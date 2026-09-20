/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 影子日志对拍器（B2：读侧比对工具）。
 *
 * 输入 = 两份 `SessionEventShadowLog` 产出的 JSONL（同一请求分别在 legacy / pi 内核
 * 各跑一次的 `turn-events.<sessionId>.jsonl`），输出 = 结构化 diff 报告。
 *
 * 设计取舍（2026-09-20）：
 *  - **不比模型文本逐字内容**——真实会话的模型输出非确定，逐字比对必然误报。
 *    比对对象是「结构时间线」：工具调用序列（名称 + 规范 argsHash）、工具结果
 *    成败、以及护栏/引导提醒的注入点（system-reminder 出现在哪条工具结果里）。
 *    这些正是两条内核路径必须一致的失控防护面。
 *  - **顺序敏感**（不用 LCS）：双路对拍用确定性脚本模型时两条流应当逐步对齐；
 *    第一个分叉点就是最有诊断价值的信号，给出位置 + 两侧上下文即可。
 *  - 纯函数、零服务依赖 ⇒ 可在 node 测试与一次性脚本里直接复用。
 */

import { canonicalToolArgsHash } from '../common/agentRunState.js';

/** 结构时间线上的一项。 */
export interface ITimelineEntry {
	/** call=模型发起工具调用；result=工具结果；reminder=护栏/引导提醒注入。 */
	readonly kind: 'call' | 'result' | 'reminder';
	/** 工具名（reminder 为空串）。 */
	readonly name: string;
	/** call 的规范参数哈希 / result 的成败 / reminder 的提醒类别。 */
	readonly detail: string;
}

export interface IShadowDiff {
	/** 两侧逐项一致的前缀长度。 */
	readonly commonPrefix: number;
	/** 第一个分叉点（无分叉为 undefined）。 */
	readonly divergence?: {
		readonly index: number;
		readonly expected: ITimelineEntry | undefined;
		readonly actual: ITimelineEntry | undefined;
	};
	/** 两侧时间线长度（归一化后）。 */
	readonly expectedLength: number;
	readonly actualLength: number;
}

export interface IShadowCompareReport {
	readonly ok: boolean;
	readonly diffs: readonly IShadowDiff[];
	/** 人类可读摘要（CI/控制台直出）。 */
	readonly summary: string;
}

/** 解析 JSONL 文本为影子事件数组（坏行跳过并计数返回）。 */
export function parseShadowJsonl(text: string): { events: ReadonlyArray<Record<string, unknown>>; skipped: number } {
	const events: Record<string, unknown>[] = [];
	let skipped = 0;
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) { continue; }
		try {
			events.push(JSON.parse(trimmed) as Record<string, unknown>);
		} catch {
			skipped++;
		}
	}
	return { events, skipped };
}

/**
 * 从影子事件流中提取结构时间线。
 * 消息片段按 runState/legacy 循环形状宽松识别（role/content 结构在不同
 * 写入侧略有差异，这里只取语义字段，不做类型强转）。
 */
export function extractTimeline(events: ReadonlyArray<Record<string, unknown>>): ITimelineEntry[] {
	const out: ITimelineEntry[] = [];
	for (const ev of events) {
		const messages = ev['messages'];
		if (!Array.isArray(messages)) { continue; }
		for (const raw of messages) {
			collectMessageEntries(raw, out);
		}
	}
	return out;
}

function collectMessageEntries(raw: unknown, out: ITimelineEntry[]): void {
	const msg = raw as { role?: string; content?: unknown; toolName?: string; name?: string; success?: boolean; isError?: boolean };
	if (!msg || typeof msg !== 'object') { return; }

	// 工具结果消息（runState 形状：{ role:'tool', toolName, content, isError } 或带 success）
	if (msg.role === 'tool' || msg.role === 'toolResult') {
		const name = msg.toolName ?? msg.name ?? '';
		const ok = msg.success ?? (msg.isError === true ? false : true);
		out.push({ kind: 'result', name, detail: ok ? 'ok' : 'fail' });
		// 护栏/引导提醒注入点：结果文本里出现 system-reminder
		const text = flattenText(msg.content);
		const reminderCount = (text.match(/system-reminder/g) ?? []).length;
		for (let i = 0; i < reminderCount; i++) {
			out.push({ kind: 'reminder', name: '', detail: classifyReminder(text) });
		}
		return;
	}

	// 助手消息：提取其中的工具调用块
	if (msg.role === 'assistant') {
		const content = Array.isArray(msg.content) ? msg.content : [];
		for (const block of content) {
			const b = block as { type?: string; name?: string; arguments?: unknown; args?: unknown };
			if (b && (b.type === 'toolCall' || b.type === 'tool_call' || b.type === 'tool_use')) {
				const args = b.arguments ?? b.args ?? {};
				const parsed = typeof args === 'string' ? safeParse(args) : args;
				out.push({ kind: 'call', name: b.name ?? '', detail: canonicalToolArgsHash(parsed as Record<string, unknown>) });
			}
		}
	}
}

/** 提醒分类（粗粒度——同类提醒的文案参数差异不构成 diff）。 */
function classifyReminder(text: string): string {
	if (text.includes('no progress') || text.includes('identical result')) { return 'no-progress'; }
	if (text.includes('Ping-pong') || text.includes('ping-pong')) { return 'ping-pong'; }
	if (text.includes('past the soft budget')) { return 'soft-budget'; }
	if (text.includes('Iteration limit reached')) { return 'hard-limit'; }
	if (text.includes('consecutive') && text.includes('fail')) { return 'consecutive-fail'; }
	if (text.includes('stop searching') || text.includes('graph search')) { return 'text-search'; }
	return 'other';
}

function flattenText(content: unknown): string {
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		return content.map(b => {
			const block = b as { type?: string; text?: string };
			return block && (block.type === 'text' || block.type === 'output_text') ? (block.text ?? '') : '';
		}).join('\n');
	}
	return '';
}

function safeParse(text: string): Record<string, unknown> {
	try {
		const v = JSON.parse(text) as unknown;
		return v && typeof v === 'object' ? v as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

/**
 * 比对两条结构时间线（顺序敏感；第一个分叉点即报告）。
 * @param label 报告里的对比项名称（如 'main-turn'）。
 */
export function compareTimelines(
	label: string,
	expected: readonly ITimelineEntry[],
	actual: readonly ITimelineEntry[],
): IShadowCompareReport {
	let i = 0;
	while (i < expected.length && i < actual.length && timelineEntryEquals(expected[i]!, actual[i]!)) {
		i++;
	}
	const diverged = i < expected.length || i < actual.length;
	const diffs: IShadowDiff[] = diverged ? [{
		commonPrefix: i,
		divergence: { index: i, expected: expected[i], actual: actual[i] },
		expectedLength: expected.length,
		actualLength: actual.length,
	}] : [];
	const summary = diverged
		? `[${label}] DIVERGED @${i}: expected=${formatEntry(expected[i])} actual=${formatEntry(actual[i])} (lengths ${expected.length} vs ${actual.length})`
		: `[${label}] OK (${expected.length} entries identical)`;
	return { ok: !diverged, diffs, summary };
}

/** 端到端：两份 JSONL 文本 → 报告。 */
export function compareShadowJsonl(label: string, expectedText: string, actualText: string): IShadowCompareReport {
	const expected = extractTimeline(parseShadowJsonl(expectedText).events);
	const actual = extractTimeline(parseShadowJsonl(actualText).events);
	return compareTimelines(label, expected, actual);
}

function timelineEntryEquals(a: ITimelineEntry, b: ITimelineEntry): boolean {
	return a.kind === b.kind && a.name === b.name && a.detail === b.detail;
}

function formatEntry(e: ITimelineEntry | undefined): string {
	return e === undefined ? '(end)' : `${e.kind}:${e.name}:${e.detail.slice(0, 24)}`;
}
