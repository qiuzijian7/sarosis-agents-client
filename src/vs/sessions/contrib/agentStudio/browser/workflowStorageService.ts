/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ------------------------------------------------------------------------------------------------
// workflowStorageService.ts - 工作流文件存储服务实现
// ------------------------------------------------------------------------------------------------
//
// 将工作流以 JSON 文件形式持久化到当前工作区的
// `.sarosworkspace/workflows/{id}.json`。
//
// 目录定位:
//   workspace.path → home/元数据目录 → 拼接 `.sarosworkspace/workflows/`
//   (workspace.path 通过 IAgentStudioService.getWorkspace(activeId) 获取)

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { IWorkflowStorageService, type IStoredWorkflow } from '../common/workflowStorage.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';

const USER_SAROS_DIR = '.saros';
const WORKFLOWS_DIR = 'workflows';
const DEFAULT_WORKFLOW_PRESET_ID = 'workflow-agent';

export class WorkflowStorageService extends Disposable implements IWorkflowStorageService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorkflows = this._register(new Emitter<void>());
	readonly onDidChangeWorkflows: Event<void> = this._onDidChangeWorkflows.event;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IAgentStudioService private readonly _studioService: IAgentStudioService,
		@INativeEnvironmentService private readonly _envService: INativeEnvironmentService,
	) {
		super();
	}

	// ─── Directory resolution ────────────────────────────────────────────

	/**
	 * 解析用户级的 `~/.saros/workflows/` 目录 URI。
	 * 所有工作流全局存储，不再按工作区隔离。
	 */
	private async _resolveWorkflowsDir(_workspaceId?: string): Promise<URI | undefined> {
		try {
			const userHome = this._envService.userHome;
			const dir = URI.joinPath(userHome, USER_SAROS_DIR, WORKFLOWS_DIR);
			return dir;
		} catch (err) {
			this._logService.error('[WorkflowStorage] Failed to resolve user workflows dir', err);
			return undefined;
		}
	}

	private async _ensureDir(dirUri: URI): Promise<void> {
		try {
			await this._fileService.stat(dirUri);
		} catch {
			try {
				await this._fileService.createFolder(dirUri);
			} catch (createErr) {
				this._logService.error('[WorkflowStorage] createFolder failed', dirUri.toString(), createErr);
				throw createErr;
			}
		}
	}

	// ─── CRUD ────────────────────────────────────────────────────────────

	async listWorkflows(workspaceId?: string): Promise<IStoredWorkflow[]> {
		const dir = await this._resolveWorkflowsDir(workspaceId);
		if (!dir) { return []; }

		try {
			const stat = await this._fileService.resolve(dir);
			if (!stat.children) { return []; }

			const workflows: IStoredWorkflow[] = [];
			for (const child of stat.children) {
				if (child.isDirectory || !child.name.endsWith('.json')) { continue; }
				try {
					const content = await this._fileService.readFile(child.resource);
					const wf = JSON.parse(content.value.toString()) as IStoredWorkflow;
					if (wf && wf.id) {
						workflows.push(wf);
					}
				} catch (parseErr) {
					this._logService.warn('[WorkflowStorage] Failed to parse workflow file', child.resource.toString(), parseErr);
				}
			}
			// 按更新时间倒序
			workflows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
			return workflows;
		} catch {
			// 目录不存在
			return [];
		}
	}

	async getWorkflow(id: string, workspaceId?: string): Promise<IStoredWorkflow | undefined> {
		const dir = await this._resolveWorkflowsDir(workspaceId);
		if (!dir) { return undefined; }
		const uri = URI.joinPath(dir, `${id}.json`);
		try {
			const content = await this._fileService.readFile(uri);
			return JSON.parse(content.value.toString()) as IStoredWorkflow;
		} catch {
			return undefined;
		}
	}

	async createWorkflow(
		data: {
			name: string;
			description?: string;
			presetId?: string;
			agentId?: string;
			steps?: IStoredWorkflow['steps'];
		},
		workspaceId?: string,
	): Promise<IStoredWorkflow> {
		const dir = await this._resolveWorkflowsDir(workspaceId);
		if (!dir) {
			throw new Error('Cannot resolve workflows directory. Please ensure your home directory is accessible.');
		}
		await this._ensureDir(dir);

		const now = Date.now();
		const id = generateUuid();
		const activeWsId = workspaceId ?? this._studioService.getActiveWorkspaceId();
		const workflow: IStoredWorkflow = {
			id,
			name: data.name,
			description: data.description ?? '',
			steps: data.steps ?? [],
			isActive: false,
			createdAt: now,
			updatedAt: now,
			presetId: data.presetId ?? DEFAULT_WORKFLOW_PRESET_ID,
			agentId: data.agentId,
			workspaceId: activeWsId,
		};

		const uri = URI.joinPath(dir, `${id}.json`);
		await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(workflow, null, 2)));
		this._logService.info('[WorkflowStorage] Created workflow', id, 'at', uri.toString());
		this._onDidChangeWorkflows.fire();
		return workflow;
	}

	async updateWorkflow(id: string, patch: Partial<IStoredWorkflow>, workspaceId?: string): Promise<IStoredWorkflow> {
		const dir = await this._resolveWorkflowsDir(workspaceId);
		if (!dir) {
			throw new Error('No active workspace — cannot update workflow.');
		}
		const existing = await this.getWorkflow(id, workspaceId);
		if (!existing) {
			throw new Error(`Workflow ${id} not found.`);
		}
		const updated: IStoredWorkflow = {
			...existing,
			...patch,
			id: existing.id, // id 不可变
			updatedAt: Date.now(),
		};
		const uri = URI.joinPath(dir, `${id}.json`);
		await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(updated, null, 2)));
		this._onDidChangeWorkflows.fire();
		return updated;
	}

	async deleteWorkflow(id: string, workspaceId?: string): Promise<void> {
		const dir = await this._resolveWorkflowsDir(workspaceId);
		if (!dir) { return; }
		const uri = URI.joinPath(dir, `${id}.json`);
		try {
			await this._fileService.del(uri);
			this._onDidChangeWorkflows.fire();
		} catch (err) {
			this._logService.warn('[WorkflowStorage] delete failed', uri.toString(), err);
		}
	}

	/**
	 * v19: Persist workflow display order.
	 * Stores ordered IDs in `.sarosworkspace/workflows-order.json`.
	 */
	async reorderWorkflows(orderedIds: string[], workspaceId?: string): Promise<void> {
		const dir = await this._resolveWorkflowsDir(workspaceId);
		if (!dir) { return; }
		// Write order file in parent directory (.sarosworkspace/)
		const orderUri = URI.joinPath(dir, '..', 'workflows-order.json');
		const data = JSON.stringify({ order: orderedIds, updatedAt: Date.now() }, null, 2);
		await this._fileService.writeFile(orderUri, VSBuffer.fromString(data));
		this._logService.info(`[WorkflowStorage] Reorder saved: ${orderedIds.length} workflows`);
	}
}
