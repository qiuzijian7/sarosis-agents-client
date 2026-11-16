import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('legacy protocol path forwards the same authoritative Host implementation', async () => {
	const [legacy, authoritative] = await Promise.all([
		import('../../vssaros-workbenches/lib/pluginPackage.js'),
		import('../lib/pluginPackage.js'),
	]);
	assert.deepEqual(Object.keys(legacy).sort(), Object.keys(authoritative).sort());
	for (const key of Object.keys(authoritative)) { assert.equal(legacy[key], authoritative[key], key); }
});

function archive(files, special = '0') {
	const chunks = [];
	for (const [path, text] of Object.entries(files)) {
		const data = Buffer.from(text);
		const header = Buffer.alloc(512);
		header.write(`package/${path}`);
		header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
		header[156] = special.charCodeAt(0);
		chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
	}
	chunks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(chunks));
}
const files = () => ({
	'package.json': JSON.stringify({ name: '@demo/bot', version: '1.0.0', type: 'module', main: 'lib/index.js', exports: { '.': './lib/index.js' }, dsh: { bundle: { patch: ['./cordis.patch.yml'] } } }),
	'vssaros.plugin.json': JSON.stringify({ schemaVersion: 1, profile: 'bot', primaryBot: 'helper', resources: { bots: [{ id: 'helper', path: 'bots/helper/.agent.md' }] } }),
	'lib/index.js': 'throw new Error("inspection must not execute this module");',
	'cordis.patch.yml': '- insert: []',
	'bots/helper/.agent.md': '---\nname: Helper\n---\nHelp',
});

test('resource package imports in physical isolation without workbench UI package', async t => {
	const root = await mkdtemp(join(tmpdir(), 'isolated-resource-host-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await cp(new URL('../lib/', import.meta.url), join(root, 'lib'), { recursive: true });
	await cp(new URL('../package.json', import.meta.url), join(root, 'package.json'));
	const module = await import(pathToFileURL(join(root, 'lib/index.js')).href);
	assert.equal(typeof module.apply, 'function');
	const inspected = await module.inspectArchive(archive(files()));
	assert.equal(inspected.plan.profile, 'bot');
	assert.equal(inspected.hasClient, false);
});

test('neutral archive inspection rejects malformed or conflicting Bot identity before registration', async () => {
	const { inspectArchive } = await import('../lib/index.js');
	for (const content of ['No frontmatter', '---\nname: Helper\nid: another\n---\nHelp', '---\nname: "Helper\n---\nHelp']) {
		const malformed = files();
		malformed['bots/helper/.agent.md'] = content;
		await assert.rejects(inspectArchive(archive(malformed)), /frontmatter/);
	}
});

test('neutral archive inspection accepts Host-only Bot without executing third-party modules', async () => {
	const { inspectArchive } = await import('../lib/index.js');
	const inspected = await inspectArchive(archive(files()));
	assert.deepEqual([inspected.name, inspected.version, inspected.plan.profile, inspected.hasClient], ['@demo/bot', '1.0.0', 'bot', false]);
});

test('archive inspection rejects duplicate manifest, special entries and unsafe paths', async () => {
	const { inspectArchive } = await import('../lib/index.js');
	await assert.rejects(inspectArchive(archive({ '../escape.js': '' })), /越界|路径/);
	await assert.rejects(inspectArchive(archive(files(), '2')), /链接|特殊/);
	const both = files();
	both['workbench.plugin.json'] = JSON.stringify({ schemaVersion: 1, workbench: { title: 'Legacy' } });
	await assert.rejects(inspectArchive(archive(both)), /同时/);
});

test('installed plan reader accepts Host-only Bot and rejects ambiguous legacy/unified manifests', async t => {
	const { readPluginPlan } = await import('../lib/index.js');
	const { mkdir, writeFile } = await import('node:fs/promises');
	const root = await mkdtemp(join(tmpdir(), 'resource-plan-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [path, text] of Object.entries(files())) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), text);
	}
	assert.equal((await readPluginPlan(root)).profile, 'bot');
	await writeFile(join(root, 'workbench.plugin.json'), '{"schemaVersion":1,"workbench":{"title":"Legacy"}}');
	await assert.rejects(readPluginPlan(root), /同时/);
});
