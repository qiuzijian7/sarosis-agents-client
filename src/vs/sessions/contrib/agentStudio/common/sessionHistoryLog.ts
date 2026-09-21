/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 会话历史的**追加日志**（append-only journal）—— 2026-09-21（P0-1）。
 *
 * ── 为什么需要 ────────────────────────────────────────────────────────────────
 * 会话历史此前是**整文件覆盖写**：`appendMessage` / `appendMessagesBatch` /
 * `updateMessage` 每调用一次就 `JSON.stringify(整个会话)` 再写盘 ✗。这带来两类问题：
 *
 *  ① **成本与消息数成正比** —— 62 轮 turn = 62 次全量序列化（真实事故见
 *     `agentChatBatchPersist.test.ts` 头注释：渲染进程被阻塞 2.5 分钟 ✗）；
 *  ② **崩溃丢整轮** —— 原子写只保证「要么旧内容、要么新内容」✓，若进程在两轮之间
 *     被 kill/OOM，磁盘上是**上一轮的快照** ⇒ 本轮全部内容丢失 ✗
 *     （用户可见：「LLM 输出途中 app 被关 → 重启后内容消失」）。
 *
 * 对齐开源（Cline 每次消息更新即写盘 ✓ / OpenCode 按 part 逐条落盘 ✓ / Continue 防抖写 ✓）：
 * 共性 = **流式内容增量落盘**。本模块即该思路在会话层的落地 ✓。
 *
 * ── 布局（两种文件，职责分离 ✓）────────────────────────────────────────────────
 *   `sessions/{sessionId}.json`   —— **快照**（完整 `ChatMessage[]`，原子覆盖写 ✓）
 *   `sessions/{sessionId}.jsonl`  —— **追加日志**（一行一条，只追加不重写 ✓）
 *
 * 读取 = 快照 + 重放日志 ✓；写入 = 只追加日志 ✓；日志膨胀到阈值 ⇒ 快照 + 屏障 + 截断 ✓。
 *
 * ── 屏障（barrier）为什么是必需的 ──────────────────────────────────────────────
 * 「写快照 → 截断日志」这两步之间若崩溃（✗ 断电 / 被 kill），日志仍带着**已进入快照的
 * 旧条目** ⇒ 重放时会把它们再叠一遍 ✗。故顺序改为：
 *   ① 写快照（原子 ✓）→ ② **追加一行屏障** → ③ 尽力删除日志（删不掉也无妨 ✓）
 * 重放规则：**屏障之前的所有条目一律丢弃** ✓ ⇒ 崩在 ①② 之间 = 状态仍正确 ✓✓；
 * 崩在 ②③ 之间 = 屏障已落盘 ⇒ 同样正确 ✓。截断因此从「正确性必需」降级为「体积优化」✓。
 *
 * ── 去重 / 幂等 ────────────────────────────────────────────────────────────────
 * 条目以消息 **id** 定位（`upsertMessageById`）：同 id 覆盖原位置、否则追加 ✓。
 * 于是**重放同一份日志两次的结果完全相同**（幂等 ✓）—— 这是「截断失败重放」与
 * 「流式期间同 id 反复更新」（同一 assistant 消息每轮 delta 覆盖 ✓）都能安全工作的前提 ✓。
 */

import type { ChatMessage } from './types.js';

/** 会话追加日志的扩展名（`sessions/{sessionId}.jsonl`）。 */
export const SESSION_LOG_SUFFIX = '.jsonl';

/** 日志条目：追加一条消息（同 id 覆盖 ✓）。 */
export const SESSION_LOG_OP_APPEND = 'a';

/** 日志条目：**屏障** —— 此前的条目已包含在快照里，重放时一律丢弃 ✓。 */
export const SESSION_LOG_OP_BARRIER = 'base';

export interface ISessionLogAppendLine {
	readonly op: typeof SESSION_LOG_OP_APPEND;
	readonly msg: ChatMessage;
}

export interface ISessionLogBarrierLine {
	readonly op: typeof SESSION_LOG_OP_BARRIER;
	readonly ts: number;
}

export type SessionLogLine = ISessionLogAppendLine | ISessionLogBarrierLine;

/**
 * 序列化一批追加条目（每行一笔 ✓）。
 *
 * 无 `id` 的消息**不写**（它们无法在重放时定位 ⇒ 只会造成重复气泡 ✗）；
 * 调用方本就有跨会话与去重守卫（见 `AgentChatService.appendMessage` ✓），此处只兜底 ✓。
 */
export function serializeSessionLogAppends(msgs: readonly ChatMessage[]): string {
	let out = '';
	for (const m of msgs) {
		if (!m || !m.id) { continue; }
		out += JSON.stringify({ op: SESSION_LOG_OP_APPEND, msg: m }) + '\n';
	}
	return out;
}

export function serializeSessionLogBarrier(): string {
	return JSON.stringify({ op: SESSION_LOG_OP_BARRIER, ts: Date.now() }) + '\n';
}

export interface ISessionLogReplay {
	/** 屏障之后真正生效的消息（已按 id 归并 ✓）。 */
	readonly messages: ChatMessage[];
	/** 屏障之后的追加条数（用于压缩阈值计数 ✓ —— 屏障之前的条目已被丢弃）。 */
	readonly appends: number;
	/** 屏障之后的**字节数**（压缩的第二个阈值 ✓ —— 条数阈值兜不住 MB 级工具结果 ✗）。 */
	readonly bytes: number;
	/** 解析失败的行数（崩溃截断的尾行 ✓ 静默忽略）。 */
	readonly tornLines: number;
	/** 是否见过屏障（诊断用 ✓）。 */
	readonly barrierSeen: boolean;
}

/**
 * 重放日志文本 ⇒ 消息列表（**只返回屏障之后的条目** ✓）。
 *
 * ⚠ 容错原则：任何解析失败的行都**只丢弃该行**，绝不整体失败 ✗ ——
 * 追加写被 kill 时最后一行可能只写了一半（`{"op":"a","msg":{...` ✗），
 * 这是**正常情况**而非损坏 ✓（此时最大的损失就是最后一条消息 ✓）。
 */
export function replaySessionLog(text: string): ISessionLogReplay {
	let messages: ChatMessage[] = [];
	let appends = 0;
	let bytes = 0;
	let tornLines = 0;
	let barrierSeen = false;
	if (!text) {
		return { messages, appends, bytes, tornLines, barrierSeen };
	}
	for (const line of text.split('\n')) {
		const raw = line.trim();
		if (!raw) { continue; } // 空行（含文件末尾换行）✓
		let parsed: { op?: unknown; msg?: unknown; ts?: unknown } | undefined;
		try {
			parsed = JSON.parse(raw) as { op?: unknown; msg?: unknown };
		} catch {
			tornLines++;
			continue;
		}
		if (parsed?.op === SESSION_LOG_OP_BARRIER) {
			// 屏障：此前的一切都以快照为准 ⇒ 全部丢弃 ✓
			messages = [];
			appends = 0;
			bytes = 0;
			barrierSeen = true;
			continue;
		}
		if (parsed?.op === SESSION_LOG_OP_APPEND) {
			const msg = parsed.msg as ChatMessage | undefined;
			if (msg && msg.id) {
				upsertMessageById(messages, msg);
				appends++;
				bytes += raw.length + 1; // 行内容 + 换行 ✓（用于字节阈值 ✓）
				continue;
			}
		}
		tornLines++; // 未知 op / 缺 id：同样只丢这一行 ✓
	}
	return { messages, appends, bytes, tornLines, barrierSeen };
}

/**
 * 按 id 归并一条消息：同 id ⇒ **原位置覆盖**（不移动 ✓）；否则追加到末尾 ✓。
 *
 * 「原位置覆盖」而非「移到末尾」是重放幂等性的关键 ✓：否则重放顺序会改变消息次序
 * （同一条消息先 push 再搬到末尾 ⇒ 与真实发生顺序不符 ✗）。
 *
 * 对**流式**场景而言这就是原有的 tail-replace 语义 ✓（同一 assistant 消息的每次更新
 * 都在末尾 ⇒ 覆盖末尾 ✓），对**非末尾的同 id 消息**则顺带消除了重复气泡 ✗。
 */
export function upsertMessageById(messages: ChatMessage[], msg: ChatMessage): void {
	if (!msg || !msg.id) { return; }
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].id === msg.id) {
			messages[i] = msg;
			return;
		}
	}
	messages.push(msg);
}
