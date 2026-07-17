/*---------------------------------------------------------------------------------------------
 *  Folder → per-repo RAG build / cross-repo query / incremental re-ingest (Option A).
 *
 *  Drives the real `KnowledgeManager` engine with the deterministic HashEmbedder
 *  + MockChatModel (mirrors engine.test.ts) and a filesystem-free `FolderProbe`,
 *  so the full discover → build → search → re-ingest pipeline runs with no network,
 *  no VS Code runtime, and no 4GB heap pressure.
 *
 *  Run: node .../engine/__tests__/run-folderrag-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { test } from 'node:test';

import { IGitRepoProbe } from '../../../../common/gitRepoDiscovery.js';
import { IEmbedder } from '../embedder.js';
import { IChatModel, ExtractRequest } from '../llm.js';
import { KBStorageAdapter, KnowledgeManager, SerializedKB } from '../knowledgeManager.js';
import {
	aggregateItems, buildFolderRag, reingestRepo, searchAcrossRepos, searchInRepo,
	classifyRepoStrategy, computeRepoStats, extOf,
} from '../folderRagBuild.js';
import { searchFolderRag } from '../../knowledgeTools.js';

// ── Engine mocks (copied from engine.test.ts) ──────────────────────────────────

class HashEmbedder implements IEmbedder {
	readonly dimensions = 64;
	private readonly dims = 64;
	async embed(texts: string[]): Promise<number[][]> { return texts.map(t => this.one(t)); }
	async embedOne(text: string): Promise<number[]> { return this.one(text); }
	private one(text: string): number[] {
		const v = new Array(this.dims).fill(0);
		const words = String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
		for (const w of words) {
			let h = 0;
			for (let i = 0; i < w.length; i++) { h = (h * 31 + w.charCodeAt(i)) >>> 0; }
			v[h % this.dims] += 1;
		}
		const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
		return v.map(x => x / n);
	}
}

/** Extraction prompt that wraps the source text so the mock can recover it exactly. */
const DELIM = 'DOCSTART{source_text}DOCEND';

class MockChatModel implements IChatModel {
	constructor(private readonly handler: (req: ExtractRequest) => any) {}
	async extract<T = any>(req: ExtractRequest): Promise<T> { return this.handler(req) as T; }
	async complete(_s: string | undefined, u: string): Promise<string> {
		return `Answer. (${u.slice(-16)})`;
	}
}

function folderLlm(): MockChatModel {
	return new MockChatModel((req) => {
		const m = /DOCSTART([\s\S]*?)DOCEND/.exec(req.prompt);
		const text = m ? m[1] : req.prompt;
		const title = 'it_' + Math.abs(hashStr(text)).toString(36);
		return { items: [{ title, content: text }] };
	});
}

function hashStr(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
	return h;
}

class MemStorage implements KBStorageAdapter {
	private map = new Map<string, SerializedKB>();
	async read(id: string) { return this.map.get(id); }
	async write(id: string, p: SerializedKB) { this.map.set(id, p); }
	async remove(id: string) { this.map.delete(id); }
	async list() {
		return [...this.map.values()].map(p => {
			const m = (p.metadata ?? {}) as Record<string, any>;
			return { id: m.id, templateId: m.templateId, title: m.title, kind: m.kind, itemCount: 0, createdAt: m.createdAt ?? '', updatedAt: m.updatedAt ?? '' };
		});
	}
}

// ── Filesystem-free folder probe ────────────────────────────────────────────────

class FolderProbe implements IGitRepoProbe {
	constructor(
		private readonly tree: Map<string, string[]>,
		private readonly dirs: Set<string>,
		private readonly files: Map<string, string>,
	) {}

	async listFolder(path: string): Promise<readonly string[]> {
		const e = this.tree.get(path);
		if (!e) { throw new Error(`ENOENT: ${path}`); }
		return e;
	}
	async isDirectory(path: string): Promise<boolean> { return this.dirs.has(path); }
	async readFile(path: string): Promise<string | undefined> { return this.files.get(path); }
}

/** Throw when reading any path that contains `badMarker` (simulates a corrupt/unreadable file). */
class FaultyReadProbe extends FolderProbe {
	constructor(
		tree: Map<string, string[]>, dirs: Set<string>, files: Map<string, string>,
		private readonly badMarker: string,
	) { super(tree, dirs, files); }
	override async readFile(path: string): Promise<string | undefined> {
		if (path.includes(this.badMarker)) { throw new Error(`read failed: ${path}`); }
		return super.readFile(path);
	}
}

function baseName(p: string): string {
	const norm = p.endsWith('/') ? p.slice(0, -1) : p;
	const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
	return i >= 0 ? norm.slice(i + 1) : norm;
}

const OPTS = { config: { prompt: DELIM } as any, idForRepo: (r: string) => 'sess-' + baseName(r) };

// ── U2: buildFolderRag ──────────────────────────────────────────────────────────

test('T10 single repo → exactly one session, persisted', async () => {
	const tree = new Map<string, string[]>([
		['/root', ['.git', 'src']],
		['/root/src', ['a.ts']],
	]);
	const dirs = new Set(['/root', '/root/.git', '/root/src']);
	const files = new Map<string, string>([
		['/root/.git/HEAD', 'ref: refs/heads/main'],
		['/root/src/a.ts', 'auth token service login module'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const storage = new MemStorage();
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder(), storage });

	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	assert.strictEqual(res.sessions.size, 1);
	assert.strictEqual(res.sessions.get('/root'), 'sess-root');
	assert.ok(mgr.get('sess-root'), 'session registered in manager');
	assert.ok((await storage.list()).length === 1, 'session persisted');
	assert.ok(mgr.get('sess-root')!.meta.itemCount >= 1, 'items extracted');
});

test('T11 multiple sibling repos → N sessions, search stays isolated', async () => {
	const tree = new Map<string, string[]>([
		['/root', ['a', 'b']],
		['/root/a', ['.git', 'auth.ts']],
		['/root/b', ['.git', 'log.ts']],
	]);
	const dirs = new Set(['/root', '/root/a', '/root/a/.git', '/root/b', '/root/b/.git']);
	const files = new Map<string, string>([
		['/root/a/.git/HEAD', 'ref: refs/heads/main'],
		['/root/b/.git/HEAD', 'ref: refs/heads/main'],
		['/root/a/auth.ts', 'auth token service login credential'],
		['/root/b/log.ts', 'logging rotation file writer module'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });

	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	assert.strictEqual(res.sessions.size, 2);
	const aId = res.sessions.get('/root/a')!;
	const bId = res.sessions.get('/root/b')!;

	const aRes = await searchInRepo(mgr, aId, 'auth');
	const aTop = (aRes.items as any[])[0];
	assert.ok(String(aTop.content).includes('auth'), 'A returns A content');
	assert.ok(!String(aTop.content).includes('logging'), 'A does NOT leak B content');

	const bRes = await searchInRepo(mgr, bId, 'auth');
	const bTop = (bRes.items as any[])[0];
	assert.ok(!String(bTop.content).includes('auth'), 'B result is B-only (isolation)');
});

test('T12 noise dirs (node_modules) are skipped', async () => {
	const tree = new Map<string, string[]>([
		['/root', ['.git', 'src', 'node_modules']],
		['/root/src', ['app.ts']],
		['/root/node_modules', ['lib']],
		['/root/node_modules/lib', ['x.ts']],
	]);
	const dirs = new Set(['/root', '/root/.git', '/root/src', '/root/node_modules', '/root/node_modules/lib']);
	const files = new Map<string, string>([
		['/root/.git/HEAD', 'ref: refs/heads/main'],
		['/root/src/app.ts', 'auth token service'],
		['/root/node_modules/lib/x.ts', 'should be ignored third party'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });
	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	assert.strictEqual(res.sessions.get('/root') ? mgr.get(res.sessions.get('/root')!)!.meta.itemCount : 0, 1,
		'only the first-party src file is ingested');
});

test('T13 includeUnversioned builds a session for loose files', async () => {
	const tree = new Map<string, string[]>([
		['/root', ['a', 'c.txt']],
		['/root/a', ['.git', 'a.ts']],
	]);
	const dirs = new Set(['/root', '/root/a', '/root/a/.git']);
	const files = new Map<string, string>([
		['/root/a/.git/HEAD', 'ref: refs/heads/main'],
		['/root/a/a.ts', 'auth token service'],
		['/root/c.txt', 'loose notes not in any repo'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });
	const res = await buildFolderRag('/root', { manager: mgr, probe }, { ...OPTS, includeUnversioned: true });
	assert.strictEqual(res.sessions.size, 1, 'one git repo');
	assert.ok(res.unversionedSessionId, 'unversioned session created');
	const u = mgr.get(res.unversionedSessionId!)!;
	assert.ok(u.meta.itemCount >= 1, 'loose file ingested into unversioned session');
});

test('T14 idempotent rebuild → stable ids + stable counts', async () => {
	const tree = new Map<string, string[]>([
		['/root', ['a', 'b']],
		['/root/a', ['.git', 'auth.ts']],
		['/root/b', ['.git', 'log.ts']],
	]);
	const dirs = new Set(['/root', '/root/a', '/root/a/.git', '/root/b', '/root/b/.git']);
	const files = new Map<string, string>([
		['/root/a/.git/HEAD', 'ref: refs/heads/main'],
		['/root/b/.git/HEAD', 'ref: refs/heads/main'],
		['/root/a/auth.ts', 'auth token service'],
		['/root/b/log.ts', 'logging rotation module'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });
	const r1 = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	const r2 = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	assert.deepStrictEqual([...r1.sessions.entries()], [...r2.sessions.entries()], 'stable repoRoot→id map');
	assert.strictEqual(r1.errors.size, 0);
	assert.strictEqual(r2.errors.size, 0);
});

test('T15 fault isolation: one repo unreadable → others still built', async () => {
	const tree = new Map<string, string[]>([
		['/root', ['a', 'b']],
		['/root/a', ['.git', 'auth.ts']],
		['/root/b', ['.git', 'log.ts']],
	]);
	const dirs = new Set(['/root', '/root/a', '/root/a/.git', '/root/b', '/root/b/.git']);
	const files = new Map<string, string>([
		['/root/a/.git/HEAD', 'ref: refs/heads/main'],
		['/root/b/.git/HEAD', 'ref: refs/heads/main'],
		['/root/a/auth.ts', 'auth token service'],
		['/root/b/log.ts', 'logging rotation module'],
	]);
	const probe = new FaultyReadProbe(tree, dirs, files, '/b/log.ts');
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });
	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	assert.ok(res.sessions.has('/root/a'), 'A built');
	assert.ok(res.errors.has('/root/b'), 'B errored but did not abort A');
	assert.ok(mgr.get(res.sessions.get('/root/a')!)!.meta.itemCount >= 1);
});

test('T16 session title carries repo base name', async () => {
	const tree = new Map<string, string[]>([
		['/root', ['a']],
		['/root/a', ['.git', 'auth.ts']],
	]);
	const dirs = new Set(['/root', '/root/a', '/root/a/.git']);
	const files = new Map<string, string>([
		['/root/a/.git/HEAD', 'ref: refs/heads/main'],
		['/root/a/auth.ts', 'auth token service'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });
	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	const aId = res.sessions.get('/root/a')!;
	assert.ok(mgr.get(aId)!.meta.title.includes('a'), 'title includes repo base name');
});

test('T17 per-file streaming: many files → one item each (not one mega-string)', async () => {
	const tree = new Map<string, string[]>([
		['/root', ['.git', 'src']],
		['/root/src', ['f1.ts', 'f2.ts', 'f3.ts']],
	]);
	const dirs = new Set(['/root', '/root/.git', '/root/src']);
	const files = new Map<string, string>([
		['/root/.git/HEAD', 'ref: refs/heads/main'],
		['/root/src/f1.ts', 'alpha module'],
		['/root/src/f2.ts', 'beta module'],
		['/root/src/f3.ts', 'gamma module'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });
	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	assert.strictEqual(mgr.get(res.sessions.get('/root')!)!.meta.itemCount, 3, 'one item per file (chunked feed)');
});

// ── U3: cross-repo query routing ────────────────────────────────────────────────

test('T19 searchInRepo routes to a single session', async () => {
	// Built inside T11-style setup, but verify a direct single-session query.
	const tree = new Map<string, string[]>([
		['/root', ['a']],
		['/root/a', ['.git', 'auth.ts']],
	]);
	const dirs = new Set(['/root', '/root/a', '/root/a/.git']);
	const files = new Map<string, string>([
		['/root/a/.git/HEAD', 'ref: refs/heads/main'],
		['/root/a/auth.ts', 'auth token service'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });
	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	const aId = res.sessions.get('/root/a')!;
	const r = await searchInRepo(mgr, aId, 'auth');
	assert.strictEqual(r.type, 'list');
	assert.ok((r.items as any[]).length >= 1);
});

test('T20 searchAcrossRepos fans out and aggregates both repos', async () => {
	const tree = new Map<string, string[]>([
		['/root', ['a', 'b']],
		['/root/a', ['.git', 'auth.ts']],
		['/root/b', ['.git', 'log.ts']],
	]);
	const dirs = new Set(['/root', '/root/a', '/root/a/.git', '/root/b', '/root/b/.git']);
	const files = new Map<string, string>([
		['/root/a/.git/HEAD', 'ref: refs/heads/main'],
		['/root/b/.git/HEAD', 'ref: refs/heads/main'],
		['/root/a/auth.ts', 'auth token service login'],
		['/root/b/log.ts', 'logging rotation writer'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });
	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	const across = await searchAcrossRepos(mgr, res.sessions, 'code', 5);
	assert.strictEqual(across.hits.length, 2, 'both repos queried');
	assert.strictEqual(across.errors.length, 0);
	const agg = aggregateItems(across, 5);
	assert.strictEqual(agg.length, 2, 'both repos represented in aggregated items');
	const roots = new Set(agg.map(x => String(x['_repoRoot'])));
	assert.deepStrictEqual(roots, new Set(['/root/a', '/root/b']));
});

test('T21 empty session map → no hits, no errors', async () => {
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });
	const across = await searchAcrossRepos(mgr, new Map(), 'anything', 5);
	assert.strictEqual(across.hits.length, 0);
	assert.strictEqual(across.errors.length, 0);
});

test('T22 cross-repo ranking: query "auth" tops the auth repo', async () => {
	const tree = new Map<string, string[]>([
		['/root', ['a', 'b']],
		['/root/a', ['.git', 'auth.ts']],
		['/root/b', ['.git', 'log.ts']],
	]);
	const dirs = new Set(['/root', '/root/a', '/root/a/.git', '/root/b', '/root/b/.git']);
	const files = new Map<string, string>([
		['/root/a/.git/HEAD', 'ref: refs/heads/main'],
		['/root/b/.git/HEAD', 'ref: refs/heads/main'],
		['/root/a/auth.ts', 'auth token service login credential'],
		['/root/b/log.ts', 'logging rotation file writer'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });
	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	const across = await searchAcrossRepos(mgr, res.sessions, 'auth', 5);
	const agg = aggregateItems(across, 5);
	assert.strictEqual(String(agg[0]['_repoRoot']), '/root/a', 'auth query ranks repo A first');
});

test('T23 single repo failure isolated in cross-repo search', async () => {
	const tree = new Map<string, string[]>([
		['/root', ['a', 'b']],
		['/root/a', ['.git', 'auth.ts']],
		['/root/b', ['.git', 'log.ts']],
	]);
	const dirs = new Set(['/root', '/root/a', '/root/a/.git', '/root/b', '/root/b/.git']);
	const files = new Map<string, string>([
		['/root/a/.git/HEAD', 'ref: refs/heads/main'],
		['/root/b/.git/HEAD', 'ref: refs/heads/main'],
		['/root/a/auth.ts', 'auth token service'],
		['/root/b/log.ts', 'logging rotation'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });
	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	// Simulate A's session vanishing (e.g. evicted) → its search throws.
	mgr.delete(res.sessions.get('/root/a')!);
	const across = await searchAcrossRepos(mgr, res.sessions, 'code', 5);
	assert.strictEqual(across.hits.length, 1, 'B still returns');
	assert.strictEqual(across.errors.length, 1, 'A error isolated');
	assert.strictEqual(across.errors[0].repoRoot, '/root/a');
});

// ── U4: incremental re-ingest ───────────────────────────────────────────────────

test('T24 git pull adds a file → only that repo grows; sibling untouched', async () => {
	const tree = new Map<string, string[]>([
		['/root', ['a', 'b']],
		['/root/a', ['.git', 'auth.ts']],
		['/root/b', ['.git', 'log.ts']],
	]);
	const dirs = new Set(['/root', '/root/a', '/root/a/.git', '/root/b', '/root/b/.git']);
	const files = new Map<string, string>([
		['/root/a/.git/HEAD', 'ref: refs/heads/main'],
		['/root/b/.git/HEAD', 'ref: refs/heads/main'],
		['/root/a/auth.ts', 'auth token service'],
		['/root/b/log.ts', 'logging rotation'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });
	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	const aId = res.sessions.get('/root/a')!;
	const bId = res.sessions.get('/root/b')!;

	const bBefore = mgr.get(bId)!.meta.itemCount;
	const bUpdatedBefore = mgr.get(bId)!.updatedAt;

	// git pull: add a new file to repo A.
	dirs.add('/root/a');
	tree.set('/root/a', [...(tree.get('/root/a') ?? []), 'session.ts']);
	files.set('/root/a/session.ts', 'auth session store module');

	const r = await reingestRepo('/root/a', aId, { manager: mgr, probe }, OPTS);
	assert.strictEqual(r.itemCountAfter, r.itemCountBefore + 1, 'A grew by one');
	assert.strictEqual(mgr.get(bId)!.meta.itemCount, bBefore, 'B unchanged');
	assert.strictEqual(mgr.get(bId)!.updatedAt, bUpdatedBefore, 'B not re-touched');
});

test('T25 re-ingest of unchanged repo is idempotent', async () => {
	const tree = new Map<string, string[]>([
		['/root', ['a']],
		['/root/a', ['.git', 'auth.ts']],
	]);
	const dirs = new Set(['/root', '/root/a', '/root/a/.git']);
	const files = new Map<string, string>([
		['/root/a/.git/HEAD', 'ref: refs/heads/main'],
		['/root/a/auth.ts', 'auth token service'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });
	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	const aId = res.sessions.get('/root/a')!;
	const r = await reingestRepo('/root/a', aId, { manager: mgr, probe }, OPTS);
	assert.strictEqual(r.itemCountAfter, r.itemCountBefore, 'no duplicate explosion');
});

// ── U5: searchFolderRag (production cross-repo entry point) ─────────────────────

test('T26 searchFolderRag fans out across the global index in one call', async () => {
	// Build sessions with an in-memory storage so cross-repo search can re-load them.
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder(), storage: new MemStorage() });
	const tree = new Map<string, string[]>([
		['/root', ['a', 'b']],
		['/root/a', ['.git', 'auth.ts']],
		['/root/b', ['.git', 'log.ts']],
	]);
	const dirs = new Set(['/root', '/root/a', '/root/a/.git', '/root/b', '/root/b/.git']);
	const files = new Map<string, string>([
		['/root/a/.git/HEAD', 'ref: refs/heads/main'],
		['/root/b/.git/HEAD', 'ref: refs/heads/main'],
		['/root/a/auth.ts', 'auth token service login credential'],
		['/root/b/log.ts', 'logging rotation file writer'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);

	// searchFolderRag reads the global index and reuses the same manager instance.
	let cached = mgr;
	const deps = {
		fileService: {} as any,
		configurationService: {} as any,
		embeddingService: { isEnabled: () => true } as any,
		resolveBaseDir: async () => '/root',
		resolveStorageRoot: async () => '/kb',
		createManager: async () => cached,
		readFolderRagIndex: async () => Object.fromEntries(res.sessions),
	} as any;

	const out = await searchFolderRag(deps, 'auth service', 5);
	assert.strictEqual(out.repoCount, res.sessions.size, 'index size drives the fan-out');
	assert.ok(out.results.length >= 1, 'cross-repo hits returned');
	assert.strictEqual(out.errors.length, 0, 'no faults when every session loads');
	assert.ok(out.results.every(r => typeof r['_repoRoot'] === 'string'), 'each hit tagged with its source _repoRoot');
	assert.ok(new Set(out.results.map(r => String(r['_repoRoot']))).has('/root/a'), 'auth repo is represented');
});

test('T27 searchFolderRag isolates a stale/missing session (index drift) into errors', async () => {
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder(), storage: new MemStorage() });
	const tree = new Map<string, string[]>([
		['/root', ['a']],
		['/root/a', ['.git', 'auth.ts']],
	]);
	const dirs = new Set(['/root', '/root/a', '/root/a/.git']);
	const files = new Map<string, string>([
		['/root/a/.git/HEAD', 'ref: refs/heads/main'],
		['/root/a/auth.ts', 'auth token service login'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);

	let cached = mgr;
	const deps = {
		fileService: {} as any,
		configurationService: {} as any,
		embeddingService: { isEnabled: () => true } as any,
		resolveBaseDir: async () => '/root',
		resolveStorageRoot: async () => '/kb',
		createManager: async () => cached,
		// Index drift: a live repo + a stale session id whose KB was deleted.
		readFolderRagIndex: async () => ({ ...Object.fromEntries(res.sessions), '/root/gone': 'sess-gone' }),
	} as any;

	const out = await searchFolderRag(deps, 'auth', 5);
	assert.strictEqual(out.repoCount, res.sessions.size + 1, 'fan-out still covers the stale entry');
	assert.ok(out.errors.length >= 1, 'missing session isolated into errors (does not abort the rest)');
	assert.ok(out.results.length >= 1, 'healthy repos still return hits');
});

// ── U6: per-repo extraction strategy differentiation ───────────────────────────

test('T28 classifyRepoStrategy maps file-mix → strategy (code / docs / mixed / empty)', () => {
	// extOf edge cases: dotfiles have no extension; nested dirs don't leak.
	assert.strictEqual(extOf('/r/a.ts'), '.ts');
	assert.strictEqual(extOf('/r/.gitignore'), '', 'a leading-dot file has no extension');
	assert.strictEqual(extOf('/r/dir.d/README'), '', 'a dot in a dir segment is not an extension');
	assert.strictEqual(extOf('/r/MODEL.MD'), '.md', 'extension is lowercased');

	const codeStats = computeRepoStats([{ path: '/r/a.ts' }, { path: '/r/b.py' }, { path: '/r/README.md' }]);
	assert.deepStrictEqual(classifyRepoStrategy('/r', codeStats), { method: 'light_rag' }, 'code dominates → light_rag');

	const docStats = computeRepoStats([{ path: '/d/a.md' }, { path: '/d/b.md' }, { path: '/d/c.rst' }, { path: '/d/one.ts' }]);
	assert.deepStrictEqual(classifyRepoStrategy('/d', docStats), { templateId: 'notes_summary' }, 'docs dominate → notes_summary');

	const mixedStats = computeRepoStats([{ path: '/m/a.ts' }, { path: '/m/b.md' }]);
	assert.deepStrictEqual(classifyRepoStrategy('/m', mixedStats), { templateId: 'entity_list' }, '1:1 mix → entity_list');

	const emptyStats = computeRepoStats([{ path: '/e/logo.png' }, { path: '/e/data.bin' }]);
	assert.strictEqual(emptyStats.codeFiles + emptyStats.docFiles, 0, 'no code/doc files recognized');
	assert.deepStrictEqual(classifyRepoStrategy('/e', emptyStats), { templateId: 'entity_list' }, 'no known files → entity_list');
});

test('T29 buildFolderRag applies a different strategy per repo via chooseStrategy', async () => {
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder(), storage: new MemStorage() });
	// repo `code` is source-heavy; repo `docs` is prose-heavy.
	const tree = new Map<string, string[]>([
		['/root', ['code', 'docs']],
		['/root/code', ['.git', 'a.ts', 'b.ts']],
		['/root/docs', ['.git', 'guide.md', 'intro.md']],
	]);
	const dirs = new Set(['/root', '/root/code', '/root/code/.git', '/root/docs', '/root/docs/.git']);
	const files = new Map<string, string>([
		['/root/code/.git/HEAD', 'ref: refs/heads/main'],
		['/root/docs/.git/HEAD', 'ref: refs/heads/main'],
		['/root/code/a.ts', 'auth token service'],
		['/root/code/b.ts', 'session store cache'],
		['/root/docs/guide.md', 'installation and setup guide'],
		['/root/docs/intro.md', 'project overview and goals'],
	]);
	const probe = new FolderProbe(tree, dirs, files);

	// Use the production heuristic as the selector (no explicit templateId/method).
	const res = await buildFolderRag('/root', { manager: mgr, probe }, {
		config: { prompt: DELIM } as any,
		idForRepo: (r: string) => 'sess-' + baseName(r),
		chooseStrategy: classifyRepoStrategy,
	});
	assert.strictEqual(res.errors.size, 0, 'both repos build without error');

	const codeSession = mgr.get(res.sessions.get('/root/code')!)!;
	const docsSession = mgr.get(res.sessions.get('/root/docs')!)!;
	assert.strictEqual(codeSession.meta.templateId, 'light_rag', 'code repo → light_rag method');
	assert.strictEqual(codeSession.kind, 'graph', 'light_rag builds a graph session');
	assert.strictEqual(docsSession.meta.templateId, 'notes_summary', 'docs repo → notes_summary template');
	assert.strictEqual(docsSession.kind, 'list', 'notes_summary builds a list session');
});

test('T30 an explicit templateId/method overrides chooseStrategy for every repo', async () => {
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder(), storage: new MemStorage() });
	const tree = new Map<string, string[]>([
		['/root', ['code', 'docs']],
		['/root/code', ['.git', 'a.ts']],
		['/root/docs', ['.git', 'guide.md']],
	]);
	const dirs = new Set(['/root', '/root/code', '/root/code/.git', '/root/docs', '/root/docs/.git']);
	const files = new Map<string, string>([
		['/root/code/.git/HEAD', 'ref: refs/heads/main'],
		['/root/docs/.git/HEAD', 'ref: refs/heads/main'],
		['/root/code/a.ts', 'auth token service'],
		['/root/docs/guide.md', 'installation guide'],
	]);
	const probe = new FolderProbe(tree, dirs, files);

	let selectorCalls = 0;
	const res = await buildFolderRag('/root', { manager: mgr, probe }, {
		config: { prompt: DELIM } as any,
		idForRepo: (r: string) => 'sess-' + baseName(r),
		templateId: 'entity_list', // explicit → wins
		chooseStrategy: () => { selectorCalls++; return { method: 'light_rag' }; },
	});
	assert.strictEqual(selectorCalls, 0, 'chooseStrategy is not consulted when a strategy is forced');
	for (const sid of res.sessions.values()) {
		assert.strictEqual(mgr.get(sid)!.meta.templateId, 'entity_list', 'forced templateId applied to every repo');
	}
});

// ── U7: streaming / 4GB heap guard (chunked feed + maxFiles cap) ────────────────

test('T31 streaming feed ingests every file even with a tiny chunkSize (peak heap bounded)', async () => {
	const N = 7;
	// Build one repo with N non-empty source files under a single dir.
	const tree = new Map<string, string[]>([['/root', ['.git', 'src']], ['/root/src', []]]);
	const dirs = new Set(['/root', '/root/.git', '/root/src']);
	const files = new Map<string, string>([['/root/.git/HEAD', 'ref: refs/heads/main']]);
	for (let i = 1; i <= N; i++) {
		const name = `f${i}.ts`;
		tree.get('/root/src')!.push(name);
		files.set(`/root/src/${name}`, `module number ${i} payload text`);
	}
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });

	// chunkSize=2 → forces multiple chunk iterations; all N files must still land.
	const res = await buildFolderRag('/root', { manager: mgr, probe }, {
		...OPTS, chunkSize: 2,
	});
	assert.strictEqual(res.errors.size, 0, 'no errors despite chunked feed');
	const sid = res.sessions.get('/root')!;
	assert.strictEqual(mgr.get(sid)!.meta.itemCount, N, 'every file ingested across chunks (not one mega-string)');
});

test('T32 maxFiles cap skips surplus files without error', async () => {
	const tree = new Map<string, string[]>([['/root', ['.git', 'src']], ['/root/src', ['a.ts', 'b.ts', 'c.ts']]]);
	const dirs = new Set(['/root', '/root/.git', '/root/src']);
	const files = new Map<string, string>([
		['/root/.git/HEAD', 'ref: refs/heads/main'],
		['/root/src/a.ts', 'alpha module payload'],
		['/root/src/b.ts', 'beta module payload'],
		['/root/src/c.ts', 'gamma module payload'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });

	const res = await buildFolderRag('/root', { manager: mgr, probe }, {
		...OPTS, maxFiles: 1, chunkSize: 1,
	});
	assert.strictEqual(res.errors.size, 0, 'cap is a soft skip, not an error');
	const sid = res.sessions.get('/root')!;
	assert.strictEqual(mgr.get(sid)!.meta.itemCount, 1, 'only the first file within the cap is ingested');
});

test('T33 reingestRepo streams too (bounded chunk, reuses same session)', async () => {
	const tree = new Map<string, string[]>([['/root', ['.git', 'src']], ['/root/src', ['a.ts', 'b.ts']]]);
	const dirs = new Set(['/root', '/root/.git', '/root/src']);
	const files = new Map<string, string>([
		['/root/.git/HEAD', 'ref: refs/heads/main'],
		['/root/src/a.ts', 'alpha module payload'],
		['/root/src/b.ts', 'beta module payload'],
	]);
	const probe = new FolderProbe(tree, dirs, files);
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder() });
	const res = await buildFolderRag('/root', { manager: mgr, probe }, OPTS);
	const sid = res.sessions.get('/root')!;
	const before = mgr.get(sid)!.meta.itemCount;

	// Re-ingest with a tiny chunk; itemCount should grow by the same N (merge keeps it bounded,
	// but the streaming path must still reach every file).
	const re = await reingestRepo('/root', sid, { manager: mgr, probe }, { ...OPTS, chunkSize: 1 });
	assert.strictEqual(re.sessionId, sid, 'reingest targets the same session');
	assert.ok(re.itemCountAfter >= before, 'reingest streamed files into the same session without loss');
});
