/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import "./media/agentChat.css";
import {
	Disposable,
	IDisposable,
	toDisposable } from '../../../base/common/lifecycle.js';
import type { ConfigHtmlCfg } from '../../contrib/agentStudio/common/configHtmlConfig.js';
// ★ 2026-09-23：Channel 绑定页签的「飞书 CLI」契约（common 层，允许被本层依赖；
//   真正的实现由 host 注入回调 —— 见下方 _onGetLarkCliStatus 等 hook 的注释）
import type { IFeishuBotCreationUpdate, IFeishuChatSummary, ILarkCliRunResult, ILarkCliStatus } from '../../contrib/agentStudio/common/larkCli.js';
import { $,
	append,
	clearNode,
	addDisposableListener,
	EventType } from '../../../base/browser/dom.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { MarkdownRenderOptions } from '../../../base/browser/markdownRenderer.js';
import { decideDomTrim,
	describeDensityOverBudget,
	DOM_TRIM_LIMITS,
	withProtectedRange,
	trimScrollCompensation,
} from './domBudgetDecision.js';
import { IAgentChatMessage, IToolCall, IMessagePart, deriveUiMessageParts, IChatAttachment, ISubAgentData, IConfirmationData, IAgentInfo, IProviderInfo, IModelInfo, IImageModelGroup, HeaderPanelType, StreamPhase, IModeOption, IWorktreeItem, IWorkspaceItem, ISessionInfo, IAgentSessionMeta, IContextUsage, ICheckpointInfo, IQueueItem, IQueueItemActionCallback, ISuggestedQuestion, IReferenceItem, ILiveWorkflowAskUser, ILiveWorkflowPickerSelect, ILiveWorkflowNodeInteraction, ILiveWorkflowExecution, ILiveWorkflowEvent, ILiveWorkflowSubAgent, ILiveCollectVariable, ITodoItem, ITipMessage, IProgressMessage, IPlanTaskCard, OrchestrationPlan, PlanTask, AgentStatus, coalesceAdjacentTextParts } from './agentChatTypes.js';
// ChatMode removed — replaced by chatOnly boolean toggle
import type { IChatPanel } from './iChatPanel.js';
import { TabbedPanelManager } from './modules/tabbedPanel.js';
import { ScrollbarController, type IScrollbarHost } from './scrollbarController.js';
import { StreamingRenderScheduler } from './streamingRenderScheduler.js';
import { decidePinScrollTop, needsPinPass } from './streamPinDecision.js';
import { markRenderActivity } from '../../../base/common/renderActivityTrace.js';
import { FullRefreshLogger, type FullRefreshSource } from './agentChatPanel.refreshLog.js';









export const MODE_OPTIONS: IModeOption[] = [
	{
		id: 'craft',
		label: 'Craft',
		description: '打造模式 · 完整工具链',
		icon: 'M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.121 2.121 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z',
	},
	{
		id: 'ask',
		label: 'Ask',
		description: '问答模式 · 只读',
		icon: 'M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z',
	},
	{
		id: 'plan',
		label: 'Plan',
		description: '规划模式 · 多步编排',
		icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
	},
];

export const TOOL_BUILTIN_TITLES: Record<string, { done: string; running: string }> = {
	// 2026-09-06：参数流式期的占位卡（网关未下发 function.name 时）——
	// 走内置标题路径，避免「正在调用 生成工具调用…」的拗口拼接。
	pending_args: { done: '工具调用', running: '正在生成工具调用参数…' },
	file_read: { done: '读取文件', running: '正在读取文件' },
	file_write: { done: '写入文件', running: '正在写入文件' },
	file_list: { done: '查看目录', running: '正在查看目录' },
	search_files: { done: '搜索内容', running: '正在搜索内容' },
	patch: { done: '编辑文件', running: '正在编辑文件' },
	terminal: { done: '执行终端命令', running: '正在执行终端命令' },
	process: { done: '管理进程', running: '正在管理进程' },
	http_get: { done: '请求网页', running: '正在请求网页' },
	web_search: { done: '网络搜索', running: '正在网络搜索' },
	web_fetch: { done: '抓取网页', running: '正在抓取网页' },
	recall: { done: '检索记忆', running: '正在检索记忆' },
	memory: { done: '记忆操作', running: '正在记忆操作' },
	read_skill: { done: '读取技能', running: '正在读取技能' },
	list_skills: { done: '列出技能', running: '正在列出技能' },
	skill_manage: { done: '管理技能', running: '正在管理技能' },
	delegate_task: { done: '委派任务', running: '正在委派任务' },
	workflow: { done: '执行工作流', running: '正在执行工作流' },

	clarify: { done: '等待用户选择', running: '正在等待用户选择' },
	memory_remember: { done: '保存记忆', running: '正在保存记忆' },

	memory_list: { done: '列出记忆', running: '正在列出记忆' },
	kanban_create: { done: '创建看板任务', running: '正在创建看板任务' },
	kanban_complete: { done: '完成看板任务', running: '正在完成看板任务' },
	kanban_block: { done: '阻塞任务', running: '正在阻塞任务' },
	kanban_unblock: { done: '解除阻塞', running: '正在解除阻塞' },
	kanban_show: { done: '查看任务详情', running: '正在查看任务' },
	kanban_list: { done: '列出看板任务', running: '正在列出看板任务' },
	kanban_heartbeat: { done: '刷新任务', running: '正在刷新任务' },
	kanban_comment: { done: '评论任务', running: '正在评论任务' },
	kanban_link: { done: '关联任务', running: '正在关联任务' },
	kanban_specify: { done: '指定任务', running: '正在指定任务' },
	kanban_decompose: { done: '分解任务', running: '正在分解任务' },
	kanban_swarm: { done: '群智调度', running: '正在群智调度' },
	workflow_list: { done: '列出工作流', running: '正在列出工作流' },
	workflow_get: { done: '查看工作流', running: '正在查看工作流' },
	workflow_get_schema: { done: '获取工作流结构', running: '正在获取工作流结构' },
	workflow_apply: { done: '应用工作流', running: '正在应用工作流' },
	todo: { done: '更新待办', running: '正在更新待办' },
	update_plan: { done: '更新计划', running: '正在更新计划' },
	execute_code: { done: '执行代码', running: '正在执行代码' },
	session_search: { done: '搜索会话', running: '正在搜索会话' },
	read_file: { done: '读取文件', running: '正在读取文件' },
	read: { done: '读取文件', running: '正在读取文件' },
	ls_dir: { done: '查看目录', running: '正在查看目录' },
	list_files: { done: '查看目录', running: '正在查看目录' },
	get_dir_tree: { done: '查看目录树', running: '正在查看目录树' },
	search_pathnames_only: { done: '按文件名搜索', running: '正在按文件名搜索' },
	search_for_files: { done: '搜索', running: '正在搜索' },
	search_content: { done: '搜索内容', running: '正在搜索内容' },
	search_in_file: { done: '在文件中搜索', running: '正在文件中搜索' },
	grep: { done: '搜索内容', running: '正在搜索内容' },
	create_file_or_folder: { done: '创建', running: '正在创建' },
	delete_file_or_folder: { done: '删除', running: '正在删除' },
	edit_file: { done: '编辑文件', running: '正在编辑文件' },
	edit: { done: '编辑文件', running: '正在编辑文件' },
	replace_in_file: { done: '编辑文件', running: '正在编辑文件' },
	apply_patch: { done: '编辑文件', running: '正在编辑文件' },
	rewrite_file: { done: '写入文件', running: '正在写入文件' },
	write_file: { done: '写入文件', running: '正在写入文件' },
	write: { done: '写入文件', running: '正在写入文件' },
	run_command: { done: '执行终端命令', running: '正在执行终端命令' },
	run_persistent_command: { done: '执行终端命令', running: '正在执行终端命令' },
	run_terminal_cmd: { done: '执行终端命令', running: '正在执行终端命令' },
	open_persistent_terminal: { done: '打开终端', running: '正在打开终端' },
	kill_persistent_terminal: { done: '关闭终端', running: '正在关闭终端' },
	read_lint_errors: { done: '读取诊断', running: '正在读取诊断' },
	// ── Codebase 工具 ──
	search_graph: { done: '搜索知识图谱', running: '正在搜索知识图谱' },
	search_code: { done: '搜索代码', running: '正在搜索代码' },
	get_architecture: { done: '获取架构概览', running: '正在获取架构概览' },
	trace_path: { done: '追踪调用链', running: '正在追踪调用链' },
	query_graph: { done: 'Cypher 查询', running: '正在执行 Cypher 查询' },
	index_repository: { done: '索引代码库', running: '正在索引代码库' },
	get_code_snippet: { done: '获取代码片段', running: '正在获取代码片段' },
	get_graph_schema: { done: '获取图结构', running: '正在获取图结构' },
	detect_changes: { done: '检测变更', running: '正在检测变更' },
	list_projects: { done: '列出项目', running: '正在列出项目' },
	delete_project: { done: '删除项目', running: '正在删除项目' },
	index_status: { done: '索引状态', running: '正在查询索引状态' },
	ingest_traces: { done: '摄入 Trace', running: '正在摄入 Trace' },
	manage_adr: { done: '管理 ADR', running: '正在管理 ADR' },
	// ── 计划编排工具 ──
	plan_explore: { done: '任务分析完成', running: '正在任务分析' },
	plan_enter: { done: '进入计划模式', running: '正在进入计划模式' },
	plan_exit: { done: '退出计划模式', running: '正在退出计划模式' },
	// ── 委派工具 ──
	transfer_to_agent: { done: '转移至 Agent', running: '正在转移至 Agent' },
	new_agent: { done: '创建 Agent', running: '正在创建 Agent' },
};

export const TOOL_TERMINAL_TOOLS = new Set(['terminal', 'run_command', 'run_persistent_command', 'run_terminal_cmd', 'process', 'execute_code']);

/** 计划/探索/更新 族（需专用卡片） */
export const TOOL_PLAN_TOOLS = new Set(['plan_explore', 'plan_enter', 'plan_exit', 'update_plan']);

/** 委派/子Agent 族（需专用卡片）。new_agent 是配置型 action，不走委派卡（回退通用工具卡）。 */
export const TOOL_DELEGATE_TOOLS = new Set(['delegate_task', 'transfer_to_agent']);

/** 搜索/查询 族（需列表化结果卡片）。web_search/web_extract 不在此列——已迁移到 TOOL_WEB_TOOLS（专用 Web 卡片）。 */
export const TOOL_SEARCH_TOOLS = new Set(['search_code', 'search_graph', 'query_graph', 'trace_path', 'get_architecture', 'search_files', 'get_code_snippet']);

/** Web 族（web_search 联网搜索 / web_extract 整页抓取）—— 走 agentChatPanel.webCard.ts 专用卡片。
 *  anysearch 不在此列：它经 execute_code 调 CLI，由 dispatcher 按 args 内容识别后同样走 Web 卡片。 */
export const TOOL_WEB_TOOLS = new Set(['web_search', 'web_extract']);

export const TOOL_LIST_TOOLS = new Set(['search_files', 'ls_dir', 'list_files', 'get_dir_tree', 'search_pathnames_only', 'search_for_files', 'search_content', 'search_in_file', 'grep',
	// codebase 搜索类工具
	'search_graph', 'query_graph', 'trace_path', 'get_architecture', 'get_graph_schema', 'get_code_snippet', 'index_repository', 'search_code',
	// 委派/计划类（也可能有大量文本输出，用列表化展示）
	'delegate_task', 'plan_explore', 'web_search', 'web_extract']);

/** 文件读取工具键：仅渲染折叠态紧凑卡片，点击打开编辑器跳转到行 */
export const READ_FILE_KEYS = new Set(['read_file', 'file_read', 'read', 'read_lints']);

export const TOOL_CODEBASE_TOOLS = new Set(['search_graph', 'grep', 'get_architecture', 'trace_path', 'query_graph', 'index_repository', 'get_code_snippet', 'get_graph_schema', 'detect_changes', 'list_projects', 'delete_project', 'index_status', 'ingest_traces', 'manage_adr']);

/** 技能族（read_skill / list_skills 等，需专用卡片） */
export const TOOL_SKILL_TOOLS = new Set(['read_skill', 'list_skills', 'skill_manage']);

/** Mermaid 图示族（renderMermaidDiagram 等，需专用渲染卡片） */
export const TOOL_MERMAID_TOOLS = new Set(['rendermermaiddiagram', 'mermaid_render', 'render_diagram']);

/** Draw.io 图示族（renderDrawioDiagram 等，需专用渲染卡片；mxGraphModel 只读预览） */
export const TOOL_DRAWIO_TOOLS = new Set(['renderDrawioDiagram', 'renderdrawiodiagram', 'drawio_render', 'render_diagram']);

/** Unreal Engine 工具（unreal_*，BunnySeek bridge）。
 *
 * ⚠ 2026-09-21 修（名单与注册脱节的活 bug）：此处曾写 `unreal_run_command / unreal_query /
 * unreal_editor_command / unreal_console_command / unreal_get_actors / unreal_get_asset_info /
 * unreal_screenshot`（8 个），而 `unrealTools.ts` 实际注册的是 health/exec/wait/help/dump/
 * build/find_asset（7 个）——**只有 `unreal_exec` 重合** ⇒ 其余 6 个已注册工具永远拿不到
 * 专用卡片（落到通用卡），而集合里 7 个名字对应的工具**根本不存在**。名单必须与
 * `unrealTools.ts` 的 UNREAL_*_TOOL_NAME 逐一对齐（`unrealToolCard.test.ts` 已钉住）。
 */
export const TOOL_UNREAL_TOOLS = new Set([
	'unreal_health', 'unreal_exec', 'unreal_wait', 'unreal_help',
	'unreal_dump', 'unreal_build', 'unreal_find_asset',
]);

export function _patchNestedMarkdown(source: string): string {
	// 2026-09-11 快速路径：不含 ``` 直接返回。超长媒体 content（单条可达 8MB 的
	// base64 图片文本，见 agentDriverService 的媒体内联）跑 `/```(\w*|.*)(md|…)/`
	// 纯属浪费——`.match` 在 MB 级单行上有明显回溯开销，而这类内容不可能含
	// 嵌套 markdown 围栏。
	if (source.indexOf('```') === -1) {
		return source;
	}
	if (!source.match(/```(\w*|.*)(md|markdown|gfm|github-markdown)/)) {
		return source;
	}
	let nestCount = 0;
	const lines = source.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (nestCount > 0) {
			// 在 markdown 块内
			if (line.startsWith('```')) {
				// 内层 ``` 围栏——只有当它是外层的闭合围栏时才转 ~~~。
				// 启发式：如果剩余行中 ``` 的数量为偶数，说明这个 ``` 是内层的；
				// 为奇数则它是外层闭合。简单做法：遇到裸 ```（无语言标识）就视为
				// 可能的闭合，转 ~~~ 并退出嵌套。
				const header = line.replaceAll('`', '').trim();
				if (!header) {
					nestCount = 0;
					lines[i] = '~~~';
				} else {
					nestCount++;
				}
			}
		} else {
			if (line.startsWith('```')) {
				const header = line.replaceAll('`', '').trim().toLowerCase();
				if (header === 'md' || header === 'markdown' || header === 'gfm' || header === 'github-markdown') {
					nestCount = 1;
					lines[i] = lines[i].replaceAll('`', '~');
				}
			}
		}
	}
	return lines.join('\n');
}

export abstract class AgentChatPanelBase extends Disposable implements IChatPanel, IScrollbarHost {
	// -- DOM refs --

/** host 注入的 logService（渲染层诊断日志需落 renderer.log） */
protected readonly _logService: ILogService;

protected readonly _container: HTMLElement;

protected _messagesContainer!: HTMLElement;

protected _messagesWrapper!: HTMLElement;

protected _textarea!: HTMLElement;

protected _charCounterEl!: HTMLElement;

protected _scrollToBottomBtn!: HTMLElement;

protected _scrollBadge: HTMLElement | null = null;

protected _customScrollbar: HTMLElement | null = null;

protected _scrollbarTrack: HTMLElement | null = null;

protected _scrollbarThumb: HTMLElement | null = null;

	/**
	 * 当前面板所属窗口。在「独立聊天框窗口」（moveEditorToNewWindow 产生的 aux window）
	 * 中，模块作用域里的裸 `window`/`document` 仍指向主窗口，直接用 window.getSelection() 或
	 * document.* 会拿到主窗口的选区/节点，对本窗口 DOM 无效甚至抛跨文档错误。
	 * 因此一律通过元素自身的 ownerDocument 取正确的 window/document。
	 */
	protected get _ownerWindow(): Window | null {
		return this._textarea?.ownerDocument.defaultView ?? null;
	}

	/** 当前面板所属 document（popout 下 != 全局 document）。 */
	protected get _ownerDocument(): Document {
		return this._textarea?.ownerDocument ?? document;
	}

	/**
	 * 创建 HTML 元素——**始终用主窗口 document 创建**（经 dom.$，桌面端解析为主窗口 document）。
	 * 不要在 popout（auxiliary window）里用 `this._ownerDocument.createElement`：
	 * auxiliaryWindowService 会抛出 "Not allowed to create elements in child window
	 * JavaScript context"（aux 窗口 document 的 createElement 被禁用，以保证
	 * `el instanceof HTMLElement` 成立）。主窗口 document 创建的元素可 append 到任何窗口 DOM。
	 */
	protected _createEl<K extends keyof HTMLElementTagNameMap>(tagName: K): HTMLElementTagNameMap[K] {
		return $<HTMLElementTagNameMap[K]>(tagName);
	}

protected _worktreeDropdownOutsideClick: IDisposable | null = null;

protected _modeDropdownOutsideClick: IDisposable | null = null;

protected _chatModelDropdownOutsideClick: IDisposable | null = null;

protected _imageModelDropdownOutsideClick: IDisposable | null = null;

protected _scrollbarPopup: HTMLElement | null = null;

protected _scrollbarPopupPreview: HTMLElement | null = null;



protected _unreadCount = 0;

protected _sendBtn!: HTMLElement;

protected readonly _tabbedPanel: TabbedPanelManager;

protected _messages: IAgentChatMessage[] = [];

protected _onOpenCompressionDetail: ((data: Record<string, unknown>) => void) | null = null;

protected _onOpenMemoryDetail: ((agentId: string, memoryType?: string, contentPreview?: string) => void) | null = null;

protected _onOpenCodebaseDetail: (() => void) | null = null;

protected readonly _toolCallExpandState = new Map<string, boolean>();

/** 子代理区整体的折叠状态（key = `${tc.id}::${sa.id}`），默认展开。 */
protected readonly _subAgentCollapsed = new Set<string>();

/** 结论面板的展开状态（key = `${tc.id}::${sa.id}`），默认 clamp 3 行。 */
protected readonly _conclusionExpanded = new Set<string>();

protected _agent: IAgentInfo | null = null;

/** 标记 setAgent 是否曾成功加载过有效 agent。仅用于判断是否真的"丢失了 agent"，
 * 避免构造期（_render 在 setAgent 之前被调用）误报 console.warn。 */
private _agentLoadedOnce = false;

protected _isSending = false;

/** 全局加载提示药丸（去抖显示 + 不挡交互）。详见 _scheduleLoadingPill / _clearLoadingPill。 */
protected _loadingPillEl: HTMLElement | null = null;
private _loadingPillTimer: number | null = null;
private _loadingPillRemoveTimer: number | null = null;
private static readonly _LOADING_PILL_DEBOUNCE_MS = 300;

/** 「处理中」已耗时秒级刷新定时器（footer 内联版，见 _startProcessingElapsedTicker）。
 *  实际实现在 AgentChatPanelMessages；此处仅持有字段以便在 dispose 时统一清理。 */
protected _processingElapsedTimer: number | null = null;
/** 与 CSS 折叠过渡时长保持一致，动画结束后才把药丸移出 DOM */
private static readonly _LOADING_PILL_COLLAPSE_MS = 200;

protected _showScrollBtn = false;

protected _isAtBottom = true;

protected _isDraggingScrollbar = false;

protected _wasLoading = false;

protected _streamJustEnded = false;

protected _streamJustEndedTimer: number | null = null;


/**
 * 全量刷新记录器（2026-08-22）：整条消息重建 / 整卡重建 / markdown 全量替换
 * 都必须经它上报来源。全量刷新是聊天框抖动的唯一直接来源，而此前
 * `_rebuildMessageElement` 的 7 个调用点共用一条无来源日志、工具卡重建与
 * markdown 全量替换完全无日志 —— 抖动只能靠用户截图反馈。详见 refreshLog 模块。
 */
protected readonly refreshLogger = new FullRefreshLogger();

/**
 * 流式 markdown 渲染调度器（P5a）：统一持有节流定时器与内容基线四元组，
 * 替代原 _streamingMdTimer/_streamingMdTarget/_streamingMdLastContent/_streamingMdLastRendered
 * 散字段。hooks 运行时 dispatch 到 markdown 层的 override 实现（base 为 throw stub）。
 */
protected _mdScheduler: StreamingRenderScheduler | null = null;

protected get mdScheduler(): StreamingRenderScheduler {
	if (!this._mdScheduler) {
		this._mdScheduler = new StreamingRenderScheduler({
			renderFull: (c, t) => this._renderMarkdownContent(c, t, true),
			renderIncremental: (c, t) => this._tryIncrementalMarkdownRender(c, t),
			resetIncremental: (c) => this._resetIncrementalMd(c),
			// 增量渲染失败 → 整个 markdown 子树被 replaceChildren 替换（内容闪烁）
			onFullReplace: (_c, n) => this.refreshLogger.record('md:incremental-failed', { contentLen: n, note: 'content-md' }),
		}, AgentChatPanelBase.STREAMING_MD_INTERVAL);
	}
	return this._mdScheduler;
}

/**
 * thinking 卡片 body 的独立渲染调度器（P-T1）：与 content 的 mdScheduler 分离——
 * 两者可能同帧调度（thinking + text 交替），单 target 调度器会互相覆盖。
 */
protected _thinkingMdScheduler: StreamingRenderScheduler | null = null;

protected get thinkingMdScheduler(): StreamingRenderScheduler {
	if (!this._thinkingMdScheduler) {
		this._thinkingMdScheduler = new StreamingRenderScheduler({
			renderFull: (c, t) => this._renderMarkdownContent(c, t, true),
			renderIncremental: (c, t) => this._tryIncrementalMarkdownRender(c, t),
			resetIncremental: (c) => this._resetIncrementalMd(c),
			// note 区分两个 scheduler —— 定位「是正文还是思考卡在闪」
			onFullReplace: (_c, n) => this.refreshLogger.record('md:incremental-failed', { contentLen: n, note: 'thinking-md' }),
		}, AgentChatPanelBase.STREAMING_MD_INTERVAL,
			// thinking 流式增长时 body 滚动条保持吸底；用户上滚则解除（_attachStreamCardPin）
			(c) => this._pinStreamCardToBottom(c));
	}
	return this._thinkingMdScheduler;
}

/** thinking 卡片折叠状态记忆（P-T2）：msgId → collapsed。rebuild 后保留用户选择。 */
protected readonly _thinkingCardState = new Map<string, boolean>();

/** 卡内容器流式钉底状态（WeakMap：元素 GC 自动清理）。
 *  pinned=false 表示用户上滚解除；lastUserTop 记录用户最后的滚动位置，
 *  用于全量替换（replaceChildren 物理归零 scrollTop）后恢复；
 *  lastUserScrollAt 记录用户最近一次「向上滚动（拖拽/滚轮）」的时间戳，
 *  用于在宽限期内抑制程序化强制置底，避免高频钉底调用与拖拽争抢滚动位置。 */
protected readonly _streamCardPinState = new WeakMap<HTMLElement, { pinned: boolean; lastUserTop: number; lastUserScrollAt: number }>();

	/**
	 * 标记「刚发生过程序化 scrollTop 写入」的容器（2026-09-13）。
	 *
	 * 用途：写入 scrollTop 会异步派发 scroll 事件，而 `_attachStreamCardPin` 的监听器
	 * 会把「向下滚动但未到底 / 位置变小」判定为**用户操作**并解除 pinned。恢复滚动位置
	 * （写回重建前的旧 top）正是这种写入 —— 若被误判，容器将永久失去钉底能力，
	 * 表现为 delegate 卡片滚动条停在顶部、必须手动拖到底。
	 */
	protected readonly _suppressPinScrollEvent = new WeakSet<HTMLElement>();

/** 给卡内滚动容器挂载流式钉底（幂等）：渲染更新后自动置底；
 *  用户滚动离开底部则解除钉底（之后可自由拖拽），滚回底部恢复跟随。
 *  scroll 事件覆盖滚轮/拖动/键盘；pinned 纯由「是否贴近底部」驱动，
 *  用户上滚即解除并记录时间戳，使后续帧暂缓强制置底，彻底解决
 *  「钉底高频调用吞掉拖拽 scroll 事件 → 滚动条拖不动」的问题。 */
protected _attachStreamCardPin(container: HTMLElement): void {
	if (this._streamCardPinState.has(container)) { return; }
	const state = { pinned: true, lastUserTop: container.scrollTop, lastUserScrollAt: 0 };
	this._streamCardPinState.set(container, state);
	container.addEventListener('scroll', () => {
		const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
		// 贴近底部（<8px）→ 重新钉底跟随流式增长
		if (distFromBottom < 8) {
			state.pinned = true;
		} else if (container.scrollTop < state.lastUserTop) {
			// 用户向上滚动（滚轮/拖拽）：解除钉底并打时间戳，使后续帧暂缓强制置底，
			// 把滚动位置交还给用户，避免与高频钉底调用争抢导致「拖不动」。
			state.pinned = false;
			state.lastUserScrollAt = Date.now();
		} else if (this._suppressPinScrollEvent.has(container)) {
			// ★ 2026-09-13：程序化写入 scrollTop 引发的事件（恢复位置/钉底）——
			//   不能当作「用户滚动」处理。否则「恢复到旧位置(0)」这一写会走下面的
			//   else 分支把 pinned 置 false，容器此后永久失去钉底能力：
			//   delegate 卡片滚动条因此停在顶部，必须手动拖到底。
			//   这里只更新基线，不改变 pinned 语义（由写入方决定）。
		} else {
			// 向下滚动但未到底：保持解除，避免半路被钉回底部
			state.pinned = false;
		}
		state.lastUserTop = container.scrollTop;
	}, { passive: true });
}

/** 标记「本次 scrollTop 写入是程序化的，其 scroll 事件不应改变 pinned」。 */
protected _markProgrammaticPinWrite(container: HTMLElement): void {
	this._suppressPinScrollEvent.add(container);
	// scroll 事件是异步派发的（下一任务），必须跨帧保留标记；用微任务清空即可，
	// 因为同一帧内的多次写入同属一次程序化操作。
	queueMicrotask(() => { this._suppressPinScrollEvent.delete(container); });
}

/** 渲染后回调（thinkingMdScheduler 的 afterRender）：pinned → 滚到底跟随；
 *  非 pinned → 尊重用户滚动位置（自由拖拽），仅在「全量替换导致 scrollTop 大幅归零」
 *  （>50px 跳变，区别于正常拖拽的小步增量）时恢复到 lastUserTop，避免失位。
 *
 *  阈值判据统一委托 `streamPinDecision.decidePinScrollTop`（与批量钉底同一真源，
 *  避免两处各写一套 8px/200ms/50px 而后续改动只改一处）。 */
protected _pinStreamCardToBottom(container: HTMLElement): void {
	// 兜底自动挂载（2026-07-28 修复思考卡片滚动条不置底）：
	// _pinAllScrollableBodiesToBottom 对「未溢出」的容器跳过 attach（continue），
	// 导致容器首次未溢出时 _streamCardPinState 无状态。若此时调度器 afterRender 调到此，
	// 旧逻辑 !state 早退不置底；随后全量替换 replaceChildren 把 scrollTop 物理归零，
	// scroll 事件把 pinned 误判为 false——之后彻底不再置底。这里未挂载则先挂载（pinned
	// 初始 true），确保 afterRender 总能置底、并保持 scrollHeight 一致避免误判。
	if (!this._streamCardPinState.has(container)) {
		this._attachStreamCardPin(container);
	}
	const state = this._streamCardPinState.get(container);
	if (!state) { return; }
	const top = decidePinScrollTop(
		{ scrollHeight: container.scrollHeight, clientHeight: container.clientHeight, scrollTop: container.scrollTop },
		state,
		Date.now(),
	);
	if (top !== undefined) {
		// 程序化写入：标记后其 scroll 事件不会被误判为「用户上滚」而解除 pinned
		this._markProgrammaticPinWrite(container);
		container.scrollTop = top;
	}
}

/**
 * 批量钉底的「上帧 scrollHeight」缓存。
 *
 * 用途见 {@link needsPinPass}：内容高度没变说明本帧该卡没有新增内容，连 scrollTop
 * 都不必写 —— 不写就不会使布局失效，也就不会让后续元素的度量读取触发强制重排。
 * WeakMap：元素被移除后自动回收。
 */
private readonly _pinLastScrollHeight = new WeakMap<HTMLElement, number>();

/**
 * 统一钉底：找到容器内所有可滚动卡片体，对已钉底的执行置底跟随。
 * 覆盖 thinking body / tool body / sub-agent trace-list / sa-body / write-file-stream 等。
 * 在 _reconcileParts 后处理、_updateToolCardStatuses 等路径调用，
 * 确保所有卡片内容流式增长时内部滚动条自动贴底。
 *
 * ★ 2026-08-21（日志 1787323320262「后期输出抖动严重」）：原实现是
 * 「读 scrollHeight → 写 scrollTop → 读下一个」的交错循环，即 **layout thrashing** ——
 * 每次写都使布局失效，下一次读就强制同步重排。元素数 = 工具卡数，实测单条消息涨到
 * 81 个工具卡 → 每帧约 81 次强制重排，且开销随消息增长线性上升（= 后期越来越抖）。
 *
 * 现改为**读写分相**：
 *   相①（只读）遍历采集度量 + 算出待写值，全程不碰任何写操作；
 *   相②（只写）统一提交 scrollTop。
 * N 次强制重排降为最多 1 次。叠加「未增长即跳过」，干净帧的写入数为 0。
 */
protected _pinAllScrollableBodiesToBottom(container: HTMLElement): void {
	const scrollables = container.querySelectorAll(
		'.thinking-card-body, .tool-header-children, .trace-list, .sa-body, .write-file-stream, .conclusion-box, .done-stats, .delegate-scroll'
	) as NodeListOf<HTMLElement>;
	if (scrollables.length === 0) { return; }

	// ── 相①：只读。绝不在此写入任何布局相关属性，否则下一次读会强制重排。 ──
	const now = Date.now();
	const pendingWrites: { el: HTMLElement; top: number }[] = [];
	for (const el of scrollables) {
		const scrollHeight = el.scrollHeight;
		const clientHeight = el.clientHeight;
		if (!needsPinPass({ scrollHeight, clientHeight }, this._pinLastScrollHeight.get(el))) { continue; }
		this._pinLastScrollHeight.set(el, scrollHeight);
		// attach 只读 scrollTop + 注册监听，不写布局属性
		this._attachStreamCardPin(el);
		const state = this._streamCardPinState.get(el);
		if (!state) { continue; }
		const top = decidePinScrollTop({ scrollHeight, clientHeight, scrollTop: el.scrollTop }, state, now);
		if (top !== undefined) { pendingWrites.push({ el, top }); }
	}

	// ── 相②：只写。此时已无后续读取，写入不会再引发强制重排。 ──
	for (const w of pendingWrites) {
		// 程序化写入：标记后其 scroll 事件不会被误判为「用户上滚」而解除 pinned
		this._markProgrammaticPinWrite(w.el);
		w.el.scrollTop = w.top;
	}
}

protected static readonly STREAMING_MD_INTERVAL = 100;

protected _streamingUpdateRaf: number | null = null;



protected _lazyLoadObserver: IntersectionObserver | null = null;
// 懒加载剩余可加载的历史消息数（供裁剪时重锚定懒加载）
protected _lazyLoadRemaining = 0;

// ★ 2026-09-24（P1 分帧渲染）：时间片渲染的代次与续片句柄 ✓
//   （背景与不变量见 browser/agentChat/agentChatPanel.renderSlicer.ts 头注 ——
//    真机 LONG_TASK worst=1256ms ⇒ 恢复渲染改时间片；代次每轮 _renderMessages 递增 ⇒ 旧链静默退出 ✓）
protected _renderSliceGen = 0;
protected _renderSliceRaf: number | null = null;

// ── ★★★ 2026-09-19：DOM 消息窗口（根治「app 卡死」）────────────────────
//
// 背景（真机 ✓）：渲染进程 RSS 涨到 **3.4GB** ✗ 而 JS 堆只有 **600MB** ✓
// ⇒ 大头在 **DOM** 侧 ✓✓。机制（`_setupLazyLoad` ✓）：
//   新块插在 `firstEl` **之前** ✗ ⇒ `firstEl` 被不断下推却仍停在视口内 ✗
//   ⇒ IntersectionObserver（`rootMargin: 200px` ✓）**持续触发** ✗ ⇒ 分块加载一路
//   把**整段历史**（真机 1675 条 ✓）全部搬进 DOM ✗；且**全程没有任何卸载** ✗✓
// ⇒ 长会话 = DOM 单调增长 ⇒ 主线程被布局/重排拖死（用户表现：卡死 ✓）。
//
// 对策：**保留一个以视口为中心的 DOM 窗口** ✓，超出的从**离视口最远**的一端卸载 ✓
//  （数据始终留在 `_messages` ✓，滚回去按需重建 ✓）；
//  卸载由既有 `_domDisposalObserver` 自动释放 `_markdownDisposables` ✓（设施现成 ✓）。
/**
 * 阈值**单点定义在 `domBudgetDecision.ts`**（纯模块，可单测）——
 * 这里只做别名，避免「面板里一份、判据里一份」漂移 ✗。
 *
 * ⚠ 2026-09-19 卡死取证后的判据升级：**只看条数不够** —— 真机 117 条消息就 12.1 万节点
 * （均值 ≈1000 节点/条：长代码块 + 工具卡 + 高亮 span）⇒ 条数上限 120 永不触发 ✗。
 * 现在同时看**页面节点预算**（见 `decideDomTrim`）。
 */
protected static readonly DOM_MESSAGE_LIMIT = DOM_TRIM_LIMITS.messageLimit;
/** 视口上下各保留的缓冲条数（防止轻微滚动就反复重建 ✓）。 */
protected static readonly DOM_MESSAGE_KEEP = DOM_TRIM_LIMITS.messageKeep;
/**
 * 「DOM 节点预算」周期体检间隔（ms）。
 *
 * 裁剪原本只在「新增消息 / 懒加载插入 / 跳转」时安排 ✗ —— 而冻结发生在**流式过程**中
 * （每次 delta 全量重写气泡，节点数一路爬升，上述触发点一次都不来）⇒ 必须有独立体检。
 */
private static readonly DOM_BUDGET_CHECK_INTERVAL_MS = 8000;
/** 周期体检定时器句柄（流式期开启、空闲即停 ✓）。 */
private _domBudgetWatchTimer: number | null = null;
private _trimScheduled = false;
	// 集中式 detached-DOM 资源释放观察器（在 _renderMessagesArea 中 setup）。
	// 任何消息/part 子树被移除时，释放其 _markdownDisposables，避免 detached 子树被
	// map 引用而无法 GC（7G 内存泄漏的根因：keyed-reconcile 删残留、全量重建、setMessages 清空）。
	protected _domDisposalObserver: MutationObserver | null = null;

	// ── ScrollbarController host contract (IScrollbarHost) ──
	protected readonly _scrollbar: ScrollbarController;

	get isSending(): boolean { return this._isSending; }
	get isDraggingScrollbar(): boolean { return this._isDraggingScrollbar; }
	get streamJustEnded(): boolean { return this._streamJustEnded; }
	get unreadCount(): number { return this._unreadCount; }
	get isAtBottom(): boolean { return this._isAtBottom; }
	set isAtBottom(v: boolean) { this._isAtBottom = v; }
	get showScrollBtn(): boolean { return this._showScrollBtn; }
	set showScrollBtn(v: boolean) { this._showScrollBtn = v; }
	get wasLoading(): boolean { return this._wasLoading; }
	set wasLoading(v: boolean) { this._wasLoading = v; }
	get messages(): readonly IAgentChatMessage[] { return this._messages; }
	get messagesContainer(): HTMLElement | undefined { return this._messagesContainer; }
	get customScrollbar(): HTMLElement | null { return this._customScrollbar; }
	get scrollbarThumb(): HTMLElement | null { return this._scrollbarThumb; }
	get scrollbarTrack(): HTMLElement | null { return this._scrollbarTrack; }
	get scrollbarPopup(): HTMLElement | null { return this._scrollbarPopup; }
	get scrollbarPopupPreview(): HTMLElement | null { return this._scrollbarPopupPreview; }
	get scrollToBottomBtn(): HTMLElement | null { return this._scrollToBottomBtn; }
	get scrollBadge(): HTMLElement | null { return this._scrollBadge; }
	get onScrollToMessage(): ((messageId: string) => void) | undefined { return this._onScrollToMessage; }
	scrollToMessage(messageId: string): void { this._scrollToMessage(messageId); }

protected _streamPhase: StreamPhase = 'idle';

protected _currentProvider = "";

protected _currentModel = "";

protected _providers: IProviderInfo[] = [];

protected _models: IModelInfo[] = [];

/** 图片模型分组（按 provider 归类，见 IImageModelGroup）。 */
protected _imageModelGroups: IImageModelGroup[] = [];

/** 提示词优化按钮（发送按钮左侧，2026-09-10）。 */
protected _promptOptimizeBtn: HTMLElement | null = null;

/** 提示词优化进行中（防重入 + 按钮 loading 态）。 */
protected _optimizeInFlight = false;

/**
 * 当前图片模型偏好：`''`（未配置）| `provider:<providerId>:<modelId>`。
 * 2026-09-10：去掉「自动」选项 —— 默认未配置，chip 显示占位「图片模型」；
 * 未配置时由下游按默认路由（等价原 auto 语义），不在 UI 暴露。
 */
protected _currentImageModel = '';

protected _activeHeaderPanel: HeaderPanelType = null;

protected _abortController: AbortController | null = null;

protected _inputAreaEl: HTMLElement | null = null;

protected _worktrees: IWorktreeItem[] = [];

protected _selectedWorktreePath = "";

protected _workspaces: IWorkspaceItem[] = [];

protected _selectedWorkspaceId = "";

protected _workspaceTrigger: HTMLElement | null = null;

protected _workspaceDropdownEl: HTMLElement | null = null;

protected _workspaceDropdownOutsideClick: IDisposable | null = null;

protected readonly _onLoadWorkspaces?: () => Promise<ReadonlyArray<IWorkspaceItem>>;

protected readonly _onSelectWorkspace?: (workspaceId: string, workspaceName: string) => void;

protected _chatOnly: boolean = false;

/**
 * 输入框选定的 ChatMode（2026-08-21，替代「干活/纯聊」布尔开关）。
 *
 * 真源是 `sessions/common/agentStudioService.ChatMode`，此处用字面量联合
 * 避免 browser/agentChat 反向依赖 contrib 层（该目录是通用聊天 UI，
 * 不应耦合 agentStudio 内部模块）。
 *
 * 语义（见 chatModeConfig.ts 的 getPermissionMode）：
 *  - craft → AcceptEdits，完整工具
 *  - ask   → Default 权限，只读工具
 *  - plan  → Plan 权限，只读 + **独占 plan_enter/plan_exit/plan_explore**
 *
 * ⚠ 与 `_chatOnly` 并存（正交）：chatMode 是意图档位，chatOnly 是额外只读约束。
 * 保留 `_chatOnly` 是为了不破坏 xtermCliPanel / cliChatEditorPanel 两个 CLI 面板
 * 和 `setChatOnly` 公开 API 的既有行为。
 */
protected _chatMode: 'craft' | 'ask' | 'plan' = 'craft';

protected _sessionInfo: ISessionInfo | null = null;

protected _agentSessions: IAgentSessionMeta[] = [];

protected _contextUsage: IContextUsage | null = null;

protected _streamUsage: { input?: number; output?: number; seen?: boolean } | null = null;

protected _streamTextBuffer: string = '';

protected _streamThinkingBuffer: string = '';

protected _compactedBaseline: number = 0;

protected _checkpoint: ICheckpointInfo | null = null;

protected _checkpoints: ICheckpointInfo[] = [];

protected _attachments: IChatAttachment[] = [];

protected _imageTooltip: HTMLElement | null = null;

protected _fileInput: HTMLInputElement | null = null;

protected _availableAgents: IAgentInfo[] = [];

protected _dropdownOpen = false;

protected _dropdownFilter = "";

protected _agentDropdownEl: HTMLElement | null = null;

protected _agentSearchInput: HTMLInputElement | null = null;

protected _agentDropdownList: HTMLElement | null = null;

protected _agentSelectorTrigger: HTMLElement | null = null;

protected _worktreeDropdownEl: HTMLElement | null = null;

protected _worktreeTrigger: HTMLElement | null = null;

protected _worktreeContextMenuEl: HTMLElement | null = null;
protected _worktreeContextMenuOutsideClick: IDisposable | null = null;

protected _sessionContextMenuEl: HTMLElement | null = null;
protected _sessionContextMenuOutsideClick: IDisposable | null = null;
protected _sessionRenameOverlayDisposables: IDisposable[] | null = null;

protected _sessionId: string | null = null;
protected _sessionName: string | null = null;

protected _msgNavOverlayEl: HTMLElement | null = null;

protected _msgNavTrigger: HTMLElement | null = null;

protected _modeDropdownEl: HTMLElement | null = null;

protected _modeTrigger: HTMLElement | null = null;

protected _modeDropdownTrigger: HTMLElement | null = null;

/** 「对话模型」下拉（2026-09-10 由 Provider + Model 两个下拉合并而来）。
 *  一级 = provider 列表，hover 任一行飞出二级 = 该 provider 的模型列表。 */
protected _chatModelDropdownEl: HTMLElement | null = null;

protected _chatModelTrigger: HTMLElement | null = null;

protected _chatModelDropdownTrigger: HTMLElement | null = null;

/** 「图片模型」下拉（2026-09-10 新增）。一级 = 自动 + 图片 provider，
 *  hover 任一行飞出二级 = 该 provider 的图片模型列表。 */
protected _imageModelDropdownEl: HTMLElement | null = null;

protected _imageModelTrigger: HTMLElement | null = null;

protected _imageModelDropdownTrigger: HTMLElement | null = null;

protected _historyOverlayEl: HTMLElement | null = null;

protected _tabsContainer: HTMLElement | undefined;

protected _resizeMaxH = 120;

protected _userHasAdjustedHeight = false;

protected _slashMenuEl: HTMLElement | null = null;

protected _slashMenuIndex = 0;

/** `/` 斜杠菜单收起后的延迟定时器（用于「先隐藏、后销毁」）。
 *  单例 timer：重复触发时先清旧的，避免多个 pending 定时器竞态。 */
protected _slashMenuTimer: number | null = null;

/** 高度基线估算缓存（key = 输入内容指纹，value = 估算出的目标高度）。
 *  内容未变时直接复用，跳过整段 DOM 测量。 */
protected _baselineEstimateCache: { key: string; value: number } | null = null;

/** 输入框高度刷新用的 rAF 句柄（0 / undefined 表示无 pending 帧）。
 *  合帧节流：同一帧内多次请求只跑一次测量。 */
protected _composerHeightRaf: number = 0;

/** 上一次写入的输入框高度。用于「高度未变则跳过写回」的短路判断。 */
protected _lastComposerHeight = 0;

/** 输入框击键耗时采样缓冲（每 50 条 flush 一次，避免逐次刷屏）。 */
protected _composerDiagSamples: Array<{ total: number; segments: Record<string, number> }> = [];

/** 工作流参数表单面板（点击 workflow chip 弹出）。 */
protected _workflowParamsEl: HTMLElement | null = null;

/** 工作流参数面板的外部点击关闭 disposable。 */
protected _workflowParamsDisposable: IDisposable | null = null;

protected _mentionEl: HTMLElement | null = null;

protected _mentionIndex = 0;

protected _mentionQuery = '';

protected _mentionResults: Array<{ path: string; name: string }> = [];

protected _mentionSearchTimer: number | null = null;

protected _orchestrationPlanEl: HTMLElement | null = null;

protected _isPlanDialogOpen: boolean = false;

protected _activePlan: OrchestrationPlan | null = null;

protected _markdownDisposables = new Map<HTMLElement, IDisposable>();

protected _nodeCollapsedState = new Map<string, boolean>();

protected readonly _onSendMessage: (text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[], workflowTrigger?: { workflowId: string; input?: string; variables?: Record<string, string>; images?: string[] }) => void;

/**
 * 插队立即发送（任务队列项「↑」）：中断当前流后直接把文本发出去。
 * 与 `_onSendMessage` 的区别在于**绕开「LLM 输出中→再次入队」分支** ——
 * 队列项本就只在输出中产生，用 `_onSendMessage` 只会把它删了又新建。
 * 由宿主注入（需要 `cancelStream`，面板层拿不到）。未注入时回退为普通发送。
 */
protected readonly _onInterruptAndSend?: (text: string, attachments?: IChatAttachment[]) => void;

protected readonly _onCancelExecution: () => void;
	/**
	 * 跳过当前工具（terminal 等长命令卡住时用户点击「跳过」）：
	 * 只中止正在执行的工具，不取消整个 turn——agent 拿到中断结果后继续后续步骤。
	 */
	protected readonly _onSkipCurrentTool?: () => void;

	/**
	 * 转后台当前工具（terminal 卡片「转后台」，2026-09-21）：**不中止进程** ✓ ——
	 * 进程留在其真实终端实例里继续跑 + 控制台自动打开 ✓，当前轮立即放行 ✓。
	 * 与「跳过」（杀进程 ✗）互补：转后台 = "这活我还要，只是别挡路" ✓✓。
	 */
	protected readonly _onDetachCurrentTool?: () => void;

protected readonly _onSelectAgent: (id: string) => void;

protected readonly _onSelectWorktree?: (worktree: { path: string; branch: string }) => void;

protected readonly _onClearWorktree?: () => void;

protected readonly _onLoadWorktrees?: () => Promise<ReadonlyArray<IWorktreeItem>>;

protected readonly _onDebugWorktree?: (worktree: { path: string; branch: string }) => void;

protected readonly _onScrollToMessage?: (messageId: string) => void;

protected readonly _onNewSession?: () => void;

protected readonly _onOpenSession?: (sessionId: string) => void;

protected readonly _onRenameSession?: (sessionId: string, newName: string) => void;

protected _getSessionId(): string | null {
	return this._sessionId;
}

protected _getSessionName(): string | null {
	return this._sessionName;
}

protected readonly _onDeleteSession?: (sessionId: string) => void;

protected readonly _onForkSession?: (sessionId: string) => void;

protected readonly _onOpenSettings?: () => void;

	// _onChangeMode removed — replaced by chatOnly toggle (setChatOnly)
	protected readonly _onChangeMode?: undefined;

	protected readonly _onSelectProvider?: (providerId: string) => void;

protected readonly _onSelectModel?: (modelId: string) => void;

	/** 图片模型偏好选择回调（见 IImageModelGroup 注释）。 */
	protected readonly _onSelectImageModel?: (preference: string) => void;

	/** 提示词优化回调（输入框 ✨ 按钮，2026-09-10）。 */
	protected readonly _onOptimizePrompt?: (text: string) => Promise<string | undefined>;

protected readonly _onCheckpointAction?: (action: 'undoAll' | 'keepAll' | 'openDiff' | 'undoConversation' | 'openTimeline', payload?: { filePath?: string; checkpointId?: string }) => void;

protected readonly _onConfirmationAction?: (confirmationId: string, buttonId: string) => void;

protected readonly _onEditMessage?: (messageId: string, newText: string) => void;

protected readonly _onListSkills: () => ReadonlyArray<{ id: string; name: string; description: string; activation?: string; source?: string; version?: string; enabled: boolean; category?: string }>;

protected readonly _onListWorkflows?: () => ReadonlyArray<{ id: string; name: string; description?: string; variables?: ReadonlyArray<{ name: string; defaultValue: string }> }>;

/**
 * 斜杠命令（2026-09-22：`/compact` 等 ✓）：两条都由宿主注入 ✓。
 * ⚠ 列表为**空/缺失 ⇒ 菜单里不出现命令条目** ✗✓（避免"点了没反应"的死条目 ✓）。
 */
protected readonly _onListSlashCommands?: () => ReadonlyArray<{ command: string; label: string; description: string }>;

protected readonly _onRunSlashCommand?: (command: string, arg: string) => void | Promise<void>;

protected readonly _onListMcpServers?: () => ReadonlyArray<{ name: string; status: string; toolCount: number }>;

protected readonly _onOpenMcpSettings?: () => void;

protected readonly _onOpenHtmlPreview?: () => void;

/**
 * 双击聊天里的媒体 → 在中间栏编辑器独立 pane 打开（2026-09-11 用户需求）。
 * 载荷的 `src` 已由 `_mediaSrc` 转成可加载 URL（data: / http(s): / blob: / vscode-file:）。
 */
protected readonly _onOpenMedia?: (payload: { src: string; kind: string; title?: string }) => void;

protected readonly _onGetAgentSkills?: () => string[];

protected readonly _onAddSkill?: (skillId: string) => Promise<void>;

protected readonly _onRemoveSkill?: (skillId: string) => Promise<void>;

protected readonly _onAskUserSubmit?: (askUserId: string, executionId: string, nodeId: string, selection: string | string[] | { __askUserAnswer: 1; labels: string[]; params?: Record<string, string>; multiSelect?: boolean } | { __askUserAnswer: 1; answers: Record<string, unknown> }) => void;

/** ImagePicker 多选提交（2026-09-11）：refs = 选中的媒体引用（作为 resume 值传回执行侧）。 */
protected readonly _onPickerSelectSubmit?: (pickerId: string, executionId: string, nodeId: string, refs: string[]) => void;

/** 节点交互表单提交（2026-09-11 框架）：values = 表单字段值（JSON 序列化后 resume）。 */
protected readonly _onNodeInteractionSubmit?: (interactionId: string, executionId: string, nodeId: string, values: Record<string, unknown>) => void;

protected readonly _onClarifySubmit?: (toolCallId: string, selection: string) => void;

/** ChatMode 下拉框选择回调（2026-08-21）——宿主据此更新 per-turn 的 request.chatMode。 */
protected readonly _onChangeChatMode?: (chatMode: 'craft' | 'ask' | 'plan') => void;

protected readonly _onQuestionClick?: (question: ISuggestedQuestion) => void;

protected readonly _onReferenceClick?: (ref: IReferenceItem) => void;

protected readonly _onTipAction?: (tipId: string, actionId: string) => void;

protected readonly _onTipDismiss?: (tipId: string) => void;

protected readonly _onApplyCode?: (code: string, language: string, filePath?: string) => void;

protected readonly _onSubmitVariables?: (executionId: string, values: Record<string, string>) => void;

protected readonly _onOpenFile?: (filePath: string, contentOrLine?: string | number) => void;

protected readonly _onSearchFiles?: (query: string) => Promise<Array<{ path: string; name: string }>>;

protected readonly _onComposerTextChange?: (text: string) => void;

protected readonly _onAddFileContext?: (filePath: string) => void;

protected readonly _onExecuteCommand?: (commandId: string, ...args: unknown[]) => Promise<unknown>;

protected readonly _onRunInTerminal?: (code: string) => void;

protected readonly _onAddSelectionToChat?: () => void;

protected readonly _onOpenLink?: (url: string) => void;

protected readonly _onToolApprove?: (toolCallId: string, decision: string) => void;

protected readonly _onApprovePlan?: (planId: string) => void;

protected readonly _onRejectPlan?: (planId: string) => void;

protected readonly _onApproveWithoutExecute?: (planId: string) => void;

protected readonly _onTaskAction?: (planId: string, taskId: string, action: 'retry' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' | 'block' | 'unblock') => void;

protected readonly _onUpdatePlan?: (planId: string, updates: Record<string, unknown>) => void;

protected readonly _onUpdateTask?: (planId: string, taskId: string, updates: Record<string, unknown>) => void;

protected readonly _onDecomposeTask?: (planId: string, taskId: string) => void;

protected readonly _onClosePlanDialog?: (planId: string) => void;

protected readonly _onFavoriteMessage?: (messageContent: string) => void;

protected readonly _onImportToKnowledgeBase?: (messageContent: string, messageId: string) => Promise<boolean>;
protected readonly _onImportFileToKnowledgeBase?: (filePath: string, toolId?: string) => Promise<boolean>;
protected readonly _onExtractSkill?: (messageContent: string) => void;

/** Set of message IDs that have been successfully imported to KB. */
protected readonly _importedKbMessageIds = new Set<string>();
/** Set of tool IDs (write_file 卡片) that have been successfully imported to KB. */
protected readonly _importedKbFileToolIds = new Set<string>();

	// ── Channel 绑定（飞书）回调 ──
	protected readonly _onListFeishuBindings?: () => ReadonlyArray<{ conversationId: string; agentId: string }>;
	protected readonly _onAddFeishuBinding?: (chatId: string) => void;
	protected readonly _onRemoveFeishuBinding?: (chatId: string) => void;
	protected readonly _onGetFeishuDefaultAgent?: () => string | undefined;
	protected readonly _onSetFeishuDefaultAgent?: (agentId: string | undefined) => void;
	// ── Channel 会话级绑定（chat_id ↔ 指定会话）回调 ──
	protected readonly _onListAgentSessions?: () => Promise<ReadonlyArray<{ id: string; name: string }>>;
	protected readonly _onListFeishuSessionBindings?: () => ReadonlyArray<{ conversationId: string; agentId: string; agentSessionId: string }>;
	protected readonly _onBindFeishuSession?: (chatId: string, sessionId: string) => void;
	protected readonly _onUnbindFeishuSession?: (chatId: string) => void;
	/** 渠道默认会话（默认 Agent 配套）：未精确绑定的飞书消息进入此会话。 */
	protected readonly _onGetFeishuDefaultSession?: () => string | undefined;
	protected readonly _onSetFeishuDefaultSession?: (sessionId: string | undefined) => void;
	/** 当前会话绑定的飞书 chat_id（host 推送；header 标识用）。 */
	protected _feishuBoundChatId: string | null = null;
	/** 是否为渠道默认会话（区别于 chat_id 精确绑定）。 */
	protected _feishuBindingIsDefault = false;
	/**
	 * 标识里的品牌 logo（host 注入 `createChannelIcon('feishu', …)` 的产物）。
	 *
	 * ★ 2026-09-22：面板在 `sessions/browser` 层，**不能反向依赖** `contrib/agentStudio` 的
	 *   `channelIcons.ts` ⇒ 由 host 建好元素传进来（与设置页渠道条目共用同一份品牌 SVG；
	 *   未注入时徽章退化为纯文字，不会空白）。
	 */
	protected _feishuBindingIcon?: HTMLElement;

	// ── 飞书 CLI（2026-09-23）───────────────────────────────────────────────
	//
	// ★ 为什么是回调而不是直接 import：本面板在 `sessions/browser` 层，**不能反向依赖**
	//   `contrib/agentStudio` 的 browser 实现（`larkCliService.ts` / `feishuChatList.ts` /
	//   `feishuRegistration.ts`）。契约类型放 common 层（`common/larkCli.ts`），
	//   实现由 host（`nativeChatEditorPane.ts`）注入 —— 与 `_onBindFeishuSession` 同一套路。
	// 未注入时该区块只显示「不可用」，不影响其余绑定功能（非 Electron / 无凭证环境）。

	/** CLI 状态探测（是否安装 / 版本 / npm 最新版本）。 */
	protected readonly _onGetLarkCliStatus?: () => Promise<ILarkCliStatus>;
	/** 安装 / 升级（同一条命令；host 在主进程执行）。 */
	protected readonly _onInstallLarkCli?: () => Promise<ILarkCliRunResult>;
	/** 列「机器人所在的群」（host 用渠道凭证查飞书；失败抛错，由面板显示原因）。 */
	protected readonly _onListFeishuChats?: () => Promise<ReadonlyArray<IFeishuChatSummary>>;
	/**
	 * 扫码创建机器人：host 跑完 device-flow 全流程（含二维码 PNG 生成），
	 * 通过 `onUpdate` 持续回推进度；面板只负责显示二维码与状态文案。
	 */
	protected readonly _onCreateFeishuBot?: (onUpdate: (update: IFeishuBotCreationUpdate) => void) => Promise<void>;
	/**
	 * ★ 等待绑定表从磁盘水合完成（2026-09-23）。
	 *
	 * 绑定持久化在**主进程**（IPC 读盘异步），引擎读接口却是同步的 ⇒ 启动后首次渲染
	 * 列表会读到空表；实测磁盘 bindings.json 有数据而列表为空，用户会认为「重启后绑定丢了」。
	 * ⇒ 面板渲染后再 `await` 一次并重绘列表（未注入时跳过，行为与旧版一致）。
	 */
	protected readonly _onEnsureBindingsLoaded?: () => Promise<void>;

	// ── ConfigHtml（URL 面板 / 本地 HTML）回调 ──
	protected readonly _onGetConfigHtmlCfg?: () => Promise<ConfigHtmlCfg | undefined>;
	protected readonly _onSaveConfigHtmlCfg?: (cfg: ConfigHtmlCfg) => Promise<void>;
	protected readonly _onEnsureConfigHtmlServer?: (spec: Record<string, unknown>) => Promise<{ ok: boolean; alreadyRunning?: boolean; starting?: boolean; error?: string }>;
	protected readonly _onStopConfigHtmlServer?: (spec: { url: string; port?: number }) => Promise<{ ok: boolean; killed: number[] }>;
	protected readonly _onOpenConfigHtmlPreview?: (url: string) => Promise<void> | void;

constructor(opts: {
		onSendMessage: (text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[], workflowTrigger?: { workflowId: string; input?: string; variables?: Record<string, string>; images?: string[] }) => void;
		/** 插队立即发送（任务队列「↑」）：中断当前流后直接发送，绕开入队分支。★ 同上需带 attachments ✓ */
		onInterruptAndSend?: (text: string, attachments?: IChatAttachment[]) => void;
		onCancelExecution: () => void;
		onSkipCurrentTool?: () => void;
		/** 转后台当前工具（terminal 卡片「转后台」✓）：进程留着 + 控制台打开 ✓，不杀进程 ✗ */
		onDetachCurrentTool?: () => void;
		/**
		 * 服务层「本会话是否仍有活跃流」查询（入队判定用，见 `_onIsStreamActive`）。
		 * 缺省 = 未接入服务层 ⇒ 只按 UI 状态判定（回退路径，不弱化原有行为）。
		 */
		onIsStreamActive?: () => boolean;
		onToggleCollapse: () => void;
		onSelectAgent: (id: string) => void;
		onSelectWorktree?: (worktree: { path: string; branch: string }) => void;
		onClearWorktree?: () => void;
		onLoadWorktrees?: () => Promise<ReadonlyArray<IWorktreeItem>>;
		onDebugWorktree?: (worktree: { path: string; branch: string }) => void;
		// 工作区选择器（输入区工具栏，位于 worktree 下拉框左侧）
		onLoadWorkspaces?: () => Promise<ReadonlyArray<IWorkspaceItem>>;
		onSelectWorkspace?: (workspaceId: string, workspaceName: string) => void;
		onScrollToMessage?: (messageId: string) => void;
		onNewSession?: () => void;
		onOpenSession?: (sessionId: string) => void;
		onRenameSession?: (sessionId: string, newName: string) => void;
		onDeleteSession?: (sessionId: string) => void;
		onForkSession?: (sessionId: string) => void;
		onOpenSettings?: () => void;
		// onChangeMode removed — ChatMode replaced by chatOnly toggle
		onSelectProvider?: (providerId: string) => void;
		onSelectModel?: (modelId: string) => void;
		/** 「图片模型」选择回调：偏好字符串 `auto` | `provider:<id>`（2026-09-10）。 */
		onSelectImageModel?: (preference: string) => void;
		/** 提示词优化回调（输入框 ✨ 按钮，2026-09-10）。 */
		onOptimizePrompt?: (text: string) => Promise<string | undefined>;
		onCheckpointAction?: (action: 'undoAll' | 'keepAll' | 'openDiff' | 'undoConversation' | 'openTimeline', payload?: { filePath?: string; checkpointId?: string }) => void;
		onConfirmationAction?: (confirmationId: string, buttonId: string) => void;
		onEditMessage?: (messageId: string, newText: string) => void;
		onListSkills: () => ReadonlyArray<{ id: string; name: string; description: string; activation?: string; source?: string; version?: string; enabled: boolean; category?: string }>;
		onListWorkflows?: () => ReadonlyArray<{ id: string; name: string; description?: string; variables?: ReadonlyArray<{ name: string; defaultValue: string }> }>;
		onListMcpServers?: () => ReadonlyArray<{ name: string; status: string; toolCount: number }>;
		onOpenMcpSettings?: () => void;
		onOpenHtmlPreview?: () => void;
		/** 双击聊天里的媒体 → 在中间栏编辑器独立 pane 打开（2026-09-11）。 */
		onOpenMedia?: (payload: { src: string; kind: string; title?: string }) => void;
		onGetAgentSkills?: () => string[];
		onAddSkill?: (skillId: string) => Promise<void>;
		onRemoveSkill?: (skillId: string) => Promise<void>;
		// New callbacks for missing features
		onAskUserSubmit?: (askUserId: string, executionId: string, nodeId: string, selection: string | string[] | { __askUserAnswer: 1; labels: string[]; params?: Record<string, string>; multiSelect?: boolean } | { __askUserAnswer: 1; answers: Record<string, unknown> }) => void;
		/** ImagePicker 多选提交（2026-09-11）：refs 作为 resume 值回传执行侧。 */
		onPickerSelectSubmit?: (pickerId: string, executionId: string, nodeId: string, refs: string[]) => void;
		/** 节点交互表单提交（2026-09-11 框架）：values 序列化后作为 resume 值。 */
		onNodeInteractionSubmit?: (interactionId: string, executionId: string, nodeId: string, values: Record<string, unknown>) => void;
		onClarifySubmit?: (toolCallId: string, selection: string) => void;
		onChangeChatMode?: (chatMode: 'craft' | 'ask' | 'plan') => void;
		onQuestionClick?: (question: ISuggestedQuestion) => void;
		onReferenceClick?: (ref: IReferenceItem) => void;
		onTipAction?: (tipId: string, actionId: string) => void;
		onTipDismiss?: (tipId: string) => void;
		onApplyCode?: (code: string, language: string, filePath?: string) => void;
		onSubmitVariables?: (executionId: string, values: Record<string, string>) => void;
		onOpenFile?: (filePath: string, contentOrLine?: string | number) => void;
	/** P0-2: @提及文件搜索——用户输入 @ 时搜索工作区文件 */
	onSearchFiles?: (query: string) => Promise<Array<{ path: string; name: string }>>;
	/** 输入框文本变更（每次 input 事件触发；消费方自行 debounce）。用于 per-session 草稿持久化。 */
	onComposerTextChange?: (text: string) => void;
	/** P0-2: @提及文件选择后——添加文件作为上下文 */
	onAddFileContext?: (filePath: string) => void;
	/** 通用执行 VS Code 命令回调（用于工具卡片中的特殊按钮，如 Mermaid 预览） */
	onExecuteCommand?: (commandId: string, ...args: unknown[]) => Promise<unknown>;
		/** P1-1: 在终端运行代码（shell 语言代码块） */
		onRunInTerminal?: (code: string) => void;
		/** P1-3: 添加编辑器当前选中的代码作为上下文 */
		onAddSelectionToChat?: () => void;
		/** Click handler for http(s) links in LLM output. Opens the URL in the editor area. */
		onOpenLink?: (url: string) => void;
		/** Tool approval callback (for security-level tool calls) */
		onToolApprove?: (toolCallId: string, decision: string) => void;
		onDecomposeTask?: (planId: string, taskId: string) => void;
		// Orchestration plan callbacks
		onApprovePlan?: (planId: string) => void;
		onRejectPlan?: (planId: string) => void;
		onApproveWithoutExecute?: (planId: string) => void;
		onTaskAction?: (planId: string, taskId: string, action: 'retry' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' | 'block' | 'unblock') => void;
		onUpdatePlan?: (planId: string, updates: Record<string, unknown>) => void;
		onUpdateTask?: (planId: string, taskId: string, updates: Record<string, unknown>) => void;
		onClosePlanDialog?: (planId: string) => void;
		/** 收藏消息到知识库 */
		onFavoriteMessage?: (messageContent: string) => void;
	/** P2: 导入知识库（footer 复制按钮右侧，返回 true 表示导入成功） */
	onImportToKnowledgeBase?: (messageContent: string, messageId: string) => Promise<boolean>;
	/** write_file 工具卡片「导入知识库」：自动执行入口(落盘到库)+抽取(构建笔记)。返回 true 表示成功 */
	onImportFileToKnowledgeBase?: (filePath: string, toolId?: string) => Promise<boolean>;
	/** P2: 沉淀技能（footer 导入知识库按钮右侧） */
	onExtractSkill?: (messageContent: string) => void;
	// ── Channel 绑定（飞书）相关回调（对齐 AgentSettingsEditorPane）──
	onListFeishuBindings?: () => ReadonlyArray<{ conversationId: string; agentId: string }>;
	onAddFeishuBinding?: (chatId: string) => void;
	onRemoveFeishuBinding?: (chatId: string) => void;
	onGetFeishuDefaultAgent?: () => string | undefined;
	onSetFeishuDefaultAgent?: (agentId: string | undefined) => void;
	/** 列出当前 Agent 名下会话（channel 页签绑定表单的 session 下拉用）。 */
	onListAgentSessions?: () => Promise<ReadonlyArray<{ id: string; name: string }>>;
	/** 列出飞书全部 chat_id ↔ 专属会话映射。 */
	onListFeishuSessionBindings?: () => ReadonlyArray<{ conversationId: string; agentId: string; agentSessionId: string }>;
	/** 绑定 chat_id 到当前 Agent 的指定会话。 */
	onBindFeishuSession?: (chatId: string, sessionId: string) => void;
	/** 飞书 CLI（2026-09-23）：状态探测 / 安装升级 / 群列表 / 扫码创建机器人 —— 由 host 注入实现。 */
	onGetLarkCliStatus?: () => Promise<ILarkCliStatus>;
	onInstallLarkCli?: () => Promise<ILarkCliRunResult>;
	onListFeishuChats?: () => Promise<ReadonlyArray<IFeishuChatSummary>>;
	onCreateFeishuBot?: (onUpdate: (update: IFeishuBotCreationUpdate) => void) => Promise<void>;
	/** 等待绑定表水合完成（见 _onEnsureBindingsLoaded 的说明）。 */
	onEnsureBindingsLoaded?: () => Promise<void>;
	/** 解除 chat_id 的专属会话绑定。 */
	onUnbindFeishuSession?: (chatId: string) => void;
	/** 读取渠道默认会话 id（默认 Agent 配套；undefined = 未设置）。 */
	onGetFeishuDefaultSession?: () => string | undefined;
	/** 设置渠道默认会话（undefined = 清除，恢复每群自动建专属会话）。 */
	onSetFeishuDefaultSession?: (sessionId: string | undefined) => void;
	/**
	 * 斜杠命令（2026-09-22：聊天框支持 `/compact` 等 ✓）——
	 * 列表为**空/缺失 ⇒ 菜单不出现命令条目** ✗✓（不给出"点了没反应"的死条目 ✓）。
	 */
	onListSlashCommands?: () => ReadonlyArray<{ command: string; label: string; description: string }>;
	onRunSlashCommand?: (command: string, arg: string) => void | Promise<void>;
	/** 渲染层诊断日志需要落到 renderer.log，故注入 host 的 logService */
	logService: ILogService;
	}) {
		super();
		this._logService = opts.logService;
		this._scrollbar = this._register(new ScrollbarController(this));
		this._onSendMessage = opts.onSendMessage;
		this._onInterruptAndSend = opts.onInterruptAndSend;
		this._onCancelExecution = opts.onCancelExecution;
		this._onSkipCurrentTool = opts.onSkipCurrentTool;
		this._onDetachCurrentTool = opts.onDetachCurrentTool;
		this._onIsStreamActive = opts.onIsStreamActive;
		this._onSelectAgent = opts.onSelectAgent;
		this._onSelectWorktree = opts.onSelectWorktree;
		this._onClearWorktree = opts.onClearWorktree;
		this._onLoadWorktrees = opts.onLoadWorktrees;
		this._onDebugWorktree = opts.onDebugWorktree;
		this._onLoadWorkspaces = opts.onLoadWorkspaces;
		this._onSelectWorkspace = opts.onSelectWorkspace;
		this._onScrollToMessage = opts.onScrollToMessage;
		this._onNewSession = opts.onNewSession;
		this._onOpenSession = opts.onOpenSession;
		this._onRenameSession = opts.onRenameSession;
		this._onDeleteSession = opts.onDeleteSession;
		this._onForkSession = opts.onForkSession;
		this._onOpenSettings = opts.onOpenSettings;
		// _onChangeMode removed — replaced by chatOnly toggle (setChatOnly)
		this._onSelectProvider = opts.onSelectProvider;
		this._onSelectModel = opts.onSelectModel;
		this._onSelectImageModel = opts.onSelectImageModel;
		this._onOptimizePrompt = opts.onOptimizePrompt;
		this._onCheckpointAction = opts.onCheckpointAction;
		this._onConfirmationAction = opts.onConfirmationAction;
		this._onEditMessage = opts.onEditMessage;
		this._onListSkills = opts.onListSkills;
		this._onListWorkflows = opts.onListWorkflows;
		// 斜杠命令（2026-09-22 ✓）：缺失时下方 `_collectSlashItems` 就收集不到命令 ⇒ 菜单无命令条目 ✓
		this._onListSlashCommands = opts.onListSlashCommands;
		this._onRunSlashCommand = opts.onRunSlashCommand;
		this._onListMcpServers = opts.onListMcpServers;
		this._onOpenMcpSettings = opts.onOpenMcpSettings;
		this._onOpenHtmlPreview = opts.onOpenHtmlPreview;
		this._onOpenMedia = opts.onOpenMedia;
		this._onGetAgentSkills = opts.onGetAgentSkills;
		this._onAddSkill = opts.onAddSkill;
		this._onRemoveSkill = opts.onRemoveSkill;
		// New callbacks
		this._onAskUserSubmit = opts.onAskUserSubmit;
		this._onPickerSelectSubmit = opts.onPickerSelectSubmit;
		this._onNodeInteractionSubmit = opts.onNodeInteractionSubmit;
		this._onClarifySubmit = opts.onClarifySubmit;
		this._onChangeChatMode = opts.onChangeChatMode;
		this._onQuestionClick = opts.onQuestionClick;
		this._onReferenceClick = opts.onReferenceClick;
		this._onTipAction = opts.onTipAction;
		this._onTipDismiss = opts.onTipDismiss;
		this._onApplyCode = opts.onApplyCode;
		this._onSubmitVariables = opts.onSubmitVariables;
		this._onOpenFile = opts.onOpenFile;
		this._onSearchFiles = opts.onSearchFiles;
		this._onComposerTextChange = opts.onComposerTextChange;
		this._onAddFileContext = opts.onAddFileContext;
		this._onExecuteCommand = opts.onExecuteCommand;
		this._onRunInTerminal = opts.onRunInTerminal;
		this._onAddSelectionToChat = opts.onAddSelectionToChat;
		this._onOpenLink = opts.onOpenLink;
		this._onOpenFile = opts.onOpenFile;
		this._onToolApprove = opts.onToolApprove;
		// Orchestration plan callbacks
		this._onApprovePlan = opts.onApprovePlan;
		this._onRejectPlan = opts.onRejectPlan;
		this._onApproveWithoutExecute = opts.onApproveWithoutExecute;
		this._onTaskAction = opts.onTaskAction;
		this._onUpdatePlan = opts.onUpdatePlan;
		this._onUpdateTask = opts.onUpdateTask;
		this._onDecomposeTask = opts.onDecomposeTask;
		this._onClosePlanDialog = opts.onClosePlanDialog;
		this._onFavoriteMessage = opts.onFavoriteMessage;
		this._onImportToKnowledgeBase = opts.onImportToKnowledgeBase;
		this._onImportFileToKnowledgeBase = opts.onImportFileToKnowledgeBase;

		this._onExtractSkill = opts.onExtractSkill;
		// Channel 绑定（飞书）回调
		this._onListFeishuBindings = opts.onListFeishuBindings;
		this._onAddFeishuBinding = opts.onAddFeishuBinding;
		this._onRemoveFeishuBinding = opts.onRemoveFeishuBinding;
		this._onGetFeishuDefaultAgent = opts.onGetFeishuDefaultAgent;
		this._onSetFeishuDefaultAgent = opts.onSetFeishuDefaultAgent;
		// Channel 会话级绑定回调
		this._onListAgentSessions = opts.onListAgentSessions;
		this._onListFeishuSessionBindings = opts.onListFeishuSessionBindings;
		this._onBindFeishuSession = opts.onBindFeishuSession;
		// 飞书 CLI（2026-09-23）：未注入时面板显示「不可用」并禁用按钮，其余绑定功能不受影响
		this._onGetLarkCliStatus = opts.onGetLarkCliStatus;
		this._onInstallLarkCli = opts.onInstallLarkCli;
		this._onListFeishuChats = opts.onListFeishuChats;
		this._onCreateFeishuBot = opts.onCreateFeishuBot;
		this._onEnsureBindingsLoaded = opts.onEnsureBindingsLoaded;
		this._onUnbindFeishuSession = opts.onUnbindFeishuSession;
		this._onGetFeishuDefaultSession = opts.onGetFeishuDefaultSession;
		this._onSetFeishuDefaultSession = opts.onSetFeishuDefaultSession;

	// TabbedPanelManager — 替代 systemMsgBar + queueBar，DOM 在 _renderInputArea 中创建
		const self = this;
		this._tabbedPanel = this._register(new TabbedPanelManager({
			get container() { return self._container; },
			get textarea() { return self._textarea ?? null; },
			get isSending() { return self._isSending; },
			// ★ 2026-09-19：**必须把 attachments 一起转发** ✗ —— 队列项（含"LLM 输出中发送"的排队消息）
			//   把附件存在 `metadata.attachments` ✓，此前这里只转发 `text` ✗ ⇒ 附件被静默丢弃 ✓，
			//   表现为「输入框里的代码片段没有发送给 llm」✓（`_onSendMessage` 的第二个参数是
			//   `explicitSkillIds`，附件是**第三个** ✓）
			onSendMessage: (text, attachments) => { self._onSendMessage?.(text, undefined, attachments); },
			// 插队发送委托给宿主面板：中断当前流需要 `cancelStream`（位于
			// nativeChatEditorPane 层，面板本身拿不到）。宿主实现为
			// cancelStream → setSending(false,{triggerExecuteNext:false}) → 直接发送。
			onInterruptAndSend: (text, attachments) => { self._onInterruptAndSend?.(text, attachments); },
			get agentId() { return self._agent?.id; },
			get onOpenCompressionDetail() { return self._onOpenCompressionDetail; },
			get onOpenMemoryDetail() { return self._onOpenMemoryDetail; },
			get onOpenCodebaseDetail() { return self._onOpenCodebaseDetail; },
		}));

		this._container = $(".chat-container");

		// Initial render so the container has visible structure (tabs + empty state)
		// even before setAgent() / setAvailableAgents() are called.
		this._render();

		// 性能探针：在 webview 控制台调用 window.__SAROSIS_PERF_PROBE__(rounds)
		// 触发 N 轮流式负载，量化每帧成本（对齐 Hermes perf-probe 思路）。
		(window as unknown as Record<string, unknown>).__SAROSIS_PERF_PROBE__ = (rounds?: number) => this.runPerfProbe(rounds);
	}

get element(): HTMLElement {
		return this._container;
	}

	/**
	 * host 推送当前会话的渠道（飞书）绑定状态（header 标识）；null = 未绑定。
	 * @param icon 品牌 logo 元素（可选，host 用 `createChannelIcon` 构造后注入）
	 */
	setFeishuBinding(chatId: string | null, isDefault = false, icon?: HTMLElement): void {
		// 图标**只存不参与变更判定**：host 每次都新建元素，若拿它做比较会让每次刷新都全量重绘
		if (icon) { this._feishuBindingIcon = icon; }
		if (this._feishuBoundChatId === chatId && this._feishuBindingIsDefault === isDefault) { return; }
		this._feishuBoundChatId = chatId;
		this._feishuBindingIsDefault = isDefault;
		this._render();
	}

setAgent(agent: IAgentInfo | null): void {
	if ((window as unknown as Record<string, unknown>).__SAROSIS_SCROLL_DIAG) {
		// eslint-disable-next-line no-console
		console.info('[AgentChatPanel] setAgent:', agent ? `id="${agent.id}", name="${agent.name}"` : 'null', `stack=${new Error().stack?.split('\n').slice(2, 5).join(' ← ')}`);
	}
	this._agent = agent;
	if (agent) { this._agentLoadedOnce = true; }
	const t0 = performance.now();
	this._render();
		console.info(`[AgentChatPanel] setAgent: _render done in ${(performance.now() - t0).toFixed(1)}ms`);
	}

getAgent(): IAgentInfo | null {
		return this._agent;
	}

/**
 * 就地更新当前 agent 的定义字段（icon / name / role…）并只重绘 header。
 *
 * 与 `setAgent` 的区别：`setAgent` 会 `_render()` 全量重建面板（清空消息区），
 * 滚动位置与阅读状态都会丢失。仅当变更属于「Agent 设置页改了图标」这类定义字段时，
 * 用本方法即可，代价最小。
 */
patchAgent(agent: IAgentInfo): void {
	this._agent = agent;
	this._agentLoadedOnce = true;
	this._refreshHeaderOnly();
}

/**
 * 更新当前 agent 的运行状态（驱动 header 头像右下角状态圆点）。
 *
 * 比 `patchAgent()` 轻量得多：只改圆点颜色 + 角色行状态文案，不重建 header。
 * 发送链路每次开始/结束各调用一次，故必须是廉价操作。
 */
setAgentStatus(status: AgentStatus): void {
	this._agentStatus = status;
	this._refreshAgentStatusDot(status);
}

/** 当前 agent 运行状态（发送中 = working，其余 = idle）。 */
protected _agentStatus: AgentStatus = AgentStatus.Idle;

/**
 * 底层是否仍有活跃流（含「已取消、未收尾」窗口期）—— **服务层是唯一真源**。
 *
 * 由宿主注入（`AgentChatService.isSessionStreaming`）。未注入时视为 false，
 * 退回「仅按 UI 状态判定」，与未接入服务层的行为一致。
 *
 * 为什么必须是**拉取**而不是面板自己维护一个布尔：`cancelStream()` 会把 UI 状态
 * 立即复位，而底层流要到 `finally` 才清理 —— 任何「推」过来的镜像值都会在这段
 * 窗口期失真，这正是「流式中连发两条，第二条打断第一条」的成因
 * （详见 `agentChatPanel.send.ts` 头注释）。
 */
protected readonly _onIsStreamActive?: () => boolean;

/**
 * 「进入视口才执行」的延迟构建（★★ 2026-09-20 性能，全卡片族共用）。
 *
 * 动机（真机取证）：首屏 / session 切换会一次性建出 N 张卡，其中重卡的正文
 * （子代理执行详情、图表 SVG、长输出…）在用户**根本看不到**时就已付成本 ——
 * 真机 `render.createMessageElement=58.3ms (parts=127 tools=69)` 与
 * `52.4ms (delegates×4)` 即此类；长任务归因也长期报「无标记」✗。
 *
 * 边界（全部 fail-open，绝不吞内容 ✓）：
 *   ① 无 `IntersectionObserver`（旧环境 / 测试）⇒ **立即执行**（行为同修复前 ✓）；
 *   ② 元素在触发前已从文档移除（重建 / 裁剪 / 关会话）⇒ 跳过，省掉整段工作 ✓；
 *   ③ 观察器纳入面板 disposables ⇒ pane 释放时断开（不泄漏 ✓）；
 *   ④ 任何异常 ⇒ 回退立即执行（诊断/新 API 失败不影响功能 ✓）。
 *
 * @param el     可见性锚定元素
 * @param render 真正执行构建的回调（至多被调用一次）
 */
protected _renderWhenCardVisible(el: HTMLElement, render: () => void): void {
	try {
		if (typeof IntersectionObserver === 'undefined') { render(); return; }
		let done = false;
		const io = new IntersectionObserver(entries => {
			if (done || !entries.some(e => e.isIntersecting)) { return; }
			done = true;
			io.disconnect();
			if (!el.isConnected) { return; }
			render();
		}, { root: null, rootMargin: '200px 0px 200px 0px', threshold: 0 });
		io.observe(el);
		this._register(toDisposable(() => { done = true; io.disconnect(); }));
	} catch {
		render();
	}
}

/** 只重绘 header（不重建消息区 / 输入区）。子类覆盖。 */
protected _refreshHeaderOnly(): void {
	// 默认实现：无 header 的场景（CLI 面板等）无需刷新。
}

/** 刷新 header 状态圆点。子类覆盖。 */
protected _refreshAgentStatusDot(_status: AgentStatus): void {
	// 默认实现：无 header 的场景无需刷新。
}


setAvailableAgents(agents: IAgentInfo[]): void {
		this._availableAgents = agents;
		// Re-render tabs to reflect the new list of available agents
		this._renderTabs();
	}

setMessages(messages: IAgentChatMessage[]): void {
		const t0 = performance.now();
		this._messages = this._aggregateTurns(messages);
		const tAgg = performance.now();
		if ((window as unknown as Record<string, unknown>).__SAROSIS_SCROLL_DIAG) {
			const diagStack = new Error().stack?.split('\n').slice(2,5).map(s => s.trim()).join(' ← ') || '?';
			console.debug(`[ScrollDiag] setMessages count=${messages.length} _wasLoading=${this._wasLoading} isSending=${this._isSending} caller: ${diagStack}`);
		}
		this._renderMessages();
		const tRender = performance.now();
		// 加载历史消息 → 标记 wasLoading，确保 instant 滚动
		// 双重 rAF：首帧等布局计算，次帧等级联布局（代码块/工具卡异步插入后）
		this._wasLoading = true;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => this._scrollbar.scrollToBottom(false));
		});
		// 消息变化影响 inputBaselineTokens，需要重新计算 context ring
		this._updateContextRing();
		console.warn(`[AgentChatPanel] setMessages: total=${messages.length} aggregate=${(tAgg - t0).toFixed(1)}ms render=${(tRender - tAgg).toFixed(1)}ms total=${(performance.now() - t0).toFixed(1)}ms`);
	}

getMessages(): IAgentChatMessage[] {
		return [...this._messages];
	}

getCliMode(): boolean {
		return this._messagesContainer?.classList.contains('cli-mode') ?? false;
	}

setCliMode(enabled: boolean): void {
		if (!this._messagesContainer || !this._container) { return; }
		const isOn = this._messagesContainer.classList.contains('cli-mode');
		if (isOn === enabled) { return; }
		if (enabled) {
			this._container.classList.add('cli-mode');
			this._messagesContainer.classList.add('cli-mode');
		} else {
			this._container.classList.remove('cli-mode');
			this._messagesContainer.classList.remove('cli-mode');
		}
		// Re-render so all existing messages pick up the new style
		this._renderMessages();
		requestAnimationFrame(() => {
			requestAnimationFrame(() => this._scrollbar.scrollToBottom(false));
		});
		// CLI mode changes font-size / line-height / padding on every message,
		// so scrollHeight/clientHeight/trackHeight all shift. The synchronous
		// _refreshScrollMarkers() inside _renderMessages reads stale layout
		// because the browser hasn't reflowed yet. Defer two frames so the new
		// CSS has been applied and measured before recomputing thumb + markers.
		requestAnimationFrame(() => {
			this._scrollbar.refreshScrollMarkers();
			this._scrollbar.scheduleScrollbarUpdate();
		});
	}

addMessage(message: IAgentChatMessage): void {
		this._messages.push(message);
		this._appendMessageDom(message);
		// 用户不在底部时累积未读计数 + 脉冲提示
		if (!this._isAtBottom) {
			this._unreadCount++;
			this._scrollbar.updateScrollBadge();
			this._scrollbar.pulseScrollBtn();
		}
		// 新增消息 → instant 滚动（force=true）
		this._scrollbar.scrollToBottom(true);
		// 刷新滚动条用户消息标记
		this._scrollbar.refreshScrollMarkers();
		// ★ 2026-09-19：新增消息后安排 DOM 窗口裁剪（长会话不再无限增长 ✓）
		this._scheduleTrimDistantMessages();
	}

addCompressionNotice(info: {
		originalCount: number;
		compressedCount: number;
		tokensSaved: number;
		durationMs: number;
		beforeText?: string;
		afterText?: string;
		summary?: string;
	}): void {
		const savePercent = info.originalCount > 0
			? Math.round((1 - info.compressedCount / info.originalCount) * 100)
			: 0;
		const details: string[] = [];
		if (savePercent > 0) { details.push(`-${savePercent}%`); }
		if (info.tokensSaved > 0) { details.push(`节省 ${info.tokensSaved.toLocaleString()} tokens`); }
		if (info.durationMs > 0) { details.push(`${(info.durationMs / 1000).toFixed(1)}s`); }
		this._tabbedPanel.addSystemMessage({
			type: 'compression',
			icon: '\u{1F4E6}',
			badge: '压缩',
			badgeClass: 'compression',
			content: `上下文已压缩：${info.originalCount} → ${info.compressedCount} 条消息`,
			details,
			rawData: { ...info, savePercent },
		});
	}

addMemoryNotice(info: {
		content: string;
		memoryType?: string;
		priority?: number;
		sceneName?: string;
		assistantContentPreview?: string;
		iteration?: number;
		noticeId?: string;
		status?: 'pending' | 'saved' | 'failed';
		entries?: Array<{ type: string; content: string }>;
		skillId?: string;
		skillTitle?: string;
		agentId?: string;
		clickable?: boolean;
	}): void {
	const typeLabels: Record<string, string> = {
		working: 'Working',
		episodic: 'Episodic',
		semantic: 'Semantic',
		procedural: 'Procedural',
		injected: '注入',
		skill: '技能',
		pattern: 'pattern', preference: 'preference', architecture: 'architecture',
		bug: 'bug', workflow: 'workflow', fact: 'fact', instruction: 'instruction',
	};
	const typeLabel = info.memoryType ? (typeLabels[info.memoryType] ?? info.memoryType) : '记忆';
	const memType = info.memoryType ?? '';
	const badgeClass = memType === 'working' ? 'memory-l0'
		: (memType === 'episodic' ? 'memory-l1'
		: (memType === 'semantic' ? 'memory-l2'
		: (memType === 'procedural' ? 'memory-l3'
		: (memType === 'injected' ? 'memory-injected'
		: (memType === 'skill' ? 'memory-skill'
		: 'memory')))));
		let displayContent = info.content;
		if (info.entries && info.entries.length > 0) {
			const entryList = info.entries.map((e, i) =>
				`  ${i + 1}. [${typeLabels[e.type] ?? e.type}] ${e.content}`
			).join('\n');
			displayContent = `${info.content}\n\n${entryList}`;
		}
		if (memType === 'skill' && info.clickable) {
			displayContent = `${info.content}\n\n💡 点击此消息可跳转到记忆详情 → 技能页签`;
		}
		this._tabbedPanel.addSystemMessage({
			type: 'memory',
			icon: memType === 'skill' ? '\u26A1' : '\uD83E\uDDE0',
			badge: typeLabel,
			badgeClass,
			content: displayContent,
			rawData: { ...info },
			status: info.status,
			noticeId: info.noticeId,
		});
	}

updateMemoryNotice(noticeId: string, status: 'saved' | 'failed', newContent?: string): void {
		this._tabbedPanel.updateSystemMessage(noticeId, status, newContent);
	}

removeMemoryNotice(noticeId: string): void {
		this._tabbedPanel.removeSystemMessage(noticeId);
	}

setOpenCompressionDetailCallback(cb: (data: Record<string, unknown>) => void): void {
		this._onOpenCompressionDetail = cb;
	}

setOpenMemoryDetailCallback(cb: (agentId: string, memoryType?: string, contentPreview?: string) => void): void {
		this._onOpenMemoryDetail = cb;
	}

setOpenCodebaseDetailCallback(cb: () => void): void {
		this._onOpenCodebaseDetail = cb;
	}

addCodebaseNotice(info: { operation: string; detail?: string; }): void {
		const opLabels: Record<string, string> = {
			index: '索引', search: '搜索', graph: '图谱',
			trace: '追踪', changes: '变更检测',
		};
		const label = opLabels[info.operation] ?? info.operation;
		const details: string[] = [];
		if (info.detail) { details.push(info.detail); }
		this._tabbedPanel.addSystemMessage({
			type: 'codebase',
			icon: '\uD83D\uDDC2\uFE0F',
			badge: label,
			badgeClass: 'codebase',
			content: info.detail || `代码库记忆操作: ${info.operation}`,
			details,
		});
	}

clearSystemMessages(): void {
		this._tabbedPanel.clearSystemMessages();
	}

setOnQueueItemAction(_cb: IQueueItemActionCallback | null): void { /* deprecated: handled internally */ }

addQueueItem(item: IQueueItem): void { this._tabbedPanel.add(item); }

removeQueueItem(itemId: string): void { this._tabbedPanel.remove(itemId); }

updateQueueItem(itemId: string, updates: Partial<Omit<IQueueItem, 'id'>>): void { this._tabbedPanel.update(itemId, updates); }

getQueueItems(): ReadonlyArray<IQueueItem> { return this._tabbedPanel.getItems(); }

clearQueueItems(): void { this._tabbedPanel.clear(); }

reorderQueueItem(itemId: string, direction: 'up' | 'down'): void { this._tabbedPanel.reorder(itemId, direction); }

updateMessage(
		messageId: string,
		updates: Partial<IAgentChatMessage>,
	): void {
	const idx = this._messages.findIndex((m) => m.id === messageId);
	if (idx >= 0) {
		// 2026-07-26 卡死修复（日志 1785076308529）：isCritical 判定前先快照
		// 旧值——text/thinking delta 每帧都携带 isStreaming:true / parts:slice()
		// （值未变化/仅引用变化），旧判定使「每个 token 同步 _updateMessageDom」，
		// rAF 帧合并被完全绕过，UE 级长内容场景主线程被流式帧占满（单帧 14.8s）。
		const prevIsStreaming = this._messages[idx].isStreaming;
		// 工具签名（id+status）：tool_args 高频 delta 每帧携带 toolCalls 新引用
		// 但仅 args 增长——签名相同则不 critical，走 rAF 合并（单帧 1.3s 元凶）。
		const prevToolSig = (this._messages[idx].toolCalls ?? []).map(t => `${t.id}:${t.status}`).join(',');
		Object.assign(this._messages[idx], updates);
		const m = this._messages[idx];
		// ★ 2026-09-23（用户报「一条消息被拆成 2 段」✓）：**实时路径的同一个接缝** —— 合并相邻
		//   text part ✓。这是**唯一**让 parts 落地的点（`updates.parts` 就由此进数组 ✓）⇒
		//   在此归一 ⇒ 之后所有消费者（keyedParts / _createPartElement / 结构变化判据）看到的
		//   都是**同一份**数组 ✓✓；放渲染层则计数漂移 ⇒ 全量重建闪烁 ✗✓。
		if (m.parts && m.parts.length > 1) {
			m.parts = coalesceAdjacentTextParts(m.parts);
		}

		// ★★ 2026-09-20：完成态 footer 的**用量药丸补建** ✓。
		// 为什么需要：footer 在流结束时**只创建一次**（`_ensureLastBubbleFooter` ✓），而
		// usage delta 可能**晚于** done 抵达 ✗ ⇒ 创建那一刻 `msg.tokenUsage` 还是 undefined
		// ⇒ 完成态只剩「耗时」✗（用户截图：`耗时: 57.2S` ✗）。此后 `updateMessage(id,{tokenUsage})`
		// 只改数据、**不重建 footer** ✗ ⇒ 两个 pill 永远不出现 ✓。
		//（处理中为何正常 ✓：那里有每秒 ticker 反复 upsert ✓。）
		if (updates.tokenUsage !== undefined) {
			this._refreshDoneUsagePills(m);
		}

			// ── parts 管理（单一真相：updates.parts > 已有 parts > 重新派生）──
			// 1. 如果调用方显式提供 parts → 直接使用（流式期间由 _processDelta 维护）
			// 2. 如果 toolCalls 变化但无 parts → 检查工具数量是否变化：
			//    - 数量不变 → 保留已有 parts（工具对象共享引用，数据已更新）
			//    - 数量变化 → 重新派生
			// 3. 如果仅 content 变化 → 原地更新 text part
			const hasPartsUpdate = updates.parts !== undefined;
			const hasToolCallUpdate = updates.toolCalls !== undefined;
			const hasContentUpdate = updates.content !== undefined;

			if (!hasPartsUpdate && m.role === 'assistant') {
				if (hasToolCallUpdate) {
					// toolCalls 变化：检查工具数量是否变化
					const existingToolParts = m.parts?.filter(p => p.kind === 'tool') ?? [];
					const newToolCount = m.toolCalls?.length ?? 0;
				if (existingToolParts.length !== newToolCount || !m.parts || m.parts.length === 0) {
					// 工具数量变化或无 parts → 重新派生
					// 2026-07-26 用户要求：thinking 结束后不移除 thinking 卡片。
					// deriveUiMessageParts 只派生 text/tool——不重派生会丢 thinking parts
					// （首个 tool_start 触发重派生 → thinking 卡片消失的根因）。
					const oldThinkingParts = m.parts?.filter(p => p.kind === 'thinking') ?? [];
					if (m.toolCalls && m.toolCalls.length > 0) {
						m.parts = deriveUiMessageParts(m.content ?? '', m.toolCalls);
					} else if (m.content) {
						m.parts = [{ kind: 'text', text: m.content }];
					} else {
						m.parts = undefined;
					}
					// 保留 thinking parts：重派生丢失 episode 原位信息，插到起始
					// （思考先于输出的标准位置，与历史恢复逻辑一致）。
					if (m.parts && oldThinkingParts.length > 0) {
						m.parts.unshift(...oldThinkingParts);
					}
				}
					// 工具数量不变 → parts 仍有效（工具对象共享引用，subAgents 等数据已更新）
				} else if (hasContentUpdate && m.parts) {
					// 纯文本增量：原地更新 text part。
					// 仅当消息无工具卡时（纯文本消息）才把唯一 text part 更新为全量 content。
					// 有工具卡时，pane 的 text handler 已在共享 parts 数组中按「当前段」
					// 正确更新末尾 text part（segText = content.slice(segmentBase)）；
					// 此处若再用全量 content 覆盖 parts[0]（首个叙述段），会把整段分析
					// 写到消息顶部、与末尾 text part 重复——「文字被重复插入」的根因。
					const hasTool = m.parts.some(p => p.kind === 'tool');
					if (!hasTool) {
						const textPart = m.parts.find(p => p.kind === 'text');
						if (textPart && typeof updates.content === 'string') {
							(textPart as any).text = updates.content;
						}
					}
				}
			}

			// ── 轻量路径：仅 subagent 数据变化 → 原地重建含 subAgents 的工具卡 ──
			// subagent_batch delta 只携带 subAgents，toolCalls 对象共享引用已更新
			const subagentDataOnly = (
				updates.subAgents !== undefined &&
				updates.toolCalls === undefined &&
				updates.isStreaming === undefined &&
				updates.content === undefined &&
				updates.confirmation === undefined &&
				updates.tokenUsage === undefined
			);
			// 诊断：在数据链汇合处记录到达 reducer 的用量字段形态。
			// 与 delegateCards 的 [MetaDiag] render 对照，即可判定抹除发生在上游
			// （此处已是 undefined）还是渲染层（此处有值、render 无 DOM）。
			if ((globalThis as { __SAROSIS_META_DIAG?: boolean }).__SAROSIS_META_DIAG && updates.subAgents) {
				this._logService.info(
					`[MetaDiag] delta msgId=${m.id} only=${subagentDataOnly} n=${updates.subAgents.length} `
					+ `| ${JSON.stringify((updates.subAgents as ISubAgentData[]).map(s => ({ id: s.id, st: s.status, tk: s.tokensUsed ?? null, cr: s.creditUsed ?? null })))}`
				);
			}
			if (subagentDataOnly) {
				this._updateSubAgentCardsInPlace(idx, m);
				return;
			}

		// 2026-07-26 卡死修复（日志 1785076308529）：critical 按「值变化」判定。
		// - isStreaming：仅 true↔false 翻转才 critical（流式中每帧重复 true 不 critical）
		// - toolCalls：仅 id+status 签名变化（新增工具/状态翻转）才 critical——
		//   tool_args 的 args 增长走 rAF 合并，args 预览由就地 rules 节流刷新
		// - parts：流式期间高频 slice() 引用必不同，不可按引用判定——流式中走
		//   rAF 合并（就地 rules 会消费最新 parts），非流式才算 critical
		// - confirmation/subAgents/tokenUsage：低频事件，保持 critical
		const isCritical =
			(updates.isStreaming !== undefined && updates.isStreaming !== prevIsStreaming) ||
			(updates.toolCalls !== undefined && updates.toolCalls.map(t => `${t.id}:${t.status}`).join(',') !== prevToolSig) ||
			(updates.parts !== undefined && !m.isStreaming) ||
			updates.confirmation !== undefined ||
			updates.subAgents !== undefined ||
			updates.tokenUsage !== undefined;
			if (isCritical) {
				if (this._streamingUpdateRaf !== null) {
					cancelAnimationFrame(this._streamingUpdateRaf);
					this._streamingUpdateRaf = null;
				}
				this._updateMessageDom(idx, m);
				this._updateContextRing();
				if (!this._isSending) { this._scrollbar.scheduleScrollToBottom(); }
				return;
			}

			// 流式纯文本更新 → rAF 批处理，合并同帧多次 delta
			if (m.isStreaming && this._streamingUpdateRaf !== null) {
				// 已有 pending rAF — 跳过，rAF 回调会读取最新数据
				return;
			}
			if (m.isStreaming) {
				const rafIdx = idx;
				this._streamingUpdateRaf = requestAnimationFrame(() => {
					this._streamingUpdateRaf = null;
					// ★ 分诊埋点 #5（2026-09-06）：确认 rAF 回调是否真的在执行
					// （窗口不可见/标签后台时 rAF 会被节流甚至暂停 → DOM 永不更新）。
					if (rafIdx < this._messages.length) {
						const _d2 = this._messages[rafIdx] as any;
						_d2._rafRuns = (_d2._rafRuns ?? 0) + 1;
						if (_d2._rafRuns % 50 === 0) {
							this._logService.info(`[UmdDiag] raf-run n=${_d2._rafRuns} msgId=${this._messages[rafIdx].id} v5`);
						}
					}
					if (rafIdx < this._messages.length) {
						this._updateMessageDom(rafIdx, this._messages[rafIdx]);
					}
					this._updateContextRing();
					// P0: 流式期间 _startStreamScroll rAF 循环已钉底，不额外滚动
				});
				return;
			}

			// 非流式非关键更新 → 立即处理 DOM，滚动走 rAF 批量化
			this._updateMessageDom(idx, m);
			this._updateContextRing();
			this._scrollbar.scheduleScrollToBottom();
		}
	}

setSending(sending: boolean, options: { triggerExecuteNext?: boolean } = {}): void {
		const { triggerExecuteNext = true } = options;
		if ((window as unknown as Record<string, unknown>).__SAROSIS_SCROLL_DIAG) {
			const diagStack = new Error().stack?.split('\n').slice(2, 5).map(s => s.trim()).join(' ← ') || '?';
			console.debug(`[ScrollDiag] setSending(${sending}) wasSending=${this._isSending} caller: ${diagStack}`);
		}
		this._isSending = sending;
		this._updateSendButton();
		// 流式期间显式确保 contentEditable 可编辑：频繁 DOM 更新可能重置 textarea 状态，
		// 导致用户无法选中或输入文字（contentEditable 属性丢失或被重置为 inherit）。
		if (sending && this._textarea) {
			this._textarea.setAttribute('contenteditable', 'true');
			if (!this._textarea.hasAttribute('tabindex')) {
				this._textarea.setAttribute('tabindex', '0');
			}
		}
		if (sending) {
			// 追踪加载状态：新消息或切换 Agent 时，下一帧滚动用 instant
			this._wasLoading = true;
			this._scrollbar.startStreamScroll();
		// P0: 重置增量渲染状态——新流式会话从头开始
		this._mdScheduler?.reset();
		this._thinkingMdScheduler?.reset();
			// ── 2026-08-29 移除独立「处理中…」药丸 UI ──
			// 旧行为：_scheduleLoadingPill() 在消息列表底部显示一个独立的
			// 「处理中…」spinner 药丸（chat-loading-pill），与 LLM 气泡分离。
			// 新行为：「处理中」信息内嵌到 LLM 气泡 footer 右侧（见 _createFooter），
			// 不再需要独立的悬浮药丸。此处保留注释以便日后恢复。
			// this._scheduleLoadingPill();
			// 启动「处理中」已耗时秒级刷新（footer 内联版）
			this._startProcessingElapsedTicker();
			// 2026-08-31：此刻补建「处理中」指示。占位消息往往在 _isSending 置位前
			// 就已创建（其时 helper 因 !_isSending 返回 null，占位被留空），若不在此
			// 补建，首包延迟期间（记忆召回/压缩/长工具参数）右下角将一直空白。
			this._syncLastProcessingIndicator();
		} else {
			this._streamPhase = 'idle';
			this._scrollbar.stopStreamScroll();
			// 加载结束：立即隐藏加载提示（与去抖对应）
			// this._clearLoadingPill(); // 同上，已移除独立药丸
			this._stopProcessingElapsedTicker();
		// 清理流式渲染节流定时器和 rAF 批处理
		this._mdScheduler?.reset();
		this._thinkingMdScheduler?.reset();
			// 流式结束后立即更新 context ring（取消 pending 防抖）
			if (this._contextRingTimer !== null) {
				clearTimeout(this._contextRingTimer);
				this._contextRingTimer = null;
			}
			this._doUpdateContextRing();
			if (this._streamingUpdateRaf !== null) {
				cancelAnimationFrame(this._streamingUpdateRaf);
				this._streamingUpdateRaf = null;
			}
			// 流式结束后设置宽限期标志——slow-path 重建（footer/token popup）
			// 增加的高度可能触发 80px 阈值检查误判为"用户滚离"。
			// 500ms 宽限期覆盖异步渲染（语法高亮、markdown 布局）完成。
			this._streamJustEnded = true;
			if (this._streamJustEndedTimer !== null) { clearTimeout(this._streamJustEndedTimer); }
			this._streamJustEndedTimer = setTimeout(() => {
				this._streamJustEnded = false;
				this._streamJustEndedTimer = null;
			}, 2000) as unknown as number;
			// 调度延迟滚动追赶异步 DOM 变化
			this._schedulePostStreamScroll();
			// Agent loop 结束 → 补齐最后一条 assistant 消息的 footer
			// （loop 中所有消息的 footer 都被 _isSending 检查跳过）
			this._revealFootersAfterLoop();
			// 自动执行队列中的待处理任务
			// ⚠️ 只有 sendMessage 真正结束后（_sendMessageInternal line 644）才触发 executeNext，
			// 避免 done 监听器 + line 644 双重 setSending(false) 导致连续 dispatch 多个队列任务。
			// 中间状态（流瞬时结束 / 用户点 Stop）只更新 UI 状态，不触发 dispatch。
			if (triggerExecuteNext) {
				this._tabbedPanel.executeNext();
			}
		}
	}

	/** 判断该消息是否为当前最后一条 assistant 消息（用于流式 footer 占位只作用于最后一条）。 */
	protected _isLastAssistantMessage(msg: IAgentChatMessage): boolean {
		const messages = this.getMessages();
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'assistant') {
				return messages[i].id === msg.id;
			}
		}
		return false;
	}

	/**
	 * 加载态去抖：仅在 _isSending 持续超过 _LOADING_PILL_DEBOUNCE_MS 时才显示
	 * 全局加载提示药丸，避免瞬时回复闪烁。
	 * 药丸为 pointer-events:none，绝不拦截滚动 / 点击（对齐 Hermes 加载态不挡交互）。
	 *
	 * 药丸作为消息列表的最后一个流内子元素插入（而非绝对定位悬浮层）：
	 * 绝对定位会脱离滚动流，导致它要么一直钉在顶部、要么被 scroll-marker /
	 * 自定义滚动条遮罩盖住。流内元素天然跟随最新内容，滚动到底即可见。
	 */
	protected _scheduleLoadingPill(): void {
		this._clearLoadingPillTimerOnly();
		// 会话是否从空开始——决定药丸左对齐（跟随消息流）还是居中（首条等待）
		const isFirstMessage = this._messages.length <= 1;
		this._loadingPillTimer = setTimeout(() => {
			this._loadingPillTimer = null;
			if (!this._messagesContainer) { return; }
			// 取消上一次隐藏的延迟移除，避免刚显示就被移除
			if (this._loadingPillRemoveTimer !== null) {
				clearTimeout(this._loadingPillRemoveTimer);
				this._loadingPillRemoveTimer = null;
			}
			if (!this._loadingPillEl || !this._loadingPillEl.isConnected) {
				const pill = $('.chat-loading-pill');
				pill.appendChild($('.loading-spinner'));
				pill.appendChild($('span.chat-loading-pill-label', undefined, '处理中…'));
				this._loadingPillEl = pill;
			}
			// 每次显示前校正对齐方式（同一次会话可能在两种场景间切换）
			this._loadingPillEl.classList.toggle('is-first-message', isFirstMessage);
			// 先入 DOM 并置于末尾，再强制回流，确保随后加 visible 能触发展开过渡
			this._repositionLoadingPill();
			void this._loadingPillEl.offsetHeight;
			this._loadingPillEl.classList.add('visible');
		}, AgentChatPanelBase._LOADING_PILL_DEBOUNCE_MS) as unknown as number;
	}

	/** 把加载药丸保持为消息容器的最后一个子元素。
	 *  消息 / 工具卡片是 appendChild 进来的，若不重新定位，药丸会被挤到内容中间。 */
	protected _repositionLoadingPill(): void {
		const pill = this._loadingPillEl;
		if (!pill || !this._messagesContainer) { return; }
		if (this._messagesContainer.lastElementChild === pill) { return; }
		this._messagesContainer.appendChild(pill);
	}

	protected _clearLoadingPill(): void {
		this._clearLoadingPillTimerOnly();
		const pill = this._loadingPillEl;
		if (!pill) { return; }
		pill.classList.remove('visible');
		// 折叠动画结束后移出 DOM：药丸不是消息，不应常驻参与
		// children 计数（懒加载锚点 / 内存裁剪都以子元素索引为基准）。
		if (this._loadingPillRemoveTimer !== null) {
			clearTimeout(this._loadingPillRemoveTimer);
		}
		this._loadingPillRemoveTimer = setTimeout(() => {
			this._loadingPillRemoveTimer = null;
			// 期间若重新进入加载态，保留新显示的药丸
			if (pill.classList.contains('visible')) { return; }
			pill.remove();
			if (this._loadingPillEl === pill) { this._loadingPillEl = null; }
		}, AgentChatPanelBase._LOADING_PILL_COLLAPSE_MS) as unknown as number;
	}

	private _clearLoadingPillTimerOnly(): void {
		if (this._loadingPillTimer !== null) {
			clearTimeout(this._loadingPillTimer);
			this._loadingPillTimer = null;
		}
	}

	protected _revealFootersAfterLoop(): void {
		// 找到最后一条 assistant 消息
		const messages = this.getMessages();
		let lastAssistantIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'assistant') {
				lastAssistantIdx = i;
				break;
			}
		}
		if (lastAssistantIdx < 0) { return; }
		const lastAssistant = messages[lastAssistantIdx];
		// 找到对应 DOM
		const lastAssistantEl = this._findMessageElementById(lastAssistant.id);
		if (!lastAssistantEl) { return; }
		const bubble = lastAssistantEl.querySelector('.chat-bubble');
		if (!bubble) { return; }
		// 补齐 footer（如果还没有）：先移除流式期间的占位，避免高度叠加
		if (!bubble.querySelector('.chat-bubble-footer')) {
			bubble.querySelector('.chat-bubble-footer-placeholder')?.remove();
			bubble.appendChild(this._createFooter(lastAssistant));
		}
	}

/**
 * ★★ 2026-09-20：完成态用量药丸**补建**（基类空实现 ✓，由 messages 侧覆盖 ✓）。
 *
 * 为什么需要：完成态 footer 在流结束时**只创建一次**，而 usage delta 可能**晚于** done 抵达 ✗
 * ⇒ 创建时 `msg.tokenUsage` 还是 undefined ⇒ 完成态只剩「耗时」✗（用户截图：`耗时: 57.2S` ✗）。
 * 由 `updateMessage()` 在 `updates.tokenUsage` 到达时调用 ✓（幂等、只在缺 pill 时重建 footer ✓）。
 */
protected _refreshDoneUsagePills(_msg: IAgentChatMessage): void { /* overridden in feature files */ }

protected _findMessageElementById(id: string): HTMLElement | null {
		if (!this._messagesContainer) { return null; }
		return this._messagesContainer.querySelector(`[data-msg-id="${id}"]`);
	}

	/** 容器内当前**已渲染**的消息元素（按 DOM 顺序 ✓，跳过药丸等非消息子元素 ✓）。 */
	protected _renderedMessageElements(): HTMLElement[] {
		if (!this._messagesContainer) { return []; }
		return Array.from(this._messagesContainer.querySelectorAll<HTMLElement>('[data-msg-id]'));
	}

	/**
	 * 「**不得卸载**」的尾部下标（★ 2026-09-19 修「LLM 长执行中气泡突然消失」✓）。
	 *
	 * 两条，都是**常数条**（≤2）⇒ 不会抵消裁剪的收益 ✓：
	 *   ① **最后一条已渲染消息** —— 正在流式 / 刚输出完的那条通常就是它 ✓（最直接 ✓）；
	 *   ② **最后一条 assistant**（按数据 `_messages` 找，再映射回 DOM 下标 ✓）——
	 *      兜住"尾部恰好是系统/用户消息"的情况 ✓。
	 *
	 * ⚠ 只保护**尾部**、不保护"当前视口外的一切" ✗ —— 否则裁剪就失去意义了 ✓。
	 */
	private _protectedTailIndexes(els: HTMLElement[]): number[] {
		const out: number[] = [];
		if (els.length > 0) { out.push(els.length - 1); }
		for (let i = this._messages.length - 1; i >= 0; i--) {
			if (this._messages[i].role !== 'assistant') { continue; }
			const idx = els.findIndex(el => el.getAttribute('data-msg-id') === this._messages[i].id);
			if (idx >= 0) { out.push(idx); }
			break;
		}
		return out;
	}

	/**
	 * ★★★ 2026-09-19：安排一次「DOM 窗口裁剪」（节流 + 空闲执行 ✓）。
	 * 调用时机：新增消息 ✓、懒加载插入一块 ✓、强制全渲染后 ✓、跳转到历史消息后 ✓。
	 */
	protected _scheduleTrimDistantMessages(): void {
		if (this._trimScheduled) { return; }
		this._trimScheduled = true;
		const run = () => {
			this._trimScheduled = false;
			this._trimDistantMessages();
		};
		// 空闲时机执行 ⇒ 绝不与流式渲染 / 布局争主线程 ✓（无 requestIdleCallback 时退化为 setTimeout ✓）
		const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
		if (typeof ric === 'function') { ric(run); } else { window.setTimeout(run, 200); }
	}

	/**
	 * ★★★ 2026-09-19：把 DOM 中的消息裁剪成「以视口为中心的窗口」✓。
	 *
	 * 为什么不能只加"上限条数"✗：用户可能停在**任意位置**（含跳转到的历史处 ✓）
	 * ⇒ 必须按**离视口的距离**卸载 ✓，否则会删掉用户正在看的内容 ✗✓。
	 *
	 * 安全性 ✓：
	 *  - `_messages`（数据）**完全不动** ✓ ⇒ 滚回去/跳回去都能重建 ✓；
	 *  - 卸载走 `_domDisposalObserver` ✓ ⇒ markdown disposables 自动释放 ✓；
	 *  - 若卸载了**顶部**，则按新的首元素**重锚**懒加载 ✓（`_setupLazyLoad` ✓）
	 *    —— 否则上游还有未渲染的消息，用户再也滚不出来 ✗✓；
	 *  - 卸载前后补偿 `scrollTop` ✓（与插入侧 `_setupLazyLoad` 的做法对称 ✓）。
	 */
	protected _trimDistantMessages(): void {
		const container = this._messagesContainer;
		if (!container) { return; }
		const els = this._renderedMessageElements();
		// ★ 2026-09-19（app 卡死取证）：判据从「条数」升级为「条数 **or 页面节点预算**」。
		// 真机 117 条消息就 12.1 万节点（均值 ≈1000 节点/条）⇒ 旧判据（条数 > 120）恒不触发 ✗，
		// 节点一路涨到看门狗的 12 万死亡区 ⇒ 布局/重排把渲染主线程拖死 ⇒ 整窗卡死。
		const nodeCount = this._countDocumentNodes();
		const decision = decideDomTrim(els.length, nodeCount);
		if (!decision.shouldTrim) { return; }
		if (decision.reason === 'node-budget') {
			this._logService.warn(
				`[AgentChatPanel] DOM 预算超限 ⇒ 提前裁剪：nodes=${nodeCount} > ${DOM_TRIM_LIMITS.nodeBudget}` +
				`（messages=${els.length}，保留缓冲 ${decision.keepBuffer} 条，phase=${this._streamPhase}）`,
			);
		}

		// ① 找可见区间（offsetTop 相对 container ✓；仅在超限时做一次，可接受 ✓）
		const viewTop = container.scrollTop;
		const viewBottom = viewTop + container.clientHeight;
		let firstVisible = 0;
		let lastVisible = els.length - 1;
		for (let i = 0; i < els.length; i++) {
			const el = els[i];
			const elTop = el.offsetTop;
			const elBottom = elTop + el.offsetHeight;
			if (elBottom >= viewTop) { firstVisible = i; break; }
		}
		for (let i = els.length - 1; i >= 0; i--) {
			const el = els[i];
			if (el.offsetTop <= viewBottom) { lastVisible = i; break; }
		}

		// ② 期望保留区间 = 可见区间 ± 缓冲 ✓（缓冲随判定来源变：预算触发时更激进 ✓）
		const rawFrom = Math.max(0, firstVisible - decision.keepBuffer);
		const rawTo = Math.min(els.length - 1, lastVisible + decision.keepBuffer);
		// ★★★ 2026-09-19 修「LLM 长时间执行中气泡 UI 突然消失」✗✗（用户报）：
		// 复现链（代码 + 真机日志 ✓）：长执行期间用户**滚上去看历史**或**搜索跳到旧消息** ✓
		// —— `dropdowns.ts:1155` 是「跳转完成后**立刻**裁剪」✓ —— 此时保留窗口只覆盖**视口中段** ✓
		// ⇒ 尾部整条被 `el.remove()` ✗ ⇒ **正在执行的那条 assistant 气泡从 DOM 消失** ✓
		// （数据 `_messages` 没丢 ✓，但不重渲染就回不来 ⇒ 用户看到的就是"气泡突然没了" ✓）。
		// ⇒ 把「不得卸载」的尾部下标并进窗口 ✓（只扩大 ✓，见 `withProtectedRange` ✓）。
		const protectIdx = this._protectedTailIndexes(els);
		const win = withProtectedRange(rawFrom, rawTo, els.length, protectIdx);
		const keepFrom = win.keepFrom;
		const keepTo = win.keepTo;
		if (keepFrom !== rawFrom || keepTo !== rawTo) {
			// 只在**确实扩大**了窗口时留痕 ✓（下次日志里可直接核实保护是否生效 ✓）
			this._logService.info(
				`[AgentChatPanel] 裁剪窗口并入保护尾部：视口 ${rawFrom}..${rawTo} → ${keepFrom}..${keepTo}`
				+ `（保护 idx=${protectIdx.join(',') || '-'}）⇒ 不卸载正在执行的气泡 ✓`,
			);
		}

		const removeAbove = els.slice(0, keepFrom);
		const removeBelow = els.slice(keepTo + 1);
		if (removeAbove.length === 0 && removeBelow.length === 0) {
			// 无可卸载（可视窗口本身已短）⇒ 若仍超预算，直接给出「单条密度」结论 ✓
			this._reportDomDensityIfOverBudget();
			return;
		}

		// ③ 卸载 + 补偿 scrollTop（**上方**被删 ⇒ 内容变短 ⇒ scrollTop 要同量减少 ✓）
		// ★★ 2026-09-22 修复（用户报「输入文字过程中上方滚动条莫名向上滚一下」✗✓）：
		//   旧实现在**上下都删完之后**才取一次 `scrollHeight` ✗ ⇒ 下方被删的高度也被算进补偿量
		//   ⇒ **多减** ⇒ 视图额外向上跳 ✗✗（下方内容不改变视口锚点 ✓，绝不能参与补偿 ✓）。
		//   正确顺序：记 prev 值 → **先删上方** → 读一次 `scrollHeight` 得"只含上方"的补偿量 →
		//   **再删下方**（不参与补偿 ✓）。数学在 `domBudgetDecision.trimScrollCompensation` ✓（有单测 ✓）。
		const prevScrollHeight = container.scrollHeight;
		const prevScrollTop = container.scrollTop;
		for (const el of removeAbove) { el.remove(); }
		const aboveRemovedHeight = removeAbove.length > 0
			? trimScrollCompensation(prevScrollHeight, container.scrollHeight)
			: 0;
		for (const el of removeBelow) { el.remove(); }
		if (aboveRemovedHeight > 0) {
			container.scrollTop = Math.max(0, prevScrollTop - aboveRemovedHeight);
		}

		// ④ 顶部被删 ⇒ 按新首元素重锚懒加载（否则上游历史再也滚不出来 ✗）
		// ⚠ 用 `_renderedMessageElements()[0]` 而非子类的 `_firstMessageElement()` ✗
		// （后者在基类上不可见 ✓；这里语义等价且零耦合 ✓）
		if (removeAbove.length > 0) {
			const newFirst = this._renderedMessageElements()[0] ?? null;
			const newFirstId = newFirst?.getAttribute('data-msg-id') ?? '';
			const idx = newFirstId ? this._messages.findIndex(m => m.id === newFirstId) : -1;
			if (newFirst && idx > 0) {
				this._setupLazyLoad(newFirst, idx);
			}
		}

		// ⑤ 裁剪后复核：仍超预算 ⇒ 说明「单条消息节点密度」是主因（留痕，供后续折叠立项）
		this._reportDomDensityIfOverBudget();
		this._scrollbar.refreshScrollMarkers();
	}

	/**
	 * 页面总节点数（与 `AgentChatService` 的 MemSnap **同一口径** ⇒ 指标可比 ✓）。
	 * ⚠ O(节点数)：只在裁剪与周期体检里调，别放进逐 delta 的热路径 ✗。
	 */
	protected _countDocumentNodes(): number {
		try {
			// O(全文档节点数) 读取本身通常快，但调用方（密度点名/体检）常伴随更重遍历 ⇒
			// 打活动标记，让 LONG_TASK 能区分「是 DOM 普查在占线程」（2026-09-22）
			markRenderActivity('dom-census');
			return this._container.ownerDocument.getElementsByTagName('*').length;
		} catch {
			return 0;
		}
	}

	/** 裁剪后仍超预算 ⇒ 落一条**可见的**密度结论（`null` 时静默 ✓）。 */
	private _reportDomDensityIfOverBudget(): void {
		const note = describeDensityOverBudget(this._countDocumentNodes(), this._renderedMessageElements().length);
		if (note) {
			this._logService.warn(note);
			// ★ 2026-09-19：光知道「≈5592 节点/条」无法行动 —— 必须点名**重在哪**。
			this._logDensityBreakdown();
		}
	}

	/**
	 * 「单条消息太重」的**构成点名**（2026-09-19）。
	 *
	 * ## 为什么需要
	 * 实测（12:57:59）裁剪到 11 条消息后仍 61.5k 节点（≈5592 节点/条），但**猜不出重在哪**：
	 * 排查过程中已证伪两个想当然的假设 ✗ ——
	 *   ① "大代码块的高亮 span"✗：`codeBlockRendererSync` 用的是 `codeEl.textContent = code`
	 *      （**整块一个文本节点**，无 token span）⇒ 代码块大小与节点数无关 ✓；
	 *   ② "工具卡的 markdown 结果"✗：同样走 `_renderMarkdownSafe`，无逐行建 DOM ✓。
	 * ⇒ 只能**实测**：把 top-3 最重消息 + 各自内部 top-5 `tag.class` 打进日志。
	 *
	 * ## 代价与触发条件
	 * O(渲染中节点数) 且只在**已超预算**时调用（罕见）⇒ 可接受；
	 * 不在逐 delta 热路径上 ✓。
	 */
	private _logDensityBreakdown(): void {
		try {
			const rows = this._renderedMessageElements()
				.map(el => ({ id: el.getAttribute('data-msg-id') ?? '?', nodes: el.getElementsByTagName('*').length + 1, el }))
				.sort((a, b) => b.nodes - a.nodes)
				.slice(0, 3);
			const total = this._countDocumentNodes();
			for (const row of rows) {
				const byClass = new Map<string, number>();
				for (const d of Array.from(row.el.getElementsByTagName('*'))) {
					const cn = typeof d.className === 'string' ? d.className.split(' ')[0] : '';
					const key = d.tagName.toLowerCase() + (cn ? '.' + cn : '');
					byClass.set(key, (byClass.get(key) ?? 0) + 1);
				}
				const top = [...byClass.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
					.map(([k, v]) => `${k}:${v}`).join(' , ');
				this._logService.warn(
					`[AgentChatPanel] 密度点名：msg=${row.id} 占 ${row.nodes} 节点（页面共 ${total}）；`
					+ `内部 top：${top}`,
				);
			}
		} catch (err) {
			// 诊断绝不影响主流程
			this._logService.warn('[AgentChatPanel] density breakdown failed:', err);
		}
	}

	/**
	 * ★ 2026-09-19：开启「DOM 节点预算」周期体检（流式期）。
	 *
	 * 必要性：裁剪只在「新增消息 / 懒加载插入 / 跳转」时被安排，而**冻结发生在流式过程中**
	 * —— 每次 delta 全量重写气泡（实测 `content_replace/41ms`）时节点数持续爬升，
	 * 上述触发点一次都不来 ⇒ 直到撞 12 万死亡区 ✗。本体检独立于触发点，早于死亡区动手。
	 */
	protected _ensureDomBudgetWatch(): void {
		if (this._domBudgetWatchTimer !== null) { return; }
		this._domBudgetWatchTimer = window.setInterval(() => {
			if (!this._messagesContainer) { return; }
			// O(全文档节点数) 的周期体检：打活动标记，LONG_TASK 可直接归因（2026-09-22）
			markRenderActivity('dom-budget-watch');
			const nodes = this._countDocumentNodes();
			if (nodes > DOM_TRIM_LIMITS.nodeBudget) {
				this._logService.warn(
					`[AgentChatPanel] DOM 体检：nodes=${nodes} > budget=${DOM_TRIM_LIMITS.nodeBudget}` +
					`（phase=${this._streamPhase}）— 安排裁剪`,
				);
				this._scheduleTrimDistantMessages();
			}
		}, AgentChatPanelBase.DOM_BUDGET_CHECK_INTERVAL_MS);
	}

	/** 停止周期体检（空闲 / 销毁时 ✓ —— 别让一个 O(n) 计数在后台常驻空跑 ✗）。 */
	protected _stopDomBudgetWatch(): void {
		if (this._domBudgetWatchTimer !== null) {
			clearInterval(this._domBudgetWatchTimer);
			this._domBudgetWatchTimer = null;
		}
	}

protected _schedulePostStreamScroll(): void {
		const doScroll = () => {
			if (this._isAtBottom && this._messagesContainer) {
				this._messagesContainer.scrollTop = this._messagesContainer.scrollHeight;
			}
		};
		// 多帧滚动——覆盖 slow-path 重建 + markdown 渲染 + footer 追加的异步 DOM 更新
		let framesLeft = 10;
		const tick = () => {
			doScroll();
			if (--framesLeft > 0) { requestAnimationFrame(tick); }
		};
		requestAnimationFrame(tick);
	}

setStreamPhase(phase: StreamPhase): void {
		this._streamPhase = phase;
		// ★ 2026-09-19：流式期开启「DOM 节点预算」周期体检（空闲即停 ⇒ 不让 O(节点数) 计数常驻空跑 ✓）。
		// 冻结发生在流式过程中，而裁剪的原触发点（新增消息/懒加载/跳转）在那期间一次都不来 ⇒ 必须独立体检。
		if (phase === 'idle') { this._stopDomBudgetWatch(); } else { this._ensureDomBudgetWatch(); }
		// streamPhase 变化影响 context usage 计算（空闲/流式/真值 三层逻辑）
		this._updateContextRing();
	}

setProviders(providers: IProviderInfo[]): void {
		this._providers = providers.slice();
	}

setModels(models: IModelInfo[]): void {
		this._models = models.slice();
		// 模型列表更新后，重新计算 context usage（limit 可能变化）
		this._updateContextRing();
	}

setCurrentProvider(provider: string): void {
		this._currentProvider = provider;
		// P2+: 只刷新输入区域（provider chip 标签），不重建消息列表
		if (this._agent) { this._refreshInputArea(); }
	}

setCurrentModel(model: string): void {
		this._currentModel = model;
		// 当前模型变化后，重新计算 context usage（limit 可能变化）
		this._updateContextRing();
		// P2+: 只刷新输入区域（model chip 标签 + context ring），不重建消息列表
		if (this._agent) { this._refreshInputArea(); }
	}

	/**
	 * 设置图片模型分组数据（2026-09-10）。
	 * 由 pane 从 `getAvailableModels()` 中筛出 `supportsImageGen` 的模型后按 provider 分组。
	 */
	setImageModels(groups: IImageModelGroup[]): void {
		this._imageModelGroups = groups.slice();
	}

	/**
	 * 设置当前图片模型偏好（`auto` | `provider:<id>`）。
	 * 仅更新 chip 文案（轻量刷新输入区），不重建消息列表。
	 */
	setCurrentImageModel(preference: string): void {
		if (preference === this._currentImageModel) { return; }
		this._currentImageModel = preference;
		if (this._agent) { this._refreshInputArea(); }
	}

	/**
	 * 当前图片模型偏好的显示名：
	 *  - 未配置（`''`，含历史遗留的 `auto`）→ 占位文案「图片模型」
	 *  - `provider:<providerId>:<modelId>` → 对应模型 label
	 * 找不到对应项时回退显示 modelId（避免 chip 空白）。
	 */
	protected _getImageModelLabel(): string {
		const pref = this._currentImageModel;
		// 'auto' 为 2026-09-10 之前的默认值（已弃用），按未配置处理。
		if (!pref || pref === 'auto') { return '图片模型'; }
		const parts = pref.split(':');
		if (parts[0] === 'provider' && parts.length >= 3) {
			const providerId = parts[1];
			const modelId = parts.slice(2).join(':');
			const group = this._imageModelGroups.find(g => g.providerId === providerId);
			const model = group?.models.find(m => m.id === modelId);
			if (model) { return model.label; }
			return modelId;
		}
		return pref;
	}

protected _refreshInputArea(): void {
		// 保存当前输入内容（切换 provider/model 时不应清空输入框）
		const savedValue = this._getComposerText();
		const savedAttachments = this._attachments.slice();
		if (this._inputAreaEl && this._inputAreaEl.isConnected) {
			this._inputAreaEl.remove();
		}
		// TabbedPanel 需手动清理
		this._tabbedPanel.removeDom();
		this._renderInputArea();
		// 恢复输入内容和附件
		if (this._textarea && savedValue) {
			this._setComposerText(savedValue);
		}
		this._attachments = savedAttachments;
		// 恢复附件的内联芯片显示
		if (savedAttachments.length > 0) {
			this._renderInlineAttachmentChips();
		}
		// 刷新 header 中的工作区/worktree 选择器 label（切换后轻量更新，不重建 header）
		this._updateHeaderSelectors();
	}

	protected _updateHeaderSelectors(): void {
		// 默认空实现，由 header 特性覆写（工作区/worktree 选择器已移至 header）
	}

setWorktrees(items: ReadonlyArray<IWorktreeItem>): void {
		this._worktrees = items.slice();
		// P0: 轻量刷新输入区替代 _render()——避免 board change reload 时
		// setAgent → setMessages → setWorktrees → _render 链条中第 3 次全量消息重建
		if (this._agent) { this._refreshInputArea(); }
	}

setSelectedWorktree(path: string): void {
		this._selectedWorktreePath = path || "";
		if (this._agent) { this._refreshInputArea(); }
	}

setWorkspaces(items: ReadonlyArray<IWorkspaceItem>): void {
		this._workspaces = items.slice();
		// P0: 轻量刷新输入区替代 _render()——避免 board change reload 时
		// 第 4 次全量消息重建（setWorkspaces → _render → _renderMessages）
		if (this._agent) { this._refreshInputArea(); }
	}

setSelectedWorkspace(id: string): void {
		this._selectedWorkspaceId = id || "";
		// 轻量刷新输入区域（保存/恢复输入框内容），避免 _render() 全量重建清空输入框
		if (this._agent) { this._refreshInputArea(); }
	}

	// ChatOnly toggle — replaces legacy setChatMode(mode: ChatMode)
	setChatOnly(chatOnly: boolean): void {
		this._chatOnly = chatOnly;
		if (this._agent) { this._refreshInputArea(); }
		}

		/**
		 * 恢复输入框选定的 ChatMode（2026-08-21）。
		 * 由宿主在窗口重载 / 切换 agent 时调用（持久化在宿主侧，见
		 * nativeChatEditorPane 的 _STORAGE_CHAT_MODE）。
		 */
		setChatMode(chatMode: 'craft' | 'ask' | 'plan'): void {
			this._chatMode = chatMode;
			if (this._agent) { this._refreshInputArea(); }
		}

setSessionInfo(info: ISessionInfo | null): void {
	this._sessionInfo = info;
	if (this._agent) { this._render(); }
}

public setSessionId(sessionId: string | null, sessionName?: string | null): void {
	this._sessionId = sessionId;
	if (sessionName !== undefined) {
		this._sessionName = sessionName;
	}
	this._render();
}

public setSessionName(sessionName: string | null): void {
	this._sessionName = sessionName;
	this._render();
}

setAgentSessions(sessions: ReadonlyArray<IAgentSessionMeta>): void {
		// 按更新时间倒序排列（最新的在最前面）
		this._agentSessions = sessions.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
		// 如果历史 overlay 已打开，重新渲染以反映最新会话列表
		if (this._historyOverlayEl) {
			this._historyOverlayEl.remove();
			this._historyOverlayEl = null;
			this._renderHistoryOverlay();
		}
	}

setContextUsage(usage: IContextUsage | null): void {
		// 保存完整推送（2026-09-04）：effectiveWindow/thresholdTokens 供
		// _computeContextUsage 把环分母对齐到压缩判定口径（此前只提取 used，
		// 分母一直用本地 maxInputTokens，大窗口模型出现「环 6% 实际 30%」错位）。
		this._contextUsage = usage;
		// 为了向后兼容，从 IContextUsage 提取 input/output 并设置 streamUsage
		if (usage) {
			this._streamUsage = { input: usage.used, output: 0, seen: true };
		} else {
			this._streamUsage = null;
		}
		this._updateContextRing();
	}

setCompactedBaseline(baseline: number): void {
		this._compactedBaseline = baseline;
		this._updateContextRing();
	}

setStreamUsage(usage: { input?: number; output?: number; seen?: boolean } | null): void {
		this._streamUsage = usage;
		this._updateContextRing();
	}

setStreamTextBuffer(buffer: string): void {
		this._streamTextBuffer = buffer;
		this._updateContextRing();
	}

setStreamThinkingBuffer(buffer: string): void {
		this._streamThinkingBuffer = buffer;
		this._updateContextRing();
	}

setCheckpoint(info: ICheckpointInfo | null): void {
		this._checkpoint = info;
		this._checkpoints = info ? [info] : [];
	}

setCheckpoints(list: ICheckpointInfo[]): void {
		this._checkpoints = list;
		this._checkpoint = list.length > 0 ? list[list.length - 1] : null;
		void (this._checkpoints.length);
	}

focusInput(): void {
		this._textarea?.focus();
	}

	protected _render(): void {
		// Close all floating dropdowns before re-render
		this._closeAllDropdowns();
		// P3: 清理所有 markdown disposables 防止内存泄漏——clearNode 只移除 DOM，
		// renderMarkdown 返回的 disposable（事件监听、observer）仍残留在 Map 中。
		for (const disposable of this._markdownDisposables.values()) {
			try { disposable.dispose(); } catch { /* already disposed */ }
		}
		this._markdownDisposables.clear();
		clearNode(this._container);

		// NOTE: 原侧栏样式（webview 版）没有 tabs。
		// 此处不再渲染 tabs，使外观与原 chat sidebar 保持一致。
		// 如需开启 multi-agent tabs，可调用 _renderTabsContainer()。
		this._tabsContainer = undefined;

		if (!this._agent) {
			// 构造期（setAgent 之前）_render 被调用属正常流程，不应告警；
			// 仅当曾成功加载过 agent 之后又变为 null（异常丢失）才警告。
			if (this._agentLoadedOnce) {
				// eslint-disable-next-line no-console
				console.warn('[AgentChatPanel] _render: rendering empty state — _agent was previously loaded but is now null/undefined');
			}
			// Bug fix：4 开聊天框场景下，_selectAndLoadAgent 的 generation 竞态 / getAgent 失败
			// 等原因可能让某个 pane 的 _agent 保持 null。原代码此分支直接 return → 不渲染
			// 输入框，导致该面板「输入框丢失」。改为：仍渲染轻量 empty state（消息区空提示），
			// 并继续渲染输入框（_renderInputArea 用占位 agent 兼容 null），用户可通过
			// header 的 agent 下拉选择 agent 恢复。输入框始终可见是底线可用性。
			this._renderEmptyState();
			this._renderInputArea();
			this._renderMessages();
			return;
		}

		// Chat header
		this._renderHeader();

		// Session info bar (mode badge + hierarchy + tasks)
		if (this._sessionInfo) {
			this._renderSessionInfo();
		}

		// Messages wrapper
		this._renderMessagesArea();

		// Input area
		this._renderInputArea();

		// History overlay (rendered last so it stacks on top)
		if (this._activeHeaderPanel === 'history') {
			this._renderHistoryOverlay();
		}

	// Message-nav overlay (right-side panel, same as history)
	if (this._activeHeaderPanel === 'message-nav') {
		this._renderMsgNavOverlay();
	}

	// Settings overlay (right-side panel, unified with history)
	if (this._activeHeaderPanel === 'settings') {
		this._renderSettingsOverlay();
	}

		// 初始加载后滚动到底部（双重 rAF 等布局完成）
		this._wasLoading = true;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => this._scrollbar.scrollToBottom(true));
		});
	}

protected _closeAllDropdowns(): void {
		this._closeAgentDropdown();
		this._closeWorktreeDropdown();
		this._closeWorkspaceDropdown();
		// Message-nav overlay is closed via _activeHeaderPanel (managed in _render())
		if (this._msgNavOverlayEl) {
			this._msgNavOverlayEl.remove();
			this._msgNavOverlayEl = null;
		}
		this._closeModeDropdown();
		this._closeChatModelDropdown();
		this._closeImageModelDropdown();
		this._closeSlashMenu();
	}

protected _renderTabsContainer(): void  { throw new Error('[moved-to-feature] _renderTabsContainer'); }

protected _renderTabs(): void  { throw new Error('[moved-to-feature] _renderTabs'); }

protected _renderEmptyState(): void  { throw new Error('[moved-to-feature] _renderEmptyState'); }

protected _renderHeader(): void  { throw new Error('[moved-to-feature] _renderHeader'); }

protected _appendHeaderActionBtn(parent: HTMLElement, opts: { title: string; svgPath: string }): HTMLElement  { throw new Error('[moved-to-feature] _appendHeaderActionBtn'); }

protected _openAgentDropdown(): void  { throw new Error('[moved-to-feature] _openAgentDropdown'); }

protected _closeAgentDropdown(): void  { throw new Error('[moved-to-feature] _closeAgentDropdown'); }

protected _renderAgentDropdownContent(): void  { throw new Error('[moved-to-feature] _renderAgentDropdownContent'); }

protected _renderAgentList(): void  { throw new Error('[moved-to-feature] _renderAgentList'); }

protected _aggregateTurns(messages: IAgentChatMessage[]): IAgentChatMessage[]  { throw new Error('[moved-to-feature] _aggregateTurns'); }

protected _renderMessagesArea(): void  { throw new Error('[moved-to-feature] _renderMessagesArea'); }

protected _renderMessages(): void  { throw new Error('[moved-to-feature] _renderMessages'); }

protected _setupLazyLoad(firstEl: HTMLElement, remainingCount: number): void  { throw new Error('[moved-to-feature] _setupLazyLoad'); }

protected _appendMessageDom(msg: IAgentChatMessage): void  { throw new Error('[moved-to-feature] _appendMessageDom'); }

protected _updateMessageDom(idx: number, msg: IAgentChatMessage): void  { throw new Error('[moved-to-feature] _updateMessageDom'); }

protected _updateStreamingContentInPlace(existingEl: HTMLElement, msg: IAgentChatMessage): void  { throw new Error('[moved-to-feature] _updateStreamingContentInPlace'); }

protected _rebuildMessageElement(existingEl: HTMLElement, msg: IAgentChatMessage, source: FullRefreshSource): void  { throw new Error('[moved-to-feature] _rebuildMessageElement'); }

protected _updateToolCardStatuses(existingEl: HTMLElement, msg: IAgentChatMessage): void  { throw new Error('[moved-to-feature] _updateToolCardStatuses'); }

protected _createMessageElement(msg: IAgentChatMessage): HTMLElement  { throw new Error('[moved-to-feature] _createMessageElement'); }

protected _createFooter(msg: IAgentChatMessage): HTMLElement  { throw new Error('[moved-to-feature] _createFooter'); }

protected _transitionStreamingToComplete(existingEl: HTMLElement, msg: IAgentChatMessage): void  { throw new Error('[moved-to-feature] _transitionStreamingToComplete'); }

protected runPerfProbe(rounds?: number): Promise<unknown>  { throw new Error('[moved-to-feature] runPerfProbe'); }

protected _createThinkingIndicator(): HTMLElement  { throw new Error('[moved-to-feature] _createThinkingIndicator'); }

protected static readonly _PHASE_LABELS: Record<string, { icon: string; label: string }> = {
		'understanding':    { icon: '🔍', label: '理解阶段 — Reading relevant code' },
		'implementation':   { icon: '🔧', label: '实施阶段 — Making changes' },
		'verification':     { icon: '✅', label: '验证阶段 — Testing' },
		'llm_streaming':    { icon: '💬', label: 'LLM 推理' },
		'tool_executing':   { icon: '🔧', label: '工具执行中' },
	};

protected _extractFilePath(tc: IToolCall): string  { throw new Error('[moved-to-feature] _extractFilePath'); }

protected _getLanguageTag(filePath: string): string  { throw new Error('[moved-to-feature] _getLanguageTag'); }

protected _computeDiffStats(tc: IToolCall): { added: number; removed: number; lines: Array<{ type: 'add' | 'rem' | 'ctx'; text: string }> }  { throw new Error('[moved-to-feature] _computeDiffStats'); }

protected static _svgChevronTpl: SVGElement | null = null;

protected static _svgSpinnerTpl: SVGElement | null = null;

protected static _svgCopyTpl: SVGElement | null = null;

protected static _svgCheckTpl: SVGElement | null = null;

protected static _svgUndoTpl: SVGElement | null = null;

protected static _svgImportKbTpl: SVGElement | null = null;

protected static _svgSkillTpl: SVGElement | null = null;

protected _appendCanceledNotice(wrapper: HTMLElement): void  { throw new Error('[moved-to-feature] _appendCanceledNotice'); }

protected _toolResultText(result: string): string  { throw new Error('[moved-to-feature] _toolResultText'); }

/**
 * 2026-08-09：通用工具 result 归一化（与 delegateCards.ts:113-119 一致）。
 * codebaseTools/coreTools 的 `json()` helper 返回 `[{type:'text', text:'...'}]` 数组，
 * 经 agentOSService 的 safeStringifyToolResult + JSON.parse 后 tc.result 仍是 array。
 * 通用工具卡片直接 set textContent=array 会得到 [object Object] 或空白。
 * 实现放在 agentChatPanel.messages.ts（与 _toolResultText 一致的 moved-to-feature 模式）。
 */
protected _normalizeToolResultText(result: unknown): string  { throw new Error('[moved-to-feature] _normalizeToolResultText'); }

protected _formatDuration(ms: number): string  { throw new Error('[moved-to-feature] _formatDuration'); }

/** 「处理中」已耗时秒级刷新定时器启停。实现在 agentChatPanel.messages.ts
 *  （_startProcessingElapsedTicker / _stopProcessingElapsedTicker / _tickProcessingElapsed）。
 *  基类留空实现（非 throw）：setSending 在任何子类实例上都会调用，
 *  未实现该特性的子类（如 CLI 面板）静默跳过即可，不应抛错中断发送流程。 */
protected _startProcessingElapsedTicker(): void { /* implemented in messages feature */ }
protected _stopProcessingElapsedTicker(): void { /* implemented in messages feature */ }
/**
 * 自愈补建最后一条 assistant 气泡里的「处理中」指示。实现在 messages feature。
 * 同样留空实现（非 throw），未实现该特性的子类静默跳过。
 * 2026-08-31：占位可能在 _isSending 置位前创建，需在此刻补建，否则首包延迟期间
 * 右下角不显示「处理中」（setSending(true) 时调用）。
 */
protected _syncLastProcessingIndicator(): void { /* implemented in messages feature */ }

protected _toggleNodeCollapse(
		nodeId: string,
		card: HTMLElement,
		nodeBody: HTMLElement,
		summary: HTMLElement,
		collapseBtn: HTMLElement,
		chevron: HTMLElement,
	): void  { throw new Error('[moved-to-feature] _toggleNodeCollapse'); }

protected _addMessageActionButtons(container: HTMLElement, msg: IAgentChatMessage): void  { throw new Error('[moved-to-feature] _addMessageActionButtons'); }

protected _openUndoConfirmDialog(): void  { throw new Error('[moved-to-feature] _openUndoConfirmDialog'); }

protected _openUserEditOverlay(msg: IAgentChatMessage): void  { throw new Error('[moved-to-feature] _openUserEditOverlay'); }

protected _renderEditContextUsageRing(parent: HTMLElement): void  { throw new Error('[moved-to-feature] _renderEditContextUsageRing'); }

protected async _copyToClipboard(text: string, attachments?: IChatAttachment[]): Promise<boolean>  { throw new Error('[moved-to-feature] _copyToClipboard'); }

protected _cleanupMarkdownDisposables(root: HTMLElement): void  { throw new Error('[moved-to-feature] _cleanupMarkdownDisposables'); }

protected _renderMarkdownContent(parent: HTMLElement, content: string, isStreaming: boolean = false): void  { throw new Error('[moved-to-feature] _renderMarkdownContent'); }

protected static readonly _FILE_PATH_RE
		= /(?<![\/\w.\-])(?:(?:\.{0,2}\/)?[\w.\-]+(?:\/[\w.\-]+)*\/[\w.\-]+?\.(?:tsx?|jsx?|mjs|cjs|py[3w]?|rb|php|go|rs|java|kt|swift|scala|cs|cpp|cxx|h|hpp|vue|svelte|astro|prisma|md|mdx|css|scss|less|html?|json|ya?ml|toml|xml|svg|png|jpe?g|gif|webp|bmp|ico|sh|bash|zsh|fish|ps1|bat|cmd|sql|graphql|env|config|ini|cfg|lock|txt|log|tf|tfvars|proto|sqlx|dart|lua|r|jl|nim|zig))(?:[#:]\d+)?(?<![\/\w.\-])/g;

protected static readonly _URL_RE
		= /(?<!["'>=])(https?:\/\/[^\s<>"'，。；：！？、]+)/g;

protected _linkifyPlainText(parent: HTMLElement): void  { throw new Error('[moved-to-feature] _linkifyPlainText'); }

protected _parseLinkifyText(text: string): Array<string | { type: 'file' | 'url'; text: string }> | null  { throw new Error('[moved-to-feature] _parseLinkifyText'); }

protected _tryIncrementalMarkdownRender(container: HTMLElement, newContent: string): boolean  { throw new Error('[moved-to-feature] _tryIncrementalMarkdownRender'); }

protected _resetIncrementalMd(container: HTMLElement): void  { throw new Error('[moved-to-feature] _resetIncrementalMd'); }

protected _getMarkdownOptions(isStreaming: boolean = false): MarkdownRenderOptions  { throw new Error('[moved-to-feature] _getMarkdownOptions'); }

protected _attachLinkInterceptor(parent: HTMLElement): void  { throw new Error('[moved-to-feature] _attachLinkInterceptor'); }

protected _renderPartsContent(bubble: HTMLElement, parts: readonly IMessagePart[], isStreaming: boolean, hostMsg?: IAgentChatMessage): void  { throw new Error('[moved-to-feature] _renderPartsContent'); }

protected _renderInputArea(): void  { throw new Error('[moved-to-feature] _renderInputArea'); }

protected _appendToolbarBtn(
		parent: HTMLElement,
		opts: {
			title: string;
			svgPath: string;
			extraSvgElements?: SVGElement[];
			hasLabel?: boolean;
			label?: string;
			showChevron?: boolean;
			cssClass?: string;
		},
	): HTMLElement  { throw new Error('[moved-to-feature] _appendToolbarBtn'); }

protected _renderSendButtonSvg(): void  { throw new Error('[moved-to-feature] _renderSendButtonSvg'); }

protected _updateSendButton(): void  { throw new Error('[moved-to-feature] _updateSendButton'); }

protected _renderSessionInfo(): void  { throw new Error('[moved-to-feature] _renderSessionInfo'); }

protected _scheduleMentionSearch(query: string): void  { throw new Error('[moved-to-feature] _scheduleMentionSearch'); }

protected _openMentionMenu(): void  { throw new Error('[moved-to-feature] _openMentionMenu'); }

protected _highlightMentionItem(): void  { throw new Error('[moved-to-feature] _highlightMentionItem'); }

protected _selectMentionItem(): void  { throw new Error('[moved-to-feature] _selectMentionItem'); }

protected _closeMentionMenu(): void  { throw new Error('[moved-to-feature] _closeMentionMenu'); }

protected _openSlashMenu(filter: string): void  { throw new Error('[moved-to-feature] _openSlashMenu'); }

protected _renderSlashMenuItems(filter: string): void  { throw new Error('[moved-to-feature] _renderSlashMenuItems'); }

protected _highlightSlashMenuItem(): void  { throw new Error('[moved-to-feature] _highlightSlashMenuItem'); }

protected _addSkillChip(id: string, name: string): void  { throw new Error('[moved-to-feature] _addSkillChip'); }

protected _removeSkillChip(id: string): void  { throw new Error('[moved-to-feature] _removeSkillChip'); }

protected _renderSkillChips(): void  { throw new Error('[moved-to-feature] _renderSkillChips'); }

protected _selectSlashMenuItem(): void  { throw new Error('[moved-to-feature] _selectSlashMenuItem'); }

protected _insertSlashSkill(skillId: string, skillName: string): void  { throw new Error('[moved-to-feature] _insertSlashSkill'); }

protected _closeSlashMenu(): void  { throw new Error('[moved-to-feature] _closeSlashMenu'); }

protected _renderContextUsageRing(parent: HTMLElement): void  { throw new Error('[moved-to-feature] _renderContextUsageRing'); }

protected _estimateTokens(text: string | undefined | null): number  { throw new Error('[moved-to-feature] _estimateTokens'); }

protected _computeInputBaselineTokens(): number  { throw new Error('[moved-to-feature] _computeInputBaselineTokens'); }

protected _computeContextUsage(): IContextUsage | null  { throw new Error('[moved-to-feature] _computeContextUsage'); }

protected _contextRingTimer: number | null = null;

protected _updateContextRing(): void  { throw new Error('[moved-to-feature] _updateContextRing'); }

protected _doUpdateContextRing(): void  { throw new Error('[moved-to-feature] _doUpdateContextRing'); }

protected _openWorktreeDropdown(): void  { throw new Error('[moved-to-feature] _openWorktreeDropdown'); }

protected async _loadWorktreesAndRender(list: HTMLElement, loadingEl: HTMLElement): Promise<void> {
		try {
			// 调用回调加载 worktree 列表
			if (this._onLoadWorktrees) {
				const worktrees = await this._onLoadWorktrees();
				this._worktrees = worktrees.slice();
			}

			// 移除加载提示
			loadingEl.remove();

			// 渲染 "主仓库" 选项（参考 React WorktreeSwitcher）
			const mainItem = append(list, $(".chat-worktree-dropdown-item"));
			if (!this._selectedWorktreePath) {
				mainItem.classList.add('active');
			}
			append(mainItem, $("span.chat-worktree-dropdown-item-icon", undefined, '📁'));
			append(mainItem, $("span.chat-worktree-dropdown-item-name", undefined, '主仓库'));
			if (!this._selectedWorktreePath) {
				append(mainItem, $("span.chat-worktree-dropdown-item-check", undefined, '✓'));
			}
			this._register(
				addDisposableListener(mainItem, EventType.CLICK, () => {
					this._closeWorktreeDropdown();
					if (this._selectedWorktreePath) {
					this._selectedWorktreePath = '';
					this._onClearWorktree?.();
					// 轻量刷新输入区域（保存/恢复输入框内容），避免 _render() 全量重建清空输入框
					this._refreshInputArea();
					}
				}),
			);

			// 渲染 worktree 列表
			if (this._worktrees.length === 0) {
				append(list, $(".chat-worktree-dropdown-empty", undefined, '暂无其他 worktree'));
			} else {
				// 添加分隔线
				append(list, $(".chat-worktree-dropdown-divider"));

				for (const wt of this._worktrees) {
					const item = append(list, $(".chat-worktree-dropdown-item"));
					if (wt.path === this._selectedWorktreePath) {
						item.classList.add('active');
					}
					const infoCol = append(item, $(".chat-worktree-dropdown-info"));
					append(infoCol, $("span.chat-worktree-dropdown-branch", undefined, wt.branch));

					// 显示变更数量徽章（VS Code 兼容）
					if (wt.outgoingChanges || wt.incomingChanges || wt.uncommittedChanges) {
						const changesSpan = append(infoCol, $("span.chat-worktree-dropdown-changes"));
						if (wt.outgoingChanges) {
							append(changesSpan, $("span.chat-worktree-dropdown-changes-out", undefined, `↑${wt.outgoingChanges}`));
						}
						if (wt.incomingChanges) {
							append(changesSpan, $("span.chat-worktree-dropdown-changes-in", undefined, `↓${wt.incomingChanges}`));
						}
						if (wt.uncommittedChanges) {
							append(changesSpan, $("span.chat-worktree-dropdown-changes-uncommitted", undefined, `•${wt.uncommittedChanges}`));
						}
					}

					append(infoCol, $("span.chat-worktree-dropdown-path", undefined, wt.path));
					this._register(
						addDisposableListener(item, EventType.CLICK, () => {
							this._closeWorktreeDropdown();
							if (wt.path !== this._selectedWorktreePath) {
							this._selectedWorktreePath = wt.path;
							this._onSelectWorktree?.({ path: wt.path, branch: wt.branch });
							// 轻量刷新输入区域（保存/恢复输入框内容），避免 _render() 全量重建清空输入框
							this._refreshInputArea();
							}
						}),
					);
					// 右键 worktree 项 → 显示「调试」上下文菜单
					this._register(
						addDisposableListener(item, EventType.CONTEXT_MENU, (e) => {
							e.preventDefault();
							e.stopPropagation();
							this._openWorktreeContextMenu(wt, e);
						}),
					);
				}
			}
		} catch (err) {
			console.error('[AgentChatPanel] Failed to load worktrees:', err);
			loadingEl.textContent = '加载失败，请重试';
		}
	}

protected _closeWorktreeDropdown(): void  { throw new Error('[moved-to-feature] _closeWorktreeDropdown'); }

protected _openWorktreeContextMenu(wt: IWorktreeItem, e: MouseEvent): void  { throw new Error('[moved-to-feature] _openWorktreeContextMenu'); }

protected _closeWorktreeContextMenu(): void  { throw new Error('[moved-to-feature] _closeWorktreeContextMenu'); }

protected _getWorktreeLabel(): string  { throw new Error('[moved-to-feature] _getWorktreeLabel'); }

protected _openWorkspaceDropdown(): void  { throw new Error('[moved-to-feature] _openWorkspaceDropdown'); }

protected _closeWorkspaceDropdown(): void  { throw new Error('[moved-to-feature] _closeWorkspaceDropdown'); }

protected _settingsOverlayEl: HTMLElement | null = null;

protected _renderSettingsOverlay(): void  { throw new Error('[moved-to-feature] _renderSettingsOverlay'); }

protected _renderSettingsOverlayContent(activeTab: string): void  { throw new Error('[moved-to-feature] _renderSettingsOverlayContent'); }

protected _renderSettingsPromptTab(container: HTMLElement): void  { throw new Error('[moved-to-feature] _renderSettingsPromptTab'); }

protected _renderSettingsSkillsTab(container: HTMLElement): void  { throw new Error('[moved-to-feature] _renderSettingsSkillsTab'); }

protected _renderSettingsMcpTab(container: HTMLElement): void  { throw new Error('[moved-to-feature] _renderSettingsMcpTab'); }

protected _renderSettingsKnowledgeTab(container: HTMLElement): void  { throw new Error('[moved-to-feature] _renderSettingsKnowledgeTab'); }

	protected _renderSettingsRulesTab(container: HTMLElement): void  { throw new Error('[moved-to-feature] _renderSettingsRulesTab'); }

	protected _renderSettingsChannelTab(container: HTMLElement): void  { throw new Error('[moved-to-feature] _renderSettingsChannelTab'); }



protected _renderMsgNavOverlay(): void  { throw new Error('[moved-to-feature] _renderMsgNavOverlay'); }

protected _renderMsgNavOverlayContent(): void  { throw new Error('[moved-to-feature] _renderMsgNavOverlayContent'); }

protected _renderMsgNavItems(listEl: HTMLElement, searchInput: HTMLInputElement): void  { throw new Error('[moved-to-feature] _renderMsgNavItems'); }

protected _groupMessagesByDate(): { label: string; msgs: IAgentChatMessage[] }[]  { throw new Error('[moved-to-feature] _groupMessagesByDate'); }

protected _getMessageSummary(m: IAgentChatMessage): string  { throw new Error('[moved-to-feature] _getMessageSummary'); }

protected _formatMsgTime(timestamp: number | undefined): string  { throw new Error('[moved-to-feature] _formatMsgTime'); }

protected _scrollToMessage(messageId: string): void  { throw new Error('[moved-to-feature] _scrollToMessage'); }

protected _forceRenderAllMessages(): void  { throw new Error('[moved-to-feature] _forceRenderAllMessages'); }

protected _openModeDropdown(customTrigger?: HTMLElement | null): void  { throw new Error('[moved-to-feature] _openModeDropdown'); }

protected _closeModeDropdown(): void  { throw new Error('[moved-to-feature] _closeModeDropdown'); }

protected _openChatModelDropdown(customTrigger?: HTMLElement | null): void  { throw new Error('[moved-to-feature] _openChatModelDropdown'); }

protected _closeChatModelDropdown(): void  { throw new Error('[moved-to-feature] _closeChatModelDropdown'); }

	protected _openImageModelDropdown(customTrigger?: HTMLElement | null): void  { throw new Error('[moved-to-feature] _openImageModelDropdown'); }

protected _closeImageModelDropdown(): void  { throw new Error('[moved-to-feature] _closeImageModelDropdown'); }

protected _renderHistoryOverlay(): void  { throw new Error('[moved-to-feature] _renderHistoryOverlay'); }

protected _positionDropdownAbove(el: HTMLElement, trigger: HTMLElement | null): void  { throw new Error('[moved-to-feature] _positionDropdownAbove'); }

protected _disposeOutsideClick(d: IDisposable | null): void  { throw new Error('[moved-to-feature] _disposeOutsideClick'); }

protected _registerOutsideClickClose(panel: HTMLElement, trigger: HTMLElement | null, onClose: () => void): IDisposable  { throw new Error('[moved-to-feature] _registerOutsideClickClose'); }

protected _handleSendMessage(): void  { throw new Error('[moved-to-feature] _handleSendMessage'); }

public closeOrchestrationPlanDialog(): void  { throw new Error('[moved-to-feature] closeOrchestrationPlanDialog'); }

public showOrchestrationPlanDialog(plan: OrchestrationPlan): void  { throw new Error('[moved-to-feature] showOrchestrationPlanDialog'); }

protected _showEditTaskForm(task: PlanTask, plan: OrchestrationPlan): void  { throw new Error('[moved-to-feature] _showEditTaskForm'); }

protected _showEditGoalForm(plan: OrchestrationPlan): void  { throw new Error('[moved-to-feature] _showEditGoalForm'); }

layout(width: number, height: number): void {
		// The CSS flexbox handles layout automatically
	}

protected _handleFileSelection(): void  { throw new Error('[moved-to-feature] _handleFileSelection'); }

protected _addFiles(files: File[], isPasted = false): void  { throw new Error('[moved-to-feature] _addFiles'); }

protected _resizeImage(file: File, maxWidth: number, maxHeight: number): Promise<string>  { throw new Error('[moved-to-feature] _resizeImage'); }

protected _insertInlineAttachmentChip(att: IChatAttachment): void  { throw new Error('[moved-to-feature] _insertInlineAttachmentChip'); }

protected _createReadOnlyAttachmentChip(att: IChatAttachment): HTMLElement  { throw new Error('[moved-to-feature] _createReadOnlyAttachmentChip'); }

protected _renderInlineAttachmentChips(): void  { throw new Error('[moved-to-feature] _renderInlineAttachmentChips'); }

protected _getComposerText(): string  { throw new Error('[moved-to-feature] _getComposerText'); }

/** Public wrapper for input text persistence — delegates to feature implementation. */
public getComposerText(): string { return this._getComposerText(); }
/** Public wrapper for input text persistence — delegates to feature implementation. */
public setComposerText(text: string): void { this._setComposerText(text); }

protected _updateCharCounter(text: string): void  { throw new Error('[moved-to-feature] _updateCharCounter'); }

protected _setComposerText(text: string): void  { throw new Error('[moved-to-feature] _setComposerText'); }

protected _getCaretOffset(): number  { throw new Error('[moved-to-feature] _getCaretOffset'); }

protected _focusComposerEnd(): void  { throw new Error('[moved-to-feature] _focusComposerEnd'); }

protected _insertTextAtCaret(text: string): void  { throw new Error('[moved-to-feature] _insertTextAtCaret'); }

protected _renderAttachmentPreviews(): void  { throw new Error('[moved-to-feature] _renderAttachmentPreviews'); }

protected _showLightbox(src: string): void  { throw new Error('[moved-to-feature] _showLightbox'); }

protected _showImageTooltip(att: IChatAttachment, chip: HTMLElement): void  { throw new Error('[moved-to-feature] _showImageTooltip'); }

protected _hideImageTooltip(): void  { throw new Error('[moved-to-feature] _hideImageTooltip'); }

getAttachments(): ReadonlyArray<IChatAttachment>  { throw new Error('[moved-to-feature] getAttachments'); }

clearAttachments(): void  { throw new Error('[moved-to-feature] clearAttachments'); }

addFileContext(filePath: string, content: string): void  { throw new Error('[moved-to-feature] addFileContext'); }

addTextContext(name: string, content: string): void  { throw new Error('[moved-to-feature] addTextContext'); }

injectPrompt(message: string): void  { throw new Error('[moved-to-feature] injectPrompt'); }

override dispose(): void {
		this._hideImageTooltip();
		this._closeAgentDropdown();
		this._abortController?.abort();
		this._scrollbar.stopStreamScroll();
	if (this._streamJustEndedTimer !== null) { clearTimeout(this._streamJustEndedTimer); }
	this._mdScheduler?.cancel();
	this._thinkingMdScheduler?.cancel();
	this._thinkingCardState.clear();
	if (this._streamingUpdateRaf !== null) { cancelAnimationFrame(this._streamingUpdateRaf); }
		// ★ 2026-09-24（P1 分帧渲染）：销毁 ⇒ 作废旧链 + 取消续片 rAF ✓（否则续片回调会操作已销毁的 DOM ✗）
		this._renderSliceGen++;
		if (this._renderSliceRaf !== null) { cancelAnimationFrame(this._renderSliceRaf); this._renderSliceRaf = null; }
		if (this._lazyLoadObserver) { this._lazyLoadObserver.disconnect(); }
		if (this._domDisposalObserver) { this._domDisposalObserver.disconnect(); this._domDisposalObserver = null; }
		if (this._contextRingTimer !== null) { clearTimeout(this._contextRingTimer); }
		// 清理加载药丸的两个定时器，避免面板销毁后回调仍操作已移除的 DOM
		if (this._loadingPillTimer !== null) { clearTimeout(this._loadingPillTimer); this._loadingPillTimer = null; }
		if (this._loadingPillRemoveTimer !== null) { clearTimeout(this._loadingPillRemoveTimer); this._loadingPillRemoveTimer = null; }
		this._loadingPillEl?.remove();
		this._loadingPillEl = null;
		// 清理「处理中」已耗时刷新定时器，避免面板销毁后回调仍操作已移除的 DOM
		if (this._processingElapsedTimer !== null) { clearInterval(this._processingElapsedTimer); this._processingElapsedTimer = null; }
		// 清理「DOM 节点预算」周期体检（同上：销毁后不得再计数/排裁剪）
		this._stopDomBudgetWatch();

		// Dispose all markdown disposables to avoid leakage
		for (const disposable of this._markdownDisposables.values()) {
			disposable.dispose();
		}
		this._markdownDisposables.clear();
		this._nodeCollapsedState.clear();

		super.dispose();
	}


	// ── tool-card methods implemented in agentChatPanel.toolCards.ts ──
	protected abstract _createThinkingCard(msg: IAgentChatMessage): HTMLElement;
	protected abstract _maybeCreateClarifyCard(tc: IToolCall): HTMLElement | null;

	/**
	 * 取与指定工具调用匹配的沙箱确认（confirmation.toolCallId === toolCallId 且 pending）。
	 * 写文件等工具卡片内嵌「询问用户」按钮时由 toolCards/fileCards 使用。
	 */
	protected _getToolConfirmation(msg: IAgentChatMessage | undefined, toolCallId: string | undefined): IConfirmationData | undefined {
		if (!msg || !msg.confirmation || msg.confirmation.status !== 'pending' || !toolCallId) {
			return undefined;
		}
		return msg.confirmation.toolCallId === toolCallId ? msg.confirmation : undefined;
	}

	/** 写文件类工具键（沙箱确认内嵌到这些卡片上显示询问按钮） */
	protected static readonly WRITE_FILE_TOOL_KEYS = new Set(['file_write', 'patch', 'file_edit', 'create_file']);

	/**
	 * 判断沙箱确认是否已内嵌到写文件工具卡片（此时跳过独立确认卡片，避免重复 UI）。
	 * 非写文件工具（如 terminal）的确认仍走独立确认卡片。
	 */
	protected _isConfirmationEmbeddedInWriteCard(msg: IAgentChatMessage | undefined): boolean {
		if (!msg || !msg.confirmation || msg.confirmation.status !== 'pending' || !msg.confirmation.toolCallId) {
			return false;
		}
		const toolId = msg.confirmation.toolCallId;
		// toolCalls 数组
		if (msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				if (tc.id === toolId && AgentChatPanelBase.WRITE_FILE_TOOL_KEYS.has((tc.name || '').toLowerCase())) {
					return true;
				}
			}
		}
		// parts 模式
		if (msg.parts) {
			for (const p of msg.parts) {
				if (p.kind === 'tool') {
					const t = (p as any).tool as IToolCall | undefined;
					if (t && t.id === toolId && AgentChatPanelBase.WRITE_FILE_TOOL_KEYS.has((t.name || '').toLowerCase())) {
						return true;
					}
				}
			}
		}
		return false;
	}
	protected abstract _buildTaskCardFromData(data: { title: string; description: string; source?: string; taskId?: string; dependencies?: readonly string[]; attachments?: readonly { name: string; mimeType: string }[] }): HTMLElement | null;
	protected abstract _appendToolCallsWithPhaseGroups(
		parent: HTMLElement,
		toolCalls: readonly IToolCall[],
		streamPhase?: string,
	): void;
	protected abstract _appendToolCard(container: HTMLElement, tc: IToolCall, msg: IAgentChatMessage): void;
	protected abstract _createWriteFileToolCard(tc: IToolCall, key: string, confirmation?: IConfirmationData): HTMLElement;
	protected abstract _svgChevronDown(parent: HTMLElement, className: string): void;
	protected abstract _createTerminalToolCard(tc: IToolCall, key: string): HTMLElement;
	protected abstract _createToolCallCard(tc: IToolCall, confirmation?: IConfirmationData): HTMLElement;
	protected abstract _svgChevron(parent: HTMLElement, className: string, size: number): SVGElement;
	protected abstract _svgSpinner(parent: HTMLElement, className: string): void;
	protected abstract _createPlanCard(tc: IToolCall): HTMLElement;
	protected abstract _appendToolSection(
		parent: HTMLElement,
		opts: {
			label: string;
			icon: 'content' | 'result';
			collapsed: boolean;
			badge?: string;
			badgeClass?: string;
			meta?: string;
			buildContent: (container: HTMLElement) => void;
		},
	): void;
	protected abstract _svgSectionContent(parent: HTMLElement, className: string): void;
	protected abstract _svgSectionResult(parent: HTMLElement, className: string): void;
	protected abstract _parsePlanArgs(args: Record<string, unknown> | undefined): {
		plan: Array<{ step: string; status: string }>;
		explanation?: string;
	} | null;
	protected abstract _svgCheck(parent: HTMLElement, className: string): void;
	protected abstract _svgAlert(parent: HTMLElement, className: string): void;
	protected abstract _maybeCreateEnhancedResult(key: string, resultText: string): HTMLElement | null;
	protected abstract _createCodebaseResultCard(key: string, resultText: string): HTMLElement | null;
	protected abstract _renderSearchGraphCard(card: HTMLElement, data: any): HTMLElement;
	protected abstract _renderSearchCodeCard(card: HTMLElement, data: any): HTMLElement;
	protected abstract _renderArchitectureCard(card: HTMLElement, data: any): HTMLElement;
	protected abstract _renderTracePathCard(card: HTMLElement, data: any): HTMLElement;
	protected abstract _renderIndexRepoCard(card: HTMLElement, data: any): HTMLElement;
	protected abstract _renderCodebaseSummaryCard(card: HTMLElement, key: string, data: any): HTMLElement;
	protected abstract _createKanbanListCard(resultText: string): HTMLElement | null;
	protected abstract _createKanbanShowCard(resultText: string): HTMLElement | null;
	protected abstract _createWorkflowListCard(resultText: string): HTMLElement | null;
	protected abstract _createMemoryListCard(resultText: string): HTMLElement | null;
	protected abstract _getToolTitle(key: string, displayName: string | undefined, name: string, isRunning: boolean): string;
	protected abstract _getToolDesc1(key: string, args: string | undefined, filePath: string | undefined): string;
	protected abstract _parseToolListItems(resultText: string): Array<{ name: string; path?: string }> | null;
	protected abstract _createSubAgentCard(sa: ISubAgentData): HTMLElement;
	/** 仅 subagent 数据变化时原地更新已有卡片 DOM，避免整条消息重建。子类 override。 */
	protected _updateSubAgentCardsInPlace(_msgIdx: number, _msg: IAgentChatMessage): void { /* default: no-op */ }
	protected abstract _createCloseIconSVG(): SVGElement;
	protected abstract _createLiveWorkflowTraceView(
		workflowExecutions: Record<string, ILiveWorkflowExecution>,
		workflowEvents?: ILiveWorkflowEvent[],
		collectVariables?: Record<string, ILiveCollectVariable>,
		askUsers?: ILiveWorkflowAskUser[],
		pickerSelects?: ILiveWorkflowPickerSelect[],
		nodeInteractions?: ILiveWorkflowNodeInteraction[]
	): HTMLElement;
	protected abstract _createCollectVarsCard(execId: string, cv: ILiveCollectVariable): HTMLElement;
	/**
	 * 节点卡。`interactions` = 属于该节点的配置表单（2026-09-11 用户需求：配置 UI
	 * 内嵌进对应节点卡，不再与节点卡并列渲染）。
	 */
	protected abstract _createNodeCard(sa: ILiveWorkflowSubAgent, interactions?: ILiveWorkflowNodeInteraction[]): HTMLElement;
	protected abstract _createTimeline(exec: ILiveWorkflowExecution, events: ILiveWorkflowEvent[]): HTMLElement;
	protected abstract _createTimelineItem(label: string, status: string): HTMLElement;
	protected abstract _createConfirmationCard(cf: IConfirmationData): HTMLElement;
	protected abstract _createTerminalConfirmationCard(cf: IConfirmationData): HTMLElement;
	protected abstract _createAskUserCard(askUser: ILiveWorkflowAskUser): HTMLElement;

	/**
	 * ImagePicker 交互选择卡（2026-09-11 用户需求）：执行到 picker 阶段时暂停，
	 * 卡片展示上游候选图供用户多选，确认后 resume 才推进下游节点。
	 */
	protected abstract _createPickerSelectCard(pickerSelect: ILiveWorkflowPickerSelect): HTMLElement;

	/**
	 * 节点交互表单卡（2026-09-11 框架）：按 schema 动态渲染表单（数字/下拉/文本/
	 * 开关/m×n 网格/列表），用户提交后节点才执行、随后继续下游。
	 */
	protected abstract _createNodeInteractionCard(interaction: ILiveWorkflowNodeInteraction): HTMLElement;
	protected abstract _createTodoListCard(todos: ITodoItem[]): HTMLElement;
	protected abstract _createPlanTasksCard(planTasks: IPlanTaskCard): HTMLElement;
	protected abstract _createQuestionCarouselCard(questions: ISuggestedQuestion[]): HTMLElement;
	protected abstract _createReferencesCard(references: IReferenceItem[]): HTMLElement;
	protected abstract _createTipCard(tip: ITipMessage): HTMLElement;
	protected abstract _createProgressCard(progressItems: IProgressMessage[]): HTMLElement;
	protected abstract _createStreamErrorCard(msg: IAgentChatMessage): HTMLElement;
	protected abstract _renderUserContent(parent: HTMLElement, content: string): void;
	protected abstract _appendEditToolbarBtn(
		parent: HTMLElement,
		opt: { title: string; svgPath: string; hasLabel?: boolean; label?: string; cssClass?: string; showChevron?: boolean }
	): HTMLElement;
	protected abstract _svgEditIcon(): SVGElement;
	protected abstract _svgCopyIcon(): SVGElement;
	protected abstract _svgUndoIcon(): SVGElement;
	protected abstract _svgFavoriteIcon(): SVGElement;
	protected abstract _svgTerminalLogo(parent: HTMLElement, className: string): SVGElement;
	protected abstract _svgTerminalOpenIcon(parent: HTMLElement, className: string): void;
	protected abstract _svgImportKbIcon(): SVGElement;
	protected abstract _svgSkillIcon(): SVGElement;
	protected abstract _svgCheckSmall(): SVGElement;
	protected abstract _createAttachmentChipNode(att: IChatAttachment): HTMLElement;
}
