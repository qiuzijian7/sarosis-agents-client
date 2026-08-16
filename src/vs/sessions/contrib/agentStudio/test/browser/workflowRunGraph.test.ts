/*---------------------------------------------------------------------------------------------
 *  Unit tests for runGraphExecution — workflow-wide orchestrated execution.
 *
 *  Covers the "stop on first failure" contract, ordering, cycle short-circuit,
 *  and the runner-less pure-provider graph path. These are the semantics the
 *  planned parallel execution mode must preserve (docs/Agent-画布编排设计方案.md P1).
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { runGraphExecution } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import { MediaSnapshotStore } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';

/** In-memory backend so the real MediaSnapshotStore works in tests. */
function makeStore(): MediaSnapshotStore {
	const map = new Map<string, unknown>();
	return new MediaSnapshotStore({
		async save(key, data) { map.set(key, data); return key; },
		async load(key) { return map.get(key) ?? null; },
		async remove(key) { map.delete(key); },
	});
}

interface NodeLike { id: string; type: string; }
interface EdgeLike { source: string; target: string; }

/** A successful imagegen RPC — returns one image per call. */
function okSend(): (args: { prompt: string }) => Promise<{ images: Array<{ url: string }> }> {
	return async (args) => ({ images: [{ url: `http://img/${encodeURIComponent(args.prompt)}.png` }] });
}

/** Deterministic values provider: every node uses the same prompt. */
const nodeValues = (nodes: NodeLike[]) => Object.fromEntries(nodes.map(n => [n.id, { providerId: 'p', modelId: 'm', prompt: `prompt-${n.id}` }]));

/** Base options with all the wiring the caller (LiteGraphCanvas) provides. */
function baseOptions(nodes: NodeLike[], edges: EdgeLike[], overrides?: Partial<Parameters<typeof runGraphExecution>[0]>): Parameters<typeof runGraphExecution>[0] {
	const cardStates: Record<string, string> = {};
	return {
		nodes,
		edges,
		getSpec: () => ({ kind: 'llm' as const }),
		resolveRunner: () => { throw new Error('runner must not be resolved for a provider-only graph'); },
		snapshotStore: makeStore(),
		cardState: {
			set(id, state: { runState: string }) { cardStates[id] = state.runState; },
		},
		sendImageGen: okSend(),
		resolveImageGenDefaults: async () => ({ providerId: 'p', modelId: 'm' }),
		...overrides,
	};
}

suite('workflowRun — runGraphExecution', () => {

	test('provider-only graph runs without a ComfyUI runner', async () => {
		const nodes: NodeLike[] = [
			{ id: 'a', type: 'Saros.ModelImageGen' },
			{ id: 'b', type: 'Saros.ModelImageGen' },
		];
		const r = await runGraphExecution(baseOptions(nodes, [{ source: 'a', target: 'b' }], { nodeValues: nodeValues(nodes) }));
		assert.strictEqual(r.success, true);
		assert.deepStrictEqual(r.ran, ['a', 'b']);
		assert.strictEqual(r.failed, null);
	});

	test('stops on the first failure — downstream nodes never start', async () => {
		const nodes: NodeLike[] = [
			{ id: 'a', type: 'Saros.ModelImageGen' },
			{ id: 'b', type: 'Saros.ModelImageGen' },
			{ id: 'c', type: 'Saros.ModelImageGen' },
		];
		const started: string[] = [];
		// Only `a` succeeds; `b` returns no images; `c` would be next.
		const send = async (args: { prompt: string }) => {
			if (args.prompt.includes('b')) { return { images: [] }; }   // → '图片生成接口未返回图片'
			return { images: [{ url: 'http://img/x.png' }] };
		};
		const r = await runGraphExecution(baseOptions(nodes, [
			{ source: 'a', target: 'b' },
			{ source: 'b', target: 'c' },
		], {
			nodeValues: nodeValues(nodes),
			sendImageGen: send,
			onNodeStart: (step: { id: string }) => started.push(step.id),
		}));
		assert.strictEqual(r.success, false);
		assert.deepStrictEqual(r.ran, ['a']);
		assert.strictEqual(r.failed?.nodeId, 'b');
		assert.ok(r.failed?.error, 'failure should carry an error message');
		assert.deepStrictEqual(started, ['a', 'b'], 'c must not start after b fails');
	});

	test('cycle short-circuits — nothing executes', async () => {
		const nodes: NodeLike[] = [
			{ id: 'a', type: 'Saros.ModelImageGen' },
			{ id: 'b', type: 'Saros.ModelImageGen' },
		];
		let started = 0;
		const r = await runGraphExecution(baseOptions(nodes, [
			{ source: 'a', target: 'b' },
			{ source: 'b', target: 'a' },
		], { onNodeStart: () => { started++; } }));
		assert.strictEqual(r.success, false);
		assert.strictEqual(r.hasCycle, true);
		assert.strictEqual(r.ran.length, 0);
		assert.strictEqual(started, 0);
	});

	test('missing imagegen channel fails the first node without crashing', async () => {
		const nodes: NodeLike[] = [{ id: 'a', type: 'Saros.ModelImageGen' }];
		const r = await runGraphExecution(baseOptions(nodes, [], {
			nodeValues: nodeValues(nodes),
			sendImageGen: undefined,
		}));
		assert.strictEqual(r.success, false);
		assert.strictEqual(r.failed?.nodeId, 'a');
		assert.match(r.failed?.error ?? '', /imagegen\.generate/);
	});

	test('snapshots land in the store before downstream consumers run', async () => {
		const nodes: NodeLike[] = [
			{ id: 'a', type: 'Saros.ModelImageGen' },
			{ id: 'b', type: 'Saros.ModelImageGen' },
		];
		const store = makeStore();
		const seen: string[] = [];
		// `b`'s img2img path reads the upstream image ref from the store;
		// assert that by the time `b` runs, `a`'s snapshot is already there.
		const send = async (args: { prompt: string }) => {
			if (args.prompt.includes('b')) {
				seen.push(store.byNode('a').length > 0 ? 'a-ready' : 'a-missing');
			}
			return { images: [{ url: 'http://img/y.png' }] };
		};
		const r = await runGraphExecution(baseOptions(nodes, [{ source: 'a', target: 'b' }], {
			snapshotStore: store,
			nodeValues: nodeValues(nodes),
			sendImageGen: send,
		}));
		assert.strictEqual(r.success, true);
		assert.deepStrictEqual(seen, ['a-ready']);
	});

	test('aborted signal stops mid-graph — treated as a clean stop, not a failure', async () => {
		const nodes: NodeLike[] = [
			{ id: 'a', type: 'Saros.ModelImageGen' },
			{ id: 'b', type: 'Saros.ModelImageGen' },
			{ id: 'c', type: 'Saros.ModelImageGen' },
		];
		const ctrl = new AbortController();
		const r = await runGraphExecution(baseOptions(nodes, [
			{ source: 'a', target: 'b' },
			{ source: 'b', target: 'c' },
		], {
			nodeValues: nodeValues(nodes),
			signal: ctrl.signal,
			onNodeStart: (step: { id: string }) => {
				if (step.id === 'a') { ctrl.abort(); }
			},
		}));
		// Abort on a's start → a still completes, the loop breaks before b.
		assert.strictEqual(r.success, true, 'abort is a clean stop, not a graph failure');
		assert.strictEqual(r.failed, null);
		assert.deepStrictEqual(r.ran, ['a']);
	});

	test('subflow nodes are flattened before execution (internal nodes run)', async () => {
		// A subflow node whose data.subflow contains one ModelImageGen.
		const def = {
			id: 'sf',
			name: '子流程',
			nodes: [{ id: 'inner', type: 'Saros.ModelImageGen' }],
			edges: [],
			entryIds: ['inner'],
			exitIds: ['inner'],
		};
		const nodes: Array<{ id: string; type: string; data?: unknown }> = [
			{ id: 'sf1', type: 'Saros.Subflow', data: { subflow: def } },
		];
		const r = await runGraphExecution(baseOptions(nodes as never, [], {
			nodeValues: { 'sf1:inner': { providerId: 'p', modelId: 'm', prompt: 'x' } },
		}));
		// The internal node sf1:inner is flattened and executed.
		assert.strictEqual(r.success, true);
		assert.deepStrictEqual(r.ran, ['sf1:inner']);
	});

	// ── 快照归档键（stageUid）贯穿全图 Run ────────────────────────────────
	// 卡片读侧用 stageUid；若图执行仍按 nodeId 归档就是「写 nodeId、读 uid」→
	// 跑成功但所有 OUTPUT 静默不刷新。上游键同样必须映射，否则下游 img2img /
	// picker 拿不到上游刚生成的图。
	const uidOf = (id: string) => `uid-${id}`;

	test('snapshotKeyOf archives under stageUid and maps upstream keys (serial)', async () => {
		const nodes: NodeLike[] = [
			{ id: 'a', type: 'Saros.ModelImageGen' },
			{ id: 'b', type: 'Saros.ModelImageGen' },
		];
		const store = makeStore();
		const imageInputs: Array<string | undefined> = [];
		const send = async (args: { prompt: string; imageInput?: string }) => {
			if (args.prompt.includes('b')) { imageInputs.push(args.imageInput); }
			return { images: [{ url: `http://img/${args.prompt}.png` }] };
		};
		const r = await runGraphExecution(baseOptions(nodes, [{ source: 'a', target: 'b' }], {
			snapshotStore: store,
			nodeValues: nodeValues(nodes),
			sendImageGen: send,
			snapshotKeyOf: uidOf,
		}));
		assert.strictEqual(r.success, true);
		assert.strictEqual(store.byNode('uid-a').length, 1, '快照必须落在 stageUid 名下');
		assert.strictEqual(store.byNode('uid-b').length, 1);
		assert.strictEqual(store.byNode('a').length, 0, 'nodeId 名下不应再有归档');
		// b 的 img2img 输入取自上游归档（uid-a）→ 证明 upstreams 已映射成归档键。
		assert.deepStrictEqual(imageInputs, ['http://img/prompt-a.png']);
	});

	test('snapshotKeyOf is honoured in parallel mode too', async () => {
		const nodes: NodeLike[] = [
			{ id: 'a', type: 'Saros.ModelImageGen' },
			{ id: 'b', type: 'Saros.ModelImageGen' },
		];
		const store = makeStore();
		const r = await runGraphExecution(baseOptions(nodes, [{ source: 'a', target: 'b' }], {
			snapshotStore: store,
			nodeValues: nodeValues(nodes),
			snapshotKeyOf: uidOf,
			mode: 'parallel',
		}));
		assert.strictEqual(r.success, true);
		assert.strictEqual(store.byNode('uid-a').length, 1);
		assert.strictEqual(store.byNode('uid-b').length, 1);
		assert.strictEqual(store.byNode('b').length, 0);
	});

	test('without snapshotKeyOf the archive stays under nodeId (backward compatible)', async () => {
		const nodes: NodeLike[] = [{ id: 'a', type: 'Saros.ModelImageGen' }];
		const store = makeStore();
		const r = await runGraphExecution(baseOptions(nodes, [], {
			snapshotStore: store,
			nodeValues: nodeValues(nodes),
		}));
		assert.strictEqual(r.success, true);
		assert.strictEqual(store.byNode('a').length, 1);
	});
});
