/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import "./media/agentChat.css";
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { $, append, clearNode, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { MarkdownRenderOptions } from '../../../base/browser/markdownRenderer.js';
import { IAgentChatMessage, IToolCall, IMessagePart, deriveUiMessageParts, IChatAttachment, ISubAgentData, IConfirmationData, IAgentInfo, IProviderInfo, IModelInfo, HeaderPanelType, StreamPhase, IModeOption, IWorktreeItem, IWorkspaceItem, ISessionInfo, IAgentSessionMeta, IContextUsage, ICheckpointInfo, IQueueItem, IQueueItemActionCallback, ISuggestedQuestion, IReferenceItem, ILiveWorkflowAskUser, ILiveWorkflowExecution, ILiveWorkflowEvent, ILiveWorkflowSubAgent, ILiveCollectVariable, ITodoItem, ITipMessage, IProgressMessage, IPlanTaskCard, OrchestrationPlan, PlanTask } from './agentChatTypes.js';
// ChatMode removed — replaced by chatOnly boolean toggle
import type { IChatPanel } from './iChatPanel.js';
import { TabbedPanelManager } from './modules/tabbedPanel.js';
import { ScrollbarController, type IScrollbarHost } from './scrollbarController.js';
import { StreamingRenderScheduler } from './streamingRenderScheduler.js';









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

export function _patchNestedMarkdown(source: string): string {
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

protected _providerDropdownOutsideClick: IDisposable | null = null;

protected _modelDropdownOutsideClick: IDisposable | null = null;

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
private _loadingPillEl: HTMLElement | null = null;
private _loadingPillTimer: number | null = null;
private static readonly _LOADING_PILL_DEBOUNCE_MS = 300;

protected _showScrollBtn = false;

protected _isAtBottom = true;

protected _isDraggingScrollbar = false;

protected _wasLoading = false;

protected _streamJustEnded = false;

protected _streamJustEndedTimer: number | null = null;


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
private readonly _streamCardPinState = new WeakMap<HTMLElement, { pinned: boolean; lastUserTop: number; lastUserScrollAt: number }>();

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
		} else {
			// 向下滚动但未到底：保持解除，避免半路被钉回底部
			state.pinned = false;
		}
		state.lastUserTop = container.scrollTop;
	}, { passive: true });
}

/** 渲染后回调（thinkingMdScheduler 的 afterRender）：pinned → 滚到底跟随；
 *  非 pinned → 尊重用户滚动位置（自由拖拽），仅在「全量替换导致 scrollTop 大幅归零」
 *  （>50px 跳变，区别于正常拖拽的小步增量）时恢复到 lastUserTop，避免失位。 */
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
	if (state.pinned) {
		// 用户近期在向上滚动（拖拽中）则暂缓强制置底，把滚动位置交还给用户；
		// 200ms 宽限足以覆盖一次拖拽手势，且不依赖不可靠的滚动条指针事件。
		if (Date.now() - state.lastUserScrollAt < 200) { return; }
		// 仅在确实未贴底时强制置底跟随流式增长
		const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
		if (distFromBottom > 8) {
			container.scrollTop = container.scrollHeight;
		}
	} else if (container.scrollTop < state.lastUserTop - 50) {
		// 仅 replaceChildren 物理归零（跳变 >50px）时恢复用户位置；正常拖拽增量 <50px 不干扰
		container.scrollTop = state.lastUserTop;
	}
}

/**
 * 统一钉底：找到容器内所有可滚动卡片体，对已钉底的执行置底跟随。
 * 覆盖 thinking body / tool body / sub-agent trace-list / sa-body / write-file-stream 等。
 * 在 _reconcileParts 后处理、_updateToolCardStatuses 等路径调用，
 * 确保所有卡片内容流式增长时内部滚动条自动贴底。
 */
protected _pinAllScrollableBodiesToBottom(container: HTMLElement): void {
	const scrollables = container.querySelectorAll(
		'.thinking-card-body, .tool-header-children, .trace-list, .sa-body, .write-file-stream, .conclusion-box, .done-stats, .delegate-scroll'
	) as NodeListOf<HTMLElement>;
	for (const el of scrollables) {
		if (el.scrollHeight <= el.clientHeight) { continue; } // 不可滚动无需钉底
		this._attachStreamCardPin(el);
		this._pinStreamCardToBottom(el);
	}
}

protected static readonly STREAMING_MD_INTERVAL = 100;

protected _streamingUpdateRaf: number | null = null;



protected _lazyLoadObserver: IntersectionObserver | null = null;

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

protected _providerDropdownEl: HTMLElement | null = null;

	protected _providerTrigger: HTMLElement | null = null;

	protected _providerDropdownTrigger: HTMLElement | null = null;

protected _modelDropdownEl: HTMLElement | null = null;

protected _modelTrigger: HTMLElement | null = null;

protected _modelDropdownTrigger: HTMLElement | null = null;

protected _historyOverlayEl: HTMLElement | null = null;

protected _tabsContainer: HTMLElement | undefined;

protected _resizeMaxH = 120;

protected _userHasAdjustedHeight = false;

protected _slashMenuEl: HTMLElement | null = null;

protected _slashMenuIndex = 0;

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

protected readonly _onSendMessage: (text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[], workflowTrigger?: { workflowId: string; input?: string; variables?: Record<string, string> }) => void;

protected readonly _onCancelExecution: () => void;
	/**
	 * 跳过当前工具（terminal 等长命令卡住时用户点击「继续执行」）：
	 * 只中止正在执行的工具，不取消整个 turn——agent 拿到中断结果后继续后续步骤。
	 */
	protected readonly _onSkipCurrentTool?: () => void;

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

protected readonly _onCheckpointAction?: (action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string; checkpointId?: string }) => void;

protected readonly _onConfirmationAction?: (confirmationId: string, buttonId: string) => void;

protected readonly _onEditMessage?: (messageId: string, newText: string) => void;

protected readonly _onListSkills: () => ReadonlyArray<{ id: string; name: string; description: string; activation?: string; source?: string; version?: string; enabled: boolean; category?: string }>;

protected readonly _onListWorkflows?: () => ReadonlyArray<{ id: string; name: string; description?: string; variables?: ReadonlyArray<{ name: string; defaultValue: string }> }>;

protected readonly _onListMcpServers?: () => ReadonlyArray<{ name: string; status: string; toolCount: number }>;

protected readonly _onOpenMcpSettings?: () => void;

protected readonly _onOpenHtmlPreview?: () => void;

protected readonly _onGetAgentSkills?: () => string[];

protected readonly _onAddSkill?: (skillId: string) => Promise<void>;

protected readonly _onRemoveSkill?: (skillId: string) => Promise<void>;

protected readonly _onAskUserSubmit?: (askUserId: string, executionId: string, nodeId: string, selection: string | string[]) => void;

protected readonly _onClarifySubmit?: (toolCallId: string, selection: string) => void;

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

constructor(opts: {
		onSendMessage: (text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[], workflowTrigger?: { workflowId: string; input?: string; variables?: Record<string, string> }) => void;
		onCancelExecution: () => void;
		onSkipCurrentTool?: () => void;
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
		onCheckpointAction?: (action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string; checkpointId?: string }) => void;
		onConfirmationAction?: (confirmationId: string, buttonId: string) => void;
		onEditMessage?: (messageId: string, newText: string) => void;
		onListSkills: () => ReadonlyArray<{ id: string; name: string; description: string; activation?: string; source?: string; version?: string; enabled: boolean; category?: string }>;
		onListWorkflows?: () => ReadonlyArray<{ id: string; name: string; description?: string; variables?: ReadonlyArray<{ name: string; defaultValue: string }> }>;
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
	}) {
		super();
	this._scrollbar = this._register(new ScrollbarController(this));
		this._onSendMessage = opts.onSendMessage;
		this._onCancelExecution = opts.onCancelExecution;
		this._onSkipCurrentTool = opts.onSkipCurrentTool;
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
		this._onCheckpointAction = opts.onCheckpointAction;
		this._onConfirmationAction = opts.onConfirmationAction;
		this._onEditMessage = opts.onEditMessage;
		this._onListSkills = opts.onListSkills;
		this._onListWorkflows = opts.onListWorkflows;
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

		// 性能探针：在 webview 控制台调用 window.__SAROSIS_PERF_PROBE__(rounds)
		// 触发 N 轮流式负载，量化每帧成本（对齐 Hermes perf-probe 思路）。
		(window as unknown as Record<string, unknown>).__SAROSIS_PERF_PROBE__ = (rounds?: number) => this.runPerfProbe(rounds);
	}

get element(): HTMLElement {
		return this._container;
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
			// 加载态去抖：瞬时回复（< 300ms）不闪烁加载提示；持续处理才显示。
			this._scheduleLoadingPill();
		} else {
			this._streamPhase = 'idle';
			this._scrollbar.stopStreamScroll();
			// 加载结束：立即隐藏加载提示（与去抖对应）
			this._clearLoadingPill();
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
	 */
	protected _scheduleLoadingPill(): void {
		this._clearLoadingPillTimerOnly();
		this._loadingPillTimer = setTimeout(() => {
			this._loadingPillTimer = null;
			if (!this._loadingPillEl) {
				const pill = $('.chat-loading-pill');
				pill.appendChild($('.loading-spinner'));
				pill.appendChild($('span.chat-loading-pill-label', undefined, '处理中…'));
				this._container.appendChild(pill);
				this._loadingPillEl = pill;
			}
			this._loadingPillEl.classList.add('visible');
		}, AgentChatPanelBase._LOADING_PILL_DEBOUNCE_MS) as unknown as number;
	}

	protected _clearLoadingPill(): void {
		this._clearLoadingPillTimerOnly();
		if (this._loadingPillEl) {
			this._loadingPillEl.classList.remove('visible');
		}
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

protected _findMessageElementById(id: string): HTMLElement | null {
		if (!this._messagesContainer) { return null; }
		return this._messagesContainer.querySelector(`[data-msg-id="${id}"]`);
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
		this._closeProviderDropdown();
		this._closeModelDropdown();
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

protected _rebuildMessageElement(existingEl: HTMLElement, msg: IAgentChatMessage): void  { throw new Error('[moved-to-feature] _rebuildMessageElement'); }

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

protected async _copyToClipboard(text: string): Promise<boolean>  { throw new Error('[moved-to-feature] _copyToClipboard'); }

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

protected _openProviderDropdown(customTrigger?: HTMLElement | null): void  { throw new Error('[moved-to-feature] _openProviderDropdown'); }

protected _closeProviderDropdown(): void  { throw new Error('[moved-to-feature] _closeProviderDropdown'); }

	protected _openModelDropdown(customTrigger?: HTMLElement | null): void  { throw new Error('[moved-to-feature] _openModelDropdown'); }

protected _closeModelDropdown(): void  { throw new Error('[moved-to-feature] _closeModelDropdown'); }

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
		collectVariables?: Record<string, ILiveCollectVariable>
	): HTMLElement;
	protected abstract _createCollectVarsCard(execId: string, cv: ILiveCollectVariable): HTMLElement;
	protected abstract _createNodeCard(sa: ILiveWorkflowSubAgent): HTMLElement;
	protected abstract _createTimeline(exec: ILiveWorkflowExecution, events: ILiveWorkflowEvent[]): HTMLElement;
	protected abstract _createTimelineItem(label: string, status: string): HTMLElement;
	protected abstract _createConfirmationCard(cf: IConfirmationData): HTMLElement;
	protected abstract _createTerminalConfirmationCard(cf: IConfirmationData): HTMLElement;
	protected abstract _createAskUserCard(askUser: ILiveWorkflowAskUser): HTMLElement;
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
