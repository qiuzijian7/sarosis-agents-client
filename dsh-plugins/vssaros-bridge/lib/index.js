// @vssaros/dsh-bridge — host half.
// Listens on a named pipe given by VsSaros (config.pipe). VsSaros main processes connect as
// clients (several instances may share one Host). Newline-delimited JSON-RPC 2.0.
// Only VsSaros-defined messages cross this pipe; no dsh event or data structure is relayed.
import net from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createRunsApprovalGate, createRunsService } from './runs.js';
import { CREDIT_RECORD_TYPE, createCreditLedger, creditProjection, observeStream } from './credit.js';
import { createTofService, openExternalUrl, tofToolDefinitions } from './tof.js';
import { buildRouteProfile, routeReasoningDefault, sameProfile } from './providerProfile.js';
import { CODEBUDDY_ROUTE, createCodeBuddyService } from './codebuddy.js';
import { createLightAIService } from './lightai.js';

// 启动计时（2026-10-15，"首启慢"排查）：本行的打印时刻 ≈ node 引导 + dsh 核心 + cordis profile
// 装载完成的时刻（cordis 在解析插件图时 import 本文件）；与 apply() 里那一条合起来，Host 冷启被拆成
// 「核心装载 → 模块装载/装配 → apply→ready」三段。只打一行、无状态，别在这里做别的 ✓。
console.log(`[vssaros-bridge] module loaded (host uptime ${Math.round(process.uptime() * 1000)}ms)`);

export const name = 'vssaros-bridge';
// Cordis 4: the object form of `inject` maps service names to intercept config; it has no
// "optional" semantics. Every listed service is required before apply() runs.
// `agents` (dsh-agent registry) is part of dsh-base in every supported version (0.1.7 – 0.2.x);
// `sessionController` comes from dsh-api-session-controller (web template, all supported versions).
export const inject = ['webServer', 'connection', 'workspaceRegistry', 'agents', 'sessionController', 'settings', 'credentials', 'llm', 'tools'];

// v2（2026-10-10）：新增**反向通道**（Host → IDE）。此前协议只有 IDE → Host 一个方向，
// 于是方案 6.7 那句"@vssaros/dsh-ide 的工具执行经控制桥 `ide.request` 回调 VsSaros"**不成立**——
// 实测两端都不支持：bridge 只 `send()` 响应，`DshBridgeClient` 对"id 不在自己 pending 表里"的消息直接跳过。
// v2 约定：**Host 发起的请求用负数 id**（IDE 自己的序号是正整数，天然不相交），
// 响应形如 `{ id: <负数>, result | error }`（没有 method）；参数里带 `token` 供 IDE 侧核验。
const BRIDGE_VERSION = 2;

/**
 * 企业身份（TOF/OA）票据在 dsh 侧的**凭证引用名**（`ctx.credentials.set(ref, value)` 的 ref）。
 *
 * ⚠ 必须与 IDE 侧 `src/vs/sessions/contrib/dshHarness/common/dshBridgeProtocol.ts` 的
 *   `DSH_TOF_CREDENTIAL_REF` **逐字一致** —— 两侧不能互相 import（插件是独立包，随包分发）
 *   ⇒ 由 `dsh-plugins/check-dsh-tof-identity.mjs` 做**跨层对账**钉住 ✓。
 */
const TOF_CREDENTIAL_REF = 'VSSAROS_TOF_TICKET';

/**
 * **会改用户身份状态**的工具（2026-10-21）：`tof_signin`（开系统浏览器登录 + 把票据写进 dsh 的
 * 凭据存储）、`tof_signout`（清掉那份票据）⇒ 与 kanban/kb 的写同一档 ⇒ 必须挂官方审批闸 ✓
 * （`tof_status` 只读 ⇒ 不拦 ✓）。
 *
 * ⚠ 名字表由守卫 `dshPluginPackages.test.ts` 逐名核对（改了名却没改这里 ⇒ 闸会静默失效 ✗）。
 */
export const WRITE_TOOLS = ['tof_signin', 'tof_signout'];

const pluginVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** 常驻 Host 的空闲自退：最后一个 IDE 客户端断开后，超过该时长无新客户端则 Host 优雅退出。 */
const IDLE_TTL_DEFAULT_MS = 30 * 60_000;

/**
 * 拥有者**心跳**的陈旧阈值（2026-10-16）。
 *
 * 宿主（VsSaros 主进程）活着时会定期碰一次拥有者记录的 mtime，间隔由 TS 侧的
 * `HOST_RUN_OWNERSHIP_HEARTBEAT_MS` 定义（20s）⇒ 超过这里的阈值没动，就认定"宿主进程**崩了**
 * （没走到优雅退出）而 Host 还在常驻"。
 * ⚠ 主进程被**同步文件写挂住**（本仓有过"零 CPU 假死"、同一指纹 4 次）时心跳同样会停 ⇒ 这里也会按
 *   "失联"处理。那是**有意的取舍**：挂住的宿主本来也用不了这些会话，先把握着的写租约放出来 ✓；
 *   代价是宿主恢复后那次会是冷启动（比"会话一直被占用"划算 ✓）。
 * ★ 两侧是**一对**常量（阈值 ≥ 3× 心跳），由 `test/common/dshOwnerWatchdog.test.ts` 的配对守卫钉住 ✓。
 */
/**
 * ★ 2026-10-28（用户：「商城、媒体库加载很慢，切回会话也很慢」）真机取证：
 *   `providers.sync` 每轮都要 `settings.mutate('llm-pi-ai', …)` ≈ 2s，而 `vssaros-ollama` 路由
 *   在 `stale` ↔ `route-absent` 之间**来回震荡**（写进去下一轮又"不在"，于是再写）
 *   ⇒ 每轮 2s 的设置写入持续占着 Host 事件循环 ⇒ 同期的 `/api/session/list`、`/api/commands/list`
 *   等全部排队（实测这些接口 0.8–1.5s，而空闲时 5ms）。
 *   ⇒ 对"连续写不进去"的路由**停止重写**：连续 N 轮只有它的 stale/absent 差异 ⇒ 本轮跳过 mutate。
 *   一旦它真的写成功了（下一轮没有它的差异）⇒ 计数清零，恢复正常。
 */
const ROUTE_WRITE_STREAK_LIMIT = 2;
/** route → 连续"写不进去"的轮数（模块级：跨 sync 调用累计） */
const routeWriteStreak = new Map();

const OWNER_STALE_MS = 3 * 20_000;
/** 看门狗的巡检间隔（比阈值小一个数量级 ⇒ 够及时，且几乎不耗 CPU ✓）。 */
const OWNER_WATCH_INTERVAL_MS = 20_000;

/**
 * 推理能力位：**pi-ai 的模型级字段是 `reasoningEfforts`**（`{ 档位 → 线上取值 }`），不是 `reasoning`。
 *
 * 为什么必须写对（实测症状）：`dsh-llm-pi-ai` 的 `modelFields` 只有
 * `name / contextWindow / maxTokens / input / reasoningEfforts / compat`；`reasoning` 对它是**未知键**
 * ⇒ 被忽略 ⇒ `resolveModelReasoning()` 落到 `{ reasoning: base?.reasoning ?? false }`（自定义路由没有
 * catalog 基线 ⇒ **false**）⇒ 模型在 dsh 里不支持推理 ⇒ **输入框的模型选择器缺 effort 档位行**
 * （`ModelSelect` 的档位来自 `model.reasoning.efforts` / `defaultEffort`）。
 *
 * 档位与线上取值：CodeBuddy 网关收 `reasoning_effort: low|medium|high`
 * （见 `extensions/codebuddy-provider/src/extension.ts` 的请求体构造：
 * `bodyObj.reasoning_effort = effort`，effort ∈ {low,medium,high}）；pi-ai 在 `openai-completions`
 * 下按 `thinkingLevelMap[档位]` 发该字段，而这个 map 正是由 `reasoningEfforts` 翻译来的
 * （默认 compat 已满足：`supportsReasoningEffort: true`、`thinkingFormat: 'openai'`
 * —— 自定义 baseURL 落在这条默认分支上，无需额外写 compat）。
 *
 * 档位**只声明网关认的三个**：`resolveModelReasoning` 会把未声明的档位钉成 null（= 不支持），
 * 所以不必也不该把 minimal/xhigh/max 塞进来（pi-ai 对 xhigh/max 还要求显式声明才算支持）。
 *
 * `off: null` 是**唯一允许"声明但留空"**的档（`resolveModelReasoning`：`wire === null` 只有 off 合法，
 * 其它档位留空会 invalid）——语义是"支持，且选中时不发 reasoning 参数"。为什么要显式写它：
 * pi-ai 把**未声明**的档位钉成 null（`if (wire === void 0) map[level] = null;` ⇒ 不支持），
 * 于是 Omission 与 null 语义相反：
 *   · 不写 off      ⇒ 选择器**没有 Off**，用户无法关思考（= 我们上一版的状态）；
 *   · `off: null`   ⇒ 选择器出现 **Off** 档，等价于**原生聊天框思考开关的"关"**
 *                     （扩展侧 `reasoningActive === false` 时也同样是**完全不发** `reasoning_effort`，
 *                      见 `extensions/codebuddy-provider/src/extension.ts:1125`）。
 * 位置：菜单顺序 = `getSupportedThinkingLevels()` 的 THINKING_LEVELS 顺序 ⇒ **Off 排第一**，
 * 与官方 deepseek 适配器一致（`dsh-llm-deepseek/lib/index.js:456` 的 REASONING_EFFORTS 首项也是 Off）。
 * 合法性已核实：schema 明写收 null（`dsh-llm-pi-ai/lib/index.js:1001`：
 * `z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS))`），且经 schemastery 解析/再解析后
 * **仍是 null**（不是被抹成 undefined）⇒ 幂等比对（`sameReasoning`）不会每次都判"变了"。
 *
 * ★ 2026-10-22：`REASONING_EFFORTS` / `REASONING_LEVELS` / `routeReasoningDefault` 与画像比对（`sameProfile`）
 *   已移到 `./providerProfile.js` —— dsh 侧自持的 provider（`./codebuddy.js`）写同一种画像，必须共用一份 ✓。
 */

/**
 * **dsh 侧自持**的路由（2026-10-22）：登录 / 目录 / 写入都在 Host 里做（见 `./codebuddy.js`）。
 *
 * `providers.sync`（IDE 侧整批同步）对这些路由**一律不碰**：负载里带了也忽略、"残留 vssaros- 路由"清理时
 * 也跳过、凭据也不覆盖 —— 否则 IDE（旧版或过渡期）一次同步就会把 dsh 自己维护的路由删掉/改回去 ✗。
 */
const DSH_OWNED_ROUTES = new Set([CODEBUDDY_ROUTE]);
/**
 * 上一次打过的“默认推理档位”汇总行 —— **值没变就不再打**。
 *
 * Why: 这行原先每次 `providers.sync` 都打一遍，而 sync 在每次会话/工具往返里都会跑 ⇒
 * 2026-10-11 用户在 Host 日志里看到同一行刷了几十遍，日志彻底没法用（他原话：“值没变就不重复打的去重”）。
 * 只按**内容**去重（不按次数/时间）：档位真的变了还是要留痕 ✓。
 */
let lastRouteReasoningLog = '';

export function apply(ctx, config = {}) {
	// 启动计时（与文件顶部那条配对）：模块装载 → apply 之间是 cordis 等齐 inject 声明的服务。
	// 2026-10-15：把进入时刻存下来，好让函数末尾那条"apply done (took …)"报出**同步部分**的耗时 ✓
	const applyStartMs = Math.round(process.uptime() * 1000);
	console.log(`[vssaros-bridge] apply (host uptime ${applyStartMs}ms)`);
	/** 反向通道是否就绪（页面自诊断用；只在配了 pipe/token 时才有意义）。 */
	let reverseReady = false;
	let connectedClients = 0;
	// 空闲自退定时器（VsSaros 的 hostKeepAlive 模式：IDE 退出不杀 Host，靠这里防孤儿常驻）。
	// 0 = 不自退。只在配了 pipe（即 VsSaros 托管的 Host）时启用——浏览器直接访问的 dsh web 不受影响。
	const idleTtlMs = config.idleTtlMs === undefined ? IDLE_TTL_DEFAULT_MS : Number(config.idleTtlMs);
	let idleTimer;
	const noteClients = () => {
		connectedClients = clients.size;
		if (!config.pipe || !idleTtlMs) {
			return;
		}
		if (connectedClients > 0) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		} else if (!idleTimer) {
			idleTimer = setTimeout(() => {
				console.log(`[vssaros-bridge] idle for ${Math.round(idleTtlMs / 60000)} min with no IDE client; shutting down the host`);
				process.exit(0);
			}, idleTtlMs);
			idleTimer.unref?.();
		}
	};
	// ── 拥有者失联自退（2026-10-16）──────────────────────────────────────────────
	// 场景：宿主进程**崩了**（没有任何退出路径跑到），而这个 Host 还在按 idleTtlMs 常驻 ⇒ 它会一直
	// 攥着会话写租约（`session.lock` 是 OS 文件锁，只有关句柄/退进程才释放；而 dsh 的 agent 归**宿主**
	// 所有、不随客户端离开释放）⇒ 与官方 DSH 桌面端共用 `~/.dsh` 时表现为"这个会话已被占用" ✗。
	// 判据三合一（少一条都会误杀 ✗）：
	//   ① 没有 IDE 客户端（clients.size === 0）；
	//   ② 拥有者记录的 mtime 已过期 —— ⚠ **不能只看 pid 存活**，pid 会被复用骗过 ✗；
	//   ③ 记录路径由**握手**给出（`client.register` 的 ownerRecord）⇒ 永远对应当前那个拥有者 ✓
	//      （接管场景下会被换成接管者那份 ✓，所以不能用环境变量一次性给 ✗）。
	// 读不到记录（还没写下 / 已被清）⇒ **一律不动**（保守 ✓）。
	// ⚠ 优雅分离（IDE 正常退出且 keepAlive）时宿主会把 mtime 推到未来 ⇒ 这里天然判"不陈旧" ✓。
	let ownerRecordPath;
	const ownerWatchdog = setInterval(() => {
		if (!ownerRecordPath || clients.size > 0) { return; }
		let mtimeMs;
		try { mtimeMs = statSync(ownerRecordPath).mtimeMs; } catch { return; }
		const staleMs = Date.now() - mtimeMs;
		if (staleMs <= OWNER_STALE_MS) { return; }
		console.log(`[vssaros-bridge] owner heartbeat stale for ${staleMs}ms (${ownerRecordPath}) and no IDE client; shutting down the host so session write handles are released`);
		process.exit(0);
	}, OWNER_WATCH_INTERVAL_MS);
	ownerWatchdog.unref?.();

	// ── 默认模型对齐（providers.sync 与 dsh 侧自持 provider 共用；2026-10-22 从 providers.sync 里抽出）───
	// 现象：新会话的模型选择器默认停在官方 `deepseek-official/deepseek-flash`（官方 bundle 写死），而在
	// VsSaros 里那个 provider **没有凭据** ⇒ 默认停在一个用不了的模型上。
	// 规则（与抽出前逐字一致）：
	//   · 候选 = 传入的路由（首选 `vssaros-codebuddy`，否则取第一条有模型的）；
	//   · **只**在"当前默认仍是官方 deepseek-official 且它不可用"或"当前默认指向我们已失效的路由"时改写；
	//     用户自己选过的一律不动；
	//   · 走官方 `agentDefaultModel.saveSelection()`（经 configEditor 写 profile patch ⇒ 跨重启保留）；
	//   · 服务缺席时静默跳过，绝不影响 provider 接入。
	/**
	 * @param {Record<string, {models?: Array<{id:string}>}>} candidates 路由 → 画像（只用 models）
	 * @returns {Promise<string|undefined>} 日志用说明；没改写 ⇒ undefined
	 */
	async function alignDefaultModel(candidates) {
		const { llm } = ctx;
		try {
			const defaultModel = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined;
			if (!defaultModel?.currentSelection || !defaultModel?.saveSelection) { return undefined; }
			const current = defaultModel.currentSelection();
			const routeIds = Object.keys(candidates);
			// "我们的路由是否仍在线"必须看 `llm.listProviders()`（**真实在线**路由），不能看本次传入的候选
			// （候选可能没带全 ⇒ 会把"用户自己选中的、仍然在线"的 vssaros- 路由误判成已失效而覆盖 ✗）。
			const liveRoutes = (llm?.listProviders?.() ?? []).map(p => String(p?.provider ?? p?.id ?? p)).filter(r => r.startsWith('vssaros-'));
			const preferred = [routeIds.includes(CODEBUDDY_ROUTE) ? CODEBUDDY_ROUTE : undefined, ...routeIds]
				.filter(r => r !== undefined)
				.map(route => ({ route, models: candidates[route]?.models ?? [] }))
				.find(c => c.models.length > 0);
			const untouchedOfficialDefault = current?.provider === 'deepseek-official';
			const staleOwnRoute = typeof current?.provider === 'string' && current.provider.startsWith('vssaros-') && !liveRoutes.includes(current.provider);
			// 官方 provider **仍可用**（用户自己配了 DeepSeek 凭据）⇒ 尊重其默认值，不动。
			let officialUsable = false;
			if (untouchedOfficialDefault) {
				try {
					officialUsable = (await llm.listModels('deepseek-official')).length > 0;
				} catch {
					officialUsable = false;
				}
			}
			if (preferred && !officialUsable && (untouchedOfficialDefault || staleOwnRoute)) {
				// `saveSelection` 在没有 configuration editor 时是 no-op（官方 README）⇒ 只记"请求改写"。
				await defaultModel.saveSelection({ provider: preferred.route, model: preferred.models[0].id });
				return `请求改写 ${current.provider}/${current.model} -> ${preferred.route}/${preferred.models[0].id}`;
			}
			return undefined;
		} catch (e) {
			return `ERR ${String(e?.message ?? e).slice(0, 160)}`;
		}
	}

	// ── CodeBuddy：**dsh 侧自持**的模型 provider（2026-10-22，见 ./codebuddy.js 文件头）──────────────
	// 放在 `pipe/token` 早退**之前**：dsh 独立跑（没有 IDE）时 CodeBuddy 也要能登录、能出模型 ✓。
	// 有 IDE 托管（配了 pipe）时首轮同步推迟到"第一个 IDE 客户端注册"（那时才能拿到计费代理地址 ⇒
	// 避免先写直连、再改代理地址的两次 profile 重写）；20s 内没人注册就按直连写。
	const codebuddy = createCodeBuddyService({
		credentials: ctx.credentials,
		settings: ctx.settings,
		openExternal: openExternalUrl,
		config: (config && typeof config.codebuddy === 'object' && config.codebuddy) ? config.codebuddy : {},
		onRouteWritten: async entry => {
			const note = await alignDefaultModel({ [entry.route]: entry });
			if (note) { console.log(`[vssaros-bridge] default model: ${note}`); }
		},
		log: line => console.log(line),
	});
	ctx.effect(() => codebuddy.start({ initialDelayMs: config && config.pipe ? 20_000 : 2_000 }));

	// ── LightAI（2026-10-22，用户选方案 ①：用本仓浏览器插件开登录页、登录后自动读 Cookie）──────────────
	// 浏览器插件是**可选**依赖：`ctx.inject([...], cb)` 动态取（不在 ⇒ 本插件照常起，只是登录时明说"需要浏览器插件"）✓。
	// 放在管道早退之前：dsh 独立跑（没有 IDE）时 LightAI 也要能登录 ✓。
	let browserService;
	try {
		ctx.inject?.(['vssarosBrowser'], scope => {
			browserService = scope.vssarosBrowser;
			return () => { browserService = undefined; };
		});
	} catch { /* 老运行时没有动态 inject ⇒ 登录时如实报"需要浏览器插件" */ }
	const lightai = createLightAIService({
		credentials: ctx.credentials,
		browser: () => browserService,
		config: (config && typeof config.lightai === 'object' && config.lightai) ? config.lightai : {},
		log: line => console.log(line),
	});
	/**
	 * `vssarosLightAI`：给**同 Host 的其他插件**用的 LightAI 生成服务（2026-10-22 二期，用户："把建任务、轮询结果这套
	 * 搬到 dsh，让 dsh 里生图直接用 LightAI，不再绕道 IDE"）。imagegen 的生图 / 改图 / 模型列表直接调它。
	 * ⚠ 只交出**生成与状态**：cookie / 编排凭证不出本插件（回执里只有产物 URL）✓。
	 * 放在管道早退之前：dsh 独立跑（没有 IDE）时也能生图 ✓。
	 */
	ctx.provide('vssarosLightAI', {
		/** 状态投影（同设置页那份；**无 cookie 值**）。 */
		status: () => lightai.status(),
		/** 某类里能生成的模型 + 默认模型：`{ models: [{id, name}], defaultModel }`。 */
		models: kind => lightai.modelsOf(kind),
		/** banana 系可选比例（给能力表展示用）。 */
		ratios: lightai.ratios,
		/**
		 * 生成一次：`kind` = image / video / model3d / audio；`params` 同 IDE 扩展的 FloodGenParams
		 * （modelId 可省 ⇒ 该类默认模型；imageInput = 参考图 data URL / http(s) URL）；`opts.signal` 可取消。
		 */
		generate: (kind, params, opts) => lightai.generate(kind, params, opts),
	});

	/**
	 * 设置页（模型 → CodeBuddy 卡片）用的 HTTP 面：`/x/vssaros-bridge/api/codebuddy/<op>`。
	 * 与页面同源、走同一道 `requestRejection`（Host 的围栏 + 浏览器认证）⇒ **不经 IDE** 也能登录 ✓。
	 * 回执只有状态投影（**没有 token**）✓。
	 */
	const CODEBUDDY_API = '/x/vssaros-bridge/api/codebuddy/';
	const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
	// ⚠ 这里**不用 switch 分支写子路径**：守卫 `dshBridgeParity.test.ts` 把本文件里所有"case + 引号字符串 + 冒号"
	//   都当成"桥方法分发"去和协议对账（扫的是原文、不剥注释）⇒ HTTP 子路径写成分支会被误判为"分发了协议里没有的方法" ✗。
	/** @type {Record<string, {write: boolean, run: () => Promise<[number, object]>}>} */
	const codebuddyOps = {
		status: { write: false, run: async () => [200, { ok: true, status: await codebuddy.status() }] },
		// 不等浏览器那头（可能要几分钟）：先回 202 + "登录中"，页面轮询 status 看结果 ✓（失败原因落在 status().error）
		signin: { write: true, run: async () => { codebuddy.signIn().catch(() => undefined); return [202, { ok: true, status: await codebuddy.status() }]; } },
		cancel: { write: true, run: async () => { codebuddy.cancelSignIn(); return [200, { ok: true, status: await codebuddy.status() }]; } },
		signout: { write: true, run: async () => [200, { ok: true, status: await codebuddy.signOut() }] },
		refresh: { write: true, run: async () => { await codebuddy.refreshModels(); return [200, { ok: true, status: await codebuddy.status() }]; } },
	};
	async function handleCodeBuddyApi(op, req, res) {
		const reply = (code, body) => { res.writeHead(code, JSON_HEADERS); res.end(JSON.stringify(body)); };
		const entry = Object.prototype.hasOwnProperty.call(codebuddyOps, op) ? codebuddyOps[op] : undefined;
		if (!entry) {
			reply(404, { ok: false, error: `未知操作：${op}` });
			return;
		}
		if (entry.write && req.method !== 'POST') {
			reply(405, { ok: false, error: `${op} 只接受 POST`, method: String(req.method ?? '') });
			return;
		}
		try {
			const [code, body] = await entry.run();
			reply(code, body);
		} catch (e) {
			reply(500, { ok: false, error: String(e?.message ?? e) });
		}
	}

	/**
	 * 企业身份（TOF/OA）的 HTTP 面：`/x/vssaros-bridge/api/tof/<op>`（2026-10-22，用户："登录也转移到 dsh 侧实现，
	 * ide 侧仅读取状态"）——dsh 页面（侧栏账号行）**不经 IDE** 直接登录 / 登出 ⇒ 独立桌面窗口也能用 ✓。
	 * 与 CodeBuddy 同一套写法：写操作只认 POST、`signin` 先回 202 页面轮询、回执**没有票据** ✓。
	 * ⚠ `tofService` 在本函数更下方才建（它要排在管道早退之前）——handler 只在请求到来时跑，
	 *   那时 apply() 早已跑完 ⇒ 不会撞上暂时性死区 ✓。
	 */
	const TOF_API = '/x/vssaros-bridge/api/tof/';
	/** @type {Record<string, {write: boolean, run: () => Promise<[number, object]>}>} */
	const tofOps = {
		status: { write: false, run: async () => [200, { ok: true, status: await tofService.status() }] },
		signin: { write: true, run: async () => { tofService.signIn().catch(() => undefined); return [202, { ok: true, status: await tofService.status() }]; } },
		cancel: { write: true, run: async () => { tofService.cancelSignIn(); return [200, { ok: true, status: await tofService.status() }]; } },
		// 用户点「退出登录」= 两份票都清 + 记"主动登出过"（IDE 不再把旧扩展里的票迁回来）✓
		signout: { write: true, run: async () => { await tofService.signOut({ all: true, byUser: true }); return [200, { ok: true, status: await tofService.status() }]; } },
	};
	async function handleTofApi(op, req, res) {
		const reply = (code, body) => { res.writeHead(code, JSON_HEADERS); res.end(JSON.stringify(body)); };
		const entry = Object.prototype.hasOwnProperty.call(tofOps, op) ? tofOps[op] : undefined;
		if (!entry) {
			reply(404, { ok: false, error: `未知操作：${op}` });
			return;
		}
		if (entry.write && req.method !== 'POST') {
			reply(405, { ok: false, error: `${op} 只接受 POST`, method: String(req.method ?? '') });
			return;
		}
		try {
			const [code, body] = await entry.run();
			reply(code, body);
		} catch (e) {
			reply(500, { ok: false, error: String(e?.message ?? e) });
		}
	}

	/**
	 * LightAI 的 HTTP 面：`/x/vssaros-bridge/api/lightai/<op>`（设置 → 模型 → LightAI 卡片用）。
	 * 同 CodeBuddy：写操作只认 POST、`signin` 先回 202 页面轮询、回执**没有 cookie 值** ✓。
	 * `config` 带 JSON 体（≤16KB）：`{ floodApiBase?, userType?, company? }`。
	 */
	const LIGHTAI_API = '/x/vssaros-bridge/api/lightai/';
	const readJsonBody = req => new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on?.('data', c => {
			size += c.length;
			if (size > 16 * 1024) { reject(new Error('请求体过大')); req.destroy?.(); return; }
			chunks.push(c);
		});
		req.on?.('end', () => {
			try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('请求体不是 JSON')); }
		});
		req.on?.('error', reject);
	});
	/** @type {Record<string, {write: boolean, run: (req: any) => Promise<[number, object]>}>} */
	const lightaiOps = {
		status: { write: false, run: async () => [200, { ok: true, status: await lightai.status() }] },
		signin: { write: true, run: async () => { lightai.signIn().catch(() => undefined); return [202, { ok: true, status: await lightai.status() }]; } },
		cancel: { write: true, run: async () => { lightai.cancelSignIn(); return [200, { ok: true, status: await lightai.status() }]; } },
		signout: { write: true, run: async () => [200, { ok: true, status: await lightai.signOut({ byUser: true }) }] },
		refresh: { write: true, run: async () => [200, { ok: true, status: await lightai.refreshModels() }] },
		test: { write: true, run: async () => [200, { ok: true, status: await lightai.test() }] },
		config: { write: true, run: async req => [200, { ok: true, status: await lightai.setConfig(await readJsonBody(req)) }] },
	};
	/**
	 * 创作模型目录 / 默认选择（2026-10-22，聊天框下拉框用）。
	 * `GET  /x/vssaros-bridge/api/media/catalog` —— 按 provider 分组的全部媒体模型 + 各类默认 + provider 状态
	 * `POST /x/vssaros-bridge/api/media/default` —— body `{ kind, provider, model }` ⇒ 记住这一类的默认
	 * ⚠ 只有 dsh 侧能生成的 provider 才在里面（用户已定：不经 IDE）；回执里没有 cookie ✓
	 */
	const MEDIA_API = '/x/vssaros-bridge/api/media/';
	const mediaOps = {
		catalog: {
			write: false,
			run: async () => [200, { ok: true, ...(await lightai.catalog()) }],
		},
		default: {
			write: true,
			run: async req => [200, { ok: true, ...(await lightai.setDefault(await readJsonBody(req))) }],
		},
	};
	async function handleMediaApi(op, req, res) {
		const reply = (code, body) => { res.writeHead(code, JSON_HEADERS); res.end(JSON.stringify(body)); };
		const entry = Object.prototype.hasOwnProperty.call(mediaOps, op) ? mediaOps[op] : undefined;
		if (!entry) {
			reply(404, { ok: false, error: `未知操作：${op}` });
			return;
		}
		if (entry.write && req.method !== 'POST') {
			reply(405, { ok: false, error: `${op} 只接受 POST`, method: String(req.method ?? '') });
			return;
		}
		try {
			const [code, body] = await entry.run(req);
			reply(code, body);
		} catch (e) {
			reply(400, { ok: false, error: String(e?.message ?? e) });
		}
	}

	async function handleLightAIApi(op, req, res) {
		const reply = (code, body) => { res.writeHead(code, JSON_HEADERS); res.end(JSON.stringify(body)); };
		const entry = Object.prototype.hasOwnProperty.call(lightaiOps, op) ? lightaiOps[op] : undefined;
		if (!entry) {
			reply(404, { ok: false, error: `未知操作：${op}` });
			return;
		}
		if (entry.write && req.method !== 'POST') {
			reply(405, { ok: false, error: `${op} 只接受 POST`, method: String(req.method ?? '') });
			return;
		}
		try {
			const [code, body] = await entry.run(req);
			reply(code, body);
		} catch (e) {
			reply(400, { ok: false, error: String(e?.message ?? e) });
		}
	}

	// P0-8: plugin-hosted page, guarded by the Host's own fence + browser auth (always on, even outside VsSaros).
	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: '/x/vssaros-bridge',
		handler: (req, res) => {
			const rejected = ctx.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain' });
				res.end(String(rejected));
				return;
			}
			const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
			if (pathname.startsWith(CODEBUDDY_API)) {
				void handleCodeBuddyApi(pathname.slice(CODEBUDDY_API.length), req, res);
				return;
			}
			if (pathname.startsWith(TOF_API)) {
				void handleTofApi(pathname.slice(TOF_API.length), req, res);
				return;
			}
			if (pathname.startsWith(LIGHTAI_API)) {
				void handleLightAIApi(pathname.slice(LIGHTAI_API.length), req, res);
				return;
			}
			if (pathname.startsWith(MEDIA_API)) {
				void handleMediaApi(pathname.slice(MEDIA_API.length), req, res);
				return;
			}
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
			res.end(`<!doctype html><meta charset="utf-8"><title>vssaros-bridge</title><main data-vssaros-page="status" data-vssaros-bridge-version="${BRIDGE_VERSION}" data-vssaros-bridge-reverse="${reverseReady ? 'ready' : 'off'}" data-vssaros-bridge-clients="${connectedClients}">vssaros-bridge ${pluginVersion} on :${ctx.webServer.port}</main>`);
		},
	}));

	// 重构 1.4（2026-10-16）：后台回合服务 `vssarosRuns`（cordis 服务，Host 内插件直接用）+
	// 桥方法 `session.run`（IDE 侧过渡期调用）。链路按 Spike S1 已验证的手法（见 runs.js 文件头）。
	// 与 pipe/token 无关：即使脱离 VsSaros 跑（纯 dsh web），Host 内插件也该能用 ⇒ provide 提前到这里。
	// 1.5：runs 会话的审批最终应答者（deny-by-default；非 runs 会话放行给 UI 应答者）。
	// 挂在根 ctx：scoped waterfall 对无标签侦听放行 ⇒ 收得到全部 agent 的请求 ✓（Spike 5a/5b 实测）。
	const approvalGate = createRunsApprovalGate(handler => ctx.on('approval/request', handler));

	// ── 积分账本（2026-10-20；详见 credit.js 文件头）────────────────────────────────
	// 主进程代理抓到积分 → 桥 `credit.record` → 这里按 LLM 调用区间归属到 (会话, 回合)
	// → 写进会话日志（官方插件记录）→ 投影 `vssaros-credit` 自动推给页面。
	//
	// ⚠ 本仓插件原则上不 import `@deepseek-ai/*`（profile 侧解析不到、跨版本不稳）。这里是**唯一例外**：
	//   `appendPluginRecord` 只从 `@deepseek-ai/dsh-session` 导出（`session.append` 写未知类型会让会话
	//   **重载时整条打不开**，绝不能用）。所以从**正在运行的 Host 入口**解析它 —— 拿到的就是 Host 自己
	//   那份模块实例（`#appendRecord` 是私有字段，必须同一个类），版本也永远与 Host 一致。
	//   解析失败 ⇒ 账本不写记录（返回 appended:false），页面自动退回旧的时间窗口径，不会坏 ✓。
	let appendPluginRecordFn = null;
	void (async () => {
		try {
			const entry = process.argv[1];
			if (!entry) { throw new Error('process.argv[1] is empty'); }
			const resolved = createRequire(entry).resolve('@deepseek-ai/dsh-session');
			const mod = await import(pathToFileURL(resolved).href);
			if (typeof mod.appendPluginRecord !== 'function') { throw new Error('appendPluginRecord is not exported'); }
			appendPluginRecordFn = mod.appendPluginRecord;
			console.log('[vssaros-bridge] credit ledger ready (appendPluginRecord from Host runtime)');
		} catch (e) {
			console.warn(`[vssaros-bridge] credit ledger disabled: cannot load appendPluginRecord (${String(e?.message ?? e)})`);
		}
	})();
	const sessionOf = (id) => {
		try {
			const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
			return sessions?.get?.(id) ?? ctx.agents?.get?.(id)?.session;
		} catch { return undefined; }
	};
	const creditLedger = createCreditLedger({
		now: () => Date.now(),
		turnOf: (id) => {
			const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined;
			const session = sessionOf(id);
			if (!projections || !session) { return undefined; }
			const boundary = projections.stateOf(session, 'turnBoundary');
			if (!boundary) { return undefined; }
			return boundary.openTurnStartSeq === null ? null : boundary.lastTurn;
		},
		append: (id, data) => {
			if (!appendPluginRecordFn) { return false; }
			const session = sessionOf(id);
			if (!session) { return false; }
			appendPluginRecordFn(session, CREDIT_RECORD_TYPE, data);
			// 立刻落盘（同官方 translator 的做法）：回合已结束时不会再有下一次检查点替我们 flush。
			try {
				const sessions = ctx.get('sessions');
				void Promise.resolve(sessions?.flush?.(session)).catch(() => undefined);
			} catch { /* flush 失败不影响记录本身（下次检查点会带上） */ }
			return true;
		},
		log: line => console.log(`[vssaros-bridge] ${line}`),
	});
	// 记账：每次 LLM 调用的 (会话, provider, model, 起止)。只观察、不改请求与 chunk。
	ctx.on('llm/stream', (options, next) => {
		const handle = creditLedger.beginCall({
			sessionId: options?.sessionId,
			provider: options?.provider,
			model: options?.model,
			purpose: options?.purpose,
		});
		return observeStream(next(), handle);
	});
	// 投影：同 key + 同 stateVersion 的 register 是 ref-count 共享。`register` 内部走的是**调用方**
	// ctx 的 effect ⇒ 随 child 作用域自动释放（与 vssaros-agents 的 persona 投影同一写法，不手动 dispose）。
	ctx.inject(['sessionProjections'], child => child.effect(() => {
		child.sessionProjections.register(creditProjection());
		return () => { };
	}));
	const runs = createRunsService({
		agents: ctx.agents,
		sessionController: ctx.sessionController,
		workspaceRegistry: ctx.workspaceRegistry,
		approvalGate,
	});
	Object.defineProperty(runs, Symbol.for('cordis.tracker'), {
		value: { property: 'ctx', noShadow: true },
		enumerable: false,
	});
	ctx.provide('vssarosRuns', runs);

	// ── 企业身份（TOF/OA）：dsh 侧**独立**登录（2026-10-21）────────────────────────
	//
	// 原先只有一条路：IDE 侧登录 → 票据经控制桥 `tof.sync` 同步过来 ⇒ **依附 IDE**。
	// dsh 单独跑（没有 IDE / IDE 没开）时 Host 手里没有身份 ⇒ 商城 / 内网服务 / 内网 MCP 全用不了。
	// 这里补上"dsh 自己登"这条路：vendored TOF 客户端（起 loopback → spawn 开浏览器 → whoami 验证）
	//   ⇒ 票据落进 dsh 的凭据存储（`ctx.credentials`）。
	//
	// ⚠ **两份票据分开存**：IDE 同步的那份是 `TOF_CREDENTIAL_REF`（下面那个常量），dsh 自登的是
	//   `VSSAROS_TOF_TICKET_DSH`（见 tof.js）⇒ 两条路不互相覆盖；读取时按"本地自登 > IDE 同步"取 ✓。
	// ⚠ **票据绝不出现在工具回执里**（回执会进模型上下文与页面 ⇒ 等同下发页面 ✗）——投影只有工号/姓名/团队 ✓。
	// ⚠ 这一段放在 `pipe/token` 早退**之前**：dsh 独立跑时没有管道，登录能力也必须可用 ✓。
	// ★ 2026-10-22（用户："登录也转移到 dsh 侧实现，ide 侧仅读取状态"）：登录态一变就通知 IDE
	//   （反向方法 `tof.changed`，主进程就地转给渲染进程）⇒ IDE 的 TofAuthService 立刻重读，不必轮询 ✓。
	//   通知函数在下面管道段里才有（要 IDE 客户端）⇒ 这里先放一个晚绑定的钩子。
	let notifyTofChanged = () => { };
	const tofService = createTofService({
		credentials: ctx.credentials,
		ideCredentialRef: TOF_CREDENTIAL_REF,
		config: (config && typeof config.tof === 'object' && config.tof) ? config.tof : {},
		log: line => console.log(line),
		onChange: why => notifyTofChanged(why),
	});
	ctx.provide('vssarosTof', tofService);
	for (const definition of tofToolDefinitions(tofService)) {
		ctx.effect(() => ctx.tools.register(definition));
	}

	// ── 审批闸（2026-10-21）：改企业身份的工具必须先问用户 ─────────────────────
	//   `tof_signin` 会**打开系统浏览器**并把票据写进 dsh 的凭据存储；`tof_signout` 会清掉那份票据
	//   ⇒ 两者都改用户的身份状态 ⇒ 与 kanban/kb 的写同一档 ⇒ 挂官方 `tools/pre-execute` ⇒ ask ✓
	//   （官方契约：`ask` 只有审批服务返回 allowed-once 才执行；没有审批支持的部署 degrade to deny
	//   ⇒ fail-closed ✓）。`tof_status` 只读 ⇒ 直接放行（不弹窗 ⇒ 不造成审批疲劳 ✓）。
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		if (!exec || !WRITE_TOOLS.includes(exec.name)) {
			return next();
		}
		return {
			kind: 'ask',
			reason: `${exec.name} 会改动你的企业身份（登录会打开系统浏览器并保存票据；登出会清掉 dsh 侧保存的票据）`,
			displayReason: {
				en: `${exec.name} changes your corporate identity (sign-in opens the system browser and stores a ticket; sign-out clears the stored one)`,
				zh: `${exec.name} 会改动你的企业身份（登录会打开系统浏览器并保存票据；登出会清掉 dsh 侧保存的票据）`,
			},
		};
	}));

	const { pipe, token } = config;
	if (!pipe || !token) {
		// Running outside VsSaros (e.g. plain `dsh web`): stay inert.
		return;
	}
	const clients = new Map();
	/**
	 * 反向（Host → IDE）待答请求：id → { resolve, reject, timer }。
	 * id 一律**负数**（见文件头的协议说明），与 IDE 自己的正数序号不相交。
	 */
	const outbound = new Map();
	let outboundSeq = 0;

	/** 选一个已注册的 IDE 客户端（可按 instanceId 指定；缺省取第一个）。 */
	const pickClient = instanceId => {
		const entries = [...clients.entries()];
		if (instanceId) {
			const hit = entries.find(([, info]) => info.instanceId === instanceId);
			return hit?.[0];
		}
		return entries[0]?.[0];
	};

	/**
	 * Host → IDE 的一次调用（反向通道）。
	 * 没有客户端 / 超时都**明确报错**（不静默、不假装成功）——IDE 侧尚未实现请求分发时，
	 * 表现就是这里超时，错误信息直接指向原因。
	 */
	function callIDE(method, params = {}, { timeoutMs = 10_000, instanceId } = {}) {
		const socket = pickClient(instanceId);
		if (!socket) {
			return Promise.reject(new Error('控制桥没有已注册的 IDE 客户端：反向调用需要至少一个 `client.register` 过的客户端'));
		}
		const id = -(++outboundSeq);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				outbound.delete(id);
				reject(new Error(`控制桥反向调用超时（${timeoutMs}ms）：${method}（IDE 侧是否实现了请求分发？）`));
			}, timeoutMs);
			outbound.set(id, { resolve, reject, timer });
			socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { token, ...params } }) + '\n');
		});
	}

	/**
	 * 调用方的**权威身份**：加载器那一行的 `name`（= 安装的包名，与 IDE 侧 `listPlugins()` 查的是同一个口径）。
	 *
	 * 依据（`@deepseek-ai/cordis-plugin-loader`）：`this.options.name` 是行里的 specifier（包名），
	 * 而 `fiber.entry` 只在 loader 托管的纤维上存在（`Loader.locate()` 就是靠它）。
	 * 拿不到（内部闭包调用 / 非 loader 环境）⇒ `undefined`，此时**保持原来的自报行为**。
	 */
	function callerIdentityOf(service) {
		return service?.ctx?.fiber?.entry?.options?.name ?? undefined;
	}

	/**
	 * 给 `ide.request` **盖上调用方身份**（把"自报"换成"桥盖章"）。
	 *
	 * 为什么要有这一步：`pluginId` 原本由**调用方自报**，而任何能拿到 `ctx.vssarosBridge` 的插件都能
	 * 自称 `@vssaros/dsh-ide` 去要它那 10 个能力 —— 逐插件授权因此是"声明式"而不是"证明式"。
	 * cordis 能给出真实身份（见 `bridgeService` 上的 tracker 注释），所以：
	 *  - 拿到权威身份 ⇒ **以它为准**；自报值与之不符 ⇒ **直接拒绝**（不是"忽略"：不符只可能是写错或冒名，
	 *    静默放过会让"按清单逐项授权"变成一句空话）；
	 *  - 拿不到 ⇒ 原样透传（IDE 侧自检 `ide.probe` 是**桥自己**发起的，没有调用方 ctx）。
	 */
	function stampCallerIdentity(service, method, params) {
		if (method !== 'ide.request' || !params || typeof params !== 'object') {
			return params;
		}
		const actual = callerIdentityOf(service);
		if (actual === undefined) {
			return params;
		}
		const claimed = params.pluginId;
		if (typeof claimed === 'string' && claimed !== actual) {
			throw new Error(`控制桥：调用方自报 pluginId=${claimed}，实际是 ${actual} —— 拒绝（身份必须与已安装插件一致）`);
		}
		return { ...params, pluginId: actual };
	}

	// 兄弟插件（如 @vssaros/dsh-ide）经 `inject: ['vssarosBridge']` 取用出站原语。
	// **必须 `ctx.provide`**（不是 `ctx.set`）：Cordis 4 里 `set` 只能改**已 provide** 的服务，
	// 在未 provide 的名字上 set 会抛 `cannot set property "vssarosBridge" without provide`（实测踩过）。
	//
	// ⚠️ `callIDE` **刻意写成方法**（用 `this`）并给服务挂上 cordis 的 tracker：cordis 的
	// `getTraceable()` / `createTraceable()` 会把服务按**访问者的 ctx** 包装，方法调用时 `this` 被重绑到
	// "访问方 ctx 的 shadow" ⇒ **方法里 `this.ctx` 就是调用方 ctx**（`Service` 基类挂的就是同一个符号
	// `Symbol.for('cordis.tracker')`，所以这是 cordis 里写服务的标准姿势，不是私有 hack）。
	// 探针：`poc/dsh-p0/scripts/cordis-caller-probe.mjs`（跑一遍就能看到"自报假名字、实际拿到真身份"）。
	const bridgeService = {
		version: BRIDGE_VERSION,
		callIDE(method, params, options) {
			return callIDE(method, stampCallerIdentity(this, method, params), options);
		},
		clientCount: () => clients.size,
		instances: () => [...clients.values()].map(info => info.instanceId),
	};
	Object.defineProperty(bridgeService, Symbol.for('cordis.tracker'), {
		value: { property: 'ctx', noShadow: true },
		enumerable: false,
	});
	ctx.provide('vssarosBridge', bridgeService);
	// CodeBuddy 路由的 baseURL 走 IDE 主进程的**计费代理**（积分 chip 的数据源，见 IDE 侧 dshCreditProxy.ts）：
	// 反向方法 `credit.route` 让主进程登记"路由 → 真实网关"并回代理地址。代理端口固定 + secret 落盘 ⇒
	// 跨重启地址不变 ⇒ profile 不会因此反复重写 ✓。
	//   · 没有 IDE 客户端时沿用**上一次拿到的代理地址**（IDE 一断就改回直连 ⇒ 每次进出都重写 profile ✗）；
	//   · 从没拿到过 / 老 IDE 不认这个方法 ⇒ 直连（宁可这一轮没有积分，也不能让模型接入断掉）✓。
	let lastProxiedCodeBuddyURL;
	codebuddy.setBaseURLResolver(async real => {
		if (clients.size === 0) {
			return lastProxiedCodeBuddyURL ?? real;
		}
		try {
			const r = await callIDE('credit.route', { route: CODEBUDDY_ROUTE, baseURL: real }, { timeoutMs: 5_000 });
			if (typeof r?.baseURL === 'string' && r.baseURL) {
				lastProxiedCodeBuddyURL = r.baseURL;
				return r.baseURL;
			}
		} catch (e) {
			console.log(`[vssaros-bridge] credit.route 不可用（按直连写 CodeBuddy 路由，本轮积分不可见）：${String(e?.message ?? e).slice(0, 160)}`);
		}
		return lastProxiedCodeBuddyURL ?? real;
	});
	// 企业身份变化 ⇒ 通知**每个**已注册的 IDE（2026-10-22）：反向方法 `tof.changed`，主进程就地转给渲染进程，
	// 渲染进程的 TofAuthService 立刻经 `tof.status` / `tof.ticket` 重读（通知里**不带票据**）✓。
	// 老 IDE 不认这个方法 ⇒ 反向调用被拒 ⇒ 吞掉（它们本来就不靠这条路）✓。
	notifyTofChanged = why => {
		for (const info of clients.values()) {
			callIDE('tof.changed', { reason: String(why ?? '') }, { timeoutMs: 5_000, instanceId: info.instanceId }).catch(() => undefined);
		}
	};
	reverseReady = true;
	const hello = () => {
		const origin = `http://127.0.0.1:${ctx.webServer.port}`;
		return {
			bridgeVersion: BRIDGE_VERSION,
			pluginVersion,
			node: process.version,
			pid: process.pid,
			host: { port: ctx.webServer.port, bind: ctx.webServer.host, origin, authUrl: ctx.connection.authenticatedUrl(origin + '/') },
		};
	};

	/**
	 * `ChangeResult` → 过桥视图（方案 5.16 批次 3/4 共用）。安装面比启停多带 pnpm 诊断：
	 * `packageResult` 里的退出码/失败类别/超时与诊断落盘路径——失败时界面要给"日志在哪"。
	 */
	const shapeChange = (res, fallbackTarget, extra) => ({
		changed: !!res?.changed,
		application: res?.application ?? null,
		stage: res?.stage ?? null,
		target: res?.target ?? fallbackTarget,
		...(res?.error?.code ? { error: res.error.code } : {}),
		// dsh 的失败分两类：**预期拒绝**给码（`management-required` / `unknown-plugin` …），**非预期异常**
		// 给 `operation-error` **外加一条 `diagnostic`（原始错误信息）**。只转码不转诊断 ⇒ 界面上只剩
		// "操作失败"，看不出为什么、也看不出该查哪儿（README 4.51 就是被这条卡住的）。截断保留前 400 字符。
		...(res?.error?.diagnostic ? { diagnostic: String(res.error.diagnostic).slice(0, 400) } : {}),
		...(res?.warnings?.length ? { warnings: res.warnings.slice(0, 8).map(w => String(w).slice(0, 200)) } : {}),
		...(res?.bundle ? { bundle: String(res.bundle) } : {}),
		...(res?.packageResult ? {
			exitCode: res.packageResult.exitCode ?? null,
			...(res.packageResult.kind ? { failureKind: String(res.packageResult.kind) } : {}),
			...(res.packageResult.timedOut ? { timedOut: true } : {}),
			...(res.packageResult.logPath ? { logPath: String(res.packageResult.logPath) } : {}),
		} : {}),
		...(res?.pendingBuilds?.length ? { pendingBuilds: res.pendingBuilds.slice(0, 32).map(String) } : {}),
		...(res?.registries?.length ? { registries: res.registries.slice(0, 8).map(r => r ?? null) } : {}),
		...(extra?.requestId ? { requestId: extra.requestId } : {}),
	});

	const server = net.createServer(socket => {
		let buf = '';
		let registered = null;
		const send = msg => socket.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
		socket.on('data', chunk => {
			buf += chunk;
			let nl;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				let req;
				try {
					req = JSON.parse(line);
				} catch {
					send({ id: null, error: { code: -32700, message: 'parse error' } });
					continue;
				}
				// 反向调用的**响应**先于一切处理：它是 `{ id: <负数>, result|error }`（没有 method），
				// 不是请求，绝不能掉进下面的 method 分发（否则会被回一句 method not found）。
				if (req.method === undefined && typeof req.id === 'number' && req.id < 0 && outbound.has(req.id)) {
					const entry = outbound.get(req.id);
					outbound.delete(req.id);
					clearTimeout(entry.timer);
					if (req.error) {
						entry.reject(new Error(`IDE 侧拒绝反向调用（code ${req.error.code ?? '?'}）：${req.error.message ?? ''}`));
					} else {
						entry.resolve(req.result);
					}
					continue;
				}
				if (!registered && req.method !== 'client.register') {
					send({ id: req.id ?? null, error: { code: -32001, message: 'not registered' } });
					continue;
				}
				switch (req.method) {
					case 'client.register': {
						if (req.params?.token !== token) {
							send({ id: req.id, error: { code: -32002, message: 'bad token' } });
							socket.end();
							break;
						}
						registered = { instanceId: String(req.params.instanceId ?? 'unknown'), windows: req.params.windows ?? [] };
						clients.set(socket, registered);
						// 看门狗目标随每次注册更新（见上方"拥有者失联自退"的注释）：**只在给了路径时才替换** ✗
						// —— 接管/Host 不由 VsSaros 托管时是不给路径的，那时把已有目标清掉就等于看门狗静默失效 ✗。
						if (typeof req.params.ownerRecord === 'string' && req.params.ownerRecord) {
						if (ownerRecordPath !== req.params.ownerRecord) {
							console.log(`[vssaros-bridge] owner watchdog → ${req.params.ownerRecord}`);
						}
						ownerRecordPath = req.params.ownerRecord;
					}
						noteClients();
						send({ id: req.id, result: hello() });
						// 有 IDE 客户端了 ⇒ 可以拿计费代理地址 ⇒ 立刻同步一次 CodeBuddy 路由（也顺带在主进程登记代理路由：
						// 主进程的路由表只在内存里，App 重启后不登记一次，走代理的请求会 502 ✗）。
						void codebuddy.syncRoute('client-register').catch(() => undefined);
						break;
					}
					case 'host.ping':
						// `instances` 让调用方**定点**反向调用（多个客户端时 `pickClient()` 取"最先注册"的那个，
						// 而 VsSaros 的客户端注册时机不由调用方决定 ⇒ 需要能指定目标；真机 e2e 踩过）。
						send({ id: req.id, result: { ok: true, clients: clients.size, instances: [...clients.values()].map(info => info.instanceId) } });
						break;
					case 'approval.request': {
						// 客户端→Host：**要一次用户确认**。交给 Host 的审批服务（`ctx.get('approval')`）——与 dsh 侧
						// 能力用的是**同一张**客户端 UI 卡（`dsh-client-ui-approval`）⇒ 让**留在 IDE 侧**的动作类能力
						// （目前只有 canvas）不再各自弹通知，而与 dsh 侧统一到"聊天内 ask"（README 4.76 / 4.83）。
						// ⚠ **fail-closed**：拿不到审批服务就回 `allowed:false`（不猜、不静默放行）。
						const approval = (() => { try { return ctx.get?.('approval'); } catch { return undefined; } })();
						if (!approval || typeof approval.request !== 'function') {
							send({ id: req.id, result: { allowed: false, reason: 'no-approval-channel' } });
							break;
						}
						const consentArgs = req.params ?? {};
						Promise.resolve(approval.request({
							toolName: typeof consentArgs.toolName === 'string' && consentArgs.toolName ? consentArgs.toolName : 'ide',
							reason: typeof consentArgs.reason === 'string' && consentArgs.reason ? consentArgs.reason : 'IDE 侧能力请求执行有副作用的操作',
							...(consentArgs.displayReason === undefined ? {} : { displayReason: consentArgs.displayReason }),
						})).then(
							outcome => send({ id: req.id, result: { allowed: outcome === 'allowed-once', outcome: String(outcome) } }),
							error => send({ id: req.id, result: { allowed: false, reason: `approval-error: ${String(error?.message ?? error)}` } }),
						);
						break;
					}
					case 'ide.probe': {
						// `ide.request` 的**自检**：IDE 调它 → 桥反向 `ide.request` 指定能力 → 返回结果或拒绝原因。
						// 用途：`@vssaros/dsh-ide` 模块还没做时也能验收"授权 + 执行"整条链；
						// 模块做好后它仍是"这条链还通不通"的健康检查（IDE 侧只做一次数据往返，不改状态）。
						const timeoutMs = Number.isFinite(req.params?.timeoutMs) ? req.params.timeoutMs : 8000;
						callIDE('ide.request', {
							capability: req.params?.capability,
							...(req.params?.pluginId === undefined ? {} : { pluginId: req.params.pluginId }),
							...(req.params?.params === undefined ? {} : { params: req.params.params }),
						}, { timeoutMs, ...(req.params?.instanceId === undefined ? {} : { instanceId: req.params.instanceId }) }).then(
							result => send({ id: req.id, result }),
							e => send({ id: req.id, result: { ok: false, error: String(e?.message ?? e) } }),
						);
						break;
					}
					case 'ide.roundtrip': {
						// 反向通道**自检**：IDE 调本方法 → Host 反向调 `ide.echo` → 把结果回给 IDE。
						// 用途：IDE 侧实现请求分发后，一条命令就能验收"反向通道真的通"（不必等具体能力工具）。
						const timeoutMs = Number.isFinite(req.params?.timeoutMs) ? req.params.timeoutMs : 5000;
						callIDE('ide.echo', { at: Date.now() }, { timeoutMs }).then(
							// 成功时把 IDE 的返回**原样**透传（将来 `ide.request` 的结果也要这样，不套一层）
							result => send({ id: req.id, result }),
							e => send({ id: req.id, result: { ok: false, error: String(e?.message ?? e) } }),
						);
						break;
					}
					case 'workspace.ensure':
					case 'workspace.list': {
						const reg = ctx.workspaceRegistry;
						if (!reg) {
							send({ id: req.id, error: { code: -32003, message: 'workspaceRegistry unavailable' } });
							break;
						}
						const view = w => ({ id: w.id, path: w.path, title: w.title, sessions: (w.sessionIds ?? []).length });
						const run = req.method === 'workspace.list'
							? Promise.resolve(reg.list().map(view))
							: Promise.all((req.params?.paths ?? []).map(p => reg.create(p).then(view, e => ({ path: p, error: String(e?.message ?? e) }))));
						run.then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
						break;
					}
					case 'workspace.context': {
						// 运行期**工作区上下文**（2026-10-17）：IDE 切工作区时推一份新的 ⇒ 看板 / 记忆 / 图谱
						// 这些消费插件**不必重启 Host** 就能跟着走 ✓（真源与三条纪律见
						// `@vssaros/dsh-foundation/lib/workspaceContext.js`；起因：切工作区重启会杀掉在跑的会话）。
						//
						// ⚠ `applied` **必须如实**：IDE 拿它决定"还要不要退回旧的重启路径" ✓。两条自证：
						//   · 本 case 之前装着的桥（没有这段）会落到 `default` 的 -32601 ⇒ IDE 侧 `bridge.call`
						//     直接抛 ⇒ 它按"老 Host"处理、退回重启 ✓（升级那一次仍然要重启，之后就再也不用了 ✓）；
						//   · foundation 缺席 / 载荷畸形 ⇒ 回 `applied:false` + 原因，**不谎报成功** ✓
						//     （谎报会让"切了工作区但没生效"变成静默错 ✗）。
						const foundation = (() => {
							try { return ctx.reflect?.get?.('vssarosFoundation', false); } catch { return undefined; }
						})();
						if (!foundation || typeof foundation.setWorkspaceContext !== 'function') {
							send({ id: req.id, result: { applied: false, reason: 'foundation-unavailable' } });
							break;
						}
						const applied = foundation.setWorkspaceContext(req.params ?? {});
						if (!applied) {
							send({ id: req.id, result: { applied: false, reason: 'invalid-payload' } });
							break;
						}
						// 每次切换留一行：这是"工作区上下文到底跟着走了没有"唯一的现场证据 ✓
						console.log(`[vssaros-bridge] workspace context applied: workspaceId=${applied.workspaceId ?? '(none)'} root=${applied.workspaceRoot ?? '(none)'} related=${applied.relatedRoots.length}`);
						send({ id: req.id, result: { applied: true, context: applied } });
						break;
					}
					case 'session.start': {
						// Plan §7: VsSaros starts a Session (chat tab binding / background entries)
						// without going through the IDE's own chat service. Uses dsh's official
						// session controller: create-or-idempotently-adopt by sessionId, then prompt.
						const { cwd, sessionId, agentPreset, prompt } = req.params ?? {};
						const run = async () => {
							if (!cwd || typeof cwd !== 'string') {
								throw new Error('session.start: cwd required');
							}
							const reg = ctx.workspaceRegistry;
							const workspace = reg ? await reg.create(cwd) : undefined;
							// 竞态根治（2026-10-13 用户报"聊天框消失"）：IDE 侧 `bind(session.start)` 与 `createView` **并行**，
							// 而 createView 加载的页面自己也在开**同一个**派生会话 ⇒ 后到的一方撞上同进程 `writers` 里的**在途
							// claim**（`dsh-session-persistence-jsonl` 的 `claimWrite` 抛 `SessionAlreadyOwnedError: already owned
							// by an active write handle`）。dsh 的 `create` 对**已活跃**会话本是"领养"语义 ⇒ 等那个在途句柄
							// 物化完，再 create 就会领养成功。⇒ 遇"already owned"**有界重试领养**，而不是一次失败就放弃
							// （此前 IDE 侧 warn 一句返回 undefined ⇒ 聊天绑不上会话 ⇒ 空白/消失）。
							// ⚠ 只重试"在途竞态"（in-process writers 撞）；**真·跨进程**的 flock 占用（另一个 Host 拿着）
							//   报的是锁错误、不含 'already owned' ⇒ 不会被这条吞掉，仍会抛出 ✓。
							let created;
							// ★★ 2026-10-20（今天 Host 铸了 53 条空会话；其中 3 条紧跟在 IDE 的 bind 之后 3~93ms）：
							//   dsh 的 `create({ sessionId })` **不是**"幂等接管"——源码（dsh-api-session-controller `claim()`）：
							//     · 该会话 agent 已在运行（live）且**不是空会话** ⇒ `reuseLive` 返回 undefined ⇒ `createMinted`
							//       ⇒ 另铸一条 `session-<uuid>` 空会话 ✗（真机三次都发生在"复用已有 Host"时，正是 live 的情形）
							//   ⇒ live **且非空**时直接接管同一个 agent，不再调 create（目录不一致仍交给 create 报冲突，行为不变）。
							//   live 但**空**的会话照旧走 create：Host 会按请求的 preset 重新选择（reuseLive 的语义，不能丢）。
							//   判空用 Host 自己的判据（`isBlank`：turnBoundary 投影 `openTurnStartSeq===null && lastTurn===0`）；
							//   取不到投影服务 ⇒ 视为"不确定"⇒ 走 create（退回原行为）。
							//   不 live 的情形也维持原样（create 会 resume；真机 7 次冷启 bind 都没有铸新）。
							const live = sessionId && ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(sessionId) : undefined;
							const targetCwd = workspace?.path ?? cwd;
							const sameDir = (a, b) => typeof a === 'string' && typeof b === 'string'
								&& (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
							const liveHasTurns = (() => {
								try {
									const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined;
									const boundary = projections && live ? projections.stateOf(live.session, 'turnBoundary') : undefined;
									if (!boundary) { return false; }
									return !(boundary.openTurnStartSeq === null && boundary.lastTurn === 0);
								} catch { return false; }
							})();
							if (live && liveHasTurns && sameDir(live.session?.header?.cwd, targetCwd)) {
								let preset = null;
								try {
									const projections = ctx.get('sessionProjections');
									preset = projections ? (projections.stateOf(live.session, 'agentPreset') ?? null) : null;
								} catch { preset = null; }
								created = { sessionId, agentPreset: preset, adoptedLive: true };
							}
							for (let attempt = 0; !created; attempt++) {
								try {
									created = await ctx.sessionController.create({ cwd: targetCwd, sessionId, agentPreset });
									break;
								} catch (e) {
									const msg = String(e?.message ?? e);
									const inFlightRace = msg.includes('already owned') || msg.includes('writer-held') || (e && e.name === 'SessionAlreadyOwnedError');
									if (!inFlightRace || attempt >= 6) {
										throw e;
									}
									await new Promise(r => setTimeout(r, 120 * (attempt + 1))); // 120/240/…/720ms，等在途 claim 物化
								}
							}
							const id = created?.sessionId ?? sessionId;
							// 万一 Host 仍返回了别的 id（另铸），留一行日志：这正是"空会话越积越多"的来源，不能静默。
							if (sessionId && id !== sessionId) {
								console.warn(`[vssaros-bridge] session.start: 请求 ${sessionId} 但 Host 返回 ${id}（另建了新会话）`);
							}
							// dsh-webhook attaches explicitly; only do it when not already attached.
							if (workspace && id && !(workspace.sessionIds ?? []).includes(id)) {
								await workspace.attachSession(id);
							}
							let prompted = false;
							if (prompt && id) {
								// ⚠ dsh 的 `prompt(request, signal)` **要求第二个参数**：它第一句就是
								// `signal.throwIfAborted()` ⇒ 不传会抛 `Cannot read properties of undefined
								// (reading 'throwIfAborted')`（TypeError，且错误消息完全看不出缺了 signal）。
								//
								// 2026-10-11 实测（探针 `p3-20`，带堆栈定位到
								// `dsh-api-session-controller/lib/index.js:3097` 的 facade `prompt`）：
								// **带 prompt 的 `session.start` 必坏**，而不带 prompt 的形态正常——而仓库既有测试
								// （`channelProbe.ts`）只覆盖了不带 prompt 的 `{cwd, sessionId}` ⇒ 这条路径此前**无覆盖**，
								// 也就是说 App 的"建会话并投递首条消息"一直是坏的。
								//
								// 语义（dsh 注释原文）：signal 只用于"**投递开始之前**的调用方取消"，不绑定回合生命周期
								// ⇒ 这里给一个不会主动中止的 controller（真正的取消由上游 RPC 超时负责）。
								await ctx.sessionController.prompt({
									requestId: `vssaros-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
									sessionId: id,
									mode: 'queue',
									content: [{ type: 'text', text: String(prompt) }],
								}, new AbortController().signal);
								prompted = true;
							}
							// agentPreset 回传（方案 5.15）：VsSaros 据此习得基座会话实际运行的 preset，
						// "切回基座 preset"才能解析回无后缀会话 id（幂等接管保住原历史）。
						return { sessionId: id, workspaceId: workspace?.id, prompted, agentPreset: created?.agentPreset ?? null };
						};
						run().then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
						break;
					}
					case 'session.run': {
						// 重构 1.4：后台回合的统一入口（渠道/看板/工作流/调度/Pocket 都走它）。
						// 与 session.start 的区别：start 只投递（聊天框自己看事件流）；run 等回合跑完并回传结果。
						const p = req.params ?? {};
						runs.run(p)
							.then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
						break;
					}
					case 'session.cancel': {
						const p = req.params ?? {};
						runs.cancel(p)
							.then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
						break;
					}
					case 'tof.sync': {
					// 企业身份（TOF/OA 票据）落到 dsh 侧（2026-10-21）。
					//
					// 需求：用户不要 dsh 官方 DeepSeek 路由那一套账号；要在**两侧**用同一份企业身份
					//   （工号 + 票据）⇒ IDE 侧登录一次，把票据同步过来，dsh 侧自己持有 ✓。
					// ⚠ 为什么登录不在 dsh 侧自己做：TOF 的 OAuth 是 passport.woa.com → 网关
					//   `/api/v1/auth/tof/callback?cb_port=` → 本地 loopback（协议由**网关**定），
					//   而 dsh **没有**"打开外部 URL"的服务（无 openExternal/openUrl）⇒ 开浏览器得靠 IDE 侧
					//   那个现成的扩展开浏览器（extensions/tof-authentication）⇒ 一次登录、两处可用 ✓。
					// ⚠ **安全边界**：票据从 VS Code 的 SecretStorage（加密）落到 dsh 的 .credentials.yaml
					//   （**明文**！dsh-credentials-local 自述："同 UID 的 agent 工具进程能读到这个文件"）。
					//   这是**扩大了暴露面** —— 所以：① 票据绝不下发页面（页面只拿展示投影）；
					//   ② 票据只经本机命名管道过，不出网；③ 落到 credentials 的**正式落点**（不是 settings）。
					// ⚠ 幂等：同值不重写（`describe` 只回 presence，不回值 ⇒ 只能靠"有没有"判有无变化，
					//   真正相等与否交给 credentials.set 自身处理）。
					const p = req.params ?? {};
					const run = async () => {
						const { credentials } = ctx;
						if (!credentials) {
							throw new Error('tof.sync: credentials service unavailable');
						}
						const ref = TOF_CREDENTIAL_REF;
						const ticket = typeof p.ticket === 'string' ? p.ticket : null;
						if (ticket === null) {
							// 登出：清掉 dsh 侧那份（`unset` 缺席时是 no-op ⇒ 幂等 ✓）
							const before = await credentials.describe(ref);
							await credentials.unset(ref);
							tofService.invalidate();
							return { signedIn: false, ref, changed: before.configured === true };
						}
						await credentials.set(ref, ticket);
						tofService.invalidate();
						return { signedIn: true, ref, changed: true };
					};
					const p0 = req.params ?? {};
					// 2026-10-22：用户在 dsh 侧**主动登出**过 ⇒ 拒收 IDE 推来的票（IDE 刚启动、还没认出"dsh 持有身份"时，
					//   会按老路把旧扩展里的票推过来 ⇒ 不拦就"登出不掉" ✗）。用户在 dsh 侧再登录才撤标记 ✓。
					const guarded = async () => {
						if (typeof p0.ticket === 'string' && (await tofService.status()).signedOutByUser === true) {
							return { signedIn: false, ref: TOF_CREDENTIAL_REF, changed: false, ignored: 'signed-out-by-user' };
						}
						return run();
					};
					guarded().then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
					break;
				}
				// ── 企业身份由 dsh 侧持有（2026-10-22，用户："登录也转移到 dsh 侧实现，ide 侧仅读取状态"）──────────
				// IDE 的 TofAuthService 在 Host 认这几条方法时**只读** dsh 的状态；IDE 里的 9 个登录入口都经它交给这里登录。
				case 'tof.status': {
					// 状态投影（**没有票据**）；`fresh` ⇒ 跳过 60s 缓存重查网关
					const p = req.params ?? {};
					tofService.status({ fresh: p.fresh === true }).then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
					break;
				}
				case 'tof.signin': {
					// 开系统浏览器登录（最长 ~3 分钟）——回执等登录完成才发；并发与页面 HTTP 登录共用同一次 ✓
					tofService.signIn().then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
					break;
				}
				case 'tof.signout': {
					// IDE 的「退出登录」= 用户主动登出 ⇒ 两份票都清 + 记标记（IDE 不再把旧扩展里的票迁回来）✓
					tofService.signOut({ all: true, byUser: true }).then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
					break;
				}
				case 'tof.ticket': {
					// 给 IDE 取票（商城 JWT 兑换要它）。⚠ 票据只经本机命名管道到 IDE 主进程，**绝不**进页面 / 工具回执 ✓
					tofService.ticket().then(r => send({ id: req.id, result: { ticket: r.ticket ?? null, source: r.source } }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
					break;
				}
				case 'codebuddy.status': {
					// IDE → Host：查 dsh 侧 CodeBuddy 登录态（**不含 token**）。IDE 用它决定要不要做一次性迁移。
					codebuddy.status().then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
					break;
				}
				case 'codebuddy.import': {
					// IDE → Host：把 IDE 扩展里的 CodeBuddy 登录态**一次性**迁过来（过渡期；dsh 侧已登录时不覆盖）。
					// token 只经本机命名管道、落 dsh 凭据存储；回执只有状态投影 ✓。
					const p = req.params ?? {};
					codebuddy.importSession({ accessToken: p.accessToken, refreshToken: p.refreshToken, expiresAt: p.expiresAt })
						.then(async r => send({ id: req.id, result: { ...r, status: await codebuddy.status() } }),
							e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
					break;
				}
				case 'lightai.status': {
					// IDE → Host：dsh 侧 LightAI 登录态（**无 cookie 值**）。IDE 用它判断要不要做一次性迁移（2026-10-22）。
					lightai.status().then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
					break;
				}
				case 'lightai.import': {
					// IDE → Host：把 IDE 扩展 settings 里的 LightAI cookie **一次性**迁过来（dsh 侧已登录 / 用户主动登出过 ⇒ 不导）。
					// cookie 只经本机命名管道、落 dsh 凭据存储；回执只有"导没导"✓。
					const p = req.params ?? {};
					lightai.importSession({ cookie: p.cookie, userId: p.userId })
						.then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
					break;
				}
				case 'credit.record': {
						// 积分样本入账（2026-10-20）：主进程计费代理抓到一条推一条。只有 route/model/credit/at
						// 这几个数值字段过管道 —— 不含请求/响应内容。归属与写记录见 credit.js / 上面的账本接线。
						try {
							send({ id: req.id, result: creditLedger.recordSample(req.params ?? {}) });
						} catch (e) {
							send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } });
						}
						break;
					}
					case 'host.activity': {
						// Upgrade / exit gate (plan §3.3 `host.hasRunningWork`). Asks the same
						// `workspace/session-activity` waterfall dsh uses for archive admission, so every
						// provider (turn, job, subagent, schedule) answers for its own family.
						// Only session ids and family keys cross the pipe — no session content.
						const ids = ctx.agents.list().map(a => a.id);
						Promise.all(ids.map(sessionId => ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
							.then(acts => ({ sessionId, kinds: acts.map(a => String(a.kind)) }), () => ({ sessionId, kinds: ['unknown'] }))))
							.then(list => send({ id: req.id, result: { live: ids.length, sessions: list.filter(s => s.kinds.length) } }),
								e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
						break;
					}
					case 'providers.sync': {
						// 模型 provider 接入（dsh 插件形式）：VsSaros 把已配置的 provider（codebuddy /
						// lightai / openrouter / 自定义 BYOK）写成 llm-pi-ai 的 settings profile ——
						// 休眠的 pi-ai 适配器监听配置变化，路由在线注册，模型进聊天框选择器。
						// 我们只管理 vssaros- 前缀的路由与 VSSAROS_ 前缀的凭证，用户自加条目不动。
						const run = async () => {
							const { settings, credentials, llm } = ctx;
							if (!settings || !credentials) {
								throw new Error('providers.sync: settings/credentials service unavailable');
							}
							// 分段计时（2026-10-15，"首启后模型清单晚 ~17s"排查）：IDE 侧实测 collect=300ms、
							// 耗时全在这一条桥调用里 ⇒ 必须知道是凭证/改写/默认模型/模型清点中的哪一步。
							const tSync = Date.now();
							const step = {};
							const params = req.params ?? {};
							const credList = Array.isArray(params.credentials) ? params.credentials : [];
							const entries = Array.isArray(params.providers) ? params.providers : [];
							// 凭证先就位（profile 的 apiKeyEnv 按请求解析引用——先写凭证再挂路由）。
							// ⚠ dsh 侧自持路由用到的凭据**不覆盖**（dsh 刚刷新过的 token 会被 IDE 手里的旧值盖掉 ✗）。
							const ownedRefs = new Set(entries.filter(p => p && DSH_OWNED_ROUTES.has(p.route) && p.credentialRef).map(p => p.credentialRef));
							for (const c of credList) {
								if (c && typeof c.ref === 'string' && typeof c.value === 'string' && !ownedRefs.has(c.ref)) {
									await credentials.set(c.ref, c.value);
								}
							}
							step.credMs = Date.now() - tSync;
							const tDescribe = Date.now();
							const desc = settings.describe().find(d => d.ns === 'llm-pi-ai');
							if (!desc) {
								throw new Error('providers.sync: llm-pi-ai settings namespace missing (dsh-llm-pi-ai not mounted?)');
							}
							step.describeMs = Date.now() - tDescribe;
							const current = (desc.value && typeof desc.value === 'object' ? desc.value.providers : undefined) ?? {};
							// ★ 2026-10-22：**dsh 侧自持**的路由（`DSH_OWNED_ROUTES`，目前是 CodeBuddy）一律不碰 ——
							//   负载里带了也忽略（IDE 旧版/过渡期仍可能发）、它的凭据也不覆盖（dsh 侧刷新过的 token 会被旧值盖掉 ✗）。
							const ownedSkipped = entries.filter(p => p && DSH_OWNED_ROUTES.has(p.route)).map(p => p.route);
							if (ownedSkipped.length > 0) {
								console.log(`[vssaros-bridge] providers.sync: 忽略 dsh 侧自持路由 ${ownedSkipped.join(', ')}（由 Host 自己登录/维护）`);
							}
							const ours = {};
							const reasoningNotes = [];
							for (const p of entries) {
								if (!p || DSH_OWNED_ROUTES.has(p.route)) { continue; }
								// 画像构造与比对见 ./providerProfile.js（与 dsh 侧自持 provider 共用一份 ⇒ 两边写出的画像同形）。
								ours[p.route] = buildRouteProfile(p);
								const routeReasoning = ours[p.route].reasoning;
								const total = (p.models ?? []).length;
								const reasoned = (p.models ?? []).filter(m => m && m.reasoning === true).length;
								reasoningNotes.push(routeReasoning
									? `${p.route}=${routeReasoning}`
									: `${p.route}=跳过(${reasoned}/${total} 支持推理)`);
							}
							if (reasoningNotes.length > 0) {
								// 进 Host 日志：一眼看清默认档位写了没、为什么没写。**值没变就不重复打**（见 `lastRouteReasoningLog`）。
								const line = reasoningNotes.join(' ');
								if (line !== lastRouteReasoningLog) {
									lastRouteReasoningLog = line;
									console.log(`[vssaros-bridge] route reasoning default: ${line}`);
								}
							}
							// 幂等：语义比对（`sameProfile`，见 ./providerProfile.js）。只比我们管理的字段；残留 vssaros- 路由也算变化
							// —— 但 **dsh 侧自持路由不算残留**（它本来就不在负载里）✓。
							const stale = Object.keys(current).filter(k => k.startsWith('vssaros-') && !ours[k] && !DSH_OWNED_ROUTES.has(k));
							const diffNotes = stale.map(k => `${k}:stale`);
							for (const k of Object.keys(ours)) {
								const why = [];
								if (!sameProfile(ours[k], current[k], why)) {
									diffNotes.push(`${k}:${why.join('+') || '?'}`);
								}
							}
							// ★「写不进去的路由别再写」：只统计 `:stale` / `:route-absent` 这类**残留**差异
							//   （它不是我们负载里的字段，写进去也可能被宿主再次丢弃 ⇒ 会无限来回）。
							const stuckNotes = diffNotes.filter(n => /:(stale|route-absent)$/.test(n));
							const otherNotes = diffNotes.filter(n => !/:(stale|route-absent)$/.test(n));
							let skipStuck = false;
							if (stuckNotes.length > 0) {
								const stuckRoutes = stuckNotes.map(n => n.split(':')[0]);
								if (otherNotes.length === 0) {
									const tried = stuckRoutes.map(r => routeWriteStreak.get(r) || 0);
									skipStuck = tried.every(n => n >= ROUTE_WRITE_STREAK_LIMIT);
								}
								stuckRoutes.forEach(r => routeWriteStreak.set(r, (routeWriteStreak.get(r) || 0) + 1));
							}
							// 本轮没有差异的路由 ⇒ 说明上次写成功了 ⇒ 计数清零（避免永久拉黑）
							try {
								for (const [r, n] of routeWriteStreak) {
									if (!stuckNotes.some(x => x.startsWith(r + ':'))) { routeWriteStreak.delete(r); }
								}
							} catch { /* ignore */ }
							if (skipStuck) {
								console.log('[vssaros-bridge] providers.sync: 跳过反复写不进去的路由（' + stuckNotes.join(', ')
									+ '），避免每轮 2s 的设置写入拖慢整个 Host');
							}
							const changed = diffNotes.length > 0 && !skipStuck;
							const tMutate = Date.now();
							if (changed) {
								const merged = {};
								for (const [k, v] of Object.entries(current)) {
									// 非 vssaros- 条目（用户自加）原样保留；**dsh 侧自持路由也原样保留**（不在负载里 ≠ 该删）✓
									if (!k.startsWith('vssaros-') || DSH_OWNED_ROUTES.has(k)) {
										merged[k] = v;
									}
								}
								for (const k of Object.keys(ours)) {
									merged[k] = ours[k];
								}
								try {
									await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers'], value: merged }], desc.revision);
								} catch (e) {
									// 设置页并发编辑 → 重读 revision 重试一次。
									if (String(e?.code ?? e?.message ?? e).includes('SETTINGS_CONFLICT')) {
										const d2 = settings.describe().find(d => d.ns === 'llm-pi-ai');
										await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers'], value: merged }], d2?.revision);
									} else {
										throw e;
									}
								}
							}
							step.mutateMs = Date.now() - tMutate;
							const tDefault = Date.now();
							// ─── 默认模型对齐（规则见 apply() 开头的 `alignDefaultModel`，2026-10-22 抽出共用）────
							// 候选 = 本次负载的路由 + **仍在 profile 里的 dsh 侧自持路由**（CodeBuddy 不在负载里，
							// 但它仍是首选 ⇒ 不并进来的话默认模型会落到别的路由上 ✗）。
							const candidates = {};
							for (const k of Object.keys(current)) {
								if (DSH_OWNED_ROUTES.has(k) && current[k] && typeof current[k] === 'object') {
									candidates[k] = current[k];
								}
							}
							Object.assign(candidates, ours);
							const defaultModelNote = await alignDefaultModel(candidates);
							if (defaultModelNote) {
								// 进 Host 日志（supervisor 会把它收进 dsh 日志面板）：重启后一眼能看到默认值有没有被改。
								console.log(`[vssaros-bridge] default model: ${defaultModelNote}`);
							}
							step.defaultMs = Date.now() - tDefault;
							const online = (llm?.listProviders?.() ?? []).map(p => String(p?.provider ?? p?.id ?? p)).filter(p => p.startsWith('vssaros-'));
							// 诊断：每条路由的模型清单（目录/选择器的数据源——路由在线但模型为空时选择器不会有内容）。
							const tProbe = Date.now();
							const modelsOnline = {};
							for (const route of Object.keys(ours)) {
								// 反复写不进去的路由（典型：ollama 没在跑）⇒ 不再探模型清单，
								// 否则每次 sync 都要为它等一次超时（也是"整机变慢"的一部分）。
								if ((routeWriteStreak.get(route) || 0) >= ROUTE_WRITE_STREAK_LIMIT) {
									modelsOnline[route] = 'SKIP（路由反复写不进去，已暂停探测）';
									continue;
								}
								try {
									modelsOnline[route] = (await llm.listModels(route)).map(m => String(m?.id ?? m));
								} catch (e) {
									modelsOnline[route] = `ERR ${String(e?.message ?? e).slice(0, 120)}`;
								}
							}
							step.probeMs = Date.now() - tProbe;
							const totalMs = Date.now() - tSync;
							// 只在"有改写"或"明显慢"时打：sync 内容没变就不该刷屏（与 route reasoning 那行同一纪律 ✓）。
							if (changed || totalMs > 500) {
								console.log(`[vssaros-bridge] providers.sync timing: cred=${step.credMs}ms describe=${step.describeMs}ms mutate=${step.mutateMs}ms(changed=${changed}${changed ? ` diffs=[${diffNotes.join(', ')}]` : ''}) defaultModel=${step.defaultMs}ms modelsProbe=${step.probeMs}ms total=${totalMs}ms`);
							}
							return { routes: Object.keys(ours), unchanged: !changed, providersOnline: online, modelsOnline, ...(defaultModelNote ? { defaultModel: defaultModelNote } : {}) };
						};
						run().then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
						break;
					}
					// ─── 插件商城（方案 5.16，只读面）。服务用 reflect 探测而不是 inject 硬依赖：
					// 管理器缺席（换 profile / 更老的 dsh）时不能让整个桥不激活 —— 只该这几个方法报不可用。
					case 'plugins.bundles.list':
					case 'plugins.plugins.list':
					case 'plugins.registries':
					case 'plugins.inventory': {
						const run = async () => {
							if (req.method === 'plugins.bundles.list') {
								const mgr = ctx.reflect?.get?.('pluginManager', false);
								if (!mgr) { throw new Error('pluginManager unavailable'); }
								const bundles = await mgr.listBundles();
								// 整形：只过桥 VsSaros 用得上的字段（dsh 内部结构不搬运）。
								return bundles.map(b => ({
									name: b.name,
									...(b.version ? { version: b.version } : {}),
									...(b.description ? { description: b.description } : {}),
									enabled: !!b.enabled,
									installed: !!b.installed,
									optional: !!b.optional,
									removable: !!b.removable,
									...(b.readOnlyReason ? { readOnlyReason: b.readOnlyReason } : {}),
									...(b.error?.code ? { error: b.error.code } : {}),
									rows: (b.rows ?? []).map(r => ({
										rowId: String(r.rowId ?? ''),
										moduleName: String(r.moduleName ?? ''),
										...(r.entryId ? { entryId: String(r.entryId) } : {}),
									})),
								}));
							}
							if (req.method === 'plugins.plugins.list') {
								const mgr = ctx.reflect?.get?.('pluginManager', false);
								if (!mgr) { throw new Error('pluginManager unavailable'); }
								const rows = await mgr.listPlugins();
								return rows.map(p => ({
									entryId: String(p.entryId ?? p.id ?? ''),
									...(p.patchId ? { patchId: String(p.patchId) } : {}),
									...(p.moduleName ? { moduleName: String(p.moduleName) } : {}),
									...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}),
									...(p.phase ? { phase: String(p.phase) } : {}),
									...(p.readOnlyReason ? { readOnlyReason: String(p.readOnlyReason) } : {}),
								}));
							}
							if (req.method === 'plugins.registries') {
								const mgr = ctx.reflect?.get?.('pluginManager', false);
								if (!mgr) { throw new Error('pluginManager unavailable'); }
								const r = await mgr.registries();
								return {
									registry: r.registry ?? null,
									fallbackRegistries: [...(r.fallbackRegistries ?? [])],
									resolved: r.resolved ?? null,
								};
							}
							// plugins.inventory：只回计数与预设数（187 条全量过桥没意义）。
							const inv = ctx.reflect?.get?.('pluginInventory', false);
							if (!inv || typeof inv.list !== 'function') { throw new Error('pluginInventory unavailable'); }
							const list = await inv.list();
							const entries = Array.isArray(list) ? list : (Array.isArray(list?.entries) ? list.entries : []);
							const presets = Array.isArray(list?.agentPresets) ? list.agentPresets : [];
							return {
								entries: entries.length,
								enabledEntries: entries.filter(e => e?.enabled === true).length,
								agentPresets: presets.length,
								managementAvailable: list?.managementAvailable !== false,
							};
						};
						run().then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32003, message: String(e?.message ?? e) } }));
						break;
					}
					// ─── 插件商城（方案 5.16 批次 3，写入面）：启停改走 Host 的 pluginManager ——
					// 组合包级写 `dsh.profile.bundles`、行级写 `cordis.patch.yml` 的 disabled 覆盖，
					// 都由 Host 用自己的写锁与归一化完成，并如实回传 application（applied / restart-required /
					// overridden / failed），VsSaros 不再自己复制这套语义。
					// 注意（批次 1 的死锁教训）：这些调用由**桥的请求处理器**发起（不在任何插件的 activation 链上），
					// 所以 HMR 开着时的 profile reload 能正常完成。
					case 'plugins.bundle.setEnabled':
					case 'plugins.plugin.setEnabled': {
						const run = async () => {
							const mgr = ctx.reflect?.get?.('pluginManager', false);
							if (!mgr) { throw new Error('pluginManager unavailable'); }
							const params = req.params ?? {};
							const enabled = params.enabled === true;
							const id = req.method === 'plugins.bundle.setEnabled' ? params.name : params.entryId;
							if (typeof id !== 'string' || !id.trim()) {
								throw new Error(`${req.method}: ${req.method === 'plugins.bundle.setEnabled' ? 'name' : 'entryId'} required`);
							}
							const res = req.method === 'plugins.bundle.setEnabled'
								? await mgr.setBundleEnabled(id.trim(), enabled)
								: await mgr.setPluginEnabled(id.trim(), enabled);
							return shapeChange(res, id);
						};
						run().then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
						break;
					}
					// ─── 插件商城（方案 5.16 批次 4，安装面）：inspect / install / cancel / remove ——
					// 与启停同理，都由**桥的请求处理器**发起（脱离 activation 链，HMR 开着也能完成）。
					// 安装是长任务：spec 决定的 pnpm 运行可能要几分钟，调用方的超时必须自己放宽。
					case 'plugins.bundle.inspect': {
						const run = async () => {
							const mgr = ctx.reflect?.get?.('pluginManager', false);
							if (!mgr) { throw new Error('pluginManager unavailable'); }
							const spec = typeof req.params?.spec === 'string' ? req.params.spec.trim() : '';
							if (!spec) { throw new Error('plugins.bundle.inspect: spec required'); }
							// 注册表查询可能挂着不返回；管理器自己有 inspectTimeoutMs，这里再加一层硬上限。
							const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(90_000) : undefined;
							const r = await mgr.inspect(spec, undefined, signal);
							if (r?.status === 'refused') {
								return {
									status: 'refused',
									problem: r.problem ?? 'unknown',
									reason: String(r.reason ?? 'refused'),
									...(Array.isArray(r.registries) ? { registries: r.registries.map(x => x ?? null).slice(0, 8) } : {}),
								};
							}
							return {
								status: 'accepted',
								kind: r?.kind ?? null,
								...(r?.name ? { name: String(r.name) } : {}),
								...(r?.version ? { version: String(r.version) } : {}),
								...(r?.description ? { description: String(r.description).slice(0, 400) } : {}),
								bundle: typeof r?.bundle === 'boolean' ? r.bundle : null,
								registry: r?.registry ?? null,
								...(r?.host ? { host: String(r.host) } : {}),
							};
						};
						run().then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
						break;
					}
					case 'plugins.bundle.install': {
						const run = async () => {
							const mgr = ctx.reflect?.get?.('pluginManager', false);
							if (!mgr) { throw new Error('pluginManager unavailable'); }
							const params = req.params ?? {};
							const spec = typeof params.spec === 'string' ? params.spec.trim() : '';
							const requestId = typeof params.requestId === 'string' ? params.requestId.trim() : '';
							if (!spec) { throw new Error('plugins.bundle.install: spec required'); }
							if (!requestId) { throw new Error('plugins.bundle.install: requestId required（取消与进度都按它关联）'); }
							const approvedBuilds = Array.isArray(params.approvedBuilds)
								? params.approvedBuilds.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, 32)
								: undefined;
							// requestId 在 dsh 侧是 brand 类型，运行期就是字符串——必须原样透传，
							// Host 的 install-state 事件与 cancelInstall 都按同一个值匹配。
							const res = await mgr.installBundle(spec, {
								requestId,
								...(approvedBuilds?.length ? { approvedBuilds } : {}),
							});
							return shapeChange(res, res?.bundle ?? spec, { requestId });
						};
						run().then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
						break;
					}
					case 'plugins.bundle.install.cancel': {
						const run = async () => {
							const mgr = ctx.reflect?.get?.('pluginManager', false);
							if (!mgr) { throw new Error('pluginManager unavailable'); }
							const requestId = typeof req.params?.requestId === 'string' ? req.params.requestId.trim() : '';
							if (!requestId) { throw new Error('plugins.bundle.install.cancel: requestId required'); }
							const r = await mgr.cancelInstall(requestId);
							return { status: r?.status ?? 'not-running' };
						};
						run().then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
						break;
					}
					case 'plugins.bundle.remove': {
						const run = async () => {
							const mgr = ctx.reflect?.get?.('pluginManager', false);
							if (!mgr) { throw new Error('pluginManager unavailable'); }
							const name = typeof req.params?.name === 'string' ? req.params.name.trim() : '';
							if (!name) { throw new Error('plugins.bundle.remove: name required'); }
							const res = await mgr.removeBundle(name);
							return shapeChange(res, name);
						};
						run().then(result => send({ id: req.id, result }), e => send({ id: req.id, error: { code: -32000, message: String(e?.message ?? e) } }));
						break;
					}
					default:
						send({ id: req.id ?? null, error: { code: -32601, message: `method not found: ${req.method}` } });
				}
			}
		});
		socket.on('close', () => {
			clients.delete(socket);
			noteClients();
		});
		socket.on('error', () => {
			clients.delete(socket);
			noteClients();
		});
	});
	ctx.effect(() => {
		server.listen(pipe);
		return () => {
			for (const s of clients.keys()) {
				s.destroy();
			}
			server.close();
		};
	});
	// ★ 2026-10-15（用户第三次催"首启卡"这件事）：把**本插件 apply 同步部分**的耗时钉成一行。
	//
	// 为什么需要：首启 20.9s 里有一段 9.8s（`spawn→首行 4.9s` 之后的 `首行→ready`）**没有任何日志
	// 能归因** ✗ —— 只能靠"我们三个插件的横幅时刻"反推，而反推出的结论（我们自己的 apply 占了
	// 5~7 秒）差点是错的：`providers.sync`（含 `route reasoning default` 那行）其实是
	// **IDE 客户端连上后发来的请求**（见上面 `case 'providers.sync'`），不是启动路径 ✗✓。
	// 有了这行，下次冷启就能一眼分清那段里"有没有我们的活" ✓（took 接近 0 ⇒ 全是 dsh 自身 ✓）。
	//
	// ⚠ 只覆盖**同步**部分，且配了 pipe/token 之外的分支会在上面提前 return（那时不打，符合预期 ✓）。
	// ⚠ 与 `providers.sync timing` 分工不同：那条量的是**一次请求**的处理耗时 ✓，这条量的是**装载**耗时 ✓。
	console.log(`[vssaros-bridge] apply done (host uptime ${Math.round(process.uptime() * 1000)}ms, took ${Math.round(process.uptime() * 1000) - applyStartMs}ms)`);
}
