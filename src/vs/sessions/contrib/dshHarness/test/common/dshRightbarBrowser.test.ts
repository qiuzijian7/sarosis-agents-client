/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	cdpCookieOf, RIGHTBAR_BROWSER_METHODS, RIGHTBAR_CDP_FILE, RIGHTBAR_CDP_PATH, RIGHTBAR_ENSURE_PAGE_METHOD, RIGHTBAR_PAGE_METHODS, RIGHTBAR_SHARED_VIEW_ID, RIGHTBAR_VIEW_ID_PREFIX,
	rightbarCdpRefusal, rightbarNavigationRefusal, rightbarTokenMatches,
} from '../../common/dshRightbarCdp.js';

/**
 * VsSaros addition (2026-11-07, P0 · one browser): the right sidebar browser is the page the `browser` tool operates.
 *
 * 1. The main process's relay policy (`common/dshRightbarCdp.ts`): no new pages, no closing the person's view, no
 *    `Browser.close` / browser contexts, http(s)-only navigation away from cloud metadata, token compare.
 * 2. The Host plugin (`vssaros-browser/lib/core/rightbar.js` + `host.js`) against a fake relay on a real loopback
 *    WebSocket: it uses the right sidebar's page first, creates and closes no page, shares it across sessions, reports
 *    `mode: 'rightbar'`, never relaunches Chrome for a login, and goes back to Chrome when the right sidebar has no page.
 */

const abs = (rel: string): string => path.join(process.cwd(), rel);
const load = async <T>(rel: string): Promise<T> => await import(pathToFileURL(abs(rel)).href) as T;
const RIGHTBAR = 'dsh-plugins/vssaros-browser/lib/core/rightbar.js';
const HOST = 'dsh-plugins/vssaros-browser/lib/core/host.js';
const SILENT = { info: () => { /* quiet */ }, warn: () => { /* quiet */ } };

interface IHost {
	readonly usingRightbar: boolean;
	ensurePage(ownerKey?: string, url?: string): Promise<{ targetId: string; sessionId: string; rightbar?: boolean }>;
	status(): Promise<{ ok: boolean; mode?: string; endpoint?: string }>;
	closeSessionPages(ownerKey: string): Promise<{ closed: string[] }>;
	command(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
	ensureHeaded(): Promise<void>;
	dispose(): void;
}
type HostCtor = new (options: Record<string, unknown>) => IHost;

/** A fake relay: the right sidebar's views as page targets, answering as the platform proxy does, recording requests. */
async function fakeRelay(pages: { targetId: string; url: string }[], options: { createOnEnsure?: boolean } = {}) {
	const ws = await import(pathToFileURL(abs('node_modules/ws/wrapper.mjs')).href) as { WebSocketServer: new (o: Record<string, unknown>) => { on(e: string, f: (s: { on(e: string, f: (d: unknown) => void): void; send(t: string): void }) => void): void; once(e: string, f: () => void): void; address(): { port: number }; close(): void } };
	const token = 'ab12'.repeat(8);
	const server = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise<void>(resolve => server.once('listening', resolve));
	const requests: { method: string; sessionId?: string }[] = [];
	server.on('connection', socket => {
		socket.on('message', data => {
			const req = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
			requests.push({ method: req.method, ...(req.sessionId ? { sessionId: req.sessionId } : {}) });
			const refusal = rightbarCdpRefusal(req.method, req.params, req.sessionId);
			const reply = (body: Record<string, unknown>) => socket.send(JSON.stringify({ id: req.id, ...body }));
			if (refusal) { reply({ error: refusal }); return; }
			if (req.method === 'Target.getTargets') { reply({ result: { targetInfos: pages.map(p => ({ ...p, type: 'page', title: '', attached: true, canAccessOpener: false })) } }); return; }
			if (req.method === 'Target.attachToTarget') { reply({ result: { sessionId: `S-${String(req.params?.targetId)}` } }); return; }
			// As on the real machine (2026-11-07): a view that never loaded a page (empty URL) has no renderer, so a renderer
			// command (Runtime.*) is never answered until something navigates it.
			// The relay's own command (2026-11-07): the shared view, created hidden only when there is no page at all.
			if (req.method === RIGHTBAR_ENSURE_PAGE_METHOD) {
				if (pages.length === 0 && !options.createOnEnsure) { reply({ error: { code: -32000, message: 'no VsSaros window to own the right sidebar browser' } }); return; }
				const created = pages.length === 0;
				if (created) { pages.push({ targetId: 'T-shared', url: '' }); }
				reply({ result: { created, targetId: pages[0].targetId } });
				return;
			}
			const page = pages.find(p => req.sessionId === `S-${p.targetId}`);
			if (page && req.method === 'Page.navigate') { page.url = String(req.params?.url ?? ''); reply({ result: { frameId: page.targetId } }); return; }
			if (page && !page.url && req.method.startsWith('Runtime.')) { return; }
			reply({ result: {} });
		});
	});
	const port = server.address().port;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rightbar-cdp-'));
	const file = path.join(dir, 'dsh-run', RIGHTBAR_CDP_FILE);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ version: 1, wsUrl: `ws://127.0.0.1:${port}${RIGHTBAR_CDP_PATH}${token}`, pid: process.pid, startedAt: new Date().toISOString() }));
	return { file, dataRoot: dir, requests, close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
/** A port nothing listens on: the Chrome path then fails at once (no dedicated launch in these tests). */
const deadPort = 1;

suite('右栏浏览器 = browser 工具操作的那一页（P0 · 单一实例）', () => {

	test('中转白名单：不建页、不关人的视图、不关浏览器、不碰浏览器上下文；工具要的命令都在', () => {
		for (const refused of ['Target.createTarget', 'Target.closeTarget', 'Browser.close', 'Target.createBrowserContext', 'Target.disposeBrowserContext',
			'Target.setAutoAttach', 'Target.exposeDevToolsProtocol', 'Browser.setDownloadBehavior']) {
			assert.ok(!RIGHTBAR_BROWSER_METHODS.has(refused) && !RIGHTBAR_PAGE_METHODS.has(refused), refused);
			assert.strictEqual(rightbarCdpRefusal(refused, {}, undefined)?.code, -32601, refused);
			assert.strictEqual(rightbarCdpRefusal(refused, {}, 'S1')?.code, -32601, `${refused} on a page session`);
		}
		for (const page of ['DOM.removeNode', 'DOM.setOuterHTML', 'Debugger.enable', 'Network.getAllCookies', 'Runtime.callFunctionOn', 'Fetch.enable']) {
			assert.strictEqual(rightbarCdpRefusal(page, {}, 'S1')?.code, -32601, page);
		}
		// Page methods need a page session.
		assert.strictEqual(rightbarCdpRefusal('Runtime.evaluate', {}, undefined)?.code, -32601);
		// What `vssaros-browser` sends today (lib/core: cdp.js / client.js / loginSession.js / index.js).
		for (const [method, session] of [['Target.getTargets', undefined], ['Target.attachToTarget', undefined], ['Target.activateTarget', undefined],
			['Storage.getCookies', undefined], ['Runtime.evaluate', 'S1'], ['Page.enable', 'S1'], ['Page.getNavigationHistory', 'S1'],
			['Page.navigateToHistoryEntry', 'S1'], ['Page.captureScreenshot', 'S1'], ['Input.dispatchMouseEvent', 'S1'], ['Input.insertText', 'S1'],
			['Accessibility.getFullAXTree', 'S1'], ['DOM.getDocument', 'S1'], ['DOM.pushNodesByBackendIdsToFrontend', 'S1'], ['DOM.setAttributeValue', 'S1'],
			['Input.dispatchKeyEvent', 'S1'], ['Network.setCookies', 'S1']] as const) {
			assert.strictEqual(rightbarCdpRefusal(method, {}, session), undefined, method);
		}
	});

	test('导航：只许 http(s) / about:blank，拒云元数据地址', () => {
		assert.strictEqual(rightbarNavigationRefusal('https://example.com/a'), undefined);
		assert.strictEqual(rightbarNavigationRefusal('http://localhost:5173/'), undefined);
		assert.strictEqual(rightbarNavigationRefusal('about:blank'), undefined);
		for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,x', 'http://169.254.169.254/latest/meta-data/',
			'http://metadata.google.internal/computeMetadata/v1/', 'not a url', '']) {
			assert.ok(rightbarNavigationRefusal(bad), bad);
		}
		assert.strictEqual(rightbarCdpRefusal('Page.navigate', { url: 'file:///etc/passwd' }, 'S1')?.code, -32602);
		assert.strictEqual(rightbarCdpRefusal('Page.navigate', { url: 'https://example.com' }, 'S1'), undefined);
	});

	test('token：路径前缀 + 等长逐位比较；错一位、缺、多都拒', () => {
		const token = 'f'.repeat(48);
		assert.ok(rightbarTokenMatches(`${RIGHTBAR_CDP_PATH}${token}`, token));
		assert.ok(!rightbarTokenMatches(`${RIGHTBAR_CDP_PATH}${token.slice(1)}e`, token));
		assert.ok(!rightbarTokenMatches(`${RIGHTBAR_CDP_PATH}${token}0`, token));
		assert.ok(!rightbarTokenMatches(`/devtools/browser/${token}`, token));
		assert.ok(!rightbarTokenMatches(undefined, token));
		assert.ok(!rightbarTokenMatches(`${RIGHTBAR_CDP_PATH}`, ''));
	});

	test('cookie 形状：Electron → CDP（Storage.getCookies 由中转从右栏的 session 答）', () => {
		assert.deepStrictEqual(cdpCookieOf({ name: 'sid', value: 'v', domain: '.example.com', path: '/', secure: true, httpOnly: true, session: false, expirationDate: 1800000000, sameSite: 'lax' }),
			{ name: 'sid', value: 'v', domain: '.example.com', path: '/', expires: 1800000000, size: 4, httpOnly: true, secure: true, session: false, sameSite: 'Lax' });
		assert.strictEqual(cdpCookieOf({ name: 'a', value: 'b', session: true }).expires, -1);
	});

	test('主进程与插件同名：发现文件名、视图前缀与 dshHarness.contribution.ts 的命名一致', async () => {
		const rightbar = await load<{ RIGHTBAR_CDP_FILE: string; rightbarCdpFile(root: string): string }>(RIGHTBAR);
		assert.strictEqual(rightbar.RIGHTBAR_CDP_FILE, RIGHTBAR_CDP_FILE);
		assert.strictEqual(rightbar.rightbarCdpFile('/root'), path.join('/root', 'dsh-run', RIGHTBAR_CDP_FILE));
		const contribution = fs.readFileSync(abs('src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts'), 'utf8');
		assert.ok(contribution.includes('getOrCreateLazy(RIGHTBAR_SHARED_VIEW_ID)'), 'the right sidebar tab shows the one shared view');
		assert.ok(RIGHTBAR_SHARED_VIEW_ID.startsWith(RIGHTBAR_VIEW_ID_PREFIX), 'the relay exposes the shared view');
		const plugin = await load<{ RIGHTBAR_ENSURE_PAGE_METHOD: string }>(RIGHTBAR);
		assert.strictEqual(plugin.RIGHTBAR_ENSURE_PAGE_METHOD, RIGHTBAR_ENSURE_PAGE_METHOD);
		assert.strictEqual(rightbarCdpRefusal(RIGHTBAR_ENSURE_PAGE_METHOD, {}, undefined), undefined, 'browser-level, allowed');
	});

	test('发现文件：坏的 / 非本机 / 进程已不在 ⇒ 不用右栏', async () => {
		const { readRightbarEndpoint } = await load<{ readRightbarEndpoint(file: string, alive?: (pid: number) => boolean): { wsUrl: string } | undefined }>(RIGHTBAR);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rightbar-file-'));
		try {
			const file = path.join(dir, RIGHTBAR_CDP_FILE);
			const good = { version: 1, wsUrl: `ws://127.0.0.1:4567${RIGHTBAR_CDP_PATH}${'a1'.repeat(24)}`, pid: 4242 };
			assert.strictEqual(readRightbarEndpoint(file), undefined, 'no file');
			fs.writeFileSync(file, '{oops');
			assert.strictEqual(readRightbarEndpoint(file), undefined, 'bad JSON');
			fs.writeFileSync(file, JSON.stringify(good));
			assert.strictEqual(readRightbarEndpoint(file, () => true)?.wsUrl, good.wsUrl);
			assert.strictEqual(readRightbarEndpoint(file, () => false), undefined, 'its process is gone');
			fs.writeFileSync(file, JSON.stringify({ ...good, wsUrl: `ws://10.0.0.5:4567${RIGHTBAR_CDP_PATH}${'a1'.repeat(24)}` }));
			assert.strictEqual(readRightbarEndpoint(file, () => true), undefined, 'not loopback');
			fs.writeFileSync(file, JSON.stringify({ ...good, version: 2 }));
			assert.strictEqual(readRightbarEndpoint(file, () => true), undefined, 'unknown version');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('★★ 右栏开着：所有会话都用右栏那一页，不建页、不关页、不拉 Chrome，status 报 rightbar', async () => {
		const relay = await fakeRelay([{ targetId: 'T-hidden', url: 'https://hidden.example/' }]);
		const { CdpHost } = await load<{ CdpHost: HostCtor }>(HOST);
		const host = new CdpHost({ port: deadPort, launchDedicated: false, homeDir: os.tmpdir(), logger: SILENT, rightbarFile: relay.file });
		try {
			const a = await host.ensurePage('sess-A', 'https://a.example/');
			const b = await host.ensurePage('sess-B', 'https://b.example/');
			assert.strictEqual(a.targetId, 'T-hidden');
			assert.strictEqual(b.targetId, a.targetId, 'every session shares the right sidebar page (no per-Bot isolation, by decision)');
			assert.strictEqual(a.rightbar, true);
			assert.ok(host.usingRightbar);
			await host.command('Runtime.evaluate', { expression: '1' }, a.sessionId);
			assert.deepStrictEqual(await host.closeSessionPages('sess-A'), { closed: [], skipped: '' }, 'a session ending closes nothing of the person\'s view');
			await host.ensureHeaded();
			assert.ok(host.usingRightbar, 'a login needs no Chrome window: the right sidebar is visible');
			const status = await host.status();
			assert.strictEqual(status.mode, 'rightbar');
			assert.strictEqual(status.ok, true);
			const methods = relay.requests.map(r => r.method);
			assert.ok(!methods.includes('Target.createTarget') && !methods.includes('Target.closeTarget') && !methods.includes('Browser.close'), methods.join(', '));
		} finally {
			host.dispose();
			relay.close();
		}
	});

	test('★ 右栏页签开着但还没打开过网页（地址为空、没有渲染进程）⇒ 先导航 about:blank，页面命令才有回应', async () => {
		const relay = await fakeRelay([{ targetId: 'T-blank', url: '' }]);
		const { CdpHost } = await load<{ CdpHost: HostCtor }>(HOST);
		const host = new CdpHost({ port: deadPort, launchDedicated: false, homeDir: os.tmpdir(), logger: SILENT, rightbarFile: relay.file });
		try {
			const page = await host.ensurePage('sess-A');
			const answered = await Promise.race([host.command('Runtime.evaluate', { expression: '1' }, page.sessionId).then(() => true),
				new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1500))]);
			assert.strictEqual(answered, true, 'a blank view gets about:blank first, else Runtime.evaluate waits out its timeout (real machine: 8 s each)');
			assert.deepStrictEqual(relay.requests.filter(r => r.method === 'Page.navigate').length, 1);
		} finally {
			host.dispose();
			relay.close();
		}
	});

	test('★★ 右栏一页都没有 ⇒ 第一次页面操作请中转建隐藏的共享视图并用它；status 只看不建', async () => {
		const relay = await fakeRelay([], { createOnEnsure: true });
		const { CdpHost } = await load<{ CdpHost: HostCtor }>(HOST);
		const host = new CdpHost({ port: deadPort, launchDedicated: false, homeDir: os.tmpdir(), logger: SILENT, rightbarFile: relay.file });
		try {
			const before = await host.status() as { mode: string; viewReady?: boolean; note?: string };
			assert.strictEqual(before.mode, 'rightbar');
			assert.strictEqual(before.viewReady, false);
			assert.match(String(before.note), /第一次 navigate \/ snapshot 等页面操作时会自动在右栏建一个/);
			assert.ok(!relay.requests.some(r => r.method === RIGHTBAR_ENSURE_PAGE_METHOD), 'status never creates a view');
			const page = await host.ensurePage('sess-A');
			assert.strictEqual(page.targetId, 'T-shared');
			assert.ok(host.usingRightbar, 'no Chrome while VsSaros can give a right sidebar view');
			assert.strictEqual(relay.requests.filter(r => r.method === RIGHTBAR_ENSURE_PAGE_METHOD).length, 1);
			const methods = relay.requests.map(r => r.method);
			assert.ok(!methods.includes('Target.createTarget'), 'the view comes from the relay\'s own command, never Target.createTarget');
			await host.ensurePage('sess-B');
			assert.strictEqual(relay.requests.filter(r => r.method === RIGHTBAR_ENSURE_PAGE_METHOD).length, 1, 'one shared view: the second session reuses it');
		} finally {
			host.dispose();
			relay.close();
		}
	});

	test('★ 右栏没有页面、中转也建不了（没有窗口）⇒ 回到 Chrome 路径（这里没有 Chrome ⇒ 报端点不可达，而不是卡住）', async () => {
		const relay = await fakeRelay([]);
		const { CdpHost } = await load<{ CdpHost: HostCtor }>(HOST);
		const host = new CdpHost({ port: deadPort, launchDedicated: false, homeDir: os.tmpdir(), logger: SILENT, rightbarFile: relay.file });
		try {
			await assert.rejects(() => host.ensurePage('sess-A'), /CDP 端点全部不可达/);
			assert.ok(!host.usingRightbar);
			assert.ok(relay.requests.some(r => r.method === RIGHTBAR_ENSURE_PAGE_METHOD), 'it asked the relay first');
		} finally {
			host.dispose();
			relay.close();
		}
	});

	test('★ 不给发现文件 ⇒ 完全是旧行为（`VSSAROS_BROWSER_RIGHTBAR=0`）', async () => {
		const relay = await fakeRelay([{ targetId: 'T-1', url: 'about:blank' }]);
		const { CdpHost } = await load<{ CdpHost: HostCtor }>(HOST);
		const host = new CdpHost({ port: deadPort, launchDedicated: false, homeDir: os.tmpdir(), logger: SILENT });
		try {
			await assert.rejects(() => host.ensurePage('sess-A'), /CDP 端点全部不可达/);
			assert.strictEqual(relay.requests.length, 0, 'the relay is never contacted');
		} finally {
			host.dispose();
			relay.close();
		}
	});
});
