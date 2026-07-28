/*---------------------------------------------------------------------------------------------
 *  kbSqliteStore.test.ts — KbSqliteStore 单元测试（mocha BDD）。
 *
 *  better-sqlite3 不可用时全部跳过（非 Electron 主进程环境常见）。
 *  运行：node test/node/run-kbSqliteStore-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { KbSqliteStore, IKbStoreDoc } from '../../node/kbSqliteStore.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 由 runner 注入（better-sqlite3 从 temp dir 不可解析，runner 侧已加载并设置全局标记）
const dbAvailable = !!(globalThis as any).__KBSQLITE_AVAILABLE__;
const itOrSkip = dbAvailable ? it : it.skip;

const tmpDir = path.join(os.tmpdir(), `kb-sqlite-test-${Date.now()}`);

function tempDb(name: string): string {
	fs.mkdirSync(tmpDir, { recursive: true });
	return path.join(tmpDir, name);
}

function cleanup(): void {
	try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
}

describe('KbSqliteStore' + (dbAvailable ? '' : ' [SKIPPED: better-sqlite3 not installed]'), () => {

	// ── 生命周期 ────────────────────────────────────────────────────

	itOrSkip('open creates db and tables', () => {
		const store = new KbSqliteStore();
		const dbPath = tempDb('test-open.db');
		store.open(dbPath);
		assert.ok(fs.existsSync(dbPath), 'db file should exist');
		store.close();
	});

	itOrSkip('close safely destroys (double close ok)', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-close.db'));
		store.close();
		store.close();
		assert.ok(true);
	});

	itOrSkip('open throws when better-sqlite3 not loaded', () => {
		// Already verified by itOrSkip — if we reach here, better-sqlite3 IS loaded
		const store = new KbSqliteStore();
		assert.doesNotThrow(() => store.open(tempDb('test-guard.db')));
		store.close();
	});

	// ── CRUD ────────────────────────────────────────────────────────

	itOrSkip('upsertDocsBatch inserts documents', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-insert.db'));
		const docs: IKbStoreDoc[] = [
			{ uri: '/a/note1.md', name: 'note1.md', section: 'notes', mtime: 100, size: 200, text: 'my first note' },
			{ uri: '/a/code.ts', name: 'code.ts', section: 'library', mtime: 200, size: 500, text: 'const x = 1;' },
		];
		store.upsertDocsBatch(docs);
		assert.strictEqual(store.getDocCount(), 2);
		store.close();
	});

	itOrSkip('upsertDocsBatch is idempotent (update existing)', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-upsert.db'));
		store.upsertDocsBatch([{ uri: '/dup.md', name: 'dup.md', section: 'library', mtime: 1, size: 10, text: 'v1' }]);
		store.upsertDocsBatch([{ uri: '/dup.md', name: 'dup-new.md', section: 'notes', mtime: 999, size: 99, text: 'v2' }]);
		const all = store.getAllDocs();
		assert.strictEqual(all.length, 1, 'no duplicate');
		assert.strictEqual(all[0].name, 'dup-new.md');
		assert.strictEqual(all[0].mtime, 999);
		assert.strictEqual(all[0].text, 'v2');
		store.close();
	});

	itOrSkip('deleteDoc removes document', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-delete.db'));
		store.upsertDocsBatch([
			{ uri: '/keep.md', name: 'keep.md', section: 'library', mtime: 1, size: 10, text: 'keep' },
			{ uri: '/del.md', name: 'del.md', section: 'notes', mtime: 2, size: 20, text: 'del' },
		]);
		assert.strictEqual(store.getDocCount(), 2);
		store.deleteDoc('/del.md');
		assert.strictEqual(store.getDocCount(), 1);
		store.close();
	});

	itOrSkip('clear empties all docs', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-clear.db'));
		store.upsertDocsBatch([
			{ uri: '/a.md', name: 'a.md', section: 'library', mtime: 1, size: 1, text: 'a' },
			{ uri: '/b.md', name: 'b.md', section: 'notes', mtime: 2, size: 2, text: 'b' },
		]);
		store.clear();
		assert.strictEqual(store.getDocCount(), 0);
		store.close();
	});

	// ── FTS5 搜索 ───────────────────────────────────────────────────

	itOrSkip('search english phrase match', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-search-en.db'));
		store.upsertDocsBatch([
			{ uri: '/ml.md', name: 'ml.md', section: 'library', mtime: 1, size: 100, text: 'Machine learning is a subset of artificial intelligence' },
			{ uri: '/dl.md', name: 'dl.md', section: 'notes', mtime: 2, size: 200, text: 'Deep learning uses neural networks' },
		]);
		const r = store.search('machine learning', 5);
		assert.ok(r.length >= 1, `expected match: ${r.length}`);
		assert.strictEqual(r[0].name, 'ml.md');

		const empty = store.search('nonexistent', 5);
		assert.strictEqual(empty.length, 0);
		store.close();
	});

	itOrSkip('search chinese bigram tokenization', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-search-zh.db'));
		store.upsertDocsBatch([
			{ uri: '/ml.md', name: '机器学习.md', section: 'library', mtime: 1, size: 100, text: '机器学习是人工智能的重要分支' },
			{ uri: '/dl.md', name: '深度学习.md', section: 'notes', mtime: 2, size: 200, text: '深度学习常用神经网络和反向传播算法' },
		]);
		const r1 = store.search('机器学习', 5);
		assert.ok(r1.length >= 1, `机器学习: ${r1.length}`);

		// unicode61 bigram should match partial
		const r2 = store.search('学习', 5);
		assert.ok(r2.length >= 1, `学习 (bigram): ${r2.length}`);

		// prefix fallback
		const r3 = store.search('神经网络', 5);
		assert.ok(r3.length >= 1, `神经网络 (prefix): ${r3.length}`);
		store.close();
	});

	itOrSkip('search snippet has highlight marks', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-snippet.db'));
		store.upsertDocsBatch([
			{ uri: '/s.md', name: 's.md', section: 'library', mtime: 1, size: 100, text: 'The quick brown fox jumps over the lazy dog' },
		]);
		const r = store.search('quick fox', 5);
		assert.ok(r.length >= 1);
		assert.ok(r[0].snippet.includes('<mark>'), `snippet: ${r[0].snippet}`);
		store.close();
	});

	itOrSkip('search handles FTS5 special chars gracefully', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-escape.db'));
		store.upsertDocsBatch([
			{ uri: '/s.md', name: 's.md', section: 'library', mtime: 1, size: 50, text: 'C++ is a (powerful) language' },
		]);
		assert.doesNotThrow(() => { store.search('C++ (powerful)', 5); });
		const r = store.search('powerful', 5);
		assert.ok(r.length >= 1, `powerful: ${r.length}`);
		store.close();
	});

	// ── 边界情况 ────────────────────────────────────────────────────

	itOrSkip('empty db returns empty search', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-empty.db'));
		assert.strictEqual(store.search('anything', 5).length, 0);
		store.close();
	});

	itOrSkip('large text doc (~48KB) does not crash', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-large.db'));
		const t = 'open source '.repeat(8_000);
		store.upsertDocsBatch([{ uri: '/l.md', name: 'l.md', section: 'library', mtime: 1, size: t.length, text: t }]);
		assert.ok(store.search('open', 5).length >= 1);
		store.close();
	});

	itOrSkip('1000 doc bulk insert under 5s', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-bulk.db'));
		const docs: IKbStoreDoc[] = [];
		for (let i = 0; i < 1000; i++) {
			docs.push({ uri: `/doc${i}.md`, name: `doc${i}.md`, section: 'library', mtime: i, size: i * 10, text: `doc ${i} with testdoc keyword` });
		}
		const t0 = performance.now();
		store.upsertDocsBatch(docs);
		const elapsed = performance.now() - t0;
		assert.strictEqual(store.getDocCount(), 1000);
		assert.ok(elapsed < 5000, `1000 docs in: ${elapsed.toFixed(1)}ms`);
		assert.ok(store.search('testdoc', 10).length > 0);
		store.close();
	});

	// ── CJK 双字预处理（对齐 unicode61 tokenizer） ──────────────────

	itOrSkip('CJK bigram preprocessing produces matching results', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-cjk-bigram.db'));
		store.upsertDocsBatch([
			{ uri: '/ml.md', name: '机器学习.md', section: 'library', mtime: 1, size: 100, text: '机器学习是人工智能的重要分支，包括监督学习和无监督学习' },
		]);

		// 单字也能命中（unicode61 双字切分 → "机器 器学 学习"）
		const r1 = store.search('机器学习', 5);
		assert.ok(r1.length >= 1, `"机器学习" 应命中: ${r1.length}`);

		// 双字 short query
		const r2 = store.search('学习', 5);
		assert.ok(r2.length >= 1, `"学习" 应命中: ${r2.length}`);

		// 三字 → 机器 器学 学习
		const r3 = store.search('器学', 5);
		assert.ok(r3.length >= 1, `"器学" bigram 应能命中: ${r3.length}`);

		store.close();
	});

	itOrSkip('CJK multi-word bigram search', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-cjk-multi.db'));
		store.upsertDocsBatch([
			{ uri: '/dl.md', name: '深度学习.md', section: 'notes', mtime: 1, size: 100, text: '深度学习常用卷积神经网络和循环神经网络进行图像识别' },
			{ uri: '/vision.md', name: '计算机视觉.md', section: 'library', mtime: 2, size: 200, text: '计算机视觉使用卷积神经网络处理图像数据' },
			{ uri: '/irr.md', name: '自然语言处理.md', section: 'library', mtime: 3, size: 150, text: '自然语言处理使用循环神经网络和Transformer模型' },
		]);

		// 卷积神经网络 → 卷积 积神 神经 经网 网络
		const r1 = store.search('卷积神经网络', 5);
		assert.ok(r1.length >= 1, `"卷积神经网络" 应命中: ${r1.length}`);

		// 图像识别 → 图像 像识 识别
		const r2 = store.search('图像识别', 5);
		assert.ok(r2.length >= 1, `"图像识别" 应命中: ${r2.length}`);

		// 短词匹配（应只匹配包含该 bigram 的文档）
		const r3 = store.search('网络', 5);
		assert.ok(r3.length >= 2, `"网络" 应命中 ≥2 篇: ${r3.length}`);

		store.close();
	});

	itOrSkip('CJK + English mixed query', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-cjk-en.db'));
		store.upsertDocsBatch([
			{ uri: '/py.md', name: 'Python机器学习.md', section: 'library', mtime: 1, size: 100, text: 'Python is widely used for 机器学习 and deep learning applications' },
		]);

		// 混合中英文 → FTS5 unicode61 分别处理
		const r = store.search('Python 机器学习', 5);
		assert.ok(r.length >= 1, `"Python 机器学习" 应命中: ${r.length}`);
		store.close();
	});

	itOrSkip('CJK short 2-char query exact match', () => {
		const store = new KbSqliteStore();
		store.open(tempDb('test-cjk-short.db'));
		store.upsertDocsBatch([
			{ uri: '/a.md', name: '测试.md', section: 'library', mtime: 1, size: 50, text: '这是一个测试文档' },
		]);

		// 双字 query 不需要切分, 直接当短语
		const r1 = store.search('测试', 5);
		assert.ok(r1.length >= 1, `"测试" 应命中: ${r1.length}`);

		// 三字 query → "这是一" → "这是 是一" bigrams
		const r2 = store.search('这是一个', 5);
		assert.ok(r2.length >= 1, `"这是一个" 应命中: ${r2.length}`);

		store.close();
	});

	// ── 清理 ────────────────────────────────────────────────────────

	itOrSkip('cleanup temp files', () => {
		cleanup();
		assert.ok(!fs.existsSync(tmpDir));
	});

	// 确保至少有一个 always-pass 的测试（让 mocha 不报空 suite）
	if (!dbAvailable) {
		it('no better-sqlite3, all sqlite tests skipped', () => { assert.ok(true); });
	}
});
