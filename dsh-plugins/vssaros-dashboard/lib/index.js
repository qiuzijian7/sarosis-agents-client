// @vssaros/dsh-dashboard — host half：会话遥测 / 用量汇总的自托管页面 + 只读工具。
//
// 数据：dsh 自己的会话投影缓存（`<DSH_HOME>/storages/session_projcache/sessions/<id>.json`）——
// 见 core/dashboard.js 的契约说明。**只读**，不声明 `owns`。
//
// 关于 live：**已接上**（2026-10-11，0.1.2）。API 形态从运行时源码逐字核对，不是猜的——
// `sessions.get(id)` → 活 Session 对象；`sessionProjections.stateOf(session, unit)` → 该单元的当前值
// （5 个单元名与缓存 `rows[unit]` **完全一致**）。合并口径：**live 优先且逐字段**（live 没给的字段保留
// 缓存值——把已读到的抹成未知比落后更糟）；"活会话存在 ≠ 已投影"：五个单元全 undefined 的行**仍标
// cache**，不谎报 live。两条通道（`sessions` / `sessionProjections`）**分别**可选注入：缺任一条只少
// 一路 live，**不影响缓存冷读这条主路径**（读活服务出任何差错都降级为纯缓存）。
//
// 只声明已证实的必需服务（tools/webServer/connection）；sessions / sessionProjections 走可选注入。
//
// 「运行状态」视图（0.1.3 起）：`todos`（**按轮**清单，`null` = 本轮还没写过 ⇒ 未知不伪装成 0）/ `plan`
// （**计划模式开关**的状态，不是任务清单）/ `userQuestions`（待用户回答或审批的条数）；0.1.4 又加
// `goal`（当前目标）/ `sandboxMode`（**执行器实际**沙箱模式）/ `permissions`（审批策略）/ `llmRetry`
// （**非空 = 此刻正在重试**）。这些都经 `sessionFromUnits` 一次装配 ⇒ **缓存冷读与 live 合并自动共用**
// （live 侧就是活跃会话的实时状态）。

import { activityTally, aggregate, applyLiveSessions, DATE_RANGES, filterSessionsByRange, formatMs, formatTokens, isActive } from './core/dashboard.js';
import { bindFoundation } from './foundationRef.js';
import { projCacheDirOf, readSession, readSessions } from './store.js';

import { readFileSync } from 'node:fs';

// ⚠ 逐项：`activityText` / `contextUsageText` / `isoOf` / `listMetaText` / `modelText` 仍被**工具输出**用到
//   （`dashboard_sessions` / `dashboard_session` 的文本）—— 页面搬到 React 后它们不能跟着一起删 ✗。
//   `getWidget` 随卡片渲染一起下线了；`normalizeWidgetConfig` 仍在用（见 `layoutForClient`：渲染前把
//   每张卡的 config 归一化一次，`sessions.limit` 夹紧 / `workbench.order` 过滤去重都靠它）。
import { activityText, contextUsageText, escapeHtml, groupByCwd, isoOf, listMetaText, metaBlock, modelText, normalizeWidgetConfig, serializeCatalog, sessionRowModel, SESSIONS_LIMIT_DEFAULT, summarizeModel, usageBuckets, WIDGETS, WORKBENCH_MODULES } from './catalog.js';

import { activePresetOf, DEFAULT_PRESET_NAME, defaultLayout, LAYOUT_VERSION, layoutCssVars, normalizeLayout, normalizeLayoutFile, normalizePresetName, normalizeSettings, serializeLayoutFile } from './layout.js';

import { layoutPath, mutateLayout, readLayout } from './layoutStore.js';

import { renderSideviewPage } from './sideview.js';


// ★ 2026-10-13（「dashboard → 可编排首页」P1：服务端组件化**等价重构**）：本文件从
//   「一整块写死顺序的 renderPage」改成**按布局渲染**：
//     · `lib/layout.js`  —— 布局层（纯函数：归一化 / 重排 / 夹紧；出厂默认布局也在这里）
//     · `lib/catalog.js` —— 组件目录（kpi / diag / sessions）＋ 呈现助手（原先都在本文件）
//     · 本文件           —— 数据整形（`collect` / `mergeLive` / `sessionRow`）＋ 路由 ＋ 整页组装
//   ⚠ 锚点与布局**解耦**：`data-vssaros-dashboard-*` 由一个隐藏元数据块**无条件**渲染 ⇒
//     组件被用户删掉也不影响探针 `p3-09`（见 `renderDashboardPage` 的注释）。
//   ⚠ P1 只有两个逃生门 `?layout=default|none`；**落盘布局是 P2 的事**（本文件不读任何文件）。
//
// ★ 2026-10-13（用户反馈"侧栏样式与原生差距大、缺打开按钮"）：**同一份数据、两种表面** ——
//   `?surface=sideview`（宿主在侧栏承载时注入）⇒ `lib/sideview.js` 的**摘要版**；
//   否则 ⇒ 本文件的**完整页**（可编排网格）。两条都渲染**同一个隐藏锚点块**（`metaBlock`）
//   ⇒ 探针 `p3-09` 与表面无关 ✓（它取的是不带参数的 URL，走的正是完整页这条 ✓）。

export const name = 'vssaros-dashboard';

// 只依赖 tools：工具在任何模板里都该可用。`webServer` / `connection` 只在 web 模板里存在，
// 写进静态 `inject` 会让整个插件在 headless / tui profile 里**永久 pending**，连工具一起失效
//（2026-10-12 照 kanban / skills / workflow 的现成写法收窄 ✓，见 `doc/dsh-modules-conformance.html` §5-9）。
export const inject = ['tools'];

const ROUTE_PREFIX = '/x/dashboard';
/**
 * 插件版本号，**渲染进页面**（页面上那行淡淡的 `vssaros-dashboard 0.4.x`）。
 *
 * 为什么要有这个：真机出现过"主页看起来是旧样式"的排查，最后发现是**两个窗口跑着不同版本**
 * （旧壳没有版本号、也没有「范围」那行）。版本写在页面上 ⇒ 一眼能判断"我看到的是哪一版"，
 * 不用再猜是缓存、是没重启、还是代码没生效。
 * ⚠ 从 `package.json` 读，**不手写常量**（手写必然与真实版本漂移）。
 */
const PLUGIN_VERSION = (() => {
	try {
		return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
	} catch {
		return '0.0.0';
	}
})();
const TOOL_NAMES = ['dashboard_sessions', 'dashboard_session'];
/**
 * 页面扫描（以及 `/api/sessions` 默认、以及会话明细组件默认）的条数上限。
 *
 * ⚠ 与 `catalog.js` 的 `SESSIONS_LIMIT_DEFAULT` **同源**（曾各自写死一个 50 ⇒ 会漂移 ✗）；
 * 组件自己的条数可配（见 `sessions` 的 `normalizeConfig`），但**扫描面**始终按这个值走。
 */
const PAGE_LIMIT = SESSIONS_LIMIT_DEFAULT;

/** 布局写入面的请求体上限（页面递的东西不该能把 Host 撑爆 ✓；布局 JSON 正常只有几 KB）。 */
const LAYOUT_BODY_LIMIT = 64 * 1024;

/**
 * 页面用到的**静态资源**（模块加载期一次读进内存）。
 *
 * 为什么不再把客户端脚本读成文本内联进页面：
 *   · React 版是 esbuild 打的单文件产物（~160KB），内联进 HTML 每次导航都重传、也没法缓存；
 *   · 它必须能被浏览器当**独立脚本**加载（script src）⇒ 走静态路由。
 *
 * ⚠ 只用**白名单**（不是拼路径）⇒ 不可能被目录穿越读到别处；
 * ⚠ 读不到就**整包加载失败**（与从前内联的做法同一条纪律：比"页面白屏、按钮没反应"好得多）；
 * ⚠ cache-control: no-store —— 插件换版后旧产物不能留在浏览器缓存里（本仓在这上面踩过）。
 */
const ASSETS = new Map([
	['/app/dashboard-app.js', { file: new URL('./app/dist/dashboard-app.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
	['/app/dashboard-app.css', { file: new URL('./app/dist/dashboard-app.css', import.meta.url), type: 'text/css; charset=utf-8' }],
	['/theme/base.css', { file: new URL('../vendor/dsw-theme/base.css', import.meta.url), type: 'text/css; charset=utf-8' }],
	['/theme/design-platform.css', { file: new URL('../vendor/dsw-theme/design-platform.css', import.meta.url), type: 'text/css; charset=utf-8' }],
	['/theme/gradient-shadow-text.css', { file: new URL('../vendor/dsw-theme/gradient-shadow-text.css', import.meta.url), type: 'text/css; charset=utf-8' }],
	['/theme/scrollbar.css', { file: new URL('../vendor/dsw-theme/scrollbar.css', import.meta.url), type: 'text/css; charset=utf-8' }],
]);
for (const [key, asset] of ASSETS) {
	asset.body = readFileSync(asset.file);
	if (!asset.body || asset.body.length === 0) {
		throw new Error('静态资源是空文件：' + key);
	}
}

/**
 * 塞进 `<script type="application/json">` 的 JSON 岛：把 `<` 转义成 `\u003c` ⇒
 * 内容里出现 `</script>` 也**绝不会**提前闭合脚本 ✓（页面把布局与目录交给客户端，靠的就是这两个岛）。
 */
function jsonIsland(value) {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * 读 JSON 请求体。**不信任任何输入**：超限 / 空 / 不是 JSON 都返回可读原因 ✓。
 * ⚠ 用 `for await` 读**流**（真机是 `IncomingMessage`）⇒ 探针里的假 req 必须提供 `Symbol.asyncIterator` ✓。
 */
async function readJsonBody(req, limit) {
	let text = '';
	try {
		for await (const chunk of req) {
			text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
			if (text.length > limit) {
				return { error: `请求体超过上限（${limit} 字节）` };
			}
		}
	} catch (e) {
		return { error: `请求体读取失败：${e?.message ?? e}` };
	}
	if (!text.trim()) {
		return { error: '请求体为空' };
	}
	try {
		return { value: JSON.parse(text) };
	} catch (e) {
		return { error: `请求体不是合法 JSON：${e?.message ?? e}` };
	}
}

/**
 * 解析"这一页该用哪份布局"（P2）。优先级：查询参数 → 落盘文件 → 出厂默认。
 *
 *   · `?layout=default` ⇒ 出厂默认（逃生门，Q3）；`?layout=none` ⇒ 一张卡都不放
 *     （排障入口 + "锚点与布局无关"的取证手段 ✓）；
 *   · 其余 ⇒ 读 `<数据根>/dashboard/layout.json`。**不存在 = 首启 ⇒ 静默用默认** ✓（不该为"还没编排过"
 *     报一个看起来像错的提示 ✗）；存在但读不了 / 有被纠正的项 ⇒ 落回默认**并带上 note**（页面会说 ✓）。
 *
 * 返回 `{ items, settings, note, source }`；`source` 是给探针与排障看的一句话来源
 * （`query:none` / `query:default` / `file` / `file:error` / `default:missing`）✓。
 */
async function resolveLayout(config, param, presetParam) {
	const fromConfig = normalizeSettings(config?.layout);
	// ⚠ **无论哪个模式都要读一次盘**：客户端保存时要拿 `updatedAt` 做 CAS，而它必须来自**盘上那份**
	//   （哪怕这一页展示的是 `?layout=default` 的预览）—— 否则"预览默认布局后保存"会拿一个 0 去比，
	//   必然误报 409 ✗。文件不存在 ⇒ stamp = 0（首启，那本来就是"没有"的诚实表示 ✓）。
	//
	// ★ 多套布局（2026-10-22）：盘上是 `{ active, presets }`；老形状（单布局）由 `normalizeLayoutFile`
	//   在**内存里**包成 `presets.default`，**不写盘** ⇒ "读一页不该产生文件"那条纪律仍然成立 ✓。
	const read = await readLayout(config);
	const file = normalizeLayoutFile(read.layout);
	const wanted = normalizePresetName(presetParam);
	// `?preset=xxx` 只是**预览**（不改变盘上的 active）；名字不存在 ⇒ 按 active 显示并如实说明
	const previewName = wanted && file.presets.has(wanted) ? wanted : undefined;
	const activeName = previewName ?? file.active;
	const entry = file.presets.get(activeName);
	const names = [...file.presets.keys()];
	const stamp = Number.isFinite(entry?.updatedAt) ? entry.updatedAt : 0;
	const presetNote = wanted && !previewName
		? `预设 ${wanted} 不存在（现有：${names.join(' / ')}）⇒ 显示当前布局`
		: '';
	const base = { active: activeName, names, stamp };

	if (param === 'none') {
		return { ...base, items: [], settings: fromConfig, note: presetNote, source: 'query:none' };
	}
	if (param === 'default') {
		return { ...base, items: defaultLayout(), settings: fromConfig, note: presetNote, source: 'query:default' };
	}
	const items = entry?.items ?? defaultLayout();
	const settings = normalizeSettings(entry?.settings) ?? fromConfig;
	if (read.error) {
		return { ...base, items, settings, note: `首页布局读不了，已回到出厂默认：${read.error}`, source: 'file:error' };
	}
	if (read.missing) {
		return { ...base, items, settings, note: presetNote, source: 'default:missing' };
	}
	const note = [
		presetNote,
		file.repaired.length ? `首页布局有 ${file.repaired.length} 处被自动纠正：${file.repaired.join('；')}` : '',
	].filter(Boolean).join('；');
	return { ...base, items, settings, note, source: 'file' };
}
/** 工具 output schema 里「运行状态」的形状——**两个工具共用一份**（写两份必然漂移）。 */
const ACTIVITY_SCHEMA = {
	type: 'object',
	description: '「运行状态」：turn 回合在不在跑 / goal 目标 / todos 按轮清单 / plan **计划模式** / sandbox 沙箱 / permissions 审批策略 / retrying 正在重试（LLM）/ inbox 排队待发 / pendingQuestions 待用户回答。**缺席即未知**。',
	properties: {
		goal: { type: 'string' },
		todos: {
			type: 'object',
			properties: {
				total: { type: 'integer' }, pending: { type: 'integer' }, inProgress: { type: 'integer' },
				completed: { type: 'integer' }, current: { type: 'string' },
			},
		},
		plan: { type: 'object', properties: { active: { type: 'boolean' }, wanted: { type: 'boolean' } } },
		sandbox: { type: 'string' },
		permissions: {
			type: 'object',
			properties: { preset: { type: 'string' }, sandbox: { type: 'string' }, approval: { type: 'string' } },
		},
		retrying: { type: 'object', properties: { retry: { type: 'integer' }, keys: { type: 'integer' } } },
		turn: { type: 'object', properties: { running: { type: 'boolean' }, lastTurn: { type: 'integer' } } },
		inbox: {
			type: 'object',
			description: '用户已发出、还排在队里的输入（inbox）：turn = 等着各开一轮的、step = 等下一个 step 边界的、queued = 两者之和。**空数组是已知的 0**，单元缺席才是未知。',
			properties: { turn: { type: 'integer' }, step: { type: 'integer' }, queued: { type: 'integer' } },
		},
		pendingQuestions: { type: 'integer' },
	},
};

// ⚠ 2026-10-13（P1 组件化）：原先这里的呈现助手（escapeHtml / shortPath / isoOf / activityText /
// contextUsageText / contextBreakdownText / modelText / listMetaText / titleInputText / subagentText）
// 已**原样搬**到 `lib/catalog.js`（组件目录与它的渲染助手放一处）。`sessionRow` / `mergeLive` /
// `collect`（数据整形，工具与 API 也用）留在本文件 ✓。整页组装见 `renderDashboardPage`。
/** 会话行（页面与工具共用；`unknown` 一律写"未知"，不写 0）。 */
function sessionRow(session) {
	return {
		id: session.id,
		title: session.title,
		cwd: session.cwd,
		preset: session.preset,
		createdAt: session.createdAt,
		source: session.source,
		active: isActive(session),
		turns: session.stats?.turns,
		steps: session.stats?.steps,
		llmMs: session.stats?.llmMs,
		toolMs: session.stats?.toolMs,
		uncachedInputTokens: session.tokens?.uncachedInput,
		outputTokens: session.tokens?.output,
		cacheReadTokens: session.tokens?.cacheRead,
		cacheWriteTokens: session.tokens?.cacheWrite,
		surfaceTokens: session.surfaceTokens,
		contextWindow: session.contextWindow,
		contextBreakdown: session.contextBreakdown,
		model: session.model,
		listMeta: session.listMeta,
		titleInput: session.titleInput,
		subagent: session.subagent,
		activity: session.activity,
	};
}

/**
 * 两条 live 通道都在时才做合并（否则原样返回）；读活服务出任何差错**一律降级为纯缓存**——
 * 宁可在页面上显示"落后一点"，也不能让一个**可选**服务把只读主路径带崩。
 */
function mergeLive(rows, state) {
	if (!state?.sessions || !state?.projections) {
		return { sessions: rows, live: 0 };
	}
	try {
		return applyLiveSessions(rows, {
			getLive: id => state.sessions.get(id),
			readUnit: (session, unit) => state.projections.stateOf(session, unit),
		});
	} catch {
		return { sessions: rows, live: 0 };
	}
}

async function collect(config, limit, state) {
	const { sessions, errors, dir, missing, truncated, remaining } = await readSessions(config, { limit });
	const { sessions: rows, live } = mergeLive(sessions, state);
	return { summary: aggregate(rows), errors, dir, missing, truncated, remaining, live };
}


/**
 * 组装整页 HTML。
 *
 * ★ 2026-10-13（P1：服务端组件化**等价重构**）：本函数以前是一整块「写死顺序」的 HTML；
 *   现在按**布局**逐块挑组件渲染 —— 布局层 `layout.js`（纯函数）＋ 组件目录 `catalog.js`。
 *
 * ⚠ **锚点与布局解耦**（本改造的核心不变量）：16 个由组件数据派生的 `data-vssaros-dashboard-*`
 *   属性，从「诊断行」这块**可被用户删掉**的组件里搬进了下面那个隐藏元数据块，且**无条件渲染** ⇒
 *   无论用户怎么编排，探针 `p3-09` 的锚点都还在 ✓（否则"用户改布局 ⇒ 守卫变红"是必然的 ✗）。
 *   `scope` / `range` 两条留在页级说明行上（那是页级口径、不是组件内容，本来就不该被删）。
 *
 * ⚠ `layout` / `settings` / `layoutNote` 三个参数由路由的 `resolveLayout()` 递进来（P1 起 `layout` 就能
 *   直接传 —— 探针据此渲染"任意布局"来断言锚点与布局无关 ✓）。
 * ⚠ 三块从「body 直接子节点」变成「网格项」后，相邻外边距**不再折叠**（flex/grid 项之间不折叠）
 *   ⇒ 纵向间距会比改造前大几个 px；内容与锚点逐字未变，且 P3 的网格本来就要接管间距。
 */
/**
 * 页面数据（汇总 + 组件模型 + 交给客户端的布局）**只装配一次**（2026-10-22）。
 *
 * 为什么抽出来：SSR 页（`renderDashboardPage`）与 **React 工作台**（`?format=json`）都要这份数据 ⇒
 * 各算一遍必然漂移（"页面说 32 条、工作台说 30 条"）✗。口径仍全在 `catalog.summarizeModel()` 一处 ✓。
 */
export function buildDashboardPayload({ data, config, toolsRegistered, liveServices, range = 'all', layout = defaultLayout(), settings }) {
	const { summary, tally, tokenLine, model } = summarizeModel(data, range, { toolsRegistered, liveServices });
	const widgetModel = {
		range,
		data,
		summary: { ...summary, sorted: undefined },
		tally,
		tokenLine,
		toolsRegistered,
		liveServices,
		sessions: summary.sorted.map(sessionRowModel),
		workbench: WORKBENCH_MODULES,
		workspaces: groupByCwd(summary.sorted, 30),
		usage: usageBuckets(model),
		// 版本号也随载荷下发：**两个前端**都用它（模块页印在页面中缝、注册式工作台印在顶栏）
		// ⇒ 排查"样式不对"时先看版本，不用再猜是缓存还是没重启 ✓
		version: PLUGIN_VERSION,
	};
	// 每张卡的 `config` 在**交给客户端之前**归一化一次（`sessions.limit` 夹紧 / `workbench.order` 过滤去重…）：
	//   宿主做第一道，React 侧的 `clampInt` 只当第二道防线 ✓。
	const layoutForClient = layout.map(item => ({
		...item,
		config: normalizeWidgetConfig(WIDGETS.find(widget => widget.kind === item.kind), item.config),
	}));
	return { summary, tally, tokenLine, model, widgetModel, layoutForClient };
}

export function renderDashboardPage({ data, config, toolsRegistered, liveServices, range = 'all', layout = defaultLayout(), settings, layoutNote = '', layoutStamp = 0, activePreset = DEFAULT_PRESET_NAME, presetNames = [DEFAULT_PRESET_NAME] }) {
	const { errors, dir, missing, truncated } = data;
	// ── 日期范围（README 5.74）：与 `/api/sessions` 用**同一个纯函数** ✓ ────────────────────────────
	// 这里把 `summary` **整体重算**成"范围内"的那一份 ⇒ 卡片 / 运行清点 / 明细列表**全都跟着范围走** ✓。
	// ⚠ 只换列表不换卡片，页面就会自相矛盾（"总数 50、明细 3 条"）—— 那比不做筛选更让人困惑 ✗。
	// ⚠ 2026-10-13：这段口径**抽到 `catalog.summarizeModel()`**，与侧栏紧凑版（`lib/sideview.js`）
	//   **共用同一处** —— 两版各算一遍必然漂移（"侧栏 32、完整页 30"）✗。语义与抽取前逐字等价 ✓
	//   （「运行中」清点仍**只数已知的**：没有会话带 todos 单元时 `todoSessions` 缺席 ⇒ 卡片不出现，而不是显示 0）。
	// 组件网格 / 工具条 / 画廊 **全部由页面里的 React 应用渲染**（lib/app/src/app.jsx）：
	//   服务端只出「壳 + 数据岛」⇒ 两套 UI 只剩一套实现（原先 pageClient.js 那套手写 DOM 已下线）。
	//   ⚠ 岛里的展示数据一律由 catalog.js 算（会话行文案 / 工作区分组 / 用量分桶 / 工作台清单）
	//     ⇒ 与侧栏版、与 /api/sessions 共用同一处口径，不会漂移。
	// ★ 2026-10-22：装配抽到 `buildDashboardPayload()`（React 工作台走 `?format=json` 吃同一份 ✓）。
	const built = buildDashboardPayload({ data, config, toolsRegistered, liveServices, range, layout, settings });
	const { summary, tally, tokenLine, widgetModel, layoutForClient } = built;
	// ⚠ 再夹一次：本函数可以被**直接调用**（探针 / 将来的其它入口）⇒ 不假设调用方已经归一化过。
	const vars = layoutCssVars(normalizeSettings(settings) ?? normalizeSettings(config?.layout) ?? {});
	// ▲ 隐藏元数据块：**机器可断言的锚点**（与用户布局无关、与承载表面无关 —— 见 catalog.metaBlock）。
	const meta = metaBlock({ data, summary, tally, toolsRegistered, liveServices });

	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>主页 · VsSaros</title>
<link rel="stylesheet" href="${ROUTE_PREFIX}/theme/base.css">
<link rel="stylesheet" href="${ROUTE_PREFIX}/theme/design-platform.css">
<link rel="stylesheet" href="${ROUTE_PREFIX}/theme/gradient-shadow-text.css">
<link rel="stylesheet" href="${ROUTE_PREFIX}/theme/scrollbar.css">
<link rel="stylesheet" href="${ROUTE_PREFIX}/app/dashboard-app.css">
<style>
	/* 页面级外壳（组件样式在 dashboard-app.css）。⚠ 本段在模板字符串里：注释绝不能出现反引号。 */
	html { color-scheme: light dark; }
	body { margin: 0; padding: 16px; font: 13px/1.6 system-ui, "Segoe UI", sans-serif;
		color: var(--dsw-alias-label-primary, #ccc); background: var(--dsw-alias-bg-base, #1f1f1f); }
	h1 { font-size: 14px; margin: 0 0 6px; font-weight: 600; }
	h1 small { font-weight: 400; color: var(--dash-muted, #999); }
	.diag, .empty { color: var(--dash-muted, #999); font-size: 12px; margin: 4px 0; }
	.diag a { color: var(--dsw-alias-brand-primary, #4C9AFF); }
	code { font-family: ui-monospace, Consolas, monospace; }

/* 页脚（2026-10-23）：范围切换与版本号从页头下沉到这里 —— 页头只留标题，功能不丢。 */
.dash-foot {
	display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
	margin: 14px 0 4px; padding-top: 10px;
	border-top: 1px solid var(--dash-stroke, rgba(127,127,127,.3));
	font-size: 12px; color: var(--dash-faint, inherit);
}
.dash-foot a { color: var(--dsw-alias-brand-primary, #4C9AFF); text-decoration: none; }
.dash-foot a:hover { text-decoration: underline; }
.dash-foot b { font-weight: 600; }
.dash-foot-ver { margin-left: auto; opacity: .75; }
</style>
</head>
<body data-vssaros-page="dashboard">

<h1>主页 <small>dsh 会话遥测 / 用量（只读）</small></h1>
${layoutNote ? `<p class="diag" data-vssaros-dashboard-layout-note="1">${escapeHtml(layoutNote)}</p>` : ''}${meta}<div data-dash-app-root="1" data-dash-api="${escapeHtml(ROUTE_PREFIX)}/api/layout" data-dash-count="${layoutForClient.length}" data-dash-version="${escapeHtml(PLUGIN_VERSION)}" style="--dash-row: ${vars.row}; --dash-gap: ${vars.gap}; --dash-max-width: ${vars.maxWidth}"></div>
<div class="dash-foot" data-vssaros-dashboard-foot="1"><span class="dash-foot-range" data-vssaros-dashboard-range="${escapeHtml(range)}">范围：${DATE_RANGES.map(item => item.range === range ? `<b>${escapeHtml(item.label)}</b>` : `<a href="${ROUTE_PREFIX}/?range=${item.range}">${escapeHtml(item.label)}</a>`).join(' · ')}</span><span class="dash-foot-ver" data-dash-version="${escapeHtml(PLUGIN_VERSION)}">vssaros-dashboard ${escapeHtml(PLUGIN_VERSION)}</span></div>
${missing ? `<p class="empty">投影缓存目录还不存在：<code>${escapeHtml(missing)}</code>（dsh 还没写过会话，或 DSH_HOME 配错了）。</p>` : ''}
${truncated ? '<p class="diag">目录里还有更多会话，已按上限截断。</p>' : ''}
${errors.length ? `<p class="diag">${errors.length} 个缓存文件读不了：${escapeHtml(errors.slice(0, 3).join('；'))}${errors.length > 3 ? ' …' : ''}</p>` : ''}
${truncated ? `<p class="diag">…另有 ${data.remaining ?? 0} 个，用 dashboard_sessions 工具查看。</p>` : ''}
<script type="application/json" data-dash-layout-json>${jsonIsland({ version: LAYOUT_VERSION, updatedAt: layoutStamp, settings: normalizeSettings(settings) ?? null, items: layoutForClient, active: activePreset, presets: presetNames })}</script>
<script type="application/json" data-dash-model-json>${jsonIsland(widgetModel)}</script>
<script type="application/json" data-dash-catalog-json>${jsonIsland(serializeCatalog(new Set(layoutForClient.map(item => item.kind))))}</script>
<script src="${ROUTE_PREFIX}/app/dashboard-app.js"></script>
</body>
</html>`;
}

function toolDefinitions(ctx, state, config) {
	return [{
		name: 'dashboard_sessions',
		description: '列出 dsh 会话及其遥测（turn/step 数、模型与工具耗时、token 用量），并给出汇总。数据来自会话投影缓存（只读）。',
		parameters: {
			type: 'object',
			properties: {
				// dsh 的参数 schema 只接受受限子集（无 minimum/maximum）：范围写描述、由代码夹紧
				limit: { type: 'integer', description: '返回的会话条数上限，1–200（默认 20；超出会被夹到边界）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					summary: {
						type: 'object',
						properties: {
							sessions: { type: 'integer' }, active: { type: 'integer' },
							live: { type: 'integer', description: '其中由活服务（sessions + sessionProjections）覆盖的行数' },
							turns: { type: 'integer' }, steps: { type: 'integer' },
							llmMs: { type: 'integer' }, toolMs: { type: 'integer' },
							activity: {
								type: 'object',
								description: '「运行状态」清点（**只含已知项且只含非零项**，缺席即未知／为 0）：todoSessions / inProgress / activePlans / waiting / retrying / running（回合进行中的会话数）/ turns（已完成回合合计）/ queued（排队待发条数合计）/ subagentSessions（**自己是**子代理的会话数）/ subagentRunning（子代理正在跑的会话数）/ subagentChildren（派出的直接子代理总数）',
								properties: {
									todoSessions: { type: 'integer' }, inProgress: { type: 'integer' },
									activePlans: { type: 'integer' }, waiting: { type: 'integer' }, retrying: { type: 'integer' },
									running: { type: 'integer' }, turns: { type: 'integer' }, queued: { type: 'integer' },
									subagentSessions: { type: 'integer' }, subagentRunning: { type: 'integer' }, subagentChildren: { type: 'integer' },
								},
							},
						},
						required: ['sessions', 'active'],
					},
					sessions: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								id: { type: 'string' }, title: { type: 'string' }, cwd: { type: 'string' },
								preset: { type: 'string' }, turns: { type: 'integer' }, steps: { type: 'integer' },
								outputTokens: { type: 'integer' }, cacheReadTokens: { type: 'integer' },
								active: { type: 'boolean' },
								source: { type: 'string', description: 'cache = 投影缓存冷读；live = 活会话覆盖' },
								activity: ACTIVITY_SCHEMA,
							},
							required: ['id'],
						},
					},
				},
				required: ['summary', 'sessions'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `会话 ${value.summary.sessions} 个（活跃 ${value.summary.active}${value.summary.live ? `，其中 ${value.summary.live} 个由 live 覆盖` : ''}）· turn ${value.summary.turns ?? '未知'} · step ${value.summary.steps ?? '未知'}`
					+ `${value.summary.activity?.todoSessions !== undefined ? ` · 进行中待办 ${value.summary.activity.inProgress}` : ''}`
					+ `${value.summary.activity?.waiting ? ` · 待用户回答 ${value.summary.activity.waiting}` : ''}`
					+ `${value.summary.activity?.running ? ` · 回合进行中 ${value.summary.activity.running}` : ''}\n`
					+ value.sessions.map(s => `- ${s.id} ${s.title ?? '(无标题)'}：turn ${s.turns ?? '未知'}，输出 token ${s.outputTokens ?? '未知'}（${s.source ?? 'cache'}）`
						+ `${s.activity ? `｜${activityText(s.activity)}` : ''}`).join('\n'),
			}],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const limit = Math.min(200, Math.max(1, Number.isFinite(params?.limit) ? Math.floor(params.limit) : 20));
			const { summary, live } = await collect(config, limit, state);
			return {
				summary: {
					sessions: summary.sessions,
					active: summary.active,
					live: live ?? 0,
					// 「运行中」清点（只含已知项；全未知时是 `{}`——不是一个伪装成 0 的对象）
					activity: activityTally(summary.sorted),
					...(summary.turns !== undefined ? { turns: summary.turns } : {}),
					...(summary.steps !== undefined ? { steps: summary.steps } : {}),
					...(summary.llmMs !== undefined ? { llmMs: summary.llmMs } : {}),
					...(summary.toolMs !== undefined ? { toolMs: summary.toolMs } : {}),
				},
				sessions: summary.sorted.slice(0, limit).map(sessionRow)
					// schema 里声明为可选整数：去掉 undefined 字段，避免校验器把它当类型不符
					.map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))),
			};
		},
	}, {
		name: 'dashboard_session',
		description: '查看某个 dsh 会话的遥测明细（用 dashboard_sessions 得到的会话 id）。',
		parameters: {
			type: 'object',
			properties: { sessionId: { type: 'string', description: '会话 id（形如 session-<uuid>）' } },
			required: ['sessionId'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					id: { type: 'string' }, title: { type: 'string' }, cwd: { type: 'string' }, preset: { type: 'string' },
					createdAt: { type: 'integer' }, turns: { type: 'integer' }, steps: { type: 'integer' },
					llmMs: { type: 'integer' }, toolMs: { type: 'integer' },
					outputTokens: { type: 'integer' }, cacheReadTokens: { type: 'integer' }, surfaceTokens: { type: 'integer' },
					contextWindow: { type: 'integer', description: '上下文窗口大小（contextPressure v5 起才有；缺则未知）' },
					contextBreakdown: {
						type: 'object',
						description: '表面构成（contextBreakdown v5；**启发式估算**）。owner 包保证 `system + messages == surface`；`tools` 是工具定义那部分、**不在表面里**。',
						properties: {
							system: { type: 'integer' }, messages: { type: 'integer' }, tools: { type: 'integer' },
							nodes: { type: 'integer' }, surface: { type: 'integer' },
						},
					},
					model: {
						type: 'object',
						description: '模型选择（modelSelection v2）：used = 最近一次请求**实际**用的（权威）；pending = 用户已选、**尚未生效**。',
						properties: {
							used: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' } } },
							pending: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' } } },
						},
					},
					listMeta: {
						type: 'object',
						description: '冷会话列表摘要提示（sessionListMetadata）：blank = 折叠前缀里**没有回合**（空白会话，产品权威口径）；lastPromptAt = 最新**人类**提示时间（`null` = 没有人提示过；字段缺席才是未知）。',
						properties: { blank: { type: 'boolean' }, lastPromptAt: { type: 'integer' } },
					},
					subagent: {
						type: 'object',
						description: '子代理四件（owner：`@deepseek-ai/dsh-subagent` / `dsh-tool-subagent`）：role = 本会话**自己是子代理**（mode one-shot/continuable + label）；timing = 活跃时长（running 非空即有 active 窗口）；children = **派出去的直接子代理**（count + 模式分布；head 缺席 = 已知的 0）；policy = 允许子代理显式选的路由（null 与"没有记录"同义 ⇒ 缺席）。',
						properties: {
							role: {
								type: 'object',
								properties: { mode: { type: 'string' }, label: { type: 'string' }, seq: { type: 'integer' } },
							},
							timing: {
								type: 'object',
								properties: {
									settledMs: { type: 'integer' }, running: { type: 'boolean' },
									activeMs: { type: 'integer' }, lastTurnCompleted: { type: 'boolean' },
								},
							},
							children: {
								type: 'object',
								properties: {
									count: { type: 'integer' }, oneShot: { type: 'integer' },
									continuable: { type: 'integer' }, unknown: { type: 'integer' }, lastChildAt: { type: 'integer' },
								},
							},
							policy: { type: 'object', properties: { routes: { type: 'integer' } } },
						},
					},
					titleInput: {
						type: 'object',
						description: 'titleInput v3：**有资格参与标题生成**的人类文本消息的**有界聚合**（count = 条数；firstSeq/firstText = 最早一条的 seq 与正文前 80 字符；lastSeq = 最新一条的 seq）。**不是"全部用户消息"**。',
						properties: {
							count: { type: 'integer' }, firstSeq: { type: 'integer' },
							firstText: { type: 'string' }, lastSeq: { type: 'integer' },
						},
					},
					source: { type: 'string' },
					activity: ACTIVITY_SCHEMA,
				},
				required: ['id', 'source'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `${value.id}（${value.source}）\n标题：${value.title ?? '未知'}\n目录：${value.cwd ?? '未知'}\npreset：${value.preset ?? '未知'}\n创建：${isoOf(value.createdAt)}\n`
					+ `turn ${value.turns ?? '未知'} · step ${value.steps ?? '未知'} · LLM ${formatMs(value.llmMs)} · 工具 ${formatMs(value.toolMs)}\n`
					+ `token：输出 ${value.outputTokens ?? '未知'} · 读缓存 ${value.cacheReadTokens ?? '未知'} · 表面 ${value.surfaceTokens ?? '未知'}${contextUsageText(value)}`
					+ `${value.model ? `\n${modelText(value)}` : ''}`
					+ `${listMetaText(value) ? `\n摘要${listMetaText(value)}` : ''}`
					+ `${value.activity ? `\n运行中：${activityText(value.activity)}` : ''}`,
			}],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const sessionId = typeof params?.sessionId === 'string' ? params.sessionId.trim() : '';
			if (!sessionId || /[\\/]|\.\./.test(sessionId)) {
				throw new Error(`sessionId 形态不合法：${sessionId || '(空)'}`);
			}
			const result = await readSession(config, sessionId);
			if (result.error) {
				throw new Error(result.error);
			}
			// 单条也走 live 合并（与列表同一套口径）：活会话存在就把最新单元读值盖上去，标 source=live。
			const merged = mergeLive([result.session], state).sessions[0] ?? result.session;
			return Object.fromEntries(Object.entries(sessionRow(merged)).filter(([, value]) => value !== undefined));
		},
	}];
}

export function apply(ctx, config = {}) {
	// 重构 1.3：绑定 foundation 共享服务（dataRoot/dshHome/pageShell/lock 的真源）。
	{
		// 同步直读在前：有插件在 apply 的**同步段**就建 store（inject 回调是异步的，会来不及 ✗）。
		let ready = null;
		try { ready = ctx.get?.('vssarosFoundation') ?? ctx.vssarosFoundation ?? null; } catch { /* 探针的 Proxy 假 ctx 对未知属性抛错 ⇒ 当不存在 */ }
		if (ready) { bindFoundation(ready); }
		ctx.inject(['vssarosFoundation'], child => {
		let svc = null;
		try { svc = child.vssarosFoundation ?? null; } catch { /* 探针的假 ctx（Proxy）对未知属性抛错 ⇒ 当不存在 */ }
		if (svc) { bindFoundation(svc); }
	});
	}
	const state = { tools: null, live: false, sessions: null, projections: null };

	// live 通道①：`sessions`（`get(id)` → 活 Session 对象）。
	ctx.inject(['sessions'], child => child.effect(() => {
		state.sessions = child.sessions;
		state.live = true;
		return () => {
			state.sessions = null;
			state.live = false;
		};
	}));
	// live 通道②：`sessionProjections`（`stateOf(session, unit)` → 该单元当前值）。
	// **分开注入**：任一条缺席只少一路 live，不该让另一条也失效（两条都到位才真的合并）。
	ctx.inject(['sessionProjections'], child => child.effect(() => {
		state.projections = child.sessionProjections;
		return () => {
			state.projections = null;
		};
	}));

	ctx.effect(() => {
		// ── R13（preset plane）：同一个包会被挂**两次**（host plane + 我们的 preset ✓）──
		// `hostHalf: true` ⇒ 这次只注册页面，**不注册工具**（工具交给 preset 里那次 ✓）；
		// 缺省 ⇒ **与从前完全一样** ✓（零行为改变）。另外两条 live 注入（`sessions` /
		// `sessionProjections`）**不受影响** ✓：它们是页面数据源、且都幂等 ✓。
		if (config.hostHalf === true) { return undefined; }
		const disposers = toolDefinitions(ctx, state, config).map(definition => ctx.tools.register(definition));
		state.tools = ctx.tools;
		return () => {
			state.tools = null;
			for (const dispose of disposers) {
				dispose();
			}
		};
	});

	// 页面路由（**可选**依赖）：`webServer` / `connection` 只在 web 模板里存在（见静态 `inject` 的注释）。
	// 不在 web 模板 ⇒ 只是**没有页面** ✓，工具照常可用 ✓。
	ctx.inject(['webServer', 'connection'], page => page.effect(() => page.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const rejected = page.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			try {
				const url = new URL(req.url ?? '/', 'http://127.0.0.1');
				// 静态资源（白名单；见 ASSETS 的注释）。**先于**数据收集：CSS/JS 不该等缓存扫盘。
				if (url.pathname.startsWith(`${ROUTE_PREFIX}/app/`) || url.pathname.startsWith(`${ROUTE_PREFIX}/theme/`)) {
					const asset = ASSETS.get(url.pathname.slice(ROUTE_PREFIX.length));
					if (!asset) {
						res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
						res.end('not found');
						return;
					}
					res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
					res.end(asset.body);
					return;
				}
				const range = url.searchParams.get('range') ?? 'all';
				// 带范围时先把缓存**多读一些**再筛：只在前 PAGE_LIMIT 条里找"今日"，数出来的数会少 ✓
				// 而且**看不出少** ✗（"为什么昨天下午的会话不见了"就是这么来的 ✓）。上限写死 1000：本地缓存读，够用 ✓。
				const scanLimit = range === 'all' ? PAGE_LIMIT : 1000;
				if (url.pathname === `${ROUTE_PREFIX}/api/sessions`) {
					// 程序化消费面（README 5.74）：IDE / chat-surface / 对账脚本用 ✓。
					// ⚠ 与页面**同一份 `collect` ＋ 同一份 `filterSessionsByRange`** ⇒ 不可能出现"页面 3 个、API 5 个" ✗。
					const requested = Number(url.searchParams.get('limit'));
					const limit = Number.isFinite(requested) && requested > 0 ? Math.min(1000, Math.floor(requested)) : PAGE_LIMIT;
					const scan = await collect(config, Math.max(limit, scanLimit), state);
					const filtered = filterSessionsByRange(scan.summary.sorted, range);
					if (filtered.error) {
						res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({ error: filtered.error, range }));
						return;
					}
					const rows = filtered.sessions.slice(0, limit).map(sessionRow)
						// 与工具同一口径：schema 里是可选字段 ⇒ 去掉 undefined，别让校验器判类型不符 ✓
						.map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)));
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({
						range, limit,
						// 三个数**分开报**，谁都别替谁说话：扫到多少 / 范围内命中多少 / 这次给了多少 ✓
						scanned: scan.summary.sorted.length,
						matched: filtered.sessions.length,
						returned: rows.length,
						summary: aggregate(filtered.sessions),
						sessions: rows,
						dir: scan.dir,
						...(scan.missing ? { missing: scan.missing } : {}),
						live: scan.live,
						...(scan.truncated ? { truncated: true, remaining: scan.remaining } : {}),
						errors: scan.errors,
					}));
					return;
				}
				// ── 布局的**写面**（P2）：`POST /x/dashboard/api/layout` ────────────────────────────
				// 本插件此前**全只读**；这是第一个写口 ⇒ 三条纪律一起上：① 输入一律先 sanitize
				// （`normalizeLayout` / `normalizeSettings`，不信任页面与脚本 ✓）；② 写盘在**锁**里
				// （`layoutStore.js` 的协议 v2 拷贝 ✓）；③ **CAS** —— 客户端递的 `updatedAt` 必须与
				// **锁内重读到的**一致，否则 409 + 当前布局（宁可让用户重来一次，也不静默覆盖别人的改动 ✗）。
				// ── 写口：布局（指定预设的内容）──────────────────────────────────────
				// 纪律：① 输入一律先 sanitize；② 写盘在**锁**里；③ **CAS**（updatedAt 不一致 ⇒ 409 + 当前内容）。
				// ★ 多套布局（2026-10-22）：体里可带 `preset`，不带给当前 active；带了就顺手切 active（"存到这份"语义）。
				if (url.pathname === `${ROUTE_PREFIX}/api/layout`) {
					if (req.method !== 'POST') {
						res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({ error: '布局写入只接受 POST', method: String(req.method ?? '') }));
						return;
					}
					const body = await readJsonBody(req, LAYOUT_BODY_LIMIT);
					if (body.error) {
						res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({ error: body.error }));
						return;
					}
					const incoming = body.value && typeof body.value === 'object' ? body.value : {};
					const normalized = normalizeLayout(incoming.layout ?? incoming);
					const settings = normalizeSettings(incoming.settings) ?? normalizeSettings(incoming.layout?.settings);
					const clientStamp = Number.isFinite(incoming.updatedAt) ? incoming.updatedAt : undefined;
					const targetName = normalizePresetName(incoming.preset);
					const outcome = await mutateLayout(config, current => {
						const file = normalizeLayoutFile(current.layout);
						const target = targetName ?? file.active;
						const existing = file.presets.get(target);
						const currentStamp = Number.isFinite(existing?.updatedAt) ? existing.updatedAt : 0;
						if (clientStamp !== undefined && clientStamp !== currentStamp) {
							// 409 回**该预设**的内容（不是 active 的）—— 客户端据此对齐，不用猜"被谁改了"
							return {
								value: {
									status: 409,
									body: {
										error: '布局已被别的写者改过（updatedAt 不一致）',
										conflict: true, preset: target, updatedAt: currentStamp,
										items: existing?.items ?? [], active: file.active,
									},
								},
							};
						}
						const next = { version: LAYOUT_VERSION, active: target, presets: new Map(file.presets) };
						next.presets.set(target, { items: normalized.items, settings, updatedAt: Date.now() });
						const written = next.presets.get(target);
						return {
							layout: serializeLayoutFile(next),
							value: {
								status: 200,
								body: {
									ok: true, preset: target, active: next.active,
									presets: [...next.presets.keys()],
									updatedAt: written.updatedAt,
									items: normalized.items, count: normalized.items.length,
									repaired: normalized.repaired, file: layoutPath(config),
									...(current.missing ? { created: true } : {}),
									...(current.error ? { previousError: current.error } : {}),
								},
							},
						};
					});
					res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify(outcome.body));
					return;
				}
				// ── 写口：预设集合（switch / saveAs / delete）────────────────────────────
				// ⚠ 这三件事**不改布局内容**，所以不参与 CAS；但仍走 `mutateLayout` ⇒ 与布局写入共用同一把锁。
				if (url.pathname === `${ROUTE_PREFIX}/api/layout/presets`) {
					if (req.method !== 'POST') {
						res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({ error: '预设操作只接受 POST', method: String(req.method ?? '') }));
						return;
					}
					const body = await readJsonBody(req, LAYOUT_BODY_LIMIT);
					if (body.error) {
						res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({ error: body.error }));
						return;
					}
					const incoming = body.value && typeof body.value === 'object' ? body.value : {};
					const action = String(incoming.action ?? '');
					const name = normalizePresetName(incoming.name);
					if (!name) {
						res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({ error: '预设名不能为空（最多 24 字）' }));
						return;
					}
					const outcome = await mutateLayout(config, current => {
						const file = normalizeLayoutFile(current.layout);
						const names = [...file.presets.keys()];
						const fail = (status, error) => ({ value: { status, body: { error, presets: names, active: file.active } } });
						/**
						 * 预设级 CAS（2026-10-22）：`rename` / `delete` **会动已有预设**，所以要防"我看到的已经不是它"。
						 * ⚠ 只对这两件事生效：`switch` 不改内容（改了也只是"看哪一份"），`saveAs` 是新建。
						 * 客户端只在操作 **active** 时带上 `updatedAt`（它只知道 active 的戳）。
						 */
						const clientStamp = Number.isFinite(incoming.updatedAt) ? incoming.updatedAt : undefined;
						const staleOf = target => {
							const stamp = Number.isFinite(file.presets.get(target)?.updatedAt) ? file.presets.get(target).updatedAt : 0;
							if (clientStamp === undefined || clientStamp === stamp) { return null; }
							return {
								value: {
									status: 409,
									body: {
										error: `预设 ${target} 在你操作期间被改过（updatedAt 不一致）⇒ 已刷新，请重试`,
										conflict: true, preset: target, updatedAt: stamp, presets: names, active: file.active,
									},
								},
							};
						};
						if (action === 'switch') {
							if (!file.presets.has(name)) { return fail(404, `预设 ${name} 不存在（现有：${names.join(' / ')}）`); }
							if (file.active === name) { return { value: { status: 200, body: { ok: true, active: name, presets: names, unchanged: true } } }; }
							return {
								layout: serializeLayoutFile({ version: LAYOUT_VERSION, active: name, presets: file.presets }),
								value: { status: 200, body: { ok: true, active: name, presets: names } },
							};
						}
						if (action === 'saveAs') {
							if (file.presets.has(name) && incoming.overwrite !== true) {
								return fail(409, `预设 ${name} 已存在（要覆盖请显式传 overwrite: true）`);
							}
							const source = activePresetOf(file);
							const next = { version: LAYOUT_VERSION, active: name, presets: new Map(file.presets) };
							next.presets.set(name, {
								items: source.items, settings: source.settings, updatedAt: Date.now(),
							});
							return {
								layout: serializeLayoutFile(next),
								value: { status: 200, body: { ok: true, active: name, presets: [...next.presets.keys()] } },
							};
						}
						// ★ 重命名（2026-10-22）：**保序**改名 —— Map 的插入顺序就是落盘顺序，
						//   若先删再插会把这套布局挪到末尾（用户看到的顺序莫名其妙变了）。
						//   也不改内容 / 不动 updatedAt（改名不是"改布局"，不该让别的窗口误判冲突）。
						if (action === 'rename') {
							const to = normalizePresetName(incoming.to);
							if (!to) { return fail(400, '新名字不能为空（最多 24 字）'); }
							if (!file.presets.has(name)) { return fail(404, `预设 ${name} 不存在（现有：${names.join(' / ')}）`); }
							const renamedStale = staleOf(name);
							if (renamedStale) { return renamedStale; }
							if (name === to) { return { value: { status: 200, body: { ok: true, active: file.active, presets: names, unchanged: true } } }; }
							if (file.presets.has(to)) { return fail(409, `预设 ${to} 已存在（换个名字，或先删掉它）`); }
							const next = {
								version: LAYOUT_VERSION,
								active: file.active === name ? to : file.active,
								presets: new Map(),
							};
							for (const [key, value] of file.presets) {
								next.presets.set(key === name ? to : key, value);
							}
							return {
								layout: serializeLayoutFile(next),
								value: { status: 200, body: { ok: true, active: next.active, presets: [...next.presets.keys()] } },
							};
						}
						if (action === 'delete') {
							if (!file.presets.has(name)) { return fail(404, `预设 ${name} 不存在`); }
							const deletedStale = staleOf(name);
							if (deletedStale) { return deletedStale; }
							if (file.presets.size <= 1) { return fail(400, '至少要留一个预设（删掉最后一个就没布局可显示了）'); }
							const next = { version: LAYOUT_VERSION, active: file.active, presets: new Map(file.presets) };
							next.presets.delete(name);
							if (next.active === name) {
								next.active = next.presets.has(DEFAULT_PRESET_NAME) ? DEFAULT_PRESET_NAME : [...next.presets.keys()][0];
							}
							return {
								layout: serializeLayoutFile(next),
								value: { status: 200, body: { ok: true, active: next.active, presets: [...next.presets.keys()] } },
							};
						}
						return fail(400, `不认识的 action：${action || '(空)'}（只认 switch / saveAs / rename / delete）`);
					});
					res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify(outcome.body));
					return;
				}
				const data = await collect(config, scanLimit, state);
				const toolsRegistered = TOOL_NAMES.filter(tool => !!state.tools?.get(tool)).join(',') || '(未注册)';
				// 两条 live 通道分别如实报告（`sessions 可用|不可用` 这个前缀是探针 p3-09 的断言口径，保持不动）
				const liveServices = `${state.live ? 'sessions 可用' : 'sessions 不可用'} · 投影 ${state.projections ? '可用' : '不可用'}`;
				// 先渲染再 writeHead（渲染抛错还能干净回 500）
				// ★ 2026-10-13：按**布局**渲染（P1 组件化 ＋ P2 落盘）。解析口径全在 `resolveLayout()`
				//   一处（查询参数 → 落盘文件 → 出厂默认）⇒ 页面与探针吃的是同一条链 ✓。
				const resolved = await resolveLayout(config, url.searchParams.get('layout'), url.searchParams.get('preset'));
				// ★ 2026-10-22（用户拍板：主页改成**注册式工作台**）：数据的 JSON 接口。
				//   用 `?format=json` 而不是新开一条路径 —— 这样**布局解析链完全共用**（查询参数 → 落盘 → 出厂默认），
				//   与 SSR 页走的是同一次 `resolveLayout()` ✓；装配同样共用 `buildDashboardPayload()` ✓。
				if (url.searchParams.get('format') === 'json') {
					const payload = buildDashboardPayload({
						data, config, toolsRegistered, liveServices, range,
						layout: resolved.items, settings: resolved.settings,
					});
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({
						ok: true,
						note: resolved.note,
						source: resolved.source,
						active: resolved.active,
						presets: resolved.names,
						stamp: resolved.stamp,
						settings: resolved.settings,
						layout: payload.layoutForClient,
						model: payload.widgetModel,
					}));
					return;
				}
				// ★ 2026-10-13：**按承载表面分版**（宿主注入 `?surface=`）：
				//   侧栏（`sideview`）⇒ 摘要版（`lib/sideview.js`）；其余（含探针与浏览器直开）⇒ 完整页 ✓。
				//   ⚠ 两版渲染**同一份隐藏锚点块** ⇒ 探针 `p3-09`（走不带参数的 URL ⇒ 完整页）不受影响 ✓。
				const sideview = url.searchParams.get('surface') === 'sideview';
				const html = sideview
					? renderSideviewPage({ data, range, toolsRegistered, liveServices, layoutNote: resolved.note })
					: renderDashboardPage({
						data, config, toolsRegistered, liveServices, range,
						layout: resolved.items, settings: resolved.settings, layoutNote: resolved.note,
						layoutStamp: resolved.stamp, activePreset: resolved.active, presetNames: resolved.names,
					});
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
				res.end(html);
			} catch (e) {
				const message = String(e?.message ?? e);
				if (res.headersSent) {
					res.end(message);
				} else {
					res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(message);
				}
			}
		},
	})));
}
