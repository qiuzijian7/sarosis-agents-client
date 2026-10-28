// @vssaros/dsh-agents — core/relay（纯函数，零 I/O、零 dsh 依赖）：回复自动回传的提取与判定。
//
// 模型（ds-bot 的 turns.js 同构，v1 收窄版）：
//   ① `agent_message` 发消息时登记一条 pending（消息 id 是唯一锚点）；
//   ② 目标会话的回合结束（`agent/turn-stopping`）时，**先验证这个回合真的消费了我们的消息**
//      （事件窗里要有装着该消息 id 的 `agent/inbox/spliced`——用户自己开的回合不该触发回传 ✗）；
//   ③ 取该回合**最后一条 assistant 文本**回传给发送方；
//   ④ 回传消息的 source 是 `agent-reply`，**不登记 pending** ⇒ 结构上不可能 A→B→A 无限回传 ✓。
//
// 事件形状（dsh-session SessionEventMap）：`{ type, data, seq }`； splice 的 `data.inserted[]` 是完整消息
// （带 id 与 source ✓，人格投影就是这么认的 ✓）；assistant 文本在 `assistant/message` 的
// `data.message.content`（parts 数组，取 text 片段；`interrupted: true` = 回合被打断 ✓）。

/** 触发回传的消息 kind（`agent_message` 写出；relay 只认它）。 */
export const AGENT_MESSAGE_KIND = 'vssaros/agent-message';
/** 回传消息的 kind（与触发不同 ⇒ 回传本身永不触发下一轮回传）。 */
export const AGENT_REPLY_KIND = 'vssaros/agent-reply';

/**
 * 在事件窗里找"装着这些消息 id 的 splice"。
 * @param events `session.snapshotEvents(from, to)` 的产物
 * @param messageIds `Set<string>`
 * @returns 命中的消息数组（带 source；顺序即时间序）
 */
export function findOurSplices(events, messageIds) {
	const hits = [];
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.type !== 'agent/inbox/spliced') {
			continue;
		}
		const inserted = Array.isArray(event.data?.inserted) ? event.data.inserted : [];
		for (const message of inserted) {
			if (message && typeof message.id === 'string' && messageIds.has(message.id)) {
				hits.push(message);
			}
		}
	}
	return hits;
}

/**
 * 取事件窗里**最后一条** assistant 文本（回合的最终答复）。
 * @returns `{ text, interrupted }`；一条文本都没有 ⇒ null（调用方决定怎么如实说）
 */
export function finalAssistantText(events) {
	let found = null;
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.type !== 'assistant/message') {
			continue;
		}
		const content = event.data?.message?.content;
		const text = typeof content === 'string'
			? content.trim()
			: (Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('\n').trim() : '');
		if (text) {
			found = { text, interrupted: event.data?.interrupted === true };
		}
	}
	return found;
}

/**
 * 与 `finalAssistantText` **同源**，但额外收集 `image` part（2026-10-27，出站富媒体）。
 *
 * 为什么另起一个函数而不是改旧的：`finalAssistantText` 被 relay / 群聊 / assignments 共用，
 * 它的返回形状（`{ text, interrupted }`）已经被多处消费；改形状会波及三处调用点，而收益只有一处。
 * ⇒ 新函数返回更宽的形状，谁需要图谁用。
 *
 * ⚠ 图片来自 assistant message 的 content 数组。实测这份 content 里**确实可能**有非 text part
 *   （否则旧函数不需要 `filter(type === 'text')`），但**何时出现**取决于工具是否产出图
 *   （画图 / 截图类工具）。所以这里只做"有就带上"，不假设一定有。
 */
export function finalAssistantContent(events) {
	let found = null;
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.type !== 'assistant/message') {
			continue;
		}
		const content = event.data?.message?.content;
		const parts = Array.isArray(content) ? content : null;
		const text = typeof content === 'string'
			? content.trim()
			: (parts ? parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n').trim() : '');
		const images = parts
			? parts
				.filter((p) => p?.type === 'image' && typeof p.data === 'string' && p.data)
				.map((p) => ({ mediaType: String(p.mediaType ?? ''), data: String(p.data), name: String(p.name ?? '') }))
			: [];
		if (text || images.length) {
			found = { text, images, interrupted: event.data?.interrupted === true };
		}
	}
	return found;
}

/** 回传消息的正文（`[Reply from …]` 头协议，与触发消息的头同族）。 */
export function replyText({ responderName, responderSessionId, final }) {
	const body = final
		? `${final.text}${final.interrupted ? '\n\n（这条回合被打断了，内容可能不完整）' : ''}`
		: '（它的回合结束了，但没有文本产出——可能被工具调用占满或被打断；要追问就再发一条 agent_message）';
	return `[Reply from ${responderName}（会话 ${responderSessionId}）]\n${body}`;
}
