/*---------------------------------------------------------------------------------------------
 *  Integration test: WorkflowStorageService → WorkflowVersionService auto-commit hooks.
 *
 *  Verifies that createWorkflow() triggers init() and updateWorkflow() triggers
 *  autoCommit() on the injected IWorkflowVersionService, and that failures in
 *  the version service do not crash storage operations.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { WorkflowStorageService } from '../../browser/workflowStorageService.js';
import type { IWorkflowVersionService } from '../../common/workflowVersionTypes.js';

// ─── Mock services ──────────────────────────────────────────────────────────

class MockLogService {
	logs: string[] = [];
	info(msg: string) { this.logs.push(msg); }
	warn(msg: string, err?: any) { this.logs.push(`${msg} ${err instanceof Error ? err.message : String(err ?? '')}`); }
	error(msg: string, _err?: any) { this.logs.push(msg); }
	trace(_msg: string) { /* noop */ }
}

class MockFileService {
	written: Map<string, string> = new Map();
	dirs: Set<string> = new Set();
	nextStatError = false;
	// Keyed by URI.toString()
	private readonly _files: Map<string, string> = new Map();

	async stat(_uri: any): Promise<any> {
		if (this.nextStatError) throw new Error('mock stat error');
		return { type: 'file' };
	}
	async createFolder(uri: any): Promise<void> {
		this.dirs.add(uri.toString());
	}
	async writeFile(uri: any, buffer: any): Promise<void> {
		const key = uri.toString();
		this.written.set(key, buffer.toString());
		this._files.set(key, buffer.toString());
	}
	async readFile(uri: any): Promise<any> {
		const key = uri.toString();
		const content = this._files.get(key);
		if (content) {
			return { value: { toString: () => content } };
		}
		throw new Error('mock file not found');
	}
	/**
	 * `del` 必须**真删**：跨进程写锁（`common/fileWriteLock.ts`）靠 `del` 释放锁文件，
	 * noop 会让第二个用例撞上"锁已存在" ⇒ 连坐全红。
	 * （只删 `_files`，不动 `written` —— 业务断言看的是后者，锁文件不该污染它。）
	 */
	async del(uri: any, _opts?: any): Promise<void> {
		this._files.delete(uri.toString());
	}

	/**
	 * ★ 2026-10-20 补（此前缺这个方法 ⇒ `WorkflowStorageService — version hooks` 6 例**全红**）：
	 * `acquireFileLock` 用 `createFile(resource, VSBuffer.fromString(text), { overwrite: false })`
	 * 做**原子占位**（已存在 ⇒ 抛 ⇒ 调用方判"被别的进程占着"）。
	 * 症状原文：`写锁创建失败（…workflow.json.lock）：fileService.createFile is not a function`。
	 */
	async createFile(uri: any, buffer: any, opts?: { overwrite?: boolean }): Promise<void> {
		const key = uri.toString();
		if (this._files.has(key) && opts?.overwrite === false) {
			throw new Error('mock file already exists');
		}
		this._files.set(key, buffer.toString());
	}

	/**
	 * ★ 2026-10-20 补：`common/atomicWrite.ts` 先探能力再决定走原子写还是普通写
	 * （`fileService.hasCapability(resource, FileSystemProviderCapabilities.FileAtomicWrite)`）。
	 * 假件缺这个方法会 `TypeError: fileService.hasCapability is not a function`。
	 * 返回 `false` ⇒ 走普通 `writeFile` 分支（本假件已实现，语义与真实磁盘写入一致）。
	 */
	hasCapability(): boolean {
		return false;
	}
}

class MockStudioService {
	getActiveWorkspaceId(): string { return 'ws-1'; }
}

class MockEnvService {
	userDataPath = '/mock/user/data';
}

class MockVersionService implements IWorkflowVersionService {
	_serviceBrand: undefined;
	initCalls: string[] = [];
	autoCommitCalls: string[] = [];
	initShouldThrow = false;
	autoCommitShouldThrow = false;
	autoCommitReturnSha: string | null = 'abc123';

	isAvailable(): boolean { return true; }

	async init(workflowId: string): Promise<void> {
		this.initCalls.push(workflowId);
		if (this.initShouldThrow) throw new Error('mock init error');
	}

	async autoCommit(workflowId: string): Promise<string | null> {
		this.autoCommitCalls.push(workflowId);
		if (this.autoCommitShouldThrow) throw new Error('mock autoCommit error');
		return this.autoCommitReturnSha;
	}

	async history(_workflowId: string, _limit?: number): Promise<any[]> { return []; }
	async diff(_workflowId: string, _sha: string): Promise<any> { return null; }
	async workflowAtVersion(_workflowId: string, _sha: string): Promise<string> { return ''; }
	async rollback(_workflowId: string, _sha: string): Promise<string> { return ''; }
}

// ─── Factory ────────────────────────────────────────────────────────────────

function createService(versionService: MockVersionService): { storage: WorkflowStorageService; log: MockLogService; file: MockFileService } {
	const log = new MockLogService();
	const file = new MockFileService();
	const studio = new MockStudioService();
	const env = new MockEnvService();

	const storage = new (WorkflowStorageService as any)(
		log, file, studio, env, versionService,
	);

	return { storage, log, file };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

suite('WorkflowStorageService — version hooks', () => {

	test('createWorkflow() calls versionService.init()', async () => {
		const version = new MockVersionService();
		const { storage } = createService(version);

		const wf = await storage.createWorkflow({ name: 'Test WF' });
		assert.ok(wf.id.startsWith('wf-'), 'should generate workflow id');
		// init() is fire-and-forget, give it a tick
		await new Promise(r => setTimeout(r, 50));
		assert.strictEqual(version.initCalls.length, 1, 'init() should be called once');
		assert.strictEqual(version.initCalls[0], wf.id, 'init() should receive workflow id');
	});

	test('updateWorkflow() calls versionService.autoCommit()', async () => {
		const version = new MockVersionService();
		const { storage, file } = createService(version);

		// Pre-create a workflow file so getWorkflow() succeeds
		const wf = await storage.createWorkflow({ name: 'Test WF' });
		// Ensure the file is "on disk" (mocked)
		assert.ok(file.written.size > 0, 'createWorkflow should write file');

		await storage.updateWorkflow(wf.id, { name: 'Updated WF' });
		// autoCommit is fire-and-forget
		await new Promise(r => setTimeout(r, 50));
		assert.strictEqual(version.autoCommitCalls.length, 1, 'autoCommit() should be called once');
		assert.strictEqual(version.autoCommitCalls[0], wf.id, 'autoCommit() should receive workflow id');
	});

	test('updateWorkflow() with opts.autoCommit=false skips autoCommit (auto-save)', async () => {
		const version = new MockVersionService();
		const { storage } = createService(version);

		const wf = await storage.createWorkflow({ name: 'Test WF' });
		await new Promise(r => setTimeout(r, 50));
		// 清掉 createWorkflow 里的 init 计数（init 不算 autoCommit）
		version.autoCommitCalls.length = 0;

		await storage.updateWorkflow(wf.id, { name: 'auto-saved' }, undefined, { autoCommit: false });
		await new Promise(r => setTimeout(r, 50));
		assert.strictEqual(version.autoCommitCalls.length, 0, 'auto-save 不应触发 autoCommit（版本爆炸防护）');
	});

	test('versionService.init() failure does not crash createWorkflow()', async () => {
		const version = new MockVersionService();
		version.initShouldThrow = true;
		const { storage, log } = createService(version);

		// Should NOT throw
		const wf = await storage.createWorkflow({ name: 'Resilient WF' });
		assert.ok(wf.id.startsWith('wf-'), 'should still return workflow');
		await new Promise(r => setTimeout(r, 50));
		assert.ok(log.logs.some(l => l.includes('mock init error')), 'should log the version init failure');
	});

	test('versionService.autoCommit() failure does not crash updateWorkflow()', async () => {
		const version = new MockVersionService();
		version.autoCommitShouldThrow = true;
		const { storage, log } = createService(version);

		const wf = await storage.createWorkflow({ name: 'Test WF' });
		await new Promise(r => setTimeout(r, 50));

		const updated = await storage.updateWorkflow(wf.id, { description: 'new desc' });
		assert.strictEqual(updated.description, 'new desc', 'update should succeed');
		await new Promise(r => setTimeout(r, 50));
		assert.ok(log.logs.some(l => l.includes('mock autoCommit error')), 'should log the autoCommit failure');
	});

	test('updateWorkflow preserves id immutability', async () => {
		const version = new MockVersionService();
		const { storage } = createService(version);

		const wf = await storage.createWorkflow({ name: 'Immutable' });
		await new Promise(r => setTimeout(r, 50));

		const updated = await storage.updateWorkflow(wf.id, { id: 'hacked-id' } as any);
		assert.strictEqual(updated.id, wf.id, 'id must not change');
	});
});
