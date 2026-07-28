/*---------------------------------------------------------------------------------------------
 *  KB 功能调用入口集成测试（llm_wiki 新功能）。
 *  复现 KB 视图各入口的完整调用序列，验证端到端产出：
 *  体检入口（lint→报告→lint-report.md→log）、整理去重入口（detect→报告→合并引用重写）、
 *  审核队列闭环（移入→列表→移回）、移入审核入口（删原笔记+重建索引）。
 *
 *  运行（从仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/kbEntryFlows.test.ts
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { KbImportController } from '../../browser/kbImportController.js';
import { lintVault, formatLintReport } from '../../browser/knowledge/kbLint.js';
import { detectDuplicates, formatDedupReport, mergeDuplicates } from '../../browser/knowledge/dedup.js';
import { writeReviewNote, listReviewNotes, approveReviewNote } from '../../browser/knowledge/reviewStore.js';

interface IMockStat { resource: URI; name: string; isDirectory: boolean; mtime: number; size: number; children?: IMockStat[]; }
class MockFileService {
	private _files = new Map<string, string>();
	private _dirs = new Set<string>();
	addFile(uri: URI, content: string): void {
		this._files.set(uri.toString(), content);
		this._regAncestors(uri);
	}
	private _regAncestors(uri: URI): void {
		const parts = uri.path.split('/').filter(Boolean);
		for (let i = 1; i < parts.length; i++) { this._dirs.add(URI.from({ scheme: uri.scheme, path: '/' + parts.slice(0, i).join('/') }).toString()); }
	}
	private _statOf(uri: URI): IMockStat {
		const key = uri.toString();
		if (this._files.has(key)) { return { resource: uri, name: uri.path.split('/').pop()!, isDirectory: false, mtime: 1, size: 1 }; }
		return { resource: uri, name: uri.path.split('/').pop()!, isDirectory: true, mtime: 1, size: 0, children: this._childrenOf(uri) };
	}
	private _childrenOf(dir: URI): IMockStat[] {
		const dirKey = dir.toString();
		const dirPath = dir.path;
		const seen = new Set<string>();
		const out: IMockStat[] = [];
		const consider = (key: string): void => {
			if (key === dirKey) { return; }
			const childUri = URI.parse(key);
			if (childUri.path.substring(0, childUri.path.lastIndexOf('/')) === dirPath) {
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
		if (c === undefined) { throw new Error('ENOENT'); }
		return { value: VSBuffer.fromString(c) };
	}
	async writeFile(uri: URI, content: VSBuffer): Promise<void> {
		this._files.set(uri.toString(), content.toString());
		this._regAncestors(uri);
	}
	async del(uri: URI): Promise<void> { this._files.delete(uri.toString()); }
	async createFolder(uri: URI): Promise<void> { this._regAncestors(uri); this._dirs.add(uri.toString()); }
	contentOf(uri: URI): string | undefined { return this._files.get(uri.toString()); }
}

suite('AgentStudio - KB 功能调用入口集成流程', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const root = () => URI.file('/vault/notes');
	const vault = () => URI.file('/vault');

	test('体检入口流程：lint → 报告 → lint-report.md → log 记录', async () => {
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(root(), 'A.md'), '纯正文 [[不存在的笔记]]'); // 断链 + 缺 frontmatter
		fs.addFile(URI.joinPath(root(), 'B.md'), '---\nsources:\n  - "[[库/x.md]]"\n---\nB 正文 [[A]]');

		// 模拟 _runLint 入口：lintVault → formatLintReport → writeFile → appendKbLog
		const issues = await lintVault(fs as any, root());
		const report = formatLintReport(root(), issues);
		await fs.writeFile(URI.joinPath(root(), 'lint-report.md'), VSBuffer.fromString(report));
		await KbImportController.appendKbLog(fs as any, root(), `体检：${issues.length} 项问题`);

		assert.ok(issues.some(i => i.rule === 'broken-link'), '应检出断链');
		assert.ok(issues.some(i => i.rule === 'no-frontmatter'), '应检出缺 frontmatter');
		const reportFile = fs.contentOf(URI.joinPath(root(), 'lint-report.md'))!;
		assert.ok(reportFile.includes('断链'), '报告应含断链');
		assert.ok(reportFile.includes('# 知识库体检报告'), '报告标题正确');
		const log = fs.contentOf(URI.joinPath(root(), 'log.md'))!;
		assert.ok(log.includes('体检'), 'log 应记录体检操作');
	});

	test('整理去重入口流程：detect → 报告 → 合并引用重写', async () => {
		const fs = new MockFileService();
		const A = URI.joinPath(root(), 'A.md');
		const Ap = URI.joinPath(root(), 'Aprime.md');
		const B = URI.joinPath(root(), 'B.md');
		fs.addFile(A, '---\ntitle: 重复\n---\n相同内容正文');
		fs.addFile(Ap, '---\ntitle: 重复\n---\n相同内容正文');
		fs.addFile(B, '---\ntitle: B\n---\nB 引用 [[Aprime]]');

		// detect
		const groups = await detectDuplicates(fs as any, root());
		assert.ok(groups.length >= 1, '应检出重复组');
		// 报告
		const report = formatDedupReport(root(), groups);
		assert.ok(report.includes('# 知识库去重报告'), '报告标题正确');
		// 合并（模拟用户确认 keep=A）：mergeDuplicates 删除其余 + 重写引用
		const g = groups.find(gr => gr.notes.length >= 2)!;
		const keep = g.notes.find(n => n.path.endsWith('/A.md'))!;
		const r = await mergeDuplicates(fs as any, root(), g, keep);
		assert.ok(r.deleted.length >= 1, '应删除非 keep 笔记');
		assert.ok(!fs.contentOf(Ap), 'Aprime 应被删除');
		const bContent = fs.contentOf(B)!;
		assert.ok(!bContent.includes('[[Aprime]]'), '[[Aprime]] 引用应被重写');
		assert.ok(bContent.includes('[[A]]'), '[[Aprime]] 应重写为 [[A]]');
	});

	test('审核队列完整闭环：移入 → 列表 → 移回', async () => {
		const fs = new MockFileService();
		const noteUri = URI.joinPath(root(), '低质量.md');
		fs.addFile(noteUri, '低质量笔记内容');

		// 移入审核（模拟 _moveToReview）：readFile → writeReviewNote → del
		const content = fs.contentOf(noteUri)!;
		await writeReviewNote(fs as any, vault(), '低质量.md', content);
		await fs.del(noteUri);
		assert.ok(!fs.contentOf(noteUri), '原笔记应被删除');
		// 列表（模拟 _showReviewQueue）
		const list = await listReviewNotes(fs as any, vault());
		assert.strictEqual(list.length, 1, '审核队列应有 1 篇');
		// 移回（模拟 _approveReview）：approveReviewNote 移回笔记根
		await approveReviewNote(fs as any, vault(), '低质量.md', root());
		assert.ok(fs.contentOf(URI.joinPath(root(), '低质量.md'))?.includes('低质量笔记内容'), '笔记应移回');
		const after = await listReviewNotes(fs as any, vault());
		assert.strictEqual(after.length, 0, '移回后审核队列应为空');
	});

	test('移入审核入口流程：删原笔记 + maintainKbNavigation 重建索引移除它', async () => {
		const fs = new MockFileService();
		const noteUri = URI.joinPath(root(), '实体/笔记A.md');
		fs.addFile(noteUri, '---\ntitle: 笔记A\n---\nA 内容');

		// 初始 maintain：index 应含笔记A
		await KbImportController.maintainKbNavigation(fs as any, root());
		assert.ok(fs.contentOf(URI.joinPath(root(), 'index.md'))?.includes('笔记A'), '初始 index 应含笔记A');

		// 移入审核后重建：index 应不再含笔记A
		await writeReviewNote(fs as any, vault(), '笔记A.md', fs.contentOf(noteUri)!);
		await fs.del(noteUri);
		await KbImportController.maintainKbNavigation(fs as any, root());
		assert.ok(!fs.contentOf(URI.joinPath(root(), 'index.md'))?.includes('笔记A'), '被移入审核的笔记应从 index 移除');
		assert.ok(fs.contentOf(URI.joinPath(vault(), '.review/笔记A.md'))?.includes('A 内容'), '审核目录应含该笔记');
	});
});
