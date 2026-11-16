// 动作类调用的「结果未知」记账 + 按 callId 幂等（2026-11-11 收口）。
//
// 纪律对齐 vssaros-browser/lib/core/riskGate.js 的 createOutcomeLedger：
//   ① 检查必须在所有校验 / 审批 / 记账之前 —— 否则重放会先过闸、再问人、甚至重复注入；
//   ② 动作已发出但拿不到结果 ⇒ 记 unknown，任何重放一律拒，直到一次成功的观察；
//   ③ 同一 callId 已成功 ⇒ 直接复用缓存结果，绝不再打中继。
//
// ★ 账本是插件实例级、安全方向偏保守：一次结果未知会挡住后续所有动作类调用，
//   直到有人成功观察（screenshot / listWindows ...）。多会话共用实例时宁可多挡一次。

export const UNKNOWN_NOTICE = '结果未知：上一次动作已发出但没拿到确认。禁止重放；请先 screenshot / listWindows 观察，再决定下一步。';
export const INFLIGHT_NOTICE = '同一个调用仍在执行，拒绝重复注入。';
export const DUPLICATE_NOTICE = '重复调用（相同 callId）：复用上次结果，不会再次注入。';

/** 纯 JS 哈希，避免为一个参数指纹引入任何依赖。 */
function fingerprint(value) {
	let text;
	try { text = JSON.stringify(value ?? null); } catch { text = String(value); }
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/** 无 callId 时退化成「身份 + op + 参数」指纹，保证仍有去重能力。 */
export function callKeyOf(exec, args, botId = '', sessionId = '') {
	const callId = String(exec?.callId ?? exec?.id ?? '').trim();
	if (callId) return `call:${callId}`;
	// ★ appKey 必须进指纹：否则「对 Notes 点击」与「对 VsSaros 点击」会算同一个调用，
	//   后者的受保护应用校验会被缓存结果绕过。
	const appKey = String(args?.appKey ?? args?.params?.appKey ?? '');
	return `fp:${botId}|${sessionId}|${String(args?.op ?? '')}|${appKey}|${fingerprint(args?.params ?? {})}`;
}

export function createOutcomeLedger() {
	const entries = new Map();
	let unknownPending = false;
	return {
		/** @returns {{ok:true}|{ok:false, notice:string, cached?:unknown}} */
		begin(key) {
			if (unknownPending) return { ok: false, notice: UNKNOWN_NOTICE };
			const prior = entries.get(key);
			if (prior?.state === 'inflight') return { ok: false, notice: INFLIGHT_NOTICE };
			if (prior?.state === 'ok') return { ok: false, notice: DUPLICATE_NOTICE, cached: prior.result };
			if (prior?.state === 'unknown') return { ok: false, notice: UNKNOWN_NOTICE };
			entries.set(key, { state: 'inflight' });
			return { ok: true };
		},
		/** outcome: 'ok' | 'unknown' */
		settle(key, outcome, result) {
			entries.set(key, { state: outcome, result });
			if (outcome === 'unknown') unknownPending = true;
		},
		/** 明确被闸拒绝（动作根本没发出）⇒ 不留 inflight，允许改参数重试。 */
		abort(key) { entries.delete(key); },
		/** 观察类成功 ⇒ 解除全局重放闸。观察失败不解除。 */
		observe() { unknownPending = false; },
		get pending() { return unknownPending; },
		size() { return entries.size; },
		clear() { entries.clear(); unknownPending = false; },
	};
}
