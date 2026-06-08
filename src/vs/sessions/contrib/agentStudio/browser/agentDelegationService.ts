/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IAgentDelegationService } from '../common/agentStudio.js';
import type { IAutoPlanResult } from '../common/agentStudio.js';
import type { Delegation } from '../common/types.js';
import { DelegationStatus } from '../common/types.js';
import { DATA_FILE_DELEGATIONS, AGENT_STUDIO_DATA_PATH_SETTING, AGENT_STUDIO_DEFAULT_AGENT_SETTING } from '../common/constants.js';
import { IAgentOSService } from '../common/agentOS.js';
import type { IAgentTurnRequest } from '../common/providers.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import type { Agent } from '../../../common/agentStudioTypes.js';
import { StructuredOutputParser } from './structuredOutputParser.js';
import { ITaskOrchestrationService } from '../common/agentStudio.js';

export class AgentDelegationService extends Disposable implements IAgentDelegationService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeDelegations = this._register(new Emitter<void>());
	readonly onDidChangeDelegations: Event<void> = this._onDidChangeDelegations.event;

	private _dataUri: URI | undefined;

	/** Structured output parser (replaces hand-written JSON extraction) */
	private readonly _outputParser: StructuredOutputParser;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@ITaskOrchestrationService private readonly taskOrchestrationService: ITaskOrchestrationService,
	) {
		super();
		void this.taskOrchestrationService; // injected for future use
		this._outputParser = new StructuredOutputParser(logService);
	}

	private _getDataUri(): URI {
		if (!this._dataUri) {
			const customPath = this.configurationService.getValue<string>(AGENT_STUDIO_DATA_PATH_SETTING);
			if (customPath) {
				this._dataUri = URI.file(customPath);
			} else {
				this._dataUri = URI.file(process.env.HOME || process.env.USERPROFILE || '~')
					.with({ path: `${process.env.HOME || process.env.USERPROFILE || '~'}/.agent-studio/data` });
			}
		}
		return this._dataUri;
	}

	private async _readDelegations(): Promise<Delegation[]> {
		try {
			const uri = URI.joinPath(this._getDataUri(), DATA_FILE_DELEGATIONS);
			const content = await this.fileService.readFile(uri);
			return JSON.parse(content.value.toString()) as Delegation[];
		} catch {
			return [];
		}
	}

	private async _writeDelegations(delegations: Delegation[]): Promise<void> {
		const uri = URI.joinPath(this._getDataUri(), DATA_FILE_DELEGATIONS);
		const content = VSBuffer.fromString(JSON.stringify(delegations, null, 2));
		await this.fileService.writeFile(uri, content);
	}

	private _generateId(): string {
		return `del_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
	}

	async getDelegations(workspaceId?: string): Promise<Delegation[]> {
		const delegations = await this._readDelegations();
		if (workspaceId) {
			return delegations.filter(d => d.workspaceId === workspaceId);
		}
		return delegations;
	}

	async getDelegation(id: string): Promise<Delegation | undefined> {
		const delegations = await this._readDelegations();
		return delegations.find(d => d.id === id);
	}

	async createDelegation(data: Partial<Delegation>): Promise<Delegation> {
		const delegations = await this._readDelegations();
		const now = new Date().toISOString();
		const newDelegation: Delegation = {
			id: this._generateId(),
			title: data.title || 'New Task',
			description: data.description,
			assigneeId: data.assigneeId || '',
			assignerId: data.assignerId,
			workspaceId: data.workspaceId || '',
			status: DelegationStatus.Pending,
			parentTaskId: data.parentTaskId,
			dependencies: data.dependencies || [],
			createdAt: now,
			updatedAt: now,
		};
		delegations.push(newDelegation);
		await this._writeDelegations(delegations);
		this._onDidChangeDelegations.fire();
		return newDelegation;
	}

	async updateDelegation(id: string, data: Partial<Delegation>): Promise<Delegation> {
		const delegations = await this._readDelegations();
		const index = delegations.findIndex(d => d.id === id);
		if (index === -1) {
			throw new Error(`Delegation not found: ${id}`);
		}

		const now = new Date().toISOString();
		const updated: Delegation = {
			...delegations[index],
			...data,
			id,
			updatedAt: now,
		};

		// Set completedAt when transitioning to Done/Error/Cancelled
		if (data.status && [DelegationStatus.Done, DelegationStatus.Error, DelegationStatus.Cancelled].includes(data.status)) {
			updated.completedAt = now;
		}

		delegations[index] = updated;
		await this._writeDelegations(delegations);
		this._onDidChangeDelegations.fire();
		return updated;
	}

	async deleteDelegation(id: string): Promise<void> {
		const delegations = await this._readDelegations();
		const filtered = delegations.filter(d => d.id !== id);
		await this._writeDelegations(filtered);
		this._onDidChangeDelegations.fire();
	}

	async executePlan(goal: string, workspaceId: string): Promise<IAutoPlanResult> {
		this.logService.info(`[AgentStudio] ===== Auto-Plan START for goal: "${goal}" =====`);

		try {
			// Step 0: Get workspace context (available agents)
			// Agents are global definitions; all are available in every workspace.
			this.logService.info(`[AgentStudio] [Step 0] Fetching workspace context: ${workspaceId}`);
			const agents = await this.agentStudioService.getAgents();
			this.logService.info(`[AgentStudio] [Step 0] Found ${agents.length} agents`);
			agents.forEach((a, i) => {
				this.logService.info(`[AgentStudio] [Step 0] Agent[${i}]: id=${a.id}, name="${a.name}", type=${a.agentType || 'unknown'}`);
			});

			// Create name-to-id mapping for assignee resolution
			const agentNameToId = new Map<string, string>();
			agents.forEach(a => {
				if (a.name && a.id) {
					agentNameToId.set(a.name.toLowerCase(), a.id);
				}
			});
			this.logService.info(`[AgentStudio] [Step 0] Built agentNameToId map with ${agentNameToId.size} entries`);

			// Step 1: Call AI model to decompose the goal into sub-tasks
			this.logService.info(`[AgentStudio] [Step 1] Calling AI model for task decomposition`);
			const aiResponse = await this._callAIModel(goal, workspaceId, agents);
			this.logService.info(`[AgentStudio] [Step 1] AI response received, length=${aiResponse.length}`);
			
			// Step 2: Parse AI response using StructuredOutputParser
			this.logService.info(`[AgentStudio] [Step 2] Parsing AI response with StructuredOutputParser`);
			const { tasks: parsedTasks, errors } = this._outputParser.parseTaskDecomposition(aiResponse);
			
			if (errors.length > 0) {
				this.logService.warn(`[AgentStudio] [Step 2] StructuredOutputParser reported ${errors.length} validation errors`);
				for (const err of errors.slice(0, 5)) {
					this.logService.warn(`[AgentStudio]   - ${err.path}: ${err.message}`);
				}
			}

			this.logService.info(`[AgentStudio] [Step 2] Parsed ${parsedTasks.length} tasks from AI response`);
			
			// Step 3: Create delegations for each task
			this.logService.info(`[AgentStudio] [Step 3] Creating delegations`);
			const delegations: Delegation[] = [];
			const taskIdMap = new Map<string, string>(); // Map AI task ID to delegation ID
			
			for (const task of parsedTasks) {
				// Resolve assignee ID
				const assigneeId = task.suggestedAssignee
					? (agentNameToId.get(task.suggestedAssignee.toLowerCase()) || '')
					: '';

				this.logService.info(`[AgentStudio] [Step 3] Creating delegation: title="${task.title}", assigneeId="${assigneeId}"`);
				const delegation = await this.createDelegation({
					title: task.title,
					description: task.description,
					workspaceId,
					status: DelegationStatus.Pending,
					assigneeId,
					dependencies: task.dependencies
						.map(depId => taskIdMap.get(depId))
						.filter(Boolean) as string[],
				});
				
				delegations.push(delegation);
				taskIdMap.set(task.id, delegation.id);
				this.logService.info(`[AgentStudio] [Step 3] Created delegation id=${delegation.id} for task id=${task.id}`);
			}

			this.logService.info(`[AgentStudio] ===== Auto-Plan SUCCESS: created ${delegations.length} tasks =====`);

			return {
				delegations,
				summary: `Created ${delegations.length} tasks for goal: "${goal}"`,
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this.logService.error('[AgentStudio] ===== Auto-Plan FAILED =====');
			this.logService.error(`[AgentStudio] Error message: ${errorMsg}`);
			this.logService.error(`[AgentStudio] Error stack: ${error instanceof Error ? error.stack : 'no stack'}`);
			
			// Fallback: create a single delegation as placeholder
			const delegation = await this.createDelegation({
				title: goal,
				description: `Auto-plan failed: ${errorMsg}. Please try again or manually create tasks.`,
				workspaceId,
				status: DelegationStatus.Pending,
			});

			return {
				delegations: [delegation],
				summary: `Auto-plan failed: ${errorMsg}. Created 1 fallback task for goal: "${goal}"`,
			};
		}
	}

	/**
	 * Call AI model to decompose goal into sub-tasks.
	 * Reference: Paperclip's task decomposition principles from skills/paperclip-converting-plans-to-tasks/SKILL.md
	 */
	private async _callAIModel(goal: string, workspaceId: string, agents: Agent[]): Promise<string> {
		this.logService.info(`[AgentStudio] Calling AI model for goal: "${goal}"`);
		
		// Get default agent ID from configuration
		const defaultAgentId = this.configurationService.getValue<string>(AGENT_STUDIO_DEFAULT_AGENT_SETTING) || 'default';
		this.logService.info(`[AgentStudio] Using agentId: ${defaultAgentId}`);
		
		// Build agent context string
		const agentContext = agents.length > 0 
			? `Available team members:\n${agents.map(a => `- ${a.name} (${a.agentType || 'worker'})`).join('\n')}`
			: 'No team members available.';
		
		// Build concise system prompt following Paperclip's principles
		const systemPrompt = `You are a task decomposition expert. Break down the goal into small, executable tasks.

Principles:
1. Plan deeply - smallest executable units
2. Know your team - consider required roles and available team members
3. Assign for specialty - match tasks to roles/team members

${agentContext}

Output JSON format:
{
  "tasks": [
    {
      "id": "T1",
      "title": "Task title",
      "description": "Detailed description",
      "suggestedRole": "Developer",
      "suggestedAssignee": "agent-name", 
      "dependencies": [],
      "priority": 1
    }
  ]
}

Important: 
- Return ONLY the JSON object, no markdown formatting.
- Use "suggestedAssignee" field to specify which team member should do the task (use name from Available team members).
- If no suitable team member, leave "suggestedAssignee" empty.`;

		const userMessage = `Goal: ${goal}\n\nDecompose this goal into executable tasks. Consider the available team members. Return JSON.`;

		const request: IAgentTurnRequest = {
			agentId: defaultAgentId,
			sessionId: workspaceId,
			messages: [
				{ role: 'user', content: userMessage }
			],
			systemPrompt,
		};

		try {
			this.logService.info(`[AgentStudio] Calling AgentOS.executeAgentTurn with agentId=${defaultAgentId}`);
			const stream = this.agentOSService.executeAgentTurn(request);
			let responseText = '';
			let textDeltaCount = 0;
			let otherDeltaCount = 0;
			const deltaTypes = new Set<string>();

			for await (const delta of stream) {
				deltaTypes.add(delta.type);
				if (delta.type === 'text' && delta.content) {
					responseText += delta.content;
					textDeltaCount++;
				} else if (delta.type === 'tool_result' && delta.content) {
					responseText += delta.content;
					this.logService.info(`[AgentStudio] Received tool_result delta, content length: ${delta.content.length}`);
				} else if (delta.type === 'error') {
					this.logService.error(`[AgentStudio] Received error delta: ${delta.content}`);
				} else {
					otherDeltaCount++;
				}
			}

			this.logService.info(`[AgentStudio] Stream complete. Delta types: [${Array.from(deltaTypes).join(', ')}]`);
			this.logService.info(`[AgentStudio] text deltas: ${textDeltaCount}, other deltas: ${otherDeltaCount}`);
			this.logService.info(`[AgentStudio] AI model response raw text length: ${responseText.length}`);
			this.logService.info(`[AgentStudio] AI raw response preview: ${responseText.substring(0, 500)}...`);
			
			if (!responseText.trim()) {
				this.logService.error('[AgentStudio] AI model returned empty response');
				throw new Error('AI model returned empty response');
			}
			
			return responseText;
		} catch (error) {
			this.logService.error('[AgentStudio] Failed to call AI model:', error);
			throw new Error(`AI model call failed: ${error}. Please check model configuration and try again.`);
		}
	}

}

