/*---------------------------------------------------------------------------------------------
 *  Git repository discovery for "import folder → per-repo RAG" (Option A).
 *
 *  Pure and filesystem-agnostic: every I/O goes through an injected
 *  `IGitRepoProbe`, so the logic is unit-testable without touching the real
 *  disk (mirrors the `IFileProbe` seam used by focusMode.ts).
 *
 *  Design rule (the heart of Option A):
 *    When a directory contains a `.git` entry it is recorded as exactly ONE
 *    repository and its subtree is NOT descended into. This guarantees one git
 *    repo maps to one RAG session, and prevents a nested `.git` (e.g. a repo
 *    checked out inside another) from being double-counted.
 *--------------------------------------------------------------------------------------------*/

export interface IGitRepoProbe {
	/** List immediate child entry names of `path` (throws if not a directory / inaccessible). */
	listFolder(path: string): Promise<readonly string[]>;
	/** True if `path` is a directory. */
	isDirectory(path: string): Promise<boolean>;
	/** Read a file's text, or undefined if absent / unreadable. */
	readFile?(path: string): Promise<string | undefined>;
}

export interface DiscoveredRepo {
	/** Absolute repository root (the directory that contains `.git`). */
	readonly root: string;
	/** Current branch parsed from `.git/HEAD`, or undefined when detached / unreadable. */
	readonly branch?: string;
}

export interface DiscoverResult {
	/** One entry per git repository (each becomes its own RAG session under Option A). */
	readonly repos: DiscoveredRepo[];
	/**
	 * The scanned root when it holds files/entries that are NOT inside any
	 * discovered repository (i.e. "loose", unversioned content). `null` otherwise.
	 */
	readonly unversionedRoot: string | null;
}

export interface DiscoverOptions {
	/** Maximum descent depth from `root`. Default: unlimited. */
	readonly maxDepth?: number;
}

const GIT_DIR = '.git';

/**
 * Walk `root` and return every git repository found, plus a flag for loose
 * (unversioned) content. See module header for the per-repo invariant.
 */
export async function discoverGitRepos(
	root: string,
	probe: IGitRepoProbe,
	opts: DiscoverOptions = {},
): Promise<DiscoverResult> {
	const maxDepth = opts.maxDepth ?? Number.MAX_SAFE_INTEGER;
	const repos: DiscoveredRepo[] = [];
	let hasLoose = false;

	// BFS over directories.
	const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

	while (queue.length > 0) {
		const { dir, depth } = queue.shift()!;

		// A directory that is itself a git repo: record it, do NOT descend.
		if (await isRepoRoot(probe, dir)) {
			repos.push({ root: dir, branch: await readBranch(probe, dir) });
			continue;
		}

		const entries = await safeList(probe, dir);
		for (const name of entries) {
			const child = joinPath(dir, name);
			if (await probe.isDirectory(child)) {
				if (depth + 1 <= maxDepth) {
					queue.push({ dir: child, depth: depth + 1 });
				} else {
					// Content exists below maxDepth but is not scanned → treat as loose.
					hasLoose = true;
				}
			} else {
				// A file outside any discovered repo subtree is "loose" content.
				hasLoose = true;
			}
		}
	}

	return { repos, unversionedRoot: hasLoose ? root : null };
}

async function isRepoRoot(probe: IGitRepoProbe, dir: string): Promise<boolean> {
	const entries = await safeList(probe, dir);
	return entries.includes(GIT_DIR);
}

/** List a folder, swallowing errors so an inaccessible directory is skipped (fault isolation). */
async function safeList(probe: IGitRepoProbe, dir: string): Promise<string[]> {
	try {
		return [...(await probe.listFolder(dir))];
	} catch {
		return [];
	}
}

/**
 * Parse the branch name from `.git/HEAD`. Handles both a real `.git/`
 * directory and a `.git` file pointer (git worktree / submodule):
 *   - dir  : read `<root>/.git/HEAD`
 *   - file : parse `gitdir: <path>` then read `<path>/HEAD`
 * A detached HEAD (raw sha) yields `undefined`.
 */
async function readBranch(probe: IGitRepoProbe, repoRoot: string): Promise<string | undefined> {
	if (!probe.readFile) { return undefined; }
	const gitPath = joinPath(repoRoot, GIT_DIR);
	let headPath: string;
	const gitIsDir = await probe.isDirectory(gitPath).catch(() => false);
	if (gitIsDir) {
		headPath = joinPath(gitPath, 'HEAD');
	} else {
		const ptr = await probe.readFile(gitPath);
		if (!ptr) { return undefined; }
		const m = /^gitdir:\s*(.+)$/m.exec(ptr.trim());
		if (!m) { return undefined; }
		headPath = joinPath(m[1].trim(), 'HEAD');
	}
	const head = await probe.readFile(headPath);
	if (!head) { return undefined; }
	const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
	return ref ? ref[1].trim() : undefined;
}

/** OS-agnostic path join (always '/' — deterministic for tests, valid on all platforms). */
function joinPath(base: string, name: string): string {
	return base.endsWith('/') ? base + name : base + '/' + name;
}
