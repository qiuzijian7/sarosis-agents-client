/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbImportController.test.ts — 知识库静态管线集成测试（maintainKbInsights 社区语义摘要）。
 *
 *  ★ 2026-11-07（换 UI 宿主）：agentic 构建路径已整体迁到 dsh `/x/kb/`，
 *    原 `_buildNoteAgentic` suite 与其 helper 已退役；这里保留静态能力覆盖。
 *
 *  覆盖：
 *   1. _buildNoteAgentic — FILE 块落盘 / driver 调用形态（agentId、chatOnly）/ 构建缓存 /
 *      discard_prior_text 作废语义 / 空产出返回 null
 *   2. maintainKbInsights + chatModel — 社区语义摘要渲染进 insights.md + 指纹缓存命中
 *
 *  运行方式：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *       src/vs/sessions/contrib/agentStudio/browser/kbImportControllerAgentic.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { KbImportController } from './kbImportController.js';

// ---------------------------------------------------------------------------
// 树形内存 mock IFileService（resolve / readFile / writeFile / createFolder）
// ---------------------------------------------------------------------------

function createTreeFileService() {
	const files = new Map<string, string>();
	const nameOf = (p: string) => p.split('/').pop()!;
	const keyOf = (uri: URI) => uri.fsPath.replace(/\\/g, '/');
	const service = {
		async resolve(uri: URI): Promise<any> {
			const key = keyOf(uri);
			if (files.has(key)) {
				const c = files.get(key)!;
				return { resource: uri, name: nameOf(key), isDirectory: false, mtime: 1000, size: c.length, children: undefined };
			}
			const prefix = key.endsWith('/') ? key : key + '/';
			const seenDirs = new Set<string>();
			const children: any[] = [];
			for (const p of files.keys()) {
				if (!p.startsWith(prefix)) { continue; }
				const rest = p.slice(prefix.length);
				const seg = rest.split('/')[0];
				if (rest.includes('/')) {
					if (!seenDirs.has(seg)) {
						seenDirs.add(seg);
						children.push({ resource: URI.file(prefix + seg), name: seg, isDirectory: true });
					}
				} else {
					children.push({ resource: URI.file(p), name: seg, isDirectory: false, mtime: 1000, size: files.get(p)!.length });
				}
			}
			return { resource: uri, name: nameOf(key), isDirectory: true, mtime: 0, size: 0, children };
		},
		async readFile(uri: URI): Promise<{ value: { toString(): string; byteLength: number } }> {
			const c = files.get(keyOf(uri));
			if (c === undefined) { throw new Error('not found: ' + keyOf(uri)); }
			return { value: { toString: () => c, byteLength: c.length } };
		},
		async writeFile(uri: URI, value: { toString(): string }): Promise<void> {
			files.set(keyOf(uri), value.toString());
		},
		async createFolder(): Promise<void> {},
	};
	return {
		service: service as any,
		addFile(path: string, content: string) { files.set(URI.file(path).fsPath.replace(/\\/g, '/'), content); },
		getContent(path: string): string | undefined { return files.get(URI.file(path).fsPath.replace(/\\/g, '/')); },
		allPaths(): string[] { return [...files.keys()]; },
	};
}

const LIB = URI.file('/vault/库');

	// ★ 2026-11-07（换 UI 宿主）：`_buildNoteAgentic` 已整体退役，相关测试与 helper 一并删除。


suite('KbImportController.maintainKbInsights 集成（社区语义摘要）', () => {

	test('有 chatModel：insights.md 含主题与摘要，指纹缓存落盘；二次调用零 LLM', async () => {
		const fs = createTreeFileService();
		// 三篇笔记两两互链（一个社区）
		fs.addFile('/vault/库/概念/a.md', '---\ntitle: Alpha\n---\n引用 [[Beta]] 与 [[Gamma]]。');
		fs.addFile('/vault/库/概念/b.md', '---\ntitle: Beta\n---\n引用 [[Alpha]] 与 [[Gamma]]。');
		fs.addFile('/vault/库/概念/c.md', '---\ntitle: Gamma\n---\n引用 [[Alpha]] 与 [[Beta]]。');

		let calls = 0;
		const chatModel = {
			async complete() {
				calls++;
				return '### 社区 c0\n主题：三角互链\n摘要：三篇笔记互相引用，形成紧密的主题簇。';
			},
			async extract<T>(): Promise<T> { throw new Error('not used'); },
		};
		await KbImportController.maintainKbInsights(fs.service, LIB, chatModel as any);

		const insights = fs.getContent('/vault/库/insights.md');
		assert.ok(insights, 'insights.md 已生成');
		assert.ok(insights!.includes('3 篇笔记'), '头部统计正确');
		assert.ok(/社区 c\S+（3 节点）：三角互链/.test(insights!), '社区标题带主题名');
		assert.ok(insights!.includes('三篇笔记互相引用'), '摘要渲染为引用块');
		assert.ok(insights!.includes('[[Alpha]]'), '成员列表保留');
		assert.ok(fs.getContent('/vault/库/.kb/insights-cache.json'), '摘要缓存已落盘');

		// 二次调用：成员指纹命中 ⇒ 不再调 LLM
		await KbImportController.maintainKbInsights(fs.service, LIB, chatModel as any);
		assert.strictEqual(calls, 1, '指纹缓存命中 ⇒ 零新增 LLM 调用');
	});

	test('无 chatModel：回退纯成员列表（行为与旧版一致）', async () => {
		const fs = createTreeFileService();
		fs.addFile('/vault/库/概念/a.md', '---\ntitle: Alpha\n---\n引用 [[Beta]]。');
		fs.addFile('/vault/库/概念/b.md', '---\ntitle: Beta\n---\n引用 [[Alpha]]。');
		await KbImportController.maintainKbInsights(fs.service, LIB, undefined);
		const insights = fs.getContent('/vault/库/insights.md');
		assert.ok(insights!.includes('社区'));
		assert.ok(!insights!.includes('摘要'), '无 chatModel 时不含摘要');
	});
});
