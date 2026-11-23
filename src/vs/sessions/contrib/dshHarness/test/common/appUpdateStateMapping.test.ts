/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「平台 12 态 → app 更新 8 相」映射表的行为守卫（2026-11-23）。
 *
 * 重点钉住三件会静默出错的事：
 *   ① 普通 `Idle` 返回 `undefined` ⇒ 不迁移，否则会把用户还没点「更新」的 `available` 冲掉；
 *   ② `Disabled` 必须是 `unsupported`（不是 `error`），文案要指向手动覆盖安装；
 *   ③ 拿不到总字节数时事件里没有 `percent` ⇒ 页面走不确定进度条，不残留上一轮假进度。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs appUpdateStateMapping
 */

import assert from 'assert';
import { DisablementReason, IUpdate, State, StateType, UpdateType } from '../../../../../platform/update/common/update.js';
import { APP_UPDATE_MAPPED_STATE_TYPES, mapUpdateServiceState } from '../../common/appUpdateStateMapping.js';
import { initialAppUpdateStatus, reduceAppUpdateStatus } from '../../common/appUpdateState.js';

const update = (version: string, productVersion?: string): IUpdate =>
	({ version, ...(productVersion ? { productVersion } : {}) });

suite('dshHarness / 平台 12 态 → app 更新 8 相（穷尽映射表）', () => {

	test('覆盖清单：平台 StateType 一个不少', () => {
		const expected = [
			StateType.Uninitialized, StateType.Idle, StateType.Disabled,
			StateType.CheckingForUpdates, StateType.AvailableForDownload, StateType.Downloading,
			StateType.Downloaded, StateType.Updating, StateType.Ready, StateType.Overwriting,
			StateType.Restarting,
		];
		assert.strictEqual(expected.length, 11, '平台 StateType 共 11 个（含 Uninitialized）');
		assert.deepStrictEqual(
			[...APP_UPDATE_MAPPED_STATE_TYPES].sort(),
			[...expected].sort(),
			'表里缺/多状态 ⇒ 平台新增状态会静默停在上一相 ✗',
		);
	});

	test('不迁移的几支：Uninitialized / 普通 Idle', () => {
		assert.strictEqual(mapUpdateServiceState(State.Uninitialized), undefined);
		assert.strictEqual(mapUpdateServiceState(State.Idle(UpdateType.Setup)), undefined);
	});

	test('Idle 的两种显式结论：error / notAvailable', () => {
		assert.deepStrictEqual(mapUpdateServiceState(State.Idle(UpdateType.Setup, '网络错误')), { type: 'error', message: '网络错误' });
		assert.deepStrictEqual(mapUpdateServiceState(State.Idle(UpdateType.Setup, undefined, true)), { type: 'not-available' });
		// error 优先于 notAvailable
		assert.deepStrictEqual(mapUpdateServiceState(State.Idle(UpdateType.Setup, '网络错误', true)), { type: 'error', message: '网络错误' });
	});

	test('Disabled ⇒ unsupported（不是 error），文案指向手动覆盖安装', () => {
		const ev = mapUpdateServiceState(State.Disabled(DisablementReason.NotBuilt));
		assert.strictEqual(ev?.type, 'unsupported');
		assert.ok(ev?.type === 'unsupported' && ev.message.includes('手动下载安装包'));
	});

	test('CheckingForUpdates：explicit 决定 manual 与 source', () => {
		assert.deepStrictEqual(mapUpdateServiceState(State.CheckingForUpdates(true)), { type: 'check', manual: true, source: 'manual' });
		assert.deepStrictEqual(mapUpdateServiceState(State.CheckingForUpdates(false)), { type: 'check', manual: false, source: 'runtime' });
	});

	test('AvailableForDownload：productVersion 优先、发布日志只在这一相带出', () => {
		assert.deepStrictEqual(
			mapUpdateServiceState(State.AvailableForDownload(update('deadbeef', '2.2.26301')), '· 修复假超时'),
			{ type: 'available', version: '2.2.26301', releaseNotes: '· 修复假超时' },
		);
		assert.deepStrictEqual(
			mapUpdateServiceState(State.AvailableForDownload(update('deadbeef'))),
			{ type: 'available', version: 'deadbeef' },
			'没有 productVersion 时回落 commit',
		);
		assert.deepStrictEqual(
			mapUpdateServiceState(State.AvailableForDownload(update('deadbeef', '2.2.26301'))),
			{ type: 'available', version: '2.2.26301' },
			'没有日志时不该塞空 releaseNotes',
		);
	});

	test('Downloading / Updating：有字节数给 percent，没有就留空（不确定进度条）', () => {
		assert.deepStrictEqual(
			mapUpdateServiceState(State.Downloading(update('c'), true, false, 250, 500)),
			{ type: 'downloading', percent: 50 },
		);
		assert.deepStrictEqual(
			mapUpdateServiceState(State.Downloading(update('c'), true, false, 100, undefined)),
			{ type: 'downloading' },
		);
		assert.deepStrictEqual(
			mapUpdateServiceState(State.Updating(update('c'), true, 30, 100)),
			{ type: 'downloading', percent: 30 },
		);
		assert.deepStrictEqual(mapUpdateServiceState(State.Overwriting(update('c'), true)), { type: 'downloading' });
	});

	test('Downloaded / Ready / Restarting 统一落到 downloaded', () => {
		for (const st of [
			State.Downloaded(update('c', '2.2.26301'), true, false),
			State.Ready(update('c', '2.2.26301'), true, false),
			State.Restarting(update('c', '2.2.26301')),
		]) {
			assert.deepStrictEqual(mapUpdateServiceState(st), { type: 'downloaded', version: '2.2.26301' });
		}
	});

	test('集成：check → available → downloading → downloaded，且普通 Idle 不冲掉 available', () => {
		let status = initialAppUpdateStatus('2.2.26252');
		const chain = [
			State.CheckingForUpdates(true),
			State.AvailableForDownload(update('c', '2.2.26301')),
			State.Idle(UpdateType.Setup),
			State.Downloading(update('c'), true, false, 250, 500),
			State.Ready(update('c', '2.2.26301'), true, false),
		];
		for (const st of chain) {
			const ev = mapUpdateServiceState(st);
			if (ev) {
				status = reduceAppUpdateStatus(status, ev);
			}
		}
		assert.strictEqual(status.phase, 'downloaded');
		assert.strictEqual(status.availableVersion, '2.2.26301');

		// 用户还没点「更新」时来一次普通 Idle，不许把 available 冲掉
		let pending = reduceAppUpdateStatus(initialAppUpdateStatus('2.2.26252'), { type: 'available', version: '2.2.26301' });
		const idleEvent = mapUpdateServiceState(State.Idle(UpdateType.Setup));
		if (idleEvent) {
			pending = reduceAppUpdateStatus(pending, idleEvent);
		}
		assert.strictEqual(pending.phase, 'available', '普通 Idle 必须返回 undefined ✗');
	});
});
