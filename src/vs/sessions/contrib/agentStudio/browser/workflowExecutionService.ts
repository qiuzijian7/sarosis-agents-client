/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { IAgentChatService } from '../common/agentStudio.js';
import { IAgentOSService } from '../common/agentOS.js';
import { IWorkflowStorageService, IStoredWorkflow, WorkflowNodeType, WorkflowGraphNode, WorkflowGraphConnection } from '../common/workflowStorage.js';
import type { IWorkflowExecutionService, IWorkflowExecutionState, IWorkflowExecutionOptions, WorkflowExecutionStatus, IWorkflowNodeExecutionState, WorkflowNodeExecutionStatus, IAskUserOption } from '../common/workflowExecutionService.js';

const DATA_FILE_WORKFLOW_EXECUTIONS = 'workflow-executions.json';

export class WorkflowExecutionService extends Disposable implements IWorkflowExecutionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidExecutionStatusChange = this._register(new Emitter<IWorkflowExecutionState>());
	readonly onDidExecutionStatusChange: Event<IWorkflowExecutionState> = this._onDidExecutionStatusChange.event;

	private readonly _onDidNodeExecutionStatusChange = this._register(new Emitter<{ executionId: string; nodeState: IWorkflowNodeExecutionState }>());
	readonly onDidNodeExecutionStatusChange: Event<{ executionId: string; nodeState: IWorkflowNodeExecutionState }> = this._onDidNodeExecutionStatusChange.event;

	private readonly _onDidChangeBreakpoints = this._register(new Emitter<{ executionId: string; nodeIds: string[] }>());
	readonly onDidChangeBreakpoints: Event<{ executionId: string; nodeIds: string[] }> = this._onDidChangeBreakpoints.event;

	private _executions = new Map<string, IWorkflowExecutionState>();
	private _pauseResolvers = new Map<string, (value: string | string[]) => void>();
	private _dataUri: URI | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IAgentChatService private readonly agentChatService: IAgentChatService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
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

		// Create execution state
		const executionId = `wf_exec_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
		const executionState: IWorkflowExecutionState = {
			executionId,
			workflowId,
			status: WorkflowExecutionStatus.Running,
			nodeStates: new Map<string, IWorkflowNodeExecutionState>(),
			startTime: new Date().toISOString(),
			context: options?.context ?? {},
		};

		this._executions.set(executionId, executionState);
		this._onDidExecutionStatusChange.fire(executionState);

		// Start execution (fire-and-forget)
		this._executeWorkflowAsync(executionState, workflow, options).catch(err => {
			this.logService.error(`[WorkflowExecution] Execution ${executionId} failed:`, err);
			executionState.status = WorkflowExecutionStatus.Failed;
			executionState.error = err instanceof Error ? err.message : String(err);
			executionState.endTime = new Date().toISOString();
			this._onDidExecutionStatusChange.fire(executionState);
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
	}

	getExecutionState(executionId: string): IWorkflowExecutionState | undefined {
		return this._executions.get(executionId);
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
		const taskDescription = (data.label as string) || node.name || 'Unknown Task';

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
			// 将提示作为用户消息追加到聊天历史
			this.logService.info(`[WorkflowExecution] Appending prompt to agent ${agentId}: ${promptText.substring(0, 100)}`);
			await this.agentChatService.appendMessage(agentId, {
				id: `prompt_${node.id}_${Date.now()}`,
				role: 'user',
				content: promptText,
				timestamp: new Date().toISOString(),
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

		if (!agentId) {
			throw new Error(`Agent node ${node.id} has no agentId`);
		}

		try {
			// 使用指定 agent 执行（发送一个继续的提示）
			const continuePrompt = (data.prompt as string) || '请继续执行工作流任务';
			this.logService.info(`[WorkflowExecution] Sending to agent ${agentId}: ${continuePrompt}`);
			
			const message = await this.agentChatService.sendMessage(
				agentId,
				continuePrompt,
				{ workspaceId: undefined, agentSessionId: undefined },
				(delta) => {
					this.logService.debug(`[WorkflowExecution] Agent ${node.id} delta: ${delta.content?.substring(0, 50)}`);
				},
			);

			// 记录执行结果
			const nodeState = executionState.nodeStates.get(node.id);
			if (nodeState) {
				nodeState.output = message.content || '';
			}

			this.logService.info(`[WorkflowExecution] Agent ${node.id} completed`);
		} catch (err) {
			this.logService.error(`[WorkflowExecution] Agent ${node.id} failed:`, err);
			throw err;
		}
	}

	private async _executeAskUserNode(
		executionState: IWorkflowExecutionState,
		workflow: IStoredWorkflow,
		node: WorkflowGraphNode,
		adj: Map<string, { targetId: string; fromPort?: string }[]>,
	): Promise<string | string[]> {
		this.logService.info(`[WorkflowExecution] Executing AskUser node: ${node.id}`);
		const data = node.data ?? {};
		const question = (data.question as string) || '请提供更多输入';
		const options = (data.options as IAskUserOption[]) || [];

		try {
			// 暂停执行并等待用户输入
			this.logService.info(`[WorkflowExecution] Pausing for user input: ${question}`);
			const userInput = await this.pauseExecution(
				executionState.executionId,
				node.id,
				question,
				options,
			);

			this.logService.info(`[WorkflowExecution] User input received: ${JSON.stringify(userInput)}`);
			return userInput;
		} catch (err) {
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
		const branches = (data.branches as Array<{ id: string; label: string; condition: string }>) ?? [];

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

	private _getDataUri(): URI {
		if (!this._dataUri) {
			const customPath = this.configurationService.getValue<string>('agentStudio.dataPath');
			if (customPath) {
				this._dataUri = URI.file(customPath);
			} else {
				this._dataUri = URI.joinPath((this.environmentService as any).userHome, '.agent-studio', 'data');
			}
		}
		return this._dataUri;
	}
}
