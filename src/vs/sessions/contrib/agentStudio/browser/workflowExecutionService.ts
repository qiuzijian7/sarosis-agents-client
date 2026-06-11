/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentChatService } from '../common/agentStudio.js';
import { IWorkflowStorageService, IStoredWorkflow, WorkflowNodeType, WorkflowGraphNode } from '../common/workflowStorage.js';
import { IWorkflowExecutionService, WorkflowExecutionStatus, WorkflowNodeExecutionStatus } from '../common/workflowExecutionService.js';
import type { IWorkflowExecutionState, IWorkflowExecutionOptions, IWorkflowNodeExecutionState, IWorkflowTraceEvent, IAskUserOption } from '../common/workflowExecutionService.js';

export class WorkflowExecutionService extends Disposable implements IWorkflowExecutionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidExecutionStatusChange = this._register(new Emitter<IWorkflowExecutionState>());
	readonly onDidExecutionStatusChange: Event<IWorkflowExecutionState> = this._onDidExecutionStatusChange.event;

	private readonly _onDidNodeExecutionStatusChange = this._register(new Emitter<{ executionId: string; nodeState: IWorkflowNodeExecutionState }>());
	readonly onDidNodeExecutionStatusChange: Event<{ executionId: string; nodeState: IWorkflowNodeExecutionState }> = this._onDidNodeExecutionStatusChange.event;

	private readonly _onDidChangeBreakpoints = this._register(new Emitter<{ executionId: string; nodeIds: string[] }>());
	readonly onDidChangeBreakpoints: Event<{ executionId: string; nodeIds: string[] }> = this._onDidChangeBreakpoints.event;

	private readonly _onDidExecutionTrace = this._register(new Emitter<IWorkflowTraceEvent>());
	readonly onDidExecutionTrace: Event<IWorkflowTraceEvent> = this._onDidExecutionTrace.event;

	private _executions = new Map<string, IWorkflowExecutionState>();
	private _pauseResolvers = new Map<string, (value: string | string[]) => void>();
	/** sessionId cache: key=`${agentId}:${executionId}`, value=agentSessionId */
	private _sessionCache = new Map<string, string>();
	/** Per-execution session info (owner agent + new session id + workflow name) */
	private _executionSession = new Map<string, { workflowAgentId: string; sessionId: string; workflowName: string }>();
	/**
	 * Per-execution pending AskUser entries (v4). Keyed by `${executionId}:${nodeId}` so we
	 * can re-fire the trace event if a webview subscribes late. The entry also lets us
	 * detect "ghost" pauses (resolver leaked) on cancel.
	 */
	private _pendingAskUser = new Map<string, {
		executionId: string; sessionId: string; nodeId: string; nodeName: string;
		question: string; options: IAskUserOption[]; multiSelect: boolean;
	}>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IAgentChatService private readonly agentChatService: IAgentChatService,
		@IWorkflowStorageService private readonly workflowStorage: IWorkflowStorageService,
	) {
		super();
	}

	// --------------------------------------------------------------------------------------------
	// Public API
	// --------------------------------------------------------------------------------------------

	async executeWorkflow(workflowId: string, options?: IWorkflowExecutionOptions): Promise<string> {
		this.logService.info(`[WorkflowExecution] executeWorkflow: workflowId=${workflowId}`);

		// Load workflow
		const workflow = await this.workflowStorage.getWorkflow(workflowId);
		if (!workflow) {
			throw new Error(`Workflow not found: ${workflowId}`);
		}

		// Create execution state. v5a: copy workflow-level breakpoints into the
		// execution state so the per-node pause check picks them up.
		const executionId = `wf_exec_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
		const executionState: IWorkflowExecutionState = {
			executionId,
			workflowId,
			status: WorkflowExecutionStatus.Running,
			nodeStates: new Map<string, IWorkflowNodeExecutionState>(),
			startTime: new Date().toISOString(),
			context: options?.context ?? {},
			breakpoints: new Set<string>(workflow.breakpoints ?? []),
		};

		this._executions.set(executionId, executionState);
		this._onDidExecutionStatusChange.fire(executionState);

		// P4: Create a fresh session on the workflow's owner agent (workflow.agentId)
		// and post a user "trigger" message. The session is where the owner chat will
		// render subagent cards for each node executed in this run.
		const workflowAgentId = workflow.agentId || options?.agentId;
		if (workflowAgentId) {
			try {
				const meta = await this.agentChatService.createAgentSession(
					workflowAgentId,
					`▶ ${workflow.name || workflowId}`,
				);
				this._executionSession.set(executionId, {
					workflowAgentId,
					sessionId: meta.id,
					workflowName: workflow.name || workflowId,
				});
				this._sessionCache.set(`${workflowAgentId}:${executionId}`, meta.id);

				// Post trigger user message so the owner chat has a visible anchor.
				await this.agentChatService.appendMessage(workflowAgentId, {
					id: `wf_trigger_${executionId}`,
					role: 'user',
					content: `▶ Run workflow: **${workflow.name || workflowId}**\n\n${workflow.description ?? ''}`,
					timestamp: new Date().toISOString(),
					agentSessionId: meta.id,
				} as any);

				// Forward session info to webview so it can switch the active chat.
				this._onDidExecutionTrace.fire({
					kind: 'subagent_start',
					executionId,
					workflowAgentId,
					sessionId: meta.id,
					nodeId: '__workflow__',
					nodeName: workflow.name || workflowId,
					nodeType: 'workflow',
					task: workflow.description || `Run workflow: ${workflow.name || workflowId}`,
				} as any);

				this.logService.info(
					`[WorkflowExecution] Created owner-agent session ${meta.id} for ${workflowAgentId} (execution=${executionId})`,
				);
			} catch (err) {
				this.logService.warn(
					`[WorkflowExecution] Failed to create owner-agent session (continuing without chat trace): ${err instanceof Error ? err.message : err}`,
				);
			}
		} else {
			this.logService.warn(
				`[WorkflowExecution] Workflow has no agentId; chat trace will be skipped.`,
			);
		}

		// Start execution (fire-and-forget)
		this._executeWorkflowAsync(executionState, workflow, options).catch(err => {
			this.logService.error(`[WorkflowExecution] Execution ${executionId} failed:`, err);
			executionState.status = WorkflowExecutionStatus.Failed;
			executionState.error = err instanceof Error ? err.message : String(err);
			executionState.endTime = new Date().toISOString();
			this._onDidExecutionStatusChange.fire(executionState);
			// P4: also fire execution_end so the owner chat can mark the run as failed.
			const ownerSession = this._executionSession.get(executionId);
			if (ownerSession) {
				this._onDidExecutionTrace.fire({
					kind: 'execution_end',
					executionId,
					sessionId: ownerSession.sessionId,
					status: 'failed',
				});
			}
		});

		return executionId;
	}

	async pauseExecution(executionId: string, nodeId: string, question: string, options: IAskUserOption[]): Promise<string | string[]> {
		this.logService.info(`[WorkflowExecution] pauseExecution: executionId=${executionId}, nodeId=${nodeId}`);
		
		const state = this._executions.get(executionId);
		if (!state) {
			throw new Error(`Execution not found: ${executionId}`);
		}

		// 设置状态为暂停
		state.status = WorkflowExecutionStatus.Paused;
		state.currentNodeId = nodeId;
		this._onDidExecutionStatusChange.fire(state);

		// 创建延迟 Promise，等待用户恢复
		return new Promise<string | string[]>((resolve) => {
			this._pauseResolvers.set(executionId, resolve);
		});
	}

	async resumeExecution(executionId: string, userInput: string | string[]): Promise<void> {
		this.logService.info(`[WorkflowExecution] resumeExecution: executionId=${executionId}`);
		
		const resolver = this._pauseResolvers.get(executionId);
		if (!resolver) {
			throw new Error(`No pending pause for execution: ${executionId}`);
		}

		// 恢复执行（调用 resolver）
		resolver(userInput);
		this._pauseResolvers.delete(executionId);

		// 更新状态为运行中
		const state = this._executions.get(executionId);
		if (state) {
			state.status = WorkflowExecutionStatus.Running;
			this._onDidExecutionStatusChange.fire(state);
		}
	}

	async cancelExecution(executionId: string): Promise<void> {
		this.logService.info(`[WorkflowExecution] cancelExecution: executionId=${executionId}`);
		const state = this._executions.get(executionId);
		if (!state) {
			throw new Error(`Execution not found: ${executionId}`);
		}
		state.status = WorkflowExecutionStatus.Cancelled;
		state.endTime = new Date().toISOString();
		this._onDidExecutionStatusChange.fire(state);

		// v4: resolve any pending AskUser pauses so the host's pauseExecution
		// promise doesn't leak. Also fire ask_user_end so the webview card
		// flips to "cancelled" state.
		this._cancelPendingAskUserForExecution(executionId, 'cancelled');
	}

	/**
	 * v4 helper: fire ask_user_end('cancelled') for every still-pending AskUser on
	 * this execution and clean up the resolver. Called from cancelExecution().
	 */
	private _cancelPendingAskUserForExecution(
		executionId: string,
		status: 'cancelled',
	): void {
		for (const [key, entry] of this._pendingAskUser.entries()) {
			if (entry.executionId !== executionId) { continue; }
			this._pendingAskUser.delete(key);
			this._onDidExecutionTrace.fire({
				kind: 'ask_user_end',
				executionId,
				sessionId: entry.sessionId,
				nodeId: entry.nodeId,
				status,
			});
		}
		// If the resolver for this execution is still parked (AskUser pause was
		// never answered), resolve it with empty string so pauseExecution() unblocks.
		const resolver = this._pauseResolvers.get(executionId);
		if (resolver) {
			resolver('');
			this._pauseResolvers.delete(executionId);
		}
	}

	getExecutionState(executionId: string): IWorkflowExecutionState | undefined {
		return this._executions.get(executionId);
	}

	getExecutionSession(executionId: string): { workflowAgentId: string; sessionId: string; workflowName: string } | undefined {
		return this._executionSession.get(executionId);
	}

	getActiveExecutions(): IWorkflowExecutionState[] {
		return Array.from(this._executions.values()).filter(s =>
			s.status === WorkflowExecutionStatus.Running ||
			s.status === WorkflowExecutionStatus.Paused
		);
	}

	setBreakpoint(executionId: string, nodeId: string): void {
		this.logService.info(`[WorkflowExecution] setBreakpoint: executionId=${executionId}, nodeId=${nodeId}`);
		const state = this._executions.get(executionId);
		if (!state) {
			throw new Error(`Execution not found: ${executionId}`);
		}
		if (!state.breakpoints) {
			state.breakpoints = new Set<string>();
		}
		state.breakpoints.add(nodeId);
		this._onDidChangeBreakpoints.fire({ executionId, nodeIds: Array.from(state.breakpoints) });
	}

	clearBreakpoint(executionId: string, nodeId: string): void {
		this.logService.info(`[WorkflowExecution] clearBreakpoint: executionId=${executionId}, nodeId=${nodeId}`);
		const state = this._executions.get(executionId);
		if (!state) {
			throw new Error(`Execution not found: ${executionId}`);
		}
		if (state.breakpoints) {
			state.breakpoints.delete(nodeId);
			this._onDidChangeBreakpoints.fire({ executionId, nodeIds: Array.from(state.breakpoints) });
		}
	}

	getBreakpoints(executionId: string): string[] {
		const state = this._executions.get(executionId);
		if (!state || !state.breakpoints) {
			return [];
		}
		return Array.from(state.breakpoints);
	}

	// ─── v5a: Workflow-level breakpoints (persist across runs) ───────────

	/**
	 * Set a breakpoint at the workflow level. Persists to the workflow JSON
	 * via the storage service. If `executionId` is provided, also applies to
	 * the running execution for immediate effect.
	 */
	async setWorkflowBreakpoint(workflowId: string, nodeId: string, executionId?: string): Promise<void> {
		this.logService.info(`[WorkflowExecution] setWorkflowBreakpoint: workflowId=${workflowId}, nodeId=${nodeId}, executionId=${executionId ?? 'none'}`);
		const workflow = await this.workflowStorage.getWorkflow(workflowId);
		if (!workflow) {
			throw new Error(`Workflow not found: ${workflowId}`);
		}
		const current = new Set(workflow.breakpoints ?? []);
		if (current.has(nodeId)) { return; } // already set, no-op
		current.add(nodeId);
		await this.workflowStorage.updateWorkflow(workflowId, { breakpoints: Array.from(current) });
		// Apply to running execution if any.
		if (executionId) {
			try { this.setBreakpoint(executionId, nodeId); } catch { /* execution may have ended */ }
		}
	}

	async clearWorkflowBreakpoint(workflowId: string, nodeId: string, executionId?: string): Promise<void> {
		this.logService.info(`[WorkflowExecution] clearWorkflowBreakpoint: workflowId=${workflowId}, nodeId=${nodeId}, executionId=${executionId ?? 'none'}`);
		const workflow = await this.workflowStorage.getWorkflow(workflowId);
		if (!workflow) {
			throw new Error(`Workflow not found: ${workflowId}`);
		}
		const current = new Set(workflow.breakpoints ?? []);
		if (!current.has(nodeId)) { return; }
		current.delete(nodeId);
		await this.workflowStorage.updateWorkflow(workflowId, { breakpoints: Array.from(current) });
		if (executionId) {
			try { this.clearBreakpoint(executionId, nodeId); } catch { /* execution may have ended */ }
		}
	}

	async getWorkflowBreakpoints(workflowId: string): Promise<string[]> {
		const workflow = await this.workflowStorage.getWorkflow(workflowId);
		if (!workflow) { return []; }
		return workflow.breakpoints ?? [];
	}

	// --------------------------------------------------------------------------------------------
	// Execution Engine
	// --------------------------------------------------------------------------------------------

	private async _executeWorkflowAsync(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		options?: IWorkflowExecutionOptions,
	): Promise<void> {
		this.logService.info(`[WorkflowExecution] Starting execution ${executionState.executionId}`);

		const nodes = workflow.nodes ?? [];
		const connections = workflow.connections ?? [];

		// Build adjacency list
		const adj = new Map<string, { targetId: string; fromPort?: string }[]>();
		for (const conn of connections) {
			const list = adj.get(conn.from) ?? [];
			list.push({ targetId: conn.to, fromPort: conn.fromPort });
			adj.set(conn.from, list);
		}

		// Find start node
		const startNode = nodes.find(n => n.type === WorkflowNodeType.Start);
		if (!startNode) {
			throw new Error('Workflow has no Start node');
		}

		// Execute from start node
		await this._executeNodeRecursive(executionState, workflow, startNode, adj, options);

		// Mark execution as completed
		if (executionState.status === WorkflowExecutionStatus.Running) {
			executionState.status = WorkflowExecutionStatus.Completed;
			executionState.endTime = new Date().toISOString();
			this._onDidExecutionStatusChange.fire(executionState);
			this.logService.info(`[WorkflowExecution] Execution ${executionState.executionId} completed`);
		}

		// P4: fire execution_end so the owner chat can commit the final assistant message.
		const ownerSession = this._executionSession.get(executionState.executionId);
		if (ownerSession) {
			const finalStatus: 'completed' | 'failed' | 'cancelled' =
				executionState.status === WorkflowExecutionStatus.Cancelled
					? 'cancelled'
					: executionState.status === WorkflowExecutionStatus.Failed
						? 'failed'
						: 'completed';
			this._onDidExecutionTrace.fire({
				kind: 'execution_end',
				executionId: executionState.executionId,
				sessionId: ownerSession.sessionId,
				status: finalStatus,
			});
		}
	}

	private async _executeNodeRecursive(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		adj: Map<string, { targetId: string; fromPort?: string }[]>,
		options?: IWorkflowExecutionOptions,
	): Promise<void> {
		// Check if execution was cancelled
		if (executionState.status === WorkflowExecutionStatus.Cancelled) {
			return;
		}

		// Mark node as running
		executionState.currentNodeId = node.id;
		const nodeState: IWorkflowNodeExecutionState = {
			nodeId: node.id,
			status: WorkflowNodeExecutionStatus.Running,
			startTime: new Date().toISOString(),
		};
		executionState.nodeStates.set(node.id, nodeState);
		this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState });

		try {
			// 检查断点（P2 调试功能）
			if (executionState.breakpoints?.has(node.id)) {
				this.logService.info(`[WorkflowExecution] Breakpoint hit at node ${node.id}`);
				// 暂停执行，等待用户恢复
				await this.pauseExecution(
					executionState.executionId,
					node.id,
					`断点暂停: ${node.name || node.id}`,
					[],
				);
				// 恢复后继续执行
			}

			// Execute node based on type
			let nextNodeIds: string[] = [];

			switch (node.type) {
				case WorkflowNodeType.Start:
					// Start node: just pass through to next nodes
					nextNodeIds = this._getNextNodes(node.id, adj);
					break;

				case WorkflowNodeType.End:
					// End node: stop execution
					nodeState.status = WorkflowNodeExecutionStatus.Completed;
					nodeState.endTime = new Date().toISOString();
					executionState.nodeStates.set(node.id, nodeState);
					this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState });
					return;

				case WorkflowNodeType.Task:
					// Task node: execute task
					await this._executeTaskNode(executionState, workflow, node, options);
					nextNodeIds = this._getNextNodes(node.id, adj);
					break;

				case WorkflowNodeType.Prompt:
					// Prompt node: inject prompt
					await this._executePromptNode(executionState, workflow, node, options);
					nextNodeIds = this._getNextNodes(node.id, adj);
					break;

				case WorkflowNodeType.Agent:
					// Agent node: execute with specific agent
					await this._executeAgentNode(executionState, workflow, node, options);
					nextNodeIds = this._getNextNodes(node.id, adj);
					break;

				case WorkflowNodeType.Skill:
					// Skill node: execute skill
					await this._executeSkillNode(executionState, workflow, node, options);
					nextNodeIds = this._getNextNodes(node.id, adj);
					break;

				case WorkflowNodeType.Tool:
					// Tool node: execute tool
					await this._executeToolNode(executionState, workflow, node, options);
					nextNodeIds = this._getNextNodes(node.id, adj);
					break;

				case WorkflowNodeType.Condition:
				case WorkflowNodeType.IfElse:
				case WorkflowNodeType.Switch:
					// Control flow: evaluate condition and follow branch
					nextNodeIds = await this._executeConditionNode(executionState, workflow, node, adj, options);
					break;

				case WorkflowNodeType.Loop:
					// Loop node: iterate
					nextNodeIds = await this._executeLoopNode(executionState, workflow, node, adj, options);
					break;

				case WorkflowNodeType.Parallel:
					// Parallel node: execute branches concurrently
					nextNodeIds = await this._executeParallelNode(executionState, workflow, node, adj, options);
					break;

			case WorkflowNodeType.AskUser:
				// AskUser node: pause and wait for user input
				const userInput = await this._executeAskUserNode(executionState, workflow, node, adj);
				// 将用户输入存储到上下文
				executionState.context['userInput'] = userInput;
				nextNodeIds = this._getNextNodes(node.id, adj);
				break;

				default:
					this.logService.warn(`[WorkflowExecution] Unknown node type: ${node.type}, skipping`);
					nextNodeIds = this._getNextNodes(node.id, adj);
					break;
			}

			// Mark node as completed
			nodeState.status = WorkflowNodeExecutionStatus.Completed;
			nodeState.endTime = new Date().toISOString();
			executionState.nodeStates.set(node.id, nodeState);
			this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState });

			// Execute next nodes
			for (const nextNodeId of nextNodeIds) {
				const nextNode = workflow.nodes?.find(n => n.id === nextNodeId);
				if (nextNode) {
					await this._executeNodeRecursive(executionState, workflow, nextNode, adj, options);
				}
			}
		} catch (err) {
			// Mark node as failed
			nodeState.status = WorkflowNodeExecutionStatus.Failed;
			nodeState.error = err instanceof Error ? err.message : String(err);
			nodeState.endTime = new Date().toISOString();
			executionState.nodeStates.set(node.id, nodeState);
			this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState });

			// Mark execution as failed
			executionState.status = WorkflowExecutionStatus.Failed;
			executionState.error = nodeState.error;
			executionState.endTime = new Date().toISOString();
			this._onDidExecutionStatusChange.fire(executionState);

			throw err;
		}
	}

	// --------------------------------------------------------------------------------------------
	// Node Executors
	// --------------------------------------------------------------------------------------------

	private async _executeTaskNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		_options?: IWorkflowExecutionOptions,
	): Promise<void> {
		this.logService.info(`[WorkflowExecution] Executing Task node: ${node.id}`);
		const data = node.data ?? {};
		// v9: prefer data.prompt (configured via PropertyPanel), then data.label, then node.name.
		// Never use hardcoded fallbacks that could cause the agent to call unrelated skills.
		const taskDescription = (data.prompt as string) || (data.label as string) || node.name || '';

		// 获取 agent ID（优先使用 options 中的，否则使用 workflow 的 agentId）
		const agentId = _options?.agentId || workflow.agentId;
		if (!agentId) {
			throw new Error(`Task node ${node.id}: No agent ID available (workflow.agentId is empty and no options.agentId)`);
		}

		try {
			// 发送任务描述给 Agent
			this.logService.info(`[WorkflowExecution] Sending task to agent ${agentId}: ${taskDescription}`);
			const message = await this.agentChatService.sendMessage(
				agentId,
				taskDescription,
				{ workspaceId: undefined, agentSessionId: undefined },
				(delta) => {
					// 可选：转发流式响应
					this.logService.debug(`[WorkflowExecution] Task ${node.id} delta: ${delta.content?.substring(0, 50)}`);
				},
			);

			// 记录执行结果
			const nodeState = executionState.nodeStates.get(node.id);
			if (nodeState) {
				nodeState.output = message.content || '';
			}

			this.logService.info(`[WorkflowExecution] Task ${node.id} completed: ${message.content?.substring(0, 100)}`);
		} catch (err) {
			this.logService.error(`[WorkflowExecution] Task ${node.id} failed:`, err);
			throw err;
		}
	}

	private async _executePromptNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		_options?: IWorkflowExecutionOptions,
	): Promise<void> {
		this.logService.info(`[WorkflowExecution] Executing Prompt node: ${node.id}`);
		const data = node.data ?? {};
		const promptText = (data.prompt as string) || '';

		if (!promptText) {
			this.logService.warn(`[WorkflowExecution] Prompt node ${node.id} has empty prompt`);
			return;
		}

		// 获取 agent ID
		const agentId = _options?.agentId || workflow.agentId;
		if (!agentId) {
			throw new Error(`Prompt node ${node.id}: No agent ID available`);
		}

		try {
			// Get or create a session for this workflow execution to avoid cross-session leakage.
			const sessionName = WorkflowExecutionService._buildSessionName(executionState, workflow);
			const agentSessionId = await this._getOrCreateAgentSession(
				agentId,
				executionState.executionId,
				sessionName,
			);

			// 将提示作为用户消息追加到聊天历史
			this.logService.info(`[WorkflowExecution] Appending prompt to agent ${agentId} (session=${agentSessionId}): ${promptText.substring(0, 100)}`);
			await this.agentChatService.appendMessage(agentId, {
				id: `prompt_${node.id}_${Date.now()}`,
				role: 'user',
				content: promptText,
				timestamp: new Date().toISOString(),
				agentSessionId,
			} as any);

			this.logService.info(`[WorkflowExecution] Prompt ${node.id} appended successfully`);
		} catch (err) {
			this.logService.error(`[WorkflowExecution] Prompt ${node.id} failed:`, err);
			throw err;
		}
	}

	private async _executeAgentNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		options?: IWorkflowExecutionOptions,
	): Promise<void> {
		this.logService.info(`[WorkflowExecution] Executing Agent node: ${node.id}`);
		const data = node.data ?? {};
		const agentId = (data.agentId as string) || options?.agentId;
		const ownerSession = this._executionSession.get(executionState.executionId);

		if (!agentId) {
			throw new Error(`Agent node ${node.id} has no agentId`);
		}

		// v10: build prompt from node config, with task context as fallback.
		// Only the FIRST agent node receives the taskDescription — once consumed,
		// we clear it so subsequent nodes must use their own data.prompt.
		let nodePrompt = (data.prompt as string) || '';
		if (!nodePrompt) {
			const ctx = executionState.context;
			const consumed = (ctx?._taskConsumed as boolean) || false;
			const taskDesc = consumed ? undefined : (ctx?.taskDescription as string | undefined);
			if (taskDesc) {
				nodePrompt = taskDesc;
				// Mark the task context as consumed so subsequent agent nodes
				// don't accidentally pick it up.
				ctx!['_taskConsumed'] = true;
				this.logService.info(
					`[WorkflowExecution] Agent node ${node.id} (FIRST) using task context: "${taskDesc.substring(0, 80)}"`,
				);
			}
		}

		if (!nodePrompt) {
			// No prompt configured at all — log a warning and skip execution.
			this.logService.warn(
				`[WorkflowExecution] Agent node ${node.id} ("${node.name || ''}") has no prompt configured — skipping execution. ` +
				'Add a prompt via the PropertyPanel (select the node → "Prompt Template" field).',
			);
			if (ownerSession) {
				// Fire subagent_start then immediately subagent_end(error) so the
				// card renders and shows the error.
				const nodeName = (data.label as string) || node.name || node.id;
				this._onDidExecutionTrace.fire({
					kind: 'subagent_start',
					executionId: executionState.executionId,
					workflowAgentId: ownerSession.workflowAgentId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					nodeName,
					nodeType: 'agent',
					task: 'No prompt configured — add a prompt in the PropertyPanel.',
				});
				this._onDidExecutionTrace.fire({
					kind: 'subagent_end',
					executionId: executionState.executionId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					status: 'error',
					error: `Agent node "${nodeName}" has no prompt configured. Open the PropertyPanel, select this node, and fill in the "Prompt Template" field.`,
				});
			}
			return;
		}

		// P4: fire subagent_start so the workflow owner chat opens a subagent card
		if (ownerSession) {
			this._onDidExecutionTrace.fire({
				kind: 'subagent_start',
				executionId: executionState.executionId,
				workflowAgentId: ownerSession.workflowAgentId,
				sessionId: ownerSession.sessionId,
				nodeId: node.id,
				nodeName: (data.label as string) || node.name || node.id,
				nodeType: 'agent',
				task: nodePrompt.substring(0, 200),
			});
		}

		try {
			// 使用指定 agent 执行（发送一个继续的提示）
			const continuePrompt = nodePrompt;

			// Get or create a session for this workflow execution to avoid cross-session leakage.
			const sessionName = WorkflowExecutionService._buildSessionName(executionState, workflow);
			const agentSessionId = await this._getOrCreateAgentSession(
				agentId,
				executionState.executionId,
				sessionName,
			);

			this.logService.info(`[WorkflowExecution] Sending to agent ${agentId} (session=${agentSessionId}): ${continuePrompt}`);

			const message = await this.agentChatService.sendMessage(
				agentId,
				continuePrompt,
				{ workspaceId: undefined, agentSessionId },
				(delta) => {
					this.logService.debug(`[WorkflowExecution] Agent ${node.id} delta: ${delta.content?.substring(0, 50)}`);

					// P4: forward delta to owner chat as subagent progress.
					// Strip non-serializable fields if any (delta.content is fine; metadata may be omitted).
					if (ownerSession) {
						this._onDidExecutionTrace.fire({
							kind: 'delta',
							executionId: executionState.executionId,
							sessionId: ownerSession.sessionId,
							nodeId: node.id,
							delta: this._sanitizeDelta(delta),
						});
					}
				},
			);

			// 记录执行结果
			const nodeState = executionState.nodeStates.get(node.id);
			if (nodeState) {
				nodeState.output = message.content || '';
			}

			// P4: fire subagent_end so the owner chat can flip the card to "done".
			if (ownerSession) {
				this._onDidExecutionTrace.fire({
					kind: 'subagent_end',
					executionId: executionState.executionId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					status: 'done',
					output: message.content?.substring(0, 4000) || '',
				});
			}

			this.logService.info(`[WorkflowExecution] Agent ${node.id} completed`);
		} catch (err) {
			// P4: surface errors to owner chat too.
			if (ownerSession) {
				this._onDidExecutionTrace.fire({
					kind: 'subagent_end',
					executionId: executionState.executionId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					status: 'error',
					error: err instanceof Error ? err.message : String(err),
				});
			}
			this.logService.error(`[WorkflowExecution] Agent ${node.id} failed:`, err);
			throw err;
		}
	}

	/**
	 * Strip a streaming delta of any non-serializable fields before sending
	 * it through the structured-clone boundary (host→webview). The delta has
	 * a few well-known fields: type, content, toolCallId, toolName, etc.
	 */
	private _sanitizeDelta(delta: any): Record<string, unknown> {
		if (!delta || typeof delta !== 'object') { return {}; }
		const out: Record<string, unknown> = {};
		const copyKeys = [
			'type', 'content', 'toolCallId', 'toolName', 'displayName', 'renderType',
			'defaultShow', 'arguments', 'metadata', 'progressData', 'confirmationData',
			'todosData', 'tipsData', 'questionsData', 'references', 'usage',
		];
		for (const k of copyKeys) {
			if (k in delta) { out[k] = delta[k]; }
		}
		return out;
	}

	/**
	 * v11: build a human-readable session name for the workflow execution.
	 * If the execution was triggered from a task, use "执行任务: {taskTitle}".
	 * Otherwise fall back to "workflow-{name}".
	 */
	private static _buildSessionName(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
	): string {
		const taskTitle = executionState.context?.taskTitle as string | undefined;
		if (taskTitle) {
			// Truncate long task titles to keep the session name readable.
			const short = taskTitle.length > 50 ? taskTitle.substring(0, 50) + '…' : taskTitle;
			return `执行任务: ${short}`;
		}
		return `workflow-${workflow.name || workflow.id}`;
	}

	/**
	 * Get or create an agent session for a workflow execution.
	 * Cached by (agentId, executionId) so all nodes in the same execution
	 * for the same agent share one session.
	 */
	private async _getOrCreateAgentSession(
		agentId: string,
		executionId: string,
		sessionName: string,
	): Promise<string> {
		const key = `${agentId}:${executionId}`;
		const cached = this._sessionCache.get(key);
		if (cached) {
			return cached;
		}

		const meta = await this.agentChatService.createAgentSession(agentId, sessionName);
		this._sessionCache.set(key, meta.id);
		this.logService.info(`[WorkflowExecution] Created agent session ${meta.id} for ${agentId} (execution=${executionId})`);
		return meta.id;
	}

	private async _executeAskUserNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		_adj: Map<string, { targetId: string; fromPort?: string }[]>,
	): Promise<string | string[]> {
		this.logService.info(`[WorkflowExecution] Executing AskUser node: ${node.id}`);
		const data = node.data ?? {};
		const question = (data.question as string) || '请提供更多输入';
		const options = (data.options as IAskUserOption[]) || [];
		const multiSelect = (data.multiSelect as boolean) ?? false;
		const ownerSession = this._executionSession.get(executionState.executionId);

		try {
			// v4: fire ask_user trace event BEFORE pausing so the webview can render
			// an interactive card in the workflow owner agent's chat. The card will
			// send `workflow.resume` (RPC) when the user picks an option.
			if (ownerSession) {
				const nodeName = (data.label as string) || node.name || node.id;
				this._pendingAskUser.set(`${executionState.executionId}:${node.id}`, {
					executionId: executionState.executionId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					nodeName,
					question,
					options,
					multiSelect,
				});
				this._onDidExecutionTrace.fire({
					kind: 'ask_user',
					executionId: executionState.executionId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					nodeName,
					question,
					options,
					multiSelect,
				});
			}

			// 暂停执行并等待用户输入
			this.logService.info(`[WorkflowExecution] Pausing for user input: ${question}`);
			const userInput = await this.pauseExecution(
				executionState.executionId,
				node.id,
				question,
				options,
			);

			// v4: fire ask_user_end so the webview card flips to "answered" state.
			if (ownerSession) {
				this._pendingAskUser.delete(`${executionState.executionId}:${node.id}`);
				this._onDidExecutionTrace.fire({
					kind: 'ask_user_end',
					executionId: executionState.executionId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					status: 'answered',
					selection: userInput,
				});
			}

			this.logService.info(`[WorkflowExecution] User input received: ${JSON.stringify(userInput)}`);
			return userInput;
		} catch (err) {
			// v4: mark the pending ask_user as expired so the card shows "failed" state.
			if (ownerSession) {
				this._pendingAskUser.delete(`${executionState.executionId}:${node.id}`);
				this._onDidExecutionTrace.fire({
					kind: 'ask_user_end',
					executionId: executionState.executionId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					status: 'expired',
				});
			}
			this.logService.error(`[WorkflowExecution] AskUser ${node.id} failed:`, err);
			throw err;
		}
	}

	private async _executeSkillNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		_options?: IWorkflowExecutionOptions,
	): Promise<void> {
		this.logService.info(`[WorkflowExecution] Executing Skill node: ${node.id}`);
		const data = node.data ?? {};
		const skillName = (data.skillName as string) || '';

		if (!skillName) {
			throw new Error(`Skill node ${node.id} has no skillName`);
		}

		// TODO: Execute skill
		this.logService.info(`[WorkflowExecution] Skill: ${skillName}`);
	}

	private async _executeToolNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		_options?: IWorkflowExecutionOptions,
	): Promise<void> {
		this.logService.info(`[WorkflowExecution] Executing Tool node: ${node.id}`);
		const data = node.data ?? {};
		const toolName = (data.toolName as string) || '';

		if (!toolName) {
			throw new Error(`Tool node ${node.id} has no toolName`);
		}

		// TODO: Execute tool
		this.logService.info(`[WorkflowExecution] Tool: ${toolName}`);
	}

	private async _executeConditionNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		adj: Map<string, { targetId: string; fromPort?: string }[]>,
		_options?: IWorkflowExecutionOptions,
	): Promise<string[]> {
		this.logService.info(`[WorkflowExecution] Executing Condition node: ${node.id}`);
		const data = node.data ?? {};
		const condition = (data.condition as string) || '';

		// TODO: Evaluate condition and select branch
		// For now, just follow the first branch
		const nextNodes = this._getNextNodes(node.id, adj);
		this.logService.info(`[WorkflowExecution] Condition: ${condition}, following ${nextNodes.length} branches`);
		return nextNodes;
	}

	private async _executeLoopNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		adj: Map<string, { targetId: string; fromPort?: string }[]>,
		_options?: IWorkflowExecutionOptions,
	): Promise<string[]> {
		this.logService.info(`[WorkflowExecution] Executing Loop node: ${node.id}`);
		const data = node.data ?? {};
		const loopConfig = (data.loopConfig as { items: string; itemVariable: string; maxIterations?: number }) ?? {};

		// TODO: Implement loop iteration
		// For now, just follow the first branch once
		const nextNodes = this._getNextNodes(node.id, adj);
		this.logService.info(`[WorkflowExecution] Loop: over ${loopConfig.items}, following ${nextNodes.length} branches`);
		return nextNodes;
	}

	private async _executeParallelNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		adj: Map<string, { targetId: string; fromPort?: string }[]>,
		_options?: IWorkflowExecutionOptions,
	): Promise<string[]> {
		this.logService.info(`[WorkflowExecution] Executing Parallel node: ${node.id}`);

		// TODO: Execute branches concurrently
		// For now, return all next nodes (will be executed sequentially)
		const nextNodes = this._getNextNodes(node.id, adj);
		this.logService.info(`[WorkflowExecution] Parallel: ${nextNodes.length} branches`);
		return nextNodes;
	}

	// --------------------------------------------------------------------------------------------
	// Helper Methods
	// --------------------------------------------------------------------------------------------

	private _getNextNodes(nodeId: string, adj: Map<string, { targetId: string; fromPort?: string }[]>): string[] {
		const connections = adj.get(nodeId) ?? [];
		return connections.map(c => c.targetId);
	}
}
