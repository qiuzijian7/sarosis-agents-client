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

	// ── project 过滤下推（2026-09-15）─────────────────────────────────────
	// 背景：SQLite 文件是**跨工作区共享**的持久层（<userData>/codebase-graph/graph.db），
	// 里面留着历史工作区的项目。旧实现不带 project ⇒ 跨全库取前 N 条，候选池被外来项目占满，
	// renderer 侧再收敛 ⇒ 结果恒为 0（用户实测 needle="test" 的 231 条全是 S1Game:148 + UE5EA:83）。

	itOrSkip('project filter is pushed down (FTS path)', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('proj-fts.db'));
		await store.upsertNode(makeNode('test', { qualifiedName: 'mine::test' }));
		await store.upsertNode({ ...makeNode('test', { qualifiedName: 's1::test' }), project: 'S1Game' });
		await store.upsertNode({ ...makeNode('test', { qualifiedName: 'ue::test' }), project: 'UE5EA' });

		const all = await store.searchNodes('test');
		assert.strictEqual(all.length, 3, `不带 project 应跨库命中 3 条，实际 ${all.length}`);

		const mine = await store.searchNodes('test', undefined, 100, PROJECT);
		assert.strictEqual(mine.length, 1, `带 project 应只命中本项目 1 条，实际 ${mine.length}`);
		assert.strictEqual(mine[0].project, PROJECT);
		await store.close();
	});

	itOrSkip('project filter is pushed down (LIKE fallback path)', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('proj-like.db'));
		await store.upsertNode(makeNode('MyHandler', { qualifiedName: 'mine::MyHandler' }));
		await store.upsertNode({ ...makeNode('MyHandler', { qualifiedName: 's1::MyHandler' }), project: 'S1Game' });

		// "Handle" 不是独立词元 → FTS 无命中 → 走 LIKE 兜底；project 过滤必须同样生效
		const mine = await store.searchNodes('Handle', undefined, 100, PROJECT);
		assert.deepStrictEqual(mine.map(r => r.qualifiedName), ['mine::MyHandler']);
		await store.close();
	});

	itOrSkip('★ 回归：外来项目不得占满候选池（cap 很小时本项目仍须命中）', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('proj-cap.db'));
		// 模拟用户现场：残留的历史工作区项目在 "test" 上命中远多于本项目
		for (let i = 0; i < 20; i++) {
			await store.upsertNode({ ...makeNode('test', { qualifiedName: `s1::test${i}`, inDegree: 100 + i }), project: 'S1Game' });
		}
		for (let i = 0; i < 20; i++) {
			await store.upsertNode({ ...makeNode('test', { qualifiedName: `ue::test${i}`, inDegree: 100 + i }), project: 'UE5EA' });
		}
		await store.upsertNode(makeNode('test', { qualifiedName: 'mine::test', inDegree: 1 }));

		// 旧行为：cap=5 的候选全被外来项目占满 ⇒ 收敛后 0 结果（Find Symbol 搜不到任何东西）
		const withProject = await store.searchNodes('test', undefined, 5, PROJECT);
		assert.strictEqual(withProject.length, 1, `cap=5 时本项目应命中 1 条，实际 ${withProject.length}`);
		assert.strictEqual(withProject[0].project, PROJECT);
		await store.close();
	});

	// ── 非符号类型排除下推（2026-09-15，用户截图）───────────────────────────
	// 背景：Find Symbol 搜 `test` 时 200 条候选里大半是 `label='file'` 的 CONTAINS 桩节点
	// （`toolArgsJson.test.ts` 等**文件名**），把真正的 variable/function 挤出 LIMIT
	// （截图里 6 条可见结果只有 2 条真符号）。与 project 同一条教训：**只在 renderer
	// 后置过滤没用** —— LIMIT 已经先把符号丢掉了，必须下推到 SQL。

	itOrSkip('excludeTypes is pushed down (FTS path), case-insensitive', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('ex-type-fts.db'));
		await store.upsertNode(makeNode('test', { label: 'file', type: 'file', qualifiedName: 'src/a.test.ts', filePath: 'src/a.test.ts' }));
		await store.upsertNode(makeNode('test', { label: 'variable', type: 'variable', qualifiedName: 'src/a.ts::test' }));
		// 外来项目：同时验证 project 与 excludeTypes **两个下推条件同时生效**（占位符顺序）
		await store.upsertNode({ ...makeNode('test', { label: 'variable', type: 'variable', qualifiedName: 's1::test' }), project: 'S1Game' });

		const all = await store.searchNodes('test');
		assert.strictEqual(all.length, 3, `不带过滤应命中 file + 2 variable 共 3 条，实际 ${JSON.stringify(all.map(r => r.type))}`);

		// 传大写 'FILE' 也必须生效 —— 图里 `file`（addEdge 桩）与 `File`（架构视图）并存，
		// SQL 侧用 lower() 比较，调用方大小写不敏感
		const filtered = await store.searchNodes('test', undefined, 100, undefined, ['FILE']);
		assert.strictEqual(filtered.length, 2, `排除 file 后应只剩 2 个 variable，实际 ${JSON.stringify(filtered.map(r => [r.name, r.type]))}`);
		assert.ok(filtered.every(r => r.type === 'variable'));

		// ★ project + excludeTypes 同时下推：两组占位符的顺序必须与 SQL 一致
		// （错位是这类「拼 SQL」改动最经典的缺陷形态）
		const both = await store.searchNodes('test', undefined, 100, PROJECT, ['file']);
		assert.strictEqual(both.length, 1, `project + excludeTypes 同时生效时应只剩本仓 variable，实际 ${JSON.stringify(both.map(r => [r.name, r.project, r.type]))}`);
		assert.strictEqual(both[0].project, PROJECT);
		assert.strictEqual(both[0].type, 'variable');
		await store.close();
	});

	itOrSkip('excludeTypes is pushed down (LIKE fallback path)', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('ex-type-like.db'));
		await store.upsertNode(makeNode('myTestFile.ts', { label: 'file', type: 'file', qualifiedName: 'src/myTestFile.ts', filePath: 'src/myTestFile.ts' }));
		await store.upsertNode(makeNode('myTestHelper', { label: 'function', type: 'function', qualifiedName: 'src/a.ts::myTestHelper' }));

		// "TestH" 不是独立词元 → FTS 无命中 → LIKE 兜底；排除条件必须同样生效
		const filtered = await store.searchNodes('TestH', undefined, 100, undefined, ['file']);
		assert.deepStrictEqual(filtered.map(r => r.name), ['myTestHelper']);
		await store.close();
	});

	itOrSkip('★ 回归：file 桩节点不得占满候选池（cap 很小时真符号仍须命中）', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('ex-type-cap.db'));
		// 模拟用户现场：命中同一词的文件名桩节点远多于真符号（且连接度更高）
		for (let i = 0; i < 30; i++) {
			await store.upsertNode(makeNode('test', { label: 'file', type: 'file', qualifiedName: `src/f${i}.test.ts`, filePath: `src/f${i}.test.ts`, inDegree: 100 + i }));
		}
		await store.upsertNode(makeNode('testHelper', { label: 'variable', type: 'variable', qualifiedName: 'src/a.ts::testHelper', inDegree: 1 }));

		// 旧行为：cap=5 的候选全被 file 桩节点占满 ⇒ Find Symbol 只看到文件名（用户截图）
		const rows = await store.searchNodes('test', undefined, 5, undefined, ['file']);
		assert.strictEqual(rows.length, 1, `cap=5 且排除 file 后应只剩真符号，实际 ${JSON.stringify(rows.map(r => r.name))}`);
		assert.strictEqual(rows[0].name, 'testHelper');
		await store.close();
	});

	// ── 符号名检索 nameOnly（2026-09-15，用户截图）─────────────────────────
	// 背景：Find Symbol 搜 `test` 返回 `MockClassifyLLM` —— QN 形如 `<相对文件路径>::<符号名>`，
	// 而 FTS 索引了 qualified_name/file_path/body ⇒ 路径里的 `classifyLLM.test.ts` 也算命中。
	// `nameOnly` 只匹配 `name` 列，且**跳过 FTS 走 LIKE 子串**（FTS 是词元匹配，`testHelper`
	// 会被漏掉 —— 见第二个用例，防止有人把它「优化」成 FTS 列过滤）。

	itOrSkip('nameOnly matches the name column only (QN/filePath must not match)', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('name-only.db'));
		// 用户截图里的那个类：QN 里含 "test"（文件名），符号名本身不含
		await store.upsertNode(makeNode('MockClassifyLLM', {
			label: 'class', type: 'class',
			qualifiedName: 'src/knowledge/classifyLLM.test.ts::MockClassifyLLM',
			filePath: 'src/knowledge/classifyLLM.test.ts',
		}));
		// 名字里真的含 "test"
		await store.upsertNode(makeNode('testHelper', { label: 'variable', type: 'variable', qualifiedName: 'src/a.ts::testHelper', filePath: 'src/a.ts' }));

		// 旧口径（FTS 跨 name/QN/file_path/body）：只命中 QN 里的路径 —— 正是用户看到的现象
		const loose = await store.searchNodes('test');
		assert.deepStrictEqual(loose.map(r => r.name), ['MockClassifyLLM'], `旧口径应只命中 QN 里的路径命中，实际 ${JSON.stringify(loose.map(r => r.name))}`);

		// nameOnly：只剩名字里真的含 test 的那条
		const strict = await store.searchNodes('test', undefined, 100, undefined, undefined, true);
		assert.deepStrictEqual(strict.map(r => r.name), ['testHelper']);
		await store.close();
	});

	itOrSkip('nameOnly is a substring match (FTS token match would miss testHelper)', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('name-only-substr.db'));
		await store.upsertNode(makeNode('testHelper', { label: 'function', type: 'function', qualifiedName: 'src/a.ts::testHelper' }));
		await store.upsertNode(makeNode('MyTestRunner', { label: 'class', type: 'class', qualifiedName: 'src/b.ts::MyTestRunner' }));

		// 词元匹配只会命中词元恰为 test 的名字 ⇒ `testHelper`/`MyTestRunner` 都会漏
		const rows = await store.searchNodes('test', undefined, 100, undefined, undefined, true);
		assert.deepStrictEqual(rows.map(r => r.name).sort(), ['MyTestRunner', 'testHelper']);
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

// ── keyset 分页（2026-09-16）──────────────────────────────────────────────────
// 动机：`_loadGraphFromSqlite()` 必须分页（几十万行不能一次跨 IPC 把主线程冻住），而
// `LIMIT/OFFSET` 在翻到后面几页时是 **O(offset) 累计**（每页从头跳过前 offset 行；边查询的
// project 过滤子查询还要每页重跑一次）⇒ 改 keyset（`id > 游标`）。这里钉三件事：
//   ① 翻页不漏不重；② 与 project 过滤叠加仍正确（边尤其易错）；③ afterId 与 offset 同时给出时
//   以 keyset 为准（两套语义叠加会漏行）。
describe('CodebaseGraphSqliteStore keyset paging (getAllNodes / getAllEdges)' + (dbAvailable ? '' : ' [SKIPPED: better-sqlite3 not installed]'), () => {

	itOrSkip('nodes: keyset 翻页不漏不重', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('keyset-nodes.db'));
		for (let i = 0; i < 25; i++) { await store.upsertNode(makeNode(`n${i}`)); }
		await store.upsertNode({ ...makeNode('foreign'), project: 'Other' });

		const seen: string[] = [];
		let cursor: number | undefined;
		for (;;) {
			const page = await store.getAllNodes(undefined, 10, undefined, cursor);
			if (page.length === 0) { break; }
			for (const n of page) { seen.push(n.name); }
			cursor = Number(page[page.length - 1].id);
			if (page.length < 10) { break; }
		}
		assert.strictEqual(seen.length, 26, `共应取到 26 个节点，实际 ${seen.length}：${JSON.stringify(seen)}`);
		assert.strictEqual(new Set(seen).size, 26, 'keyset 翻页不得重复');
		await store.close();
	});

	itOrSkip('nodes: project 过滤与 keyset 叠加，且 afterId 优先于 offset', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('keyset-nodes-filter.db'));
		for (let i = 0; i < 6; i++) { await store.upsertNode(makeNode(`p${i}`)); }
		for (let i = 0; i < 4; i++) { await store.upsertNode({ ...makeNode(`o${i}`), project: 'Other' }); }

		const mine = await store.getAllNodes(PROJECT, 3, undefined, undefined);
		assert.strictEqual(mine.length, 3);
		assert.ok(mine.every(n => n.project === PROJECT), 'project 过滤必须生效');

		// afterId 与 offset 同时给：以 keyset 为准（offset 只是历史参数，叠加会漏行）
		const after = await store.getAllNodes(PROJECT, 3, 3, Number(mine[2].id));
		assert.strictEqual(after[0].name, 'p3', `afterId 存在时应忽略 offset，实际首条 ${after[0]?.name}`);
		await store.close();
	});

	itOrSkip('edges: keyset 翻页不漏不重 + project 过滤叠加 + 带游标 id', async () => {
		const store = new CodebaseGraphSqliteStore();
		await store.open(tempDb('keyset-edges.db'));
		const idA = await store.upsertNode(makeNode('a'));
		const idB = await store.upsertNode(makeNode('b'));
		const idF = await store.upsertNode({ ...makeNode('f'), project: 'Other' });
		const idG = await store.upsertNode({ ...makeNode('g'), project: 'Other' });
		for (let i = 0; i < 12; i++) {
			await store.upsertEdge({ source: String(idA), target: String(idB), type: `T${i}`, properties: {} });
		}
		await store.upsertEdge({ source: String(idF), target: String(idG), type: 'FOREIGN', properties: {} });

		const types: string[] = [];
		let cursor: number | undefined;
		for (;;) {
			const page = await store.getAllEdges(PROJECT, 5, undefined, cursor);
			if (page.length === 0) { break; }
			for (const e of page) {
				assert.ok(e.id !== undefined, '边必须带回行 id 作分页游标');
				types.push(e.type);
			}
			cursor = Number(page[page.length - 1].id);
			if (page.length < 5) { break; }
		}
		assert.strictEqual(types.length, 12, `本项目应有 12 条边，实际 ${types.length}：${JSON.stringify(types)}`);
		assert.strictEqual(new Set(types).size, 12, 'keyset 翻页不得重复');
		assert.ok(!types.includes('FOREIGN'), 'project 过滤必须排除他项目的边');
		await store.close();
	});
});

after(() => cleanup());
