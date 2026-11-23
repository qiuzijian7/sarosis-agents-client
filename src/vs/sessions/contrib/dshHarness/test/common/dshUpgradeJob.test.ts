/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 批量升级 job 状态机的行为守卫（2026-11-23）：逐项进度、失败分型、幂等回执、信任边界。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshUpgradeJob
 */

import assert from 'assert';
import {
	createUpgradeJob, finishUpgradeJob, finishUpgradeJobItem, startUpgradeJobItem,
	upgradeJobSummary, validateUpgradeJobState,
} from '../../common/dshUpgradeJob.js';

const specs = [
	{ kind: 'bundled' as const, key: '@vssaros/dsh-memory', label: '@vssaros/dsh-memory' },
	{ kind: 'bundled' as const, key: '@vssaros/dsh-dashboard', label: '@vssaros/dsh-dashboard' },
	{ kind: 'asset' as const, key: 'mcp/codebase-memory-mcp', label: 'codebase-memory-mcp' },
];

suite('dshHarness / 批量升级任务（jobId + 逐项进度）', () => {

	test('create：全 pending，计数从 0 开始', () => {
		const job = createUpgradeJob(7, specs);
		assert.strictEqual(job.id, 7);
		assert.strictEqual(job.status, 'running');
		assert.strictEqual(job.total, 3);
		assert.strictEqual(job.done, 0);
		assert.strictEqual(job.failed, 0);
		assert.deepStrictEqual(job.items.map(i => i.status), ['pending', 'pending', 'pending']);
		assert.strictEqual(createUpgradeJob(8, []).total, 0);
	});

	test('start → finish：逐项推进，done/failed 计数正确', () => {
		let job = createUpgradeJob(1, specs);
		job = startUpgradeJobItem(job, specs[0].key);
		assert.strictEqual(job.current, specs[0].key);
		assert.strictEqual(job.items[0].status, 'running');
		job = finishUpgradeJobItem(job, specs[0].key, true);
		assert.strictEqual(job.done, 1);
		assert.strictEqual(job.failed, 0);
		assert.strictEqual(job.current, undefined);
		assert.strictEqual(job.items[0].status, 'done');

		job = startUpgradeJobItem(job, specs[1].key);
		job = finishUpgradeJobItem(job, specs[1].key, false, 'profile 锁被占用');
		assert.strictEqual(job.done, 2);
		assert.strictEqual(job.failed, 1);
		assert.strictEqual(job.items[1].status, 'failed');
		assert.strictEqual(job.items[1].error, 'profile 锁被占用');
	});

	test('重复回执不重复计数（幂等）', () => {
		let job = createUpgradeJob(2, specs);
		job = finishUpgradeJobItem(job, specs[0].key, true);
		const again = finishUpgradeJobItem(job, specs[0].key, false, '迟到的失败');
		assert.strictEqual(again.done, 1);
		assert.strictEqual(again.failed, 0, '已 done 的项不许被迟到回执改成 failed');
	});

	test('finish：有失败项 ⇒ failed；全成功 ⇒ done', () => {
		const ok = finishUpgradeJob(createUpgradeJob(3, specs));
		assert.strictEqual(ok.status, 'done');
		const bad = finishUpgradeJob(finishUpgradeJobItem(createUpgradeJob(4, specs), specs[0].key, false, '网络错'));
		assert.strictEqual(bad.status, 'failed');
		assert.strictEqual(bad.current, undefined);
	});

	test('upgradeJobSummary：进行中 / 失败 / 完成三种人话', () => {
		const running = startUpgradeJobItem(createUpgradeJob(5, specs), specs[0].key);
		assert.match(upgradeJobSummary(running), /升级 0\/3/);
		assert.ok(upgradeJobSummary(running).includes(specs[0].key));
		const failed = finishUpgradeJob(finishUpgradeJobItem(createUpgradeJob(6, specs), specs[0].key, false, 'x'));
		assert.match(upgradeJobSummary(failed), /有 1 项没升成/);
		assert.match(upgradeJobSummary(finishUpgradeJob(createUpgradeJob(7, specs))), /全部完成/);
	});

	test('validateUpgradeJobState：白名单重建，脏值不进 dataset', () => {
		const raw = createUpgradeJob(9, specs);
		const clean = validateUpgradeJobState(JSON.parse(JSON.stringify(raw)));
		assert.deepStrictEqual(clean, raw);

		const dirty = validateUpgradeJobState({
			...raw,
			id: 'bad',
			status: 'hacked',
			items: [
				{ ...raw.items[0], status: 'done', injected: 'evil' },
				{ kind: 'unknown', key: 'x', status: 'pending' },
				{ kind: 'asset', key: '', status: 'pending' },
				{ kind: 'asset', key: 'a/b', status: 'bogus' },
				null,
			],
			extra: 'should be dropped',
		});
		assert.strictEqual(dirty, undefined, 'id / status 不合法 ⇒ 整份 job 丢弃');
		const partial = validateUpgradeJobState({ ...raw, items: [...raw.items, { kind: 'x', key: 'y', status: 'pending' }] });
		assert.strictEqual(partial?.items.length, 3, '不认识的 item 逐条丢掉');
		assert.strictEqual(validateUpgradeJobState(null), undefined);
		assert.strictEqual(validateUpgradeJobState({ id: 1 }), undefined, '缺 status/items ⇒ 丢弃');
	});
});
