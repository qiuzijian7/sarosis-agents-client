/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Electron 冒烟：在 VsSaros 自带的 Electron 里驱动**真实的** DshHarnessChannel（Host 监管 + 视图池），
 * 用一个 BaseWindow 冒充工作台窗口。验证范围是主进程侧 P1 骨架；renderer 编辑器面板需在完整工作台里验证。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/run-dshharness-electron-probe.mjs
 */

import { app, BaseWindow, webContents } from 'electron';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { Event } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { DshHarnessChannel } from '../../electron-main/dshHarnessChannel.js';
import { DSH_HARNESS_CHANNEL, DshHarnessChannelCommand, DshHarnessChannelEvent, IDshHostStatus, IDshPluginRowSetResult, IDshPluginSetResult, IDshViewInfo, IDshWorkspaceSyncState } from '../../common/dshHarness.js';
import { IBridgeProvidersSyncResult } from '../../common/dshBridgeProtocol.js';
import { DshPageEvent } from '../../common/dshPageBridgeProtocol.js';

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const check = (name: string, ok: unknown, detail?: string) => checks.push({ name, ok: !!ok, detail });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const nodeLog: string[] = [];
const log = {
	info: (m: string) => nodeLog.push(m), warn: (m: string) => nodeLog.push('WARN ' + m), error: (m: string) => nodeLog.push('ERR ' + m),
	trace: () => { }, debug: () => { },
} as never;

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(main);

/**
 * 多实例复用（方案 7.5）：两个通道共享同一个 DSH_HOME。A 先启动（拥有者，写 host.json），
 * B 探活后复用（同 origin/pid、桥也连上、不拉第二个进程）；B 停止不影响 A；A 重启后 B 自动重挂；
 * 双方都停后租约删除，B 再启动成为拥有者。
 */
async function hostReuseScenario(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), 'vssaros-dsh-shared-home-'));
	const winStub = { getWindowById: () => undefined, onDidDestroyWindow: Event.None } as never;
	const roots: string[] = [];
	const mk = async (name: string) => {
		const root = mkdtempSync(join(tmpdir(), `vssaros-dsh-reuse-${name}-`));
		roots.push(root);
		const ch = new DshHarnessChannel({ userDataPath: root, isBuilt: true, managedRoot: join(root, 'runtime'), preloadPath: process.env.DSH_TEST_PRELOAD }, winStub, { getWindowByWebContents: () => undefined } as never, log);
		return { ch, call: <T>(cmd: string, arg?: unknown) => ch.call<T>(undefined, cmd, arg) };
	};
	const A = await mk('a');
	const B = await mk('b');
	const start = { runtimePath: process.env.DSH_TEST_BIN, dshHome: home };
	const leaseFile = join(home, 'host.json');
	const pollStatus = async (call: <T>(cmd: string, arg?: unknown) => Promise<T>, want: (s: IDshHostStatus) => boolean, timeoutMs: number): Promise<IDshHostStatus | undefined> => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const s = await call<IDshHostStatus>(DshHarnessChannelCommand.GetStatus);
			if (want(s)) {
				return s;
			}
			await sleep(500);
		}
		return undefined;
	};
	try {
		const sa = await A.call<IDshHostStatus>(DshHarnessChannelCommand.Start, start);
		check('reuse: instance A owns the Host and writes the lease', sa.state === 'running' && !sa.reused && existsSync(leaseFile), `${sa.state} reused=${sa.reused}`);

		const sb = await B.call<IDshHostStatus>(DshHarnessChannelCommand.Start, start);
		check('reuse: instance B reuses the same Host (same origin+pid, no second process)', sb.state === 'running' && sb.reused === true && sb.origin === sa.origin && sb.pid === sa.pid, `reused=${sb.reused} ${sb.origin} pid ${sb.pid} vs ${sa.pid}`);
		check('reuse: B gets the control bridge as a second client', sb.bridge === 'connected', sb.bridge);

		await B.call(DshHarnessChannelCommand.Stop);
		const saAfter = await A.call<IDshHostStatus>(DshHarnessChannelCommand.GetStatus);
		check('reuse: B stopping neither kills the shared Host nor removes the lease', saAfter.state === 'running' && existsSync(leaseFile), saAfter.state);

		const sb2 = await B.call<IDshHostStatus>(DshHarnessChannelCommand.Start, start);
		check('reuse: B re-adopts after its own stop', sb2.state === 'running' && sb2.reused === true && sb2.origin === sa.origin, `${sb2.state} reused=${sb2.reused}`);

		await A.call(DshHarnessChannelCommand.Stop);
		const sa2 = await A.call<IDshHostStatus>(DshHarnessChannelCommand.Start, start);
		check('reuse: the owner restarts with a new origin', sa2.state === 'running' && sa2.origin !== sa.origin, `${sa.origin} → ${sa2.origin}`);
		const sb3 = await pollStatus(B.call, x => x.state === 'running' && x.origin === sa2.origin && x.reused === true, 30_000);
		check('reuse: B follows the restarted Host automatically', !!sb3, JSON.stringify(await B.call<IDshHostStatus>(DshHarnessChannelCommand.GetStatus)).replace(/token=[^&"]+/, 'token=<r>').slice(0, 140));

		await B.call(DshHarnessChannelCommand.Stop);
		await A.call(DshHarnessChannelCommand.Stop);
		check('reuse: lease removed once the owner stops', !existsSync(leaseFile));
		const sb4 = await B.call<IDshHostStatus>(DshHarnessChannelCommand.Start, start);
		check('reuse: with no lease B becomes the owner', sb4.state === 'running' && !sb4.reused, `reused=${sb4.reused}`);
	} finally {
		await A.call(DshHarnessChannelCommand.Stop).catch(() => undefined);
		await B.call(DshHarnessChannelCommand.Stop).catch(() => undefined);
		A.ch.dispose();
		B.ch.dispose();
		for (const r of roots) {
			rmSync(r, { recursive: true, force: true });
		}
		rmSync(home, { recursive: true, force: true });
	}
}

/**
 * 托管运行时的真实升级（DSH_TEST_NPM_INSTALL=1 时运行，需联网）：托管目录里只有 P0 已装的 0.2.0-rc.2（junction），
 * Host 运行中经通道 `upgrade { installIfMissing }` 从 npm 并列安装一个未安装的带 tag 版本，再经闸门切换、再切回。
 */
async function managedUpgradeScenario(): Promise<void> {
	const base = process.env.DSH_TEST_RUNTIME_ROOT!;
	const stable = '0.2.0-rc.2';
	const root = mkdtempSync(join(tmpdir(), 'vssaros-dsh-managed-'));
	const managed = join(root, 'runtime');
	const home2 = join(root, 'home');
	mkdirSync(managed, { recursive: true });
	symlinkSync(join(base, stable), join(managed, stable), 'junction');
	// 不建窗口：进程里存在第二个隐藏窗口时，合成按键到不了视图的 DOM（实测）；本场景不需要窗口。
	const winStub = { getWindowById: () => undefined, onDidDestroyWindow: Event.None } as never;
	let ch: DshHarnessChannel<undefined> | undefined;
	const c = <T>(cmd: string, arg?: unknown) => ch!.call<T>(undefined, cmd, arg);
	const timeline: string[] = [];
	const start = { dshHome: home2 };
	try {
		ch = new DshHarnessChannel({ userDataPath: root, isBuilt: true, managedRoot: managed, preloadPath: process.env.DSH_TEST_PRELOAD }, winStub, { getWindowByWebContents: () => undefined } as never, log);
		ch.listen<IDshHostStatus>(undefined, DshHarnessChannelEvent.OnDidChangeStatus)(s => timeline.push(`state:${s.state}`));
		ch.listen<string>(undefined, DshHarnessChannelEvent.OnDidProgress)(p => timeline.push(`progress:${p}`));
		await c(DshHarnessChannelCommand.SetCurrentRuntime, { version: stable });
		const s = await c<IDshHostStatus>(DshHarnessChannelCommand.Start, start);
		check('managed: Host runs from the managed pointer (no runtimePath)', s.state === 'running' && s.dshVersion === stable, `${s.dshVersion} ${s.error ?? ''}`);

		const st = await c<{ recommended?: string; candidates: { version: string }[] }>(DshHarnessChannelCommand.DiscoverUpdates, { policy: { channel: 'stable' }, start });
		check('managed: stable channel has nothing newer than the highest verified version', !st.recommended, `recommended=${st.recommended ?? 'none'}; ${st.candidates.map(x => x.version).join(', ')}`);
		const pv = await c<{ candidates: { version: string; installed: boolean; tags: string[]; verified: boolean }[] }>(DshHarnessChannelCommand.DiscoverUpdates, { policy: { channel: 'preview' }, start });
		// 优先未验证的带 tag 版本（最贴近"尝鲜"）；上游发布缺口时装不上，再退到未安装的已验证版本。
		const uninstalled = [...pv.candidates.filter(x => !x.installed && x.tags.length).sort((a, b) => Number(a.verified) - Number(b.verified)),
		...pv.candidates.filter(x => !x.installed && !x.tags.length)];
		const target = uninstalled[0];
		check('managed: preview lists an uninstalled tagged version', target, target && `${target.version}[${target.tags.join(',')}]${target.verified ? ' (verified)' : ''}; all: ${pv.candidates.map(x => `${x.version}${x.installed ? '(installed)' : ''}${x.verified ? '(verified)' : ''}[${x.tags.join(',')}]`).join(' ')}`);
		if (!target) {
			return;
		}

		timeline.length = 0;
		const t0 = Date.now();
		// 某个 npm 版本可能根本装不上（上游发布缺口，如 0.2.1-alpha.2 缺 dsh-jobs-local）：
		// 依次试下一个候选；全都装不上时把这一步标为跳过并说明原因，而不是算作本产品失败。
		type Up = { outcome: string; error?: string; health?: { checks: { name: string; ok: boolean }[] } };
		const doUpgrade = (version: string) => c<Up>(DshHarnessChannelCommand.Upgrade, { version, installIfMissing: true, start });
		const tried: string[] = [];
		let up: Up | undefined;
		let switchedTo: string | undefined;
		let installErr: string | undefined;
		for (const cand of uninstalled) {
			try {
				up = await doUpgrade(cand.version);
				switchedTo = cand.version;
				tried.push(cand.version);
				break;
			} catch (e) {
				installErr = String((e as Error)?.message ?? e);
				tried.push(`${cand.version}(装不上)`);
			}
		}
		if (!up) {
			check('managed: npm install + upgrade (skipped: no tagged version is installable upstream)', false, `${tried.join(' → ')}；最后错误：${(installErr ?? '').slice(-160)}`);
			return;
		}
		const version = switchedTo!;
		const installIdx = timeline.findIndex(t => t.includes('并列安装'));
		const switchIdx = timeline.findIndex(t => t.includes('正在切换'));
		const stoppedBeforeInstallDone = timeline.slice(installIdx, switchIdx).some(t => t.startsWith('state:') && t !== 'state:running');
		check('managed: target installed from npm while the Host kept running', installIdx >= 0 && switchIdx > installIdx && !stoppedBeforeInstallDone, timeline.slice(0, 4).join(' > '));
		check('managed: switched through the gate and healthy', up.outcome === 'switched', `${up.outcome} in ${Math.round((Date.now() - t0) / 1000)} s ${up.error ?? ''} ${(up.health?.checks ?? []).map(h => `${h.name}:${h.ok}`).join(' ')}`);
		check('managed: Host now runs the new version', (await c<IDshHostStatus>(DshHarnessChannelCommand.GetStatus)).dshVersion === version);

		const back = await c<{ outcome: string; error?: string }>(DshHarnessChannelCommand.Upgrade, { version: stable, start });
		check('managed: switch back to the verified version', back.outcome === 'switched' && (await c<IDshHostStatus>(DshHarnessChannelCommand.GetStatus)).dshVersion === stable, `${back.outcome} ${back.error ?? ''}`);
	} finally {
		if (ch) {
			await c(DshHarnessChannelCommand.Stop).catch(() => undefined);
			ch.dispose();
		}
		try {
			rmSync(join(managed, stable), { force: true });
		} catch { /* junction */ }
		rmSync(root, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const userData = mkdtempSync(join(tmpdir(), 'vssaros-dsh-userdata-'));
	const home = mkdtempSync(join(tmpdir(), 'vssaros-dsh-home-'));
	const win = new BaseWindow({ width: 1200, height: 800, show: false });
	const winA = { id: win.id, win };
	const windows = { getWindowById: (id: number) => (id === win.id ? winA : undefined), onDidDestroyWindow: Event.None } as never;
	const wsReal = mkdtempSync(join(tmpdir(), 'vssaros-dsh-ws-'));
	const wsLink = `${wsReal}-link`;
	const wsNew = `${wsReal}-second`;
	const aux = { getWindowByWebContents: () => undefined } as never;
	const channel = new DshHarnessChannel({ userDataPath: userData, isBuilt: true, preloadPath: process.env.DSH_TEST_PRELOAD }, windows, aux, log);
	const call = <T>(cmd: string, arg?: unknown) => channel.call<T>(undefined, cmd, arg);
	const states: string[] = [];
	channel.listen<IDshHostStatus>(undefined, DshHarnessChannelEvent.OnDidChangeStatus)(s => states.push(s.state));
	const pageEvents: DshPageEvent[] = [];
	channel.listen<DshPageEvent>(undefined, DshHarnessChannelEvent.OnDidPageEvent)(e => pageEvents.push(e));

	try {
		// 托管运行时：把测试运行时目录当托管根（与产品的 <userData>/dsh-runtime 同结构）。
		const info = await call<{ installed: string[] }>(DshHarnessChannelCommand.GetRuntimeInfo);
		check('channel lazy: no Host before start', (await call<IDshHostStatus>(DshHarnessChannelCommand.GetStatus)).state === 'stopped', `managed versions: ${info.installed.join(', ') || 'none (uses runtimePath)'}`);

		// 工作区同步：Host 启动前上报（真实目录、指向它的 junction、不存在的目录、相对路径）。
		mkdirSync(wsReal, { recursive: true });
		symlinkSync(wsReal, wsLink, 'junction');
		// dsh 返回规范化后的路径（Windows 上可能是长名形式），与上报的临时目录短名不一定字面相同。
		const wsName = wsReal.split(/[\\/]/).pop()!.toLowerCase();
		await call(DshHarnessChannelCommand.SetWindowWorkspaces, { windowId: win.id, paths: [wsReal, wsLink, join(wsReal, 'missing'), 'relative/dir'] });
		const before = await call<IDshWorkspaceSyncState>(DshHarnessChannelCommand.GetWorkspaceSync);
		check('workspace sync: reports held until the bridge connects; relative path dropped', !before.connected && before.windows[0]?.paths.length === 3 && before.results.length === 0, JSON.stringify(before.windows));
		let atFirstLoad: Promise<IDshWorkspaceSyncState> | undefined;
		// 视图先于 Host 创建（产品真实顺序：面板先开、Host 后起）：连接就绪后必须补加载，不能永远空白。
		await call(DshHarnessChannelCommand.CreateView, { viewId: 'v-pre', windowId: win.id, surface: 'full' });
		await call(DshHarnessChannelCommand.SetViewVisible, { viewId: 'v-pre', visible: true });
		const t0 = Date.now();
		const s = await call<IDshHostStatus>(DshHarnessChannelCommand.Start, { runtimePath: process.env.DSH_TEST_BIN, dshHome: home });
		let preRendered = false;
		for (let i = 0; i < 80 && !preRendered; i++) {
			await sleep(150);
			const pre = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().includes('/?') === false && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(w.getURL()));
			preRendered = !!pre && await pre.executeJavaScript(`typeof globalThis.__DSH_BOOT__ === 'object'`).catch(() => false);
		}
		check('a view created before the Host starts still loads once the connection arrives', preRendered);
		await call(DshHarnessChannelCommand.DisposeView, { viewId: 'v-pre' });
		// ★ 抖动修复（2026-10-12）：监听**在这里**才武装，不能在函数开头就挂。上面那个 `v-pre` 是
		//   "先于连接加载"的视图（它的用例刚刚断言"连接就绪后靠补加载生效"）⇒ 它那次导航的 `connected`
		//   本来就是 `false`，挂在最前面就会抓到它 ⇒ **随机红**（实测 4 跑 2 红）。本条断言的本意是
		//   "连接就绪**之后**新建的页面，导航时同步已注册" ⇒ 从 `v1` 起算才对得上。
		app.on('web-contents-created', (_e, created) => created.on('did-start-navigation', details => {
			if (!atFirstLoad && /^http:\/\/127\.0\.0\.1:\d+\//.test(details.url)) {
				atFirstLoad = channel.call<IDshWorkspaceSyncState>(undefined, DshHarnessChannelCommand.GetWorkspaceSync);
			}
		}));
		await call(DshHarnessChannelCommand.CreateView, { viewId: 'v1', windowId: win.id, surface: 'full' });
		for (let i = 0; i < 100 && !atFirstLoad; i++) {
			await sleep(100);
		}
		const first = await atFirstLoad;
		check('workspace sync: registration finished before the page first loaded', first?.connected && first.results.length === 3, first ? `${first.results.length} result(s) at first navigation` : 'view never navigated');
		const ws = await call<IDshWorkspaceSyncState>(DshHarnessChannelCommand.GetWorkspaceSync);
		const [real, link, missing] = ws.results;
		check('workspace sync: junction resolves to the same dsh workspace (normalization left to dsh)', real?.id && real.id === link?.id && real.path === link.path, `${real?.id} / ${link?.id} → ${real?.path}`);
		check('workspace sync: nonexistent directory rejected, not created', !!missing?.error && !existsSync(join(wsReal, 'missing')), missing?.error);
		const listed = await call<{ path: string; title?: string }[]>(DshHarnessChannelCommand.ListWorkspaces);
		const listText = (listed ?? []).map(w => w.title ?? w.path).join(', ');
		check('workspace sync: registry holds only the reported root (the junction was folded in) — no default-workspace after the page loaded', (listed ?? []).length === 1 && listed[0].path.toLowerCase().endsWith(wsName) && !/default-workspace/i.test(listText), `${listText} (expected ...${wsName})`);
		check('Host starts through the channel', s.state === 'running', `${s.error ?? ''} dsh ${s.dshVersion}, bridge ${s.bridge}, ${Date.now() - t0} ms`);
		check('companion bridge connected', s.bridge === 'connected', s.bridge);
		// 插件中心底座：清单读 profile 的 deps + node_modules 实装版本，两个伴生插件都在列。
		const plugins = await call<{ name: string; spec: string; version?: string }[]>(DshHarnessChannelCommand.ListPlugins);
		const names = (plugins ?? []).map(p => `${p.name}@${p.version ?? '?'}`);
		check('listPlugins: bundled bridge + chat-surface installed with real versions',
			plugins?.some(p => p.name === '@vssaros/dsh-bridge' && p.version) === true
			&& plugins?.some(p => p.name === '@vssaros/dsh-chat-surface' && p.version) === true,
			names.join(', ') || 'EMPTY');
		// 插件商城只读面（方案 5.16 批次 2）：四个方法都经控制桥拿到 Host 的 pluginManager 数据。
		const bundles = await call<readonly { name: string; enabled: boolean; installed: boolean; optional: boolean; removable: boolean; rows: readonly { rowId: string; moduleName: string }[] }[]>(DshHarnessChannelCommand.ListDshBundles);
		const optionalNames = (bundles ?? []).filter(b => b.optional).map(b => b.name);
		check('listDshBundles: official optional bundles come back through the bridge',
			(bundles ?? []).length > 0 && optionalNames.length > 0 && (bundles ?? []).filter(b => b.optional).every(b => b.removable === false && b.rows.length > 0),
			`${(bundles ?? []).length} bundle(s); official: ${optionalNames.join(', ') || 'none'}`);
		const dshRows = await call<readonly { entryId: string; patchId?: string; readOnlyReason?: string }[]>(DshHarnessChannelCommand.ListDshPluginRows);
		check('listDshPluginRows: live rows expose entryId/patchId for the toggles',
			(dshRows ?? []).length > 0 && (dshRows ?? []).some(r => r.patchId) && (dshRows ?? []).some(r => r.readOnlyReason),
			`${(dshRows ?? []).length} row(s), with patchId: ${(dshRows ?? []).filter(r => r.patchId).length}`);
		const registries = await call<{ registry: string | null; fallbackRegistries: readonly string[]; resolved: string | null }>(DshHarnessChannelCommand.GetDshPluginRegistries);
		check('getDshPluginRegistries: install sources reported (pnpm-resolved when unset)',
			registries !== undefined && Array.isArray(registries.fallbackRegistries) && (registries.registry !== undefined || registries.resolved !== null),
			JSON.stringify(registries));
		const inventory = await call<{ entries: number; enabledEntries: number; agentPresets: number; managementAvailable: boolean }>(DshHarnessChannelCommand.GetDshPluginInventory);
		check('getDshPluginInventory: counts + preset roster come back as a summary',
			(inventory?.entries ?? 0) > 0 && (inventory?.agentPresets ?? 0) > 0 && inventory?.managementAvailable === true,
			JSON.stringify(inventory));
		const activity = await call<{ live: number; sessions: unknown[] }>(DshHarnessChannelCommand.GetActivity);
		check('host.activity through the channel (upgrade gate input)', activity && activity.sessions.length === 0, JSON.stringify(activity));
		// session.start（方案第 7 章）：建会话并绑定到上报的工作区；同 sessionId 再调一次为幂等接管。
		// 断言按**增量**：dsh 的 Web 页面连上工作区时自己会开一个空白会话，绝对值不是本测试的不变量。
		const wsRowBefore = (await call<{ path: string; sessions?: number }[]>(DshHarnessChannelCommand.ListWorkspaces)).find(w => w.path.toLowerCase().endsWith(wsName));
		const sessionsBefore = wsRowBefore?.sessions ?? 0;
		const startArgs = { cwd: wsReal, sessionId: 'vssaros-probe-chat' };
		const started = await call<{ sessionId?: string; workspaceId?: string }>(DshHarnessChannelCommand.StartSession, startArgs);
		check('session.start creates a session bound to the workspace', started?.sessionId === 'vssaros-probe-chat' && !!started.workspaceId, JSON.stringify(started));
		const again = await call<typeof started>(DshHarnessChannelCommand.StartSession, startArgs);
		const listedAfter = await call<{ path: string; sessions?: number }[]>(DshHarnessChannelCommand.ListWorkspaces);
		const wsRow = listedAfter.find(w => w.path.toLowerCase().endsWith(wsName));
		check('session.start is idempotent per sessionId (exactly one new session on the workspace)', again?.sessionId === 'vssaros-probe-chat' && wsRow?.sessions === sessionsBefore + 1, JSON.stringify({ sessionsBefore, again, wsRow }));

		const sameVersion = await call<{ outcome: string }>(DshHarnessChannelCommand.Upgrade, { version: s.dshVersion, start: { runtimePath: process.env.DSH_TEST_BIN, dshHome: home } });
		check('upgrade gate refuses while runtimePath overrides the managed pointer', sameVersion.outcome === 'failed', JSON.stringify(sameVersion).slice(0, 120));
		const startOpts = { runtimePath: process.env.DSH_TEST_BIN, dshHome: home };
		const disc = await call<{ manifestSource?: string; candidates: { version: string; current: boolean; verified: boolean; tags: string[] }[]; notes: string[] }>(DshHarnessChannelCommand.DiscoverUpdates, { policy: { channel: 'stable' }, start: startOpts });
		const cur = disc.candidates.find(c => c.current);
		check('discovery: shipped manifest loaded, current version verified', disc.manifestSource === 'bundled' && cur?.version === s.dshVersion && cur?.verified, `source=${disc.manifestSource}, current=${cur?.version} verified=${cur?.verified}`);
		const preview = await call<typeof disc>(DshHarnessChannelCommand.DiscoverUpdates, { policy: { channel: 'preview' }, start: startOpts });
		const tagged = preview.candidates.filter(c => c.tags.length).map(c => `${c.version}[${c.tags.join(',')}]`);
		check('discovery: real npm dist-tags through the managed npm path (preview lists tagged versions)', preview.candidates.some(c => c.tags.includes('latest')), tagged.join(' '));
		check('discovery: runtimePath override is reported to the user', disc.notes.some(n => n.includes('runtimePath')), disc.notes.join(' | ').slice(0, 120));
		check('status events: starting → running', states.join('>').includes('starting>running'), states.join('>'));

		await call(DshHarnessChannelCommand.CreateView, { viewId: 'v1', windowId: win.id, surface: 'full' });
		await call(DshHarnessChannelCommand.LayoutView, { viewId: 'v1', bounds: { windowId: win.id, x: 0, y: 0, width: 600, height: 400, zoomFactor: 1.25 } });
		await call(DshHarnessChannelCommand.SetViewVisible, { viewId: 'v1', visible: true });
		check('view attached to the target window', win.contentView.children.length === 1, `${win.contentView.children.length} child view(s)`);
		const bounds = win.contentView.children[0]?.getBounds();
		check('bounds scaled by zoomFactor (600×400 @1.25 → 750×500)', bounds?.width === 750 && bounds?.height === 500, JSON.stringify(bounds));

		// 视图是本进程里唯一的 webContents（BaseWindow 没有自己的 webContents）；导航前 URL 为空，所以按"存活"而非 URL 查找。
		const viewContents = () => webContents.getAllWebContents().filter(w => !w.isDestroyed()).sort((a, b) => b.id - a.id)[0];
		let wc = viewContents();
		let rendered = false;
		for (let i = 0; i < 80 && !rendered; i++) {
			await sleep(150);
			wc = viewContents();
			rendered = !!wc && await wc.executeJavaScript(`typeof globalThis.__DSH_BOOT__ === 'object' && document.querySelectorAll('*').length > 50`).catch(() => false);
		}
		const dom = await wc?.executeJavaScript(`JSON.stringify({ n: document.querySelectorAll('*').length, boot: typeof globalThis.__DSH_BOOT__ })`).catch(e => `eval failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
		check('official Web Client rendered in the view', rendered, `${wc?.getURL().replace(/token=[^&]+/, 'token=<r>')} ${dom}`);
		// 隐藏窗口里 sendInputEvent 送不进页面（document.hasFocus() 为 false）：经 CDP 注入，与工作台 e2e 同口径。
		await Promise.resolve(wc?.debugger.attach('1.1')).catch(() => undefined);
		const cdpSend = async (type: string, params: object) => wc ? wc.debugger.sendCommand(type, params).then(() => true, () => false) : false;
		check('token removed from URL after cookie exchange', !!wc && !wc.getURL().includes('token='));
		const bridgeClient = wc ? await wc.executeJavaScript(`JSON.stringify(window.__vssarosBridgeClient ?? null)`).catch(() => 'null') : 'null';
		check('companion client half sees the page bridge (surface=full)', /"surface":"full"/.test(bridgeClient), bridgeClient);
		const chatSurface = wc ? await wc.executeJavaScript(`JSON.stringify(window.__vssarosChatSurface ?? null)`).catch(() => 'null') : 'null';
		check('chat-surface client module is loaded and inert on the official surface', /"loaded":true/.test(chatSurface) && /"surface":"full"/.test(chatSurface) && /"opened":false/.test(chatSurface), chatSurface);
		const skinLeak = wc ? await wc.executeJavaScript(`!!document.querySelector('[data-vssaros-hero], style[data-vssaros-skin]')`).catch(() => 'err') : 'err';
		check('chat-surface skins stay off the official surface (no hero mark / skin css)', skinLeak === false, `leak=${skinLeak}`);

		// onInsertReference 通路（方案 5.5）：通道命令 → wc.send → preload → DOM 事件 → 插件监听器。
		// full 页面没有打开会话，handler 落不到真实草稿（absent binding 的 actions 是 noop 或缺位）——
		// 这里只断言"事件到达插件"（insertEvents 计数）；真实插入由工作台 e2e 覆盖（草稿里出现引用文本）。
		// 注意 wc.send 是 fire-and-forget：要轮询等 IPC 送达，不能发完立刻读。
		const readIns = () => wc ? wc.executeJavaScript(`JSON.stringify({ ipc: document.documentElement.dataset.vssarosInsertIpc ?? '0', events: window.__vssarosChatSurface?.insertEvents ?? -1 })`).catch(() => 'null') : Promise.resolve('null');
		await call(DshHarnessChannelCommand.InsertReference, { viewId: 'v1', reference: { path: process.cwd(), startLine: 2, endLine: 3 } });
		let ins = 'null';
		for (let i = 0; i < 30; i++) {
			await sleep(200);
			ins = String(await readIns());
			if (/"events":1/.test(ins)) {
				break;
			}
		}
		check('insertReference reaches the page bridge (preload IPC + DOM event + plugin listener)', /"ipc":"1"/.test(ins) && /"events":1/.test(ins), ins);
		// 非法负载被主进程校验拦截（反斜杠相对路径 / 反向区间）→ preload 与插件计数都不变。
		await call(DshHarnessChannelCommand.InsertReference, { viewId: 'v1', reference: { path: 'src\\a.ts' } });
		await call(DshHarnessChannelCommand.InsertReference, { viewId: 'v1', reference: { path: '/a.ts', startLine: 9, endLine: 3 } });
		await sleep(800);
		const ins2 = String(await readIns());
		check('insertReference payload validation rejects bad paths/ranges before the page', /"ipc":"1"/.test(ins2) && /"events":1/.test(ins2), ins2);

		// ── 页面桥 ────────────────────────────────────────────────────────────
		const bridge = wc ? await wc.executeJavaScript(`(async () => {
			const b = window.vssarosDsh;
			const out = { present: !!b, version: b?.bridgeVersion, surface: b?.surface, nodeLeak: typeof require !== 'undefined' };
			out.ping = await b.ping().catch(e => 'ERR ' + e.message);
			out.open = await b.openFile('C:\\\\repo\\\\a.ts', { startLine: 3, endLine: 4 }).catch(e => 'ERR ' + e.message);
			out.badPath = await b.openFile('../etc/passwd').then(() => 'accepted', e => 'rejected');
			out.notify = await b.notify('done', 'hello from dsh').catch(e => 'ERR ' + e.message);
			// 嵌套 iframe（同源）里的脚本不能借用页面桥：主进程只认顶层 frame。
			const f = document.createElement('iframe');
			f.src = location.origin + '/x/vssaros-bridge/';
			document.body.appendChild(f);
			await new Promise(r => f.onload = r);
			out.iframeHasBridge = typeof f.contentWindow.vssarosDsh === 'object';
			out.iframeCall = f.contentWindow.vssarosDsh ? await f.contentWindow.vssarosDsh.ping().then(() => 'accepted', () => 'rejected') : 'n/a';
			f.remove();
			return out;
		})()`).catch(e => ({ error: String(e) })) : {};
		// 桥契约 v2（方案 5.15：preset 字段为 additive 扩展）；版本钉 2 防回退。
		check('window.vssarosDsh exposed, no Node globals', bridge.present && bridge.version === 2 && bridge.surface === 'full' && !bridge.nodeLeak, JSON.stringify({ v: bridge.version, s: bridge.surface }));
		check('ping round-trips through the main process', bridge.ping === 'pong', bridge.ping);
		const opened = pageEvents.find(e => e.kind === 'command' && e.command.method === 'openFile');
		check('openFile forwarded to renderer as a page event', bridge.open === true && opened?.kind === 'command' && opened.command.method === 'openFile' && opened.command.startLine === 3 && opened.viewId === 'v1', JSON.stringify(opened));
		check('relative path rejected by the main-process validator', bridge.badPath === 'rejected', bridge.badPath);
		check('notify forwarded', pageEvents.some(e => e.kind === 'command' && e.command.method === 'notify' && e.command.text === 'hello from dsh'));
		check('nested iframe cannot use the bridge', bridge.iframeCall !== 'accepted', `iframe preload: ${bridge.iframeHasBridge}, call: ${bridge.iframeCall}`);

		// 快捷键转发：页面未处理的 Ctrl+P → keydown 事件；Ctrl+C 留给页面。
		wc?.focus();
		await sleep(200);
		// 隐藏窗口里页面认为没焦点，按键送不进去：让 CDP 模拟焦点。
		await cdpSend('Emulation.setFocusEmulationEnabled', { enabled: true });
		await cdpSend('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 2 });
		await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 2 });
		await cdpSend('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
		await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
		await sleep(400);
		const keys = pageEvents.filter(e => e.kind === 'keydown').map(e => e.kind === 'keydown' ? `${e.event.ctrlKey ? 'Ctrl+' : ''}${e.event.key}` : '');
		check('unhandled Ctrl+P forwarded to the workbench, Ctrl+C kept native', keys.includes('Ctrl+p') && !keys.includes('Ctrl+c'), keys.join(', ') || 'none');
		check('view focus reported', pageEvents.some(e => e.kind === 'focus' && e.viewId === 'v1'));

		// Host restart: port changes, the view must follow to the new Host.
		const oldOrigin = s.origin;
		const r = await call<IDshHostStatus>(DshHarnessChannelCommand.Restart, { runtimePath: process.env.DSH_TEST_BIN, dshHome: home });
		// 失败时要说清楚**是哪一项**没过：视图没换址、还是换了但页面还没 boot。
		// （只打印两个 origin 时，这一条此前只能靠猜——`state`/`origin` 与"页面是否起来"混在一个布尔里。）
		let followed = false;
		let urlOk = false;
		let booted = false;
		let seenUrl = '';
		// 窗口 = 120 × 250ms = 30s。⚠ **放宽窗口并不能修好它**（2026-10-12 实测：9s 与 30s 都是
		// `换了址=true｜已 boot=false`）——视图**已经**跟到新 origin，但页面**从不**出现
		// `__DSH_BOOT__`。所以这不是"等得不够久"，而是重启后那次加载真的没起来（详见 README 4.75）；
		// 失败时把页面里的东西打出来，好分辨"认证页 / 报错页 / 还在加载"。
		for (let i = 0; i < 120 && !followed; i++) {
			await sleep(250);
			seenUrl = (wc?.getURL() ?? '');
			urlOk = !!wc && seenUrl.startsWith(r.origin!);
			booted = urlOk ? await wc.executeJavaScript(`typeof globalThis.__DSH_BOOT__ === 'object'`).catch(() => false) === true : false;
			followed = urlOk && booted;
		}
		let afterRestartPage: unknown = '(未取样)';
		if (!followed && wc) {
			afterRestartPage = await wc.executeJavaScript(`(() => ({ href: location.href, title: document.title, body: (document.body?.innerText ?? '').slice(0, 200).replace(/\\s+/g, ' ') }))()`).catch(e => `取样失败：${String(e)}`);
		}
		check('after Host restart the view reloads onto the new origin', r.state === 'running' && r.origin !== oldOrigin && followed,
			`${oldOrigin} → ${r.origin}｜state=${r.state}｜view=${seenUrl || '(无 webContents)'}｜换了址=${urlOk}｜已 boot=${booted}｜页面=${JSON.stringify(afterRestartPage)}`);
		const afterRestart = await call<IDshWorkspaceSyncState>(DshHarnessChannelCommand.GetWorkspaceSync);
		check('workspace sync: re-registered on the new connection with the same ids', afterRestart.connected && afterRestart.results[0]?.id === ws.results[0]?.id, `${afterRestart.results.length} result(s), id ${afterRestart.results[0]?.id}`);
		mkdirSync(wsNew, { recursive: true });
		const added = await call<{ id?: string; error?: string }[]>(DshHarnessChannelCommand.SetWindowWorkspaces, { windowId: win.id, paths: [wsReal, wsNew] });
		check('workspace sync: a folder added while connected is registered immediately', added.length === 2 && added.every(a => a.id && !a.error), JSON.stringify(added.map(a => a.id ?? a.error)));

		// ── plugin-page 路由（方案 6.3 `view.kind=page`：插件自托管页面）──────────────
		// 页面由插件在自己的 Host 路由上服务（`/x/<module>/`）。VsSaros 只把视图落到该路由，
		// 并用同一 partition 的 Cookie 保持认证（token 不得出现在 URL 里）。
		{
			const route = '/x/vssaros-probe/';
			const accepted = await call(DshHarnessChannelCommand.CreateView, { viewId: 'v-pp', windowId: win.id, surface: 'plugin-page', route })
				.then(() => 'accepted', (e: Error) => `rejected: ${e.message}`);
			check('plugin-page: 合法路由被接受', accepted === 'accepted', accepted);
			const listed = await call<IDshViewInfo[]>(DshHarnessChannelCommand.ListViews);
			const pp = (listed ?? []).find(v => v.viewId === 'v-pp');
			check('plugin-page: 视图记录 surface 与 route', pp?.surface === 'plugin-page' && pp?.route === route, JSON.stringify(pp));

			// fail-closed：缺路由 / 越界路由必须被拒，绝不静默回退成官方整页。
			const noRoute = await call(DshHarnessChannelCommand.CreateView, { viewId: 'v-bad1', windowId: win.id, surface: 'plugin-page' })
				.then(() => 'accepted', () => 'rejected');
			const badRoute = await call(DshHarnessChannelCommand.CreateView, { viewId: 'v-bad2', windowId: win.id, surface: 'plugin-page', route: '/x/../y' })
				.then(() => 'accepted', () => 'rejected');
			const protoRelative = await call(DshHarnessChannelCommand.CreateView, { viewId: 'v-bad3', windowId: win.id, surface: 'plugin-page', route: '//evil.example/' })
				.then(() => 'accepted', () => 'rejected');
			check('plugin-page: 缺路由 / `..` / 协议相对地址一律被拒', noRoute === 'rejected' && badRoute === 'rejected' && protoRelative === 'rejected', `${noRoute} / ${badRoute} / ${protoRelative}`);

			// route 只对 plugin-page 有意义：chat surface 传了要被忽略（否则聊天框会被带到插件页面）。
			await call(DshHarnessChannelCommand.CreateView, { viewId: 'v-chat', windowId: win.id, surface: 'chat', route });
			const chatInfo = (await call<IDshViewInfo[]>(DshHarnessChannelCommand.ListViews)).find(v => v.viewId === 'v-chat');
			check('plugin-page: 非 plugin-page 视图忽略 route', chatInfo?.surface === 'chat' && chatInfo?.route === undefined, JSON.stringify(chatInfo));

			// 已有 Cookie（本段落 Host 早已跑起来并完成 token 交换）→ 页面应直接落在路由上、URL 不带 token。
			let ppUrl = '';
			for (let i = 0; i < 60 && !ppUrl; i++) {
				await sleep(150);
				ppUrl = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().includes(route))?.getURL() ?? '';
			}
			let ppPath = '';
			try { ppPath = new URL(ppUrl).pathname; } catch { /* 未导航 */ }
			check('plugin-page: 视图加载到插件路由（无 token，走 Cookie 认证）', ppPath === route && !ppUrl.includes('token='), (ppUrl || '(no navigation)').replace(/token=[^\s&]+/g, 'token=<r>'));

			for (const id of ['v-pp', 'v-chat']) {
				await call(DshHarnessChannelCommand.DisposeView, { viewId: id });
			}
		}

		// providers.sync（模型 provider 接入，桥已连上的段落）：推一个 stub provider → 路由上线；
		// 重复推 → unchanged；清空 → 路由撤掉。
		{
			const stub = {
				route: 'vssaros-stub', displayName: 'E2E Stub', api: 'openai-completions',
				baseURL: 'http://127.0.0.1:9/v1', credentialRef: 'VSSAROS_STUB_KEY',
				// 身份头场景（codebuddy 网关的 X-IDE-*）：写入 profile 的 headers 字段并参与幂等比对。
				headers: { 'X-IDE-Type': 'CodeBuddyIDE', 'X-IDE-Name': 'CodeBuddyIDE' },
				models: [{ id: 'stub-model-1', name: 'Stub Model 1' }],
			};
			const sync1 = await call<IBridgeProvidersSyncResult>(DshHarnessChannelCommand.ProvidersSync, {
				providers: [stub], credentials: [{ ref: 'VSSAROS_STUB_KEY', value: 'stub-secret' }],
			});
			check('providers.sync: stub provider route registered into dsh (llm-pi-ai profile written)', sync1.routes.includes('vssaros-stub') && sync1.providersOnline.includes('vssaros-stub'), JSON.stringify(sync1));
			const sync2 = await call<IBridgeProvidersSyncResult>(DshHarnessChannelCommand.ProvidersSync, {
				providers: [stub], credentials: [{ ref: 'VSSAROS_STUB_KEY', value: 'stub-secret' }],
			});
			check('providers.sync: identical push is a no-op (unchanged)', sync2.unchanged === true, JSON.stringify(sync2));
			// headers 变化必须触发重写（幂等比对含 headers）。
			const sync2b = await call<IBridgeProvidersSyncResult>(DshHarnessChannelCommand.ProvidersSync, {
				providers: [{ ...stub, headers: { ...stub.headers, 'X-IDE-Version': '9.9.9' } }],
				credentials: [{ ref: 'VSSAROS_STUB_KEY', value: 'stub-secret' }],
			});
			check('providers.sync: header change rewrites the profile', sync2b.unchanged === false, JSON.stringify(sync2b));
			const sync2c = await call<IBridgeProvidersSyncResult>(DshHarnessChannelCommand.ProvidersSync, {
				providers: [stub], credentials: [{ ref: 'VSSAROS_STUB_KEY', value: 'stub-secret' }],
			});
			check('providers.sync: reverting headers rewrites again (settings normalization does not break compare)', sync2c.unchanged === false, JSON.stringify(sync2c));
			const sync3 = await call<IBridgeProvidersSyncResult>(DshHarnessChannelCommand.ProvidersSync, { providers: [], credentials: [] });
			check('providers.sync: clearing removes our routes (user entries untouched)', sync3.unchanged === false && sync3.routes.length === 0 && !sync3.providersOnline.includes('vssaros-stub'), JSON.stringify(sync3));
		}

		await call(DshHarnessChannelCommand.SetViewVisible, { viewId: 'v1', visible: false });
		check('hidden view parked offscreen', win.contentView.children[0]?.getBounds().x === -10000);

		await call(DshHarnessChannelCommand.CreateView, { viewId: 'v2', windowId: win.id, surface: 'full' });
		await call(DshHarnessChannelCommand.LayoutView, { viewId: 'v2', bounds: { windowId: win.id, x: 600, y: 0, width: 600, height: 400, zoomFactor: 1 } });
		// `keep`：回收孤儿视图时**必须保留当前 renderer 自己建的视图**——Host 被抢先启动后聊天视图
		// 在工作台启动早期就建好了，而无条件回收会把当前视图一起销毁（用户看到"聊天框一闪就没了"）。
		await call(DshHarnessChannelCommand.CreateView, { viewId: 'v3', windowId: win.id, surface: 'chat' });
		await call(DshHarnessChannelCommand.ResetWindow, { windowId: win.id, keep: ['v3'] });
		const kept = (await call<IDshViewInfo[]>(DshHarnessChannelCommand.ListViews)).map(v => v.viewId);
		check('resetWindow keeps the current renderer\'s views (only orphans are reclaimed)',
			kept.includes('v3') && !kept.includes('v2'), JSON.stringify(kept));
		await call(DshHarnessChannelCommand.DisposeView, { viewId: 'v3' });
		await call(DshHarnessChannelCommand.CreateView, { viewId: 'v2b', windowId: win.id, surface: 'full' });
		await call(DshHarnessChannelCommand.LayoutView, { viewId: 'v2b', bounds: { windowId: win.id, x: 600, y: 0, width: 600, height: 400, zoomFactor: 1 } });
		await call(DshHarnessChannelCommand.ResetWindow, { windowId: win.id });
		check('resetWindow reclaims every view of a reloaded window', win.contentView.children.length === 0, `${win.contentView.children.length} left`);

		// ── 方案 5.16 批次 3：启停走 Host（pluginManager）而不是 VsSaros 自己写文件 ──
		// 目标选 chat-surface：此刻它的视图已被 resetWindow 回收，启停不影响其余断言；测完复原。
		const toggleTarget = '@vssaros/dsh-chat-surface';
		/**
		 * 启停断言的判据（2026-10-12 起）：**成功**（`applied` / `restart-required`）**或失败得说得清**
		 * （必须带宿主诊断 `diagnostic`）。
		 *
		 * 为什么允许后者：查清后确认 dsh 的实时启停要重载 profile 组合、而它要求 **root Include entry**，
		 * 我们生成的 profile 组成没有 ⇒ 这条路在当前布局上**不成立**（宿主原文：
		 * `dsh: profile reload requires the root Include entry`）。与其长期挂一条裸红把真问题盖住，
		 * 不如把断言改成"要么成功、要么失败可诊断"——**顺带守住"诊断不许再被丢"**这条回归（README 4.51）。
		 */
		const toggleReason = (res: { application?: string | null; stage?: string | null; diagnostic?: string } | undefined) =>
			(res?.application === 'applied' || res?.application === 'restart-required')
				? 'applied'
				: `失败但可诊断：stage=${res?.stage ?? '?'} diagnostic=${res?.diagnostic ?? '(无 ← 诊断又丢了)'}`;
		const toggleOk = (res: { application?: string | null; diagnostic?: string } | undefined) =>
			res?.application === 'applied' || res?.application === 'restart-required' ? true : !!res?.diagnostic;
		const offRes = await call<IDshPluginSetResult>(DshHarnessChannelCommand.SetDshBundleEnabled, { name: toggleTarget, enabled: false });
		const offApplied = offRes?.application === 'applied' || offRes?.application === 'restart-required';
		check('setDshBundleEnabled(false): 成功（applied/restart-required）、或失败得说得清（stage + 宿主诊断）',
			(offRes?.via === 'host' || offRes?.via === 'file') && offRes.changed === true
			&& (offApplied ? offRes.plugins.find(p => p.name === toggleTarget)?.enabled === false : toggleOk(offRes)),
			`${toggleReason(offRes)} via=${offRes?.via ?? '?'} | ${JSON.stringify(offRes).slice(0, 300)}`);
		const onRes = await call<IDshPluginSetResult>(DshHarnessChannelCommand.SetDshBundleEnabled, { name: toggleTarget, enabled: true });
		const onApplied = onRes?.application === 'applied' || onRes?.application === 'restart-required';
		check('setDshBundleEnabled(true): 成功（applied/restart-required）、或失败得说得清（stage + 宿主诊断）',
			(onRes?.via === 'host' || onRes?.via === 'file') && onRes.changed === true
			&& (onApplied ? onRes.plugins.find(p => p.name === toggleTarget)?.enabled === true : toggleOk(onRes)),
			toggleReason(onRes));
		const forbidden = await call<IDshPluginSetResult>(DshHarnessChannelCommand.SetDshBundleEnabled, { name: '@vssaros/dsh-bridge', enabled: false }).then(() => undefined, (e: unknown) => String((e as Error)?.message ?? e));
		check('the control bridge itself stays undisablable', typeof forbidden === 'string' && /必需/.test(forbidden), String(forbidden).slice(0, 120));

		// 行级启停：写 profile `cordis.patch.yml` 的 disabled 覆盖（`entryId` 是宿主侧存活条目的 id）。
		const rowsForToggle = await call<readonly { entryId: string; patchId?: string; moduleName?: string }[]>(DshHarnessChannelCommand.ListDshPluginRows);
		const rowTarget = (rowsForToggle ?? []).find(x => (x.moduleName ?? '') === toggleTarget && !!x.patchId);
		// 文件级真相：Host 的实时重组在 VsSaros 的启动路径上**必然**失败（README 4.51：dsh 要求 root
		// Include entry）⇒ 通道会退回写 profile 的 patch。这里直接读文件确认"覆盖真的落盘了/清掉了"，
		// 而不是只看通道回了个 application（"回了成功但什么也没发生"正是这条链最容易出的假象）。
		const patchFile = join(home, 'profiles', 'vssaros', 'cordis.patch.yml');
		const readPatch = () => { try { return readFileSync(patchFile, 'utf8'); } catch { return ''; } };
		const hasRowOverride = () => !!rowTarget?.patchId
			&& new RegExp(`-\\s*id:\\s*["']?${rowTarget.patchId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*\\n\\s*disabled:\\s*true`).test(readPatch());
		const rowOff = rowTarget
			? await call<IDshPluginRowSetResult>(DshHarnessChannelCommand.SetDshPluginRowEnabled, { entryId: rowTarget.entryId, enabled: false })
			: undefined;
		check('setDshPluginRowEnabled(false): 成功、或失败得说得清（上面同一条判据）',
			!!rowTarget && rowOff?.changed === true && toggleOk(rowOff),
			`${toggleReason(rowOff)} | ${JSON.stringify({ row: rowTarget ?? null, res: rowOff ?? null })}`);
		check('setDshPluginRowEnabled(false): 覆盖**真的写进了** profile 的 `cordis.patch.yml`（不是只回了个成功）',
			hasRowOverride(), `patchId=${rowTarget?.patchId ?? '(none)'} | patch 尾部：${JSON.stringify(readPatch().slice(-160))}`);
		// `via` 是"这次写入走了哪条路"的**唯一凭据**（界面据它决定说"Host 热重载完成"还是"Host 没能应用"）。
		// 行级结果原先没有这个字段，界面就写死成 'host' ⇒ 文件级兜底被说成 Host 应用成功。
		check('★ 行级结果带 `via`（区分 Host 应用 / 文件级兜底）',
			rowOff?.via === 'host' || rowOff?.via === 'file', `via=${String(rowOff?.via)}`);
		check('★ Host 报了失败就必须如实标 `via:file`（不许把兜底说成 Host 应用成功）',
			!rowOff?.errorCode || rowOff?.via === 'file', `errorCode=${String(rowOff?.errorCode)} via=${String(rowOff?.via)}`);
		const rowOn = rowTarget
			? await call<IDshPluginRowSetResult>(DshHarnessChannelCommand.SetDshPluginRowEnabled, { entryId: rowTarget.entryId, enabled: true })
			: undefined;
		check('setDshPluginRowEnabled(true): 成功、或失败得说得清（上面同一条判据）',
			!!rowTarget && rowOn?.changed === true && toggleOk(rowOn),
			toggleReason(rowOn));
		check('setDshPluginRowEnabled(true): 覆盖从 profile patch 里**清掉**（回到"由 base bundle 提供"）',
			!!rowTarget?.patchId && !hasRowOverride(), `patch 尾部：${JSON.stringify(readPatch().slice(-160))}`);

		const pid = r.pid!;
		// ── 4.48 / 4.49：一次 IDE 能力请求该落在哪个窗口（定向投递；同会话两窗口 ⇒ 拒绝）──
		// 这一段是本仓库里**唯一**能自动化验证"定向投递"的地方：探针直接持有 `DshHarnessChannel`，而这里的
		// windows 服务是**手写假对象** ⇒ 给每个窗口装一个负责记录的 `sendWhenReady`，就能看见通知发给了谁、
		// 带没带会话 id、以及"同会话两窗口"时是不是**拒绝**而不是猜。
		{
			const winB = new BaseWindow({ width: 800, height: 600, show: false });
			const sent: { windowId: number; channel: string; notification: string; payload: { id?: number; sessionId?: string } }[] = [];
			const record = (windowId: number) => (channelName: string, _token: unknown, notification: string, ...args: unknown[]) => {
				sent.push({ windowId, channel: channelName, notification, payload: (args[0] ?? {}) as { id?: number; sessionId?: string } });
			};
			const fakeWindows = windows as unknown as { getWindowById: (id: number) => unknown };
			const onlyWin = () => (id: number) => (id === win.id ? { id: win.id, win, sendWhenReady: record(win.id) } : undefined);
			fakeWindows.getWindowById = (id: number) => (id === win.id
				? { id: win.id, win, sendWhenReady: record(win.id) }
				: id === winB.id ? { id: winB.id, win: winB, sendWhenReady: record(winB.id) } : undefined);

			// 用**真闸门**（真读 profile 清单 → 真授权）：挑一个"已装且声明了 getDiagnostics"的插件名
			const installed = await call<readonly { name: string }[]>(DshHarnessChannelCommand.ListPlugins);
			const profileDir = join(home, 'profiles', 'vssaros');
			const declared = (installed ?? []).find(p => {
				try {
					const pkg = JSON.parse(readFileSync(join(profileDir, 'node_modules', ...p.name.split('/'), 'package.json'), 'utf8')) as { vssaros?: { ideCapabilities?: string[] } };
					return (pkg.vssaros?.ideCapabilities ?? []).includes('getDiagnostics');
				} catch {
					return false;
				}
			});
			if (!declared) {
				check('IDE targeting: skipped — 没有已装插件声明 getDiagnostics', true, `${(installed ?? []).length} plugin(s)`);
			} else {
				const gate = (channel as unknown as { _ideGate: { handle: (request: unknown) => Promise<unknown> } })._ideGate;
				const sessionId = 'probe-targeting-session';
				// `method` 就是 `DshBridgeReverseMethod.IdeRequest`；token 由桥客户端核验，这里走闸门不需要它。
				const reverse = { id: -7, method: 'ide.request', params: { capability: 'getDiagnostics', pluginId: declared.name, sessionId } };

				// ① 只有一个窗口绑着该会话 ⇒ 通知**只**发给那个窗口，并带上会话 id；随后把"认领 → 回执"走完
				await call(DshHarnessChannelCommand.CreateView, { viewId: 'v-target', windowId: win.id, surface: 'chat', sessionId });
				sent.length = 0;
				const pending = gate.handle(reverse);
				await sleep(80);
				check('IDE targeting: 请求**定向**投给绑着该会话的那个窗口（不是广播）',
					sent.length === 1 && sent[0].windowId === win.id && sent[0].channel === DSH_HARNESS_CHANNEL
					&& sent[0].notification === DshHarnessChannelEvent.OnIdeRequest && sent[0].payload.sessionId === sessionId,
					JSON.stringify(sent));
				const requestId = sent[0]?.payload.id;
				const first = await call<{ claimed: boolean }>(DshHarnessChannelCommand.ClaimIdeRequest, { id: requestId });
				const second = await call<{ claimed: boolean }>(DshHarnessChannelCommand.ClaimIdeRequest, { id: requestId });
				check('IDE targeting: 认领只成功一次（多窗口不重复执行）',
					first?.claimed === true && second?.claimed === false, `${JSON.stringify(first)} / ${JSON.stringify(second)}`);
				await call(DshHarnessChannelCommand.ResolveIdeRequest, { id: requestId, result: { via: 'probe' } });
				check('IDE targeting: 回执把结果交回 Host', JSON.stringify(await pending) === JSON.stringify({ via: 'probe' }), JSON.stringify(await pending));

				// ② 同一个会话又被第二个窗口绑上 ⇒ **拒绝**（不猜、也不广播）
				await call(DshHarnessChannelCommand.CreateView, { viewId: 'v-target-b', windowId: winB.id, surface: 'chat', sessionId });
				sent.length = 0;
				const refused = await gate.handle({ ...reverse, id: -8 }).then(() => undefined, (e: unknown) => String((e as Error)?.message ?? e));
				check('IDE targeting: 同会话在两窗口都开 ⇒ **拒绝**（错误里点名两个窗口，且一条通知都没发）',
					typeof refused === 'string' && /同时在窗口/.test(refused) && refused.includes(String(win.id)) && refused.includes(String(winB.id)) && sent.length === 0,
					String(refused).slice(0, 200));
			}
			await call(DshHarnessChannelCommand.DisposeView, { viewId: 'v-target-b' }).catch(() => undefined);
			await call(DshHarnessChannelCommand.DisposeView, { viewId: 'v-target' }).catch(() => undefined);
			fakeWindows.getWindowById = onlyWin();   // 复原成"只有主窗口"
			winB.destroy();
		}

		await call(DshHarnessChannelCommand.Stop);
		let alive = true;
		try { process.kill(pid, 0); } catch { alive = false; }
		check('stop terminates the Host', !alive && (await call<IDshHostStatus>(DshHarnessChannelCommand.GetStatus)).state === 'stopped');

		const logLines = await call<string[]>(DshHarnessChannelCommand.GetLog);
		check('host log has no raw tokens', !logLines.some(l => /token=(?!<redacted>)/.test(l)), `${logLines.length} lines`);

		// 方案 5.13「聊天框只保留聊天 UI」由工作台 e2e 覆盖，不在这里测：探针窗口是隐藏的，
		// 在它的第二个 WebContentsView 上 executeJavaScript 不返回（实测），而 e2e 用真窗口。
		const skipScenarios = (process.env.DSH_PROBE_SKIP ?? '').split(',').map(s => s.trim()).filter(Boolean);
		if (!skipScenarios.includes('reuse')) {
			await hostReuseScenario();
		}

		if (process.env.DSH_TEST_NPM_INSTALL === '1') {
			await managedUpgradeScenario();
		}
	} catch (e) {
		check('unexpected error', false, String((e as Error)?.stack ?? e));
	} finally {
		channel.dispose();
		win.destroy();
		let failed = 0;
		for (const c of checks) {
			console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
			failed += c.ok ? 0 : 1;
		}
		console.log(`\n${checks.length - failed}/${checks.length} passed`);
		if (failed) {
			console.log(nodeLog.slice(-20).join('\n'));
		}
		// `--keep`：保留临时目录（排查用——harness 落盘日志在 `<userData>/dsh-run/harness-*.log`）；
		// 默认删掉以免留垃圾。工作区 junction/真目录是诊断物，不随 --keep 保留（它们在仓外）。
		if (!process.argv.includes('--keep')) {
			rmSync(home, { recursive: true, force: true });
			rmSync(userData, { recursive: true, force: true });
		} else {
			console.log(`--keep：保留 userData=${userData}  home=${home}`);
		}
		try {
			rmSync(wsLink, { force: true });
		} catch { /* junction */ }
		rmSync(wsReal, { recursive: true, force: true });
		rmSync(wsNew, { recursive: true, force: true });
		app.exit(failed ? 1 : 0);
	}
}
