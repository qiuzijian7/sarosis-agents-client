/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Re-export service interfaces from sessions/common/ for backward compatibility

// Value exports (the decorators for dependency injection)
export {
	IAgentStudioService,
	IAgentChatService,
	IAgentDelegationService,
	IAgentTaskBoardService,
	ITaskOrchestrationService,
	IConfigHtmlService,
} from '../../../common/agentStudioService.js';

// Type-only exports (interfaces)
export type {
	IChatStreamDelta,
	IChatSendOptions,
	IAutoPlanResult,
	OrchestrationTaskAction,
	IConfigMdCommand,
	IConfigMdPatchOp,
	IConfigMdState,
	ConfigMdChangeOrigin,
} from '../../../common/agentStudioService.js';
