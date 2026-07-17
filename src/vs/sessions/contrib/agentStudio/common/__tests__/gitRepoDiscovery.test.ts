/*---------------------------------------------------------------------------------------------
 *  Unit tests for gitRepoDiscovery (Option A: one git repo → one RAG session).
 *
 *  Pure, filesystem-free: a `MockFileProbe` models a directory tree so the
 *  discovery logic (including nested `.git`, worktree pointers, maxDepth and
 *  fault isolation) can be exercised without touching the real disk.
 *
 *  Run with the bundled esbuild runner:
 *    node src/.../common/__tests__/run-gitdiscovery-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { test } from 'node:test';

import { discoverGitRepos, IGitRepoProbe } from '../gitRepoDiscovery.js';
import { FsGitRepoProbe } from '../fsGitRepoProbe.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';

// ── Mock probe ────────────────────────────────────────────────────────────────

class MockFileProbe implements IGitRepoProbe {
	constructor(
		private readonly tree: Map<string, string[]>,
		private readonly dirs: Set<string>,
		private readonly files: Map<string, string> = new Map(),
	) {}

	async listFolder(path: string): Promise<readonly string[]> {
		const e = this.tree.get(path);
		if (!e) { throw new Error(`ENOENT: ${path}`); }
		return e;
	}

	async isDirectory(path: string): Promise<boolean> {
		return this.dirs.has(path);
	}

	async readFile(path: string): Promise<string | undefined> {
		return this.files.get(path);
	}
}

/** Build a probe from a compact spec. `tree` maps dir → child entry names. */
function probeFrom(tree: Map<string, string[]>, files: Map<string, string> = new Map()): MockFileProbe {
	const dirs = new Set<string>();
	for (const dir of tree.keys()) { dirs.add(dir); }
	// Any entry that has children is a directory; also treat `.git` dirs explicitly.
	for (const [dir, entries] of tree) {
		for (const name of entries) {
			const child = dir.endsWith('/') ? dir + name : dir + '/' + name;
			// Heuristic: a child is a directory if it appears as a key in the tree.
			if (tree.has(child)) { dirs.add(child); }
			// `.git` is a directory unless it is explicitly a file (present in `files`).
			if (name === '.git' && !files.has(child)) { dirs.add(child); }
		}
	}
	return new MockFileProbe(tree, dirs, files);
}

// ── T1: root is a single repo ──────────────────────────────────────────────────

test('T1 single git repo at root → one repo, no unversioned', async () => {
	const probe = probeFrom(new Map([
		['/root', ['.git', 'README.md', 'src']],
		['/root/src', ['main.ts']],
	]), new Map([
		['/root/.git/HEAD', 'ref: refs/heads/main'],
	]));
	const r = await discoverGitRepos('/root', probe);
	assert.strictEqual(r.repos.length, 1);
	assert.strictEqual(r.repos[0].root, '/root');
	assert.strictEqual(r.repos[0].branch, 'main');
	assert.strictEqual(r.unversionedRoot, null);
});

// ── T2: multiple sibling repos + a loose file ───────────────────────────────────

test('T2 sibling repos + loose file → repos=[a,b], unversionedRoot=root', async () => {
	const probe = probeFrom(new Map([
		['/root', ['a', 'b', 'c.txt']],
		['/root/a', ['.git', 'x.ts']],
		['/root/b', ['.git', 'y.ts']],
	]), new Map([
		['/root/a/.git/HEAD', 'ref: refs/heads/dev'],
		['/root/b/.git/HEAD', 'ref: refs/heads/main'],
	]));
	const r = await discoverGitRepos('/root', probe);
	assert.strictEqual(r.repos.length, 2);
	assert.deepStrictEqual(r.repos.map(x => x.root).sort(), ['/root/a', '/root/b']);
	assert.strictEqual(r.repos.find(x => x.root === '/root/a')!.branch, 'dev');
	assert.strictEqual(r.unversionedRoot, '/root');
});

// ── T3: nested repo must NOT be double-counted ───────────────────────────────────

test('T3 nested .git inside a repo → only the outer repo is counted', async () => {
	const probe = probeFrom(new Map([
		['/root', ['.git', 'sub']],
		['/root/sub', ['.git', 'inner.ts']],
	]), new Map([
		['/root/.git/HEAD', 'ref: refs/heads/main'],
	]));
	const r = await discoverGitRepos('/root', probe);
	assert.strictEqual(r.repos.length, 1, 'inner .git must not create a second repo');
	assert.strictEqual(r.repos[0].root, '/root');
	assert.strictEqual(r.unversionedRoot, null);
});

// ── T4: `.git` is a file pointer (worktree / submodule) ──────────────────────────

test('T4 .git as a file pointer (worktree) → still a repo, branch resolved', async () => {
	const files = new Map<string, string>([
		['/root/.git', 'gitdir: /elsewhere/repos/x/.git'],
		['/elsewhere/repos/x/.git/HEAD', 'ref: refs/heads/feature'],
	]);
	const probe = probeFrom(new Map([
		['/root', ['.git', 'src']],
		['/root/src', ['main.ts']],
	]), files);
	const r = await discoverGitRepos('/root', probe);
	assert.strictEqual(r.repos.length, 1);
	assert.strictEqual(r.repos[0].root, '/root');
	assert.strictEqual(r.repos[0].branch, 'feature');
});

// ── T5: no git at all → unversioned only ──────────────────────────────────────────

test('T5 no git anywhere → repos empty, unversionedRoot=root', async () => {
	const probe = probeFrom(new Map([
		['/root', ['readme.md', 'src']],
		['/root/src', ['x.ts']],
	]));
	const r = await discoverGitRepos('/root', probe);
	assert.strictEqual(r.repos.length, 0);
	assert.strictEqual(r.unversionedRoot, '/root');
});

// ── T6: empty folder → nothing ──────────────────────────────────────────────────

test('T6 empty folder → repos empty, no unversioned', async () => {
	const probe = probeFrom(new Map([
		['/root', []],
	]));
	const r = await discoverGitRepos('/root', probe);
	assert.strictEqual(r.repos.length, 0);
	assert.strictEqual(r.unversionedRoot, null);
});

// ── T7: maxDepth guards deep trees ───────────────────────────────────────────────

test('T7 maxDepth=1 does not descend into deep repos', async () => {
	const probe = probeFrom(new Map([
		['/root', ['shallow', 'deep']],
		['/root/shallow', ['.git', 'a.ts']],
		['/root/deep', ['x']],
		['/root/deep/x', ['y']],
		['/root/deep/x/y', ['.git', 'b.ts']],
	]), new Map([
		['/root/shallow/.git/HEAD', 'ref: refs/heads/main'],
		['/root/deep/x/y/.git/HEAD', 'ref: refs/heads/main'],
	]));
	const r = await discoverGitRepos('/root', probe, { maxDepth: 1 });
	// shallow (depth 1) is discovered; deep/x/y (depth 3) is beyond maxDepth.
	assert.strictEqual(r.repos.length, 1);
	assert.strictEqual(r.repos[0].root, '/root/shallow');
	assert.strictEqual(r.unversionedRoot, '/root'); // unscanned deep content → loose
});

// ── T8: branch parsing (ref vs detached HEAD) ────────────────────────────────────

test('T8 detached HEAD yields undefined branch', async () => {
	const probe = probeFrom(new Map([
		['/root', ['.git', 'a.ts']],
	]), new Map([
		['/root/.git/HEAD', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'],
	]));
	const r = await discoverGitRepos('/root', probe);
	assert.strictEqual(r.repos.length, 1);
	assert.strictEqual(r.repos[0].branch, undefined);
});

// ── T9: inaccessible subfolder is skipped, others still discovered ───────────────

test('T9 inaccessible subfolder → skipped, sibling repo still found', async () => {
	const tree = new Map<string, string[]>([
		['/root', ['ok', 'broken']],
		['/root/ok', ['.git', 'a.ts']],
		// 'broken' is present as an entry but listFolder throws.
	]);
	class BrokenProbe extends MockFileProbe {
		override async listFolder(path: string): Promise<readonly string[]> {
			if (path === '/root/broken') { throw new Error('EACCES'); }
			return super.listFolder(path);
		}
	}
	const dirs = new Set<string>(['/root', '/root/ok', '/root/ok/.git' /* .git dir */]);
	const probe = new BrokenProbe(tree, dirs, new Map([
		['/root/ok/.git/HEAD', 'ref: refs/heads/main'],
	]));
	const r = await discoverGitRepos('/root', probe);
	assert.strictEqual(r.repos.length, 1);
	assert.strictEqual(r.repos[0].root, '/root/ok');
});

test('FsGitRepoProbe adapts IFileService → IGitRepoProbe (end-to-end with discoverGitRepos)', async () => {
		// Minimal in-memory IFileService fake — models the same tree as the MockFileProbe tests
		// but goes through the real `resolve` / `stat` / `readFile` surface used in production,
		// so the gitRepoDiscovery pipeline is exercised against the actual disk bridge.
		// `FsGitRepoProbe` calls `URI.file(path)`, so the path arrives via `uri.fsPath` which on
		// Windows is normalized (e.g. `\\root` / `C:\root`); normalize keys to posix to stay
		// platform-independent.
		const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/\/+/g, '/');
		class FakeFs {
			constructor(
				private readonly tree: Map<string, string[]>,
				private readonly dirs: Set<string>,
				private readonly files: Map<string, string>,
			) {}
			async resolve(uri: { fsPath: string }) {
				const kids = this.tree.get(norm(uri.fsPath)) ?? [];
				return { children: kids.map(name => ({ name })) };
			}
			async stat(uri: { fsPath: string }) {
				return { isDirectory: this.dirs.has(norm(uri.fsPath)) };
			}
			async readFile(uri: { fsPath: string }) {
				const c = this.files.get(norm(uri.fsPath));
				if (c === undefined) { throw new Error(`ENOENT: ${uri.fsPath}`); }
				return { value: { toString: () => c } };
			}
		}

	const tree = new Map<string, string[]>([
		['/root', ['.git', 'src', 'a.ts']],
		['/root/src', ['b.ts']],
	]);
	const dirs = new Set<string>(['/root', '/root/.git', '/root/src']);
	const files = new Map<string, string>([
		['/root/.git/HEAD', 'ref: refs/heads/main'],
		['/root/a.ts', 'root file'],
		['/root/src/b.ts', 'src file'],
	]);
	const probe = new FsGitRepoProbe(new FakeFs(tree, dirs, files) as unknown as IFileService);

	// IGitRepoProbe surface
	assert.deepStrictEqual([...(await probe.listFolder('/root'))].sort(), ['.git', 'a.ts', 'src']);
	assert.strictEqual(await probe.isDirectory('/root/.git'), true);
	assert.strictEqual(await probe.isDirectory('/root/a.ts'), false);
	assert.strictEqual(await probe.readFile('/root/a.ts'), 'root file');

	// End-to-end: the real probe drives discovery exactly like the mock does.
	const r = await discoverGitRepos('/root', probe);
	assert.strictEqual(r.repos.length, 1);
	assert.strictEqual(r.repos[0].root, '/root');
	assert.strictEqual(r.repos[0].branch, 'main');
});
