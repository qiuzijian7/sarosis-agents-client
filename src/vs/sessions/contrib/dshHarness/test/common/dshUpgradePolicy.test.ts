/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 升级策略（灰度 / 强制最低版本 / 更新内容）的行为守卫（2026-11-23）。
 *
 * 重点钉住：默认不配策略时行为不变；强制版本不受灰度阻挡；分桶稳定；
 * `notes` 是纯文本且限长；策略穿过 `validateUpgradeState` 时逐字段白名单。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshUpgradePolicy
 */

import assert from 'assert';
import { parseAppUpdateResponse } from '../../common/dshAppUpdate.js';
import {
	bucketOf, decideUpgradePolicy, rolloutHit, validateUpgradePolicyState,
} from '../../common/dshUpgradePolicy.js';
import { validateUpgradeState } from '../../common/dshPageBridgeProtocol.js';

const base = {
	at: 1,
	app: { current: '2.2.26252', action: 'uptodate' },
	runtime: { channel: 'stable' },
	bundled: [],
	assets: [],
};

suite('dshHarness / 升级策略（灰度 / 强制版本 / 更新内容）', () => {

	test('默认（更新源不给策略）⇒ 全量、建议升级，行为与改造前一致', () => {
		const p = decideUpgradePolicy({ local: '2.2.26252', remote: '2.2.26301', bucket: 'abc' });
		assert.strictEqual(p.urgency, 'recommended');
		assert.strictEqual(p.rolloutPercent, 100);
		assert.strictEqual(p.minRequiredVersion, undefined);
		assert.match(p.reason, /建议升级/);
	});

	test('没有新版 ⇒ optional / 已是最新', () => {
		assert.strictEqual(decideUpgradePolicy({ local: '2.2.26252' }).urgency, 'optional');
		assert.strictEqual(decideUpgradePolicy({ local: '2.2.26252', remote: '2.2.26252' }).urgency, 'optional');
		assert.strictEqual(decideUpgradePolicy({ local: '2.2.26252', remote: '2.2.26100' }).urgency, 'optional',
			'更新源更旧不能被策略说成建议升级 ✗');
	});

	test('本地低于最低要求 ⇒ required，且不受灰度阻挡', () => {
		const p = decideUpgradePolicy({
			local: '2.2.26080', remote: '2.2.26301',
			minRequiredVersion: '2.2.26200', rolloutPercent: 0, bucket: 'abc',
		});
		assert.strictEqual(p.urgency, 'required');
		assert.strictEqual(p.minRequiredVersion, '2.2.26200');
		assert.match(p.reason, /必须升级/);
		const ok = decideUpgradePolicy({ local: '2.2.26301', minRequiredVersion: '2.2.26200' });
		assert.notStrictEqual(ok.urgency, 'required');
	});

	test('灰度：0% 全挡、100% 全放、分桶稳定且不同标识有区分', () => {
		assert.strictEqual(rolloutHit(0, 'abc'), false);
		assert.strictEqual(rolloutHit(100, 'abc'), true);
		assert.strictEqual(rolloutHit(50, undefined), true, '缺分桶标识不该把整批用户挡住');
		assert.strictEqual(bucketOf('abc'), bucketOf('abc'), '同一标识必须稳定');
		assert.ok(bucketOf('abc') >= 0 && bucketOf('abc') < 100);
		const seeds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
		assert.ok(new Set(seeds.map(bucketOf)).size > 1, '分桶要真的把不同标识散开');

		const hold = decideUpgradePolicy({
			local: '2.2.26252', remote: '2.2.26301', rolloutPercent: 0, bucket: 'abc',
		});
		assert.strictEqual(hold.urgency, 'optional');
		assert.match(hold.reason, /暂缓/);
		const hit = decideUpgradePolicy({
			local: '2.2.26252', remote: '2.2.26301', rolloutPercent: 100, bucket: 'abc',
		});
		assert.strictEqual(hit.urgency, 'recommended');
	});

	test('notes 纯文本、限长；策略投影带出最低版本与渠道', () => {
		const p = decideUpgradePolicy({
			local: '2.2.26252', remote: '2.2.26301', channel: 'beta',
			minRequiredVersion: '2.2.26000', notes: '  · 修复假超时  ',
		});
		assert.strictEqual(p.channel, 'beta');
		assert.strictEqual(p.notes, '· 修复假超时');
		assert.strictEqual(decideUpgradePolicy({ local: '1', notes: 'x'.repeat(30_000) }).notes?.length, 20_000);
	});

	test('parseAppUpdateResponse 认策略字段；脏值不进响应体', () => {
		const ok = parseAppUpdateResponse({ productVersion: '2.2.26301', minVersion: '2.2.26200', rolloutPercent: 25.6 });
		assert.strictEqual(ok?.minVersion, '2.2.26200');
		assert.strictEqual(ok?.rolloutPercent, 26);
		const dirty = parseAppUpdateResponse({ productVersion: '2.2.26301', minVersion: 12, rolloutPercent: 'all' });
		assert.strictEqual(dirty?.minVersion, undefined);
		assert.strictEqual(dirty?.rolloutPercent, undefined);
		assert.strictEqual(parseAppUpdateResponse({ productVersion: '2.2.26301', rolloutPercent: 500 })?.rolloutPercent, 100);
		assert.strictEqual(parseAppUpdateResponse({ productVersion: '2.2.26301', rolloutPercent: -2 })?.rolloutPercent, 0);
	});

	test('validateUpgradePolicyState：白名单重建，脏 urgency 整份丢弃', () => {
		const p = decideUpgradePolicy({
			local: '2.2.26252', remote: '2.2.26301', minRequiredVersion: '2.2.26000',
			notes: '<img src=x>', bucket: 'abc',
		});
		const clean = validateUpgradePolicyState(JSON.parse(JSON.stringify({ ...p, injected: 'evil' })));
		assert.deepStrictEqual(clean, p);
		assert.strictEqual((clean as unknown as Record<string, unknown> | undefined)?.injected, undefined);
		assert.strictEqual(clean?.notes, '<img src=x>', '纯文本原样保留，由渲染层转义');
		assert.strictEqual(validateUpgradePolicyState({ ...p, urgency: 'hacked' }), undefined);
		assert.strictEqual(validateUpgradePolicyState(null), undefined);
		const long = validateUpgradePolicyState({ ...p, notes: 'x'.repeat(30_000), reason: 'y'.repeat(500) });
		assert.strictEqual(long?.notes?.length, 20_000);
		assert.strictEqual(long?.reason.length, 300);
	});

	test('策略随快照穿过 validateUpgradeState（新增字段没被静默丢掉）', () => {
		const policy = decideUpgradePolicy({
			local: '2.2.26080', remote: '2.2.26301', minRequiredVersion: '2.2.26200', notes: '· 安全修复',
		});
		const s = validateUpgradeState({ ...base, seq: 3, policy });
		assert.strictEqual(s?.policy?.urgency, 'required');
		assert.strictEqual(s?.policy?.notes, '· 安全修复');
		assert.strictEqual(s?.policy?.minRequiredVersion, '2.2.26200');
		const dirty = validateUpgradeState({ ...base, policy: { urgency: 'hacked' } });
		assert.ok(dirty);
		assert.strictEqual(dirty?.policy, undefined, '形状不合法的策略不许进 dataset');
	});
});
