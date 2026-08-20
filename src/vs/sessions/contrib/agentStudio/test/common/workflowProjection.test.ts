/*---------------------------------------------------------------------------------------------
 *  WF-C4b — M4b 运行时投影测试（实施计划 §2.9 C4.7-C4.10）。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { buildWorkflowProjection, renderProjectionSummary, type IWorkflowProjection } from '../../common/workflow/projection.js';
import type { WorkflowEngineEvent } from '../../common/workflow/types.js';

const RID = 'wf-t';

function start(seq: number, label = `a${seq}`, phase?: string): WorkflowEngineEvent {
	return { type: 'agent-start', id: RID, info: { seq, label, ...(phase ? { phase } : {}), childId: `c${seq}` } };
}
function end(seq: number, outcome: 'completed' | 'failed' | 'cancelled' = 'completed'): WorkflowEngineEvent {
	return { type: 'agent-end', id: RID, info: { seq, label: `a${seq}`, childId: `c${seq}`, outcome } };
}
function phase(title: string): WorkflowEngineEvent { return { type: 'phase', id: RID, title }; }
function endRun(stopReason = 'completed'): WorkflowEngineEvent { return { type: 'end', id: RID, stopReason, agentsStarted: 0 }; }

suite('workflow projection (C4.7-C4.10)', () => {

	test('C4.7a 串行 3 agent → 3 层各 1，层间全连边', () => {
		const p = buildWorkflowProjection([
			start(1), end(1), start(2), end(2), start(3), end(3), endRun(),
		]);
		assert.strictEqual(p.layers.length, 3);
		assert.deepStrictEqual(p.layers.map(l => l.length), [1, 1, 1]);
		assert.deepStrictEqual(p.edges, [{ from: 1, to: 2 }, { from: 2, to: 3 }]);
		assert.strictEqual(p.agentsStarted, 3);
	});

	test('C4.7b parallel 5 重叠 → 单层 5（动态扇出真实呈现）', () => {
		const events: WorkflowEngineEvent[] = [];
		for (let i = 1; i <= 5; i++) { events.push(start(i)); }
		for (let i = 1; i <= 5; i++) { events.push(end(i)); }
		events.push(endRun());
		const p = buildWorkflowProjection(events);
		assert.strictEqual(p.layers.length, 1);
		assert.strictEqual(p.layers[0].length, 5);
		assert.deepStrictEqual(p.edges, []);
	});

	test('C4.7c pipeline 交错（1s2 完成前 2s1 开始）→ 2 项同层', () => {
		// item1 stage1 → item2 stage1 → item1 stage2 → item2 stage2（真实无 barrier 时序）
		const p = buildWorkflowProjection([
			start(1), start(2), end(1), start(3), end(2), end(3), endRun(),
		]);
		// 1、2 重叠同层；3 在 2 结束前开始（active 含 2）→ 仍与 2 同层？
		// 重放：start1(active={1},新层L1) start2(active={1,2}→L1) end1(active={2}) start3(active={2,3}→L1!)
		// —— pipeline 全程链式重叠会塌缩为单层。这是「重叠=同层」模型的已知语义：
		// 完全无 barrier 的链式 pipeline 是一条连续重叠流 → 单层呈现（扇出证据仍在宽度上）。
		assert.strictEqual(p.layers.length, 1);
		assert.strictEqual(p.layers[0].length, 3);
	});

	test('C4.7d 失败 agent 占位 + outcome 统计', () => {
		const p = buildWorkflowProjection([
			start(1), start(2), end(1, 'failed'), end(2), endRun(),
		]);
		assert.strictEqual(p.layers[0].length, 2);
		assert.strictEqual(p.layers[0].find(a => a.seq === 1)?.outcome, 'failed');
		assert.match(renderProjectionSummary(p), /✗failed/);
	});

	test('C4.8 cancel：未收敛 agent → cancelled', () => {
		const p = buildWorkflowProjection([
			start(1), start(2), end(2), endRun('cancelled'),
		]);
		assert.strictEqual(p.layers[0].find(a => a.seq === 1)?.outcome, 'cancelled');
		assert.strictEqual(p.stopReason, 'cancelled');
	});

	test('C4.9 phase 归属 + phase 序去重', () => {
		const p = buildWorkflowProjection([
			phase('扫描'), start(1), end(1),
			phase('汇总'), start(2), end(2),
			phase('扫描'), // 重复 phase 不追加
			endRun(),
		]);
		assert.deepStrictEqual(p.phases, ['扫描', '汇总']);
		assert.strictEqual(p.layers[0][0].phase, '扫描');
		assert.strictEqual(p.layers[1][0].phase, '汇总');
	});

	test('边降级：宽层笛卡尔超 64 → 代表连线', () => {
		const events: WorkflowEngineEvent[] = [];
		// 两层各 9 个 → 全连 81 > 64 → 降级：8+8=16 条代表边
		for (let i = 1; i <= 9; i++) { events.push(start(i)); }
		for (let i = 1; i <= 9; i++) { events.push(end(i)); }
		for (let i = 10; i <= 18; i++) { events.push(start(i)); }
		for (let i = 10; i <= 18; i++) { events.push(end(i)); }
		events.push(endRun());
		const p: IWorkflowProjection = buildWorkflowProjection(events);
		assert.strictEqual(p.layers.length, 2);
		assert.ok(p.edges.length <= 20, `降级后边数应 ≤20，实际 ${p.edges.length}`);
		assert.ok(p.edges.length >= 16, '代表连线至少覆盖首桥接');
	});

	test('乱序容错：agent-end 无 start 忽略 / 重复 start 保留首个', () => {
		const p = buildWorkflowProjection([
			end(99),            // 无 start → 忽略
			start(1), start(1), // 重复 → 一个
			end(1), endRun(),
		]);
		assert.strictEqual(p.agentsStarted, 1);
		assert.strictEqual(p.layers[0].length, 1);
	});

	test('摘要：无 agent 的空投影', () => {
		const p = buildWorkflowProjection([endRun()]);
		assert.strictEqual(renderProjectionSummary(p), '运行投影：无 agent 调用');
	});
});
