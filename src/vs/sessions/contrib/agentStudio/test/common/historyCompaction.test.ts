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
	extractCompactionSummary,
	extractFileOperations,
	findLastCompactionBoundaryIndex,
	findLastValidCompactionBoundaryIndex,
	formatFileOperationSummary,
	isCompactionSummaryStarved,
	isValidCompactionBoundary,
	requiredCompactionSummaryChars,
	sliceAtCompactionBoundary,
	truncateToolResultContent,
} from '../../common/historyCompaction.js';

interface IFakeMsg {
	readonly role: string;
	readonly content: string;
	readonly metadata?: {
		readonly type?: string;
		readonly originalCount?: number;
		readonly tokensSaved?: number;
		readonly summaryChars?: number;
	};
}

function msg(role: string, content: string, type?: string): IFakeMsg {
	return type ? { role, content, metadata: { type } } : { role, content };
}

/**
 * 可信边界所需的摘要填充：`isValidCompactionBoundary` 要求纯摘要字符数 ≥300
 * （信息量与被压缩量相称）。切片语义用例需要边界**生效**，故默认补足。
 */
const VALID_SUMMARY_PAD = '（早期对话细节：文件路径、命令与结论，此处省略）'.repeat(20);

/**
 * 造一条压缩边界。默认补成**可信**边界（切片用例需要它生效）；
 * 需要"摘要饥饿 / 负收益 / 元数据缺失"边界时用 `options` 显式构造。
 */
function compactionMsg(summary: string, options: {
	readonly valid?: boolean;
	readonly metadata?: Record<string, unknown>;
} = {}): IFakeMsg {
	const body = options.valid === false ? summary : `${summary}${VALID_SUMMARY_PAD}`;
	return {
		role: 'assistant',
		content: `[上下文压缩] 此前的对话历史（11 条消息）已压缩为以下摘要：\n\n${body}`,
		metadata: { type: COMPACTION_METADATA_TYPE, ...(options.metadata ?? {}) },
	};
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

suite('historyCompaction — 边界有效性（摘要饥饿 / 负收益 ⇒ 不切片）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// 事故 A（2026-09-21，日志 `vscode-app-1789994132110.log`）：输入框切模型 ⇒ 窗口塌到
	//   64k 下限 ⇒ 既有 76k 会话被判"120% 超压"⇒ 强制压缩走 RETRIEVAL 模式，
	//   **153 条消息只换回 129 token**（≈450 字符）的召回；`tokensSaved=24836 > 0` 顺利
	//   通过"有收益就插"判据 ⇒ 边界生效 ⇒ 模型永久失忆（转去 `session_search` 抓别的任务）。
	// 事故 B（`sess_ms5kriv8_0j6atj`）：`tokensSaved=-73`（压缩反而变大）+ 摘要写着「无」。
	// ⇒ 共同根因：**用"省了 token"当成功判据** —— 毁内容最容易省 token ✓。

	test('摘要饥饿判据（唯一真源）：门槛 = max(300, min(N×8, 1200))', () => {
		assert.strictEqual(requiredCompactionSummaryChars(0), 300, '无消息数信息 ⇒ 退化为绝对下限 ✓');
		assert.strictEqual(requiredCompactionSummaryChars(11), 300, '小规模压缩 ⇒ 88 <300 ⇒ 取下限 ✓');
		assert.strictEqual(requiredCompactionSummaryChars(153), 1200, '153×8=1224 ⇒ 被上限 1200 截住 ✓');
		assert.strictEqual(isCompactionSummaryStarved(450, 153), true, '本次事故的实际数字：450 <1200 ⇒ 饥饿 ✓');
		assert.strictEqual(isCompactionSummaryStarved(1300, 153), false, '信息量相称 ⇒ 不饥饿 ✓');
		assert.strictEqual(isCompactionSummaryStarved(0, 11), true, '空摘要一律饥饿 ✓');
		assert.strictEqual(isCompactionSummaryStarved(Number.NaN, 11), true, 'NaN 不得被当成"足够" ✓');
	});

	test('extractCompactionSummary：剥离固定前缀与"最近指令原文"尾部', () => {
		const content = '[上下文压缩] 此前的对话历史（11 条消息）已压缩为以下摘要：\n\n'
			+ '## 摘要正文\n关键结论若干\n\n---\n'
			+ '**用户最近的指令（原文保留 —— 摘要可能失真，以下为准确来源 ✗）**：\n1. 请把路径找出来';
		assert.strictEqual(extractCompactionSummary(content), '## 摘要正文\n关键结论若干',
			'尾部 fail-safe 的原文不得被算作摘要信息量 ✓（否则空壳边界会被它撑过门槛 ✗）');
	});

	test('★ 摘要饥饿的有收益边界（153 条 → 129 token）⇒ **不切片**（模型恢复看到全部）', () => {
		const history = [
			msg('user', '请把 agent 存储路径找出来'),
			msg('assistant', '我先看看'),
			compactionMsg('无'.repeat(150), {
				valid: false,
				metadata: { originalCount: 153, tokensSaved: 24836 },
			}),
			msg('assistant', '找到了'),
		];
		assert.strictEqual(isValidCompactionBoundary(history[2]), false,
			'450 字符 < 153×8（clamp 1200）⇒ 判不可信 ✓（tokensSaved 为正也拦得住 ✓）');
		assert.strictEqual(findLastValidCompactionBoundaryIndex(history), -1, '无可用边界 ⇒ -1 ✓');
		assert.strictEqual(sliceAtCompactionBoundary(history).length, 3,
			'不切片 ⇒ 历史全部保留（4 条 − 被剔除的不可信边界标记 = 3 条）✓ 这就是"救回现场"的机制 ✓');
	});

	test('★ 负收益边界（真机 sess_ms5kriv8_0j6atj：tokensSaved=-73）⇒ 不切片', () => {
		const history = [
			msg('user', 'u1'),
			compactionMsg('## Active Task（当前任务）\n无', {
				valid: false,
				metadata: { originalCount: 11, tokensSaved: -73 },
			}),
			msg('assistant', 'a1'),
		];
		assert.strictEqual(isValidCompactionBoundary(history[1]), false,
			'压缩反而变大（-73）⇒ 该边界只有"销毁上下文"一种效果 ✓');
		assert.strictEqual(sliceAtCompactionBoundary(history).length, 2);
	});

	test('★ 不可信边界**不进模型视野**（"摘要：无"的标记不得误导模型以为自己丢过历史）', () => {
		const history = [
			msg('user', 'u1'),
			compactionMsg('无', { valid: false, metadata: { originalCount: 11, tokensSaved: -73 } }),
			msg('assistant', 'a1'),
		];
		const visible = sliceAtCompactionBoundary(history);
		assert.ok(!visible.some(m => m.content.includes('[上下文压缩]')),
			'不可信边界标记必须被剔除 ✓（否则模型读到自己"已被压缩"⇒ 主动放弃上下文 ✗）');
	});

	test('可信边界（长摘要 + 正收益）⇒ 切片且保留边界消息', () => {
		const history = [
			msg('user', 'old q'),
			msg('assistant', 'old a'),
			compactionMsg('SUMMARY', { metadata: { originalCount: 11, tokensSaved: 4200 } }),
			msg('user', 'new q'),
		];
		const result = sliceAtCompactionBoundary(history);
		assert.strictEqual(result.length, 2, '丢弃边界之前的 2 条 ✓');
		assert.ok(result[0].content.includes('SUMMARY'), '可信边界（承载真摘要）必须保留 ✓');
	});

	test('★ 尾部边界失效时，更早的**可信**边界仍生效（不把已正确摘要的更早历史重新灌回）', () => {
		const history = [
			msg('user', 'v0'),
			compactionMsg('早期摘要', { metadata: { originalCount: 30, tokensSaved: 9000 } }),
			msg('assistant', 'mid'),
			compactionMsg('无', { valid: false, metadata: { originalCount: 153, tokensSaved: 24836 } }),
			msg('assistant', '最后'),
		];
		const result = sliceAtCompactionBoundary(history);
		assert.strictEqual(result.length, 3,
			'从**可信**边界起切片（v0 丢弃）+ 剔除不可信尾部边界 ⇒ 3 条 ✓');
		assert.ok(result[0].content.includes('早期摘要'));
	});

	test('元数据缺失（旧数据）⇒ 仅按摘要字符量判（仍能拦住饥饿摘要）', () => {
		const short: IFakeMsg = {
			role: 'assistant',
			content: '[上下文压缩] 此前的对话历史（99 条消息）已压缩为以下摘要：\n\n太短',
			metadata: { type: COMPACTION_METADATA_TYPE },
		};
		assert.strictEqual(isValidCompactionBoundary(short), false, '无 originalCount 时退化为 300 字符下限 ✓');
		const long: IFakeMsg = {
			role: 'assistant',
			content: `[上下文压缩] 此前的对话历史（99 条消息）已压缩为以下摘要：\n\n${'x'.repeat(400)}`,
			metadata: { type: COMPACTION_METADATA_TYPE },
		};
		assert.strictEqual(isValidCompactionBoundary(long), true);
	});

	test('非边界消息不参与（isValidCompactionBoundary 对普通消息恒 false）', () => {
		assert.strictEqual(isValidCompactionBoundary(msg('assistant', 'x'.repeat(500), 'orchestration_plan')), false);
		assert.strictEqual(isValidCompactionBoundary(msg('user', 'x'.repeat(500))), false);
	});
});

suite('historyCompaction — extractFileOperations（文件操作累计，确定性）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// 2026-09-21：编码任务里"读过/改过哪些文件"是压缩后最贵的一类信息，而摘要 LLM
	// 可能漏掉、检索式重构更常只回 129 token ⇒ 这里从工具调用**确定性**提取并追加到
	// 摘要尾部（对齐 pi `formatFileOperations`），不依赖摘要质量、永远在场。

	test('读/写分类 + 去重（按首次出现序）', () => {
		const messages = [
			{ role: 'assistant', toolCalls: [
				{ name: 'file_read', arguments: '{"filePath":"a.ts"}' },
				{ name: 'file_write', arguments: '{"filePath":"b.ts"}' },
			] },
			{ role: 'assistant', toolCalls: [
				{ name: 'patch', arguments: '{"filePath":"b.ts"}' },
				{ name: 'file_read', arguments: '{"filePath":"a.ts"}' },
				{ name: 'grep', arguments: '{"path":"src/x.ts"}' },
			] },
		];
		const ops = extractFileOperations(messages);
		assert.deepStrictEqual(ops.read, ['a.ts', 'src/x.ts']);
		assert.deepStrictEqual(ops.modified, ['b.ts'], '同一文件的多次写入只计一次 ✓');
	});

	test('非文件工具 / 坏 JSON / 空路径 ⇒ 跳过（宁可漏一条，也不让坏数据阻断压缩）', () => {
		const messages = [
			{ role: 'assistant', toolCalls: [
				{ name: 'session_search', arguments: '{"query":"q"}' },
				{ name: 'file_read', arguments: '{broken json' },
				{ name: 'file_write', arguments: '{"filePath":""}' },
				{ name: 'terminal', arguments: '{"command":"npm test"}' },
			] },
		];
		assert.deepStrictEqual(extractFileOperations(messages), { read: [], modified: [] });
	});

	test('arguments 为对象（非 JSON 字符串）也能取路径', () => {
		const ops = extractFileOperations([
			{ role: 'assistant', toolCalls: [{ name: 'file_edit', arguments: { filePath: 'c.ts' } }] },
		]);
		assert.deepStrictEqual(ops.modified, ['c.ts']);
	});

	test('formatFileOperationSummary：空 ⇒ 空串；非空 ⇒ 读/改两类分条', () => {
		assert.strictEqual(formatFileOperationSummary({ read: [], modified: [] }), '');
		const text = formatFileOperationSummary({ read: ['a.ts'], modified: ['b.ts', 'c.ts'] });
		assert.ok(text.includes('修改（2 个）') && text.includes('b.ts') && text.includes('c.ts'));
		assert.ok(text.includes('读取（1 个）') && text.includes('a.ts'));
	});

	test('★ 封顶（M2）：长会话清单必须有界，截尾丢最早的、并报出省略条数', () => {
		const calls = Array.from({ length: 25 }, (_, i) => ({ name: 'file_read', arguments: `{"filePath":"f${i}.ts"}` }));
		const ops = extractFileOperations([{ role: 'assistant', toolCalls: calls }]);
		assert.strictEqual(ops.read.length, 20, '超过 20 个必须截尾（对齐 MiMo FILE_MANIFEST_LIMIT 思路）✓');
		assert.strictEqual(ops.truncatedRead, 5, '截掉的条数要显式报出 ✓');
		assert.strictEqual(ops.read[0], 'f5.ts', '丢的是最早的 f0-f4 ✓');
		assert.strictEqual(ops.read.at(-1), 'f24.ts', '最近的必须留下 ✓');
		assert.ok(formatFileOperationSummary(ops).includes('另有 5 个更早的从略'), '格式要交代省略量 ✓');
	});

	test('复用会把文件挪到"最近使用"端 ⇒ 封顶时优先保留', () => {
		const calls = [
			...Array.from({ length: 21 }, (_, i) => ({ name: 'file_read', arguments: `{"filePath":"f${i}.ts"}` })),
			{ name: 'file_read', arguments: '{"filePath":"f0.ts"}' }, // 复用最早的 f0 ⇒ 挪到末尾 ⇒ 不丢
		];
		const ops = extractFileOperations([{ role: 'assistant', toolCalls: calls }]);
		assert.strictEqual(ops.read.length, 20);
		assert.ok(ops.read.includes('f0.ts'), '最近又碰过的文件必须留下 ✓');
		assert.ok(!ops.read.includes('f1.ts'), 'f1 成为最旧的被截掉 ✓');
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
