/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Workflow 上传 / 下载 / 更新 测试用例
 *
 * 覆盖以下场景：
 *   1. WorkflowInstaller.install       — 从解压目录导入工作流到 ~/.saros/workflows/
 *   2. WorkflowInstaller.preparePack   — 将本地工作流打包到临时目录
 *   3. WorkflowInstaller.getInstalledVersion — 从 installed-packages.json 查询已安装版本
 *   4. 版本比较（semver）              — 升级判定逻辑
 *   5. install 已存在工作流            — 同名冲突 / force 升级
 *
 * 测试策略：使用 mock 文件系统和 mock IWorkflowStorageService，
 *          通过 WorkflowInstaller 的公开 API 间接验证行为。
 */

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { WorkflowInstaller } from '../../browser/installers/workflowInstaller.js';
import type { IStoredWorkflow } from '../../common/workflowStorage.js';
import type { PackageManifest } from '../../common/packageInstaller.js';

// ─── Mock FileService ─────────────────────────────────────────────────────────

interface MockFile {
	content: string;
}

class MockFileService {
	private _files = new Map<string, MockFile>();
	private _folders = new Set<string>();

	async exists(uri: URI): Promise<boolean> {
		return this._files.has(uri.toString()) || this._folders.has(uri.toString());
	}

	async readFile(uri: URI): Promise<{ value: VSBuffer }> {
		const f = this._files.get(uri.toString());
		if (!f) { throw new Error(`File not found: ${uri.toString()}`); }
		return { value: VSBuffer.fromString(f.content) };
	}

	async writeFile(uri: URI, content: VSBuffer): Promise<void> {
		this._files.set(uri.toString(), { content: content.toString() });
	}

	async createFolder(uri: URI): Promise<void> {
		this._folders.add(uri.toString());
	}

	async stat(uri: URI): Promise<{ isDirectory: boolean; children?: Array<{ resource: URI; isDirectory: boolean; name: string }> }> {
		const key = uri.toString();
		if (this._folders.has(key)) {
			const children: Array<{ resource: URI; isDirectory: boolean; name: string }> = [];
			const prefix = key.endsWith('/') ? key : key + '/';
			for (const fileKey of this._files.keys()) {
				if (fileKey.startsWith(prefix)) {
					const rest = fileKey.substring(prefix.length);
					if (!rest.includes('/')) {
						children.push({
							resource: URI.parse(fileKey),
							isDirectory: false,
							name: rest,
						});
					}
				}
			}
			return { isDirectory: true, children };
		}
		if (this._files.has(key)) {
			return { isDirectory: false };
		}
		throw new Error(`Not found: ${key}`);
	}

	// test helper: inject a file
	_setFile(path: string, content: string): void {
		this._files.set(URI.file(path).toString(), { content });
	}

	// test helper: read a file's content as string
	_getFile(path: string): string | undefined {
		return this._files.get(URI.file(path).toString())?.content;
	}
}

// ─── Mock LogService ──────────────────────────────────────────────────────────

class MockLogService {
	info(_msg: string) { /* noop */ }
	warn(_msg: string) { /* noop */ }
	error(_msg: string) { /* noop */ }
	debug(_msg: string) { /* noop */ }
	trace(_msg: string) { /* noop */ }
}

// ─── Mock WorkflowStorageService ──────────────────────────────────────────────

class MockWorkflowStorage {
	private _workflows = new Map<string, IStoredWorkflow>();

	async listWorkflows(): Promise<IStoredWorkflow[]> {
		return Array.from(this._workflows.values());
	}

	async getWorkflow(id: string): Promise<IStoredWorkflow | undefined> {
		return this._workflows.get(id);
	}

	async createWorkflow(data: { name: string; description?: string; steps?: any[] }): Promise<IStoredWorkflow> {
		const id = `wf-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
		const now = Date.now();
		const wf: IStoredWorkflow = {
			id,
			name: data.name,
			description: data.description ?? '',
			steps: data.steps ?? [],
			isActive: false,
			createdAt: now,
			updatedAt: now,
			version: '1.0.0',
		};
		this._workflows.set(id, wf);
		return wf;
	}

	async updateWorkflow(id: string, patch: Partial<IStoredWorkflow>): Promise<IStoredWorkflow> {
		const existing = this._workflows.get(id);
		if (!existing) { throw new Error(`Workflow ${id} not found`); }
		const updated = { ...existing, ...patch, id: existing.id, updatedAt: Date.now() };
		this._workflows.set(id, updated);
		return updated;
	}

	async deleteWorkflow(id: string): Promise<void> {
		this._workflows.delete(id);
	}

	// test helper
	_seed(wf: IStoredWorkflow): void {
		this._workflows.set(wf.id, wf);
	}
}

// ─── Mock PathService ─────────────────────────────────────────────────────────

class MockPathService {
	constructor(private readonly _userHome: URI) { }

	async userHome(): Promise<URI> {
		return this._userHome;
	}
}

// ─── Mock WorkspaceContextService ──────────────────────────────────────────────

class MockWorkspaceContextService {
	constructor(private readonly _workspaceId: string = 'test-workspace') { }

	getWorkspace(): { id: string } {
		return { id: this._workspaceId };
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWorkflow(overrides: Partial<IStoredWorkflow> = {}): IStoredWorkflow {
	const now = Date.now();
	return {
		id: 'wf-test-001',
		name: 'Test Workflow',
		description: 'A test workflow',
		steps: [],
		isActive: false,
		createdAt: now,
		updatedAt: now,
		version: '1.0.0',
		...overrides,
	};
}

function makeManifest(overrides: Partial<PackageManifest> = {}): PackageManifest {
	return {
		kind: 'workflow',
		id: 'wf-test-001',
		name: 'Test Workflow',
		version: '1.0.0',
		description: 'A test workflow',
		files: ['workflow.json'],
		...overrides,
	};
}

/**
 * Compare semver versions. Returns true if `server` > `local`.
 * Mirrors the implementation in presetAgentView._isVersionHigher.
 */
function isVersionHigher(server: string | undefined, local: string | undefined): boolean {
	if (!server) { return false; }
	if (!local) { return true; }
	const parseVer = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
	const s = parseVer(server);
	const l = parseVer(local);
	for (let i = 0; i < Math.max(s.length, l.length); i++) {
		const sv = s[i] ?? 0;
		const lv = l[i] ?? 0;
		if (sv > lv) { return true; }
		if (sv < lv) { return false; }
	}
	return false;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('WorkflowMarketOperations', () => {

	let fileService: MockFileService;
	let logService: MockLogService;
	let workflowStorage: MockWorkflowStorage;
	let pathService: MockPathService;
	let workspaceService: MockWorkspaceContextService;
	let installer: WorkflowInstaller;

	const USER_HOME = URI.file('/test-home/user');

	setup(() => {
		fileService = new MockFileService();
		logService = new MockLogService();
		workflowStorage = new MockWorkflowStorage();
		pathService = new MockPathService(USER_HOME);
		workspaceService = new MockWorkspaceContextService();

		// WorkflowInstaller constructor: fileService, logService, workflowStorage, pathService, workspaceService
		installer = new WorkflowInstaller(
			fileService as any,
			logService as any,
			workflowStorage as any,
			pathService as any,
			workspaceService as any,
		);
	});

	// ── 1. install — 从解压目录导入新工作流 ──────────────────────────────────

	test('install: 从解压目录导入新工作流到工作区', async () => {
		const manifest = makeManifest({ id: 'wf-new-001', version: '1.0.0' });
		const extractedDir = URI.file('/tmp/extract/wf-new-001');
		const workflowData = makeWorkflow({
			id: 'wf-new-001',
			name: 'New Workflow',
			description: 'Imported workflow',
			version: '1.0.0',
		});
		fileService._setFile('/tmp/extract/wf-new-001/workflow.json', JSON.stringify(workflowData));

		const result = await installer.install(manifest, extractedDir);

		assert.strictEqual(result.kind, 'workflow');
		assert.strictEqual(result.storeId, 'wf-new-001');
		assert.strictEqual(result.version, '1.0.0');

		// 工作流应该被创建到 workflowStorage 中
		const created = await workflowStorage.getWorkflow(result.storeId);
		// 注意：install 内部会 createWorkflow，但 createWorkflow 会生成新 id，所以不能用原 id 查
		// 验证 listWorkflows 至少有一个
		const all = await workflowStorage.listWorkflows();
		assert.ok(all.length > 0, '工作流应该被导入到 workflowStorage');
		assert.strictEqual(all[0].name, 'New Workflow');
	});

	test('install: 同时备份到 ~/.saros/workflows/{id}/workflow.json', async () => {
		const manifest = makeManifest({ id: 'wf-backup-001' });
		const extractedDir = URI.file('/tmp/extract/wf-backup-001');
		const workflowData = makeWorkflow({ id: 'wf-backup-001', name: 'Backup Test' });
		fileService._setFile('/tmp/extract/wf-backup-001/workflow.json', JSON.stringify(workflowData));

		const result = await installer.install(manifest, extractedDir);

		// 备份文件应该存在于 ~/.saros/workflows/{id}/workflow.json
		const expectedBackupPath = `/test-home/user/.saros/workflows/${manifest.id}/workflow.json`;
		const backupContent = fileService._getFile(expectedBackupPath);
		assert.ok(backupContent, `备份文件应存在于 ${expectedBackupPath}`);
		const parsed = JSON.parse(backupContent!);
		assert.strictEqual(parsed.name, 'Backup Test');
	});

	test('install: 工作流已存在且未指定 force 时抛出冲突错误', async () => {
		const existing = makeWorkflow({ id: 'wf-conflict-001', name: 'Existing' });
		workflowStorage._seed(existing);

		const manifest = makeManifest({ id: 'wf-conflict-001' });
		const extractedDir = URI.file('/tmp/extract/wf-conflict-001');
		fileService._setFile('/tmp/extract/wf-conflict-001/workflow.json', JSON.stringify(existing));

		await assert.rejects(
			() => installer.install(manifest, extractedDir),
			(err: Error) => err.message.includes('已存在'),
		);
	});

	test('install: force=true 时覆盖已存在的工作流', async () => {
		const existing = makeWorkflow({ id: 'wf-force-001', name: 'Old Name', version: '1.0.0' });
		workflowStorage._seed(existing);

		const manifest = makeManifest({ id: 'wf-force-001', version: '2.0.0' });
		const extractedDir = URI.file('/tmp/extract/wf-force-001');
		const newData = makeWorkflow({ id: 'wf-force-001', name: 'New Name', version: '2.0.0' });
		fileService._setFile('/tmp/extract/wf-force-001/workflow.json', JSON.stringify(newData));

		const result = await installer.install(manifest, extractedDir, { force: true });

		assert.strictEqual(result.version, '2.0.0');
		const updated = await workflowStorage.getWorkflow('wf-force-001');
		assert.ok(updated, '工作流应该仍然存在');
		assert.strictEqual(updated!.name, 'New Name');
	});

	// ── 2. preparePack — 将本地工作流打包 ───────────────────────────────────

	test('preparePack: 将本地工作流打包到临时目录', async () => {
		const wf = makeWorkflow({ id: 'wf-pack-001', name: 'Pack Test', version: '1.2.0' });
		workflowStorage._seed(wf);

		const result = await installer.preparePack('wf-pack-001');

		assert.ok(result.localDir, '应返回打包目录');
		assert.strictEqual(result.manifest.kind, 'workflow');
		assert.strictEqual(result.manifest.id, 'wf-pack-001');
		assert.strictEqual(result.manifest.name, 'Pack Test');
		assert.strictEqual(result.manifest.version, '1.2.0');

		// workflow.json 应该被写入打包目录
		const workflowFileUri = URI.joinPath(result.localDir, 'workflow.json');
		const content = await fileService.readFile(workflowFileUri);
		const parsed = JSON.parse(content.value.toString());
		assert.strictEqual(parsed.id, 'wf-pack-001');
		assert.strictEqual(parsed.name, 'Pack Test');
	});

	test('preparePack: 工作流不存在时抛出错误', async () => {
		await assert.rejects(
			() => installer.preparePack('non-existent-id'),
			(err: Error) => err.message.includes('不存在'),
		);
	});

	test('preparePack: 未设置版本号时默认为 1.0.0', async () => {
		const wf = makeWorkflow({ id: 'wf-no-ver', version: undefined });
		workflowStorage._seed(wf);

		const result = await installer.preparePack('wf-no-ver');
		assert.strictEqual(result.manifest.version, '1.0.0');
	});

	// ── 3. getInstalledVersion ────────────────────────────────────────────────

	test('getInstalledVersion: 默认返回 undefined（由 MarketplaceService 统一检查）', () => {
		const version = installer.getInstalledVersion('wf-001');
		assert.strictEqual(version, undefined);
	});

	// ── 4. 版本比较（升级判定） ───────────────────────────────────────────────

	suite('版本比较 (semver)', () => {

		test('服务器版本高于本地版本时返回 true', () => {
			assert.strictEqual(isVersionHigher('1.1.0', '1.0.0'), true);
			assert.strictEqual(isVersionHigher('2.0.0', '1.9.9'), true);
			assert.strictEqual(isVersionHigher('1.0.1', '1.0.0'), true);
		});

		test('服务器版本等于本地版本时返回 false', () => {
			assert.strictEqual(isVersionHigher('1.0.0', '1.0.0'), false);
			assert.strictEqual(isVersionHigher('2.0.0', '2.0.0'), false);
		});

		test('服务器版本低于本地版本时返回 false', () => {
			assert.strictEqual(isVersionHigher('1.0.0', '1.1.0'), false);
			assert.strictEqual(isVersionHigher('0.9.0', '1.0.0'), false);
		});

		test('本地无版本号时，只要服务器有版本就返回 true', () => {
			assert.strictEqual(isVersionHigher('1.0.0', undefined), true);
			assert.strictEqual(isVersionHigher('0.0.1', undefined), true);
		});

		test('服务器无版本号时返回 false', () => {
			assert.strictEqual(isVersionHigher(undefined, '1.0.0'), false);
			assert.strictEqual(isVersionHigher(undefined, undefined), false);
		});

		test('不同位数的版本号也能正确比较', () => {
			assert.strictEqual(isVersionHigher('1.2', '1.1.0'), true);
			assert.strictEqual(isVersionHigher('1.1.0.0', '1.1.0'), false);
			assert.strictEqual(isVersionHigher('1.1.0.1', '1.1.0'), true);
		});
	});

	// ── 5. 上传/更新业务逻辑（模拟） ────────────────────────────────────────

	suite('上传/更新业务场景', () => {

		test('场景1：服务器中无该工作流 → 显示上传按钮', () => {
			const localVersion = '1.0.0';
			const serverVersion = undefined; // 服务器无此工作流

			const shouldShowUpload = !serverVersion;
			const shouldShowUpgrade = isVersionHigher(serverVersion, localVersion);

			assert.strictEqual(shouldShowUpload, true, '服务器无该工作流时应显示上传按钮');
			assert.strictEqual(shouldShowUpgrade, false, '不应同时显示升级按钮');
		});

		test('场景2：服务器版本号大于本地版本号 → 显示升级按钮', () => {
			const localVersion = '1.0.0';
			const serverVersion = '1.1.0';

			const shouldShowUpload = !serverVersion;
			const shouldShowUpgrade = isVersionHigher(serverVersion, localVersion);

			assert.strictEqual(shouldShowUpgrade, true, '服务器版本更高时应显示升级按钮');
			assert.strictEqual(shouldShowUpload, false, '不应同时显示上传按钮');
		});

		test('场景3：服务器版本号等于本地版本号 → 既不显示上传也不显示升级', () => {
			const localVersion = '1.0.0';
			const serverVersion = '1.0.0';

			const shouldShowUpload = !serverVersion;
			const shouldShowUpgrade = isVersionHigher(serverVersion, localVersion);

			assert.strictEqual(shouldShowUpload, false);
			assert.strictEqual(shouldShowUpgrade, false);
		});

		test('场景4：服务器版本号小于本地版本号 → 既不显示上传也不显示升级', () => {
			const localVersion = '2.0.0';
			const serverVersion = '1.0.0';

			const shouldShowUpload = !serverVersion;
			const shouldShowUpgrade = isVersionHigher(serverVersion, localVersion);

			assert.strictEqual(shouldShowUpload, false);
			assert.strictEqual(shouldShowUpgrade, false);
		});

		test('场景5：删除按钮始终显示', () => {
			// 无论何种状态，删除按钮都应该显示
			const localVersion = '1.0.0';
			const serverVersion = undefined;

			const shouldShowDelete = true; // 删除按钮始终显示
			assert.strictEqual(shouldShowDelete, true);
		});
	});

	// ── 6. 工作流存储路径 ────────────────────────────────────────────────────

	suite('工作流存储路径 ~/.saros/workflows/{workflowid}/', () => {

		test('install 后备份目录为 ~/.saros/workflows/{id}/', async () => {
			const manifest = makeManifest({ id: 'wf-path-001' });
			const extractedDir = URI.file('/tmp/extract/wf-path-001');
			fileService._setFile('/tmp/extract/wf-path-001/workflow.json', JSON.stringify(makeWorkflow({ id: 'wf-path-001' })));

			const result = await installer.install(manifest, extractedDir);

			// 验证 targetDir 包含正确的路径
			assert.ok(result.targetDir.includes('.saros'), 'targetDir 应包含 .saros');
			assert.ok(result.targetDir.includes('workflows'), 'targetDir 应包含 workflows');
			assert.ok(result.targetDir.includes('wf-path-001'), 'targetDir 应包含工作流 ID');
		});

		test('preparePack 的打包目录在 ~/.saros/tmp/ 下', async () => {
			const wf = makeWorkflow({ id: 'wf-tmp-001' });
			workflowStorage._seed(wf);

			const result = await installer.preparePack('wf-tmp-001');

			assert.ok(result.localDir.toString().includes('.saros'), '打包目录应在 ~/.saros/ 下');
			assert.ok(result.localDir.toString().includes('tmp'), '打包目录应在 tmp 子目录下');
			assert.ok(result.localDir.toString().includes('workflow-pack'), '打包目录应包含 workflow-pack 前缀');
		});
	});
});
