/**
 * Host 侧 CDP 宿主：**发现端点 → 连 WebSocket → 拉起专属 Chrome**（零依赖，只有 Node 内建）。
 *
 * 从这里开始是"移植"与"重写"的分界：VsSaros 那份把这部分放在**主进程**
 * （`agentStudio/electron-main/browserCdpChannel.ts`，因为它 import 了 electron 的 `net`）。
 * 而它实际用到的只有三样：`fetch`（发现 `/json/version`）、Node 全局 `WebSocket`、
 * `child_process.spawn`（拉起专属实例）——**Host 进程三样都有**，所以整段可以搬进来
 * （README 4.66：这就是 `browser` 族能下移的全部依据）。
 *
 * 与 IDE 侧的两点**有意不同**（都是"Host 里没有那个东西"的直接后果）：
 *  · 不用 Electron `net.fetch`：Host 是纯 Node ⇒ 用全局 `fetch`（也顺带避开 CORS 那套）。
 *  · 没有渲染进程 ⇒ **没有用户确认 UI**。动作类 op 的允许与否由**配置**决定（见 `lib/index.js`），
 *    默认只放只读 op —— 与 unreal 那条"只放行只读子集"同一档纪律（不自造授权）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
	cdpEndpointCandidates, chromeExecutableCandidates, dedicatedPortFor, dedicatedProfileDir,
	pickChromeExecutable, buildDedicatedChromeArgs, CHROME_PATH_ENV, DEFAULT_CDP_PORT,
} from './chrome.js';
import { CdpConnection, CdpTargetManager } from './cdp.js';

/** 发现端点的超时（与 IDE 侧同量级：不可达端口实测约 2.5s）。 */
const DISCOVER_TIMEOUT_MS = 3_000;

/** 拉起专属实例后等端口就绪的上限：Chrome 冷启动实测 1~3s，给足余量但不要无限等。 */
const LAUNCH_READY_TIMEOUT_MS = 15_000;

/**
 * "连不上"这个结论的缓存时长（只缓存失败，见 `ensureReachable`）。
 *
 * 取 10s 的理由是**两个方向都要快**：短到"用户刚开好调试就能立刻成功"（否则会变成"我明明开了
 * 它还说连不上"这种说不清的故障），长到"模型一次失败后连试几个 op 不会每个都白等一次探测"。
 */
const PROBE_FAIL_TTL_MS = 10_000;

/**
 * 读一个端点的 `/json/version`：拿 `webSocketDebuggerUrl` 与浏览器版本。
 * 对应 IDE 侧 `browserCdpChannel.ts:200-208`（那边用 `net.fetch`）。
 */
export async function discoverEndpoint(endpointURL) {
	const res = await fetch(`${endpointURL}/json/version`, { signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS) });
	if (!res.ok) { throw new Error(`GET ${endpointURL}/json/version → HTTP ${res.status}`); }
	const body = await res.json();
	if (typeof body?.webSocketDebuggerUrl !== 'string' || !body.webSocketDebuggerUrl) {
		throw new Error('no webSocketDebuggerUrl in /json/version');
	}
	return { wsUrl: body.webSocketDebuggerUrl, product: typeof body.Browser === 'string' ? body.Browser : undefined };
}

/**
 * 把底层网络错误翻译成**人能读的一行**。
 *
 * 为什么必须翻译（2026-10-13 真机日志定位到的缺陷）：`fetch` 对"端口没人监听"抛的是
 * `TypeError: fetch failed` —— 它对模型和用户都没有任何信息量，而我们要它们做的是
 * "去开远程调试 / 让工具自动拉起"。**原始错误一律保留在冒号后面**（翻译只加信息，不丢信息）。
 */
export function explainEndpointFailure(error) {
	if (!error) { return '(没有捕获到具体原因)'; }
	const message = error instanceof Error ? error.message : String(error);
	const code = error?.cause?.code ?? error?.code ?? '';
	if (code === 'ECONNREFUSED' || /fetch failed/i.test(message)) {
		return '连接被拒绝 —— 该端口上没有 Chrome 在监听（远程调试没开，或端口不对）';
	}
	if (code === 'ECONNRESET') { return '连接被重置 —— 端口上有东西，但它不是可调试的 Chrome'; }
	if (code === 'ETIMEDOUT' || code === 'ABORT_ERR' || /timeout|timed out|aborted/i.test(message)) {
		return '连接超时 —— 端口没有响应（防火墙/代理，或它不是 Chrome 的调试端口）';
	}
	return message;
}

/**
 * 这个端点上的**是不是 Chrome**（而不是别的 CDP 服务）。
 *
 * ★ 2026-10-28 实测事故：IDE 自己的 DevTools 也监听 **9222**（Chrome 的惯例调试端口）
 *   ⇒ 插件把 **IDE** 当成了 Chrome ⇒ 两个症状同时出现：
 *     ① `Storage.getCookies` 读到的是 **Electron 的 cookie**（里面没有 Chrome 的登录态）；
 *     ② `Target.createTarget` **不被支持** ⇒ 登录页开不出来
 *   ⇒ 表现为「还没有额度数据：CDP Target.createTarget failed (code -32000): Not supported」✗
 *
 * ⇒ `/json/version` 的 `Browser` 字段能区分：Chrome 是 `Chrome/…`，Electron 是 `Electron/…`
 *   ⇒ 明确不是 Chrome 的端点一律**跳过**（当作不可达）⇒ 继续试下一个候选
 *   ⇒ 全都不是 ⇒ 走「拉起专属 Chrome 实例」那条路 ✓
 * ⚠ `product` 缺失（undefined）时**不排除**（不因信息缺失而误杀真浏览器）。
 */
export function isChromeProduct(product) {
	if (typeof product !== 'string' || !product.trim()) { return true; }
	return /^chrome\//i.test(product.trim());
}

/**
 * 并行探测所有候选端点，按**候选顺序**取第一个连上的（不是"谁先回来选谁"）。
 * 真源：`browserCdp.ts:118-148`（连不上的连接必须在这里关掉，否则留常驻连接）。
 */
export async function connectPreferredEndpoint(candidates, connect, dispose) {
	if (candidates.length === 0) { throw new Error('connectPreferredEndpoint: 候选端点为空'); }
	const settled = await Promise.all(candidates.map(async endpoint => {
		try {
			return { ok: true, endpoint, value: await connect(endpoint) };
		} catch (error) {
			return { ok: false, endpoint, error };
		}
	}));
	const winner = settled.find(r => r.ok);
	if (!winner) {
		// ⚠ 必须**包装**，不能把底层错误原样抛出（2026-10-13 真机日志定位到的缺陷）：
		//   `fetch` 对"端口没人监听"抛的是 `TypeError: fetch failed` —— 这句话对模型和用户都没有
		//   任何信息量（真机上模型只能自己猜 "Chrome not running with CDP"），而我们要它做的是
		//   "去开远程调试 / 让工具自动拉起"。所以消息里必须带上**候选端点**与**可读的原因**。
		//
		//   （原写法 `first.ok ? new Error('CDP 端点全部不可达') : first.error` 里的三元是**死代码**：
		//    只要有一个候选成功，它就会在上面被选为 winner ⇒ 走到这里时 `first.ok` 恒为 false，
		//    于是那句人话**从来没被抛出去过** —— 真机日志里模型看到的正是裸的 `fetch failed`。）
		throw new Error(`CDP 端点全部不可达（${candidates.map(c => c.url).join(', ')}）：`
			+ explainEndpointFailure(settled[0]?.error));
	}
	for (const r of settled) {
		if (r.ok && r !== winner) {
			try { dispose(r.value); } catch { /* 关不掉也不该影响主流程 */ }
		}
	}
	return { endpoint: winner.endpoint, value: winner.value };
}

/** 拉起一个带专属 profile 的可调试 Chrome；`detached + unref` ⇒ 不随 Host 退出被杀。真源：`browserCdpChannel.ts:292-338`。 */
export function launchDedicatedChrome(exe, args) {
	// ⚠ windowsHide 必带：dsh Host 本身没有可继承的控制台 ⇒ 不带的话 Chrome 启动时
	// 会新分配一个控制台窗口（闪一下黑框）。detached 是为了不随 Host 退出被杀，与
	// windowsHide 不冲突（CREATE_NO_WINDOW 只影响控制台，不影响进程独立性）。
	const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
	child.unref();
	return child.pid;
}

/**
 * Host 侧 CDP 宿主（懒连接 + 一条连接复用）。
 *
 * 配置面（`lib/index.js` 从行的 `config` 与中立配置里取）：
 *  · `port` 配置端口（默认 {@link DEFAULT_CDP_PORT}）——**你自己的 Chrome** 应该在它上面；
 *  · `launchDedicated` 允许"什么都不用配"时由我们起一个专属实例（占 `port + 1`）；
 *  · `headless` 专属实例是否无头（⚠ 无头下没法交互式登录，默认 false）。
 */
export class CdpHost {
	constructor(options) {
		this._log = options.logger;
		this._config = {
			port: Number.isInteger(options.port) ? options.port : DEFAULT_CDP_PORT,
			launchDedicated: options.launchDedicated === true,
			headless: options.headless === true,
			homeDir: options.homeDir,
			platform: options.platform ?? process.platform,
			env: options.env ?? process.env,
		};
		this._conn = undefined;
		this._targets = undefined;
		this._endpoint = undefined;
		this._product = undefined;
		this._dedicatedPid = undefined;
		this._connecting = undefined;
		/**
		 * ★ 当前专属实例的**模式**（true = 无头）。
		 *
		 * 2026-10-28（用户要求「每次启动都自动打开浏览器，能不能无感」）：
		 *   · **平时**（读 cookie / 采集额度）⇒ **无头** ⇒ Host 启动不会弹出任何窗口 ✓
		 *   · **需要人工登录时** ⇒ 由 `ensureHeaded()` 切成**有头**（同 profile 不能并存 ⇒ 先杀再拉）
		 *   · 登录完 ⇒ `ensureHeadless()` 切回无头 ⇒ 用户无感 ✓
		 */
		this._modeHeadless = this._config.headless === true;
		this._dedicatedHeadless = undefined;
		/** 「上次探测失败」的缓存（**只缓存失败**，见 `ensureReachable`）。 */
		this._failProbe = undefined;
	}

	/** 当前配置下的专属端口（= 配置端口 + 1）。给状态文案用。 */
	get dedicatedPort() { return dedicatedPortFor(this._config.port); }

	/**
	 * 我们自己拉起的那个 Chrome 的 pid（没有则 `undefined`）。
	 *
	 * ⚠ 它**故意**不随 Host 退出被关掉（`launchDedicatedChrome` 用 detached + unref）：
	 * 用户很可能正在那个窗口里登录 —— Host 重启不该把他的窗口收走。
	 * 这个 getter 是给**诊断与测试清理**用的（测试每跑一次就漏一批 headless 进程，累积起来
	 * 会让后续运行变慢甚至超时，2026-10-13 实测过）。
	 */
	get dedicatedPid() { return this._dedicatedPid; }

	/** 探一下"现在能不能连上"（不建连接、不留状态）：工具可用性/文案都要它。 */
	async probe() {
		const candidates = cdpEndpointCandidates(this._config.port);
		try {
			const { endpoint, value } = await connectPreferredEndpoint(
					candidates,
					async ep => {
						const found = await discoverEndpoint(ep.url);
						// ★ 明确不是 Chrome 的端点（多半是 IDE 自己的 Electron DevTools 占了 9222）
						//   ⇒ 当作不可达跳过 ⇒ 继续试下一个候选 / 拉专属实例 ✓
						if (!isChromeProduct(found.product)) {
							throw new Error(`端点 ${ep.url} 不是 Chrome（是 ${found.product}）`);
						}
						return found;
					},
					() => { /* 发现阶段没有要关的连接 */ },
			);
			return { ok: true, endpoint: endpoint.url, selfLaunched: endpoint.selfLaunched, browser: value.product };
		} catch (error) {
			return { ok: false, endpoint: candidates[0]?.url, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * 工具 op 的**前置可达性检查**（2026-10-13）。
	 *
	 * 为什么必须有它：真机日志里，用户先被问了一次"允许 browser.login 打开登录页吗"、点了允许，
	 * **然后才失败**（底层 `fetch failed`）—— 那次授权是**白点**的。本仓早就定过这条纪律
	 * （"校验必须在审批之前：不许为一个必然失败的调用点问用户"），只是当时只覆盖了开关与参数，
	 * **漏了"浏览器根本连不上"这个最典型的必然失败**。
	 *
	 * 与 `probe()` 的分工：`probe()` 是"如实报告现状"（`status` op 用它，每次都要新鲜的）；
	 * 本方法是"**现在要不要就拒掉这次调用**"（允许缓存，见下）。
	 *
	 * 缓存规则 —— **只缓存失败**，两个方向都要快：
	 *   · **已连接** ⇒ 直接放行（连接在手是最硬的证据；`probe()` 是"不建连接"的，用它反而绕远）；
	 *   · **失败** ⇒ 缓存 {@link PROBE_FAIL_TTL_MS}（10s）：模型一次失败后常会立刻试别的 op，
	 *     不缓存就是每个 op 都白等一次探测；TTL 又必须短 —— 用户很可能正要去开调试，
	 *     缓存久了会变成"我明明开好了它还说连不上"这种说不清的故障；
	 *   · **成功但未连接**（探到你的 Chrome 但还没建连）⇒ **不缓存**：紧接着的调用会自己建连。
	 *
	 * ⚠ 这里**不做**"要不要拉起专属实例"的判断（那是 `_connection()` 的职责）：本方法只回答
	 * "**按现状**现在能不能连上"，由调用方结合 `launchDedicated` 决定要不要据此拒绝。
	 */
	async ensureReachable() {
		if (this._conn) { return { ok: true, connected: true, endpoint: this._endpoint }; }
		const now = Date.now();
		if (this._failProbe && now - this._failProbe.at < PROBE_FAIL_TTL_MS) {
			return this._failProbe.result;
		}
		const result = await this.probe();
		if (result.ok) { return { ...result, connected: false }; }
		this._failProbe = { at: now, result };
		return result;
	}

	/**
	 * 取（或建立）那条浏览器级连接。
	 * 候选全不可达且允许拉起时，**起一个专属实例再连**（这条路不需要用户勾任何同意框）。
	 */
	async _connection() {
		if (this._conn) { return this._conn; }
		if (this._connecting) { return this._connecting; }
		this._connecting = (async () => {
			try {
				const { endpoint, value } = await connectPreferredEndpoint(
					cdpEndpointCandidates(this._config.port),
					async ep => {
						const found = await discoverEndpoint(ep.url);
						// ★ 同上：不是 Chrome 的端点（IDE 的 Electron DevTools 占了 9222）⇒ 跳过
						if (!isChromeProduct(found.product)) {
							throw new Error(`端点 ${ep.url} 不是 Chrome（是 ${found.product}）`);
						}
						const ws = new WebSocket(found.wsUrl);
						await new Promise((resolve, reject) => {
							ws.onopen = () => resolve();
							ws.onerror = () => reject(new Error(`WebSocket 连接失败：${found.wsUrl}`));
						});
						const conn = new CdpConnection(ws, this._log);
						return { conn, product: found.product };
					},
					v => v?.conn?.dispose(),
				);
				this._endpoint = endpoint.url;
				this._product = value.product;
				this._conn = value.conn;
				this._targets = new CdpTargetManager(this._conn, this._log);
				// 断线后把缓存清掉，下次调用重连（目标记账保留，见 CdpTargetManager）。
				this._conn.onClosed(() => {
					this._targets?.clearSessions();
					this._conn = undefined;
					this._targets = undefined;
				});
				return this._conn;
			} catch (primary) {
				if (!this._config.launchDedicated) { throw primary; }
				const port = this.dedicatedPort;
				this._log?.info?.(`[vssaros-browser] 端点不可达，尝试拉起专属调试实例（端口 ${port}）`);
				const exe = pickChromeExecutable(
					chromeExecutableCandidates(this._config.env, this._config.platform),
					p => { try { return existsSync(p); } catch { return false; } },
				);
				if (!exe) {
					throw new Error(`找不到 Chrome 可执行文件（可用 ${CHROME_PATH_ENV} 指定）｜原因：${primary instanceof Error ? primary.message : String(primary)}`);
				}
				const profileDir = dedicatedProfileDir(this._config.homeDir, this._config.platform);
				this._dedicatedHeadless = this._modeHeadless;
				this._dedicatedPid = launchDedicatedChrome(exe, buildDedicatedChromeArgs(profileDir, port, this._modeHeadless));
				const url = `http://127.0.0.1:${port}`;
				const deadline = Date.now() + LAUNCH_READY_TIMEOUT_MS;
				let last;
				while (Date.now() < deadline) {
					try {
						const found = await discoverEndpoint(url);
						// ★ 专属端口上同样要确认是 Chrome（否则又连到某个别的 CDP 服务）
						if (!isChromeProduct(found.product)) {
							throw new Error(`专属端点 ${url} 不是 Chrome（是 ${found.product}）`);
						}
						const ws = new WebSocket(found.wsUrl);
						await new Promise((resolve, reject) => {
							ws.onopen = () => resolve();
							ws.onerror = () => reject(new Error('WebSocket 连接失败'));
						});
						this._conn = new CdpConnection(ws, this._log);
						this._targets = new CdpTargetManager(this._conn, this._log);
						this._endpoint = url;
						this._product = found.product;
						return this._conn;
					} catch (e) {
						last = e;
						await new Promise(r => setTimeout(r, 300));
					}
				}
				throw new Error(`专属实例起不来（${url}）：${explainEndpointFailure(last)}`);
			}
		})();
		try {
			return await this._connecting;
		} finally {
			this._connecting = undefined;
		}
	}

	/**
	 * 杀掉**我们自己拉起**的专属实例。
	 *
	 * ⚠ 切模式前必做：Chrome **不允许同一 profile 两个实例并存** ⇒ 必须先杀再拉。
	 */
	_killDedicated() {
		const pid = this._dedicatedPid;
		this._dedicatedPid = undefined;
		this._dedicatedHeadless = undefined;
		if (!pid) { return; }
		try {
			spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
		} catch {
			try { process.kill(pid); } catch { /* ignore */ }
		}
	}

	/** 断开当前连接（切模式时用）。 */
	_dropConnection() {
		try { this._conn?.dispose?.(); } catch { /* ignore */ }
		this._conn = undefined;
		this._targets = undefined;
		this._endpoint = undefined;
		this._product = undefined;
	}

	/**
	 * 确保专属实例是**有头**的（需要人交互登录时用）。
	 *
	 * 2026-10-28：平时是无头（用户无感），只有要让人登录时才切有头。
	 */
	async ensureHeaded() {
		if (!this._config.launchDedicated) { return; }
		// 连的是**用户自己的 Chrome**（不是我们拉的）⇒ 它本来就有头 ⇒ 不用切 ✓
		if (this._dedicatedPid === undefined && this._conn) { return; }
		if (this._dedicatedHeadless === false) { return; }
		this._log?.info?.('[vssaros-browser] 切换专属实例：无头 → 有头（需要人交互登录）');
		this._dropConnection();
		this._killDedicated();
		await new Promise((resolve) => setTimeout(resolve, 700));
		this._modeHeadless = false;
		await this._connection();
	}

	/**
	 * 确保专属实例是**无头**的（交互结束 ⇒ 回到"用户无感"状态）。
	 */
	async ensureHeadless() {
		if (!this._config.launchDedicated) { return; }
		if (this._dedicatedPid === undefined && this._conn) { return; }
		if (this._dedicatedHeadless === true) { return; }
		this._log?.info?.('[vssaros-browser] 切换专属实例：有头 → 无头（交互结束，用户无感）');
		this._dropConnection();
		this._killDedicated();
		await new Promise((resolve) => setTimeout(resolve, 700));
		this._modeHeadless = true;
		await this._connection();
	}

	/** 状态：端点 + 是否连上 + 浏览器版本（`status` op 的返回值）。 */
	async status() {
		const probe = await this.probe();
		return {
			ok: probe.ok,
			endpoint: probe.endpoint,
			connected: probe.ok,
			...(probe.browser ? { browser: probe.browser } : {}),
			...(probe.ok ? {} : { error: probe.error }),
			selfLaunched: probe.selfLaunched === true,
			dedicatedPort: this.dedicatedPort,
		};
	}

	/** 列出可操作的 page target（`list` op 用）。 */
	async list() {
		await this._connection();
		return await this._targets.list();
	}

	/**
	 * 确保有一个可操作的 page（`navigate` 等 op 用）。
	 *
	 * `ownerKey` = 调用方的**会话标识**（Host 侧传 dsh 的 `exec.agent.id`，即 SessionId）——
	 * 它决定"用**谁的** tab"：多会话并发时只认自己那个，绝不复用别人的页面（见 `CdpTargetManager` 类头）。
	 * 传空/省略＝旧行为（兼容 IDE 侧那条老路径）。
	 */
	async ensurePage(ownerKey, url) {
		await this._connection();
		return await this._targets.ensurePage(url, ownerKey);
	}

	/** 发一条 CDP 命令（会先确保连接）。 */
	async command(method, params, sessionId, timeoutMs) {
		const conn = await this._connection();
		return await conn.send(method, params, sessionId, timeoutMs);
	}

	async closeOwned(targetId, ownerKey) {
		await this._connection();
		return await this._targets.closeOwned(targetId, ownerKey);
	}

	/**
	 * 回收某个会话名下的**全部**页面 —— 会话结束时调用（2026-10-13，把多会话隔离收成闭环）。
	 *
	 * ★ 最重要的判据是**第一条**：`_conn` 为空就直接返回、什么都不做。
	 *   我们是**懒连接**的 —— 为了"关页面"去连一次 CDP（在什么都没配的机器上还会因此**拉起**
	 *   一个专属 Chrome）是本末倒置：会话结束反而开了个浏览器 ✗。从没连过 ⇒ 我们就不可能建过 tab ✓。
	 *
	 * 其余两条：归属校验交给 `closeOwned`（只关我们建的、且属于这个会话的 ⇒ 用户的标签页永不受影响）；
	 * 单个失败**不抛**（best-effort）—— 会话正在结束，没有谁能处理这个异常，而"少关一个 tab"
	 * 的代价只是留一个后台页（下次同 id 不会再复用，但也不碍事）。
	 */
	async closeSessionPages(ownerKey) {
		if (!this._conn) { return { closed: [], skipped: 'never-connected' }; }
		const closed = [];
		for (const targetId of this._targets.ownedTargetsOf(ownerKey)) {
			try {
				await this._targets.closeOwned(targetId, ownerKey);
				closed.push(targetId);
			} catch (err) {
				this._log?.info?.(`[vssaros-browser] 会话结束回收 ${targetId} 失败（忽略）：${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return { closed, skipped: '' };
	}

	dispose() {
		try { this._conn?.dispose(); } catch { /* 忽略 */ }
		this._conn = undefined;
		this._targets = undefined;
	}
}


