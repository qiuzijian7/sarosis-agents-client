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
import { GRID_COLUMNS, clampInt, textOf } from './layout.js';

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
/**
 * 单条会话行的**展示数据**（纯文本，不含 HTML）—— SSR 与 React 版共用这一处。
 *
 * ⚠ 为什么抽出来：主页现在有两套渲染（服务端字符串 / 页面里的 React）⇒ 文案若各写一份必然漂移
 *   （表现就是"同一个会话在两版里字段不一样"）✗。这里只产出「标题 + 若干行文本」，
 *   结构（`<li><code><small>`）交给渲染层 ⇒ 文案口径只有一处 ✓。
 * ⚠ 文案逐字由 `p3-46` 钉着（`来源 cache` / `参与标题的输入` / `turn` / `token：输入` / 子代理身份）。
 */
export function sessionRowModel(session) {
	const lines = [];
	lines.push(`${shortPath(session.cwd)} · ${session.preset ?? '未知 preset'} · ${isoOf(session.createdAt)} · 来源 ${session.source}${listMetaText(session)}${titleInputText(session)}`);
	if (session.model) {
		lines.push(modelText(session));
	}
	const sub = subagentText(session);
	if (sub) {
		lines.push(sub);
	}
	lines.push(`turn ${session.stats?.turns ?? '未知'} · step ${session.stats?.steps ?? '未知'} · LLM ${formatMs(session.stats?.llmMs)} · 工具 ${formatMs(session.stats?.toolMs)}`);
	lines.push(`token：输入 ${formatTokens(session.tokens?.uncachedInput)} · 输出 ${formatTokens(session.tokens?.output)} · 读缓存 ${formatTokens(session.tokens?.cacheRead)} · 表面 ${formatTokens(session.surfaceTokens)}${contextUsageText(session)}${contextBreakdownText(session)}`);
	// 没有「运行中」信号的会话不渲染这一行（而不是渲染"运行中：0"——那正是"未知伪装成 0"）
	if (session.activity) {
		lines.push(`运行中：${activityText(session.activity)}`);
	}
	return {
		id: String(session.id),
		title: session.title ?? '(无标题)',
		cold: !session.active,
		lines,
		// ★ 2026-10-23：**结构化字段**（additive，`lines` 一字未动 ⇒ 文案守卫不受影响）。
		//   为什么要它：主页的会话卡要做成"表格"（turn / step / 耗时各一列），
		//   从 `lines` 里 regex 抠数字是最脆的写法（文案一改就静默错）。
		//   值未知时给 `undefined`（渲染层显示「未知」），**不伪装成 0**。
		turns: session.stats?.turns,
		steps: session.stats?.steps,
		llmMs: session.stats?.llmMs,
		cwd: String(session.cwd ?? ''),
	};
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
export const WORKBENCH_MODULES = [
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
	// ★ 2026-10-23（用户：「技能 item 改名为 工具，描述改为 技能、工具、mcp、agent、工作流、工作台」）：
	//   文案与侧栏 `DEFAULT_ITEMS` 对齐（那边也叫「工具」）——同一个入口在两处叫不同名字最容易让人找不到。
	{ route: '/x/skills/', name: '工具', desc: '技能、工具、mcp、agent、工作流、工作台', icon: '🧩' },
	// ★ 2026-10-23（用户：「移除 mcp 工作台」）：MCP **不是整页模块**（`DSH_MODULE_PAGES` 里没有它，
	//   服务器挂载在 VsSaros 启动时用 `--patch` 做）⇒ 它既不在侧栏 `DEFAULT_ITEMS`、也不在 route 白名单里
	//   ⇒ 这张卡片点「打开」本来就会被**静默拒掉**（表现为"点了没反应"）。移除卡片正好把这个假入口清掉 ✓。
	//   （MCP 服务器本身仍在「工具」页的 MCP 页签里管理 ✓）
	{ route: '/x/workflow/', name: '流程', desc: '工作流引擎与画布', icon: '⚙' },
	{ route: '/x/agents/', name: 'Bots', desc: '.agent.md → dsh preset', icon: '🤖' },
	// ★ 2026-10-22（修 bug：主页没有「商城」卡片）：自营商城工作台（`@vssaros/dsh-marketplace`）。
	//   ⚠ 漏登记的后果不止"卡片不显示"：`client.workbenchNav.js` 的 `itemByRoute()` 只认
	//   `DEFAULT_ITEMS` 里的 route ⇒ 卡片就算加进来，点「打开」也会被 route 白名单静默拒掉
	//   （表现为"点了没反应"）✗ ⇒ **两处必须同时登记**（守卫 `check-workbench-catalog.mjs` 盯着 ✓）。
	{ route: '/x/marketplace/', name: '商城', desc: 'Agent / Skill / 工作台 / 工作流的安装与发布', icon: '🛒' },
	// ★ 2026-10-23（用户：「saros 工作台显示站点前端 + 右上角 AI 助手 → 右侧 chat-surface」）：
	//   萨罗斯管理平台工作台（`@vssaros/dsh-studio`，页面 `/x/studio/` = 站点 iframe + 站点栏）。
	//   ⚠ 与 `client.workbenchNav.js` 的 `DEFAULT_ITEMS` **必须两处同时登记**，否则「打开」被
	//   route 白名单静默拒掉（"点了没反应"）；守卫 `check-workbench-catalog.mjs` 盯着。
	{ route: '/x/studio/', name: '萨罗斯管理平台', desc: '承载 Saroasis Studio System 前端；右上角「AI 助手」开右侧 chat-surface', icon: '◱' },
	// ★ 2026-10-24：小红书笔记（创作型工作台样板 `@vssaros/dsh-xhs-note`）。
	//   ⚠ 与 `client.workbenchNav.js` 的 `DEFAULT_ITEMS` 必须两处同时登记（那边同时是 route 白名单）。
	// ★ 2026-10-30（用户要求「删除小红书工作台」）：`@vssaros/dsh-xhs-note` 已卸载 ⇒ 它的卡片一并删除。

	{ route: '/x/sessions/', name: '历史会话', desc: '会话分组 / 人格标记 / 指示灯', icon: '🕘' },
	// ★ 2026-10-22（用户：「多 TUI 应该设计为一个工作台，在主页中显示 item」）：
	//   并行 TUI 工作台（`@vssaros/dsh-parallel`）。⚠ 与 `client.workbenchNav.js` 的 `DEFAULT_ITEMS`
	//   **必须两处同时登记**（漏一处 ⇒ 卡片在、点「打开」被 route 白名单静默拒掉 = 点了没反应 ✗，
	//   守卫 `check-workbench-catalog.mjs` 盯着）；⚠ route 还必须与宿主 `DSH_MODULE_PAGES` 一致。
	{ route: '/x/parallel/', name: '并行 TUI 工作台', desc: '并排编排多个并行 LLM 会话：每格一个 TUI，可观察 / 收割 / 接管', icon: '🖥' },
	// ★ 2026-10-30（用户要求「移除萨罗斯中转站工作台」）：`@vssaros/dsh-relay` 已卸载 ⇒
	//   这里同步删掉它的卡片（与 `client.workbenchNav.js` 的条目必须同时改）。
	// ★ 2026-10-28（用户：「dsh 侧增加定时任务工作台，复用原生的定时任务 UI」）：
	//   scheduler 0.3.0 起工作台内容 = 官方原生任务管理页（`@deepseek-ai/dsh-client-ui-schedule` 的
	//   `TaskManagerPage`），它已经是**正经工作台**（页签 + 满页渲染）⇒ 主页必须给入口。
	//   ⚠ 原先这里**故意豁免**了它（当时的理由是"自动化任务不是工作台"，见
	//   `check-workbench-catalog.mjs` 的 HOST_EXEMPT）—— 那个理由现在不成立了 ⇒ 豁免已删。
	//   ⚠ 与 `client.workbenchNav.js` 的 `DEFAULT_ITEMS` 必须两处同时登记（那边同时是 route 白名单
	//   ⇒ 漏登记 = 卡片在、点「打开」被静默拒掉 = "点了没反应"）。
	{ route: '/x/scheduler/', name: '自动化任务', desc: '按计划自动运行 Agent；原生任务页（搜索 / 筛选 / 详情 / 投递历史）', icon: '⏰' },
];

/** 按 cwd 分组（工作区 = cwd，worktree 目录天然就是另一个 cwd ⇒ 自动分开 ✓）。未知 cwd 单列、不伪造 ✓。 */
export function groupByCwd(sessions, limit) {
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
export function usageBuckets(model) {
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
 *
 * ⚠⚠ 2026-10-22（主页改 React 渲染）：**`render()` 这一族已经不是活的渲染路径了** ——
 *   完整页现在只出「壳 + 数据岛」（`index.js` 的 `renderDashboardPage`），卡片由
 *   `lib/app/src/app.jsx` 的 React 组件画。这里保留的是**元数据**（`kind` / `name` /
 *   `defaultSize` / `defaultConfig` / `normalizeConfig`，`serializeCatalog` 与画廊在用）。
 *   ⇒ 要改外观去改 `app.jsx` / `app.css`；**别在这里加新渲染逻辑**（改了也不会生效，最坑的形态）。
 *   清理待办：把 `render()` 与随之失去调用方的 `getWidget` / `sessionRowsHtml` / `widgetTitle` 一并删掉。
 */
/**
 * 布尔归一化（给 `type: 'toggle'` 的配置字段用）。
 *
 * ⚠ 只认 `true/false`（含 JSON 里的字符串形式）—— 手改 `layout.json` 写成 `"abc"` 时**回落 fallback**，
 *   而不是按 JS 真值当成 true（"未知伪装成已开启"是同一类错 ✗）。
 */
function boolOf(value, fallback) {
	if (value === true || value === 'true') { return true; }
	if (value === false || value === 'false') { return false; }
	return fallback;
}

/** 枚举归一化（给 `type: 'select'` 的配置字段用）：不在白名单里就回落 fallback。 */
function enumOf(value, allowed, fallback) {
	return allowed.includes(value) ? value : fallback;
}

export const WIDGETS = [
	{
		kind: 'kpi',
		name: '关键指标',
		description: '会话 / turn / step / 模型·工具耗时，以及「运行状态」清点（待办 / 待回答 / 重试 / 排队 / 子代理）',
		icon: 'graph',
		accent: '#4C9AFF',
		defaultSize: { w: GRID_COLUMNS, h: 1 },
		defaultConfig: () => ({}),
	},
	{
		kind: 'diag',
		name: '诊断行',
		description: 'token 明细 / 数据目录 / 工具注册情况 / live 通道（排障用；机器可断言的锚点**不在这里**）',
		icon: 'pulse',
		accent: '#8A8A8E',
		defaultSize: { w: GRID_COLUMNS, h: 1 },
		defaultConfig: () => ({}),
	},
	{
		kind: 'sessions',
		name: '会话明细',
		description: '按创建时间倒序的会话列表（含 turn/step/token/运行状态/子代理），条数可配',
		icon: 'list-unordered',
		accent: '#3FB950',
		defaultSize: { w: GRID_COLUMNS, h: 3 },
		defaultConfig: () => ({ limit: SESSIONS_LIMIT_DEFAULT }),
		// ★ 2026-10-22：**可配字段声明**（渲染层据此自动画设置面板，见 app.jsx 的 CardSettings）。
		//   ⚠ `min/max/fallback` 必须与 `normalizeConfig` 里的夹紧**同值** —— 守卫用行为断言钉住
		//     （`normalizeWidgetConfig(max+100) === max`）。面板给的界比夹紧宽 ⇒ 用户填了会被悄悄改掉 ✗。
		configFields: [
			{ key: 'limit', label: '最多显示', unit: '条', min: 1, max: SESSIONS_LIMIT_MAX, step: 1, fallback: SESSIONS_LIMIT_DEFAULT },
			{
				key: 'order', label: '排序', type: 'select', fallback: 'desc',
				options: [{ value: 'desc', label: '最新在前' }, { value: 'asc', label: '最早在前' }],
			},
			// ★ 文本型配置（2026-10-22）：唯一一个**真有用途**的文本项 —— 按标题/主题过滤会话。
			//   `maxLength` 必填：不截断的话一个粘贴进去的长串会把面板与卡片撑坏。
			{ key: 'keyword', label: '只看包含', type: 'text', maxLength: 40, placeholder: '标题里的关键字', fallback: '' },
		],
		// 逐组件归一化（R3）：用户填的值也要被纠正后才用。
		normalizeConfig(raw) {
			return {
				limit: clampInt(raw?.limit, 1, SESSIONS_LIMIT_MAX, SESSIONS_LIMIT_DEFAULT),
				order: enumOf(raw?.order, ['desc', 'asc'], 'desc'),
				keyword: textOf(raw?.keyword, 40, ''),
			};
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
	},
	{
		kind: 'workspaces',
		name: '工作区统计',
		description: '按 cwd 分组（worktree 目录天然是另一个 cwd）的会话数 / turn·step / 耗时 / 输出 token',
		icon: 'folder',
		accent: '#4C9AFF',
		defaultSize: { w: 6, h: 2 },
		defaultConfig: () => ({ limit: 8 }),
		configFields: [
			{ key: 'limit', label: '最多显示', unit: '个工作区', min: 1, max: 30, step: 1, fallback: 8 },
		],
		normalizeConfig(raw) {
			return { limit: clampInt(raw?.limit, 1, 30, 8) };
		},
	},
	{
		kind: 'usage',
		name: '用量分布',
		description: 'token 四路构成（输入 / 输出 / 读缓存 / 写缓存）＋ 按实际使用的模型分桶',
		icon: 'graph-line',
		accent: '#4EC9B0',
		defaultSize: { w: 6, h: 2 },
		defaultConfig: () => ({ showByModel: true }),
		configFields: [
			{ key: 'showByModel', label: '按模型分桶表', type: 'toggle', fallback: true },
		],
		normalizeConfig(raw) {
			return { showByModel: boolOf(raw?.showByModel, true) };
		},
	},
	{
		kind: 'clock',
		name: '时钟',
		description: '本地时间 / 日期（服务端给初值，客户端每秒自走；页面不重载）',
		icon: 'watch',
		accent: '#DCDCAA',
		defaultSize: { w: 3, h: 2 },
		defaultConfig: () => ({ showSeconds: true, hour12: false }),
		configFields: [
			{ key: 'showSeconds', label: '显示秒', type: 'toggle', fallback: true },
			{ key: 'hour12', label: '12 小时制', type: 'toggle', fallback: false },
		],
		normalizeConfig(raw) {
			return { showSeconds: boolOf(raw?.showSeconds, true), hour12: boolOf(raw?.hour12, false) };
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
		configFields: [
			{ key: 'focus', label: '专注', unit: '分钟', min: 5, max: 90, step: 5, fallback: 25 },
			{ key: 'break', label: '休息', unit: '分钟', min: 1, max: 30, step: 1, fallback: 5 },
		],
		normalizeConfig(raw) {
			return { focus: clampInt(raw?.focus, 5, 90, 25), break: clampInt(raw?.break, 1, 30, 5) };
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
		// ★ 2026-10-22：可配字段一并发给页面 ⇒ 设置面板由「声明」自动生成（不是每个组件写一套表单）。
		//   没有 `configFields` 的组件 ⇒ 面板不出现齿轮（见 app.jsx）。
		configFields: Array.isArray(widget.configFields) ? widget.configFields : [],
	}));
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

