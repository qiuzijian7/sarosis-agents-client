/**
 * CDP 的**连接与目标管理**（零依赖纯 JS）——逐条移植自
 * `src/vs/sessions/contrib/agentStudio/common/browserCdp.ts`（`CdpConnection` / `CdpTargetManager` /
 * `formatCdpError`）。那个文件本来就只有"JSON-RPC 关联 + 目标选择决策"，socket 由外部注入 ⇒ 正好可搬。
 *
 * 模型：**浏览器级连接 + `Target.attachToTarget({flatten:true})` 的 sessionId**（不是"每页一条 WS"）——
 * 只有一条连接要维护，关联逻辑只有一份。
 */

import { CDP_COMMAND_TIMEOUT_MS } from './chrome.js';

/** 把 CDP 的 error 载荷转成 Error（保留 code，便于调用方识别 "no such target"）。真源：`browserCdp.ts:448`。 */
export function formatCdpError(method, error) {
	const e = error ?? {};
	const message = typeof e.message === 'string' && e.message ? e.message : JSON.stringify(error ?? null);
	const code = typeof e.code === 'number' ? ` (code ${e.code})` : '';
	return new Error(`CDP ${method} failed${code}: ${message}`);
}

/** 一条 CDP WebSocket 连接 + JSON-RPC 请求关联。真源：`browserCdp.ts:462-565`。 */
export class CdpConnection {
	constructor(socket, logger) {
		this._socket = socket;
		this._logger = logger;
		this._nextId = 1;
		this._pending = new Map();
		this._disposed = false;
		this._onClosed = undefined;

		this._socket.onmessage = event => this._handleMessage(event?.data);
		this._socket.onerror = () => { /* onclose 总会跟着来，统一在那里收尾 */ };
		this._socket.onclose = () => this._handleClose('socket closed');
	}

	/** 注册断线回调（上层据此丢弃缓存并重连）。 */
	onClosed(handler) { this._onClosed = handler; }

	get pendingCount() { return this._pending.size; }

	/** 发一条 CDP 命令（`sessionId` 省略 = 浏览器级命令）。真源：`browserCdp.ts:491`。 */
	send(method, params, sessionId, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
		if (this._disposed) {
			return Promise.reject(new Error(`CDP ${method} failed: connection is disposed`));
		}
		const id = this._nextId++;

		return new Promise((resolve, reject) => {
			// 超时必须自己管：CDP 不会对已发出的命令回错误，页面卡住时请求会永远悬着。
			const timer = setTimeout(() => {
				this._pending.delete(id);
				reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this._pending.set(id, { method, resolve, reject, timer });

			try {
				this._socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
			} catch (err) {
				clearTimeout(timer);
				this._pending.delete(id);
				reject(new Error(`CDP ${method} send failed: ${err instanceof Error ? err.message : String(err)}`));
			}
		});
	}

	dispose() {
		this._handleClose('disposed');
		try { this._socket.close(); } catch { /* 已关闭 */ }
	}

	_handleMessage(raw) {
		let msg;
		try {
			const text = typeof raw === 'string' ? raw : (raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : String(raw));
			msg = JSON.parse(text);
		} catch {
			this._logger?.warn?.('[vssaros-browser] dropped unparseable CDP message');
			return;
		}
		// 事件（有 method、无 id）：当前实现不需要事件，显式忽略而不是当响应处理。
		if (msg?.id === undefined) { return; }

		const pending = this._pending.get(msg.id);
		if (!pending) {
			this._logger?.warn?.(`[vssaros-browser] response for unknown id ${msg.id} (already timed out?)`);
			return;
		}
		this._pending.delete(msg.id);
		clearTimeout(pending.timer);

		if (msg.error !== undefined) {
			pending.reject(formatCdpError(pending.method, msg.error));
			return;
		}
		pending.resolve(msg.result);
	}

	_handleClose(reason) {
		if (this._disposed) { return; }
		this._disposed = true;
		// 断线必须让所有在飞的请求立刻失败：否则调用方会一直等到超时才报错，真正的原因被掩盖。
		for (const [id, pending] of this._pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error(`CDP ${pending.method} aborted: ${reason} (id ${id})`));
		}
		this._pending.clear();
		this._onClosed?.();
	}
}

/**
 * 目标选择/attach/创建/关闭的**决策逻辑**。真源：`browserCdp.ts:239-362`。
 *
 * 三条优先级（越靠前越"不动用户的东西"）：① 已 attach 且仍存在 ② 曾自己创建且仍存活（重新 attach，
 * 否则会**泄漏 tab**）③ URL 匹配 ④ **新建**（记为 owned；抢用现有 tab 会把操作打到用户正在填的表单里）。
 *
 * ## 归属：多会话隔离（2026-10-13）
 *
 * 每条"本工具创建的 tab"额外记一个 **ownerKey**（Host 侧传 dsh 的 `exec.agent.id`，即 **SessionId**；
 * 见 `dsh-agent/lib/types/types.d.ts` 的 `Agent { readonly id: SessionId }`）。
 *
 * **有 ownerKey 时的规则与无 owner 时不同**（这是"多会话同时用 browser 互不影响"的全部依据）：
 *   · 只复用**自己名下**的 tab —— 绝不会落到另一个会话正在操作的页面上；
 *   · **不进** URL 匹配分支 —— 那个分支会"抢用现有 tab"，对单个会话是省事，对多会话就是**串台**；
 *   · 自己名下没有 ⇒ **新建**（多花一个 tab 是本工具正常代价；串台不是）。
 *
 * **无 ownerKey**（IDE 侧旧路径 / 测试 / 诊断）时**保持原有行为**（attach 缓存 → owned → URL 匹配 →
 * 新建）⇒ 本次改动不改变旧路径的语义。`_ownerOf` 用 `''` 表示"无主"，与传空串等价。
 *
 * ⚠ `_sessions`（CDP 的 flatten sessionId 缓存）**与 owner 无关**：那是"attach 关系"的缓存，
 * 一个 target 只有一条 attach sessionId，谁用都一样。别把它误当归属表。
 */
export class CdpTargetManager {
	constructor(conn, logger) {
		this._conn = conn;
		this._logger = logger;
		this._sessions = new Map();
		/** targetId → ownerKey（本工具创建的 tab 归谁；`''` = 无主/旧路径）。`closeOwned` 也只看它。 */
		this._ownerOf = new Map();
	}

	get ownedCount() { return this._ownerOf.size; }

	/** 某个会话名下的 tab 数（诊断 / 守卫用）。 */
	ownedCountOf(ownerKey) {
		const key = typeof ownerKey === 'string' ? ownerKey : '';
		let n = 0;
		for (const owner of this._ownerOf.values()) { if (owner === key) { n++; } }
		return n;
	}

	/** 某个会话名下的**全部** tab id（会话结束时逐个回收；见 `CdpHost.closeSessionPages`）。 */
	ownedTargetsOf(ownerKey) {
		const key = typeof ownerKey === 'string' ? ownerKey : '';
		const ids = [];
		for (const [targetId, owner] of this._ownerOf) { if (owner === key) { ids.push(targetId); } }
		return ids;
	}

	async list() {
		const res = await this._conn.send('Target.getTargets');
		const infos = Array.isArray(res?.targetInfos) ? res.targetInfos : [];
		return infos
			.filter(t => t?.['type'] === 'page' && !String(t?.['url'] ?? '').startsWith('devtools://'))
			.map(t => ({
				targetId: String(t?.['targetId'] ?? ''),
				url: String(t?.['url'] ?? ''),
				title: String(t?.['title'] ?? ''),
				type: String(t?.['type'] ?? ''),
			}))
			.filter(t => !!t.targetId);
	}

	/** 取（或建立）某 target 的 flatten sessionId。 */
	async ensureSession(targetId) {
		const cached = this._sessions.get(targetId);
		if (cached) { return cached; }
		try {
			const res = await this._conn.send('Target.attachToTarget', { targetId, flatten: true });
			const sessionId = res?.sessionId;
			if (!sessionId) { throw new Error('Target.attachToTarget returned no sessionId'); }
			this._sessions.set(targetId, sessionId);
			return sessionId;
		} catch (err) {
			// attach 失败通常意味着 target 已经不在了（用户关了这个 tab）。
			this._sessions.delete(targetId);
			this._ownerOf.delete(targetId);
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(`无法附着到页面 ${targetId}（可能已被关闭）：${detail}`);
		}
	}

	forgetTarget(targetId) {
		this._sessions.delete(targetId);
		this._ownerOf.delete(targetId);
	}

	/** 连接断开时调用：sessionId 全部作废，但"自己创建的 tab"这层记账仍然有效。 */
	clearSessions() { this._sessions.clear(); }

	async ensurePage(url, ownerKey) {
		const key = typeof ownerKey === 'string' ? ownerKey : '';
		const targets = await this.list();

		// ── 有 ownerKey：**只认自己名下的 tab**（多会话隔离，见类头注释）──────────────
		if (key) {
			for (const [targetId, owner] of this._ownerOf) {
				if (owner !== key) { continue; }
				const alive = targets.find(t => t.targetId === targetId);
				if (!alive) {
					// 用户把它关了（或崩溃回收）⇒ 销账后新建，不留死指针。
					this._ownerOf.delete(targetId);
					this._sessions.delete(targetId);
					continue;
				}
				// 连接断开重建后 sessionId 会失效 ⇒ 这里重新 attach（否则下次命令发出去就 "session not found"）。
				const sessionId = await this.ensureSession(targetId);
				return { targetId, sessionId, url: alive.url, owner: key, reused: true };
			}
			return await this._create(url, key);
		}

		// ── 无 ownerKey：保持原有行为（IDE 侧旧路径 / 测试 / 诊断）────────────────────
		// ① 已 attach 的（且仍存在）。
		for (const [targetId, sessionId] of this._sessions) {
			const alive = targets.find(t => t.targetId === targetId);
			if (alive) { return { targetId, sessionId, url: alive.url }; }
			this._sessions.delete(targetId);
		}

		// ② 曾自己创建、仍存活、只是 session 作废（典型：连接断开重建）——少了这步会**泄漏 tab**。
		for (const targetId of this._ownerOf.keys()) {
			const alive = targets.find(t => t.targetId === targetId);
			if (!alive) { this._ownerOf.delete(targetId); continue; }
			const sessionId = await this.ensureSession(targetId);
			return { targetId, sessionId, url: alive.url };
		}

		// ③ URL 匹配。
		if (url) {
			const match = targets.find(t => t.url === url) ?? targets.find(t => t.url.startsWith(url));
			if (match) {
				const sessionId = await this.ensureSession(match.targetId);
				return { targetId: match.targetId, sessionId, url: match.url };
			}
		}

		// ④ 新建。
		return await this._create(url, '');
	}

	/** 建一条新 tab 并记归属（**唯一**的建页点，免得两处归属写法漂移）。 */
	async _create(url, ownerKey) {
		const created = await this._conn.send('Target.createTarget', { url: url ?? 'about:blank' });
		const targetId = created?.targetId;
		if (!targetId) { throw new Error('Target.createTarget returned no targetId'); }
		this._ownerOf.set(targetId, ownerKey);
		const sessionId = await this.ensureSession(targetId);
		this._logger?.info?.(`[vssaros-browser] created page ${targetId} (${url ?? 'about:blank'})`
			+ (ownerKey ? ` for session ${ownerKey}` : ''));
		return { targetId, sessionId, url: url ?? 'about:blank', ...(ownerKey ? { owner: ownerKey } : {}), created: true };
	}

	/**
	 * 关闭**本工具创建**的页面；非自己创建的一律拒绝。
	 *
	 * ⚠ 多会话下判据是**归属相等**：`''` 也只关 `''` 的 —— 否则一个不带会话标识的调用就能把别的
	 * 会话正在读的页面关掉（那正是"互不影响"要防的事）。
	 */
	async closeOwned(targetId, ownerKey) {
		const key = typeof ownerKey === 'string' ? ownerKey : '';
		if (!this._ownerOf.has(targetId)) {
			throw new Error(`拒绝关闭 ${targetId}：该 tab 不是本工具创建的（不会关闭你自己的浏览器标签页）`);
		}
		if (this._ownerOf.get(targetId) !== key) {
			throw new Error(`拒绝关闭 ${targetId}：它属于另一个会话（多会话隔离：不许跨会话关页）`);
		}
		await this._conn.send('Target.closeTarget', { targetId });
		this._ownerOf.delete(targetId);
		this._sessions.delete(targetId);
		return { closed: true };
	}
}
