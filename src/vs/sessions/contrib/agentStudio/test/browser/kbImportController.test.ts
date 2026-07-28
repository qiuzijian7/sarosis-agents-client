/*---------------------------------------------------------------------------------------------
 *  KbImportController 确定性导航/源追溯/洞察/级联删除 单元测试。
 *  - 内存 FileService mock：支持 resolve 递归目录树 / readFile / writeFile / del。
 *  - 覆盖 P2（index.md 导航面、sources[] 源追溯、级联删除）与 P3（overview.md、
 *    insights.md 社区发现、内容哈希增量缓存）的纯确定性逻辑。
 *
 *  运行（从仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/kbImportController.test.ts
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { KbImportController, createKbImportHandler } from '../../browser/kbImportController.js';
import { DEFAULT_KB_SCHEMA, buildSchemaPromptText, findTypeById, sanitizeKbTopic } from '../../browser/knowledge/kbSchema.js';
import { safeSchemaFallback } from '../../browser/knowledge/classifier.js';

interface IMockStat {
	resource: URI;
	name: string;
	isDirectory: boolean;
	mtime: number;
	size: number;
	children?: IMockStat[];
}

/** 极简内存文件系统，满足 _collectMdFiles / maintain / cascade 的 IFileService 子集需求。 */
class MockFileService {
	private _files = new Map<string, string>();
	private _dirs = new Set<string>();
	/** 文件添加时间（用于模拟 mtime） */
	private _mtimes = new Map<string, number>();
	/** writeFile 实际落盘次数（用于验证增量缓存）。 */
	writeCount = 0;
	/** del 调用记录（用于验证级联删除）。 */
	deleted: string[] = [];

	private _regAncestors(uri: URI): void {
		const parts = uri.path.split('/').filter(Boolean);
		for (let i = 1; i < parts.length; i++) {
			const p = '/' + parts.slice(0, i).join('/');
			this._dirs.add(URI.from({ scheme: uri.scheme, path: p }).toString());
		}
	}

	addFile(uri: URI, content: string): void {
		this._files.set(uri.toString(), content);
		this._mtimes.set(uri.toString(), Date.now());
		this._regAncestors(uri);
	}

	addDir(uri: URI): void {
		this._regAncestors(uri);
		this._dirs.add(uri.toString());
	}

	contentOf(uri: URI): string | undefined {
		return this._files.get(uri.toString());
	}

	private _statOf(uri: URI): IMockStat {
		const key = uri.toString();
		if (this._files.has(key)) {
			const c = this._files.get(key)!;
			return { resource: uri, name: uri.path.split('/').pop()!, isDirectory: false, mtime: this._mtimes.get(key) ?? Date.now(), size: c.length };
		}
		return { resource: uri, name: uri.path.split('/').pop()!, isDirectory: true, mtime: Date.now(), size: 0, children: this._childrenOf(uri) };
	}

	private _childrenOf(dir: URI): IMockStat[] {
		const dirKey = dir.toString();
		const dirPath = dir.path;
		const seen = new Set<string>();
		const out: IMockStat[] = [];
		const consider = (key: string): void => {
			if (key === dirKey) { return; }
			const childUri = URI.parse(key);
			const parentPath = childUri.path.substring(0, childUri.path.lastIndexOf('/'));
			if (parentPath === dirPath) {
				const name = childUri.path.split('/').pop()!;
				if (!seen.has(name)) { seen.add(name); out.push(this._statOf(childUri)); }
			}
		};
		for (const k of this._files.keys()) { consider(k); }
		for (const k of this._dirs.keys()) { consider(k); }
		return out;
	}

	async resolve(uri: URI): Promise<IMockStat> {
		const key = uri.toString();
		if (!this._files.has(key) && !this._dirs.has(key)) { throw new Error('ENOENT ' + key); }
		return this._statOf(uri);
	}

	async readFile(uri: URI): Promise<{ value: VSBuffer }> {
		const c = this._files.get(uri.toString());
		if (c === undefined) { throw new Error('ENOENT file ' + uri.toString()); }
		return { value: VSBuffer.fromString(c) };
	}

	async writeFile(uri: URI, content: VSBuffer): Promise<void> {
		this.writeCount++;
		this._files.set(uri.toString(), content.toString());
		this._regAncestors(uri);
	}

	async del(uri: URI): Promise<void> {
		this.deleted.push(uri.toString());
		const key = uri.toString();
		const prefix = key.endsWith('/') ? key : key + '/';
		for (const k of [...this._files.keys()]) {
			if (k === key || k.startsWith(prefix)) { this._files.delete(k); }
		}
		for (const k of [...this._dirs.keys()]) {
			if (k === key || k.startsWith(prefix)) { this._dirs.delete(k); }
		}
	}

	async createFolder(uri: URI): Promise<void> { this._regAncestors(uri); this._dirs.add(uri.toString()); }

	/** IFileService.move 子集（去重迁移测试需要）：仅支持单文件移动。 */
	async move(source: URI, target: URI, _overwrite?: boolean): Promise<IMockStat> {
		const content = this._files.get(source.toString());
		if (content === undefined) { throw new Error('ENOENT move ' + source.toString()); }
		this._files.delete(source.toString());
		this._mtimes.delete(source.toString());
		this._files.set(target.toString(), content);
		this._mtimes.set(target.toString(), Date.now());
		this._regAncestors(target);
		return this._statOf(target);
	}

	/** 列出所有文件 key（uri.toString 形式）；contains 按 percent-decoded 形式匹配（兼容中文目录）。 */
	listFiles(contains = ''): string[] {
		return [...this._files.keys()].filter(k => decodeURIComponent(k).includes(contains));
	}
}

suite('AgentStudio - KbImportController 确定性导航/源追溯/洞察', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// 说明：VS Code URI 在 Windows 盘符路径（C:/...）上存在编解码怪异，会破坏内存 FS 的 key 匹配；
	// 用无盘符的 /vault/notes 路径时，root 与笔记的 fsPath 均为一致的前向斜杠形式，rel 计算与收集均稳定。
	const notesRoot = () => URI.file('/vault/notes');

	// ── parseNoteSources（P2b 源追溯解析，纯静态）─────────────────────────────────
	test('parseNoteSources 无 frontmatter → 空数组', () => {
		assert.deepStrictEqual(KbImportController.parseNoteSources('# 标题\n正文'), []);
	});

	test('parseNoteSources 块序列 sources → 归一化 basename', () => {
		const md = '---\nsources:\n  - "库/LibA.md"\n  - [[库/LibB.md]]\n---\n正文';
		const r = KbImportController.parseNoteSources(md);
		assert.deepStrictEqual(r.sort(), ['liba.md', 'libb.md']);
	});

	test('parseNoteSources 流列表 sources → 归一化 basename', () => {
		const md = '---\nsources: ["库/LibA.md", "[[库/LibB.md]]"]\n---\n正文';
		const r = KbImportController.parseNoteSources(md);
		assert.deepStrictEqual(r.sort(), ['liba.md', 'libb.md']);
	});

	test('parseNoteSources 缺失 sources → 空数组', () => {
		assert.deepStrictEqual(KbImportController.parseNoteSources('---\ntitle: x\n---\n正文'), []);
	});

	// ── maintainKbIndex（P2a 导航面 + P3b 增量缓存）──────────────────────────────
	test('maintainKbIndex 按类型分组输出 wikilink 索引并排除系统文件', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		fs.addFile(URI.joinPath(root, '实体/x.md'), '# X');
		fs.addFile(URI.joinPath(root, '概念/y.md'), '# Y');
		fs.addFile(URI.joinPath(root, '杂记/z.md'), '# Z');

		await KbImportController.maintainKbIndex(fs as any, root);
		const idx = fs.contentOf(URI.joinPath(root, 'index.md'))!;
		assert.ok(idx.includes('## 实体') && idx.includes('- [[实体/x|x]]'), '应列出实体类型与笔记');
		assert.ok(idx.includes('## 概念') && idx.includes('- [[概念/y|y]]'), '应列出概念类型与笔记');
		assert.ok(idx.includes('## 杂记'), '兜底类型也应出现');
		assert.ok(idx.includes('[[overview]]') && idx.includes('[[insights]]'), '应注入高层导航/洞察链接');
		assert.ok(!idx.includes('- [[index|index]]'), 'index.md 自身不应被收录');
	});

	test('maintainKbIndex 内容未变时走增量缓存（仅写一次）', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		fs.addFile(URI.joinPath(root, '实体/x.md'), '# X');

		await KbImportController.maintainKbIndex(fs as any, root);
		const afterFirst = fs.writeCount;
		await KbImportController.maintainKbIndex(fs as any, root);
		assert.strictEqual(fs.writeCount, afterFirst, '内容未变，第二次不应再写文件');
	});

	// P0 改进：frontmatter type 分组（对齐 llm_wiki rebuild_wiki_index）
	test('maintainKbIndex 按 frontmatter type 分组（而非目录路径）', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		// 笔记在 01_学习 目录下（非 schema 类型目录），但 frontmatter type=concept
		fs.addFile(URI.joinPath(root, '01_学习', 'AI_Agent', 'note.md'), '---\ntype: concept\ntitle: AI Agent笔记\ncreated: 2026-07-24\n---\n# 内容');
		// 另一笔记在概念目录下，type=synthesis
		fs.addFile(URI.joinPath(root, '概念', '总结.md'), '---\ntype: synthesis\ntitle: GC优化总结\ncreated: 2026-07-24\n---\n# 总结');

		await KbImportController.maintainKbIndex(fs as any, root);
		const idx = fs.contentOf(URI.joinPath(root, 'index.md'))!;
		// 关键：按 frontmatter type 分组，而非目录路径
		assert.ok(idx.includes('## concept'), '应按 frontmatter type=concept 分组');
		assert.ok(idx.includes('## synthesis'), '应按 frontmatter type=synthesis 分组');
		assert.ok(!idx.includes('## 01_学习'), '不应按目录路径 01_学习 分组');
	});

	test('maintainKbIndex 无 frontmatter 时回退到目录路径分组', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		fs.addFile(URI.joinPath(root, '实体/x.md'), '# X（无 frontmatter）');

		await KbImportController.maintainKbIndex(fs as any, root);
		const idx = fs.contentOf(URI.joinPath(root, 'index.md'))!;
		assert.ok(idx.includes('## 实体'), '无 frontmatter 时应回退到目录路径分组');
	});

	// ── maintainKbOverview（P3a 高层导航）────────────────────────────────────────
	test('maintainKbOverview 输出类型聚合统计与主题概览', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		fs.addFile(URI.joinPath(root, '实体/前端/React.md'), '# React');
		fs.addFile(URI.joinPath(root, '实体/后端/Go.md'), '# Go');
		fs.addFile(URI.joinPath(root, '概念/缓存.md'), '# 缓存');

		await KbImportController.maintainKbOverview(fs as any, root);
		const ov = fs.contentOf(URI.joinPath(root, 'overview.md'))!;
		assert.ok(ov.includes('# 知识库总览'), '应有总览标题');
		assert.ok(ov.includes('共 **3** 篇笔记'), '应统计总笔记数=3');
		assert.ok(ov.includes('## 实体（2 篇）'), '实体类型应聚合为 2 篇');
		assert.ok(ov.includes('前端：1 篇') && ov.includes('后端：1 篇'), '应按主题聚合');
		assert.ok(ov.includes('[[index]]') && ov.includes('[[insights]]'), '应提供明细/洞察入口');
	});

	// ── maintainKbInsights（P3b Louvain 社区发现；输出契约：标题 + 统计行 + 社区章节）──
	test('maintainKbInsights 对互链图给出社区划分（两个独立连通分量）', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		fs.addFile(URI.joinPath(root, 'A.md'), 'A 链接 [[B]]');
		fs.addFile(URI.joinPath(root, 'B.md'), 'B 链接 [[A]]');
		fs.addFile(URI.joinPath(root, 'C.md'), 'C 链接 [[D]]');
		fs.addFile(URI.joinPath(root, 'D.md'), 'D 链接 [[C]]');

		await KbImportController.maintainKbInsights(fs as any, root);
		const ins = fs.contentOf(URI.joinPath(root, 'insights.md'))!;
		assert.ok(ins.includes('# 知识图谱洞察'), '应有洞察标题');
		assert.ok(ins.includes('4 篇笔记'), '4 篇互链笔记均入图');
		assert.ok(ins.includes('2 个社区'), '两个独立连通分量 → 2 个社区');
		assert.ok(ins.includes('## 社区'), '应渲染社区章节');
		assert.ok(ins.includes('[[A]]') && ins.includes('[[C]]'), '社区内应列出节点');
	});

	test('maintainKbInsights 连通图：统计行与社区章节齐全', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		// 两个稠密对 + E 连接 B 与 C（整图连通）
		fs.addFile(URI.joinPath(root, 'A.md'), 'A [[B]]');
		fs.addFile(URI.joinPath(root, 'B.md'), 'B [[A]] [[E]]');
		fs.addFile(URI.joinPath(root, 'C.md'), 'C [[D]] [[E]]');
		fs.addFile(URI.joinPath(root, 'D.md'), 'D [[C]]');
		fs.addFile(URI.joinPath(root, 'E.md'), 'E [[B]] [[C]]');

		await KbImportController.maintainKbInsights(fs as any, root);
		const ins = fs.contentOf(URI.joinPath(root, 'insights.md'))!;
		assert.ok(ins.includes('5 篇笔记'), '5 篇笔记均入图');
		assert.ok(ins.includes('条链接'), '统计行应包含链接数');
		assert.ok(ins.includes('个社区'), '统计行应包含社区数');
		assert.ok(ins.includes('## 社区'), '应渲染社区章节');
		assert.ok(ins.includes('[[E]]'), '节点 E 应出现在某个社区中');
	});

	test('maintainKbInsights 无互链时输出零链接统计', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		fs.addFile(URI.joinPath(root, '孤立.md'), '没有任何双链');
		await KbImportController.maintainKbInsights(fs as any, root);
		const ins = fs.contentOf(URI.joinPath(root, 'insights.md'))!;
		assert.ok(ins.includes('# 知识图谱洞察'), '应有洞察标题');
		assert.ok(ins.includes('1 篇笔记'), '孤立笔记计为 1 节点');
		assert.ok(ins.includes('0 条链接'), '无互链 → 0 条链接');
	});

	// ── cascadeDeleteLibraryNotes（两阶段工作流下为禁用 stub：不自动删除，手动删除由 KB 视图触发）──
	test('cascadeDeleteLibraryNotes 两阶段工作流下不再自动删除（stub 契约）', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		const n1 = URI.joinPath(root, '实体/n1.md');
		fs.addFile(n1, '---\nsources:\n  - "[[库/Lib1.md]]"\n---\n引用了 Lib1');

		const deleted = await KbImportController.cascadeDeleteLibraryNotes(fs as any, URI.file('/vault/库'), root);
		assert.deepStrictEqual(deleted, [], '两阶段工作流下级联删除已禁用，应返回空数组');
		assert.ok(fs.contentOf(n1), '笔记不应被删除');
	});

	// ── maintainKbNavigation 统一入口（P3 收口）─────────────────────────────────
	test('maintainKbNavigation 一次性生成 index/overview/insights', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		fs.addFile(URI.joinPath(root, '实体/x.md'), '# X 链接 [[y]]');
		fs.addFile(URI.joinPath(root, '概念/y.md'), '# Y 链接 [[x]]');

		await KbImportController.maintainKbNavigation(fs as any, root);
		assert.ok(fs.contentOf(URI.joinPath(root, 'index.md')), 'index.md 已生成');
		assert.ok(fs.contentOf(URI.joinPath(root, 'overview.md')), 'overview.md 已生成');
		assert.ok(fs.contentOf(URI.joinPath(root, 'insights.md')), 'insights.md 已生成');
	});

	// ── _validateAndFixNotePaths（两阶段工作流下为 no-op：笔记路径由构建阶段/Agent 自主决定）──
	test('_validateAndFixNotePaths 两阶段工作流下为 no-op（不再强制纠偏）', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		const targetDir = URI.joinPath(root, '概念/02_工作/GR');
		const sinceMs = Date.now() - 10000;

		// 模拟 agent 写到"错误"位置
		const wrongFile = URI.joinPath(root, '概念/wrong-place.md');
		fs.addFile(wrongFile, '# 错误位置的笔记');
		// 系统文件
		for (const sys of ['index.md', 'overview.md', 'insights.md', 'log.md']) {
			fs.addFile(URI.joinPath(root, sys), `# ${sys}`);
		}

		await (KbImportController as any)._validateAndFixNotePaths(fs as any, root, root, targetDir, sinceMs);

		// no-op 契约：任何文件都不应被移动/删除，targetDir 下也不应新建文件
		assert.ok(fs.contentOf(wrongFile), 'no-op：原文件不应被移动或删除');
		assert.ok(!fs.contentOf(URI.joinPath(targetDir, 'wrong-place.md')), 'no-op：不应在 targetDir 创建文件');
		for (const sys of ['index.md', 'overview.md', 'insights.md', 'log.md']) {
			assert.ok(fs.contentOf(URI.joinPath(root, sys)), `no-op：${sys} 不应受影响`);
		}
	});

	// ── _computeTargetCategory 分类路径计算（schema 驱动） ──────────────────
	/** 用最小 mock 构造 KbImportController（仅满足 _computeTargetCategory + _getSchema 依赖）。
	 *  - _configurationService = {} → isChatProviderConfigured 返回 false → 走 schema 关键词 fallback
	 *  - _agentStudioService = {} → createKbChatModel 不存在 → _classifyWithSchema 走 safeSchemaFallback（misc + 未分类）
	 */
	function makeCtrl(fs: MockFileService, _classifier?: any): any {
		return new (KbImportController as any)(
			{ getValue: (_key: string) => _key === 'sessions.agentStudio.provider.customProviders' ? [] : undefined }, /* _configurationService */
			{}, /* _logService */
			fs, /* _fileService */
			{ userHome: URI.file('/home/user') }, /* _envService */
			{ get: () => undefined }, /* _storageService — 提供 get 方法供 _resolveKbRootUri 使用 */
			{}, /* _chatService */
			_classifier ?? {}, /* _agentStudioService */
			{}, /* _skillRegistry */
			{}, /* _agentOSService */
			{}, /* _viewsService */
			{}, /* _editorService */
			{}, /* _notificationService */
		);
	}

	test('_computeTargetCategory 命中 schema 类型目录时复用路径', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		// 概念 类型目录下存在 GR 子目录（02_工作 是用户目录，不应被收集为候选）
		fs.addFile(URI.joinPath(root, '概念', 'GR', 'b.md'), '# b');
		fs.addFile(URI.joinPath(root, '概念', 'c.md'), '# c');
		fs.addFile(URI.joinPath(root, '实体', 'x.md'), '# x');

		const ctrl = makeCtrl(fs);
		const content = 'GC卡顿诊断报告 GR 自旋等待分析 机制 原理';
		const r = await ctrl._computeTargetCategory(content, URI.joinPath(root, '库'), root);
		// 命中概念类型下的 GR 子目录 → 复用
		assert.strictEqual(r.category, '概念/GR', '命中 schema 类型目录下的子目录应复用');
		assert.strictEqual(r.type, '概念', 'type 应为概念');
		assert.ok(r.classifyResult.typeId, '分类结果应有 typeId');
		ctrl.dispose?.();
	});

	test('_computeTargetCategory 用户自定义目录（如 01_学习/02_工作）不应被收集为候选', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		// 用户自定义目录 01_学习（非 schema 类型）存在 AI_Agent 子目录
		fs.addFile(URI.joinPath(root, '01_学习', 'AI_Agent', 'a.md'), '# a');
		fs.addFile(URI.joinPath(root, '01_学习', 'b.md'), '# b');

		const ctrl = makeCtrl(fs);
		// 内容包含 GR 关键词 + 概念关键词
		const content = 'GC卡顿诊断报告 机制 原理分析';
		const r = await ctrl._computeTargetCategory(content, URI.joinPath(root, '库'), root);
		// 关键断言：01_学习 不是 schema 类型，不应被复用
		assert.ok(!r.category.startsWith('01_学习'), '用户目录 01_学习 不应被复用为分类');
		// 测试环境无 LLM → 安全降级默认类型（不再用关键词猜 schema 类型）
		assert.strictEqual(r.category, '杂记/未分类', '无 LLM 时应安全降级为 杂记/未分类');
		ctrl.dispose?.();
	});

	test('_computeTargetCategory 无匹配时安全降级默认类型（LLM 不可用）', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		// 空 notesDir，无候选；测试环境无 LLM → 安全降级
		const ctrl = makeCtrl(fs);
		const content = 'GC垃圾回收机制原理分析\n详细内容...';
		const r = await ctrl._computeTargetCategory(content, URI.joinPath(root, '库'), root);
		assert.strictEqual(r.category, '杂记/未分类', '无 LLM 时应降级为 默认类型/未分类');
		assert.strictEqual(r.type, '杂记', 'type 应为 schema 默认类型 misc 的目录');
		assert.strictEqual(r.topic, '未分类', '无 LLM 时 topic 应为未分类（不再从内容行派生）');
		assert.ok(r.classifyResult.source === 'fallback', '无 LLM 时应为 fallback（非关键词猜测）');
		ctrl.dispose?.();
	});

	test('_computeTargetCategory 返回完整 classifyResult（安全降级路径）', async () => {
		const fs = new MockFileService();
		const root = notesRoot();
		const ctrl = makeCtrl(fs);
		const content = '如何优化React性能 - 最佳实践指南';
		const r = await ctrl._computeTargetCategory(content, URI.joinPath(root, '库'), root);
		// 测试环境无 LLM → 安全降级默认类型
		assert.strictEqual(r.classifyResult.typeId, 'misc', '无 LLM 时应降级为 misc');
		assert.strictEqual(r.classifyResult.typeLabel, '杂记');
		assert.strictEqual(r.classifyResult.typeDir, '杂记');
		assert.strictEqual(r.classifyResult.confidence, 0, '降级置信度应为 0');
		assert.ok(r.classifyResult.reasoning.length > 0, '应有分类理由');
		assert.strictEqual(r.classifyResult.source, 'fallback', '测试环境无 LLM → fallback');
		ctrl.dispose?.();
	});
});

// ─── _collectAgentNotesUnderTargetDir：后验落盘校验（必须递归，避免子目录笔记误报） ───────
suite('_collectAgentNotesUnderTargetDir — 后验落盘校验（递归）', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const targetDir = () => URI.file('/vault/notes/02_工作');

	test('笔记直接写在 targetDir 下 → 判定为已落盘', async () => {
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(targetDir(), 'GC卡顿诊断报告.md'), '# 内容');
		const notes = await KbImportController._collectAgentNotesUnderTargetDir(fs, targetDir());
		assert.strictEqual(notes.length, 1, '直接落盘的笔记应被识别');
	});

	test('回归：笔记写在 targetDir 子目录（如 02_工作/GR/）下 → 仍判定为已落盘（不误报 not found）', async () => {
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(targetDir(), 'GR', 'GC卡顿诊断报告.md'), '# 内容');
		const notes = await KbImportController._collectAgentNotesUnderTargetDir(fs, targetDir());
		assert.strictEqual(notes.length, 1, '递归扫描应找到子目录下的笔记；非递归判定会误报"not found"');
	});

	test('targetDir 仅含子目录、无 .md → 判定为未落盘（仍告警）', async () => {
		const fs = new MockFileService();
		fs.addDir(URI.joinPath(targetDir(), 'GR')); // 空目录
		const notes = await KbImportController._collectAgentNotesUnderTargetDir(fs, targetDir());
		assert.strictEqual(notes.length, 0, '无任何笔记时应判为未落盘');
	});

	test('排除导航聚合文件（index/overview/insights/log 不算落盘笔记）', async () => {
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(targetDir(), 'index.md'), '# 索引');
		fs.addFile(URI.joinPath(targetDir(), 'overview.md'), '# 总览');
		fs.addFile(URI.joinPath(targetDir(), 'GR', 'note.md'), '# 真实笔记');
		const notes = await KbImportController._collectAgentNotesUnderTargetDir(fs, targetDir());
		assert.strictEqual(notes.length, 1, '导航聚合文件不应被当作已落盘笔记');
	});
});

// ─── createKbImportHandler：聊天框「导入知识库」按钮去重（禁止重复导入） ───────────────
suite('createKbImportHandler — 导入知识库按钮去重（禁止重复导入）', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** 构造一个假 KbImport，统计真实导入次数与入参 */
	function makeFakeKbImport() {
		let importCount = 0;
		let lastContent = '';
		let lastAgentId: string | null = null;
		const fake = {
			async handleFavoriteMessage(content: string, agentId: string | null): Promise<boolean> {
				importCount++;
				lastContent = content;
				lastAgentId = agentId;
				return true;
			},
		};
		return {
			fake,
			get importCount() { return importCount; },
			get lastContent() { return lastContent; },
			get lastAgentId() { return lastAgentId; },
		};
	}

	test('首次导入成功 → 记录 messageId 并返回 true', async () => {
		const kb = makeFakeKbImport();
		const importedIds = new Set<string>();
		const handler = createKbImportHandler(kb.fake, () => 'agent-x', importedIds);

		const ok = await handler('hello world', 'msg-1');

		assert.strictEqual(ok, true, '首次导入应返回 true');
		assert.strictEqual(kb.importCount, 1, '应调用一次真实导入');
		assert.ok(importedIds.has('msg-1'), '应将 msg-1 记入已导入集合');
	});

	test('同一消息重复点击 → 仅导入一次（不重复落盘）', async () => {
		const kb = makeFakeKbImport();
		const importedIds = new Set<string>();
		const handler = createKbImportHandler(kb.fake, () => 'agent-x', importedIds);

		const r1 = await handler('hello world', 'msg-1');
		const r2 = await handler('hello world', 'msg-1');
		const r3 = await handler('hello world', 'msg-1');

		assert.strictEqual(r1, true);
		assert.strictEqual(r2, true, '重复点击也返回 true（视为已导入）');
		assert.strictEqual(r3, true);
		assert.strictEqual(kb.importCount, 1, '同一消息只应落盘一次');
		assert.ok(importedIds.has('msg-1'), '已导入集合应含 msg-1');
	});

	test('不同消息 → 各自独立导入，互不干扰', async () => {
		const kb = makeFakeKbImport();
		const importedIds = new Set<string>();
		const handler = createKbImportHandler(kb.fake, () => 'agent-x', importedIds);

		await handler('content A', 'msg-A');
		await handler('content B', 'msg-B');

		assert.strictEqual(kb.importCount, 2, '两条不同消息应各自导入一次');
		assert.ok(importedIds.has('msg-A') && importedIds.has('msg-B'), '两条消息都应记入集合');
	});

	test('真实导入失败 → 不记入已导入集合（允许重试）', async () => {
		let importCount = 0;
		const failingKb = {
			async handleFavoriteMessage(_c: string, _a: string | null): Promise<boolean> {
				importCount++;
				return false; // 模拟导入失败
			},
		};
		const importedIds = new Set<string>();
		const handler = createKbImportHandler(failingKb, () => 'agent-x', importedIds);

		const ok = await handler('content', 'msg-1');
		const ok2 = await handler('content', 'msg-1'); // 失败重试

		assert.strictEqual(ok, false);
		assert.strictEqual(ok2, false, '失败也应返回 false');
		assert.strictEqual(importCount, 2, '失败不记集合，应允许再次尝试导入');
		assert.ok(!importedIds.has('msg-1'), '失败的消息不应记入已导入集合');
	});

	test('动态获取当前 Agent —— 每次导入都使用最新 agentId', async () => {
		const kb = makeFakeKbImport();
		let current = 'agent-1';
		const importedIds = new Set<string>();
		const handler = createKbImportHandler(kb.fake, () => current, importedIds);

		await handler('c', 'm1');
		current = 'agent-2';
		await handler('c', 'm2');

		assert.strictEqual(kb.lastAgentId, 'agent-2', '第二次导入应拿到更新后的 agentId');
		assert.strictEqual(kb.importCount, 2, '两次不同消息应各导入一次');
	});

	test('kbImport 未就绪（undefined）→ 返回 false 且不记集合', async () => {
		const importedIds = new Set<string>();
		const handler = createKbImportHandler(undefined, () => 'agent-x', importedIds);

		const ok = await handler('content', 'msg-1');

		assert.strictEqual(ok, false, '未配置导入器应返回 false');
		assert.ok(!importedIds.has('msg-1'), '未成功导入不应记入集合');
	});

	test('空 messageId → 不写集合（仍尝试导入一次）', async () => {
		const kb = makeFakeKbImport();
		const importedIds = new Set<string>();
		const handler = createKbImportHandler(kb.fake, () => 'agent-x', importedIds);

		const ok = await handler('content', '');

		assert.strictEqual(ok, true);
		assert.strictEqual(kb.importCount, 1, '空 messageId 仍应触发一次导入');
		assert.strictEqual(importedIds.size, 0, '空 messageId 不应写入集合');
	});
});

// ─── Schema 驱动分类（safeSchemaFallback / buildSchemaPromptText） ─────────
suite('KBSchema — 安全降级与 schema 文本（safeSchemaFallback / buildSchemaPromptText）', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('safeSchemaFallback 始终落到 schema 默认类型（misc）+ 未分类', () => {
		const r = safeSchemaFallback(DEFAULT_KB_SCHEMA);
		assert.strictEqual(r.typeId, 'misc');
		assert.strictEqual(r.typeLabel, '杂记');
		assert.strictEqual(r.typeDir, '杂记');
		assert.strictEqual(r.topic, '未分类');
		assert.strictEqual(r.confidence, 0, '降级置信度应为 0');
		assert.strictEqual(r.source, 'fallback', 'source 应为 fallback（非关键词猜测）');
	});

	test('safeSchemaFallback 自定义 reason 透传', () => {
		const r = safeSchemaFallback(DEFAULT_KB_SCHEMA, 'LLM 超时');
		assert.strictEqual(r.reasoning, 'LLM 超时');
	});

	test('buildSchemaPromptText 生成完整的 schema 描述文本', () => {
		const text = buildSchemaPromptText(DEFAULT_KB_SCHEMA);
		assert.ok(text.includes('## Knowledge Base Schema'), '应包含标题');
		assert.ok(text.includes('| entity |'), '应包含 entity 类型');
		assert.ok(text.includes('| concept |'), '应包含 concept 类型');
		assert.ok(text.includes('| misc |'), '应包含 misc 兜底类型');
		assert.ok(text.includes('### Required Frontmatter'), '应包含 frontmatter 要求');
		assert.ok(text.includes('`type`'), '应提到 type 字段');
		assert.ok(text.includes('`title`'), '应提到 title 字段');
		assert.ok(text.includes('`created`'), '应提到 created 字段');
		assert.ok(text.includes('[[wikilinks]]'), '应提到 wikilinks');
	});

	test('findTypeById 正确查找类型定义', () => {
		const t = findTypeById(DEFAULT_KB_SCHEMA, 'concept');
		assert.ok(t, '应找到 concept 类型');
		assert.strictEqual(t!.label, '概念');
		assert.strictEqual(t!.dir, '概念');
	});

	test('findTypeById 无效 id 返回 undefined', () => {
		const t = findTypeById(DEFAULT_KB_SCHEMA, 'nonexistent');
		assert.strictEqual(t, undefined, '无效 id 应返回 undefined');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// GC HTML 真实文件导入：分类归档 + 结构抽离
// fixture：src/.../test/browser/fixtures/GC_Mechanism_Diagram.html
//         （源自 F:\GR_qiuzijian_main\S1Game\GC_Mechanism_Diagram.html，
//           UE5 GC 机制可视化页面，首行为 <!DOCTYPE html> —— 正是历史上
//           产生「库/概念/!DOCTYPE html」垃圾目录的输入形态）
// ═══════════════════════════════════════════════════════════════════════════
suite('AgentStudio - KbImportController GC HTML 导入（分类归档/结构抽离）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const vault = () => URI.file('/vault');
	const notesDirOf = () => URI.joinPath(vault(), '笔记');
	const GC_FIXTURE = nodePath.join(process.cwd(),
		'src/vs/sessions/contrib/agentStudio/test/browser/fixtures/GC_Mechanism_Diagram.html');
	const loadGcHtml = (): string => {
		assert.ok(nodeFs.existsSync(GC_FIXTURE), `fixture 缺失：${GC_FIXTURE}（需从仓库根目录运行测试）`);
		return nodeFs.readFileSync(GC_FIXTURE, 'utf8');
	};

	const logMock = { info() { }, warn() { }, error() { }, debug() { } };
	const notifyMock = { notify() { } };

	/** 构造可跑通 handleFavoriteMessage 全流程的控制器（对齐真实 9+1 参构造签名）。 */
	const makeFlowCtrl = (fs: MockFileService, studioSvc: any): any =>
		new (KbImportController as any)(
			{ getValue: () => undefined },              /* _configurationService */
			logMock,                                    /* _logService */
			fs,                                         /* _fileService */
			{ userHome: URI.file('/home/user') },       /* _envService */
			{ get: () => undefined },                   /* _storageService */
			{ requestKbRefresh: () => {}, ...studioSvc }, /* _agentStudioService */
			{ openView: async () => null },             /* _viewsService */
			{ openEditor: async () => null },           /* _editorService */
			notifyMock,                                 /* _notificationService */
			{},                                         /* _requestService */
		);

	/** 分类 LLM：schema 分类为 concept/UE5垃圾回收机制。 */
	const classifyLlm = {
		extract: async () => ({
			typeId: 'concept', typeLabel: '概念', topic: 'UE5垃圾回收机制',
			confidence: 0.93, reasoning: '内容为 UE5 GC 机制原理讲解',
		}),
		complete: async () => '',
	};

	// ── 分类归档 ────────────────────────────────────────────────────────────

	test('topic 源头封堵：HTML 首行清洗后为 undefined，绝不产生 !DOCTYPE 目录名', () => {
		const html = loadGcHtml();
		const firstLine = html.split('\n').find(l => l.trim().length > 3)!;
		assert.ok(firstLine.includes('DOCTYPE'), 'fixture 首个非平凡行应为 <!DOCTYPE html>');
		assert.strictEqual(sanitizeKbTopic(firstLine), undefined, 'DOCTYPE 行清洗后应为 undefined（不可作目录名）');
		// <title> 行清洗后是有效 topic（对照：语义文本应被保留）
		const titleLine = html.split('\n').find(l => l.includes('<title>'))!;
		const t = sanitizeKbTopic(titleLine);
		assert.ok(t && t.includes('UE5 GC'), `<title> 行清洗后应保留语义文本，实际：${t}`);
	});

	test('LLM 分类归档：库文件落入 概念/UE5垃圾回收机制，frontmatter 正确', async () => {
		const fs = new MockFileService();
		const html = loadGcHtml();
		const ctrl = makeFlowCtrl(fs, { createKbChatModel: () => classifyLlm });

		const ok = await ctrl.handleFavoriteMessage(html, null, vault());
		assert.strictEqual(ok, true, '导入应成功');

		const libFiles = fs.listFiles('/库/').filter(k => k.endsWith('.md'));
		assert.strictEqual(libFiles.length, 1, '库分区应恰好 1 个文件');
		const libPath = decodeURIComponent(libFiles[0]);
		assert.ok(libPath.includes('/库/概念/UE5垃圾回收机制/'), `应归档到 概念/UE5垃圾回收机制，实际：${libPath}`);
		assert.ok(!libPath.includes('DOCTYPE'), '路径不得包含 DOCTYPE 垃圾目录名');
		assert.ok(/\/库\/概念\/UE5垃圾回收机制\/UE5垃圾回收机制-\d{4}-\d{2}-\d{2}\.md$/.test(libPath),
			`文件名应为 <topic>-<日期>.md（语义可读），实际：${libPath}`);

		const content = (fs as any)._files.get(libFiles[0]) as string; // map key 为 percent-encoded 形式
		assert.ok(content.includes('type: 概念'), 'frontmatter 应含 type: 概念');
		assert.ok(content.includes('topic: UE5垃圾回收机制'), 'frontmatter 应含 topic: UE5垃圾回收机制');
		assert.ok(content.includes('<!DOCTYPE html>'), '正文应原样保留 HTML 内容');
		ctrl.dispose?.();
	});

	test('无 LLM 时安全降级：落入 杂记/未分类，同样不产生 DOCTYPE 目录', async () => {
		const fs = new MockFileService();
		const html = loadGcHtml();
		const ctrl = makeFlowCtrl(fs, {}); // 无 createKbChatModel → safeSchemaFallback

		const ok = await ctrl.handleFavoriteMessage(html, null, vault());
		assert.strictEqual(ok, true, '导入应成功');

		const libFiles = fs.listFiles('/库/').filter(k => k.endsWith('.md'));
		assert.strictEqual(libFiles.length, 1, '库分区应恰好 1 个文件');
		const libPath = decodeURIComponent(libFiles[0]);
		assert.ok(libPath.includes('/库/杂记/未分类/'), `无 LLM 时应安全降级到 杂记/未分类，实际：${libPath}`);
		assert.ok(/\/杂记\/未分类\/未分类-\d{4}-\d{2}-\d{2}\.md$/.test(libPath), `降级文件名应为 未分类-<日期>.md，实际：${libPath}`);
		assert.ok(!libPath.includes('DOCTYPE'), '不得产生 DOCTYPE 目录');
		ctrl.dispose?.();
	});

	test('消息导入文件名：同日同主题不同内容追加 -2 后缀，同内容不重复落盘', async () => {
		const fs = new MockFileService();
		const html = loadGcHtml();
		const ctrl = makeFlowCtrl(fs, { createKbChatModel: () => classifyLlm });

		// 第一条消息
		assert.strictEqual(await ctrl.handleFavoriteMessage(html, null, vault()), true);
		// 第二条：同主题但内容不同 → 追加 -2
		assert.strictEqual(await ctrl.handleFavoriteMessage(html + '\n<!-- v2 增补内容 -->', null, vault()), true);
		// 第三条：与第一条完全相同 → 去重命中，不产生新文件
		assert.strictEqual(await ctrl.handleFavoriteMessage(html, null, vault()), true);

		const libFiles = fs.listFiles('/库/').filter(k => k.endsWith('.md'));
		assert.strictEqual(libFiles.length, 2, '不同内容 2 条 + 同内容去重 1 条 → 恰好 2 个库文件');
		const names = libFiles.map(k => decodeURIComponent(k).split('/').pop()!);
		assert.ok(names.some(n => /UE5垃圾回收机制-\d{4}-\d{2}-\d{2}\.md$/.test(n)), `首个文件应为 <topic>-<date>.md，实际：${names.join(', ')}`);
		assert.ok(names.some(n => /UE5垃圾回收机制-\d{4}-\d{2}-\d{2}-2\.md$/.test(n)), `同名不同内容应为 -2 后缀，实际：${names.join(', ')}`);
		ctrl.dispose?.();
	});

	test('去重迁移：同内容重复导入，文件从旧错误目录迁到新分类目录', async () => {
		const fs = new MockFileService();
		const html = loadGcHtml();

		// 第一次：无 LLM → 杂记/未分类
		const ctrl1 = makeFlowCtrl(fs, {});
		assert.strictEqual(await ctrl1.handleFavoriteMessage(html, null, vault()), true);
		const before = fs.listFiles('/库/').filter(k => k.endsWith('.md'));
		assert.strictEqual(before.length, 1);
		assert.ok(decodeURIComponent(before[0]).includes('/库/杂记/未分类/'), `首次应降级到 杂记/未分类，实际：${decodeURIComponent(before[0])}`);

		// 第二次：有 LLM → 概念/UE5垃圾回收机制；同内容 hash 命中去重 → 迁移而非重复落盘
		const ctrl2 = makeFlowCtrl(fs, { createKbChatModel: () => classifyLlm });
		assert.strictEqual(await ctrl2.handleFavoriteMessage(html, null, vault()), true);
		const after = fs.listFiles('/库/').filter(k => k.endsWith('.md'));
		assert.strictEqual(after.length, 1, '去重：仍应只有 1 个库文件');
		assert.ok(decodeURIComponent(after[0]).includes('/库/概念/UE5垃圾回收机制/'), `应迁移到新分类目录，实际：${decodeURIComponent(after[0])}`);
		assert.ok(!fs.listFiles('/库/杂记/未分类/').some(k => k.endsWith('.md')), '旧目录不应残留文件');
		ctrl1.dispose?.();
		ctrl2.dispose?.();
	});

	// ── 结构抽离 ────────────────────────────────────────────────────────────

	test('结构抽离：stage2 FILE 块产出结构化笔记并回链库文件', async () => {
		const fs = new MockFileService();
		const html = loadGcHtml();

		// 先经 LLM 分类入库（得到带 frontmatter type/topic 的库文件）
		const ctrl = makeFlowCtrl(fs, { createKbChatModel: () => classifyLlm });
		assert.strictEqual(await ctrl.handleFavoriteMessage(html, null, vault()), true);
		const libPath = fs.listFiles('/库/').filter(k => k.endsWith('.md'))[0];
		const libPathDec = decodeURIComponent(libPath);
		const libRel = libPathDec.substring(libPathDec.indexOf('/库/') + 1); // '库/概念/UE5垃圾回收机制/<date>_<hash>.md'

		// 构建 LLM：stage1（系统提示含「架构师」）返回规划文本；stage2 返回 FILE 块
		// FILE 块路径相对于源文件所在目录（库/概念/UE5垃圾回收机制/）
		const fileBlock = [
			'---FILE: UE5垃圾回收机制.md ---',
			'---',
			'type: 概念',
			'title: UE5 垃圾回收机制',
			'created: 2026-07-28',
			'sources:',
			`  - ${libRel}`,
			'---',
			'',
			'# UE5 垃圾回收机制',
			'',
			'## 概述',
			'UE5 GC 采用分阶段管线：Marking / Reaching / Finalize / 增量压缩……',
			'---END FILE---',
		].join('\n');
		const buildLlm = {
			complete: async (system: string) => system.includes('架构师') ? '规划：产出一篇概念笔记' : fileBlock,
			extract: async () => { throw new Error('not used in build'); },
		};
		const studioSvc = { createKbChatModel: () => buildLlm, isKbChatProviderAvailable: () => true, requestKbRefresh: () => { } };

		const notePath = await KbImportController.buildNotesFromLibrary(
			URI.parse(libPath), vault(),
			{
				fileService: fs as any, configService: { getValue: () => undefined } as any,
				logService: logMock as any, notificationService: notifyMock as any,
				agentStudioService: studioSvc as any,
			},
		);
		assert.ok(notePath, '构建应成功（返回笔记路径）');

		// 笔记应写入源文件所在库目录（库/概念/UE5垃圾回收机制/UE5垃圾回收机制.md）
		const expectedNoteUri = URI.joinPath(vault(), '库', '概念', 'UE5垃圾回收机制', 'UE5垃圾回收机制.md');
		const note = fs.contentOf(expectedNoteUri);
		assert.ok(note, '笔记应写入 库/概念/UE5垃圾回收机制/UE5垃圾回收机制.md');
		assert.ok(note!.includes('# UE5 垃圾回收机制'), '笔记应含标题');
		assert.ok(note!.includes(`- ${libRel}`), '笔记 sources 应回链库文件');
		assert.ok(!expectedNoteUri.path.includes('DOCTYPE'), '笔记路径不得含 DOCTYPE');
		ctrl.dispose?.();
	});

	test('结构抽离兜底：stage2 输出无 FILE 块时，原始输出落为单篇分类笔记', async () => {
		const fs = new MockFileService();
		const html = loadGcHtml();

		// 直接放置带分类 frontmatter 的库文件（跳过入库阶段）
		const libUri = URI.joinPath(vault(), '库', '概念', 'UE5垃圾回收机制', '2026-07-28_test01.md');
		fs.addFile(libUri, [
			'---', 'type: 概念', 'topic: UE5垃圾回收机制', 'date: 2026-07-28',
			'source: test', 'hash: abc123', 'tags: []', '---', '', html,
		].join('\n'));

		// stage2 返回不合规文本（无 FILE 块，长度 ≥100 触发 salvage）
		const garbage = '这是一段没有按 FILE 块格式输出的模型回复，包含对 GC 机制的零散描述。'.repeat(4);
		const buildLlm = {
			complete: async (system: string) => system.includes('架构师') ? '规划' : garbage,
			extract: async () => { throw new Error('not used in build'); },
		};
		const studioSvc = { createKbChatModel: () => buildLlm, isKbChatProviderAvailable: () => true, requestKbRefresh: () => { } };

		const notePath = await KbImportController.buildNotesFromLibrary(
			libUri, vault(),
			{
				fileService: fs as any, configService: { getValue: () => undefined } as any,
				logService: logMock as any, notificationService: notifyMock as any,
				agentStudioService: studioSvc as any,
			},
		);
		assert.ok(notePath, '兜底应产出笔记而非失败（返回笔记路径）');

		// 兜底笔记落在源文件所在库目录
		const expectedNoteUri = URI.joinPath(vault(), '库', '概念', 'UE5垃圾回收机制', 'UE5垃圾回收机制.md');
		const note = fs.contentOf(expectedNoteUri);
		assert.ok(note, '兜底笔记应落在 库/概念/UE5垃圾回收机制/UE5垃圾回收机制.md（分类取库文件 frontmatter）');
		assert.ok(note!.includes('title: UE5垃圾回收机制'), '兜底笔记 frontmatter 应含库分类 topic');
		assert.ok(note!.includes('没有按 FILE 块格式输出'), '兜底笔记正文应保留模型原始输出');
	});

	// ── 文件导入：原始文件保留文件名入库 ────────────────────────────────────

	test('文件导入：原始文件原样复制入库并保留文件名（不包 frontmatter），抽取兜底按目录路径推导分类', async () => {
		const fs = new MockFileService();
		const html = loadGcHtml();
		const srcUri = URI.file('/src/GC_Mechanism_Diagram.html');
		fs.addFile(srcUri, html);

		// 入口：文件导入（LLM 分类为 concept/UE5垃圾回收机制）→ 原始文件副本入库
		const ctrl = makeFlowCtrl(fs, { createKbChatModel: () => classifyLlm });
		assert.strictEqual(await ctrl.handleFavoriteMessage(html, null, vault(), srcUri), true, '文件导入应成功');

		const libFiles = fs.listFiles('/库/').filter(k => k.endsWith('.html'));
		assert.strictEqual(libFiles.length, 1, '库分区应恰好 1 个 .html 文件（原始文件副本）');
		const libPath = decodeURIComponent(libFiles[0]);
		assert.ok(libPath.includes('/库/概念/UE5垃圾回收机制/GC_Mechanism_Diagram.html'),
			`应保留原始文件名并归入分类目录，实际：${libPath}`);
		assert.ok(!libPath.includes('DOCTYPE'), '路径不得包含 DOCTYPE 垃圾目录');
		// 原样复制：内容与原始文件完全一致，且无 frontmatter 包裹
		const libContent = (fs as any)._files.get(libFiles[0]) as string;
		assert.strictEqual(libContent, html, '库文件应与原始文件内容完全一致（原样复制）');
		assert.ok(!libContent.startsWith('---'), '文件导入的库文件不应包 frontmatter');

		// 抽取：stage2 无 FILE 块 → 兜底笔记的分类按「库/<typeDir>/<topic>/<file>」目录路径推导
		const garbage = '这是一段没有按 FILE 块格式输出的模型回复，包含对 GC 机制的零散描述。'.repeat(4);
		const buildLlm = {
			complete: async (system: string) => system.includes('架构师') ? '规划' : garbage,
			extract: async () => { throw new Error('not used in build'); },
		};
		const studioSvc = { createKbChatModel: () => buildLlm, isKbChatProviderAvailable: () => true, requestKbRefresh: () => { } };
		const notePath = await KbImportController.buildNotesFromLibrary(
			URI.parse(libFiles[0]), vault(),
			{
				fileService: fs as any, configService: { getValue: () => undefined } as any,
				logService: logMock as any, notificationService: notifyMock as any,
				agentStudioService: studioSvc as any,
			},
		);
		assert.ok(notePath, '兜底应产出笔记而非失败');

		// 兜底笔记落在源文件所在库目录（分类按库目录路径推导 typeDir=topic）
		const expectedNoteUri = URI.joinPath(vault(), '库', '概念', 'UE5垃圾回收机制', 'UE5垃圾回收机制.md');
		const note = fs.contentOf(expectedNoteUri);
		assert.ok(note, '兜底笔记应落在 库/概念/UE5垃圾回收机制/UE5垃圾回收机制.md（分类按库目录路径推导）');
		assert.ok(note!.includes('title: UE5垃圾回收机制'), '兜底笔记 frontmatter 应含路径推导出的 topic');
		ctrl.dispose?.();
	});
});

// ── P0-1 去抽象化门控（applyDeabstractionGating）────────────────────────────
suite('AgentStudio - KbImportController P0-1 去抽象化门控', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const lib = () => URI.file('/vault/库');

	const conceptNote = (type: string, title: string, sources: string[]): string =>
		['---', `type: ${type}`, `title: ${title}`, 'created: 2026-07-28',
			`sources: [${sources.map(s => `"${s}"`).join(', ')}]`, '---', '', `# ${title}`, '', '正文'].join('\n');

	test('单一概念仅 1 个来源 → status: pending', async () => {
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(lib(), '概念', 'GC', 'GC.md'), conceptNote('concept', 'GC 机制', ['库/LibA.md']));
		const r = await KbImportController.applyDeabstractionGating(fs, lib());
		assert.strictEqual(r.pending, 1);
		assert.strictEqual(r.active, 0);
		const note = fs.contentOf(URI.joinPath(lib(), '概念', 'GC', 'GC.md'))!;
		assert.ok(note.includes('status: pending'), '单来源概念应标记为 pending');
	});

	test('同名概念被 ≥2 个不同来源确认 → status: active（跨文件）', async () => {
		const fs = new MockFileService();
		// 两次导入产生同名概念的两个文件，各自引用不同库文件（标题含/不含空格均归一匹配）
		fs.addFile(URI.joinPath(lib(), '概念', 'GC', 'GC-a.md'), conceptNote('concept', 'GC 机制', ['库/LibA.md']));
		fs.addFile(URI.joinPath(lib(), '概念', 'GC', 'GC-b.md'), conceptNote('concept', 'GC机制', ['库/LibB.md']));
		const r = await KbImportController.applyDeabstractionGating(fs, lib());
		assert.strictEqual(r.active, 2);
		assert.strictEqual(r.pending, 0);
		const a = fs.contentOf(URI.joinPath(lib(), '概念', 'GC', 'GC-a.md'))!;
		const b = fs.contentOf(URI.joinPath(lib(), '概念', 'GC', 'GC-b.md'))!;
		assert.ok(a.includes('status: active'), '跨文件同名确认应 active');
		assert.ok(b.includes('status: active'), '跨文件同名确认应 active');
	});

	test('来源类（source/query）不受门控影响（不写 status）', async () => {
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(lib(), '概念', 'GC', 'GC.md'), conceptNote('source', 'LibA', []));
		const r = await KbImportController.applyDeabstractionGating(fs, lib());
		assert.strictEqual(r.active, 0);
		assert.strictEqual(r.pending, 0);
		const note = fs.contentOf(URI.joinPath(lib(), '概念', 'GC', 'GC.md'))!;
		assert.ok(!note.includes('status:'), 'source 类不应写 status');
	});

	test('P1 同义归一：不同表述（GC机制 / 垃圾回收）经 aliases 归一并共享来源 → active', async () => {
		const fs = new MockFileService();
		// 在 kbDir（库/ 的父目录）放 aliases.json：canonical「垃圾回收」含同义词「GC机制」
		fs.addFile(URI.joinPath(URI.file('/vault'), 'aliases.json'),
			JSON.stringify({ aliases: { '垃圾回收': ['GC机制', 'GC', 'GarbageCollection'] } }));
		fs.addFile(URI.joinPath(lib(), '概念', 'GC', 'a.md'), conceptNote('concept', 'GC 机制', ['库/LibA.md']));
		fs.addFile(URI.joinPath(lib(), '概念', 'GC', 'b.md'), conceptNote('concept', '垃圾回收', ['库/LibB.md']));
		const r = await KbImportController.applyDeabstractionGating(fs, lib());
		assert.strictEqual(r.active, 2, '同义归一后两文件应视为同一概念且来源≥2 → active');
		assert.strictEqual(r.pending, 0);
		const a = fs.contentOf(URI.joinPath(lib(), '概念', 'GC', 'a.md'))!;
		const b = fs.contentOf(URI.joinPath(lib(), '概念', 'GC', 'b.md'))!;
		assert.ok(a.includes('status: active') && b.includes('status: active'), '同义两篇均应 active');
	});

	test('P1 同义归一：缺 aliases.json 时安全降级（各按自身标题归并，互不同源）', async () => {
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(lib(), '概念', 'GC', 'a.md'), conceptNote('concept', 'GC 机制', ['库/LibA.md']));
		fs.addFile(URI.joinPath(lib(), '概念', 'GC', 'b.md'), conceptNote('concept', '垃圾回收', ['库/LibB.md']));
		const r = await KbImportController.applyDeabstractionGating(fs, lib());
		assert.strictEqual(r.pending, 2, '无 aliases 时两标题不归一 → 各仅 1 来源 → pending');
		assert.strictEqual(r.active, 0);
	});
});

suite('AgentStudio - _matchCategory 统一分词 + 模糊匹配修复', () => {

	/** 通过最小 mock 实例调用实例方法 _matchCategory */
	function match(query: string, cands: string[], aliasMap?: Record<string, string[]>): string | null {
		const ctrl = new (KbImportController as any)(
			{ getValue: (_k: string) => undefined }, {}, new MockFileService(),
			{ userHome: URI.file('/home/user') }, { get: () => undefined },
			{}, {}, {}, {}, {}, {},
		);
		return ctrl._matchCategory(query, cands, aliasMap);
	}

	test('连字符 topic 不再因分词不对称而漏匹配（根因修复）', () => {
		// 此前 query "UE5-GC机制" 按 [\\s/]+ 分割→{"ue5-gc机制"} 整体 token，
		// candidate "概念/UE5 GC机制分析" 按 [\\/\\-_] 分割→["ue5","gc","机制","分析"]，
		// 交集为空 → 不命中。修复后统一 DELIM 分割。
		const r = match('UE5-GC机制', ['概念/UE5 GC机制分析']);
		assert.ok(r, '连字符 topic 应能命中含空格的既有目录');
		assert.strictEqual(r, '概念/UE5 GC机制分析');
	});

	test('子串包含评分使部分关键词也能命中', () => {
		const r = match('GC 机制', ['概念/UE5 GC机制分析']);
		assert.ok(r, '"GC 机制" 应通过子串包含命中 "UE5 GC机制分析"');
	});

	test('阈值门控：弱匹配返回 null（避免误归到无关目录）', () => {
		const r = match('网络协议', ['概念/UE5 GC机制分析', '实体/内存管理']);
		assert.strictEqual(r, null, '完全无关的 query 不应命中任何候选');
	});

	test('同义归一加分使别名表述命中同一目录', () => {
		const aliasMap = { '垃圾回收': ['GC机制', 'GC'] };
		const r = match('GC 机制', ['概念/垃圾回收'], aliasMap);
		assert.ok(r, '同义归一后 "GC 机制" 应命中 "垃圾回收" 目录');
		assert.strictEqual(r, '概念/垃圾回收');
	});

	test('多候选选最高分', () => {
		const r = match('UE5 GC机制', [
			'概念/UE5 GC机制分析',
			'概念/内存管理',
			'实体/GC 优化',
		]);
		assert.strictEqual(r, '概念/UE5 GC机制分析', '应选 token 重叠最多的候选');
	});
});

suite('AgentStudio - _writeFileBlocks 方案A 平铺落盘', () => {

	const logMock = { warn: () => { } } as any;
	const TYPE_DIRS = new Set(['概念', '方法', '综合', '实体', '杂记', '来源', '查询']);
	// 平台无关：fsPath 在 Windows 用反斜杠，统一归一为正斜杠再断言
	const norm = (p: string) => decodeURIComponent(p).replace(/\\/g, '/');

	function call(blocks: { path: string; content: string }[], fs: MockFileService, typeDirs?: ReadonlySet<string>): Promise<string[]> {
		return (KbImportController as any)._writeFileBlocks(
			blocks, URI.file('/vault/库/概念/UE5 GC 机制'), URI.file('/vault'), fs, logMock, typeDirs,
		);
	}

	test('剥掉类型目录前缀 → 平铺进主题目录', async () => {
		const fs = new MockFileService();
		const written = await call([
			{ path: '概念/UE5 GC 机制.md', content: '概念笔记' },
			{ path: '方法/UE5 GC 调优.md', content: '方法笔记' },
		], fs, TYPE_DIRS);
		const names = written.map(p => norm(p).split('/').pop()!);
		assert.ok(names.includes('UE5 GC 机制.md'), '概念笔记应平铺');
		assert.ok(names.includes('UE5 GC 调优.md'), '方法笔记应平铺');
		// 主题目录内不应再有类型子目录（文件应直接落在 base 下，无额外 /）
		const base = '/vault/库/概念/UE5 GC 机制/';
		for (const p of written) {
			const dec = norm(p);
			assert.ok(dec.startsWith(base), '应在主题目录内：' + dec);
			assert.ok(!dec.slice(base.length).includes('/'), '主题目录内不应再有类型子目录：' + dec);
		}
	});

	test('平铺后同名冲突 → 自动改名 _2，避免互相覆盖', async () => {
		const fs = new MockFileService();
		const written = await call([
			{ path: '概念/UE5 GC 机制.md', content: '概念版' },
			{ path: '方法/UE5 GC 机制.md', content: '方法版（平铺后与概念同名）' },
		], fs, TYPE_DIRS);
		const names = written.map(p => norm(p).split('/').pop()!);
		assert.ok(names.includes('UE5 GC 机制.md'), '第一篇保留原名');
		assert.ok(names.includes('UE5 GC 机制_2.md'), '同名第二篇应自动改名');
		// 两篇内容都应保留（未被覆盖）
		const dir = '/vault/库/概念/UE5 GC 机制';
		assert.ok(fs.contentOf(URI.file(dir + '/UE5 GC 机制.md'))?.includes('概念版'));
		assert.ok(fs.contentOf(URI.file(dir + '/UE5 GC 机制_2.md'))?.includes('方法版'));
	});

	test('无类型前缀的路径原样落盘（不剥首段）', async () => {
		const fs = new MockFileService();
		const written = await call([
			{ path: '子主题/UE5 GC 机制.md', content: '子主题笔记' },
		], fs, TYPE_DIRS);
		assert.strictEqual(written.length, 1);
		assert.ok(norm(written[0]).includes('/子主题/UE5 GC 机制.md'), '非类型目录的子目录应保留：' + norm(written[0]));
	});

	test('不传 typeDirs 时按原样落盘（向后兼容）', async () => {
		const fs = new MockFileService();
		const written = await call([
			{ path: '概念/UE5 GC 机制.md', content: 'x' },
		], fs, undefined);
		assert.ok(norm(written[0]).includes('/概念/UE5 GC 机制.md'), '无 typeDirs 时不剥前缀：' + norm(written[0]));
	});
});
