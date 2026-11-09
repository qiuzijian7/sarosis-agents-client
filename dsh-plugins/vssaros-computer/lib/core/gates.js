// P1 完整执行闸（执行前）：档位 → 受保护应用 → 应用授权 → 租约 → 审批。
//
// 顺序即安全优先级：受保护应用**连用户都不能授权**（防 Bot 点自己的审批卡）；
// 审批走官方缝且 fail-closed（只认 'allowed-once'）；租约先占再问，避免两个 Bot
// 同时拿到同一应用的授权。execute 里会再做一次同步校验，防竞态与绕过。
import { classifyOp, gateCall, isProtectedApp } from './levels.js';
import { GRANT_ALWAYS, GRANT_DENY, GRANT_ONCE, appKeyOf, grantOf } from './grants.js';

export function preGate({
	op, level, appKey, state, botId = '', sessionId = '',
	leases, allowBackground = false, handoffs,
}) {
	// P2：用户接管中 / 有未处理的交接卡 ⇒ 连只读都暂停（控制 op 在 index.js 里已提前分派，
	// 不受这条限制，否则用户无法交还）。
	if (handoffs?.isBlocked(sessionId)) {
		return { ok: false, code: -32601, message: handoffs.blockReason(sessionId) };
	}
	const base = gateCall(op, level, { p0ReadOnly: !allowBackground });
	if (!base.ok) return base;
	const kind = classifyOp(op);
	// 只读调用不要授权、不占租约。
	if (kind === 'observe') return { ok: true, kind };

	const key = appKeyOf(appKey);
	if (!key) return { ok: false, code: -32602, message: '动作类调用必须给出目标应用 appKey（先 listWindows）' };
	if (isProtectedApp(key)) {
		return { ok: false, code: -32601, message: `${key} 是受保护应用，用户也不能授权` };
	}
	const grant = grantOf(state, botId, key, sessionId);
	if (grant === GRANT_DENY) {
		return { ok: false, code: -32601, message: `本段对话里已拒绝使用 ${key}` };
	}
	const lease = leases?.acquire(`app:${key}`, botId);
	if (lease && !lease.ok) {
		return { ok: false, code: -32601, message: `${lease.holder} 正在使用 ${key}` };
	}
	// P2：前台动作额外占「前台租约」——同一时间只有一个 Bot 能动可见指针。
	if (kind === 'foreground') {
		const foreground = leases?.acquire('foreground', botId);
		if (foreground && !foreground.ok) {
			return { ok: false, code: -32601, message: `${foreground.holder} 正在使用前台（同一时间只允许一个 Bot）` };
		}
	}
	if (grant === GRANT_ALWAYS || grant === GRANT_ONCE) {
		return { ok: true, kind, appKey: key, lease: true };
	}
	return { ok: true, kind, appKey: key, needsApproval: true, lease: true };
}

/** 官方审批缝；无服务 / 抛错 / 非 'allowed-once' 一律 deny。 */
export async function requestConsent({ approval, exec, appKey, action }) {
	if (!approval || typeof approval.request !== 'function') return GRANT_DENY;
	const reason = `允许 Bot 使用「${appKey}」执行 ${action}？`;
	try {
		const outcome = await approval.request({
			...(exec?.agent !== undefined ? { agent: exec.agent } : {}),
			...(exec?.callId !== undefined ? { callId: exec.callId } : {}),
			...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
			toolName: 'computer',
			reason,
			displayReason: {
				en: `Allow the Bot to use ${appKey} for ${action}?`,
				zh: reason,
			},
		});
		return outcome === 'allowed-once' ? GRANT_ONCE : GRANT_DENY;
	} catch {
		return GRANT_DENY;
	}
}
