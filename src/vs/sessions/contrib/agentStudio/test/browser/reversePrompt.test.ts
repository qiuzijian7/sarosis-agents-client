/*---------------------------------------------------------------------------------------------
 *  Unit tests for reversePrompt — reverse prompt request builder (P2).
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { buildReversePromptRequest, buildReversePromptFromProviders, REVERSE_PROMPT_INSTRUCTION } from '../../webview/src/features/workflowEditor/comfyHost/reversePrompt.js';

const authed = {
	id: 'p1', authStatus: 'authenticated',
	models: [{ id: 'm-text', supportsTextChat: true }, { id: 'm-img', supportsImageGen: true }],
};

suite('buildReversePromptRequest', () => {

	test('uses the requested model when present', () => {
		const r = buildReversePromptRequest('snap:x:0', authed, 'm-text');
		assert.strictEqual(r.providerId, 'p1');
		assert.strictEqual(r.modelId, 'm-text');
		assert.strictEqual(r.ready, true);
	});

	test('falls back to a usable model when the requested one is missing', () => {
		const r = buildReversePromptRequest('snap:x:0', authed, 'no-such');
		assert.strictEqual(r.ready, true);
		assert.ok(r.modelId === 'm-text' || r.modelId === 'm-img');
	});

	test('unauthenticated provider is not ready', () => {
		const r = buildReversePromptRequest('snap:x:0', { id: 'p2', authStatus: 'anonymous' });
		assert.strictEqual(r.ready, false);
		assert.strictEqual(r.modelId, '');
	});

	test('authenticated provider without models is not ready', () => {
		const r = buildReversePromptRequest('snap:x:0', { id: 'p3', authStatus: 'authenticated', models: [] });
		assert.strictEqual(r.ready, false);
	});

	test('request carries the image ref and the instruction', () => {
		const r = buildReversePromptRequest('snap:img1:0', authed);
		assert.strictEqual(r.imageRef, 'snap:img1:0');
		assert.strictEqual(r.prompt, REVERSE_PROMPT_INSTRUCTION);
	});
});

suite('buildReversePromptFromProviders', () => {

	test('picks the first authenticated ready provider', () => {
		const providers = [
			{ id: 'anon', authStatus: 'anonymous', models: [{ id: 'x', supportsImageGen: true }] },
			{ id: 'auth1', authStatus: 'authenticated', models: [{ id: 'm1', supportsTextChat: true }] },
		];
		const r = buildReversePromptFromProviders('snap:x:0', providers);
		assert.ok(r);
		assert.strictEqual(r!.providerId, 'auth1');
	});

	test('returns null when nothing is authenticated', () => {
		const r = buildReversePromptFromProviders('snap:x:0', [
			{ id: 'a', authStatus: 'anonymous' },
			{ id: 'b', authStatus: 'anonymous' },
		]);
		assert.strictEqual(r, null);
	});

	test('returns a (not ready) request when authed providers lack usable models', () => {
		const r = buildReversePromptFromProviders('snap:x:0', [
			{ id: 'a', authStatus: 'authenticated', models: [] },
		]);
		assert.ok(r);
		assert.strictEqual(r!.providerId, 'a');
		assert.strictEqual(r!.ready, false);
	});
});
