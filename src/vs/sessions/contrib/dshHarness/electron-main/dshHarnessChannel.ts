/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh 底座的主进程通道：Host 监管 + 托管运行时 + 视图池。全应用单例（方案第 7.5 节：全应用一个 Host）。
 * 在 `src/vs/code/electron-main/app.ts` 中以 `DSH_HARNESS_CHANNEL` 注册。
 *
 * 启动时机：渲染进程侧**必然**在聊天框随布局挂载时（工作台起来后）才发 Start，而 Host 冷启动要 3–4 s；
 * 两者串起来 = 窗口起来 10 s 后聊天框才可用。因此主进程会在 app ready 后用**上一次的启动选项**抢先起
 * Host（`_eagerPrewarm`，与工作台启动完全并行），渲染进程随后的 Start 若选项相同就直接复用。
 * 首次运行（没有上次选项）与"上次被禁用"时仍退回渲染进程触发。
 */

import { app, net } from 'electron';
import { existsSync, promises as fsp, readFileSync } from 'fs';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IAuxiliaryWindowsMainService } from '../../../../platform/auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';
import { DshBridgeMethod, IBridgeBundleInfo, IBridgeBundleToggleArgs, IBridgeInspectResult, IBridgeInstallArgs, IBridgeInstallCancelArgs, IBridgeInstallCancelResult, IBridgeInstallResult, IBridgePluginChangeResult, IBridgePluginInventory, IBridgePluginRegistries, IBridgePluginRow, IBridgePluginRowToggleArgs, IBridgeProvidersSyncArgs, IBridgeProvidersSyncResult, IBridgeRemoveArgs, IBridgeSessionCancelArgs, IBridgeSessionCancelResult, IBridgeSessionRunArgs, IBridgeSessionRunResult, IBridgeSessionStartArgs, IBridgeSessionStartResult, IBridgeWorkspace, IBridgeWorkspaceContextArgs, validateBundleInspectArgs, validateBundleInstallArgs, validateBundleRemoveArgs, validateBundleToggleArgs, validateInstallCancelArgs, validatePluginRowToggleArgs, validateProvidersSyncArgs, validateWorkspaceContextArgs } from '../common/dshBridgeProtocol.js';
import { DshCreditProxy, IDshCreditSample } from './dshCreditProxy.js';
import { localPluginDir, selectRuntimeVersion } from '../common/dshCli.js';
import { discoverUpdates, resolveCurrentVersion, selectInstallTarget } from '../common/dshCompat.js';
import { DSH_HARNESS_CHANNEL, DshHarnessChannelCommand, DshHarnessChannelEvent, IDshBootstrapArgs, IDshBundledPluginRow, IDshCreateViewArgs, IDshHostStartOptions, IDshHostStatus, IDshIdeClaimReply, IDshIdeReply, IDshIdeRequest, IDshPluginActivationSnapshot, IDshPluginInfo, IDshPluginRowSetResult, IDshPluginSetResult, IDshUpdateDiscoveryResult, IDshUpdatePolicy, IDshUpgradeArgs, IDshViewBounds, sameStartOptions } from '../common/dshHarness.js';
import { IdeRequestClaims } from '../common/dshIdeClaims.js';
import { IIdeTargetPick, pickIdeTargetWindow } from '../common/dshIdeTargeting.js';
import { readCapabilityDeclarations } from '../common/dshIdeAuthorization.js';
import { validateInsertReference, validateWorkspaceOptions, validateWorktreeOptions } from '../common/dshPageBridgeProtocol.js';
import { isDshChatSessionId } from '../common/dshChatSession.js';
import { validatePluginRoute } from '../common/dshPluginPage.js';
import { isBundleDisableForbidden, isBundleEnabled } from '../common/dshPluginActivation.js';
import { listBundledPlugins, mergeBundledWithInstalled } from './dshBundledPlugins.js';
import { IVssarosPluginManifest, isBuiltinPluginName, tryParseVssarosManifest } from '../common/vssarosPluginManifest.js';
import { DshPluginActivationStore } from './dshPluginActivationStore.js';
import { DshIdeRequestGate } from './dshIdeRequestGate.js';
import { IDshViewBackgrounds, validateThemeTokens, validateViewBackgrounds } from '../common/dshThemeBridge.js';
import { IDshUpgradeResult } from '../common/dshUpgrade.js';
import { loadCompatManifest } from './dshCompatSource.js';
import { DshHostSupervisor } from './dshHostSupervisor.js';
import { FetchLike } from './dshNodeInstaller.js';
import { DshRuntimeError, DshRuntimeManager, IResolvedNode } from './dshRuntimeManager.js';
import { DshUpgradeGate } from './dshUpgradeGate.js';
import { DshViewHost } from './dshViewHost.js';
import { DshWorkspaceSync } from './dshWorkspaceSync.js';

export interface IDshHarnessChannelOptions {
	readonly userDataPath: string;
	/** 开发版（未打包）：未配置 dshHome 时使用独立目录，避免与安装版争用同一会话（dsh 会话跨进程单写者）。 */
	readonly isBuilt: boolean;
	/** 仅测试使用：覆盖视图 preload 路径。 */
	readonly preloadPath?: string;
	/** 仅测试使用：覆盖托管运行时根目录（默认 `<userData>/dsh-runtime`）。 */
	readonly managedRoot?: string;
	/** 仅测试使用：覆盖下载实现（默认 `electron.net.fetch`，走系统代理）。 */
	readonly fetch?: FetchLike;
	/** 仅测试使用：覆盖随包兼容清单路径。 */
	readonly compatBundledPath?: string;
	/** 仅测试使用：覆盖**随包插件根**（默认 `<appPath>/dsh-plugins`；`vssaros-bridge` / 模块插件都在这一层）。 */
	readonly bundledPluginsPath?: string;
}

/** 伴生插件的版本与它声明支持的 dsh 范围（预检 ②）。 */
function readBridgeInfo(dir: string): { version?: string; peerRange?: string } {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string; peerDependencies?: Record<string, string> };
		return { version: pkg.version, peerRange: pkg.peerDependencies?.['@deepseek-ai/dsh'] };
	} catch {
		return {};
	}
}

export class DshHarnessChannel<TContext> extends Disposable implements IServerChannel<TContext> {

	private readonly _runtime: DshRuntimeManager;
	private readonly _supervisor: DshHostSupervisor;
	private readonly _views: DshViewHost;
	private readonly _pluginActivation: DshPluginActivationStore;
	private readonly _gate: DshUpgradeGate;
	private readonly _fetch: FetchLike;
	private readonly _onDidChangeStatus = this._register(new Emitter<IDshHostStatus>());
	private readonly _onDidProgress = this._register(new Emitter<string>());
	/** 插件启停变化（方案 6.4 步骤 3/4 的 `plugins.changed` 雏形）。 */
	private readonly _onDidChangePlugins = this._register(new Emitter<void>());
	/** Host 里的插件请求 IDE 能力（已授权）：renderer 执行后经 `ResolveIdeRequest` 交回。 */
	private readonly _onDidIdeRequest = this._register(new Emitter<IDshIdeRequest>());
	/** 在途的 IDE 能力请求：id → 等 renderer 回执。 */
	private readonly _idePending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; grace?: ReturnType<typeof setTimeout> }>();
	/**
	 * 谁认领了哪次请求（多窗口下 `OnIdeRequest` 是广播，没有它同一个请求会被执行 N 次）。
	 * 认领在 renderer 执行**之前**，失败者不执行也不回执（详见 `common/dshIdeClaims.ts`）。
	 */
	private readonly _ideClaims = new IdeRequestClaims();
	/**
	 * 定向投递后的"**宽限广播**"窗口（毫秒）：这么久没人认领就退回广播一次。
	 *
	 * 为什么不直接信任定向：`sendWhenReady` 只保证"窗口就绪就发"，不保证那个窗口的
	 * `DshHarnessService` 已经注册了监听（窗口刚开、视图在重建时会漏）⇒ 请求会一直挂到超时。
	 * 宽限广播是纯保险：认领簿保证同一个请求只执行一次，重复投递只会被丢弃。
	 */
	private readonly _ideTargetedGraceMs = 1_500;
	private _ideSeq = 0;
	private _bootstrapping: Promise<IDshHostStatus> | undefined;
	/**
	 * 「真·积分」探针代理（2026-10-11）：把 dsh 路由的 baseURL 改指本地代理，代理转发到真实网关时
	 * 读出 SSE 末块的 `usage.credit` —— dsh 内部（`dsh-llm-pi-ai` 的 `mapUsage` + `TurnTokenUsage`）
	 * 只保留 token 桶，积分在底层就被丢掉了，只能在链路上抓。见 `dshCreditProxy.ts` 文件头。
	 */
	private readonly _creditProxy: DshCreditProxy;

	constructor(
		options: IDshHarnessChannelOptions,
		windowsMainService: IWindowsMainService,
		auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
		private readonly _logService: ILogService,
	) {
		super();
		const log = (line: string) => this._logService.info(`[dshHarness] ${line}`);
		this._fetch = options.fetch ?? ((url: string) => net.fetch(url));
		// 内置运行时目录（构建期 prepack，见 build/prepack-dsh-runtime.mjs）：存在即传给管理器，
		// 解析顺序 setting → managed → bundled → global（bundled 只在全新安装时兜底）。
		const bundledRuntime = join(app.getAppPath(), 'dsh-runtime');
		this._runtime = new DshRuntimeManager(options.managedRoot ?? join(options.userDataPath, 'dsh-runtime'), log, existsSync(bundledRuntime) ? bundledRuntime : undefined);
		// 随包插件根：`vssaros-bridge` / `vssaros-chat-surface` / **模块插件**都在这一层。
		// 伴生插件的解析与插件中心「随包」段的枚举**必须同源**（否则会出现"列表里有、装的时候找不到"）。
		this._bundledPluginsRoot = options.bundledPluginsPath ?? join(app.getAppPath(), 'dsh-plugins');
		const bundledBridge = join(this._bundledPluginsRoot, 'vssaros-bridge');
		const bundledChatSurface = join(this._bundledPluginsRoot, 'vssaros-chat-surface');
		// 知识库 `@` 引用源（2026-10-14 P1-1，纯客户端）：与 chat-surface 同一条"存在才装"路径 ✓。
		const bundledKbRefs = join(this._bundledPluginsRoot, 'vssaros-kb-refs');
		// Host 侧的 `browser` / `unreal_*` 插件（README 4.69 Step 1）：与上面两个伴生插件**同一条路径规则**
		// （都在随包 `dsh-plugins/` 那一层，由伴生段逐个装 —— 它们没有 `vssaros.module`，不进模块自发现）。
		const bundledBrowser = join(this._bundledPluginsRoot, 'vssaros-browser');
		const bundledUnreal = join(this._bundledPluginsRoot, 'vssaros-unreal');
		// 随包 **vendored 第三方技能包**（archify，MIT）：与上面几个同一条"存在才装"路径 ✓。
		// 它没有 `vssaros.module`（技能 bundle，不是我们的 UI 模块）⇒ 不进模块自发现，也不算进「随包」列表 ✓。
		const bundledArchify = join(this._bundledPluginsRoot, 'vssaros-archify');
		// 共享运行时服务插件（重构 1.3）：所有模块插件的底座（dataRoot/dshHome/pageShell/lock 的唯一真源），
		// 同一条"存在才装"路径；安装顺序上它排在模块插件之前（见 supervisor 的插件清单）。
		const bundledFoundation = join(this._bundledPluginsRoot, 'vssaros-foundation');
		// 模块插件（agents / skills / mcp / kb / memory / codebase / kanban / workflow / dashboard / ide）：
		// **全部随包自动安装**（2026-10-11 用户要求）。清单**自发现**而不是在这里列名 —— 判据是插件自己的
		// `vssaros.module` 清单（`listBundledPlugins`，与插件中心「随包」段、容器聚合表同一真源）
		// ⇒ 将来新增模块只需把包放进 `dsh-plugins/`，不必再改宿主三处（硬编码清单的漂移不报错 ✗）。
		const bundled = listBundledPlugins(this._bundledPluginsRoot);
		const modulePluginDirs = bundled.packages.map(p => [p.name, p.dir] as const);
		log(`bundled module plugins: ${modulePluginDirs.map(([n]) => n).join(', ') || '(none)'}`);
		// 「非模块插件」是 bridge / chat-surface 被跳过的正常情况，不刷日志；其余（坏 package.json 等）留痕。
		for (const problem of bundled.problems.filter(p => !p.includes('非模块插件'))) {
			log(`bundled plugin scan: ${problem}`);
		}
		this._supervisor = this._register(new DshHostSupervisor({
			runtime: this._runtime,
			runDir: join(options.userDataPath, 'dsh-run'),
			bridgePluginDir: existsSync(join(bundledBridge, 'package.json')) ? bundledBridge : undefined,
			foundationPluginDir: existsSync(join(bundledFoundation, 'package.json')) ? bundledFoundation : undefined,
			chatSurfacePluginDir: existsSync(join(bundledChatSurface, 'package.json')) ? bundledChatSurface : undefined,
			kbRefsPluginDir: existsSync(join(bundledKbRefs, 'package.json')) ? bundledKbRefs : undefined,
			browserPluginDir: existsSync(join(bundledBrowser, 'package.json')) ? bundledBrowser : undefined,
			unrealPluginDir: existsSync(join(bundledUnreal, 'package.json')) ? bundledUnreal : undefined,
			archifyPluginDir: existsSync(join(bundledArchify, 'package.json')) ? bundledArchify : undefined,
			modulePluginDirs,
			defaultDshHome: options.isBuilt ? undefined : join(options.userDataPath, 'dsh-home'),
			instanceId: `vssaros-${process.pid}-${generateUuid().slice(0, 8)}`,
			log,
			// 启动阶段进度透传到状态区（profile 初始化/伴生插件 i/n/Host 启动）。
			onProgress: line => this._onDidProgress.fire(line),
			// 反向通道（Host → IDE）的处理器：**在桥客户端创建时**注册（不是等状态变化）——
			// 早先写在下面 `_applyConnection` 里，而桥客户端建好前状态可能已是 running 且之后不再变，
			// 于是处理器被永久跳过：真机 e2e 里客户端回"IDE 侧没有处理 ide.request"（README 4.55）。
			reverseRequestHandler: request => this._ideGate.handle(request),
		}));
		this._views = this._register(new DshViewHost(windowsMainService, auxiliaryWindowsMainService, _logService, options.preloadPath));
		this._workspaces = this._register(new DshWorkspaceSync(log));
		this._register(windowsMainService.onDidDestroyWindow(w => this._workspaces.removeWindow(w.id)));
		this._register(this._supervisor.onDidChangeStatus(status => {
			void this._applyConnection();
			this._onDidChangeStatus.fire(status);
		}));
		this._pluginActivation = new DshPluginActivationStore(() => this._supervisor.profileDirectory(), log);
		this._gate = new DshUpgradeGate(this._supervisor, this._runtime, join(options.userDataPath, 'dsh-snapshots'), log);
		this._compatBundledPath = options.compatBundledPath ?? join(app.getAppPath(), 'dsh-plugins', 'dsh-compat.json');
		this._bridgeInfo = readBridgeInfo(bundledBridge);
		this._userDataPath = options.userDataPath;
		// ⚠ 代理必须在构造函数体里建（不能在字段初始化里）：`userDataPath`/`log` 那时才就位 ✓。
		//   `userDataPath` 是"baseURL 跨进程稳定"的前提（2026-10-15，见 `dshCreditProxy.ts` 文件头 §2）。
		this._creditProxy = this._register(new DshCreditProxy({
			onSample: sample => this._onCreditSample(sample),
			userDataPath: options.userDataPath,
			log,
		}));
		// ★ 2026-10-15（用户报"积分 chip 一直 —"）：页面侧的样本池是**活推送**（chunk 级数组，
		//   页面重载即清零 ✗）⇒ 视图就绪后由 viewHost 把最近样本**回放**一遍（负载形状与
		//   `_onCreditSample` 的活推送同一份 ✓）。
		this._views.setCreditReplaySource(() => this._creditProxy.recentSamples.map(s => ({
			route: s.route,
			...(s.model === undefined ? {} : { model: s.model }),
			...(s.credit === undefined ? {} : { credit: s.credit }),
			...(s.status === undefined ? {} : { status: s.status }),
			at: s.at,
		})));
		// 抢先启动：与窗口/工作台启动并行（渲染进程那份预热抢不过"聊天框随布局挂载即启动"）。
		void this._eagerPrewarm();
	}

	// ─── 抢先启动（主进程侧）────────────────────────────────────────────────────

	private readonly _userDataPath: string;
	/** 抢先启动所用的选项；渲染进程随后的 Start 用它判断"能不能直接复用"。 */
	private _prewarmedWith: IDshHostStartOptions | undefined;

	/**
	 * 用上一次的启动选项抢先起 Host。仅当设置允许（enabled/prewarm 非 false、chatEngine≠legacy）
	 * 且存在上次选项时才做；失败只记日志——渲染进程随后的 Start 会照常走完整错误/引导路径。
	 *
	 * 选项来源：上次 Start 落盘的 `dsh-run/last-start.json`（路径类选项）+ 本次 settings.json 的
	 * 用户设置覆盖（runtimePath/nodePath/dshHome/profile 以设置为准）。
	 */
	private async _eagerPrewarm(): Promise<void> {
		try {
			const persisted = this._readLastStart();
			if (!persisted) {
				return; // 首次运行：没有可复用的选项，退回渲染进程触发
			}
			const s = this._readUserSettings();
			if (s['sessions.dshHarness.enabled'] === false || s['sessions.dshHarness.prewarm'] === false || s['sessions.dshHarness.chatEngine'] === 'legacy') {
				return;
			}
			const pick = (key: string, fallback: string | undefined) => {
				const v = s[key];
				return typeof v === 'string' && v.trim() ? v.trim() : fallback;
			};
			const opts: IDshHostStartOptions = {
				...persisted,
				runtimePath: pick('sessions.dshHarness.runtimePath', persisted.runtimePath),
				nodePath: pick('sessions.dshHarness.nodePath', persisted.nodePath),
				dshHome: pick('sessions.dshHarness.dshHome', persisted.dshHome),
				profile: pick('sessions.dshHarness.profile', persisted.profile),
				// 抢先启动发生在渲染进程之前，读不到配置服务 ⇒ 与其它几项一样直接读 `User/settings.json`。
				skipPluginInstall: s['sessions.dshHarness.skipPluginInstall'] === true,
			};
			this._prewarmedWith = opts;
			this._logService.info('[dshHarness] prewarming Host from the main process (parallel to workbench startup)');
			const status = await this._supervisor.start(opts);
			this._logService.info(`[dshHarness] prewarm result: ${status.state}${status.error ? ` (${status.error})` : ''}`);
		} catch (e) {
			this._prewarmedWith = undefined;
			this._logService.warn(`[dshHarness] prewarm failed: ${String((e as Error)?.message ?? e)}`);
		}
	}

	/** 上次启动选项的落盘位置（`<userData>/dsh-run/last-start.json`）。 */
	private _lastStartFile(): string {
		return join(this._userDataPath, 'dsh-run', 'last-start.json');
	}

	private _readLastStart(): IDshHostStartOptions | undefined {
		try {
			const p = this._lastStartFile();
			if (!existsSync(p)) {
				return undefined;
			}
			const parsed = JSON.parse(readFileSync(p, 'utf8')) as IDshHostStartOptions;
			return parsed && typeof parsed === 'object' ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * 记住本次启动选项（供下次抢先启动用）；失败不影响启动。
	 *
	 * 异步落盘（fire-and-forget）：这只是 best-effort 的备忘（写不进去 = 下次少一次抢先启动），
	 * 而**主线程上的同步写**一旦撞上 I/O 卡死（2026-10-12 三次 `NtWriteFile` 现场）就是整个 IDE
	 * 假死。本次启动的判断依据是内存里的 `_prewarmedWith` ⇒ 不需要等它落盘。
	 */
	private _rememberStart(opts: IDshHostStartOptions): void {
		const p = this._lastStartFile();
		void fsp.mkdir(join(this._userDataPath, 'dsh-run'), { recursive: true })
			.then(() => fsp.writeFile(p, JSON.stringify(opts, undefined, 2)))
			.catch(e => this._logService.warn(`[dshHarness] rememberStart failed: ${String((e as Error)?.message ?? e)}`));
	}

	/** 读 `<userData>/User/settings.json`（机器级设置就落在这份文件里）；读不到返回 {}。 */
	private _readUserSettings(): Record<string, unknown> {
		try {
			const p = join(this._userDataPath, 'User', 'settings.json');
			const parsed = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}

	private readonly _compatBundledPath: string;
	/** 随包插件根（`<appPath>/dsh-plugins`）：伴生插件解析 + 「随包」段枚举同源。 */
	private readonly _bundledPluginsRoot: string;
	private readonly _bridgeInfo: { version?: string; peerRange?: string };
	private readonly _workspaces: DshWorkspaceSync;
	private _connectionGen = 0;

	/**
	 * 连接变化时：先把连接交给视图池（页面立刻开始加载），同时经控制桥注册各窗口的工作区
	 * （方案第 8.2 节"页面首次打开之前"）。实测注册约 20–30 ms、页面首字节约 0.5 s，
	 * 因此注册总在页面真正被服务之前完成；不阻塞页面加载可以避免 Host 起来后视图空等。
	 * 断开立即生效。没有控制桥（退回 URL 行）时只下发连接。
	 */
	private async _applyConnection(): Promise<void> {
		const gen = ++this._connectionGen;
		const conn = this._supervisor.connection;
		const bridge = conn ? this._supervisor.bridge : undefined;
		// 反向通道的处理器**不在这里注册**：`supervisor` 在桥客户端创建时就挂好了（见其 options
		// `reverseRequestHandler`）——在这里按"状态变化"注册会漏掉"客户端尚未建好"的那段时间。
		if (conn) {
			this._views.setConnection(conn);
		}
		const t0 = Date.now();
		await this._workspaces.connect(bridge ? paths => bridge.call<IBridgeWorkspace[]>(DshBridgeMethod.WorkspaceEnsure, { paths }, 30_000) : undefined);
		if (gen !== this._connectionGen) {
			return;
		}
		this._logService.info(`[dshHarness] workspace ensure: ${Date.now() - t0} ms (${this._workspaces.state.results.length} path(s))`);
		// 诊断（用户机器上"workspace 加载慢"排查）：紧跟注册之后探一次桥往返。若这里也是秒级，
		// 说明慢的不是 workspace 注册本身，而是 Host 刚 ready 时事件循环被页面/插件启动占满。
		if (this._supervisor.bridge) {
			const tp = Date.now();
			try {
				await this._supervisor.bridge.call<unknown>(DshBridgeMethod.WorkspaceList, undefined, 15_000);
			} catch { /* 探针失败不影响流程 */ }
			this._logService.info(`[dshHarness] bridge probe after ensure: ${Date.now() - tp} ms`);
		}
		if (!conn) {
			this._views.setConnection(undefined);
		}
	}

	/**
	 * 反向请求（Host → IDE）的闸门：授权在 `DshIdeRequestGate` 里（可单测），这里只供它两个回调。
	 * `ide.echo`（自检）由桥客户端**内建**应答，到不了闸门。
	 */
	private readonly _ideGate = new DshIdeRequestGate({
		readDeclarations: () => this._readIdeDeclarations(),
		dispatch: (request, timeoutMs) => this._requestIdeInRenderer(request, timeoutMs),
		log: line => this._logService.warn(`[dshHarness] ${line}`),
		// 审计：每条已授权的 ide.request 记一行（info 级，进日志文件、不当告警）——`pluginId` 是调用方
		// 自报的，留痕至少让"哪个插件在驱动 IDE、要的是什么能力"事后可查。
		trace: line => this._logService.info(`[dshHarness] ${line}`),
	});

	/** 读 profile 里已装插件的清单，抽出各家声明的 `vssaros.ideCapabilities`（授权的数据源）。 */
	private _readIdeDeclarations(): ReturnType<typeof readCapabilityDeclarations> {
		const profileDir = this._supervisor.profileDirectory();
		const manifests = new Map<string, unknown>();
		for (const plugin of this._supervisor.listPlugins()) {
			try {
				manifests.set(plugin.name, JSON.parse(readFileSync(join(profileDir, 'node_modules', plugin.name, 'package.json'), 'utf8')));
			} catch {
				// 读不了 ⇒ 该插件零能力（不给它任何放行）
			}
		}
		return readCapabilityDeclarations(manifests);
	}

	/**
	 * 把**已授权**的请求交给 renderer 执行（IDE 状态在渲染进程），等回执。
	 * 超时/没人接都明确报错——错误文案直接指向"能力实现是否已接"，免得又变成一次无声的挂起。
	 */
	private _requestIdeInRenderer(request: Omit<IDshIdeRequest, 'id'>, timeoutMs: number): Promise<unknown> {
		// 先判目标：**同一个会话同时在两个窗口开着 ⇒ 明确拒绝**（README 4.49）。
		// 不"取第一个"也不"退回广播"：两者都是猜，猜错就是用户直接看到的错（文件开在他没看的窗口）。
		// 这种状态有据可查（会话 id 不含窗口号 ⇒ 两窗口开同一工作区就会落到同一会话），说得清就该说不清在哪。
		const pick = pickIdeTargetWindow(this._views.viewSlots(), request.sessionId);
		if (pick.kind === 'ambiguous') {
			const windows = pick.windowIds.join(' / ');
			this._logService.warn(`[dshHarness] 拒绝 IDE 能力 ${request.capability}：会话 ${String(request.sessionId)} 同时在窗口 ${windows} 打开（无法判断结果该落在哪）`);
			return Promise.reject(new Error(`会话 ${String(request.sessionId)} 同时在窗口 ${windows} 打开：无法判断 ${request.capability} 的结果该落在哪个窗口。请只在一个窗口打开这个会话（关掉其它窗口里的那个聊天），再重试`));
		}
		const id = ++this._ideSeq;
		const payload: IDshIdeRequest = { id, ...request };
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._idePending.delete(id);
				this._ideClaims.release(id);
				this._clearIdeGrace(id);
				reject(new Error(`IDE 能力 ${request.capability} 超时（${timeoutMs}ms）：renderer 没有回执（该能力的实现是否已接？）`));
			}, timeoutMs);
			this._idePending.set(id, { resolve, reject, timer });
			this._dispatchIdeRequest(payload, pick);
		});
	}

	/**
	 * 下发一次已授权的请求：**能定位到"正在跑这个会话的窗口"就定向投递**，否则广播（行为与从前一致）。
	 *
	 * 定位靠请求里的 `sessionId`（Host 侧从 `exec.agent.session.id` 取）+ `DshViewHost` 记的
	 * `ownerWindowId`（策略在 `common/dshIdeTargeting.ts`）。定位不到（没带 sessionId / 没有窗口绑着该会话 /
	 * 窗口已经关了）就退回广播——**新机制不会成为"请求发不出去"的故障源**。
	 */
	private _dispatchIdeRequest(payload: IDshIdeRequest, pick: IIdeTargetPick): void {
		if (pick.kind !== 'window' || !this._views.sendToWindow(pick.windowId, DSH_HARNESS_CHANNEL, DshHarnessChannelEvent.OnIdeRequest, payload)) {
			// 定位不到（没带 sessionId / 没有窗口绑着该会话）或窗口已关 ⇒ 保持广播（与从前一致）
			this._onDidIdeRequest.fire(payload);
			return;
		}
		const target = pick.windowId;
		const grace = setTimeout(() => {
			if (this._idePending.has(payload.id)) {
				this._logService.warn(`[dshHarness] 窗口 ${target} 未在 ${this._ideTargetedGraceMs}ms 内认领 ${payload.capability}（会话 ${String(payload.sessionId)}）⇒ 退回广播`);
				this._onDidIdeRequest.fire(payload);
			}
		}, this._ideTargetedGraceMs);
		const pending = this._idePending.get(payload.id);
		if (pending) {
			pending.grace = grace;
		}
	}

	/**
	 * `entryId`（宿主侧的存活条目 id，形如 `include:vssaros-chat-surface`）→ 该条目在 profile patch 里的
	 * **补丁行 id** 与**模块名**。
	 *
	 * 为什么需要：行级启停的文件级兜底写的是 profile `cordis.patch.yml` 里的**补丁行**，而 renderer 传过来
	 * 的是 `entryId`。两者不同名（前者不带 `include:` 前缀），dsh 自己也是这么换算的
	 * （`dsh-plugin-manager:1656`：`writePluginEnabled(this.profile.patchPath, row.patchId, row.moduleName, …)`）——
	 * **必须查这张表**：查不到就不写（宁可如实报失败，也不猜一个 id 写进组合）。`moduleName` 一并带走，
	 * 因为 dsh 的条目匹配还要求 `name` 对得上（同名不同模块的残留行不该被改）。
	 */
	private async _patchRowOf(entryId: string): Promise<{ readonly patchId: string; readonly moduleName?: string } | undefined> {
		const bridge = this._supervisor.bridge;
		if (!bridge) {
			return undefined;
		}
		try {
			const rows = await bridge.call<readonly IBridgePluginRow[]>(DshBridgeMethod.PluginsList, undefined, 20_000);
			const row = (rows ?? []).find(item => item.entryId === entryId && !!item.patchId);
			return row?.patchId ? { patchId: row.patchId, ...(row.moduleName ? { moduleName: row.moduleName } : {}) } : undefined;
		} catch (e) {
			this._logService.warn(`[dshHarness] 查补丁行失败（entryId=${entryId}）：${String((e as Error)?.message ?? e)}`);
			return undefined;
		}
	}

	/** 撤掉宽限广播（有人认领 / 已回执 / 已超时都不该再广播一次）。 */
	private _clearIdeGrace(id: number): void {
		const pending = this._idePending.get(id);
		if (pending?.grace !== undefined) {
			clearTimeout(pending.grace);
			pending.grace = undefined;
		}
	}

	/** 发现所需的外部输入：dist-tags（失败时为空）与兼容清单。 */
	private async _updateContext(policy: IDshUpdatePolicy, node: IResolvedNode | undefined) {
		const notes: string[] = [];
		let distTags: Record<string, string> = {};
		if (node) {
			try {
				distTags = await this._runtime.distTags(node);
			} catch (e) {
				notes.push(`npm dist-tags 查询失败：${String((e as Error)?.message ?? e).slice(0, 200)}`);
			}
		} else {
			notes.push('没有可用的 Node，无法查询 npm。');
		}
		const compat = await loadCompatManifest({
			bundledPath: this._compatBundledPath,
			remoteUrl: policy.compatUrl,
			cachePath: join(this._runtime.managedRoot, 'compat-cache.json'),
			fetch: this._fetch,
			log: line => this._logService.info(`[dshHarness] ${line}`),
		});
		notes.push(...compat.errors);
		return { distTags, manifest: compat.manifest, manifestSource: compat.source, bridge: this._bridgeInfo, notes };
	}

	private async _discover(policy: IDshUpdatePolicy, start: IDshHostStartOptions): Promise<IDshUpdateDiscoveryResult> {
		let node: IResolvedNode | undefined;
		try {
			node = await this._runtime.resolveNode(start.nodePath);
		} catch {
			node = undefined;
		}
		const ctx = await this._updateContext(policy, node);
		const installed = this._runtime.listInstalled();
		const current = resolveCurrentVersion({
			runtimePath: start.runtimePath,
			runningVersion: this._supervisor.status.dshVersion,
			managedVersion: selectRuntimeVersion(this._runtime.readState(), installed),
		});
		const d = discoverUpdates({
			channel: policy.channel, pinned: policy.pinned, current, installed, distTags: ctx.distTags, manifest: ctx.manifest,
			bridgePeerRange: ctx.bridge.peerRange, bridgeVersion: ctx.bridge.version, nodeVersion: node?.version,
			// ★ 2026-10-12：随包**模块插件**的 peer 范围也要过一遍（预检 ③）—— 运行时升到范围外时，
			//   dsh 的准入检查会让那个插件失效，而用户只看到"某个模块凭空消失"✗。
			modulePluginPeerRanges: listBundledPlugins(this._bundledPluginsRoot).packages.map(p => ({ name: p.name, range: p.peerRange ?? '' })),
		});
		if (start.runtimePath?.trim()) {
			ctx.notes.push('设置 sessions.dshHarness.runtimePath 指定了 dsh 位置：托管版本切换不会生效。');
		}
		return { ...d, notes: [...d.notes, ...ctx.notes], manifestSource: ctx.manifestSource, manifestGeneratedAt: ctx.manifest?.generatedAt };
	}

	private async _upgrade(a: IDshUpgradeArgs): Promise<IDshUpgradeResult> {
		if (a.installIfMissing && !this._runtime.listInstalled().includes(a.version)) {
			const node = await this._runtime.resolveNode(a.nodePath ?? a.start.nodePath);
			this._onDidProgress.fire(`正在并列安装 dsh ${a.version}（当前 Host 保持运行）…`);
			await this._runtime.install(a.version, node);
		}
		this._onDidProgress.fire(`正在切换到 dsh ${a.version}：快照、重启并检查…`);
		return this._gate.upgrade({ version: a.version, force: a.force }, a.start ?? {});
	}

	/**
	 * 一键准备：缺 Node 就下载托管 Node，缺 dsh 就安装 npm `latest`（或指定 tag）并设为当前，然后启动。
	 * 只补缺的部分；已有的 Node / dsh 不会被替换。
	 */
	private _bootstrap(args: IDshBootstrapArgs): Promise<IDshHostStatus> {
		if (!this._bootstrapping) {
			this._bootstrapping = (async () => {
				let node: IResolvedNode;
				try {
					node = await this._runtime.resolveNode(args.start.nodePath);
				} catch (e) {
					if (!(e instanceof DshRuntimeError) || e.code !== 'node-missing' || args.start.nodePath?.trim()) {
						throw e;
					}
					this._onDidProgress.fire('正在下载并校验托管 Node…');
					const installed = await this._runtime.installNode(this._fetch, { mirror: args.nodeMirror });
					this._onDidProgress.fire(`托管 Node ${installed.version} 已就绪`);
					node = await this._runtime.resolveNode(undefined);
				}
				try {
					await this._runtime.resolveDsh(args.start.runtimePath, node);
				} catch (e) {
					if (!(e instanceof DshRuntimeError) || e.code !== 'dsh-missing') {
						throw e;
					}
					this._onDidProgress.fire('正在确定要安装的 dsh 版本…');
					const ctx = await this._updateContext(args.policy, node);
					const version = selectInstallTarget({ channel: args.policy.channel, pinned: args.policy.pinned, installed: [], distTags: ctx.distTags, manifest: ctx.manifest, bridgePeerRange: ctx.bridge.peerRange, bridgeVersion: ctx.bridge.version, nodeVersion: node.version });
					if (!version) {
						throw new Error(`无法确定要安装的 dsh 版本：${ctx.notes.join('；') || '兼容清单与 npm dist-tags 都不可用'}`);
					}
					this._onDidProgress.fire(`正在安装 dsh ${version}（首次约 1–2 分钟）…`);
					await this._runtime.install(version, node);
					await this._runtime.setCurrent(version);
				}
				this._onDidProgress.fire('正在启动 Host…');
				return this._supervisor.start(args.start);
			})().finally(() => this._bootstrapping = undefined);
		}
		return this._bootstrapping;
	}

	/** 已装插件 + 启停状态（= 是否在 profile 的 `dsh.profile.bundles` 里）；插件中心的行数据。 */
	private async _listPluginsWithActivation(): Promise<IDshPluginInfo[]> {
		const pkg = await this._pluginActivation.read();
		return this._supervisor.listPlugins().map(p => ({
			...p,
			enabled: isBundleEnabled(pkg, p.name),
			// 2026-10-16（重构 1.1，清单驱动的壳）：清单一并下发，渲染端的 ActivityBar / 页面路由都按它算，
			// 不再靠壳里的硬编码表。读不动/不合法 ⇒ 不带 manifest（该插件不激活模块，不猜字段）。
			manifest: this._readPluginManifest(p.name),
		}));
	}

	/** 读一个已装插件的 `vssaros` 清单并校验；不合法返回 undefined 并记日志。 */
	private _readPluginManifest(name: string): IVssarosPluginManifest | undefined {
		try {
			const raw = JSON.parse(readFileSync(join(this._supervisor.profileDirectory(), 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))?.vssaros;
			if (raw === undefined) {
				return undefined;
			}
			const { manifest, error } = tryParseVssarosManifest(raw, { pluginName: name, builtin: isBuiltinPluginName(name) });
			if (!manifest) {
				this._logService.info(`[dshHarness] ${name} 的 vssaros 清单不合法（不激活它的模块）：${error}`);
				return undefined;
			}
			return manifest;
		} catch {
			return undefined;
		}
	}

	/**
	 * 随包模块插件清单（含 profile 里的实装版本）——插件中心「随包」段的数据源。
	 *
	 * 枚举根 = `_bundledPluginsRoot`（与 bridge / chat-surface 的解析同源，否则会出现"列表里有、
	 * 装的时候找不到"）；已装信息复用 `_listPluginsWithActivation()`（同一口径：**停用**的包也要让
	 * 界面能说清"装了但关着"）。读不动/非模块包不静默丢——`listBundledPlugins` 会把它们放进
	 * `problems`，这里落一条日志（探针排障要看得出"目录里有东西却没列出来"）。
	 */
	private async _listBundledPlugins(): Promise<IDshBundledPluginRow[]> {
		const { packages, problems } = listBundledPlugins(this._bundledPluginsRoot);
		if (problems.length) {
			this._logService.info(`[dshHarness] 随包插件目录 ${this._bundledPluginsRoot}：${problems.join('；')}`);
		}
		return mergeBundledWithInstalled(packages, await this._listPluginsWithActivation());
	}

	/**
	 * 把 `providers.sync` 负载里的 baseURL 换成**计费探针代理**地址（真实网关地址登记到代理表）。
	 *
	 * 失败（代理起不来）时**原样返回**：宁可这一轮没有积分，也绝不能让模型接入断掉（可降级原则）。
	 */
	private async _rewriteForCreditProxy(args: IBridgeProvidersSyncArgs): Promise<IBridgeProvidersSyncArgs> {
		try {
			const providers = await Promise.all(args.providers.map(async p => ({
				...p,
				baseURL: await this._creditProxy.routeBaseURL(p.route, p.baseURL),
			})));
			return { ...args, providers };
		} catch (e) {
			this._logService.warn(`[dshCredit] 探针代理未就绪，本次按直连下发（本轮积分不可见）: ${String((e as Error)?.message ?? e)}`);
			return args;
		}
	}

	/**
	 * 计费样本落点：① 落日志（核对"代理是否真的抓到了积分"）；② 推给 dsh 页面，
	 * 由 chat-surface 的回合页脚渲染「积分」chip（含按回合时间窗归属）。
	 *
	 * 推送负载只带展示数值与归属线索（route/model/at/credit/status），**不含**请求体或凭据。
	 */
	private _onCreditSample(sample: IDshCreditSample): void {
		const credit = sample.credit === undefined ? '(该响应无 credit 字段)' : sample.credit;
		this._logService.info(`[dshCredit] route=${sample.route} model=${sample.model ?? '?'} status=${sample.status ?? '?'} credit=${credit}`);
		this._views.pushCredit({
			route: sample.route,
			...(sample.model === undefined ? {} : { model: sample.model }),
			...(sample.credit === undefined ? {} : { credit: sample.credit }),
			...(sample.status === undefined ? {} : { status: sample.status }),
			at: sample.at,
		});
	}

	/** 清单 + HMR 状态（HMR 决定改完组合是热重载还是需重启）。 */
	private async _pluginActivationSnapshot(): Promise<IDshPluginActivationSnapshot> {
		return { plugins: await this._listPluginsWithActivation(), hmr: await this._pluginActivation.hmrState() };
	}

	listen<T>(_ctx: TContext, event: string): Event<T> {
		if (event === DshHarnessChannelEvent.OnDidChangeStatus) {
			return this._onDidChangeStatus.event as Event<T>;
		}
		if (event === DshHarnessChannelEvent.OnDidProgress) {
			return this._onDidProgress.event as Event<T>;
		}
		if (event === DshHarnessChannelEvent.OnDidWorkspaceSync) {
			return this._workspaces.onDidSync as Event<T>;
		}
		if (event === DshHarnessChannelEvent.OnDidPageEvent) {
			return this._views.onDidPageEvent as Event<T>;
		}
		if (event === DshHarnessChannelEvent.OnDidChangePlugins) {
			return this._onDidChangePlugins.event as Event<T>;
		}
		if (event === DshHarnessChannelEvent.OnIdeRequest) {
			return this._onDidIdeRequest.event as Event<T>;
		}
		throw new Error(`[dshHarness] unknown event: ${event}`);
	}

	async call<T>(_ctx: TContext, command: string, arg?: any): Promise<T> {
		return this._call(command, arg) as Promise<T>;
	}

	private async _call(command: string, arg: any): Promise<unknown> {
		switch (command) {
			case DshHarnessChannelCommand.GetStatus:
				return this._supervisor.status;
			case DshHarnessChannelCommand.Start: {
				const opts = (arg ?? {}) as IDshHostStartOptions;
				// 主进程抢先启动过（`_eagerPrewarm`）：选项与抢先那次相同 → 直接复用（这正是"零等待"）；
				// 不同（用户改了 runtimePath/工作区/技能库…）→ 重启，避免"跑着旧配置却被当成新配置"。
				// running 与 starting 都算：starting 时 restart 会先取消在途启动，否则调用方会拿到
				// 旧选项起出来的 Host。
				const prewarmLive = this._supervisor.status.state === 'running' || this._supervisor.status.state === 'starting';
				if (this._prewarmedWith && prewarmLive && !sameStartOptions(this._prewarmedWith, opts)) {
					this._logService.info('[dshHarness] prewarmed Host started with different options; restarting to match the renderer request');
					this._prewarmedWith = undefined;
					const restarted = await this._supervisor.restart(opts);
					this._rememberStart(opts);
					return restarted;
				}
				this._prewarmedWith = undefined;
				const started = await this._supervisor.start(opts);
				this._rememberStart(opts);
				return started;
			}
			case DshHarnessChannelCommand.Stop:
				return this._supervisor.stop();
			case DshHarnessChannelCommand.Restart:
				return this._supervisor.restart(arg as IDshHostStartOptions);
			case DshHarnessChannelCommand.GetLog:
				return this._supervisor.getLog();
			case DshHarnessChannelCommand.RequestActionConsent: {
				// 渲染侧 → 主进程 → 桥 → Host 的审批服务（卡片由 `dsh-client-ui-approval` 渲染）⇒ 与 dsh 侧
				// 能力**同一张**卡；fail-closed 与超时口径都在 supervisor 那一层（README 4.84 / 4.86）。
				const consent = arg as { title?: string; detail?: string } | undefined;
				const allowed = await this._supervisor.requestActionConsent({
					toolName: 'canvas',
					reason: String(consent?.title ?? 'IDE 侧能力请求执行有副作用的操作'),
					...(consent?.detail ? { displayReason: { zh: String(consent.detail) } } : {}),
				});
				return { allowed };
			}
			case DshHarnessChannelCommand.ListPlugins:
				return this._listPluginsWithActivation();
			case DshHarnessChannelCommand.GetPluginActivation:
				return await this._pluginActivationSnapshot();
			case DshHarnessChannelCommand.SetPluginEnabled: {
				const { name, enabled } = (arg ?? {}) as { name?: unknown; enabled?: unknown };
				if (typeof name !== 'string' || !name.trim() || typeof enabled !== 'boolean') {
					throw new Error('[dshHarness] setPluginEnabled: 需要 { name: string, enabled: boolean }');
				}
				const pluginName = name.trim();
				// 只允许切换 profile 里真实存在的插件（防手改组合凭空塞条目）。
				if (!this._supervisor.listPlugins().some(p => p.name === pluginName)) {
					throw new Error(`[dshHarness] setPluginEnabled: profile 里没有这个插件：${pluginName}`);
				}
				const { changed } = await this._pluginActivation.setEnabled(pluginName, enabled);
				if (changed) {
					this._onDidChangePlugins.fire();
				}
				return { ...await this._pluginActivationSnapshot(), changed };
			}
			case DshHarnessChannelCommand.GetRuntimeInfo:
				return this._runtime.getInfo();
			case DshHarnessChannelCommand.InstallRuntime: {
				const { version, nodePath } = arg as { version: string; nodePath?: string };
				const node = await this._runtime.resolveNode(nodePath);
				const installed = await this._runtime.install(version, node);
				return { version: installed.version };
			}
			case DshHarnessChannelCommand.SetCurrentRuntime:
				return this._runtime.setCurrent((arg as { version: string }).version);
			case DshHarnessChannelCommand.InstallNode: {
				const a = (arg ?? {}) as { mirror?: string; version?: string };
				const r = await this._runtime.installNode(this._fetch, a);
				return { version: r.version, path: r.path };
			}
			case DshHarnessChannelCommand.Bootstrap:
				return this._bootstrap(arg as IDshBootstrapArgs);
			case DshHarnessChannelCommand.Upgrade:
				return this._upgrade(arg as IDshUpgradeArgs);
			case DshHarnessChannelCommand.SetWindowWorkspaces: {
				const a = arg as { windowId: unknown; paths: unknown };
				if (typeof a?.windowId !== 'number') {
					throw new Error('[dshHarness] setWindowWorkspaces: windowId required');
				}
				return this._workspaces.setWindowWorkspaces(a.windowId, a.paths);
			}
			case DshHarnessChannelCommand.SetWorkspaceContext: {
				// 运行期工作区上下文（2026-10-17）：形状先在这里卡住（畸形载荷不出进程 ✓），
				// 能不能**真的生效**由 Host 回执（`applied`）说了算 —— 见 supervisor 的同名方法 ✓。
				if (!validateWorkspaceContextArgs(arg)) {
					throw new Error('[dshHarness] setWorkspaceContext: 载荷形状不合法（workspaceId/workspaceRoot/relatedRoots/windowId/at）');
				}
				return this._supervisor.setWorkspaceContext(arg as IBridgeWorkspaceContextArgs);
			}
			case DshHarnessChannelCommand.GetWorkspaceSync:
				return this._workspaces.state;
			case DshHarnessChannelCommand.ListWorkspaces: {
				const bridge = this._supervisor.bridge;
				return bridge ? bridge.call<IBridgeWorkspace[]>(DshBridgeMethod.WorkspaceList, undefined, 10_000) : [];
			}
			case DshHarnessChannelCommand.StartSession: {
				const a = arg as IBridgeSessionStartArgs;
				const bridge = this._supervisor.bridge;
				if (!bridge) {
					throw new Error('[dshHarness] startSession: 控制桥不可用（未安装伴生插件或 Host 未运行）');
				}
				// 建会话/接管会话可能要先落工作区记录，给足时间；prompt 只投递消息，不等模型跑完。
				const ts = Date.now();
				const r = await bridge.call<IBridgeSessionStartResult>(DshBridgeMethod.SessionStart, a, 120_000);
				// 诊断：这条与 workspace 注册共用 dsh 的注册表排队器，耗时能直接看出"聊天要等多久"。
				this._logService.info(`[dshHarness] session.start: ${Date.now() - ts} ms (${a?.sessionId ?? ''})`);
				return r;
			}
			case DshHarnessChannelCommand.RunSession: {
				const a = arg as IBridgeSessionRunArgs;
				const bridge = this._supervisor.bridge;
				if (!bridge) {
					throw new Error('[dshHarness] runSession: 控制桥不可用（未安装伴生插件或 Host 未运行）');
				}
				// 要等整个回合跑完：超时给足（桥侧 runs.run 自身有 120s 默认上限，这里再加余量）。
				const ts = Date.now();
				const r = await bridge.call<IBridgeSessionRunResult>(DshBridgeMethod.SessionRun, a, (a?.timeoutMs ?? 120_000) + 30_000);
				this._logService.info(`[dshHarness] session.run: ${Date.now() - ts} ms (${a?.sessionId ?? ''}, stop=${r?.stopReason ?? '?'})`);
				return r;
			}
			case DshHarnessChannelCommand.CancelSession: {
				const a = arg as IBridgeSessionCancelArgs;
				const bridge = this._supervisor.bridge;
				if (!bridge) {
					throw new Error('[dshHarness] cancelSession: 控制桥不可用（未安装伴生插件或 Host 未运行）');
				}
				return bridge.call<IBridgeSessionCancelResult>(DshBridgeMethod.SessionCancel, a, 10_000);
			}
			// ─── 插件商城（方案 5.16 批次 2，只读面）：数据源是 Host 的 pluginManager。
			// 控制桥不可用时**明确报错**（不静默返回空——UI 要能区分"没插件"与"Host 没起来"）。
			case DshHarnessChannelCommand.ListBundledPlugins:
				return await this._listBundledPlugins();
			case DshHarnessChannelCommand.InstallBundledPlugin: {
				const { name } = (arg ?? {}) as { name?: unknown };
				if (typeof name !== 'string' || !name.trim()) {
					throw new Error('[dshHarness] installBundledPlugin: 需要 { name: string }');
				}
				const row = (await this._listBundledPlugins()).find(r => r.name === name.trim());
				if (!row) {
					throw new Error(`[dshHarness] installBundledPlugin: 随包里没有这个插件：${name}`);
				}
				const result = await this._supervisor.installBundledPlugin(row.name, row.dir);
				// 装上了就该让模块 ActivityBar 重算（与插件中心的启停同一事件）。
				if (result.changed) {
					this._onDidChangePlugins.fire();
				}
				return result;
			}
			/**
			 * 本地目录安装（**不走商城那条**）。
			 *
			 * 商城那条（`InstallDshPlugin` → Host 内 pluginManager）在**全新 profile** 上会把未被
			 * lockfile 声明的那棵树剪掉（实测 `Packages: -43`）并判 `operation-error`——首启用户
			 * 点"安装"必失败（README 4.86）。本地目录改由主进程暂存 + `dsh plugin add`，与随包一键安装、
			 * 启动时装伴生插件同源，已在新 profile 上验证可用。注册表 / git / tarball 仍走商城那条。
			 */
			case DshHarnessChannelCommand.InstallLocalPlugin: {
				const { spec } = (arg ?? {}) as { spec?: unknown };
				if (typeof spec !== 'string' || !spec.trim()) {
					throw new Error('[dshHarness] installLocalPlugin: 需要 { spec: string }');
				}
				const dir = localPluginDir(spec);
				if (!dir) {
					throw new Error(`[dshHarness] installLocalPlugin: 只接受本地绝对路径（注册表 / git / tarball 请走商城那条），收到：${spec.trim().slice(0, 120)}`);
				}
				const local = await this._supervisor.installLocalPlugin(dir);
				if (local.changed) {
					this._onDidChangePlugins.fire();
				}
				return local;
			}
			/**
			 * 按 **spec** 安装（`{ spec, name }`）——**不走商城那条**，理由与 `InstallLocalPlugin` 完全相同
			 * （全新 profile 上 Host 的 pluginManager 会 `operation-error` ✗），但 spec 不限于本地目录：
			 * 注册表 / git / tarball 都交给主进程的 `dsh plugin add` ✓。
			 *
			 * `name` 必填：装完要读 `<profile>/node_modules/<name>/package.json` 核对版本 ⇒ 名字由**预检结果**
			 * 给（界面侧选路真源 `agentStudio/common/dshPluginTransport.ts` 要求 `kind==='registry'` 且有名字
			 * 才走这条 ✓）。
			 */
			case DshHarnessChannelCommand.InstallPluginSpec: {
				const { spec, name } = (arg ?? {}) as { spec?: unknown; name?: unknown };
				if (typeof spec !== 'string' || !spec.trim()) {
					throw new Error('[dshHarness] installPluginSpec: 需要 { spec: string }');
				}
				if (typeof name !== 'string' || !name.trim()) {
					throw new Error('[dshHarness] installPluginSpec: 需要 { name: string }（装完用它核对版本）');
				}
				const installed = await this._supervisor.installPluginSpec(spec, name);
				if (installed.changed) {
					this._onDidChangePlugins.fire();
				}
				return installed;
			}
			case DshHarnessChannelCommand.ListDshBundles: {
				const bridge = this._supervisor.bridge;
				if (!bridge) {
					throw new Error('[dshHarness] listDshBundles: 控制桥不可用（Host 未运行或伴生插件未装）');
				}
				return bridge.call<IBridgeBundleInfo[]>(DshBridgeMethod.BundlesList, undefined, 20_000);
			}
			case DshHarnessChannelCommand.ListDshPluginRows: {
				const bridge = this._supervisor.bridge;
				if (!bridge) {
					throw new Error('[dshHarness] listDshPluginRows: 控制桥不可用（Host 未运行或伴生插件未装）');
				}
				return bridge.call<IBridgePluginRow[]>(DshBridgeMethod.PluginsList, undefined, 20_000);
			}
			case DshHarnessChannelCommand.GetDshPluginRegistries: {
				const bridge = this._supervisor.bridge;
				if (!bridge) {
					throw new Error('[dshHarness] getDshPluginRegistries: 控制桥不可用（Host 未运行或伴生插件未装）');
				}
				return bridge.call<IBridgePluginRegistries>(DshBridgeMethod.PluginRegistries, undefined, 20_000);
			}
			case DshHarnessChannelCommand.GetDshPluginInventory: {
				const bridge = this._supervisor.bridge;
				if (!bridge) {
					throw new Error('[dshHarness] getDshPluginInventory: 控制桥不可用（Host 未运行或伴生插件未装）');
				}
				return bridge.call<IBridgePluginInventory>(DshBridgeMethod.PluginInventory, undefined, 20_000);
			}
			// 组合包启停（方案 5.16 批次 3）：Host 运行时经 `pluginManager.setBundleEnabled`（它自己的
			// 写锁 + application 语义）；Host 未运行时降级为直接改 profile 的 `dsh.profile.bundles` ——
			// 同一份真源、同一落盘形态，界面据 `via` 如实说明。
			case DshHarnessChannelCommand.SetDshBundleEnabled: {
				const a = arg as IBridgeBundleToggleArgs;
				if (!validateBundleToggleArgs(a)) {
					throw new Error('[dshHarness] setDshBundleEnabled: 需要 { name: string, enabled: boolean }');
				}
				const name = a.name.trim();
				if (!a.enabled && isBundleDisableForbidden(name)) {
					throw new Error(`${name} 是 Host 运行所必需（基础组合 / 控制桥），不能停用`);
				}
				// 只允许切换 profile 里真实存在的包（防手改组合凭空塞条目）。
				if (!this._supervisor.listPlugins().some(p => p.name === name)) {
					throw new Error(`[dshHarness] setDshBundleEnabled: profile 里没有这个插件：${name}`);
				}
				const bridge = this._supervisor.bridge;
				if (bridge) {
					const r = await bridge.call<IBridgePluginChangeResult>(DshBridgeMethod.BundleSetEnabled, { name, enabled: a.enabled }, 60_000);
					if (r.changed) {
						this._onDidChangePlugins.fire();
					}
					// Host **没能真的应用**（`application: 'failed'`）⇒ 退回**文件级**写入（写 `dsh.profile.bundles`，
					// 我们既有的 `via: 'file'` 口径）。起因（README 4.51/4.52）：dsh 的实时重组要求 profile 有
					// root Include entry（宿主原文 `dsh: profile reload requires the root Include entry`），
					// 我们的启动路径不满足 ⇒ 实时那条必然失败。**切换不该白点一次**：写盘后 HMR 生效或下次启动生效。
					if (r.application === 'failed') {
						const { changed } = await this._pluginActivation.setEnabled(name, a.enabled);
						if (changed) {
							this._onDidChangePlugins.fire();
						}
						const snapshot = await this._pluginActivationSnapshot();
						return {
							...snapshot,
							changed: changed || r.changed,
							via: 'file' as const,
							// HMR `active` ⇒ 改 profile 组合会被串行热重载（约 2 秒）⇒ 按"已应用"报；
							// `disabled`/`unknown` ⇒ 要重启才生效（与 `IDshPluginActivationSnapshot.hmr` 的既有口径一致）。
							application: (snapshot.hmr === 'active' ? 'applied' : 'restart-required') as 'applied' | 'restart-required',
							...(r.error ? { errorCode: r.error } : {}),
							...(r.stage === undefined ? {} : { stage: r.stage }),
							...(r.diagnostic === undefined ? {} : { diagnostic: r.diagnostic }),
						} satisfies IDshPluginSetResult;
					}
					return {
						...await this._pluginActivationSnapshot(),
						changed: r.changed,
						via: 'host' as const,
						application: r.application,
						...(r.error ? { errorCode: r.error } : {}),
						// 失败在哪一步：Host 给了就透传（少了它，界面/探针只剩一个裸错误码，看不出该查哪儿）
						...(r.stage === undefined ? {} : { stage: r.stage }),
						// 原始诊断：`operation-error` 这类非预期异常只有它说得出原因（预期拒绝才有枚举码）
						...(r.diagnostic === undefined ? {} : { diagnostic: r.diagnostic }),
					} satisfies IDshPluginSetResult;
				}
				const { changed } = await this._pluginActivation.setEnabled(name, a.enabled);
				if (changed) {
					this._onDidChangePlugins.fire();
				}
				return { ...await this._pluginActivationSnapshot(), changed, via: 'file' as const, application: null } satisfies IDshPluginSetResult;
			}
			case DshHarnessChannelCommand.SetDshPluginRowEnabled: {
				const a = arg as IBridgePluginRowToggleArgs;
				if (!validatePluginRowToggleArgs(a)) {
					throw new Error('[dshHarness] setDshPluginRowEnabled: 需要 { entryId: string, enabled: boolean }');
				}
				const bridge = this._supervisor.bridge;
				if (!bridge) {
					throw new Error('[dshHarness] setDshPluginRowEnabled: 行级启停需要 Host 运行（控制桥不可用）');
				}
				const r = await bridge.call<IBridgePluginChangeResult>(DshBridgeMethod.PluginRowSetEnabled, { entryId: a.entryId.trim(), enabled: a.enabled }, 60_000);
				if (r.changed) {
					this._onDidChangePlugins.fire();
				}
				// Host **没能真的应用** ⇒ 退回**文件级**（写 profile 的 `cordis.patch.yml` 的 `disabled` 覆盖）。
				// 与组合包那条同一个起因（README 4.51/4.52：dsh 的实时重组要求 root Include entry，我们的启动
				// 路径不满足）⇒ 没有这一路，"禁用某一行"就是白点。`errorCode`/`stage`/`diagnostic` 照样带走。
				if (r.application === 'failed') {
					const row = await this._patchRowOf(a.entryId.trim());
					if (row) {
						const { changed } = await this._pluginActivation.setRowEnabled(row.patchId, a.enabled, row.moduleName);
						if (changed) {
							this._onDidChangePlugins.fire();
						}
						const snapshot = await this._pluginActivationSnapshot();
						return {
							changed: changed || r.changed,
							// 如实标注"走的是文件级"（同组合包那条）：界面据此**不会**说成"Host 热重载完成"
							via: 'file' as const,
							// 同组合包那条的口径：HMR `active` ⇒ 改 profile 组合会被热重载 ⇒ 按"已应用"报
							application: (snapshot.hmr === 'active' ? 'applied' : 'restart-required') as 'applied' | 'restart-required',
							target: r.target,
							...(r.error ? { errorCode: r.error } : {}),
							...(r.warnings ? { warnings: r.warnings } : {}),
							...(r.stage === undefined ? {} : { stage: r.stage }),
							...(r.diagnostic === undefined ? {} : { diagnostic: r.diagnostic }),
						} satisfies IDshPluginRowSetResult;
					}
				}
				return {
					changed: r.changed,
					via: 'host' as const,
					application: r.application,
					target: r.target,
					...(r.error ? { errorCode: r.error } : {}),
					...(r.warnings ? { warnings: r.warnings } : {}),
					...(r.stage === undefined ? {} : { stage: r.stage }),
					...(r.diagnostic === undefined ? {} : { diagnostic: r.diagnostic }),
				} satisfies IDshPluginRowSetResult;
			}
			// ─── 插件商城（方案 5.16 批次 4，安装面）────────────────────────────
			// 四件事都只有 Host 运行时才做得了（安装要用 profile 的写锁与 pnpm），控制桥不可用时
			// **明确报错**——不要给"装好了"的假象。超时按各自动作给：inspect 要查注册表（可能连续
			// 试几个源），install/remove 是 pnpm 长任务（首次装依赖可能几分钟）。
			case DshHarnessChannelCommand.InspectDshPlugin: {
				const a = arg as { spec?: string };
				if (!validateBundleInspectArgs(a)) {
					throw new Error('[dshHarness] inspectDshPlugin: 需要 { spec: 非空字符串（不含空白/引号） }');
				}
				const bridge = this._supervisor.bridge;
				if (!bridge) {
					throw new Error('[dshHarness] inspectDshPlugin: 控制桥不可用（Host 未运行或伴生插件未装）');
				}
				return bridge.call<IBridgeInspectResult>(DshBridgeMethod.BundleInspect, { spec: a.spec!.trim() }, 120_000);
			}
			case DshHarnessChannelCommand.InstallDshPlugin: {
				if (!validateBundleInstallArgs(arg)) {
					throw new Error('[dshHarness] installDshPlugin: 需要 { spec, requestId }（requestId 用于取消与进度关联）');
				}
				const a = arg as IBridgeInstallArgs;
				const bridge = this._supervisor.bridge;
				if (!bridge) {
					throw new Error('[dshHarness] installDshPlugin: 控制桥不可用（Host 未运行或伴生插件未装）');
				}
				const r = await bridge.call<IBridgeInstallResult>(DshBridgeMethod.BundleInstall, {
					spec: a.spec.trim(),
					requestId: a.requestId,
					...(a.approvedBuilds?.length ? { approvedBuilds: a.approvedBuilds } : {}),
				}, 900_000);
				if (r.changed) {
					this._onDidChangePlugins.fire();
				}
				return r;
			}
			case DshHarnessChannelCommand.CancelDshPluginInstall: {
				if (!validateInstallCancelArgs(arg)) {
					throw new Error('[dshHarness] cancelDshPluginInstall: 需要 { requestId }');
				}
				const bridge = this._supervisor.bridge;
				if (!bridge) {
					throw new Error('[dshHarness] cancelDshPluginInstall: 控制桥不可用（Host 未运行或伴生插件未装）');
				}
				return bridge.call<IBridgeInstallCancelResult>(DshBridgeMethod.BundleInstallCancel, { requestId: (arg as IBridgeInstallCancelArgs).requestId }, 120_000);
			}
			case DshHarnessChannelCommand.RemoveDshPlugin: {
				if (!validateBundleRemoveArgs(arg)) {
					throw new Error('[dshHarness] removeDshPlugin: 需要 { name: 包名 }');
				}
				const a = arg as IBridgeRemoveArgs;
				const bridge = this._supervisor.bridge;
				if (!bridge) {
					throw new Error('[dshHarness] removeDshPlugin: 控制桥不可用（Host 未运行或伴生插件未装）');
				}
				const r = await bridge.call<IBridgeInstallResult>(DshBridgeMethod.BundleRemove, { name: a.name.trim() }, 300_000);
				if (r.changed) {
					this._onDidChangePlugins.fire();
				}
				return r;
			}
			case DshHarnessChannelCommand.ProvidersSync: {
				const bridge = this._supervisor.bridge;
				if (!bridge) {
					throw new Error('[dshHarness] providersSync: 控制桥不可用（未安装伴生插件或 Host 未运行）');
				}
				if (!validateProvidersSyncArgs(arg)) {
					throw new Error('[dshHarness] providersSync: 负载未通过校验');
				}
				// 校验用**原始**负载（真实 https 网关地址）；下发前换成探针代理地址（也是校验允许的
				// `http://127.0.0.1:…`），真实地址只登记在代理表里、不进 profile。
				const rewritten = await this._rewriteForCreditProxy(arg);
				return bridge.call<IBridgeProvidersSyncResult>(DshBridgeMethod.ProvidersSync, rewritten, 60_000);
			}
			case DshHarnessChannelCommand.DiscoverUpdates: {
				const a = arg as { policy: IDshUpdatePolicy; start: IDshHostStartOptions };
				return this._discover(a.policy, a.start ?? {});
			}
			case DshHarnessChannelCommand.ClaimIdeRequest: {
				// 多窗口下 `OnIdeRequest` 是广播：renderer 执行**之前**先认领，只放行一个（详见 `dshIdeClaims.ts`）。
				// 请求已超时/未知 id 也**不认领** —— renderer 据此不执行也不回执，免得执行一个已被放弃的请求。
				const claim = arg as { id?: unknown } | undefined;
				const id = typeof claim?.id === 'number' ? claim.id : undefined;
				const claimed = id !== undefined && this._idePending.has(id) && this._ideClaims.claim(id);
				if (claimed) {
					this._clearIdeGrace(id!);   // 有人接了 ⇒ 撤掉宽限广播（别再发一遍）
				}
				const reply: IDshIdeClaimReply = { claimed };
				return reply;
			}
			case DshHarnessChannelCommand.ResolveIdeRequest: {
				// renderer 对一次 IDE 能力请求的回执。已超时/重复回执 ⇒ 丢弃（不抛，免得渲染侧刷错误），
				// 但**必须留痕**：最常见的来源是"renderer 答得比主进程预算晚"（超时已 reject，回执才回来）。
				// 以前是裸 `return`，于是"多窗口下第二个回执被丢弃"这类事故在日志里完全不可见。
				const reply = arg as IDshIdeReply | undefined;
				const pending = typeof reply?.id === 'number' ? this._idePending.get(reply.id) : undefined;
				if (!pending) {
					this._logService.warn(`[dshHarness] 丢弃无人认领的 IDE 回执：id=${String(reply?.id)}（已超时 / 重复 / 未知 id）`);
					return;
				}
				this._clearIdeGrace(reply!.id);
				this._idePending.delete(reply!.id);
				this._ideClaims.release(reply!.id);
				clearTimeout(pending.timer);
				if (reply!.error !== undefined) {
					pending.reject(new Error(reply!.error));
				} else {
					pending.resolve(reply!.result);
				}
				return;
			}
			case DshHarnessChannelCommand.GetActivity:
				return this._supervisor.getActivity();
			case DshHarnessChannelCommand.CreateView: {
				const a = arg as IDshCreateViewArgs;
				// plugin-page 必须带合法的站内绝对路径：这条边界同时挡住 `//host`（协议相对地址）
				// 与 `..`（跨路径）。其他 surface 的 route 一律忽略（不静默改行为）。
				const route = a.surface === 'plugin-page' ? validatePluginRoute(a.route) : undefined;
				if (a.surface === 'plugin-page' && !route) {
					throw new Error('[dshHarness] createView: plugin-page 需要合法的 route（站内绝对路径，如 /x/<module>/）');
				}
				if (a.surface !== 'plugin-page' && a.route !== undefined) {
					this._logService.warn(`[dshHarness] createView: 忽略 non-plugin-page 视图 ${a.viewId} 的 route`);
				}
				// 承载表面（2026-10-13）：只允许白名单取值，非法值当作**没给**（回落完整页）而不是抛错 ——
				// 它是"渲染哪一版"的提示，不是安全边界（真值由宿主自己传）✓。
				const pageSurface = a.pageSurface === 'sideview' || a.pageSurface === 'editor' ? a.pageSurface : undefined;
				if (a.surface !== 'plugin-page' && a.pageSurface !== undefined) {
					this._logService.warn(`[dshHarness] createView: 忽略 non-plugin-page 视图 ${a.viewId} 的 pageSurface`);
				}
				// 视图底色候选（2026-10-13：修「初次打开侧栏视图白屏一下」）——建视图时就染色 ⇒
				// 页面画出第一帧之前不会露 Electron 默认白。形状非法 ⇒ 当没给（宁可少染一次，
				// 也不把没校验过的字符串塞进原生 API ✗）。
				const backgrounds: IDshViewBackgrounds | undefined = validateViewBackgrounds(a.backgrounds) ? a.backgrounds : undefined;
				this._views.create(a.viewId, a.windowId, a.surface, a.chatOnlyUi !== false, a.sessionId || undefined, a.colorScheme, route, pageSurface, backgrounds, a.isolatedPool === true);
				return;
			}
			case DshHarnessChannelCommand.LayoutView: {
				const a = arg as { viewId: string; bounds: IDshViewBounds };
				this._views.layout(a.viewId, a.bounds);
				return;
			}
			case DshHarnessChannelCommand.SetViewVisible: {
				const a = arg as { viewId: string; visible: boolean; focus?: boolean };
				this._views.setVisible(a.viewId, a.visible);
				if (a.visible && a.focus) {
					this._views.focus(a.viewId);
				}
				return;
			}
			case DshHarnessChannelCommand.FreezeView: {
				// 浮层让位：**先抓一帧，再把视图藏起来**（顺序必须在主进程内保证 —— 见 `captureAndHide` 的注释）。
				// 拿不到帧（视图不存在/已销毁/抓图失败）⇒ `undefined`，调用方退回主题底色 ✓。
				const a = arg as { viewId?: unknown };
				return typeof a.viewId === 'string' ? await this._views.captureAndHide(a.viewId) : undefined;
			}
			case DshHarnessChannelCommand.ReloadView:
				this._views.reload((arg as { viewId: string }).viewId);
				return;
			case DshHarnessChannelCommand.PushTheme: {
				const a = arg as { viewId: string; tokens: unknown; colorScheme?: unknown; backgrounds?: unknown };
				if (typeof a.viewId === 'string' && validateThemeTokens(a.tokens)) {
					// 底色随主题一起推（切主题时原生视图底色也要跟着变，见 dshViewHost 的 _applyViewBackground ✓）
					this._views.pushTheme(a.viewId, a.tokens, a.colorScheme === 'dark' || a.colorScheme === 'light' ? a.colorScheme : undefined, validateViewBackgrounds(a.backgrounds) ? a.backgrounds : undefined);
				}
				return;
			}
			case DshHarnessChannelCommand.PushWorktrees: {
				// worktree 列表（聊天 header 下拉）：渲染进程给的是 `IWorktreeDetail` 的**投影**，
				// 这里再校验一遍形状（主进程是信任边界；`dataset` 会被页面当作可信数据解析）。
				const a = arg as { viewId: unknown; options: unknown };
				const options = typeof a.viewId === 'string' ? validateWorktreeOptions(a.options) : undefined;
				if (options) {
					this._views.pushWorktrees(a.viewId as string, options);
				} else {
					// ⚠ 从前这里是**静默**的 ✗：形状不合法 ⇒ 页面永远拿不到列表 ⇒ worktree UI 不出现，
					//   而日志里一片安静（2026-10-13 排查"没有显示 worktree ui"的教训）⇒ 至少要留一行。
					this._logService.warn(`[dshHarness] pushWorktrees ignored: 选项形状不合法（viewId=${String(a.viewId)}）`);
				}
				return;
			}
			case DshHarnessChannelCommand.PushWorkspaces: {
				// IDE 工作区记录（多根工作区；2026-10-16）：与 PushWorktrees 同口径 —— 渲染进程给的是
				// `Workspace` 记录的**投影**，这里再校验一遍形状（主进程是信任边界；`dataset` 会被页面
				// 当作可信数据解析）。⚠ 不合法**必须留一行**：静默会让页面永远看不到多根，
				// 而日志里一片安静（2026-10-13 worktree 的教训 ✓）。
				const a = arg as { viewId: unknown; options: unknown };
				const options = typeof a.viewId === 'string' ? validateWorkspaceOptions(a.options) : undefined;
				if (options) {
					this._views.pushWorkspaces(a.viewId as string, options);
				} else {
					this._logService.warn(`[dshHarness] pushWorkspaces ignored: 选项形状不合法（viewId=${String(a.viewId)}）`);
				}
				return;
			}
			case DshHarnessChannelCommand.InsertReference: {
				const a = arg as { viewId: string; reference: unknown };
				if (typeof a.viewId === 'string' && validateInsertReference(a.reference)) {
					this._views.insertReference(a.viewId, a.reference);
				}
				return;
			}
			case DshHarnessChannelCommand.RebindSession: {
				const a = arg as { viewId: string; sessionId: unknown };
				if (typeof a.viewId === 'string' && isDshChatSessionId(a.sessionId)) {
					this._views.rebindSession(a.viewId, a.sessionId);
				}
				return;
			}
			case DshHarnessChannelCommand.RenameSession: {
				// 标题只承载展示文本：非空、截断到 500（与页面桥 sessionTitle 的上限一致）。
				// 未通过的负载静默丢弃（调用方是自家 UI，不构成攻击面，但保持与其它命令同风格）。
				const a = arg as { viewId: unknown; title: unknown };
				if (typeof a.viewId === 'string' && typeof a.title === 'string' && a.title.trim()) {
					this._views.renameSession(a.viewId, a.title.trim().slice(0, 500));
				}
				return;
			}
			case DshHarnessChannelCommand.DisposeView:
				this._views.disposeView((arg as { viewId: string }).viewId);
				return;
			case DshHarnessChannelCommand.ListViews:
				return this._views.describe();
			case DshHarnessChannelCommand.ResetWindow: {
				const a = arg as { windowId: number; keep?: unknown };
				// keep = 派发方（当前 renderer）自己创建的视图：只回收孤儿，别把当前视图也清掉
				// （Host 抢先启动后聊天视图会在工作台启动早期就建好，见 disposeViewsOfWindow）。
				const keep = Array.isArray(a?.keep) ? a.keep.filter((v): v is string => typeof v === 'string') : undefined;
				const n = this._views.disposeViewsOfWindow(a.windowId, keep);
				if (n) {
					this._logService.info(`[dshHarness] reclaimed ${n} orphan view(s) of window ${(arg as { windowId: number }).windowId}`);
				}
				return;
			}
			default:
				throw new Error(`[dshHarness] unknown command: ${command}`);
		}
	}
}
