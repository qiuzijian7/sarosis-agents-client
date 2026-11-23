/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 重启生效范围的行为守卫（2026-11-23）：四种范围的判定顺序、不误报、白名单、快照放行。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshRestartScope
 */

import assert from 'assert';
import { decideRestartScope, validateRestartPlan } from '../../common/dshRestartScope.js';
import { validateUpgradeState } from '../../common/dshPageBridgeProtocol.js';

const base = {
	at: 1,
	app: { current: '2.2.26252', action: 'uptodate' },
	runtime: { channel: 'stable' },
	bundled: [],
	assets: [],
};

const job = (over: Record<string, unknown> = {}) => ({
	jobStatus: 'done' as const, jobDone: 2, jobFailed: 0,
	jobItems: [
		{ kind: 'bundled', status: 'done' },
		{ kind: 'asset', status: 'done' },
	],
	...over,
});

suite('dshHarness / 重启生效范围（restart 投影）', () => {

	test('默认：没有待生效变更 ⇒ none / pending=false', () => {
		const p = decideRestartScope({});
		assert.strictEqual(p.scope, 'none');
		assert.strictEqual(p.pending, false);
		assert.match(p.detail, /没有待生效/);
	});

	test('应用安装包就绪 ⇒ ide，且优先于 job', () => {
		const p = decideRestartScope({ appPhase: 'downloaded', ...job() });
		assert.strictEqual(p.scope, 'ide');
		assert.strictEqual(p.pending, true);
		assert.match(p.detail, /整个 IDE/);
		assert.strictEqual(decideRestartScope({ appBusy: 'installing' }).scope, 'ide');
		assert.notStrictEqual(decideRestartScope({ appPhase: 'downloading' }).scope, 'ide');
	});

	test('批量升级：含随包插件 ⇒ host；只有商城资产 ⇒ refresh', () => {
		assert.strictEqual(decideRestartScope(job()).scope, 'host');
		assert.match(decideRestartScope(job()).detail, /dsh Host/);
		const assetsOnly = job({ jobItems: [{ kind: 'asset', status: 'done' }, { kind: 'asset', status: 'done' }] });
		assert.strictEqual(decideRestartScope(assetsOnly).scope, 'refresh');
		assert.match(decideRestartScope(assetsOnly).detail, /刷新页面/);
	});

	test('不误报：任务还在跑 / 全失败 / 没有成功项 ⇒ none', () => {
		assert.strictEqual(decideRestartScope(job({ jobStatus: 'running' })).scope, 'none');
		assert.strictEqual(decideRestartScope(job({ jobDone: 2, jobFailed: 2 })).scope, 'none');
		assert.strictEqual(decideRestartScope(job({ jobDone: 0, jobFailed: 0 })).scope, 'none');
		assert.strictEqual(decideRestartScope(job({ jobStatus: 'failed', jobDone: 1, jobFailed: 1 })).scope, 'none');
	});

	test('回滚 ⇒ refresh，并说明可再次回滚', () => {
		const p = decideRestartScope({ rollback: true });
		assert.strictEqual(p.scope, 'refresh');
		assert.strictEqual(p.pending, true);
		assert.match(p.detail, /可再次回滚/);
	});

	test('优先级：ide > host > refresh > none', () => {
		const all = { appPhase: 'downloaded', rollback: true, ...job() };
		assert.strictEqual(decideRestartScope(all).scope, 'ide');
		assert.strictEqual(decideRestartScope({ rollback: true, ...job() }).scope, 'host');
		assert.strictEqual(decideRestartScope({ rollback: true }).scope, 'refresh');
		assert.strictEqual(decideRestartScope({}).scope, 'none');
	});

	test('validateRestartPlan：值域 / 限长 / 脏值丢弃', () => {
		const p = decideRestartScope(job());
		assert.deepStrictEqual(validateRestartPlan({ ...p, injected: 'evil' }), p);
		assert.strictEqual((validateRestartPlan({ ...p, injected: 'evil' }) as Record<string, unknown> | undefined)?.injected, undefined);
		assert.strictEqual(validateRestartPlan({ ...p, scope: 'hacked' }), undefined);
		assert.strictEqual(validateRestartPlan(null), undefined);
		const long = validateRestartPlan({ ...p, label: 'x'.repeat(300), detail: 'y'.repeat(900), pending: 'yes' as never });
		assert.strictEqual(long?.label.length, 120);
		assert.strictEqual(long?.detail.length, 500);
		assert.strictEqual(long?.pending, false);
	});

	test('restart 随快照穿过 validateUpgradeState（新增字段没被静默丢掉）', () => {
		const restart = decideRestartScope(job());
		const s = validateUpgradeState({ ...base, seq: 9, restart });
		assert.strictEqual(s?.restart?.scope, 'host');
		assert.strictEqual(s?.restart?.pending, true);
		assert.strictEqual(s?.seq, 9);
		const dirty = validateUpgradeState({ ...base, restart: { scope: 'hacked' } });
		assert.ok(dirty);
		assert.strictEqual(dirty?.restart, undefined);
	});
});
