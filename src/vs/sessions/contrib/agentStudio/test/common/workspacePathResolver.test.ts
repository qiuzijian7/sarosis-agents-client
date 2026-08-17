/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { isLinux, isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveWorkspacePath } from '../../common/workspacePathResolver.js';

/**
 * 把解析后的路径归一化为与平台无关的 posix 风格 path，便于跨平台稳定断言。
 * `URI.file()` 会统一盘符与正/反斜杠，因此 `\workspace\a` 与 `/workspace/a`
 * 归一化后相等。
 */
function normPath(p: string): string {
	return URI.file(p).path;
}

suite('workspacePathResolver - resolveWorkspacePath', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// 统一使用 posix 风格绝对根，保证 path.isAbsolute / path.join 在所有平台行为一致。
	const ROOT = '/workspace/repo';

	// ─── 相对路径解析 ─────────────────────────────────────────────

	test('relative "." resolves to the root and is allowed', () => {
		const r = resolveWorkspacePath('.', [ROOT]);
		assert.strictEqual(r.isAllowed, true);
		assert.strictEqual(normPath(r.resolvedPath), '/workspace/repo');
	});

	test('relative "./src" resolves under the root and is allowed', () => {
		const r = resolveWorkspacePath('./src', [ROOT]);
		assert.strictEqual(r.isAllowed, true);
		assert.strictEqual(normPath(r.resolvedPath), '/workspace/repo/src');
	});

	test('relative nested "src/app/main.ts" resolves under the root', () => {
		const r = resolveWorkspacePath('src/app/main.ts', [ROOT]);
		assert.strictEqual(r.isAllowed, true);
		assert.strictEqual(normPath(r.resolvedPath), '/workspace/repo/src/app/main.ts');
	});

	// ─── 路径穿越（../）防护 ───────────────────────────────────────

	test('relative traversal "../../etc/passwd" escapes the root and is denied', () => {
		const r = resolveWorkspacePath('../../etc/passwd', [ROOT]);
		assert.strictEqual(r.isAllowed, false);
		// `..` 段被 normalize 折叠，解析结果已逃逸出沙箱根。
		assert.strictEqual(normPath(r.resolvedPath), '/etc/passwd');
	});

	test('relative traversal back into root "../repo/a.ts" stays allowed', () => {
		const r = resolveWorkspacePath('../repo/a.ts', [ROOT]);
		assert.strictEqual(r.isAllowed, true);
		assert.strictEqual(normPath(r.resolvedPath), '/workspace/repo/a.ts');
	});

	// ─── 绝对路径边界 ─────────────────────────────────────────────

	test('absolute path inside root is allowed', () => {
		const r = resolveWorkspacePath('/workspace/repo/src/a.ts', [ROOT]);
		assert.strictEqual(r.isAllowed, true);
	});

	test('absolute path equal to root itself is allowed', () => {
		const r = resolveWorkspacePath('/workspace/repo', [ROOT]);
		assert.strictEqual(r.isAllowed, true);
	});

	test('absolute path outside root is denied', () => {
		const r = resolveWorkspacePath('/etc/passwd', [ROOT]);
		assert.strictEqual(r.isAllowed, false);
	});

	// ─── 关键：兄弟目录前缀不得误判（验证非朴素 startsWith） ──────────

	test('sibling dir sharing root prefix "/workspace/repofoo" is denied', () => {
		// 朴素的 startsWith('/workspace/repo') 会把 "/workspace/repofoo" 误判为 allowed；
		// isEqualOrParent 以路径段为边界，正确拒绝。
		const r = resolveWorkspacePath('/workspace/repofoo/a.ts', [ROOT]);
		assert.strictEqual(r.isAllowed, false);
	});

	test('sibling file sharing root prefix "/workspace/repo.bak" is denied', () => {
		const r = resolveWorkspacePath('/workspace/repo.bak', [ROOT]);
		assert.strictEqual(r.isAllowed, false);
	});

	// ─── 多根 ─────────────────────────────────────────────────────

	test('absolute path matching the second of multiple roots is allowed', () => {
		const r = resolveWorkspacePath('/workspace/other/b.ts', ['/workspace/repo', '/workspace/other']);
		assert.strictEqual(r.isAllowed, true);
	});

	test('relative path always resolves against the FIRST root', () => {
		const r = resolveWorkspacePath('b.ts', ['/workspace/repo', '/workspace/other']);
		assert.strictEqual(normPath(r.resolvedPath), '/workspace/repo/b.ts');
		assert.strictEqual(r.isAllowed, true);
	});

	// ─── 空 / 退化输入 ────────────────────────────────────────────

	test('empty allowedRoots denies everything and returns path unchanged', () => {
		const r = resolveWorkspacePath('./src', []);
		assert.strictEqual(r.isAllowed, false);
		assert.strictEqual(r.resolvedPath, './src');
		assert.deepStrictEqual(r.normalizedRoots, []);
	});

	test('blank / empty root entries are filtered out of normalizedRoots', () => {
		const r = resolveWorkspacePath('/workspace/repo/a.ts', ['', ROOT]);
		assert.deepStrictEqual(r.normalizedRoots, ['/workspace/repo']);
		assert.strictEqual(r.isAllowed, true);
	});

	// ─── 根归一化（去尾分隔符 + 去重） ────────────────────────────

	test('trailing slashes are trimmed from roots', () => {
		const r = resolveWorkspacePath('/workspace/repo/a.ts', ['/workspace/repo/']);
		assert.deepStrictEqual(r.normalizedRoots, ['/workspace/repo']);
		assert.strictEqual(r.isAllowed, true);
	});

	test('duplicate roots are de-duplicated', () => {
		const r = resolveWorkspacePath('/workspace/repo/a.ts', ['/workspace/repo', '/workspace/repo/']);
		assert.deepStrictEqual(r.normalizedRoots, ['/workspace/repo']);
	});

	// ─── 跨平台大小写语义（本次修复的核心 bug） ───────────────────

	test('case sensitivity follows the file system (not a blanket toLowerCase)', () => {
		// root = /workspace/repo（小写），请求 /workspace/Repo/x（大写 R）。
		// 旧实现一刀切 toLowerCase 会无条件判为 allowed，在大小写敏感的 Linux
		// 上构成越界。新实现按文件系统语义：Linux 拒绝，非 Linux 允许。
		const r = resolveWorkspacePath('/workspace/Repo/x.ts', [ROOT]);
		if (isLinux) {
			assert.strictEqual(r.isAllowed, false, 'Linux 文件系统大小写敏感，应拒绝越界');
		} else {
			assert.strictEqual(r.isAllowed, true, '非 Linux 文件系统忽略大小写，应允许');
		}
	});

	// ─── worktree 独占沙箱场景 ────────────────────────────────────

	// 显式平台分支守卫（本次任务核心交付）：把「跨平台大小写语义」逐 OS 写明，
	// 防止有人把 isEqualOrParent 回退为一刀切 toLowerCase() canonicalize ——
	// 那会在 Linux 上抹平大小写差异、放行越界。
	//
	// 真实文件系统语义（base/common/resources.ts 的 extUriBiasedIgnorePathCase）：
	//   Linux   大小写敏感   → 拒绝 /workspace/Repo 越界
	//   macOS   大小写不敏感 → 允许
	//   Windows 大小写不敏感 → 允许
	// 注：早期任务描述曾写「macOS 区分大小写→deny」，但与 extUriBiasedIgnorePathCase
	// 实际行为（及上方既有用例）冲突，故按真实语义断言，避免 macOS/Windows CI 失败。

	test('Linux: case-sensitive "/workspace/Repo" is denied (guard against canonicalize)', () => {
		if (!isLinux) { return; }
		const r = resolveWorkspacePath('/workspace/Repo/x.ts', [ROOT]);
		assert.strictEqual(r.isAllowed, false, 'Linux fs is case-sensitive; blanket toLowerCase() would wrongly allow');
	});

	test('macOS: case-insensitive "/workspace/Repo" is allowed', () => {
		if (!isMacintosh) { return; }
		const r = resolveWorkspacePath('/workspace/Repo/x.ts', [ROOT]);
		assert.strictEqual(r.isAllowed, true, 'macOS fs is case-insensitive; must still allow');
	});

	test('Windows: case-insensitive "/workspace/Repo" is allowed', () => {
		if (!isWindows) { return; }
		const r = resolveWorkspacePath('/workspace/Repo/x.ts', [ROOT]);
		assert.strictEqual(r.isAllowed, true, 'Windows fs is case-insensitive; must still allow');
	});

	test('worktree-sandboxed single root allows paths inside the worktree', () => {
		const worktree = '/workspace/repo/.worktrees/feat-x';
		const r = resolveWorkspacePath('src/feature.ts', [worktree]);
		assert.strictEqual(r.isAllowed, true);
		assert.strictEqual(normPath(r.resolvedPath), '/workspace/repo/.worktrees/feat-x/src/feature.ts');
	});

	test('worktree-sandboxed root denies access to the main checkout', () => {
		const worktree = '/workspace/repo/.worktrees/feat-x';
		// 主仓目录在 worktree 之外 —— 独占沙箱下必须拒绝。
		const r = resolveWorkspacePath('/workspace/repo/src/main.ts', [worktree]);
		assert.strictEqual(r.isAllowed, false);
	});
});
