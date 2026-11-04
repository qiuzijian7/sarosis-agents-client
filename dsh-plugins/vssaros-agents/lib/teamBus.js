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
//     provide(impl) / publish(view)   → 只给本插件自己用
//   }
//   挂在 globalThis 而不是 ctx.provide：消费者不必依赖本包；任一方 HMR 重载时订阅都不会丢
//   （订阅表在总线对象上，不在会被重新求值的模块里）。与 feishuEventBus.js 同一做法。

const KEY = Symbol.for('vssaros.team');

/** 取（或建）进程内团队总线。`root` 只给单测注入。 */
export function teamBus(root = globalThis) {
	const cur = root[KEY];
	if (cur && cur.version === 1) { return cur; }
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
	return bus;
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
	};
}
