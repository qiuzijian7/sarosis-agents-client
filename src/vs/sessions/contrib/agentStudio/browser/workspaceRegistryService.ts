/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkspaceRegistry, IWorkspaceConfig } from '../common/agentWorkspace.js';
import { IAgentOSService } from '../common/agentOS.js';
import { IAgentDriverService } from '../common/agentDriver.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AgentOSService } from './agentOSService.js';

// ─── Workspace Registry Service Implementation ─────────────────

export class WorkspaceRegistryService extends Disposable implements IWorkspaceRegistry {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorkspaces = this._register(new Emitter<void>());
	readonly onDidChangeWorkspaces = this._onDidChangeWorkspaces.event;

	private readonly _workspaces = new Map<string, {
		config: IWorkspaceConfig;
		osService: AgentOSService;
	}>();

	private readonly _logService: ILogService;

	constructor(
		@ILogService logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._logService = logService;
	}

	registerWorkspace(config: IWorkspaceConfig): IDisposable {
		if (this._workspaces.has(config.id)) {
			this._logService.warn(`[WorkspaceRegistry] Workspace ${config.id} already registered`);
			return { dispose: () => {} };
		}

		// 为每个工作区创建独立的 OS 实例栈
		const osService = this._instantiationService.createInstance(AgentOSService);
		this._register(osService);

		this._workspaces.set(config.id, { config, osService });
		this._onDidChangeWorkspaces.fire();

		this._logService.info(`[WorkspaceRegistry] Registered workspace: ${config.name} (${config.id}) with isolated OS instance`);

		return {
			dispose: () => {
				this.unregisterWorkspace(config.id);
			},
		};
	}

	unregisterWorkspace(workspaceId: string): void {
		const entry = this._workspaces.get(workspaceId);
		if (entry) {
			// 清理 OS 实例
			entry.osService.dispose();
			this._workspaces.delete(workspaceId);
			this._onDidChangeWorkspaces.fire();
			this._logService.info(`[WorkspaceRegistry] Unregistered workspace: ${workspaceId}, OS instance disposed`);
		}
	}

	getWorkspaces(): IWorkspaceConfig[] {
		return Array.from(this._workspaces.values()).map(e => e.config);
	}

	getWorkspace(workspaceId: string): IWorkspaceConfig | undefined {
		return this._workspaces.get(workspaceId)?.config;
	}

	getWorkspaceOSService(workspaceId: string): IAgentOSService | undefined {
		return this._workspaces.get(workspaceId)?.osService;
	}

	getWorkspaceDriverService(_workspaceId: string): IAgentDriverService | undefined {
		// TODO: 实现工作区级别的 Driver 实例获取
		return undefined;
	}

	override dispose(): void {
		// 清理所有工作区的 OS 实例
		for (const [id, entry] of this._workspaces) {
			entry.osService.dispose();
			this._logService.debug(`[WorkspaceRegistry] Disposed OS instance for workspace ${id}`);
		}
		this._workspaces.clear();
		super.dispose();
	}
}
