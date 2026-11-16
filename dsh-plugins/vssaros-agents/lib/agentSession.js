// @vssaros/dsh-agents — "给某个 agent 找一条活会话，没有就现开一条"。
//
// ★ 2026-11-03 从 groups.js 抽出来：群聊下线后，唯一还需要这个能力的调用方是 **IM 渠道派发**
//   （`bindings.js` 的 dispatchAgent → 每条绑定固定一条会话）。与群无关 ⇒ 先搬家再删群。
//   原版还带"群内成员会话绑定"（`group.memberSessions`），那部分随群一起删掉了。

import { presetIdOf } from './core/agents.js';
import { rowBelongsTo } from './core/live.js';
import { dataRootOf } from './store.js';

function httpError(status, message) {
	const e = new Error(message);
	e.httpStatus = status;
	e.status = status;
	return e;
}

/**
 * ★ 2026-11-14（真机：飞书发消息给「知识库专家」，会话卡在 running、侧栏找不到该会话）：
 *   IM 入站没有 cwd ⇒ 旧版 `sc.create({ agentPreset })` 建的会话**不进工作区账本**
 *   （`workspace.sessionIds`），而 chat-surface 的 `buildSidebar` 只按账本出行
 *   ⇒ 这条会话永远不出现在「会话」列表里，页签角标却会数到它。
 *
 * 口径照 `rooms.js` 的 placeOf：优先挂到第一个已登记工作区（不盲建）；
 * 一个工作区都没有时按数据根 `create(cwd)` 兜底（ensure 幂等），再不行退 `{ cwd }`。
 * ⚠ `workspaceId` 与 `cwd` 互斥（官方 session.create 两个都给会 400，见 index.js 的 /api/session）。
 * 纯函数（deps 注入 reg）⇒ 守卫可直接断言。
 */
export async function imSessionPlaceOf(config, reg) {
	if (reg && typeof reg.list === 'function') {
		try {
			const first = reg.list().find(ws => ws && ws.id);
			if (first) { return { workspaceId: first.id }; }
		} catch { /* 读不到就往下兜底 */ }
	}
	const cwd = dataRootOf(config);
	if (reg && typeof reg.create === 'function') {
		try {
			const ws = await reg.create(cwd);
			if (ws && ws.id) { return { workspaceId: ws.id }; }
		} catch { /* 建不出来退 cwd */ }
	}
	return { cwd };
}

/**
 * 把会话挂进工作区账本（幂等、尽力而为）。
 * `sc.create({ workspaceId })` 正常会自动 attach；这里做一次显式兜底，
 * 覆盖「宿主版本不自动挂」与「复用旧会话但从来没挂过」两种情况。
 * 失败绝不阻断 IM 派发。
 */
export async function attachImSessionToWorkspace(reg, workspaceId, sessionId) {
	if (!reg || !workspaceId || !sessionId) { return false; }
	try {
		let ws = typeof reg.get === 'function' ? reg.get(workspaceId) : null;
		if (!ws && typeof reg.list === 'function') {
			ws = reg.list().find(w => w && w.id === workspaceId) || null;
		}
		if (!ws || typeof ws.attachSession !== 'function') { return false; }
		const ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
		if (ids.includes(sessionId)) { return true; }   // 已挂 ⇒ 不重复登记
		await ws.attachSession(sessionId);
		return true;
	} catch { return false; }
}

/**
 * 找 `agent` 的活会话：projcache 里**最近活跃**的那条 ∩ 运行注册表；都没有就新建一条。
 * @returns `{ sessionId, created }`
 */
export async function ensureAgentSession(config, state, agent) {
	const live = state?.agents;
	const { readLiveSessions } = await import('./live.js');
	const liveRows = await readLiveSessions(config).catch(() => null);
	const liveIds = new Set((live?.roots?.() ?? []).map(a => a?.session?.id ?? a?.id).filter(Boolean));
	const reg = state?.workspaceRegistry;

	const candidate = (liveRows?.rows ?? [])
		.filter(r => rowBelongsTo(r, agent.id) && liveIds.has(r.id))
		.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0];
	if (candidate) {
		// ★ 复用旧会话也要补挂（历史遗留的孤儿会话此前从未进过账本）
		if (reg && typeof reg.list === 'function') {
			try {
				const first = reg.list().find(ws => ws && ws.id);
				if (first) { await attachImSessionToWorkspace(reg, first.id, candidate.id); }
			} catch { /* 尽力而为 */ }
		}
		return { sessionId: candidate.id, created: false };
	}
	const sc = state?.sessionController;
	if (typeof sc?.create !== 'function') {
		throw httpError(503, '没有 sessionController 服务，开不了会话（dsh 版本不匹配？）。');
	}
	const place = await imSessionPlaceOf(config, reg);
	const created = await sc.create({ ...place, agentPreset: presetIdOf(agent.id) });
	const sessionId = String(created?.sessionId ?? '').trim();
	if (!sessionId) {
		throw httpError(500, `给 ${agent.name} 开会话：创建成功但没回 sessionId。`);
	}
	if (place.workspaceId) {
		await attachImSessionToWorkspace(reg, place.workspaceId, sessionId);
	}
	return { sessionId, created: true };
}
