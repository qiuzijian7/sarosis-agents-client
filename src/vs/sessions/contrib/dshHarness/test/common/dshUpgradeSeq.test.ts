/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 升级快照 `seq` / `job` 的信任边界（2026-11-23）。
 *
 * 为什么必须有：`validateUpgradeState` 是**逐字段白名单**——新增字段忘了放行，页面会
 * **静默**收不到（appUpdateReplica 那组守卫钉过一次）。这里钉住「放行的是干净值」而不是
 * 「放行任意值」：序号脏了会让页面永久丢弃后续快照，job 脏了会把外部文本写进 dataset。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshUpgradeSeq
 */

import assert from 'assert';
import { createUpgradeJob, finishUpgradeJobItem } from '../../common/dshUpgradeJob.js';
import { validateUpgradeState } from '../../common/dshPageBridgeProtocol.js';

const base = {
	at: 1,
	app: { current: '2.2.26252', action: 'uptodate' },
	runtime: { channel: 'stable' },
	bundled: [],
	assets: [],
};

suite('dshHarness / 升级快照 seq 与 job 的信任边界', () => {

	test('seq 放行并收敛成自然数（小数 / 负数 / 字符串都不许穿过去）', () => {
		assert.strictEqual(validateUpgradeState({ ...base, seq: 7 })?.seq, 7);
		assert.strictEqual(validateUpgradeState({ ...base, seq: 7.9 })?.seq, 7);
		assert.strictEqual(validateUpgradeState({ ...base, seq: -3 })?.seq, 0);
		assert.strictEqual(validateUpgradeState({ ...base, seq: Number.NaN })?.seq, undefined);
		assert.strictEqual(validateUpgradeState({ ...base, seq: '9' as never })?.seq, undefined);
		assert.strictEqual(validateUpgradeState({ ...base, seq: Number.POSITIVE_INFINITY })?.seq, undefined);
	});

	test('没有 seq 的老宿主快照照样能解析（兼容旧桥）', () => {
		const s = validateUpgradeState(base);
		assert.ok(s);
		assert.strictEqual(s?.seq, undefined);
		assert.strictEqual(s?.app.current, '2.2.26252');
	});

	test('job 随快照放行，且逐字段白名单重建', () => {
		const job = finishUpgradeJobItem(createUpgradeJob(3, [
			{ kind: 'bundled', key: '@vssaros/dsh-memory', label: '@vssaros/dsh-memory' },
		]), '@vssaros/dsh-memory', false, 'profile 锁被占用');
		const s = validateUpgradeState({ ...base, seq: 12, job: { ...job, injected: 'evil' } });
		assert.strictEqual(s?.seq, 12);
		assert.strictEqual(s?.job?.id, 3);
		assert.strictEqual(s?.job?.failed, 1);
		assert.strictEqual(s?.job?.items[0].error, 'profile 锁被占用');
		assert.strictEqual((s?.job as Record<string, unknown> | undefined)?.injected, undefined);
	});

	test('畸形 job 不许进快照（但快照本身仍可用）', () => {
		const s = validateUpgradeState({ ...base, job: { id: 'x', status: 'running', items: [] } });
		assert.ok(s);
		assert.strictEqual(s?.job, undefined);
		const empty = validateUpgradeState({ ...base, job: null });
		assert.strictEqual(empty?.job, undefined);
	});

	test('seq 单调递增的语义由宿主保证：这里只校验「不倒退」的值域', () => {
		const a = validateUpgradeState({ ...base, seq: 100 });
		const b = validateUpgradeState({ ...base, seq: 101 });
		assert.ok(b!.seq! > a!.seq!, '两份快照的序号要能直接比较（页面据此丢旧序）');
	});
});
