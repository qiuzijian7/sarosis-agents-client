import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { createFoundationService } from '../../vssaros-foundation/lib/index.js';
import { MARKET_JWT_REF } from '../lib/marketClient.js';

const dataRoot = await mkdtemp(join(tmpdir(), 'vssaros-marketplace-ui-'));
const publicFetch = globalThis.fetch;
const endpoint = 'http://21.91.158.20:3040';
const disposers = [];
const installedFixture = process.argv.includes('--installed-fixture');
const fixtureItems = [
	{ kind: 'skill', slug: 'rederive', name: 'rederive · 代码设计推导', version: '0.0.1', installedVersion: '0.0.1', latestVersion: '0.1.0', upgradable: true },
	{ kind: 'skill', slug: 'unreal-skill', name: 'Unreal Skill', version: '1.0.0', installedVersion: '1.0.0' },
	{ kind: 'mcp', slug: 'dsb-amap', name: 'Amap', version: '1.0.0', installedVersion: '1.0.0' },
	{ kind: 'mcp', slug: 'unreal-official-mcp', name: 'Unreal MCP', version: '1.0.0', installedVersion: '1.0.0' },
	{ kind: 'knowledge', slug: 'isolated-notes', name: '隔离测试 · 本机知识库', version: '1.0.0', isLocal: true, localId: 'isolated-notes' }
];
let handler;
const services = {
	credentials: { resolve: async ref => ref === MARKET_JWT_REF ? { value: 'isolated-ui-test' } : undefined },
	vssarosFoundation: createFoundationService(),
	webServer: { register: route => { handler = route.handler; return () => {}; } },
	connection: { requestRejection: req => req.socket.remoteAddress === '127.0.0.1' ? null : { status: 403, body: 'loopback only' } },
};
const ctx = { on: () => () => {}, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') { disposers.push(dispose); } return dispose; } };
ctx.inject = (keys, fn) => {
	if (!keys.every(key => key in services)) { return; }
	const dispose = fn({ ...ctx, ...Object.fromEntries(keys.map(key => [key, services[key]])) });
	if (typeof dispose === 'function') { disposers.push(dispose); }
};
globalThis.fetch = (url, init = {}) => {
	const target = String(url);
	if (!target.startsWith(endpoint + '/api/v1/packages') || (init.method && init.method !== 'GET')) {
		throw new Error('验证沙箱禁止远端写请求或非商品读取：' + target);
	}
	return publicFetch(target, { method: 'GET', credentials: 'omit', signal: AbortSignal.timeout(20000) });
};
await apply(ctx, { dataRoot, marketEndpoint: endpoint });
const server = createServer(async (req, res) => {
	if (req.method === 'GET' && req.url === '/__marketplace-test-close' && req.socket.remoteAddress === '127.0.0.1') { res.end('test server closed'); setImmediate(() => { void cleanup(); }); return; }
	if (req.method === 'POST' && req.url === '/x/marketplace/api/action') {
		const chunks = []; for await (const chunk of req) { chunks.push(chunk); }
		const body = Buffer.concat(chunks).toString();
		let parsed;
		try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('{}'); return; }
		if (!['list', 'detail', 'installed', 'mcpConfig', 'preferencesRead', 'preferencesUpdate'].includes(parsed.op)) {
			res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: false, error: '验证沙箱不执行安装、发布或管理写动作' })); return;
		}
		if (installedFixture && ['installed', 'mcpConfig'].includes(parsed.op)) {
			res.setHeader('content-type', 'application/json');
			const result = parsed.op === 'installed' ? { ok: true, total: fixtureItems.length, items: fixtureItems }
				: { ok: true, digest: 'isolated-fixture', path: '隔离测试 / mcp.json', text: '{"servers":{}}', servers: [{ id: 'dsb-amap', disabled: true, type: 'http' }, { id: 'unreal-official-mcp', disabled: false, type: 'stdio', approved: false }] };
			res.end(JSON.stringify(result)); return;
		}
		const { Readable } = await import('node:stream');
		const input = Readable.from([Buffer.from(body)]);
		Object.assign(input, { method: req.method, url: req.url, headers: req.headers, socket: req.socket });
		await handler(input, res); return;
	}
	await handler(req, res);
});
await new Promise(resolve => server.listen(8770, '127.0.0.1', resolve));
console.log('UI 验证页 http://127.0.0.1:8770/x/marketplace/');
console.log('仅公开商城 GET；收藏只写隔离目录；安装、发布和插件管理写操作被阻断。');
let closing = false;
async function cleanup() {
	if (closing) { return; } closing = true;
	for (const dispose of disposers.reverse()) { dispose(); }
	await new Promise(resolve => server.close(resolve));
	await rm(dataRoot, { recursive: true, force: true });
	globalThis.fetch = publicFetch;
}
process.once('SIGINT', () => { void cleanup(); });
process.once('SIGTERM', () => { void cleanup(); });
server.on('error', error => { console.error(error); void cleanup(); });
