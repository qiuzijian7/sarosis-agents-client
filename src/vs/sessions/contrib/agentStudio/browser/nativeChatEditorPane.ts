/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorPane, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorGroupView } from '../../../../workbench/browser/parts/editor/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IMcpService } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { ISkillRegistry } from '../common/skills.js';
import { IAgentOSService } from '../common/agentOS.js';
import { filterUserFacingAgents } from '../common/builtinAgents.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IBridgeService } from './bridge/bridgeService.js';

import { NativeChatEditorInput, type IChatRuntimeState, type ChatTabStatus } from './nativeChatEditorInput.js';
import { WorkflowTraceController } from './workflowTraceController.js';
import { CheckpointManager } from './checkpointManager.js';
import { KbImportController, createKbImportHandler } from './kbImportController.js';
import { SkillExtractionController } from './skillExtractionController.js';
import { ChatEditorIntegration } from './chatEditorIntegration.js';
import { CompressionDetailEditorInput } from './compressionDetailEditorInput.js';
import { MemoryDetailEditorInput } from './memoryDetailEditorInput.js';
import { AgentStreamRecorder } from './agentStreamRecorder.js';
import { MemoryDetailEditorPane } from './memoryDetailEditorPane.js';
import { CodebaseMemoryDetailEditorInput } from './codebaseMemoryDetailEditorInput.js';
import { AgentSettingsEditorInput } from './agentSettingsEditorInput.js';
import { AgentChatPanel } from '../../../browser/agentChat/agentChatPanel.js';
import { XtermCliPanel } from '../../../browser/agentChat/xtermTui/xtermCliPanel.js';
import type { IChatPanel } from '../../../browser/agentChat/iChatPanel.js';
import { IAgentStudioService, IAgentChatService, IAgentTaskBoardService, IChatAttachmentSend } from '../../../common/agentStudioService.js';
import { IWorktreeService } from '../../worktree/common/worktreeService.js';
import { ITaskOrchestrationService } from '../../../common/agentStudioService.js';
import { IModelSelectorService } from '../common/modelSelector.js';
import { ICheckpointService } from '../common/checkpointService.js';
import { IWorkflowExecutionService } from '../common/workflowExecutionService.js';
import { IWorkflowStorageService } from '../common/workflowStorage.js';
import { collectWorkflowVariables } from './utils/templateUtils.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import type { AgentStatus as AgentChatAgentStatus, IProviderInfo as IPanelProviderInfo, IModelInfo as IPanelModelInfo, IAgentSessionMeta, IAgentChatMessage, IContextUsage, IChatAttachment, IToolCall } from '../../../browser/agentChat/agentChatTypes.js';
import { adaptPersistedChatMessage } from '../../../browser/agentChat/agentChatTypes.js';
import type { ChatMessage } from '../../../common/agentStudioTypes.js';
import { TaskBoardStatus } from '../../../common/agentStudioTypes.js';
// OrchestrationPlan import removed — task orchestration entry point closed
import * as DOM from '../../../../base/browser/dom.js';
import { clearNode } from '../../../../base/browser/dom.js';

/**
 * EditorPane that hosts AgentChatPanel natively in the DOM.
 *
 * This replaces the WebView/iframe-based AgentStudioEditorPane for chat,
 * eliminating the overlay synchronisation issues (bottom gap on resize),
 * iframe destruction on DOM reparent, and cross-origin communication overhead.
 *
 * The pane mounts the existing AgentChatPanel (which renders the full chat UI:
 * tabs, header, messages, input area) directly inside the editor container.
 */
export class NativeChatEditorPane extends EditorPane {

	static readonly ID = NativeChatEditorInput.EditorID;
	/** 多实例计数器（仅调试用），每个 pane 创建时自增。 */
	private static _nextPaneId = 1;
	/**
	 * 最近获得焦点的面板实例（跨所有 tab/分组共享）。
	 * "Add File to Chat" 等外部操作通过此字段路由到正确的面板。
	 */
	static lastFocusedPane: NativeChatEditorPane | null = null;

	private _container: HTMLElement | undefined;
	private _chatPanel: IChatPanel | undefined;
	/** 多实例调试：每个 pane 的唯一标识（递增计数器），用于日志区分。 */
	private readonly _paneId: number = NativeChatEditorPane._nextPaneId++;
	get paneId(): number { return this._paneId; }

	/**
	 * 共享外部发送会话状态：防止多个 pane 同时接管同一个外部 session 的流式渲染。
	 * Key = sessionId（无前缀，与 delta 事件 sessionId 对齐），不含 agentId。
	 * 首 pane claim → add；done/error → delete。后续 pane 检查已存在 → 跳过。
	 */
	private static readonly _sharedExternalSendSessions = new Set<string>();

	/**
	 * 共享本地发送会话状态：防止「多开聊天框、相同 agentId 不同 session」时串台。
	 * 当某 pane 通过自身输入框发起本地发送（_sendMessageInternal）时，会将本次
	 * sessionId 加入此集合；其它同 agent 的 pane 在 onDidStreamDelta 监听器里
	 * 见到属于该 session 的广播 delta 会直接忽略（流式内容已由发起 pane 自己的
	 * onDelta 渲染），从而避免把 A 会话的 LLM 输出渲染进 B 会话的聊天框。
	 * Key = sessionId（无前缀，与 delta 事件 sessionId 对齐），不含 agentId。
	 * 发送开始 → add；done/error → delete。
	 */
	private static readonly _sharedLocalSendSessions = new Set<string>();

	/**
	 * 本 pane 正在进行本地发送的 sessionId（`''` 表示无 session 的本地发送）。
	 *
	 * ★ 唯一可靠的「本地 onDelta 回调仍在接收 delta」判据（2026-08-20，修
	 * 「聊天框 LLM 返回文字逐 token 重叠」事故，日志 1787211923566 + 用户截图）。
	 *
	 * ## 为什么不能用 `_isSending && !_isExternalSend`（旧守卫）
	 * 那两个标志会被 **delta 处理逻辑自身改写**，形成自毁循环：
	 *  1. 本地发送开始：`_isSending=true`、`_isExternalSend=false` → 旧守卫正确跳过；
	 *  2. 中途 `_isSending` 被置 false（error delta 收尾、turn 级 done、取消等，
	 *     见 line 166 注释已知行为）→ 旧守卫失效；
	 *  3. 全局 onDidStreamDelta 落入「外部接管」else 分支，line 1671-1672 设
	 *     `_isSending=true` **且 `_isExternalSend=true`**；
	 *  4. 此后旧守卫 `_isSending(true) && !_isExternalSend(false)` **恒为 false**
	 *     → 永不跳过；而本地回调（line 610）仍在跑；
	 *  5. 两条路径对**同一个 delta** 各调一次 `_handleStreamDelta`，都 push 进同一个
	 *     `_deltaBuffer`（line ~2465）→ flush 后序列变成 `d1 d1 d2 d2 …`
	 *     → 渲染出「LoadLoadImageImage」「现在现在」这种**逐 token 交错重复**。
	 *
	 * 日志铁证：`STREAM_END types={tool_start=2,tool_end=2,tool_result=2,usage=2,
	 * phase_change=2,…}` —— 单工具单次 LLM 的量精确 ×2，而 `done=1`（turn done
	 * 不广播给外部监听器，故只走一条路径）。
	 *
	 * 本字段只在 `_sendMessageInternal` 的发送区设置、`finally` 清除，
	 * **任何 delta 处理逻辑都不得修改它**，因此不会被上述自毁循环破坏。
	 */
	private _localSendActiveSessionId: string | null = null;

	/**
	 * 共享注入认领状态：防止多个 pane 同时响应同一次 requestInjectPrompt 导致
	 * 重复发送（workflow 编辑器「⇗ 到 Chat 编辑」等场景）。
	 * 首 pane 认领（指纹 = agentId+长度+前缀，10s 时间窗）→ 执行切换+发送；
	 * 其余 pane 在同窗内见到相同指纹 → 跳过。
	 */
	private static _injectClaimFingerprint = '';
	private static _injectClaimUntil = 0;
	private static _directRunClaimFingerprint = '';
	private static _directRunClaimUntil = 0;

	private _isInitialized = false;
	private _defaultAgentSelected = false;
	private _currentAgentId: string | null = null;
	private _currentAgentSkills: string[] = [];
	private _currentSessionId: string | null = null;
	private _currentChatOnly: boolean = false;
	/**
	 * 输入框选定的 ChatMode（2026-08-21）。随每 turn 传给 agent（request.chatMode），
	 * 决定权限档位与 plan_* 工具是否入 schema（仅 'plan' 档暴露）。
	 * 与 _currentChatOnly 正交：前者是意图档位，后者是额外只读约束。
	 */
	private _currentChatMode: 'craft' | 'ask' | 'plan' = 'craft';
	private _currentWorkspaceId: string | null = null;
	/** 工作流缓存（composer `/` 菜单「工作流」分组，同步返回；异步刷新）。 */
	private _workflowCache: ReadonlyArray<{ id: string; name: string; description?: string; variables?: ReadonlyArray<{ name: string; defaultValue: string }> }> = [];
	/**
	 * 面板本地 Provider/Model 选择状态（不写入共享单例 IModelSelectorService）。
	 * 多面板共存时（主窗口 + popout），每个面板的选择互不影响。
	 */
	private _localProviderId: string = '';
	private _localModelId: string = '';
	/**
	 * 会话只读（多开 --instance）：当前会话锁被另一实例持有时为 true，
	 * _sendMessageInternal 拦截发送并提示，防止双写覆盖聊天历史。
	 */
	private _sessionReadOnly = false;

	// ─── Per-agent input area state persistence keys ─────────────────────────
	// Store chatMode / provider / model / composerText per agent so switching
	// agents or restarting the client restores the full input area state.
	private static readonly _STORAGE_CHAT_ONLY = 'saros:chatOnly';
	private static readonly _STORAGE_CHAT_MODE = 'saros:chatMode';
	private static readonly _STORAGE_PROVIDER = 'saros:lastProvider';
	private static readonly _STORAGE_MODEL = 'saros:lastModel';
	private static readonly _STORAGE_COMPOSER_TEXT = 'saros:composerText';

	private _isSending = false;
	/**
	 * 标记当前流式 delta 来源是否为外部发送（如看板任务执行）。
	 * 当 _isSending && !_isExternalSend → 面板自己的 _sendMessageInternal 回调处理 delta，
	 *   onDidStreamDelta 监听器跳过（避免双重处理）。
	 * 当 _isSending && _isExternalSend → 外部发送，onDidStreamDelta 监听器接管
	 *   按钮状态 + 记忆 delta 处理（面板回调不会被调用）。
	 */
	private _isExternalSend = false;
	/**
	 * 标志：本地发送（_sendMessageInternal）是否已结束（done 或 error）。
	 * 当 _localSendDone=true 时，onDidStreamDelta 的 else 分支禁止重新 _initStreamingMessage，
	 * 防止 error delta 重置 _isSending=false 后，后续 memory_writing 等广播 delta 误触发
	 * 第二次流式初始化，导致出现多余空气泡。每次 _sendMessageInternal 入口重置为 false。
	 */
	private _localSendDone = false;
	/**
	 * Flag to prevent _selectAndLoadAgent reload during the execution‑setup
	 * window: onDidChangeTaskBoard fires BEFORE executeTaskForBoard starts
	 * streaming, so _isSending is still false when the 1500ms reload timer
	 * fires.  Setting this flag keeps the guard active until the first
	 * streaming delta arrives (which sets _isSending=true).
	 */
	private _taskExecutingSessionId: string | null = null;
	/**
	 * 当前流式 assistant 消息的共享状态，供 _sendMessageInternal 回调和
	 * onDidStreamDelta 监听器共同访问，确保本地发送和外部发送（看板）走同一套
	 * 流式 UI 路径（文本/工具/记忆/usage 卡片）。
	 * 流式开始时由 _initStreamingMessage() 初始化，done/error 后由 _resetStreamingMessage() 清理。
	 */
	private _streamingAssistantId: string | null = null;
	private _streamingAssistantMsg: IAgentChatMessage | null = null;
	/** LLM 流式输出记录器（createEditor 时初始化；默认关闭，localStorage 开关）。 */
	private _streamRecorder: AgentStreamRecorder | undefined;
	/** 看板变更后延迟 reload 的 timer，用于防止多个 board change 堆叠 reload。 */
	private _taskBoardReloadTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * 外部发送（看板任务）完成后设置的标志。
	 * 为 true 时，onDidChangeTaskBoard 跳过 reload — 流式 UI 已正确显示所有内容，
	 * 全量 setMessages 会覆盖流式 UI 导致闪烁。
	 * 在下次用户主动操作（切换 agent / 手动发送）时清除。
	 */
	private _externalSendJustFinished = false;
	private _currentMaxContextTokens: number | undefined;

	// ── P0: Delta 输入缓冲层 ──
	// 流式期间每个 SSE delta (text/thinking/tool_*/usage/memory/phase) 都需
	// 触发 updateMessage() → DOM 更新 → _scrollToBottom()，高峰期每秒 50-100
	// 次调用。缓冲合并 25ms 内的同类型 delta（text 只保留最后一个），降低
	// updateMessage 调用频率到约 40fps。
	private _deltaBuffer: Array<{ type: string; delta: any }> = [];
	private _deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
	private static readonly DELTA_FLUSH_INTERVAL_MS = 25;
	/** 最后发射到 panel 的 text content——用于跳过与上一批重复的 text delta。 */
	private _lastFlushedTextContent: string = '';

	/**
	 * 流式期间当前 text 段在完整 content 中的起始偏移量。
	 * 每当 tool_start 到达时，更新为当时的 content.length——
	 * 使后续 text delta 生成的 text part 只包含「工具之后的增量文本」，
	 * 而非全量 content（避免文本在工具卡前后重复渲染）。
	 */
	private _streamTextSegmentBase: number = 0;

	/**
	 * 最近一个 delegate_task / plan_explore 工具调用的真实 callId（LLM 分配）。
	 *
	 * delegationTools.ts 的 handler 无法拿到 LLM 分配的真实 callId，只能自己生成
	 * 内部 `delegate_<ts>_<rand>` 作为 subagent trace 的 parentToolCallId。该内部 ID
	 * 与主 agent parts 中 delegate_task 工具卡的真实 callId 不匹配，导致 subagent
	 * 执行详情无法内嵌到 delegate_task 卡片。
	 *
	 * 由于 delegate_task 的 tool_start 一定先于其 subagent trace 到达，这里在
	 * tool_start 时记录真实 callId，onDidSubAgentTrace 到达时用它覆盖 parentToolCallId，
	 * 使 subagent 数据能正确匹配并内嵌到 delegate_task 卡片。
	 */
	private _lastDelegateToolCallId: string | undefined;

	/** [PerfDiag] 流式性能诊断数据 */
	private _streamPerf?: {
		startTime: number;
		deltaCount: number;
		slowOps: Array<{ type: string; elapsed: number; count: number }>;
		totalTypes: Record<string, number>;
		lastFlushTime?: number;
		lastFlushBatchSize?: number;
	};
	/**
	 * Whether this pane's editor tab is currently the active (focused) tab
	 * in its group. Tracked via {@link IEditorGroup.onDidActiveEditorChange}.
	 *
	 * Drives the "pending" → "idle" transition: when execution finishes while
	 * the tab is not active, the status dot turns white (pending) to signal
	 * unread results; activating the tab clears it to idle.
	 */
	/** Message IDs successfully imported to KB (synced to chat panel's _importedKbMessageIds). */
	private readonly _chatPanelImportedIds = new Set<string>();
	private _isTabActive = false;
	/** Reusable streaming-send function, captured from the panel's onSendMessage. */
	private _sendMessageInternal!: (text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[], workflowTrigger?: { workflowId: string; input?: string; variables?: Record<string, string>; images?: string[] }) => Promise<void>;
	/**
	 * Async race guard: incremented before each `_selectAndLoadAgent` call.
	 * Only the latest generation's result is applied — stale loads are silently discarded.
	 * Prevents rapid tab switches from causing agent/session cross-talk.
	 */
	private _loadGeneration = 0;
	/** Workflow trace controller — manages live workflow execution state. */
	private _workflowTrace: WorkflowTraceController | undefined;
	/** Checkpoint manager — refresh bar and handle actions. */
	private _checkpointMgr: CheckpointManager | undefined;
	private _kbImport: KbImportController | undefined;
	private _skillExtract: SkillExtractionController | undefined;
	private _editorIntegration: ChatEditorIntegration | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storageService: IStorageService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
		@ITaskOrchestrationService private readonly _taskOrchestrationService: ITaskOrchestrationService,
		@IAgentChatService private readonly _chatService: IAgentChatService,
		@IAgentTaskBoardService private readonly _taskBoardService: IAgentTaskBoardService,
		@IModelSelectorService private readonly _modelSelector: IModelSelectorService,
		@ICheckpointService private readonly _checkpointService: ICheckpointService,
		@ICommandService private readonly _commandService: ICommandService,
		@IWorkflowExecutionService private readonly _workflowExecutionService: IWorkflowExecutionService,
		@IWorkflowStorageService private readonly _workflowStorageService: IWorkflowStorageService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IFileService private readonly _fileService: IFileService,
		@IModelService private readonly _modelService: IModelService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
		@INativeEnvironmentService private readonly _envService: INativeEnvironmentService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IRequestService private readonly _requestService: IRequestService,
		@IMcpService private readonly _mcpService: IMcpService,
		@ISkillRegistry private readonly _skillRegistry: ISkillRegistry,
		@IAgentOSService private readonly _agentOSService: IAgentOSService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IBridgeService private readonly _bridgeService: IBridgeService,
		@IViewsService private readonly _viewsService: IViewsService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IWorktreeService private readonly _worktreeService: IWorktreeService,
	) {
		super(NativeChatEditorPane.ID, group, telemetryService, themeService, _storageService);
	}

	// ─── 外部 http(s) 链接：系统浏览器打开 ─────────────────────────────
	/**
	 * 把外部 http(s) 链接交给系统浏览器打开，而不是内嵌到中间栏预览。
	 * 内嵌第三方页面会因 CSP(frame-ancestors) / 沙箱 / WAF 反爬等机制
	 * 在控制台抛出大量与产品无关的噪音，故改为系统浏览器。
	 */
	private _openExternalInSystemBrowser(rawUrl: string): void {
		let uri: URI;
		try {
			uri = URI.parse(rawUrl);
		} catch {
			uri = URI.from({ scheme: 'https', path: rawUrl });
		}
		if (uri.scheme !== 'http' && uri.scheme !== 'https') {
			// 仅外部 http(s) 链接走系统浏览器，其余（如相对路径）忽略
			return;
		}
		void this._openerService.open(uri, { openExternal: true }).then(
			() => {},
			(err) => this._logService.error('[NativeChatEditorPane] openExternalInSystemBrowser failed:', err),
		);
	}

	/** 异步刷新工作流缓存（供 composer `/` 菜单同步读取）。 */
	private async _refreshWorkflowCache(): Promise<void> {
		try {
			const workflows = await this._workflowStorageService.listWorkflows();
			this._workflowCache = workflows.map(w => ({
				id: w.id,
				name: w.name ?? w.id,
				description: w.description ?? '',
				variables: collectWorkflowVariables(w.nodes),
			}));
		} catch (err) {
			this._logService.error('[NativeChatEditorPane] _refreshWorkflowCache failed:', err);
			this._workflowCache = [];
		}
	}

	// ─── 中间栏编辑器实例路由 ──────────────────────────────────────────
	/**
	 * 聊天框内所有「非聊天面板」的编辑器打开请求，强制落到中间栏（mainPart）编辑器组，
	 * 禁止落到右侧 agentPart（聊天区）的编辑器组覆盖聊天面板。
	 * sessions 布局下 mainPart = 中间栏主编辑器，agentPart = 右侧聊天区。
	 */
	private get _mainColumnGroup(): IEditorGroupView | undefined {
		const parts = this._editorGroupsService as unknown as { mainPart?: { activeGroup?: IEditorGroupView } };
		return parts.mainPart?.activeGroup;
	}

	private _openInMainColumn(input: EditorInput | IUntypedEditorInput, options?: IEditorOptions): Promise<IEditorPane | undefined> {
		const group = this._mainColumnGroup;
		if (group) {
			if (input instanceof EditorInput) {
				return this._editorService.openEditor(input, options, group);
			}
			// 描述符：group 为第 2 参数，options 内联进 descriptor
			const descriptor = input as IUntypedEditorInput;
			return this._editorService.openEditor(
				{ ...descriptor, options: { ...(descriptor.options ?? {}), ...(options ?? {}) } } as IUntypedEditorInput,
				group,
			);
		}
		// 兜底：理论不会发生（mainPart 恒有组），退回默认 activeGroup
		if (input instanceof EditorInput) {
			return this._editorService.openEditor(input, options);
		}
		const descriptor = input as IUntypedEditorInput;
		return this._editorService.openEditor(
			{ ...descriptor, options: { ...(descriptor.options ?? {}), ...(options ?? {}) } } as IUntypedEditorInput,
		);
	}

	protected createEditor(parent: HTMLElement): void {
		this._logService.debug(`[NativeChatEditorPane#${this._paneId}] createEditor`);
		// 首次进入时从 input 获取 chatId（setInput 会随后被调用确认）
		if (this.input instanceof NativeChatEditorInput) {
			this._currentInputChatId = this.input.chatId;
		}
		NativeChatEditorPane._injectTabStatusStyles();
		const t0 = performance.now();
		this._logService.debug(`[NativeChatEditorPane][Init] createEditor START t=${t0.toFixed(0)}ms`);
		this._container = document.createElement('div');
		this._container.classList.add('native-chat-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflow = 'hidden';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		parent.appendChild(this._container);

		this._initChatPanel();
		// LLM 流式输出记录器（默认关闭；localStorage['saros.streamRecord']='1' 启用）。
		this._streamRecorder = this._register(new AgentStreamRecorder(this._fileService, this._logService, this._envService));
		this._logService.debug(`[NativeChatEditorPane][Init] createEditor END t=${(performance.now() - t0).toFixed(1)}ms`);
	}

	/**
	 * Inject the chat tab status-dot CSS exactly once into the document head.
	 *
	 * The dot is rendered via a `::before` pseudo-element on the tab label,
	 * whose classes come from {@link NativeChatEditorInput.getLabelExtraClasses}.
	 * VS Code applies those classes to the `.monaco-icon-label` inside each
	 * `.tab` element, so the selector scopes the dot to chat tabs only.
	 */
	private static _tabStatusStylesInjected = false;
	private static _injectTabStatusStyles(): void {
		if (NativeChatEditorPane._tabStatusStylesInjected) { return; }
		NativeChatEditorPane._tabStatusStylesInjected = true;
		const style = document.createElement('style');
		style.id = 'native-chat-tab-status-dot';
		style.textContent = `
/* Chat editor tab status indicator dot.
   The status classes are emitted by NativeChatEditorInput.getLabelExtraClasses()
   and applied by VS Code to the .monaco-icon-label inside each editor tab.
   VS Code also uses that label's ::before pseudo-element for codicon icons,
   so we force a solid dot with explicit reset of font/icon properties. */
.tabs-container .tab .monaco-icon-label.chat-tab-status::before,
.tabs-container .tab .chat-tab-status::before {
	content: '' !important;
	display: inline-block !important;
	font-family: inherit !important;
	font-size: 0 !important;
	font-weight: normal !important;
	line-height: 7px !important;
	text-decoration: none !important;
	border: 0 !important;
	outline: 0 !important;
	padding: 0 !important;
	margin: 0 6px 0 2px !important;
	width: 7px !important;
	min-width: 7px !important;
	max-width: 7px !important;
	height: 7px !important;
	min-height: 7px !important;
	max-height: 7px !important;
	aspect-ratio: 1 / 1 !important;
	border-radius: 50% !important;
	vertical-align: middle !important;
	background: transparent !important;
	flex: 0 0 7px !important;
	align-self: center !important;
	box-sizing: border-box !important;
	overflow: hidden !important;
}
/* Running — green, pulsing */
.tabs-container .tab .monaco-icon-label.chat-tab-status-running::before,
.tabs-container .tab .chat-tab-status-running::before {
	background: #3fb950 !important;
	box-shadow: 0 0 4px rgba(63, 185, 80, 0.6) !important;
	animation: chat-tab-status-pulse 1.4s ease-in-out infinite !important;
}
/* Error — red */
.tabs-container .tab .monaco-icon-label.chat-tab-status-error::before,
.tabs-container .tab .chat-tab-status-error::before {
	background: #f85149 !important;
	box-shadow: 0 0 4px rgba(248, 81, 73, 0.5) !important;
}
/* Pending (finished, unread) — white/gray */
.tabs-container .tab .monaco-icon-label.chat-tab-status-pending::before,
.tabs-container .tab .chat-tab-status-pending::before {
	background: #d6deeb !important;
	opacity: 0.85 !important;
}
@keyframes chat-tab-status-pulse {
	0%, 100% { opacity: 1; transform: scale(1); }
	50% { opacity: 0.45; transform: scale(0.8); }
}
`;
		document.head.appendChild(style);
	}

	private _initChatPanel(): void {
		if (this._isInitialized || !this._container) {
			return;
		}
		const t0 = performance.now();
		this._logService.debug(`[NativeChatEditorPane][Init] _initChatPanel START`);

		// 预填充工作流缓存 + 订阅变更（composer `/` 菜单「工作流」分组同步读取）
		void this._refreshWorkflowCache();
		this._register(this._workflowStorageService.onDidChangeWorkflows(() => {
			void this._refreshWorkflowCache();
		}));

		// Choose panel type based on cliMode.
		// - XtermCliPanel: xterm.js-based TUI rendering (true terminal emulator)
		// - AgentChatPanel: rich bubble UI (default)
		// Both implement IChatPanel so the rest of the pane code is agnostic.
		const useCliPanel = this.input instanceof NativeChatEditorInput && this.input.cliMode;
		const PanelCtor = useCliPanel ? XtermCliPanel : AgentChatPanel;
		this._chatPanel = this._register(new PanelCtor({
			onSendMessage: (this._sendMessageInternal = async (text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[], workflowTrigger?: { workflowId: string; input?: string; variables?: Record<string, string>; images?: string[] }) => {
			// 注：防重入逻辑已下移到 AgentChatPanel._handleSendMessage（流式时入队，非流式时直接发送）
			// 此处不再拦截，让 Panel 的队列机制处理并发发送。
			// 跨 pane 串台防护用的 sessionId（在 finally 中统一释放，避免本地发送异常时泄漏标记）。
			let sentSessionId: string | null = null;
			try {
					// 会话只读（多开同会话双开）：锁被另一实例持有时拦截发送
					if (this._sessionReadOnly) {
						this._notificationService.notify({
							severity: Severity.Warning,
							message: '该会话正在另一个实例中编辑，当前窗口为只读。请切换到该实例操作，或在此窗口新建会话。',
						});
						this._logService.warn('[NativeChatEditorPane] onSendMessage blocked: session locked by another instance (read-only)');
						return;
					}
					// Converge the multi-layer session id: always resolve a concrete
					// agent + session before sending so the stream never falls into the
					// "noSession bucket" (the historical cross-talk root cause).
			const ensured = await this._ensureSession();
			if (!ensured) {
				this._logService.info('[NativeChatEditorPane] onSendMessage: no usable agent/session');
				return;
			}
			const agentId = ensured.agentId;
			const sessionId: string = ensured.sessionId;
			// ★ 2026-08-27 诊断（多聊天框 UI 不刷新）：记录本次发送归属的 pane/session/chat，
			// 与 _initStreamingMessage 的 SKIPPED 警告、AgentChatService.sendMessage 的
			// CoderTrace 行对照，即可判定是否存在「多 pane 共用同一 session」的寄生问题
			// （streamKey 冲突 → 后发者 cancel 掉先发者的流 / onDelta 被覆盖）。
			this._logService.info(
				`[NativeChatEditorPane#${this._paneId}] onSendMessage: agent=${agentId} session=${sessionId} ` +
				`chatId=${this._currentInputChatId} staleStreaming=${this._streamingAssistantId ?? 'none'} isSending=${this._isSending}`
			);

			// 发送后清空该 session 的输入框草稿（panel 已在 _onSendMessage 前清空 composer）
			this._saveComposerDraft(agentId, sessionId);

				// ── 首条消息 → 会话名自动设为消息内容（workflow 模式用工作流名）──
				try {
					const history = await this._chatService.getHistory(agentId, sessionId);
					if (!history || history.length === 0) {
						let autoName = text.trim().substring(0, 30);
						if (workflowTrigger?.workflowId) {
							const wfName = await this._workflowStorageService.getWorkflow(workflowTrigger.workflowId)
								.then(w => w?.name)
								.catch(() => undefined);
							autoName = wfName || workflowTrigger.workflowId;
						}
						if (autoName) {
							await this._chatService.renameAgentSession(agentId, sessionId, autoName);
							this._logService.debug(`[NativeChatEditorPane] Auto-renamed session ${sessionId} to "${autoName}"`);
						}
					}
				} catch (renameErr) {
					this._logService.warn('[NativeChatEditorPane] Auto-rename on first message failed:', renameErr);
				}

				// 附件不再以占位文本注入消息，而是透传给 sendMessage 的 options.attachments，
					// 由 agentDriverService.executeFromChatOptions → buildUserContentParts 构建多模态
					// contentParts（图片 → image 块，文件 → 文本上下文），最终经 MessageFormatConverter
					// 转换为各 LLM API 的多模态格式（OpenAI image_url / Anthropic base64 source /
					// Gemini inline_data）。这样图片/文件的真实内容才能正确送达 LLM（旧逻辑只会
					// 发送 [image: name] / [binary file, N bytes] 占位文本，丢失实际数据）。
					const fullText = text;

					// Optimistically add user message
					const userMsg: IAgentChatMessage = {
						id: `msg_${Date.now()}_user`,
						role: 'user',
						content: fullText,
						timestamp: Date.now(),
						// 带上附件，使气泡 UI 能展示图片/文件 chip（与输入框 chip 样式一致）。
						// 真实内容仍经 sendMessage 的 options.attachments 透传给 LLM（见下方 sendMessage 调用）。
						attachments: attachments && attachments.length > 0 ? attachments : undefined,
					};
				this._chatPanel?.addMessage(userMsg);

				// 广播 user 消息：让同 agent + 同 session 的其它窗口（popout 独立窗口）
				// 同步显示该用户消息气泡（对方 onDidStreamDelta 监听 'user_message' delta）。
				try {
					this._chatService.fireUserMessageAdded(agentId, sessionId ?? '', userMsg);
				} catch (e) {
					this._logService.warn('[NativeChatEditorPane] fireUserMessageAdded failed:', e);
				}

				// Set sending state BEFORE await — switches send button to stop icon immediately
				this._chatPanel?.setSending(true);
					this._isSending = true;
					this._isExternalSend = false; // 本地发送，onDidStreamDelta 监听器跳过
					this._localSendDone = false; // 重置本地发送完成标志

					// Create assistant message immediately with isThinking=true so the user
					// sees a "正在思考..." indicator while waiting for the first LLM delta.
					this._initStreamingMessage();

					// 标记本 session 为「本地发送中」，供其它同 agent 的 pane 在
					// onDidStreamDelta 监听器里忽略其流式 delta（防止多开聊天框串台）。
					sentSessionId = sessionId;
					NativeChatEditorPane._sharedLocalSendSessions.add(sessionId);
					// ★ 本地回调活跃标记（见字段注释）：全局 onDidStreamDelta 监听器据此
					// 无条件跳过本 session 的 delta，避免与下方 onDelta 回调双重处理。
					this._localSendActiveSessionId = sessionId ?? '';

					await this._chatService.sendMessage(
						agentId,
						fullText,
						{
							chatOnly: this._currentChatOnly,
							// 输入框 ChatMode 下拉框选定的档位（2026-08-21）。
							// 决定权限档位（getPermissionMode）与 plan_* 工具是否入 schema
							// （filterPlanExclusiveTools —— 仅 'plan' 档暴露），
							// 并作为 WorkMode 的 fallback（resolveRequestWorkMode）。
							chatMode: this._currentChatMode,
							agentSessionId: sessionId,
							explicitSkillIds: explicitSkillIds,
							// 工作流触发：chip 选中工作流后，后端走 _executeWorkflowTurn 而非普通 LLM 回合。
							workflowTrigger: workflowTrigger,
							// 透传附件：图片/文件真实内容经 agentDriverService 构建多模态
							// contentParts，最终正确送达 LLM（修复此前仅发送占位文本的问题）。
							attachments: attachments as IChatAttachmentSend[] | undefined,
							// P0（2026-08-17 日志 1786957557603）：透传面板本地模型选择。
							// 用户手动在聊天框选择模型只更新了面板本地 _localModelId/_localProviderId
							// （不写共享 _modelSelector，避免跨面板污染），此前发送时未透传 →
							// 后端 executeFromChatOptions 的 modelOverride 恒为 undefined，回退到
							// 全局 _activeSelection（settings 里的 defaultModel = hy3-ioa），导致
							// UI 显示 deepseek-v4-pro 但实际请求用 hy3-ioa。现把面板本地选择
							// 透传为 per-request modelOverride，覆盖全局默认选择。
							model: this._localModelId || undefined,
							providerId: this._localProviderId || undefined,
						},
						(delta) => {
							this._handleStreamDelta(delta);
						},
					);
					// Agent loop fully completed (not per-turn) — reset sending state
					this._chatPanel?.setSending(false);
					this._isSending = false;
					this._resetStreamingMessage();
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] sendMessage failed:', err);
					// sendMessage 抛出后没有 _sendMessageInternal line 644 收尾，必须这里手动
					// 恢复 UI 状态并触发队列 dispatch（与正常完成路径一致）。
					this._chatPanel?.setSending(false);
					this._isSending = false;
					this._isExternalSend = false;
					this._resetStreamingMessage();
				} finally {
					// 本地发送结束（正常或异常）：释放该 session 的串台防护标记，
					// 让其它同 agent 的 pane 恢复对该 session 流式 delta 的监听。
					if (sentSessionId) {
						NativeChatEditorPane._sharedLocalSendSessions.delete(sentSessionId);
					}
					// ★ 解除本地回调活跃标记：此后本 session 的广播 delta 由全局
					// onDidStreamDelta 接管（后续 turn / 看板续跑等），不再有双重处理风险。
					this._localSendActiveSessionId = null;
				}
			}),
			onEditMessage: (messageId: string, newText: string) => {
				void this._handleEditMessage(messageId, newText);
			},
			// 「继续执行」：只中止当前正在执行的工具（terminal 长命令等），
			// 不取消整个 turn——agent 拿到中断结果后继续后续步骤，避免原地卡住。
			onSkipCurrentTool: () => {
				this._agentOSService.skipCurrentTool();
			},
			onCancelExecution: () => {
				try {
					// Cancel workflow if active (delegated to controller)
					this._workflowTrace?.cancelExecution();
					// Also cancel any in-flight chat stream
					const agentId = this._currentAgentId ?? 'claw';
					const sessionId = this._currentSessionId ?? undefined;
					this._chatService.cancelStream(agentId, sessionId);
					// Sync: cancel any running task assigned to this agent so the
					// task card reflects the cancellation immediately.
					void (async () => {
						try {
							const tasks = await this._taskBoardService.getTasks();
							const runningTask = tasks.find(t =>
								t.status === 'running' && t.assigneeId === agentId
							);
							if (runningTask) {
								await this._taskBoardService.updateTaskStatus(
									runningTask.id,
									TaskBoardStatus.Cancelled,
								);
								console.info(`[NativeChatEditorPane] onCancelExecution: synced task ${runningTask.id} → cancelled`);
							}
						} catch (err) {
							this._logService.warn('[NativeChatEditorPane] onCancelExecution: failed to sync task board', err);
						}
					})();
					// 立即恢复 UI 状态——cancelStream 中断 AbortController 后，
					// for-await 循环仅在下个 delta 到达时才 break，done/error delta
					// 不会被发射，setSending(false) 不会被调用。这里手动恢复按钮 + 输入框。
					// ⚠️ triggerExecuteNext=false —— _sendMessageInternal line 644 在 sendMessage
					// await 真正退出后会再次 setSending(false) 并触发 executeNext()，这里手动
					// 调用只更新 UI 状态（_isSending / _streamPhase / stream scroll / send button），
					// 不触发队列 dispatch，避免与 line 644 双重触发。
					this._chatPanel?.setSending(false, { triggerExecuteNext: false });
					this._isSending = false;
					// 立即在 LLM 冒泡消息上显示「用户已取消」——cancelStream 仅中断 AbortController，
					// 真正的 done(canceled:true) delta 要等 for-await 循环 break 后才会发出（可能滞后数秒，
					// 例如 LLM 正阻塞在工具调用）。这里同步更新气泡，让停止反馈即时可见。
					// done 事件滞后到达时会再次调用本逻辑，_buildCanceledContent 保证幂等不重复追加。
					const cancelId = this._streamingAssistantId;
					const cancelMsg = this._streamingAssistantMsg;
					if (cancelId && cancelMsg) {
						this._applyStreamPhase('canceled');
						this._chatPanel?.updateMessage(cancelId, {
							content: this._buildCanceledContent(cancelMsg),
							toolCalls: cancelMsg.toolCalls ? cancelMsg.toolCalls.slice() : undefined,
							isStreaming: false,
							isThinking: false,
							streamPhase: 'canceled',
						});
					}
					// 解除共享 Claim：手动停止时 onDidStreamDelta('done') 不会触发，
					// 必须在此清理，防止该 session 权限被永久泄漏。
					if (this._isExternalSend && this._taskExecutingSessionId) {
						NativeChatEditorPane._sharedExternalSendSessions.delete(this._taskExecutingSessionId);
					}
					this._isExternalSend = false;
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] cancelExecution failed:', err);
				}
			},
			onToggleCollapse: () => {
				document.dispatchEvent(new CustomEvent('agent-studio:toggle-right-column'));
			},
			onSelectAgent: (agentId: string) => {
				this._logService.debug(`[NativeChatEditorPane#${this._paneId}] onSelectAgent (dropdown): agentId=${agentId} _currentAgentId=${this._currentAgentId}`);
				this._selectAndLoadAgent(agentId, { force: true });
			},
			onToggleChatOnly: (chatOnly: boolean) => {
				this._currentChatOnly = chatOnly;
				this._saveInputAreaState();
			},
			onChangeChatMode: (chatMode: 'craft' | 'ask' | 'plan') => {
				this._currentChatMode = chatMode;
				this._logService.info(`[NativeChatEditorPane#${this._paneId}] chatMode → ${chatMode}`);
				this._saveInputAreaState();
			},
			onOpenSettings: async () => {
				// Open agent settings page (refer to AgentChat.tsx settings button)
				if (!this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onOpenSettings: no agent selected');
					return;
				}
				try {
					const agent = await this._agentStudioService.getAgent(this._currentAgentId);
					if (!agent) {
						this._logService.info(`[NativeChatEditorPane] onOpenSettings: agent ${this._currentAgentId} not found`);
						return;
					}
					const input = new AgentSettingsEditorInput(agent.id, agent.name);
					await this._openInMainColumn(input, { pinned: true });
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] onOpenSettings failed:', err);
				}
			},
			onListSkills: () => {
				return this._skillRegistry.getSkills().map(s => ({
					id: s.id,
					name: s.name ?? s.id,
					description: s.description ?? '',
					activation: s.activation,
					source: s.source,
					version: s.version,
					enabled: s.enabled,
					category: s.category,
				}));
			},
			onListWorkflows: () => {
				// 首次为空时触发异步刷新（下次打开菜单即显示），本次返回已有缓存
				if (this._workflowCache.length === 0) {
					void this._refreshWorkflowCache();
				}
				return this._workflowCache;
			},
			onListMcpServers: () => {
				// 从 IMcpService 获取 MCP 服务器列表
				const servers = this._mcpService.servers.get();
				return servers.map(server => ({
					name: server.definition.label,
					status: server.connectionState.get().state === 2 ? 'connected' : // McpConnectionState.Kind.Running = 2
						server.connectionState.get().state === 1 ? 'starting' :
							server.connectionState.get().state === 3 ? 'error' : 'stopped',
					toolCount: server.tools.get().length,
				}));
			},
			onOpenMcpSettings: () => {
				// 打开 VS Code 原生 MCP 设置界面
				this._commandService.executeCommand('workbench.action.openSettings', 'mcp').catch(err => {
					this._logService.error('[NativeChatEditorPane] onOpenMcpSettings failed:', err);
				});
			},
			onOpenHtmlPreview: () => {
				// 打开 agent 的 config.html 文件（检查并创建默认文件，用文本编辑器打开）
				if (!this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onOpenHtmlPreview: no agent selected');
					return;
				}
				(async () => {
					try {
						const agentId = this._currentAgentId!;
						const agentDir = await this._agentStudioService.getAgentDir(agentId);
						const configHtmlUri = URI.joinPath(agentDir, 'config.html');

						// 检查 config.html 是否存在，不存在则创建默认文件
						if (!(await this._fileService.exists(configHtmlUri))) {
							const safeName = agentId.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
							const defaultHtml = `<!DOCTYPE html>
<html lang="zh-CN" data-template-edit-mode="slots">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeName} · Panel</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    line-height: 1.6;
    color: #1f2328;
    background: #ffffff;
    padding: 40px 28px;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  .lead { color: #57606a; margin: 0 0 28px; }
  .card {
    border: 1px solid #d0d7de;
    border-radius: 10px;
    padding: 20px 22px;
    margin: 14px 0;
  }
  .card h2 { font-size: 17px; margin: 0 0 6px; }
  .card p { margin: 0; color: #424a53; }
</style>
</head>
<body>
  <div class="wrap">
    <h1 data-edit-slot data-slot-type="text">${safeName} 的面板</h1>
    <p class="lead" data-edit-slot data-slot-type="text">在 AI 中描述你想要的页面，或直接编辑这段 HTML。</p>
    <div class="card">
      <h2 data-edit-slot data-slot-type="text">开始使用</h2>
      <p data-edit-slot data-slot-type="text">这是一个零依赖、可在浏览器内编辑的单文件 HTML 文档。</p>
    </div>
  </div>
</body>
</html>
`;
							await this._fileService.createFolder(agentDir);
							await this._fileService.writeFile(configHtmlUri, VSBuffer.fromString(defaultHtml));
							this._logService.info(`[NativeChatEditorPane] Created default config.html for agent ${agentId}`);
						}

					// 在中间栏（mainPart）文本编辑器中打开 config.html
					await this._openInMainColumn({ resource: configHtmlUri });
						this._logService.info(`[NativeChatEditorPane] Opened config.html for agent ${agentId} in center editor group`);
					} catch (err) {
						this._logService.error('[NativeChatEditorPane] onOpenHtmlPreview failed:', err);
					}
				})();
			},
			onNewSession: async () => {
				// Create a new session for the current agent
				if (!this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onNewSession: no agent selected');
					return;
				}
			try {
				// 保存旧 session 的输入框草稿（await 之前，此时 composer 内容仍属于旧 session）
				this._saveComposerDraft();
				const session = await this._chatService.createAgentSession(this._currentAgentId, `Session ${new Date().toLocaleString()}`);
				this._currentSessionId = session.id;
				void this._updateSessionLock();
					this._logService.debug(`[NativeChatEditorPane] onNewSession: created session ${session.id}`);
					// 持久化 session 到 input（拖拽到新 group 时恢复用），页签显示 session 名
					if (this.input instanceof NativeChatEditorInput && this._currentAgentId) {
						this.input.setAgentInfo(this.input.name, this._currentAgentId, session.id, session.name);
					}
					this._logService.debug(`[NativeChatEditorPane] onNewSession: created session ${session.id}`);
				// Clear messages in UI
				this._chatPanel?.setMessages([]);
				// 新 session 无草稿 → 清空输入框（per-session 隔离）
				this._restoreComposerDraft();
				// 新会话无压缩历史 → 重置压缩基线
				this._restoreCompactedBaseline();
					// New session has no checkpoints yet — reset bar & scope checkpoints to it.
					this._activateCheckpointSession(this._currentAgentId, session.id);
					// Refresh session list
					await this._refreshSessionList();
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] onNewSession failed:', err);
				}
			},
			onOpenSession: async (sessionId: string) => {
				// Switch to the selected session and reload its history
				if (!this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onOpenSession: no agent selected');
					return;
				}
			const agentId = this._currentAgentId;
			try {
				// 保存旧 session 草稿 → 切换 → 恢复目标 session 草稿
				this._saveComposerDraft();
				this._currentSessionId = sessionId;
				void this._updateSessionLock();
				this._logService.debug(`[NativeChatEditorPane] onOpenSession: switched to session ${sessionId}`);
					// 查找 session name 作为页签标题
					let sessionName: string | undefined;
					try {
						const sessions = await this._chatService.listAgentSessions(agentId);
						sessionName = sessions.find(s => s.id === sessionId)?.name;
					} catch { /* lookup failure → fall through without sessionName */ }
					// 持久化 session 到 input（拖拽到新 group 时恢复用）
					if (this.input instanceof NativeChatEditorInput && this._currentAgentId) {
						this.input.setAgentInfo(this.input.name, agentId, sessionId, sessionName);
					}
				const history = await this._chatService.getHistory(agentId, sessionId);
				this._chatPanel?.setMessages(this._adaptHistoryMessages(history));
				// 恢复目标 session 的输入框草稿（无草稿则清空）
				this._restoreComposerDraft();
				// 恢复压缩基线（窗口重载后 token 进度条保持压缩后数值）
				this._restoreCompactedBaseline();
				// Scope checkpoints to the newly opened session & refresh the bar.
				this._activateCheckpointSession(agentId, sessionId);
			} catch (err) {
				this._logService.error('[NativeChatEditorPane] onOpenSession failed:', err);
					this._chatPanel?.setMessages([]);
				}
			},
			onRenameSession: async (sessionId: string, newName: string) => {
				if (!this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onRenameSession: no agent selected');
					return;
				}
				try {
					await this._chatService.renameAgentSession(this._currentAgentId, sessionId, newName);
					this._logService.debug(`[NativeChatEditorPane] onRenameSession: renamed session ${sessionId} to "${newName}"`);
					// 双向同步：session 改名后，同步刷新编辑器页签名（仅 session 名）
					if (this.input instanceof NativeChatEditorInput) {
						this.input.setAgentInfo(this.input.name, this._currentAgentId, sessionId, newName);
					}
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] onRenameSession failed:', err);
				}
			},
			onDeleteSession: async (sessionId: string) => {
				if (!this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onDeleteSession: no agent selected');
					return;
				}
				const agentId = this._currentAgentId;
				try {
				await this._chatService.deleteAgentSession(agentId, sessionId);
				this._logService.debug(`[NativeChatEditorPane] onDeleteSession: deleted session ${sessionId}`);
				// 清理被删 session 的输入框草稿
				try { localStorage.removeItem(this._composerDraftKey(agentId, sessionId)); } catch { /* ignore */ }
					// If the deleted session is the current one, switch to the most recent
					// remaining session (or clear the view) and reload history + checkpoints.
					if (this._currentSessionId === sessionId) {
						const sessions = await this._chatService.listAgentSessions(agentId);
						if (sessions.length > 0) {
							this._currentSessionId = sessions[0].id;
							void this._updateSessionLock();
							if (this.input instanceof NativeChatEditorInput) {
								this.input.setAgentInfo(this.input.name, agentId, sessions[0].id);
							}
						try {
							const history = await this._chatService.getHistory(agentId, this._currentSessionId);
							this._chatPanel?.setMessages(this._adaptHistoryMessages(history));
						} catch {
							this._chatPanel?.setMessages([]);
						}
						this._restoreComposerDraft();
						this._activateCheckpointSession(agentId, this._currentSessionId);
					} else {
						this._currentSessionId = null;
						if (this.input instanceof NativeChatEditorInput) {
							this.input.setAgentInfo(this.input.name, agentId, null);
						}
						this._chatPanel?.setMessages([]);
						this._chatPanel?.setCheckpoint(null);
						// 无 session → 清空输入框草稿显示
						this._restoreComposerDraft();
					}
					}
					await this._refreshSessionList();
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] onDeleteSession failed:', err);
				}
			},
			// Orchestration plan callbacks
			onApprovePlan: async (planId: string) => {
				try {
					await this._taskOrchestrationService.approvePlan(planId);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] approvePlan failed:', err);
				}
			},
			onRejectPlan: async (planId: string) => {
				try {
					await this._taskOrchestrationService.rejectPlan(planId);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] rejectPlan failed:', err);
				}
			},
			onApproveWithoutExecute: async (planId: string) => {
				try {
					await this._taskOrchestrationService.approveWithoutExecute(planId);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] approveWithoutExecute failed:', err);
				}
			},
			onTaskAction: async (planId: string, taskId: string, action: 'retry' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' | 'block' | 'unblock') => {
				try {
					await this._taskOrchestrationService.taskAction(planId, taskId, action);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] taskAction failed:', err);
				}
			},
			onUpdatePlan: async (planId: string, updates: Record<string, unknown>) => {
				try {
					await this._taskOrchestrationService.updatePlan(planId, updates);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] updatePlan failed:', err);
				}
			},
			onUpdateTask: async (planId: string, taskId: string, updates: Record<string, unknown>) => {
				try {
					await this._taskOrchestrationService.updateTask(planId, taskId, updates);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] updateTask failed:', err);
				}
			},
			onDecomposeTask: async (planId: string, taskId: string) => {
				try {
					// Get the plan to retrieve workspaceId and plannerId
					const plan = await this._taskOrchestrationService.getPlan(planId);
					if (plan) {
						await this._taskOrchestrationService.decomposeTask(planId, taskId, plan.workspaceId, plan.plannerId);
					}
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] decomposeTask failed:', err);
				}
			},
			onClosePlanDialog: (planId: string) => {
				// Just log for now, the dialog is closed in AgentChatPanel
				this._logService.debug('[NativeChatEditorPane] closePlanDialog:', planId);
			},
			onSelectWorktree: async (worktree: { path: string; branch: string }) => {
				const workspaceId = this._agentStudioService.getActiveWorkspaceId() || this._currentWorkspaceId || undefined;
				if (!workspaceId || !this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onSelectWorktree: missing workspaceId or agentId');
					return;
				}
				try {
					await this._agentStudioService.upsertAgentBinding(workspaceId, this._currentAgentId, {
						worktreePath: worktree.path,
						worktreeBranch: worktree.branch,
					});
					// Update local state
					this._currentWorkspaceId = workspaceId;
					this._chatPanel?.setSelectedWorktree(worktree.path);
					this._logService.debug(`[NativeChatEditorPane] onSelectWorktree: switched to worktree ${worktree.path}`);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] onSelectWorktree failed:', err);
				}
			},
			// 参考 React WorktreeSwitcher 逻辑：下拉框打开时主动加载 worktree 列表
			onLoadWorktrees: async () => {
				return await this._getWorktrees();
			},
			// 右键 worktree 项 → 「调试」：编译 worktree out/ 并启动其 VsSaros 实例（复用主 exe）
			onDebugWorktree: async (worktree: { path: string; branch: string }) => {
				this._logService.debug(`[NativeChatEditorPane] onDebugWorktree: ${worktree.path} (${worktree.branch})`);
				this._notificationService.notify({ severity: Severity.Info, message: `正在编译并启动 worktree [${worktree.branch}] ...` });
				const result = await this._worktreeService.launchDebug(worktree.path);
				if (result.success) {
					this._notificationService.notify({ severity: Severity.Info, message: `已启动 worktree [${worktree.branch}] 的 VsSaros 实例` });
				} else {
					this._logService.error('[NativeChatEditorPane] onDebugWorktree failed:', result.stderr);
					this._notificationService.notify({ severity: Severity.Error, message: `启动 worktree 调试失败: ${result.stderr}` });
				}
			},
			// 工作区选择器回调
			onLoadWorkspaces: async () => {
				await this._loadWorkspaces();
				// 返回已加载的工作区列表（供 panel 下拉框渲染）
				return this._agentStudioService.getWorkspaces().then(workspaces =>
					workspaces.filter(ws => ws.path).map(ws => ({
						id: ws.id,
						name: ws.name,
						path: ws.path!,
					}))
				);
			},
			/** 切换工作区 → 绑定沙箱到该工作区目录，仅允许在该目录内读写 */
			onSelectWorkspace: async (workspaceId: string, _workspaceName: string) => {
				this._currentWorkspaceId = workspaceId;
				// 切换工作区后【不得】用 ws.path 覆盖 AgentBinding.worktreePath：
				// 1) worktreePath 语义是「worktree 沙箱绑定」（agent 运行在 git worktree
				//    分支内），不能用 workspace.path 污染；否则会清掉用户已选的 worktree，
				//    导致 LLM 文件操作回落到主仓（main 分支）。
				// 2) 常规沙箱模式（resolveAndCheckWorkspacePathImpl 未绑定 worktree 时）已
				//    放行 workspace.path + relatedFolders，无需显式绑定。
				// 3) 新 workspace 的 worktree 选择由下方 _loadWorktrees() 从 binding 恢复。
				// 清空旧 worktree 并重新加载新 workspace 的 worktree 列表
				this._chatPanel?.setWorktrees([]);
				this._chatPanel?.setSelectedWorktree('');
				await this._loadWorktrees();
				this._logService.debug(`[NativeChatEditorPane] onSelectWorkspace: switched to ${workspaceId}`);
			},
			// 参考 React WorktreeSwitcher 逻辑：清除 worktree 选择（切换到"主仓库"）
			onClearWorktree: async () => {
				const workspaceId = this._agentStudioService.getActiveWorkspaceId() || this._currentWorkspaceId || undefined;
				if (!workspaceId || !this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onClearWorktree: missing workspaceId or agentId');
					return;
				}
				try {
					await this._agentStudioService.upsertAgentBinding(workspaceId, this._currentAgentId, {
						worktreePath: undefined,
						worktreeBranch: undefined,
					});
					// Update local state
					this._chatPanel?.setSelectedWorktree('');
					this._logService.debug(`[NativeChatEditorPane] onClearWorktree: switched to main repo`);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] onClearWorktree failed:', err);
				}
			},
			onScrollToMessage: (_messageId: string) => {
				// Scrolling is handled internally by AgentChatPanel._scrollToMessage().
				// This callback is a notification hook only — no host-side action needed.
			},
			onSelectProvider: (providerId: string) => {
				// 仅更新面板本地状态，不写入共享单例 _modelSelector（避免跨面板污染）
				this._logService.info(`[NativeChatEditorPane#${this._paneId}] onSelectProvider: agentId=${this._currentAgentId ?? '(none)'} providerId=${providerId} (prev=${this._localProviderId ?? '(none)'})`);
				this._localProviderId = providerId;
				this._chatPanel?.setCurrentProvider(providerId);
				this._saveInputAreaState();
			},
			onSelectModel: (modelId: string) => {
				// 仅更新面板本地状态，不写入共享单例 _modelSelector
				this._logService.info(`[NativeChatEditorPane#${this._paneId}] onSelectModel: agentId=${this._currentAgentId ?? '(none)'} modelId=${modelId} (prev=${this._localModelId ?? '(none)'})`);
				this._localModelId = modelId;
				this._chatPanel?.setCurrentModel(modelId);
				this._saveInputAreaState();
			},
			onCheckpointAction: (action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string; checkpointId?: string }) => {
				void this._handleCheckpointAction(action, payload);
			},
			onConfirmationAction: (confirmationId: string, buttonId: string) => {
				void this._handleConfirmationAction(confirmationId, buttonId);
			},
			onAskUserSubmit: (askUserId: string, executionId: string, nodeId: string, selection: string | string[]) => {
				this._logService.debug('[NativeChatEditorPane] onAskUserSubmit:', askUserId, executionId, nodeId, selection);
				// Optimistically mark the AskUser as answered, then resume the paused workflow.
				// Both are delegated to the WorkflowTraceController, which owns the
				// _askUsers state and the live-workflow message refresh.
				this._workflowTrace?.markAskUserAnswered(askUserId, selection);
				this._workflowTrace?.resumeExecution(executionId, selection).catch(err => {
					this._logService.error('[NativeChatEditorPane] Failed to resume workflow:', err);
					// Rollback optimistic update on failure.
					this._workflowTrace?.rollbackAskUser(askUserId);
				});
			},
			onClarifySubmit: (toolCallId: string, selection: string) => {
				// 用户在 clarify 卡片中选择了选项 → 将选择作为新消息发送给 LLM
				this._logService.info('[NativeChatEditorPane] onClarifySubmit:', toolCallId, selection);
				void this._sendMessageInternal?.(selection);
			},
			onQuestionClick: (question: { label: string }) => {
				// Send the suggested question as a new user message.
				if (question?.label) {
					void this._sendMessageInternal?.(question.label);
				}
			},
			onReferenceClick: (ref: { kind: string; uri?: string; name: string; range?: { startLine: number } }) => {
				// Open file references in the editor, URL references in the system browser.
				if (ref?.kind === 'url' && ref.uri) {
					this._openExternalInSystemBrowser(ref.uri);
				} else if (ref?.kind === 'file' || ref?.kind === 'code' || ref?.kind === 'symbol') {
					const filePath = ref.uri || ref.name;
					if (filePath) {
						void this._editorIntegration?.openFileInEditor(filePath, ref.range?.startLine);
					}
				}
			},
			onTipAction: (_tipId: string, _actionId: string) => {
				// Tip actions are forward-compatible hooks. Common actionIds like
				// 'openSettings' or 'openMarket' can be routed here in the future.
				// For now, tip actions are handled by the panel's internal logic.
			},
			onTipDismiss: (_tipId: string) => {
				// Tip dismissal is a UI-only operation. The AgentChatPanel handles
				// hiding the tip card internally; no host-side persistence needed.
			},
			onApplyCode: (code: string, language: string, filePath?: string) => {
				void this._editorIntegration?.handleApplyCode(code, language, filePath);
			},
			onSubmitVariables: (executionId: string, values: Record<string, string>) => {
				this._logService.debug('[NativeChatEditorPane] onSubmitVariables:', executionId, values);
				this._workflowExecutionService.submitWorkflowVariables(executionId, values).catch(err => {
					this._logService.error('[NativeChatEditorPane] Failed to submit variables:', err);
				});
			},
			onOpenFile: (filePath: string, contentOrLine?: string | number) => {
				if (typeof contentOrLine === 'string') {
					// 纯内容附件（如 Console Logs）— 在中间栏 untitled 编辑器中显示
					this._openInMainColumn({
						resource: URI.from({ scheme: 'untitled', path: filePath }),
						contents: contentOrLine,
					}).catch(err => {
						this._logService.error('[NativeChatEditorPane] onOpenFile: failed to open content:', err);
					});
				} else if (typeof contentOrLine === 'number' && contentOrLine > 0) {
					// 行号跳转 — 在编辑器中打开文件并跳转到指定行
					void this._editorIntegration?.openFileInEditor(filePath, contentOrLine);
				} else {
					// 真实文件路径 — 在编辑器中打开文件
					void this._editorIntegration?.openFileInEditor(filePath);
				}
			},
			// P0-2: @mention 文件搜索
			onSearchFiles: async (query: string): Promise<Array<{ path: string; name: string }>> => {
				return this._editorIntegration?.searchWorkspaceFiles(query) ?? [];
			},
			// 输入框草稿 per-session 持久化（panel input 事件 → debounce 落盘）
			onComposerTextChange: () => {
				this._scheduleSaveComposerDraft();
			},
			// P0-2: @提及文件选择后添加为上下文
			onAddFileContext: (filePath: string) => {
				void this._editorIntegration?.addFileContextToChat(filePath);
			},
			// 通用命令执行（用于工具卡片中的特殊按钮，例如 Mermaid 预览）
			onExecuteCommand: (commandId: string, ...args: unknown[]) => {
				return this._commandService.executeCommand(commandId, ...args);
			},
			// P1-1: 终端运行代码
			onRunInTerminal: (code: string) => {
				void this._editorIntegration?.runInTerminal(code);
			},
			// P1-3: 添加编辑器选中代码到聊天
			onAddSelectionToChat: () => {
				void this._editorIntegration?.addEditorSelectionToChat();
			},
			onOpenLink: (url: string) => {
				// 外部 http(s) 链接 → 在系统浏览器中打开（不再内嵌中间栏预览，
				// 避免第三方站点的 CSP(frame-ancestors)/沙箱/WAF 反爬噪音）
				this._openExternalInSystemBrowser(url);
			},
			/** 收藏 LLM 消息到知识库，自动归类 */
			onFavoriteMessage: (messageContent: string) => {
				void this._kbImport?.handleFavoriteMessage(messageContent, this._currentAgentId ?? null);
			},
			/** P2: footer 复制按钮右侧的「导入知识库」按钮 —— 走与 onFavoriteMessage 同一份管线 */
			onImportToKnowledgeBase: (messageContent: string, messageId: string): Promise<boolean> =>
				createKbImportHandler(
					this._kbImport,
					() => this._currentAgentId ?? null,
					this._chatPanelImportedIds,
				)(messageContent, messageId),
			/** write_file 工具卡片「导入知识库」：读取文件内容 → 入口(落盘到库)+抽取(构建笔记) */
			onImportFileToKnowledgeBase: async (filePath: string, toolId?: string): Promise<boolean> => {
				if (!this._kbImport) { return false; }
				try {
					const uri = URI.file(filePath);
					if (!(await this._fileService.exists(uri))) {
						this._logService.warn(`[NativeChatEditorPane] import-to-kb skipped, file not found: ${filePath}`);
						return false;
					}
				const text = (await this._fileService.readFile(uri)).value.toString();
				return await this._kbImport.importContentAndBuild(text, this._currentAgentId ?? null, undefined, uri);
				} catch (err) {
					this._logService.error(`[NativeChatEditorPane] import file to KB failed: ${filePath}`, err);
					return false;
				}
			},
			/** P2: footer 导入知识库按钮右侧的「沉淀技能」按钮 —— 提取消息为 SKILL.md */
			onExtractSkill: (messageContent: string) => {
				void this._skillExtract?.handleExtractSkill(messageContent);
			},
			// ── Channel 绑定（飞书）—— 对齐 AgentSettingsEditorPane ──
			onListFeishuBindings: () => {
				try {
					return this._bridgeService.getEngine().listConversationBindings('feishu');
				} catch {
					// 桥接引擎未就绪：返回空
					return [];
				}
			},
			onAddFeishuBinding: (chatId: string) => {
				if (!this._currentAgentId) { return; }
				try {
					this._bridgeService.getEngine().setConversationAgent('feishu', chatId, this._currentAgentId);
					this._notificationService.notify({ severity: Severity.Info, message: `已绑定飞书群聊 ${chatId} 到本 Agent` });
				} catch (err) {
					this._notificationService.notify({ severity: Severity.Error, message: `绑定失败: ${err instanceof Error ? err.message : String(err)}` });
				}
			},
			onRemoveFeishuBinding: (chatId: string) => {
				if (!this._currentAgentId) { return; }
				try {
					this._bridgeService.getEngine().clearConversationAgent('feishu', chatId);
					this._notificationService.notify({ severity: Severity.Info, message: `已解除飞书群聊 ${chatId} 的绑定` });
				} catch (err) {
					this._notificationService.notify({ severity: Severity.Error, message: `解除失败: ${err instanceof Error ? err.message : String(err)}` });
				}
			},
			onGetFeishuDefaultAgent: () => {
				return this._configurationService.getValue<string>('sessions.channel.feishu.defaultAgent');
			},
			onSetFeishuDefaultAgent: (agentId: string | undefined) => {
				const key = 'sessions.channel.feishu.defaultAgent';
				const cur = this._configurationService.getValue<string>(key);
				if (agentId) {
					this._configurationService.updateValue(key, agentId);
					this._notificationService.notify({ severity: Severity.Info, message: '已设为飞书渠道默认 Agent' });
				} else if (cur) {
					this._configurationService.updateValue(key, '');
					this._notificationService.notify({ severity: Severity.Info, message: '已取消飞书渠道默认 Agent' });
				}
			},
		} as any) as IChatPanel);

		this._container!.appendChild(this._chatPanel.element);
		this._isInitialized = true;
		this._logService.debug(`[NativeChatEditorPane][Init] _initChatPanel panel constructed + appended t=${(performance.now() - t0).toFixed(1)}ms`);

		// 主动调用一次 panel.layout()，确保面板使用正确的容器尺寸初始化
		// （xterm TUI 需要根据容器高度计算内部布局）
		if (this._container) {
			const rect = this._container.getBoundingClientRect();
			this._chatPanel!.layout(rect.width, rect.height);
		}

		// 设置系统消息面板的详情回调
		this._chatPanel?.setOpenCompressionDetailCallback((data) => {
			const input = CompressionDetailEditorInput.getOrCreate(data as any);
			this._openInMainColumn(input, { pinned: true }).catch(err => {
				this._logService.error('[NativeChatEditorPane] Failed to open compression detail:', err);
			});
		});
		this._chatPanel?.setOpenMemoryDetailCallback((agentId, memoryType, contentPreview) => {
			const input = MemoryDetailEditorInput.getOrCreate(agentId);
			input.targetMemoryId = null;
			input.targetLayer = memoryType ?? null;
			input.fromAgentChat = true; // 标记从聊天框跳转，仅显示当前 agent 数据
			this._openInMainColumn(input, { pinned: true }).then(() => {
				const pane = this._editorService.activeEditorPane;
				if (pane instanceof MemoryDetailEditorPane) {
					// 技能沉淀消息点击：跳转到技能页签
					if (memoryType === 'skill') {
						(pane as any)._currentView = 'skills';
						(pane as any)._renderFull();
					} else {
						pane.navigateToTarget(memoryType ?? undefined, contentPreview);
					}
				}
			}).catch(err => {
				this._logService.error('[NativeChatEditorPane] Failed to open memory detail:', err);
			});
		});
		this._chatPanel?.setOpenCodebaseDetailCallback(() => {
			const input = CodebaseMemoryDetailEditorInput.getOrCreate();
			this._openInMainColumn(input, { pinned: true }).catch(err => {
				this._logService.error('[NativeChatEditorPane] Failed to open codebase memory detail:', err);
			});
		});
		this._logService.debug(`[NativeChatEditorPane][Init] callbacks set up t=${(performance.now() - t0).toFixed(1)}ms`);

		// Load available agents
		this._logService.debug(`[NativeChatEditorPane][Init] calling _loadAvailableAgents t=${(performance.now() - t0).toFixed(1)}ms`);
		this._loadAvailableAgents();

		// Model selector wiring — initialize provider/model data for toolbar
		// Debounce: multiple onDidChangeAvailableModels events fire in rapid
		// succession as providers register (observed 7+ calls). Only refresh
		// once after the burst settles.
		let modelSelectorTimer: ReturnType<typeof setTimeout> | null = null;
		const debouncedRefreshModelSelector = () => {
			if (modelSelectorTimer) { clearTimeout(modelSelectorTimer); }
			modelSelectorTimer = setTimeout(() => {
				modelSelectorTimer = null;
				void this._refreshModelSelector();
			}, 300);
		};
		this._logService.debug(`[NativeChatEditorPane][Init] calling _refreshModelSelector (debounced) t=${(performance.now() - t0).toFixed(1)}ms`);
		debouncedRefreshModelSelector();
		// 不再监听 onDidChangeSelection：选择状态已改为面板本地（_localProviderId/_localModelId），
		// 监听此事件会导致其他面板的选择变更污染当前面板。
		this._register(this._modelSelector.onDidChangeAvailableModels(() => {
			debouncedRefreshModelSelector();
		}));
		this._register({ dispose: () => { if (modelSelectorTimer) { clearTimeout(modelSelectorTimer); } } });

		// 监听自定义 Provider 设置变化：用户在设置页/侧边栏添加 Provider 后，
		// 主进程 reconcile 链路可能因时序问题未及时触发 onDidChangeAvailableModels，
		// 这里直接监听配置键兜底刷新模型选择器，确保聊天框 Provider 下拉立即可见。
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('sessions.agentStudio.provider.customProviders')) {
				debouncedRefreshModelSelector();
			}
		}));

		// Listen for agent selection from agentStudio webview/external sources
		// 多实例核心修复：仅在 pane 首次初始化且无 agent 时响应全局 onDidSelectAgent。
		// 已有 agent 的 pane 忽略全局事件——agent 切换通过自己的 dropdown 回调
		// (onSelectAgent → _selectAndLoadAgent) 处理，避免预设面板点击导致所有 pane 同步切换。
		this._register(this._agentStudioService.onDidSelectAgent(async (agentId) => {
			this._logService.debug(`[NativeChatEditorPane#${this._paneId}] onDidSelectAgent: agentId=${agentId} _currentAgentId=${this._currentAgentId}`);
			// 已有 agent 加载完成的 pane 忽略全局事件
			if (this._currentAgentId) {
				return;
			}
			if (!agentId) {
				this._chatPanel?.setAgent(null);
				return;
			}
			await this._selectAndLoadAgent(agentId, { force: true });
		}));

		// ── workflow 注入链（v3 修复）────────────────────────────────────
		// requestInjectPrompt 的接收端。旧 webview chat controller 在 native 模式下
		// early return 不注册监听，导致注入链整体断裂（"⇗ 到 Chat 编辑" 无声丢失）。
		// 这里由 native pane 认领：切换到目标 agent（默认 saros-claw）并直接发送消息，
		// 使 workflow 脚本始终在 saros-claw 中执行，不依赖用户先打开某个 chat。
		// 多 pane 防重复：静态指纹 + 10s 时间窗，首个就绪的 pane 认领，其余跳过。
		this._register(this._agentStudioService.onDidRequestInjectPrompt(async ({ agentId, message }) => {
			if (!message || !agentId || !this._sendMessageInternal) {
				return; // 未就绪的 pane 不认领，留给已就绪的 pane
			}
			const fp = `${agentId}:${message.length}:${message.slice(0, 64)}`;
			const now = Date.now();
			if (fp === NativeChatEditorPane._injectClaimFingerprint && now < NativeChatEditorPane._injectClaimUntil) {
				return; // 另一 pane 已认领本次注入
			}
			NativeChatEditorPane._injectClaimFingerprint = fp;
			NativeChatEditorPane._injectClaimUntil = now + 10_000;
			this._logService.info(`[NativeChatEditorPane#${this._paneId}] injectPrompt: agent=${agentId} (${message.length} chars) — claiming & sending`);
			try {
				if (this._currentAgentId !== agentId) {
					await this._selectAndLoadAgent(agentId, { force: true });
				}
				await this._sendMessageInternal(message);
			} catch (err) {
				this._logService.error(`[NativeChatEditorPane#${this._paneId}] injectPrompt failed`, err);
			}
		}));

		// ── M4c 画布「直接执行」：开合成 workflow 工具卡（绕过 LLM，子代理卡片内嵌其中）──
		this._register(this._agentStudioService.onDidRequestWorkflowDirectRun(({ toolCallId, name, script }) => {
			if (!this._chatPanel || !this._currentAgentId) { return; } // 未就绪 pane 不认领
			// 单一 pane 认领（toolCallId 做 fingerprint），避免多窗口重复开卡
			const now = Date.now();
			if (toolCallId === NativeChatEditorPane._directRunClaimFingerprint && now < NativeChatEditorPane._directRunClaimUntil) {
				return;
			}
			NativeChatEditorPane._directRunClaimFingerprint = toolCallId;
			NativeChatEditorPane._directRunClaimUntil = now + 60_000;
			this._logService.info(`[NativeChatEditorPane#${this._paneId}] workflowDirectRun: opening synthetic tool card ${toolCallId} "${name}"`);

			this._isSending = true;
			this._chatPanel.setSending(true);
			this._initStreamingMessage();
			const assistantMsg = this._streamingAssistantMsg;
			const assistantId = this._streamingAssistantId;
			if (!assistantMsg || !assistantId) { return; }
			if (!assistantMsg.toolCalls) { assistantMsg.toolCalls = []; }
			assistantMsg.toolCalls.push({
				id: toolCallId,
				name: 'workflow',
				args: JSON.stringify({ name, script }),
				status: 'running',
				displayName: name || '工作流',
				renderType: 'WorkflowRun',
				defaultShow: true,
			});
			this._lastDelegateToolCallId = toolCallId;
			if (assistantMsg.parts) {
				const tcRef = assistantMsg.toolCalls[assistantMsg.toolCalls.length - 1];
				assistantMsg.parts.push({ kind: 'tool', tool: tcRef } as any);
			}
			this._applyStreamPhase('tool_executing');
			this._chatPanel.updateMessage(assistantId, {
				toolCalls: assistantMsg.toolCalls.slice(),
				parts: assistantMsg.parts?.slice(),
				isStreaming: true,
				isThinking: false,
				streamPhase: 'tool_executing',
			});
		}));

		this._register(this._agentStudioService.onDidWorkflowDirectRunResult((payload) => {
			if (!this._chatPanel) { return; }
			const assistantMsg = this._streamingAssistantMsg;
			const assistantId = this._streamingAssistantId;
			if (!assistantMsg || !assistantId) { return; }
			const tc = (assistantMsg.toolCalls ?? []).find((t: any) => t.id === payload.toolCallId);
			if (!tc) {
				// ★ 本 pane 不持有该卡片（别的 pane 认领了）；认领的 pane 在开卡时就
				// 持有 _streamingAssistantMsg 与该 toolCall，只有该 pane 会找到 tc。
				return;
			}
			// 进入这里，说明本 pane 持有该卡，必须同步关闭，否则 UI 永远「执行中」。
			this._logService.info(`[NativeChatEditorPane#${this._paneId}] workflowDirectRunResult: closing tool card ${payload.toolCallId} ok=${payload.ok}`);
			if (payload.ok) {
				tc.status = 'success';
				tc.result = `workflow 执行完成（${payload.agentsStarted ?? 0} agents）。\n返回值：\n${JSON.stringify(payload.value, null, 2) ?? 'null'}`;
			} else {
				tc.status = 'error';
				tc.error = payload.error;
				tc.result = payload.error;
			}
			this._applyStreamPhase('idle');
			// ★ 关键：updateMessage 是浅合并 + 整体替换字段。pane 本地改 tc.status
			// 不会同步到 chatPanel 内部的 messages 数组（不同对象引用）。必须把
			// 整个 toolCalls 数组传过去让 chatPanel 用新数组替换，UI 卡状态才会
			// 从「执行中」变 success/error。
			this._chatPanel.updateMessage(assistantId, {
				toolCalls: assistantMsg.toolCalls!.slice(),
				isStreaming: false,
				isThinking: false,
				streamPhase: 'idle',
			});
			this._chatPanel.setSending(false);
			this._isSending = false;
			this._resetStreamingMessage();
		}));

		// ── M4c 实时进度：ComfyUI 生成进度透传到工具卡（解决「卡住看不到进度」）──
		this._register(this._agentStudioService.onDidWorkflowDirectRunProgress((payload) => {
			if (!this._chatPanel) { return; }
			const assistantMsg = this._streamingAssistantMsg;
			const assistantId = this._streamingAssistantId;
			if (!assistantMsg || !assistantId) { return; }
			const tc = (assistantMsg.toolCalls ?? []).find((t: any) => t.id === payload.toolCallId);
			if (!tc) { return; } // 本 pane 不持有该卡
			// ★ 进度单调化：ComfyUI 轮询值可能跳变/回落（重排队等），UI 只前进不后退。
			const prev = (tc as any).progress as number | undefined;
			if (typeof prev === 'number' && payload.progress < prev) { return; }
			(tc as any).progress = payload.progress;
			(tc as any).progressText = payload.message ?? `生成中 ${payload.progress}%`;
			// 节流：progress 事件高频（ComfyUI 轮询），避免每帧整体替换数组触发全量重渲染。
			const now = Date.now();
			const last = (this as any)._lastWfProgressFlush as number | undefined;
			if (last !== undefined && now - last < 250) { return; }
			(this as any)._lastWfProgressFlush = now;
			this._chatPanel.updateMessage(assistantId, { toolCalls: assistantMsg.toolCalls!.slice() });
		}));

		// 监听 agent 列表变化（新建/删除/更新）——即时刷新 header 的 agent 下拉框。
		// _loadAvailableAgents 内有 _defaultAgentSelected 守卫：已选中 agent 的 pane
		// 只更新下拉框候选列表，不会重置/切换当前选中的 agent。
		this._register(this._agentStudioService.onDidChangeAgents(() => {
			if (!this._chatPanel) { return; }
			void this._loadAvailableAgents();
		}));

		// Orchestration plan listeners removed — task orchestration entry point is closed.

		// Listen for streaming deltas from task execution / external sendMessage calls.
		//
		// 当消息来源是面板自身（_sendMessageInternal）时，_isSending=true 且 _isExternalSend=false，
		// 面板回调已经处理了所有 delta 类型（text/tool/memory/usage...），此处跳过避免双重处理。
		//
		// 当消息来源是外部（如看板 executeTaskForBoard 直接调用 agentChatService.sendMessage）时，
		// 面板回调不会被调用，此处接管所有 delta 处理（与本地发送走同一套 _handleStreamDelta 路径）：
		//   - 首个非 done/error delta → _initStreamingMessage() 创建占位消息 + setSending(true)
		//   - text/thinking/tool_*/usage/phase_change → 通过 _handleStreamDelta 实时更新 UI
		//   - done → finalize + _resetStreamingMessage() + 延迟 reload history
		//   - error → finalize + setSending(false) + reset
		this._register(this._chatService.onDidStreamDelta(({ agentId, sessionId, delta }) => {
			if (agentId !== this._currentAgentId) { return; }

			// ★★★ 本地回调独占守卫（2026-08-20，修「文字逐 token 重叠」）★★★
			// 本 pane 正在本地发送该 session 时，其 delta 已由 _sendMessageInternal 的
			// onDelta 回调（line ~610）处理，此处必须**无条件**跳过。
			//
			// 必须放在监听器最前面（早于下方任何 session 切换 / 外部接管逻辑）：
			// 旧守卫在 line ~1594（`_isSending && !_isExternalSend`）位置太靠后且判据
			// 会被 delta 处理逻辑自身改写——一旦 `_isSending` 中途被置 false，delta 就会
			// 落入「外部接管」else 分支并设 `_isExternalSend=true`，使旧守卫**永久失效**，
			// 于是本地回调与本监听器对同一 delta 各处理一次、双双 push 进同一个
			// `_deltaBuffer` → 渲染出「LoadLoadImageImage」式逐 token 交错重复。
			// 详见 `_localSendActiveSessionId` 字段注释（含日志铁证）。
			if (this._localSendActiveSessionId !== null &&
				this._localSendActiveSessionId === (sessionId ?? '')) {
				return;
			}

			// 串台防护：本地发送（用户在某个聊天框点击发送）的流式 delta 由发起
			// pane 自身的 onDelta 处理；其它 pane 必须忽略——但仅限【不同 session】。
			// 同一 agent + 同一 session 的其它 pane（如 popout 独立窗口）需要【同步渲染】：
			// 发起 pane 因 _isSending && !_isExternalSend 会在下方 line 1385 跳过（不重复），
			// 同 session 的其它 pane 走「外部接管」分支各自渲染同一流，实现多窗口实时同步。
			// 不同 session 的 pane 仍必须忽略，否则会把 A 会话的 LLM 输出渲染进 B 会话的
			// 聊天框（多开聊天框串台根因）。
			//
			// ⚠️ 全局防线（2026-08-08 修复日志 1786178468122 串台）：
			// 旧实现只在本 pane 处于「本地发送」时（sessionId ∈ _sharedLocalSendSessions）才做
			// session 匹配检查。但外部发送路径（看板任务 executeTaskForBoard / webview 直接调
			// agentChatService.sendMessage / workflow 等）不会把 sessionId 写入 _sharedLocalSendSessions，
			// 此时不同 session 的空闲 pane 会落入「外部接管」分支并【切换 _currentSessionId】渲染对方
			// 会话的 LLM 输出 → 两个 gr-gc-expert 会话并发时，A pane 显示了 B 的内容。
			// 修复：只要本 pane 已绑定会话且与广播 sessionId 不同，一律忽略（不进入外部接管）。
			// 仅当本 pane 尚未绑定会话（_currentSessionId 为空）时允许接管，用于看板任务创建
			// 新 session 后在空闲 pane 上显示其执行流。
			if (sessionId && this._currentSessionId && this._currentSessionId !== sessionId) {
				return;
			}
			const localKey = sessionId || `__nosession_${agentId}`;
			if (NativeChatEditorPane._sharedLocalSendSessions.has(localKey)) {
				// 归一化：_currentSessionId 可能是 null，广播的 sessionId 可能是 ''（无 session）。
				if ((this._currentSessionId ?? '') !== (sessionId ?? '')) {
					return;
				}
			}
			if (!this._chatPanel) { return; }
			if (!delta) { return; }

			// 跨窗口同步 user 消息：同 agent + 同 session 的其它 pane 收到
			// 'user_message' delta 后 addMessage（幂等，避免与本地 addMessage 重复）。
			{
				const d = delta as { type?: string; message?: unknown };
				if (d.type === 'user_message') {
					if ((this._currentSessionId ?? '') === (sessionId ?? '')) {
						const um = d.message as IAgentChatMessage | undefined;
						if (um && !this._chatPanel.getMessages().some(m => m.id === um.id)) {
							this._chatPanel.addMessage(um);
						}
					}
					return;
				}
			}

			// 兜底守卫（主守卫已前移到监听器开头的 _localSendActiveSessionId 检查）：
			// 保留此条以覆盖「本地发送标记已清除、但本 pane 仍处于自身发送态」的窄窗口。
			// ⚠ 不可作为唯一防线——其判据 _isSending/_isExternalSend 会被 delta 处理逻辑
			// 自身改写而失效（2026-08-20「文字逐 token 重叠」根因，见字段注释）。
			if (this._isSending && !this._isExternalSend) { return; }

			if (delta.type === 'done') {
				// 外部发送最终结束（整个 agent loop 完成）— finalize + 重置状态。
				// 注意：此 done 来自 agentChatService for-await 退出后的广播，
				// 不是 turn 级别的 done（turn done 不广播给外部监听器）。
				if (this._isExternalSend) {
					// 解除共享 Claim：释放本 pane 对该 session 外部流的独占权。
					const claimKey = sessionId || `__nosession_${agentId}`;
					NativeChatEditorPane._sharedExternalSendSessions.delete(claimKey);

					this._handleStreamDelta(delta); // finalize assistant msg（不 reset）
					this._resetStreamingMessage(); // 清理流式状态
					this._applyStreamPhase('idle');
					this._chatPanel.setSending(false);
					this._isSending = false;
					this._isExternalSend = false;
					this._taskExecutingSessionId = null;
					// 标记外部发送刚完成 — onDidChangeTaskBoard 跳过后续 reload 避免闪烁。
					// 流式 UI 已正确显示所有内容，全量 setMessages 会覆盖导致闪烁。
					this._externalSendJustFinished = true;
				}
				// 本地发送时 done 不做处理 — 由 _sendMessageInternal await 返回后统一收尾
			} else if (delta.type === 'error') {
				// 外部发送出错 — 解除共享 Claim，防止该 session 的权限被永久占住。
				// _handleStreamDelta 内部会设置 _isExternalSend=false（见 line ~1822），
				// 但共享集合需在此处清理（有 sessionId/agentId 上下文）。
				if (this._isExternalSend) {
					const claimKey = sessionId || `__nosession_${agentId}`;
					NativeChatEditorPane._sharedExternalSendSessions.delete(claimKey);
				}
				this._handleStreamDelta(delta);
			} else {
				// 首个非 done delta → 外部发送开始：初始化流式消息 + 标记外部发送
				if (!this._isSending) {
					// 防止本地发送 error/done 后，_isSending 已被重置为 false，
					// 后续 memory_writing 等广播 delta 误触发二次 _initStreamingMessage 导致空气泡。
					if (this._localSendDone) {
						// 本地发送已完成：残留广播（memory_writing 等）跳过防空气泡。
						// 但其它 pane 发起的【同 session 新流】（phase_change/text/thinking
						// 起始 delta）应重置标志并接管渲染 —— 多窗口实时同步。
						if (delta.type !== 'phase_change' && delta.type !== 'text' && delta.type !== 'thinking') {
							return;
						}
						this._localSendDone = false;
					}
					// 修复多窗口并行场景下的 Pane 劫持问题：
					// 当两个 pane 打开同一 agent 时，看板任务执行会广播 delta 到所有 pane，
					// 导致 idle 的 pane 被意外切换到任务 session。用共享静态集合做跨 pane 协调：
					// 如果已有另一个 pane（包括本 pane）claim 了该 session 的外部流，则跳过。
					// 与 _activeTurns 取消键（agentId::sessionId）不同，此处 session 是 delta
					// 事件的 sessionId，不含 agentId 前缀，直接匹配。
					const externalClaimKey = sessionId || `__nosession_${agentId}`;
					// 同 session 的 pane 需要同步渲染 → 不参与 claim 独占（各 pane 独立渲染
					// 同一流）；不同 session 的 pane 仍由首个 pane claim，防止 idle pane 被
					// 意外切换到任务 session（多窗口并行 Pane 劫持）。
					const isSameSession = (this._currentSessionId ?? '') === (sessionId ?? '');
					if (!isSameSession && NativeChatEditorPane._sharedExternalSendSessions.has(externalClaimKey)) {
						// 另一个 pane 已经接管了这个外部 session 的流式渲染，跳过。
						return;
					}
					if (!isSameSession) {
						NativeChatEditorPane._sharedExternalSendSessions.add(externalClaimKey);
					}

					// If the delta belongs to a different session than what's
					// currently loaded in the panel, switch to that session first.
					// This happens when executeTaskForBoard creates a new session
					// for the task execution (P2-14: per-task sessions).
					if (sessionId && this._currentSessionId !== sessionId) {
						console.info(`[NativeChatEditorPane] External delta for different session: current=${this._currentSessionId} delta=${sessionId}, switching...`);
						this._currentSessionId = sessionId;
						if (this.input instanceof NativeChatEditorInput) {
							this.input.setAgentInfo(this.input.name, agentId, sessionId);
						}
						this._activateCheckpointSession(agentId, sessionId);
					}
					this._isSending = true;
					this._isExternalSend = true;
					this._taskExecutingSessionId = this._currentSessionId;
					this._chatPanel.setSending(true);
					this._initStreamingMessage();
				}
				// 走与本地发送完全相同的 delta 处理路径（流式文本/工具/记忆/usage 全部生效）
				this._handleStreamDelta(delta);
			}
		}));

		// P0/Bug2: 订阅 subagent 流式旁路总线 —— plan_explore 执行期间实时推送
		// subagent 的 toolTraces/progress/output 快照，使卡片中间显示流式执行过程，
		// 而非等 subagent_batch 完成后才一次性渲染。按 subAgent.id upsert（幂等）。
		// P2: 添加 throttle 批量更新（50ms 合并多次 SubAgentEvent），防止高频 DOM 操作导致卡顿。
		let _subAgentTraceThrottleTimer: ReturnType<typeof setTimeout> | undefined;
		let _subAgentTracePendingData: any[] | undefined;
	this._register(this._agentOSService.onDidSubAgentTrace((snapshot) => {
		if (!this._chatPanel) { return; }
		// 流式记录：subagent 旁路总线快照（与主流 delta 同一文件，便于完整回放）
		this._streamRecorder?.record({ type: 'subagent_trace', groupId: snapshot?.groupId, subagentData: snapshot?.subagentData });
		const assistantId = this._streamingAssistantId;
		const assistantMsg = this._streamingAssistantMsg;
		if (!assistantId || !assistantMsg) { return; }
		const saData = snapshot?.subagentData as any[] | undefined;
		if (!saData || saData.length === 0) { return; }

			// 累积最新数据（last-write-wins，throttle 时总是用最新快照）
			_subAgentTracePendingData = saData;

			if (_subAgentTraceThrottleTimer !== undefined) { return; } // 已有定时器，数据已累积

			_subAgentTraceThrottleTimer = setTimeout(() => {
				_subAgentTraceThrottleTimer = undefined;
				const pendingData = _subAgentTracePendingData;
				_subAgentTracePendingData = undefined;
				if (!pendingData || !this._chatPanel) { return; }
				const asstId = this._streamingAssistantId;
				const asstMsg = this._streamingAssistantMsg;
				if (!asstId || !asstMsg) { return; }

				const merged = new Map<string, any>((asstMsg.subAgents ?? []).map((s: any) => [s.id, s]));
				for (const sa of pendingData) { if (sa?.id) { merged.set(sa.id, sa); } }
				asstMsg.subAgents = [...merged.values()];
				// 将 subagent 数据附加到各自对应的父 delegate_task/plan_explore 工具卡。
				this._remapAndAttachSubAgents(asstMsg);
			// 仅传 subAgents（不带 isStreaming）：走 panel 的轻量原地重建路径
			// _updateSubAgentCardsInPlace（只重建含 subAgents 的工具卡）。
			// 若带 isStreaming:true 会落入 isCritical 全量重建——每次 trace 快照
			// （100ms flush × 多子代理并行）都重渲染 markdown 全文 + 全部卡片，
			// 一次会话 273 次快照致渲染线程饱和卡死（2026-07-25）。
			this._chatPanel.updateMessage(asstId, {
				subAgents: asstMsg.subAgents,
			});
			}, 50);
		}));

		// ─── 工具审批广播（2026-08-21）────────────────────────────────────
		// 事故 1787276571583：审批 handler 是覆盖式单例，只有 webview 注册；
		// 用户在 native chat pane 工作时 terminal 首次调用需审批 → 卡片里没有
		// 任何按钮 → agent loop 永久「处理中」。现在 agentOSService 广播请求，
		// 本 pane 把审批区挂到对应工具卡（含倒计时），点击经
		// _handleConfirmationAction → agentStudio.confirmationAction 回传决策。
		this._register(this._agentOSService.onDidRequestToolApproval((req) => {
			this._applyToolApproval(req.toolCallId, {
				id: req.toolCallId,
				toolName: req.toolName,
				reason: this._formatApprovalReason(req.toolName, req.arguments, req.reason),
				securityLevel: req.securityLevel as 'safe' | 'cautious' | 'dangerous',
				deadline: req.deadline,
				timeoutMs: req.timeoutMs,
				status: 'pending',
			}, 'approval_required');
		}));
		this._register(this._agentOSService.onDidResolveToolApproval((res) => {
			const status = res.outcome;
			// approved → 卡片回到 running（工具真正开始执行）；
			// 其余 → rejected/canceled 定格（超时另有 tool result 说明）。
			const hadCard = this._streamingAssistantMsg?.toolCalls?.some(
				(c: any) => c.id === res.toolCallId && c.approval);
			this._applyToolApproval(res.toolCallId, undefined, status === 'approved' ? 'running' : 'rejected', status);
			// 超时：agentOSService 已 cancelAgentLoop 终止本轮 LLM。turn 会在下一个
			// 迭代顶部 break 并发出 done delta 自动收尾 UI，这里只补一条显式提示，
			// 避免用户离开一段时间回来看到「回答莫名中断」而不知原因。
			if (status === 'timeout' && hadCard) {
				this._notificationService.warn(
					'工具授权等待超时，已拒绝该工具并终止本次回答。可重新发送消息并及时点击「允许本次」。',
				);
			}
		}));

		// Reload chat history when the task board changes and the current agent
		// was assigned to a task that just completed (e.g. kanban-created task finished).
		//
		// 防闪烁策略：
		// 1. 流式进行中（_isSending=true）跳过 — 清空流式内容会导致严重闪烁
		// 2. 防抖 timer — 多个 board change 事件只触发最后一次 reload
		this._register(this._taskBoardService.onDidChangeTaskBoard(() => {
			if (!this._currentAgentId || !this._chatPanel) {
				console.info('[ChatFlickerDiag] onDidChangeTaskBoard SKIP: no agent or panel (agentId=%s)', this._currentAgentId || 'null');
				return;
			}
			// 流式进行中不 reload — 会清空正在显示的 streaming text/tool cards
			if (this._isSending) {
				console.info('[ChatFlickerDiag] onDidChangeTaskBoard SKIP: _isSending=true, agentId=%s', this._currentAgentId);
				return;
			}
			// Task execution setup window: onDidChangeTaskBoard fires in
			// Phase 2 (ensureTaskAgent→fire) BEFORE executeTaskForBoard
			// starts streaming.  The 1500ms reload timer below can fire
			// before _isSending is set by the first delta, causing a full
			// _selectAndLoadAgent → setMessages → DOM rebuild → scroll jump.
			if (this._taskExecutingSessionId === this._currentSessionId) {
				console.info('[ChatFlickerDiag] onDidChangeTaskBoard SKIP: taskExecutingSession, agentId=%s sessionId=%s', this._currentAgentId, this._currentSessionId);
				return;
			}
			// 外部发送刚完成 — 流式 UI 已正确显示所有内容，跳过 reload 避免闪烁。
			// 用户下次主动操作（切换 agent / 手动发送）时清除标志。
			if (this._externalSendJustFinished) {
				console.info('[ChatFlickerDiag] onDidChangeTaskBoard SKIP: _externalSendJustFinished=true, agentId=%s', this._currentAgentId);
				this._externalSendJustFinished = false;
				return;
			}
			// 清除之前的 pending timer，只让最后一次 board change 触发 reload
			if (this._taskBoardReloadTimer) {
				console.info('[ChatFlickerDiag] onDidChangeTaskBoard RESET timer, agentId=%s', this._currentAgentId);
				clearTimeout(this._taskBoardReloadTimer);
			}
			console.info('[ChatFlickerDiag] onDidChangeTaskBoard QUEUE reload (1500ms), agentId=%s', this._currentAgentId);
			this._taskBoardReloadTimer = setTimeout(() => {
				this._taskBoardReloadTimer = null;
				if (this._currentAgentId && !this._isSending) {
					console.info('[ChatFlickerDiag] onDidChangeTaskBoard EXEC reload (light), agentId=%s', this._currentAgentId);
					// P0: 轻量重载——board change 只更新消息列表，不重建整个聊天 UI。
					// _selectAndLoadAgent 会 setAgent + setMessages 双重重建（每步 ~600ms），
					// 导致滚动条跳动和 UI 闪烁。这里只拉取最新历史并原地更新。
					void this._reloadChatHistory(this._currentAgentId);
				}
			}, 1500);
		}));

		// Listen for worktree changes (agent binding or list changes)
		this._register(addDisposableListener(mainWindow, 'agentStudio:agent-worktree-changed', (e: Event) => {
			const detail = (e as CustomEvent).detail as { workspaceId?: string; agentId?: string; worktreePath?: string; worktreeBranch?: string };
			if (detail?.workspaceId && detail.workspaceId !== this._currentWorkspaceId) { return; }
			if (detail?.agentId && detail.agentId !== this._currentAgentId) { return; }
			// Update selected worktree
			if (detail?.worktreePath) {
				this._chatPanel?.setSelectedWorktree(detail.worktreePath);
			}
		}));
		this._register(addDisposableListener(mainWindow, 'agentStudio:worktree-changed', (_e: Event) => {
			// Reload worktree list
			void this._loadWorktrees();
		}));
		// NOTE: 移除 agentStudio:workspace-changed 监听器 ——
		// 聊天面板的 workspace 独立于侧边栏全局活跃工作区。
		// 聊天面板仅通过自身的 workspace 下拉框切换，不跟随外部变更。

		// Track whether this pane's editor tab is the active (focused) tab in
		// its group. Used to decide the pending→idle transition of the tab
		// status dot: a finished run leaves a white "pending" dot only when
		// the user has not yet activated the tab; activating it clears it.
		this._isTabActive = this.group.activeEditor === this.input;
		if (this._isTabActive) { NativeChatEditorPane.lastFocusedPane = this; }
		this._register(this.group.onDidActiveEditorChange((e) => {
			const nowActive = e.editor === this.input;
			if (nowActive === this._isTabActive) { return; }
			this._isTabActive = nowActive;
			if (nowActive) { NativeChatEditorPane.lastFocusedPane = this; }
			// User just focused the tab → clear any unread "pending" dot.
			if (nowActive && this.input instanceof NativeChatEditorInput) {
				if (this.input.getTabStatus() === 'pending') {
					this.input.setTabStatus('idle');
				}
			}
		}));

		// ── Initialize extracted controllers ────────────────────────────
		// Checkpoint manager — encapsulates refresh + action logic
		this._checkpointMgr = this._register(new CheckpointManager(
			this._checkpointService, this._commandService,
		));
		this._register(this._checkpointService.onDidCreateCheckpoint((cp) => {
			if (cp.agentId === this._currentAgentId && cp.sessionId === this._currentSessionId) {
				void this._checkpointMgr?.refreshBar(this._chatPanel, this._currentAgentId, this._currentSessionId);
			}
		}));

		// Workflow trace controller — manages live workflow execution state
		this._workflowTrace = this._register(new WorkflowTraceController(
			this._workflowExecutionService, this._chatService, this._logService,
		));
		// KB import controller — encapsulates "import to knowledge base" feature
		this._kbImport = this._register(new KbImportController(
			this._configurationService, this._logService, this._fileService, this._envService,
			this._storageService, this._agentStudioService,
			this._viewsService, this._editorService, this._notificationService,
			this._requestService,
		));

		// Skill extraction controller — encapsulates "save skill" feature (host bridges pane state)
		this._skillExtract = this._register(new SkillExtractionController(
			this._notificationService, this._modelSelector, this._agentStudioService, this._fileService,
			this._logService, this._skillRegistry, this._agentOSService, this._envService,
			{
				getCurrentAgentId: () => this._currentAgentId,
				setCurrentAgentSkills: (skills) => {
					this._currentAgentSkills = skills;
					this._logService.debug(`[NativeChatEditorPane] skills cache updated: ${this._currentAgentSkills.length}`);
				},
				refreshMemoryDetailPane: async () => {
					try {
						const activePane = this._editorService.activeEditorPane;
						if (activePane instanceof MemoryDetailEditorPane) {
							await (activePane as MemoryDetailEditorPane).refreshCurrentView();
						}
					} catch { /* best-effort */ }
				},
			},
		));

		// Chat editor integration controller — file/code/terminal helpers
		this._editorIntegration = this._register(new ChatEditorIntegration(
			this._logService, this._fileService, this._commandService,
			this._editorService, this._editorGroupsService, this._modelService,
			this._workspaceContextService,
			{ getChatPanel: () => this._chatPanel ?? null },
		));

		const pane = this;
		this._workflowTrace.start({
			get chatPanel() { return pane._chatPanel; },
			get currentAgentId() { return pane._currentAgentId; },
			get currentSessionId() { return pane._currentSessionId; },
			onWorkflowAgentChanged: (agentId, sessionId) => {
				pane._currentAgentId = agentId;
				pane._currentSessionId = sessionId;
			},
			onWorkflowEnded: () => {
				pane._isSending = false;
			},
			adaptHistoryMessages: (history) => pane._adaptHistoryMessages(history),
			activateCheckpointSession: (agentId, sessionId) => pane._activateCheckpointSession(agentId, sessionId),
			refreshSessionList: () => pane._refreshSessionList(),
		});

		this._logService.debug('[NativeChatEditorPane] Chat panel initialized');
	}

	// _scheduleDeltaRefresh and _refreshLiveWorkflowMessage have been moved to
	// WorkflowTraceController. The pane now delegates workflow trace events to
	// this._workflowTrace via start() in _initChatPanel().

	/**
	 * P0: 轻量级聊天历史重载——跳过 setAgent 全 UI 重建，仅更新消息列表。
	 *
	 * 与 _selectAndLoadAgent 的区别：
	 * - 不调用 setAgent() → 不重建 header / input area / 面板 UI
	 * - 保持滚动位置（不强制滚到底部，除非用户已在底部）
	 *
	 * 用于 onDidChangeTaskBoard 触发的被动 reload，避免滚动条莫名跳动。
	 */
	private async _reloadChatHistory(agentId: string): Promise<void> {
		if (!this._chatPanel || !this._currentSessionId) { return; }
		if (this._isSending) { return; }

		const t0 = performance.now();
		const diagStack = new Error().stack?.split('\n').slice(2, 5).map(s => s.trim()).join(' ← ') || '?';
		console.debug(`[ScrollDiag] _reloadChatHistory START agentId=${agentId} paneId=${this._paneId} caller: ${diagStack}`);
		this._logService.debug(`[NativeChatEditorPane#${this._paneId}] _reloadChatHistory: agentId=${agentId}`);

		try {
			// 保存当前是否在底部（用于 setMessages 后判断是否恢复到底）
			const messagesContainer = (this._chatPanel as any)['_messagesContainer'] as HTMLElement | null;
			const wasAtBottom = messagesContainer
				? (messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight) < 80
				: false;

			const history = await this._chatService.getHistory(agentId, this._currentSessionId);
			const adapted = this._adaptHistoryMessages(history);
			this._logService.debug(`[NativeChatEditorPane#${this._paneId}] _reloadChatHistory: ${adapted.length} msgs in ${(performance.now() - t0).toFixed(1)}ms`);

			// setMessages 会设置 _wasLoading=true 导致强制滚底。
			// 如果用户不在底部，调用后恢复原位。
			if (!wasAtBottom && messagesContainer) {
				const savedScrollTop = messagesContainer.scrollTop;
				const savedScrollHeight = messagesContainer.scrollHeight;

				this._chatPanel.setMessages(adapted);

				// setMessages 内部双重 rAF 后滚底，我们需要在之后恢复位置
				// 三重 rAF 确保在 setMessages 的滚底之后执行恢复
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							if (!messagesContainer.isConnected) { return; }
							const newScrollHeight = messagesContainer.scrollHeight;
							const heightDelta = newScrollHeight - savedScrollHeight;
							messagesContainer.scrollTop = savedScrollTop + heightDelta;
						});
					});
				});
			} else {
				// 用户已在底部 → 正常 setMessages（保持底部跟随）
				this._chatPanel.setMessages(adapted);
			}

			this._restoreCompactedBaseline();
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _reloadChatHistory failed:', err);
		}
	}

	/**
	 * 本页签是否为「用户新建的聊天页签」（而非 default 单例页签 / 窗口重载恢复的页签）。
	 *
	 * 判定依据（两者同时成立才算新建）：
	 *  1. input 尚未绑定 sessionId —— 已绑定的走「重载恢复」或「已初始化」语义；
	 *  2. chatId 不是 `'default'` —— default 是 NativeChatEditorInput.getInstance()
	 *     的遗留单例页签（nativeChatEditorInput.ts:91），承载「重启后回到上次会话」的
	 *     预期，不能每次都开新 session。
	 *
	 * 用户点「+」新建的页签由 create() 生成 `chat-<ts>-<rand>` 形态的 chatId
	 * （nativeChatEditorInput.ts:105），且 presetAgentView.ts:776 /
	 * taskOverviewEditorPane.ts:931 传 sessionId=undefined → 命中本判定。
	 *
	 * 用途：_selectAndLoadAgent 据此为新页签创建独立 session，避免多页签共用同一
	 * session 导致 streamKey 冲突、后发者 cancel 掉先发者的流（详见该方法内注释）。
	 */
	private _isFreshChatTab(): boolean {
		if (!(this.input instanceof NativeChatEditorInput)) {
			return false;
		}
		if (this.input.sessionId) {
			return false; // 已绑定 session → 重载恢复或已初始化，不新建
		}
		return this.input.chatId !== 'default';
	}

	/**
	 * 加载/切换 agent 并刷新聊天历史。
	 *
	 * @param agentId 要加载的 agent ID
	 * @param options.force 跳过流式保护守卫。用户主动切换 agent 或首次加载时传 true；
	 *   程序化 reload（board change timer、chat jump retry）保持默认 false，流式进行中跳过
	 *   以避免清空正在显示的流式内容。
	 */
	private async _selectAndLoadAgent(agentId: string, options?: { force?: boolean }): Promise<void> {
		// 流式进行中跳过程序化 reload — 避免清空流式内容导致严重闪烁。
		// 用户主动切换（force=true）和首次加载（_currentAgentId=null）不受影响。
		if (!options?.force && this._isSending && this._currentAgentId === agentId) {
			this._logService.info(`[NativeChatEditorPane] _selectAndLoadAgent: skipped (streaming in progress for ${agentId})`);
			return;
		}
		const caller = new Error().stack?.split('\n').slice(2, 4).join(' ← ') || '?';
		console.info(`[ChatFlickerDiag] _selectAndLoadAgent START agentId=${agentId} force=${options?.force ?? false} isSending=${this._isSending} caller=${caller}`);
		// 手动/程序化 reload 时清除待处理的 board reload timer
		if (this._taskBoardReloadTimer) { clearTimeout(this._taskBoardReloadTimer); this._taskBoardReloadTimer = null; }
		const t0 = performance.now();
		const gen = ++this._loadGeneration;
		this._logService.debug(`[NativeChatEditorPane#${this._paneId}] _selectAndLoadAgent: agentId=${agentId} gen=${gen}`);
		try {
			const emp = await this._agentStudioService.getAgent(agentId);
			this._logService.debug(`[NativeChatEditorPane][Init] getAgent done t=${(performance.now() - t0).toFixed(1)}ms`);
			if (emp && this._chatPanel) {
				// Race guard: if a newer load was initiated, discard this stale result.
				if (gen !== this._loadGeneration) {
					this._logService.info(`[NativeChatEditorPane] _selectAndLoadAgent: gen=${gen} superseded by gen=${this._loadGeneration}, discarding`);
					return;
				}
				// 切换 agent 时重置外部发送状态 — 旧 agent 的 onDidStreamDelta('done')
				// 不会再被此 pane 处理（agentId 不匹配），避免 _isSending 卡住。
				// 同时解除共享 Claim，防止该 session 权限被永久泄漏。
				if (this._currentAgentId && this._currentAgentId !== agentId && this._isExternalSend) {
					const claimKey = this._taskExecutingSessionId || `__nosession_${this._currentAgentId}`;
					NativeChatEditorPane._sharedExternalSendSessions.delete(claimKey);
					this._isSending = false;
					this._isExternalSend = false;
					this._chatPanel.setSending(false);
				}
				this._currentAgentId = agentId;
				this._currentAgentSkills = emp.skills ?? [];
				this._logService.debug(`[NativeChatEditorPane#${this._paneId}] _selectAndLoadAgent: setting _currentAgentId to ${agentId}`);
				console.info(`[ChatFlickerDiag] _selectAndLoadAgent → setAgent("${agentId}") gen=${gen}`);
				this._chatPanel.setAgent({
					id: emp.id,
					name: emp.name,
					role: emp.role,
					avatarUrl: emp.avatar,
					icon: emp.icon,
					status: (emp.status ?? 'idle') as AgentChatAgentStatus,
					isPM: emp.id === 'pm' || emp.role?.toLowerCase().includes('project manager'),
					customPrompt: emp.systemPrompt,
					model: emp.model,
					provider: undefined,
				});
				// Auto-create or get active session for this agent
				try {
					// 窗口重载恢复：优先使用 input 上的 sessionId
					const restoredSessionId = (this.input instanceof NativeChatEditorInput) ? this.input.sessionId : undefined;
					let session: IAgentSessionMeta;
					if (restoredSessionId) {
						// 尝试查找恢复的 session
						const allSessions = await this._chatService.listAgentSessions(agentId);
						const restored = allSessions.find(s => s.id === restoredSessionId);
						if (restored) {
							session = restored;
							this._logService.info(`[NativeChatEditorPane] _selectAndLoadAgent: restored session ${session.id} from editor input`);
						} else {
							session = await this._chatService.getOrCreateActiveSession(agentId);
						}
					} else if (this._isFreshChatTab()) {
						// ★ 新建聊天页签（用户点「+」新建，chatId 为 chat-<ts> 且 input 未
						// 绑定 session）→ 必须创建【独立新 session】。
						//
						// 旧行为走 getOrCreateActiveSession(agentId)，而它是**全局单例语义**
						// （agentChatService.ts:2781 按 agentId 取「最近更新」的 session，
						// 且带 10s 缓存）→ 新页签会寄生到其它页签正在用的 session。
						// 后果链（日志 20260827T173319/window1）：
						//   pane#1(default) 与 pane#2(chat-…) 共用 session sess_mtabb578
						//   → 两者 streamKey 相同（`saros-claw::sess_mtabb578`）
						//   → sendMessage 开头 `cancelStream(streamKey)`(agentChatService.ts:1731)
						//     abort 掉先发者的流并 delete 其 onDelta 回调
						//   → 先发 pane 再也收不到 delta → **UI 不刷新 LLM 返回**（用户报告现象）
						// 新建一个 session 即可让两页签 streamKey 天然隔离，根除互掐。
						this._logService.info(`[NativeChatEditorPane#${this._paneId}] fresh chat tab — creating isolated session for agent ${agentId}`);
						session = await this._chatService.createAgentSession(agentId, `Session ${new Date().toLocaleString()}`);
					} else {
						this._logService.debug(`[NativeChatEditorPane][Init] calling getOrCreateActiveSession t=${(performance.now() - t0).toFixed(1)}ms`);
						session = await this._chatService.getOrCreateActiveSession(agentId);
					}
					// Race guard after async: discard if a newer load superseded this one.
					if (gen !== this._loadGeneration) {
						this._logService.info(`[NativeChatEditorPane] _selectAndLoadAgent: gen=${gen} superseded after getOrCreateActiveSession, discarding`);
						return;
					}
					this._currentSessionId = session.id;
					// 持久化 agentId + sessionId 到 input，窗口重载恢复时使用。
					// 页签名称格式: agentName (sessionName)
					if (this.input instanceof NativeChatEditorInput) {
						this.input.setAgentInfo(emp.name, agentId, session.id, session.name);
					}
					this._logService.debug(`[NativeChatEditorPane][Init] getOrCreateActiveSession done session=${session.id} t=${(performance.now() - t0).toFixed(1)}ms`);

					// Load history messages for this session
					try {
						this._logService.debug(`[NativeChatEditorPane][Init] calling getHistory t=${(performance.now() - t0).toFixed(1)}ms`);
						const history = await this._chatService.getHistory(agentId, this._currentSessionId);
						// Race guard after async history load
						if (gen !== this._loadGeneration) {
							this._logService.info(`[NativeChatEditorPane] _selectAndLoadAgent: gen=${gen} superseded after getHistory, discarding`);
							return;
						}
						this._logService.debug(`[NativeChatEditorPane][Init] getHistory done count=${history?.length ?? 0} t=${(performance.now() - t0).toFixed(1)}ms`);
						// Yield to event loop: let the input box render and become
						// interactive BEFORE the heavy synchronous setMessages call
						// (which blocks ~1.4s for 259 messages).
						const adapted = this._adaptHistoryMessages(history);
						await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
						// Final race guard after rAF yield
						if (gen !== this._loadGeneration) {
							this._logService.info(`[NativeChatEditorPane] _selectAndLoadAgent: gen=${gen} superseded after rAF, discarding`);
							return;
						}
						this._logService.debug(`[NativeChatEditorPane][Init] setMessages START (after yield) t=${(performance.now() - t0).toFixed(1)}ms`);
						console.info(`[ChatFlickerDiag] _selectAndLoadAgent → setMessages(${adapted.length}) gen=${gen}`);
						this._chatPanel.setMessages(adapted);
						this._logService.debug(`[NativeChatEditorPane][Init] setMessages done t=${(performance.now() - t0).toFixed(1)}ms`);
						// 恢复压缩基线（窗口重载后 token 进度条保持压缩后数值）
						this._restoreCompactedBaseline();
					} catch (err) {
						this._logService.info('[NativeChatEditorPane] Failed to load history:', err);
						this._chatPanel.setMessages([]);
					}
					// Register active session for checkpoint scoping & refresh checkpoint bar
					this._activateCheckpointSession(agentId, this._currentSessionId);
					this._logService.debug(`[NativeChatEditorPane][Init] _selectAndLoadAgent END t=${(performance.now() - t0).toFixed(1)}ms`);
				} catch (err) {
					this._logService.info('[NativeChatEditorPane] getOrCreateActiveSession failed:', err);
				}
				// Load worktrees for the selected agent
				await this._loadWorkspaces();
				await this._loadWorktrees();
				// Refresh chat-history panel
				await this._refreshSessionList();
				// Restore per-agent input area state (chatMode / provider / model / composer text)
				// Called after setAgent + _refreshModelSelector so the panel DOM is ready.
				await this._refreshModelSelector();
				this._restoreInputAreaState();
			}
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _selectAndLoadAgent failed:', err);
		}
	}

	/**
	 * 将服务端持久化的 ChatMessage[] 适配为面板使用的 IAgentChatMessage[]。
	 * 阶段E：复用共享 adaptPersistedChatMessage —— assistant 消息携带有序 parts
	 * （取代 textPosition 交织），独立 'tool' 角色消息被过滤。与 ChatBarPart 完全对齐。
	 */
	private _adaptHistoryMessages(history: ChatMessage[]): IAgentChatMessage[] {
		const adapted = (history ?? [])
			.map(m => adaptPersistedChatMessage(m))
			.filter((m): m is IAgentChatMessage => !!m);
		this._backfillPlanPhase(adapted);
		return adapted;
	}

	/**
	 * 阶段卡兜底推导（P2-4）：老会话的 plan_enter/plan_explore 工具卡无 planPhase
	 * （新链路上线前的数据），按消息时序向后找最近的 plan_exit(success) 推导：
	 * - 找到 → 完成态（currentStep 4 + completedAt=消息时间戳）
	 * - 未找到 → 进行中（currentStep 1，规划中；WorkMode 真值由 agentDriverService 恢复）
	 * 保证刷新后老会话的阶段卡也不丢渲染依据。
	 */
	private _backfillPlanPhase(messages: IAgentChatMessage[]): void {
		for (const m of messages) {
			for (const tc of m.toolCalls ?? []) {
				if ((tc.name === 'plan_enter' || tc.name === 'plan_explore') && !tc.planPhase) {
					const hasExit = messages.some(mm => (mm.toolCalls ?? []).some(t =>
						t.name === 'plan_exit' && (t.status === 'success' || t.status === 'running')));
					tc.planPhase = hasExit
						? { currentStep: 4, completedAt: m.timestamp }
						: { currentStep: 1 };
				}
			}
		}
	}

	/** 持久化压缩基线到 localStorage（key 按 agentId:sessionId 隔离）。 */
	private _saveCompactedBaseline(baseline: number): void {
		if (!this._currentAgentId || !this._currentSessionId) { return; }
		try {
			const key = `saros:compactedBaseline:${this._currentAgentId}:${this._currentSessionId}`;
			localStorage.setItem(key, String(baseline));
		} catch { /* localStorage may be unavailable */ }
	}

	// ─── Per-agent input area state persistence ──────────────────────────
	// Persist chatMode / provider / model / composerText per agent so that
	// switching agents or restarting the client restores the full input-area
	// state. Uses localStorage with agent-scoped keys.

	private _storageKey(baseKey: string): string {
		return `${baseKey}:${this._currentAgentId ?? 'global'}`;
	}

// ─── Per-session composer draft persistence ──────────────────────────
// 输入框草稿按 session 隔离（saros:composerText:{agentId}:{sessionId}）：
// 切换 session 时保存旧草稿、恢复目标草稿（无草稿则清空输入框）；
// 输入过程经 onComposerTextChange debounce 400ms 实时落盘。
// chatOnly / provider / model 仍为 per-agent 偏好（见 _saveInputAreaState）。

private _composerDraftTimer: number | null = null;

private _composerDraftKey(agentId: string, sessionId: string): string {
	return `${NativeChatEditorPane._STORAGE_COMPOSER_TEXT}:${agentId}:${sessionId}`;
}

/** 保存当前输入框草稿到指定 session（默认当前；空文本则清除 key）。 */
private _saveComposerDraft(agentId = this._currentAgentId, sessionId = this._currentSessionId): void {
	if (!agentId || !sessionId) { return; }
	try {
		const key = this._composerDraftKey(agentId, sessionId);
		const text = this._chatPanel?.getComposerText?.() ?? '';
		if (text.trim().length > 0) {
			localStorage.setItem(key, text);
		} else {
			localStorage.removeItem(key);
		}
	} catch { /* localStorage may be unavailable */ }
}

/** 恢复当前 session 的输入框草稿；无草稿时清空输入框（per-session 隔离的核心）。
 *  向后兼容：旧 per-agent key（无 sessionId 段）存在时迁移一次并删除。 */
private _restoreComposerDraft(): void {
	if (!this._currentAgentId || !this._chatPanel) { return; }
	try {
		let savedText: string | null = null;
		if (this._currentSessionId) {
			const key = this._composerDraftKey(this._currentAgentId, this._currentSessionId);
			savedText = localStorage.getItem(key);
			if (!savedText) {
				const legacyKey = this._storageKey(NativeChatEditorPane._STORAGE_COMPOSER_TEXT);
				const legacy = localStorage.getItem(legacyKey);
				if (legacy) {
					localStorage.setItem(key, legacy);
					localStorage.removeItem(legacyKey);
					savedText = legacy;
				}
			}
		}
		const text = savedText && savedText.trim().length > 0 ? savedText : '';
		// deferred — _renderInputArea must have run first
		requestAnimationFrame(() => {
			this._chatPanel?.setComposerText?.(text);
		});
	} catch { /* localStorage may be unavailable */ }
}

/** 输入时 debounce 保存草稿（400ms），避免窗口关闭/崩溃丢失未发送内容。 */
private _scheduleSaveComposerDraft(): void {
	if (this._composerDraftTimer !== null) { clearTimeout(this._composerDraftTimer); }
	this._composerDraftTimer = window.setTimeout(() => {
		this._composerDraftTimer = null;
		this._saveComposerDraft();
	}, 400);
}

/** Save all input-area state for the current agent. */
private _saveInputAreaState(): void {
	if (!this._currentAgentId) { return; }
	try {
		localStorage.setItem(this._storageKey(NativeChatEditorPane._STORAGE_CHAT_ONLY), String(this._currentChatOnly));
		localStorage.setItem(this._storageKey(NativeChatEditorPane._STORAGE_CHAT_MODE), this._currentChatMode);
		// 使用面板本地状态（不读共享 _modelSelector）
		if (this._localProviderId) {
			localStorage.setItem(this._storageKey(NativeChatEditorPane._STORAGE_PROVIDER), this._localProviderId);
		}
		if (this._localModelId) {
			localStorage.setItem(this._storageKey(NativeChatEditorPane._STORAGE_MODEL), this._localModelId);
		}
	// Composer 草稿按 session 隔离保存（per-session）
	this._saveComposerDraft();
} catch { /* localStorage may be unavailable */ }
}

	/** Restore all input-area state for the current agent. Call after setAgent(). */
	private _restoreInputAreaState(): void {
		if (!this._currentAgentId || !this._chatPanel) { return; }
		try {
			// Restore chatOnly (default: false)
			const savedChatOnly = localStorage.getItem(this._storageKey(NativeChatEditorPane._STORAGE_CHAT_ONLY));
			const chatOnly = savedChatOnly === 'true';
			this._currentChatOnly = chatOnly;
			this._chatPanel.setChatOnly(chatOnly);

			// Restore chatMode（默认 craft）。只接受 3 个合法值，
			// 防历史遗留/手改 localStorage 写入 'workflow' 等非法档位。
			const savedChatMode = localStorage.getItem(this._storageKey(NativeChatEditorPane._STORAGE_CHAT_MODE));
			const chatMode = (savedChatMode === 'ask' || savedChatMode === 'plan') ? savedChatMode : 'craft';
			this._currentChatMode = chatMode;
			this._chatPanel.setChatMode?.(chatMode);

			// Restore provider + model to 面板本地状态（不写共享 _modelSelector）
			const savedProvider = localStorage.getItem(this._storageKey(NativeChatEditorPane._STORAGE_PROVIDER));
			const savedModel = localStorage.getItem(this._storageKey(NativeChatEditorPane._STORAGE_MODEL));
			if (savedProvider && savedModel) {
				this._localProviderId = savedProvider;
				this._localModelId = savedModel;
				this._chatPanel.setCurrentProvider(savedProvider);
				this._chatPanel.setCurrentModel(savedModel);
			} else {
				// 无本地覆盖时，使用 Agent 配置的默认 provider/model
				void this._applyAgentDefaultModelSelection();
			}

		// Restore composer draft (per-session；无草稿时清空输入框)
		this._restoreComposerDraft();
	} catch { /* localStorage may be unavailable */ }
}

/** 无本地保存的模型选择时，应用 Agent 在设置页配置的默认 provider/model */
private async _applyAgentDefaultModelSelection(): Promise<void> {
	if (!this._currentAgentId) { return; }
	try {
		const agent = await this._agentStudioService.getAgent(this._currentAgentId);
		// 只要 agent 配置了 model 就应用（不再强制要求 providerId 同时存在）。
		// 历史 bug（2026-08-17 日志 1786937164284）：`agent?.providerId && agent?.model`
		// 要求两者同时存在，但自定义 agent 的 .agent.md 往往只写 `model` 不写 `providerId`
		// （如 saros-chatbox-agent），导致 agent 配置的模型从未生效，回退到全局默认模型。
		// providerId 为空时只设置 model，provider 由下游按 model 反查/保持默认。
		if (agent?.model) {
			this._localModelId = agent.model;
			this._chatPanel?.setCurrentModel(agent.model);
			if (agent.providerId) {
				this._localProviderId = agent.providerId;
				this._chatPanel?.setCurrentProvider(agent.providerId);
			}
			this._logService.info(`[NativeChatEditorPane#${this._paneId}] _applyAgentDefaultModelSelection: agentId=${this._currentAgentId} providerId=${agent.providerId ?? '(none)'} model=${agent.model}`);
		} else {
			this._logService.debug(`[NativeChatEditorPane#${this._paneId}] _applyAgentDefaultModelSelection: agentId=${this._currentAgentId} has no model configured, keeping current provider/model`);
		}
	} catch (err) { this._logService.warn('[NativeChatEditorPane] _applyAgentDefaultModelSelection failed:', err); }
}

	/** 从 localStorage 恢复压缩基线（窗口重载后 token 进度条保持压缩后数值）。
	 *  新会话或无压缩历史时清除基线，避免残留旧值。 */
	private _restoreCompactedBaseline(): void {
		if (!this._currentAgentId || !this._currentSessionId) {
			this._chatPanel?.setCompactedBaseline(0);
			return;
		}
		try {
			const key = `saros:compactedBaseline:${this._currentAgentId}:${this._currentSessionId}`;
			const saved = localStorage.getItem(key);
			if (saved) {
				const baseline = parseInt(saved, 10);
				if (baseline > 0) {
					this._chatPanel?.setCompactedBaseline(baseline);
					return;
				}
			}
		} catch { /* localStorage may be unavailable */ }
		// 无保存的基线 → 重置为 0（新会话或从未压缩过）
		this._chatPanel?.setCompactedBaseline(0);
	}

	// ---------- checkpoint wiring (aligned with ChatBarPart) ----------

	/**
	 * Ensures a concrete agent id + session id is available before a send.
	 *
	 * Session id convergence: the various layers (`_currentSessionId`,
	 * `AgentSessionMeta.id`, checkpoint session, provider session) all refer to
	 * the same logical agent session. If the UI never resolved one (e.g. agent
	 * load failed), we lazily create/resolve it via `getOrCreateActiveSession`
	 * so the stream is never persisted into the agent-only "noSession bucket",
	 * which historically caused history cross-talk between sessions.
	 */
	/**
	 * 活跃 chat 变化时的处理：重载聊天面板的消息历史。
	 *
	 * - 同一 agent 下的多 chat 切换：仅重载消息，不切换 agent
	 * - 新建 chat（untitled）：清空面板 + 聚焦输入框
	 * - 首次激活：不触发（避免与 _initChatPanel 的初始加载冲突）
	 */
	/** 公共入口：聚焦聊天输入框（供 preset 点击聊天按钮后聚焦用）。 */
	focusInput(): void {
		this._chatPanel?.focusInput();
	}

	// ─── Tab status indicator helpers ──────────────────────────────────

	/**
	 * Apply a stream phase to BOTH the chat panel UI and the editor tab
	 * status dot. Wraps {@link AgentChatPanel.setStreamPhase} so every phase
	 * transition also updates {@link NativeChatEditorInput.setTabStatus}.
	 *
	 * Mapping:
	 *  - llm_streaming / tool_executing → 'running' (green)
	 *  - error                          → 'error'   (red)
	 *  - idle                           → 'pending' if tab not active, else 'idle'
	 */
	private _applyStreamPhase(phase: string): void {
		this._chatPanel?.setStreamPhase(phase as any);
		this._updateTabStatusForPhase(phase);
	}

	/**
	 * 计算「用户已取消」最终内容：已有真实内容则追加提示，否则仅提示。
	 * 幂等：若内容已含取消标记则原样返回，避免 onCancelExecution 立即更新
	 * 与滞后到达的 done(canceled:true) 事件重复追加「用户已取消」。
	 */
	private _buildCanceledContent(assistantMsg: IAgentChatMessage): string {
		const currentContent = assistantMsg.content || '';
		const marker = '⚠️ 用户已取消';
		if (currentContent.includes(marker)) {
			return currentContent;
		}
		const hasRealContent = currentContent.trim().length > 0
			&& !/^[\s\S]*?(正在思考|Thinking\.\.\.)$/m.test(currentContent.trim());
		return hasRealContent ? currentContent + '\n\n' + marker : marker;
	}

	/**
	 * 初始化流式 assistant 消息：创建带 isThinking=true 的占位消息并存入共享字段。
	 * 由 _sendMessageInternal（本地发送）开始时和 onDidStreamDelta（外部发送）首个 delta 到达时调用。
	 */
	private _initStreamingMessage(): void {
		if (this._streamingAssistantId) {
			// ★ 2026-08-27 诊断（多聊天框 UI 不刷新，日志 20260827T173319/window1）：
			// 上一次发送的流尚未收尾（_streamingAssistantId 未清空）就又发起新发送时，
			// 新流无法创建自己的气泡，其 delta 会被 _processDelta 追加到【旧消息】上
			// （或直接因 assistantMsg 被 reset 而丢弃）→ 表现为「发了消息但 UI 不刷新」。
			// 此处打点，便于下次复现时确认该路径是否被触发。
			this._logService.warn(
				`[NativeChatEditorPane#${this._paneId}] _initStreamingMessage SKIPPED — stale streaming msg ` +
				`${this._streamingAssistantId} (session=${this._currentSessionId}, isSending=${this._isSending}, ` +
				`isExternalSend=${this._isExternalSend}). New turn content may not render.`
			);
			return;
		}
		const id = `msg_${Date.now()}_assistant`;
		const msg: IAgentChatMessage = {
			id,
			role: 'assistant',
			content: '',
			// P0: 跟踪文本→工具→文本的时间顺序，供 deriveUiMessageParts
			// 在最终渲染时按实际出现顺序交插文本和工具卡片。
			parts: [],
			timestamp: Date.now(),
			isStreaming: true,
			isThinking: true,
			streamPhase: 'llm_streaming',
			turnId: `turn_${Date.now()}`,
		};
	this._chatPanel?.addMessage(msg);
	this._streamingAssistantId = id;
	this._streamingAssistantMsg = msg;
	// 新流式消息：重置当前 text 段起点
	this._streamTextSegmentBase = 0;
	// 流式记录：会话开始（未启用时零开销）
	this._streamRecorder?.begin({
		agentId: this._currentAgentId ?? 'unknown',
		sessionId: this._currentSessionId ?? undefined,
		chatId: this._currentInputChatId ?? undefined,
		startedAt: Date.now(),
	}, `p${this._paneId}`);
}

	/**
	 * 清理流式状态：done/error 后调用，避免下次流式时残留旧引用。
	 */
	private _resetStreamingMessage(): void {
		this._streamingAssistantId = null;
		this._streamingAssistantMsg = null;
		// P0: 清空 delta 缓冲区——新流式会话从零开始
		if (this._deltaFlushTimer !== null) {
			clearTimeout(this._deltaFlushTimer);
			this._deltaFlushTimer = null;
		}
		this._deltaBuffer = [];
		this._lastFlushedTextContent = '';
		this._streamTextSegmentBase = 0;
	}

	/**
	 * 共享的流式 delta 处理方法。
	 * 供 _sendMessageInternal 回调（本地发送）和 onDidStreamDelta 监听器（外部发送，如看板任务）共同调用。
	 * 读取/更新 _streamingAssistantId 和 _streamingAssistantMsg 共享字段。
	 *
	 * 调用前必须确保：
	 * 1. 已通过 _initStreamingMessage() 初始化流式消息
	 * 2. _isSending=true（按钮处于 stop 状态）
	 */
	/**
	 * Delta 处理入口（带 P0 缓冲层）。
	 *
	 * text / thinking / tool_* / usage / memory / phase_change →
	 *   缓冲 25ms 后批量分发（text 只保留最后一个）。
	 * done / error →
	 *   立即清空缓冲区 + 处理（保证 UI 快速响应错误/结束）。
	 *
	 * 调用须知：
	 * 1. 已通过 _initStreamingMessage() 初始化流式消息
	 * 2. _isSending=true（按钮处于 stop 状态）
	 */
private _handleStreamDelta(delta: any): void {
	if (!delta) { return; }

	// 流式记录：原始 delta 落盘（缓冲合并前，保真）
	this._streamRecorder?.record(delta);
	if (delta.type === 'done' || delta.type === 'error') {
		void this._streamRecorder?.end(delta.type);
	}

	// ═══ PerfDiag: delta 接收追踪 ═══
		{
			const now = Date.now();
			if (!this._streamPerf) {
				this._streamPerf = { startTime: now, deltaCount: 0, slowOps: [], totalTypes: {} as Record<string, number> };
			}
			const pf = this._streamPerf;
			pf.deltaCount++;
			pf.totalTypes[delta.type] = (pf.totalTypes[delta.type] || 0) + 1;
			if (pf.deltaCount <= 10 || pf.deltaCount % 100 === 0) {
				this._logService.trace(`[StreamPerf] delta #${pf.deltaCount} type=${delta.type} queue=${this._deltaBuffer.length} elapsed=${now - pf.startTime}ms`);
			}
		}

		// done / error — 立即清空缓冲区后处理，保证 UI 即时响应
		if (delta.type === 'done' || delta.type === 'error') {
			this._flushDeltaBuffer();
			this._processDelta(delta);
			// ═══ PerfDiag: 流式结束汇总 ═══
			if (this._streamPerf) {
				const pf = this._streamPerf;
				const totalElapsed = Date.now() - pf.startTime;
				const typeBreakdown = Object.entries(pf.totalTypes).sort((a, b) => b[1] - a[1]).slice(0, 8)
					.map(([t, c]) => `${t}=${c}`).join(',');
				const slowCount = pf.slowOps.length;
				this._logService.info(`[StreamPerf] STREAM_END total=${totalElapsed}ms deltas=${pf.deltaCount} types={${typeBreakdown}} slowFlushes=${slowCount}`);
				delete this._streamPerf;
			}
			return;
		}

		// 缓冲区排入
		this._deltaBuffer.push({ type: delta.type, delta });

		// 已有排期 timer 就不重复设
		if (!this._deltaFlushTimer) {
			this._deltaFlushTimer = setTimeout(() => {
				this._flushDeltaBuffer();
			}, NativeChatEditorPane.DELTA_FLUSH_INTERVAL_MS);
		}
	}

	/**
	 * P0 缓冲层：合并同帧 / 相邻帧的 delta 并成批分发。
	 *
	 * 规则：
	 * - text delta 链 → 只保留最后一个（包含完整累计内容，fullText 或 content 累加）
	 * - 其它 delta → 保留全部，按原始顺序
	 */
	private _flushDeltaBuffer(): void {
		const flushStart = Date.now();

		if (this._deltaFlushTimer !== null) {
			clearTimeout(this._deltaFlushTimer);
			this._deltaFlushTimer = null;
		}
		const batch = this._deltaBuffer;
		this._deltaBuffer = [];
		if (this._streamPerf) {
			this._streamPerf.lastFlushTime = flushStart;
			this._streamPerf.lastFlushBatchSize = batch.length;
		}
		if (batch.length === 0) { return; }

		// 合并：连续 text delta 链压缩为一条，减少同帧 DOM 更新次数。
		// ⚠️ 关键修复（流式内容错乱/乱码，2026-07-13）：
		//   本地 native pane 经 sendMessage(onDelta) 收到的 text delta 是**增量**片段
		//   （delta.content = 本次新增文本，且**不带** delta.fullText）。旧逻辑「只保留
		//   连续链的最后一个」是按「每个 text delta 都携带全量快照 fullText」设计的，
		//   在增量模式下会**丢弃链中间所有片段**——幸存的相邻片段直接拼接成乱码
		//   （如 "16px" +（丢失）+ "chrome-bg" → "16pxrome-bg"；"flex" +（丢失）+
		//   "top bar" → "flextopbar"），正是日志中「成长中的本文已经文字化け」的根因。
		//   修复：增量模式下把整条链的 content **按序拼接**成一条合并 delta（内容零丢失，
		//   仍只触发一次 _processDelta）；仅当 delta 携带 fullText（全量快照，如 webview
		//   经 controller 注入）时才安全地只取最后一个。
		const merged: Array<{ type: string; delta: any }> = [];
		for (let i = 0; i < batch.length; i++) {
			const item = batch[i];
			if (item.type !== 'text') {
				merged.push(item);
				continue;
			}
			// 找到连续 text delta 链 [i, lastTextIdx]
			let lastTextIdx = i;
			for (let j = i + 1; j < batch.length; j++) {
				if (batch[j].type === 'text') { lastTextIdx = j; }
				else { break; }
			}
			const lastText = batch[lastTextIdx];
			const hasFullText = lastText.delta.fullText !== undefined;
			let mergedDelta = lastText.delta;
			let textContent: string;
			if (hasFullText && lastText.delta.fullText.length >= (this._streamingAssistantMsg?.content ?? '').length) {
				// 全量快照模式：最后一个 delta 已含完整内容，直接取用。
				textContent = lastText.delta.fullText;
			} else {
				// 增量模式：拼接链上所有片段，避免丢失中间内容造成乱码。
				let combined = '';
				for (let k = i; k <= lastTextIdx; k++) {
					if (batch[k].type === 'text') {
						combined += (batch[k].delta.content ?? '');
					}
				}
				if (lastTextIdx > i) {
					// 用合并后的 content 生成新 delta（保留其余字段），仅触发一次 _processDelta。
					mergedDelta = { ...lastText.delta, content: combined };
					this._logService.trace(
						`[NativeChatEditorPane] flush: merged ${lastTextIdx - i + 1} incremental text deltas → combinedLen=${combined.length}`,
					);
				}
				textContent = (this._streamingAssistantMsg?.content ?? '') + combined;
			}
			// 跳过与上一批完全相同的 text（去重）
			if (textContent !== this._lastFlushedTextContent) {
				merged.push({ type: 'text', delta: mergedDelta });
				this._lastFlushedTextContent = textContent;
			}
			i = lastTextIdx;
		}

		// 成批分发
		let processedCount = 0;
		for (const item of merged) {
			const t0 = Date.now();
			this._processDelta(item.delta);
			const dt = Date.now() - t0;
			processedCount++;
			if (dt > 16 && this._streamPerf) {
				this._streamPerf.slowOps.push({ type: item.delta.type, elapsed: dt, count: this._streamPerf.deltaCount });
			}
		}
		const totalTime = Date.now() - flushStart;
		if (totalTime > 16 && this._streamPerf) {
			this._logService.warn(`[StreamPerf] SLOW_FLUSH batch=${batch.length} merged=${merged.length} processed=${processedCount} total=${totalTime}ms ` +
				`delays=${this._streamPerf.slowOps.slice(-3).map(o => o.type + '/' + o.elapsed + 'ms').join(',')}`);
		} else {
			this._logService.trace(`[StreamPerf] flush batch=${batch.length} merged=${merged.length} total=${totalTime}ms`);
		}
	}

	/**
	 * 将 subagent 数据附加到父工具调用的 tc.subAgents 字段。
	 * 替代旧的 _upsertSubAgentCards（创建独立 subagent parts）——
	 * subagent 数据现在内嵌在工具卡中，不再创建独立的 subagent parts。
	 */
	private _attachSubAgentsToToolCall(assistantMsg: any, saData: any[], realToolCallId?: string): void {
		if (!saData || saData.length === 0) { return; }
		if (realToolCallId) {
			const parentTc = (assistantMsg.toolCalls ?? []).find((tc: any) => tc.id === realToolCallId);
			if (parentTc) {
				parentTc.subAgents = saData;
			}
		}
		assistantMsg.subAgents = saData;
	}

	/**
	 * 将累积的 subagent 数据重映射并挂载到【各自对应】的 delegate_task/plan_explore 工具卡。
	 *
	 * 2026-07-27 修复（bug：并行多 delegate_task 时所有 subagent 卡片全挤在最后一张卡）：
	 * delegationTools.ts 的 handler 拿不到 LLM 分配的真实 callId，只能自造内部
	 * `delegate_<ts>_<rand>` 作为 parentToolCallId，与工具卡真实 callId 不匹配。
	 * 旧逻辑回退到【单值】`_lastDelegateToolCallId`——tool_start 触发 N 次后它只剩
	 * 最后一个 delegate 的 callId，于是 N 个 delegate 的 subagent 全被重映射到最后一张卡。
	 *
	 * 新逻辑：按【内部 parentToolCallId 分组】（每个 delegate handler 一个唯一内部 id），
	 * 每组独立分配到一张 delegate 卡：① 优先按 task 文本匹配（sa.task 与工具卡
	 * args.task/tasks[] 同源）；② 退化到尚未被占用的 delegate 卡（FIFO，杜绝挤到最后一张）；
	 * ③ 最终退化到 _lastDelegateToolCallId。usedTc 防止两组映射到同一张卡。
	 */
	private _remapAndAttachSubAgents(assistantMsg: any): void {
		const subAgents = (assistantMsg.subAgents ?? []) as any[];
		if (subAgents.length === 0) { return; }
		const delegateTcs = ((assistantMsg.toolCalls ?? []) as any[]).filter(
			(tc: any) => tc?.name === 'delegate_task' || tc?.name === 'plan_explore' || tc?.name === 'workflow');
		if (delegateTcs.length === 0) { return; }

		// 已占用的真实工具卡（subagent 已直接指向真实 callId 的）
		const usedTc = new Set<string>();
		for (const sa of subAgents) {
			const pid = sa?.parentToolCallId;
			if (pid && delegateTcs.some((tc: any) => tc.id === pid)) { usedTc.add(pid); }
		}

		// 按内部 parentToolCallId 分组（跳过已指向真实卡片的）
		const internalGroups = new Map<string, any[]>();
		for (const sa of subAgents) {
			const pid = sa?.parentToolCallId;
			if (!pid) { continue; }
			if (delegateTcs.some((tc: any) => tc.id === pid)) { continue; }
			let g = internalGroups.get(pid);
			if (!g) { g = []; internalGroups.set(pid, g); }
			g.push(sa);
		}

		for (const group of internalGroups.values()) {
			const probeTask = group[0]?.task;
			// ① task 文本匹配未占用卡
			let target = delegateTcs.find((tc: any) => !usedTc.has(tc.id)
				&& this._delegateTaskKeys(tc).some(k => this._taskKeyMatch(probeTask, k)));
			// ② FIFO：任一未占用卡
			if (!target) { target = delegateTcs.find((tc: any) => !usedTc.has(tc.id)); }
			// ③ 兜底：最近一次 delegate callId
			if (!target && this._lastDelegateToolCallId) {
				target = delegateTcs.find((tc: any) => tc.id === this._lastDelegateToolCallId);
			}
			if (target) {
				usedTc.add(target.id);
				for (const sa of group) { sa.parentToolCallId = target.id; }
			}
		}

		// 按最终 parentToolCallId 分组挂载到各工具卡
		for (const tc of delegateTcs) {
			const own = subAgents.filter((s: any) => s?.parentToolCallId === tc.id);
			if (own.length > 0) { tc.subAgents = own; }
		}
	}

	/** 从 delegate_task/plan_explore 工具卡的 args 提取 task 文本（支持 JSON、纯文本、tasks[]）。 */
	private _delegateTaskKeys(tc: any): string[] {
		const keys: string[] = [];
		const raw = tc?.args;
		let a: any = undefined;
		if (typeof raw === 'string' && raw.length > 0) {
			try { a = JSON.parse(raw); } catch { keys.push(raw); }
		} else if (raw && typeof raw === 'object') {
			a = raw;
		}
		if (a) {
			if (typeof a.task === 'string') { keys.push(a.task); }
			if (Array.isArray(a.tasks)) {
				for (const t of a.tasks) {
					keys.push(typeof t === 'string' ? t : String(t?.task ?? t?.description ?? ''));
				}
			}
		}
		return keys.filter(k => k && k.length > 0);
	}

	/** task 文本前缀匹配（sa.task 可能被截断为 200 字符，故按公共前缀比较）。 */
	private _taskKeyMatch(a: string | undefined, b: string | undefined): boolean {
		if (!a || !b) { return false; }
		const n = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
		const x = n(a), y = n(b);
		if (!x || !y) { return false; }
		const len = Math.min(x.length, y.length, 100);
		if (len < 8) { return x === y; }  // 太短要求全等，避免误匹配
		return x.slice(0, len) === y.slice(0, len);
	}

	/**
	 * 实际 delta 处理逻辑（已去缓冲）。
	 * 从原 _handleStreamDelta 的 switch-case 体提取。
	 */
	private _processDelta(delta: any): void {
		const assistantId = this._streamingAssistantId;
		const assistantMsg = this._streamingAssistantMsg;

		// Inter-turn safety net: 如果 _isSending 因某种原因被置 false
		// （如错误、取消、或 done 之后），当新一轮 agent loop 真正有
		// 交互性 delta 到来时，重新激活 sending 状态，确保按钮显示
		// stop 图标、输入框禁用、流式滚动路径生效。
		//
		// ⚠ 2026-08-20：本 safety net 曾是「文字逐 token 重叠」的诱因之一——
		// 它只恢复 `_isSending` 而不管 `_isExternalSend`，使旧守卫
		// （`_isSending && !_isExternalSend`）的两个判据可能处于矛盾状态。
		// 现在双重处理已由 `_localSendActiveSessionId` 独占守卫从源头阻断
		// （见该字段注释），此处额外保证：**本地发送仍活跃时不得改写发送态标志**，
		// 避免本 safety net 与本地发送流程互相覆盖。
		if (!this._isSending && this._localSendActiveSessionId === null) {
			const reActivateTypes = ['text', 'thinking', 'tool_start', 'tool_args', 'tool_end', 'tool_result', 'tool_progress', 'phase_change'];
			if (reActivateTypes.includes(delta.type)) {
				this._chatPanel?.setSending(true);
				this._isSending = true;
			}
		}

		switch (delta.type) {
			case 'text':
				if (!assistantMsg || !assistantId) { return; }
				{
					// fullText 比 content 短时回退到 append 模式
					// （agentStudioWebviewController 检测到 tool XML 后会重置 streamingTextBuffer，
					// 导致后续 fullText 只含工具标签后的文本，无脑替换会清空冒泡内容）
					const textContent = (delta.fullText !== undefined && delta.fullText.length >= assistantMsg.content.length)
						? delta.fullText
						: (assistantMsg.content + (delta.content ?? ''));
				assistantMsg.content = textContent;
				this._applyStreamPhase('llm_streaming');
				this._chatPanel?.setStreamTextBuffer(textContent);
				// 正文恢复流出 → 参数生成进度文本已过期，清除（若存在）
				if (assistantMsg.activityText !== undefined) { assistantMsg.activityText = undefined; }
				this._chatPanel?.updateMessage(assistantId, {
					content: textContent,
					activityText: assistantMsg.activityText,
					isStreaming: true,
					isThinking: false,
					streamPhase: 'llm_streaming',
				});
					// P0: 跟踪文本→工具→文本的时间顺序。
					// text part 只保存「当前段」文本 = content.slice(_streamTextSegmentBase)，
					// 而非全量 content——否则工具后的新 text part 会重复包含工具前的文本，
					// 导致同一段文本在工具卡前后渲染两次。
					if (assistantMsg.parts) {
						const segText = textContent.slice(this._streamTextSegmentBase);
						const last = assistantMsg.parts[assistantMsg.parts.length - 1];
						if (last && last.kind === 'text') {
							// 最后一个 part 是 text → 就地更新当前段
							(last as any).text = segText;
						} else if (segText.length > 0) {
							// 最后一个 part 是 tool（或空）→ 开启新 text 段
							assistantMsg.parts.push({ kind: 'text', text: segText } as any);
						}
					}
				}
				break;
			case 'thinking':
				if (!assistantMsg || !assistantId) { return; }
				{
					const prevThinking = assistantMsg.thinking ?? '';
					const thinkingContent = delta.fullThinking !== undefined ? delta.fullThinking : (prevThinking + (delta.content ?? ''));
					assistantMsg.thinking = thinkingContent;
					// thinking 作为 parts 流片段（2026-07-26 用户要求：不固定顶部，
					// 跟随 LLM 流式输出的实际发生位置）。增量追加到当前 episode 的
					// thinking part；若最后一个 part 非 thinking（文本/工具已流过）
					// → 开新 episode（新 part），卡片渲染在当轮内容之前。
					const increment = thinkingContent.slice(prevThinking.length);
					if (assistantMsg.parts && increment.length > 0) {
						const last = assistantMsg.parts[assistantMsg.parts.length - 1] as any;
						if (last && last.kind === 'thinking') {
							last.text += increment;
						} else {
							assistantMsg.parts.push({ kind: 'thinking', text: increment } as any);
						}
					}
					this._chatPanel?.setStreamThinkingBuffer(thinkingContent);
					this._chatPanel?.updateMessage(assistantId, {
						thinking: thinkingContent,
						parts: assistantMsg.parts?.slice(),
						isThinking: true,
					});
				}
				break;
			case 'tool_start': {
				if (!assistantMsg || !assistantId) { return; }
				if (!assistantMsg.toolCalls) { assistantMsg.toolCalls = []; }

				// 清除 tool_progress 期间为 file_write 创建的合成卡片
				const synthId = (assistantMsg as any)._tpFileWriteId as string | undefined;
				if (synthId && delta.toolName === 'file_write') {
					const si = assistantMsg.toolCalls.findIndex((t: any) => t.id === synthId);
					if (si >= 0) { assistantMsg.toolCalls.splice(si, 1); }
					if (assistantMsg.parts) {
						const pi = assistantMsg.parts.findIndex((p: any) => p.kind === 'tool' && p.tool?.id === synthId);
						if (pi >= 0) { assistantMsg.parts.splice(pi, 1); }
					}
					delete (assistantMsg as any)._tpFileWriteId;
				}

				const newToolCallId = delta.toolCallId ?? `tool_${Date.now()}`;
				// ── 同 id 去重（2026-08-22，日志 1787377582459）────────────────────
				// 纵深防御：本层**不能假设上游永不重复发 tool_start**。实测循环检测的
				// 补发路径（agentTurnExecutor 的 loop-detection 分支）会对 adapter 已
				// 发过 tool_start 的同一 id 再补一次，而这里原本是裸 `push()`：
				//   → 同一工具建出 2 张卡 + 2 个 part；
				//   → 后到的 `tool_args` 用 `find()` 只命中**第一张**，第二张永远无参数
				//     → 显示「读取未知文件」/ execute_code 空白卡；
				//   → parts 每轮多涨，domParts 堆积（实测 826 vs 期望 178）→ UI 抖动。
				// 上游已修（只在未发过时补发），此处再兜一道：同 id 视为**同一次调用的
				// 重复 start**，只补齐元数据，绝不新增卡片与 part。
				// ⚠ 仅当 `delta.toolCallId` 存在时去重 —— 缺 id 时上面会生成时间戳兜底
				// id，那本就是「无法关联」的调用，不能按 id 合并。
				if (delta.toolCallId) {
					const existing = assistantMsg.toolCalls.find((tc: any) => tc.id === delta.toolCallId);
					if (existing) {
						// 只补元数据（后到的 delta 可能才带上 displayName/renderType）。
						// 不动 args / status —— 那是 tool_args / tool_end 的职责。
						if (delta.toolName && !existing.name) { existing.name = delta.toolName; }
						if (delta.displayName !== undefined && existing.displayName === undefined) { existing.displayName = delta.displayName; }
						if (delta.renderType !== undefined && existing.renderType === undefined) { existing.renderType = delta.renderType; }
						if (delta.defaultShow !== undefined && existing.defaultShow === undefined) { existing.defaultShow = delta.defaultShow; }
						this._logService.info(`[AgentOS] Ignored duplicate tool_start for callId=${delta.toolCallId} (name=${delta.toolName ?? '?'}) — metadata merged, no new card`);
						break;
					}
				}
				assistantMsg.toolCalls.push({
					id: newToolCallId,
					name: delta.toolName ?? '',
					args: '',
					status: 'running',
					displayName: delta.displayName,
					renderType: delta.renderType,
					defaultShow: delta.defaultShow,
					textPosition: typeof delta.textPosition === 'number' ? delta.textPosition : (assistantMsg.content?.length ?? 0),
				});
				// 记录 delegate_task / plan_explore / workflow 的真实 callId，供 onDidSubAgentTrace
				// 将内部 parentToolCallId 重映射为真实 callId（内嵌 subagent 执行详情）。
				// workflow 是 NEVER_PARALLEL 工具 —— 同一时刻至多一个 run，映射无歧义。
				if (delta.toolName === 'delegate_task' || delta.toolName === 'plan_explore' || delta.toolName === 'workflow') {
					this._lastDelegateToolCallId = newToolCallId;
				}
			this._applyStreamPhase('tool_executing');
			assistantMsg.activityText = undefined;
			// P0: 跟踪文本→工具→文本的时间顺序，push 一个 tool part。
			// 注意：必须先 mutate parts 再 updateMessage 并显式携带 parts——
			// 否则 panel 侧因工具数量变化触发 deriveUiMessageParts 重派生，
			// 虽经兜底保留 thinking parts，但 episode 原位信息会降级为置顶。
			if (assistantMsg.parts) {
				const tcRef = assistantMsg.toolCalls[assistantMsg.toolCalls.length - 1];
				assistantMsg.parts.push({ kind: 'tool', tool: tcRef } as any);
				// 记录当前 content 长度作为下一个 text 段的起点——
				// 后续 text delta 生成的 text part 只含工具之后的增量文本。
				this._streamTextSegmentBase = assistantMsg.content?.length ?? 0;
			}
			this._chatPanel?.updateMessage(assistantId, {
				toolCalls: assistantMsg.toolCalls.slice(),
				// 显式携带 parts（含 thinking episodes），跳过 panel 重派生，
				// 保证 thinking 卡片不移除且保持流式原位（2026-07-26 用户要求）。
				parts: assistantMsg.parts ? assistantMsg.parts.slice() : undefined,
				activityText: undefined,
				isStreaming: true,
				isThinking: false,
				streamPhase: 'tool_executing',
			});
			break;
			}
			case 'tool_progress': {
				// 工具参数流式生成进度（2026-07-26 治本 UI 化）：此前该信号只喂
				// idle 计时器，界面上不可见——超大参数（file_write 写大文件，
				// 万级 tokens 数分钟）期间屏幕假死（事故 1785065604981）。
				// 现把进度文本透到阶段指示器（activityText），每秒可见刷新。
				if (!assistantMsg || !assistantId) { return; }
				assistantMsg.activityText = delta.stage ?? '正在生成工具调用参数…';

				// file_write 参数服务端生成期间（非增量 tool_args）：提前创建合成卡片，
				// 在真实 tool_start 到达前显示「正在生成文件内容…」占位 + KB 进度提示。
				const tpStage = delta.stage || '';
				const tpMatch = tpStage.match(/正在生成工具调用参数\s+(\S+)/);
				const tpToolName = tpMatch?.[1];
				const isFw = tpToolName === 'file_write';
				const hasRealFwCard = assistantMsg.toolCalls?.some(
					(t: any) => t.name === 'file_write' && t.status === 'running' && t.id !== (assistantMsg as any)._tpFileWriteId);
				let toolCallsChanged = false;
				if (isFw && !hasRealFwCard) {
					if (!assistantMsg.toolCalls) { assistantMsg.toolCalls = []; }
					let synthId = (assistantMsg as any)._tpFileWriteId as string | undefined;
					// 首次创建：生成合成工具调用并加入 parts
					if (!synthId || !assistantMsg.toolCalls.some((t: any) => t.id === synthId)) {
						synthId = `_tp_fw_${Date.now()}`;
						(assistantMsg as any)._tpFileWriteId = synthId;
						assistantMsg.toolCalls.push({
							id: synthId, name: 'file_write', args: '', status: 'running',
							displayName: '写入文件', renderType: 'file_write', defaultShow: true,
						});
						if (assistantMsg.parts) {
							const tcRef = assistantMsg.toolCalls[assistantMsg.toolCalls.length - 1];
							assistantMsg.parts.push({ kind: 'tool', tool: tcRef } as any);
						}
						toolCallsChanged = true;
					}
					// 后续进度：仅通过 activityText 刷新 KB 计数（卡片本身占位不变）
				}
				this._chatPanel?.updateMessage(assistantId, {
					activityText: assistantMsg.activityText,
					isStreaming: true,
				...(toolCallsChanged ? {
					toolCalls: (assistantMsg.toolCalls ?? []).slice(),
					parts: assistantMsg.parts?.slice(),
				} : {}),
				});
				break;
			}
			case 'tool_args': {
				if (!assistantMsg || !assistantId) { return; }
				const argCall = (assistantMsg.toolCalls ?? []).find((tc: any) => tc.id === delta.toolCallId);
				if (argCall) {
					argCall.args = (argCall.args ?? '') + (delta.content ?? '');
					this._chatPanel?.updateMessage(assistantId, {
						toolCalls: assistantMsg.toolCalls!.slice(),
						isStreaming: true,
						streamPhase: 'tool_executing',
					});
				}
				break;
			}
			case 'tool_end': {
				if (!assistantMsg || !assistantId) { return; }
				const endCall = (assistantMsg.toolCalls ?? []).find((tc: any) => tc.id === delta.toolCallId);
				if (endCall) {
					// 根据服务端返回的 success 字段决定状态——失败时显示红色警告工具卡而非绿色成功卡。
					const isError = (delta.success === false);
					endCall.status = isError ? 'error' : 'success';
					// 失败时把已写入的 result 同步到 .error，使工具卡底部「错误详情」区域可渲染。
					if (isError && endCall.result && !endCall.error) {
						endCall.error = endCall.result;
					}
				this._applyStreamPhase('llm_streaming');
				// turn 间「正在思考...」指示器（2026-07-26 修正）：指示器条件已放宽为
				// 仅 isThinking（见 agentChatPanel.messages.ts _ensurePhaseIndicator），
				// 无需清空 thinking——旧实现（tool_end 清 thinking）会导致置顶的
				// thinking 卡片在每个工具边界消失/重现，引发布局跳动（1785065604981）。
				this._chatPanel?.updateMessage(assistantId, {
					toolCalls: assistantMsg.toolCalls!.slice(),
					isStreaming: true,
					isThinking: true,
					streamPhase: 'llm_streaming',
				});
				}
				break;
			}
			case 'tool_result': {
				if (!assistantMsg || !assistantId) { return; }
				const resultCall = (assistantMsg.toolCalls ?? []).find((tc: any) => tc.id === delta.toolCallId);
				if (resultCall) {
					resultCall.result = delta.content;
					// 仅在尚未被 tool_end 设为 error 时才默认 success（tool_end 后到的情况）。
					if (resultCall.status === 'running') { resultCall.status = 'success'; }
					this._chatPanel?.updateMessage(assistantId, {
						toolCalls: assistantMsg.toolCalls!.slice(),
					});
				}
				break;
			}
			case 'mode_changed':
				// Legacy mode_changed — no-op since ChatMode is removed.
				// chatOnly is toggled via the UI toggle button directly.
				break;
			case 'discard_prior_text':
				// Hermes-style 合成恢复信号：host 检测到 fake-completion / unfinished-intent /
				// 空回 等"非真实模型输出"并准备注入 nudge 续跑时，会 yield 此事件。
				// AgentDriver / AgentChatService 收到后会清空各自累积缓冲（已确认，
				// 见日志 `cleared rawDeltaChunks + assistantChunks` / `clearing fullContent`）。
				// 但**聊天面板的 _streamingAssistantMsg.content 不会被自动清空**——
				// 这里显式重置，否则 LLM 重新生成时新文本会被追加到旧文本上，
				// 出现 "Re  ReachabilityReachability" 这类重复渲染。
				// 同时清空聊天面板内部的 streamTextBuffer / streamThinkingBuffer 以保持一致。
				if (assistantMsg) {
					assistantMsg.content = '';
					assistantMsg.thinking = '';
					if (assistantId) {
						this._chatPanel?.updateMessage(assistantId, {
							content: '',
							thinking: '',
							isStreaming: true,
							isThinking: true,
							streamPhase: 'llm_streaming',
						});
					}
				}
				this._chatPanel?.setStreamTextBuffer('');
				this._chatPanel?.setStreamThinkingBuffer('');
				this._logService.info(
					`[ChatPanel] 🧹 discard_prior_text: cleared local streaming text/thinking buffer ` +
					`(reason=${delta.metadata?.reason ?? 'unknown'})`
				);
				break;
		case 'subagent_batch':
			// subagent 数据 → 附加到父工具调用的 tc.subAgents（不再创建独立 subagent parts）
			if (assistantMsg && assistantId && (delta as any).subagentData) {
				const saData = (delta as any).subagentData as any[];
				const realToolCallId = (delta as any).toolCallId;
				// 用 delta 携带的真实 toolCallId 覆盖 parentToolCallId
				if (realToolCallId) {
					for (const sa of saData) { if (sa) { sa.parentToolCallId = realToolCallId; } }
				}
				this._attachSubAgentsToToolCall(assistantMsg, saData, realToolCallId);
				this._chatPanel?.updateMessage(assistantId, {
					subAgents: saData,
					isStreaming: true,
				});
			}
			break;
			case 'work_mode_changed': {
				// P2-4 阶段卡：planPhase 合并到显示版 plan_enter/plan_explore 工具卡并重渲染。
				// 跨消息查找（plan_enter 可能在早前 turn 的 assistant 消息上）：
				// getMessages 从后向前，优先 plan_enter、退化 plan_explore。
				// 持久化由 agentChatService delta 管道独立完成（共享引用落盘），此处只管显示。
				const phase = (delta as any).planPhase as { currentStep?: number; planFilePath?: string; completedAt?: number } | undefined;
				if (phase) {
					const messages = this._chatPanel?.getMessages() ?? [];
					let hostMsg: IAgentChatMessage | undefined;
					let hostTc: IToolCall | undefined;
					for (let mi = messages.length - 1; mi >= 0; mi--) {
						const tcs = messages[mi].toolCalls ?? [];
						for (let ti = tcs.length - 1; ti >= 0; ti--) {
							const n = tcs[ti].name;
							if (n === 'plan_enter') { hostMsg = messages[mi]; hostTc = tcs[ti]; break; }
							if (n === 'plan_explore' && !hostTc) { hostMsg = messages[mi]; hostTc = tcs[ti]; }
						}
						if (hostTc?.name === 'plan_enter') { break; }
					}
					if (hostMsg && hostTc) {
						hostTc.planPhase = {
							...(hostTc.planPhase ?? {}),
							...(phase.currentStep !== undefined ? { currentStep: phase.currentStep } : {}),
							...(phase.planFilePath !== undefined ? { planFilePath: phase.planFilePath } : {}),
							...(phase.completedAt !== undefined ? { completedAt: phase.completedAt } : {}),
						};
						this._chatPanel?.updateMessage(hostMsg.id, {
							toolCalls: hostMsg.toolCalls!.slice(),
							isStreaming: hostMsg.id === assistantId,
						} as any);
					}
				}
				break;
			}
			case 'plan_tasks':
				// plan_exit 生成的结构化任务 → 专用任务卡片
				if (assistantMsg && assistantId && (delta as any).planTasksData) {
					const planTasks = (delta as any).planTasksData;
					(assistantMsg as any).planTasks = planTasks;
					this._chatPanel?.updateMessage(assistantId, {
						planTasks,
						isStreaming: true,
					} as any);
				}
				break;
			case 'phase_change':
				if (delta.phase) {
					this._applyStreamPhase(delta.phase);
				}
				if (delta.phase && assistantId) {
					const phasePartial: any = {
						streamPhase: delta.phase,
						isStreaming: delta.phase !== 'idle',
					};
				// 进入 LLM 流式阶段 → 重新激活"正在思考"指示器
				// text delta 到来时（line 2000）会置 isThinking=false 自动隐藏
				if (delta.phase === 'llm_streaming') {
					phasePartial.isThinking = true;
					// 2026-07-26 修正：不再清空 thinking——指示器条件已放宽为仅
					// isThinking；清空会导致置顶 thinking 卡片在轮次边界消失/重现，
					// 引发布局跳动（1785065604981）。卡片跨轮累积、稳定置顶。
				}
					this._chatPanel?.updateMessage(assistantId, phasePartial);
				}
				break;
			case 'confirmation':
				// 安全沙箱受限→渲染确认卡片（暂停等待用户决策）。
				if (assistantMsg && assistantId && delta.confirmationData) {
					assistantMsg.confirmation = delta.confirmationData as any;
					this._chatPanel?.updateMessage(assistantId, {
						confirmation: delta.confirmationData,
						isStreaming: true,
					});
				}
				break;
			case 'confirmation_resolved':
				// 用户已决策 → 更新卡片状态（approved / cancelled）。
				if (assistantMsg && assistantId && assistantMsg.confirmation && delta.confirmationId === assistantMsg.confirmation.id) {
					assistantMsg.confirmation = {
						...assistantMsg.confirmation,
						status: delta.confirmationStatus as 'approved' | 'rejected' | 'cancelled',
					};
					this._chatPanel?.updateMessage(assistantId, {
						confirmation: assistantMsg.confirmation,
					});
				}
				break;
		case 'done': {
			if (assistantMsg && assistantId) {
				const isCanceled = (delta as any).canceled === true;
				if (assistantMsg.toolCalls) {
					for (const tc of assistantMsg.toolCalls) {
						// done 收尾：仍为 running 的工具——2026-07-27 修复（用户报告
						// 「点击取消后工具卡片没展示取消状态」）：取消时 handler 被
						// abort 打断、无 tool_end，此前一律误标 success（绿勾）。
						// 现按 isCanceled 区分：取消 → 'canceled'（卡片显示已取消），
						// 正常完成 → 'success'；已被 tool_end 设为 error 的保留不变。
						if (tc.status === 'running') { tc.status = isCanceled ? 'canceled' : 'success'; }
					}
				}
				const durationMs = Date.now() - (assistantMsg.timestamp || Date.now());
					// 用户主动取消：在 bubble 末尾追加「用户已取消」提示（保留已生成内容）
					// 若是空内容（仅"正在思考..."），则直接显示取消提示作为 content
					const finalContent = isCanceled
						? this._buildCanceledContent(assistantMsg)
						: (assistantMsg.content || '');
					this._applyStreamPhase(isCanceled ? 'canceled' : 'idle');
					// ── Diag: done 时完整 parts 状态 ──
					{
						const partsSummary = (assistantMsg.parts || []).map((p: any) =>
							p.kind === 'text' ? `text(${p.text?.length ?? 0}c)` :
							p.kind === 'tool' ? `tool:${p.tool?.name}(${p.tool?.status})` : p.kind
						).join(' → ');
						this._logService.info(`[PartsDiag] DONE partsLen=${(assistantMsg.parts || []).length} isCanceled=${isCanceled} parts=[${partsSummary}] contentLen=${(assistantMsg.content||'').length} toolCalls=${(assistantMsg.toolCalls || []).length}`);
					}
					// 显式发送最终 content，确保全量重建时读到的不是流式过程中最后一次
					// delta 的残留（可能因增量渲染产生碎片 DOM）。
					assistantMsg.activityText = undefined;
					this._chatPanel?.updateMessage(assistantId, {
						content: finalContent,
						activityText: undefined, // 流式结束清除瞬时活动文本
						// P0: 仅当 toolCalls 非空时才发送——空数组会通过 Object.assign
						// 覆盖掉之前迭代累积的 tool call，导致最终重建时工具卡全部消失。
						toolCalls: assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0
							? assistantMsg.toolCalls.slice()
							: undefined,
						// P0: 若流式期间已按时间顺序跟踪 parts 列表，直接发送，
						// 避免 deriveUiMessageParts 依赖跨迭代失效的 textPosition。
						parts: assistantMsg.parts && assistantMsg.parts.length > 0
							? assistantMsg.parts.slice()
							: undefined,
						isStreaming: false,
						isThinking: false,
						streamPhase: isCanceled ? 'canceled' : 'idle',
						metadata: { ...(assistantMsg.metadata || {}), durationMs },
					});
					// 持久化 durationMs + tokenUsage（积分）到历史，使重新加载后 footer 仍能展示耗时和积分
					if (this._currentAgentId && this._currentSessionId) {
						void this._chatService.updateMessage(
							this._currentAgentId,
							this._currentSessionId,
							assistantId,
							{
								content: finalContent,
								metadata: { ...(assistantMsg.metadata || {}), durationMs },
								tokenUsage: assistantMsg.tokenUsage,
							},
						).catch(err => {
							this._logService.warn('[NativeChatEditorPane] Failed to persist done message:', err);
						});
					}
				}
				// ⚠️ 不在此处调用 _resetStreamingMessage() — agent loop 中每次 LLM turn
				// 结束都会 yield done，如果重置流式状态，下一轮 LLM delta 到达时
				// _streamingAssistantId 为 null，delta 被丢弃。_resetStreamingMessage()
				// 由调用方在最终 done（整个 agent loop 结束）后调用。
				break;
			}
			case 'error':
				if (assistantId && assistantMsg) {
					this._applyStreamPhase('error');
					// LLM provider 错误（如 HTTP 400/429/超时等）→ 渲染为合成错误工具卡，
					// 而非追加到 message.content 渲染为文本气泡（避免「错误文本 + 耗时」两个独立气泡）。
					const errorText = typeof delta.content === 'string' ? delta.content : '执行失败';
					const errorId = `__llm_error_${delta.toolCallId ?? Date.now()}`;
					const syntheticToolCall = {
						id: errorId,
						name: 'llm_error',
						displayName: '模型调用错误',
						status: 'error' as const,
						error: errorText,
						result: errorText,
						defaultShow: true,
					};
					// 合并到现有 toolCalls，去重同名同 ID 的合成卡（防止 done/error 多 delta 重复添加）
					const existing = (assistantMsg.toolCalls ?? []).filter(
						(tc: any) => !(tc?.id === errorId || (tc?.name === 'llm_error' && tc?.error === errorText))
					);
					assistantMsg.toolCalls = [...existing, syntheticToolCall];
					this._chatPanel?.updateMessage(assistantId, {
						toolCalls: [...existing, syntheticToolCall],
						isStreaming: false,
						isThinking: false,
						streamPhase: 'error',
					});
				} else if (assistantId) {
					// 无 assistantMsg 上下文时回退到原行为
					this._applyStreamPhase('error');
					this._chatPanel?.updateMessage(assistantId, {
						isStreaming: false,
						isThinking: false,
						streamPhase: 'error',
						content: ((assistantMsg?.content) || '') + `\n\n⚠️ ${typeof delta.content === 'string' ? delta.content : '执行失败'}`,
					});
				}
				this._chatPanel?.setSending(false);
				this._isSending = false;
				this._isExternalSend = false;
				this._localSendDone = true; // 标记本地发送已结束，防止广播 delta 误触发二次 _initStreamingMessage
				this._taskExecutingSessionId = null;
				this._resetStreamingMessage();
				break;
		case 'usage':
			if (delta.usage && assistantMsg && assistantId) {
				// usage delta 每个 LLM 轮次末块各发一次（CodeBuddy data part / Knot step end，
				// 值为本轮聚合）。多轮 agent loop 时 footer 应展示全程总消耗——与
				// agentChatService 持久化路径一致做累加（原实现为覆盖，多轮时丢失前轮
				// token 统计与积分 credit，导致积分 pill 不显示）。
				const prev = assistantMsg.tokenUsage;
				const input = (prev?.input ?? 0) + (delta.usage.inputTokens ?? 0);
				const output = (prev?.output ?? 0) + (delta.usage.outputTokens ?? 0);
				const total = (prev?.total ?? 0) + (delta.usage.totalTokens ?? ((delta.usage.inputTokens ?? 0) + (delta.usage.outputTokens ?? 0)));
				const cachedRead = (prev?.cachedRead ?? 0) + (delta.usage.cachedTokens ?? 0);
				const cacheWrite = (prev?.cacheWrite ?? 0) + (delta.usage.cacheWriteTokens ?? 0);
				const creditSum = (prev?.credit ?? 0) + (delta.usage.credit ?? 0);
				// 2026-07-27：credit 是否"曾经出现过"（哪怕值为 0）与"从未提供"需区分——
				// 否则免费/未计费模型的 credit=0 会被误判为"无数据"而不展示占位 pill。
				const creditSeen = prev?.credit !== undefined || typeof delta.usage.credit === 'number';
			const cacheMiss = Math.max(0, input - cachedRead - cacheWrite);
			const cacheHitRate = input > 0 ? (cachedRead / input) * 100 : 0;
			// reasoning 不再硬编码 0：usage delta 现已携带 reasoning_tokens（OpenAI 系），
			// 与子代理 subagentTokenCollector.reasoningTokens 口径对齐
			const reasoning = (prev?.reasoning ?? 0) + (delta.usage.reasoning ?? 0);
			// 2026-08-17 修复「UI 选 A 但实际用 B」：以本次 usage 真实命中的 provider/model 为准。
			// delta.usage.providerId/modelId 由 LMBridge.chat() 内部填入（vendor + 实际请求的
			// modelId），比面板本地 _localModelId 更可信（考虑了 defaultModel 兜底、modelOverride
			// 全局覆盖等场景）。Token 明细 UI 用此字段展示真实命中。
			const realProvider = delta.usage.providerId || this._localProviderId || undefined;
			const realModel = delta.usage.modelId || this._localModelId || undefined;
			const tokenUsage = { input, output, total, cached: cachedRead || undefined, cachedRead: cachedRead || undefined, cacheWrite: cacheWrite || undefined, cacheMiss, reasoning: reasoning || undefined, cacheHitRate, credit: creditSeen ? creditSum : undefined, providerId: realProvider, model: realModel };
				assistantMsg.tokenUsage = tokenUsage;
				this._chatPanel?.updateMessage(assistantId, { tokenUsage });
					const limit = this._currentMaxContextTokens ?? 0;
					if (limit > 0) {
						this._chatPanel?.setStreamUsage({
							input: delta.usage.inputTokens ?? 0,
							output: delta.usage.outputTokens ?? 0,
							seen: true,
						});
					}
				}
				break;
			case 'context_compacted': {
				const compacted = (delta as any).compactedInputTokens ?? 0;
				if (compacted > 0) {
					this._chatPanel?.setCompactedBaseline(compacted);
					this._saveCompactedBaseline(compacted);
				}
				const limit = this._currentMaxContextTokens ?? 0;
				if (limit > 0 && compacted > 0) {
					const ratio = Math.max(0, Math.min(1, compacted / limit));
					this._chatPanel?.setContextUsage({
						used: compacted,
						limit,
						ratio,
						percent: ratio * 100,
					} as IContextUsage);
				}
				const origCount = (delta as any).compressionOriginalCount ?? 0;
				const compCount = (delta as any).compressionCompressedCount ?? 0;
				const tokensSaved = (delta as any).compressionTokensSaved ?? 0;
				const durationMs = (delta as any).compressionDurationMs ?? 0;
				if (origCount > 0 && compCount > 0 && compCount < origCount) {
					this._chatPanel?.addCompressionNotice({
						originalCount: origCount,
						compressedCount: compCount,
						tokensSaved,
						durationMs,
						beforeText: (delta as any).compressionBeforeText,
						afterText: (delta as any).compressionAfterText,
						summary: (delta as any).compressionSummary,
					});
				}
				break;
			}
			case 'memory_extracted': {
				const memContent = delta.content ?? '';
				const memMeta = delta.metadata ?? {};
				if (memContent) {
					this._chatPanel?.addMemoryNotice({
						content: memContent,
						memoryType: memMeta.memoryType,
						priority: memMeta.priority,
						sceneName: memMeta.sceneName,
						assistantContentPreview: memMeta.assistantContentPreview,
						iteration: memMeta.iteration,
						status: 'saved',
					});
				}
				break;
			}
			case 'memory_writing': {
				const memContent = delta.content ?? '';
				const memMeta = delta.metadata ?? {};
				if (memContent) {
					this._chatPanel?.addMemoryNotice({
						content: memContent,
						memoryType: memMeta.memoryType,
						priority: memMeta.priority,
						sceneName: memMeta.sceneName,
						assistantContentPreview: memMeta.assistantContentPreview,
						iteration: memMeta.iteration,
						noticeId: memMeta.noticeId,
						status: 'pending',
					});
				}
				break;
			}
			case 'memory_written': {
				const memMeta = delta.metadata ?? {};
				if (memMeta.noticeId) {
					if (memMeta.remove) {
						this._chatPanel?.removeMemoryNotice(memMeta.noticeId);
					} else {
						this._chatPanel?.updateMemoryNotice(memMeta.noticeId, 'saved', delta.content);
					}
				}
				break;
			}
			case 'memory_write_failed': {
				const memMeta = delta.metadata ?? {};
				if (memMeta.noticeId) {
					this._chatPanel?.updateMemoryNotice(memMeta.noticeId, 'failed', delta.content);
				}
				break;
			}
			case 'memory_injected': {
				const memContent = delta.content ?? '';
				const memMeta = delta.metadata ?? {};
				if (memContent) {
					this._chatPanel?.addMemoryNotice({
						content: memContent,
						memoryType: 'injected',
						status: 'saved',
						entries: memMeta.entries,
					});
				}
				break;
			}
			case 'skill_extracted': {
				const skillContent = delta.content ?? '';
				const skillMeta = delta.metadata ?? {};
				if (skillContent) {
					this._chatPanel?.addMemoryNotice({
						content: skillContent,
						memoryType: 'skill',
						status: 'saved',
						skillId: skillMeta.skillId,
						skillTitle: skillMeta.title,
						agentId: skillMeta.agentId,
						clickable: true,
					});
				}
				break;
			}
			default:
				break;
		}
	}

	/**
	 * Recompute the tab status dot from a stream phase. Called on every
	 * phase transition (live deltas + state restore on tab switch).
	 */
	private _updateTabStatusForPhase(phase: string): void {
		if (!(this.input instanceof NativeChatEditorInput)) { return; }
		let status: ChatTabStatus;
		switch (phase) {
			case 'llm_streaming':
			case 'tool_executing':
				status = 'running';
				break;
			case 'error':
				status = 'error';
				break;
			case 'canceled':
				// 用户主动取消：视为普通 idle（清除未读提示，因为没有新结果待查看）
				status = this._isTabActive ? 'idle' : 'pending';
				break;
			case 'idle':
				// Execution finished: white "pending" dot if the user hasn't
				// viewed the tab yet; otherwise clear to idle.
				status = this._isTabActive ? 'idle' : 'pending';
				break;
			default:
				return; // unknown phase, leave current status unchanged
		}
		this.input.setTabStatus(status);
	}

	private async _ensureSession(): Promise<{ agentId: string; sessionId: string } | null> {
		const agentId = this._currentAgentId ?? 'claw';
		let sessionId = this._currentSessionId ?? undefined;
		if (!sessionId) {
			try {
				const session = await this._chatService.getOrCreateActiveSession(agentId);
				sessionId = session.id;
				this._currentSessionId = sessionId;
				if (this.input instanceof NativeChatEditorInput) {
					this.input.setAgentInfo(this.input.name, agentId, sessionId);
				}
				this._activateCheckpointSession(agentId, sessionId);
			} catch (err) {
				this._logService.error('[NativeChatEditorPane] _ensureSession failed:', err);
				return null;
			}
		}
		return { agentId, sessionId };
	}

	/**
	 * Handles an inline user-message edit (edit → truncate → regenerate).
	 *
	 * The panel has already removed the edited message and everything after it
	 * from the in-memory view. Here we truncate the persisted history to drop
	 * the edited user message (and everything after), then re-send the new text
	 * through the normal streaming flow.
	 */
	private async _handleEditMessage(messageId: string, newText: string): Promise<void> {
		// 解析实际会话（与 _sendMessageInternal 一致，含 claw 兜底）。避免
		// `if (!this._currentAgentId) return;` 静默 no-op——面板已在 commit() 里
		// 截断了视图，若此处直接 return，会表现为「点了发送没反应」（无回复）。
		const ensured = await this._ensureSession();
		if (!ensured) {
			this._logService.info('[NativeChatEditorPane] _handleEditMessage: no usable agent/session, aborting');
			return;
		}
		const agentId = ensured.agentId;
		const sessionId = ensured.sessionId;
		try {
			const history = await this._chatService.getHistory(agentId, sessionId);
			const idx = history.findIndex(m => m.id === messageId);
			if (idx === 0) {
				// 编辑的是首条消息 → 清空整个会话（历史中该消息不存在保留意义）
				await this._chatService.clearHistory(agentId, sessionId);
			} else if (idx > 0) {
				// 保留到被编辑消息的前一条，删掉被编辑消息及其之后的内容
				await this._chatService.deleteMessagesAfter(agentId, sessionId, history[idx - 1].id);
			} else {
				// 未在历史中找到该消息：不截断（绝不误清空整个会话），仅重新发送
				this._logService.warn(`[NativeChatEditorPane] _handleEditMessage: message ${messageId} not found in history, sending without truncation`);
			}
		} catch (err) {
			// 截断失败不阻断发送——面板视图已截断，仍应按新文本重新生成，
			// 否则用户会看到「点了发送没反应」。
			this._logService.error('[NativeChatEditorPane] _handleEditMessage: truncate failed (send anyway):', err);
		}

		// ── 关键：发送前必须先 cancel 残留 stream + 重置 isSending ──
		// 上次发送若崩溃（EXCEPTION_ACCESS_VIOLATION 等），sendMessage 的 for-await
		// 残留但 AbortController 未触发，_isSending 残留为 true —— 此时再次
		// _sendMessageInternal 会与残留流并发对同一 session 发请求，导致：
		//   1) AgentChatPanel._handleSendMessage 入队（_isSending=true → 入队）
		//   2) 或 sendMessage 内部对同一 stream key 抛错被吞
		// 表现为「编辑覆盖层点击发送没反应」（commit 截断做了，发送却被残留状态吞掉）。
		// 强制 cancel 残留流 + 同步重置本地状态，再走正常 _sendMessageInternal 路径。
		if (this._isSending) {
			try {
				this._chatService.cancelStream(agentId, sessionId);
			} catch (e) {
				this._logService.warn('[NativeChatEditorPane] _handleEditMessage: cancelStream failed', e);
			}
			// 同步重置 UI 状态（与 onCancelExecution 同样的手动收尾，但 triggerExecuteNext=false
			// 避免与 _sendMessageInternal 完成后重复触发队列 dispatch）。
			this._chatPanel?.setSending(false, { triggerExecuteNext: false });
			this._isSending = false;
			this._isExternalSend = false;
			this._resetStreamingMessage();
		}

		await this._sendMessageInternal(newText);
	}

	/** Register the active checkpoint session and refresh the checkpoint bar. */
	private _activateCheckpointSession(agentId: string, sessionId: string | null | undefined): void {
		if (!sessionId) {
			this._chatPanel?.setCheckpoint(null);
			return;
		}
		try {
			this._checkpointService.setActiveSession(agentId, sessionId);
		} catch { /* ignore */ }
		void this._refreshCheckpointBar();
	}

	private async _refreshCheckpointBar(): Promise<void> {
		// Delegated to CheckpointManager
		await this._checkpointMgr?.refreshBar(this._chatPanel, this._currentAgentId, this._currentSessionId);
	}

	private async _handleCheckpointAction(action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string; checkpointId?: string }): Promise<void> {
		try {
			// Delegated to CheckpointManager
			await this._checkpointMgr?.handleAction(this._chatPanel, this._currentAgentId, this._currentSessionId, action, payload);
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _handleCheckpointAction failed:', err);
		}
	}

	private async _loadAvailableAgents(): Promise<void> {
		const t0 = performance.now();
		this._logService.debug(`[NativeChatEditorPane][Init] _loadAvailableAgents START`);
		try {
		// 仅对外展示白名单内置 agent + 自定义 agent；其余内置 agent 仅内部使用
		const agents = filterUserFacingAgents(await this._agentStudioService.getAgents());
		this._logService.debug(`[NativeChatEditorPane][Init] _loadAvailableAgents getAgents done count=${agents?.length ?? 0} t=${(performance.now() - t0).toFixed(1)}ms`);
			console.info(
				`[NativeChatEditorPane] _loadAvailableAgents: fetched ${agents?.length ?? 0} agents — ` +
				`ids=[${(agents ?? []).map(a => a.id).join(', ')}]`
			);
			if (this._chatPanel && agents) {
				this._chatPanel.setAvailableAgents(
					agents.map(emp => ({
						id: emp.id,
						name: emp.name,
						role: emp.role,
						avatarUrl: emp.avatar,
						icon: emp.icon,
						status: (emp.status ?? 'idle') as AgentChatAgentStatus,
						isPM: emp.id === 'pm' || emp.role?.toLowerCase().includes('project manager'),
						customPrompt: emp.systemPrompt,
						model: emp.model,
						provider: undefined,
					}))
				);

				// 默认选中 agent（多级 fallback）：
				//   1. 窗口重载恢复的 input.agentId（优先）
				//   2. id / presetId 完全等于 'saros-claw' / 'claw'
				//   3. id / presetId / name / role 不区分大小写包含 'claw'
				//   4. 上面都没匹配到 → 列表第一个 agent
				if (!this._defaultAgentSelected && agents.length > 0) {
					const lower = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '');
					const matchExact = (a: any) => a.id === 'saros-claw' || a.id === 'claw' || (a as any).presetId === 'claw' || (a as any).presetId === 'saros-claw';
					const matchFuzzy = (a: any) => lower(a.id).includes('claw') || lower((a as any).presetId).includes('claw') || lower(a.name).includes('claw') || lower(a.role).includes('claw');

					// 1. 窗口重载恢复的 agentId 优先
					const restoredAgentId = (this.input instanceof NativeChatEditorInput) ? this.input.agentId : undefined;
					let target: any | undefined;
					if (restoredAgentId) {
						target = agents.find(a => a.id === restoredAgentId || (a as any).presetId === restoredAgentId);
						if (target) {
							this._logService.info(`[NativeChatEditorPane] _loadAvailableAgents: restoring agent "${target.id}" from editor input`);
						}
					}

					// 2-4. claw 精确/模糊/fallback
					if (!target) {
						target = agents.find(matchExact) ?? agents.find(matchFuzzy) ?? agents[0];
					}

					if (target) {
						this._defaultAgentSelected = true;
						console.info(`[NativeChatEditorPane] _loadAvailableAgents: defaulting to agent "${target.id}" (${target.name})`);
						await this._selectAndLoadAgent(target.id, { force: true });
					}
				}
			}
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _loadAvailableAgents failed:', err);
		}
	}

	// ---------- model selector wiring (mirrors chatBarPart.ts) ----------

	private async _refreshModelSelector(): Promise<void> {
		if (!this._chatPanel) {
			return;
		}
		const t0 = performance.now();
		this._logService.debug(`[NativeChatEditorPane][Init] _refreshModelSelector START`);
		try {
			const items = await this._modelSelector.getAvailableModels();
			this._logService.debug(`[NativeChatEditorPane][Init] _refreshModelSelector getAvailableModels done count=${items?.length ?? 0} t=${(performance.now() - t0).toFixed(1)}ms`);

			// Provider list — unique by id, preserving order
			const seenProviders = new Set<string>();
			const providers: IPanelProviderInfo[] = [];
			for (const it of items) {
				if (!seenProviders.has(it.provider.id)) {
					seenProviders.add(it.provider.id);
					providers.push({
						id: it.provider.id,
						label: it.provider.name,
						supportsAgents: it.provider.supportsAgents
					});
				}
			}

			// Model list — unique by `${providerId}:${modelId}`
			const seenModels = new Set<string>();
			const models: IPanelModelInfo[] = [];
			for (const it of items) {
				const key = `${it.provider.id}:${it.model.id}`;
				if (!seenModels.has(key)) {
					seenModels.add(key);
					models.push({
						id: it.model.id,
						label: it.model.name,
						provider: it.provider.id,
						// 与 _resolveContextWindow 对齐：maxInputTokens 是单次请求的上限，
						// maxAllowedSize 是 input+output 总量，不应作为分母（会使进度条百分比虚低）。
						maxInputTokens: it.model.maxInputTokens ?? it.model.contextWindow ?? it.model.maxAllowedSize,
						supportsImages: it.model.supportsImages,
					});
				}
			}

			this._chatPanel.setProviders(providers);
			this._chatPanel.setModels(models);

			// 使用面板本地选择状态（不读共享 _modelSelector，避免跨面板污染）
			const localProviderId = this._localProviderId;
			const localModelId = this._localModelId;
			if (localProviderId || localModelId) {
				if (localProviderId) { this._chatPanel.setCurrentProvider(localProviderId); }
				if (localModelId) { this._chatPanel.setCurrentModel(localModelId); }

				const matched = items.find(
					it => it.provider.id === localProviderId && it.model.id === localModelId,
				);
				this._currentMaxContextTokens = matched?.model.maxInputTokens
					?? matched?.model.contextWindow
					?? matched?.model.maxAllowedSize
					?? undefined;
			} else {
				this._currentMaxContextTokens = undefined;
			}
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _refreshModelSelector failed:', err);
		}
	}

	// ---------- session list logic ----------

	private async _refreshSessionList(): Promise<void> {
		if (!this._currentAgentId || !this._chatPanel) {
			return;
		}
		try {
			const sessions = await this._chatService.listAgentSessions(this._currentAgentId);
			if (Array.isArray(sessions)) {
				const metas: IAgentSessionMeta[] = sessions.map((s: any) => ({
					id: s.id,
					name: s.name ?? '未命名会话',
					createdAt: s.createdAt ?? new Date().toISOString(),
					updatedAt: s.updatedAt ?? s.createdAt ?? new Date().toISOString(),
					messageCount: s.messageCount ?? 0,
				}));
				this._chatPanel.setAgentSessions(metas);
			} else {
				this._chatPanel.setAgentSessions([]);
			}
		} catch {
			this._chatPanel.setAgentSessions([]);
		}
	}

	// ---------- worktree logic (mirrors React AgentChat.tsx) ----------

	private async _loadWorktrees(): Promise<void> {
		if (!this._chatPanel) {
			return;
		}
		try {
			// 优先使用面板本地 workspace，若为空则从全局活跃工作区继承（仅首次加载）
			const workspaceId = this._currentWorkspaceId || this._agentStudioService.getActiveWorkspaceId() || undefined;
			if (!workspaceId) {
				this._logService.info('[NativeChatEditorPane] _loadWorktrees: no workspaceId');
				this._chatPanel.setWorktrees([]);
				this._chatPanel.setSelectedWorktree('');
				return;
			}
			this._currentWorkspaceId = workspaceId;
			const worktrees = await this._agentStudioService.getWorktrees(workspaceId);
			// Adapt to IWorktreeItem format (include change counts for VS Code compatibility)
			const items = worktrees.map(wt => ({
				path: wt.path,
				branch: wt.branch,
				outgoingChanges: wt.outgoingChanges,
				incomingChanges: wt.incomingChanges,
				uncommittedChanges: wt.uncommittedChanges,
			}));
			this._chatPanel.setWorktrees(items);
			// Set selected worktree from agent binding
			if (this._currentAgentId) {
				try {
					const binding = await this._agentStudioService.getAgentBinding(workspaceId, this._currentAgentId);
					if (binding?.worktreePath) {
						this._chatPanel.setSelectedWorktree(binding.worktreePath);
					}
				} catch {
					// ignore
				}
			}
			this._logService.debug(`[NativeChatEditorPane] _loadWorktrees: loaded ${items.length} worktrees for workspace ${workspaceId}`);
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _loadWorktrees failed:', err);
			this._chatPanel.setWorktrees([]);
		}
	}

	/** 加载工作区列表（供 AgentChatPanel 的 onLoadWorkspaces 回调使用） */
	private async _loadWorkspaces(): Promise<void> {
		if (!this._chatPanel) { return; }
		try {
			const workspaces = await this._agentStudioService.getWorkspaces();
			const items = workspaces
				.filter(ws => ws.path) // 过滤掉没有路径的 legacy 虚拟工作区
				.map(ws => ({
					id: ws.id,
					name: ws.name,
					path: ws.path!,
				}));
			this._chatPanel.setWorkspaces(items);
			// 设置当前选中的工作区：优用面板本地状态，若为空则从全局活跃工作区继承（仅首次加载）
			if (!this._currentWorkspaceId) {
				this._currentWorkspaceId = this._agentStudioService.getActiveWorkspaceId() || null;
			}
			const activeId = this._currentWorkspaceId || (items.length > 0 ? items[0].id : '');
			if (activeId) {
				this._chatPanel.setSelectedWorkspace(activeId);
			}
			this._logService.debug(`[NativeChatEditorPane] _loadWorkspaces: loaded ${items.length} workspaces, active=${activeId}`);
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _loadWorkspaces failed:', err);
		}
	}

	/** 获取 worktree 列表（供 AgentChatPanel 的 onLoadWorktrees 回调使用） */
	private async _getWorktrees(): Promise<ReadonlyArray<{ path: string; branch: string; outgoingChanges?: number; incomingChanges?: number; uncommittedChanges?: number }>> {
		const workspaceId = this._currentWorkspaceId || this._agentStudioService.getActiveWorkspaceId() || undefined;
		if (!workspaceId) {
			this._logService.info('[NativeChatEditorPane] _getWorktrees: no workspaceId');
			return [];
		}
		try {
			const worktrees = await this._agentStudioService.getWorktrees(workspaceId);
			return worktrees.map(wt => ({
				path: wt.path,
				branch: wt.branch,
				outgoingChanges: wt.outgoingChanges,
				incomingChanges: wt.incomingChanges,
				uncommittedChanges: wt.uncommittedChanges,
			}));
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _getWorktrees failed:', err);
			return [];
		}
	}

	/** 当前 setInput 正在处理的 chatId（用于防止重复切换）。 */
	private _currentInputChatId: string | undefined;

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this._logService.debug(`[NativeChatEditorPane#${this._paneId}] setInput: type=${input.constructor.name}, resource=${input.resource?.toString()}`);

		// ── 1. 切换前保存当前 chat 的运行时状态到【旧 input】+ 释放本地流式 claim ──
		// 必须在 super.setInput() 之前执行：基类 EditorPane.setInput 会同步把
		// this._input 改为新 input，若在其后才调用 _saveCurrentRuntimeState()，
		// 保存目标会错误地变成新 input（旧实现正是如此，导致 tab 切换/移动时
		// 状态串台、popout 时流式内容丢失）。
		const isChatInput = input instanceof NativeChatEditorInput;
		const newChatId = isChatInput ? input.chatId : undefined;
		// 从当前 chat 切到「不同 chat 或非 chat（如 Canvas）」时才保存/交接；
		// 从非 chat 切回同一 chat（_currentInputChatId 仍为该 chat）不重复保存。
		if (this._currentInputChatId !== undefined && newChatId !== this._currentInputChatId) {
			this._saveCurrentRuntimeState();
			this._handoffActiveStream();
		}

		await super.setInput(input, options, context, token);

		if (!isChatInput) {
			this._logService.info('[NativeChatEditorPane] setInput: not a NativeChatEditorInput, skipping');
			return;
		}

		if (token.isCancellationRequested) {
			return;
		}

		// 同一个 chatId，无需切换
		if (newChatId === this._currentInputChatId) {
			this._logService.debug(`[NativeChatEditorPane#${this._paneId}] setInput: same chatId, skipping state switch`);
			return;
		}

		this._logService.info(`[NativeChatEditorPane#${this._paneId}] setInput: chatId=${newChatId} (prev=${this._currentInputChatId})`);

		// ── 2. 切换到新 chat ──
		this._currentInputChatId = newChatId;

		// 从 NativeChatEditorInput 恢复状态（单一真相源）
		this._currentSessionId = input.sessionId ?? null;

		// ── 3. 恢复新 chat 的运行时状态 ──
		const saved = input.getRuntimeState();
		if (saved) {
			// 有保存的运行时状态 → 直接恢复，无需服务器 round-trip
			this._logService.info(`[NativeChatEditorPane#${this._paneId}] setInput: restoring runtime state (msgs=${saved.messages.length}, phase=${saved.streamPhase})`);

			this._currentAgentId = input.agentId ?? null;
			this._defaultAgentSelected = saved.agentLoaded;

			// 恢复此 tab 保存的 model selection（每个 tab 独立切换 model）
			// 使用面板本地状态，不写共享 IModelSelectorService 单例
			if (saved.modelSelection) {
				this._localProviderId = saved.modelSelection.providerId ?? '';
				this._localModelId = saved.modelSelection.modelId ?? '';
				this._chatPanel?.setCurrentProvider(this._localProviderId);
				this._chatPanel?.setCurrentModel(this._localModelId);
			}

			// ── 流式接管（同步，赶在任何 delta 到达之前）──
			// 保存的状态显示该 chat 正在流式输出（saved.isSending）：发起该流的面板
			// 已通过 _handoffActiveStream 释放 _sharedLocalSendSessions claim，本面板
			// 立即切为「外部发送」模式并经全局 onDidStreamDelta 续接渲染。必须在
			// _restoreAgentDisplay 的 await 之前同步完成，否则中途到达的 delta 会因
			// _isSending=false 触发 _initStreamingMessage 新建空气泡（重复气泡）。
			if (saved.isSending) {
				this._isSending = true;
				this._isExternalSend = true;
				this._taskExecutingSessionId = this._currentSessionId;
				const streamingMsg = (saved.messages as any[]).slice().reverse().find((m: any) =>
					m && (m.isStreaming === true || m.streamPhase === 'llm_streaming'));
				if (streamingMsg) {
					this._streamingAssistantId = streamingMsg.id;
					this._streamingAssistantMsg = streamingMsg;
					// 续接文本段：从已恢复内容长度起算，避免重复生成历史文本 part
					this._streamTextSegmentBase = typeof streamingMsg.content === 'string' ? streamingMsg.content.length : 0;
				}
			}

		// 恢复 agent 显示（如有）
		if (input.agentId) {
			void this._restoreAgentDisplay(input.agentId, saved);
		} else {
			// 无 agent → 加载默认
			this._defaultAgentSelected = false;
			this._loadAvailableAgents();
		}

		// 恢复该 tab 当前 session 的输入框草稿（runtimeState 不含 composer 文本，
		// per-session 草稿在 localStorage；无草稿时清空，避免残留上一 tab 的内容）
		this._restoreComposerDraft();
	} else {
			// 无运行时状态 → 首次加载或拖拽到新 group
			if (input.agentId) {
				this._currentAgentId = input.agentId;
				this._defaultAgentSelected = true;
				void this._selectAndLoadAgent(input.agentId, { force: true });
			} else {
				this._defaultAgentSelected = false;
				this._loadAvailableAgents();
			}
		}

		// The chat panel is already initialized in createEditor.
		// Re-entering setInput (e.g. after a group move) just needs to ensure
		// the panel element is in the container.
		if (this._chatPanel && this._container && !this._container.contains(this._chatPanel.element)) {
			this._container.appendChild(this._chatPanel.element);
		}

		// Sync CLI mode from the input — each tab remembers its own CLI mode.
		// If the cliMode differs from the currently active panel type, swap panels.
		this._syncPanelType(input.cliMode);
	}

	/**
	 * Ensure the active panel matches the desired cliMode. If the current
	 * panel type doesn't match (e.g. switching from a rich tab to a CLI tab),
	 * save state → dispose old panel → create new panel → restore state.
	 *
	 * Called from setInput() when switching tabs and from toggleCliMode()
	 * when the user explicitly toggles CLI mode.
	 */
	private _syncPanelType(desiredCliMode: boolean): void {
		if (!this._chatPanel) { return; }
		const currentIsCli = this._chatPanel instanceof XtermCliPanel;
		if (currentIsCli === desiredCliMode) { return; }

		// Save runtime state
		const messages = this._chatPanel.getMessages();
		const agent = this._chatPanel.getAgent();
		const streamPhase = (this._chatPanel as any)?._streamPhase ?? 'idle';
		const isSending = this._isSending;

		// Dispose old panel
		this._chatPanel.dispose();
		this._chatPanel = undefined;
		this._isInitialized = false;

		if (this._container) {
			clearNode(this._container);
		}

		// Create new panel
		this._initChatPanel();

		// Restore state — capture panel reference locally. Use type assertion
		// because TypeScript's control-flow analysis narrows `this._chatPanel`
		// to `never` after the `= undefined` assignment above, even though
		// `_initChatPanel()` creates a new panel internally.
		const newPanel = this._chatPanel as IChatPanel | undefined;
		if (newPanel) {
			if (agent) {
				newPanel.setAgent(agent);
			}
			newPanel.setMessages(messages);
			newPanel.setStreamPhase(streamPhase as any);
			if (isSending) {
				newPanel.setSending(true);
			}
			// 主动调用一次 layout()，确保新创建的 xterm panel 正确布局
			// 修复：从 web 切换到 CLI 时的空白问题
			if (this._container) {
				const rect = this._container.getBoundingClientRect();
				newPanel.layout(rect.width, rect.height);
			}
			newPanel.focusInput();
		}

		// Re-populate provider/model lists
		void this._refreshModelSelector();
	}

	/**
	 * 保存当前面板的运行时状态到当前 input 上。
	 * 在 setInput 切换到新 chat 之前调用，确保流式消息、思考状态等不丢失。
	 */
	private _saveCurrentRuntimeState(): void {
		if (!this._currentInputChatId) { return; }
		const currentInput = this.input;
		if (!(currentInput instanceof NativeChatEditorInput)) { return; }

		// 从 _chatPanel 读取当前状态
		const messages = this._chatPanel?.getMessages() ?? [];
		const streamPhase = (this._chatPanel as any)?._streamPhase ?? 'idle';
		const isSending = (this._chatPanel as any)?._isSending ?? false;

		// 保存当前 tab 的 model selection（面板本地状态，每个 tab 独立）
		const modelSel = this._localProviderId || this._localModelId
			? { providerId: this._localProviderId, modelId: this._localModelId, agentId: this._currentAgentId ?? undefined }
			: undefined;

		currentInput.saveRuntimeState({
			messages: [...messages],  // shallow copy
			streamPhase,
			isSending,
			agentLoaded: this._defaultAgentSelected,
			modelSelection: modelSel ? { ...modelSel } : undefined,
		});

		// Persist per-agent input area state to localStorage
		this._saveInputAreaState();

		this._logService.debug(`[NativeChatEditorPane#${this._paneId}] saved runtime state for ${this._currentInputChatId}: msgs=${messages.length}, phase=${streamPhase}`);
	}

	/**
	 * 交接当前正在进行的本地流式输出：
	 * 1. 释放串台防护 claim（_sharedLocalSendSessions），使接管该 chat 的
	 *    面板（如 popout 后的独立窗口）能经全局 onDidStreamDelta 续接渲染；
	 * 2. 清空本面板的流式引用，避免本面板（已切走/清除）继续处理 delta 造成
	 *    在共享消息对象上的双重累计（内容重复/乱码）。
	 *
	 * 调用时机：pane 停止显示某 chat（setInput 切走 / clearInput / dispose）。
	 */
	private _handoffActiveStream(): void {
		if (this._isSending && !this._isExternalSend && this._currentSessionId) {
			NativeChatEditorPane._sharedLocalSendSessions.delete(this._currentSessionId);
		}
		if (this._streamingAssistantId || this._streamingAssistantMsg) {
			this._resetStreamingMessage();
		}
	}

	/**
	 * 从保存的运行时状态恢复面板显示（不触发服务器请求）。
	 * 用于 tab 切换时快速恢复消息列表 + 流式状态。
	 */
	private async _restoreAgentDisplay(agentId: string, saved: IChatRuntimeState): Promise<void> {
		const gen = ++this._loadGeneration;
		try {
			// P0: skip full rebuild when the same agent is already loaded.
			// _handleChatJump triggers openEditor → setInput → _restoreAgentDisplay
			// even when the target pane already displays the same agent. Without this
			// guard, setAgent() clears + rebuilds the entire UI (messages=0), then
			// setMessages() rebuilds again (messages=82). Combined with the parallel
			// _selectAndLoadAgent from updateTask, this causes 4+ _renderMessages
			// calls → severe scrollbar thrashing.
			const currentAgent = this._chatPanel?.getAgent?.();
			if (currentAgent && currentAgent.id === agentId && this._currentAgentId === agentId) {
				// Agent already loaded — just restore stream phase and focus
				if (saved.streamPhase) { this._applyStreamPhase(saved.streamPhase); }
				this._chatPanel?.focusInput?.();
				return;
			}

			const emp = await this._agentStudioService.getAgent(agentId);
			if (gen !== this._loadGeneration) { return; }  // race guard
			if (emp && this._chatPanel) {
				this._currentAgentId = agentId;
				this._currentAgentSkills = emp.skills ?? [];
				// 注意：此处【不得】用 ws.path 覆盖 AgentBinding.worktreePath。
				// worktreePath 语义是「worktree 沙箱绑定」（agent 运行在 git worktree
				// 分支内），而「绑定到工作区目录」由常规沙箱模式自动覆盖
				// （resolveAndCheckWorkspacePathImpl 未绑定 worktree 时已放行
				// workspace.path + relatedFolders）。若在此覆盖，会把用户在聊天框里
				// 选好的 worktree 绑定清掉，导致 LLM 文件操作回落到主仓（main）。
				this._chatPanel.setAgent({
					id: emp.id,
					name: emp.name,
					role: emp.role,
					avatarUrl: emp.avatar,
					icon: emp.icon,
					status: (emp.status ?? 'idle') as AgentChatAgentStatus,
					isPM: emp.id === 'pm' || emp.role?.toLowerCase().includes('project manager'),
					customPrompt: emp.systemPrompt,
					model: emp.model,
					provider: undefined,
				});
				if (this.input instanceof NativeChatEditorInput) {
					this.input.setAgentInfo(emp.name, emp.id);
				}

				// 恢复保存的消息（含流式占位符）
				if (saved.messages.length > 0) {
					this._chatPanel.setMessages(saved.messages as any);
				}

				// 恢复流式状态（接管模式已在 setInput 中同步建立：_isExternalSend /
				// _streamingAssistantId 已就绪，此处仅恢复 UI 发送态与 streamPhase）
				this._isTabActive = this.group.activeEditor === this.input;
				this._applyStreamPhase(saved.streamPhase);
				if (saved.isSending) {
					this._chatPanel.setSending(true);
					this._isSending = true;
				}

				// 加载 workspace + worktree + session 列表（轻量，不阻塞渲染）
				void this._loadWorkspaces().then(() => void this._loadWorktrees());
				void this._refreshSessionList();

				// 聚焦输入框
				this._chatPanel.focusInput();
			}
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _restoreAgentDisplay failed:', err);
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = '100%';
		}
		// Propagate layout to the active chat panel so that
		// panel-specific layout (e.g. xterm TUI height recalculation)
		// runs when the editor is resized or the panel type changes.
		if (this._chatPanel) {
			this._chatPanel.layout(dimension.width, dimension.height);
		}
	}

	/**
	 * 添加内容到聊天框作为附件（供外部命令调用）。
	 * 使用 addTextContext 而非 addFileContext，因为内容可能不是真实文件（如 Console Logs）。
	 */
	addContentToChat(name: string, content: string): void {
		this._chatPanel?.addTextContext(name, content);
	}

	/**
	 * 将文件 URI 读取后添加为聊天附件（供 Explorer "Add to Agent Chat" 等外部命令调用）。
	 */
	async addFileToChat(uri: URI): Promise<void> {
		this._logService.info(`[NativeChatEditorPane#addFileToChat] START paneId=${this._paneId}, uri=${uri.toString()}, _chatPanel=${this._chatPanel ? 'exists' : 'NULL'}`);
		try {
			const content = await this._fileService.readFile(uri);
			const text = content.value.toString();
			const fileName = uri.path.split(/[/\\]/).pop() || uri.path;
			const maxSize = 100 * 1024; // 100KB
			const truncated = text.length > maxSize ? text.slice(0, maxSize) + '\n... (truncated)' : text;

			if (!this._chatPanel) {
				this._logService.warn(`[NativeChatEditorPane#addFileToChat] _chatPanel is null — panel may not be initialized yet. paneId=${this._paneId}, file="${fileName}"`);
				return;
			}

			this._chatPanel.addFileContext(fileName, truncated);
			this._logService.info(`[NativeChatEditorPane#addFileToChat] OK "${fileName}" added (${text.length} chars, truncated=${text.length > maxSize}) to paneId=${this._paneId}`);
		} catch (err) {
			this._logService.error('[NativeChatEditorPane#addFileToChat] FAILED — readFile error:', uri.toString(), err);
		}
	}

	/**
	 * Toggle CLI-style mode on the current chat tab.
	 *
	 * Instead of toggling a CSS class on the existing panel, this method
	 * **swaps the entire panel implementation**: it saves the current
	 * runtime state (messages, stream phase, sending flag), disposes the
	 * old panel, creates a new one of the opposite type (AgentChatPanel ↔
	 * CliChatEditorPanel), and restores the state into it. This keeps the
	 * CLI rendering logic completely isolated from the rich bubble UI.
	 */
	toggleCliMode(): void {
		if (!(this.input instanceof NativeChatEditorInput)) { return; }
		const next = !this.input.cliMode;
		this.input.setCliMode(next);
		this._syncPanelType(next);
	}



	/**
	 * Handle confirmation card button clicks (tool approval / denial).
	 * Updates the message to remove the confirmation card and dispatches
	 * the decision through the command service.
	 */
	private async _handleConfirmationAction(confirmationId: string, buttonId: string): Promise<void> {
		try {
			// Dispatch the tool approval decision. The chat service / tool
			// approval handler listens for this command and resolves the
			// pending approval promise, unblocking the agent loop.
			await this._commandService.executeCommand('agentStudio.confirmationAction', confirmationId, buttonId);
		} catch {
			// Command may not be registered in all configurations — that's OK,
			// the confirmation card is still dismissed in the UI.
		}
	}

	/**
	 * 把审批状态写到当前流式消息里对应的 tool call 上并刷新卡片。
	 *
	 * 关键设计：审批数据挂在 **tool call** 而非 message.confirmation ——
	 * 工具卡的多条重建路径（parts 渲染 / _ruleToolStatusSync / progress 补建）
	 * 并不会传 msg.confirmation，挂 message 上会导致按钮在任意重绘后消失。
	 *
	 * 只有「当前流式消息里确实存在该 toolCallId」的 pane 才处理 —— 天然过滤掉
	 * 多聊天窗口并发时的非归属 pane（广播是全局的）。
	 *
	 * @param patch      pending 请求时的完整审批数据；resolve 时传 undefined（只改 status）
	 * @param toolStatus 同步给工具卡的 status
	 * @param outcome    resolve 时的终局状态
	 */
	private _applyToolApproval(
		toolCallId: string,
		patch: NonNullable<IToolCall['approval']> | undefined,
		toolStatus: 'approval_required' | 'running' | 'rejected',
		outcome?: 'approved' | 'rejected' | 'timeout' | 'cancelled',
		attempt: number = 0,
	): void {
		const assistantId = this._streamingAssistantId;
		const assistantMsg = this._streamingAssistantMsg;
		if (!assistantId || !assistantMsg || !this._chatPanel) { return; }
		let tc = (assistantMsg.toolCalls ?? []).find((c: any) => c.id === toolCallId);
		if (!tc && patch && attempt === 0) {
			// 竞态：delta 有 25ms 缓冲层，而审批广播是即时的 —— tool_start 可能
			// 还在 _deltaBuffer 里没落到 toolCalls。先强制 flush 再找一次。
			this._flushDeltaBuffer();
			tc = (assistantMsg.toolCalls ?? []).find((c: any) => c.id === toolCallId);
		}
		if (!tc) {
			// 仍找不到：可能卡片确实还没到（再等一拍），也可能本 pane 非归属方（放弃）。
			if (patch && attempt < 3) {
				setTimeout(() => this._applyToolApproval(toolCallId, patch, toolStatus, outcome, attempt + 1), 200);
			} else if (patch) {
				this._logService.warn(
					`[NativeChatEditorPane#${this._paneId}] tool approval ${toolCallId} has no matching tool card — ` +
					`approval UI not rendered here`,
				);
			}
			return;
		}

		if (patch) {
			tc.approval = patch;
		} else if (tc.approval) {
			// 已批准 → 直接摘掉审批区，卡片回到普通「运行中」形态（不留残余提示）。
			// 拒绝 / 超时 / 取消 → 保留审批区并定格文案，让用户知道为什么没执行。
			tc.approval = outcome === 'approved' ? undefined : { ...tc.approval, status: outcome ?? 'rejected' };
		} else {
			return; // 本 pane 没渲染过该审批（非归属），不越权改状态
		}
		tc.status = toolStatus;
		this._logService.info(
			`[NativeChatEditorPane#${this._paneId}] tool approval ${toolCallId} → ` +
			`${tc.approval?.status ?? outcome ?? 'pending'} (toolStatus=${toolStatus})`,
		);
		this._chatPanel.updateMessage(assistantId, {
			toolCalls: (assistantMsg.toolCalls ?? []).slice(),
			parts: assistantMsg.parts?.slice(),
		});
	}

	/** 审批说明文案：附上关键参数（terminal 的命令等），让用户不展开也能判断。 */
	private _formatApprovalReason(
		toolName: string,
		args: Record<string, unknown> | undefined,
		fallback: string | undefined,
	): string {
		const raw = args ?? {};
		const cmd = typeof raw['command'] === 'string' ? raw['command']
			: typeof raw['cmd'] === 'string' ? raw['cmd']
				: typeof raw['code'] === 'string' ? raw['code'] : '';
		if (cmd) {
			const preview = cmd.length > 300 ? `${cmd.slice(0, 300)}…` : cmd;
			return `即将执行命令：${preview}`;
		}
		const path = typeof raw['path'] === 'string' ? raw['path']
			: typeof raw['file_path'] === 'string' ? raw['file_path'] : '';
		if (path) {
			return `工具「${toolName}」将操作：${path}`;
		}
		return fallback ?? `工具「${toolName}」需要你的授权才能执行。`;
	}

	override clearInput(): void {
		// 聊天 editor 被移走/关闭且所在 group 变空时，VS Code 调用 clearInput()
		// （而非 setInput）——必须在此把当前 chat 的运行时状态存回 input，
		// 否则 popout 移动后独立窗口恢复到的 runtime state 是过期的（流式内容丢失）。
		this._saveCurrentRuntimeState();
		this._handoffActiveStream();
		super.clearInput();
	}

override dispose(): void {
	// dispose 前保存运行时状态 + 释放流式 claim（若聊天仍在流式输出中）
	this._saveCurrentRuntimeState();
	this._handoffActiveStream();
	if (this._taskBoardReloadTimer) { clearTimeout(this._taskBoardReloadTimer); this._taskBoardReloadTimer = null; }
	// flush pending 的草稿保存，避免 dispose 丢最后 400ms 输入
	if (this._composerDraftTimer !== null) {
		clearTimeout(this._composerDraftTimer);
		this._composerDraftTimer = null;
		this._saveComposerDraft();
	}
	// 释放会话锁（多开）：窗口关闭后另一实例可接管编辑
	void this._chatService.releaseSessionLock().catch(() => { /* ignore */ });
	this._chatPanel = undefined;
	this._isInitialized = false;
	super.dispose();
}

/**
 * 为当前 agent/session 获取会话锁（多开 --instance 同会话双开只读）。
 * 锁被另一实例持有时标记 _sessionReadOnly=true（发送被拦截）并提示一次；
 * 否则恢复可写。在每次会话激活（打开/新建/切换/删除切换/fork）后调用。
 */
private async _updateSessionLock(): Promise<void> {
	const agentId = this._currentAgentId;
	const sessionId = this._currentSessionId;
	if (!agentId || !sessionId) {
		this._sessionReadOnly = false;
		await this._chatService.releaseSessionLock().catch(() => { /* ignore */ });
		return;
	}
	const res = await this._chatService.tryAcquireSessionLock(agentId, sessionId);
	if (!res.acquired) {
		this._sessionReadOnly = true;
		this._notificationService.notify({
			severity: Severity.Warning,
			message: `会话正在另一个实例${res.holderInstanceId ? `（实例 ${res.holderInstanceId}）` : ''}中编辑，当前窗口为只读。`,
		});
		this._logService.warn(`[NativeChatEditorPane] session ${sessionId} locked by instance ${res.holderInstanceId ?? '?'} → read-only`);
	} else if (this._sessionReadOnly) {
		this._sessionReadOnly = false;
	}
}
}
