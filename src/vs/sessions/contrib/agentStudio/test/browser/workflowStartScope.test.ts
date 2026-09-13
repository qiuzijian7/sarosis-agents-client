/*---------------------------------------------------------------------------------------------
 * W7「运行 = 从 Start 开始执行」：resolveStartScope 入口作用域 + 执行计划裁剪。
 *
 * 三条执行路径（画布全图 Run / 画布脚本导出 / headless workflowExecutionService）
 * 共用 resolveStartScope 的判定，本测试锁定其语义契约。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	resolveStartScope,
	buildExecutionPlan,
	buildParallelExecutionPlan,
	isWorkflowStartType,
	isWorkflowEndType,
	type ExecutionNodeLike,
	type ExecutionEdgeLike,
} from '../../webview/src/features/workflowEditor/comfyHost/executionGraph.js';

const ALL_EXECUTABLE = () => true;

suite('W7 Start scope (resolveStartScope)', () => {

	test('no Start node → scope null (whole graph, legacy graphs unchanged)', () => {
		const nodes: ExecutionNodeLike[] = [
			{ id: 'a', type: 'ComfyTV.ImageStage' },
			{ id: 'b', type: 'ComfyTV.EmojiStage' },
		];
		const edges: ExecutionEdgeLike[] = [{ source: 'a', target: 'b' }];
		const r = resolveStartScope(nodes, edges);
		assert.strictEqual(r.scope, null);
		assert.strictEqual(r.degraded, false);
		assert.deepStrictEqual(r.startIds, []);
	});

	test('Start wired to a business node → strict scope (downstream closure)', () => {
		const nodes: ExecutionNodeLike[] = [
			{ id: 's', type: 'Saros.Start' },
			{ id: 'p', type: 'Saros.Prompt' },
			{ id: 'stage', type: 'ComfyTV.EmojiStage' },
			{ id: 'orphan', type: 'ComfyTV.ImageStage' },
		];
		const edges: ExecutionEdgeLike[] = [
			{ source: 's', target: 'p' },
			{ source: 'p', target: 'stage' },
		];
		const r = resolveStartScope(nodes, edges);
		assert.ok(r.scope, 'scope should be computed');
		assert.deepStrictEqual([...r.scope!].sort(), ['p', 's', 'stage']);
		assert.strictEqual(r.degraded, false);
		assert.ok(!r.scope!.has('orphan'), 'unconnected node must be out of scope');
	});

	test('upstream data dependencies are pulled into scope (LoadImage → stage)', () => {
		// 关键回归：媒体链的数据源挂在 stage **上游**（不在 Start 下游），
		// 只取正向可达会把它裁掉 → stage 报「无上游图像」。
		const nodes: ExecutionNodeLike[] = [
			{ id: 's', type: 'Saros.Start' },
			{ id: 'stage', type: 'ComfyTV.EmojiStage' },
			{ id: 'load', type: 'LoadImage' },
			{ id: 'loadSrc', type: 'Saros.MediaPicker' },
		];
		const edges: ExecutionEdgeLike[] = [
			{ source: 's', target: 'stage' },
			{ source: 'load', target: 'stage' },
			{ source: 'loadSrc', target: 'load' },
		];
		const r = resolveStartScope(nodes, edges);
		assert.deepStrictEqual([...r.scope!].sort(), ['load', 'loadSrc', 's', 'stage']);
	});

	test('Start → End only → degraded (whole graph, no silent no-op)', () => {
		// 用户实拍场景：画布上摆了 Start→End，业务链独立在下方。
		// 严格裁剪会导致「点运行什么都不跑」，属于回归 → 退化为全图。
		const nodes: ExecutionNodeLike[] = [
			{ id: 's', type: 'Saros.Start' },
			{ id: 'e', type: 'Saros.End' },
			{ id: 'stage', type: 'ComfyTV.EmojiStage' },
		];
		const edges: ExecutionEdgeLike[] = [{ source: 's', target: 'e' }];
		const r = resolveStartScope(nodes, edges);
		assert.strictEqual(r.scope, null);
		assert.strictEqual(r.degraded, true);
		assert.deepStrictEqual(r.startIds, ['s']);
	});

	test('Start with no outgoing edge → degraded', () => {
		const nodes: ExecutionNodeLike[] = [
			{ id: 's', type: 'Saros.Start' },
			{ id: 'stage', type: 'ComfyTV.EmojiStage' },
		];
		const r = resolveStartScope(nodes, []);
		assert.strictEqual(r.scope, null);
		assert.strictEqual(r.degraded, true);
	});

	test('multiple Start nodes → union of their scopes', () => {
		const nodes: ExecutionNodeLike[] = [
			{ id: 's1', type: 'Saros.Start' },
			{ id: 's2', type: 'Saros.Start' },
			{ id: 'a', type: 'Saros.Agent' },
			{ id: 'b', type: 'Saros.Agent' },
			{ id: 'orphan', type: 'Saros.Agent' },
		];
		const edges: ExecutionEdgeLike[] = [
			{ source: 's1', target: 'a' },
			{ source: 's2', target: 'b' },
		];
		const r = resolveStartScope(nodes, edges);
		assert.deepStrictEqual([...r.scope!].sort(), ['a', 'b', 's1', 's2']);
	});

	test('headless lowercase node types are recognised (start / end)', () => {
		// workflowExecutionService 侧 type 已归一化为小写枚举 —— 同一套判定必须通用。
		assert.ok(isWorkflowStartType('start'));
		assert.ok(isWorkflowStartType('Saros.Start'));
		assert.ok(!isWorkflowStartType('Saros.Prompt'));
		assert.ok(isWorkflowEndType('end'));
		assert.ok(isWorkflowEndType('Saros.End'));
		const nodes: ExecutionNodeLike[] = [
			{ id: 's', type: 'start' },
			{ id: 'a', type: 'agent' },
		];
		const r = resolveStartScope(nodes, [{ source: 's', target: 'a' }]);
		assert.deepStrictEqual([...r.scope!].sort(), ['a', 's']);
	});

	test('dangling edges do not leak unknown ids into scope', () => {
		const nodes: ExecutionNodeLike[] = [
			{ id: 's', type: 'Saros.Start' },
			{ id: 'a', type: 'Saros.Agent' },
		];
		const edges: ExecutionEdgeLike[] = [
			{ source: 's', target: 'a' },
			{ source: 'a', target: 'ghost' },
			{ source: 'ghost2', target: 'a' },
		];
		const r = resolveStartScope(nodes, edges);
		assert.deepStrictEqual([...r.scope!].sort(), ['a', 's']);
	});
});

suite('W7 execution plan scoping', () => {

	const nodes: ExecutionNodeLike[] = [
		{ id: 's', type: 'Saros.Start' },
		{ id: 'inScope', type: 'ComfyTV.EmojiStage' },
		{ id: 'outScope', type: 'ComfyTV.ImageStage' },
	];
	const edges: ExecutionEdgeLike[] = [{ source: 's', target: 'inScope' }];

	test('serial plan: out-of-scope executables land in outOfScope (not skipped)', () => {
		const scope = resolveStartScope(nodes, edges).scope;
		const plan = buildExecutionPlan(nodes, edges, ALL_EXECUTABLE, scope);
		assert.deepStrictEqual(plan.steps.map(s => s.id), ['s', 'inScope']);
		assert.deepStrictEqual(plan.outOfScope, ['outScope']);
		assert.deepStrictEqual(plan.skipped, []);
		assert.strictEqual(plan.hasCycle, false);
	});

	test('parallel plan: same scoping contract', () => {
		const scope = resolveStartScope(nodes, edges).scope;
		const plan = buildParallelExecutionPlan(nodes, edges, ALL_EXECUTABLE, scope);
		assert.deepStrictEqual(plan.layers.flat().map(s => s.id), ['s', 'inScope']);
		assert.deepStrictEqual(plan.outOfScope, ['outScope']);
		assert.deepStrictEqual(plan.skipped, []);
	});

	test('no entryScope → whole graph (backward compatible)', () => {
		const plan = buildExecutionPlan(nodes, edges, ALL_EXECUTABLE);
		assert.deepStrictEqual(plan.steps.map(s => s.id).sort(), ['inScope', 'outScope', 's']);
		assert.deepStrictEqual(plan.outOfScope, []);
	});

	test('non-executable types still go to skipped, scope-independent', () => {
		const scope = resolveStartScope(nodes, edges).scope;
		const plan = buildExecutionPlan(nodes, edges, t => t !== 'ComfyTV.EmojiStage', scope);
		assert.deepStrictEqual(plan.skipped, ['inScope']);
		assert.deepStrictEqual(plan.outOfScope, ['outScope']);
		assert.deepStrictEqual(plan.steps.map(s => s.id), ['s']);
	});
});

suite('W7-flow data/flow upstream separation', () => {

	// Start --flowOut--> Emoji(flowIn)   控制边
	// LoadImage.image --> Emoji.images   数据边
	const nodes: ExecutionNodeLike[] = [
		{ id: 's', type: 'Saros.Start' },
		{ id: 'emoji', type: 'ComfyTV.EmojiStage' },
		{ id: 'load', type: 'LoadImage' },
	];
	const edges: ExecutionEdgeLike[] = [
		{ source: 's', target: 'emoji', sourceHandle: 'flowOut', targetHandle: 'flowIn' },
		{ source: 'load', target: 'emoji', sourceHandle: 'image', targetHandle: 'images' },
	];
	/** 与 workflowRunShared.makeFlowEdgeClassifier 同规则的最小桩：targetHandle=flowIn → 控制边 */
	const classifyEdge = (e: ExecutionEdgeLike) => e.targetHandle === 'flowIn';

	test('FLOW edge is excluded from data upstreams, kept in flowUpstreams', () => {
		const plan = buildExecutionPlan(nodes, edges, ALL_EXECUTABLE, null, classifyEdge);
		const emoji = plan.steps.find(s => s.id === 'emoji')!;
		assert.deepStrictEqual(emoji.upstreams, ['load'], 'data upstreams must not contain the flow source');
		assert.deepStrictEqual(emoji.flowUpstreams, ['s']);
		const s = plan.steps.find(x => x.id === 's')!;
		assert.deepStrictEqual(s.flowUpstreams, []);
	});

	test('topological order still respects FLOW edges (control dependency)', () => {
		const plan = buildExecutionPlan(nodes, edges, ALL_EXECUTABLE, null, classifyEdge);
		const ids = plan.steps.map(s => s.id);
		assert.ok(ids.indexOf('s') < ids.indexOf('emoji'), 'Start (flow upstream) must run before emoji');
	});

	test('no classifier → all edges are data upstreams (backward compatible)', () => {
		const plan = buildExecutionPlan(nodes, edges, ALL_EXECUTABLE);
		const emoji = plan.steps.find(s => s.id === 'emoji')!;
		assert.deepStrictEqual(emoji.upstreams.sort(), ['load', 's']);
		assert.deepStrictEqual(emoji.flowUpstreams, []);
	});

	test('parallel plan separates the same way', () => {
		const plan = buildParallelExecutionPlan(nodes, edges, ALL_EXECUTABLE, null, classifyEdge);
		const emoji = plan.layers.flat().find(s => s.id === 'emoji')!;
		assert.deepStrictEqual(emoji.upstreams, ['load']);
		assert.deepStrictEqual(emoji.flowUpstreams, ['s']);
	});
});
