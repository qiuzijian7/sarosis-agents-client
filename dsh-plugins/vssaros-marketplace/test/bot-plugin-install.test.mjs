import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { packTarGzFromMap, listTarGzEntries } from '../lib/tar.js';
import { createPluginEnvelope, unpackPluginEnvelope } from '../lib/pluginArchive.js';
import { inspectPluginArchive } from '../../vssaros-workbenches/lib/localInstall.js';
import { apply } from '../lib/index.js';
import { MARKET_JWT_REF } from '../lib/marketClient.js';
import { readInstalled } from '../lib/installedLedger.js';
import { publishPluginVersion } from '../lib/publisher.js';

function packageOf(mask = 0, version = '1.0.0') {
	const resources = { bots: [{ id: 'helper', path: 'bots/helper/.agent.md' }] };
	const files = {
		'package/package.json': JSON.stringify({ name: '@demo/bot-plugin', type: 'module', version, main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
		'package/cordis.patch.yml': '- insert:\n  - id: demo-bot\n    name: "@demo/bot-plugin"\n',
		'package/lib/index.js': 'export function apply() {}',
		'package/bots/helper/.agent.md': '---\nid: helper\nname: Helper\n---\nHelp users.',
	};
	const optional = [
		['skills', 'skills/review/SKILL.md', '---\nname: review\ndescription: Review\n---\nReview content.'],
		['tools', 'lib/tools/review.js', 'export const definition={name:"review",parameters:{type:"object",properties:{}},output:{schema:{type:"string"},render:String},execute:async()=>"ok"};'],
		['mcp', 'mcp/review/config.json', '{"type":"http","url":"https://example.invalid/mcp"}'],
	];
	optional.forEach(([kind, path, text], index) => {
		if (mask & (1 << index)) { resources[kind] = [{ id: 'review', path }]; files['package/' + path] = text; }
	});
	files['package/vssaros.plugin.json'] = JSON.stringify({ schemaVersion: 1, profile: 'bot', primaryBot: 'helper', resources });
	return packTarGzFromMap(files);
}

for (let mask = 0; mask < 8; mask++) {
	test(`Bot plugin roundtrip optional resources ${mask}`, async () => {
		const tgz = packageOf(mask);
		const envelope = await createPluginEnvelope({ gzBuffer: tgz, localId: 'demo-bot', version: '1.0.0', kind: 'agent', inspect: inspectPluginArchive });
		assert.equal(envelope.manifest.kind, 'agent');
		const restored = await unpackPluginEnvelope({ gzBuffer: envelope.gzBuffer, slug: 'demo-bot', version: '1.0.0', kind: 'agent', inspect: inspectPluginArchive });
		assert.deepEqual(restored.pluginBuffer, tgz);
		assert.equal(restored.plan.profile, 'bot');
		assert.equal(restored.plan.primaryBot, 'helper');
		assert.equal(restored.plan.resources.skills.length, mask & 1 ? 1 : 0);
		assert.equal(restored.plan.resources.tools.length, mask & 2 ? 1 : 0);
		assert.equal(restored.plan.resources.mcp.length, mask & 4 ? 1 : 0);
		await assert.rejects(unpackPluginEnvelope({ gzBuffer: envelope.gzBuffer, slug: 'demo-bot', version: '1.0.0', kind: 'workbench', inspect: inspectPluginArchive }), /类型|profile|kind/);
	});
}

test('publishing refuses same version replacement and package identity changes', async () => {
	let uploads = 0;
	let current = { kind: 'agent', versions: [{ version: '1.0.0', manifest: { plugin: { name: '@demo/bot-plugin' } } }] };
	const market = { request: async () => { throw new Error('HTTP 409'); }, detail: async () => current, upload: async () => { uploads++; } };
	const options = { market, localId: 'demo-bot', kind: 'agent', inspect: inspectPluginArchive };
	await assert.rejects(publishPluginVersion({ ...options, version: '1.0.0', gzBuffer: packageOf() }), /同版本/);
	current.versions[0].manifest.plugin.name = '@other/bot';
	await assert.rejects(publishPluginVersion({ ...options, version: '1.1.0', gzBuffer: packageOf(0, '1.1.0') }), /包名/);
	assert.equal(uploads, 0);
});

test('marketplace real action uploads, installs, upgrades and removes Bot plugin without legacy resource path', async t => {
	const root = await mkdtemp(join(tmpdir(), 'vssaros-bot-plugin-consumer-'));
	const versions = new Map();
	const installed = new Map();
	const tools = new Map();
	let handler;
	let installCount = 0;
	let downloadCount = 0;
	const dispose = [];
	const hash = bytes => createHash('sha256').update(bytes).digest('hex');
	const market = createServer(async (req, res) => {
		try {
			const chunks = []; for await (const chunk of req) { chunks.push(chunk); }
			const bytes = Buffer.concat(chunks);
			res.setHeader('content-type', 'application/json');
			if (req.url.endsWith('/versions/raw')) {
				const parsed = await listTarGzEntries(bytes);
				const manifest = JSON.parse(parsed.files.find(f => f.path === 'manifest.json').data);
				assert.equal(manifest.kind, 'agent');
				versions.set(manifest.version, { blob: bytes, manifest, version: manifest.version, sha256: hash(bytes) });
				res.end(JSON.stringify({ version: manifest.version })); return;
			}
			if (req.url.endsWith('/download')) {
				downloadCount++; const version = decodeURIComponent(req.url.split('/').at(-2));
				res.end(versions.get(version).blob); return;
			}
			if (req.url.endsWith('/upgrade/check')) { res.end(JSON.stringify({ updates: [{ kind: 'agent', storeId: 'demo-bot', latest: [...versions.keys()].at(-1) }] })); return; }
			if (req.method === 'POST') { assert.equal(JSON.parse(bytes).kind, 'agent'); res.end('{"id":"demo-bot"}'); return; }
			res.end(JSON.stringify({ slug: 'demo-bot', kind: 'agent', latest_version: [...versions.keys()].at(-1),
				versions: [...versions.values()].map(({ blob, ...row }) => row) }));
		} catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
	});
	await new Promise(resolve => market.listen(0, '127.0.0.1', resolve));
	let host;
	t.after(async () => {
		for (const fn of dispose.reverse()) { await fn(); }
		if (host) { await new Promise(resolve => host.close(resolve)); }
		await new Promise(resolve => market.close(resolve));
		await rm(root, { recursive: true, force: true });
	});
	const services = {
		credentials: { resolve: async key => key === MARKET_JWT_REF ? { value: 'isolated-jwt' } : undefined },
		pluginManager: {
			listBundles: async () => [...installed.values()],
			installBundle: async spec => {
				assert.ok(spec.startsWith('file:'));
				const info = await inspectPluginArchive(await readFile(spec.slice(5)));
				assert.equal(info.plan.profile, 'bot');
				installed.set(info.name, { name: info.name, version: info.version, installed: true, enabled: true }); installCount++;
				return { application: 'restart-required', changed: true };
			},
			removeBundle: async name => { assert.equal(name, '@demo/bot-plugin'); installed.delete(name); return { application: 'applied', changed: true }; },
		},
		vssarosPluginResources: { inspectArchive: inspectPluginArchive, refresh: async () => {}, status: () => null },
		tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
		webServer: { register: route => { handler = route.handler; return () => {}; } },
		connection: { requestRejection: () => null },
	};
	const ctx = { on: () => () => {}, effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') { dispose.push(cleanup); } return cleanup; } };
	ctx.inject = (keys, fn) => { if (keys.every(key => key in services)) { const cleanup = fn({ ...ctx, ...Object.fromEntries(keys.map(key => [key, services[key]])) }); if (typeof cleanup === 'function') { dispose.push(cleanup); } } };
	await apply(ctx, { dataRoot: root, marketEndpoint: `http://127.0.0.1:${market.address().port}` });
	assert.equal(typeof handler, 'function');
	host = createServer(handler); await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
	const action = async (op, params) => (await fetch(`http://127.0.0.1:${host.address().port}/x/marketplace/api/action`, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, params }),
	})).json();
	for (const version of ['1.0.0', '1.1.0']) {
		const response = await action('publish', { kind: 'agent', localId: 'demo-bot', version, pluginBase64: packageOf(7, version).toString('base64') });
		assert.equal(response.ok, true, response.error);
	}
	const preview = await action('previewInstall', { slug: 'demo-bot', version: '1.0.0' });
	assert.equal(preview.ok, true, preview.error);
	assert.ok(preview.files.some(file => file.path === 'bots/helper/.agent.md'));
	assert.equal(installCount, 0);
	const first = await action('install', { kind: 'agent', slug: 'demo-bot', version: '1.0.0' });
	assert.equal(first.ok, true, first.error);
	assert.equal(first.packageName, '@demo/bot-plugin');
	assert.equal(installCount, 1);
	const map = await action('installed', {});
	assert.equal(map.ok, true, map.error);
	assert.equal(map.items.find(row => row.storeId === 'demo-bot' || row.slug === 'demo-bot').upgradable, true);
	const updated = await action('upgrade', { kind: 'agent', slug: 'demo-bot', version: '1.1.0' });
	assert.equal(updated.ok, true, updated.error);
	assert.equal(updated.version, '1.1.0');
	assert.equal(installCount, 2);
	assert.ok(downloadCount >= 3);
	assert.equal((await readInstalled(root)).find(row => row.storeId === 'demo-bot').packageName, '@demo/bot-plugin');
	const wrongKind = await action('install', { kind: 'workbench', slug: 'demo-bot', version: '1.1.0' });
	assert.equal(wrongKind.ok, false);
	assert.equal(installCount, 2);
	const realRemove = services.pluginManager.removeBundle;
	services.pluginManager.removeBundle = async () => ({ ok: false, application: 'failed' });
	const rejected = await action('uninstall', { kind: 'agent', slug: 'demo-bot' });
	assert.equal(rejected.ok, false);
	assert.equal((await readInstalled(root)).some(row => row.storeId === 'demo-bot'), true);
	services.pluginManager.removeBundle = realRemove;
	const removed = await action('uninstall', { kind: 'agent', slug: 'demo-bot' });
	assert.equal(removed.ok, true, removed.error);
	assert.equal(installed.size, 0);
	assert.equal((await readInstalled(root)).some(row => row.storeId === 'demo-bot'), false);
	const tool = tools.get('market_install');
	assert.ok(tool, 'market_install must be registered');
	const viaTool = await tool.execute({ slug: 'demo-bot', version: '1.1.0' });
	assert.equal(viaTool.ok, true, JSON.stringify(viaTool));
	assert.equal(installCount, 3);
	assert.equal((await action('uninstall', { kind: 'agent', slug: 'demo-bot' })).ok, true);
});
