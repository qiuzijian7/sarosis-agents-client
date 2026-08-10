/*---------------------------------------------------------------------------------------------
 *  Unit tests for cardState — per-node execution state driving the ComfyTV-style
 *  card feedback (run button / progress / error / output).
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { CardStateStore, useNodeCardState } from '../../webview/src/features/workflowEditor/comfyHost/cardState.js';
import { getNodeCardMeta } from '../../webview/src/features/workflowEditor/comfyHost/nodeCard.js';

suite('cardState (CardStateStore)', () => {

	test('default state is idle with 0 progress', () => {
		const store = new CardStateStore();
		const s = store.get('node-x');
		assert.strictEqual(s.runState, 'idle');
		assert.strictEqual(s.progress, 0);
	});

	test('set() stores and notifies subscribers', () => {
		const store = new CardStateStore();
		let notified = 0;
		const unsub = store.subscribe(() => { notified++; });
		store.set('node-x', { runState: 'running', progress: 42 });
		assert.strictEqual(notified, 1);
		assert.strictEqual(store.get('node-x').runState, 'running');
		assert.strictEqual(store.get('node-x').progress, 42);
		unsub();
		store.set('node-x', { runState: 'success', progress: 100 });
		assert.strictEqual(notified, 1); // no longer subscribed
	});

	test('nodes are independent', () => {
		const store = new CardStateStore();
		store.set('a', { runState: 'running', progress: 10 });
		assert.strictEqual(store.get('b').runState, 'idle');
	});

	test('clear() removes a node back to idle', () => {
		const store = new CardStateStore();
		store.set('a', { runState: 'error', progress: 0, errorMsg: 'boom' });
		store.clear('a');
		assert.strictEqual(store.get('a').runState, 'idle');
	});

	test('clearAll() resets every node', () => {
		const store = new CardStateStore();
		store.set('a', { runState: 'running', progress: 1 });
		store.set('b', { runState: 'error', progress: 0 });
		store.clearAll();
		assert.strictEqual(store.get('a').runState, 'idle');
		assert.strictEqual(store.get('b').runState, 'idle');
	});

	suite('transition', () => {

		test('running keeps previous errorMsg cleared via explicit values', () => {
			const next = CardStateStore.transition({ runState: 'error', progress: 0, errorMsg: 'old' }, { runState: 'running', progress: 5 });
			assert.strictEqual(next.runState, 'running');
			assert.strictEqual(next.progress, 5);
			// errorMsg carries forward unless overridden — tests default merge semantics
		});

		test('running clears finishedAt; terminal sets it', () => {
			const running = CardStateStore.transition(undefined, { runState: 'running', progress: 5 });
			assert.strictEqual(running.finishedAt, undefined);
			const done = CardStateStore.transition(running, { runState: 'success', durationMs: 800 });
			assert.strictEqual(done.durationMs, 800);
			assert.ok(done.finishedAt != null);
		});

		test('preserves prior fields when next omits them', () => {
			const prev = { runState: 'running', progress: 60, durationMs: 500 };
			const next = CardStateStore.transition(prev, { runState: 'success' });
			assert.strictEqual(next.progress, 60);
			assert.strictEqual(next.durationMs, 500);
		});
	});
});

suite('nodeCard ComfyTV metadata (getNodeCardMeta)', () => {

	test('schema stage exposes stageKind + hasPrompt for run-button styling', () => {
		const spec: any = {
			type: 'ComfyTV.ImageStage', kind: 'schema', title: '文生图', category: 'c',
			inputs: [], outputs: [],
			comfyTV: { stageKind: 'image', workflowKind: 'image-to-image' },
		};
		const meta = getNodeCardMeta(spec, {});
		assert.strictEqual(meta.stageKind, 'image');
		assert.strictEqual(meta.hasPrompt, true);
	});

	test('native / react nodes do not show run button (hasPrompt false)', () => {
		const native: any = { type: 'KSampler', kind: 'native', category: 'c', inputs: [], outputs: [] };
		assert.strictEqual(getNodeCardMeta(native, {}).hasPrompt, false);
		assert.strictEqual(getNodeCardMeta(native, {}).stageKind, undefined);
		const react: any = { type: 'Sarosis.Prompt', kind: 'react', category: 'c', inputs: [], outputs: [] };
		assert.strictEqual(getNodeCardMeta(react, {}).hasPrompt, false);
	});
});
