/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `browser_*` 工具的真实后端：通过 CDP 驱动**用户本机真实 Chrome**（P1-2，2026-09-24）。
 *
 * ## 为什么是 CDP 而不是自带浏览器
 *
 * 本仓已有主进程 `WebPageLoader`（Electron BrowserWindow 抓单页），但它是**一次性抓取**：
 * 抓完即销毁，没有会话、没有登录态、不能交互。`browser_*` 要解决的恰恰是这三件事：
 *   • **登录态** —— 用户日常 Chrome 里已登录的站点，直接可用，不需要在别处再登一遍；
 *   • **交互** —— 点击/输入/滚动/提交表单；
 *   • **会话** —— 多步操作在同一页面上下文里连续进行。
 *
 * ## 架构：为什么 CDP 客户端必须在**主进程**
 *
 * renderer 是 `vscode-file://vscode-app` origin：
 *   ① `GET http://127.0.0.1:9222/json/version`（发现 WS 端点）会被 CORS 拦截 —— Chrome 的
 *      DevTools HTTP 端点不回 `Access-Control-Allow-Origin`；
 *   ② WS 握手会带上 renderer 的 Origin，Chrome 111+ 默认拒绝跨 origin 的 DevTools WS。
 * 主进程（Node，无 origin 概念）两个问题都不存在 —— 这也是本机 `web-access` 技能必须起一个
 * Node 代理进程的根本原因。区别是本仓不必新起进程：**主进程本身就是那个 Node 侧**。
 *
 * ## 本文件只放**可单测**的部分
 *
 * 契约类型 + `CdpConnection`（JSON-RPC 请求关联 / 超时 / 断线清理）。socket 通过
 * `IWebSocketLike` 注入 ⇒ 单测用假 socket 即可覆盖关联与错误路径。
 * 真实 WebSocket 与 HTTP 发现、IPC 注册都在 `electron-main/browserCdpChannel.ts`
 * （那个文件 import electron，无法在纯 node 测试里 bundle）。
 */

/** IPC channel 名。⚠ `validatedIpcMain` 要求以 `vscode:` 开头（见 base/parts/ipc/electron-main/ipcMain.ts）。 */
export const BROWSER_CDP_CHANNEL = 'vscode:browserCdp';

/** Chrome 远程调试默认端口（`--remote-debugging-port` 的惯例值）。 */
export const DEFAULT_CDP_PORT = 9222;

/** 单条 CDP 命令的默认超时。导航类命令由调用方传入更大的值。 */
export const CDP_COMMAND_TIMEOUT_MS = 20_000;

// ─── 端点优先级：你自己的 Chrome 优先，专属实例只是兜底 ────────────────────────

/**
 * 我们**自行拉起**的专属调试实例使用的端口 —— 恒为「你设置的端口 + 1」。
 *
 * ## 为什么要错开一个端口（2026-09-24，由一份 Chrome CDP 场景对照资料 + 本仓提示文案驱动）
 *
 * Chrome 自己的调试开关（地址栏 `chrome://inspect/#remote-debugging` 里那个
 * "Allow remote debugging for this browser instance"）**没有端口选项**，只会监听**默认端口**
 * （资料给的形态是 `127.0.0.1:9222`，IPv6 形态为 `[::1]:9222`）。也就是说 9222 是"用你日常那个
 * Chrome（带你全部登录态）"这条路**唯一**的入口。
 *
 * 而专属实例此前**也占这个端口** ⇒ 它一旦跑起来，用户日常 Chrome 的开关就再也绑不上端口，那条路被
 * **静默**堵死；更糟的是我们仍能连上该端口，于是模型驱动的是**空 profile**，用户看到的是
 * "它说我没登录"却完全不知道为什么。错开后：你设置的端口永远留给**你的**浏览器，专属实例占 +1。
 *
 * 上限：`65535` 没有 +1 的空间，退到 `-1`（仍 ≠ 配置端口，且仍在合法端口范围内）。
 */
export function dedicatedPortFor(configuredPort: number): number {
	const next = configuredPort + 1;
	return next > 65535 ? configuredPort - 1 : next;
}

/** 一个候选 CDP 端点。`url` 可直接用于 `GET {url}/json/version` 发现。 */
export interface ICdpEndpoint {
	/** 主机部分（可能是 `127.0.0.1` 或 `[::1]`，见 `cdpEndpointCandidates`）。 */
	readonly host: string;
	readonly port: number;
	/** 端点的 HTTP 根，如 `http://127.0.0.1:9222`。 */
	readonly url: string;
	/** 是否按约定属于**我们自行拉起**的专属实例（只有 +1 那个端口是）。 */
	readonly selfLaunched: boolean;
}

/**
 * 候选端点的**优先级顺序**：先你设置的端口（你自己的 Chrome），再同端口的 IPv6 形态，最后专属实例。
 *
 * ① 为什么"你自己的 Chrome"排在专属实例**前面**：那条路带着你真实的登录态，是我们最想要的结果；
 *    专属实例只是"什么都不用配"的兜底。反过来排会让"用户明明勾了同意框、模型却仍在驱动空 profile"
 *    变成一个说不清的现象（而这正是本函数要消灭的那类失败）。
 *
 * ② 为什么要带 IPv6 形态：Chrome 那个开关可能监听 `[::1]:9222` 而非 `127.0.0.1:9222`
 *    （两种形态在实测资料里都出现过 —— 有资料甚至明确写"不要把 host 写死为 127.0.0.1"）。
 *    只探 IPv4 会在这种情况下误判"不可达"→ 悄悄退回专属实例，然后表现为"它说我没登录"。
 *
 * ③ 专属实例只列 IPv4：它是**我们自己**用 `--remote-debugging-port` 起的，绑定形态已知
 *    （真机验证脚本一直就是这么连的），多列一个 IPv6 只会平白多一次探测。
 */
export function cdpEndpointCandidates(configuredPort: number): ICdpEndpoint[] {
	const dedicated = dedicatedPortFor(configuredPort);
	const mk = (host: string, port: number): ICdpEndpoint => ({
		host, port, url: `http://${host}:${port}`, selfLaunched: port === dedicated,
	});
	const out = [mk('127.0.0.1', configuredPort), mk('[::1]', configuredPort)];
	// 唯一可能相等的情形就是上限回退那一档；相等时不必重复列同一个端点。
	if (dedicated !== configuredPort) { out.push(mk('127.0.0.1', dedicated)); }
	return out;
}

/**
 * 并行探测所有候选端点，按**候选顺序**取第一个连上的；全部失败则抛第一个候选的错误。
 *
 * ## 为什么并行发起
 *
 * 每个失败候选都要等一次网络超时（不可达端口实测约 2.5s，见 `BrowserCdpReachabilityGate` 注释），
 * 串行就是 3 次叠加。并行下总耗时 = 最慢的那一个。
 *
 * ## 为什么"顺序"仍然决定选谁（而不是谁先回来选谁）
 *
 * 见 `cdpEndpointCandidates` 的两条理由 —— 用户自己的 Chrome 必须优先于我们的专属实例，
 * 哪怕专属实例回得更快（它在本地、通常确实更快）。
 *
 * ⚠ 没被选中的连接**必须**在这里关掉：每一个都是真的 WebSocket + 一个 `Target` 会话，
 * 漏关就是一条常驻连接（而且它不会再被任何人复用）。
 */
export async function connectPreferredEndpoint<T>(
	candidates: readonly ICdpEndpoint[],
	connect: (endpoint: ICdpEndpoint) => Promise<T>,
	dispose: (value: T) => void,
): Promise<{ endpoint: ICdpEndpoint; value: T }> {
	if (candidates.length === 0) {
		throw new Error('connectPreferredEndpoint: 候选端点为空（调用方应当保证至少有一个）');
	}

	const settled = await Promise.all(candidates.map(async endpoint => {
		try {
			return { ok: true as const, endpoint, value: await connect(endpoint) };
		} catch (error) {
			return { ok: false as const, endpoint, error };
		}
	}));

	const winner = settled.find(r => r.ok);
	if (!winner) {
		// 抛**第一个**候选的错误：它的文案是给用户看的引导（且第一项正是他设置的端口）。
		const firstFailure = settled[0];
		throw firstFailure.ok ? new Error('CDP 端点全部不可达') : firstFailure.error;
	}

	for (const r of settled) {
		if (r.ok && r !== winner) {
			try { dispose(r.value); } catch { /* 关不掉也不该影响主流程 */ }
		}
	}
	return { endpoint: winner.endpoint, value: winner.value };
}

// ─── IPC 契约（renderer ↔ main）───────────────────────────────────────────────

export type BrowserCdpRequest =
	/** 探测端点可达性 + 连接状态（不发命令）。 */
	| { readonly op: 'status' }
	/** 列出可操作的 page target。 */
	| { readonly op: 'list' }
	/**
	 * 确保有一个可用 page：优先复用已 attach 的、其次复用匹配 URL 的、否则新建。
	 * 返回 `{ targetId, sessionId, url }`（sessionId 供后续 command 使用）。
	 */
	| { readonly op: 'ensurePage'; readonly url?: string }
	/** 关闭我们创建的 page（**绝不**关用户自己的 tab —— 由调用方保证只关自己建的）。 */
	| { readonly op: 'closePage'; readonly targetId: string }
	/** 发一条 CDP 命令（需要先 ensurePage 拿到 targetId/sessionId）。 */
	| { readonly op: 'command'; readonly targetId: string; readonly sessionId?: string; readonly method: string; readonly params?: Record<string, unknown>; readonly timeoutMs?: number }
	/** 丢弃连接（设置改端口后 / 排障用）。 */
	| { readonly op: 'reset' };

export interface IBrowserCdpStatus {
	readonly ok: boolean;
	readonly endpoint: string;
	/** 浏览器级 WS 是否已连上。 */
	readonly connected: boolean;
	/** `Browser.getVersion` 的 `product`（如 `Chrome/124.0.6367.60`）。 */
	readonly browser?: string;
	/** `ok=false` 时的人读原因（引导用户去开远程调试）。 */
	readonly error?: string;
	/**
	 * 本次连的是否为我们**自行拉起**的专属实例（缺省 = 你自己的 Chrome）。
	 *
	 * 为什么要把这件事暴露出来：两者行为看起来一样，但**登录态完全不同** —— 命中登录墙时用户需要知道
	 * "我在哪个浏览器里登录"才能自救。只有端点是个事实（+1 端口），所以按端口判定，不靠记忆。
	 */
	readonly selfLaunched?: boolean;
}

export interface IBrowserCdpTarget {
	readonly targetId: string;
	readonly url: string;
	readonly title: string;
	readonly type: string;
}

export interface IBrowserCdpPage {
	readonly targetId: string;
	readonly sessionId: string;
	readonly url: string;
}

export type BrowserCdpResult =
	| IBrowserCdpStatus
	| readonly IBrowserCdpTarget[]
	| IBrowserCdpPage
	| { readonly closed: boolean }
	| unknown;

export interface IBrowserCdpResponse<T = BrowserCdpResult> {
	readonly ok: boolean;
	readonly error?: string;
	readonly result?: T;
}

// ─── 可测部分：WebSocket 抽象 + JSON-RPC 关联 ─────────────────────────────────

/** 最小 WebSocket 抽象。主进程传 Node 原生 `WebSocket`，单测传假实现。 */
export interface IWebSocketLike {
	send(data: string): void;
	close(): void;
	onopen?: (() => void) | null;
	onmessage?: ((event: { data: unknown }) => void) | null;
	onerror?: ((event: unknown) => void) | null;
	onclose?: (() => void) | null;
}

/** 日志只需这两个方法（避免把 ILogService 拖进 common）。 */
export interface ICdpLogger {
	info?(message: string): void;
	warn?(message: string): void;
}

/**
 * CDP 目标管理（纯逻辑，只依赖 `CdpConnection`）。
 *
 * 从 `electron-main/browserCdpChannel.ts` 抽出：那个文件混了两件性质不同的事 ——
 * 「发现 + WebSocket + IPC」（必须有 electron/Node 能力，无法纯测）与「目标选择/attach/
 * 创建/关闭」（**决策逻辑**：复用还是新建、哪些 tab 允许关）。抽出来之后决策逻辑既能用
 * 假连接单测，也能被真机验证脚本直接复用（不必在脚本里复制一份）。
 */
export class CdpTargetManager {
	private readonly _sessions = new Map<string, string>();
	/** 本工具创建的 targetId —— `closeOwned` 仅接受这些（绝不关用户自己的 tab）。 */
	private readonly _owned = new Set<string>();

	constructor(
		private readonly _conn: CdpConnection,
		private readonly _logger?: ICdpLogger,
	) { }

	get ownedCount(): number {
		return this._owned.size;
	}

	async list(): Promise<IBrowserCdpTarget[]> {
		const res = await this._conn.send<{ targetInfos?: Array<Record<string, unknown>> }>('Target.getTargets');
		const infos = Array.isArray(res?.targetInfos) ? res.targetInfos : [];
		return infos
			.filter(t => t['type'] === 'page' && !String(t['url'] ?? '').startsWith('devtools://'))
			.map(t => ({
				targetId: String(t['targetId'] ?? ''),
				url: String(t['url'] ?? ''),
				title: String(t['title'] ?? ''),
				type: String(t['type'] ?? ''),
			}))
			.filter(t => !!t.targetId);
	}

	/** 取（或建立）某 target 的 flatten sessionId。 */
	async ensureSession(targetId: string): Promise<string> {
		const cached = this._sessions.get(targetId);
		if (cached) { return cached; }
		try {
			const res = await this._conn.send<{ sessionId?: string }>('Target.attachToTarget', { targetId, flatten: true });
			const sessionId = res?.sessionId;
			if (!sessionId) {
				throw new Error('Target.attachToTarget returned no sessionId');
			}
			this._sessions.set(targetId, sessionId);
			return sessionId;
		} catch (err) {
			// attach 失败通常意味着 target 已经不在了（用户关了这个 tab）。
			this._sessions.delete(targetId);
			this._owned.delete(targetId);
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(`无法附着到页面 ${targetId}（可能已被关闭）：${detail}`);
		}
	}

	forgetTarget(targetId: string): void {
		this._sessions.delete(targetId);
		this._owned.delete(targetId);
	}

	/** 连接断开时调用：sessionId 全部作废，但"自己创建的 tab"这层记账仍然有效。 */
	clearSessions(): void {
		this._sessions.clear();
	}

	/**
	 * 确保有一个可操作的 page。
	 *
	 * 优先级（越靠前越"不动用户的东西"）：
	 *   ① 已 attach 且仍存在的页面；
	 *   ② URL 匹配（调用方指定了 url 时）；
	 *   ③ **新建** tab（记为 owned）—— 这一条是有意的：抢用现有 tab 会把操作打到用户正在
	 *      看的页面里（可能是他在填的表单），代价远大于多开一个后台 tab。
	 */
	async ensurePage(url?: string): Promise<IBrowserCdpPage> {
		const targets = await this.list();

		// ① 已 attach 的（且仍存在）。
		for (const [targetId, sessionId] of this._sessions) {
			const alive = targets.find(t => t.targetId === targetId);
			if (alive) { return { targetId, sessionId, url: alive.url }; }
			this._sessions.delete(targetId);
		}

		// ①b 曾经自己创建、仍然存活、只是 session 已作废（典型：连接断开重建）。
		// 少了这一步会**泄漏 tab**：`_owned` 记着这个 tab，但 `_sessions` 清空了 ⇒ 每次都走
		// ③ 新开一个，旧的一直留在浏览器里（反复重连就积一堆）。先尝试重新 attach。
		for (const targetId of this._owned) {
			const alive = targets.find(t => t.targetId === targetId);
			if (!alive) {
				// 真的被关掉了 → 销账，别让 `_owned` 无限增长。
				this._owned.delete(targetId);
				continue;
			}
			const sessionId = await this.ensureSession(targetId);
			return { targetId, sessionId, url: alive.url };
		}

		// ② URL 匹配。
		if (url) {
			const match = targets.find(t => t.url === url) ?? targets.find(t => t.url.startsWith(url));
			if (match) {
				const sessionId = await this.ensureSession(match.targetId);
				return { targetId: match.targetId, sessionId, url: match.url };
			}
		}

		// ③ 新建。
		const created = await this._conn.send<{ targetId?: string }>('Target.createTarget', { url: url ?? 'about:blank' });
		const targetId = created?.targetId;
		if (!targetId) {
			throw new Error('Target.createTarget returned no targetId');
		}
		this._owned.add(targetId);
		const sessionId = await this.ensureSession(targetId);
		this._logger?.info?.(`[BrowserCdp] created page ${targetId} (${url ?? 'about:blank'})`);
		return { targetId, sessionId, url: url ?? 'about:blank' };
	}

	/** 关闭**本工具创建**的页面；非自己创建的一律拒绝（见类注释）。 */
	async closeOwned(targetId: string): Promise<{ closed: boolean }> {
		if (!this._owned.has(targetId)) {
			throw new Error(`拒绝关闭 ${targetId}：该 tab 不是本工具创建的（不会关闭你自己的浏览器标签页）`);
		}
		await this._conn.send('Target.closeTarget', { targetId });
		this._owned.delete(targetId);
		this._sessions.delete(targetId);
		return { closed: true };
	}
}

/**
 * `browser_*` 工具可用性的**可达性门控**（P1-2 加固，2026-09-24）。
 *
 * ## 为什么需要它（实测依据）
 *
 * `available()` 必须是同步的，而"Chrome 有没有开远程调试"只能发网络探测才知道。不探测的
 * 实测后果（见 `log.ts`）：工具常驻暴露，模型每次都会花一次调用去撞
 * `net::ERR_CONNECTION_REFUSED` 再回退；而且这个失败**特别慢** —— 同一个不可达端口，
 * Node fetch 23ms 返回，Electron `net.fetch` 要约 2466ms（Chromium 网络栈的冷启动开销）。
 * 门控把这两种浪费一起消掉：不可达就不把工具暴露给模型。
 *
 * ## 三条语义（本类的全部意图，改前先读）
 *
 *   ① `isUsable()` **永不阻塞**：它只回答"现在知道的可达性"，需要探测时丢到后台。
 *      调用方是 `listTools` 这种每轮都会走的热路径，绝不能在这里 await 网络。
 *   ② **节流 + 单飞**：一个周期内最多一次探测，且同时只有一次在飞 —— `available()` 会被
 *      `listTools` 与 `getAllToolDefinitions` 各调一遍（每个工具各一次），没有节流会引发
 *      探测风暴。
 *   ③ **状态变化才通知**：日志回调只在 false↔true 翻转时触发，避免每 30s 刷一条。
 *
 * 未探测过视为**不可用**：宁可让工具晚一个周期出现，也不要把必然失败的工具摆在模型面前 ——
 * 模型不区分"工具坏了"和"环境没配"，只会浪费轮次。用户**中途**再开远程调试也能被发现，
 * 因为每次调用都会在周期到点时重探。
 */
export class BrowserCdpReachabilityGate {
	private _reachable = false;
	/**
	 * 上次发起探测的时刻。初值是 `-Infinity` 而不是 0 —— 用 0 表示"从未探测"会与"时钟基准恰好
	 * 从 0 开始"混在一起，导致首次探测被节流误挡（注入假时钟的单测立刻就撞上了；真实时钟因为
	 * `Date.now()` 值很大而侥幸不发病，属于隐藏的时钟耦合）。
	 */
	private _probedAt = Number.NEGATIVE_INFINITY;
	private _inFlight = false;

	constructor(
		private readonly _probe: () => Promise<boolean>,
		/** 重探周期。太小会白白反复打本地端口；太大会让"用户刚开好远程调试"长时间不生效。 */
		private readonly _intervalMs: number,
		private readonly _onChange?: (reachable: boolean, detail: string) => void,
		private readonly _now: () => number = () => Date.now(),
	) { }

	/** 当前是否判定可用（必要时后台补探测，见类注释 ①②）。 */
	isUsable(): boolean {
		this._maybeProbe();
		return this._reachable;
	}

	/** 注册时预热，让首次 `listTools` 就有结论（而不是白等一个周期）。 */
	warmUp(): void {
		this._maybeProbe(0);
	}

	private _maybeProbe(intervalOverride?: number): void {
		const interval = intervalOverride ?? this._intervalMs;
		if (this._inFlight) { return; }
		const now = this._now();
		if (now - this._probedAt < interval) { return; }
		// 先记时刻再发起：否则同步连续调用会各发一次（节流失效）。
		this._probedAt = now;
		this._inFlight = true;
		void this._probe().then(
			reachable => this._settle(reachable, ''),
			err => this._settle(false, err instanceof Error ? err.message : String(err)),
		);
	}

	private _settle(reachable: boolean, detail: string): void {
		this._inFlight = false;
		if (reachable !== this._reachable) {
			this._reachable = reachable;
			this._onChange?.(reachable, detail);
		}
	}
}

interface IPendingCall {
	readonly method: string;
	readonly resolve: (value: never) => void;
	readonly reject: (reason: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** 把 CDP 的 error 载荷转成 Error（保留 code，便于调用方识别 "no such target"）。 */
export function formatCdpError(method: string, error: unknown): Error {
	const e = (error ?? {}) as { message?: unknown; code?: unknown; data?: unknown };
	const message = typeof e.message === 'string' && e.message ? e.message : JSON.stringify(error ?? null);
	const code = typeof e.code === 'number' ? ` (code ${e.code})` : '';
	return new Error(`CDP ${method} failed${code}: ${message}`);
}

/**
 * 一条 CDP WebSocket 连接 + JSON-RPC 请求关联。
 *
 * **模型选择：浏览器级连接 + `Target.attachToTarget({flatten:true})` 的 sessionId**，
 * 而不是"每个 page 一条 WS"。理由：① 只有一条连接要维护/重连，状态面小；
 * ② flatten 模式下所有目标共用同一 id 空间，关联逻辑只需一份（本类）。
 */
export class CdpConnection {
	private _nextId = 1;
	private readonly _pending = new Map<number, IPendingCall>();
	private _disposed = false;
	private _onClosed: (() => void) | undefined;

	constructor(
		private readonly _socket: IWebSocketLike,
		private readonly _logger?: ICdpLogger,
	) {
		this._socket.onmessage = event => this._handleMessage(event?.data);
		this._socket.onerror = () => { /* onclose 总会跟着来，统一在那里收尾 */ };
		this._socket.onclose = () => this._handleClose('socket closed');
	}

	/** 注册断线回调（上层据此丢弃缓存并重连）。 */
	onClosed(handler: () => void): void {
		this._onClosed = handler;
	}

	get pendingCount(): number {
		return this._pending.size;
	}

	/**
	 * 发一条 CDP 命令。
	 *
	 * @param sessionId flatten 模式下 attach 得到的会话 id；省略 = 浏览器级命令。
	 */
	send<T>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs: number = CDP_COMMAND_TIMEOUT_MS): Promise<T> {
		if (this._disposed) {
			return Promise.reject(new Error(`CDP ${method} failed: connection is disposed`));
		}
		const id = this._nextId++;

		return new Promise<T>((resolve, reject) => {
			// 超时必须自己管：CDP 不会对已发出的命令回错误，页面卡住时请求会永远悬着。
			const timer = setTimeout(() => {
				this._pending.delete(id);
				reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this._pending.set(id, {
				method,
				resolve: resolve as (value: never) => void,
				reject,
				timer,
			});

			try {
				this._socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
			} catch (err) {
				clearTimeout(timer);
				this._pending.delete(id);
				reject(new Error(`CDP ${method} send failed: ${err instanceof Error ? err.message : String(err)}`));
			}
		});
	}

	dispose(): void {
		this._handleClose('disposed');
		try { this._socket.close(); } catch { /* 已关闭 */ }
	}

	private _handleMessage(raw: unknown): void {
		let msg: { id?: number; method?: string; result?: unknown; error?: unknown };
		try {
			const text = typeof raw === 'string' ? raw : (raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : String(raw));
			msg = JSON.parse(text) as typeof msg;
		} catch {
			this._logger?.warn?.('[BrowserCdp] dropped unparseable message');
			return;
		}

		// 事件（有 method、无 id）：当前实现不需要事件，显式忽略而不是当响应处理。
		if (msg.id === undefined) { return; }

		const pending = this._pending.get(msg.id);
		if (!pending) {
			this._logger?.warn?.(`[BrowserCdp] response for unknown id ${msg.id} (already timed out?)`);
			return;
		}
		this._pending.delete(msg.id);
		clearTimeout(pending.timer);

		if (msg.error !== undefined) {
			pending.reject(formatCdpError(pending.method, msg.error));
			return;
		}
		(pending.resolve as (value: unknown) => void)(msg.result);
	}

	private _handleClose(reason: string): void {
		if (this._disposed) { return; }
		this._disposed = true;
		// 断线必须让所有在飞的请求立刻失败：否则调用方会一直等到超时才报错，
		// 而真正的原因（连接没了）被掩盖。
		for (const [id, pending] of this._pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error(`CDP ${pending.method} aborted: ${reason} (id ${id})`));
		}
		this._pending.clear();
		this._onClosed?.();
	}
}
