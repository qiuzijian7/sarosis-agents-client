/*---------------------------------------------------------------------------------------------
 *  Unit tests for nodeExecutor — single-node Comfy execution ("click → prompt → image").
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	buildNodeApiPrompt,
	comfyOutputsToSnapshots,
	runSingleNode,
	unwrapNodeOutputs,
	PROMPT_NODE_KEY,
} from '../../webview/src/features/workflowEditor/comfyHost/nodeExecutor.js';
import { MediaSnapshotStore, createMemoryBackend } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';
import { primarySnapshotKey } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshot.js';
import type { IComfyRunner } from '../../webview/src/features/workflowEditor/comfyHost/comfyRunner.js';

function fakeRunner(outputs: Record<string, unknown>, overrides?: { status?: 'success' | 'error'; error?: string }): IComfyRunner {
	return {
		id: 'local', kind: 'local', baseUrl: 'http://127.0.0.1:8188',
		testConnection: async () => ({ ok: true }),
		invoke: async () => ({
			promptId: 'p1',
			outputs,
			status: overrides?.status ?? 'success',
			error: overrides?.error,
			durationMs: 1200,
		}),
	};
}

suite('nodeExecutor', () => {

	suite('buildNodeApiPrompt', () => {

		test('wraps class_type + inputs under the stable node key', () => {
			const prompt = buildNodeApiPrompt('ComfyTV.ImageStage', { prompt: 'a cat', seed: -1 });
			assert.deepStrictEqual(prompt, {
				[PROMPT_NODE_KEY]: { class_type: 'ComfyTV.ImageStage', inputs: { prompt: 'a cat', seed: -1 } },
			});
		});

		test('does not mutate the input values object', () => {
			const values = { prompt: 'x' };
			buildNodeApiPrompt('KSampler', values);
			assert.deepStrictEqual(values, { prompt: 'x' });
		});
	});

	suite('comfyOutputsToSnapshots', () => {

		test('flattens images into /view URLs on the primary output port', () => {
			const entries = comfyOutputsToSnapshots('http://127.0.0.1:8188', {
				images: [{ filename: 'a.png', subfolder: 'sub', type: 'output' }, { filename: 'b.png', subfolder: '', type: 'temp' }],
			}, 'node-42');
			assert.strictEqual(entries.length, 2);
			assert.strictEqual(entries[0].nodeId, 'node-42');
			assert.strictEqual(entries[0].port, 'output');
			assert.strictEqual(entries[0].index, 0);
			assert.strictEqual(entries[0].key, 'node-42:output:0');
			assert.strictEqual(entries[0].media.kind, 'image');
			assert.strictEqual(entries[0].media.ref, 'http://127.0.0.1:8188/view?filename=a.png&subfolder=sub&type=output');
			assert.strictEqual(entries[1].key, 'node-42:output:1');
			assert.strictEqual(entries[1].media.ref, 'http://127.0.0.1:8188/view?filename=b.png&subfolder=&type=temp');
		});

		test('strings become inline text refs (no /view rewrite)', () => {
			const entries = comfyOutputsToSnapshots('http://x', { text: 'hello world' }, 'n1');
			assert.strictEqual(entries.length, 1);
			assert.strictEqual(entries[0].media.kind, 'text');
			assert.strictEqual(entries[0].media.ref, 'hello world');
		});

		test('unknown / array of strings passes through', () => {
			const entries = comfyOutputsToSnapshots('http://x', { out: ['x.png', 'y.png'] }, 'n2');
			assert.strictEqual(entries.length, 2);
			assert.strictEqual(entries[0].media.ref, 'x.png');
		});

		test('undefined outputs → empty list', () => {
			assert.deepStrictEqual(comfyOutputsToSnapshots('http://x', undefined, 'n3'), []);
		});

		test('multiple slots are concatenated with ascending indices', () => {
			const entries = comfyOutputsToSnapshots('http://x', {
				images: ['i1.png'],
				audio: ['a1.wav'],
			}, 'n4');
			assert.deepStrictEqual(entries.map(e => e.key), ['n4:output:0', 'n4:output:1']);
			assert.strictEqual(entries[1].media.kind, 'audio');
		});
	});

	suite('unwrapNodeOutputs', () => {

		test('returns the PROMPT_NODE_KEY slot layer when present', () => {
			const out = unwrapNodeOutputs({ '1': { images: ['a.png'] }, '2': { images: ['b.png'] } });
			assert.deepStrictEqual(out, { images: ['a.png'] });
		});

		test('falls back to the single node outputs when keyed differently', () => {
			const out = unwrapNodeOutputs({ '7': { images: ['z.png'] } });
			assert.deepStrictEqual(out, { images: ['z.png'] });
		});

		test('undefined → undefined', () => {
			assert.strictEqual(unwrapNodeOutputs(undefined), undefined);
		});

		test('non-object outputs (multiple keys) returned as-is', () => {
			const out = unwrapNodeOutputs({ a: 'x', b: 'y' });
			assert.deepStrictEqual(out, { a: 'x', b: 'y' });
		});
	});

	suite('runSingleNode', () => {

		test('success path stores snapshots keyed by primarySnapshotKey', async () => {
			const store = new MediaSnapshotStore(createMemoryBackend());
			const runner = fakeRunner({ '1': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } });
			const result = await runSingleNode({
				runner, nodeId: 'node-7', type: 'ComfyTV.ImageStage',
				values: { prompt: 'a cat' }, store,
			});
			assert.strictEqual(result.status, 'success');
			assert.strictEqual(result.promptId, 'p1');
			assert.strictEqual(result.entries.length, 1);
			assert.ok(store.has(primarySnapshotKey('node-7')));
			const ref = store.get(primarySnapshotKey('node-7'));
			assert.strictEqual(ref?.kind, 'image');
			assert.match(ref?.ref ?? '', /\/view\?filename=out\.png/);
		});

		test('uses the runner baseUrl for /view URLs', async () => {
			const store = new MediaSnapshotStore(createMemoryBackend());
			const runner = fakeRunner({ '1': { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } });
			runner.baseUrl = 'http://192.168.1.5:8188';
			const result = await runSingleNode({ runner, nodeId: 'n', type: 'T', values: {}, store });
			const ref = store.get(primarySnapshotKey('n'));
			assert.match(ref?.ref ?? '', /^http:\/\/192\.168\.1\.5:8188\/view\?/);
			assert.strictEqual(result.status, 'success');
		});

		test('error status from runner surfaces gracefully', async () => {
			const store = new MediaSnapshotStore(createMemoryBackend());
			const runner = fakeRunner({}, { status: 'error', error: 'ComfyUI execution error' });
			const result = await runSingleNode({ runner, nodeId: 'n', type: 'T', values: {}, store });
			assert.strictEqual(result.status, 'error');
			assert.match(result.error ?? '', /execution error/);
			assert.strictEqual(result.entries.length, 0);
			assert.strictEqual(store.has(primarySnapshotKey('n')), false);
		});

		test('canceled status returns no entries', async () => {
			const store = new MediaSnapshotStore(createMemoryBackend());
			const runner: IComfyRunner = {
				id: 'local', kind: 'local', baseUrl: 'http://x',
				testConnection: async () => ({ ok: true }),
				invoke: async () => ({ promptId: 'p', outputs: {}, status: 'canceled', durationMs: 5 }),
			};
			const result = await runSingleNode({ runner, nodeId: 'n', type: 'T', values: {}, store });
			assert.strictEqual(result.status, 'canceled');
			assert.strictEqual(result.entries.length, 0);
		});

		test('runner throw is caught into result.error', async () => {
			const store = new MediaSnapshotStore(createMemoryBackend());
			const runner: IComfyRunner = {
				id: 'local', kind: 'local', baseUrl: 'http://x',
				testConnection: async () => ({ ok: true }),
				invoke: async () => { throw new Error('HTTP 503'); },
			};
			const result = await runSingleNode({ runner, nodeId: 'n', type: 'T', values: {}, store });
			assert.strictEqual(result.status, 'error');
			assert.match(result.error ?? '', /HTTP 503/);
			assert.strictEqual(result.entries.length, 0);
		});

		test('outputs keyed by a node id other than "1" are still captured', async () => {
			const store = new MediaSnapshotStore(createMemoryBackend());
			const runner = fakeRunner({ '7': { images: [{ filename: 'z.png', subfolder: '', type: 'output' }] } });
			const result = await runSingleNode({ runner, nodeId: 'n', type: 'T', values: {}, store });
			assert.strictEqual(result.status, 'success');
			assert.strictEqual(result.entries.length, 1);
			assert.ok(store.has(primarySnapshotKey('n')));
		});
	});
});
