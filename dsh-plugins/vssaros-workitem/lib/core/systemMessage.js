// 真源：**回环闸门** —— loop 把结果发进群之后，那条消息**绝不能**再触发一次派发。
//
// 事故链（不做闸门就会发生）：
//   loop 收尾 → 通知进群（"bug/1234 已修复"）
//   → 群聊 @ 解析/派发逻辑把这条当新消息 → 派给成员 → 成员回一句 → 又进 transcript
//   → 又被派发 …… 几十轮就把额度烧干净，而日志里全是"正常对话"。
//
// 纪律（与 `vssaros-agents/lib/channelPolicy.js` 的"发送者白名单在 mention 之前检查"同款）：
//   **判来源必须发生在 @ 解析之前**。先解析 @ 再判来源，等于闸门装在下游，照样漏。

/** 系统（非人、非成员）发出的消息标识。 */
export const SYSTEM_KIND = 'system';

/**
 * 这条消息是不是系统消息（因此**不参与** @ 解析与派发）。
 * 三个判据任一成立即算：显式 `kind`、显式 `sender`、或来源是 loop。
 */
export function isSystemMessage(msg) {
	if (!msg || typeof msg !== 'object') {
		return false;
	}
	return msg.kind === SYSTEM_KIND
		|| msg.sender === SYSTEM_KIND
		|| msg.source === 'loop'
		|| msg.system === true;
}

/**
 * loop 通知 → 群聊的载荷。
 *
 * ⚠ 只带"结论 + 出处"，**不带指令**：系统消息若长得像任务，成员模型会把它当活接过去
 * （那就是回环的另一半）。要不要变成一件活，由人自己在群里发 `#task:<key>` 重新标记 ✓。
 */
export function notifyPayload({ loopName = '', key = '', status = '', reason = '', text = '', url = '' } = {}) {
	return {
		kind: SYSTEM_KIND,
		source: 'loop',
		sender: SYSTEM_KIND,
		ts: Date.now(),
		loopName,
		key,
		status,
		reason,
		text: String(text ?? '').slice(0, 4000),
		...(url ? { url } : {}),
	};
}

/** 渲染成群里的一行文本（系统消息也要能读，但**不带 @ 名** ⇒ 不会被 @ 解析命中）。 */
export function renderNotify(payload) {
	const head = payload?.loopName ? `[${payload.loopName}] ` : '';
	const tail = payload?.key ? `　(${payload.key})` : '';
	const outcome = payload?.status ? `${payload.status}${payload?.reason ? `：${payload.reason}` : ''}` : '';
	return `${head}${outcome}${tail}${payload?.text ? `\n${payload.text}` : ''}`;
}
