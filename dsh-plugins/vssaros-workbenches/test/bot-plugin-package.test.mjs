import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as protocol from '../lib/pluginPackage.js';
import * as localInstall from '../lib/localInstall.js';
import { packTarGzFromMap } from '../../vssaros-marketplace/lib/tar.js';

function fixture(mask = 0, profile = 'bot', legacy = false) {
	const manifest = { name: '@demo/helper-plugin', version: '1.2.0', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } };
	const plan = { schemaVersion: 1, ...(!legacy ? { profile } : {}), ...(profile === 'bot' ? { primaryBot: 'helper' } : { workbench: { title: 'Helper', defaultBot: 'helper' } }), resources: { bots: [{ id: 'helper', path: 'bots/helper/.agent.md' }] } };
	const files = {
		'package.json': JSON.stringify(manifest),
		'cordis.patch.yml': 'plugins:\n  - name: "@demo/helper-plugin"\n',
		'lib/index.js': 'export function apply() {}',
		'bots/helper/.agent.md': '---\nid: helper\nname: Helper\nskills: []\ntools: []\n---\nHelp users.',
	};
	const optional = [
		['skills', 'skills/helper/SKILL.md', '---\nname: helper\ndescription: Help users\n---\nInstructions.'],
		['tools', 'lib/tools/helper.js', 'export const definition = { execute: async () => "ok" };'],
		['mcp', 'mcp/helper/config.json', JSON.stringify({ type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${env:DEMO_TOKEN}' } })],
	];
	for (const [bit, [kind, path, body]] of optional.entries()) {
		if (mask & (1 << bit)) { plan.resources[kind] = [{ id: 'helper', path }]; files[path] = body; }
	}
	if (profile === 'workbench') {
		manifest.exports = { './client': './lib/client.js' };
		manifest.dsh.client = { inject: ['@vssaros/dsh-workbenches'] };
		files['lib/client.js'] = 'export function apply(ctx) { ctx.desktopWorkbenches.register({package:"@demo/helper-plugin",title:"Helper"}, () => null); }';
	}
	const resourceFile = legacy ? 'workbench.plugin.json' : 'vssaros.plugin.json';
	return { manifest, plan, files, resourceFile };
}

function entriesOf(f) {
	return Object.entries({ ...f.files, 'package.json': JSON.stringify(f.manifest), [f.resourceFile]: JSON.stringify(f.plan) })
		.map(([name, value]) => ({ name, data: Buffer.from(value) }));
}

function archiveOf(f) {
	return packTarGzFromMap(Object.fromEntries(entriesOf(f).map(entry => ['package/' + entry.name, entry.data])));
}

function validate(f) { return protocol.validatePluginResources(f.manifest, entriesOf(f)); }

for (let mask = 0; mask < 8; mask++) {
	test(`host-only Bot accepts optional skills/tools/mcp combination ${mask}`, async () => {
		const f = fixture(mask);
		const info = await localInstall.inspectPluginArchive(archiveOf(f));
		assert.equal(info.hasClient, false);
		assert.equal(info.plan.profile, 'bot');
		assert.equal(info.plan.primaryBot, 'helper');
		assert.equal(info.plan.workbench, undefined);
		assert.equal(info.plan.resources.bots.length, 1);
		assert.equal(info.plan.packageName, f.manifest.name);
		assert.equal(info.plan.version, '1.2.0');
		for (const [bit, kind] of ['skills', 'tools', 'mcp'].entries()) {
			assert.equal(info.plan.resources[kind].length, mask & (1 << bit) ? 1 : 0);
		}
		assert.equal(info.plan.resources.bots[0].runtimeId, protocol.resourceId(f.manifest.name, 'helper'));
	});
}

test('resource manifest reader is pure and maps legacy profile/defaultBot', () => {
	assert.equal(protocol.UNIFIED_PLUGIN_RESOURCE_FILE, 'vssaros.plugin.json');
	assert.equal(protocol.PLUGIN_RESOURCE_FILE, 'workbench.plugin.json');
	const f = fixture(0, 'workbench', true);
	const entries = entriesOf(f);
	const before = entries.map(entry => ({ name: entry.name, data: Buffer.from(entry.data) }));
	const result = protocol.getPluginResourceManifest(entries);
	assert.equal(result.profile, 'workbench');
	assert.equal(result.primaryBot, 'helper');
	assert.deepEqual(entries, before);
	assert.equal(protocol.getPluginResourceManifest([]), null);
});

test('profile maps to marketplace kind without accepting unknown profiles', () => {
	assert.equal(protocol.pluginProfileKind('bot'), 'agent');
	assert.equal(protocol.pluginProfileKind('workbench'), 'workbench');
	assert.throws(() => protocol.pluginProfileKind('other'), /profile/);
});

test('both resource manifests are rejected instead of choosing one', () => {
	const f = fixture();
	const entries = [...entriesOf(f), { name: 'workbench.plugin.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, workbench: { title: 'Legacy' } })) }];
	assert.throws(() => protocol.validatePluginResources(f.manifest, entries), /同时|双|冲突/);
	assert.throws(() => protocol.getPluginResourceManifest(entries), /同时|双|冲突/);
});

test('unified manifest requires a supported explicit profile and schema', () => {
	for (const value of [undefined, '', 'agent', 'other']) {
		const f = fixture(); f.plan.profile = value;
		assert.throws(() => validate(f), /profile/);
	}
	const f = fixture(); f.plan.schemaVersion = 2;
	assert.throws(() => validate(f), /schemaVersion/);
});

test('legacy manifest cannot masquerade as a host-only Bot', () => {
	const f = fixture(); f.resourceFile = 'workbench.plugin.json';
	assert.throws(() => validate(f), /workbench|工作台|profile/);
});

test('Bot profile requires at least one declared Bot and matching primaryBot', () => {
	const f = fixture(); f.plan.resources.bots = [];
	assert.throws(() => validate(f), /bots|Bot/);
	for (const value of [undefined, '', 'missing']) {
		const g = fixture(); g.plan.primaryBot = value;
		assert.throws(() => validate(g), /primaryBot/);
	}
});

test('primaryBot and workbench.defaultBot cannot conflict', () => {
	for (const profile of ['bot', 'workbench']) {
		const f = fixture(0, profile);
		f.plan.resources.bots.push({ id: 'other', path: 'bots/other/.agent.md' });
		f.files['bots/other/.agent.md'] = '---\nid: other\nname: Other\n---\nOther bot.';
		f.plan.primaryBot = 'helper'; f.plan.workbench = { title: 'Helper', defaultBot: 'other' };
		assert.throws(() => validate(f), /冲突|一致/);
	}
});

test('all declared resource files must exist', () => {
	for (const path of ['bots/helper/.agent.md', 'skills/helper/SKILL.md', 'lib/tools/helper.js', 'mcp/helper/config.json']) {
		const f = fixture(7); delete f.files[path];
		assert.throws(() => validate(f), /不存在/);
	}
});

test('legacy and unified workbenches retain pages and default Bot', async () => {
	for (const legacy of [false, true]) {
		const info = await localInstall.inspectWorkbenchArchive(archiveOf(fixture(7, 'workbench', legacy)));
		assert.equal(info.plan.profile, 'workbench');
		assert.equal(info.plan.primaryBot, 'helper');
		assert.equal(info.plan.workbench.defaultBot, 'helper');
		assert.equal(info.hasClient, true);
	}
});

test('workbench profile still requires a page and workbenches injection', () => {
	const noClient = fixture(0, 'workbench'); delete noClient.manifest.exports;
	assert.throws(() => validate(noClient), /页面|client/);
	const noInject = fixture(0, 'workbench'); delete noInject.manifest.dsh.client;
	assert.throws(() => validate(noInject), /注入/);
	const noTitle = fixture(0, 'workbench'); delete noTitle.plan.workbench.title;
	assert.throws(() => validate(noTitle), /title/);
});

test('page-only legacy workbench does not acquire a fabricated primaryBot', async () => {
	const f = fixture(0, 'workbench', true); delete f.plan.resources; delete f.plan.workbench.defaultBot;
	const info = await localInstall.inspectWorkbenchArchive(archiveOf(f));
	assert.equal(info.plan.profile, 'workbench');
	assert.equal(info.plan.primaryBot, undefined);
	assert.deepEqual(info.plan.resources, { bots: [], skills: [], tools: [], mcp: [] });
});

test('legacy dry-run and extraction reject Bot even when it carries an optional page', async () => {
	const f = fixture(0, 'workbench'); f.plan.profile = 'bot'; f.plan.primaryBot = 'helper';
	const buffer = archiveOf(f);
	assert.equal((await localInstall.inspectPluginArchive(buffer)).plan.profile, 'bot');
	await assert.rejects(localInstall.inspectWorkbenchArchive(buffer), /Bot|bot/);
	const root = await mkdtemp(join(tmpdir(), 'vssaros-bot-package-'));
	try {
		await assert.rejects(localInstall.extractWorkbenchPackage(buffer, join(root, 'package')), /Bot|bot/);
		await assert.rejects(readFile(join(root, 'package', 'package.json')), { code: 'ENOENT' });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('Host entry is required and all declared entry/patch files form a closed package', () => {
	for (const mutate of [
		f => { delete f.manifest.main; },
		f => { f.manifest.exports = { '.': { import: './lib/index.js' } }; },
		f => { f.manifest.exports = { '.': './lib/missing.js' }; },
		f => { f.manifest.exports = { '.': './lib/index.js' }; f.manifest.main = './lib/missing.js'; },
		f => { delete f.manifest.dsh.bundle.patch; },
		f => { f.manifest.dsh.bundle.patch = ['./cordis.patch.yml', './missing.patch.yml']; },
		f => { f.manifest.exports = { './client': './lib/missing.js' }; },
	]) {
		const f = fixture(); mutate(f);
		assert.throws(() => validate(f), /Host|入口|patch|client/);
	}
	const f = fixture(); f.manifest.exports = { '.': './lib/index.js' }; delete f.manifest.main;
	assert.equal(validate(f).profile, 'bot');
});

test('version and reserved credential/runtime files remain safety boundaries', () => {
	for (const version of ['', '1.2', '01.2.0', '1.2.0-01']) {
		const f = fixture(); f.manifest.version = version;
		assert.throws(() => validate(f), /版本|SemVer/);
	}
	for (const path of ['.env', '.env.local', 'mcp-secrets.json', '.credentials.json', 'installed-packages.json', 'session.data']) {
		const f = fixture(); f.files[path] = 'secret';
		assert.throws(() => validate(f), /凭据|运行数据/);
	}
});

test('unsafe dependency and installation lifecycle scripts remain forbidden', () => {
	for (const dependencies of [{ helper: 'file:../local' }, { helper: 'link:../local' }, { helper: 'workspace:*' }]) {
		const f = fixture(); f.manifest.dependencies = dependencies;
		assert.throws(() => validate(f), /本地目录/);
	}
	const f = fixture(); f.manifest.scripts = { postinstall: 'node install.js' };
	assert.throws(() => validate(f), /安装脚本/);
});

test('MCP credential placeholders cannot hide literal secrets', () => {
	for (const config of [
		{ type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer literal${env:EMPTY}' } },
		{ type: 'http', url: 'https://example.invalid/mcp?token=literal' },
		{ type: 'http', url: 'https://user:literal@example.invalid/mcp' },
		{ type: 'stdio', command: 'node', cwd: 'C:/author/dir' },
		{ type: 'stdio', command: 'node', approved: true },
	]) {
		const f = fixture(4); f.files['mcp/helper/config.json'] = JSON.stringify(config);
		assert.throws(() => validate(f), /凭据|路径|批准/);
	}
});

test('Bot preflight rejects missing or malformed frontmatter and unusable identity', () => {
	for (const text of [
		'Help users.',
		'---\nid: helper\nname: Helper\nHelp users.',
		'---\nid: helper\n---\nHelp users.',
		'---\nid: other\nname: Helper\n---\nHelp users.',
		'---\nid: [helper]\nname: Helper\n---\nHelp users.',
		'---\nid: "helper\nname: Helper\n---\nHelp users.',
		'---\nid: helper\nname: "Helper\n---\nHelp users.',
		'---\nid: helper\nname: []\n---\nHelp users.',
		'---\nid: helper\nid: helper\nname: Helper\n---\nHelp users.',
	]) {
		const f = fixture(); f.files['bots/helper/.agent.md'] = text;
		assert.throws(() => validate(f), /Bot|frontmatter|name|id/);
	}
});

test('Bot identity preflight accepts runtime-compatible quoted identity, CRLF and directory fallback', () => {
	for (const text of [
		'---\nid: "helper"\nname: \'Helper\'\nskills:\n  - helper\ntools:\n  # allowlisted tool\n  - helper\n---\nHelp users.',
		'---\r\nid: helper\r\nname: Helper\r\n---\r\nHelp users.',
		'---\nname: Helper\n---\nHelp users.',
	]) {
		const f = fixture(); f.files['bots/helper/.agent.md'] = text;
		assert.equal(validate(f).resources.bots[0].id, 'helper');
	}
});

test('preflight never imports or executes declared tool modules', async () => {
	const f = fixture(2);
	f.files['lib/tools/helper.js'] = 'throw new Error("tool module executed during preflight");';
	assert.equal((await localInstall.inspectPluginArchive(archiveOf(f))).plan.resources.tools.length, 1);
});

test('duplicate resource IDs and duplicate archive entries are rejected', () => {
	const f = fixture(); f.plan.resources.bots.push(f.plan.resources.bots[0]);
	assert.throws(() => validate(f), /重复/);
	const g = fixture(); const entries = entriesOf(g);
	assert.throws(() => protocol.validatePluginResources(g.manifest, [...entries, entries[0]]), /重复/);
});

test('legacy workbench protocol forwards the authoritative Host exports without copying implementations', async () => {
	const authority = await import('../../vssaros-plugin-resources/lib/pluginPackage.js');
	assert.deepEqual(Object.keys(protocol).sort(), Object.keys(authority).sort());
	for (const name of Object.keys(authority)) { assert.equal(protocol[name], authority[name], name); }
});

test('resourceId retains the established stable namespace', () => {
	assert.equal(protocol.resourceId('@demo/desk', 'helper'), 'wb-02e1ef0447-helper');
	assert.notEqual(protocol.resourceId('@demo/desk', 'helper'), protocol.resourceId('@other/desk', 'helper'));
	assert.ok(protocol.resourceId('@demo/desk', 'a-very-long-component-resource-id').length <= 32);
});
