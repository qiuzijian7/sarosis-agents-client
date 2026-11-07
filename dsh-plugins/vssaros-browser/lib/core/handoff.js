/**
 * 人机交接（2026-11-07，P1 · 对齐 DS Bot 的 browser_handoff / browser_resume）。
 *
 * 模型遇到登录墙、验证码、扫码、付款这类**必须由人来做**的事，调 `browser(op:"handoff", text:"…")`：
 * 记一张交接卡（右栏「浏览器」页签里显示「接管 / 我完成了 / 停止」），**立刻返回**（不阻塞一个工具调用等人几分钟）。
 * 人点完以后，模型调 `browser(op:"resume")` 读结果：
 *   · 还没点（`pending` / `taken`）⇒ 如实说「用户还在处理」；
 *   · `done` ⇒ 交接结束，可以继续（先 snapshot 看清现状）；
 *   · `stopped` ⇒ 用户叫停：这次 resume 把它确认掉，模型该停下来告诉用户，而不是继续操作。
 * 交接未结束（`pending` / `taken`，或叫停后还没 resume）时，**这个会话的动作类调用一律拒绝** ——
 * 避免模型和人同时在一页上点（只读的 snapshot / screenshot 照常）。
 *
 * 状态只在 Host 进程内（不落盘）：Host 重启后页面状态本来也要重新看；会话结束时清掉它名下的卡。
 */

import { randomUUID } from 'node:crypto';

/** 卡片的状态。 */
export const HANDOFF_STATES = Object.freeze(['pending', 'taken', 'done', 'stopped']);
/** 人在卡片上能做的事 → 状态。 */
const ACTIONS = Object.freeze({ takeover: 'taken', done: 'done', stop: 'stopped' });
/** 列表里最多保留的已结束卡片（给人看最近发生了什么）。 */
const KEEP_FINISHED = 10;

export function createHandoffs(now = () => Date.now()) {
	/** id → card */
	const cards = new Map();
	/** 开卡顺序（同一毫秒开的两张卡也分得出新旧）。 */
	let seq = 0;
	const open = card => card.state === 'pending' || card.state === 'taken' || (card.state === 'stopped' && !card.acknowledged);
	const newest = (a, b) => b.seq - a.seq;
	const latestOf = session => [...cards.values()].filter(card => card.session === session).sort(newest)[0];
	const prune = () => {
		const finished = [...cards.values()].filter(card => !open(card)).sort(newest);
		for (const card of finished.slice(KEEP_FINISHED)) { cards.delete(card.id); }
	};
	return {
		/** 开一张卡（同会话还没结束的旧卡被它取代：模型换了要求）。 */
		open({ session, reason, url = '', kind = 'handoff' }) {
			for (const card of cards.values()) {
				if (card.session === session && (card.state === 'pending' || card.state === 'taken')) {
					card.state = 'stopped'; card.acknowledged = true; card.note = '被新的交接取代';
				}
			}
			const card = { id: randomUUID(), session, reason: String(reason ?? '').trim().slice(0, 400), url: String(url ?? '').slice(0, 500),
				kind, state: 'pending', at: now(), updatedAt: now(), acknowledged: false, seq: ++seq };
			cards.set(card.id, card);
			prune();
			return { ...card };
		},
		/** 人在卡片上点了一下。@returns 更新后的卡；不认识 / 已结束 ⇒ undefined */
		act(id, action) {
			const card = cards.get(id);
			const state = ACTIONS[action];
			if (!card || !state || card.state === 'done' || card.state === 'stopped') { return undefined; }
			card.state = state;
			card.updatedAt = now();
			return { ...card };
		},
		/** 模型来读结果：`done` / `stopped` 被确认（之后不再挡动作）。 */
		resume(session) {
			const card = latestOf(session);
			if (!card) { return undefined; }
			if (card.state === 'done' || card.state === 'stopped') { card.acknowledged = true; }
			return { ...card };
		},
		/** 这个会话现在能不能做动作；不能 ⇒ 原因。 */
		blockOf(session) {
			const card = latestOf(session);
			if (!card || !open(card)) { return undefined; }
			if (card.state === 'stopped') {
				return '用户在右栏浏览器的交接卡上点了「停止」：先调 `op: "resume"` 确认，然后停下来告诉用户，不要继续操作页面。';
			}
			return `正在等用户在右栏浏览器里处理（${card.reason || '交接'}，卡片状态：${card.state === 'taken' ? '用户已接管' : '等用户接手'}）`
				+ ' —— 这期间不操作页面。用户点「我完成了」后调 `op: "resume"` 再继续（只读的 snapshot / screenshot 不受影响）。';
		},
		/** 某种交接（如登录）在会话里自行结束了（`login(done:true)` 验过了）。 */
		finish(session, kind) {
			for (const card of cards.values()) {
				if (card.session === session && card.kind === kind && (card.state === 'pending' || card.state === 'taken')) {
					card.state = 'done'; card.acknowledged = true; card.updatedAt = now();
				}
			}
		},
		/** 给右栏页签看的：还没结束的在前，加最近结束的几张。 */
		list() {
			return [...cards.values()].sort((a, b) => Number(open(b)) - Number(open(a)) || newest(a, b))
				.map(card => ({ id: card.id, reason: card.reason, url: card.url, kind: card.kind, state: card.state, at: new Date(card.at).toISOString(), open: open(card) }));
		},
		forget(session) { for (const [id, card] of cards) { if (card.session === session) { cards.delete(id); } } },
	};
}

/** `resume` 的返回文案。 */
export function resumeText(card) {
	if (!card) { return '没有交接要恢复（本会话没有开过 `op: "handoff"`）。'; }
	if (card.state === 'pending') { return `交接还没开始：用户还没在右栏浏览器的卡片上操作（${card.reason}）。等用户回复后再 resume，期间别操作页面。`; }
	if (card.state === 'taken') { return `用户已接管，还在处理（${card.reason}）。等用户点「我完成了」后再 resume。`; }
	if (card.state === 'stopped') { return `用户叫停了这次交接（${card.reason}）${card.note ? `：${card.note}` : ''}。停下来，告诉用户你停在哪里，不要继续操作页面。`; }
	return `用户已完成：${card.reason}。可以继续 —— 先 \`op: "snapshot"\` 看清页面现在的样子（登录后页面通常已经变了）。`;
}
