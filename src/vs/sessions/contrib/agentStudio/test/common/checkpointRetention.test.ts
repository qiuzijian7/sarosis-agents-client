/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	CHECKPOINT_MAX_PER_SESSION,
	CHECKPOINT_MAX_VERSIONS_PER_FILE,
	CHECKPOINT_TTL_MS,
	collectProtectedSnapshotIds,
	isSessionExpired,
	planCheckpointEviction,
	planVersionPrune,
	selectUnreferencedSnapshotIds,
	type ISnapshotVersionRef,
} from '../../common/checkpointRetention.js';

/** 构造 N 个同文件版本（createdAt 递增）。 */
function versions(n: number, uri = 'file:///a.ts', prefix = 's'): ISnapshotVersionRef[] {
	return Array.from({ length: n }, (_, i) => ({ snapshotId: `${prefix}${i}`, uri, createdAt: i }));
}

suite('checkpointRetention — 检查点保留策略（2026-09-12，P0-1 / P0-2）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── 常量 ────────────────────────────────────────────────────────────────

	test('常量有界且合理', () => {
		assert.ok(CHECKPOINT_MAX_VERSIONS_PER_FILE > 0 && CHECKPOINT_MAX_VERSIONS_PER_FILE <= 500);
		assert.ok(CHECKPOINT_MAX_PER_SESSION > 0 && CHECKPOINT_MAX_PER_SESSION <= 5000);
	});

	// ─── planVersionPrune ────────────────────────────────────────────────────

	test('未超阈值 → 不淘汰任何版本', () => {
		assert.deepStrictEqual(planVersionPrune(versions(3), 50), []);
	});

	test('★ 超出阈值 → 保留最早 1 个 + 最近 N 个，中间淘汰', () => {
		// 10 个版本，max=3 → 保留 s0（最早）+ s7,s8,s9（最近 3）→ 淘汰 s1..s6
		const evicted = planVersionPrune(versions(10), 3).sort();
		assert.deepStrictEqual(evicted, ['s1', 's2', 's3', 's4', 's5', 's6']);
	});

	test('★ 最早快照永不淘汰（撤销全部 revertAll 的基线）', () => {
		const evicted = new Set(planVersionPrune(versions(20), 1));
		assert.ok(!evicted.has('s0'), '最早快照必须保留 —— revertAllCheckpoints 依赖它还原原始内容');
		assert.ok(!evicted.has('s19'), '最近 1 个必须保留');
		assert.strictEqual(evicted.size, 18);
	});

	test('★ 多文件独立计算（互不影响）', () => {
		const refs = [...versions(5, 'file:///a.ts', 'a'), ...versions(2, 'file:///b.ts', 'b')];
		// max=2 → a 保留 a0 + a3,a4（淘汰 a1,a2）；b 仅 2 个 → 全留
		assert.deepStrictEqual(planVersionPrune(refs, 2).sort(), ['a1', 'a2']);
	});

	test('maxVersions=0 → 退化为「只留最早 1 个」', () => {
		assert.deepStrictEqual(planVersionPrune(versions(4), 0).sort(), ['s1', 's2', 's3']);
	});

	test('空输入 → 空结果', () => {
		assert.deepStrictEqual(planVersionPrune([], 5), []);
	});

	test('★ 同 createdAt 时按输入顺序取最早（不误伤基线）', () => {
		const refs: ISnapshotVersionRef[] = Array.from({ length: 5 }, (_, i) => ({
			snapshotId: `s${i}`, uri: 'file:///a.ts', createdAt: 100,
		}));
		const evicted = new Set(planVersionPrune(refs, 2));
		assert.ok(!evicted.has('s0'), '时间戳并列时应保留先出现者作为最早快照');
		assert.strictEqual(evicted.size, 2);
	});

	// ─── planCheckpointEviction ──────────────────────────────────────────────

	test('未超上限 → 不淘汰', () => {
		const cps = [{ id: 'c1', createdAt: 1, isGhost: false, snapshotIds: ['s1'] }];
		assert.deepStrictEqual(planCheckpointEviction(cps, new Set(), 200), []);
	});

	test('★ 超上限 → 从最老的开始淘汰', () => {
		const cps = Array.from({ length: 5 }, (_, i) => ({
			id: `c${i}`, createdAt: i, isGhost: false, snapshotIds: [`s${i}`],
		}));
		assert.deepStrictEqual(planCheckpointEviction(cps, new Set(), 3), ['c0', 'c1']);
	});

	test('★ 承载最早快照的检查点被跳过（撤销正确性优先于数量上限）', () => {
		const cps = Array.from({ length: 5 }, (_, i) => ({
			id: `c${i}`, createdAt: i, isGhost: false, snapshotIds: [`s${i}`],
		}));
		const removed = planCheckpointEviction(cps, new Set(['s0']), 3);
		assert.ok(!removed.includes('c0'), '含最早快照的检查点不可整体移除');
		assert.deepStrictEqual(removed, ['c1', 'c2']);
	});

	test('★ ghost 检查点不占配额', () => {
		const cps = [
			{ id: 'c0', createdAt: 0, isGhost: true, snapshotIds: [] },
			{ id: 'c1', createdAt: 1, isGhost: false, snapshotIds: ['s1'] },
			{ id: 'c2', createdAt: 2, isGhost: false, snapshotIds: ['s2'] },
		];
		assert.deepStrictEqual(planCheckpointEviction(cps, new Set(), 2), []);
	});

	// ─── selectUnreferencedSnapshotIds ───────────────────────────────────────

	test('★ 仍被引用的快照不删除（内容寻址后的引用计数）', () => {
		assert.deepStrictEqual(selectUnreferencedSnapshotIds(['s1', 's2'], new Set(['s1'])), ['s2']);
	});

	test('★ 候选去重（同一 id 多次释放只删一次）', () => {
		assert.deepStrictEqual(selectUnreferencedSnapshotIds(['s1', 's1', 's2'], new Set()), ['s1', 's2']);
	});

	test('全部仍被引用 → 空（共享快照不得误删）', () => {
		assert.deepStrictEqual(selectUnreferencedSnapshotIds(['s1'], new Set(['s1'])), []);
	});

	// ─── collectProtectedSnapshotIds ─────────────────────────────────────────

	test('★ 每个 URI 取最早快照作为受保护基线', () => {
		const refs: ISnapshotVersionRef[] = [
			{ snapshotId: 'a2', uri: 'file:///a.ts', createdAt: 20 },
			{ snapshotId: 'a1', uri: 'file:///a.ts', createdAt: 10 },
			{ snapshotId: 'b1', uri: 'file:///b.ts', createdAt: 15 },
		];
		const ids = collectProtectedSnapshotIds(refs);
		assert.ok(ids.has('a1'), 'a 文件最早快照受保护');
		assert.ok(ids.has('b1'), 'b 文件最早快照受保护');
		assert.ok(!ids.has('a2'), '较晚版本不受保护');
	});

	test('空输入 → 空集合', () => {
		assert.strictEqual(collectProtectedSnapshotIds([]).size, 0);
	});

	// ─── isSessionExpired（P0-3 TTL 清扫）────────────────────────────────────

	test('TTL 常量 = 30 天（对齐 Claude Code cleanupPeriodDays 默认）', () => {
		assert.strictEqual(CHECKPOINT_TTL_MS, 30 * 24 * 60 * 60 * 1000);
	});

	test('★ TTL：超过保留期 → 过期', () => {
		const now = 1_000_000_000_000;
		assert.strictEqual(isSessionExpired(now - CHECKPOINT_TTL_MS - 1, now), true);
	});

	test('★ TTL：保留期内 → 不过期', () => {
		const now = 1_000_000_000_000;
		assert.strictEqual(isSessionExpired(now - 1000, now), false);
	});

	test('★ TTL 边界：恰好等于保留期 → 不过期（判定用 > 而非 >=）', () => {
		const now = 1_000_000_000_000;
		assert.strictEqual(isSessionExpired(now - CHECKPOINT_TTL_MS, now), false);
	});

	test('★ TTL：时间戳缺失/非法 → 不判定过期（宁可漏清不误删用户数据）', () => {
		const now = 1_000_000_000_000;
		assert.strictEqual(isSessionExpired(0, now), false);
		assert.strictEqual(isSessionExpired(-1, now), false);
	});
});
