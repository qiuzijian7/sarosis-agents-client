// @vssaros/dsh-agents — 按会话设置 bot 模型（2026-11-03，取代 preset 里的 `default-model` 行与 `-assign` 派生 preset）。
//
// ★ 为什么要有这个模块（dsh 0.2.1-rc.2 源码核对）：
//   · preset 里挂 `@deepseek-ai/dsh-agent-default-model` 行只会在 **preset 作用域**提供一个 `agentDefaultModel` 服务，
//     而 API 会话的模型选择（`dsh-api-session-controller` 的 `ApiSessionAgentController.selectionFor`）读的是
//     **host 层**的 `agentDefaultModel`；子代理（`dsh-subagent` 的 `resolveChildAgentOptions`）继承父会话模型。
//     ⇒ preset 里的模型行**没有任何消费方**：`.agent.md` 的 `model:` 与 `model-assignment`（`-assign` 派生 preset）
//       实际从未生效。
//   · 官方的会话级入口是 `session/selectModel`，但它会顺手 `agentDefaultModel.saveSelection()` ——
//     把**全局默认模型**改掉 ✗（开一次委派就改用户的默认模型）。
//   ⇒ 这里走它内部的同一条路、只是不写全局默认：`sessionController.agents.selectForNextRequest(agent, selection)`
//     （追加 `model/selection` 会话事件 + 更新活会话的选择；可从日志重放，composer 的模型 chip 会自动显示它）。
//
// 规则：
//   ① 只在会话**从没选过、也从没发过请求**时应用（`modelSelection` 投影 `pending === null && lastUsed === null`）
//      ⇒ 用户在 composer 里换过模型、或老会话已经跑过 ⇒ 一律不碰。
//   ② 子代理会话不碰（官方语义：子代理继承父会话模型）。
//   ③ 校验与官方 selectModel 同口径（`commands.requireModel` + `llm.resolveCallConfig`）；不可用 ⇒ 不选（跟随默认）+ 记日志。
//   ④ 校验结果按 route 缓存 ⇒ `agent/created` 里能**同步**选上（避免"建会话后立刻 steer"的调用方抢在选择之前装配第一步）。

import { modelRouteOf } from './core/agents.js';

/** agentId → `{ main?: route, assign?: route }`（route = `{ provider, model }`）。模块级：本包会被挂多次，闭包会裂。 */
const AGENT_MODEL_ROUTES = new Map();

/** `provider/model` → 校验通过的选择（`{ provider, model, reasoningEffort? }`）。**只缓存成功**：
 *  provider 清单由 IDE 在启动后才同步进来，早期失败不能当成永久结论。 */
const RESOLVED = new Map();

/** `provider/model` → 上次告警时间（失败日志限流，避免每建一个会话刷一条）。 */
const WARNED_AT = new Map();
const WARN_INTERVAL_MS = 60_000;

const routeKey = (route) => `${route.provider}/${route.model}`;

/**
 * 每次扫描后刷新路由表（纯同步）。
 * @param agents 扫描出的 agent
 * @param provider `config.defaultProvider`
 */
export function setAgentModelRoutes(agents, provider) {
	AGENT_MODEL_ROUTES.clear();
	for (const agent of Array.isArray(agents) ? agents : []) {
		const main = modelRouteOf(agent?.model, provider);
		const assign = modelRouteOf(agent?.modelAssignment, provider);
		if (main || assign) {
			AGENT_MODEL_ROUTES.set(String(agent.id), { ...(main ? { main } : {}), ...(assign ? { assign } : {}) });
		}
	}
}

/** 某个 agent 的路由（`kind` = 'main' | 'assign'；assign 没写就回落 main）。 */
export function agentModelRouteOf(agentId, kind = 'main') {
	const entry = AGENT_MODEL_ROUTES.get(String(agentId ?? ''));
	if (!entry) {
		return undefined;
	}
	return kind === 'assign' ? (entry.assign ?? entry.main) : entry.main;
}

/** 规则 ①：投影状态是不是"从没选过、从没请求过"。拿不到投影 ⇒ 当作不确定 ⇒ false（宁可不选）。 */
export function isBlankModelState(state) {
	return !!state && typeof state === 'object' && state.pending === null && state.lastUsed === null;
}

/** 规则 ②：子代理会话（官方判据同 `hasApiSessionSubagentOwner` 的前半）。 */
export function isSubagentSession(agent) {
	const header = agent?.session?.header;
	return !!header && (header.origin === 'subagent' || header.parentSession !== undefined);
}

function modelStateOf(projections, agent) {
	try {
		return projections?.stateOf?.(agent.session, 'modelSelection');
	} catch {
		return undefined;
	}
}

/**
 * 规则 ③：与官方 selectModel 同口径的校验；成功按 route 缓存。
 * @returns 选择；`null` = 模型不可用；`undefined` = llm 服务没到位（下次再试）
 */
export async function resolveRoute({ sc, llm }, route) {
	const key = routeKey(route);
	if (RESOLVED.has(key)) {
		return RESOLVED.get(key);
	}
	if (typeof llm?.resolveCallConfig !== 'function') {
		return undefined;
	}
	try {
		if (typeof sc?.commands?.requireModel === 'function') {
			await sc.commands.requireModel({ provider: route.provider, model: route.model });
		}
		const resolved = await llm.resolveCallConfig({ provider: route.provider, model: route.model });
		const selected = {
			provider: resolved.provider,
			model: resolved.model,
			...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
		};
		RESOLVED.set(key, selected);
		return selected;
	} catch (error) {
		const now = Date.now();
		if (now - (WARNED_AT.get(key) ?? 0) >= WARN_INTERVAL_MS) {
			WARNED_AT.set(key, now);
			console.warn(`[vssaros-agents] 模型 ${key} 在 dsh 里不可用，相关 bot 会话跟随默认模型（${String(error?.message ?? error).slice(0, 200)}）`);
		}
		return null;
	}
}

/** 扫描后 / llm 到位后预热校验缓存（fire-and-forget；失败不缓存，会话创建时会再试）。 */
export function prevalidateRoutes(deps) {
	const routes = new Map();
	for (const entry of AGENT_MODEL_ROUTES.values()) {
		for (const route of [entry.main, entry.assign]) {
			if (route) { routes.set(routeKey(route), route); }
		}
	}
	return Promise.all([...routes.values()].map(route => resolveRoute(deps, route).catch(() => null)));
}

/** 真正写入（同步）：官方内部入口；不存在 ⇒ false。 */
function commitSelection(sc, agent, selected) {
	const select = sc?.agents?.selectForNextRequest;
	if (typeof select !== 'function') {
		return false;
	}
	select.call(sc.agents, agent, { ...selected });
	return true;
}

/**
 * 给一个活会话选模型。
 * @param deps `{ sc, llm, projections }`（sessionController / llm / sessionProjections）
 * @param agent 活 agent
 * @param route `{ provider, model }`
 * @param options.onlyIfBlank 规则 ①（`agent/created` 用 true；委派显式指定用 false）
 * @returns `{ ok, reason?, selected? }` —— 永不抛
 */
export async function applyModelSelection(deps, agent, route, { onlyIfBlank = true } = {}) {
	try {
		if (!agent?.session || !route) {
			return { ok: false, reason: 'no-agent-or-route' };
		}
		if (isSubagentSession(agent)) {
			return { ok: false, reason: 'subagent' };
		}
		if (typeof deps?.sc?.agents?.selectForNextRequest !== 'function') {
			return { ok: false, reason: 'no-select-api' };
		}
		const blank = () => isBlankModelState(modelStateOf(deps.projections, agent));
		if (onlyIfBlank && !blank()) {
			return { ok: false, reason: 'not-blank' };
		}
		// 命中缓存 ⇒ 同步提交（不跨 await，调用方紧接着 steer 也赶得上第一步装配）
		const key = routeKey(route);
		let selected = RESOLVED.get(key);
		if (selected === undefined) {
			selected = await resolveRoute(deps, route);
			// 跨了 await：别人（委派显式指定 / 用户手选）可能已经选过 ⇒ 重新判
			if (onlyIfBlank && !blank()) {
				return { ok: false, reason: 'not-blank' };
			}
		}
		if (!selected) {
			return { ok: false, reason: selected === null ? 'model-unavailable' : 'llm-missing' };
		}
		return commitSelection(deps.sc, agent, selected) ? { ok: true, selected } : { ok: false, reason: 'no-select-api' };
	} catch (error) {
		return { ok: false, reason: `error: ${String(error?.message ?? error).slice(0, 200)}` };
	}
}

/** 测试用：复位模块状态。 */
export function __resetModelSelection() {
	AGENT_MODEL_ROUTES.clear();
	RESOLVED.clear();
	WARNED_AT.clear();
}
