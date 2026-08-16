/*---------------------------------------------------------------------------------------------
 *  媒体资产纯函数测试：自动收录判定 / picker kind 推断 / 画廊工具。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { shouldCollectMedia, parseDataUrl } from '../../webview/src/features/workflowEditor/comfyHost/mediaCollect.js';
import { inferPickerKind } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import { formatBytes, assetFileName } from '../../webview/src/features/workflowEditor/mediaGalleryUtils.js';

suite('shouldCollectMedia (自动收录判定)', () => {

	test('空 ref / blob: URL 不收录', () => {
		assert.strictEqual(shouldCollectMedia('wf', '', new Set()), null);
		assert.strictEqual(shouldCollectMedia('wf', 'blob:http://local/uuid', new Set()), null);
	});

	test('http(s) URL → provider comfyui；其他 → local', () => {
		const d = shouldCollectMedia('wf1', 'http://localhost:8188/view?filename=a.png', new Set());
		assert.ok(d);
		assert.strictEqual(d.provider, 'comfyui');
		assert.strictEqual(d.key, 'wf1:http://localhost:8188/view?filename=a.png');

		const d2 = shouldCollectMedia('wf1', 'data:image/png;base64,AA', new Set());
		assert.ok(d2);
		assert.strictEqual(d2.provider, 'local');
	});

	test('同一 workflow + ref 已收录则去重', () => {
		const collected = new Set(['wf1:http://h/a.png']);
		assert.strictEqual(shouldCollectMedia('wf1', 'http://h/a.png', collected), null);
		// 不同 workflow 同 ref 不算重复
		const d = shouldCollectMedia('wf2', 'http://h/a.png', collected);
		assert.ok(d);
		assert.strictEqual(d.key, 'wf2:http://h/a.png');
	});

	test('已收录后手动加入 set 的 key 会挡住下一次', () => {
		const collected = new Set<string>();
		const d = shouldCollectMedia('wf', 'http://h/x.png', collected);
		assert.ok(d);
		collected.add(d.key);
		assert.strictEqual(shouldCollectMedia('wf', 'http://h/x.png', collected), null);
	});
});

suite('parseDataUrl (物化 data URL → 落盘载荷)', () => {

	test('拆出 base64 / mime / ext', () => {
		const p = parseDataUrl('data:image/png;base64,iVBORw0KGgo=');
		assert.ok(p);
		assert.strictEqual(p.base64, 'iVBORw0KGgo=');
		assert.strictEqual(p.mime, 'image/png');
		assert.strictEqual(p.ext, 'png');
	});

	test('jpeg → jpg；webp 保持；未知 mime 用 subtype 兜底', () => {
		assert.strictEqual(parseDataUrl('data:image/jpeg;base64,AA')?.ext, 'jpg');
		assert.strictEqual(parseDataUrl('data:image/webp;base64,AA')?.ext, 'webp');
		assert.strictEqual(parseDataUrl('data:video/mp4;base64,AA')?.ext, 'mp4');
		// 未在映射表内 → 取 subtype
		assert.strictEqual(parseDataUrl('data:image/heic;base64,AA')?.ext, 'heic');
	});

	test('非 data URL / 非 base64 / 空载荷 → null（调用方回退为 URL 引用）', () => {
		assert.strictEqual(parseDataUrl('http://localhost:8188/view?filename=a.png'), null);
		assert.strictEqual(parseDataUrl(''), null);
		// URL-encoded（非 base64）data URL 不能当二进制落盘
		assert.strictEqual(parseDataUrl('data:text/plain,hello'), null);
		// 有 base64 标记但载荷为空
		assert.strictEqual(parseDataUrl('data:image/png;base64,'), null);
	});

	test('header 带额外参数时仍能解析', () => {
		const p = parseDataUrl('data:image/png;charset=utf-8;base64,AAAB');
		assert.ok(p);
		assert.strictEqual(p.mime, 'image/png');
		assert.strictEqual(p.ext, 'png');
		assert.strictEqual(p.base64, 'AAAB');
	});
});

suite('inferPickerKind (picker 节点 kind 推断)', () => {

	test('Video/Audio/Image 映射', () => {
		assert.strictEqual(inferPickerKind('ComfyTV.VideoPickerStage', 'x'), 'video');
		assert.strictEqual(inferPickerKind('ComfyTV.AudioPickerStage', 'x'), 'audio');
		assert.strictEqual(inferPickerKind('ComfyTV.ImagePickerStage', 'x'), 'image');
		assert.strictEqual(inferPickerKind('ComfyTV.LoadImage', 'x'), 'image');
	});
});

suite('mediaGalleryUtils (画廊工具)', () => {

	test('formatBytes 人类可读', () => {
		assert.strictEqual(formatBytes(undefined), '0 B');
		assert.strictEqual(formatBytes(0), '0 B');
		assert.strictEqual(formatBytes(512), '512 B');
		assert.strictEqual(formatBytes(1024), '1 KB');
		assert.strictEqual(formatBytes(1536), '1.5 KB');
		assert.strictEqual(formatBytes(1048576), '1 MB');
		assert.strictEqual(formatBytes(200 * 1048576), '200 MB');
		assert.strictEqual(formatBytes(3 * 1073741824), '3 GB');
	});

	test('assetFileName 优先级：fileName > URL 尾部 > key+kind', () => {
		assert.strictEqual(assetFileName({ fileName: 'my.png', ref: 'http://h/a.png', id: 'i', kind: 'image' }), 'my.png');
		assert.strictEqual(assetFileName({ fileName: undefined, ref: 'http://localhost:8188/view?filename=out_00001_.png&subfolder=&type=output', id: 'i', kind: 'image' }), 'out_00001_.png');
		assert.strictEqual(assetFileName({ fileName: undefined, ref: 'http://h/noext', id: 'abc', kind: 'image' }), 'abc.png');
		assert.strictEqual(assetFileName({ fileName: undefined, ref: 'data:image/png;base64,AA', id: 'xyz', kind: 'video' }), 'xyz.mp4');
	});
});
