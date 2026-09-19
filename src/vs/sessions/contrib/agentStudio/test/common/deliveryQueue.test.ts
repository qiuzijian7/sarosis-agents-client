/**
 * DeliveryQueue 单测 —— 租约状态机的关键语义。
 *
 * 为什么这些用例重要：队列服务于「运行中消息注入」，三个失效模式
 * （重复投递 / 崩溃丢失 / 永久卡死）都靠租约语义规避。若以下断言不成立，
 * 用户消息可能被投两次（副作用翻倍）或永久卡住。
 */

import * as assert from 'assert';
import {
	createDeliveryQueue,
	DEFAULT_LEASE_TTL_MS,
	DEFAULT_MAX_CONTENT_CHARS,
} from '../../common/deliveryQueue.js';

suite('DeliveryQueue — 租约状态机', () => {

	test('enqueue 后为 pending，peek 可见且不占用租约', () => {
		const q = createDeliveryQueue();
		q.enqueue({ id: 'm1', from: 'user', to: 'agent-a', content: 'hello' });

		const peeked = q.peek('agent-a');
		assert.strictEqual(peeked.length, 1);
		assert.strictEqual(peeked[0].status, 'pending');
		// peek 是只读的：不改变状态，可反复调用
		assert.strictEqual(q.peek('agent-a').length, 1);
		assert.strictEqual(q.stats().pending, 1);
	});

	test('lease 原子领取：按 enqueue 序，且第二次 lease 领不到已领走的', () => {
		const q = createDeliveryQueue();
		q.enqueue({ id: 'm1', from: 'user', to: 'agent-a', content: 'first' });
		q.enqueue({ id: 'm2', from: 'user', to: 'agent-a', content: 'second' });

		const leased = q.lease('agent-a', 'lease-1');
		assert.deepStrictEqual(leased.map(i => i.id), ['m1', 'm2']);
		assert.ok(leased.every(i => i.status === 'in_progress' && i.leaseId === 'lease-1'));

		// 已领走的不能被再次领取 —— 这是「不重复投递」的核心保证
		assert.strictEqual(q.lease('agent-a', 'lease-2').length, 0);
	});

	test('lease 按 to 过滤：不同目标的队列互不干扰', () => {
		const q = createDeliveryQueue();
		q.enqueue({ id: 'm1', from: 'user', to: 'agent-a', content: 'for A' });
		q.enqueue({ id: 'm2', from: 'user', to: 'agent-b', content: 'for B' });

		assert.deepStrictEqual(q.lease('agent-a', 'l1').map(i => i.id), ['m1']);
		assert.deepStrictEqual(q.lease('agent-b', 'l2').map(i => i.id), ['m2']);
	});

	test('ack 仅对 in_progress 生效，注入成功后不可再被领取', () => {
		const q = createDeliveryQueue();
		q.enqueue({ id: 'm1', from: 'user', to: 'agent-a', content: 'hello' });
		q.lease('agent-a', 'lease-1');

		assert.strictEqual(q.ack(['m1']), 1);
		assert.strictEqual(q.stats().delivered, 1);
		assert.strictEqual(q.lease('agent-a', 'lease-2').length, 0);

		// 幂等：重复 ack 无副作用（不是 in_progress 了，返回 0）
		assert.strictEqual(q.ack(['m1']), 0);
	});

	test('release 归还租约：回到 pending，attempts+1，可被重新领取', () => {
		const q = createDeliveryQueue();
		q.enqueue({ id: 'm1', from: 'user', to: 'agent-a', content: 'hello' });
		q.lease('agent-a', 'lease-1');

		assert.strictEqual(q.release('lease-1'), 1);
		assert.strictEqual(q.stats().pending, 1);

		const releasd = q.peek('agent-a')[0];
		assert.strictEqual(releasd.attempts, 1, 'release 必须累加 attempts 以便识别反复失败的交付');

		// 归还后必须能被重新领取 —— 否则注入失败的消息就永久丢了
		const leased = q.lease('agent-a', 'lease-2');
		assert.deepStrictEqual(leased.map(i => i.id), ['m1']);
	});

	test('release 只影响自己的租约，不误伤他方', () => {
		const q = createDeliveryQueue();
		q.enqueue({ id: 'm1', from: 'user', to: 'agent-a', content: 'a' });
		q.enqueue({ id: 'm2', from: 'user', to: 'agent-a', content: 'b' });
		q.lease('agent-a', 'lease-1');

		// 用一个不存在的租约 id 归还 —— 不应改变任何状态
		assert.strictEqual(q.release('lease-nonexistent'), 0);
		assert.strictEqual(q.stats().in_progress, 2);
	});

	test('reclaimStale 回收超时租约（消费方崩溃时的兜底）', () => {
		let nowMs = 1_000_000;
		const q = createDeliveryQueue({ leaseTtlMs: 5000, now: () => nowMs });

		q.enqueue({ id: 'm1', from: 'user', to: 'agent-a', content: 'hello' });
		q.lease('agent-a', 'lease-1');
		assert.strictEqual(q.stats().in_progress, 1);

		// 未到期：不回收
		nowMs += 4000;
		assert.strictEqual(q.reclaimStale(), 0);

		// 已超时：回收回 pending
		nowMs += 2000;
		assert.strictEqual(q.reclaimStale(), 1);
		assert.strictEqual(q.stats().pending, 1);
	});

	test('超长内容在 enqueue 时截断（防止注入撑爆上下文）', () => {
		const q = createDeliveryQueue({ maxContentChars: 10 });
		const item = q.enqueue({ id: 'm1', from: 'user', to: 'agent-a', content: 'x'.repeat(100) });

		assert.ok(item.content.length < 100, '超长内容必须被截断');
		assert.ok(item.content.startsWith('x'.repeat(10)));
		assert.ok(item.content.endsWith('…[truncated]'));
	});

	test('边界内容不截断：恰好等于上限时保持原样', () => {
		const q = createDeliveryQueue({ maxContentChars: 10 });
		const item = q.enqueue({ id: 'm1', from: 'user', to: 'agent-a', content: 'x'.repeat(10) });
		assert.strictEqual(item.content, 'x'.repeat(10));
	});

	test('discard 丢弃后不可再被领取', () => {
		const q = createDeliveryQueue();
		q.enqueue({ id: 'm1', from: 'user', to: 'agent-a', content: 'hello' });

		assert.strictEqual(q.discard(['m1']), 1);
		assert.strictEqual(q.stats().discarded, 1);
		assert.strictEqual(q.lease('agent-a', 'lease-1').length, 0);
	});

	test('默认常量与文档一致', () => {
		assert.strictEqual(DEFAULT_LEASE_TTL_MS, 5 * 60 * 1000);
		assert.strictEqual(DEFAULT_MAX_CONTENT_CHARS, 6000);
	});
});
