/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { Emitter } from '../../../../../base/common/event.js';
import { IUpdateService, State, UpdateType } from '../../../../../platform/update/common/update.js';
import { UpdateChannel } from '../../../../../platform/update/common/updateIpc.js';
import { classifyDesktopUpdateFailure, desktopUpdatePresentation, DSH_DESKTOP_UPDATE_IPC, IDesktopUpdatePresentation, mergeDesktopUpdateReplica } from '../../common/dshDesktopUpdate.js';
import { validatePageCommand } from '../../common/dshPageBridgeProtocol.js';
import { DshDesktopUpdateController } from '../../electron-main/dshDesktopUpdateController.js';

const update = { version: 'commit', productVersion: '2.0.0', url: 'https://example.test/setup.exe' };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

suite('统一 Desktop 更新桥', () => {
	test('命令面板和齿轮菜单的更新 IPC 同样进入统一确认，后台查询不弹窗', async () => {
		const emitter = new Emitter<State>();
		const calls: string[] = [];
		const service: IUpdateService = {
			_serviceBrand: undefined, state: State.Idle(UpdateType.Setup), onStateChange: emitter.event,
			async checkForUpdates(explicit) { calls.push(`check:${explicit}`); },
			async downloadUpdate() { calls.push('must not download'); },
			async applyUpdate() { calls.push('must not install'); },
			async quitAndInstall() { calls.push('must not restart'); },
			async isLatestVersion() { return true; }, async _applySpecificUpdate() { }, async setInternalOrg() { },
		};
		try {
			const channel = new UpdateChannel(service, async () => { calls.push('open'); });
			for (const command of ['checkForUpdates', 'downloadUpdate', 'applyUpdate', 'quitAndInstall']) {
				await channel.call(undefined, command, true);
			}
			await channel.call(undefined, 'checkForUpdates', false);
			await channel.call(undefined, '_getInitialState');
			assert.deepStrictEqual(calls, ['open', 'open', 'open', 'open', 'check:false']);
		} finally { emitter.dispose(); }
	});

	test('原生状态映射下载、校验、安装和就绪，未知总量不伪造进度', () => {
		assert.deepStrictEqual([
			desktopUpdatePresentation(State.CheckingForUpdates(true)).phase,
			desktopUpdatePresentation(State.AvailableForDownload(update)).phase,
			desktopUpdatePresentation(State.Downloading(update, true, false, 25, 100)).percent,
			desktopUpdatePresentation(State.Downloading(update, true, false, 25)).percent,
			desktopUpdatePresentation({ ...State.Downloading(update, true, false), verifying: true }).phase,
			desktopUpdatePresentation(State.Updating(update, true, 2, 4)).percent,
			desktopUpdatePresentation(State.Ready(update, true, false)).phase,
		], ['checking', 'available', 25, undefined, 'verifying', 50, 'ready']);
	});

	test('网络、磁盘、权限、占用和安装准备错误正确分类', () => {
		assert.deepStrictEqual([
			classifyDesktopUpdateFailure('ECONNRESET', 'checking'),
			classifyDesktopUpdateFailure('ETIMEDOUT', 'downloading'),
			classifyDesktopUpdateFailure('ENOSPC', 'downloading'),
			classifyDesktopUpdateFailure('EPERM', 'downloading'),
			classifyDesktopUpdateFailure('EBUSY', 'downloading'),
			classifyDesktopUpdateFailure('tasks-changed', 'installing'),
			classifyDesktopUpdateFailure('tasks-unavailable', 'ready'),
			classifyDesktopUpdateFailure('stop-failed', 'installing'),
		], ['check-network', 'download-network', 'download-space', 'download-permission', 'download-busy', 'tasks-changed', 'tasks-unavailable', 'stop-failed']);
	});

	test('旧 renderer 快照不能覆盖 app 真源及重启范围', () => {
		const snapshot = { seq: 5, presentation: { phase: 'ready' as const }, app: { current: '1.0.0', action: 'upgrade' as const, phase: 'downloaded' as const, manual: false } };
		const state = mergeDesktopUpdateReplica({ at: 1, app: { current: '0.0.0', action: 'unknown' }, runtime: {}, bundled: [], assets: [] }, snapshot, 10);
		assert.deepStrictEqual({ app: state.app, seq: state.seq, restart: state.restart?.scope }, { app: snapshot.app, seq: 10, restart: 'ide' });
	});

	test('官方桥无参命令不能接受 URL、文件、窗口或 force', () => {
		for (const method of ['desktopUpdateStatus', 'desktopUpdateOpen']) {
			assert.deepStrictEqual(validatePageCommand({ method }), { method });
			for (const key of ['url', 'file', 'windowId', 'force']) {
				assert.strictEqual(validatePageCommand({ method, [key]: 'x' }), undefined);
			}
		}
	});

	test('实际 preload 官方 API：status 无副作用、open 固定命令、subscribe 可注销且不泄露 Electron 事件', async () => {
		interface Bridge {
			protocolVersion: number;
			updates: { status(): Promise<IDesktopUpdatePresentation>; open(): Promise<void>; subscribe(listener: (state: IDesktopUpdatePresentation) => void): () => void };
		}
		const source = readFileSync('src/vs/sessions/contrib/dshHarness/electron-browser/preload-dshView.ts', 'utf8');
		const start = source.indexOf("contextBridge.exposeInMainWorld('dshDesktop',");
		const end = source.indexOf("contextBridge.exposeInMainWorld('vssarosDshPrompt',", start);
		assert.ok(start > 0 && end > start);
		const events = new EventEmitter();
		const calls: object[] = [];
		let exposed: Bridge | undefined;
		const unload = new Set<() => void>();
		vm.runInNewContext(transpileModule(source.slice(start, end), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, {
			contextBridge: { exposeInMainWorld: (_name: string, api: Bridge) => { exposed = api; } },
			invoke: async (payload: object) => { calls.push(payload); return { phase: 'idle' }; },
			ipcRenderer: { on: (name: string, callback: (...args: object[]) => void) => events.on(name, callback), removeListener: (name: string, callback: (...args: object[]) => void) => events.removeListener(name, callback) },
			window: { addEventListener: (_name: string, callback: () => void) => unload.add(callback), removeEventListener: (_name: string, callback: () => void) => unload.delete(callback) },
		});
		assert.strictEqual(exposed?.protocolVersion, 1);
		const bridge = exposed!;
		await bridge.updates.status();
		await bridge.updates.open();
		assert.strictEqual(JSON.stringify(calls), JSON.stringify([{ method: 'desktopUpdateStatus' }, { method: 'desktopUpdateOpen' }]));
		const received: IDesktopUpdatePresentation[] = [];
		const dispose = bridge.updates.subscribe(state => received.push(state));
		events.emit(DSH_DESKTOP_UPDATE_IPC, { sender: 'must not escape' }, { phase: 'available', version: '2.0.0' });
		dispose();
		events.emit(DSH_DESKTOP_UPDATE_IPC, {}, { phase: 'ready' });
		assert.deepStrictEqual({ received, listeners: events.listenerCount(DSH_DESKTOP_UPDATE_IPC), unload: unload.size }, { received: [{ phase: 'available', version: '2.0.0' }], listeners: 0, unload: 0 });
	});

	test('查询快照不检查不弹窗，后台状态也广播，订阅注销后不再接收', async () => {
		const emitter = new Emitter<State>();
		const calls: string[] = [];
		const service = {
			state: State.Idle(UpdateType.Setup) as State, onStateChange: emitter.event,
			async checkForUpdates() { calls.push('check'); }, async downloadUpdate() { calls.push('download'); },
			async applyUpdate() { calls.push('install'); }, async quitAndInstall() { calls.push('restart'); },
		};
		const controller = new DshDesktopUpdateController(service, async () => { calls.push('dialog'); return { response: 1, checkboxChecked: false }; }, () => { }, { currentVersion: '1.0.0' });
		try {
			const first = controller.snapshot;
			const phases: string[] = [];
			const listener = controller.onDidChange(snapshot => phases.push(snapshot.presentation.phase));
			service.state = State.AvailableForDownload(update);
			emitter.fire(service.state);
			assert.ok(controller.snapshot.seq > first.seq);
			listener.dispose();
			service.state = State.Downloading(update, false, false, 50, 100);
			emitter.fire(service.state);
			assert.deepStrictEqual({ calls, phases, percent: controller.snapshot.presentation.percent, manual: controller.snapshot.app.manual }, { calls: [], phases: ['available'], percent: 50, manual: false });
		} finally { controller.dispose(); emitter.dispose(); }
	});

	test('已下载更新准备失败后可直接重试安装，不重新检查或下载', async () => {
		const emitter = new Emitter<State>();
		let failed = true;
		const calls: string[] = [];
		const service = {
			state: State.Downloaded(update, true, false) as State, onStateChange: emitter.event,
			async checkForUpdates() { calls.push('must not check'); },
			async downloadUpdate() { calls.push('must not download'); },
			async applyUpdate() { calls.push('apply'); if (failed) { throw new Error('tasks-changed: running'); } },
			async quitAndInstall() { calls.push('must not restart'); },
		};
		const controller = new DshDesktopUpdateController(service, async () => ({ response: 0, checkboxChecked: false }), () => { });
		try {
			await controller.checkForUpdates();
			assert.strictEqual(controller.snapshot.presentation.failure, 'tasks-changed');
			failed = false;
			await controller.checkForUpdates();
			assert.deepStrictEqual(calls, ['apply', 'apply']);
		} finally { controller.dispose(); emitter.dispose(); }
	});

	test('后台检查不下载不弹窗，控制器安装准备失败保留错误分类及可重读详情', async () => {
		const emitter = new Emitter<State>();
		const calls: string[] = [];
		const service = {
			state: State.Idle(UpdateType.Setup) as State, onStateChange: emitter.event,
			async checkForUpdates(explicit: boolean) { calls.push(`check:${explicit}`); },
			async downloadUpdate() { throw new Error('tasks-unavailable: bridge down'); },
			async applyUpdate() { }, async quitAndInstall() { },
		};
		const controller = new DshDesktopUpdateController(service, async () => { calls.push('dialog'); return { response: 0, checkboxChecked: false }; }, () => { });
		try {
			await controller.checkForUpdates(false);
			assert.deepStrictEqual(calls, ['check:false']);
			service.state = State.AvailableForDownload(update);
			emitter.fire(service.state);
			await controller.checkForUpdates();
			await flush();
			assert.deepStrictEqual({ phase: controller.snapshot.presentation.phase, failure: controller.snapshot.presentation.failure, error: controller.snapshot.app.error }, { phase: 'error', failure: 'tasks-unavailable', error: 'tasks-unavailable: bridge down' });
		} finally { controller.dispose(); emitter.dispose(); }
	});
});
