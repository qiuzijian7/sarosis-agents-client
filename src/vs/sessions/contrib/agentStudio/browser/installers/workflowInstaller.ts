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
import { sanitizeForPublish, MAX_PUBLISH_BYTES } from '../utils/publishSanitize.js';
import { buildWorkflowExportPayload } from '../workflow/workflowFileExport.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';

const WORKFLOW_FILE = 'workflow.json';
/**
 * 包备份根目录名（`{root}/workflows-store/`）。
 *
 * ★ 必须与工作流列表目录（`SarosPath.workflows` = `{root}/workflows/`）**区分开**：
 *   两者曾重合，导致安装时同一目录被写两次（详见 `_resolveBackupDir` 注释）。
 *   刻意不加入 `SarosPath` —— 它不是"用户数据"目录，只是安装器的溯源缓存，
 *   避免被其它模块误当成工作流目录遍历。
 */
const WORKFLOW_STORE_DIR = 'workflows-store';

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
		// ★ 安装侧校验（2026-09-13 修注入面）：包内 JSON 此前**零校验**直写本地 ✗
		//   （`JSON.parse` 之后直接 createWorkflow / updateWorkflow）。这里补两道**廉价**护栏：
		//   体积上限 + 关键字段类型 —— 挡住「畸形包 / 超大包」，但不做完整 schema
		//   （完整校验属于白名单范畴，是产品决策 ✓）。
		if (content.length > MAX_PUBLISH_BYTES) {
			throw new Error(`包内 workflow.json 过大（${(content.length / 1024 / 1024).toFixed(1)}MB），拒绝安装`);
		}
		let workflowData: Partial<IStoredWorkflow>;
		try {
			workflowData = JSON.parse(content);
		} catch (err) {
			throw new Error(`workflow.json 解析失败: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!workflowData || typeof workflowData !== 'object' || Array.isArray(workflowData)) {
			throw new Error('workflow.json 结构非法（顶层应为对象）');
		}
		if (workflowData.id !== undefined && typeof workflowData.id !== 'string') {
			throw new Error('workflow.json 的 id 应为字符串');
		}
		if (workflowData.nodes !== undefined && !Array.isArray(workflowData.nodes)) {
			throw new Error('workflow.json 的 nodes 应为数组');
		}
		if (workflowData.connections !== undefined && !Array.isArray(workflowData.connections)) {
			throw new Error('workflow.json 的 connections 应为数组');
		}

		// 2. 获取当前工作区 ID
		const workspaceId = this._getWorkspaceId();
		if (!workspaceId) {
			throw new Error('未找到激活的工作区，无法导入工作流');
		}

		// 3. 检查是否已存在同名工作流
		const existing = await this.workflowStorage.getWorkflow(workflowData.id || manifest.id, workspaceId);
		if (existing && !opts?.force) {
			// ★ 文案不再"教"用户传 `force`（2026-09-13）：旧文案直接写「使用 force=true 覆盖」
			//   ✗ → 用户（和 UI）会习惯性带 force → 覆盖保护形同虚设 ✗。改成引导走升级流程 ✓。
			throw new Error(`工作流 "${existing.name}" 已存在。请在商城中选择「升级」以覆盖，或先重命名本地工作流`);
		}

		// 4. 导入到工作区
		let workflow: IStoredWorkflow;
		if (existing && opts?.force) {
			// ★ 升级前备份**本地版本**（2026-09-13 修「升级静默丢本地改动」）：
			//   此前直接 `updateWorkflow` 整体覆盖 ✗ —— 本地**未发布**的修改会无声丢失，
			//   而第 5 步那份"备份"是**入包内容**（供升级溯源 ✓），**不是**本地旧版 ✗。
			//   现把覆盖前的本地工作流原样落盘到 `workflows-store/{id}/local-backup-{ts}.json` ✓。
			//   ⚠ 备份失败**不阻断**升级：它是补偿手段，不该变成新的失败点 ✗。
			try {
				const localBackupDir = await this._resolveBackupDir(manifest.id);
				await this.fileService.createFolder(localBackupDir);
				const ts = new Date().toISOString().replace(/[:.]/g, '-');
				await this.fileService.writeFile(
					URI.joinPath(localBackupDir, `local-backup-${ts}.json`),
					VSBuffer.fromString(JSON.stringify(existing, null, 2)),
				);
				this.logService.info(`[WorkflowInstaller] 升级前已备份本地版本: ${existing.id} → local-backup-${ts}.json`);
			} catch (err) {
				this.logService.warn('[WorkflowInstaller] 本地版本备份失败（继续升级）:', err);
			}
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
			// ★ 修复（2026-09-11）：安装必须**沿用包内 id**，否则产生重复工作流。
			//   `createWorkflow` 缺省按 name 派生 id（`wf-{slug(name)}`），而本方法上方
			//   的「已存在」检查用的是 `workflowData.id || manifest.id` —— 两者不一致时
			//   （典型：工作流**改名后发布**，id 固定但 name 已变）：
			//     ① 检查查不到 → 走新建 → 本地 id 变成 wf-{新 name 的 slug}
			//     ② 下方「备份」又按 manifest.id 写一份 → **列表出现两条同名工作流**
			//     ③ 下次升级仍用包内 id 查 → 仍查不到 → 再新建 → 无限累积
			//   传 slug 让 createWorkflow 还原出包内 id（其实现为 `wf-{sanitize(slug)}`，
			//   对 `wf-xxx` 形态的 id 是**恒等映射**）。
			const packId = String(workflowData.id || manifest.id || '').trim();
			const packSlug = packId ? (packId.startsWith('wf-') ? packId.slice(3) : packId) : '';
			workflow = await this.workflowStorage.createWorkflow(
				{
					name: workflowData.name || manifest.name || manifest.id,
					description: workflowData.description || manifest.description,
					presetId: workflowData.presetId,
					steps: workflowData.steps || [],
					...(packSlug ? { slug: packSlug } : {}),
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
		// ★ 发布前剥离「本地态」（2026-09-13 修发布泄露面）：此前 `JSON.stringify(workflow)`
		//   **整份上传** ✗ → 节点属性里的 `data:` 大图（单张数百 KB~数 MB，跨机无意义 ✗）
		//   与本机绝对路径（`E:\…` / `/Users/…` ✗）都会进包。剥离是**递归**的且不改原对象 ✓。
		// ★ 复用**导出白名单**（2026-09-13）：`buildWorkflowExportPayload` 是导出路径
		//   已批准的**顶层字段**清单 ✓（nodes/connections/breakpoints/version/category/
		//   author/visibility/tags/useGuide …）—— 发布直接复用，**不再整份 stringify** ✗
		//   （后者会带上 `updatedAt`/`createdAt`/本地 session 等**纯本地态** ✗）。
		//   ⚠ 它**不**深入 node.data（那是产品决策 ✗）→ 节点级本地态由 `sanitizeForPublish`
		//   兜住（data: 大图 / 本机绝对路径 ✓）。
		const { value: publishable, stripped } = sanitizeForPublish(buildWorkflowExportPayload(workflow));
		if (stripped.length > 0) {
			this.logService.info(
				`[WorkflowInstaller] 发布剥离 ${stripped.length} 个本地态字段: `
				+ `${stripped.slice(0, 10).join(', ')}${stripped.length > 10 ? ' …' : ''}`);
		}
		const workflowJson = JSON.stringify(publishable, null, 2);
		// ★ 包体上限（2026-09-13）：剥离后仍超限 → 几乎必然是把本地生成物打进去了 ✗。
		//   直接失败好过"悄悄传一个几十 MB 的包"（也免去服务端拒收前的无谓上传 ✓）。
		if (workflowJson.length > MAX_PUBLISH_BYTES) {
			throw new Error(
				`工作流包体过大（${(workflowJson.length / 1024 / 1024).toFixed(1)}MB > `
				+ `${MAX_PUBLISH_BYTES / 1024 / 1024}MB）：请检查是否包含大文件或内联图片`);
		}
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

	/**
	 * 包备份目录：`{root}/workflows-store/{id}/`。
	 *
	 * ★ 2026-09-11 修复：此前是 `{root}/workflows/{id}/` —— 与**工作流列表目录**
	 *   （`workflowStorageService._resolveWorkflowsDir()` = `{userDataPath}/workflows`，
	 *   两个根都指向 `~/.vssaros/`）**完全重合**。后果：
	 *     ① 安装/升级时同一目录被写两次（createWorkflow → updateWorkflow → 备份用
	 *        包内原始 content 覆盖），把本地 `updatedAt` 覆盖成发布方的值 →
	 *        刚装好的工作流在列表里排到旧位置；
	 *     ② id 与包内不一致的旧行为下，还会额外多出一条「备份」工作流（重复条目）。
	 *   移到平级目录 `workflows-store/` 后，列表扫描（只遍历 `workflows/` 顶层
	 *   子目录）不再受影响，备份语义（供升级溯源）保持不变。
	 */
	private async _resolveBackupDir(id: string): Promise<URI> {
		return resolveSarosPath(this._getSarosRoot(), WORKFLOW_STORE_DIR, id);
	}

	private _getSarosRoot(): URI {
		return userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
	}
}
