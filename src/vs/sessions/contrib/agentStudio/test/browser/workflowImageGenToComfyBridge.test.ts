/*---------------------------------------------------------------------------------------------
 *  Unit tests for imageGenToComfyBridge — Provider 输出 → Comfy LoadImage 桥接。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	isComfyViewRef,
	classifyImageRef,
	dataUrlToBlob,
	uploadNameForRef,
	uploadRefToComfy,
	resolveLoadImageImageRef,
	type BridgeFetchLike,
} from '../../webview/src/features/workflowEditor/comfyHost/imageGenToComfyBridge.js';

const BASE = 'http://127.0.0.1:8188';

suite('imageGenToComfyBridge — classifyImageRef', () => {

	test('comfy /view refs are passthrough', () => {
		assert.strictEqual(isComfyViewRef('http://x/view?filename=a.png'), true);
		assert.strictEqual(isComfyViewRef('http://x/img.png'), false);
	});

	test('classifies the three ref kinds', () => {
		assert.deepStrictEqual(classifyImageRef('http://cdn/a.png'), { kind: 'http', url: 'http://cdn/a.png' });
		assert.deepStrictEqual(classifyImageRef('data:image/png;base64,QUJD'), { kind: 'data-url', dataUrl: 'data:image/png;base64,QUJD' });
		assert.deepStrictEqual(classifyImageRef('http://x/view?filename=a.png'), { kind: 'comfy-view', url: 'http://x/view?filename=a.png' });
		assert.deepStrictEqual(classifyImageRef(undefined), { kind: 'unknown' });
		assert.deepStrictEqual(classifyImageRef('not-a-ref'), { kind: 'unknown' });
	});
});

suite('imageGenToComfyBridge — dataUrlToBlob', () => {

	test('decodes base64 data URL', () => {
		const parsed = dataUrlToBlob('data:image/png;base64,aGVsbG8=');
		assert.ok(parsed);
		assert.strictEqual(parsed.mime, 'image/png');
		assert.strictEqual(parsed.blob.size, 5);
	});

	test('rejects malformed data URL', () => {
		assert.strictEqual(dataUrlToBlob('data:image/png'), undefined);
	});
});

suite('imageGenToComfyBridge — uploadNameForRef', () => {

	test('derives name from data URL mime', () => {
		assert.strictEqual(uploadNameForRef('data:image/jpeg;base64,QUJD'), 'sarosis_upload_0.jpg');
		assert.strictEqual(uploadNameForRef('data:image/png;base64,QUJD'), 'sarosis_upload_0.png');
	});

	test('keeps filename from http URL', () => {
		assert.strictEqual(uploadNameForRef('http://cdn/a.png'), 'a.png');
		assert.strictEqual(uploadNameForRef('http://cdn/a.png?x=1'), 'a.png');
	});

	test('falls back for extensionless URLs', () => {
		assert.strictEqual(uploadNameForRef('http://cdn/gen'), 'sarosis_upload_0.png');
	});
});

suite('imageGenToComfyBridge — uploadRefToComfy', () => {

	function fakeFetch(handler: (url: string, init?: { body?: FormData | string }) => { ok: boolean; json(): unknown; text(): string }): BridgeFetchLike {
		return async (url, init) => {
			const r = handler(url, init);
			return { ok: r.ok, json: () => r.json(), text: () => r.text() };
		};
	}

	test('comfy-view ref passes through without upload', async () => {
		const called: string[] = [];
		const fetchImpl: BridgeFetchLike = async (url) => { called.push(url); return { ok: true, json: () => ({}), text: () => '' }; };
		const r = await uploadRefToComfy({ ref: `${BASE}/view?filename=a.png`, baseUrl: BASE, fetchImpl });
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.ref, `${BASE}/view?filename=a.png`);
		assert.strictEqual(called.length, 0);
	});

	test('data URL is uploaded and returns /view ref', async () => {
		const fetchImpl = fakeFetch((url, init) => {
			assert.strictEqual(url, `${BASE}/upload/image`);
			assert.ok(init?.body instanceof FormData);
			assert.ok((init.body as FormData).has('image'));
			return { ok: true, json: () => ({ name: 'up.png', subfolder: '', type: 'input' }), text: () => '' };
		});
		const r = await uploadRefToComfy({ ref: 'data:image/png;base64,aGVsbG8=', baseUrl: BASE, fetchImpl });
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.ref, `${BASE}/view?filename=up.png&type=input`);
	});

	test('http ref downloads then uploads', async () => {
		const calls: string[] = [];
		const fetchImpl: BridgeFetchLike = async (url) => {
			calls.push(url);
			if (url.startsWith('http://cdn/')) {
				return { ok: true, json: () => ({}), text: () => 'BINARY' };
			}
			return { ok: true, json: () => ({ name: 'cdn.png' }), text: () => '' };
		};
		const r = await uploadRefToComfy({ ref: 'http://cdn/a.png', baseUrl: BASE, fetchImpl });
		assert.strictEqual(r.ok, true);
		assert.ok(r.ref?.includes('/view?filename=cdn.png'));
		assert.deepStrictEqual(calls, ['http://cdn/a.png', `${BASE}/upload/image`]);
	});

	test('upload failure surfaces error', async () => {
		const fetchImpl = fakeFetch(() => ({ ok: false, json: () => ({}), text: () => 'forbidden' }));
		const r = await uploadRefToComfy({ ref: 'data:image/png;base64,aGVsbG8=', baseUrl: BASE, fetchImpl });
		assert.strictEqual(r.ok, false);
		assert.match(r.error ?? '', /上传图片失败/);
	});

	test('unknown ref → error', async () => {
		const fetchImpl = fakeFetch(() => ({ ok: true, json: () => ({}), text: () => '' }));
		const r = await uploadRefToComfy({ ref: 'nope', baseUrl: BASE, fetchImpl });
		assert.strictEqual(r.ok, false);
		assert.match(r.error ?? '', /无法识别的图片引用/);
	});
});

suite('imageGenToComfyBridge — resolveLoadImageImageRef', () => {

	test('no ref → error', async () => {
		const fetchImpl: BridgeFetchLike = async () => ({ ok: true, json: () => ({}), text: () => '' });
		const r = await resolveLoadImageImageRef({ ref: undefined, baseUrl: BASE, fetchImpl });
		assert.strictEqual(r.ok, false);
		assert.match(r.error ?? '', /没有可用的图片输出/);
	});

	test('comfy-view passthrough', async () => {
		const fetchImpl: BridgeFetchLike = async () => { throw new Error('should not upload'); };
		const r = await resolveLoadImageImageRef({ ref: `${BASE}/view?filename=x.png`, baseUrl: BASE, fetchImpl });
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.image, `${BASE}/view?filename=x.png`);
	});

	test('data URL uploads and returns image ref', async () => {
		const fetchImpl: BridgeFetchLike = async (url) => {
			assert.strictEqual(url, `${BASE}/upload/image`);
			return { ok: true, json: () => ({ name: 'x.png' }), text: () => '' };
		};
		const r = await resolveLoadImageImageRef({ ref: 'data:image/png;base64,aGVsbG8=', baseUrl: BASE, fetchImpl });
		assert.strictEqual(r.ok, true);
		assert.ok(r.image?.includes('/view?filename=x.png'));
	});
});
