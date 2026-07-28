/*---------------------------------------------------------------------------------------------
 *  AgentLoop 策略层 — IterationBudget 单测
 *
 *  覆盖：
 *  - 消费 / 退费基础语义
 *  - Grace call（武装 → 注入提醒 → 消耗）
 *  - Snapshot/restore 中断恢复
 *  - 预算耗尽判断
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IterationBudget, type BudgetSnapshot } from '../../common/iterationBudget.js';

suite('AgentLoop — IterationBudget', () => {

	suite('基础消费 / 退费', () => {

		test('初始化：总数=10，consumed=0', () => {
			const b = new IterationBudget(10);
			assert.strictEqual(b.maxIterations, 10);
			assert.strictEqual(b.consumed, 0);
			assert.strictEqual(b.remaining, 10);
		});

		test('consume(1)：consumed=1, remaining=9', () => {
			const b = new IterationBudget(10);
			b.consume(1);
			assert.strictEqual(b.consumed, 1);
			assert.strictEqual(b.remaining, 9);
		});

		test('consume(3)：consumed=3, remaining=7', () => {
			const b = new IterationBudget(10);
			b.consume(3);
			assert.strictEqual(b.consumed, 3);
			assert.strictEqual(b.remaining, 7);
		});

		test('consume 超出 max：remaining 不会为负', () => {
			const b = new IterationBudget(5);
			b.consume(10);
			assert.strictEqual(b.consumed, 10);
			assert.ok(b.remaining >= 0);
		});

		test('refund(1)：委托轮不消耗父预算', () => {
			const b = new IterationBudget(10);
			b.consume(1);
			b.refund(1);
			assert.strictEqual(b.consumed, 0);
			assert.strictEqual(b.remaining, 10);
		});

		test('refund 不超过已消费量', () => {
			const b = new IterationBudget(10);
			b.consume(2);
			b.refund(5);
			assert.strictEqual(b.consumed, 0);
		});

		test('连续 consume + refund 正确追踪', () => {
			const b = new IterationBudget(10);
			b.consume(1); // 1/10
			b.consume(1); // 2/10
			b.refund(1);  // 1/10
			b.consume(1); // 2/10
			assert.strictEqual(b.consumed, 2);
			assert.strictEqual(b.remaining, 8);
		});
	});

	suite('Grace Call 武装 / 消耗', () => {

		test('初始 grace 未武装', () => {
			const b = new IterationBudget(10);
			assert.strictEqual(b.isGraceArmed(), false);
			assert.strictEqual(b.isGraceUsed(), false);
		});

		test('armGraceCall() 后 isGraceArmed=true', () => {
			const b = new IterationBudget(10);
			b.armGraceCall();
			assert.strictEqual(b.isGraceArmed(), true);
			assert.strictEqual(b.isGraceUsed(), false);
		});

		test('consumeGrace() 未武装也不抛错（直接设置 flags）', () => {
			const b = new IterationBudget(10);
			// consumeGrace 不抛错，只是设置内部标志位
			b.consumeGrace();
			assert.strictEqual(b.isGraceArmed(), false);
		});

		test('armGraceCall + consumeGrace：grace 已消耗', () => {
			const b = new IterationBudget(10);
			b.armGraceCall();
			b.consumeGrace();
			assert.strictEqual(b.isGraceArmed(), false);
			assert.strictEqual(b.isGraceUsed(), true);
		});

		test('重复 armGraceCall 幂等', () => {
			const b = new IterationBudget(10);
			b.armGraceCall();
			b.armGraceCall();
			assert.strictEqual(b.isGraceArmed(), true);
			b.consumeGrace();
		});

		test('grace 消耗后不可再次 arm：_graceUsed=true 阻止 isGraceArmed', () => {
			const b = new IterationBudget(10);
			b.armGraceCall();
			b.consumeGrace();
			// _graceUsed=true → isGraceArmed() 永远返回 false（grace 仅一次）
			b.armGraceCall();
			assert.strictEqual(b.isGraceArmed(), false);
		});
	});

	suite('Snapshot / Restore（V3 中断恢复）', () => {

		test('snapshot 包含所有预算状态', () => {
			const b = new IterationBudget(15);
			b.consume(5);
			b.armGraceCall();
			const snap = b.snapshot();
			assert.strictEqual(snap.maxIterations, 15);
			assert.strictEqual(snap.consumed, 5);
			assert.strictEqual(snap.remaining, 10);
			assert.strictEqual(snap.graceCall, true);
			assert.strictEqual(snap.graceUsed, false);
		});

		test('restore 从快照重建预算实例', () => {
			const b = new IterationBudget(15);
			b.consume(7);
			b.armGraceCall();
			b.consumeGrace();
			const snap = b.snapshot();
			const restored = IterationBudget.restore(snap);
			assert.strictEqual(restored.maxIterations, 15);
			assert.strictEqual(restored.consumed, 7);
			assert.strictEqual(restored.remaining, 8);
			assert.strictEqual(restored.isGraceArmed(), false);
			// _graceUsed=true 已消费，无法再次 arm
		});

		test('restore 原始快照零修改', () => {
			const b = new IterationBudget(20);
			b.consume(3);
			const snap1 = b.snapshot();
			const snap2: BudgetSnapshot = { ...snap1 };
			IterationBudget.restore(snap1);
			// snapshot 不可变——restore 不修改传入对象
			assert.deepStrictEqual(snap1, snap2);
		});

		test('restore 后可继续消费', () => {
			const b = new IterationBudget(10);
			b.consume(4);
			const restored = IterationBudget.restore(b.snapshot());
			restored.consume(2);
			assert.strictEqual(restored.consumed, 6);
			assert.strictEqual(restored.remaining, 4);
		});

		test('零消费快照正确恢复', () => {
			const b = new IterationBudget(30);
			const restored = IterationBudget.restore(b.snapshot());
			assert.strictEqual(restored.maxIterations, 30);
			assert.strictEqual(restored.consumed, 0);
			assert.strictEqual(restored.remaining, 30);
		});
	});

	suite('预算耗尽判断', () => {

		test('初始 remaining > 0', () => {
			const b = new IterationBudget(10);
			assert.ok(b.remaining > 0);
		});

		test('消费到上限 remaining=0', () => {
			const b = new IterationBudget(3);
			b.consume(3);
			assert.strictEqual(b.remaining, 0);
		});

		test('消费小于上限 remaining > 0', () => {
			const b = new IterationBudget(3);
			b.consume(2);
			assert.ok(b.remaining > 0);
		});

		test('超消费 remaining 非正', () => {
			const b = new IterationBudget(1);
			b.consume(5);
			assert.ok(b.remaining <= 0);
		});
	});
});
