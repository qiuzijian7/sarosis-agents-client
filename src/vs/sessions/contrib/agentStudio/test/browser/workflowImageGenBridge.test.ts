/*---------------------------------------------------------------------------------------------
 *  Agent Studio - Image generation bridge tests (llmBridge.generateImage / inferImageGen).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
// 2026-08-21 拆分：纯函数留在 common/，网络实现迁到 node/（common 禁止 Node 依赖）
import { inferImageGen } from '../../common/llmBridge.js';
import { generateImage } from '../../node/llmBridgeNode.js';

suite('llmBridge — inferImageGen', () => {

	test('detects common text→image model markers', () => {
		assert.strictEqual(inferImageGen({ id: 'dall-e-3' }), true);
		assert.strictEqual(inferImageGen({ id: 'gpt-image-1' }), true);
		assert.strictEqual(inferImageGen({ id: 'flux' }), true);
		assert.strictEqual(inferImageGen({ id: 'black-forest-labs/flux-1-schnell' }), true);
		assert.strictEqual(inferImageGen({ id: 'stable-diffusion-xl' }), true);
		assert.strictEqual(inferImageGen({ id: 'seedream-4.0' }), true);
	});

	test('does not flag chat-only models', () => {
		assert.strictEqual(inferImageGen({ id: 'gpt-4o' }), false);
		assert.strictEqual(inferImageGen({ id: 'claude-sonnet-4' }), false);
		assert.strictEqual(inferImageGen({ id: 'gemini-2.5-pro' }), false);
	});

	test('description-based detection', () => {
		assert.strictEqual(inferImageGen({ id: 'some-model', description: 'Text to image generation' }), true);
		assert.strictEqual(inferImageGen({ id: 'some-model', description: 'Fast chat model' }), false);
	});
});

suite('llmBridge — generateImage', () => {

	const okJson = (images: unknown[]): Response => ({
		ok: true,
		status: 200,
		json: async () => ({ data: images }),
		text: async () => '',
	} as unknown as Response);

	test('maps url images from OpenAI-compatible response', async () => {
		const fetchImpl = async (): Promise<Response> => okJson([
			{ url: 'https://cdn.example/img1.png' },
			{ url: 'https://cdn.example/img2.png' },
		]);
		const original = globalThis.fetch;
		globalThis.fetch = fetchImpl as unknown as typeof fetch;
		try {
			const result = await generateImage({
				url: 'https://api.example.com/v1/images/generations',
				apiKey: 'k',
				body: { model: 'gpt-image-1', prompt: 'cat', n: 2 },
			});
			assert.strictEqual(result.images.length, 2);
			assert.strictEqual(result.images[0].url, 'https://cdn.example/img1.png');
		} finally {
			globalThis.fetch = original;
		}
	});

	test('maps b64_json images', async () => {
		const fetchImpl = async (): Promise<Response> => okJson([
			{ b64_json: 'aGVsbG8=' },
		]);
		const original = globalThis.fetch;
		globalThis.fetch = fetchImpl as unknown as typeof fetch;
		try {
			const result = await generateImage({
				url: 'https://api.example.com/v1/images/generations',
				apiKey: 'k',
				body: { model: 'dall-e-3', prompt: 'dog', n: 1 },
			});
			assert.strictEqual(result.images.length, 1);
			assert.strictEqual(result.images[0].b64, 'aGVsbG8=');
		} finally {
			globalThis.fetch = original;
		}
	});

	test('filters empty entries and non-ok responses throw', async () => {
		const fetchImpl = async (): Promise<Response> => okJson([{ url: 'x' }, {}, null]);
		const original = globalThis.fetch;
		globalThis.fetch = fetchImpl as unknown as typeof fetch;
		try {
			const result = await generateImage({
				url: 'https://api.example.com/v1/images/generations',
				apiKey: 'k',
				body: { model: 'flux', prompt: 'cat', n: 3 },
			});
			assert.strictEqual(result.images.length, 1);
			assert.strictEqual(result.images[0].url, 'x');
		} finally {
			globalThis.fetch = original;
		}
	});

	test('throws on non-ok response', async () => {
		const fetchImpl = async (): Promise<Response> => ({
			ok: false,
			status: 401,
			text: async () => 'unauthorized',
		} as unknown as Response);
		const original = globalThis.fetch;
		globalThis.fetch = fetchImpl as unknown as typeof fetch;
		try {
			await assert.rejects(
				() => generateImage({
					url: 'https://api.example.com/v1/images/generations',
					apiKey: 'bad',
					body: { model: 'flux', prompt: 'cat' },
				}),
				/401/,
			);
		} finally {
			globalThis.fetch = original;
		}
	});
});
