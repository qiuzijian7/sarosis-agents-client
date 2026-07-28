/*---------------------------------------------------------------------------------------------
 *  Unit tests for FileContextStorageService (IContextStorage implementation).
 *
 *  Run with:
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/test/browser/contextStorageService.test.ts
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { FileContextStorageService } from '../../browser/contextStorageService.js';

/**
 * In-memory mock of IFileService for unit testing FileContextStorageService.
 */
class MockFileService {
	private _files = new Map<string, string>();
	private _dirs = new Set<string>();

	async exists(uri: URI): Promise<boolean> {
		const key = uri.toString();
		return this._files.has(key) || this._dirs.has(key);
	}

	async writeFile(uri: URI, buffer: { toString(): string }): Promise<void> {
		const key = uri.toString();
		const parentDir = key.substring(0, key.lastIndexOf('/'));
		if (parentDir) { this._dirs.add(parentDir); }
		this._files.set(key, buffer.toString());
	}

	async readFile(uri: URI): Promise<{ value: { toString(): string } }> {
		const key = uri.toString();
		const content = this._files.get(key);
		if (content === undefined) { throw new Error('File not found'); }
		return { value: { toString: () => content } };
	}

	async del(uri: URI): Promise<void> {
		this._files.delete(uri.toString());
	}

	async resolve(uri: URI): Promise<{ children?: { resource: URI; isFile: boolean }[] }> {
		const dirKey = uri.toString();
		const children: { resource: URI; isFile: boolean }[] = [];
		for (const [fileKey] of this._files) {
			if (fileKey.startsWith(dirKey) && fileKey !== dirKey) {
				children.push({ resource: URI.parse(fileKey), isFile: true });
			}
		}
		return { children };
	}
}

class MockLogService {
	error(..._args: any[]) { /* no-op */ }
	warn(..._args: any[]) { /* no-op */ }
	info(..._args: any[]) { /* no-op */ }
}

const TEST_ROOT = URI.parse('file:///test-user-data/');

function createService(): FileContextStorageService {
	return new FileContextStorageService(
		new MockFileService() as any,
		new MockLogService() as any,
		TEST_ROOT,
	);
}

suite('FileContextStorageService', () => {

	test('write then read round-trip', async () => {
		const svc = createService();
		const data = { name: 'auth', cognitive: 20, tags: ['security', 'auth'] };
		await svc.write('snapshot:abc123', data);
		const result = await svc.read('snapshot:abc123');
		assert.deepStrictEqual(result, data);
	});

	test('read non-existent key returns undefined', async () => {
		const svc = createService();
		const result = await svc.read('nonexistent:key');
		assert.strictEqual(result, undefined);
	});

	test('delete removes key', async () => {
		const svc = createService();
		await svc.write('template:t1', { id: 't1' });
		await svc.delete('template:t1');
		const result = await svc.read('template:t1');
		assert.strictEqual(result, undefined);
	});

	test('delete non-existent key does not throw', async () => {
		const svc = createService();
		await assert.doesNotReject(() => svc.delete('no-such-key'));
	});

	test('list by prefix returns matching keys', async () => {
		const svc = createService();
		await svc.write('snapshot:a', { id: 'a' });
		await svc.write('snapshot:b', { id: 'b' });
		await svc.write('summary:x', { id: 'x' });

		const snapshots = await svc.list('snapshot:');
		assert.strictEqual(snapshots.length, 2);
		assert.ok(snapshots.includes('snapshot:a'));
		assert.ok(snapshots.includes('snapshot:b'));

		const summaries = await svc.list('summary:');
		assert.strictEqual(summaries.length, 1);
		assert.ok(summaries.includes('summary:x'));

		const all = await svc.list('');
		assert.strictEqual(all.length, 3);
	});

	test('list with no files returns empty array', async () => {
		const svc = createService();
		const result = await svc.list('anything:');
		assert.deepStrictEqual(result, []);
	});

	test('overwrite existing key', async () => {
		const svc = createService();
		await svc.write('shared:orchestration-1', { version: 1, data: 'old' });
		await svc.write('shared:orchestration-1', { version: 2, data: 'new' });
		const result = await svc.read('shared:orchestration-1');
		assert.deepStrictEqual(result, { version: 2, data: 'new' });
	});

	test('handles complex nested data', async () => {
		const svc = createService();
		const complexData = {
			contexts: [{ id: 'c1', prompt: 'hello' }],
			handoffs: [{ from: 'agent-a', to: 'agent-b' }],
			metadata: { createdAt: Date.now(), deep: { nested: true } },
		};
		await svc.write('persist:complex', complexData);
		const result = await svc.read('persist:complex');
		assert.deepStrictEqual(result, complexData);
	});
});
