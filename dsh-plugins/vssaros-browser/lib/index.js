/**
 * @vssaros/dsh-browser —— **Host 侧**的 `browser`（CDP）工具族。
 *
 * ## 它解决什么
 *
 * 同一个 `browser` 工具在 VsSaros 里是 `vssaros-ide` 暴露的，执行发生在 **IDE 进程**
 * （CDP 客户端在 VsSaros 主进程，`agentStudio/electron-main/browserCdpChannel.ts`）⇒
 * **没有 VsSaros 时整族不可用**。本插件把 CDP 编排搬到 Host 自己（README 4.66）：
 * 发现端点、连 WebSocket、必要时拉起专属 Chrome，全部只用 Node 内建。
 *
 * ## 11 个 op 的分层
 *
 * · **能力层**（`lib/core/client.js`）：CDP 命令编排 —— 逐条移植自 IDE 侧 `browserCdpClient.ts`；
 * · **采集脚本与渲染**（`lib/core/snapshot.js`）：由 `bin/sync-snapshot.mjs` 从真源
 *   `agentStudio/browser/browserCdpSnapshot.ts` **生成**（`--check` 守卫保证不漂移）——
 *   两种入口给出的 ref 与快照格式必须一致。
 *
 * ## 与 IDE 侧**有意不同**的一点（不要"补齐"）
 *
 * **没有用户确认 UI**：IDE 侧的动作类 op 会弹确认框（60s 窗口）。Host 是常驻进程、没有渲染进程，
 * 所以这里**不假装有**：动作类 op 只有配置显式放行（`config.allowActions` /
 * `VSSAROS_BROWSER_ALLOW_ACTIONS=1`）才执行，默认只放只读 —— 与 unreal 那条"只放行只读子集"
 * 同一档纪律（**不自造授权**）。
 *
 * ## 确认的**分档**（2026-10-14，止审批疲劳；四档从"绝不问"到"永远问"）
 *
 * 起因：真机反馈"抓一次小红书，`scroll` 被问了两次"。根因不是配置错，而是**审批缝没有"记住"这一档**：
 * `dsh-user-approval` 的 outcome 是封闭集且只有一次性放行，策略只有 `ask` / `never`（`never` 还是**自动拒绝**）
 * ⇒ "这个工具以后都同意"**协议表达不了**。所以正确的解法是**缩小需要问的面**（与官方生态一致：
 * 沙箱分层 / 越界才问 / 规则命中即免问），而不是去记忆审批结果 ✗。
 *
 *   ① **只读**（`status` / `snapshot` / `images` / `login(done)` / `cookies(inspect)`）：从不问（由 `isActionOp` 决定）；
 *   ② **阅读类动作**（`scroll`）：**默认不问** —— 它只移动视口，不改站点状态、不落输入、不搬凭据。
 *      ⚠ 这是拿"少问一次"换"模型能自动翻页读完已登录页面"，故留了 `askReading: true` 一键恢复旧行为；
 *   ③ **规则命中**（`~/.vssaros/tool-allow.json`，见 `core/allowRules.js`）：不问 —— 用户显式写下的授权，
 *      与 IDE 侧「始终允许」同一个文件、同一套键形 ⇒ 两边行为一致、用户只维护一份；
 *   ④ **其余动作**（`navigate` / `click` / `type` / `pressEnter` / `pressKey` / `back` / `reset`）：逐次问。
 *      `back` **刻意留在这一档**（不是"只移动视口"：它会让当前页离开，页面里未提交的输入随之丢失，
 *      且没有任何回滚点）—— 要免问就写规则（`browser::back`），让"放开"是一次显式决定 ✓。
 *
 * ★ 规则**也不能**免问的三类（`RULE_EXEMPT_DENY_OPS`）：`evaluate`（用户批的必须是**那段代码**）、
 * `cookies` 的 `export`/`import`（搬活凭据）、会导航的 `login`。它们各自另有默认关的独立开关
 * （`allowEvaluate` / `allowCookieIO`）⇒ 规则即使写了 `browser::*` 也越不过去 ✓（"两道闸"照旧）。
 *
 * ## 为什么是**分开的包**而不是改 `vssaros-ide`
 *
 * 同一份组合里出现两个叫 `browser` 的工具会撞名 ⇒ 本包**故意不声明** `vssaros.module`，
 * 因此不会被 VsSaros 的自发现列进"可安装模块"（`dshBundledPlugins.listBundledPlugins` 只收有 module 的包）。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRuleReader } from './core/allowRules.js';
import { DEFAULT_CDP_PORT } from './core/chrome.js';
import { BrowserCdpClient } from './core/client.js';
import {
	cookieStoreEnvelope, cookieStorePath, formatCookieReport, isAllowedSiteUrl,
	normalizeCookieAction, parseSiteUrl, sanitizeCookie, summarizeCookies,
} from './core/cookies.js';
import { readCookieStore, writeCookieStore } from './core/cookieStore.js';
import { buildReadStorageScript, buildWriteLocalStorageScript, formatStorageReport, normalizeStorageAction, parseStorageRead, sameOriginHost, sanitizeStorageMap, skippedNote, storageEnvelope, storageStorePath, summarizeStorage } from './core/storage.js';
import { readStorageStore, writeStorageStore } from './core/storageStore.js';
import { clampEvaluateTimeout, expressionPreview, formatEvaluateResult, normalizeExpression } from './core/evaluateResult.js';
import { CdpHost } from './core/host.js';
import { createHostInvoker } from './core/invoker.js';
import { createLoginSessions } from './core/loginSession.js';
import { findInSnapshot, formatFindResult, normalizeFindQuery } from './core/findInSnapshot.js';
import { SETTLE_DEFAULT_MS, SETTLE_MAX_MS, normalizeWaitConditions, settleAfterAction, waitForCondition } from './core/interaction.js';
import { formatLoginVerdict, loginGuidanceText } from './core/loginProbe.js';
import { MEDIA_SCRIPT, formatMedia, normalizeRawMedia } from './core/media.js';
import { formatImages, formatSnapshot } from './core/snapshot.js';
import { unreachableMessage } from './core/unreachable.js';

export const name = 'vssaros-browser';
export const inject = ['tools'];

/**
 * 本插件实现的 op。
 *
 * 前 11 个 = IDE 侧那 11 个（逐条移植）；
 * 后 3 个（2026-10-13 新增，**只有 Host 侧有**）：
 *  · `login`    —— 登录墙的"停下请人 + 判据验证"闭环（cookie 证据 + 页面证据）；
 *  · `cookies`  —— cookie 通道：`inspect`（只报数量）/ `export` / `import`（默认关，逐次审批）；
 *  · `evaluate` —— 在当前页面里执行**调用方给的** JS（默认关 + 逐次审批，且审批时**回显那段代码**）。
 */
const KNOWN_OPS = [
	'status', 'snapshot', 'images', 'navigate', 'click', 'type', 'pressEnter', 'pressKey', 'scroll', 'back', 'reset',
	'login', 'cookies', 'evaluate',
	// 2026-10-14（P0）：等待与快照内检索 —— **都只读**（不碰页面状态 ⇒ 不在 `ACTION_OPS` 里 ✓）。
	// `waitFor` 补的是"点了立刻读"拿到旧 DOM 的假失败；`find` 补的是大页面整页回灌的 token 爆炸 ✓。
	'waitFor', 'find',
	// 2026-10-15（P1-⑤）：storage 通道（localStorage / sessionStorage）—— `list` 只读报告、
	// `export`/`import` 搬登录态（那道闸见 `precheckStorage` 与 `isActionOp` ✓）。
	'storage',
	// 2026-10-15：媒体清单（video/audio 元素 + og 直链 + 资源清单里的媒体请求）—— **只读** ✓
	//（真机现场：模型判"视频拿不到"时，直链其实就在已登录页面里，缺的只是这一格 ✓）。
	'media',
];
/** 有用户可见副作用的 op（与 IDE 侧 `BROWSER_CONSENT_OPS` 同口径）⇒ 需要配置放行。 */
const ACTION_OPS = ['navigate', 'click', 'type', 'pressEnter', 'pressKey', 'scroll', 'back', 'reset'];

/**
 * **阅读类**动作：只移动视口，不改站点状态、不落输入、不搬凭据 ⇒ **默认免问**（2026-10-14）。
 *
 * 为什么只放 `scroll` 进来、**不放 `back`**：`back` 会让当前页离开 —— 页面里没提交的输入随之丢失，
 * 且本插件没有任何回滚点（IDE 侧那套"写盘前 captureBeforeToolEdit"在这里不存在）。
 * 判据是"最坏情况有多坏"，不是"看着像不像读"。
 *
 * ⚠ 这是一次**主动放宽**（本插件此前是"动作类一律要放行"），所以：① 它写在常量里、可被单测/探针钉住；
 * ② 留了 `askReading: true` 一键回旧行为；③ 每次免问都在 Host 日志留一行（可事后审计）。
 */
const READING_OPS = ['scroll'];

/**
 * **规则也不能**免问的 op（`RULE_EXEMPT_DENY_OPS`）。
 *
 * 理由各不同，但都是"这个决定必须由人**当场**做"：
 *   · `evaluate` —— 用户批的必须是**那段代码**（语义完全由表达式决定，静态文案没有判断价值）；
 *   · `cookies`  —— `export`/`import` 搬的是**活凭据**（"能不能操作浏览器"与"能不能把凭据搬出去"是两件事）；
 *   · `storage`  —— 同上（localStorage 里常常就是**登录 token** 本身；`list` 虽只报键名，
 *                  但"这个 op 能不能免问"按**整族**判 —— 按 action 分档会让规则模式把 export 也放过 ✗）；
 *   · `login`    —— 会导航到登录页（且属于"请人工完成"的流程入口）。
 * 前两类另有默认关的独立开关（`allowEvaluate` / `allowCookieIO` / `allowStorageIO`）⇒ **两道闸的设计保持不变** ✓。
 */
const RULE_EXEMPT_DENY_OPS = new Set(['evaluate', 'cookies', 'storage', 'login']);

/**
 * 浏览器可达性的**重探间隔**（2026-10-13，工具可见性门控用）。
 *
 * 取 30s 与 IDE 侧同口径（那边是"至多 30 秒重探一次"）：用户随时可能去开远程调试，
 * 太慢会让"我明明开好了、它还是看不见"变成一个说不清的故障；再快则是白费探测
 * （本机 `ECONNREFUSED` 是立即返回的、代价很小，但每秒打一次也没必要）。
 *
 * ⚠ 用它的定时器必须 `unref()`（见 `refreshAvailability` 的挂载处）：它跟着 Host 进程活，
 * 绝不能因为它让 Host 退不掉。
 */
const AVAILABILITY_RECHECK_MS = 30_000;

/**
 * 该次调用是否有用户可见副作用 —— **按 op + 参数**判（2026-10-13）。
 *
 * 为什么不能只看 op：`login` 与 `cookies` 都是"同一个 op 两种性质"——
 *   · `login` 不带 `done`：会打开页面（动用户的浏览器）⇒ 要确认；
 *     `login` 带 `done: true`：只读 cookie 与页面正文（**不导航**）⇒ 不该弹窗；
 *   · `cookies` 的 `inspect`：只报数量（只读）；`export` / `import`：写盘 / 注入凭据 ⇒ 要确认。
 * 判错任一侧的代价都不小：多弹 = 审批疲劳（用户会开始无脑点同意）；少弹 = 静默把凭据写进磁盘。
 */
const isActionOp = (op, params) => {
	if (ACTION_OPS.includes(op)) { return true; }
	if (op === 'login') { return params?.done !== true; }
	if (op === 'cookies') { return normalizeCookieAction(params?.action) !== 'inspect'; }
	// `storage` 同形（2026-10-15）：`list` 只报**键名/条数/字节数**（值不进上下文 ⇒ 与 `cookies inspect` 同档 ✓）；
	// `export` / `import` 会**把活 token 写盘或注入** ⇒ 动作类（两道闸，见 `precheckStorage`）。
	if (op === 'storage') { return normalizeStorageAction(params?.action) !== 'list'; }
	// `evaluate` 跑的是**页面里的任意 JS** ⇒ 不存在"只读的 evaluate"这一档（哪怕表达式看着无害，
	// 判据也不该由我们替用户猜）⇒ 永远要确认。总开关另有一个默认关的 `allowEvaluate`。
	if (op === 'evaluate') { return true; }
	return false;
};

/**
 * `evaluate` 的审批文案。
 *
 * 为什么它必须**回显那段代码**（而不是像其它 op 一样一句话带过）：这个 op 的语义**完全由表达式决定**
 * —— "browser.evaluate 会执行 JS"对用户没有任何判断价值（取个标题，还是 `document.cookie`，天壤之别）。
 * 其余 op 的语义由 op 名定死（`click` 就是点击）⇒ 静态文案够用。用户批的必须是**代码**，不是"某个动作"。
 */
function describeEvaluate(params) {
	const preview = expressionPreview(params?.expression);
	return {
		reason: 'browser.evaluate 会在**当前页面**里执行下面这段 JS（它能读取该页的 cookie / localStorage，也能改动页面）：'
			+ `\n\n${preview}`,
		zh: `允许 browser.evaluate 在当前页面执行这段 JS？\n\n${preview}`,
		en: `Allow browser.evaluate to run this JS in the current page?\n\n${preview}`,
	};
}

/**
 * 从工具执行上下文取**会话归属键**（多会话隔离的入口，2026-10-13）。
 *
 * 取值契约（**纯函数 ⇒ 可单测**；本文件里唯一读 `exec` 身份的地方）：
 *   · `exec.agent.id` 就是 dsh 的 **SessionId**（`@deepseek-ai/dsh-agent`：`interface Agent { readonly id: SessionId }`）；
 *   · 只有它是**非空字符串**才采用；其余（没有 agent / id 不是字符串 / 空串）一律返回 `''` ⇒ 退化为不隔离。
 *     —— **不猜**：拿一个畸形 id 当隔离键，比不隔离更糟（会把人锁在一个谁也认不出的页面上）。
 *
 * 导出是为了让守卫能**行为级**钉住它（而不是去断言源码里那行字面量）。
 */
export const sessionKeyOf = exec => (typeof exec?.agent?.id === 'string' && exec.agent.id.length > 0 ? exec.agent.id : '');

const flag = raw => raw === '1' || raw === 'true';
const asInt = value => (Number.isInteger(value) ? value : undefined);

export function apply(ctx, config = {}) {
	const env = process.env;
	const port = Number.isInteger(config.port)
		? config.port
		: (Number.parseInt(env.VSSAROS_BROWSER_CDP_PORT ?? '', 10) || DEFAULT_CDP_PORT);
	/**
	 * 端点不可达时，是否由我们**拉起一个专属实例**。
	 *
	 * ⚠⚠ **默认值必须与 IDE 侧对齐 = 开**（2026-10-13 修正）。原先这里走"环境变量为空 ⇒ false"，
	 * 而 IDE 侧同名设置是 `default: true`、UI 上写着"开箱即用" ⇒ **两边对不上**，症状正是真机日志
	 * 里那一串：**工具看得见、永远用不了**（模型调 `browser.login` ⇒ 弹授权 ⇒ `fetch failed`）。
	 * 根因是 Host 是**独立进程**，读不到 IDE 的 settings（`cordis.patch.yml` 里是 `config: {}`），
	 * 所以默认值必须以**这一侧**为准 —— 不能假设"总会有人注入 IDE 的设置"。
	 * 要关就显式关：`launchDedicated = false` 或 `VSSAROS_BROWSER_LAUNCH_DEDICATED=0`。
	 */
	const launchDedicated = typeof config.launchDedicated === 'boolean'
		? config.launchDedicated
		: flag(env.VSSAROS_BROWSER_LAUNCH_DEDICATED ?? '1');
	/**
	 * ★ 2026-10-28（用户要求：「每次启动都自动打开浏览器，能不能无感」）：
	 *   专属实例**默认无头** ⇒ Host 启动**不再弹出任何 Chrome 窗口**；
	 *   只有需要人交互登录时，`loginSession.open()` 才把它切成**有头**（登录完再切回无头）✓
	 *   ⚠ 显式配置仍然优先：`config.headless = false` 或 `VSSAROS_BROWSER_HEADLESS=0` 可强制有头。
	 */
	const headless = typeof config.headless === 'boolean' ? config.headless : flag(env.VSSAROS_BROWSER_HEADLESS ?? '1');
	const allowActions = typeof config.allowActions === 'boolean'
		? config.allowActions
		: flag(env.VSSAROS_BROWSER_ALLOW_ACTIONS ?? '');
	/**
	 * cookie 导出/导入的**总开关**（默认 **关**，2026-10-13）。
	 *
	 * 为什么与 `allowActions` 分开、且默认关闭：导出会把**活凭据**写到磁盘上（即使是本机）。
	 * "能不能操作浏览器"与"能不能把凭据搬出浏览器"是两件事，后者必须有独立且默认关闭的开关。
	 * 逐次审批（`isActionOp`）是第二道闸 —— 两道都要过。
	 */
	const allowCookieIO = typeof config.allowCookieIO === 'boolean'
		? config.allowCookieIO
		: flag(env.VSSAROS_BROWSER_ALLOW_COOKIE_IO ?? '');
	/**
	 * localStorage / sessionStorage 导出与注入的**总开关**（默认 **关**，2026-10-15，P1-⑤）。
	 *
	 * 为什么与 `allowCookieIO` **分开**：两处放的凭据不是一套 —— 很多站点把**登录 token 放在
	 * localStorage**（cookie 里只有无状态的东西）⇒ 只开 cookie 那一道的人，不该顺带被允许把 token 搬出浏览器 ✗。
	 * 逐次审批是第二道闸（`isActionOp`）—— 两道都要过 ✓。`action: "list"`（只报键名/条数）不受它影响。
	 */
	const allowStorageIO = typeof config.allowStorageIO === 'boolean'
		? config.allowStorageIO
		: flag(env.VSSAROS_BROWSER_ALLOW_STORAGE_IO ?? '');
	/**
	 * **在页面里执行调用方给的 JS** 的总开关（默认 **关**，2026-10-13）。
	 *
	 * 为什么又开一个开关，而不是复用 `allowActions`：两者管的是不同的事 ——
	 * `allowActions` 是"**能不能操作**浏览器"（点击 / 导航：语义有界，能做什么一眼看得出）；
	 * 这里是"**能不能在页面里跑任意代码**"（图灵完备：读该页 cookie / localStorage、改页面、发请求）。
	 * 更要紧的是：`cookies` op 刻意保证"凭据值**不进上下文**"，而 `evaluate` **做不到**这个保证
	 * —— 既然保证不了就不假装，改成"默认关 + 让用户在批之前看见那段代码"。
	 */
	const allowEvaluate = typeof config.allowEvaluate === 'boolean'
		? config.allowEvaluate
		: flag(env.VSSAROS_BROWSER_ALLOW_EVALUATE ?? '');
	/**
	 * 动作后**自动沉降**的总预算（ms，默认 400；0 = **关掉**；夹在 `[0, SETTLE_MAX_MS]`）。
	 *
	 * 为什么默认**开**：模型的典型失败模式是"点了立刻 snapshot" ⇒ 拿到旧 DOM ⇒ ref 全失效 ⇒ 循环重试 ✗
	 *（P0-②；见 `core/interaction.js` 的文件头）。400ms 的预算只够等"快抖两下"，慢加载要显式 `waitFor` ✓。
	 * ⚠ 它不轮询网络：我们没有 CDP 事件通道 ⇒ 只有"页面指纹稳定"这一种判据 ✓（不伪装有 networkIdle ✗）。
	 */
	const settleMs = (() => {
		const raw = typeof config.settleMs === 'number' ? config.settleMs
			: Number.parseInt(env.VSSAROS_BROWSER_SETTLE_MS ?? '', 10);
		if (!Number.isFinite(raw)) { return SETTLE_DEFAULT_MS; }
		return Math.min(Math.max(Math.floor(raw), 0), SETTLE_MAX_MS);
	})();
	/**
	 * **阅读类动作**是否也照旧逐次问（默认 `false` = 免问，2026-10-14）。
	 *
	 * 为什么留这个反向开关：② 档（见文件头）是一次**主动放宽** —— 换来的是"模型能自动翻页读完
	 * 已登录页面"，代价是"读页面这件事不再逐次经过人"。偏紧的部署可以一键回到旧行为；
	 * 想只对某个 op 松口则用规则（`~/.vssaros/tool-allow.json` 里写 `browser::scroll`），
	 * 那是**显式**决定，比"默认就松"更适合审计 ✓。
	 */
	const askReading = typeof config.askReading === 'boolean'
		? config.askReading
		: flag(env.VSSAROS_BROWSER_ASK_READING ?? '');
	/** 数据根的家目录（专属 profile 与 cookie 存档都挂在它下面，保持单一来源）。 */
	const homeDir = homedir();
	/**
	 * allow 规则（`<数据根>/tool-allow.json`，与 IDE 侧**同一个文件**）—— 见 `core/allowRules.js`。
	 *
	 * 默认路径走数据根链（`config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`），与 kanban 等插件同口径：
	 * dev 数据根是 `~/.vssaros-dev`，IDE 在 dev 下写的授权表也在那里——硬编码 `~/.vssaros` 会读错文件。
	 * 路径可配（`allowRulesPath` / `VSSAROS_TOOL_ALLOW_FILE`）：真机不需要它（默认就是 IDE 写的那份），
	 * 存在是为了让探针能把规则指到临时文件上（否则测试就得去改用户的真实授权表 ✗）。
	 */
	const allowRulesPath = (() => {
		const fromConfig = typeof config.allowRulesPath === 'string' && config.allowRulesPath.trim()
			? config.allowRulesPath.trim() : undefined;
		const fromEnv = (env.VSSAROS_TOOL_ALLOW_FILE ?? '').trim() || undefined;
		if (fromConfig ?? fromEnv) { return fromConfig ?? fromEnv; }
		const dataRoot = typeof config.dataRoot === 'string' && config.dataRoot.trim()
			? config.dataRoot.trim()
			: ((env.VSSAROS_DATA_ROOT ?? '').trim() || join(homeDir, '.vssaros'));
		return join(dataRoot, 'tool-allow.json');
	})();
	const allowRules = createRuleReader(allowRulesPath);

	const log = line => {
		try { process.stdout.write(`${line}\n`); } catch { /* 忽略 */ }
		ctx.logger?.info?.(line);
	};
	/** 免问日志每次都写会很吵（`scroll` 可能连调十次）⇒ 同一原因只写一次。 */
	const loggedExemptions = new Set();
	const logExemptionOnce = (key, line) => {
		if (loggedExemptions.has(key)) { return; }
		loggedExemptions.add(key);
		log(line);
	};
	const logger = { info: log, warn: log };
	const host = new CdpHost({ port, launchDedicated, headless, homeDir, logger });
	const invoke = createHostInvoker(host);
	/**
	 * **无会话绑定**的客户端：真正的调用一律经 `baseClient.forSession(sessionKey)` 取绑定视图
	 * （见 `execute`）—— 这是多会话互不影响的入口。
	 */
	const baseClient = new BrowserCdpClient(invoke, logger);
	/**
	 * 登录会话（2026-10-22）：给**同 Host 的其他插件**用（LightAI 在 dsh 侧登录 = 开登录页 + 读会话 cookie）。
	 * 只认登记过的站点与 cookie 名、不经模型可达的工具面 ⇒ 不受 `allowCookieIO` / 审批约束（见 `core/loginSession.js`）。
	 */
	const loginSession = createLoginSessions({
		baseClient,
		browserCommand: async (method, params) => {
			const res = await invoke({ op: 'command', method, params });
			if (!res?.ok) { throw new Error(res?.error ?? 'browser CDP call failed'); }
			return res.result;
		},
		headless,
		// ★ 2026-10-28：平时无头（用户无感）；要人登录时切有头；登录完切回无头 ✓
		ensureHeaded: () => host.ensureHeaded(),
		ensureHeadless: () => host.ensureHeadless(),
		log,
	});

	// ★ **让路标记**：`vssaros-ide` 会检查这个服务在不在，在就跳过它自己那套 `browser`（见 README 4.69 Step 1）。
	//   两个包同时注册同名工具会让**整条 entry 失效**（不是后者覆盖）⇒ 必须靠它保证任何时刻只有一个。
	ctx.provide('vssarosBrowser', {
		plugin: '@vssaros/dsh-browser',
		ops: KNOWN_OPS,
		executesInHost: true,
		/** 能力声明（供诊断/守卫读）：页面按会话隔离到**独立 tab**（多会话并发互不影响）。 */
		sessionIsolation: 'per-session-tab',
		/** 端点不可达时会不会自己拉起专属实例（默认**开**；与 IDE 侧那个同名设置的默认值一致）。 */
		launchDedicated,
		/** 默认**免问**的阅读类动作（诊断/守卫读；见文件头"确认的分档"②）。 */
		readingOps: READING_OPS,
		/** 登录会话（开登录页 / 读登记站点的会话 cookie / 关 tab）——见 `core/loginSession.js`。 */
		loginSession,
	});

	/**
	 * 动作类 op 的**用户确认**：走官方审批缝 `ctx.get('approval')` —— 与运行时自己的 `serviceAsk`
	 * 是同一条缝（`dsh-tools` 里 `ask` 就是经它解析的）。
	 *
	 * 为什么在这里自己发起而不是挂 `tools/pre-execute` 钩子：本工具是"一个工具 + op 参数"，钩子只拿得到
	 * 工具名；而**更关键**的是钩子拿不到审批**结果** ⇒ 无法在 `execute` 里做 fail-closed 兜底
	 * （钩子返回 `ask` 而运行时不支持审批时，官方会 deny ✓；但如果运行时压根没有那条钩子，动作就会
	 * 不经询问地执行 ✗）。自己发起 + 自己判结果 ⇒ 任何部署下都是**默认拒绝**。
	 *
	 * ## 四道闸的顺序（2026-10-14；只有"要不要问人"这一步，其它两闸不受影响）
	 *
	 *   ① `allowActions`（显式全局放行，无人值守）
	 *   ② 阅读类动作（`READING_OPS`，默认免问，可用 `askReading` 关掉）
	 *   ③ allow 规则命中（`~/.vssaros/tool-allow.json`，用户显式写下；`RULE_EXEMPT_DENY_OPS` 除外）
	 *   ④ 都没有 ⇒ 走官方审批缝逐次问（本函数原先的唯一行为）
	 *
	 * ⚠ ②③ **不越过**参数/开关校验：那些在 `execute` 里、本函数**之前**（`precheckCookies` /
	 * `precheckEvaluate` / `requireReachable`）⇒ 免问 ≠ 免校验，`allowCookieIO`/`allowEvaluate`
	 * 这两道独立开关照旧 ✓。
	 */
	const requestConsent = async (op, exec, params) => {
		if (allowActions) { return; }   // ① 显式免确认（无人值守；配置项 + 环境变量两条路都能开）
		// ② 阅读类动作：只移动视口，不改站点状态（理由与代价见文件头"确认的分档"）
		if (!askReading && READING_OPS.includes(op)) {
			logExemptionOnce(`reading:${op}`, `[vssaros-browser] browser.${op} 免问（阅读类动作；要恢复逐次确认：askReading=true）`);
			return;
		}
		// ③ 用户显式写下的规则命中即免问（同一份文件、同一套键形 —— 与 IDE 侧行为一致）
		if (!RULE_EXEMPT_DENY_OPS.has(op)) {
			let hit;
			try { hit = allowRules.match('browser', op); } catch { hit = undefined; }   // 读规则绝不至于挡住动作
			if (hit) {
				logExemptionOnce(`rule:${hit}`, `[vssaros-browser] browser.${op} 免问（allow 规则：${hit}）`);
				return;
			}
		}
		// ④ 逐次问
		const approval = (() => { try { return ctx.get?.('approval'); } catch { return undefined; } })();
		if (!approval || typeof approval.request !== 'function') {
			throw new Error(`browser.${op} 属动作类，需要用户确认，但本部署**没有审批通道** ⇒ 已按 fail-closed 拒绝。`
				+ '接线：启用 dsh 的审批服务（user-approval）；无人值守场景可显式设 `config.allowActions = true`'
				+ ' 或 `VSSAROS_BROWSER_ALLOW_ACTIONS=1`（⚠ 那意味着模型可不经确认地操作你浏览器里已登录的站点）。');
		}
		/**
		 * 审批文案必须**说真话**：`cookies` 的动作是"搬登录凭据"、`login` 的动作是"打开登录页"，
		 * 与"翻页/点击"完全不是一回事 —— 用同一句泛泛的话，用户就无从判断该不该点同意
		 * （本仓既有纪律："审批文案必须说真话"，见 memory 侧的 memory 工具那次）。
		 *
		 * ⚠ `evaluate` **必须回显那段代码** ⇒ 它是唯一"语义由参数决定"的 op（见 `describeEvaluate`）——
		 * 所以这里得把 `params` 传进来，不能只用 op 名查表。
		 */
		const describe = op === 'evaluate' ? describeEvaluate(params) : ({
			cookies: {
				reason: 'browser.cookies 会读写你浏览器里的登录凭据（导出到本机文件 / 从文件注入）',
				zh: '允许 browser.cookies 读写你浏览器里的登录凭据？',
				en: 'Allow browser.cookies to read/write your browser login credentials?',
			},
			login: {
				reason: 'browser.login 会打开登录页面，供你自己在那个窗口里完成登录',
				zh: '允许 browser.login 打开登录页面？',
				en: 'Allow browser.login to open a sign-in page?',
			},
		}[op] ?? {
			reason: `browser.${op} 会操作你本机 Chrome 里已登录的页面`,
			zh: `允许 browser.${op} 操作你本机 Chrome？`,
			en: `Allow browser.${op} to drive your local Chrome?`,
		});

		const outcome = await approval.request({
			...(exec?.agent === undefined ? {} : { agent: exec.agent }),
			...(exec?.callId === undefined ? {} : { callId: exec.callId }),
			...(exec?.signal === undefined ? {} : { signal: exec.signal }),
			toolName: 'browser',
			reason: describe.reason,
			displayReason: { en: describe.en, zh: describe.zh },
		});
		if (outcome !== 'allowed-once') {
			throw new Error(`browser.${op} 未获准（${String(outcome)}）⇒ 已拒绝执行（不会碰浏览器）。`);
		}
	};
	log(`[vssaros-browser] apply（port=${port} dedicated=${launchDedicated ? 'on' : 'off'} headless=${headless ? 'on' : 'off'} actions=${allowActions ? 'allowed' : 'ask'} reading=${askReading ? 'ask' : `${READING_OPS.join('/')}免问`} rules=${allowRulesPath}${allowRules.loaded() ? '（有规则）' : '（空/不存在）'} cookieIO=${allowCookieIO ? 'on' : 'off'} evaluate=${allowEvaluate ? 'on' : 'off'}）`);

	/**
	 * `cookies` op 的前置校验 —— **必须在审批之前跑**（用户不该为一个必然被拒的调用点确认）。
	 * 返回归一后的 `{ action, site }`，handler 里复用同一份结果（避免两处各归一一次而分叉）。
	 */
	const precheckCookies = params => {
		const action = normalizeCookieAction(params?.action);
		const site = parseSiteUrl(params?.url);
		if (!site) {
			throw new Error('browser.cookies 需要 url（用它确定站点域名；不接受"猜"出来的域名）');
		}
		if (!isAllowedSiteUrl(site)) {
			throw new Error('browser.cookies 只接受 https:// 站点（或本地回环 http://，供开发自测）—— 明文 http 上不搬运凭据。');
		}
		if (action !== 'inspect' && !allowCookieIO) {
			throw new Error('cookie 的导出/导入**默认关闭**（它会把登录凭据落盘或注入浏览器）。要启用：配置 `allowCookieIO = true`'
				+ '，或环境变量 `VSSAROS_BROWSER_ALLOW_COOKIE_IO=1`。只读的 `action: "inspect"` 不受影响。');
		}
		return { action, site };
	};

	/**
	 * `storage` op 的前置校验（2026-10-15，P1-⑤）—— **必须在审批之前跑**（与 cookies 同一条纪律）。
	 *
	 * 三条判定：
	 *   ① `action: "list"` 只是**键名/条数**报告（值不进上下文）⇒ **不看开关**、也不需要站点围栏 ✓
	 *      （否则 http 站点连"登录态在不在 localStorage"都查不了 ✗）；
	 *   ② `export` / `import` 会把 localStorage 里的**活 token** 写盘或注入 ⇒ 要 `allowStorageIO`（默认关）；
	 *   ③ 给了 `url` 时它必须是一个"能搬凭据"的地址（https 或本地回环）—— 与 cookie 通道同一把尺 ✓。
	 *      ⚠ 同源要求（localStorage 按源隔离）在 execute 里判：**要等页内事实回来**才知道当前页在哪 ✓，
	 *      而且我们**不替调用方导航**（导航是动作类 ⇒ 静默导航 = 一次未经审批的动作 ✗）。
	 */
	const precheckStorage = params => {
		const action = normalizeStorageAction(params?.action);
		let site;
		if (action !== 'list' || params?.url !== undefined) {
			site = parseSiteUrl(params?.url);
			if (params?.url !== undefined && !site) {
				throw new Error('browser.storage 的 url 不是合法地址（需要 http(s)://…；不接受"猜"出来的域名）');
			}
			if (site && !isAllowedSiteUrl(site)) {
				throw new Error('browser.storage 只接受 https:// 站点（或本地回环 http://，供开发自测）—— 明文 http 上不搬运凭据。');
			}
			if (action === 'list' && !site) {
				throw new Error('browser.storage 给了 url 但它不是合法地址（需要 http(s)://…）');
			}
		}
		if (action !== 'list' && !allowStorageIO) {
			throw new Error('localStorage / sessionStorage 的导出/导入**默认关闭**（它会把登录 token 落盘或注入浏览器）。'
				+ '要启用：配置 `allowStorageIO = true`，或环境变量 `VSSAROS_BROWSER_ALLOW_STORAGE_IO=1`。'
				+ '只读的 `action: "list"`（只报键名与条数）不受影响。');
		}
		return { action, site };
	};

	/**
	 * `evaluate` op 的前置校验 —— 同样**必须在审批之前**跑（开关关着 / 表达式非法时，用户不该被问一次）。
	 * 返回归一后的表达式，与 handler 里用的是**同一个** `normalizeExpression`（纯函数、幂等）。
	 */
	const precheckEvaluate = params => {
		const expression = normalizeExpression(params?.expression);
		if (!allowEvaluate) {
			throw new Error('browser.evaluate **默认关闭**：它会在当前页面里执行任意 JS（能读到该页的 cookie / localStorage，'
				+ '也能改动页面）。要启用：配置 `allowEvaluate = true`，或环境变量 `VSSAROS_BROWSER_ALLOW_EVALUATE=1`'
				+ ' —— ⚠ 那意味着每次审批通过后，模型都能在你**已登录的**页面里跑任意代码。'
				+ '只想读页面内容的话用 `op: "snapshot"` / `op: "images"`，它们不需要这个开关。');
		}
		return expression;
	};

	/**
	 * **不可达时的前置拒绝**（2026-10-13）。
	 *
	 * 为什么必须在审批**之前**：真机日志里用户先点了"允许一次"、**然后**才失败（`fetch failed`）
	 * —— 那次授权白点了。本仓的纪律是"校验必须在审批之前：不许为一个必然失败的调用点问用户"，
	 * 而"浏览器根本连不上"正是最典型的必然失败（当时只覆盖了开关与参数，漏了这一类）。
	 *
	 * ⚠ 两条**不拦**（都会把本来能走通的路堵死）：
	 *   · `launchDedicated` 开着 ⇒ "连不上"**不等于**"会失败"：`_connection()` 会自己拉起专属实例；
	 *   · `op: "status"` ⇒ 它的**存在意义**就是如实报告"连不上"（它本身就是诊断入口），
	 *     拦了它等于把诊断能力一起关掉。
	 */
	const requireReachable = async op => {
		if (op === 'status' || launchDedicated) { return; }
		const reach = await host.ensureReachable();
		if (reach.ok) { return; }
		throw new Error(unreachableMessage(op, {
			endpoint: reach.endpoint,
			error: reach.error,
			launchDedicated,
			dedicatedPort: host.dedicatedPort,
		}));
	};

	/**
	 * 各 op 的实现（参数校验在这里做；**碰网络之前**就把不合法的请求拒掉）。
	 *
	 * 为什么是**工厂**而不是一个常量对象：每次调用都要把 `client` 换成**该会话的绑定视图**
	 * （`forSession`）。做成工厂只需 `execute` 里一行，12 个 handler 的内部代码一行都不用改
	 * —— 而"每个方法都记得传会话键"正是最容易漏一处的地方（漏一处就串台，且只在并发时复现）。
	 */
	const createHandlers = client => ({
		status: async () => JSON.stringify(await client.status(), null, 2),
		snapshot: async () => formatSnapshot(await client.snapshot()),
		images: async () => formatImages(await client.images()),
		navigate: async params => {
			const url = typeof params?.url === 'string' ? params.url.trim() : '';
			if (!url) { throw new Error('browser.navigate 需要 url'); }
			return await client.navigate(url);
		},
		click: async params => {
			const ref = asInt(params?.ref);
			if (ref === undefined) { throw new Error('browser.click 需要整数 ref（来自 browser_snapshot）'); }
			return await client.click(ref);
		},
		type: async params => {
			const ref = asInt(params?.ref);
			if (ref === undefined) { throw new Error('browser.type 需要整数 ref（来自 browser_snapshot）'); }
			if (typeof params?.text !== 'string') { throw new Error('browser.type 需要 text（可为空串 = 清空）'); }
			return await client.type(ref, params.text, { append: params?.append === true });
		},
		pressEnter: async () => await client.pressEnter(),
		pressKey: async params => {
			const key = typeof params?.key === 'string' ? params.key.trim() : '';
			if (!key) { throw new Error('browser.pressKey 需要 key（如 Enter / Tab / ArrowDown）'); }
			await client.pressKey(key);
			return `Pressed ${key}.`;
		},
		scroll: async params => {
			const direction = params?.direction === 'up' || params?.direction === 'down' ? params.direction : undefined;
			if (!direction) { throw new Error("browser.scroll 需要 direction（'up' 或 'down'）"); }
			const amount = asInt(params?.amount);
			if (amount === undefined || amount <= 0) { throw new Error('browser.scroll 需要正整数 amount（像素）'); }
			const ref = asInt(params?.ref);
			return await client.scroll(direction, amount, ref);
		},
		back: async () => await client.back(),
		reset: async () => {
			await client.reset();
			return '已丢弃 CDP 连接（下次调用会重新发现端点）。';
		},

		/**
		 * 登录墙的闭环（2026-10-13）—— 两道工序，**刻意分成两次调用**：
		 *   ① 不带 `done`：把目标页打开到那个窗口里，返回"请你自己去登录"的指引（结束当轮，用户看得见窗口）；
		 *   ② 带 `done: true`：**验证**登录态（cookie 证据 + 页面证据），把结论如实说出来。
		 * 为什么不合成一次：登录是**人工步骤**，同步等待只能靠轮询或超时 —— 而"结束当轮 + 用户回来说一声"
		 * 在聊天形态里是零成本的（与 IDE 侧 `browser_use_my_chrome` 引导卡同一取向）。
		 */
		login: async params => {
			const url = typeof params?.url === 'string' ? params.url.trim() : '';
			if (params?.done === true) {
				// 只读：不导航（避免"未经审批的导航"），只探测当前页 + 读 cookie。
				return formatLoginVerdict(await client.checkLogin(url || undefined));
			}
			if (url) {
				const site = parseSiteUrl(url);
				if (!site) { throw new Error('browser.login 的 url 不是合法地址（需要 http(s)://…）'); }
				await client.openForLogin(site.url);
			}
			const status = await client.status().catch(() => undefined);
			return loginGuidanceText({ url, endpoint: status?.endpoint, selfLaunched: status?.selfLaunched === true });
		},

		/**
		 * cookie 通道（2026-10-13）：**只读计数** / 导出到本机存档 / 从存档注入。
		 *
		 * 三条不可动的性质：① 返回值里**没有 cookie 值**（只有计数与名字）；② 导出路径**不可由调用方指定**
		 * （永远只写/读"本站点默认存档"，否则就是一个任意文件读写面）；③ 开关 + 审批两道闸。
		 */
		cookies: async params => {
			const { action, site } = precheckCookies(params);
			const cookies = await client.cookiesForSite(site.host);
			const summary = summarizeCookies(cookies, site.host);

			if (action === 'inspect') {
				return formatCookieReport({ action, host: site.host, summary });
			}

			const storePath = cookieStorePath(homeDir, process.platform, site.host);

			if (action === 'export') {
				if (summary.total === 0) {
					return formatCookieReport({ action, host: site.host, summary })
						+ '\n\nNothing to export — sign in first (`op: "login"`), then try again.';
				}
				const written = writeCookieStore(storePath, cookieStoreEnvelope(site.host, cookies, new Date().toISOString()));
				if (!written.ok) {
					return `## Cookie export failed — ${site.host}\n\n`
						+ `Read ${summary.total} cookie(s) from the browser, but could not write the store: ${written.reason}.\n`
						+ 'No cookie value was returned or logged.';
				}
				return formatCookieReport({ action, host: site.host, summary, path: written.path });
			}

			// import
			const read = readCookieStore(storePath);
			if (!read.ok) {
				return `## Cookie import — nothing to import for ${site.host}\n\n`
					+ `No usable store at ${storePath ?? '(unresolved path)'} (${read.reason}).\n`
					+ 'Export a session first (`action: "export"`) while that site is signed in, then import it here.';
			}
			// 净化 + 必须有 domain（没有 domain 的 cookie CDP 无法定位，注进去也白搭）。
			const usable = read.cookies.map(sanitizeCookie).filter(c => !!c && !!c.domain);
			const result = await client.cookiesSet(usable);
			const imported = summarizeCookies(usable, site.host);
			return formatCookieReport({
				action, host: site.host, injected: result.injected,
				summary: { total: usable.length, sessionish: imported.sessionish, hasSessionish: imported.hasSessionish },
			});
		},

		/**
		 * 在**当前页面**里跑调用方给的 JS（2026-10-13）：`snapshot` / `images` 取不到的东西从这里取
		 * （SPA 挂在 `window` 上的页面数据、按选择器批量取属性、滚动到位再读……）。
		 *
		 * 两道闸缺一不可：默认关的 `allowEvaluate`（`precheckEvaluate`）+ 逐次审批（且**回显代码**）。
		 * 结果经 `formatEvaluateResult` 渲染 —— 它负责类型说明、截断，以及"这不是页面内容、ref 可能已失效"
		 * 这两句提醒（否则模型会把一个 `outerHTML` 当成整页文本用）。
		 */
		evaluate: async params => {
			const expression = normalizeExpression(params?.expression);
			return formatEvaluateResult(expression, await client.evaluate(expression, clampEvaluateTimeout(params?.timeoutMs)));
		},

		/**
		 * 等待页内条件（**只读**，2026-10-14 P0-①）：`text` / `textGone` / `selector` / `urlContains` /
		 * `delayMs` 至少给一条，多条是 **AND**。见 `core/interaction.js` 的文件头（轮询页内表达式；
		 * 没有 networkIdle 这一档 —— 我们没有 CDP 事件通道，别伪装有 ✗）。
		 */
		waitFor: async params => {
			const conds = normalizeWaitConditions(params);
			const r = await waitForCondition(expr => client._evaluate(expr), conds);
			return `等到条件成立（耗时 ${r.waitedMs}ms）：${r.met}`;
		},
		/**
		 * 在**最近一次 snapshot 的那一帧**里检索（**只读**，2026-10-14 P0-③）：按文本/正则只回命中的
		 * 那一小撮 —— 不回整棵树。⚠ 它不碰页面、**也不重标 ref** ⇒ 旧 ref 不会被它作废 ✓
		 * （`snapshot` 每次会清重标 ⇒ "先 snapshot 再 find"读的是**同一帧** ✓）。
		 */
		find: async params => {
			const query = normalizeFindQuery(params);
			const raw = await client.snapshot();
			return formatFindResult(query, findInSnapshot(raw, query));
		},
		/** 媒体清单（只读，2026-10-15）：`<video>/<audio>` + og 直链 + 资源清单里的媒体请求。 */
		media: async () => formatMedia(normalizeRawMedia(await client._evaluate(MEDIA_SCRIPT, 20_000))),
		/**
		 * localStorage / sessionStorage 通道（2026-10-15，P1-⑤）：`list` 只读报告（键名/条数/字节数，
		 * **值不进上下文** ✓）、`export`/`import` 跨 profile 搬登录态（开关 + 逐次审批两道闸）。
		 * ⚠ localStorage **按源隔离** ⇒ 只对"当前页所在的那个源"生效；要搬别的站点**不替你导航**
		 *（导航是动作类）——报错说清"先把页面开过去" ✓。见 `core/storage.js` 的七条约束。
		 */
		storage: async params => {
			const { action, site } = precheckStorage(params);
			const parsed = parseStorageRead(await client._evaluate(buildReadStorageScript(), 20_000));
			if (!parsed.ok) {
				throw new Error(`browser.storage 读页面存储失败（${parsed.reason}）：页面可能正在导航，或该源的本地存储被禁用/不可访问。`);
			}
			if (site && action !== 'list' && !sameOriginHost(site.host, parsed.host)) {
				throw new Error(`browser.storage 要搬的是 ${site.host}，而当前页在 ${parsed.host}`
					+ '（localStorage 按**源**隔离）⇒ 不会替你导航（那是动作类）：请先把页面开到目标站点，再调一次。');
			}
			const host = site ? site.host : parsed.host;
			const pageSummary = {
				localStorage: summarizeStorage(parsed.areas.localStorage, host),
				sessionStorage: summarizeStorage(parsed.areas.sessionStorage, host),
			};
			if (action === 'list') {
				return formatStorageReport({ action, host, summary: pageSummary, skippedNote: skippedNote(parsed.skipped) });
			}
			const storePath = storageStorePath(homeDir, process.platform, host);
			if (action === 'export') {
				const envelope = storageEnvelope(host, parsed.areas, new Date().toISOString());
				const written = writeStorageStore(storePath, envelope);
				if (!written.ok) {
					return formatStorageReport({ action, host, summary: pageSummary, skippedNote: skippedNote(parsed.skipped) })
						+ `\n\n## Export failed — could not write the store: ${written.reason}\nNo value was returned or logged.`;
				}
				return formatStorageReport({
					action, host, summary: pageSummary, path: written.path,
					skippedNote: skippedNote(parsed.skipped, envelope.skipped),
				});
			}
			// import
			const read = readStorageStore(storePath);
			if (!read.ok) {
				return `## Storage import — nothing to import for ${host}\n\n`
					+ `No usable store at ${storePath ?? '(unresolved path)'} (${read.reason}).\n`
					+ 'Export first (`action: "export"`) while that site is signed in, then import it here.';
			}
			const injected = await client._evaluate(buildWriteLocalStorageScript(read.areas.localStorage), 20_000);
			return formatStorageReport({
				action, host,
				summary: {
					localStorage: summarizeStorage(read.areas.localStorage, host),
					sessionStorage: summarizeStorage(read.areas.sessionStorage, host),
				},
				injected: typeof injected === 'number' ? injected : 0,
			});
		},
	});

	/**
	 * `browser` 工具的**完整定义**（注册与注销**共用同一份** —— 拆成两份必然漂移）。
	 *
	 * ⚠ 它被抽成常量是为了下面那个「**可见性门控**」：同一个定义会按"浏览器此刻是否可达"
	 * 被 register / dispose 若干次（见 `refreshAvailability`）。
	 */
	const toolDefinition = {
		name: 'browser',
		description: '用 CDP 驱动**本机真实 Chrome**（带你的登录态）：快照页面、导航、点击、输入、滚动，'
			+ '并处理登录墙、cookie 备份与页面内取值。'
			+ 'op：status / snapshot / images / navigate / click / type / pressEnter / pressKey / scroll / back / reset / login / cookies / evaluate / waitFor / find。'
			// 【选谁】2026-10-21：装了 ego lite 之后**有两个浏览器入口**，这里只做"选哪个"的提示，
			// 不改任何执行路径（`browser` 仍然只认 Chrome 的 CDP 端点 —— ego 是另一套，见 vssaros-ego/README）。
			// 为什么这条必须写在描述里：模型看不到插件清单，它只看工具描述 ⇒ 不写就等于"它不知道还有另一个"。
			+ '【选谁】若同时装了 ego lite（有 `ego_run` 工具）：让 agent **在后台连开很多页面 / 长时间跑**'
			+ '（每个 agent 一个隔离 Space、与你并行）的任务优先用 `ego_run`；'
			+ '要**复用你当前这个 Chrome 的登录态 / 已打开的标签页**就用本工具 —— ego 是**另一个浏览器**，两边的登录态不共通。'
			+ '【时序】动作类 op **完成后会自动等 DOM 稳定**（约 0.4s 内不抖了才回；`settleMs: 0` 关掉）⇒ 别再"点完立刻 snapshot"（那是拿旧帧 ✗）；'
			+ '要等明确的条件用 `op: "waitFor"`（`text` / `textGone` / `selector` / `urlContains` / `delayMs` 至少一条，AND 语义，超时会如实报哪个没到）；'
			+ '大页面别整页 snapshot：用 `op: "find"`（`text` 子串 / `regex` 正则，二选一）只回命中的那一小撮（ref / 标题 / 正文窗口）。'
			+ '【媒体】`op: "media"` 列出当前页的 video/audio（直链、时长、尺寸、是否在播）+ og 直链 + 资源清单里"像媒体"的请求 —— '
			+ '想找"这个视频能不能下载"时**先调它**（直链多半就在里面，且已登录页面的签名直链可直接用 HTTP 下载，不必装 yt-dlp）；'
			+ '`blob:` 源会如实单独报（那种不可下载）。'
			+ '⚠ 本工具由 **Host 侧**实现（不依赖 VsSaros）：动作类 op（navigate / click / type / pressEnter / '
			+ 'pressKey / back / reset / 会导航的 login）需要放行（独立入口默认只读，配置见 `allowActions`）；'
			+ '`scroll` 只移动视口、默认免确认；`cookies` 的 export/import 与 `evaluate` 既要各自开关、又每次都问。'
			+ 'click / type / scroll 的 ref 来自最近一次 snapshot；导航或重渲染后旧 ref 失效，需重新 snapshot。'
			+ '【登录墙】页面被判为登录墙时**不要**重试、也**不要**换回文本抓取（同一堵墙永远在那儿）：'
			+ '用 `op: "login"` 把页面打开到那个窗口，请用户**自己**登录一次（扫码也行；**绝不要**索要账号密码或 cookie），'
			+ '用户说好了之后用同 op 加 `done: true` 验证 —— 验证通过才去读页面。'
			+ '【cookie】`op: "cookies"` 的 `action: "inspect"` 只报该域名下有多少 cookie（只读）；'
			+ '`export` / `import` 用来备份 / 恢复登录态，**默认关闭**且每次都要审批，不是常规手段。'
			+ '【storage】`op: "storage"` 管 localStorage / sessionStorage：`action: "list"` 只报**键名/条数/字节数**'
			+ '（值不会回给你 —— 一个键可能就是活 token），用来判断"登录态是不是存在 localStorage 里"；'
			+ '`export` / `import` 用来**跨 profile 搬登录态**（很多站点把 token 放在 localStorage，只搬 cookie 会"看着登录了其实没登录"）。'
			+ '⚠ 它**按源隔离**：只作用于**当前页所在的那个源**，要搬别的站点你得先把页面开过去（本工具**不替你导航**）；'
			+ '`export` / `import` 默认关闭且每次都要审批，`sessionStorage` 只记录不注入（它随标签页消失）。'
			+ '【evaluate】`op: "evaluate"` 在**当前页面**里执行一段 JS 并取回值 —— `snapshot` / `images` 拿不到的'
			+ '页面数据（SPA 挂在 window 上的状态、按选择器批量取属性、localStorage 里的公开配置）走它。'
			+ '**默认关闭**（需 `allowEvaluate`），且**每次都**要用户批准 —— 批准弹窗里会回显你要跑的那段代码。'
			+ '**不要**用它搬 cookie / 凭据（那是 `cookies` 的事，且凭据值本就该留在浏览器里）。'
			+ '返回值是"页面里的值"而不是页面内容；跑 JS 可能改过 DOM ⇒ 旧的 ref 请重新 snapshot。'
			+ '【连不上时】若 `status` 报连不上、或某个 op 抛「CDP 端点全部不可达」：**不要重试** —— 那是'
			+ 'Host 侧连不上本机 Chrome 的调试端口，不是页面问题。错误文案里已经写了该做什么（请用户开一次'
			+ '远程调试 / 由 Host 拉起专属实例 / 改用文本通道），照着做并如实告诉用户。'
			+ '【多会话】每个会话有**自己**的标签页：多个会话同时用本工具不会串台（别人的导航不会顶掉你的页面，'
			+ '快照的 ref 也不会被互相清除）。`op: "reset"` 是**进程级**动作 —— 它会断开所有会话的连接'
			+ '（各自名下的页面仍保留，下次调用会重新附着回自己那一条）。',
		parameters: {
			type: 'object',
			properties: {
				op: { type: 'string', enum: KNOWN_OPS, description: '要做的操作' },
				url: { type: 'string', description: 'navigate / login 的目标地址；cookies 用它确定站点域名' },
				ref: { type: 'integer', description: '元素引用号（来自 browser_snapshot）' },
				text: { type: 'string', description: 'type 要输入的文字；find 要查的子串（大小写不敏感）；waitFor 要等出现的文本' },
				key: { type: 'string', description: 'pressKey 的按键名（如 Enter / Tab / ArrowDown）' },
				// 2026-10-14（P0-①③）：`waitFor` 的条件键 与 `find` 的检索键 —— 都是**可选**（语义互斥在
				//   各自 op 的归一化里判：不给/两个都给都报错，文案说清怎么改 ✓）。
				textGone: { type: 'string', description: 'waitFor 用：要等**消失**的文本' },
				selector: { type: 'string', description: 'waitFor 用：要等**出现且可见**的元素选择器（非法会立刻报错，不会让你等满超时）' },
				urlContains: { type: 'string', description: 'waitFor 用：要等 URL 里出现的子串' },
				delayMs: { type: 'integer', description: 'waitFor 用：纯等待毫秒数（0–30000）；与其它条件一起给是先睡再等（AND 语义）' },
				regex: { type: 'string', description: 'find 用：正则（如 `价格|到手价`）—— 与 `text` 二选一' },
				max: { type: 'integer', description: 'find 用：命中条数上限（默认 20，夹在 1–50）' },
				direction: { type: 'string', enum: ['up', 'down'], description: 'scroll 方向' },
				amount: { type: 'integer', description: 'scroll 像素数（正整数）' },
				append: { type: 'boolean', description: 'type 时追加而不是替换（默认替换 = 先全选）' },
				action: { type: 'string', enum: ['inspect', 'export', 'import', 'list'], description: 'cookies 用 inspect / export / import（缺省 inspect，只读）；storage 用 list（只读报告）/ export / import' },
				done: { type: 'boolean', description: 'login 用：true = 用户已登录完，去验证登录态（只读，不导航）' },
				expression: { type: 'string', description: 'evaluate 要执行的 JS（≤4000 字符）：要返回值就写成表达式或 IIFE，异步写成 async IIFE' },
				timeoutMs: { type: 'integer', description: 'evaluate 的超时毫秒数（不给用默认 20s，夹在 1s～120s）' },
			},
			required: ['op'],
		},
		// ⚠ dsh ≥ 0.2.1-alpha.1 起 `tools.register` **强制**要求 `output { schema, render }`
		//   （缺了整条 entry 不激活：`TypeError: tool "…" must declare output`）。
		//   本工具的每个 op 都返回**文本**（快照/说明/失败均可读）⇒ 声明 string + 文本渲染。
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
		},
		// 只读 op 可并行；有副作用的独占（与 IDE 侧 `isConcurrencySafe` 同口径，但判定含参数，见 `isActionOp`）。
		isConcurrencySafe: args => !isActionOp(args?.op, args),
		execute: async (params, exec) => {
			const op = typeof params?.op === 'string' ? params.op.trim() : '';
			/**
			 * ★ 多会话隔离的**唯一入口**（2026-10-13）：`exec.agent.id` 就是 dsh 的 **SessionId**
			 * （`@deepseek-ai/dsh-agent` 的类型：`interface Agent { readonly id: SessionId }`）。
			 *
			 * 拿它取一个**绑定视图** ⇒ 本次调用的每个 op 都只认**本会话自己那条 tab**：
			 *   · 别的会话的 `navigate` 不会把本会话的"当前页"顶掉（页面缓存在各自视图里）；
			 *   · 快照的 `ref` 不会被别的会话擦掉 —— `data-saros-ref` 是**页面级属性**，
			 *     两个会话共用一个 tab 时会互相 `removeAttribute`，表现为"ref 忽然全部失效"。
			 *
			 * 取不到身份（旧路径 / 测试 / 诊断）⇒ 退化为不隔离，行为与改动前**逐字一致**。
			 */
			const sessionKey = sessionKeyOf(exec);
			const client = baseClient.forSession(sessionKey);
			const handlers = createHandlers(client);
			const handler = Object.prototype.hasOwnProperty.call(handlers, op) ? handlers[op] : undefined;
			if (!handler) {
				throw new Error(`不认识的 browser op：${op || '(空)'}（可用：${KNOWN_OPS.join(' / ')}）`);
			}
			// 参数 / 开关校验必须在审批**之前**：否则用户会为一个必然失败的调用点确认
			// （`cookies` 的默认关闭开关就属这一类 —— 它连"要不要问"都不该问）。
			if (op === 'cookies') { precheckCookies(params); }
			if (op === 'storage') { precheckStorage(params); }
			if (op === 'evaluate') { precheckEvaluate(params); }
			// ★ 可达性也在审批**之前**（2026-10-13）：浏览器连不上时，用户不该为这次调用点"允许一次"
			//   （真机日志：授权卡 → 25s 等待 → 失败）。只在 `launchDedicated` 关着时才拦 —— 见 `requireReachable`。
			await requireReachable(op);
			// 确认在**参数校验之后、碰网络之前**：校验失败不该弹确认框（用户看着一个必然失败的调用被问）。
			const acted = isActionOp(op, params);
			if (acted) {
				await requestConsent(op, exec, params);
			}
			const out = await handler(params);
			// ★ 动作后**自动沉降**（2026-10-14，P0-②）：模型"点了立刻 snapshot"会拿到旧 DOM ✗ ⇒ 等页面指纹
			//   连续两拍相同再回（预算 400ms，慢加载走显式 `waitFor`）。`settleMs: 0` 显式关掉 ✓；
			//   它**不抛错**（沉降失败只是"信息可能旧"，不构成失败 ✓）。判据与轮询都在 `core/interaction.js`。
			if (acted && settleMs > 0) {
				await settleAfterAction(expr => client._evaluate(expr), settleMs);
			}
			return out;
		},
	};

	// ★★ **工具可见性门控**（2026-10-13：真机日志定位到的缺陷 1 的彻底修法）。
	//
	// ## 为什么需要它
	//
	// 真机日志：浏览器根本连不上，但 `browser` **仍然出现在模型的工具列表里** ⇒ 模型必然去试 ⇒
	// 弹一次授权 ⇒ 失败。而 IDE 侧**原本有**这个门控（"这 7 个工具**只在探测到 Chrome 调试端口
	// 可达时**才出现（默认至多 30 秒重探一次）"，见 `agentStudio.contribution.ts`）——
	// 移植到 Host 时被丢了，于是"看得见、永远用不了"。
	//
	// ## 机制（dsh 侧的可行性已取证）
	//
	// · `ctx.tools.register(def)` 返回 disposer，**可以在运行时注销**（先例：`vssaros-codebase`
	//   的 `ctx.effect(() => { const disposers = […].map(d => ctx.tools.register(d)); return () => disposers.forEach(d => d()); })`）；
	// · `@deepseek-ai/dsh-tools` 的 `'tools/change'` 事件（`@mode emit`，**不做 scope 过滤**）
	//   的文档原话是 "A tool was registered or unregistered… a global change concerns **every
	//   agent's next assembly**" ⇒ 增删会反映到模型看到的工具面 ✓（不需要我们额外通知）。
	//
	// ## 三条设计约束
	//
	//  ① **有兜底 ⇒ 恒注册（同步）**：`launchDedicated` 开着时"连不上"不等于"用不了"
	//     （`_connection()` 会自己拉起专属实例）⇒ 立刻注册，且**不必先探测**（默认路径零延迟、
	//     也不会因为探测慢而让模型在前几秒看不到工具）；
	//  ② **只在"确定不可用"时才撤下**：即 `launchDedicated` 关着 **且** 探测不通 —— 与
	//     `requireReachable` 用**同一条判据**（两条路判据不一致就会互相打架）；
	//  ③ **定时器必须 `unref()`**：它跟着 Host 进程活，绝不能因为它让 Host 退不掉。
	//
	// ⚠ 让路标记（`provide('vssarosBrowser')`）**不参与**这个门控：它决定的是"IDE 侧那套 `browser`
	// 要不要让位"，必须在**装配期同步**定下来（异步地撤一个 provide 没有意义）。所以极端情况是
	// "两边都没有 browser 工具" —— 那是**对的**：此刻浏览器就是不可用，给模型一个假入口更糟。
	let registration = undefined;

	const ensureRegistered = () => {
		if (registration) { return; }
		registration = ctx.tools.register(toolDefinition);
		log('[vssaros-browser] 浏览器可用 ⇒ `browser` 已对模型可见');
	};

	const dropRegistration = () => {
		if (!registration) { return; }
		const disposer = registration;
		registration = undefined;
		try {
			disposer?.dispose?.();
		} catch { /* 摘不掉也不该影响主流程（下次重探还会再试） */ }
		log('[vssaros-browser] 浏览器不可达 ⇒ `browser` 已从模型工具面撤下（重探到可达会自动回来）');
	};

	/** 按"现在到底能不能用"决定注册还是撤下。幂等 ⇒ 可以每 30 秒无脑调一次。 */
	const refreshAvailability = async () => {
		if (launchDedicated) { ensureRegistered(); return true; }
		const reach = await host.ensureReachable();
		if (reach.ok) { ensureRegistered(); return true; }
		dropRegistration();
		return false;
	};

	ctx.effect(() => {
		if (launchDedicated) {
			ensureRegistered();               // ① 默认路径：同步注册，模型立刻能用
		} else {
			void refreshAvailability();       // ② 无兜底：先探一次，通了才露面
		}
		const timer = setInterval(() => { void refreshAvailability(); }, AVAILABILITY_RECHECK_MS);
		timer.unref?.();                      // ③ 绝不阻塞 Host 退出
		return () => {
			clearInterval(timer);
			dropRegistration();               // 卸载时摘掉：否则热更新后会留下一个孤儿注册
		};
	});

	// ★ 会话结束时回收它名下的页面（2026-10-13，把多会话隔离收成闭环）。
	//
	// 为什么用 `agent/disposed`：它的 payload 就是 `{ agent }`（`@deepseek-ai/dsh-agent` 的
	// `lib/types/runtime-types.d.ts` 事件表里逐条列了 `agent/created` / `agent/disposed` / …），
	// 而 `agent.id` **正是**我们用作归属键的 SessionId ⇒ 不必猜、也不必自己维护一张"会话表"。
	//
	// ⚠ 三条纪律（都来自本仓已踩过的坑）：
	//   ① handler 里**不能 await**（与 `vssaros-memory` 挂 `agent/turn-stopping` 同一条：
	//      事件可能被串行派发、甚至被 await）⇒ 一律 `void` 排后台；
	//   ② 订阅本身可能失败（事件表随版本变）⇒ try/catch 兜住并**降级为"不回收"**
	//      （页面就留在浏览器里，与改动前一致 —— 不致命，但不能假装它生效了）；
	//   ③ 假 ctx 的 `on` 可能返回 `undefined` ⇒ 归一成函数再交给 `ctx.effect`
	//      （本仓那条"假 ctx 也算两边之一"的教训：卸载时对一个非函数调一次就抛）。
	ctx.effect(() => {
		try {
			const disposer = ctx.on('agent/disposed', payload => {
				const key = sessionKeyOf({ agent: payload?.agent });
				if (!key) { return; }
				void host.closeSessionPages(key).then(result => {
					if (result.closed.length > 0) {
						log(`[vssaros-browser] 会话 ${key} 结束 ⇒ 回收 ${result.closed.length} 个页面`);
					}
				}, err => {
					log(`[vssaros-browser] 会话 ${key} 的页面回收失败（忽略）：${err instanceof Error ? err.message : String(err)}`);
				});
			});
			return typeof disposer === 'function' ? disposer : () => { /* 无需摘除 */ };
		} catch (err) {
			log(`[vssaros-browser] 订阅 agent/disposed 失败 ⇒ 会话结束不再回收页面（其它功能不受影响）：${err instanceof Error ? err.message : String(err)}`);
			return () => { /* 没有订阅要摘 */ };
		}
	});

	ctx.effect(() => () => host.dispose());
}
