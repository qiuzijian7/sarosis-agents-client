/*---------------------------------------------------------------------------------------------
 * P0: Saros.End / Saros.Task executor + evaluationTarget {{input.*}} 前缀兼容。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { runNodeOrStage } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import { MediaSnapshotStore, createMemoryBackend } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';
import type { IComfyRunner } from '../../webview/src/features/workflowEditor/comfyHost/comfyRunner.js';
import type { AgentNodeSendFn } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';

function makeInput(over: Record<string, unknown>): Parameters<typeof runNodeOrStage>[0] {
	return {
		runner: null as unknown as IComfyRunner,
		nodeId: 'n1',
		type: 'Saros.End',
		getSpec: () => undefined,
		values: {},
		store: new MediaSnapshotStore(createMemoryBackend()),
		...over,
	} as Parameters<typeof runNodeOrStage>[0];
}

function putJson(store: MediaSnapshotStore, key: string, value: unknown): void {
	store.put({ nodeId: key, port: 'output', key: `${key}:output:0`, index: 0, media: { kind: 'text', ref: JSON.stringify(value), meta: { sarosJson: '1' } } }, true);
}

suite('P0 End / Task / evaluationTarget prefix', () => {

	test('End node passes through upstream snapshot and marks endNode', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		putJson(store, 'up1', { a: 1, b: 'x' });
		const r = await runNodeOrStage(makeInput({ store, type: 'Saros.End', nodeId: 'end1', upstreams: ['up1'] }));
		assert.strictEqual(r.status, 'success');
		const snap = store.get('end1:output:0');
		assert.strictEqual(snap?.ref, '{"a":1,"b":"x"}');
		assert.strictEqual(snap?.meta?.endNode, '1');
	});

	test('End node errors without upstream', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		const r = await runNodeOrStage(makeInput({ store, type: 'Saros.End', nodeId: 'end1', upstreams: [] }));
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /无上游输出/);
	});

	test('Task node reuses the agent executor (prompt + agentId)', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		let captured: Parameters<AgentNodeSendFn>[0] | undefined;
		const runAgentNode: AgentNodeSendFn = async (payload) => { captured = payload; return { ok: true, output: 'done' }; };
		const r = await runNodeOrStage(makeInput({ store, type: 'Saros.Task', nodeId: 't1', values: { prompt: '做 X', agentId: 'worker' }, runAgentNode }));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(captured?.prompt, '做 X');
		assert.strictEqual(captured?.agentId, 'worker');
		const snap = store.get('t1:output:0');
		assert.strictEqual(snap?.ref, '{"output":"done"}');
	});

	test('evaluationTarget supports {{input.path}} prefix (IfElse)', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		putJson(store, 'up1', { result: { ok: true } });
		const r = await runNodeOrStage(makeInput({ store, type: 'Saros.IfElse', nodeId: 'g1', values: { evaluationTarget: '{{input.result.ok}}' }, upstreams: ['up1'] }));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual((r as { branch?: string }).branch, 'true');
	});

	test('evaluationTarget supports bare dot path (regression)', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		putJson(store, 'up1', { score: 3 });
		const r = await runNodeOrStage(makeInput({ store, type: 'Saros.IfElse', nodeId: 'g1', values: { evaluationTarget: 'score' }, upstreams: ['up1'] }));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual((r as { branch?: string }).branch, 'true'); // 3 真值
	});

	test('Switch cases routes to case-N port with {{input.}} target', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		putJson(store, 'up1', { tag: 'b' });
		const r = await runNodeOrStage(makeInput({ store, type: 'Saros.Switch', nodeId: 'sw1', values: { evaluationTarget: '{{input.tag}}', cases: '["a","b","c"]' }, upstreams: ['up1'] }));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual((r as { branch?: string }).branch, 'case-2'); // b 命中第 2 路
	});

	test('Switch falls back to default port when no case matches', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		putJson(store, 'up1', { tag: 'zzz' });
		const r = await runNodeOrStage(makeInput({ store, type: 'Saros.Switch', nodeId: 'sw1', values: { evaluationTarget: 'tag', cases: '["a","b"]' }, upstreams: ['up1'] }));
		assert.strictEqual((r as { branch?: string }).branch, 'default');
	});
});
