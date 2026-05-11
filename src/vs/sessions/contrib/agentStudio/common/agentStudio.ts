/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Re-export service interfaces from sessions/common/ for backward compatibility
export {
	IAgentStudioService,
	IAgentChatService,
	IChatStreamDelta,
	IChatSendOptions,
	IAutoPlanResult,
	IAgentDelegationService,
	IAgentTaskBoardService,
} from '../../../common/agentStudioService.js';
