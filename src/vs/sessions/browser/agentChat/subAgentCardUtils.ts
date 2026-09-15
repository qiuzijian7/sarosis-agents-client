/*---------------------------------------------------------------------------------------------
 *  subAgentCardUtils.ts
 *
 *  子代理卡片渲染相关的纯函数工具集。
 *  与 agentChatPanel.toolCards.ts 分离，避免引入浏览器端依赖（window / dom），
 *  使这些函数可被 Node.js 单测环境直接 import。
 *--------------------------------------------------------------------------------------------*/

import type { ISubAgentData } from './agentChatTypes.js';

/**
 * 将 subagent 的完整 id 缩短为最后一段随机后缀。
 * 例：`subagent-1784816784503-r8slpypyu` → `r8slpypyu`。
 */
export function formatSubAgentId(id: string): string {
	if (!id) { return ''; }
	const parts = id.split('-');
	return parts.length > 1 ? parts[parts.length - 1] : id;
}

/**
 * 提取 subagent task 的可读文本。
 *
 * 模型有时把 task 传成对象（如 `{focus: "Search ..."}`），`normalizeTaskArg` 在
 * dispatch 边界会把它 JSON 化为字符串。这里反向解析，展示场景优先取 `title`
 * （任务概述）→ `description` → `focus`（常为文件路径/范围，概述性弱）→
 * `content`/`task`；非 JSON 或解析失败时截断原文本。
 */
export function formatSubAgentTask(task: string | undefined, typeLabel: string): string {
	const fallback = `SubAgent (${typeLabel})`;
	if (!task) { return fallback; }
	let cleaned = task;
	if (task.startsWith('{') && task.endsWith('}')) {
		try {
			const obj = JSON.parse(task);
			cleaned = obj.title || obj.description || obj.focus || obj.content || obj.task || task;
		} catch { /* not JSON — keep raw */ }
	}
	if (cleaned.length > 200) {
		cleaned = cleaned.slice(0, 200) + '…';
	}
	return cleaned;
}

/**
 * 从消息级 subAgents 中按 parentToolCallId 筛选子代理列表。
 */
export function filterChildSubAgents(subAgents: ISubAgentData[] | undefined, parentToolCallId: string): ISubAgentData[] {
	if (!subAgents || !parentToolCallId) { return []; }
	return subAgents.filter(sa => sa.parentToolCallId === parentToolCallId);
}

/**
 * 统计子代理列表中各状态的数量。
 */
export function countSubAgentStatuses(subAgents: ISubAgentData[]): { done: number; running: number; error: number } {
	let done = 0, running = 0, error = 0;
	for (const sa of subAgents) {
		if (sa.status === 'done') { done++; }
		else if (sa.status === 'running') { running++; }
		else if (sa.status === 'error' || sa.status === 'cancelled') { error++; }
	}
	return { done, running, error };
}

/**
 * 清洗 trace 预览文本：工具的 args/result 常是 JSON（含 [{"type":"text","text":…}]
 * 协议包装、数组、嵌套对象），直接展示会把包装结构泄露给用户（如
 * `搜索内容[{"type":"text","text":"(no matching files)"}]`、`"0": "[object]"`）。
 * 解析后提取可读内容，折叠为单行并截断。
 */
export function cleanTracePreview(raw: string, maxLen: number): string {
	let s = raw.trim();
	// 2026-07-27：有限递归（≤2 层）——协议包装 [{"type":"text","text":"<JSON>"}]
	// 解包后内层往往仍是 JSON（如 search_code 的 {"results":[...]}），需再清洗
	// 一轮才能提取文件路径摘要，否则显示原始 JSON 文本（"results=[object]" 同类）。
	for (let depth = 0; depth < 2; depth++) {
		if (!(s.length > 1 && (s.startsWith('[') || s.startsWith('{')))) { break; }
		try {
			s = stringifyTraceValue(JSON.parse(s));
		} catch { break; /* 非 JSON，原样展示 */ }
	}
	s = s.replace(/\s+/g, ' ').trim();
	return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

/** 行内（单行）trace 摘要的字符预算——与 hover tip 的完整内容区分。 */
export const TRACE_ROW_SINGLE_LINE_MAX = 120;

/**
 * 生成 trace 行的**单行**摘要（配合 CSS ellipsis 使用）。
 *
 * 与 hover tip 的分工：行内只给「一眼可辨」的短摘要，完整参数/结果放 tip。
 * 因此这里用一个远小于 tip 的预算，并且**不再追加省略号**——截断处由 CSS
 * `text-overflow: ellipsis` 视觉补全（若在此加 `…`，字符会与 UI 省略号叠加）。
 */
export function shortenTraceDetail(raw: string): string {
	return cleanTracePreview(raw, TRACE_ROW_SINGLE_LINE_MAX).replace(/…$/, '');
}

// ── 动态表情包三阶段（画布 Saros.AnimatedEmoji）─────────────────────────────
/**
 * 阶段链定义：与执行器 `run_scope`（video/matte/gif）及快照归档 port
 * （video/matte/output）**一一对应**。改阶段数/名称时只改这里 + 卡片渲染
 * （执行器文件头有同一份契约说明）。
 */
export const ANIMATED_EMOJI_STAGES: ReadonlyArray<{
	id: AnimatedEmojiStageId;
	num: string;
	label: string;
	port: string;
}> = [
	{ id: 'video', num: '①', label: '生成视频', port: 'video' },
	{ id: 'matte', num: '②', label: '视频抠像', port: 'matte' },
	{ id: 'gif', num: '③', label: 'GIF 输出', port: 'output' },
];

export type AnimatedEmojiStageId = 'video' | 'matte' | 'gif';

/** 该卡片是否属于动态表情包节点（类型优先，节点显示名兜底）。 */
export function isAnimatedEmojiCard(nodeType?: string, nodeName?: string): boolean {
	if (nodeType === 'Saros.AnimatedEmoji') { return true; }
	return /动态表情包/.test(nodeName ?? '');
}

/**
 * 从进度文案解析当前阶段。执行器发的是「阶段① 生成视频 · 格 3/9」这类 message
 * （见 animatedEmojiExecutor 的 onProgress）。返回 undefined = 非本节点的文案。
 */
export function parseAnimatedEmojiStage(message?: string): AnimatedEmojiStageId | undefined {
	if (!message) { return undefined; }
	if (message.includes('阶段①')) { return 'video'; }
	if (message.includes('阶段②')) { return 'matte'; }
	if (message.includes('阶段③')) { return 'gif'; }
	return undefined;
}

/** 动态表情包阶段卡状态。 */
export interface IAnimatedEmojiStageState {
	/** 正在跑的阶段（无匹配进度文案 → undefined）。 */
	current?: AnimatedEmojiStageId;
	/** 各阶段是否已有产物（由快照 port 推断）。 */
	done: Record<AnimatedEmojiStageId, boolean>;
	/** 各阶段产物条数。 */
	counts: Record<AnimatedEmojiStageId, number>;
}

/**
 * 由「快照条目（含 port）」+「进度文案」推断三阶段状态。
 *
 * ★ 判据只用 `port`（不看 ref/kind）——归档端口就是阶段契约：
 *   `video`=阶段① 产物、`matte`=阶段② 产物、`output`=阶段③ 产物。
 * 纯函数（可 Node 单测）。
 */
export function computeAnimatedEmojiStageState(
	snapshot: ReadonlyArray<{ port?: unknown }> | undefined,
	message?: string,
): IAnimatedEmojiStageState {
	const counts: Record<AnimatedEmojiStageId, number> = { video: 0, matte: 0, gif: 0 };
	for (const m of snapshot ?? []) {
		const port = typeof m?.port === 'string' ? m.port : '';
		if (port === 'video') { counts.video++; }
		else if (port === 'matte') { counts.matte++; }
		else if (port === 'output') { counts.gif++; }
	}
	return {
		current: parseAnimatedEmojiStage(message),
		done: { video: counts.video > 0, matte: counts.matte > 0, gif: counts.gif > 0 },
		counts,
	};
}

/** 把 JSON 值转成可读短文本（cleanTracePreview 的递归辅助）。 */
function stringifyTraceValue(v: unknown): string {
	// [{"type":"text","text":"…"}] 内容包装 → 拼接内层文本
	if (Array.isArray(v)) {
		if (v.length > 0 && v.every(e => e !== null && typeof e === 'object'
			&& (e as { type?: unknown }).type === 'text'
			&& typeof (e as { text?: unknown }).text === 'string')) {
			return v.map(e => (e as { text: string }).text).join(' ');
		}
		const head = v.slice(0, 3).map(e => stringifyTraceValue(e)).join(', ');
		return v.length > 3 ? `${head}, …(${v.length} 项)` : head;
	}
	if (v !== null && typeof v === 'object') {
		const obj = v as Record<string, unknown>;
		// 全数字键（结构化截断对数组的畸形产物 {"0": …}）→ 按数组处理，
		// 否则 UI 会把索引键显示成 "0=…"（2026-07-26 "搜索内容显示 0"）。
		const keys = Object.keys(obj);
		if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
			return stringifyTraceValue(keys.map(k => obj[k]));
		}
		// 单字段语义键直取
		for (const k of ['text', 'content', 'message', 'error']) {
			if (typeof obj[k] === 'string') { return obj[k] as string; }
		}
		// 2026-07-27（用户报告：搜索代码卡片显示 "results=[object]" 无法阅读）：
		// search_code 类结果的 results 数组是核心数据——提取文件路径摘要，
		// 而非折叠为 […]/[object]（折叠后信息量为零）。
		if (Array.isArray(obj['results'])) {
			const arr = obj['results'] as unknown[];
			const head = arr.slice(0, 3).map((r) => {
				if (r !== null && typeof r === 'object') {
					const rec = r as Record<string, unknown>;
					const fp = rec['filePath'] ?? rec['path'] ?? rec['name'];
					if (typeof fp === 'string') {
						return typeof rec['lineNo'] === 'number' ? `${fp}:${rec['lineNo']}` : fp;
					}
				}
				return stringifyTraceValue(r);
			}).join(', ');
			const total = typeof obj['total'] === 'number' ? obj['total'] : arr.length;
			return arr.length > 3 || total > arr.length ? `${head}, …(${total} 项)` : head;
		}
		// mode:"files" 结果 {files:[...]}：同理提取路径摘要
		if (Array.isArray(obj['files'])) {
			const arr = obj['files'] as unknown[];
			const head = arr.slice(0, 3).map((f) => typeof f === 'string' ? f : stringifyTraceValue(f)).join(', ');
			const total = typeof obj['total_files'] === 'number' ? obj['total_files'] : arr.length;
			return arr.length > 3 || total > arr.length ? `${head}, …(${total} 项)` : head;
		}
		// 对象 → key=value 紧凑拼接（嵌套结构折叠为 […]）
		const pairs = Object.entries(obj).slice(0, 4).map(([k, val]) => {
			const vs = typeof val === 'string' ? val
				: (val !== null && typeof val === 'object' ? '[…]' : String(val));
			return `${k}=${vs}`;
		});
		return pairs.join(' ');
	}
	return String(v);
}
