/*---------------------------------------------------------------------------------------------
 *  KbLinkGraph 单元测试 — 双链图谱构建 / 反链查询 / 图数据导出
 *  纯内存，不依赖 DOM / Worker / 网络。
 *
 *  运行：
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *      src/vs/sessions/contrib/agentStudio/test/browser/kbGraph.test.ts
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { KbLinkGraph } from '../../browser/views/knowledgeBase/kbGraph.js';
import type { KbSection } from '../../browser/views/knowledgeBase/kbTypes.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService, IFileStatWithMetadata } from '../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';

// ─── Mock FileService（内存）────────────────────────────────────────────────

class MockFileService implements Partial<IFileService> {
	private files = new Map<string, { content: string; mtime: number }>();

	async readFile(resource: URI): Promise<{ value: VSBuffer }> {
		const f = this.files.get(resource.toString());
		if (!f) { throw new Error(`ENOENT: ${resource.toString()}`); }
		return { value: VSBuffer.fromString(f.content) };
	}

	async resolve(resource: URI): Promise<IFileStatWithMetadata> {
		const f = this.files.get(resource.toString());
		if (!f) { throw new Error(`ENOENT: ${resource.toString()}`); }
		return {
			resource,
			mtime: f.mtime,
			ctime: f.mtime,
			size: f.content.length,
			isDirectory: false,
			isFile: true,
			isSymbolicLink: false,
			readonly: false,
			etag: '',
		} as unknown as IFileStatWithMetadata;
	}

	addFile(path: string, content: string, mtime = Date.now()): void {
		this.files.set(URI.file(path).toString(), { content, mtime });
	}

	clear(): void { this.files.clear(); }
}

// ─── 工具 ─────────────────────────────────────────────────────────────────

function mkUri(fsPath: string): URI { return URI.file(fsPath); }

/** 便捷创建并注册测试文档，返回 buildFromDocs 所需的参数对象数组。
 *  name 必须带 .md 扩展名，否则会被 MD_EXTS 过滤跳过。 */
function mkDocs(
	fileService: MockFileService,
	items: { path: string; name: string; section: KbSection; text: string }[],
): { uri: URI; name: string; section: KbSection; mtime: number; text: string }[] {
	return items.map((it, i) => {
		fileService.addFile(it.path, it.text, 1000 + i);
		return { uri: mkUri(it.path), name: it.name + '.md', section: it.section, mtime: 1000 + i, text: it.text };
	});
}

// ─── 测试 ─────────────────────────────────────────────────────────────────

suite('KbLinkGraph — 双链图谱', () => {
	let fileService: MockFileService;
	let graph: KbLinkGraph;

	setup(() => {
		fileService = new MockFileService();
		graph = new KbLinkGraph(fileService as unknown as IFileService);
	});

	// ─── buildFromDocs 基础 ────────────────────────────────────────────────

	test('buildFromDocs：空文档集 → 空图谱', () => {
		graph.buildFromDocs([]);
		const data = graph.getGraphData();
		assert.strictEqual(data.nodes.length, 0);
		assert.strictEqual(data.links.length, 0);
	});

	test('buildFromDocs：单个文档无链接 → 仅一个节点', () => {
		const docs = mkDocs(fileService, [{ path: '/notes/a.md', name: 'a', section: 'notes', text: '# Note A\nNo links.' }]);
		graph.buildFromDocs(docs);
		const data = graph.getGraphData();
		assert.strictEqual(data.nodes.length, 1);
		assert.strictEqual(data.nodes[0].label, 'a'); // label 已去扩展名
		assert.strictEqual(data.nodes[0].refs, 0);
		assert.strictEqual(data.links.length, 0);
	});

	test('buildFromDocs：文档间双链 → 正确边', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/a.md', name: 'a', section: 'notes', text: 'Link to [[b]]' },
			{ path: '/notes/b.md', name: 'b', section: 'notes', text: 'No outgoing' },
		]);
		graph.buildFromDocs(docs);
		const data = graph.getGraphData();
		assert.strictEqual(data.nodes.length, 2);
		assert.strictEqual(data.links.length, 1);
		assert.strictEqual(data.links[0].source, mkUri('/notes/a.md').toString());
		assert.strictEqual(data.links[0].target, mkUri('/notes/b.md').toString());
	});

	test('buildFromDocs：多个相同链接（未在 getGraphData 去重，记录为3条原始链接）', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/a.md', name: 'a', section: 'notes', text: '[[b]] and [[b]] and [[b]] again' },
			{ path: '/notes/b.md', name: 'b', section: 'notes', text: 'ok' },
		]);
		graph.buildFromDocs(docs);
		// getGraphData 逐条生成 link（按 outgoing 原始列表），不去重同一 source→target
		assert.strictEqual(graph.getGraphData().links.length, 3);
		// 但 backlinks 的去重由 _byTarget（Set）保证
		assert.strictEqual(graph.backlinks(mkUri('/notes/b.md').toString()).length, 1);
	});

	test('buildFromDocs：broken link 不产生 link（目标不在库内）', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/a.md', name: 'a', section: 'notes', text: 'See [[missing-note]]' },
		]);
		graph.buildFromDocs(docs);
		const data = graph.getGraphData();
		// missing-note 无对应文档 → getGraphData 跳过 → links 为 0
		assert.strictEqual(data.links.length, 0);
		assert.strictEqual(data.nodes.length, 1); // 只有 a 节点
	});

	// ─── backlinks / outgoingLinks ─────────────────────────────────────────

	test('backlinks：双链 A→B，B 有反链', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/a.md', name: 'a', section: 'notes', text: 'See [[b]] for details' },
			{ path: '/notes/b.md', name: 'b', section: 'notes', text: 'No outgoing' },
		]);
		graph.buildFromDocs(docs);
		const backB = graph.backlinks(mkUri('/notes/b.md').toString());
		assert.strictEqual(backB.length, 1);
		assert.strictEqual(backB[0].name, 'a.md'); // backlinks name 含扩展名
		assert.ok(backB[0].snippet.includes('See'));
	});

	test('outgoingLinks：A→B，A 有出链', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/a.md', name: 'a', section: 'notes', text: 'See [[b]]' },
			{ path: '/notes/b.md', name: 'b', section: 'notes', text: 'ok' },
		]);
		graph.buildFromDocs(docs);
		const outA = graph.outgoingLinks(mkUri('/notes/a.md').toString());
		assert.strictEqual(outA.length, 1);
		assert.strictEqual(outA[0].targetName, 'b');
		assert.ok(outA[0].targetUri);
	});

	test('backlinks：无反链 → 空数组', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/orphan.md', name: 'orphan', section: 'notes', text: 'isolated' },
		]);
		graph.buildFromDocs(docs);
		assert.strictEqual(graph.backlinks(mkUri('/notes/orphan.md').toString()).length, 0);
		assert.strictEqual(graph.outgoingLinks(mkUri('/notes/orphan.md').toString()).length, 0);
	});

	test('backlinks：多个文档指向同一目标', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/x.md', name: 'x', section: 'notes', text: 'See [[hub]]' },
			{ path: '/notes/y.md', name: 'y', section: 'notes', text: 'Also [[hub]]' },
			{ path: '/notes/hub.md', name: 'hub', section: 'notes', text: 'Target' },
		]);
		graph.buildFromDocs(docs);
		const backHub = graph.backlinks(mkUri('/notes/hub.md').toString());
		assert.strictEqual(backHub.length, 2);
		assert.deepStrictEqual(backHub.map(b => b.name).sort(), ['x.md', 'y.md']);
	});

	// ─── 特殊链接格式 ──────────────────────────────────────────────────────

	test('buildFromDocs：[[name|alias]] 别名链接', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/a.md', name: 'a', section: 'notes', text: 'See [[b|click here]]' },
			{ path: '/notes/b.md', name: 'b', section: 'notes', text: 'ok' },
		]);
		graph.buildFromDocs(docs);
		assert.strictEqual(graph.getGraphData().links.length, 1);
		assert.strictEqual(graph.getGraphData().links[0].target, mkUri('/notes/b.md').toString());
	});

	test('buildFromDocs：[[name#heading]] 标题链接', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/a.md', name: 'a', section: 'notes', text: 'See [[b#section]]' },
			{ path: '/notes/b.md', name: 'b', section: 'notes', text: 'ok' },
		]);
		graph.buildFromDocs(docs);
		assert.strictEqual(graph.getGraphData().links.length, 1);
	});

	test('buildFromDocs：[[name#heading|alias]] 组合', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/a.md', name: 'a', section: 'notes', text: 'See [[b#section|Read section]]' },
			{ path: '/notes/b.md', name: 'b', section: 'notes', text: 'ok' },
		]);
		graph.buildFromDocs(docs);
		assert.strictEqual(graph.getGraphData().links.length, 1);
	});

	// ─── 分区 ──────────────────────────────────────────────────────────────

	test('buildFromDocs：跨分区双链仍然连接（library → notes）', () => {
		const docs = mkDocs(fileService, [
			{ path: '/library/a.md', name: 'a', section: 'library', text: 'See [[b]]' },
			{ path: '/notes/b.md', name: 'b', section: 'notes', text: 'ok' },
		]);
		graph.buildFromDocs(docs);
		const data = graph.getGraphData();
		assert.strictEqual(data.nodes.length, 2);
		assert.strictEqual(data.links.length, 1);
		assert.strictEqual(data.links[0].source, mkUri('/library/a.md').toString());
		assert.strictEqual(data.links[0].target, mkUri('/notes/b.md').toString());
	});

	// ─── GraphData 结构 ────────────────────────────────────────────────────

	test('getGraphData：节点结构完整', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/a.md', name: 'a', section: 'notes', text: 'Hello' },
		]);
		graph.buildFromDocs(docs);
		const node = graph.getGraphData().nodes[0];
		assert.ok(node.id.startsWith('file:///'));
		assert.strictEqual(node.label, 'a');
		assert.strictEqual(node.type, 'doc');
		assert.strictEqual(node.refs, 0);
		assert.strictEqual(node.defs, 0);
	});

	test('getGraphData：多次调用返回拷贝（不可变）', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/a.md', name: 'a', section: 'notes', text: 'Hello' },
		]);
		graph.buildFromDocs(docs);
		const d1 = graph.getGraphData();
		const d2 = graph.getGraphData();
		assert.notStrictEqual(d1.nodes, d2.nodes, 'nodes should be a copy');
		assert.notStrictEqual(d1.links, d2.links, 'links should be a copy');
	});

	test('getGraphData：无链接文档 → 无 links', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/a.md', name: 'a', section: 'notes', text: 'No links' },
			{ path: '/notes/b.md', name: 'b', section: 'notes', text: 'No links' },
		]);
		graph.buildFromDocs(docs);
		const data = graph.getGraphData();
		assert.strictEqual(data.nodes.length, 2);
		assert.strictEqual(data.links.length, 0);
	});

	test('getGraphData：复杂图谱（hub 中心）', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/hub.md', name: 'hub', section: 'notes', text: '[[a]] [[b]] [[c]]' },
			{ path: '/notes/a.md', name: 'a', section: 'notes', text: '[[hub]]' },
			{ path: '/notes/b.md', name: 'b', section: 'notes', text: '[[hub]]' },
			{ path: '/notes/c.md', name: 'c', section: 'notes', text: 'No links' },
		]);
		graph.buildFromDocs(docs);
		const data = graph.getGraphData();
		assert.strictEqual(data.nodes.length, 4);
		// hub→a, hub→b, hub→c, a→hub, b→hub
		assert.strictEqual(data.links.length, 5);
	});

	test('buildFromDocs：系统文件（index.md）也会进图谱（walk 过滤，buildFromDocs 不区分）', () => {
		const docs = mkDocs(fileService, [
			{ path: '/notes/index.md', name: 'index', section: 'notes', text: '[[a]]' },
			{ path: '/notes/a.md', name: 'a', section: 'notes', text: 'ok' },
		]);
		graph.buildFromDocs(docs);
		// buildFromDocs 只按扩展名过滤，不检查 SYS_FILES → index.md 被包含
		const data = graph.getGraphData();
		assert.strictEqual(data.nodes.length, 2);
		assert.strictEqual(data.links.length, 1); // index→a
	});

	test('buildFromDocs：连续重建（reset）', () => {
		const docs1 = mkDocs(fileService, [
			{ path: '/notes/a.md', name: 'a', section: 'notes', text: '[[b]]' },
		]);
		graph.buildFromDocs(docs1);
		assert.strictEqual(graph.getGraphData().nodes.length, 1);

		// 重建：新数据集替换旧数据
		fileService.clear();
		const docs2 = mkDocs(fileService, [
			{ path: '/notes/x.md', name: 'x', section: 'notes', text: '[[y]]' },
			{ path: '/notes/y.md', name: 'y', section: 'notes', text: 'ok' },
		]);
		graph.buildFromDocs(docs2);
		assert.strictEqual(graph.getGraphData().nodes.length, 2);
		assert.strictEqual(graph.getGraphData().links.length, 1);
	});
});
