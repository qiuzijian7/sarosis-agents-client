/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Re-export types from sessions/common/ for backward compatibility

// Value exports (enums, classes) - these exist at runtime
export {
	AgentStudioSession,
	AgentType,
	ConnectionType,
	DelegationStatus,
	EmployeeStatus,
	TaskBoardStatus,
	TaskSource,
	OrchestrationPlanStatus,
	PlanTaskStatus,
} from '../../../common/agentStudioTypes.js';

// Type-only exports (interfaces) - erased at runtime, must use 'export type'
export type {
	AgentBootstrapTemplates,
	AgentExportData,
	ChatMessage,
	Connection,
	Delegation,
	Employee,
	TaskBoardRecord,
	ToolCall,
	Workspace,
	WorkspaceEdge,
	WorkspaceLayout,
	WorkspaceNode,
	OrchestrationPlan,
	PlanTask,
} from '../../../common/agentStudioTypes.js';
