/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { enableWorktreeLongPaths, renderWorktreeLongPathsPreload } from '../../common/dshWorktreeLongPaths.js';

const fixture = `export class WorktreeService {
  gitArgv(args) {
    return [
      this.config.gitCommand,
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      ...args
    ];
  }
}`;

suite('dshHarness / Windows worktree long paths', () => {
	let root: string;
	setup(() => { root = mkdtempSync(join(tmpdir(), 'dsh-wt-long-')); });
	teardown(() => rmSync(root, { recursive: true, force: true }));

	test('补丁幂等且保留 hooks/fsmonitor 安全参数', () => {
		const patched = enableWorktreeLongPaths(fixture);
		assert.match(patched, /core.longpaths=true/);
		assert.match(patched, /core.hooksPath=\/dev\/null/);
		assert.match(patched, /core.fsmonitor=false/);
		assert.strictEqual(enableWorktreeLongPaths(patched), patched);
		assert.throws(() => enableWorktreeLongPaths(''), /unsupported gitArgv/);
		assert.throws(() => enableWorktreeLongPaths(fixture + fixture), /unsupported gitArgv/);
		assert.strictEqual(renderWorktreeLongPathsPreload('0.2.2-rc.2', 'linux'), '');
	});

	test('load hook 实际修改加载中的官方模块，不修改磁盘文件', () => {
		const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-experimental-worktree');
		mkdirSync(join(pkg, 'lib'), { recursive: true });
		writeFileSync(join(pkg, 'package.json'), JSON.stringify({ type: 'module', version: '0.2.2-rc.2' }));
		const entry = join(pkg, 'lib', 'index.js');
		writeFileSync(entry, fixture);
		const preload = join(root, 'preload.mjs');
		writeFileSync(preload, renderWorktreeLongPathsPreload('0.2.2-rc.2', 'win32'));
		const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', `const {WorktreeService} = await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log(JSON.stringify(WorktreeService.prototype.gitArgv.call({config:{gitCommand:'git'}}, ['reset', '--hard'])));`], { encoding: 'utf8', timeout: 15_000 });
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /core.longpaths=true/);
		assert.strictEqual(readFileSync(entry, 'utf8'), fixture);
	});

	test('已安装 rc.2 的 gitArgv 符合补丁契约', function () {
		const entry = join(process.cwd(), 'dsh-runtime', '0.2.2-rc.2', 'node_modules', '@deepseek-ai', 'dsh-experimental-worktree', 'lib', 'index.js');
		if (!existsSync(entry)) { this.skip(); }
		const source = readFileSync(entry, 'utf8');
		const patched = enableWorktreeLongPaths(source);
		assert.notStrictEqual(patched, source);
		assert.strictEqual(enableWorktreeLongPaths(patched), patched);
		const preload = join(root, 'official-preload.mjs');
		writeFileSync(preload, renderWorktreeLongPathsPreload('0.2.2-rc.2', 'win32'));
		const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', `const {WorktreeService} = await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log(JSON.stringify(WorktreeService.prototype.gitArgv.call({config:{gitCommand:'git'}}, ['reset', '--hard'])));`], { encoding: 'utf8', timeout: 15_000 });
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /core.longpaths=true/);
		assert.strictEqual(readFileSync(entry, 'utf8'), source);
	});

	(process.platform === 'win32' ? test : test.skip)('真实 Git：命令级 longpaths 能检出超过 260 字符的工作树文件', function () {
		if (spawnSync('git', ['--version'], { windowsHide: true }).status !== 0) { this.skip(); }
		const repo = join(root, 'repo');
		mkdirSync(repo);
		const run = (cwd: string, args: string[], longPaths = true) => spawnSync('git', ['-c', `core.longpaths=${longPaths}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
		const ok = (result: ReturnType<typeof run>) => assert.strictEqual(result.status, 0, result.stderr);
		ok(run(repo, ['init', '-q', '-b', 'main']));
		const directory = join('src', 'x'.repeat(70), 'y'.repeat(70));
		const name = join(directory, 'snapshot_' + 'x'.repeat(150) + '.snap');
		mkdirSync(join(repo, directory), { recursive: true });
		writeFileSync(join(repo, name), 'snapshot content');
		ok(run(repo, ['add', '--', name]));
		ok(run(repo, ['-c', 'user.name=worktree-test', '-c', 'user.email=worktree-test@example.invalid', 'commit', '-q', '-m', 'fixture']));
		const checkout = join(repo, '.agents', 'worktrees', 'dsh-' + 'x'.repeat(75));
		mkdirSync(join(checkout, '..'), { recursive: true });
		ok(run(repo, ['worktree', 'add', '--no-checkout', '-b', 'worktree-test', '--', checkout, 'HEAD']));
		const reset = ['--work-tree', checkout, 'reset', '--hard', '--no-recurse-submodules', 'HEAD'];
		assert.ok(join(checkout, name).length > 260);
		const baseline = run(checkout, reset, false);
		if (baseline.status !== 0) {
			assert.match(baseline.stderr, /Filename too long/i);
		} else {
			console.info('    本机 Git 未复现默认路径限制；继续验证显式 longpaths 检出');
		}
		ok(run(checkout, reset));
		assert.strictEqual(readFileSync(join(checkout, name), 'utf8'), 'snapshot content');
	});
});
