/*---------------------------------------------------------------------------------------------
 *  Real-filesystem integration test: "import folder → per-repo RAG → cross-repo search".
 *
 *  Uses the ACTUAL disk (NodeProbe backed by node:fs) to discover git repos under the
 *  user-supplied root, build one KnowledgeSession per repo, then verify that cross-repo
 *  search returns tagged, ranked hits.
 *
 *  The extraction LLM + embedder are deterministic mocks (mirror engine tests) so the
 *  test runs with no network and bounded time even on 100+ repos.
 *
 *  Run:  node .../engine/__tests__/run-integration-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { IGitRepoProbe } from '../../../../common/gitRepoDiscovery.js';
import { IEmbedder } from '../embedder.js';
import { IChatModel, ExtractRequest } from '../llm.js';
import { KBStorageAdapter, KnowledgeManager, SerializedKB } from '../knowledgeManager.js';
import {
	buildFolderRag, searchAcrossRepos, aggregateItems, stableRepoSessionId,
} from '../folderRagBuild.js';

// ── Deterministic engine mocks (mirror engine / folderrag tests) ─────────────

class HashEmbedder implements IEmbedder {
	readonly dimensions = 64;
	async embed(texts: string[]): Promise<number[][]> { return texts.map(t => this.one(t)); }
	async embedOne(text: string): Promise<number[]> { return this.one(text); }
	private one(text: string): number[] {
		const v = new Array(this.dimensions).fill(0);
		const words = String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
		for (const w of words) {
			let h = 0;
			for (let i = 0; i < w.length; i++) { h = (h * 31 + w.charCodeAt(i)) >>> 0; }
			v[h % this.dimensions] += 1;
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

// ── Real-filesystem probe (no VS Code runtime, node:fs only) ─────────────────

class NodeProbe implements IGitRepoProbe {
	async listFolder(p: string): Promise<readonly string[]> {
		try {
			// Node accepts forward slashes; resolve normalises to platform separator.
			return await fs.readdir(path.resolve(p));
		} catch { return []; }
	}
	async isDirectory(p: string): Promise<boolean> {
		try { return (await fs.stat(path.resolve(p))).isDirectory(); } catch { return false; }
	}
	async readFile(p: string): Promise<string | undefined> {
		try { return await fs.readFile(path.resolve(p), 'utf-8'); } catch { return undefined; }
	}
}

// ── Integration test ─────────────────────────────────────────────────────────

const TARGET_ROOT = 'G:\\CustomWorkspaces\\AIProjects';

/**
 * Sanity guard: the target root must exist on disk (local-only integration test,
 * skipped in CI / unfamiliar environments).
 */
async function rootExists(): Promise<boolean> {
	try { await fs.stat(TARGET_ROOT); return true; } catch { return false; }
}

test('I01 real-filesystem discover + per-repo RAG build + cross-repo search', { skip: !(await rootExists()) }, async () => {
	// ── Build ──────────────────────────────────────────────────────────────
	const store = new MemStorage();
	const manager = new KnowledgeManager({ llm: folderLlm(), embedder: new HashEmbedder(), storage: store });
	const probe = new NodeProbe();

	const buildRes = await buildFolderRag(TARGET_ROOT, { manager, probe }, {
		templateId: 'entity_list',
		idForRepo: stableRepoSessionId,
		maxFiles: 10,      // cap files per repo so 100+ repos stay fast
		maxDepth: 1,       // only repo root + its immediate children
		skipDirs: new Set(['.git', 'node_modules', '.workbuddy', '.worktrees', 'out', 'out-build', 'out-test', 'out-vscode', 'build', 'extensions', 'test', 'tests', 'tmp', 'dist', '.next', '__pycache__', 'venv', '.venv', 'target', '.dart_tool', 'Pods']),
	});

	const sessions = buildRes.sessions;
	const errors = buildRes.errors;

	console.error(`I01 repos=${sessions.size} errors=${errors.size}`);

	// Basic sanity
	assert.ok(sessions.size >= 1, 'at least one git repo found under the target root');
	assert.ok(sessions.size >= errors.size * 2 || errors.size === 0,
		'most repos built successfully (isolated failures don\'t abort all)');

	// ── Search ─────────────────────────────────────────────────────────────
	// Cross-repo fan-out using the same manager (all sessions are in-memory).
	const acrossRes = await searchAcrossRepos(manager, sessions, 'import export function class', 5);
	const results = aggregateItems(acrossRes, 5);

	console.error(`I01 search hits=${acrossRes.hits.length} results=${results.length} errors=${acrossRes.errors.length}`);

	assert.ok(results.length >= 1, 'cross-repo search returns at least one de-duplicated, ranked hit');
	assert.ok(results.every(r => typeof r['_repoRoot'] === 'string' && r['_repoRoot'].length > 0),
		'every aggregated hit carries a non-empty _repoRoot tag');

	// ── Verify the current repo is included ────────────────────────────────
	const thisRepo = path.resolve(TARGET_ROOT, 'sarosis-agents-client');
	assert.ok(sessions.has(thisRepo) || [...sessions.keys()].some(k => k.toLowerCase().includes('sarosis')),
		'current project repo (sarosis-agents-client) is indexed');

	const itemsFromThisRepo = results.filter(r => String(r['_repoRoot']).includes('sarosis'));
	console.error(`I01 hits-from-this-repo=${itemsFromThisRepo.length}`);

	// ── Fault isolation ───────────────────────────────────────────────────
	// searchAcrossRepos errors carry `unknown` (Error objects are valid);
	// the fault-isolation invariant is that one repo failing doesn't abort the rest.
	if (acrossRes.errors.length > 0) {
		assert.ok(acrossRes.errors.every(e => typeof e.repoRoot === 'string' && e.repoRoot.length > 0),
			'search errors always identify the failing repoRoot');
	}
});
