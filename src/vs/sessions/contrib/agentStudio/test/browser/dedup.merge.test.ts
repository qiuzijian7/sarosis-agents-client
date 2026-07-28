/*---------------------------------------------------------------------------------------------
 *  dedup merge 引用重写测试（P3-1）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { rewriteRefs, mergeDuplicates, type DedupGroup } from '../../browser/knowledge/dedup.js';

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
	async writeFile(uri: URI, content: VSBuffer): Promise<void> { this._files.set(uri.toString(), content.toString()); }
	async del(_uri: URI): Promise<void> { this._files.delete(_uri.toString()); }
	contentOf(uri: URI): string | undefined { return this._files.get(uri.toString()); }
}

suite('AgentStudio - dedup merge 引用重写', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('rewriteRefs 把 [[被删名]] → [[keep名]]', () => {
		const deleted = new Map([["a'", "A'"]]);
		const { newContent, changed } = rewriteRefs('见 [[A\']] 与 [[B]]', deleted, 'A');
		assert.strictEqual(changed, true);
		assert.ok(newContent.includes('[[A]]'));
		assert.ok(newContent.includes('[[B]]'));
		assert.ok(!newContent.includes("[[A']]"));
	});

	test('rewriteRefs 含别名 [[A\'|x]] → [[keep名]]', () => {
		const deleted = new Map([["a'", "A'"]]);
		const { newContent, changed } = rewriteRefs("[[A'|别名]]", deleted, 'A');
		assert.strictEqual(changed, true);
		assert.ok(newContent.includes('[[A]]'));
	});

	test('rewriteRefs 无匹配 → 不变', () => {
		const deleted = new Map([['x', 'X']]);
		const { newContent, changed } = rewriteRefs('[[B]] 正文', deleted, 'A');
		assert.strictEqual(changed, false);
		assert.strictEqual(newContent, '[[B]] 正文');
	});

	test('mergeDuplicates 删除重复并重写引用', async () => {
		const fs = new MockFileService();
		const root = URI.file('/vault/notes');
		const A = URI.joinPath(root, 'A.md');
		const Ap = URI.joinPath(root, 'Aprime.md');
		const B = URI.joinPath(root, 'B.md');
		fs.addFile(A, '---\ntitle: T\n---\nA 内容');
		fs.addFile(Ap, '---\ntitle: T\n---\nA 重复');
		fs.addFile(B, '---\ntitle: B\n---\nB 引用 [[Aprime]]');
		const group: DedupGroup = { key: 'test', notes: [A, Ap], reason: 'title-collision' };

		const r = await mergeDuplicates(fs as any, root, group, A);
		assert.strictEqual(r.deleted.length, 1);
		assert.strictEqual(r.deleted[0].toString(), Ap.toString());
		assert.ok(r.rewritten.some(u => u.toString() === B.toString()), 'B 应被重写');
		const bContent = fs.contentOf(B)!;
		assert.ok(bContent.includes('[[A]]'), 'B 的 [[Aprime]] 应改为 [[A]]');
		assert.ok(!bContent.includes('[[Aprime]]'));
		assert.ok(!fs.contentOf(Ap), 'Aprime 应被删除');
	});

	test('mergeDuplicates keep 不在 group → 不删任何', async () => {
		const fs = new MockFileService();
		const root = URI.file('/vault/notes');
		const A = URI.joinPath(root, 'A.md');
		const B = URI.joinPath(root, 'B.md');
		fs.addFile(A, 'A');
		fs.addFile(B, 'B');
		const group: DedupGroup = { key: 'test', notes: [A, B], reason: 'title-collision' };
		const other = URI.joinPath(root, 'C.md');
		fs.addFile(other, 'C');
		const r = await mergeDuplicates(fs as any, root, group, other);
		assert.strictEqual(r.deleted.length, 0);
	});
});
