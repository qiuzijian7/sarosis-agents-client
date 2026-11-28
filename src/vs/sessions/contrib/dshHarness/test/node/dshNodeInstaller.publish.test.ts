/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 托管 Node 落位：Windows 上「整目录 rename 持续 EPERM」的真机回归（安装包首启）。
 * 用真实文件系统 + 注入的 rename/copyDir，不联网、不下载 Node 分发包。
 *
 * Windows 实测：只要待改名目录树里有任一文件被持有句柄（或目标目录已存在），
 * `MoveFileEx` 就一直 EPERM ⇒ 重试无用，必须能退化到逐文件复制。
 */

import assert from 'assert';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { publishStagedNode } from '../../electron-main/dshNodeInstaller.js';

suite('dshHarness / managed Node publish', () => {
	let root: string;
	const logs: string[] = [];

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'vssaros-node-publish-'));
		logs.length = 0;
	});
	teardown(() => rmSync(root, { recursive: true, force: true }));

	const paths = () => ({
		stagedDir: join(root, `node.tmp-${process.pid}`, 'node-v-test-win-x64'),
		finalDir: join(root, 'node'),
		oldDir: join(root, `node.old-${process.pid}`),
	});

	function tree(base: string, marker: string): void {
		mkdirSync(join(base, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
		writeFileSync(join(base, 'node.exe'), marker);
		writeFileSync(join(base, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), marker);
		writeFileSync(join(base, '.vssaros-node.json'), marker);
	}

	function errorWithCode(code: string): NodeJS.ErrnoException {
		return Object.assign(new Error(`${code}: simulated`), { code });
	}

	/** 只锁住「暂存目录 → final」这一跳（模拟杀软占着刚解压出来的那份），其余 rename 走真实 fs。 */
	const renameWithLockedStaging = (stagedDir: string) => async (from: string, to: string): Promise<void> => {
		if (from === stagedDir) {
			throw errorWithCode('EPERM');
		}
		await fsp.rename(from, to);
	};

	const alwaysLocked = async (): Promise<void> => { throw errorWithCode('EPERM'); };

	test('正常路径：旧目录让位 + 原子 rename 就位 + 清理 old', async () => {
		const p = paths();
		tree(p.stagedDir, 'new');
		tree(p.finalDir, 'old');
		await publishStagedNode({ ...p, log: l => logs.push(l) });
		assert.strictEqual(readFileSync(join(p.finalDir, 'node.exe'), 'utf8'), 'new');
		assert.ok(!existsSync(p.oldDir), 'old 已清理');
		assert.ok(!existsSync(p.stagedDir), '暂存目录已被整体移走');
		assert.deepStrictEqual(logs, [], '正常路径不该打降级日志');
	});

	test('首装时 rename 持续 EPERM ⇒ 逐文件复制兜底（安装包首启真机场景）', async () => {
		const p = paths();
		tree(p.stagedDir, 'new');
		await publishStagedNode({ ...p, rename: alwaysLocked, log: l => logs.push(l) });
		assert.strictEqual(readFileSync(join(p.finalDir, 'node.exe'), 'utf8'), 'new');
		assert.strictEqual(readFileSync(join(p.finalDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'utf8'), 'new');
		assert.strictEqual(readFileSync(join(p.finalDir, '.vssaros-node.json'), 'utf8'), 'new');
		assert.ok(!existsSync(p.oldDir));
		assert.match(logs.join('\n'), /逐文件复制落位/);
	});

	test('升级时暂存 rename 被占用 ⇒ 恢复旧目录后就地覆盖', async () => {
		const p = paths();
		tree(p.stagedDir, 'new');
		tree(p.finalDir, 'old');
		await publishStagedNode({ ...p, rename: renameWithLockedStaging(p.stagedDir), log: l => logs.push(l) });
		assert.strictEqual(readFileSync(join(p.finalDir, 'node.exe'), 'utf8'), 'new', '旧 node.exe 被覆盖');
		assert.strictEqual(readFileSync(join(p.finalDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'utf8'), 'new');
		assert.ok(!existsSync(p.oldDir), '旧目录已恢复并清理，没有留下孤儿备份');
		assert.match(logs.join('\n'), /逐文件复制落位/);
	});

	test('非锁类错误不被吞掉，且旧目录恢复原位', async () => {
		const p = paths();
		tree(p.stagedDir, 'new');
		tree(p.finalDir, 'old');
		const rename = async (from: string, to: string): Promise<void> => {
			if (from === p.stagedDir) {
				throw errorWithCode('ENOENT');
			}
			await fsp.rename(from, to);
		};
		await assert.rejects(publishStagedNode({ ...p, rename, log: l => logs.push(l) }), /ENOENT/);
		assert.strictEqual(readFileSync(join(p.finalDir, 'node.exe'), 'utf8'), 'old', '原有的托管 Node 完好');
		assert.ok(!existsSync(p.oldDir));
		assert.deepStrictEqual(logs, [], '不该误走复制兜底');
	});

	// 不用 mock：真的持有一个源文件句柄，让 Windows 自己把整目录 rename 判成 EPERM。
	// 非 Windows 上 rename 不受句柄影响，这条不适用。
	(process.platform === 'win32' ? test : test.skip)('真机复现：源文件被占用时仍能落位', async () => {
		const p = paths();
		tree(p.stagedDir, 'new');
		const handle = openSync(join(p.stagedDir, 'node.exe'), 'r');
		try {
			await publishStagedNode({ ...p, log: l => logs.push(l) });
		} finally {
			closeSync(handle);
		}
		assert.strictEqual(readFileSync(join(p.finalDir, 'node.exe'), 'utf8'), 'new');
		assert.strictEqual(readFileSync(join(p.finalDir, '.vssaros-node.json'), 'utf8'), 'new');
		assert.match(logs.join('\n'), /逐文件复制落位/);
	});

	test('复制失败且原本没有 Node ⇒ 删掉半成品，不留假安装', async () => {
		const p = paths();
		tree(p.stagedDir, 'new');
		const copyDir = async (_from: string, to: string): Promise<void> => {
			writeFileSync(join(to, 'node.exe'), 'half');
			throw errorWithCode('EBUSY');
		};
		await assert.rejects(
			publishStagedNode({ ...p, rename: alwaysLocked, copyDir, log: l => logs.push(l) }),
			/托管 Node 落位失败/,
		);
		assert.ok(!existsSync(join(p.finalDir, 'node.exe')), '半成品被清掉，下次启动会重新下载');
	});
});
