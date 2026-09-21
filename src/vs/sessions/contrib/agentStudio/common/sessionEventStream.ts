/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 会话**事件流**（JSONL + 游标）—— 2026-09-21（P1-5）。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────────
 * P0-1 已经把会话历史变成「追加日志 + 快照」✓，但日志此前只是**读取侧的内部实现**
 * （`_loadFromSessionFile` 一次性把整份日志重放完 ✓）⇒ 谁也没法"跟上"一个正在变化的会话 ✗：
 *   · 第二个窗口/面板想看同一会话 ⇒ 只能靠内存共享与一堆 `_sharedExternalSendSessions`
 *     这类**进程内补丁** ✗（跨进程完全不通 ✗）；
 *   · 想 headless 观察会话 ⇒ 无接口 ✗；
 *   · 想做"真会话回放"的确定性测试 ⇒ 只能重放整份，无法按批次断言增量 ✗。
 *
 * 本模块把日志抽象成**可游标读取的事件流** ✓：
 *   · `seq` = 日志中的**行序号**（1 起 ✓）—— 因为日志**只追加** ✓，行序号天然稳定 ✓；
 *   · 调用方持有 `cursor`（"我看到第几行" ✓），下次只拿**新增**事件 ✓；
 *   · 屏障 / 日志被压缩重启 ⇒ 发出 **`reset`** 事件 ✓（消费方须重载快照 ✓）。
 *
 * ── 与 `sessionHistoryLog` 的分工 ──────────────────────────────────────────────
 * `sessionHistoryLog` = 落盘格式与**重放**（把日志折叠成 `ChatMessage[]` ✓）；
 * 本模块 = **增量消费**（把日志展开成有序事件 + 游标 ✓）。
 * 两者共用同一组 op 常量 ✓（`SESSION_LOG_OP_*`）⇒ 格式只有一处定义 ✓。
 *
 * ── 三条必须守住的语义（都有对应测试 ✓）─────────────────────────────────────────
 * ① **只增量**：`seq <= cursor` 的行一律不发 ✓（重复读同一区间不得重复投递 ✗）；
 * ② **压缩安全**：日志被"快照 + 屏障 + 删除"压缩后行号会**从头开始** ✗ ——
 *    若 `总行数 < cursor.seq`，说明文件被重写过 ⇒ 必须发 `reset`（否则消费方会
 *    静默停在旧游标上，**永远读不到新内容** ✗✓）。屏障行本身同样发 `reset` ✓；
 * ③ **半行不越游标**：末尾截断的半行**不推进游标** ✓ —— 否则那条消息在补全后
 *    会被跳过 ✗（追加写的正常崩溃态，重读到它是可接受的成本 ✓）。
 */

import { SESSION_LOG_OP_APPEND, SESSION_LOG_OP_BARRIER } from './sessionHistoryLog.js';

import type { ChatMessage } from './types.js';

/** 消费位点：已消费到的**日志行序号**（1 起；`0` = 从头 ✓）。 */
export interface ISessionEventCursor {
	readonly seq: number;
}

export type SessionEventKind =
	/** 一条消息被写入（新增或按 id 覆盖 ✓）。 */
	| 'message'
	/** 历史被整段改写（屏障 ✓）或日志被压缩重写（行号重置 ✗）⇒ 消费方须重载快照 ✓。 */
	| 'reset';

export interface ISessionEvent {
	/** 该事件在日志中的行序号（1 起 ✓，只增不改 ✓）。 */
	readonly seq: number;
	readonly kind: SessionEventKind;
	/** `kind === 'message'` 时携带的消息 ✓。 */
	readonly msg?: ChatMessage;
	/** `kind === 'reset'` 时的原因（诊断 / 日志用 ✓）。 */
	readonly reason?: 'barrier' | 'log-rewritten';
}

export interface IReadSessionEventsResult {
	/** 相对传入游标的**新增**事件（按 seq 升序 ✓）。 */
	readonly events: readonly ISessionEvent[];
	/** 新的游标（无新增时等于传入游标 ✓）。 */
	readonly cursor: ISessionEventCursor;
	/** 末尾无法解析的行数（半截尾行 ✓ —— 游标已停在它之前 ✓）。 */
	readonly tornLines: number;
	/** 本次扫描的总行数（诊断 ✓）。 */
	readonly totalLines: number;
}

export const EMPTY_SESSION_EVENT_CURSOR: ISessionEventCursor = { seq: 0 };

/**
 * 从日志文本中读取 `cursor` **之后**的事件 ✓。
 *
 * 幂等性：同一份文本 + 同一游标 ⇒ 结果完全相同 ✓（可安全重试 ✓）。
 * 无副作用：不修改入参 ✓。
 */
export function readSessionEvents(logText: string, cursor?: ISessionEventCursor): IReadSessionEventsResult {
	const from = cursor?.seq ?? 0;
	const lines = logText ? logText.split('\n') : [];
	// 末尾换行会产生一个空元素 ⇒ 不算"行" ✓（否则总行数会周期性 ±1 ✗）
	const effective: { raw: string; seq: number }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (raw.trim() === '' && i === lines.length - 1) { continue; }
		effective.push({ raw, seq: i + 1 });
	}

	const events: ISessionEvent[] = [];
	let tornLines = 0;
	let newSeq = from;

	// ★ 压缩检测：行号从头开始（日志被快照+屏障+删除重写过 ✗）⇒ 游标已失效 ✓
	if (effective.length < from) {
		events.push({ seq: from + 1, kind: 'reset', reason: 'log-rewritten' });
		newSeq = 0;
	}

	for (const line of effective) {
		if (line.seq <= newSeq) { continue; } // 已消费 ✓（游标之后的才发 ✓）
		const raw = line.raw.trim();
		if (raw === '') {
			newSeq = line.seq; // 空行：消费掉（不投递 ✓）
			continue;
		}
		let parsed: { op?: unknown; msg?: unknown } | undefined;
		try {
			parsed = JSON.parse(raw) as { op?: unknown; msg?: unknown };
		} catch {
			// ★ 半行不越游标 ✓（补全后仍能被读到 ✓）
			tornLines++;
			break;
		}
		if (parsed?.op === SESSION_LOG_OP_BARRIER) {
			events.push({ seq: line.seq, kind: 'reset', reason: 'barrier' });
			newSeq = line.seq;
			continue;
		}
		if (parsed?.op === SESSION_LOG_OP_APPEND) {
			const msg = parsed.msg as ChatMessage | undefined;
			if (msg && msg.id) {
				events.push({ seq: line.seq, kind: 'message', msg });
			}
			// 缺 id 的条目：与重放侧一致地忽略 ✗（但它确实是"已消费" ⇒ 推进游标 ✓）
			newSeq = line.seq;
			continue;
		}
		// 未知 op：同样消费掉（推进游标 ✓，避免每次重读都卡在它上面 ✗）
		newSeq = line.seq;
	}

	return {
		events,
		cursor: { seq: newSeq },
		tornLines,
		totalLines: effective.length,
	};
}

/**
 * 把事件序列折叠成"当前消息视图"（消费方无需自行维护状态 ✓）。
 *
 * 规则与 `sessionHistoryLog.replaySessionLog` **保持一致的方向** ✓：
 *   · `reset` ⇒ **清空**（历史已被整段改写 ✓；但注意此时正确的内容在**快照**里，
 *     折叠结果只代表"屏障之后写入的增量" ✓ —— 需要完整视图时请先读快照 ✓）；
 *   · `message` ⇒ 按 id 覆盖/追加 ✓。
 *
 * 提供它是为了让**跨进程消费方**（CLI / 第二窗口 / 测试 ✓）不需要重复实现归并逻辑 ✓。
 */
export function foldSessionEvents(messages: readonly ChatMessage[], events: readonly ISessionEvent[], upsert: (list: ChatMessage[], msg: ChatMessage) => void): ChatMessage[] {
	const out = [...messages];
	for (const ev of events) {
		if (ev.kind === 'reset') { out.length = 0; continue; }
		if (ev.kind === 'message' && ev.msg) { upsert(out, ev.msg); }
	}
	return out;
}
