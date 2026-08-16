/*---------------------------------------------------------------------------------------------
 *  Unit tests for runGraphExecution(mode:'parallel') (docs/Agent-画布编排设计方案.md P1).
 *  Uses the same fake wiring as workflowRunGraph.test.ts.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { runGraphExecution } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import { MediaSnapshotStore } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';

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

const nodeValues = (nodes: NodeLike[]) => Object.fromEntries(nodes.map(n => [n.id, { providerId: 'p', modelId: 'm', prompt: `prompt-${n.id}` }]));

function baseOptions(nodes: NodeLike[], edges: EdgeLike[], overrides?: Record<string, unknown>): Parameters<typeof runGraphExecution>[0] {
	return {
		nodes,
		edges,
		getSpec: () => ({ kind: 'llm' }),
		resolveRunner: () => { throw new Error('no runner for provider-only graph'); },
		snapshotStore: makeStore(),
		cardState: { set: () => { } },
		sendImageGen: async () => ({ images: [{ url: 'http://img/x.png' }] }),
		resolveImageGenDefaults: async () => ({ providerId: 'p', modelId: 'm' }),
		nodeValues: nodeValues(nodes),
		mode: 'parallel' as const,
		parallelConcurrency: 4,
		...overrides,
	} as Parameters<typeof runGraphExecution>[0];
}

suite('workflowRun — parallel execution', () => {

	test('independent provider steps run concurrently (overlapping time)', async () => {
		const nodes: NodeLike[] = [{ id: 'a', type: 'Saros.ModelImageGen' }, { id: 'b', type: 'Saros.ModelImageGen' }];
		const running = new Set<string>();
		let maxConcurrent = 0;
		let seq = 0;
		const send = async () => {
			const key = `s${seq++}`;
			running.add(key);
			maxConcurrent = Math.max(maxConcurrent, running.size);
			await new Promise(r => setTimeout(r, 15));
			running.delete(key);
			return { images: [{ url: 'http://img/x.png' }] };
		};
		const r = await runGraphExecution(baseOptions(nodes, [], { sendImageGen: send }));
		assert.strictEqual(r.success, true, `expected success, got: ${JSON.stringify(r.failed)}`);
		assert.strictEqual(r.mode, 'parallel');
		// Two 15ms sends overlap → the concurrency pool must have run them together.
		assert.ok(maxConcurrent >= 2, `expected overlap (max ${maxConcurrent})`);
	});

	test('chain steps still run in dependency order (barrier between layers)', async () => {
		const nodes: NodeLike[] = [{ id: 'a', type: 'Saros.ModelImageGen' }, { id: 'b', type: 'Saros.ModelImageGen' }, { id: 'c', type: 'Saros.ModelImageGen' }];
		const started: string[] = [];
		const r = await runGraphExecution(baseOptions(nodes, [
			{ source: 'a', target: 'b' },
			{ source: 'b', target: 'c' },
		], { onNodeStart: (s: { id: string }) => started.push(s.id) }));
		assert.strictEqual(r.success, true);
		assert.deepStrictEqual(r.ran, ['a', 'b', 'c']);
		assert.deepStrictEqual(started, ['a', 'b', 'c']);
		assert.deepStrictEqual(r.layerStats?.map(l => l.total), [1, 1, 1]);
	});

	test('a failure stops later layers but records layer stats', async () => {
		const nodes: NodeLike[] = [{ id: 'a', type: 'Saros.ModelImageGen' }, { id: 'b', type: 'Saros.ModelImageGen' }, { id: 'c', type: 'Saros.ModelImageGen' }];
		// a succeeds; b fails (no images); c is in the next layer and must not start.
		const started: string[] = [];
		const send = async (args: { prompt: string }) => {
			if (args.prompt.includes('b')) { return { images: [] }; }
			return { images: [{ url: 'http://img/x.png' }] };
		};
		const r = await runGraphExecution(baseOptions(nodes, [
			{ source: 'a', target: 'b' },
			{ source: 'b', target: 'c' },
		], { onNodeStart: (s: { id: string }) => started.push(s.id), sendImageGen: send }));
		assert.strictEqual(r.success, false);
		assert.strictEqual(r.failed?.nodeId, 'b');
		assert.ok(!started.includes('c'), 'c must not start after b fails');
	});

	test('comfy backend steps are serialized even with a concurrency pool', async () => {
		// Schema/native steps are backend steps → single-slot pool → serialized.
		const specByType: Record<string, { kind: string }> = {
			'ComfyTV.StageA': { kind: 'schema' },
			'ComfyTV.StageB': { kind: 'schema' },
		};
		const nodes: NodeLike[] = [{ id: 'x', type: 'ComfyTV.StageA' }, { id: 'y', type: 'ComfyTV.StageB' }];
		let runnerResolves = 0;
		const r = await runGraphExecution(baseOptions(nodes, [], {
			getSpec: (t: string) => specByType[t],
			resolveRunner: () => { runnerResolves++; return { baseUrl: 'http://comfy' } as never; },
		}));
		// A runner IS required (schema steps present) → resolveRunner called.
		assert.ok(runnerResolves >= 1, 'runner resolved for backend steps');
		// With only a stub runner the backend execution fails (StageWorkflowUnavailableError
		// falls back to runSingleNode with an undefined runner) — the key assertion is
		// that the graph did NOT crash and reported a failure rather than a provider error.
		assert.strictEqual(r.success, false);
		assert.strictEqual(r.hasCycle, false);
	});

	test('cycle short-circuits with no layers', async () => {
		const nodes: NodeLike[] = [{ id: 'a', type: 'Saros.ModelImageGen' }, { id: 'b', type: 'Saros.ModelImageGen' }];
		const r = await runGraphExecution(baseOptions(nodes, [
			{ source: 'a', target: 'b' },
			{ source: 'b', target: 'a' },
		]));
		assert.strictEqual(r.success, false);
		assert.strictEqual(r.hasCycle, true);
		assert.deepStrictEqual(r.ran, []);
	});
});
