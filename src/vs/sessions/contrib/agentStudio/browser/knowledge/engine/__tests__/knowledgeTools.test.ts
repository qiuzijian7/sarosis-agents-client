/*---------------------------------------------------------------------------------------------
 *  Knowledge-tools production wiring tests (Option A folder → per-repo RAG).
 *
 *  Exercises the agent-facing layer in `knowledgeTools.ts` that is NOT covered by the
 *  engine-level `folderRagBuild.test.ts`:
 *    - `shouldAutoExportNotes` (pure note-export decision)
 *    - `stableRepoSessionId` (deterministic repo→session mapping)
 *    - `importFolderToRag` (real `FsGitRepoProbe` over an in-memory `IFileService`,
 *      injected `createManager` so no network / no disk / no VS Code runtime)
 *    - `searchFolderRag` cross-repo fan-out (empty index, happy path, fault isolation)
 *
 *  Uses the same deterministic `HashEmbedder` + `MockChatModel` mocks as the engine
 *  tests so the whole pipeline runs in `node:test` with no 4GB heap pressure.
 *
 *  Run: node .../engine/__tests__/run-knowledgetools-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { test } from 'node:test';

import { IEmbedder } from '../embedder.js';
import { IChatModel, ExtractRequest } from '../llm.js';
import { KBStorageAdapter, KnowledgeManager, SerializedKB } from '../knowledgeManager.js';
import { stableRepoSessionId } from '../folderRagBuild.js';
import {
	shouldAutoExportNotes,
	importFolderToRag,
	searchFolderRag,
	type KnowledgeToolDeps,
} from '../../knowledgeTools.js';

// ── Engine mocks (mirror folderRagBuild.test.ts) ────────────────────────────────

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

/** In-memory storage adapter shared across `KnowledgeManager` instances. */
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

// ── Minimal in-memory IFileService (backs the real FsGitRepoProbe) ──────────────

class InMemoryFileService {
	nodes = new Map<string, { isDir: boolean; children: string[]; content?: string }>([['/', { isDir: true, children: [] }]]);
	private faulty = new Set<string>();
	/**
	 * `FsGitRepoProbe` resolves paths via `URI.file(path).fsPath`, which on Windows
	 * yields backslash-separated paths (e.g. `\\ws\\repoA`). Normalize every incoming
	 * key to POSIX form so our `/`-rooted tree keys match regardless of platform.
	 */
	private norm(p: string): string {
		return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
	}
	/** Create a directory node and link it under its parent's child list (idempotent). */
	private ensureDir(p: string): void {
		p = this.norm(p);
		if (!p || p === '/') { return; }
		const i = p.lastIndexOf('/');
		const parent = i > 0 ? p.slice(0, i) : '/';
		if (!this.nodes.has(p)) { this.nodes.set(p, { isDir: true, children: [] }); }
		if (parent && parent !== p) {
			this.ensureDir(parent);
			const name = p.slice(i + 1);
			const pc = this.nodes.get(parent)!;
			if (!pc.children.includes(name)) { pc.children.push(name); }
		}
	}
	dir(p: string): this { this.ensureDir(p); return this; }
	file(p: string, content: string): this {
		p = this.norm(p);
		const i = p.lastIndexOf('/');
		const parent = i >= 0 ? p.slice(0, i) : '/';
		this.ensureDir(parent);
		const name = p.slice(i + 1);
		const pc = this.nodes.get(parent)!;
		if (!pc.children.includes(name)) { pc.children.push(name); }
		this.nodes.set(p, { isDir: false, children: [], content });
		return this;
	}
	/** Register a directory node WITHOUT its listing, but make `isDirectory` lie=true
	 *  so `walkRepoPaths` traverses into it and then `listFolder` throws (fault path). */
	faultyDir(p: string): this {
		this.ensureDir(p);
		this.faulty.add(this.norm(p));
		return this;
	}
	async resolve(uri: any) {
		const fp = this.norm(uri.fsPath);
		if (this.faulty.has(fp)) { throw new Error(`EIO ${fp}`); }
		const n = this.nodes.get(fp);
		if (!n || !n.isDir) { throw new Error(`ENOTDIR ${fp}`); }
		return {
			children: n.children.map(name => {
				const childPath = fp.endsWith('/') ? fp + name : fp + '/' + name;
				const c = this.nodes.get(childPath);
				return { name, isDirectory: !!c?.isDir };
			}),
		};
	}
	async stat(uri: any) {
		const fp = this.norm(uri.fsPath);
		const n = this.nodes.get(fp);
		if (!n) { throw new Error(`ENOENT ${fp}`); }
		return { isDirectory: n.isDir } as any;
	}
	async readFile(uri: any) {
		const fp = this.norm(uri.fsPath);
		const n = this.nodes.get(fp);
		if (!n || n.isDir) { throw new Error(`EISDIR ${fp}`); }
		// FsGitRepoProbe does `(await readFile(...)).value.toString()` — a minimal
		// buffer-like shim satisfies that without importing vscode's VSBuffer.
		return { value: { toString: () => n.content ?? '' } } as any;
	}
}

function mkDeps(fs: InMemoryFileService, store: MemStorage, index?: Record<string, string>): KnowledgeToolDeps {
	return {
		fileService: fs as any,
		configurationService: undefined as any,
		embeddingService: { isEnabled: () => true } as any,
		resolveBaseDir: async () => '/root',
		resolveStorageRoot: async () => '/kbroot',
		createManager: async () => new KnowledgeManager({
			llm: folderLlm(),
			embedder: new HashEmbedder(),
			storage: store,
		}),
		readFolderRagIndex: index ? async () => index : async () => ({}),
	} as unknown as KnowledgeToolDeps;
}

function gitRepoTree(fs: InMemoryFileService, root: string, files: Record<string, string>): InMemoryFileService {
	fs.dir(root).dir(`${root}/.git`).file(`${root}/.git/HEAD`, 'ref: refs/heads/main');
	for (const [rel, content] of Object.entries(files)) {
		const p = `${root}/${rel}`;
		const i = p.lastIndexOf('/');
		const parent = p.slice(0, i);
		fs.dir(parent);
		fs.file(p, content);
	}
	return fs;
}

// ── U9: shouldAutoExportNotes (pure) ────────────────────────────────────────────

test('T40 shouldAutoExportNotes decides note export correctly', () => {
	assert.strictEqual(shouldAutoExportNotes({ export_notes: true }, 'entity_list'), true, 'explicit true wins');
	assert.strictEqual(shouldAutoExportNotes({ export_notes: false }, 'notes_summary'), false, 'explicit false wins even for notes_summary');
	assert.strictEqual(shouldAutoExportNotes({}, 'notes_summary'), true, 'notes_summary defaults on when unset');
	assert.strictEqual(shouldAutoExportNotes({}, 'entity_list'), false, 'other templates default off when unset');
});

// ── U10: stableRepoSessionId (deterministic mapping) ───────────────────────────

test('T41 stableRepoSessionId is deterministic and repo-rooted', () => {
	const a1 = stableRepoSessionId('/ws/repoA');
	const a2 = stableRepoSessionId('/ws/repoA');
	const b = stableRepoSessionId('/ws/repoB');
	assert.strictEqual(a1, a2, 'same repoRoot → identical sessionId (stable across calls)');
	assert.notStrictEqual(a1, b, 'different repoRoots → different sessionIds');
	assert.match(a1, /^rag-/, 'stable id carries the rag- prefix used by importFolderToRag');
});

// ── U11: importFolderToRag end-to-end (real FsGitRepoProbe + in-memory FS) ──────

test('T42 importFolderToRag builds one session per git repo and persists it', async () => {
	const fs = new InMemoryFileService();
	gitRepoTree(fs, '/root', {
		'src/a.ts': 'function alpha() {} exports alpha',
		'src/b.ts': 'class Beta { go() {} }',
	});
	const store = new MemStorage();
	const deps = mkDeps(fs, store);

	// Force entity_list so the deterministic mock LLM yields list items (the per-repo
	// `light_rag` strategy is covered separately by the engine tests T28–T30).
	const res = await importFolderToRag(deps, '/root', { templateId: 'entity_list' });
	assert.strictEqual(Object.keys(res.errors).length, 0, 'no errors on a clean repo');
	assert.strictEqual(Object.keys(res.sessions).length, 1, 'exactly one session for the single git repo');
	const sid = res.sessions['/root'];
	assert.ok(sid, 'session id recorded for /root');

	// The session must actually be persisted to the injected storage and hold items.
	const mgr = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder(), storage: store });
	const sess = await mgr.load(sid);
	assert.ok(sess.meta.itemCount >= 2, 'both source files were ingested into the session');
});

test('T43 importFolderToRag isolates a faulty repo, still builds the healthy one', async () => {
	const fs = new InMemoryFileService();
	// Healthy repo A.
	gitRepoTree(fs, '/ws/repoA', { 'src/a.ts': 'function alpha() {}' });
	// Repo B: discovered (has .git) and would build, but its session creation fails
	// in the engine — surfaced as a per-repo error, never aborting the whole import.
	fs.dir('/ws/broken').dir('/ws/broken/.git').file('/ws/broken/.git/HEAD', 'x')
		.dir('/ws/broken/src').file('/ws/broken/src/b.ts', 'class Broken {}');

	const store = new MemStorage();
	const deps = mkDeps(fs, store);
	// Inject a manager whose `create` throws for the broken repo (the only
	// probe-independent failure point that propagates to buildFolderRag's per-repo
	// try/catch; filesystem-level probe errors are intentionally swallowed upstream).
	(deps as any).createManager = async () => {
		const m = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder(), storage: store });
		const origCreate = m.create.bind(m);
		(m as any).create = (templateId: any, opts: any) => {
			if (String(opts?.id).includes('broken')) { throw new Error('simulated engine failure for broken repo'); }
			return origCreate(templateId, opts);
		};
		return m;
	};

	const res = await importFolderToRag(deps, '/ws', { templateId: 'entity_list' });
	assert.ok(res.sessions['/ws/repoA'], 'healthy repo still built despite the broken sibling');
	assert.ok(res.errors && res.errors['/ws/broken'], 'broken repo isolated into errors, not thrown');
});

// ── U12: searchFolderRag cross-repo fan-out ──────────────────────────────────

test('T44 searchFolderRag returns empty when no folders are indexed', async () => {
	const fs = new InMemoryFileService();
	const store = new MemStorage();
	const deps = mkDeps(fs, store, {});
	const res = await searchFolderRag(deps, 'anything', 5);
	assert.strictEqual(res.repoCount, 0, 'no repos → repoCount 0');
	assert.deepStrictEqual(res.results, [], 'no repos → no results');
	assert.deepStrictEqual(res.errors, [], 'no repos → no errors');
});

test('T45 searchFolderRag fans out across repos and tags hits with _repoRoot', async () => {
	const fs = new InMemoryFileService();
	gitRepoTree(fs, '/root', {
		'src/a.ts': 'function alpha() {} searchable alpha token',
		'src/b.ts': 'class Beta { go() {} }',
	});
	const store = new MemStorage();
	const deps = mkDeps(fs, store);

	const built = await importFolderToRag(deps, '/root', { templateId: 'entity_list' });
	const index = built.sessions; // repoRoot → sessionId

	// Fresh deps sharing the SAME storage so the sessions load.
	const searchDeps = mkDeps(new InMemoryFileService(), store, index);
	const res = await searchFolderRag(searchDeps, 'alpha', 5);

	assert.strictEqual(res.repoCount, 1, 'one indexed repo fanned out');
	assert.strictEqual(res.errors.length, 0, 'healthy repo → no errors');
	assert.ok(res.results.length >= 1, 'query found at least one hit');
	assert.ok(res.results.every(r => r['_repoRoot'] === '/root'),
		'every aggregated hit is tagged with its source _repoRoot');
});

test('T46 searchFolderRag isolates a missing session, still searches valid ones', async () => {
	const fs = new InMemoryFileService();
	gitRepoTree(fs, '/root', { 'src/a.ts': 'function alpha() {} searchable alpha token' });
	const store = new MemStorage();
	const buildDeps = mkDeps(fs, store);
	const built = await importFolderToRag(buildDeps, '/root', { templateId: 'entity_list' });

	// Index references the real repo plus a ghost session that does not exist.
	const index = { ...built.sessions, '/ghost': 'sess-does-not-exist' };
	const searchDeps = mkDeps(new InMemoryFileService(), store, index);

	const res = await searchFolderRag(searchDeps, 'alpha', 5);
	assert.strictEqual(res.repoCount, 2, 'index had two entries');
	assert.ok(res.errors.some(e => e['repoRoot'] === '/ghost'), 'ghost repo isolated into errors');
	assert.ok(res.results.length >= 1, 'valid repo still produced hits despite the ghost');
	assert.ok(res.results.every(r => r['_repoRoot'] === '/root'), 'valid hits correctly tagged');
});
