// 应用授权三态（P1）：拒绝 / 这一次 / 一直允许。
//
// 授权按 **Bot × 应用** 记，换段、进群都不丢（「一直允许」）；「这一次」按会话记。
// 卡片/审批只由人给出，模型无法写状态文件（写入口在插件 Host，不在工具参数里）。
export const GRANT_ALWAYS = 'always';
export const GRANT_ONCE = 'once';
export const GRANT_DENY = 'deny';

/** 应用身份规范化：bundle id / 路径 / 名称统一成一个键。 */
export function appKeyOf(nameOrPath) {
	return String(nameOrPath ?? '').trim().toLowerCase()
		.replace(/\\/g, '/')
		.replace(/\/+$/, '')
		.split('/').at(-1) ?? '';
}

const onceKey = (botId, sessionId, appKey) => `${botId}|${sessionId}|${appKey}`;

/** @returns 'always' | 'once' | 'deny' | null（null = 需要问人） */
export function grantOf(state, botId, appKey, sessionId = '') {
	const key = appKeyOf(appKey);
	if (!key) return null;
	if (state?.grants?.[botId]?.[key]) return GRANT_ALWAYS;
	const once = state?.once?.[onceKey(botId, sessionId, key)];
	return once === GRANT_ONCE || once === GRANT_DENY ? once : null;
}

/** 写入一个授权决定；返回新状态（原地修改传入对象，调用方负责落盘）。 */
export function applyGrant(state, botId, appKey, decision, sessionId = '') {
	const target = state ?? { version: 1, levels: {}, grants: {}, once: {} };
	target.grants ??= {};
	target.once ??= {};
	const key = appKeyOf(appKey);
	if (!key) return target;
	if (decision === GRANT_ALWAYS) {
		(target.grants[botId] ??= {})[key] = { name: String(appKey), grantedAt: new Date().toISOString() };
		delete target.once[onceKey(botId, sessionId, key)];
	} else if (decision === GRANT_ONCE || decision === GRANT_DENY) {
		target.once[onceKey(botId, sessionId, key)] = decision;
	}
	return target;
}

/** 撤销「一直允许」：同时清掉该 Bot 对此应用的所有 once 记录，并中止在途操作由调用方处理。 */
export function revokeGrant(state, botId, appKey) {
	const key = appKeyOf(appKey);
	if (state?.grants?.[botId]) delete state.grants[botId][key];
	if (state?.once) {
		for (const key0 of Object.keys(state.once)) {
			if (key0.startsWith(`${botId}|`) && key0.endsWith(`|${key}`)) delete state.once[key0];
		}
	}
	return state;
}

export function listGrants(state, botId) {
	return Object.entries(state?.grants?.[botId] ?? {}).map(([key, value]) => ({ appKey: key, ...value }));
}
