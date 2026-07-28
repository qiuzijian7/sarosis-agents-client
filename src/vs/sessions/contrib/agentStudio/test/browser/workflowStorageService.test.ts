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
	async del(_uri: any, _opts?: any): Promise<void> {
		/* noop */
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
