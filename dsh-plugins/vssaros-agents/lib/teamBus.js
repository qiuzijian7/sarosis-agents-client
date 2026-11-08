// @vssaros/dsh-agents — 进程内的团队总线（2026-11-04，superagent 主管组团 T0）
//
// ── 为什么要它 ──────────────────────────────────────────────────────────────
// dsh-superagent 的主管要「找 bot、把任务派给 bot、等 bot 回报」。bot 名册、开会话、委派台账
// 都在本插件里（lib/assignments.js），所以由本插件提供，superagent 在同一进程里调用。
//
// ── 形状（跨插件契约，只增不改）─────────────────────────────────────────────
//   globalThis[Symbol.for('vssaros.team')] = {
//     version: 1,
//     available()                → 本插件是否已提供实现（Host 启动早期 / 本插件未装时为 false）
//     listBots()                 → Promise<BotCard[]>          名册（不含隐藏 bot）
//     delegate(input)            → Promise<AssignmentView>     开会话 + 投递任务（input 见 lib/team.js）
//     createBot(input)           → Promise<{id,name,preset,file}>  主管建 bot（闸门在调用方）
//     registerExternalBot(spec)  → 撤销函数；登记会话不由本插件管的 bot（如 SuperAgent 主管）
//     unregisterExternalBot(id) / externalBots() / externalBotOf(ref)
//     get(id)                    → Promise<AssignmentView|undefined>
//     cancel(id, reason?)        → Promise<AssignmentView>
//     subscribe(fn)              → 退订函数；fn(AssignmentView) 在委派**结束**（done / cancelled）时调用
//     createGroup(input) / listGroups()  → 2026-11-05 多 bot 群聊（见下面 withGroups）
//     groupState(roomId)         → 2026-11-07 群现在在做什么（SuperAgent 给「由群执行的工单」回写结果用）
//     provide(impl) / publish(view) / provideGroups(impl)   → 只给本插件自己用
//   }
//   挂在 globalThis 而不是 ctx.provide：消费者不必依赖本包；任一方 HMR 重载时订阅都不会丢
//   （订阅表在总线对象上，不在会被重新求值的模块里）。与 feishuEventBus.js 同一做法。

import { presetIdOf } from './core/agents.js';

const KEY = Symbol.for('vssaros.team');
/** 群实现挂在总线对象上（HMR 重载模块也不会丢），以及 createGroup 是否已支持 originTriggerId。 */
const GROUPS_STATE = Symbol.for('vssaros.team.groups.state');
const GROUPS_IDEMPOTENT = Symbol.for('vssaros.team.groups.idempotent');

/**
 * ★ 2026-11-05 群聊（多 bot 群）：`createGroup(input)` / `listGroups()` / `provideGroups(impl)`。
 * 补在已有的总线对象上（HMR 后总线可能是旧模块建的，只增不改）；实现方是 lib/rooms.js。
 *   createGroup({ members, name?, notice?, admin?, mode?, createdBy?, workspaceId?, cwd?, originTriggerId? }) → Promise<RoomView>
 *   listGroups() → Promise<RoomView[]>
 *   ★ 2026-11-05 P0：`originTriggerId`（同一个 SuperAgent trigger）重复调用返回同一个群，不重复建会话。
 */
function withGroups(bus) {
	const state = bus[GROUPS_STATE] ?? { groups: null };
	bus[GROUPS_STATE] = state;
	if (bus[GROUPS_IDEMPOTENT] && typeof bus.createGroup === 'function' && typeof bus.provideGroups === 'function'
		&& typeof bus.groupState === 'function') { return bus; }
	const needGroups = () => {
		if (!state.groups) { throw new Error('VsSaros 群聊还没就绪（Host 正在启动，或没装 @vssaros/dsh-agents）'); }
		return state.groups;
	};
	bus.provideGroups = (next) => {
		if (!next || typeof next.create !== 'function') { return () => undefined; }
		state.groups = next;
		return () => { if (state.groups === next) { state.groups = null; } };
	};
	bus.createGroup = async (input) => {
		const { createdBy, workspaceId, cwd, originTriggerId, triggerId, ...rest } = input ?? {};
		return needGroups().create(rest, { createdBy, workspaceId, cwd,
			originTriggerId: typeof originTriggerId === 'string' && originTriggerId ? originTriggerId
				: typeof triggerId === 'string' && triggerId ? triggerId : undefined });
	};
	bus.listGroups = async () => needGroups().list();
	// ★ 2026-11-07：群现在在做什么（rooms.js `state`）。实现还没就绪 / 太老 ⇒ undefined（调用方下次再问），不抛
	bus.groupState = async (roomId) => {
		const groups = state.groups;
		return groups && typeof groups.state === 'function' ? groups.state(roomId) : undefined;
	};
	Object.defineProperty(bus, GROUPS_IDEMPOTENT, { value: true, configurable: true });
	return bus;
}

/**
 * ★ 2026-11-06 契约修订 2（适配层，superagent v2 第 8 项）：`version` 仍是 1 —— 它是兼容主版本，
 *   老消费者只认 `version === 1`（如 superagent ≤0.1.62），改它就等于把老消费者踢出去，违背「只增不改」。
 *   新能力用 `revision` + `features` 标出，消费者按 `revision >= 2` / `features.includes(...)` 检测：
 *     revision: 2
 *     features: ['delegate', 'externalBots', 'groups', 'presetOf', 'describeBot']
 *     presetOf(botId)      → string                  该 bot 的 dsh preset id（与本插件注册口径同一个函数，消费者不必照抄命名规则）
 *     describeBot(ref)     → Promise<BotDetail|undefined>  名册卡片 + model / preset / 工作区（按 id 或名字）
 *   v1 的方法全部保留、语义不变；delegate / subscribe 在 superagent v2 里已不再使用（契约保留）。
 */
export const TEAM_BUS_REVISION = 2;
export const TEAM_BUS_FEATURES = Object.freeze(['delegate', 'externalBots', 'groups', 'presetOf', 'describeBot']);
function withRevision2(bus) {
	if (bus.revision >= TEAM_BUS_REVISION && typeof bus.presetOf === 'function' && typeof bus.describeBot === 'function') { return bus; }
	const state = bus[GROUPS_STATE] ?? { groups: null };
	bus[GROUPS_STATE] = state;
	bus.revision = TEAM_BUS_REVISION;
	bus.features = TEAM_BUS_FEATURES;
	bus.presetOf = (botId) => presetIdOf(String(botId ?? '').trim());
	bus.describeBot = async (ref) => {
		const describe = bus[DESCRIBE];
		if (typeof describe !== 'function') { throw new Error('VsSaros Bots 还没就绪（Host 正在启动，或没装 @vssaros/dsh-agents）'); }
		return describe(ref);
	};
	/** 只给本插件自己用：提供 describeBot 的实现。 */
	bus.provideDescribe = (fn) => {
		if (typeof fn !== 'function') { return () => undefined; }
		bus[DESCRIBE] = fn;
		return () => { if (bus[DESCRIBE] === fn) { bus[DESCRIBE] = undefined; } };
	};
	return bus;
}
const DESCRIBE = Symbol.for('vssaros.team.describe');

/** 取（或建）进程内团队总线。`root` 只给单测注入。 */
export function teamBus(root = globalThis) {
	const cur = root[KEY];
	if (cur && cur.version === 1) { return withRevision2(withGroups(cur)); }
	let impl = null;
	const subscribers = new Set();
	// ★ 2026-11-04 外部 bot（superagent 主管）：名册只登记它，会话与消息仍由注册方自己管。
	// 登记表挂在总线对象上而不是模块闭包里 —— 任一插件 HMR 重载时登记不会丢。
	const externals = new Map();
	const need = () => {
		if (!impl) { throw new Error('VsSaros Bots 还没就绪（Host 正在启动，或没装 @vssaros/dsh-agents）'); }
		return impl;
	};
	const bus = {
		version: 1,
		available: () => !!impl,
		provide(next) {
			if (!next || typeof next.delegate !== 'function') { return () => undefined; }
			impl = next;
			return () => { if (impl === next) { impl = null; } };
		},
		listBots: async () => need().listBots(),
		delegate: async (input) => need().delegate(input),
		createBot: async (input) => need().createBot(input),
		get: async (id) => need().get(id),
		cancel: async (id, reason) => need().cancel(id, reason),
		subscribe(fn) {
			if (typeof fn !== 'function') { return () => undefined; }
			subscribers.add(fn);
			return () => { subscribers.delete(fn); };
		},
		publish(view) {
			let delivered = 0;
			for (const fn of [...subscribers]) {
				try {
					const r = fn(view);
					if (r && typeof r.catch === 'function') { r.catch(() => undefined); }
					delivered += 1;
				} catch { /* 一个订阅者出错不能挡住别人 */ }
			}
			return delivered;
		},
		/**
		 * 登记一个「外部 bot」：它的会话不归本插件开，消息交给注册方的 onMessage。
		 * 返回撤销函数；同 id 重复登记时后一次顶替前一次，旧撤销函数不会误撤新的。
		 */
		registerExternalBot(spec) {
			const id = String(spec?.id ?? '').trim();
			if (!id || !String(spec?.name ?? '').trim() || typeof spec?.onMessage !== 'function') { return () => undefined; }
			const entry = { ...spec, id, name: String(spec.name).trim(), at: Date.now() };
			externals.set(id, entry);
			return () => { if (externals.get(id) === entry) { externals.delete(id); } };
		},
		unregisterExternalBot(id) { externals.delete(String(id ?? '').trim()); },
		/** 公开视图：不含 onMessage 回调（回调只在同进程内部调用）。 */
		externalBots() {
			return [...externals.values()].map(({ onMessage: _omit, ...view }) => view);
		},
		/** 内部用：按 id 或名字找外部 bot，含 onMessage。 */
		externalBotOf(ref) {
			const key = String(ref ?? '').trim().toLowerCase();
			return [...externals.values()].find(bot => bot.id.toLowerCase() === key || bot.name.toLowerCase() === key);
		},
	};
	Object.defineProperty(root, KEY, { value: bus, configurable: true, enumerable: false, writable: false });
	return withRevision2(withGroups(bus));
}

/** 当前进程里登记的外部 bot（公开视图）。 */
export function externalBots() { return teamBus().externalBots(); }
/** 按 id 或名字找外部 bot（含 onMessage，供同进程的消息路由用）。 */
export function externalBotOf(ref) { return teamBus().externalBotOf(ref); }
/** 花名册 API 的行：外部 bot 没有 .agent.md，也不注册 preset。 */
export function externalBotRow(bot) {
	return {
		id: bot.id, name: bot.name, description: String(bot.description ?? ''), icon: String(bot.icon ?? ''),
		role: String(bot.role ?? '主管'), skills: [], tools: [], color: '#4176e6', model: '', personaBytes: 0,
		presetId: '', registered: true, external: true, source: 'external', live: null,
		// ★ 2026-11-04 superagent v2：主管对话的会话 id（名册点它就该打开这条会话）。
		sessionId: String(bot.session ?? ''),
	};
}
