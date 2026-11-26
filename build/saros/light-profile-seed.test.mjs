/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { archiveSeedPlugin } from './seed-package.mjs';
import { buildLightProfileSeed, LIGHT_SEED_REVISION, planLightProfileSeed, validateLightProfileSeed } from './light-profile-seed.mjs';

function write(file, contents) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
}

function install(modules, name, version, fields = {}) {
	const dir = path.join(modules, ...name.split('/'));
	write(path.join(dir, 'package.json'), { name, version, main: 'lib/index.js', ...fields });
	write(path.join(dir, 'lib', 'index.js'), 'export const value = 1;');
	if (fields.dsh?.bundle) { write(path.join(dir, 'cordis.patch.yml'), '[]'); }
	return dir;
}

async function fixture(run) {
	const root = fs.mkdtempSync(path.join(tmpdir(), 'dsh-light-seed-'));
	const runtimeDir = path.join(root, 'runtime');
	const modules = path.join(runtimeDir, 'node_modules');
	const fullProfile = path.join(runtimeDir, 'profile-seed', 'profiles', 'vssaros');
	const fullModules = path.join(fullProfile, 'node_modules');
	const outputDir = path.join(root, 'candidate');
	const version = '0.2.2-rc.5';
	try {
		install(modules, '@deepseek-ai/dsh', version, { dependencies: { '@deepseek-ai/dsh-base': version, '@deepseek-ai/dsh-web-app': version, '@deepseek-ai/cordis': '4.1.0', 'runtime-shared': '1.0.0' } });
		for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
			install(modules, name, version, { dsh: { bundle: { patch: './cordis.patch.yml' } } });
			install(fullModules, name, version, { dsh: { bundle: { patch: './cordis.patch.yml' } } });
		}
		install(modules, '@deepseek-ai/cordis', '4.1.0');
		install(fullModules, '@deepseek-ai/cordis', '4.1.0');
		install(modules, 'runtime-shared', '1.0.0');
		install(fullModules, 'mermaid', '11.0.0');
		const vendor = install(fullModules, 'dsh-better-sidebar', '0.32.1', {
			dependencies: { mermaid: '11.0.0', 'runtime-shared': '1.0.0' }, peerDependencies: { '@deepseek-ai/cordis': '^4.1.0' },
			dsh: { bundle: { patch: './cordis.patch.yml' } },
		});
		write(path.join(vendor, 'assets', 'schema.json'), { type: 'object' });
		const memory = install(fullModules, '@vssaros/dsh-memory', '1.0.22', { dsh: { bundle: { patch: './cordis.patch.yml' } } });
		const dependencies = { '@deepseek-ai/dsh-web-app': 'file:.vssaros/plugins/web.tgz', 'dsh-better-sidebar': 'file:.vssaros/plugins/sidebar.tgz', '@vssaros/dsh-memory': 'file:.vssaros/plugins/memory.tgz' };
		const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-better-sidebar', '@vssaros/dsh-memory'];
		write(path.join(fullProfile, 'package.json'), { name: 'dsh-profile-vssaros', private: true, dependencies, dsh: { profile: { bundles } }, pnpm: { onlyBuiltDependencies: ['sharp'], dangerouslyAllowAllBuilds: true }, privateToken: 'TEST-SECRET' });
		write(path.join(fullProfile, 'cordis.yml'), '[]');
		write(path.join(fullProfile, 'cordis.patch.yml'), '[]');
		write(path.join(fullProfile, 'compatibility.json'), { exemptions: [] });
		write(path.join(fullProfile, 'pnpm-workspace.yaml'), 'autoInstallPeers: false\nnodeLinker: hoisted\n');
		write(path.join(fullProfile, 'pnpm-lock.yaml'), 'OLD-LOCK');
		write(path.join(fullModules, '.modules.yaml'), 'OLD-STORE');
		write(path.join(fullProfile, '.credentials.yaml'), 'TEST-SECRET');
		write(path.join(fullProfile, '.vssaros', 'plugins', 'web.tgz'), 'UNUSED-OFFICIAL-ARCHIVE');
		await archiveSeedPlugin(vendor, path.join(fullProfile, '.vssaros', 'plugins', 'sidebar.tgz'));
		await archiveSeedPlugin(memory, path.join(fullProfile, '.vssaros', 'plugins', 'memory.tgz'));
		write(path.join(runtimeDir, 'profile-seed', 'seed.json'), { generatorRevision: 4, dsh: version, plugins: { '@deepseek-ai/dsh-web-app': version, 'dsh-better-sidebar': '0.32.1', '@vssaros/dsh-memory': '1.0.22' } });
		await run({ root, runtimeDir, modules, fullProfile, fullModules, outputDir, vendor, memory, bundles });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test('plan is read-only, removes matching runtime core and retains the dependency pocket', () => fixture(f => {
	const before = fs.readFileSync(path.join(f.fullProfile, 'package.json'), 'utf8');
	const plan = planLightProfileSeed(f);
	assert.equal(plan.stats.localPlugins, 2);
	assert.equal(plan.stats.omittedPackageCopies, 3);
	assert.ok(plan.providers['@deepseek-ai/cordis']);
	assert.ok(plan.providers['runtime-shared']);
	assert.deepEqual(Object.keys(plan.manifest.dependencies), ['dsh-better-sidebar', '@vssaros/dsh-memory']);
	assert.equal(fs.existsSync(f.outputDir), false);
	assert.equal(fs.readFileSync(path.join(f.fullProfile, 'package.json'), 'utf8'), before);
}));

test('candidate retains assets and private dependencies but has no core copies, old lock or credentials', () => fixture(async f => {
	const fullBefore = fs.readFileSync(path.join(f.fullProfile, 'package.json'), 'utf8');
	const result = await buildLightProfileSeed(f);
	const candidate = result.profileDir;
	assert.ok(fs.existsSync(path.join(candidate, 'node_modules', 'mermaid', 'lib', 'index.js')));
	assert.ok(fs.existsSync(path.join(candidate, 'node_modules', 'dsh-better-sidebar', 'assets', 'schema.json')));
	assert.equal(fs.existsSync(path.join(candidate, 'node_modules', '@deepseek-ai', 'cordis')), false);
	assert.equal(fs.existsSync(path.join(candidate, 'pnpm-lock.yaml')), false);
	assert.equal(fs.existsSync(path.join(candidate, 'node_modules', '.modules.yaml')), false);
	assert.equal(fs.existsSync(path.join(candidate, '.credentials.yaml')), false);
	assert.equal(fs.existsSync(path.join(candidate, '.vssaros', 'plugins', 'web.tgz')), false);
	assert.ok(fs.existsSync(path.join(candidate, '.vssaros', 'plugins', 'sidebar.tgz')));
	const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'));
	assert.deepEqual(manifest.dsh.profile.bundles, f.bundles);
	assert.equal(manifest.privateToken, undefined);
	assert.equal(manifest.pnpm.dangerouslyAllowAllBuilds, undefined);
	assert.equal(fs.readFileSync(path.join(f.fullProfile, 'package.json'), 'utf8'), fullBefore);
	const metadata = JSON.parse(fs.readFileSync(path.join(f.outputDir, 'seed.json'), 'utf8'));
	assert.equal(metadata.generatorRevision, LIGHT_SEED_REVISION);
	assert.deepEqual(metadata.qualification, { static: true, host: false, hmr: false, workers: false, packageManager: false });
	assert.ok(!JSON.stringify(metadata).includes(f.root));
}));

test('malformed installed manifest is reported with its path and never publishes a candidate', () => fixture(async f => {
	const file = path.join(f.memory, 'package.json');
	write(file, '{"files":["one" "two"]}');
	await assert.rejects(buildLightProfileSeed(f), error => error.message.includes(file) && error.message.includes('package metadata'));
	assert.equal(fs.existsSync(f.outputDir), false);
}));

test('wrong runtime/full package version fails before writing output', () => fixture(async f => {
	const manifest = path.join(f.fullModules, '@deepseek-ai', 'cordis', 'package.json');
	const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
	write(manifest, { ...pkg, version: '4.0.0' });
	await assert.rejects(buildLightProfileSeed(f), /version conflict/);
	assert.equal(fs.existsSync(f.outputDir), false);
}));

test('missing private dependency cannot be hidden by a global installation', () => fixture(async f => {
	fs.rmSync(path.join(f.fullModules, 'mermaid'), { recursive: true });
	await assert.rejects(buildLightProfileSeed(f), /Dependency pocket is incomplete/);
	assert.equal(fs.existsSync(f.outputDir), false);
}));

test('missing entry or archive rejects an incomplete source seed', () => fixture(f => {
	fs.rmSync(path.join(f.memory, 'lib', 'index.js'));
	assert.throws(() => planLightProfileSeed(f), /resource is missing/);
	write(path.join(f.memory, 'lib', 'index.js'), 'export const value=1;');
	fs.rmSync(path.join(f.fullProfile, '.vssaros', 'plugins', 'memory.tgz'));
	assert.throws(() => planLightProfileSeed(f), /archive is missing/);
}));

test('output overlapping runtime is rejected without creating its parent', () => fixture(async f => {
	const parent = path.join(f.runtimeDir, 'must-not-create');
	await assert.rejects(buildLightProfileSeed({ ...f, outputDir: path.join(parent, 'candidate') }), /must not overlap/);
	assert.equal(fs.existsSync(parent), false);
}));

test('an existing output is never replaced or cleaned', () => fixture(async f => {
	write(path.join(f.outputDir, 'user-file'), 'PRESERVE');
	await assert.rejects(buildLightProfileSeed(f), /EEXIST/);
	assert.equal(fs.readFileSync(path.join(f.outputDir, 'user-file'), 'utf8'), 'PRESERVE');
}));

test('failure after copying removes only the claimed output and never publishes a marker', () => fixture(async f => {
	write(path.join(f.fullProfile, 'pnpm-workspace.yaml'), 'dangerouslyAllowAllBuilds: true\n');
	await assert.rejects(buildLightProfileSeed(f), /Unsafe build-script policy/);
	assert.equal(fs.existsSync(f.outputDir), false);
	assert.ok(fs.existsSync(path.join(f.fullProfile, 'package.json')));
}));

test('unused virtual-store residue is omitted while live isolated package links are rejected', () => fixture(async f => {
	write(path.join(f.fullModules, '.pnpm', 'old-unused', 'data.txt'), 'OLD');
	const result = await buildLightProfileSeed(f);
	assert.equal(fs.existsSync(path.join(result.profileDir, 'node_modules', '.pnpm')), false);
	const original = path.join(f.fullModules, 'mermaid');
	const isolated = path.join(f.fullModules, '.pnpm', 'mermaid@11.0.0', 'node_modules', 'mermaid');
	fs.mkdirSync(path.dirname(isolated), { recursive: true });
	fs.renameSync(original, isolated);
	fs.symlinkSync(isolated, original, 'junction');
	assert.throws(() => planLightProfileSeed(f), /live isolated/);
}));

test('package links escaping the supplied runtime are rejected', () => fixture(f => {
	const outside = path.join(f.root, 'outside-package');
	fs.renameSync(f.vendor, outside);
	fs.symlinkSync(outside, f.vendor, 'junction');
	assert.throws(() => planLightProfileSeed(f), /escapes seed or runtime/);
}));

test('optional dependencies absent from both trees remain optional', () => fixture(async f => {
	const file = path.join(f.vendor, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
	write(file, { ...pkg, optionalDependencies: { 'absent-native-addon': '1.0.0' } });
	const result = await buildLightProfileSeed(f);
	assert.ok(result.profileDir);
}));

test('unverified required peers fail qualification instead of silently borrowing client modules', () => fixture(async f => {
	const file = path.join(f.vendor, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
	write(file, { ...pkg, peerDependencies: { ...pkg.peerDependencies, '@deepseek-ai/absent-client-provider': '*' } });
	await assert.rejects(buildLightProfileSeed(f), /Unverified peer provider/);
	assert.equal(fs.existsSync(f.outputDir), false);
}));

test('static validator detects a removed dependency and changed bundle order', () => fixture(async f => {
	const plan = planLightProfileSeed(f);
	const result = await buildLightProfileSeed(f);
	const file = path.join(result.profileDir, 'package.json');
	const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
	write(file, { ...manifest, dsh: { profile: { bundles: [...f.bundles].reverse() } } });
	assert.throws(() => validateLightProfileSeed(result.profileDir, plan), /bundle order/);
	write(file, manifest);
	fs.rmSync(path.join(result.profileDir, 'node_modules', 'mermaid'), { recursive: true });
	assert.throws(() => validateLightProfileSeed(result.profileDir, plan), /ENOENT|unreachable|unreadable package metadata/);
}));
