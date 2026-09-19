/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorPane, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorGroupView } from '../../../../workbench/browser/parts/editor/editor.js';
import { EditorActivation, IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { toDisposable, DisposableStore } from '../../../../base/common/lifecycle.js';
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
import { sanitizeAssistantVisibleText, addSanitizeTraceSink } from '../common/assistantVisibleText.js';
import { IAgentOSService } from '../common/agentOS.js';
import { buildPromptOptimizeMessages, sanitizeOptimizedOutput } from '../../../browser/agentChat/promptOptimize.js';
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
import { UrlPreviewEditorInput } from './urlPreviewEditorInput.js';
import { AgentMediaEditorInput } from './agentMedia/agentMediaEditorInput.js';
import { requestCanvasOps } from './providers/tool/canvasOpsBridge.js';
import { AgentMediaEditorPane } from './agentMedia/agentMediaEditorPane.js';
import { buildEnsureSpec, nativeIpcBridge, normalizePanelUrl, type ConfigHtmlCfg } from '../common/configHtmlConfig.js';
import { ensureConfigHtmlServerAndOpenPreview } from './configHtmlPreviewOpener.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { AgentChatPanel } from '../../../browser/agentChat/agentChatPanel.js';
import { XtermCliPanel } from '../../../browser/agentChat/xtermTui/xtermCliPanel.js';
import type { IChatPanel } from '../../../browser/agentChat/iChatPanel.js';
import { IAgentStudioService, IAgentChatService, IAgentTaskBoardService, IChatAttachmentSend } from '../../../common/agentStudioService.js';
import { IWorktreeService } from '../../worktree/common/worktreeService.js';
import { ITaskOrchestrationService } from '../../../common/agentStudioService.js';
import { IModelSelectorService } from '../common/modelSelector.js';
import { isChatCapableModel } from '../common/chatModelFilter.js';
import { ICheckpointService } from '../common/checkpointService.js';
import { earliestCheckpointTime, findConversationKeepIndex } from '../common/checkpointConversationAnchor.js';
import { describeSkippedSnapshots } from '../common/checkpointSnapshotPolicy.js';
import { IWorkflowExecutionService } from '../common/workflowExecutionService.js';
import { IWorkflowStorageService } from '../common/workflowStorage.js';
import { formatProgressPct } from '../common/progressFormat.js';
import { collectWorkflowVariables } from './utils/templateUtils.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { createMediaStoreProxy } from './mediaStoreProxy.js';
import type { IMediaBackend } from '../common/mediaStoreChannel.js';
import { AGENT_STUDIO_IMAGE_GEN_PROVIDER, AGENT_STUDIO_IMAGE_GEN_MODEL } from '../common/constants.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ContextManager } from '../common/contextManager.js';
import type { AgentStatus as AgentChatAgentStatus, IProviderInfo as IPanelProviderInfo, IModelInfo as IPanelModelInfo, IImageModelGroup as IPanelImageModelGroup, IAgentSessionMeta, IAgentChatMessage, IContextUsage, IChatAttachment, IToolCall } from '../../../browser/agentChat/agentChatTypes.js';
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

	/**
	 * ★ 2026-09-15：存活 pane 列表（构造时入列、dispose 时出列）。
	 *
	 * 用途：`lastFocusedPane` 是**跨 pane 静态**引用，而「关闭聊天框独立窗口」会
	 * 销毁其中的 pane —— 若不清算，该静态字段会继续指向**已销毁**的 pane，主窗口
	 * 的「Add to Chat」等外部动作就被路由到死 pane 上（静默失效，表现为主窗口
	 * 聊天框的加文件功能失灵）。dispose 时据此挑一个仍存活的 pane 接管。
	 * 取**最后一个**存活项 ≈ 最近创建的那个（主窗口的 pane 通常早于独立窗口创建）。
	 */
	private static readonly _livePanes: NativeChatEditorPane[] = [];

	/**
	 * 该 pane 是否仍存活。给跨窗口引用 `lastFocusedPane` 的调用方做失效判定用
	 * （`Disposable` 不暴露 `isDisposed()`，故以存活列表为准）。
	 */
	static isLivePane(pane: NativeChatEditorPane | null | undefined): pane is NativeChatEditorPane {
		return !!pane && NativeChatEditorPane._livePanes.includes(pane);
	}

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
	 * ★ 2026-09-15：会话锁的**跨 pane 引用计数**（`${agentId}::${sessionId}`
	 * → 正在显示该 session 的 pane 集合）。
	 *
	 * 为什么需要：`AgentChatService` 是**每实例单例**，只持有一把会话锁
	 * （单个 `_sessionLockUri` + 单个 token），而 `releaseSessionLock()` 会
	 * **无条件删掉锁文件并停掉 30s 心跳**。于是「多个 pane 显示同一 session」
	 * （复制式 popout / 同 session 多开聊天框）时，任一 pane 的 dispose 都会把
	 * **其它 pane 仍在用的锁**一并释放 —— 后果：主窗口的聊天框静默失去锁，
	 * 另一个 `--instance` 可趁虚接管该 session，主窗口下次 `_updateSessionLock()`
	 * 时被判为只读（发送被拦截 + 弹告警）。
	 *
	 * 这里记录持有者集合：只有集合空了才真正 `releaseSessionLock()`。
	 */
	private static readonly _sessionLockHolders = new Map<string, Set<NativeChatEditorPane>>();

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
	 * 面板本地「图片模型」偏好（2026-09-10）：`''`（未配置）| `provider:<providerId>:<modelId>`。
	 * 与 provider/model 一样只存面板本地，并持久化到 localStorage（per-pane）。
	 * 未配置时不干预下游路由（等价原 auto 语义）。
	 */
	private _localImageModelPreference: string = '';
	/** 媒体资产库代理（惰性创建）：把工具结果里的 `saros-media://<id>` 换成 data URL。 */
	private _mediaBackend?: IMediaBackend;
	/**
	 * 会话只读（多开 --instance）：当前会话锁被另一实例持有时为 true，
	 * _sendMessageInternal 拦截发送并提示，防止双写覆盖聊天历史。
	 */
	private _sessionReadOnly = false;

	/** 本 pane 在 `_sessionLockHolders` 中登记的 key（undefined = 未登记/不持有）。 */
	private _sessionLockKey: string | undefined;

	// ─── Per-agent input area state persistence keys ─────────────────────────
	// Store chatMode / provider / model / composerText per agent so switching
	// agents or restarting the client restores the full input area state.
	private static readonly _STORAGE_CHAT_ONLY = 'saros:chatOnly';
	private static readonly _STORAGE_CHAT_MODE = 'saros:chatMode';
	private static readonly _STORAGE_PROVIDER = 'saros:lastProvider';
	private static readonly _STORAGE_MODEL = 'saros:lastModel';
	private static readonly _STORAGE_COMPOSER_TEXT = 'saros:composerText';
	/** 「图片模型」偏好（2026-09-10，per-pane：key 后缀 paneId）。 */
	private static readonly _STORAGE_IMAGE_MODEL = 'saros:imageModel';

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
	/**
	 * 2026-09-10：流式「已放弃」标记（修「输出中切换会话 → 聊天框卡死」第二道防线）。
	 *
	 * 用户在流式进行中**切走**时置 true（onOpenSession）；**切回该流式所属会话**时
	 * 由 onOpenSession 复位为 false（2026-09-11 修正），下一次真正开始新流
	 * （_initStreamingMessage）时也会复位。
	 *
	 * 背景：切换会话会 setMessages(新会话历史) 并清空 _streamingAssistantId，
	 * 若旧会话的 delta 漏入（全局监听器在广播 sessionId 为空时会放行），
	 * _processDelta 的「自愈」分支（_isSending && !isTerminal &&
	 * !_streamingAssistantId）会反复 _initStreamingMessage()，在新会话的聊天框里
	 * 凭空重建流式消息 → 高频 DOM 重建 → 主线程饱和卡死。第一道防线（本地
	 * onDelta 的会话守卫）已堵住主要入口，本标记作为兜底：放弃态下禁止自愈重建。
	 *
	 * ⚠ 2026-09-11 修正：本标记**不能**做成「只置不复位」的一次性标记——切回原会话后
	 * 自愈分支被永久阻断，而复位它的唯一入口 `_initStreamingMessage` 又正被该条件挡在
	 * 门外，形成死锁，用户表现为「切走再切回，LLM 输出内容整段丢失」（日志
	 * 1789133432350）。现在切回时复位 + 后台缓冲回放，见 `_backgroundDeltaBuffer`。
	 */
	private _streamingAbandoned = false;
	/**
	 * 2026-09-11：会话切换期间的「后台 delta 缓冲」——修「LLM 输出中切走再切回 → 内容丢失」。
	 *
	 * **事故（日志 1789133432350）**：agentic loop 跑到 iter=3（多轮工具调用）时用户切走再
	 * 切回，切回后聊天框那段输出整段消失。三层原因叠加：
	 *  ① assistant 消息要等 **loop 全部结束的 finalization** 才落盘
	 *     （agentChatService.ts:2598-2647，`_streamingParts`/`_fullContentChunks` 都是
	 *     `sendMessage` 的**局部变量**，没有任何「流式快照」查询接口）——loop 未结束时
	 *     `getHistory` 必然拿不到这条消息（日志实证：切回后仍 `getHistory: 9 msgs`，
	 *     与流式开始前同数）。
	 *  ② `setMessages(历史)` 把流式消息（`_streamingAssistantId`）清空。
	 *  ③ 9-10 的卡死修复「切走即丢弃旧 delta」**只置 `_streamingAbandoned=true` 不复位**，
	 *     切回后 `_processDelta` 的自愈分支（`_isSending && !isTerminal &&
	 *     !_streamingAssistantId && !_streamingAbandoned`）被永久阻断 → 后续 delta 全丢，
	 *     且标记只能靠 `_initStreamingMessage` 复位，而它正被这个条件挡在门外 → **死锁**。
	 *
	 * **修复**：切走期间本会话的 delta 不丢弃，按 sessionId 排队；切回该会话时按序回放
	 * 喂给 `_processDelta`，重建完整流式消息（delta 自包含增量、顺序回放即自洽）。
	 * key = sessionId；上限见 `_BACKGROUND_DELTA_LIMIT`（防长时间切走爆内存）。
	 */
	private _backgroundDeltaBuffer = new Map<string, any[]>();
	/**
	 * ★ 2026-09-13：「切走瞬间的流式消息快照」—— 修「切走再切回，之前的 LLM 输出消失」。
	 *
	 * **事故（日志 1789269767739）**：切回时 `replaying 3 buffered delta(s)` —— 只有 3 个，
	 * 而切走前那条 assistant 消息**已经渲染了一大段内容**。原因：
	 *   `_backgroundDeltaBuffer` **只累积「切走后」到达的 delta** ✗；切走前的内容早已被
	 *   `_handleStreamDelta` 消费、渲染进 `_streamingAssistantMsg`，**从未进过缓冲** ✗。
	 * 而切回时 `setMessages(历史)` 清空 panel 侧消息，随后 `_resetStreamingMessage()`
	 * 又清掉 pane 侧句柄（那一步是必要的 —— 否则回放的 delta 会追加到"孤儿对象"上，
	 * `updateMessage(旧id)` 静默 no-op，见 onOpenSession 内注释）→ **切走前的内容彻底
	 * 无源可依**，只能靠那 3 个 delta 重建 ✗✗。
	 *
	 * **修复**：切走时把 `_streamingAssistantMsg` 的**引用**存起来（key = sessionId）；
	 * 切回时若它还没落盘（不在 getHistory 里）就插回 panel 并把句柄接回，之后回放的
	 * delta 会继续往它身上追加 → 切走前 + 切走期间的内容都完整 ✓。
	 *
	 * 存**引用**即可：切走后该对象不再被 delta 修改（delta 进的是缓冲），且即便
	 * `_streamingAssistantMsg` 被 `_resetStreamingMessage()` 置空也不影响这份引用。
	 */
	private _backgroundStreamingSnapshot = new Map<string, IAgentChatMessage>();
	/**
	 * 2026-09-12：后台缓冲因超限而被回收的 delta 累计数。
	 * 切回时读一次并在回放日志里标注（>0 表示回放内容可能被截断），随后复位。
	 */
	private _backgroundDroppedDeltas = 0;
	/** 后台 delta 缓冲上限（按条数）。超限后丢弃新来的并告警一次，避免长时间切走吃满内存。 */
	private static readonly _BACKGROUND_DELTA_LIMIT = 20000;
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
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@ICommandService private readonly _commandService: ICommandService,
		@IWorkflowExecutionService private readonly _workflowExecutionService: IWorkflowExecutionService,
		@IWorkflowStorageService private readonly _workflowStorageService: IWorkflowStorageService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IFileService private readonly _fileService: IFileService,
		@IModelService private readonly _modelService: IModelService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IDialogService private readonly _dialogService: IDialogService,
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
		@ILifecycleService lifecycleService: ILifecycleService,
		// ★ 2026-09-10：图片生成结果以 `saros-media://<assetId>` 短引用回传（避免 base64
		// 进 LLM 上下文），UI 侧需要经主进程媒体库把它换成 data URL 才能显示。
		// （图片模型偏好走既有的 _configurationService，见上方构造参数，无需重复注入。）
		@IMainProcessService private readonly _mainProcessService: IMainProcessService,
	) {
		super(NativeChatEditorPane.ID, group, telemetryService, themeService, _storageService);
		NativeChatEditorPane._livePanes.push(this);
		this._installSanitizeTraceSink();
		this._installInterruptedStreamPersist(lifecycleService);
	}

	/**
	 * 安装 sanitizer trace 接收器 —— 把「哪个剥离阶段删了什么」落到 renderer.log。
	 *
	 * 用途：多个剥离阶段用了锚定文本末尾的正则（`$` 无 `m` flag）。一旦误命中正文
	 * 里的常见词（`Action:` / `[TOOL_CALL]` / `<function>` 等），会删除「从这里到
	 * 文本末尾」的全部内容 —— 这正是「消息尾部被截断」的表现。未装 trace 时
	 * sanitize 前后只表现为总长度变化，无法归因到具体阶段。
	 */
	private _installSanitizeTraceSink(): void {
		const paneId = this._paneId;
		this._register(toDisposable(addSanitizeTraceSink(e => {
			this._logService.warn(
				`[SanitizeTrace] p${paneId} stage=${e.stage} profile=${e.profile} ` +
				`len ${e.beforeLen}→${e.afterLen} (removed=${e.removedLen}) atOffset=${e.atOffset}\n` +
				`  removedSnippet="${e.removedSnippet.replace(/\n/g, '\\n')}"\n` +
				`  afterTail="${e.afterTail.replace(/\n/g, '\\n')}"`
			);
		})));
	}

	/**
	 * 关窗前把「未完成的流式输出」落盘（2026-09-06，用户报「输出一半的内容消失」）。
	 *
	 * 根因：assistant 消息只在 agent loop **完整结束**后才由 agentChatService
	 * 落盘（收集到 fullContent 才 append）；而保存流式中内容的 runtime state 是
	 * **纯内存**（nativeChatEditorInput 注释自证 "Not serialized (transient)"，
	 * 仅为同进程 tab 切换设计）。故流式途中关闭 app → 进程终止 → 消息从未 append
	 * → 重启后内容消失。
	 *
	 * 此处在 onWillShutdown 时：若仍有进行中的流且已有内容，append 一条 partial
	 * assistant 消息并标记 streamInterrupted，重启后内容仍在。
	 *
	 * 用 onWillShutdown 而非 dispose：dispose 不能 await，而 appendMessage 是 async
	 * 写文件；只有 e.join() 能真正等到写完成（对齐 agentChatService 的 sessionIndex
	 * 兜底，其注释亦如此说明）。
	 *
	 * 不产生重复：流正常结束后 _streamingAssistantId 被清空且 _isSending=false，
	 * 判定不成立；此时内容由服务端正常 append。
	 */
	// ── 流式草稿 journal（★★★ 2026-09-19：崩溃保命 —— 对齐 Cline/OpenCode 的增量落盘 ✓）──
	// 痛点（用户实测）：流式途中 app 被关/崩溃 ⇒ onWillShutdown **可能根本没跑**
	// （kill / OOM / 断电 ✗）⇒ 半截输出全丢 ✗ —— 旧机制只在「优雅关闭」时救一次 ✗。
	// 对齐开源：Cline 每次消息更新即写盘（write-through ✓）、OpenCode 按 part 逐条落盘
	// （事件溯源 ✓）⇒ 崩溃最多丢几秒。此处：流式期间**每 ≥2s 覆盖写一次小草稿文件**
	// （+ 停笔 1.5s 尾部补一笔 ✓）；loop 正常结束时清除 ✓；崩溃 ⇒ 草稿留存 ⇒
	// 重启 getHistory 当「已中断」消息注入 ✓（既有消费链 `_consumeInterruptedDraft`，不动 ✓）。
	private _draftJournalLastAt = 0;
	private _draftJournalTimer: ReturnType<typeof setTimeout> | undefined;

	private _installInterruptedStreamPersist(lifecycleService: ILifecycleService): void {
		// journal 的尾部定时器随 pane 释放 ✓
		this._register(toDisposable(() => {
			if (this._draftJournalTimer) { clearTimeout(this._draftJournalTimer); this._draftJournalTimer = undefined; }
		}));
		// 关闭尝试打点（2026-09-06「关闭 app 按钮不生效」排查）：
		// 若点了关闭却连这条都没有 → 事件根本没到 pane，与本落盘逻辑无关；
		// 若有 onBeforeShutdown 但没有 onWillShutdown → 被别处 veto 卡住。
		this._register(lifecycleService.onBeforeShutdown(e => {
			this._logService.info(
				`[NativeChatEditorPane#${this._paneId}] onBeforeShutdown: reason=${e.reason} ` +
				`isSending=${this._isSending} streamingId=${this._streamingAssistantId ?? 'null'}`
			);
		}));

		this._register(lifecycleService.onWillShutdown(e => {
			const content = (this._streamingAssistantMsg?.content ?? '').trim();
			this._logService.info(
				`[NativeChatEditorPane#${this._paneId}] onWillShutdown: reason=${e.reason} ` +
				`isSending=${this._isSending} streamingId=${this._streamingAssistantId ?? 'null'} ` +
				`contentLen=${content.length} agent=${this._currentAgentId ?? 'null'}`
			);
			// 仅「确实有进行中的流 + 已有内容」才落盘：
			// - 流已结束 → _streamingAssistantId 已清空 / _isSending=false
			// - 空内容（刚开始就关）→ 不留下空气泡
			if (!this._streamingAssistantId || !this._isSending || !content) { return; }
			// 草稿按 sessionId 命名，agentId / sessionId 缺一不可
			if (!this._currentAgentId || !this._currentSessionId) { return; }
			e.join(this._persistInterruptedStream(content), {
				id: 'nativeChatEditorPane.interruptedStream',
				label: 'Saving interrupted assistant output',
			});
		}));
	}

	/** 落盘半截的 assistant 输出（关窗兜底，带硬超时）。 */
	private async _persistInterruptedStream(content: string): Promise<void> {
		const agentId = this._currentAgentId;
		const id = this._streamingAssistantId;
		if (!agentId || !id) { return; }

		// 硬超时（2026-09-06）：WillShutdownEvent.join 的 promise 若永不完成，会
		// **永久阻塞关闭** —— 其文档原文：promise "will block the application from
		// closing"，joiner 正是为「takes very long or never completes」准备的标识。
		// shutdown 期间服务可能已半销毁，appendMessage 内的 _ensureHistoryLoaded /
		// 文件写入都有挂起风险 → 宁可丢这次半截内容，也绝不让 app 关不掉。
		//
		// ★ 同类事故先例（务必遵守）：configHtmlServerChannel.ts:249 —— 2026-09-05
		// 用户实测「点击关闭无法关闭 app」，根因正是 e.join 阻塞 shutdown（每个端口
		// 串行 netstat+taskkill 可卡 10s+），最终改为 **fire-and-forget** 才解决。
		// 即本项目已有「shutdown 路径不要 join 慢操作」的共识。此处之所以仍用 join，
		// 是因为落盘必须在进程退出前完成才有意义（fire-and-forget 会被进程退出打断），
		// 故以硬超时兜底：只 join 一个通常 <100ms 的小写入，挂起则 3s 放弃。
		const PERSIST_TIMEOUT_MS = 1500;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<'timeout'>(resolve => {
			timer = setTimeout(() => resolve('timeout'), PERSIST_TIMEOUT_MS);
		});
		const work = (async (): Promise<'done'> => {
			try {
				// 写**独立草稿小文件**（几 KB，通常 <50ms），不重写整个 session 历史
				// —— 关闭速度不受会话长度影响。草稿在下次 getHistory 时被消费、
				// 补进历史并落盘（agentChatService._consumeInterruptedDraft）。
				await this._chatService.saveInterruptedDraft(
					agentId,
					this._currentSessionId ?? '',
					content,
				);
			} catch (err) {
				this._logService.warn('[NativeChatEditorPane] Failed to persist interrupted stream:', err);
			}
			return 'done';   // 失败同样视为结束：绝不让异常阻塞关闭
		})();

		try {
			const result = await Promise.race([work, timeout]);
			if (result === 'timeout') {
				this._logService.warn(
					`[NativeChatEditorPane#${this._paneId}] interrupted stream persist TIMEOUT ` +
					`(${PERSIST_TIMEOUT_MS}ms) — giving up so shutdown is never blocked ` +
					`(content=${content.length} chars not saved)`
				);
			} else {
				this._logService.info(
					`[NativeChatEditorPane#${this._paneId}] persisted interrupted stream output ` +
					`(${content.length} chars) before shutdown`
				);
			}
		} finally {
			if (timer !== undefined) { clearTimeout(timer); }
		}
	}

	/** 流式 journal 挂钩（text delta 后调用）：节流 ≥2s 一笔 + 停笔 1.5s 尾部补一笔 ✓。 */
	private _journalStreamingDraft(): void {
		const now = Date.now();
		if (now - this._draftJournalLastAt >= 2000) {
			this._draftJournalLastAt = now;
			this._writeStreamingDraftNow();
		}
		// 尾部补一笔：覆盖"最后一次节流之后又来了小段就停笔"的尾巴 ✓
		if (this._draftJournalTimer) { clearTimeout(this._draftJournalTimer); }
		this._draftJournalTimer = setTimeout(() => {
			this._draftJournalTimer = undefined;
			this._draftJournalLastAt = Date.now();
			this._writeStreamingDraftNow();
		}, 1500);
	}

	private _writeStreamingDraftNow(): void {
		const msg = this._streamingAssistantMsg;
		const agentId = this._currentAgentId;
		const sessionId = this._currentSessionId;
		if (!msg || !this._isSending || !agentId || !sessionId) { return; }
		const text = (msg.content ?? '').trim();
		if (!text) { return; }
		// quiet：2s 一笔是常态，逐笔打 info 会刷屏 ✗（关停兜底那笔仍打 ✓）
		void this._chatService.saveInterruptedDraft(agentId, sessionId, text, { quiet: true });
	}

	/** 流正常结束（loop 完成/失败收尾）：清掉 journal 草稿 + 尾部定时器（内容已落盘 ⇒ 草稿是过期物 ✗）。 */
	private _clearStreamingDraft(sessionId: string | null | undefined): void {
		if (this._draftJournalTimer) { clearTimeout(this._draftJournalTimer); this._draftJournalTimer = undefined; }
		const agentId = this._currentAgentId;
		if (!agentId || !sessionId) { return; }
		void this._chatService.clearInterruptedDraft(agentId, sessionId);
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
			logService: this._logService,
			// 任务队列「↑ 插队立即发送」：中断当前流式输出，把排队的该条任务立刻发出。
			// 复刻 _handleEditMessage 的既有模式 —— cancelStream → setSending(false)（不触发 executeNext，
			// 避免排空队列与随后的直接发送竞态）→ 直接走 _sendMessageInternal 派发。
			// ★ 2026-09-19：接收并透传 `attachments` ✓（排队的消息此前只带 text ⇒ 附件全丢 ✗，
			//   用户报「输入框里的代码片段没有发送给 llm」✓）
			onInterruptAndSend: async (text: string, attachments?: IChatAttachment[]) => {
				try {
					const agentId = this._currentAgentId ?? 'claw';
					const sessionId = this._currentSessionId ?? undefined;
					// 1) 中断当前流式输出（同 onCancelExecution 的做法）
					this._workflowTrace?.cancelExecution();
					this._chatService.cancelStream(agentId, sessionId);
					// 2) 立即恢复 UI 状态；triggerExecuteNext=false 防止排空队列与直接发送竞态
					this._chatPanel?.setSending(false, { triggerExecuteNext: false });
					this._isSending = false;
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
					// 3) 把排队的该条任务立刻发出（绕过队列直接派发）
					await this._sendMessageInternal?.(text, undefined, attachments);
				} catch (err) {
					this._logService.warn('[NativeChatEditorPane] onInterruptAndSend failed', err);
				}
			},
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
							// ★★★ 2026-09-10 会话切换守卫（修「输出中切换会话 → 聊天框卡死」）★★★
							// 本回调是 sendMessage 的闭包，与【发起发送时的会话】绑定；而
							// onOpenSession 切换会话会立刻改写 _currentSessionId 并
							// setMessages(新会话历史)（含 _resetStreamingMessage 清空
							// _streamingAssistantId/_deltaBuffer）。此后旧会话的 delta 仍会
							// 持续到达本回调，且全局 onDidStreamDelta 监听器因
							// _localSendActiveSessionId 仍是旧会话（line ~1854 独占守卫）
							// 会直接跳过 —— 旧会话 delta **只能**从这条原本无守卫的本地
							// 回调进入 _processDelta，于是：
							//   · _streamingAssistantId 为空 → 命中 _processDelta 的「自愈」
							//     分支（line ~3207：_isSending && !isTerminal &&
							//     !_streamingAssistantId）→ 反复 _initStreamingMessage()
							//   · 每个 delta 都在【新会话的聊天框】里凭空重建/追加 assistant
							//     消息 → 高频 addMessage + DOM 重建 → 主线程饱和 → UI 卡死
							//     （日志 20260910T103549：17:46:45.314 后静默 2m22s，
							//     用户最终强关窗口）。
							// 守卫：发起会话已非当前会话 → 不渲染到当前聊天框，但**也不丢弃**。
							// 2026-09-11 修正：原实现直接 return 丢弃，导致「切走再切回」后这段
							// 输出永久消失（assistant 消息要等 loop 结束才落盘，切回时 getHistory
							// 里没有它；详见 _backgroundDeltaBuffer 字段注释）。现改为存入后台
							// 缓冲，切回该会话时由 onOpenSession 按序回放重建。
							if (sentSessionId && this._currentSessionId && this._currentSessionId !== sentSessionId) {
								this._bufferBackgroundDelta(sentSessionId, delta);
								return;
							}
							this._handleStreamDelta(delta);
						},
					);
					// Agent loop fully completed (not per-turn) — reset sending state
					this._chatPanel?.setSending(false);
					this._isSending = false;
					this._resetStreamingMessage();
					// ★ 2026-09-19：流式 journal 草稿同理 —— 内容已由 finalization 落盘 ✓，
					//   不删会让下次 getHistory 把同一内容再注入一条「已中断」消息 ✗。
					this._clearStreamingDraft(sentSessionId);
					// 2026-09-11：流已结束（内容已由 finalization 落盘），清掉该会话可能残留的
					// 后台缓冲——否则下次切回会回放一份过期快照，与 getHistory 的落盘内容重复。
					if (sentSessionId) {
						this._backgroundDeltaBuffer.delete(sentSessionId);
						// ★ 2026-09-13：流式快照同理 —— 内容已落盘，留着会让切回时把旧对象
						//   再插一条（虽然 getHistory 的 id 去重能挡住，但引用已过期、不该留）。
						this._backgroundStreamingSnapshot.delete(sentSessionId);
					}
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] sendMessage failed:', err);
					// sendMessage 抛出后没有 _sendMessageInternal line 644 收尾，必须这里手动
					// 恢复 UI 状态并触发队列 dispatch（与正常完成路径一致）。
					this._chatPanel?.setSending(false);
					this._isSending = false;
					this._isExternalSend = false;
					this._resetStreamingMessage();
					// ★ 2026-09-19：失败收尾同样清 journal 草稿（错误信息已落盘 ✓，草稿是过期物 ✗）
					this._clearStreamingDraft(sentSessionId);
					// ★ 2026-09-13：外部流结束 —— 清掉快照。外部发送路径拿不到 sessionId
					//   （delta 只带 agentId/sessionId，pane 未持有），而同一 pane 同时只可能
					//   有一个流 → 直接 clear 既安全又不会残留（否则下次切回会插回已落盘的旧对象）。
					this._backgroundStreamingSnapshot.clear();
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
			// 「跳过」：只中止当前正在执行的工具（terminal 长命令等），
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
					const pane = await this._openInMainColumn(input, { pinned: true });
					// 同 onOpenMedia：若复用已有 tab，本次新建的 input 被引擎丢弃且不释放，
					// 需调用方 dispose，否则 GC 时报 "[LEAKED DISPOSABLE]"。
					if (pane?.input !== input) {
						input.dispose();
					}
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
			onOpenMedia: (media: { src: string; kind: string; title?: string }) => {
				// ★ 双击聊天里的媒体 → 中间栏编辑器**独立 pane**（2026-09-11 用户需求）。
				//   走 _openInMainColumn：sessions 布局下 mainPart = 中间栏主编辑器，
				//   agentPart = 右侧聊天区 —— 必须显式指定，否则会落在聊天区的编辑器组里
				//   覆盖聊天面板。
				//   pinned:true → 固定标签，避免被后续预览（单击其他图）顶掉；
				//   revealIfOpened + matches() 去重 → 重复双击同一张图复用同一 tab。
				try {
					const kind = (media.kind === 'image' || media.kind === 'video' || media.kind === 'audio')
						? media.kind
						: 'unknown';
					const input = new AgentMediaEditorInput({ src: media.src, kind, ...(media.title ? { title: media.title } : {}) });
					// ★ `override`（2026-09-11）：**显式指定 pane id** —— 兜底「按 input 类匹配失败」
					//   的情况（EditorPaneRegistry 是按 `editor.constructor === 注册的 SyncDescriptor.ctor`
					//   匹配的）。若匹配失败，VS Code 会回退成文本编辑器 → tab 标题正确但内容**空白** ✗，
					//   正是用户实测「点放大后未显示图像」的形态。
					//
					// ★ 兜底释放（2026-09-11）：`revealIfOpened` + `matches()` 命中已有 tab 时，
					//   openEditor 复用旧 editor 并**丢弃本次新建的 input 且不释放** —— 调用方
					//   必须自行 dispose，否则 GC 时触发 "[LEAKED DISPOSABLE]"（重复点同一张图必现）。
					//   打开失败同理。真正打开时 pane.input === input，保留由 group 管理生命周期。
					void this._openInMainColumn(input, {
						pinned: true,
						revealIfOpened: true,
						activation: EditorActivation.ACTIVATE,
						override: AgentMediaEditorPane.ID,
					}).then(pane => {
						if (pane?.input !== input) {
							input.dispose();
						}
					}, err => {
						input.dispose();
						this._logService.error('[NativeChatEditorPane] onOpenMedia failed:', err);
					});
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] onOpenMedia failed:', err);
				}
			},
			onOpenHtmlPreview: () => {
				// ★ 按 agent 的 configHtml 配置预览（与设置页「打开预览」共享同一 opener，行为一致）：
				//   url 模式 → 探活/拉起面板服务 + 打开 URL 预览；
				//   文件模式 → 原 config.html 逻辑（不存在则创建默认文件）。
				if (!this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onOpenHtmlPreview: no agent selected');
					return;
				}
				(async () => {
					try {
						const agentId = this._currentAgentId!;
						const agent = await this._agentStudioService.getAgent(agentId);
						const cfg = agent?.configHtml as ConfigHtmlCfg | undefined;
						if (cfg?.url?.trim()) {
							const wsRoot = this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
							await ensureConfigHtmlServerAndOpenPreview({
								url: cfg.url,
								server: cfg.server,
								wsRoot,
								notificationService: this._notificationService,
								logService: this._logService,
								dialogService: this._dialogService,
								open: (input, options) => this._openInMainColumn(input, options),
							});
							return;
						}
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
				// ★ 2026-09-11：切走 / 切回 的流式状态处理（修「输出中切走再切回 → 内容丢失」）
				// 9-10 的实现把 `_streamingAbandoned` 当成一次性标记「只置 true 不复位」，
				// 切回原会话后 `_processDelta` 的自愈分支被永久阻断、标记又只能由
				// `_initStreamingMessage` 复位（正被该条件挡住）→ 死锁 → 输出全丢。
				// 现按「目标会话是否就是流式所属会话」分别处理：
				const streamOwner = this._localSendActiveSessionId;
				if (streamOwner && streamOwner === sessionId) {
					// ① 切回「仍在流式输出中」的会话 → 解除放弃标记，让后续 delta 继续渲染。
					//    流式消息本身由 setMessages 清空后，靠自愈分支在下一个 delta 上重建；
					//    切走期间的内容则由下面的后台缓冲回放补齐。
					this._streamingAbandoned = false;
				} else if (this._streamingAssistantId || streamOwner !== null) {
					// ② 切走（或切到另一个会话）→ 标记放弃，防止旧 delta 污染新会话的聊天框
					//    （9-10 卡死根因）。待处理队列里的 delta 转入后台缓冲而非丢弃，
					//    保证切回时能完整回放。
					this._streamingAbandoned = true;
					if (streamOwner) {
						for (const d of this._deltaBuffer) {
							this._bufferBackgroundDelta(streamOwner, d);
						}
					}
					// ★ 2026-09-13：把**切走前已渲染的流式消息**存快照 —— 否则切回时只能靠
					//   缓冲里的 delta 重建，而缓冲只含「切走后」的增量，切走前的内容全丢
					//   （日志 1789269767739：replaying 3 buffered delta(s)，而切走前已渲染一大段）。
					//   详见字段注释。
					//
					//   ★ key 取 `streamOwner ?? _currentSessionId`：**外部发送**
					//   （看板 executeTaskForBoard 直调 agentChatService.sendMessage）时
					//   `_localSendActiveSessionId` 为 **null**，若只用 streamOwner 守卫，
					//   外部流切走再切回同样丢内容（平行路径 —— 本仓「修了一半」是高频模式）。
					//   此刻 `_currentSessionId` 仍是**切走前**的会话（赋值在下方），正好是流所属会话 ✓。
					const snapshotKey = streamOwner ?? this._currentSessionId;
					if (snapshotKey && this._streamingAssistantMsg) {
						this._backgroundStreamingSnapshot.set(snapshotKey, this._streamingAssistantMsg);
					}
					if (this._deltaFlushTimer !== null) {
						clearTimeout(this._deltaFlushTimer);
						this._deltaFlushTimer = null;
					}
					this._deltaBuffer = [];
				} else {
					// ③ 无进行中的本地流（切走期间该流已结束/未在发送）→ 复位标记，
					//    避免「放弃」态残留到下一次切换（残留时自愈分支会被无谓阻断）。
					this._streamingAbandoned = false;
				}
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
				const adaptedHistory = this._adaptHistoryMessages(history);
				// ★ 2026-09-13：切回「仍在流式输出中」的会话时，把**切走瞬间的快照**接回末尾。
				//   必须在 setMessages **之前**拼进数组（`addMessage` 会触发二次渲染）。
				//   若该消息已落盘（loop 恰在切走期间结束 → getHistory 里已有同 id）则跳过，避免重复。
				const streamingSnapshot = this._backgroundStreamingSnapshot.get(sessionId);
				const snapshotUsable = !!streamingSnapshot
					// 本地流：`_localSendActiveSessionId` 必须正是本会话（否则说明用户已在本
					// pane 发了另一条到别的会话，旧快照不该再插回）。
					// **外部流**（看板 executeTaskForBoard）时该字段恒为 null → 不做此限制；
					// 此时「能从 Map 里按 sessionId 取到」本身已证明它属于本会话 ✓。
					&& (this._localSendActiveSessionId === null || this._localSendActiveSessionId === sessionId)
					&& !adaptedHistory.some(m => m.id === streamingSnapshot.id);
				if (snapshotUsable && streamingSnapshot) {
					adaptedHistory.push(streamingSnapshot);
				}
				this._chatPanel?.setMessages(adaptedHistory);
				// ★★ 2026-09-11 补充修复「切回原会话后，原先正在输出的内容没有显示」★★
				//
				// `setMessages` 只整体替换 **panel 侧** 的 `_messages` 数组，**不会**清 pane
				// 侧的 `_streamingAssistantId`/`_streamingAssistantMsg` —— 它们仍指向
				// 【切走前】那条流式消息对象，而该对象已不在 `_messages` 里，成为**孤儿**。
				//
				// 后果：回放的后台 delta 走 `_processDelta` 的「assistantMsg 非空」正常分支
				// → 全部追加到孤儿对象 → `panel.updateMessage(旧id, …)` 按 id 找不到 →
				// **静默 no-op**，聊天框始终空白。
				// 日志 1789135259834 铁证：`replaying 165 buffered delta(s)` 之后，既无
				// `SELF-HEALED` 也无 `MISSING on type` 打点（说明 assistantMsg 恒非空、从未
				// 进过自愈分支），而该轮流其实继续跑完 961 deltas 并正常落盘 —— 数据没丢，
				// 只是**一条都没渲染**。
				//
				// 清空后，首个 delta 命中自愈分支重建流式消息，回放/后续 delta 才有归宿。
				// 注意：此处**无条件**清空（不只在有缓冲时）——因为 `setMessages` 一旦执行，
				// 任何残留的流式句柄都必然指向孤儿，留着只会让后续 delta 静默丢失。
				this._resetStreamingMessage();
				// ★ 2026-09-13：快照可用时**把流式句柄接回快照**（必须在 `_resetStreamingMessage`
				//   之后 —— 那一步会清空句柄）。
				//   为何必须接回：`_processDelta` 在 `_streamingAssistantId` 为空时走「自愈分支」
				//   **新建**一条流式消息；若此处不接回，回放的 delta 会另建一条，切走前的内容
				//   虽显示在列表里却**不会再被后续 delta 更新**（两处内容各走各的）✗。
				//   接回后：回放 delta 直接追加到快照上 → 切走前 + 切走期间的内容连贯 ✓。
				if (snapshotUsable && streamingSnapshot) {
					this._streamingAssistantId = streamingSnapshot.id;
					this._streamingAssistantMsg = streamingSnapshot;
				}
				// ★ 2026-09-11：回放切走期间攒下的 delta，把「尚未落盘、只存在于内存」的
				// 流式输出补回 UI（assistant 消息要等 loop 结束才落盘，getHistory 里没有它）。
				// 必须在 setMessages 之后：回放会经 _processDelta 的自愈分支重建流式消息，
				// 顺序喂入才能还原 parts（text/tool 交错）的原始次序。
				const pendingDeltas = this._backgroundDeltaBuffer.get(sessionId);
				if (pendingDeltas && pendingDeltas.length > 0) {
					this._backgroundDeltaBuffer.delete(sessionId);
					this._logService.info(
						`[NativeChatEditorPane] onOpenSession: replaying ${pendingDeltas.length} buffered delta(s) for session ${sessionId}` +
						(this._backgroundDroppedDeltas > 0
							// ★ 2026-09-12：缓冲超限曾回收过 delta —— 明确标注，避免"内容莫名变短"无从归因。
							? ` — ⚠ ${this._backgroundDroppedDeltas} delta(s) recycled on overflow, content may be truncated`
							: ''),
					);
					this._backgroundDroppedDeltas = 0;
					// 回放期间必须处于发送态，否则自愈分支不重建流式消息 → 回放内容无处落。
					// （正常切回时 _isSending 仍为 true；此处兜底防御被 delta 逻辑改写的情形。）
					if (!this._isSending) {
						this._isSending = true;
						this._chatPanel?.setSending(true);
					}
					for (const d of pendingDeltas) {
						if (!d) { continue; }	// 缓冲满载标记（见 _bufferBackgroundDelta）
						this._handleStreamDelta(d);
					}
				}
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
				// 2026-09-12（P0-3）：会话被删除 → 连同其检查点数据（index.json + snapshots/）
				// 一起回收。此前只重置 UI，磁盘数据永久残留（无任何清理入口）。
				try {
					await this._checkpointService.deleteSessionCheckpoints(agentId, sessionId);
				} catch (err) {
					this._logService.warn(
						`[NativeChatEditorPane] onDeleteSession: failed to purge checkpoints of ${sessionId}: ${err}`,
					);
				}
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
			// 提示词优化（2026-09-10，输入框 ✨ 按钮）：一次性 LLM 改写输入框文本。
			// 不进入会话历史、不触发 agent loop（见 _optimizePrompt）。
			onOptimizePrompt: (text: string) => this._optimizePrompt(text),
			// 「图片模型」选择（2026-09-10）：偏好字符串 auto | provider:<pid>:<mid>。
			// 面板本地持久化（per-pane localStorage），聊天中触发图片生成时按此路由。
			onSelectImageModel: (preference: string) => {
				this._logService.info(`[NativeChatEditorPane#${this._paneId}] onSelectImageModel: ${preference} (prev=${this._localImageModelPreference})`);
				this._localImageModelPreference = preference;
				try { localStorage.setItem(this._imageModelPrefKey(), preference); } catch { /* localStorage 不可用忽略 */ }
				// ★ 2026-09-10：同步写入 agent 配置（.agent.md 的 imageModel/imageProviderId）。
				// localStorage 只是本 pane 的即时缓存；agent 配置才是跨 pane / 跨会话 /
				// 跨重启的权威值（也与 agent 设置页的「图片生成模型」双向一致）。
				void this._persistImageModelToAgent(preference);
				this._chatPanel?.setCurrentImageModel(preference);
			},
			onCheckpointAction: (action: 'undoAll' | 'keepAll' | 'openDiff' | 'undoConversation' | 'openTimeline', payload?: { filePath?: string; checkpointId?: string }) => {
				void this._handleCheckpointAction(action, payload);
			},
			onConfirmationAction: (confirmationId: string, buttonId: string) => {
				void this._handleConfirmationAction(confirmationId, buttonId);
			},
			onAskUserSubmit: (askUserId: string, executionId: string, nodeId: string, selection: string | string[] | { __askUserAnswer: 1; labels: string[]; params?: Record<string, string>; multiSelect?: boolean } | { __askUserAnswer: 1; answers: Record<string, unknown> }) => {
				this._logService.debug('[NativeChatEditorPane] onAskUserSubmit:', askUserId, executionId, nodeId, selection);
				// ★ D4：对象态答案（labels + 动态 params）原样透传给 resume——
				//   执行侧 _executeAskUserNode 判别 object 态并物化 params。
				// ★ 多问题（2026-09-11）：`{ __askUserAnswer:1, answers:{…} }` **没有
				//   labels 字段** —— 旧代码直接取 `selection.labels[0]` 会 TypeError
				//   （卡片提交即崩）。这里按 answers 优先分支处理：卡片显示摘要文本，
				//   resumeValue（下方 JSON.stringify）仍完整携带 answers。
				const isObjAnswer = !!selection && typeof selection === 'object' && !Array.isArray(selection);
				const multiAnswers = isObjAnswer && 'answers' in selection
					? (selection as { answers?: Record<string, unknown> }).answers
					: undefined;
				const answer: string | string[] = multiAnswers
					? Object.values(multiAnswers)
						.map(v => typeof v === 'string' ? v : (v && typeof v === 'object' ? Object.values(v as Record<string, unknown>).join('/') : String(v ?? '')))
						.filter(Boolean)
						.join(' · ')
					: isObjAnswer
						? ((selection as { multiSelect?: boolean; labels: string[] }).multiSelect
							? (selection as { labels: string[] }).labels
							: ((selection as { labels: string[] }).labels[0] ?? ''))
						: selection as string | string[];
				// Optimistically mark the AskUser as answered, then resume the paused workflow.
				// Both are delegated to the WorkflowTraceController, which owns the
				// _askUsers state and the live-workflow message refresh.
				// ★ D4：对象态答案（含动态 params）序列化后随 resume 传回执行侧
				//   （执行侧 parse 出 __askUserAnswer 判别），卡片显示用 labels（answer）。
				const resumeValue: string | string[] = (selection && typeof selection === 'object' && !Array.isArray(selection))
					? JSON.stringify(selection)
					: (selection as string | string[]);
				this._workflowTrace?.markAskUserAnswered(askUserId, answer);
				this._workflowTrace?.resumeExecution(executionId, resumeValue).catch(err => {
					this._logService.error('[NativeChatEditorPane] Failed to resume workflow:', err);
					// Rollback optimistic update on failure.
					this._workflowTrace?.rollbackAskUser(askUserId);
				});
			},
			// ★ ImagePicker 多选提交（2026-09-11 用户需求）：卡片勾选 → 乐观标记已选择
			//   → resume 执行侧（refs 作为 pauseExecution 的解析值 → picker 节点输出）。
			//   与 AskUser 同链路：失败回滚卡片状态。
			onPickerSelectSubmit: (pickerId: string, executionId: string, nodeId: string, refs: string[]) => {
				this._logService.info('[NativeChatEditorPane] onPickerSelectSubmit:', pickerId, executionId, nodeId, refs.length);
				if (refs.length === 0) { return; }
				this._workflowTrace?.markPickerSelected(pickerId, refs);
				// ★ 与画布节点同步（2026-09-11 用户需求）：聊天卡勾选的候选要**写回画布
				//   ImagePicker 节点的选中态**（`selected_index` / `directRef`）。
				//   此前只 resume 执行侧 → 画布上仍是旧高亮 ✗。
				//   走 canvasOps（host→webview 既有通道）；ref→池序号 由 webview 侧解析
				//   （池 = 快照库 + 上游连线，host 算不出 ✗）。失败不影响主链路（仅日志）。
				void requestCanvasOps([{ op: 'select_picker_refs', node: nodeId, refs }]).catch(err => {
					this._logService.warn('[NativeChatEditorPane] picker→canvas 同步失败（不影响执行）:', err);
				});
				this._workflowTrace?.resumeExecution(executionId, refs).catch(err => {
					this._logService.error('[NativeChatEditorPane] Failed to resume workflow (picker):', err);
					this._workflowTrace?.rollbackPickerSelect(pickerId);
				});
			},
			// ★ 节点交互表单提交（2026-09-11 框架）：表单值 JSON 序列化后作为 resume 值
			//   回传执行侧（与 AskUser D4 的对象态答案同约定）；执行侧 JSON.parse 后
			//   合并进节点 values，该节点才执行。
			onNodeInteractionSubmit: (interactionId: string, executionId: string, nodeId: string, values: Record<string, unknown>) => {
				this._logService.info('[NativeChatEditorPane] onNodeInteractionSubmit:', interactionId, executionId, nodeId, Object.keys(values).length);
				this._workflowTrace?.markNodeInteractionSubmitted(interactionId, values);
				// ★ 与画布节点同步（2026-09-11 用户需求：**所有**卡片数据 ↔ 画布节点 UI 始终同步）：
				//   表单提交值此前**只**进执行期 values ✗ → 画布节点完全看不到用户在卡片里改的
				//   行列/风格/提示词/参考图。现同时写回画布节点。
				//   机制：复用既有 `update_node`（浅合并进 node.data —— 画布侧 node.properties
				//   即 store 的 node.data，见 applyCanvasOpsToStore 的映射）✓，**无需新 op**。
				//   ⚠ 画布侧约定：数组/对象以 **JSON 字符串**存储（如 comfytv_image_refs），
				//   故非原始值必须序列化 —— 否则画布控件读到对象会解析失败 ✗。
				const patch: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(values)) {
					patch[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
				}
				if (Object.keys(patch).length > 0) {
					void requestCanvasOps([{ op: 'update_node', node: nodeId, patch }]).catch(err => {
						this._logService.warn('[NativeChatEditorPane] 表单→画布 同步失败（不影响执行）:', err);
					});
				}
				this._workflowTrace?.resumeExecution(executionId, JSON.stringify(values)).catch(err => {
					this._logService.error('[NativeChatEditorPane] Failed to resume workflow (node interaction):', err);
					this._workflowTrace?.rollbackNodeInteraction(interactionId);
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
			// ── ConfigHtml（URL 面板 / 本地 HTML）—— 对齐 AgentSettingsEditorPane ──
			onGetConfigHtmlCfg: async (): Promise<ConfigHtmlCfg | undefined> => {
				if (!this._currentAgentId) { return undefined; }
				try {
					const agent = await this._agentStudioService.getAgent(this._currentAgentId);
					return (agent?.configHtml ?? undefined) as ConfigHtmlCfg | undefined;
				} catch {
					return undefined;
				}
			},
			onSaveConfigHtmlCfg: async (cfg: ConfigHtmlCfg): Promise<void> => {
				if (!this._currentAgentId) { return; }
				await this._agentStudioService.updateAgent(this._currentAgentId, { configHtml: cfg });
			},
			onEnsureConfigHtmlServer: async (spec: Record<string, unknown>): Promise<{ ok: boolean; alreadyRunning?: boolean; starting?: boolean; error?: string }> => {
				const bridge = nativeIpcBridge();
				if (!bridge?.ipcRenderer?.invoke) {
					return { ok: false, error: '当前环境不支持' };
				}
				// ★ 聊天设置页只传 {url,port,healthExpect?}——这里必须走共享 buildEnsureSpec 补全
				//   command/args/cwd（注释原本承诺「由实现方补全」但之前只透传）：
				//   主进程收到空 args 会 spawn 一个无参数的 node（REPL）挂住 30s，表现为「点了没反应」。
				const url = normalizePanelUrl(String(spec.url ?? ''));
				const wsRoot = this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
				const formPort = Number(spec.port ?? NaN);
				const agent = this._currentAgentId
					? await this._agentStudioService.getAgent(this._currentAgentId).catch(() => undefined)
					: undefined;
				const server = (agent?.configHtml as ConfigHtmlCfg | undefined)?.server;
				const full = {
					...buildEnsureSpec(url, Number.isFinite(formPort) && formPort > 0 ? formPort : undefined, wsRoot),
					...(server?.command ? { command: server.command } : {}),
					...(server?.args ? { args: server.args } : {}),
					...(server?.healthPath ? { healthPath: server.healthPath } : {}),
					...(typeof spec.healthExpect === 'string' && spec.healthExpect ? { healthExpect: spec.healthExpect } : server?.healthExpect ? { healthExpect: server.healthExpect } : {}),
					...(server?.readyTimeoutMs ? { readyTimeoutMs: server.readyTimeoutMs } : {}),
					...(server?.cwd ? { cwd: server.cwd.replace(/\$\{workspaceRoot\}/g, wsRoot) } : {}),
					...(server?.env ? { env: server.env } : {}),
				};
				return await bridge.ipcRenderer.invoke('vscode:configHtmlEnsureServer', full) as { ok: boolean; alreadyRunning?: boolean; starting?: boolean; error?: string };
			},
			onStopConfigHtmlServer: async (spec: { url: string; port?: number }): Promise<{ ok: boolean; killed: number[] }> => {
				const bridge = nativeIpcBridge();
				if (!bridge?.ipcRenderer?.invoke) { return { ok: false, killed: [] }; }
				return await bridge.ipcRenderer.invoke('vscode:configHtmlStopServer', spec) as { ok: boolean; killed: number[] };
			},
			onOpenConfigHtmlPreview: async (url: string): Promise<void> => {
				await this._openInMainColumn(UrlPreviewEditorInput.getOrCreate(url), { pinned: true });
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
			// ★ 百分比必须 `formatProgressPct`（2026-09-12 用户需求「生成的进度最多显示
			//   小数点后2位」）：ComfyUI 进度是 `value/max*100` 的无限小数，直接插值会让
			//   聊天卡显示「生成中 45.45454545454546%」✗（窄容器里还被 CSS 省略号截成
			//   「45.45…」这种看起来像 bug 的样子）。
			(tc as any).progressText = payload.message ?? `生成中 ${formatProgressPct(payload.progress)}%`;
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

		// 2026-09-13 修复「多窗口同时跑时，非活跃窗口的压缩 UI 不更新」：
		// 压缩基线此前只写裸 localStorage —— 物理上跨窗口共享，但**没有变更通知**，
		// 于是窗口 B 必须等自己下次切 agent/session 才重读。现改为写入 IStorageService
		// 并订阅其跨窗口广播（external=true），A 窗口压缩后 B 立即同步进度圈。
		this._registerCompactedBaselineSync();

		// 2026-09-04 修复「新建工作区后聊天框工作区下拉框不刷新」：
		// AgentStudioService 在 createWorkspace/update/delete 等 6 处 fire onDidChangeWorkspace
		// （workspaceView/searchView/knowledgeBaseView/workspaceToolbar 均已监听），
		// 但本 pane 此前未订阅 → 聊天面板的 _workspaces 缓存停留在初始化时的快照；
		// 且下拉框打开时只要缓存非空就直接渲染缓存（agentChatPanel.dropdowns.ts
		// _openWorkspaceDropdown 的 staticItems 短路），永不重新加载 —— 新工作区
		// 对聊天框完全不可见。现对齐 onDidChangeAgents 的模式：事件驱动重拉列表。
		// _loadWorkspaces 内部 setWorkspaces + setSelectedWorkspace（保选中的
		// _currentWorkspaceId 优先），不会打断用户当前的选择。
		this._register(this._agentStudioService.onDidChangeWorkspace(() => {
			if (!this._chatPanel) { return; }
			void this._loadWorkspaces();
		}));

		// Orchestration plan listeners removed — task orchestration entry point is closed.

		// ★ 2026-09-12：本面板正在显示的会话被**别处**（会话历史视图 / 会话浏览器）删除时，
		//   面板自身的 onDeleteSession 回调不会被调用 → `_currentSessionId` 会一直指向已删
		//   会话 → 后续发送报 `Session ... not found`（日志 20260912T102833）。
		//   订阅专门的删除事件，立刻切到最近会话（或清空视图）。
		this._register(this._chatService.onDidDeleteAgentSession(async ({ agentId, sessionId }) => {
			if (agentId !== this._currentAgentId || sessionId !== this._currentSessionId) { return; }
			this._logService.info(
				`[NativeChatEditorPane#${this._paneId}] current session ${sessionId} deleted elsewhere — switching away`,
			);
			await this._handleCurrentSessionDeleted(agentId);
		}));

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
			this._checkpointService, this._commandService, this._logService,
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
				// ⚠️ 2026-08-29 修复「重启后 provider/model 丢失，需重新选择」：
				// 旧实现把下面 4 个 await 与末尾的 _restoreInputAreaState() 放在同一个
				// try 块里，**任一 await 抛错就直接跳到 catch，恢复逻辑永不执行**。
				// _loadWorktrees() 走 git 操作（重启/仓库未就绪时极易失败），
				// _refreshSessionList()/_refreshModelSelector() 也各有失败路径，
				// 于是表现为「每次重启都要重新选一遍 provider + model」。
				// 修复：各 await 独立 try/catch（它们都不是恢复的前置条件），
				// 保证 _restoreInputAreaState() 无论前面成败都必然执行。
				try { await this._loadWorkspaces(); }
				catch (e) { this._logService.info(`[NativeChatEditorPane#${this._paneId}] _loadWorkspaces failed (non-fatal):`, e); }
				try { await this._loadWorktrees(); }
				catch (e) { this._logService.info(`[NativeChatEditorPane#${this._paneId}] _loadWorktrees failed (non-fatal):`, e); }
				// Refresh chat-history panel
				try { await this._refreshSessionList(); }
				catch (e) { this._logService.info(`[NativeChatEditorPane#${this._paneId}] _refreshSessionList failed (non-fatal):`, e); }
				// Restore per-agent input area state (chatMode / provider / model / composer text)
				// Called after setAgent + _refreshModelSelector so the panel DOM is ready.
				try { await this._refreshModelSelector(); }
				catch (e) { this._logService.info(`[NativeChatEditorPane#${this._paneId}] _refreshModelSelector failed (non-fatal):`, e); }
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

	/** 压缩基线的 storage key（跨窗口共享，故用 APPLICATION scope）。 */
	private _compactedBaselineKey(): string | undefined {
		if (!this._currentAgentId || !this._currentSessionId) { return undefined; }
		return `saros.compactedBaseline.${this._currentAgentId}.${this._currentSessionId}`;
	}

	/**
	 * 持久化压缩基线。
	 *
	 * 2026-09-13：从裸 `localStorage` 迁移到 `IStorageService`（StorageScope.APPLICATION）。
	 *
	 * 动机（多窗口压缩 UI 不更新）：`localStorage` 虽在 Electron 同源渲染进程间物理共享，
	 * 但它**不产生任何变更通知** —— 窗口 A 压缩后窗口 B 无从得知，只能等自己下次
	 * 切 agent/session 时才重读。`IStorageService` 的写入会经 IPC 广播到所有窗口
	 * （storageIpc.ts `onDidChangeStorage`），使 `_registerCompactedBaselineSync`
	 * 能实时刷新对端 UI。
	 *
	 * 仍保留 localStorage 双写：迁移期兜底，且旧值可被 `_restoreCompactedBaseline`
	 * 的降级分支读到，避免升级后已压缩会话的进度圈瞬间回退到未压缩值。
	 */
	private _saveCompactedBaseline(baseline: number): void {
		const key = this._compactedBaselineKey();
		if (!key) { return; }
		try {
			this._storageService.store(key, String(baseline), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} catch { /* storage may be unavailable */ }
		// 兼容旧版本读取（双写，见方法注释）
		try {
			localStorage.setItem(`saros:compactedBaseline:${this._currentAgentId}:${this._currentSessionId}`, String(baseline));
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

/**
 * 「图片模型」偏好的 localStorage key（per-pane，2026-09-10）。
 * 值形如 `auto` | `provider:<providerId>:<modelId>`；不随 agent/session 变化
 * （图片模型是面板级能力选择，与当前会话无关）。
 */
private _imageModelPrefKey(): string {
	return `${NativeChatEditorPane._STORAGE_IMAGE_MODEL}:pane${this._paneId}`;
}

/**
 * 把「图片模型」偏好写入 agent 配置（2026-09-10）。
 *
 * 偏好字符串 → agent 字段的映射（与 `_getImageModelLabel` 的解析约定一致）：
 *   - `'auto'`                          → 清空 imageProviderId/imageModel（跟随全局默认）
 *   - `'provider:<providerId>:<modelId>'` → 写入对应两个字段
 *
 * 为什么必须写 agent 配置：图片模型是 agent 级能力（决定该 agent 生成图片时用哪个
 * 模型），需跨 pane / 跨会话 / 跨重启生效，且要与 agent 设置页「图片生成模型」
 * 双向一致——只写 localStorage 会在换窗口后丢失。
 */
private async _persistImageModelToAgent(preference: string): Promise<void> {
	let imageProviderId: string | undefined;
	let imageModel: string | undefined;
	const parts = (preference || '').split(':');
	if (parts[0] === 'provider' && parts.length >= 3) {
		imageProviderId = parts[1];
		imageModel = parts.slice(2).join(':');
	}

	// ① 用户级全局配置：**总是写**（2026-09-10）。这是工具侧 image_generate 在
	//    agent 配置缺失时读的那一份——内置 agent（只读）场景下用户的选择只有
	//    落到这里才会真正生效，否则会掉进自动路由选中不支持 Images API 的 provider。
	try {
		await this._configurationService.updateValue(AGENT_STUDIO_IMAGE_GEN_PROVIDER, imageProviderId ?? '');
		await this._configurationService.updateValue(AGENT_STUDIO_IMAGE_GEN_MODEL, imageModel ?? '');
		this._logService.info(
			`[NativeChatEditorPane#${this._paneId}] image model default persisted (user-level): ` +
			`provider=${imageProviderId ?? '(cleared)'} model=${imageModel ?? '(cleared)'}`
		);
	} catch (err) {
		this._logService.warn('[NativeChatEditorPane] persist image model default (user-level) failed:', err);
	}

	// ② agent 配置：可写时同步（自定义 agent 优先于全局默认）
	if (!this._currentAgentId) { return; }
	try {
		await this._agentStudioService.updateAgent(this._currentAgentId, { imageProviderId, imageModel });
		this._logService.info(
			`[NativeChatEditorPane#${this._paneId}] _persistImageModelToAgent: agentId=${this._currentAgentId} ` +
			`imageProviderId=${imageProviderId ?? '(default)'} imageModel=${imageModel ?? '(cleared)'} → .agent.md`
		);
	} catch (err) {
		// ★ 2026-09-10：内置 agent 只读（如 saros-claw）→ 写 .agent.md 必然被拒。
		// 这不是异常而是预期：此时保留 localStorage 缓存（本 pane 内仍然生效），
		// 静默跳过 agent 持久化即可——否则用户每选一次图片模型都吃一条 error 日志
		//（日志 1789050110889 实证：updateAgent(saros-claw): rejected — builtin
		// agent is read-only）。要跨 pane 持久化请改用自定义 agent。
		const msg = err instanceof Error ? err.message : String(err);
		if (/只读|read-only/i.test(msg)) {
			this._logService.info(
				`[NativeChatEditorPane#${this._paneId}] _persistImageModelToAgent skipped — ` +
				`agent "${this._currentAgentId}" is read-only (builtin); kept in localStorage only`
			);
		} else {
			this._logService.warn('[NativeChatEditorPane] _persistImageModelToAgent failed:', err);
		}
	}
}

/** 从当前 agent 配置构造图片模型偏好串（未配置 → undefined，表示无 agent 级默认）。 */
private async _imagePreferenceFromAgent(): Promise<string | undefined> {
	if (!this._currentAgentId) { return undefined; }
	try {
		const agent = await this._agentStudioService.getAgent(this._currentAgentId);
		if (agent?.imageProviderId && agent?.imageModel) {
			return `provider:${agent.imageProviderId}:${agent.imageModel}`;
		}
	} catch { /* 读取失败按无默认处理 */ }
	return undefined;
}

/** 媒体资产库代理（惰性创建）。 */
private _getMediaBackend(): IMediaBackend {
	let backend = this._mediaBackend;
	if (!backend) {
		backend = createMediaStoreProxy(this._mainProcessService);
		this._mediaBackend = backend;
	}
	return backend;
}

/**
 * 把工具结果里的 `saros-media://<assetId>` 引用替换为 data URL（2026-09-10）。
 *
 * 背景：图片生成工具（image_generate）为避免 base64 进入 LLM 上下文，结果里只放
 * 媒体库短引用；UI 需要真实 data URL 才能显示图片。本方法在 **UI 侧**完成替换——
 * 服务端落盘的历史仍是短引用（不会被污染），只影响当前显示。
 *
 * 替换后主动 updateMessage，让工具卡用新结果重渲染（工具卡据此渲染 <img>）。
 */
private async _resolveMediaRefsInToolResult(tc: any, msgId: string, msg: any): Promise<void> {
	const text = typeof tc?.result === 'string' ? tc.result : '';
	if (!text.includes('saros-media://')) { return; }
	const ids = [...text.matchAll(/saros-media:\/\/([A-Za-z0-9_-]+)/g)].map(m => m[1]);
	if (ids.length === 0) { return; }
	let replaced = text;
	let resolved = 0;
	for (const id of ids) {
		try {
			const dataUrl = await this._getMediaBackend().getAsDataUrl(id);
			if (dataUrl) {
				replaced = replaced.split(`saros-media://${id}`).join(dataUrl);
				resolved++;
			}
		} catch (err) {
			this._logService.warn(`[NativeChatEditorPane] resolve media ref ${id} failed:`, err);
		}
	}
	if (resolved > 0 && replaced !== text) {
		tc.result = replaced;
		this._chatPanel?.updateMessage(msgId, { toolCalls: (msg.toolCalls ?? []).slice() });
		this._logService.info(`[NativeChatEditorPane#${this._paneId}] resolved ${resolved}/${ids.length} saros-media ref(s) → data URL for UI display`);
	}
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
			const providerKey = this._storageKey(NativeChatEditorPane._STORAGE_PROVIDER);
			const modelKey = this._storageKey(NativeChatEditorPane._STORAGE_MODEL);
			const savedProvider = localStorage.getItem(providerKey);
			const savedModel = localStorage.getItem(modelKey);
			// ── 诊断日志（2026-08-29）：重启后 provider/model 丢失定位 ──
			// 打印实际读取的 key 与值，便于确认是「没存」还是「key 不匹配」还是「没恢复」。
			this._logService.info(
				`[ModelSelRestore] pane#${this._paneId} agent=${this._currentAgentId} ` +
				`providerKey=${providerKey}=${savedProvider ?? '(none)'} ` +
				`modelKey=${modelKey}=${savedModel ?? '(none)'} ` +
				`currentLocal=${this._localProviderId ?? ''}/${this._localModelId ?? ''}`
			);
			if (savedProvider && savedModel) {
				this._localProviderId = savedProvider;
				this._localModelId = savedModel;
				this._chatPanel.setCurrentProvider(savedProvider);
				this._chatPanel.setCurrentModel(savedModel);
				this._logService.info(`[ModelSelRestore] restored → ${savedProvider}/${savedModel}`);
			} else {
				// 无本地覆盖时，使用 Agent 配置的默认 provider/model
				this._logService.info(`[ModelSelRestore] no saved selection — falling back to agent default`);
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

	/** 从持久化存储恢复压缩基线（窗口重载后 token 进度条保持压缩后数值）。
	 *  新会话或无压缩历史时清除基线，避免残留旧值。
	 *
	 *  读取顺序：IStorageService（新）→ localStorage（旧版本遗留）→ 0。
	 *  降级分支保证升级后首次打开旧会话时，压缩基线不会瞬间回退。 */
	private _restoreCompactedBaseline(): void {
		const key = this._compactedBaselineKey();
		if (!key) {
			this._chatPanel?.setCompactedBaseline(0);
			return;
		}
		// 1. 新存储（跨窗口共享 + 变更通知）
		try {
			const saved = this._storageService.get(key, StorageScope.APPLICATION);
			if (saved) {
				const baseline = parseInt(saved, 10);
				if (baseline > 0) {
					this._chatPanel?.setCompactedBaseline(baseline);
					return;
				}
			}
		} catch { /* storage may be unavailable */ }
		// 2. 旧存储降级（迁移期）
		try {
			const legacy = localStorage.getItem(`saros:compactedBaseline:${this._currentAgentId}:${this._currentSessionId}`);
			if (legacy) {
				const baseline = parseInt(legacy, 10);
				if (baseline > 0) {
					this._chatPanel?.setCompactedBaseline(baseline);
					// 顺手迁移到新存储，下次即走快路径
					this._saveCompactedBaseline(baseline);
					return;
				}
			}
		} catch { /* localStorage may be unavailable */ }
		// 无保存的基线 → 重置为 0（新会话或从未压缩过）
		this._chatPanel?.setCompactedBaseline(0);
	}

	/**
	 * 订阅「他窗口写入的压缩基线」—— 修复多窗口压缩 UI 不更新。
	 *
	 * 场景：窗口 A 跑完一轮触发压缩并落盘基线；窗口 B 打开着同一 agent+session，
	 * 其进度圈 / 压缩提示应当同步刷新，而不必等用户手动切换会话。
	 *
	 * 实现：`IStorageService.onDidChangeValue` 经主进程 IPC 广播
	 * （storageIpc.ts `onDidChangeStorage`），`key` 传 undefined 表示监听该 scope
	 * 下所有键的变更 —— 因为用户可能在 B 窗口切换了 agent/session，
	 * 此时不同的 key 才是「当前会话」的基线，必须由回调内的 `_compactedBaselineKey()`
	 * 实时比较而非订阅时固定。
	 */
	private _registerCompactedBaselineSync(): void {
		this._register(this._storageService.onDidChangeValue(
			StorageScope.APPLICATION,
			undefined,
			// 该 DisposableStore 只管理 Event.filter 的内部过滤器，订阅本体由外层 _register 释放
			this._register(new DisposableStore()),
		)((e) => {
			const currentKey = this._compactedBaselineKey();
			if (!currentKey || e.key !== currentKey) { return; }
			// external=true 表示变更来自另一个窗口/进程（见 IStorageValueChangeEvent 注释）。
			// 本窗口自身的写入已在 context_compacted 分支更新过 UI，跳过以免重复渲染。
			if (!e.external) { return; }
			const baseline = parseInt(this._storageService.get(currentKey, StorageScope.APPLICATION) ?? '0', 10);
			if (baseline > 0) {
				this._chatPanel?.setCompactedBaseline(baseline);
				this._logService.info(
					`[NativeChatEditorPane] Compacted baseline synced from another window: ${baseline} (session=${this._currentSessionId})`,
				);
			}
		}));
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
		// 2026-09-10：真正开始一条新流 —— 解除「流式已放弃」标记（见字段注释）。
		// 置于 stale 检查之后：自愈路径调用本方法时该标记必为 false，复位无副作用。
		this._streamingAbandoned = false;
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
	// 新流式消息：重置当前 text 段起点 + content_replace 追加式缓存
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
	 * 找出「可以续接」的流式 assistant 消息 —— 句柄被清空、但气泡仍显示在面板里且仍在流式中。
	 *
	 * ★★ 2026-09-16：修「一次 LLM 答复被错误拆分成多段气泡」的核心判据。
	 * 背景与事故链见调用点（`_processDelta` 自愈分支）注释：`_handoffActiveStream()`
	 * 会因「聊天页签不再显示」（如 LLM 打开 mermaid 预览页签）而清空 `_streamingAssistantId`，
	 * 旧代码随后 `_initStreamingMessage()` 新建气泡 ⇒ 答复被切段。
	 *
	 * 判据刻意收得很紧，宁可不接（新建气泡）也不误接（旧消息被继续追加而错乱）：
	 *  · **最后一条**消息 —— 流式气泡永远在列表末尾；中间的消息必已收尾；
	 *  · `role === 'assistant'`；
	 *  · `isStreaming === true` —— pane 在 done/error 收尾时会置 false，
	 *    因此「已收尾的上一轮」不会被接上。
	 */
	private _recoverableStreamingMessage(): IAgentChatMessage | undefined {
		const msgs = this._chatPanel?.getMessages() ?? [];
		const last = msgs[msgs.length - 1] as (IAgentChatMessage & { isStreaming?: boolean }) | undefined;
		if (last && last.role === 'assistant' && last.isStreaming === true) {
			return last;
		}
		return undefined;
	}

	/**
	 * 跨流补发的 tool_result / tool_end 兜底（2026-09-06）。
	 *
	 * 工具在所属消息的流结束后才执行，其结果/结束事件常在**下一轮流开头**才到达
	 * pane——此时 `_streamingAssistantMsg` 已切到新消息，按当前消息 find 工具卡
	 * 必然失配，旧实现静默 return → 卡片 status=success（end 在同流先到）但
	 * result 永远为空 → 永远显示「等待工具结果」（日志 1788709752561 实证：
	 * branch=awaiting-result status=success；STREAM_END toolStarts=3 toolResults=1）。
	 *
	 * 此处从最新消息往回扫，找到持有该 toolCallId 的卡就地补写，并让 panel
	 * 重渲该消息。全部消息都没有 → warn 留痕（此前此路径完全不可观测）。
	 */
	private _applyLateToolDelta(currentMsgId: string, toolCallId: string | undefined, apply: (tc: any) => void, kind: string): void {
		if (!toolCallId || !this._chatPanel) { return; }
		const msgs = this._chatPanel.getMessages();
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i] as any;
			if (m.id === currentMsgId || m.role !== 'assistant') { continue; }
			const tc = (m.toolCalls ?? []).find((t: any) => t.id === toolCallId);
			if (!tc) { continue; }
			apply(tc);
			this._chatPanel.updateMessage(m.id, { toolCalls: (m.toolCalls ?? []).slice() });
			this._logService.info(
				`[NativeChatEditorPane#${this._paneId}] ${kind} for ${toolCallId} applied to EARLIER ` +
				`message ${m.id} (late cross-stream delivery — placeholder card recovered)`
			);
			return;
		}
		this._logService.warn(
			`[NativeChatEditorPane#${this._paneId}] ${kind} dropped — no card for toolCallId=${toolCallId} ` +
			`in current or any earlier message`
		);
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
/**
 * 把「非前台会话」的 delta 存入后台缓冲（切回时回放）。
 *
 * 只在「本 pane 本地发送的会话被切走」期间调用（见 sendMessage 的 onDelta 守卫）。
 * 超限（`_BACKGROUND_DELTA_LIMIT`）后丢弃新 delta 并告警一次——丢弃**后缀**而非前缀，
 * 保证回放出的 parts 前缀完整（tool_start/tool_end 配对不会从中间断裂）。
 */
private _bufferBackgroundDelta(sessionId: string, delta: any): void {
	let buf = this._backgroundDeltaBuffer.get(sessionId);
	if (!buf) {
		buf = [];
		this._backgroundDeltaBuffer.set(sessionId, buf);
	}
	const limit = NativeChatEditorPane._BACKGROUND_DELTA_LIMIT;
	if (buf.length >= limit) {
		// ★ 2026-09-12（P2 优化）：原实现「超限即丢**新** delta」，导致长时间切走时
		//   切回后内容缺失且用户无感知。现改为**丢最旧的 text delta**——
		//   ① text 是纯增量，丢掉只损失文字，不会破坏 parts 结构（tool_start/tool_end
		//      必须配对，丢任一端都会让回放出的卡片错乱）；
		//   ② 一次回收 5%，使后续 ~1000 个 delta 都不再触发本分支（摊销 O(1)）；
		//   ③ 丢弃量记入 `_backgroundDroppedDeltas`，切回时在回放日志中标注，不静默。
		const target = Math.max(1, Math.floor(limit * 0.05));
		let removed = 0;
		for (let i = 0; i < buf.length && removed < target;) {
			const d = buf[i];
			if (d && d.type === 'text') { buf.splice(i, 1); removed++; } else { i++; }
		}
		if (removed === 0) {
			// 极端：缓冲内全是非 text（工具风暴）→ 退化为丢最旧一条（保尾部最新内容）
			buf.shift();
			removed = 1;
		}
		this._backgroundDroppedDeltas += removed;
		this._logService.warn(
			`[NativeChatEditorPane#${this._paneId}] background delta buffer full (${limit}) for session ${sessionId}; ` +
			`recycled ${removed} oldest text delta(s) (total dropped=${this._backgroundDroppedDeltas}). ` +
			`Replayed content may be truncated.`,
		);
	}
	buf.push(delta);
}

/**
 * ★ 2026-09-12：本面板正在显示的会话被**别处**删除后的处理。
 *
 * 场景：用户在会话历史视图 / 会话浏览器里删掉了聊天面板正打开的会话 —— 面板自己的
 * `onDeleteSession` 回调不会触发，`_currentSessionId` 会一直指向已删会话，导致后续
 * 发送 `getHistory: 0 msgs` + `Auto-rename failed: Session ... not found`
 * （日志 20260912T102833）。
 *
 * 语义与 `onDeleteSession` 中「删的是当前会话」分支一致：优先切到最近会话，
 * 没有则清空视图（`_currentSessionId = null`，下次发送由 `_ensureSession` 新建）。
 */
private async _handleCurrentSessionDeleted(agentId: string): Promise<void> {
	try {
		const sessions = await this._chatService.listAgentSessions(agentId);
		if (sessions.length > 0) {
			this._currentSessionId = sessions[0].id;
			void this._updateSessionLock();
			if (this.input instanceof NativeChatEditorInput) {
				this.input.setAgentInfo(this.input.name, agentId, sessions[0].id, sessions[0].name);
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
			this._restoreComposerDraft();
		}
		await this._refreshSessionList();
	} catch (err) {
		this._logService.warn(
			`[NativeChatEditorPane] _handleCurrentSessionDeleted(${agentId}) failed: ${err instanceof Error ? err.message : err}`,
		);
	}
}

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
				// 工具对账（2026-09-06）：tool_start vs tool_result 计数。★ 差值跨流
				// **正常**——tool_result 在下一轮流开头补发（工具在流结束后执行），
				// 故只做对账回显、不做告警；整份日志总和失衡才是结果丢失信号
				//（当日曾因误读单流差值错判「丢失 2/3」）。
				const toolStarts = pf.totalTypes['tool_start'] ?? 0;
				const toolResults = pf.totalTypes['tool_result'] ?? 0;
				// 2026-08-30：加 paneId/sessionId —— 多窗口并发时两个 pane 的 STREAM_END
				// 混在同一份日志里且无标识，只能靠计数反推归属（排查 20260829T232635 的痛点）。
				this._logService.info(`[StreamPerf] STREAM_END p${this._paneId} session=${this._currentSessionId} total=${totalElapsed}ms deltas=${pf.deltaCount} types={${typeBreakdown}} slowFlushes=${slowCount} toolStarts=${toolStarts} toolResults=${toolResults}`);
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

		// ★★ 2026-09-16 诊断（用户报「多 subagent 并行时工具卡片刷新异常」）：
		// 一眼看出「数据到没到、挂到了哪张卡、有没有卡是空的」。
		// 两种异常形态都能被这条日志区分：
		//   ① `attached=[...:0]`（某张卡挂到 0 个子代理）⇒ 分组被并到别的卡（关联错误）；
		//   ② `groups=2 cards=3` 而某卡为 0 ⇒ 有组没找到目标卡（兜底链也没兜住）。
		if (delegateTcs.length > 0) {
			const rows = delegateTcs.map((tc: any) => `${String(tc.id).slice(-6)}:${(tc.subAgents ?? []).length}`);
			this._logService.info(
				`[SubAgentAttach] sa=${subAgents.length} groups=${internalGroups.size} cards=${delegateTcs.length} `
				+ `used=${usedTc.size} attached=[${rows.join(', ')}]`,
			);
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
		// let（非 const）：下方自愈分支重建流式消息后需重新绑定，否则各 case 仍读到 null
		let assistantId = this._streamingAssistantId;
		let assistantMsg = this._streamingAssistantMsg;

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

		// ── 2026-08-30：流式消息缺失的可观测 + 自愈 ──────────────────────────
		// 事故（日志 20260829T232635/window1）：新建聊天窗口（Pane#2）发消息后，
		// LLM 侧完全正常（ToolAudit iters=10、末段 STREAM_END text=229、历史追加
		// 12 条 assistant），但 UI 一条都不显示。
		// 根因机制：_streamingAssistantMsg/_streamingAssistantId 在流式途中被提前
		// 清空（_resetStreamingMessage 共 7 处调用），此后下方**每个** case 首行的
		// `if (!assistantMsg || !assistantId) return;` 把所有 delta 静默丢弃 —— 且
		// 零日志，事后只能靠「STREAM_END 有 / PartsDiag 无」的计数差反推，无法归因。
		// 这里统一打点；并在「本 pane 仍处于发送态」时自愈重建，避免整轮内容全丢。
		if (!assistantId || !assistantMsg) {
			// done/error 是终态：即便缺失也只记录，不重建（否则流真正结束时凭空多出空气泡）
			const isTerminal = delta.type === 'done' || delta.type === 'error';
			this._logService.warn(
				`[NativeChatEditorPane#${this._paneId}] _processDelta: streaming msg MISSING on type=${delta.type} ` +
				`(id=${assistantId ?? 'null'}, msg=${assistantMsg ? 'set' : 'null'}) | session=${this._currentSessionId} ` +
				`chatId=${this._currentInputChatId} isSending=${this._isSending} isExternalSend=${this._isExternalSend} ` +
				`localSendActive=${this._localSendActiveSessionId ?? 'null'}`
			);
			// 自愈：仍在发送态 + 非终态 delta + 确实没有流式消息 → 重建，让后续 delta 有归宿。
			// 三重条件缺一不可：发送态保证不该丢内容；非终态避免空气泡；!_streamingAssistantId 防重建覆盖。
			// 2026-09-10 第四条件 !_streamingAbandoned：切换会话后旧会话的流已放弃，
			// 漏入的 delta 不得在新会话里凭空重建流式消息（否则高频重建 → 卡死，
			// 详见 _streamingAbandoned 字段注释）。
			if (this._isSending && !isTerminal && !this._streamingAssistantId && !this._streamingAbandoned) {
				// ★★ 2026-09-16：先尝试**续接仍显示中的流式气泡**，接不上才新建
				// —— 修「一次 LLM 答复被错误拆分成多段气泡」。
				//
				// 事故（日志 `vscode-app-1789528831953.log`）：LLM 输出途中调
				// `renderMermaidDiagram` ⇒ 应用**打开 mermaid 预览页签**（`[MermaidOpenPreview]
				// opened in editor tab`）⇒ 聊天页签不再显示 ⇒ VS Code 调 `clearInput()` ⇒
				// `_handoffActiveStream()` 把 `_streamingAssistantId` 清空（**该路径没有日志**）。
				// 而流仍在跑（`isSending=true`），下一个 text delta 命中本分支 ⇒ 旧实现
				// `_initStreamingMessage()` **新建**一条 `msg_..._assistant` ⇒ 同一段答复被切成
				// 两个气泡。实测连续发生两次（`msg_1789527908098` / `msg_1789527911720`，
				// 新气泡第 28 / 1627 字符开始），用户观感即「一次答复被拆成多段」。
				//
				// 判据（`_recoverableStreamingMessage()`）：面板**最后一条** assistant 消息
				// 仍是 `isStreaming === true` ⇒ 它就是被切段的那条，接回来继续追加正文/工具卡；
				// 否则说明上一条确已收尾（新 turn 的正常路径由调用方直接 `_initStreamingMessage`，
				// 不走这里），才新建气泡。
				const recoverable = this._recoverableStreamingMessage();
				if (recoverable) {
					this._streamingAssistantId = recoverable.id;
					this._streamingAssistantMsg = recoverable;
					this._logService.info(
						`[NativeChatEditorPane#${this._paneId}] _processDelta: RE-ADOPTED in-flight assistant msg ` +
						`${recoverable.id} — continuing the SAME bubble (handle was cleared mid-stream, type=${delta.type})`
					);
				} else {
					this._initStreamingMessage();
				}
				assistantId = this._streamingAssistantId;
				assistantMsg = this._streamingAssistantMsg;
				this._logService.warn(
					`[NativeChatEditorPane#${this._paneId}] _processDelta: SELF-HEALED streaming msg ` +
					`(newId=${assistantId ?? 'null'}, adopted=${recoverable ? 'yes' : 'no'}, ` +
					`session=${this._currentSessionId}, type=${delta.type})`
				);
			}
		}

		switch (delta.type) {
			case 'text':
				if (!assistantMsg || !assistantId) { return; }
				{
					// ★ 2026-09-06 重复文本修复：先捕获替换前的 content 长度。
					// fullText 比 content 短时回退到 append 模式
					// （agentStudioWebviewController 检测到 tool XML 后会重置 streamingTextBuffer，
					// 导致后续 fullText 只含工具标签后的文本，无脑替换会清空冒泡内容）
					const prevContentLen = assistantMsg.content.length;
					let textContent = (delta.fullText !== undefined && delta.fullText.length >= prevContentLen)
						? delta.fullText
						: (assistantMsg.content + (delta.content ?? ''));
					// ★ 流式 sanitize：模型可能在  think 块内「伪造」工具调用形状
					//   （<tool_calls:hexid> <tool_call:hexid>tool_name 等），这些标签会随
					//   text delta 原样流入 UI。此处对每次增量做轻量 sanitize（幂等），
					//   确保 panel 实时渲染不含伪标签。content_replace 阶段再做全量 sanitize
					//   作为兜底（见下方 case 'content_replace'）。
					textContent = sanitizeAssistantVisibleText(textContent, 'streaming');
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
				// ★★★ 2026-09-19：journal 一笔（崩溃保命 ✓）—— 流式途中进程死掉时，
				// 重启后最多丢最后 ~2s 的输出（对齐 Cline write-through / OpenCode 逐 part 落盘 ✓）
				this._journalStreamingDraft();
					// P0: 跟踪文本→工具→文本的时间顺序。
					// text part 只保存「当前段」文本，而非全量 content——否则工具后的
					// 新 text part 会重复包含工具前的文本，导致同一段文本在工具卡前后
					// 渲染两次。
					//
					// ★ 2026-09-06 重复文本修复（日志 1788708458481 实证）：
					// 旧实现用 `_streamTextSegmentBase` 切段，但 base 在跨 iteration
					// 场景必然失明——时序：iter1 文本 A(230c) → tool_start（base=230）
					// → content_replace（base=content.len-A'.len=0）→ iter2 首 delta
					// 的 fullText=**A+B(469c)**（webviewController 的 streamingTextBuffer
					// 跨 iteration 累积、原生 tool_calls 不重置它）→ 替换模式成立 →
					// slice(base=0) 切出 **A+B 整段**，此时最后 part 是 tool → push
					// text(469c) part → A 在 text(230c) 与 text(469c) 两个 part 里
					// 各渲染一次（PartsDiag 实证两 part 并存，469=230+239 精确吻合；
					// UI 表现：同一段话在工具卡前后各出现一遍，第二份还带新内容）。
					//
					// 新公式不依赖 base：本段起点 = 替换前 content 长 - 当前段长
					// （= 本段之前所有已渲染文本的总长）。
					//  - 继续本段（last 是 text）：segStart = 段起点 → segText = 段+增量 ✅
					//  - 工具后开新段（last 是 tool）：lastSegLen=0 → segStart=prevLen
					//    → segText = **纯增量**（替换模式 = fullText 超出旧 content 的
					//    部分；append 模式 = delta.content）→ 不再裹挟历史文本 ✅
					//  - 替换模式恒有 fullText.length ≥ prevLen → segStart 永不越界，
					//    旧 base overshoot 分支自然消失（warn 保留作观测）。
					if (assistantMsg.parts) {
						const last = assistantMsg.parts[assistantMsg.parts.length - 1];
						const lastSegLen = (last && last.kind === 'text') ? (((last as any).text ?? '').length) : 0;
						const segStart = Math.max(0, prevContentLen - lastSegLen);
						let segText = segStart <= textContent.length
							? textContent.slice(segStart)
							: textContent;   // 防御回退（理论上不再触达）
						// 防御：segText 来自已 sanitize 的全量文本，但再做一次幂等 sanitize 无害
						segText = sanitizeAssistantVisibleText(segText, 'streaming');
						if (last && last.kind === 'text') {
							// 最后一个 part 是 text → 就地更新当前段。
							// 空段只在 last 本身尚为空时才允许写入，绝不覆盖已有内容。
							if (segText.length > 0 || !((last as any).text ?? '')) {
								(last as any).text = segText;
							}
						} else if (segText.length > 0) {
							// 最后一个 part 是 tool（或空）→ 开启新 text 段
							assistantMsg.parts.push({ kind: 'text', text: segText } as any);
						}
						if (segStart > textContent.length) {
							this._logService.warn(
								`[NativeChatEditorPane#${this._paneId}] text seg start overshoot: ` +
								`segStart=${segStart} contentLen=${textContent.length} segText.len=${segText.length}`
							);
						}
					}
				}
				break;
			case 'content_replace':
				if (!assistantMsg || !assistantId) { return; }
				{
					const replaced = typeof delta.content === 'string' ? delta.content : '';
					// host 端 content_replace 携带的是【当前轮】sanitize 后的文本
					// （agentTurnExecutor L3056/L3077 的 assistantContent），并非跨轮累积全文。
					// 因此必须【只替换最后一个文本段】，保留前面各轮已流式建立的文本段与
					// 工具卡穿插顺序——否则前面各轮的文本会被整体重切片覆盖丢失 → 消息中间截断。
					// 流式 text delta 可能残留 <tag:hexid> 伪标签等泄漏（见 sanitizeAssistantVisibleText），
					// 此处用 host 已 sanitize 的 replaced 覆盖最后一段即可。
					if (assistantMsg.parts) {
						const oldParts = assistantMsg.parts as any[];
						const dumpOf = (arr: any[]) => JSON.stringify(arr.map((p: any) =>
							p.kind === 'tool' ? `tool:${((p?.tool?.name) ?? (p?.tool?.toolName) ?? '?')}`
								: `text(${(p?.text ?? '').length}c)`));
						// 节流（2026-09-06）：本条与下方 OUT 每条都对 **全部 parts 做
						// JSON.stringify**，而 content_replace 在流式过程中每个 chunk
						// 都会触发一次 —— 实测单个 delta 处理 19ms（SLOW_FLUSH 阈值
						// 16ms），且成本随 parts 数量增长 → 长输出越来越卡、主线程繁忙。
						// 诊断价值在于 parts 序列（排查 2026-08-31「消息中间截断」），
						// 故保留、**每 25 次输出一次**（对齐下方 thinking 日志的节流模式）。
						// 且必须在 if 内调用 dumpOf —— 否则模板字符串会先求值，节流
						// 也省不掉 stringify 的成本。
						const _crMsg = assistantMsg as any;
						_crMsg._crReplaceCount = (_crMsg._crReplaceCount ?? 0) + 1;
						const _crLog = (_crMsg._crReplaceCount % 25) === 1;
						if (_crLog) {
							this._logService.info(`[NativeChatEditorPane#${this._paneId}] content_replace IN content.len=${replaced.length} seq=${_crMsg._crReplaceCount} parts=${dumpOf(oldParts)}`);
						}

						const newParts: any[] = oldParts.map((p: any) => ({ ...p }));
						// 找到最后一个文本段，用 replaced 覆盖它；保留其余 parts 不变。
						let lastTextIdx = -1;
						for (let i = newParts.length - 1; i >= 0; i--) {
							if (newParts[i].kind === 'text') { lastTextIdx = i; break; }
						}
						if (lastTextIdx >= 0) {
							newParts[lastTextIdx] = { ...newParts[lastTextIdx], text: replaced };
						} else {
							newParts.push({ kind: 'text', text: replaced });
						}
						assistantMsg.parts = newParts;
						// content = 所有文本段拼接（完整消息文本，含前面各轮），避免 content 被截断。
						assistantMsg.content = newParts
							.filter((p: any) => p.kind === 'text')
							.map((p: any) => p.text ?? '')
							.join('');
						// ★ 2026-08-31：content 已被按 parts 重算，同步当前段起点。
						// replaced 是「当前轮」文本，故当前段起点 = 新 content 长度 - replaced 长度。
						// 不改的话 base 停留在旧值（上一轮 tool_start 记的长度），下一个 text
						// delta 的 slice 会算出重复文本或空串（配合上面 base 越界回退才不至于清空，
						// 但会重复包含前面各段的文字）。
						this._streamTextSegmentBase = Math.max(0, assistantMsg.content.length - replaced.length);
						if (_crLog) {
						this._logService.info(`[NativeChatEditorPane#${this._paneId}] content_replace OUT content.len=${assistantMsg.content.length} base=${this._streamTextSegmentBase} seq=${_crMsg._crReplaceCount} parts=${dumpOf(newParts)}`);
					}
					} else {
						assistantMsg.content = replaced;
					}
					this._chatPanel?.setStreamTextBuffer(assistantMsg.content);
					this._chatPanel?.updateMessage(assistantId, {
						content: assistantMsg.content,
						parts: assistantMsg.parts?.slice(),
						activityText: assistantMsg.activityText,
						isStreaming: true,
						isThinking: false,
						streamPhase: 'llm_streaming',
					});
				}
				break;
			case 'thinking':
				if (!assistantMsg || !assistantId) { return; }
				{
					const prevThinking = assistantMsg.thinking ?? '';
					const thinkingContent = delta.fullThinking !== undefined ? delta.fullThinking : (prevThinking + (delta.content ?? ''));
					assistantMsg.thinking = thinkingContent;
					// （2026-09-06「思考卡卡住」的节流诊断打点已移除：glm reasoning 每轮
					// 5 万+ 帧，每 25 帧一条 = 2000+ 条日志，完全淹没其他事件——日志
					// 1788708458481 实证排查时只能先过滤掉它。需要时用 STREAM_END 的
					// thinking=NNNN 计数对账即可。）
					// thinking 作为 parts 流片段（2026-07-26 用户要求：不固定顶部，
					// 跟随 LLM 流式输出的实际发生位置）。
					// ★ 2026-09-06 修正一（日志 1788670708266）：原「last part 非 thinking
					// → 开新 episode」被周期性 tool part 插拔打碎（12606 字符切成 13 段）
					// → 改为追加到最后一个 thinking part。
					// ★★ 2026-09-06 修正二（用户报「第二次思考被错误并入第一张卡」）：
					// 修正一**过度**——agent loop 的**第二轮思考**（上一轮工具执行完之后
					// 的新思考）语义上是新 episode，不该并进第一张卡。正确的 episode 边界
					// 是「工具执行结束」（tool_end/tool_result），而非「last part 的种类」：
					//   - 思考→工具参数生成（合成卡插拔）→ 同一轮内 → **连续追加** ✓
					//   - 工具执行完（tool_end）→ 新一轮思考 → **新 episode 新卡** ✓
					// 实现：tool_end/tool_result 时置 `_thinkingEpClosed=true`；下一个
					// thinking delta 开新 part 并复位标志。
					const increment = thinkingContent.slice(prevThinking.length);
					if (assistantMsg.parts && increment.length > 0) {
						const epClosed = (assistantMsg as any)._thinkingEpClosed === true;
						const lastThinking = epClosed
							? undefined
							: ([...assistantMsg.parts].reverse().find(p => (p as any).kind === 'thinking') as any);
						if (lastThinking) {
							lastThinking.text += increment;
						} else {
							assistantMsg.parts.push({ kind: 'thinking', text: increment } as any);
							(assistantMsg as any)._thinkingEpClosed = false;
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

				// 清除 tool_progress 期间创建的合成占位卡（2026-09-06：从 file_write
				// 专用推广到任意工具；id 前缀 _tp_synth_<tool>_，兼容清理旧 _tp_fw_ 残留）
				let _carriedArgs = '';
				if (assistantMsg.toolCalls?.length) {
					const synthCards = assistantMsg.toolCalls.filter((t: any) => {
						const tid = String(t.id);
						return tid.startsWith('_tp_synth_') || tid.startsWith('_tp_fw_');
					});
					// 2026-09-06：占位卡在参数流式期间已累积了参数文本，tool_start 建真实
					// 卡时把这段文本**继承**过来，避免卡内已显示的参数被清空（观感回退）。
					// 清除不再按 name 匹配——占位卡在网关未下发 function.name 时暂名
					// 'unknown'，按名匹配会漏删 → 真实卡与占位卡并存（重复卡）。
					_carriedArgs = synthCards.length
						? synthCards.map((c: any) => c.args ?? '').filter(Boolean).join('')
						: '';
					for (const sc of synthCards) {
						const si = assistantMsg.toolCalls.indexOf(sc);
						if (si >= 0) { assistantMsg.toolCalls.splice(si, 1); }
						if (assistantMsg.parts) {
							const pi = assistantMsg.parts.findIndex((p: any) => p.kind === 'tool' && p.tool?.id === sc.id);
							if (pi >= 0) { assistantMsg.parts.splice(pi, 1); }
						}
					}
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
					// 继承占位卡在参数流式期间已累积的参数文本
					args: _carriedArgs,
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
				this._logService.info(`[NativeChatEditorPane#${this._paneId}] tool_start push parts=${JSON.stringify((assistantMsg.parts as any[]).map((p: any) => p.kind + (p.kind === 'tool' ? `:${((p?.tool?.name) ?? (p?.tool?.toolName) ?? '?')}` : '')))}`);
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
				// ★ 2026-09-06 终版：UI 完全静默（用户定论：占位卡「全部干掉」）。
				// 参数流式呈现的两轮尝试（阶段指示器播报 → 占位卡卡内流式参数）在
				// glm **reasoning 与 tool_calls 并行**的真实形态下都无法干净呈现：
				// ① 指示器与「正在思考」状态冲突；② 占位卡与思考/正文交错插入，
				// 且 push 进 parts 时不更新 _streamTextSegmentBase → 后续 text delta
				// 按旧 base 切分 → **正文整段重复**（用户实测截图）。
				// progress 帧回归其原始价值——provider 1s 节流信号供
				// resilience/P4/subagent 看门狗 idle 续命（防误杀健康流，事故
				// 1785049332701），UI 不做任何呈现。参数生成期界面由思考卡/正文
				// 流式自然覆盖（glm 并行形态下无假死窗）。
				break;
			}
			case 'tool_args': {
				if (!assistantMsg || !assistantId) { return; }
				// 2026-09-06：参数已到齐（工具进入执行）→ 参数生成期确定结束，清除
				// 瞬时活动文本。否则 tool_start 之后到达的 tool_progress 会把
				// 「正在生成工具调用参数…」指示器点亮到 turn 结束（tool_args/tool_end
				// 此前都不清，只有 text/tool_start/done 清）。
				assistantMsg.activityText = undefined;
				const argCall = (assistantMsg.toolCalls ?? []).find((tc: any) => tc.id === delta.toolCallId);
				if (argCall) {
					argCall.args = (argCall.args ?? '') + (delta.content ?? '');
					this._chatPanel?.updateMessage(assistantId, {
						toolCalls: assistantMsg.toolCalls!.slice(),
						activityText: undefined,
						isStreaming: true,
						streamPhase: 'tool_executing',
					});
				} else {
					// 2026-08-29（日志 1787932864271）：tool_args 到达却匹配不到卡片即被静默丢弃
					// → 卡片永远停在占位态（「（无命令）」/「执行中…」），且因
					// parseToolArgsLoose('') = {} 使 `card:args-arrived` 补齐也永不触发，故障自锁。
					// 已知成因：tool_start 缺 toolCallId 时建卡用的是 `tool_${Date.now()}`
					// 时间戳兜底 id（见上文 case 'tool_start'），后续 tool_args 带真实 id 匹配不上。
					// 该失败此前完全不可观测，必须留痕。
					this._logService.warn(`[AgentOS] tool_args dropped — no card for toolCallId=${delta.toolCallId} (contentLen=${(delta.content ?? '').length}, existingIds=[${(assistantMsg.toolCalls ?? []).map((t: any) => t.id).join(',')}])`);
				}
				break;
			}
			case 'tool_end': {
				if (!assistantMsg || !assistantId) { return; }
				// ★ 2026-09-06：工具执行结束 = 当前思考 episode 关闭。之后的新思考
				// （下一轮 LLM 输出）开新 thinking part / 新卡，不再并进第一张卡。
				(assistantMsg as any)._thinkingEpClosed = true;
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
				// 2026-09-06：工具已结束 → 清除瞬时活动文本（参数生成期确定结束）。
				assistantMsg.activityText = undefined;
				// turn 间「正在思考...」指示器（2026-07-26 修正）：指示器条件已放宽为
				// 仅 isThinking（见 agentChatPanel.messages.ts _ensurePhaseIndicator），
				// 无需清空 thinking——旧实现（tool_end 清 thinking）会导致置顶的
				// thinking 卡片在每个工具边界消失/重现，引发布局跳动（1785065604981）。
				this._chatPanel?.updateMessage(assistantId, {
					toolCalls: assistantMsg.toolCalls!.slice(),
					activityText: undefined,
					isStreaming: true,
					isThinking: true,
					streamPhase: 'llm_streaming',
				});
				} else {
					// ★ 2026-09-06 跨流补发兜底：tool_end 可能晚于所属消息的流结束到达
					//（此时 _streamingAssistantMsg 已切到下一条消息，find 必然失配）。
					this._applyLateToolDelta(assistantId, delta.toolCallId, tc => {
						const isError = (delta.success === false);
						tc.status = isError ? 'error' : 'success';
						if (isError && tc.result && !tc.error) { tc.error = tc.result; }
					}, 'tool_end');
				}
				break;
			}
			case 'tool_result': {
				if (!assistantMsg || !assistantId) { return; }
				// ★ 2026-09-06：同 tool_end——工具结果到达即关闭当前思考 episode。
				(assistantMsg as any)._thinkingEpClosed = true;
				const resultCall = (assistantMsg.toolCalls ?? []).find((tc: any) => tc.id === delta.toolCallId);
				if (resultCall) {
					resultCall.result = delta.content;
					// 仅在尚未被 tool_end 设为 error 时才默认 success（tool_end 后到的情况）。
					if (resultCall.status === 'running') { resultCall.status = 'success'; }
					this._chatPanel?.updateMessage(assistantId, {
						toolCalls: assistantMsg.toolCalls!.slice(),
					});
					// ★ 图片生成结果：把 `saros-media://<id>` 引用换成 data URL（仅 UI 显示，
					// 落盘历史仍是短引用）——工具卡据此渲染图片。
					void this._resolveMediaRefsInToolResult(resultCall, assistantId, assistantMsg);
				} else {
					// ★ 2026-09-06 跨流补发兜底（「工具卡显示等待工具结果」根因，日志
					// 1788709752561 实证 branch=awaiting-result status=success）：
					// 工具结果常在**下一轮流的流开头补发**（agent loop 的工具在流结束后
					// 执行），此时 _streamingAssistantMsg 已切到新消息——旧 find 在新消息
					// 的 toolCalls 里找上一条消息的工具 id，必然失配 → 静默 return →
					// 卡片 status=success（end 在同流先到）但 result 永远为空 →
					// 永远显示「等待工具结果」。此处回溯更早的消息补写结果。
					this._applyLateToolDelta(assistantId, delta.toolCallId, tc => {
						tc.result = delta.content;
						if (tc.status === 'running') { tc.status = 'success'; }
					}, 'tool_result');
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
					// ★ 2026-08-31：此前只清 content/thinking，既没同步 parts 也没重置
					// `_streamTextSegmentBase`，造成两处不一致：
					// ① parts 里残留被 host 丢弃的半截 text 段 → parts 文本和 > content
					//    （日志实证：最后一组 contentLen=390 / partsTextSum=438，差 48 恰是残留段）；
					// ② base 仍指向旧 content 长度 → 后续 text delta 的 slice 全部错位，
					//    表现为消息尾部截断/重复。
					// 故：移除「正在生成」的最后一个 text part，把 content 重算为剩余段拼接，
					// 并让 base 重新对齐到该长度（新段从这里开始）。
					let keptContent = '';
					if (assistantMsg.parts) {
						const parts = assistantMsg.parts as any[];
						const last = parts[parts.length - 1];
						if (last && last.kind === 'text') { parts.pop(); }
						keptContent = parts
							.filter((p: any) => p.kind === 'text')
							.map((p: any) => p.text ?? '')
							.join('');
					}
					assistantMsg.content = keptContent;
					assistantMsg.thinking = '';
					this._streamTextSegmentBase = keptContent.length;
					if (assistantId) {
						this._chatPanel?.updateMessage(assistantId, {
							content: keptContent,
							thinking: '',
							// parts 已被裁剪，必须显式下发，否则 panel 侧仍按旧 parts 渲染
							parts: assistantMsg.parts ? assistantMsg.parts.slice() : undefined,
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
						// 已被 tool_end 设为 error 的保留不变。
						// ★ 2026-09-07 修复（日志 1788710908280 实证）：**非取消不再置
						// success**。此处的 done 只是 **iteration 边界**（LLM 响应流结束），
						// 而工具在其**之后**才执行（日志：DONE 时三卡已 success，但
						// tool_end=0、「Executing tool」在 DONE 之后）——结果下一轮流才
						// 补发。提前标 success 会造出「status=success 且 result 空」的卡，
						// 渲染落进 awaiting 分支 → 永远显示「等待工具结果」。保持 running
						// （转圈）才是真实状态；终态由 tool_end/tool_result 写入（跨流
						// 补发时 _applyLateToolDelta 跨消息兜底）。
						if (tc.status === 'running' && isCanceled) { tc.status = 'canceled'; }
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
						// 2026-08-30：加 paneId/sessionId（同 STREAM_END，便于多窗口归因）
					this._logService.info(`[PartsDiag] DONE p${this._paneId} session=${this._currentSessionId} partsLen=${(assistantMsg.parts || []).length} isCanceled=${isCanceled} parts=[${partsSummary}] contentLen=${(assistantMsg.content||'').length} toolCalls=${(assistantMsg.toolCalls || []).length}`);
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
						// 分母对齐（2026-09-04）：随真值推送压缩判定口径的窗口/阈值
						// （ContextManager.resolveEffectiveWindowDefault 唯一真源：clamp(窗口,64k,200k)），
						// UI 环以压缩线为满刻度——大窗口模型不再出现「环 6% 实际 30%」错位。
						const budget = ContextManager.resolveEffectiveWindowDefault(limit);
						const _used = (delta.usage.inputTokens ?? 0) + (delta.usage.outputTokens ?? 0);
						const _ratio = Math.max(0, Math.min(1, _used / budget.effectiveWindow));
						this._chatPanel?.setContextUsage({
							used: _used,
							limit: budget.effectiveWindow,
							ratio: _ratio,
							percent: _ratio * 100,
							effectiveWindow: budget.effectiveWindow,
							thresholdTokens: budget.thresholdTokens,
						} as IContextUsage);
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
					const budget = ContextManager.resolveEffectiveWindowDefault(limit);
					const ratio = Math.max(0, Math.min(1, compacted / budget.effectiveWindow));
					this._chatPanel?.setContextUsage({
						used: compacted,
						limit: budget.effectiveWindow,
						ratio,
						percent: ratio * 100,
						effectiveWindow: budget.effectiveWindow,
						thresholdTokens: budget.thresholdTokens,
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
		// ── 诊断日志（2026-08-29）：用户气泡 send 按钮「点了没反应」定位 ──
		// 与面板侧 [EditSendDiag] commit() 日志配对：commit 打印 → 本行打印，
		// 说明回调链路通畅；只有 commit 没有本行，说明回调未注册或被吞。
		this._logService.info(
			`[EditSendDiag] _handleEditMessage ENTER pane#${this._paneId} msgId=${messageId} ` +
			`newTextLen=${newText.length} agent=${this._currentAgentId} session=${this._currentSessionId} ` +
			`isSending=${this._isSending} isExternalSend=${this._isExternalSend} ` +
			`staleStreaming=${this._streamingAssistantId ?? 'none'} hasChatPanel=${!!this._chatPanel}`
		);
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

		this._logService.info(
			`[EditSendDiag] _handleEditMessage → dispatching _sendMessageInternal ` +
			`(msgId=${messageId}, agent=${agentId}, session=${sessionId})`
		);
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

	private async _handleCheckpointAction(action: 'undoAll' | 'keepAll' | 'openDiff' | 'undoConversation' | 'openTimeline', payload?: { filePath?: string; checkpointId?: string }): Promise<void> {
		try {
			// 2026-09-12（P1-1）：只回退对话（保留代码）不走 CheckpointManager ——
			// 它只服务文件回退；对话截断由本 pane 直接经 chatService 完成。
			if (action === 'undoConversation') {
				await this._revertConversationOnly();
				return;
			}
			// 2026-09-12（P2-1）：检查点时间线同样由 pane 实现（需要 QuickPick + 刷新自身 UI）。
			if (action === 'openTimeline') {
				await this._openCheckpointTimeline();
				return;
			}
			// 2026-09-12（P1-3）：回退**代码**前预检「agent 编辑之后被用户手动改过」的文件 ——
			// 回退会把用户这次手改一并抹掉（唯一真实的数据丢失场景：agent 改完 → 用户又手改
			// → 回退）。有冲突时二次确认；用户取消则整体中止（不改文件、不动检查点）。
			if (action === 'undoAll' && this._currentAgentId && this._currentSessionId) {
				const conflicts = await this._checkpointService.detectExternallyModifiedFiles(
					this._currentAgentId, this._currentSessionId,
				);
				if (conflicts.length > 0) {
					const names = conflicts
						.map(f => f.split(/[/\\]/).filter(Boolean).pop() ?? f)
						.slice(0, 5)
						.join('、');
					const more = conflicts.length > 5 ? ` 等 ${conflicts.length} 个文件` : '';
					// `INotificationService.prompt` 返回 **handle**（不是下标）：用户选择经
					// `IPromptChoice.run` 回调返回；直接关闭通知（不点任何项）→ 视为**取消**
					// （保守：宁可不动，也不静默丢用户数据）。
					const proceed = await new Promise<boolean>(resolve => {
						let settled = false;
						const handle = this._notificationService.prompt(
							Severity.Warning,
							`有 ${conflicts.length} 个文件在你手动修改之后被回退，这些改动会丢失：${names}${more}。是否继续？`,
							[
								{ label: '仍然回退', run: () => { settled = true; resolve(true); } },
								{ label: '取消', run: () => { settled = true; resolve(false); }, isSecondary: true },
							],
						);
						this._register(handle.onDidClose(() => {
							if (!settled) { settled = true; resolve(false); }
						}));
					});
					if (!proceed) {
						this._logService.info(
							'[NativeChatEditorPane] undoAll cancelled by user (manual edits detected after agent write)',
						);
						return;
					}
				}
			}
			// Delegated to CheckpointManager
			const result = await this._checkpointMgr?.handleAction(this._chatPanel, this._currentAgentId, this._currentSessionId, action, payload);
			// 2026-09-12（P2-3）：有文件因体积过大/二进制未纳入检查点 → 明确告知用户，
			// 避免「以为已完全还原」（对齐 Claude Code 的 skipped N files 提示）。
			const skipNote = describeSkippedSnapshots(result?.skippedFiles ?? []);
			if (skipNote) {
				this._logService.warn(`[NativeChatEditorPane] ${skipNote}`);
				this._notificationService.warn(skipNote);
			}
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _handleCheckpointAction failed:', err);
		}
	}

	/**
	 * 只回退对话（2026-09-12，P1-1）：把聊天历史截断到「本轮起点之前」，**代码保持现状**。
	 * 与「回撤改动」（只回退代码）互补，对齐 Claude Code `/rewind` 的 Restore conversation。
	 *
	 * 「本轮起点」= 最早的非 ghost 检查点的 `createdAt`。之所以用**时间戳**而不是检查点的
	 * `messageId`：现有检查点（native 链工具侧创建的 tool_edit、webview 链的每轮锚点）创建时
	 * 都**没有**写入 messageId，依赖它会让本功能静默失效。`ChatMessage.timestamp` 是 ISO
	 * 字符串，需 `Date.parse` 后与 ms 时间戳比较。
	 *
	 * 保守边界（对齐 `_handleEditMessage` 的同类保护）：若历史中没有任何消息早于该时间戳
	 * （说明本轮即会话开始）→ **拒绝截断**并 warn，绝不误清空整个会话。
	 *
	 * 检查点数据**保留**（代码没变，用户随后仍可「回撤改动」）。
	 */
	private async _revertConversationOnly(): Promise<void> {
		const agentId = this._currentAgentId;
		const sessionId = this._currentSessionId;
		if (!agentId || !sessionId) {
			this._logService.warn('[NativeChatEditorPane] revertConversationOnly: no active agent/session');
			return;
		}
		// 1. 本轮起点时间 = 最早的非 ghost 检查点（纯函数，见 common/checkpointConversationAnchor）
		const list = await this._checkpointService.listCheckpoints(agentId, sessionId);
		const earliestAt = earliestCheckpointTime(list);
		if (earliestAt === undefined) {
			this._logService.warn('[NativeChatEditorPane] revertConversationOnly: no live checkpoint to anchor on');
			return;
		}

		// 2. 找到最后一条「早于起点」的消息，保留到它（含）
		const history = await this._chatService.getHistory(agentId, sessionId);
		const keepIdx = findConversationKeepIndex(history, earliestAt);
		if (keepIdx < 0) {
			this._logService.warn(
				`[NativeChatEditorPane] revertConversationOnly: refusing to truncate — no message predates the ` +
				`earliest checkpoint (earliestAt=${earliestAt}, history=${history.length})`,
			);
			return;
		}
		const removed = history.length - (keepIdx + 1);
		if (removed === 0) {
			this._logService.info('[NativeChatEditorPane] revertConversationOnly: nothing to remove');
			return;
		}
		await this._chatService.deleteMessagesAfter(agentId, sessionId, history[keepIdx].id);

		// 3. 刷新面板（磁盘文件不动）
		const refreshed = await this._chatService.getHistory(agentId, sessionId);
		this._chatPanel?.setMessages(this._adaptHistoryMessages(refreshed));
		this._logService.info(
			`[NativeChatEditorPane] revertConversationOnly: kept ${keepIdx + 1}, removed ${removed} message(s) ` +
			`(code untouched)`,
		);
	}

	/**
	 * 检查点时间线（2026-09-12，P2-1）：列出本会话全部可回退检查点，选中即回退到该点
	 * —— **文件与对话同时**回到该检查点创建之前。对齐 Claude Code `/rewind` 的菜单体验。
	 *
	 * 与「回撤改动」（只能回到本轮起点）的区别：这里可以选择**历史任意一点**。
	 *
	 * 实现要点：
	 *   · 用 {@link findConversationKeepIndex}（P1-1 的纯函数）按**时间戳**定位对话截断点
	 *     （检查点未写 messageId，不能依赖它）；
	 *   · 回退后刷新消息列表 + 检查点条；
	 *   · 未纳入检查点的文件（P2-3 省略内容）经 `skippedFiles` 显式提示。
	 */
	private async _openCheckpointTimeline(): Promise<void> {
		const agentId = this._currentAgentId;
		const sessionId = this._currentSessionId;
		if (!agentId || !sessionId) {
			this._logService.warn('[NativeChatEditorPane] checkpointTimeline: no active agent/session');
			return;
		}
		const list = (await this._checkpointService.listCheckpoints(agentId, sessionId)).filter(cp => !cp.isGhost);
		if (list.length === 0) {
			this._notificationService.info('当前会话没有可回退的检查点。');
			return;
		}

		// 最新在前（用户通常想回到最近的某个点）。
		const ordered = list.slice().sort((a, b) => b.createdAt - a.createdAt);
		type TimelineItem = IQuickPickItem & { checkpointId: string };
		const items: TimelineItem[] = ordered.map(cp => ({
			label: cp.label || (cp.type === 'tool_edit' ? '工具修改' : '用户检查点'),
			description: `${new Date(cp.createdAt).toLocaleString()}${cp.files?.length ? ` · ${cp.files.length} 个文件` : ''}`,
			detail: cp.description,
			checkpointId: cp.id,
		}));

		const picked = await this._quickInputService.pick(items, {
			title: '回退到检查点',
			placeHolder: '选择要回退到的检查点（文件与对话将同时回到该点之前）',
			matchOnDescription: true,
		});
		if (!picked) { return; }

		const cp = ordered.find(c => c.id === picked.checkpointId);
		if (!cp) { return; }

		try {
			// 1. 文件回退（该检查点之后的检查点会被标记为 ghost）
			const result = await this._checkpointService.jumpToCheckpoint(agentId, sessionId, cp.id);

			// 2. 对话截断到该检查点之前（复用 P1-1 的锚点纯函数，按时间戳定位）
			const history = await this._chatService.getHistory(agentId, sessionId);
			const keepIdx = findConversationKeepIndex(history, cp.createdAt);
			if (keepIdx >= 0) {
				await this._chatService.deleteMessagesAfter(agentId, sessionId, history[keepIdx].id);
			}

			// 3. 刷新面板与检查点条
			const refreshed = await this._chatService.getHistory(agentId, sessionId);
			this._chatPanel?.setMessages(this._adaptHistoryMessages(refreshed));
			await this._refreshCheckpointBar();

			this._logService.info(
				`[NativeChatEditorPane] checkpointTimeline: reverted to ${cp.id} ` +
				`(restored ${result.restoredFiles.length}, skipped ${result.skippedFiles?.length ?? 0})`,
			);

			// 4. 未纳入检查点的文件（P2-3）显式提示，避免「以为已完全还原」
			const skipNote = describeSkippedSnapshots(result.skippedFiles ?? []);
			if (skipNote) { this._notificationService.warn(skipNote); }
		} catch (err) {
			this._logService.error('[NativeChatEditorPane] checkpointTimeline failed:', err);
			this._notificationService.error(`回退失败：${(err as Error).message}`);
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

			// Provider list — unique by id, preserving order.
			// 只收录至少有一个对话可用模型的 provider，避免纯媒体生成 provider
			// （如 lightai）以空分组的形式出现在下拉里。见 chatModelFilter.ts。
			const seenProviders = new Set<string>();
			const providers: IPanelProviderInfo[] = [];
			for (const it of items) {
				if (!isChatCapableModel(it.model)) {
					continue;
				}
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
				if (!isChatCapableModel(it.model)) {
					continue;
				}
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

			// 图片模型分组（2026-09-10）：从同一份 items 中筛出支持文生图的模型
			// （`supportsImageGen`），按 provider 归类供「图片模型」下拉使用 ——
			// 复用既有数据，不新增任何后端调用。
			const imageGroupMap = new Map<string, { providerId: string; providerLabel: string; models: Array<{ id: string; label: string }> }>();
			for (const it of items) {
				if (!it.model.supportsImageGen) { continue; }
				const pid = it.provider.id;
				let g = imageGroupMap.get(pid);
				if (!g) {
					g = { providerId: pid, providerLabel: it.provider.name, models: [] };
					imageGroupMap.set(pid, g);
				}
				if (!g.models.some(m => m.id === it.model.id)) {
					g.models.push({ id: it.model.id, label: it.model.name });
				}
			}
			this._chatPanel.setImageModels([...imageGroupMap.values()] as IPanelImageModelGroup[]);

			// 恢复图片模型偏好。优先级（2026-09-10）：
			//   ① agent 配置（.agent.md 的 imageModel/imageProviderId）——自定义 agent 的权威值
			//   ② 用户级全局配置——**内置 agent（只读，写不进 .agent.md）时用户选择的落点**，
			//      也是 image_generate 工具实际读取的那一份（缺了这级，工具会掉进自动
			//      路由选中不支持 Images API 的 provider → 404，日志 1789050110889）
			//   ③ 本 pane 的 localStorage 缓存——同一窗口内的即时记忆
			//   ④ 未配置（空字符串）——chip 显示占位「图片模型」，下游按默认路由
			// 陈旧值（provider/模型已被移除）由面板 _getImageModelLabel 的回退逻辑兜底
			// 显示，不阻断渲染。
			let resolvedImagePref: string | undefined;
			try {
				resolvedImagePref = await this._imagePreferenceFromAgent();
			} catch { /* 读取失败按无 agent 默认处理 */ }
			// 'auto' 为 2026-09-10 之前的默认值（UI 已移除该选项）→ 按未配置处理。
			if (resolvedImagePref === 'auto') { resolvedImagePref = undefined; }
			if (!resolvedImagePref) {
				try {
					const gProvider = this._configurationService.getValue<string>(AGENT_STUDIO_IMAGE_GEN_PROVIDER);
					const gModel = this._configurationService.getValue<string>(AGENT_STUDIO_IMAGE_GEN_MODEL);
					if (gProvider && gModel) { resolvedImagePref = `provider:${gProvider}:${gModel}`; }
				} catch { /* 读取失败继续下一级 */ }
			}
			if (!resolvedImagePref) {
				try {
					const savedImagePref = localStorage.getItem(this._imageModelPrefKey());
					if (savedImagePref && savedImagePref !== 'auto') { resolvedImagePref = savedImagePref; }
				} catch { /* localStorage 不可用忽略 */ }
			}
			this._localImageModelPreference = resolvedImagePref ?? '';
			this._chatPanel.setCurrentImageModel(this._localImageModelPreference);

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

	/**
	 * 提示词优化（输入框 ✨ 按钮，2026-09-10）。
	 *
	 * 取本面板当前选定的 provider/model 发起**一次性** chat 调用：
	 *   · 不写入会话历史、不触发 agent loop、不占用聊天面板的流式通道；
	 *   · 按 `promptOptimize.ts` 的模板（移植自 prompt-optimizer 的
	 *     user-prompt-professional）改写输入框文本后原样返回。
	 *
	 * 失败时 notify 用户并返回 undefined —— 调用方据此保持输入框内容不变。
	 */
	private async _optimizePrompt(text: string): Promise<string | undefined> {
		const trimmed = (text ?? '').trim();
		if (!trimmed) { return undefined; }

		// provider/model 解析：面板本地选择优先，回退共享选择（与发送路径一致）。
		const selection = this._modelSelector.getSelection();
		const providerId = this._localProviderId || selection?.providerId;
		const modelId = this._localModelId || selection?.modelId;
		if (!providerId || !modelId) {
			this._notificationService.notify({ severity: Severity.Warning, message: '请先选择对话模型，再使用提示词优化。' });
			return undefined;
		}

		const provider = this._agentOSService.getModelProviders().find(p => p.id === providerId);
		if (!provider) {
			this._notificationService.notify({ severity: Severity.Warning, message: `未找到 Provider「${providerId}」，无法优化提示词。` });
			return undefined;
		}

		const t0 = performance.now();
		try {
			const messages = buildPromptOptimizeMessages(trimmed);
			let out = '';
			for await (const delta of provider.chat(modelId, messages, { temperature: 0.7, maxTokens: 2048 })) {
				if (delta.type === 'text' && delta.content) {
					out += delta.content;
				} else if (delta.type === 'error') {
					throw new Error(delta.error || '模型返回错误');
				}
			}
			const optimized = sanitizeOptimizedOutput(out);
			if (!optimized) {
				this._notificationService.notify({ severity: Severity.Warning, message: '提示词优化未返回内容，请重试。' });
				return undefined;
			}
			this._logService.info(
				`[NativeChatEditorPane#${this._paneId}] _optimizePrompt: ok in ${(performance.now() - t0).toFixed(0)}ms ` +
				`(provider=${providerId}, model=${modelId}, in=${trimmed.length}c, out=${optimized.length}c)`,
			);
			return optimized;
		} catch (err) {
			this._logService.error('[NativeChatEditorPane] _optimizePrompt failed:', err);
			this._notificationService.notify({
				severity: Severity.Error,
				message: `提示词优化失败：${err instanceof Error ? err.message : String(err)}`,
			});
			return undefined;
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
			//
			// ⚠️ 2026-08-29：旧实现用 `?? ''` 兜底——当 runtime state 里的
			// modelSelection 对象存在但字段为空时，会把面板上已有的有效选择
			// **覆盖成空字符串**，导致 provider/model 显示为空（须重新选择）。
			// 现改为「仅当字段非空时才覆盖」，缺失字段保持原值不动。
			if (saved.modelSelection) {
				if (saved.modelSelection.providerId) {
					this._localProviderId = saved.modelSelection.providerId;
					this._chatPanel?.setCurrentProvider(this._localProviderId);
				}
				if (saved.modelSelection.modelId) {
					this._localModelId = saved.modelSelection.modelId;
					this._chatPanel?.setCurrentModel(this._localModelId);
				}
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
			// ★ 2026-09-16：此路径此前**零日志**，导致「流式途中句柄被清空」只能靠
			// `_processDelta` 的 MISSING/SELF-HEALED 反推（日志 vscode-app-1789528831953）。
			// 记下被交接的消息 id 与发送态，便于下次一眼归因（是 popout 真交接，还是
			// 仅页签被挡住的误清空 —— 后者会让同一条答复另起气泡）。
			this._logService.info(
				`[NativeChatEditorPane#${this._paneId}] _handoffActiveStream: releasing streaming msg ` +
				`${this._streamingAssistantId ?? 'null'} (session=${this._currentSessionId}, ` +
				`isSending=${this._isSending}, isExternalSend=${this._isExternalSend})`
			);
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
	// 释放会话锁（多开）：窗口关闭后另一实例可接管编辑。
	// ★ 2026-09-15：改为**引用计数**式释放 —— 只有本实例已无其它 pane 显示
	// 同一 session 时才真正删锁。否则「关闭聊天框独立窗口」会把主窗口那个
	// 仍在显示同一 session 的聊天框的锁一起删掉（该 pane 静默失锁 ⇒ 另一个
	// `--instance` 可接管 ⇒ 主窗口下次检查时被判只读）。这正是「关闭独立窗口
	// 不要影响主窗口聊天框」要求下必须修掉的一环。
	this._trackSessionLock(undefined);

	// ★ 2026-09-15：清算跨 pane 静态引用。关闭独立窗口会销毁其中的 pane，
	// 若不清算，`lastFocusedPane` 会继续指向已销毁的 pane ⇒ 主窗口聊天框的
	// 「Add to Chat」等外部动作被路由到死 pane 上（静默失效）。交回给仍存活的
	// 另一个 pane（取最后入列者 ≈ 最近创建，通常是主窗口的那个）。
	const liveIndex = NativeChatEditorPane._livePanes.indexOf(this);
	if (liveIndex >= 0) {
		NativeChatEditorPane._livePanes.splice(liveIndex, 1);
	}
	if (NativeChatEditorPane.lastFocusedPane === this) {
		NativeChatEditorPane.lastFocusedPane = NativeChatEditorPane._livePanes.length > 0
			? NativeChatEditorPane._livePanes[NativeChatEditorPane._livePanes.length - 1]
			: null;
		this._logService.info(`[NativeChatEditorPane#${this._paneId}] dispose → lastFocusedPane handed over to ${NativeChatEditorPane.lastFocusedPane ? `pane#${NativeChatEditorPane.lastFocusedPane._paneId}` : 'null'}`);
	}
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
		// ★ 2026-09-15：不再直接 releaseSessionLock()。本 pane 只是暂时没有
		// session，而同实例很可能还有别的 pane 在显示某个 session（复制式
		// popout / 多开聊天框）—— 直接释放会把**它们的锁**一起删掉。
		// 交给引用计数决定是否真释放（旧 key 迁移后无人持有才释放）。
		this._trackSessionLock(undefined);
		return;
	}

	const lockKey = `${agentId}::${sessionId}`;

	// ★ 同实例已有别的 pane 显示同一 session ⇒ 锁已经在本实例手上，无需重复抢。
	// （`tryAcquireSessionLock` 会**先删旧锁文件再写新锁**，重复抢会制造一个
	//  「锁文件短暂缺失」的窗口，让另一个实例有机可乘。）
	if (this._hasSiblingLockHolder(lockKey)) {
		this._trackSessionLock(lockKey);
		this._sessionReadOnly = false;
		return;
	}

	const res = await this._chatService.tryAcquireSessionLock(agentId, sessionId);
	if (!res.acquired) {
		// 另一实例持有 ⇒ 本 pane 不是持有者，**不登记**（dispose 时也就不会误释放别人的锁）。
		this._trackSessionLock(undefined);
		this._sessionReadOnly = true;
		this._notificationService.notify({
			severity: Severity.Warning,
			message: `会话正在另一个实例${res.holderInstanceId ? `（实例 ${res.holderInstanceId}）` : ''}中编辑，当前窗口为只读。`,
		});
		this._logService.warn(`[NativeChatEditorPane] session ${sessionId} locked by instance ${res.holderInstanceId ?? '?'} → read-only`);
	} else {
		this._trackSessionLock(lockKey);
		if (this._sessionReadOnly) {
			this._sessionReadOnly = false;
		}
		// ★★★ P0-3（2026-09-15）：**加锁过程本身失败**（文件系统异常）⇒ 我们其实**没有**互斥保护。
		// 继续允许编辑（不把用户锁死在只读里），但必须显式告知：另一窗口若也开着同一会话，
		// 可能出现对话历史互相覆盖。会话写入已走原子写 ⇒ 最坏是「丢更新」，不会损坏文件。
		if (res.degraded) {
			this._notificationService.notify({
				severity: Severity.Warning,
				message: `本会话未能加锁（文件系统异常），无法保证与其它窗口互斥：若另一个窗口也在编辑同一会话，对话历史可能互相覆盖。`,
			});
			this._logService.warn(`[NativeChatEditorPane] session ${sessionId} lock DEGRADED (no mutual exclusion) — see [AgentChatService] log for the cause`);
		}
	}
}

/**
 * 把本 pane 的会话锁持有登记从旧 key 迁移到新 key（引用计数）。
 *
 * - 旧 key 迁移后若已无任何 pane 持有 ⇒ 才真正 `releaseSessionLock()`；
 * - `key === undefined` ⇒ 仅解除本 pane 的登记（「暂时无 session」与 dispose 都走这里）。
 *
 * 调用方：`_updateSessionLock()`（每次会话激活）与 `dispose()`。
 */
private _trackSessionLock(key: string | undefined): void {
	const previous = this._sessionLockKey;
	if (previous === key) {
		return;
	}
	this._sessionLockKey = key;

	if (previous) {
		const holders = NativeChatEditorPane._sessionLockHolders.get(previous);
		holders?.delete(this);
		const noHolderLeft = !!holders && holders.size === 0;
		if (noHolderLeft) {
			NativeChatEditorPane._sessionLockHolders.delete(previous);
			// ⚠ 只有「本 pane 不再持有任何 session」（key === undefined）时才真正释放。
			// 切到**另一个** session 时，调用方 `_updateSessionLock()` 已经通过
			// `tryAcquireSessionLock` 把服务端的锁换成新 session 了（该服务只持有
			// 一把锁）——此时再 release 会把**刚拿到的新锁**删掉。
			if (key === undefined) {
				// 本实例已无 pane 显示该 session ⇒ 交还锁，另一实例可接管编辑
				void this._chatService.releaseSessionLock().catch(() => { /* ignore */ });
			}
		}
	}

	if (key) {
		let holders = NativeChatEditorPane._sessionLockHolders.get(key);
		if (!holders) {
			holders = new Set<NativeChatEditorPane>();
			NativeChatEditorPane._sessionLockHolders.set(key, holders);
		}
		holders.add(this);
	}
}

/** 本实例是否已有**其它** pane 在显示该 session（有 ⇒ 无需重复抢锁）。 */
private _hasSiblingLockHolder(key: string): boolean {
	const holders = NativeChatEditorPane._sessionLockHolders.get(key);
	if (!holders) {
		return false;
	}
	for (const pane of holders) {
		if (pane !== this) {
			return true;
		}
	}
	return false;
}
}
