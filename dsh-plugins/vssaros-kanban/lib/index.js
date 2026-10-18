// @vssaros/dsh-kanban — host half：只读页面 + 看板工具（list / create / update）。
//
// 数据契约（方案 6.6 看板行 + 6.8 单写者）：读写与 VsSaros IDE **完全相同的** `taskboard.json`，
// 字段真源 `src/vs/sessions/common/agentStudioTypes.ts` 的 TaskBoardRecord；序列化与 IDE 一致（2 空格）。
// 写入的串行/原子/锁/丢更新防护见 `lib/store.js`（含"IDE 侧尚未参与同一把锁"的边界说明）。
// 纯业务逻辑（记录构造、字段更新语义、筛选排序）在 `lib/core/taskboard.js`，零 I/O 可单测（方案 6.9 方案 C）。
//
// 为什么没有任何 `@deepseek-ai/*` import（与 vssaros-bridge 同口径）：
// - 工具定义是普通对象即可（`ToolDefinition = ToolSchema{name,description,parameters} + output + execute`）；
// - 页面用 `ctx.webServer.register({ kind:'prefix' })` + `ctx.connection.requestRejection(req)`，
//   这套「插件自托管页面 + Host 自身鉴权栅栏」在 vssaros-bridge 里已实证（P0-8）。
// 不 import 就避免了 profile 侧对 dsh 包的解析依赖，跨版本更稳。

import { DEFAULT_BOARD_ID, DETAIL_DESCRIPTION_LIMIT, PRIORITIES, STATUSES, applyUpdate, createRecord, project, projectDetail, selectTasks } from './core/taskboard.js';
import { bindFoundation, foundation } from './foundationRef.js';
// 两种承载表面（2026-10-14）：
//   · 侧栏（宿主注入 `?surface=sideview`）⇒ `lib/sideview.js` 的**摘要 + 入口**；
//   · 编辑区（不带该参数）⇒ `lib/board.js` 的**多列看板**（探针 p3-01 走的正是这条）。
// 渲染与样式都在那两个文件里（它们各自 import `pageShell.js`）；**本文件只负责取数 + 分派路由**，
// 免得两个表面的渲染混在一处。看板页的列口径 / 卡片视图模型 / 描述拆分都是纯函数，可被探针直接验。
import { columnKeyForStatus, moveOutcome, renderBoardPage, resolveDrop, splitNotes, statusLabel } from './board.js';

import { renderSideviewPage } from './sideview.js';

import { dataRootOf, mutateTaskboard, readBoards, readDshTodoMirrors, readTaskboard, runnerCwdOf, TASKBOARD_FILE, taskboardPath, workspaceIdOf } from './store.js';
import { createKanbanRunner } from './runner.js';
import { join } from 'node:path';  // 重构 4：web-recipes.json 的路径拼接


export const name = 'vssaros-kanban';
// 只依赖 tools：工具在任何模板里都该可用。webServer / connection 只在 web 模板里存在，
// 写进这里会让整个插件在 headless / tui profile 里**永久 pending**，连工具一起失效（实测）。
export const inject = ['tools'];

/** 页面前缀路由：不带尾斜杠（prefix 路由匹配 `p` 与 `p/<anything>`，见 dsh-host-webserver 类型）。 */
const ROUTE_PREFIX = '/x/kanban';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const LIMITS = { default: DEFAULT_LIMIT, max: MAX_LIMIT };
/** 本插件在反向通道里的调用方标识：VsSaros 侧据此查"这个插件声明了哪些能力"。 */
const PLUGIN_ID = '@vssaros/dsh-kanban';
/** 「在看板打开」的等待预算：主进程一趟 + 渲染侧一趟（不开浏览器、不等用户点头），默认预算够用。 */
const FOCUS_TIMEOUT_MS = 15_000;
/** JSON 回执的统一响应头（多处理由共用一份，免得一处改了另一处忘）。 */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
/** 页面自诊断按这份清单报告注册情况（探针据此断言，不必等模型调用）。 */
const EXPECTED_TOOLS = [
	'kanban_list', 'kanban_create', 'kanban_update',
	// 与 IDE legacy 工具族对齐的动词（逐条按 `kanbanTools.ts` 的语义与**文案格式**移植）
	'kanban_show', 'kanban_complete', 'kanban_block', 'kanban_unblock',
	'kanban_heartbeat', 'kanban_comment', 'kanban_link',
	// 重构 4（2026-10-16）：decompose（LLM 分解父任务为子任务，写 taskboard 带父依赖）。
	'kanban_decompose',
	// 重构 4（2026-10-16）：swarm（建拓扑：root → workers → verifier/synthesizer，写 taskboard；
	//   跑的部分由 runner 接住——拖到 running 就驱动 ✓，与 decompose 同一条链 ✓）。
	'kanban_swarm',
	// 重构 4（2026-10-16）：specify（LLM 细化任务为结构化规格：Goal/Approach/Acceptance/Out of scope，
	//   移到 todo）。与 decompose 同构（读任务 + 经 runs 驱动 + 写回 ✓）。
	'kanban_specify',
	// 重构 4（2026-10-16）：web_recipe（URL 模式 → 抽取函数的配方；数据面：create/list/remove，
	//   存 `<dataRoot>/web-recipes.json`）。抽取执行经桥回 IDE（browser 插件，留待）。
	'web_recipe_create', 'web_recipe_list', 'web_recipe_remove',
	// 重构 4（2026-10-16）：web_scrape_to_board（刮当前打开的浏览器页面 ⇒ 任务进看板）。
	// 执行经桥回 IDE（壳侧的 browser 插件有页面 + Playwright ✓）；回执是任务清单 ⇒ 本侧写 taskboard ✓。
	'web_scrape_to_board',
];

/** runs 服务的模块级引用（runner 的 inject 回调装，decompose 工具用——同一份 ✓）。 */
const runsRef = { current: null };

const text = value => (typeof value === 'string' ? value.trim() : '');

/**
 * 往描述里追加一行（`existing\n<line>`；没有描述就是这一行）。
 * 与 IDE legacy **逐字符同格式**——注释/阻塞原因都写在 description 里，格式不一致会让看板界面里的
 * 历史看起来像两个人的手笔。
 */
function appendNote(description, line) {
	const existing = text(description);
	return existing ? `${existing}\n${line}` : line;
}

/**
 * 解析卡片 id：先精确匹配，再按**末 6 位**后缀匹配（与 IDE legacy 同口径，支持带 `#` 前缀）。
 * 返回 `{ id }` 或 `{ error }`。
 *
 * 与 legacy 的一处**故意差异**：后缀匹配到多张时，legacy 只说 "not found"（对着"到底指哪张"没法查），
 * 这里把候选列出来——同一个歧义输入，模型能自己改对。
 */
function resolveTaskId(tasks, raw) {
	const wanted = text(raw);
	if (!wanted) {
		return { error: 'id 必填' };
	}
	const exact = tasks.find(t => t.id === wanted);
	if (exact) {
		return { id: exact.id };
	}
	const normalized = wanted.replace(/^#/, '');
	const matches = tasks.filter(t => t.id.endsWith(normalized));
	if (matches.length === 1) {
		return { id: matches[0].id };
	}
	if (matches.length === 0) {
		return { error: `找不到卡片：${wanted}` };
	}
	return { error: `卡片 id 有歧义：${wanted} 匹配到 ${matches.length} 张（${matches.map(t => t.id.slice(-6)).join(' / ')}）——请给完整 id` };
}

/** 调用期信息（锁参数由 store 直接从 config 读，配置口径见 store.js 注释）。 */
const storeOptions = exec => ({ signal: exec?.signal });

const TASK_SCHEMA = {
	type: 'object',
	properties: {
		id: { type: 'string' },
		title: { type: 'string' },
		status: { type: 'string' },
		boardId: { type: 'string' },
		priority: { type: 'string' },
		assigneeName: { type: 'string' },
		url: { type: 'string' },
		workspaceId: { type: 'string' },
		updatedAt: { type: 'string' },
	},
	required: ['id', 'title', 'status'],
};

const LIST_OUTPUT_SCHEMA = {
	type: 'object',
	properties: {
		count: { type: 'integer', description: '本次返回的任务数' },
		total: { type: 'integer', description: '过滤后命中的总数（可能大于 count）' },
		tasks: { type: 'array', items: TASK_SCHEMA },
		// 看板维度（README 5.117 / 数据面 C 组）：`boards.json` 里登记过的看板 ✓（只取**有消费者**的
		// 三个字段 ✓）。⚠ `default`（`DEFAULT_BOARD_ID`）**永远存在** ✓，但它不一定在这张表里 ✗
		//（IDE 只在真的建过板时才落盘 ✓）⇒ 描述里必须说清，否则模型会以为"表里没有 = 不能用 default" ✗。
		boardCount: { type: 'integer', description: '看板元数据里的看板数（不含隐式的 default）' },
		boardsNote: { type: 'string', description: 'boards.json 读不懂时的如实说明（与任务文件缺失分开 ✓）' },
		boards: {
			type: 'array',
			description: 'boards.json 里登记过的看板（id / name / workspaceId）',
			items: {
				type: 'object',
				properties: { id: { type: 'string' }, name: { type: 'string' }, workspaceId: { type: 'string' } },
				required: ['id', 'name'],
			},
		},
		note: { type: 'string', description: '数据文件缺失等说明' },
	},
	required: ['count', 'total', 'tasks'],
};

const MUTATION_OUTPUT_SCHEMA = {
	type: 'object',
	properties: {
		task: TASK_SCHEMA,
		changed: { type: 'array', items: { type: 'string' }, description: '被改动的字段名' },
	},
	required: ['task'],
};

const ONE_TASK_OUTPUT_SCHEMA = {
	type: 'object',
	properties: { task: TASK_SCHEMA },
	required: ['task'],
};

function renderTaskList(value) {
	const lines = [`看板任务：返回 ${value.count} / 命中 ${value.total}`];
	for (const t of value.tasks) {
		const extra = [t.boardId ? `board ${t.boardId}` : '', t.priority ?? '', t.assigneeName ?? ''].filter(Boolean).join(' · ');
		lines.push(`- [${t.status}] ${t.id}　${t.title}${extra ? `　(${extra})` : ''}`);
	}
	// ⚠ 位置有讲究 ✓：**首行**必须仍是"看板任务：返回 N / 命中 M" —— 卡片在没有 `meta` 时靠它回落
	//（旧日志 / 嵌套调用 ✓），所以看板这句只能放在**任务行之后** ✗。
	// ⚠ 只在"**有东西可说**"时打这句 ✓（有看板 ✓、或 `boards.json` 读不懂 ✓）：没有文件不是异常 ✓ ——
	// 隐式 `default` 永远存在这条已经写在**工具描述**里 ✓，每次列表都重复一遍是噪音 ✗。
	if (value.boards?.length || value.boardsNote) {
		lines.push(value.boards?.length
			? `看板：${value.boards.map(b => `${b.name}（${b.id}）`).join('、')}（另含隐式 default）`
			: `看板：${value.boardsNote}`);
	}
	if (value.note) {
		lines.push(value.note);
	}
	return lines.join('\n');
}

/**
 * 页面渲染的**分派**（2026-10-14）：
 * - `?surface=sideview`（宿主在**侧栏**承载时注入）⇒ `renderSideviewPage` 的摘要 + 入口；
 * - 其余（编辑区的完整版；探针 p3-01 走的正是这条）⇒ `renderBoardPage` 的多列看板。
 *
 * 两个表面**吃同一份数据、共用同一批锚点**（`data-vssaros-tools` / `data-registered` /
 * `data-vssaros-workspace` / 数据文件路径都在 `board.js` 的 `diagHtml` 里，只有一份实现 ⇒ 不会漂）。
 */
function renderPage(input) {
	return (input.surface === 'sideview' ? renderSideviewPage : renderBoardPage)({
		...input,
		expectedTools: EXPECTED_TOOLS,
	});
}

/** 「拖拽换列」写口的请求体上限（只有 id + 列 key，4KB 绰绰有余）。 */
const MOVE_BODY_LIMIT = 4 * 1024;

/**
 * 读 JSON 请求体。**不信任任何输入**：超限 / 空 / 不是 JSON 都返回可读原因 ✓
 * （与 `vssaros-dashboard` 那份**逐字同款** —— 那是本仓已验证的写法；插件之间不互相 import ✓）。
 * ⚠ 用 `for await` 读**流**（真机是 `IncomingMessage`）⇒ 探针里的假 req 必须提供 `Symbol.asyncIterator` ✓。
 */
async function readJsonBody(req, limit) {
	let body = '';
	try {
		for await (const chunk of req) {
			body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
			if (body.length > limit) {
				return { error: `请求体超过上限（${limit} 字节）` };
			}
		}
	} catch (e) {
		return { error: `请求体读取失败：${e?.message ?? e}` };
	}
	if (!body.trim()) {
		return { error: '请求体为空' };
	}
	try {
		return { value: JSON.parse(body) };
	} catch (e) {
		return { error: `请求体不是合法 JSON：${e?.message ?? e}` };
	}
}

/**
 * 带 HTTP 语义的拒绝：`mutateTaskboard` 的 mutator 里**抛它**就能"既不写盘、又能给出精确状态码" ✓
 * （⚠ 若改成在 mutator 里 `return { tasks: list, ... }`，store 会**原样重写一次**文件 —— 不写盘就必须抛 ✓）。
 */
function refusal(httpStatus, message) {
	return Object.assign(new Error(message), { httpStatus });
}

/**
 * 建卡前必须拿到工作区 id，否则卡片在看板界面里不可见（见 `store.workspaceIdOf` 注释）。
 *
 * ★ 2026-10-17 **导出**：这是**写路径**上"卡片归哪个工作区"的唯一来源（`kanban_create` / `update` /
 *   `decompose` / `swarm` / `specify` 都经它）—— 切工作区要不要重启 Host，靠的就是它认不认运行期上下文 ✓。
 *   为什么要能被守卫断到：dsh 侧的**读**路径根本不按工作区过滤（`kanban_list` 缺省 = 全部工作区，
 *   过滤在 IDE 侧用它自己的活动工作区 id 做）⇒ 只断读路径会得出"运行期上下文没用"的**错误**结论 ✗
 *   （`dsh-plugins/check-host-config.mjs` 的 `writeStamp` 链就是它 ✓）。
 */
export function requireWorkspaceId(config, fromArgs) {
	const workspaceId = text(fromArgs) || workspaceIdOf(config);
	if (!workspaceId) {
		throw new Error('拿不到工作区 id：这样建出来的卡片在看板界面里不可见。'
			+ '请让 VsSaros 经 --patch 注入 config.workspaceId（或设环境变量 VSSAROS_WORKSPACE_ID），或在参数里显式给 workspaceId。');
	}
	return workspaceId;
}

/**
 * 装配期配置校验（fail-fast）：**错型立刻拒**，而且指得出是哪个键 ✓ —— 报告 §5-8 要的效果是"错型
 * **启动期即报**、而不是等第一次读配置才炸" ✓，这里用**同样早**的时机自己做到它 ✓。
 *
 * 为什么不用 dsh 的 `Config` 声明：那要 `import { z } from '@deepseek-ai/schemastery'` ✗ —— 本仓插件
 * **不 import 任何 `@deepseek-ai/*`** ✓（见本文件头那条理由：避免 profile 侧对 dsh 包的解析依赖、
 * 跨版本更稳 ✓）。键清单与 `store.js` **真正读的键一一对应** ✓（加配置键时这里也要加 ✗，否则校验漏）。
 *
 * ⚠ `vssaros-kanban` / `vssaros-workflow` 各有一份**内容相同**的副本（插件之间不能互相 import ✓）——
 * 改一处必须改另一处 ✓（两边各有断言钉住"错型必须抛" ✓，漏改会红 ✗）。
 */
function validateConfig(config) {
	const stringKeys = ['dataRoot', 'workspaceId'];
	const integerKeys = ['lockWaitMs', 'lockStaleMs'];
	for (const key of stringKeys) {
		const value = config?.[key];
		if (value !== undefined && typeof value !== 'string') {
			throw new Error(`${name}: config.${key} 必须是字符串（收到 ${typeof value}）—— 错型的配置会让模块读到别的地方，装配期直接拒掉`);
		}
	}
	for (const key of integerKeys) {
		const value = config?.[key];
		if (value !== undefined && !Number.isInteger(value)) {
			throw new Error(`${name}: config.${key} 必须是整数（收到 ${typeof value}）`);
		}
	}
}

export function apply(ctx, config = {}) {
	// ── 配置校验（fail-fast，报告 §5-8）：装配期即拒错型，别等第一次读配置才炸 ✗
	validateConfig(config);
	// 重构 1.3：绑定 foundation 共享服务（dataRoot/dshHome/pageShell/lock 的真源）。
	// ⚠ 位置在校验**之后** ✓：错型配置必须装配期第一个抛（守卫看的就是"报的是哪个键" ✓）。
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
	// ── R13（preset plane）：同一个包会被挂**两次**（host plane 一行 + 我们的 preset 里一行 ✓）──
	// `hostHalf: true` ⇒ 这一次只注册页面/路由，**不注册工具**（工具交给 preset 里那次 ✓）；
	// 缺省（不写）⇒ **与从前完全一样**（页面 + 工具都注册 ✓）⇒ 加这个闸本身零行为改变 ✓。
	// 下面 10 个工具注册点统一改成**三元**表达（`hostHalf` 为真时这个 effect 直接返回 `undefined`）✓
	// —— 三元写在**参数位置**上，不改变括号配平 ⇒ 一次替换就能闸全部 ✓；工具重名是**静默顶掉**、
	//   不报错 ✗，所以必须显式分半边，不能靠两边都注册去碰运气 ✓。
	// ⚠ 注释里**故意不写那句三元的完整字面量** ✓：写了它就会成为"批量替换的锚点"的一部分
	// （实测锚点从 10 处变成 11 处 ✗ —— 突变脚本会连注释一起改）。

	// ⚠ 位置在 `validateConfig` **之后** ✓：错型配置必须装配期第一个说话（p3-10 守卫看的正是"报的是哪个键"✓）。
	const hostHalf = config.hostHalf === true;
	// ★ 写入类工具的**审批闸**（报告 §5-1 / README 5.103）：官方派发前决策钩子是 `tools/pre-execute`
	// 这条 **waterfall 事件** ✓（`dsh-tools` 类型 L37-47 ✓）；返回 `{ kind: 'ask' }` ＝ "先问用户" ✓。
	// 官方契约把三件事写死了 ✓（L437-441 / L817-820）：
	//   ① `ask` **只有审批服务返回 `allowed-once` 才执行**，否则 **deny** ✓；
	//   ② 审批缝是 `ctx.get('approval')`（由 `@deepseek-ai/dsh-user-approval` 提供 ✓）；
	//   ③ 「**没有审批支持的部署会把 `ask` 变成拒绝**」✓ ⇒ headless / base 组合里我们的写工具**直接拒绝** ✓
	//      —— 这正是写入该有的方向（fail-closed ✓），而不是"没有界面就悄悄放行" ✗。
	// 真机那半**已有实测**：4.24 验过完整两段舞（沙箱挡回 → 模型带 `danger-full-access` 重发 → **弹审批卡**
	// → 点 Allow once → 执行成功 ✓）。
	// ⚠ 只拦**写入类**工具 ✓：两个只读的（`kanban_list` / `kanban_show`）走 `next()` 交回默认 allow ✓
	// —— 否则每次列表也要弹窗，工具就没法用了 ✗。
	const WRITE_TOOL_NAMES = EXPECTED_TOOLS.filter(name => name !== 'kanban_list' && name !== 'kanban_show');
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		if (exec && WRITE_TOOL_NAMES.includes(exec.name)) {
			return {
				kind: 'ask',
				// `reason` 是**审计**口径（官方：the audited approval reason ✓）、`displayReason` 是本地化提示 ✓
				reason: `${exec.name} 会改动看板数据文件`,
				displayReason: { en: `Allow ${exec.name} to modify the taskboard?`, zh: `允许 ${exec.name} 修改看板数据？` },
			};
		}
		return next();
	}));
	// 自托管页面：Host 自己的鉴权栅栏 + 同源同 partition 的 Cookie（VsSaros 侧 WebContentsView 加载）。
	// 用 `ctx.inject` 做**可选依赖**：这两个服务就绪时才注册路由；缺它们（headless / tui profile）
	// 不影响本插件激活，工具照常可用。
	// 反向通道（**可选**依赖）：页面上的「在看板打开」要经它请求 IDE 的 taskboard 能力。
	//
	// ★ 2026-10-14 修正（与 workflow / codebase 同一处根因）：原先 `const found = ctx.vssarosBridge`
	//   包 try/catch —— 那句**恒抛** ✗（cordis 的 context 代理对未在 `inject` 里声明的服务一律抛
	//   `cannot get property "vssarosBridge" without inject`，见 `@deepseek-ai/cordis/src/reflect.ts`）
	//   ⇒ 被 catch 吞掉后恒为 undefined ⇒ 点条目**永远**回 503「控制桥不可用」，而桥其实是好的 ✗。
	//   ⇒ 改用 `ctx.inject(['vssarosBridge'], …)` **动态声明**（与上面 webServer / connection 同一姿势：
	//   桥不在时**不会**让插件 pending，工具照常可用 ✓），并在 scope 里读 ✓
	//   —— 这样读到的服务"访问方 ctx"是我们自己 ⇒ 桥的 `stampCallerIdentity`（盖章真身份）仍生效 ✓。
	let bridge;
	ctx.inject(['vssarosBridge'], scope => {
		bridge = scope.vssarosBridge;
		return () => { bridge = undefined; };
	});
	// 重构 2.2：看板自动执行 runner（拖到「进行中」⇒ 驱动专属会话跑完并回写，见 lib/runner.js）。
	// 可选注入 vssarosRuns：bridge 0.2.26+ 提供；不在（旧桥/没装）⇒ runner 不启动，看板照常 ✓。
	// cwd：看板的工作区路径 = VsSaros 注入的 workspaceId 对应的 dsh 工作区路径；拿不齐就不启动
	// （拿错目录跑任务是比"不跑"更差的失败 ✗）。
	let runner;
	// 自动执行 runner 的**可断言状态**（2026-10-17）：页面自诊断（`data-kanban-runner`）读它 ⇒
	// "产品口径下 runner 起不起来"这条不再只能读代码判定 ✓（那个 warn 走 `ctx.logger`，探针抓不到 ✗）。
	// ⚠ 声明在 **apply 作用域**里（不挂模块级）：p3-110 抓到过模块级状态泄漏（上一个夹具的 runs 被下一个读到 ✗）。
	const runnerState = { on: false, why: 'init' };
	ctx.inject(['vssarosRuns', 'workspaceRegistry'], scope => {
		// 防御：探针的假 ctx 不忠实模拟"依赖不齐就不调 cb"（直接调）⇒ 服务不齐时如实不启动，
		// 不抛错（抛错会让整个插件 apply 失败 ✗，看板工具陪葬 ✗）。
		let runsSvc, registry;
		try { runsSvc = scope.vssarosRuns; registry = scope.workspaceRegistry; } catch { /* Proxy 假 ctx */ }
		if (!runsSvc || typeof runsSvc.run !== 'function' || !registry || typeof registry.list !== 'function') {
			runnerState.why = 'deps-missing';
			const log = typeof ctx.logger === 'function' ? ctx.logger('vssaros-kanban') : console;
			log.warn('runner 未启动：vssarosRuns / workspaceRegistry 不齐（旧桥 / 探针假 ctx）');
			return undefined;
		}
		// 重构 4（2026-10-16）：runs 也存到模块级（decompose 工具要用它驱动 LLM 分解 ✓——
		//   与 runner 同一份 ✓，不是另起一份 ✗）。
		runsRef.current = runsSvc;
		// ★ 2026-10-17 **重做**（本刀：切工作区不必重启 Host 的最后一块）：从前这里是"apply 时算一次 cwd"，
		//   而那次几乎**必然拿不到**（`workspaceId` 是 Agent Studio 的 slug id，dsh 注册表里是 dsh 自己的 id
		//   = 两套 id 空间 ⇒ 匹配不上；兜底 `config.workspacePath` 产品侧没人注入）⇒ **runner 在真机上从未起来过**
		//   （只有一行 `ctx.logger` 的 warn，且它不在 Host stdout 里 ⇒ 之前连探针都钉不住）。
		//   现在三件事一起改：① 目录**逐卡**按运行期上下文解析（`runnerCwdOf`）；② 起停**跟着上下文走**
		//   （切工作区不重启 Host 就能换根 ✓）；③ 只把**当前工作区**的卡交给 runner（别的工作区的卡既不该在
		//   今天的目录里跑，也不该被"看不见 ⇒ 取消"误伤 ✓）。
		if (config.runner === false) {
			// 显式关闭的逃生口（IDE 侧要是将来给用户一个"不要自动执行"的开关，注 `runner: false` 即可 ✓）
			runnerState.why = 'disabled';
			return undefined;
		}
		const readBoardForCurrentWorkspace = async () => {
			const current = workspaceIdOf(config);
			const all = (await readTaskboard(config)).tasks;
			return current ? all.filter(t => t && t.workspaceId === current) : [];
		};
		/**
		 * 起停判定（幂等）：拿得到当前工作区的**可靠**目录 ⇒ 起（没有就停）；每次判定后立刻对账一轮，
		 * 这样"切工作区 ⇒ 旧工作区的在跑卡被取消 / 新工作区的卡被拾取"不必等 15s 轮询 ✓。
		 */
		const sync = () => {
			const cwd = runnerCwdOf(config, workspaceIdOf(config), registry.list());
			if (!cwd) {
				if (runner) { runner.stop(); runner = undefined; }
				runnerState.on = false;
				runnerState.why = 'no-cwd';
				return false;
			}
			if (!runner) {
				runner = createKanbanRunner({
					readBoard: readBoardForCurrentWorkspace,
					mutateTaskboard: mutator => mutateTaskboard(config, mutator),
					runs: runsSvc,
					// ⚠ **逐卡**解析（runner 就是这么调的 ✓）：`cwdOf(task.workspaceId)`
					cwdOf: taskWorkspaceId => runnerCwdOf(config, taskWorkspaceId, registry.list()),
					log: (level, msg) => ctx.logger('vssaros-kanban')[level === 'warn' ? 'warn' : 'info'](msg),
					config,
				});
				runner.start();
			}
			runnerState.on = true;
			runnerState.why = 'ok';
			void runner.kick();
			return true;
		};
		if (!sync()) {
			ctx.logger('vssaros-kanban').warn('runner 未启动：当前工作区拿不到**可靠**目录（运行期上下文的 workspaceRoot 与 config.workspacePath 都没有）'
				+ '—— 这是产品口径下的**正常**状态（推上下文后会自动起来 ✓；或注 config.runner === false 表示"不要自动执行"）。');
		}
		// 上下文变了（IDE 切工作区）⇒ 重新判定起停 + 立即对账（**不重启 Host** ✓，与本刀其余部分同一条纪律）
		let offWorkspaceContext;
		try {
			offWorkspaceContext = foundation().onDidChangeWorkspaceContext?.(() => { sync(); });
		} catch { /* 没有 foundation（老 Host / 探针假 ctx）⇒ 只在启动那一刻判一次，与从前同口径 ✓ */ }
		// dispose 时清掉模块级的 runsRef（否则探针的下一个夹具会读到上一个的 runs ✗——
		//   模块级状态泄漏，p3-110 ② 抓到：没 runs 的夹具静默跑过了 ✗）。
		return () => {
			try { offWorkspaceContext?.(); } catch { /* 退订失败不值得打扰用户 ✓ */ }
			if (runner) { runner.stop(); runner = undefined; }
			runsRef.current = null;
			runnerState.on = false;
			runnerState.why = 'disposed';
		};
	});
	function bridgeOf() {
		return bridge && typeof bridge.callIDE === 'function' ? bridge : undefined;
	}
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
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			const pathname = url.pathname;
			try {
				if (pathname === `${ROUTE_PREFIX}/api/focus`) {
					// 「在看板打开」：**只经反向通道**请求 IDE 能力 `taskboard`（清单里已声明 ⇒ 才有授权）。
					// 没有桥 / 没有 IDE 监听时给**可读错误**（页面据此显示原因），绝不静默成功。
					const title = (url.searchParams.get('title') ?? '').trim();
					if (!title) {
						res.writeHead(400, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: 'title 必填（按标题定位卡片，与 IDE 侧 focusTaskInBoard 同口径）' }));
						return;
					}
					const activeBridge = bridgeOf();
					if (!activeBridge || typeof activeBridge.callIDE !== 'function') {
						res.writeHead(503, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: '控制桥不可用（@vssaros/dsh-bridge 未加载或版本过旧）：定位看板需要反向通道（协议 v2）' }));
						return;
					}
					try {
						const reply = await activeBridge.callIDE('ide.request', {
							capability: 'taskboard',
							pluginId: PLUGIN_ID,
							params: { op: 'focus', title },
						}, { timeoutMs: FOCUS_TIMEOUT_MS });
						res.writeHead(200, JSON_HEADERS);
						res.end(JSON.stringify({ ok: true, reply: reply ?? null }));
					} catch (e) {
						// 主进程拒绝（未声明能力 / 插件未装 / 无 IDE 在监听）与执行端报错都走这里，
						// 文案原样带出去——这是用户唯一能看到的线索。
						res.writeHead(502, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
					}
					return;
				}
				// ── 拖拽换列（本页**唯一**的写口；四条边界见 `lib/board.js` 文件头）──────────────────
				// 只认 `{ id, to: <列 key> }`：**不接受任意 status**（否则这页就成了"改任意字段"的写口 ✗）。
				if (pathname === `${ROUTE_PREFIX}/api/move`) {
					if (req.method !== 'POST') {
						res.writeHead(405, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: '换列写入只接受 POST', method: String(req.method ?? '') }));
						return;
					}
					const parsed = await readJsonBody(req, MOVE_BODY_LIMIT);
					if (parsed.error) {
						res.writeHead(400, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: parsed.error }));
						return;
					}
					const incoming = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
					const wanted = text(incoming.id);
					if (!wanted) {
						res.writeHead(400, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: 'id 必填（完整 id 或末 6 位短 id）' }));
						return;
					}
					const drop = resolveDrop(incoming.to);
					if (!drop.ok) {
						res.writeHead(400, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: drop.reason }));
						return;
					}
					const reply = (code, payload) => {
						res.writeHead(code, JSON_HEADERS);
						res.end(JSON.stringify(payload));
					};
					try {
						const { tasks } = await readTaskboard(config, undefined);
						// ① **快速判定**（不写盘的那几种情形在这里挡掉：找不到 / 不可拖 / 同状态）——
						//    它的价值是"能拒绝就不动文件"✓；但它是**无锁读**，所以不能当权威 ✗（见 ②）。
						const resolved = resolveTaskId(tasks, wanted);
						if (resolved.error) {
							reply(404, { ok: false, error: resolved.error });
							return;
						}
						const quick = moveOutcome(tasks.find(t => t.id === resolved.id), drop.status);
						if (!quick.ok) {
							reply(409, { ok: false, error: quick.reason });
							return;
						}
						if (quick.changed === false) {
							reply(200, {
								ok: true, changed: false, status: quick.status, statusLabel: statusLabel(quick.status),
								column: columnKeyForStatus(quick.status),
								note: `卡片本来就在「${columnKeyForStatus(quick.status)}」（状态 ${quick.status}）—— 没有改动`,
							});
							return;
						}
						// ② **权威判定在锁内**：读与写之间别的写者可能改了这张卡（IDE 也在写同一个文件 ✓）⇒
						//    锁内重判，判定不过就**抛**（抛 ⇒ store 连文件都不会碰 ✓；改成 return 会原样重写一次 ✗）。
						const outcome = await mutateTaskboard(config, list => {
							const again = resolveTaskId(list, resolved.id);
							if (again.error) {
								throw refusal(404, `卡片在写入前消失了：${again.error}`);
							}
							const verdict = moveOutcome(list.find(t => t.id === again.id), drop.status);
							if (!verdict.ok) {
								throw refusal(409, verdict.reason);
							}
							if (verdict.changed === false) {
								// ⚠ 这不是失败：**别人已经把它挪到目标列了** ⇒ 回 `ok:true, changed:false` 让客户端
								//    跟着服务端走（而不是把乐观挪动当成事实 ✗）。
								throw refusal(200, `卡片已经被别的写者移到「${columnKeyForStatus(verdict.status)}」了 —— 没有改动`);
							}
							const index = list.findIndex(t => t.id === again.id);
							// ★ 与工具**同语义**：`applyUpdate` 负责写/清 `completedAt`（与 kanban_update 同一条码路 ✓）
							const { task, changed } = applyUpdate(list[index], { status: drop.status });
							const next = [...list];
							next[index] = task;
							return { tasks: next, value: { task: project(task), changed } };
						}, storeOptions(undefined));
						reply(200, {
							ok: true, changed: true, status: drop.status, statusLabel: statusLabel(drop.status),
							column: columnKeyForStatus(drop.status), task: outcome.task, changedFields: outcome.changed,
						});
					} catch (e) {
						// 拒绝是**预期路径**（带 `httpStatus`）；其余错误原样交给外层 500 ✓。
						// ⚠ `httpStatus === 200` 表示"没改动"（锁内发现别人已经挪到目标列了）—— 不是失败 ✓，
						//   所以回 `ok:true, changed:false`，让客户端**以服务端为准**收尾 ✓。
						if (Number.isInteger(e?.httpStatus)) {
							if (e.httpStatus === 200) {
								reply(200, {
									ok: true, changed: false,
									status: String(drop.status), statusLabel: statusLabel(drop.status),
									column: columnKeyForStatus(drop.status), note: String(e.message),
								});
							} else {
								reply(e.httpStatus, { ok: false, error: String(e.message) });
							}
							return;
						}
						throw e;
					}
					return;
				}
				const { tasks, missing } = await readTaskboard(config, undefined);
				// 详情接口（2026-10-14）：**描述按需拉**。本机实测单条描述最长 266 KB（全表 4.5 MB）
				// ⇒ 列表页绝不带描述，只有点开某一张卡时才取这一张（且限长、如实标注截断 ✓）。
				if (pathname === `${ROUTE_PREFIX}/api/task`) {
					const wanted = (url.searchParams.get('id') ?? '').trim();
					if (!wanted) {
						res.writeHead(400, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: 'id 必填（完整 id 或末 6 位短 id）' }));
						return;
					}
					const resolved = resolveTaskId(tasks, wanted);
					if (resolved.error) {
						// 找不到 / 有歧义：404 与原因（`resolveTaskId` 对"多张匹配"会把候选列出来 ✓）
						res.writeHead(404, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: resolved.error }));
						return;
					}
					const task = tasks.find(t => t.id === resolved.id);
					const statusById = new Map(tasks.map(t => [String(t.id ?? ''), statusLabel(t.status)]));
					const desc = splitNotes(task.description);
					// ⚠ `description` **不整段回传**（`projectDetail` 会带上它）：只回拆好的 head / notes ✓
					//   —— 同一个 4000 字上限，但客户端拿到的正是它要画的形状（5.83：没消费者的字段等于没有 ✓）。
					const { description: _omit, ...detail } = projectDetail(task);
					res.writeHead(200, JSON_HEADERS);
					res.end(JSON.stringify({
						ok: true,
						task: { ...detail, statusLabel: statusLabel(task.status) },
						desc: { ...desc, limit: DETAIL_DESCRIPTION_LIMIT },
						depStatus: Object.fromEntries((detail.dependencies ?? []).map(id => [id, statusById.get(id) ?? ''])),
					}));
					return;
				}
				const { total, tasks: picked } = selectTasks(tasks, {}, LIMITS);
				if (pathname === `${ROUTE_PREFIX}/api/tasks`) {
					res.writeHead(200, JSON_HEADERS);
					res.end(JSON.stringify({ total, tasks: picked.map(project), ...(missing ? { missing } : {}) }));
					return;
				}
				// 看板页吃**全部**任务（卡片只带短字段 ⇒ 55 条的 payload 是几十 KB 量级 ✓）；列表接口
				// `/api/tasks` 那条仍按 LIMITS 截断（它是给模型读的，口径没变 ✓）。每列另有 `COLUMN_LIMIT`
				// 上限并**如实报数**（超出时页面写"还有 N 张未显示" ✓）。
				const { boards, error: boardsError } = await readBoards(config);
				// ★ dsh 任务镜像（只读，2026-10-14 P1）：读 dsh 的 `todos` 会话投影 ⇒ 以**镜像卡**落列。
				//   读不到**不是致命错误**：把原因交给页面如实显示（`board.js` 的 `data-kanban-mirror-note` ✓），
				//   绝不当成"没有任务"静默掉 ✗ —— 那是"两份真相"里最容易骗人的一处 ✓。
				//   ⚠ 失败**不**影响看板本体（我们自己的 taskboard 照常渲染 ✓）。
				const mirrorRead = await readDshTodoMirrors(config)
					.catch(e => ({ mirrors: [], note: `读取异常：${String(e?.message ?? e)}` }));
				// 渲染放到 writeHead 之前：渲染抛错时还能干净地回 500（顺序反了会变成"头已发出→再写头又抛
				// →socket 被切断"，在 skills 模块上实测吃过这个亏）。200 之后真发生异常则只 end。
				const html = renderPage({
					surface: url.searchParams.get('surface') === 'sideview' ? 'sideview' : 'board',
					// ⚠ 页面自己从这份数组算总数与各列计数（**只有一份**计数实现 ✓）；`total` 只服务
					// `/api/tasks` 那条给模型读的接口 ⇒ 不往页面里传第二次（两处算同一个数早晚会漂 ✗）。
					tasks,
					missing,
					boards,
					note: boardsError ?? '',
					registeredTools: EXPECTED_TOOLS.filter(name => !!ctx.tools.get(name)),
					dataFile: taskboardPath(config),
					workspaceId: workspaceIdOf(config) ?? '',
					// 自动执行状态（2026-10-17）：页面自诊断把它写成 `data-kanban-runner` ⇒ 探针/用户都看得见 ✓
					runner: runnerState.on,
					runnerWhy: runnerState.why,
					// dsh 任务镜像（**只读**；`board.js` 只认 `mirrors`/`mirrorsNote` 两个键 ✓，sideview 忽略 ✓）
					mirrors: mirrorRead.mirrors,
					mirrorsNote: mirrorRead.note,
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

	// 只读工具：注册进 ctx.tools 后 schema 自动进入系统提示（见 dsh-tools README）。
	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'kanban_list',
		description: '列出 VsSaros 看板任务（只读）。读取与 IDE 相同的 taskboard.json，返回任务 id / 标题 / 状态等字段，可用于了解当前待办与进展。同时给出 boards.json 里**登记过的看板**（id / name / workspaceId ✓）—— 要按 boardId 过滤就得先知道有哪些 boardId；⚠ 隐式的 `default` 板**永远存在**，即使它没出现在这张表里。',
		parameters: {
			type: 'object',
			properties: {
				boardId: { type: 'string', description: '按看板 id 过滤（缺省 = 全部看板）' },
				status: { type: 'string', enum: STATUSES, description: '按状态过滤' },
				query: { type: 'string', description: '标题关键字（不区分大小写）' },
				workspaceId: { type: 'string', description: '按工作区 id 过滤（缺省 = 全部工作区）' },
				// 注意：dsh 的参数 schema 只接受受限子集（type/oneOf/properties/required/additionalProperties/items/enum/const），
				// 没有 minimum/maximum —— 范围只能写进描述、由代码夹紧（selectTasks 里做）。
				limit: { type: 'integer', description: `返回条数上限，1–${MAX_LIMIT}（默认 ${DEFAULT_LIMIT}；超出会被夹到边界）` },
			},
		},
		output: {
			schema: LIST_OUTPUT_SCHEMA,
			// ★ `presentationMeta`（报告 §5-11 / README 5.101 第三张卡）：卡片的计数**此前靠正则抠首行** ✗
			// （`/^看板任务：返回 (\d+) \/ 命中 (\d+)/` ✓ —— 首行文案一改，卡片就**静默**少一块 ✓）。
			// 改成元数据承载 ✓。⚠ 同 workflow / codebase 两条约束：① 随会话日志持久化并**每次请求重发**
			// ⇒ 必须**限长** ✓（只放计数，**不放 tasks** ✗）；② 官方只为**顶层调用**算 meta ✓
			// ⇒ 卡片必须保留首行回落 ✗（旧日志 / 嵌套调用 ✓）。
			// ⚠ 只放**卡片真的会读**的字段 ✓：`note`（数据文件缺失说明）**不放** ✗ —— 人读行与 `raw`
			// 已经带着它 ✓，而 meta 是"卡片读的投影"不是"结果副本"（5.83 的教训：没消费者的字段等于没有 ✓）。
			presentationMeta: (_args, value) => ({
				shape: 'kanban-list',
				count: value.count,
				total: value.total,
			}),
			render: (_args, value) => [{ type: 'text', text: renderTaskList(value) }],
		},
		// 纯读、无共享可变状态：允许与同批只读工具并行（见 ToolDefinition.isConcurrencySafe 契约）。
		isConcurrencySafe: () => true,
		async execute(args = {}, exec) {
			const { tasks, missing } = await readTaskboard(config, exec?.signal);
			const { total, tasks: picked } = selectTasks(tasks, args, LIMITS);
			// 看板维度（README 5.117）：与任务**分开读** ✓ —— `boards.json` 不存在不算错 ✓（只说明还没建过板 ✓）。
			const { boards, error: boardsError } = await readBoards(config);
			return {
				count: picked.length,
				total,
				tasks: picked.map(project),
				// ⚠ 读不懂 `boards.json` 时**如实报** ✓（不装作"没有看板" ✗）—— 与 `missing` 分开成两句 ✓。
				boardCount: boards.length,
				...(boards.length ? { boards } : {}),
				...(missing ? { note: `看板数据文件还不存在：${missing}（首次启动或尚未使用看板时属正常）` } : {}),
				...(boardsError ? { boardsNote: boardsError } : {}),
			};
		},
	}));

	// 写工具：不声明 isConcurrencySafe（默认独占，见契约"仅 true 表示可并行"）。
	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'kanban_create',
		description: '在看板上新建一张卡片（写入与 IDE 同一个 taskboard.json）。默认进 triage 列（待分解/细化），默认看板、medium 优先级；可用 status 直接指定别的列。',
		parameters: {
			type: 'object',
			properties: {
				title: { type: 'string', description: '卡片标题' },
				description: { type: 'string', description: '卡片描述（内联 base64 图片/附件会被替换成占位符，与 IDE 一致）' },
				status: { type: 'string', enum: STATUSES, description: '初始状态（默认 triage）' },
				priority: { type: 'string', enum: PRIORITIES, description: '优先级（默认 medium）' },
				boardId: { type: 'string', description: `看板 id（默认 ${DEFAULT_BOARD_ID}）` },
				// 与 IDE 的 legacy `kanban_create` 参数名对齐（它叫 assignee），两个名字都收
				assigneeName: { type: 'string', description: '指派给谁（展示名；等价于 assignee）' },
				assignee: { type: 'string', description: 'assigneeName 的别名（兼容 IDE legacy 工具的参数名）' },
				url: { type: 'string', description: '参考链接' },
				workspaceId: { type: 'string', description: '工作区 id（缺省用 Host 注入的当前工作区）' },
			},
			required: ['title'],
		},
		output: {
			schema: ONE_TASK_OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: `已新建卡片 ${value.task.id}　[${value.task.status}] ${value.task.title}` }],
		},
		async execute(args = {}, exec) {
			const workspaceId = requireWorkspaceId(config, args.workspaceId);
			// `assignee` 是 IDE legacy `kanban_create` 的参数名，两个名字都收（assigneeName 优先）
			const record = createRecord({ ...args, assigneeName: args.assigneeName ?? args.assignee, workspaceId });
			const created = await mutateTaskboard(
				config,
				tasks => ({ tasks: [...tasks, record], value: record }),
				storeOptions(exec),
			);
			return { task: project(created) };
		},
	}));

	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'kanban_update',
		description: '更新看板卡片（标题/描述/状态/优先级/看板/链接/指派）。状态改为 done / cancelled / archived 时会写完成时间，退回其它状态会清掉。',
		parameters: {
			type: 'object',
			properties: {
				id: { type: 'string', description: '卡片 id' },
				title: { type: 'string' },
				description: { type: 'string' },
				status: { type: 'string', enum: STATUSES },
				priority: { type: 'string', enum: PRIORITIES },
				boardId: { type: 'string' },
				url: { type: 'string' },
				assigneeName: { type: 'string' },
			},
			required: ['id'],
		},
		output: {
			schema: MUTATION_OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: `已更新 ${value.task.id}：${(value.changed ?? []).join(' / ')} → [${value.task.status}] ${value.task.title}` }],
		},
		async execute(args = {}, exec) {
			const id = text(args.id);
			if (!id) {
				throw new Error('id 必填');
			}
			return mutateTaskboard(config, tasks => {
				const index = tasks.findIndex(t => t.id === id);
				if (index < 0) {
					throw new Error(`找不到卡片：${id}`);
				}
				const { task, changed } = applyUpdate(tasks[index], args);
				const next = [...tasks];
				next[index] = task;
				return { tasks: next, value: { task: project(task), changed } };
			}, storeOptions(exec));
		},
	}));

	// ── 与 IDE legacy 工具族对齐的动词（`kanbanTools.ts` 是语义与文案的真源）────────────────────
	// 每个工具的**数据效果**必须与 IDE 完全一致：两端写同一份 `taskboard.json`，语义分叉会变成
	// "同一个动词在两个引擎里结果不同"，那比缺这个工具更糟。故意不移植的三个（`specify` / `decompose` /
	// `swarm`）都要**调模型**——那是 agent 自己的活，不做成"看起来是确定性操作"的工具。

	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'kanban_show',
		description: '查看单张看板卡片的完整信息（标题 / 描述 / 状态 / 指派 / 优先级 / 依赖 / 时间戳）。id 支持完整 id 或末 6 位短 id（可带 # 前缀）。',
		parameters: {
			type: 'object',
			properties: { id: { type: 'string', description: '卡片 id（完整或末 6 位）' } },
			required: ['id'],
		},
		output: {
			schema: ONE_TASK_OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: `#${value.task.id.slice(-6)} [${value.task.status}] ${value.task.title}` }],
		},
		isConcurrencySafe: () => true,
		async execute(args = {}) {
			const { tasks } = await readTaskboard(config);
			const resolved = resolveTaskId(tasks, args.id);
			if (resolved.error) {
				throw new Error(resolved.error);
			}
			// 详情投影（带描述与依赖）：与 IDE legacy 的 `kanban_show` 输出对齐——它也是给全文的
			return { task: projectDetail(tasks.find(t => t.id === resolved.id)) };
		},
	}));

	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'kanban_complete',
		description: '把看板卡片标记为完成（进 done 列），可带一句结果摘要。',
		parameters: {
			type: 'object',
			properties: {
				id: { type: 'string', description: '卡片 id（完整或末 6 位）' },
				result: { type: 'string', description: '结果摘要（可选）' },
			},
			required: ['id'],
		},
		output: {
			schema: MUTATION_OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: `已完成 #${value.task.id.slice(-6)}：${value.task.title}` }],
		},
		async execute(args = {}, exec) {
			const result = text(args.result);
			return mutateTaskboard(config, tasks => {
				const resolved = resolveTaskId(tasks, args.id);
				if (resolved.error) {
					throw new Error(resolved.error);
				}
				const index = tasks.findIndex(t => t.id === resolved.id);
				// ⚠ 与 IDE legacy **一致**：给了 `result` 就把它写进 `description`（**替换**原描述，
				// 不是追加）。这是那份实现的行为，两端写同一份文件 ⇒ 跟随它，不做"我觉得更好"的改动。
				const { task, changed } = applyUpdate(tasks[index], {
					status: 'done',
					...(result ? { description: result } : {}),
				});
				const next = [...tasks];
				next[index] = task;
				return { tasks: next, value: { task: project(task), changed } };
			}, storeOptions(exec));
		},
	}));

	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'kanban_block',
		description: '把卡片标记为阻塞（进 blocked 列）并记下原因——原因必填，会以 `[BLOCKED] …` 追加到描述里（与 IDE 同格式）。',
		parameters: {
			type: 'object',
			properties: {
				id: { type: 'string', description: '卡片 id（完整或末 6 位）' },
				reason: { type: 'string', description: '阻塞原因（必填）' },
			},
			required: ['id', 'reason'],
		},
		output: {
			schema: MUTATION_OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: `已阻塞 #${value.task.id.slice(-6)}：${value.task.title}` }],
		},
		async execute(args = {}, exec) {
			const reason = text(args.reason);
			if (!reason) {
				throw new Error('reason 必填：阻塞要有原因（会写进描述里）');
			}
			return mutateTaskboard(config, tasks => {
				const resolved = resolveTaskId(tasks, args.id);
				if (resolved.error) {
					throw new Error(resolved.error);
				}
				const index = tasks.findIndex(t => t.id === resolved.id);
				const { task, changed } = applyUpdate(tasks[index], {
					status: 'blocked',
					description: appendNote(tasks[index].description, `[BLOCKED] ${reason}`),
				});
				const next = [...tasks];
				next[index] = task;
				return { tasks: next, value: { task: project(task), changed } };
			}, storeOptions(exec));
		},
	}));

	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'kanban_unblock',
		description: '解除阻塞：把卡片退回 todo 列（与 IDE 一致，不删描述里的 `[BLOCKED] …` 记录）。',
		parameters: {
			type: 'object',
			properties: { id: { type: 'string', description: '卡片 id（完整或末 6 位）' } },
			required: ['id'],
		},
		output: {
			schema: MUTATION_OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: `已解除阻塞 #${value.task.id.slice(-6)} → [${value.task.status}]` }],
		},
		async execute(args = {}, exec) {
			return mutateTaskboard(config, tasks => {
				const resolved = resolveTaskId(tasks, args.id);
				if (resolved.error) {
					throw new Error(resolved.error);
				}
				const index = tasks.findIndex(t => t.id === resolved.id);
				const { task, changed } = applyUpdate(tasks[index], { status: 'todo' });
				const next = [...tasks];
				next[index] = task;
				return { tasks: next, value: { task: project(task), changed } };
			}, storeOptions(exec));
		},
	}));

	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'kanban_heartbeat',
		description: '报告"这张卡还在推进"：带 note 时以 `[HEARTBEAT <时间>] …` 追加到描述；不带 note 就只刷新更新时间（免得诊断把在跑的活当成卡死/掉线）。',
		parameters: {
			type: 'object',
			properties: {
				id: { type: 'string', description: '卡片 id（完整或末 6 位）' },
				note: { type: 'string', description: '进展说明（可选；给了就写进描述）' },
			},
			required: ['id'],
		},
		output: {
			schema: MUTATION_OUTPUT_SCHEMA,
			render: (_args, value) => [{
				type: 'text',
				text: value.changed.includes('description')
					? `已记录进展 #${value.task.id.slice(-6)}`
					: `已刷新 #${value.task.id.slice(-6)} 的活跃时间（无内容）`,
			}],
		},
		async execute(args = {}, exec) {
			const note = text(args.note);
			return mutateTaskboard(config, tasks => {
				const resolved = resolveTaskId(tasks, args.id);
				if (resolved.error) {
					throw new Error(resolved.error);
				}
				const index = tasks.findIndex(t => t.id === resolved.id);
				// 没内容也要"碰一下"：重写标题 ⇒ `updatedAt` 刷新（与 legacy 同一手，不改语义）
				const { task, changed } = applyUpdate(tasks[index], note
					? { description: appendNote(tasks[index].description, `[HEARTBEAT ${new Date().toISOString()}] ${note}`) }
					: { title: tasks[index].title });
				const next = [...tasks];
				next[index] = task;
				return { tasks: next, value: { task: project(task), changed } };
			}, storeOptions(exec));
		},
	}));

	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'kanban_comment',
		description: '给卡片加一条评论（以 `[COMMENT …]` 追加到描述里，与 IDE 同格式）。用来记录进展、发现或结论。',
		parameters: {
			type: 'object',
			properties: {
				id: { type: 'string', description: '卡片 id（完整或末 6 位）' },
				body: { type: 'string', description: '评论内容' },
			},
			required: ['id', 'body'],
		},
		output: {
			schema: MUTATION_OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: `已评论 #${value.task.id.slice(-6)}` }],
		},
		async execute(args = {}, exec) {
			const body = text(args.body);
			if (!body) {
				throw new Error('body 必填：评论要有内容');
			}
			return mutateTaskboard(config, tasks => {
				const resolved = resolveTaskId(tasks, args.id);
				if (resolved.error) {
					throw new Error(resolved.error);
				}
				const index = tasks.findIndex(t => t.id === resolved.id);
				// 作者名固定 `agent`：dsh 的工具上下文里**没有** IDE 那份 agent 显示名（legacy 用的是
				// `studioService.getAgent(agentId).name`）。格式其余部分与 IDE 逐字符一致。
				const { task, changed } = applyUpdate(tasks[index], {
					description: appendNote(tasks[index].description, `[COMMENT agent ${new Date().toISOString()}] ${body}`),
				});
				const next = [...tasks];
				next[index] = task;
				return { tasks: next, value: { task: project(task), changed } };
			}, storeOptions(exec));
		},
	}));

	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'kanban_link',
		description: '建立依赖：child 依赖 parent（parent 先完成，child 才能开始）。已有同一条依赖时不改动、如实回报；不允许自依赖。',
		parameters: {
			type: 'object',
			properties: {
				parent_id: { type: 'string', description: '先完成的卡片（完整或末 6 位）' },
				child_id: { type: 'string', description: '依赖它的卡片（完整或末 6 位）' },
			},
			required: ['parent_id', 'child_id'],
		},
		output: {
			schema: MUTATION_OUTPUT_SCHEMA,
			render: (args, value) => [{
				// 文案用**调用参数**里的 parent（回执的 task 是精简投影，不带 dependencies——
				// 依赖清单要看用 `kanban_show`，它的详情投影才给）
				type: 'text',
				text: value.changed.length === 0
					? `#${value.task.id.slice(-6)} 已有这条依赖，未改动`
					: `已建立依赖：#${value.task.id.slice(-6)} 依赖 ${String(args?.parent_id ?? '').slice(-6)}`,
			}],
		},
		async execute(args = {}, exec) {
			return mutateTaskboard(config, tasks => {
				const parent = resolveTaskId(tasks, args.parent_id);
				if (parent.error) {
					throw new Error(`parent_id：${parent.error}`);
				}
				const child = resolveTaskId(tasks, args.child_id);
				if (child.error) {
					throw new Error(`child_id：${child.error}`);
				}
				if (parent.id === child.id) {
					throw new Error('卡片不能依赖自己');
				}
				const index = tasks.findIndex(t => t.id === child.id);
				const deps = new Set(tasks[index].dependencies ?? []);
				if (deps.has(parent.id)) {
					// 已经是这个状态：**不写文件**（返回原数组 ⇒ 指纹不变 ⇒ store 不会落盘），如实回报
					return { tasks, value: { task: project(tasks[index]), changed: [] } };
				}
				deps.add(parent.id);
				const { task, changed } = applyUpdate(tasks[index], { dependencies: [...deps] });
				const next = [...tasks];
				next[index] = task;
				return { tasks: next, value: { task: project(task), changed } };
			}, storeOptions(exec));
		},
	}));

	// 重构 4（2026-10-16）：`kanban_decompose`——LLM 分解父任务为子任务（写 taskboard 带父依赖）。
	// 与 runner 同一份 runs（`runsRef` ✓——inject 回调装的，见上面 ✓）。写类 ⇒ 挂审批闸 ✓
	//（kanban 的闸已拦所有写工具 ✓——decompose 在 WRITE_TOOL_NAMES 里 ✓）。
	// 分解是模型的事（LLM 出子任务清单）⇒ 经 runs 驱动一回合；解析不了 ⇒ 如实报错（不静默建空任务 ✗）。
	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'kanban_decompose',
		description: '把一张看板卡片分解成 2-N 个具体子任务（LLM 分解），创建带父依赖的子卡片。fanout=true（默认）⇒ 独立/并行子任务；false ⇒ 顺序子任务（后一个依赖前一个）。',
		parameters: {
			type: 'object',
			properties: {
				task_id: { type: 'string', description: '父卡片 id（完整或末 6 位）' },
				fanout: { type: 'boolean', description: 'true=并行/独立子任务（默认），false=顺序' },
				max_subtasks: { type: 'number', description: '最多几个子任务（默认 6，上限 12）' },
				assignee: { type: 'string', description: '子任务的默认指派（可选）' },
				workspaceId: { type: 'string', description: '工作区 id（缺省用 Host 注入的当前工作区）' },
			},
			required: ['task_id'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					parentId: { type: 'string' },
					children: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } },
					error: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `已把 #${String(value.parentId ?? '').slice(-6)} 分解成 ${value.children?.length ?? 0} 个子任务：\n${(value.children ?? []).map(c => `  #${String(c.id ?? '').slice(-6)} — ${c.title}`).join('\n')}`
					: `分解失败：${value.error ?? '未知原因'}`,
			}],
		},
		// 写类 ⇒ 不声明 isConcurrencySafe（默认独占 ✓）。
		async execute(args = {}) {
			const taskId = String(args?.task_id ?? '').trim();
			if (!taskId) { throw new Error('task_id 必填（父卡片 id）'); }
			const workspaceId = requireWorkspaceId(config, args.workspaceId);
			// 读父任务
			const { tasks } = await readTaskboard(config);
			const resolved = resolveTaskId(tasks, taskId);
			if (resolved.error) { throw new Error(resolved.error); }
			const parent = tasks.find(t => t.id === resolved.id);
			// 经 runs 驱动 LLM 分解（与 runner 同一份 ✓；没有 ⇒ 如实报错 ✗）
			const runs = runsRef.current;
			if (!runs || typeof runs.run !== 'function') {
				throw new Error('分解要 LLM（经 vssarosRuns 驱动一回合），它不在（bridge 0.2.26+ 才有）——runner 没启动时这个工具用不了 ✓');
			}
			const maxSubTasks = Math.min(12, Math.max(2, Number.isFinite(args?.max_subtasks) ? Math.floor(args.max_subtasks) : 6));
			const fanout = args?.fanout !== false;
			const prompt = [
				`把下面这张看板卡片分解成 ${Math.min(4, maxSubTasks)}–${maxSubTasks} 个具体、可执行的子任务。`,
				`父卡片标题：${parent.title}`,
				parent.description ? `父卡片描述：${parent.description}` : '',
				'只回 JSON 数组，每项 {title, body}（body 是这个子任务要做什么）。不要别的文字。',
			].filter(Boolean).join('\n');
			const result = await runs.run({
				sessionId: `kanban-decompose-${parent.id.slice(-6)}`,
				cwd: workspaceId,
				prompt,
			});
			if (result.stopReason !== 'completed') {
				throw new Error(`分解回合未完成（stopReason=${result.stopReason ?? '未知'}）`);
			}
			// 解析 LLM 的输出（JSON 数组）；解析不了 ⇒ 如实报错（不静默建空任务 ✗）
			let children;
			try {
				const text = String(result.finalText ?? '').trim();
				const jsonMatch = text.match(/\[[\s\S]*\]/);
				children = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
			} catch { children = null; }
			if (!Array.isArray(children) || children.length === 0) {
				throw new Error(`分解回合没产出可解析的子任务清单（要 JSON 数组 [{title, body}, …]）：${String(result.finalText ?? '').slice(0, 120)}`);
			}
			children = children.slice(0, maxSubTasks);
			// 写子任务（带父依赖：fanout ⇒ 都依赖父；顺序 ⇒ 后一个依赖前一个）
			const created = [];
			let prevId = parent.id;
			for (const child of children) {
				const title = String(child?.title ?? '').trim();
				if (!title) { continue; }
				const record = createRecord({
					title,
					description: String(child?.body ?? '').trim() || undefined,
					assigneeName: typeof args?.assignee === 'string' ? args.assignee : undefined,
					workspaceId,
				});
				// 依赖：fanout ⇒ 都依赖父；顺序 ⇒ 后一个依赖前一个（第一个还是依赖父 ✓）
				record.dependencies = [prevId];
				if (!fanout) { prevId = record.id; }
				const createdRecord = await mutateTaskboard(config, tasks => ({ tasks: [...tasks, record], value: record }), {});
				created.push({ id: createdRecord.id, title: createdRecord.title });
			}
			return { ok: true, parentId: parent.id, children: created };
		},
	}));

	// 重构 4（2026-10-16）：`kanban_swarm`——建多代理拓扑（root → workers → verifier → synthesizer），
	// 写进 taskboard。**跑的部分由 runner 接住**（拖到 running 就驱动 ✓——与 decompose 同一条链 ✓，
	// 本工具只建拓扑 ✓，不自己跑 ✗）。写类 ⇒ 挂审批闸 ✓（kanban 的闸已拦所有写工具 ✓）。
	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'kanban_swarm',
		description: '建一个多代理协作拓扑：root 任务 → 并行 worker 任务 → verifier（验证）→ synthesizer（综合）。写进看板后由 runner 驱动（拖到「进行中」就跑）。workers 至少 1 个（每个要 title + body）。enable_verifier / enable_synthesizer 控制要不要验证/综合阶段（缺省：≥2 个 worker 时开 verifier，总是开 synthesizer）。',
		parameters: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Swarm 标题（成为 root 任务的标题）' },
				goal: { type: 'string', description: '总目标（注入每个 worker 的上下文）' },
				workers: {
					type: 'array',
					description: 'Worker 规格（至少 1 个）',
					items: {
						type: 'object',
						properties: {
							title: { type: 'string', description: 'Worker 卡片标题' },
							body: { type: 'string', description: '这个 worker 要做什么' },
							profile: { type: 'string', description: 'Worker 角色/人设（可选）' },
							priority: { type: 'string', enum: ['low', 'medium', 'high'], description: '优先级' },
						},
						required: ['title', 'body'],
					},
				},
				enable_verifier: { type: 'boolean', description: '要不要验证阶段（缺省：≥2 个 worker 时开）' },
				enable_synthesizer: { type: 'boolean', description: '要不要综合阶段（缺省：开）' },
				workspaceId: { type: 'string', description: '工作区 id（缺省用 Host 注入的当前工作区）' },
			},
			required: ['title', 'workers'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					swarmId: { type: 'string' },
					rootId: { type: 'string' },
					workerIds: { type: 'array', items: { type: 'string' } },
					verifierId: { type: 'string' },
					synthesizerId: { type: 'string' },
					error: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `已建 swarm「${value.swarmId}」（root #${String(value.rootId ?? '').slice(-6)} · ${value.workerIds?.length ?? 0} 个 worker${value.verifierId ? ' · 含验证' : ''}${value.synthesizerId ? ' · 含综合' : ''}）——拖到「进行中」由 runner 驱动`
					: `建 swarm 失败：${value.error ?? '未知原因'}`,
			}],
		},
		// 写类 ⇒ 不声明 isConcurrencySafe（默认独占 ✓）。
		async execute(args = {}) {
			const title = String(args?.title ?? '').trim();
			if (!title) { throw new Error('title 必填（swarm 标题）'); }
			const rawWorkers = Array.isArray(args?.workers) ? args.workers : [];
			if (rawWorkers.length === 0) { throw new Error('workers 必填（至少 1 个 worker，每个要 title + body）'); }
			const workspaceId = requireWorkspaceId(config, args.workspaceId);
			// 校验 worker 规格（缺 title/body 的跳过 ✓——legacy 同款）
			const workers = [];
			for (const w of rawWorkers) {
				const wTitle = String(w?.title ?? '').trim();
				const wBody = String(w?.body ?? '').trim();
				if (!wTitle || !wBody) { continue; }
				workers.push({ title: wTitle, body: wBody, profile: String(w?.profile ?? '').trim() || undefined, priority: w?.priority });
			}
			if (workers.length === 0) { throw new Error('没有有效的 worker（每个要 title + body）'); }
			const goal = String(args?.goal ?? '').trim();
			const enableVerifier = typeof args?.enable_verifier === 'boolean' ? args.enable_verifier : workers.length >= 2;
			const enableSynthesizer = typeof args?.enable_synthesizer === 'boolean' ? args.enable_synthesizer : true;
			// 建拓扑（顺序：root → workers → verifier → synthesizer；依赖关系见下）
			const swarmId = `swarm-${Date.now().toString(36)}`;
			const created = [];
			// root
			const root = createRecord({ title, description: goal || undefined, workspaceId, status: 'todo' });
			await mutateTaskboard(config, tasks => ({ tasks: [...tasks, root], value: root }), {});
			created.push(root);
			// workers（都依赖 root）
			const workerIds = [];
			for (const w of workers) {
				const record = createRecord({
					title: w.title,
					description: [w.body, goal ? `\n\n总目标：${goal}` : '', w.profile ? `\n\n角色：${w.profile}` : ''].filter(Boolean).join(''),
					priority: w.priority,
					workspaceId,
					status: 'todo',
				});
				record.dependencies = [root.id];
				await mutateTaskboard(config, tasks => ({ tasks: [...tasks, record], value: record }), {});
				workerIds.push(record.id);
				created.push(record);
			}
			// verifier（依赖所有 worker）
			let verifierId;
			if (enableVerifier) {
				const record = createRecord({ title: `验证：${title}`, description: '核对所有 worker 的产出是否满足总目标', workspaceId, status: 'todo' });
				record.dependencies = [...workerIds];
				await mutateTaskboard(config, tasks => ({ tasks: [...tasks, record], value: record }), {});
				verifierId = record.id;
				created.push(record);
			}
			// synthesizer（依赖 verifier 或所有 worker）
			let synthesizerId;
			if (enableSynthesizer) {
				const record = createRecord({ title: `综合：${title}`, description: '把所有产出综合成最终结果', workspaceId, status: 'todo' });
				record.dependencies = verifierId ? [verifierId] : [...workerIds];
				await mutateTaskboard(config, tasks => ({ tasks: [...tasks, record], value: record }), {});
				synthesizerId = record.id;
				created.push(record);
			}
			return { ok: true, swarmId, rootId: root.id, workerIds, verifierId, synthesizerId };
		},
	}));

	// 重构 4（2026-10-16）：`kanban_specify`——LLM 细化任务为结构化规格（Goal / Approach /
	// Acceptance criteria / Out of scope），移到 todo。与 decompose 同构（读任务 + 经 runs 驱动 +
	// 写回 ✓；与 runner 同一份 runs ✓——`runsRef`）。写类 ⇒ 挂审批闸 ✓（kanban 的闸已拦所有写工具 ✓）。
	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'kanban_specify',
		description: '把一张粗略的看板卡片细化成结构化规格（目标 / 方案 / 验收标准 / 不做的事），移到「待办」。细化是模型的事（LLM 出规格）⇒ 经 vssarosRuns 驱动一回合；解析不了 ⇒ 如实报错（不静默写空规格 ✗）。',
		parameters: {
			type: 'object',
			properties: {
				task_id: { type: 'string', description: '要细化的卡片 id（完整或末 6 位）' },
				workspaceId: { type: 'string', description: '工作区 id（缺省用 Host 注入的当前工作区）' },
			},
			required: ['task_id'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					taskId: { type: 'string' },
					status: { type: 'string' },
					spec: { type: 'string', description: '结构化规格（Goal / Approach / Acceptance criteria / Out of scope）' },
					error: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `已细化 #${String(value.taskId ?? '').slice(-6)}（移到 ${value.status}）：\n${String(value.spec ?? '').slice(0, 300)}`
					: `细化失败：${value.error ?? '未知原因'}`,
			}],
		},
		// 写类 ⇒ 不声明 isConcurrencySafe（默认独占 ✓）。
		async execute(args = {}) {
			const taskId = String(args?.task_id ?? '').trim();
			if (!taskId) { throw new Error('task_id 必填（要细化的卡片 id）'); }
			requireWorkspaceId(config, args.workspaceId);
			// 读任务
			const { tasks } = await readTaskboard(config);
			const resolved = resolveTaskId(tasks, taskId);
			if (resolved.error) { throw new Error(resolved.error); }
			const task = tasks.find(t => t.id === resolved.id);
			// 经 runs 驱动 LLM 细化（与 runner 同一份 ✓；没有 ⇒ 如实报错 ✗）
			const runs = runsRef.current;
			if (!runs || typeof runs.run !== 'function') {
				throw new Error('细化要 LLM（经 vssarosRuns 驱动一回合），它不在（bridge 0.2.26+ 才有）——runner 没启动时这个工具用不了 ✓');
			}
			const prompt = [
				'把下面这张看板卡片细化成结构化规格。用这四个标题（逐字）：',
				'**目标** / **方案** / **验收标准** / **不做的事**',
				`卡片标题：${task.title}`,
				task.description ? `卡片描述：${task.description}` : '',
				'只回规格正文（Markdown），不要别的文字。',
			].filter(Boolean).join('\n');
			const result = await runs.run({
				sessionId: `kanban-specify-${task.id.slice(-6)}`,
				cwd: requireWorkspaceId(config, args.workspaceId),
				prompt,
			});
			if (result.stopReason !== 'completed') {
				throw new Error(`细化回合未完成（stopReason=${result.stopReason ?? '未知'}）`);
			}
			const spec = String(result.finalText ?? '').trim();
			if (!spec || !spec.includes('**目标**')) {
				throw new Error(`细化回合没产出结构化规格（要含「**目标**」标题）：${spec.slice(0, 120)}`);
			}
			// 写回（规格进描述 + 移到 todo）
			const updated = await mutateTaskboard(config, tasks => {
				const index = tasks.findIndex(t => t.id === task.id);
				if (index < 0) { throw new Error(`卡片 ${task.id} 在写回时不在了（并发改？）`); }
				const { task: next, changed } = applyUpdate(tasks[index], { description: spec, status: 'todo' });
				const nextTasks = [...tasks];
				nextTasks[index] = next;
				return { tasks: nextTasks, value: { task: projectDetail(next), changed } };
			}, {});
			return { ok: true, taskId: task.id, status: updated.task.status, spec };
		},
	}));

	// 重构 4（2026-10-16）：web_recipe 三件套——URL 模式 → 抽取函数的配方（数据面：存文件）。
	// 抽取执行经桥回 IDE（browser 插件的 Playwright，留待——本工具只存配方 ✓，不执行 ✗）。
	// create/remove 是写类 ⇒ 挂审批闸 ✓（kanban 的闸已拦所有写工具 ✓）；list 只读 ✓。
	const recipesPath = () => join(dataRootOf(config), 'web-recipes.json');
	const readRecipes = async () => {
		try {
			const raw = await import('node:fs/promises').then(m => m.readFile(recipesPath(), 'utf8'));
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed?.recipes) ? parsed.recipes : [];
		} catch { return []; }
	};
	const writeRecipes = async (recipes) => {
		const { writeFile, mkdir } = await import('node:fs/promises');
		const { dirname } = await import('node:path');
		await mkdir(dirname(recipesPath()), { recursive: true });
		await writeFile(recipesPath(), JSON.stringify({ recipes }, null, 2));
	};

	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'web_recipe_create',
		description: '存一个可复用的抓取配方：把 URL 模式（正则）绑到一个 Playwright 抽取函数。存好后，打开匹配的页面调 web_scrape_to_board 就会用这个配方（确定性抽取，不用 LLM 每次解析）。适合固定站点（TAPD / Jira / GitHub Issues）。抽取执行在 IDE 侧（browser 插件）——本工具只存配方。',
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string', description: '配方名（唯一，后面用它引用）' },
				url_pattern: { type: 'string', description: 'URL 正则（匹配页面 URL）' },
				url_flags: { type: 'string', description: '正则标志（如 "i"；缺省空）' },
				extract_fn: { type: 'string', description: 'JS 函数串：async (page, args) => ({ boardName, sourceUrl, tasks }) 或裸任务数组' },
				board_name: { type: 'string', description: '固定看板名（覆盖函数输出；可选）' },
				max_tasks: { type: 'number', description: '单配方任务上限（默认 30，硬上限 100）' },
			},
			required: ['name', 'url_pattern', 'extract_fn'],
		},
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' }, name: { type: 'string' } } },
			render: (_args, value) => [{ type: 'text', text: value.ok ? `已存配方「${value.name}」` : '存配方失败' }],
		},
		async execute(args = {}) {
			const name = String(args?.name ?? '').trim();
			const urlPattern = String(args?.url_pattern ?? '').trim();
			const extractFn = String(args?.extract_fn ?? '').trim();
			if (!name) { throw new Error('name 必填（配方名）'); }
			if (!urlPattern) { throw new Error('url_pattern 必填（URL 正则）'); }
			if (!extractFn) { throw new Error('extract_fn 必填（抽取函数串）'); }
			// 正则要能编译（存一个跑不起来的配方是没意义的 ✗）
			try { new RegExp(urlPattern, String(args?.url_flags ?? '')); } catch (e) { throw new Error(`url_pattern 编译不了：${String(e?.message ?? e)}`); }
			const recipes = await readRecipes();
			if (recipes.some(r => r.name === name)) { throw new Error(`配方 ${name} 已存在（不会覆盖 ✓；要改先删掉再建）。`); }
			recipes.push({
				name,
				urlPattern,
				urlFlags: String(args?.url_flags ?? '').trim() || undefined,
				extractFn,
				boardName: String(args?.board_name ?? '').trim() || undefined,
				maxTasks: Number.isFinite(args?.max_tasks) ? Math.min(100, Math.max(1, Math.floor(args.max_tasks))) : undefined,
			});
			await writeRecipes(recipes);
			return { ok: true, name };
		},
	}));

	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'web_recipe_list',
		description: '列出所有已存的抓取配方（名字 / URL 模式 / 看板名 / 任务上限）。',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: { type: 'object', properties: { count: { type: 'integer' }, recipes: { type: 'array', items: { type: 'object' } } } },
			render: (_args, value) => [{
				type: 'text',
				text: value.count ? `${value.count} 个配方：\n${value.recipes.map(r => `  • ${r.name}  —  /${r.urlPattern}/${r.urlFlags ?? ''}${r.boardName ? `  (看板: ${r.boardName})` : ''}${r.maxTasks ? `  (上限: ${r.maxTasks})` : ''}`).join('\n')}` : '还没有配方（用 web_recipe_create 存一个）。',
			}],
		},
		isConcurrencySafe: () => true,  // 只读 ✓
		execute: async () => ({ count: (await readRecipes()).length, recipes: await readRecipes() }),
	}));

	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'web_recipe_remove',
		description: '删掉一个抓取配方（按名字）。',
		parameters: {
			type: 'object',
			properties: { name: { type: 'string', description: '要删的配方名' } },
			required: ['name'],
		},
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' }, name: { type: 'string' } } },
			render: (_args, value) => [{ type: 'text', text: value.ok ? `已删配方「${value.name}」` : '删配方失败' }],
		},
		async execute(args = {}) {
			const name = String(args?.name ?? '').trim();
			if (!name) { throw new Error('name 必填（要删的配方名）'); }
			const recipes = await readRecipes();
			const index = recipes.findIndex(r => r.name === name);
			if (index < 0) { throw new Error(`配方 ${name} 不存在（remove 要求目标在 ✓——免得"以为删了"）。`); }
			recipes.splice(index, 1);
			await writeRecipes(recipes);
			return { ok: true, name };
		},
	}));

	// 重构 4（2026-10-16）：`web_scrape_to_board`——刮当前打开的浏览器页面 ⇒ 任务进看板。
	// 执行经桥回 IDE（壳侧的 browser 插件有页面 + Playwright ✓；本侧没有浏览器 ✗——如实说 ✓）。
	// 回执是任务清单 ⇒ 本侧写进 taskboard（与 kanban_create 同款写法 ✓）。写类 ⇒ 挂审批闸 ✓。
	ctx.effect(() => hostHalf ? undefined : ctx.tools.register({
		name: 'web_scrape_to_board',
		description: '刮当前打开的浏览器页面，把页面上的任务/待办/TODO 列表自动建成看板卡片。有配方匹配 URL 时用配方（确定性抽取，不用 LLM）；否则 LLM 解析页面快照。用 web_recipe_create 存配方后可复用。执行在 IDE 侧（browser 插件的 Playwright）——本侧只接收任务清单并写进看板。',
		parameters: {
			type: 'object',
			properties: {
				board_name: { type: 'string', description: '看板名（缺省 = 页面标题 / 配方的看板名）' },
				max_tasks: { type: 'number', description: '最多建几张卡（默认 30，硬上限 100）' },
				recipe: { type: 'string', description: '强制用某个配方（跳过 URL 自动匹配）' },
				auto_match: { type: 'boolean', description: '自动按 URL 匹配配方（默认 true；false = 总是 LLM 解析）' },
				workspaceId: { type: 'string', description: '工作区 id（缺省用 Host 注入的当前工作区）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					boardName: { type: 'string' },
					created: { type: 'integer' },
					tasks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } },
					error: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `已建 ${value.created} 张卡片到「${value.boardName}」：\n${(value.tasks ?? []).map(t => `  #${String(t.id ?? '').slice(-6)} — ${t.title}`).join('\n')}`
					: `刮取失败：${value.error ?? '未知原因'}`,
			}],
		},
		// 写类 ⇒ 不声明 isConcurrencySafe（默认独占 ✓）。
		async execute(args = {}) {
			const workspaceId = requireWorkspaceId(config, args.workspaceId);
			// 经桥回 IDE（壳侧的 browser 插件跑 Playwright 抽取或 LLM 解析 ✓；本侧没有浏览器 ✗）
			if (!bridge || typeof bridge.callIDE !== 'function') {
				throw new Error('刮取要经桥回 IDE（browser 插件的 Playwright 在壳侧），但 vssarosBridge 不在（bridge 插件没装/没连）');
			}
			// capability 是 `browser`（不是 `kanban`）——刮取用的是 browser 插件的 Playwright ✓
			// （清单支持的能力名里有 `browser`，没有 `kanban` ✗——p3-110 的守卫抓到 ✓）。
			const reply = await bridge.callIDE('ide.request', {
				capability: 'browser',
				pluginId: 'vssaros-kanban',
				params: {
					op: 'scrapeToBoard',
					boardName: String(args?.board_name ?? '').trim() || undefined,
					maxTasks: Number.isFinite(args?.max_tasks) ? Math.min(100, Math.max(1, Math.floor(args.max_tasks))) : undefined,
					recipe: String(args?.recipe ?? '').trim() || undefined,
					autoMatch: args?.auto_match !== false,
				},
			}, { timeoutMs: 5 * 60 * 1000 });  // 刮取 + LLM 解析可能慢
			const taskSpecs = Array.isArray(reply?.tasks) ? reply.tasks : null;
			if (!taskSpecs) {
				throw new Error(`IDE 没回任务清单（没打开浏览器页面？或 browser 插件没实现 scrapeToBoard）：${JSON.stringify(reply)?.slice(0, 120)}`);
			}
			if (taskSpecs.length === 0) {
				return { ok: true, boardName: String(reply?.boardName ?? args?.board_name ?? ''), created: 0, tasks: [] };
			}
			// 写进 taskboard（与 kanban_create 同款写法 ✓）
			const boardName = String(reply?.boardName ?? args?.board_name ?? '刮取').trim();
			const created = [];
			for (const spec of taskSpecs.slice(0, 100)) {
				const title = String(spec?.title ?? '').trim();
				if (!title) { continue; }
				const record = createRecord({
					title,
					description: String(spec?.description ?? '').trim() || undefined,
					priority: spec?.priority,
					assigneeName: String(spec?.assignee ?? '').trim() || undefined,
					url: String(spec?.sourceUrl ?? '').trim() || undefined,
					workspaceId,
				});
				const createdRecord = await mutateTaskboard(config, tasks => ({ tasks: [...tasks, record], value: record }), {});
				created.push({ id: createdRecord.id, title: createdRecord.title });
			}
			return { ok: true, boardName, created: created.length, tasks: created };
		},
	}));

}
