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
