/*---------------------------------------------------------------------------------------------
 *  Agent Studio - Main Window Integration
 *  Registers Agent Studio services for use in the main workbench window (AuxiliaryBar/Chat position).
 *  This replaces the Sessions window approach: Agent Studio is now embedded directly.
 *--------------------------------------------------------------------------------------------*/

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize } from '../../../../nls.js';

import { IAgentStudioService, IAgentChatService, IAgentDelegationService, IAgentTaskBoardService } from '../../../../sessions/contrib/agentStudio/common/agentStudio.js';
import { AgentStudioService } from '../../../../sessions/contrib/agentStudio/browser/agentStudioService.js';
import { AgentChatService } from '../../../../sessions/contrib/agentStudio/browser/agentChatService.js';
import { AgentDelegationService } from '../../../../sessions/contrib/agentStudio/browser/agentDelegationService.js';
import { AgentTaskBoardService } from '../../../../sessions/contrib/agentStudio/browser/agentTaskBoardService.js';
import {
	AGENT_STUDIO_ENABLED_SETTING,
	AGENT_STUDIO_KNOT_TOKEN_SETTING,
	AGENT_STUDIO_KNOT_AGENT_ID_SETTING,
	AGENT_STUDIO_KNOT_BASE_URL_SETTING,
	AGENT_STUDIO_DATA_PATH_SETTING,
} from '../../../../sessions/contrib/agentStudio/common/constants.js';

// ─── Configuration ──────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'agentStudio',
	properties: {
		[AGENT_STUDIO_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('agentStudio.enabled', "Enable Agent Studio in the Chat panel position."),
		},
		[AGENT_STUDIO_KNOT_TOKEN_SETTING]: {
			type: 'string',
			default: '',
			description: localize('agentStudio.knot.token', "Knot AG-UI authentication token."),
		},
		[AGENT_STUDIO_KNOT_AGENT_ID_SETTING]: {
			type: 'string',
			default: '',
			description: localize('agentStudio.knot.agentId', "Knot AG-UI agent ID."),
		},
		[AGENT_STUDIO_KNOT_BASE_URL_SETTING]: {
			type: 'string',
			default: 'https://knot.woa.com',
			description: localize('agentStudio.knot.baseUrl', "Knot AG-UI base URL."),
		},
		[AGENT_STUDIO_DATA_PATH_SETTING]: {
			type: 'string',
			default: '',
			description: localize('agentStudio.dataPath', "Custom data directory path for Agent Studio."),
		},
	},
});

// ─── Services Registration ──────────────────────────────────────────────────────

registerSingleton(IAgentStudioService, AgentStudioService, InstantiationType.Delayed);
registerSingleton(IAgentChatService, AgentChatService, InstantiationType.Delayed);
registerSingleton(IAgentDelegationService, AgentDelegationService, InstantiationType.Delayed);
registerSingleton(IAgentTaskBoardService, AgentTaskBoardService, InstantiationType.Delayed);
