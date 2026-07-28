/*---------------------------------------------------------------------------------------------
 *  Tests for historyCompaction — 压缩状态跨 turn 持久化 + 冻结截断文本。
 *  - findLastCompactionBoundaryIndex / sliceAtCompactionBoundary：边界回放语义
 *  - truncateToolResultContent：确定性（同一内容永远同一字节串）
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	COMPACTION_METADATA_TYPE,
	TRUNCATED_FOR_IPC_SUFFIX,
	findLastCompactionBoundaryIndex,
	sliceAtCompactionBoundary,
	truncateToolResultContent,
} from '../../common/historyCompaction.js';

interface IFakeMsg {
	readonly role: string;
	readonly content: string;
	readonly metadata?: { readonly type?: string };
}

function msg(role: string, content: string, type?: string): IFakeMsg {
	return type ? { role, content, metadata: { type } } : { role, content };
}

function compactionMsg(summary: string): IFakeMsg {
	return msg('assistant', `[上下文压缩] ...：\n\n${summary}`, COMPACTION_METADATA_TYPE);
}

suite('historyCompaction — findLastCompactionBoundaryIndex', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('no metadata at all → -1', () => {
		const history = [msg('user', 'a'), msg('assistant', 'b')];
		assert.strictEqual(findLastCompactionBoundaryIndex(history), -1);
	});

	test('no compaction boundary → -1 (other metadata types ignored)', () => {
		const history = [msg('user', 'a'), msg('assistant', 'plan', 'orchestration_plan')];
		assert.strictEqual(findLastCompactionBoundaryIndex(history), -1);
	});

	test('single boundary → its index', () => {
		const history = [msg('user', 'a'), compactionMsg('S1'), msg('assistant', 'b')];
		assert.strictEqual(findLastCompactionBoundaryIndex(history), 1);
	});

	test('multiple boundaries → the LAST one wins', () => {
		const history = [
			compactionMsg('S1'),
			msg('assistant', 'x'),
			compactionMsg('S2'),
			msg('assistant', 'y'),
		];
		assert.strictEqual(findLastCompactionBoundaryIndex(history), 2,
			'多次压缩时只有最后一条边界有效（更早边界覆盖的历史已被最新摘要承载）');
	});

	test('empty history → -1', () => {
		assert.strictEqual(findLastCompactionBoundaryIndex([]), -1);
	});
});

suite('historyCompaction — sliceAtCompactionBoundary', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('no boundary → returns the same array (backward compatible)', () => {
		const history = [msg('user', 'a'), msg('assistant', 'b')];
		const result = sliceAtCompactionBoundary(history);
		assert.strictEqual(result.length, 2);
		assert.strictEqual(result[0].content, 'a');
	});

	test('boundary in the middle → drops everything BEFORE it, keeps boundary first', () => {
		const history = [
			msg('user', 'old q'),
			msg('assistant', 'old a'),
			compactionMsg('SUMMARY'),
			msg('user', 'new q'),
			msg('assistant', 'new a'),
		];
		const result = sliceAtCompactionBoundary(history);
		assert.strictEqual(result.length, 3);
		assert.ok(result[0].content.includes('SUMMARY'), '边界消息（摘要）必须保留为历史首条');
		assert.strictEqual(result[1].content, 'new q');
		assert.strictEqual(result[2].content, 'new a');
	});

	test('boundary at index 0 → identity (nothing to drop)', () => {
		const history = [compactionMsg('S'), msg('user', 'q')];
		const result = sliceAtCompactionBoundary(history);
		assert.strictEqual(result.length, 2);
	});

	test('boundary as last message → replay keeps only the boundary', () => {
		const history = [msg('user', 'q'), msg('assistant', 'a'), compactionMsg('TAIL')];
		const result = sliceAtCompactionBoundary(history);
		assert.strictEqual(result.length, 1);
		assert.ok(result[0].content.includes('TAIL'));
	});

	test('cross-turn scenario: turn1 压缩 → turn2 只重放边界之后（不再重新膨胀）', () => {
		// 模拟 turn1: [u1, a1, tool×3, 压缩点, a2, a3(final)] → turn2 追加 [u2]
		const history = [
			msg('user', 'turn1 question'),
			msg('assistant', 'iter1'),
			msg('tool', 'huge result 1'),
			msg('tool', 'huge result 2'),
			compactionMsg('turn1 前半段摘要'),
			msg('assistant', 'iter2 post-compression'),
			msg('assistant', 'turn1 final answer'),
			msg('user', 'turn2 question'),
		];
		const replay = sliceAtCompactionBoundary(history);
		assert.strictEqual(replay.length, 4, 'turn1 压缩点之前的 4 条消息不再回灌');
		assert.ok(replay[0].content.includes('turn1 前半段摘要'));
		assert.strictEqual(replay[3].content, 'turn2 question');
	});
});

suite('historyCompaction — truncateToolResultContent (冻结截断)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('short content → unchanged', () => {
		assert.strictEqual(truncateToolResultContent('hello', 2048), 'hello');
		assert.strictEqual(truncateToolResultContent('', 2048), '');
	});

	test('exactly at limit → unchanged', () => {
		const s = 'x'.repeat(2048);
		assert.strictEqual(truncateToolResultContent(s, 2048), s);
	});

	test('over limit → head-slice + marker', () => {
		const s = 'y'.repeat(5000);
		const out = truncateToolResultContent(s, 2048);
		assert.strictEqual(out.length, 2048 + TRUNCATED_FOR_IPC_SUFFIX.length);
		assert.ok(out.startsWith('y'.repeat(2048)));
		assert.ok(out.endsWith(TRUNCATED_FOR_IPC_SUFFIX));
	});

	test('deterministic / frozen: same content always yields byte-identical output', () => {
		const s = 'z'.repeat(10000);
		const a = truncateToolResultContent(s, 2048);
		const b = truncateToolResultContent(s, 2048);
		assert.strictEqual(a, b, '同一内容必须永远得到逐字节相同的结果（跨 turn 缓存稳定的前提）');
	});

	test('truncated output is itself stable under re-truncation (idempotent)', () => {
		const s = 'w'.repeat(8000);
		const once = truncateToolResultContent(s, 2048);
		const twice = truncateToolResultContent(once, 2048);
		assert.strictEqual(once, twice, '已截断文本不应再次被截断（幂等）');
	});
});
