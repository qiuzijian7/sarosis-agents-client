/*---------------------------------------------------------------------------------------------
 *  AgentOS — AgentRunState reducer 单测（reducer 化 Step 1）
 *
 *  覆盖：
 *  - 初始 state 工厂
 *  - 各 channel reducer 的纯函数语义（不可变、正确合并）
 *  - 控制逻辑纯函数（detectToolCallLoop / 上限判定）
 *  全部不依赖 live model / provider。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	AgentRunState,
	AgentAction,
	createInitialRunState,
	reduceRunState,
	appendMessages,
	insertMessages,
	compactMessages,
	appendToolHistory,
	detectToolCallLoop,
	reachedReflectLimit,
	RUN_STATE_LIMITS,
	classifyIncompleteTurn,
	resolveIncompleteTurnRetryInstruction,
	incompleteTurnRetryLimit,
	incompleteTurnDiscardReason,
	resolveRecoveryInstruction,
	isTransientStreamError,
	snapshotRunState,
	restoreRunState,
	prepareResumeRunState,
	AGENT_RUN_STATE_VERSION,
} from '../../common/agentRunState.js';
import { AgentGraph, createInitialGraphRunState } from '../../common/agentGraph.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function reduceAll(state: AgentRunState, actions: AgentAction[]): AgentRunState {
	return actions.reduce(reduceRunState, state);
}

/** 本地最小图（避免跨测试文件导入 makeGraph，防止重复注册用例） */
function makeMiniGraph(): AgentGraph {
	return {
		id: 'g1',
		entryNodeId: 'sup',
		nodes: {
			sup: { id: 'sup', agentId: 'a-sup', kind: 'supervisor' },
			w1: { id: 'w1', agentId: 'a-w1', kind: 'worker' },
			w2: { id: 'w2', agentId: 'a-w2', kind: 'worker' },
		},
		edges: [{ from: 'sup', to: 'w1' }, { from: 'w1', to: 'w2' }],
	};
}

suite('AgentRunState - reducer (reducer 化 Step 1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── 初始 state 工厂 ──────────────────────────────────────────
	test('createInitialRunState seeds system + request messages, all counters zero', () => {
		const s = createInitialRunState({
			systemPrompt: 'be helpful',
			messages: [{ role: 'user', content: 'hi' }],
		});
		assert.deepStrictEqual(s.messages, [
			{ role: 'system', content: 'be helpful' },
			{ role: 'user', content: 'hi' },
		]);
		assert.strictEqual(s.iteration, 0);
		assert.strictEqual(s.phase, 'idle');
		assert.strictEqual(s.invalidToolNameCount, 0);
		assert.strictEqual(s.reflectCount, 0);
		assert.strictEqual(s.hasModifiedFiles, false);
		assert.deepStrictEqual(s.toolCallHistory, []);
		assert.deepStrictEqual(s.startedToolIds, []);
		assert.deepStrictEqual(s.endedToolIds, []);
		assert.strictEqual(s.reducerMode, 'reducer');
	});

	test('createInitialRunState omits system message when no systemPrompt', () => {
		const s = createInitialRunState({ messages: [{ role: 'user', content: 'hi' }] });
		assert.deepStrictEqual(s.messages, [{ role: 'user', content: 'hi' }]);
	});

	test('createInitialRunState seeds lastRealPromptTokens and reducerMode', () => {
		const s = createInitialRunState({
			messages: [],
			lastRealPromptTokens: 1234,
			reducerMode: 'reducer',
		});
		assert.strictEqual(s.lastRealPromptTokens, 1234);
		assert.strictEqual(s.reducerMode, 'reducer');
	});

	// ─── 不可变性 ─────────────────────────────────────────────────
	test('reduceRunState never mutates the input state', () => {
		const s0 = createInitialRunState({ messages: [{ role: 'user', content: 'a' }] });
		const s1 = reduceRunState(s0, { type: 'APPEND_MESSAGES', messages: [{ role: 'assistant', content: 'b' }] });
		// 原 state 未被改动
		assert.deepStrictEqual(s0.messages, [{ role: 'user', content: 'a' }]);
		// 新 state 是独立对象
		assert.notStrictEqual(s0, s1);
		assert.deepStrictEqual(s1.messages, [
			{ role: 'user', content: 'a' },
			{ role: 'assistant', content: 'b' },
		]);
	});

	// ─── channel reducers ────────────────────────────────────────
	test('APPEND_MESSAGES appends without clobbering', () => {
		const s0 = createInitialRunState({ messages: [{ role: 'user', content: 'a' }] });
		const s1 = reduceRunState(s0, { type: 'APPEND_MESSAGES', messages: [{ role: 'tool', content: 'r', toolCallId: 't1' }] });
		assert.strictEqual(s1.messages.length, 2);
		assert.strictEqual(s1.messages[1].role, 'tool');
	});

	test('COMPACT_MESSAGES replaces wholesale', () => {
		const s0 = createInitialRunState({ messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] });
		const s1 = reduceRunState(s0, { type: 'COMPACT_MESSAGES', messages: [{ role: 'system', content: 'summary' }] });
		assert.deepStrictEqual(s1.messages, [{ role: 'system', content: 'summary' }]);
	});

	test('BUMP_ITERATION increments by 1 or by N', () => {
		const s0 = createInitialRunState({ messages: [] });
		const s1 = reduceRunState(s0, { type: 'BUMP_ITERATION' });
		assert.strictEqual(s1.iteration, 1);
		const s2 = reduceRunState(s1, { type: 'BUMP_ITERATION', by: 5 });
		assert.strictEqual(s2.iteration, 6);
	});

	test('SET_PHASE updates phase only', () => {
		const s0 = createInitialRunState({ messages: [] });
		const s1 = reduceRunState(s0, { type: 'SET_PHASE', phase: 'llm_streaming' });
		assert.strictEqual(s1.phase, 'llm_streaming');
		assert.strictEqual(s0.phase, 'idle'); // 不可变
	});

	test('RECORD_TOOL_CALL appends to history (window-trimmed)', () => {
		let s = createInitialRunState({ messages: [] });
		for (let i = 0; i < RUN_STATE_LIMITS.TOOL_LOOP_WINDOW + 3; i++) {
			s = reduceRunState(s, { type: 'RECORD_TOOL_CALL', name: `t${i}`, argsHash: `h${i}` });
		}
		// 窗口裁剪：只保留最后 TOOL_LOOP_WINDOW 条
		assert.strictEqual(s.toolCallHistory.length, RUN_STATE_LIMITS.TOOL_LOOP_WINDOW);
		assert.strictEqual(s.toolCallHistory[0].name, `t${3}`);
	});

	test('INVALID_TOOL_NAME / REFLECT increment counters', () => {
		const s = reduceAll(createInitialRunState({ messages: [] }), [
			{ type: 'INVALID_TOOL_NAME' },
			{ type: 'INVALID_TOOL_NAME' },
			{ type: 'REFLECT' },
		]);
		assert.strictEqual(s.invalidToolNameCount, 2);
		assert.strictEqual(s.reflectCount, 1);
	});

	test('MARK_FILE_MODIFIED sets flag true', () => {
		const s = reduceRunState(createInitialRunState({ messages: [] }), { type: 'MARK_FILE_MODIFIED' });
		assert.strictEqual(s.hasModifiedFiles, true);
	});

	test('SET_LAST_PROMPT_TOKENS updates the persisted token count', () => {
		const s = reduceRunState(createInitialRunState({ messages: [], lastRealPromptTokens: 10 }), { type: 'SET_LAST_PROMPT_TOKENS', value: 4321 });
		assert.strictEqual(s.lastRealPromptTokens, 4321);
	});

	test('RECONCILE_ORPHANS appends ended ids', () => {
		const s = reduceRunState(createInitialRunState({ messages: [] }), { type: 'RECONCILE_ORPHANS', endedIds: ['x', 'y'] });
		assert.deepStrictEqual(s.endedToolIds, ['x', 'y']);
	});

	// ─── 控制逻辑纯函数 ───────────────────────────────────────────
	test('detectToolCallLoop counts repeated signatures and flags loop at threshold', () => {
		// 历史条目的 argsHash 须与查询时由 args 重算的 hash 一致，才能被计入（对齐函数语义）
		const args = { x: 1 };
		const hash = JSON.stringify(args).slice(0, 200);
		let hist = appendToolHistory([], { name: 'read', argsHash: hash });
		let r = detectToolCallLoop(hist, 'read', args); // 1 历史匹配 → 返回 count=2（含当前）
		assert.strictEqual(r.loop, false);
		assert.strictEqual(r.count, 2);

		hist = appendToolHistory(hist, { name: 'read', argsHash: hash });
		r = detectToolCallLoop(hist, 'read', args); // 2 历史匹配 → count=3
		assert.strictEqual(r.loop, false);
		assert.strictEqual(r.count, 3);

		hist = appendToolHistory(hist, { name: 'read', argsHash: hash });
		r = detectToolCallLoop(hist, 'read', args); // 3 历史匹配 → count=4，loop 触发（阈值 3）
		assert.strictEqual(r.loop, true);
		assert.strictEqual(r.count, 4);

		// 不同签名不计入：0 历史匹配 → count=1
		const r2 = detectToolCallLoop(hist, 'read', { x: 2 });
		assert.strictEqual(r2.loop, false);
		assert.strictEqual(r2.count, 1);
	});

	test('reachedReflectLimit respects MAX_REFLECT_ITERATIONS', () => {
		assert.strictEqual(reachedReflectLimit(0), false);
		assert.strictEqual(reachedReflectLimit(RUN_STATE_LIMITS.MAX_REFLECT_ITERATIONS), true);
	});

	// ─── 未完成轮判定（对齐 OpenClaw incomplete-turn，stopReason 驱动、无文本意图识别）──
	suite('classifyIncompleteTurn (stopReason 驱动)', () => {
		test('complete when visible text present', () => {
			assert.strictEqual(
				classifyIncompleteTurn({ finishReason: 'stop', hasVisibleText: true, hasThinking: false, hasToolCalls: false }),
				'complete',
			);
			// 即便有思考块，只要可见文本存在即为正常终轮
			assert.strictEqual(
				classifyIncompleteTurn({ finishReason: 'stop', hasVisibleText: true, hasThinking: true, hasToolCalls: false }),
				'complete',
			);
		});

		test('complete when tool calls present', () => {
			assert.strictEqual(
				classifyIncompleteTurn({ finishReason: 'stop', hasVisibleText: false, hasThinking: false, hasToolCalls: true }),
				'complete',
			);
		});

		test('length when finishReason indicates truncation and no visible text', () => {
			for (const fr of ['length', 'max_tokens', 'max_completion_tokens']) {
				assert.strictEqual(
					classifyIncompleteTurn({ finishReason: fr, hasVisibleText: false, hasThinking: false, hasToolCalls: false }),
					'length',
				);
			}
		});

		test('reasoning-only when only thinking blocks, no visible text, no tools', () => {
			assert.strictEqual(
				classifyIncompleteTurn({ finishReason: 'stop', hasVisibleText: false, hasThinking: true, hasToolCalls: false }),
				'reasoning-only',
			);
		});

		test('empty when nothing produced', () => {
			assert.strictEqual(
				classifyIncompleteTurn({ finishReason: null, hasVisibleText: false, hasThinking: false, hasToolCalls: false }),
				'empty',
			);
			assert.strictEqual(
				classifyIncompleteTurn({ finishReason: undefined, hasVisibleText: false, hasThinking: false, hasToolCalls: false }),
				'empty',
			);
		});

		test('retry instruction + limit + discard reason map per kind', () => {
			assert.strictEqual(resolveIncompleteTurnRetryInstruction('complete'), null);
			assert.ok(resolveIncompleteTurnRetryInstruction('length')?.includes('cut off'));
			assert.ok(resolveIncompleteTurnRetryInstruction('reasoning-only')?.includes('reasoning'));
			// 升级为 system-reminder 格式后不再含 'visible answer'，改为检查核心指令内容
			assert.ok(resolveIncompleteTurnRetryInstruction('empty')?.includes('NO PROGRESS'));

			assert.strictEqual(incompleteTurnRetryLimit('reasoning-only'), 2);
			assert.strictEqual(incompleteTurnRetryLimit('empty'), 2);
			assert.strictEqual(incompleteTurnRetryLimit('length'), 2);
			assert.strictEqual(incompleteTurnRetryLimit('complete'), 0);

			assert.strictEqual(incompleteTurnDiscardReason('reasoning-only'), 'empty-recovery');
			assert.strictEqual(incompleteTurnDiscardReason('empty'), 'unfinished-intent');
			assert.strictEqual(incompleteTurnDiscardReason('length'), 'unfinished-intent');
		});

		// ─── 维度 1：新增分类 ──────────────────────────────────────────
		test('filtered when content_filter finish', () => {
			for (const fr of ['content_filter', 'content-filter']) {
				assert.strictEqual(
					classifyIncompleteTurn({ finishReason: fr, hasVisibleText: false, hasThinking: false, hasToolCalls: false }),
					'filtered',
				);
			}
		});

		test('failed when error finish', () => {
			assert.strictEqual(
				classifyIncompleteTurn({ finishReason: 'error', hasVisibleText: false, hasThinking: false, hasToolCalls: false }),
				'failed',
			);
		});

		test('		filtered and failed do NOT produce retry instructions', () => {
			assert.strictEqual(resolveIncompleteTurnRetryInstruction('filtered'), null);
			assert.strictEqual(resolveIncompleteTurnRetryInstruction('failed'), null);
			assert.strictEqual(incompleteTurnRetryLimit('filtered'), 0);
			assert.strictEqual(incompleteTurnRetryLimit('failed'), 0);
		});
	});

	// ─── 维度 2+4：恢复阶梯 + 升级指令 ────────────────────────────────────────
	suite('resolveRecoveryInstruction (recovery ladder)', () => {
		test('attempt 1: soft remind for empty', () => {
			const inst = resolveRecoveryInstruction('empty', 1);
			assert.ok(inst.includes('NO PROGRESS'), 'L1 should contain NO PROGRESS');
			assert.ok(inst.includes('<system-reminder>'), 'should use system-reminder format');
			assert.ok(!inst.includes('LAST CHANCE'), 'L1 should NOT contain LAST CHANCE');
		});

		test('attempt 2: final chance for empty', () => {
			const inst = resolveRecoveryInstruction('empty', 2);
			assert.ok(inst.includes('LAST CHANCE'), 'L2 should contain LAST CHANCE');
			assert.ok(inst.includes('<system-reminder>'), 'should use system-reminder format');
		});

		test('attempt 3: still final chance (same as L2)', () => {
			const inst = resolveRecoveryInstruction('empty', 3);
			assert.ok(inst.includes('LAST CHANCE'), 'beyond limit still returns L2 text');
		});

		test('attempt escalation for reasoning-only', () => {
			assert.ok(resolveRecoveryInstruction('reasoning-only', 1).includes('NO PROGRESS'));
			assert.ok(resolveRecoveryInstruction('reasoning-only', 2).includes('LAST CHANCE'));
		});

		test('attempt escalation for length', () => {
			assert.ok(resolveRecoveryInstruction('length', 1).includes('NO PROGRESS'));
			assert.ok(resolveRecoveryInstruction('length', 2).includes('FINAL CHANCE'));
		});

		test('resolveIncompleteTurnRetryInstruction with attempt upgrades', () => {
			const l1 = resolveIncompleteTurnRetryInstruction('empty', 1);
			const l2 = resolveIncompleteTurnRetryInstruction('empty', 2);
			assert.ok(l1?.includes('NO PROGRESS') && !l1?.includes('LAST CHANCE'));
			assert.ok(l2?.includes('LAST CHANCE'));
		});
	});

	// ─── 维度 3：瞬态错误检测 ─────────────────────────────────────────────────
	suite('isTransientStreamError', () => {
		test('SSE timeout is transient', () => {
			assert.ok(isTransientStreamError(new Error('SSE read timed out')));
			assert.ok(isTransientStreamError(new Error('socket hang up')));
		});

		test('HTTP 429 / 5xx are transient', () => {
			assert.ok(isTransientStreamError(Object.assign(new Error('too many'), { status: 429 })));
			assert.ok(isTransientStreamError(Object.assign(new Error('error'), { statusCode: 503 })));
			assert.ok(isTransientStreamError(Object.assign(new Error('error'), { statusCode: 529 })));
		});

		test('ECONNRESET / EPIPE / ETIMEDOUT are transient', () => {
			assert.ok(isTransientStreamError(Object.assign(new Error('hang'), { code: 'ECONNRESET' })));
			assert.ok(isTransientStreamError(Object.assign(new Error('pipe'), { code: 'EPIPE' })));
			assert.ok(isTransientStreamError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
		});

		test('upstream_error / EOF are transient', () => {
			assert.ok(isTransientStreamError(new Error('upstream_error in proxy')));
			assert.ok(isTransientStreamError(new Error('unexpected EOF')));
		});

		test('non-transient errors return false', () => {
			assert.ok(!isTransientStreamError(new Error('normal error')));
			assert.ok(!isTransientStreamError(null));
			assert.ok(!isTransientStreamError(undefined));
			assert.ok(!isTransientStreamError('string error'));
		});

		test('auth errors (401/403) are NOT transient', () => {
			assert.ok(!isTransientStreamError(Object.assign(new Error('auth'), { status: 401 })));
			assert.ok(!isTransientStreamError(Object.assign(new Error('forbidden'), { statusCode: 403 })));
		});
	});

	test('appendMessages / compactMessages primitives behave', () => {
		assert.deepStrictEqual(appendMessages([{ role: 'a' }], { role: 'b' }, { role: 'c' }), [
			{ role: 'a' }, { role: 'b' }, { role: 'c' },
		]);
		assert.deepStrictEqual(compactMessages([{ role: 'old' }], [{ role: 'new' }]), [{ role: 'new' }]);
	});

	test('insertMessages inserts at index without clobbering (memory / durable injection)', () => {
		const base = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
		// 插在 system 之后、user 之前（对齐 loop 内 insertIdx = 1）
		const out = insertMessages(base, 1, { role: 'system', content: 'injected' });
		assert.deepStrictEqual(out, [
			{ role: 'system', content: 'sys' },
			{ role: 'system', content: 'injected' },
			{ role: 'user', content: 'hi' },
		]);
		// 不修改入参
		assert.strictEqual(base.length, 2);
		// 越界下标被夹紧
		assert.deepStrictEqual(insertMessages(base, 99, { role: 'x' }), [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'hi' },
			{ role: 'x' },
		]);
	});

	// ─── Snapshot / Restore（Step 5：checkpoint 地基）──────────────
	suite('snapshot / restore (Step 5)', () => {
		test('snapshotRunState deep-clones and is versioned', () => {
			const s = createInitialRunState({ messages: [{ role: 'user', content: 'hi' }] });
			const snap = snapshotRunState(s);
			assert.strictEqual(snap.version, AGENT_RUN_STATE_VERSION);
			// 深拷贝：修改原 state 不影响快照
			s.messages.push({ role: 'assistant', content: 'mutate' });
			assert.strictEqual(snap.state.messages.length, 1);
			assert.notStrictEqual(snap.state, s);
		});

		test('restoreRunState round-trips a valid snapshot', () => {
			const s = createInitialRunState({ messages: [{ role: 'user', content: 'hi' }] });
			s.invalidToolNameCount = 3;
			const restored = restoreRunState(snapshotRunState(s));
			assert.strictEqual(restored.invalidToolNameCount, 3);
			assert.deepStrictEqual(restored.messages, [{ role: 'user', content: 'hi' }]);
		});

		test('restoreRunState never throws on malformed input (undefined / {})', () => {
			assert.doesNotThrow(() => restoreRunState(undefined));
			const r1 = restoreRunState(undefined);
			assert.strictEqual(r1.graph, undefined);
			assert.strictEqual(r1.phase, 'idle');
			const r2 = restoreRunState({});
			assert.strictEqual(r2.invalidToolNameCount, 0);
		});

		test('restoreRunState fills missing fields from defaults (partial state)', () => {
			const partial = { iteration: 7, hasModifiedFiles: true } as any;
			const r = restoreRunState(partial);
			assert.strictEqual(r.iteration, 7);
			assert.strictEqual(r.hasModifiedFiles, true);
			// 缺失字段补全为合法默认值
			assert.strictEqual(r.phase, 'idle');
			assert.deepStrictEqual(r.toolCallHistory, []);
			assert.strictEqual(r.reducerMode, 'reducer');
		});

		test('restoreRunState rejects unknown/higher version', () => {
			const s = createInitialRunState({});
			const snap = snapshotRunState(s) as any;
			snap.version = AGENT_RUN_STATE_VERSION + 100;
			const r = restoreRunState(snap);
			assert.strictEqual(r.phase, 'idle');
			assert.strictEqual(r.iteration, 0);
		});

		test('restoreRunState normalizes graph sub-state (partial graph)', () => {
			const restored = restoreRunState({
				graph: { nodeThreads: { n1: [{ role: 'user', content: 'x' }] }, currentNodeId: 'n1' },
			} as any);
			assert.ok(restored.graph);
			assert.strictEqual(restored.graph!.currentNodeId, 'n1');
			assert.deepStrictEqual(restored.graph!.nodeThreads['n1'], [{ role: 'user', content: 'x' }]);
			// 缺失 graph 子字段补默认
			assert.deepStrictEqual(restored.graph!.sharedMemory, {});
			assert.deepStrictEqual(restored.graph!.nodeStatus, {});
		});

		test('SET_CURRENT_NODE updates currentNodeId (no-op when no graph)', () => {
			const s = createInitialRunState({ messages: [] });
			// 单 agent 无 graph → no-op
			const s1 = reduceRunState(s, { type: 'SET_CURRENT_NODE', nodeId: 'w2' });
			assert.strictEqual(s1, s);
			// 图模式 → 更新
			const g = createInitialRunState({ graphRunState: createInitialGraphRunState(makeMiniGraph()) });
			const g1 = reduceRunState(g, { type: 'SET_CURRENT_NODE', nodeId: 'w2' });
			assert.strictEqual(g1.graph!.currentNodeId, 'w2');
		});
	});

	// ─── Resume 起点（Step D）─────────────────────────────────────
	suite('prepareResumeRunState (Step D)', () => {
		const g = makeMiniGraph();

		test('resumes from restored currentNodeId', () => {
			const restored = createInitialRunState({ graphRunState: createInitialGraphRunState(g) });
			restored.graph!.currentNodeId = 'w2';
			restored.graph!.nodeStatus['w2'] = 'done';
			const plan = prepareResumeRunState(g, restored);
			assert.strictEqual(plan.startNodeId, 'w2');
			assert.strictEqual(plan.runState.graph!.currentNodeId, 'w2');
		});

		test('falls back to entry when restored has no graph', () => {
			const plan = prepareResumeRunState(g, createInitialRunState({ messages: [] }));
			assert.strictEqual(plan.startNodeId, g.entryNodeId);
			assert.ok(plan.runState.graph);
		});

		test('falls back to entry when currentNodeId missing/invalid', () => {
			const noCur = createInitialRunState({ graphRunState: createInitialGraphRunState(g) });
			assert.strictEqual(prepareResumeRunState(g, noCur).startNodeId, g.entryNodeId);
			const badCur = createInitialRunState({ graphRunState: createInitialGraphRunState(g) });
			badCur.graph!.currentNodeId = 'ghost';
			assert.strictEqual(prepareResumeRunState(g, badCur).startNodeId, g.entryNodeId);
		});

		test('undefined restored → fresh entry start', () => {
			const plan = prepareResumeRunState(g, undefined);
			assert.strictEqual(plan.startNodeId, g.entryNodeId);
			assert.ok(plan.runState.graph);
		});
	});
});
