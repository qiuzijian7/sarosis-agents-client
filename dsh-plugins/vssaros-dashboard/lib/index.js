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

import { activityText, contextUsageText, escapeHtml, getWidget, isoOf, listMetaText, metaBlock, modelText, normalizeWidgetConfig, SESSIONS_LIMIT_DEFAULT, serializeCatalog, summarizeModel } from './catalog.js';

import { defaultLayout, LAYOUT_VERSION, layoutCssVars, normalizeLayout, normalizeSettings } from './layout.js';

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
 * 页面侧脚本：**读成文本**整段嵌进 `<script>`（独立文件 —— 理由见 `lib/pageClient.js` 的头注释：
 * 客户端代码里可以自由用反引号，而页面那段模板字符串就不会被提前闭合 ✗）。
 *
 * ⚠ **在模块加载期读**：文件缺失 ⇒ **整包加载失败** ⇒ `dshPluginPackages.test.ts` 的"Host 入口必须能被
 * 加载"当场抓住 ✓（比"页面少个按钮、静默没交互"好得多）。⚠ `package.json` 的 `files` **必须**列上它 ——
 * 漏了就是"源码里在、装出来没有"（本仓已经踩过一次这种 ✗）。
 */
const PAGE_CLIENT_JS = readFileSync(new URL('./pageClient.js', import.meta.url), 'utf8');

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
async function resolveLayout(config, param) {
	const fromConfig = normalizeSettings(config?.layout);
	// ⚠ **无论哪个模式都要读一次盘**：客户端保存时要拿 `updatedAt` 做 CAS，而它必须来自**盘上那份**
	//   （哪怕这一页展示的是 `?layout=default` 的预览）—— 否则"预览默认布局后保存"会拿一个 0 去比，
	//   必然误报 409 ✗。文件不存在 ⇒ stamp = 0（首启，那本来就是"没有"的诚实表示 ✓）。
	const read = await readLayout(config);
	const stamp = Number.isFinite(read.layout?.updatedAt) ? read.layout.updatedAt : 0;
	if (param === 'none') {
		return { items: [], settings: fromConfig, note: '', source: 'query:none', stamp };
	}
	if (param === 'default') {
		return { items: defaultLayout(), settings: fromConfig, note: '', source: 'query:default', stamp };
	}
	const normalized = normalizeLayout(read.layout);
	const settings = normalizeSettings(read.layout?.settings) ?? fromConfig;
	if (read.error) {
		return { items: normalized.items, settings, note: `首页布局读不了，已回到出厂默认：${read.error}`, source: 'file:error', stamp };
	}
	if (read.missing) {
		return { items: normalized.items, settings, note: '', source: 'default:missing', stamp };
	}
	const note = normalized.repaired.length
		? `首页布局有 ${normalized.repaired.length} 处被自动纠正：${normalized.repaired.join('；')}`
		: '';
	return { items: normalized.items, settings, note, source: 'file', stamp };
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
export function renderDashboardPage({ data, config, toolsRegistered, liveServices, range = 'all', layout = defaultLayout(), settings, layoutNote = '', layoutStamp = 0 }) {
	const { errors, dir, missing, truncated } = data;
	// ── 日期范围（README 5.74）：与 `/api/sessions` 用**同一个纯函数** ✓ ────────────────────────────
	// 这里把 `summary` **整体重算**成"范围内"的那一份 ⇒ 卡片 / 运行清点 / 明细列表**全都跟着范围走** ✓。
	// ⚠ 只换列表不换卡片，页面就会自相矛盾（"总数 50、明细 3 条"）—— 那比不做筛选更让人困惑 ✗。
	// ⚠ 2026-10-13：这段口径**抽到 `catalog.summarizeModel()`**，与侧栏紧凑版（`lib/sideview.js`）
	//   **共用同一处** —— 两版各算一遍必然漂移（"侧栏 32、完整页 30"）✗。语义与抽取前逐字等价 ✓
	//   （「运行中」清点仍**只数已知的**：没有会话带 todos 单元时 `todoSessions` 缺席 ⇒ 卡片不出现，而不是显示 0）。
	const { summary, tally, tokenLine, model } = summarizeModel(data, range, { toolsRegistered, liveServices });
	// 「编排」工具条 + 画廊：**无条件渲染**（编辑态靠 CSS 显形）⇒ 探针不必去点按钮就能断言它们在 ✓
	// ★ 2026-10-13（用户："不允许重复添加组件"）：把**页面上已有的 kind** 交给目录序列化 ⇒ 画廊据此
	//   标「已添加」（`data-dash-added` / `is-added` ✓）。`layout` 是**归一化过**的（重复 kind 已被
	//   `normalizeLayout` 丢掉 ✓）⇒ 标记与实际渲染的卡片**必然一致** ✓（两处各算一遍就会漂移 ✗）。
	const catalog = serializeCatalog(new Set(layout.map(item => item.kind)));
	// ⚠ 编排按钮同时带**稳定锚点** `data-dash-edit-toggle`：`data-dash-action` 会在 edit ↔ done 之间来回改
	//   （客户端 `setEditing` ✓），拿它当"查找键"必然单向卡死 ✗（见 `pageClient.js` 的注释与探针第 ⑭ 条 ✓）。
	const toolbar = '<div class="dash-bar"><button type="button" class="dash-btn" data-dash-action="edit" data-dash-edit-toggle="1">编排</button><button type="button" class="dash-btn dash-btn-add" data-dash-action="gallery">＋ 添加组件</button><span class="dash-status" data-dash-status></span></div>';
	// ⚠ 已添加的那些**保留按钮**（不删 ✗）：点了由 `pageClient.js` 的 `addWidget` 回一句话说明原因 ✓
	//   —— 直接 disabled 的话用户只会觉得"按钮坏了" ✗（而且 p3-46 断言每个 kind 都有按钮 ✓）。
	const gallery = `<div class="dash-gallery" data-dash-gallery hidden><p class="dash-gallery-title">加一个组件：</p>${catalog.map(entry => `<button type="button" class="dash-gallery-item${entry.added ? ' is-added' : ''}" data-dash-action="add" data-dash-kind="${escapeHtml(entry.kind)}"${entry.added ? ' data-dash-added="1" aria-disabled="true"' : ''}><b>${escapeHtml(entry.name)}</b><small>${entry.added ? '已经在页面上（不允许重复添加）' : `${escapeHtml(entry.description)} · ${entry.w}×${entry.h}`}</small></button>`).join('')}</div>`;
	// ⚠ 再夹一次：本函数可以被**直接调用**（探针 / 将来的其它入口）⇒ 不假设调用方已经归一化过
	//   （文件可能被手改过 ⇒ 渲染期是**最后**一道，见 `layout.js` 的两道夹紧注释 ✓）。
	const vars = layoutCssVars(normalizeSettings(settings) ?? normalizeSettings(config?.layout) ?? {});

	const cells = layout.map(item => {
		// `h` = **最小高度**（行）：出厂默认 1/1/3 ⇒ 24/24/72px，**都低于内容高度 ⇒ 视觉与改造前一致** ✓
		// （把 `h` 拉大是缩放手柄的活儿；语义见 `layout.js` 的注释）
		const attrs = [
			`data-dash-id="${escapeHtml(item.id)}"`,
			`data-dash-widget="${escapeHtml(item.kind)}"`,
			`data-dash-w="${item.w}"`,
			`data-dash-h="${item.h}"`,
			`style="grid-column: span ${item.w}; min-height: calc(${item.h} * var(--dash-row) + ${Math.max(0, item.h - 1)} * var(--dash-gap, 0px))"`,
		].join(' ');
		// 编辑态的四个小件（尺寸标签 / 移除 / 缩放手柄）**由服务端就渲染好**，靠 CSS 只在 `.dash-editing`
		// 下显形 ⇒ "进入编辑模式"只是切一个 class，没有"客户端凭空造 DOM"那一步 ✓；非编辑态**完全不留痕** ✓。
		const tools = `<span class="dash-tools"><span data-dash-size>${item.w}×${item.h}</span><button type="button" class="dash-x" data-dash-action="remove" title="移除这个组件">✕</button></span><span class="dash-resize" data-dash-resize title="拖动缩放（列 × 行）"></span>`;
		const widget = getWidget(item.kind);
		if (!widget) {
			// 未知组件 ⇒ **占位卡**（不静默丢掉）：用户得看得见"这里少了一块"，并能把它从布局里去掉；
			// 提供它的模块装回来时，同一份布局会自动恢复（布局里一直保留着它）。
			return `<section class="dash-w dash-w-missing" ${attrs}>${tools}<p class="empty">该组件不存在：<code>${escapeHtml(item.kind)}</code>（提供它的模块可能被卸下了）。</p></section>`;
		}
		return `<section class="dash-w" ${attrs}>${tools}${widget.render(model, normalizeWidgetConfig(widget, item.config))}</section>`;
	}).join('\n');

	// ▲ 隐藏元数据块：**机器可断言的锚点**（与用户布局无关、与承载表面无关 —— 实现见 `catalog.metaBlock`）。
	//   ⚠ 与侧栏紧凑版**共用同一个函数**：两版 HTML 完全不同，唯一必须逐字相同的就是这 16 个锚点 ✓
	//   （侧栏版没有组件网格、完整页的组件可被用户删光 ⇒ 锚点若分别内联，早晚有一边漂移 ✗）。
	const meta = metaBlock({ data, summary, tally, toolsRegistered, liveServices });

	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>主页 · VsSaros</title>
<style>
	:root { color-scheme: light dark; }
	body { margin: 0; padding: 16px; font: 13px/1.6 system-ui, "Segoe UI", sans-serif; color: var(--vscode-foreground, #ccc); background: var(--vscode-sideBar-background, #1e1e1e); }
	h1 { font-size: 14px; margin: 0 0 6px; font-weight: 600; }
	h1 small, h2 small { color: var(--vscode-descriptionForeground, #999); font-weight: 400; }
	.cards { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 4px; }
	.card { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 6px; padding: 6px 10px; min-width: 96px; }
	.card b { display: block; font-size: 16px; }
	.card span { color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
	ul { list-style: none; margin: 0; padding: 0; }
	li { padding: 6px 0; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
	li:first-child { border-top: 0; }
	li.cold { opacity: .72; }
	.t { font-weight: 600; }
	small, .diag, .empty { color: var(--vscode-descriptionForeground, #999); }
	.diag { font-size: 12px; margin: 4px 0 0; }
	code { font-family: ui-monospace, Consolas, monospace; }
	/* ── 组件网格（2026-10-13 P1）：12 列制，宽度由布局给（grid-column: span N）。
	   ⚠ 默认 --dash-gap 为 0 是刻意的：等价重构阶段不该凭空多出网格间距（见 layout.js 注释）。
	   ⚠ 本段在模板字符串里：注释里**绝不能出现反引号**，否则会提前闭合整页 ✗（真踩过两次）。 */
	.dash-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--dash-gap, 0); max-width: var(--dash-max-width, none); }
	.dash-w { min-width: 0; }
	.dash-w-missing { border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 6px; padding: 6px 10px; }
	/* ── 编排态（2026-10-13 P3）：**非编辑态完全不留痕** —— 四个小件都 display:none、没有 outline
	   ⇒ 出厂视觉与改造前一致 ✓（这也是为什么小件由服务端渲染而不是客户端造 DOM ✓）。
	   ⚠ 本段在模板字符串里：注释里**绝不能出现反引号**，否则整页提前闭合 ✗（本轮第三次踩）。 */
	.dash-bar { display: flex; align-items: center; gap: 6px; margin: 8px 0 0; }
	.dash-btn { font: inherit; font-size: 12px; color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c); border: 0; border-radius: 3px; padding: 2px 8px; cursor: pointer; }
	.dash-btn-add { display: none; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ccc); }
	.dash-status { color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
	.dash-gallery { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 6px; padding: 8px; margin: 8px 0; }
	.dash-gallery-title { margin: 0 0 6px; color: var(--vscode-descriptionForeground, #999); font-size: 12px; }
	.dash-gallery-item { display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: none; border: 1px solid transparent; border-radius: 4px; padding: 4px 6px; cursor: pointer; }
	.dash-gallery-item:hover { border-color: var(--vscode-focusBorder, #007acc); }
	.dash-gallery-item small { display: block; color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
	/* ★ 2026-10-13：已经在页面上的组件（不允许重复添加）⇒ 置灰但仍可点（点了会回一句话说明原因 ✓）。 */
	.dash-gallery-item.is-added { opacity: .5; }
	.dash-gallery-item.is-added:hover { border-color: var(--vscode-panel-border, rgba(128,128,128,.35)); }
	.dash-tools, .dash-resize { display: none; }
	/* 2026-10-13：长列表（会话明细）自己滚动，别把整页撑长（用户要求）。帽用视口份额而不是
	   卡片的 h：h 的语义是"最小高度"，且**已落盘布局里还是旧值 3** ⇒ 按它算帽会让老用户只看到
	   一两行（把改动变成回归 ✗）。overscroll-behavior 防滚动链（滚到底不再带动外层 ✓）。
	   ★ 2026-10-13 二改（用户："会话组件太高了，降低组件高度"）：帽从 55vh 降到 **min(30vh, 300px)**
	     —— **双帽**（视口份额 + 绝对像素）：只给 vh 的话大屏上仍是半个屏幕 ✗，只给 px 的话小屏上
	     又会占满 ✗。要更高就点「编排」用右下角手柄拉（h 是**最小高度**，卡片会被内容撑回来 ✓ 但
	     列表自己的滚动帽不受 h 影响 ⇒ 想真正变高，得改这里或加"每卡高度"配置 ✗ —— 目前不做）。
	   ⚠ 本段在模板字符串里：注释里**绝不能出现反引号**，否则整页提前闭合 ✗（这条我踩了第 4 次 ✗）。 */
	.dash-scroll { max-height: min(30vh, 300px); overflow-y: auto; overscroll-behavior: contain; }
	/* 2026-10-13 新增组件（工作台 / 工作区统计 / 用量分布 / 时钟 / 番茄时钟）的样式。
	   ⚠ 本段在模板字符串里：注释里**绝不能出现反引号**（本仓已踩过四次 ✗）。 */
	.wb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(178px, 1fr)); gap: 8px; }
	.wb-card { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 5px; padding: 8px 10px; background: rgba(128,128,128,.06); }
	/* ★ 2026-10-13：工作台条目可**拖拽排序**（非编辑态也允许 ✓）—— 抓手 / 拖拽中的反馈。
	   touch-action: none 防触摸环境下拖动变成滚页 ✓（与卡片缩放手柄同款做法 ✓）。 */
	.wb-card { cursor: grab; touch-action: none; user-select: none; }
	/* ⚠ 本段在模板字符串里：注释里绝不能出现反引号 ✗ */
	/* ★ 2026-10-13（用户："工作台中的item缺少拖拽表现" ⇒ 并选定**B 空槽跟手**）：
	   ① 抓手提示（名称前的 ⠿）：一眼知道这条能拖 ✓；
	   ② 拖拽中：原条目变**虚线空槽**（留出落点位置 ✓），另一个**浮层克隆跟着指针走** ✓
	      —— 实现在 pageClient.js 的 makeWorkbenchGhost ✓。
	   ⚠ 本段在模板字符串里：注释里**绝不能出现反引号** ✗ —— 我这次正是在这里加了反引号，
	     让它提前闭合、整个文件语法错（探针静默失败 ✓）。现在 p3-46 开头有一道元检查盯着它 ✓。 */
	.wb-nm::before { content: '⠿'; opacity: .45; margin-right: 4px; font-size: 11px; }
	.wb-card.wb-slot { border-style: dashed; border-color: var(--vscode-focusBorder, #007acc); background: transparent; }
	.wb-card.wb-slot > * { opacity: .18; }
	/* ⚠ 浮层必须 pointer-events: none —— 否则它会把指针事件全吃掉，拖到一半就断 ✓（真踩过 ✓）。
	   ★ 方案 3（用户 2026-10-13 选定）：位置**只**由 transform: translate3d() 给 ——
	     ① left/top 固定 0 ＋ translate3d ⇒ 交给**合成层**、不触发布局（最跟手 ✓）；
	     ② ⚠ **绝对不要**再写 left/top ✗ —— 之前横向取"空槽矩形"，实测偏差 **283px** ✓（"非常不跟手" ✓）；
	     ③ will-change 挂在这里够用（浮层只存在于拖拽期间 ✓）。 */
	.wb-ghost { position: fixed; left: 0; top: 0; z-index: 60; margin: 0; pointer-events: none; opacity: .95;
		border-color: var(--vscode-focusBorder, #007acc); background: var(--vscode-editor-background, #1e1e1e);
		box-shadow: 0 10px 26px rgba(0, 0, 0, .45); transform: translate3d(0, 0, 0) scale(1.02); will-change: transform; }
	.wb-nm { font-size: 12px; display: flex; align-items: center; gap: 6px; }
	.wb-desc { font-size: 10px; color: var(--vscode-descriptionForeground, #999); margin-top: 2px; min-height: 15px; }
	.wb-ops { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
	.wb-op { font: inherit; font-size: 11px; color: inherit; background: rgba(128,128,128,.16); border: 1px solid transparent; border-radius: 3px; padding: 1px 6px; cursor: pointer; }
	.wb-op:hover { border-color: var(--vscode-focusBorder, #007acc); }
	.clock { text-align: center; }
	.clock-t { font-family: ui-monospace, Consolas, monospace; font-size: 28px; letter-spacing: 1px; }
	.clock-d { font-size: 11px; color: var(--vscode-descriptionForeground, #999); margin-top: 2px; }
	.pomo { text-align: center; }
	.pomo-ring { width: 84px; height: 84px; }
	.pomo-t { font-family: ui-monospace, Consolas, monospace; font-size: 24px; }
	.pomo-ph { font-size: 11px; color: var(--vscode-descriptionForeground, #999); margin: 2px 0 8px; }
	.pomo-ops { display: flex; gap: 6px; justify-content: center; }
	.ws-track { height: 7px; border-radius: 4px; background: rgba(128,128,128,.2); overflow: hidden; margin-top: 4px; }
	.ws-track i { display: block; height: 100%; background: var(--vscode-charts-blue, #4C9AFF); }
	.stack { display: flex; height: 20px; border-radius: 4px; overflow: hidden; margin: 6px 0 8px; }
	.stack i { display: block; height: 100%; }
	.legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--vscode-descriptionForeground, #999); }
	.legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; }
	.dash-editing .dash-btn-add { display: inline-block; }
	.dash-editing .dash-w { position: relative; outline: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.5)); outline-offset: 2px; cursor: grab; touch-action: none; }
	.dash-editing .dash-w.dash-dragging { cursor: grabbing; opacity: .85; z-index: 3; }
	.dash-editing .dash-w[data-dash-drop="before"] { box-shadow: 0 -3px 0 var(--vscode-focusBorder, #007acc); }
	.dash-editing .dash-w[data-dash-drop="after"] { box-shadow: 0 3px 0 var(--vscode-focusBorder, #007acc); }
	.dash-editing .dash-tools { display: flex; gap: 6px; align-items: center; justify-content: flex-end; color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
	.dash-x { font: inherit; font-size: 11px; color: inherit; background: none; border: 0; cursor: pointer; }
	.dash-editing .dash-resize { display: block; position: absolute; right: -2px; bottom: -2px; width: 14px; height: 14px; background: linear-gradient(135deg, transparent 50%, var(--vscode-focusBorder, #007acc) 50%); cursor: nwse-resize; touch-action: none; }
</style>
</head>
<body data-vssaros-page="dashboard">
<h1>主页 <small>dsh 会话遥测 / 用量（只读）</small></h1>
<p class="diag" data-vssaros-dashboard-scope="session-telemetry">口径：本页读 dsh 自己的<b>会话投影缓存</b>（checkpoint 落盘，可能比实时略落后），因此只有<b>会话遥测</b>（turn / step / 耗时 / token 用量 / 子代理 / 待办计数）；IDE 那侧的「主页」是它自己的聚合口径（另有成本与告警）⇒ <b>两者数字不必相同</b>，不要拿两页互相"对账"。</p>
<p class="diag" data-vssaros-dashboard-range="${escapeHtml(range)}">范围：${DATE_RANGES.map(item => item.range === range
		? `<b>${escapeHtml(item.label)}</b>`
		: `<a href="${ROUTE_PREFIX}/?range=${item.range}">${escapeHtml(item.label)}</a>`).join(' · ')}</p>
${toolbar}
${gallery}
${layoutNote ? `<p class="diag" data-vssaros-dashboard-layout-note="1">${escapeHtml(layoutNote)}</p>\n` : ''}${meta}
<div class="dash-grid" data-dash-grid="1" data-dash-count="${layout.length}" data-dash-api="${escapeHtml(ROUTE_PREFIX)}/api/layout" style="--dash-row: ${vars.row}; --dash-gap: ${vars.gap}; --dash-max-width: ${vars.maxWidth}">
${cells}
</div>
${missing ? `<p class="empty">投影缓存目录还不存在：<code>${escapeHtml(missing)}</code>（dsh 还没写过会话，或 DSH_HOME 配错了）。</p>` : ''}
${truncated ? '<p class="diag">目录里还有更多会话，已按上限截断。</p>' : ''}
${errors.length ? `<p class="diag">${errors.length} 个缓存文件读不了：${escapeHtml(errors.slice(0, 3).join('；'))}${errors.length > 3 ? ' …' : ''}</p>` : ''}
${truncated ? `<p class="diag">…另有 ${data.remaining ?? 0} 个，用 dashboard_sessions 工具查看。</p>` : ''}
<script type="application/json" data-dash-layout-json>${jsonIsland({ version: LAYOUT_VERSION, updatedAt: layoutStamp, settings: normalizeSettings(settings) ?? null, items: layout })}</script>
<script type="application/json" data-dash-catalog-json>${jsonIsland(catalog)}</script>
<script>${PAGE_CLIENT_JS}</script>
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
					// 允许两种递法：`{ layout: {...}, updatedAt }` 或直接 `{ items: [...] }`（脚本更好写 ✓）
					const normalized = normalizeLayout(incoming.layout ?? incoming);
					const settings = normalizeSettings(incoming.settings) ?? normalizeSettings(incoming.layout?.settings);
					const clientStamp = Number.isFinite(incoming.updatedAt) ? incoming.updatedAt : undefined;
					const outcome = await mutateLayout(config, current => {
						const currentLayout = current.layout && typeof current.layout === 'object' ? current.layout : {};
						const currentStamp = Number.isFinite(currentLayout.updatedAt) ? currentLayout.updatedAt : 0;
						if (clientStamp !== undefined && clientStamp !== currentStamp) {
							return {
								value: {
									status: 409,
									body: {
										error: '布局已被别的写者改过（updatedAt 不一致）',
										conflict: true, updatedAt: currentStamp,
										layout: { version: LAYOUT_VERSION, updatedAt: currentStamp, items: normalizeLayout(currentLayout).items },
									},
								},
							};
						}
						const next = {
							version: LAYOUT_VERSION,
							...(settings ? { settings } : {}),
							updatedAt: Date.now(),
							items: normalized.items,
						};
						return {
							layout: next,
							value: {
								status: 200,
								body: {
									// ⚠ 字段语义（2026-10-13 改明确）：`items` = **数组**（真正落盘的那份 ✓，客户端
									//   据此对齐 ✗ 之前没有它，客户端只能拿"读盘时那份"⇒ 两边错位 ✓）；
									//   `count` = 数量（原先是 `items: <number>` ✗ —— 名字与内容不符，且我加数组时
									//   撞了同名键 ⇒ 后写的覆盖前写的，把既有契约改掉了 ✗ 探针当场抓到 ✓）。
									ok: true, updatedAt: next.updatedAt,
									items: normalized.items, count: normalized.items.length,
									repaired: normalized.repaired, file: layoutPath(config),
									// ★ 2026-10-13：回传**归一化后的 items**（= 真正落盘的那份）⇒ 客户端拿它当准 ✓。
									//   起因（用户第二次报"删除不生效"）：页面手里的 items 是**读盘时**那份，而写口会
									//   再归一化一次（丢重复 kind ✓）⇒ 两边不一致时，客户端"删一个"再 POST 回去，
									//   盘上却是另一份东西 ✗（表现："显示已保存、卡片却还在"）。客户端现在会采纳这份 ✓。
									items: normalized.items,
									// 顺手把"写之前盘上是什么状态"如实带出来（坏了就是坏了，别装作没发生 ✓）
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
				const data = await collect(config, scanLimit, state);
				const toolsRegistered = TOOL_NAMES.filter(tool => !!state.tools?.get(tool)).join(',') || '(未注册)';
				// 两条 live 通道分别如实报告（`sessions 可用|不可用` 这个前缀是探针 p3-09 的断言口径，保持不动）
				const liveServices = `${state.live ? 'sessions 可用' : 'sessions 不可用'} · 投影 ${state.projections ? '可用' : '不可用'}`;
				// 先渲染再 writeHead（渲染抛错还能干净回 500）
				// ★ 2026-10-13：按**布局**渲染（P1 组件化 ＋ P2 落盘）。解析口径全在 `resolveLayout()`
				//   一处（查询参数 → 落盘文件 → 出厂默认）⇒ 页面与探针吃的是同一条链 ✓。
				const resolved = await resolveLayout(config, url.searchParams.get('layout'));
				// ★ 2026-10-13：**按承载表面分版**（宿主注入 `?surface=`）：
				//   侧栏（`sideview`）⇒ 摘要版（`lib/sideview.js`）；其余（含探针与浏览器直开）⇒ 完整页 ✓。
				//   ⚠ 两版渲染**同一份隐藏锚点块** ⇒ 探针 `p3-09`（走不带参数的 URL ⇒ 完整页）不受影响 ✓。
				const sideview = url.searchParams.get('surface') === 'sideview';
				const html = sideview
					? renderSideviewPage({ data, range, toolsRegistered, liveServices, layoutNote: resolved.note })
					: renderDashboardPage({
						data, config, toolsRegistered, liveServices, range,
						layout: resolved.items, settings: resolved.settings, layoutNote: resolved.note,
						layoutStamp: resolved.stamp,
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
