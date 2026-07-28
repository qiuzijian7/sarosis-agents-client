/*---------------------------------------------------------------------------------------------
 *  codebaseGraphSqliteStore.test.ts — CodebaseGraphSqliteStore 单元测试（mocha BDD）。
 *
 *  覆盖 2026-07-22 新增能力：
 *  - searchNodes：单词/多词优先 FTS5 bm25，空结果退回 LIKE 子串（子串必须兜底）
 *  - grepContent：主进程流式 grep（字面/正则/glob/limit/大文件跳过/缺文件容错/空查询）
 *
 *  better-sqlite3 不可用时全部跳过（非 Electron 主进程环境常见）。
 *  运行：node test/node/run-codebaseGraphSqliteStore-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { CodebaseGraphSqliteStore } from '../../node/codebaseGraphSqliteStore.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 由 runner 注入（better-sqlite3 从 temp dir 不可解析，runner 侧已加载并设置全局标记）
const dbAvailable = !!(globalThis as any).__KBSQLITE_AVAILABLE__;
const itOrSkip = dbAvailable ? it : it.skip;

const tmpDir = path.join(os.tmpdir(), `cbg-sqlite-test-${Date.now()}`);
const PROJECT = 'P';

function tempDb(name: string): string {
	fs.mkdirSync(tmpDir, { recursive: true });
	return path.join(tmpDir, name);
}

function cleanup(): void {
	try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
}

function makeNode(name: string, opts: Partial<Record<string, unknown>> = {}): any {
	return {
		project: PROJECT,
		name,
		label: (opts.label as string) ?? 'Function',
		type: (opts.type as string) ?? (opts.label as string) ?? 'Function',
		qualifiedName: (opts.qualifiedName as string) ?? name,
		filePath: opts.filePath,
		startLine: opts.startLine ?? 1,
		endLine: opts.endLine ?? 10,
		inDegree: opts.inDegree ?? 0,
		outDegree: opts.outDegree ?? 0,
		properties: opts.properties ?? {},
	};
}

describe('CodebaseGraphSqliteStore.searchNodes (FTS5-first + LIKE fallback)' + (dbAvailable ? '' : ' [SKIPPED: better-sqlite3 not installed]'), () => {

	itOrSkip('single-word query hits via FTS5 bm25 (exact token)', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('fts-single.db'));
		await store.upsertNode(makeNode('ProcessEvent'));
		await store.upsertNode(makeNode('ProcessEventInternal'));
		await store.upsertNode(makeNode('GarbageCollect'));
		const rows = await store.searchNodes('ProcessEvent');
		const names = rows.map(r => r.name);
		assert.ok(names.includes('ProcessEvent'), `expected ProcessEvent in ${JSON.stringify(names)}`);
		await store.close();
	});

	itOrSkip('substring query falls back to LIKE (FTS token would miss)', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('like-fallback.db'));
		await store.upsertNode(makeNode('MyHandler'));
		await store.upsertNode(makeNode('GarbageCollect'));
		// "Handle" 不是独立词元 → FTS5 无命中 → 必须 LIKE 兜底命中 MyHandler
		const rows = await store.searchNodes('Handle');
		const names = rows.map(r => r.name);
		assert.ok(names.includes('MyHandler'), `LIKE fallback should find MyHandler, got ${JSON.stringify(names)}`);
		await store.close();
	});

	itOrSkip('multi-word query uses FTS5 AND semantics', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('fts-multi.db'));
		await store.upsertNode(makeNode('ProcessEvent', { qualifiedName: 'Engine.Core.ProcessEvent' }));
		await store.upsertNode(makeNode('ProcessEvent', { qualifiedName: 'Game.UI.ProcessEvent' }));
		const rows = await store.searchNodes('Engine ProcessEvent');
		assert.strictEqual(rows.length, 1, `expected exactly 1 row, got ${rows.length}`);
		assert.strictEqual(rows[0].qualifiedName, 'Engine.Core.ProcessEvent');
		await store.close();
	});

	itOrSkip('nodeType filter is applied', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('type-filter.db'));
		// 注意：upsertNode 按 (project, qualifiedName) 冲突更新 → 必须给不同 qn
		await store.upsertNode(makeNode('Auth', { label: 'Class', type: 'Class', qualifiedName: 'ns.AuthClass' }));
		await store.upsertNode(makeNode('Auth', { label: 'Function', type: 'Function', qualifiedName: 'ns.AuthFn' }));
		const rows = await store.searchNodes('Auth', 'Class');
		assert.ok(rows.length >= 1);
		assert.ok(rows.every(r => (r.type ?? r.label) === 'Class'), 'all rows should be Class');
		await store.close();
	});

	itOrSkip('empty query returns empty array', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('empty-q.db'));
		await store.upsertNode(makeNode('Anything'));
		assert.deepStrictEqual(await store.searchNodes(''), []);
		assert.deepStrictEqual(await store.searchNodes('   '), []);
		await store.close();
	});

	itOrSkip('limit is respected', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('limit.db'));
		for (let i = 0; i < 10; i++) { await store.upsertNode(makeNode(`Fn${i}`, { qualifiedName: `ns.Fn${i}` })); }
		const rows = await store.searchNodes('Fn', undefined, 3);
		assert.ok(rows.length <= 3, `expected <= 3 rows, got ${rows.length}`);
		await store.close();
	});
});

describe('CodebaseGraphSqliteStore.grepContent (main-process streaming grep)' + (dbAvailable ? '' : ' [SKIPPED: better-sqlite3 not installed]'), () => {

	let repoRoot: string;

	/** 建一个带真实源文件的临时仓库，并把文件清单（以节点形式）写入 store。 */
	async function setupRepo(dbName: string): Promise<CodebaseGraphSqliteStore> {
		repoRoot = path.join(tmpDir, 'repo');
		fs.mkdirSync(path.join(repoRoot, 'src', 'sub'), { recursive: true });
		fs.writeFileSync(path.join(repoRoot, 'src', 'a.cpp'), 'void foo() {}\n// call ProcessEvent now\n');
		fs.writeFileSync(path.join(repoRoot, 'src', 'b.cpp'), 'int bar = 42;\n');
		fs.writeFileSync(path.join(repoRoot, 'src', 'sub', 'c.h'), '#pragma once\nvoid ProcessEvent();\n');
		// 超 1MB 上限的大文件（含命中词，应被跳过）
		fs.writeFileSync(path.join(repoRoot, 'src', 'big.cpp'), `// ${'x'.repeat(1024 * 1024 + 16)} ProcessEvent\n`);

		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb(dbName));
		await store.upsertNode(makeNode('foo', { filePath: 'src/a.cpp' }));
		await store.upsertNode(makeNode('bar', { filePath: 'src/b.cpp' }));
		await store.upsertNode(makeNode('ProcessEvent', { filePath: 'src/sub/c.h' }));
		await store.upsertNode(makeNode('bigFn', { filePath: 'src/big.cpp' }));
		await store.upsertNode(makeNode('ghost', { filePath: 'src/gone.cpp' })); // 磁盘上不存在
		return store;
	}

	itOrSkip('literal query matches across files, returns rel paths + line numbers', async () => {
		const store = await setupRepo('grep-basic.db');
		const r = await store.grepContent('ProcessEvent', { project: PROJECT, roots: [repoRoot] });
		const byFile = new Map(r.matches.map(m => [m.filePath, m.lineNo]));
		assert.strictEqual(byFile.get('src/a.cpp'), 2, `a.cpp:2 expected, got ${JSON.stringify(r.matches)}`);
		assert.strictEqual(byFile.get('src/sub/c.h'), 2, `c.h:2 expected, got ${JSON.stringify(r.matches)}`);
		assert.ok(r.totalFiles >= 4, `totalFiles should count indexed files, got ${r.totalFiles}`);
		await store.close();
	});

	itOrSkip('filePattern glob narrows scope', async () => {
		const store = await setupRepo('grep-glob.db');
		const r = await store.grepContent('ProcessEvent', { project: PROJECT, roots: [repoRoot], filePattern: '**/*.h' });
		assert.strictEqual(r.matches.length, 1);
		assert.strictEqual(r.matches[0].filePath, 'src/sub/c.h');
		await store.close();
	});

	itOrSkip('useRegex matches pattern', async () => {
		const store = await setupRepo('grep-regex.db');
		const r = await store.grepContent('Process\\w+', { project: PROJECT, roots: [repoRoot], useRegex: true });
		assert.ok(r.matches.length >= 2, `expected >= 2 matches, got ${r.matches.length}`);
		await store.close();
	});

	itOrSkip('limit causes early exit', async () => {
		const store = await setupRepo('grep-limit.db');
		const r = await store.grepContent('ProcessEvent', { project: PROJECT, roots: [repoRoot], limit: 1 });
		assert.strictEqual(r.matches.length, 1);
		await store.close();
	});

	itOrSkip('oversized file (>1MB) is skipped; missing file tolerated', async () => {
		const store = await setupRepo('grep-bigskip.db');
		const r = await store.grepContent('ProcessEvent', { project: PROJECT, roots: [repoRoot] });
		assert.ok(!r.matches.some(m => m.filePath === 'src/big.cpp'), 'big.cpp must be skipped');
		// gone.cpp 不存在 → 不抛错、不出现在结果中
		assert.ok(!r.matches.some(m => m.filePath === 'src/gone.cpp'), 'gone.cpp must not appear');
		await store.close();
	});

	itOrSkip('empty query returns empty result', async () => {
		const store = await setupRepo('grep-empty.db');
		const r = await store.grepContent('', { project: PROJECT, roots: [repoRoot] });
		assert.deepStrictEqual(r.matches, []);
		assert.strictEqual(r.totalFiles, 0);
		await store.close();
	});

	itOrSkip('no match returns empty matches but reports scan stats', async () => {
		const store = await setupRepo('grep-nomatch.db');
		const r = await store.grepContent('NoSuchSymbolXYZ', { project: PROJECT, roots: [repoRoot] });
		assert.deepStrictEqual(r.matches, []);
		assert.ok(r.totalFiles >= 4);
		await store.close();
	});
});

after(() => cleanup());
