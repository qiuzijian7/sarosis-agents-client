/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * `browser_*` 工具的 CDP 宿主（主进程）—— 驱动用户本机真实 Chrome（P1-2，2026-09-24）。
 *
 * 放在主进程的理由见 `common/browserCdp.ts` 文件头（renderer 受 CORS + Origin 双重拦截，
 * 这也是本机 `web-access` 技能必须额外起一个 Node 代理进程的原因；本仓不必新起进程）。
 *
 * ## 本文件只做"必须在这里做"的三件事
 *
 *   ① **端点发现**（`net.fetch /json/version`，主进程无 CORS）
 *   ② **WebSocket 建连**（默认不发 Origin 头，绕过 Chrome 111+ 的跨 origin 拒绝）
 *   ③ **IPC 注册**
 *
 * 目标选择 / attach / 创建 / 关闭这些**决策逻辑**全在 `common/browserCdp.ts` 的
 * `CdpTargetManager` 里 —— 那样它们既可用假连接单测，也能被真机验证脚本直接复用
 * （不必在脚本里复制一份，避免"脚本测的是副本"）。
 *
 * ## 连接模型
 *
 * 一条**浏览器级** WebSocket（`/json/version` 给出的 `webSocketDebuggerUrl`），各 page 通过
 * `Target.attachToTarget({flatten:true})` 拿 sessionId 复用这条连接。
 *
 * ## 连的是哪个浏览器（2026-09-24 起）
 *
 * 候选端点**按优先级并行探测**：① 你设置的端口（你自己的 Chrome，带你的登录态）→ ② 同一端口的
 * IPv6 形态（Chrome 那个开关也可能只监听 `[::1]`）→ ③ 我们自己拉起的专属实例（配置端口 **+1**）。
 * 只有三者都不可达、且设置允许时才会去起专属实例。选择逻辑全在 `common/browserCdp.ts`
 * （可单测），本文件只负责"发现 + 建连 + IPC"。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { validatedIpcMain } from '../../../../base/parts/ipc/electron-main/ipcMain.js';
import { net } from 'electron';
import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import {
	BROWSER_CDP_CHANNEL,
	CDP_COMMAND_TIMEOUT_MS,
	CdpConnection,
	CdpTargetManager,
	DEFAULT_CDP_PORT,
	cdpEndpointCandidates,
	connectPreferredEndpoint,
	dedicatedPortFor,
} from '../common/browserCdp.js';
import {
	CHROME_PATH_ENV,
	buildDedicatedChromeArgs,
	chromeExecutableCandidates,
	dedicatedProfileDir,
	pickChromeExecutable,
	remoteDebuggingHint,
} from '../common/chromeDebugSetup.js';
import {
	AGENT_STUDIO_BROWSER_CDP_HEADLESS_SETTING,
	AGENT_STUDIO_BROWSER_CDP_LAUNCH_DEDICATED_SETTING,
	AGENT_STUDIO_BROWSER_CDP_PORT_SETTING,
} from '../common/constants.js';
import type {
	BrowserCdpRequest,
	BrowserCdpResult,
	IBrowserCdpResponse,
	IBrowserCdpStatus,
	ICdpEndpoint,
	IWebSocketLike,
} from '../common/browserCdp.js';

/** 自行拉起专属实例后，等端口就绪的上限。新 profile 首启要建目录/初始化，实测需要几秒。 */
const DEDICATED_LAUNCH_TIMEOUT_MS = 20_000;

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * 一次**成功**的候选连接。
 *
 * `product` 由 `_connectOnce` 从 `/json/version` 的 `Browser` 字段读出后带出来，而不是就地写进
 * `this._browserProduct` —— 并行探测时多个候选都可能成功，就地写会被落败者覆盖。
 */
interface IConnectedEndpoint {
	readonly conn: CdpConnection;
	readonly manager: CdpTargetManager;
	readonly product?: string;
}

export class BrowserCdpChannel extends Disposable {

	private _conn: CdpConnection | undefined;
	private _manager: CdpTargetManager | undefined;
	private _browserProduct: string | undefined;
	/**
	 * 当前连接对应的是哪个候选端点（`status` 据此报告"连的是你日常的 Chrome 还是专属实例"）。
	 *
	 * 原先这里是 `_lastError`（"上次连接失败原因"）—— 并行探测候选之后，一个共享的"上次错误"槽
	 * 在构造上就是错的（多个候选会各自写入），而失败原因已经随抛出的错误自带引导文案，
	 * 所以直接去掉那个字段，改为记录**成功时连的是谁**。
	 */
	private _activeEndpoint: ICdpEndpoint | undefined;
	/** 我们自己拉起的专属调试实例 pid（仅用于日志排障；Chrome 常驻，VsSaros 退出不带走它）。 */
	private _dedicatedPid: number | undefined;
	/** 正在进行的拉起动作 —— 并发的工具调用只应拉起一个浏览器。 */
	private _dedicatedLaunching: Promise<void> | undefined;

	constructor(
		private readonly logService: ILogService,
		private readonly configurationService: IConfigurationService,
	) {
		super();
		this.registerChannels();
	}

	override dispose(): void {
		validatedIpcMain.removeHandler(BROWSER_CDP_CHANNEL);
		this._dropConnection('channel disposed');
		super.dispose();
	}

	// ─── 连接管理 ────────────────────────────────────────────────────────────

	private _port(): number {
		const raw = this.configurationService.getValue<number | string>(AGENT_STUDIO_BROWSER_CDP_PORT_SETTING);
		const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
		return Number.isFinite(n) && n > 0 && n < 65536 ? Math.floor(n) : DEFAULT_CDP_PORT;
	}

	private _dropConnection(reason: string): void {
		this._manager?.clearSessions();
		try { this._conn?.dispose(); } catch { /* 已关闭 */ }
		this._conn = undefined;
		this._manager = undefined;
		this._browserProduct = undefined;
		this._activeEndpoint = undefined;
		this.logService.info(`[BrowserCdp] connection dropped: ${reason}`);
	}

	/**
	 * 建立（或复用）浏览器级连接 + 目标管理器。
	 *
	 * `allowLaunch`：**所有候选端点都不可达**时，是否允许自行拉起专属调试实例。
	 *   · 真实操作（ensurePage / command / list / closePage）→ `true`：调用方确实要用浏览器，
	 *     这时把浏览器带起来是合理的（Route B：无需用户手动开调试）。
	 *   · `status`（renderer 的可达性门控每 30 秒探一次）→ **必须 `false`**：绝不能让"探测"
	 *     变成"弹出一个浏览器窗口" —— 那等于把我们刚删掉的"启动就开 Chrome"从后门放回来。
	 *
	 * 候选端点与优先级见 `common/browserCdp.ts` 的 `cdpEndpointCandidates`（你自己的 Chrome 优先，
	 * 我们的专属实例只是兜底）。这些**决策**都在 `common/` 里，本文件只负责"发现 + 建连 + IPC"。
	 */
	private async _connect(allowLaunch = true): Promise<{ conn: CdpConnection; manager: CdpTargetManager }> {
		if (this._conn && this._manager) { return { conn: this._conn, manager: this._manager }; }

		const candidates = cdpEndpointCandidates(this._port());
		try {
			return await this._connectPreferred(candidates);
		} catch (firstErr) {
			// 用户自己开好了远程调试 ⇒ 上面就成功了，这里根本不会跑到，也就不会多起一个浏览器。
			if (!allowLaunch || !this._launchDedicatedEnabled()) { throw firstErr; }
			const dedicated = candidates.find(c => c.selfLaunched);
			if (!dedicated) { throw firstErr; }
			this.logService.info(`[BrowserCdp] 候选端点全部不可达 → 拉起专属调试实例（端口 ${dedicated.port}）`);
			try {
				await this._ensureDedicatedBrowser(dedicated.port);
			} catch (launchErr) {
				// 原始的"连不上"信息量更大（带手动引导），拉起失败的原因也一并带上（例如端口被占用）。
				throw new Error(`${errMsg(firstErr)}\n\n另外，尝试自行启动可调试 Chrome 也失败了：${errMsg(launchErr)}`);
			}
			return await this._connectPreferred([dedicated]);
		}
	}

	/** 并行探测候选、按优先级取胜者，并把连接状态记为**胜者**。 */
	private async _connectPreferred(candidates: readonly ICdpEndpoint[]): Promise<{ conn: CdpConnection; manager: CdpTargetManager }> {
		const { endpoint, value } = await connectPreferredEndpoint(
			candidates,
			c => this._connectOnce(c),
			// 落败的候选也是**真的连上了**的（真的 WebSocket + 真的 Target 会话），必须显式关掉。
			v => { try { v.conn.dispose(); } catch { /* 已关闭 */ } },
		);
		this._conn = value.conn;
		this._manager = value.manager;
		this._browserProduct = value.product;
		this._activeEndpoint = endpoint;
		this.logService.info(`[BrowserCdp] connected: ${endpoint.url}`
			+ (endpoint.selfLaunched ? '（专属实例 —— **不是**你日常的 Chrome，登录态与之无关）' : '（你自己的浏览器）'));
		return { conn: value.conn, manager: value.manager };
	}

	/** 单次连接尝试：HTTP 发现 → WS 建连。失败时抛出的错误**自带**给用户的引导文案。 */
	private async _connectOnce(ep: ICdpEndpoint): Promise<IConnectedEndpoint> {
		// 1) HTTP 发现 WS 端点。必须走主进程 net.fetch：renderer 会被 CORS 拦截。
		let wsUrl: string;
		let product: string | undefined;
		try {
			const res = await net.fetch(`${ep.url}/json/version`, { signal: AbortSignal.timeout(3000) });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} ${res.statusText}`);
			}
			const body = await res.json() as { webSocketDebuggerUrl?: unknown; Browser?: unknown };
			if (typeof body.webSocketDebuggerUrl !== 'string' || !body.webSocketDebuggerUrl) {
				throw new Error('no webSocketDebuggerUrl in /json/version');
			}
			wsUrl = body.webSocketDebuggerUrl;
			if (typeof body.Browser === 'string') { product = body.Browser; }
		} catch (err) {
			throw new Error(this._discoveryHint(ep.url, `CDP 端点探测失败：${errMsg(err)}`));
		}

		// 2) 打开 WebSocket。用 Node 原生 WebSocket（Electron 39 = Node 22，已是标准全局）；
		//    取不到时给出明确信息而不是 ReferenceError。
		const Ctor = (globalThis as { WebSocket?: new (url: string) => IWebSocketLike }).WebSocket;
		if (!Ctor) {
			throw new Error('CDP 不可用：当前运行时没有 WebSocket 全局（需要 Node 22+ / Electron 39+）');
		}
		const socket = new Ctor(wsUrl);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('CDP WebSocket 建连超时（5s）')), 5000);
			socket.onopen = () => { clearTimeout(timer); resolve(); };
			socket.onerror = () => {
				clearTimeout(timer);
				// 主进程不发 Origin，所以这里失败通常是"端口对了但不是 DevTools / 未授权"。
				reject(new Error(this._discoveryHint(ep.url, 'CDP WebSocket 建连失败（握手被拒或端口非 DevTools）')));
			};
		});

		const conn = new CdpConnection(socket, this.logService);
		const manager = new CdpTargetManager(conn, this.logService);
		conn.onClosed(() => {
			// sessionId 全部作废；下一次调用会走 _connect 重连。
			// ⚠ 只在"当前连接就是这条"时清空：落败候选的连接被 `_connectPreferred` 关掉时也会触发
			// onClosed，无条件清空会把**胜者**的连接状态一并抹掉（表现为"刚连上又变成未连接"）。
			if (this._conn === conn) {
				manager.clearSessions();
				this._conn = undefined;
				this._manager = undefined;
				this._browserProduct = undefined;
				this._activeEndpoint = undefined;
			}
		});
		// ⚠ 这里**不**写 `this._conn` / `_browserProduct`：并行探测时多个候选都会跑到这一行，
		// 就地写会被落败者覆盖（而落败者随后会被关掉 ⇒ 留下一个已 dispose 的"当前连接"）。
		// 赋值统一由 `_connectPreferred` 在选出胜者之后做。
		return { conn, manager, product };
	}

	/**
	 * 探测失败时的引导文案。
	 *
	 * 两个端口数字都要报出来，且**必须是不同的**：用户设置的那个（他改的地方）与专属实例实际所在
	 * 的那个（配置端口 +1，见 `browserCdp.ts` 的 `dedicatedPortFor`）。混成一个会让用户改错地方 ——
	 * 而这段文案是他失败时唯一的行动依据。
	 */
	private _discoveryHint(url: string, detail: string): string {
		const configuredPort = this._port();
		return remoteDebuggingHint({
			configuredPort,
			dedicatedPort: dedicatedPortFor(configuredPort),
			detail: `${detail}（${url}）`,
		});
	}

	// ─── Route B：自行拉起可调试实例（因此无需用户手动开远程调试）────────────

	private _launchDedicatedEnabled(): boolean {
		return this.configurationService.getValue<boolean>(AGENT_STUDIO_BROWSER_CDP_LAUNCH_DEDICATED_SETTING) !== false;
	}

	/** 并发的工具调用共用一个拉起动作 —— 否则会各起一个 Chrome。 */
	private _ensureDedicatedBrowser(port: number): Promise<void> {
		if (!this._dedicatedLaunching) {
			this._dedicatedLaunching = this._doLaunchDedicated(port)
				.finally(() => { this._dedicatedLaunching = undefined; });
		}
		return this._dedicatedLaunching;
	}

	/**
	 * 用专属 profile 起一个 Chrome，并等调试端口真的就绪。
	 *
	 * 为什么用**专属** profile 而不是用户的主 profile：Chrome 136+ 对默认 profile 会静默忽略
	 * `--remote-debugging-port`；而"复制主 profile"要多占几百 MB~GB、还可能复制到不一致的 cookie
	 * （三条路的对照表见 `common/chromeDebugSetup.ts` 文件头）。专属 profile 的代价只有"首次登录一次"。
	 *
	 * 刻意**不**在 dispose 时杀这个浏览器：它是给用户用的浏览器（登录态要在里面累积），而且下次启动时
	 * 端口已开、发现逻辑会直接复用，根本不会再拉起一个。
	 */
	private async _doLaunchDedicated(port: number): Promise<void> {
		const candidates = chromeExecutableCandidates(process.env, process.platform);
		const exe = pickChromeExecutable(candidates, existsSync);
		if (!exe) {
			throw new Error(`找不到 Chrome 可执行文件（已查 ${candidates.length} 个常见位置）。`
				+ `若装在非标准目录，请设环境变量 ${CHROME_PATH_ENV} 指向 chrome.exe；`
				+ `或在设置里关掉「自动拉起调试实例」，改为手动开启 Chrome 远程调试。`);
		}

		const profileDir = dedicatedProfileDir(homedir(), process.platform);
		try {
			mkdirSync(profileDir, { recursive: true });
		} catch (err) {
			// 建不出来时 Chrome 自己会报更准的错，这里只留痕，不遮住后续错误。
			this.logService.info(`[BrowserCdp] could not create profile dir ${profileDir}: ${errMsg(err)}`);
		}

		// 现读设置（不是在构造时快照）：用户改了无头开关，下一次拉起就按新值来。
		const headless = this.configurationService.getValue<boolean>(AGENT_STUDIO_BROWSER_CDP_HEADLESS_SETTING) === true;
		const args = buildDedicatedChromeArgs(profileDir, port, headless);
		this.logService.info(`[BrowserCdp] launching dedicated Chrome (headless=${headless}): ${exe} ${args.join(' ')}`);
		const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
		// spawn 的失败是**异步**的；不接住会变成 unhandled 'error' 直接崩主进程。
		child.on('error', err => this.logService.info(`[BrowserCdp] dedicated launch error: ${errMsg(err)}`));
		// 独立进程：VsSaros 退出不该把浏览器一起带走。
		child.unref();
		this._dedicatedPid = child.pid;

		// 等端口就绪：首次用新 profile 要建目录/初始化，实测要几秒 —— 给足时间，但别无限等。
		const deadline = Date.now() + DEDICATED_LAUNCH_TIMEOUT_MS;
		let lastErr = '（尚未探测到端口）';
		while (Date.now() < deadline) {
			try {
				const res = await net.fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
				if (res.ok) {
					this.logService.info(`[BrowserCdp] dedicated Chrome ready on port ${port} (pid=${this._dedicatedPid}, profile=${profileDir})`);
					return;
				}
				lastErr = `HTTP ${res.status} ${res.statusText}`;
			} catch (err) {
				lastErr = errMsg(err);
			}
			await new Promise(resolve => setTimeout(resolve, 300));
		}
		throw new Error(`已启动专属调试 Chrome（pid=${this._dedicatedPid}）但 ${Math.round(DEDICATED_LAUNCH_TIMEOUT_MS / 1000)} 秒内端口 ${port} 仍未就绪：${lastErr}。`
			+ `常见原因：该端口被其他程序（或另一个 Chrome 实例）占用 —— 可在「设置 → 工具配置 → 浏览器工具（CDP）」里换一个端口。`);
	}

	// ─── 各项操作 ────────────────────────────────────────────────────────────

	private async _status(): Promise<IBrowserCdpStatus> {
		// 未连接时报告**优先级最高**的那个候选（= 用户设置里那个端口）——那才是他期望看到的地址。
		const primary = cdpEndpointCandidates(this._port())[0];
		try {
			// allowLaunch=false：探测**只回报事实**，绝不因为一次探测就去起一个浏览器。
			// renderer 的可达性门控每 30 秒探一次，这里一旦允许拉起，"探测"就变成了"开浏览器窗口"。
			const { conn } = await this._connect(false);
			const version = await conn.send<{ product?: string }>('Browser.getVersion', undefined, undefined, 5000);
			const active = this._activeEndpoint ?? primary;
			return {
				ok: true,
				endpoint: active.url,
				connected: true,
				browser: typeof version?.product === 'string' ? version.product : this._browserProduct,
				selfLaunched: active.selfLaunched,
			};
		} catch (err) {
			return {
				ok: false,
				endpoint: primary.url,
				connected: false,
				error: errMsg(err),
			};
		}
	}

	private async _command(req: Extract<BrowserCdpRequest, { op: 'command' }>): Promise<unknown> {
		const { conn, manager } = await this._connect();
		const sessionId = req.sessionId ?? await manager.ensureSession(req.targetId);
		return conn.send(req.method, req.params, sessionId, req.timeoutMs ?? CDP_COMMAND_TIMEOUT_MS);
	}

	// ─── IPC ─────────────────────────────────────────────────────────────────

	private registerChannels(): void {
		validatedIpcMain.handle(BROWSER_CDP_CHANNEL, async (_event, req: BrowserCdpRequest): Promise<IBrowserCdpResponse> => {
			try {
				let result: BrowserCdpResult;
				switch (req?.op) {
					case 'status': result = await this._status(); break;
					case 'list': result = await (await this._connect()).manager.list(); break;
					case 'ensurePage': result = await (await this._connect()).manager.ensurePage(req.url); break;
					case 'closePage': result = await (await this._connect()).manager.closeOwned(req.targetId); break;
					case 'command': result = await this._command(req) as unknown; break;
					case 'reset':
						this._dropConnection('reset requested');
						result = { ok: true };
						break;
					default:
						throw new Error(`unknown op: ${String((req as { op?: unknown })?.op)}`);
				}
				return { ok: true, result };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.logService.info(`[BrowserCdp] op ${req?.op} failed: ${message}`);
				return { ok: false, error: message };
			}
		});
	}
}
