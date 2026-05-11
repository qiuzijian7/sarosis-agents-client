/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Re-export types from sessions/common/ for backward compatibility
export {
	EmployeeStatus,
	ConnectionType,
	DelegationStatus,
	TaskBoardStatus,
	TaskSource,
	Employee,
	EmployeeSkill,
	Workspace,
	WorkspaceLayout,
	WorkspaceNode,
	WorkspaceEdge,
	Connection,
	Delegation,
	ChatMessage,
	ToolCall,
	AgentStudioSession,
	TaskBoardRecord,
} from '../../../common/agentStudioTypes.js';
