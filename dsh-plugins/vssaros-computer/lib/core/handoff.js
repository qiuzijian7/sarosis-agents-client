// 人机接管 / 交接状态机（P2）。
//
// 三态：idle（Bot 可操作） / pending（Bot 主动交了张卡等人） / user（人在操作，Bot 全拒）。
// ★ 交接期间**不记录**用户打的字、点的位置（对齐 DS Bot 的隐私口径）。
// ★ 控制 op 在闸之前分派，否则「用户在操作」时连交还都做不了。
export const CONTROL_OPS = ['takeover', 'handback', 'handoff', 'resume'];
export const HANDOFF_REASONS = ['login', 'payment', 'captcha', 'confirm', 'other'];
export const HANDOFF_BACK_TEXT = '用户已交还电脑。请先重新观察一遍当前窗口，再继续（DS Bot 同口径：不记录接管期间的输入）。';

export class DesktopHandoffs {
	constructor({ now = () => Date.now() } = {}) {
		this._now = now;
		this._sessions = new Map();
		this._counter = 0;
	}

	_entry(sessionId) {
		const key = String(sessionId ?? 'anonymous');
		let entry = this._sessions.get(key);
		if (!entry) {
			entry = { state: 'idle', at: this._now(), card: undefined, result: undefined };
			this._sessions.set(key, entry);
		}
		return entry;
	}

	stateOf(sessionId) { return this._entry(sessionId).state; }

	/** 用户或 Bot 在 pending/user 态下，所有非控制 op 一律拒绝。 */
	isBlocked(sessionId) { return this._entry(sessionId).state !== 'idle'; }

	blockReason(sessionId) {
		const entry = this._entry(sessionId);
		return entry.state === 'user'
			? '用户正在操作这台电脑（已接管）；所有电脑调用被拒，等用户交还。'
			: `有一张待处理的交接卡（${entry.card?.reason ?? 'other'}）；等用户回答后再继续。`;
	}

	/** 用户点「我来操作」：状态置 user，中止在途由调用方释放租约。 */
	takeover(sessionId) {
		const entry = this._entry(sessionId);
		entry.state = 'user';
		entry.at = this._now();
		entry.card = undefined;
		return { state: entry.state, text: '已交给用户；Bot 的电脑调用已全部暂停。' };
	}

	/** 用户点「交还」：回到 idle，并给 Bot 一条 followup（不记录接管期间输入）。 */
	handback(sessionId) {
		const entry = this._entry(sessionId);
		entry.state = 'idle';
		entry.at = this._now();
		entry.card = undefined;
		entry.result = HANDOFF_BACK_TEXT;
		return { state: entry.state, text: HANDOFF_BACK_TEXT };
	}

	/** Bot 主动交接（登录 / 付款 / 验证码 / 确认 / 其他）。 */
	open({ sessionId, reason = 'other', note = '', url = '' } = {}) {
		const safeReason = HANDOFF_REASONS.includes(reason) ? reason : 'other';
		const entry = this._entry(sessionId);
		entry.state = 'pending';
		entry.at = this._now();
		entry.card = {
			id: `handoff-${++this._counter}`,
			reason: safeReason,
			note: String(note ?? '').slice(0, 500),
			url: String(url ?? '').slice(0, 500),
		};
		entry.result = undefined;
		return { state: entry.state, card: { ...entry.card }, text: `已把「${safeReason}」交给用户；在用户回答前不要操作电脑。` };
	}

	cardOf(sessionId) {
		const card = this._entry(sessionId).card;
		return card ? { ...card } : undefined;
	}

	/** 用户回答卡片：skip / takeover / done。 */
	answer({ sessionId, action = 'skip', note = '' } = {}) {
		const entry = this._entry(sessionId);
		if (entry.state !== 'pending') return { ok: false, error: '当前没有待处理的交接卡' };
		if (action === 'takeover') return { ok: true, ...this.takeover(sessionId) };
		entry.state = 'idle';
		entry.at = this._now();
		entry.card = undefined;
		const text = action === 'done'
			? `用户完成了交接事项${note ? `：${String(note).slice(0, 500)}` : ''}。请先重新观察再继续。`
			: '用户跳过了这次交接。请换一种做法，或先重新观察。';
		entry.result = text;
		return { ok: true, state: 'idle', text };
	}

	/** Bot 调 resume 读结果；没有结果时给一条确定答案，不挂住回合。 */
	resume(sessionId) {
		const entry = this._entry(sessionId);
		if (entry.state !== 'idle') return this.blockReason(sessionId);
		const text = entry.result ?? '没有待读取的交接结果。';
		entry.result = undefined;
		return text;
	}

	/** stop / 回合结束：清掉该会话的卡与 hold，把控制权还给 idle。 */
	reset(sessionId) {
		this._sessions.delete(String(sessionId ?? 'anonymous'));
	}

	get size() { return this._sessions.size; }
}

/** 只做格式校验，供设置页/工具入口复用；LEVELS 仅用于避免误拼档位名。 */
export function validateHandoffReason(reason) {
	return HANDOFF_REASONS.includes(reason) ? reason : 'other';
}

export function isControlOp(op) {
	return CONTROL_OPS.includes(op);
}
