/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「启动只露桌面窗口，不许 IDE 闪一下」的守卫（2026-10-31）。
 *
 * 真机（打包版 2026-10-31 09:50:23）：
 *   `[windowsManager] wantsHiddenStart=false（isBuilt=true, isEmbeddedApp=true, hasTarget=true）`
 * ⇒ IDE 主窗口**可见地**建出来，几秒后桌面窗口就绪才把它藏回去 ⇒ 用户看到 IDE 闪一下 ✗✗
 *   （对比：同日 10:01:57 那次 `hasTarget=false` ⇒ 隐藏 ✓ 没有闪）。
 *
 * 根因：`_wantsHiddenStart()` 里 `hasTarget`（文件 / 文件夹 / `--diff` / `--merge`）会**强制不隐藏**，
 *   而本 app 的主界面就是桌面窗口 ⇒ 带目标也应该继续藏着（目标照样被打开，只是发生在桌面窗口那边）。
 *
 * 修法：读取 `sessions.dshHarness.openDesktopOnStartup`（默认 `true`）——
 *   只要它没被用户关掉，**带目标也不露 IDE**；只有用户关掉它时才回到"带目标就露 IDE"的老语义。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshDesktopOnlyStart
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDesktopHostRunning } from '../../common/dshDesktopSessionStart.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisablementReason, State, UpdateType } from '../../../../../platform/update/common/update.js';
import { DshDesktopUpdateController } from '../../electron-main/dshDesktopUpdateController.js';

const WMS = 'src/vs/platform/windows/electron-main/windowsMainService.ts';
const CONTRIB = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts';
const APP = 'src/vs/code/electron-main/app.ts';
const SHELL = 'src/vs/sessions/electron-browser/dshDesktop.ts';
const LIFECYCLE = 'src/vs/platform/lifecycle/electron-main/lifecycleMainService.ts';
const CHANNEL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts';
const CONTROLLER = 'src/vs/sessions/contrib/dshHarness/electron-main/dshDesktopUpdateController.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 源码守卫必须排除注释，否则注释里解释的旧写法会造成假红。 */
function code(rel: string): string {
	return read(rel)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split(/\r?\n/)
		.filter(line => !/^\s*\/\//.test(line))
		.join('\n');
}

suite('启动只露桌面窗口（不许 IDE 闪一下）', () => {

	test('1) 判据必须读"启动即开桌面窗口"设置，且它没被关掉时带目标也隐藏', () => {
		const src = read(WMS);
		const at = src.indexOf('private _wantsHiddenStart(): boolean {');
		assert.ok(at > 0, '找不到 _wantsHiddenStart');
		const body = src.slice(at, at + 3000);
		assert.match(body, /sessions\.dshHarness\.openDesktopOnStartup/,
			'必须读 `sessions.dshHarness.openDesktopOnStartup`（否则带目标时还是会露 IDE）');
		assert.match(body, /getValue<boolean>\('sessions\.dshHarness\.openDesktopOnStartup'\)\s*!==\s*false/,
			'读不到配置时要按"开着"处理（`!== false`）⇒ 默认不露 IDE');
		// ⚠ 关键表达式：hidden = (isBuilt||isEmbedded) && (openDesktopOnStartup || !hasTarget)
		assert.match(body, /const hidden = \(isBuilt \|\| isEmbedded\) && \(openDesktopOnStartup \|\| !hasTarget\);/,
			'隐藏判据必须是 `(isBuilt||isEmbedded) && (openDesktopOnStartup || !hasTarget)`');
		assert.ok(!/const hidden = !hasTarget && \(isBuilt \|\| isEmbedded\);/.test(body),
			'旧的 `!hasTarget && …` 判据不许回来（那正是 IDE 闪一下的根因）');
	});

	test('2) 日志必须带上 openDesktopOnStartup（下次再闪能一眼看出是哪个判据没成立）', () => {
		const src = read(WMS);
		assert.match(src, /wantsHiddenStart=\$\{hidden\}（isBuilt=\$\{isBuilt\}, isEmbeddedApp=\$\{isEmbedded\}, hasTarget=\$\{hasTarget\}, openDesktopOnStartup=\$\{openDesktopOnStartup\}）/,
			'日志要打印 hasTarget 与 openDesktopOnStartup 两个判据');
	});

	test('3) 该设置默认必须是 true（否则默认行为还是露 IDE）', () => {
		const src = read(CONTRIB);
		const at = src.indexOf('[DshHarnessSettings.OpenDesktopOnStartup]: {');
		assert.ok(at > 0, '找不到 OpenDesktopOnStartup 的配置声明');
		assert.match(src.slice(at, at + 300), /default: true/, '该设置默认必须是 true');
	});

	test('4) app 启动项必须在创建窗口之前显式开启隐藏启动', () => {
		const src = read('scripts/start-dev-app.mjs');
		const at = src.indexOf('const child = spawn(EXE, args, {');
		assert.ok(at > 0, '找不到 app 启动入口');
		const env = src.slice(at, src.indexOf('\n});', at));
		assert.match(env, /VSSAROS_START_HIDDEN: '1'/);
	});

	test('5) B 方案：desktop-only 启动默认开启，且启动入口必须能不创建 IDE 主窗口', () => {
		const app = read(APP);
		assert.match(app, /DshDesktopWindowMainService/, '启动入口必须接入主进程 desktop 开窗服务');
		assert.match(app, /VSSAROS_DESKTOP_ONLY/, '必须有可回退的进程级开关');
		assert.match(app, /await this\.dshDesktopWindowMainService\.openDesktopWindow\(\);/, 'B 分支必须直接打开 desktop 窗口');
		assert.match(app, /return \[\];/, 'B 分支必须返回空 CodeWindow 列表（不创建 IDE 主窗口）');
		const contrib = read(CONTRIB);
		assert.match(contrib, /\[DshHarnessSettings\.DesktopOnlyStartup\]/, '缺少 desktop-only 开关声明');
		assert.match(contrib, /default: true/, 'desktop-only 开关必须默认开启');
	});

	test('6) B 方案轻量壳必须保留 dsh 官方左侧栏（不许 chatOnlyUi=true）', () => {
		const shell = code(SHELL);
		assert.match(shell, /chatOnlyUi: false/, 'B 方案是主界面而非 IDE 内嵌聊天框，必须保留官方侧栏/右栏');
		assert.ok(!/chatOnlyUi:\s*true/.test(shell), 'chatOnlyUi=true 会注入 CSS 隐藏 `[data-slot="sidebar"]` ✗');
		assert.match(shell, /dshOwnWindow: true/, '自主窗口必须让 dsh 自己决定明暗');
		assert.match(shell, /isolatedPool: true/, '桌面视图必须使用独立网络分区');
		assert.match(shell, /\[data-vssaros-wb-tabstrip\]/, '必须等待带官方侧栏的换皮锚点');
		assert.match(shell, /\[data-vssaros-guide-root\]/, '必须兼容新版 guide 根节点锚点');
	});

	test('7) B 壳必须先建视图槽、后等 Host，并单次等待换皮锚点', () => {
		const shell = code(SHELL);
		const createAt = shell.indexOf('DshHarnessChannelCommand.CreateView');
		const bootstrapAt = shell.indexOf('DshHarnessChannelCommand.Bootstrap');
		const waitAt = shell.indexOf('DshHarnessChannelCommand.WaitViewSelector');
		assert.ok(createAt > 0 && bootstrapAt > createAt && waitAt > bootstrapAt,
			'顺序必须是 CreateView → Bootstrap → WaitViewSelector：视图槽可与 Host 启动并行准备');
		assert.match(shell, /const skinSelector = '\[data-vssaros-wb-tabstrip\],\[data-vssaros-guide-root\]'/,
			'两个换皮锚点必须用一次并集查询等待，不许串行 1.5s + 7.5s');
		assert.match(shell, /timeoutMs: 5000/, '换皮等待必须有 5s 有界预算');
		assert.ok(!/timeoutMs: 7500/.test(shell), '旧的 7.5s 串行等待不许回来');
		assert.match(shell, /DshHarnessChannelCommand\.DisposeView/, 'Bootstrap 失败时必须清理预建视图槽');
		assert.match(shell, /viewVisible = true/, '换皮就绪/超时后才允许显示视图，避免焦点事件提前露出默认样式');
	});

	test('Bootstrap 兑现 error 状态时保留失败原因，不进入皮肤等待或显示空视图', async () => {
		const events: string[] = [];
		const message = 'EBUSY: copyfile mermaid/phase2.layering.spec.d.ts';
		const ok = await ensureDesktopHostRunning(async () => ({ state: 'error', error: message }), async error => {
			events.push('disposeView', error);
		});
		if (ok) { events.push('waitViewSelector', 'showView'); }
		assert.strictEqual(ok, false);
		assert.deepStrictEqual(events, ['disposeView', message]);
	});

	test('Bootstrap reject 与兑现 error 共用失败处理，且等待清理完成后才返回', async () => {
		const events: string[] = [];
		const ok = await ensureDesktopHostRunning(async () => { throw new Error('IPC disconnected'); }, async message => {
			await Promise.resolve();
			events.push('disposeView', message);
		});
		assert.strictEqual(ok, false);
		assert.deepStrictEqual(events, ['disposeView', 'IPC disconnected']);
	});

	test('只有 running 且无错误才放行，其它状态全部保留失败提示', async () => {
		assert.strictEqual(await ensureDesktopHostRunning(async () => ({ state: 'running' }), async () => {
			assert.fail('running 不应清理视图');
		}), true);
		for (const state of ['starting', 'stopping', 'stopped', 'error']) {
			let message = '';
			assert.strictEqual(await ensureDesktopHostRunning(async () => ({ state }), async error => {
				message = error;
			}), false);
			assert.ok(message.includes(state));
		}
		let message = '';
		assert.strictEqual(await ensureDesktopHostRunning(async () => ({ state: 'running', error: 'startup failed' }), async error => {
			message = error;
		}), false);
		assert.strictEqual(message, 'startup failed');
	});

	test('B 壳实际接线：检查 Bootstrap 结果之后才允许等待皮肤及显示视图', () => {
		const shell = code(SHELL);
		const at = shell.indexOf('const hostReady = await ensureDesktopHostRunning(');
		const guardAt = shell.indexOf('if (!hostReady)', at);
		const waitAt = shell.indexOf('DshHarnessChannelCommand.WaitViewSelector', at);
		assert.ok(at > 0 && guardAt > at && waitAt > guardAt);
		assert.match(shell.slice(guardAt, waitAt), /if \(!hostReady\) \{\s*return;/);
		const failure = shell.slice(at, guardAt);
		assert.match(failure, /viewVisible = false/);
		assert.match(failure, /DshHarnessChannelCommand.DisposeView/);
		assert.match(failure, /showBooting\(`dsh 运行环境启动失败：\$\{message\}/);
		assert.match(failure, /console\.error/);
	});

	test('8) 关 IDE 不许带走 B 方案 desktop 窗口', () => {
		const lifecycle = code(LIFECYCLE);
		assert.match(lifecycle, /private hasSurvivingAppWindow\(\): boolean/,
			'生命周期层必须有「还有非 CodeWindow 应用窗口」判据');
		assert.match(lifecycle, /getAllWindowsExcludingOffscreen\(\)/,
			'判据必须排除 offscreen 窗口，只看真正的应用窗口');
		const at = lifecycle.indexOf('if (this.windowCounter === 0 && (!isMacintosh || this._quitRequested))');
		assert.ok(at > 0, '找不到最后一个 CodeWindow 关闭的 shutdown 判据');
		const body = lifecycle.slice(at, at + 800);
		assert.match(body, /!this\._quitRequested && this\.hasSurvivingAppWindow\(\)/,
			'非真退出且 desktop 仍存活时必须保住应用');
		assert.match(body, /fireOnWillShutdown\(ShutdownReason\.QUIT\)/,
			'真退出/没有其它窗口时仍必须保留原 shutdown 路径');
		assert.ok(!/if \(!this\._quitRequested && this\.hasSurvivingAppWindow\(\)\) \{\s*this\.fireOnWillShutdown/.test(body),
			'不许在 desktop 仍存活时直接 fireOnWillShutdown（会 dispose 掉 desktop ✗）');

		const channel = code(CHANNEL);
		assert.match(channel, /add\(getActiveDshDesktopWindow\(\)\)/,
			'关窗事实里的 desktop 计数必须把 B 方案独立窗口算进去，避免误判为最后一个界面');
	});

	test('桌面菜单的更新反馈只走 dsh 通知卡片，不许弹 IDE messagebox', () => {
		const app = code(APP);
		assert.match(app, /checkForUpdates: \(\) => desktopUpdateController\.checkForUpdates\(\)/);
		assert.match(app, /desktopUpdates: desktopUpdateController/);
		assert.ok(!/showMessageBox\(options, getActiveDshDesktopWindow\(\)\)/.test(app),
			'控制器不许再注入 showMessageBox（更新提示只用 dsh 侧通知卡片）✗');
		assert.match(app, /if \(this\.productService\.quality !== 'saros'\) \{\s*this\._register\(new NotAvailableUpdateDialog/,
			'saros 必须跳过「当前没有可用更新」的原生对话框 ✗');
		const controller = code(CONTROLLER);
		assert.ok(!/showMessageBox|prompt\(/.test(controller), '控制器里不许残留原生弹窗调用 ✗');
		assert.match(controller, /async confirmUpdate\(\)/, '卡片按钮必须能直接推进下载/安装/重启 ✗');
	});

	test('9) 启动 UI 必须显示阶段说明与耗时，并接上主进程的细粒度进度', () => {
		const shell = code(SHELL);
		assert.match(shell, /DshHarnessChannelEvent\.OnDidProgress/,
			'不订阅进度事件就只剩一句「正在准备运行环境…」，用户看不出卡在哪');
		assert.match(shell, /boot\.note\(line\)/);
		for (const stage of ['shell', 'view', 'runtime', 'ui']) {
			assert.match(shell, new RegExp(`beginStage\\('${stage}'\\)`), `${stage} 阶段必须显式记时`);
		}
		assert.match(shell, /boot\.finish\('启动完成'\)/, '完成时必须冻结总耗时并展示汇总');
		assert.match(shell, /boot\.failCurrent\(message\)/, '失败时必须标出卡在哪个阶段');
		assert.match(shell, /logBootSummary\(\)/, '各阶段耗时还要落日志，面板消失后仍可回溯');
		const html = read('src/vs/sessions/electron-browser/dshDesktop.html');
		assert.match(html, /boot-stage-detail/, '每个阶段必须有详细说明的容器');
		assert.match(html, /boot-stage-time/, '每个阶段必须显示耗时');
		assert.match(html, /boot-steps/, '进度子步骤必须逐条显示');
	});
});

suite('独立桌面窗口更新反馈（只用 dsh 通知卡片）', () => {
	const disposables: Array<{ dispose(): void }> = [];
	teardown(() => {
		for (const disposable of disposables.splice(0)) {
			disposable.dispose();
		}
	});

	const update = { version: 'new-commit', productVersion: '9.9.9', url: 'https://example.test/setup.exe' };
	const flush = () => new Promise<void>(resolve => setImmediate(resolve));

	function fixture(initial: State = State.Idle(UpdateType.Setup)) {
		const changes = new Emitter<State>();
		disposables.push(changes);
		const calls: string[] = [];
		const phases: string[] = [];
		const service = {
			state: initial,
			onStateChange: changes.event,
			async checkForUpdates(explicit: boolean) {
				calls.push(`check:${explicit}`);
				setState(State.CheckingForUpdates(explicit));
			},
			async downloadUpdate(explicit: boolean) {
				calls.push(`download:${explicit}`);
				setState(State.Downloading(update, explicit, false));
			},
			async applyUpdate() { calls.push('apply'); },
			async quitAndInstall() { calls.push('restart'); },
		};
		function setState(state: State): void {
			service.state = state;
			changes.fire(state);
		}
		const controller = new DshDesktopUpdateController(service, message => calls.push(`error:${message}`), { currentVersion: '1.0.0' });
		disposables.push(controller);
		disposables.push(controller.onDidChange(snapshot => phases.push(`${snapshot.presentation.phase}${snapshot.app.manual ? ':manual' : ''}`)));
		return { controller, service, calls, phases, setState };
	}

	test('显式检查无更新：只推给卡片「已是最新版本」，不弹 messagebox', async () => {
		const f = fixture();
		await f.controller.checkForUpdates();
		f.setState(State.Idle(UpdateType.Setup, undefined, true));
		await flush();
		assert.deepStrictEqual(f.calls, ['check:true']);
		assert.strictEqual(f.controller.snapshot.app.phase, 'up-to-date');
		assert.strictEqual(f.controller.snapshot.app.manual, true);
		assert.ok(f.phases.includes('checking:manual'));
	});

	test('检查失败：错误只进快照和日志，不再弹原生框', async () => {
		const f = fixture();
		await f.controller.checkForUpdates();
		f.setState(State.Idle(UpdateType.Setup, 'connection refused'));
		await flush();
		assert.strictEqual(f.controller.snapshot.presentation.phase, 'error');
		assert.strictEqual(f.controller.snapshot.app.error, 'connection refused');
		assert.strictEqual(f.controller.snapshot.app.manual, true);
	});

	test('发现新版只推 available，卡片点「更新」才下载', async () => {
		const f = fixture();
		await f.controller.checkForUpdates();
		f.setState(State.AvailableForDownload(update));
		await flush();
		assert.deepStrictEqual(f.calls, ['check:true']);
		assert.strictEqual(f.controller.snapshot.presentation.phase, 'available');
		await f.controller.confirmUpdate();
		assert.deepStrictEqual(f.calls, ['check:true', 'download:true']);
	});

	test('安装完成只推 ready，重启必须再由卡片按钮确认', async () => {
		const f = fixture(State.AvailableForDownload(update));
		await f.controller.confirmUpdate();
		f.setState(State.Downloading(update, true, false, 100, 200));
		f.setState(State.Downloaded(update, true, false));
		f.setState(State.Updating(update, true));
		f.setState(State.Ready(update, true, false));
		await flush();
		assert.deepStrictEqual(f.calls, ['download:true']);
		assert.strictEqual(f.controller.snapshot.restartReady, true);
		assert.strictEqual(f.controller.snapshot.presentation.phase, 'ready');
		assert.strictEqual(f.controller.snapshot.app.phase, 'downloaded');
		await f.controller.confirmUpdate();
		assert.deepStrictEqual(f.calls, ['download:true', 'restart']);
	});

	test('已下载状态：卡片「重新启动并安装」直接安装', async () => {
		const f = fixture(State.Downloaded(update, true, false));
		await f.controller.confirmUpdate();
		assert.deepStrictEqual(f.calls, ['apply']);
	});

	test('禁用 / 未初始化也只给卡片状态，不弹框', async () => {
		for (const state of [State.Disabled(DisablementReason.RunningAsAdmin), State.Uninitialized]) {
			const f = fixture(state);
			await f.controller.checkForUpdates();
			assert.strictEqual(f.controller.snapshot.app.manual, true);
			assert.ok(f.controller.snapshot.app.error || f.controller.snapshot.app.phase === 'unsupported' || f.controller.snapshot.app.phase === 'idle');
		}
	});

	test('后台检查不下载，也不产生手动反馈', async () => {
		const f = fixture();
		await f.controller.checkForUpdates(false);
		f.setState(State.AvailableForDownload(update));
		await flush();
		assert.deepStrictEqual(f.calls, ['check:false']);
		assert.strictEqual(f.controller.snapshot.app.manual, false);
		assert.strictEqual(f.controller.snapshot.presentation.phase, 'available');
	});

	test('重复点「更新」不会重复下载', async () => {
		const f = fixture(State.AvailableForDownload(update));
		await Promise.all([f.controller.confirmUpdate(), f.controller.confirmUpdate()]);
		assert.deepStrictEqual(f.calls, ['download:true']);
	});

	test('卡片「重试」：下载失败重做下载，空闲状态重新检查', async () => {
		const f = fixture(State.AvailableForDownload(update));
		let fail = true;
		f.service.downloadUpdate = async () => {
			if (fail) { fail = false; throw new Error('network down'); }
			f.calls.push('download:true');
		};
		await f.controller.confirmUpdate();
		assert.strictEqual(f.controller.snapshot.presentation.phase, 'error');
		assert.strictEqual(f.controller.snapshot.app.error, 'network down');
		await f.controller.retry();
		assert.deepStrictEqual(f.calls, ['error:network down', 'download:true']);

		const g = fixture();
		await g.controller.retry();
		assert.deepStrictEqual(g.calls, ['check:true']);
	});

	test('原生检查被跳过或抛错：失败原因仍由卡片可读', async () => {
		const f = fixture();
		f.service.checkForUpdates = async () => { };
		await f.controller.checkForUpdates();
		assert.strictEqual(f.controller.snapshot.app.error, '更新检查未启动，请稍后重试。');
		f.service.checkForUpdates = async () => { throw new Error('IPC unavailable'); };
		await f.controller.checkForUpdates();
		assert.strictEqual(f.controller.snapshot.presentation.phase, 'error');
		assert.strictEqual(f.controller.snapshot.app.error, 'IPC unavailable');
		assert.ok(f.calls.includes('error:更新检查未启动，请稍后重试。'));
		assert.ok(f.calls.includes('error:IPC unavailable'));
	});
});
