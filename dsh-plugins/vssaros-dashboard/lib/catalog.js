// @vssaros/dsh-dashboard — 首页组件目录（catalog）：**组件 = 一个纯渲染函数 + 一份元数据**。
//
// ⚠ 2026-10-13 引入（「dashboard → 可编排首页」P1：服务端组件化**等价重构**）：
//   改造前，这几块 HTML 是**写死**在 `lib/index.js` 的 `renderPage()` 里、顺序也写死；
//   现在每块变成一个定义、由布局决定顺序与宽度 ⇒ 页面渲染 = 「按布局挑组件 + 按组件渲染」。
//   ⚠ P1 的判据是**等价**：出厂默认布局下渲染出来的内容必须与改造前**逐字一致**。为此，下面
//     两个 `@@` 标记处的代码是**从 index.js 原样搬过来的**（由一次性脚本搬，不是手抄 ——
//     手抄第一版就抄错了 `activityText` 的 `⏳` 前缀与 `?? '?'`，那正是"未知伪装成 0" ✗）。
//
// 组件契约（`WidgetDefinition`）—— 字段名与参考实现（Obsidian home-pages）同口径，**实现全部自写**：
//   kind / name / description / icon / accent / defaultSize{w,h}
//   defaultConfig() · normalizeConfig?(raw)   ← 逐组件迁移 + 类型纠正（有它才好各自演进）
//   render(model, config) → HTML 字符串        ← 服务端渲染（我们的页面是 HTTP 页，没有客户端渲染循环）

import { activityTally, aggregate, filterSessionsByRange, formatMs, formatTokens } from './core/dashboard.js';
import { GRID_COLUMNS, clampInt } from './layout.js';

export function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** `C:\a\b\c` → `…\b\c`（路径太长，只留尾巴）。 */
export function shortPath(path) {
	if (typeof path !== 'string' || !path) {
		return '未知';
	}
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

export function isoOf(ms) {
	return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '未知';
}

/** 「运行状态」一行话（**未知项不显示、不写 0**——与"未知不伪装成 0"同一条家规）。 */
export function activityText(activity) {
	const parts = [];
	// 「回合在不在跑」放最前：它是"运行中"里信息量最大的一条——运行时自己（`dsh-agent-preset-registry`）
	// 也拿 `openTurnStartSeq` 当闸门（有回合在跑就拒绝切 preset）⇒ 这条信号是**语义有背书**的。
	if (activity.turn) {
		const { running, lastTurn } = activity.turn;
		if (running === true) {
			parts.push(`▶ 回合进行中${typeof lastTurn === 'number' ? `（已完成 ${lastTurn} 轮）` : ''}`);
		} else if (typeof lastTurn === 'number') {
			parts.push(`已完成 ${lastTurn} 轮`);
		}
	}
	if (activity.goal) {
		parts.push(`目标：${activity.goal}`);
	}
	if (activity.todos) {
		const { completed, total, inProgress, current } = activity.todos;
		parts.push(`待办 ${completed}/${total} 完成${inProgress ? `（进行中：${current ?? '1 项'}）` : ''}`);
	}
	if (activity.plan) {
		parts.push(`计划模式 ${activity.plan.active ? '开' : '关'}`);
	}
	if (activity.sandbox) {
		parts.push(`沙箱 ${activity.sandbox}`);
	}
	if (activity.permissions?.approval) {
		parts.push(`审批 ${activity.permissions.approval}`);
	}
	if (activity.retrying) {
		parts.push(`⟳ 正在重试（第 ${activity.retrying.retry} 次${activity.retrying.keys > 1 ? `／${activity.retrying.keys} 路` : ''}）`);
	}
	if (activity.pendingQuestions !== undefined) {
		parts.push(`待回答 ${activity.pendingQuestions}`);
	}
	// 「排队待发」：**用户已经发出、agent 还没消费**的输入（owner 原文 "prompts awaiting individual turns" /
	// "input awaiting the next step boundary"）。0 也如实显示（与"待回答 0"同口径：这是**已知的 0**）。
	if (activity.inbox) {
		const detail = [activity.inbox.turn ? `待开轮 ${activity.inbox.turn}` : '', activity.inbox.step ? `待生效 ${activity.inbox.step}` : ''].filter(Boolean).join(' / ');
		parts.push(`⏳ 排队待发 ${activity.inbox.queued ?? '?'}${detail ? `（${detail}）` : ''}`);
	}
	return parts.join(' · ') || '（无运行中信息）';
}

/**
 * 上下文占用（`surfaceTokens` ÷ `contextWindow`）。
 *
 * 只有**两个数都在、且窗口 > 0** 时才算——"未知不伪装成 0"更进一步：**也不伪装成 0%**。
 * `contextWindow` 是 `contextPressure` v5 起才有的字段（真机 `{"surfaceTokens":3058,"contextWindow":1000000}`），
 * 老版本读不到就不显示占比。
 */
export function contextUsageText(session) {
	const used = session.surfaceTokens;
	const window = session.contextWindow;
	if (typeof used !== 'number' || typeof window !== 'number' || window <= 0) {
		return '';
	}
	return `（占 ${(used / window * 100).toFixed(1)}% · 窗口 ${formatTokens(window)}）`;
}

/**
 * 表面构成一行（`contextBreakdown`）。
 *
 * owner 包 README 保证了 **`system + messages == surface`**、且 `toolsTokens`（工具定义）**不在表面里**
 * ⇒ 这里也就这么显示：系统/消息给出（两者之和即表面），工具定义**另标"另计"**。
 * 两个量都是**启发式估算** ⇒ 行首标"估算"，不冒充精确值。
 */
export function contextBreakdownText(session) {
	const breakdown = session.contextBreakdown;
	if (!breakdown) {
		return '';
	}
	const parts = [];
	if (typeof breakdown.system === 'number' && typeof breakdown.messages === 'number') {
		parts.push(`系统 ${formatTokens(breakdown.system)} / 消息 ${formatTokens(breakdown.messages)}`);
	} else if (typeof breakdown.system === 'number') {
		parts.push(`系统 ${formatTokens(breakdown.system)}`);
	} else if (typeof breakdown.messages === 'number') {
		parts.push(`消息 ${formatTokens(breakdown.messages)}`);
	}
	if (typeof breakdown.tools === 'number') {
		parts.push(`工具定义 ${formatTokens(breakdown.tools)}（另计）`);
	}
	if (!parts.length) {
		return '';
	}
	return ` · 构成（估算）${parts.join(' / ')}`;
}

/**
 * 模型一行（`modelSelection`）：`used` = 最近一次请求**实际**用的（权威）；`pending` = 用户已选、**尚未生效**。
 * 只显示已知的（缺席不写"未知模型"占位——沿用本页"没有就不渲染这一项"的口径）。
 */
export function modelText(session) {
	const model = session.model;
	if (!model) {
		return '';
	}
	const name = selection => `${selection.provider}/${selection.model}${selection.reasoningEffort ? `（effort ${selection.reasoningEffort}）` : ''}`;
	const parts = [];
	if (model.used) {
		parts.push(name(model.used));
	}
	const pendingDiffers = model.pending && (!model.used || model.pending.provider !== model.used.provider || model.pending.model !== model.used.model);
	if (pendingDiffers) {
		parts.push(`→ 已切到 ${name(model.pending)}（尚未生效）`);
	}
	return parts.length ? `模型 ${parts.join(' ')}` : '';
}

/**
 * 冷会话摘要提示（`sessionListMetadata`）：`blank === true` ⇒ **空白会话**（产品**权威**口径：
 * "折叠前缀里没有回合"，与派生口径 `isActive()` 互补）；`lastPromptAt` = 最新**人类**提示时间
 * （`null` = 没有人提示过 ⇒ 不显示占位；只有**字段缺席**才是未知）。
 */
export function listMetaText(session) {
	const meta = session.listMeta;
	if (!meta) {
		return '';
	}
	const parts = [];
	if (meta.blank === true) {
		parts.push('空白会话');
	}
	if (typeof meta.lastPromptAt === 'number') {
		parts.push(`最后提示 ${isoOf(meta.lastPromptAt)}`);
	}
	return parts.length ? ` · ${parts.join(' · ')}` : '';
}

/**
 * 「参与标题的输入」一行（`titleInput`）。⚠ 措辞照 owner 的定语：**eligible** human text message
 * （"有资格参与标题生成的人类文本消息"）⇒ **不写"用户输入 N 条"**（那会把口径说宽）。
 */
export function titleInputText(session) {
	const input = session.titleInput;
	if (!input || typeof input.count !== 'number') {
		return '';
	}
	return ` · 参与标题的输入 ${input.count} 条${input.firstText ? `（首条「${input.firstText.slice(0, 24)}…」）` : ''}`;
}

/**
 * 子代理一行（四个单元合成，见 core 的 `subagentOf`）。只显示**已知**的：
 * 本会话是不是子代理（身份 + 标签）／正在跑多久、累计多久（`subagentTiming`）／派出了几个孩子（`subagentCatalog`）／
 * 允许子代理显式选的路由条数（`subagentModelSelectionPolicy`）。
 */
export function subagentText(session) {
	const sub = session.subagent;
	if (!sub) {
		return '';
	}
	const parts = [];
	if (sub.role) {
		parts.push(`本会话是子代理（${sub.role.mode === 'continuable' ? '可续' : '一次性'}${sub.role.label ? ` · ${sub.role.label}` : ''}）`);
	}
	if (sub.timing?.running === true) {
		parts.push(`▶ 正在跑${typeof sub.timing.activeMs === 'number' ? ` ${(sub.timing.activeMs / 1000).toFixed(1)}s` : ''}`);
	}
	if (typeof sub.timing?.settledMs === 'number') {
		parts.push(`累计 ${(sub.timing.settledMs / 1000).toFixed(1)}s`);
	}
	if (sub.children) {
		const detail = [
			sub.children.oneShot ? `一次性 ${sub.children.oneShot}` : '',
			sub.children.continuable ? `可续 ${sub.children.continuable}` : '',
			sub.children.unknown ? `模式未知 ${sub.children.unknown}` : '',
		].filter(Boolean).join(' / ');
		parts.push(`派出子代理 ${sub.children.count} 个${detail ? `（${detail}）` : ''}`);
	}
	if (sub.policy) {
		parts.push(`子代理可选模型 ${sub.policy.routes} 条`);
	}
	return parts.length ? `子代理：${parts.join(' · ')}` : '';
}

/** 会话明细的默认条数（⚠ 与页面级扫描上限同值：见 `index.js` 的 `PAGE_LIMIT`）。 */
export const SESSIONS_LIMIT_DEFAULT = 50;
/** 会话明细的条数上限（超出夹到边界，由代码夹紧，而不是 schema 的 minimum/maximum）。 */
export const SESSIONS_LIMIT_MAX = 200;

/**
 * 会话明细的行 —— **从改造前的 renderPage 原样搬来**（只把 slice 的输入换成参数）。
 */
export function sessionRowsHtml(shown) {
	const rows = shown.map(session => {
		const cells = [
			`<span class="t">${escapeHtml(session.title ?? '(无标题)')}</span>`,
			`<small>${escapeHtml(shortPath(session.cwd))} · ${escapeHtml(session.preset ?? '未知 preset')} · ${isoOf(session.createdAt)} · 来源 ${session.source}${escapeHtml(listMetaText(session))}${escapeHtml(titleInputText(session))}</small>`,
			session.model ? `<small>${escapeHtml(modelText(session))}</small>` : undefined,
			subagentText(session) ? `<small>${escapeHtml(subagentText(session))}</small>` : undefined,
			`<small>turn ${session.stats?.turns ?? '未知'} · step ${session.stats?.steps ?? '未知'} · LLM ${formatMs(session.stats?.llmMs)} · 工具 ${formatMs(session.stats?.toolMs)}</small>`,
			`<small>token：输入 ${formatTokens(session.tokens?.uncachedInput)} · 输出 ${formatTokens(session.tokens?.output)} · 读缓存 ${formatTokens(session.tokens?.cacheRead)} · 表面 ${formatTokens(session.surfaceTokens)}${contextUsageText(session)}${contextBreakdownText(session)}</small>`,
			// 没有「运行中」信号的会话不渲染这一行（而不是渲染"运行中：0"——那正是"未知伪装成 0"）
			session.activity ? `<small>运行中：${escapeHtml(activityText(session.activity))}</small>` : undefined,
		].filter(Boolean);
		return `<li class="${session.active ? '' : 'cold'}"><code>${escapeHtml(String(session.id))}</code><br>${cells.join('<br>')}</li>`;
	}).join('');
	return rows;
}

/**
 * 页面级摘要：按**范围**重算聚合 + 运行清点 + token 行。
 *
 * ⚠ **完整页与侧栏紧凑版（`lib/sideview.js`）共用这一处** —— 两版各自算一遍必然漂移，
 *   表现就是"侧栏说 32 个会话、完整页说 30 个"这种自相矛盾 ✗（这类页面最容易被质疑的地方）。
 *   改口径只改这里 ✓。
 */
export function summarizeModel(data, range, { toolsRegistered = '', liveServices = '' } = {}) {
	const ranged = filterSessionsByRange(data.summary.sorted, range ?? 'all');
	const summary = aggregate(ranged.sessions);
	const tally = activityTally(summary.sorted);
	const tokenLine = [
		`输入 ${formatTokens(summary.tokens.uncachedInput)}`,
		`输出 ${formatTokens(summary.tokens.output)}`,
		`读缓存 ${formatTokens(summary.tokens.cacheRead)}`,
		`写缓存 ${formatTokens(summary.tokens.cacheWrite)}`,
	].join(' · ');
	const model = { data, summary, tally, tokenLine, range, toolsRegistered, liveServices };
	return { summary, tally, tokenLine, model };
}

/**
 * 隐藏元数据块 —— **16 个 `data-vssaros-dashboard-*` 锚点**，也就是探针 `p3-09` 的全部机器断言面。
 *
 * ⚠ **完整页与侧栏紧凑版都用这一处**，且必须"**与布局无关、与表面无关**"地恒在：
 *   完整页里组件可被用户删光、侧栏版根本没有组件网格 —— 锚点若挂在组件里，两种情况都必红 ✗。
 *   （两个版本的 HTML 长得完全不同，唯一必须逐字相同的就是这一块 ⇒ 抽出来是**防漂移**，不是洁癖。）
 */
export function metaBlock({ data, summary, tally, toolsRegistered = '', liveServices = '' }) {
	return `<div hidden data-vssaros-dashboard-meta="1" data-vssaros-dashboard-dir="${escapeHtml(data.dir)}" data-vssaros-dashboard-sessions="${summary.sessions}" data-vssaros-dashboard-active="${summary.active}" data-vssaros-dashboard-live="${data.live ?? 0}" data-vssaros-dashboard-todo-inprogress="${tally.inProgress ?? ''}" data-vssaros-dashboard-waiting="${tally.waiting ?? ''}" data-vssaros-dashboard-retrying="${tally.retrying ?? ''}" data-vssaros-dashboard-running="${tally.running ?? ''}" data-vssaros-dashboard-queued="${tally.queued ?? ''}" data-vssaros-dashboard-subagents="${tally.subagentChildren ?? ''}" data-vssaros-dashboard-subagent-sessions="${tally.subagentSessions ?? ''}" data-vssaros-dashboard-turns="${summary.turns ?? ''}" data-vssaros-dashboard-steps="${summary.steps ?? ''}" data-vssaros-dashboard-output-tokens="${summary.tokens.output ?? ''}" data-vssaros-dashboard-tools="${escapeHtml(toolsRegistered)}" data-vssaros-dashboard-live-services="${escapeHtml(liveServices)}"></div>`;
}

/**
 * 「工作台」组件的数据：**dsh 侧自己维护的模块页清单**（2026-10-13，用户选 ③「dsh 侧自己枚举」）。
 *
 * ⚠ 为什么是静态常量、而不是从 IDE 拿：pin / 显隐 / 顺序的真源在 IDE 的 `WorkbenchManagerService`
 *   （落在 IDE storage ✗），而本页是**服务端渲染**（插件在 Host 里拼 HTML ✓）⇒ 渲染那一刻拿不到 ✗。
 *   既然选了"零新通道"，这份清单就**由 dsh 侧拥有** ⇒ 新增模块时要同步这里 ✓。
 * ⚠ 后果（已与用户确认）：卡片**无法回显** pin / 显隐状态 ⇒ 「固定 / 隐藏」是**单向动作**（点了就生效、
 *   页面不知道结果 ✓），**不是开关** ✗。
 * ⚠ `route` 必须与宿主的模块页表（`dshModuleContainers.ts::DSH_MODULE_PAGES`）一致 —— 打开 / 固定 / 隐藏
 *   三条命令**都按 route 白名单**（IDE 侧再把 route 映射成容器 id ✓）⇒ 这里写错 route 的表现是
 *   "点了没反应（命令被静默拒掉）" ✗ ✓。
 */
const WORKBENCH_MODULES = [
	// ★ 2026-10-21（用户：「主页item ui中的固定，应该默认固定状态，且不可以取消固定」）：
	//   主页是 dsh 侧栏的**常驻入口**（那一行永远在）⇒ 活动栏里它也**恒为固定** ⇒ 卡片上
	//   直接显示「📌 已固定」且**不给取消的入口**（按钮 disabled）✓。
	{ route: '/x/dashboard/', name: '主页', desc: '会话遥测 / 用量与编排', icon: '🏠', alwaysPinned: true },
	{ route: '/x/kanban/', name: '看板', desc: '看板存储与卡片工具', icon: '🗂' },
	{ route: '/x/kb/', name: '知识库', desc: '知识库索引与检索', icon: '📚' },
	{ route: '/x/memory/', name: '记忆库', desc: '记忆条目与检索', icon: '🧠' },
	{ route: '/x/codebase/', name: '代码库', desc: '代码图谱与符号检索', icon: '🕸' },
	{ route: '/x/media/', name: '媒体库', desc: '只读 media.db 页面', icon: '🎬' },
	{ route: '/x/imagegen/', name: '生图', desc: '生图工作台 / 最近出图画廊', icon: '🎨' },
	{ route: '/x/skills/', name: '技能', desc: '技能注册与按需加载', icon: '🧩' },
	{ route: '/x/mcp/', name: 'MCP', desc: 'MCP 服务器与工具', icon: '🔌' },
	{ route: '/x/workflow/', name: '流程', desc: '工作流引擎与画布', icon: '⚙' },
	{ route: '/x/agents/', name: 'Agent', desc: '.agent.md → dsh preset', icon: '🤖' },
	// ★ 2026-10-22（修 bug：主页没有「商城」卡片）：自营商城工作台（`@vssaros/dsh-marketplace`）。
	//   ⚠ 漏登记的后果不止"卡片不显示"：`client.workbenchNav.js` 的 `itemByRoute()` 只认
	//   `DEFAULT_ITEMS` 里的 route ⇒ 卡片就算加进来，点「打开」也会被 route 白名单静默拒掉
	//   （表现为"点了没反应"）✗ ⇒ **两处必须同时登记**（守卫 `check-workbench-catalog.mjs` 盯着 ✓）。
	{ route: '/x/marketplace/', name: '商城', desc: 'Agent / Skill / 工作台 / 工作流的安装与发布', icon: '🛒' },

	{ route: '/x/sessions/', name: '历史会话', desc: '会话分组 / 人格标记 / 指示灯', icon: '🕘' },
];

/** 按 cwd 分组（工作区 = cwd，worktree 目录天然就是另一个 cwd ⇒ 自动分开 ✓）。未知 cwd 单列、不伪造 ✓。 */
function groupByCwd(sessions, limit) {
	const groups = new Map();
	for (const session of sessions) {
		const key = typeof session.cwd === 'string' && session.cwd ? session.cwd : '';
		const g = groups.get(key) ?? { cwd: key, sessions: 0, turns: undefined, steps: undefined, llmMs: undefined, toolMs: undefined, output: undefined };
		g.sessions += 1;
		// 「未知不伪装成 0」：只有**至少一条**带该单元时才累计 ✓（一个都没有 ⇒ 保持 undefined ⇒ 页面写"未知" ✓）
		if (session.stats?.turns !== undefined) { g.turns = (g.turns ?? 0) + session.stats.turns; }
		if (session.stats?.steps !== undefined) { g.steps = (g.steps ?? 0) + session.stats.steps; }
		if (session.stats?.llmMs !== undefined) { g.llmMs = (g.llmMs ?? 0) + session.stats.llmMs; }
		if (session.stats?.toolMs !== undefined) { g.toolMs = (g.toolMs ?? 0) + session.stats.toolMs; }
		if (session.tokens?.output !== undefined) { g.output = (g.output ?? 0) + session.tokens.output; }
		groups.set(key, g);
	}
	return [...groups.values()].sort((a, b) => b.sessions - a.sessions).slice(0, limit);
}

/** token 四路构成 + 按**实际模型**（`modelSelection.used`）分桶 —— 「未知」一律如实写未知 ✓。 */
function usageBuckets(model) {
	const t = model.summary.tokens ?? {};
	const parts = [
		{ key: '输入', value: t.uncachedInput, color: '#4C9AFF' },
		{ key: '输出', value: t.output, color: '#89D185' },
		{ key: '读缓存', value: t.cacheRead, color: '#4EC9B0' },
		{ key: '写缓存', value: t.cacheWrite, color: '#DCDCAA' },
	];
	const total = parts.reduce((sum, p) => sum + (p.value ?? 0), 0);
	const byModel = new Map();
	for (const session of model.summary.sorted) {
		const used = session.model?.used;
		const key = used?.provider && used?.model ? `${used.model}（${used.provider}）` : '未知（缓存里没有该单元）';
		const row = byModel.get(key) ?? { key, sessions: 0, output: undefined };
		row.sessions += 1;
		if (session.tokens?.output !== undefined) { row.output = (row.output ?? 0) + session.tokens.output; }
		byModel.set(key, row);
	}
	return { parts, total, byModel: [...byModel.values()].sort((a, b) => b.sessions - a.sessions) };
}

/**
 * 组件目录。**顺序 = 「添加组件」画廊里的推荐顺序**，与页面上的顺序无关（那由布局决定）。
 *
 * ⚠ `diag` 这块原先背着 18 个 `data-vssaros-dashboard-*` 锚点；现在锚点搬到页面的隐藏元数据块里
 *   （因为组件可被用户删掉，而探针的锚点必须稳定 —— 见 `index.js` 的 `renderDashboardPage`）。
 */
export const WIDGETS = [
	{
		kind: 'kpi',
		name: '关键指标',
		description: '会话 / turn / step / 模型·工具耗时，以及「运行状态」清点（待办 / 待回答 / 重试 / 排队 / 子代理）',
		icon: 'graph',
		accent: '#4C9AFF',
		defaultSize: { w: GRID_COLUMNS, h: 1 },
		defaultConfig: () => ({}),
		render(model) {
			const { summary, tally } = model;
			return `<div class="cards">
	<div class="card"><b>${summary.sessions}</b><span>会话（${summary.active} 个活跃）</span></div>
	<div class="card"><b>${summary.turns ?? '未知'}</b><span>turn</span></div>
	<div class="card"><b>${summary.steps ?? '未知'}</b><span>step</span></div>
	<div class="card"><b>${formatMs(summary.llmMs)}</b><span>模型耗时</span></div>
	<div class="card"><b>${formatMs(summary.toolMs)}</b><span>工具耗时</span></div>
${tally.todoSessions !== undefined ? `	<div class="card"><b>${tally.inProgress ?? 0}</b><span>进行中待办（${tally.todoSessions} 个会话有清单）</span></div>\n` : ''}${tally.waiting ? `	<div class="card"><b>${tally.waiting}</b><span>待用户回答 / 审批</span></div>\n` : ''}${tally.activePlans ? `	<div class="card"><b>${tally.activePlans}</b><span>计划模式生效</span></div>\n` : ''}${tally.retrying ? `	<div class="card"><b>${tally.retrying}</b><span>正在重试（LLM）</span></div>\n` : ''}${tally.running ? `	<div class="card"><b>${tally.running}</b><span>回合进行中</span></div>\n` : ''}${tally.queued ? `	<div class="card"><b>${tally.queued}</b><span>排队待发</span></div>\n` : ''}${tally.subagentChildren ? `	<div class="card"><b>${tally.subagentChildren}</b><span>派出的子代理</span></div>\n` : ''}${tally.subagentSessions ? `	<div class="card"><b>${tally.subagentSessions}</b><span>是子代理的会话</span></div>\n` : ''}${tally.subagentRunning ? `	<div class="card"><b>${tally.subagentRunning}</b><span>子代理正在跑</span></div>\n` : ''}</div>`;
		},
	},
	{
		kind: 'diag',
		name: '诊断行',
		description: 'token 明细 / 数据目录 / 工具注册情况 / live 通道（排障用；机器可断言的锚点**不在这里**）',
		icon: 'pulse',
		accent: '#8A8A8E',
		defaultSize: { w: GRID_COLUMNS, h: 1 },
		defaultConfig: () => ({}),
		render(model) {
			const { data, tokenLine, toolsRegistered, liveServices } = model;
			return `<p class="diag">token：${tokenLine} · 数据目录 <code>${escapeHtml(data.dir)}</code> · 工具 <code>${escapeHtml(toolsRegistered)}</code> · live 服务 <code>${escapeHtml(liveServices)}</code> · 本轮由 live 覆盖 <code>${data.live ?? 0}</code> 个会话（其余为 cache）</p>`;
		},
	},
	{
		kind: 'sessions',
		name: '会话明细',
		description: '按创建时间倒序的会话列表（含 turn/step/token/运行状态/子代理），条数可配',
		icon: 'list-unordered',
		accent: '#3FB950',
		defaultSize: { w: GRID_COLUMNS, h: 3 },
		defaultConfig: () => ({ limit: SESSIONS_LIMIT_DEFAULT }),
		// 逐组件归一化（R3）：用户填的值也要被纠正后才用。
		normalizeConfig(raw) {
			return { limit: clampInt(raw?.limit, 1, SESSIONS_LIMIT_MAX, SESSIONS_LIMIT_DEFAULT) };
		},
		render(model, config) {
			const { summary } = model;
			const limit = clampInt(config?.limit, 1, SESSIONS_LIMIT_MAX, SESSIONS_LIMIT_DEFAULT);
			const shown = summary.sorted.slice(0, limit);
			const rows = shown.length ? sessionRowsHtml(shown) : '';
			// ⚠ 标题里的计数必须与**实际列出**的条数一致：只按聚合总数写，会出现"56 个"却只列 50 条的自相矛盾 ✗
			//   （等价重构：默认 limit=50 且库里 ≤ 50 时两个数相等 ⇒ 文案与改造前逐字一致 ✓）
			const countLabel = shown.length === summary.sorted.length
				? `${summary.sorted.length} 个（按创建时间倒序）`
				: `显示 ${shown.length} / 共 ${summary.sorted.length} 个（按创建时间倒序）`;
			// ⚠ 2026-10-13（用户："会话组件太长了，限制高度使用滚动条滚动即可"）：列表**自己滚动** ✓
		//   —— 计数行（`<h2>`）留在滚动容器**外面** ⇒ 无论滚到哪都能看见总数 ✓（比塞进去更有用）。
		//   ⚠ 帽子与"卡片可被拉高"不冲突：`h` 的语义是**最小高度**（见 layout.js），这里是"列表最多
		//   占视口一半"，超过就滚 ✓ —— 用它而不是 `h` 的原因：**已落盘的布局里 `h` 还是旧值 3** ✗，
		//   按 `h` 算帽子会让老用户看到只有一两行（等于把改动变成回归 ✗）。
		return `<h2>会话 <small>${countLabel}</small></h2>
${rows ? `<div class="dash-scroll" data-dash-scroll="sessions"><ul>${rows}</ul></div>` : '<p class="empty">没有可显示的会话。</p>'}`;
		},
	},
	// ── 2026-10-13 新增（用户要求；参考 Obsidian Home Pages 的组件思路，代码自写 ✓）─────────────
	{
		kind: 'workbench',
		name: '工作台',
		description: 'dsh 模块页入口：打开 / 固定 / 从活动栏隐藏（后两个是单向动作；主页恒为固定）',
		icon: 'home',
		accent: '#C586C0',
		defaultSize: { w: GRID_COLUMNS, h: 3 },
		defaultConfig: () => ({ order: [] }),
		/**
		 * 条目顺序 —— **用户拖出来的**（★ 2026-10-13 用户要求：**非编辑态也允许拖拽排序** ✓）。
		 * 逐项过滤：只留非空字符串、去重、最多 64 项 ✓（顺序里出现但已不存在的 route 无害 ⇒ 渲染时忽略 ✓）。
		 */
		normalizeConfig(raw) {
			const list = Array.isArray(raw?.order) ? raw.order : [];
			const seen = new Set();
			const order = [];
			for (const entry of list) {
				if (typeof entry === 'string' && entry && !seen.has(entry)) {
					seen.add(entry);
					order.push(entry);
				}
				if (order.length >= 64) {
					break;
				}
			}
			return { order };
		},
		render(model, config) {
			// ⚠ 排序规则刻意**保守**：不在顺序里的模块（新装的插件 ✓）排在**最后**、仍按默认序 ✓
			//   —— 不能因为用户排过序，新模块就"不见了"或跑到奇怪位置 ✗；顺序里已不存在的 route 直接忽略 ✓。
			const saved = Array.isArray(config?.order) ? config.order : [];
			const rank = new Map();
			saved.forEach((route, index) => {
				if (!rank.has(route)) {
					rank.set(route, index);
				}
			});
			const ordered = WORKBENCH_MODULES
				.map((entry, index) => ({ entry, index }))
				.sort((a, b) => {
					const ra = rank.has(a.entry.route) ? rank.get(a.entry.route) : Number.MAX_SAFE_INTEGER;
					const rb = rank.has(b.entry.route) ? rank.get(b.entry.route) : Number.MAX_SAFE_INTEGER;
					return ra === rb ? a.index - b.index : ra - rb;
				})
				.map(item => item.entry);
			// ⚠ `data-dash-wb-route` 是客户端算"拖后的顺序"用的（只认这个属性和 DOM 次序 ✓，不猜别的 ✓）
			const cards = ordered.map(m => `<div class="wb-card" data-dash-wb-route="${escapeHtml(m.route)}">
	<div class="wb-nm"><span>${m.icon}</span>${escapeHtml(m.name)}</div>
	<div class="wb-desc">${escapeHtml(m.desc)}</div>
	<div class="wb-ops"><button type="button" class="wb-op" data-dash-action="open-module" data-dash-route="${escapeHtml(m.route)}">↗ 打开</button>${m.alwaysPinned ? '<button type="button" class="wb-op" disabled title="主页恒为固定（不可取消）">📌 已固定</button>' : '<button type="button" class="wb-op" data-dash-action="pin-module" data-dash-route="' + escapeHtml(m.route) + '">📌 固定</button>'}<button type="button" class="wb-op" data-dash-action="hide-module" data-dash-route="${escapeHtml(m.route)}">👁 从活动栏隐藏</button></div>
</div>`).join('');
			return `<div class="wb-grid" data-dash-workbench="1">${cards}</div>
<p class="diag">这些按钮是<b>单向动作</b>：dsh 侧读不到 IDE 的固定 / 显隐状态（用户选的是"dsh 侧自己枚举"）⇒ 卡片<b>不回显</b>"已固定 / 已隐藏"，点了就生效、页面不知道结果。顺序可以直接<b>拖动卡片</b>调整（不需要进"编排"模式 ✓）。</p>`;
		},
	},
	{
		kind: 'workspaces',
		name: '工作区统计',
		description: '按 cwd 分组（worktree 目录天然是另一个 cwd）的会话数 / turn·step / 耗时 / 输出 token',
		icon: 'folder',
		accent: '#4C9AFF',
		defaultSize: { w: 6, h: 2 },
		defaultConfig: () => ({ limit: 8 }),
		normalizeConfig(raw) {
			return { limit: clampInt(raw?.limit, 1, 30, 8) };
		},
		render(model, config) {
			const limit = clampInt(config?.limit, 1, 30, 8);
			const groups = groupByCwd(model.summary.sorted, limit);
			if (!groups.length) {
				return '<h2>工作区 <small>按 cwd 分组</small></h2><p class="empty">没有可显示的会话。</p>';
			}
			const top = groups[0].sessions;
			const rows = groups.map(g => `<tr>
	<td><code>${escapeHtml(g.cwd || '（cwd 未知）')}</code></td>
	<td>${g.sessions}</td>
	<td>${g.turns ?? '未知'} / ${g.steps ?? '未知'}</td>
	<td>${g.llmMs === undefined ? '未知' : formatMs(g.llmMs)}</td>
	<td>${g.output === undefined ? '未知' : formatTokens(g.output)}</td>
</tr>
<tr><td colspan="5"><div class="ws-track"><i style="width: ${Math.round((g.sessions / top) * 100)}%"></i></div></td></tr>`).join('');
			return `<h2>工作区 <small>按 cwd 分组（${model.summary.sorted.length} 个会话）</small></h2>
<table>
<tr><th>工作区</th><th>会话</th><th>turn / step</th><th>模型耗时</th><th>输出 token</th></tr>
${rows}
</table>
<p class="diag">未知一律写"未知"，不伪装成 0（某个工作区一条会话都没带该单元时就是这样 ✓）。</p>`;
		},
	},
	{
		kind: 'usage',
		name: '用量分布',
		description: 'token 四路构成（输入 / 输出 / 读缓存 / 写缓存）＋ 按实际使用的模型分桶',
		icon: 'graph-line',
		accent: '#4EC9B0',
		defaultSize: { w: 6, h: 2 },
		defaultConfig: () => ({}),
		render(model) {
			const { parts, total, byModel } = usageBuckets(model);
			const bar = total > 0
				? `<div class="stack">${parts.filter(p => (p.value ?? 0) > 0).map(p => `<i style="width: ${(p.value / total) * 100}%; background: ${p.color}" title="${escapeHtml(p.key)}"></i>`).join('')}</div>`
				: '<p class="empty">范围内没有 token 用量可显示。</p>';
			const legend = parts.map(p => `<span><i style="background: ${p.color}"></i>${escapeHtml(p.key)} ${p.value === undefined ? '未知' : formatTokens(p.value)}</span>`).join('');
			const modelRows = byModel.map(row => `<tr><td>${escapeHtml(row.key)}</td><td>${row.sessions}</td><td>${row.output === undefined ? '未知' : formatTokens(row.output)}</td></tr>`).join('');
			return `<h2>用量 <small>四路构成 ＋ 按模型</small></h2>
${bar}
<div class="legend">${legend}</div>
<table>
<tr><th>实际使用的模型（modelSelection.used）</th><th>会话</th><th>输出 token</th></tr>
${modelRows}
</table>
<p class="diag">数据全来自会话投影缓存；模型只认<b>实际用过</b>的那个（"已选未生效"的不算 ✓）。</p>`;
		},
	},
	{
		kind: 'clock',
		name: '时钟',
		description: '本地时间 / 日期（服务端给初值，客户端每秒自走；页面不重载）',
		icon: 'watch',
		accent: '#DCDCAA',
		defaultSize: { w: 3, h: 2 },
		defaultConfig: () => ({}),
		render() {
			// 服务端先渲染一个初值（脚本没跑起来时也不至于空着 ✓），客户端接管让它走 ✓
			const now = new Date();
			const p = n => String(n).padStart(2, '0');
			const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
			return `<div class="clock" data-dash-clock="1">
	<div class="clock-t" data-dash-clock-time>${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}</div>
	<div class="clock-d" data-dash-clock-date>${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${week}</div>
</div>`;
		},
	},
	{
		kind: 'pomodoro',
		name: '番茄时钟',
		description: '专注 / 休息计时（纯客户端，刻意不落盘 —— 关掉页面即停）',
		icon: 'timer',
		accent: '#F48771',
		defaultSize: { w: 3, h: 3 },
		defaultConfig: () => ({ focus: 25, break: 5 }),
		normalizeConfig(raw) {
			return { focus: clampInt(raw?.focus, 5, 90, 25), break: clampInt(raw?.break, 1, 30, 5) };
		},
		render(model, config) {
			const focus = clampInt(config?.focus, 5, 90, 25);
			const brk = clampInt(config?.break, 1, 30, 5);
			return `<div class="pomo" data-dash-pomodoro="1" data-dash-focus="${focus}" data-dash-break="${brk}">
	<svg class="pomo-ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" stroke-opacity=".12" stroke-width="8"></circle><circle data-dash-pomo-arc cx="50" cy="50" r="42" fill="none" stroke="#4EC9B0" stroke-width="8" stroke-linecap="round" transform="rotate(-90 50 50)"></circle></svg>
	<div class="pomo-t" data-dash-pomo-time>${String(focus).padStart(2, '0')}:00</div>
	<div class="pomo-ph" data-dash-pomo-phase>专注 · 第 1 个</div>
	<div class="pomo-ops"><button type="button" class="dash-btn" data-dash-action="pomo-toggle">开始</button><button type="button" class="dash-btn" data-dash-action="pomo-reset">重置</button></div>
</div>`;
		},
	},
];

/**
 * 「添加组件」画廊用的目录摘要（**只含客户端需要的字段**）⇒ 服务端把它塞进页面的 JSON 岛，
 * 客户端据此渲染画廊并在加卡时取默认尺寸 ✓。
 *
 * ⚠ 与 `WIDGETS` **同源**（加一个组件不必改两处 ✓）；探针断言"岛里的 kind 集合 == 目录的 kind 集合" ✓
 * （两处漂移的表现是"画廊里有、点了加不出来"，且**不报错** ✗）。
 */
export function serializeCatalog(presentKinds) {
	// ★ 2026-10-13（用户要求「不允许重复添加组件」）：传进来的 kind 表示"页面上已经有了" ⇒
	//   画廊里标成「已添加」并在点击时给出回话 ✓。**权威判定在 `layout.js` 的 `normalizeLayout`**
	//   （写口与渲染口都经过它 ✓），这里只是**看得见**的那一半 ✓。
	const have = presentKinds instanceof Set ? presentKinds : new Set(presentKinds ?? []);
	return WIDGETS.map(widget => ({
		kind: widget.kind,
		name: widget.name,
		description: widget.description,
		icon: widget.icon,
		accent: widget.accent,
		w: widget.defaultSize.w,
		h: widget.defaultSize.h,
		added: have.has(widget.kind),
	}));
}

/** kind → 定义。未知 kind 返回 `undefined`（调用方据此渲染**占位卡**）。 */
export function getWidget(kind) {
	return WIDGETS.find(widget => widget.kind === kind);
}

/** 全部可用 kind（探针用它断言"默认布局没引用不存在的组件"）。 */
export const WIDGET_KINDS = new Set(WIDGETS.map(widget => widget.kind));

/** 组件的归一化配置（缺 `normalizeConfig` 时就是默认值 + 原样补齐）。 */
export function normalizeWidgetConfig(widget, raw) {
	if (!widget) {
		return { ...(raw ?? {}) };
	}
	return widget.normalizeConfig ? widget.normalizeConfig(raw) : { ...widget.defaultConfig(), ...(raw ?? {}) };
}

/** 卡片标题（自定义标题优先，否则用目录里的名字）。P3 的编辑态用它。 */
export function widgetTitle(item) {
	const custom = typeof item?.title === 'string' ? item.title.trim() : '';
	if (custom) {
		return custom;
	}
	return getWidget(item?.kind)?.name ?? item?.kind ?? '(未知组件)';
}
