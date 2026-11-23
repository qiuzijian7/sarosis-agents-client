/**
 * `lib/profileWritable.js` 的行为守卫（2026-11-23）。
 *
 * 运行：node dsh-plugins/vssaros-market/test/run-profile-writable-check.mjs
 *
 * 钉住：未注入共享标记时完全 no-op；共享态写前物化会把 `node_modules` 落为真实副本，
 * 且**种子目录本身不被改动**（这条守的是"别顺着 junction 删掉安装目录"）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureWritableProfile, sharedProfileDir } from '../lib/profileWritable.js';

function makeSeed(root) {
	const seed = path.join(root, 'seed');
	fs.mkdirSync(path.join(seed, 'node_modules', 'yaml'), { recursive: true });
	fs.mkdirSync(path.join(seed, '.vssaros'), { recursive: true });
	fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"seed"}');
	fs.writeFileSync(path.join(seed, 'node_modules', 'yaml', 'index.js'), 'YAML');
	return seed;
}

const results = [];
async function check(name, fn) {
	await fn();
	results.push(name);
	console.log(`ok - ${name}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pw-'));
try {
	await check('未注入标记时是 no-op', async () => {
		assert.equal(sharedProfileDir({}), undefined);
		assert.equal(sharedProfileDir({ VSSAROS_PROFILE_SHARED: '0' }), undefined);
		assert.equal(await ensureWritableProfile(undefined), false);
		assert.equal(await ensureWritableProfile(path.join(root, 'nowhere')), false);
	});

	await check('共享态物化：联接变真实副本，种子不动', async () => {
		const seed = makeSeed(root);
		const profile = path.join(root, 'profiles', 'vssaros');
		fs.mkdirSync(profile, { recursive: true });
		fs.symlinkSync(path.join(seed, 'node_modules'), path.join(profile, 'node_modules'), 'junction');
		const dir = sharedProfileDir({ VSSAROS_PROFILE_SHARED: '1', VSSAROS_PROFILE_DIR: profile });
		assert.equal(dir, profile);
		assert.equal(await ensureWritableProfile(dir), true);
		assert.equal(fs.lstatSync(path.join(profile, 'node_modules')).isSymbolicLink(), false);
		assert.equal(fs.readFileSync(path.join(profile, 'node_modules', 'yaml', 'index.js'), 'utf8'), 'YAML');
		assert.equal(fs.readFileSync(path.join(seed, 'node_modules', 'yaml', 'index.js'), 'utf8'), 'YAML');
		assert.equal(await ensureWritableProfile(dir), false, '已物化后应 no-op');
	});

	await check('主插件模块仍可加载（import 路径未写错）', async () => {
		const mod = await import('../lib/index.js');
		assert.equal(mod.name, 'vssaros-market');
	});
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${results.length} checks passed`);
