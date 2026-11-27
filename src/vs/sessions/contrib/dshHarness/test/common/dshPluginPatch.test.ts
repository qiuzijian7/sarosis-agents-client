/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { DshPluginPatchManager, IDshPluginPatchOptions } from '../../electron-main/dshPluginPatchManager.js';
import { DSH_PLUGIN_PATCH_LOCK, runPluginPatchTransaction } from '../../electron-main/dshPluginPatchTransaction.js';
import { readOverrides, writeOverrides } from '../../electron-main/dshPluginOverrides.js';

suite('插件补丁防降级和批次失败恢复', () => {
	let root: string;
	setup(async () => {
		const parent = join(process.cwd(), '.build', 'test-work');
		await fs.mkdir(parent, { recursive: true });
		root = await fs.mkdtemp(join(parent, 'plugin-patch-'));
	});
	teardown(async () => { await fs.rm(root, { recursive: true, force: true }); });

	async function fixture() {
		const profile = join(root, 'profile');
		const bundled = join(root, 'bundled');
		await fs.mkdir(profile, { recursive: true });
		const originalPackage = '{"dependencies":{"@vssaros/a":"1.0.0","@vssaros/b":"1.0.0"}}';
		const originalLock = 'lockfileVersion: 9\n';
		await fs.writeFile(join(profile, 'package.json'), originalPackage);
		await fs.writeFile(join(profile, 'pnpm-lock.yaml'), originalLock);
		for (const name of ['a', 'b']) {
			await fs.mkdir(join(bundled, name), { recursive: true });
			await fs.writeFile(join(bundled, name, 'package.json'), JSON.stringify({ name: `@vssaros/${name}`, version: '1.0.0' }));
		}
		const bytes = Buffer.from('verified patch bytes');
		const hash = createHash('sha256').update(bytes).digest('hex');
		const plugins = ['a', 'b'].map(name => ({ name: `@vssaros/${name}`, version: '2.0.0', source: `dsh-plugins/${name}`, url: `/patch/${name}.tgz`, sha256: hash, size: bytes.length }));
		const installed = new Map([['@vssaros/a', '1.0.0'], ['@vssaros/b', '1.0.0']]);
		const calls: string[] = [];
		let failPackage: string | undefined;
		let wrongVersion = false;
		let restoreFails = false;
		const options: IDshPluginPatchOptions = {
			userDataPath: root, updateUrl: 'https://updates.example.test', bundledPluginsRoot: bundled,
			clientVersion: '2.2.26291', bundledPin: '0.2.2-rc.5', platform: 'win32-x64', allowUnsigned: true,
			log: () => { }, installedVersion: name => installed.get(name),
			fetch: async url => {
				calls.push(url.includes('/api/dsh-plugins') ? 'manifest' : 'download');
				return new Response(url.includes('/api/dsh-plugins') ? JSON.stringify({ schemaVersion: 1, requires: { bundled: '0.2.2-rc.5' }, plugins }) : bytes);
			},
			runTransaction: async apply => {
				const previous = new Map(installed);
				return runPluginPatchTransaction(profile, () => apply(async name => {
					calls.push(`install:${name}`);
					await fs.writeFile(join(profile, 'package.json'), '{"changed":true}');
					await fs.writeFile(join(profile, 'pnpm-lock.yaml'), 'changed lock');
					if (name === failPackage) { return { ok: false, error: 'second install failed' }; }
					const version = wrongVersion ? '1.0.0' : '2.0.0';
					installed.set(name, version);
					return { ok: true, version };
				}), async () => {
					calls.push('restore');
					if (restoreFails) { throw new Error('frozen install failed'); }
					installed.clear();
					for (const [name, version] of previous) { installed.set(name, version); }
				});
			},
		};
		return { profile, options, plugins, hash, calls, installed, originalPackage, originalLock,
			fail: (name: string) => { failPackage = name; }, wrongVersion: () => { wrongVersion = true; }, failRestore: () => { restoreFails = true; } };
	}

	test('严格更高的实装版本才提交 overrides，提交后移除事务锁', async () => {
		const f = await fixture();
		const result = await new DshPluginPatchManager(f.options).start();
		assert.deepStrictEqual(result, { ok: true, applied: 2 });
		assert.deepStrictEqual(readOverrides(root).map(entry => [entry.name, entry.version]), [['@vssaros/a', '2.0.0'], ['@vssaros/b', '2.0.0']]);
		assert.ok(!f.calls.includes('restore'));
		await assert.rejects(fs.stat(join(f.profile, DSH_PLUGIN_PATCH_LOCK)), /ENOENT/);
	});

	test('低版或同版替换在下载和安装前拒绝', async () => {
		const f = await fixture();
		for (const version of ['0.9.0', '1.0.0']) {
			f.plugins[0].version = version;
			f.calls.length = 0;
			const result = await new DshPluginPatchManager(f.options).start();
			assert.strictEqual(result.ok, false);
			assert.deepStrictEqual(f.calls, ['manifest']);
		}
	});

	test('以实装和覆盖版本为基线，不能被较旧随包版本降级', async () => {
		const f = await fixture();
		f.installed.set('@vssaros/a', '3.0.0');
		assert.strictEqual((await new DshPluginPatchManager(f.options).start()).ok, false);
		assert.deepStrictEqual(f.calls, ['manifest']);
	});

	test('第二个插件安装失败时恢复前项、原 package/lock，且不提交 overrides', async () => {
		const f = await fixture();
		f.fail('@vssaros/b');
		const result = await new DshPluginPatchManager(f.options).start();
		assert.strictEqual(result.ok, false);
		assert.match(result.error ?? '', /已恢复/);
		assert.deepStrictEqual({ installed: [...f.installed], overrides: readOverrides(root), pkg: await fs.readFile(join(f.profile, 'package.json'), 'utf8'), lock: await fs.readFile(join(f.profile, 'pnpm-lock.yaml'), 'utf8') }, { installed: [['@vssaros/a', '1.0.0'], ['@vssaros/b', '1.0.0']], overrides: [], pkg: f.originalPackage, lock: f.originalLock });
	});

	test('目标版本未真正装上时必须失败并恢复', async () => {
		const f = await fixture();
		f.wrongVersion();
		const result = await new DshPluginPatchManager(f.options).start();
		assert.strictEqual(result.ok, false);
		assert.match(result.error ?? '', /版本不匹配/);
		assert.ok(f.calls.includes('restore'));
	});

	test('overrides 提交失败同样触发依赖恢复', async () => {
		const f = await fixture();
		await fs.mkdir(join(root, 'dsh-plugin-overrides.json'));
		const result = await new DshPluginPatchManager(f.options).start();
		assert.strictEqual(result.ok, false);
		assert.ok(f.calls.includes('restore'));
	});

	test('恢复失败不能报告保留现有插件成功，必须保留备份和阻断锁', async () => {
		const f = await fixture();
		f.fail('@vssaros/b');
		f.failRestore();
		const result = await new DshPluginPatchManager(f.options).start();
		assert.strictEqual(result.ok, false);
		assert.match(result.error ?? '', /恢复失败/);
		const lock = JSON.parse(await fs.readFile(join(f.profile, DSH_PLUGIN_PATCH_LOCK), 'utf8')) as { backup: string };
		assert.strictEqual(await fs.readFile(join(lock.backup, 'package.json'), 'utf8'), f.originalPackage);
		await assert.rejects(runPluginPatchTransaction(f.profile, async () => { }, async () => { }), /EEXIST/);
	});

	test('没有旧锁文件就不开始安装，不能声称可以恢复未知依赖树', async () => {
		const f = await fixture();
		await fs.unlink(join(f.profile, 'pnpm-lock.yaml'));
		let applied = false;
		await assert.rejects(runPluginPatchTransaction(f.profile, async () => { applied = true; }, async () => { }), /ENOENT/);
		assert.strictEqual(applied, false);
	});

	test('重复包和越界 source 在安装前拒绝', async () => {
		const f = await fixture();
		f.plugins[1].name = f.plugins[0].name;
		assert.strictEqual((await new DshPluginPatchManager(f.options).start()).ok, false);
		f.plugins[1].name = '@vssaros/b';
		f.plugins[0].source = 'dsh-plugins/../outside';
		assert.strictEqual((await new DshPluginPatchManager(f.options).start()).ok, false);
		assert.ok(!f.calls.includes('download'));
	});

	test('相同已提交版本与哈希只跳过，不重复安装', async () => {
		const f = await fixture();
		writeOverrides(root, f.plugins.map(entry => ({ name: entry.name, version: entry.version, dirName: entry.source.split('/')[1], sha256: entry.sha256, archive: 'cached.tgz', appliedAt: new Date().toISOString() })));
		assert.deepStrictEqual(await new DshPluginPatchManager(f.options).start(), { ok: true, applied: 0 });
		assert.deepStrictEqual(f.calls, ['manifest']);
	});
});
