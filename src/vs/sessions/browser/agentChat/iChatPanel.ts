/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '../../../base/common/lifecycle.js';
import type {
	IAgentChatMessage,
	IAgentInfo,
	IProviderInfo,
	IModelInfo,
	StreamPhase,
	IWorktreeItem,
	IWorkspaceItem,
	ISessionInfo,
	IAgentSessionMeta,
	IContextUsage,
	ICheckpointInfo,
	IChatAttachment,
	OrchestrationPlan,
} from './agentChatTypes.js';

/**
 * Callbacks passed to a chat panel constructor.
 * Both {@link AgentChatPanel} and {@link CliChatEditorPanel} accept the same
 * callback shape so that {@link NativeChatEditorPane} can instantiate either
 * one without changing its wiring code.
 */
export interface IChatPanelCallbacks {
	onSendMessage: (text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[], workflowTrigger?: { workflowId: string; input?: string; variables?: Record<string, string>; images?: string[] }) => void;
	onCancelExecution: () => void;
	onToggleCollapse: () => void;
	onSelectAgent: (id: string) => void;
	onSelectWorktree?: (worktree: { path: string; branch: string }) => void;
	onClearWorktree?: () => void;
	onLoadWorktrees?: () => Promise<ReadonlyArray<IWorktreeItem>>;
	/** 右键 worktree 项 → 「调试」：以该 worktree 目录启动 F5 调试（打开 worktree 开发窗口） */
	onDebugWorktree?: (worktree: { path: string; branch: string }) => void;
	onScrollToMessage?: (messageId: string) => void;
	onNewSession?: () => void;
	onOpenSession?: (sessionId: string) => void;
	onRenameSession?: (sessionId: string, newName: string) => void;
	onDeleteSession?: (sessionId: string) => void;
	onOpenSettings?: () => void;
	// onChangeMode removed — replaced by onToggleChatOnly
	onToggleChatOnly?: (chatOnly: boolean) => void;
	/**
	 * 输入框 ChatMode 下拉框选择回调（2026-08-21）。
	 * 与 onToggleChatOnly 正交：chatMode 是意图档位（craft/ask/plan），
	 * chatOnly 是额外的只读约束。宿主需把它随每 turn 传给 agent（request.chatMode）。
	 */
	onChangeChatMode?: (chatMode: 'craft' | 'ask' | 'plan') => void;
	onSelectProvider?: (providerId: string) => void;
	onSelectModel?: (modelId: string) => void;
	onCheckpointAction?: (action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string; checkpointId?: string }) => void;
	onConfirmationAction?: (confirmationId: string, buttonId: string) => void;
	onEditMessage?: (messageId: string, newText: string) => void;
	onListSkills: () => ReadonlyArray<{ id: string; name: string; description: string; activation?: string; source?: string; version?: string; enabled: boolean; category?: string }>;
	/** 列出当前项目可用的工作流（供 composer `/` 菜单「工作流」分组）。 */
	onListWorkflows?: () => ReadonlyArray<{ id: string; name: string; description?: string; variables?: ReadonlyArray<{ name: string; defaultValue: string }> }>;
	onListMcpServers?: () => ReadonlyArray<{ name: string; status: string; toolCount: number }>;
	onOpenMcpSettings?: () => void;
	onOpenHtmlPreview?: () => void;
	onAskUserSubmit?: (askUserId: string, executionId: string, nodeId: string, selection: string | string[]) => void;
	onClarifySubmit?: (toolCallId: string, selection: string) => void;
	onQuestionClick?: (question: { label: string }) => void;
	onReferenceClick?: (ref: { kind: string; uri?: string; name: string; range?: { startLine: number } }) => void;
	onTipAction?: (tipId: string, actionId: string) => void;
	onTipDismiss?: (tipId: string) => void;
	onApplyCode?: (code: string, language: string, filePath?: string) => void;
	onSubmitVariables?: (executionId: string, values: Record<string, string>) => void;
	onOpenFile?: (filePath: string, contentOrLine?: string | number) => void;
	onSearchFiles?: (query: string) => Promise<Array<{ path: string; name: string }>>;
	onAddFileContext?: (filePath: string) => void;
	onRunInTerminal?: (code: string) => void;
	onAddSelectionToChat?: () => void;
	onOpenLink?: (url: string) => void;
	onToolApprove?: (toolCallId: string, decision: string) => void;
	onDecomposeTask?: (planId: string, taskId: string) => void;
	onApprovePlan?: (planId: string) => void;
	onRejectPlan?: (planId: string) => void;
	onApproveWithoutExecute?: (planId: string) => void;
	onTaskAction?: (planId: string, taskId: string, action: 'retry' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' | 'block' | 'unblock') => void;
	onUpdatePlan?: (planId: string, updates: Record<string, unknown>) => void;
	onUpdateTask?: (planId: string, taskId: string, updates: Record<string, unknown>) => void;
	onClosePlanDialog?: (planId: string) => void;
	/** 收藏消息到知识库 */
	onFavoriteMessage?: (messageContent: string) => void;
	/** 输入框文本变更（每次 input 事件触发；消费方自行 debounce）。用于 per-session 草稿持久化。 */
	onComposerTextChange?: (text: string) => void;

	// ── Channel 绑定（飞书）相关回调（对齐 AgentSettingsEditorPane）──
	/** 列出某平台所有 会话→Agent 绑定；Channel 绑定 tab 依赖它，缺失则不显示该 tab。 */
	onListFeishuBindings?: () => ReadonlyArray<{ conversationId: string; agentId: string }>;
	/** 绑定飞书会话到当前 Agent（chat_id 已 trim，空值由实现方校验）。 */
	onAddFeishuBinding?: (chatId: string) => void;
	/** 解除飞书会话绑定。 */
	onRemoveFeishuBinding?: (chatId: string) => void;
	/** 读取当前飞书渠道默认 Agent（未设置返回 undefined）。 */
	onGetFeishuDefaultAgent?: () => string | undefined;
	/** 设置/取消飞书渠道默认 Agent（传 undefined 表示取消）。 */
	onSetFeishuDefaultAgent?: (agentId: string | undefined) => void;
}

/**
 * Public API contract for chat panels.
 *
 * Implemented by both {@link AgentChatPanel} (rich bubble UI) and
 * {@link CliChatEditorPanel} (OpenCode TUI-style compact rendering).
 * {@link NativeChatEditorPane} holds a reference typed as `IChatPanel`
 * and calls these methods regardless of which concrete panel is active.
 */
export interface IChatPanel extends IDisposable {
	/** Root DOM element appended into the editor pane container. */
	readonly element: HTMLElement;

	// ── Agent / providers ──
	setAgent(agent: IAgentInfo | null): void;
	getAgent(): IAgentInfo | null;
	setAvailableAgents(agents: IAgentInfo[]): void;
	setProviders(providers: IProviderInfo[]): void;
	setModels(models: IModelInfo[]): void;
	setCurrentProvider(provider: string): void;
	setCurrentModel(model: string): void;

	// ── Messages ──
	setMessages(messages: IAgentChatMessage[]): void;
	addMessage(message: IAgentChatMessage): void;
	updateMessage(messageId: string, updates: Partial<IAgentChatMessage>): void;
	getMessages(): IAgentChatMessage[];

	// ── System messages (compression / memory notices) ──
	addCompressionNotice(info: {
		originalCount: number;
		compressedCount: number;
		tokensSaved: number;
		durationMs: number;
		beforeText?: string;
		afterText?: string;
		summary?: string;
	}): void;
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
	}): void;
	updateMemoryNotice(noticeId: string, status: 'saved' | 'failed', newContent?: string): void;
	removeMemoryNotice(noticeId: string): void;
	addCodebaseNotice(info: { operation: string; summary?: string }): void;
	clearSystemMessages(): void;
	setOpenCompressionDetailCallback(cb: (data: Record<string, unknown>) => void): void;
	setOpenMemoryDetailCallback(cb: (agentId: string, memoryType?: string, contentPreview?: string) => void): void;
	setOpenCodebaseDetailCallback(cb: () => void): void;

	// ── Stream state ──
	/**
	 * 切换流式状态。
	 * @param sending true = 开始流式，false = 结束流式
	 * @param options.triggerExecuteNext false 表示只更新 UI 状态，不触发队列 executeNext。
	 *   默认 true 保持向后兼容。**在 Pane 层的 onDidStreamDelta('done') 监听器和 onCancelExecution
	 *   中必须传 false**，因为那里调用 setSending(false) 不是流真正结束（_sendMessageInternal
	 *   line 644 会再次调用并触发 executeNext），提前 dispatch 会导致多个队列任务被同时推送
	 *   给 LLM（test3 还没真正完成就推 test4）。
	 */
	setSending(sending: boolean, options?: { triggerExecuteNext?: boolean }): void;
	setStreamPhase(phase: StreamPhase): void;
	setStreamTextBuffer(buffer: string): void;
	setStreamThinkingBuffer(buffer: string): void;
	setStreamUsage(usage: { input?: number; output?: number; seen?: boolean } | null): void;
	setCompactedBaseline(baseline: number): void;
	setContextUsage(usage: IContextUsage | null): void;

	// ── Session / worktree / mode ──
	setChatOnly(chatOnly: boolean): void;
	/** 恢复输入框选定的 ChatMode（窗口重载 / 切换 agent 时用）。 */
	setChatMode?(chatMode: 'craft' | 'ask' | 'plan'): void;
	setSessionInfo(info: ISessionInfo | null): void;
	setAgentSessions(sessions: ReadonlyArray<IAgentSessionMeta>): void;
	setWorktrees(items: ReadonlyArray<IWorktreeItem>): void;
	setSelectedWorktree(path: string): void;
	/** 设置工作区列表（供输入区工具栏 workspace 下拉框使用） */
	setWorkspaces(items: ReadonlyArray<IWorkspaceItem>): void;
	/** 设置当前选中的工作区 */
	setSelectedWorkspace(id: string): void;
	setCheckpoint(info: ICheckpointInfo | null): void;
	setCheckpoints(list: ICheckpointInfo[]): void;

	// ── Orchestration ──
	showOrchestrationPlanDialog(plan: OrchestrationPlan): void;
	closeOrchestrationPlanDialog(): void;

	// ── UI operations ──
	focusInput(): void;
	layout(width: number, height: number): void;
	/** Read composer text for persistence. */
	getComposerText(): string;
	/** Set composer text (for restoring persisted input). */
	setComposerText(text: string): void;

	// ── Attachments ──
	getAttachments(): ReadonlyArray<IChatAttachment>;
	clearAttachments(): void;
	addFileContext(filePath: string, content: string): void;
	addTextContext(name: string, content: string): void;

	// ── CLI mode query (for state save/restore) ──
	/** Whether this panel is currently rendering in CLI style. */
	getCliMode(): boolean;
}
