/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 孤儿 Host 回收的**判定**（`planOrphanHosts`）——纯逻辑，不碰文件、不杀进程 ✓。
 *
 * ★ 本文件的主要目的（2026-10-16）：钉住 **按 `hostPid` 分组收敛** 这条规则 ✗。
 * 场景来自真机可达路径：A 优雅分离后 B 经 `host.json` **接管**了同一个 Host（B 也写下自己那份记录
 * ⇒ 同一 `hostPid` 上有**两份**记录）。此时 A 的记录里 `appPid` 已死 ⇒ 单条判定就是"可回收" ⇒
 * 插件换过版本时新起的 C 会 `taskkill /T` 掉 **B 正在用**的 Host ✗✗。
 * 所以：**组里只要有一条说"还在用"，整个 Host 不许动** ✓；负对照（把 B 也改成死的）必须回到"可回收" ✓。
 */

import assert from 'assert';
import { IHostRunOwnership, planOrphanHosts } from '../../common/dshHostRunOwnership.js';

const NOW = 1_700_000_000_000;
/** 保护期（与 `dshHostReaper` 的 `OWNERSHIP_GRACE_MS` 同量级）。 */
const GRACE = 15_000;
const SELF = 40_000;
const DEAD_OWNER = 41_000;
const LIVE_OWNER = 42_000;
/** 判"活着"的只有 LIVE_OWNER 一个（其余 pid 一律视为已退出 ✓）。 */
const isAlive = (pid: number) => pid === LIVE_OWNER;

function record(overrides: Partial<IHostRunOwnership> & Pick<IHostRunOwnership, 'runId' | 'appPid' | 'hostPid'>): IHostRunOwnership {
	return {
		format: 1,
		instanceId: 'inst',
		profile: 'saros',
		startedAt: NOW - 60_000,
		files: [],
		...overrides,
	};
}

function plan(records: readonly IHostRunOwnership[]) {
	return planOrphanHosts(records, { selfAppPid: SELF, isAlive, now: NOW, graceMs: GRACE });
}

suite('dshHarness / orphan host reaping — planOrphanHosts', () => {

	test('拥有者已退出 ⇒ 可回收（原因必须说清是谁不在了）', () => {
		const result = plan([record({ runId: 'r1', appPid: DEAD_OWNER, hostPid: 100 })]);
		assert.deepStrictEqual(result.reap.map(v => v.record.runId), ['r1']);
		assert.deepStrictEqual(result.keep, []);
		assert.ok(result.reap[0].reason.includes('已退出'), '原因要能解释（进日志）');
	});

	test('拥有者仍在运行 ⇒ 不动（真·多实例：别的窗口可能正接在上面）', () => {
		const result = plan([record({ runId: 'r1', appPid: LIVE_OWNER, hostPid: 100 })]);
		assert.deepStrictEqual(result.reap, []);
		assert.deepStrictEqual(result.keep.map(v => v.record.runId), ['r1']);
		assert.ok(result.keep[0].reason.includes('仍在运行'));
	});

	test('拥有者就是本进程（上一轮留下的）⇒ 可回收', () => {
		const result = plan([record({ runId: 'r1', appPid: SELF, hostPid: 100 })]);
		assert.deepStrictEqual(result.reap.map(v => v.record.runId), ['r1']);
		assert.ok(result.reap[0].reason.includes('本进程'));
	});

	test('保护期内的新记录 ⇒ 不动（可能是并发实例刚写下的）', () => {
		const result = plan([record({ runId: 'r1', appPid: DEAD_OWNER, hostPid: 100, startedAt: NOW - 1_000 })]);
		assert.deepStrictEqual(result.reap, []);
		assert.ok(result.keep[0].reason.includes('保护期'));
	});

	test('★ 同一 hostPid 有多份记录时：只要一份说"还在用"，整组不动', () => {
		// A 优雅分离（已死）+ B 接管（活着）——「B 正在用的 Host 被 C 误杀」就是漏了这条。
		const shared = [
			record({ runId: 'a', appPid: DEAD_OWNER, hostPid: 100 }),
			record({ runId: 'b', appPid: LIVE_OWNER, hostPid: 100 }),
		];
		const kept = plan(shared);
		assert.deepStrictEqual(kept.reap, [], '有活着的拥有者接在上面 ⇒ 一条都不许回收');
		assert.deepStrictEqual(kept.keep.map(v => v.record.runId).sort(), ['a', 'b']);
		// 成组时原因要点明"整组保留"，否则日志里看不出为什么没回收 ✓
		assert.ok(kept.keep.every(v => v.reason.includes('整组保留')));

		// 负对照：把"活着的那份"也改成死的 ⇒ 必须回到"两份都可回收" ✓
		const orphaned = plan([
			record({ runId: 'a', appPid: DEAD_OWNER, hostPid: 100 }),
			record({ runId: 'b', appPid: DEAD_OWNER, hostPid: 100 }),
		]);
		assert.deepStrictEqual(orphaned.keep, []);
		assert.deepStrictEqual(orphaned.reap.map(v => v.record.runId).sort(), ['a', 'b']);
	});

	test('不同 hostPid 各自判定，互不牵连', () => {
		const result = plan([
			record({ runId: 'dead', appPid: DEAD_OWNER, hostPid: 100 }),
			record({ runId: 'live', appPid: LIVE_OWNER, hostPid: 200 }),
		]);
		assert.deepStrictEqual(result.reap.map(v => v.record.runId), ['dead']);
		assert.deepStrictEqual(result.keep.map(v => v.record.runId), ['live']);
	});

	test('单条记录的原因原样透传（排查习惯依赖这些关键字）', () => {
		const result = plan([record({ runId: 'r1', appPid: LIVE_OWNER, hostPid: 100 })]);
		assert.ok(!result.keep[0].reason.includes('整组保留'), '只有一条时不该套用成组话术');
	});
});
