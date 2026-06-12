/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

export const IWorkflowExecutionService = createDecorator<IWorkflowExecutionService>('workflowExecutionService');

// ------------------------------------------------------------------------------------------------
// Workflow Execution Service Interface
// ------------------------------------------------------------------------------------------------

export const enum WorkflowExecutionStatus {
	Idle = 'idle',
	Running = 'running',
	Paused = 'paused', // Waiting for user input (AskUser node)
	Completed = 'completed',
	Failed = 'failed',
	Cancelled = 'cancelled',
}

export const enum WorkflowNodeExecutionStatus {
	Pending = 'pending',
	Running = 'running',
	Completed = 'completed',
	Failed = 'failed',
	Skipped = 'skipped',
}

export interface IWorkflowNodeExecutionState {
	nodeId: string;
	status: WorkflowNodeExecutionStatus;
	startTime?: string;
	endTime?: string;
	error?: string;
	output?: string;
}

export interface IWorkflowExecutionState {
	executionId: string;
	workflowId: string;
	status: WorkflowExecutionStatus;
	currentNodeId?: string;
	nodeStates: Map<string, IWorkflowNodeExecutionState>;
	startTime?: string;
	endTime?: string;
	error?: string;
	context: Record<string, unknown>; // Data passed between nodes
	breakpoints?: Set<string>; // Node IDs with breakpoints (for P2 debug)
}

export interface IWorkflowExecutionService {
	readonly _serviceBrand: undefined;

	/** Execution state changes */
	readonly onDidExecutionStatusChange: Event<IWorkflowExecutionState>;
	/** Node execution state changes */
	readonly onDidNodeExecutionStatusChange: Event<{ executionId: string; nodeState: IWorkflowNodeExecutionState }>;
	/** Breakpoint changes */
	readonly onDidChangeBreakpoints: Event<{ executionId: string; nodeIds: string[] }>;
	/** Fine-grained trace events for chat panel rendering (P4) */
	readonly onDidExecutionTrace: Event<IWorkflowTraceEvent>;

	/**
	 * Execute a workflow.
	 * @param workflowId The workflow ID to execute
	 * @param options Execution options
	 * @returns Execution ID
	 */
	executeWorkflow(workflowId: string, options?: IWorkflowExecutionOptions): Promise<string>;

	/**
	 * Pause execution (for AskUser node or breakpoint).
	 * Returns a promise that resolves with user input when execution is resumed.
	 */
	pauseExecution(executionId: string, nodeId: string, question: string, options: IAskUserOption[]): Promise<string | string[]>;

	/**
	 * Resume execution after user input.
	 */
	resumeExecution(executionId: string, userInput: string | string[]): Promise<void>;

	/**
	 * Cancel execution.
	 */
	cancelExecution(executionId: string): Promise<void>;

	/**
	 * Get execution state.
	 */
	getExecutionState(executionId: string): IWorkflowExecutionState | undefined;

	/**
	 * Get all active executions.
	 */
	getActiveExecutions(): IWorkflowExecutionState[];

	/**
	 * Get the owner-agent chat session created for this execution (P4 chat trace).
	 * Returns undefined if the workflow has no agentId or session creation failed.
	 */
	getExecutionSession(executionId: string): IWorkflowSessionInfo | undefined;

	/**
	 * Set breakpoint on a node (P2 debug feature).
	 */
	setBreakpoint(executionId: string, nodeId: string): void;

	/**
	 * Clear breakpoint on a node.
	 */
	clearBreakpoint(executionId: string, nodeId: string): void;

	/**
	 * Get all breakpoints for an execution.
	 */
	getBreakpoints(executionId: string): string[];

	// v5a: workflow-level breakpoints (persist across runs).

	/**
	 * Set a breakpoint on a workflow node. Persists to the workflow JSON so
	 * it applies to the next run. Pass `executionId` to also apply it to the
	 * running execution (if any) for immediate effect.
	 */
	setWorkflowBreakpoint(workflowId: string, nodeId: string, executionId?: string): Promise<void>;

	/**
	 * Clear a workflow-level breakpoint.
	 */
	clearWorkflowBreakpoint(workflowId: string, nodeId: string, executionId?: string): Promise<void>;

	/**
	 * Get all workflow-level breakpoints (persisted).
	 */
	getWorkflowBreakpoints(workflowId: string): Promise<string[]>;

	/**
	 * v6: Submit variable values collected before execution starts.
	 * Called by the webview after the user fills in the variable collection card.
	 */
	submitWorkflowVariables(executionId: string, values: Record<string, string>): Promise<void>;
}

export interface IWorkflowExecutionOptions {
	/** Initial context data */
	context?: Record<string, unknown>;
	/** Agent ID to use for agent nodes (defaults to workflow's agentId) */
	agentId?: string;
}

export interface IAskUserOption {
	label: string;
	description?: string;
}

// ─── Trace Event: forwarded to webview so the workflow owner agent's chat
//     can render node execution as subagent cards + tool call list. ───

/** Per-node execution trace event (one per agent node in the workflow). */
export type IWorkflowTraceEvent =
	/** A new subagent (workflow node) starts. */
	| { kind: 'subagent_start'; executionId: string; workflowAgentId: string; sessionId: string;
		nodeId: string; nodeName: string; nodeType: string; task: string }
	/** Streaming delta from the agent model (text/thinking/tool_start/tool_args/tool_result). */
	| { kind: 'delta'; executionId: string; sessionId: string; nodeId: string; delta: unknown }
	/** Subagent finishes successfully. */
	| { kind: 'subagent_end'; executionId: string; sessionId: string; nodeId: string;
		status: 'done' | 'error'; output?: string; error?: string }
	/** AskUser node wants user input — webview should render an interactive card. */
	| { kind: 'ask_user'; executionId: string; sessionId: string; nodeId: string; nodeName: string;
		question: string; options: IAskUserOption[]; multiSelect: boolean }
	/** AskUser node has been answered (or cancelled) — webview flips card to "answered" state. */
	| { kind: 'ask_user_end'; executionId: string; sessionId: string; nodeId: string;
		status: 'answered' | 'cancelled' | 'expired'; selection?: string | string[] }
	/** v6: Workflow needs variable values before execution. Webview renders text inputs for each. */
	| { kind: 'collect_variables'; executionId: string; sessionId: string;
		variables: Array<{ name: string; defaultValue?: string }> }
	/** v6: Variable collection resolved — webview flips card to "submitted" state. */
	| { kind: 'collect_variables_end'; executionId: string; sessionId: string;
		status: 'submitted' | 'skipped' }
	/** Whole execution finished — owner chat should commit final assistant message. */
	| { kind: 'execution_end'; executionId: string; sessionId: string; status: 'completed' | 'failed' | 'cancelled' };

/** Information about the new chat session created for a workflow run. */
export interface IWorkflowSessionInfo {
	workflowAgentId: string;
	sessionId: string;
	workflowName: string;
}
