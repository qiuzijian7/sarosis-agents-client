/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import "./media/agentChat.css";
import { Disposable, DisposableStore, IDisposable } from "../../../base/common/lifecycle.js";
import {
	$,
	append,
	clearNode,
	addDisposableListener,
	EventType,
} from "../../../base/browser/dom.js";
import { mainWindow } from "../../../base/browser/window.js";
import { renderMarkdown, type MarkdownRenderOptions } from "../../../base/browser/markdownRenderer.js";
import type { IMarkdownString } from "../../../base/common/htmlContent.js";
import {
	IAgentChatMessage,
	IToolCall,
	IMessagePart,
	deriveUiMessageParts,
	flattenMessageParts,
	IChatAttachment,
	ISubAgentData,
	IConfirmationData,
	IAgentInfo,
	IProviderInfo,
	IModelInfo,
	STATUS_MAP,
	HeaderPanelType,
	AgentStatus,
	ChatMode,
	StreamPhase,
	IModeOption,
	IWorktreeItem,
	IWorkspaceItem,
	ISessionInfo,
	IAgentSessionMeta,
	IContextUsage,
	ICheckpointInfo,
	IQueueItem,
	IQueueItemActionCallback,
	ISuggestedQuestion,
	IReferenceItem,
	ILiveWorkflowAskUser,
	ILiveWorkflowExecution,
	ILiveWorkflowEvent,
	ILiveWorkflowSubAgent,
	ILiveCollectVariable,
	ITodoItem,
	ITipMessage,
	IProgressMessage,
	// Orchestration Plan Types
	OrchestrationPlan,
	PlanTask,
} from "./agentChatTypes.js";

import type { IChatPanel } from "./iChatPanel.js";
import { TabbedPanelManager } from "./modules/tabbedPanel.js";
import { positionDropdownAbove, disposeOutsideClick, registerOutsideClickClose } from "./modules/dropdownHelpers.js";
import { renderContextUsageRing } from "./modules/contextRing.js";
import { renderHistoryOverlay } from "./modules/historyOverlay.js";

// Mode options metadata — mirrors webview ChatComposer.tsx modeOptions
const MODE_OPTIONS: IModeOption[] = [
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

// AgentChatPanel -- Full chat panel matching saros-webui layout
//
// Structure:
//   .chat-container
//     .chat-header           <- avatar + name/status + toolbar buttons
//     .chat-messages-wrapper <- scrollable messages + scroll-to-bottom btn
//       .chat-messages
//         .chat-message .user / .assistant
//           .chat-message-avatar (assistant only)
//           .chat-bubble .user / .assistant
//             .thinking-card
//             .step-indicator
//             .tool-calls-section > .tool-call-card
//             .message-content
//             .streaming-cursor
//             .chat-bubble-footer
//     .chat-input-area
//       .chat-composer-box
//         textarea.chat-composer-textarea
//         .chat-composer-toolbar
//           .chat-toolbar-left (attach, voice, web-search, divider, provider, model)
//           .chat-send-circle

// ─── Void 工具卡：状态感知标题映射（移植自 webview ToolCallCard BUILTIN_TITLES）───
const TOOL_BUILTIN_TITLES: Record<string, { done: string; running: string }> = {
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
	skill_view: { done: '读取技能', running: '正在读取技能' },
	list_skills: { done: '列出技能', running: '正在列出技能' },
	skills_list: { done: '列出技能', running: '正在列出技能' },
	skill_manage: { done: '管理技能', running: '正在管理技能' },
	delegate_task: { done: '委派任务', running: '正在委派任务' },

	clarify: { done: '等待用户选择', running: '正在等待用户选择' },
	memory_remember: { done: '保存记忆', running: '正在保存记忆' },
	memory_search: { done: '搜索记忆', running: '正在搜索记忆' },
	memory_delete: { done: '删除记忆', running: '正在删除记忆' },
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
};
const TOOL_TERMINAL_TOOLS = new Set(['terminal', 'run_command', 'run_persistent_command', 'run_terminal_cmd', 'process', 'execute_code']);
const TOOL_LIST_TOOLS = new Set(['search_files', 'ls_dir', 'list_files', 'get_dir_tree', 'search_pathnames_only', 'search_for_files', 'search_content', 'search_in_file', 'grep']);
const TOOL_CODEBASE_TOOLS = new Set(['search_graph', 'search_code', 'get_architecture', 'trace_path', 'query_graph', 'index_repository', 'get_code_snippet', 'get_graph_schema', 'detect_changes', 'list_projects', 'delete_project', 'index_status', 'ingest_traces', 'manage_adr']);

/**
 * 嵌套 markdown 代码块围栏冲突预处理（移植自 Continue `patchNestedMarkdown`）。
 *
 * 当模型返回 ```markdown 代码块，其内容又含 ``` 围栏时，VS Code renderMarkdown
 * 的围栏解析会在内层 ``` 处提前关闭外层块 → 后续内容泄漏为正文，表现为代码块
 * 错位/混乱。本函数把外层 ```markdown``` 的开/闭围栏转成 ~~~，避免与内层 ``` 冲突。
 *
 * 仅对 ```md / ```markdown / ```gfm / ```github-markdown 开头的代码块生效，
 * 普通 ```html / ```css / ```js 等不受影响（early return）。Sub-ms。
 */
function _patchNestedMarkdown(source: string): string {
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

export class AgentChatPanel extends Disposable implements IChatPanel {
	// -- DOM refs --
	private readonly _container: HTMLElement;
	private _messagesContainer!: HTMLElement;
	private _messagesWrapper!: HTMLElement;
	private _textarea!: HTMLElement;  // contentEditable div（支持文本+内联附件芯片混排）
	private _charCounterEl!: HTMLElement;  // 字符计数器
	private _scrollToBottomBtn!: HTMLElement;
	private _scrollBadge: HTMLElement | null = null;
	// ── 自定义滚动条覆盖层 ──
	private _customScrollbar: HTMLElement | null = null;
	private _scrollbarTrack: HTMLElement | null = null;
	private _scrollbarThumb: HTMLElement | null = null;
	// ── Dropdown outside-click disposable（防止累积泄漏导致卡顿）──
	private _worktreeDropdownOutsideClick: IDisposable | null = null;
	private _modeDropdownOutsideClick: IDisposable | null = null;
	private _providerDropdownOutsideClick: IDisposable | null = null;
	private _modelDropdownOutsideClick: IDisposable | null = null;
	private _scrollbarPopup: HTMLElement | null = null;
	private _scrollbarPopupPreview: HTMLElement | null = null;
	private _scrollbarUpdateRaf: number | null = null;
	private _markerDisposables = new DisposableStore();
	// 未读消息计数——用户滚离底部时新消息累积，回到底部后清零
	private _unreadCount = 0;
	private _sendBtn!: HTMLElement;
	// ── Tabbed panel（替代 systemMsgBar + queueBar）──
	private readonly _tabbedPanel: TabbedPanelManager;

	// -- State --
	private _messages: IAgentChatMessage[] = [];

	/** 系统消息面板回调（打开编辑器详情） */
	private _onOpenCompressionDetail: ((data: Record<string, unknown>) => void) | null = null;
	private _onOpenMemoryDetail: ((agentId: string, memoryType?: string, contentPreview?: string) => void) | null = null;
	private _onOpenCodebaseDetail: (() => void) | null = null;
	/**
	 * 工具卡展开态（按 toolCall id 记忆）。流式期间消息会被频繁整条重建
	 * （_rebuildMessageElement），若不持久化展开态，用户点开的卡会被下一帧重建合上。
	 * 此 Map 跨重建保留用户的展开/折叠选择；未记录时回退到 tc.defaultShow。
	 */
	private readonly _toolCallExpandState = new Map<string, boolean>();
	private _agent: IAgentInfo | null = null;
	private _isSending = false;
	private _showScrollBtn = false;
	// 智能滚动状态（匹配 React isAtBottomRef / wasLoadingRef）
	private _isAtBottom = true;
	// 用户正在拖拽自定义滚动条 thumb — 流式 rAF 钉底循环必须暂停，否则两者互相冲突
	private _isDraggingScrollbar = false;
	private _wasLoading = false;
	// 流式结束后的宽限期标志——slow-path 重建（footer/token popup/语法高亮）
	// 会增加内容高度，非流式路径的 80px 阈值检查会误判为"用户滚离"而禁用自动滚动。
	// 此标志在流式结束后短暂为 true，绕过阈值检查。
	private _streamJustEnded = false;
	private _streamJustEndedTimer: number | null = null;
	// 流式期间持续滚动 rAF 句柄——renderMarkdown 的 codeBlockRenderer 返回 Promise，
	// 代码块在微任务中异步插入 DOM，同步 _scrollToBottom 读取的 scrollHeight 不含代码块高度，
	// 导致流式过程中视图逐渐脱离底部。rAF 循环在微任务之后、绘制之前补滚，追平异步插入。
	private _streamScrollRaf: number | null = null;

	// ── 流式 markdown 渲染节流（参考 Void progressive rendering 50ms interval）──
	// 每个 delta 都调用 _renderMarkdownContent 会触发完整 markdown 解析 + DOM 重建 +
	// disposable 创建，是流式性能的头号瓶颈。节流策略：
	//   1. delta 到达时用 textContent 立即显示原始文本（0 成本）
	//   2. 每 200ms 做一次完整 markdown 渲染（格式化追上）
	//   3. 流式结束后 slow-path 重建自动做最终渲染
	private _streamingMdTimer: number | null = null;
	private _streamingMdLastContent: string = '';
	private _streamingMdTarget: { container: HTMLElement } | null = null;
	// P0: 上次完整渲染为 markdown 的内容——用于判断是否可以增量更新
	private _streamingMdLastRendered: string = '';
	private static readonly STREAMING_MD_INTERVAL = 100; // ms（对齐 Continue 无节流思路，降至 100ms 更流畅；命令式 renderMarkdown 仍需节流防 jank）

	// ── updateMessage rAF 批处理 ──
	// 流式期间多个 delta 可能在同一帧内到达，rAF 批处理合并为每帧一次 DOM 更新。
	// 参考 Void 的 Event.accumulate() 事件累积机制。
	// 关键更新（isStreaming/toolCalls/parts 变化）立即处理，不批处理。
	private _streamingUpdateRaf: number | null = null;

	// P0: scroll-to-bottom rAF 批量化——避免 updateMessage 中每个 delta
	// 同步调用 _scrollToBottom 读取 scrollHeight 导致强制回流。
	// 同帧多次 delta → 只在帧末滚一次。流式期间（_startStreamScroll
	// rAF 循环已持续钉底）此调度不生效。
	private _pendingScrollToBottom = false;
	private _pendingScrollToBottomRaf: number | null = null;

	// P2: 懒加载 observer——setMessages 时断开旧的，避免泄漏
	private _lazyLoadObserver: IntersectionObserver | null = null;
	private _streamPhase: StreamPhase = 'idle';
	private _currentProvider = "";
	private _currentModel = "";
	private _providers: IProviderInfo[] = [];
	private _models: IModelInfo[] = [];
	private _activeHeaderPanel: HeaderPanelType = null;
	private _abortController: AbortController | null = null;
	// P2+: 输入区域 DOM 引用——provider/model 变化时只刷新输入区域，不重建消息列表
	private _inputAreaEl: HTMLElement | null = null;

	// Worktree / session / context / checkpoint state
	private _worktrees: IWorktreeItem[] = [];
	private _selectedWorktreePath = "";
	// ── 工作区/分支选择器（输入区工具栏）──
	/** 可用工作区列表（由外部通过 setWorkspaces() 设置） */
	private _workspaces: IWorkspaceItem[] = [];
	/** 当前选中的工作区 ID */
	private _selectedWorkspaceId = "";
	/** 工作区下拉触发器 */
	private _workspaceTrigger: HTMLElement | null = null;
	/** 工作区下拉面板 */
	private _workspaceDropdownEl: HTMLElement | null = null;
	/** 工作区下拉外部点击关闭 disposable */
	private _workspaceDropdownOutsideClick: IDisposable | null = null;
	/** 加载工作区列表的回调（外部注入） */
	private readonly _onLoadWorkspaces?: () => Promise<ReadonlyArray<IWorkspaceItem>>;
	/** 切换工作区的回调（外部注入，切换后重新加载 worktree 等） */
	private readonly _onSelectWorkspace?: (workspaceId: string, workspaceName: string) => void;
	private _chatMode: ChatMode = 'craft';
	private _sessionInfo: ISessionInfo | null = null;
	private _agentSessions: IAgentSessionMeta[] = [];
	private _contextUsage: IContextUsage | null = null;
	// 流式状态：用于计算 context usage（匹配 React 3 层逻辑）
	private _streamUsage: { input?: number; output?: number; seen?: boolean } | null = null;
	private _streamTextBuffer: string = '';
	private _streamThinkingBuffer: string = '';
	private _compactedBaseline: number = 0;
	private _checkpoint: ICheckpointInfo | null = null;
	// _checkpoints written by setCheckpoint/setCheckpoints; read suppressed for now
	// (previously rendered in _renderSystemMsgPanel; todo: render in tabbed panel msg tab)
	private _checkpoints: ICheckpointInfo[] = [];
	private _attachments: IChatAttachment[] = [];
	private _imageTooltip: HTMLElement | null = null;
	private _fileInput: HTMLInputElement | null = null;
	// -- Agent dropdown state --
	private _availableAgents: IAgentInfo[] = [];
	private _dropdownOpen = false;
	private _dropdownFilter = "";
	private _agentDropdownEl: HTMLElement | null = null;
	private _agentSearchInput: HTMLInputElement | null = null;
	private _agentDropdownList: HTMLElement | null = null;
	private _agentSelectorTrigger: HTMLElement | null = null;

	// -- Other floating dropdown refs --
	private _worktreeDropdownEl: HTMLElement | null = null;
	private _worktreeTrigger: HTMLElement | null = null;
	private _msgNavOverlayEl: HTMLElement | null = null;
	private _msgNavTrigger: HTMLElement | null = null;
	private _modeDropdownEl: HTMLElement | null = null;
	private _modeTrigger: HTMLElement | null = null;
	// 当前 mode 下拉菜单实际使用的触发器（默认 = _modeTrigger；编辑消息时 = 编辑 composer 内的 mode 按钮）
	private _modeDropdownTrigger: HTMLElement | null = null;
	private _providerDropdownEl: HTMLElement | null = null;
	private _providerTrigger: HTMLElement | null = null;
	private _providerDropdownTrigger: HTMLElement | null = null;
	private _modelDropdownEl: HTMLElement | null = null;
	private _modelTrigger: HTMLElement | null = null;
	private _modelDropdownTrigger: HTMLElement | null = null;
	private _historyOverlayEl: HTMLElement | null = null;

	// -- Tabs state --
	private _tabsContainer: HTMLElement | undefined;

	// -- Composer --
	private _resizeMaxH = 120; // dynamic max height from drag resize
	private _userHasAdjustedHeight = false; // whether user has manually adjusted the composer height

	// -- Slash menu state --
	private _slashMenuEl: HTMLElement | null = null;
	private _slashMenuIndex = 0;

	// -- P0-2: @mention file search state --
	private _mentionEl: HTMLElement | null = null;
	private _mentionIndex = 0;
	private _mentionQuery = '';
	private _mentionResults: Array<{ path: string; name: string }> = [];
	private _mentionSearchTimer: number | null = null;

	// -- Skill chips state --
	private _skillChipsBar: HTMLElement | null = null;
	private _skillChips: Array<{ id: string; name: string }> = [];

	// -- Orchestration plan state --
	private _orchestrationPlanEl: HTMLElement | null = null;
	private _isPlanDialogOpen: boolean = false;
	private _activePlan: OrchestrationPlan | null = null;

	// -- Markdown render disposables --
	private _markdownDisposables = new Map<HTMLElement, IDisposable>();

	// -- Node collapse state (persists across DOM rebuilds) --
	// Keyed by sub-agent node id; true = user manually collapsed.
	private _nodeCollapsedState = new Map<string, boolean>();

	// -- Context baseline --

	// -- Callbacks --
	private readonly _onSendMessage: (text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[]) => void;
	private readonly _onCancelExecution: () => void;
	private readonly _onSelectAgent: (id: string) => void;
	private readonly _onSelectWorktree?: (worktree: { path: string; branch: string }) => void;
	private readonly _onClearWorktree?: () => void;
	private readonly _onLoadWorktrees?: () => Promise<ReadonlyArray<IWorktreeItem>>;
	private readonly _onScrollToMessage?: (messageId: string) => void;
	private readonly _onNewSession?: () => void;
	private readonly _onOpenSession?: (sessionId: string) => void;
	private readonly _onRenameSession?: (sessionId: string, newName: string) => void;
	private readonly _onDeleteSession?: (sessionId: string) => void;
	private readonly _onForkSession?: (sessionId: string) => void;
	private readonly _onOpenSettings?: () => void;
	private readonly _onChangeMode?: (mode: ChatMode) => void;
	private readonly _onSelectProvider?: (providerId: string) => void;
	private readonly _onSelectModel?: (modelId: string) => void;
	private readonly _onCheckpointAction?: (action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string; checkpointId?: string }) => void;
	private readonly _onConfirmationAction?: (confirmationId: string, buttonId: string) => void;
	/** Edit a prior user message: truncate the conversation after it and regenerate from the new text. */
	private readonly _onEditMessage?: (messageId: string, newText: string) => void;
	private readonly _onListSkills: () => ReadonlyArray<{ id: string; name: string; description: string; activation?: string; source?: string; version?: string; enabled: boolean; category?: string }>;
	private readonly _onListMcpServers?: () => ReadonlyArray<{ name: string; status: string; toolCount: number }>;
	private readonly _onOpenMcpSettings?: () => void;
	private readonly _onOpenHtmlPreview?: () => void;
	private readonly _onGetAgentSkills?: () => string[];
	private readonly _onAddSkill?: (skillId: string) => Promise<void>;
	private readonly _onRemoveSkill?: (skillId: string) => Promise<void>;
	// New callbacks for missing features
	private readonly _onAskUserSubmit?: (askUserId: string, executionId: string, nodeId: string, selection: string | string[]) => void;
	private readonly _onClarifySubmit?: (toolCallId: string, selection: string) => void;
	private readonly _onQuestionClick?: (question: ISuggestedQuestion) => void;
	private readonly _onReferenceClick?: (ref: IReferenceItem) => void;
	private readonly _onTipAction?: (tipId: string, actionId: string) => void;
	private readonly _onTipDismiss?: (tipId: string) => void;
	private readonly _onApplyCode?: (code: string, language: string, filePath?: string) => void;
	private readonly _onSubmitVariables?: (executionId: string, values: Record<string, string>) => void;
	private readonly _onOpenFile?: (filePath: string, content?: string) => void;
	/** P0-2: @提及文件搜索 */
	private readonly _onSearchFiles?: (query: string) => Promise<Array<{ path: string; name: string }>>;
	private readonly _onAddFileContext?: (filePath: string) => void;
	/** P1-1: 终端运行 */
	private readonly _onRunInTerminal?: (code: string) => void;
	/** P1-3: 添加编辑器选中代码 */
	private readonly _onAddSelectionToChat?: () => void;
	/** Click handler for http(s) links in LLM output. Opens the URL in the editor area. */
	private readonly _onOpenLink?: (url: string) => void;
	/** Tool approval callback (for security-level tool calls) */
	private readonly _onToolApprove?: (toolCallId: string, decision: string) => void;
	// Orchestration plan callbacks
	private readonly _onApprovePlan?: (planId: string) => void;
	private readonly _onRejectPlan?: (planId: string) => void;
	private readonly _onApproveWithoutExecute?: (planId: string) => void;
	private readonly _onTaskAction?: (planId: string, taskId: string, action: 'retry' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' | 'block' | 'unblock') => void;
	private readonly _onUpdatePlan?: (planId: string, updates: Record<string, unknown>) => void;
	private readonly _onUpdateTask?: (planId: string, taskId: string, updates: Record<string, unknown>) => void;
	private readonly _onDecomposeTask?: (planId: string, taskId: string) => void;
	private readonly _onClosePlanDialog?: (planId: string) => void;
	private readonly _onFavoriteMessage?: (messageContent: string) => void;
	/** P2: 导入知识库按钮回调（与 onFavoriteMessage 走同一份 importMessageToKnowledgeBase 管线，仅入口不同） */
	private readonly _onImportToKnowledgeBase?: (messageContent: string) => void;

	constructor(opts: {
		onSendMessage: (text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[]) => void;
		onCancelExecution: () => void;
		onToggleCollapse: () => void;
		onSelectAgent: (id: string) => void;
		onSelectWorktree?: (worktree: { path: string; branch: string }) => void;
		onClearWorktree?: () => void;
		onLoadWorktrees?: () => Promise<ReadonlyArray<IWorktreeItem>>;
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
		onChangeMode?: (mode: ChatMode) => void;
		onSelectProvider?: (providerId: string) => void;
		onSelectModel?: (modelId: string) => void;
		onCheckpointAction?: (action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string; checkpointId?: string }) => void;
		onConfirmationAction?: (confirmationId: string, buttonId: string) => void;
		onEditMessage?: (messageId: string, newText: string) => void;
		onListSkills: () => ReadonlyArray<{ id: string; name: string; description: string; activation?: string; source?: string; version?: string; enabled: boolean; category?: string }>;
		onListMcpServers?: () => ReadonlyArray<{ name: string; status: string; toolCount: number }>;
		onOpenMcpSettings?: () => void;
		onOpenHtmlPreview?: () => void;
		onGetAgentSkills?: () => string[];
		onAddSkill?: (skillId: string) => Promise<void>;
		onRemoveSkill?: (skillId: string) => Promise<void>;
		// New callbacks for missing features
		onAskUserSubmit?: (askUserId: string, executionId: string, nodeId: string, selection: string | string[]) => void;
		onClarifySubmit?: (toolCallId: string, selection: string) => void;
		onQuestionClick?: (question: ISuggestedQuestion) => void;
		onReferenceClick?: (ref: IReferenceItem) => void;
		onTipAction?: (tipId: string, actionId: string) => void;
		onTipDismiss?: (tipId: string) => void;
		onApplyCode?: (code: string, language: string, filePath?: string) => void;
		onSubmitVariables?: (executionId: string, values: Record<string, string>) => void;
		onOpenFile?: (filePath: string, content?: string) => void;
		/** P0-2: @提及文件搜索——用户输入 @ 时搜索工作区文件 */
		onSearchFiles?: (query: string) => Promise<Array<{ path: string; name: string }>>;
		/** P0-2: @提及文件选择后——添加文件作为上下文 */
		onAddFileContext?: (filePath: string) => void;
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
		/** P2: 导入知识库（footer 复制按钮右侧，与 onFavoriteMessage 走同一份管线） */
		onImportToKnowledgeBase?: (messageContent: string) => void;
	}) {
		super();
		this._onSendMessage = opts.onSendMessage;
		this._onCancelExecution = opts.onCancelExecution;
		this._onSelectAgent = opts.onSelectAgent;
		this._onSelectWorktree = opts.onSelectWorktree;
		this._onClearWorktree = opts.onClearWorktree;
		this._onLoadWorktrees = opts.onLoadWorktrees;
		this._onLoadWorkspaces = opts.onLoadWorkspaces;
		this._onSelectWorkspace = opts.onSelectWorkspace;
		this._onScrollToMessage = opts.onScrollToMessage;
		this._onNewSession = opts.onNewSession;
		this._onOpenSession = opts.onOpenSession;
		this._onRenameSession = opts.onRenameSession;
		this._onDeleteSession = opts.onDeleteSession;
		this._onForkSession = opts.onForkSession;
		this._onOpenSettings = opts.onOpenSettings;
		this._onChangeMode = opts.onChangeMode;
		this._onSelectProvider = opts.onSelectProvider;
		this._onSelectModel = opts.onSelectModel;
		this._onCheckpointAction = opts.onCheckpointAction;
		this._onConfirmationAction = opts.onConfirmationAction;
		this._onEditMessage = opts.onEditMessage;
		this._onListSkills = opts.onListSkills;
		this._onListMcpServers = opts.onListMcpServers;
		this._onOpenMcpSettings = opts.onOpenMcpSettings;
		this._onOpenHtmlPreview = opts.onOpenHtmlPreview;
		this._onGetAgentSkills = opts.onGetAgentSkills;
		this._onAddSkill = opts.onAddSkill;
		this._onRemoveSkill = opts.onRemoveSkill;
		// New callbacks
		this._onAskUserSubmit = opts.onAskUserSubmit;
		this._onClarifySubmit = opts.onClarifySubmit;
		this._onQuestionClick = opts.onQuestionClick;
		this._onReferenceClick = opts.onReferenceClick;
		this._onTipAction = opts.onTipAction;
		this._onTipDismiss = opts.onTipDismiss;
		this._onApplyCode = opts.onApplyCode;
		this._onSubmitVariables = opts.onSubmitVariables;
		this._onOpenFile = opts.onOpenFile;
		this._onSearchFiles = opts.onSearchFiles;
		this._onAddFileContext = opts.onAddFileContext;
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

		// TabbedPanelManager — 替代 systemMsgBar + queueBar，DOM 在 _renderInputArea 中创建
		const self = this;
		this._tabbedPanel = this._register(new TabbedPanelManager({
			get container() { return self._container; },
			get textarea() { return self._textarea ?? null; },
			get isSending() { return self._isSending; },
			onSendMessage: (text) => { self._onSendMessage?.(text); },
			get agentId() { return self._agent?.id; },
			get onOpenCompressionDetail() { return self._onOpenCompressionDetail; },
			get onOpenMemoryDetail() { return self._onOpenMemoryDetail; },
			get onOpenCodebaseDetail() { return self._onOpenCodebaseDetail; },
		}));

		this._container = $(".chat-container");

		// Initial render so the container has visible structure (tabs + empty state)
		// even before setAgent() / setAvailableAgents() are called.
		this._render();
	}

	get element(): HTMLElement {
		return this._container;
	}

	// Public API

	setAgent(agent: IAgentInfo | null): void {
		// eslint-disable-next-line no-console
		console.info('[AgentChatPanel] setAgent:', agent ? `id="${agent.id}", name="${agent.name}"` : 'null', `stack=${new Error().stack?.split('\n').slice(2,5).join(' ← ')}`);
		this._agent = agent;
		const t0 = performance.now();
		this._render();
		console.info(`[AgentChatPanel] setAgent: _render done in ${(performance.now() - t0).toFixed(1)}ms`);
	}

	getAgent(): IAgentInfo | null {
		return this._agent;
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
		const diagStack = new Error().stack?.split('\n').slice(2,5).map(s => s.trim()).join(' ← ') || '?';
		console.debug(`[ScrollDiag] setMessages count=${messages.length} _wasLoading=${this._wasLoading} isSending=${this._isSending} caller: ${diagStack}`);
		this._renderMessages();
		const tRender = performance.now();
		// 加载历史消息 → 标记 wasLoading，确保 instant 滚动
		// 双重 rAF：首帧等布局计算，次帧等级联布局（代码块/工具卡异步插入后）
		this._wasLoading = true;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => this._scrollToBottom(false));
		});
		// 消息变化影响 inputBaselineTokens，需要重新计算 context ring
		this._updateContextRing();
		console.warn(`[AgentChatPanel] setMessages: total=${messages.length} aggregate=${(tAgg - t0).toFixed(1)}ms render=${(tRender - tAgg).toFixed(1)}ms total=${(performance.now() - t0).toFixed(1)}ms`);
	}

	/**
	 * Returns the current in-memory messages array (shallow copy).
	 * Used by NativeChatEditorPane to save runtime state on tab switch.
	 */
	getMessages(): IAgentChatMessage[] {
		return [...this._messages];
	}

	/** Whether CLI-style compact rendering is currently active. */
	getCliMode(): boolean {
		return this._messagesContainer?.classList.contains('cli-mode') ?? false;
	}

	/**
	 * Toggle CLI-style mode on or off.
	 *
	 * When enabled, the root container and the messages container receive the
	 * `cli-mode` CSS class. The root class drives the input-area styling, while
	 * the messages class drives the compact terminal-style message rendering.
	 * Existing messages are re-rendered so the change takes effect immediately.
	 *
	 * @param enabled true to enable CLI mode, false to restore rich UI
	 */
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
			requestAnimationFrame(() => this._scrollToBottom(false));
		});
		// CLI mode changes font-size / line-height / padding on every message,
		// so scrollHeight/clientHeight/trackHeight all shift. The synchronous
		// _refreshScrollMarkers() inside _renderMessages reads stale layout
		// because the browser hasn't reflowed yet. Defer two frames so the new
		// CSS has been applied and measured before recomputing thumb + markers.
		requestAnimationFrame(() => {
			this._refreshScrollMarkers();
			this._scheduleScrollbarUpdate();
		});
	}



	addMessage(message: IAgentChatMessage): void {
		this._messages.push(message);
		this._appendMessageDom(message);
		// 用户不在底部时累积未读计数 + 脉冲提示
		if (!this._isAtBottom) {
			this._unreadCount++;
			this._updateScrollBadge();
			this._pulseScrollBtn();
		}
		// 新增消息 → instant 滚动（force=true）
		this._scrollToBottom(true);
		// 刷新滚动条用户消息标记
		this._refreshScrollMarkers();
	}

	/**
	 * 添加上下文压缩提示到系统消息面板（委托给 TabbedPanelManager）。
	 */
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

	/**
	 * 添加记忆提取提示（委托给 TabbedPanelManager）。
	 */
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

	/** 更新已有记忆卡片的状态（委托给 TabbedPanelManager） */
	updateMemoryNotice(noticeId: string, status: 'saved' | 'failed', newContent?: string): void {
		this._tabbedPanel.updateSystemMessage(noticeId, status, newContent);
	}

	/** 移除已有记忆卡片（委托给 TabbedPanelManager） */
	removeMemoryNotice(noticeId: string): void {
		this._tabbedPanel.removeSystemMessage(noticeId);
	}

	/** 设置打开压缩详情编辑器的回调 */
	setOpenCompressionDetailCallback(cb: (data: Record<string, unknown>) => void): void {
		this._onOpenCompressionDetail = cb;
	}

	/** 设置打开记忆详情编辑器的回调 */
	setOpenMemoryDetailCallback(cb: (agentId: string, memoryType?: string, contentPreview?: string) => void): void {
		this._onOpenMemoryDetail = cb;
	}

	/** 设置打开代码库记忆详情编辑器的回调 */
	setOpenCodebaseDetailCallback(cb: () => void): void {
		this._onOpenCodebaseDetail = cb;
	}

	/** 添加代码库记忆操作提示（委托给 TabbedPanelManager） */
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

	/** 清空系统消息（委托给 TabbedPanelManager） */
	clearSystemMessages(): void {
		this._tabbedPanel.clearSystemMessages();
	}



	// =========================================================
	// Queue bar（委托给 modules/tabbedPanel.ts — TabbedPanelManager）
	// =========================================================

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
			Object.assign(this._messages[idx], updates);
			const m = this._messages[idx];
			// 阶段E：流式期间由 content + toolCalls 即时派生有序 parts（单一真相），
			// 除非调用方已显式提供 parts。textPosition 此处仅作本地排序信号，不再跨层传递。
			// P2: 纯文本 delta 跳过 O(n) deriveUiMessageParts（只在 toolCalls/streaming 变化时重算）
			if (updates.parts === undefined && m.role === 'assistant') {
				const hasToolCallChange = updates.toolCalls !== undefined;
				const isStructural = hasToolCallChange || updates.isStreaming !== undefined;

				if (isStructural || !m.parts || (m.parts.length === 0 && m.content)) {
					// 全量派生
					if (m.toolCalls && m.toolCalls.length > 0) {
						m.parts = deriveUiMessageParts(m.content ?? '', m.toolCalls);
					} else if (m.content) {
						m.parts = [{ kind: 'text', text: m.content }];
					} else {
						m.parts = undefined;
					}
				} else if (updates.content !== undefined) {
					// 纯文本增量：原地更新 text part，避免遍历 toolCalls 数组
					const textPart = m.parts.find(p => p.kind === 'text');
					if (textPart && typeof updates.content === 'string') {
						textPart.text = updates.content;
					}
				}
			}

			// 关键更新（结构变化、流式状态切换）→ 立即处理，不批处理
			const isCritical =
				updates.isStreaming !== undefined ||
				updates.toolCalls !== undefined ||
				updates.parts !== undefined ||
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
				// P0: 流式期间 _startStreamScroll rAF 循环持续钉底，
				// 非流式期间走 rAF 批量滚动避免每个 delta 同步强制回流
				if (!this._isSending) { this._scheduleScrollToBottom(); }
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
			this._scheduleScrollToBottom();
		}
	}

	setSending(sending: boolean, options: { triggerExecuteNext?: boolean } = {}): void {
		const { triggerExecuteNext = true } = options;
		const diagStack = new Error().stack?.split('\n').slice(2, 5).map(s => s.trim()).join(' ← ') || '?';
		console.debug(`[ScrollDiag] setSending(${sending}) wasSending=${this._isSending} caller: ${diagStack}`);
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
			this._startStreamScroll();
			// P0: 重置增量渲染状态——新流式会话从头开始
			this._streamingMdLastRendered = '';
		} else {
			this._streamPhase = 'idle';
			this._stopStreamScroll();
			// 清理流式渲染节流定时器和 rAF 批处理
			if (this._streamingMdTimer !== null) {
				clearTimeout(this._streamingMdTimer);
				this._streamingMdTimer = null;
			}
			this._streamingMdTarget = null;
			this._streamingMdLastContent = '';
			this._streamingMdLastRendered = '';
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

	/**
	 * Agent loop 结束后调用 —— 为最后一条 assistant 消息补齐 footer。
	 *
	 * 设计原因：loop 进行中（`_isSending === true`）时所有消息的 footer
	 * （复制/积分/token 消耗/耗时）都被隐藏，避免在迭代过程中刷屏。
	 * loop 结束后只补齐**最后一条** assistant 消息的 footer —— 用户可见
	 * 的"本轮统计"已在该消息上累计（多次 usage 事件累加）。
	 *
	 * 注意：中间迭代消息保持无 footer，避免视觉噪音。
	 */
	private _revealFootersAfterLoop(): void {
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
		// 补齐 footer（如果还没有）
		if (!bubble.querySelector('.chat-bubble-footer')) {
			bubble.appendChild(this._createFooter(lastAssistant));
		}
	}

	/**
	 * 根据消息 id 查找 DOM 元素。
	 */
	private _findMessageElementById(id: string): HTMLElement | null {
		if (!this._messagesContainer) { return null; }
		return this._messagesContainer.querySelector(`[data-msg-id="${id}"]`);
	}

	/**
	 * 流式结束后调度延迟滚动——rAF 循环已停止，但 slow-path 重建
	 * （footer、token popup、markdown 渲染）可能在此之后才完成布局。
	 * 双 rAF 确保：第一帧让浏览器处理 pending layout，第二帧在布局稳定后补滚。
	 */
	private _schedulePostStreamScroll(): void {
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
	 * P2+: 轻量刷新输入区域——移除旧输入区域 DOM 并重新渲染。
	 * 用于 provider/model 变化时避免 _render() 全量重建（header + 消息列表 + 输入区域）。
	 */
	private _refreshInputArea(): void {
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

	/** 设置工作区列表（外部调用） */
	setWorkspaces(items: ReadonlyArray<IWorkspaceItem>): void {
		this._workspaces = items.slice();
		// P0: 轻量刷新输入区替代 _render()——避免 board change reload 时
		// 第 4 次全量消息重建（setWorkspaces → _render → _renderMessages）
		if (this._agent) { this._refreshInputArea(); }
	}

	/** 设置当前选中工作区 */
	setSelectedWorkspace(id: string): void {
		this._selectedWorkspaceId = id || "";
		// 轻量刷新输入区域（保存/恢复输入框内容），避免 _render() 全量重建清空输入框
		if (this._agent) { this._refreshInputArea(); }
	}

	setChatMode(mode: ChatMode): void {
		this._chatMode = mode;
		if (this._agent) { this._render(); }
	}

	setSessionInfo(info: ISessionInfo | null): void {
		this._sessionInfo = info;
		if (this._agent) { this._render(); }
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

	/** @deprecated 使用 setStreamUsage 替代 */
	setContextUsage(usage: IContextUsage | null): void {
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

	/** 设置流式用量（来自 usage chunk） */
	setStreamUsage(usage: { input?: number; output?: number; seen?: boolean } | null): void {
		this._streamUsage = usage;
		this._updateContextRing();
	}

	/** 设置流式文本缓冲区（用于实时估算） */
	setStreamTextBuffer(buffer: string): void {
		this._streamTextBuffer = buffer;
		this._updateContextRing();
	}

	/** 设置流式思考缓冲区（用于实时估算） */
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

	// Rendering — Full render

	private _render(): void {
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
			// eslint-disable-next-line no-console
			console.warn('[AgentChatPanel] _render: rendering empty state — _agent is null/undefined');
			this._renderEmptyState();
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
			requestAnimationFrame(() => this._scrollToBottom(true));
		});
	}

	private _closeAllDropdowns(): void {
		this._closeAgentDropdown();
		this._closeWorktreeDropdown();
		this._closeWorkspaceDropdown();
		// Message-nav overlay is closed via _activeHeaderPanel (managed in _render())
		if (this._msgNavOverlayEl) {
			this._msgNavOverlayEl.remove();
			this._msgNavOverlayEl = null;
		}
		this._closeModeDropdown();
		this._closeProviderDropdown();
		this._closeModelDropdown();
		this._closeSlashMenu();
	}

	// Tabs Container (editor-style tabs)
	// NOTE: 当前不使用 tabs（与原侧栏样式保持一致）。保留方法以便未来可恢复 multi-agent tabs 功能。
	// @ts-expect-error - reserved for future use
	private _renderTabsContainer(): void {
		// Create tabs container
		const tabsContainer = append(this._container, $('.chat-tabs-container'));

		// Create tabs list (role="tablist")
		this._tabsContainer = append(tabsContainer, $('.chat-tabs', { role: 'tablist' }));

		// Render tabs
		this._renderTabs();
	}

	private _renderTabs(): void {
		if (!this._tabsContainer) {
			return;
		}

		clearNode(this._tabsContainer);

		// Create a tab for each available agent
		for (const agent of this._availableAgents) {
			const tab = append(this._tabsContainer, $('.chat-tab', { role: 'tab' }));

			// Mark active tab
			if (this._agent && agent.id === this._agent.id) {
				tab.classList.add('active');
				tab.setAttribute('aria-selected', 'true');
			} else {
				tab.setAttribute('aria-selected', 'false');
			}

			// Agent avatar/icon
			const avatar = append(tab, $('.chat-tab-avatar'));
			if (agent.avatarUrl) {
				const img = append(avatar, $('img')) as HTMLImageElement;
				img.src = agent.avatarUrl;
				img.alt = agent.name;
				img.style.width = '16px';
				img.style.height = '16px';
				img.style.borderRadius = '2px';
			} else if (agent.icon) {
				// Use icon emoji — no background, matches preset panel style
				const iconEl = append(avatar, $('.chat-tab-avatar-icon'));
				iconEl.textContent = agent.icon;
			} else {
				const fallback = append(avatar, $('.chat-tab-avatar-fallback'));
				fallback.textContent = agent.name.charAt(0).toUpperCase();
			}

			// Agent name
			const label = append(tab, $('.chat-tab-label'));
			label.textContent = agent.name;

			// Click handler to switch agent
			this._register(
				addDisposableListener(tab, EventType.CLICK, () => {
					this._onSelectAgent(agent.id);
				})
			);
		}
	}

	// Empty state

	private _renderEmptyState(): void {
		// 还原原 webview AgentChat.tsx 的空状态结构：
		// <div class="chat-empty">
		//   <div class="chat-empty-inner">
		//     <div class="chat-empty-icon">💬</div>
		//     <h2 class="chat-empty-title">Agent Studio</h2>
		//     <p class="chat-empty-desc">选择一个 Agent 开始对话</p>
		//   </div>
		// </div>
		const empty = append(this._container, $(".chat-empty"));
		const inner = append(empty, $(".chat-empty-inner"));
		append(inner, $(".chat-empty-icon", undefined, "💬"));
		append(inner, $("h2.chat-empty-title", undefined, "Agent Studio"));
		append(inner, $("p.chat-empty-desc", undefined, "选择一个 Agent 开始对话"));
	}

	// Chat Header

	private _renderHeader(): void {
		const emp = this._agent!;
		const status = emp.status as keyof typeof STATUS_MAP;
		const statusInfo = STATUS_MAP[status] || STATUS_MAP[AgentStatus.Idle];

		const header = append(this._container, $(".chat-header"));

		// Left: agent selector dropdown trigger
		const left = append(header, $(".chat-header-left"));

		// Agent selector trigger (clickable, replaces static avatar+name)
		this._agentSelectorTrigger = append(left, $(".chat-header-agent-selector"));

		// Avatar with status dot
		const avatarWrap = append(this._agentSelectorTrigger, $(".chat-header-avatar-wrap"));
		const avatarBorder = append(avatarWrap, $(".chat-header-avatar-border"));
		if (emp.avatarUrl) {
			const img = append(
				avatarBorder,
				$("img.chat-header-avatar-img"),
			) as HTMLImageElement;
			img.src = emp.avatarUrl;
			img.alt = emp.name;
		} else if (emp.icon) {
			// Use icon emoji — no background, matches preset panel style
			const iconEl = append(avatarBorder, $(".chat-header-avatar-icon"));
			iconEl.textContent = emp.icon;
		} else {
			const fallback = append(avatarBorder, $(".chat-header-avatar-fallback"));
			fallback.textContent = emp.name.charAt(0).toUpperCase();
		}
		const statusDot = append(avatarWrap, $(".chat-header-status-dot"));
		statusDot.style.backgroundColor = statusInfo.dot;
		if (statusInfo.animated) {
			statusDot.classList.add("animated");
		}

		// Name + role
		const info = append(this._agentSelectorTrigger, $(".chat-header-info"));
		append(info, $("span.chat-header-name", undefined, emp.name));
		const roleText = emp.role?.split(/[，,]/)[0] || "";
		append(
			info,
			$(
				"span.chat-header-role",
				undefined,
				`${roleText} · ${statusInfo.label}`,
			),
		);

		// Chevron icon for dropdown
		const chevronWrap = append(this._agentSelectorTrigger, $(".chat-header-dropdown-chevron"));
		const chevronSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		chevronSvg.setAttribute("width", "12");
		chevronSvg.setAttribute("height", "12");
		chevronSvg.setAttribute("viewBox", "0 0 24 24");
		chevronSvg.setAttribute("fill", "none");
		chevronSvg.setAttribute("stroke", "currentColor");
		chevronSvg.setAttribute("stroke-width", "2.5");
		chevronSvg.setAttribute("stroke-linecap", "round");
		chevronSvg.setAttribute("stroke-linejoin", "round");
		const chevronPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
		chevronPath.setAttribute("d", "M6 9l6 6 6-6");
		chevronSvg.appendChild(chevronPath);
		chevronWrap.appendChild(chevronSvg);

		// Click handler for dropdown toggle
		this._register(
			addDisposableListener(this._agentSelectorTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._dropdownOpen) {
					this._closeAgentDropdown();
				} else {
					this._openAgentDropdown();
				}
			}),
		);

		// Auto-orchestrate toggle (PM only) — REMOVED: task orchestration entry point closed

		// Spacer
		append(left, $(".chat-header-spacer"));

	// Right: action buttons (message-nav / new / history / settings / html preview)
	const actions = append(header, $(".chat-header-actions"));

	// HTML 预览按钮——使用 Codicon 原生图标（小眼睛）
		const htmlPreviewBtn = append(actions, $("button.chat-header-action-btn.chat-header-btn"));
		htmlPreviewBtn.title = 'HTML 预览';
		const eyeIcon = append(htmlPreviewBtn, $("span.codicon.codicon-eye"));
		eyeIcon.style.fontSize = '15px';
		this._register(
			addDisposableListener(htmlPreviewBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onOpenHtmlPreview?.();
			}),
		);

		// 1. Message-nav (会话消息列表)
		this._msgNavTrigger = this._appendHeaderActionBtn(actions, {
			title: '会话消息列表',
			svgPath: 'M4 6h16M4 12h10M4 18h16',
		});
		// Disable if no user messages
		const userMsgCount = this._messages.filter(m => m.role === 'user').length;
		if (userMsgCount === 0) {
			this._msgNavTrigger.classList.add('disabled');
			this._msgNavTrigger.setAttribute('aria-disabled', 'true');
		}
		if (this._activeHeaderPanel === 'message-nav') {
			this._msgNavTrigger.classList.add('active');
		}
		this._register(
			addDisposableListener(this._msgNavTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._msgNavTrigger && this._msgNavTrigger.classList.contains('disabled')) { return; }
				// Toggle: same pattern as history button
				if (this._activeHeaderPanel === 'message-nav') {
					this._activeHeaderPanel = null;
				} else {
					this._activeHeaderPanel = 'message-nav';
				}
				this._render();
			}),
		);

		// 2. New session (+)
		const newBtn = this._appendHeaderActionBtn(actions, {
			title: '新建会话',
			svgPath: 'M12 5v14M5 12h14',
		});
		this._register(
			addDisposableListener(newBtn, EventType.CLICK, () => {
				console.log('[AgentChatPanel] New Session button clicked, _onNewSession exists:', !!this._onNewSession);
				try {
					this._onNewSession?.();
				} catch (err) {
					console.error('[AgentChatPanel] Error in _onNewSession:', err);
				}
			}),
		);

		// 3. History (clock icon)
		const historyBtn = this._appendHeaderActionBtn(actions, {
			title: '聊天历史',
			svgPath: 'M12 8v4l3 2',
		});
		// Add the outer circle for the clock icon
		const historyClockSvg = historyBtn.querySelector('svg');
		if (historyClockSvg) {
			const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
			c.setAttribute('cx', '12');
			c.setAttribute('cy', '12');
			c.setAttribute('r', '9');
			historyClockSvg.insertBefore(c, historyClockSvg.firstChild);
		}
		if (this._activeHeaderPanel === 'history') {
			historyBtn.classList.add('active');
		}
		this._register(
			addDisposableListener(historyBtn, EventType.CLICK, () => {
				this._activeHeaderPanel = this._activeHeaderPanel === 'history' ? null : 'history';
				this._render();
			}),
		);

		// 4. Settings (gear)
		const settingsBtn = this._appendHeaderActionBtn(actions, {
			title: '设置',
			svgPath: 'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
		});
		const gearSvg = settingsBtn.querySelector('svg');
		if (gearSvg) {
			const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
			c.setAttribute('cx', '12');
			c.setAttribute('cy', '12');
			c.setAttribute('r', '3');
			gearSvg.insertBefore(c, gearSvg.firstChild);
		}
	this._register(
		addDisposableListener(settingsBtn, EventType.CLICK, () => {
			if (this._activeHeaderPanel === 'settings') {
				this._activeHeaderPanel = null;
			} else {
				this._activeHeaderPanel = 'settings';
			}
			this._render();
		}),
	);
	}

	// Header-action button helper
	private _appendHeaderActionBtn(parent: HTMLElement, opts: { title: string; svgPath: string }): HTMLElement {
		const el = append(parent, $(".chat-header-action-btn.chat-header-btn"));
		el.title = opts.title;
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("width", "15");
		svg.setAttribute("height", "15");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "2");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
		pathEl.setAttribute("d", opts.svgPath);
		svg.appendChild(pathEl);
		el.appendChild(svg);
		return el;
	}



// Agent dropdown — open / close / render

	private _openAgentDropdown(): void {
		if (this._dropdownOpen) { return; }
		this._dropdownOpen = true;
		this._dropdownFilter = "";

		// Toggle chevron rotation via class
		if (this._agentSelectorTrigger) {
			this._agentSelectorTrigger.classList.add("open");
		}

		// Create dropdown panel on document.body to avoid any overflow:hidden clipping
		this._agentDropdownEl = append(mainWindow.document.body, $(".chat-agent-dropdown"));

		// Fixed position aligned to the chat container
		const containerRect = this._container.getBoundingClientRect();
		const headerHeight = 52; // approximate header height (padding + content + border)
		this._agentDropdownEl.style.position = "fixed";
		this._agentDropdownEl.style.top = (containerRect.top + headerHeight) + "px";
		this._agentDropdownEl.style.left = (containerRect.left + 14) + "px";
		this._agentDropdownEl.style.width = (containerRect.width - 28) + "px";
		this._agentDropdownEl.style.maxHeight = Math.min(320, containerRect.bottom - containerRect.top - headerHeight - 20) + "px";

		this._renderAgentDropdownContent();

		// Close on outside click
		const outsideHandler = addDisposableListener(mainWindow.document.body, EventType.CLICK, (e) => {
			if (this._agentDropdownEl && !this._agentDropdownEl.contains(e.target as Node) &&
				this._agentSelectorTrigger && !this._agentSelectorTrigger.contains(e.target as Node)) {
				this._closeAgentDropdown();
			}
		});
		this._register(outsideHandler);

		// Auto-focus search
		if (this._agentSearchInput) {
			this._agentSearchInput.focus();
		}
	}

	private _closeAgentDropdown(): void {
		if (!this._dropdownOpen) { return; }
		this._dropdownOpen = false;

		if (this._agentSelectorTrigger) {
			this._agentSelectorTrigger.classList.remove("open");
		}

		if (this._agentDropdownEl) {
			this._agentDropdownEl.remove();
			this._agentDropdownEl = null;
		}
		this._agentSearchInput = null;
		this._agentDropdownList = null;
		this._dropdownFilter = "";
	}

	private _renderAgentDropdownContent(): void {
		if (!this._agentDropdownEl) { return; }

		// Search input
		const searchWrap = append(this._agentDropdownEl, $(".chat-agent-dropdown-search"));
		const searchIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		searchIcon.setAttribute("width", "14");
		searchIcon.setAttribute("height", "14");
		searchIcon.setAttribute("viewBox", "0 0 24 24");
		searchIcon.setAttribute("fill", "none");
		searchIcon.setAttribute("stroke", "currentColor");
		searchIcon.setAttribute("stroke-width", "2");
		searchIcon.classList.add("search-icon");
		const circleEl = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		circleEl.setAttribute("cx", "11");
		circleEl.setAttribute("cy", "11");
		circleEl.setAttribute("r", "8");
		searchIcon.appendChild(circleEl);
		const lineEl = document.createElementNS("http://www.w3.org/2000/svg", "line");
		lineEl.setAttribute("x1", "21");
		lineEl.setAttribute("y1", "21");
		lineEl.setAttribute("x2", "16.65");
		lineEl.setAttribute("y2", "16.65");
		searchIcon.appendChild(lineEl);
		searchWrap.appendChild(searchIcon);

		this._agentSearchInput = append(searchWrap, $("input.chat-agent-dropdown-input")) as HTMLInputElement;
		this._agentSearchInput.placeholder = "搜索 Agent...";
		this._agentSearchInput.value = this._dropdownFilter;

		this._register(
			addDisposableListener(this._agentSearchInput, EventType.INPUT, () => {
				this._dropdownFilter = this._agentSearchInput?.value || "";
				this._renderAgentList();
			}),
		);

		// Prevent Enter key from bubbling up
		this._register(
			addDisposableListener(this._agentSearchInput, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === "Escape") {
					this._closeAgentDropdown();
				}
				e.stopPropagation();
			}),
		);

		// Agent list
		this._agentDropdownList = append(this._agentDropdownEl, $(".chat-agent-dropdown-list"));
		this._renderAgentList();
	}

	private _renderAgentList(): void {
		if (!this._agentDropdownList) { return; }
		clearNode(this._agentDropdownList);

		const filter = this._dropdownFilter.toLowerCase().trim();
		const filtered = filter
			? this._availableAgents.filter(e =>
				e.name.toLowerCase().includes(filter) ||
				e.role.toLowerCase().includes(filter)
			)
			: this._availableAgents;

		if (filtered.length === 0) {
			const noResults = append(this._agentDropdownList, $(".chat-agent-dropdown-no-results"));
			noResults.textContent = "未找到匹配的 Agent";
			return;
		}

		for (const agent of filtered) {
			const item = append(this._agentDropdownList, $(".chat-agent-dropdown-item"));
			if (this._agent?.id === agent.id) {
				item.classList.add("active");
			}

			// Mini avatar
			const miniAvatar = append(item, $(".chat-agent-dropdown-item-avatar"));
			if (agent.avatarUrl) {
				const img = append(miniAvatar, $("img")) as HTMLImageElement;
				img.src = agent.avatarUrl;
				img.alt = agent.name;
			} else if (agent.icon) {
				// Use icon emoji — no background, matches preset panel style
				const iconEl = append(miniAvatar, $(".chat-agent-dropdown-item-avatar-icon"));
				iconEl.textContent = agent.icon;
			} else {
				const fallback = append(miniAvatar, $(".chat-agent-dropdown-item-avatar-fallback"));
				fallback.textContent = agent.name.charAt(0).toUpperCase();
			}

			// Name + role
			const itemInfo = append(item, $(".chat-agent-dropdown-item-info"));
			append(itemInfo, $(".chat-agent-dropdown-item-name", undefined, agent.name));
			const roleText = agent.role?.split(/[，,]/)[0] || "";
			append(itemInfo, $(".chat-agent-dropdown-item-role", undefined, roleText));

			// Click to select (mirrors React AgentChat.tsx logic)
			this._register(
				addDisposableListener(item, EventType.CLICK, (e) => {
					e.stopPropagation();
					// Select agent first (matches React: selectAgent + setActiveAgent)
					if (agent.id !== this._agent?.id) {
						this._onSelectAgent(agent.id);
					}
					// Then close dropdown and clear filter (matches React: setDropdownOpen + setDropdownFilter)
					this._closeAgentDropdown();
				}),
			);
		}
	}

	// --- Hermes turn aggregation ---
	// Merges consecutive assistant messages that share the same turnId into single bubbles,
	// matching the React webview displayMessages computed-property behavior.
	private _aggregateTurns(messages: IAgentChatMessage[]): IAgentChatMessage[] {
		if (!messages.length) { return []; }

		const aggregated: IAgentChatMessage[] = [];
		let i = 0;

		while (i < messages.length) {
			const current = messages[i];

			// Skip non-assistant or messages without turnId
			if (current.role !== 'assistant' || !current.turnId) {
				aggregated.push(current);
				i++;
				continue;
			}

			// Collect consecutive assistant messages with same turnId
			const turnId = current.turnId;
			const turnMessages: IAgentChatMessage[] = [current];
			let j = i + 1;
			while (j < messages.length && messages[j].role === 'assistant' && messages[j].turnId === turnId) {
				turnMessages.push(messages[j]);
				j++;
			}

			if (turnMessages.length === 1) {
				aggregated.push(current);
			} else {
				// 阶段E：按 turn 顺序拼接有序 parts（不再做 textPosition 偏移运算）。
				// 每条 turn 消息的 parts 已表达其自身顺序，顺次连接即为整回合的正确顺序，
				// 结构上不可能错位。content/toolCalls 由 parts 反推为派生兼容字段。
				const mergedParts: IMessagePart[] = [];
				for (const tm of turnMessages) {
					const tmParts = (tm.parts && tm.parts.length > 0)
						? tm.parts
						: deriveUiMessageParts(tm.content || '', tm.toolCalls || []);
					// 多 turn 文本之间补一个空行分隔，保持原有 \n\n 视觉间距。
					if (mergedParts.length > 0 && tmParts.length > 0 && tmParts[0].kind === 'text') {
						const lastPart = mergedParts[mergedParts.length - 1];
						if (lastPart.kind === 'text') {
							lastPart.text = `${lastPart.text}\n\n`;
						}
					}
					for (const p of tmParts) {
						mergedParts.push(p.kind === 'text' ? { kind: 'text', text: p.text } : { kind: 'tool', tool: p.tool });
					}
				}
				const flat = flattenMessageParts(mergedParts);

				const lastMsg = turnMessages[turnMessages.length - 1];
				const merged: IAgentChatMessage = {
					...lastMsg,
					id: `turn-${turnId}`,
					content: flat.content,
					toolCalls: flat.toolCalls.length > 0 ? flat.toolCalls : undefined,
					parts: mergedParts.length > 0 ? mergedParts : undefined,
					thinking: turnMessages.map(m => m.thinking).filter(Boolean).join('\n\n') || undefined,
				};
				aggregated.push(merged);
			}

			i = j;
		}

		return aggregated;
	}

	// Messages area

	private _renderMessagesArea(): void {
		this._messagesWrapper = append(
			this._container,
			$(".chat-messages-wrapper"),
		);
		this._messagesContainer = append(
			this._messagesWrapper,
			$(".chat-messages"),
		);

		const SCROLL_THRESHOLD = 80; // 匹配 React 80px 阈值

		// ── 辅助：检测是否在底部 ──
		const checkAtBottom = (): boolean => {
			if (!this._messagesContainer) { return false; }
			const el = this._messagesContainer;
			return (el.scrollHeight - el.scrollTop - el.clientHeight) < SCROLL_THRESHOLD;
		};

		// ── 辅助：更新按钮可见性 ──
		const updateScrollButtons = (atBottom: boolean) => {
			const show = !atBottom;
			if (show !== this._showScrollBtn) {
				this._showScrollBtn = show;
				if (this._scrollToBottomBtn) {
					this._scrollToBottomBtn.style.display = show ? "flex" : "none";
				}
			}
		};

		// ── SCROLL 事件：恢复/暂停自动滚动（rAF 节流）──
		let scrollRafId: number | null = null;
		this._register(
			addDisposableListener(this._messagesContainer, EventType.SCROLL, () => {
				if (scrollRafId !== null) { return; }
				scrollRafId = requestAnimationFrame(() => {
					scrollRafId = null;
					const atBottom = checkAtBottom();
					// 拖拽滚动条期间不更新 _isAtBottom（由 MOUSE_DOWN/UP 控制）
					if (!this._isDraggingScrollbar) {
						if (atBottom) {
							this._isAtBottom = true;
							// 用户手动滚到底部 → 清零未读计数
							if (this._unreadCount > 0) {
								this._unreadCount = 0;
								this._updateScrollBadge();
							}
						} else if (!this._isSending) {
							// 非流式期间，滚离底部 → 暂停自动跟随
							this._isAtBottom = false;
						}
					}
					// 流式期间由 _startStreamScroll rAF 循环持续钉底，
					// 程序滚动触发的 SCROLL 事件不更新按钮（避免异步内容增长导致的误闪）
					if (!this._isSending) {
						updateScrollButtons(atBottom);
					}
				});
			}),
		);
		this._register({ dispose: () => { if (scrollRafId !== null) { cancelAnimationFrame(scrollRafId); } } });

		// ── WHEEL 事件：精细控制自动滚动 ──
		this._register(
			addDisposableListener(this._messagesContainer, EventType.WHEEL, (e: WheelEvent) => {
				if (e.deltaY < 0) {
					// 向上滚 → 立即暂停自动滚动
					this._isAtBottom = false;
					updateScrollButtons(false);
				} else if (e.deltaY > 0) {
					// 向下滚 → 检测是否到底，恢复自动跟随
					requestAnimationFrame(() => {
						if (checkAtBottom()) {
							this._isAtBottom = true;
							updateScrollButtons(true);
						}
					});
				}
			}),
		);

		// ── TOUCHSTART：触屏设备暂停自动滚动 ──
		this._register(
			addDisposableListener(this._messagesContainer, 'touchstart', () => {
				this._isAtBottom = false;
				updateScrollButtons(false);
			}),
		);

		// ── 创建下箭头 SVG ──
		const createDownArrowSvg = () => {
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "20");
			svg.setAttribute("height", "20");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor");
			svg.setAttribute("stroke-width", "2.5");
			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			path.setAttribute("d", "M12 5v14M5 12l7 7 7-7");
			path.setAttribute("stroke-linecap", "round");
			path.setAttribute("stroke-linejoin", "round");
			svg.appendChild(path);
			return svg;
		};

		// ── 回到底部按钮 ──
		this._scrollToBottomBtn = append(
			this._messagesWrapper,
			$(".scroll-to-bottom-btn.chat-scroll-bottom-btn"),
		);
		this._scrollToBottomBtn.style.display = "none";
		this._scrollToBottomBtn.appendChild(createDownArrowSvg());
		this._scrollToBottomBtn.title = "回到底部";
		// 未读消息计数 badge
		this._scrollBadge = append(this._scrollToBottomBtn, $('.scroll-badge'));
		this._scrollBadge.style.display = 'none';
		this._register(
			addDisposableListener(this._scrollToBottomBtn, EventType.CLICK, () => {
				// 平滑滚动到底部 + 清零未读计数
				if (this._messagesContainer) {
					this._messagesContainer.scrollTo({ top: this._messagesContainer.scrollHeight, behavior: 'smooth' });
				}
				this._isAtBottom = true;
				this._unreadCount = 0;
				this._updateScrollBadge();
				this._showScrollBtn = false;
				this._scrollToBottomBtn.style.display = "none";
			}),
		);

		// ── 自定义滚动条覆盖层 ──（必须在 _renderMessages 之前创建，
		//    否则 _refreshScrollMarkers 因 _customScrollbar===null 而跳过）
		this._customScrollbar = append(this._messagesWrapper, $('.chat-custom-scrollbar'));
		this._scrollbarTrack = append(this._customScrollbar, $('.chat-scrollbar-track'));
		this._scrollbarThumb = append(this._scrollbarTrack, $('.chat-scrollbar-thumb'));
		// Hover popup
		this._scrollbarPopup = append(this._customScrollbar, $('.chat-marker-popup'));
		const popupLabel = append(this._scrollbarPopup, $('.chat-marker-popup-label'));
		popupLabel.textContent = '用户消息';
		this._scrollbarPopupPreview = append(this._scrollbarPopup, $('.chat-marker-popup-preview'));
		const popupHint = append(this._scrollbarPopup, $('.chat-marker-popup-hint'));
		popupHint.textContent = '点击跳转到该消息';

		// Scroll sync — lightweight separate listener (rAF-throttled)
		this._register(
			addDisposableListener(this._messagesContainer, EventType.SCROLL, () => {
				this._scheduleScrollbarUpdate();
			}),
		);

		// Thumb drag
		let dragStartY = 0;
		let dragStartScrollTop = 0;
		this._register(
			addDisposableListener(this._scrollbarThumb, EventType.MOUSE_DOWN, (e: MouseEvent) => {
				this._isDraggingScrollbar = true;
				// 拖拽开始立即暂停自动钉底，防止流式 rAF 循环把视图拉回底部
				this._isAtBottom = false;
				dragStartY = e.clientY;
				dragStartScrollTop = this._messagesContainer.scrollTop;
				this._scrollbarThumb?.classList.add('dragging');
				e.preventDefault();
			}),
		);
		this._register(
			addDisposableListener(document, EventType.MOUSE_MOVE, (e: MouseEvent) => {
				if (!this._isDraggingScrollbar || !this._scrollbarThumb || !this._scrollbarTrack || !this._messagesContainer) { return; }
				const deltaY = e.clientY - dragStartY;
				const maxScroll = this._messagesContainer.scrollHeight - this._messagesContainer.clientHeight;
				const trackH = this._scrollbarTrack.offsetHeight - this._scrollbarThumb.offsetHeight;
				const scrollDelta = trackH > 0 ? (deltaY / trackH) * maxScroll : 0;
				this._messagesContainer.scrollTop = dragStartScrollTop + scrollDelta;
			}),
		);
		this._register(
			addDisposableListener(document, EventType.MOUSE_UP, () => {
				if (this._isDraggingScrollbar) {
					this._isDraggingScrollbar = false;
					this._scrollbarThumb?.classList.remove('dragging');
					// 拖拽结束：检测是否在底部，恢复自动跟随
					if (checkAtBottom()) {
						this._isAtBottom = true;
					}
				}
			}),
		);

		// Render existing messages (after scrollbar DOM exists so _refreshScrollMarkers works)
		this._renderMessages();

		// Initial update (deferred to next frame so layout is ready)
		this._scheduleScrollbarUpdate();
		// Deferred marker refresh — layout may not be ready during _renderMessages,
		// so retry on next frame when offsetHeight is correct
		requestAnimationFrame(() => this._refreshScrollMarkers());
	}

	private _renderMessages(): void {
		if (!this._messagesContainer) { return; }
		const diagStack = new Error().stack?.split('\n').slice(2, 5).map(s => s.trim()).join(' ← ') || '?';
		console.debug(`[ScrollDiag] _renderMessages count=${this._messages.length} _wasLoading=${this._wasLoading} caller: ${diagStack}`);
		// Clean up all markdown disposables before clearing the DOM,
		// to prevent renderMarkdown disposable leaks across setMessages calls.
		this._cleanupMarkdownDisposables(this._messagesContainer);
		// P2: 断开旧的懒加载 observer
		if (this._lazyLoadObserver) {
			this._lazyLoadObserver.disconnect();
			this._lazyLoadObserver = null;
		}
		clearNode(this._messagesContainer);

		if (this._messages.length === 0) {
			const empty = append(this._messagesContainer, $(".chat-messages-empty"));
			append(empty, $("p", undefined, "还没有消息，开始对话吧"));
			return;
		}

		// P2: 懒加载渲染——只渲染最近的 VISIBLE_CHUNK 条消息，
		// 用户向上滚动时按需加载更早的消息。
		// 参考 VS Code WorkbenchObjectTree 虚拟化（只渲染可见区域）。
		const VISIBLE_CHUNK = 30;
		const total = this._messages.length;

		if (total <= VISIBLE_CHUNK) {
			// 小列表 — 同步渲染全部
			for (const msg of this._messages) {
				this._appendMessageDom(msg);
			}
			return;
		}

		// 大列表 — 只渲染最后 VISIBLE_CHUNK 条，其余懒加载
		const firstBatchStart = Math.max(0, total - VISIBLE_CHUNK);

		// 渲染最近的消息
		for (let i = firstBatchStart; i < total; i++) {
			this._appendMessageDom(this._messages[i]);
		}

		// 设置懒加载——观察第一个消息元素，进入视口时加载更多
		const firstEl = this._messagesContainer.firstElementChild as HTMLElement | null;
		if (firstEl && firstBatchStart > 0) {
			this._setupLazyLoad(firstEl, firstBatchStart);
		}

		// 刷新滚动条用户消息标记
		this._refreshScrollMarkers();
	}

	/**
	 * P2: 懒加载设置——使用 IntersectionObserver 监测第一个消息元素，
	 * 当用户向上滚动接近顶部时，按块加载更早的消息。
	 * 消息按顺序插入到第一个元素之前，保持时间顺序。
	 */
	private _setupLazyLoad(firstEl: HTMLElement, remainingCount: number): void {
		const CHUNK = 20;
		let nextEnd = remainingCount;

		const loadChunk = () => {
			if (!firstEl.isConnected || nextEnd <= 0) { return; }
			const nextStart = Math.max(0, nextEnd - CHUNK);
			const frag = document.createDocumentFragment();
			for (let i = nextStart; i < nextEnd; i++) {
				const el = this._createMessageElement(this._messages[i]);
				frag.appendChild(el);
			}
			// 保持滚动位置：插入前记录 scrollHeight，插入后修正 scrollTop
			const container = this._messagesContainer;
			if (!container) { return; }
			const prevScrollHeight = container.scrollHeight;
			const prevScrollTop = container.scrollTop;
			firstEl.parentNode?.insertBefore(frag, firstEl);
			// 修正滚动位置，避免内容插入后视图跳动
			const scrollDiff = container.scrollHeight - prevScrollHeight;
			if (scrollDiff > 0) {
				container.scrollTop = prevScrollTop + scrollDiff;
			}
			nextEnd = nextStart;
			// 刷新滚动条标记——消息插入后 offsetTop 全部偏移，旧标记位置失效
			this._refreshScrollMarkers();
		};

		const observer = new IntersectionObserver((entries) => {
			if (entries[0]?.isIntersecting && nextEnd > 0) {
				loadChunk();
			}
		}, {
			root: this._messagesContainer,
			threshold: 0.1,
			rootMargin: '200px 0px 0px 0px', // 提前 200px 预加载
		});
		observer.observe(firstEl);
		// P2: 存储到字段，下次 setMessages 时断开
		this._lazyLoadObserver = observer;
	}

	private _appendMessageDom(msg: IAgentChatMessage): void {
		if (!this._messagesContainer) {
			return;
		}
		// Remove empty-state placeholder before appending the first real message.
		// 否则占位元素会一直作为 children[0] 存在，导致 _updateMessageDom 的
		// idx → children 映射整体偏移 1 位（流式更新错误地写到上一条消息的 DOM），
		// 同时 "还没有消息，开始对话吧" 文本也不会消失。
		const emptyEl = this._messagesContainer.querySelector('.chat-messages-empty');
		if (emptyEl) {
			emptyEl.remove();
		}
		const el = this._createMessageElement(msg);
		this._messagesContainer.appendChild(el);
	}

	private _updateMessageDom(idx: number, msg: IAgentChatMessage): void {
		if (!this._messagesContainer) { return; }
		// P2: 使用 data-msg-id 查找元素，解除 idx → children[idx] 硬绑定。
		// 懒加载场景下 DOM 顺序与 _messages 数组顺序可能不一致（老消息后插入）。
		const existingEl = this._messagesContainer.querySelector(`[data-msg-id="${msg.id}"]`) as HTMLElement | null;
		if (!existingEl) { return; }

		// Force rebuild when isThinking state changes — the thinking indicator
		// needs to be added/removed, which fast paths don't handle.
		const existingIndicator = existingEl.querySelector('.thinking-indicator');
		const shouldShowIndicator = !!(msg.isStreaming && msg.isThinking && !msg.thinking);
		if (!!existingIndicator !== shouldShowIndicator) {
			this._rebuildMessageElement(existingEl, msg);
			return;
		}

		const partsToolCount = msg.parts ? msg.parts.filter(p => p.kind === 'tool').length : 0;
		const hasToolCalls = (msg.toolCalls && msg.toolCalls.length > 0) || partsToolCount > 0;
		const hasStructuralChange =
			hasToolCalls ||
			msg.confirmation ||
			(msg.subAgents && msg.subAgents.length > 0) ||
			(msg.workflowExecutions && Object.keys(msg.workflowExecutions).length > 0) ||
			(msg.workflowEvents && msg.workflowEvents.length > 0) ||
			(msg.collectVariables && Object.keys(msg.collectVariables).length > 0);

		// Fast path 1: no structural change, streaming text-only update
		if (!hasStructuralChange && msg.isStreaming && msg.content) {
			const streamingContainer = existingEl.querySelector('.streaming-container') as HTMLElement | null;
			const streamingText = existingEl.querySelector('.streaming-text') as HTMLSpanElement | null;

			if (streamingContainer) {
				// 节流 markdown 渲染：delta 到达时仅更新缓存内容，不立即操作 DOM。
				// 定时器每 200ms 做一次增量/全量 markdown 渲染。
				// 首次渲染之前（_streamingMdLastRendered 为空）用 textContent 显示纯文本，
				// 让用户立即看到输出；首次 markdown 渲染后不再覆盖，由增量更新追加。
				if (!this._streamingMdLastRendered) {
					streamingContainer.textContent = msg.content;
				}
				this._streamingMdTarget = { container: streamingContainer };
				this._streamingMdLastContent = msg.content;
				if (this._streamingMdTimer === null) {
					this._streamingMdTimer = window.setTimeout(() => {
						this._streamingMdTimer = null;
						const target = this._streamingMdTarget;
						if (!target || !target.container.isConnected || !this._streamingMdLastContent) { return; }
						// P0: 内容未变 → 跳过渲染
						if (this._streamingMdLastContent === this._streamingMdLastRendered) { return; }
						// P0: 尝试增量更新——只渲染追加部分，避免全量 re-parse
						if (this._tryIncrementalMarkdownRender(target.container, this._streamingMdLastContent)) {
							return;
						}
					// 全量重建 — 离屏渲染后原子替换，避免 textContent='' 导致的空白帧闪烁
					{
						const tempDiv = document.createElement('div');
						this._renderMarkdownContent(tempDiv, this._streamingMdLastContent, true);
						const children = Array.from(tempDiv.childNodes);
						target.container.replaceChildren(...children);
					}
						this._streamingMdLastRendered = this._streamingMdLastContent;
					}, AgentChatPanel.STREAMING_MD_INTERVAL);
				}
				return;
			}

			if (streamingText) {
				streamingText.textContent = msg.content;
				return;
			}
		}

		// Fast path 2: tool cards already rendered in DOM — only update text content in place
		// 参考 void：工具调用渲染后，后续流式文本只更新内容区域，不重复重建卡片
		if (msg.isStreaming && msg.content && hasToolCalls) {
			const existingToolCards = existingEl.querySelectorAll('.tool-header-wrapper');
			if (existingToolCards.length > 0) {
				// Tool cards are already present in DOM — update only the content parts
				this._updateStreamingContentInPlace(existingEl, msg);
				return;
			}
		}

		// Slow path: rebuild this single message element and replace in DOM
		// Clean up any markdown disposables associated with the old element
		// before replacing it, to prevent renderMarkdown() disposable leaks.

		// P1: 流式结束转换——isStreaming 从 true 变为 false 时。
		// 条件：之前在流式（有 streaming-container 或 streaming-cursor），现在不流式。
		const wasStreaming = existingEl.querySelector('.streaming-container, .streaming-cursor') !== null;
		if (wasStreaming && !msg.isStreaming) {
			if (!hasStructuralChange) {
				// 无结构性变化：轻量转换——移除光标 + 渲染 markdown + 追加 footer。
				this._transitionStreamingToComplete(existingEl, msg);
			} else {
				// 结构性消息（含工具卡/确认/子代理/工作流）流式结束：
				// 旧逻辑落到下方「只更新工具卡状态 + footer」的分支，不会重渲染正文，
				// 导致流式期间以 raw text / 半渲染残留的正文（如大段 HTML mockup）在
				// 结束后依旧错乱。这里以最终完整 parts/content 做一次干净全量重建
				// （与历史恢复路径完全一致），彻底消除流式增量渲染累积的错位。
				// 重建仅在流式结束时发生一次，开销可接受。
				this._streamingMdLastRendered = '';
				this._streamingMdLastContent = '';
				this._streamingMdTarget = null;
				this._rebuildMessageElement(existingEl, msg);
			}
			return;
		}

		// P1.5: 流式期间首个 tool_start → 增量追加工具卡，避免
		// replaceChild 导致 scrollHeight 突变 → 滚动条跳动。
		if (msg.isStreaming && hasToolCalls) {
			const existingCards = existingEl.querySelectorAll('.tool-header-wrapper[data-tool-id]');
			if (existingCards.length === 0) {
			const container = existingEl.querySelector('.chat-bubble') as HTMLElement || existingEl;
			for (const tc of msg.toolCalls || []) {
				if (!tc.id) continue;
				this._appendToolCard(container, tc, msg);
			}
				return;
			}
		}

		// P2+: 非流式工具卡增量更新——如果已有工具卡且 ID 匹配（仅状态/结果变化），
		// 只更新变化的工具卡，不重建整条消息。
		if (hasToolCalls && !msg.isStreaming) {
			const existingCards = existingEl.querySelectorAll('.tool-header-wrapper[data-tool-id]');
			const newToolIds = (msg.toolCalls || []).map(tc => tc.id).filter(Boolean);
			if (existingCards.length === newToolIds.length && existingCards.length > 0) {
				const existingIds = Array.from(existingCards).map(c => c.getAttribute('data-tool-id'));
				const idsMatch = newToolIds.every((id, i) => existingIds[i] === id);
				if (idsMatch) {
					// 流式刚结束 → 移除光标 + streaming-container class + 追加 footer
					// Agent loop 进行中（_isSending === true）时跳过 footer 渲染，
					// 避免复制/积分/token 消耗信息在中间迭代中刷屏。
					// loop 结束后由 setSending(false) 统一补齐。
					const bubble = existingEl.querySelector('.chat-bubble');
					if (bubble) {
						bubble.querySelectorAll('.streaming-cursor').forEach(el => el.remove());
						const sc = bubble.querySelector('.streaming-container');
						if (sc) { sc.classList.remove('streaming-container'); }
						if (!this._isSending && !bubble.querySelector('.chat-bubble-footer')) {
							bubble.appendChild(this._createFooter(msg));
						}
					}
					this._updateToolCardStatuses(existingEl, msg);
					return;
				}
			}
		}

		this._cleanupMarkdownDisposables(existingEl);
		const newEl = this._createMessageElement(msg);
		this._messagesContainer.replaceChild(newEl, existingEl);
	}

	/**
	 * 增量更新流式内容（工具卡片已渲染后在流式过程中不断更新文本）
	 * 参考 void：保留工具调用卡片，只更新已渲染的 Markdown 内容区域
	 */
	private _updateStreamingContentInPlace(existingEl: HTMLElement, msg: IAgentChatMessage): void {
		// 检测工具调用结构是否发生变化（新增或移除工具卡片）
		const existingToolCards = existingEl.querySelectorAll('.tool-header-wrapper');
		const newToolCount = msg.parts
			? msg.parts.filter(p => p.kind === 'tool').length
			: (msg.toolCalls?.length ?? 0);

		if (existingToolCards.length !== newToolCount) {
			// 结构变化：完整重建
			this._rebuildMessageElement(existingEl, msg);
			return;
		}

		// 阶段E：parts 多段文本与工具卡交织 → 增量更新复杂，直接完整重建（与旧 interleaved 行为一致）
		const partsSegments = existingEl.querySelectorAll('.parts-text-segment, .interleaved-segment');
		if (partsSegments.length > 0 || (msg.parts && msg.parts.filter(p => p.kind === 'tool').length > 0)) {
			this._rebuildMessageElement(existingEl, msg);
			return;
		}

		// 简单模式：streaming-container + 工具卡片分离 → 只更新文本容器
		const streamingContainer = existingEl.querySelector('.streaming-container') as HTMLElement | null;
		if (streamingContainer) {
			// P2+: 增量更新工具卡状态（running → success/error 等），不重建整条消息
			this._updateToolCardStatuses(existingEl, msg);
			// 节流 markdown 渲染：delta 到达时仅更新缓存内容，不立即操作 DOM。
			// 首次渲染之前（_streamingMdLastRendered 为空）用 textContent 显示纯文本。
			if (!this._streamingMdLastRendered) {
				// 首次渲染：立即做完整 markdown 渲染（不等 200ms 计时器）。
				// 旧实现先用 textContent 撑 200ms，期间用户看到 raw text（表格 `|` 语法、
				// CSS/HTML 裸露），表现为「流式错乱」。首屏直接 renderMarkdown 保证从
				// 第一个 delta 起就是格式化好的 markdown。后续 delta 仍走节流。
				this._renderMarkdownContent(streamingContainer, msg.content, true);
				this._streamingMdLastRendered = msg.content;
			}
			this._streamingMdTarget = { container: streamingContainer };
			this._streamingMdLastContent = msg.content;
			if (this._streamingMdTimer === null) {
				this._streamingMdTimer = window.setTimeout(() => {
					this._streamingMdTimer = null;
					const target = this._streamingMdTarget;
					if (!target || !target.container.isConnected || !this._streamingMdLastContent) { return; }
					if (this._streamingMdLastContent === this._streamingMdLastRendered) { return; }
					if (this._tryIncrementalMarkdownRender(target.container, this._streamingMdLastContent)) {
						return;
					}
				// 离屏渲染后原子替换，避免空白帧闪烁
				{
					const tempDiv = document.createElement('div');
					this._renderMarkdownContent(tempDiv, this._streamingMdLastContent, true);
					const children = Array.from(tempDiv.childNodes);
					target.container.replaceChildren(...children);
					}
					this._streamingMdLastRendered = this._streamingMdLastContent;
				}, AgentChatPanel.STREAMING_MD_INTERVAL);
			}
			return;
		}

		// 回退：完整重建
		this._rebuildMessageElement(existingEl, msg);
	}

	/** 完整重建消息元素并替换到 DOM */
	private _rebuildMessageElement(existingEl: HTMLElement, msg: IAgentChatMessage): void {
		// Clean up markdown disposables before replacing the old element
		this._cleanupMarkdownDisposables(existingEl);
		const newEl = this._createMessageElement(msg);
		const parent = existingEl.parentNode;
		if (parent) {
			parent.replaceChild(newEl, existingEl);
		}
	}

	/**
	 * P2+: 增量更新工具卡状态——按 data-tool-id 查找工具卡，
	 * 只重建状态变化的卡片，保留其他卡片和消息内容不变。
	 * 参考 VS Code renderChatContentDiff 的逐 part diff + replaceWith。
	 */
	private _updateToolCardStatuses(existingEl: HTMLElement, msg: IAgentChatMessage): void {
		if (!msg.toolCalls || msg.toolCalls.length === 0) { return; }
		const section = existingEl.querySelector('.tool-calls-section');
		if (!section) { return; }

		for (const tc of msg.toolCalls) {
			if (!tc.id) { continue; }
			const oldCard = section.querySelector(`[data-tool-id="${tc.id}"]`) as HTMLElement | null;
			if (!oldCard) { continue; }

			// 比较状态类名——只有状态变化才重建卡片
			const statusMatch = oldCard.className.match(/tool-card-(\w+)/);
			const currentStatus = statusMatch?.[1] ?? '';
			const newStatus = tc.status === 'error' ? 'error'
				: tc.status === 'running' ? 'running'
				: tc.status === 'approval_required' ? 'approval'
				: (tc.status === 'rejected' || tc.status === 'canceled') ? 'rejected'
				: 'success';

			if (currentStatus !== newStatus) {
				const newCard = this._createToolCallCard(tc);
				oldCard.replaceWith(newCard);
			}
		}
	}

	// Message element builder

	private _createMessageElement(msg: IAgentChatMessage): HTMLElement {
		const isUser = msg.role === "user";
		const messageEl = $(`.chat-message.${isUser ? "user" : "assistant"}`);
		messageEl.setAttribute('data-msg-id', msg.id);

		// Assistant avatar
		if (!isUser && this._agent) {
			const avatarWrap = append(messageEl, $(".chat-message-avatar"));
			if (this._agent.avatarUrl) {
				const img = append(avatarWrap, $("img")) as HTMLImageElement;
				img.src = this._agent.avatarUrl;
				img.alt = this._agent.name;
				img.style.width = "100%";
				img.style.height = "100%";
				img.style.objectFit = "cover";
				img.style.borderRadius = "50%";
			} else if (this._agent.icon) {
				// Use icon emoji — no background, matches preset panel style
				const iconEl = append(avatarWrap, $(".chat-avatar-icon"));
				iconEl.textContent = this._agent.icon;
			} else {
				const fallback = append(avatarWrap, $(".chat-avatar-fallback"));
				fallback.textContent = this._agent.name.charAt(0).toUpperCase();
			}
		}

		// Bubble
		const bubble = append(
			messageEl,
			$(`.chat-bubble.${isUser ? "user" : "assistant"}`),
		);

		// Thinking card (assistant only) — only show when there's actual thinking
		// content. When isThinking is true but no thinking text yet, we show a
		// "正在思考..." indicator at the BOTTOM of the bubble instead.
		if (!isUser && msg.thinking) {
			bubble.appendChild(this._createThinkingCard(msg));
		}

		// "正在思考..." indicator 延后到 content + toolCalls 之后 append（见下方）

		// Content + Tool calls — interleaved rendering for assistant messages
		// (Void-inspired: tool cards inserted at text positions inside markdown),
		// simple rendering for user messages.
		// NOTE: Always use Markdown rendering for assistant messages (including streaming)
		// to ensure code blocks, inline code, and other Markdown features render correctly.

		// 附件（图片/文件）—— 与输入框 chip 样式一致，气泡内只读展示（无删除按钮，图片可点击放大）
		if (isUser && msg.attachments && msg.attachments.length > 0) {
			const attWrap = append(bubble, $('.message-attachments'));
			attWrap.style.display = 'flex';
			attWrap.style.flexWrap = 'wrap';
			attWrap.style.gap = '4px';
			attWrap.style.marginBottom = msg.content ? '6px' : '0';
			for (const att of msg.attachments) {
				attWrap.appendChild(this._createReadOnlyAttachmentChip(att));
			}
		}

		if (isUser && msg.content) {
			// Task prompt card: render from structured data when available
			// (avoids the fragile regex-parse anti-pattern).
			const taskCardData = msg.taskCard;
			if (taskCardData) {
				const card = this._buildTaskCardFromData(taskCardData);
				if (card) { bubble.appendChild(card); }
				// Show plain text content below the card
				if (msg.content) {
					const contentEl = append(bubble, $('.message-content'));
					this._renderUserContent(contentEl, msg.content);
				}
			} else {
				const contentEl = append(bubble, $('.message-content'));
				this._renderUserContent(contentEl, msg.content);
			}
			// Hover action buttons: edit / copy / undo (Void-style, shown below-bubble on hover)
			this._addMessageActionButtons(bubble, msg);
		} else if (!isUser && msg.parts && msg.parts.length > 0) {
			// 阶段E：有序 parts 是渲染唯一真相 —— 按数组顺序遍历，
			// 文本段→markdown，工具段→工具卡。结构上不可能错位（取代 textPosition）。
			this._renderPartsContent(bubble, msg.parts, !!msg.isStreaming);
			// 有工具卡时标记 bubble，CSS 会隐藏文本内嵌光标（改用底部光标）
			const hasTool = msg.parts.some(p => p.kind === 'tool');
			if (hasTool) { bubble.classList.add('has-tool-cards'); }
		} else if (!isUser && msg.content) {
			// 回退（无 parts，多见于直连模式早期流式）：content 作 Markdown，附加工具卡。
			const contentEl = append(bubble, $(".message-content"));
			if (msg.isStreaming) {
				contentEl.classList.add('streaming-container');
			}
			this._renderMarkdownContent(contentEl, msg.content, true);
			if (msg.toolCalls && msg.toolCalls.length > 0) {
				this._appendToolCallsWithPhaseGroups(bubble, msg.toolCalls, msg.streamPhase);
			}
		} else if (!isUser && msg.toolCalls && msg.toolCalls.length > 0) {
			// 回退：工具调用存在但内容为空（流式输出早期阶段常见）
			// 参考 void：工具调用作为独立的进度卡片渲染
			this._appendToolCallsWithPhaseGroups(bubble, msg.toolCalls, msg.streamPhase);
		}

		// Assistant hover actions: 收藏按钮（仅 assistant 消息，内联在 parts/content 后、footer 前）
		if (!isUser && msg.content && this._onFavoriteMessage) {
			this._addMessageActionButtons(bubble, msg);
		}

		// Sub-agent cards (with grouping for parallel execution)
		if (!isUser && msg.subAgents && msg.subAgents.length > 0) {
			const section = append(bubble, $(".subagent-cards-section"));

			// Group sub-agents by groupId (for parallel execution display)
			const groups = new Map<string, ISubAgentData[]>();
			for (const sa of msg.subAgents) {
				const groupKey = sa.groupId || 'default';
				if (!groups.has(groupKey)) {
					groups.set(groupKey, []);
				}
				groups.get(groupKey)!.push(sa);
			}

			// Render grouped sub-agents
			for (const [groupId, agents] of groups) {
				// If multiple groups, add a group label
				if (groups.size > 1) {
					const groupLabel = append(section, $('.subagent-group-label'));
					const groupText = groupId === 'default' ? 'SubAgents' : `批次 ${groupId} (${agents.length} 个任务)`;
					groupLabel.textContent = groupText;
				}

				// Render each sub-agent in this group
				for (const sa of agents) {
					section.appendChild(this._createSubAgentCard(sa));
				}
			}
		}

		// LiveWorkflowTraceView — collapsible workflow execution trace
		if (!isUser && msg.workflowExecutions && Object.keys(msg.workflowExecutions).length > 0) {
			bubble.appendChild(this._createLiveWorkflowTraceView(
				msg.workflowExecutions,
				msg.workflowEvents,
				msg.collectVariables
			));
		}

		// Confirmation card
		if (!isUser && msg.confirmation && msg.confirmation.status === 'pending') {
			bubble.appendChild(this._createConfirmationCard(msg.confirmation));
		}

		// AskUser cards (workflow interactive input)
		if (!isUser && msg.askUsers && msg.askUsers.length > 0) {
			for (const askUser of msg.askUsers) {
				bubble.appendChild(this._createAskUserCard(askUser));
			}
		}

		// TodoList card
		if (!isUser && msg.todos && msg.todos.length > 0) {
			bubble.appendChild(this._createTodoListCard(msg.todos));
		}

		// QuestionCarousel card
		if (!isUser && msg.questions && msg.questions.length > 0) {
			bubble.appendChild(this._createQuestionCarouselCard(msg.questions));
		}

		// References card
		if (!isUser && msg.references && msg.references.length > 0) {
			bubble.appendChild(this._createReferencesCard(msg.references));
		}

		// Tip card
		if (!isUser && msg.tip) {
			bubble.appendChild(this._createTipCard(msg.tip));
		}

		// Progress card
		if (!isUser && msg.progress && msg.progress.length > 0) {
			bubble.appendChild(this._createProgressCard(msg.progress));
		}

		// Stream error — structured error card with retry button
		if (!isUser && msg.metadata?.['streamError']) {
			bubble.appendChild(this._createStreamErrorCard(msg));
		}

		// "正在思考..." indicator — 位于 bubble 底部（content + toolCalls 之后、streaming-cursor 之前）
		if (!isUser && msg.isStreaming && msg.isThinking && !msg.thinking) {
			bubble.appendChild(this._createThinkingIndicator());
		}

		// Streaming cursor — 策略：
		//   有工具卡/工作流卡时：文本内嵌光标已由 CSS 隐藏，
		//               改用气泡末尾的 span.streaming-cursor 跟在所有内容之后。
		//   无工具卡时：仅在无 `.streaming-container` 时显示（否则 `::after` 已在文本末尾渲染光标）。
		if (!isUser && msg.isStreaming) {
			const hasToolCards = bubble.querySelector('.tool-header-wrapper') !== null;
			const hasWorkflowTrace = bubble.querySelector('.wf-trace') !== null;
			if (hasToolCards || hasWorkflowTrace || !bubble.querySelector('.streaming-container')) {
				append(bubble, $("span.streaming-cursor")).textContent = "|";
			}
		}

		// Footer: copy | score | tokens | duration — 仅在 LLM 流式输出结束后显示
		// Agent loop 进行中（_isSending === true）时暂时不渲染 footer，避免：
		//   - 复制/积分/token 消耗信息刷屏
		//   - 用户看到部分统计就误以为循环结束
		// loop 结束后由 setSending(false) → _revealFootersAfterLoop() 统一补齐最后一条消息的 footer
		if (!isUser && !msg.isStreaming && !this._isSending) {
			bubble.appendChild(this._createFooter(msg));
		}

		return messageEl;
	}

	/**
	 * P1: 创建消息底部 footer（复制/积分/Tokens/耗时）。
	 * 从 _createMessageElement 中提取，供 _transitionStreamingToComplete 复用。
	 */
	private _createFooter(msg: IAgentChatMessage): HTMLElement {
		// 空消息（无内容也无非错误工具调用）不渲染 footer，避免显示「空 bubble + 复制按钮 + 耗时」视觉噪音
		// —— 错误是首个 delta 时，_initStreamingMessage 创建的占位消息应保持完全空白。
		const realContent = (msg.content ?? '').trim()
			&& !/^(正在思考|Thinking\.\.\.)$/.test((msg.content ?? '').trim());
		const hasRealToolCalls = (msg.toolCalls ?? []).some(
			(tc: any) => tc?.name !== 'llm_error',
		);
		if (!realContent && !hasRealToolCalls) {
			// 返回占位 footer（空元素），调用方 append 后不会显示任何内容
			return $('.chat-bubble-footer');
		}

		const footer = $(".chat-bubble-footer");

		// ── 复制按钮（样式同用户消息的复制按钮）──
		const copyBtn = append(footer, $("button.chat-msg-action-btn.chat-msg-copy-btn")) as HTMLButtonElement;
		copyBtn.title = "复制";
		const copySvg = this._svgCopyIcon();
		copyBtn.appendChild(copySvg);
		this._register(addDisposableListener(copyBtn, EventType.CLICK, async (e: Event) => {
			e.stopPropagation();
			const ok = await this._copyToClipboard(msg.content ?? '');
			if (ok) {
				copyBtn.removeChild(copySvg);
				const checkSvg = this._svgCheckSmall();
				copyBtn.appendChild(checkSvg);
				copyBtn.classList.add("chat-msg-copy-copied");
				setTimeout(() => {
					copyBtn.classList.remove("chat-msg-copy-copied");
					try { copyBtn.removeChild(checkSvg); } catch { /* already removed */ }
					copyBtn.appendChild(copySvg);
				}, 1500);
			}
		}));

		// ── 导入知识库按钮（位于复制按钮右侧；走 importMessageToKnowledgeBase 管线，与顶部收藏按钮同源）──
		if (this._onImportToKnowledgeBase) {
			const importBtn = append(footer, $("button.chat-msg-action-btn.chat-msg-import-kb-btn")) as HTMLButtonElement;
			importBtn.title = "导入知识库";
			const importSvg = this._svgImportKbIcon();
			importBtn.appendChild(importSvg);
			let inFlight = false;
			this._register(addDisposableListener(importBtn, EventType.CLICK, async (e: Event) => {
				e.stopPropagation();
				if (inFlight) { return; } // 防重入：一次导入未完成时屏蔽重复点击
				inFlight = true;
				importBtn.disabled = true;
				try {
					// 复制内容快照：避免流式/外部修改导致 callback 看到不一致文本
					const snapshot = msg.content ?? '';
					await this._onImportToKnowledgeBase!(snapshot);
					// 视觉反馈：图标换成对号 + 绿色（1.5s 后还原）
					importBtn.removeChild(importSvg);
					const checkSvg = this._svgCheckSmall();
					importBtn.appendChild(checkSvg);
					importBtn.classList.add("chat-msg-import-kb-saved");
					setTimeout(() => {
						importBtn.classList.remove("chat-msg-import-kb-saved");
						try { importBtn.removeChild(checkSvg); } catch { /* already removed */ }
						importBtn.appendChild(importSvg);
					}, 1500);
				} finally {
					importBtn.disabled = false;
					inFlight = false;
				}
			}));
		}

		// ── 分隔线 ──
		append(footer, $(".chat-bubble-footer-sep"));

		// ── 积分（pill 样式，$ 图标 + 积分 + 数值）──
		if (msg.tokenUsage?.credit !== undefined && msg.tokenUsage.credit > 0) {
			const scoreWrap = append(footer, $("span.chat-bubble-footer-item.chat-footer-pill"));
			// $ 图标（圆形 $）
			append(scoreWrap, $('span.chat-footer-pill-icon.codicon.codicon-credit-card'));
			append(scoreWrap, $('span.chat-footer-pill-label', undefined, '积分'));
			append(scoreWrap, $('span.chat-footer-pill-value', undefined, `: ${msg.tokenUsage.credit.toFixed(2)}`));
		}

		// ── Tokens（pill 样式 + tokens-popup 详情）──
		if (msg.tokenUsage?.total !== undefined && msg.tokenUsage.total > 0) {
			const tokenWrap = append(footer, $("span.chat-bubble-footer-item.chat-footer-pill.tokens-item"));
			// clipboard 图标
			append(tokenWrap, $('span.chat-footer-pill-icon.codicon.codicon-clippy'));
			append(tokenWrap, $('span.chat-footer-pill-label', undefined, 'Tokens'));
			append(tokenWrap, $('span.chat-footer-pill-value', undefined, `: ${msg.tokenUsage.total.toLocaleString()}`));
			// 信息小图标，提示 hover 查看明细
			append(tokenWrap, $('span.chat-footer-pill-info.codicon.codicon-info'));

			// ── Token 消耗明细 Popup ──
			const tu = msg.tokenUsage;
			const cachedRead = tu.cachedRead ?? tu.cached ?? 0;
			const cacheWrite = tu.cacheWrite ?? 0;
			const cacheMiss = tu.cacheMiss ?? Math.max(0, tu.input - cachedRead - cacheWrite);
			const reasoning = tu.reasoning ?? 0;
			const contentTokens = Math.max(0, tu.output - reasoning);
			const hitRate = tu.cacheHitRate ?? (tu.input > 0 ? (cachedRead / tu.input) * 100 : 0);

			const popup = append(tokenWrap, $('div.tokens-popup'));
			// 标题行：左侧 "Token 消耗明细" + 右侧 "总计 X"
			const titleRow = append(popup, $('div.tokens-popup-header'));
			append(titleRow, $('span.tokens-popup-title', undefined, 'Token 消耗明细'));
			const totalEl = append(titleRow, $('span.tokens-popup-total-inline'));
			append(totalEl, $('span.label', undefined, '总计'));
			append(totalEl, $('span.value', undefined, tu.total.toLocaleString()));
			// 输入分组
			const inputGroup = append(popup, $('div.tokens-popup-group'));
			const inputTitle = append(inputGroup, $('div.tokens-popup-group-title'));
			append(inputTitle, $('span.group-name', undefined, '输入'));
			append(inputTitle, $('span.group-value', undefined, tu.input.toLocaleString()));
			if (cachedRead > 0 || cacheMiss > 0 || cacheWrite > 0) {
				if (cachedRead > 0) {
					const row = append(inputGroup, $('div.tokens-popup-sub-row'));
					append(row, $('span.sub-dot.hit'));
					append(row, $('span.sub-label', undefined, '缓存命中'));
					append(row, $('span.sub-value.highlight', undefined, cachedRead.toLocaleString()));
				}
				if (cacheMiss > 0) {
					const row = append(inputGroup, $('div.tokens-popup-sub-row'));
					append(row, $('span.sub-dot.miss'));
					append(row, $('span.sub-label', undefined, '缓存未命中'));
					append(row, $('span.sub-value', undefined, cacheMiss.toLocaleString()));
				}
				if (cacheWrite > 0) {
					const row = append(inputGroup, $('div.tokens-popup-sub-row'));
					append(row, $('span.sub-dot.write'));
					append(row, $('span.sub-label', undefined, '缓存写入'));
					append(row, $('span.sub-value', undefined, cacheWrite.toLocaleString()));
				}
			}
			// 输出分组
			const outputGroup = append(popup, $('div.tokens-popup-group'));
			const outputTitle = append(outputGroup, $('div.tokens-popup-group-title'));
			append(outputTitle, $('span.group-name', undefined, '输出'));
			append(outputTitle, $('span.group-value', undefined, tu.output.toLocaleString()));
			if (reasoning > 0 || contentTokens > 0) {
				if (reasoning > 0) {
					const row = append(outputGroup, $('div.tokens-popup-sub-row'));
					append(row, $('span.sub-label', undefined, '思考过程'));
					append(row, $('span.sub-value', undefined, reasoning.toLocaleString()));
				}
				const row = append(outputGroup, $('div.tokens-popup-sub-row'));
				append(row, $('span.sub-label', undefined, '回复内容'));
				append(row, $('span.sub-value', undefined, contentTokens.toLocaleString()));
			}
			// 缓存命中率（带进度条）
			if (hitRate > 0 || cachedRead > 0) {
				const hitRateEl = append(popup, $('div.tokens-popup-hit-rate'));
				append(hitRateEl, $('span.rate-icon.codicon.codicon-flame'));
				append(hitRateEl, $('span.rate-label', undefined, '缓存命中率'));
				append(hitRateEl, $('span.rate-value', undefined, `${hitRate.toFixed(1)}%`));
				// 进度条
				const bar = append(hitRateEl, $('div.tokens-popup-hit-bar'));
				const fill = append(bar, $('div.tokens-popup-hit-bar-fill'));
				fill.style.width = `${Math.max(0, Math.min(100, hitRate))}%`;
				// 底部图例
				const legend = append(hitRateEl, $('div.tokens-popup-legend'));
				const lg1 = append(legend, $('span.legend-item'));
				append(lg1, $('span.legend-dot.hit'));
				append(lg1, $('span.legend-label', undefined, '命中'));
				const lg2 = append(legend, $('span.legend-item'));
				append(lg2, $('span.legend-dot.write'));
				append(lg2, $('span.legend-label', undefined, '写入'));
				const lg3 = append(legend, $('span.legend-item'));
				append(lg3, $('span.legend-dot.miss'));
				append(lg3, $('span.legend-label', undefined, '未命中'));
			}
		}

		// ── 耗时（pill 样式，时钟图标 + 耗时 + 数值）──
		const durMs = typeof (msg.metadata?.durationMs) === 'number'
			? (msg.metadata.durationMs as number)
			: 0;
		if (durMs > 0) {
			const durWrap = append(footer, $("span.chat-bubble-footer-item.chat-footer-pill.duration-item"));
			append(durWrap, $('span.chat-footer-pill-icon.codicon.codicon-watch'));
			append(durWrap, $('span.chat-footer-pill-label', undefined, '耗时'));
			append(durWrap, $('span.chat-footer-pill-value', undefined, `: ${this._formatDuration(durMs)}`));
		}

		return footer;
	}

	/**
	 * P1: 流式结束转换优化——避免全量重建。
	 * 当 isStreaming 从 true 变为 false 时，实际变化仅为：
	 *   1. 移除 streaming-cursor
	 *   2. 将 streaming-container 的 textContent 替换为完整 markdown 渲染
	 *   3. 追加 footer（复制/积分/Tokens/耗时）
	 * 保留已有 DOM（avatar、thinking card、工具卡、事件监听器），避免 _createMessageElement 全量重建。
	 * 参考 VS Code chatListRenderer 的 diff + renderChatContentDiff 增量更新。
	 */
	private _transitionStreamingToComplete(existingEl: HTMLElement, msg: IAgentChatMessage): void {
		const bubble = existingEl.querySelector('.chat-bubble') as HTMLElement | null;
		if (!bubble) {
			// 找不到 bubble，回退到全量重建
			this._rebuildMessageElement(existingEl, msg);
			return;
		}

		// 1. 移除流式光标
		bubble.querySelectorAll('.streaming-cursor').forEach(el => el.remove());

		// 2. 将 streaming-container 的 textContent 替换为完整 markdown 渲染
		const streamingContainer = bubble.querySelector('.streaming-container') as HTMLElement | null;
		if (streamingContainer && msg.content) {
			streamingContainer.classList.remove('streaming-container');
			// 清理旧的 markdown disposable
			this._cleanupMarkdownDisposables(streamingContainer);
			streamingContainer.textContent = '';
			this._renderMarkdownContent(streamingContainer, msg.content, true);
			this._streamingMdLastRendered = msg.content;
		}

		// 3. 追加 footer（如果尚不存在）
		// Agent loop 进行中（_isSending === true）时跳过 footer 渲染，
		// 避免复制/积分/token 消耗信息在中间迭代中刷屏。
		// loop 结束后由 setSending(false) 统一补齐。
		if (!this._isSending && !bubble.querySelector('.chat-bubble-footer')) {
			bubble.appendChild(this._createFooter(msg));
		}
	}

	// --- Thinking card ----------------------------------------

	private _createThinkingCard(msg: IAgentChatMessage): HTMLElement {
		const card = $(`.thinking-card${msg.isThinking ? ".active" : ""}`);

		// Header
		const header = $(".thinking-card-header");
		append(card, header);
		const icon = append(header, $("span.thinking-card-icon"));
		if (msg.isThinking) {
			const spinnerSvg = append(icon, $("svg.thinking-spinner"));
			spinnerSvg.setAttribute("width", "14");
			spinnerSvg.setAttribute("height", "14");
			spinnerSvg.setAttribute("viewBox", "0 0 24 24");
			spinnerSvg.setAttribute("fill", "none");
			spinnerSvg.setAttribute("stroke", "currentColor");
			spinnerSvg.setAttribute("stroke-width", "2");
			const spinPath = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"path",
			);
			spinPath.setAttribute("d", "M21 12a9 9 0 11-6.219-8.56");
			spinnerSvg.appendChild(spinPath);
		} else {
			icon.textContent = "...";
		}
		append(
			header,
			$(
				"span.thinking-card-title",
				undefined,
				msg.isThinking ? "思考中..." : "思考过程",
			),
		);
		const toggle = append(header, $("span.thinking-card-toggle.collapsed"));
		toggle.textContent = "▼";

		// Body (initially collapsed, rendered as markdown)
		const body = $(".thinking-card-body");
		append(card, body);
		if (msg.thinking) {
			this._renderMarkdownContent(body, msg.thinking);
		} else {
			body.textContent = msg.isThinking ? "正在思考..." : "";
		}
		body.style.display = "none";

		// Toggle click
		let collapsed = true;
		this._register(
			addDisposableListener(header, EventType.CLICK, () => {
				collapsed = !collapsed;
				body.style.display = collapsed ? "none" : "block";
				toggle.classList.toggle("collapsed", collapsed);
			}),
		);

		return card;
	}

	/**
	 * "正在思考..." indicator — a compact, animated placeholder shown in the
	 * assistant bubble while waiting for the LLM's first response delta, and
	 * again during the agent loop (after a tool call completes, before the
	 * next LLM response). Displays three pulsing dots for visual feedback.
	 */
	private _createThinkingIndicator(): HTMLElement {
		const indicator = $('.thinking-indicator');
		const label = append(indicator, $('span.thinking-indicator-label'));
		label.textContent = '正在思考';
		const dots = append(indicator, $('span.thinking-indicator-dots'));
		for (let i = 0; i < 3; i++) {
			append(dots, $('span.thinking-indicator-dot'));
		}
		return indicator;
	}

	// --- Clarify tool card (LLM asks user to choose) ---

	/**
	 * 检测 clarify 工具调用。如果 tc.name === 'clarify' 且 args 可解析，
	 * 返回交互式 clarify 卡片；否则返回 null（由调用方 fallback 到普通工具卡）。
	 *
	 * clarify args 格式（JSON 字符串）：
	 *   { "question": "...", "options": ["选项A", "选项B", ...] }
	 */
	private _maybeCreateClarifyCard(tc: IToolCall): HTMLElement | null {
		const key = (tc.name || '').toLowerCase();
		if (key !== 'clarify') { return null; }

		// 解析 args
		let parsed: { question?: string; options?: string[] } = {};
		try {
			parsed = tc.args ? JSON.parse(tc.args) : {};
		} catch {
			// args 可能是流式增量（不完整 JSON），此时不渲染 clarify 卡片
			return null;
		}
		if (!parsed.question || !Array.isArray(parsed.options) || parsed.options.length === 0) {
			return null;
		}

		// 已回答？检测 result
		const isAnswered = tc.status === 'success' && tc.result && tc.result.length > 0;
		const isPending = !isAnswered;

		const card = $('.clarify-card');
		if (isAnswered) { card.classList.add('answered'); }

		// Header — 使用 Codicon 原生图标
		const header = append(card, $('.clarify-card-header'));
		const icon = append(header, $('span.codicon.codicon-question'));
		icon.style.color = 'var(--vscode-charts-blue, #60a5fa)';
		icon.style.fontSize = '16px';
		const title = append(header, $('span.clarify-card-title', undefined, '需要澄清'));
		title.style.fontWeight = '600';
		title.style.fontSize = '13px';

		// Question
		const questionEl = append(card, $('.clarify-card-question'));
		questionEl.textContent = parsed.question;

		// Options — 单选按钮组，参考 VS Code 原生 Button + radio 样式
		if (isPending) {
			let selectedIdx = -1;
			const optionsDiv = append(card, $('.clarify-options'));
			parsed.options.forEach((opt, idx) => {
			const optBtn = append(optionsDiv, $('button.clarify-option')) as HTMLButtonElement;
			append(optBtn, $('span.clarify-option-marker.codicon'));
				const body = append(optBtn, $('span.clarify-option-body'));
				append(body, $('span.clarify-option-label', undefined, opt));

				this._register(addDisposableListener(optBtn, EventType.CLICK, () => {
					selectedIdx = idx;
					// 更新所有选项的选中状态
					optionsDiv.querySelectorAll('.clarify-option').forEach((el, i) => {
						el.classList.toggle('selected', i === idx);
						const m = el.querySelector('.clarify-option-marker');
						if (m) {
							m.className = 'clarify-option-marker codicon ' + (i === idx ? 'codicon-check' : 'codicon-circle-outline');
						}
					});
					submitBtn.disabled = false;
				}));
			});

			// Submit button — VS Code 原生 monaco-button
			const actions = append(card, $('.clarify-actions'));
			const submitBtn = append(actions, $('button.monaco-button.monaco-text-button.clarify-submit')) as HTMLButtonElement;
			submitBtn.textContent = '提交';
			submitBtn.disabled = true;
			this._register(addDisposableListener(submitBtn, EventType.CLICK, () => {
				if (selectedIdx < 0) { return; }
				const selection = parsed.options![selectedIdx];
				submitBtn.disabled = true;
				submitBtn.textContent = '已提交';
				// 禁用所有选项
				optionsDiv.querySelectorAll('.clarify-option').forEach(el => {
					(el as HTMLButtonElement).disabled = true;
				});
				// 调用回调
				this._onClarifySubmit?.(tc.id, selection);
			}));
		}

		// Answered summary
		if (isAnswered) {
			const answerDiv = append(card, $('.clarify-answer'));
			append(answerDiv, $('span.codicon.codicon-check'));
			append(answerDiv, $('span.clarify-answer-text', undefined, tc.result!));
		}

		return card;
	}

	// --- Task Prompt Card (kanban task execution user message) ---

	/**
	 * Build a task prompt card directly from structured data (no regex parsing).
	 * Called when a user message has `taskCard` metadata.
	 */
	private _buildTaskCardFromData(data: { title: string; description: string; source?: string; taskId?: string; dependencies?: readonly string[]; attachments?: readonly { name: string; mimeType: string }[] }): HTMLElement | null {
		const card = $('.task-prompt-card');
		// Header row
		const header = append(card, $('.tpc-header'));
		const left = append(header, $('.tpc-header-left'));
		append(left, $('span.tpc-icon', undefined, '📋'));
		append(left, $('span.tpc-title', undefined, data.title || '任务'));
		append(header, $('.tpc-header-right'));
		// Toggle button
		const toggleBtn = append(header, $('.tpc-toggle'));
		toggleBtn.textContent = '▾ 收起';
		// Collapsible body
		const body = append(card, $('.tpc-body'));
		// Description (multi-line)
		const descEl = append(body, $('.tpc-desc'));
		descEl.textContent = data.description || '';
		// Metadata row
		const meta = append(body, $('.tpc-meta'));
		if (data.source) {
			append(meta, $('span.tpc-meta-item', undefined, `来源: ${data.source}`));
		}
		if (data.attachments && data.attachments.length > 0) {
			append(meta, $('span.tpc-meta-item', undefined, `附件: ${data.attachments.map(a => a.name).join(', ')}`));
		}

		// Toggle logic
		let collapsed = false;
		toggleBtn.addEventListener('click', () => {
			collapsed = !collapsed;
			body.style.display = collapsed ? 'none' : '';
			toggleBtn.textContent = collapsed ? '▸ 展开' : '▾ 收起';
		});

		return card;
	}
	/**
	 * Incrementally append a tool call card (Void-style) to a parent element.
	 * This is the shared implementation used by the P1.5 fast path in
	 * _updateMessageDom (streaming—first tool_start) and anywhere else that
	 * needs to add a single tool card without rebuilding the entire message DOM.
	 */
	/**
	 * Phase name → display icon + label mapping used to render phase group
	 * headers between tool call batches during task execution.
	 */
	private static readonly _PHASE_LABELS: Record<string, { icon: string; label: string }> = {
		'understanding':    { icon: '🔍', label: '理解阶段 — Reading relevant code' },
		'implementation':   { icon: '🔧', label: '实施阶段 — Making changes' },
		'verification':     { icon: '✅', label: '验证阶段 — Testing' },
		'llm_streaming':    { icon: '💬', label: 'LLM 推理' },
		'tool_executing':   { icon: '🔧', label: '工具执行中' },
	};

	/**
	 * Append tool call cards with phase group headers.  Tools that share the
	 * same `streamPhase` are grouped together under a labelled section header.
	 * If no phase info is available, tools are appended directly without groups.
	 */
	private _appendToolCallsWithPhaseGroups(
		parent: HTMLElement,
		toolCalls: readonly IToolCall[],
		streamPhase?: string,
	): void {
		const section = append(parent, $('.tool-calls-section'));
		const filteredCalls: IToolCall[] = [];
		// update_plan dedup — keep only the last one
		let lastUpdatePlanIdx = -1;
		for (let i = 0; i < toolCalls.length; i++) {
			if (toolCalls[i].name === 'update_plan') { lastUpdatePlanIdx = i; }
		}
		for (let i = 0; i < toolCalls.length; i++) {
			if (toolCalls[i].name === 'update_plan' && i !== lastUpdatePlanIdx) { continue; }
			filteredCalls.push(toolCalls[i]);
		}

		if (filteredCalls.length === 0) { return; }

		// Single-phase case: all tools share the same streamPhase → render
		// under one group header
		if (streamPhase && streamPhase !== 'idle') {
			const phaseInfo = AgentChatPanel._PHASE_LABELS[streamPhase];
			if (phaseInfo) {
				const group = append(section, $('.tpc-phase-group'));
				const header = append(group, $('.tpc-phase-header'));
				append(header, $('.tpc-phase-icon')).textContent = phaseInfo.icon;
				append(header, $('.tpc-phase-label')).textContent = phaseInfo.label;
				for (const tc of filteredCalls) {
					const card = this._maybeCreateClarifyCard(tc) ?? this._createToolCallCard(tc);
					group.appendChild(card);
				}
				return;
			}
		}

		// Fallback — no phase grouping
		for (const tc of filteredCalls) {
			const card = this._maybeCreateClarifyCard(tc) ?? this._createToolCallCard(tc);
			section.appendChild(card);
		}
	}

	private _appendToolCard(container: HTMLElement, tc: IToolCall, msg: IAgentChatMessage): void {
		const clarifyCard = this._maybeCreateClarifyCard(tc);
		if (clarifyCard) {
			container.appendChild(clarifyCard);
			return;
		}
		const wrapper = this._createToolCallCard(tc);
		if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }
		container.appendChild(wrapper);
	}

	// --- Tool call card (Void ToolHeaderWrapper parity) ---

	// ─── 写文件专用卡片（diff 风格：文件名 + +/– 行数 + 查看文件）────────

	/** 写文件/编辑文件专用卡片：语言标签 + 文件名 + diff 行数 + 查看文件 + 折叠按钮。 */
	private _createWriteFileToolCard(tc: IToolCall, key: string): HTMLElement {
		const isRunning = tc.status === 'running';
		const isError = tc.status === 'error';

		// 提取文件路径（fallback 链：tc.filePath → args.filePath → args.path）
		const filePath = this._extractFilePath(tc);

		// ── 状态驱动外壳 ──
		let statusClass = 'tool-card-success';
		if (isError) { statusClass = 'tool-card-error'; }
		else if (isRunning) { statusClass = 'tool-card-running'; }
		const wrapper = $(`.tool-header-wrapper.${statusClass}.write-file-tool-card`);
		if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }

		// ── Body（默认折叠）—— 必须先创建 body，折叠按钮 handler 才能引用 ──
		const body = append(wrapper, $('.tool-header-children'));

		// ── Header（diff 风格）──
		const headerEl = append(wrapper, $('.tool-header.write-file-header'));
		const row = append(headerEl, $('.tool-header-row'));

		// 左侧：chevron + 标题（语言标签 + 文件名 + 修改标记 + diff 行数）
		const left = append(row, $('.tool-header-left'));
		const titleContainer = append(left, $('.tool-header-title-container.tool-header-title-clickable'));
		const chevron = this._svgChevron(titleContainer, 'tool-header-chevron', 14);

		// 文件名 + 修改标记
		if (filePath) {
			// 语言标签（基于文件扩展名）
			const lang = this._getLanguageTag(filePath);
			if (lang) {
				const langEl = append(titleContainer, $('span.write-file-lang'));
				langEl.textContent = lang;
			}

			const fileName = filePath.split(/[\\/]/).pop() || filePath;
			const fileNameEl = append(titleContainer, $('span.write-file-name'));
			fileNameEl.textContent = fileName;

			const modEl = append(titleContainer, $('span.write-file-modified'));
			modEl.textContent = isRunning ? '(运行中)' : key === 'patch' ? '(修改)' : '(新建)';
		}

		// diff 行数统计（绿色 +N / 红色 -N）
		const diffStats = this._computeDiffStats(tc);
		if (diffStats.added > 0 || diffStats.removed > 0) {
			const diffEl = append(titleContainer, $('span.write-file-diff-stats'));
			if (diffStats.added > 0) {
				const addEl = append(diffEl, $('span.write-file-diff-add'));
				addEl.textContent = `+${diffStats.added}`;
			}
			if (diffStats.removed > 0) {
				const remEl = append(diffEl, $('span.write-file-diff-rem'));
				remEl.textContent = `-${diffStats.removed}`;
			}
		}

		// 点击标题区域（chevron + 文件名 + diff 统计）展开/折叠，不拦截内部按钮点击
		this._register(addDisposableListener(titleContainer, EventType.CLICK, (e) => {
			if ((e.target as HTMLElement)?.closest?.('button')) { return; }
			e.stopPropagation();
			const isExpanded = body.classList.toggle('tool-header-children-expanded');
			if (isExpanded) {
				this._toolCallExpandState.set(tc.id, true);
				chevron.classList.add('tool-header-chevron-expanded');
			} else {
				this._toolCallExpandState.set(tc.id, false);
				chevron.classList.remove('tool-header-chevron-expanded');
			}
		}));

		// 右侧：状态图标 + 「查看文件」按钮
		const right = append(row, $('.tool-header-right'));
		// 查看文件按钮（始终显示）
		if (this._onOpenFile && filePath && !isRunning) {
			const viewLink = append(right, $('button.tool-view-file-link'));
			viewLink.textContent = '查看文件';
			viewLink.title = `在编辑器中打开 ${filePath}`;
			this._register(addDisposableListener(viewLink, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onOpenFile?.(filePath);
			}));
		}
		// 展开/折叠 toggle 按钮（chevron-down SVG，旋转 180° 表示展开态）
		const collapseBtn = append(right, $('button.tool-collapse-btn')) as HTMLButtonElement;
		collapseBtn.title = '展开/折叠';
		this._svgChevronDown(collapseBtn, 'tool-collapse-icon');
		this._register(addDisposableListener(collapseBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			const isExpanded = body.classList.toggle('tool-header-children-expanded');
			if (isExpanded) {
				this._toolCallExpandState.set(tc.id, true);
				chevron.classList.add('tool-header-chevron-expanded');
				collapseBtn.classList.add('tool-collapse-expanded');
			} else {
				this._toolCallExpandState.set(tc.id, false);
				chevron.classList.remove('tool-header-chevron-expanded');
				collapseBtn.classList.remove('tool-collapse-expanded');
			}
		}));

		const inner = append(body, $('.tool-children-wrapper'));
		const innerBox = append(inner, $('.tool-children-wrapper-inner'));
		innerBox.classList.add('write-file-body');

		// 默认折叠（用户可点击展开查看 diff）
		const expanded = this._toolCallExpandState.get(tc.id) ?? false;
		if (expanded) {
			body.classList.add('tool-header-children-expanded');
			chevron.classList.add('tool-header-chevron-expanded');
			collapseBtn.classList.add('tool-collapse-expanded');
		}

		// ── Body 内容：直接 diff 代码块（无 section 包装）──
		if (isRunning && !tc.result) {
			const placeholder = append(innerBox, $('.write-file-placeholder'));
			placeholder.textContent = '正在写入文件...';
		} else if (tc.result) {
			const diffBlock = append(innerBox, $('.write-file-diff-block'));
			if (diffStats.lines && diffStats.lines.length > 0) {
				for (const line of diffStats.lines) {
					const lineEl = append(diffBlock, $(`div.write-file-diff-line.write-file-diff-${line.type}`));
					append(lineEl, $('span.write-file-diff-marker')).textContent = line.type === 'add' ? '+' : line.type === 'rem' ? '-' : ' ';
					append(lineEl, $('span.write-file-diff-content')).textContent = line.text;
				}
			} else {
				// 退化为纯文本预览
				const pre = append(diffBlock, $('.write-file-diff-content'));
				pre.textContent = tc.result;
			}
		}

		// ── 错误详情（无 result 时）──
		if (isError && tc.error && !tc.result) {
			const bottom = append(wrapper, $('.tool-bottom-children'));
			const bh = append(bottom, $('.tool-bottom-children-header'));
			const bchevron = this._svgChevron(bh, 'tool-bottom-children-chevron', 12);
			append(bh, $('span.tool-bottom-children-title')).textContent = '错误详情';
			const bbody = append(bottom, $('.tool-bottom-children-body'));
			append(bbody, $('.tool-bottom-children-content')).textContent = tc.error;
			this._register(addDisposableListener(bh, EventType.CLICK, (e) => {
				e.stopPropagation();
				const open = bbody.classList.toggle('tool-bottom-children-body-open');
				bchevron.classList.toggle('tool-bottom-children-chevron-open', open);
			}));
		}

		// 取消通知
		if (tc.status === 'canceled') {
			this._appendCanceledNotice(wrapper);
		}

		return wrapper;
	}

	/** 从 IToolCall 中提取文件路径：fallback 链 tc.filePath → args.filePath → args.path */
	private _extractFilePath(tc: IToolCall): string {
		if (tc.filePath) { return tc.filePath; }
		try {
			if (tc.args) {
				const args = JSON.parse(tc.args);
				for (const key of ['filePath', 'path', 'file', 'filepath']) {
					if (typeof args[key] === 'string' && args[key].length > 0) {
						return args[key];
					}
				}
			}
		} catch { /* ignore */ }
		return '';
	}

	/** 根据文件扩展名返回语言标签（短文本） */
	private _getLanguageTag(filePath: string): string {
		const ext = filePath.split('.').pop()?.toLowerCase() || '';
		const map: Record<string, string> = {
			ts: 'TS', tsx: 'TSX', js: 'JS', jsx: 'JSX',
			py: 'PY', java: 'JAVA', kt: 'KT', swift: 'SWIFT',
			go: 'GO', rs: 'RS', cpp: 'C++', c: 'C', h: 'H',
			html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'LESS',
			json: 'JSON', yaml: 'YAML', yml: 'YAML', xml: 'XML',
			md: 'MD', sql: 'SQL', sh: 'SH', bash: 'SH', zsh: 'SH',
			vue: 'VUE', svelte: 'SVELTE', dart: 'DART',
		};
		return map[ext] || ext.toUpperCase().slice(0, 4);
	}

	/** 折叠图标（chevron-down，与外部 chevron 方向一致） */
	private _svgChevronDown(parent: HTMLElement, className: string): void {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', className);
		svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
		const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		poly.setAttribute('points', '6 9 12 15 18 9');
		svg.appendChild(poly);
		parent.appendChild(svg);
	}

	/** 计算 diff 行数：优先从 args 中解析 search/replace 或 content，否则从 result 简单计算。 */
	private _computeDiffStats(tc: IToolCall): { added: number; removed: number; lines: Array<{ type: 'add' | 'rem' | 'ctx'; text: string }> } {
		try {
			if (!tc.args) { return { added: 0, removed: 0, lines: [] }; }
			const args = JSON.parse(tc.args);
			// patch 模式：search + replace
			if (typeof args['search'] === 'string' && typeof args['replace'] === 'string') {
				const searchLines = args['search'].split('\n');
				const replaceLines = args['replace'].split('\n');
				return {
					added: replaceLines.length,
					removed: searchLines.length,
					lines: [
						...searchLines.map(text => ({ type: 'rem' as const, text })),
						...replaceLines.map(text => ({ type: 'add' as const, text })),
					],
				};
			}
			// write 模式：content —— 新增文件，全是 +N
			if (typeof args['content'] === 'string') {
				const lines = args['content'].split('\n');
				return { added: lines.length, removed: 0, lines: lines.map(text => ({ type: 'add' as const, text })) };
			}
		} catch { /* ignore */ }
		return { added: 0, removed: 0, lines: [] };
	}

	// ─── 终端/控制台工具卡片（控制台 logo + 命令 + Run in Terminal + 折叠）──

	/** 控制台工具卡片：单行命令（带终端 logo）+ 复制 + 独立终端 + ×折叠。 */
	private _createTerminalToolCard(tc: IToolCall, key: string): HTMLElement {
		const isRunning = tc.status === 'running';
		const isError = tc.status === 'error';
		const isSuccess = tc.status === 'success' || (!isRunning && !isError && tc.status !== 'approval_required' && tc.status !== 'rejected' && tc.status !== 'canceled');

		// 提取命令字符串
		let commandText = '';
		try {
			if (tc.args) {
				const args = JSON.parse(tc.args);
				commandText = typeof args['command'] === 'string' ? args['command']
					: typeof args['cmd'] === 'string' ? args['cmd']
					: typeof args['code'] === 'string' ? args['code'] : '';
			}
		} catch { /* ignore */ }

		// ── 状态驱动外壳 ──
		let statusClass = 'tool-card-success';
		if (isError) { statusClass = 'tool-card-error'; }
		else if (isRunning) { statusClass = 'tool-card-running'; }
		else if (tc.status === 'skipped' || tc.status === 'canceled') { statusClass = 'tool-card-rejected'; }
		const wrapper = $(`.tool-header-wrapper.${statusClass}.terminal-tool-card`);
		if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }

		// ── Header（单行命令 + 按钮）──
		const headerEl = append(wrapper, $('.tool-header.terminal-header'));
		const row = append(headerEl, $('.tool-header-row'));

		// 左侧：终端 logo + 命令
		const left = append(row, $('.tool-header-left.terminal-left'));
		const titleContainer = append(left, $('.tool-header-title-container.tool-header-title-clickable'));
		const chevron = this._svgChevron(titleContainer, 'tool-header-chevron', 14);

		// 终端 logo（`>_` prompt 风格 SVG）
		this._svgTerminalLogo(titleContainer, 'terminal-logo');
		// 命令文本（去掉前缀"$ "，使用等宽字体）
		const cmdEl = append(titleContainer, $('span.terminal-cmd-text'));
		cmdEl.textContent = commandText || (isRunning ? '执行中…' : '(空命令)');

		// 点击标题区域（chevron + logo + 命令文本）展开/折叠，但不拦截内部按钮点击
		this._register(addDisposableListener(titleContainer, EventType.CLICK, (e) => {
			if ((e.target as HTMLElement)?.closest?.('button')) { return; }
			e.stopPropagation();
			const isExpanded = body.classList.toggle('tool-header-children-expanded');
			if (isExpanded) {
				this._toolCallExpandState.set(tc.id, true);
				chevron.classList.add('tool-header-chevron-expanded');
			} else {
				this._toolCallExpandState.set(tc.id, false);
				chevron.classList.remove('tool-header-chevron-expanded');
			}
		}));

		// 右侧：状态图标 + 复制 + Run in Terminal
		const right = append(row, $('.tool-header-right'));
		if (isRunning) {
			this._svgSpinner(right, 'tool-header-spinner-icon');
		} else if (isError) {
			this._svgAlert(right, 'tool-header-error-icon');
		} else if (isSuccess) {
			this._svgCheck(right, 'tool-header-success-icon');
		}
		if (typeof tc.duration === 'number' && tc.duration >= 0 && !isRunning) {
			append(right, $('span.tool-header-desc2')).textContent = this._formatDuration(tc.duration);
		}
		// 复制按钮
		if (commandText) {
			const copyBtn = append(right, $('button.terminal-copy-btn'));
			copyBtn.title = '复制命令';
			const copySvg = this._svgCopyIcon();
			copyBtn.appendChild(copySvg);
			this._register(addDisposableListener(copyBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				void this._copyToClipboard(commandText);
				copyBtn.classList.add('terminal-copy-done');
				setTimeout(() => copyBtn.classList.remove('terminal-copy-done'), 1200);
			}));
		}
		// 独立终端按钮（绿色框图标）
		if (this._onRunInTerminal && commandText && !isRunning) {
			const termBtn = append(right, $('button.terminal-open-btn'));
			termBtn.title = '在独立终端窗口中运行';
			this._svgTerminalOpenIcon(termBtn, 'terminal-open-icon');
			this._register(addDisposableListener(termBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onRunInTerminal?.(commandText);
			}));
		}
		// ── Body（默认折叠）—— 提前创建以便 header 点击事件引用 ──
		const body = append(wrapper, $('.tool-header-children'));
		const inner = append(body, $('.tool-children-wrapper'));
		const innerBox = append(inner, $('.tool-children-wrapper-inner'));
		innerBox.classList.add('terminal-body');

		const expanded = this._toolCallExpandState.get(tc.id) ?? false;
		if (expanded) {
			body.classList.add('tool-header-children-expanded');
			chevron.classList.add('tool-header-chevron-expanded');
		}

		// ── Body 内容：直接放命令结果（无 section 标签）──
		if (isRunning && !tc.result) {
			const running = append(innerBox, $('.terminal-running-row'));
			// 左侧占位文本 + 右侧「继续下一步」按钮
			const placeholder = append(running, $('span.terminal-placeholder'));
			placeholder.textContent = '运行中，详情可在终端查看';
			// 继续下一步按钮：点击后标记跳过 + 取消执行（用户可继续后续步骤）
			if (this._onCancelExecution) {
				const continueBtn = append(running, $('button.terminal-continue-btn')) as HTMLButtonElement;
				continueBtn.textContent = '继续下一步';
				continueBtn.title = '不等待命令完成，标记为已跳过并继续后续步骤';
				this._register(addDisposableListener(continueBtn, EventType.CLICK, (e) => {
					e.stopPropagation();
					continueBtn.disabled = true;
					continueBtn.textContent = '已跳过';
					// 取消当前执行（agent 端 abort → onCancelExecution → bubble 显示「用户已取消」）
					this._onCancelExecution?.();
				}));
			}
		} else if (tc.result) {
			const output = append(innerBox, $('.terminal-output-block'));
			if (isError) { output.classList.add('terminal-output-error'); }
			const pre = append(output, $('.terminal-output-content'));
			pre.textContent = tc.result;
			// exit code 徽标
			if (typeof tc.exitCode === 'number') {
				const ec = append(output, $(
					`.tool-exit-code.${tc.exitCode === 0 ? 'tool-exit-code-zero' : 'tool-exit-code-nonzero'}`
				));
				ec.textContent = `exit code ${tc.exitCode}`;
			}
		}

		// 错误详情
		if (isError && tc.error && !tc.result) {
			const bottom = append(wrapper, $('.tool-bottom-children'));
			const bh = append(bottom, $('.tool-bottom-children-header'));
			const bchevron = this._svgChevron(bh, 'tool-bottom-children-chevron', 12);
			append(bh, $('span.tool-bottom-children-title')).textContent = '错误详情';
			const bbody = append(bottom, $('.tool-bottom-children-body'));
			append(bbody, $('.tool-bottom-children-content')).textContent = tc.error;
			this._register(addDisposableListener(bh, EventType.CLICK, (e) => {
				e.stopPropagation();
				const open = bbody.classList.toggle('tool-bottom-children-body-open');
				bchevron.classList.toggle('tool-bottom-children-chevron-open', open);
			}));
		}

		// ── 取消通知（canceled 状态）──
		if (tc.status === 'canceled') {
			this._appendCanceledNotice(wrapper);
		}

		return wrapper;
	}

	private _createToolCallCard(tc: IToolCall): HTMLElement {
		const key = (tc.name || '').toLowerCase();

		// ── update_plan: 专用计划卡片 ──
		if (key === 'update_plan') {
			return this._createPlanCard(tc);
		}

		// ── 写文件/编辑文件：diff 风格专用卡片（默认折叠）──
		if (key === 'file_write' || key === 'patch' || key === 'file_edit' || key === 'create_file') {
			return this._createWriteFileToolCard(tc, key);
		}

		// ── 终端命令：专用终端卡片（复刻 Void 风格：命令预览 + 输出代码块 + exit code）──
		if (TOOL_TERMINAL_TOOLS.has(key)) {
			return this._createTerminalToolCard(tc, key);
		}

		const isRunning = tc.status === 'running';
		const isError = tc.status === 'error';
		const isSuccess = tc.status === 'success' || (!isRunning && !isError && tc.status !== 'approval_required' && tc.status !== 'rejected' && tc.status !== 'canceled');
		const isApproval = tc.status === 'approval_required';
		const isRejected = tc.status === 'rejected';
		const isCanceled = tc.status === 'canceled';
		const isSkipped = tc.status === 'skipped';

		// 状态驱动外壳类（与 void-tool-card.css 对齐）
		let statusClass = 'tool-card-success';
		if (isError) { statusClass = 'tool-card-error'; }
		else if (isRunning) { statusClass = 'tool-card-running'; }
		else if (isApproval) { statusClass = 'tool-card-approval'; }
		else if (isRejected || isCanceled) { statusClass = 'tool-card-rejected'; }
		else if (isSkipped) { statusClass = 'tool-card-rejected'; }
		const wrapper = $(`.tool-header-wrapper.${statusClass}`);
		// P2+: data-tool-id 用于增量更新——状态变化时按 ID 查找并更新单张卡片
		if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }
		const headerEl = append(wrapper, $('.tool-header'));
		const row = append(headerEl, $('.tool-header-row'));

		// ── 左侧：chevron + 状态感知标题 + 斜体 desc ──
		const left = append(row, $('.tool-header-left'));
		const titleContainer = append(left, $('.tool-header-title-container.tool-header-title-clickable'));
		const chevron = this._svgChevron(titleContainer, 'tool-header-chevron', 14);

		const titleEl = append(titleContainer, $('span.tool-header-title'));
		const titleText = this._getToolTitle(key, tc.displayName, tc.name, isRunning);
		if (isRunning) {
			const lt = append(titleEl, $('span.tool-header-loading-title'));
			lt.appendChild(document.createTextNode(titleText));
			append(lt, $('span.tool-header-loading-dots'));
		} else {
			titleEl.textContent = titleText;
		}

		const desc1 = this._getToolDesc1(key, tc.args, tc.filePath);
		if (desc1) {
			const descEl = append(titleContainer, $('span.tool-header-desc1'));
			descEl.textContent = desc1;
			if (tc.filePath) {
				descEl.classList.add('tool-header-desc1-clickable');
				descEl.title = tc.filePath;
				descEl.addEventListener('click', (e) => {
					e.stopPropagation();
					if (tc.filePath) { this._onOpenFile?.(tc.filePath); }
				});
			}
		}

		// ── 右侧：spinner / error / success 图标 + duration ──
		const right = append(row, $('.tool-header-right'));
		if (isRunning) {
			this._svgSpinner(right, 'tool-header-spinner-icon');
		} else if (isError) {
			this._svgAlert(right, 'tool-header-error-icon');
		} else if (isApproval) {
			this._svgAlert(right, 'tool-header-approval-icon');
		} else if (isRejected || isCanceled) {
			this._svgAlert(right, 'tool-header-rejected-icon');
		} else if (isSuccess) {
			this._svgCheck(right, 'tool-header-success-icon');
		}
		if (typeof tc.duration === 'number' && tc.duration >= 0 && !isRunning && !isApproval) {
			append(right, $('span.tool-header-desc2')).textContent = this._formatDuration(tc.duration);
		}

		// ── 审批按钮（approval_required 状态）──
		if (isApproval) {
			const approvalRow = append(wrapper, $('.tool-approval-row'));
			const securityLabel = tc.securityLevel === 'dangerous'
				? '危险操作'
				: tc.securityLevel === 'cautious'
					? '需谨慎'
					: '需确认';
			const labelEl = append(approvalRow, $('span.tool-approval-label'));
			// 添加盾牌图标
			const shieldSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			shieldSvg.setAttribute('width', '13');
			shieldSvg.setAttribute('height', '13');
			shieldSvg.setAttribute('viewBox', '0 0 24 24');
			shieldSvg.setAttribute('fill', 'none');
			shieldSvg.setAttribute('stroke', 'currentColor');
			shieldSvg.setAttribute('stroke-width', '2');
			const shieldPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			shieldPath.setAttribute('d', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
			shieldSvg.appendChild(shieldPath);
			labelEl.appendChild(shieldSvg);
			labelEl.appendChild(document.createTextNode(securityLabel));

			// 允许一次按钮
			const allowOnceBtn = append(approvalRow, $('button.tool-approval-btn.tool-approval-btn-primary'));
			allowOnceBtn.textContent = '允许一次';
			allowOnceBtn.title = '仅允许此次执行';
			this._register(addDisposableListener(allowOnceBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onToolApprove?.(tc.id, 'allow_once');
			}));

			// 会话中允许按钮
			const allowSessionBtn = append(approvalRow, $('button.tool-approval-btn.tool-approval-btn-secondary'));
			allowSessionBtn.textContent = '会话中允许';
			allowSessionBtn.title = '在当前会话中自动允许';
			this._register(addDisposableListener(allowSessionBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onToolApprove?.(tc.id, 'allow_session');
			}));

			// 始终允许按钮
			const allowAlwaysBtn = append(approvalRow, $('button.tool-approval-btn.tool-approval-btn-secondary'));
			allowAlwaysBtn.textContent = '始终允许';
			allowAlwaysBtn.title = '始终自动允许此工具';
			this._register(addDisposableListener(allowAlwaysBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onToolApprove?.(tc.id, 'allow_always');
			}));

			// 拒绝按钮
			const denyBtn = append(approvalRow, $('button.tool-approval-btn.tool-approval-btn-reject'));
			denyBtn.textContent = '拒绝';
			denyBtn.title = '拒绝此工具调用';
			this._register(addDisposableListener(denyBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onToolApprove?.(tc.id, 'deny');
			}));
		}

		// ── 拒绝通知（rejected 状态）──
		if (isRejected) {
			const rejectedNotice = append(wrapper, $('.tool-rejected-notice'));
			rejectedNotice.textContent = '用户已拒绝此工具调用';
		}

		// ── Body（可折叠 dropdown）──
		const body = append(wrapper, $('.tool-header-children'));
		const inner = append(body, $('.tool-children-wrapper'));
		const innerBox = append(inner, $('.tool-children-wrapper-inner'));
		innerBox.classList.add('tool-section-body'); // 新：Content/Result 双区容器

		// 展开态：跨流式重建保留用户选择，否则回退 defaultShow。
		const expanded = this._toolCallExpandState.get(tc.id) ?? (tc.defaultShow === true);
		if (expanded) {
			body.classList.add('tool-header-children-expanded');
			chevron.classList.add('tool-header-chevron-expanded');
		}

		// ── Content Section：请求参数（可折叠）──
		const hasArgs = tc.args && (() => {
			try { return JSON.stringify(JSON.parse(tc.args), null, 2) !== '{}'; }
			catch { return false; }
		})();

		if (hasArgs) {
			this._appendToolSection(innerBox, {
				label: '请求参数',
				icon: 'content',
				collapsed: false,
				buildContent: (container) => {
					const parsed = JSON.stringify(JSON.parse(tc.args!), null, 2);
					const code = append(container, $('.tool-code-children'));
					const sel = append(code, $('.tool-code-children-selectable'));
					append(sel, $('pre')).textContent = parsed;
				},
			});
		}

		// ── Divider（双区都有内容时才显示）──
		if (hasArgs && tc.result) {
			append(innerBox, $('.tool-section-divider'));
		}

		// ── Result Section：执行结果（可折叠）──
		if (tc.result || isRunning) {
			// 状态徽标
			let statusBadge = '';
			let statusBadgeClass = '';
			if (isRunning) { statusBadge = '执行中'; statusBadgeClass = 'tool-section-badge-running'; }
			else if (isError) { statusBadge = '失败'; statusBadgeClass = 'tool-section-badge-error'; }
			else if (isSuccess) { statusBadge = '成功'; statusBadgeClass = 'tool-section-badge-success'; }

			// 元信息
			let metaText = '';
			if (typeof tc.duration === 'number' && tc.duration >= 0) {
				metaText = this._formatDuration(tc.duration);
			}
			if (typeof tc.exitCode === 'number') {
				metaText = metaText ? `${metaText} · exit ${tc.exitCode}` : `exit ${tc.exitCode}`;
			}

			this._appendToolSection(innerBox, {
				label: '执行结果',
				icon: 'result',
				collapsed: false,
				badge: statusBadge,
				badgeClass: statusBadgeClass,
				meta: metaText,
				buildContent: (container) => {
					if (isRunning && !tc.result) {
						const placeholder = append(container, $('.tool-section-placeholder'));
						placeholder.textContent = '等待结果返回...';
						return;
					}
					const resultText = tc.result!;
					// 增强渲染
					const enhanced = this._maybeCreateEnhancedResult(key, resultText);
					if (enhanced) {
						container.appendChild(enhanced);
					} else if (TOOL_TERMINAL_TOOLS.has(key)) {
						const term = append(container, $('.tool-children-terminal'));
						const codeBox = append(term, $('.tool-terminal-code'));
						append(codeBox, $('pre')).textContent = resultText;
						if (typeof tc.exitCode === 'number') {
							const ec = append(term, $(`.tool-exit-code.${tc.exitCode === 0 ? 'tool-exit-code-zero' : 'tool-exit-code-nonzero'}`));
							ec.textContent = `exit code ${tc.exitCode}`;
						}
					} else if (TOOL_LIST_TOOLS.has(key)) {
						const items = this._parseToolListItems(resultText);
						if (items && items.length > 0) {
							for (const it of items) {
								const itemEl = append(container, $(`.tool-listable-item${it.path ? '.tool-listable-item-clickable' : ''}`));
								const dot = append(itemEl, $('.tool-listable-item-dot'));
								const dotSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
								dotSvg.setAttribute('viewBox', '0 0 100 40');
								const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
								rect.setAttribute('x', '0'); rect.setAttribute('y', '15'); rect.setAttribute('width', '100'); rect.setAttribute('height', '10');
								dotSvg.appendChild(rect);
								dot.appendChild(dotSvg);
								append(itemEl, $('div')).textContent = it.name;
								if (it.path) {
									const p = it.path;
									itemEl.addEventListener('click', (e) => { e.stopPropagation(); this._onOpenFile?.(p); });
								}
							}
						} else {
							const code = append(container, $('.tool-code-children'));
							append(append(code, $('.tool-code-children-selectable')), $('pre')).textContent = resultText;
						}
					} else {
						const code = append(container, $('.tool-code-children'));
						const sel = append(code, $('.tool-code-children-selectable'));
						if (isError) { code.classList.add('tool-result-error'); }
						append(sel, $('pre')).textContent = resultText;
					}
				},
			});
		}

		// 错误（底部可折叠区，void BottomChildren）
		// 仅在 Result 区没有内容时才显示底部「错误详情」折叠区——避免错误信息与 Result 区域内容重复。
		// 已有 result 时，错误信息已在 Result 区（带红色错误样式）展示，无需再渲染底部折叠。
		if (isError && tc.error && !tc.result) {
			const bottom = append(wrapper, $('.tool-bottom-children'));
			const bh = append(bottom, $('.tool-bottom-children-header'));
			const bchevron = this._svgChevron(bh, 'tool-bottom-children-chevron', 12);
			append(bh, $('span.tool-bottom-children-title')).textContent = '错误详情';
			const bbody = append(bottom, $('.tool-bottom-children-body'));
			append(bbody, $('.tool-bottom-children-content')).textContent = tc.error;
			this._register(addDisposableListener(bh, EventType.CLICK, (e) => {
				e.stopPropagation();
				const open = bbody.classList.toggle('tool-bottom-children-body-open');
				bchevron.classList.toggle('tool-bottom-children-chevron-open', open);
			}));
		}

		// ── 展开/折叠点击（点标题行整体）──
		this._register(addDisposableListener(titleContainer, EventType.CLICK, () => {
			const nowExpanded = !body.classList.contains('tool-header-children-expanded');
			body.classList.toggle('tool-header-children-expanded', nowExpanded);
			chevron.classList.toggle('tool-header-chevron-expanded', nowExpanded);
			this._toolCallExpandState.set(tc.id, nowExpanded);
		}));

		return wrapper;
	}

	// ─── Void 工具卡 helper ─────────────────────────────────────────

	/** ChevronRight SVG（CSS 旋转控制展开/折叠箭头朝向）。 */
	// P2+: SVG 图标模板缓存——cloneNode(true) 比多次 createElementNS + setAttribute 快 5-10x。
	// 每条消息至少创建 2-3 个 SVG（copy/chevron/spinner），缓存后只做 1 次原生 clone。
	private static _svgChevronTpl: SVGElement | null = null;
	private static _svgSpinnerTpl: SVGElement | null = null;
	private static _svgCopyTpl: SVGElement | null = null;
	private static _svgCheckTpl: SVGElement | null = null;
	private static _svgUndoTpl: SVGElement | null = null;
	private static _svgImportKbTpl: SVGElement | null = null;

	private _svgChevron(parent: HTMLElement, className: string, size: number): SVGElement {
		if (!AgentChatPanel._svgChevronTpl) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
			const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
			poly.setAttribute('points', '9 18 15 12 9 6');
			svg.appendChild(poly);
			AgentChatPanel._svgChevronTpl = svg;
		}
		const svg = AgentChatPanel._svgChevronTpl.cloneNode(true) as SVGElement;
		svg.setAttribute('class', className);
		svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
		parent.appendChild(svg);
		return svg;
	}

	private _svgSpinner(parent: HTMLElement, className: string): void {
		if (!AgentChatPanel._svgSpinnerTpl) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
			svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', 'M21 12a9 9 0 11-6.219-8.56');
			svg.appendChild(path);
			AgentChatPanel._svgSpinnerTpl = svg;
		}
		const svg = AgentChatPanel._svgSpinnerTpl.cloneNode(true) as SVGElement;
		svg.setAttribute('class', className);
		parent.appendChild(svg);
	}

	// ── update_plan 专用计划卡片 ──────────────────────────────────────────

	private _createPlanCard(tc: IToolCall): HTMLElement {
		// _parsePlanArgs 期望 Record<string, unknown>，但 IToolCall.args 是 JSON 字符串
		let parsedArgs: Record<string, unknown> | undefined = undefined;
		if (tc.args) {
			try { parsedArgs = JSON.parse(tc.args); } catch { /* invalid JSON */ }
		}
		const planData = this._parsePlanArgs(parsedArgs);
		const isRunning = tc.status === 'running';
		const statusClass = isRunning ? 'tool-card-running'
			: tc.status === 'error' ? 'tool-card-error'
			: 'tool-card-success';

		const wrapper = $(`.tool-header-wrapper.${statusClass}.plan-card`);
		if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }

		const body = append(wrapper, $('.plan-card-body'));

		// 标题行
		const titleRow = append(body, $('.plan-card-title-row'));
		const titleContainer = append(titleRow, $('.tool-header-title-container'));
		const titleEl = append(titleContainer, $('span.tool-header-title'));
		const doneCount = planData ? planData.plan.filter(s => s.status === 'completed').length : 0;
		const totalCount = planData ? planData.plan.length : 0;
		titleEl.textContent = isRunning
			? `更新计划 · ${doneCount}/${totalCount}`
			: `已更新计划 · ${doneCount}/${totalCount}`;

		if (isRunning) {
			const spinner = append(titleRow, $('.plan-card-spinner'));
			this._svgSpinner(spinner, '');
		} else {
			const check = append(titleRow, $('span.tool-header-success-icon'));
			this._svgCheck(check, '');
		}

		// 进度条
		if (planData && totalCount > 0) {
			const progressRow = append(body, $('.plan-card-progress'));
			const bar = append(progressRow, $('.plan-card-progress-bar'));
			const pct = Math.round((doneCount / totalCount) * 100);
			bar.style.width = `${pct}%`;
		}

		// 步骤列表
		if (planData && planData.plan.length > 0) {
			const stepsEl = append(body, $('.plan-card-steps'));
			for (let i = 0; i < planData.plan.length; i++) {
				const s = planData.plan[i];
				const stepRow = append(stepsEl, $(`.plan-card-step.step-${s.status}`));
				const dot = append(stepRow, $('span.plan-card-step-dot'));
				if (s.status === 'completed') {
					dot.textContent = '✓';
				} else if (s.status === 'in_progress') {
					dot.textContent = '▶';
					dot.classList.add('pulse');
				} else {
					dot.textContent = '·';
				}
				const stepText = append(stepRow, $('span.plan-card-step-text'));
				stepText.textContent = s.step;
			}
		}

		// explanation（如果有）
		if (planData?.explanation) {
			const footer = append(body, $('.plan-card-footer'));
			const icon = append(footer, $('span.plan-card-footer-icon'));
			icon.textContent = '✏';
			const text = append(footer, $('span.plan-card-footer-text'));
			text.textContent = planData.explanation;
		}

		return wrapper;
	}

	// ─── Content/Result 双区 Section 辅助方法 ───────────────────────

	/** 通用工具卡分区：可折叠 header（图标+标签+状态徽标+元信息） + 内容体。 */
	private _appendToolSection(
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
	): void {
		const wrapper = append(parent, $('.tool-section'));

		// Header row
		const header = append(wrapper, $('.tool-section-header'));
		const chevron = this._svgChevron(header, 'tool-section-chevron', 12);
		if (!opts.collapsed) { chevron.classList.add('tool-section-chevron-open'); }

		// Icon
		if (opts.icon === 'content') { this._svgSectionContent(header, 'tool-section-icon'); }
		else { this._svgSectionResult(header, 'tool-section-icon'); }

		// Label
		const label = append(header, $('span.tool-section-label'));
		label.textContent = opts.label;

		// Status badge
		if (opts.badge && opts.badgeClass) {
			const badge = append(header, $('span.tool-section-badge'));
			badge.textContent = opts.badge;
			badge.classList.add(opts.badgeClass);
		}

		// Meta (right-aligned)
		if (opts.meta) {
			const meta = append(header, $('span.tool-section-meta'));
			meta.textContent = opts.meta;
		}

		// Content
		const content = append(wrapper, $('.tool-section-content'));
		if (opts.collapsed) { content.classList.add('tool-section-content-collapsed'); }
		opts.buildContent(content);

		// Toggle collapse
		this._register(addDisposableListener(header, EventType.CLICK, (e) => {
			e.stopPropagation();
			const isCollapsed = content.classList.toggle('tool-section-content-collapsed');
			if (isCollapsed) {
				chevron.classList.remove('tool-section-chevron-open');
			} else {
				chevron.classList.add('tool-section-chevron-open');
			}
		}));
	}

	/** Content 区图标（文件/参数）*/
	private _svgSectionContent(parent: HTMLElement, className: string): void {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', className);
		svg.setAttribute('width', '12'); svg.setAttribute('height', '12');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z');
		svg.appendChild(path);
		const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		poly.setAttribute('points', '14 2 14 8 20 8');
		svg.appendChild(poly);
		parent.appendChild(svg);
	}

	/** Result 区图标（输出/结果）*/
	private _svgSectionResult(parent: HTMLElement, className: string): void {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', className);
		svg.setAttribute('width', '12'); svg.setAttribute('height', '12');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', 'M9 12l2 2 4-4');
		svg.appendChild(path);
		const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		rect.setAttribute('x', '3'); rect.setAttribute('y', '3');
		rect.setAttribute('width', '18'); rect.setAttribute('height', '18');
		rect.setAttribute('rx', '2');
		svg.appendChild(rect);
		parent.appendChild(svg);
	}

	/** 已取消状态的通知条 */
	private _appendCanceledNotice(wrapper: HTMLElement): void {
		const notice = append(wrapper, $('.tool-rejected-notice'));
		notice.textContent = '命令已取消';
	}

	private _parsePlanArgs(args: Record<string, unknown> | undefined): {
		plan: Array<{ step: string; status: string }>;
		explanation?: string;
	} | null {
		if (!args) { return null; }
		const plan = args['plan'];
		if (!Array.isArray(plan) || plan.length === 0) { return null; }
		const steps = plan.map((s: any, i: number) => ({
			step: typeof s?.step === 'string' ? s.step : `Step ${i + 1}`,
			status: ['pending', 'in_progress', 'completed'].includes(s?.status) ? s.status : 'pending',
		}));
		const explanation = typeof args['explanation'] === 'string' ? args['explanation'] : undefined;
		return { plan: steps, explanation };
	}

	private _svgCheck(parent: HTMLElement, className: string): void {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', className);
		svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		poly.setAttribute('points', '20 6 9 17 4 12');
		svg.appendChild(poly);
		parent.appendChild(svg);
	}

	private _svgAlert(parent: HTMLElement, className: string): void {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', className);
		svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z');
		svg.appendChild(path);
		const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		l1.setAttribute('x1', '12'); l1.setAttribute('y1', '9'); l1.setAttribute('x2', '12'); l1.setAttribute('y2', '13');
		svg.appendChild(l1);
		const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		l2.setAttribute('x1', '12'); l2.setAttribute('y1', '17'); l2.setAttribute('x2', '12.01'); l2.setAttribute('y2', '17');
		svg.appendChild(l2);
		parent.appendChild(svg);
	}

	// --- Enhanced result rendering (kanban / workflow / memory) ---

	/**
	 * 尝试为结构化工具结果创建增强渲染卡片。
	 * 支持：kanban_list / kanban_show / workflow_list / memory_search / memory_list
	 * 返回 null 表示无增强（fallback 到通用代码块）。
	 */
	private _maybeCreateEnhancedResult(key: string, resultText: string): HTMLElement | null {
		// ── kanban_list: 表格形式展示任务列表 ──
		if (key === 'kanban_list') {
			return this._createKanbanListCard(resultText);
		}
		// ── kanban_show: 任务详情卡片 ──
		if (key === 'kanban_show') {
			return this._createKanbanShowCard(resultText);
		}
		// ── workflow_list: 工作流列表卡片 ──
		if (key === 'workflow_list') {
			return this._createWorkflowListCard(resultText);
		}
		// ── memory_search: 记忆搜索结果卡片 ──
		if (key === 'memory_search') {
			return this._createMemorySearchCard(resultText);
		}
		// ── memory_list: 记忆列表卡片 ──
		if (key === 'memory_list') {
			return this._createMemoryListCard(resultText);
		}
		// ── codebase tools: 知识图谱结构化卡片 ──
		if (TOOL_CODEBASE_TOOLS.has(key)) {
			return this._createCodebaseResultCard(key, resultText);
		}
		return null;
	}

	/** Codebase 工具结果 → 结构化卡片（search_graph / search_code / get_architecture / trace_path / index_repository） */
	private _createCodebaseResultCard(key: string, resultText: string): HTMLElement | null {
		try {
			const data = JSON.parse(resultText);
			if (!data) { return null; }

			const card = $('.codebase-result-card');

			// ── search_graph: BM25 搜索结果列表 ──
			if (key === 'search_graph' && data.nodes && Array.isArray(data.nodes)) {
				return this._renderSearchGraphCard(card, data);
			}
			// ── search_code: 代码搜索 + 上下文 ──
			if (key === 'search_code' && data.results && Array.isArray(data.results)) {
				return this._renderSearchCodeCard(card, data);
			}
			// ── get_architecture: 架构总览 ──
			if (key === 'get_architecture' && (data.totalNodes || data.languages)) {
				return this._renderArchitectureCard(card, data);
			}
			// ── trace_path: 调用链追踪 ──
			if (key === 'trace_path' && (data.hops || data.path)) {
				return this._renderTracePathCard(card, data);
			}
			// ── index_repository: 索引进度/完成 ──
			if (key === 'index_repository') {
				return this._renderIndexRepoCard(card, data);
			}
			// ── 其他 codebase 工具：紧凑统计卡 ──
			return this._renderCodebaseSummaryCard(card, key, data);
		} catch {
			return null;
		}
	}

	/** search_graph — 排名列表 */
	private _renderSearchGraphCard(card: HTMLElement, data: any): HTMLElement {
		const nodes = data.nodes || [];
		const total = data.total ?? nodes.length;
		const hasMore = data.hasMore ?? false;
		const semResults = data.semantic_results || [];

		// Summary strip
		const strip = append(card, $('.codebase-summary'));
		append(strip, $('span.codebase-stat', undefined, `${nodes.length} / ${total} results`));
		if (hasMore) {
			append(strip, $('span.codebase-stat.codebase-stat-more', undefined, 'hasMore → paginate'));
		}
		if (semResults.length > 0) {
			append(strip, $('span.codebase-stat', undefined, `+${semResults.length} semantic`));
		}

		// Column headers
		const hdr = append(card, $('.codebase-result-row.codebase-result-header'));
		append(hdr, $('span.codebase-col-rank', undefined, '#'));
		append(hdr, $('span.codebase-col-name', undefined, 'Symbol'));
		append(hdr, $('span.codebase-col-type', undefined, 'Type'));
		append(hdr, $('span.codebase-col-file', undefined, 'File'));
		append(hdr, $('span.codebase-col-score', undefined, 'Score'));

		const maxShow = Math.min(nodes.length, 10);
		for (let i = 0; i < maxShow; i++) {
			const n = nodes[i];
			const row = append(card, $('.codebase-result-row'));
			append(row, $('span.codebase-col-rank', undefined, String(i + 1)));
			append(row, $('span.codebase-col-name', undefined, n.name || n.id || '?'));
			append(row, $('span.codebase-col-type', undefined, n.type || ''));
			const file = (n.filePath || '').split('/').pop() || n.filePath || '';
			append(row, $('span.codebase-col-file', undefined, file));
			const score = data.scores && data.scores[n.id] ? data.scores[n.id].toFixed(1) : (n.score ? n.score.toFixed(1) : '-');
			append(row, $('span.codebase-col-score', undefined, score));
		}

		// Semantic results section
		if (semResults.length > 0) {
			append(card, $('.codebase-section-title', undefined, '🔮 Semantic Results'));
			for (let i = 0; i < Math.min(semResults.length, 5); i++) {
				const s = semResults[i];
				const srow = append(card, $('.codebase-result-row.codebase-semantic-row'));
				append(srow, $('span.codebase-col-name', undefined, s.name || s.id));
				append(srow, $('span.codebase-col-type', undefined, s.type || ''));
				const sScore = s.score ? s.score.toFixed(2) : '-';
				append(srow, $('span.codebase-col-score', undefined, sScore));
			}
		}

		if (hasMore) {
			append(card, $('.codebase-page-hint', undefined, `⚡ hasMore = true — 共 ${total} 条结果，当前显示前 ${maxShow} 条。用 offset=${maxShow} 翻页查看更多。`));
		}

		return card;
	}

	/** search_code — 代码匹配 + 上下文 */
	private _renderSearchCodeCard(card: HTMLElement, data: any): HTMLElement {
		const results = data.results || [];
		const total = data.total ?? results.length;
		const mode = data.mode || 'compact';

		const strip = append(card, $('.codebase-summary'));
		append(strip, $('span.codebase-stat', undefined, `${results.length} / ${total} matches`));
		append(strip, $('span.codebase-stat', undefined, `mode: ${mode}`));

		for (let i = 0; i < Math.min(results.length, 5); i++) {
			const r = results[i];
			const entry = append(card, $('.codebase-search-code-entry'));

			const meta = append(entry, $('.codebase-search-code-meta'));
			const sym = r.symbol ? ` [${r.type || ''} ${r.symbol}]` : '';
			append(meta, $('span', undefined, `${r.filePath || ''}:${r.lineNo || ''}${sym}`));

			if (r.text) {
				append(entry, $('pre.codebase-search-code-line', undefined, r.text));
			}
			if (r.context) {
				const ctx = append(entry, $('.codebase-search-code-context'));
				append(ctx, $('pre', undefined, r.context));
			}
		}

		return card;
	}

	/** get_architecture — 架构总览 */
	private _renderArchitectureCard(card: HTMLElement, data: any): HTMLElement {
		// Stats grid
		const grid = append(card, $('.codebase-arch-grid'));
		const stats: [string, any, string][] = [
			['Total Nodes', data.totalNodes, ''],
			['Total Edges', data.totalEdges, ''],
			['Languages', Array.isArray(data.languages) ? data.languages.length : Object.keys(data.languages || {}).length, ''],
			['Packages', data.packages ? data.packages.length : 0, ''],
		];
		for (const [label, value, ] of stats) {
			if (value === null || value === undefined) { continue; }
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, String(value)));
			append(cell, $('.codebase-arch-label', undefined, label));
		}

		// Communities
		const communities = data.communities || [];
		if (communities.length > 0) {
			append(card, $('.codebase-section-title', undefined, `🏘️ Communities (${communities.length})`));
			const cGrid = append(card, $('.codebase-comm-grid'));
			for (const c of communities.slice(0, 6)) {
				const cc = append(cGrid, $('.codebase-comm-card'));
				append(cc, $('.codebase-comm-name', undefined, c.label || c.name || ''));
				const mems = c.members || c.size || 0;
				const coh = c.cohesion != null ? ` · cohesion ${(c.cohesion * 100).toFixed(0)}%` : '';
				append(cc, $('.codebase-comm-stats', undefined, `${mems} nodes${coh}`));
				if (c.topNodes && c.topNodes.length > 0) {
					const tops = c.topNodes.slice(0, 3).map((n: any) => n.name || n).join(', ');
					append(cc, $('.codebase-comm-top', undefined, `Top: ${tops}`));
				}
			}
		}

		return card;
	}

	/** trace_path — 调用链追踪 */
	private _renderTracePathCard(card: HTMLElement, data: any): HTMLElement {
		const hops = data.hops || data.path || [];
		if (!Array.isArray(hops) || hops.length === 0) { return card; }

		const strip = append(card, $('.codebase-summary'));
		append(strip, $('span.codebase-stat', undefined, `${hops.length} hops`));
		if (data.mode) { append(strip, $('span.codebase-stat', undefined, `mode: ${data.mode}`)); }

		for (let i = 0; i < Math.min(hops.length, 15); i++) {
			const h = hops[i];
			const row = append(card, $('.codebase-trace-hop'));
			append(row, $('span.codebase-hop-num', undefined, `H${i}`));
			if (i > 0) { append(row, $('span.codebase-hop-arrow', undefined, '→')); }
			append(row, $('span.codebase-hop-name', undefined, h.name || h.function || h.callee || h.caller || '?'));

			const risk = h.risk || (h.depth >= 3 ? 'High' : h.depth >= 2 ? 'Med' : 'Low');
			const riskClass = risk === 'Critical' ? 'codebase-risk-crit' : risk === 'High' ? 'codebase-risk-high' : risk === 'Med' ? 'codebase-risk-med' : 'codebase-risk-low';
			append(row, $('span.codebase-hop-risk.' + riskClass, undefined, risk));
		}

		return card;
	}

	/** index_repository — 索引进度/完成 */
	private _renderIndexRepoCard(card: HTMLElement, data: any): HTMLElement {
		const strip = append(card, $('.codebase-summary'));
		if (data.success !== false) {
			append(strip, $('span.codebase-stat.codebase-stat-ok', undefined, '✓ success'));
		} else {
			append(strip, $('span.codebase-stat.codebase-stat-err', undefined, '✗ failed'));
		}
		if (data.message) {
			append(strip, $('span.codebase-stat', undefined, data.message));
		}

		const grid = append(card, $('.codebase-arch-grid'));
		if (data.filesScanned) {
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, String(data.filesScanned)));
			append(cell, $('.codebase-arch-label', undefined, 'Files Scanned'));
		}
		if (data.nodesExtracted) {
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, String(data.nodesExtracted)));
			append(cell, $('.codebase-arch-label', undefined, 'Nodes'));
		}
		if (data.edgesExtracted) {
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, String(data.edgesExtracted)));
			append(cell, $('.codebase-arch-label', undefined, 'Edges'));
		}
		const excludedDirs = data.excludedDirs || data.skipped || [];
		if (excludedDirs.length > 0) {
			append(card, $('.codebase-page-hint', undefined, `⏭️ Skipped: ${Array.isArray(excludedDirs) ? excludedDirs.length : excludedDirs} paths (e.g. ${String(Array.isArray(excludedDirs) ? excludedDirs.slice(0, 3).join(', ') : excludedDirs)})`));
		}

		return card;
	}

	/** 其他 codebase 工具 — 紧凑摘要卡 */
	private _renderCodebaseSummaryCard(card: HTMLElement, key: string, data: any): HTMLElement {
		// 提取关键字段
		const keys = Object.keys(data).filter(k => !['success', 'message', 'hint', '_scopePath', '_scoped'].includes(k));
		const grid = append(card, $('.codebase-arch-grid'));
		for (const k of keys.slice(0, 6)) {
			const v = data[k];
			if (v === null || v === undefined) { continue; }
			const display = typeof v === 'object' ? JSON.stringify(v).substring(0, 60) : String(v);
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, display));
			append(cell, $('.codebase-arch-label', undefined, k));
		}
		return card;
	}

	/** kanban_list 结果 → 表格卡片 */
	private _createKanbanListCard(resultText: string): HTMLElement | null {
		const text = this._toolResultText(resultText);
		// 尝试解析为结构化数据（kanban_list handler 返回文本格式）
		const lines = text.split('\n').filter(l => l.trim());
		if (lines.length <= 1) { return null; }

		const card = $('.kanban-result-card');
		const tableWrap = append(card, $('.kanban-result-table'));
		// 表头
		const header = append(tableWrap, $('.kanban-result-row.kanban-result-header'));
		append(header, $('span.kanban-col-id', undefined, '#'));
		append(header, $('span.kanban-col-title', undefined, '标题'));
		append(header, $('span.kanban-col-status', undefined, '状态'));
		// 解析每行 — 同时兼容两种后端格式:
		//   (1) `  #abc123  [triage]  任务标题`          (历史带方括号)
		//   (2) `  #abc123  triage    — 任务标题`        (当前无方括号+破折号)
		// ID 段用 \S+ 捕获非空字符（兼容 6 位 hex、长 alphanum、含 -_）
		for (const line of lines) {
			const m = line.match(/#(\S+)\s+(?:\[(\w+)\]|(\w+))\s*[—\-]?\s*(.*)/i);
			if (!m) { continue; }
			const status = (m[2] || m[3] || '').toLowerCase();
			const title = (m[4] || '').replace(/^[—\-\s]+/, '').trim();
			if (!status || !title) { continue; }
			const row = append(tableWrap, $('.kanban-result-row'));
			append(row, $('span.kanban-col-id', undefined, `#${m[1]}`));
			append(row, $('span.kanban-col-title', undefined, title));
			const badge = append(row, $('span.kanban-col-status.kanban-status-badge'));
			badge.textContent = status;
			badge.classList.add(`kanban-status-${status}`);
		}
		return card;
	}

	/** kanban_show 结果 → 详情卡片 */
	private _createKanbanShowCard(resultText: string): HTMLElement | null {
		const text = this._toolResultText(resultText);
		const card = $('.kanban-detail-card');
		for (const line of text.split('\n')) {
			const m = line.match(/^\s+(.+?):\s+(.*)/);
			if (m) {
				const row = append(card, $('.kanban-detail-row'));
				append(row, $('span.kanban-detail-label', undefined, m[1]));
				append(row, $('span.kanban-detail-value', undefined, m[2]));
			}
		}
		return card;
	}

	/** workflow_list 结果 → 工作流卡片网格 */
	private _createWorkflowListCard(resultText: string): HTMLElement | null {
		const text = this._toolResultText(resultText);
		let data: any[];
		try { data = JSON.parse(text); } catch { return null; }
		if (!Array.isArray(data) || data.length === 0) { return null; }

		const card = $('.workflow-list-card');
		for (const wf of data) {
			const item = append(card, $('.workflow-list-item'));
			const header = append(item, $('.workflow-list-item-header'));
			append(header, $('span.codicon.codicon-circuit-board'));
			append(header, $('span.workflow-list-item-name', undefined, wf.name || '(unnamed)'));
			const meta = append(item, $('.workflow-list-item-meta'));
			if (typeof wf.nodeCount === 'number') {
				append(meta, $('span.workflow-list-item-nodes', undefined, `${wf.nodeCount} 节点`));
			}
			if (wf.description) {
				append(item, $('span.workflow-list-item-desc', undefined, wf.description));
			}
		}
		return card;
	}

	/** memory_search 结果 → 搜索结果列表 */
	private _createMemorySearchCard(resultText: string): HTMLElement | null {
		const text = this._toolResultText(resultText);
		let data: any[];
		try { data = JSON.parse(text); } catch { return null; }
		if (!Array.isArray(data) || data.length === 0) { return null; }

		const card = $('.memory-search-card');
		for (const mem of data) {
			const item = append(card, $('.memory-search-item'));
			const header = append(item, $('.memory-search-item-header'));
			if (mem.type) {
				const typeBadge = append(header, $('span.memory-type-badge'));
				typeBadge.textContent = mem.type;
			}
			if (mem.tags && Array.isArray(mem.tags)) {
				for (const tag of mem.tags.slice(0, 3)) {
					append(header, $('span.memory-tag-badge', undefined, tag));
				}
			}
			if (mem.content) {
				const preview = mem.content.length > 120 ? mem.content.substring(0, 120) + '…' : mem.content;
				append(item, $('span.memory-search-item-content', undefined, preview));
			}
			if (mem.score !== undefined) {
				append(item, $('span.memory-search-item-score', undefined, `相关度: ${(mem.score * 100).toFixed(0)}%`));
			}
		}
		return card;
	}

	/** memory_list 结果 → 分组列表 */
	private _createMemoryListCard(resultText: string): HTMLElement | null {
		const text = this._toolResultText(resultText);
		let data: any[];
		try { data = JSON.parse(text); } catch { return null; }
		if (!Array.isArray(data) || data.length === 0) { return null; }

		// 按类型分组
		const groups: Record<string, any[]> = {};
		for (const mem of data) {
			const type = mem.type || 'unknown';
			if (!groups[type]) { groups[type] = []; }
			groups[type].push(mem);
		}

		const card = $('.memory-list-card');
		for (const [type, entries] of Object.entries(groups)) {
			const section = append(card, $('.memory-list-group'));
			const header = append(section, $('.memory-list-group-header'));
			const label = type === 'episodic' ? '情景记忆' :
				type === 'semantic' ? '语义记忆' :
				type === 'procedural' ? '过程记忆' :
				type === 'working' ? '工作记忆' : type;
			append(header, $('span.codicon.codicon-database'));
			append(header, $('span.memory-list-group-label', undefined, `${label} (${entries.length})`));
			for (const mem of entries) {
				const item = append(section, $('.memory-list-item'));
				if (mem.content) {
					const preview = mem.content.length > 80 ? mem.content.substring(0, 80) + '…' : mem.content;
					append(item, $('span.memory-list-item-content', undefined, preview));
				}
			}
		}
		return card;
	}

	/** 状态感知标题（void titleOfBuiltinToolName）。 */
	private _getToolTitle(key: string, displayName: string | undefined, name: string, isRunning: boolean): string {
		const builtin = TOOL_BUILTIN_TITLES[key];
		if (!builtin) {
			const label = displayName || name || 'MCP';
			const prefix = isRunning ? '正在调用' : '调用了';
			return `${prefix} ${label}`;
		}
		return isRunning ? builtin.running : builtin.done;
	}

	/** 斜体 desc：文件名 / 命令 / 查询（void toolNameToDesc）。 */
	private _getToolDesc1(key: string, args: string | undefined, filePath: string | undefined): string {
		let p: Record<string, unknown> = {};
		try { p = args ? JSON.parse(args) : {}; } catch { p = {}; }
		const basename = (s: string) => {
			const parts = s.replace(/\\/g, '/').split('/').filter(Boolean);
			return parts[parts.length - 1] || s;
		};
		const fp = (filePath || p.file_path || p.filePath || p.path || p.uri) as string | undefined;
		const query = (p.query || p.pattern || p.search_query || p.search) as string | undefined;
		const command = (p.command || p.cmd) as string | undefined;
		const clip = (s: string) => (s.length > 60 ? s.slice(0, 60) + '…' : s);

		if (TOOL_TERMINAL_TOOLS.has(key)) {
			return command ? `"${clip(command)}"` : '';
		}
		if (key.includes('search') || key === 'grep') {
			return query ? `"${clip(query)}"` : '';
		}
		if (fp && typeof fp === 'string') {
			let d = basename(fp);
			const start = (p.start_line ?? p.startLine ?? p.offset) as number | undefined;
			const end = (p.end_line ?? p.endLine) as number | undefined;
			if ((key === 'file_read' || key === 'read_file' || key === 'read') && (start !== undefined && start !== null)) {
				d += ` (${start}${end !== undefined && end !== null ? '-' + end : ''})`;
			}
			return d;
		}
		if (query && typeof query === 'string') { return `"${clip(query)}"`; }
		if (command && typeof command === 'string') { return `"${clip(command)}"`; }
		const firstStr = Object.values(p).find(v => typeof v === 'string' && (v as string).length > 0) as string | undefined;
		return firstStr ? clip(firstStr) : '';
	}

	/** 把工具结果（可能是 JSON / content-part 数组 / 纯文本）规整为可读文本。 */
	private _toolResultText(result: string): string {
		try {
			const parsed = JSON.parse(result);
			if (typeof parsed === 'string') { return parsed; }
			if (parsed && Array.isArray((parsed as any).content)) {
				return (parsed as any).content
					.map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
					.join('');
			}
			return JSON.stringify(parsed, null, 2);
		} catch {
			return result;
		}
	}

	/** 解析列表类结果为 {name, path}[]（void parseListItems）。 */
	private _parseToolListItems(resultText: string): Array<{ name: string; path?: string }> | null {
		if (!resultText) { return null; }
		const basename = (s: string) => {
			const parts = s.replace(/\\/g, '/').split('/').filter(Boolean);
			return parts[parts.length - 1] || s;
		};
		try {
			const parsed = JSON.parse(resultText);
			const arr = Array.isArray(parsed) ? parsed
				: Array.isArray(parsed?.items) ? parsed.items
					: Array.isArray(parsed?.children) ? parsed.children
						: Array.isArray(parsed?.list) ? parsed.list
							: Array.isArray(parsed?.uris) ? parsed.uris
								: null;
			if (!arr) { return null; }
			const mapped: Array<{ name: string; path?: string }> = [];
			for (const it of arr) {
				if (typeof it === 'string') { mapped.push({ name: basename(it), path: it }); continue; }
				if (!it || typeof it !== 'object') { continue; }
				const anyIt = it as Record<string, unknown>;
				const path = (anyIt.path || anyIt.uri || anyIt.fsPath || anyIt.file || '') as string;
				const nameRaw = (anyIt.name || anyIt.content) as string | undefined;
				if (!path && !nameRaw) { continue; }
				const name = (nameRaw || basename(path)) as string;
				if (!name) { continue; }
				const isDir = anyIt.isDirectory === true || anyIt.item_type === 'directory' || anyIt.type === 'directory' || anyIt.type === 'dir';
				mapped.push({ name: `${name}${isDir && !String(name).endsWith('/') ? '/' : ''}`, path: path || undefined });
			}
			return mapped.length > 0 ? mapped : null;
		} catch {
			const lines = resultText.split('\n').map(l => l.trim()).filter(Boolean);
			return lines.length > 0 ? lines.map(l => ({ name: l })) : null;
		}
	}



	/** 格式化毫秒时长 */
	private _formatDuration(ms: number): string {
		if (ms < 1000) { return `${ms}ms`; }
		const seconds = ms / 1000;
		if (seconds < 60) { return `${seconds.toFixed(1)}s`; }
		const minutes = Math.floor(seconds / 60);
		const remainSec = Math.round(seconds % 60);
		return `${minutes}m ${remainSec}s`;
	}

	// --- Sub-agent card (enhanced panel-style matching React screenshot) ---

	private _createSubAgentCard(sa: ISubAgentData): HTMLElement {
		const isRunning = sa.status === 'running';
		const isDone = sa.status === 'done';
		const isError = sa.status === 'error';

		// Type config
		const typeConfig = sa.type === 'explore' ? { icon: '🔍', label: '探索' } :
							sa.type === 'scout' ? { icon: '🌐', label: '研究' } :
							{ icon: '⚙️', label: '通用' };

		// ── Card container ──
		const saCard = $(`.subagent-card.enhanced${isRunning ? '.active' : ''}${isDone || isError ? '.collapsed' : ''}`);

		// ── Header ──
		const saHeader = append(saCard, $('.subagent-card-header'));
		// Icon
		const headerIcon = append(saHeader, $('span.subagent-card-header-icon'));
		headerIcon.textContent = typeConfig.icon;
		// Title (with shimmer if running)
		const saTitle = append(saHeader, $(`span.subagent-card-title${isRunning ? '.shimmer' : ''}`));
		saTitle.textContent = sa.task || `SubAgent (${typeConfig.label})`;
		// Close button (X icon)
		const closeBtn = append(saHeader, $('button.subagent-card-close-btn'));
		closeBtn.appendChild(this._createCloseIconSVG());

		// ── Body (markdown content) ──
		const saBody = append(saCard, $('.subagent-card-body'));
		const bodyContent = append(saBody, $('.subagent-card-body-content'));

		// Render content based on status
		if (isDone && sa.output) {
			// Done: show output with markdown rendering
			const mdString: IMarkdownString = { value: sa.output, isTrusted: true, supportHtml: true };
			// Track disposable to prevent leaks on DOM rebuild
			const prevDisposable = this._markdownDisposables.get(bodyContent);
			if (prevDisposable) { prevDisposable.dispose(); }
			this._markdownDisposables.set(bodyContent, renderMarkdown(mdString, undefined, bodyContent));
		} else if (isError && sa.error) {
			// Error: show error message
			const errorEl = append(bodyContent, $('div.subagent-card-error'));
			errorEl.textContent = sa.error;
		} else if (sa.task) {
			// Fallback: show task description
			const taskEl = append(bodyContent, $('p.subagent-card-task'));
			taskEl.textContent = sa.task;
		}

		// ── Footer (Execution Summary) ──
		const saFooter = append(saCard, $('.subagent-card-footer'));

		// Status summary
		const statusSummary = append(saFooter, $('span.subagent-exec-summary'));
		const statusLabel = append(statusSummary, $('span.subagent-exec-summary-label'));
		statusLabel.textContent = '状态: ';
		const statusValue = append(statusSummary, $('span.subagent-exec-stat'));
		statusValue.textContent = isRunning ? '运行中' : isDone ? '完成' : isError ? '失败' : '未知';

		// Tool calls summary (if available)
		if (sa.toolTraces && sa.toolTraces.length > 0) {
			const toolsSummary = append(saFooter, $('span.subagent-exec-summary'));
			const toolsLabel = append(toolsSummary, $('span.subagent-exec-summary-label'));
			toolsLabel.textContent = '工具: ';
			const toolsValue = append(toolsSummary, $('span.subagent-exec-stat'));
			const runningCount = sa.toolTraces.filter(t => t.status === 'running').length;
			const doneCount = sa.toolTraces.filter(t => t.status === 'done').length;
			const errorCount = sa.toolTraces.filter(t => t.status === 'error').length;
			toolsValue.textContent = `${doneCount}完成 · ${runningCount}运行 · ${errorCount}失败`;
		}

		// ── Interactions ──
		// Header click → toggle collapse (excluding close button)
		this._register(addDisposableListener(saHeader, EventType.CLICK, () => {
			saCard.classList.toggle('collapsed');
		}));

		// Close button → remove card (with stopPropagation to prevent toggle)
		this._register(addDisposableListener(closeBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			saCard.remove();
		}));

		return saCard;
	}

// --- LiveWorkflowTraceView -----------------------------------

	/** Create an SVG close (X) icon using DOM API (avoids TrustedHTML innerHTML issues). */
	private _createCloseIconSVG(): SVGElement {
		const ns = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('width', '12');
		svg.setAttribute('height', '12');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2.5');
		const l1 = document.createElementNS(ns, 'line');
		l1.setAttribute('x1', '18'); l1.setAttribute('y1', '6'); l1.setAttribute('x2', '6'); l1.setAttribute('y2', '18');
		const l2 = document.createElementNS(ns, 'line');
		l2.setAttribute('x1', '6'); l2.setAttribute('y1', '6'); l2.setAttribute('x2', '18'); l2.setAttribute('y2', '18');
		svg.appendChild(l1); svg.appendChild(l2);
		return svg;
	}

	private _createLiveWorkflowTraceView(
		workflowExecutions: Record<string, ILiveWorkflowExecution>,
		workflowEvents?: ILiveWorkflowEvent[],
		collectVariables?: Record<string, ILiveCollectVariable>
	): HTMLElement {
		const container = $('.wf-trace');

		for (const [execId, exec] of Object.entries(workflowExecutions)) {
			// ── Workflow Card ──
			const card = append(container, $('.wf-card'));
			card.classList.add(exec.status); // running | completed | failed | cancelled

			// ── Header ──
			const header = append(card, $('.wf-header'));
			const toggle = append(header, $('span.wf-toggle', undefined, '▼'));
			append(header, $('span.wf-icon', undefined, '🔀'));
			append(header, $('span.wf-name', undefined, exec.workflowName || 'Workflow'));
			const statusMap: Record<string, { label: string; cls: string }> = {
				running: { label: '运行中', cls: 'running' },
				completed: { label: '已完成', cls: 'completed' },
				failed: { label: '失败', cls: 'failed' },
				cancelled: { label: '已取消', cls: 'cancelled' },
			};
			const sInfo = statusMap[exec.status] ?? { label: exec.status, cls: 'running' };
			const badge = append(header, $('span.wf-status-badge'));
			badge.classList.add(sInfo.cls);
			if (sInfo.cls === 'running') {
				append(badge, $('span.dot'));
				append(badge, document.createTextNode(sInfo.label));
			} else {
				const icon = sInfo.cls === 'completed' ? '✓' : sInfo.cls === 'failed' ? '✗' : '⛔';
				append(badge, document.createTextNode(`${icon} ${sInfo.label}`));
			}

			// ── Body ──
			const body = append(card, $('.wf-body'));

			// ── Collect Variables Card (if pending) ──
			if (collectVariables) {
				const vars = Object.values(collectVariables).filter(v => v.executionId === execId);
				for (const cv of vars) {
					if (cv.status === 'pending') {
						body.appendChild(this._createCollectVarsCard(execId, cv));
					}
				}
			}

			// ── Node Cards ──
			for (const sa of exec.subAgents) {
				if (sa.id === '__workflow__') { continue; } // skip synthetic root
				body.appendChild(this._createNodeCard(sa));
			}

			// ── Timeline ──
			if (workflowEvents && workflowEvents.length > 0) {
				const events = workflowEvents.filter(e => e.executionId === execId);
				if (events.length > 0) {
					card.appendChild(this._createTimeline(exec, events));
				}
			}

			// ── Header toggle ──
			this._register(addDisposableListener(header, EventType.CLICK, () => {
				const isHidden = body.style.display === 'none';
				body.style.display = isHidden ? '' : 'none';
				toggle.textContent = isHidden ? '▼' : '▶';
				toggle.classList.toggle('collapsed', !isHidden);
			}));
		}

		return container;
	}

	/** Create a collect-variables card with input fields and submit button. */
	private _createCollectVarsCard(execId: string, cv: ILiveCollectVariable): HTMLElement {
		const card = $('.collect-vars-card');
		const header = append(card, $('.collect-vars-header'));
		append(header, $('span.icon', undefined, '📝'));
		append(header, $('span.title', undefined, '请填入工作流变量'));

		const form = append(card, $('.collect-vars-form'));
		const inputs: HTMLInputElement[] = [];
		for (const v of cv.variables) {
			const field = append(form, $('.collect-vars-field'));
			append(field, $('label', undefined, `${v.name}${v.defaultValue ? ` (默认: ${v.defaultValue})` : ''}`));
			const input = document.createElement('input');
			input.type = 'text';
			input.className = 'collect-vars-input';
			input.placeholder = v.defaultValue ? `默认: ${v.defaultValue}` : `请输入 ${v.name}`;
			input.value = cv.values[v.name] ?? v.defaultValue ?? '';
			field.appendChild(input);
			inputs.push(input);
		}
		if (this._onSubmitVariables) {
			const btn = append(form, $('button.collect-vars-submit', undefined, '提交')) as HTMLButtonElement;
			this._register(addDisposableListener(btn, EventType.CLICK, () => {
				const values: Record<string, string> = {};
				cv.variables.forEach((v, i) => { values[v.name] = inputs[i]?.value ?? v.defaultValue ?? ''; });
				this._onSubmitVariables!(execId, values);
				btn.disabled = true;
				btn.textContent = '已提交';
			}));
		}
		return card;
	}

	/** Create a single node card (subagent / prompt / skill / tool). */
	private _createNodeCard(sa: ILiveWorkflowSubAgent): HTMLElement {
		const isRunning = sa.status === 'running';
		const isDone = sa.status === 'done';
		const isError = sa.status === 'error';

		const card = $('.node-card');
		card.classList.add(sa.status); // running | done | error | pending | cancelled

		// ── Collapse state (persists across re-renders) ──
		const userCollapsed = this._nodeCollapsedState.get(sa.id) === true;
		if (userCollapsed) { card.classList.add('collapsed'); }

		// ── Header ──
		const header = append(card, $('.node-header'));

		// Type icon
		const typeIcons: Record<string, { icon: string; cls: string }> = {
			agent: { icon: '🤖', cls: 'agent' },
			prompt: { icon: '📝', cls: 'prompt' },
			skill: { icon: '⚡', cls: 'skill' },
			tool: { icon: '🔧', cls: 'tool' },
		};
		const typeKey = (sa as any).type ?? 'agent';
		const tInfo = typeIcons[typeKey] ?? typeIcons.agent;
		const iconEl = append(header, $('.node-type-icon'));
		iconEl.classList.add(tInfo.cls);
		iconEl.textContent = tInfo.icon;

		// Info (name + task)
		const info = append(header, $('.node-info'));
		append(info, $('.node-name', undefined, sa.name));
		if (sa.task) {
			append(info, $('.node-task', undefined, sa.task));
		}

		// ── Collapse/expand button ──
		const collapseBtn = append(header, $('button.node-collapse-btn'));
		collapseBtn.classList.add(userCollapsed ? 'collapsed' : 'expanded');
		collapseBtn.title = userCollapsed ? '点击展开' : '点击收缩';
		const chevron = append(collapseBtn, $('span.icon-chevron'));
		chevron.textContent = userCollapsed ? '▶' : '▼';

		// Status indicator
		const statusEl = append(header, $('.node-status'));
		// Duration
		const dur = sa.endTime ? ((sa.endTime - sa.startTime) / 1000).toFixed(1) + 's' : isRunning ? '...' : '';
		if (dur) { append(statusEl, $('span.node-duration', undefined, dur)); }
		// Icon
		if (isRunning) {
			append(statusEl, $('span.spinner'));
		} else if (isDone) {
			append(statusEl, $('span.check', undefined, '✓'));
		} else if (isError) {
			append(statusEl, $('span.error', undefined, '✗'));
		} else {
			append(statusEl, $('span.node-pending', undefined, '等待中'));
		}

		// ── Body (collapsible) ──
		const nodeBody = append(card, $('.node-body'));
		if (userCollapsed) { nodeBody.style.display = 'none'; }

		// Streamed text / output / error
		if (isRunning && sa.streamedText) {
			const out = append(nodeBody, $('.node-output.running'));
			const md: IMarkdownString = { value: sa.streamedText, isTrusted: true, supportHtml: true };
			// Use renderMarkdown with parent element to track disposable lifecycle
			const prevDisposable = this._markdownDisposables.get(out);
			if (prevDisposable) { prevDisposable.dispose(); }
			this._markdownDisposables.set(out, renderMarkdown(md, undefined, out));
		} else if (isDone && (sa.output || sa.streamedText)) {
			const out = append(nodeBody, $('.node-output.done'));
			const text = sa.output || sa.streamedText || '';
			const md: IMarkdownString = { value: text, isTrusted: true, supportHtml: true };
			const prevDisposable = this._markdownDisposables.get(out);
			if (prevDisposable) { prevDisposable.dispose(); }
			this._markdownDisposables.set(out, renderMarkdown(md, undefined, out));
		} else if (isError && sa.error) {
			const out = append(nodeBody, $('.node-output.error'));
			out.textContent = sa.error;
		}

		// Tool calls
		if (sa.toolCalls && sa.toolCalls.length > 0) {
			const toolList = append(nodeBody, $('.tool-list'));
			for (const tc of sa.toolCalls as any[]) {
				const item = append(toolList, $('.tool-item'));
				const ti = append(item, $('.tool-icon'));
				ti.textContent = '🔧';
				append(item, $('span.tool-name', undefined, tc.name ?? 'unknown'));
				const ts = append(item, $('span.tool-status'));
				ts.classList.add(tc.status ?? 'done');
				const tIcon = tc.status === 'running' ? 'running...' : tc.status === 'error' ? '✗ error' : '✓ done';
				ts.textContent = tIcon;
			}
		}

		// ── Summary row (visible only when collapsed) ──
		const summary = append(card, $('.node-summary'));
		summary.style.display = userCollapsed ? 'block' : 'none';
		const toolCount = sa.toolCalls?.length ?? 0;
		const outputLen = (sa.output?.length ?? sa.streamedText?.length ?? 0);
		const parts: string[] = [];
		if (toolCount > 0) { parts.push(`${toolCount} 个工具调用`); }
		if (outputLen > 0) { parts.push(`输出约 ${outputLen} 字`); }
		if (isRunning) { parts.unshift('处理中'); }
		append(summary, $('span.node-summary-text', undefined, parts.join(' · ') || '暂无输出'));

		// ── Collapse/expand interaction ──
		// Toggle via button click. State is persisted in _nodeCollapsedState
		// so that DOM rebuilds (streaming updates) respect the user's choice
		// and do NOT auto-expand a manually-collapsed node.
		this._register(addDisposableListener(collapseBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			this._toggleNodeCollapse(sa.id, card, nodeBody, summary, collapseBtn, chevron);
		}));
		// Also allow header click (excluding the button itself) to toggle
		this._register(addDisposableListener(header, EventType.CLICK, (e) => {
			if (e.target === collapseBtn || collapseBtn.contains(e.target as Node)) { return; }
			this._toggleNodeCollapse(sa.id, card, nodeBody, summary, collapseBtn, chevron);
		}));

		return card;
	}

	/** Toggle a node card's collapsed/expanded state and persist it. */
	private _toggleNodeCollapse(
		nodeId: string,
		card: HTMLElement,
		nodeBody: HTMLElement,
		summary: HTMLElement,
		collapseBtn: HTMLElement,
		chevron: HTMLElement,
	): void {
		const isCollapsed = this._nodeCollapsedState.get(nodeId) === true;
		const newCollapsed = !isCollapsed;
		this._nodeCollapsedState.set(nodeId, newCollapsed);

		nodeBody.style.display = newCollapsed ? 'none' : '';
		summary.style.display = newCollapsed ? 'block' : 'none';
		card.classList.toggle('collapsed', newCollapsed);

		collapseBtn.classList.toggle('collapsed', newCollapsed);
		collapseBtn.classList.toggle('expanded', !newCollapsed);
		collapseBtn.title = newCollapsed ? '点击展开' : '点击收缩';
		chevron.textContent = newCollapsed ? '▶' : '▼';
	}

	/** Create the bottom timeline bar showing node progress. */
	private _createTimeline(exec: ILiveWorkflowExecution, events: ILiveWorkflowEvent[]): HTMLElement {
		const timeline = $('.wf-timeline');

		// Build ordered node list from events
		const nodeOrder: string[] = [];
		const nodeStatus: Record<string, string> = {};
		for (const e of events) {
			if (e.kind === 'subagent_start' && e.nodeId !== '__workflow__' && !nodeOrder.includes(e.nodeId)) {
				nodeOrder.push(e.nodeId);
			}
			if (e.kind === 'subagent_start') {
				nodeStatus[e.nodeId] = 'active';
			}
			if (e.kind === 'subagent_end') {
				nodeStatus[e.nodeId] = e.status === 'done' ? 'done' : e.status === 'error' ? 'error' : 'done';
			}
		}
		// Also include nodes from subAgents
		for (const sa of exec.subAgents) {
			if (sa.id === '__workflow__') { continue; }
			if (!nodeOrder.includes(sa.id)) { nodeOrder.push(sa.id); }
			if (sa.status === 'running') { nodeStatus[sa.id] = 'active'; }
			else if (sa.status === 'done') { nodeStatus[sa.id] = 'done'; }
			else if (sa.status === 'error') { nodeStatus[sa.id] = 'error'; }
		}

		// Render: start → node1 → node2 → ... → end
		append(timeline, this._createTimelineItem('start', exec.status === 'running' ? 'active' : 'done'));
		for (let i = 0; i < nodeOrder.length; i++) {
			const nodeId = nodeOrder[i];
			const label = events.find(e => e.nodeId === nodeId)?.nodeName ?? nodeId;
			const st = nodeStatus[nodeId] ?? '';
			append(timeline, $('span.wf-timeline-arrow', undefined, '→'));
			append(timeline, this._createTimelineItem(label, st));
		}
	append(timeline, $('span.wf-timeline-arrow', undefined, '→'));
	const endStatus = exec.status === 'completed' ? 'done' : exec.status === 'failed' ? 'error' : exec.status === 'cancelled' ? 'done' : 'active';
	append(timeline, this._createTimelineItem('end', endStatus));

		return timeline;
	}

	private _createTimelineItem(label: string, status: string): HTMLElement {
		const el = $('.wf-timeline-item');
		if (status) { el.classList.add(status); }
		el.textContent = label;
		return el;
	}

	// --- Confirmation card -----------------------------------

	private _createConfirmationCard(cf: IConfirmationData): HTMLElement {
		// Terminal confirmation card (has command field)
		if (cf.command) {
			return this._createTerminalConfirmationCard(cf);
		}

		const card = $('.confirmation-card');
		const header = append(card, $('.confirmation-card-header'));
		append(header, $('span.confirmation-card-title', undefined, cf.title));
		// Security level badge
		if (cf.securityLevel) {
			const badge = append(header, $(`span.security-badge.${cf.securityLevel}`));
			badge.textContent = cf.securityLevel === 'safe' ? '安全' : cf.securityLevel === 'cautious' ? '注意' : '危险';
		}
		const body = append(card, $('.confirmation-card-body'));
		append(body, $('p.confirmation-card-message', undefined, cf.message));
		if (cf.detail) {
			append(body, $('pre.confirmation-card-detail', undefined, cf.detail));
		}
		const actions = append(body, $('.confirmation-card-actions'));
		// Main action buttons
		for (const btn of cf.buttons) {
			const el = append(actions, $(
				`button.confirmation-card-btn${btn.primary ? '.primary' : ''}${btn.danger ? '.danger' : ''}`,
				undefined,
				btn.label,
			));
			this._register(addDisposableListener(el, EventType.CLICK, () => {
				this._onConfirmationAction?.(cf.id, btn.id);
			}));
		}
		// Auto-confirm options (once/session/workspace/always)
		if (cf.autoConfirmOptions?.length) {
			const autoSection = append(body, $('.confirmation-auto-options'));
			append(autoSection, $('span.confirmation-auto-options-label', undefined, '自动确认:'));
			for (const opt of cf.autoConfirmOptions) {
				const btn = append(autoSection, $('button.confirmation-auto-btn'));
				btn.textContent = opt.label;
				this._register(addDisposableListener(btn, EventType.CLICK, () => {
					this._onConfirmationAction?.(cf.id, opt.id);
				}));
			}
		}
		return card;
	}

	private _createTerminalConfirmationCard(cf: IConfirmationData): HTMLElement {
		const card = $('.confirmation-card.confirmation-card-terminal');
		const header = append(card, $('.confirmation-title-bar'));
		const titleContent = append(header, $('.confirmation-title-content'));
		// Terminal icon (chevron-right + line)
		const svgIcon = append(titleContent, $('svg'));
		svgIcon.setAttribute('width', '16');
		svgIcon.setAttribute('height', '16');
		svgIcon.setAttribute('viewBox', '0 0 24 24');
		svgIcon.setAttribute('fill', 'none');
		svgIcon.setAttribute('stroke', 'currentColor');
		svgIcon.setAttribute('stroke-width', '2');
		const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		polyline.setAttribute('points', '4 17 10 11 4 5');
		svgIcon.appendChild(polyline);
		const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		line.setAttribute('x1', '12');
		line.setAttribute('y1', '19');
		line.setAttribute('x2', '20');
		line.setAttribute('y2', '19');
		svgIcon.appendChild(line);

		append(titleContent, $('span.confirmation-title', undefined, '执行终端命令'));
		const badge = append(titleContent, $('span.confirmation-security-badge.security-cautious'));
		badge.textContent = '终端操作';

		// Command preview
		const cmdSection = append(card, $('.confirmation-terminal-command'));
		const cmdHeader = append(cmdSection, $('.terminal-command-header'));
		append(cmdHeader, $('span.terminal-prompt', undefined, '$'));
		const cmdText = cf.command || '';
		const isLong = cmdText.length > 100;
		const displayCmd = isLong ? cmdText.substring(0, 100) + '...' : cmdText;
		append(cmdHeader, $('code.terminal-command-text', undefined, displayCmd));

		if (isLong) {
			const showMoreBtn = append(cmdSection, $('button.terminal-show-more-btn'));
			showMoreBtn.textContent = '显示全部';
			// Toggle logic would need state management - simplified for now
		}

		// Action buttons
		const actions = append(card, $('.confirmation-actions'));
		const primaryAction = append(actions, $('.confirmation-primary-action'));

		const approveBtn = append(primaryAction, $('button.confirmation-btn.confirmation-btn-approve'));
		const approveSvg = append(approveBtn, $('svg'));
		approveSvg.setAttribute('width', '14');
		approveSvg.setAttribute('height', '14');
		approveSvg.setAttribute('viewBox', '0 0 24 24');
		approveSvg.setAttribute('fill', 'none');
		approveSvg.setAttribute('stroke', 'currentColor');
		approveSvg.setAttribute('stroke-width', '2');
		const approvePolyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		approvePolyline.setAttribute('points', '20 6 9 17 4 12');
		approveSvg.appendChild(approvePolyline);
		approveBtn.appendChild(document.createTextNode('执行'));
		this._register(addDisposableListener(approveBtn, EventType.CLICK, () => {
			this._onConfirmationAction?.(cf.id, 'allow_once');
		}));

		// Dropdown for more options
		const dropdownContainer = append(primaryAction, $('.confirmation-dropdown-container'));
		const dropdownToggle = append(dropdownContainer, $('button.confirmation-dropdown-toggle'));
		const toggleSvg = append(dropdownToggle, $('svg'));
		toggleSvg.setAttribute('width', '12');
		toggleSvg.setAttribute('height', '12');
		toggleSvg.setAttribute('viewBox', '0 0 24 24');
		toggleSvg.setAttribute('fill', 'none');
		toggleSvg.setAttribute('stroke', 'currentColor');
		toggleSvg.setAttribute('stroke-width', '2');
		const togglePolyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		togglePolyline.setAttribute('points', '6 9 12 15 18 9');
		toggleSvg.appendChild(togglePolyline);

		const dropdownMenu = append(dropdownContainer, $('.confirmation-dropdown-menu'));
		for (const opt of (cf.autoConfirmOptions || [
			{ id: 'allow_session', label: '在此会话中允许' },
			{ id: 'allow_workspace', label: '在工作区中允许' },
			{ id: 'allow_always', label: '始终允许' },
		])) {
			const item = append(dropdownMenu, $('button.confirmation-dropdown-item'));
			item.textContent = opt.label;
			this._register(addDisposableListener(item, EventType.CLICK, () => {
				this._onConfirmationAction?.(cf.id, opt.id);
			}));
		}

		// Reject button
		const rejectBtn = append(actions, $('button.confirmation-btn.confirmation-btn-reject'));
		const rejectSvg = append(rejectBtn, $('svg'));
		rejectSvg.setAttribute('width', '14');
		rejectSvg.setAttribute('height', '14');
		rejectSvg.setAttribute('viewBox', '0 0 24 24');
		rejectSvg.setAttribute('fill', 'none');
		rejectSvg.setAttribute('stroke', 'currentColor');
		rejectSvg.setAttribute('stroke-width', '2');
		const rejectLine1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		rejectLine1.setAttribute('x1', '18');
		rejectLine1.setAttribute('y1', '6');
		rejectLine1.setAttribute('x2', '6');
		rejectLine1.setAttribute('y2', '18');
		rejectSvg.appendChild(rejectLine1);
		const rejectLine2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		rejectLine2.setAttribute('x1', '6');
		rejectLine2.setAttribute('y1', '6');
		rejectLine2.setAttribute('x2', '18');
		rejectLine2.setAttribute('y2', '18');
		rejectSvg.appendChild(rejectLine2);
		rejectBtn.appendChild(document.createTextNode('取消'));
		this._register(addDisposableListener(rejectBtn, EventType.CLICK, () => {
			this._onConfirmationAction?.(cf.id, 'reject');
		}));

		return card;
	}

	// --- AskUser Card (workflow interactive input) ---

	private _createAskUserCard(askUser: ILiveWorkflowAskUser): HTMLElement {
		const card = $(`.askuser-card.${askUser.status}`);
		const isPending = askUser.status === 'pending';
		const isAnswered = askUser.status === 'answered';

		// Header
		const header = append(card, $('.askuser-card-header'));
		const headerStatus = isPending
			? { icon: '❓', label: '需要输入', color: 'var(--vscode-charts-blue, #60a5fa)' }
			: isAnswered
				? { icon: '✓', label: '已回答', color: 'var(--vscode-charts-green, #34d399)' }
				: { icon: '⊘', label: askUser.status === 'cancelled' ? '已取消' : '已过期', color: 'var(--as-fg-secondary, #6c757d)' };
		append(header, $('span.askuser-card-icon', { style: `color:${headerStatus.color}` }, headerStatus.icon));
		append(header, $('span.askuser-card-title', undefined, askUser.nodeName));
		append(header, $('span.askuser-card-status', { style: `color:${headerStatus.color}` }, headerStatus.label));

		// Question
		append(card, $('div.askuser-card-question', undefined, askUser.question));

		// Options (interactive only while pending)
		if (isPending) {
			const optionsDiv = append(card, $(`.askuser-options.${askUser.multiSelect ? 'multi' : 'single'}`));
			askUser.options.forEach((opt, idx) => {
				const isSelected = askUser.selectedIndices.includes(idx);
				const optBtn = append(optionsDiv, $('button.askuser-option' + (isSelected ? '.selected' : '')));
				this._register(addDisposableListener(optBtn, EventType.CLICK, () => {
					// Toggle selection
					const current = askUser.selectedIndices.slice();
					if (askUser.multiSelect) {
						const has = current.includes(idx);
						const next = has ? current.filter(i => i !== idx) : [...current, idx].sort((a, b) => a - b);
						askUser.selectedIndices = next;
					} else {
						askUser.selectedIndices = [idx];
					}
					// Re-render this card
					const msgEl = card.closest('.chat-message') as HTMLElement;
					if (msgEl) {
						const msgId = msgEl.dataset.msgId;
						if (msgId) {
							const msg = this._messages.find(m => m.id === msgId);
							if (msg) { this._updateMessageDom(this._messages.indexOf(msg), msg); }
						}
					}
				}));
				append(optBtn, $('span.askuser-option-marker', undefined, askUser.multiSelect ? (isSelected ? '☑' : '☐') : (isSelected ? '●' : '○')));
				const body = append(optBtn, $('span.askuser-option-body'));
				append(body, $('span.askuser-option-label', undefined, opt.label));
				if (opt.description) {
					append(body, $('span.askuser-option-description', undefined, opt.description));
				}
			});

			// Submit button
			const actions = append(card, $('.askuser-actions'));
			const canSubmit = askUser.selectedIndices.length > 0;
			const submitBtn = append(actions, $('button.askuser-submit' + (canSubmit ? '' : '.disabled'))) as HTMLButtonElement;
			submitBtn.textContent = askUser.multiSelect ? `提交选择 (${askUser.selectedIndices.length})` : '提交';
			submitBtn.disabled = !canSubmit;
			this._register(addDisposableListener(submitBtn, EventType.CLICK, () => {
				if (!canSubmit) { return; }
				const selectedLabels = askUser.selectedIndices.map(i => askUser.options[i]?.label).filter(Boolean);
				// Call onAskUserSubmit callback
				this._onAskUserSubmit?.(askUser.id, askUser.executionId, askUser.nodeId, askUser.multiSelect ? selectedLabels : selectedLabels[0] ?? '');
			}));
		}

		// Answered summary (read-only)
		if (isAnswered) {
			const answerDiv = append(card, $('.askuser-answer'));
			append(answerDiv, $('div.askuser-answer-label', undefined, '已选择:'));
			const valuesDiv = append(answerDiv, $('.askuser-answer-values'));
			const selection = Array.isArray(askUser.selection) ? askUser.selection : [askUser.selection];
			selection.forEach(s => {
				if (typeof s === 'string' && s.length > 0) {
					append(valuesDiv, $('span.askuser-answer-chip', undefined, s));
				}
			});
		}

		return card;
	}

	// --- TodoList Card ---

	private _createTodoListCard(todos: ITodoItem[]): HTMLElement {
		const card = $('.todo-list-card');
		const completedCount = todos.filter(t => t.completed).length;
		const totalCount = todos.length;

		// Header
		const header = append(card, $('.todo-header'));
		append(header, $('span.todo-icon', undefined, '☑️'));
		append(header, $('span.todo-title', undefined, '任务清单'));
		append(header, $('span.todo-progress', undefined, `${completedCount}/${totalCount}`));
		const toggle = append(header, $('span.todo-toggle'));
		// Create SVG element directly (avoid TrustedHTML issues with DOMParser)
		const todoToggleSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		todoToggleSvg.setAttribute("width", "12");
		todoToggleSvg.setAttribute("height", "12");
		todoToggleSvg.setAttribute("viewBox", "0 0 24 24");
		todoToggleSvg.setAttribute("fill", "none");
		todoToggleSvg.setAttribute("stroke", "currentColor");
		todoToggleSvg.setAttribute("stroke-width", "2.5");
		const todoTogglePolyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
		todoTogglePolyline.setAttribute("points", "6 9 12 15 18 9");
		todoToggleSvg.appendChild(todoTogglePolyline);
		toggle.appendChild(todoToggleSvg);

		// Body
		const body = append(card, $('.todo-body'));
		const list = append(body, $('.todo-list'));
		todos.forEach(todo => {
			const item = append(list, $('.todo-item' + (todo.completed ? '.completed' : '')));
			const label = append(item, $('label.todo-checkbox-label'));
			const cb = append(label, $('input.todo-checkbox')) as HTMLInputElement;
			cb.type = 'checkbox';
			cb.checked = todo.completed;
			cb.disabled = true; // read-only in chat message
			append(label, $('span.todo-label', undefined, todo.label));
			if (todo.description) {
				append(item, $('span.todo-description', undefined, todo.description));
			}
			if (todo.assignee) {
				append(item, $('span.todo-assignee', undefined, `👤 ${todo.assignee}`));
			}
		});

		return card;
	}

	// --- QuestionCarousel Card ---

	private _createQuestionCarouselCard(questions: ISuggestedQuestion[]): HTMLElement {
		const card = $('.question-carousel-card');

		// Title
		const titleDiv = append(card, $('.question-carousel-title'));
		append(titleDiv, $('span.question-carousel-icon', undefined, '💬'));
		append(titleDiv, $('span', undefined, '推荐问题'));

		// Questions list
		const list = append(card, $('.question-carousel-list'));
		questions.forEach(q => {
			const btn = append(list, $('button.question-carousel-item'));
			btn.title = q.tooltip ?? '';
			this._register(addDisposableListener(btn, EventType.CLICK, () => {
				this._onQuestionClick?.(q);
			}));
			append(btn, $('span.question-label', undefined, q.label));
			// Arrow icon
			const arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			arrowSvg.setAttribute('width', '12');
			arrowSvg.setAttribute('height', '12');
			arrowSvg.setAttribute('viewBox', '0 0 24 24');
			arrowSvg.setAttribute('fill', 'none');
			arrowSvg.setAttribute('stroke', 'currentColor');
			arrowSvg.setAttribute('stroke-width', '2');
			const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('x1', '5');
			line.setAttribute('y1', '12');
			line.setAttribute('x2', '19');
			line.setAttribute('y2', '12');
			arrowSvg.appendChild(line);
			const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
			polyline.setAttribute('points', '12 5 19 12 12 19');
			arrowSvg.appendChild(polyline);
			btn.appendChild(arrowSvg);
		});

		return card;
	}

	// --- References Card ---

	private _createReferencesCard(references: IReferenceItem[]): HTMLElement {
		const card = $('.references-card');
		const title = references.length > 1 ? `使用了 ${references.length} 个引用` : '使用了 1 个引用';

		// Header
		const header = append(card, $('.references-header'));
		append(header, $('span.references-icon', undefined, '📚'));
		append(header, $('span.references-title', undefined, title));
		const toggle = append(header, $('span.references-toggle.collapsed'));
		// Create SVG element directly (avoid TrustedHTML issues with DOMParser)
		const refToggleSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		refToggleSvg.setAttribute("width", "12");
		refToggleSvg.setAttribute("height", "12");
		refToggleSvg.setAttribute("viewBox", "0 0 24 24");
		refToggleSvg.setAttribute("fill", "none");
		refToggleSvg.setAttribute("stroke", "currentColor");
		refToggleSvg.setAttribute("stroke-width", "2.5");
		const refTogglePolyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
		refTogglePolyline.setAttribute("points", "6 9 12 15 18 9");
		refToggleSvg.appendChild(refTogglePolyline);
		toggle.appendChild(refToggleSvg);

		// List (collapsed by default)
		const list = append(card, $('.references-list'));
		list.style.display = 'none';
		references.forEach(ref => {
			const item = append(list, $(`.reference-item.${ref.state || ''}`));
			const iconMap: Record<string, string> = { file: '📄', code: '📝', url: '🔗', symbol: '🔧', text: '📋' };
			append(item, $('span.reference-icon', undefined, iconMap[ref.kind] || '📎'));
			append(item, $('span.reference-name', undefined, ref.name));
			if (ref.description) {
				append(item, $('span.reference-description', undefined, ref.description));
			}
			if (ref.state && ref.state !== 'not-modified') {
				const badgeLabel = ref.state === 'modified' ? '已修改' : ref.state === 'pending' ? '待处理' : '已排除';
				append(item, $('span.reference-state-badge', undefined, badgeLabel));
			}
			// Click to open
			this._register(addDisposableListener(item, EventType.CLICK, () => {
				this._onReferenceClick?.(ref);
			}));
		});

		// Toggle expand/collapse
		this._register(addDisposableListener(header, EventType.CLICK, () => {
			const expanded = list.style.display !== 'none';
			list.style.display = expanded ? 'none' : 'block';
			toggle.classList.toggle('collapsed');
		}));

		return card;
	}

	// --- Tip Card ---

	private _createTipCard(tip: ITipMessage): HTMLElement {
		const card = $('.tip-card');
		append(card, $('span.tip-icon', undefined, tip.icon || '💡'));
		append(card, $('span.tip-content', undefined, tip.content));

		if (tip.action) {
			const actionBtn = append(card, $('button.tip-action-btn'));
			actionBtn.textContent = tip.action.label;
			actionBtn.title = tip.action.tooltip ?? '';
			this._register(addDisposableListener(actionBtn, EventType.CLICK, () => {
				this._onTipAction?.(tip.id, tip.action!.actionId);
			}));
		}

		const dismissBtn = append(card, $('button.tip-dismiss-btn'));
		dismissBtn.textContent = '×';
		dismissBtn.title = '关闭提示';
		this._register(addDisposableListener(dismissBtn, EventType.CLICK, () => {
			this._onTipDismiss?.(tip.id);
		}));

		return card;
	}

	// --- Progress Card ---

	private _createProgressCard(progressItems: IProgressMessage[]): HTMLElement {
		const card = $('.progress-card');
		const header = append(card, $('.progress-header'));
		append(header, $('span.progress-header-icon', undefined, '⚙️'));
		append(header, $('span.progress-header-title', undefined, '执行进度'));

		const list = append(card, $('.progress-list'));
		progressItems.forEach(p => {
			const step = append(list, $(`.progress-step.${p.status}`));
			const iconMap: Record<string, string> = { spinner: '⏳', check: '✓', warning: '⚠', error: '✗' };
			append(step, $('span.progress-icon', undefined, iconMap[p.icon ?? ''] || '•'));
			append(step, $('span.progress-content', undefined, p.content));
			if (p.timestamp) {
				append(step, $('span.progress-timestamp', undefined, p.timestamp));
			}
		});

		return card;
	}

	// --- Stream error card (retryable errors with structured display) ---

	private _createStreamErrorCard(msg: IAgentChatMessage): HTMLElement {
		const card = $('.chat-error-card');
		const err = (msg.metadata?.['streamError'] as any);
		const msgText = typeof err === 'string' ? err : err?.message ?? '执行失败';
		const isRetryable = !!(err?.retryable);
		const isRateLimited = !!(err?.isRateLimited);
		const level: string = err?.level || 'error';

		const icon = append(card, $('span.chat-error-icon'));
		icon.textContent = level === 'warning' ? '⚠️' : '❌';

		const text = append(card, $('span.chat-error-text'));
		text.textContent = isRateLimited ? `速率限制: ${msgText}` : msgText;
		text.style.color = level === 'warning' ? '#fbbf24' : '#f87171';

		if (isRetryable) {
			const retryBtn = append(card, $('button.chat-error-retry-btn'));
			retryBtn.textContent = '重试';
			this._register(addDisposableListener(retryBtn, EventType.CLICK, () => {
				// Re-send the last user message before this error
				const msgIdx = this._messages.findIndex(m => m.id === msg.id);
				if (msgIdx > 0) {
					const prevMsg = this._messages[msgIdx - 1];
					if (prevMsg.role === 'user') {
						this._onSendMessage(prevMsg.content);
					}
				}
			}));
		}
		return card;
	}

	// --- Content renderers -----------------------------------

	private _renderUserContent(parent: HTMLElement, content: string): void {
		// Highlight @mentions
		const parts = content.split(/(@[\w\u4e00-\u9fff]+)/g);
		for (const part of parts) {
			if (part.startsWith("@") && part.length > 1) {
				const mention = append(parent, $("span.msg-mention"));
				mention.textContent = part;
			} else {
				append(parent, $("span")).textContent = part;
			}
		}
	}

	// --- User message edit → truncate → regenerate ------------

	/**
	 * Adds a hover-revealed "edit" button to a user message bubble.
	 * Clicking it switches the bubble into an inline edit mode.
	 */
	private _addMessageActionButtons(container: HTMLElement, msg: IAgentChatMessage): void {
		const actions = append(container, $(".chat-msg-actions"));
		const isAssistant = msg.role === 'assistant';

		if (this._onEditMessage) {
			const editBtn = append(actions, $("button.chat-msg-action-btn.chat-msg-edit-btn"));
			editBtn.title = "编辑";
			editBtn.appendChild(this._svgEditIcon());
			this._register(addDisposableListener(editBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._openUserEditOverlay(msg);
			}));
		}

		const copyBtn = append(actions, $("button.chat-msg-action-btn.chat-msg-copy-btn"));
		copyBtn.title = "复制";
		const copySvg = this._svgCopyIcon();
		copyBtn.appendChild(copySvg);
		this._register(addDisposableListener(copyBtn, EventType.CLICK, async (e) => {
			e.stopPropagation();
			const ok = await this._copyToClipboard(msg.content);
			if (ok) {
				// 替换为对号图标
				copyBtn.removeChild(copySvg);
				const checkSvg = this._svgCheckSmall();
				copyBtn.appendChild(checkSvg);
				copyBtn.classList.add("chat-msg-copy-copied");
				setTimeout(() => {
					copyBtn.classList.remove("chat-msg-copy-copied");
					copyBtn.removeChild(checkSvg);
					copyBtn.appendChild(copySvg);
				}, 1500);
			}
		}));

		if (this._onCheckpointAction) {
			const undoBtn = append(actions, $("button.chat-msg-action-btn.chat-msg-undo-btn"));
			undoBtn.title = "回撤改动";
			undoBtn.appendChild(this._svgUndoIcon());
			this._register(addDisposableListener(undoBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				// 检查是否跳过确认对话框
				try {
					if (localStorage.getItem('agentChat_skipUndoConfirm') === '1') {
						this._onCheckpointAction?.('undoAll');
						return;
					}
				} catch { /* ignore */ }
				this._openUndoConfirmDialog();
			}));
		}

		// 4. 收藏按钮 — 收藏到知识库并自动归类
		if (isAssistant && this._onFavoriteMessage && msg.content) {
			const favBtn = append(actions, $("button.chat-msg-action-btn.chat-msg-fav-btn"));
			favBtn.title = "收藏到知识库";
			favBtn.appendChild(this._svgFavoriteIcon());
			this._register(addDisposableListener(favBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onFavoriteMessage?.(msg.content);
				// 视觉反馈：星形变实心 + 短暂高亮
				const svg = favBtn.querySelector('svg');
				if (svg) { svg.setAttribute('fill', 'currentColor'); svg.style.color = 'var(--void-warn, #d4a72c)'; }
				favBtn.classList.add('chat-msg-fav-saved');
				setTimeout(() => {
					favBtn.classList.remove('chat-msg-fav-saved');
					if (svg) { svg.removeAttribute('fill'); svg.style.color = ''; }
				}, 1500);
			}));
		}
	}

	/**
	 * 打开 checkpoint 回撤确认对话框（模态浮层）。
	 * 显示检查点 ID、影响文件列表、确认/取消按钮、以及"不再提示"选项。
	 */
	private _openUndoConfirmDialog(): void {
		// 防止重复弹出
		if (this._container.querySelector('.checkpoint-undo-dialog-overlay')) { return; }
		const cp = this._checkpoint;
		if (!cp) { this._onCheckpointAction?.('undoAll'); return; }

		// ── 背景遮罩 + 居中容器 ──
		const overlay = append(this._container, $('.checkpoint-undo-dialog-overlay'));
		const dialog = append(overlay, $('.checkpoint-undo-dialog'));

		// ── 标题栏：标题 + 关闭 × ──
		const header = append(dialog, $('.checkpoint-undo-dialog-header'));
		const titleText = append(header, $('span.checkpoint-undo-title'));
		titleText.textContent = `确定回退 检查点 ${cp.id}`;
		const closeBtn = append(header, $('button.checkpoint-undo-close-btn'));
		closeBtn.title = '关闭';
		closeBtn.setAttribute('aria-label', '关闭');
		const closeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		closeSvg.setAttribute('viewBox', '0 0 24 24');
		closeSvg.setAttribute('width', '16');
		closeSvg.setAttribute('height', '16');
		closeSvg.setAttribute('fill', 'none');
		closeSvg.setAttribute('stroke', 'currentColor');
		closeSvg.setAttribute('stroke-width', '2');
		closeSvg.setAttribute('stroke-linecap', 'round');
		closeSvg.setAttribute('stroke-linejoin', 'round');
		const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		closePath.setAttribute('d', 'M18 6L6 18M6 6l12 12');
		closeSvg.appendChild(closePath);
		closeBtn.appendChild(closeSvg);

		// ── 描述文字 ──
		const desc = append(dialog, $('p.checkpoint-undo-desc'));
		const modeLabel = this._chatMode === 'craft' ? 'Craft' : this._chatMode === 'ask' ? 'Ask' : this._chatMode === 'plan' ? 'Plan' : this._chatMode;
		desc.textContent = `回退将会恢复 ${modeLabel} 操作变更过的 ${cp.fileCount} 个文件`;

		// ── 文件变更列表 ──
		const fileList = append(dialog, $('.checkpoint-undo-file-list'));
		for (const f of cp.files) {
			const fileRow = append(fileList, $('.checkpoint-undo-file-row'));
			// # 前缀图标（模拟 git diff 样式）
			const hashIcon = append(fileRow, $('span.checkpoint-file-hash'));
			hashIcon.textContent = '# ';
			// 文件名
			const fileName = append(fileRow, $('span.checkpoint-file-name'));
			// 提取短路径（只取最后一段）
			const shortName = f.path.split(/[/\\]/).pop() || f.path;
			fileName.textContent = shortName;
			// 变更统计（模拟 +N -M）
			const stats = append(fileRow, $('span.checkpoint-file-stats'));
			// 根据 status 和 path 生成模拟统计
			const added = f.status === 'created' ? Math.floor(Math.random() * 30) + 10 : Math.floor(Math.random() * 50) + 5;
			const removed = f.status === 'deleted' ? Math.floor(Math.random() * 20) + 5 : Math.floor(Math.random() * 15);
			stats.textContent = `+${added} -${removed}`;
			stats.classList.add(f.status === 'deleted' ? 'stat-deleted' : f.status === 'created' ? 'stat-added' : 'stat-modified');

			const revertLabel = append(fileRow, $('span.checkpoint-file-revert-label'));
			revertLabel.textContent = '将撤回改动';

			// 点击行可查看 diff
			fileRow.style.cursor = 'pointer';
			this._register(addDisposableListener(fileRow, EventType.CLICK, () => {
				this._onCheckpointAction?.('openDiff', { filePath: f.path });
			}));
		}

		// ── 底部操作栏：[确认] [取消]  + [×]不再提示 ──
		const footer = append(dialog, $('.checkpoint-undo-footer'));

		const btnGroup = append(footer, $('.checkpoint-undo-btn-group'));

		const confirmBtn = append(btnGroup, $('button.checkpoint-undo-btn.confirm'));
		confirmBtn.textContent = '确认';
		const cancelBtn = append(btnGroup, $('button.checkpoint-undo-btn.cancel'));
		cancelBtn.textContent = '取消';

		// "不再提示" 复选框
		const noPromptWrap = append(footer, $('label.checkpoint-no-prompt-wrap'));
		const noPromptCb = append(noPromptWrap, $('input.checkpoint-no-prompt-cb')) as HTMLInputElement;
		noPromptCb.type = 'checkbox';
		append(noPromptWrap, $('span.checkpoint-no-prompt-text')).textContent = '不再提示';

		// ── 关闭对话框辅助方法 ──
		const closeDialog = () => { overlay.remove(); };

		// ── 事件绑定 ──
		this._register(addDisposableListener(closeBtn, EventType.CLICK, closeDialog));
		this._register(addDisposableListener(overlay, EventType.CLICK, (e: Event) => {
			if (e.target === overlay) { closeDialog(); }
		}));
		this._register(addDisposableListener(cancelBtn, EventType.CLICK, closeDialog));
		this._register(addDisposableListener(confirmBtn, EventType.CLICK, () => {
			// 记住"不再提示"
			if (noPromptCb.checked) {
				try { localStorage.setItem('agentChat_skipUndoConfirm', '1'); } catch { /* ignore */ }
			}
			closeDialog();
			this._onCheckpointAction?.('undoAll');
		}));

		// ESC 关闭
		const onEsc = (e: KeyboardEvent) => {
			if (e.key === 'Escape') { closeDialog(); }
		};
		mainWindow.addEventListener('keydown', onEsc);
		this._register({ dispose: () => mainWindow.removeEventListener('keydown', onEsc) });
	}
	/**
	 * 结构复刻：chat-composer-box → textarea + toolbar（附件/语音/模式/provider/发送）。
	 */
	private _openUserEditOverlay(msg: IAgentChatMessage): void {
		const msgEl = this._messagesContainer?.querySelector(`[data-msg-id="${msg.id}"]`) as HTMLElement | null;
		if (!msgEl) { return; }
		if (msgEl.querySelector(".chat-user-edit-composer")) { return; }

		const bubble = msgEl.querySelector(".chat-bubble") as HTMLElement | null;
		if (!bubble) { return; }

		// Void-style inline edit: 气泡内容替换为 composer，消息宽度变为 100%
		const origContent = bubble.querySelector(".message-content") as HTMLElement | null;
		const origActions = bubble.querySelector(".chat-msg-actions") as HTMLElement | null;
		if (origContent) { origContent.style.display = "none"; }
		if (origActions) { origActions.style.display = "none"; }
		msgEl.classList.add('chat-message-edit-mode');

		// Composer（与底部 chat-composer-box 完全一致）
		const composer = append(bubble, $(".chat-user-edit-composer"));
		const textarea = append(composer, $("textarea.chat-user-edit-input")) as HTMLTextAreaElement;
		textarea.value = msg.content;
		textarea.placeholder = "编辑消息...";
		textarea.rows = 1;
		textarea.style.height = 'auto';
		textarea.style.height = `${Math.min(textarea.scrollHeight, 500)}px`;

		// Auto-resize — 与底部主输入框行为一致，最大高度 500px
		this._register(addDisposableListener(textarea, EventType.INPUT, () => {
			textarea.style.height = 'auto';
			textarea.style.height = `${Math.min(textarea.scrollHeight, 500)}px`;
		}));

		// Toolbar — 与底部 composer toolbar 完全一致
		const toolbar = append(composer, $(".chat-user-edit-toolbar"));
		const leftTools = append(toolbar, $("span.chat-user-edit-toolbar-left"));
		const attachBtn = this._appendEditToolbarBtn(leftTools, { title: "上传附件", svgPath: "M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" });
		this._register(addDisposableListener(attachBtn, EventType.CLICK, (e) => { e.stopPropagation(); this._fileInput?.click(); }));
		this._register(addDisposableListener(this._appendEditToolbarBtn(leftTools, { title: "语音输入", svgPath: "M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" }), EventType.CLICK, (e) => e.stopPropagation()));
		append(leftTools, $(".chat-user-edit-toolbar-divider"));
		const modeOpt = MODE_OPTIONS.find(m => m.id === this._chatMode) || MODE_OPTIONS[0];
		const modeBtn = this._appendEditToolbarBtn(leftTools, { title: '切换模式', svgPath: modeOpt.icon, hasLabel: true, label: modeOpt.label, showChevron: true, cssClass: 'mode-tag' });
		this._register(addDisposableListener(modeBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			if (this._modeDropdownEl) {
				this._closeModeDropdown();
			} else {
				this._openModeDropdown(modeBtn);
			}
		}));
		const curProvider = this._providers.find(p => p.id === this._currentProvider)?.label || this._currentProvider || 'Provider';
		const providerBtn = this._appendEditToolbarBtn(leftTools, { title: '切换 Provider', svgPath: 'M2 3h20v14H2zM8 21h8M12 17v4', hasLabel: true, label: curProvider, showChevron: true, cssClass: 'provider-tag' });
		this._register(addDisposableListener(providerBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			if (this._providerDropdownEl) {
				this._closeProviderDropdown();
			} else {
				this._openProviderDropdown(providerBtn);
			}
		}));
		const curModel = this._currentModel || 'Model';
		const modelBtn = this._appendEditToolbarBtn(leftTools, { title: '切换模型', svgPath: 'M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7M12 12v7M8 12v7M16 12v7M5 3h14l-2 4H7L5 3z', hasLabel: true, label: curModel, showChevron: true, cssClass: 'model-tag' });
		this._register(addDisposableListener(modelBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			if (this._modelDropdownEl) {
				this._closeModelDropdown();
			} else {
				this._openModelDropdown(modelBtn);
			}
		}));
		const right = append(toolbar, $('span.chat-user-edit-toolbar-right'));
		this._renderEditContextUsageRing(right);
		const sendBtn = append(right, $('button.chat-send-circle')) as HTMLButtonElement;
		sendBtn.title = '重新生成';
		const sendSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		sendSvg.setAttribute('width', '10'); sendSvg.setAttribute('height', '10');
		sendSvg.setAttribute('viewBox', '0 0 24 24'); sendSvg.setAttribute('fill', 'none');
		sendSvg.setAttribute('stroke', 'currentColor'); sendSvg.setAttribute('stroke-width', '2');
		sendSvg.setAttribute('stroke-linecap', 'round'); sendSvg.setAttribute('stroke-linejoin', 'round');
		const sendLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		sendLine.setAttribute('x1', '22'); sendLine.setAttribute('y1', '2'); sendLine.setAttribute('x2', '11'); sendLine.setAttribute('y2', '13');
		sendSvg.appendChild(sendLine);
		const sendPoly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
		sendPoly.setAttribute('points', '22 2 15 22 11 13 2 9 22 2');
		sendSvg.appendChild(sendPoly);
		sendBtn.appendChild(sendSvg);

		const hintsRow = append(composer, $(".chat-user-edit-hints-row"));
		const hints = append(hintsRow, $("span.chat-user-edit-hints"));
		const escKbd = document.createElement('kbd');
		escKbd.textContent = 'Esc';
		hints.appendChild(escKbd);
		hints.appendChild(document.createTextNode(' 取消'));

		const restore = () => {
			composer.remove();
			msgEl.classList.remove('chat-message-edit-mode');
			if (origContent) { origContent.style.display = ""; }
			if (origActions) { origActions.style.display = ""; }
		};

		// 点击 composer 外部区域时自动关闭编辑框
		const onOutsideMousedown = (e: MouseEvent) => {
			if (!composer.isConnected) { return; } // 已关闭
			const target = e.target as HTMLElement | null;
			if (!target) { return; }
			if (composer.contains(target) || (e.target as HTMLElement)?.closest?.('.chat-composer-box, .chat-input-area, .chat-send-circle, .provider-dropdown, .mode-dropdown-composer')) {
				return; // 点击在 composer 内部、底部输入区域或 mode/provider/model 下拉菜单 → 不关闭
			}
			restore();
		};
		this._register(addDisposableListener(mainWindow.document, EventType.MOUSE_DOWN, onOutsideMousedown));

		const commit = () => {
			const newText = textarea.value.trim();
			if (!newText || newText === msg.content.trim()) {
				restore();
				return;
			}
			const idx = this._messages.findIndex(m => m.id === msg.id);
			if (idx >= 0) {
				this._messages = this._messages.slice(0, idx);
				this._renderMessages();
			}
			restore();
			this._onEditMessage?.(msg.id, newText);
		};

		this._register(addDisposableListener(sendBtn, EventType.CLICK, (e) => { e.stopPropagation(); commit(); }));
		this._register(addDisposableListener(textarea, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === "Escape") { e.preventDefault(); restore(); }
			else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
		}));
		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
	}

	/** 渲染编辑 composer 中的 context usage ring（与底部输入框 CSS class 完全一致） */
	private _renderEditContextUsageRing(parent: HTMLElement): void {
		const usage = this._contextUsage;
		const pct = usage ? Math.max(0, Math.min(1, usage.ratio)) : 0;
		const warnLevel = pct > 0.8 ? 'danger' : pct > 0.6 ? 'warn' : '';
		const tooltipText = usage
			? `上下文 ${Math.round(pct * 100)}% (${usage.used} / ${usage.limit})\n输入: ${usage.used} / 上下文窗口: ${usage.limit}`
			: '上下文';
		const ringEl = append(parent, $(`.context-usage-ring${warnLevel ? '.' + warnLevel : ''}`));
		ringEl.title = tooltipText;

		const radius = 9; const stroke = 1.8;
		const size = (radius + stroke) * 2;
		const circumference = 2 * Math.PI * radius;
		const offset = circumference * (1 - pct);

		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
		svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

		const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		bg.setAttribute('cx', String(size / 2)); bg.setAttribute('cy', String(size / 2));
		bg.setAttribute('r', String(radius)); bg.setAttribute('fill', 'none');
		bg.setAttribute('class', 'ring-track');
		bg.setAttribute('stroke-width', String(stroke));
		svg.appendChild(bg);

		const fg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		fg.setAttribute('cx', String(size / 2)); fg.setAttribute('cy', String(size / 2));
		fg.setAttribute('r', String(radius)); fg.setAttribute('fill', 'none');
		fg.setAttribute('class', 'ring-progress');
		fg.setAttribute('stroke-width', String(stroke));
		fg.setAttribute('stroke-dasharray', String(circumference));
		fg.setAttribute('stroke-dashoffset', String(offset));
		fg.setAttribute('stroke-linecap', 'round');
		fg.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
		svg.appendChild(fg);
		ringEl.appendChild(svg);
	}

	/** Helper to append toolbar icon buttons for edit composer（类似 _appendToolbarBtn 简化版） */
	private _appendEditToolbarBtn(
		parent: HTMLElement,
		opt: { title: string; svgPath: string; hasLabel?: boolean; label?: string; cssClass?: string; showChevron?: boolean }
	): HTMLElement {
		const btn = append(parent, $(`button.chat-user-edit-tb-btn${opt.cssClass ? '.' + opt.cssClass : ''}${opt.showChevron ? '.has-label' : ''}`));
		btn.title = opt.title;
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', '12'); svg.setAttribute('height', '12');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', opt.svgPath);
		svg.appendChild(path);
		btn.appendChild(svg);
		if (opt.hasLabel && opt.label) {
			const lbl = append(btn, $("span.chat-user-edit-tb-label"));
			lbl.textContent = opt.label;
		}
		if (opt.showChevron) {
			const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			chevron.setAttribute('width', '10'); chevron.setAttribute('height', '10');
			chevron.setAttribute('viewBox', '0 0 24 24'); chevron.setAttribute('fill', 'none');
			chevron.setAttribute('stroke', 'currentColor'); chevron.setAttribute('stroke-width', '2.5');
			const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			chevronPath.setAttribute('d', 'M6 9l6 6 6-6');
			chevron.appendChild(chevronPath);
			btn.appendChild(chevron);
		}
		return btn;
	}

	private _svgEditIcon(): SVGElement {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
		const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		p1.setAttribute('d', 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7');
		svg.appendChild(p1);
		const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		p2.setAttribute('d', 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z');
		svg.appendChild(p2);
		return svg;
	}

	private _svgCopyIcon(): SVGElement {
		if (!AgentChatPanel._svgCopyTpl) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
			svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
			svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
			const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
			rect.setAttribute('x', '9'); rect.setAttribute('y', '9'); rect.setAttribute('width', '13'); rect.setAttribute('height', '13'); rect.setAttribute('rx', '2'); rect.setAttribute('ry', '2');
			svg.appendChild(rect);
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
			svg.appendChild(path);
			AgentChatPanel._svgCopyTpl = svg;
		}
		return AgentChatPanel._svgCopyTpl.cloneNode(true) as SVGElement;
	}

	private _svgUndoIcon(): SVGElement {
		if (!AgentChatPanel._svgUndoTpl) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
			svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
			svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
			const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
			poly.setAttribute('points', '1 4 1 10 7 10');
			svg.appendChild(poly);
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', 'M3.51 15a9 9 0 1 0 2.13-9.36L1 10');
			svg.appendChild(path);
			AgentChatPanel._svgUndoTpl = svg;
		}
		return AgentChatPanel._svgUndoTpl.cloneNode(true) as SVGElement;
	}

	/** 收藏按钮图标（星形）*/
	private _svgFavoriteIcon(): SVGElement {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
		const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
		polygon.setAttribute('points', '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2');
		svg.appendChild(polygon);
		return svg;
	}

	/** 终端/控制台 logo（`>_` 提示符风格） */
	private _svgTerminalLogo(parent: HTMLElement, className: string): SVGElement {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', className);
		svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
		// 终端屏幕外框
		const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		rect.setAttribute('x', '2'); rect.setAttribute('y', '4');
		rect.setAttribute('width', '20'); rect.setAttribute('height', '16');
		rect.setAttribute('rx', '2');
		svg.appendChild(rect);
		// `>` 提示符
		const poly1 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		poly1.setAttribute('points', '6 9 10 12 6 15');
		svg.appendChild(poly1);
		// 下划线（光标）
		const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		line.setAttribute('x1', '12'); line.setAttribute('y1', '15');
		line.setAttribute('x2', '17'); line.setAttribute('y2', '15');
		svg.appendChild(line);
		parent.appendChild(svg);
		return svg;
	}

	/** 独立终端打开按钮图标（绿色方框 + 箭头，Run in Terminal 风格） */
	private _svgTerminalOpenIcon(parent: HTMLElement, className: string): void {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', className);
		svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
		// 终端方框
		const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		rect.setAttribute('x', '2'); rect.setAttribute('y', '4');
		rect.setAttribute('width', '20'); rect.setAttribute('height', '16');
		rect.setAttribute('rx', '2');
		svg.appendChild(rect);
		// 顶部装饰线
		const top = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		top.setAttribute('d', 'M2 8h20');
		svg.appendChild(top);
		// 播放箭头
		const play = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
		play.setAttribute('points', '9.5 12 14 14 9.5 16');
		play.setAttribute('fill', 'currentColor');
		play.setAttribute('stroke', 'none');
		svg.appendChild(play);
		parent.appendChild(svg);
	}

	/**
	 * 导入知识库按钮图标（书本 + 加号，Lucide book-plus 风格）。
	 * 与现有按钮图标风格一致（24×24、stroke-width=2、round 端点）。
	 */
	private _svgImportKbIcon(): SVGElement {
		if (!AgentChatPanel._svgImportKbTpl) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
			svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
			svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
			// 书脊（左侧）：闭合矩形 + 顶部折痕
			const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path1.setAttribute('d', 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20');
			svg.appendChild(path1);
			const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path2.setAttribute('d', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z');
			svg.appendChild(path2);
			// 中央 + 号（添加到知识库）
			const lineV = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			lineV.setAttribute('x1', '12'); lineV.setAttribute('y1', '8'); lineV.setAttribute('x2', '12'); lineV.setAttribute('y2', '14');
			svg.appendChild(lineV);
			const lineH = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			lineH.setAttribute('x1', '9'); lineH.setAttribute('y1', '11'); lineH.setAttribute('x2', '15'); lineH.setAttribute('y2', '11');
			svg.appendChild(lineH);
			AgentChatPanel._svgImportKbTpl = svg;
		}
		return AgentChatPanel._svgImportKbTpl.cloneNode(true) as SVGElement;
	}

	/**
	 * Copy text to clipboard with fallback for Electron workbench contexts
	 * where navigator.clipboard.writeText may be unavailable or fail.
	 */
	private async _copyToClipboard(text: string): Promise<boolean> {
		// Try modern Clipboard API first
		if (navigator.clipboard?.writeText) {
			try {
				await navigator.clipboard.writeText(text);
				return true;
			} catch { /* fall through to legacy method */ }
		}
		// Fallback: temporary textarea + execCommand('copy')
		try {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.left = '-9999px';
			ta.style.top = '0';
			document.body.appendChild(ta);
			ta.focus();
			ta.select();
			const ok = document.execCommand('copy');
			document.body.removeChild(ta);
			return ok;
		} catch {
			return false;
		}
	}

	/** Small check SVG for copy button feedback */
	private _svgCheckSmall(): SVGElement {
		if (!AgentChatPanel._svgCheckTpl) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
			svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
			svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
			const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
			poly.setAttribute('points', '20 6 9 17 4 12');
			svg.appendChild(poly);
			AgentChatPanel._svgCheckTpl = svg;
		}
		return AgentChatPanel._svgCheckTpl.cloneNode(true) as SVGElement;
	}





	/**
	 * Dispose all markdown render disposables associated with elements inside
	 * the given root element. Called before rebuilding a message DOM to prevent
	 * renderMarkdown disposable leaks (event listeners, etc.).
	 */
	private _cleanupMarkdownDisposables(root: HTMLElement): void {
		const toRemove: HTMLElement[] = [];
		for (const [el, disposable] of this._markdownDisposables) {
			if (root.contains(el)) {
				disposable.dispose();
				toRemove.push(el);
			}
		}
		for (const el of toRemove) {
			this._markdownDisposables.delete(el);
		}
	}

	private _renderMarkdownContent(parent: HTMLElement, content: string, isStreaming: boolean = false): void {
		// 预处理：嵌套 markdown 代码块围栏冲突（移植自 Continue patchNestedMarkdown）。
		// 模型返回 ```markdown 代码块内含 ``` 时，VS Code renderMarkdown 的围栏解析
		// 会错位 → 内层代码块泄漏为正文。把外层 ```markdown``` 的围栏转成 ~~~ 避免冲突。
		const processed = _patchNestedMarkdown(content);
		const md: IMarkdownString = { value: processed, isTrusted: true };
		const options = this._getMarkdownOptions(isStreaming);

		// Dispose previous markdown disposable for this parent to avoid leakage
		const existingDisposable = this._markdownDisposables.get(parent);
		if (existingDisposable) {
			existingDisposable.dispose();
		}

		// renderMarkdown returns a disposable that must be managed
		const disposable = renderMarkdown(md, options, parent);
		this._markdownDisposables.set(parent, disposable);

		// Intercept clicks on http(s) links so they open in the editor area
		// (middle column) instead of the system browser. Event delegation on
		// the parent element covers all <a> tags rendered by renderMarkdown,
		// including those added during streaming updates.
		this._attachLinkInterceptor(parent);
		this._linkifyPlainText(parent);
	}

	/**
	 * 扫描文本节点中的文件路径和网址，转为可点击的超链接。
	 * 已位于 <a>/<pre>/<code>/script/style 内的文本节点跳过。
	 */
	private static readonly _FILE_PATH_RE
		= /(?<![\/\w.\-])(?:(?:\.{0,2}\/)?[\w.\-]+(?:\/[\w.\-]+)*\/[\w.\-]+?\.(?:tsx?|jsx?|mjs|cjs|py[3w]?|rb|php|go|rs|java|kt|swift|scala|cs|cpp|cxx|h|hpp|vue|svelte|astro|prisma|md|mdx|css|scss|less|html?|json|ya?ml|toml|xml|svg|png|jpe?g|gif|webp|bmp|ico|sh|bash|zsh|fish|ps1|bat|cmd|sql|graphql|env|config|ini|cfg|lock|txt|log|tf|tfvars|proto|sqlx|dart|lua|r|jl|nim|zig))(?:[#:]\d+)?(?<![\/\w.\-])/g;
	private static readonly _URL_RE
		= /(?<!["'>=])(https?:\/\/[^\s<>"'，。；：！？、]+)/g;

	private _linkifyPlainText(parent: HTMLElement): void {
		const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT, {
			acceptNode: (node: Text) => {
				// 跳过已位于链接/代码块/预格式化/脚本/样式/页脚内的文本
				let el: HTMLElement | null = node.parentElement;
				while (el && el !== parent) {
					const tag = el.tagName;
					if (tag === 'A' || tag === 'PRE' || tag === 'CODE' || tag === 'SCRIPT' || tag === 'STYLE') {
						return NodeFilter.FILTER_REJECT;
					}
					if (el.classList.contains('tool-code-children')
						|| el.classList.contains('tool-children-wrapper')
						|| el.classList.contains('chat-bubble-footer')) {
						return NodeFilter.FILTER_REJECT;
					}
					el = el.parentElement;
				}
				return NodeFilter.FILTER_ACCEPT;
			},
		});

		let node: Text | null;
		const nodesToReplace: Array<{ node: Text; parts: Array<string | { type: 'file' | 'url'; text: string }> }> = [];
		while ((node = walker.nextNode() as Text | null)) {
			const text = node.textContent ?? '';
			if (text.length < 3) { continue; }
			const combined = this._parseLinkifyText(text);
			if (combined) {
				nodesToReplace.push({ node, parts: combined });
			}
		}

		for (const { node, parts } of nodesToReplace) {
			const frag = document.createDocumentFragment();
			for (const part of parts) {
				if (typeof part === 'string') {
					frag.appendChild(document.createTextNode(part));
				} else if (part.type === 'file') {
					const a = document.createElement('a');
					a.setAttribute('data-file', part.text);
					a.textContent = part.text;
					a.className = 'msg-file-link';
					// 阻止默认导航行为（由 _attachLinkInterceptor 处理）
					a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
					frag.appendChild(a);
				} else {
					const a = document.createElement('a');
					a.href = part.text;
					a.textContent = part.text;
					a.target = '_blank';
					a.rel = 'noopener noreferrer';
					a.className = 'msg-url-link';
					frag.appendChild(a);
				}
			}
			node.parentNode?.replaceChild(frag, node);
		}
	}

	/** 将文本拆分为纯文本 + 文件路径 + 网址的混合数组 */
	private _parseLinkifyText(text: string): Array<string | { type: 'file' | 'url'; text: string }> | null {
		// 找到所有匹配的文件路径和网址位置
		const matches: Array<{ index: number; length: number; type: 'file' | 'url'; text: string }> = [];

		// 文件路径
		AgentChatPanel._FILE_PATH_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = AgentChatPanel._FILE_PATH_RE.exec(text)) !== null) {
			matches.push({ index: m.index, length: m[0].length, type: 'file', text: m[0] });
		}
		// 网址（排除已被文件路径匹配覆盖的区域）
		AgentChatPanel._URL_RE.lastIndex = 0;
		while ((m = AgentChatPanel._URL_RE.exec(text)) !== null) {
			const urlStart = m.index, urlEnd = m.index + m[0].length;
			const overlaps = matches.some(fm => fm.index < urlEnd && (fm.index + fm.length) > urlStart);
			if (!overlaps) {
				matches.push({ index: m.index, length: m[0].length, type: 'url', text: m[0] });
			}
		}

		if (matches.length === 0) { return null; }

		// 按位置排序，构建分段数组
		matches.sort((a, b) => a.index - b.index);
		const result: Array<string | { type: 'file' | 'url'; text: string }> = [];
		let cursor = 0;
		for (const match of matches) {
			if (match.index > cursor) {
				result.push(text.slice(cursor, match.index));
			}
			result.push({ type: match.type, text: match.text });
			cursor = match.index + match.length;
		}
		if (cursor < text.length) {
			result.push(text.slice(cursor));
		}
		return result;
	}

	/**
	 * P0: 增量 Markdown 渲染——如果新内容只是旧内容的追加，且边界安全
	 * （不在代码块内、在块边界处），只渲染追加部分，避免全量 re-parse。
	 * 参考 VS Code ChatMarkdownContentPart.tryIncrementalUpdate。
	 * 返回 true 表示增量更新成功，false 表示需要全量重建。
	 */
	private _tryIncrementalMarkdownRender(container: HTMLElement, newContent: string): boolean {
		const oldContent = this._streamingMdLastRendered;

		// 无上次渲染 → 无法增量
		if (!oldContent) { return false; }

		// 新内容必须以旧内容为前缀（追加模式）
		if (!newContent.startsWith(oldContent)) { return false; }

		const appended = newContent.slice(oldContent.length);
		if (!appended) { return true; } // 无变化

		// 大内容强制全量重建：增量渲染会在表格/代码块/嵌套列表边界产生碎片 DOM，
		// 导致复杂 markdown（如模型返回的设计方案文档含表格+代码+CSS）显示混乱。
		// 小内容（<4KB）保留增量以降低流式渲染开销。全量重建已按 200ms 节流，性能可接受。
		if (newContent.length > 4096) { return false; }

		// 安全检查：旧内容不能结束在代码块中间（``` 标记数为奇数）
		const fenceCount = (oldContent.match(/```/g) || []).length;
		if (fenceCount % 2 !== 0) { return false; }

		// 安全检查：旧内容必须在块边界处结束（以 \n 结尾或为空）
		// 不在行中间切断，否则追加的文本会与旧文本合并不完整的 markdown 块
		if (!oldContent.endsWith('\n') && oldContent.length > 0) { return false; }

		// 安全：只渲染追加部分——renderMarkdown 会 append 到 container，保留已有 DOM
		const md: IMarkdownString = { value: appended, isTrusted: true };
		const options = this._getMarkdownOptions();
		const newDisposable = renderMarkdown(md, options, container);

		// 组合新旧 disposable——全量重建时一起 dispose
		const existing = this._markdownDisposables.get(container);
		this._markdownDisposables.set(container, {
			dispose: () => {
				try { newDisposable.dispose(); } catch { /* already disposed */ }
				try { existing?.dispose(); } catch { /* already disposed */ }
			},
		});
		this._attachLinkInterceptor(container);
		this._linkifyPlainText(container);
		this._streamingMdLastRendered = newContent;
		return true;
	}

	/**
	 * 提取 markdown 渲染选项（codeBlockRenderer 等），供 _renderMarkdownContent
	 * 和 _tryIncrementalMarkdownRender 共享。P0 重构。
	 */
	private _getMarkdownOptions(isStreaming: boolean = false): MarkdownRenderOptions {
		const LARGE_CODE_THRESHOLD = 30; // lines before auto-collapse

		return {
			// 流式时自动补全未闭合的 ``` 围栏 / 表格 / 列表（对齐 Void/VS Code 原生 chat
			// 的 fillIncompleteTokens 机制）。这是防止流式错乱的根因修复——之前流式
			// 过程中未闭合的代码块会以 raw text 形式泄漏到正文，表现为 CSS/HTML 裸露。
			fillInIncompleteTokens: isStreaming,
			// 显式开启 GFM：表格 / 任务列表 / 删除线 / 自动链接。marked 实例的默认值
			// 在某些版本下 gfm=false，导致 | col1 | col2 | 表格语法以 raw text 渲染。
			markedOptions: { gfm: true, breaks: false },
			// ⚠️ 关键修复（流式代码块显示为裸露 HTML/CSS 文本，输出结束后才正常，2026-07-13）：
			//   必须用 codeBlockRendererSync（同步）而非 codeBlockRenderer（异步 Promise）。
			//   原因：异步 codeBlockRenderer 下，renderMarkdown 会先同步插入占位符
			//   `<div class="code" data-code="N">${escape(code)}</div>`（内容是转义后的原始
			//   代码文本），再在 `Promise.all(codeBlocks).then()`（微任务）里用
			//   `outElement.querySelectorAll('div[data-code]')` 替换为真正的代码块。
			//   但流式全量重建走「离屏 tempDiv 渲染 → replaceChildren 把子节点移动到真实
			//   容器」的模式（见 _streamingMdTimer 回调），replaceChildren 同步把节点搬出
			//   tempDiv 后，微任务里的 querySelectorAll 在**已清空的 tempDiv** 上找不到占位符
			//   → 永不替换 → 占位符里转义的裸露 HTML/CSS 文本一直留在可见容器（即错乱）。
			//   流式结束时 _rebuildMessageElement 直接渲染进真实容器，故「结束后正常」。
			//   改用同步渲染后，renderMarkdown 在返回前就完成占位符替换（markdownRenderer.ts
			//   L343-351），移动子节点时代码块已就位，彻底消除该竞态。本渲染器体内无真正
			//   异步操作，转同步零副作用。
			codeBlockRendererSync: (languageAlias: string, code: string) => {
				const lang = languageAlias || '';
				const lines = code.split('\n');
				const isLarge = lines.length > LARGE_CODE_THRESHOLD;

				// Wrapper
				const wrapper = document.createElement('div');
				wrapper.className = `code-block-wrapper${isLarge ? ' code-block-collapsed' : ''}`;

				// Header bar
				const header = document.createElement('div');
				header.className = 'code-block-header';

				const langLabel = document.createElement('span');
				langLabel.className = 'code-block-lang';
				langLabel.textContent = lang || 'code';
				header.appendChild(langLabel);

				const actions = document.createElement('span');
				actions.className = 'code-block-actions';

				// Copy button
				const copyBtn = document.createElement('button');
				copyBtn.className = 'code-block-copy-btn';
				copyBtn.title = 'Copy code';
				// P2+: 复用缓存 SVG 模板（cloneNode），只改尺寸为 12x12
				const copySvg = this._svgCopyIcon();
				copySvg.setAttribute('width', '12');
				copySvg.setAttribute('height', '12');
				copyBtn.appendChild(copySvg);
				copyBtn.addEventListener('click', async (e) => {
					e.stopPropagation();
					const ok = await this._copyToClipboard(code);
					copyBtn.textContent = '';
					if (ok) {
						// 成功：复用缓存 check SVG 模板
						const copiedSvg = this._svgCheckSmall();
						copiedSvg.setAttribute('width', '12');
						copiedSvg.setAttribute('height', '12');
						copyBtn.appendChild(copiedSvg);
						copyBtn.classList.add('copied');
						copyBtn.title = 'Copied';
					} else {
						// 失败：显示错误状态
						copyBtn.classList.add('copy-failed');
						copyBtn.title = 'Copy failed';
					}
					setTimeout(() => {
						copyBtn.textContent = '';
						const copySvg2 = this._svgCopyIcon();
						copySvg2.setAttribute('width', '12');
						copySvg2.setAttribute('height', '12');
						copyBtn.appendChild(copySvg2);
						copyBtn.classList.remove('copied');
						copyBtn.classList.remove('copy-failed');
						copyBtn.title = 'Copy code';
					}, 1500);
				});
				actions.appendChild(copyBtn);

				// Apply button (Void-inspired BlockCodeApplyWrapper)
				const applyBtn = document.createElement('button');
				applyBtn.className = 'code-block-apply-btn';
				applyBtn.title = 'Diff 预览并应用代码到文件';
				applyBtn.textContent = 'Apply';
			applyBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				console.log(`[AgentChatPanel] Apply button clicked — lang="${lang}", codeLen=${code.length}, hasOnApplyCode=${!!this._onApplyCode}`);
				this._onApplyCode?.(code, lang);
			});
				actions.appendChild(applyBtn);

				// P1-1: 终端运行按钮（仅 shell 语言代码块显示）
				const shellLangs = ['bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'ps1', 'cmd', 'bat'];
				if (shellLangs.includes(lang.toLowerCase()) && this._onRunInTerminal) {
					const runBtn = document.createElement('button');
					runBtn.className = 'code-block-run-btn';
					runBtn.title = '在终端中运行';
					runBtn.textContent = '▶ Run';
					runBtn.addEventListener('click', (e) => {
						e.stopPropagation();
						this._onRunInTerminal?.(code);
						// 视觉反馈
						runBtn.textContent = '✓ 已发送';
						runBtn.classList.add('ran');
						setTimeout(() => {
							runBtn.textContent = '▶ Run';
							runBtn.classList.remove('ran');
						}, 1500);
					});
					actions.appendChild(runBtn);
				}

				// Expand/collapse button for large blocks
				if (isLarge) {
					const toggleBtn = document.createElement('button');
					toggleBtn.className = 'code-block-toggle-btn';
					toggleBtn.textContent = `+ Expand (${lines.length} lines)`;
					toggleBtn.addEventListener('click', (e) => {
						e.stopPropagation();
						const collapsed = wrapper.classList.toggle('code-block-collapsed');
						toggleBtn.textContent = collapsed
							? `+ Expand (${lines.length} lines)`
							: `- Collapse`;
					});
					actions.appendChild(toggleBtn);
				}

				header.appendChild(actions);
				wrapper.appendChild(header);

				// Code block
				const pre = document.createElement('pre');
				const codeEl = document.createElement('code');
				if (lang) { codeEl.classList.add(`language-${lang}`); }
				codeEl.textContent = code;
				pre.appendChild(codeEl);
				wrapper.appendChild(pre);

				return wrapper;
			},
		};
	}

	/**
	 * Attach a click interceptor on `parent` that catches clicks on `<a>` tags.
	 * - http/https links → route to `onOpenLink` (opens in browser/webview)
	 * - `data-file` links → route to `onOpenFile` (opens in editor area)
	 * Non-http links without data-file (e.g. `command:`, `file:`) are left alone.
	 */
	private _attachLinkInterceptor(parent: HTMLElement): void {
		const handler = (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) { return; }
			const anchor = target.closest('a') as HTMLAnchorElement | null;
			if (!anchor) { return; }
			// 文件路径链接
			const filePath = anchor.getAttribute('data-file');
			if (filePath) {
				e.preventDefault();
				e.stopPropagation();
				this._onOpenFile?.(filePath);
				return;
			}
			const href = anchor.getAttribute('data-href') || anchor.href;
			if (!href) { return; }
			// Only intercept http(s) links.
			if (!/^https?:\/\//i.test(href)) { return; }
			e.preventDefault();
			e.stopPropagation();
			this._onOpenLink?.(href);
		};
		parent.addEventListener('click', handler);
		// Track the listener for disposal when the parent is cleaned up.
		const existingDisposable = this._markdownDisposables.get(parent);
		if (existingDisposable) {
			this._markdownDisposables.set(parent, {
				dispose: () => {
					parent.removeEventListener('click', handler);
					existingDisposable.dispose();
				},
			});
		}
	}

	// --- Ordered parts renderer (阶段E：按 parts 数组顺序遍历，取代 textPosition 交织) ---

	private _renderPartsContent(bubble: HTMLElement, parts: readonly IMessagePart[], isStreaming: boolean): void {
		// 找到最后一个非空文本片段索引，流式时把它标记为 streaming-container（增量更新目标）。
		let lastTextIdx = -1;
		for (let k = 0; k < parts.length; k++) {
			const p = parts[k];
			if (p.kind === 'text' && p.text.trim().length > 0) { lastTextIdx = k; }
		}
		// 2026-07-04: update_plan 是"替换语义"——多张卡片只保留最后一张
		let lastUpdatePlanIndex = -1;
		for (let k = 0; k < parts.length; k++) {
			const p = parts[k] as any;
			if (p.kind === 'tool' && p.tool?.name === 'update_plan') {
				lastUpdatePlanIndex = k;
			}
		}
		for (let k = 0; k < parts.length; k++) {
			const part = parts[k];
			if (part.kind === 'text') {
				if (part.text.trim().length === 0) { continue; }
				const segEl = append(bubble, $(".message-content.parts-text-segment"));
				if (isStreaming && k === lastTextIdx) {
					segEl.classList.add('streaming-container');
				}
				this._renderMarkdownContent(segEl, part.text, isStreaming);
			} else {
				// 跳过非最后的 update_plan 卡片（替换语义）
				const toolPart = (part as any).tool;
				if (toolPart?.name === 'update_plan' && k !== lastUpdatePlanIndex) { continue; }
				bubble.appendChild(this._createToolCallCard(toolPart));
			}
		}
	}

	// Input area

	private _renderInputArea(): void {
		const emp = this._agent!;

		// Resize handle — drag to adjust composer height (placed above input area)
		// 已存在则跳过（_refreshInputArea 重复调用时不重建）
		let resizeHandle = this._container.querySelector('.composer-resize-handle') as HTMLElement | null;
		if (!resizeHandle) {
			resizeHandle = append(this._container, $(".composer-resize-handle"));
		}
		this._register(addDisposableListener(resizeHandle, EventType.MOUSE_DOWN, (downEv: MouseEvent) => {
			downEv.preventDefault();
			const startY = downEv.clientY;
			const startH = this._textarea?.offsetHeight ?? this._resizeMaxH;
			const onMove = (moveEv: MouseEvent) => {
				const newH = Math.max(60, Math.min(800, startH + (startY - moveEv.clientY)));
				this._resizeMaxH = newH;
				this._userHasAdjustedHeight = true; // 标记用户已调整过高度
				if (this._textarea) { this._textarea.style.height = `${newH}px`; }
				// 保存用户调整的高度到 localStorage
				try {
					localStorage.setItem('agentChatComposerHeight', newH.toString());
				} catch {
					// localStorage 不可用时忽略
				}
			};
			const onUp = () => {
				document.removeEventListener('mousemove', onMove);
				document.removeEventListener('mouseup', onUp);
			};
			document.addEventListener('mousemove', onMove);
			document.addEventListener('mouseup', onUp);
		}));


		// ── Tabbed panel（替代 system bar + queue bar）──
		this._tabbedPanel.createDom();

		const inputArea = append(this._container, $(".chat-input-area"));
		this._inputAreaEl = inputArea;

		// Composer box
		const composerBox = append(inputArea, $(".chat-composer-box"));

		// Skill chips bar (inserted before textarea)
		// Note: visibility is controlled by _renderSkillChips() -> line 3103
		this._skillChipsBar = append(composerBox, $(".skill-chips-bar")) as HTMLElement;
		// Initialize skill chips bar visibility
		this._renderSkillChips();

		// ContentEditable div（替代 textarea，支持文本+内联附件芯片混排）
		this._textarea = append(
			composerBox,
			$("div.chat-composer-textarea"),
		) as HTMLElement;
		this._textarea.setAttribute('contenteditable', 'true');
		this._textarea.setAttribute('tabindex', '0');
		this._textarea.setAttribute('data-placeholder', `Message ${emp.name}...`);
		this._textarea.setAttribute('role', 'textbox');
		this._textarea.setAttribute('aria-multiline', 'true');
		this._textarea.setAttribute('aria-label', `Message ${emp.name}...`);
		// 流式输出过程中不再禁用输入框——用户可继续输入新消息排队
		// this._textarea.disabled = this._isSending;  ← 已移除

		// 防御修复：流式期间 DOM 更新可能破坏 contentEditable 状态。
		// 每次用户点击/mousedown 显式确保 contentEditable=true + tabIndex=0。
		this._register(addDisposableListener(this._textarea, EventType.MOUSE_DOWN, () => {
			if (this._textarea.getAttribute('contenteditable') !== 'true') {
				this._textarea.setAttribute('contenteditable', 'true');
			}
			if (!this._textarea.hasAttribute('tabindex')) {
				this._textarea.setAttribute('tabindex', '0');
			}
		}));

		// 恢复保存的输入框高度
		try {
			const savedHeight = localStorage.getItem('agentChatComposerHeight');
			if (savedHeight) {
				const height = parseInt(savedHeight, 10);
				if (!isNaN(height) && height >= 60 && height <= 800) {
					this._resizeMaxH = height;
					this._userHasAdjustedHeight = true;
					this._textarea.style.height = `${height}px`;
				}
			}
		} catch {
			// localStorage 不可用时忽略
		}

		// Auto-resize + slash command detection + slash menu + mention
		this._register(
			addDisposableListener(this._textarea, EventType.INPUT, () => {
				const t = this._textarea;
				// 保存消息区滚动位置：输入框高度变化会挤压 flex 布局的消息区，
				// 浏览器自动调整 scrollTop 导致滚动条跳动。保存后恢复即可避免。
				const savedScrollTop = this._messagesContainer?.scrollTop ?? 0;
				t.style.height = "auto";
				const maxAllowed = 320;
				const newHeight = this._userHasAdjustedHeight
					? Math.min(Math.max(t.scrollHeight, this._resizeMaxH), maxAllowed)
					: Math.min(t.scrollHeight, this._resizeMaxH);
				t.style.height = newHeight + "px";
				if (this._messagesContainer && this._messagesContainer.scrollTop !== savedScrollTop) {
					this._messagesContainer.scrollTop = savedScrollTop;
				}

				// 获取纯文本（排除内联附件芯片内容）
				const val = this._getComposerText();

				// Detect /skill /command patterns — show slash menu
				const slashMatch = val.match(/^\/(\w*)$/);
				if (slashMatch) {
					t.style.color = 'var(--ec-accent, #60a5fa)';
					t.setAttribute('data-slash-command', slashMatch[1]);
					const filter = slashMatch[1];
					if (this._slashMenuEl) {
						this._renderSlashMenuItems(filter);
					} else {
						this._openSlashMenu(filter);
					}
				} else {
					t.style.color = '';
					t.removeAttribute('data-slash-command');
					this._closeSlashMenu();
				}

				// P0-2: @mention 文件搜索检测
				const cursorPos = this._getCaretOffset();
				const beforeCursor = val.slice(0, cursorPos);
				const atMatch = beforeCursor.match(/@(\w[^\s]*)$/);
				if (atMatch && this._onSearchFiles) {
					const query = atMatch[1];
					if (query !== this._mentionQuery) {
						this._mentionQuery = query;
						this._scheduleMentionSearch(query);
					}
				} else {
					this._closeMentionMenu();
				}

				// 更新字符计数器
				this._updateCharCounter(val);
			}),
		);


		// Hidden file input (for attach button + paste)
		this._fileInput = append(this._container, $("input.chat-file-input")) as HTMLInputElement;
		this._fileInput.type = "file";
		this._fileInput.multiple = true;
		this._fileInput.accept = "image/*,.txt,.md,.json,.js,.ts,.py,.go,.rs,.java,.cs,.html,.css";
		this._fileInput.style.display = "none";
		this._fileInput.addEventListener("change", () => this._handleFileSelection());

		// Drag & drop — 全聊天区域拖放（文件 + 代码选择）
		// 参考 Void SidebarChat 的拖放支持，扩展为整个聊天面板
		// 已存在则跳过（_refreshInputArea 重复调用时不重建 overlay 和事件监听器）
		if (this._container.querySelector('.chat-drag-overlay')) {
			// overlay 已存在，跳过创建
		} else {
		const dragOverlay = append(this._container, $('.chat-drag-overlay'));
		dragOverlay.style.display = 'none';
		let dragCounter = 0;
		this._register(addDisposableListener(this._container, 'dragenter', (e: DragEvent) => {
			e.preventDefault();
			dragCounter++;
			dragOverlay.style.display = 'flex';
		}));
		this._register(addDisposableListener(this._container, 'dragover', (e: DragEvent) => {
			e.preventDefault();
			if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
		}));
		this._register(addDisposableListener(this._container, 'dragleave', () => {
			dragCounter--;
			if (dragCounter <= 0) { dragCounter = 0; dragOverlay.style.display = 'none'; }
		}));
		this._register(addDisposableListener(this._container, 'drop', (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			dragCounter = 0;
			dragOverlay.style.display = 'none';
			const dt = e.dataTransfer;
			if (!dt) { return; }
			// 1. OS 文件拖放
			if (dt.files && dt.files.length > 0) {
				this._addFiles(Array.from(dt.files));
				return;
			}
			// 2. 代码/文本拖放（从编辑器选中代码拖入）
			const text = dt.getData('text/plain');
			if (text && text.trim().length > 0) {
				const att: IChatAttachment = {
					id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					type: 'file',
					name: `code-snippet.txt`,
					mimeType: 'text/plain',
					data: text,
					size: text.length,
					isPasted: false,
				};
				this._attachments.push(att);
				this._renderAttachmentPreviews();
				this._insertInlineAttachmentChip(att);
			}
		}));
		} // end else (drag overlay 已存在则跳过)

		// Paste handling — 文本走「格式化粘贴」（去除样式），图片/文件保持 chip 显示
		this._register(addDisposableListener(this._textarea, EventType.PASTE, (e) => {
			const clipboardData = (e as ClipboardEvent).clipboardData;
			if (!clipboardData) { return; }

			// 有图片/文件 → 保持本地图片/文件 chip 显示（原逻辑），不做格式化、不受影响
			if (clipboardData.files?.length) {
				const imageFiles = Array.from(clipboardData.files).filter(f => f.type.startsWith("image/"));
				if (imageFiles.length > 0) {
					e.preventDefault();
					this._addFiles(imageFiles, true);
				}
				return;
			}

			// 纯文本 / 富文本 → 格式化粘贴：剥离样式，只插入纯文本（不展示样式）。
			// 图片/文件 chip 由上面分支处理，本分支不会影响其显示。
			e.preventDefault();
			let plain = clipboardData.getData('text/plain');
			if (!plain) {
				const html = clipboardData.getData('text/html');
				if (html) { plain = html.replace(/<[^>]+>/g, ''); }
			}
			if (plain) {
				this._insertTextAtCaret(plain);
			}
		}));

		// Attachment preview area — 已移至内联芯片模式（附件直接嵌入 contentEditable 文本流中）
		// 旧 .chat-attachment-bar 不再需要，保留 class 选择器兼容旧逻辑

		// Enter to send / slash menu navigation
		this._register(
			addDisposableListener(
				this._textarea,
				EventType.KEY_DOWN,
				(e: KeyboardEvent) => {
					// Slash menu open: handle navigation keys
					if (this._slashMenuEl) {
						if (e.key === 'ArrowDown') {
							e.preventDefault();
							this._slashMenuIndex++;
							this._highlightSlashMenuItem();
							return;
						}
						if (e.key === 'ArrowUp') {
							e.preventDefault();
							this._slashMenuIndex = Math.max(0, this._slashMenuIndex - 1);
							this._highlightSlashMenuItem();
							return;
						}
						if (e.key === 'Enter') {
							e.preventDefault();
							this._selectSlashMenuItem();
							return;
						}
					}
					// P0-2: @mention menu navigation
					if (this._mentionEl) {
						if (e.key === 'ArrowDown') {
							e.preventDefault();
							this._mentionIndex = Math.min(this._mentionResults.length - 1, this._mentionIndex + 1);
							this._highlightMentionItem();
							return;
						}
						if (e.key === 'ArrowUp') {
							e.preventDefault();
							this._mentionIndex = Math.max(0, this._mentionIndex - 1);
							this._highlightMentionItem();
							return;
						}
						if (e.key === 'Enter') {
							e.preventDefault();
							this._selectMentionItem();
							return;
						}
					}
					if (e.key === 'Escape') {
						e.preventDefault();
						if (this._slashMenuEl) {
							this._closeSlashMenu();
						} else if (this._mentionEl) {
							this._closeMentionMenu();
						} else if (this._isSending && this._onCancelExecution) {
							this._onCancelExecution();
						}
						return;
					}

					// Backspace: if composer is empty and we have skill chips, remove the last chip
					// Also handle: if cursor is right after an inline attachment chip, delete the chip
					if (e.key === 'Backspace') {
						const sel = window.getSelection();
						if (sel && sel.rangeCount > 0) {
							const range = sel.getRangeAt(0);
							const container = range.startContainer;
							const offset = range.startOffset;
							// 找到光标前紧邻的「有效节点」（跳过纯空白文本节点）
							let prevNode: Node | null = null;
							if (container.nodeType === Node.ELEMENT_NODE) {
								prevNode = container.childNodes[offset - 1] ?? null;
								// 若前一个是空白文本节点且再前一个是芯片，则定位到芯片（删除芯片）
								if (prevNode && prevNode.nodeType === Node.TEXT_NODE && /^\s*$/.test(prevNode.textContent ?? '') && offset - 2 >= 0) {
									const beforeThat = container.childNodes[offset - 2];
									if (beforeThat && (beforeThat as HTMLElement).classList?.contains('inline-attachment-chip')) {
										prevNode = beforeThat;
									}
								}
							} else if (container.nodeType === Node.TEXT_NODE && offset === 0) {
								prevNode = container.previousSibling;
							}
							if (prevNode && prevNode.nodeType === Node.ELEMENT_NODE && (prevNode as HTMLElement).classList.contains('inline-attachment-chip')) {
								e.preventDefault();
								const attId = (prevNode as HTMLElement).dataset.attId;
								if (attId) {
									this._attachments = this._attachments.filter(a => a.id !== attId);
									(prevNode as ChildNode).remove();
									this._updateSendButton();
								}
								return;
							}
						}
						if (!this._getComposerText().trim() && this._skillChips.length > 0) {
							e.preventDefault();
							const lastChip = this._skillChips[this._skillChips.length - 1];
							this._removeSkillChip(lastChip.id);
							return;
						}
					}

					// ── 编辑快捷键（contentEditable 内优先于 VS Code 宿主 keybinding）──
					// Ctrl+A：全选（选区覆盖整个 contentEditable 文本）
					if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
						e.preventDefault();
						e.stopPropagation();
						const sel = window.getSelection();
						const textarea = this._textarea;
						if (sel && textarea) {
							const range = document.createRange();
							range.selectNodeContents(textarea);
							sel.removeAllRanges();
							sel.addRange(range);
						}
						return;
					}
					// Ctrl+Z：撤销
					if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
						e.preventDefault();
						e.stopPropagation();
						document.execCommand('undo');
						return;
					}
					// Ctrl+Y / Ctrl+Shift+Z：重做
					if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
						e.preventDefault();
						e.stopPropagation();
						document.execCommand('redo');
						return;
					}
					// Ctrl+C / Ctrl+X：复制 / 剪切（contentEditable 内让浏览器默认行为生效，但要阻止 VS Code 捕获）
					if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'x' || e.key === 'v')) {
						// Ctrl+V 已有独立 PASTE 监听器处理格式化粘贴 / 图片 chip，此处不拦截
						// Ctrl+C / Ctrl+X 只用 stopPropagation 阻止 VS Code 宿主捕获，让浏览器默认行为生效
						if (e.key === 'c' || e.key === 'x') {
							e.stopPropagation(); // 阻止 VS Code 宿主 keybinding 拦截
						}
						// 不调 preventDefault，保留浏览器默认行为
						return;
					}

					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						this._handleSendMessage();
					}
				},
			),
		);

		// Toolbar
		const toolbar = append(composerBox, $(".chat-composer-toolbar"));
		const leftToolbar = append(toolbar, $(".chat-toolbar-left"));

		// Attach button — triggers file input dialog
		const attachBtn = this._appendToolbarBtn(leftToolbar, {
			title: "上传附件",
			svgPath:
				"M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13",
		});
		this._register(addDisposableListener(attachBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			this._fileInput?.click();
		}));

		// P1-3: 添加编辑器选中代码作为上下文
		const selectionBtn = this._appendToolbarBtn(leftToolbar, {
			title: "添加选中代码到聊天",
			svgPath: "M9 2h6a1 1 0 011 1v6h6a1 1 0 011 1v6a1 1 0 01-1 1h-6v6a1 1 0 01-1 1H9a1 1 0 01-1-1v-6H2a1 1 0 01-1-1V10a1 1 0 011-1h6V3a1 1 0 011-1z",
		});
		this._register(addDisposableListener(selectionBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			this._onAddSelectionToChat?.();
		}));

		// Voice button
		this._appendToolbarBtn(leftToolbar, {
			title: "语音输入",
			svgPath:
				"M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8",
		});

		// Divider
		append(leftToolbar, $(".chat-toolbar-divider"));

		// ── 工作区选择器（左侧） ──
		const wsLabel = this._workspaces.find(w => w.id === this._selectedWorkspaceId)?.name ||
			this._workspaces[0]?.name || '工作区';
		const workspaceBtn = this._appendToolbarBtn(leftToolbar, {
			title: '切换工作区',
			svgPath: 'M20.5 5.5H3.5a1 1 0 00-1 1v13a1 1 0 001 1h17a1 1 0 001-1v-13a1 1 0 00-1-1zM2 8.5h20M9 2.5v3M15 2.5v3',
			hasLabel: true,
			label: wsLabel,
			showChevron: true,
			cssClass: 'workspace-tag',
		});
		this._workspaceTrigger = workspaceBtn;
		this._register(addDisposableListener(workspaceBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			if (this._workspaceDropdownEl) {
				this._closeWorkspaceDropdown();
			} else {
				this._openWorkspaceDropdown();
			}
		}));

		// ── Worktree 选择器（右侧） ──
		const wtLabel = this._getWorktreeLabel();
		const worktreeBtn = this._appendToolbarBtn(leftToolbar, {
			title: '切换 Worktree',
			svgPath: 'M6 3v12M18 9v12M6 21l12-12',
			hasLabel: true,
			label: wtLabel,
			showChevron: true,
			cssClass: 'worktree-tag',
		});
		this._worktreeTrigger = worktreeBtn;
		this._register(addDisposableListener(worktreeBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			if (this._worktreeDropdownEl) {
				this._closeWorktreeDropdown();
			} else {
				this._openWorktreeDropdown();
			}
		}));

		// Divider
		append(leftToolbar, $(".chat-toolbar-divider"));

		// Mode tag (craft / ask / plan)
		const modeOpt = MODE_OPTIONS.find(m => m.id === this._chatMode) || MODE_OPTIONS[0];
		this._modeTrigger = this._appendToolbarBtn(leftToolbar, {
			title: '切换模式',
			svgPath: modeOpt.icon,
			hasLabel: true,
			label: modeOpt.label,
			showChevron: true,
			cssClass: 'mode-tag',
		});
		this._register(
			addDisposableListener(this._modeTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._modeDropdownEl) {
					this._closeModeDropdown();
				} else {
					this._openModeDropdown();
				}
			}),
		);

		// Provider chip
		this._providerTrigger = this._appendToolbarBtn(leftToolbar, {
			title: "选择 Provider",
			svgPath: "M2 3h20v14H2zM8 21h8M12 17v4",
			hasLabel: true,
			label: this._providers.find(p => p.id === this._currentProvider)?.label || this._currentProvider || "Provider",
			showChevron: true,
			cssClass: "provider-tag",
		});
		this._register(
			addDisposableListener(this._providerTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._providerDropdownEl) {
					this._closeProviderDropdown();
				} else {
					this._openProviderDropdown();
				}
			}),
		);

		// Agent chip — only show when current provider supports agents (e.g. knot)
		const currentProviderInfo = this._providers.find(p => p.id === this._currentProvider);
		const supportsAgents = !!currentProviderInfo?.supportsAgents;
		
		if (supportsAgents) {
			const agentTag = this._appendToolbarBtn(leftToolbar, {
				title: '切换 Agent',
				svgPath: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
				hasLabel: true,
				label: this._agent?.name || 'Agent',
				showChevron: true,
				cssClass: 'agent-tag',
			});
			this._register(
				addDisposableListener(agentTag, EventType.CLICK, (e) => {
					e.stopPropagation();
					if (this._dropdownOpen) {
						this._closeAgentDropdown();
					} else {
						this._openAgentDropdown();
					}
				}),
			);
		}

		// Model chip
		this._modelTrigger = this._appendToolbarBtn(leftToolbar, {
			title: "选择模型",
			svgPath: "M4 17l6-6-6-6M12 19h8",
			hasLabel: true,
			label: this._models.find(m => m.id === this._currentModel)?.label || this._currentModel || "Model",
			showChevron: true,
			cssClass: "model-tag",
		});
		this._register(
			addDisposableListener(this._modelTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._modelDropdownEl) {
					this._closeModelDropdown();
				} else {
					this._openModelDropdown();
				}
			}),
		);

		// Right wrap: context-usage ring + char counter + send circle
		const rightWrap = append(toolbar, $(".provider-model-chip-wrap"));
		this._renderContextUsageRing(rightWrap);

		// 字符计数器（在发送按钮左侧）
		this._charCounterEl = append(rightWrap, $('span.chat-char-counter'));

		// Send / Cancel button
		this._sendBtn = append(
			rightWrap,
			$(`.chat-send-circle${this._isSending ? ".chat-cancel-circle" : ""}`),
		);
		this._renderSendButtonSvg();
		this._register(
			addDisposableListener(this._sendBtn, EventType.CLICK, () => {
				if (this._isSending) {
					// 参考React：有输入/附件时发送新消息（自动停止当前），无输入时取消
				if (this._getComposerText().trim() || this._attachments.length > 0) {
					this._handleSendMessage();
					} else {
						this._onCancelExecution();
					}
				} else {
					this._handleSendMessage();
				}
			}),
		);
	}

	private _appendToolbarBtn(
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
	): HTMLElement {
		const btn = append(
			parent,
			$(
				`.chat-toolbar-btn${opts.hasLabel ? ".has-label" : ""}${opts.cssClass ? "." + opts.cssClass : ""}`,
			),
		);
		btn.title = opts.title;

		// Extra SVG elements (like the globe for web search)
		if (opts.extraSvgElements) {
			const wrapper = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"svg",
			);
			wrapper.setAttribute("width", "16");
			wrapper.setAttribute("height", "16");
			wrapper.setAttribute("viewBox", "0 0 24 24");
			wrapper.setAttribute("fill", "none");
			wrapper.setAttribute("stroke", "currentColor");
			wrapper.setAttribute("stroke-width", "2");
			wrapper.setAttribute("stroke-linecap", "round");
			wrapper.setAttribute("stroke-linejoin", "round");
			// Append pre-created SVG elements (avoids TrustedHTML issues)
			for (const el of opts.extraSvgElements) {
				wrapper.appendChild(el);
			}
			btn.appendChild(wrapper);
		}

		// Main SVG
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("width", "16");
		svg.setAttribute("height", "16");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "2");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", opts.svgPath);
		svg.appendChild(path);
		btn.appendChild(svg);

		// Label
		if (opts.hasLabel && opts.label) {
			const labelEl = append(btn, $("span.toolbar-btn-label"));
			labelEl.textContent = opts.label;
		}

		// Chevron
		if (opts.showChevron) {
			const chevron = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"svg",
			);
			chevron.setAttribute("width", "10");
			chevron.setAttribute("height", "10");
			chevron.setAttribute("viewBox", "0 0 24 24");
			chevron.setAttribute("fill", "none");
			chevron.setAttribute("stroke", "currentColor");
			chevron.setAttribute("stroke-width", "2.5");
			const chevronPath = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"path",
			);
			chevronPath.setAttribute("d", "M6 9l6 6 6-6");
			chevron.appendChild(chevronPath);
			btn.appendChild(chevron);
		}

		return btn;
	}

	private _renderSendButtonSvg(): void {
		clearNode(this._sendBtn);
		const hasInput = !!(this._getComposerText().trim() || this._attachments.length > 0);
		const isQueueing = this._isSending && hasInput;

		if (isQueueing) {
			// Queue icon — 双层堆叠文档（表示"追加到队列"）
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "14");
			svg.setAttribute("height", "14");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor");
			svg.setAttribute("stroke-width", "2");
			svg.setAttribute("stroke-linecap", "round");
			svg.setAttribute("stroke-linejoin", "round");
			// 下层文档
			const outer = document.createElementNS("http://www.w3.org/2000/svg", "path");
			outer.setAttribute("d", "M4 5h12l4 4v12H4z");
			svg.appendChild(outer);
			// 上层文档（偏移）
			const inner = document.createElementNS("http://www.w3.org/2000/svg", "path");
			inner.setAttribute("d", "M2 4h12l4 4v12H2z");
			svg.appendChild(inner);
			// 加号
			const plus = document.createElementNS("http://www.w3.org/2000/svg", "line");
			plus.setAttribute("x1", "12"); plus.setAttribute("y1", "8");
			plus.setAttribute("x2", "12"); plus.setAttribute("y2", "16");
			plus.setAttribute("stroke-width", "3");
			svg.appendChild(plus);
			const plusH = document.createElementNS("http://www.w3.org/2000/svg", "line");
			plusH.setAttribute("x1", "8"); plusH.setAttribute("y1", "12");
			plusH.setAttribute("x2", "16"); plusH.setAttribute("y2", "12");
			plusH.setAttribute("stroke-width", "3");
			svg.appendChild(plusH);
			this._sendBtn.appendChild(svg);
		} else if (this._isSending) {
			// Stop icon — 使用与发送箭头相同 14x14 尺寸，方块填充 viewBox 核心区域
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "14");
			svg.setAttribute("height", "14");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("fill", "currentColor");
			const rect = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"rect",
			);
			rect.setAttribute("x", "4");
			rect.setAttribute("y", "4");
			rect.setAttribute("width", "16");
			rect.setAttribute("height", "16");
			rect.setAttribute("rx", "3");
			svg.appendChild(rect);
			this._sendBtn.appendChild(svg);
		} else {
			// Arrow up icon
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "12");
			svg.setAttribute("height", "12");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor");
			svg.setAttribute("stroke-width", "2.5");
			svg.setAttribute("stroke-linecap", "round");
			svg.setAttribute("stroke-linejoin", "round");
			const line = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"line",
			);
			line.setAttribute("x1", "12");
			line.setAttribute("y1", "19");
			line.setAttribute("x2", "12");
			line.setAttribute("y2", "5");
			svg.appendChild(line);
			const polyline = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"polyline",
			);
			polyline.setAttribute("points", "5 12 12 5 19 12");
			svg.appendChild(polyline);
			this._sendBtn.appendChild(svg);
		}
	}

	private _updateSendButton(): void {
		if (!this._sendBtn) {
			return;
		}
		const text = this._getComposerText();
		const hasInput = !!(text.trim() || this._attachments.length > 0);

		// 流式输出过程中有输入内容 → 显示为「排队发送」按钮，不是「取消」按钮
		const isQueueing = this._isSending && hasInput;
		this._sendBtn.classList.toggle("chat-cancel-circle", this._isSending && !hasInput);
		this._sendBtn.classList.toggle("chat-queue-circle", isQueueing);

		// 流式输出过程中不再禁用输入框 (textarea.disabled 已在 _renderInputArea 移除)
		// 按钮禁用逻辑：无输入且非发送中 → 禁用
		const disabled = !hasInput && !this._isSending;
		(this._sendBtn as HTMLButtonElement).disabled = disabled;

		// 更新按钮标题
		if (isQueueing) {
			this._sendBtn.title = '排队发送 (Enter)';
		} else if (this._isSending) {
			this._sendBtn.title = '停止生成 (Escape)';
		} else {
			this._sendBtn.title = '发送 (Enter)';
		}

		// 更新字符计数器
		this._updateCharCounter(text);

		this._renderSendButtonSvg();
	}

	// =========================================================
	// Session Info Bar (mode badge + hierarchy + tasks)
	// =========================================================

	private _renderSessionInfo(): void {
		const info = this._sessionInfo!;
		const bar = append(this._container, $(".chat-session-info"));

		const modeBadge = append(bar, $(`.chat-mode-badge.mode-${info.mode}`));
		modeBadge.textContent = info.mode === 'craft' ? 'Craft' : info.mode === 'ask' ? 'Ask' : 'Plan';

		const hierarchy = append(bar, $(".session-info-hierarchy"));
		if (info.superior) {
			append(hierarchy, $("span.hierarchy-label", undefined, '上级'));
			append(hierarchy, $("span.hierarchy-agent", undefined, info.superior.name));
			if (info.subordinates && info.subordinates.length > 0) {
				append(hierarchy, $("span.hierarchy-comma", undefined, ' · '));
			}
		}
		if (info.subordinates && info.subordinates.length > 0) {
			append(hierarchy, $("span.hierarchy-label", undefined, '下级'));
			const names = info.subordinates.map(s => s.name).join('、');
			append(hierarchy, $("span.hierarchy-agent", undefined, names));
		}
		if (!info.superior && (!info.subordinates || info.subordinates.length === 0)) {
			append(hierarchy, $("span.hierarchy-label", undefined, '独立会话'));
		}

		const tasks = append(bar, $(".session-info-tasks"));
		tasks.textContent = `任务 ${info.taskCount}`;
	}

	// =========================================================
	// Checkpoint detail card (rendered in system message list)
	// =========================================================

	// =========================================================
	// P0-2: @mention file search (文件提及搜索)
	// =========================================================

	private _scheduleMentionSearch(query: string): void {
		if (this._mentionSearchTimer !== null) { clearTimeout(this._mentionSearchTimer); }
		// 300ms 防抖——参考 Void util/inputs.tsx L525-551
		this._mentionSearchTimer = window.setTimeout(async () => {
			this._mentionSearchTimer = null;
			if (!this._onSearchFiles) { return; }
			try {
				const results = await this._onSearchFiles(query);
				this._mentionResults = results.slice(0, 10);
				if (this._mentionResults.length > 0) {
					this._openMentionMenu();
				} else {
					this._closeMentionMenu();
				}
			} catch { /* ignore */ }
		}, 300) as unknown as number;
	}

	private _openMentionMenu(): void {
		this._closeMentionMenu();
		if (!this._textarea || this._mentionResults.length === 0) { return; }

		const rect = this._textarea.getBoundingClientRect();
		this._mentionEl = document.createElement('div');
		this._mentionEl.className = 'mention-menu';
		this._mentionEl.style.left = `${rect.left}px`;
		this._mentionEl.style.bottom = `${window.innerHeight - rect.top + 4}px`;
		this._mentionEl.style.maxWidth = `${Math.max(rect.width, 320)}px`;

		const list = document.createElement('div');
		list.className = 'mention-menu-list';
		this._mentionResults.forEach((r, i) => {
			const item = document.createElement('div');
			item.className = 'mention-menu-item';
			item.dataset.path = r.path;
			const icon = document.createElement('span');
			icon.className = 'mention-menu-item-icon';
			icon.textContent = '📄';
			item.appendChild(icon);
			const info = document.createElement('span');
			info.className = 'mention-menu-item-info';
			const name = document.createElement('span');
			name.className = 'mention-menu-item-name';
			name.textContent = r.name;
			info.appendChild(name);
			const path = document.createElement('span');
			path.className = 'mention-menu-item-path';
			path.textContent = r.path;
			info.appendChild(path);
			item.appendChild(info);
			item.addEventListener('click', () => {
				this._mentionIndex = i;
				this._selectMentionItem();
			});
			list.appendChild(item);
		});

		this._mentionEl.appendChild(list);
		document.body.appendChild(this._mentionEl);
		this._mentionIndex = 0;
		this._highlightMentionItem();
	}

	private _highlightMentionItem(): void {
		const items = this._mentionEl?.querySelectorAll('.mention-menu-item');
		if (!items?.length) { return; }
		items.forEach((el, i) => el.classList.toggle('selected', i === this._mentionIndex));
		const selected = items[this._mentionIndex] as HTMLElement | undefined;
		if (selected) { selected.scrollIntoView({ block: 'nearest' }); }
	}

	private _selectMentionItem(): void {
		if (!this._mentionEl || this._mentionIndex >= this._mentionResults.length) { return; }
		const selected = this._mentionResults[this._mentionIndex];
		if (!selected) { return; }

		// 替换 contentEditable 中的 @query 为 @filename
		const root = this._textarea;
		if (!root) { return; }
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0) {
			const range = sel.getRangeAt(0);
			const container = range.endContainer;
			if (container.nodeType === Node.TEXT_NODE) {
				const textNode = container as Text;
				const text = textNode.textContent ?? '';
				const caretOffset = range.endOffset;
				const beforeCursor = text.slice(0, caretOffset);
				const afterCursor = text.slice(caretOffset);
				// 找到最后一个 @query 并替换
				const atMatch = beforeCursor.match(/@(\w[^\s]*)$/);
				if (atMatch) {
					const replacement = `@${selected.name} `;
					const newBefore = beforeCursor.slice(0, beforeCursor.length - atMatch[0].length) + replacement;
					textNode.textContent = newBefore + afterCursor;
					// 光标移动到 replacement 之后
					const newPos = newBefore.length;
					const newRange = document.createRange();
					newRange.setStart(textNode, newPos);
					newRange.collapse(true);
					sel.removeAllRanges();
					sel.addRange(newRange);
				}
			} else {
				// 退化为直接插入文件名文本
				this._insertTextAtCaret(`@${selected.name} `);
			}
		}

		// 添加文件作为上下文
		this._onAddFileContext?.(selected.path);

		this._closeMentionMenu();
		// 触发 input 以更新高度/发送按钮
		root.dispatchEvent(new Event('input'));
	}

	private _closeMentionMenu(): void {
		if (this._mentionEl) {
			this._mentionEl.remove();
			this._mentionEl = null;
		}
		this._mentionQuery = '';
		this._mentionResults = [];
		this._mentionIndex = 0;
	}

	// =========================================================
	// Slash menu (slash command picker)
	// =========================================================

	private _openSlashMenu(filter: string): void {
		this._closeSlashMenu();

		const skills = this._onListSkills();
		if (!skills.length) { return; }

		const filtered = filter
			? skills.filter(s =>
				s.id.toLowerCase().includes(filter.toLowerCase()) ||
				s.name.toLowerCase().includes(filter.toLowerCase()))
			: skills;
		if (!filtered.length) { return; }

		const textarea = this._textarea;
		const rect = textarea.getBoundingClientRect();

		this._slashMenuEl = document.createElement('div');
		this._slashMenuEl.className = 'slash-menu';
		// Position above textarea
		this._slashMenuEl.style.left = `${rect.left}px`;
		this._slashMenuEl.style.bottom = `${window.innerHeight - rect.top + 4}px`;
		this._slashMenuEl.style.maxWidth = `${Math.max(rect.width, 260)}px`;

		// Items (render directly since we just created the element)
		const list = document.createElement('div');
		list.className = 'slash-menu-list';
		filtered.forEach((s, i) => {
			const item = document.createElement('div');
			item.className = 'slash-menu-item';
			item.dataset.skillId = s.id;
			item.dataset.skillName = s.name || s.id;
			const icon = document.createElement('span');
			icon.className = 'slash-menu-item-icon';
			icon.textContent = '/';
			item.appendChild(icon);
			const info = document.createElement('span');
			info.className = 'slash-menu-item-info';
			const name = document.createElement('span');
			name.className = 'slash-menu-item-name';
			name.textContent = s.id;
			info.appendChild(name);
			const desc = document.createElement('span');
			desc.className = 'slash-menu-item-desc';
			desc.textContent = s.name;
			info.appendChild(desc);
			item.appendChild(info);
			item.addEventListener('mousedown', (e) => {
				e.preventDefault();
				this._insertSlashSkill(s.id, s.name || s.id);
				this._closeSlashMenu();
			});
			list.appendChild(item);
		});

		this._slashMenuEl.appendChild(list);
		document.body.appendChild(this._slashMenuEl);
		this._slashMenuIndex = 0;
		this._highlightSlashMenuItem();
	}

	private _renderSlashMenuItems(filter: string): void {
		if (!this._slashMenuEl) { return; }
		const skills = this._onListSkills();
		const filtered = filter
			? skills.filter(s =>
				s.id.toLowerCase().includes(filter.toLowerCase()) ||
				s.name.toLowerCase().includes(filter.toLowerCase()))
			: skills;

		const list = this._slashMenuEl.querySelector('.slash-menu-list') as HTMLElement | null;
		if (!list) { return; }
		clearNode(list);

		if (!filtered.length) {
			this._closeSlashMenu();
			return;
		}

		filtered.forEach((s, i) => {
			const item = document.createElement('div');
			item.className = 'slash-menu-item';
			item.dataset.skillId = s.id;
			const icon = document.createElement('span');
			icon.className = 'slash-menu-item-icon';
			icon.textContent = '/';
			item.appendChild(icon);
			const info = document.createElement('span');
			info.className = 'slash-menu-item-info';
			const name = document.createElement('span');
			name.className = 'slash-menu-item-name';
			name.textContent = s.id;
			info.appendChild(name);
			const desc = document.createElement('span');
			desc.className = 'slash-menu-item-desc';
			desc.textContent = s.name;
			info.appendChild(desc);
			item.appendChild(info);
			item.addEventListener('mousedown', (e) => {
				e.preventDefault();
				this._insertSlashSkill(s.id, s.name || s.id);
				this._closeSlashMenu();
			});
			list.appendChild(item);
		});

		this._slashMenuIndex = Math.min(this._slashMenuIndex, filtered.length - 1);
		this._highlightSlashMenuItem();
	}

	private _highlightSlashMenuItem(): void {
		const items = this._slashMenuEl?.querySelectorAll('.slash-menu-item');
		if (!items?.length) { return; }
		items.forEach((el, i) => {
			el.classList.toggle('selected', i === this._slashMenuIndex);
		});
		// Scroll selected into view
		const selected = items[this._slashMenuIndex] as HTMLElement | undefined;
		if (selected) { selected.scrollIntoView({ block: 'nearest' }); }
	}

	// --- Skill chips (P2) ---

	private _addSkillChip(id: string, name: string): void {
		// Check if already added
		if (this._skillChips.some(c => c.id === id)) { return; }
		this._skillChips.push({ id, name });
		this._renderSkillChips();
	}

	private _removeSkillChip(id: string): void {
		this._skillChips = this._skillChips.filter(c => c.id !== id);
		this._renderSkillChips();
	}

	private _renderSkillChips(): void {
		if (!this._skillChipsBar) { return; }
		// Clear existing chips
		while (this._skillChipsBar.firstChild) {
			this._skillChipsBar.removeChild(this._skillChipsBar.firstChild);
		}
		// Render chips
		for (const chip of this._skillChips) {
			const chipEl = append(this._skillChipsBar, $('span.skill-chip'));
			chipEl.title = `技能: ${chip.name} (${chip.id})`;
			append(chipEl, $('span.skill-chip-icon', undefined, '⚡'));
			append(chipEl, $('span.skill-chip-name', undefined, chip.name));
		const removeBtn = append(chipEl, $('button.skill-chip-remove'));
			// Create SVG element directly (avoid TrustedHTML issues with DOMParser)
			const removeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			removeSvg.setAttribute('width', '10');
			removeSvg.setAttribute('height', '10');
			removeSvg.setAttribute('viewBox', '0 0 24 24');
			removeSvg.setAttribute('fill', 'none');
			removeSvg.setAttribute('stroke', 'currentColor');
			removeSvg.setAttribute('stroke-width', '2.5');
			const removeLine1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			removeLine1.setAttribute('x1', '18');
			removeLine1.setAttribute('y1', '6');
			removeLine1.setAttribute('x2', '6');
			removeLine1.setAttribute('y2', '18');
			removeSvg.appendChild(removeLine1);
			const removeLine2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			removeLine2.setAttribute('x1', '6');
			removeLine2.setAttribute('y1', '6');
			removeLine2.setAttribute('x2', '18');
			removeLine2.setAttribute('y2', '18');
			removeSvg.appendChild(removeLine2);
			removeBtn.appendChild(removeSvg);
			this._register(addDisposableListener(removeBtn, EventType.CLICK, () => {
				this._removeSkillChip(chip.id);
			}));
		}
		// Show/hide bar
		this._skillChipsBar.style.display = this._skillChips.length > 0 ? 'flex' : 'none';
	}

	private _selectSlashMenuItem(): void {
		const items = this._slashMenuEl?.querySelectorAll('.slash-menu-item');
		if (!items?.length) { return; }
		const selected = items[Math.min(this._slashMenuIndex, items.length - 1)] as HTMLElement | undefined;
		if (selected?.dataset.skillId) {
			this._insertSlashSkill(selected.dataset.skillId, selected.dataset.skillName || selected.dataset.skillId);
		}
		this._closeSlashMenu();
	}

	private _insertSlashSkill(skillId: string, skillName: string): void {
		// Add skill chip
		this._addSkillChip(skillId, skillName);
		// Clear composer (skill is now in chip)
		this._setComposerText('');
		this._textarea.style.color = '';
		this._textarea.removeAttribute('data-slash-command');
		// Auto-resize and reposition cursor to end
		this._textarea.style.height = 'auto';
		const maxAllowed = 320;
		const newHeight = this._userHasAdjustedHeight
			? Math.min(Math.max(this._textarea.scrollHeight, this._resizeMaxH), maxAllowed)
			: Math.min(this._textarea.scrollHeight, this._resizeMaxH);
		this._textarea.style.height = newHeight + 'px';
		this._focusComposerEnd();
	}

	private _closeSlashMenu(): void {
		if (this._slashMenuEl) {
			this._slashMenuEl.remove();
			this._slashMenuEl = null;
		}
		this._slashMenuIndex = 0;
	}

	// =========================================================
	// Context-usage ring
	// =========================================================

	private _renderContextUsageRing(parent: HTMLElement): void {
		renderContextUsageRing(parent, this._contextUsage);
	}

	// ── Context Usage 计算（匹配 React 3 层逻辑）─────────────────

	/** 粗略 token 估算（参考 React estimateTokens：字符数/4 向上取整） */
	private _estimateTokens(text: string | undefined | null): number {
		if (!text) { return 0; }
		return Math.ceil(text.length / 4);
	}

	/** 计算输入基线 tokens（从消息历史中最后一条有 tokenUsage 的消息） */
	private _computeInputBaselineTokens(): number {
		// 从后往前找到最近一条有真实 tokenUsage 的消息
		for (let i = this._messages.length - 1; i >= 0; i--) {
			const m = this._messages[i];
			if (m.tokenUsage && (m.tokenUsage.input > 0 || m.tokenUsage.total > 0)) {
				if (m.tokenUsage.input > 0) {
					return m.tokenUsage.input + (m.tokenUsage.output || 0);
				}
				return m.tokenUsage.total;
			}
		}
		// 无真实 usage（新对话或首条消息）：降级为逐条字符估算
		let total = 0;
		for (const m of this._messages) {
			total += this._estimateTokens(m.content);
			total += this._estimateTokens(m.thinking);
			if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
				for (const tc of m.toolCalls) {
					total += this._estimateTokens(tc.args);
					total += this._estimateTokens(tc.result);
					total += this._estimateTokens(tc.name);
				}
			}
		}
		return total;
	}

	/** 计算 context usage（3 层实时更新逻辑，匹配 React） */
	private _computeContextUsage(): IContextUsage | null {
		// 从当前模型获取 maxInputTokens（匹配 React：currentModel?.maxInputTokens）
		const currentModelInfo = this._models.find(m => m.id === this._currentModel);
		const limit = currentModelInfo?.maxInputTokens ?? 0;
		if (limit <= 0) {
			return null;
		}

		const isStreaming = this._streamPhase !== 'idle' && this._streamPhase !== 'error';

		const inputBaselineTokens = this._computeInputBaselineTokens();

		// effectiveBaseline: 如果有 compactedBaseline，使用它（取较小值）
		const effectiveBaseline = this._compactedBaseline > 0
			? Math.min(this._compactedBaseline, inputBaselineTokens)
			: inputBaselineTokens;

		let used: number;
		if (this._streamUsage?.seen) {
			// 3) 真值优先：已收到真实 usage chunk
			const real = (this._streamUsage.input ?? 0) + (this._streamUsage.output ?? 0);
			used = Math.max(real, effectiveBaseline);
		} else if (isStreaming) {
			// 2) 流式进行中且尚无真实 usage：输入基线 + 实时输出估算
			const outputEstimate = this._estimateTokens(this._streamTextBuffer) + this._estimateTokens(this._streamThinkingBuffer);
			used = effectiveBaseline + outputEstimate;
		} else {
			// 1) 空闲态：纯输入基线
			used = effectiveBaseline;
		}

		const ratio = Math.max(0, Math.min(1, used / limit));
		return {
			used,
			limit,
			ratio,
			percent: Math.round(ratio * 100),
		};
	}

	/**
	 * Context ring 更新——流式期间 500ms 防抖，非流式立即更新。
	 * 参考 VS Code 的 lazy update pattern。
	 */
	private _contextRingTimer: number | null = null;

	private _updateContextRing(): void {
		// 流式期间防抖——context ring 不需要每帧更新，500ms 足够
		if (this._isSending) {
			if (this._contextRingTimer !== null) { return; } // 已有 pending
			this._contextRingTimer = window.setTimeout(() => {
				this._contextRingTimer = null;
				this._doUpdateContextRing();
			}, 500);
			return;
		}
		// 非流式：取消 pending 并立即更新
		if (this._contextRingTimer !== null) {
			clearTimeout(this._contextRingTimer);
			this._contextRingTimer = null;
		}
		this._doUpdateContextRing();
	}

	private _doUpdateContextRing(): void {
		// 重新计算 contextUsage（3层逻辑，匹配 React）
		const computed = this._computeContextUsage();
		if (computed) {
			this._contextUsage = computed;
		}
		// 渲染环形进度条
		const ring = this._container.querySelector('.context-usage-ring') as HTMLElement | null;
		if (!ring) { return; }
		const parent = ring.parentElement;
		if (!parent) { return; }
		const sendBtn = parent.querySelector('.chat-send-circle');
		ring.remove();
		const tempParent = $('div');
		this._renderContextUsageRing(tempParent);
		const newRing = tempParent.firstElementChild;
		if (newRing && sendBtn) {
			parent.insertBefore(newRing, sendBtn);
		} else if (newRing) {
			parent.appendChild(newRing);
		}
	}

	// =========================================================
	// Worktree dropdown
	// =========================================================

	private _openWorktreeDropdown(): void {
		this._closeAllDropdowns();
		this._activeHeaderPanel = 'worktree';
		if (this._worktreeTrigger) { this._worktreeTrigger.classList.add('open'); }

		this._worktreeDropdownEl = append(mainWindow.document.body, $(".chat-worktree-dropdown"));
		// 输入框中 worktree 选择器 → 弹出方向：向上（避免被输入框遮挡）
		this._positionDropdownAbove(this._worktreeDropdownEl, this._worktreeTrigger);

		const head = append(this._worktreeDropdownEl, $(".chat-worktree-dropdown-header"));
		head.textContent = 'Worktrees';

		const list = append(this._worktreeDropdownEl, $(".chat-worktree-dropdown-list"));

		// 显示加载提示
		const loadingEl = append(list, $(".chat-worktree-dropdown-loading", undefined, '加载中...'));

		// 异步加载 worktree 列表（参考 React WorktreeSwitcher 的逻辑）
		this._loadWorktreesAndRender(list, loadingEl);

		this._disposeOutsideClick(this._worktreeDropdownOutsideClick);
		this._worktreeDropdownOutsideClick = this._registerOutsideClickClose(this._worktreeDropdownEl, this._worktreeTrigger, () => this._closeWorktreeDropdown());
	}

	private async _loadWorktreesAndRender(list: HTMLElement, loadingEl: HTMLElement): Promise<void> {
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
				}
			}
		} catch (err) {
			console.error('[AgentChatPanel] Failed to load worktrees:', err);
			loadingEl.textContent = '加载失败，请重试';
		}
	}

	private _closeWorktreeDropdown(): void {
		this._disposeOutsideClick(this._worktreeDropdownOutsideClick);
		this._worktreeDropdownOutsideClick = null;
		if (this._worktreeDropdownEl) {
			this._worktreeDropdownEl.remove();
			this._worktreeDropdownEl = null;
		}
		if (this._worktreeTrigger) { this._worktreeTrigger.classList.remove('open'); }
		if (this._activeHeaderPanel === 'worktree') {
			this._activeHeaderPanel = null;
		}
	}

	/** 获取 worktree 触发器显示的标签文字 */
	private _getWorktreeLabel(): string {
		if (!this._selectedWorktreePath) { return '主仓库'; }
		const current = this._worktrees.find(w => w.path === this._selectedWorktreePath);
		if (current?.branch) { return current.branch; }
		return this._selectedWorktreePath.split(/[\\/]/).filter(Boolean).pop() || this._selectedWorktreePath;
	}

	// =========================================================
	// Workspace dropdown (input-area toolbar)
	// =========================================================

	private _openWorkspaceDropdown(): void {
		this._closeAllDropdowns();
		if (this._workspaceTrigger) { this._workspaceTrigger.classList.add('open'); }

		this._workspaceDropdownEl = append(mainWindow.document.body, $(".workspace-dropdown"));
		// 输入框中 workspace 选择器 → 弹出方向：向上（避免被输入框遮挡）
		this._positionDropdownAbove(this._workspaceDropdownEl, this._workspaceTrigger);

		// 如果有外部提供的加载回调，先异步加载
		const renderItems = (list: IWorkspaceItem[]) => {
			if (!this._workspaceDropdownEl) { return; }
			// 清空
			while (this._workspaceDropdownEl.firstChild) { this._workspaceDropdownEl.firstChild.remove(); }
			for (const ws of list) {
				const item = append(this._workspaceDropdownEl, $(".workspace-dropdown-item"));
				if (ws.id === this._selectedWorkspaceId) {
					item.classList.add('active');
				}
				append(item, $("span.workspace-dropdown-name", undefined, ws.name));
				append(item, $("span.workspace-dropdown-path", undefined, ws.path));
				this._register(addDisposableListener(item, EventType.CLICK, () => {
					this._closeWorkspaceDropdown();
					if (ws.id !== this._selectedWorkspaceId) {
					this._selectedWorkspaceId = ws.id;
					this._onSelectWorkspace?.(ws.id, ws.name);
					// 轻量刷新输入区域（保存/恢复输入框内容），避免 _render() 全量重建清空输入框
					this._refreshInputArea();
					}
				}));
			}
		};

		const staticItems = this._workspaces;
		if (staticItems.length > 0) {
			renderItems(staticItems);
		} else if (this._onLoadWorkspaces) {
			this._onLoadWorkspaces().then(loaded => {
				this._workspaces = loaded.slice();
				renderItems(loaded as unknown as IWorkspaceItem[]);
			}).catch(() => { /* 静默忽略 */ });
		}

		this._disposeOutsideClick(this._workspaceDropdownOutsideClick);
		this._workspaceDropdownOutsideClick = this._registerOutsideClickClose(
			this._workspaceDropdownEl, this._workspaceTrigger, () => this._closeWorkspaceDropdown()
		);
	}

	private _closeWorkspaceDropdown(): void {
		this._disposeOutsideClick(this._workspaceDropdownOutsideClick);
		this._workspaceDropdownOutsideClick = null;
		if (this._workspaceDropdownEl) {
			this._workspaceDropdownEl.remove();
			this._workspaceDropdownEl = null;
		}
		if (this._workspaceTrigger) { this._workspaceTrigger.classList.remove('open'); }
	}

	// =========================================================
	// Settings overlay (right-side panel, unified with history)
	// =========================================================


	private _settingsOverlayEl: HTMLElement | null = null;

	private _renderSettingsOverlay(): void {
		this._settingsOverlayEl = append(this._container, $(".chat-settings-overlay"));
		this._renderSettingsOverlayContent('prompt');
	}

	private _renderSettingsOverlayContent(activeTab: string): void {
		if (!this._settingsOverlayEl) { return; }
		clearNode(this._settingsOverlayEl);

		// Header (title + close button)
		const header = append(this._settingsOverlayEl, $(".chat-settings-header"));
		const titleLeft = append(header, $(".chat-settings-title-left"));
		const gearIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		gearIcon.setAttribute('width', '16');
		gearIcon.setAttribute('height', '16');
		gearIcon.setAttribute('viewBox', '0 0 24 24');
		gearIcon.setAttribute('fill', 'none');
		gearIcon.setAttribute('stroke', 'currentColor');
		gearIcon.setAttribute('stroke-width', '2');
		const gearPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		gearPath.setAttribute('d', 'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z');
		gearIcon.appendChild(gearPath);
		const gearCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		gearCircle.setAttribute('cx', '12');
		gearCircle.setAttribute('cy', '12');
		gearCircle.setAttribute('r', '3');
		gearIcon.appendChild(gearCircle);
		titleLeft.appendChild(gearIcon);
		append(titleLeft, $("span.chat-settings-title", undefined, 'Agent 配置'));

		// Close button (right-aligned)
		const closeBtn = append(header, $("button.chat-settings-close-btn"));
		closeBtn.title = '关闭';
		const closeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		closeSvg.setAttribute('width', '16');
		closeSvg.setAttribute('height', '16');
		closeSvg.setAttribute('viewBox', '0 0 24 24');
		closeSvg.setAttribute('fill', 'none');
		closeSvg.setAttribute('stroke', 'currentColor');
		closeSvg.setAttribute('stroke-width', '2');
		closeSvg.setAttribute('stroke-linecap', 'round');
		const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		closePath.setAttribute('d', 'M18 6L6 18M6 6l12 12');
		closeSvg.appendChild(closePath);
		closeBtn.appendChild(closeSvg);
		this._register(
			addDisposableListener(closeBtn, EventType.CLICK, () => {
				this._activeHeaderPanel = null;
				this._render();
			}),
		);

		// Tab bar — 使用 Codicon 原生图标 + monaco-button 样式
		const tabBar = append(this._settingsOverlayEl, $(".chat-settings-tabs"));
		const tabs: { id: string; codicon: string; label: string }[] = [
			{ id: 'prompt', codicon: 'codicon codicon-comment-discussion', label: 'Prompt' },
			{ id: 'skills', codicon: 'codicon codicon-tools', label: '技能' },
			{ id: 'mcp', codicon: 'codicon codicon-server', label: 'MCP' },
			{ id: 'knowledge', codicon: 'codicon codicon-library', label: '知识库' },
			{ id: 'rules', codicon: 'codicon codicon-checklist', label: '规则' },
		];
		for (const tab of tabs) {
			const tabBtn = append(tabBar, $("button.chat-settings-tab"));
			if (tab.id === activeTab) { tabBtn.classList.add('active'); }
			append(tabBtn, $("span.tab-icon." + tab.codicon));
			append(tabBtn, $("span.tab-label", undefined, tab.label));
			this._register(
				addDisposableListener(tabBtn, EventType.CLICK, () => {
					this._renderSettingsOverlayContent(tab.id);
				}),
			);
		}

		// Content area
		const contentArea = append(this._settingsOverlayEl, $(".chat-settings-content"));

		// Render tab content
		if (activeTab === 'prompt') {
			this._renderSettingsPromptTab(contentArea);
		} else if (activeTab === 'skills') {
			this._renderSettingsSkillsTab(contentArea);
		} else if (activeTab === 'mcp') {
			this._renderSettingsMcpTab(contentArea);
		} else if (activeTab === 'knowledge') {
			this._renderSettingsKnowledgeTab(contentArea);
		} else if (activeTab === 'rules') {
			this._renderSettingsRulesTab(contentArea);
		}

		// Footer with "Open full editor" button — 使用 VS Code 原生 monaco-button
		const footer = append(this._settingsOverlayEl, $(".chat-settings-footer"));
		const openFullBtn = append(footer, $("button.monaco-button.monaco-text-button.chat-settings-open-full-btn"));
		openFullBtn.textContent = '在完整编辑器中打开 →';
		this._register(
			addDisposableListener(openFullBtn, EventType.CLICK, () => {
				this._activeHeaderPanel = null;
				this._render();
				this._onOpenSettings?.();
			}),
		);
	}

	private _renderSettingsPromptTab(container: HTMLElement): void {
		const desc = append(container, $(".chat-settings-tab-desc"));
		desc.textContent = '编辑 Agent 的系统提示词';

		const textarea = append(container, $("textarea.chat-settings-prompt-editor")) as HTMLTextAreaElement;
		textarea.spellcheck = false;
		textarea.placeholder = '输入系统提示词...';
		// 使用当前 agent 的实际系统提示词，而非硬编码默认值
		textarea.value = this._agent?.customPrompt ?? '';

		const actions = append(container, $(".chat-settings-tab-actions"));
		append(actions, $("span.dirty-hint", undefined, '● 未保存'));
		const spacer = append(actions, $("div"));
		spacer.style.flex = '1';
		const saveBtn = append(actions, $("button.monaco-button.monaco-text-button.action-btn.primary", undefined, '保存'));
		this._register(
			addDisposableListener(saveBtn, EventType.CLICK, () => {
				// TODO: save system prompt via callback
				console.log('[Settings] Save prompt clicked');
			}),
		);
	}

	private _renderSettingsSkillsTab(container: HTMLElement): void {
		const desc = append(container, $(".chat-settings-tab-desc"));
		desc.textContent = '为 Agent 配置技能。点击右侧可用技能添加，点击左侧已安装技能移除。';

		const panel = append(container, $(".skills-dnd-panel"));

		// Left: installed skills
		const leftCol = append(panel, $(".skills-column"));
		const leftHeader = append(leftCol, $(".skills-column-header"));
		leftHeader.textContent = '已安装技能';
		const leftList = append(leftCol, $(".skills-list"));

		// Right: available skills
		const rightCol = append(panel, $(".skills-column"));
		const rightHeader = append(rightCol, $(".skills-column-header"));
		rightHeader.textContent = '可用技能';
		const rightFilter = append(rightCol, $('input.skills-filter-input')) as HTMLInputElement;
		rightFilter.type = 'text';
		rightFilter.placeholder = '搜索技能...';
		const rightList = append(rightCol, $(".skills-list"));

		const allSkills = this._onListSkills();
		const agentSkillIds = this._onGetAgentSkills?.() ?? [];

		const renderSkillsLists = (filterText: string = '') => {
			// Installed skills
			leftList.replaceChildren();
			if (agentSkillIds.length === 0) {
				const empty = append(leftList, $(".skills-empty"));
				empty.textContent = '暂无已安装技能';
			} else {
				for (const skillId of agentSkillIds) {
					const skill = allSkills.find(s => s.id === skillId);
					const item = append(leftList, $(".skill-item.installed"));
					const info = append(item, $(".skill-item-info"));
					const nameEl = append(info, $("span.skill-item-name"));
					nameEl.textContent = skill?.name || skillId;
					if (skill?.category) {
						append(info, $("span.skill-item-cat", undefined, skill.category));
					}
					const removeBtn = append(item, $("button.skill-remove-btn")) as HTMLButtonElement;
					removeBtn.title = '移除';
					removeBtn.textContent = '✕';
					this._register(addDisposableListener(removeBtn, EventType.CLICK, async (e) => {
						e.stopPropagation();
						removeBtn.disabled = true;
						try {
							await this._onRemoveSkill?.(skillId);
							const idx = agentSkillIds.indexOf(skillId);
							if (idx >= 0) { agentSkillIds.splice(idx, 1); }
							renderSkillsLists(rightFilter.value);
						} catch {
							removeBtn.disabled = false;
						}
					}));
				}
			}

			// Available skills
			rightList.replaceChildren();
			const available = allSkills.filter(s =>
				!agentSkillIds.includes(s.id) &&
				(!filterText || s.name.toLowerCase().includes(filterText.toLowerCase()))
			);
			if (available.length === 0) {
				const empty = append(rightList, $(".skills-empty"));
				empty.textContent = filterText ? '未找到匹配的技能' : '无可用技能';
			} else {
				for (const skill of available) {
					const item = append(rightList, $(".skill-item.available"));
					const info = append(item, $(".skill-item-info"));
					const nameEl = append(info, $("span.skill-item-name"));
					nameEl.textContent = skill.name;
					if (skill.category) {
						append(info, $("span.skill-item-cat", undefined, skill.category));
					}
					const addBtn = append(item, $("button.skill-add-btn")) as HTMLButtonElement;
					addBtn.title = '添加';
					addBtn.textContent = '+';
					this._register(addDisposableListener(addBtn, EventType.CLICK, async (e) => {
						e.stopPropagation();
						addBtn.disabled = true;
						try {
							await this._onAddSkill?.(skill.id);
							agentSkillIds.push(skill.id);
							renderSkillsLists(rightFilter.value);
						} catch {
							addBtn.disabled = false;
						}
					}));
				}
			}
		};

		this._register(addDisposableListener(rightFilter, EventType.INPUT, () => {
			renderSkillsLists(rightFilter.value);
		}));

		renderSkillsLists();
	}

	/**
	 * MCP 服务器配置页签——列出已连接的 MCP 服务器及工具数，
	 * 提供按钮打开 VS Code 原生 MCP 设置界面。
	 */
	private _renderSettingsMcpTab(container: HTMLElement): void {
		const desc = append(container, $(".chat-settings-tab-desc"));
		desc.textContent = 'MCP（Model Context Protocol）配置：连接外部工具和数据源。';

		const servers = this._onListMcpServers?.() ?? [];

		if (servers.length === 0) {
			const placeholder = append(container, $(".chat-settings-empty"));
			placeholder.textContent = '暂无已连接的 MCP 服务器';
		} else {
			const list = append(container, $(".skills-list.mcp-server-list"));
			for (const server of servers) {
				const item = append(list, $(".skill-item.mcp-server-item"));
				append(item, $("span.skill-item-icon.codicon.codicon-server"));
				const info = append(item, $(".skill-item-info"));
				const nameEl = append(info, $("span.skill-item-name"));
				nameEl.textContent = server.name;
				const statusEl = append(info, $("span.skill-item-cat"));
				statusEl.textContent = `${server.status} · ${server.toolCount} 个工具`;
				// 状态指示灯
				const dot = append(item, $("span.mcp-status-dot"));
				if (server.status === 'connected' || server.status === 'running') {
					dot.style.background = '#4ec9b0';
				} else if (server.status === 'error') {
					dot.style.background = '#f48771';
				} else {
					dot.style.background = '#cccccc';
				}
			}
		}

		// 操作按钮——使用 VS Code 原生 monaco-button
		const actions = append(container, $(".chat-settings-tab-actions"));
		const addBtn = append(actions, $("button.monaco-button.monaco-text-button.action-btn.primary", undefined, '配置 MCP 服务器'));
		this._register(
			addDisposableListener(addBtn, EventType.CLICK, () => {
				this._onOpenMcpSettings?.();
			}),
		);
	}

	private _renderSettingsKnowledgeTab(container: HTMLElement): void {
		const desc = append(container, $(".chat-settings-tab-desc"));
		desc.textContent = '知识库检索配置';

		const section = append(container, $(".chat-settings-section.expanded"));
		const sectionHeader = append(section, $(".config-section-header", undefined, '基础设置'));
		sectionHeader.style.padding = '8px 12px';
		sectionHeader.style.fontSize = '12px';
		sectionHeader.style.fontWeight = '600';
		sectionHeader.style.borderBottom = '1px solid rgba(128,128,128,0.1)';

		const body = append(section, $(".config-section-body"));
		body.style.padding = '10px 12px';
		body.style.display = 'flex';
		body.style.flexDirection = 'column';
		body.style.gap = '10px';

		const row1 = append(body, $(".config-row"));
		row1.style.display = 'flex';
		row1.style.alignItems = 'center';
		row1.style.justifyContent = 'space-between';
		append(row1, $("span.config-row-label", undefined, '启用知识库'));
		const toggle1 = append(row1, $("div.toggle-switch.on"));
		this._register(
			addDisposableListener(toggle1, EventType.CLICK, (e) => {
				e.stopPropagation();
				toggle1.classList.toggle('on');
			}),
		);

		const row2 = append(body, $(".config-row"));
		row2.style.display = 'flex';
		row2.style.alignItems = 'center';
		row2.style.justifyContent = 'space-between';
		append(row2, $("span.config-row-label", undefined, '检索策略'));
		const select = append(row2, $("select.config-select")) as HTMLSelectElement;
		for (const opt of ['hybrid（混合）', 'vector（向量）', 'keyword（关键词）']) {
			const o = document.createElement('option');
			o.textContent = opt;
			select.appendChild(o);
		}
	}

	private _renderSettingsRulesTab(container: HTMLElement): void {
		const desc = append(container, $(".chat-settings-tab-desc"));
		desc.textContent = 'Agent 行为规则和约束';

		const list = append(container, $(".chat-settings-rules-list"));
		const rules = [
			{ icon: '🔒', name: '安全规则', desc: '禁止执行危险命令（rm -rf 等）' },
			{ icon: '📝', name: '代码审查规则', desc: '修改前先阅读文件，修改后检查 lint' },
			{ icon: '🎯', name: '任务完成规则', desc: '完成后验证编译并总结改动' },
		];
		for (const rule of rules) {
			const card = append(list, $(".chat-settings-rule-card"));
			append(card, $("span.rule-icon", undefined, rule.icon));
			const content = append(card, $(".rule-content"));
			append(content, $("div.rule-name", undefined, rule.name));
			append(content, $("div.rule-desc", undefined, rule.desc));
			const toggle = append(card, $("div.toggle-switch.on"));
			this._register(
				addDisposableListener(toggle, EventType.CLICK, (e) => {
					e.stopPropagation();
					toggle.classList.toggle('on');
				}),
			);
		}
	}

	// =========================================================
	// Message-nav overlay (right-side panel, unified with history)
	// =========================================================

	private _renderMsgNavOverlay(): void {
		this._msgNavOverlayEl = append(this._container, $(".chat-msg-nav-overlay"));
		this._renderMsgNavOverlayContent();
	}

	private _renderMsgNavOverlayContent(): void {
		if (!this._msgNavOverlayEl) { return; }
		clearNode(this._msgNavOverlayEl);

		// Header (title + close button)
		const header = append(this._msgNavOverlayEl, $(".chat-msg-nav-header"));
		const titleLeft = append(header, $(".chat-msg-nav-title-left"));
		const listIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		listIcon.setAttribute('width', '16');
		listIcon.setAttribute('height', '16');
		listIcon.setAttribute('viewBox', '0 0 20 20');
		listIcon.setAttribute('fill', 'none');
		listIcon.setAttribute('stroke', 'currentColor');
		listIcon.setAttribute('stroke-width', '1.6');
		const li1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		li1.setAttribute('d', 'M3 5h14M3 10h14M3 15h14');
		li1.setAttribute('stroke-linecap', 'round');
		listIcon.appendChild(li1);
		titleLeft.appendChild(listIcon);
		append(titleLeft, $("span.chat-msg-nav-title", undefined, '会话消息'));

		// Close button (right-aligned)
		const closeBtn = append(header, $("button.chat-msg-nav-close-btn"));
		closeBtn.title = '关闭';
		const closeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		closeSvg.setAttribute('width', '16');
		closeSvg.setAttribute('height', '16');
		closeSvg.setAttribute('viewBox', '0 0 24 24');
		closeSvg.setAttribute('fill', 'none');
		closeSvg.setAttribute('stroke', 'currentColor');
		closeSvg.setAttribute('stroke-width', '2');
		closeSvg.setAttribute('stroke-linecap', 'round');
		closeSvg.setAttribute('stroke-linejoin', 'round');
		const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		closePath.setAttribute('d', 'M18 6L6 18M6 6l12 12');
		closeSvg.appendChild(closePath);
		closeBtn.appendChild(closeSvg);
		this._register(
			addDisposableListener(closeBtn, EventType.CLICK, () => {
				this._activeHeaderPanel = null;
				this._render();
			}),
		);

		// Search box
		const searchWrap = append(this._msgNavOverlayEl, $(".chat-msg-nav-search"));
		const searchInput = append(searchWrap, $("input.chat-msg-nav-search-input", { type: 'text', placeholder: '搜索消息...' })) as HTMLInputElement;

		// Message list (grouped by date)
		const listEl = append(this._msgNavOverlayEl, $(".chat-msg-nav-list"));

		if (this._messages.length === 0) {
			append(listEl, $(".chat-msg-nav-empty", undefined, '当前对话还没有消息'));
		} else {
			this._renderMsgNavItems(listEl, searchInput);
		}

		// Footer (message count)
		const footer = append(this._msgNavOverlayEl, $(".chat-msg-nav-footer"));
		footer.textContent = `共 ${this._messages.length} 条消息`;

		// Search filter
		this._register(
			addDisposableListener(searchInput, EventType.INPUT, () => {
				this._renderMsgNavItems(listEl, searchInput);
			}),
		);
	}

	private _renderMsgNavItems(listEl: HTMLElement, searchInput: HTMLInputElement): void {
		clearNode(listEl);
		const query = (searchInput.value || '').toLowerCase();

		// Group messages by date
		const groups = this._groupMessagesByDate();

		for (const group of groups) {
			if (group.msgs.length === 0) { continue; }

			// Date divider
			const divider = append(listEl, $(".chat-msg-nav-date-divider"));
			divider.textContent = group.label;

			for (const m of group.msgs) {
				const summary = this._getMessageSummary(m);
				if (query && !summary.toLowerCase().includes(query)) { continue; }

				const item = append(listEl, $(".chat-msg-nav-item"));

				// Role dot
				const dot = append(item, $("span.chat-msg-nav-role-dot", { 'data-role': m.role }));
				dot.title = m.role === 'user' ? '你' : m.role === 'assistant' ? '助手' : m.role === 'system' ? '系统' : '工具';

				// Content
				const content = append(item, $(".chat-msg-nav-item-content"));
				const text = append(content, $("span.chat-msg-nav-item-text"));
				text.textContent = summary;
				const time = append(content, $("span.chat-msg-nav-item-time"));
				time.textContent = this._formatMsgTime(m.timestamp);

				this._register(
					addDisposableListener(item, EventType.CLICK, () => {
						this._activeHeaderPanel = null;
						this._render();
						this._scrollToMessage(m.id);
						this._onScrollToMessage?.(m.id);
					}),
				);
			}
		}
	}

	private _groupMessagesByDate(): { label: string; msgs: IAgentChatMessage[] }[] {
		const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
		const yesterdayStart = new Date(todayStart.getTime() - 86400000);
		const weekStart = new Date(todayStart.getTime() - 7 * 86400000);

		const groups: { label: string; msgs: IAgentChatMessage[]; order: number }[] = [
			{ label: '今天', msgs: [], order: 0 },
			{ label: '昨天', msgs: [], order: 1 },
			{ label: '本周更早', msgs: [], order: 2 },
			{ label: '更早', msgs: [], order: 3 },
		];

		for (const m of this._messages) {
			const t = m.timestamp ? new Date(m.timestamp).getTime() : 0;
			if (t >= todayStart.getTime()) {
				groups[0].msgs.push(m);
			} else if (t >= yesterdayStart.getTime()) {
				groups[1].msgs.push(m);
			} else if (t >= weekStart.getTime()) {
				groups[2].msgs.push(m);
			} else {
				groups[3].msgs.push(m);
			}
		}

		return groups.filter(g => g.msgs.length > 0).map(({ label, msgs }) => ({ label, msgs: msgs.reverse() }));
	}

	private _getMessageSummary(m: IAgentChatMessage): string {
		const roleLabel = m.role === 'user' ? '你' : m.role === 'assistant' ? '助手' : m.role === 'system' ? '系统' : '工具';
		let content = '';
		if (m.content) {
			content = (m.content || '').replace(/\n/g, ' ').trim();
		} else if (m.toolCalls && m.toolCalls.length > 0) {
			const tc = m.toolCalls[0];
			content = `${tc.name} · ${tc.args || ''}`.slice(0, 60);
		}
		const summary = content.slice(0, 50) + (content.length > 50 ? '…' : '');
		return `${roleLabel}：${summary}`;
	}

	private _formatMsgTime(timestamp: number | undefined): string {
		if (!timestamp) { return ''; }
		try {
			const d = new Date(timestamp);
			const now = new Date();
			const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
			const diffDays = Math.round((todayStart.getTime() - msgDate.getTime()) / 86400000);

			const hh = d.getHours().toString().padStart(2, '0');
			const mm = d.getMinutes().toString().padStart(2, '0');

			if (diffDays === 0) {
				// Within 5 minutes: "刚刚"
				const diffMin = Math.round((now.getTime() - d.getTime()) / 60000);
				if (diffMin <= 1) { return '刚刚'; }
				if (diffMin <= 60) { return `${diffMin}分钟前`; }
				return `${hh}:${mm}`;
			} else if (diffDays === 1) {
				return `昨天 ${hh}:${mm}`;
			} else if (diffDays <= 7) {
				return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
			} else {
				return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
			}
		} catch {
			return '';
		}
	}

	/**
	 * 滚动到指定消息（匹配 React handleScrollToMessage），居中显示 + 暂停自动滚动 + 高亮闪烁
	 * 如果目标消息尚未渲染（懒加载范围），先强制渲染全部消息再跳转。
	 */
	private _scrollToMessage(messageId: string): void {
		if (!this._messagesContainer) { return; }
		let el = this._messagesContainer.querySelector(`[data-msg-id="${messageId}"]`) as HTMLElement | null;

		if (!el) {
			// 目标消息不在 DOM 中——可能在懒加载未渲染范围内。
			// 强制渲染全部消息后重试。
			this._forceRenderAllMessages();
			el = this._messagesContainer.querySelector(`[data-msg-id="${messageId}"]`) as HTMLElement | null;
			if (!el) { return; } // 仍然找不到——消息不存在
		}

		el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		// 不再自动跟随：滚动到历史消息意味着用户正在查看历史
		this._isAtBottom = false;
		// 更新按钮状态（内联 80px 阈值检查）
		const dist = this._messagesContainer.scrollHeight - this._messagesContainer.scrollTop - this._messagesContainer.clientHeight;
		const show = dist >= 80;
		this._showScrollBtn = show;
		if (this._scrollToBottomBtn) { this._scrollToBottomBtn.style.display = show ? "flex" : "none"; }
		// 高亮闪烁效果
		el.classList.add('chat-message-flash');
		mainWindow.setTimeout(() => el.classList.remove('chat-message-flash'), 1200);
		// 跳转后刷新标记位置
		this._refreshScrollMarkers();
	}

	/**
	 * 强制渲染所有未渲染的消息（懒加载场景下点击标记跳转时使用）。
	 * 找到第一个已渲染的消息，将其之前的所有消息一次性插入 DOM，
	 * 然后断开懒加载 observer（全部已渲染，不再需要懒加载）。
	 */
	private _forceRenderAllMessages(): void {
		if (!this._messagesContainer) { return; }
		const firstRendered = this._messagesContainer.firstElementChild as HTMLElement | null;
		if (!firstRendered) { return; }

		const firstRenderedId = firstRendered.getAttribute('data-msg-id');
		if (!firstRenderedId) { return; }
		const firstRenderedIdx = this._messages.findIndex(m => m.id === firstRenderedId);
		if (firstRenderedIdx <= 0) { return; } // 所有消息已渲染

		// 一次性插入所有未渲染的消息
		const frag = document.createDocumentFragment();
		for (let i = 0; i < firstRenderedIdx; i++) {
			const el = this._createMessageElement(this._messages[i]);
			frag.appendChild(el);
		}
		// 保持滚动位置
		const prevScrollHeight = this._messagesContainer.scrollHeight;
		const prevScrollTop = this._messagesContainer.scrollTop;
		firstRendered.parentNode?.insertBefore(frag, firstRendered);
		const scrollDiff = this._messagesContainer.scrollHeight - prevScrollHeight;
		if (scrollDiff > 0) {
			this._messagesContainer.scrollTop = prevScrollTop + scrollDiff;
		}

		// 全部消息已渲染——断开懒加载 observer
		if (this._lazyLoadObserver) {
			this._lazyLoadObserver.disconnect();
			this._lazyLoadObserver = null;
		}
	}

	// =========================================================
	// Mode dropdown (composer)
	// =========================================================

	private _openModeDropdown(customTrigger?: HTMLElement | null): void {
		this._closeAllDropdowns();
		this._modeDropdownTrigger = customTrigger ?? this._modeTrigger;
		if (this._modeDropdownTrigger) { this._modeDropdownTrigger.classList.add('open'); }

		this._modeDropdownEl = append(mainWindow.document.body, $(".mode-dropdown-composer"));
		this._positionDropdownAbove(this._modeDropdownEl, this._modeDropdownTrigger);

		// — Disable plan mode for non-planner agents (mirrors webview behaviour)
		const isPlanner = this._agent?.agentType === 'planner';

		for (const opt of MODE_OPTIONS) {
			const isDisabled = opt.id === 'plan' && !isPlanner;
			const item = append(this._modeDropdownEl, $(`.mode-item${this._chatMode === opt.id ? '.active' : ''}${isDisabled ? '.disabled' : ''}`));

			// icon
			const ic = append(item, $(".mode-item-icon"));
			const sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			sv.setAttribute('width', '14');
			sv.setAttribute('height', '14');
			sv.setAttribute('viewBox', '0 0 24 24');
			sv.setAttribute('fill', 'none');
			sv.setAttribute('stroke', 'currentColor');
			sv.setAttribute('stroke-width', '2');
			sv.setAttribute('stroke-linecap', 'round');
			sv.setAttribute('stroke-linejoin', 'round');
			const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			p.setAttribute('d', opt.icon);
			sv.appendChild(p);
			ic.appendChild(sv);

			// label + description
			const text = append(item, $(".mode-item-text"));
			append(text, $("span.mode-item-label", undefined, opt.label));
			append(text, $("span.mode-item-tooltip", undefined, opt.description));

			if (!isDisabled) {
				this._register(
					addDisposableListener(item, EventType.CLICK, () => {
						this._closeModeDropdown();
						if (opt.id !== this._chatMode) {
							this._chatMode = opt.id;
							this._onChangeMode?.(opt.id);
							// 轻量刷新输入区域（保存/恢复输入框内容），避免 _render() 全量重建清空输入框
							this._refreshInputArea();
						}
					}),
				);
			}
		}

		this._disposeOutsideClick(this._modeDropdownOutsideClick);
		this._modeDropdownOutsideClick = this._registerOutsideClickClose(this._modeDropdownEl, this._modeDropdownTrigger, () => this._closeModeDropdown());
	}

	private _closeModeDropdown(): void {
		this._disposeOutsideClick(this._modeDropdownOutsideClick);
		this._modeDropdownOutsideClick = null;
		if (this._modeDropdownEl) {
			this._modeDropdownEl.remove();
			this._modeDropdownEl = null;
		}
		if (this._modeDropdownTrigger) { this._modeDropdownTrigger.classList.remove('open'); }
		this._modeDropdownTrigger = null;
	}

	// =========================================================
	// Provider dropdown (composer)
	// =========================================================

	private _openProviderDropdown(customTrigger?: HTMLElement | null): void {
		this._closeAllDropdowns();
		this._providerDropdownTrigger = customTrigger ?? this._providerTrigger;
		if (this._providerDropdownTrigger) { this._providerDropdownTrigger.classList.add('open'); }

		this._providerDropdownEl = append(mainWindow.document.body, $(".provider-dropdown"));
		this._positionDropdownAbove(this._providerDropdownEl, this._providerDropdownTrigger);

		if (this._providers.length === 0) {
			append(this._providerDropdownEl, $(".provider-dropdown-empty", undefined, '暂无可用 Provider'));
		} else {
			for (const p of this._providers) {
				const item = append(this._providerDropdownEl, $(`.provider-dropdown-item${this._currentProvider === p.id ? '.active' : ''}`));
				append(item, $("span.provider-dropdown-name", undefined, p.label));
				this._register(
					addDisposableListener(item, EventType.CLICK, () => {
						this._closeProviderDropdown();
						if (p.id !== this._currentProvider) {
							this._currentProvider = p.id;
							this._onSelectProvider?.(p.id);
							// 轻量刷新输入区域（保存/恢复输入框内容），避免 _render() 全量重建清空输入框
							this._refreshInputArea();
						}
					}),
				);
			}
		}

		this._disposeOutsideClick(this._providerDropdownOutsideClick);
		this._providerDropdownOutsideClick = this._registerOutsideClickClose(this._providerDropdownEl, this._providerDropdownTrigger, () => this._closeProviderDropdown());
	}

	private _closeProviderDropdown(): void {
		this._disposeOutsideClick(this._providerDropdownOutsideClick);
		this._providerDropdownOutsideClick = null;
		if (this._providerDropdownEl) {
			this._providerDropdownEl.remove();
			this._providerDropdownEl = null;
		}
		if (this._providerDropdownTrigger) { this._providerDropdownTrigger.classList.remove('open'); }
		this._providerDropdownTrigger = null;
	}

	// =========================================================
	// Model dropdown (composer)
	// =========================================================

	private _openModelDropdown(customTrigger?: HTMLElement | null): void {
		this._closeAllDropdowns();
		this._modelDropdownTrigger = customTrigger ?? this._modelTrigger;
		if (this._modelDropdownTrigger) { this._modelDropdownTrigger.classList.add('open'); }

		this._modelDropdownEl = append(mainWindow.document.body, $(".provider-dropdown.model-dropdown"));
		this._positionDropdownAbove(this._modelDropdownEl, this._modelDropdownTrigger);

		// Filter models by current provider when set
		const filtered = this._currentProvider
			? this._models.filter(m => !m.provider || m.provider === this._currentProvider)
			: this._models;

		if (filtered.length === 0) {
			append(this._modelDropdownEl, $(".provider-dropdown-empty", undefined, '暂无可用模型'));
		} else {
			for (const m of filtered) {
				const item = append(this._modelDropdownEl, $(`.provider-dropdown-item${this._currentModel === m.id ? '.active' : ''}`));
				append(item, $("span.provider-dropdown-name", undefined, m.label));
				if (m.provider) {
					append(item, $("span.provider-dropdown-detail", undefined, m.provider));
				}
				this._register(
					addDisposableListener(item, EventType.CLICK, () => {
						this._closeModelDropdown();
						if (m.id !== this._currentModel) {
							this._currentModel = m.id;
							this._onSelectModel?.(m.id);
							// 轻量刷新输入区域（保存/恢复输入框内容），避免 _render() 全量重建清空输入框
							this._refreshInputArea();
						}
					})
				);
			}
		}

		this._disposeOutsideClick(this._modelDropdownOutsideClick);
		this._modelDropdownOutsideClick = this._registerOutsideClickClose(this._modelDropdownEl, this._modelDropdownTrigger, () => this._closeModelDropdown());
	}

	private _closeModelDropdown(): void {
		this._disposeOutsideClick(this._modelDropdownOutsideClick);
		this._modelDropdownOutsideClick = null;
		if (this._modelDropdownEl) {
			this._modelDropdownEl.remove();
			this._modelDropdownEl = null;
		}
		if (this._modelDropdownTrigger) { this._modelDropdownTrigger.classList.remove('open'); }
		this._modelDropdownTrigger = null;
	}

	// =========================================================
	// History overlay
	// =========================================================

	private _renderHistoryOverlay(): void {
		this._historyOverlayEl = renderHistoryOverlay(
			this._container,
			{ agentSessions: this._agentSessions },
			{
				onRenameSession: this._onRenameSession,
				onDeleteSession: this._onDeleteSession,
				onForkSession: this._onForkSession,
				onOpenSession: this._onOpenSession,
				onNewSession: this._onNewSession,
				onClose: () => { this._activeHeaderPanel = null; this._render(); },
			},
			(d) => this._register(d),
		);
	}

	// =========================================================
	// Dropdown helpers (delegated to modules/dropdownHelpers.ts)
	// =========================================================

	private _positionDropdownAbove(el: HTMLElement, trigger: HTMLElement | null): void {
		positionDropdownAbove(el, trigger);
	}
	private _disposeOutsideClick(d: IDisposable | null): void {
		disposeOutsideClick(d);
	}
	private _registerOutsideClickClose(panel: HTMLElement, trigger: HTMLElement | null, onClose: () => void): IDisposable {
		return registerOutsideClickClose(panel, trigger, onClose, (d) => this._register(d));
	}

	// Actions

	private _handleSendMessage(): void {
		// 从 contentEditable 中提取纯文本（排除内联芯片元素）
		const text = this._getComposerText().trim();
		const hasAttachments = this._attachments.length > 0;
		if (!text && !hasAttachments) {
			return;
		}

		// LLM 正在输出中 → 消息入队（排队等待执行）
		if (this._isSending) {
			const queueId = `queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			this._tabbedPanel.add({
				id: queueId,
				content: text || (hasAttachments ? `[${this._attachments.length} 个附件]` : ''),
				timestamp: Date.now(),
				status: 'pending',
			});

			// 清空输入框（保持当前高度不变，避免排队时输入框塌缩）
			const savedHeight = this._textarea.style.height;
			this._setComposerText('');
			this._textarea.style.height = savedHeight || 'auto';
			this._skillChips = [];
			this._renderSkillChips();
			this._attachments = [];
			this._updateSendButton();
			return;
		}

		// Get explicit skill IDs from skill chips
		const explicitSkillIds = this._skillChips.length > 0 ? this._skillChips.map(c => c.id) : undefined;

		// Snapshot attachments before clearing
		const attachments = this._attachments.length > 0 ? this._attachments.slice() : undefined;

		// Clear composer content and skill chips
		this._setComposerText('');
		this._textarea.style.height = "auto";
		const maxAllowed = 320;
		const newHeight = this._userHasAdjustedHeight
			? Math.min(Math.max(this._textarea.scrollHeight, this._resizeMaxH), maxAllowed)
			: Math.min(this._textarea.scrollHeight, this._resizeMaxH);
		this._textarea.style.height = newHeight + 'px';
		this._skillChips = [];
		this._renderSkillChips();

		// Clear attachments (inline chips already cleared by _setComposerText)
		this._attachments = [];

		// Send message with skill IDs + attachments
		this._onSendMessage(text || '', explicitSkillIds, attachments);
	}

	// ─── Orchestration Plan Dialog ─────────────────────────────────────

	public closeOrchestrationPlanDialog(): void {
		if (this._orchestrationPlanEl) {
			this._orchestrationPlanEl.remove();
			this._orchestrationPlanEl = null;
		}
		this._isPlanDialogOpen = false;
		this._activePlan = null;
	}

	public showOrchestrationPlanDialog(plan: OrchestrationPlan): void {
		// If dialog is already open for the same plan, just update it
		if (this._isPlanDialogOpen && this._activePlan?.id === plan.id) {
			// Close existing dialog and reopen with new data
			this.closeOrchestrationPlanDialog();
		}

		this._activePlan = plan;
		this._isPlanDialogOpen = true;

		// Remove existing dialog if any
		if (this._orchestrationPlanEl) {
			this._orchestrationPlanEl.remove();
		}

		// Create dialog overlay
		const overlay = document.createElement('div');
		overlay.className = 'orch-plan-overlay';

		// Create dialog content
		const dialog = document.createElement('div');
		dialog.className = 'orch-plan-dialog';

		// ─── Dialog Header ─────────────────────────────────────────────
		const header = document.createElement('div');
		header.className = 'orch-dialog-header';

		const title = document.createElement('h3');
		title.textContent = '任务编排';
		header.appendChild(title);

		// Plan status badge
		const statusConfig: Record<string, { label: string; color: string }> = {
			pending_approval: { label: '等待确认', color: '#f59e0b' },
			approved: { label: '已批准', color: '#3b82f6' },
			executing: { label: '执行中', color: '#3b82f6' },
			completed: { label: '已完成', color: '#10b981' },
			rejected: { label: '已拒绝', color: '#6b7280' },
			error: { label: '执行错误', color: '#ef4444' },
		};
		const planStatus = statusConfig[plan.status] || { label: plan.status, color: '#6b7280' };
		const statusBadge = document.createElement('span');
		statusBadge.className = 'orch-plan-status-badge';
		statusBadge.style.backgroundColor = planStatus.color + '20';
		statusBadge.style.color = planStatus.color;
		statusBadge.textContent = planStatus.label;
		header.appendChild(statusBadge);

		// Close button
		const closeBtn = document.createElement('button');
		closeBtn.className = 'orch-inline-close';
		closeBtn.textContent = '✕';
		closeBtn.onclick = () => {
			overlay.remove();
			this._isPlanDialogOpen = false;
			this._activePlan = null;
			this._onClosePlanDialog?.(plan.id);
		};
		header.appendChild(closeBtn);
		dialog.appendChild(header);

		// ─── Plan Summary ──────────────────────────────────────────────
		const summary = document.createElement('div');
		summary.className = 'orch-plan-summary';

		// Goal
		const goalDiv = document.createElement('div');
		goalDiv.className = 'orch-plan-goal';
		goalDiv.style.display = 'flex';
		goalDiv.style.alignItems = 'center';
		goalDiv.style.gap = '8px';
		const goalText = document.createElement('span');
		append(goalText, $('strong', undefined, '目标:'));
		goalText.append(` ${plan.goal}`);
		goalDiv.appendChild(goalText);
		// Edit goal button (only for pending_approval plans)
		if (plan.status === 'pending_approval') {
			const editGoalBtn = document.createElement('button');
			editGoalBtn.textContent = '✏️';
			editGoalBtn.title = '编辑目标';
			editGoalBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:14px;';
			editGoalBtn.onclick = () => this._showEditGoalForm(plan);
			goalDiv.appendChild(editGoalBtn);
		}
		summary.appendChild(goalDiv);

		// Description
		if (plan.summary) {
			const descDiv = document.createElement('div');
			descDiv.className = 'orch-plan-desc';
			descDiv.textContent = plan.summary;
			summary.appendChild(descDiv);
		}

		// Stats
		const statsDiv = document.createElement('div');
		statsDiv.className = 'orch-plan-stats';
		const totalTasks = plan.tasks.length;
		const doneTasks = plan.tasks.filter(t => t.status === 'done').length;
		const runningTasks = plan.tasks.filter(t => t.status === 'running').length;
		const pendingTasks = plan.tasks.filter(t => t.status === 'pending').length;
		append(statsDiv, $('span.orch-stat', undefined, `📋 ${totalTasks} 任务`));
		if (runningTasks > 0) {
			statsDiv.append(' ');
			append(statsDiv, $('span.orch-stat', undefined, `⚡ ${runningTasks} 执行中`));
		}
		if (doneTasks > 0) {
			statsDiv.append(' ');
			append(statsDiv, $('span.orch-stat', undefined, `✅ ${doneTasks} 完成`));
		}
		if (pendingTasks > 0) {
			statsDiv.append(' ');
			append(statsDiv, $('span.orch-stat', undefined, `⏳ ${pendingTasks} 待执行`));
		}
		summary.appendChild(statsDiv);
		dialog.appendChild(summary);

		// ─── Task List ─────────────────────────────────────────────────
		const taskListContainer = document.createElement('div');
		taskListContainer.className = 'orch-task-list';

		// Task status config
		const taskStatusConfig: Record<string, { label: string; color: string; icon: string }> = {
			pending: { label: '待执行', color: '#f59e0b', icon: '⏳' },
			running: { label: '执行中', color: '#3b82f6', icon: '⚡' },
			paused: { label: '已暂停', color: '#8b5cf6', icon: '⏸' },
			done: { label: '已完成', color: '#10b981', icon: '✅' },
			cancelled: { label: '已取消', color: '#6b7280', icon: '⏹' },
			error: { label: '错误', color: '#ef4444', icon: '❌' },
		};

		// Sort tasks by depth and priority
		const sortedTasks = [...plan.tasks].sort((a, b) => a.depth - b.depth || a.priority - b.priority);

		for (const task of sortedTasks) {
			const taskEl = document.createElement('div');
			taskEl.className = 'orch-task-item';
			taskEl.style.marginLeft = `${task.depth * 24}px`;

			// Task header
			const taskHeader = document.createElement('div');
			taskHeader.className = 'orch-task-item-header';

			const statusConf = taskStatusConfig[task.status] || taskStatusConfig.pending;
			const statusIcon = document.createElement('span');
			statusIcon.className = 'orch-task-status-icon';
			statusIcon.textContent = statusConf.icon;
			statusIcon.style.color = statusConf.color;
			taskHeader.appendChild(statusIcon);

			const taskTitle = document.createElement('span');
			taskTitle.className = 'orch-task-title';
			taskTitle.textContent = task.title;
			taskHeader.appendChild(taskTitle);

			const taskStatusBadge = document.createElement('span');
			taskStatusBadge.className = 'orch-task-status-badge';
			taskStatusBadge.style.backgroundColor = statusConf.color + '20';
			taskStatusBadge.style.color = statusConf.color;
			taskStatusBadge.textContent = statusConf.label;
			taskHeader.appendChild(taskStatusBadge);

			// Edit button (only for pending_approval plans)
			if (plan.status === 'pending_approval') {
				const editBtn = document.createElement('button');
				editBtn.className = 'orch-task-header-btn';
				editBtn.textContent = '✏️';
				editBtn.title = '编辑任务';
				editBtn.onclick = () => this._showEditTaskForm(task, plan);
				taskHeader.appendChild(editBtn);

				// Decompose button
				const decomposeBtn = document.createElement('button');
				decomposeBtn.className = 'orch-task-header-btn';
				decomposeBtn.textContent = '🔀';
				decomposeBtn.title = 'AI 自动拆分任务';
				decomposeBtn.onclick = () => this._onDecomposeTask?.(plan.id, task.id);
				taskHeader.appendChild(decomposeBtn);
			}

			taskEl.appendChild(taskHeader);

			// Task description
			if (task.description && task.description !== task.title) {
				const taskDesc = document.createElement('div');
				taskDesc.className = 'orch-task-desc';
				taskDesc.textContent = task.description.length > 120 ? task.description.slice(0, 120) + '...' : task.description;
				taskEl.appendChild(taskDesc);
			}

			// Task meta
			const taskMeta = document.createElement('div');
			taskMeta.className = 'orch-task-meta';

			if (task.assigneeName) {
				const agentSpan = document.createElement('span');
				agentSpan.className = 'orch-task-agent';
				agentSpan.textContent = `${task.autoCreateAgent ? '🆕 ' : ''}${task.assigneeName}`;
				taskMeta.appendChild(agentSpan);
			}

			// Retry count
			if (task.retryCount > 0) {
				const retrySpan = document.createElement('span');
				retrySpan.className = 'orch-task-retry-badge';
				retrySpan.textContent = `🔄 ${task.retryCount}/${task.maxRetries}`;
				taskMeta.appendChild(retrySpan);
			}

			taskEl.appendChild(taskMeta);

			// Task error
			if (task.error) {
				const errorDiv = document.createElement('div');
				errorDiv.className = 'orch-task-error';
				errorDiv.textContent = `❌ ${task.error}`;
				taskEl.appendChild(errorDiv);
			}

			// Task actions (only show for executing plans)
			const isExecuting = plan.status === 'executing' || plan.status === 'approved';
			if (isExecuting) {
				const actionsDiv = document.createElement('div');
				actionsDiv.className = 'orch-task-actions';

				// Retry button (for error or cancelled tasks)
				if (task.status === 'error' || task.status === 'cancelled') {
					const retryBtn = document.createElement('button');
					retryBtn.className = 'orch-task-action-btn retry';
					retryBtn.textContent = '🔄 重做';
					retryBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'retry');
					actionsDiv.appendChild(retryBtn);
				}

				// Pause button (for running or pending tasks)
				if (task.status === 'running' || task.status === 'pending') {
					const pauseBtn = document.createElement('button');
					pauseBtn.className = 'orch-task-action-btn pause';
					pauseBtn.textContent = '⏸ 暂停';
					pauseBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'pause');
					actionsDiv.appendChild(pauseBtn);
				}

				// Resume button (for paused tasks)
				if (task.status === 'paused') {
					const resumeBtn = document.createElement('button');
					resumeBtn.className = 'orch-task-action-btn resume';
					resumeBtn.textContent = '▶ 恢复';
					resumeBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'resume');
					actionsDiv.appendChild(resumeBtn);
				}

				// Cancel button (for non-done/cancelled tasks)
				if (task.status !== 'done' && task.status !== 'cancelled') {
					const cancelBtn = document.createElement('button');
					cancelBtn.className = 'orch-task-action-btn cancel';
					cancelBtn.textContent = '✕ 取消';
					cancelBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'cancel');
					actionsDiv.appendChild(cancelBtn);
				}

				// Approve/Reject buttons (for done tasks with pending review)
				if (task.status === 'done' && task.reviewStatus === 'pending') {
					const approveBtn = document.createElement('button');
					approveBtn.className = 'orch-task-action-btn approve';
					approveBtn.textContent = '✅ 通过';
					approveBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'approve');
					actionsDiv.appendChild(approveBtn);

					const rejectBtn = document.createElement('button');
					rejectBtn.className = 'orch-task-action-btn reject';
					rejectBtn.textContent = '❌ 拒绝';
					rejectBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'reject');
					actionsDiv.appendChild(rejectBtn);
				}

				// Block/Unblock buttons
				if (!task.isBlocked && task.status !== 'done') {
					const blockBtn = document.createElement('button');
					blockBtn.className = 'orch-task-action-btn block';
					blockBtn.textContent = '🚫 阻塞';
					blockBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'block');
					actionsDiv.appendChild(blockBtn);
				}

				if (task.isBlocked) {
					const unblockBtn = document.createElement('button');
					unblockBtn.className = 'orch-task-action-btn unblock';
					unblockBtn.textContent = '🔓 解除';
					unblockBtn.onclick = () => this._onTaskAction?.(plan.id, task.id, 'unblock');
					actionsDiv.appendChild(unblockBtn);
				}

				taskEl.appendChild(actionsDiv);
			}

			taskListContainer.appendChild(taskEl);
		}

		dialog.appendChild(taskListContainer);

		// ─── Plan Actions ──────────────────────────────────────────────
		const planActions = document.createElement('div');
		planActions.className = 'orch-plan-actions';

		const isPendingApproval = plan.status === 'pending_approval';
		const isExecutingOrApproved = plan.status === 'executing' || plan.status === 'approved';

		if (isPendingApproval) {
			// Approve button
			const approveBtn = document.createElement('button');
			approveBtn.className = 'btn-primary';
			approveBtn.textContent = '✅ 批准计划';
			approveBtn.onclick = () => {
				this._onApprovePlan?.(plan.id);
				overlay.remove();
			};
			planActions.appendChild(approveBtn);

			// Approve without execute button
			const approveWithoutExecBtn = document.createElement('button');
			approveWithoutExecBtn.className = 'btn-secondary';
			approveWithoutExecBtn.textContent = '批准但不执行';
			approveWithoutExecBtn.onclick = () => {
				this._onApproveWithoutExecute?.(plan.id);
				overlay.remove();
			};
			planActions.appendChild(approveWithoutExecBtn);

			// Reject button
			const rejectBtn = document.createElement('button');
			rejectBtn.className = 'btn-secondary';
			rejectBtn.textContent = '❌ 拒绝计划';
			rejectBtn.onclick = () => {
				this._onRejectPlan?.(plan.id);
				overlay.remove();
			};
			planActions.appendChild(rejectBtn);
		} else if (isExecutingOrApproved) {
			// Pause all button
			const pauseAllBtn = document.createElement('button');
			pauseAllBtn.className = 'btn-secondary';
			pauseAllBtn.textContent = '⏸ 暂停所有';
			pauseAllBtn.onclick = () => {
				// Pause all running tasks
				for (const task of plan.tasks) {
					if (task.status === 'running' || task.status === 'pending') {
						this._onTaskAction?.(plan.id, task.id, 'pause');
					}
				}
			};
			planActions.appendChild(pauseAllBtn);
		}

		dialog.appendChild(planActions);

		// ─── Assemble ──────────────────────────────────────────────────
		overlay.appendChild(dialog);
		document.body.appendChild(overlay);
		this._orchestrationPlanEl = overlay;
	}

	// ─── Edit Task Form ──────────────────────────────────────────────

	private _showEditTaskForm(task: PlanTask, plan: OrchestrationPlan): void {
		// Create overlay for edit form
		const overlay = document.createElement('div');
		overlay.className = 'orch-edit-overlay';
		overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10002;display:flex;align-items:center;justify-content:center;';

		// Create form dialog
		const dialog = document.createElement('div');
		dialog.className = 'orch-edit-dialog';
		dialog.style.cssText = 'background:#1e1e2e;color:#cdd6f4;padding:20px;border-radius:8px;max-width:500px;width:90%;';

		// Title
		const title = document.createElement('h4');
		title.textContent = '编辑任务';
		title.style.marginBottom = '15px';
		dialog.appendChild(title);

		// Form fields
		// Task title
		const titleLabel = document.createElement('label');
		titleLabel.textContent = '任务标题';
		titleLabel.style.display = 'block';
		titleLabel.style.marginBottom = '5px';
		dialog.appendChild(titleLabel);

		const titleInput = document.createElement('input');
		titleInput.type = 'text';
		titleInput.value = task.title;
		titleInput.style.cssText = 'width:100%;padding:8px;margin-bottom:15px;border:1px solid #333;border-radius:4px;background:#2a2a3e;color:#cdd6f4;';
		dialog.appendChild(titleInput);

		// Task description
		const descLabel = document.createElement('label');
		descLabel.textContent = '任务描述';
		descLabel.style.display = 'block';
		descLabel.style.marginBottom = '5px';
		dialog.appendChild(descLabel);

		const descTextarea = document.createElement('textarea');
		descTextarea.value = task.description || '';
		descTextarea.rows = 3;
		descTextarea.style.cssText = 'width:100%;padding:8px;margin-bottom:15px;border:1px solid #333;border-radius:4px;background:#2a2a3e;color:#cdd6f4;';
		dialog.appendChild(descTextarea);

		// Priority
		const priorityLabel = document.createElement('label');
		priorityLabel.textContent = '优先级';
		priorityLabel.style.display = 'block';
		priorityLabel.style.marginBottom = '5px';
		dialog.appendChild(priorityLabel);

		const prioritySelect = document.createElement('select');
		prioritySelect.style.cssText = 'width:100%;padding:8px;margin-bottom:15px;border:1px solid #333;border-radius:4px;background:#2a2a3e;color:#cdd6f4;';
		for (let i = 1; i <= 5; i++) {
			const option = document.createElement('option');
			option.value = i.toString();
			option.textContent = `${i} - ${i === 1 ? '最高' : i === 2 ? '高' : i === 3 ? '中' : i === 4 ? '低' : '最低'}`;
			if (i === task.priority) {
				option.selected = true;
			}
			prioritySelect.appendChild(option);
		}
		dialog.appendChild(prioritySelect);

		// Action buttons
		const actions = document.createElement('div');
		actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';

		const cancelBtn = document.createElement('button');
		cancelBtn.textContent = '取消';
		cancelBtn.style.cssText = 'padding:8px 16px;background:transparent;border:1px solid #333;border-radius:4px;color:#cdd6f4;cursor:pointer;';
		cancelBtn.onclick = () => overlay.remove();
		actions.appendChild(cancelBtn);

		const saveBtn = document.createElement('button');
		saveBtn.textContent = '保存';
		saveBtn.style.cssText = 'padding:8px 16px;background:#10b981;border:none;border-radius:4px;color:white;cursor:pointer;';
		saveBtn.onclick = () => {
			const updates: Record<string, unknown> = {
				title: titleInput.value,
				description: descTextarea.value,
				priority: parseInt(prioritySelect.value, 10),
			};
			this._onUpdateTask?.(plan.id, task.id, updates);
			overlay.remove();
			// Refresh the plan dialog
			this.showOrchestrationPlanDialog(plan);
		};
		actions.appendChild(saveBtn);

		dialog.appendChild(actions);

		overlay.appendChild(dialog);
		document.body.appendChild(overlay);
	}

	// ─── Edit Goal Form ──────────────────────────────────────────

	private _showEditGoalForm(plan: OrchestrationPlan): void {
		// Create overlay for edit form
		const overlay = document.createElement('div');
		overlay.className = 'orch-edit-overlay';
		overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10002;display:flex;align-items:center;justify-content:center;';

		// Create form dialog
		const dialog = document.createElement('div');
		dialog.className = 'orch-edit-dialog';
		dialog.style.cssText = 'background:#1e1e2e;color:#cdd6f4;padding:20px;border-radius:8px;max-width:500px;width:90%;';

		// Title
		const title = document.createElement('h4');
		title.textContent = '编辑计划目标';
		title.style.marginBottom = '15px';
		dialog.appendChild(title);

		// Goal textarea
		const goalTextarea = document.createElement('textarea');
		goalTextarea.value = plan.goal;
		goalTextarea.rows = 3;
		goalTextarea.style.cssText = 'width:100%;padding:8px;margin-bottom:15px;border:1px solid #333;border-radius:4px;background:#2a2a3e;color:#cdd6f4;';
		dialog.appendChild(goalTextarea);

		// Action buttons
		const actions = document.createElement('div');
		actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';

		const cancelBtn = document.createElement('button');
		cancelBtn.textContent = '取消';
		cancelBtn.style.cssText = 'padding:8px 16px;background:transparent;border:1px solid #333;border-radius:4px;color:#cdd6f4;cursor:pointer;';
		cancelBtn.onclick = () => overlay.remove();
		actions.appendChild(cancelBtn);

		const saveBtn = document.createElement('button');
		saveBtn.textContent = '保存';
		saveBtn.style.cssText = 'padding:8px 16px;background:#10b981;border:none;border-radius:4px;color:white;cursor:pointer;';
		saveBtn.onclick = () => {
			const updates: Record<string, unknown> = {
				goal: goalTextarea.value,
			};
			if (this._onUpdatePlan) { this._onUpdatePlan(plan.id, updates); }
			overlay.remove();
			// Refresh the plan dialog
			this.showOrchestrationPlanDialog(plan);
		};
		actions.appendChild(saveBtn);

		dialog.appendChild(actions);

		overlay.appendChild(dialog);
		document.body.appendChild(overlay);
	}


	// ─── Scroll ──────────────────────────────────────────────────────

	/**
	 * 流式期间启动 rAF 循环，持续将 scrollTop 钉在底部。
	 *
	 * 根因：VS Code 的 renderMarkdown 对代码块走 codeBlockRenderer → Promise.resolve(wrapper)，
	 * 代码块在微任务中异步插入 DOM。_scrollToBottom 在 _renderMarkdownContent 之后同步执行，
	 * 此时 scrollHeight 尚未包含代码块高度 → 滚动位置偏低 → 代码块插入后视图脱离底部。
	 * rAF 在微任务之后、绘制之前运行，可追平异步插入的内容。
	 *
	 * 自愈设计：循环在 _isSending=true 期间始终存活，仅在 _isAtBottom=true 时执行钉底。
	 * 这样即使用户（或触控板惯性误触）短暂将 _isAtBottom 置为 false，循环也不会死亡——
	 * 当 SCROLL/WHEEL 处理器将 _isAtBottom 恢复为 true 时，循环自动恢复钉底，
	 * 无需显式重启。之前的实现一旦 _isAtBottom=false 就停止循环且永不重启，
	 * 导致流式过程中滚动条"突然不动"。
	 */
	private _startStreamScroll(): void {
		if (this._streamScrollRaf !== null) { return; }
		const diagStack = new Error().stack?.split('\n').slice(2, 5).map(s => s.trim()).join(' ← ') || '?';
		console.debug(`[ScrollDiag] _startStreamScroll START caller: ${diagStack}`);
		const tick = () => {
			this._streamScrollRaf = null;
			// 流式结束 → 停止循环（唯一合法的停止条件）
			if (!this._isSending || !this._messagesContainer) {
				return;
			}
			// 用户滚离底部 → 跳过钉底但保持循环存活，等待 _isAtBottom 恢复
			// 用户正在拖拽滚动条 → 暂停钉底，避免互相冲突
			if (this._isAtBottom && !this._isDraggingScrollbar) {
				this._messagesContainer.scrollTop = this._messagesContainer.scrollHeight;
			}
			this._streamScrollRaf = requestAnimationFrame(tick);
		};
		this._streamScrollRaf = requestAnimationFrame(tick);
	}

	private _stopStreamScroll(): void {
		if (this._streamScrollRaf !== null) {
			cancelAnimationFrame(this._streamScrollRaf);
			this._streamScrollRaf = null;
			const diagStack = new Error().stack?.split('\n').slice(2, 5).map(s => s.trim()).join(' ← ') || '?';
			console.debug(`[ScrollDiag] _stopStreamScroll STOP caller: ${diagStack}`);
		}
	}

	/**
	 * P0: rAF 批量滚动调度——避免 updateMessage 中每个 delta 同步强制回流。
	 * 同帧多次调用只滚一次。流式期间 _startStreamScroll rAF 循环已持续钉底，
	 * 此调度不生效（避免重复）。
	 */
	private _scheduleScrollToBottom(): void {
		// 流式期间 _startStreamScroll rAF 循环持续钉底，不需要额外调度
		if (this._isSending) { return; }

		this._pendingScrollToBottom = true;
		if (this._pendingScrollToBottomRaf === null) {
			this._pendingScrollToBottomRaf = requestAnimationFrame(() => {
				this._pendingScrollToBottomRaf = null;
				if (this._pendingScrollToBottom) {
					this._pendingScrollToBottom = false;
					this._scrollToBottom(false);
				}
			});
		}
	}

	// ─── Custom Scrollbar Overlay ──────────────────────────────────

	/**
	 * rAF 节流调度滚动条更新——scroll 事件高频触发，合并为每帧一次。
	 */
	private _scheduleScrollbarUpdate(): void {
		if (this._scrollbarUpdateRaf !== null) { return; }
		this._scrollbarUpdateRaf = requestAnimationFrame(() => {
			this._scrollbarUpdateRaf = null;
			this._updateScrollbarThumb();
		});
	}

	/**
	 * 更新自定义滚动条 thumb 位置/大小 + 标记位置。
	 * Thumb 随 scrollTop 同步移动；标记位置固定（对应用户消息在内容中的绝对位置）。
	 * 内容不足滚动时隐藏整个覆盖层。
	 */
	private _updateScrollbarThumb(): void {
		if (!this._messagesContainer || !this._customScrollbar || !this._scrollbarThumb || !this._scrollbarTrack) { return; }
		const el = this._messagesContainer;
		const ratio = el.clientHeight / el.scrollHeight;
		if (ratio >= 1) {
			// Content fits — hide scrollbar
			this._customScrollbar.style.display = 'none';
			return;
		}
		this._customScrollbar.style.display = '';
		const trackHeight = this._scrollbarTrack.offsetHeight;
		const thumbHeight = Math.max(24, trackHeight * ratio);
		const maxScroll = el.scrollHeight - el.clientHeight;
		const scrollRatio = maxScroll > 0 ? el.scrollTop / maxScroll : 0;
		const thumbTop = scrollRatio * (trackHeight - thumbHeight);
		this._scrollbarThumb.style.height = `${thumbHeight}px`;
		this._scrollbarThumb.style.top = `${thumbTop}px`;
	}

	/**
	 * 刷新用户消息标记——在消息增删后调用。
	 * 标记位置 = msgEl.offsetTop / scrollHeight * trackHeight（绝对位置，不随滚动变化）。
	 */
	private _refreshScrollMarkers(): void {
		if (!this._customScrollbar || !this._messagesContainer || !this._scrollbarTrack) { return; }
		// 移除旧标记 + 释放旧事件监听器
		this._markerDisposables.clear();
		const oldMarkers = this._customScrollbar.querySelectorAll('.chat-scroll-marker');
		oldMarkers.forEach(m => m.remove());

		const el = this._messagesContainer;
		const trackHeight = this._scrollbarTrack.offsetHeight;
		if (trackHeight <= 0 || el.scrollHeight <= 0) { return; }

		for (const msg of this._messages) {
			if (msg.role !== 'user') { continue; }
			const msgEl = el.querySelector(`[data-msg-id="${msg.id}"]`) as HTMLElement | null;
			if (!msgEl) { continue; }

			const msgRatio = msgEl.offsetTop / el.scrollHeight;
			const markerTop = msgRatio * trackHeight;

			const marker = document.createElement('div');
			marker.className = 'chat-scroll-marker';
			marker.style.top = `${markerTop}px`;

			// Hover → popup
			this._markerDisposables.add(
				addDisposableListener(marker, EventType.MOUSE_ENTER, () => {
					if (!this._scrollbarPopup || !this._scrollbarPopupPreview || !this._scrollbarTrack) { return; }
					const preview = msg.content.length > 100 ? msg.content.substring(0, 100) + '…' : msg.content;
					this._scrollbarPopupPreview.textContent = preview;
					const popupTop = Math.min(markerTop, this._scrollbarTrack.offsetHeight - 80);
					this._scrollbarPopup.style.top = `${popupTop}px`;
					this._scrollbarPopup.classList.add('visible');
				}),
			);
			this._markerDisposables.add(
				addDisposableListener(marker, EventType.MOUSE_LEAVE, () => {
					this._scrollbarPopup?.classList.remove('visible');
				}),
			);

			// Click → jump to message
			this._markerDisposables.add(
				addDisposableListener(marker, EventType.CLICK, (e: MouseEvent) => {
					e.stopPropagation();
					this._scrollToMessage(msg.id);
				}),
			);

			this._customScrollbar.appendChild(marker);
		}

		// Also update thumb (content may have changed scrollHeight)
		this._updateScrollbarThumb();
	}

	/**
	 * 更新滚动按钮上的未读消息计数 badge。
	 * count > 0 时显示数字，count = 0 时隐藏。
	 */
	private _updateScrollBadge(): void {
		if (!this._scrollBadge) { return; }
		if (this._unreadCount > 0) {
			this._scrollBadge.textContent = String(this._unreadCount > 99 ? '99+' : this._unreadCount);
			this._scrollBadge.style.display = 'flex';
		} else {
			this._scrollBadge.style.display = 'none';
		}
	}

	/**
	 * 新消息到达时脉冲提示——按钮短暂放大 + 颜色变化，吸引用户注意。
	 */
	private _pulseScrollBtn(): void {
		if (!this._scrollToBottomBtn) { return; }
		this._scrollToBottomBtn.classList.remove('pulse');
		// 强制 reflow 重启动画
		void this._scrollToBottomBtn.offsetWidth;
		this._scrollToBottomBtn.classList.add('pulse');
	}

	/**
	 * 滚动到底部（匹配 React useLayoutEffect 逻辑）
	 * - wasLoading=true（加载历史/切Agent）→ instant 即时跳转
	 * - isAtBottom=true（用户已在底部）→ smooth 平滑滚动
	 * - isAtBottom=false（用户已滚离）→ 不滚动
	 */
	private _scrollToBottom(force: boolean): void {
		if (!this._messagesContainer) { return; }
		// ── SCROLL DIAG: 记录每次滚动的调用栈 ──
		const diagStack = new Error().stack?.split('\n').slice(2, 6).map(s => s.trim()).join(' ← ') || '?';
		const prevTop = this._messagesContainer.scrollTop;
		const prevHeight = this._messagesContainer.scrollHeight;
		const wasAtBtm = (prevHeight - prevTop - this._messagesContainer.clientHeight) < 80;

		const instant = force || this._wasLoading;

		if (instant) {
			// 加载历史 / 切 Agent → 即时跳转，恢复自动跟随
			this._isAtBottom = true;
			this._wasLoading = false;
			this._showScrollBtn = false;
			if (this._scrollToBottomBtn) { this._scrollToBottomBtn.style.display = "none"; }
			this._messagesContainer.scrollTop = this._messagesContainer.scrollHeight;
			return;
		}

		// 用户不在底部 → 不自动滚动
		if (!this._isAtBottom) { return; }

		// During streaming, always use instant scroll to stay pinned to bottom.
		// Smooth scroll can't keep up with continuous content growth — it falls
		// behind, creating a growing gap that eventually triggers the 80px
		// threshold check, causing jumpy behavior.
		if (this._isSending) {
			this._messagesContainer.scrollTop = this._messagesContainer.scrollHeight;
			return;
		}

		// Non-streaming: check if user scrolled away from bottom
		const distFromBottom = this._messagesContainer.scrollHeight - this._messagesContainer.scrollTop - this._messagesContainer.clientHeight;
		// 流式刚结束时，slow-path 重建（footer/token popup）增加的高度可能
		// 超过 80px 阈值，误判为"用户滚离"。宽限期内绕过此检查。
		if (distFromBottom >= 80 && !this._streamJustEnded) {
			// User likely scrolled up → disable auto-scroll
			this._isAtBottom = false;
			this._showScrollBtn = true;
			if (this._scrollToBottomBtn) { this._scrollToBottomBtn.style.display = "flex"; }
			return;
		}

		// 正常情况 → smooth 滚动（宽限期内用 instant 追赶高度变化）
		if (this._streamJustEnded) {
			this._messagesContainer.scrollTop = this._messagesContainer.scrollHeight;
		} else {
			this._messagesContainer.scrollTo({ top: this._messagesContainer.scrollHeight, behavior: 'smooth' });
		}

		// ── SCROLL DIAG: 记录滚动效果 ──
		if (this._messagesContainer) {
			const delta = this._messagesContainer.scrollTop - prevTop;
			const hDelta = this._messagesContainer.scrollHeight - prevHeight;
			if (Math.abs(delta) > 5 || hDelta !== 0) {
				console.debug(`[ScrollDiag] _scrollToBottom force=${force} instant=${instant} prevScroll=${prevTop}→${this._messagesContainer.scrollTop} (Δ${delta}) scrollH=${prevHeight}→${this._messagesContainer.scrollHeight} (Δ${hDelta}) wasAtBtm=${wasAtBtm} isSending=${this._isSending} isAtBtm=${this._isAtBottom}\n  caller: ${diagStack}`);
			}
		}
	}

	// Layout

	layout(width: number, height: number): void {
		// The CSS flexbox handles layout automatically
	}

	// --- Attachments -------------------------------------

	private _handleFileSelection(): void {
		if (!this._fileInput?.files) { return; }
		this._addFiles(Array.from(this._fileInput.files));
		this._fileInput.value = ''; // reset so same file can be re-selected
	}

	private _addFiles(files: File[], isPasted = false): void {
		const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB per image
		const MAX_FILE_SIZE = 30 * 1024 * 1024;  // 30MB per file
		const MAX_TOTAL_SIZE = 30 * 1024 * 1024; // 30MB total

		for (const file of files) {
			const isImage = file.type.startsWith('image/');
			const maxSize = isImage ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;

			if (file.size > maxSize) {
				// eslint-disable-next-line no-console
				console.warn(`[AgentChatPanel] File too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB > ${(maxSize / 1024 / 1024).toFixed(0)}MB limit)`);
				continue;
			}

			if (isImage) {
				// Scale image before encoding
				this._resizeImage(file, 2048, 768).then(scaledDataUrl => {
					const base64 = scaledDataUrl.split(',')[1] || '';
					const att: IChatAttachment = {
						id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						type: 'image',
						name: file.name,
						mimeType: file.type || 'image/png',
						data: base64,
						size: file.size,
						isPasted,
					};
					const currentTotal = this._attachments.reduce((sum, a) => sum + a.size, 0);
					if (currentTotal + file.size > MAX_TOTAL_SIZE) { return; }
					this._attachments.push(att);
					this._renderAttachmentPreviews();
					this._insertInlineAttachmentChip(att);
				}).catch(() => { /* ignore resize failures */ });
			} else {
				const reader = new FileReader();
				reader.onload = () => {
					const dataUrl = reader.result as string;
					const base64 = dataUrl.split(',')[1] || '';
					const att: IChatAttachment = {
						id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						type: 'file',
						name: file.name,
						mimeType: file.type || 'application/octet-stream',
						data: base64,
						size: file.size,
						isPasted,
					};
					const currentTotal = this._attachments.reduce((sum, a) => sum + a.size, 0);
					if (currentTotal + file.size > MAX_TOTAL_SIZE) { return; }
					this._attachments.push(att);
					this._renderAttachmentPreviews();
					this._insertInlineAttachmentChip(att);
				};
				reader.readAsDataURL(file);
			}
		}
	}

	/** Auto-scale image to max 2048x768, return data URL */
	private _resizeImage(file: File, maxWidth: number, maxHeight: number): Promise<string> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				let { width, height } = img;
				if (width <= maxWidth && height <= maxHeight) {
					// No scaling needed, return original via FileReader
					const reader = new FileReader();
					reader.onload = () => resolve(reader.result as string);
					reader.onerror = reject;
					reader.readAsDataURL(file);
					return;
				}
				const ratio = Math.min(maxWidth / width, maxHeight / height);
				width = Math.round(width * ratio);
				height = Math.round(height * ratio);
				const canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;
				const ctx = canvas.getContext('2d');
				if (!ctx) { reject(new Error('No canvas context')); return; }
				ctx.drawImage(img, 0, 0, width, height);
				resolve(canvas.toDataURL(file.type || 'image/png', 0.85));
			};
			img.onerror = reject;
			img.src = URL.createObjectURL(file);
		});
	}

	/**
	 * 将附件以「内联芯片」形式嵌入到 contentEditable 输入框文本流中，
	 * 让文本和图片/文件在输入框内混排显示（需求：移除底部独立预览区，附件嵌入文本流）。
	 * 真实数据仍通过结构化 `attachments` 通道发送给 LLM。
	 */
	private _insertInlineAttachmentChip(att: IChatAttachment): void {
		const root = this._textarea;
		if (!root) { return; }
		const chip = this._createAttachmentChipNode(att);
		const spaceBefore = document.createTextNode(' ');
		const spaceAfter = document.createTextNode(' ');
		root.focus();
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0) {
			const range = sel.getRangeAt(0);
			range.deleteContents();
			const frag = document.createDocumentFragment();
			frag.appendChild(spaceBefore);
			frag.appendChild(chip);
			frag.appendChild(spaceAfter);
			range.insertNode(frag);
			range.setStartAfter(spaceAfter);
			range.collapse(true);
			sel.removeAllRanges();
			sel.addRange(range);
		} else {
			root.appendChild(spaceBefore);
			root.appendChild(chip);
			root.appendChild(spaceAfter);
			this._focusComposerEnd();
		}
		// 触发 input 事件以更新自动高度与发送按钮状态
		root.dispatchEvent(new Event('input'));
	}

	private _createAttachmentChipNode(att: IChatAttachment): HTMLElement {
		const chip = document.createElement('span');
		chip.className = 'inline-attachment-chip';
		chip.dataset.attId = att.id;
		chip.setAttribute('contenteditable', 'false');

		const icon = document.createElement('span');
		icon.className = 'inline-attachment-chip-icon';
		icon.textContent = att.type === 'image' ? '\u{1F4F7}' : '\u{1F4C4}';
		chip.appendChild(icon);

		const label = document.createElement('span');
		label.className = 'inline-attachment-chip-label';
		label.textContent = att.name;
		chip.appendChild(label);

		const removeBtn = document.createElement('span');
		removeBtn.className = 'inline-attachment-chip-remove';
		removeBtn.textContent = '✕';
		chip.appendChild(removeBtn);
		this._register(addDisposableListener(removeBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			e.preventDefault();
		this._attachments = this._attachments.filter(a => a.id !== att.id);
		chip.remove();
		this._hideImageTooltip();
		this._updateSendButton();
		}));

		if (att.type === 'image' && att.data) {
			this._register(addDisposableListener(chip, EventType.CLICK, (e) => {
				if ((e.target as HTMLElement).classList.contains('inline-attachment-chip-remove')) { return; }
				this._showLightbox(`data:${att.mimeType};base64,${att.data}`);
			}));
			// hover 时显示图片缩略图预览
			this._register(addDisposableListener(chip, EventType.MOUSE_ENTER, () => {
				if ((chip.querySelector('.inline-attachment-chip-remove') as HTMLElement)?.matches(':hover')) { return; }
				this._showImageTooltip(att, chip);
			}));
			this._register(addDisposableListener(chip, EventType.MOUSE_LEAVE, () => this._hideImageTooltip()));
		}
		return chip;
	}

	/**
	 * 气泡内只读附件 chip：样式与输入框 `inline-attachment-chip` 完全一致
	 * （图标 + 文件名，圆角胶囊），但不可删除（消息已发送）。
	 * 图片点击放大（lightbox + hover 缩略图预览），与输入框 chip 行为对齐。
	 */
	private _createReadOnlyAttachmentChip(att: IChatAttachment): HTMLElement {
		const chip = document.createElement('span');
		chip.className = 'inline-attachment-chip message-attachment-chip';
		chip.dataset.attId = att.id;
		chip.setAttribute('contenteditable', 'false');

		const icon = document.createElement('span');
		icon.className = 'inline-attachment-chip-icon';
		icon.textContent = att.type === 'image' ? '\u{1F4F7}' : '\u{1F4C4}';
		chip.appendChild(icon);

		const label = document.createElement('span');
		label.className = 'inline-attachment-chip-label';
		label.textContent = att.name;
		chip.appendChild(label);

		if (att.type === 'image' && att.data) {
			this._register(addDisposableListener(chip, EventType.CLICK, () => {
				this._showLightbox(`data:${att.mimeType};base64,${att.data}`);
			}));
			this._register(addDisposableListener(chip, EventType.MOUSE_ENTER, () => {
				this._showImageTooltip(att, chip);
			}));
			this._register(addDisposableListener(chip, EventType.MOUSE_LEAVE, () => this._hideImageTooltip()));
		}
		return chip;
	}

	/** 将所有附件重渲染为内联芯片（用于 _refreshInputArea 重建输入框后恢复） */
	private _renderInlineAttachmentChips(): void {
		const root = this._textarea;
		if (!root) { return; }
		for (const att of this._attachments) {
			if (root.querySelector(`.inline-attachment-chip[data-att-id="${att.id}"]`)) { continue; }
			const spaceBefore = document.createTextNode(' ');
			const spaceAfter = document.createTextNode(' ');
			root.appendChild(spaceBefore);
			root.appendChild(this._createAttachmentChipNode(att));
			root.appendChild(spaceAfter);
		}
		if (this._attachments.length) { this._focusComposerEnd(); }
	}

	// ─── contentEditable 文本辅助方法 ───────────────────────────────

	/** 提取输入框纯文本（排除内联附件芯片内容） */
	private _getComposerText(): string {
		const root = this._textarea;
		if (!root) { return ''; }
		let out = '';
		const walk = (node: Node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				out += node.textContent ?? '';
				return;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) { return; }
			const el = node as HTMLElement;
			if (el.classList.contains('inline-attachment-chip')) { return; }
			const tag = el.tagName;
			if (tag === 'BR') { out += '\n'; return; }
			if (tag === 'DIV' || tag === 'P') {
				if (out.length > 0 && !out.endsWith('\n')) { out += '\n'; }
			}
			for (const child of Array.from(el.childNodes)) { walk(child); }
			if ((tag === 'DIV' || tag === 'P') && !out.endsWith('\n')) { out += '\n'; }
		};
		for (const child of Array.from(root.childNodes)) { walk(child); }
		// 归一化不间断空格（contentEditable 常见）
		return out.replace(/\u00A0/g, ' ');
	}

	/** 更新字符计数器（纯信息展示，不限制输入） */
	private _updateCharCounter(text: string): void {
		if (!this._charCounterEl) { return; }
		this._charCounterEl.textContent = `${text.length}`;
	}

	/** 设置输入框纯文本内容（清空后写入，并重算高度） */
	private _setComposerText(text: string): void {
		const root = this._textarea;
		if (!root) { return; }
		clearNode(root);
		if (text) { root.textContent = text; }
		// 重新计算高度，避免多行时被截断
		root.style.height = 'auto';
		const maxAllowed = 320;
		const newHeight = this._userHasAdjustedHeight
			? Math.min(Math.max(root.scrollHeight, this._resizeMaxH), maxAllowed)
			: Math.min(root.scrollHeight, this._resizeMaxH);
		root.style.height = newHeight + 'px';
		// 更新字符计数器
		this._updateCharCounter(text);
	}

	/** 返回光标在纯文本（排除芯片）中的偏移量，用于 / 与 @ 检测 */
	private _getCaretOffset(): number {
		const root = this._textarea;
		if (!root) { return 0; }
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) { return 0; }
		const range = sel.getRangeAt(0);
		const pre = range.cloneRange();
		pre.selectNodeContents(root);
		pre.setEnd(range.endContainer, range.endOffset);
		let offset = 0;
		pre.cloneContents().childNodes.forEach((n) => {
			if (n.nodeType === Node.TEXT_NODE) {
				offset += (n.textContent ?? '').length;
			} else if (n.nodeType === Node.ELEMENT_NODE) {
				const el = n as HTMLElement;
				if (!el.classList.contains('inline-attachment-chip')) {
					offset += (el.textContent ?? '').length;
				}
			}
		});
		return offset;
	}

	/** 将光标定位到输入框末尾 */
	private _focusComposerEnd(): void {
		const root = this._textarea;
		if (!root) { return; }
		root.focus();
		const sel = window.getSelection();
		if (!sel) { return; }
		const range = document.createRange();
		range.selectNodeContents(root);
		range.collapse(false);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	/** 在光标处插入纯文本 */
	private _insertTextAtCaret(text: string): void {
		const root = this._textarea;
		if (!root) { return; }
		root.focus();
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0) {
			const range = sel.getRangeAt(0);
			range.deleteContents();
			const node = document.createTextNode(text);
			range.insertNode(node);
			range.setStartAfter(node);
			range.collapse(true);
			sel.removeAllRanges();
			sel.addRange(range);
		} else {
			root.appendChild(document.createTextNode(text));
		}
		root.dispatchEvent(new Event('input'));
	}

	/**
	 * 底部独立附件预览区已移除（需求：附件以「内联芯片」形式嵌入输入框文本流）。
	 * 保留该方法签名以兼容既有调用点，但不再渲染任何 DOM——附件通过
	 * `_insertInlineAttachmentChip` / `_renderInlineAttachmentChips` 渲染到 contentEditable 中。
	 */
	private _renderAttachmentPreviews(): void {
		// no-op
	}

	// --- Lightbox (full-screen image preview) ---

	private _showLightbox(src: string): void {
		// Remove any existing lightbox
		document.querySelector('.chat-lightbox-overlay')?.remove();

		const overlay = document.createElement('div');
		overlay.className = 'chat-lightbox-overlay';

		const img = document.createElement('img');
		img.src = src;
		img.className = 'chat-lightbox-image';
		overlay.appendChild(img);

		const closeBtn = document.createElement('button');
		closeBtn.className = 'chat-lightbox-close';
		closeBtn.textContent = '✕';
		closeBtn.addEventListener('click', () => overlay.remove());
		overlay.appendChild(closeBtn);

		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) { overlay.remove(); }
		});

		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') { overlay.remove(); }
		}, { once: true });

		document.body.appendChild(overlay);
	}

	/** 鼠标悬停在图片 chip 上时，在 chip 上方显示该图片的缩略图浮层 */
	private _showImageTooltip(att: IChatAttachment, chip: HTMLElement): void {
		if (!att.data) { return; }
		this._hideImageTooltip();

		const tip = document.createElement('div');
		tip.className = 'inline-attachment-thumb-tip';

		const img = document.createElement('img');
		img.className = 'inline-attachment-thumb-tip-img';
		img.src = `data:${att.mimeType};base64,${att.data}`;
		tip.appendChild(img);

		const caption = document.createElement('div');
		caption.className = 'inline-attachment-thumb-tip-caption';
		caption.textContent = att.name;
		tip.appendChild(caption);

		this._imageTooltip = tip;
		document.body.appendChild(tip);

		const position = () => {
			const rect = chip.getBoundingClientRect();
			const tipRect = tip.getBoundingClientRect();
			let left = rect.left + rect.width / 2 - tipRect.width / 2;
			let top = rect.top - tipRect.height - 8;
			// 水平方向夹取到视口内
			left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
			// 若上方空间不足则翻转到 chip 下方
			if (top < 8) { top = rect.bottom + 8; }
			tip.style.left = `${Math.round(left)}px`;
			tip.style.top = `${Math.round(top)}px`;
		};
		// 图片加载完成后尺寸才确定，需重新定位
		if (img.complete) {
			position();
		} else {
			img.addEventListener('load', position, { once: true });
			// 兜底：若长时间未触发 load（如损坏图片），仍按默认尺寸定位
			setTimeout(position, 60);
		}
	}

	/** 移除图片缩略图浮层 */
	private _hideImageTooltip(): void {
		if (this._imageTooltip) {
			this._imageTooltip.remove();
			this._imageTooltip = null;
		}
	}

	getAttachments(): ReadonlyArray<IChatAttachment> {
		return this._attachments;
	}

	clearAttachments(): void {
		this._attachments = [];
		this._renderAttachmentPreviews();
	}

	/**
	 * P0-2: 添加文件内容作为聊天上下文附件。
	 * 由 @mention 选择文件后调用，读取文件内容并添加为 text/plain 附件。
	 */
	addFileContext(filePath: string, content: string): void {
		const fileName = filePath.split(/[\\/]/).pop() || filePath;
		const att: IChatAttachment = {
			id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			type: 'file',
			name: fileName,
			mimeType: 'text/plain',
			data: content,
			size: content.length,
			isPasted: false,
			filePath,
		};
		this._attachments.push(att);
		this._renderAttachmentPreviews();
		this._insertInlineAttachmentChip(att);
	}

	/**
	 * 添加纯文本内容作为聊天上下文附件（无文件路径，不可点击打开）。
	 * 由内置浏览器的 "Add Console Logs to Chat" 等功能调用。
	 */
	addTextContext(name: string, content: string): void {
		const att: IChatAttachment = {
			id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			type: 'file',
			name,
			mimeType: 'text/plain',
			data: content,
			size: content.length,
			isPasted: false,
		};
		this._attachments.push(att);
		this._renderAttachmentPreviews();
		this._insertInlineAttachmentChip(att);
	}

		/** Inject a workflow/taskboard prompt into the textarea and auto-send it */
	injectPrompt(message: string): void {
		if (!this._textarea) { return; }
		this._setComposerText(message);
		this._textarea.dispatchEvent(new Event('input'));
		// Auto-send after a microtask so the textarea resize settles
		queueMicrotask(() => this._handleSendMessage());
	}

	override dispose(): void {
		this._hideImageTooltip();
		this._closeAgentDropdown();
		this._abortController?.abort();
		this._stopStreamScroll();
		if (this._streamJustEndedTimer !== null) { clearTimeout(this._streamJustEndedTimer); }
		if (this._streamingMdTimer !== null) { clearTimeout(this._streamingMdTimer); }
		if (this._streamingUpdateRaf !== null) { cancelAnimationFrame(this._streamingUpdateRaf); }
		if (this._scrollbarUpdateRaf !== null) { cancelAnimationFrame(this._scrollbarUpdateRaf); }
		this._markerDisposables.dispose();
		if (this._lazyLoadObserver) { this._lazyLoadObserver.disconnect(); }
		if (this._contextRingTimer !== null) { clearTimeout(this._contextRingTimer); }

		// Dispose all markdown disposables to avoid leakage
		for (const disposable of this._markdownDisposables.values()) {
			disposable.dispose();
		}
		this._markdownDisposables.clear();
		this._nodeCollapsedState.clear();

		super.dispose();
	}
}

