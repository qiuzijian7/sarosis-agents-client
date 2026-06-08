/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Re-export types from sessions/common/ for backward compatibility

// Value exports (enums, classes) - these exist at runtime
export {
	AgentStudioSession,
	AgentType,
	AgentTarget,
	AgentSource,
	ConnectionType,
	DelegationStatus,
	AgentStatus,
	SandboxMode,
	TaskBoardStatus,
	TaskSource,
	OrchestrationPlanStatus,
	PlanTaskStatus,
	DEFAULT_BOARD_ID,
} from '../../../common/agentStudioTypes.js';

// Function exports - utility helpers
export {
	getPrimaryModel,
	getModelChain,
} from '../../../common/agentStudioTypes.js';

// Type-only exports (interfaces) - erased at runtime, must use 'export type'
export type {
	Agent,
	AgentBinding,
	AgentMemoryConfig,
	AgentBootstrapTemplates,
	AgentExportData,
	ChatMessage,
	Connection,
	Delegation,
	Employee,
	IAgentHandOff,
	IAgentHooks,
	IAgentHookEntry,
	IAgentLimits,
	IAgentToolHookEntry,
	IAgentVisibility,
	IModelChain,
	ISkillDirective,
	ModelSpec,
	TaskBoardRecord,
	TaskBoard,
	TaskAttachment,
	ToolCall,
	RelatedFolder,
	Workspace,
	WorkspaceEdge,
	WorkspaceLayout,
	WorkspaceNode,
	OrchestrationPlan,
	PlanTask,
} from '../../../common/agentStudioTypes.js';
