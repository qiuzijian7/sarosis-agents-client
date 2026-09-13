/*---------------------------------------------------------------------------------------------
 *  Unit tests for 失败收尾「下游标 skipped」。
 *
 *  ★ 背景（2026-09-11）：host 引擎失败时用 `_cascadeSkipDownstream` 把失败节点的**可达下游**
 *    标 Skipped（独立并行分支照跑）；webview 引擎此前失败后直接 `return`，下游卡片停在
 *    idle —— 用户无法区分「没跑到」与「被上游失败连累」。现两个引擎语义对齐：
 *    失败后下游标 skipped（仅改卡片状态与 skippedIds，不改执行语义）。
 *    守卫 = 纯函数 `collectDownstreamClosure` + 两个引擎路径的集成断言。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { runGraphExecution } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import { collectDownstreamClosure } from '../../webview/src/features/workflowEditor/comfyHost/executionGraph.js';
import { MediaSnapshotStore } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';

interface NodeLike { id: string; type: string; }
interface EdgeLike { source: string; target: string; }

const edge = (source: string, target: string): EdgeLike => ({ source, target });

suite('collectDownstreamClosure（纯函数）', () => {

	test('链 a→b→c：闭包含 b、c，不含根 a', () => {
		const c = collectDownstreamClosure(['a'], [edge('a', 'b'), edge('b', 'c')]);
		assert.deepStrictEqual([...c].sort(), ['b', 'c']);
	});

	test('菱形 a→b, a→c, b→d, c→d：闭包 = {b,c,d}', () => {
		const c = collectDownstreamClosure(['a'], [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]);
		assert.deepStrictEqual([...c].sort(), ['b', 'c', 'd']);
	});

	test('★ 独立分支不入闭包（只跳被连累的下游）', () => {
		const c = collectDownstreamClosure(['a'], [edge('a', 'b'), edge('x', 'y')]);
		assert.deepStrictEqual([...c], ['b']);
		assert.ok(!c.has('x') && !c.has('y'));
	});

	test('多根：两个失败点的下游并集', () => {
		const c = collectDownstreamClosure(['a', 'x'], [edge('a', 'b'), edge('x', 'y')]);
		assert.deepStrictEqual([...c].sort(), ['b', 'y']);
	});

	test('★ 含环图不死循环（visited 去重）', () => {
		const c = collectDownstreamClosure(['a'], [edge('a', 'b'), edge('b', 'a'), edge('b', 'c')]);
		assert.deepStrictEqual([...c].sort(), ['b', 'c']);
	});

	test('空根 → 空闭包', () => {
		assert.strictEqual(collectDownstreamClosure([], [edge('a', 'b')]).size, 0);
	});

	test('悬空边（未知 source）不影响结果', () => {
		const c = collectDownstreamClosure(['a'], [edge('a', 'b'), edge('ghost', 'z')]);
		assert.deepStrictEqual([...c], ['b']);
	});
});

// ─── 集成：runGraphExecution 的失败收尾 ─────────────────────────────────────

function makeStore(): MediaSnapshotStore {
	const map = new Map<string, unknown>();
	return new MediaSnapshotStore({
		async save(key, data) { map.set(key, data); return key; },
		async load(key) { return map.get(key) ?? null; },
		async remove(key) { map.delete(key); },
	});
}

function options(
	nodes: NodeLike[],
	edges: EdgeLike[],
	states: Map<string, string>,
	overrides?: Record<string, unknown>,
): Parameters<typeof runGraphExecution>[0] {
	return {
		nodes,
		edges,
		getSpec: () => ({ kind: 'llm' }),
		resolveRunner: () => { throw new Error('no runner for provider-only graph'); },
		snapshotStore: makeStore(),
		cardState: { set: (id: string, s: { runState: string }) => { states.set(id, s.runState); } },
		sendImageGen: async (args: { prompt?: string }) => (args.prompt ?? '').includes('b')
			? { images: [] }                       // b 失败
			: { images: [{ url: 'http://img/x.png' }] },
		resolveImageGenDefaults: async () => ({ providerId: 'p', modelId: 'm' }),
		nodeValues: Object.fromEntries(nodes.map(n => [n.id, { providerId: 'p', modelId: 'm', prompt: `prompt-${n.id}` }])),
		...overrides,
	} as Parameters<typeof runGraphExecution>[0];
}

const CHAIN: NodeLike[] = [
	{ id: 'a', type: 'Saros.ModelImageGen' },
	{ id: 'b', type: 'Saros.ModelImageGen' },
	{ id: 'c', type: 'Saros.ModelImageGen' },
];
const CHAIN_EDGES = [edge('a', 'b'), edge('b', 'c')];

suite('runGraphExecution 失败收尾：下游标 skipped', () => {

	test('★ serial：b 失败 → 下游 c 标 skipped 并进 skippedIds', async () => {
		const states = new Map<string, string>();
		const r = await runGraphExecution(options(CHAIN, CHAIN_EDGES, states, { mode: 'serial' }));
		assert.strictEqual(r.success, false);
		assert.strictEqual(r.failed?.nodeId, 'b');
		assert.ok(r.skippedIds.includes('c'), `c 应进 skippedIds，实得 ${JSON.stringify(r.skippedIds)}`);
		assert.strictEqual(states.get('c'), 'skipped', '下游卡片必须是 skipped（不能停在 idle）');
		// 失败节点自身保持 error，且不被计为 skipped
		assert.strictEqual(states.get('b'), 'error');
		assert.ok(!r.skippedIds.includes('b'));
		// 上游 a 已成功，不被误标
		assert.strictEqual(states.get('a'), 'success');
	});

	test('★ parallel：b 失败 → 下游 c 标 skipped', async () => {
		const states = new Map<string, string>();
		const r = await runGraphExecution(options(CHAIN, CHAIN_EDGES, states, { mode: 'parallel' }));
		assert.strictEqual(r.success, false);
		assert.strictEqual(r.failed?.nodeId, 'b');
		assert.ok(r.skippedIds.includes('c'), `c 应进 skippedIds，实得 ${JSON.stringify(r.skippedIds)}`);
		assert.strictEqual(states.get('c'), 'skipped');
	});

	test('成功路径不产生 skipped（回归：勿误标）', async () => {
		const states = new Map<string, string>();
		const ok = async () => ({ images: [{ url: 'http://img/x.png' }] });
		const r = await runGraphExecution(options(CHAIN, CHAIN_EDGES, states, { sendImageGen: ok }));
		assert.strictEqual(r.success, true);
		assert.deepStrictEqual(r.skippedIds, []);
		assert.deepStrictEqual(r.ran, ['a', 'b', 'c']);
	});
});
