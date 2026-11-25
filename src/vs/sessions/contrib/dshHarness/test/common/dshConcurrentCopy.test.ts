/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `copyDirectoryConcurrently`（首启种子复制的并发实现）的行为守卫。
 *
 * 口径：与 `fsp.cp(src, dest, { recursive: true, force: true })` 对齐 —— 目录结构/文件内容一致、
 * 覆盖已存在文件、链接按 `dereference` 解引用成真实目录、失败向上冒且不在本层做回滚。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshConcurrentCopy
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { copyDirectoryConcurrently, copyFileWithRetry } from '../../electron-main/dshConcurrentCopy.js';

/** 目录快照：相对路径 → 文件内容（空目录单独断言，不混进内容比较）。 */
function snapshot(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name);
			const rel = path.relative(root, abs).replace(/\\/g, '/');
			if (entry.isDirectory()) {
				walk(abs);
			} else {
				out[rel] = fs.readFileSync(abs, 'utf8');
			}
		}
	};
	walk(root);
	return out;
}

function makeSeed(root: string): string {
	const seed = path.join(root, 'seed');
	fs.mkdirSync(path.join(seed, 'a', 'b'), { recursive: true });
	fs.mkdirSync(path.join(seed, 'empty'), { recursive: true });
	fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"seed"}');
	fs.writeFileSync(path.join(seed, 'a', 'one.txt'), 'ONE');
	fs.writeFileSync(path.join(seed, 'a', 'b', 'two.txt'), 'TWO');
	return seed;
}

suite('dshHarness / 并发目录复制', () => {

	test('目录结构与文件内容与源一致（含空目录）', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cc-basic-'));
		try {
			const seed = makeSeed(root);
			const dest = path.join(root, 'dest');
			await copyDirectoryConcurrently(seed, dest, { dereference: true });
			assert.deepStrictEqual(snapshot(dest), snapshot(seed));
			assert.ok(fs.statSync(path.join(dest, 'empty')).isDirectory(), '空目录也要建出来');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('并发度 1 与 16 的产物一致', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cc-par-'));
		try {
			const seed = makeSeed(root);
			const serial = path.join(root, 'serial');
			const parallel = path.join(root, 'parallel');
			await copyDirectoryConcurrently(seed, serial, { concurrency: 1, dereference: true });
			await copyDirectoryConcurrently(seed, parallel, { concurrency: 16, dereference: true });
			assert.deepStrictEqual(snapshot(parallel), snapshot(serial));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('已存在的同名文件被覆盖（force 语义）', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cc-force-'));
		try {
			const seed = makeSeed(root);
			const dest = path.join(root, 'dest');
			fs.mkdirSync(path.join(dest, 'a'), { recursive: true });
			fs.writeFileSync(path.join(dest, 'a', 'one.txt'), 'STALE');
			await copyDirectoryConcurrently(seed, dest, { dereference: true });
			assert.deepStrictEqual(snapshot(dest), snapshot(seed));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('dereference: true 把 junction 复制成真实目录（Windows 非管理员建 symlink 会 EPERM）', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cc-links-'));
		try {
			const seed = makeSeed(root);
			fs.symlinkSync(path.join(seed, 'a'), path.join(seed, 'link'), 'junction');
			const dest = path.join(root, 'dest');
			await copyDirectoryConcurrently(seed, dest, { dereference: true });
			const linked = fs.lstatSync(path.join(dest, 'link'));
			assert.ok(linked.isDirectory() && !linked.isSymbolicLink(), '链接必须解引用成真实目录');
			assert.strictEqual(fs.readFileSync(path.join(dest, 'link', 'one.txt'), 'utf8'), 'ONE');
			assert.strictEqual(fs.readFileSync(path.join(dest, 'link', 'b', 'two.txt'), 'utf8'), 'TWO');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('无文件锁时只复制一次，不产生退避等待', async () => {
		let calls = 0;
		await copyFileWithRetry('source', 'target', {
			copyFile: async (from, to) => {
				assert.deepStrictEqual([from, to], ['source', 'target']);
				calls++;
			},
			sleep: async () => assert.fail('成功复制不应等待'),
		});
		assert.strictEqual(calls, 1);
	});

	test('EBUSY/EPERM 暂态锁按退避重试，成功后立即停止', async () => {
		for (const code of ['EBUSY', 'EPERM']) {
			let calls = 0;
			const delays: number[] = [];
			await copyFileWithRetry('source', 'target', {
				copyFile: async () => {
					if (++calls <= 2) { throw Object.assign(new Error('locked'), { code }); }
				},
				sleep: async delay => { delays.push(delay); },
			});
			assert.strictEqual(calls, 3);
			assert.deepStrictEqual(delays, [100, 250]);
		}
	});

	test('锁持续存在时最多六次复制，耗尽后保留原错误和路径', async () => {
		for (const code of ['EBUSY', 'EPERM']) {
			const error = Object.assign(new Error('locked'), { code, path: 'source', dest: 'target' });
			let calls = 0;
			const delays: number[] = [];
			await assert.rejects(() => copyFileWithRetry('source', 'target', {
				copyFile: async () => { calls++; throw error; },
				sleep: async delay => { delays.push(delay); },
			}), e => e === error);
			assert.strictEqual(calls, 6);
			assert.deepStrictEqual(delays, [100, 250, 500, 1_000, 2_000]);
		}
	});

	test('ENOENT/EACCES/EIO 等非暂态错误直接抛出，不重试', async () => {
		for (const code of ['ENOENT', 'EACCES', 'EIO']) {
			const error = Object.assign(new Error('copy failed'), { code });
			let calls = 0;
			await assert.rejects(() => copyFileWithRetry('source', 'target', {
				copyFile: async () => { calls++; throw error; },
				sleep: async () => assert.fail('非暂态错误不应等待'),
			}), e => e === error);
			assert.strictEqual(calls, 1);
		}
	});

	test('worker 遇到暂态锁后完整复制文件，不静默跳过', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cc-retry-'));
		try {
			const seed = makeSeed(root);
			const dest = path.join(root, 'dest');
			const attempts = new Map<string, number>();
			await copyDirectoryConcurrently(seed, dest, {
				dereference: true,
				retryDelaysMs: [0],
				sleep: async () => undefined,
				copyFile: async (from, to) => {
					const count = (attempts.get(from) ?? 0) + 1;
					attempts.set(from, count);
					if (count === 1) { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); }
					await fs.promises.copyFile(from, to);
				},
			});
			assert.deepStrictEqual(snapshot(dest), snapshot(seed));
			assert.ok([...attempts.values()].every(count => count === 2));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('worker 失败后停止领新文件，等待所有在途复制收尾才抛出', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cc-drain-'));
		try {
			const seed = makeSeed(root);
			let release!: () => void;
			const gate = new Promise<void>(resolve => { release = resolve; });
			let secondStarted!: () => void;
			const second = new Promise<void>(resolve => { secondStarted = resolve; });
			const error = Object.assign(new Error('locked'), { code: 'EBUSY' });
			let calls = 0;
			let finished = false;
			const pending = copyDirectoryConcurrently(seed, path.join(root, 'dest'), {
				concurrency: 2,
				retryDelaysMs: [],
				copyFile: async () => {
					if (++calls === 1) { throw error; }
					secondStarted();
					await gate;
					finished = true;
				},
			});
			const rejected = assert.rejects(pending, e => e === error);
			await second;
			assert.strictEqual(finished, false);
			release();
			await rejected;
			assert.strictEqual(finished, true);
			assert.strictEqual(calls, 2, '失败后不许继续领第三个文件');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('源目录不存在时向上抛错（回滚由调用方负责）', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cc-missing-'));
		try {
			await assert.rejects(() => copyDirectoryConcurrently(path.join(root, 'nope'), path.join(root, 'dest'), { dereference: true }));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
