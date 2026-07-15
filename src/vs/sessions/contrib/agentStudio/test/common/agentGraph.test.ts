/*---------------------------------------------------------------------------------------------
 *  AgentOS — AgentGraph 纯函数 + reducer 图 action 单测（supervisor / AgentCommand(goto) Step A）
 *
 *  覆盖：
 *  - 图状态工厂 createInitialGraphRunState
 *  - 纯函数 isKnownNode / resolveGoto / staticEdgeTarget / applyCommandToState
 *  - reduceRunState 的图 action（ENTER_NODE / EXIT_NODE / SET_NODE_STATUS /
 *    WRITE_SHARED_MEMORY / SET_HANDOFF）
 *  - 单 agent 模式（graph=undefined）下上述 action 为 no-op（向后兼容）
 *  - 不可变性
 *  全部不依赖 live model / provider。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	AgentRunState,
	createInitialRunState,
	reduceRunState,
} from '../../common/agentRunState.js';
import {
	AgentGraph,
	AgentGraphNode,
	AgentCommand,
	END_NODE,
	TRANSFER_TO_AGENT_TOOL,
	createInitialGraphRunState,
	isKnownNode,
	resolveGoto,
	staticEdgeTarget,
	applyCommandToState,
	buildHandoffCommand,
	computeNextNode,
} from '../../common/agentGraph.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function makeGraph(): AgentGraph {
	return {
		id: 'g1',
		entryNodeId: 'sup',
		nodes: {
			sup: { id: 'sup', agentId: 'a-sup', kind: 'supervisor', terminalAllowed: false },
			w1: { id: 'w1', agentId: 'a-w1', kind: 'worker' },
			w2: { id: 'w2', agentId: 'a-w2', kind: 'worker' },
		},
		edges: [{ from: 'sup', to: 'w1' }, { from: 'w1', to: 'w2' }],
	};
}

function makeGraphState(graph: AgentGraph = makeGraph()): AgentRunState {
	const s = createInitialRunState({ messages: [] });
	return { ...s, graph: createInitialGraphRunState(graph) };
}

suite('AgentGraph - pure functions + reducer graph actions (Step A)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── 图状态工厂 ──────────────────────────────────────────────
	test('createInitialGraphRunState seeds all nodes pending + entry current', () => {
		const g = makeGraph();
		const gs = createInitialGraphRunState(g);
		assert.strictEqual(gs.currentNodeId, 'sup');
		assert.deepStrictEqual(gs.nodeThreads, {});
		assert.deepStrictEqual(gs.sharedMemory, {});
		assert.strictEqual(gs.handoffSummary, undefined);
		assert.deepStrictEqual(gs.nodeStatus, { sup: 'pending', w1: 'pending', w2: 'pending' });
	});

	// ─── isKnownNode ────────────────────────────────────────────
	test('isKnownNode recognizes graph nodes and END, rejects unknown', () => {
		const g = makeGraph();
		assert.strictEqual(isKnownNode(g, 'sup'), true);
		assert.strictEqual(isKnownNode(g, 'w2'), true);
		assert.strictEqual(isKnownNode(g, END_NODE), true);
		assert.strictEqual(isKnownNode(g, 'nope'), false);
	});

	// ─── resolveGoto ────────────────────────────────────────────
	test('resolveGoto returns single target as array', () => {
		const g = makeGraph();
		assert.deepStrictEqual(resolveGoto({ goto: 'w1' }, g), ['w1']);
	});

	test('resolveGoto preserves fan-out order for array targets', () => {
		const g = makeGraph();
		assert.deepStrictEqual(resolveGoto({ goto: ['w1', 'w2'] }, g), ['w1', 'w2']);
	});

	test('resolveGoto returns [] when no goto', () => {
		const g = makeGraph();
		assert.deepStrictEqual(resolveGoto({}, g), []);
	});

	test('resolveGoto allows END as target', () => {
		const g = makeGraph();
		assert.deepStrictEqual(resolveGoto({ goto: END_NODE }, g), [END_NODE]);
	});

	test('resolveGoto throws on unknown target node', () => {
		const g = makeGraph();
		assert.throws(
			() => resolveGoto({ goto: 'ghost' }, g),
			/unknown target node "ghost"/,
		);
	});

	// ─── staticEdgeTarget ───────────────────────────────────────
	test('staticEdgeTarget finds the default edge, undefined when absent', () => {
		const g = makeGraph();
		assert.strictEqual(staticEdgeTarget(g, 'sup'), 'w1');
		assert.strictEqual(staticEdgeTarget(g, 'w2'), undefined);
	});

	// ─── applyCommandToState ────────────────────────────────────
	test('applyCommandToState is a no-op for empty command', () => {
		const s = makeGraphState();
		const s2 = applyCommandToState(s, {});
		assert.strictEqual(s2, s);
	});

	test('applyCommandToState writes sharedMemory + handoff summary immutably', () => {
		const s = makeGraphState();
		const cmd: AgentCommand = { summary: 'handoff to w1', update: { ctx: 'x' } };
		const s2 = applyCommandToState(s, cmd);
		// 原 state 未变
		assert.strictEqual(s.graph!.handoffSummary, undefined);
		assert.deepStrictEqual(s.graph!.sharedMemory, {});
		// 新 state 写入
		assert.strictEqual(s2.graph!.handoffSummary, 'handoff to w1');
		assert.deepStrictEqual(s2.graph!.sharedMemory, { ctx: 'x' });
		// 独立对象
		assert.notStrictEqual(s.graph, s2.graph);
	});

	test('applyCommandToState merges into existing sharedMemory', () => {
		let s = makeGraphState();
		s = reduceRunState(s, { type: 'WRITE_SHARED_MEMORY', patch: { a: 1 } });
		const s2 = applyCommandToState(s, { update: { b: 2 } });
		assert.deepStrictEqual(s2.graph!.sharedMemory, { a: 1, b: 2 });
		// 原 state 未被覆盖
		assert.deepStrictEqual(s.graph!.sharedMemory, { a: 1 });
	});

	test('applyCommandToState lazily creates graph when undefined (single-agent safety)', () => {
		const s = createInitialRunState({ messages: [] }); // graph === undefined
		const s2 = applyCommandToState(s, { summary: 'hi' });
		assert.strictEqual(s.graph, undefined); // 原 state 不动
		assert.strictEqual(s2.graph!.handoffSummary, 'hi');
		assert.deepStrictEqual(s2.graph!.sharedMemory, {});
	});

	// ─── reducer 图 action（图模式）─────────────────────────────
	test('ENTER_NODE sets currentNodeId + running status', () => {
		let s = makeGraphState();
		s = reduceRunState(s, { type: 'ENTER_NODE', nodeId: 'w1' });
		assert.strictEqual(s.graph!.currentNodeId, 'w1');
		assert.strictEqual(s.graph!.nodeStatus['w1'], 'running');
		assert.strictEqual(s.graph!.nodeStatus['sup'], 'pending');
	});

	test('EXIT_NODE marks done + persists node thread', () => {
		let s = makeGraphState();
		const thread = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
		s = reduceRunState(s, { type: 'EXIT_NODE', nodeId: 'w1', messages: thread });
		assert.strictEqual(s.graph!.nodeStatus['w1'], 'done');
		assert.deepStrictEqual(s.graph!.nodeThreads['w1'], thread);
		// 入参未被引用修改（复制落地）
		thread.push({ role: 'user', content: 'leak' });
		assert.strictEqual(s.graph!.nodeThreads['w1'].length, 2);
	});

	test('SET_NODE_STATUS / WRITE_SHARED_MEMORY / SET_HANDOFF update only their channel', () => {
		let s = makeGraphState();
		s = reduceRunState(s, { type: 'SET_NODE_STATUS', nodeId: 'w2', status: 'error' });
		assert.strictEqual(s.graph!.nodeStatus['w2'], 'error');
		s = reduceRunState(s, { type: 'WRITE_SHARED_MEMORY', patch: { k: 'v' } });
		assert.deepStrictEqual(s.graph!.sharedMemory, { k: 'v' });
		s = reduceRunState(s, { type: 'SET_HANDOFF', summary: 'go w2' });
		assert.strictEqual(s.graph!.handoffSummary, 'go w2');
	});

	// ─── 单 agent 模式：图 action 是 no-op（向后兼容）────────────
	test('graph actions are no-ops when graph is undefined', () => {
		const s = createInitialRunState({ messages: [{ role: 'user', content: 'hi' }] });
		assert.strictEqual(s.graph, undefined);
		const noops: AgentRunState[] = [
			reduceRunState(s, { type: 'ENTER_NODE', nodeId: 'x' }),
			reduceRunState(s, { type: 'EXIT_NODE', nodeId: 'x', messages: [] }),
			reduceRunState(s, { type: 'SET_NODE_STATUS', nodeId: 'x', status: 'running' }),
			reduceRunState(s, { type: 'WRITE_SHARED_MEMORY', patch: { a: 1 } }),
			reduceRunState(s, { type: 'SET_HANDOFF', summary: 's' }),
		];
		for (const r of noops) {
			assert.strictEqual(r, s, 'graph action must be a no-op when graph is undefined');
		}
		// 单 agent 业务字段不受影响
		assert.strictEqual(s.messages.length, 1);
		assert.strictEqual(s.phase, 'idle');
	});

	// ─── 不可变性 ───────────────────────────────────────────────
	test('graph reducer actions never mutate the input graph slice', () => {
		const s = makeGraphState();
		const before = s.graph; // 丢弃 action 结果时，输入 graph slice 不应被改动
		reduceRunState(s, { type: 'ENTER_NODE', nodeId: 'w1' });
		reduceRunState(s, { type: 'WRITE_SHARED_MEMORY', patch: { a: 1 } });
		assert.strictEqual(s.graph, before, 'input graph slice must not be mutated (reducer returns a new object)');
	});

	// ─── buildHandoffCommand（Step B: transfer_to_agent 拦截）────────
	test('buildHandoffCommand returns undefined when graph is absent (single-agent mode)', () => {
		const cmd = buildHandoffCommand({ node_id: 'w1', summary: 'hi' });
		assert.strictEqual(cmd, undefined);
	});

	test('buildHandoffCommand returns undefined when node_id is missing or unknown', () => {
		const g = makeGraph();
		assert.strictEqual(buildHandoffCommand({}, g), undefined, 'missing node_id');
		assert.strictEqual(buildHandoffCommand({ node_id: 'ghost' }, g), undefined, 'unknown node');
		assert.strictEqual(buildHandoffCommand({ node_id: 123 }, g), undefined, 'wrong type');
	});

	test('buildHandoffCommand builds AgentCommand for a known node', () => {
		const g = makeGraph();
		const cmd = buildHandoffCommand({ node_id: 'w1', summary: 'handoff note' }, g);
		assert.deepStrictEqual(cmd, {
			goto: 'w1',
			summary: 'handoff note',
			update: { lastHandoffSummary: 'handoff note' },
		});
	});

	test('buildHandoffCommand accepts END_NODE as a valid target', () => {
		const g = makeGraph();
		const cmd = buildHandoffCommand({ node_id: END_NODE, summary: 'done' }, g);
		assert.strictEqual(cmd?.goto, END_NODE);
	});

	test('buildHandoffCommand tolerates missing summary (goto still set)', () => {
		const g = makeGraph();
		const cmd = buildHandoffCommand({ node_id: 'w2' }, g);
		assert.strictEqual(cmd?.goto, 'w2');
		assert.strictEqual(cmd?.summary, undefined);
		assert.deepStrictEqual(cmd?.update, { lastHandoffSummary: undefined });
	});

	test('TRANSFER_TO_AGENT_TOOL constant is stable', () => {
		assert.strictEqual(TRANSFER_TO_AGENT_TOOL, 'transfer_to_agent');
	});

	// ─── computeNextNode（Step C: 图解释器路由决策）──────────────
	suite('computeNextNode', () => {
		const g = makeGraph();

		test('follows command.goto to a known node', () => {
			const cmd: AgentCommand = { goto: 'w2', summary: 'hi' };
			assert.strictEqual(computeNextNode(g, g.nodes['sup'], cmd), 'w2');
		});

		test('worker with no goto + no static edge → END (terminalAllowed default true)', () => {
			// w2 无静态边、kind=worker（terminalAllowed 默认 true）→ END_NODE
			assert.strictEqual(computeNextNode(g, g.nodes['w2']), END_NODE);
		});

		test('supervisor with no goto + static edge → static edge target', () => {
			// sup 无 goto、terminalAllowed=false → 静态兜底边 sup→w1
			assert.strictEqual(computeNextNode(g, g.nodes['sup']), 'w1');
		});

		test('supervisor with terminalAllowed=true + no goto → END', () => {
			const supTerminal: AgentGraphNode = { ...g.nodes['sup'], terminalAllowed: true };
			assert.strictEqual(computeNextNode(g, supTerminal), END_NODE);
		});

		test('worker with terminalAllowed=false + static edge → static edge target', () => {
			const w1NoTerm: AgentGraphNode = { ...g.nodes['w1'], terminalAllowed: false };
			assert.strictEqual(computeNextNode(g, w1NoTerm), 'w2'); // 静态边 w1→w2
		});

		test('goto to END_NODE is honoured', () => {
			const cmd: AgentCommand = { goto: END_NODE };
			assert.strictEqual(computeNextNode(g, g.nodes['sup'], cmd), END_NODE);
		});
	});
});
