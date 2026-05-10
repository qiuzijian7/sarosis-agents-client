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

// ─── Workspace Registry Service Implementation ─────────────────

export class WorkspaceRegistryService extends Disposable implements IWorkspaceRegistry {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorkspaces = this._register(new Emitter<void>());
	readonly onDidChangeWorkspaces = this._onDidChangeWorkspaces.event;

	private readonly _workspaces = new Map<string, {
		config: IWorkspaceConfig;
		osService: IAgentOSService | undefined;
	}>();

	private _logService: ILogService = console as unknown as ILogService;

	constructor() {
		super();
	}

	registerWorkspace(config: IWorkspaceConfig): IDisposable {
		if (this._workspaces.has(config.id)) {
			this._logService.warn(`[WorkspaceRegistry] Workspace ${config.id} already registered`);
			return { dispose: () => {} };
		}

		// 为每个工作区创建独立的 OS 实例栈
		// TODO: 实现工作区级别的 OS 实例创建
		const osService: IAgentOSService | undefined = undefined; // 延迟初始化

		this._workspaces.set(config.id, { config, osService });
		this._onDidChangeWorkspaces.fire();

		this._logService.info(`[WorkspaceRegistry] Registered workspace: ${config.name} (${config.id})`);

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
			entry.osService = undefined;
			this._workspaces.delete(workspaceId);
			this._onDidChangeWorkspaces.fire();
			this._logService.info(`[WorkspaceRegistry] Unregistered workspace: ${workspaceId}`);
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
		// 当前返回 undefined，等待 Phase 4 完善
		return undefined;
	}

	setLogService(logService: ILogService): void {
		this._logService = logService;
	}
}
