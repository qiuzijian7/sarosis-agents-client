// 真源：窗口预算（防"风暴"）—— 群聊里 bot 互相触发、或 loop 通知回群又触发派发，
// 都能在几十秒内把额度打爆。这是 loop 侧**没有**而群聊侧必须有的护栏。
//
// 默认值对齐 `vssaros-agents/lib/channelPolicy.js` 的 `LOOP_DEFAULTS`（同一量级，
// 同一条纪律：默认给一个保守值，别让空配置变成"不限"）。

export const BUDGET_DEFAULTS = { maxEvents: 20, windowMs: 60_000, cooldownMs: 60_000 };

/**
 * 判定这一刻还能不能派发。
 *
 * @param events 历史派发时间戳（ms）数组，调用方自己持久化（群聊可存 ledger 旁、
 *               loop 可存 state.json）
 * @returns `{ allowed, count, retryAfterMs, reason }` —— `allowed=false` 时 `reason` 可直接给人看。
 */
export function budgetVerdict(events, nowMs = Date.now(), budget = BUDGET_DEFAULTS) {
	const maxEvents = Number(budget?.maxEvents ?? BUDGET_DEFAULTS.maxEvents);
	const windowMs = Number(budget?.windowMs ?? BUDGET_DEFAULTS.windowMs);
	const cooldownMs = Number(budget?.cooldownMs ?? BUDGET_DEFAULTS.cooldownMs);
	const list = Array.isArray(events) ? events.filter(at => Number.isFinite(at)) : [];
	const recent = list.filter(at => nowMs - at < windowMs);
	if (recent.length < maxEvents) {
		return { allowed: true, count: recent.length, retryAfterMs: 0, reason: '' };
	}
	// 冷却取"最早一条滚出窗口"与 cooldown 的**较小**者（先到先恢复），最低 1s（别让调用方自旋）。
	const oldestInWindow = Math.min(...recent);
	const untilWindowRolls = oldestInWindow + windowMs - nowMs;
	const wait = Math.max(1000, Math.min(untilWindowRolls, cooldownMs));
	return {
		allowed: false,
		count: recent.length,
		retryAfterMs: wait,
		reason: `budget-exceeded（${windowMs / 1000}s 内已派 ${recent.length} 条，上限 ${maxEvents}；${Math.ceil(wait / 1000)}s 后恢复）`,
	};
}

/** 把已派时间戳裁剪到窗口内（持久化前调用，别让数组无限长）。 */
export function pruneEvents(events, nowMs = Date.now(), budget = BUDGET_DEFAULTS) {
	const windowMs = Number(budget?.windowMs ?? BUDGET_DEFAULTS.windowMs) * 4; // 留 4 倍窗口便于审计
	return (Array.isArray(events) ? events : []).filter(at => Number.isFinite(at) && nowMs - at < windowMs).slice(-200);
}
