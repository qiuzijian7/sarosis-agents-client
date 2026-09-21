/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbAttachmentStore.test.ts — 附件相对引用路径生成（媒体库沉淀方案的正文替换目标）。
 *
 *  运行：node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/browser/knowledge/kbAttachmentStore.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { KbAttachmentStore } from './kbAttachmentStore.js';

suite('KbAttachmentStore.relativeRef（附件相对引用）', () => {

	test('同目录规则：<note>.attachments/<id><ext>', () => {
		const note = URI.file('/vault/库/概念/GC 机制.md');
		assert.strictEqual(
			KbAttachmentStore.relativeRef(note, 'm1abc', 'shot.png'),
			'GC 机制.attachments/m1abc.png',
		);
	});

	test('保留原始扩展名（jpg）', () => {
		const note = URI.file('/vault/库/概念/a.md');
		assert.strictEqual(KbAttachmentStore.relativeRef(note, 'x2', 'photo.jpeg'), 'a.attachments/x2.jpeg');
	});

	test('无扩展名文件名不追加点', () => {
		const note = URI.file('/vault/库/概念/a.markdown');
		assert.strictEqual(KbAttachmentStore.relativeRef(note, 'x3', 'noext'), 'a.attachments/x3');
	});

	test('与 dirUri 的目录命名一致（同一笔记同一附件目录）', () => {
		const note = URI.file('/vault/库/概念/a.md');
		const dir = KbAttachmentStore.dirUri(note);
		assert.ok(dir.path.endsWith('a.attachments'), dir.path);
		assert.ok(KbAttachmentStore.relativeRef(note, 'id1', 'p.png').startsWith('a.attachments/'));
	});
});
