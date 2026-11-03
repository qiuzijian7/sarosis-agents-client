// @vssaros/dsh-agents — "给某个 agent 找一条活会话，没有就现开一条"。
//
// ★ 2026-11-03 从 groups.js 抽出来：群聊下线后，唯一还需要这个能力的调用方是 **IM 渠道派发**
//   （`bindings.js` 的 dispatchAgent → 每条绑定固定一条会话）。与群无关 ⇒ 先搬家再删群。
//   原版还带"群内成员会话绑定"（`group.memberSessions`），那部分随群一起删掉了。

import { presetIdOf } from './core/agents.js';
import { rowBelongsTo } from './core/live.js';

function httpError(status, message) {
	const e = new Error(message);
	e.httpStatus = status;
	e.status = status;
	return e;
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

	const candidate = (liveRows?.rows ?? [])
		.filter(r => rowBelongsTo(r, agent.id) && liveIds.has(r.id))
		.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0];
	if (candidate) {
		return { sessionId: candidate.id, created: false };
	}
	const sc = state?.sessionController;
	if (typeof sc?.create !== 'function') {
		throw httpError(503, '没有 sessionController 服务，开不了会话（dsh 版本不匹配？）。');
	}
	const created = await sc.create({ agentPreset: presetIdOf(agent.id) });
	const sessionId = String(created?.sessionId ?? '').trim();
	if (!sessionId) {
		throw httpError(500, `给 ${agent.name} 开会话：创建成功但没回 sessionId。`);
	}
	return { sessionId, created: true };
}
