// @vssaros/dsh-agents — relay（主机侧）：`agent_message` 的回复自动回传（P3.2）。
//
// 流程：发送时登记 outbox pending（消息 id 为锚）→ 目标会话的 `agent/turn-stopping`
// （回合即将关闭、串行 ✓，与 vssaros-memory 的自动沉淀同一个钩子 ✓）→ 验证这回合真消费了我们的消息
// → 取最终内容 → 按 pending 的 kind 分流：
//   · `relay` ⇒ `followup` 回发送方会话（独立回合，不插队）
//   · `im`    ⇒ `bindingHub.deliverForEntry` 推回该绑定对应的 IM 会话（飞书/Telegram/…）
//
// ★ 2026-11-10：`im` 这条曾随「群聊整体下线」一起被删掉，导致 Bot 答了、outbox 永远 pending、
//   飞书收不到任何回复（真机日志：WS 收到事件 → 会话 outputTokens 有值 → 无任何出站记录）。
//   outbox 写入、`deliverForEntry` API、`finalAssistantContent` 都还在，缺的只是这里的回收分支。
//
// ⚠ 队列真源在 **lib/outbox.js**（2026-10-16 二期起落盘，Host 重启读回 ✓；本文件的模块级 PENDING
//    已撤）。本模块只管"回收判定 + 投递"，不管存储 ✓。
// ⚠ 投递失败（发送方不在运行）⇒ **outboxMarkUnknown**（unknown-outcome，不删不自动重发 ✓；
//    此前是 console.warn 后随回收一起删 = 静默丢 ✗，二期修掉）。重发只有页面上的手动口 ✓。
// ⚠ relay 只装在**顶层角色**（宿主面看得到全部会话的事件）；toolsOnly 角色不装（它的事件视野未证 ✗）。

import { randomUUID } from 'node:crypto';
import { AGENT_REPLY_KIND, finalAssistantContent, finalAssistantText, findOurSplices, replyText } from './core/relay.js';
import { readLiveSession } from './live.js';
import { outboxMarkUnknown, outboxNote, outboxPendingFor, outboxResolve } from './outbox.js';
import { agentsRootOf, scanAgents } from './store.js';
import { rowAgentOf } from './core/live.js';

/**
 * 发送方登记一条"等它回"（投递成功后调）。entry = { messageId, from, fromName, hop }。
 * （2026-10-16 起带 config 第一参：登记要写穿 outbox ✓）
 */
export function notePendingReply(config, sessionId, entry) {
	return outboxNote(config, { kind: 'relay', sessionId, ...entry });
}

/** 会话 id → 显示名（projcache 行 → 归属 agent 名（身份记录优先，见 rowAgentOf）；取不到就退回 preset id / 会话 id）。 */
async function displayNameOf(config, sessionId) {
	const row = await readLiveSession(config, sessionId).catch(() => null);
	const preset = row?.row?.presetId;
	if (!preset) {
		return sessionId;
	}
	const scan = await scanAgents(agentsRootOf(config)).catch(() => null);
	return rowAgentOf(row.row, scan?.agents)?.name ?? preset;
}

/**
 * 装回传监听。返回 dispose。
 * @param ctx 顶层角色的上下文（事件总线）
 * @param config 本行 config（名字解析走数据根/dshHome 链；outbox 写穿也走它）
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
		/* ★ 2026-11-10：`kind:'im'` 也必须在这里回收（见文件头）。 */
		const pending = outboxPendingFor(session.id).filter(e => e.kind === 'relay' || e.kind === 'im');
		if (pending.length === 0) {
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
		const answered = new Set(hits.map(m => m.id));
		const matched = pending.filter(p => answered.has(p.messageId));
		/** 只有真正投递出去的 messageId 才 resolve；失败标 unknown，绝不静默删。 */
		const delivered = [];

		/* ① relay：答复 followup 回发送方会话（既有行为逐字保留）。 */
		const relayEntries = matched.filter(e => e.kind === 'relay');
		if (relayEntries.length) {
			const final = finalAssistantText(events);
			const responderName = await displayNameOf(config, session.id);
			for (const entry of relayEntries) {
				// 回传消息：回传**不登记 pending** ⇒ 对方的下一回合不会再触发回传（结构上断掉 ping-pong ✓）
				const resolvedPayload = {
					text: replyText({ responderName, responderSessionId: session.id, final }),
					source: { kind: AGENT_REPLY_KIND, from: session.id, to: entry.from, inReplyTo: entry.messageId, hop: entry.hop },
				};
				const sender = entry.from ? state.agents?.get?.(entry.from) : undefined;
				if (!sender || typeof sender.followup !== 'function') {
					// 投递失败 ⇒ unknown-outcome（不删不自动重发 ✓；此前是 warn 后被回收删掉 = 静默丢 ✗）
					console.warn(`[vssaros-agents] 回传投递失败（发送方会话不在运行）：${entry.from ?? '(无 id)'} ⇒ 标 unknown-outcome`);
					outboxMarkUnknown(config, session.id, entry.messageId, resolvedPayload, '投递时发送方会话不在运行');
					continue;
				}
				sender.followup({
					id: randomUUID(),
					role: 'user',
					content: [{ type: 'text', text: resolvedPayload.text }],
					source: resolvedPayload.source,
				});
				delivered.push(entry.messageId);
			}
		}

		/* ② im：把最终答复（带图）推回该绑定对应的 IM 会话。
		   ★ 2026-11-10：一个回合**只投一次**。Host 重启后 `seenSeq` 归零，
		     `snapshotEvents(0, to)` 会返回整个历史，`findOurSplices` 可能同时命中多条
		     历史 im pending（例如上一条没回的 Test）。逐条投递会把同一份最终答复推 N 次
		     （真机：飞书收到两条重复消息）。⇒ 以本回合最后消费的那条为准投一次，
		     其余命中的条目一并回收，既不重复推、也不留到下次再被全量窗口命中。 */
		const imEntries = matched.filter(e => e.kind === 'im');
		if (imEntries.length) {
			const lastHitId = hits[hits.length - 1]?.id;
			const target = imEntries.find(e => e.messageId === lastHitId) ?? imEntries[imEntries.length - 1];
			const stale = imEntries.filter(e => e !== target);
			const content = finalAssistantContent(events);
			const hub = state.bindingHub;
			if (!hub || typeof hub.deliverForEntry !== 'function') {
				console.warn(`[vssaros-agents] IM 回复回收失败：bindingHub 未就绪（会话 ${session.id}）`);
			} else if (!content) {
				const why = '回合没有最终答复（assistant 无文本/图片产出）';
				console.warn(`[vssaros-agents] IM 回复回收跳过：${why}（会话 ${session.id}）`);
				for (const entry of imEntries) {
					outboxMarkUnknown(config, session.id, entry.messageId,
						{ kind: 'im', bindingId: entry.bindingId }, why);
				}
			} else {
				let r;
				try {
					r = await hub.deliverForEntry(target, content.text, content.images);
				} catch (e) {
					r = { ok: false, error: String(e?.message ?? e) };
				}
				if (r?.ok) {
					delivered.push(target.messageId, ...stale.map(e => e.messageId));
				} else {
					const why = String(r?.error || r?.reason || '未知原因');
					console.warn(`[vssaros-agents] IM 回复投递失败（绑定 ${target.bindingId ?? ''}）：${why}`);
					outboxMarkUnknown(config, session.id, target.messageId,
						{ kind: 'im', bindingId: target.bindingId, text: content.text, images: content.images }, why);
					for (const entry of stale) {
						outboxMarkUnknown(config, session.id, entry.messageId,
							{ kind: 'im', bindingId: entry.bindingId },
							'同回合已有另一条 IM 消息触发答复，本条不重复投递');
					}
				}
			}
		}

		// 只回收成功投递的（unknown 条目 status 已不是 pending ⇒ resolve 本来就删不动它 ✓）
		if (delivered.length) {
			outboxResolve(config, session.id, delivered);
		}
	});
}
