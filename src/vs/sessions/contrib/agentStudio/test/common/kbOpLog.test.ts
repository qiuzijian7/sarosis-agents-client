/*---------------------------------------------------------------------------------------------
 *  Knowledge Base operation log — unit tests
 *
 *  Covers `appendKbOpLog` (JSONL append semantics, best-effort contract)
 *  and `resolveKbRoot` (the storage root that determines where the
 *  `.op-log.jsonl` file lives). A tiny in-memory `IFileService` stands in
 *  for the real disk-backed one so the tests stay environment-agnostic.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';

/**
 * Normalize a path to posix style (`URI.file().path`) so assertions are
 * stable across Windows / Linux / macOS (same trick as workspacePathResolver.test.ts).
 */
function normPath(p: string): string {
	return URI.file(p).path;
}
import { IFileService } from '../../../../../platform/files/common/files.js';
import {
	appendKbOpLog,
	kbOpLogUri,
	KB_OP_LOG_FILE,
	IKbOpLogEntry,
} from '../../browser/knowledge/kbOpLog.js';
import { resolveKbRoot } from '../../browser/knowledge/knowledgeStorage.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/** Minimal in-memory IFileService: only the 3 methods `appendKbOpLog` uses. */
class MemFs {
	private store = new Map<string, string>();
	public writeShouldFail = false;

	async createFolder(_uri: URI): Promise<unknown> {
		return undefined;
	}
	async readFile(uri: URI): Promise<{ value: VSBuffer }> {
		const content = this.store.get(uri.fsPath);
		if (content === undefined) {
			throw new Error('ENOENT: ' + uri.fsPath);
		}
		return { value: VSBuffer.fromString(content) };
	}
	async writeFile(uri: URI, content: VSBuffer): Promise<void> {
		if (this.writeShouldFail) {
			throw new Error('EIO: write failed');
		}
		this.store.set(uri.fsPath, content.toString());
	}
	getContent(uri: URI): string | undefined {
		return this.store.get(uri.fsPath);
	}
}

/** Read back the op-log as a parsed array of entries. */
function readEntries(fs: MemFs, root: string): IKbOpLogEntry[] {
	const raw = fs.getContent(kbOpLogUri(root)) ?? '';
	return raw
		.split('\n')
		.filter(l => l.trim().length > 0)
		.map(l => JSON.parse(l) as IKbOpLogEntry);
}

suite('kbOpLog - appendKbOpLog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let mem: MemFs;
	let fs: IFileService;
	const root = '/home/user/.saros/kb';

	setup(() => {
		mem = new MemFs();
		fs = mem as unknown as IFileService;
	});

	test('kbOpLogUri points at <root>/.op-log.jsonl', () => {
		assert.strictEqual(kbOpLogUri(root).fsPath, join(root, KB_OP_LOG_FILE));
	});

	test('first append creates the file with a single valid JSONL line', async () => {
		await appendKbOpLog(fs, root, {
			ts: '2026-07-09T00:00:00.000Z',
			op: 'kb_build',
			channel: 'engine',
			status: 'success',
			target: 'kb_123',
		});
		const entries = readEntries(mem, root);
		assert.strictEqual(entries.length, 1, 'exactly one line written');
		assert.deepStrictEqual(entries[0], {
			ts: '2026-07-09T00:00:00.000Z',
			op: 'kb_build',
			channel: 'engine',
			status: 'success',
			target: 'kb_123',
		});
	});

	test('multiple appends accumulate into multiple parseable lines, in order', async () => {
		const ops = ['vault.create', 'kb.import.folder', 'note.update'];
		for (let i = 0; i < ops.length; i++) {
			await appendKbOpLog(fs, root, {
				ts: `2026-07-09T00:00:0${i}.000Z`,
				op: ops[i],
				channel: i % 2 === 0 ? 'vault' : 'engine',
				status: 'success',
			});
		}
		const entries = readEntries(mem, root);
		assert.strictEqual(entries.length, 3);
		assert.deepStrictEqual(entries.map(e => e.op), ops);
	});

	test('missing file (read throws) is swallowed → first line still written', async () => {
		// mem starts empty; readFile throws → must not abort the write.
		await appendKbOpLog(fs, root, {
			ts: '2026-07-09T00:00:00.000Z',
			op: 'note.create',
			channel: 'vault',
			status: 'success',
		});
		const entries = readEntries(mem, root);
		assert.strictEqual(entries.length, 1);
	});

	test('ts is auto-filled with an ISO timestamp when omitted', async () => {
		await appendKbOpLog(fs, root, {
			op: 'kb_search',
			channel: 'engine',
			status: 'success',
		});
		const entries = readEntries(mem, root);
		assert.strictEqual(entries.length, 1);
		assert.ok(typeof entries[0].ts === 'string');
		assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(entries[0].ts), 'ts looks like ISO-8601');
	});

	test('optional source/target/detail/error fields round-trip', async () => {
		await appendKbOpLog(fs, root, {
			ts: '2026-07-09T00:00:00.000Z',
			op: 'kb.import.url',
			channel: 'vault',
			status: 'failure',
			source: 'https://example.com/doc',
			detail: { kind: 'url' },
			error: 'network timeout',
		});
		const entries = readEntries(mem, root);
		assert.strictEqual(entries.length, 1);
		const e = entries[0];
		assert.strictEqual(e.source, 'https://example.com/doc');
		assert.deepStrictEqual(e.detail, { kind: 'url' });
		assert.strictEqual(e.error, 'network timeout');
		assert.strictEqual(e.status, 'failure');
	});

	test('newline safety: existing content without trailing newline stays separated', async () => {
		// Simulate a pre-existing file with one line and NO trailing newline.
		const uri = kbOpLogUri(root);
		(mem as { store: Map<string, string> }).store.set(
			uri.fsPath,
			JSON.stringify({ ts: 't1', op: 'a', channel: 'vault', status: 'success' }),
		);
		await appendKbOpLog(fs, root, {
			ts: 't2',
			op: 'b',
			channel: 'engine',
			status: 'success',
		});
		const raw = mem.getContent(uri)!;
		const lines = raw.split('\n').filter(l => l.trim().length > 0);
		assert.strictEqual(lines.length, 2, 'no extra blank lines, exactly two entries');
		assert.deepStrictEqual(JSON.parse(lines[0]).op, 'a');
		assert.deepStrictEqual(JSON.parse(lines[1]).op, 'b');
	});

	test('best-effort: a throwing writeFile does NOT reject the promise', async () => {
		mem.writeShouldFail = true;
		// Must resolve, not throw — logging must never break the operation.
		await appendKbOpLog(fs, root, {
			ts: '2026-07-09T00:00:00.000Z',
			op: 'kb_delete',
			channel: 'engine',
			status: 'success',
		});
		assert.ok(true);
	});
});

suite('kbOpLog - storage root resolution', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const home = '/home/vssaros';

	test('empty config → <userHome>/.saros/kb', () => {
		assert.strictEqual(normPath(resolveKbRoot('', home)), normPath(join(home, '.saros', 'kb')));
		assert.strictEqual(normPath(resolveKbRoot(undefined, home)), normPath(join(home, '.saros', 'kb')));
	});

	test('"~" prefix expands to the user home', () => {
		assert.strictEqual(normPath(resolveKbRoot('~/kbroot', home)), normPath(join(home, 'kbroot')));
	});

	test('absolute path is used as-is', () => {
		assert.strictEqual(resolveKbRoot('/data/kb', home), '/data/kb');
	});

	test('relative path is resolved against the user home', () => {
		assert.strictEqual(normPath(resolveKbRoot('mykb', home)), normPath(join(home, 'mykb')));
	});

	test('trailing separators + "~" normalize into the op-log path', () => {
		const resolved = resolveKbRoot('~/kb/', home);
		assert.strictEqual(kbOpLogUri(resolved).fsPath, join(home, 'kb', KB_OP_LOG_FILE));
	});
});
