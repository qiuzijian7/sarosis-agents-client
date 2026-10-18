// @vssaros/dsh-kanban — board：看板页（**编辑区完整版**）的纯逻辑 + 渲染。
//
// 为什么要有它（2026-10-14，用户：「Tasks 工作台缺少打开按钮 …… 参考开源的看板项目，实现优化方案」）：
// 改造前**两种承载表面渲染的是同一份只读列表**（侧栏 300px 与编辑区整屏长得一模一样）⇒ 侧栏没有入口、
// 编辑区用不上横向空间。现在分成两半：
//   · 本文件 = **编辑区**的完整版（多列看板；不带 `?surface=` 参数时走这条，探针 p3-01 走的正是这条）；
//   · `lib/sideview.js` = **侧栏**的摘要版（宿主承载侧栏时注入 `?surface=sideview`）。
//
// 口径来自**同一份数据**的两个现成参照（只借鉴设计，代码全部自写）：
//   · IDE 侧真看板 `src/vs/sessions/contrib/agentStudio/webview/src/features/taskboard/TaskBoardPanel.tsx`
//     的 `COLUMNS` 常量：5 列聚合（todo+ready / running+blocked / done / cancelled / archived）；
//     ⚠ 那 5 列里**没有 triage**，而 dsh 的 `kanban_create` 默认建的正是 `triage` ⇒ 照抄会让"模型刚建的卡
//     在 dsh 看板上直接消失" ⇒ 本文件的列**多一列 triage（待分解）**，这是与 IDE 那侧**故意的差异**。
//   · 开源看板（Planka / Wekan / Focalboard / Kanboard）的共性：列 = 状态、列头计数、卡片只放"扫一眼就够"
//     的字段、详情按需展开、筛选常驻顶部。
//
// ★★ 一条硬约束（数据现实，实测过）：本机 `~/.vssaros-dev/taskboard.json` = 55 条 / **4.5 MB**，
//    **单条描述最长 266 KB**（追加记录与未清洗内容）。⇒ 卡片**绝不可**整段带描述（`project()` 正好不带 ✓），
//    卡片上的预览只是**首行 80 字**（服务端切片，过线的是预览不是原文 ✓），全文只在详情接口里按需给。
//
// ★★ 写路径（2026-10-14 第二刀：用户回「继续」= 对 D4 的签字 —— 原方案稿里 D4 一期只读、二期做拖拽改状态）：
//    **拖拽改状态**是这一页**唯一**的写动作，边界如下（四条一起才成立，缺一条都不能算安全）：
//      ① **动作白名单**：请求只认 `{ id, to: <列 key> }`，服务端把列 key 翻成**该列声明的落列状态**
//         （`BOARD_COLUMNS[].dropStatus`）—— **不接受任意 status** ✗（否则这页就成了"改任意字段"的写口）；
//      ② **running 保护**：`running` 卡片**拖不动**（与 IDE 侧 `TaskCard.isDraggable` 同口径：执行中的活
//         不该被 UI 抢走），且"执行中"这一列**不接受落卡**（拖进去该设 running 还是 blocked？语义不清 ⇒ 拒绝）；
//      ③ **写路径复用既有那一套**：`mutateTaskboard` 的跨进程锁 ＋ 原子写 ＋ 指纹 CAS ＋ 模块级串行 ⇒
//         **不新增写者、不新增协议**（`owns: taskboard.json` 本来就声明着，页面写的是同一个 owner 的文件）；
//      ④ **与工具同语义**：改状态一律走 `core/taskboard.js` 的 `applyUpdate({ status })` ⇒ `completedAt`
//         的写/清与 `kanban_update` / `kanban_complete` 逐字一致（两端同一份文件，语义分叉比缺功能更糟）。
//    ⚠ **审批语义的界线**（这条必须说清，否则会被误读成"绕过审批"）：`tools/pre-execute` 的那个 `ask` 闸
//      只管**模型调用工具**那条链；用户在看板上拖一下是**用户自己的界面操作**（同 IDE 侧那份看板），
//      它不走那条链，而是走上面 ①②③④ 这四条边界 ＋ 同源 ＋ Host 自己的鉴权栅栏（`connection.requestRejection`）。
//
// ⚠ 本文件里的 CSS / 客户端脚本都在**模板字符串**里 ⇒ **不许出现反引号**（会提前闭合整页，本仓已踩 5 次；
//   探针 p3-88 有一条指名道姓的元检查盯着它）。
//
// ⚠ `lib/pageShell.js` 是四个模块插件**逐字节相同**的 vendor 副本（守卫断言四份一致）⇒ 本文件**不许改它**，
//    看板自己的样式一律走 `renderShell({ extraCss })`。

import { escapeHtml, renderShell } from './pageShell.js';
import { DETAIL_DESCRIPTION_LIMIT, STATUSES } from './core/taskboard.js';

/** 状态 → 图标（逐条照 `tasksView.ts` 的 `_getStatusIcon`，与改造前同一份表）。 */
export const STATUS_ICONS = {
	triage: '🗂', todo: '⬜', ready: '✔️', running: '⚡', blocked: '🚧', done: '✅', cancelled: '❌', archived: '📦',
};

/** 状态 → 中文列名（详情抽屉里显示用；与 IDE 看板的列名同义）。 */
export const STATUS_LABELS = {
	triage: '待分解', todo: '待执行', ready: '就绪', running: '执行中', blocked: '阻塞', done: '执行结束',
	cancelled: '取消执行', archived: '归档',
};

/**
 * 看板列。`statuses` = 这一列收哪些状态（聚合）；`dropStatus` = **拖进这一列会把卡片设成哪个状态**
 * （`null` = 这一列**不接受落卡**，见文件头边界②）。
 *
 * ⚠ 与 IDE 那侧的差异只有一条：**这里有 triage 列**（理由见文件头）。其余五列的聚合与 `dropStatus` 逐条对齐
 * （IDE 那份 `TaskBoardPanel.tsx` 的 `COLUMNS`：todo→todo / running→**null** / done→done / cancelled→cancelled /
 * archived→archived）。
 * ⚠ `archived` 默认**折叠**（归档不该占横向空间）—— 但**不是删掉**：折叠态一键可展开，卡片仍在。
 * ⚠ 「执行中」列 `dropStatus: null` 的**代价**要说清：`blocked` 卡片没法"拖进别的列再由本列收" ——
 *   它可以被拖**出去**（拖到「待执行」= 解除阻塞 ✓，与 `kanban_unblock` 同语义）⇒ 出口仍然存在 ✓。
 */
export const BOARD_COLUMNS = [
	{ key: 'triage', statuses: ['triage'], label: '待分解', icon: '🗂', color: '#8b5cf6', dropStatus: 'triage' },
	{ key: 'todo', statuses: ['todo', 'ready'], label: '待执行', icon: '📋', color: '#f59e0b', dropStatus: 'todo' },
	{ key: 'running', statuses: ['running', 'blocked'], label: '执行中', icon: '⚡', color: '#3b82f6', dropStatus: null },
	{ key: 'done', statuses: ['done'], label: '执行结束', icon: '✅', color: '#10b981', dropStatus: 'done' },
	{ key: 'cancelled', statuses: ['cancelled'], label: '取消执行', icon: '⏹', color: '#6b7280', dropStatus: 'cancelled' },
	{ key: 'archived', statuses: ['archived'], label: '归档', icon: '📦', color: '#8b5cf6', startCollapsed: true, dropStatus: 'archived' },
];

/** 单列最多渲染多少张（防病态数据）：超出的部分**如实报数**，不静默丢。 */
export const COLUMN_LIMIT = 100;
/** 卡片上的描述预览长度（**只取首行、只切这么长** ⇒ 不会把 266KB 带出去）。 */
export const PREVIEW_LIMIT = 80;

const PRIORITIES = { high: { label: '高', color: '#ef4444', bg: 'rgba(239,68,68,.16)' }, medium: { label: '中', color: '#f59e0b', bg: 'rgba(245,158,11,.16)' }, low: { label: '低', color: '#9d9d9d', bg: 'rgba(157,157,157,.16)' } };

/** 描述里的**追加记录**前缀（与 IDE 侧写描述的格式一致：`[COMMENT …]` / `[BLOCKED] …` / `[HEARTBEAT …]`）。 */
const NOTE_PREFIX = /^\[(COMMENT|BLOCKED|HEARTBEAT)\b/;

export function statusIcon(status) {
	return STATUS_ICONS[String(status ?? '')] ?? '⬜';
}

export function statusLabel(status) {
	const key = String(status ?? '');
	return STATUS_LABELS[key] ?? key;
}

/**
 * 状态计数（**唯一真源**）：侧栏 KPI 与看板列头都从这里来。
 * ⚠ 只准有一份实现 —— 否则会出现"侧栏说 5、编辑区说 6"（「主页」那条 `summarizeModel` 的教训）。
 */
export function countsByStatus(tasks) {
	const out = { total: 0 };
	for (const task of Array.isArray(tasks) ? tasks : []) {
		if (!task || typeof task !== 'object') { continue; }
		const status = String(task.status ?? '');
		out[status] = (out[status] ?? 0) + 1;
		out.total += 1;
	}
	return out;
}

/** 关键字匹配面：id / 标题 / 状态 / 看板 / 优先级 / 负责人（与改造前的 `data-search` 同面，**不含描述**）。 */
export function searchTextOf(task) {
	return [task?.id, task?.title, task?.status, task?.boardId, task?.priority, task?.assigneeName]
		.filter(Boolean).join(' ').toLowerCase();
}

const stamp = task => String(task?.updatedAt ?? task?.createdAt ?? '');

/** 最近的在前（同 `selectTasks` 的并列口径）。返回**新数组**，不改输入。 */
export function sortByRecent(tasks) {
	return [...(Array.isArray(tasks) ? tasks : [])].sort((a, b) => stamp(b).localeCompare(stamp(a)));
}

/**
 * 一列的卡片：按状态过滤 → 最近在前 → 截到 `limit`。
 * 返回 `{ list, hidden }` —— `hidden > 0` 时页面**如实**写一句"还有 N 张未显示"（不静默丢 ✗）。
 */
export function columnTasks(tasks, column, limit = COLUMN_LIMIT) {
	const statuses = new Set(column?.statuses ?? []);
	const matched = sortByRecent((Array.isArray(tasks) ? tasks : []).filter(t => t && statuses.has(String(t.status ?? ''))));
	return { list: matched.slice(0, limit), hidden: Math.max(0, matched.length - limit) };
}

/** 卡片上的描述预览：**首行** 且 ≤ `PREVIEW_LIMIT`；与标题相同（或没有）就不显示。 */
export function previewOf(task, limit = PREVIEW_LIMIT) {
	const raw = typeof task?.description === 'string' ? task.description : '';
	if (!raw) { return ''; }
	const firstLine = raw.split('\n').map(line => line.trim()).find(Boolean) ?? '';
	if (!firstLine || firstLine === String(task?.title ?? '').trim()) { return ''; }
	return firstLine.length > limit ? `${firstLine.slice(0, limit)}…` : firstLine;
}

/**
 * 把描述拆成 `{ head, notes, truncated, length }`：`notes` = `[COMMENT] / [BLOCKED] / [HEARTBEAT]` 那些行，
 * `head` = 其余正文行（保持原顺序）。
 *
 * ⚠ 截断语义（细节重要）：超 `limit` 时**先切、再丢掉最后一行** —— 那一行很可能是被切开的**半行**，
 *   宁可少显示一行，也不要把半行当成一条完整记录展示 ✗。截断事实由 `truncated` 如实带出（页面要写出来）。
 */
export function splitNotes(description, limit = DETAIL_DESCRIPTION_LIMIT) {
	const full = typeof description === 'string' ? description : '';
	const truncated = full.length > limit;
	let text = truncated ? full.slice(0, limit) : full;
	if (truncated) {
		text = text.slice(0, Math.max(0, text.lastIndexOf('\n')));
	}
	const head = [];
	const notes = [];
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line) { continue; }
		if (NOTE_PREFIX.test(line)) { notes.push(line); } else { head.push(line); }
	}
	return { head: head.join('\n'), notes, truncated, length: full.length };
}

/** 按 key 取列（找不到 → `undefined`；⚠ 与"这一列不接受落卡（`dropStatus: null`）"是**两件事**）。 */
/**
 * dsh 任务状态 → 看板列（**只读镜像**用）。
 *
 * ⚠ 这是**展示映射**，不是"改状态"：镜像卡不写盘、不参与拖拽 ✓。dsh 只有三态
 *   （`pending` / `in_progress` / `completed`，见 `dsh-tool-todo` 的类型 ✓），分别落到
 *   「待执行 / 执行中 / 执行结束」三列 ✓；我们自己的 `triage` / `cancelled` / `archived`
 *   **不会**出现在镜像里 ✓（镜像数据来自 dsh 投影，不是我们的 taskboard ✓）。
 */
export const MIRROR_COLUMN_OF = { pending: 'todo', in_progress: 'running', completed: 'done' };

/**
 * 单张镜像卡（服务端渲染，**只读**）。
 *
 * **故意**不带 `data-task-id` / `data-kanban-grab` / `data-kanban-card`：
 *   · 拖拽与"开详情"在客户端都以 `data-task-id` 为前提（`BOARD_SCRIPT` 的 `startDrag` / `openDrawer` ✓）
 *     ⇒ 镜像卡天然不可拖、开不了详情 ⇒ 页面**没有**多出任何写路径 ✓；
 *   · 也不进 `data-kanban-card` 集合 ⇒ 不会被客户端的筛/选/键盘导航当成我们的任务 ✓
 *     （代价：文本搜索**不会**隐藏镜像卡 —— 列定义与计数都在服务端，显示上不会因此错 ✗）。
 */
export function renderMirrorCard(mirror) {
	const src = mirror.sessionTitle ? mirror.sessionTitle : String(mirror.sessionId ?? '').slice(0, 8);
	return '<article class="kb-card kb-card-mirror" data-kanban-mirror="1"'
		+ ` data-mirror-status="${escapeHtml(mirror.status)}" data-mirror-session="${escapeHtml(mirror.sessionId)}"`
		+ ` data-focus-title="${escapeHtml(mirror.content)}">`
		+ `<div class="kb-mirror-title">${escapeHtml(mirror.content)}</div>`
		+ '<div class="kb-mirror-meta"><span class="kb-src-mirror">dsh 会话投影 · 只读</span>'
		+ `<span class="kb-agent">${escapeHtml(src)}</span></div>`
		+ '</article>';
}

/** 镜像卡的样式（**不塞进** `BOARD_CSS`：那条字符串很长，改动它风险高于收益 ✓）。 */
const MIRROR_CSS = `
.kb-card-mirror { border-left: 3px dashed #3794ff; background: rgba(55,148,255,.06); cursor: default; }
.kb-card-mirror:hover { background: rgba(55,148,255,.10); }
.kb-mirror-title { font-size: 12px; line-height: 1.45; }
.kb-mirror-meta { margin-top: 5px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.kb-src-mirror { background: rgba(55,148,255,.16); color: #6cb6ff; border: 1px solid rgba(55,148,255,.35); border-radius: 8px; padding: 0 6px; font-size: 10px; }
`;

export function columnByKey(key) {
	return BOARD_COLUMNS.find(column => column.key === String(key ?? ''));
}

/**
 * 把"拖到某一列"翻成"改成哪个状态" —— **动作白名单的唯一实现**（文件头边界①）。
 *
 * 返回 `{ ok: true, status }` 或 `{ ok: false, reason }`；三种拒绝各有各的原因（不可合并成一句话 ✗）：
 *   · 列不存在（拼错的 key / 有人手工构造请求）；
 *   · 这一列不接受落卡（`dropStatus: null`，目前是「执行中」）；
 *   · 列存在但落列状态不在 `STATUSES` 里（**改列定义改错** ⇒ 只有这里能挡住 ✗）。
 * ⚠ 最后一个分支看着多余，其实是"**只认列声明的状态**"这条不变量的守卫：没有它，改列时写错一个字符串
 *   就会变成"页面能写入任意状态" ✓（同 `createRecord` 里 `STATUSES.includes(...)` 那手）。
 */
export function resolveDrop(key, statuses = STATUSES) {
	const column = columnByKey(key);
	if (!column) {
		return { ok: false, reason: `没有这一列：${String(key ?? '')}（可用：${BOARD_COLUMNS.map(c => c.key).join(' / ')}）` };
	}
	if (column.dropStatus === null) {
		return { ok: false, reason: `「${column.label}」列不接受落卡（拖进"执行中"该设成 running 还是 blocked 语义不清）—— 要动它请用卡片详情里的线索或 kanban_* 工具` };
	}
	if (!statuses.includes(column.dropStatus)) {
		return { ok: false, reason: `「${column.label}」列声明的落列状态不在状态表里：${String(column.dropStatus)}（这是列定义的错，不该发生）` };
	}
	return { ok: true, status: column.dropStatus };
}

/**
 * 某个状态**归属哪一列**（写口回给客户端"卡片现在实际在哪一列"用；找不到返回空串）。
 * ⚠ 与 `resolveDrop` 是**反方向**的两件事，别混：那个是"列 → 落列状态"（白名单），这个是"状态 → 列"（回执）。
 * 需要它是因为：`ready` 这类状态归属的列（「待执行」）与它的落列状态（`todo`）**不是同一个字符串** ⇒
 * 客户端**没法**自己从状态推出列 ⇒ 由服务端在回执里给出 ✓（客户端不复制一份列定义 ✗）。
 */
export function columnKeyForStatus(status) {
	const key = String(status ?? '');
	const column = BOARD_COLUMNS.find(c => c.statuses.includes(key));
	return column ? column.key : '';
}

/**
 * 这张卡能不能拖（文件头边界②）：`running` 拖不动 —— 与 IDE 侧 `TaskCard.isDraggable`（`status !== 'running'`）同口径。
 * ⚠ `blocked` **可以**拖（拖到「待执行」= 解除阻塞）⇒ 它不会被困死在「执行中」列里 ✓。
 */
export function draggableOf(task) {
	return String(task?.status ?? '') !== 'running';
}

/**
 * 一次移动的**判定**（纯函数，写口与探针共用；真正落盘由 `mutateTaskboard` 做 ✓）。
 *   · 卡片不存在 ⇒ `{ ok: false, reason }`（写口回 404）；
 *   · 卡片是 `running` ⇒ `{ ok: false, reason }`（写口回 409，**不写盘**）；
 *   · 目标状态与当前相同 ⇒ `{ ok: true, changed: false, status }`（写口**不写盘**、如实回报"未改动"）；
 *   · 其余 ⇒ `{ ok: true, changed: true, status }`。
 */
export function moveOutcome(task, status) {
	if (!task || typeof task !== 'object') {
		return { ok: false, reason: '卡片不存在' };
	}
	if (!draggableOf(task)) {
		return { ok: false, reason: `卡片 #${String(task.id ?? '').slice(-6)} 正在执行（running）—— 执行中的卡不让拖，避免把在跑的活抢走` };
	}
	const current = String(task.status ?? '');
	if (current === status) {
		return { ok: true, changed: false, status };
	}
	return { ok: true, changed: true, status };
}

/**
 * 页面自诊断（**两个承载表面共用** ⇒ 锚点只有一份实现，不会漂）。
 *
 * 机器可断言的锚点（探针 / e2e 用，不依赖模型调用）：
 * - `data-vssaros-tools` / `data-registered`：哪些工具真的注册进了 `ctx.tools`（把"页面能打开"与
 *   "工具已注册"分开可证 ✓）；
 * - `data-vssaros-workspace`：工作区 id（空 ⇒ 写工具会 fail-closed，是这块最可能的故障之一 ✓）；
 * - 数据文件绝对路径：数据根配错（`.vssaros` vs `.vssaros-dev`）会在这里现形 ✓。
 * - ★ `data-kanban-runner` / `data-kanban-runner-why`（2026-10-17）：**自动执行 runner 到底起没起来**。
 *   为什么要它：从前这条只能读代码判定 —— 那个 warn 走 `ctx.logger(...)`，**不在** Host stdout 里（探针抓不到），
 *   而"产品口径下 runner 起不来"是个会影响用户体验的实情（拖到「进行中」不会开跑 ✓）⇒ 给个**能抓的锚点** ✓。
 *   取值：`on` / `off`；`why` 就是原因码（`deps-missing` / `no-cwd` / `ok` / `init` / `disposed`）。
 */
export function diagHtml({ registeredTools = [], expectedTools = [], workspaceId = '', dataFile = '', runner = false, runnerWhy = 'init' }) {
	const allRegistered = expectedTools.length > 0 && expectedTools.every(name => registeredTools.includes(name));
	const attrs = `data-vssaros-tools="${escapeHtml(registeredTools.join(','))}" data-registered="${allRegistered ? 'true' : 'false'}" data-vssaros-workspace="${escapeHtml(workspaceId)}" data-kanban-runner="${runner ? 'on' : 'off'}" data-kanban-runner-why="${escapeHtml(runnerWhy)}"`;
	const runnerText = runner ? '已启动' : `未启动（${escapeHtml(runnerWhy)}）`;
	return `<p class="dsh-diag" ${attrs}>工具：${registeredTools.length ? escapeHtml(registeredTools.join(', ')) : '（未注册）'}（${registeredTools.length}/${expectedTools.length}） · 工作区：<code>${workspaceId ? escapeHtml(workspaceId) : '未注入（写工具会拒绝建卡）'}</code> · 自动执行：<code>${runnerText}</code> · 数据文件：<code>${escapeHtml(dataFile)}</code></p>`;
}

/** 卡片视图模型（**纯函数**，可被探针直接验；不含描述原文）。 */
export function cardModel(task, statusById) {
	const deps = Array.isArray(task?.dependencies) ? task.dependencies.map(id => String(id)) : [];
	return {
		id: String(task?.id ?? ''),
		shortId: `#${String(task?.id ?? '').slice(-6)}`,
		title: String(task?.title ?? ''),
		status: String(task?.status ?? ''),
		priority: String(task?.priority ?? ''),
		priorityLabel: PRIORITIES[String(task?.priority ?? '')]?.label ?? '',
		assigneeName: String(task?.assigneeName ?? ''),
		boardId: String(task?.boardId ?? ''),
		source: String(task?.source ?? ''),
		when: stamp(task) ? new Date(stamp(task)) : undefined,
		preview: previewOf(task),
		deps: deps.map(id => ({ id, shortId: `#${id.slice(-6)}`, status: statusById?.get(id) ?? '' })),
	};
}

/**
 * 渲染看板页（编辑区完整版）。服务端渲染 —— 客户端脚本只做"筛 / 折 / 开详情"，不复制一套渲染 ✓。
 *
 * 输入是**原始任务记录**（不是 `project()` 投影）：卡片要用 `dependencies` 与描述首行；而**描述原文
 * 不会进 HTML**（只有 ≤80 字的首行预览 ✓）。
 */
export function renderBoardPage({ tasks, missing, registeredTools, expectedTools, dataFile, workspaceId, boards = [], note = '', mirrors = [], mirrorsNote = '', runner = false, runnerWhy = 'init' }) {
	const all = (Array.isArray(tasks) ? tasks : []).filter(t => t && typeof t === 'object');
	const counts = countsByStatus(all);
	const statusById = new Map(all.map(t => [String(t.id ?? ''), String(t.status ?? '')]));
	const total = counts.total;

	const diag = diagHtml({ registeredTools, expectedTools, workspaceId, dataFile, runner, runnerWhy });

	// 列：任一列有卡片、或该列"本来就该在"（triage / archived 由开关控制）都渲染出来
	const columnsHtml = BOARD_COLUMNS.map(column => {
		const { list, hidden } = columnTasks(all, column);
		const cards = list.map(task => renderCard(cardModel(task, statusById))).join('');
		const more = hidden > 0
			? `<p class="kb-col-more" data-kanban-col-more>还有 ${hidden} 张未显示（超出单列上限 ${COLUMN_LIMIT}）</p>`
			: '';
		// ★ dsh 任务镜像（只读，2026-10-14 P1）：按**状态**落列（映射见 `MIRROR_COLUMN_OF`）。
		//   ⚠ 镜像卡**不带** `data-task-id` / `data-kanban-grab` ⇒ 客户端（`BOARD_SCRIPT`）天然
		//   拖不动、也开不了详情 —— 那两处都先取 `data-task-id`、取不到就 return ✓（`board.js:644,786`）。
		const mirrorCards = mirrors
			.filter(m => MIRROR_COLUMN_OF[m.status] === column.key)
			.map(renderMirrorCard).join('');
		// ⚠ `data-kanban-drop` = 落列状态（`locked` = 这一列不接受落卡）。它只是**给客户端做 UX**（高亮可落列、
		//   拒绝拖进 locked 列）；**权威判定在服务端**（`resolveDrop` 那一手 ✓）—— 客户端属性永远不是安全判据 ✗。
		const drop = column.dropStatus === null ? 'locked' : escapeHtml(column.dropStatus);
		return `<section class="kb-col${column.startCollapsed ? ' kb-col-folded' : ''}" data-kanban-col="${escapeHtml(column.key)}" data-kanban-drop="${drop}">`
			+ '<header class="kb-col-hd">'
			+ `<span class="kb-col-icon" aria-hidden="true">${column.icon}</span>`
			+ `<span class="kb-col-label">${escapeHtml(column.label)}</span>`
			+ `<span class="kb-col-count" data-kanban-col-count style="background:${column.color}33;color:${column.color}">${list.length}</span>`
			+ '<span class="kb-col-spacer"></span>'
			+ `<button type="button" class="kb-col-toggle" data-kanban-collapse title="折叠 / 展开这一列" aria-label="折叠或展开「${escapeHtml(column.label)}」">‹</button>`
			+ '</header>'
			+ `<div class="kb-col-body">${cards || (mirrorCards ? '' : '<p class="kb-col-empty">这一列没有卡片</p>')}${mirrorCards}</div>`
			+ more
			+ '</section>';
	}).join('');

	// 看板筛选的候选项：`default` 永远存在（即使它不在 boards.json 里 ✓，与工具描述同一口径）
	const boardIds = [];
	for (const board of boards) {
		if (board?.id && !boardIds.includes(board.id)) { boardIds.push(board.id); }
	}
	if (!boardIds.includes('default')) { boardIds.push('default'); }
	const boardOptions = ['<option value="">全部看板</option>']
		.concat(boardIds.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)).join('');

	const toolbar = '<div class="dsh-toolbar kb-bar">'
		+ '<input type="search" name="q" class="kb-input" data-kanban-search placeholder="搜索标题 / id / 负责人…" aria-label="搜索任务">'
		+ `<select class="kb-select" name="board" data-kanban-board aria-label="按看板筛选">${boardOptions}</select>`
		+ '<select class="kb-select" name="assignee" data-kanban-assignee aria-label="按负责人筛选"><option value="">全部负责人</option></select>'
		+ '<span class="kb-bar-spacer"></span>'
		+ `<span class="dsh-diag kb-bar-count" data-kanban-count>显示 ${total} / ${total} 张</span>`
		// 拖拽回话行（成功/失败/被服务端拒绝都写这里；失败**不许静默** —— 卡片的回滚也要靠它给人解释 ✓）
		+ '<span class="kb-status" data-kanban-status role="status" aria-live="polite"></span>'
		+ '<span class="kb-chip-static" title="卡片详情只读；只有拖动换列会写入 taskboard.json">拖拽可换列</span>'
		+ '</div>';

	const header = `<div class="dsh-header"><h1>Tasks <small>${total} 条（只读）</small></h1>${diag}`;

	// 缺文件 / 读不了：如实说（首启形态：还没有 taskboard.json 是正常的 ✓）
	const notice = (missing
		? `<p class="dsh-empty kb-notice">看板数据文件还不存在：<code>${escapeHtml(missing)}</code><br>首次启动或尚未使用看板时属正常。</p>`
		: (note ? `<p class="dsh-diag kb-notice">${escapeHtml(note)}</p>` : ''))
		// dsh 任务镜像"读不到"的原因也要**如实显示** —— "两份真相"里最容易骗人的就是这一处，
		// 静默当作"没有任务"会让人以为镜像功能坏了 ✓（口径同 `readBoards` 的 error ✓）。
		+ (mirrorsNote ? `<p class="dsh-diag kb-notice" data-kanban-mirror-note>dsh 任务镜像：${escapeHtml(mirrorsNote)}</p>` : '');

	return renderShell({
		kind: 'kanban',
		title: 'Tasks',
		subtitle: `${total} 条（只读）`,
		headerHtml: `${header}</div>`,
		toolbarHtml: toolbar,
		bodyHtml: `<div class="kb-board">${columnsHtml}</div>${drawerHtml()}${notice}<p class="dsh-empty" data-kanban-empty hidden>🔍 没有匹配的卡片</p>`,
		attrs: 'data-vssaros-kanban-surface="board"',
		extraCss: BOARD_CSS + MIRROR_CSS,
		script: BOARD_SCRIPT,
	});
}

/** 一张卡片（服务端渲染）：锚点与 IDE 侧 `TaskCard` 同款（`data-task-id` 给 e2e，`data-focus-title` 给"在 IDE 看板定位"）。 */
function renderCard(card) {
	const pri = PRIORITIES[card.priority];
	const priHtml = pri ? `<span class="kb-pri" style="color:${pri.color};background:${pri.bg}">${pri.label}</span>` : '';
	const sourceHtml = card.source === 'delegation' ? '<span class="kb-src">委派</span>' : '';
	const depsHtml = card.deps.length
		? card.deps.map(dep => `<span class="kb-dep${dep.status === 'done' ? ' is-done' : dep.status === 'blocked' ? ' is-blocked' : ''}" title="依赖 ${escapeHtml(dep.id)}（状态：${escapeHtml(statusLabel(dep.status) || '未知')}）">${dep.status === 'done' ? '✓' : dep.status === 'blocked' ? '🚧' : '○'} ${escapeHtml(dep.shortId)}</span>`).join('')
		: '<span class="kb-dep">依赖：无</span>';
	const when = card.when && !Number.isNaN(card.when.getTime()) ? card.when.toLocaleDateString('zh-CN') : '';
	const assignee = card.assigneeName
		? `<span class="kb-agent">🤖 ${escapeHtml(card.assigneeName)}</span>`
		: '<span class="kb-agent kb-agent-none">未指派</span>';
	return `<article class="kb-card status-${escapeHtml(card.status)}"`
		+ ` data-kanban-card="1" data-task-id="${escapeHtml(card.id)}" data-board="${escapeHtml(card.boardId)}"`
		+ ` data-assignee="${escapeHtml(card.assigneeName)}" data-search="${escapeHtml(searchTextOf({ id: card.id, title: card.title, status: card.status, boardId: card.boardId, priority: card.priority, assigneeName: card.assigneeName }))}"`
		+ ` data-focus-title="${escapeHtml(card.title)}" role="button" tabindex="0"`
		// ⚠ 可拖 / 锁定是**两个互斥的锚点**：`running` 的卡只有 `data-kanban-locked`（拖不动 ⇒ 也就不会被
		//   拖进别的列）；其余卡片带 `data-kanban-grab`（可拖）。客户端只认这两个属性，不自己判状态 ✓。
		+ (draggableOf({ status: card.status }) ? ' data-kanban-grab="1"' : ' data-kanban-locked="1"')
		+ ` title="完整 ID：${escapeHtml(card.id)}（点击看详情${draggableOf({ status: card.status }) ? '，拖动可换列' : '；执行中不可拖'}）">`
		+ '<div class="kb-card-r1">'
		+ `<span class="kb-id">${escapeHtml(card.shortId)}</span>`
		+ priHtml + sourceHtml
		+ '</div>'
		+ `<div class="kb-title">${escapeHtml(card.title)}</div>`
		+ (card.preview ? `<div class="kb-preview">${escapeHtml(card.preview)}</div>` : '')
		+ `<div class="kb-card-r3">${assignee}${when ? `<span class="kb-when">${escapeHtml(when)}</span>` : ''}${depsHtml}</div>`
		+ '</article>';
}

/** 详情抽屉：**静态骨架**（服务端渲染），内容由客户端按需取 `/x/kanban/api/task` 填 ✓。 */
function drawerHtml() {
	return '<aside class="kb-drawer" data-kanban-drawer hidden aria-label="卡片详情">'
		+ '<header class="kb-drawer-hd"><span class="kb-drawer-title" data-kanban-drawer-title>卡片详情</span>'
		+ '<button type="button" class="kb-drawer-close" data-kanban-drawer-close title="关闭">✕</button></header>'
		+ '<div class="kb-drawer-bd">'
		+ '<p class="dsh-diag" data-kanban-drawer-note>点左边任意一张卡片看它的详情。</p>'
		+ '<div data-kanban-drawer-fields></div>'
		+ '<button type="button" class="dsh-btn kb-locate" data-kanban-locate hidden>在 IDE 的看板里定位</button>'
		+ '<p class="dsh-diag" data-kanban-locate-note hidden></p>'
		+ '</div></aside>';
}

/**
 * 看板页样式。只写本页真正用到的选择器（**不引入死样式**：本仓有一条"选择器已无元素匹配"的守卫做法）。
 * 只用 `--vscode-*` 主题变量（+ 与原 Pane 相同的硬编码状态色），不引入新色板。
 */
export const BOARD_CSS = `
	/* ⚠ 本段在模板字符串里：注释里不能出现反引号（会提前闭合整页）。 */
	.kb-bar { flex-wrap: wrap; }
	.kb-input {
		font: inherit; font-size: 11px; padding: 3px 6px; min-width: 180px;
		border-radius: 3px; border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
		background: var(--vscode-input-background, transparent); color: var(--vscode-input-foreground, #ccc); outline: none;
	}
	.kb-input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
	.kb-select {
		font: inherit; font-size: 11px; padding: 3px 4px; border-radius: 3px;
		border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
		background: var(--vscode-input-background, transparent); color: var(--vscode-input-foreground, #ccc);
	}
	.kb-bar-spacer { flex: 1; }
	.kb-bar-count { padding: 0; margin: 0; }
	.kb-chip-static {
		font-size: 10px; padding: 1px 6px; border-radius: 999px; opacity: .75;
		background: var(--vscode-badge-background, rgba(128,128,128,.25)); color: var(--vscode-badge-foreground, #fff);
	}
	/* 看板本体：横向滚动、每列自己纵向滚动 */
	.kb-board { flex: 1; min-height: 0; display: flex; gap: 10px; padding: 8px; overflow-x: auto; overflow-y: hidden; }
	.kb-col {
		flex: 0 0 248px; min-width: 248px; display: flex; flex-direction: column;
		background: var(--vscode-editor-background, #1e1e1e);
		border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 6px; overflow: hidden;
	}
	.kb-col-hd {
		display: flex; align-items: center; gap: 6px; padding: 6px 8px;
		border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
		background: var(--vscode-sideBar-background, #1e1e1e);
	}
	.kb-col-icon { font-size: 12px; }
	.kb-col-label { font-size: 11px; font-weight: 600; }
	.kb-col-count { font-size: 10px; border-radius: 999px; padding: 0 6px; }
	.kb-col-spacer { flex: 1; }
	.kb-col-toggle {
		background: none; border: 0; cursor: pointer; font: inherit; font-size: 11px; padding: 0 2px;
		color: var(--vscode-descriptionForeground, #999);
	}
	.kb-col-toggle:hover { color: var(--vscode-foreground, #ccc); }
	.kb-col-body { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; }
	.kb-col-empty, .kb-col-more { font-size: 10px; color: var(--vscode-descriptionForeground, #999); text-align: center; margin: 8px 0; }
	.kb-col-folded { flex: 0 0 44px; min-width: 44px; }
	.kb-col-folded .kb-col-body, .kb-col-folded .kb-col-label, .kb-col-folded .kb-col-count, .kb-col-folded .kb-col-more { display: none; }
	.kb-col-folded .kb-col-toggle { transform: rotate(180deg); }
	/* 拖拽：可落列高亮 / 锁列明确拒绝 / 源卡半透明 / 浮层跟手（位置只由 transform 给 ⇒ 不触发布局） */
	.kb-col.kb-col-drop { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
	.kb-col.kb-col-drop .kb-col-body { background: var(--vscode-list-dropBackground, rgba(0,127,212,.10)); }
	.kb-col.kb-col-locked { outline: 1px dashed var(--vscode-errorForeground, #f48771); outline-offset: -1px; }
	.kb-card.is-dragging { opacity: .35; }
	.kb-ghost {
		position: fixed; left: 0; top: 0; z-index: 40; pointer-events: none;
		width: 200px; opacity: .92; transform: translate3d(0,0,0) scale(1.02); will-change: transform;
	}
	.kb-status { font-size: 11px; color: var(--vscode-descriptionForeground, #999); }
	.kb-status.is-error { color: var(--vscode-errorForeground, #f48771); }
	/* 卡片 */
	.kb-card {
		border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
		border-left: 3px solid var(--vscode-panel-border, rgba(128,128,128,.5));
		border-radius: 5px; padding: 6px 8px; margin-bottom: 6px; cursor: pointer;
		background: var(--vscode-sideBar-background, #1e1e1e);
	}
	.kb-card:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
	.kb-card:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); }
	.kb-card.is-selected { outline: 1px solid var(--vscode-focusBorder, #007fd4); }
	.kb-card.status-triage { border-left-color: #8b5cf6; }
	.kb-card.status-todo { border-left-color: #f59e0b; }
	.kb-card.status-ready { border-left-color: #0ea5e9; }
	.kb-card.status-running { border-left-color: #3b82f6; }
	.kb-card.status-blocked { border-left-color: #ef4444; }
	.kb-card.status-done { border-left-color: #10b981; }
	.kb-card.status-cancelled { border-left-color: #6b7280; }
	.kb-card.status-archived { border-left-color: #8b5cf6; }
	/* ⚠ 卡片是 flex 子项之外仍要能靠 hidden 属性隐藏：作者样式会盖掉 [hidden] 的 UA 规则 ⇒ 必须显式写 */
	.kb-board [hidden] { display: none !important; }
	.kb-card-r1 { display: flex; align-items: center; gap: 5px; }
	.kb-id { font-family: ui-monospace, Consolas, monospace; font-size: 10px; color: var(--vscode-descriptionForeground, #999); }
	.kb-pri { font-size: 9px; padding: 0 5px; border-radius: 3px; }
	.kb-src { font-size: 9px; padding: 0 5px; border-radius: 3px; background: var(--vscode-badge-background, rgba(128,128,128,.25)); }
	.kb-title { font-size: 11px; line-height: 1.4; margin-top: 3px; }
	.kb-preview { font-size: 10px; color: var(--vscode-descriptionForeground, #999); margin-top: 3px; }
	.kb-card-r3 { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 5px; font-size: 9px; color: var(--vscode-descriptionForeground, #999); }
	.kb-agent-none { opacity: .7; }
	.kb-dep { font-size: 9px; padding: 0 5px; border-radius: 3px; background: var(--vscode-badge-background, rgba(128,128,128,.2)); }
	.kb-dep.is-done { color: #4ec9b0; }
	.kb-dep.is-blocked { color: #f48771; }
	/* 详情抽屉（浮在看板之上；父级是定位过的 .kb-board? 否 —— 挂在 body 下，用 fixed 定位最稳） */
	.kb-drawer {
		position: fixed; top: 0; right: 0; bottom: 0; width: 380px; z-index: 20;
		display: flex; flex-direction: column;
		background: var(--vscode-editor-background, #1e1e1e);
		border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,.45));
		box-shadow: -8px 0 24px rgba(0,0,0,.35);
	}
	.kb-drawer[hidden] { display: none; }
	.kb-drawer-hd { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
	.kb-drawer-title { flex: 1; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
	.kb-drawer-close { background: none; border: 0; cursor: pointer; font: inherit; color: var(--vscode-descriptionForeground, #999); }
	.kb-drawer-close:hover { color: var(--vscode-foreground, #ccc); }
	.kb-drawer-bd { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; }
	.kb-fld { margin-bottom: 9px; }
	.kb-fld-l { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground, #999); }
	.kb-fld-v { font-size: 11px; word-break: break-word; white-space: pre-wrap; }
	.kb-fld-v.is-mono { font-family: ui-monospace, Consolas, monospace; }
	.kb-log { font-family: ui-monospace, Consolas, monospace; font-size: 10px; padding: 2px 0; border-bottom: 1px dotted var(--vscode-panel-border, rgba(128,128,128,.3)); word-break: break-all; }
	.kb-locate { margin-top: 6px; }
	.kb-notice { text-align: left; padding: 8px 10px; }
`;

/**
 * 页内交互（**整段内联进页面**；独立导出是为了能被 `node --check` 单验 —— 本仓有过"客户端脚本语法错
 * 静默上线、真机只表现为点了没反应"的教训）。
 *
 * 做什么：① 搜索 / 看板 / 负责人三档筛选（就地隐藏卡片 + 列头计数跟着走）；② 折叠列；
 * ③ 点卡片开**详情抽屉**（按需 `GET /x/kanban/api/task` ✓ —— 描述不进列表页）；④ 抽屉里「在 IDE 的看板里定位」
 * 走既有的 `/x/kanban/api/focus`（失败把原因原样显示，不静默）。
 */
export const BOARD_SCRIPT = `
(function () {
	var cards = Array.prototype.slice.call(document.querySelectorAll('[data-kanban-card]'));
	var cols = Array.prototype.slice.call(document.querySelectorAll('[data-kanban-col]'));
	var search = document.querySelector('[data-kanban-search]');
	var boardSel = document.querySelector('[data-kanban-board]');
	var agentSel = document.querySelector('[data-kanban-assignee]');
	var count = document.querySelector('[data-kanban-count]');
	var empty = document.querySelector('[data-kanban-empty]');
	var statusEl = document.querySelector('[data-kanban-status]');
	var drawer = document.querySelector('[data-kanban-drawer]');
	var drawerTitle = document.querySelector('[data-kanban-drawer-title]');
	var drawerNote = document.querySelector('[data-kanban-drawer-note]');
	var drawerFields = document.querySelector('[data-kanban-drawer-fields]');
	var locateBtn = document.querySelector('[data-kanban-locate]');
	var locateNote = document.querySelector('[data-kanban-locate-note]');
	var cache = {};
	var selected = null;

	// 页面自诊断：脚本真的跑起来了（探针 / e2e 用；与客户端插件那套同款）
	document.body.dataset.kanbanClient = 'on';

	function applyFilter() {
		var q = search ? String(search.value || '').trim().toLowerCase() : '';
		var board = boardSel ? String(boardSel.value || '') : '';
		var agent = agentSel ? String(agentSel.value || '') : '';
		var shown = 0;
		cards.forEach(function (card) {
			var hit = (!q || String(card.getAttribute('data-search') || '').indexOf(q) >= 0)
				&& (!board || String(card.getAttribute('data-board') || '') === board)
				&& (!agent || String(card.getAttribute('data-assignee') || '') === agent);
			card.hidden = !hit;
			if (hit) { shown += 1; }
		});
		// 列头计数跟着筛选走（⚠ 服务端渲染的"这一列没有卡片"是**数据事实**，筛选不改变它 ⇒ 这里不动它）
		cols.forEach(function (col) {
			var n = col.querySelectorAll('[data-kanban-card]:not([hidden])').length;
			var badge = col.querySelector('[data-kanban-col-count]');
			if (badge) { badge.textContent = String(n); }
		});
		if (count) { count.textContent = '显示 ' + shown + ' / ' + cards.length + ' 张'; }
		if (empty) { empty.hidden = shown !== 0; }
	}

	/** 回话行：成功/失败都写这里（失败**不许静默** —— 拖拽的失败必须给人一个原因 ✓）。 */
	function status(message, isError) {
		if (!statusEl) { return; }
		statusEl.textContent = message || '';
		statusEl.classList.toggle('is-error', !!isError);
	}

	function field(label, value, isMono) {
		var box = document.createElement('div');
		box.className = 'kb-fld';
		var l = document.createElement('div');
		l.className = 'kb-fld-l';
		l.textContent = label;
		var v = document.createElement('div');
		v.className = isMono ? 'kb-fld-v is-mono' : 'kb-fld-v';
		v.textContent = value;
		box.appendChild(l);
		box.appendChild(v);
		return box;
	}

	function paint(body) {
		var task = body.task || {};
		var desc = body.desc || {};
		if (drawerTitle) { drawerTitle.textContent = task.title || '(无标题)'; }
		if (drawerNote) { drawerNote.textContent = '只读详情（与 IDE 看板同一份数据）。'; }
		if (!drawerFields) { return; }
		drawerFields.textContent = '';
		drawerFields.appendChild(field('状态', task.statusLabel || task.status || '未知'));
		drawerFields.appendChild(field('负责人 / 优先级 / 来源', [task.assigneeName || '未指派', task.priority || '未设', task.source || '未知'].join(' · ')));
		drawerFields.appendChild(field('看板', task.boardId || 'default'));
		var deps = (task.dependencies || []);
		if (deps.length) {
			var wrap = document.createElement('div');
			wrap.className = 'kb-fld';
			var dl = document.createElement('div');
			dl.className = 'kb-fld-l';
			dl.textContent = '依赖';
			wrap.appendChild(dl);
			deps.forEach(function (id) {
				var v = document.createElement('div');
				v.className = 'kb-fld-v is-mono';
				v.textContent = '#' + String(id).slice(-6) + ' · ' + (body.depStatus && body.depStatus[id] ? body.depStatus[id] : '不在本次列表里');
				wrap.appendChild(v);
			});
			drawerFields.appendChild(wrap);
		} else {
			drawerFields.appendChild(field('依赖', '无'));
		}
		if (task.createdAt || task.updatedAt || task.completedAt) {
			drawerFields.appendChild(field('创建 / 更新 / 完成',
				[task.createdAt || '—', task.updatedAt || '—', task.completedAt || '—'].join('  ·  ')));
		}
		if (task.url) { drawerFields.appendChild(field('链接', task.url)); }
		drawerFields.appendChild(field('任务 id', task.id || '', true));
		if (desc.head) { drawerFields.appendChild(field('描述', desc.head)); }
		if (desc.notes && desc.notes.length) {
			var logBox = document.createElement('div');
			logBox.className = 'kb-fld';
			var ll = document.createElement('div');
			ll.className = 'kb-fld-l';
			ll.textContent = '追加记录（COMMENT / BLOCKED / HEARTBEAT）';
			logBox.appendChild(ll);
			desc.notes.forEach(function (line) {
				var ln = document.createElement('div');
				ln.className = 'kb-log';
				ln.textContent = line;
				logBox.appendChild(ln);
			});
			drawerFields.appendChild(logBox);
		}
		if (desc.truncated) {
			drawerFields.appendChild(field('提示',
				'描述过长已截断显示（原文 ' + String(desc.length || 0) + ' 字，这里最多 ' + String(desc.limit || 0) + ' 字）；完整原文请用 kanban_show 或直接看数据文件。'));
		}
		if (locateBtn) {
			// 「在 IDE 的看板里定位」只在**真的拿到标题**时可用（定位是按标题匹配的）
			if (task.title) { locateBtn.hidden = false; locateBtn.dataset.title = task.title; }
			else { locateBtn.hidden = true; }
		}
	}

	function fail(reason) {
		if (drawerNote) { drawerNote.textContent = reason; }
		if (drawerFields) { drawerFields.textContent = ''; }
	}

	function openDrawer(card) {
		var id = card.getAttribute('data-task-id') || '';
		if (!id) { return; }
		if (selected) { selected.classList.remove('is-selected'); }
		selected = card;
		card.classList.add('is-selected');
		if (drawer) { drawer.hidden = false; }
		if (drawerTitle) { drawerTitle.textContent = card.getAttribute('data-focus-title') || '卡片详情'; }
		if (locateNote) { locateNote.hidden = true; }
		if (cache[id]) { paint(cache[id]); return; }
		if (drawerNote) { drawerNote.textContent = '正在读取详情…'; }
		if (drawerFields) { drawerFields.textContent = ''; }
		fetch('/x/kanban/api/task?id=' + encodeURIComponent(id), { headers: { accept: 'application/json' } })
			.then(function (res) { return res.json().then(function (body) { return { ok: res.ok && body && body.ok, body: body }; }); })
			.then(function (out) {
				if (!out.ok) { fail('读不到详情：' + String((out.body && out.body.error) || '未知原因')); return; }
				cache[id] = out.body;
				paint(out.body);
			})
			.catch(function (err) { fail('读不到详情：' + String(err && err.message ? err.message : err)); });
	}

	function closeDrawer() {
		if (drawer) { drawer.hidden = true; }
		if (selected) { selected.classList.remove('is-selected'); selected = null; }
	}

	// 「在 IDE 的看板里定位」：走既有的反向通道（插件向 IDE 请求 taskboard 能力）；失败**原样显示原因**
	if (locateBtn) {
		locateBtn.addEventListener('click', function () {
			var title = locateBtn.dataset.title || '';
			if (!title) { return; }
			if (locateNote) { locateNote.hidden = false; locateNote.textContent = '正在 IDE 的看板里定位…'; }
			fetch('/x/kanban/api/focus?title=' + encodeURIComponent(title), { headers: { accept: 'application/json' } })
				.then(function (res) { return res.json().then(function (body) { return { ok: res.ok && body && body.ok, body: body }; }); })
				.then(function (out) {
					if (!locateNote) { return; }
					locateNote.textContent = out.ok ? ('已在 IDE 的看板里定位：' + title)
						: ('定位失败：' + String((out.body && out.body.error) || '未知原因'));
				})
				.catch(function (err) {
					if (locateNote) { locateNote.textContent = '定位失败：' + String(err && err.message ? err.message : err); }
				});
		});
	}

	cards.forEach(function (card) {
		card.addEventListener('click', function () { openDrawer(card); });
		card.addEventListener('keydown', function (event) {
			if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDrawer(card); }
		});
	});

	// ── 拖拽换列（本页**唯一**的写动作；四条边界见 lib/board.js 文件头的"D4 写路径"）──────────────
	// 手法照抄本仓已验证的那套（dashboard 的 pageClient.js），逐条都是踩出来的：
	//   · **Pointer Events**（HTML5 DnD 在 Electron 的 WebContentsView 里不可靠 ⇒ 本仓已否掉 ✗）；
	//   · **6px 死区**（区分"点击看详情"与"想拖动"）＋ 拖过之后**吞掉那一次 click** ✓（否则松手会开抽屉 ✗）；
	//   · 浮层 position:fixed ＋ **只写 transform: translate3d(...)**（合成层、不触发布局）＋
	//     pointer-events:none（否则浮层自己吃掉指针事件、拖到一半就断 ✗）；
	//   · 监听器一律挂 document（setPointerCapture 只是**优化**：合成事件/部分宿主会抛 ⇒ 必须容错 ✗）；
	//   · 落点**两轴**判定（本仓教训：只判一轴 ⇒ "左右拖不动"✓）。
	// ⚠ 上面这段注释里**不许出现反引号**：本段在模板字符串里，一个反引号就会提前闭合整页 ✗
	//   （我在这一轮又踩了一次，node --check 当场抓住 —— 探针 p3-88 的元检查也盯着它 ✓）。
	function colByKey(key) {
		for (var i = 0; i < cols.length; i += 1) {
			if (cols[i].getAttribute('data-kanban-col') === key) { return cols[i]; }
		}
		return null;
	}
	function bodyOf(col) { return col ? col.querySelector('.kb-col-body') : null; }
	function labelOf(col) {
		var label = col ? col.querySelector('.kb-col-label') : null;
		return label ? String(label.textContent || '') : '那一列';
	}
	/** 把卡片放进某一列（就地改 DOM；**计数一律走 applyFilter()** ⇒ 只有一份计数实现 ✓）。 */
	function placeInColumn(card, key) {
		var col = colByKey(key);
		var body = bodyOf(col);
		if (!body) { return false; }
		if (card.parentNode !== body) {
			body.appendChild(card);
			// 落进**折叠**的列（如「归档」）时顺手展开：否则用户看不到刚挪过去的结果 ✗
			col.classList.remove('kb-col-folded');
		}
		return true;
	}
	/** 落点：先按"指针在列矩形内"命中；都在外面时只对**列间那条缝**（≤16px 且纵向在列内）退让。 */
	function columnUnder(x, y) {
		var nearest = null;
		for (var i = 0; i < cols.length; i += 1) {
			var rect = cols[i].getBoundingClientRect();
			if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) { return cols[i]; }
			var dx = x < rect.left ? rect.left - x : (x > rect.right ? x - rect.right : 0);
			var insideY = y >= rect.top && y <= rect.bottom;
			if (insideY && dx <= 16 && (!nearest || dx < nearest.dx)) { nearest = { col: cols[i], dx: dx }; }
		}
		return nearest ? nearest.col : null;
	}
	function makeGhost(card, rect) {
		var ghost = card.cloneNode(true);
		ghost.classList.remove('is-dragging');
		ghost.classList.add('kb-ghost');
		ghost.style.width = rect.width + 'px';
		ghost.style.height = rect.height + 'px';
		document.body.appendChild(ghost);
		return ghost;
	}
	/** 松手**立即**到位（乐观），失败**真的回滚**并把原因写出来 —— 不许"失败当成功" ✗。 */
	function commitMove(card, fromCol, dest, id) {
		var label = labelOf(dest);
		bodyOf(dest).appendChild(card);
		applyFilter();
		status('正在移动到「' + label + '」…', false);
		fetch('/x/kanban/api/move', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ id: id, to: dest.getAttribute('data-kanban-col') }),
		})
			.then(function (res) { return res.json().then(function (b) { return { ok: res.ok && b && b.ok, body: b }; }); })
			.then(function (out) {
				if (!out.ok) {
					if (bodyOf(fromCol)) { bodyOf(fromCol).appendChild(card); }
					applyFilter();
					status('没能移动：' + String((out.body && out.body.error) || '未知原因'), true);
					return;
				}
				// ★ **以服务端为准**：它回的 column 才是卡片真正所属的列（"同状态/被别的写者改过"时，
				//   服务端说"没改动"⇒ 页面跟着它走，而不是把乐观挪动当成事实 ✗）。
				if (!placeInColumn(card, out.body.column)) {
					if (bodyOf(fromCol)) { bodyOf(fromCol).appendChild(card); }
				}
				applyFilter();
				status(out.body.changed === false
					? ('没有改动：' + String(out.body.note || ('卡片就在「' + label + '」')))
					: ('已移动到「' + label + '」（' + String(out.body.statusLabel || out.body.status || '') + '）'), false);
			})
			.catch(function (err) {
				if (bodyOf(fromCol)) { bodyOf(fromCol).appendChild(card); }
				applyFilter();
				status('没能移动：' + String(err && err.message ? err.message : err), true);
			});
	}
	function startDrag(event, card) {
		var id = card.getAttribute('data-task-id') || '';
		var fromCol = card.closest('[data-kanban-col]');
		if (!id || !fromCol) { return; }
		event.preventDefault();
		try { card.setPointerCapture(event.pointerId); } catch (e) { /* 捕获只是优化 ✓ */ }
		var startX = event.clientX;
		var startY = event.clientY;
		var grabRect = card.getBoundingClientRect();
		var grabDx = startX - grabRect.left;
		var grabDy = startY - grabRect.top;
		var moved = false;
		var cancelled = false;
		var ghost = null;
		var target = null;

		function mark(highlight) {
			cols.forEach(function (col) {
				col.classList.remove('kb-col-drop', 'kb-col-locked');
				if (col === highlight) {
					col.classList.add(col.getAttribute('data-kanban-drop') === 'locked' ? 'kb-col-locked' : 'kb-col-drop');
				}
			});
		}
		function cleanup() {
			document.removeEventListener('pointermove', onMove);
			document.removeEventListener('pointerup', onUp);
			document.removeEventListener('pointercancel', onCancel);
			document.removeEventListener('keydown', onKey, true);
			mark(null);
			card.classList.remove('is-dragging');
			document.body.style.cursor = '';
			if (ghost && ghost.parentNode) { ghost.parentNode.removeChild(ghost); }
			ghost = null;
		}
		function swallowClickOnce() {
			var onClick = function (clickEvent) {
				clickEvent.stopPropagation();
				clickEvent.preventDefault();
				document.removeEventListener('click', onClick, true);
			};
			document.addEventListener('click', onClick, true);
			// 兜底：万一这次没产生 click（指针移出等），别把捕获监听器留在 document 上 ✗
			setTimeout(function () { document.removeEventListener('click', onClick, true); }, 0);
		}
		function onMove(moveEvent) {
			// ⚠ 死区**两轴**都判 ✗ —— 只判纵向的话，横向拖动永远不触发（本仓踩过："左右无法拖动"）。
			if (!moved && Math.abs(moveEvent.clientX - startX) < 6 && Math.abs(moveEvent.clientY - startY) < 6) { return; }
			if (!moved) {
				moved = true;
				ghost = makeGhost(card, grabRect);
				card.classList.add('is-dragging');
				document.body.style.cursor = 'grabbing';
				status('拖动中 —— 松手即改列，按 Esc 取消', false);
			}
			if (ghost) {
				ghost.style.transform = 'translate3d(' + (moveEvent.clientX - grabDx) + 'px,' + (moveEvent.clientY - grabDy) + 'px,0) scale(1.02)';
			}
			target = columnUnder(moveEvent.clientX, moveEvent.clientY);
			mark(target);
		}
		function onUp() {
			var dest = target;
			var didMove = moved;
			cleanup();
			if (!didMove || cancelled) { return; }
			swallowClickOnce();
			if (!dest) { status('松手的位置不在任何列上 —— 没有改动', true); return; }
			if (dest === fromCol) { status('还在原列 —— 没有改动', false); return; }
			if (dest.getAttribute('data-kanban-drop') === 'locked') {
				status('「' + labelOf(dest) + '」列不接受落卡（执行中的卡改状态语义不清）—— 没有改动', true);
				return;
			}
			commitMove(card, fromCol, dest, id);
		}
		function onCancel() {
			cancelled = true;
			cleanup();
			status('已取消拖动', false);
		}
		function onKey(event) {
			if (event.key === 'Escape') {
				event.preventDefault();
				onCancel();
			}
		}
		document.addEventListener('pointermove', onMove);
		document.addEventListener('pointerup', onUp);
		document.addEventListener('pointercancel', onCancel);
		document.addEventListener('keydown', onKey, true);
	}

	// 只有带 data-kanban-grab 的卡片能拖（running 的卡在服务端渲染时就带的是 data-kanban-locked ✓
	// ⇒ 客户端**不自己判状态**：判据只有服务端给的那一个属性）。
	cards.forEach(function (card) {
		if (!card.hasAttribute('data-kanban-grab')) { return; }
		card.addEventListener('pointerdown', function (event) {
			if (event.button !== 0) { return; }
			startDrag(event, card);
		});
	});

	cols.forEach(function (col) {
		var toggle = col.querySelector('[data-kanban-collapse]');
		if (toggle) {
			toggle.addEventListener('click', function () { col.classList.toggle('kb-col-folded'); });
		}
	});
	var closeBtn = document.querySelector('[data-kanban-drawer-close]');
	if (closeBtn) { closeBtn.addEventListener('click', closeDrawer); }
	document.addEventListener('keydown', function (event) { if (event.key === 'Escape') { closeDrawer(); } });

	if (search) { search.addEventListener('input', applyFilter); }
	if (boardSel) { boardSel.addEventListener('change', applyFilter); }

	// 负责人下拉：**从卡片上的真实数据**建选项（不猜、不写死）
	if (agentSel) {
		var seen = [];
		cards.forEach(function (card) {
			var name = card.getAttribute('data-assignee') || '';
			if (name && seen.indexOf(name) < 0) { seen.push(name); }
		});
		seen.sort().forEach(function (name) {
			var opt = document.createElement('option');
			opt.value = name;
			opt.textContent = name;
			agentSel.appendChild(opt);
		});
		agentSel.addEventListener('change', applyFilter);
	}

	applyFilter();
})();
`;
