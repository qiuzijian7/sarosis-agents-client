/*---------------------------------------------------------------------------------------------
 *  kbMediaViewerKinds 单测（纯函数，不依赖 VS Code 运行时）。
 *
 *  ★ 2026-09-24 用户要求：「知识库中的 png/svg 图片要在 editorPane 中显示」。
 *  这里锁住三件事：
 *    ① 图片类型确实被查看器接管（否则双击 ⇒ 文本编辑器 ⇒ 满屏二进制）；
 *    ② MIME 正确（`data:` URI 拼错 ⇒ 图片不显示）；
 *    ③ **kinds ↔ resolver glob 不漂移**（只加 kinds 不注册 glob ⇒ 仍走文本编辑器，静默失效）。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	extOfPath, imageMimeOf, isKbMediaViewerFile, KB_MEDIA_KINDS, KB_MEDIA_VIEWER_GLOBS, mediaKindOf,
} from './kbMediaViewerKinds.js';

const at = (name: string) => ({ path: `/vault/笔记/assets/${name}` });

suite('kbMediaViewerKinds · 图片/文档接管', () => {

	test('图片扩展名 ⇒ 种类 image（大小写不敏感）', () => {
		for (const name of ['a.png', 'b.PNG', 'c.jpg', 'd.jpeg', 'e.jfif', 'f.gif', 'g.webp', 'h.bmp', 'i.avif', 'j.ico', 'k.svg', 'l.SVG']) {
			assert.strictEqual(mediaKindOf(at(name)), 'image', `${name} 应交给图片查看器`);
			assert.ok(isKbMediaViewerFile(at(name)), `${name} 应被接管`);
		}
	});

	test('pdf / docx 仍接管（既有能力不回归）', () => {
		assert.strictEqual(mediaKindOf(at('x.pdf')), 'pdf');
		assert.strictEqual(mediaKindOf(at('y.docx')), 'docx');
	});

	test('笔记与其它类型**不**接管（各有既有打开路径）', () => {
		for (const name of ['n.md', 'n.markdown', 'archive.txt', 'flow.drawio', 'map.canvas', 'flow.mermaid', 'page.html', 'data.json']) {
			assert.strictEqual(mediaKindOf(at(name)), undefined, `${name} 不应被媒体查看器接管`);
			assert.ok(!isKbMediaViewerFile(at(name)));
		}
		assert.strictEqual(mediaKindOf({ path: '/vault/无扩展名' }), undefined, '无扩展名不接管');
		assert.strictEqual(mediaKindOf({ path: '/vault/.hidden' }), undefined, '以点开头无扩展名不接管');
	});

	test('图片 MIME 映射（svg 必须是 +xml，否则 data: URI 不渲染）', () => {
		assert.strictEqual(imageMimeOf('a.png'), 'image/png');
		assert.strictEqual(imageMimeOf('a.JPG'), 'image/jpeg');
		assert.strictEqual(imageMimeOf('a.jpeg'), 'image/jpeg');
		assert.strictEqual(imageMimeOf('a.jfif'), 'image/jpeg');
		assert.strictEqual(imageMimeOf('a.svg'), 'image/svg+xml');
		assert.strictEqual(imageMimeOf('a.gif'), 'image/gif');
		assert.strictEqual(imageMimeOf('a.webp'), 'image/webp');
		assert.strictEqual(imageMimeOf('a.bmp'), 'image/bmp');
		assert.strictEqual(imageMimeOf('a.avif'), 'image/avif');
		assert.strictEqual(imageMimeOf('a.ico'), 'image/x-icon');
		assert.strictEqual(imageMimeOf('a.pdf'), undefined, '非图片不给 MIME');
	});

	test('★ 防漂移：每个被接管的扩展名都必须在 resolver glob 列表里', () => {
		const globs = new Set(KB_MEDIA_VIEWER_GLOBS.map(g => g.pattern.replace(/^\*\./, '')));
		for (const ext of Object.keys(KB_MEDIA_KINDS)) {
			assert.ok(globs.has(ext), `${ext} 已接管但没注册 glob ⇒ 打开它仍会走文本编辑器（静默失效）`);
		}
	});

	test('防漂移（反向）：glob 列表里的扩展名也必须被接管，避免注册了却没人渲染', () => {
		for (const g of KB_MEDIA_VIEWER_GLOBS) {
			const ext = g.pattern.replace(/^\*\./, '');
			assert.ok(KB_MEDIA_KINDS[ext], `glob ${g.pattern} 没有对应的渲染器种类`);
		}
	});

	test('extOfPath：取最后一段的扩展名（路径分隔符两种都支持）', () => {
		assert.strictEqual(extOfPath('C:\\vault\\库\\raw\\a.PNG'), 'png');
		assert.strictEqual(extOfPath('/vault/库/raw/a.svg'), 'svg');
		assert.strictEqual(extOfPath('/vault/dir.with.dot/file'), '', '目录里的点不算扩展名');
	});
});
