/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 共享（只读）profile / 延迟物化的行为守卫。
 *
 * 钉住两条安全红线：共享态 `node_modules` 是**链接**而不是副本；物化/清理**绝不碰种子目录本身**
 * （递归删除若顺着 junction 走，删掉的就是安装目录里的随包运行时）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshSharedProfile
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
	createSharedProfile, isSharedProfile, isSharedSeedInRuntimeTree, materializeSharedProfile, removeProfileSafely,
	runtimeRootOfDshBin, SHARED_PROFILE_ENV, sharedProfileEnabled, unlinkSharedNodeModules,
} from '../../electron-main/dshSharedProfile.js';

/** 读源码并去掉注释：静态契约断言要查的是真实代码，不是注释里出现的名字。 */
function code(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split(/\r?\n/)
		.filter(l => !/^\s*\/\//.test(l))
		.join('\n');
}

function makeSeed(root: string): string {
	const seed = path.join(root, 'seed');
	fs.mkdirSync(path.join(seed, 'node_modules', 'yaml'), { recursive: true });
	fs.mkdirSync(path.join(seed, 'node_modules', '@scope', 'pkg'), { recursive: true });
	fs.mkdirSync(path.join(seed, '.vssaros', 'plugins'), { recursive: true });
	fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"seed"}');
	fs.writeFileSync(path.join(seed, 'cordis.yml'), '[]\n');
	fs.writeFileSync(path.join(seed, '.vssaros', 'plugins', 'x.tgz'), 'TGZ');
	fs.writeFileSync(path.join(seed, 'node_modules', 'yaml', 'index.js'), 'YAML');
	fs.writeFileSync(path.join(seed, 'node_modules', '@scope', 'pkg', 'package.json'), '{"name":"@scope/pkg"}');
	return seed;
}

suite('dshHarness / 共享 profile 与延迟物化', () => {

	test('环境变量开关默认关闭，只认 1/true', () => {
		assert.strictEqual(sharedProfileEnabled({}), false);
		assert.strictEqual(sharedProfileEnabled({ [SHARED_PROFILE_ENV]: '0' }), false);
		assert.strictEqual(sharedProfileEnabled({ [SHARED_PROFILE_ENV]: '1' }), true);
		assert.strictEqual(sharedProfileEnabled({ [SHARED_PROFILE_ENV]: ' TRUE ' }), true);
	});

	test('首启只复制可写层，依赖树是指向种子的联接', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sp-create-'));
		try {
			const seed = makeSeed(root);
			const profile = path.join(root, 'profiles', 'p');
			await createSharedProfile(seed, profile);
			assert.strictEqual(await isSharedProfile(profile), true);
			assert.ok(fs.lstatSync(path.join(profile, 'node_modules')).isSymbolicLink());
			assert.strictEqual(fs.readFileSync(path.join(profile, 'cordis.yml'), 'utf8'), '[]\n');
			assert.strictEqual(fs.readFileSync(path.join(profile, '.vssaros', 'plugins', 'x.tgz'), 'utf8'), 'TGZ');
			assert.strictEqual(fs.readFileSync(path.join(profile, 'node_modules', 'yaml', 'index.js'), 'utf8'), 'YAML', '透过联接能读到共享依赖');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('物化落为真实副本，种子目录原样保留', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sp-materialize-'));
		try {
			const seed = makeSeed(root);
			const profile = path.join(root, 'profiles', 'p');
			await createSharedProfile(seed, profile);
			await materializeSharedProfile(profile);
			assert.strictEqual(await isSharedProfile(profile), false);
			assert.ok(fs.statSync(path.join(profile, 'node_modules')).isDirectory());
			assert.strictEqual(fs.readFileSync(path.join(profile, 'node_modules', 'yaml', 'index.js'), 'utf8'), 'YAML');
			assert.strictEqual(fs.readFileSync(path.join(profile, 'node_modules', '@scope', 'pkg', 'package.json'), 'utf8'), '{"name":"@scope/pkg"}');
			assert.strictEqual(fs.readFileSync(path.join(seed, 'node_modules', 'yaml', 'index.js'), 'utf8'), 'YAML', '物化是复制，不能动种子');
			await materializeSharedProfile(profile); // 已 owned：no-op，不应报错
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('摘联接与安全删除都不碰种子目录', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sp-remove-'));
		try {
			const seed = makeSeed(root);
			const profile = path.join(root, 'profiles', 'p');
			await createSharedProfile(seed, profile);
			await unlinkSharedNodeModules(profile);
			assert.strictEqual(fs.existsSync(path.join(profile, 'node_modules')), false);
			assert.strictEqual(fs.readFileSync(path.join(seed, 'node_modules', 'yaml', 'index.js'), 'utf8'), 'YAML');
			await createSharedProfile(seed, profile).catch(() => undefined); // 目录已在：认领失败属预期
			await removeProfileSafely(profile);
			assert.strictEqual(fs.existsSync(profile), false);
			assert.strictEqual(fs.readFileSync(path.join(seed, 'node_modules', 'yaml', 'index.js'), 'utf8'), 'YAML', '删除 profile 不能顺着联接删掉种子');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('坏 manifest 不落位', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sp-invalid-'));
		try {
			const seed = path.join(root, 'seed');
			fs.mkdirSync(seed, { recursive: true });
			fs.writeFileSync(path.join(seed, 'package.json'), '[]');
			const profile = path.join(root, 'profiles', 'p');
			await assert.rejects(() => createSharedProfile(seed, profile));
			assert.strictEqual(fs.existsSync(profile), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	/**
	 * 真实种子的端到端计时（默认跳过）：`VSSAROS_SHARED_E2E_SEED=<安装版 profile 种子目录>` 时才跑。
	 * 只在真机上验证「shared 首启只复制可写层、物化才复制依赖树」这条口径与耗时，不进常规回归。
	 */
	test('真实种子：shared 创建与物化的耗时（需 VSSAROS_SHARED_E2E_SEED）', async function (this: { timeout(ms: number): void }) {
		const seed = process.env.VSSAROS_SHARED_E2E_SEED;
		if (!seed || !fs.existsSync(path.join(seed, 'node_modules'))) {
			return; // 未提供真实种子：跳过
		}
		this.timeout(600_000);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sp-e2e-'));
		try {
			const profile = path.join(root, 'profiles', 'vssaros');
			let t0 = Date.now();
			await createSharedProfile(seed, profile);
			console.log(`      [e2e] shared create: ${Date.now() - t0} ms`);
			assert.strictEqual(await isSharedProfile(profile), true);
			t0 = Date.now();
			await materializeSharedProfile(profile);
			console.log(`      [e2e] materialize: ${Date.now() - t0} ms`);
			assert.strictEqual(await isSharedProfile(profile), false);
			assert.ok(fs.existsSync(path.join(profile, 'node_modules', 'package.json')) || fs.existsSync(path.join(profile, 'node_modules', '.modules.yaml')), '物化后应是真实依赖树');
			assert.ok(fs.existsSync(path.join(seed, 'node_modules')), '种子目录仍在');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('所有经主进程 / channel 的写路径都有物化前置（防回归）', () => {
		const channel = code('src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts');
		for (const cmd of ['InstallDshPlugin', 'RemoveDshPlugin', 'SetDshBundleEnabled']) {
			assert.match(channel, new RegExp(`case DshHarnessChannelCommand\\.${cmd}[\\s\\S]{0,1200}ensureProfileWritable\\(\\)`),
				`${cmd} 在转发给 Host 前必须先物化`);
		}
		const sup = code('src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts');
		assert.match(sup, /async ensureProfileWritable\(\)/, 'supervisor 要暴露给 channel 用的物化入口');
		assert.match(sup, /if \(wants\.length\) \{[\s\S]{0,200}_materializeIfShared\(pluginProfileDir\)/, '伴生安装前必须物化');
		assert.match(sup, /_repairSeededStoreMetadata\(profileDir: string\): Promise<void> \{\s*if \(await isSharedProfile\(profileDir\)\) \{/, '共享态跳过元数据写入');
	});

	test('runtimeRootOfDshBin 解析 dsh 安装根', () => {
		assert.strictEqual(runtimeRootOfDshBin('D:/app/dsh-runtime/0.2.2-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'), 'D:/app/dsh-runtime/0.2.2-rc.2');
		assert.strictEqual(runtimeRootOfDshBin('D:\\app\\dsh-runtime\\0.2.2-rc.2\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'), 'D:/app/dsh-runtime/0.2.2-rc.2');
		assert.strictEqual(runtimeRootOfDshBin('/usr/lib/other/lib/bin.js'), undefined);
	});

	test('同树校验：同树通过、跨树拒绝（含 junction 的 realpath）', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sp-tree-'));
		try {
			const makeTree = (name: string) => {
				const tree = path.join(root, name);
				fs.mkdirSync(path.join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
				fs.mkdirSync(path.join(tree, 'profile-seed', 'profiles', 'vssaros'), { recursive: true });
				fs.writeFileSync(path.join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// bin');
				return tree;
			};
			const treeA = makeTree('treeA');
			const treeB = makeTree('treeB');
			const binA = path.join(treeA, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
			const seedA = path.join(treeA, 'profile-seed', 'profiles', 'vssaros');
			const seedB = path.join(treeB, 'profile-seed', 'profiles', 'vssaros');
			assert.strictEqual(await isSharedSeedInRuntimeTree(seedA, binA), true, '同树');
			assert.strictEqual(await isSharedSeedInRuntimeTree(seedB, binA), false, '跨树（superagent 双实例那条根因）');
			const seedLink = path.join(root, 'seed-link');
			fs.symlinkSync(seedA, seedLink, 'junction');
			assert.strictEqual(await isSharedSeedInRuntimeTree(seedLink, binA), true, 'seed 是 junction 也按 realpath 判同树');
			const seedLinkB = path.join(root, 'seed-link-b');
			fs.symlinkSync(seedB, seedLinkB, 'junction');
			assert.strictEqual(await isSharedSeedInRuntimeTree(seedLinkB, binA), false, 'junction 指向另一棵树要拒绝');
			const treeC = path.join(root, 'treeC');
			fs.mkdirSync(treeC, { recursive: true });
			fs.symlinkSync(path.join(treeA, 'node_modules'), path.join(treeC, 'node_modules'), 'junction');
			const binC = path.join(treeC, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
			assert.strictEqual(await isSharedSeedInRuntimeTree(seedA, binC), true, 'dshBin 经 junction 后 realpath 仍同树');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('shared 首启有同树闸门与回退日志（静态契约）', () => {
		const sup = code('src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts');
		assert.match(sup, /sharedProfileEnabled\(\) && await isSharedSeedInRuntimeTree\(plan\.seedDir, dsh\.bin\)/, 'shared 前必须校验同树');
		assert.match(sup, /falling back to a full copy to avoid cross-tree duplicate module instances/, '跨树要回退完整复制');
	});
});
