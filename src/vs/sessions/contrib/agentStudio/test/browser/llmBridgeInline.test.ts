/*---------------------------------------------------------------------------------------------
 *  Unit tests for inlineRemoteImageUrls (common/llmBridge.ts) —
 *  provider 文生图结果的外链 URL 宿主侧内联（CORS / 签名过期修复）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	inlineRemoteImageUrls,
	isRemoteHttpUrl,
	IMAGE_INLINE_MAX_BYTES,
	type IProviderImageEntry,
	type DownloadImageB64,
} from '../../common/llmBridge.js';

suite('inlineRemoteImageUrls', () => {

	test('isRemoteHttpUrl 只认 http(s)', () => {
		assert.strictEqual(isRemoteHttpUrl('https://cos.example.com/a.png'), true);
		assert.strictEqual(isRemoteHttpUrl('http://127.0.0.1:8188/view?filename=x'), true);
		assert.strictEqual(isRemoteHttpUrl('data:image/png;base64,AAA'), false);
		assert.strictEqual(isRemoteHttpUrl('blob:vscode-webview://x'), false);
		assert.strictEqual(isRemoteHttpUrl(''), false);
	});

	test('http(s) URL 被下载为 b64 且删除 url（下游才会走 data: 分支）', async () => {
		const calls: string[] = [];
		const download: DownloadImageB64 = async (url) => {
			calls.push(url);
			return { base64: 'QUJD', contentType: 'image/webp' };
		};
		const r = await inlineRemoteImageUrls([{ url: 'https://cos.example.com/a.png' }], download);
		assert.deepStrictEqual(calls, ['https://cos.example.com/a.png']);
		assert.strictEqual(r.images.length, 1);
		assert.strictEqual(r.images[0].url, undefined, 'url 必须删除，否则 providerImagesToMedia 优先 url 不会生成 data:');
		assert.strictEqual(r.images[0].b64, 'QUJD');
		assert.strictEqual(r.images[0].mime, 'image/webp');
		assert.deepStrictEqual(r.failures, []);
	});

	test('data:/blob:/无 url 条目原样保留（不触发下载）', async () => {
		let calls = 0;
		const download: DownloadImageB64 = async () => { calls++; return { base64: 'X', contentType: 'image/png' }; };
		const input: IProviderImageEntry[] = [
			{ b64: 'AAA' },
			{ url: 'data:image/jpeg;base64,BBB' },
			{ url: 'blob:vscode-webview://x' },
		];
		const r = await inlineRemoteImageUrls(input, download);
		assert.strictEqual(calls, 0);
		assert.deepStrictEqual(r.images, input);
	});

	test('下载失败 → 保留原 url + 记入 failures（优雅降级=现状）', async () => {
		const download: DownloadImageB64 = async () => { throw new Error('HTTP 403'); };
		const r = await inlineRemoteImageUrls([{ url: 'https://cos.example.com/gone.png' }], download);
		assert.strictEqual(r.images[0].url, 'https://cos.example.com/gone.png');
		assert.strictEqual(r.images[0].b64, undefined);
		assert.strictEqual(r.failures.length, 1);
		assert.ok(r.failures[0].includes('HTTP 403'));
	});

	test('空 body 视为失败（防把空串当有效 b64）', async () => {
		const download: DownloadImageB64 = async () => ({ base64: '', contentType: 'image/png' });
		const r = await inlineRemoteImageUrls([{ url: 'https://x/y.png' }], download);
		assert.strictEqual(r.failures.length, 1);
		assert.strictEqual(r.images[0].url, 'https://x/y.png');
	});

	test('多张混合：部分成功部分失败互不影响', async () => {
		const download: DownloadImageB64 = async (url) => {
			if (url.includes('bad')) { throw new Error('timeout'); }
			return { base64: 'OK', contentType: 'image/png' };
		};
		const r = await inlineRemoteImageUrls([
			{ url: 'https://a/ok.png' },
			{ url: 'https://a/bad.png' },
			{ b64: 'KEEP' },
		], download);
		assert.strictEqual(r.images[0].b64, 'OK');
		assert.strictEqual(r.images[1].url, 'https://a/bad.png');
		assert.strictEqual(r.images[2].b64, 'KEEP');
		assert.strictEqual(r.failures.length, 1);
	});

	test('常量护栏存在（防误删上限）', () => {
		assert.ok(IMAGE_INLINE_MAX_BYTES >= 5 * 1024 * 1024);
	});
});
