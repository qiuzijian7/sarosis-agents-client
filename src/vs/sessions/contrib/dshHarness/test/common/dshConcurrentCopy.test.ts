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

import { copyDirectoryConcurrently } from '../../electron-main/dshConcurrentCopy.js';

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

	test('源目录不存在时向上抛错（回滚由调用方负责）', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cc-missing-'));
		try {
			await assert.rejects(() => copyDirectoryConcurrently(path.join(root, 'nope'), path.join(root, 'dest'), { dereference: true }));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
