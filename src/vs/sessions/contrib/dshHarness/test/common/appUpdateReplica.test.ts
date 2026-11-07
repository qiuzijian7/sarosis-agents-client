/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 复刻 dsh-desktop 更新实现的行为回归（2026-11-05）。
 *
 * 重点钉住三件「静默出错」的事：
 *   ① 历史快照不得重放手动弹窗（`isNewManualPresentation` 的 delivery 判据）；
 *   ② 拿不到 totalBytes 时不许残留上一轮的 percent（会显示假进度）；
 *   ③ `validateUpgradeState` 是逐字段白名单 —— 新增字段忘了放行，页面会**静默**收不到。
 */

import assert from 'assert';
import fs from 'node:fs';
import {
	clampPercent, initialAppUpdateStatus, isAppUpdatePhase, normalizeReleaseNotes,
	percentFromBytes, reduceAppUpdateStatus, type IAppUpdateStatus,
} from '../../common/appUpdateState.js';
import {
	appUpdateHeadline, isAppUpdateDismissed, isNewManualPresentation, shouldShowAppUpdate,
} from '../../common/appUpdateView.js';
import { parseAppUpdateResponse } from '../../common/dshAppUpdate.js';
import { validateUpgradeState } from '../../common/dshPageBridgeProtocol.js';

function advance(from: IAppUpdateStatus, ...events: Parameters<typeof reduceAppUpdateStatus>[1][]): IAppUpdateStatus {
	return events.reduce(reduceAppUpdateStatus, from);
}

suite('dshHarness / app 更新状态机（复刻 dsh-desktop）', () => {

	test('clampPercent 收敛到 0..100 且保留一位小数', () => {
		assert.strictEqual(clampPercent(62.36), 62.4);
		assert.strictEqual(clampPercent(-3), 0);
		assert.strictEqual(clampPercent(180), 100);
		assert.strictEqual(clampPercent(Number.NaN), 0);
		assert.strictEqual(clampPercent(Number.POSITIVE_INFINITY), 0);
	});

	test('percentFromBytes：没给 Content-Length 时返回 undefined（不猜百分比）', () => {
		assert.strictEqual(percentFromBytes(100, 200), 50);
		assert.strictEqual(percentFromBytes(300, 200), 100);
		assert.strictEqual(percentFromBytes(undefined, 200), 0);
		assert.strictEqual(percentFromBytes(100, undefined), undefined);
		assert.strictEqual(percentFromBytes(100, 0), undefined);
		assert.strictEqual(percentFromBytes(100, Number.NaN), undefined);
	});

	test('8 相主链路：check → available → downloading → downloaded', () => {
		let s = initialAppUpdateStatus('2.2.26207');
		assert.strictEqual(s.phase, 'idle');
		s = advance(s,
			{ type: 'check', manual: true, source: 'manual' },
			{ type: 'available', version: '2.2.26208', releaseNotes: '· 修复假超时' },
		);
		assert.strictEqual(s.phase, 'available');
		assert.strictEqual(s.availableVersion, '2.2.26208');
		assert.strictEqual(s.manual, true);
		s = advance(s, { type: 'downloading', percent: 62.4 });
		assert.strictEqual(s.phase, 'downloading');
		assert.strictEqual(s.percent, 62.4);
		assert.strictEqual(s.presentationId, undefined);
		// 发布日志/版本跨阶段保留（详情弹窗在下载中也能看）
		assert.strictEqual(s.releaseNotes, '· 修复假超时');
		s = advance(s, { type: 'downloaded', version: '2.2.26208' });
		assert.strictEqual(s.phase, 'downloaded');
		assert.strictEqual(s.percent, undefined, 'downloaded 不该残留 percent');
	});

	test('downloading 无 percent 时不残留上一轮的百分比', () => {
		let s = advance(initialAppUpdateStatus('1.0.0'),
			{ type: 'available', version: '1.0.1' },
			{ type: 'downloading', percent: 80 },
		);
		assert.strictEqual(s.percent, 80);
		s = reduceAppUpdateStatus(s, { type: 'downloading' });
		assert.strictEqual(s.percent, undefined);
		assert.strictEqual(s.availableVersion, '1.0.1', '版本号不该被清掉');
	});

	test('reset / not-available / error / unsupported 都清掉上一版的版本与日志', () => {
		const base = advance(initialAppUpdateStatus('1.0.0'),
			{ type: 'check', manual: true },
			{ type: 'available', version: '1.0.1', releaseNotes: 'notes' },
		);
		for (const event of [
			{ type: 'not-available' } as const,
			{ type: 'error', message: '网络错误' } as const,
			{ type: 'unsupported', message: '不支持' } as const,
			{ type: 'reset' } as const,
		]) {
			const s = reduceAppUpdateStatus(base, event);
			assert.strictEqual(s.availableVersion, undefined, `${event.type} 不该带旧版本`);
			assert.strictEqual(s.releaseNotes, undefined, `${event.type} 不该带旧日志`);
		}
		assert.strictEqual(reduceAppUpdateStatus(base, { type: 'error', message: '网络错误' }).message, '网络错误');
	});

	test('normalizeReleaseNotes 只认纯文本、限长、不吞 HTML', () => {
		assert.strictEqual(normalizeReleaseNotes('  a\r\nb  '), 'a\nb');
		assert.strictEqual(normalizeReleaseNotes([{ note: 'a' }, { note: 'b' }, { nope: 1 }]), 'a\n\nb');
		assert.strictEqual(normalizeReleaseNotes({ note: 'a' }), undefined);
		assert.strictEqual(normalizeReleaseNotes('<img src=x>'), '<img src=x>', '原样保留文本，由渲染层用 textContent');
		assert.strictEqual(normalizeReleaseNotes('x'.repeat(30_000))?.length, 20_000);
	});

	test('shouldShowAppUpdate：只有 3 个阶段自动可见，其余必须 manual', () => {
		const auto = ['available', 'downloading', 'downloaded'] as const;
		const manual = ['checking', 'up-to-date', 'error', 'unsupported'] as const;
		for (const phase of auto) {
			assert.strictEqual(shouldShowAppUpdate({ ...initialAppUpdateStatus('1'), phase }), true, phase);
		}
		for (const phase of manual) {
			const s = { ...initialAppUpdateStatus('1'), phase, manual: false };
			assert.strictEqual(shouldShowAppUpdate(s), false, `${phase} 不该自动弹`);
			assert.strictEqual(shouldShowAppUpdate({ ...s, manual: true }), true, `${phase} 手动检查后应可见`);
		}
		assert.strictEqual(shouldShowAppUpdate(initialAppUpdateStatus('1')), false, 'idle 永不显示');
	});

	test('isNewManualPresentation：历史快照不重放弹窗，presentationId 区分新旧请求', () => {
		const first: IAppUpdateStatus = { ...initialAppUpdateStatus('1'), phase: 'checking', manual: true, presentationId: 1 };
		const second: IAppUpdateStatus = { ...first, presentationId: 2 };
		assert.strictEqual(isNewManualPresentation(first, undefined), true);
		assert.strictEqual(isNewManualPresentation(first, first), false, '同一个请求不重开');
		assert.strictEqual(isNewManualPresentation(second, first), true, '新请求要重开');
		assert.strictEqual(isNewManualPresentation(second, undefined, 'snapshot'), false, '★ 快照绝不重放');
		assert.strictEqual(isNewManualPresentation({ ...second, manual: false }, undefined), false);
	});

	test('isAppUpdateDismissed：有版本按版本忽略，瞬态按阶段忽略', () => {
		const withVersion: IAppUpdateStatus = { ...initialAppUpdateStatus('1'), phase: 'available', manual: false, availableVersion: '2.0.0' };
		assert.strictEqual(isAppUpdateDismissed(withVersion, '2.0.0'), true);
		assert.strictEqual(isAppUpdateDismissed(withVersion, '1.9.0'), false, '新版本仍要问');
		const transient: IAppUpdateStatus = { ...initialAppUpdateStatus('1'), phase: 'checking', manual: true };
		assert.strictEqual(isAppUpdateDismissed(transient, null, 'checking'), true);
		assert.strictEqual(isAppUpdateDismissed(transient, null, 'error'), false);
	});

	test('appUpdateHeadline：无百分比时说「正在下载…」，不说 0%', () => {
		const noPercent = appUpdateHeadline({ ...initialAppUpdateStatus('1'), phase: 'downloading', manual: false, availableVersion: '2.0.0' });
		assert.ok(noPercent.description.includes('正在下载'));
		assert.ok(!noPercent.description.includes('0%'));
		const withPercent = appUpdateHeadline({ ...initialAppUpdateStatus('1'), phase: 'downloading', manual: false, availableVersion: '2.0.0', percent: 62 });
		assert.ok(withPercent.description.includes('62%'));
		assert.ok(appUpdateHeadline({ ...initialAppUpdateStatus('1'), phase: 'error', manual: true, message: '下载超时' }).description.includes('下载超时'));
	});

	test('isAppUpdatePhase 只放行 8 相', () => {
		for (const p of ['idle', 'checking', 'available', 'downloading', 'downloaded', 'up-to-date', 'error', 'unsupported']) {
			assert.strictEqual(isAppUpdatePhase(p), true, p);
		}
		assert.strictEqual(isAppUpdatePhase('bogus'), false);
		assert.strictEqual(isAppUpdatePhase(undefined), false);
	});
});

suite('dshHarness / app 更新契约（复刻新增字段）', () => {

	const fixture = {
		at: 1,
		app: {
			current: '2.2.26207', action: 'upgrade', remote: '2.2.26208',
			phase: 'downloading', percent: 62.4, releaseNotes: '· 修复假超时',
			presentationId: 7, manual: true, source: 'manual',
			availableVersion: '2.2.26208', skippedVersion: '2.2.26206',
		},
		runtime: {}, bundled: [], assets: [],
	};

	test('★ validateUpgradeState 白名单必须放行全部新字段（漏一个就静默丢）', () => {
		const out = validateUpgradeState(fixture);
		assert.ok(out, '整份状态不该被判为脏数据');
		assert.strictEqual(out.app.phase, 'downloading');
		assert.strictEqual(out.app.availableVersion, '2.2.26208');
		assert.strictEqual(out.app.percent, 62.4);
		assert.strictEqual(out.app.releaseNotes, '· 修复假超时');
		assert.strictEqual(out.app.presentationId, 7);
		assert.strictEqual(out.app.manual, true);
		assert.strictEqual(out.app.source, 'manual');
		assert.strictEqual(out.app.skippedVersion, '2.2.26206');
	});

	test('白名单同时挡住脏值：非法 phase 丢弃、percent 收敛、日志限长', () => {
		const out = validateUpgradeState({
			...fixture,
			app: {
				...fixture.app,
				phase: 'bogus', percent: 999, source: 'hacker',
				releaseNotes: 'x'.repeat(30_000), presentationId: Number.NaN,
			},
		});
		assert.ok(out);
		assert.strictEqual(out.app.phase, undefined);
		assert.strictEqual(out.app.percent, 100);
		assert.strictEqual(out.app.source, undefined);
		assert.strictEqual(out.app.releaseNotes?.length, 20_000);
		assert.strictEqual(out.app.presentationId, undefined);
	});

	test('老宿主推来的状态（没有任何新字段）照样能解析', () => {
		const out = validateUpgradeState({ at: 1, app: { current: '1.0.0', action: 'uptodate' }, runtime: {}, bundled: [], assets: [] });
		assert.ok(out);
		assert.strictEqual(out.app.phase, undefined);
		assert.strictEqual(out.app.current, '1.0.0');
	});

	test('parseAppUpdateResponse 认更新源的 notes 字段（纯文本、限长）', () => {
		const out = parseAppUpdateResponse({ version: 'abc', productVersion: '2.2.26208', url: 'https://x', notes: '· 新增 A' });
		assert.strictEqual(out?.notes, '· 新增 A');
		assert.strictEqual(parseAppUpdateResponse({ notes: 'x'.repeat(30_000) })?.notes?.length, 20_000);
		assert.strictEqual(parseAppUpdateResponse({ notes: '   ' })?.notes, undefined);
		assert.strictEqual(parseAppUpdateResponse({ version: 'abc' })?.notes, undefined);
	});
});

/** 新 chunk 的源码契约（随 appUpdateReplica 一起进 check:dsh-plugins 链）。 */
suite('dshHarness / app 更新卡片 chunk 契约', () => {
	const CHUNK = 'dsh-plugins/vssaros-chat-surface/lib/client.appUpdate.js';
	const CLIENT = 'dsh-plugins/vssaros-chat-surface/lib/client.js';
	const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

	test('① 新 chunk 必须在 ALWAYS_CHUNKS 里（否则页面永远不加载）', () => {
		const entry = strip(fs.readFileSync(CLIENT, 'utf8'));
		const at = entry.indexOf('const ALWAYS_CHUNKS');
		assert.ok(at > 0, '找不到 ALWAYS_CHUNKS ✗');
		assert.match(entry.slice(at, entry.indexOf('];', at)), /client\.appUpdate\.js/);
	});

	test('② 隔离与主题：closed ShadowRoot + 9 个令牌复制 + MutationObserver', () => {
		const src = strip(fs.readFileSync(CHUNK, 'utf8'));
		assert.match(src, /attachShadow\(\{ mode: "closed" \}\)/);
		assert.match(src, /document\.documentElement\.appendChild\(host\)/);
		assert.match(src, /MutationObserver/);
		const tp = src.indexOf('const THEME_PROPERTIES');
		assert.ok(tp > 0, '缺少 THEME_PROPERTIES ✗');
		const body = src.slice(tp, src.indexOf('];', tp));
		assert.strictEqual((body.match(/--dsw-alias-/g) || []).length, 9, '必须复制官方同款 9 个语义令牌 ✗');
	});

	test('③ 首帧按 snapshot 处理（历史状态不重放手动弹窗）', () => {
		const src = strip(fs.readFileSync(CHUNK, 'utf8'));
		assert.match(src, /applyStatus\(readState\(\), "snapshot"\)/);
		assert.match(src, /delivery === "event" && status\.manual/,
			'只有事件态才允许判定「新的手动呈现」✗');
	});

	test('④ 发布日志只走 textContent；三条新桥命令都接到', () => {
		const src = strip(fs.readFileSync(CHUNK, 'utf8'));
		assert.match(src, /notes\.textContent =/);
		assert.ok(!/notes\.innerHTML/.test(src), '更新日志来自更新源（不可信），不许 innerHTML ✗');
		for (const m of ['appUpdateCheck', 'appUpdateSkip', 'appUpdateInstall']) {
			assert.ok(src.includes('b.' + m + '('), `缺少桥命令 ${m} ✗`);
		}
	});

	test('⑤ 旧入口不得复活：胶囊 / IDE 面板都不许再画一键升级', () => {
		const old = strip(fs.readFileSync('dsh-plugins/vssaros-chat-surface/lib/client.upgrade.js', 'utf8'));
		const pane = strip(fs.readFileSync('src/vs/sessions/contrib/dshHarness/electron-browser/dshUpgradeEditorPane.ts', 'utf8'));
		for (const [name, src] of [['胶囊', old], ['IDE 面板', pane]] as const) {
			assert.ok(!/一键升级|upgradeApp\(/.test(src), `${name} 里不许再有一键升级 ✗`);
		}
	});
});
