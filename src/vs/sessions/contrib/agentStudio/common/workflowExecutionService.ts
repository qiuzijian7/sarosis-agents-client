/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import type { IStoredWorkflow, WorkflowNodeType, WorkflowGraphNode, WorkflowGraphConnection } from './workflowStorage.js';

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
