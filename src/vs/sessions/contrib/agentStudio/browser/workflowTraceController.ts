/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkflowExecutionService } from '../common/workflowExecutionService.js';
import { IAgentChatService } from '../../../common/agentStudioService.js';
import type { IChatPanel } from '../../../browser/agentChat/iChatPanel.js';
import type { ILiveWorkflowAskUser, ILiveWorkflowExecution, ILiveWorkflowEvent, ILiveCollectVariable } from '../../../browser/agentChat/agentChatTypes.js';
import type { IAgentChatMessage } from '../../../browser/agentChat/agentChatTypes.js';

/**
 * Interface for the pane to interact with the controller.
 * The pane implements this to provide callbacks the controller needs.
 */
export interface IWorkflowPaneCallbacks {
	readonly chatPanel: IChatPanel | undefined;
	readonly currentAgentId: string | null;
	readonly currentSessionId: string | null;
	onWorkflowAgentChanged(agentId: string, sessionId: string): void;
	onWorkflowEnded(): void;
	adaptHistoryMessages(messages: any[]): IAgentChatMessage[];
	activateCheckpointSession(agentId: string, sessionId: string): void;
	refreshSessionList(): Promise<void>;
}

/**
 * WorkflowTraceController — manages live workflow execution state and
 * renders workflow trace cards (subagents, events, collect variables,
 * ask-user prompts) in the chat panel.
 *
 * Extracted from NativeChatEditorPane to reduce its size and isolate
 * the complex workflow trace state machine (subagent_start/end, delta,
 * collect_variables, ask_user, execution_end).
 *
 * Lifecycle: created in NativeChatEditorPane._initChatPanel(), disposed
 * when the pane is disposed (via _register).
 */
export class WorkflowTraceController extends Disposable {

	private _execId: string | null = null;
	private _msgId: string | null = null;
	private _subAgents: any[] = [];
	private _events: ILiveWorkflowEvent[] = [];
	private _collectVars: Record<string, ILiveCollectVariable> = {};
	private _askUsers: ILiveWorkflowAskUser[] = [];
	private _ready = false;
	private _deltaRefreshTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly _workflowExecutionService: IWorkflowExecutionService,
		private readonly _chatService: IAgentChatService,
		private readonly _logService: ILogService,
	) {
		super();
	}

	/**
	 * Start listening for workflow execution traces.
	 * Must be called after the controller is created and the pane is ready.
	 */
	start(callbacks: IWorkflowPaneCallbacks): void {
		this._register(this._workflowExecutionService.onDidExecutionTrace(async (trace) => {
			await this._handleTrace(trace as any, callbacks);
		}));
	}

	private async _handleTrace(trace: any, cb: IWorkflowPaneCallbacks): Promise<void> {
		const isWorkflowRoot = trace.kind === 'subagent_start' && trace.nodeId === '__workflow__';
		const isCurrentExecution = this._execId && trace.executionId === this._execId;
		if (!isWorkflowRoot && !isCurrentExecution && cb.currentSessionId && trace.sessionId && trace.sessionId !== cb.currentSessionId) {
			return;
		}

		switch (trace.kind) {
			case 'subagent_start':
				await this._handleSubagentStart(trace, cb);
				break;
			case 'collect_variables':
				this._handleCollectVariables(trace);
				break;
			case 'collect_variables_end':
				this._handleCollectVariablesEnd(trace);
				break;
			case 'delta':
				this._handleDelta(trace, cb);
				break;
			case 'subagent_end':
				this._handleSubagentEnd(trace);
				break;
			case 'ask_user':
				this._handleAskUser(trace);
				break;
			case 'ask_user_end':
				this._handleAskUserEnd(trace);
				break;
			case 'execution_end':
				this._handleExecutionEnd(trace, cb);
				break;
		}
	}

	private async _handleSubagentStart(trace: any, cb: IWorkflowPaneCallbacks): Promise<void> {
		if (trace.nodeId === '__workflow__') {
			const { workflowAgentId, sessionId, nodeName } = trace;
			this._logService.debug(`[WorkflowTrace] Workflow started: agent=${workflowAgentId}, session=${sessionId}, name=${nodeName}`);
			cb.onWorkflowAgentChanged(workflowAgentId, sessionId);
			this._execId = trace.executionId;
			this._msgId = `wf_live_${trace.executionId}`;
			this._subAgents = [];
			this._events = [];
			this._collectVars = {};
			this._askUsers = [];
			this._ready = false;

			const panel = cb.chatPanel;
			if (panel) {
				panel.setSending(true);
				panel.setStreamPhase('llm_streaming');
				panel.setStreamTextBuffer('');
				panel.setStreamThinkingBuffer('');
			}

			try {
				const history = await this._chatService.getHistory(workflowAgentId, sessionId);
				cb.chatPanel?.setMessages(cb.adaptHistoryMessages(history));
				cb.activateCheckpointSession(workflowAgentId, sessionId);
				await cb.refreshSessionList();
			} catch (err) {
				this._logService.info('[WorkflowTrace] Failed to load workflow session history:', err);
			}

			// Add live workflow assistant message
			cb.chatPanel?.addMessage({
				id: this._msgId!,
				role: 'assistant',
				content: `▶ **${nodeName}** — 执行中...`,
				timestamp: Date.now(),
				isStreaming: true,
				workflowExecutions: {
					[trace.executionId]: {
						executionId: trace.executionId,
						workflowName: nodeName,
						status: 'running' as const,
						subAgents: this._subAgents,
						startTime: Date.now(),
					},
				},
				workflowEvents: this._events,
				...(Object.keys(this._collectVars).length > 0 ? { collectVariables: this._collectVars } : {}),
			} as any);
			this._ready = true;

			if (this._subAgents.length > 0) {
				this._refreshMessage(cb);
			}
		} else {
			// Non-root subagent
			this._logService.debug(`[WorkflowTrace] subagent_start: node=${trace.nodeId}, name=${trace.nodeName}, type=${trace.nodeType}`);

			if (!this._msgId || !this._execId) {
				// Fallback: auto-initialize if root event was missed
				this._logService.info(`[WorkflowTrace] subagent_start without root — auto-initializing (execId=${trace.executionId})`);
				this._execId = trace.executionId;
				this._msgId = `wf_live_${trace.executionId}`;
				this._subAgents = [];
				this._events = [];
				this._collectVars = {};
				this._askUsers = [];
				this._ready = false;
				const panel = cb.chatPanel;
				if (panel) {
					panel.setSending(true);
					panel.setStreamPhase('llm_streaming');
					panel.setStreamTextBuffer('');
					panel.setStreamThinkingBuffer('');
				}
				if (trace.workflowAgentId) { cb.onWorkflowAgentChanged(trace.workflowAgentId, trace.sessionId); }
				panel?.addMessage({
					id: this._msgId!,
					role: 'assistant',
					content: `▶ **${trace.nodeName || trace.nodeId}** — 执行中...`,
					timestamp: Date.now(),
					isStreaming: true,
					workflowExecutions: {
						[trace.executionId]: {
							executionId: trace.executionId,
							workflowName: trace.nodeName || trace.nodeId,
							status: 'running' as const,
							subAgents: this._subAgents,
							startTime: Date.now(),
						},
					},
					workflowEvents: this._events,
				} as any);
				this._ready = true;
			}

			this._subAgents.push({
				id: trace.nodeId,
				name: trace.nodeName,
				type: trace.nodeType,
				task: trace.task,
				status: 'running' as const,
				startTime: Date.now(),
			});
			this._events.push({
				id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
				executionId: trace.executionId,
				sessionId: trace.sessionId,
				timestamp: Date.now(),
				kind: 'subagent_start' as const,
				nodeId: trace.nodeId,
				nodeName: trace.nodeName,
				nodeType: trace.nodeType,
			});
			this._refreshMessage(cb);
		}
	}

	private _handleCollectVariables(trace: any): void {
		this._events.push({
			id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			executionId: trace.executionId,
			sessionId: trace.sessionId,
			timestamp: Date.now(),
			kind: 'collect_variables' as const,
			nodeId: '',
		});
		this._collectVars[trace.executionId] = {
			id: trace.executionId,
			executionId: trace.executionId,
			variables: trace.variables,
			values: {},
			status: 'pending' as const,
			createdAt: Date.now(),
		};
	}

	private _handleCollectVariablesEnd(trace: any): void {
		this._events.push({
			id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			executionId: trace.executionId,
			sessionId: trace.sessionId,
			timestamp: Date.now(),
			kind: 'collect_variables_end' as const,
			nodeId: '',
			status: trace.status,
		});
		this._collectVars[trace.executionId] = {
			id: trace.executionId,
			executionId: trace.executionId,
			variables: [],
			values: {},
			status: (trace.status === 'submitted' ? 'submitted' : 'skipped') as 'submitted' | 'skipped',
			createdAt: Date.now(),
		};
	}

	private _handleDelta(trace: any, cb: IWorkflowPaneCallbacks): void {
		const d = trace.delta as any;
		const sa = this._subAgents.find(s => s.id === trace.nodeId);

		if (d) {
			const panel = cb.chatPanel;
			if (d.type === 'text') {
				panel?.setStreamPhase('llm_streaming');
			} else if (d.type === 'thinking') {
				panel?.setStreamPhase('llm_streaming');
			} else if (d.type === 'tool_start' || d.type === 'tool_args' || d.type === 'tool_end' || d.type === 'tool_result') {
				panel?.setStreamPhase('tool_executing');
			}
			if (d.type === 'usage' && d.usage) {
				panel?.setStreamUsage({
					input: d.usage.inputTokens ?? 0,
					output: d.usage.outputTokens ?? 0,
					seen: true,
				});
			}
		}

		if (sa && d) {
			if (d.type === 'text' && d.content) {
				sa.streamedText = (sa.streamedText ?? '') + d.content;
				cb.chatPanel?.setStreamTextBuffer(sa.streamedText);
			} else if (d.type === 'thinking' && d.content) {
				sa.streamedThinking = (sa.streamedThinking ?? '') + d.content;
				cb.chatPanel?.setStreamThinkingBuffer(sa.streamedThinking ?? '');
			} else if (d.type === 'tool_start') {
				sa.toolCalls = sa.toolCalls ?? [];
				sa.toolCalls.push({
					id: d.toolCallId ?? d.id ?? `tc_${Date.now()}`,
					name: d.toolName ?? d.name ?? '',
					status: 'running',
					args: d.arguments ?? d.args ?? '',
				});
			} else if (d.type === 'tool_args') {
				const tc = sa.toolCalls?.find((t: any) => t.id === (d.toolCallId ?? d.id));
				if (tc) { tc.args = (tc.args ?? '') + (d.content ?? d.arguments ?? d.args ?? ''); }
			} else if (d.type === 'tool_end') {
				const tc = sa.toolCalls?.find((t: any) => t.id === (d.toolCallId ?? d.id));
				if (tc) { tc.status = 'done'; tc.result = d.content ?? d.result ?? ''; }
			} else if (d.type === 'tool_result') {
				const tc = sa.toolCalls?.find((t: any) => t.id === (d.toolCallId ?? d.id));
				if (tc) {
					tc.result = d.content ?? d.result ?? '';
					if (tc.status === 'running') { tc.status = 'done'; }
				}
			}
		}
		this._scheduleDeltaRefresh(cb);
	}

	private _handleSubagentEnd(trace: any): void {
		const sa = this._subAgents.find(s => s.id === trace.nodeId);
		if (sa) {
			sa.status = trace.status === 'done' ? 'done' as const : trace.status === 'cancelled' ? 'cancelled' as const : 'error' as const;
			sa.output = trace.output;
			sa.error = trace.error;
			sa.endTime = Date.now();
		}
	}

	private _handleAskUser(trace: any): void {
		const askId = `${trace.executionId}:${trace.nodeId}`;
		if (!this._askUsers.some(a => a.id === askId)) {
			this._askUsers.push({
				id: askId,
				executionId: trace.executionId,
				nodeId: trace.nodeId,
				nodeName: trace.nodeName ?? trace.nodeId,
				question: trace.question ?? '',
				options: trace.options ?? [],
				multiSelect: trace.multiSelect ?? false,
				selectedIndices: [],
				status: 'pending',
				createdAt: Date.now(),
			});
		}
		this._events.push({
			id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			executionId: trace.executionId,
			sessionId: trace.sessionId,
			timestamp: Date.now(),
			kind: 'ask_user' as const,
			nodeId: trace.nodeId,
			nodeName: trace.nodeName,
			summary: `❓ ${trace.question?.substring(0, 60) ?? ''}`,
		});
	}

	private _handleAskUserEnd(trace: any): void {
		const askId = `${trace.executionId}:${trace.nodeId}`;
		const status = (trace.status as 'answered' | 'cancelled' | 'expired') ?? 'answered';
		if (status !== 'answered') {
			this._askUsers = this._askUsers.map(a =>
				a.id === askId && a.status === 'pending'
					? { ...a, status, answeredAt: Date.now() }
					: a
			);
		}
		this._events.push({
			id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			executionId: trace.executionId,
			sessionId: trace.sessionId,
			timestamp: Date.now(),
			kind: 'ask_user_end' as const,
			nodeId: trace.nodeId,
			status: trace.status,
			summary: `已${status === 'answered' ? '回答' : status === 'cancelled' ? '取消' : '过期'}`,
		});
	}

	private _handleExecutionEnd(trace: any, cb: IWorkflowPaneCallbacks): void {
		const snapExecId = this._execId;
		const snapMsgId = this._msgId;
		const snapEvents = this._events.slice();
		const snapSubAgents = this._subAgents.slice();
		const snapWorkflowName = (() => {
			const we = snapEvents.find(e => e.kind === 'subagent_start' && e.nodeId === '__workflow__');
			return we?.nodeName ?? '';
		})();
		const finalStatus = trace.status === 'completed' ? 'completed' as const
			: trace.status === 'failed' ? 'failed' as const
				: 'cancelled' as const;

		// Step 1: Update live card to final status
		this._refreshMessage(cb, {
			workflowExecutions: snapExecId ? {
				[snapExecId]: {
					executionId: snapExecId,
					workflowName: snapWorkflowName,
					status: finalStatus,
					subAgents: snapSubAgents,
					startTime: Date.now(),
					endTime: Date.now(),
				},
			} : undefined,
		});

		// Step 2: Reset chat input state
		const panel = cb.chatPanel;
		panel?.setSending(false);
		panel?.setStreamPhase('idle');
		panel?.setStreamTextBuffer('');
		panel?.setStreamThinkingBuffer('');
		panel?.setStreamUsage(null);

		// Step 3: Safety-net delayed refresh
		if (snapExecId && snapMsgId && panel) {
			requestAnimationFrame(() => {
				panel.updateMessage(snapMsgId, {
					isStreaming: false,
					workflowExecutions: {
						[snapExecId]: {
							executionId: snapExecId,
							workflowName: snapWorkflowName,
							status: finalStatus,
							subAgents: snapSubAgents,
							startTime: Date.now(),
							endTime: Date.now(),
						},
					},
					workflowEvents: snapEvents,
				} as any);
			});
		}

		// Step 4: Clear live state
		this._execId = null;
		this._msgId = null;
		this._subAgents = [];
		this._events = [];
		this._collectVars = {};
		this._askUsers = [];
		this._ready = false;

		cb.onWorkflowEnded();
	}

	/** Throttled refresh for delta events (100ms coalescing). */
	private _scheduleDeltaRefresh(cb: IWorkflowPaneCallbacks): void {
		if (this._deltaRefreshTimer) { return; }
		this._deltaRefreshTimer = setTimeout(() => {
			this._deltaRefreshTimer = null;
			this._refreshMessage(cb);
		}, 100);
	}

	/** Update the live workflow message in the chat panel. */
	private _refreshMessage(cb: IWorkflowPaneCallbacks, overrides?: Record<string, unknown>): void {
		if (this._deltaRefreshTimer) {
			clearTimeout(this._deltaRefreshTimer);
			this._deltaRefreshTimer = null;
		}
		if (!this._msgId || !this._execId || !this._ready) { return; }
		const updates: Record<string, unknown> = {
			workflowExecutions: {
				[this._execId]: {
					executionId: this._execId,
					workflowName: '',
					status: 'running' as const,
					subAgents: this._subAgents,
					startTime: Date.now(),
				} as ILiveWorkflowExecution,
			},
			workflowEvents: this._events,
			...(Object.keys(this._collectVars).length > 0 ? { collectVariables: this._collectVars } : {}),
			...(this._askUsers.length > 0 ? { askUsers: this._askUsers } : {}),
			...overrides,
		};
		cb.chatPanel?.updateMessage(this._msgId, updates);
	}

	/** Cancel the current workflow execution. */
	cancelExecution(): void {
		if (this._execId) {
			this._workflowExecutionService.cancelExecution(this._execId).catch(err => {
				this._logService.error('[WorkflowTrace] cancelExecution failed:', err);
			});
		}
	}

	/** Submit workflow variables. */
	submitVariables(executionId: string, values: Record<string, string>): void {
		this._workflowExecutionService.submitWorkflowVariables(executionId, values).catch(err => {
			this._logService.error('[WorkflowTrace] submitVariables failed:', err);
		});
	}

	/** Resume a paused workflow execution (AskUser response). */
	resumeExecution(executionId: string, selection: string | string[]): Promise<void> {
		return this._workflowExecutionService.resumeExecution(executionId, selection);
	}

	/** Get current ask-user prompts (for UI rendering). */
	getAskUsers(): ILiveWorkflowAskUser[] {
		return this._askUsers;
	}

	/** Mark an AskUser as answered (optimistic UI update). */
	markAskUserAnswered(askUserId: string, selection: string | string[]): void {
		this._askUsers = this._askUsers.map(a =>
			a.id === askUserId
				? { ...a, status: 'answered' as const, selection, answeredAt: Date.now() }
				: a
		);
	}

	/** Rollback an AskUser to pending (on resume failure). */
	rollbackAskUser(askUserId: string): void {
		this._askUsers = this._askUsers.map(a =>
			a.id === askUserId
				? { ...a, status: 'pending' as const, selection: undefined, answeredAt: undefined }
				: a
		);
	}

	override dispose(): void {
		if (this._deltaRefreshTimer) {
			clearTimeout(this._deltaRefreshTimer);
			this._deltaRefreshTimer = null;
		}
		super.dispose();
	}
}
