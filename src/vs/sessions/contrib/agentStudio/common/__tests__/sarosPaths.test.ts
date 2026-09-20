/*---------------------------------------------------------------------------------------------
 *  Unit tests for sarosPaths — unified Agent Studio data root resolution and
 *  the one-time legacy `~/.agent-studio/data/` migration helper.
 *
 *  Run with the bundled esbuild runner:
 *    node src/.../common/__tests__/run-sarospaths-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { test } from 'node:test';

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';

import {
	resolveAgentStudioDataRoot,
	migrateLegacyAgentStudioData,
	userDataRootFromRoamingHome,
} from '../sarosPaths.js';

// ── Minimal in-memory IFileService mock ──────────────────────────────────────

type MockNode = { isDirectory: boolean; content?: string };

class MockFileService {
	readonly nodes = new Map<string, MockNode>();

	private key(uri: URI): string {
		return uri.path;
	}

	seedFile(path: string, content: string): void {
		this.nodes.set(path, { isDirectory: false, content });
	}

	seedDir(path: string): void {
		this.nodes.set(path, { isDirectory: true });
	}

	async exists(uri: URI): Promise<boolean> {
		return this.nodes.has(this.key(uri));
	}

	async resolve(uri: URI): Promise<{ isDirectory: boolean; children?: { resource: URI; name: string; isDirectory: boolean }[] }> {
		const node = this.nodes.get(this.key(uri));
		if (!node) { throw new Error(`ENOENT: ${uri.path}`); }
		if (!node.isDirectory) { return { isDirectory: false }; }
		const prefix = uri.path.endsWith('/') ? uri.path : uri.path + '/';
		const children: { resource: URI; name: string; isDirectory: boolean }[] = [];
		for (const [p, n] of this.nodes) {
			if (!p.startsWith(prefix)) { continue; }
			const rest = p.slice(prefix.length);
			if (!rest || rest.includes('/')) { continue; }
			children.push({ resource: URI.joinPath(uri, rest), name: rest, isDirectory: n.isDirectory });
		}
		return { isDirectory: true, children };
	}

	async readFile(uri: URI): Promise<{ value: VSBuffer }> {
		const node = this.nodes.get(this.key(uri));
		if (!node || node.isDirectory) { throw new Error(`ENOENT: ${uri.path}`); }
		return { value: VSBuffer.fromString(node.content ?? '') };
	}

	async writeFile(uri: URI, value: VSBuffer): Promise<void> {
		this.nodes.set(this.key(uri), { isDirectory: false, content: value.toString() });
	}

	async createFolder(uri: URI): Promise<void> {
		this.nodes.set(this.key(uri), { isDirectory: true });
	}

	asService(): IFileService {
		return this as unknown as IFileService;
	}
}

const silentLog = {
	info: () => { /* noop */ },
	warn: () => { /* noop */ },
	debug: () => { /* noop */ },
} as unknown as ILogService;

const USER_HOME = URI.file('/home/u');
const ROAMING_HOME = URI.file('/home/u/.vssaros/User');

// ── resolveAgentStudioDataRoot ────────────────────────────────────────────────

test('resolveAgentStudioDataRoot: custom path wins', () => {
	const uri = resolveAgentStudioDataRoot('D:/custom/data', ROAMING_HOME);
	// URI.file 对 Windows 盘符会规范化为前导斜杠路径
	assert.strictEqual(uri.path, '/D:/custom/data');
});

test('resolveAgentStudioDataRoot: default = user data root (~/.vssaros/)', () => {
	const uri = resolveAgentStudioDataRoot(undefined, ROAMING_HOME);
	assert.strictEqual(uri.path, '/home/u/.vssaros');
	assert.strictEqual(uri.path, userDataRootFromRoamingHome(ROAMING_HOME).path);
});

test('resolveAgentStudioDataRoot: empty-string custom path falls back to default', () => {
	const uri = resolveAgentStudioDataRoot('', ROAMING_HOME);
	assert.strictEqual(uri.path, '/home/u/.vssaros');
});

// ── migrateLegacyAgentStudioData ──────────────────────────────────────────────

test('migrateLegacyAgentStudioData: legacy dir missing → no-op, no writes', async () => {
	const fs = new MockFileService();
	const target = URI.file('/home/u/.vssaros');
	await migrateLegacyAgentStudioData(fs.asService(), silentLog, USER_HOME, target, ['taskboard.json']);
	assert.strictEqual(fs.nodes.size, 0);
});

test('migrateLegacyAgentStudioData: copies listed files and dirs recursively', async () => {
	const fs = new MockFileService();
	fs.seedDir('/home/u/.agent-studio/data');
	fs.seedFile('/home/u/.agent-studio/data/taskboard.json', '[{"id":1}]');
	fs.seedFile('/home/u/.agent-studio/data/swarms.json', '[]');
	fs.seedDir('/home/u/.agent-studio/data/attachments');
	fs.seedDir('/home/u/.agent-studio/data/attachments/t1');
	fs.seedFile('/home/u/.agent-studio/data/attachments/t1/a.png', 'PNG');
	// 未列入 entries 的文件不迁移
	fs.seedFile('/home/u/.agent-studio/data/unrelated.json', '{}');

	const target = URI.file('/home/u/.vssaros');
	await migrateLegacyAgentStudioData(fs.asService(), silentLog, USER_HOME, target, ['taskboard.json', 'swarms.json', 'attachments']);

	assert.strictEqual(fs.nodes.get('/home/u/.vssaros/taskboard.json')?.content, '[{"id":1}]');
	assert.strictEqual(fs.nodes.get('/home/u/.vssaros/swarms.json')?.content, '[]');
	assert.strictEqual(fs.nodes.get('/home/u/.vssaros/attachments/t1/a.png')?.content, 'PNG');
	assert.strictEqual(fs.nodes.has('/home/u/.vssaros/unrelated.json'), false);
});

test('migrateLegacyAgentStudioData: never overwrites an existing target (idempotent re-run)', async () => {
	const fs = new MockFileService();
	fs.seedDir('/home/u/.agent-studio/data');
	fs.seedFile('/home/u/.agent-studio/data/taskboard.json', 'OLD');
	// 目标已有新数据
	fs.seedFile('/home/u/.vssaros/taskboard.json', 'NEW');

	await migrateLegacyAgentStudioData(fs.asService(), silentLog, USER_HOME, URI.file('/home/u/.vssaros'), ['taskboard.json']);
	assert.strictEqual(fs.nodes.get('/home/u/.vssaros/taskboard.json')?.content, 'NEW');
});

test('migrateLegacyAgentStudioData: entry failure does not block the rest', async () => {
	const fs = new MockFileService();
	fs.seedDir('/home/u/.agent-studio/data');
	// taskboard.json 存在（exists=true）但 resolve 会抛错 ⇒ 该条目迁移失败
	fs.seedFile('/home/u/.agent-studio/data/taskboard.json', 'X');
	fs.seedFile('/home/u/.agent-studio/data/swarms.json', '[]');

	const failing = new Proxy(fs, {
		get(targetObj, prop, receiver) {
			if (prop === 'resolve') {
				return async (uri: URI) => {
					if (uri.path.endsWith('taskboard.json')) { throw new Error('boom'); }
					return fs.resolve(uri);
				};
			}
			return Reflect.get(targetObj, prop, receiver);
		},
	});

	await migrateLegacyAgentStudioData(failing.asService(), silentLog, USER_HOME, URI.file('/home/u/.vssaros'), ['taskboard.json', 'swarms.json']);
	assert.strictEqual(fs.nodes.get('/home/u/.vssaros/swarms.json')?.content, '[]');
});
