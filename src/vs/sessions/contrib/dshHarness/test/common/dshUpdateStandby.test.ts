/*---------------------------------------------------------------------------------------------
 * Copyright (c) Saros. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { IDesktopUpdateSnapshot } from '../../common/dshDesktopUpdate.js';
import { DSH_UPDATE_STANDBY_ACTION, isUpdateStandbyAction, updateStandbyHtml, updateStandbyUrl } from '../../common/dshUpdateStandby.js';

const VIEW = 'src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts';
const source = readFileSync(VIEW, 'utf8');
const snapshot = (phase: IDesktopUpdateSnapshot['presentation']['phase'], restartReady = false): IDesktopUpdateSnapshot => ({ seq: 1, presentation: { phase, version: '2.2.26295' }, restartReady, app: { current: '2.2.26294', action: 'upgrade' } });

function methods(file: string, names: readonly string[]): string {
	const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
	const found = new Map<string, string>();
	const visit = (node: ts.Node): void => {
		if (ts.isMethodDeclaration(node)) {
			const name = node.name.getText(ast);
			if (names.includes(name)) { found.set(name, node.getText(ast)); }
		}
		ts.forEachChild(node, visit);
	};
	visit(ast);
	for (const name of names) { assert.ok(found.has(name), `Missing actual method: ${name}`); }
	return names.map(name => found.get(name)).join('\n');
}

function mainFrameHandler(): string {
	const ast = ts.createSourceFile(VIEW, source, ts.ScriptTarget.Latest, true);
	let handler: string | undefined;
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && node.expression.getText(ast) === 'wc.on' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'will-frame-navigate') {
			handler = node.arguments[1].getText(ast);
		}
		ts.forEachChild(node, visit);
	};
	visit(ast);
	assert.ok(handler, 'Actual navigation handler missing');
	return handler;
}

function fixture() {
	let url = 'http://127.0.0.1:12333/';
	let probes = 0;
	let loads = 0;
	let reloads = 0;
	const sends: Array<[string, unknown]> = [];
	const upgrades: string[] = [];
	const names = ['beginAppUpdate', 'appUpdatePreparationFailed', 'pushDesktopUpdate', 'setConnection', '_showHostUnavailable', '_checkPageAlive', '_pageOrigin', '_pushAppUpdateToSlot'];
	const code = ts.transpileModule(`class Host { ${methods(VIEW, names)} } globalThis.Host = Host;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
	interface Slot { id: string; visible: boolean; view: { webContents: object }; blankChecks?: number; updateStandbyUrl?: string }
	interface Host {
		_views: Map<string, Slot>; _connection: object | undefined; _lastHostOrigin?: string; _appUpdateSuspended: boolean; _desktopUpdate?: IDesktopUpdateSnapshot;
		beginAppUpdate(): void; appUpdatePreparationFailed(): void; pushDesktopUpdate(value: IDesktopUpdateSnapshot): void;
		setConnection(value: object | undefined): void; _checkPageAlive(slot: Slot): Promise<void>;
	}
	const context = {
		Host: undefined as unknown as { new(): Host },
		updateStandbyUrl, isUpdateStandbyAction, sameAuthConnection: (a: object, b: object) => a === b,
		DSH_DESKTOP_UPDATE_IPC: 'vssaros:dsh:desktop-update',
		resetViewLoadRetry: () => ({}), setInterval: () => 1, clearInterval() {}, AUTH_REFRESH_INTERVAL_MS: 100,
	};
	vm.runInNewContext(code, context);
	const host = new context.Host();
	const wc = { isDestroyed: () => false, getURL: () => url, mainFrame: { origin: 'http://127.0.0.1:12333' },
		send: (channel: string, value: unknown) => { sends.push([channel, value]); },
		loadURL: async (value: string) => { loads++; url = value; }, executeJavaScript: async () => { probes++; return false; } };
	const slot: Slot = { id: 'desktop', visible: true, view: { webContents: wc } };
	Object.assign(host, { _views: new Map([[slot.id, slot]]), _connection: { origin: 'http://127.0.0.1:12333' },
		_lastHostOrigin: 'http://127.0.0.1:12333', _appUpdateSuspended: false,
		_authWarmup: { setConnection() {} }, prefetchAuth() {}, _load() { reloads++; },
		_logService: { info() {}, warn() {} }, pushUpgrade(viewId: string) { upgrades.push(viewId); } });
	return { host, slot, url: () => url, counts: () => ({ probes, loads, reloads }), sends, upgrades };
}

suite('更新在后台安装，不遮挡页面 UI', () => {
	test('Host停止、更新Ready但未点击任何按钮都保留原页面，状态只推给页内通知卡片', async () => {
		const f = fixture();
		f.host.pushDesktopUpdate(snapshot('installing'));
		f.host.beginAppUpdate();
		f.host.setConnection(undefined);
		assert.strictEqual(f.url(), 'http://127.0.0.1:12333/');
		assert.strictEqual(f.counts().loads, 0, '后台安装不许加载全屏本地状态页');
		f.host.pushDesktopUpdate(snapshot('ready', true));
		for (let i = 0; i < 10; i++) { await f.host._checkPageAlive(f.slot); }
		assert.deepStrictEqual(f.counts(), { probes: 0, loads: 0, reloads: 0 });
		assert.ok(f.sends.some(([channel, value]) => channel === 'vssaros:dsh:desktop-update' && (value as { phase?: string }).phase === 'ready'));
		assert.ok(f.upgrades.includes('desktop'), '全量升级状态必须推给页面（通知卡片据此重画）');
	});

	test('安装准备失败/取消也只推错误状态；真实新连接才恢复Host页面', async () => {
		const f = fixture();
		f.host.pushDesktopUpdate(snapshot('installing'));
		f.host.beginAppUpdate();
		f.host.setConnection(undefined);
		f.host.appUpdatePreparationFailed();
		assert.strictEqual(f.counts().loads, 0);
		assert.strictEqual(f.url(), 'http://127.0.0.1:12333/');
		assert.ok(f.sends.some(([, value]) => (value as { phase?: string }).phase === 'error'));
		assert.strictEqual(f.host._desktopUpdate?.app.error, '会话服务未能安全停止，安装已中止');
		f.host.pushDesktopUpdate(snapshot('idle'));
		assert.ok(f.sends.some(([, value]) => (value as { phase?: string }).phase === 'idle'));
		f.host.setConnection({ origin: 'http://127.0.0.1:12334' });
		assert.strictEqual(f.host._appUpdateSuspended, false);
		assert.strictEqual(f.counts().reloads, 1);
	});

	test('页面本身已不可用时也不换页（绝不加载全屏状态页）', () => {
		const f = fixture();
		f.host.pushDesktopUpdate(snapshot('installing'));
		f.host.beginAppUpdate();
		(f.slot.view.webContents as { mainFrame: { origin: string } }).mainFrame.origin = 'about:blank';
		f.host.setConnection(undefined);
		assert.strictEqual(f.url(), 'http://127.0.0.1:12333/');
		assert.strictEqual(f.counts().loads, 0);
		assert.strictEqual(f.slot.updateStandbyUrl, undefined);
	});

	test('Downloaded与安装Ready不同；本地页无脚本/网络资源和假进度', () => {
		assert.ok(!updateStandbyHtml(snapshot('ready')).includes('更新已安装'));
		for (const phase of ['installing', 'ready', 'error', 'idle'] as const) {
			const html = updateStandbyHtml(snapshot(phase, phase === 'ready'));
			assert.ok(html.includes('data-vssaros-update-standby'));
			assert.ok(html.includes('default-src \'none\''));
			assert.ok(!/<script|<iframe|<img|<meta[^>]+refresh|\bonclick=/i.test(html));
			assert.ok(!html.includes('<progress'));
		}
		const html = updateStandbyHtml({ ...snapshot('installing'), presentation: { phase: 'installing', percent: 45, version: '<script>bad</script>' } });
		assert.ok(html.includes('value="45"'));
		assert.ok(!html.includes('<script>'));
		assert.ok(html.includes('&lt;script&gt;'));
	});

	test('固定操作仅由精确本地页顶层触发，不授权任意data页/子帧/外链或已恢复Host', () => {
		const url = updateStandbyUrl(snapshot('ready', true));
		const input = { target: DSH_UPDATE_STANDBY_ACTION, current: url, expected: url, mainFrame: true, connected: false };
		assert.strictEqual(isUpdateStandbyAction(input), true);
		for (const changed of [{ current: 'about:blank' }, { expected: undefined }, { mainFrame: false }, { connected: true }, { target: DSH_UPDATE_STANDBY_ACTION + '?force=1' }, { current: url + '#other' }]) {
			assert.strictEqual(isUpdateStandbyAction({ ...input, ...changed }), false);
		}
	});

	test('实际导航事件只拦截精确固定操作并打开确认，不会重新启动Host或导航空页', async () => {
		const current = updateStandbyUrl(snapshot('ready', true));
		const calls: unknown[] = [];
		let prevented = 0;
		const context = {
			wc: { getURL: () => current }, slot: { id: 'desktop', updateStandbyUrl: current },
			URL, isUpdateStandbyAction, lastUserInputAt: 0, readEnvFlag: () => false,
			decideMainFrameNavigation: () => 'block',
			_logService: { info() {}, warn() {} },
			_pageCommandHandler: async (command: object, id: string) => { calls.push([command, id]); },
		};
		const js = ts.transpileModule(`globalThis.handler = ${mainFrameHandler()};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
		const script = vm.runInNewContext(js + '\nhandler', context) as (details: { isMainFrame: boolean; url: string; preventDefault(): void }) => void;
		script.call(context, { isMainFrame: true, url: DSH_UPDATE_STANDBY_ACTION, preventDefault() { prevented++; } });
		await Promise.resolve();
		assert.strictEqual(JSON.stringify(calls), JSON.stringify([[{ method: 'desktopUpdateOpen' }, 'desktop']]));
		assert.strictEqual(prevented, 1);
		script.call(context, { isMainFrame: false, url: DSH_UPDATE_STANDBY_ACTION, preventDefault() { prevented++; } });
		assert.strictEqual(calls.length, 1);
	});

	test('真实接线先标记更新再停止Host，待机页动作仅打开原生确认，IPC信任边界不放宽', () => {
		const channel = readFileSync('src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts', 'utf8');
		assert.ok(channel.indexOf('this._views.beginAppUpdate();') < channel.indexOf('await this._supervisor.prepareForAppUpdate(token)'));
		assert.match(source, /_appUpdateSuspended && !this\._connection/);
		assert.match(source, /if \(!slot\.visible \|\| !this\._connection\)/);
		assert.match(source, /isUpdateStandbyAction\(/);
		assert.ok(!methods(VIEW, ['_showHostUnavailable']).includes('updateStandbyUrl('),
			'后台安装路径不许再生成/加载全屏状态页 ✗');
		assert.match(source, /_pageCommandHandler\?\.\(\{ method: 'desktopUpdateOpen' \}, slot\.id\)/);
		assert.match(source, /frame\.parent === null && frame\.origin === this\._connection\.origin/);
	});
});

suite('更新准备真实状态转换', () => {
	test('停止Host之前已经发布Updating，准备失败发布错误且不启动安装器', async () => {
		const file = 'src/vs/platform/update/electron-main/updateService.win32.ts';
		const code = ts.transpileModule(`class Installer { ${methods(file, ['doApplyUpdate'])} } globalThis.Installer = Installer;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
		interface Installer { state: { type: string; update?: object; explicit?: boolean; error?: string }; availableUpdate?: object; preparingInstall: boolean; doApplyUpdate(): Promise<void> }
		const context = {
			Installer: undefined as unknown as { new(): Installer },
			StateType: { Downloaded: 'downloaded', Updating: 'updating' },
			State: { Updating: (update: object, explicit: boolean) => ({ type: 'updating', update, explicit }), Idle: (_type: string, error: string) => ({ type: 'idle', error }) },
			getUpdateType: () => 'setup', runBeforeUpdateInstallHooks: async () => { assert.strictEqual(installer.state.type, 'updating'); throw new Error('stop-failed: interrupted'); },
			spawn() { assert.fail('Must not start installer on veto'); },
		};
		vm.runInNewContext(code, context);
		const installer = new context.Installer();
		Object.assign(installer, { state: { type: 'downloaded', update: { version: 'new' }, explicit: true }, availableUpdate: { packagePath: 'unused' }, setState(value: Installer['state']) { installer.state = value; } });
		await assert.rejects(installer.doApplyUpdate(), /stop-failed/);
		assert.strictEqual(installer.state.type, 'idle');
		assert.ok(installer.state.error?.includes('interrupted'));
		assert.strictEqual(installer.availableUpdate, undefined);
		assert.strictEqual(installer.preparingInstall, false);
	});

	test('计划释放Host在kill前标为stopping，不触发意外退出日志清理', () => {
		const supervisor = readFileSync('src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts', 'utf8');
		const start = supervisor.indexOf('public async releaseHost()');
		const end = supervisor.indexOf('private async _ensurePlugin', start);
		const release = supervisor.slice(start, end);
		assert.ok(release.indexOf("state: 'stopping'") < release.indexOf('await this._killChild()'));
		assert.ok(release.includes('this._runDisposables.clear()'));
		assert.ok(!release.includes('_cleanupRunFiles'));
	});
});
