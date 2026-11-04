// @vssaros/dsh-agents — 进程内的飞书事件总线（2026-11-04）
//
// ── 为什么要它 ──────────────────────────────────────────────────────────────
// 飞书长连接是**集群模式、不广播**：同一应用多条连接，每条消息只随机落到其中一条。
// 所以同一个 Host 里，Bots 和别的插件（比如 dsh-superagent 的飞书来源）想收同一个应用的消息时，
// 不能各开一条连接，只能**共用 Bots 这一条、在进程内扇出**。
//
// ── 形状（跨插件契约，只增不改）─────────────────────────────────────────────
//   globalThis[Symbol.for('vssaros.feishuEvents')] = {
//     version: 1,
//     active(appId)            → 这个应用此刻是否有一条活着的连接（ready / connecting）
//     subscribe(appId, fn)     → 退订函数；fn(payload) 收到飞书 v2 原始事件 `{ header, event }`
//     provide(appId, stateFn)  → 撤销函数（只给持有连接的一方用）
//     publish(appId, payload)  → 投递给该应用的全部订阅者，返回**成功**投递数（订阅者抛错不影响别人、也不计数）
//   }
//   挂在 globalThis 而不是 import：消费者不必依赖本包，本包 HMR 重载时订阅也不会丢。
//
// ── 边界 ────────────────────────────────────────────────────────────────────
//   · 只在**同一进程**内有效；跨进程仍靠按应用的锁（imFeishuAppLock.js）互斥。
//   · 订阅者拿到的是原始事件（含正文）：同一 Host 里的插件本来就共享进程与凭据文件，没有扩大信任面。
//   · 订阅者必须快：长连接要求 3 秒内处理完，重活请自己排队异步做。

const KEY = Symbol.for('vssaros.feishuEvents');
const ACTIVE = new Set(['ready', 'connecting']);

const idOf = (appId) => String(appId ?? '').trim();

/** 取（或建）进程内总线。`root` 只给单测注入。 */
export function feishuEventBus(root = globalThis) {
	const cur = root[KEY];
	if (cur && cur.version === 1) { return cur; }
	const providers = new Map();
	const subscribers = new Map();
	const bus = {
		version: 1,
		provide(appId, state) {
			const id = idOf(appId);
			if (!id || typeof state !== 'function') { return () => undefined; }
			providers.set(id, state);
			return () => { if (providers.get(id) === state) { providers.delete(id); } };
		},
		active(appId) {
			const state = providers.get(idOf(appId));
			if (!state) { return false; }
			try { return ACTIVE.has(String((state() || {}).status)); } catch { return false; }
		},
		subscribe(appId, fn) {
			const id = idOf(appId);
			if (!id || typeof fn !== 'function') { return () => undefined; }
			let set = subscribers.get(id);
			if (!set) { set = new Set(); subscribers.set(id, set); }
			set.add(fn);
			return () => {
				set.delete(fn);
				if (!set.size && subscribers.get(id) === set) { subscribers.delete(id); }
			};
		},
		publish(appId, payload) {
			const set = subscribers.get(idOf(appId));
			if (!set) { return 0; }
			let delivered = 0;
			for (const fn of [...set]) {
				try {
					const r = fn(payload);
					if (r && typeof r.catch === 'function') { r.catch(() => undefined); }
					delivered += 1;
				} catch { /* 一个订阅者出错不能挡住别人 */ }
			}
			return delivered;
		},
	};
	Object.defineProperty(root, KEY, { value: bus, configurable: true, enumerable: false, writable: false });
	return bus;
}

/** 飞书 v2 事件头里的接收应用（`header.app_id`）。 */
export function appIdOfEvent(payload) {
	return idOf(payload && payload.header && payload.header.app_id);
}
