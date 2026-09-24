/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbImportControllerAgentic.test.ts — agentic 构建路径与 insights 摘要集成测试（tdd 风格）。
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

const VAULT = URI.file('/vault');
const LIB = URI.file('/vault/库');

function noteBlock(path: string, type: string, title: string, body: string): string {
	return `---FILE: ${path} ---\n---\ntype: ${type}\ntitle: ${title}\ncreated: 2026-09-19\n---\n\n# ${title}\n\n${body}\n\n---END FILE---\n`;
}

function createController(fs: any, driver: any) {
	const logService = { info() {}, warn() {}, error() {} };
	return new KbImportController(
		{ getValue: () => undefined } as any,
		logService as any,
		fs,
		{} as any, {} as any,
		{ requestKbRefresh() {} } as any,
		{} as any, {} as any,
		{ notify() {} } as any,
		undefined as any,
		driver,
	);
}

suite('KbImportController._buildNoteAgentic（agentic 构建模式）', () => {

	test('正常路径：FILE 块落盘、driver 形态正确、构建缓存写入', async () => {
		const fs = createTreeFileService();
		fs.addFile('/vault/库/raw/src1.md', '---\ntype: clipping\ntopic: GC\n---\n# 素材\n垃圾回收与内存管理的讨论记录。');
		const captured: { agentId?: string; opts?: any } = {};
		const driver = {
			executeFromChatOptions(agentId: string, _msg: string, opts: any) {
				captured.agentId = agentId; captured.opts = opts;
				return (async function* () {
					yield { type: 'text', content: noteBlock('概念/gc.md', 'concept', 'GC 机制', '垃圾回收的核心机制与分代策略，内容足够长以构成一篇笔记。') };
					yield { type: 'text', content: noteBlock('概念/jvm.md', 'concept', 'JVM 运行时', 'JVM 的运行时数据区与 GC 的关系，内容足够长以构成一篇笔记。') };
					yield { type: 'done' };
				})();
			},
		};
		const controller = createController(fs.service, driver);
		const libFile = URI.file('/vault/库/raw/src1.md');
		const result = await (controller as any)._buildNoteAgentic(libFile, VAULT);

		assert.strictEqual(captured.agentId, 'knowledge-base-expert');
		assert.strictEqual(captured.opts.chatOnly, true, 'agentic 构建以 chatOnly 运行（落盘由控制器统一完成）');
		assert.ok(result && result.includes('gc.md'), `应返回首篇笔记路径，实际 ${result}`);
		assert.ok(fs.getContent('/vault/笔记/概念/gc.md')?.includes('GC 机制'), '笔记 1 已落盘');
		assert.ok(fs.getContent('/vault/笔记/概念/jvm.md')?.includes('JVM'), '笔记 2 已落盘');
		const cache = fs.getContent('/vault/.kb-build-cache.json');
		assert.ok(cache?.includes('src1.md'), '构建缓存已写入');
	});

	test('discard_prior_text：作废已累计文本（Hermes 合成恢复语义）', async () => {
		const fs = createTreeFileService();
		fs.addFile('/vault/库/raw/src2.md', '# 素材\n内容。');
		const driver = {
			executeFromChatOptions() {
				return (async function* () {
					yield { type: 'text', content: '这段是被作废的幻觉输出，不应出现在任何文件中。' };
					yield { type: 'discard_prior_text', metadata: { reason: 'fake-completion' } };
					yield { type: 'text', content: noteBlock('概念/real.md', 'concept', '真实笔记', '真实的笔记正文，长度足够，包含实质内容与结构化信息。') };
				})();
			},
		};
		const controller = createController(fs.service, driver);
		const result = await (controller as any)._buildNoteAgentic(URI.file('/vault/库/raw/src2.md'), VAULT);
		assert.ok(result?.includes('real.md'));
		assert.ok(!fs.allPaths().some(p => p.includes('幻觉')), '作废文本未落盘');
		assert.ok(!fs.getContent('/vault/笔记/概念/real.md')?.includes('作废'), '落盘笔记不含作废文本');
	});

	test('空产出返回 null（调用方回退直连管线）', async () => {
		const fs = createTreeFileService();
		fs.addFile('/vault/库/raw/src3.md', '# 素材\n内容。');
		const driver = {
			executeFromChatOptions() {
				return (async function* () { yield { type: 'done' }; })();
			},
		};
		const controller = createController(fs.service, driver);
		const result = await (controller as any)._buildNoteAgentic(URI.file('/vault/库/raw/src3.md'), VAULT);
		assert.strictEqual(result, null);
	});

	test('构建缓存命中时直接返回（不消耗 agent 轮次）', async () => {
		const fs = createTreeFileService();
		fs.addFile('/vault/库/raw/src4.md', '# 素材\n内容。');
		fs.addFile('/vault/库/概念/existing.md', '# 已构建\n已有笔记。');
		fs.addFile('/vault/.kb-build-cache.json', JSON.stringify({ [URI.file('/vault/库/raw/src4.md').fsPath]: URI.file('/vault/库/概念/existing.md').fsPath }));
		let driverCalled = false;
		const driver = { executeFromChatOptions() { driverCalled = true; return (async function* () { })(); } };
		const controller = createController(fs.service, driver);
		const result = await (controller as any)._buildNoteAgentic(URI.file('/vault/库/raw/src4.md'), VAULT);
		assert.strictEqual(driverCalled, false);
		assert.ok(result?.includes('existing.md'));
	});
});

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
		assert.ok(fs.getContent('/vault/库/.kb-insights-cache.json'), '摘要缓存已落盘');

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
