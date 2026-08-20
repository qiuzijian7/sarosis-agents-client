/*---------------------------------------------------------------------------------------------
 * W5: Saros.Loop / Saros.Parallel 迭代子图容器执行器单测。
 * body 全用 Saros.Prompt（纯本地，无 runner/RPC 依赖）。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { runNodeOrStage } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import { MediaSnapshotStore, createMemoryBackend } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';
import { primarySnapshotKey } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshot.js';
import type { IComfyRunner } from '../../webview/src/features/workflowEditor/comfyHost/comfyRunner.js';

function makeInput(over: Record<string, unknown>): Parameters<typeof runNodeOrStage>[0] {
	return {
		runner: null as unknown as IComfyRunner,
		nodeId: 'loop1',
		type: 'Saros.Loop',
		getSpec: () => undefined,
		values: {},
		store: new MediaSnapshotStore(createMemoryBackend()),
		...over,
	} as Parameters<typeof runNodeOrStage>[0];
}

function readOut(store: MediaSnapshotStore, key: string): string | undefined {
	return store.get(`${key}:output:0`)?.ref;
}

suite('W5 runLoopNodeExecutor', () => {

	test('serial loop runs body per item and aggregates iterations', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		const body = {
			id: 'b', name: 'body',
			nodes: [
				{ id: 'p1', type: 'Saros.Prompt', data: { prompt: '加工 {{input}}' } },
				{ id: 'p2', type: 'Saros.Prompt', data: { prompt: '完成:{{input}}' } },
			],
			edges: [{ source: 'p1', target: 'p2' }],
			entryIds: ['p1'],
			exitIds: ['p2'],
		};
		const nodes = [{ id: 'loop1', type: 'Saros.Loop', data: { loopBody: body } }];
		const r = await runNodeOrStage(makeInput({ store, nodes, values: { items: '["a","b","c"]' } }));
		assert.strictEqual(r.status, 'success');
		const out = JSON.parse(readOut(store, 'loop1')!);
		assert.strictEqual(out.iterations.length, 3);
		assert.strictEqual(out.failed, 0);
		// p1 {{input}} = item 的 JSON 文本（'"a"'），p2 {{input}} = p1 输出原文
		assert.match(String(out.iterations[0]), /完成:加工 "a"/);
		assert.match(String(out.iterations[2]), /完成:加工 "c"/);
	});

	test('failing item yields null and the loop continues', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		// p-fail 是无 runAgentNode 注入的 Agent 节点 → 单节点执行失败 → 该 item null
		const body = {
			id: 'b', name: 'body',
			nodes: [
				{ id: 'p1', type: 'Saros.Prompt', data: { prompt: '加工 {{input}}' } },
				{ id: 'p2', type: 'Saros.Agent', data: { prompt: 'x' } },
			],
			edges: [{ source: 'p1', target: 'p2' }],
			entryIds: ['p1'],
			exitIds: ['p2'],
		};
		const nodes = [{ id: 'loop1', type: 'Saros.Loop', data: { loopBody: body } }];
		const r = await runNodeOrStage(makeInput({ store, nodes, values: { items: '[1,2]' } }));
		assert.strictEqual(r.status, 'success');
		const out = JSON.parse(readOut(store, 'loop1')!);
		assert.strictEqual(out.failed, 2);
		assert.deepStrictEqual(out.iterations, [null, null]);
	});

	test('parallel mode keeps result order aligned with items', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		const body = {
			id: 'b', name: 'body',
			nodes: [{ id: 'p1', type: 'Saros.Prompt', data: { prompt: '项 {{input}}' } }],
			edges: [],
			entryIds: ['p1'],
			exitIds: ['p1'],
		};
		const nodes = [{ id: 'par1', type: 'Saros.Parallel', data: { loopBody: body } }];
		const r = await runNodeOrStage(makeInput({ store, nodes, nodeId: 'par1', type: 'Saros.Parallel', values: { items: '["i0","i1","i2","i3","i4"]', concurrency: 3 } }));
		assert.strictEqual(r.status, 'success');
		const out = JSON.parse(readOut(store, 'par1')!);
		assert.strictEqual(out.iterations.length, 5);
		assert.match(String(out.iterations[0]), /项 "i0"/);
		assert.match(String(out.iterations[4]), /项 "i4"/); // 顺序与 items 对齐
	});

	test('missing body reports a friendly error', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		const nodes = [{ id: 'loop1', type: 'Saros.Loop', data: {} }];
		const r = await runNodeOrStage(makeInput({ store, nodes }));
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /缺少循环体/);
	});

	test('empty items archives an empty result (no error)', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		const body = { id: 'b', name: 'body', nodes: [{ id: 'p1', type: 'Saros.Prompt', data: { prompt: 'x' } }], edges: [], entryIds: ['p1'], exitIds: ['p1'] };
		const nodes = [{ id: 'loop1', type: 'Saros.Loop', data: { loopBody: body } }];
		const r = await runNodeOrStage(makeInput({ store, nodes, values: { items: '[]' } }));
		assert.strictEqual(r.status, 'success');
		const out = JSON.parse(readOut(store, 'loop1')!);
		assert.deepStrictEqual(out, { iterations: [], failed: 0 });
	});
});
