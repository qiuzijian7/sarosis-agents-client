import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { readPluginPlan } from '../../vssaros-workbenches/lib/pluginResources.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packTarGzFromMap } from '../lib/tar.js';
import { inspectWorkbenchArchive } from '../../vssaros-workbenches/lib/localInstall.js';
import { createPluginEnvelope, unpackPluginEnvelope, installPluginEnvelope } from '../lib/pluginArchive.js';
import { resourceId } from '../../vssaros-workbenches/lib/pluginPackage.js';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { apply as applyMarketplace } from '../lib/index.js';
import { MARKET_JWT_REF } from '../lib/marketClient.js';

const root = await mkdtemp(join(tmpdir(), 'vssaros-plugin-package-'));
let passed = 0;
const failures = [];
async function check(name, fn) {
	try { await fn(); passed++; console.log(`ok ${name}`); }
	catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
function fixture(mask = 0) {
	const resources = {};
	const files = {
		'package/package.json': JSON.stringify({ name: '@demo/desk', version: '1.2.0', main: 'lib/index.js', exports: { './client': './lib/client.js' }, dsh: { bundle: { patch: './cordis.patch.yml' }, client: { inject: ['@vssaros/dsh-workbenches'], platform: 'web' } } }),
		'package/cordis.patch.yml': 'plugins:\n  - name: "@demo/desk"\n',
		'package/lib/index.js': 'export function apply() {}',
		'package/lib/client.js': 'export function apply(ctx) { ctx.desktopWorkbenches.register({package:"@demo/desk",title:"Demo"}, () => null); }',
	};
	const entries = [
		['bots', 'bots/helper/.agent.md', '---\nid: helper\nname: Helper\n---\nHelp users.'],
		['skills', 'skills/helper/SKILL.md', '---\nname: helper\ndescription: Help users\n---\nInstructions.'],
		['tools', 'lib/tools/helper.js', 'export const definition = {name:"helper",description:"Help",parameters:{type:"object",properties:{}},output:{schema:{type:"string"},render:String},execute:async()=>"ok"};'],
		['mcp', 'mcp/helper/config.json', JSON.stringify({ type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${env:DEMO_TOKEN}' } })],
	];
	entries.forEach(([kind, path, body], bit) => {
		if (mask & (1 << bit)) { resources[kind] = [{ id: 'helper', path }]; files['package/' + path] = body; }
	});
	files['package/workbench.plugin.json'] = JSON.stringify({ schemaVersion: 1, workbench: { title: 'Demo', ...(mask & 1 ? { defaultBot: 'helper' } : {}) }, resources });
	return files;
}
try {
	for (let mask = 0; mask < 16; mask++) {
		await check(`optional resource matrix ${mask}`, async () => {
			const tgz = packTarGzFromMap(fixture(mask));
			const prepared = await createPluginEnvelope({ gzBuffer: tgz, localId: 'demo-desk', version: '1.2.0', inspect: inspectWorkbenchArchive });
			const restored = await unpackPluginEnvelope({ gzBuffer: prepared.gzBuffer, slug: 'demo-desk', version: '1.2.0', inspect: inspectWorkbenchArchive });
			assert.deepEqual(restored.pluginBuffer, tgz);
			assert.equal(restored.packageName, '@demo/desk');
			assert.equal(restored.plan.resources.bots.length, mask & 1 ? 1 : 0);
			assert.equal(restored.plan.resources.mcp.length, mask & 8 ? 1 : 0);
		});
	}
	await check('missing declared resource rejected before upload', async () => {
		const files = fixture(1); delete files['package/bots/helper/.agent.md'];
		await assert.rejects(createPluginEnvelope({ gzBuffer: packTarGzFromMap(files), localId: 'demo-desk', version: '1.2.0', inspect: inspectWorkbenchArchive }), /bots|不存在|缺少/);
	});
	await check('exports host entry cannot hide a missing actual module', async () => {
		const files = fixture(); const pkg = JSON.parse(files['package/package.json']);
		pkg.exports['.'] = './lib/missing.js'; files['package/package.json'] = JSON.stringify(pkg);
		await assert.rejects(inspectWorkbenchArchive(packTarGzFromMap(files)), /Host|入口/);
		pkg.exports['.'] = './lib/index.js'; delete pkg.main; files['package/package.json'] = JSON.stringify(pkg);
		assert.ok((await inspectWorkbenchArchive(packTarGzFromMap(files))).plan);
	});
	await check('installed package reads the same exports-only and MCP cwd plan', async () => {
		const files = fixture(8); const pkg = JSON.parse(files['package/package.json']);
		delete pkg.main; pkg.exports['.'] = './lib/index.js'; files['package/package.json'] = JSON.stringify(pkg);
		files['package/mcp/helper/config.json'] = JSON.stringify({ type: 'stdio', command: 'node', args: ['server.js'], cwd: 'lib/server' });
		files['package/lib/server/server.js'] = 'export {};';
		const info = await inspectWorkbenchArchive(packTarGzFromMap(files));
		const target = await mkdtemp(join(root, 'installed-'));
		for (const entry of info.entries) { const file = join(target, entry.name); await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, entry.data); }
		assert.deepEqual((await readPluginPlan(target)).resources, info.plan.resources);
	});
	await check('literal credentials cannot be hidden by appending placeholders', async () => {
		for (const cfg of [
			{ type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer secret-value${env:EMPTY}' } },
			{ type: 'http', url: 'https://example.invalid/mcp?token=secret-value' },
			{ type: 'http', url: 'https://user:secret@example.invalid/mcp' },
			{ type: 'stdio', command: 'node', cwd: 'C:/author/dir' },
			{ type: 'stdio', command: 'node', cwd: 'missing-dir' },
		]) {
			const files = fixture(8); files['package/mcp/helper/config.json'] = JSON.stringify(cfg);
			await assert.rejects(inspectWorkbenchArchive(packTarGzFromMap(files)), /凭据|路径|cwd/);
		}
	});
	await check('author version cannot disagree with marketplace version', async () => {
		await assert.rejects(createPluginEnvelope({ gzBuffer: packTarGzFromMap(fixture()), localId: 'demo-desk', version: '9.0.0', inspect: inspectWorkbenchArchive }), /版本/);
	});
	await check('marketplace package cannot replace reserved builtin packages', async () => {
		const files = fixture(); const pkg = JSON.parse(files['package/package.json']);
		pkg.name = '@vssaros/dsh-workbenches'; files['package/package.json'] = JSON.stringify(pkg);
		await assert.rejects(createPluginEnvelope({ gzBuffer: packTarGzFromMap(files), localId: 'demo-desk', version: '1.2.0', inspect: inspectWorkbenchArchive }), /内置/);
	});
	await check('duplicate resource ids rejected', async () => {
		const files = fixture(1);
		const manifest = JSON.parse(files['package/workbench.plugin.json']);
		manifest.resources.bots.push(manifest.resources.bots[0]);
		files['package/workbench.plugin.json'] = JSON.stringify(manifest);
		await assert.rejects(inspectWorkbenchArchive(packTarGzFromMap(files)), /重复/);
	});
	await check('resource namespaces are stable and MCP safe', () => {
		assert.equal(resourceId('@demo/desk', 'helper'), resourceId('@demo/desk', 'helper'));
		assert.notEqual(resourceId('@demo/desk', 'helper'), resourceId('@other/desk', 'helper'));
		assert.ok(resourceId('@demo/desk', 'a-very-long-component-resource-id').length <= 32);
	});
	await check('consumer installs downloaded package through manager, retains archive', async () => {
		const prepared = await createPluginEnvelope({ gzBuffer: packTarGzFromMap(fixture(15)), localId: 'demo-desk', version: '1.2.0', inspect: inspectWorkbenchArchive });
		let called = 0;
		const pm = { installBundle: async (spec) => {
			called++;
			assert.ok(spec.startsWith('file:'));
			const bytes = await readFile(spec.slice(5));
			assert.equal((await inspectWorkbenchArchive(bytes)).name, '@demo/desk');
			return { application: 'restart-required', changed: true };
		} };
		const r = await installPluginEnvelope({ dataRoot: root, gzBuffer: prepared.gzBuffer, slug: 'demo-desk', version: '1.2.0', expectedSha256: prepared.sha256, inspect: inspectWorkbenchArchive, pluginManager: pm });
		assert.equal(called, 1);
		assert.equal(r.packageName, '@demo/desk');
		assert.equal(r.application, 'restart-required');
		assert.deepEqual(await readFile(r.archivePath), packTarGzFromMap(fixture(15)));
		await assert.rejects(installPluginEnvelope({ dataRoot: root, gzBuffer: prepared.gzBuffer, slug: 'demo-desk', version: '1.2.0', expectedSha256: '0'.repeat(64), inspect: inspectWorkbenchArchive, pluginManager: pm }), /sha256/);
		assert.equal(called, 1);
	});
	await check('real marketplace action: author uploads and consumer downloads/installs', async () => {
		let blob;
		let handler;
		let installCount = 0;
		const market = createServer(async (req, res) => {
			const chunks = []; for await (const chunk of req) { chunks.push(chunk); }
			const bytes = Buffer.concat(chunks);
			if (req.url.endsWith('/versions/raw')) { blob = bytes; res.end('{"version":"1.2.0"}'); return; }
			if (req.url.endsWith('/download')) { res.end(blob); return; }
			res.setHeader('content-type', 'application/json');
			if (req.method === 'POST') { res.end('{"id":"demo-desk"}'); return; }
			res.end(JSON.stringify({ slug: 'demo-desk', kind: 'workbench', latest_version: '1.2.0',
				distribution: { type: 'npm', name: 'wrong-legacy-source' },
				versions: [{ version: '1.2.0', sha256: createHash('sha256').update(blob).digest('hex'),
					manifest: JSON.parse((await import('../lib/tar.js')).listTarEntries((await import('node:zlib')).gunzipSync(blob)).files.find(f => f.path === 'manifest.json').data) }] }));
		});
		await new Promise(resolve => market.listen(0, '127.0.0.1', resolve));
		const consumerRoot = await mkdtemp(join(tmpdir(), 'vssaros-plugin-consumer-'));
		const dispose = [];
		const services = {
			credentials: { resolve: async key => key === MARKET_JWT_REF ? { value: 'isolated-test-jwt' } : undefined },
			pluginManager: { installBundle: async spec => { installCount++; assert.equal((await inspectWorkbenchArchive(await readFile(spec.slice(5)))).name, '@demo/desk'); return { application: 'restart-required' }; } },
			vssarosPluginResources: { inspectArchive: inspectWorkbenchArchive, refresh: async () => {}, status: () => null },
			webServer: { register: route => { handler = route.handler; return () => {}; } },
			connection: { requestRejection: () => null },
		};
		const ctx = { on: () => () => {}, effect: fn => { const d = fn(); if (typeof d === 'function') { dispose.push(d); } return d; } };
		ctx.inject = (keys, fn) => { if (keys.every(key => key in services)) { const d = fn({ ...ctx, ...Object.fromEntries(keys.map(key => [key, services[key]])) }); if (typeof d === 'function') { dispose.push(d); } } };
		let host;
		try {
			await applyMarketplace(ctx, { dataRoot: consumerRoot, marketEndpoint: `http://127.0.0.1:${market.address().port}` });
			assert.equal(typeof handler, 'function');
			host = createServer(handler); await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
			const action = async (op, params) => (await fetch(`http://127.0.0.1:${host.address().port}/x/marketplace/api/action`, {
				method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, params }),
			})).json();
			const upload = await action('publish', { kind: 'workbench', localId: 'demo-desk', version: '1.2.0', pluginBase64: packTarGzFromMap(fixture()).toString('base64') });
			assert.equal(upload.ok, true, upload.error);
			const preview = await action('previewInstall', { slug: 'demo-desk', version: '1.2.0' });
			assert.equal(preview.ok, true, preview.error);
			assert.ok(preview.files.some(file => file.path === 'lib/client.js'));
			assert.equal(installCount, 0);
			const installed = await action('install', { kind: 'workbench', slug: 'demo-desk', version: '1.2.0' });
			assert.equal(installed.ok, true, installed.error);
			assert.equal(installed.packageName, '@demo/desk');
			assert.equal(installCount, 1);
			assert.equal(installed.workbench, 'unverified');
		} finally {
			for (const d of dispose.reverse()) { d(); }
			if (host) { await new Promise(resolve => host.close(resolve)); }
			await new Promise(resolve => market.close(resolve));
			await rm(consumerRoot, { recursive: true, force: true });
		}
	});
} finally { await rm(root, { recursive: true, force: true }); }
console.log(`[workbench-plugin-package] ${passed} passing / ${failures.length} failing`);
process.exitCode = failures.length ? 1 : 0;
