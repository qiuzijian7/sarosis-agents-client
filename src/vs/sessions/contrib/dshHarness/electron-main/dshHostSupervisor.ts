/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh Host 监管：准备 profile 与伴生插件、拉起 Host、控制桥握手、健康与退出处理（方案第 3、7.5 节）。
 *
 * 只依赖 Node 内置模块与 vs/base（不 import electron），可在纯 Node 下做集成测试。
 * 所有与 dsh 的交互都走 CLI（L0）；握手走 VsSaros 自有控制桥；从不读写 `$DSH_HOME` 下的凭证、设置与会话文件，
 * 唯一读取的是 profile 的 `package.json`（判断 profile 是否存在、伴生插件版本）。
 */

import { ChildProcess, execFile, execFileSync, spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { existsSync, promises as fsp, readFileSync, rmSync, utimesSync } from 'fs';
import { ClientRequest, request as httpRequest } from 'http';
import { homedir, tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, delimiter, join, resolve } from '../../../../base/common/path.js';
import { DshBridgeMethod, IBridgeHello, IBridgePluginRow, IBridgeReverseRequest, IBridgeWorkspaceContextArgs, IBridgeWorkspaceContextResult } from '../common/dshBridgeProtocol.js';
import { bridgePipePath, buildHostArgs, buildPluginAddArgs, buildPluginAddArgsMany, buildProfileInitArgs, DSH_SHARED_INSTANCE_PACKAGES, memoryGatewayUrlFromEnv, parseAuthUrl, resolveSiblingPackage, toFileSpec } from '../common/dshCli.js';
import { isDshRowsBundleRegistered, parseMcpServers, renderMcpOverlay } from '../common/dshMcpConfig.js';
import { auditBundledPluginVersions, isVersionNewer, renderBundledVersionAudit } from '../common/dshPluginVersionAudit.js';
import { DSH_HOST_IDLE_TTL_MS, DshHostOverlayKind, hostOverlayFileName, IDshHostConfig, renderHostOverlays } from '../common/dshHostConfig.js';
import { HOST_RUN_OWNERSHIP_HEARTBEAT_MS, hostRunOwnershipFileName } from '../common/dshHostRunOwnership.js';
import { DSH_ARCHIFY_PLUGIN_NAME, DSH_BRIDGE_PLUGIN_NAME, DSH_EGO_PLUGIN_NAME, DSH_BROWSER_PLUGIN_NAME, DSH_CHAT_SURFACE_PLUGIN_NAME, DSH_DEFAULT_PROFILE, DSH_FOUNDATION_PLUGIN_NAME, DSH_KB_REFS_PLUGIN_NAME, DSH_SCHEDULE_BUNDLE_PLUGIN_NAME, DSH_UNREAL_PLUGIN_NAME, DSH_VOICE_BUNDLE_PLUGIN_NAME, DSH_WEB_APP_BUNDLE_NAME, DSH_WORKBENCHES_PLUGIN_NAME, IDshBundledInstallResult, IDshHostStartOptions, IDshHostStatus, IDshPluginInfo, sameStartOptions } from '../common/dshHarness.js';
import { hostLeaseBlocker, IDshHostLease } from '../common/dshHostLease.js';
import { SANDBOX_FALLBACK_MODE, SANDBOX_FALLBACK_ROOT } from '../common/dshSandboxCompat.js';
import { probeLabelWriteOnce } from './dshSandboxProbe.js';
import { DshBridgeClient } from './dshBridgeClient.js';
import { IStartupDeadline, createStartupDeadline, startupExpiryMessage } from './dshStartupDeadline.js';
import { normalizeExistingPath, repairStoreMetadataContent } from './dshStoreMetadata.js';
import { DshHostLeaseStore } from './dshHostLeaseStore.js';
import { rememberHostPort, resolveHostPort } from './dshHostPortManager.js';
import { reapOrphanHosts } from './dshHostReaper.js';
import { DshRuntimeError, DshRuntimeManager, IResolvedDsh, IResolvedNode, sanitizedEnv } from './dshRuntimeManager.js';
import { IDshHealthReport, IHostActivity, summarizeHealth } from '../common/dshUpgrade.js';
// ★ 2026-10-19：内置 agent 的**代码真源**（`getBuiltinAgents`）与它到 md 的序列化（`buildAgentMd`）。
//   dsh 侧的 agents 模块（`vssaros-agents`）此前**只扫用户目录** ⇒ 内置 agent 一个都列不出来 ✗；
//   Host 进程读不到产品源码 ⇒ 启动期在这里把真源生成成 md 副本，再把目录绝对路径写进覆盖层。
//   ⚠ 真源只有一个（`common/builtinAgents.ts`）；这里是**产物交付**，不是第二个真源。
import { getBuiltinAgents } from '../../agentStudio/common/builtinAgents.js';
import { buildAgentMd } from '../../agentStudio/common/agentMdFormat.js';

const isWindows = process.platform === 'win32';
const LOG_LIMIT = 400;

/** dsh 页面实时事件走的 WebSocket mux 路径（`dsh-api-gateway` 的 `REMOTE_STREAM_MUX_PATH`）。 */
const DSH_MUX_PATH = '/api/remote.mux';

/**
 * 探一次 mux 升级路由**是否已注册**（不带 cookie，绝不会被放行）。
 *
 * 为什么能区分（2026-10-20 读官方源码确认）：
 *   · `dsh-host-webserver` upgrade 处理：路由未注册 ⇒ `socket.destroy()`，**没有任何 HTTP 响应**；
 *   · `dsh-api-gateway` 的 mux handler：已注册但未认证 ⇒ `rejectRemoteStreamUpgrade` 回 401/403/409。
 *   ⇒ 收到任何 HTTP 响应 = 路由已在；连接被直接掐断 / 超时 = 还没注册。
 * 而 mux 路由要等 `appReady`（整个 boot 返回）才注册，比我们判定 ready 用的 bridge hello 晚 ——
 * 这段时间里页面的实时事件连接每一代都失败，只能按 0.5/1/2/4/8 s 退避重试。
 * @returns HTTP 状态码（101 也算）；未注册 / 超时 / 出错返回 `undefined`。
 */
function probeMuxRouteOnce(origin: string, timeoutMs: number): Promise<number | undefined> {
	return new Promise(resolvePromise => {
		let done = false;
		let req: ClientRequest | undefined;
		const timer = setTimeout(() => finish(undefined), timeoutMs);
		function finish(v: number | undefined): void {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			try { req?.destroy(); } catch { /* 探针收尾失败无所谓 */ }
			resolvePromise(v);
		}
		try {
			const u = new URL(DSH_MUX_PATH, origin);
			req = httpRequest({
				hostname: u.hostname,
				port: u.port,
				path: u.pathname,
				method: 'GET',
				headers: {
					'Connection': 'Upgrade',
					'Upgrade': 'websocket',
					'Sec-WebSocket-Version': '13',
					'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
				},
			});
		} catch {
			finish(undefined);
			return;
		}
		req.on('response', res => { res.resume(); finish(res.statusCode ?? 0); });
		req.on('upgrade', (_res, socket) => { socket.destroy(); finish(101); });
		req.on('error', () => finish(undefined));
		req.on('close', () => finish(undefined));
		req.end();
	});
}

/**
 * 随包媒体二进制目录（`ffmpeg` / `ffprobe` / `yt-dlp` / `whisper-cli` 都在里面；2026-10-15）。
 *
 * 解析优先级（与 `voxLaunchChannel.findBuiltinBin` 同口径，避免两处漂移）：
 *   ① 打包后 `process.resourcesPath/saros/bin`；
 *   ② dev：IDE 以**仓库根**为 cwd 启动 ⇒ `cwd/build/saros/bin`。
 *
 * ⚠ **不要用本文件路径当锚点**（CJS 的目录变量 / ESM 的 import-meta URL）：本模块所在的打包产物里
 * 它们**不存在/不可用**（2026-10-15 实测：Host 启动即报"目录变量未定义" —— 这是本函数第一版的坑 ✓；
 * 守卫见 `dshHostConfig.test.ts` 的"不漂移"那条 —— 它会拦这两个标识符）。
 * cwd 不是仓库根时退回 `undefined`（不注入 ⇒ 行为与改动前一致，**绝不能让定位失败变成启动失败** ✓）。
 */
function bundledMediaBinDir(): string | undefined {
	const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
	if (resourcesPath) {
		const packaged = join(resourcesPath, 'saros', 'bin');
		if (existsSync(packaged)) { return packaged; }
	}
	const devCandidate = join(process.cwd(), 'build', 'saros', 'bin');
	return existsSync(devCandidate) ? devCandidate : undefined;
}

/** Host 冷启分段计时（`ready in` 的拆账；打点与量化误差说明见 `_awaitReady`）。 */
interface IDshHostBootTiming {
	/** spawn → Host 第一行输出（node 引导 + dsh 核心 + cordis 装配段）。 */
	readonly spawnToFirstOutputMs?: number;
	/** 首行输出 → ready（其余插件 apply + web server 段）。 */
	readonly firstOutputToReadyMs?: number;
}
/**
 * **安静预算**：多久没有任何进展才认为 Host 卡住了（保留旧的 60s 口径）。
 *
 * ⚠ 它不再是"总时长"：真机实测（p3-16）冷机器上 Host 正在"安装伴生插件（1/3）"时会被固定 60s 判成
 * "启动失败"——明明在动。改成进度感知（见 {@link createStartupDeadline}）：有进展就续期，
 * 上限见 {@link STARTUP_MAX_MS}。
 */
const STARTUP_TIMEOUT_MS = 60_000;
/** 启动总时长上限：无论多有进展都不放过的兜底（否则刷日志的坏进程能永远吊住 UI）。 */
const STARTUP_MAX_MS = 300_000;
/** URL 行出现后，再给控制桥多少时间完成握手（伴生插件在 Host 内与 webServer 同时激活）。 */
const BRIDGE_GRACE_MS = 8_000;
/** 另一个实例正在启动 Host 时，等它写出租约的最长时间。 */
const START_LOCK_WAIT_MS = 30_000;
/** 复用中桥断开后，等拥有者重启并写新租约的时间。 */
const READOPT_WAIT_MS = 20_000;

export interface IDshHostSupervisorOptions {
	readonly runtime: DshRuntimeManager;
	/** 运行期临时文件（覆盖层、Unix socket）目录。 */
	readonly runDir: string;
	/** 随产品分发的伴生插件目录（含 package.json）；不存在时跳过安装，以 URL 行兜底。 */
	readonly bridgePluginDir: string | undefined;
	/** 随产品分发的 foundation 插件目录（重构 1.3 共享服务）；不存在时跳过安装。 */
	readonly foundationPluginDir: string | undefined;
	/** 随产品分发的工作台宿主插件目录（`@vssaros/dsh-workbenches`）；不存在时跳过安装。 */
	readonly workbenchesPluginDir?: string;
	/** 随产品分发的 chat-surface 插件目录（聊天框绑定会话用）；不存在时跳过安装。 */
	readonly chatSurfacePluginDir: string | undefined;
	/**
	 * 随产品分发的**知识库 `@` 引用源**插件目录（`@vssaros/dsh-kb-refs`，2026-10-14 P1-1）；
	 * 不存在时跳过安装 ⇒ 聊天框里就没有「知识库」那组 `@` 候选（其余一切不受影响 ✓）。
	 */
	readonly kbRefsPluginDir?: string;
	/**
	 * 随产品分发的 **Host 侧 `browser` 插件**目录（README 4.69 Step 1）；不存在时跳过安装。
	 * 缺省 undefined ⇒ 老构建/没带该包时行为与从前一致。
	 */
	readonly browserPluginDir?: string;
	/** 随产品分发的 **Host 侧 `unreal_*` 插件**目录（同上）。 */
	readonly unrealPluginDir?: string;
	/**
	 * 随包 **vendored 的第三方技能包**目录（`dsh-plugins/vssaros-archify/`；上游 `tt-a1i/archify`，MIT）。
	 *
	 * 为什么不是"随包模块插件"：它没有 `vssaros.module`（是**技能 bundle**、不是我们的 UI 模块）⇒ 走**伴生插件**
	 * 这条一起装（与 browser / unreal 同路径 ✓），且**不**进插件中心「随包」段（那段只列模块 ✓）。
	 * 缺省 undefined ⇒ 老构建/没带该目录时行为与从前一致 ✓（取舍与 provenance：`vssaros-archify/VENDOR.md`）。
	 */
	readonly archifyPluginDir?: string;
	/**
	 * 随包 **ego lite（`ego-browser`）接入插件**目录（`dsh-plugins/vssaros-ego/`）。
	 *
	 * 与 archify 同一条"存在才装"的伴生路径（它也没有 `vssaros.module`：不是我们的 UI 模块）。
	 * 装不上不影响启动 —— 用户没装 ego lite 应用时那 4 个工具本来就用不了，`ego_status` 会说明原因。
	 */
	readonly egoPluginDir?: string;
	/**
	 * 随产品分发的**模块插件**（`[包名, 目录]`；由 channel 用 `listBundledPlugins` 自发现）。
	 * 2026-10-11 起**全部随包自动安装**（用户要求）：agents / skills / mcp / kb / memory / codebase /
	 * kanban / workflow / dashboard / ide。空数组合法（老构建没带 `dsh-plugins/`）。
	 */
	readonly modulePluginDirs: readonly (readonly [string, string])[];
	/** 未显式配置 dshHome 时使用的目录；undefined 表示沿用 `$DSH_HOME` / dsh 默认 `~/.dsh`。 */
	readonly defaultDshHome: string | undefined;
	readonly instanceId: string;
	readonly log: (line: string) => void;
	/** 启动阶段进度（给状态区做实时反馈）；缺省 = 只记日志。 */
	readonly onProgress?: (line: string) => void;
	/**
	 * **反向通道（Host → IDE）**的处理器。
	 *
	 * 由 VsSaros 侧提供（`DshHarnessChannel` 的授权闸门），在**桥客户端创建时**就地注册。
	 * 为什么不做成"状态变化时由外部注册"：桥客户端建好之前状态可能已经是 `running`（并且之后不再变化），
	 * 那样注册会被**永久跳过**——真机 e2e 抓到过：客户端对 `ide.request` 回
	 * `IDE 侧没有处理 ide.request`（README 4.55）。这里注册不留时序窗口。
	 */
	readonly reverseRequestHandler?: (request: IBridgeReverseRequest) => unknown;
}

export interface IDshHostConnection {
	readonly origin: string;
	readonly authUrl: string;
}

/** 日志中屏蔽 token（URL 行带着进程启动 token）。 */
export function redactSecrets(line: string): string {
	return line.replace(/([?&]token=)[^\s&"'<>]+/g, '$1<redacted>');
}

/**
 * 推导 pnpm 会实际解析到的 store 目录（用来校正种子带来的 storeDir）。
 *
 * pnpm 的默认店不是常量：**先看 `<项目所在盘>:\\.pnpm-store\\v<N>` 是否已存在，存在就用它，
 * 否则退回用户级 `%LOCALAPPDATA%\\pnpm\\store\\v<N>`**（实测：仓库在 G: 且 `G:\\.pnpm-store\\v10`
 * 已存在 → `G:\\.pnpm-store\\v10`；在 C: 的临时目录 → `C:\\Users\\…\\AppData\\Local\\pnpm\\store\\v10`）。
 * POSIX 上则是 `~/.local/share/pnpm/store/v<N>`（macOS 为 `~/Library/pnpm/store/v<N>`）。
 *
 * 为什么要算它：profile 的 `node_modules/.modules.yaml` 是**从构建期的种子拷来的**，里面记着构建机
 * 仓库盘上的店；profile 通常在别的盘（userData 在 C:）⇒ 与 pnpm 解析值不符，
 * `dsh plugin add` 直接 `ERR_PNPM_UNEXPECTED_STORE`（实测：只改 virtualStoreDir 仍复现）。
 * @param profileDir - profile 根目录（决定盘符）。
 * @param storeVersion - 种子里记的 store 版本后缀（如 `v10`）。
 * @returns 期望的 store 目录，无法判定时返回 undefined（保持原值）。
 */
export function resolveExpectedStoreDir(profileDir: string, storeVersion: string): string | undefined {
	if (process.platform === 'win32') {
		const drive = /^([A-Za-z]):/.exec(profileDir)?.[1];
		const driveStore = drive ? `${drive}:${'\\'}.pnpm-store${'\\'}v${storeVersion}` : undefined;
		if (driveStore && existsSync(driveStore)) {
			return driveStore;
		}
		const localAppData = process.env['LOCALAPPDATA'];
		return localAppData ? join(localAppData, 'pnpm', 'store', `v${storeVersion}`) : driveStore;
	}
	const base = process.platform === 'darwin'
		? join(homedir(), 'Library', 'pnpm', 'store')
		: join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'pnpm', 'store');
	return join(base, `v${storeVersion}`);
}

export class DshHostSupervisor extends Disposable {

	private readonly _onDidChangeStatus = this._register(new Emitter<IDshHostStatus>());
	readonly onDidChangeStatus: Event<IDshHostStatus> = this._onDidChangeStatus.event;

	/**
	 * ★ 2026-10-20：新起的 Host 的 mux 升级路由**第一次可用**（见 `probeMuxRouteOnce`）。
	 * 渠道层据此通知页面：dsh 连接还在退避时立刻 `reconnect()`，不必再等剩下的 4/8 s 档。
	 */
	private readonly _onMuxReady = this._register(new Emitter<{ readonly afterReadyMs: number; readonly probes: number; readonly status: number }>());
	readonly onMuxReady: Event<{ readonly afterReadyMs: number; readonly probes: number; readonly status: number }> = this._onMuxReady.event;

	private _status: IDshHostStatus = { state: 'stopped', bridge: 'none' };
	private _child: ChildProcess | undefined;
	private _bridge: DshBridgeClient | undefined;

	/**
	 * 把反向通道（Host → IDE）的处理器就地挂到**刚建好的**桥客户端上。
	 * 两个创建点（冷启动 / 复用 Host）都要调：漏一个就会出现"重新连上以后驱不动 IDE"。
	 */
	private _registerReverseHandler(bridge: DshBridgeClient): void {
		if (this._opts.reverseRequestHandler) {
			bridge.setReverseRequestHandler(this._opts.reverseRequestHandler);
		}
	}
	private _connection: IDshHostConnection | undefined;
	private _overlayFile: string | undefined;
	/** 看板插件的当前工作区覆盖层（`--patch`，与 bridge 覆盖层同生命周期）。 */
	private _kanbanOverlayFile: string | undefined;
	/** 代码图谱插件的工作区根覆盖层（`--patch`，同上）。 */
	private _codebaseOverlayFile: string | undefined;
	/**
	 * 上一次收到的启动请求（用来判断"在跑的时候又发来了**不同**的选项"）。
	 * 不是为了复用——Host 在跑时 `start()` 一律原样复用、新选项不生效（见那里的注释）。
	 */
	private _requestedOptions: IDshHostStartOptions | undefined;
	/** MCP 服务器覆盖层（由 `~/.vssaros/mcp.json` 渲染，每次启动重建）。 */
	private _mcpOverlayFile: string | undefined;
	/** 技能库覆盖层（VsSaros 内置+用户技能目录，每次启动重建）。 */
	private _skillsOverlayFile: string | undefined;
	/** agents 模块的 agent 目录覆盖层（`config.agentsRoot`，每次启动重建；dev/生产数据根不同）。 */
	private _agentsOverlayFile: string | undefined;
	/** 数据根覆盖层（`config.dataRoot` × 4 + mcp 的 `config.path`；每次启动重建）。 */
	private _dataRootOverlayFile: string | undefined;
	/** 记忆模块的网关地址覆盖层（`--patch`，同上；地址来自主进程的 AGENTMEMORY_URL/PORT）。 */
	private _memoryOverlayFile: string | undefined;
	/** 沙箱降级覆盖层（**只在启动期探针探不通时才有**，见 `common/dshSandboxCompat.ts`）。 */
	private _sandboxOverlayFile: string | undefined;
	/** 沙箱探针的失败说明**只 warn 一次**（Host 会被反复重启：换工作区/装插件/白屏自愈都会 ✗）。 */
	private _sandboxProbeLogged = false;
	/** 多实例复用（方案 7.5）：本次运行是复用别人的 Host，以及本进程作为拥有者写出租约的 pid。 */
	private _reused = false;
	/** 关闭 IDE 时保留 Host 常驻（来自最近一次 start 的选项；桥插件的空闲 TTL 是防孤儿兜底）。 */
	private _keepAlive = false;
	/**
	 * **插件代码在磁盘上换了版本，而常驻 Host 内存里还是旧版** ⇒ 下一次 `start()` 必须换进程。
	 *
	 * 为什么非要有这个标记（2026-10-11 实测踩到，代价是排查一整晚）：
	 * dsh 的 web server 把插件**前端** chunk 从磁盘现读给页面，而插件的**模块半边**是 Host 启动时
	 * require 进来的 ⇒ 只更新磁盘不换进程，就会得到"前端是新的、后端是旧的"这种最误导的组合 ✗。
	 * 现场：profile 依赖已指向 `@vssaros/dsh-agents@0.1.7`（`presetId` 是它新加的能力），
	 * 而常驻 Host 内存里是 **0.1.5**（只认 `personaId`）⇒ 人格切换恒回
	 * `HTTP 400：需要 sessionId 与 personaId`，前后端各自都对、合起来没人说得清 ✗✗。
	 *
	 * 为什么不是"安装完立刻杀 Host"：那会打断正在跑的 agent 回合（与本文件里
	 * "选项变了不自动重启"同一条权衡）。这里改成**下一次 start 时换进程** —— 由"用户自己开聊天"
	 * 这个动作触发，代价是他能预期的一次启动等待，而不是无从解释的静默错版本 ✓。
	 */
	private _pluginsStale = false;
	/**
	 * 插件自检是否已经自动重启过一次（防抖动）。插件图**健康**时复位 ⇒ 将来"另一批插件又坏掉"时
	 * 还能再自愈一次 ✓（见 `_auditPluginGraph`）。
	 */
	private _pluginAuditRestarted = false;
	/** Preview Notice 抑制版本的读盘缓存（key = dsh bin 路径）。 */
	private _welcomeNoticeCache: { key: string; value: string | undefined } | undefined;
	private _leaseOwnedPid: number | undefined;
	private _leaseStore: DshHostLeaseStore | undefined;
	/** 本次 run 的**拥有者记录**文件（`owner-<runId>.json`；清理时一并删 ✓）。 */
	private _ownershipFile: string | undefined;
	/** 拥有者记录的**心跳**定时器（间隔见 `HOST_RUN_OWNERSHIP_HEARTBEAT_MS`；桥插件据此判"宿主还在"✓）。 */
	private _ownershipHeartbeat: ReturnType<typeof setInterval> | undefined;
	private _starting: Promise<IDshHostStatus> | undefined;
	private _stopping: Promise<void> | undefined;
	private _generation = 0;
	/**
	 * 启动阶段**进度感知的截止**（`_appendLog` 里 touch）。
	 * 生命周期只覆盖一次启动等待：`_awaitReady` 建、`finish` 清（见那里的注释）。
	 */
	private _startupDeadline: IStartupDeadline | undefined;
	/**
	 * 本次启动等待期间**控制桥连接失败**的原因（`_awaitReady` 的 connect 失败回调记下）。
	 *
	 * 为什么单独记：桥连不上时 `_awaitReady` 只把它写进日志，随后**安静预算**到点，用户看到的是
	 * "Host 在 60 秒内没有任何进展"——把人引向"进程卡住了"，而真因是"控制桥没握手"（可操作：
	 * 装不上 / 加载失败 / 管道不通）。2026-10-11 实测的真因就是这样：profile 缺官方
	 * `dsh-web-app` ⇒ bridge 永远 pending ⇒ 管道不存在 ⇒ connect ENOENT ⇒ 报成"无进展"。
	 * 记下来后由截止超时把真因一并报出。
	 */
	private _lastBridgeError: string | undefined;
	/**
	 * 本次启动中**没装上**的伴生/随包插件（`名称（应 X，实为 Y）`）。
	 *
	 * 为什么要有它：`_ensurePlugin` 装不上只记日志并继续 ⇒ 缺包的 profile 最终以"启动超时 /
	 * 没有任何进展"结束 ✗，用户在"进程卡住 / 网络 / profile 坏了"之间猜，而真因是某个插件没装上
	 * （2026-07-26 的 web-app 缺失事故就是这个形状）。这份清单进**启动失败文案**，
	 * 与 `_lastBridgeError` 同因同治（文案与截断口径见 `dshStartupDeadline.startupExpiryMessage`）。
	 */
	private _startupPluginProblems: string[] = [];
	private readonly _log: string[] = [];
	/** harness 启动日志的落盘文件（懒建，见 `_appendLog`；一个 supervisor 实例一份）。 */
	private _harnessLogFile: string | undefined;
	/** 落盘写入的串行链（`_appendLog` 用它把异步追加排成队：保序、不阻塞主进程、写不进静默丢弃）。 */
	private _logWriteChain: Promise<void> = Promise.resolve();
	/** 单次运行的监听（桥关闭等），每次停止时清空。 */
	private readonly _runDisposables = this._register(new DisposableStore());

	constructor(private readonly _opts: IDshHostSupervisorOptions) {
		super();
	}

	get status(): IDshHostStatus {
		return this._status;
	}

	get connection(): IDshHostConnection | undefined {
		return this._status.state === 'running' ? this._connection : undefined;
	}

	/**
	 * **向用户要一次确认** —— 给**留在 IDE 侧**的动作类能力用（目前只有 canvas）：经控制桥调 Host 的
	 * `approval.request` ⇒ 走 Host 的审批服务，卡片由 `dsh-client-ui-approval` 渲染，与 dsh 侧能力
	 * 用的是**同一张**卡（README 4.76 / 4.83）。
	 *
	 * ⚠ **超时必须显式给足**：用户确认窗口是 60s（`IDE_CONSENT_TIMEOUT_MS`），而 `DshBridgeClient.call`
	 * 默认只有 10s ⇒ 不传就会变成"每次确认都超时＝被拒"（默认值吃掉业务窗口，与 `ideRequestTimeoutMs`
	 * 慢档那段注释同源的坑）。
	 *
	 * **fail-closed**：桥不在 / 调用失败 / Host 无审批通道 —— 一律算"未允许"，**不退回通知**（README 4.84）。
	 */
	async requestActionConsent(args: { toolName: string; reason: string; displayReason?: { en?: string; zh?: string } }): Promise<boolean> {
		const bridge = this._bridge;
		if (!bridge) {
			this._opts.log('[dshHarness] action consent denied: no bridge（Host 没在跑？）');
			return false;
		}
		try {
			// 60s = 确认窗口本身；留 5s 余量给桥往返（不能小于窗口，否则用户还没来得及点就超时）。
			const outcome = await bridge.call<{ allowed?: boolean; outcome?: string; reason?: string }>(
				'approval.request', args, 65_000,
			);
			if (outcome?.allowed !== true) {
				// 2026-10-22：拒绝原因必须留痕（真机"点安装没反应"就是因为这里静默返回 false，原因 `approval-error` 没人看见）
				this._opts.log(`[dshHarness] action consent not allowed: outcome=${String(outcome?.outcome ?? '')} reason=${String(outcome?.reason ?? '')}`);
			}
			return outcome?.allowed === true;
		} catch (error) {
			this._opts.log(`[dshHarness] action consent denied: ${String((error as Error)?.message ?? error)}`);
			return false;
		}
	}

	get bridge(): DshBridgeClient | undefined {
		return this._bridge && !this._bridge.closed ? this._bridge : undefined;
	}

	getLog(): string[] {
		return [...this._log];
	}

	/** 列出当前 profile 的已装插件（清单 deps + node_modules 实装版本）；未启动时用默认目录只读探测。 */
	listPlugins(): IDshPluginInfo[] {
		const profile = this._status.profile ?? DSH_DEFAULT_PROFILE;
		const home = this._status.dshHome ?? this._opts.defaultDshHome ?? join(homedir(), '.dsh');
		const dir = join(home, 'profiles', profile);
		let deps: Record<string, string> = {};
		try {
			const pkg = JSON.parse(readFileSync(this._profileManifest(profile, { DSH_HOME: home } as NodeJS.ProcessEnv), 'utf8'));
			deps = pkg?.dependencies ?? {};
		} catch {
			return [];
		}
		return Object.entries(deps).map(([name, spec]) => ({
			name,
			spec,
			version: this._readPkgVersion(join(dir, 'node_modules', ...name.split('/'), 'package.json')),
		}));
	}

	/**
	 * 安装（或升级）一个**随包**插件：先复制进 profile，再 `dsh plugin add`。
	 *
	 * 为什么不复用商城的 spec 安装：那条走 Host 内的 `pluginManager`，spec 是 `file:<路径>`，
	 * 而**仓库与 profile 常在不同盘符**（开发机：仓库 G:、userData C:），pnpm 的 `file:` 跨盘符必失败。
	 * 这里与启动时装伴生插件**共用 `_ensurePlugin`**（先暂存到 `<profile>/.vssaros/plugins/<name>-<ver>/`
	 * ⇒ 同盘 ⇒ 可装），所以"能装伴生插件"与"能装随包模块"是同一套机制、同一批坑。
	 *
	 * 装前补一次 profile 初始化 + pnpm 元数据校正：与启动同口径——否则"还没起过 Host 就来装插件"
	 * 会踩到未初始化（或元数据指错目录）的 profile。
	 *
	 * `ok` 判的是**实装版本等于随包版本**（`_ensurePlugin` 装不上时只记日志并继续，不能把
	 * "报了个错然后继续"显示成成功）。
	 */
	installBundledPlugin(name: string, dir: string): Promise<IDshBundledInstallResult> {
		return this._installFromDir(name, dir, 'bundled plugin');
	}

	/**
	 * 安装一个**本地目录**里的插件（「添加插件」段的本地路径分支，通道命令 `InstallLocalPlugin`）。
	 *
	 * 名字与目标版本从该目录的 `package.json` 读；其余与随包一键安装**完全同路**。
	 *
	 * 为什么本地路径也要走这里、不走商城那条：Host 内 `pluginManager` 的安装在**全新 profile** 上
	 * 会把未被 lockfile 声明的那棵树剪掉（实测 `Packages: -43`）并判 `operation-error`——首启用户
	 * 点"安装"必失败（README 4.86、守护测试 `dshFreshProfileInstall.test.ts`）。注册表 / git / tarball
	 * 仍走商城那条：那些需要 pnpm 的解析、取消与进度能力。
	 */
	async installLocalPlugin(dir: string): Promise<IDshBundledInstallResult> {
		const name = this._readPkgField(join(dir, 'package.json'), 'name');
		if (!name) {
			return { name: dir, ok: false, bundledVersion: '', changed: false, error: `${dir} 不是包目录（读不到 package.json 里的 name）` };
		}
		return this._installFromDir(name, dir, 'local plugin');
	}

	/**
	 * 按**任意 spec** 把插件装进 profile（注册表 / git / tarball），**不经 Host 的 `pluginManager`**。
	 *
	 * 为什么要这条（2026-10-13，通道命令 `InstallPluginSpec`）：Host 内 `pluginManager` 的安装在
	 * **全新 profile** 上会把未被 lockfile 声明的那棵树剪掉（实测 `Packages: -43`）并判
	 * `operation-error` ⇒ 首启用户点"安装"必失败（README 4.86、`dshFreshProfileInstall.test.ts`）。
	 * 主进程这条路（`dsh plugin add`，与随包一键安装 / 启动装伴生插件同源）在同一测试里验证过可用 ⇒
	 * 注册表规格改走它（选路真源是 `agentStudio/common/dshPluginTransport.ts` ✓）。
	 *
	 * 代价与互补：**没有**商城那条的进度 / 取消 / 构建脚本批准
	 * ⇒ 界面在这条失败时会**回落**到商城那条（`pluginsView._dshInstallPlugin` 的注释），
	 * 两条路是互补关系，不是取代 ✗。
	 *
	 * `name` 必填：装完要读 `<profile>/node_modules/<name>/package.json` 的版本来**确认真的装上了**
	 * （spec 形态五花八门，读不出名字就无从核对 ⇒ 宁可不装也不给假成功 ✗）。名字由调用方从**预检结果**
	 * 给（`kind: 'registry'` 时一定有 ✓）。
	 *
	 * 返回值的 `bundledVersion` 在这条路上 = **实装版本**（spec 安装没有"随包源版本"这个概念 ✓）。
	 */
	async installPluginSpec(spec: string, name: string): Promise<IDshBundledInstallResult> {
		const cleanSpec = spec.trim();
		const pkgName = name.trim();
		const fail = (error: string): IDshBundledInstallResult =>
			({ name: pkgName || cleanSpec, ok: false, bundledVersion: '', changed: false, error });
		if (!cleanSpec) {
			return fail('spec 不能为空');
		}
		if (!pkgName) {
			return fail('缺少包名：装完要按包名核对版本，读不出名字就不装（先做一次预检）');
		}
		const { profile, dshHome } = this._resolveProfileAndHome();
		const options = this._requestedOptions ?? {};
		let node: IResolvedNode;
		let dsh: IResolvedDsh;
		try {
			node = await this._opts.runtime.resolveNode(options.nodePath);
			dsh = await this._opts.runtime.resolveDsh(options.runtimePath, node);
		} catch (e) {
			return fail(`解析运行时失败：${String((e as Error)?.message ?? e)}`);
		}
		const env = sanitizedEnv(dshHome ? { DSH_HOME: dshHome } : {});
		const profileDir = this._profileDir(profile, env);
		const manifest = join(profileDir, 'node_modules', ...pkgName.split('/'), 'package.json');
		const previousVersion = this._readPkgVersion(manifest);
		try {
			await this._ensureProfile(node, dsh, profile, env);
			await this._repairSeededStoreMetadata(profileDir);
			this._appendLog(`spec install: ${cleanSpec} (was ${previousVersion ?? 'absent'})`);
			// 走到真正执行安装这一步 ⇒ 与 `_ensurePlugin` 同一口径：任何**已经在跑**的 Host 内存里都不会有它
			//   （新装的 entry 在旧进程里 `failed to import` 且永久不可用）⇒ 下次 start 不接管旧进程 ✓。
			this._pluginsStale = true;
			// 超时 5 分钟：这条没有商城那条的取消能力，不能照抄 900s（否则卡住时用户只能干等）；
			// 组合包首次装依赖一般 1-2 分钟量级，够用 ✓。
			const out = await this._runDsh(node, buildPluginAddArgs(dsh.bin, profile, cleanSpec), env, 300_000);
			const after = this._readPkgVersion(manifest);
			if (!after) {
				// 失败要**留全原因**（与 `_ensurePlugin` 同口径：头 + 尾，避免 400 把关键行截掉）
				const clean = redactSecrets(out.trim());
				const kept = clean.length <= 1600 ? clean : `${clean.slice(0, 800)}\n…（中间省略）…\n${clean.slice(-800)}`;
				this._appendLog(`spec install failed; nothing installed: ${kept}`);
				return {
					name: pkgName, ok: false, bundledVersion: '', changed: false,
					...(previousVersion ? { previousVersion } : {}),
					error: `没装上（profile 里读不到 ${pkgName} 的 package.json）——pnpm 输出见 Host / supervisor 日志`,
				};
			}
			const changed = previousVersion !== after;
			this._appendLog(`spec install ok: ${pkgName}@${after}${changed ? '' : '（版本未变）'}`);
			return {
				name: pkgName, ok: true, bundledVersion: after, version: after, changed,
				...(previousVersion ? { previousVersion } : {}),
			};
		} catch (e) {
			return { name: pkgName, ok: false, bundledVersion: '', changed: false, error: String((e as Error)?.message ?? e) };
		}
	}

	/** 上面两条公开安装路径的共用实现（差异只有 label 与调用方给的名字）。 */
	private async _installFromDir(name: string, dir: string, label: string): Promise<IDshBundledInstallResult> {
		const bundledVersion = this._readPkgVersion(join(dir, 'package.json')) ?? '';
		const { profile, dshHome } = this._resolveProfileAndHome();
		const options = this._requestedOptions ?? {};
		let node: IResolvedNode;
		let dsh: IResolvedDsh;
		try {
			node = await this._opts.runtime.resolveNode(options.nodePath);
			dsh = await this._opts.runtime.resolveDsh(options.runtimePath, node);
		} catch (e) {
			return { name, ok: false, bundledVersion, changed: false, error: `解析运行时失败：${String((e as Error)?.message ?? e)}` };
		}
		const env = sanitizedEnv(dshHome ? { DSH_HOME: dshHome } : {});
		const profileDir = this._profileDir(profile, env);
		const manifest = (p: string) => join(profileDir, 'node_modules', ...p.split('/'), 'package.json');
		const previousVersion = this._readPkgVersion(manifest(name));
		const base = { name, bundledVersion, ...(previousVersion ? { previousVersion } : {}) };
		try {
			await this._ensureProfile(node, dsh, profile, env);
			await this._repairSeededStoreMetadata(profileDir);
			this._appendLog(`${label} install: ${name}@${bundledVersion || '?'} (was ${previousVersion ?? 'absent'})`);
			const after = await this._ensurePlugin(name, dir, node, dsh, profile, env, label);
			const ok = !!bundledVersion && after === bundledVersion;
			const changed = ok && previousVersion !== bundledVersion;
			// ★ 版本真变了 ⇒ 任何**已经在跑**的 Host（含 `host.json` 里那个由别的实例拉起的）内存里都是旧代码，
			//   而页面 chunk 由它从磁盘现读 ⇒ "前端新、后端旧"。标记一下：下一次 `start()` **既不原样复用、
			//   也不接管**旧进程，而是起一个读磁盘新代码的 Host（见 `_pluginsStale` 的注释）。
			// ⚠ 2026-10-12 二次踩：原来只在 `_status.state === 'running'` 时标记 —— 而 IDE 刚启动时装插件，
			//   状态还是 `idle`（Host 尚未接管）⇒ 于是**静默接管**了 18:15 的老进程；那个 Host 内存里缺新版
			//   插件、客户端 chunk 却是新的 ⇒ 聊天页白屏（`uiWorkspace in inactive context`，自动重载两次也
			//   不恢复）+ 更早的 `HTTP 400：需要 sessionId 与 personaId`，都是同一类"新旧混用" ✗✗。
			if (changed) {
				this._pluginsStale = true;
				this._appendLog(`${label}: ${name} ${previousVersion ?? 'absent'} → ${bundledVersion} — 已运行的 Host 内存里是旧代码（页面 chunk 却是新的）；下一次 start 会起新 Host，不接管旧进程`);
			}
			return {
				...base,
				ok,
				...(after ? { version: after } : {}),
				changed,
				...(ok ? {} : { error: `装完仍是 ${after ?? '（未装上）'}，目标版本是 ${bundledVersion || '（未知）'}——详见 Host 日志` }),
			};
		} catch (e) {
			return { ...base, ok: false, changed: false, error: String((e as Error)?.message ?? e) };
		}
	}

	/**
	 * 当前 profile 的目录（`<DSH_HOME>/profiles/<profile>`）。
	 * 解析口径与 {@link listPlugins} 一致（Host 未启动时用默认目录只读探测），
	 * 供 VsSaros 自己的 profile 侧文件（插件启停状态）定位。
	 */
	profileDirectory(): string {
		const profile = this._status.profile ?? DSH_DEFAULT_PROFILE;
		const home = this._status.dshHome ?? this._opts.defaultDshHome ?? join(homedir(), '.dsh');
		return join(home, 'profiles', profile);
	}

	/** 实际生效的 `$DSH_HOME`：设置项 → 开发版默认目录 → 环境变量 → `~/.dsh`。 */
	effectiveDshHome(dshHome?: string): string {
		return dshHome?.trim() || this._opts.defaultDshHome || process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
	}

	/**
	 * 是否配过任一 DeepSeek 凭据（决定要不要把官方 deepseek provider 藏出模型选择器）。
	 *
	 * 口径：读 VsSaros 的 `User/settings.json`（userData 目录 = dsh-home 的父目录，
	 * 例 `~/.vssaros-dev/dsh-home` ⇒ userData = `~/.vssaros-dev`）。命中任一即算"配了"：
	 *   ① 内置键 `sessions.agentStudio.provider.deepseek.apiKey`（若将来加了这个内置身份）
	 *   ② `customProviders` 里 `id === 'deepseek'` 且 apiKey 非空的条目
	 * 读不到/判不出 ⇒ **返回 false（按"没配"处理 ⇒ 隐藏）**——这正是用户当下的诉求；
	 * 将来配了 Key，下一次 Host 启动就不再隐藏（覆盖层每次启动重新生成）。
	 */
	private _hasDeepseekCredential(dshHome: string | undefined): boolean {
		if (!dshHome) {
			return false; // 无 dsh-home（安装态走 ~/.dsh）时读不到 VsSaros 设置，按"没配"处理
		}
		try {
			const settingsPath = join(dshHome, '..', 'User', 'settings.json');
			const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
			const direct = settings?.['sessions.agentStudio.provider.deepseek.apiKey'];
			if (typeof direct === 'string' && direct.trim()) {
				return true;
			}
			const customs = settings?.['sessions.agentStudio.provider.customProviders'];
			if (Array.isArray(customs)) {
				return customs.some((c: unknown) => {
					const o = c as { id?: unknown; apiKey?: unknown } | undefined;
					return !!o && o.id === 'deepseek' && typeof o.apiKey === 'string' && o.apiKey.trim() !== '';
				});
			}
		} catch { /* 读不到/判不出 = 按"没配"处理（隐藏） */ }
		return false;
	}

	/**
	 * 运行中的工作。控制桥不可用时返回 undefined（调用方须当作"无法判断"处理，不能当作"空闲"）。
	 */
	async getActivity(): Promise<IHostActivity | undefined> {
		const bridge = this.bridge;
		if (!bridge || this._status.state !== 'running') {
			return undefined;
		}
		try {
			return await bridge.call<IHostActivity>(DshBridgeMethod.HostActivity, undefined, 10_000);
		} catch (e) {
			this._appendLog(`host.activity failed: ${String((e as Error)?.message ?? e)}`);
			return undefined;
		}
	}

	/**
	 * 把**运行期工作区上下文**推给 Host（2026-10-17：切工作区不必重启 Host 的落点）。
	 *
	 * 为什么要它：工作区上下文（Agent Studio 的工作区 id / 工作区根 / 关联根）从前只在 Host **启动时**
	 * 经 `--patch` 注入一次 ⇒ 切工作区必须重启才能生效（而重启会连在跑的会话一起杀掉）。
	 *
	 * ⚠ 这里**只回执、不抛**：认不认得这条调用是调用方**唯一**能据以决定"要不要退回重启"的信号 ✓
	 *   —— 老 Host 的桥会回 `-32601 method not found`（当成 `applied:false`），foundation 缺席 /
	 *   载荷被拒也是 `applied:false`。把它抛上去只会让调用方多一层 try，语义还一样 ✗。
	 */
	async setWorkspaceContext(args: IBridgeWorkspaceContextArgs): Promise<IBridgeWorkspaceContextResult> {
		const bridge = this.bridge;
		if (!bridge) {
			return { applied: false, reason: 'no-bridge' };
		}
		try {
			const result = await bridge.call<IBridgeWorkspaceContextResult>(DshBridgeMethod.WorkspaceContext, args, 10_000);
			return result?.applied ? result : { applied: false, reason: result?.reason ?? 'not-applied' };
		} catch (e) {
			// 老 Host（-32601）/ 桥超时 / Host 刚挂：都按"这次没推成"处理 ⇒ 调用方会退回旧路径 ✓
			return { applied: false, reason: String((e as Error)?.message ?? e) };
		}
	}

	/**
	 * 升级后的健康检查（方案第 3.3 节，去掉需要模型凭据的"发一条消息"那项）：
	 * Host 运行、控制桥握手（插件随包分发时）、认证换 Cookie、首页带 `__DSH_BOOT__` 且启动图里有伴生插件前端。
	 */
	async healthCheck(): Promise<IDshHealthReport> {
		const checks: { name: string; ok: boolean; detail?: string }[] = [];
		const s = this._status;
		checks.push({ name: 'host running', ok: s.state === 'running', detail: s.error ?? s.dshVersion });
		const conn = this.connection;
		if (!conn) {
			return summarizeHealth(checks);
		}
		const expectBridge = !!this._opts.bridgePluginDir;
		if (expectBridge) {
			checks.push({ name: 'bridge handshake', ok: s.bridge === 'connected', detail: s.bridgePluginVersion ?? s.bridge });
		}
		try {
			const r = await fetch(conn.authUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
			const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
			checks.push({ name: 'auth exchange', ok: r.status === 303 && !!cookie, detail: `HTTP ${r.status}` });
			const html = await (await fetch(`${conn.origin}/`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) })).text();
			checks.push({ name: 'page boot graph', ok: html.includes('__DSH_BOOT__') });
			if (expectBridge) {
				checks.push({ name: 'companion client in boot graph', ok: html.includes(DSH_BRIDGE_PLUGIN_NAME) });
			}
		} catch (e) {
			checks.push({ name: 'page reachable', ok: false, detail: String((e as Error)?.message ?? e) });
		}
		return summarizeHealth(checks);
	}

	start(options: IDshHostStartOptions = {}): Promise<IDshHostStatus> {
		this._keepAlive = options.keepAlive === true;
		// ⚠ 例外：插件换过版本就不许复用（见 `_pluginsStale`）——"前端新、后端旧"必须靠换进程消掉。
		if (this._status.state === 'running' && !this._pluginsStale) {
			// 在跑就**原样复用**，新选项不生效：换工作区 / 技能目录 / MCP 都要重启 Host 才更新。
			// 为什么不自动重启：重启会连正在跑的 agent 会话一起杀掉，代价比"选项晚一步生效"更大
			// （工作区 id 的这一步见 `renderKanbanOverlay` 的注释与方案 6.8）。
			// 但**必须在日志里留一句**：否则"卡片写到了旧工作区""技能没生效"这类问题只剩现象，
			// 日志里连"为什么不生效"都查不到——`sameStartOptions` 就是判这个的（有单测）。
			if (this._requestedOptions && !sameStartOptions(this._requestedOptions, options)) {
				this._appendLog('start: options differ from the last start request (workspace / skills / MCP set changed) — not restarting, the running Host keeps the old ones; restart to apply');
			}
			return Promise.resolve(this._status);
		}
		if (!this._starting) {
			this._starting = (async () => {
				await this._stopping;
				if (this._status.state === 'running') {
					// 只有 `_pluginsStale` 能走到这里（上面的复用早退已把常态挡掉）：换进程，
					// 让 Host 重新 require 磁盘上的新插件代码。代价是这一次启动变慢，换来"版本一致"。
					this._pluginsStale = false;
					this._requestedOptions = undefined;
					this._appendLog('start: a bundled plugin changed while the Host was running — restarting the Host so it loads the new plugin code');
					await this.stop();
				}
				return this._doStart(options);
			})().finally(() => this._starting = undefined);
		}
		return this._starting;
	}

	async restart(options: IDshHostStartOptions = {}): Promise<IDshHostStatus> {
		await this.stop();
		return this.start(options);
	}

	stop(): Promise<void> {
		if (!this._stopping) {
			this._stopping = this._doStop().finally(() => this._stopping = undefined);
		}
		return this._stopping;
	}

	// ─── 启动 ────────────────────────────────────────────────────────────────

	/**
	 * profile 与 dsh home 的**纯**解析（含路径写法归一）。
	 *
	 * ★ 归一是硬前提：pnpm 按**长名**算虚拟店位置且用字符串比较，而 Windows 上 `TEMP` / `userData`
	 * 常给 **8.3 短名**（`C:\Users\QIUZIJ~1\…`）⇒ 混用即 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE` ⇒ 伴生包
	 * （含必装的 `@deepseek-ai/dsh-web-app`）装不上 ⇒ 需要它的插件全 pending ⇒ **Host 退出 code 1**。
	 * 必须用 `realpathSync.native`（普通 `realpathSync` 不展开短名）——细节见 `dshStoreMetadata.ts`。
	 *
	 * 抽成一处是因为**启动**与**随包插件安装**（`installBundledPlugin`）都要这套上下文：两边各写一份，
	 * 迟早有一边忘了归一（那正是这轮修的那个错）。
	 */
	private _resolveProfileAndHome(options?: IDshHostStartOptions): { profile: string; dshHome?: string } {
		const opts = options ?? this._requestedOptions ?? {};
		const profile = opts.profile?.trim() || DSH_DEFAULT_PROFILE;
		const configuredHome = opts.dshHome?.trim() || this._opts.defaultDshHome;
		return { profile, dshHome: configuredHome ? normalizeExistingPath(configuredHome) : configuredHome };
	}

	private async _doStart(options: IDshHostStartOptions): Promise<IDshHostStatus> {
		this._requestedOptions = options;
		const generation = ++this._generation;
		const t0 = Date.now();
		const { profile, dshHome } = this._resolveProfileAndHome(options);
		this._setStatus({ state: 'starting', bridge: 'none', profile, dshHome });

		try {
			const node = await this._opts.runtime.resolveNode(options.nodePath);
			const dsh = await this._opts.runtime.resolveDsh(options.runtimePath, node);
			this._appendLog(`node ${node.version} (${node.source}: ${node.path})`);
			this._appendLog(`dsh ${dsh.version} (${dsh.source}: ${dsh.bin})`);
			// ⚠ 2026-10-12：这里必须把**数据根**交给 Host 的**子进程 env** ✓ —— 三条理由（都实测过）：
			//   · 插件口径是 `config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`（6 个模块同形 ✓，
			//     由 `dsh-plugins/check-host-config.mjs` 的契约守着 ✓）；**config 优先** ⇒ 这里注入
			//     **不改变**任何已被覆盖层注入过的行 ✓（零行为改变 ✓，只是补上"覆盖层送不到"的那几处）。
			//   · 覆盖层**送不到**的地方确实存在：`--patch` 打不到 **preset 内部的行** ✓（实测，
			//     见 doc/dsh-shell-contract.html §8 ③）⇒ 不接这条，它们会退回 `~/.vssaros`，
			//     而 dev 模式的数据根是 `~/.vssaros-dev` ⇒ dev 实例会读**生产**数据 ✗
			//     （`common/dshHarness.ts:351` 与 `common/dshCli.ts:421` 的注释记的就是这类事故 ✓）。
			//     R13 把工具挪到 preset 平面时，这条是**前置** ✓。
			//   · 验证：`node poc/dsh-p0/scripts/p3-23-env-only-root.mjs` 的 L3（真回合里 `skill_search`
			//     的工具结果出现 env 根下的标记技能 ✓，反向对照换个根则不出现 ✓，含反向突变 ✓）。
			const dataRootEnv = options.dataRoot?.trim();
			const env = sanitizedEnv({
				...(dshHome ? { DSH_HOME: dshHome } : {}),
				...(dataRootEnv ? { VSSAROS_DATA_ROOT: dataRootEnv } : {}),
				// ★ 2026-10-22：Host 运行时版本 ⇒ `@vssaros/dsh-market` 装第三方工作台前用它做兼容判定
				//   （与 Host 启动时跳过不兼容插件**同一个判据、同一个版本**；没有它就只能用 app-boot 自报的版本）。
				...(dsh.version ? { VSSAROS_DSH_RUNTIME_VERSION: dsh.version } : {}),
			});
			// ★ 2026-10-15：把**随包媒体二进制目录**（ffmpeg / ffprobe / yt-dlp / whisper…，打包管线
			//   `build/saros/strip-before-pack.mjs` 的 ensureOptionalBin 段）注入 Host 的 PATH ⇒
			//   dsh 会话里的 shell 工具（execute_code / bash / pwsh）能直接用**裸命令名**解析它们。
			//   不注的现场：真机上模型抓小红书视频时报"yt-dlp / ffmpeg 本机未安装"——其实安装包里带着，
			//   只是不在 PATH 上（模型走 shell 而不是走 IDE 侧的 `mediaBinaries.ts` 解析链 ✗）。
			//   顺序：**内置优先于用户 PATH**（与 `mediaBinaries.ts` 的 override → bundled → path 优先级对齐 ✓）；
			//   想用自己的版本 ⇒ 设 `FFMPEG_PATH` / `YTDLP_PATH`（IDE 侧媒体工具认得它们，Host 原样继承 ✓）。
			//   ⚠ Windows 的 PATH 键大小写不固定（`Path` / `PATH` 都有）⇒ 必须**按现有键的原样大小写**改，
			//   否则子进程会同时拿到两个键、行为未定义 ✗。
			const mediaBinDir = bundledMediaBinDir();
			if (mediaBinDir) {
				const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
				env[pathKey] = `${mediaBinDir}${delimiter}${env[pathKey] ?? ''}`;
				// ★ 同一个目录还得给**环境变量**一份：PATH 只管"裸命令名 → exe"（shell 那侧 ✓），
				//   而插件自己的解析链（如 `vssaros-web-content-import` 的 `resolveBinary` /
				//   `resolveWhisperModel`）读的是 `config.binDir` / `VSSAROS_BIN_DIR` —— 不注这个，
				//   whisper **模型**（`<binDir>/../models/ggml-base.bin`）照样找不到（PATH 里没有模型文件 ✗，
				//   2026-10-15 真机现场：exe 起来了、模型落空 ⇒ ASR 段报"找不到 whisper 模型"）。
				//   ⚠ 不覆盖用户显式设过的值（override 优先 ✓，与 `mediaBinaries.ts` 的顺序一致）。
				if (!env.VSSAROS_BIN_DIR?.trim()) {
					env.VSSAROS_BIN_DIR = mediaBinDir;
				}
				this._appendLog(`media bin dir prepended to Host PATH: ${mediaBinDir}${env.VSSAROS_BIN_DIR === mediaBinDir ? '（VSSAROS_BIN_DIR 同步注入 ✓）' : ''}`);
			}
			// **仅诊断用的注入口**（生产永不设置 `VSSAROS_DSH_HOST_PRELOAD`）：把 preload 挂到 Host 进程上，
			// 用于"加载期插桩"——本机对依赖产物（`node_modules/`、`poc/dsh-p0/.runtime/`）的写入会被
			// **静默回滚**（README 4.57），所以插桩只能由我们自己的 loader hook 在**加载源码时**改，
			// 磁盘上的包一个字节也不动。必须在 `sanitizedEnv` **之后**补：它会主动删 `NODE_OPTIONS`。
			const hostPreload = process.env.VSSAROS_DSH_HOST_PRELOAD;
			if (hostPreload) {
				// ⚠ Windows 上 `--import` **必须**给 `file://` URL：给路径会报
				// `ERR_UNSUPPORTED_ESM_URL_SCHEME … Received protocol 'g:'`（实测，Host 直接起不来 ⇒ 探针 2/11）。
				env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--import "${pathToFileURL(hostPreload).href}"`;
				this._appendLog(`诊断 preload 已注入 Host：${hostPreload}`);
			}

			await this._ensureProfile(node, dsh, profile, env);
			// 种子拷贝（或历史遗留）会带着**构建期**的 pnpm 元数据：node_modules/.modules.yaml 的
			// virtualStoreDir 指向 seed 自己的路径 → 之后每次 `dsh plugin add` 都 ERR_PNPM_UNEXPECTED_STORE
			// （实测伴生插件全部升不上去，dev 实例长期跑旧插件）。这里装插件前无条件校正一次
			// （幂等：只在值不一致时写），新种子与既有 profile 都覆盖。
			await this._repairSeededStoreMetadata(this._profileDir(profile, env));
			// 伴生插件逐个安装（profile 的 pnpm 锁决定了并行没收益），进度报给状态区。
			const plugins: [string, string | undefined, string][] = [
				// ⚠ **要先装它**：dsh 官方 web app 提供 `webServer` / `connection` 两个服务。缺它时
				// bridge / chat-surface / codebase / memory 等全部**永远 pending** ⇒ bridge 不会去建
				// 控制桥管道 ⇒ VsSaros 侧 `DshBridgeClient.connect` 60s 超时（ENOENT）⇒ **Host 退出 code 1**。
				// 2026-10-11 实测根因：App 侧 profile 缺它、探针侧有它（README 4.79）。
				[DSH_WEB_APP_BUNDLE_NAME, resolveSiblingPackage(dsh.bin, DSH_WEB_APP_BUNDLE_NAME), 'web-app bundle'],
				// foundation（重构 1.3）：所有模块插件的共享服务（dataRoot/dshHome/pageShell/lock 真源），
				// **必须在模块插件之前**装上——消费者 apply 时 inject 它，缺了它们会永远 pending。
				[DSH_FOUNDATION_PLUGIN_NAME, this._opts.foundationPluginDir, 'foundation plugin'],
				// 工作台宿主（2026-10-22）：提供 `desktopWorkbenches`；**必须在模块插件之前**（迁成 React 的
				// 工作台客户端注册进它）。它没有 `vssaros.module` ⇒ 模块自发现不会装它，只能列在这里。
				[DSH_WORKBENCHES_PLUGIN_NAME, this._opts.workbenchesPluginDir, 'workbench host plugin'],
				[DSH_BRIDGE_PLUGIN_NAME, this._opts.bridgePluginDir, 'companion plugin'],
				// chat-surface（聊天框绑定会话）：装不上不影响启动，聊天框退回官方默认形态（不绑定会话）。
				[DSH_CHAT_SURFACE_PLUGIN_NAME, this._opts.chatSurfacePluginDir, 'chat-surface plugin'],
				// 知识库 `@` 引用源（P1-1）：纯客户端插件**装不上不影响启动**，只是聊天框里没有「知识库」那组候选。
				[DSH_KB_REFS_PLUGIN_NAME, this._opts.kbRefsPluginDir, 'kb-refs plugin'],
				// ★ Host 侧的 `browser` / `unreal_*`（README 4.69 Step 1）：这两族原先经反向通道交给 IDE 进程
				//   执行（没有 VsSaros 就整族不可用），搬到 Host 后两种入口都能用。
				//   `vssaros-ide` 会检查 `ctx.get('vssarosBrowser'/'vssarosUnreal')` 并**让路** ⇒ 任何时刻
				//   只有一个同名工具（两个都注册会让整条 entry 失效，表现成"工具静默少了一批"）。
				//   装不上不影响启动：`vssaros-ide` 那条路会继续兜底（它只在服务**在**的时候让路）。
				[DSH_BROWSER_PLUGIN_NAME, this._opts.browserPluginDir, 'host browser plugin'],
				[DSH_UNREAL_PLUGIN_NAME, this._opts.unrealPluginDir, 'host unreal plugin'],
				// **vendored 第三方技能包**（archify）：随包自动装（2026-10-14，用户要求"默认随包"）。
				// 与前两个同一条路（存在才装、装不上不影响启动 ⇒ 只是技能库里少一个 archify ✓）。
				// 装的是**本地暂存目录**（零网络）⇒ 首启只多一次暂存拷贝，不像 npm 那条要等 30s+ ✓。
				[DSH_ARCHIFY_PLUGIN_NAME, this._opts.archifyPluginDir, 'archify skill bundle'],
				// **ego lite 的接入插件**（`ego_status` / `ego_guide` / `ego_spaces` / `ego_run` + 随包技能）：
				// 与 archify / browser 同一条"存在才装、装不上不影响启动"的路（本地暂存目录 ⇒ 零网络）。
				// 它不提供浏览器本体（第三方 app 单独安装）⇒ 缺席只是少一个可选浏览器，不是能力回归。
				[DSH_EGO_PLUGIN_NAME, this._opts.egoPluginDir, 'ego lite plugin'],
				// 模块插件（agents / skills / mcp / kb / memory / codebase / kanban / workflow / dashboard / ide）：
				// **全部随包自动安装**（2026-10-11 用户要求）。清单由 channel 用 `listBundledPlugins` 自发现
				// （判据 `vssaros.module`，与插件中心「随包」段、容器聚合表同一真源）⇒ 新增模块不必改这里。
				// 装不上不影响 Host 启动，只是少了那块模块能力（例：agents 缺 ⇒ 聊天框 Agents 只剩内置 preset）。
				...this._opts.modulePluginDirs.map(([name, dir]) => [name, dir, `${name} module`] as [string, string, string]),
				// 语音输入（官方实验 bundle，随 dsh 运行时分发）：本地 SenseVoice 识别，麦克风按钮进 composer。
				// 装不上不影响启动，聊天框只是没有语音入口。模型权重首次使用时下载到 DSH_HOME。
				[DSH_VOICE_BUNDLE_PLUGIN_NAME, resolveSiblingPackage(dsh.bin, DSH_VOICE_BUNDLE_PLUGIN_NAME), 'voice-input bundle'],
				// 调度（官方实验 bundle，重构 2.1；S3 已验证）：time-context / schedule 服务 / ui-schedule。
				// 装不上不影响启动，只是没有定时任务能力（legacy 调度器本来就不执行 ⇒ 无回归）。
				[DSH_SCHEDULE_BUNDLE_PLUGIN_NAME, resolveSiblingPackage(dsh.bin, DSH_SCHEDULE_BUNDLE_PLUGIN_NAME), 'schedule bundle'],
			];
			// ★ 2026-10-12：本次启动要装的伴生插件若**没装上**，就记一笔 —— `_ensurePlugin` 失败时
			//   只写日志并继续，于是缺包的 profile 最终表现为"60 秒没有任何进展"✗（真因埋在 Host 日志里）。
			//   清单交给启动失败文案说出来（见 `_startupPluginProblems` 与 `startupExpiryMessage`）。
			this._startupPluginProblems = [];
			// ★ 2026-10-13 首启提速（用户报"首次启动很慢：安装伴生插件→启动 host→加载工作区"）：
			//   原来这里逐个 `await _ensurePlugin(...)` ⇒ **每个变更插件**一次 `dsh plugin add`
			//   （= 一个 pnpm 进程，实测 2–5 s）**串行叠加**：dev 实例实测 6 个变更 = 17 s 才轮到起 Host，
			//   而 Host 冷启动 6 s、工作区注册 0.3 s ⇒ 24 s 的首启里 **17 s 全耗在这里** ✗。
			//   改成**先判定、再一次装**：
			//     · 判定（`_planPluginInstall`）只读 package.json，几乎零成本 ✓
			//     · 暂存拷贝**并行**（各插件压各自的版本目录，互不相干）✓
			//     · **一条** `dsh plugin add spec1 spec2 …`（dsh 把非自有参数原样转交 pnpm、pnpm 的 add
			//       接受多包；依据写在 `buildPluginAddArgsMany` 的注释里）⇒ N 次进程 + N 次解析收敛成 1 次 ✓
			//   安全网：批量漏装的那几项**回退 `_ensurePlugin` 逐项装**（行为与旧版逐字一致）⇒ 即便
			//   将来 dsh 改窄参数，最坏也只是回到从前的速度，不会装不上 ✓。
			const wants: { name: string; dir: string; label: string; bundled: string; installed?: string; fingerprint?: string }[] = [];
			for (let i = 0; i < plugins.length; i++) {
				const [name, dir, label] = plugins[i];
				this._progress(`正在安装伴生插件（${i + 1}/${plugins.length}）…`);
				const want = this._planPluginInstall(name, dir, label, profile, env, options.skipPluginInstall === true);
				if (want) {
					wants.push(want);
				}
			}
			const pluginProfileDir = this._profileDir(profile, env);
			const installedVersionOf = (name: string) => this._readPkgVersion(join(pluginProfileDir, 'node_modules', ...name.split('/'), 'package.json'));
			// ★ 2026-10-21：版本错配自检（profile 已装 vs 随包）—— 漏装/不同代要**在日志里点名**。
			this._auditBundledVersions(plugins, pluginProfileDir);
			if (wants.length) {
				// 真的执行了安装动作（升级既有 / 补装缺失）⇒ 置标记：下一次 `start()` 不接管旧 Host
				// （旧进程内存里是旧代码 / 缺这个包，见 `_pluginsStale` 的注释）✓。
				this._pluginsStale = true;
				for (const w of wants) {
					this._appendLog(`installing ${w.name}@${w.bundled} (was ${w.installed ?? 'absent'})`);
				}
				const t0 = Date.now();
				const specs = await Promise.all(wants.map(w => this._stagePlugin(w.name, w.dir, w.bundled, pluginProfileDir, w.fingerprint).then(toFileSpec)));
				const out = await this._runDsh(node, buildPluginAddArgsMany(dsh.bin, profile, specs), env, 120_000 + wants.length * 15_000);
				// 复核口径 = **版本 + 入口内容**（2026-10-14）：只看版本时，"同版本内容变了"的假成功会被报成
				// `N ok`（现场：`4 ok, 0 to retry`，而其中一个副本是两天前的旧代码 ✗✗），谁也不知道那 8 秒
				// 是白花的、跑的还是旧代码。内容判据与 `_installedEntryMatches` 共用同一份定义 ✓。
				const installedDirOf = (name: string) => join(pluginProfileDir, 'node_modules', ...name.split('/'));
				const missed = wants.filter(w => installedVersionOf(w.name) !== w.bundled || !this._installedEntryMatches(w.dir, installedDirOf(w.name)));
				this._appendLog(`one-shot install of ${wants.length} plugin(s) took ${Date.now() - t0} ms: ${wants.length - missed.length} ok, ${missed.length} to retry`);
				// 版本已相同、内容仍不一致 ⇒ pnpm 把**同路径的 `file:` 依赖**当成"没变化"而跳过了替换 ——
				// 这份副本是陈旧的（Host 会跑旧代码）。**必须说出来**：沉默时它表现为"每次启动都重装、
				// 每次都说 ok、内容永远不变"（2026-10-14 真机现场），是最难查的一类静默失效。
				const staleAfterInstall = missed.filter(w => installedVersionOf(w.name) === w.bundled);
				if (staleAfterInstall.length) {
					this._appendLog(`⚠ 同版本重装后入口内容仍与随包不一致（pnpm 跳过了同路径 file: 依赖的替换）⇒ 这些副本是陈旧的，Host 会跑旧代码：${staleAfterInstall.map(w => w.name).join(', ')}（随包目录应已换指纹命名，若仍如此请查暂存目录是否可写）`);
				}
				if (missed.length) {
					// 保头+尾（400 曾把真正的错误行截掉只剩栈尾，语音 bundle 排查实测）。
					const clean = redactSecrets(out.trim());
					const kept = clean.length <= 1200 ? clean : `${clean.slice(0, 600)}\n…（中间省略）…\n${clean.slice(-600)}`;
					this._appendLog(`批量安装输出（${missed.length} 项未到位）：${kept}`);
					for (const w of missed) {
						await this._ensurePlugin(w.name, w.dir, node, dsh, profile, env, w.label, false);
					}
				}
			}
			// 收敛结果：谁最终没到位就记一笔（交给启动失败文案，见 `_startupPluginProblems`）。
			// 口径与 `_ensurePlugin` 的返回契约一致：装上了 = 随包版本；不等于随包版本就是没装上
			// （`skipPluginInstall` 主动跳过升级时也会命中 ✓ 合理）。
			for (const [name, dir] of plugins) {
				const want = dir ? this._readPkgVersion(join(dir, 'package.json')) : undefined;
				if (want && installedVersionOf(name) !== want) {
					this._startupPluginProblems.push(`${name}（应 ${want}，实为 ${installedVersionOf(name) ?? '未装'}）`);
				}
			}
			// ★ 内容口径的收敛检查（2026-10-14）：版本对得上**不足以**说明这份副本就是随包那一份 ——
			//   "同版本内容变了但 pnpm 没替换"时，上面那条会把**两天前的旧代码**当成到位，而 Host 启动失败时
			//   给出的原因列表里也就没有它（最难查的一类：明明在报别的错，真因是插件陈旧 ✗）。
			//   只查**本次计划装过**的那几项：其余插件在判定阶段刚做过同一份内容比对（通过 ⇒ 不必重复读盘 ✓）。
			for (const w of wants) {
				if (installedVersionOf(w.name) === w.bundled && !this._installedEntryMatches(w.dir, join(pluginProfileDir, 'node_modules', ...w.name.split('/')))) {
					this._startupPluginProblems.push(`${w.name}（版本 ${w.bundled} 但入口内容仍与随包不一致 ⇒ 跑的是陈旧副本）`);
				}
			}
			const bridgeVersion: string | undefined = installedVersionOf(DSH_BRIDGE_PLUGIN_NAME);
			// 收敛"必须与运行时同一模块实例"的 dsh 包——不同实例会让**实时启停永远失败**（见该方法注释）。
			await this._dedupeSharedPackages(dsh, profile, env);
			this._progress('正在启动 Host…');
			this._throwIfStale(generation);

			// 多实例复用（方案 7.5）：先试 `$DSH_HOME/host.json` 里的既有 Host。
			const leases = new DshHostLeaseStore(this.effectiveDshHome(options.dshHome), line => this._appendLog(line));
			this._leaseStore = leases;
			const existing = leases.read();
			if (existing && this._pluginsStale) {
				// ★ 插件换过版本 ⇒ **不许接管**这个 Host（见 `_pluginsStale` 的注释）。它内存里是旧插件代码，
				//   而客户端 chunk 由它从磁盘现读 ⇒ "前端新、后端旧" ⇒ 2026-10-12 实测白屏
				//   （`uiWorkspace in inactive context`；重载页面两次也救不回来，因为源头在 Host 内存里）✗✗。
				//   宁可多花一次冷启动（用户能预期的一次等待），也不要那种无从解释的错版本 ✓。
				//   ⚠ **2026-10-13 订正**：这里原来写"旧进程不杀：它有自己的空闲 TTL 与租约，别的 IDE 窗口
				//   可能还在用" ✗ —— 前半句靠不住（真机实测 16:30/16:58/17:18 三份 Host 同时活着 ✗），后半句
				//   只在"拥有者 app 还活着"时成立 ✓。现在改成：**拥有者已退出或就是自己 ⇒ 由
				//   `reapOrphanHosts` 回收**（见下面那处调用）✓；拥有者活着 ⇒ 才不动它 ✓。
				this._appendLog(`not reusing the running Host (pid ${existing.pid}): bundled plugins changed on disk — that process still runs the previous plugin code; starting a fresh Host instead`);
			} else if (existing) {
				const blocker = hostLeaseBlocker(existing, { dshVersion: dsh.version, profile });
				if (blocker) {
					this._appendLog(`not reusing the running Host: ${blocker}`);
				} else {
					const unreachable = await leases.probe(existing);
					if (!unreachable && await this._adoptLease(existing, generation, profile, dshHome, t0)) {
						return this._status;
					}
					if (unreachable) {
						this._appendLog(`running Host not reusable: ${unreachable}`);
					}
					await leases.removeIfStale();
				}
			}

			// 另起 Host。启动锁让同时启动的另一个实例等待；等待期间先者可能已写出租约。
			const want = { dshVersion: dsh.version, profile };
			// 走到这里就是在"要起一个新 Host"了 —— 但**先别清标记**：清早了会让并发的第二次 start
			// 又去接管旧进程 ✗（2026-10-12 实测），统一在**真正 spawn 成功**之后清 ✓。
			const pluginsWereStale = this._pluginsStale;
			const leaseFromLock = await leases.acquireStartLock(START_LOCK_WAIT_MS);
			try {
				this._throwIfStale(generation);
				// 锁竞争里那个 Host 同样可能是旧代码（别的实例拉起它时还没装上新插件）⇒ 同样不接管 ✓。
				if (leaseFromLock && !pluginsWereStale && !hostLeaseBlocker(leaseFromLock, want) && !(await leases.probe(leaseFromLock))) {
					if (await this._adoptLease(leaseFromLock, generation, profile, dshHome, t0)) {
						return this._status;
					}
				}

				// ★ 2026-10-13：**判定不复用之后**才回收孤儿 ✓ —— 顺序要紧 ✗：先试复用（上面两处早退），
				//   走到这里说明"要起新的、且旧的不接管"，此时才结束那些**拥有者已退出或就是自己**的旧 Host ✓
				//   （拥有者还活着一律不动 ✓：别的窗口可能正接在上面 ✗）。
				//   不这么做的话，`keepAlive` 的旧 Host 会一直活着攥着会话写句柄 ✗ ⇒ 用户端现象是
				//   `SessionAlreadyOwnedError: session "…" is already owned by an active write handle`
				//   （斜杠命令目录预热失败 ✗；2026-10-13 实测 ✗）。
				await reapOrphanHosts({
					runDir: this._opts.runDir || tmpdir(),
					selfAppPid: process.pid,
					log: line => this._appendLog(line),
				});

				const overlays: string[] = [];
				let pipe: string | undefined;
				let token: string | undefined;
				// 官方「Preview Notice」弹窗的抑制版本（从运行时包读常量；读不到就不抑制）。
				const welcomeNoticeVersion = this._welcomeNoticeVersion(dsh);
				const runId = randomBytes(6).toString('hex');
				// ★ 2026-10-16：拥有者记录的**路径**要在 spawn 之前就定下来 ✗ —— 它随 `client.register`
				//   的握手交给桥插件（= 看门狗的目标），而那次握手发生在 `_awaitReady` 里，比"写记录"
				//   那一步更早 ⇒ 晚定就只能给一个 undefined ✓（那时插件保持原目标，等于看门狗不工作 ✗）。
				//   文件本身仍等 ready 之后才写（那时才知道 hostPid ✓）；插件读不到记录时**一律不动** ✓。
				this._ownershipFile = join(this._opts.runDir, hostRunOwnershipFileName(runId));
				if (bridgeVersion) {
					pipe = bridgePipePath(process.platform, runId, this._opts.runDir || tmpdir());
					token = randomBytes(24).toString('base64url');
				}

				// ★ 覆盖层的**渲染只有一处真源**：`common/dshHostConfig.ts` 的 `renderHostOverlays`（README 4.64）。
				//   这里只负责"把配置凑齐 → 渲染 → 写盘 → 记住文件（`_cleanupRunFiles` 靠这些字段删）"，
				//   不再自己调 `renderXxxOverlay`：独立启动器（没有 VsSaros）要的是**同一组**覆盖层，两份平行
				//   实现一漂移就是**静默错配**（dev 实例读生产数据、覆盖层打空且不报错）。顺序与条件由它保证。
				const workspaceId = options.workspaceId?.trim();
				const workspaceRoot = options.workspaceRoot?.trim();
				const agentsRoot = options.agentsRoot?.trim();
				const dataRoot = options.dataRoot?.trim();
				// 技能库：目录增删重启 Host 后生效 ⇒ 先过滤出**真实存在**的目录（渲染器不查盘）
				const skillDirs = options.skillDirs?.filter(d => typeof d === 'string' && existsSync(d)) ?? [];
				// 内置技能目录：走官方 `bundledSkillDir`（rank 600）⇒ 同样在这里过滤存在性 ✓
				// （渲染器不查盘；不存在就不注入，覆盖层里只剩 customSkillDirs ✓）
				const bundledDirRaw = options.bundledSkillDir?.trim();
				const bundledSkillDir = bundledDirRaw && existsSync(bundledDirRaw) ? bundledDirRaw : undefined;
				const memoryGatewayUrl = memoryGatewayUrlFromEnv(process.env);
				// ★ 沙箱兼容探针（一个进程只探一次；完整缘由见 `common/dshSandboxCompat.ts`）：
				// 本机若禁止写 Low 完整性标签，dsh 默认的 `workspace-write`（Windows 的 windows-acl 档）
				// 会在**每次工具调用**的 grant 阶段失败 —— 用户端是一排
				// `SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>)`，而 runner 的设计是
				// "绝不无沙箱启动子进程" ⇒ **不降级、直接失败** ✗✗（且 IDE 日志里毫无痕迹，只能看聊天）。
				// 探不通就用覆盖层把模式降成 `danger-full-access` ✓ —— **只降沙箱、不动审批**
				// （审批行的策略读 `DSH_PERMISSION_MODE` 环境变量，我们不碰它 ⇒ 审批闸照旧 `ask` ✓）。
				// ⚠ 探**真实目标路径**：dsh 那行的 `workspaceRoot` 是 `process.cwd()`（没工作区时就等于它）
				// ⇒ 探针也跟着指同一个目录，绝不用 `os.tmpdir()` 之类"差不多的地方"代替（那是假阳性 ✓
				// ——首版就这么写的，实测在本机返回 ok=true 而工作区下根本写不了标签 ✗✗）。
				// ⚠ 路径口径（2026-10-13 修）：**没有工作区时**必须探"dsh 那行实际会用的根"——它是 Host
				//   进程的 `process.cwd()`，而本壳起 Host 用 `cwd: homedir()`（见下面的 spawn ✓）
				//   ⇒ 用 `SANDBOX_FALLBACK_ROOT`（= homedir ✓）与它对齐。旧写法探的是**主进程**的 cwd ✗
				//   ⇒ 与 dsh 实际要写的路径不是同一个（假阳性/假阴性都可能 ✗）；更糟的是降级覆盖层因为
				//   缺 `workspaceRoot` 索性**不发** ⇒ 降级**静默失效** ⇒ 每条 `pwsh` 都被问一次 ✗✗。
				const sandboxProbeRoot = workspaceRoot ?? SANDBOX_FALLBACK_ROOT;
				const sandboxProbe = await probeLabelWriteOnce(sandboxProbeRoot);
				const sandboxFallback = !sandboxProbe.ok;
				if (sandboxFallback && !this._sandboxProbeLogged) {
					this._sandboxProbeLogged = true;   // 只 warn 一次（Host 会被反复重启）
					this._appendLog(`sandbox unusable on this machine — downgrading dsh sandbox mode to ${SANDBOX_FALLBACK_MODE}: ${sandboxProbe.detail}`);
				}
				// ★ 2026-10-19：内置 agent 目录（由 `common/builtinAgents.ts` 这份**代码真源**生成 md 副本）。
				//   生成失败**不致命**：只是列表里少一档内置 agent，不能因此起不来 Host（方法内自己吞错）。
				const agentsBuiltinRoot = await this._writeBuiltinAgentsDir(options.agentsBuiltinSrc?.trim() || undefined);
				const hostConfig: IDshHostConfig = {
					...(pipe && token ? {
						bridge: {
							pipe, token,
							hideOfficialDeepseek: !this._hasDeepseekCredential(dshHome),
							...(welcomeNoticeVersion ? { welcomeNoticeVersion } : {}),
							// ★ 2026-10-15（解法 A）：显式给 TTL —— 否则桥插件用 30min 默认，IDE 重启间隔稍长
							//   Host 就自杀 ⇒ 二次启动又是 ~27s 冷启 ✗（取值权衡见 common/dshHostConfig.ts 的常量注释）。
							idleTtlMs: DSH_HOST_IDLE_TTL_MS,
						},
					} : {}),
					...(dataRoot ? { dataRoot } : {}),
					...(workspaceId ? { workspaceId } : {}),
					...(workspaceRoot ? { workspaceRoot, relatedRoots: options.relatedRoots ?? [] } : {}),
					...(agentsRoot ? { agentsRoot } : {}),
				// ★ 内置 agent 目录（启动期由代码真源生成；Host 侧因此能列出内置 agent ✓）
				...(agentsBuiltinRoot ? { agentsBuiltinRoot } : {}),
					// A 组缺口（2026-10-12）：这两条过去**根本没有等价配置键** ⇒ 用户在 IDE 里改了知识库存储根 /
					// unreal bridge 地址，dsh 侧照旧读默认值（前者表现为"资料库/画布空着但不报错" ✗）。
					...(options.kbRoot?.trim() ? { kbRoot: options.kbRoot.trim() } : {}),
					/* ★ IM（飞书）入站凭据（2026-10-27）：与 agentsRoot 写进**同一行**
					   （`renderAgentsOverlay` 产出；同一行两份覆盖层时 config 是整体替换 ⇒ 不能拆）。 */
					// ★ 库记录（2026-10-15）：与 kbRoot 同一份覆盖层 ✓（`renderDataRootOverlay` 里写进
					//   `vssaros-kb` 那一行 ✓ —— 那份 config 整体替换 ⇒ 拆两份会互相擦掉 ✗）。
					...(options.kbVaults?.trim() ? { kbVaults: options.kbVaults.trim() } : {}),
					...(options.kbActiveVaultId?.trim() ? { kbActiveVaultId: options.kbActiveVaultId.trim() } : {}),
					...(options.unrealBridgeUrl?.trim() ? { unrealBridgeUrl: options.unrealBridgeUrl.trim() } : {}),
					// browser（2026-10-14）：同上一条缺口 —— IDE 那三个 `browserCdp.*` 设置此前到不了 Host
					//（插件只读自己的 config / `VSSAROS_BROWSER_*`）⇒ 关掉「自动拉起调试实例」不生效，
					// 抓已登录站点时被静默导向**空 profile** 的专属实例（现场＝先撞登录墙）。
					...(options.browser ? { browser: options.browser } : {}),
					...(skillDirs.length ? { skillDirs } : {}),
					// 内置技能单列（rank 600，见 `common/dshSkillDirs.ts`）—— 与 `skillDirs` **互不重叠** ✓
					...(bundledSkillDir ? { bundledSkillDir } : {}),
					// 记忆网关地址拿不到就不给（尊重模块"不猜端口"的纪律）；MCP 那条在下面**单独**处理
					...(memoryGatewayUrl ? { gatewayUrl: memoryGatewayUrl } : {}),
					// 沙箱降级（探针结论；探通了就**不给**这个字段 ⇒ 保持 dsh 默认 ✓）。
					// ★ 降级时必须**同时**给沙箱行一个根：那行的 `config` 是**整体替换** ✗ ⇒ 只写 `mode`
					//   会把 `workspaceRoot` 擦掉 ✓。有工作区就用它 ✓；没有就补 `SANDBOX_FALLBACK_ROOT`
					//   （与上面探针**同源** ✓）。⚠ 刻意**不顶** `config.workspaceRoot` —— 那个字段也喂给
					//   代码图谱那行，顶上去会让图谱去读 `~/.codebase-memory`（空着且不报错 ✗✗）。
					...(sandboxFallback ? {
						sandboxMode: SANDBOX_FALLBACK_MODE,
						...(workspaceRoot ? {} : { sandboxWorkspaceRoot: SANDBOX_FALLBACK_ROOT }),
					} : {}),
				};
				/** 落盘一条覆盖层并记住文件（文件名与中立入口共用 `hostOverlayFileName`）。 */
				const writeOverlay = async (kind: DshHostOverlayKind, text: string): Promise<void> => {
					await fsp.mkdir(this._opts.runDir, { recursive: true });
					const file = join(this._opts.runDir, hostOverlayFileName(kind, runId));
					await fsp.writeFile(file, text, { mode: 0o600 });
					switch (kind) {
						case 'bridge': this._overlayFile = file; break;
						case 'kanban': this._kanbanOverlayFile = file; break;
						case 'codebase': this._codebaseOverlayFile = file; break;
						case 'skills': this._skillsOverlayFile = file; break;
						case 'agents': this._agentsOverlayFile = file; break;
						case 'dataRoot': this._dataRootOverlayFile = file; break;
						case 'memory': this._memoryOverlayFile = file; break;
						case 'sandbox': this._sandboxOverlayFile = file; break;
						default: break;   // `mcp` 不走这里（它有"让路"逻辑，见 `_writeMcpOverlay`）
					}
					overlays.push(file);
				};

				// MCP 服务器：dsh-mcp-client 是"一个服务器一个组合行"、没有运行时注册 API（见 common/dshMcpConfig.ts），
				// 所以每次启动时把 VsSaros 的 mcp.json 渲染成覆盖层；配置改动重启 Host 后生效。
				// 这一条**不进** `renderHostOverlays`：写入前要读盘+解析，而且"行已归 dsh 侧就让路"（登记过
				// `@vssaros/dsh-mcp-rows` 时两条路不能并存，否则同一台服务器挂两遍 ✗）。渲染器仍是同一个。
				const mcpConfigPath = options.mcpConfigPath?.trim();
				const mcpOverlayFile = mcpConfigPath
					? await this._writeMcpOverlay(mcpConfigPath, this._profileManifest(profile, env))
					: undefined;

				// 渲染 + 写盘（各条的目的、行 id 约束与"不注入会怎样"都写在 `common/dshHostConfig.ts` /
				// 各渲染器的注释里——报告只说结论：配置一定来自 `hostConfig`，别在这里又手写覆盖层）。
				// 日志文案保持与旧实现一致（排查时按这些字样搜日志）。
				const logOfKind: Partial<Record<DshHostOverlayKind, string>> = {
					skills: `skills overlay: ${skillDirs.length} dir(s)${bundledSkillDir ? ` + bundled: ${bundledSkillDir}` : ''}`,
					...(agentsRoot ? { agents: `agents overlay: ${agentsRoot}` } : {}),
					...(dataRoot ? { dataRoot: `data-root overlay: ${dataRoot}` } : {}),
					...(memoryGatewayUrl ? { memory: `memory overlay: ${memoryGatewayUrl}` } : {}),
					...(sandboxFallback ? { sandbox: `sandbox overlay: mode=${SANDBOX_FALLBACK_MODE}（本机写不了完整性标签）` } : {}),
				};
				let mcpPushed = false;
				for (const overlay of renderHostOverlays(hostConfig)) {
					// MCP 那条按旧顺序插在 codebase 之后、skills 之前（它打的是**别的行**，跨条顺序不影响语义，
					// 只为让 run 目录里的文件与日志保持旧的可读顺序）。
					if (!mcpPushed && mcpOverlayFile && overlay.kind !== 'bridge' && overlay.kind !== 'kanban' && overlay.kind !== 'codebase') {
						overlays.push(mcpOverlayFile);
						mcpPushed = true;
					}
					const note = logOfKind[overlay.kind];
					if (note) {
						this._appendLog(note);
					}
					await writeOverlay(overlay.kind, overlay.text);
				}
				if (mcpOverlayFile && !mcpPushed) {
					overlays.push(mcpOverlayFile);   // 后面没有别的覆盖层时补在末尾：不能因为它"晚"就丢掉
				}

				// ── 端口稳定性（2026-10-14 缓存命中率根因，详见 common/dshHostPortPreference.ts）──
				// dsh 把 `http://127.0.0.1:<port>` 写进**每一条 system 提示**，而 `--port 0` 每次
				// 分配到的端口都不同 ⇒ 每次 Host 重启后 system 提示的字节都变 ⇒ provider 的
				// **prompt 前缀缓存整段失效**。真机实证（hy4-preview-ioa，同一会话 6 次请求）：
				// system 提示 302 行里 299 行逐字相同，**唯一差异就是那一行的端口**，
				// 累计缓存命中率 6.4%；而同会话内端口未变的那次调用能到 98.6%。
				// 复用上次端口（探测空闲才用），任何异常回落 0 —— 稳定性是优化，不是启动前置条件。
				const hostPort = await resolveHostPort(this.effectiveDshHome(options.dshHome));
				const args = buildHostArgs(dsh.bin, profile, overlays, hostPort);
				// keepAlive 的关键细节：stdout/stderr 不能走管道——IDE 退出后管道破裂，Host 写日志
				// EPIPE 直接崩（实测"keepAlive 存活日志打了、pid 却没了"）。常驻模式改为写日志文件，
				// _awaitReady 轮询文件内容找 URL 行；非常驻维持管道（日志直达主进程，少一层延迟）。
				let hostLogFile: string | undefined;
				let child;
				if (this._keepAlive) {
					await fsp.mkdir(this._opts.runDir, { recursive: true });
					hostLogFile = join(this._opts.runDir, `host-${randomBytes(4).toString('hex')}.log`);
					const fd = await fsp.open(hostLogFile, 'a');
					// detached：独立进程组。**实测必需**——本机（Windows + Electron 父进程）里普通 spawn 的
					// 子进程会随父进程退出被一并结束（对照实验：plain 死 / detached 活），
					// 那样 keepAlive 只是"日志打了、Host 照样没了"。unref 让父进程不因它而保持存活。
					child = spawn(node.path, args, { cwd: homedir(), env, stdio: ['ignore', fd.fd, fd.fd], windowsHide: true, detached: true });
					child.unref();
					child.once('exit', () => void fd.close().catch(() => undefined));
				} else {
					child = spawn(node.path, args, { cwd: homedir(), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
				}
				this._child = child;
				this._appendLog(`spawned pid ${child.pid}: node ${args.map(a => a === dsh.bin ? '<dsh>' : a).join(' ')}${hostLogFile ? ` (log → ${hostLogFile})` : ''}`);

				const connection = await this._awaitReady(child, generation, pipe, token, hostLogFile);
				this._throwIfStale(generation);

				this._connection = { origin: connection.origin, authUrl: connection.authUrl };
				// 记下**真正监听到的**端口（取自 `origin`，而不是我们请求的值）供下次启动复用。
				// 只在 ready 之后写：记错了反而会让端口更不稳定（见 dshHostPortManager 纪律 ②）。
				await rememberHostPort(this.effectiveDshHome(options.dshHome), connection.origin);
				child.once('exit', (code, signal) => this._onUnexpectedExit(generation, code, signal));
				if (child.pid !== undefined) {
					await leases.write({
						format: 1, pid: child.pid,
						origin: connection.origin, authUrl: connection.authUrl,
						dshVersion: dsh.version, profile,
						pipe, bridgeToken: token,
						instanceId: this._opts.instanceId, startedAt: Date.now(),
					});
					this._leaseOwnedPid = child.pid;
					// ★ 2026-10-13：给这次 run 留一份**拥有者记录** ✓。为什么必须有 ✗：`host.json` 只留
					//   **最后一份**租约 ⇒ 应用重启后没人知道"runDir 里那些老 run 是谁拉起的、那人还在不在" ✗
					//   ⇒ 下一次 start 无从判定"可以回收哪些" ✗（症状：同一会话被两份 Host 同时写 ⇒ 斜杠命令
					//   目录预热直接 `SessionAlreadyOwnedError` ✗）。判据与回收见 `common/dshHostRunOwnership.ts`
					//   与 `electron-main/dshHostReaper.ts` ✓。
					await this._writeOwnershipRecord({ runId, hostPid: child.pid, profile, files: overlays.map(f => basename(f)) });
				}

				this._setStatus({
					state: 'running',
					bridge: connection.hello ? 'connected' : 'fallback',
					dshVersion: dsh.version,
					nodeVersion: node.version,
					bridgePluginVersion: connection.hello?.pluginVersion,
					origin: connection.origin,
					pid: child.pid,
					profile,
					dshHome,
					startedAt: Date.now(),
					startupMs: Date.now() - t0,
				});
				// 分段拆账（2026-10-15）：首启慢排查要能直接看出慢在"spawn→首行输出"还是"首行→ready"。
			const bootSplit = connection.timing?.spawnToFirstOutputMs !== undefined
				? `（spawn→首行输出=${connection.timing.spawnToFirstOutputMs}ms，首行→ready=${connection.timing.firstOutputToReadyMs}ms）`
				: '';
			this._appendLog(`ready in ${Date.now() - t0} ms at ${connection.origin} (bridge: ${connection.hello ? 'connected' : 'fallback'})${bootSplit}`);
				// ★ 2026-10-20：量「ready → mux 路由可用」这段（不阻塞 start 返回）。
				void this._probeMuxAfterReady(connection.origin, generation);
				// 新起的 Host 读的就是磁盘当前代码 ⇒ 标记使命完成 ✓。
				// ⚠ 只能清在**这里**（真的 spawn 成功之后）：2026-10-12 实测把它清在"进 lock 之前"时，
				// 并发的第二次 start 会把标记读成 false ⇒ 又去接管旧进程 ✗（日志：`reusing the Host started by pid 80344`）。
				this._pluginsStale = false;
				void this._auditPluginGraph('新起 Host');
				return this._status;
			} finally {
				await leases.releaseStartLock();
			}
		} catch (e) {
			const message = String((e as Error)?.message ?? e);
			this._appendLog(`start failed: ${message}`);
			if (generation === this._generation) {
				await this._killChild();
				await this._cleanupRunFiles();
				const errorCode = e instanceof DshRuntimeError ? e.code : 'start-failed';
				this._setStatus({ state: 'error', bridge: 'none', profile, dshHome, error: message, errorCode });
			}
			return this._status;
		}
	}

	private _throwIfStale(generation: number): void {
		if (generation !== this._generation) {
			throw new Error('superseded by a newer start/stop');
		}
	}

	/**
	 * **启动后插件图自检**（2026-10-12 白屏根因的兜底）：问一次 Host 的插件行，任何 `phase === 'failed'`
	 * 都意味着**这个 Host 进程里那批插件永久不可用** —— 现象是聊天页白屏（应用渲染不出来）以及
	 * `session.start` / 新建会话报 `… : never started`，而**页面 chunk 却可能是新的**
	 * （dsh 的 web server 从磁盘现读）⇒ 最误导的一种"半新半坏" ✗✗。
	 *
	 * 实测（host-bc0a7a2c.log）：`dsh: warning: 2 entries did not activate` +
	 * `vssaros-kb: failed to import` + `vssaros-skills: failed to import` —— 磁盘上那两个版本是并发迭代中
	 * 的坏包（换成新版本后 `node` 直接 import 是 OK 的），Host 启动时加载失败并把条目**在本进程内永久**
	 * 标记为不可用 ⇒ 之后怎么刷新页面都没用，只能换进程 ✓。
	 *
	 * 自愈：认出这种状态 ⇒（一次）换一个进程重新 import 磁盘当前代码 ✓。
	 */
	private async _auditPluginGraph(why: string): Promise<void> {
		const bridge = this._bridge;
		if (!bridge) {
			return;
		}
		let rows: readonly IBridgePluginRow[];
		try {
			rows = await bridge.call<readonly IBridgePluginRow[]>(DshBridgeMethod.PluginsList, undefined, 20_000);
		} catch {
			return;   // 自检本身不许变成新的故障源
		}
		const failed = (rows ?? []).filter(r => r.phase === 'failed');
		if (failed.length === 0) {
			this._pluginAuditRestarted = false;
			return;
		}
		const names = failed.map(r => `${r.moduleName ?? r.entryId}(${r.phase})`).join(', ');
		this._appendLog(`插件图不完整（${why}）：${names} — 这些插件在本 Host 进程内不可用（聊天页会白屏 / 会话创建会报 never started）`);
		this._pluginsStale = true;   // 下一次 start 必须换进程（不许再接管这个坏 Host）
		if (this._pluginAuditRestarted) {
			this._appendLog('插件图仍不完整；不再自动重启（请检查这两个插件包本身，或用插件中心逐个启停）');
			return;
		}
		this._pluginAuditRestarted = true;
		this._appendLog('自动换一个 Host 进程重载插件（只做一次；正在跑的会话会中断）');
		// ⚠ 必须**延后**：此刻正处在 `start()` 的 in-flight 里，直接再调 `start()` 只会拿到同一个
		// promise（什么也不会发生 ✗）。交给下一轮事件循环，等本次 start 结算完再 stop → start ✓。
		setTimeout(() => { void this._restartAfterPluginAudit(); }, 0);
	}

	/** 自检发现坏插件图后的重启（见 `_auditPluginGraph`）。 */
	private async _restartAfterPluginAudit(): Promise<void> {
		// `stop()` 会清掉 `_requestedOptions` ⇒ 先取下来 ✓
		const options = this._requestedOptions ?? {};
		try {
			await this._starting?.catch(() => undefined);
			await this.stop();
			await this.start(options);
		} catch (e) {
			this._appendLog(`插件自检后的自动重启失败：${String((e as Error)?.message ?? e)}`);
		}
	}

	/**
	 * 复用另一个实例拉起的 Host（方案 7.5）：不 spawn 子进程，直接采纳租约里的连接信息；
	 * 有控制桥管道时照常连接并 `client.register`（vssaros-bridge 支持多客户端）。
	 */
	private async _adoptLease(lease: IDshHostLease, generation: number, profile: string, dshHome: string | undefined, t0: number): Promise<boolean> {
		// ★ 2026-10-16：**接管前先写下自己那份拥有者记录**（顺序要紧 ✗ —— 两个用途都要求它在
		//   `client.register` 之前就位）：
		//   ① 给回收器一个"这个 Host 有人正在用"的证据：原拥有者 A 优雅分离后它那份记录里 `appPid`
		//      已死 ⇒ 只看那条就会判"可回收"⇒ 插件换版本时新起的 C 会 `taskkill /T` 掉**我们正在用**
		//      的 Host ✗✗（`planOrphanHosts` 靠"同一 hostPid 整组收敛"避免它，前提是有这一条 ✓）。
		//   ② 作为桥插件**看门狗的目标**随握手给下去 ⇒ 换成"当前拥有者"那份 ✓（这正是载体必须是
		//      握手、不能是 spawn 时环境变量的原因：同一个 Host 会被后续窗口反复接管 ✗）。
		//   ⚠ `files: []`：这次没写过任何覆盖层，run 目录与覆盖层都是原拥有者的 ⇒ 绝不能替它清 ✗。
		await this._writeOwnershipRecord({ hostPid: lease.pid, profile, files: [] });
		let hello: IBridgeHello | undefined;
		if (lease.pipe && lease.bridgeToken) {
			try {
				const bridge = await DshBridgeClient.connect(lease.pipe, 10_000, () => generation !== this._generation, this._opts.log);
				hello = await bridge.register({ token: lease.bridgeToken, instanceId: this._opts.instanceId, ownerRecord: this._ownershipFile });
				if (generation !== this._generation) {
					bridge.dispose();
					this._dropOwnershipRecord();
					return false;
				}
				this._bridge = bridge;
				this._registerReverseHandler(bridge);
				this._runDisposables.add(bridge.onDidClose(() => this._onReusedBridgeClosed(bridge, generation)));
			} catch (e) {
				this._appendLog(`reused Host: bridge unavailable, URL-line fallback (${String((e as Error)?.message ?? e).slice(0, 160)})`);
			}
		}
		const origin = hello?.host.origin ?? lease.origin;
		const authUrl = hello?.host.authUrl ?? lease.authUrl;
		this._connection = { origin, authUrl };
		this._reused = true;
		this._setStatus({
			state: 'running',
			bridge: hello ? 'connected' : 'fallback',
			dshVersion: lease.dshVersion,
			bridgePluginVersion: hello?.pluginVersion,
			origin,
			pid: lease.pid,
			profile,
			dshHome,
			startedAt: lease.startedAt,
			startupMs: Date.now() - t0,
			reused: true,
		});
		this._appendLog(`reusing the Host started by pid ${lease.pid} at ${origin} (bridge: ${hello ? 'connected' : 'fallback'})`);
		// 接管别人的 Host 后**先体检插件图**：2026-10-12 白屏就是接管了一个"插件 import 失败"的进程
		// （它内存里那两个条目永久不可用，页面怎么刷新都救不回来）—— 见 `_auditPluginGraph`。
		void this._auditPluginGraph('接管既有 Host');
		// 拥有者记录已在函数**开头**写下（Why 与两条用途见那里的注释 ✓；重复接管时 `_writeOwnershipRecord`
		// 会先删旧记录 —— 否则旧 `hostPid` 上会永久挂着"拥有者还活着"⇒ 那个已死的 Host 再也回收不掉 ✗）。
		return true;
	}

	/**
	 * 写下本次 run 的拥有者记录（spawn 与接管两条路共用；`files` = 本次写过的覆盖层文件名 ✓）。
	 *
	 * @param init.runId - 覆盖层/管道那套**同一个** runId（spawn 路必须传 ✓：回收器是按
	 *   `record.runId` 与覆盖层文件名里的 runId 对账的，两条路用不同 id 会让"活着的 Host 的覆盖层"
	 *   被当成无主文件清掉）；接管路没有自己的覆盖层 ⇒ 省略、另取一个 ✓。
	 */
	private async _writeOwnershipRecord(init: { runId?: string; hostPid: number; profile: string; files: readonly string[] }): Promise<void> {
		const previous = this._ownershipFile;
		if (previous) {
			try {
				rmSync(previous, { force: true });
			} catch { /* best effort */ }
		}
		const runId = init.runId ?? randomBytes(6).toString('hex');
		const file = join(this._opts.runDir, hostRunOwnershipFileName(runId));
		this._ownershipFile = file;
		await fsp.writeFile(file, JSON.stringify({
			format: 1, runId, appPid: process.pid, hostPid: init.hostPid,
			instanceId: this._opts.instanceId, profile: init.profile,
			startedAt: Date.now(),
			files: [...init.files],
		}), { mode: 0o600 }).catch(() => undefined);
		// 写盘之后立刻开始心跳（见 `_startOwnershipHeartbeat`）。⚠ 顺序：**先有记录再有心跳** ✓ ——
		// 记录刚写下的 mtime 本来就是新的 ⇒ 即使插件在这一瞬间巡检也不会误判 ✓。
		this._startOwnershipHeartbeat();
	}

	/**
	 * 拥有者记录的**心跳**：定期碰一次它的 mtime（**只碰 mtime、不改内容** ✓）。
	 *
	 * 为什么必须有 ✗（这是桥插件"孤儿自退"的判据来源）：宿主进程崩掉时**没有**任何退出路径会跑，
	 * 而常驻 Host 会一直活着并攥着会话写租约（= `session.lock` 的 OS 文件锁，只有关句柄/退进程才
	 * 释放 ✗）⇒ 与官方 DSH 桌面端共用 `~/.dsh` 时表现为"这个会话已被占用"。
	 * 判"宿主还在不在"**不能只看 pid**：pid 会被复用 ⇒ 必须有一个"**一直在动**"的证据，就是这里 ✓。
	 */
	private _startOwnershipHeartbeat(): void {
		this._stopOwnershipHeartbeat();
		const file = this._ownershipFile;
		if (!file) {
			return;
		}
		this._ownershipHeartbeat = setInterval(() => {
			void fsp.utimes(file, new Date(), new Date()).catch(() => undefined);
		}, HOST_RUN_OWNERSHIP_HEARTBEAT_MS);
		// ⚠ 与同文件其它 5 处同口径：`TimeoutHandle` 类型上没有 `unref`（Node/DOM 类型冲突），
		//   但运行时确实存在 ⇒ 用结构化断言调用，不改成 `as any`（保持可见性）。
		(this._ownershipHeartbeat as { unref?: () => void } | undefined)?.unref?.();
	}

	private _stopOwnershipHeartbeat(): void {
		if (this._ownershipHeartbeat) {
			clearInterval(this._ownershipHeartbeat);
			this._ownershipHeartbeat = undefined;
		}
	}

	/**
	 * 丢弃本次的拥有者记录（**接管失败时回滚** ✓）：删文件 + 停心跳。
	 *
	 * 为什么必须有 ✗：接管路是"**先写记录再握手**"（顺序原因见 `_adoptLease`）⇒ 握手失败或代际过期时
	 * 不回滚，就会留下一份"我们拥有一个其实没接上的 Host"的记录 ⇒ 那个 Host 在我们活着的期间
	 * **永远不会被回收** ✗。
	 */
	private _dropOwnershipRecord(): void {
		this._stopOwnershipHeartbeat();
		const file = this._ownershipFile;
		this._ownershipFile = undefined;
		if (!file) {
			return;
		}
		try {
			rmSync(file, { force: true });
		} catch { /* best effort */ }
	}

	/**
	 * **优雅分离**：把记录 mtime 推到空闲 TTL 之后，向桥插件表达"这次分离是优雅的、没人要求它自退" ✓。
	 *
	 * 为什么用 mtime 而不是读-改-写一个 `detachedAt` 字段 ✗：本方法跑在 `dispose()` 的**同步**路径上，
	 * 而本仓有"同步文件写被内核挂住 ⇒ 主进程零 CPU 假死"的事故史（同一指纹 4 次）⇒ 这里只做**一次
	 * `utimes` 系统调用**，不读文件、不做 JSON 往返、不引入窗口 ✓。
	 * ⚠ 其它读取者都不看 mtime：回收器只看 `startedAt`/`appPid` ✓；判"陈旧"的只有桥插件看门狗 ✓。
	 * ⚠ 后续窗口**接管**这个 Host 时会经 `client.register` 换成**它自己那份**记录 ⇒ 不受这里的未来
	 *   mtime 影响 ✓（这正是"载体必须是握手"的原因）。
	 */
	private _markOwnershipDetachedSync(): void {
		this._stopOwnershipHeartbeat();
		const file = this._ownershipFile;
		if (!file) {
			return;
		}
		try {
			const until = new Date(Date.now() + DSH_HOST_IDLE_TTL_MS);
			utimesSync(file, until, until);
		} catch { /* best effort：写不成最多是"常驻 Host 提前自退"，不该影响退出 ✓ */ }
	}

	/** 复用中的桥断开：拥有者可能刚重启/升级了 Host（租约会换新）→ 轮询等新租约并重挂；超时视为 Host 已停。 */
	private _onReusedBridgeClosed(bridge: DshBridgeClient, generation: number): void {
		if (this._bridge !== bridge || this._status.state !== 'running' || !this._reused) {
			return;
		}
		this._bridge = undefined;
		this._appendLog('bridge closed; watching the lease in case the owner restarts the Host');
		void (async () => {
			const store = this._leaseStore;
			const deadline = Date.now() + READOPT_WAIT_MS;
			while (store && generation === this._generation && this._status.state === 'running') {
				const lease = store.read();
				const current = this._connection;
				if (lease && current && (lease.origin !== current.origin || lease.pid !== this._status.pid) && !(await store.probe(lease))) {
					this._appendLog(`the owner restarted the Host at ${lease.origin}; re-adopting`);
					await this._adoptLease(lease, generation, this._status.profile ?? DSH_DEFAULT_PROFILE, this._status.dshHome, Date.now());
					return;
				}
				if (Date.now() > deadline) {
					break;
				}
				await new Promise(r => setTimeout(r, 1_000));
			}
			if (!store || generation !== this._generation || this._status.state !== 'running') {
				return;
			}
			const lease = store.read();
			if (lease && this._connection && lease.origin === this._connection.origin && !(await store.probe(lease))) {
				// Host 还活着，只是桥没了（插件崩溃等）：视图仍可用，IDE 联动降级。
				this._setStatus({ ...this._status, bridge: 'fallback' });
				return;
			}
			this._appendLog('the reused Host is gone');
			this._runDisposables.clear();
			this._connection = undefined;
			this._reused = false;
			this._requestedOptions = undefined;
			this._setStatus({ state: 'stopped', bridge: 'none', profile: this._status.profile, dshHome: this._status.dshHome });
		})();
	}

	private async _ensureProfile(node: IResolvedNode, dsh: IResolvedDsh, profile: string, env: NodeJS.ProcessEnv): Promise<void> {
		if (existsSync(this._profileManifest(profile, env))) {
			return;
		}
		// 构建期预置的 profile 种子（build/prepack-dsh-runtime.mjs，copy 导入模式→真文件可搬运）：
		// 有种子就整目录本地复制——首启零下载、零 pnpm；种子缺失/损坏才退回模板初始化。
		const seedDir = this._profileSeedDir(profile, dsh);
		if (seedDir) {
			this._progress('正在从内置副本初始化 profile（本地拷贝，无需下载）…');
			const t0 = Date.now();
			try {
				await fsp.cp(seedDir, this._profileDir(profile, env), { recursive: true });
				if (existsSync(this._profileManifest(profile, env))) {
					this._appendLog(`profile seeded from bundled copy in ${Date.now() - t0} ms (${seedDir})`);
					return;
				}
				this._appendLog('profile seed copy incomplete; falling back to template init');
			} catch (e) {
				this._appendLog(`profile seed copy failed (${String((e as Error)?.message ?? e)}); falling back to template init`);
			}
		}
		this._progress('正在初始化专属 profile（web 模板）…');
		this._appendLog(`creating profile "${profile}" from the web template`);
		const r = await this._runDsh(node, buildProfileInitArgs(dsh.bin, profile), env, 60_000);
		if (!existsSync(this._profileManifest(profile, env))) {
			throw new Error(`profile 初始化失败：${r.trim().slice(-600)}`);
		}
	}

	/**
	 * 校正 profile 里 pnpm 的虚拟店元数据。
	 *
	 * 种子是构建期在**仓库目录**里 install 出来的，`node_modules/.modules.yaml` 记的是那个目录的
	 * `virtualStoreDir`（`<repo>/dsh-runtime/<ver>/profile-seed/profiles/<p>/node_modules/.pnpm`）。
	 * `_ensureProfile` 是整目录拷贝到 profile，元数据不会跟着改 → pnpm 认为虚拟店位置不符，
	 * 之后每次 `dsh plugin add` 都 `ERR_PNPM_UNEXPECTED_STORE`（实测把 bridge / chat-surface
	 * 全部卡在旧版本，dev 实例可见 `providersSync: 负载未通过校验` 这类版本错配症状）。
	 *
	 * 只改路径字段、不动 store 内容 —— 仍然零下载。已存在且正确的 profile 是 no-op。
	 */
	private async _repairSeededStoreMetadata(profileDir: string): Promise<void> {
		const file = join(profileDir, 'node_modules', '.modules.yaml');
		if (!existsSync(file)) {
			return;
		}
		try {
			const before = await fsp.readFile(file, 'utf8');
			// ★ 先归一写法再算期望值：`profileDir` 可能是 8.3 短名（TEMP/userData 常见），而 pnpm 内部按
			// **长名**算虚拟店位置 ⇒ 写成短名会被判成"位置不符"（ERR_PNPM_UNEXPECTED_VIRTUAL_STORE）。
			// 这也是本函数修的那类错（4.78 修的是"指错目录"，这一条修的是"同一目录两种写法"）。
			// 触发链见 `dshStoreMetadata.ts` 顶部注释：伴生包装不上 ⇒ 必装插件缺服务 ⇒ Host code 1。
			const expectedDir = normalizeExistingPath(profileDir);
			const expectedVirtual = join(expectedDir, 'node_modules', '.pnpm');
			// storeDir 也要改：pnpm 的默认 store 按**项目所在盘符**算 `<盘>:\.pnpm-store\v<N>`，
			// 而种子是在构建机的仓库盘（实测 G:）上 install 的 ⇒ profile 在别的盘（userData 在 C:）时
			// pnpm 解析出 C:\…，与元数据里的 G:\… 不符，**只修 virtualStoreDir 仍会**报同一个错（实测）。
			// 版本号沿用记录值（种子与运行时同一个 pnpm）；盘符取 profile 自身。
			const recordedStore = /^storeDir:[ \t]*(.+)$/m.exec(before)?.[1]?.trim();
			const storeVersion = recordedStore ? /[\\/]v(\d+)$/.exec(recordedStore)?.[1] : undefined;
			const expectedStore = storeVersion ? resolveExpectedStoreDir(expectedDir, storeVersion) : undefined;
			const repair = repairStoreMetadataContent(before, expectedVirtual, expectedStore);
			if (!repair.changed) {
				return;
			}
			await fsp.writeFile(file, repair.content, 'utf8');
			this._appendLog(`profile store metadata repaired: storeDir=${repair.storeDir ?? recordedStore ?? '(none)'}, virtualStoreDir=${repair.virtualStoreDir}`);
		} catch (e) {
			this._appendLog(`profile store metadata repair failed (${String((e as Error)?.message ?? e)}); plugin installs may hit ERR_PNPM_UNEXPECTED_STORE`);
		}
	}

	/**
	 * 把"必须与运行时**同一模块实例**"的 dsh 包（`DSH_SHARED_INSTANCE_PACKAGES`）在 profile 侧收敛成
	 * 指向运行时那份的**目录联接**（junction；Windows 上免管理员权限）。
	 *
	 * 为什么要紧（README 4.58 的实测根因，两个实例的 URL 都打出来了）：`dsh-app-boot` 把 "root Include
	 * entry" 存在**模块私有的 WeakMap** 里（以 root context 为 key），而 `dsh-hmr` / `dsh-plugin-manager`
	 * 靠它的 `reconcileProfilePatches()` 做**实时重组**。pnpm 装插件时会把 `dsh-app-boot` 当传递依赖装进
	 * profile `node_modules` ⇒ **Host 启动用运行时那份**（注册进 A 的 WeakMap），**插件解析到 profile 那份**
	 * （B 的 WeakMap 是空的）⇒ 每次实时重组都抛 `dsh: profile reload requires the root Include entry`
	 * ⇒ 插件启停永远要退回"写文件 + 重启"。
	 *
	 * 为什么联接能解决：Node 默认按 **realpath** 缓存模块（不保留符号链接）⇒ 两条路径解析成同一个 URL
	 * ⇒ **同一个模块实例** ⇒ WeakMap 不再分身。
	 *
	 * 保守边界：只在两边**版本一致**时替换；先接通临时联接、再删原目录、最后改名就位（避免"删了但没接上"
	 * 把 profile 弄成缺包）；任何失败都只记日志，**绝不阻断启动**（退回文件级仍然是可用的）。
	 */
	private async _dedupeSharedPackages(dsh: IResolvedDsh, profile: string, env: NodeJS.ProcessEnv): Promise<void> {
		const nodeModules = join(this._profileDir(profile, env), 'node_modules');
		for (const pkg of DSH_SHARED_INSTANCE_PACKAGES) {
			const runtimeCopy = resolveSiblingPackage(dsh.bin, pkg);
			if (!runtimeCopy || !existsSync(runtimeCopy)) {
				continue;
			}
			const [scope, name] = pkg.split('/');
			const profileCopy = join(nodeModules, scope, name);
			let stats;
			try {
				stats = await fsp.lstat(profileCopy);
			} catch {
				continue;   // profile 里没有副本 ⇒ 本来就同一实例
			}
			if (stats.isSymbolicLink()) {
				continue;   // 已经是联接（我们上次做的）
			}
			const want = this._readPkgVersion(join(runtimeCopy, 'package.json'));
			const have = this._readPkgVersion(join(profileCopy, 'package.json'));
			if (!want || want !== have) {
				this._appendLog(`${pkg}: profile 自带版本(${have ?? '?'})与运行时(${want ?? '?'})不一致 ⇒ 不收敛，实时启停将退回文件级`);
				continue;
			}
			const temp = `${profileCopy}.vssaros-dedupe`;
			try {
				await fsp.rm(temp, { recursive: true, force: true });
				await fsp.symlink(runtimeCopy, temp, 'junction');   // 先接通（此时原目录还在）
				await fsp.rm(profileCopy, { recursive: true, force: true });
				await fsp.rename(temp, profileCopy);                // 再就位
				this._appendLog(`${pkg}: profile 侧副本已收敛为指向运行时的联接 ⇒ 实时启停可用`);
			} catch (e) {
				await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);
				this._appendLog(`${pkg}: 收敛失败（不影响启动，实时启停会退回文件级）：${String((e as Error)?.message ?? e)}`);
			}
		}
	}

	/** 内置 profile 种子目录：`<bundledRoot>/<version>/profile-seed/profiles/<profile>`；不存在返回 undefined。 */
	private _profileSeedDir(profile: string, dsh: IResolvedDsh): string | undefined {
		const bundledRoot = this._opts.runtime.bundledRoot;
		if (!bundledRoot || dsh.source !== 'bundled') {
			return undefined; // 种子只对内置运行时负责——其他来源的版本可能和种子不配套
		}
		const dir = join(bundledRoot, dsh.version, 'profile-seed', 'profiles', profile);
		return existsSync(join(dir, 'package.json')) ? dir : undefined;
	}

	/**
	 * 判定某个伴生插件**是否需要安装**（与 `_ensurePlugin` 的前半段逐条对齐：缺包判据、版本一致
	 * 即跳过、`skipPluginInstall` 只跳升级而**不跳过缺失**）。
	 *
	 * 为什么抽出来（2026-10-13 首启提速）：串行 `_ensurePlugin` = 每个变更插件一个 pnpm 进程
	 * （实测 2–5 s）⇒ 首启 6 个变更就 17 s 全耗在装插件上 ✗。拆成"先判定全部、再**一次**装"，
	 * 判定这一步只读 package.json（零进程、零 I/O 之外的开销）✓。判定与安装的**口径必须一致**，
	 * 否则会出现"判定说不用装、复核说没到位"的假故障 ⇒ 两边共用这里的条件。
	 */
	private _planPluginInstall(name: string, dir: string | undefined, label: string, profile: string, env: NodeJS.ProcessEnv, skipUpgrade: boolean): { name: string; dir: string; label: string; bundled: string; installed?: string; fingerprint?: string } | undefined {
		const installed = this._readPkgVersion(join(this._profileDir(profile, env), 'node_modules', ...name.split('/'), 'package.json'));
		const bundled = dir ? this._readPkgVersion(join(dir, 'package.json')) : undefined;
		if (!bundled) {
			if (!installed) {
				this._appendLog(`${label} not bundled; skipped (${name})`);
			}
			return undefined;
		}
		// ★ 随包源码缺入口（`main` 指的文件不存在）= 半成品插件（开发中）：装它没有意义（Host 一样
		//   `failed to import`），而"读不到入口 ⇒ 判不一致"会让它**每次启动都被强制重装**（单次 ~4-12s），
		//   并把 `_pluginsStale` 钉死在 true ⇒ **常驻 Host 复用被永久关闭** ⇒ 每次都付全量冷启动
		//   （2026-10-15 现场：`dsh-web-content-import` 缺 `lib/index.js`，单次启动白装 3 次 + 永冷启）。
		//   跳过并保持已装副本原样（last-good 优于 broken-source）；修好源码后判定自然恢复 ✓。
		if (this._readEntryFile(dir!) === undefined) {
			this._appendLog(`⚠ ${label} 随包源码缺入口文件（package.json 的 main 指向的文件不存在）⇒ 跳过安装（修好源码后自动恢复）— ${name}`);
			return undefined;
		}
		if (installed === bundled) {
			// ★ 2026-10-13：版本相同**不足以说明已装副本是好的** —— 必须比对入口文件内容，见
			// `_installedEntryMatches` 的注释（本仓实测：源码被修好但没 bump 版本 ⇒ 安装判据放过了一份
			// **语法坏**的旧副本 ⇒ 该模块 never started ⇒ 会话 resume 报错，用户端每次启动都复现 ✗✗）。
			// ⚠ 这一条**不受 `skipPluginInstall` 约束**：那个开关只省"等 pnpm 升级"的代价，不该放过坏副本 ✓。
			const installedDir = join(this._profileDir(profile, env), 'node_modules', ...name.split('/'));
			if (this._installedEntryMatches(dir!, installedDir)) {
				return undefined;
			}
			this._appendLog(`${label} 已装副本与随包不一致（版本同为 ${installed}，入口内容不同）⇒ 强制重装 — ${name}`);
			return { name, dir: dir!, label, bundled, installed, fingerprint: this._entryFingerprint(dir!) };
		}
		if (skipUpgrade && installed) {
			this._appendLog(`${label} upgrade skipped (skipPluginInstall): keeping ${installed}, bundled is ${bundled} — ${name}`);
			return undefined;
		}
		// ★★ 2026-10-28（真机：打包版 exe 启动卡在"正在启动 VsSaros…"六分钟）：
		//   **已装比随包新 ⇒ 不降级**。现场：那个 exe 随包 chat-surface@0.2.243，而 profile 里已是
		//   0.2.259（dev 侧升上来的）⇒ 原来只判"不相等"就安排安装 ⇒ 每次启动降级重装 8 个包
		//   （一条 `dsh plugin add` 装 8 个，跑满 4 分钟超时 + 逐项回退再失败）⇒ 用户面对长时间卡死 ✗。
		//   "exe 比 profile 旧"是**正常状态**（先跑新 dev、再跑旧安装包）⇒ 保留已装的新版本 ✓。
		if (installed && isVersionNewer(installed, bundled)) {
			this._appendLog(`${label} 已装 ${installed} 比随包 ${bundled} 新 ⇒ 不降级，保留已装版本 — ${name}`);
			return undefined;
		}
		// ★ 指纹随计划一起带走（2026-10-14）：暂存目录名要用它 ⇒ 同一版本下**内容变了**也会换 spec 路径。
		// 不带上就会退回"同路径 file: 依赖 = pnpm 视为无变化"那个静默坑（见 `_stagePlugin` 的长注释）。
		return { name, dir: dir!, label, bundled, installed, fingerprint: this._entryFingerprint(dir!) };
	}

	/**
	 * 逐条比对「profile 已装版本」与「随包版本」，不一致就**点名**记进日志（★ 2026-10-21）。
	 *
	 * 为什么要有（现场：2026-10-21 15:41 用户"新建会话报错"）：
	 *   profile 里 @vssaros/dsh-memory 停在 0.3.81，而携带**预设**的 @vssaros/dsh-agents 已是新一代
	 *   ⇒ 预设里 memory 那一行挂不起来 ⇒ dsh 报 `agent-preset/invalid: … never started`
	 *   ⇒ **新建会话被直接拒掉**；而当时的启动日志里只有**别的**插件的 installing 行
	 *   ⇒ 排查时完全看不出"profile 里的插件与随包不同代"这层原因 ✗✗。
	 *
	 * 判定与文案都在**纯函数**里（`common/dshPluginVersionAudit.ts`）⇒ 这里只做 I/O（读版本）+ 写日志 ✓
	 *   （口径有单测守着：`test/common/dshPluginVersionAudit.test.ts` ✓）。
	 */
	private _auditBundledVersions(plugins: readonly (readonly [string, string | undefined, string])[], pluginProfileDir: string): void {
		const entries = plugins.map(([name, dir, label]) => ({
			name,
			label,
			installed: this._readPkgVersion(join(pluginProfileDir, 'node_modules', ...name.split('/'), 'package.json')),
			bundled: dir ? this._readPkgVersion(join(dir, 'package.json')) : undefined,
		}));
		const text = renderBundledVersionAudit(auditBundledPluginVersions(entries));
		if (text) {
			this._appendLog(text);
		}
	}

	/** 把一个随产品分发的插件装进 profile（版本相同则跳过）；装不上时返回已装版本并记日志。 */
	private async _ensurePlugin(name: string, dir: string | undefined, node: IResolvedNode, dsh: IResolvedDsh, profile: string, env: NodeJS.ProcessEnv, label: string, skipUpgrade = false): Promise<string | undefined> {
		const installed = this._readPkgVersion(join(this._profileDir(profile, env), 'node_modules', ...name.split('/'), 'package.json'));
		const bundled = dir ? this._readPkgVersion(join(dir, 'package.json')) : undefined;
		if (!bundled) {
			if (!installed) {
				this._appendLog(`${label} not bundled; skipped (${name})`);
			}
			return installed;
		}
		// 与 `_planPluginInstall` 同一条（缺入口 = 半成品插件）：跳过且不置 `_pluginsStale` ——
		// 否则一个"写了一半的插件"会把常驻 Host 复用永久关掉（2026-10-15 现场，见那边的注释）。
		if (this._readEntryFile(dir!) === undefined) {
			this._appendLog(`⚠ ${label} 随包源码缺入口文件（package.json 的 main 指向的文件不存在）⇒ 跳过安装（修好源码后自动恢复）— ${name}`);
			return installed;
		}
		if (installed === bundled) {
			// 同上：版本相同但**入口内容不同**（坏副本 / 被手改）⇒ 落到下面的安装路径修一次 ✓
			if (this._installedEntryMatches(dir!, join(this._profileDir(profile, env), 'node_modules', ...name.split('/')))) {
				return installed;
			}
			this._appendLog(`${label} 已装副本与随包不一致（版本同为 ${installed}）⇒ 重装 — ${name}`);
		}
		// 迭代期开关（`sessions.dshHarness.skipPluginInstall`）：跳过**升级**，但**不跳过缺失**——
		// 缺包会让 Host 起不来（web-app bundle 缺 ⇒ bridge 永远 pending ⇒ 60 s 后 Host 退出 code 1，
		// 见上面 plugins 清单里的注释）。这里只省掉"仓库 bump 了版本 ⇒ 本次启动先等 pnpm"的代价。
		if (skipUpgrade && installed) {
			this._appendLog(`${label} upgrade skipped (skipPluginInstall): keeping ${installed}, bundled is ${bundled} — ${name}`);
			return installed;
		}
		this._appendLog(`installing ${name}@${bundled} (was ${installed ?? 'absent'})`);
		// ★ **只要真的执行了安装动作**（升级既有 / 补装缺失），任何"此刻已经在跑"的 Host 里就可能有问题：
		//   · 升级 ⇒ 它内存里是**旧代码**，而页面 chunk 由它从磁盘现读（"前端新、后端旧" ✗）；
		//   · 补装缺失 ⇒ 它启动时那个包还不存在 ⇒ 该 entry `failed to import`、并**在本进程内永久**不可用 ✗✗
		//     （2026-10-12 白屏现场：`vssaros-kb / vssaros-skills: failed to import`）。
		//   ⇒ 置标记：下一次 `start()` **不接管**旧进程，另起一个读磁盘当前代码的 Host ✓（见 `_pluginsStale`）。
		//   `installed === bundled` 的 no-op 在上面就 return 了 ⇒ 不会因为"检查了一下"而误置 ✓。
		//
		// ⚠ 2026-10-13 实测修正（这条差点让整个修复白做）：我最初把标记写在 `_installFromDir` 那条路上
		//   （它的日志文案是 `${label} install: …`），而**启动时的伴生插件安装走的是本函数**
		//   （日志文案 `installing … (was …)` —— 与运行日志逐字一致 ✓）⇒ 标记**从没被设上**，
		//   `reusing the Host started by pid 95100` 照旧发生 ✗✗（该实例里连一条"已运行的 Host 内存里是旧代码"
		//   都没有 ⇒ 一眼可辨）。教训：这类标记必须挂在**真正的 choke point**（实际执行安装的那一行）上，
		//   而不是"看起来像安装"的那个函数 ✓。
		this._pluginsStale = true;
		const staged = await this._stagePlugin(name, dir!, bundled, this._profileDir(profile, env), this._entryFingerprint(dir!));
		const out = await this._runDsh(node, buildPluginAddArgs(dsh.bin, profile, toFileSpec(staged)), env, 120_000);
		const after = this._readPkgVersion(join(this._profileDir(profile, env), 'node_modules', ...name.split('/'), 'package.json'));
		if (after !== bundled) {
			// 400 曾把真正的错误行截掉只剩栈尾（语音 bundle 排查实测）——保留头+尾。
			const clean = redactSecrets(out.trim());
			const kept = clean.length <= 1600 ? clean : `${clean.slice(0, 800)}\n…（中间省略）…\n${clean.slice(-800)}`;
			this._appendLog(`${label} install failed; continuing without it: ${kept}`);
			return installed;
		}
		return after;
	}

	/**
	 * Host ready 之后每 200 ms 探一次 mux 路由，第一次可用就记一行日志并发 `onMuxReady`。
	 * 最多探 60 s；期间 Host 换代 / 停止就放弃。只加日志 + 一个事件，不改启动流程。
	 *
	 * 日志口径：`mux route available +N ms after Host ready`。N≈0 说明 ready 那一刻路由就已经在了，
	 * 也就是说页面的重连阶梯**不是**"路由未注册"导致的，要换方向查。
	 */
	private async _probeMuxAfterReady(origin: string, generation: number): Promise<void> {
		const t0 = Date.now();
		for (let i = 1; Date.now() - t0 < 60_000; i++) {
			if (generation !== this._generation || this._status.state !== 'running') {
				return;
			}
			const status = await probeMuxRouteOnce(origin, 1500);
			if (status !== undefined) {
				const after = Date.now() - t0;
				this._appendLog(`mux route available +${after} ms after Host ready（probe #${i}，HTTP ${status}）${i === 1 ? ' —— ready 时已可用：页面重连阶梯不是路由未注册导致' : ''}`);
				this._onMuxReady.fire({ afterReadyMs: after, probes: i, status });
				return;
			}
			await new Promise(r => setTimeout(r, 200));
		}
		this._appendLog('mux route still unavailable 60 s after Host ready（页面实时事件只能靠退避重试）');
	}

	private _awaitReady(child: ChildProcess, generation: number, pipe: string | undefined, token: string | undefined, hostLogFile?: string): Promise<IDshHostConnection & { hello?: IBridgeHello; timing?: IDshHostBootTiming }> {
		return new Promise((resolve, reject) => {
			// ★ 启动分段计时（2026-10-15 "首启慢"排查）：`ready in X ms` 是总账，看不出慢在
			//   "spawn 到 Host 第一行输出"（node 引导 + dsh 核心 + cordis 装配，冷机器上实测 5.7s）
			//   还是"首行到 ready"（其余插件 apply + web server 起来）。两段分开记 ✓。
			//   ⚠ keepAlive 模式下首行经 400ms 文件轮询读到 ⇒ 有 ≤400ms 量化误差，看趋势别看绝对值。
			const tSpawn = Date.now();
			let firstOutputAt = 0;
			let output = '';
			let urlFromLog: IDshHostConnection | undefined;
			let settled = false;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			let filePoll: ReturnType<typeof setInterval> | undefined;
			const finish = (fn: () => void) => {
				if (!settled) {
					settled = true;
					deadline.dispose();
					this._startupDeadline = undefined;
					clearTimeout(graceTimer);
					if (filePoll) {
						clearInterval(filePoll);
					}
					fn();
				}
			};
			this._lastBridgeError = undefined;
			const deadline: IStartupDeadline = createStartupDeadline({
				quietMs: STARTUP_TIMEOUT_MS,
				maxMs: STARTUP_MAX_MS,
				onExpire: (reason, detail) => finish(() => reject(new Error(startupExpiryMessage({
					reason,
					quietMs: STARTUP_TIMEOUT_MS,
					maxMs: STARTUP_MAX_MS,
					lastLine: redactSecrets(this._log[this._log.length - 1] ?? '(无输出)'),
					// 桥连接失败过 ⇒ 把它一并报出来（文案与口径都在 `startupExpiryMessage` 里，有单测）。
					...(this._lastBridgeError ? { bridgeError: redactSecrets(this._lastBridgeError) } : {}),
					// 有插件没装上 ⇒ 同样报出来（这是"启动失败"最常见的真因之一）。
					...(this._startupPluginProblems.length ? { pluginProblems: this._startupPluginProblems.map(redactSecrets) } : {}),
				})))),
			});
			this._startupDeadline = deadline;

			const withTiming = <T extends object>(v: T): T & { timing: IDshHostBootTiming } => ({
				...v,
				timing: firstOutputAt ? { spawnToFirstOutputMs: firstOutputAt - tSpawn, firstOutputToReadyMs: Date.now() - firstOutputAt } : {},
			});
			const onData = (chunk: Buffer) => {
				const text = chunk.toString();
				for (const line of text.split(/\r?\n/)) {
					if (line.trim()) {
						if (!firstOutputAt) {
							firstOutputAt = Date.now();
						}
						const safe = redactSecrets(line);
						this._appendLog(safe);
						// ★★ 2026-10-19（用户要求：dsh 的日志也要写到 IDE 侧，方便一处定位）：
						//   Host 的输出此前**只**落在 `<runDir>/host-<id>.log`（keepAlive 模式下 stdout 直连文件，
						//   根本不走管道）⇒ 排查时要在 IDE 日志和 dsh-run 之间两头翻 ✗。
						//   这里把**同一行**（已脱敏）镜像进 IDE 日志，带 `[dsh-host]` 前缀便于过滤 ✓。
						//   ⚠ 两种模式都经过 `onData`（keepAlive 是每 400ms 轮询文件增量、否则是 pipe）⇒ 只改这一处即全覆盖 ✓。
						//   ⚠ 必须复用脱敏后的文本：Host 的启动日志里可能带一次性 token（`parseAuthUrl` 就是在找它）。
						this._opts.log(`[dsh-host] ${safe}`);
					}
				}
				if (urlFromLog) {
					return;
				}
				output = (output + text).slice(-64 * 1024);
				const parsed = parseAuthUrl(output);
				if (parsed) {
					urlFromLog = parsed;
					if (!pipe) {
						finish(() => resolve(withTiming(parsed)));
					} else {
						graceTimer = setTimeout(() => finish(() => {
							this._appendLog('bridge handshake did not complete; using URL-line fallback');
							resolve(withTiming(parsed));
						}), BRIDGE_GRACE_MS);
					}
				}
			};
			if (hostLogFile) {
				// keepAlive 模式：宿主输出在日志文件里（管道会随 IDE 退出破裂、EPIPE 杀 Host——实测）。
				// 轮询增量读文件，走与管道同一套解析。
				let offset = 0;
				filePoll = setInterval(() => {
					void (async () => {
						try {
							const stat = await fsp.stat(hostLogFile);
							if (stat.size > offset) {
								const fh = await fsp.open(hostLogFile, 'r');
								try {
									const len = Math.min(stat.size - offset, 256 * 1024);
									const buf = Buffer.alloc(len);
									await fh.read(buf, 0, len, offset);
									offset += len;
									onData(buf);
								} finally {
									await fh.close();
								}
							}
						} catch { /* 文件暂不可读，下一轮再来 */ }
					})();
				}, 400);
			} else {
				child.stdout?.on('data', onData);
				child.stderr?.on('data', onData);
			}
			child.once('exit', code => finish(() => reject(new Error(`Host 启动期间退出（code ${code}）：${redactSecrets(this._log.slice(-8).join(' | '))}`))));
			child.once('error', err => finish(() => reject(err)));

			if (pipe && token) {
				DshBridgeClient.connect(pipe, STARTUP_TIMEOUT_MS, () => settled || generation !== this._generation, this._opts.log).then(async bridge => {
					try {
						const hello = await bridge.register({ token, instanceId: this._opts.instanceId, ownerRecord: this._ownershipFile });
						if (settled) {
							bridge.dispose();
							return;
						}
						this._bridge = bridge;
						this._registerReverseHandler(bridge);
						this._runDisposables.add(bridge.onDidClose(() => {
							if (this._bridge === bridge && this._status.state === 'running') {
								this._appendLog('bridge closed');
								this._setStatus({ ...this._status, bridge: 'fallback' });
							}
						}));
						finish(() => resolve(withTiming({ origin: hello.host.origin, authUrl: hello.host.authUrl, hello })));
					} catch (e) {
						bridge.dispose();
						this._appendLog(`bridge register failed: ${String((e as Error)?.message ?? e)}`);
					}
				}, e => {
					if (!settled) {
						this._lastBridgeError = String((e as Error)?.message ?? e);
						this._appendLog(`bridge connect failed: ${this._lastBridgeError}`);
					}
				});
			}
		});
	}

	private _onUnexpectedExit(generation: number, code: number | null, signal: NodeJS.Signals | null): void {
		if (generation !== this._generation || this._status.state !== 'running') {
			return;
		}
		this._appendLog(`Host exited unexpectedly (code ${code}, signal ${signal})`);
		const ownedPid = this._leaseOwnedPid;
		this._leaseOwnedPid = undefined;
		if (ownedPid !== undefined) {
			void this._leaseStore?.removeIfOurs(ownedPid);
		}
		this._runDisposables.clear();
		this._bridge?.dispose();
		this._bridge = undefined;
		this._child = undefined;
		this._connection = undefined;
		void this._cleanupRunFiles();
		this._setStatus({ state: 'error', bridge: 'none', profile: this._status.profile, dshHome: this._status.dshHome, error: `Host 意外退出（code ${code}）` });
	}

	// ─── 停止 ────────────────────────────────────────────────────────────────

	private async _doStop(): Promise<void> {
		this._generation++;
		await this._starting?.catch(() => undefined);
		if (this._status.state === 'stopped') {
			return;
		}
		this._setStatus({ ...this._status, state: 'stopping' });
		this._runDisposables.clear();
		this._bridge?.dispose();
		this._bridge = undefined;
		this._connection = undefined;
		await this._killChild();
		// 只有拥有者才撤租约；复用者停下不影响别人的 Host。
		const ownedPid = this._leaseOwnedPid;
		this._leaseOwnedPid = undefined;
		this._reused = false;
		this._requestedOptions = undefined;
		if (ownedPid !== undefined) {
			await this._leaseStore?.removeIfOurs(ownedPid);
		}
		await this._cleanupRunFiles();
		this._appendLog('stopped');
		this._setStatus({ state: 'stopped', bridge: 'none', profile: this._status.profile, dshHome: this._status.dshHome });
	}

	/** Windows 上 TerminateProcess 不会带走 Host 的子进程（终端、MCP 服务），因此按进程树结束。 */
	private _killChild(): Promise<void> {
		const child = this._child;
		this._child = undefined;
		if (!child || child.exitCode !== null || child.pid === undefined) {
			return Promise.resolve();
		}
		return new Promise(resolve => {
			const done = () => {
				clearTimeout(hard);
				resolve();
			};
			child.once('exit', done);
			const hard = setTimeout(() => {
				if (child.exitCode === null) {
					try {
						child.kill('SIGKILL');
					} catch { /* already gone */ }
				}
				resolve();
			}, 5_000);
			if (isWindows) {
				execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { /* exit event resolves */ });
			} else {
				child.kill('SIGTERM');
			}
		});
	}

	private async _cleanupRunFiles(): Promise<void> {
		const files = [this._overlayFile, this._kanbanOverlayFile, this._codebaseOverlayFile, this._mcpOverlayFile, this._skillsOverlayFile, this._agentsOverlayFile, this._dataRootOverlayFile, this._memoryOverlayFile, this._sandboxOverlayFile, this._ownershipFile];
		this._ownershipFile = undefined;
		this._overlayFile = undefined;
		this._kanbanOverlayFile = undefined;
		this._codebaseOverlayFile = undefined;
		this._mcpOverlayFile = undefined;
		this._skillsOverlayFile = undefined;
		this._agentsOverlayFile = undefined;
		this._dataRootOverlayFile = undefined;
		this._memoryOverlayFile = undefined;
		this._sandboxOverlayFile = undefined;
		for (const f of files) {
			if (f) {
				await fsp.rm(f, { force: true }).catch(() => undefined);
			}
		}
	}

	/**
	 * 读 VsSaros 的 MCP 配置（`~/.vssaros/mcp.json`）→ 渲染成 `--patch` 覆盖层。
	 * 文件不存在＝没有 MCP（不是错误，静默返回）；解析不了的服务器**逐条记日志**——跳过原因必须可见，
	 * 否则现象是"某个 MCP 服务器莫名没挂上"，最难查。
	 */
	/**
	 * 把**内置 agent** 从代码真源生成成一份 md 副本，供 dsh 的 agents 模块扫描（返回目录绝对路径）。
	 *
	 * ★ 为什么必须"复制/生成一份文件"：dsh Host 是**独立进程**，读不到产品源码 ⇒ 要让 Host 列出
	 *   内置 agent，只能把内容**交付**出去。首选是**原样复制**真源目录
	 *   （`resources/.agents/agents/<id>/.agent.md` —— 真源是文件，见 `builtinAgentSingleSource.test.ts`）；
	 *   真源拿不到时才回退"用代码镜像序列化"（那份必须与真源一致，由一致性用例守着 ✓）。
	 *   这与 skills 把 `resources/.agents/skills` 的绝对路径交给 Host（`bundledSkillDir`）
	 *   是同一类道理：**产品侧的东西，用绝对路径交付给读不到源码的进程**。
	 *
	 * ⚠ 真源只有一个（`common/builtinAgents.ts`）—— 这里是**产物交付**，不是第二个真源；
	 *   放在 runDir ⇒ 与覆盖层同生命周期（Host 停止时一并清理 ⇒ 不会留下陈旧副本 ✗）。
	 * ⚠ 失败**不致命**：拿不到内置 agent 只是"列表少一档" ⇒ 吞错并返回 undefined，不挡启动。
	 */
	private async _writeBuiltinAgentsDir(srcDir?: string): Promise<string | undefined> {
		try {
			const dir = join(this._opts.runDir, 'agents-builtin');
			await fsp.mkdir(dir, { recursive: true });
			let written = 0;
			// ① 首选：**从真源目录原样复制** ⇒ 交付副本与 `resources/.agents/agents/` **逐字节相同** ✓
			//    （不会因为"代码镜像没同步"而把旧内容喂给 dsh ✗ —— 那正是这次要堵的洞）。
			if (srcDir) {
				for (const e of await fsp.readdir(srcDir, { withFileTypes: true })) {
					if (!e.isDirectory()) { continue; }
					const file = join(srcDir, e.name, '.agent.md');
					if (!existsSync(file)) { continue; }
					await fsp.mkdir(join(dir, e.name), { recursive: true });
					await fsp.copyFile(file, join(dir, e.name, '.agent.md'));
					written++;
				}
			}
			// ② 回退：真源目录拿不到 ⇒ 用代码里的镜像生成（它必须与真源一致，由
			//    `builtinAgentSingleSource.test.ts` 的一致性用例守着 ✓）。
			if (written === 0) {
				for (const agent of getBuiltinAgents()) {
					if (!agent.id) { continue; }
					await fsp.mkdir(join(dir, agent.id), { recursive: true });
					await fsp.writeFile(join(dir, agent.id, '.agent.md'), buildAgentMd(agent), { mode: 0o600 });
					written++;
				}
			}
			if (written === 0) { return undefined; }
			this._appendLog(`agents overlay: builtin dir with ${written} agent(s) → ${dir}`);
			return dir;
		} catch (e) {
			this._appendLog(`agents overlay: builtin dir unavailable（${String((e as Error)?.message ?? e)}）— 只列自定义 agent`);
			return undefined;
		}
	}

	private async _writeMcpOverlay(configPath: string, profileManifest: string): Promise<string | undefined> {
		// ★ 2026-10-12：MCP 的"配置 → 组合行"已归 dsh 侧（`dsh-plugins/vssaros-mcp/bin/sync-rows.mjs`，
		// 用官方 `dsh plugin add` 登记成 profile 的一个 bundle 层）。**登记过就必须让路** —— 两条路不能并存：
		// `insert` 不是"同 id 后层胜出"，实测同时开会把同一台服务器挂两遍（p3-25），而 dsh 侧 serverName
		// 重复会让后到者加载失败 ✗。这里读不到/畸形都当"未登记"（退回旧行为，不制造新故障 ✓）。
		if (await this._isMcpRowsOwnedByDsh(profileManifest)) {
			this._appendLog('mcp rows are owned by the dsh side (@vssaros/dsh-mcp-rows registered) → skipping the shell overlay');
			return undefined;
		}
		let text: string;
		try {
			text = await fsp.readFile(configPath, 'utf8');
		} catch (e) {
			if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
				this._appendLog(`mcp config unreadable (${configPath}): ${String((e as Error)?.message ?? e)}`);
			}
			return undefined;
		}
		const { servers, skipped } = parseMcpServers(text);
		for (const entry of skipped) {
			this._appendLog(`mcp server skipped (${entry.name}): ${entry.reason}`);
		}
		const id = randomBytes(6).toString('hex');
		await fsp.mkdir(this._opts.runDir, { recursive: true });
		this._mcpOverlayFile = join(this._opts.runDir, `mcp-${id}.yml`);
		await fsp.writeFile(this._mcpOverlayFile, renderMcpOverlay(servers), { mode: 0o600 });
		this._appendLog(`mcp overlay: ${servers.length} server(s)${skipped.length ? `, ${skipped.length} skipped` : ''}`);
		return this._mcpOverlayFile;
	}

	/**
	 * profile 是否已经把 MCP 行**交给 dsh 侧**（登记了 `@vssaros/dsh-mcp-rows`）。
	 *
	 * 读不动 / 字段畸形一律返回 false ⇒ 退回旧覆盖层行为（与今天一致）。**绝不在这个判定上抛错**：
	 * 它只是"让路"的优化，不是启动的前置条件，抛出去会把"Host 起不来"和"MCP 配置怪"两件事混在一起 ✗。
	 */
	private async _isMcpRowsOwnedByDsh(profileManifest: string): Promise<boolean> {
		try {
			return isDshRowsBundleRegistered(JSON.parse(await fsp.readFile(profileManifest, 'utf8')));
		} catch {
			return false;
		}
	}

	/**
	 * 官方「Preview Notice」弹窗当前所需的确认版本（`dsh-client-ui-settings-models` 里的
	 * `WELCOME_NOTICE_VERSION` 常量，dsh 升级换文案时自动跟随）。读不到返回 undefined ——
	 * 覆盖层不写那一行，退回官方"弹一次、用户点 Continue"的行为（宁可弹窗也不写坏配置）。
	 * 命中后按运行时目录缓存（同一进程内多次启动不重复读盘）。
	 */
	private _welcomeNoticeVersion(dsh: IResolvedDsh): string | undefined {
		if (this._welcomeNoticeCache?.key === dsh.bin) {
			return this._welcomeNoticeCache.value;
		}
		let value: string | undefined;
		try {
			const pkgDir = resolveSiblingPackage(dsh.bin, '@deepseek-ai/dsh-client-ui-settings-models');
			const file = pkgDir ? join(pkgDir, 'lib', 'client.js') : undefined;
			if (file && existsSync(file)) {
				value = /WELCOME_NOTICE_VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(file, 'utf8'))?.[1];
			}
		} catch {
			value = undefined;
		}
		if (!value) {
			this._appendLog('welcome-notice version not found in the runtime; the official preview notice may show once');
		}
		this._welcomeNoticeCache = { key: dsh.bin, value };
		return value;
	}

	/** 应用退出时同步结束进程树：异步 kill 来不及在进程退出前完成。keepAlive 时保留 Host 与租约。 */
	override dispose(): void {
		this._generation++;
		// 心跳**一定先停** ✗：dispose 之后这条记录要么被删（非常驻），要么被显式标记"已优雅分离"
		// （常驻）⇒ 让它继续被碰会把"宿主已经退出"这个事实抹掉，看门狗就再也判不出孤儿了 ✗。
		this._stopOwnershipHeartbeat();
		const child = this._child;
		this._child = undefined;
		this._bridge?.dispose();
		if (this._keepAlive && child && child.exitCode === null) {
			// 常驻模式：不杀进程、不撤租约——下个实例经 host.json 探活直接接管；
			// Host 侧由桥插件的空闲 TTL 自退兜底（防孤儿常驻）。
			// ★ 2026-10-16：**优雅分离要明确告诉桥插件"别自退"** ✗ 不说的后果：看门狗会把这次正常
			//   退出当成"宿主崩了"⇒ 分钟内就把**刻意常驻**的 Host 收掉 ⇒ 解法 A 的热启动白做 ✗。
			//   做法与"为什么用 mtime 而不是写字段"见 `_markOwnershipDetachedSync` ✓。
			this._markOwnershipDetachedSync();
			this._appendLog(`keepAlive: Host pid ${child.pid} keeps running after IDE exit (idle TTL applies)`);
			this._leaseStore?.releaseStartLockSync();
			super.dispose();
			return;
		}
		if (child && child.exitCode === null && child.pid !== undefined) {
			try {
				if (isWindows) {
					execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3_000, stdio: 'ignore' });
				} else {
					child.kill('SIGTERM');
				}
			} catch { /* best effort */ }
		}
		for (const f of [this._overlayFile, this._kanbanOverlayFile, this._codebaseOverlayFile, this._mcpOverlayFile, this._skillsOverlayFile, this._agentsOverlayFile, this._dataRootOverlayFile, this._memoryOverlayFile, this._sandboxOverlayFile]) {
			if (f) {
				try {
					rmSync(f, { force: true });
				} catch { /* best effort */ }
			}
		}
		const ownedPid = this._leaseOwnedPid;
		this._leaseOwnedPid = undefined;
		if (ownedPid !== undefined) {
			this._leaseStore?.removeIfOursSync(ownedPid);
		}
		this._leaseStore?.releaseStartLockSync();
		super.dispose();
	}

	// ─── 工具 ────────────────────────────────────────────────────────────────

	private _profileDir(profile: string, env: NodeJS.ProcessEnv): string {
		const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh');
		return join(home, 'profiles', profile);
	}

	private _profileManifest(profile: string, env: NodeJS.ProcessEnv): string {
		return join(this._profileDir(profile, env), 'package.json');
	}

	/**
	 * 把随产品分发的插件复制到 `<profile>/.vssaros/plugins/<name>-<version>[-<入口指纹>]/` 再安装：
	 * 1. pnpm 的 `file:` 依赖跨盘符会失败（实测：插件在 G:、`$DSH_HOME` 在 C: 时 ENOENT）；
	 * 2. 直接链接应用安装目录，应用升级后路径变化即断链。按版本分目录，旧版本留给 dsh 的回滚。
	 *
	 * ★ **目录名还要带入口内容指纹**（`fingerprint`，2026-10-14 事故驱动；算法见 `_entryFingerprint`）。
	 *
	 * 只按版本命名会踩一个**静默**坑：**改了插件内容但没 bump 版本**时，spec 路径逐字不变 ⇒ pnpm /
	 * `dsh plugin add` 认为"这个 `file:` 依赖没变化"⇒ **一个字节都不替换**。真机取证（本仓 2026-10-14）：
	 * `node_modules/@vssaros/dsh-bridge/lib/index.js` 的内容停留在两天前那次拷贝（CreationTime 是 10-12，
	 * 而同一批安装的 kb 是本次），而暂存目录、仓库源码都已是新内容 ⇒ 判定阶段**每次启动**都判"已装副本与
	 * 随包不一致 ⇒ 强制重装"、每次重装都**无效**，永久循环：每次启动白花一次 pnpm（实测 8.5 s）、
	 * 还因为 `_pluginsStale` 被置上而**放弃复用常驻 Host**（退回冷启动 ~12 s + 回收旧 Host 1.8 s），
	 * 而跑的始终是那份旧代码 ✗✗。带上指纹后 spec 变了 ⇒ 真的会重装 ✓（这正是"版本 bump"那条路一直有效的原因）。
	 *
	 * 拿不到指纹（读不到入口文件）时退回旧命名：那条路本来就是"读不到 = 不一致"⇒ 最多白装一遍 ✓。
	 */
	private async _stagePlugin(pluginName: string, sourceDir: string, version: string, profileDir: string, fingerprint?: string): Promise<string> {
		const name = pluginName.replace(/^@/, '').replace(/\//g, '-');
		const dest = join(profileDir, '.vssaros', 'plugins', `${name}-${version}${fingerprint ? `-${fingerprint}` : ''}`);
		// 源**就是**目标：它已经在位（e2e 探针会把我们的暂存目录当 spec 传进来），此时"先删再拷"
		// 会把源一起删掉，`cp` 拷出空目录、`dsh plugin add` 报缺 package.json。直接返回。
		// Windows 路径大小写不敏感，两种写法要算同一个。
		const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
		if (norm(sourceDir) === norm(dest)) {
			return dest;
		}
		await fsp.rm(dest, { recursive: true, force: true });
		await fsp.mkdir(dest, { recursive: true });
		// 只排源目录**内部**的 node_modules：源本身可能就在 node_modules 里
		//（如官方 voice-input bundle 随运行时分发），按绝对路径排会把所有文件滤光（实测）。
		await fsp.cp(sourceDir, dest, {
			recursive: true,
			filter: src => !/[\\/]node_modules([\\/]|$)/.test(src.slice(sourceDir.length)),
		});
		return dest;
	}

	/** 读 `package.json` 里的一个字符串字段（读不到 / 类型不对 / 空串都算没有）。 */
	private _readPkgField(file: string, field: string): string | undefined {
		try {
			const v = JSON.parse(readFileSync(file, 'utf8'))[field];
			return typeof v === 'string' && v.trim() ? v.trim() : undefined;
		} catch {
			return undefined;
		}
	}

	private _readPkgVersion(file: string): string | undefined {
		return this._readPkgField(file, 'version');
	}

	/**
	 * 已装副本的**入口文件**是否与随包副本逐字一致（安装判据的第二关，2026-10-13 加）。
	 *
	 * 为什么必须有：历来判据是"**版本号相同就跳过安装**"，而"源码修好了却没 bump 版本"时，那条判据会
	 * 放过一份**语法坏**的旧副本 ⇒ Host 侧打 `… : failed to import` ⇒ 该模块 **never started** ⇒
	 * 会话 resume 报 `RemoteError: vssaros-memory (@vssaros/dsh-memory): never started`，
	 * 用户端只看到一句"command directory warmup failed"的弹窗 ✗✗，而且**每次启动都复现**
	 * （版本始终相同 ⇒ 永远不修 ✓）。比对入口内容能把这类"内容变了、版本没变"抓出来 ✓；
	 * 顺带覆盖"已装副本被手改坏" ✓。
	 *
	 * 保守方向：**读不到就算不一致**（缺文件 / 入口名不对 / 权限）⇒ 最多白重装一遍 ✓（可接受），
	 * 反过来的代价是"带着坏插件起 Host"✗（不可接受）。
	 *
	 * ⚠ 2026-10-14 补充：**光有这一关还不够** —— 它只说"不一致 ⇒ 要重装"，而"重装"在**同版本同路径**下
	 * 会被 pnpm 当成 no-op（见 `_stagePlugin`）。所以现在它有三处消费者，且判定/安装/复核共用同一份定义：
	 * ① `_planPluginInstall`（要不要装）② 批量安装后的复核（配置成"版本 + 内容"）③ 启动失败文案的原因列表。
	 */
	private _installedEntryMatches(bundledDir: string, installedDir: string): boolean {
		const want = this._readEntryFile(bundledDir);
		const have = this._readEntryFile(installedDir);
		// 任一侧读不到（缺文件 / 权限 / 入口名不对）都是 `undefined` ⇒ 判"不一致" ⇒ 最多白重装一遍 ✓，
		// 而反过来的代价是"带着坏插件起 Host"✗（不可接受）。
		return want !== undefined && want === have;
	}

	/**
	 * 读一个包目录的**入口文件**内容（入口名取 `package.json` 的 `main`，缺省 `lib/index.js`）；
	 * 读不到返回 `undefined`。
	 *
	 * 为什么抽出来（2026-10-14）：同一个"入口定义"要服务两件事 —— ① {@link _installedEntryMatches} 的内容比对、
	 * ② {@link _entryFingerprint} 的暂存目录名。两处各写一份就有**静默漂移**风险：入口名不一致时，
	 * 指纹会因一个无关文件的变化而变（白重装）或该变时不变（退回"同路径 no-op"那个坑 ✗）。
	 */
	private _readEntryFile(dir: string): string | undefined {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
			const main = typeof pkg?.main === 'string' && pkg.main ? pkg.main : join('lib', 'index.js');
			const rel = main.replace(/^\.\//, '');
			return readFileSync(join(dir, rel), 'utf8');
		} catch {
			return undefined;
		}
	}

	/**
	 * 入口内容的**短指纹**（sha1 前 8 位）—— 进暂存目录名，让"同版本、内容变了"的插件换一个 spec 路径
	 * ⇒ pnpm 才会真的替换那份副本（现场与缘由见 {@link _stagePlugin} 的长注释）。
	 *
	 * 为什么用**入口文件**而不是整目录哈希：判据要与"已装副本是否陈旧"**用同一个定义**（就是上面那个
	 * 入口读取）—— 两边一致时，"指纹没变 ⇔ 判定阶段认为内容没变"，不会出现"指纹说变了、判定说没变"
	 * 这种自己跟自己打架的组合。整目录哈希（几十 MB、含 wasm）另有多倍 I/O 代价，且会把包内**构建产物
	 * 之外**的无关差异（如日志、缓存文件）算进来 ⇒ 白重装。
	 */
	private _entryFingerprint(dir: string): string | undefined {
		const text = this._readEntryFile(dir);
		return text === undefined ? undefined : createHash('sha1').update(text).digest('hex').slice(0, 8);
	}

	private _runDsh(node: IResolvedNode, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
		return new Promise(resolve => {
			execFile(node.path, args, { env, timeout, windowsHide: true, cwd: homedir(), maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
				const out = `${stdout ?? ''}${stderr ?? ''}${err && !stderr ? String(err.message) : ''}`;
				resolve(out);
			});
		});
	}

	/** 启动阶段进度：记日志 + 上报给状态区（首次启动几十秒时用户能看到进展而不是干等）。 */
	private _progress(line: string): void {
		this._appendLog(line);
		this._opts.onProgress?.(line);
	}

	private _appendLog(line: string): void {
		// 启动阶段的**任何**日志都算进展（进度行、Host 自己的输出、桥握手前的记录）——
		// 挂在这一处就够了，不必逐个 emit 点去 touch；总时长上限保证"刷日志的坏进程"仍会被判失败。
		this._startupDeadline?.touch();
		const entry = `${new Date().toISOString().slice(11, 23)} ${line}`;
		this._log.push(entry);
		if (this._log.length > LOG_LIMIT) {
			this._log.splice(0, this._log.length - LOG_LIMIT);
		}
		this._opts.log(line);
		// 落盘一份带时间戳的（内存 `this._log` 有 LOG_LIMIT 上限、且只在会话内；"首次启动太慢"这类排查
		// 需要事后能翻）。⚠ **必须异步**：主进程里的同步写一旦内核 I/O 被挂住就是整个 IDE 假死
		// （`mainProcessSyncWrites` 守卫 / 2026-10-12 三次现场）。用 Promise 链把追加串行化——保序且不阻塞；
		// 写不进**静默丢弃**（日志路径不该影响启动，IO 挂了也不能让 start 挂掉）。
		this._logWriteChain = this._logWriteChain.then(async () => {
			if (!this._harnessLogFile) {
				await fsp.mkdir(this._opts.runDir, { recursive: true });
				this._harnessLogFile = join(this._opts.runDir, `harness-${randomBytes(4).toString('hex')}.log`);
				this._opts.log(`harness log → ${this._harnessLogFile}`);
			}
			await fsp.appendFile(this._harnessLogFile, `${entry}\n`, 'utf8');
		}).catch(() => { /* 写不进就跳过 */ });
	}

	private _setStatus(status: IDshHostStatus): void {
		this._status = status;
		this._onDidChangeStatus.fire(status);
	}
}
