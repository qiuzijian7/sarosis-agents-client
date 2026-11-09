// @vssaros/dsh-agents — 多个飞书应用的入站长连接（2026-11-04）
//
// 一个客户端里不同 bot 可以用不同的飞书应用：每个应用一条长连接、一把锁（imFeishuAppLock.js），
// 收到的消息打上应用标记再交给绑定路由（bindings.js 按 (飞书应用, chatId) 匹配）。
//
// ── 键 ──────────────────────────────────────────────────────────────────────
//   `''`   = 默认应用（`accounts.feishu`，沿用原来的 `state.feishuInbound` 网关，行为不变）
//   appId  = 额外应用（`accounts.feishuApps[appId]`，按需建网关）
//   传进来的 appId 等于当前默认应用时一律归到 `''` —— 否则同一进程会对同一应用连两次
//   （同进程的锁不互斥），正是"事件被抢走一半"的那种故障。
//
// ── 两个容易踩的坑（网关本身的语义）───────────────────────────────────────────
//   · `gateway.start()` **不抛错**：连不上只把 `status` 记成 error 并自己重试；
//     不可恢复（unavailable：缺凭据/缺依赖）时直接停 ⇒ 那种情况要把锁放掉，别白占着；
//   · 对已在连的网关再 `start()` 会**再开一条连接** ⇒ ready/connecting 时直接返回当前状态。

const ACTIVE = new Set(['ready', 'connecting']);

function conflict(message) {
	return Object.assign(new Error(message), { httpStatus: 409 });
}

export function createFeishuAppInbounds({
	defaultGateway, makeGateway, resolveDefaultAppId, acquire, describeHolder = (h) => `pid ${h && h.pid}`,
	dataRoot = () => '', log = () => undefined, bus = null,
} = {}) {
	const extras = new Map();
	const locks = new Map();
	/* 2026-11-04：连接期间把它登记为该应用的提供方（feishuEventBus.js），同进程订阅者据此改为共用这条连接 */
	const provided = new Map();
	/** 默认网关当前连的是哪个应用（默认网关的原始事件没带键，index.js 用它兜底 header.app_id）。 */
	let defaultAppId = '';

	const note = (level, msg) => { try { log(level, msg); } catch { /* 忽略 */ } };
	const defaultApp = async () => String(await Promise.resolve(resolveDefaultAppId()).catch(() => '') || '').trim();

	/** 归一：等于默认应用的 appId ⇒ `''`。 */
	async function keyOf(appId) {
		const id = String(appId ?? '').trim();
		const def = await defaultApp();
		return !id || id === def ? '' : id;
	}

	function gatewayOf(key) {
		if (!key) { return defaultGateway; }
		let gw = extras.get(key);
		if (!gw) {
			gw = makeGateway(key);
			extras.set(key, gw);
		}
		return gw;
	}

	async function releaseKey(key) {
		const withdraw = provided.get(key);
		provided.delete(key);
		if (withdraw) { try { withdraw(); } catch { /* 忽略 */ } }
		const lock = locks.get(key);
		locks.delete(key);
		if (lock) { await lock.release().catch(() => undefined); }
	}

	function provide(key, actual, gw) {
		if (!bus || !actual || provided.has(key)) { return; }
		provided.set(key, bus.provide(actual, () => gw.state()));
	}

	async function start(appId) {
		const key = await keyOf(appId);
		const def = await defaultApp();
		const actual = key || def;
		/* ★ 2026-11-09：先判活、**再抢锁**、最后才建网关 —— 原来 `gatewayOf()` 在抢锁前
		   就把一个 idle 网关写进 extras，锁被占（409）时这个网关永远不会被清理。 */
		const existing = key ? extras.get(key) : defaultGateway;
		if (existing && ACTIVE.has(existing.state().status)) { return existing.state(); }
		/* 默认应用刚好也作为额外应用在跑（用户把默认应用换成了某个额外应用）⇒ 不能再连一条 */
		if (!key && actual && extras.has(actual) && ACTIVE.has(extras.get(actual).state().status)) {
			throw conflict(`飞书应用 ${actual} 已作为额外应用在接收消息：先停掉它，再启动默认应用的入站`);
		}
		if (actual && !locks.has(key)) {
			const lock = await acquire(actual, { isDefault: !key, dataRoot: dataRoot() });
			if (!lock || !lock.ok) {
				throw conflict(describeHolder((lock && lock.holder) || { appId: actual }));
			}
			locks.set(key, lock);
		}
		const gw = gatewayOf(key);
		try {
			await gw.start();
		} catch (e) {
			/* start 抛异常时别把锁白占着（原实现只在 unavailable 状态才放锁）。 */
			await releaseKey(key);
			throw e;
		}
		const after = gw.state();
		if (after.status === 'error' && /^unavailable/.test(String(after.lastError || ''))) {
			/* 不可恢复 ⇒ 网关已自停；锁放掉，别挡着另一个能连上的实例 */
			await releaseKey(key);
		} else {
			if (!key) { defaultAppId = actual; }
			provide(key, actual, gw);
		}
		note('info', `飞书入站（${key ? '应用 ' + key : '默认应用'}）：${after.status}`);
		return after;
	}

	async function stop(appId) {
		const id = String(appId ?? '').trim();
		const key = await keyOf(id);
		/* 默认应用被换过之后，连接可能是用旧 id 建的 ⇒ 两个键都试着停、都放锁。 */
		let gw = key ? extras.get(key) : defaultGateway;
		if (!gw && id) { gw = extras.get(id); }
		if (gw) { await gw.stop(); }
		await releaseKey(key);
		if (id && id !== key) { await releaseKey(id); }
		return gw ? gw.state() : null;
	}

	/**
	 * 删掉一个额外应用时调用：停连接、放锁、丢网关。
	 *
	 * ★ 2026-11-09：`keyOf()` 每次读实时默认应用 ⇒ 默认应用被换过之后，连接建立时用的键
	 *   与现在归一出来的键可能不同。这里把「原始 id」和「归一后的键」都清一遍，
	 *   否则会留下一条还在跑的 WS 和一把永远不释放的锁。
	 */
	async function forget(appId) {
		const id = String(appId ?? '').trim();
		const key = await keyOf(id);
		for (const k of new Set([id, key].filter(Boolean))) {
			const gw = extras.get(k);
			if (gw) { await gw.stop().catch(() => undefined); }
			extras.delete(k);
			await releaseKey(k);
		}
	}

	return {
		keyOf,
		start,
		stop,
		forget,
		/** `{ [appId]: state }`（只含已建过网关的额外应用）。 */
		appStates() {
			return Object.fromEntries([...extras].map(([id, gw]) => [id, gw.state()]));
		},
		/** 默认网关最近一次连上的应用（没连过 = 空）。 */
		defaultAppId() { return defaultAppId; },
		/** 仅测试：某个键是否持锁。 */
		holds(key) { return locks.has(String(key ?? '')); },
	};
}
