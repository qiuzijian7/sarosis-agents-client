/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 转录卫生（kernelTranscriptHygiene）的纯函数钉：
 *   1. 有 call 无 result ⇒ 摘 call 块（整条清空则移除消息）；
 *   2. 有 result 无 call ⇒ 移除 result 消息；
 *   3. 合法配对一字不动（幂等）；
 *   4. 混合场景的计数准确（可观测性依赖它）。
 */
import assert from 'assert';
import type { AgentMessage } from '../../browser/piLoop/types.js';
import { hasPruneEffect, pruneOrphanedToolCalls } from '../../browser/piLoop/kernelTranscriptHygiene.js';

function assistantWithCalls(...ids: string[]): AgentMessage {
	return { role: 'assistant', content: ids.map(id => ({ type: 'toolCall', id, name: 'file_read', arguments: {} })) } as unknown as AgentMessage;
}

function assistantText(text: string): AgentMessage {
	return { role: 'assistant', content: [{ type: 'text', text }] } as unknown as AgentMessage;
}

function toolResult(id: string): AgentMessage {
	return { role: 'toolResult', toolCallId: id, toolName: 'file_read', content: [{ type: 'text', text: 'ok' }], isError: false } as unknown as AgentMessage;
}

suite('kernelTranscriptHygiene（转录卫生）', () => {

	test('孤儿 call（无 result）⇒ 摘块；整条清空 ⇒ 移除消息', () => {
		const msgs: AgentMessage[] = [
			{ role: 'user', content: 'go' } as unknown as AgentMessage,
			assistantWithCalls('c1'),
		];
		const r = pruneOrphanedToolCalls(msgs);
		assert.strictEqual(r.prunedCalls, 1);
		assert.strictEqual(r.droppedMessages, 1);
		assert.strictEqual(msgs.length, 1, '空壳 assistant 整条移除');
	});

	test('部分孤儿 ⇒ 只摘孤儿块，保留文本与有结果调用', () => {
		const msgs: AgentMessage[] = [
			{ role: 'assistant', content: [
				{ type: 'text', text: 'let me look' },
				{ type: 'toolCall', id: 'ok1', name: 'file_read', arguments: {} },
				{ type: 'toolCall', id: 'orphan1', name: 'file_read', arguments: {} },
			] } as unknown as AgentMessage,
			toolResult('ok1'),
		];
		const r = pruneOrphanedToolCalls(msgs);
		assert.strictEqual(r.prunedCalls, 1);
		assert.strictEqual(r.droppedMessages, 0);
		const content = (msgs[0] as { content: Array<{ type: string; id?: string; text?: string }> }).content;
		assert.strictEqual(content.length, 2, '文本 + 合法调用保留');
		assert.ok(content.some(b => b.type === 'text'));
		assert.ok(content.some(b => b.id === 'ok1'));
		assert.ok(!content.some(b => b.id === 'orphan1'));
	});

	test('孤儿 result（无对应 call）⇒ 移除该消息', () => {
		const msgs: AgentMessage[] = [
			{ role: 'user', content: 'go' } as unknown as AgentMessage,
			toolResult('ghost'),
		];
		const r = pruneOrphanedToolCalls(msgs);
		assert.strictEqual(r.prunedResults, 1);
		assert.strictEqual(msgs.length, 1);
	});

	test('合法配对一字不动 + 幂等（连跑两次第二次全零）', () => {
		const msgs: AgentMessage[] = [
			{ role: 'user', content: 'go' } as unknown as AgentMessage,
			assistantWithCalls('c1', 'c2'),
			toolResult('c1'),
			toolResult('c2'),
			assistantText('done'),
		];
		const before = msgs.length;
		const first = pruneOrphanedToolCalls(msgs);
		assert.ok(!hasPruneEffect(first), '合法历史不应被改');
		assert.strictEqual(msgs.length, before);
		const second = pruneOrphanedToolCalls(msgs);
		assert.deepStrictEqual(second, { prunedCalls: 0, prunedResults: 0, droppedMessages: 0 });
	});

	test('混合场景计数准确（2 孤儿 call + 1 孤儿 result + 1 连带移除）', () => {
		const msgs: AgentMessage[] = [
			assistantWithCalls('orphanA'),          // 整条移除（1 call + 1 dropped）
			{ role: 'assistant', content: [
				{ type: 'toolCall', id: 'ok1', name: 'file_read', arguments: {} },
				{ type: 'toolCall', id: 'orphanB', name: 'file_read', arguments: {} },
			] } as unknown as AgentMessage,        // 摘 1 块保留 1 块
			toolResult('ok1'),
			toolResult('ghost'),                    // 孤儿 result
		];
		const r = pruneOrphanedToolCalls(msgs);
		assert.strictEqual(r.prunedCalls, 2);
		assert.strictEqual(r.prunedResults, 1);
		assert.strictEqual(r.droppedMessages, 2, '空壳 assistant + 孤儿 result 各一条');
		assert.strictEqual(msgs.length, 2, '只剩中间那条 assistant 与 ok1 结果');
	});
});
