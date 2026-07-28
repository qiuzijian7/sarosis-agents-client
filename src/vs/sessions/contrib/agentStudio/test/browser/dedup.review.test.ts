/*---------------------------------------------------------------------------------------------
 *  dedup + reviewStore 单元测试（P3-1 / P2-1）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { detectDuplicates, formatDedupReport } from '../../browser/knowledge/dedup.js';
import { writeReviewNote, listReviewNotes, approveReviewNote, routeLintToReview } from '../../browser/knowledge/reviewStore.js';
import type { KbLintIssue } from '../../browser/knowledge/kbLint.js';

interface IMockStat { resource: URI; name: string; isDirectory: boolean; mtime: number; size: number; children?: IMockStat[]; }
class MockFileService {
	private _files = new Map<string, string>();
	private _dirs = new Set<string>();
	addFile(uri: URI, content: string): void {
		this._files.set(uri.toString(), content);
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
	private _regAncestors(uri: URI): void {
		const parts = uri.path.split('/').filter(Boolean);
		for (let i = 1; i < parts.length; i++) { this._dirs.add(URI.from({ scheme: uri.scheme, path: '/' + parts.slice(0, i).join('/') }).toString()); }
	}
	contentOf(uri: URI): string | undefined { return this._files.get(uri.toString()); }
}

suite('AgentStudio - dedup 去重检测', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const root = () => URI.file('/vault/notes');

	test('检测内容指纹重复', async () => {
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(root(), 'A/a.md'), '---\ntitle: A\n---\n相同内容正文');
		fs.addFile(URI.joinPath(root(), 'B/b.md'), '---\ntitle: B\n---\n相同内容正文');
		const groups = await detectDuplicates(fs as any, root());
		assert.ok(groups.some(g => g.reason === 'content-fingerprint' && g.notes.length === 2), '应检出内容重复');
	});

	test('检测标题碰撞', async () => {
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(root(), 'A/a.md'), '---\ntitle: 同名\n---\n内容一');
		fs.addFile(URI.joinPath(root(), 'B/b.md'), '---\ntitle: 同名\n---\n内容二');
		const groups = await detectDuplicates(fs as any, root());
		assert.ok(groups.some(g => g.reason === 'title-collision'), '应检出标题碰撞');
	});

	test('无重复时返回空', async () => {
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(root(), 'A.md'), '---\ntitle: A\n---\n内容一');
		fs.addFile(URI.joinPath(root(), 'B.md'), '---\ntitle: B\n---\n内容二');
		const groups = await detectDuplicates(fs as any, root());
		assert.strictEqual(groups.length, 0);
	});

	test('formatDedupReport 生成报告', () => {
		const r = formatDedupReport(URI.file('/v/n'), [{ key: '标题碰撞: x', notes: [URI.file('/v/n/a.md')], reason: 'title-collision' }]);
		assert.ok(r.includes('# 知识库去重报告'));
		assert.ok(r.includes('标题碰撞: x'));
	});
});

suite('AgentStudio - reviewStore 审核队列', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const vault = () => URI.file('/vault');

	test('write → list → approve 流程', async () => {
		const fs = new MockFileService();
		await writeReviewNote(fs as any, vault(), 'r1.md', '待审核内容');
		const list = await listReviewNotes(fs as any, vault());
		assert.strictEqual(list.length, 1);
		assert.ok(list[0].path.endsWith('r1.md'));

		const dest = URI.file('/vault/笔记/实体');
		const approved = await approveReviewNote(fs as any, vault(), 'r1.md', dest);
		assert.ok(approved.path.includes('实体/r1.md'), '应移动到目标目录');
		assert.ok(fs.contentOf(approved)?.includes('待审核内容'), '目标文件内容正确');
		const after = await listReviewNotes(fs as any, vault());
		assert.strictEqual(after.length, 0, '审核原文件应被删除');
	});
});

suite('AgentStudio - routeLintToReview 人环（P1）', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('warning 级笔记隔离进 .review/，info 级跳过（不隔离）', async () => {
		const fs = new MockFileService();
		const warnNote = URI.file('/vault/库/实体/GC.md');
		const infoNote = URI.file('/vault/库/实体/ok.md');
		fs.addFile(warnNote, '---\ntitle: GC\n---\n正文 [[库/不存在/x]]\n');
		fs.addFile(infoNote, '---\ntitle: ok\n---\n正文\n');
		const issues: KbLintIssue[] = [
			{ note: warnNote, severity: 'warning', rule: 'broken-link', message: '断链 [[库/不存在/x]]' },
			{ note: infoNote, severity: 'info', rule: 'no-sources', message: '缺少 sources' },
		];
		const res = await routeLintToReview(fs as any, URI.file('/vault'), issues, 'warning');
		assert.strictEqual(res.routed.length, 1, '应仅隔离 warning 级笔记');
		assert.strictEqual(res.skipped, 1, 'info 级跳过');
		const list = await listReviewNotes(fs as any, URI.file('/vault'));
		assert.strictEqual(list.length, 1);
		const content = fs.contentOf(list[0])!;
		assert.ok(content.includes('review_reason'), '审核笔记应含 review_reason 注释');
		assert.ok(content.includes('断链'), '应保留原始质量问题说明');
		assert.ok(!fs.contentOf(warnNote), '原库内笔记应被删除（隔离）');
	});

	test('已隔离（路径含 /.review/）的笔记不再重复处理（幂等）', async () => {
		const fs = new MockFileService();
		const note = URI.file('/vault/库/实体/GC.md');
		fs.addFile(note, '---\ntitle: GC\n---\n正文 [[库/不存在/x]]\n');
		const issues: KbLintIssue[] = [{ note, severity: 'warning', rule: 'broken-link', message: '断链' }];
		await routeLintToReview(fs as any, URI.file('/vault'), issues, 'warning');
		const quarantined = URI.file('/vault/.review/GC.md');
		const issues2: KbLintIssue[] = [{ note: quarantined, severity: 'warning', rule: 'broken-link', message: '断链' }];
		const res2 = await routeLintToReview(fs as any, URI.file('/vault'), issues2, 'warning');
		assert.strictEqual(res2.routed.length, 0, '已隔离笔记不应再次移动');
		assert.strictEqual(res2.skipped, 1);
		const list = await listReviewNotes(fs as any, URI.file('/vault'));
		assert.strictEqual(list.length, 1, '审核队列应仍只有 1 篇');
	});
});
