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
import { CAP_FEISHU_LARK_CLI } from './toolAvailabilityNotes.js';
import type { IToolResultContent } from '../../../common/providers.js';
import type { IBuiltinToolRegistration } from './toolRegistry.js';
import {
	AGENT_STUDIO_KB_FEISHU_SYNC_ENABLED,
	AGENT_STUDIO_KB_FEISHU_CLI_PATH,
	AGENT_STUDIO_KB_FEISHU_SYNC_PARENT,
	AGENT_STUDIO_KB_FEISHU_SYNC_ON_CONFLICT,
	AGENT_STUDIO_KB_FEISHU_SYNC_INTERVAL,
	AGENT_STUDIO_KB_FEISHU_CATEGORY_DEPTH,
	AGENT_STUDIO_KB_FEISHU_PRUNE_REMOTE,
} from '../../../common/constants.js';
import {
	buildSyncArgs, detectLarkCli, resolveSyncScript, electronNodeLaunch,
	DEFAULT_LARK_CLI, LARK_CLI_MISSING_HINT, KB_FEISHU_SYNC_SCRIPT_REL, FEISHU_SYNC_LOG_FILE,
	execShortCommand, parseSpaceMap, deriveMappedSrcDirs, FEISHU_SPACE_MAP_FILE, FEISHU_SYNC_PLAN_FILE,
	listWikiSpaces, createWikiSpace, sanitizeSpaceName,
	type IKbSpaceMapping,
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

/**
 * 读取 vault 内的「目录 ↔ 飞书知识库」映射（`.feishu-space-map.json`；缺失/损坏 ⇒ 空数组）。
 *
 * 与内置脚本、设置面板共用同一份契约（`parseSpaceMap`）—— 本工具的**默认同步范围**由它推导，
 * 保证「agent 同步」与「📤 立即同步到飞书」按钮口径一致（★ 2026-09-24 用户定调）。
 */
async function readVaultSpaceMap(ctx: KbFeishuSyncToolContext, vaultRoot: URI): Promise<IKbSpaceMapping[]> {
	try {
		const text = (await ctx.fileService.readFile(URI.joinPath(vaultRoot, FEISHU_SPACE_MAP_FILE))).value.toString();
		return parseSpaceMap(text);
	} catch {
		return [];
	}
}

export function registerKbFeishuSyncTools(ctx: KbFeishuSyncToolContext): void {
	const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

	ctx.register({
		definition: {
			name: 'kb_feishu_sync',
			description: [
				'把知识库「笔记」同步到飞书知识库（内置脚本 + lark-cli）。',
				'`mode: "dry-run"`（默认）只出计划不写远端 —— **先 dry-run 给用户看计划，确认后再 apply**。',
				'增量：按每篇 frontmatter 的 feishu.hash/remoteHash 判定，重复同步不会重复创建。',
				'**同步范围只由「目录映射」决定**（`知识库设置 → 飞书同步 → 目录映射`）：只有「笔记」区里已关联到飞书知识库的目录才会被同步，未关联的目录不同步、也不会自动建库。',
				'目标与凭证取自「知识库设置 → 飞书同步」；本工具只覆盖：mode / prune（**范围不可用参数扩大**）。',
				'返回的「本次报告」就是脚本写的计划/结果逐篇清单（dry-run 也有）——**照它向用户汇报**，别只说 exit 0。',
				'要把某个目录纳入同步 ⇒ 先用 `kb_feishu_spaces` 确认/新建飞书知识库，再写 `.feishu-space-map.json` 映射（见技能 kb-category-feishu）。',
				'图表：`apply` 前会自动把笔记里的 mermaid / drawio 代码块与 `![[x.canvas]]` 嵌入渲染成 PNG 并改写引用'
				+ '（飞书不渲染图表源码、图片也不支持 SVG）；`dry-run` 只统计、不改文件。',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					mode: { type: 'string', enum: ['dry-run', 'apply'], description: '默认 dry-run（只打印计划）' },
					prune: { type: 'boolean', description: '本地已删除的文档是否同时移除远端节点（默认 false）' },
				},
				required: [],
			},
			category: 'other',
			// ★ 2026-09-24（P1-4）：同步脚本内部调 `lark-cli`（见 feishuSyncCore.DEFAULT_LARK_CLI）
			//   ⇒ 缺 CLI 时标注"当前不可用 + 安装命令"，而不是等用户点了才报错（不隐藏，理由见
			//   toolAvailabilityNotes.ts 头注释）。
			availability: [{ type: 'custom', condition: CAP_FEISHU_LARK_CLI }],
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

			// ★ 2026-09-24：范围参数已移除 ⇒ 显式拒绝（否则模型以为"传了但没生效"，会反复重试/换写法）
			if (args['srcDirs'] !== undefined) {
				return text('`srcDirs` 参数已移除：同步范围固定为「笔记」区里**已配置映射**的目录。要把某个目录纳入同步 ⇒ 先到「知识库设置 → 飞书同步 → 目录映射」加一条映射（可先用 `kb_feishu_spaces` 确认目标知识库），再重试。');
			}

			// ③ 内置脚本
			const script = await resolveSyncScript(ctx.fileService, ctx.environmentService);
			if (!script) {
				return text(`未找到内置同步脚本（${KB_FEISHU_SYNC_SCRIPT_REL}）——安装可能不完整，请重新安装应用。`);
			}

			// ④ 参数（与「📤 立即同步到飞书」按钮同一份口径，不另搞一套）
			const vaultRoot = resolveKbRootUri(ctx.storageService, ctx.environmentService);
			const mode: 'dry-run' | 'apply' = args['mode'] === 'apply' ? 'apply' : 'dry-run';
			// ★★ 2026-09-24：范围**只由「目录映射」决定** —— 为此**删掉了 `srcDirs` 参数**。
			//   实测事故：用户只要求「关联 游戏设计 文件夹」，agent 却在 apply 时传 `srcDirs=笔记/01_学习`
			//   （比 dry-run 确认的 `笔记/01_学习/游戏设计` 大一层）⇒ 兄弟目录（AI_Agent/UnrealEngine/财经）
			//   一并被同步。参数可绕过「只同步已映射目录」的安全口径 ⇒ 直接移除。
			const srcDirs = deriveMappedSrcDirs(await readVaultSpaceMap(ctx, vaultRoot));
			if (srcDirs.length === 0) {
				return text('尚未把「笔记」里的任何目录关联到飞书知识库，无法同步：请引导用户到「知识库设置 → 飞书同步 → 目录映射」添加一条映射（把某个「笔记」子目录关联到目标飞书知识库），再重试。');
			}
			const rawInterval = ctx.configurationService.getValue<number>(AGENT_STUDIO_KB_FEISHU_SYNC_INTERVAL);
			const rawDepth = ctx.configurationService.getValue<number>(AGENT_STUDIO_KB_FEISHU_CATEGORY_DEPTH);
			// 本次报告文件：**先删旧的**（否则可能把上一次的报告当成本次结果），脚本跑完写新的。
			const planFileUri = URI.joinPath(vaultRoot, FEISHU_SYNC_PLAN_FILE);
			try {
				await ctx.fileService.del(planFileUri, { recursive: false });
			} catch { /* 不存在本就是期望状态 */ }
			const syncArgs = buildSyncArgs(script.fsPath, {
				vaultPath: vaultRoot.fsPath,
				srcDirs,
				parent: (ctx.configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_SYNC_PARENT) || 'my_library').trim(),
				onConflict: ctx.configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_SYNC_ON_CONFLICT) === 'skip' ? 'skip' : 'overwrite',
				intervalMs: Number.isFinite(rawInterval) && (rawInterval as number) >= 0 ? (rawInterval as number) : 800,
				categoryDepth: Number.isFinite(rawDepth) && (rawDepth as number) >= 0 ? (rawDepth as number) : 1,
				// ★ 2026-09-24（与视图按钮同一口径）：范围全是已映射目录 ⇒ 落点由映射决定；
				//   显式关掉自动建库 = 「不会自动创建知识库」的结构保证（未映射类别会被跳过）。
				autoCreateSpaces: false,
				prune: args['prune'] === true || ctx.configurationService.getValue<boolean>(AGENT_STUDIO_KB_FEISHU_PRUNE_REMOTE) === true,
				planFile: planFileUri.fsPath,
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

			// ⑦ 结果回传：读脚本写的**本次报告**（UTF-8；dry-run 也有内容）。
			//
			// ★★ 2026-09-24 修正：此前读 `.feishu-sync.log` 尾部 —— 但**dry-run 从不写日志**
			//   （脚本末尾 `if (!args.dryRun) …`）⇒ 预览永远返回旧内容（实测：dry-run 与 apply 拿到
			//   的都是 2026-09-23 的日志尾部，agent 无从判断「将创建/更新几篇」「实际同步了什么」）。
			//   现在脚本用 `--plan-file` 写本次报告 ⇒ 这里读它；报告缺失（脚本异常）才退回日志尾部。
			let reportText = '';
			try {
				reportText = (await ctx.fileService.readFile(planFileUri)).value.toString();
			} catch { reportText = ''; }
			if (!reportText.trim()) {
				let fallback = '';
				try {
					const raw = (await ctx.fileService.readFile(URI.joinPath(vaultRoot, FEISHU_SYNC_LOG_FILE))).value.toString();
					fallback = raw.length > LOG_TAIL ? `…（前面省略 ${raw.length - LOG_TAIL} 字符）\n` + raw.slice(-LOG_TAIL) : raw;
				} catch { fallback = (r.stdout || r.stderr || '').slice(-LOG_TAIL); }
				reportText = `（脚本未产出报告文件 —— 可能是异常退出；以下为 .feishu-sync.log 尾部，可能含历史内容）\n${fallback}`;
			}

			const ok = r.ok && r.exitCode === 0;
			return {
				content: text([
					`飞书同步${mode === 'apply' ? '' : '预览'}${ok ? '完成' : '**失败**'}（exit ${r.exitCode}；范围：${srcDirs.join('、')}）`,
					diagramNote,
					ok ? '' : `stderr 尾部：${(r.stderr || '').slice(-1200) || '(空)'}`,
					'', '── 本次报告 ──', reportText.trim().slice(-8000) || '(空)',
				].filter(Boolean).join('\n')),
				details: { ok, exitCode: r.exitCode, mode, srcDirs, diagramNote },
			};
		},
	});

	/**
	 * `kb_feishu_spaces`（★ 2026-09-24 新增）：列出 / 新建飞书知识库。
	 *
	 * 为什么需要它：用户的需求形态是「把某个笔记目录关联到飞书知识库，**没有则新建**」。
	 * 此前 agent 只能靠 `.feishu-space-map.json`（**本地映射**）判断"远端没有" —— 判据错位，
	 * 且建库只能 shell out 直调 `lark-cli wiki +space-create`（实测日志：agent 用 `execute_code`
	 * 调 CLI 建库，绕过了产品侧的 `sanitizeSpaceName` 与去重检查）。
	 * 现在给它一条正路：`list` 查远端真实列表、`create` 走同一份封装（含名称净化 + **同名复用**）。
	 */
	ctx.register({
		definition: {
			name: 'kb_feishu_spaces',
			description: [
				'列出 / 新建飞书知识库（wiki space）——「把某个笔记目录关联到飞书知识库」的前置步骤。',
				'**先 `action: "list"`**（绝不要用本地 `.feishu-space-map.json` 判断远端是否存在同名库），确认没有再 `action: "create"`。',
				'拿到 `spaceId` 后写进 `<vault>/.feishu-space-map.json` 的 `mappings`（`dir` 为「笔记」区相对目录），关联即完成；随后 `kb_feishu_sync` 才会同步该目录。',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['list', 'create'], description: 'list（默认）= 列出全部知识库；create = 新建' },
					name: { type: 'string', description: 'create 时的知识库名称（会净化引号/换行）' },
				},
				required: [],
			},
			category: 'other',
			// ★ 2026-09-24（P1-4）：同步脚本内部调 `lark-cli`（见 feishuSyncCore.DEFAULT_LARK_CLI）
			//   ⇒ 缺 CLI 时标注"当前不可用 + 安装命令"，而不是等用户点了才报错（不隐藏，理由见
			//   toolAvailabilityNotes.ts 头注释）。
			availability: [{ type: 'custom', condition: CAP_FEISHU_LARK_CLI }],
			source: 'builtin',
			securityLevel: ToolSecurityLevel.Dangerous,
		},
		handler: async (args) => {
			const action = args['action'] === 'create' ? 'create' : 'list';
			const cliPath = (ctx.configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_CLI_PATH) || DEFAULT_LARK_CLI).trim();
			const cli = await detectLarkCli(cliPath);
			if (cli.state === 'missing') { return text(LARK_CLI_MISSING_HINT); }

			if (action === 'list') {
				const spaces = await listWikiSpaces(cliPath);
				if (!spaces.length) {
					return text('未取到飞书知识库列表：确认 lark-cli 已登录（也可在「知识库设置 → 飞书同步 → 目录映射 → 🔄 刷新知识库列表」重试）。');
				}
				return text(['飞书知识库列表（远端实时）：', ...spaces.map(s => `- ${s.name}（spaceId: ${s.spaceId}）`)].join('\n'));
			}

			const name = sanitizeSpaceName(typeof args['name'] === 'string' ? args['name'] : '');
			if (!name) { return text('缺少知识库名称（`name`）—— 名称不能为空，也不能只由引号/换行组成。'); }

			// ★ 先查重（远端真实列表）：同名（忽略大小写与首尾空白）已存在 ⇒ 直接复用，绝不重复建库。
			const spaces = await listWikiSpaces(cliPath);
			const dup = spaces.find(s => s.name.trim().toLowerCase() === name.toLowerCase());
			if (dup) {
				return text([
					`飞书侧**已存在**同名知识库「${dup.name}」（spaceId: ${dup.spaceId}）⇒ 不要重复创建。`,
					`下一步：把 \`${dup.spaceId}\` 写进 \`${FEISHU_SPACE_MAP_FILE}\` 里该目录的映射（\`dir\` = 「笔记」区相对目录），再跑 \`kb_feishu_sync\`。`,
				].join('\n'));
			}

			const created = await createWikiSpace(name, cliPath);
			if (!created) {
				return text(`新建飞书知识库「${name}」失败：检查 lark-cli 登录态与网络，稍后重试（未创建任何东西）。`);
			}
			return text([
				`已创建飞书知识库「${created.name}」（spaceId: ${created.spaceId}）。`,
				`下一步：把该 spaceId 写进 \`${FEISHU_SPACE_MAP_FILE}\` 的映射（目录 → spaceId），再跑 \`kb_feishu_sync\`。`,
				'⚠ 注意：**只有映射目录里的内容会被同步**；空目录不会产生任何文档（可先放一篇索引笔记）。',
			].join('\n'));
		},
	});
}
