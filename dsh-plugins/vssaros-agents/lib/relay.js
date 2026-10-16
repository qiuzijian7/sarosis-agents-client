// @vssaros/dsh-agents — relay（主机侧）：`agent_message` 的回复自动回传（P3.2）。
//
// 流程：发送时登记 pending（`notePendingReply`，消息 id 为锚）→ 目标会话的 `agent/turn-stopping`
// （回合即将关闭、串行 ✓，与 vssaros-memory 的自动沉淀同一个钩子 ✓）→ 验证这回合真消费了我们的消息
// → 取最终文本 → `followup` 回发送方会话（独立回合，不插队）。
//
// ⚠ **模块级 PENDING 是刻意的**：本包会被挂两次（顶层 + preset 内 toolsOnly），两份闭包 state 会让
//    "preset 面发的消息"永远等不到"host 面装的回传" ✗ —— 与 kanban 的模块级串行队列同一判据
//    （同进程只加载一次 ⇒ 共享才对 ✓，A3 审计结论）。Host 重启 ⇒ 未回传的 pending 丢失（发送方回执
//    里已如实写明"重要的事自己跟进" ✓）。
// ⚠ relay 只装在**顶层角色**（宿主面看得到全部会话的事件）；toolsOnly 角色不装（它的事件视野未证 ✗）。

import { randomUUID } from 'node:crypto';
import { presetIdOf } from './core/agents.js';
import { AGENT_REPLY_KIND, finalAssistantText, findOurSplices, replyText } from './core/relay.js';
import { readLiveSession } from './live.js';
import { agentsRootOf, scanAgents } from './store.js';

/** @type {Map<string, Array<{messageId:string, from:string|null, fromName:string, hop:number, sentAt:number}>>} 目标会话 id → 待回传队列 */
const PENDING = new Map();

/** 发送方登记一条"等它回"（`agent_message` 投递成功后调）。 */
export function notePendingReply(sessionId, entry) {
	const list = PENDING.get(sessionId) ?? [];
	list.push({ ...entry, sentAt: Date.now() });
	PENDING.set(sessionId, list);
}

/** 测试/诊断用：当前 pending 全表（只读快照）。 */
export function pendingRepliesSnapshot() {
	return [...PENDING.entries()].map(([sessionId, list]) => ({ sessionId, count: list.length }));
}

/** 会话 id → 显示名（projcache preset → agent 名；取不到就退回 preset id / 会话 id）。 */
async function displayNameOf(config, sessionId) {
	const row = await readLiveSession(config, sessionId).catch(() => null);
	const preset = row?.row?.presetId;
	if (!preset) {
		return sessionId;
	}
	const scan = await scanAgents(agentsRootOf(config)).catch(() => null);
	return scan?.agents.find(a => presetIdOf(a.id) === preset)?.name ?? preset;
}

/**
 * 装回传监听。返回 dispose。
 * @param ctx 顶层角色的上下文（事件总线）
 * @param config 本行 config（名字解析走数据根/dshHome 链）
 * @param state 顶层角色状态（`agents` 服务槽位：回传投递用）
 */
export function installRelay(ctx, config, state) {
	/** 每个会话上次处理到的事件 seq（与 memory 自动沉淀同一手法 ✓）。 */
	const seenSeq = new Map();

	return ctx.on('agent/turn-stopping', async payload => {
		const session = payload?.agent?.session;
		if (!session?.id || typeof session.snapshotEvents !== 'function') {
			return;
		}
		const pending = PENDING.get(session.id);
		if (!pending || pending.length === 0) {
			return; // 没人等它回：不看事件（省一次全窗扫描 ✓）
		}
		let events;
		try {
			const from = seenSeq.get(session.id) ?? 0;
			const to = typeof session.seq === 'number' ? session.seq : 0;
			events = to > from ? Array.from(session.snapshotEvents(from, to)) : [];
			seenSeq.set(session.id, to);
		} catch {
			return; // 读不动就不回传（pending 留着，下回合再试 ✓）
		}
		const hits = findOurSplices(events, new Set(pending.map(p => p.messageId)));
		if (hits.length === 0) {
			return; // 这回合没消费我们的消息（比如用户自己开的回合）⇒ pending 留着 ✓
		}
		const final = finalAssistantText(events);
		const responderName = await displayNameOf(config, session.id);
		const answered = new Set(hits.map(m => m.id));
		for (const entry of pending.filter(p => answered.has(p.messageId))) {
			const sender = entry.from ? state.agents?.get?.(entry.from) : undefined;
			if (!sender || typeof sender.followup !== 'function') {
				console.warn(`[vssaros-agents] 回传投递失败（发送方会话不在运行）：${entry.from ?? '(无 id)'}`);
				continue;
			}
			sender.followup({
				id: randomUUID(),
				role: 'user',
				content: [{ type: 'text', text: replyText({ responderName, responderSessionId: session.id, final }) }],
				// 回传**不登记 pending** ⇒ 对方的下一回合不会再触发回传（结构上断掉 ping-pong ✓）
				source: { kind: AGENT_REPLY_KIND, from: session.id, to: entry.from, inReplyTo: entry.messageId, hop: entry.hop },
			});
		}
		PENDING.set(session.id, pending.filter(p => !answered.has(p.messageId)));
	});
}
