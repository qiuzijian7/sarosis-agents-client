/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Toolset 配置 — 参考 Hermes-Agent 的 `toolsets.py` 设计。
 *
 * 每个工具都属于一个 toolset，toolset 决定了工具的：
 *   1. 优先级 — 核心工具始终发送给 LLM，非核心工具按名额填充
 *   2. 可折叠性 — 非核心工具超过 token 阈值时折叠为 tool_search + tool_call 桥接
 *   3. Agent 级配置 — Agent 可声明 enabledToolsets，仅保留这些 toolset 的工具
 *
 * 与 Hermes 的差异：
 *   - Hermes 用 Python dict + includes 递归组合
 *   - Saros 用 TS Map + 名称模式匹配自动推断 toolset
 *   - 不支持嵌套 includes（Sarosis 工具数量远少于 Hermes，不需要组合）
 */

// ─── Toolset 优先级 ──────────────────────────────────────────────────────

export enum ToolsetPriority {
	/** 始终发送给 LLM，不可折叠 */
	Always = 0,
	/** 高优先级 — 尽量发送，仅在极端 token 超限时折叠 */
	High = 1,
	/** 中优先级 — 按名额填充，超过阈值时折叠 */
	Medium = 2,
	/** 低优先级 — 优先折叠为桥接工具 */
	Low = 3,
}

// ─── Toolset 定义 ────────────────────────────────────────────────────────

export interface IToolsetDefinition {
	/** toolset 唯一标识 */
	readonly id: string;
	/** 人类可读名称 */
	readonly label: string;
	/** 优先级 */
	readonly priority: ToolsetPriority;
	/** 工具名前缀列表 — 用于自动推断工具所属 toolset */
	readonly prefixes: readonly string[];
	/** 工具名精确匹配列表 — 用于前缀无法覆盖的情况 */
	readonly exactNames?: readonly string[];
	/** 是否可折叠为 tool_search + tool_call 桥接 */
	readonly deferrable: boolean;
}

/**
 * Toolset 定义表 — 按优先级从高到低排列。
 * 第一个匹配的工具集胜出（优先级高的在前）。
 */
export const TOOLSET_DEFINITIONS: readonly IToolsetDefinition[] = [
	{
		id: 'core',
		label: 'Core',
		priority: ToolsetPriority.Always,
		// ⚠ 不含 `memory_` 前缀（2026-08-22 修，日志 1787363991734）：
		// `getToolsetForTool` 按定义顺序「第一个匹配胜出」，而 core 排最前；
		// 早前 core 的 prefixes 含 `memory_`，会把全部 16 个 memory_* 工具抢先
		// 归入 core（Always + 不可折叠）→ 后面的 `memory` toolset（Medium + deferrable）
		// 形同虚设。后果：58 个 direct-sent 工具里塞满 memory_*，schema 直接发送
		// 浪费 ~3–4k token 却几乎不被调用。移除后 memory_* 归入独立 memory toolset，
		// 可折叠进 tool_search 桥接；`memory_list` 仍由 CORE_TOOLS 白名单兜底不可折叠。
		prefixes: ['file_', 'search_files', 'terminal'],
		exactNames: [
			// ★ 2026-09-21：`plan_register` 与 `switch_paradigm` 已正式退役（随门控一并删除），
			//   从 core 名单移除 —— 留着会让 `getToolsetForTool` 对**不存在的工具名**返回 core。
			'update_plan', 'plan_explore', 'plan_enter', 'plan_exit',
			'patch', 'process',
		'web_search', 'web_extract',
		'skill_manage',
		'session_search', 'execute_code', 'delegate_task',
		'read_skill', 'list_skills',
			// 图示渲染（Mermaid / Draw.io）— core Always 优先级确保 LLM 可调用。
			// ★ 2026-09-11：drawio 与 mermaid 同源 —— 若不在 core 登记，会落进
			// `utility`（Low）而被 focus 模式整条剔除（工具即使有真实 handler，
			// LLM 仍永远看不到；`image_gen` 曾踩同一个坑，见下方 image_gen 注释）。
			'rendermermaiddiagram',
			'renderdrawiodiagram',
			// ★ 2026-09-11：图像分析（vision_analyze）与 image_generate 同为「用户
			// 显式意图」（用户发图/截图后要求解读），不属于按项目信号推荐的代码类
			// 工具集 —— 不登记会落 `utility` 而被 focus 模式整条剔除（同 image_gen
			// 的历史坑；该工具此前正是「有 stub 定义、无 handler」的半成品）。
			'vision_analyze',
			// ★ 2026-09-11：媒体生成（视频 / 语音）—— 同为「用户显式意图」（用户
			// 要求生成视频/配音），与 image_generate 一样需要 Always 豁免；它们此前
			// 也是「有 stub 定义、无 handler」的半成品。
			'video_generate', 'text_to_speech',
			// ★ 2026-09-11：定时任务（cronjob）—— 用户显式要求「每天/每周…」，同属
			// 显式意图，需 Always 豁免（此前也是「有 stub 定义、无 handler」的半成品）。
			'cronjob',
			'clarify', // 2026-07-13: 用户交互核心工具（LLM 向用户提问并等待选择），归入 core 避免被 utility 路径过滤掉
			// ── codebase graph tools: Always priority — 代码检索优先走结构化索引 ──
			'search_graph', 'query_graph', 'trace_path',
			'get_architecture', 'get_graph_schema', 'get_code_snippet',
			'index_repository', 'index_status', 'list_projects',
			'delete_project', 'detect_changes', 'ingest_traces',
			'manage_adr',
			// ★ 2026-09-11 补：同族遗漏的 3 个（都定义在 `codebaseTools.ts`，
			// 与上面同属 codebase graph 家族）—— 此前无任何 toolset 匹配 →
			// 落进 `utility` → focus 模式被整条剔除（与 renderMermaidDiagram /
			// image_gen 落入 utility 的历史坑同源）。
			'check_index_coverage', 'export_artifact', 'import_artifact',
		],
		deferrable: false,
	},
	// ★ 2026-09-11 删除 `mcp-bridge` toolset（死配置）：
	//   它靠 `prefixes: ['mcp_tool_']` 匹配 —— 而该前缀的工具**已不存在**
	//   （桥接早已统一为单套 `tool_search` / `tool_describe` / `tool_call`，
	//   见 toolSearchAssembler 的"统一单套桥接"注释）→ 本 toolset 永不匹配任何工具。
	//   连带影响已同步清理：`CORE_TOOLSET_IDS` 移除该项、`delegationTools` 的子代理
	//   默认 toolset 列表移除该项、`schemaCorrector.test.ts` 的断言移除。
	{
		id: 'mcp',
		label: 'MCP Tools',
		priority: ToolsetPriority.Medium,
		prefixes: ['mcp_'],
		deferrable: true,
	},
	{
		id: 'tool-search',
		label: 'Tool Search',
		priority: ToolsetPriority.Always,
		prefixes: ['tool_search', 'tool_describe', 'tool_call'],
		deferrable: false,
	},
	{
		id: 'workflow',
		label: 'Workflow',
		priority: ToolsetPriority.High,
		prefixes: ['workflow_'],
		// 'workflow'（无下划线）= 动态工作流编排工具（模型写 JS 脚本扇出子代理）
		exactNames: ['workflow'],
		deferrable: false,
	},
	{
		id: 'codebase-grep',
		label: 'Codebase Grep',
		priority: ToolsetPriority.High,
		prefixes: [],
		exactNames: [
			'search_code',
		],
		deferrable: false,
	},
	{
		id: 'delegation',
		label: 'Delegation',
		priority: ToolsetPriority.High,
		prefixes: ['delegate_'],
		exactNames: ['new_agent'],
		deferrable: false,
	},
	{
		id: 'knowledge',
		label: 'Knowledge',
		priority: ToolsetPriority.High,
		prefixes: ['kb_'],
		deferrable: false,
	},
	{
		id: 'memory',
		label: 'Memory',
		priority: ToolsetPriority.Medium,
		prefixes: ['memory_'],
		deferrable: true,
	},
	{
		id: 'skill',
		label: 'Skills',
		priority: ToolsetPriority.Medium,
		prefixes: ['read_skill', 'list_skills', 'skill_'],
		deferrable: true,
	},
	{
		id: 'browser',
		label: 'Browser',
		priority: ToolsetPriority.Medium,
		prefixes: ['browser_'],
		deferrable: true,
	},
	{
		// ★ 2026-09-24：飞书云文档工具族（`feishu_doc_read` + 4 个评论工具，真实 handler
		// 见 browser/providers/tool/feishuDriveTools.ts）。
		//
		// 为什么必须显式定义：不登记就落 `utility`（Low + deferrable）⇒ focus 模式下**直接发
		// 与桥接目录都进不去** —— 这个坑已依次咬过 `unreal_*` / `image_gen` /
		// `renderMermaidDiagram` / `canvas_*`（见本文件另三处历史注释与
		// test/browser/toolRegistrationWiring.test.ts ①）。
		//
		// priority 取 Always 的理由：「用户给了飞书文档链接、要求读文档/看评论」是**显式意图**，
		// 与工作区类型无关（代码工作区里同样会发生），不属于按项目信号推荐的代码类工具集。
		// 该集只有 5 个工具，schema 开销可控；Always 也不占 toolSearchAssembler 的软上限。
		id: 'feishu',
		label: 'Feishu Docs',
		priority: ToolsetPriority.Always,
		prefixes: ['feishu_'],
		deferrable: false,
	},
	{
		id: 'kanban',
		label: 'Kanban',
		priority: ToolsetPriority.Low,
		// ★ 2026-09-11 补 `web_recipe_` 前缀与 `web_scrape_to_board`。
		// 这 4 个工具定义在 `kanbanTools.ts`（`web_scrape_to_board` 的描述即
		// 「automatically create a kanban board populated with the tasks found
		// on that page」），却因不带 `kanban_` 前缀而**无任何 toolset 匹配**
		// → 落进 `utility`（归类错误：UI 分组与 tool_search scope 过滤都不对）。
		prefixes: ['kanban_', 'web_recipe_'],
		exactNames: ['web_scrape_to_board'],
		deferrable: true,
	},
	{
		id: 'canvas',
		label: 'Canvas',
		priority: ToolsetPriority.Low,
		// ★ 2026-09-11 补 `canvas_` 前缀。此前只有 `mindmap_` —— toolset 名为
		// canvas 却匹配不到任何 `canvas_*` 工具（7 个：apply_ops / generate /
		// get_task_status / get_state / reverse_prompt / undo / redo），它们
		// 全部落进 `utility`。canvas 与 mindmap 同族（画布功能由 mindmap 演进
		// 而来，两者都要求「workflow 画布已打开」）。
		prefixes: ['mindmap_', 'canvas_'],
		deferrable: true,
	},
	{
		// ★ 2026-09-21：Unreal Engine 工具集（`unreal_*`，7 个）。
		//
		// **事故背景（用户报「打出的版本中找不到 unreal_* 工具」）**：`unrealTools.ts` 早已实现并在
		// `builtinToolProvider._registerUnrealTools()` 无条件注册（2026-09-20 接线），但**本表从未登记
		// `unreal_`** ⇒ `getToolsetForTool` 兜底归入 `utility`（Low + deferrable）⇒ 被 focus 模式
		// 收窄整条剔除（Step3a 只保留「推荐 toolset / 桥接 / core / Always」）⇒ **LLM 与 tool_search
		// 均不可见**（日志实证：`tool_describe "unreal_exec" → Error: Tool not found`）。
		// 这与 `image_gen` / `renderMermaidDiagram` / `canvas_*` 落 utility 的历史坑**完全同型**。
		//
		// priority 取 Always 的理由（同 image_gen）：Unreal 工具是**用户显式意图**（在 Unreal 项目里
		// 让 LLM 驱动编辑器），不属于「按项目信号推荐的代码类工具集」——`focusMode.CODE_PROJECT_MARKERS`
		// 虽已声明 `*.uproject` / `*.uplugin` 信号，但 `detectFocusModeWithProbe` 当前**只取信号、
		// 不消费 per-marker 的 toolsets**（那份数据是死的）⇒ 挂在 focus 推荐上不可靠；且 Always 可不
		// 受限地进入可见集（`toolSearchAssembler` 的 `MAX_VISIBLE_TOOLS` 软上限**不计数 Always**）。
		// 代价：7 个 schema 常驻（仅前缀匹配，不与 core 名冲突）。
		id: 'unreal',
		label: 'Unreal Engine',
		priority: ToolsetPriority.Always,
		prefixes: ['unreal_'],
		deferrable: false,
	},
	{
		id: 'utility',
		label: 'Utility',
		priority: ToolsetPriority.Low,
		prefixes: [],
		deferrable: true,
	},
	{
		// ★ 2026-09-10：图片生成工具集。
		//
		// 必须显式定义，否则 `getToolsetForTool('image_generate')` 无匹配 →
		// 落进 `utility`（Low）→ 被 focus 模式过滤整条剔除（Step3a 只保留
		// 「推荐 toolset / 桥接 / core / Always」）→ 工具虽注册真实 handler，
		// LLM 仍永远看不到（与 renderMermaidDiagram 落入 utility 的历史坑同源）。
		//
		// priority 取 Always 的理由：图片生成是用户在聊天框**显式选定图片模型**后的
		// 直接意图，不属于「按项目信号推荐的代码类工具集」——focus 推荐列表天然
		// 不会包含它，只能靠 Always 豁免。该集仅 1 个工具，schema 开销可忽略。
		id: 'image_gen',
		label: 'Image Generation',
		priority: ToolsetPriority.Always,
		prefixes: [],
		exactNames: ['image_generate'],
		deferrable: false,
	},
	{
		// ★ 2026-09-24：视频工具集（`extract_video_frames` 抽帧 / `video_analyze` 视频理解）。
		//
		// 为什么必须显式定义：同 `image_gen` / `unreal` —— 不登记就落 `utility`（Low + deferrable），
		// 被 focus 模式整条剔除 ⇒ 工具**注册了但 LLM 永远看不到**（且零报错）。
		//
		// priority 取 Always 的理由：「用户给了视频、要求看画面/分析」是**显式意图**，
		// 不属于按项目信号推荐的代码类工具集 ⇒ 只能靠 Always 豁免；且 Always 不占
		// `toolSearchAssembler.MAX_VISIBLE_TOOLS` 软上限。该集仅 2 个工具，schema 开销可忽略。
		//
		// ★ 2026-09-24（续）：`video_analyze` 的**真 handler 已实现**（此前是 stub ⇒ 被
		//   `isStub` 跳过 ⇒ 模型看不到）。实现后必须登记在这里，否则它会落到 `utility` 被
		//   focus 模式剔除 —— 即「工具注册了但模型永远看不到」的复发。
		id: 'video_frames',
		label: 'Video Frames & Analysis',
		priority: ToolsetPriority.Always,
		prefixes: [],
		exactNames: ['extract_video_frames', 'video_analyze'],
		deferrable: false,
	},
];

// ─── 工具名 → toolset 推断 ──────────────────────────────────────────────

const _toolsetCache = new Map<string, string>();

/**
 * 根据工具名推断其所属 toolset。
 * 按优先级顺序匹配 prefixes 和 exactNames，第一个匹配的胜出。
 */
export function getToolsetForTool(toolName: string): string {
	const cached = _toolsetCache.get(toolName);
	if (cached !== undefined) {
		return cached;
	}

	// exactNames 统一以小写登记（如 `rendermermaiddiagram`），而工具注册名可能是
	// 驼峰（如 `renderMermaidDiagram`）。此处做大小写不敏感比较，避免驼峰名
	// 匹配失败后落入默认 `utility` toolset —— utility 不在 focus 模式白名单内，
	// 会导致该工具被整条过滤出工具集，LLM 与 tool_search 均不可见。
	const lowerName = toolName.toLowerCase();
	for (const ts of TOOLSET_DEFINITIONS) {
		if (ts.exactNames?.some(n => n.toLowerCase() === lowerName)) {
			_toolsetCache.set(toolName, ts.id);
			return ts.id;
		}
		for (const prefix of ts.prefixes) {
			if (toolName.startsWith(prefix)) {
				_toolsetCache.set(toolName, ts.id);
				return ts.id;
			}
		}
	}

	// 默认归入 utility
	_toolsetCache.set(toolName, 'utility');
	return 'utility';
}

/**
 * 获取 toolset 的优先级。
 * 动态 toolsets 以 `mcp-` 开头自动识别为 Medium 优先级。
 */
export function getToolsetPriority(toolsetId: string): ToolsetPriority {
	const ts = TOOLSET_DEFINITIONS.find(t => t.id === toolsetId);
	if (ts) { return ts.priority; }
	// 动态 toolset：mcp-{server} → Medium（对齐 Hermes-Agent mcp-{server} 模式）
	if (toolsetId.startsWith('mcp-')) { return ToolsetPriority.Medium; }
	return ToolsetPriority.Low;
}

/**
 * 判断 toolset 是否可折叠为桥接工具。
 * 动态 toolsets 以 `mcp-` 开头自动识别为 deferrable。
 */
export function isToolsetDeferrable(toolsetId: string): boolean {
	const ts = TOOLSET_DEFINITIONS.find(t => t.id === toolsetId);
	if (ts) { return ts.deferrable; }
	// 动态 toolset：mcp-{server} → deferrable
	if (toolsetId.startsWith('mcp-')) { return true; }
	return true;
}

/**
 * 判断 toolset 是否为动态 toolset（非静态定义，运行时自动创建）。
 * 当前仅 `mcp-{server}` 为动态 toolset。
 */
export function isDynamicToolset(toolsetId: string): boolean {
	return toolsetId.startsWith('mcp-');
}

/**
 * 允许落 `utility` 兜底桶的白名单 —— 生产侧（`builtinToolProvider` 注册收尾的归类自检 warn）
 * 与测试侧（`test/browser/toolRegistrationWiring.test.ts` 的 ①）**共用同一份**，防两处漂移。
 *
 * 唯一成员 `transfer_to_agent`：supervisor 交接工具（handoffTools.ts），**显式**标
 * `toolset: 'utility'` —— 设计意图是「只在多代理 graph 运行时被 runtime 拦截」
 * （直发无意义，handler 对直接调用报错）。
 *
 * 新加白名单项之前，必须先回答：「它为什么不该被 focus 模式下的用户直接看到？」
 * —— 答不上来就给它登记一个真正的 toolset（unreal_* 事故的教训）。
 */
export const UTILITY_BUCKET_WHITELIST: ReadonlySet<string> = new Set(['transfer_to_agent']);

// ─── 默认启用的 toolset ─────────────────────────────────────────────────
// ★ 2026-09-11 删除 `DEFAULT_ENABLED_TOOLSETS`（死代码 + 误导）：
//   全仓**零消费**（含 extensions/webview），且其注释声称的语义
//   （「Agent 未配置 enabledToolsets 时使用」）与实际实现**不符** ——
//   `agentToolAssembly` 在 `agentToolsets` 为空时走的是 **focus 模式**
//   （Step 3a，见 `focusMode.ts` 的 `CODING_FOCUS_TOOLSETS`），并非使用该列表。
//   保留它只会让后人以为「未配置时存在一份默认 toolset 清单」。

// ─── 桥接工具名称 ────────────────────────────────────────────────────────

/** Tool Search 桥接工具名称 */
export const TOOL_SEARCH_BRIDGE_TOOLS = {
	search: 'tool_search',
	describe: 'tool_describe',
	call: 'tool_call',
} as const;

/** 判断工具名是否为桥接工具 */
export function isBridgeTool(toolName: string): boolean {
	return toolName === TOOL_SEARCH_BRIDGE_TOOLS.search
		|| toolName === TOOL_SEARCH_BRIDGE_TOOLS.describe
		|| toolName === TOOL_SEARCH_BRIDGE_TOOLS.call;
}

// ─── 核心工具白名单（双重保护，对齐 Hermes `toolsets._HERMES_CORE_TOOLS`）──
//
// 设计：核心工具的"双重保护"机制 — 即使 toolset 标记为 deferrable=true，
// 核心工具名也会在 `isCoreTool()` 检查中返回 true，从而强制不被延迟。
//
// 实际场景：MCP 工具可能注册到与核心工具同名/类似名的 key，
// 但核心工具必须永远直接发送给 LLM（对齐 Hermes `tool_search.py:163-186`）。

/** 核心工具白名单 — 永远直接发送给 LLM，永不延迟（对齐 Hermes `_HERMES_CORE_TOOLS`） */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
	// 文件操作 — 任何 Agent 的基础
	'file_read', 'file_write', 'file_edit', 'file_delete',
	'file_read', 'write_file', 'patch', 'search_files',
	'read_dir', 'list_files',
	// 终端 / 进程 — 关键调试能力
	'terminal', 'process', 'read_terminal', 'close_terminal',
	// 记忆 / 任务规划
	'memory_list',
	'update_plan',
	// 搜索 / 提取
	'web_search', 'web_extract',
	// Session 搜索
	'session_search',
	// 技能调用 — 任何 Agent 都需要
	'skill_manage',
	'read_skill', 'list_skills',
	// 图示渲染 — 图表渲染（Mermaid / Draw.io，二者同源，2026-09-11 补齐 drawio）
	'rendermermaiddiagram',
	'renderdrawiodiagram',
	// 图像分析 / 媒体生成 / 定时任务（2026-09-11 补：与 image_generate 同为用户显式意图，需 Always 豁免）
	'vision_analyze', 'video_generate', 'text_to_speech', 'cronjob',
	// 浏览器（2026-09-24 P1-2 起为**真实实现**：CDP 驱动用户本机真实 Chrome，
	// 见 browser/providers/tool/browserTools.ts）。
	// 旧注释「用于 LLM 看到浏览器工具但实际被沙箱限制时仍可调用基础导航」是**失真的** ——
	// 这些名字长期只有 stub（`isStub` 被 `listTools` 跳过），模型从未看到过它们。
	'browser_navigate', 'browser_snapshot', 'browser_click',
	'browser_type', 'browser_scroll', 'browser_back',
	// ★ 2026-09-24 补第 7 个：`browser_get_images`（页面图片清单）。
	//   它一直是 reserved stub，而"图文帖的正文在图片里"（小红书尤甚）恰恰需要它 ——
	//   `browser_snapshot` 只采集可交互元素/标题/正文摘录，拿不到任何图片 URL ⇒ 模型
	//   既看不到图、也无法 `vision_analyze`（后者需要一个 URL）。
	'browser_get_images',
	// 委派 / 代码执行
	'delegate_task', 'new_agent', 'execute_code',
	// 工具搜索桥接工具 — 本身就不能被延迟
	TOOL_SEARCH_BRIDGE_TOOLS.search,
	TOOL_SEARCH_BRIDGE_TOOLS.describe,
	TOOL_SEARCH_BRIDGE_TOOLS.call,
]);

/** 核心工具的 toolset 集合（用于批量检查） */
export const CORE_TOOLSET_IDS: ReadonlySet<string> = new Set([
	'core', 'tool-search',
]);

/**
 * 判断工具是否为核心工具（双重保护第一层）。
 * 对齐 Hermes `is_deferrable_tool_name` 中的 `_core_tool_names()` 检查。
 *
 * 即使 toolset 标记为 deferrable=true，核心工具也强制返回 true。
 */
export function isCoreTool(toolName: string): boolean {
	// 大小写不敏感匹配：CORE_TOOLS 白名单统一以小写存储，而工具的实际注册名
	// 可能是驼峰（如 `renderMermaidDiagram`）。若严格精确匹配，驼峰名会漏掉
	// 保护，进而在 focus 模式下被整条过滤出工具集。
	if (CORE_TOOLS.has(toolName)) { return true; }
	const lower = toolName.toLowerCase();
	return lower !== toolName && CORE_TOOLS.has(lower);
}

/**
 * 判断 toolset 是否为受保护的核心 toolset（双重保护第二层）。
 * 对齐 Hermes `_HERMES_CORE_TOOLS` 整体保护机制。
 */
export function isCoreToolset(toolsetId: string): boolean {
	return CORE_TOOLSET_IDS.has(toolsetId);
}
