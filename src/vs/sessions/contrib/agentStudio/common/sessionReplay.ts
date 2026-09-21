/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 会话**回放 + 结构 digest + 不变量体检**（P1-7，2026-09-21）。
 *
 * ── 定位 ──────────────────────────────────────────────────────────────────────
 * P0-1 给了「快照 + 追加日志」，P1-5 给了「游标事件流」✓ —— 本模块是它们的
 * **第一个分析型消费者** ✓：把任意一份**真实落盘历史**重建成消息列表 ✓，
 * 算一份**结构 digest**（计数 / 体积 / 卡片数 ✓）并跑一组**不变量体检** ✓。
 *
 * 三件实际用途：
 *   ① **回归证据**：改上下文拼装 / 工具执行 / 持久化之后，用真实会话回放一遍，
 *      digest 与不变量给出**确定性**的对照（不依赖模型文本 ✓ —— 与既有对拍器同思路 ✓）；
 *   ② **数据体检**：回答"这条会话为什么不渲染 / 为什么模型报孤儿工具调用"✗
 *      —— 直接看 violations 即可（每条带 messageId ✓）；
 *   ③ **CI 可门**：`npm run session:digest -- --all` 对**真实**会话根跑体检并按退出码分流 ✓。
 *
 * ── 设计约束（重要 ✗）──────────────────────────────────────────────────────────
 * · 运行时只依赖 `sessionHistoryLog.js` ✓ —— 这样 `scripts/session-digest.mjs` 可以直接
 *   `require('out/.../sessionReplay.js')` 跑（**单一实现** ✓，不像 CLI tail 那样需要双实现 ✗）；
 * · **孤儿判定只针对持久化形态** ✓（`assistant.toolCalls[]` 的 `id` / `name` / `status` / `result`
 *   与 `role:'tool'` 消息 ✓）。内核形态（`content` 块里的 `toolCall` ✓）由
 *   `piLoop/kernelTranscriptHygiene.ts` 负责 ✓ —— 两套形态不同，**不要混用** ✗✓；
 * · **末端宽限** ✓：最后一条消息之后仍无 result 的调用**不算违规**（会话可能是被 kill 的 ✓），
 *   只记为 warning ✓ —— 否则每次"中途关 app"都会让体检红 ✗。
 */

import { replaySessionLog, upsertMessageById } from './sessionHistoryLog.js';
// ★ 与**请求侧同一条**裁剪逻辑 ✓（`_toDriverMessages` 首行用的就是它 ✓）——
//   绝不在这里重写一遍 ✗（否则体检结论会和模型实际看到的不一致 ✗✓）。
import { findLastCompactionBoundaryIndex, findLastValidCompactionBoundaryIndex, sliceAtCompactionBoundary } from './historyCompaction.js';

import type { ChatMessage } from './types.js';

/** 体检项严重度：`violation` = 数据不一致（必须处理 ✗）；`warning` = 可疑但不致命 ✓。 */
export type SessionFindingSeverity = 'violation' | 'warning';

export interface ISessionFinding {
	readonly kind: string;
	readonly severity: SessionFindingSeverity;
	readonly detail: string;
	readonly messageId?: string;
}

export interface ISessionDigest {
	/**
	 * ★ 2026-09-21：**模型实际能看到的条数** ✓ —— 与请求侧同一条语义
	 * （`_toDriverMessages` 首行 `sliceAtCompactionBoundary` ✓：有边界时丢弃边界之前全部消息 ✓）。
	 * 这是判断"模型为什么失忆"最直观的指标 ✗✓（真机事故：13 条里模型只看到 7 条 ✓）。
	 */
	readonly modelVisibleMessages: number;
	/** 被压缩边界丢弃的条数（0 = 模型能看到全部 ✓）。 */
	readonly droppedByCompactionBoundary: number;
	/** 是否存在压缩边界（诊断 ✓）。 */
	readonly hasCompactionBoundary: boolean;
	readonly messages: number;
	readonly byRole: Readonly<Record<string, number>>;
	/** 不同 `turnId` 的数量（无 turnId 的旧数据按"每条 assistant 独立"计 ✓）。 */
	readonly turns: number;
	readonly toolCalls: number;
	/** 有 `result` 或 `status === 'done'` 的调用数 ✓。 */
	readonly resolvedToolCalls: number;
	/** 携带 `parts` 的消息数（阶段E 新格式覆盖度 ✓）。 */
	readonly messagesWithParts: number;
	readonly attachments: number;
	/** 携带交互卡片字段的消息数（确认/提问/待办/工作流/变量收集 ✓）。 */
	readonly cardMessages: number;
	readonly thinkingMessages: number;
	/** 粗估字节（`JSON.stringify` 长度 ✓ —— 只用于横向比较趋势 ✓）。 */
	readonly approxBytes: number;
	readonly firstTimestamp?: string;
	readonly lastTimestamp?: string;
}

/** 需要被当作"卡片"字段的键（与 `getHistory` 的空消息过滤保持同一张清单 ✓）。 */
const CARD_KEYS = [
	'confirmation', 'questions', 'todos', 'collectVariables',
	'workflowExecutions', 'askUsers', 'workflowEvents', 'references', 'subAgents',
] as const;

type LooseMessage = ChatMessage & Record<string, unknown>;

interface IToolCallLike {
	readonly id?: unknown;
	readonly name?: unknown;
	readonly status?: unknown;
	readonly result?: unknown;
}

function toolCallsOf(m: ChatMessage): readonly IToolCallLike[] {
	const tc = (m as LooseMessage).toolCalls;
	return Array.isArray(tc) ? (tc as IToolCallLike[]) : [];
}

/** 调用是否已有结果 ✓（`result` 存在或 `status === 'done'` ✓）。 */
function isResolved(tc: IToolCallLike): boolean {
	if (typeof tc.result === 'string' && tc.result.length > 0) { return true; }
	return tc.status === 'done';
}

function hasCardFields(m: ChatMessage): boolean {
	for (const k of CARD_KEYS) {
		const v = (m as LooseMessage)[k];
		if (v !== undefined && v !== null) { return true; }
	}
	return false;
}

/** 结构 digest（纯计数 ✓ —— 不含任何模型文本 ✓）。 */
export function buildSessionDigest(messages: readonly ChatMessage[]): ISessionDigest {
	const byRole: Record<string, number> = {};
	let toolCalls = 0;
	let resolvedToolCalls = 0;
	let messagesWithParts = 0;
	let attachments = 0;
	let cardMessages = 0;
	let thinkingMessages = 0;
	let approxBytes = 0;
	const turns = new Set<string>();
	let first: string | undefined;
	let last: string | undefined;

	for (const m of messages) {
		byRole[m.role] = (byRole[m.role] ?? 0) + 1;
		for (const tc of toolCallsOf(m)) {
			toolCalls++;
			if (isResolved(tc)) { resolvedToolCalls++; }
		}
		const loose = m as LooseMessage;
		if (Array.isArray(loose.parts) && (loose.parts as unknown[]).length > 0) { messagesWithParts++; }
		if (Array.isArray(m.attachments) && m.attachments.length > 0) { attachments += m.attachments.length; }
		if (hasCardFields(m)) { cardMessages++; }
		if (typeof m.thinking === 'string' && m.thinking.length > 0) { thinkingMessages++; }
		if (typeof m.turnId === 'string' && m.turnId) { turns.add(m.turnId); }
		const ts = m.timestamp;
		if (typeof ts === 'string' && ts) {
			if (!first || ts < first) { first = ts; }
			if (!last || ts > last) { last = ts; }
		}
		try { approxBytes += JSON.stringify(m).length; } catch { /* 循环引用（不该出现）⇒ 跳过体积统计 ✓ */ }
	}

	return {
		messages: messages.length,
		// ★ 「模型实际能看到的条数」✓ —— 与请求侧同源（`sliceAtCompactionBoundary` ✓）
		modelVisibleMessages: sliceAtCompactionBoundary(messages as readonly (ChatMessage & { metadata?: { type?: string } })[]).length,
		// 「被压缩边界丢弃的**历史**条数」= 最后一条**可信**边界之前的条数（2026-09-21）。
		// ⚠ 不从 `messages - modelVisible` 反推：模型看不见的条数里还包含"摘要饥饿⇒被剔除的
		//   不可信边界标记"（`sliceAtCompactionBoundary` 的过滤），那不算历史丢失 ⇒ 反推会把
		//   它误报成"压缩裁掉了 N 条"（体检的 ⚠ 行是给用户看"历史是否被裁"的 ✗）。
		droppedByCompactionBoundary: Math.max(0, findLastValidCompactionBoundaryIndex(
			messages as readonly (ChatMessage & { metadata?: { type?: string } })[])),
		hasCompactionBoundary: findLastCompactionBoundaryIndex(messages as readonly (ChatMessage & { metadata?: { type?: string } })[]) >= 0,
		byRole,
		turns: turns.size,
		toolCalls,
		resolvedToolCalls,
		messagesWithParts,
		attachments,
		cardMessages,
		thinkingMessages,
		approxBytes,
		firstTimestamp: first,
		lastTimestamp: last,
	};
}

/**
 * 不变量体检（**只读** ✓，不修改入参 ✓）。
 *
 * ⚠ 全部判定都基于**持久化形态** ✓（见文件头注释的约束 ✗）。
 */
export function checkSessionInvariants(messages: readonly ChatMessage[]): ISessionFinding[] {
	const findings: ISessionFinding[] = [];

	// ⓪ 压缩边界 ⇒ 模型**看不到**边界之前的全部历史 ✗ —— 真机事故（2026-09-21）的头号机制 ✓：
	//    边界摘要把「当前任务」写成「无」✗ ⇒ 用户说「执行」时模型答"没有待执行的任务指令" ✓✓。
	const boundarySlice = sliceAtCompactionBoundary(messages as readonly (ChatMessage & { metadata?: { type?: string } })[]);
	if (boundarySlice.length < messages.length) {
		findings.push({
			kind: 'compaction-boundary-hides-history',
			severity: 'warning',
			detail: `压缩边界取代了更早的 ${messages.length - boundarySlice.length} 条历史 ⇒ 模型只能看到 ` +
				`${boundarySlice.length}/${messages.length} 条 ✗（若用户说「执行/继续」而模型答"没有任务"✓，` +
				`先看这条：边界摘要可能把任务写成了"无" ✗）`,
		});
	}

	// ① 重复 id ✗ —— P0-1 的按 id 归并本应杜绝；真出现 ⇒ 持久化链有洞 ✓
	const seenIds = new Map<string, number>();
	for (const m of messages) {
		if (typeof m.id !== 'string' || !m.id) {
			findings.push({ kind: 'message-without-id', severity: 'violation', detail: '消息缺少 id（无法被游标/去重定位 ✗）' });
			continue;
		}
		seenIds.set(m.id, (seenIds.get(m.id) ?? 0) + 1);
	}
	for (const [id, count] of seenIds) {
		if (count > 1) {
			findings.push({ kind: 'duplicate-id', severity: 'violation', messageId: id, detail: `同 id 出现 ${count} 次 ✗（按 id 归并应保证唯一 ✓）` });
		}
	}

	// ② 工具调用 / 结果配对（末端宽限 ✓）
	const resultIds = new Set<string>();
	for (const m of messages) {
		if (m.role !== 'tool') { continue; }
		const loose = m as LooseMessage;
		const id = (typeof loose.toolCallId === 'string' ? loose.toolCallId : undefined)
			?? (typeof toolCallsOf(m)[0]?.id === 'string' ? toolCallsOf(m)[0]!.id as string : undefined);
		if (!id) {
			findings.push({ kind: 'tool-message-without-id', severity: 'warning', messageId: m.id, detail: 'role:tool 消息没有 call id ⇒ 无法与调用配对（后端可能整条剔除 ✗）' });
			continue;
		}
		resultIds.add(id);
	}
	const calledIds = new Set<string>();
	for (const m of messages) {
		for (const tc of toolCallsOf(m)) {
			if (typeof tc.id !== 'string' || !tc.id) {
				findings.push({ kind: 'tool-call-without-id', severity: 'violation', messageId: m.id, detail: 'toolCall 缺少 id ✗' });
				continue;
			}
			if (typeof tc.name !== 'string' || !tc.name) {
				findings.push({ kind: 'tool-call-without-name', severity: 'violation', messageId: m.id, detail: `toolCall ${tc.id} 缺少 name ✗` });
			}
			calledIds.add(tc.id);
			if (isResolved(tc) || resultIds.has(tc.id)) { continue; }
			// 末端宽限：**最后一条消息**里的未完成调用不算违规 ✓（会话可能被 kill ✓）
			const isTrailing = m === messages[messages.length - 1];
			findings.push({
				kind: 'orphan-tool-call',
				severity: isTrailing ? 'warning' : 'violation',
				messageId: m.id,
				detail: `工具调用 ${tc.name ?? tc.id} 无结果${isTrailing ? '（末尾 · 可能是被中断的会话 ✓）' : '（历史中段 ⇒ 后端会整批剔除，模型看到的上下文与磁盘不一致 ✗）'}`,
			});
		}
	}
	for (const id of resultIds) {
		if (!calledIds.has(id)) {
			findings.push({ kind: 'orphan-tool-result', severity: 'violation', detail: `工具结果 ${id} 找不到对应调用 ✗` });
		}
	}

	// ③ 空 assistant（无文本/无片段/无工具/无卡片）⇒ 数据债 ✓（getHistory 已过滤，但磁盘仍在长 ✗）
	for (const m of messages) {
		if (m.role !== 'assistant') { continue; }
		const loose = m as LooseMessage;
		const hasText = typeof m.content === 'string' && m.content.trim().length > 0;
		const hasParts = Array.isArray(loose.parts) && (loose.parts as unknown[]).length > 0;
		const hasTools = toolCallsOf(m).length > 0;
		const hasThinking = typeof m.thinking === 'string' && m.thinking.length > 0;
		if (!hasText && !hasParts && !hasTools && !hasThinking && !hasCardFields(m)) {
			findings.push({ kind: 'empty-assistant-message', severity: 'warning', messageId: m.id, detail: '既无文本也无卡片 ⇒ 渲染层会丢弃它（空白气泡的来源 ✗）' });
		}
	}

	// ④ 无内容用户消息 ⇒ 用户**纯片段/纯图片**消息（2026-09-19 实测 bug 类 ✓：
	//    附件此前不落盘 ⇒ 重启后变成空气泡 ✗）。修好后 attachments 应存活 ✓
	for (const m of messages) {
		if (m.role !== 'user') { continue; }
		const hasText = typeof m.content === 'string' && m.content.trim().length > 0;
		const hasAtt = Array.isArray(m.attachments) && m.attachments.length > 0;
		if (!hasText && !hasAtt) {
			findings.push({ kind: 'user-message-without-payload', severity: 'warning', messageId: m.id, detail: '用户消息既无文本也无附件 ⇒ 重启后会显示空气泡 ✗' });
		}
	}

	return findings;
}

export interface ISessionReplayResult {
	readonly messages: ChatMessage[];
	readonly digest: ISessionDigest;
	readonly findings: readonly ISessionFinding[];
	/** 日志侧的统计（诊断 ✓）：屏障之后的追加条数 / 截断行数 / 是否见过屏障 ✓。 */
	readonly logStats: { readonly appends: number; readonly tornLines: number; readonly barrierSeen: boolean };
}

/**
 * 回放一份**真实落盘历史**：快照 + 追加日志 ✓（语义完全复用 P0-1 ✓）。
 *
 * 传 `undefined`/空串表示该文件不存在 ✓（新会话可能只有日志、或只有快照 ✓）。
 * 单份文件损坏时**不抛** ✓：快照不可解析 ⇒ 只靠日志（并在 digest 里体现条数 ✓）。
 */
export function replaySessionHistory(snapshotJson: string | undefined, logText: string | undefined): ISessionReplayResult {
	let messages: ChatMessage[] = [];
	if (snapshotJson && snapshotJson.trim()) {
		try {
			const parsed = JSON.parse(snapshotJson) as unknown;
			if (Array.isArray(parsed)) { messages = parsed as ChatMessage[]; }
		} catch { /* 损坏快照 ⇒ 退回日志重建 ✓ */ }
	}
	const replay = replaySessionLog(logText ?? '');
	for (const m of replay.messages) { upsertMessageById(messages, m); }

	return {
		messages,
		digest: buildSessionDigest(messages),
		findings: checkSessionInvariants(messages),
		logStats: { appends: replay.appends, tornLines: replay.tornLines, barrierSeen: replay.barrierSeen },
	};
}

/** 是否值得让调用方以非零退出（只按真违规判定 ✓，warning 不阻塞 ✓）。 */
export function hasBlockingFindings(findings: readonly ISessionFinding[]): boolean {
	return findings.some(f => f.severity === 'violation');
}

/**
 * 把体检结果压成一行摘要（CLI 与测试共用 ✓，保证两边口径一致 ✓）。
 */
export function formatDigestLine(digest: ISessionDigest): string {
	const roles = Object.entries(digest.byRole).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`).join(' ');
	// ★「模型可见」放在最显眼处 ✓ —— 它才是"模型为什么失忆"的第一指标 ✗✓
	const visibility = digest.droppedByCompactionBoundary > 0
		? `⚠ 模型可见=${digest.modelVisibleMessages}/${digest.messages}（压缩边界丢弃 ${digest.droppedByCompactionBoundary} 条 ✗）`
		: `模型可见=${digest.modelVisibleMessages}/${digest.messages} ✓`;
	return `${visibility} | msgs=${digest.messages} (${roles}) turns=${digest.turns} tools=${digest.resolvedToolCalls}/${digest.toolCalls} ` +
		`parts=${digest.messagesWithParts} cards=${digest.cardMessages} att=${digest.attachments} ` +
		`~${Math.round(digest.approxBytes / 1024)}KB`;
}
