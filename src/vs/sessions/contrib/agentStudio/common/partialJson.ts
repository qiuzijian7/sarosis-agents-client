/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * partial JSON 字段提取器（2026-09-06，doc/tool-args-streaming-preview-design.md 阶段 2）。
 *
 * 用途：LLM 流式生成 tool_call arguments 期间（tool_progress.partialArgs = 累积串前 8KB），
 * 在参数尚未生成完时提取顶层标量字段供 UI 预览（如 file_write 的 path 提前显示）。
 *
 * ⚠ 设计红线：本模块仅供展示预览。执行/完成判定唯一来源是 tool_start——
 * 严禁把「可解析」用作任何执行或完成信号（Vercel AI SDK issue #12052 的
 * 「大参数中途恰好可解析 → 过早发射」教训）。
 *
 * 实现：单趟状态机确定截断点状态（字符串内/转义悬空/括号栈）→ 按栈补全闭合 →
 * JSON.parse → 提取顶层标量字段（string 截断至 MAX_FIELD_PREVIEW_CHARS）。
 * O(n) 全量重扫；n ≤ 8KB 且 1s 节流，无需增量游标。解析失败静默返回空，绝不抛错。
 */

const MAX_FIELD_PREVIEW_CHARS = 200;

export interface IPartialJsonFields {
	/** 顶层标量字段（string/number/boolean → string），值截断至 200 字符。嵌套 object/array 跳过。 */
	fields: Record<string, string>;
	/** 值被截断的字段名集合 */
	truncated: Set<string>;
	/** partialArgs 本就是完整合法 JSON（仅诊断参考，不得用作完成/执行判定） */
	complete: boolean;
}

function isHighSurrogate(ch: string): boolean {
	const c = ch.charCodeAt(0);
	return c >= 0xD800 && c <= 0xDBFF;
}

export function extractPartialFields(partial: string): IPartialJsonFields {
	const empty: IPartialJsonFields = { fields: {}, truncated: new Set(), complete: false };
	if (!partial || typeof partial !== 'string') { return empty; }
	const trimmed = partial.trimStart();
	if (!trimmed.startsWith('{')) { return empty; }

	// ── 单趟扫描：确定截断点状态 ──
	let inString = false;
	let escaped = false;
	const stack: string[] = [];
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (inString) {
			if (escaped) { escaped = false; continue; }
			if (ch === '\\') { escaped = true; continue; }
			if (ch === '"') { inString = false; }
			continue;
		}
		if (ch === '"') { inString = true; continue; }
		if (ch === '{') { stack.push('}'); continue; }
		if (ch === '[') { stack.push(']'); continue; }
		if (ch === '}' || ch === ']') { stack.pop(); continue; }
	}

	// ── 截断点修复 ──
	let repaired = trimmed;
	if (escaped) {
		repaired = repaired.slice(0, -1); // 悬空 '\' → 丢弃（其后的引号闭合由下一行处理）
	}
	// Unicode 代理对在截断处裂开 → 回退一个 code unit
	if (repaired.length && isHighSurrogate(repaired[repaired.length - 1])) {
		repaired = repaired.slice(0, -1);
	}
	if (inString) { repaired += '"'; }
	while (stack.length) { repaired += stack.pop(); }

	// ── 解析 + 提取 ──
	let parsed: Record<string, unknown>;
	try {
		const v = JSON.parse(repaired);
		if (!v || typeof v !== 'object' || Array.isArray(v)) { return empty; }
		parsed = v as Record<string, unknown>;
	} catch {
		return empty; // 预览容错：解析失败静默返回空，绝不抛错
	}

	const fields: Record<string, string> = {};
	const truncated = new Set<string>();
	for (const [k, v] of Object.entries(parsed)) {
		if (v === null || v === undefined) { continue; }
		if (typeof v === 'object') { continue; } // 嵌套 object/array 跳过（预览不需要）
		const s = String(v);
		if (s.length > MAX_FIELD_PREVIEW_CHARS) {
			fields[k] = s.slice(0, MAX_FIELD_PREVIEW_CHARS);
			truncated.add(k);
		} else {
			fields[k] = s;
		}
	}
	// complete：原串无需任何补全且解析成功（仅诊断参考，禁作完成/执行判定）
	const complete = !inString && !escaped && stack.length === 0;
	return { fields, truncated, complete };
}
