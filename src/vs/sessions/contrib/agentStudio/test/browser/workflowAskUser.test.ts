/*---------------------------------------------------------------------------------------------
 * P1: Saros.AskUser 交互节点 executor。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { runNodeOrStage } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import { MediaSnapshotStore, createMemoryBackend } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';
import type { IComfyRunner } from '../../webview/src/features/workflowEditor/comfyHost/comfyRunner.js';
import type { AskUserSendFn, AskUserPayload } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';

function makeInput(over: Record<string, unknown>): Parameters<typeof runNodeOrStage>[0] {
	return {
		runner: null as unknown as IComfyRunner,
		nodeId: 'a1',
		type: 'Saros.AskUser',
		getSpec: () => undefined,
		values: {},
		store: new MediaSnapshotStore(createMemoryBackend()),
		...over,
	} as Parameters<typeof runNodeOrStage>[0];
}

function putJson(store: MediaSnapshotStore, key: string, value: unknown): void {
	store.put({ nodeId: key, port: 'output', key: `${key}:output:0`, index: 0, media: { kind: 'text', ref: JSON.stringify(value), meta: { sarosJson: '1' } } }, true);
}

const OPTS = '[{"label":"风格 A","description":"cyberpunk"},{"label":"风格 B"}]';

suite('P1 AskUser executor', () => {

	test('single-select resolves a label and archives {answer}', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		let captured: AskUserPayload | undefined;
		const askUser: AskUserSendFn = async (p) => { captured = p; return '风格 A'; };
		const r = await runNodeOrStage(makeInput({ store, nodeId: 'a1', values: { questionText: '选一个风格', options: OPTS, multiSelect: 'no' }, askUser }));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(captured?.question, '选一个风格');
		assert.strictEqual(captured?.options.length, 2);
		assert.strictEqual(captured?.multiSelect, false);
		const snap = store.get('a1:output:0');
		assert.strictEqual(snap?.ref, '{"answer":"风格 A"}');
		assert.strictEqual(snap?.meta?.askUserNode, '1');
	});

	test('multi-select returns an array and archives {answer:[...]}', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		const askUser: AskUserSendFn = async () => ['风格 A', '风格 B'];
		const r = await runNodeOrStage(makeInput({ store, nodeId: 'a1', values: { options: OPTS, multiSelect: 'yes' }, askUser }));
		assert.strictEqual(r.status, 'success');
		const snap = store.get('a1:output:0');
		assert.strictEqual(snap?.ref, '{"answer":["风格 A","风格 B"]}');
	});

	test('question resolves {{input}} from upstream', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		putJson(store, 'up1', { topic: '赛博朋克' });
		let captured: AskUserPayload | undefined;
		const askUser: AskUserSendFn = async (p) => { captured = p; return 'A'; };
		const r = await runNodeOrStage(makeInput({ store, nodeId: 'a1', upstreams: ['up1'], values: { questionText: '为 {{input.topic}} 选风格', options: OPTS, multiSelect: 'no' }, askUser }));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(captured?.question, '为 赛博朋克 选风格');
	});

	test('errors without askUser injection', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		const r = await runNodeOrStage(makeInput({ store, nodeId: 'a1', values: { options: OPTS } }));
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /askUser 未注入/);
	});

	test('errors without options', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		const askUser: AskUserSendFn = async () => 'A';
		const r = await runNodeOrStage(makeInput({ store, nodeId: 'a1', values: {}, askUser }));
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /缺少选项/);
	});

	test('options passed as an array of objects', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		let captured: AskUserPayload | undefined;
		const askUser: AskUserSendFn = async (p) => { captured = p; return 'X'; };
		const r = await runNodeOrStage(makeInput({ store, nodeId: 'a1', values: { options: [{ label: 'X', description: 'd' }], multiSelect: 'no' }, askUser }));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(captured?.options[0].label, 'X');
	});
});
