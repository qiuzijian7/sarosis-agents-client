/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `process` 工具 —— 后台任务管理面（2026-09-24，P1-5）。
 *
 * ## 它管什么、不管什么
 *
 * **只管"已经在跑的"**：list（谁在跑/各是什么/跑了多久）、output（看输出尾部）、
 * terminate（终止）、wait（**限时**等一个结果）。**启动**后台任务不归它 ——
 * 那是 `execute_code({ background: true })` 的事（spawn 后立刻回 taskId，不占住轮次）。
 *
 * ## 为什么需要这个工具（此前缺的是什么）
 *
 * 后台执行与完成通知一直都在（`execute_code` 的 `background`/`action:poll|kill` +
 * `execBackgroundNotify` 的完成推送）。缺的是**管理面**：模型启动几个后台任务后，
 * 手里只有一串 taskId UUID —— 一旦上下文里没留住，就**永远失联**（不知道哪个是构建、
 * 哪个是服务、哪个还在跑）。`action:"list"` 补的正是这件事。
 *
 * ## 实现形态（刻意薄）
 *
 * 主进程 `vscode:execCode` 通道已有 poll/kill 与任务注册表（`_bgExecs`）⇒ 本工具只做：
 *   · 新增 `action:'list'`（主进程顺带回收已落定超 30 分钟的条目，见 `app.ts` 的
 *     `BG_EXEC_SETTLED_RETAIN_MS` —— 此前注册表只进不出）；
 *   · `wait` 是**渲染侧限时轮询**（封顶 {@link WAIT_MAX_S}s），不是主进程阻塞 ——
 *     长任务不该靠 wait 等：完成时通知会自动送达（见 `execBackgroundNotify.ts`），
 *     wait 只为"我就差这几秒"的收尾场景。
 *   真实主进程 handler 与 poll/kill 语义在 `src/vs/code/electron-main/app.ts`。
 *
 * ## 与既有兼容占位的交接
 *
 * `compatibilityTools.ts` 此前把 `process` 注册成**只回提示**的占位（"不支持，改用
 * execute_code background"）—— 现在它是真的了，占位已移除。
 * ⚠ 本工具必须在 `_registerBundledTools` **之前**注册（bundled 里有同名 stub 定义）。
 */

import { ToolSecurityLevel } from '../../../common/providers.js';
import type { IToolResultContent } from '../../../common/providers.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IBuiltinToolRegistration } from './toolRegistry.js';

/** 主进程 `list` 返回的单条任务。 */
export interface IProcessTaskInfo {
	readonly taskId: string;
	readonly pid: number;
	readonly done: boolean;
	readonly exitCode: number;
	readonly command: string;
	readonly cwd?: string;
	readonly startedAt?: number;
	readonly settledAt?: number;
}

export interface IProcessToolContext {
	register(registration: IBuiltinToolRegistration): void;
	logService: ILogService;
	/** 主进程调用（真实实现 = `vscode.ipcRenderer.invoke`；注入以便单测）。 */
	invoke?: (channel: string, payload: unknown) => Promise<unknown>;
	/** 时钟 / 睡眠（`wait` 轮询用；测试注入）。 */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

/** `wait` 的默认等待秒数。 */
export const WAIT_DEFAULT_S = 60;
/**
 * `wait` 的硬上限（秒）。
 *
 * 为什么封顶：`wait` 占住当前轮。真机事故（日志 1789813310143）里 agent 用前景 sleep
 * 轮询长任务，一个轮次白等 30 分钟 —— wait 只是"差几秒就收尾"的便捷，长任务应该靠
 * 完成通知（`execBackgroundNotify`）而不是干等。
 */
export const WAIT_MAX_S = 120;
/** `wait` 轮询间隔（ms）。 */
export const WAIT_POLL_MS = 1000;
/** `output` 默认只回尾部多少字符（stdout 与 stderr 各自）。 */
export const OUTPUT_TAIL_CHARS = 4000;

// ─── 纯函数（可单测）────────────────────────────────────────────────────────

/** 取尾部（超长时带一句"只显示尾部"的明确标注 —— 不静默截断）。 */
export function tailWithMarker(text: string, maxChars: number): string {
	const s = text ?? '';
	if (s.length <= maxChars) { return s; }
	return `[… 输出共 ${s.length} 字符，仅显示最后 ${maxChars} 字符]\n${s.slice(-maxChars)}`;
}

/** 运行时长 → `3s` / `2m05s` / `1h03m`。 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) { return '?'; }
	const s = Math.floor(ms / 1000);
	if (s < 60) { return `${s}s`; }
	const m = Math.floor(s / 60);
	if (m < 60) { return `${m}m${String(s % 60).padStart(2, '0')}s`; }
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** 单行命令摘要（换行折叠 + 截断；列表/详情共用，免得两处各截一份）。 */
export function commandPreview(command: string, maxChars = 100): string {
	const one = (command ?? '').replace(/\s+/g, ' ').trim();
	return one.length > maxChars ? `${one.slice(0, maxChars)}…` : one;
}

/**
 * 任务清单 → 紧凑文本。运行中的排前面，其余按启动时间倒序（最近在跑的在上）。
 */
export function formatTaskList(tasks: readonly IProcessTaskInfo[], now: number): string {
	if (!tasks.length) {
		return '（当前没有后台任务）\n启动方法：execute_code({ command: "…", background: true }) ⇒ 返回 taskId。';
	}
	const sorted = [...tasks].sort((a, b) =>
		Number(a.done) - Number(b.done) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
	const lines = sorted.map(t => {
		const dur = formatDuration((t.done ? (t.settledAt ?? now) : now) - (t.startedAt ?? now));
		const state = t.done ? `已完成 exit=${t.exitCode}` : '运行中';
		return `· ${t.taskId}  pid=${t.pid}  ${state}  ${dur}  —  ${commandPreview(t.command)}`;
	});
	return `后台任务 ${tasks.length} 个（taskId 供 output / wait / terminate 用）：\n${lines.join('\n')}`;
}

/** 从参数里取任务 id（兼容 `pid` / `task_id` / `taskId` —— 模型沿用哪个名字都说不好）。 */
export function pickTaskId(args: Record<string, unknown>): string {
	for (const k of ['task_id', 'taskId', 'pid', 'id']) {
		const v = args[k];
		if (typeof v === 'string' && v.trim()) { return v.trim(); }
		if (typeof v === 'number' && Number.isFinite(v)) { return String(v); }
	}
	return '';
}

/** 主进程 `list` 返回 → 任务数组（容错：不是数组/缺字段时尽量给结构，解析不出就给空）。 */
export function parseTaskList(raw: unknown): IProcessTaskInfo[] {
	const tasks = (raw as { tasks?: unknown } | undefined)?.tasks;
	if (!Array.isArray(tasks)) { return []; }
	return tasks
		.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
		.map(t => ({
			taskId: String(t['taskId'] ?? ''),
			pid: typeof t['pid'] === 'number' ? t['pid'] : -1,
			done: t['done'] === true,
			exitCode: typeof t['exitCode'] === 'number' ? t['exitCode'] : -1,
			command: String(t['command'] ?? ''),
			cwd: typeof t['cwd'] === 'string' ? t['cwd'] : undefined,
			startedAt: typeof t['startedAt'] === 'number' ? t['startedAt'] : undefined,
			settledAt: typeof t['settledAt'] === 'number' ? t['settledAt'] : undefined,
		}))
		.filter(t => !!t.taskId);
}

/** poll 返回 → 「状态行 + 输出尾部」。stderr 与 stdout 分开给（混在一起时错误会被输出淹掉）。 */
export function renderTaskOutput(
	taskId: string,
	poll: { done?: boolean; killed?: boolean; exitCode?: number; stdout?: string; stderr?: string },
	tailChars: number,
): string {
	const state = poll.killed ? `已被终止 exit=${poll.exitCode ?? -1}`
		: poll.done ? `已完成 exit=${poll.exitCode ?? -1}`
			: '运行中';
	const out = poll.stdout ?? '';
	const err = poll.stderr ?? '';
	const parts = [`任务 ${taskId} — ${state}`];
	if (out) { parts.push(`stdout（尾部）：\n${tailWithMarker(out.trimEnd(), tailChars)}`); }
	if (err) { parts.push(`stderr（尾部）：\n${tailWithMarker(err.trimEnd(), tailChars)}`); }
	if (!out && !err) { parts.push('（还没有任何输出）'); }
	return parts.join('\n');
}

// ─── 注册 ───────────────────────────────────────────────────────────────────

export function registerProcessTools(ctx: IProcessToolContext): void {
	const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];
	const now = ctx.now ?? (() => Date.now());
	const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

	const invoke = async (payload: unknown): Promise<Record<string, unknown> | undefined> => {
		const run = ctx.invoke
			?? (globalThis as { vscode?: { ipcRenderer?: { invoke: (c: string, p: unknown) => Promise<unknown> } } })
				.vscode?.ipcRenderer?.invoke?.bind(
					(globalThis as { vscode?: { ipcRenderer?: { invoke: (c: string, p: unknown) => Promise<unknown> } } }).vscode?.ipcRenderer,
				);
		if (!run) { return undefined; }
		try {
			const r = await run('vscode:execCode', payload);
			return (r && typeof r === 'object') ? r as Record<string, unknown> : undefined;
		} catch (err) {
			ctx.logService.warn(`[process] execCode 调用失败（action=${(payload as { action?: unknown })?.action}）：${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	};

	const NO_CHANNEL = 'process 工具需要主进程通道（VsSaros 桌面版）；当前环境不可用。\n'
		+ '启动/管理后台任务仍然可用：execute_code({ command, background: true }) ⇒ taskId，'
		+ '再用 execute_code({ action:"poll"|"kill", taskId })。';

	ctx.register({
		definition: {
			name: 'process',
			description: '管理后台任务：list（谁在跑/是什么/跑了多久）、output（看输出尾部）、'
				+ 'wait（限时等一个结果，≤120s）、terminate（终止）。'
				+ '⚠ **启动**后台任务不归它管 —— 用 execute_code({ command, background: true })（立刻回 taskId，不占住轮次）；'
				+ '长任务也别久等：完成时会有自动通知送达。适合「我刚才启动的那些任务怎么样了 / 那个构建好了没」。',
			inputSchema: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['list', 'output', 'terminate', 'wait'], description: '动作' },
					pid: { type: 'string', description: '任务 id（execute_code background 返回的 taskId；output/terminate/wait 必填）' },
					tail_chars: { type: 'number', description: `output 只回尾部多少字符（默认 ${OUTPUT_TAIL_CHARS}，stdout/stderr 各自）` },
					timeout: { type: 'number', description: `wait 的等待秒数（默认 ${WAIT_DEFAULT_S}，上限 ${WAIT_MAX_S}）` },
				},
				required: ['action'],
			},
			category: 'terminal',
			source: 'saros.builtin-tools',
			// terminate 会杀掉别人正在跑的后台任务（动作级差异无法按 action 分级 ⇒ 整工具取谨慎档）。
			// 被终止的对象只可能是**本会话 agent 自己启动**的后台任务 ⇒ Cautious（首用提示），不到 Dangerous。
			securityLevel: ToolSecurityLevel.Cautious,
		},
		handler: async (args) => {
			const action = String(args['action'] ?? '').trim().toLowerCase();
			const taskId = pickTaskId(args);

			if (action === 'list') {
				const r = await invoke({ action: 'list' });
				if (!r) { return text(NO_CHANNEL); }
				if (r['success'] !== true) {
					return text(`列出后台任务失败：${String(r['stderr'] ?? '未知错误')}`);
				}
				return text(formatTaskList(parseTaskList(r), now()));
			}

			if (action === 'output') {
				if (!taskId) { return text('process(output) 需要 pid（execute_code background 返回的 taskId）。先用 action:"list" 看看有哪些。'); }
				const r = await invoke({ action: 'poll', taskId });
				if (!r) { return text(NO_CHANNEL); }
				// 未知任务：主进程 stderr 给了 "unknown exec task: ..." ⇒ 原样带出（模型据此知道 id 写错/任务已被回收）
				if (r['success'] !== true && r['done'] !== true) {
					return text(`读取任务 ${taskId} 失败：${String(r['stderr'] ?? '未知错误')}\n提示：先 action:"list" 看现有任务（已落定超过 30 分钟的会被回收）。`);
				}
				const tailChars = Math.max(200, Math.min(Number(args['tail_chars']) || OUTPUT_TAIL_CHARS, 40_000));
				return text(renderTaskOutput(taskId, {
					done: r['done'] === true, killed: r['killed'] === true,
					exitCode: typeof r['exitCode'] === 'number' ? r['exitCode'] : undefined,
					stdout: typeof r['stdout'] === 'string' ? r['stdout'] : '',
					stderr: typeof r['stderr'] === 'string' ? r['stderr'] : '',
				}, tailChars));
			}

			if (action === 'terminate') {
				if (!taskId) { return text('process(terminate) 需要 pid（要终止的任务的 taskId）。'); }
				const r = await invoke({ action: 'kill', taskId });
				if (!r) { return text(NO_CHANNEL); }
				// ★ 判据是 done:true（不是 killed）—— 主进程 2026-09-19 的事故修复明确：
				//   kill 成功必须回 done:true，否则渲染侧会误报「still running」把 agent 带偏。
				if (r['done'] === true) {
					return text(`已终止任务 ${taskId}（exit=${typeof r['exitCode'] === 'number' ? r['exitCode'] : -1}）。`);
				}
				return text(`终止任务 ${taskId} 未确认：${String(r['stderr'] ?? '未知错误')}。可再 action:"output" 看一眼它是否还在跑。`);
			}

			if (action === 'wait') {
				if (!taskId) { return text('process(wait) 需要 pid（要等待的任务的 taskId）。'); }
				const reqS = Number(args['timeout']);
				const waitS = Number.isFinite(reqS) && reqS > 0 ? Math.min(reqS, WAIT_MAX_S) : WAIT_DEFAULT_S;
				const deadline = now() + waitS * 1000;
				// 限时轮询：到点**如实说"还在跑"**，不要假装等到（长任务靠完成通知，不靠干等）
				for (;;) {
					const r = await invoke({ action: 'poll', taskId });
					if (!r) { return text(NO_CHANNEL); }
					if (r['done'] === true || r['killed'] === true) {
						return text(renderTaskOutput(taskId, {
							done: r['done'] === true, killed: r['killed'] === true,
							exitCode: typeof r['exitCode'] === 'number' ? r['exitCode'] : undefined,
							stdout: typeof r['stdout'] === 'string' ? r['stdout'] : '',
							stderr: typeof r['stderr'] === 'string' ? r['stderr'] : '',
						}, OUTPUT_TAIL_CHARS));
					}
					if (now() >= deadline) {
						return text(`等了 ${waitS}s，任务 ${taskId} 仍在运行。`
							+ `不必继续干等：完成时会有自动通知；想看进度用 action:"output"，要停掉用 action:"terminate"。`);
					}
					await sleep(WAIT_POLL_MS);
				}
			}

			return text(`process 需要 action ∈ list / output / terminate / wait（收到 "${action || '(空)'}"）。`);
		},
	});

	ctx.logService.info('[ProcessTools] Registered process (list/output/terminate/wait)');
}
