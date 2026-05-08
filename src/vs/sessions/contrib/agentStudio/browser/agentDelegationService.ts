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
import { IAgentDelegationService, IAutoPlanResult } from '../common/agentStudio.js';
import type { Delegation } from '../common/types.js';
import { DelegationStatus } from '../common/types.js';
import { DATA_FILE_DELEGATIONS, AGENT_STUDIO_DATA_PATH_SETTING } from '../common/constants.js';

export class AgentDelegationService extends Disposable implements IAgentDelegationService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeDelegations = this._register(new Emitter<void>());
	readonly onDidChangeDelegations: Event<void> = this._onDidChangeDelegations.event;

	private _dataUri: URI | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
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
		this.logService.info(`[AgentStudio] Auto-Plan executing for goal: "${goal}" in workspace: ${workspaceId}`);

		// TODO: Call AI model to decompose the goal into sub-tasks
		// For now, create a single delegation as placeholder
		const delegation = await this.createDelegation({
			title: goal,
			description: `Auto-planned task: ${goal}`,
			workspaceId,
			status: DelegationStatus.Pending,
		});

		return {
			delegations: [delegation],
			summary: `Created 1 task for goal: "${goal}"`,
		};
	}
}
