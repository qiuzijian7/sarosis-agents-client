/*---------------------------------------------------------------------------------------------
 *  kbLint 单元测试（P3-2）。复用 kbImportController.test.ts 的 MockFileService 模式。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { lintVault, formatLintReport } from '../../browser/knowledge/kbLint.js';

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
}

suite('AgentStudio - kbLint 结构校验', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const root = () => URI.file('/vault/notes');

	test('检测断链', async () => {
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(root(), 'A.md'), '---\nsources:\n  - "[[库/x.md]]"\n---\n链接 [[不存在的笔记]]');
		const issues = await lintVault(fs as any, root());
		assert.ok(issues.some(i => i.rule === 'broken-link' && i.message.includes('不存在的笔记')), '应检出断链');
	});

	test('无 frontmatter 的 md 视为库源文件：不参与规则，但可作为链接目标', async () => {
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(root(), 'A.md'), '纯正文无 frontmatter（库源文件）');
		fs.addFile(URI.joinPath(root(), 'B.md'), '---\nsources:\n  - "[[库/x.md]]"\n---\nB 正文 [[A]]');
		const issues = await lintVault(fs as any, root());
		assert.ok(!issues.some(i => i.rule === 'no-frontmatter'), '库源文件不应报缺 frontmatter');
		assert.ok(!issues.some(i => i.rule === 'broken-link'), '指向库源文件的双链不应报断链');
		assert.ok(!issues.some(i => i.rule === 'orphan' && i.note.path.endsWith('A.md')), '库源文件不参与孤立检测');
	});

	test('带路径的双链目标解析到库文件（含非 md）不报断链', async () => {
		const libRoot = URI.file('/vault/库');
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(libRoot, '概念/主题/page.html'), '<html>源文件</html>');
		fs.addFile(URI.joinPath(libRoot, '概念/主题/note.md'), '---\nstatus: active\nsources:\n  - "[[库/概念/主题/page.html]]"\n---\n溯源 [[库/概念/主题/page.html|原文]]，断链 [[库/不存在/y.html]]');
		const issues = await lintVault(fs as any, libRoot);
		assert.ok(!issues.some(i => i.rule === 'broken-link' && i.message.includes('page.html')), '存在的库文件路径不应报断链');
		assert.ok(issues.some(i => i.rule === 'broken-link' && i.message.includes('y.html')), '不存在的路径应报断链');
	});

	test('检测孤立笔记', async () => {
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(root(), '孤.md'), '---\nsources:\n  - "[[库/x.md]]"\n---\n无任何双链');
		const issues = await lintVault(fs as any, root());
		assert.ok(issues.some(i => i.rule === 'orphan'), '应检出孤立笔记');
	});

	test('正常互链笔记不报断链/孤立', async () => {
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(root(), 'A.md'), '---\nsources:\n  - "[[库/x.md]]"\n---\nA [[B]]');
		fs.addFile(URI.joinPath(root(), 'B.md'), '---\nsources:\n  - "[[库/x.md]]"\n---\nB [[A]]');
		const issues = await lintVault(fs as any, root());
		assert.ok(!issues.some(i => i.rule === 'broken-link'), '互链不应报断链');
		assert.ok(!issues.some(i => i.rule === 'orphan'), '互链不应报孤立');
	});

	test('formatLintReport 生成报告', () => {
		const issues = [
			{ note: URI.file('/v/n/A.md'), severity: 'warning' as const, rule: 'broken-link', message: '断链 [[x]]' },
		];
		const r = formatLintReport(URI.file('/v/n'), issues);
		assert.ok(r.includes('# 知识库体检报告'));
		assert.ok(r.includes('断链 [[x]]'));
		assert.ok(r.includes('warning 1'));
	});

	// ── 规则 4/5（2026-09-23）：删除带来的悬空状态 ────────────────────────────────
	test('来源失效：sources 指向已不存在的文件 ⇒ missing-source', async () => {
		const libRoot = URI.file('/vault/库');
		const fs = new MockFileService();
		fs.addFile(URI.joinPath(libRoot, 'raw/存在.md'), '素材（无 frontmatter）');
		fs.addFile(URI.joinPath(libRoot, 'A.md'), '---\nsources:\n  - "[[库/raw/存在.md]]"\n---\n正文');
		fs.addFile(URI.joinPath(libRoot, 'B.md'), '---\nsources:\n  - "[[库/raw/已删除.md]]"\n  - "[[库/raw/存在.md]]"\n---\n正文');

		const issues = await lintVault(fs as any, libRoot);
		const hit = issues.filter(i => i.rule === 'missing-source');
		assert.strictEqual(hit.length, 1, '只有引用了已删来源的那篇应报，且每篇只报一条');
		assert.ok(hit[0].note.path.endsWith('B.md'));
		assert.ok(hit[0].message.includes('已删除.md'), '应点名失效的来源');
		assert.ok(!hit[0].message.includes('存在.md'), '仍存在的来源不应出现在失效列表里');
	});

	test('构建缓存孤儿：源 / 笔记已不存在 ⇒ stale-cache（两条，严重度不同）', async () => {
		const libRoot = URI.file('/vault/库');
		const fs = new MockFileService();
		const srcOk = URI.joinPath(libRoot, 'src-ok.md');
		const srcGone = URI.joinPath(libRoot, 'src-gone.md');
		const noteOk = URI.joinPath(libRoot, 'note-ok.md');
		const noteGone = URI.joinPath(libRoot, 'note-gone.md');
		fs.addFile(srcOk, '---\nsources: []\n---\n源');
		fs.addFile(noteOk, '---\nsources: []\n---\n笔记');
		// 缓存位于 vault 根（扫描根的上一级）
		fs.addFile(URI.file('/vault/.kb-build-cache.json'), JSON.stringify({
			[srcOk.fsPath]: noteGone.fsPath,   // 笔记被删 ⇒ warning（会导致该素材无法批量重建）
			[srcGone.fsPath]: noteOk.fsPath,   // 源被删 ⇒ info（同名素材重新出现会被误判已构建）
		}));

		const issues = await lintVault(fs as any, libRoot);
		const stale = issues.filter(i => i.rule === 'stale-cache');
		assert.strictEqual(stale.length, 2, '源失效与笔记失效应各报一条');
		assert.ok(stale.some(i => i.severity === 'info' && i.message.includes('源文件已不存在')));
		assert.ok(stale.some(i => i.severity === 'warning' && i.message.includes('已建笔记已不存在')));
	});
});
