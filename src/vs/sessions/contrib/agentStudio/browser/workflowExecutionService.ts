/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentChatService } from '../common/agentStudio.js';
import { IWorkflowStorageService, IStoredWorkflow, WorkflowNodeType, WorkflowGraphNode } from '../common/workflowStorage.js';
import type { IComfyExecutionDelegate, ComfyExecutionInput } from '../common/comfyBridge.js';
import { ISkillRegistry, ISkillDefinition } from '../common/skills.js';
import { IWorkflowExecutionService, WorkflowExecutionStatus, WorkflowNodeExecutionStatus } from '../common/workflowExecutionService.js';
import type { IWorkflowExecutionState, IWorkflowExecutionOptions, IWorkflowNodeExecutionState, IWorkflowTraceEvent, IAskUserOption } from '../common/workflowExecutionService.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceRegistry } from '../common/agentWorkspace.js';
import { substituteHostVariables, buildRuntimeValueMap, collectWorkflowVariables } from './utils/templateUtils.js';

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

	/** v6: resolvers for pre-execution variable collection (keyed by executionId). */
	private _variableResolvers = new Map<string, (values: Record<string, string>) => void>();

	/**
	 * v21: per-execution active stream tracker so `cancelExecution` can abort
	 * the in-flight LLM call instead of waiting for it to finish. Keyed by
	 * `executionId`. Each entry stores the (agentId, agentSessionId) pair that
	 * identifies the active stream inside `agentChatService._activeStreams`
	 * (the stream key is `${agentId}::${agentSessionId}`).
	 *
	 * Why this exists: previously `cancelExecution` only flipped the execution
	 * status to `Cancelled` and resolved pending AskUser / variable resolvers.
	 * The actual `agentChatService.sendMessage()` await inside a node executor
	 * kept running until the model finished its response — so clicking Cancel
	 * during a long agent turn had no visible effect for the entire LLM
	 * generation latency, and the next node's recursive call would only bail
	 * out at the *next* status check. With this tracker, cancel synchronously
	 * aborts the active stream so the node executor returns almost immediately.
	 */
	private _activeStreams = new Map<string, { agentId: string; agentSessionId: string; nodeId: string }>();

	/** P3: 当前执行链中正在运行的 workflowId 集合，用于递归环检测。 */
	private readonly _activeWorkflowChain = new Set<string>();

	/** Comfy 执行委托（懒注入，避免构造期 DI 环）。未设置时 Comfy 节点跳过。 */
	private _comfyDelegate: IComfyExecutionDelegate | undefined;

	setComfyExecutionDelegate(delegate: IComfyExecutionDelegate | undefined): void {
		this._comfyDelegate = delegate;
	}

	constructor(
		@ILogService private readonly logService: ILogService,
		@IAgentChatService private readonly agentChatService: IAgentChatService,
		@IWorkflowStorageService private readonly workflowStorage: IWorkflowStorageService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceRegistry private readonly workspaceRegistry: IWorkspaceRegistry,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
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

		// P3: 环检测 —— 防止 workflow 经 skill 节点递归调用自身形成无限循环。
		// 若同一 workflowId 已在当前执行链中，直接抛错，由嵌套调用方（_executeWorkflowAndAwait）捕获。
		if (this._activeWorkflowChain.has(workflowId)) {
			this.logService.warn(`[WorkflowExecution] Cyclic workflow invocation detected: ${workflowId} already in execution chain; aborting to prevent infinite recursion`);
			throw new Error(`Cyclic workflow invocation: ${workflowId}`);
		}
		this._activeWorkflowChain.add(workflowId);
		// 终态时从链中移除（无论完成/失败/取消），避免跨执行泄漏。
		const chainSub = this.onDidExecutionStatusChange(state => {
			if (state.executionId === executionId && (state.status === WorkflowExecutionStatus.Completed || state.status === WorkflowExecutionStatus.Failed || state.status === WorkflowExecutionStatus.Cancelled)) {
				chainSub.dispose();
				this._activeWorkflowChain.delete(workflowId);
			}
		});

		const executionState: IWorkflowExecutionState = {
			executionId,
			workflowId,
			status: WorkflowExecutionStatus.Running,
			nodeStates: new Map<string, IWorkflowNodeExecutionState>(),
			startTime: new Date().toISOString(),
			context: options?.context ?? {},
			breakpoints: new Set<string>(workflow.breakpoints ?? []),
			options,  // v31: store options for per-node access (maxHistoryMessages, etc.)
			sharedMemory: new Map<string, string>(),  // v32: inter-agent shared memory
		};

		this._executions.set(executionId, executionState);
		this._onDidExecutionStatusChange.fire(executionState);

		// P4: Create a fresh session on the workflow's owner agent (workflow.agentId)
		// BEFORE returning so that `_handleWorkflowExecute` can include sessionInfo
		// in the `workflow.execute` response. Session creation is fast (in-memory +
		// single file write), so this won't block the response.
		// v34: 不再一对一绑定专用 agent——调用者指定的 agent（/workflow 传当前聊天 agent、
		// 画布 Run 传 saros-claw）优先于 workflow.agentId 历史绑定。任何 agent 都能触发工作流。
		const workflowAgentId = options?.agentId || workflow.agentId;
		let ownerSessionId: string | undefined;
		let ownerAgentId: string | undefined;

		if (options?.sessionId && workflowAgentId) {
			// P4: 复用发起会话（如 /wf 命令所在的聊天会话），AskUser 交互卡片与
			// subagent 进度卡片直接显示在用户正看着的会话中，而非另开的「▶ 工作流名」会话。
			// 跳过 trigger anchor 消息——发起会话中已有用户的 /wf 消息作为锚点。
			ownerSessionId = options.sessionId;
			ownerAgentId = workflowAgentId;
			this._executionSession.set(executionId, {
				workflowAgentId,
				sessionId: options.sessionId,
				workflowName: workflow.name || workflowId,
			});
			this._sessionCache.set(`${workflowAgentId}:${executionId}`, options.sessionId);
			this.logService.info(
				`[WorkflowExecution] Reusing caller session ${options.sessionId} for ${workflowAgentId} (execution=${executionId})`,
			);
		} else if (workflowAgentId) {
			try {
				const meta = await this.agentChatService.createAgentSession(
					workflowAgentId,
					`▶ ${workflow.name || workflowId}`,
				);
				ownerSessionId = meta.id;
				ownerAgentId = workflowAgentId;
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
				`[WorkflowExecution] Workflow has no agentId; will fire __workflow__ with fallback session.`,
			);
		}

		// v7: ALWAYS fire __workflow__ so the webview can create a live container.
		// Without this, subagent cards never render because the container is never
		// created. If we have an owner session, use it; otherwise fire with a
		// fallback so the webview's fallback-container logic can kick in.
		const wfSessionId = ownerSessionId || options?.context?.sessionId || 'unknown';
		console.log(`[WorkflowExecution] Firing __workflow__ trace: execId=${executionId} session=${wfSessionId} agent=${ownerAgentId ?? '(none)'}`);
		this._onDidExecutionTrace.fire({
			kind: 'subagent_start',
			executionId,
			workflowAgentId: ownerAgentId,
			sessionId: wfSessionId,
			nodeId: '__workflow__',
			nodeName: workflow.name || workflowId,
			nodeType: 'workflow',
			ask: workflow.description || `Run workflow: ${workflow.name || workflowId}`,
		} as any);

		// ── FIX: kick off variable collection + execution asynchronously.
		//     Variable collection uses `await` (waiting for user input), which would
		//     block the `workflow.execute` request/response and cause a 30 s timeout.
		//     By firing this asynchronously, `executeWorkflow` returns immediately
		//     with the executionId (and sessionInfo), unblocking the response.
		this._collectVariablesAndExecute(executionId, executionState, workflow, options).catch(err => {
			this.logService.error(`[WorkflowExecution] Execution failed for ${executionId}:`, err);
			executionState.status = WorkflowExecutionStatus.Failed;
			executionState.error = err instanceof Error ? err.message : String(err);
			executionState.endTime = new Date().toISOString();
			this._onDidExecutionStatusChange.fire(executionState);
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

	/**
	 * Async: collect template variables (if any), then start workflow execution.
	 * Run fire-and-forget from `executeWorkflow` so the request returns immediately.
	 */
	private async _collectVariablesAndExecute(
		executionId: string,
		executionState: IWorkflowExecutionState,
		workflow: any,
		options?: IWorkflowExecutionOptions,
	): Promise<void> {
		// v6: Collect template variables from agent/prompt nodes before execution.
		const variables = WorkflowExecutionService._collectTemplateVariables(workflow);
		const ownerSession = this._executionSession.get(executionId);
		if (variables.length > 0 && ownerSession) {
			// v40: skip variable collection card when pre-filled from context (e.g. task board)
			if (options?.skipVariableCollection) {
				this.logService.info(
					`[WorkflowExecution] Skipping variable collection card (skipVariableCollection=true), ` +
					`auto-resolving ${variables.length} variable(s) from context`,
				);
				const autoValues: Record<string, string> = {};
				const ctx = options.context ?? {};
				for (const v of variables) {
					autoValues[v.name] = String(ctx[v.name] ?? v.defaultValue ?? '');
				}
				WorkflowExecutionService._substituteVariables(workflow, autoValues);
			} else {
				this.logService.info(
					`[WorkflowExecution] Found ${variables.length} template variable(s): ` +
					variables.map(v => v.name).join(', '),
				);
				this._onDidExecutionTrace.fire({
					kind: 'collect_variables',
					executionId,
					sessionId: ownerSession.sessionId,
					variables,
				});

				// Wait for the user to fill in variable values via the webview card.
				try {
					const values = await new Promise<Record<string, string>>((resolve) => {
						this._variableResolvers.set(executionId, resolve);
					});
					this.logService.info(
						`[WorkflowExecution] Variables collected: ${JSON.stringify(values)}`,
					);
					WorkflowExecutionService._substituteVariables(workflow, values);
					this._onDidExecutionTrace.fire({
						kind: 'collect_variables_end',
						executionId,
						sessionId: ownerSession.sessionId,
						status: 'submitted',
					});
				} catch {
					this._onDidExecutionTrace.fire({
						kind: 'collect_variables_end',
						executionId,
						sessionId: ownerSession.sessionId,
						status: 'skipped',
					});
				}
			} // end else (skipVariableCollection)
		}

		// Start execution (fire-and-forget)
		await this._executeWorkflowAsync(executionState, workflow, options);
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

		// v21: abort the in-flight LLM stream so the node executor's
		// `await sendMessage(...)` returns within ms instead of waiting for
		// the model to finish. Without this, clicking Cancel during a long
		// agent turn has no visible effect until the next model completion
		// (could be many seconds). Must run BEFORE the AskUser/variable
		// resolvers because they only unblock *future* awaits.
		this._abortActiveStream(executionId);

		// v4: resolve any pending AskUser pauses so the host's pauseExecution
		// promise doesn't leak. Also fire ask_user_end so the webview card
		// flips to "cancelled" state.
		this._cancelPendingAskUserForExecution(executionId, 'cancelled');

		// v6: resolve any pending variable collection so executeWorkflow doesn't hang.
		const varResolver = this._variableResolvers.get(executionId);
		if (varResolver) {
			this._variableResolvers.delete(executionId);
			// Reject by calling with empty values — executeWorkflow will see empty and skip.
			varResolver({});
			const ownerSession = this._executionSession.get(executionId);
			if (ownerSession) {
				this._onDidExecutionTrace.fire({
					kind: 'collect_variables_end',
					executionId,
					sessionId: ownerSession.sessionId,
					status: 'skipped',
				});
			}
		}
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

		// v31: visited set prevents diamond-pattern re-execution and infinite
		// loops from accidental cycles. maxDepth protects against stack
		// overflow on pathological graphs. Both are scoped to a single
		// execution run.
		const visited = new Set<string>();
		const MAX_DEPTH = 500;
		await this._executeNodeRecursive(executionState, workflow, startNode, adj, options, visited, 0, MAX_DEPTH);

		// Mark execution as completed (or failed if any node failed)
		if (executionState.status === WorkflowExecutionStatus.Running) {
			const hasFailed = [...executionState.nodeStates.values()]
				.some(s => s.status === WorkflowNodeExecutionStatus.Failed);
			executionState.status = hasFailed
				? WorkflowExecutionStatus.Failed
				: WorkflowExecutionStatus.Completed;
			executionState.endTime = new Date().toISOString();
			this._onDidExecutionStatusChange.fire(executionState);
			this.logService.info(`[WorkflowExecution] Execution ${executionState.executionId} ${hasFailed ? 'failed (some nodes failed)' : 'completed'}`);
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
		options: IWorkflowExecutionOptions | undefined,
		visited: Set<string>,
		depth: number,
		maxDepth: number,
	): Promise<void> {
		// Check if execution was cancelled
		if (executionState.status === WorkflowExecutionStatus.Cancelled) {
			return;
		}

		// v31: cycle detection — if this node has already been visited in the
		// current execution run, skip it. This prevents:
		//   1. Infinite loops from accidental cycles in the graph
		//   2. Diamond-pattern nodes being executed multiple times (once per
		//      incoming path, which would cause double-work and inconsistent state)
		if (visited.has(node.id)) {
			this.logService.info(
				`[WorkflowExecution] Node ${node.id} already visited (cycle/diamond), skipping`,
			);
			return;
		}
		visited.add(node.id);

		// v31: max depth guard — prevent stack overflow on deep/recursive graphs.
		if (depth >= maxDepth) {
			this.logService.error(
				`[WorkflowExecution] Max depth ${maxDepth} exceeded at node ${node.id}. ` +
				`Possible infinite loop or excessively deep workflow. Halting execution.`,
			);
			executionState.status = WorkflowExecutionStatus.Failed;
			executionState.error = `Workflow exceeded maximum depth of ${maxDepth} nodes. Possible infinite loop.`;
			executionState.endTime = new Date().toISOString();
			this._onDidExecutionStatusChange.fire(executionState);
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

		// v23: substitute upstream node outputs and the `$prev` alias in
		// `data.prompt` / `data.skillArgs[*]` / `data.toolParams[*]` BEFORE
		// any node executor runs. The pre-execution `_substituteVariables`
		// pass (called once when the workflow starts, see line ~181) only
		// resolved user-supplied variables — at that point upstream nodes
		// hadn't run yet, so `{{$prev.output}}` and `{{someNodeId.output}}`
		// remained as literal text and were never replaced.
		//
		// We re-substitute here, *now* that the upstream nodeStates map
		// contains the actual outputs of previously-completed nodes. The
		// value map built by `buildRuntimeValueMap` exposes BOTH the
		// `<nodeId>` and `<nodeId>.output` keys (and the same for `$prev`),
		// so users can write `{{myNode}}` or `{{myNode.output}}`
		// interchangeably. Cancellation / failed upstream nodes contribute
		// empty strings (with a warn log) so the prompt stays coherent
		// instead of leaving a literal `{{myNode.output}}` placeholder.
		//
		// Note: Start / End / AskUser nodes have no `data.prompt` and we
		// also short-circuit pure routing nodes to avoid mutating data on
		// them. The mutation goes back into `data` (same object the
		// downstream `_execute*Node` reads from), so it propagates
		// naturally to all four executors that use `data.prompt`.
		this._substituteUpstreamVariables(executionState, workflow, node);

		try {
			// 检查断点（P2 调试功能）
			if (executionState.breakpoints?.has(node.id)) {
				this.logService.info(`[WorkflowExecution] Breakpoint hit at node ${node.id}`);
				await this.pauseExecution(
					executionState.executionId,
					node.id,
					`断点暂停: ${node.name || node.id}`,
					[],
				);
			}

			// v31: Retry loop — wraps node execution with configurable
			// exponential backoff. Canceled executions are never retried.
			const nodeData = node.data ?? {};
			const retryMaxAttempts = (nodeData.retryMaxAttempts as number) ?? 0;
			const retryInitialMs = (nodeData.retryInitialDelayMs as number) ?? 1000;
			const retryMultiplier = (nodeData.retryBackoffMultiplier as number) ?? 2;
			const retryMaxMs = (nodeData.retryMaxDelayMs as number) ?? 30000;

		let nextNodeIds: string[] = [];

			for (let attempt = 0; attempt <= retryMaxAttempts; attempt++) {
				// Reset nextNodeIds before each attempt
				nextNodeIds = [];
				try {
					// Execute node based on type
					switch (node.type) {
						case WorkflowNodeType.Start:
							nextNodeIds = this._getNextNodes(node.id, adj);
							break;

						case WorkflowNodeType.End:
							nodeState.status = WorkflowNodeExecutionStatus.Completed;
							nodeState.endTime = new Date().toISOString();
							executionState.nodeStates.set(node.id, nodeState);
							this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState });
							return;

						case WorkflowNodeType.Task:
							await this._executeTaskNode(executionState, workflow, node, options);
							nextNodeIds = this._getNextNodes(node.id, adj);
							break;

						case WorkflowNodeType.Prompt:
							await this._executePromptNode(executionState, workflow, node, options);
							nextNodeIds = this._getNextNodes(node.id, adj);
							break;

						case WorkflowNodeType.Agent:
							await this._executeAgentNode(executionState, workflow, node, options);
							nextNodeIds = this._getNextNodes(node.id, adj);
							break;

						case WorkflowNodeType.Skill:
							await this._executeSkillNode(executionState, workflow, node, options);
							nextNodeIds = this._getNextNodes(node.id, adj);
							break;

						case WorkflowNodeType.Tool:
							await this._executeToolNode(executionState, workflow, node, options);
							nextNodeIds = this._getNextNodes(node.id, adj);
					break;

				case WorkflowNodeType.IfElse:
				case WorkflowNodeType.Switch:
					// Control flow: evaluate condition and follow branch
					nextNodeIds = await this._executeIfElseNode(executionState, workflow, node, adj, options);
					break;


				case WorkflowNodeType.AskUser:
				// AskUser node: pause and wait for user input
				const userInput = await this._executeAskUserNode(executionState, workflow, node, adj);
				// 将用户输入存储到上下文
				executionState.context['userInput'] = userInput;

				// v30: port-based routing. Each ask_user option maps to an
				// edge whose `fromPort` is 'option-0' / 'option-1' / ...
				// Only follow edges matching the user's selection(s), so
				// "暂不提交" doesn't accidentally flow into the git-commit
				// agent branch. Fall back to all edges when no port-specific
				// edges exist (backward compat for old workflows).
				{
					const askData = node.data ?? {};
					const askOptions = (askData.options as IAskUserOption[]) ?? [];
					const selections = Array.isArray(userInput) ? userInput : [userInput];
					const selectedIndices: number[] = [];
					for (const sel of selections) {
						const idx = askOptions.findIndex(opt => opt.label === sel);
						if (idx >= 0) { selectedIndices.push(idx); }
					}
					if (selectedIndices.length > 0) {
						nextNodeIds = this._getAskUserNextNodes(node.id, adj, selectedIndices);
						if (nextNodeIds.length === 0) {
							this.logService.warn(`[WorkflowExecution] AskUser ${node.id}: no edges matched selected options [${selectedIndices.join(',')}], falling back to all edges`);
							nextNodeIds = this._getNextNodes(node.id, adj);
						}
					} else {
						nextNodeIds = this._getNextNodes(node.id, adj);
					}
				}
				break;

				case WorkflowNodeType.Comfy:
				case WorkflowNodeType.ComfyStage:
					await this._executeComfyNode(executionState, workflow, node, options);
					nextNodeIds = this._getNextNodes(node.id, adj);
					break;

				default:
					this.logService.warn(`[WorkflowExecution] Unknown node type: ${node.type}, skipping`);
					nextNodeIds = this._getNextNodes(node.id, adj);
					break;
			}
					// Success — exit the retry loop.
					break;
			} catch (innerErr) {
				// Never retry cancelled executions.
					if ((executionState.status as string) === 'cancelled') {
						throw innerErr;
					}
					// Last attempt — re-throw to the outer catch handler.
					if (attempt >= retryMaxAttempts) {
						throw innerErr;
					}
					// Calculate exponential backoff delay with jitter.
					const baseDelay = Math.min(
						retryMaxMs,
						retryInitialMs * Math.pow(retryMultiplier, attempt),
					);
					// Add ±20% jitter to avoid thundering herd.
					const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
					const delay = Math.round(baseDelay + jitter);
					this.logService.warn(
						`[WorkflowExecution] Node ${node.id} failed (attempt ${attempt + 1}/${retryMaxAttempts + 1}), ` +
						`retrying in ${delay}ms: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`,
					);
					// Reset node state for retry.
					nodeState.status = WorkflowNodeExecutionStatus.Running;
					nodeState.error = undefined;
					nodeState.endTime = undefined;
					executionState.nodeStates.set(node.id, nodeState);
					this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState });
					await new Promise(resolve => setTimeout(resolve, delay));
				}
			}

			// Mark node as completed
			nodeState.status = WorkflowNodeExecutionStatus.Completed;
			nodeState.endTime = new Date().toISOString();
			// v30: AskUser nodes store the selected labels as their output
			if (node.type === WorkflowNodeType.AskUser && nodeState.output === undefined) {
				const ctxInput = executionState.context['userInput'];
				if (ctxInput !== undefined) {
					nodeState.output = Array.isArray(ctxInput) ? (ctxInput as string[]).join(', ') : (ctxInput as string);
				}
			}
			// v37: Prompt nodes store their (already-substituted) prompt text
			// as output so downstream nodes can reference it via {{$prev.output}}.
			// Without this, _collectUpstreamOutputs finds no output for the
			// prompt node, causing {{$prev.output}} to resolve to empty in the
			// downstream agent node — which then falls back to workflow
			// description instead of the user's actual input.
			if (node.type === WorkflowNodeType.Prompt && nodeState.output === undefined) {
				const promptText = (node.data as { prompt?: string })?.prompt;
				if (promptText) {
					nodeState.output = promptText;
					this.logService.info(
						`[WorkflowExecution] Prompt node ${node.id}: stored output (len=${promptText.length}) for downstream {{$prev.output}}`,
					);
				}
			}
			executionState.nodeStates.set(node.id, nodeState);
			this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState });

			// v32: write node output to SharedMemory for cross-node communication.
			// Any downstream node can read this via executionState.sharedMemory.get(nodeId).
			if (nodeState.output !== undefined) {
				executionState.sharedMemory.set(node.id, String(nodeState.output));
			}

			// v32: save checkpoint after node success
			this._saveCheckpoint(executionState).catch(() => { /* best-effort */ });

			// Execute next nodes
			for (const nextNodeId of nextNodeIds) {
				const nextNode = workflow.nodes?.find(n => n.id === nextNodeId);
				if (nextNode) {
					await this._executeNodeRecursive(executionState, workflow, nextNode, adj, options, visited, depth + 1, maxDepth);
				}
			}
		} catch (err) {
			// v21: distinguish cancellation from real failures. When the user
			// clicks Cancel, _abortActiveStream() flips the AbortController, the
			// stream loop breaks, and _sendAndTrackStream's `finally` cleans up.
			// sendMessage() returns with whatever was accumulated so the node
			// executor usually does NOT throw — the cancel propagates as a normal
			// return. But if a node was already mid-await when cancel fired and
			// throws (e.g. inner network error from the abort), we should NOT
			// mark the whole execution as Failed — the user explicitly cancelled
			// it. Detect by status flag instead of by error message to keep
			// semantics independent of error wording.
			// Note: use string comparison rather than enum equality here —
			// the early `if (status === Cancelled) return` above narrows the
			// status type inside the try block, which the catch block inherits,
			// so a direct enum comparison would be flagged TS2367 (no overlap).
			if ((executionState.status as string) === 'cancelled') {
				// Mark this node as cancelled (not failed) and let the natural
				// `_executeWorkflowAsync` end-of-loop `execution_end` fire.
				nodeState.status = WorkflowNodeExecutionStatus.Cancelled;
				nodeState.endTime = new Date().toISOString();
				executionState.nodeStates.set(node.id, nodeState);
				this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState });
				return;
			}
			// v32: Cascade failure — instead of immediately failing the entire
			// execution, mark this node as Failed and recursively skip all
			// downstream nodes (they cannot run without upstream output).
			// Other independent branches continue normally. The execution
			// is marked Failed at the end only if any node actually failed.
			nodeState.status = WorkflowNodeExecutionStatus.Failed;
			nodeState.error = err instanceof Error ? err.message : String(err);
			nodeState.endTime = new Date().toISOString();
			executionState.nodeStates.set(node.id, nodeState);
			this._onDidNodeExecutionStatusChange.fire({ executionId: executionState.executionId, nodeState });

			// Collect all downstream node IDs reachable from this failed node.
			this._cascadeSkipDownstream(executionState, node.id, adj);
			// Do NOT throw — let the execution continue for other branches.
			return;
		}
	}

	/**
	 * v32: Cascade failure — recursively mark all downstream nodes reachable
	 * from a failed node as Skipped. This prevents the execution engine from
	 * trying to execute nodes that depend on missing upstream output.
	 * Independent parallel branches are unaffected.
	 */
	private _cascadeSkipDownstream(
		executionState: IWorkflowExecutionState,
		failedNodeId: string,
		adj: Map<string, { targetId: string; fromPort?: string }[]>,
		visited = new Set<string>(),
	): void {
		if (visited.has(failedNodeId)) { return; }
		visited.add(failedNodeId);

		const downstream = adj.get(failedNodeId);
		if (!downstream) { return; }

		for (const { targetId } of downstream) {
			if (visited.has(targetId)) { continue; }
			// Only skip nodes that haven't already started/run/failed.
			// If a node already Failed (its own error, not cascade), don't overwrite with Skipped.
			const existingState = executionState.nodeStates.get(targetId);
			if (existingState && (
				existingState.status === WorkflowNodeExecutionStatus.Completed ||
				existingState.status === WorkflowNodeExecutionStatus.Running ||
				existingState.status === WorkflowNodeExecutionStatus.Failed
			)) { continue; }

			const skippedState: IWorkflowNodeExecutionState = {
				nodeId: targetId,
				status: WorkflowNodeExecutionStatus.Skipped,
				output: undefined,
				error: `Upstream node "${failedNodeId}" failed`,
				startTime: new Date().toISOString(),
				endTime: new Date().toISOString(),
			};
			executionState.nodeStates.set(targetId, skippedState);
			this._onDidNodeExecutionStatusChange.fire({
				executionId: executionState.executionId,
				nodeState: skippedState,
			});
			this.logService.info(
				`[WorkflowExecution] Cascade: skipped node ${targetId} because upstream ${failedNodeId} failed`,
			);
			// Recurse to skip this node's downstream too.
			this._cascadeSkipDownstream(executionState, targetId, adj, visited);
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
			// v21: route through _sendAndTrackStream so cancelExecution can abort
			// the in-flight LLM call. Previously the bare `sendMessage` await
			// kept running even after status flipped to Cancelled, so the UI
			// button had no effect during long agent turns.
			// 获取或创建 agent session，避免消息被 cross-session leakage guard 丢弃
			const taskSessionName = WorkflowExecutionService._buildSessionName(executionState, workflow);
			const taskSessionId = await this._getOrCreateAgentSession(
				agentId,
				executionState.executionId,
				taskSessionName,
			);
			const message = await this._sendAndTrackStream(
				executionState,
				node,
				agentId,
				taskDescription,
				taskSessionId,
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
		//
		// v32: _substituteUpstreamVariables mutates data.prompt in-place before
		// we reach here. If the original prompt was a variable template like
		// {{$prev.output}} and the upstream output was empty, data.prompt is
		// now '' — which looks like "no prompt configured". We must distinguish
		// "user didn't write a prompt" from "user wrote a template that resolved
		// to empty because the upstream node didn't produce output".
		// To do this, check whether the ORIGINAL node data has a non-empty
		// prompt property BEFORE substitution happened. We use the node's own
		// data (via the workflow.nodes) since data.prompt has been mutated.
		const workflowNode = workflow.nodes?.find(n => n.id === node.id);
		const originalPrompt = (workflowNode?.data?.prompt as string) || '';
		const hadExplicitPrompt = !!originalPrompt;

		let nodePrompt = (data.prompt as string) || '';
		if (!nodePrompt && !hadExplicitPrompt) {
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

		if (!nodePrompt && !hadExplicitPrompt) {
			// No explicit prompt — build a sensible fallback from workflow description
			// or node label instead of skipping execution.
			// v32: only fall back when the user genuinely didn't configure a prompt
			// (not when a {{$prev.output}} variable resolved to empty).
			const fallback = (workflow.description || '').trim() ||
				`Run the "${(data.label as string) || node.name || node.id}" agent with default instructions.`;
			nodePrompt = fallback;
			this.logService.info(
				`[WorkflowExecution] Agent node ${node.id} ("${node.name || ''}") has no explicit prompt — ` +
				`using fallback: "${fallback.substring(0, 80)}"`,
			);
		}

		// v32: when a variable template was configured but resolved to empty
		// (upstream didn't produce output), provide a clear diagnostic message
		// instead of sending empty instructions.
		if (!nodePrompt && hadExplicitPrompt) {
			nodePrompt = `The upstream node's output is empty — no content to work with. ` +
				`Original prompt template: <template>${originalPrompt}</template>. ` +
				`This agent node was supposed to receive upstream output but none was produced. ` +
				`Please check the upstream node's execution logs.`;
			this.logService.warn(
				`[WorkflowExecution] Agent node ${node.id} ("${node.name || ''}") prompt resolved to empty ` +
				`after variable substitution (original template: "${originalPrompt}"). ` +
				`Using diagnostic fallback.`,
			);
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
		} else {
			this.logService.warn(
				`[WorkflowExecution] _executeAgentNode: ownerSession not found for executionId=${executionState.executionId}, ` +
				`subagent_start event not fired — subagent cards will not show in chat. ` +
				`Check that workflow.agentId is set and executeWorkflow() successfully created the owner session.`,
			);
		}

		try {
			// 使用指定 agent 执行（发送一个继续的提示）
			const continuePrompt = nodePrompt;

			// v31: contextScope — controls how much conversation context the
			// agent node receives. Default 'session' keeps the old behaviour
			// (shared session with full history).
			const scope = ((data.contextScope as string) || 'session') as 'session' | 'upstream-only' | 'fresh';
			let agentSessionId: string;
			let extraOpts: { systemPrompt?: string } | undefined;

			if (scope === 'fresh') {
				// Fresh: fully isolated — new session, no upstream context.
				const sessionName = `${WorkflowExecutionService._buildSessionName(executionState, workflow)}_${node.id}`;
				const meta = await this.agentChatService.createAgentSession(agentId, sessionName);
				agentSessionId = meta.id;
				this.logService.info(`[WorkflowExecution] Agent node ${node.id}: contextScope=fresh, new session=${agentSessionId}`);
			} else if (scope === 'upstream-only') {
				// Upstream-only: new session with only upstream node outputs
				// injected as a system message — no prior conversation history.
				const sessionName = `${WorkflowExecutionService._buildSessionName(executionState, workflow)}_${node.id}`;
				const meta = await this.agentChatService.createAgentSession(agentId, sessionName);
				agentSessionId = meta.id;

				// Build upstream context as a system prompt from completed node outputs.
				const upstreamOutputs = this._collectUpstreamOutputs(executionState);
				const upstreamEntries = Object.entries(upstreamOutputs);
				if (upstreamEntries.length > 0) {
					const sections = upstreamEntries.map(([nid, out]) =>
						`<upstream_node id="${nid}">\n${out || '(empty output)'}\n</upstream_node>`,
					);
					extraOpts = {
						systemPrompt: [
							'You are executing a step in a workflow. Below are the outputs from ' +
							'previously completed steps. Use them as context for your task.',
							'',
							...sections,
						].join('\n'),
					};
				}
				this.logService.info(
					`[WorkflowExecution] Agent node ${node.id}: contextScope=upstream-only, ` +
					`new session=${agentSessionId}, upstream nodes=${upstreamEntries.length}`,
				);
			} else {
				// Session (default): shared session for this agent+execution,
				// full conversation history available.
				const sessionName = WorkflowExecutionService._buildSessionName(executionState, workflow);
				agentSessionId = await this._getOrCreateAgentSession(
					agentId,
					executionState.executionId,
					sessionName,
				);
			}

			this.logService.info(`[WorkflowExecution] Sending to agent ${agentId} (session=${agentSessionId}, scope=${scope}): ${continuePrompt}`);

			// v21: route through _sendAndTrackStream so cancelExecution can abort
			// the in-flight LLM call.
			const nodeData = data as Record<string, any>;
			const timeoutConfig = {
				runTimeoutMs: nodeData.timeoutRunMs as number | undefined,
				idleTimeoutMs: nodeData.timeoutIdleMs as number | undefined,
			};
			const message = await this._sendAndTrackStream(
				executionState,
				node,
				agentId,
				continuePrompt,
				agentSessionId,
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
				extraOpts,
				timeoutConfig,
			);

			// 记录执行结果
			const nodeState = executionState.nodeStates.get(node.id);
			if (nodeState) {
				nodeState.output = message.content || '';
			}

			// v21: if the execution was cancelled mid-stream, fire subagent_end
			// with status 'cancelled' so the webview card flips to the cancelled
			// badge instead of the "done" success badge. The sendMessage await
			// returns with partial content (no throw) when AbortController is
			// tripped, so we have to detect cancel via the execution status.
			const wasCancelled = (executionState.status as string) === 'cancelled';
			if (ownerSession) {
				this._onDidExecutionTrace.fire({
					kind: 'subagent_end',
					executionId: executionState.executionId,
					sessionId: ownerSession.sessionId,
					nodeId: node.id,
					status: wasCancelled ? 'cancelled' : 'done',
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
		const skillName = (data.skillName as string) || (data.skillId as string) || '';
		const skillInput = (data.prompt as string) || '';
		const skillArgs = (data.skillArgs as Record<string, string>) ?? {};

		const agentId = _options?.agentId || workflow.agentId;

		if (!skillName) {
			throw new Error(`Skill node ${node.id} has no skillName`);
		}

		// P2: 双向打通 —— 若 skillName 解析到 workflow 来源的可执行 skill，
		// 则确定性硬调用该工作流（而非软触发 prompt），把最终输出作为本节点输出。
		const wfSkill = this._resolveWorkflowSkill(skillName);
		if (wfSkill?.executor?.kind === 'workflow') {
			this.logService.info(`[WorkflowExecution] Skill node ${node.id} resolves to workflow ${wfSkill.executor.workflowId} — executing deterministically`);
			const finalOutput = await this._executeWorkflowAndAwait(wfSkill.executor.workflowId, {
				context: { input: skillInput },
				agentId,
				skipVariableCollection: true,
			});
			const nodeState = executionState.nodeStates.get(node.id);
			if (nodeState) {
				nodeState.output = finalOutput ?? '';
			}
			return;
		}

		if (!agentId) {
			throw new Error(`Skill node ${node.id}: No agent ID available`);
		}

		// Build skill execution prompt
		const argsStr = Object.entries(skillArgs)
			.map(([k, v]) => `  - ${k}: ${v}`)
			.join('\n');
		const promptParts: string[] = [
			`Execute the following skill: **${skillName}**`,
			skillInput ? `\nInput: ${skillInput}` : '',
			argsStr ? `\nArguments:\n${argsStr}` : '',
		];
		const executionPrompt = promptParts.filter(Boolean).join('\n');

		this.logService.info(`[WorkflowExecution] Skill ${node.id}: executing "${skillName}"`);
		// v21: route through _sendAndTrackStream so cancelExecution can abort
		// the in-flight LLM call. The bare `sendMessage` await previously
		// ignored the Cancelled status, so cancel had no effect during
		// long-running skill executions.
		// 获取或创建 agent session，避免消息被 cross-session leakage guard 丢弃
		const skillSessionName = WorkflowExecutionService._buildSessionName(executionState, workflow);
		const skillSessionId = await this._getOrCreateAgentSession(
			agentId,
			executionState.executionId,
			skillSessionName,
		);
		const message = await this._sendAndTrackStream(
			executionState,
			node,
			agentId,
			executionPrompt,
			skillSessionId,
			() => { /* noop onDelta */ },
		);

		const nodeState = executionState.nodeStates.get(node.id);
		if (nodeState) {
			nodeState.output = message.content || '';
		}
	}

	// ─── P2/P3: workflow 型 skill 节点的确定性硬调用 ─────────────────────

	/**
	 * 解析一个 skill 名称是否为 workflow 来源的可执行 skill。
	 * 大小写不敏感匹配；返回第一个 source==='workflow' 的 skill 定义。
	 */
	private _resolveWorkflowSkill(skillName: string): ISkillDefinition | undefined {
		const name = skillName.toLowerCase();
		for (const s of this.skillRegistry.getSkills()) {
			if (s.source === 'workflow' && s.name.toLowerCase() === name && s.executor?.kind === 'workflow') {
				return s;
			}
		}
		return undefined;
	}

	/**
	 * 嵌套执行一个工作流并等待其完成，返回最终输出（供 Skill 节点作为本节点输出）。
	 * - 环检测由 executeWorkflow 入口统一处理（递归调用会抛错），此处捕获并返回空。
	 * - 通过订阅 onDidExecutionStatusChange 等待目标 executionId 进入终态。
	 */
	private async _executeWorkflowAndAwait(workflowId: string, options?: IWorkflowExecutionOptions): Promise<string | undefined> {
		let executionId: string;
		try {
			executionId = await this.executeWorkflow(workflowId, options);
		} catch (err) {
			this.logService.warn(`[WorkflowExecution] nested workflow execution skipped (likely cyclic): ${workflowId}`, err);
			return undefined;
		}
		return new Promise<string | undefined>((resolve) => {
			const sub = this.onDidExecutionStatusChange(state => {
				if (state.executionId !== executionId) { return; }
				if (state.status === WorkflowExecutionStatus.Completed
					|| state.status === WorkflowExecutionStatus.Failed
					|| state.status === WorkflowExecutionStatus.Cancelled) {
					sub.dispose();
					resolve(this._extractFinalOutput(state));
				}
			});
		});
	}

	/** 从执行状态中提取最终输出（最后一个 completed 且有 output 的节点）。 */
	private _extractFinalOutput(state: IWorkflowExecutionState): string {
		let last = '';
		for (const ns of state.nodeStates.values()) {
			if (ns.status === WorkflowNodeExecutionStatus.Completed && ns.output) {
				last = ns.output;
			}
		}
		return last;
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
		const toolParams = (data.toolParams ?? data.params ?? {}) as Record<string, unknown>;

		if (!toolName) {
			throw new Error(`Tool node ${node.id} has no toolName`);
		}

		const agentId = _options?.agentId || workflow.agentId;
		if (!agentId) {
			throw new Error(`Tool node ${node.id}: No agent ID available`);
		}

		// Build tool execution prompt
		const paramsStr = typeof toolParams === 'string'
			? toolParams as string
			: JSON.stringify(toolParams, null, 2);
		const executionPrompt = paramsStr && Object.keys(toolParams).length > 0
			? `Execute tool **${toolName}** with parameters:\n\`\`\`json\n${paramsStr}\n\`\`\``
			: `Execute tool **${toolName}**`;

		this.logService.info(`[WorkflowExecution] Tool ${node.id}: executing "${toolName}"`);
		// v21: route through _sendAndTrackStream so cancelExecution can abort
		// the in-flight LLM call (cancel previously had no effect while a
		// tool's agent turn was streaming).
		// 获取或创建 agent session，避免消息被 cross-session leakage guard 丢弃
		const toolSessionName = WorkflowExecutionService._buildSessionName(executionState, workflow);
		const toolSessionId = await this._getOrCreateAgentSession(
			agentId,
			executionState.executionId,
			toolSessionName,
		);
		const message = await this._sendAndTrackStream(
			executionState,
			node,
			agentId,
			executionPrompt,
			toolSessionId,
			() => { /* noop onDelta */ },
		);

		const nodeState = executionState.nodeStates.get(node.id);
		if (nodeState) {
			nodeState.output = message.content || '';
		}
	}

	/**
	 * Execute a ComfyUI-compatible node (WorkflowNodeType.Comfy / ComfyStage).
	 * The actual Comfy invocation is delegated to an injected
	 * `IComfyExecutionDelegate` (set via setComfyExecutionDelegate), so the
	 * executor stays decoupled from the webview HTTP client. When no delegate is
	 * configured the node is skipped with a warning (same as unknown types).
	 */
	private async _executeComfyNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		_options?: IWorkflowExecutionOptions,
	): Promise<void> {
		this.logService.info(`[WorkflowExecution] Executing Comfy node: ${node.id} (${node.type})`);
		const data = node.data ?? {};
		const comfy = (data.comfy ?? {}) as { mode?: 'workflow' | 'stage'; stageClass?: string; workflowId?: string };

		if (!this._comfyDelegate) {
			this.logService.warn(
				`[WorkflowExecution] Comfy node ${node.id} skipped: no Comfy execution delegate registered. ` +
				`Use setComfyExecutionDelegate() to enable ComfyUI execution.`,
			);
			return;
		}

		// Collect resolved binding values: read the node's bindings + defaults and
		// resolve template variables against upstream node outputs (shared memory).
		const bindings = (data.bindings ?? {}) as Record<string, string>;
		const defaults = (data.defaults ?? {}) as Record<string, unknown>;
		const values: Record<string, unknown> = {};
		for (const [key, binding] of Object.entries(bindings)) {
			const resolved = WorkflowExecutionService._replaceVariables(
				typeof binding === 'string' ? binding : String(binding),
				this._buildEvalContext(executionState),
			);
			if (resolved !== undefined && resolved !== '') {
				values[key] = resolved;
			} else if (defaults[key] !== undefined) {
				values[key] = defaults[key];
			}
		}
		// Include the node's own label/description as a fallback context — but only
		// when no binding (e.g. `label: '{{n-prompt.output}}'`) already filled it.
		if (values['label'] === undefined) {
			values['label'] = data.label ?? node.name ?? node.id;
		}

		const input: ComfyExecutionInput = { values, defaults };
		const result = await this._comfyDelegate.execute(node, input, { executionId: executionState.executionId });

		const nodeState = executionState.nodeStates.get(node.id);
		if (nodeState) {
			nodeState.output = result.summary ?? JSON.stringify(result.outputs);
		}
		this.logService.info(
			`[WorkflowExecution] Comfy node ${node.id} completed (mode=${comfy.mode ?? 'workflow'}, outputs=${Object.keys(result.outputs).length})`,
		);
	}

	private async _executeIfElseNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		adj: Map<string, { targetId: string; fromPort?: string }[]>,
		_options?: IWorkflowExecutionOptions,
	): Promise<string[]> {
		this.logService.info(`[WorkflowExecution] Executing IfElse/Switch node: ${node.id}`);
		const data = node.data ?? {};
		const branches: Array<{ id: string; label: string; condition: string; isDefault?: boolean }> =
			(data.branches as any[]) || [{ id: '0', label: 'True', condition: '' }, { id: '1', label: 'False', condition: '' }];

		const agentId = _options?.agentId || workflow.agentId;
		const isSwitch = node.type === WorkflowNodeType.Switch;

		// v31: resolve the default branch index. The isDefault flag marks the
		// catch-all branch that should be taken when no condition matches.
		// prefer it as the ultimate fallback over hardcoded branch-0.
		const defaultBranchIndex = (() => {
			const idx = branches.findIndex(b => b.isDefault);
			return idx >= 0 ? idx : 0;
		})();

		// ═══════════════════════════════════════════════════════════════════
		// v31: Code-level deterministic condition evaluation.
		// Before calling the LLM (expensive + non-deterministic), try to
		// evaluate conditions with deterministic rules. For Switch nodes,
		// match the resolved evaluationTarget against branch labels and
		// condition text. For IfElse nodes, parse simple `==`, `contains`,
		// `startsWith` / `endsWith` patterns from condition strings.
		// Only fall back to LLM when no deterministic rule fires.
		// ═══════════════════════════════════════════════════════════════════
		const evalTargetRaw = (data.evaluationTarget as string) || '';
		const resolvedEvalTarget = evalTargetRaw
			? WorkflowExecutionService._replaceVariables(evalTargetRaw, this._buildEvalContext(executionState))
			: '';
		let branchIndex = -1; // -1 = not yet determined, requires LLM fallback

		// ---- Switch: deterministic label/value matching ----
		if (isSwitch && resolvedEvalTarget) {
			const targetLower = resolvedEvalTarget.trim().toLowerCase();
			this.logService.info(
				`[WorkflowExecution] Switch ${node.id}: deterministic eval on ` +
				`target="${targetLower}" against ${branches.length} branches`,
			);
			for (let i = 0; i < branches.length; i++) {
				const labelLower = (branches[i].label || '').toLowerCase();
				const condLower = (branches[i].condition || '').toLowerCase();
				if (
					labelLower === targetLower ||
					condLower === targetLower ||
					labelLower.includes(targetLower) ||
					condLower.includes(targetLower)
				) {
					branchIndex = i;
					this.logService.info(
						`[WorkflowExecution] Switch ${node.id}: ` +
						`deterministic match → branch ${branchIndex} ("${branches[i].label}")`,
					);
					break;
				}
			}
			// If no direct match, check for a numeric evaluationTarget that maps to branch index
			if (branchIndex === -1) {
				const num = parseInt(resolvedEvalTarget, 10);
				if (!isNaN(num) && num >= 0 && num < branches.length) {
					branchIndex = num;
					this.logService.info(
						`[WorkflowExecution] Switch ${node.id}: ` +
						`numeric target → branch ${branchIndex}`,
					);
				}
			}
		}

		// ---- IfElse: deterministic condition parsing ----
		if (!isSwitch && branchIndex === -1) {
			for (let i = 0; i < branches.length; i++) {
				const cond = (branches[i].condition || '').trim();
				if (!cond) { continue; }
				const resolved = WorkflowExecutionService._replaceVariables(
					cond,
					this._buildEvalContext(executionState),
				);
				if (this._evaluateSimpleCondition(resolved, executionState)) {
					branchIndex = i;
					this.logService.info(
						`[WorkflowExecution] IfElse ${node.id}: ` +
						`deterministic match → branch ${branchIndex} ("${branches[i].label}") ` +
						`condition="${cond}"`,
					);
					break;
				}
			}
		}

		// ---- LLM fallback (only when deterministic eval didn't decide) ----
		if (branchIndex === -1 && agentId) {
			// Build prompt to ask agent to evaluate conditions
			const branchList = branches.map((b, i) =>
				`${i}. **${b.label}**: ${b.condition || (b.isDefault ? '(default)' : '(no condition)')}`
			).join('\n');

			// v31: for Switch nodes, include the resolved evaluationTarget in
			// the prompt so the LLM knows what value to switch on. Previously
			// evaluationTarget was only stored in node data but never passed
			// to the agent, making Switch nodes behave identically to IfElse.
			const switchOnLine = (isSwitch && resolvedEvalTarget)
				? `\n**Switching on:** "${resolvedEvalTarget}"\n`
				: '';

			const evaluationPrompt = [
				'You are at a decision point in the workflow. Evaluate the following branches and decide which one to follow.',
				'',
				'**Branches:**',
				branchList,
				switchOnLine,
				'Based on the context of all previous steps, which branch should be followed?',
				'Respond with ONLY the branch number (e.g., "0") on the first line.',
			].join('\n');

		try {
			this.logService.info(`[WorkflowExecution] IfElse/Switch ${node.id}: asking agent to evaluate`);
			const t0_eval = Date.now();
			// 获取或创建 agent session，避免消息被 cross-session leakage guard 丢弃
			const sessionName = WorkflowExecutionService._buildSessionName(executionState, workflow);
			const ifElseSessionId = await this._getOrCreateAgentSession(
				agentId,
				executionState.executionId,
				sessionName,
			);
			const message = await this._sendAndTrackStream(
				executionState,
				node,
				agentId,
				evaluationPrompt,
				ifElseSessionId,
				() => { /* noop onDelta */ },
			);
				this.logService.info(`[WorkflowExecution] IfElse/Switch ${node.id}: evaluation returned in ${Date.now() - t0_eval}ms, contentLen=${message?.content?.length ?? 0}`);

				// v31: robust parsing — scan the first non-empty line for a
				// standalone integer, falling back to the old /\b([0-9]+)\b/
				// for backward compatibility.
				const content = message.content || '';
				const lines = content.split('\n').map((l: string) => l.trim()).filter(Boolean);
				let parsed = false;
				for (const line of lines) {
					const m = line.match(/^(\d+)\b/);
					if (m) {
						const idx = parseInt(m[1], 10);
						if (idx >= 0 && idx < branches.length) {
							branchIndex = idx;
							parsed = true;
							break;
						}
					}
				}
				if (!parsed) {
					// fallback: old-style regex across entire content
					const match = content.match(/\b([0-9]+)\b/);
					if (match) {
						const idx = parseInt(match[1], 10);
						if (idx >= 0 && idx < branches.length) {
							branchIndex = idx;
						}
					}
				}
				if (branchIndex === -1) {
					this.logService.warn(
						`[WorkflowExecution] IfElse/Switch ${node.id}: ` +
						`could not parse branch index from agent response "${content.substring(0, 100)}"`,
					);
				}
			} catch (err) {
				this.logService.warn(
					`[WorkflowExecution] IfElse/Switch ${node.id}: ` +
					`condition evaluation failed: ${err instanceof Error ? err.message : err}`,
				);
			}
		}

		// ---- Ultimate fallback: use default branch ----
		if (branchIndex === -1) {
			branchIndex = defaultBranchIndex;
			this.logService.info(
				`[WorkflowExecution] IfElse/Switch ${node.id}: ` +
				`no match found (agentId=${agentId || '<none>'}), ` +
				`using default branch ${branchIndex} ("${branches[branchIndex]?.label}")`,
			);
		}

		// Clamp to valid range (safety net)
		if (branchIndex < 0 || branchIndex >= branches.length) {
			branchIndex = defaultBranchIndex;
		}

		this.logService.info(`[WorkflowExecution] IfElse/Switch ${node.id}: selected branch ${branchIndex} ("${branches[branchIndex]?.label}")`);

		// Store the decision + upstream output in execution context.
		// v38: The node output must carry the actual upstream data, not just
		// the branch metadata. Otherwise {{$prev.output}} in downstream nodes
		// resolves to "Selected branch 0: 通过（无报错）" and the agent has
		// no real input to work with. We concatenate: upstream output first
		// (the data), then the branch decision (metadata separator).
		const nodeState = executionState.nodeStates.get(node.id);
		if (nodeState) {
			const upstreamOutputs = this._collectUpstreamOutputs(executionState);
			const upstreamEntries = Object.entries(upstreamOutputs)
				.filter(([, val]) => val.trim())
				.map(([, val]) => val.trim());
			const upstreamBlob = upstreamEntries.join('\n\n');
			const branchMeta = `Selected branch ${branchIndex}: ${branches[branchIndex]?.label}`;
			nodeState.output = upstreamBlob
				? `${upstreamBlob}\n\n---\nBranch decision: ${branchMeta}`
				: branchMeta;
		}

		// Return the selected branch's next nodes
		const connections = adj.get(node.id) ?? [];
		// v31: port-based routing. Match against branch-{branchIndex}.
		const matching = connections.filter(c => c.fromPort === `branch-${branchIndex}`);
		if (matching.length > 0) {
			return matching.map(c => c.targetId);
		}
		// v31: port mismatch — fall back to the default branch's port instead
		// of returning ALL downstream nodes (which would bypass branching
		// semantics and silently execute every branch).
		const defaultMatch = connections.filter(c => c.fromPort === `branch-${defaultBranchIndex}`);
		if (defaultMatch.length > 0) {
			this.logService.warn(
				`[WorkflowExecution] IfElse/Switch ${node.id}: ` +
				`no edge matched port "branch-${branchIndex}", ` +
				`falling back to default port "branch-${defaultBranchIndex}"`,
			);
			return defaultMatch.map(c => c.targetId);
		}
		// Ultimate last resort: return first branch's matches
		const firstMatch = connections.filter(c => c.fromPort === `branch-0`);
		if (firstMatch.length > 0) {
			this.logService.warn(
				`[WorkflowExecution] IfElse/Switch ${node.id}: ` +
				`no edge matched any specific port, using branch-0`,
			);
			return firstMatch.map(c => c.targetId);
		}
		// No port-specific edges at all — return all (backward compat for old
		// workflows that don't have fromPort on connections behind control-flow nodes)
		this.logService.warn(
			`[WorkflowExecution] IfElse/Switch ${node.id}: ` +
			`no port-specific edges found, falling back to all downstream (backward compat)`,
		);
		return connections.map(c => c.targetId);
	}

	/**
	 * v31: Build a context map for variable resolution inside condition text.
	 * Resolves upstream node outputs so that `{{previewStatus.output}}` and
	 * similar references evaluate to actual values.
	 */
	private _buildEvalContext(executionState: IWorkflowExecutionState): Record<string, string> {
		const ctx: Record<string, string> = {};
		for (const [nodeId, ns] of executionState.nodeStates) {
			if (ns.output !== undefined) {
				ctx[nodeId] = ns.output;
				ctx[`${nodeId}.output`] = ns.output;
			}
		}
		// Also expose direct context entries
		for (const [k, v] of Object.entries(executionState.context)) {
			if (typeof v === 'string') { ctx[k] = v; }
		}
		return ctx;
	}

	/**
	 * v31: Evaluate a simple condition string (after variable substitution)
	 * against the current execution context. Supports:
	 *   - `value == "literal"` or `value === "literal"`
	 *   - `value != "literal"` or `value !== "literal"`
	 *   - `value contains "substring"`
	 *   - `value startsWith "prefix"` / `value endsWith "suffix"`
	 *   - plain boolean truthiness: non-empty string = true, empty = false
	 *
	 * Returns true if the condition evaluates to true, false otherwise.
	 * Returns false for conditions that can't be parsed (safe fail: defer to LLM).
	 */
	private _evaluateSimpleCondition(condition: string, _executionState: IWorkflowExecutionState): boolean {
		const text = condition.trim();
		if (!text) { return false; }

		// Pattern: `"something"` or `'something'` → plain truthiness check.
		// Non-empty quoted literal → true (means this branch fires).
		// But a bare quoted string without an operator has no meaning, skip.
		if (/^["'].*["']$/.test(text)) {
			// A condition that's just a quoted literal is unusual — treat as truthy.
			return text.length > 2; // at least one char inside quotes
		}

		// Try `value == "literal"` / `value === "literal"`
		const eqMatch = text.match(/^(.+?)\s*[=!]==?\s*["'](.+?)["']$/);
		if (eqMatch) {
			const lhs = eqMatch[1].trim();
			const op = text.includes('!=') || text.includes('!==') ? '!=' : '==';
			const rhs = eqMatch[2];
			return op === '==' ? lhs === rhs : lhs !== rhs;
		}

		// Try `value contains "substring"`
		const containsMatch = text.match(/^(.+?)\s+contains\s+["'](.+?)["']$/i);
		if (containsMatch) {
			return containsMatch[1].trim().toLowerCase().includes(containsMatch[2].toLowerCase());
		}

		// Try `value startsWith "prefix"` / `value endsWith "suffix"`
		const startsMatch = text.match(/^(.+?)\s+startsWith\s+["'](.+?)["']$/i);
		if (startsMatch) {
			return startsMatch[1].trim().toLowerCase().startsWith(startsMatch[2].toLowerCase());
		}
		const endsMatch = text.match(/^(.+?)\s+endsWith\s+["'](.+?)["']$/i);
		if (endsMatch) {
			return endsMatch[1].trim().toLowerCase().endsWith(endsMatch[2].toLowerCase());
		}

		// Try `value matches /regex/`
		const regexMatch = text.match(/^(.+?)\s+matches\s+\/(.+?)\/$/i);
		if (regexMatch) {
			try {
				return new RegExp(regexMatch[2], 'i').test(regexMatch[1].trim());
			} catch {
				return false;
			}
		}

		// Cannot parse — defer to LLM (return false = no deterministic decision,
		// caller falls through to LLM evaluation)
		return false;
	}

	// --------------------------------------------------------------------------------------------
	// Helper Methods
	// --------------------------------------------------------------------------------------------

	private _getNextNodes(nodeId: string, adj: Map<string, { targetId: string; fromPort?: string }[]>): string[] {
		const connections = adj.get(nodeId) ?? [];
		return connections.map(c => c.targetId);
	}

	/**
	 * v30: AskUser port-aware routing. Unlike `_getNextNodes` which
	 * returns ALL downstream nodes unconditionally, this method only
	 * returns nodes whose edge's `fromPort` matches one of the selected
	 * option indices (formatted as 'option-N'). This prevents
	 * "暂不提交" / "取消操作" selections from accidentally flowing into
	 * the git-commit agent branch.
	 *
	 * When no edges carry a matching fromPort, callers should fall back
	 * to `_getNextNodes` for backward compatibility with old workflows
	 * that don't have port-specific edges behind AskUser nodes.
	 */
	private _getAskUserNextNodes(
		nodeId: string,
		adj: Map<string, { targetId: string; fromPort?: string }[]>,
		selectedIndices: number[],
	): string[] {
		const connections = adj.get(nodeId) ?? [];
		const ports = new Set(selectedIndices.map(i => `option-${i}`));
		return connections
			.filter(c => c.fromPort && ports.has(c.fromPort))
			.map(c => c.targetId);
	}

	// ─── v6: Variable collection helpers ───────────────────────────────────

	/**
	 * Scan all agent/prompt/skill/tool nodes in the workflow for `{{variable}}` patterns
	 * in their `data.prompt`, `data.skillArgs` (Record<string,string>), or
	 * `data.toolParams` (Record<string,string>) fields. Returns deduplicated
	 * variable names with optional default values. Built-in variables
	 * (`{{input}}`, `{{$prev.output}}`, etc.) are skipped — they're auto-resolved
	 * by the runtime value map.
	 */
	private static _collectTemplateVariables(workflow: IStoredWorkflow): Array<{ name: string; defaultValue?: string }> {
		// 委托给纯函数 collectWorkflowVariables（templateUtils.ts），与 composer 参数表单
		// 共用同一实现，避免前后端变量列表漂移。
		return collectWorkflowVariables(workflow.nodes);
	}

	/**
	 * Substitute variable values into all node `data.prompt`, `data.skillArgs`,
	 * and `data.toolParams` fields in the workflow graph (in-place mutation).
	 */
	private static _substituteVariables(workflow: IStoredWorkflow, values: Record<string, string>): void {
		const nodes = workflow.nodes;
		if (!nodes) { return; }

		for (const node of nodes) {
			const data = node.data as Record<string, unknown>;
			if (!data) { continue; }

			// Substitute in prompt (string).
			if (typeof data.prompt === 'string') {
				data.prompt = WorkflowExecutionService._replaceVariables(data.prompt, values);
			}
			// Substitute in skillArgs values (Record<string, string>).
			if (data.skillArgs && typeof data.skillArgs === 'object') {
				const sa = data.skillArgs as Record<string, string>;
				for (const k of Object.keys(sa)) {
					if (typeof sa[k] === 'string') {
						sa[k] = WorkflowExecutionService._replaceVariables(sa[k], values);
					}
				}
			}
			// Substitute in toolParams values (Record<string, string>).
			if (data.toolParams && typeof data.toolParams === 'object') {
				const tp = data.toolParams as Record<string, string>;
				for (const k of Object.keys(tp)) {
					if (typeof tp[k] === 'string') {
						tp[k] = WorkflowExecutionService._replaceVariables(tp[k], values);
					}
				}
			}
		}
	}

	private static _replaceVariables(template: string, values: Record<string, string>): string {
		// v23: delegate to the shared `substituteHostVariables` so both the
		// pre-execution pass and the per-node pass use the SAME regex
		// (which now supports `.output` and other `.field` suffixes).
		// Previously this inlined `/\{\{(\$?\w+)\}\}/g` which silently
		// failed on `{{$prev.output}}` because `\w+` doesn't match `.`.
		return substituteHostVariables(template, values);
	}

	// ─── v23: per-node upstream variable substitution ───────────────────

	/**
	 * Build an `upstreamOutputs` map by reading the final `output` field of
	 * every node in `executionState.nodeStates` that has finished (Completed,
	 * Failed, Skipped, or Cancelled — anything with a terminal status).
	 *
	 * Why include all finished nodes, not just immediate topological
	 * predecessors: workflow authors usually write prompts referencing
	 * upstream nodes by their stable ReactFlow `node.id` (e.g.
	 * `{{printerNode.output}}`), and that id can be several hops back. We
	 * intentionally don't enforce a graph-walk because:
	 *   1. The graph adjacency isn't always available inside this method
	 *      (we'd have to thread `adj: Map<...>` from the caller, which is
	 *      fragile — `adj` is built per-execution and is per-direction).
	 *   2. The value map is keyed by `nodeId`, so as long as the user
	 *      references a node by its id, lookup works regardless of topology.
	 *   3. Failed / cancelled nodes contribute empty strings (with a
	 *      one-line warn) so the substitution result is still a coherent
	 *      prompt instead of leaving a `{{nodeId.output}}` literal.
	 *
	 * For the `$prev` alias we use the most recently *finished* node (by
	 * its `endTime`), which is what the workflow author intuitively means
	 * by "the previous node's output" — typically the immediate predecessor
	 * in the run order.
	 */
	private _collectUpstreamOutputs(
		executionState: IWorkflowExecutionState,
	): Record<string, string> {
		const upstream: Record<string, string> = {};
		let lastEndTime: number | undefined;
		let lastId: string | undefined;
		let lastOut: string | undefined;
		for (const [nodeId, state] of executionState.nodeStates.entries()) {
			const isTerminal = state.status === WorkflowNodeExecutionStatus.Completed
				|| state.status === WorkflowNodeExecutionStatus.Failed
				|| state.status === WorkflowNodeExecutionStatus.Skipped
				|| state.status === WorkflowNodeExecutionStatus.Cancelled;
			if (!isTerminal) { continue; }
			upstream[nodeId] = state.output ?? '';
			const end = state.endTime ? Date.parse(state.endTime) : undefined;
			if (end !== undefined && (lastEndTime === undefined || end > lastEndTime)) {
				lastEndTime = end;
				lastId = nodeId;
				lastOut = state.output ?? '';
			}
		}
		// `$prev` = the most recently finished node. We do NOT inject it
		// into the map here — `buildRuntimeValueMap` reads `args.upstreamOutputs`
		// and inserts the alias itself (it picks the last key in the
		// object iteration, which roughly matches "most recently added"
		// in modern V8 for string keys). Passing an explicit lastId as a
		// synthetic key is brittle, so we leave the alias logic to the
		// helper. If authors complain `$prev` resolves to the wrong node
		// we can revisit.
		if (lastId && lastOut !== undefined) {
			this.logService.debug(
				`[WorkflowExecution] upstream: last finished node = ${lastId} ` +
				`(endTime=${new Date(lastEndTime!).toISOString()}, outputLen=${lastOut.length})`,
			);
		}
		return upstream;
	}

	/**
	 * Per-node substitution pass. Called at the start of `_executeNodeRecursive`,
	 * *after* the node is marked Running but *before* any of the per-type
	 * executors run. Builds a runtime value map from the execution context,
	 * the node's own `data.variables` overrides, and the `upstreamOutputs` of
	 * every previously-finished node; then mutates `node.data.prompt` (and
	 * `node.data.skillArgs[*]` / `node.data.toolParams[*]` if present) in place
	 * with the substituted strings.
	 *
	 * Why mutate: the four per-type executors (`_executeTaskNode`,
	 * `_executeAgentNode`, `_executeSkillNode`, `_executeToolNode`) all
	 * read `data.prompt` directly, so in-place mutation guarantees the
	 * substituted prompt reaches them without plumbing a return value
	 * through 4 call sites.
	 *
	 * Why this is safe: the pre-execution `_substituteVariables` pass has
	 * already replaced user-supplied variables; the only references that
	 * survive that pass are `{{$prev.output}}` / `{{$prev}}` / `{{nodeId.output}}`
	 * (which were undefined at pre-execution time because no upstream
	 * nodes had finished). So this second pass is a strict superset and
	 * no variable gets double-substituted.
	 */
	private _substituteUpstreamVariables(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
	): void {
		const data = node.data as Record<string, unknown> | undefined;
		if (!data) { return; }
		// Start / End / AskUser / control-flow nodes have no prompt to
		// substitute; short-circuit to avoid logging "0 substitutions"
		// noise.
		if (node.type === WorkflowNodeType.Start || node.type === WorkflowNodeType.End) {
			return;
		}

		const upstreamOutputs = this._collectUpstreamOutputs(executionState);
		const values = buildRuntimeValueMap({
			context: executionState.context as Record<string, unknown>,
			nodeVariables: (data.variables as Record<string, string> | undefined) ?? undefined,
			upstreamOutputs,
			workflowName: workflow.name || '',
		});

		let didReplace = false;
		if (typeof data.prompt === 'string' && data.prompt.includes('{{')) {
			const next = substituteHostVariables(data.prompt, values);
			if (next !== data.prompt) {
				this.logService.info(
					`[WorkflowExecution] v23 substituted upstream vars in node ${node.id} prompt ` +
					`(len ${data.prompt.length} → ${next.length})`,
				);
				data.prompt = next;
				didReplace = true;
			}
		}
		// Also substitute in skillArgs (Record<string, string>) — the
		// values may contain `{{$prev.output}}` references too.
		if (data.skillArgs && typeof data.skillArgs === 'object') {
			const sa = data.skillArgs as Record<string, string>;
			for (const k of Object.keys(sa)) {
				if (typeof sa[k] === 'string' && sa[k].includes('{{')) {
					const next = substituteHostVariables(sa[k], values);
					if (next !== sa[k]) {
						sa[k] = next;
						didReplace = true;
					}
				}
			}
		}
		// And toolParams (Record<string, string | unknown>) — we only
		// touch string values, leaving complex object params alone.
		if (data.toolParams && typeof data.toolParams === 'object') {
			const tp = data.toolParams as Record<string, unknown>;
			for (const k of Object.keys(tp)) {
				if (typeof tp[k] === 'string' && (tp[k] as string).includes('{{')) {
					const next = substituteHostVariables(tp[k] as string, values);
					if (next !== tp[k]) {
						tp[k] = next;
						didReplace = true;
					}
				}
			}
		}
		if (didReplace) {
			this.logService.debug(
				`[WorkflowExecution] v23 node ${node.id} (${node.type}) prompt/args substituted; ` +
				`upstream keys: [${Object.keys(upstreamOutputs).join(', ')}]`,
			);
		}
	}

	// ─── v6: submitWorkflowVariables ────────────────────────────────────────

	async submitWorkflowVariables(executionId: string, values: Record<string, string>): Promise<void> {
		this.logService.info(`[WorkflowExecution] submitWorkflowVariables: executionId=${executionId}, keys=${Object.keys(values).join(',')}`);
		const resolver = this._variableResolvers.get(executionId);
		if (!resolver) {
			throw new Error(`No pending variable collection for execution: ${executionId}`);
		}
		this._variableResolvers.delete(executionId);
		resolver(values);
	}

	// ─── v21: Active stream tracking for cancel ──────────────────────────

	/**
	 * Abort the in-flight chat stream for a given execution, if any. Called
	 * by `cancelExecution` so the node executor's `await sendMessage(...)`
	 * returns within a few ms instead of waiting for the LLM to finish its
	 * full response. Idempotent — safe to call when no stream is active.
	 */
	private _abortActiveStream(executionId: string): void {
		const stream = this._activeStreams.get(executionId);
		if (!stream) { return; }
		this._activeStreams.delete(executionId);
		this.logService.info(
			`[WorkflowExecution] aborting active stream for executionId=${executionId} ` +
			`(agentId=${stream.agentId}, agentSessionId=${stream.agentSessionId || '<none>'}, nodeId=${stream.nodeId})`,
		);
		try {
			// agentChatService stores the stream under `${agentId}::${agentSessionId}`
			// when sessionId is set, or just `${agentId}` when not. cancelStream
			// handles both shapes; pass undefined sessionId to use the latter form.
			if (stream.agentSessionId) {
				this.agentChatService.cancelStream(stream.agentId, stream.agentSessionId);
			} else {
				this.agentChatService.cancelStream(stream.agentId);
			}
		} catch (err) {
			this.logService.warn(
				`[WorkflowExecution] cancelStream failed (continuing with status-only cancel): ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	/**
	 * Run a node's `agentChatService.sendMessage(...)` call with the execution's
	 * active stream registered so `cancelExecution` can abort it. Throws
	 * `WorkflowCancelledError` if the execution has already been cancelled
	 * (defense in depth — combined with the abort in `_abortActiveStream`,
	 * the node executor returns within milliseconds of a cancel click).
	 *
	 * Use this from every node executor that calls `sendMessage` (task / agent
	 * / skill / tool / ifElse). The `try/finally` guarantees the stream entry
	 * is removed when sendMessage returns, regardless of success or error.
	 */
	private async _sendAndTrackStream(
		executionState: IWorkflowExecutionState,
		node: WorkflowGraphNode,
		agentId: string,
		prompt: string,
		agentSessionId: string | undefined,
		onDelta: (delta: any) => void,
		extraOptions?: { systemPrompt?: string },
		timeoutConfig?: { runTimeoutMs?: number; idleTimeoutMs?: number },
	): Promise<any> {
		if (executionState.status === WorkflowExecutionStatus.Cancelled) {
			throw new Error(`Workflow execution ${executionState.executionId} was cancelled`);
		}

		// v31: trim history if maxHistoryMessages is set.
		if (executionState.options?.maxHistoryMessages && agentSessionId) {
			const history = await this.agentChatService.getHistory(agentId, agentSessionId);
			if (history.length > executionState.options.maxHistoryMessages) {
				const excess = history.length - executionState.options.maxHistoryMessages;
				await this.agentChatService.clearHistory(agentId, agentSessionId);
				const kept = history.slice(-executionState.options.maxHistoryMessages);
				for (const msg of kept) {
					await this.agentChatService.appendMessage(agentId, msg);
				}
				this.logService.info(
					`[WorkflowExecution] Trimmed ${excess} old messages from session ${agentSessionId} ` +
					`for node ${node.id} (kept ${kept.length})`,
				);
			}
		}

		this._activeStreams.set(executionState.executionId, {
			agentId,
			agentSessionId: agentSessionId ?? '',
			nodeId: node.id,
		});

		let idleHandle: any;

	try {
		// v31/v32: timeout protection via Promise.race.
		const runTimeoutMs = timeoutConfig?.runTimeoutMs ?? 300_000; // default 5 min
		// v40: default idle timeout 120s — if no delta received within 120s,
		// the stream is likely stuck (e.g. model call hanging, executeTurn
		// blocked on an await). Without this, the UI freezes indefinitely.
		const idleTimeoutMsVal = timeoutConfig?.idleTimeoutMs ?? 120_000;

			const promises: Promise<any>[] = [];

			// Set up delta callback (may be wrapped with idle reset)
			let deltaCallback = onDelta;

			if (idleTimeoutMsVal && idleTimeoutMsVal > 0) {
				let idleReject: ((reason: any) => void) | undefined;
				const idleTimeoutPromise = new Promise<never>((_, reject) => {
					idleReject = reject;
				});
				promises.push(idleTimeoutPromise);

				const resetIdle = () => {
					if (idleHandle) { clearTimeout(idleHandle); }
					idleHandle = setTimeout(() => {
						try {
							if (agentSessionId) {
								this.agentChatService.cancelStream(agentId, agentSessionId);
							} else {
								this.agentChatService.cancelStream(agentId);
							}
						} catch { /* best effort */ }
						idleReject?.(new Error(
							`Node ${node.id} timed out after ${idleTimeoutMsVal}ms (idle timeout — ` +
							`no token received for ${idleTimeoutMsVal}ms). The stream has been cancelled.`,
						));
					}, idleTimeoutMsVal);
				};

				deltaCallback = (delta: any) => {
					resetIdle();
					onDelta(delta);
				};

				resetIdle();
			}

			// ── Run timeout (total wall-clock) ───────────────────────────
			if (runTimeoutMs > 0) {
				promises.push(new Promise<never>((_, reject) => {
					setTimeout(() => {
						try {
							if (agentSessionId) {
								this.agentChatService.cancelStream(agentId, agentSessionId);
							} else {
								this.agentChatService.cancelStream(agentId);
							}
						} catch { /* best effort */ }
						reject(new Error(
							`Node ${node.id} timed out after ${runTimeoutMs}ms (run timeout). ` +
							`The stream has been cancelled.`,
						));
					}, runTimeoutMs);
				}));
			}

			// Create sendPromise with (possibly wrapped) deltaCallback
			// v39: forward node-level provider/model config into sendMessage
			// options so the global active model selection is overridden for
			// this specific workflow node.
			const nodeData = node.data as Record<string, any>;
			const agentConfig = nodeData?.agentConfig as { providerId?: string; modelId?: string } | undefined;
			this.logService.info(`[WorkflowExecution] _sendAndTrackStream: calling sendMessage (agentId=${agentId}, promptLen=${prompt.length}, sessionId=${agentSessionId ?? 'none'})`);
			const t0_send = Date.now();
			const sendPromise = this.agentChatService.sendMessage(
				agentId,
				prompt,
				{
					workspaceId: undefined,
					agentSessionId,
					systemPrompt: extraOptions?.systemPrompt,
					providerId: agentConfig?.providerId,
					model: agentConfig?.modelId,
				},
				deltaCallback,
			);
			promises.push(sendPromise);

			this.logService.info(`[WorkflowExecution] _sendAndTrackStream: awaiting Promise.race (${promises.length} promises, node=${node.id})`);
			const result = await Promise.race(promises);
			this.logService.info(`[WorkflowExecution] _sendAndTrackStream: Promise.race resolved in ${Date.now() - t0_send}ms (node=${node.id})`);

			return result;
		} finally {
			const cur = this._activeStreams.get(executionState.executionId);
			if (cur && cur.nodeId === node.id) {
				this._activeStreams.delete(executionState.executionId);
			}
			if (idleHandle) {
				clearTimeout(idleHandle);
			}
		}

	}

	/**
	 * v32: Save a checkpoint snapshot of the current execution state.
	 * Checkpoints are saved after each node completes (success or failure)
	 * to `{workspace}/.sarosworkspace/checkpoints/{executionId}.json`.
	 * This enables resumption from the last checkpoint after a crash.
	 */
		private async _saveCheckpoint(executionState: IWorkflowExecutionState): Promise<void> {
		try {
			const nodeStates: Record<string, any> = {};
			for (const [nodeId, ns] of executionState.nodeStates.entries()) {
				nodeStates[nodeId] = {
					status: ns.status,
					output: ns.output ?? null,
					error: ns.error ?? null,
					startTime: ns.startTime ?? null,
					endTime: ns.endTime ?? null,
				};
			}
			// Sanitize context to avoid JSON.stringify errors (functions, circular refs, etc.)
			const sanitizedContext: Record<string, string> = {};
			for (const [key, val] of Object.entries(executionState.context)) {
				try {
					const json = JSON.stringify(val);
					sanitizedContext[key] = json;
				} catch {
					sanitizedContext[key] = String(val);
				}
			}
			const checkpoint = {
				executionId: executionState.executionId,
				workflowId: executionState.workflowId,
				status: executionState.status,
				timestamp: new Date().toISOString(),
				nodeStates,
				context: sanitizedContext,
				sharedMemory: [...(executionState.sharedMemory?.entries() ?? [])],
			};

			const workspaces = this.workspaceRegistry.getWorkspaces();
			const activeWorkspace = workspaces.find(w => w.isActive);
			if (activeWorkspace?.path) {
				const checkpointsDir = URI.joinPath(
					URI.file(activeWorkspace.path),
					'.sarosworkspace',
					'checkpoints',
				);
				await this.fileService.createFolder(checkpointsDir);
				const fileUri = URI.joinPath(checkpointsDir, `${executionState.executionId}.json`);
				await this.fileService.writeFile(
					fileUri,
					VSBuffer.fromString(JSON.stringify(checkpoint, null, 2)),
				);
			}
		} catch (err) {
			this.logService.warn(
				`[WorkflowExecution] Checkpoint save failed: ` +
				`${err instanceof Error ? err.message : err}`,
			);
		}
	}
}
