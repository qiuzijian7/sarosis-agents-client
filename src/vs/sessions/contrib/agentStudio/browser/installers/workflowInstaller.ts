/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * WorkflowInstaller —— workflow 资源的安装器实现。
 *
 * install: 解压目录的 workflow.json → 导入到 ~/.vssaros/workflows/{id}/workflow.json
 *          （通过 IWorkflowStorageService.createWorkflow）
 * preparePack: 读工作区 workflow → 构造 manifest + 打包目录
 * getInstalledVersion: 从 installed-packages.json 读取（回退）
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkflowStorageService, IStoredWorkflow } from '../../common/workflowStorage.js';
import { IPackageInstaller, PackageManifest, IPreparePackResult } from '../../common/packageInstaller.js';
import { PackageKind, IInstallResult } from '../../common/marketplace.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } from '../../common/sarosPaths.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';

const WORKFLOW_FILE = 'workflow.json';

export class WorkflowInstaller extends Disposable implements IPackageInstaller {
	declare readonly _serviceBrand: undefined;
	readonly kind: PackageKind = 'workflow';

	constructor(
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IWorkflowStorageService private readonly workflowStorage: IWorkflowStorageService,
			@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super();
	}

	async install(manifest: PackageManifest, extractedDir: URI, opts?: { force?: boolean }): Promise<IInstallResult> {
		this.logService.info(`[WorkflowInstaller] 安装 ${manifest.id} v${manifest.version}`);

		// 1. 读取 workflow.json
		const workflowFile = URI.joinPath(extractedDir, WORKFLOW_FILE);
		if (!await this.fileService.exists(workflowFile)) {
			throw new Error('包内缺少 workflow.json');
		}

		const content = (await this.fileService.readFile(workflowFile)).value.toString();
		let workflowData: Partial<IStoredWorkflow>;
		try {
			workflowData = JSON.parse(content);
		} catch (err) {
			throw new Error(`workflow.json 解析失败: ${err instanceof Error ? err.message : String(err)}`);
		}

		// 2. 获取当前工作区 ID
		const workspaceId = this._getWorkspaceId();
		if (!workspaceId) {
			throw new Error('未找到激活的工作区，无法导入工作流');
		}

		// 3. 检查是否已存在同名工作流
		const existing = await this.workflowStorage.getWorkflow(workflowData.id || manifest.id, workspaceId);
		if (existing && !opts?.force) {
			throw new Error(`工作流 "${existing.name}" 已存在。使用 force=true 覆盖`);
		}

		// 4. 导入到工作区
		let workflow: IStoredWorkflow;
		if (existing && opts?.force) {
			// 升级：更新现有工作流
			workflow = await this.workflowStorage.updateWorkflow(
				existing.id,
				{
					name: workflowData.name || existing.name,
					description: workflowData.description || existing.description,
					steps: workflowData.steps || existing.steps,
					nodes: workflowData.nodes || existing.nodes,
					connections: workflowData.connections || existing.connections,
					presetId: workflowData.presetId || existing.presetId,
				},
				workspaceId
			);
		} else {
			// 新建
			workflow = await this.workflowStorage.createWorkflow(
				{
					name: workflowData.name || manifest.name || manifest.id,
					description: workflowData.description || manifest.description,
					presetId: workflowData.presetId,
					steps: workflowData.steps || [],
				},
				workspaceId
			);

			// 如果有 nodes/connections，更新
			if (workflowData.nodes || workflowData.connections) {
				workflow = await this.workflowStorage.updateWorkflow(
					workflow.id,
					{
						nodes: workflowData.nodes,
						connections: workflowData.connections,
					},
					workspaceId
				);
			}
		}

		this.logService.info(`[WorkflowInstaller] 安装完成: ${workflow.name} (${workflow.id})`);

		// 5. 同时保存到 ~/.vssaros/workflows/{id}/ 作为备份（供升级检查溯源）
		const backupDir = await this._resolveBackupDir(manifest.id);
		await this.fileService.createFolder(backupDir);
		const backupFile = URI.joinPath(backupDir, WORKFLOW_FILE);
		await this.fileService.writeFile(backupFile, VSBuffer.fromString(content));

		return {
			kind: 'workflow',
			storeId: manifest.id,
			version: manifest.version,
			targetDir: backupDir.fsPath,
		};
	}

	async preparePack(localId: string): Promise<IPreparePackResult> {
		const workspaceId = this._getWorkspaceId();
		if (!workspaceId) {
			throw new Error('未找到激活的工作区');
		}

		const workflow = await this.workflowStorage.getWorkflow(localId, workspaceId);
		if (!workflow) {
			throw new Error(`工作流不存在: ${localId}`);
		}

		// 构造打包目录（临时）
		const packDir = resolveSarosPath(this._getSarosRoot(), SarosPath.tmp, `workflow-pack-${Date.now()}`);
		await this.fileService.createFolder(packDir);

		// 写入 workflow.json
		const workflowFile = URI.joinPath(packDir, WORKFLOW_FILE);
		const workflowJson = JSON.stringify(workflow, null, 2);
		await this.fileService.writeFile(workflowFile, VSBuffer.fromString(workflowJson));

		// 构造 manifest
		const manifest: PackageManifest = {
			kind: 'workflow',
			id: workflow.id,
			name: workflow.name,
			version: workflow.version || '1.0.0',
			description: workflow.description,
			category: workflow.category,
			author: workflow.author,
			files: [WORKFLOW_FILE],
		};

		return { localDir: packDir, manifest };
	}

	getInstalledVersion(storeId: string): string | undefined {
		// 从 ~/.vssaros/installed-packages.json 读取（由 MarketplaceService 维护）
		// 这里简单返回 undefined，由 MarketplaceService 统一检查
		return undefined;
	}

	// ── 内部 ─────────────────────────────────────────────────

	private _getWorkspaceId(): string | undefined {
		const workspace = this.workspaceService.getWorkspace();
		return workspace.id || undefined;
	}

	private async _resolveBackupDir(id: string): Promise<URI> {
		return resolveSarosPath(this._getSarosRoot(), SarosPath.workflows, id);
	}

	private _getSarosRoot(): URI {
		return userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
	}
}
