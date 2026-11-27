/*---------------------------------------------------------------------------------------------
 * Copyright (c) Saros. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DshRuntimeProbeCache } from '../../electron-main/dshRuntimeProbeCache.js';
import { DshRuntimeManager, injectBundledPnpm } from '../../electron-main/dshRuntimeManager.js';
import { findMediaBinDirs } from '../../electron-main/dshHostSupervisor.js';

suite('dsh runtime probe cache', () => {
	let root: string;
	let file: string;
	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-cache-'));
		file = path.join(root, 'node-file');
		fs.writeFileSync(file, 'fixture');
	});
	teardown(() => fs.rmSync(root, { recursive: true, force: true }));

	test('single media traversal keeps first-match order, depth bounds and skips linked directories', () => {
		const first = path.join(root, 'a', 'bin');
		const other = path.join(root, 'z', 'bin');
		fs.mkdirSync(first, { recursive: true });
		fs.mkdirSync(other, { recursive: true });
		fs.writeFileSync(path.join(first, 'FFMPEG.exe'), 'first');
		fs.writeFileSync(path.join(other, 'ffmpeg.exe'), 'later');
		fs.writeFileSync(path.join(other, 'yt-dlp.exe'), 'second');
		assert.deepStrictEqual([...findMediaBinDirs(root, ['ffmpeg.exe', 'yt-dlp.exe'])], [['ffmpeg.exe', first], ['yt-dlp.exe', other]]);
		assert.strictEqual(findMediaBinDirs(root, ['ffmpeg.exe'], 1).size, 0);
		const linked = path.join(root, 'links');
		fs.mkdirSync(linked);
		fs.symlinkSync(first, path.join(linked, 'target'), 'junction');
		assert.strictEqual(findMediaBinDirs(linked, ['ffmpeg.exe']).size, 0);
		assert.strictEqual(findMediaBinDirs(path.join(root, 'missing'), ['ffmpeg.exe']).size, 0);
	});

	test('same file identity merges in-flight work and reuses successful probes', async () => {
		const cache = new DshRuntimeProbeCache();
		let done!: (value: string) => void;
		let calls = 0;
		const probe = () => { calls++; return new Promise<string>(resolve => { done = resolve; }); };
		const first = cache.run([file], probe, () => true);
		assert.strictEqual(first, cache.run([file], probe, () => true));
		await Promise.resolve();
		assert.strictEqual(calls, 1);
		done('ok');
		assert.strictEqual(await first, 'ok');
		assert.strictEqual(await cache.run([file], probe, () => true), 'ok');
		assert.strictEqual(calls, 1);
	});

	test('TTL, replacement of either input and explicit clear invalidate cached probes', async () => {
		let now = 0;
		let calls = 0;
		const cache = new DshRuntimeProbeCache(() => now, 30);
		const bin = path.join(root, 'bin.js');
		fs.writeFileSync(bin, 'first');
		const probe = async () => ++calls;
		assert.strictEqual(await cache.run([file, bin], probe, () => true), 1);
		now = 31;
		assert.strictEqual(await cache.run([file, bin], probe, () => true), 2);
		fs.writeFileSync(bin, 'replacement');
		assert.strictEqual(await cache.run([file, bin], probe, () => true), 3);
		fs.writeFileSync(file, 'new executable');
		assert.strictEqual(await cache.run([file, bin], probe, () => true), 4);
		cache.clear();
		assert.strictEqual(await cache.run([file, bin], probe, () => true), 5);
	});

	test('failed, rejected or changed-during-probe results are not cached', async () => {
		const cache = new DshRuntimeProbeCache();
		await assert.rejects(cache.run([file], async () => { throw new Error('failed'); }, () => true), /failed/);
		assert.strictEqual(await cache.run([file], async () => 'retry', () => true), 'retry');
		cache.clear();
		assert.strictEqual(await cache.run([file], async () => 'bad', () => false), 'bad');
		assert.strictEqual(await cache.run([file], async () => 'good', () => true), 'good');
		cache.clear();
		let count = 0;
		await cache.run([file], async () => { count++; fs.writeFileSync(file, 'changed'); return 'old'; }, () => true);
		await cache.run([file], async () => { count++; return 'new'; }, () => true);
		assert.strictEqual(count, 2);
	});

	test('bare PATH commands and missing files always fall back to the actual probe', async () => {
		const cache = new DshRuntimeProbeCache();
		let count = 0;
		for (const name of ['node', path.join(root, 'missing')]) {
			await cache.run([name], async () => ++count, () => true);
			await cache.run([name], async () => ++count, () => true);
		}
		assert.strictEqual(count, 4);
	});

	test('actual manager reuses dsh version probe but still rejects a missing core package', async () => {
		const version = '0.2.2-rc.5';
		const directory = path.join(root, 'bundled', version);
		const scope = path.join(directory, 'node_modules', '@deepseek-ai');
		for (const name of ['dsh', 'dsh-app-boot', 'dsh-tools']) {
			fs.mkdirSync(path.join(scope, name, 'lib'), { recursive: true });
			fs.writeFileSync(path.join(scope, name, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version, main: 'lib/index.js' }));
		}
		const count = path.join(root, 'count.txt');
		const bin = path.join(scope, 'dsh', 'lib', 'bin.js');
		fs.writeFileSync(bin, `require('fs').appendFileSync(${JSON.stringify(count)}, '1'); console.log(${JSON.stringify(version)});`);
		fs.writeFileSync(path.join(scope, 'dsh-tools', 'lib', 'index.js'), '');
		fs.writeFileSync(path.join(scope, 'dsh-tools', 'lib', 'pipeline.js'), '');
		const manager = new DshRuntimeManager(path.join(root, 'managed'), () => {}, path.join(root, 'bundled'), version);
		const node = { path: process.execPath, version: process.version, source: 'path' as const };
		await Promise.all([manager.resolveDsh(undefined, node), manager.resolveDsh(undefined, node)]);
		assert.strictEqual(fs.readFileSync(count, 'utf8'), '1');
		fs.unlinkSync(path.join(scope, 'dsh-tools', 'package.json'));
		await assert.rejects(manager.resolveDsh(undefined, node), /不完整/);
		assert.strictEqual(fs.readFileSync(count, 'utf8'), '1');
	});

	test('valid bundled pnpm never executes a PATH probe and isolates interpreter shims', () => {
		const pin = '11.28.5';
		const app = path.join(root, 'app');
		const entry = path.join(app, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
		fs.mkdirSync(path.dirname(entry), { recursive: true });
		fs.mkdirSync(path.join(app, 'node_modules', 'pnpm', 'dist'));
		fs.writeFileSync(entry, 'fixture');
		fs.writeFileSync(path.join(app, 'node_modules', 'pnpm', 'dist', 'pnpm.mjs'), 'fixture');
		fs.writeFileSync(path.join(app, 'node_modules', 'pnpm', 'package.json'), JSON.stringify({ version: pin }));
		fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ devDependencies: { pnpm: pin }, packageManager: `pnpm@${pin}` }));
		const commands = path.join(root, 'commands');
		fs.mkdirSync(commands);
		const marker = path.join(root, 'unexpected-probe');
		const windows = process.platform === 'win32';
		fs.writeFileSync(path.join(commands, windows ? 'pnpm.cmd' : 'pnpm'), windows ? `@echo off\r\necho called > "${marker}"\r\n` : `#!/bin/sh\necho called > "${marker}"\n`, { mode: 0o755 });
		const env = { PATH: commands };
		const other = { PATH: commands };
		injectBundledPnpm(env, process.execPath, app);
		injectBundledPnpm(other, path.join(root, 'other-node'), app);
		const dirs = [env.PATH, other.PATH].map(value => value.split(path.delimiter)[0]);
		try {
			assert.notStrictEqual(dirs[0], dirs[1]);
			assert.strictEqual(fs.existsSync(marker), false);
			const text = fs.readFileSync(path.join(dirs[0], windows ? 'pnpm.cmd' : 'pnpm'), 'utf8');
			assert.ok(text.includes(process.execPath) && text.includes(entry));
		} finally { for (const directory of dirs) { fs.rmSync(directory, { recursive: true, force: true }); } }
	});
});
