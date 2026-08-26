/*---------------------------------------------------------------------------------------------
 *  Unit tests: 工作流资源子目录（scripts / bin）文件操作 + 路径穿越防护。
 *
 *  覆盖：
 *   - sanitizeRelPath 路径穿越防护（.. / 绝对路径 / 盘符 / 空 / NUL）
 *   - createWorkflow 预建 scripts/ 与 bin/ 目录
 *   - writeWorkflowFile / readWorkflowFile / listWorkflowFiles / deleteWorkflowFile
 *   - 子目录 relPath（sub/x.py）自动创建父目录
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { sanitizeRelPath, WorkflowStorageService } from '../../browser/workflowStorageService.js';
import type { IWorkflowVersionService } from '../../common/workflowVersionTypes.js';

// ─── sanitizeRelPath 纯函数测试 ───────────────────────────────────────────────

suite('sanitizeRelPath 路径穿越防护', () => {
	test('正常文件名通过', () => {
		assert.strictEqual(sanitizeRelPath('vox_pipeline.py'), 'vox_pipeline.py');
	});

	test('子目录路径通过并规范化为 /', () => {
		assert.strictEqual(sanitizeRelPath('sub\\dir\\x.py'), 'sub/dir/x.py');
		assert.strictEqual(sanitizeRelPath('sub/dir/x.py'), 'sub/dir/x.py');
	});

	test('拒绝 .. 段', () => {
		assert.throws(() => sanitizeRelPath('../x.py'));
		assert.throws(() => sanitizeRelPath('a/../../x.py'));
	});

	test('拒绝绝对路径（unix / 开头）', () => {
		assert.throws(() => sanitizeRelPath('/etc/passwd'));
	});

	test('拒绝绝对路径（win 盘符）', () => {
		assert.throws(() => sanitizeRelPath('C:/windows/x.py'));
		assert.throws(() => sanitizeRelPath('C:\\windows\\x.py'));
	});

	test('拒绝空路径', () => {
		assert.throws(() => sanitizeRelPath(''));
		assert.throws(() => sanitizeRelPath('   '));
	});

	test('拒绝 NUL 字符', () => {
		assert.throws(() => sanitizeRelPath('a\0b.py'));
	});
});

// ─── 集成测试（预建目录 + 文件操作）──────────────────────────────────────────

class MockLogService {
	info(_msg: string, ..._args: unknown[]) { /* noop */ }
	warn(_msg: string, ..._args: unknown[]) { /* noop */ }
	error(_msg: string, ..._args: unknown[]) { /* noop */ }
	trace(_msg: string) { /* noop */ }
}

class MockFileService {
	/** path → content */
	files: Map<string, string> = new Map();
	/** path → isDirectory */
	dirs: Map<string, boolean> = new Map();

	async stat(uri: any): Promise<any> {
		const key = uri.toString();
		if (this.dirs.has(key)) { return { type: 'dir', isDirectory: true }; }
		if (this.files.has(key)) { return { type: 'file', isDirectory: false }; }
		throw new Error('mock stat: not found');
	}
	async createFolder(uri: any): Promise<void> {
		this.dirs.set(uri.toString(), true);
	}
	async writeFile(uri: any, buffer: any): Promise<void> {
		const key = uri.toString();
		this.files.set(key, buffer.toString());
		this.dirs.delete(key);
	}
	async readFile(uri: any): Promise<any> {
		const key = uri.toString();
		const content = this.files.get(key);
		if (content !== undefined) {
			return { value: { toString: () => content } };
		}
		throw new Error('mock readFile: not found');
	}
	async resolve(uri: any): Promise<any> {
		const key = uri.toString();
		if (!this.dirs.has(key)) { throw new Error('mock resolve: dir not found'); }
		const children: Array<{ name: string; isDirectory: boolean; size?: number; mtime?: number; resource: any }> = [];
		const prefix = key.endsWith('/') ? key : key + '/';
		const seen = new Set<string>();
		for (const [p, isDir] of this.dirs) {
			if (p.startsWith(prefix) && p !== key) {
				const rest = p.slice(prefix.length).replace(/\/$/, '');
				if (!rest.includes('/')) {
					seen.add(rest);
					children.push({ name: rest, isDirectory: true, size: 0, mtime: 0, resource: { toString: () => p } });
				}
			}
		}
		for (const [p, content] of this.files) {
			if (p.startsWith(prefix)) {
				const rest = p.slice(prefix.length);
				if (!rest.includes('/')) {
					seen.add(rest);
					children.push({ name: rest, isDirectory: false, size: content.length, mtime: 1, resource: { toString: () => p } });
				}
			}
		}
		return { isDirectory: true, children };
	}
	async del(uri: any, _opts?: any): Promise<void> {
		const key = uri.toString();
		// 递归删除：删除所有以 key 为前缀的文件/目录
		const prefix = key.endsWith('/') ? key : key + '/';
		for (const p of [...this.files.keys()]) {
			if (p === key || p.startsWith(prefix)) { this.files.delete(p); }
		}
		for (const p of [...this.dirs.keys()]) {
			if (p === key || p.startsWith(prefix)) { this.dirs.delete(p); }
		}
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
	isAvailable(): boolean { return false; } // 禁用 git，隔离测试
	async init(_id: string): Promise<void> {}
	async autoCommit(_id: string): Promise<string | null> { return null; }
	async history(): Promise<any[]> { return []; }
	async diff(): Promise<any> { return null; }
	async workflowAtVersion(): Promise<string> { return ''; }
	async rollback(): Promise<string> { return ''; }
}

function createService(): { storage: WorkflowStorageService; file: MockFileService } {
	const file = new MockFileService();
	const storage = new (WorkflowStorageService as any)(
		new MockLogService(), file, new MockStudioService(), new MockEnvService(), new MockVersionService(),
	);
	return { storage, file };
}

suite('工作流资源子目录（scripts / bin）文件操作', () => {
	test('createWorkflow 预建 scripts/ 和 bin/ 目录', async () => {
		const { storage, file } = createService();
		const wf = await storage.createWorkflow({ name: 'Test WF' });
		// 断言 scripts/ 和 bin/ 目录已创建
		const keys = [...file.dirs.keys()];
		assert.ok(keys.some(k => k.includes(`/${wf.id}/scripts`)), 'scripts 目录应被预建');
		assert.ok(keys.some(k => k.includes(`/${wf.id}/bin`)), 'bin 目录应被预建');
	});

	test('writeWorkflowFile + readWorkflowFile 往返', async () => {
		const { storage } = createService();
		const wf = await storage.createWorkflow({ name: 'Test WF' });
		await storage.writeWorkflowFile(wf.id, 'scripts', 'vox_pipeline.py', 'print("hello")');
		const content = await storage.readWorkflowFile(wf.id, 'scripts', 'vox_pipeline.py');
		assert.strictEqual(content, 'print("hello")');
	});

	test('writeWorkflowFile 子目录 relPath 自动创建父目录', async () => {
		const { storage } = createService();
		const wf = await storage.createWorkflow({ name: 'Test WF' });
		await storage.writeWorkflowFile(wf.id, 'scripts', 'sub/dir/x.py', '# x');
		const content = await storage.readWorkflowFile(wf.id, 'scripts', 'sub/dir/x.py');
		assert.strictEqual(content, '# x');
	});

	test('listWorkflowFiles 列举（目录在前，文件按名）', async () => {
		const { storage } = createService();
		const wf = await storage.createWorkflow({ name: 'Test WF' });
		await storage.writeWorkflowFile(wf.id, 'scripts', 'b.py', 'b');
		await storage.writeWorkflowFile(wf.id, 'scripts', 'a.py', 'a');
		await storage.writeWorkflowFile(wf.id, 'scripts', 'sub/c.py', 'c');
		const files = await storage.listWorkflowFiles(wf.id, 'scripts');
		// sub 是目录（排前），a.py / b.py 按名排序
		assert.deepStrictEqual(files.map(f => f.name), ['sub', 'a.py', 'b.py']);
		assert.strictEqual(files[0].isDirectory, true);
	});

	test('readWorkflowFile 不存在返回 undefined', async () => {
		const { storage } = createService();
		const wf = await storage.createWorkflow({ name: 'Test WF' });
		const content = await storage.readWorkflowFile(wf.id, 'scripts', 'nope.py');
		assert.strictEqual(content, undefined);
	});

	test('deleteWorkflowFile 删除后读取为 undefined', async () => {
		const { storage } = createService();
		const wf = await storage.createWorkflow({ name: 'Test WF' });
		await storage.writeWorkflowFile(wf.id, 'bin', 'config.json', '{}');
		await storage.deleteWorkflowFile(wf.id, 'bin', 'config.json');
		assert.strictEqual(await storage.readWorkflowFile(wf.id, 'bin', 'config.json'), undefined);
	});

	test('writeWorkflowFile 拒绝路径穿越（..）', async () => {
		const { storage } = createService();
		const wf = await storage.createWorkflow({ name: 'Test WF' });
		await assert.rejects(() => storage.writeWorkflowFile(wf.id, 'scripts', '../evil.py', 'x'));
	});

	test('readWorkflowFile 拒绝绝对路径', async () => {
		const { storage } = createService();
		const wf = await storage.createWorkflow({ name: 'Test WF' });
		await assert.rejects(() => storage.readWorkflowFile(wf.id, 'scripts', '/etc/passwd'));
	});

	test('listWorkflowFiles 目录不存在返回空数组', async () => {
		const { storage } = createService();
		const files = await storage.listWorkflowFiles('wf-nonexistent', 'scripts');
		assert.deepStrictEqual(files, []);
	});
});
