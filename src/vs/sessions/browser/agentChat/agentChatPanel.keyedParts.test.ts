/*---------------------------------------------------------------------------------------------
 *  agentChatPanel.keyedParts.test.ts — Keyed Reconciliation 纯函数单元测试。
 *
 *  覆盖场景：
 *    1) 各 part 类型的 key 分配（thinking / text / tool / subagent）
 *    2) 空 text part 跳过
 *    3) update_plan 纳入渲染（卡片保留）
 *    4) 多 part 混合顺序保持
 *    5) tool / subagent 无 id 时 auto-${index} 兜底
 *    6) lastTextPartKey 计算
 *
 *  运行方式:
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/browser/agentChat/agentChatPanel.keyedParts.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { buildKeyedParts, lastTextPartKey } from './agentChatPanel.keyedParts.js';
import type { IMessagePart } from './agentChatTypes.js';

function textPart(text: string): IMessagePart {
	return { kind: 'text', text } as any;
}
function thinkingPart(text: string): IMessagePart {
	return { kind: 'thinking', text } as any;
}
function toolPart(name: string, id?: string): IMessagePart {
	return { kind: 'tool', tool: { name, id } } as any;
}
function subagentPart(name: string, id?: string): IMessagePart {
	return { kind: 'subagent', subAgent: { name, id } } as any;
}

suite('keyedParts - buildKeyedParts', () => {

	test('thinking part 分配稳定 key', () => {
		const result = buildKeyedParts([thinkingPart('thinking...')], 'msg1');
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].key, 'thinking:msg1#tk0');
		assert.strictEqual(result[0].index, 0);
	});

	test('text part 分配稳定 key', () => {
		const result = buildKeyedParts([textPart('hello')], 'msg1');
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].key, 'text:msg1#t0');
		assert.strictEqual(result[0].index, 0);
	});

	test('tool part 用 toolCall.id 作 key', () => {
		const result = buildKeyedParts([toolPart('file_read', 'call_123')], 'msg1');
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].key, 'tool:call_123');
	});

	test('subagent part 用 subAgent.id 作 key', () => {
		const result = buildKeyedParts([subagentPart('explore', 'sa_456')], 'msg1');
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].key, 'subagent:sa_456');
	});

	test('空 text part 被跳过', () => {
		const parts = [textPart(''), textPart('hello'), textPart('   ')];
		const result = buildKeyedParts(parts, 'msg1');
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].key, 'text:msg1#t1');
		assert.strictEqual(result[0].index, 1);
	});

	test('update_plan 保留为卡片（纳入 keyed parts）', () => {
		const parts = [
			toolPart('update_plan', 'plan_1'),
			textPart('middle'),
			toolPart('update_plan', 'plan_2'),
		];
		const result = buildKeyedParts(parts, 'msg1');
		assert.strictEqual(result.length, 3);
		assert.strictEqual(result[0].key, 'tool:plan_1');
		assert.strictEqual(result[1].key, 'text:msg1#t1');
		assert.strictEqual(result[2].key, 'tool:plan_2');
		assert.deepStrictEqual(result.map(r => r.index), [0, 1, 2]);
	});

	test('单张 update_plan 也保留', () => {
		const parts = [toolPart('update_plan', 'plan_1')];
		const result = buildKeyedParts(parts, 'msg1');
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].key, 'tool:plan_1');
		assert.strictEqual(result[0].index, 0);
	});

	test('tool 无 id 时 auto-${index} 兜底', () => {
		const result = buildKeyedParts([toolPart('file_read')], 'msg1');
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].key, 'tool:auto-0');
	});

	test('subagent 无 id 时 auto-${index} 兜底', () => {
		const result = buildKeyedParts([subagentPart('explore')], 'msg1');
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].key, 'subagent:auto-0');
	});

	test('多 part 混合顺序保持', () => {
		const parts = [
			thinkingPart('think1'),
			textPart('text1'),
			toolPart('file_read', 'tc1'),
			thinkingPart('think2'),
			textPart('text2'),
			toolPart('terminal', 'tc2'),
			subagentPart('explore', 'sa1'),
		];
		const result = buildKeyedParts(parts, 'msg1');
		assert.strictEqual(result.length, 7);
		assert.strictEqual(result[0].key, 'thinking:msg1#tk0');
		assert.strictEqual(result[1].key, 'text:msg1#t1');
		assert.strictEqual(result[2].key, 'tool:tc1');
		assert.strictEqual(result[3].key, 'thinking:msg1#tk3');
		assert.strictEqual(result[4].key, 'text:msg1#t4');
		assert.strictEqual(result[5].key, 'tool:tc2');
		assert.strictEqual(result[6].key, 'subagent:sa1');
		// 索引保持原始位置
		assert.deepStrictEqual(result.map(r => r.index), [0, 1, 2, 3, 4, 5, 6]);
	});

	test('空 parts 数组返回空列表', () => {
		const result = buildKeyedParts([], 'msg1');
		assert.strictEqual(result.length, 0);
	});

	test('纯空 text parts 返回空列表', () => {
		const parts = [textPart(''), textPart('   ')];
		const result = buildKeyedParts(parts, 'msg1');
		assert.strictEqual(result.length, 0);
	});

	test('key 在同一 msgId 下稳定（两次调用结果一致）', () => {
		const parts = [thinkingPart('t'), textPart('x'), toolPart('file_read', 'tc1')];
		const r1 = buildKeyedParts(parts, 'msg1');
		const r2 = buildKeyedParts(parts, 'msg1');
		assert.deepStrictEqual(r1.map(r => r.key), r2.map(r => r.key));
	});

	test('不同 msgId 生成不同 key', () => {
		const parts = [textPart('hello')];
		const r1 = buildKeyedParts(parts, 'msg1');
		const r2 = buildKeyedParts(parts, 'msg2');
		assert.notStrictEqual(r1[0].key, r2[0].key);
	});
});

suite('keyedParts - lastTextPartKey', () => {

	test('单个 text part 返回其 key', () => {
		const result = lastTextPartKey([textPart('hello')], 'msg1');
		assert.strictEqual(result, 'text:msg1#t0');
	});

	test('多个 text part 返回最后一个非空的 key', () => {
		const parts = [textPart('first'), thinkingPart('t'), textPart('second')];
		const result = lastTextPartKey(parts, 'msg1');
		assert.strictEqual(result, 'text:msg1#t2');
	});

	test('空 text part 不参与计算', () => {
		const parts = [textPart('first'), textPart(''), textPart('   ')];
		const result = lastTextPartKey(parts, 'msg1');
		assert.strictEqual(result, 'text:msg1#t0');
	});

	test('无 text part 返回 null', () => {
		const parts = [thinkingPart('t'), toolPart('file_read', 'tc1')];
		const result = lastTextPartKey(parts, 'msg1');
		assert.strictEqual(result, null);
	});

	test('空 parts 返回 null', () => {
		const result = lastTextPartKey([], 'msg1');
		assert.strictEqual(result, null);
	});

	test('text 在 tool 之后时正确返回', () => {
		const parts = [toolPart('file_read', 'tc1'), textPart('after tool')];
		const result = lastTextPartKey(parts, 'msg1');
		assert.strictEqual(result, 'text:msg1#t1');
	});
});
