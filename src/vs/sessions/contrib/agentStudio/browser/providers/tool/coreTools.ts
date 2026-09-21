/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Core Tools — clarify / file_read / file_write / search_files / terminal，及其文件系统读取守卫
 * (redact / read-dedup / repeat / similar-files / levenshtein / terminal 执行)。
 *
 * 从 builtinToolProvider.ts 的 _registerCoreTools + 一组私有 helper 抽出，降低主文件体积。
 *
 * 共享依赖经 ctx 传入：
 *  - `resolveAndCheckWorkspacePath`：仍被 compat / knowledge 等工具复用，留在主文件。
 *  - `searchHelpers`：SearchHelpers 实例（主文件持有，核心工具独占使用）。
 *  - 文件读取去重/重复 Map 保存在本函数的闭包中（随 tool handler 生命周期存活）。
 */

import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { ITerminalService } from '../../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ICheckpointService } from '../../../common/checkpointService.js';
import { NonRetryableToolError, ToolSecurityLevel } from '../../../common/providers.js';
import type { IToolResultContent } from '../../../common/providers.js';
import { SearchHelpers, redactSecrets } from './searchHelpers.js';
import { detectTerminalSearchCommand, terminalSearchCommandHint } from './terminalCommandGuards.js';
import { detectUnixOnlyCommand, UNIX_ONLY_COMMAND_HINTS, GIT_BASH_INSTALL_GUIDANCE, detectPowerShellOnlyCmdlet, powerShellCmdletGuardMessage, recordFileReadSuccess, recordFileReadFailure } from './executeCodeGuards.js';
import {
	stripShellNoise,
	isSlowStartCommand,
	emptyTerminalOutputMessage,
	createShellNoiseStripper,
	truncateTerminalOutput,
	spilledOutputFooter,
	unavailableExitCodeNote,
} from './terminalOutputDiagnosis.js';
import { pickTerminalStrategy, decideIdleWaitAction, resolveNoneTierMaxWaitMs } from './terminalCompletionStrategy.js';
import { SPILL_THRESHOLD_BYTES, spillFileName, selectSpillFilesToDelete } from './execOutputSpill.js';
import { SarosPath, resolveSarosPath, userDataRootFromPath } from '../../../common/sarosPaths.js';
import { longLineTruncationHint } from '../../../common/fileReadHints.js';
import { joinPath } from '../../../../../../base/common/resources.js';
import { INativeEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { runExecOutputPipeline } from './execOutputPipeline.js';
import { TerminalCapability } from '../../../../../../platform/terminal/common/capabilities/capabilities.js';
import type { ICommandDetectionCapability, ITerminalCommand } from '../../../../../../platform/terminal/common/capabilities/capabilities.js';
import { shellPlatformGuidance, windowsDualShellGuidance } from './shellPlatformPrompt.js';
import { resolveShellDialect } from '../../../common/shellDialect.js';
import { annotateCommandFailure, annotateMaskedSuccess, renderFailureHint } from './commandFailureHints.js';
import { detectGitBash, gitBashShellEnvironment, type IGitBashInfo } from './gitBashProvider.js';
import { shellPreflightRejection } from './shellPreflightGuards.js';
import { shellApprovalGuidance } from '../../../common/shellCommandSafety.js';
import { appendTerminalLiveOutput, clearTerminalLiveOutput } from '../../../../../browser/agentChat/terminalLiveOutput.js';
import { detectStaleWorktreeAccess, staleWorktreeWarning } from '../../../common/worktreeBinding.js';
import {
	detectDevicePath,
	detectSensitivePath,
	devicePathBlockedMessage,
	sensitiveReadBlockedMessage,
	sensitiveWriteRejection,
} from './sensitivePaths.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { AgentNetworkDomainSettingId } from '../../../../../../platform/networkFilter/common/settings.js';
import { isWindows } from '../../../../../../base/common/platform.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

/**
 * 图片类扩展名 —— 这类应由 `vision_analyze` 处理（见 {@link binaryReadRejectedMessage}）。
 * 与 `isBinaryPath` 里的图片段保持一致。
 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.ico', '.svg', '.psd',
]);

/** 二进制**文档**类扩展名 —— 可先转文本（pandoc / csv / python）。 */
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
	'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
]);

/**
 * 二进制读取被拒时的**可执行**指引（2026-09-13 重写）。
 *
 * ## 旧文案的问题：不可执行
 *
 * 只有一句「Use a different tool for binary files」+ docx/xlsx 转换建议 —— 对**图片**
 * （最高频的一类：模型自己截的 mockup 截图）**无法执行**：
 *   · 没点名该用哪个工具（「a different tool」= 让模型自己猜）；
 *   · 给的三条建议（pandoc / csv / python）全不适用于 PNG。
 *
 * 实测日志：模型拿 `docs/kb-mockups/_shot-sidebar.png` 调 `file_read` 被拒 ——
 * 而项目**已有** `vision_analyze`（`VSSAROS_TOOL_NAMES.READ_IMAGE` 的规范工具，
 * 且本轮起已支持本地文件路径）。整条「渲染 → 截图 → 看效果」闭环就卡在这句话上。
 *
 * ## 原则
 *
 * 拒绝文案必须把「下一步做什么」说到**可执行** —— 否则模型只会重试或绕路
 * （本项目在 patch 失败、读守卫、源码写入等处的文案都遵循这条）。
 *
 * ⚠ 本函数被 `visionAnalyzeTools.test.ts` **交叉断言**：文案里的工具名必须与
 * `VISION_ANALYZE_TOOL_NAME` 一致 —— 工具改名而指引没跟上，测试会红。
 */
export function binaryReadRejectedMessage(requested: string, resolved: string): string {
	const ext = (/\.[A-Za-z0-9]+$/.exec(resolved)?.[0] ?? '').toLowerCase();
	if (IMAGE_EXTENSIONS.has(ext)) {
		return `Cannot read '${requested}' as text — it is an image (${ext}).\n`
			+ 'Use `vision_analyze` instead: it accepts a LOCAL FILE PATH (also a data URL / base64 / http(s) URL) '
			+ 'and returns a TEXT answer about the image — that is the supported way to look at an image.\n'
			+ 'Do NOT retry file_read on images, and do NOT base64 the file through a shell command just to read it.';
	}
	if (DOCUMENT_EXTENSIONS.has(ext)) {
		return `Cannot read '${requested}' as text — it is a binary document (${ext}).\n`
			+ 'Convert it to text first (e.g. .docx → pandoc, .xlsx → csv, .ipynb → python script).';
	}
	return `Cannot read '${requested}' as text — binary file (${ext || 'unknown type'}).\n`
		+ 'file_read only handles UTF-8 text; use a tool that understands this format.';
}

export interface CoreToolContext {
	register(reg: IBuiltinToolRegistration): IDisposable;
	logService: ILogService;
	id: string;
	resolveAndCheckWorkspacePath: (agentId: string | undefined, requestedPath: string, checkSandbox?: boolean) => Promise<string>;
	fileService: IFileService;
	searchHelpers: SearchHelpers;
	checkpointService: ICheckpointService;
	terminalService: ITerminalService;
	workspaceService: IWorkspaceContextService;
	configurationService: IConfigurationService;
	/**
	 * 环境服务 —— 仅用于解析**输出落盘目录**（`~/.vssaros/tmp/`，与 `execute_code` 同一约定）。
	 * 可选：未注入时 terminal 退化为纯截断（中段丢弃），不影响命令执行本身。
	 */
	environmentService?: INativeEnvironmentService;
	/**
	 * 该 agent **实际绑定**的 worktree 根（`resolveEffectiveWorktreeRoot` 结果，未绑定为
	 * undefined）。用于 file_read 判定「读到的是未绑定的 worktree 过期副本」
	 * （2026-08-20，日志 1787217670299）。可选：未注入时退化为不告警。
	 */
	getBoundWorktreeRoot?: (agentId: string | undefined) => Promise<string | undefined>;
}

// ── 静态常量（原 BuiltinToolProvider 静态成员）────────────────────────
const READ_MAX_LIMIT = 2000;
const READ_LINE_MAX_CHARS = 2000;
const READ_MAX_CHARS = 100_000;
const LARGE_FILE_HINT_BYTES = 512 * 1024;
const LARGE_FILE_HINT_MIN_LIMIT = 200;
/**
 * limit ≤ 此值视为「规模探查读取」，输出额外的 `[File info: N 行, XKB]` 元信息行。
 * 目的：让 `file_read(path, limit:1)` 成为「查文件多少行」的正规做法，替代
 * 会触发审批的 shell 命令（`(Get-Content x).Count` / `wc -l`）。
 */
const PROBE_LIMIT_MAX = 5;
/** 上下文窗口大小（2026-07-26 P2 动态上下文保护）：全读大文件时按占比警告 */
const CONTEXT_WINDOW_TOKENS = 128_000;
// 敏感路径表已迁移到 sensitivePaths.ts（单一真源，读写共享同一份表与匹配语义）
const READ_REPEAT_WARN = 3;
const READ_REPEAT_BLOCK = 4;
const READ_DEDUP_BLOCK = 2;
const READ_DEDUP_CAP = 500;
const READ_REPEAT_CAP = 1000;

/** terminal 落盘序号 —— 同一毫秒内多次落盘也不重名（与 execute_code 的 spill 各自独立编号）。 */
let _terminalSpillSeq = 0;

/**
 * shell integration 能力**负结果**缓存（2026-09-21，pi/bash 对比后引入）。
 *
 * ## 为什么值得缓存
 *
 * 能力探测必须等满 `COMMAND_DETECTION_WAIT_MS`（3s）—— 因为能力是 shell 启动时注入脚本
 * 注册的，只能"就绪后再等一会儿"。而 **Git Bash（自定义 executable）从不被注入** ⇒
 * 每次 terminal 调用都白等 3s（真机实测 p50 ≈ 7.6s/次，这 3s 是其中的固定开销）。
 *
 * ## 为什么只缓存**负**结果
 *
 * 正结果（探测到能力）若被缓存，后续调用会跳过探测 ⇒ 拿不到 `commandDetection` 对象 ⇒
 * `onCommandFinished` 注册不上 ⇒ **静默退化成 idle 猜判定**（丢掉真实 exit code）✗。
 * 负结果则不同：跳过探测后的行为与"探测再到超时"**完全等价**（都是 none 档），
 * 语义零变化 ✓。正结果本身也便宜（能力已随实例就绪）⇒ 无需缓存。
 *
 * 键含 shell profile：换 shell（gitBash 路径 / 默认 profile）即换键，不会互相污染。
 * TTL 兜底"用户中途开启 shell integration"的场景（最坏 10 分钟内退化为 none 档）。
 */
const _capabilityProbeNegativeCache = new Map<string, number>();
const PROBE_NEGATIVE_TTL_MS = 10 * 60 * 1000;

/** 计算两个字符串的 Levenshtein 编辑距离（Wagner-Fischer 算法）。 */
function _levenshtein(a: string, b: string): number {
	const m = a.length, n = b.length;
	// 优化：一维滚动数组（O(min(m,n)) 空间）
	if (m < n) { return _levenshtein(b, a); }
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	let curr = new Array<number>(n + 1);
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			curr[j] = a[i - 1] === b[j - 1]
				? prev[j - 1]
				: 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n];
}

export function registerCoreTools(ctx: CoreToolContext): { resetPerTurn(): void } {
	const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

	// 文件读取去重 Map / 重复检测 Map / 读 mtime Map：随 provider 生命周期存活（闭包）。
	const _readDedupMap = new Map<string, { mtime: number; stubCount: number }>();
	const _readRepeatMap = new Map<string, { key: string; count: number }>();
	const _fileReadMtimeMap = new Map<string, number>();

	async function executeTerminalCommand(
		command: string,
		cwd: string | undefined,
		timeoutSec: number,
		signal?: AbortSignal,
		gitBash?: IGitBashInfo,
		toolCallId?: string,
	): Promise<IToolResultContent[]> {
		// 如果已被取消，直接返回
		if (signal?.aborted) {
			return [{ type: 'text', text: 'Command execution was cancelled before it started.' }];
		}
		// 运行期直播：每次执行前清空该 toolCallId 的缓存（同一轮不会重入，保底重置）
		clearTerminalLiveOutput(toolCallId);

		try {
			// 工作目录：调用方已通过 resolveAndCheckWorkspacePath 校验为允许根内的绝对路径。
			// 仅在异常缺失时回退到 VS Code 工作区文件夹（不应发生）。
			const workspaceFolders = ctx.workspaceService.getWorkspace().folders;
			const effectiveCwd = cwd ?? (workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined);

			// 创建临时终端实例。
			// Hermes 环境归一（2026-08-18）：Windows 上探测到 Git Bash 时直接以 bash.exe
			// 作为终端 shell——login shell 自带 /usr/bin（head/tail/grep/sed/awk/cat/ls/find
			// 全部真实可用），模型按 Unix 方言写命令从「必失败+护栏拦截」变「天然正确」。
			// env 三件套：CHERE_INVOKING 保持 cwd（login 默认跳 HOME）；MSYS_NO_PATHCONV/
			// MSYS2_ARG_CONV_EXCL 禁止 MSYS 参数级路径改写。未探测到 Git Bash 时回退
			// VS Code 默认 profile（PowerShell/cmd），Unix 拦截护栏继续生效。
			const launchConfig: any = {
				type: 'Task',
				name: `Agent: ${command.slice(0, 40)}`,
				cwd: effectiveCwd,
				isFeatureTerminal: true,
				hideFromUser: false,
			};
			if (gitBash) {
				launchConfig.executable = gitBash.bashPath;
				launchConfig.args = ['--login'];
				launchConfig.env = gitBashShellEnvironment();
			}
			const instance = await ctx.terminalService.createTerminal({
				config: launchConfig,
			});

			if (!instance) {
				return [{ type: 'text', text: `Error: Failed to create terminal instance for command execution.` }];
			}

			// 收集输出数据
			const outputChunks: string[] = [];
			let dataListener: IDisposable | undefined;
			let exitListener: IDisposable | undefined;
			// ★ 2026-09-21：「转后台」标记 ✓ —— abort 信号的 `reason === 'detach'` 时置位
			//   （agentOS._composeParentSignal 透传 ✓）⇒ 与「跳过」走完全不同的收尾：
			//   **不销毁终端实例**（进程继续跑 ✓✓）+ 自动打开控制台 ✓ + 返回 DETACHED 文案 ✓。
			let detachedToBackground = false;

			const IDLE_TIMEOUT_MS = 1500; // 基础 idle 轮询间隔（none 档专用）

			// ── 完成判定：三档策略（2026-08-22，横向对标五家开源实现后重构）──────
			//
			// 对标结论（详见 terminalCompletionStrategy.ts 头注释）：continue / opencode /
			// MiMo 都不用 PTY（`spawn` + 等 `close`/`exitCode`，没有猜的余地）；Cline 与
			// VS Code 官方同样用 VS Code Terminal，但完成判定**由 shell integration 事件
			// 驱动**，不是计时器。**只有本项目在用固定 idle 超时猜完成** —— 日志
			// 1787324352413 里 8 次调用全部只拿到提示符、`npx tsc` 输出全丢，根因正是它。
			//
			// 本项目其实一直具备 `TerminalCapability.CommandDetection`（全仓 52 处在用，
			// 提供 `onCommandFinished` + 真实 `exitCode` + 按 marker 取的 `getOutput()`），
			// 只是 terminal 工具从未使用 —— 记忆里长期记录的「terminal 走 PTY 拿不到
			// 结构化 exit code」这一前提是错的。
			//
			// 慢启动形态仅用于 none 档的等待预算（rich/basic 档由事件驱动，与快慢无关）。
			const slowStart = isSlowStartCommand(command);
			// ★ 2026-09-21（P0-③，pi/bash 对比）：**去掉 60s 硬顶**，timeout 完全由调用方决定
			// （上限由 handler clamp 到 300 —— schema 已标注）。pi 的 bash 则默认**无超时**、
			// 只在调用方传 `timeout` 秒时才计时；旧实现 `min(timeoutSec*1000, 60_000)` 让任何
			// >60 的 timeout **静默失效**，对 dev server / watch / 大构建等于"必然超时且参数
			// 无能为力"，而模型完全看不出参数被吃掉了。
			const timeoutMs = timeoutSec * 1000;
			/**
			 * none 档允许的最长等待 —— **不得超过外层 timeout**（详见
			 * `resolveNoneTierMaxWaitMs` 的不变量注释：内层 60s 封顶 + 外层 300s 的组合
			 * 会让慢启动命令被提前"猜"成结束并返回半截输出 ✗）。
			 */
			const noneMaxWaitMs = resolveNoneTierMaxWaitMs(timeoutMs, slowStart);

			// ── 等待 shell 就绪（processReady + 首次输出）──
			// PowerShell profile 加载需 1.5-3s，若在 shell 未就绪时 sendText，
			// 命令写入 buffer 但输出在收集窗口关闭后才到达 → "(no output)"。
			// 等待 processReady（pty 创建）+ 首次 onData（shell 已产出 prompt/welcome），
			// 确保 shell 可接受输入后再发命令。
			const SHELL_READY_TIMEOUT_MS = 8000;
			try {
				// 1. 等待 pty 进程创建
				await instance.processReady;

				// 2. 等待首次 shell 输出（prompt 或 welcome banner），超时则直接继续
				let firstDataListener: IDisposable | undefined;
				const firstOutput = new Promise<void>((resolve) => {
					firstDataListener = instance.onData(() => { resolve(); });
					setTimeout(() => resolve(), SHELL_READY_TIMEOUT_MS);
				});
				await firstOutput;
				firstDataListener?.dispose();
			} catch { /* 就绪检测失败不影响后续执行 */ }

			// ── 能力探测（必须在 shell 就绪之后）──────────────────────────────
			// shell integration 是**随 shell 启动执行注入脚本**才注册能力的，在
			// processReady 之前探测必然为空 → 会把所有终端都误判成 none 档。
			// 就绪后再给一个短窗口等待；等不到就落 none 档（自定义 executable 的
			// Git Bash 通常不被注入，常落此档）。
			const COMMAND_DETECTION_WAIT_MS = 3000;
			// ★ 2026-09-21（P1-④，pi/bash 对比）：负结果缓存 —— Git Bash 等永不注入 shell integration 的
			// profile 直接跳过这 3s 空等（详见 `_capabilityProbeNegativeCache` 注释）。
			const profileKey = gitBash ? `gitbash:${gitBash.bashPath}` : 'default';
			const probeSkipped = (_capabilityProbeNegativeCache.get(profileKey) ?? 0) > Date.now();
			const probeStartedAt = Date.now();
			const commandDetection = probeSkipped ? undefined : await (async () => {
				const existing = instance.capabilities.get(TerminalCapability.CommandDetection);
				if (existing) { return existing; }
				return await new Promise<ICommandDetectionCapability | undefined>((resolve) => {
					let settled = false;
					const listener = instance.capabilities.onDidAddCommandDetectionCapability((cap) => {
						if (settled) { return; }
						settled = true;
						listener.dispose();
						resolve(cap);
					});
					setTimeout(() => {
						if (settled) { return; }
						settled = true;
						listener.dispose();
						resolve(undefined);
					}, COMMAND_DETECTION_WAIT_MS);
				});
			})();
			// 只缓存「等满了超时窗口」的负结果：瞬时缺失可能只是启动慢，不能当成「永不注入」。
			if (!probeSkipped && !commandDetection
				&& Date.now() - probeStartedAt >= COMMAND_DETECTION_WAIT_MS - 100) {
				_capabilityProbeNegativeCache.set(profileKey, Date.now() + PROBE_NEGATIVE_TTL_MS);
				ctx.logService.info(
					`[BuiltinTools] terminal: no shell integration for profile '${profileKey}' — ` +
					`cached (none-tier) for ${PROBE_NEGATIVE_TTL_MS / 60_000}min; ` +
					`subsequent calls skip the ${COMMAND_DETECTION_WAIT_MS}ms capability wait`);
			}

			const strategy = pickTerminalStrategy({
				hasCommandDetection: !!commandDetection,
				hasRichCommandDetection: !!commandDetection?.hasRichCommandDetection,
			});

			// 有状态流式剥离器：用于「命令是否已产出真实输出」判定（见
			// terminalOutputDiagnosis.createShellNoiseStripper —— 一旦见到真输出就永久
			// 停止剥回显，结构性避免误吞后续真实输出）。
			const streamStripper = createShellNoiseStripper({ command });
			const waitStartedAt = Date.now();

			const outputPromise = new Promise<string>((resolve) => {
				let idleTimer: ReturnType<typeof setTimeout>;
				/** idle 延长次数 —— 用于抑制日志刷屏（慢启动命令可能连续延长多次）。 */
				let extendCount = 0;
				/**
				 * idle 到点后的处置。
				 *
				 * ★ 2026-08-22：原实现 idle 一到就 `resolve('')` 收工，慢启动命令必然被
				 * 提前收走。现对齐官方 `waitForIdleWithPromptHeuristics` —— **先看最后一行
				 * 像不像 shell 提示符**：像 → shell 已回到提示符、命令确实结束；不像 →
				 * 命令还在跑，继续等（上限 noneMaxWaitMs，再由外层 timeout 兜底）。
				 *
				 * 这比上一轮「按命令名猜是否慢启动」更普适，且不需要维护命令名单。
				 * 注意判据必须用**原始输出**（含提示符），不能用剥离后的文本。
				 */
				const onIdle = () => {
					const action = decideIdleWaitAction({
						collectedOutput: outputChunks.join(''),
						elapsedMs: Date.now() - waitStartedAt,
						maxWaitMs: noneMaxWaitMs,
					});
					// ★ 2026-08-22：原为 `logService.trace`，默认日志级别不输出 —— 日志
					// 1787368358120 里 0 条，导致「提示符启发式到底怎么判的」完全不可见
					// （只能从耗时间接推断）。这两条是 none 档唯一的判定过程记录，且每次
					// 命令最多产生 ~N/1.5s 条，升为 info 的体积代价可接受。
					if (action.kind === 'done') {
						ctx.logService.info(
							`[BuiltinTools] terminal idle → done after ${Date.now() - waitStartedAt}ms: ${action.reason}`);
						resolve('');
						return;
					}
					extendCount++;
					// extend 可能连续多次（慢启动命令），只在首次与每第 5 次记录，避免刷屏
					if (extendCount === 1 || extendCount % 5 === 0) {
						ctx.logService.info(
							`[BuiltinTools] terminal idle → extend ×${extendCount} ` +
							`(waited ${Date.now() - waitStartedAt}ms / max ${noneMaxWaitMs}ms): ${action.reason}`);
					}
					idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
				};

				const markIdle = () => {
					clearTimeout(idleTimer);
					idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
				};

				// 监听数据输出
				dataListener = instance.onData((data: string) => {
					// 去除 ANSI 转义序列和终端垃圾信息
					const clean = data
						// ANSI SGR (颜色、样式)
						.replace(/\x1b\[[0-9;:?]*[a-zA-Z]/g, '')
						// ANSI OSC (窗口标题等)
						.replace(/\x1b\][^\x07]*\x07/g, '')
						.replace(/\x1b\][^\x1b]*\x1b\\/g, '')
						// 其他控制字符
						.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
						.replace(/\r\n/g, '\n')
						.replace(/\r/g, '\n');
					outputChunks.push(clean);
					streamStripper.push(clean);
					// 运行期直播：把清洗后的增量输出直接推给 DOM 卡片（旁路通道）
					appendTerminalLiveOutput(toolCallId, clean);
					markIdle();
				});

				// 监听退出（非交互式 shell 可能触发）
				exitListener = instance.onExit((e) => {
					clearTimeout(idleTimer);
					const code = typeof e === 'number' ? e : (e as any).exitCode;
					resolve(`Exit code: ${code}\n`);
				});

				// 初始计时器：此刻尚无任何命令输出，走同一套「提示符启发式」判定
				idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
			});

			// ★ timeoutMs 已在上方（能力探测之前）计算 —— 因为 none 档窗口需要它做上界，
			// 见 `noneMaxWaitMs` / `resolveNoneTierMaxWaitMs`。

			// v27: log the actual command at the start of execution.
			// ★ 2026-09-21（P0-③/P1-④）：去掉 `hardCap` 字段（60s 硬顶已移除），补 `probe` 字段 ——
			// 「本次能力探测是查了缓存还是真等了 3s」是验证 P1-④ 收益的唯一现场证据（原先不可见）。
			ctx.logService.info(
				`[BuiltinTools] terminal: command="${redactSecrets(command).slice(0, 200)}" cwd=${effectiveCwd ?? '(none)'} ` +
				`timeout=${timeoutMs}ms strategy=${strategy} probe=${probeSkipped ? 'cached-none' : 'fresh'} slowStart=${slowStart}`,
			);

			// 快照：用于覆盖「命令在监听器注册前就已完成」的竞态（见下方注释）
			const commandCountBeforeSend = commandDetection?.commands.length ?? 0;

			// v27: defensive `await instance.sendText(command, true)`.
			const sendTextTimeoutMs = timeoutMs + 5_000;
			const sendTextTimeout = new Promise<void>((resolve) => {
				setTimeout(() => resolve(), sendTextTimeoutMs);
			});
			await Promise.race([instance.sendText(command, true), sendTextTimeout]);

			// ── rich / basic 档：事件驱动完成判定 ────────────────────────────────
			// 这是本次重构的核心收益：完成与否由 shell integration 报告，**与命令启动
			// 快慢完全无关** —— 日志 1787324352413 里 `npx tsc` 输出全丢的场景在此档下
			// 结构上不会发生。同时能拿到真实 exitCode 与按 marker 取的干净输出。
			let finishedCommand: ITerminalCommand | undefined;
			let commandFinishedListener: IDisposable | undefined;
			const commandFinishedPromise = commandDetection
				? new Promise<string>((resolve) => {
					commandFinishedListener = commandDetection.onCommandFinished((cmd) => {
						if (finishedCommand) { return; }
						finishedCommand = cmd;
						resolve('');
					});
					// 竞态兜底：极快的命令（`echo hi`）可能在 await sendText 返回后、
					// 监听器注册前就已完成 —— 此时事件已经错过，只能靠 commands 数组
					// 的增量发现。不做这层检查会退化成等满 idle/timeout。
					const cmds = commandDetection.commands;
					if (cmds.length > commandCountBeforeSend) {
						finishedCommand = cmds[cmds.length - 1];
						resolve('');
					}
				})
				: undefined;

			// 等待输出或超时
			let result = '';

			const abortPromise = signal
				? new Promise<string>((resolve) => {
					// 中性文案：无论整轮取消还是「跳过」跳过当前命令，LLM 都应理解
					// 命令被中断，但可继续处理后续步骤（避免误读为「用户取消了整个请求」）。
					// ★ 2026-09-21：按 `signal.reason` 区分「转后台」（**进程留着** ✓ 实例不销毁 ✓✓）
					//   与「跳过/取消」（中断 ✓）—— 两条路的收尾语义截然不同 ✓✓。
					const onAbort = () => {
						if (signal.reason === 'detach') {
							detachedToBackground = true;
							resolve('[DETACHED]\n');
							return;
						}
						resolve('[INTERRUPTED] Command execution was interrupted by the user to continue with other steps. The command may have partially completed.\n');
					};
					signal.addEventListener('abort', onAbort, { once: true });
				})
				: new Promise<string>(() => { /* never resolves */ });

			// ★ 2026-09-21（P0-③）：超时文案必须**可执行** —— 旧文案只有一句
			// `[TIMEOUT] Command timed out after Ns`：既不说"命令有没有跑完"，也不给任何出路，
			// 模型只能原样重发（必然再超时）或换写法绕（pi 的对照做法：超时是结构性文案
			// `Command timed out after N seconds`，且 pi 默认根本不会超时——只在调用方要求时才有）。
			// 现在点破 ① 未证明完成 ② 会话已关 ③ 两条出路（更大 timeout / execute_code background）。
			const timeoutPromise = new Promise<string>((resolve) => {
				setTimeout(() => resolve(
					`[TIMEOUT] The wait window (${timeoutMs / 1000}s) closed before this command reported completion — ` +
					`it was NOT proven to have finished, and the terminal session is now closed.\n` +
					`Do NOT re-send it through terminal unchanged. Instead pick ONE:\n` +
					`  • if the command does finish on its own, just raise "timeout" (seconds, max 300) and re-run it; or\n` +
					`  • for long-running processes (dev server, watcher, large install/build/test suite) run it with ` +
					`execute_code({ background:true }) — that returns a taskId immediately, ` +
					`execute_code({ action:"poll", taskId }) reads its output, and action:"kill" stops it.\n`
				), timeoutMs);
			});

			// rich/basic 档把 commandFinished 一并纳入竞速：谁先到用谁。
			// 仍保留 outputPromise（idle + 提示符启发式）作为「shell integration 没报
			// 完成」的兜底 —— 能力存在但脚本中途失效是真实存在的情况，不能只依赖事件。
			const raceTargets: Promise<string>[] = [outputPromise, timeoutPromise, abortPromise];
			if (commandFinishedPromise) { raceTargets.push(commandFinishedPromise); }
			result = await Promise.race(raceTargets);

			// 等待一小段时间让剩余数据到达
			await new Promise<void>(resolve => setTimeout(resolve, 300));

			// 清理监听器
			dataListener?.dispose();
			exitListener?.dispose();
			commandFinishedListener?.dispose();

			// ── 输出取值：优先 shell integration 的 marker 区间 ─────────────────
			// `ITerminalCommand.getOutput()` 按命令的 start/end marker 从 buffer 取，
			// 天然不含提示符与命令回显，比 onData 抓取干净得多（Cline 与官方都用它）。
			// 取不到（marker 失效 / 输出被 buffer 滚掉）时回退到 onData 累积。
			const markerOutput = finishedCommand?.getOutput();
			const rawMerged = markerOutput !== undefined && markerOutput.length > 0
				? markerOutput
				: outputChunks.join('') + result;

			// 后处理：去除 shell 提示符 / 命令回显 / 登录横幅 / 版本与升级通知。
			//
			// ★ 2026-08-21（日志 1787324352413）：原实现用一条大正则清 Git Bash 提示符
			// （`/^[^\n]*@+[^\n]*MINGW[0-9]+[^\n]*\$\s*$/gm`），要求**同一行内**既含 `@`、
			// `MINGW<数字>` 又以 `$` 结尾。真实提示符是**两行**：
			//   `user@host MINGW64 /path(branch)`  ← 以 `)` 结尾，不匹配
			//   `$ <命令回显>`                     ← 无 `@`/`MINGW`，不匹配
			// 两行全漏 → 提示符与回显原样进 LLM 上下文，且「输出是否为空」无法判断
			// （提示符本身非空 → 永远走成功路径）。现改为逐行判定，见
			// terminalOutputDiagnosis.stripShellNoise。
			const fullOutput = stripShellNoise(rawMerged, { command });

			// ── 「转后台」收尾（2026-09-21 ✓）：与所有其它分支**根本不同** ✓✓ ——
			//   ① **不销毁实例** ✗✗（dispose → pty kill ⇒ 进程被杀 ✗ —— 转后台的全部意义就是留着它 ✓✓）；
			//   ② **自动打开控制台** ✓（setActiveInstance + showPanel ⇒ 用户立刻看到后台运行过程 ✓✓）；
			//   ③ 返回 DETACHED 文案（明确告知模型：别等它 ✓ 需要结果用 execute_code background ✓）；
			//   ④ 直播订阅清理由卡片侧正常收尾（工具结果到达 → 卡片重渲染 → `_disposeLiveTerminalSub` ✓）。
			if (detachedToBackground) {
				try {
					// revealTerminal = 显示终端面板 + 置为活动实例 ✓（ITerminalService:547 ✓，
					// 一个调用 ✓；用户明确要求"自动打开 console 显示后台运行过程" ⇒ 不 preserveFocus ✓）
					void ctx.terminalService.revealTerminal(instance);
				} catch { /* 打开控制台失败不影响 detach 本身 ✓ */ }
				dataListener?.dispose();
				exitListener?.dispose();
				commandFinishedListener?.dispose();
				const partial = stripShellNoise(outputChunks.join(''), { command });
				return text(
					`[DETACHED] The command keeps running in its own terminal — the user moved it to the background ` +
					`and its console has been opened for them. Do NOT wait for it; continue with other steps. ` +
					`If its final result matters later, ask the user, or run long tasks via execute_code({ background:true }) ` +
					`next time (which supports action:"poll" / action:"kill").\n` +
					(partial ? `\n--- partial output so far ---\n${partial.slice(-2000)}` : ''),
				);
			}

			// 尝试销毁终端实例
			//
			// ★ 2026-09-21（P2-⑥ 结论：**无需在此另杀进程树**，此前列为待办，核实后撤销）：
			//   对标 pi 时它显式做 `detached` + `process.kill(-pid)` / `taskkill /F /T`。
			//   本仓 `dispose()` → pty host `TerminalProcess#_kill()` → `node-pty.kill()`
			//   （`platform/terminal/node/terminalProcess.ts:389-409`）：Windows 走 ConPTY teardown、
			//   Unix 关掉 pty 会向会话进程组发 SIGHUP ⇒ **进程树回收在这一层已经发生**，
			//   在 renderer 侧再补一次既拿不到 pid（renderer 无 process API），也会与 pty host 打架。
			//   ⚠ 已知残留面：**自己 daemonize / setsid 脱离会话的孙进程**仍可能存活（pty 语义使然，
			//   pi 的 kill(-pid) 对这类同样无效）。这类场景应引导模型用 `execute_code background:true`
			//   （那里有显式 taskkill /T /F + poll/kill 控制面）。
			try {
				if (instance) {
					instance.dispose();
				}
			} catch { /* ignore */ }

			// 密钥脱敏 — 防止命令回显的密钥泄露到 LLM 上下文（对齐 Hermes/Claude Code）
			const sanitizedRaw = redactSecrets(fullOutput);

			// token 效率管道（2026-08-22，与 execute_code 共用同一份实现）：
			// 折叠 \r 进度帧、剥 ANSI、折叠超长行，并按命令形态做结构化聚合
			// （tsc 按错误码/文件聚合、依赖栈帧折叠、npm deprecation 折叠）。
			// 内部有 never-worse 契约，最坏情况不劣于原先的裸截断。
			const piped = runExecOutputPipeline(sanitizedRaw, command);
			if (piped.appliedStages.length > 0) {
				ctx.logService.trace(
					`[BuiltinTools] terminal output pipeline: ${piped.appliedStages.join(',')} ` +
					`(${sanitizedRaw.length} → ${piped.text.length} chars)`,
				);
			}
			const sanitizedOutput = piped.text;

			// ── 截断 + 落盘（2026-09-21，P0-②，pi/bash 对比后改）──────────────
			// 旧实现：head+tail 64KB，中段**直接丢弃**、不落盘、不给总量 ⇒ 模型既拿不到中段，
			// 也无从知道丢了什么，只能重跑命令（一次构建的重跑代价远大于读文件）。
			// 现对齐 pi 的「保留头尾 + 全量落临时文件 + 明确总量与路径 + 检索引导」：
			// 截断时把**全量**写入 `~/.vssaros/tmp/`，footer 直接给出取回方式。
			// 阈值共用 `SPILL_THRESHOLD_BYTES`（与 execute_code 落盘同一常量，避免两处漂移）。
			const maxLen = SPILL_THRESHOLD_BYTES;
			const trunc = truncateTerminalOutput(sanitizedOutput, maxLen);
			let finalOutput = trunc.text;
			if (trunc.truncated) {
				const footer = await spillTerminalOutput(command, sanitizedOutput);
				// 落盘失败 ⇒ 仅保留内联截断（footer 为 undefined），绝不因落盘把成功命令变错误 ✓
				if (footer) { finalOutput = `${finalOutput}\n\n${footer}`; }
			}

			// ── exit code：优先真实值，回退正则 ─────────────────────────────────
			// ★ 2026-08-22：`ITerminalCommand.exitCode` 是 shell integration 报告的**真实
			// 退出码**。此前只能从输出里正则抠 shell 偶尔打出的 `Exit code: N`（日志里
			// 全是 `exit unknown`），导致 annotateCommandFailure 只能靠错误文本猜，
			// 还误判过 `no-such-file`（真实原因是 shell 方言不匹配）。
			const regexExit = /(?:^|\n)Exit code:\s*(\d+)/.exec(finalOutput);
			const parsedExit = finishedCommand?.exitCode ?? (regexExit ? Number(regexExit[1]) : undefined);
			const exitSource = finishedCommand?.exitCode !== undefined ? 'shellIntegration'
				: regexExit ? 'regex' : 'unknown';

			// ── 空产出处理（2026-08-21 引入，2026-08-22 按档细分）────────────────
			// 清理后没有任何实质内容有**两种截然不同**的含义，必须区分，否则要么误导
			// 模型、要么白烧迭代：
			//   a) 有真实 exitCode（rich/basic）→ 命令确实结束且**确实没有输出**，
			//      这是合法事实（`cd`/`mkdir`/`git add` 都如此）。据实报告即可，
			//      切不可让模型以为「结果丢了」而重跑。
			//   b) 无 exitCode（none 档）→ 只拿到提示符/回显，结果**可能真的丢了**。
			//      这正是日志 1787324352413 的形态：原实现此时 hintedOutput 仍非空
			//      （提示符是非空串）→ 永远报成功，模型只能自创「重定向到 /tmp 再
			//      cat」「加 sleep」等无效规避（连烧 8 轮 37s）。
			// 两者都**刻意不抛错**：命令很可能真的在跑（副作用已发生），抛错会让模型
			// 以为没执行而重跑一遍构建。
			if (!finalOutput) {
				const interrupted = /^\[(?:INTERRUPTED|TIMEOUT)\]/.test(result.trim());
				if (interrupted) {
					// 中断/超时有自己的明确文案，按原样返回（模型能正确理解）
					return [{ type: 'text', text: result.trim() }];
				}
				if (parsedExit !== undefined) {
					ctx.logService.info(
						`[BuiltinTools] terminal: command produced no output (exit=${parsedExit} ` +
						`strategy=${strategy} exitSource=${exitSource})`,
					);
					return [{
						type: 'text',
						text: `Command completed with exit code ${parsedExit}. The command produced no output.`,
					}];
				}
				ctx.logService.warn(
					`[BuiltinTools] terminal: NO OUTPUT CAPTURED after ${timeoutMs}ms ` +
					`(strategy=${strategy} slowStart=${slowStart}) — command="${redactSecrets(command).slice(0, 120)}"`,
				);
				return [{ type: 'text', text: emptyTerminalOutputMessage(command, timeoutMs) }];
			}

			// ── 失败下一步提示（Hermes terminal_hints 式，2026-08-21）───────────
			// 工具级重试已移除（决策交给模型），提示会明确表态「别重试」还是「稍后重试」。
			let hintedOutput = finalOutput;
			// 有真实 exitCode 时把它显式告知模型 —— 否则「命令失败了但输出看不出来」
			// （例如只打 warning 却 exit 1）会被误读成成功。
			if (parsedExit !== undefined && parsedExit !== 0) {
				hintedOutput = `${finalOutput}\n\nExit code: ${parsedExit}`;
			}
			// 仅在「非 0 退出码」或「未知退出码但输出含错误特征」时才尝试提示，
			// 避免给成功命令加噪音。
			/** 是否已产出「可疑/失败」类提示 —— 供下方 none 档退出码说明决定是否需要加税。 */
			let suspicionRaised = false;
			if (parsedExit === undefined || parsedExit !== 0) {
				const hint = annotateCommandFailure(parsedExit, finalOutput);
				if (hint) {
					suspicionRaised = true;
					hintedOutput = `${hintedOutput}\n\n${renderFailureHint(hint)}`;
					ctx.logService.info(
						`[BuiltinTools] terminal failure hint: ${hint.id} ` +
						`(exit=${parsedExit ?? 'unknown'} source=${exitSource} strategy=${strategy})`,
					);
				}
			} else {
				// exit 0 也可能是「假成功」：`cmd | tail` 报的是 **tail** 的状态（bash
				// 未开 pipefail），而输出里可能有强失败特征。与 execute_code 对齐：
				// 成功侧也要有兜底，否则模型会把这类 exit 0 当成「构建通过」。
				const masked = annotateMaskedSuccess(command, finalOutput);
				if (masked) {
					suspicionRaised = true;
					hintedOutput = `${hintedOutput}\n\n${renderFailureHint(masked)}`;
					ctx.logService.warn(
						`[BuiltinTools] terminal masked-success hint: ${masked.id} ` +
						`(exit=0 source=${exitSource} strategy=${strategy})`,
					);
				}
			}

			// ★ 2026-09-21（P1-⑤，pi/bash 对比）：none 档**拿不到退出码**（PTY 无 shell integration
			// 注入，Git Bash 常态）—— 而 pi 的 `bash` 因走 spawn 恒有真实退出码。这是路线差异，
			// 但**不能静默**：没有退出码时模型会按「有输出 = 成功」理解（本项目此前已因此把
			// `no-such-file` 误判为成功）。故显式声明不可观测 + 给出出路（结果导向命令走 execute_code）。
			//
			// ⚠ 触发面刻意收窄（否则 Git Bash 下**每次** terminal 调用都加约 80 token 税：
			// 而 `ls` / `git status` 这类命令的输出本身自解释，"退出码不可得"对决策毫无增量）：
			//   · 已出现可疑/失败提示（suspicionRaised）→ 必须说明"别把它读成失败"，否则模型
			//     会按提示去改一个其实成功的命令；或
			//   · 命令是**结果导向**形态（`isSlowStartCommand`：构建/测试/安装/lint）→ 这正是
			//     "退出码决定一切"的场景，必须点名。
			if (strategy === 'none' && parsedExit === undefined
				&& (suspicionRaised || isSlowStartCommand(command))) {
				hintedOutput = `${hintedOutput}\n\n${unavailableExitCodeNote()}`;
				ctx.logService.info(
					`[BuiltinTools] terminal: exit code unavailable (strategy=none, suspicion=${suspicionRaised}) ` +
					`— appended caller guidance`,
				);
			}

			return [{ type: 'text', text: hintedOutput }];
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return [{ type: 'text', text: `Error executing command: ${msg}` }];
		}
	}

	/**
	 * terminal 超限输出落盘 —— 与 `execute_code` 的 `_spillIfNeeded` 同一约定：
	 * 全量写入 `~/.vssaros/tmp/`（沙箱允许根内 ⇒ 模型后续 `file_read` 不触发越界确认卡片），
	 * 文件名可排序 + 唯一，按数量/时长回收，**任何 IO 失败都返回 undefined**（上层退化为纯截断）。
	 *
	 * 为什么不复用 `execOutputSpill.spillNoticeMessage`：那个文案面向"只内联头部"的场景
	 * （stdout/stderr 分流），而 terminal 是「头+尾」保留 + 单流全文，footer 口径不同（见
	 * `spilledOutputFooter`）。阈值/文件名/回收策略则共用同一份常量与实现，避免漂移 ✓。
	 */
	async function spillTerminalOutput(command: string, fullText: string): Promise<string | undefined> {
		try {
			const env = ctx.environmentService;
			if (!env) { return undefined; }
			const tmpDir = resolveSarosPath(userDataRootFromPath(env.userDataPath), SarosPath.tmp);
			await ctx.fileService.createFolder(tmpDir);
			// 回收：目录不可读时静默跳过（落盘只是优化，不阻塞命令结果）
			try {
				const stat = await ctx.fileService.resolve(tmpDir, { resolveMetadata: true });
				const files = (stat.children ?? [])
					.filter(c => !c.isDirectory)
					.map(c => ({ name: c.name, mtimeMs: c.mtime ?? 0 }));
				for (const name of selectSpillFilesToDelete(files, Date.now())) {
					try { await ctx.fileService.del(joinPath(tmpDir, name)); } catch { /* 单个失败跳过 */ }
				}
			} catch { /* 目录列举失败 → 本轮不回收 */ }

			const now = new Date();
			const target = joinPath(tmpDir, spillFileName(now, ++_terminalSpillSeq));
			const body = [
				`# tool: terminal`,
				`# command: ${command}`,
				`# captured: ${now.toISOString()}`,
				'',
				fullText,
			].join('\n');
			await ctx.fileService.writeFile(target, VSBuffer.fromString(body));
			ctx.logService.info(
				`[BuiltinTools] terminal: output spilled to ${target.fsPath} (${fullText.length} chars)`);
			return spilledOutputFooter(target.fsPath, fullText.length);
		} catch (e) {
			ctx.logService.warn(
				`[BuiltinTools] terminal: output spill failed, falling back to inline truncation: ${e}`);
			return undefined;
		}
	}

	/** 参数别名归一化：filePath/file_path/file/uri → path。 */
	function resolvePathArg(args: Record<string, unknown>): string {
		return String(args['path'] || args['filePath'] || args['file_path'] || args['file'] || args['uri'] || '');
	}

	/** 二进制文件扩展名守护。 */
	function isBinaryPath(p: string): boolean {
		return /\.(?:exe|dll|so|dylib|node|pak|asar|wasm|bin|obj|lib|a|o|class|jar|pyc|pyo|whl|zip|tar|gz|tgz|bz2|7z|rar|xz|zst|png|jpe?g|gif|bmp|ico|webp|tif|tiff|svg|psd|mp3|wav|ogg|flac|mp4|mov|avi|mkv|webm|pdf|docx?|xlsx?|pptx?|sqlite|db|map|woff2?|ttf|eot|otf)$/i.test(p);
	}

	/** 按行读取 [offset, offset+limit) 行，对齐 Hermes sed -n 语义。 */
	async function readFileLines(resolvedPath: string, offset: number, limit: number, signal?: AbortSignal): Promise<{ page: string[]; hasMore: boolean; totalLines: number; fileSize: number; mtime: number; truncatedLines: number[] }> {
		const normalizedUri = URI.file(resolvedPath);
		const content = await ctx.fileService.readFile(normalizedUri);
		const textContent = typeof content.value === 'string' ? content.value : content.value.toString();
		const rawLines = textContent.split(/\r?\n/);
		const fileSize = (content as any).size ?? textContent.length;
		const mtime = (content as any).mtime ?? 0;
		_fileReadMtimeMap.set(resolvedPath, mtime);

		const startIndex = offset - 1;
		const endIndex = startIndex + limit;

		// BOM 处理（仅 offset==1 时去除）
		if (startIndex === 0 && rawLines.length > 0 && rawLines[0].startsWith('\uFEFF')) {
			rawLines[0] = rawLines[0].slice(1);
		}

		const page: string[] = [];
		// ★ P2-⑦（2026-09-21，pi 对照）：记录**被截断的行号**（1-based）—— 调用侧据此给出
		// 「怎么拿到整行」的可执行出路（见 fileReadHints.longLineTruncationHint）。
		// 此前只截断不告知 ⇒ 模型要么误以为内容就这么多，要么重读整个大文件 ✗。
		const truncatedLines: number[] = [];
		for (let i = startIndex; i < Math.min(endIndex, rawLines.length); i++) {
			const line = rawLines[i];
			if (line.length > READ_LINE_MAX_CHARS) {
				page.push(line.slice(0, READ_LINE_MAX_CHARS));
				truncatedLines.push(i + 1);
			} else {
				page.push(line);
			}
		}

		const hasMore = rawLines.length > endIndex;
		const totalLines = rawLines.length;

		// signal abort 支持
		if (signal?.aborted) {
			throw new Error('aborted');
		}

		return { page, hasMore, totalLines, fileSize, mtime, truncatedLines };
	}

	/** mtime-based 去重 stub（对齐 Hermes _dedup_read_file）。 */
	function checkReadDedup(agentKey: string, readKey: string, mtime: number): { unchanged: boolean; blocked: boolean; stubCount: number } {
		const fullKey = `${agentKey}:${readKey}`;
		const prev = _readDedupMap.get(fullKey);

		if (!prev) {
			_readDedupMap.set(fullKey, { mtime, stubCount: 0 });
			if (_readDedupMap.size > READ_DEDUP_CAP) { _readDedupMap.delete(_readDedupMap.keys().next().value!); }
			return { unchanged: false, blocked: false, stubCount: 0 };
		}

		if (prev.mtime === mtime) {
			prev.stubCount++;
			if (prev.stubCount >= READ_DEDUP_BLOCK) {
				return { unchanged: true, blocked: true, stubCount: prev.stubCount };
			}
			return { unchanged: true, blocked: false, stubCount: prev.stubCount };
		}

		// mtime 变化 → 重置
		_readDedupMap.set(fullKey, { mtime, stubCount: 0 });
		if (_readDedupMap.size > READ_DEDUP_CAP) { _readDedupMap.delete(_readDedupMap.keys().next().value!); }
		return { unchanged: false, blocked: false, stubCount: 0 };
	}

	/** 连续重复读取检测（对齐 Hermes _REPEATED_READ_WARNING_COUNT / _REPEATED_READ_BLOCK_COUNT）。 */
	function checkReadRepeat(agentKey: string, readKey: string): { count: number; warning: boolean; blocked: boolean } {
		const fullKey = `${agentKey}:${readKey}`;
		const prev = _readRepeatMap.get(fullKey);

		if (!prev || prev.key !== readKey) {
			_readRepeatMap.set(fullKey, { key: readKey, count: 1 });
			if (_readRepeatMap.size > READ_REPEAT_CAP) { _readRepeatMap.delete(_readRepeatMap.keys().next().value!); }
			return { count: 1, warning: false, blocked: false };
		}

		prev.count++;
		if (prev.count >= READ_REPEAT_BLOCK) {
			return { count: prev.count, warning: true, blocked: true };
		}
		if (prev.count >= READ_REPEAT_WARN) {
			return { count: prev.count, warning: true, blocked: false };
		}
		return { count: prev.count, warning: false, blocked: false };
	}

	/** 文件不存在时建议相似文件名（对齐 Hermes _suggest_similar_files）。 */
	async function suggestSimilarFiles(resolvedPath: string): Promise<string[]> {
		const uri = URI.file(resolvedPath);
		const dirUri = URI.joinPath(uri, '..');
		const fileName = uri.path.split('/').pop() ?? '';

		try {
			const stat = await ctx.fileService.resolve(dirUri);
			if (!stat.children || stat.children.length === 0) { return []; }

			const candidates = stat.children
				.filter(c => !c.isDirectory)
				.map(c => c.name);
			if (candidates.length === 0) { return []; }

			// 2026-09-07：比较前做 Unicode 规范折叠（借鉴 Hermes-Agent
			// `_unicode_variant_match`）。macOS 用 NFD 分解存储文件名、截图名含
			// 窄不换行空格 U+202F、Finder 重命名会把 ' 变成弯引号 U+2019——
			// 这些差异在终端/UI 里**肉眼不可见**，不折叠就会误判为"文件不存在"。
			const canon = (s: string): string => s.normalize('NFC')
				.replace(/[  ]/g, ' ')
				.replace(/[‘’]/g, "'")
				.toLowerCase();

			const lowerName = canon(fileName);
			const scored = candidates.map(name => ({
				name,
				dist: _levenshtein(lowerName, canon(name)),
			}));

			const threshold = Math.max(fileName.length / 2, 3);
			return scored
				.filter(s => s.dist <= threshold)
				.sort((a, b) => a.dist - b.dist)
				.slice(0, 5)
				.map(s => s.name);
		} catch {
			return [];
		}
	}

	ctx.logService.info('[BuiltinTools] _registerCoreTools: starting to register core tools');

	// ── clarify: 向用户提问（支持单问题 / 多问题表单） ──────────
	ctx.register({
		definition: {
			name: 'clarify',
			description: [
				'Ask the user clarifying questions. Supports single-question mode (question + options)',
				'or multi-question form mode (questions array). Use multi-question mode when you have',
				'several independent points to clarify at once, saving round-trips.',
				'Each question can have optional multiple-choice options (1-4 items).',
				'The user\'s answers will arrive as a new message.',
			].join(' '),
			inputSchema: {
				type: 'object',
				properties: {
					question: { type: 'string', description: 'Single question (use this OR questions[], not both)' },
					options: {
						type: 'array',
						items: { type: 'string' },
						description: 'Multiple-choice options for single-question mode (1-4 items).',
						maxItems: 4,
					},
					questions: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								question: { type: 'string', description: 'The question text' },
								options: {
									type: 'array',
									items: { type: 'string' },
									description: 'Multiple-choice options for this question (optional, 1-4 items).',
									maxItems: 4,
								},
								id: { type: 'string', description: 'Short identifier for this question (optional, auto-generated if omitted).' },
							},
							required: ['question'],
						},
						description: 'Batch of questions (2-8 items). Each question may have its own options.',
						maxItems: 8,
					},
				},
				required: [],
			},
			category: 'clarify',
			source: ctx.id,
		},
		handler: async args => {
			// ── 多问题模式 ──────────────────────────────
			const questionsArr = Array.isArray(args['questions']) ? (args['questions'] as unknown[]) : undefined;
			if (questionsArr && questionsArr.length > 0) {
				const items = questionsArr
					.filter((q: any) => q && typeof q.question === 'string' && q.question.trim())
					.map((q: any, i: number) => ({
						id: q.id || `q${i}`,
						question: String(q.question).trim(),
						options: Array.isArray(q.options) ? (q.options as unknown[]).map(String) : undefined,
					}));
				if (items.length === 0) {
					throw new NonRetryableToolError('Error: at least one valid question is required');
				}
				return [{
					type: 'text' as const,
					text: JSON.stringify({ __clarify__: true, questions: items }),
				}];
			}

			// ── 单问题模式（向后兼容） ─────────────────
			const question = String(args['question'] ?? '').trim();
			if (!question) {
				throw new NonRetryableToolError('Error: question or questions[] parameter is required');
			}
			const options = Array.isArray(args['options']) ? (args['options'] as unknown[]).map(String) : undefined;
			return [{
				type: 'text' as const,
				text: JSON.stringify({ __clarify__: true, question, options }),
			}];
		},
	});

	// ── filesystem ─────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'file_read',
			// ⚠ description 必须声明「输出带总行数」与「limit:1 探查规模」这两点
			// （2026-08-22）：这是**已实现但模型不知道**的能力，缺了它模型会去跑
			// `(Get-Content x).Count` / `wc -l` —— shell 工具是 Dangerous 级、必然弹
			// 审批打断执行。防线 `_verify_tool_description_coverage.mjs` 会断言此处
			// 提到 totalLines / File info，删掉会报错。
			description: 'Read a UTF-8 text file with line numbers and pagination. Output format: LINE_NUM|CONTENT (e.g. 34|foo). '
				+ 'Every response ends with the file\'s TOTAL line count. '
				+ 'To check how large a file is (line count + size in KB) without reading it, call this with limit:1 — '
				+ 'the response includes a "[File info: N 行, X KB]" line. '
				+ 'NEVER use shell commands to count lines or measure files (e.g. (Get-Content x).Count, wc -l): '
				+ 'shell tools require user approval and will interrupt you, while this tool does not. '
				+ 'Use offset/limit for large files. Binary files are rejected by extension.',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path. MUST be grounded: copy it verbatim from a previous tool result (search_files / search_graph / search_code / file_read) — never assemble or recall a path from memory. Relative paths resolve against the primary workspace root; in a multi-folder workspace prefer the absolute path returned by the search tool.' },
					offset: { type: 'integer', description: 'Line number to start reading from (1-indexed, default: 1)', default: 1, minimum: 1 },
					limit: { type: 'integer', description: 'Maximum number of lines to read (default: 500, max: 2000). Use limit:1 to probe a file\'s total line count and size without reading its content.', default: 500, maximum: 2000 },
				},
				required: ['path'],
			},
			category: 'filesystem',
			source: ctx.id,
		},
		handler: async (args, signal, agentId) => {
			const requestedPath = resolvePathArg(args);
			if (!requestedPath) {
				throw new Error('path is required');
			}

			const offset = Math.max(1, Number(args['offset'] ?? 1));
			const limit = Math.min(Math.max(Number(args['limit'] ?? 500), 1), READ_MAX_LIMIT);

			// 读操作：仅解析相对路径为绝对路径，不触发沙箱判定
			let resolvedPath = await ctx.resolveAndCheckWorkspacePath(agentId, requestedPath, false);

			// ── 多根兜底探测（2026-09-07）──────────────────────────────────
			// 借鉴 Continue `resolveRelativePathInDir`（core/util/ideUtils.ts:19）：
			// 它把相对路径在**每个** workspace 根下探测、取首个存在者。而我们的
			// resolveWorkspacePath 只对首个允许根解析 → 多根工作区下，模型拿着
			// 另一个仓库里的相对路径会 File not found。
			// 这里只在「首根解析结果不存在」时兜底遍历其余根（**成功路径行为不变**，
			// 零回归风险），为后续输出「最短唯一相对路径」铺路。
			if (!/^[a-zA-Z]:[\\/]/.test(requestedPath) && !requestedPath.startsWith('/')) {
				try {
					if (!await ctx.fileService.exists(URI.file(resolvedPath))) {
						for (const folder of ctx.workspaceService.getWorkspace().folders) {
							const candidate = URI.joinPath(folder.uri, requestedPath).fsPath;
							if (candidate !== resolvedPath && await ctx.fileService.exists(URI.file(candidate))) {
								ctx.logService.info(`[coreTools] file_read: "${requestedPath}" not under primary root; resolved via "${candidate}"`);
								resolvedPath = candidate;
								break;
							}
						}
					}
				} catch { /* 探测失败 → 沿用原解析结果，行为不变 */ }
			}

			// 二进制守护 —— 文案按扩展名分类，必须给出**可执行**的下一步
			// （图片 → 点名 `vision_analyze`；文档 → 转换建议；其余 → 说明本工具只读文本）
			if (isBinaryPath(resolvedPath)) {
				throw new Error(binaryReadRejectedMessage(requestedPath, resolvedPath));
			}

			// ── 设备/内核伪文件系统：恒拦（读取会阻塞或泄露内核信息）──────
			const readDeviceHit = detectDevicePath(resolvedPath);
			if (readDeviceHit) {
				throw new NonRetryableToolError(devicePathBlockedMessage(readDeviceHit, 'read'));
			}
			// ── 凭据/密钥路径：受 chat.agent.sensitiveReadGuard 控制（默认开启）──
			// 此前该配置已注册但【从未被任何代码消费】，且读表长期落后于写表，
			// 导致 ~/.ssh/id_rsa、~/.aws/credentials、.env.local 等可被读取并
			// 随对话历史上传。此处接线配置 + 共享表，消除该泄露面。
			const sensitiveReadGuardEnabled = ctx.configurationService.getValue<boolean>(
				AgentNetworkDomainSettingId.SensitiveReadGuard,
			) ?? true;
			if (sensitiveReadGuardEnabled) {
				const sensitiveHit = detectSensitivePath(resolvedPath);
				if (sensitiveHit) {
					ctx.logService.warn(
						`[coreTools] file_read BLOCKED: ${requestedPath} matches sensitive ${sensitiveHit.kind} "${sensitiveHit.matched}"`,
					);
					throw new NonRetryableToolError(sensitiveReadBlockedMessage(sensitiveHit));
				}
			}

			// 连续重复读取检测
			const agentKey = agentId ?? '';
			const readKey = `${resolvedPath}:${offset}:${limit}`;
			const repeatResult = checkReadRepeat(agentKey, readKey);
			if (repeatResult.blocked) {
				throw new Error(`BLOCKED: You have read this exact file region ${repeatResult.count} times consecutively. Review the content already returned. If the file has been modified, use a different offset or a different tool.`);
			}

			// 读取文件（带 FileNotFound → 相似文件建议）
			let page: string[];
			let hasMore: boolean;
			let totalLines: number;
			let fileSize: number;
			let mtime: number;
			/** 本页中被截断的长行（1-based 行号）—— 供尾部长行提示使用（P2-⑦）。 */
			let truncatedLines: number[] = [];

			try {
				const result = await readFileLines(resolvedPath, offset, limit, signal);
				page = result.page;
				hasMore = result.hasMore;
				totalLines = result.totalLines;
				fileSize = result.fileSize;
				mtime = result.mtime;
				truncatedLines = result.truncatedLines;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// ── 畸形路径识别（2026-09-07，日志 1788763596406）────────────────
				// 上游工具（如 search_files 索引快路径）曾产出「工作区根 + 绝对路径」
				// 的畸形路径 `g:/…/repo/g:\Custom…`；模型照抄后 file_read 只会得到一句
				// "File not found"，既不说路径畸形、也不提示去重新定位。这里在消费侧
				// 再兜一层：识别出多个盘符段 → 明确指出并要求重新取路径。
				const driveHits = resolvedPath.match(/[a-zA-Z]:[\\/]/g);
				if (driveHits && driveHits.length > 1) {
					ctx.logService.warn(`[coreTools] file_read got a MALFORMED path (multiple drive segments): ${resolvedPath}`);
					recordFileReadFailure(resolvedPath, 'malformed path');
					throw new NonRetryableToolError(
						`Malformed path: "${requestedPath}" resolves to "${resolvedPath}", which contains more than one ` +
						`drive/root segment (a workspace root joined with an absolute path). This path can never exist. ` +
						`Do NOT retry it — re-locate the file with search_files / search_code and copy the path from its output.`,
					);
				}
				// ★ 2026-09-07：原判断漏了 'nonexistent'（"Unable to resolve nonexistent
				// file"，fileService 的标准措辞不含 "not exist"/"not found"）→ 该形态
				// 走 throw err 原样透传，无相似建议无纠错反馈（日志 1788713328385：
				// 幻觉路径 webidx\... 原样回给模型，随后 patch 用猜的内容连败 5 次）。
				const notFound = msg.includes('FILE_NOT_FOUND') || msg.includes('ENOENT') || msg.includes('not found')
					|| msg.includes('not exist') || msg.includes('nonexistent') || msg.includes('resolve nonexistent');
				// read-state 登记（无论走哪个反馈分支，失败都要记）——patch 失败时
				// describeReadGap 据此点破「你从未成功读过该文件」（本次事故直接解药）。
				recordFileReadFailure(resolvedPath, msg);
				if (notFound) {
				// NonRetryableToolError（2026-08-21）：文件不存在是**确定性失败** ——
				// 3 秒退避内文件不会自己出现。日志 1787292837471 实测 3 个不存在的临时
				// 文件各被重试 3 次（9 次调用 + ~6s 退避），模型只拿到同一条错误重复 3 遍。
				const suggestions = await suggestSimilarFiles(resolvedPath);
				if (suggestions.length > 0) {
					throw new NonRetryableToolError(`File not found: ${requestedPath}\nDid you mean one of these?\n${suggestions.map(s => `  - ${s}`).join('\n')}`);
				}
				// 事故（日志 1786172213634）：LLM 凭记忆/推断拼路径（如
				// Engine\Source\\UObject\GarbageCollection.cpp 少了一级 Runtime\CoreUObject\Private），
				// 父目录也不存在 → suggestSimilarFiles 必然空 → 原始错误无引导，模型盲试 3 次。
				// 此处给可执行的纠错反馈：引导用 search_files 拿真实绝对路径（对齐范式"可执行的纠错反馈"）。
				throw new NonRetryableToolError(
					`File not found: ${requestedPath}\n` +
					`The parent directory does not exist either. This is usually caused by manually guessing or assembling a path ` +
					`instead of copying the exact absolute path from a search result.\n` +
					`Action: call search_files with filePattern "**/${requestedPath.split(/[\\/]/).pop()}" ` +
					`(e.g. **/GarbageCollection.cpp) to locate the real absolute path, then pass that exact path to file_read. ` +
					`Do NOT guess the path again.`
				);
			}
			throw err;
			}

			// 去重 stub
			const dedupResult = checkReadDedup(agentKey, readKey, mtime);
			// read-state 登记（2026-09-07）：成功读取即记录，patch 失败时
			// describeReadGap 据此区分「从未读过」vs「读取后文件已变」。
			// P3（2026-09-12）：一并登记 mtime 作为「外部修改检测」的基线 —— patch 会用它
			// 判断文件是否在本会话读取后被用户/其他进程改过。
			recordFileReadSuccess(resolvedPath, mtime);
			if (dedupResult.blocked) {
				throw new Error(`BLOCKED: This file region has not changed since your last ${dedupResult.stubCount} reads. The content is unchanged — review what you already have.`);
			}
			if (dedupResult.unchanged) {
				const status = dedupResult.stubCount >= 1
					? `unchanged (previously read ${dedupResult.stubCount} time(s), content identical)`
					: 'unchanged';
				return text(`(file ${status})`);
			}

			// 空结果
			if (page.length === 0) {
				return text(`(empty or beyond end of file: offset=${offset})`);
			}

			// 行号格式：紧凑 `LINE_NUM|CONTENT`
			const out = page.map((line, i) => `${offset + i}|${line}`).join('\n');
			const lastLine = offset + page.length - 1;

			// P0: 总字符上限检查（对齐 Hermes 100K）
			if (out.length > READ_MAX_CHARS) {
				const truncated = out.slice(0, READ_MAX_CHARS);
				const truncatedTail = `\n\n[截断: 输出 ${out.length} 字符，超过安全上限 ${READ_MAX_CHARS}。已截取前 ${READ_MAX_CHARS} 字符。建议用更小的 limit 或 offset 分段读取。]`;
				return text(redactSecrets(truncated + truncatedTail));
			}

			const tailParts: string[] = [];

			// 分页提示
			if (hasMore) {
				tailParts.push(`[Hint: 已显示第 ${offset}-${lastLine}/${totalLines} 行。使用 offset=${lastLine + 1} 读取后续内容。]`);
			} else {
				tailParts.push(`[已显示第 ${offset}-${lastLine} 行，文件结束 (${totalLines} 行总计)]`);
			}

		// 大文件提示
		if (fileSize > LARGE_FILE_HINT_BYTES && limit > LARGE_FILE_HINT_MIN_LIMIT) {
			tailParts.push(`[Hint: 这是一个大文件 (${(fileSize / 1024).toFixed(0)}KB)。考虑用更小的 limit 值分段读以加快速度。]`);
		}

		// ── 探查性读取的规模元信息（2026-08-22）─────────────────────────────
		// 背景：模型想知道「某文件有多少行/多大」时会去跑 shell
		// （`(Get-Content x).Count` / `wc -l`），而 shell 工具是 Dangerous 级、
		// 必然弹审批打断执行 —— 实测日志里就出现过 `cd X && (Get-Content ...).Count`
		// 与 `powershell -NoProfile -Command "..."` 两种写法，两者都过不了只读白名单。
		//
		// 而本工具**早就**在返回值里带了 totalLines（上面的分页提示），只差 fileSize：
		// 原大文件提示要求 `limit > 200`，恰好把「limit=1 探查规模」这种最省 token 的
		// 用法排除在外。这里为探查性读取补一条元信息行，使
		//     file_read(path, limit: 1)
		// 成为「零审批、~30 token 拿到 行数 + 字节数」的正规做法（description 已声明）。
		//
		// 仅在 limit 很小且确实还有后续内容时输出：正常分段阅读（limit 数百）不受影响，
		// 读完整小文件时也不输出（那种情况规模已一目了然），避免给常规路径加噪音。
		// ★ P2-⑦（2026-09-21，pi 对照）：超长行被截断时必须给出**可执行出路** ——
		// 否则模型只会：① 以为内容就这么多（误判），或 ② 重读整个文件（长行文件往往极大）✗。
		// 文案真源在 common/fileReadHints（纯函数、可单测；含方言分支与「别重读」劝阻）。
		if (truncatedLines.length > 0) {
			tailParts.push(longLineTruncationHint({
				firstLine: truncatedLines[0],
				truncatedCount: truncatedLines.length,
				maxChars: READ_LINE_MAX_CHARS,
			}, resolvedPath));
		}

		if (limit <= PROBE_LIMIT_MAX && hasMore) {
			tailParts.push(`[File info: ${totalLines} 行, ${(fileSize / 1024).toFixed(1)}KB。此为规模探查读取；不要用 shell 命令数行数。]`);
		}

		// 2026-07-26（P2，Continue FileTooLarge 思路）：动态上下文保护——
		// 一次性吞下整个文件时，按估算 token 与上下文窗口占比警告。
		// Continue 超上下文 50% 直接抛错；我们选择「警告不阻止」：
		// 让模型量化感知（约占上下文 P%），引导探索场景改用局部读取。
		if (offset === 1 && !hasMore && totalLines >= 500) {
			const estimatedTokens = Math.ceil(out.length / 4);
			if (estimatedTokens >= 8_000) {
				const pct = (estimatedTokens / CONTEXT_WINDOW_TOKENS * 100).toFixed(1);
				tailParts.push(`[Warning: 一次读取了整个文件（${totalLines} 行 ≈ ${estimatedTokens} tokens，约占上下文窗口的 ${pct}%）。探索代码时优先用 offset/limit 读取相关片段，或用 search_code/get_code_snippet 精准定位符号，避免大量无关内容占用上下文。]`);
			}
		}

		// 重复读取警告
		if (repeatResult.warning) {
			tailParts.push(`[Warning: 你已连续 ${repeatResult.count} 次读取完全相同的文件区域。]`);
		}

		// ── 越界读取未绑定 worktree 副本（2026-08-20，日志 1787217670299）────────
		// 读操作不做沙箱判定，`.worktrees/**` 对 file_read 完全可达；但它对
		// search_code / search_files / 代码图是硬排除的 → 模型在过期分支副本里
		// 工作而搜索永远无法印证（实测连续 10+ 轮在 feat-chat 副本里找主仓才有的
		// 符号）。warn 日志模型看不到，故必须把警告写进工具结果。
		if (ctx.getBoundWorktreeRoot) {
			try {
				const bound = await ctx.getBoundWorktreeRoot(agentId);
				const hit = detectStaleWorktreeAccess(resolvedPath, bound);
				if (hit) { tailParts.push(staleWorktreeWarning(hit, 'read')); }
			} catch { /* 绑定解析失败不影响读取 */ }
		}

			const tail = tailParts.length > 0 ? '\n\n' + tailParts.join('\n') : '';

			// 密钥脱敏
			const sanitized = redactSecrets(out + tail);
			return text(sanitized);
		},
	});

	ctx.register({
		definition: {
			name: 'file_write',
			description: 'Write a UTF-8 text file (overwrites). Creates parent directories as needed. For large files (>8KB), prefer writing in multiple smaller steps rather than one big call: a single very large write may hit the model output limit and get truncated, leaving the file incomplete or corrupted. Write an initial portion with this tool, then append the remaining sections with follow-up `patch` calls (use the tail of the already-written content as the search anchor).',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path. MUST be grounded: copy it verbatim from a previous tool result (search_files / search_graph / search_code / file_read) — never assemble or recall a path from memory. Relative paths resolve against the primary workspace root; in a multi-folder workspace prefer the absolute path returned by the search tool.' },
					content: { type: 'string' },
				},
				required: ['path', 'content'],
			},
			category: 'filesystem',
			source: ctx.id,
			securityLevel: ToolSecurityLevel.Dangerous,
		},
		handler: async (args, _signal, agentId) => {
			const requestedPath = resolvePathArg(args);
			if (!requestedPath) {
				throw new Error('path is required');
			}

			// 路径遍历保护
			const resolvedPath = await ctx.resolveAndCheckWorkspacePath(agentId, requestedPath);
			const normalizedUri = URI.file(resolvedPath);
			let content = String(args['content'] ?? '');

			// ── 敏感 / 设备路径拒绝（共享表 sensitivePaths.ts，与读同一真源）──────
			// 写凭据/密钥文件无合理场景，恒拦（不受 sensitiveReadGuard 影响）。
			// 2026-09-13：抽成 `sensitiveWriteRejection` **单一入口** —— 此前只有本工具
			// 有这一步，`patch` 完全没有（同一份敏感路径，file_write 硬拒、patch 只需
			// 点一次「允许」就能写）。详见 sensitivePaths 模块注释。
			const sensitiveWriteHit = sensitiveWriteRejection(resolvedPath);
			if (sensitiveWriteHit) {
				ctx.logService.warn(
					`[coreTools] file_write BLOCKED (${sensitiveWriteHit.kind}): ${requestedPath} matches "${sensitiveWriteHit.matched}"`,
				);
				throw new NonRetryableToolError(sensitiveWriteHit.message);
			}

			// ── P1: 行尾保持（对齐 Hermes）──────────────────────────
			let existingLineEnding: string | undefined;
			let existingMtime: number | undefined;
			try {
				const existing = await ctx.fileService.readFile(normalizedUri);
				const existingText = typeof existing.value === 'string' ? existing.value : existing.value.toString();
				existingMtime = (existing as any).mtime as number | undefined;
				if (existingText.includes('\r\n')) {
					existingLineEnding = '\r\n';
				}
			} catch {
				// 文件不存在 → OK（首次创建）
			}
			if (existingLineEnding) {
				content = content.replace(/\r?\n/g, existingLineEnding);
			}

			// ── P1: 文件过期检查（对齐 Hermes _check_file_staleness）───
			const lastReadMtime = _fileReadMtimeMap.get(resolvedPath);
			if (lastReadMtime !== undefined && existingMtime !== undefined && existingMtime > lastReadMtime) {
				ctx.logService.warn(`[coreTools] file_write: ${resolvedPath} was modified externally since last read (mtime ${lastReadMtime} → ${existingMtime}). Proceeding with caution.`);
			}

			// Checkpoint (Void-inspired): snapshot before overwriting.
			if (agentId) {
				await ctx.checkpointService.captureBeforeToolEdit(agentId, normalizedUri.toString(), content);
			}

			// ── P0: 原子写（对齐 Hermes temp→mv）──────────────────────
			const tmpPath = resolvedPath + '.tmp.' + Date.now();
			const tmpUri = URI.file(tmpPath);
			await ctx.fileService.writeFile(tmpUri, VSBuffer.fromString(content));
			try {
				await ctx.fileService.move(tmpUri, normalizedUri, true);
			} catch (renameErr) {
				// move 失败时尝试删除临时文件并重抛
				try { await ctx.fileService.del(tmpUri); } catch { /* best effort */ }
				throw renameErr;
			}
			// ★ 2026-09-07（P3 配套，对齐 Claude Code 的 Write 标记已读）：写成功后
			// 登记 read-state。内容是本次调用自己写的、完全已知，等价于「读过」——
			// 若不登记，`file_write 建文件 → patch 微调` 这一常见流程会被 P3
			// read-before-edit 硬闸误拦，强迫模型多读一次（纯浪费一轮）。
			recordFileReadSuccess(resolvedPath);
			return text(`wrote ${content.length} chars to ${normalizedUri.fsPath}`);
		},
	});

	// ── terminal ────────────────────────────────────────────────────
	// 2026-08-18（Hermes 环境归一）：Windows 上优先 Git Bash（POSIX 方言天然正确）；
	// 未安装 Git Bash 的机器回退 PowerShell/cmd，描述后半段覆盖该场景。
	// 描述是注册期静态文本（探测是运行期异步），故用「主声明 POSIX + 回退提示」双段式：
	// 有 Git Bash（常态，开发者机器基本都装 Git）模型第一选择写 Unix 即对；
	// 无 Git Bash 时 Unix 拦截护栏（下方 handler 内）兜底纠错为 PowerShell 写法。
	// 2026-08-21：改用 shellPlatformPrompt 统一生成（借鉴 opencode per-platform prompt），
	// 内含「别用 shell 做这件事、用这个工具」映射表 —— 事前掐掉方言/工具选择错误的
	// 动机，与运行时护栏（Unix 拦截 + PowerShell cmdlet 反向拦截）形成预防+兜底双层。
	const terminalPlatformNote = isWindows
		? windowsDualShellGuidance('terminal')
		: shellPlatformGuidance('posix', 'terminal');
	// ★ 描述由审批策略生成（P2-12，2026-08-30）：审批关闭时「shape 强制打断执行」的
	// 后果不发生，整段指引不下发（见 shellApprovalGuidance）。
	const approvalEnabled = ctx.configurationService.getValue<boolean>('tools.confirmToolCalls') ?? true;
	ctx.register({
		definition: {
			name: 'terminal',
			// 分工说明（2026-08-22，对齐 MiMo-Code 把交互式需求单独抽成 bash-interactive
			// 的做法）：terminal 走**交互式 PTY**，在 UI 中可见、命令执行期间用户可接管。
			// 代价是完成判定依赖 shell integration，未注入时只能靠提示符启发式推断，
			// 且拿不到退出码。日志 1787324352413 中模型用 terminal 跑 `npx tsc --noEmit`
			// （纯粹要一个确定结果）本身就是次优选择 —— 8 次全部没拿到输出。把边界写进
			// description，让模型在选工具时就分流。
			//
			// ★ 2026-09-21 更正（P2-⑦）：此前注释写「复用同一个 shell 会话」，**与实现不符** ——
			// 每次调用都 `createTerminal` 新建实例、竞速结束后 `dispose`（不复用，也不保留
			// cwd/env 的跨调用状态）。注释失实会误导后续维护者在「会话复用」这个不存在的
			// 前提上做设计（例如以为可以依赖上次的 cd），故按实现更正。
			description: 'Execute a shell command in an interactive terminal and return the output. Works on desktop only.'
				+ ' Use this for commands where you want the terminal visible while it runs (interactive sessions, long-running dev servers,'
				+ ' commands the user may want to take over mid-flight). Each call gets its own fresh terminal session.'
				+ ' For commands where you mainly need a deterministic result — builds, type checks, test runs, linters, anything whose'
				+ ' exit code or full output you intend to act on — prefer execute_code, which runs the command once, waits for real'
				+ ' completion and returns stdout, stderr and the real exit code.'
				+ terminalPlatformNote
				// 审批形态提示与 execute_code 共用同一份真源（shellCommandSafety），
				// 两个工具都是 Dangerous 级、都吃 command 参数，规则完全一致。
				// ★ 按审批开关条件下发（P2-12）。
				+ shellApprovalGuidance(approvalEnabled),
			inputSchema: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'Shell command to execute' },
					cwd: { type: 'string', description: 'Working directory (defaults to workspace root)' },
					// ★ 2026-09-21（P0-③）：显式给出**上限** —— 此前 Schema 只写 default:30，
					// 而实现另有 60s 静默硬顶，模型传 300 会被无声截断（现已去掉硬顶）。
					timeout: { type: 'number', description: 'Command timeout in seconds (default: 30, max: 300)' },
				},
				required: ['command'],
			},
			category: 'terminal',
			source: ctx.id,
			securityLevel: ToolSecurityLevel.Dangerous,
		},
		available: () => typeof process !== 'undefined' || typeof navigator !== 'undefined',
		handler: async (args, signal, agentId, sessionId, toolCallId) => {
		const command = String(args['command'] ?? '').trim();
		if (!command) { throw new Error('command is required'); }
		// ─── 执行前护栏（2026-09-13：收敛为共享入口）──────────────────────
		// 四条护栏（HARDLINE / 裸源码 / 源码写入 / 混淆-下载即执行）原先与
		// `execute_code` **各写一份** → 实际漂移：**后两条只挂在 execute_code 上**，
		// 同一句 `curl … | bash`（RCE / prompt-injection 向量）走 terminal 就能绕过。
		// 现统一走 `shellPreflightGuards.shellPreflightRejection`（单一入口）。
		// `cwd` 必须传进护栏（与 `execute_code` 对称）：目标写成**裸文件名**时，
		// 只有拼上运行目录才能判出「它其实是产物」。
		const cwdArg = typeof args['cwd'] === 'string' ? (args['cwd'] as string).trim() : '';
		const rejection = shellPreflightRejection(command, 'terminal', cwdArg || undefined);
		if (rejection) {
			ctx.logService.warn(`[coreTools] terminal BLOCKED (${rejection.kind}): ${rejection.detail}`);
			throw new NonRetryableToolError(rejection.message);
		}
		// Hermes 环境归一（2026-08-18）：探测 Git Bash（进程级缓存，首次后零开销）。
		// 可用 → 终端直接跑 bash（POSIX 方言）；不可用 → 回退 PowerShell/cmd。
		// 注意（2026-08-30）：「跑 bash」不等于「跳过拦截」—— 见下方 dialect 注释，
		// 两套护栏按方言各开一套，而不是有 Git Bash 就全关。
		const gitBash = isWindows ? await detectGitBash(ctx.fileService, ctx.logService) : undefined;
		// ★ 方言真源（2026-08-30，日志 20260829T232635）：与 execute_code 对齐。
		// 此前两套护栏共用一个 `isWindows && !gitBash` 布尔门（Git Bash 在 → 两套全关），
		// 而正确语义是按方言各开一套：
		//   · dialect='cmd'   → 拦 Unix-only 命令 + 拦 PowerShell cmdlet
		//   · dialect='posix' → 只拦 PowerShell cmdlet（head/grep 在 bash 里真实可用）
		// ★ 方言真源（2026-08-30）：与 execute_code 共用 common/shellDialect.ts 的
		// resolveShellDialect()，不再各自内联同一行表达式。
		const dialect = resolveShellDialect(!!gitBash);
		// Unix-only 命令护栏（日志 1786264843850）：仅 cmd.exe 方言 —— cmd.exe/PowerShell
		// 下 head/tail/grep/sed/awk 必败。Git Bash 模式下这些命令真实可用，拦截反而误伤。
		if (dialect === 'cmd') {
			const unixCmd = detectUnixOnlyCommand(command);
			if (unixCmd) {
				// NonRetryableToolError（2026-08-21 修不对称）：这是**纯静态字符串校验**，
				// 命令名不会在重试间隙变对。旧版抛普通 Error → toolExecutor 判为可重试
				// → 退避重试 3 次（日志 1787292837471 L4632/4646/4673 实证：同一条护栏
				// 错误重复 3 遍 + ~3s 无谓退避），而 execute_code 同类护栏
				// （compatibilityTools.ts）早已用 NonRetryableToolError。此处对齐。
				throw new NonRetryableToolError(
					`terminal: Unix-only command '${unixCmd}' is not available on Windows (cmd.exe/PowerShell, Git Bash not installed). ` +
					`Rewrite the pipeline with a PowerShell equivalent: ... | ${UNIX_ONLY_COMMAND_HINTS[unixCmd] ?? unixCmd} ` +
					`(e.g. powershell -NoProfile -Command "<your cmd> | Select-Object -First 60"), then reissue terminal with the corrected command. ` +
					`${GIT_BASH_INSTALL_GUIDANCE}`
				);
			}
			}
		// 反向护栏（2026-08-21）：PowerShell cmdlet 裸用在 cmd.exe 必败
		// （`... | Out-String` → exit 255）。
		//
		// ★ 2026-08-30（日志 20260829T232635）：与 execute_code 同款缺陷 —— 本块原在
		// `isWindows && !gitBash` 内，Git Bash 方言下完全不拦，而 PowerShell cmdlet 在
		// bash 里同样不存在（exit 127 `command not found`）。现移出方言门控：cmd 与
		// posix 都拦，正确做法按方言区分（包 powershell 外壳 vs 改用 POSIX 命令）。
		if (dialect !== 'powershell') {
			const psCmdlet = detectPowerShellOnlyCmdlet(command);
			if (psCmdlet) {
				throw new NonRetryableToolError(powerShellCmdletGuardMessage(psCmdlet, 'terminal', dialect));
			}
		}
		const requestedCwd = args['cwd'] ? String(args['cwd']) : '.';
		// 2026-08-09：沙箱仅限制【写】操作。terminal 属执行/读性质，cwd 解析
		// 不触发沙箱判定（checkSandbox=false），允许按用户要求自由访问任意目录。
		const resolvedCwd = await ctx.resolveAndCheckWorkspacePath(agentId, requestedCwd, false);
		const timeoutSec = Math.min(Math.max(Number(args['timeout'] ?? 30), 1), 300);

		// ── 搜索类命令识别（一次检测，供熔断 + hint 复用）────────────────
		const searchGuardHit = detectTerminalSearchCommand(command);

		// ── 第四道搜索熔断：terminal 重复搜索（2026-08-21，事故 1787282838177）──
		// 前三道闸门（recordSearchRepeat / EmptyStreak / IntentRepeat）只覆盖
		// search_code / search_files，模型改用 shell grep 即可全部绕过：事故日志中
		// 47 轮迭代 78 个工具调用反复 Select-String / Get-ChildItem 同一批文件，
		// 零拦截 → 上下文 4.4 万 token → 触发压缩 → 摘要挂死。
		//
		// ★ 必须拦在 executeTerminalCommand **之前** —— 拦在之后命令已经全树扫完，
		// 时间与上下文都已消耗，熔断就失去意义（只省了模型读结果的那点 token）。
		// 只对搜索类命令计数；build/run/test/git 等一律放行。
		if (searchGuardHit) {
			const repeat = ctx.searchHelpers.recordTerminalSearchRepeat(agentId, command, searchGuardHit);
			if (repeat.blocked) {
				ctx.logService.warn(
					`[coreTools] terminal search BLOCKED (repeat=${repeat.count} fingerprint=${repeat.fingerprint} ` +
					`pattern=${searchGuardHit.id}): ${command.slice(0, 200)}`
				);
				// NonRetryableToolError：熔断是确定性判定，重试无意义（对齐 hardline 的用法）
				throw new NonRetryableToolError(repeat.blocked);
			}
			if (repeat.count > 1) {
				ctx.logService.info(
					`[coreTools] terminal search repeat=${repeat.count} fingerprint=${repeat.fingerprint} (below threshold)`
				);
			}
		}

		const result = await executeTerminalCommand(command, resolvedCwd, timeoutSec, signal, gitBash, toolCallId);
			// ── 搜索类命令护栏（不阻断执行，仅提示）──────────────────────
			// find/grep -r/Get-ChildItem -Recurse 等纯搜索命令是 search_files/
			// search_code 的本职工作（索引快路径 + 结构化结果 + 无 shell 可移植性
			// 问题）。命中模式时在输出末尾追加 tool-hint 引导下次改用专用工具。
			// 模式表数据驱动，见 terminalCommandGuards.ts。
			if (searchGuardHit) {
				ctx.logService.info(`[coreTools] terminal search-like command detected (${searchGuardHit.id}) — appending tool hint`);
				result.push({ type: 'text', text: terminalSearchCommandHint(searchGuardHit) });
			}
			return result;
		},
	});

	return {
		resetPerTurn() {
			_readRepeatMap.clear();
			_readDedupMap.clear();
		},
	};
}
