/*---------------------------------------------------------------------------------------------
 *  Folder → per-repo RAG build & cross-repo query (Option A: one git repo → one session).
 *
 *  Orchestrates the dependency-free `KnowledgeManager` engine:
 *    - discoverGitRepos() finds one repository root per git repo (see gitRepoDiscovery.ts)
 *    - buildFolderRag()    builds ONE KnowledgeSession per repo, walking each repo's
 *                          text files (skipping noise dirs like node_modules / .git)
 *    - searchInRepo()      routes a query to a single session (precision / isolation)
 *    - searchAcrossRepos() fan-outs a query across many sessions, then aggregates
 *    - reingestRepo()      re-builds ONE repo's session after a git pull (incremental)
 *
 *  All filesystem I/O goes through an injected `IGitRepoProbe` (listFolder / isDirectory /
 *  readFile), so the whole pipeline is unit-testable with a mock probe + the engine's
 *  HashEmbedder / MockChatModel — no network, no VS Code runtime, no 4GB heap pressure.
 *--------------------------------------------------------------------------------------------*/

import { discoverGitRepos, IGitRepoProbe } from '../../../common/gitRepoDiscovery.js';
import { KnowledgeManager, KnowledgeSession, SearchResult } from './knowledgeManager.js';

/** Directories that never contain first-party knowledge content. */
export const DEFAULT_SKIP_DIRS = new Set<string>([
	'.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt',
	'vendor', '__pycache__', '.venv', 'venv', 'env', '.env',
	'target', '.cargo', 'coverage', '.idea', '.vscode', '.vs',
	'bin', 'obj', 'Debug', 'Release', '.sarosworkspace',
]);

/**
 * Streaming guard: a repository's files are read + fed to the engine in chunks of
 * this many documents. Only one chunk's bodies live in memory at a time, capping
 * peak heap well under the 4GB V8 single-isolate ceiling (Electron). 256 documents
 * averages ~13MB even at 50KB/file, and far less for typical source files.
 */
export const DEFAULT_CHUNK_SIZE = 256;

/**
 * Streaming guard: hard ceiling on files ingested per repository. Bounds the path
 * array and total extraction cost so a repo with millions of tiny files cannot blow
 * the heap or run unbounded. Surplus files are skipped silently.
 */
export const DEFAULT_MAX_FILES = 200_000;

export interface BuildFolderDeps {
	manager: KnowledgeManager;
	probe: IGitRepoProbe;
}

export interface BuildFolderOptions {
	/** Engine template id. Default `entity_list` (flat title+content items). */
	templateId?: string;
	/** Named extraction method (overrides template's AutoType). */
	method?: string;
	/** AutoType config forwarded to `manager.create` (e.g. a custom extraction prompt). */
	config?: import('./types.js').AutoTypeConfig;
	/** Build an extra session for loose (unversioned) files at the root. */
	includeUnversioned?: boolean;
	skipDirs?: ReadonlySet<string>;
	maxDepth?: number;
	/** Deterministic id generator so callers can keep a stable repoRoot→sessionId map. */
	idForRepo?: (repoRoot: string) => string;
	/**
	 * Streaming chunk size: max number of file bodies read + fed to
	 * `manager.parseMany` at once (default {@link DEFAULT_CHUNK_SIZE}). The local
	 * text array for a chunk is freed after the call resolves, so peak heap only
	 * ever holds `chunkSize` documents — this is the guard against the 4GB V8
	 * single-isolate heap ceiling on Electron (see AGENTS.md architecture limits).
	 */
	chunkSize?: number;
	/**
	 * Hard cap on files ingested per repository (default {@link DEFAULT_MAX_FILES}).
	 * Bounds both the path array and total extraction work so a pathological repo
	 * (millions of tiny files) cannot balloon memory or run forever. Files beyond
	 * the cap are silently skipped.
	 */
	maxFiles?: number;
	/**
	 * Per-repo extraction strategy selector (differentiation). Called once per
	 * repository with its file-mix stats; return which template/method/config to
	 * use for THAT repo (e.g. code-heavy repos → `light_rag`, docs-heavy repos →
	 * `notes_summary`). An explicit `templateId`/`method` on these options always
	 * wins over the selector (so callers can force a single strategy). Omit to keep
	 * the single default strategy. See {@link classifyRepoStrategy} for the built-in
	 * heuristic production callers pass here.
	 */
	chooseStrategy?: (repoRoot: string, stats: RepoFileStats) => RepoStrategy;
}

/** Extraction strategy for a single repository (subset of build options). */
export interface RepoStrategy {
	templateId?: string;
	method?: string;
	config?: import('./types.js').AutoTypeConfig;
}

/** File-mix statistics for one repository, used to pick an extraction strategy. */
export interface RepoFileStats {
	/** Total text files collected (after skip-dir filtering). */
	total: number;
	/** Number of source-code files (see {@link CODE_EXTS}). */
	codeFiles: number;
	/** Number of prose/doc files (see {@link DOC_EXTS}). */
	docFiles: number;
	/** Per-extension counts (lowercased, incl. leading dot; `''` = no extension). */
	byExt: Record<string, number>;
}

/** Source-code file extensions (drive the `light_rag` strategy). */
export const CODE_EXTS: ReadonlySet<string> = new Set<string>([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
	'.c', '.h', '.cc', '.cpp', '.hpp', '.cxx', '.cs', '.rb', '.php', '.swift',
	'.kt', '.kts', '.scala', '.m', '.mm', '.sh', '.bash', '.zsh', '.ps1',
	'.vue', '.svelte', '.sql', '.lua', '.dart', '.r', '.jl', '.ex', '.exs',
	'.clj', '.hs', '.ml', '.pl', '.gradle',
]);

/** Prose / documentation file extensions (drive the `notes_summary` strategy). */
export const DOC_EXTS: ReadonlySet<string> = new Set<string>([
	'.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc', '.asciidoc',
	'.org', '.tex', '.rtf', '.wiki',
]);

/** Lower-cased extension (incl. dot) of a path, or `''` when there is none. */
export function extOf(path: string): string {
	const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	const dot = path.lastIndexOf('.');
	return dot > slash + 1 ? path.slice(dot).toLowerCase() : '';
}

/** Tally a repository's collected files into a {@link RepoFileStats}. */
export function computeRepoStats(files: ReadonlyArray<string | { path: string }>): RepoFileStats {
	const byExt: Record<string, number> = {};
	let codeFiles = 0;
	let docFiles = 0;
	for (const f of files) {
		const path = typeof f === 'string' ? f : f.path;
		const ext = extOf(path);
		byExt[ext] = (byExt[ext] ?? 0) + 1;
		if (CODE_EXTS.has(ext)) { codeFiles++; }
		else if (DOC_EXTS.has(ext)) { docFiles++; }
	}
	return { total: files.length, codeFiles, docFiles, byExt };
}

/**
 * Built-in heuristic that maps a repository's file-mix to an extraction strategy:
 *   - **code-heavy** (code files dominate) → `light_rag` method: a lightweight
 *     entity+relation graph, good for surfacing how symbols/modules relate.
 *   - **docs-heavy** (prose files dominate) → `notes_summary` template: one
 *     retrieval-friendly structured note per document.
 *   - **mixed / unknown** → `entity_list` template: a safe generic default.
 *
 * "Dominate" = at least twice as many files of one kind as the other (so a repo
 * with a README next to source code still classifies as code). Production callers
 * pass this as `chooseStrategy`; tests can pass their own selector.
 */
export function classifyRepoStrategy(_repoRoot: string, stats: RepoFileStats): RepoStrategy {
	const { codeFiles, docFiles } = stats;
	if (codeFiles === 0 && docFiles === 0) { return { templateId: 'entity_list' }; }
	if (docFiles > 0 && docFiles >= codeFiles * 2) { return { templateId: 'notes_summary' }; }
	if (codeFiles > 0 && codeFiles >= docFiles * 2) { return { method: 'light_rag' }; }
	return { templateId: 'entity_list' };
}

export interface BuildFolderResult {
	/** repoRoot → sessionId (one session per git repository). */
	sessions: Map<string, string>;
	/** sessionId of the optional unversioned session, or null. */
	unversionedSessionId: string | null;
	/** repoRoot → error (fault isolation: one repo failing doesn't abort the rest). */
	errors: Map<string, unknown>;
}

/** Build one RAG session per git repository found under `root`. */
export async function buildFolderRag(
	root: string,
	deps: BuildFolderDeps,
	opts: BuildFolderOptions = {},
): Promise<BuildFolderResult> {
	const templateId = opts.templateId ?? 'entity_list';
	const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
	const maxDepth = opts.maxDepth ?? Number.MAX_SAFE_INTEGER;
	const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
	const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;

	const { repos, unversionedRoot } = await discoverGitRepos(root, deps.probe, { maxDepth });

	const sessions = new Map<string, string>();
	const errors = new Map<string, unknown>();

	for (const repo of repos) {
		try {
			// Pass 1: collect paths only (no file bodies) → cheap strategy classification.
			const paths = await walkRepoPaths(repo.root, deps.probe, skipDirs, maxDepth, new Set(), maxFiles);
			const strat = resolveStrategy(opts, repo.root, paths);
			const session = deps.manager.create(strat.templateId ?? templateId, {
				method: strat.method,
				config: strat.config,
				id: opts.idForRepo ? opts.idForRepo(repo.root) : undefined,
				title: baseName(repo.root),
			});
			// Pass 2: stream — read + feed in bounded chunks so peak heap is capped.
			await streamParseRepo(deps.probe, session, paths, chunkSize, deps.manager);
			sessions.set(repo.root, session.id);
			await persistIfPossible(deps.manager, session);
		} catch (e) {
			errors.set(repo.root, e);
		}
	}

	let unversionedSessionId: string | null = null;
	if (unversionedRoot && opts.includeUnversioned) {
		try {
			const skip = new Set(repos.map(r => r.root));
			const paths = await walkRepoPaths(unversionedRoot, deps.probe, skipDirs, maxDepth, skip, maxFiles);
			const strat = resolveStrategy(opts, unversionedRoot, paths);
			const session = deps.manager.create(strat.templateId ?? templateId, {
				method: strat.method,
				config: strat.config,
				id: opts.idForRepo ? opts.idForRepo(unversionedRoot) : undefined,
				title: `${baseName(unversionedRoot)} (unversioned)`,
			});
			await streamParseRepo(deps.probe, session, paths, chunkSize, deps.manager);
			unversionedSessionId = session.id;
			await persistIfPossible(deps.manager, session);
		} catch (e) {
			errors.set(unversionedRoot, e);
		}
	}

	return { sessions, unversionedSessionId, errors };
}

/**
 * Resolve the extraction strategy for one repo. An explicit `templateId`/`method`
 * on the build options always wins (single forced strategy); otherwise defer to the
 * per-repo `chooseStrategy` selector; otherwise `{}` (falls back to the default
 * template at the call site).
 */
function resolveStrategy(
	opts: BuildFolderOptions,
	repoRoot: string,
	paths: ReadonlyArray<string>,
): RepoStrategy {
	if (opts.templateId || opts.method) {
		return { templateId: opts.templateId, method: opts.method, config: opts.config };
	}
	if (opts.chooseStrategy) {
		return opts.chooseStrategy(repoRoot, computeRepoStats(paths));
	}
	return {};
}

/** Re-feed one repository's files into its existing session (after a git pull). */
export interface ReingestResult {
	sessionId: string;
	itemCountBefore: number;
	itemCountAfter: number;
	updatedAtBefore: string;
	updatedAtAfter: string;
}

export async function reingestRepo(
	repoRoot: string,
	sessionId: string,
	deps: BuildFolderDeps,
	opts: BuildFolderOptions = {},
): Promise<ReingestResult> {
	const session = deps.manager.get(sessionId);
	if (!session) { throw new Error(`session not found: ${sessionId}`); }
	const itemCountBefore = session.meta.itemCount;
	const updatedAtBefore = session.updatedAt;

	const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
	const maxDepth = opts.maxDepth ?? Number.MAX_SAFE_INTEGER;
	const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
	const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
	// Stream the re-ingest too: only `chunkSize` bodies in memory at a time.
	const paths = await walkRepoPaths(repoRoot, deps.probe, skipDirs, maxDepth, new Set(), maxFiles);
	await streamParseRepo(deps.probe, session, paths, chunkSize, deps.manager);
	await persistIfPossible(deps.manager, session);

	return {
		sessionId,
		itemCountBefore,
		itemCountAfter: session.meta.itemCount,
		updatedAtBefore,
		updatedAtAfter: session.updatedAt,
	};
}

// ── Query routing ─────────────────────────────────────────────────────────────

export interface AggregatedHit {
	repoRoot: string;
	sessionId: string;
	result: SearchResult;
}

export interface SearchAcrossResult {
	hits: AggregatedHit[];
	errors: Array<{ repoRoot: string; error: unknown }>;
}

/** Route a query to a single repository's session (precision / isolation). */
export async function searchInRepo(
	manager: KnowledgeManager,
	sessionId: string,
	query: string,
	topK = 5,
): Promise<SearchResult> {
	const s = manager.get(sessionId);
	if (!s) { throw new Error(`session not found: ${sessionId}`); }
	return manager.search(s, query, topK);
}

/** Fan-out a query across many sessions, collecting per-repo results + isolated errors. */
export async function searchAcrossRepos(
	manager: KnowledgeManager,
	sessionMap: Map<string, string>,
	query: string,
	topK = 5,
): Promise<SearchAcrossResult> {
	const hits: AggregatedHit[] = [];
	const errors: Array<{ repoRoot: string; error: unknown }> = [];
	for (const [repoRoot, sessionId] of sessionMap) {
		try {
			const result = await searchInRepo(manager, sessionId, query, topK);
			hits.push({ repoRoot, sessionId, result });
		} catch (e) {
			errors.push({ repoRoot, error: e });
		}
	}
	return { hits, errors };
}

/**
 * Flatten per-repo hits into a single ranked list, deduplicating by `title`
 * and sorting by `score` desc when present. Ties keep per-repo discovery order.
 */
export function aggregateItems(
	across: SearchAcrossResult,
	topK = 5,
): Array<Record<string, unknown>> {
	const seen = new Set<string>();
	const flat: Array<Record<string, unknown>> = [];
	for (const hit of across.hits) {
		const items = (hit.result.type === 'list'
			? (hit.result.items ?? [])
			: [...(hit.result.nodes ?? []), ...(hit.result.edges ?? [])]) as Array<Record<string, unknown>>;
		for (const it of items) {
			const key = String(it['title'] ?? it['name'] ?? JSON.stringify(it));
			if (seen.has(key)) { continue; }
			seen.add(key);
			flat.push({ ...it, _repoRoot: hit.repoRoot });
		}
	}
	flat.sort((a, b) => Number(b['score'] ?? 0) - Number(a['score'] ?? 0));
	return flat.slice(0, topK);
}

/**
 * Deterministic, filesystem-safe session id for a repository root.
 * Used as `idForRepo` when importing a folder, so re-running the import (or a later
 * `git pull` → `reingestRepo`) maps the same repo root to the same session id and the
 * engine's SIMPLE merge keeps the item count bounded instead of creating duplicates.
 */
export function stableRepoSessionId(repoRoot: string): string {
	let h = 5381;
	for (let i = 0; i < repoRoot.length; i++) {
		h = (((h << 5) + h) + repoRoot.charCodeAt(i)) | 0;
	}
	const hex = (h >>> 0).toString(16).padStart(8, '0');
	const base = repoRoot.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-24) || 'repo';
	return `rag-${base}-${hex}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function persistIfPossible(manager: KnowledgeManager, session: { id: string }): Promise<void> {
	try {
		await (manager as unknown as { persist?: (s: unknown) => Promise<void> }).persist?.(session);
	} catch {
		// No storage adapter configured → in-memory only; safe to ignore in unit tests.
	}
}

/**
 * Walk a directory tree collecting file paths ONLY (no content read), skipping
 * noise dirs and subtrees. Storing paths (not file bodies) keeps this pass tiny and
 * bounded, so the per-repo extraction strategy ({@link computeRepoStats} →
 * {@link classifyRepoStrategy}) can be chosen before any document is read. The
 * `maxFiles` cap bounds the path array itself against pathological repos.
 */
async function walkRepoPaths(
	root: string,
	probe: IGitRepoProbe,
	skipDirs: ReadonlySet<string>,
	maxDepth: number,
	skipSubtrees: Set<string>,
	maxFiles: number,
): Promise<string[]> {
	const out: string[] = [];
	const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

	while (queue.length > 0) {
		const { dir, depth } = queue.shift()!;
		if (skipSubtrees.has(dir)) { continue; }
		let entries: string[] = [];
		try { entries = [...(await probe.listFolder(dir))]; } catch { continue; }
		for (const name of entries) {
			if (name === '.git' || skipDirs.has(name)) { continue; }
			const child = joinPath(dir, name);
			let isDir = false;
			try { isDir = await probe.isDirectory(child); } catch { isDir = false; }
			if (isDir) {
				if (depth + 1 <= maxDepth) { queue.push({ dir: child, depth: depth + 1 }); }
			} else if (out.length < maxFiles) {
				out.push(child);
			}
		}
	}
	return out;
}

/**
 * Read + feed a repository's files to `session` in bounded chunks so we never hold
 * more than `chunkSize` file bodies in memory at once — the guard against the 4GB
 * V8 single-isolate heap ceiling on Electron (see AGENTS.md architecture limits).
 * After each chunk's `parseMany` resolves, the local text array is dropped and can
 * be GC'd; only the (compact) session index persists. Empty/missing files are
 * skipped per chunk.
 */
async function streamParseRepo(
	probe: IGitRepoProbe,
	session: KnowledgeSession,
	paths: ReadonlyArray<string>,
	chunkSize: number,
	manager: KnowledgeManager,
): Promise<number> {
	let ingested = 0;
	for (let i = 0; i < paths.length; i += chunkSize) {
		const slice = paths.slice(i, i + chunkSize);
		const texts = await Promise.all(
			slice.map(p => (probe.readFile ? probe.readFile(p) : undefined)),
		);
		// Keep only non-empty bodies for this chunk; the array is freed after parseMany.
		const bodies = texts.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
		if (bodies.length > 0) {
			await manager.parseMany(session, bodies);
			ingested += bodies.length;
		}
	}
	return ingested;
}

function joinPath(base: string, name: string): string {
	return base.endsWith('/') ? base + name : base + '/' + name;
}

function baseName(p: string): string {
	const norm = p.endsWith('/') ? p.slice(0, -1) : p;
	const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
	return i >= 0 ? norm.slice(i + 1) : norm;
}
