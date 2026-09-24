/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `kb_feishu_sync` —— 知识库「笔记」→ 飞书知识库 同步工具（★ 2026-09-24）。
 *
 * 背景（用户需求「沉淀为技能给知识库 agent 用」）：同步能力本来只有视图上的「同步飞书」按钮
 * （可见终端里跑内置脚本）。本工具把同一套能力暴露给 **知识库专家 agent**（配技能 `kb-feishu-sync`）：
 *
 *   · **复用同一契约**：内置脚本 `resources/.agents/kb/feishu-sync.mjs` + `buildSyncArgs`
 *     （参数拼装单一真源，与按钮一致，不会漂移）；
 *   · **无头执行**：走主进程 `vscode:execCode` 通道（`execShortCommand`，child_process.spawn）——
 *     不开可见终端；Electron-as-node 需要 `ELECTRON_RUN_AS_NODE=1`，而该通道**固定 env**
 *     ⇒ 只能在命令串里加 shell 前缀（Windows: `set "…=1" && …`；POSIX: `…=1 …`）；
 *   · **结果回传走日志文件**：脚本会写 `<vault>/.feishu-sync.log`（UTF-8）；**不**回传 stdout ——
 *     主进程按本地控制台编码（简中 Windows 多为 GBK）解码 ⇒ 脚本输出的中文会乱码；
 *   · **长任务**：`timeoutMs = 600s`（通道尊重超时；超时会被杀，脚本是哈希增量的 ⇒ 下次接着跑）；
 *   · **审批**：`category: 'other'` ⇒ 默认策略下每次调用都要用户确认 —— **这是刻意的**：
 *     同步是**外部副作用**（写远端飞书），一次一确认是合适的成本；
 *   · **闸**：未在设置里启用飞书同步 / 未装 lark-cli / 找不到脚本 ⇒ 返回**引导文案**而不是报错。
 *
 * ⚠ 增量记账字段 `feishu.hash` / `remoteHash` / `syncedAt` 由脚本维护，agent **不得**手改。
 */

import { URI } from '../../../../../../base/common/uri.js';
import { isWindows } from '../../../../../../base/common/platform.js';
import type { IFileService } from '../../../../../../platform/files/common/files.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import type { INativeEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import type { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { ToolSecurityLevel } from '../../../common/providers.js';
import type { IToolResultContent } from '../../../common/providers.js';
import type { IBuiltinToolRegistration } from './toolRegistry.js';
import {
	AGENT_STUDIO_KB_FEISHU_SYNC_ENABLED,
	AGENT_STUDIO_KB_FEISHU_CLI_PATH,
	AGENT_STUDIO_KB_FEISHU_SYNC_SRC_DIRS,
	AGENT_STUDIO_KB_FEISHU_SYNC_PARENT,
	AGENT_STUDIO_KB_FEISHU_SYNC_ON_CONFLICT,
	AGENT_STUDIO_KB_FEISHU_SYNC_INTERVAL,
	AGENT_STUDIO_KB_FEISHU_CATEGORY_DEPTH,
	AGENT_STUDIO_KB_FEISHU_AUTO_CREATE_SPACES,
	AGENT_STUDIO_KB_FEISHU_PRUNE_REMOTE,
} from '../../../common/constants.js';
import {
	buildSyncArgs, detectLarkCli, resolveSyncScript, electronNodeLaunch,
	DEFAULT_LARK_CLI, LARK_CLI_MISSING_HINT, KB_FEISHU_SYNC_SCRIPT_REL, FEISHU_SYNC_LOG_FILE,
	execShortCommand, parseSrcDirs,
} from '../../knowledge/feishuSyncCore.js';
import { resolveKbRootUri } from '../../knowledge/kbVaultState.js';
import type { KbDiagramPrepareFn } from '../../knowledge/diagramSyncPrepare.js';

export interface KbFeishuSyncToolContext {
	register(registration: IBuiltinToolRegistration): void;
	fileService: IFileService;
	configurationService: IConfigurationService;
	environmentService: INativeEnvironmentService;
	storageService: IStorageService;
	logService: ILogService;
	/**
	 * 同步前「图表准备」（宿主注入；见 knowledge/diagramSyncPrepare.ts）。
	 *
	 * 飞书不渲染图表源码、图片也不支持 SVG ⇒ apply 前必须把 mermaid/drawio/canvas 转成 PNG。
	 * 该步骤 2026-09-24 起由**视图按钮与工具共用**；未注入时本工具跳过（功能降级，不报错）。
	 */
	prepareDiagrams?: KbDiagramPrepareFn;
}

/** 同步的最长等待（10 分钟）。哈希增量 ⇒ 超时被杀后下次接着跑，不丢进度。 */
const SYNC_TIMEOUT_MS = 600_000;
/** 回传的日志尾部上限（脚本日志可能很长）。 */
const LOG_TAIL = 6000;

export function registerKbFeishuSyncTools(ctx: KbFeishuSyncToolContext): void {
	const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

	ctx.register({
		definition: {
			name: 'kb_feishu_sync',
			description: [
				'把知识库「笔记」同步到飞书知识库（内置脚本 + lark-cli）。',
				'`mode: "dry-run"`（默认）只出计划不写远端 —— **先 dry-run 给用户看计划，确认后再 apply**。',
				'增量：按每篇 frontmatter 的 feishu.hash/remoteHash 判定，重复同步不会重复创建。',
				'目标与凭证取自「知识库设置 → 飞书同步」；本工具只覆盖：mode / srcDirs / prune。',
				'图表：`apply` 前会自动把笔记里的 mermaid / drawio 代码块与 `![[x.canvas]]` 嵌入渲染成 PNG 并改写引用'
				+ '（飞书不渲染图表源码、图片也不支持 SVG）；`dry-run` 只统计、不改文件。',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					mode: { type: 'string', enum: ['dry-run', 'apply'], description: '默认 dry-run（只打印计划）' },
					srcDirs: { type: 'array', items: { type: 'string' }, description: '要同步的库内相对目录（默认 ["笔记"]）' },
					prune: { type: 'boolean', description: '本地已删除的文档是否同时移除远端节点（默认 false）' },
				},
				required: [],
			},
			category: 'other',
			source: 'builtin',
			securityLevel: ToolSecurityLevel.Dangerous,
		},
		handler: async (args) => {
			const log = ctx.logService;

			// ① 功能开关（与「同步飞书」按钮同一道闸）
			if (ctx.configurationService.getValue<boolean>(AGENT_STUDIO_KB_FEISHU_SYNC_ENABLED) !== true) {
				return text('飞书同步尚未启用：请先到「知识库设置 → 飞书同步」开启并配置凭证，再让我同步。');
			}
			// ② lark-cli 检测
			const cliPath = (ctx.configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_CLI_PATH) || DEFAULT_LARK_CLI).trim();
			const cli = await detectLarkCli(cliPath);
			if (cli.state === 'missing') { return text(LARK_CLI_MISSING_HINT); }

			// ③ 内置脚本
			const script = await resolveSyncScript(ctx.fileService, ctx.environmentService);
			if (!script) {
				return text(`未找到内置同步脚本（${KB_FEISHU_SYNC_SCRIPT_REL}）——安装可能不完整，请重新安装应用。`);
			}

			// ④ 参数（默认值全部读配置 —— 与「同步飞书」按钮同一份口径，不另搞一套）
			const vaultRoot = resolveKbRootUri(ctx.storageService, ctx.environmentService);
			const mode: 'dry-run' | 'apply' = args['mode'] === 'apply' ? 'apply' : 'dry-run';
			const argDirs = args['srcDirs'];
			const cfgDirs = parseSrcDirs(ctx.configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_SYNC_SRC_DIRS));
			const srcDirs = Array.isArray(argDirs) && argDirs.length
				? argDirs.filter((d): d is string => typeof d === 'string' && d.trim() !== '').map(d => d.trim())
				: (cfgDirs.length ? cfgDirs : ['笔记']);   // ★ 用户语义：默认只同步「笔记区」（库里原始素材默认不同步）；设置里配过就按设置
			const rawInterval = ctx.configurationService.getValue<number>(AGENT_STUDIO_KB_FEISHU_SYNC_INTERVAL);
			const rawDepth = ctx.configurationService.getValue<number>(AGENT_STUDIO_KB_FEISHU_CATEGORY_DEPTH);
			const syncArgs = buildSyncArgs(script.fsPath, {
				vaultPath: vaultRoot.fsPath,
				srcDirs,
				parent: (ctx.configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_SYNC_PARENT) || 'my_library').trim(),
				onConflict: ctx.configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_SYNC_ON_CONFLICT) === 'skip' ? 'skip' : 'overwrite',
				intervalMs: Number.isFinite(rawInterval) && (rawInterval as number) >= 0 ? (rawInterval as number) : 800,
				categoryDepth: Number.isFinite(rawDepth) && (rawDepth as number) >= 0 ? (rawDepth as number) : 1,
				autoCreateSpaces: ctx.configurationService.getValue<boolean>(AGENT_STUDIO_KB_FEISHU_AUTO_CREATE_SPACES) !== false,
				prune: args['prune'] === true || ctx.configurationService.getValue<boolean>(AGENT_STUDIO_KB_FEISHU_PRUNE_REMOTE) === true,
				mode,
			});
			if (cliPath && cliPath !== DEFAULT_LARK_CLI) { syncArgs.push('--cli', cliPath); }

			// ⑤ 图表准备（★ 2026-09-24 补齐）：飞书**不渲染图表源码**、图片也**不支持 SVG**
			//   ⇒ 同步前不转换的话，飞书里只会看到一堆 ```mermaid 源码。此前该步骤只长在
			//   「知识库视图 → 同步飞书」按钮路径上，agent 走本工具时**不触发** ⇒ 这条路径同步过去是源码。
			//   · apply   ⇒ 真渲染：mermaid / drawio / canvas → PNG 并改写笔记引用；
			//   · dry-run ⇒ **只统计不写盘**：预览不应产生本地副作用（渲染会改写笔记正文），
			//                只如实告诉用户「apply 时会转换 N 张图」。
			//   与视图按钮共用同一份编排（knowledge/diagramSyncPrepare.ts）。
			let diagramNote = '';
			if (ctx.prepareDiagrams) {
				try {
					const p = await ctx.prepareDiagrams({ vaultRoot, srcDirs, dryRun: mode !== 'apply' });
					const extras: string[] = [];
					if (p.inlined) { extras.push(`${p.inlined} 个 mermaid 内联为围栏（飞书转画板活图）`); }
					if (p.attachments) { extras.push(`${p.attachments} 个 HTML 附件（飞书 file block + Preview 渲染）`); }
					if (p.charts || extras.length) {
						const tail = extras.length ? `；另：${extras.join('，')}` : '';
						diagramNote = p.dryRun
							? `图表/附件：${p.notes.length} 篇笔记含 ${p.charts} 张待转 PNG 图表${tail} —— apply 时自动处理。`
							: `图表：${p.charts} 张已渲染为 PNG${p.failures ? `，${p.failures} 张失败（已保留源码）` : ''}${tail}，改动 ${p.touched} 篇笔记。`;
					}
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					diagramNote = `图表准备失败（不影响同步）：${reason}`;
					log.warn(`[kb_feishu_sync] diagram preparation failed (non-fatal): ${reason}`);
				}
			}

			// ⑥ 执行（无头；Electron-as-node 需要 ELECTRON_RUN_AS_NODE=1，通道固定 env ⇒ 用 shell 前缀）
			const launch = electronNodeLaunch();
			const quoted = syncArgs.map(a => `"${a}"`).join(' ');
			const cmd = launch.executable
				? (isWindows
					? `set "ELECTRON_RUN_AS_NODE=1" && "${launch.executable}" ${quoted}`
					: `ELECTRON_RUN_AS_NODE=1 "${launch.executable}" ${quoted}`)
				: `node ${quoted}`;
			log.info(`[kb_feishu_sync] mode=${mode} src=${srcDirs.join(',')} cmdLen=${cmd.length}`);
			const r = await execShortCommand(cmd, SYNC_TIMEOUT_MS);
			if (!r) {
				return text('当前环境没有命令执行通道（非桌面版）⇒ 无法跑同步。请在「知识库」视图用「同步飞书」按钮手动执行。');
			}

			// ⑦ 结果回传走 **日志文件**（UTF-8，避开主进程按 GBK 解码 stdout 的乱码问题）
			let tail = '';
			try {
				const raw = (await ctx.fileService.readFile(URI.joinPath(vaultRoot, FEISHU_SYNC_LOG_FILE))).value.toString();
				tail = raw.length > LOG_TAIL ? `…（前面省略 ${raw.length - LOG_TAIL} 字符）\n` + raw.slice(-LOG_TAIL) : raw;
			} catch { tail = (r.stdout || r.stderr || '').slice(-LOG_TAIL); }

			const ok = r.ok && r.exitCode === 0;
			return {
				content: text([
					`飞书同步${mode === 'apply' ? '' : '预览'}${ok ? '完成' : '**失败**'}（exit ${r.exitCode}；范围：${srcDirs.join('、')}）`,
					diagramNote,
					ok ? '' : `stderr 尾部：${(r.stderr || '').slice(-1200) || '(空)'}`,
					'', '── 日志尾部 ──', tail.trim() || '(空)',
				].filter(Boolean).join('\n')),
				details: { ok, exitCode: r.exitCode, mode, srcDirs, diagramNote },
			};
		},
	});
}
