/*---------------------------------------------------------------------------------------------
 * P0: Saros.Skill / Saros.Tool executor（复用 runAgentNode 通道）。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { runNodeOrStage } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import { MediaSnapshotStore, createMemoryBackend } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';
import type { IComfyRunner } from '../../webview/src/features/workflowEditor/comfyHost/comfyRunner.js';
import type { AgentNodeSendFn, AgentNodePayload } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';

function makeInput(over: Record<string, unknown>): Parameters<typeof runNodeOrStage>[0] {
	return {
		runner: null as unknown as IComfyRunner,
		nodeId: 'n1',
		type: 'Saros.Skill',
		getSpec: () => undefined,
		values: {},
		store: new MediaSnapshotStore(createMemoryBackend()),
		...over,
	} as Parameters<typeof runNodeOrStage>[0];
}

function putJson(store: MediaSnapshotStore, key: string, value: unknown): void {
	store.put({ nodeId: key, port: 'output', key: `${key}:output:0`, index: 0, media: { kind: 'text', ref: JSON.stringify(value), meta: { sarosJson: '1' } } }, true);
}

suite('P0 Skill / Tool executor', () => {

	test('Skill node builds prompt with skill name + args and archives skillNode meta', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		let captured: AgentNodePayload | undefined;
		const runAgentNode: AgentNodeSendFn = async (p) => { captured = p; return { ok: true, output: '技能完成' }; };
		const r = await runNodeOrStage(makeInput({ store, type: 'Saros.Skill', nodeId: 's1', values: { skillName: 'frontend-slides', skillArgs: '{"topic":"AI"}' }, runAgentNode }));
		assert.strictEqual(r.status, 'success');
		assert.match(captured!.prompt, /frontend-slides/);
		assert.match(captured!.prompt, /"topic":"AI"/);
		const snap = store.get('s1:output:0');
		assert.strictEqual(snap?.meta?.skillNode, '1');
	});

	test('Skill node errors without skillName', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		const runAgentNode: AgentNodeSendFn = async () => ({ ok: true });
		const r = await runNodeOrStage(makeInput({ store, type: 'Saros.Skill', nodeId: 's1', values: {}, runAgentNode }));
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /缺少技能名/);
	});

	test('Tool node builds prompt with tool name + params and archives toolNode meta', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		let captured: AgentNodePayload | undefined;
		const runAgentNode: AgentNodeSendFn = async (p) => { captured = p; return { ok: true, output: '查询结果' }; };
		const r = await runNodeOrStage(makeInput({ store, type: 'Saros.Tool', nodeId: 't1', values: { toolName: 'web_search', toolParams: '{"q":"hello"}' }, runAgentNode }));
		assert.strictEqual(r.status, 'success');
		assert.match(captured!.prompt, /web_search/);
		assert.match(captured!.prompt, /"q":"hello"/);
		const snap = store.get('t1:output:0');
		assert.strictEqual(snap?.meta?.toolNode, '1');
	});

	test('Tool node errors without toolName', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		const runAgentNode: AgentNodeSendFn = async () => ({ ok: true });
		const r = await runNodeOrStage(makeInput({ store, type: 'Saros.Tool', nodeId: 't1', values: {}, runAgentNode }));
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /缺少工具名/);
	});

	test('Skill node resolves {{input}} inside skillArgs from upstream', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		putJson(store, 'up1', { topic: 'cyberpunk' });
		let captured: AgentNodePayload | undefined;
		const runAgentNode: AgentNodeSendFn = async (p) => { captured = p; return { ok: true, output: 'ok' }; };
		const r = await runNodeOrStage(makeInput({ store, type: 'Saros.Skill', nodeId: 's1', upstreams: ['up1'], values: { skillName: 'x', skillArgs: '{"topic":"{{input.topic}}"}' }, runAgentNode }));
		assert.strictEqual(r.status, 'success');
		assert.match(captured!.prompt, /"topic":"cyberpunk"/);
	});

	test('Skill/Tool without runAgentNode injection reports a friendly error', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		const r = await runNodeOrStage(makeInput({ store, type: 'Saros.Skill', nodeId: 's1', values: { skillName: 'x' } }));
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /runAgentNode 未注入/);
	});
});
