// vssaros-browser：生命周期与凭据落盘（2026-11-07，P3）——无头专属 Chrome 的空闲回收、cookie / storage 存档只许本人读写。
// 运行：node dsh-plugins/vssaros-browser/test/lifecycle.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpHost, IDLE_CLOSE_DEFAULT_MS, idleReclaimable } from '../lib/core/host.js';
import { writeCookieStore } from '../lib/core/cookieStore.js';
import { writeStorageStore } from '../lib/core/storageStore.js';

let pass = 0;
const fail = [];
const check = async (name, fn) => { try { await fn(); pass += 1; } catch (error) { fail.push(`${name} → ${error.stack?.split('\n').slice(0, 3).join(' | ') ?? error}`); } };
const HEADLESS_UA = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 HeadlessChrome/156.0.0.0 Safari/537.36';
const base = { kind: 'chrome', endpoint: 'http://127.0.0.1:9224', dedicatedEndpoint: 'http://127.0.0.1:9224', headless: undefined,
	userAgent: HEADLESS_UA, inflight: 0, lastUsedAt: 0, now: IDLE_CLOSE_DEFAULT_MS, idleMs: IDLE_CLOSE_DEFAULT_MS };

await check('空闲回收判据：只关我们的专属端点上、无头、没有调用在路上、空闲够久的', () => {
	assert.equal(idleReclaimable(base), true);
	assert.equal(idleReclaimable({ ...base, now: IDLE_CLOSE_DEFAULT_MS - 1 }), false, '还没空闲够');
	assert.equal(idleReclaimable({ ...base, inflight: 1 }), false, '有调用在路上');
	assert.equal(idleReclaimable({ ...base, kind: 'rightbar' }), false, '右栏是人的视图');
	assert.equal(idleReclaimable({ ...base, endpoint: 'http://127.0.0.1:9223' }), false, '你自己的 Chrome');
	assert.equal(idleReclaimable({ ...base, userAgent: 'Mozilla/5.0 Chrome/156.0.0.0' }), false, '有头窗口（人可能正在登录）');
	assert.equal(idleReclaimable({ ...base, headless: false }), false, '我们切成了有头');
	assert.equal(idleReclaimable({ ...base, headless: true, userAgent: undefined }), true, '我们以无头拉起的');
	assert.equal(idleReclaimable({ ...base, idleMs: 0 }), false, '0 = 不回收');
});

await check('reclaimIfIdle：满足条件才发 Browser.close 并断开；正在用的不关', async () => {
	const host = new CdpHost({ port: 9223, launchDedicated: true, homeDir: tmpdir(), logger: { info() {}, warn() {} } });
	const sent = [];
	const fakeConn = { send: async method => { sent.push(method); return {}; }, dispose() {}, onClosed() {} };
	Object.assign(host, { _conn: fakeConn, _targets: { clearSessions() {} }, _kind: 'chrome', _endpoint: host.dedicatedEndpointUrl, _userAgent: HEADLESS_UA, _lastUsedAt: 0 });
	host._inflight = 1;
	assert.equal(await host.reclaimIfIdle(1000, 10_000), false, '有调用在路上');
	assert.deepEqual(sent, []);
	host._inflight = 0;
	assert.equal(await host.reclaimIfIdle(1000, 500), false, '没空闲够');
	assert.equal(await host.reclaimIfIdle(1000, 10_000), true);
	assert.deepEqual(sent, ['Browser.close']);
	assert.equal(host._conn, undefined, '断开了，下次调用重连 / 重新拉起');
	assert.equal(await host.reclaimIfIdle(1000, 20_000), false, '没连接就没什么可关');
});

await check('cookie / storage 存档：只许本人读写（POSIX 0600；Windows 跳过 mode 断言，只看写成功）', () => {
	const dir = mkdtempSync(join(tmpdir(), 'creds-'));
	try {
		const cookie = writeCookieStore(join(dir, 'sub', 'cookies.json'), { version: 1, cookies: [] });
		const storage = writeStorageStore(join(dir, 'sub', 'storage.json'), { version: 1 });
		assert.equal(cookie.ok, true); assert.equal(storage.ok, true);
		if (process.platform !== 'win32') {
			assert.equal(statSync(cookie.path).mode & 0o777, 0o600);
			assert.equal(statSync(storage.path).mode & 0o777, 0o600);
			assert.equal(statSync(join(dir, 'sub')).mode & 0o777, 0o700);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

await check('开发版只认自己的专属实例：不把 9223（正式版专属 Chrome）当"你的 Chrome"', async () => {
	const { cdpEndpointCandidates } = await import('../lib/core/chrome.js');
	assert.deepEqual(cdpEndpointCandidates(9223, { dedicatedOnly: true }).map(c => c.url), ['http://127.0.0.1:9224']);
	assert.deepEqual(cdpEndpointCandidates(9222).map(c => c.url), ['http://127.0.0.1:9222', 'http://[::1]:9222', 'http://127.0.0.1:9223'], '正式版不变');
	const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	assert.match(src, /const dedicatedOnly = isDevEnv && !explicitPort;/);
	assert.match(src, /new CdpHost\(\{[^}]*dedicatedOnly/);
	const host = readFileSync(new URL('../lib/core/host.js', import.meta.url), 'utf8');
	assert.equal(host.split('cdpEndpointCandidates(this._config.port, { dedicatedOnly: this._config.dedicatedOnly })').length - 1, 2, 'probe 与连接两处都要带上');
});

await check('status 的 note：右栏 / 专属实例 / 用户的 Chrome 各说各的，专属实例明确"没有登录态"', async () => {
	const { statusNote } = await import('../lib/core/host.js');
	// 右栏：空页（页签开着但没打开网页）直说"还没打开任何网页"，并告诉怎么打开；有页就带标题与地址
	for (const page of [undefined, { url: '', title: '' }, { url: 'about:blank', title: '' }]) {
		const blank = statusNote({ rightbar: true, page });
		assert.match(blank, /还没打开任何网页/, JSON.stringify(page));
		assert.match(blank, /op "navigate"/);
	}
	const baidu = statusNote({ rightbar: true, page: { url: 'https://www.baidu.com/', title: '百度一下，你就知道' } });
	assert.match(baidu, /正显示的页面「百度一下，你就知道」（https:\/\/www\.baidu\.com\/）：与人看见的是同一页、同一份登录态/);
	assert.doesNotMatch(baidu, /还没打开/);
	const own = statusNote({ selfLaunched: true, headless: true, profileDir: 'C:/x/browser-profile' });
	assert.match(own, /专属 Chrome（无界面，后台运行，独立配置目录 C:\/x\/browser-profile）/);
	assert.match(own, /没有用户在那里的登录态/);
	assert.match(own, /打开 VsSaros 右栏的「浏览器」页签（不用先打开网页）/);
	assert.match(statusNote({ selfLaunched: true, headless: false }), /有窗口/);
	assert.match(statusNote({ endpoint: 'http://127.0.0.1:9222' }), /用户自己开了远程调试的 Chrome（http:\/\/127\.0\.0\.1:9222）：带用户在那里的登录态/);
});

await check('status()：右栏模式带 page（当前地址与标题），不带 dedicatedPort；Chrome 模式反之', async () => {
	const { WebSocketServer } = await import('../../../node_modules/ws/wrapper.mjs');
	const { mkdirSync, writeFileSync } = await import('node:fs');
	const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise(resolve => server.once('listening', resolve));
	let page = { targetId: 'T1', url: '', title: '' };
	server.on('connection', socket => socket.on('message', data => {
		const req = JSON.parse(String(data));
		const result = req.method === 'Target.getTargets' ? { targetInfos: [{ ...page, type: 'page', attached: false }] } : {};
		socket.send(JSON.stringify({ id: req.id, result }));
	}));
	const dir = mkdtempSync(join(tmpdir(), 'rb-status-'));
	try {
		const file = join(dir, 'dsh-run', 'rightbar-cdp.json');
		mkdirSync(join(dir, 'dsh-run'), { recursive: true });
		writeFileSync(file, JSON.stringify({ version: 1, wsUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/vssaros-rightbar/${'ab12'.repeat(8)}`, pid: process.pid }));
		const host = new CdpHost({ port: 1, launchDedicated: false, homeDir: tmpdir(), rightbarFile: file, logger: { info() {}, warn() {} } });
		let status = await host.status();
		assert.equal(status.mode, 'rightbar');
		assert.deepEqual(status.page, { url: '', title: '' });
		assert.equal('dedicatedPort' in status, false, '右栏模式不给 dedicatedPort（模型会把它当端点）');
		assert.match(status.note, /还没打开任何网页/);
		page = { targetId: 'T1', url: 'https://www.baidu.com/', title: '百度一下，你就知道' };
		status = await host.status();
		assert.deepEqual(status.page, { url: 'https://www.baidu.com/', title: '百度一下，你就知道' });
		assert.match(status.note, /「百度一下，你就知道」/);
		host.dispose();
	} finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

await check('status()：连上专属实例（UA 是 HeadlessChrome）⇒ note 说"无界面的专属实例、没有登录态"', async () => {
	const http = await import('node:http');
	const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({
		Browser: 'Chrome/156.0.8078.49', 'User-Agent': HEADLESS_UA, webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/x' })); });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const dedicated = server.address().port;
	try {
		const host = new CdpHost({ port: dedicated - 1, launchDedicated: false, dedicatedOnly: true, homeDir: tmpdir(), profileDir: 'C:/p/browser-profile', logger: { info() {}, warn() {} } });
		const status = await host.status();
		assert.equal(status.mode, 'chrome'); assert.equal(status.selfLaunched, true);
		assert.equal(status.dedicatedPort, dedicated); assert.equal('page' in status, false);
		assert.match(status.note, /专属 Chrome（无界面，后台运行，独立配置目录 C:\/p\/browser-profile）/);
		assert.match(status.note, /没有用户在那里的登录态/);
	} finally { server.close(); }
});

if (fail.length) {
	console.log(`lifecycle: ${pass} passed, ${fail.length} failed\n  ${fail.join('\n  ')}`);
	process.exit(1);
}
console.log(`lifecycle: ${pass} passed`);
process.exit(0);
