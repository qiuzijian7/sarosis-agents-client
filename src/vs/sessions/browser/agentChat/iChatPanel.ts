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
	ChatMode,
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
	onSendMessage: (text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[]) => void;
	onCancelExecution: () => void;
	onToggleCollapse: () => void;
	onSelectAgent: (id: string) => void;
	onSelectWorktree?: (worktree: { path: string; branch: string }) => void;
	onClearWorktree?: () => void;
	onLoadWorktrees?: () => Promise<ReadonlyArray<IWorktreeItem>>;
	onScrollToMessage?: (messageId: string) => void;
	onNewSession?: () => void;
	onOpenSession?: (sessionId: string) => void;
	onRenameSession?: (sessionId: string, newName: string) => void;
	onDeleteSession?: (sessionId: string) => void;
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
	onAskUserSubmit?: (askUserId: string, executionId: string, nodeId: string, selection: string | string[]) => void;
	onClarifySubmit?: (toolCallId: string, selection: string) => void;
	onQuestionClick?: (question: { label: string }) => void;
	onReferenceClick?: (ref: { kind: string; uri?: string; name: string; range?: { startLine: number } }) => void;
	onTipAction?: (tipId: string, actionId: string) => void;
	onTipDismiss?: (tipId: string) => void;
	onApplyCode?: (code: string, language: string, filePath?: string) => void;
	onSubmitVariables?: (executionId: string, values: Record<string, string>) => void;
	onOpenFile?: (filePath: string, content?: string) => void;
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
	setSending(sending: boolean): void;
	setStreamPhase(phase: StreamPhase): void;
	setStreamTextBuffer(buffer: string): void;
	setStreamThinkingBuffer(buffer: string): void;
	setStreamUsage(usage: { input?: number; output?: number; seen?: boolean } | null): void;
	setCompactedBaseline(baseline: number): void;
	setContextUsage(usage: IContextUsage | null): void;

	// ── Session / worktree / mode ──
	setChatMode(mode: ChatMode): void;
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

	// ── Attachments ──
	getAttachments(): ReadonlyArray<IChatAttachment>;
	clearAttachments(): void;
	addFileContext(filePath: string, content: string): void;
	addTextContext(name: string, content: string): void;

	// ── CLI mode query (for state save/restore) ──
	/** Whether this panel is currently rendering in CLI style. */
	getCliMode(): boolean;
}
