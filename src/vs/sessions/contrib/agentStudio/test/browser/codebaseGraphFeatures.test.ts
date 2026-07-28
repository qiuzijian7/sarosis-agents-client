/*---------------------------------------------------------------------------------------------
 *  Unit tests for two codebase-graph capabilities added 2026-07-18:
 *    1. Cypher RETURN `CASE WHEN ... THEN ... [ELSE ...] END` (codebaseGraphCypher.ts)
 *    2. `get_graph_schema` per-label/per-type property schema (codebaseGraphTrace.ts)
 *
 *  Run with:
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/test/browser/codebaseGraphFeatures.test.ts
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { CodebaseGraphStore, resolveSearchFileUri, resolveSearchFileCandidates } from '../../browser/codebaseGraphStore.js';
import { CypherEngine } from '../../browser/codebaseGraphCypher.js';
import { getGraphSchema } from '../../browser/codebaseGraphTrace.js';
import { searchCode } from '../../browser/codebaseGraphTrace.js';
import { executeExtendedCypher } from '../../browser/codebaseGraphAdvancedAnalysis.js';

const PROJECT = 'test';

function buildStore(): CodebaseGraphStore {
	const store = new CodebaseGraphStore();
	store.upsertNode({ project: PROJECT, label: 'Function', name: 'auth', qualifiedName: 'auth', properties: { cognitive: 20, complexity: 5 } });
	store.upsertNode({ project: PROJECT, label: 'Function', name: 'login', qualifiedName: 'login', properties: { cognitive: 10, complexity: 3 } });
	store.upsertNode({ project: PROJECT, label: 'Function', name: 'util', qualifiedName: 'util', properties: { cognitive: 3 } });
	store.upsertNode({ project: PROJECT, label: 'Class', name: 'AuthSvc', qualifiedName: 'AuthSvc', properties: { abstract: false } });
	return store;
}

suite('CypherEngine CASE WHEN (P2-#6)', () => {

	test('multi-branch THEN/ELSE with AS alias', () => {
		const engine = new CypherEngine(buildStore());
		const r = engine.execute(
			"MATCH (f:Function) RETURN f.name, CASE WHEN f.cognitive > 15 THEN 'high' WHEN f.cognitive > 8 THEN 'med' ELSE 'low' END AS risk",
			PROJECT
		);
		assert.deepStrictEqual(r.columns, ['f.name', 'risk']);
		// rows are 2-tuples [name, risk]; order follows node insertion
		const byName = new Map(r.rows.map(([n, risk]) => [n, risk]));
		assert.strictEqual(byName.get('auth'), 'high');
		assert.strictEqual(byName.get('login'), 'med');
		assert.strictEqual(byName.get('util'), 'low');
	});

	test('CASE without alias defaults column name to "case"', () => {
		const engine = new CypherEngine(buildStore());
		const r = engine.execute(
			'MATCH (f:Function) RETURN CASE WHEN f.cognitive > 15 THEN \'high\' ELSE \'low\' END',
			PROJECT
		);
		assert.deepStrictEqual(r.columns, ['case']);
		const vals = r.rows.map(row => row[0]).sort();
		assert.deepStrictEqual(vals, ['high', 'low', 'low']);
	});

	test('CASE THEN can return a field reference, ELSE a literal', () => {
		const engine = new CypherEngine(buildStore());
		const r = engine.execute(
			'MATCH (f:Function) RETURN CASE WHEN f.cognitive > 15 THEN f.name ELSE \'small\' END AS who',
			PROJECT
		);
		const byName = new Map(r.rows.map(([who]) => [who, true]));
		assert.ok(byName.has('auth'));   // matched branch returns field
		assert.ok(byName.has('small'));  // else branch literal
	});

	test('CASE WHEN with AND-chained condition', () => {
		const engine = new CypherEngine(buildStore());
		const r = engine.execute(
			'MATCH (f:Function) RETURN CASE WHEN f.cognitive > 8 AND f.cognitive <= 15 THEN f.name ELSE \'x\' END AS m',
			PROJECT
		);
		const matched = r.rows.map(([m]) => m).filter(v => v !== 'x');
		assert.deepStrictEqual(matched, ['login']); // only cognitive=10 in (8,15]
	});

	test('all WHEN miss falls through to ELSE', () => {
		const engine = new CypherEngine(buildStore());
		const r = engine.execute(
			'MATCH (f:Function) RETURN CASE WHEN f.cognitive > 100 THEN \'big\' ELSE \'none\' END AS t',
			PROJECT
		);
		assert.deepStrictEqual(r.rows.map(([t]) => t), ['none', 'none', 'none']);
	});
});

suite('getGraphSchema property schema (P2-#5)', () => {

	test('aggregates per-label property stats (name, count, types)', () => {
		const store = buildStore();
		const schema = getGraphSchema(store, PROJECT);

		const fn = schema.nodeLabels.find(l => l.label === 'Function')!;
		assert.strictEqual(fn.count, 3);
		const cognitive = fn.properties.find(p => p.name === 'cognitive')!;
		assert.strictEqual(cognitive.count, 3);
		assert.deepStrictEqual(cognitive.types, ['number']);

		const complexity = fn.properties.find(p => p.name === 'complexity')!;
		assert.strictEqual(complexity.count, 2); // only auth+login have it
		assert.deepStrictEqual(complexity.types, ['number']);

		const cls = schema.nodeLabels.find(l => l.label === 'Class')!;
		assert.strictEqual(cls.count, 1);
		const abs = cls.properties.find(p => p.name === 'abstract')!;
		assert.strictEqual(abs.count, 1);
		assert.deepStrictEqual(abs.types, ['boolean']);
	});

	test('properties sorted by frequency desc', () => {
		const store = buildStore();
		const fn = getGraphSchema(store, PROJECT).nodeLabels.find(l => l.label === 'Function')!;
		const names = fn.properties.map(p => p.name);
		assert.deepStrictEqual(names, ['cognitive', 'complexity']); // 3 then 2
	});

	test('totalNodes/totalEdges preserved', () => {
		const store = buildStore();
		const schema = getGraphSchema(store, PROJECT);
		assert.strictEqual(schema.totalNodes, 4);
		assert.strictEqual(schema.totalEdges, 0);
	});
});

// ─── Helpers with edges ───────────────────────────────────────────────────────

function buildStoreWithEdges(): CodebaseGraphStore {
	const store = new CodebaseGraphStore();
	const auth = store.upsertNode({ project: PROJECT, label: 'Function', name: 'auth', qualifiedName: 'auth', properties: { cognitive: 20 } });
	const login = store.upsertNode({ project: PROJECT, label: 'Function', name: 'login', qualifiedName: 'login', properties: { cognitive: 10 } });
	const util = store.upsertNode({ project: PROJECT, label: 'Function', name: 'util', qualifiedName: 'util', properties: { cognitive: 3 } });
	store.upsertNode({ project: PROJECT, label: 'Class', name: 'AuthSvc', qualifiedName: 'AuthSvc', properties: { abstract: false } });
	store.insertEdge({ project: PROJECT, sourceId: auth.id, targetId: login.id, type: 'CALLS' });
	store.insertEdge({ project: PROJECT, sourceId: login.id, targetId: util.id, type: 'CALLS' });
	store.insertEdge({ project: PROJECT, sourceId: auth.id, targetId: util.id, type: 'CALLS' });
	return store;
}

// ─── UNION / UNION ALL (extended engine) ──────────────────────────────────────

suite('executeExtendedCypher UNION (P2-#6)', () => {
	test('UNION merges distinct result sets (3 functions + 1 class = 4)', () => {
		const store = buildStore();
		const r = executeExtendedCypher(store, PROJECT,
			'MATCH (f:Function) RETURN f.name UNION MATCH (c:Class) RETURN c.name');
		assert.strictEqual(r.rows.length, 4);
	});

	test('UNION dedup removes duplicate rows', () => {
		const store = buildStore();
		const r = executeExtendedCypher(store, PROJECT,
			'MATCH (f:Function) RETURN f.name UNION MATCH (f:Function) RETURN f.name');
		// 两个子查询返回相同的 3 个函数名 → 去重后为 3
		assert.strictEqual(r.rows.length, 3);
	});

	test('UNION ALL keeps duplicates (3 + 3 = 6)', () => {
		const store = buildStore();
		const r = executeExtendedCypher(store, PROJECT,
			'MATCH (f:Function) RETURN f.name UNION ALL MATCH (f:Function) RETURN f.name');
		assert.strictEqual(r.rows.length, 6);
	});
});

// ─── multi-hop variable-length path (extended engine) ─────────────────────────

suite('executeExtendedCypher multi-hop *n..m (P2-#6)', () => {
	test('*1..2 returns forward BFS paths', () => {
		const store = buildStoreWithEdges();
		const r = executeExtendedCypher(store, PROJECT, 'MATCH (a)-[r*1..2]->(b) RETURN a.name, b.name');
		// 扩展引擎忽略 RETURN，输出固定列；BFS 路径：auth→login, auth→util, auth→login→util, login→util = 4
		assert.deepStrictEqual(r.columns, ['start', 'path', 'hops']);
		assert.strictEqual(r.rows.length, 4);
	});
});

// ─── relationship traversal (basic engine) ────────────────────────────────────

suite('CypherEngine relationship traversal (P2-#6)', () => {
	test('forward (f)-[r:CALLS]->(g) returns caller/callee pairs', () => {
		const store = buildStoreWithEdges();
		const r = new CypherEngine(store).execute(
			'MATCH (f:Function)-[r:CALLS]->(g:Function) RETURN f.name, g.name', PROJECT);
		assert.strictEqual(r.rows.length, 3); // auth→login, auth→util, login→util
		const pairs = new Set(r.rows.map(([f, g]) => `${f}->${g}`));
		assert.ok(pairs.has('auth->login'));
		assert.ok(pairs.has('auth->util'));
		assert.ok(pairs.has('login->util'));
	});

	test('reverse (g)<-[r:CALLS]-(f) follows incoming edges', () => {
		const store = buildStoreWithEdges();
		const r = new CypherEngine(store).execute(
			'MATCH (g:Function)<-[r:CALLS]-(f:Function) RETURN f.name, g.name', PROJECT);
		// 反向：g 为被调用方，f 为调用方。login←auth, util←auth, util←login = 3
		assert.strictEqual(r.rows.length, 3);
		const pairs = new Set(r.rows.map(([f, g]) => `${f}->${g}`));
		assert.ok(pairs.has('auth->login'));
		assert.ok(pairs.has('auth->util'));
		assert.ok(pairs.has('login->util'));
	});
});

// ─── ORDER BY / LIMIT / SKIP / aggregates / operators ────────────────────────

suite('CypherEngine ORDER BY / LIMIT / SKIP', () => {
	test('ORDER BY name DESC', () => {
		const store = buildStore();
		const r = new CypherEngine(store).execute(
			'MATCH (f:Function) RETURN f.name ORDER BY f.name DESC', PROJECT);
		assert.deepStrictEqual(r.columns, ['f.name']);
		assert.deepStrictEqual(r.rows, [['util'], ['login'], ['auth']]);
	});

	test('LIMIT restricts row count', () => {
		const store = buildStore();
		const r = new CypherEngine(store).execute(
			'MATCH (f:Function) RETURN f.name LIMIT 1', PROJECT);
		assert.strictEqual(r.rows.length, 1);
	});

	test('SKIP + LIMIT', () => {
		const store = buildStore();
		const r = new CypherEngine(store).execute(
			'MATCH (f:Function) RETURN f.name ORDER BY f.name SKIP 1 LIMIT 1', PROJECT);
		// skip auth → ['login']
		assert.deepStrictEqual(r.rows, [['login']]);
	});
});

suite('CypherEngine aggregates', () => {
	test('COUNT(f) AS cnt groups all matched nodes', () => {
		const store = buildStore();
		const r = new CypherEngine(store).execute(
			'MATCH (f:Function) RETURN count(f) AS cnt', PROJECT);
		assert.deepStrictEqual(r.columns, ['cnt']);
		assert.strictEqual(r.rows.length, 1);
		assert.strictEqual(r.rows[0][0], 3);
	});
});

suite('CypherEngine operators', () => {
	test('=~ regex matches pattern', () => {
		const store = buildStore();
		const r = new CypherEngine(store).execute(
			'MATCH (f:Function) WHERE f.name =~ \'au.*\' RETURN f.name', PROJECT);
		assert.deepStrictEqual(r.rows, [['auth']]);
	});

	test('CONTAINS substring match', () => {
		const store = buildStore();
		const r = new CypherEngine(store).execute(
			'MATCH (f:Function) WHERE f.name CONTAINS \'uti\' RETURN f.name', PROJECT);
		assert.deepStrictEqual(r.rows, [['util']]);
	});
});

// ─── STARTS WITH / ENDS WITH (P2 fix 2026-07-18) ──────────────────────────

suite('CypherEngine STARTS WITH / ENDS WITH', () => {
	test('STARTS WITH matches prefix', () => {
		const store = buildStore();
		const r = new CypherEngine(store).execute(
			'MATCH (f:Function) WHERE f.name STARTS WITH \'au\' RETURN f.name', PROJECT);
		assert.deepStrictEqual(r.rows, [['auth']]);
	});

	test('ENDS WITH matches suffix', () => {
		const store = buildStore();
		const r = new CypherEngine(store).execute(
			'MATCH (f:Function) WHERE f.name ENDS WITH \'in\' RETURN f.name', PROJECT);
		assert.deepStrictEqual(r.rows, [['login']]);
	});

	test('STARTS WITH no match returns empty', () => {
		const store = buildStore();
		const r = new CypherEngine(store).execute(
			'MATCH (f:Function) WHERE f.name STARTS WITH \'zzz\' RETURN f.name', PROJECT);
		assert.strictEqual(r.rows.length, 0);
	});

	test('ENDS WITH combined with AND', () => {
		const store = buildStore();
		const r = new CypherEngine(store).execute(
			'MATCH (f:Function) WHERE f.name STARTS WITH \'a\' AND f.name ENDS WITH \'h\' RETURN f.name', PROJECT);
		assert.deepStrictEqual(r.rows, [['auth']]);
	});
});

// ─── WITH clause (P2 fix 2026-07-18) ─────────────────────────────────────

suite('executeExtendedCypher WITH clause', () => {
	test('WITH simple projection without WHERE', () => {
		const store = buildStoreWithEdges();
		const r = executeExtendedCypher(store, PROJECT,
			'MATCH (f:Function) WITH f.name AS funcName RETURN funcName ORDER BY funcName');
		assert.ok(r.columns.includes('funcName'));
		const names = r.rows.map(row => row[0]).sort();
		assert.deepStrictEqual(names, ['auth', 'login', 'util']);
	});

	test('WITH projection with WHERE filter', () => {
		const store = buildStoreWithEdges();
		const r = executeExtendedCypher(store, PROJECT,
			'MATCH (f:Function) WITH f.name AS funcName, f.cognitive AS cx WHERE cx > 10 RETURN funcName, cx');
		// Only 'auth' has cognitive > 10
		assert.strictEqual(r.rows.length, 1);
		assert.strictEqual(r.rows[0][0], 'auth');
		assert.strictEqual(r.rows[0][1], 20);
	});

	test('WITH WHERE filters out all rows returns empty', () => {
		const store = buildStoreWithEdges();
		const r = executeExtendedCypher(store, PROJECT,
			'MATCH (f:Function) WITH f.name AS n, f.cognitive AS cx WHERE cx > 999 RETURN n');
		assert.strictEqual(r.rows.length, 0);
	});

	test('WITH ORDER BY DESC', () => {
		const store = buildStoreWithEdges();
		const r = executeExtendedCypher(store, PROJECT,
			'MATCH (f:Function) WITH f.cognitive AS cx RETURN cx ORDER BY cx DESC');
		assert.deepStrictEqual(r.rows, [[20], [10], [3]]);
	});

	test('WITH LIMIT', () => {
		const store = buildStoreWithEdges();
		const r = executeExtendedCypher(store, PROJECT,
			'MATCH (f:Function) WITH f.name AS n RETURN n ORDER BY n LIMIT 2');
		assert.strictEqual(r.rows.length, 2);
	});

	test('WITH aggregation COUNT on nodes', () => {
		const store = buildStore();
		// Simple aggregation: count all functions → should be 3
		const r = executeExtendedCypher(store, PROJECT,
			'MATCH (f:Function) WITH count(f) AS cnt RETURN cnt');
		assert.strictEqual(r.rows.length, 1);
		assert.strictEqual(r.rows[0][0], 3);
	});

	test('WITH aggregation COUNT on edges', () => {
		const store = buildStoreWithEdges();
		// Test the same query via WITH clause
		const r = executeExtendedCypher(store, PROJECT,
			'MATCH (a:Function)-[r:CALLS]->(b:Function) WITH a.name AS caller, count(r) AS callCount RETURN caller, callCount ORDER BY callCount DESC');
		assert.strictEqual(r.rows.length, 2, `got ${r.rows.length} rows: ${JSON.stringify(r.rows)}`);
		const byCaller = new Map(r.rows.map(([c, cnt]) => [c, cnt]));
		assert.strictEqual(byCaller.get('auth'), 2);
		assert.strictEqual(byCaller.get('login'), 1);
	});

	test('STARTS WITH not confused with WITH clause', () => {
		// Query has STARTS WITH but no standalone WITH — should go through basic engine
		const store = buildStore();
		const r = new CypherEngine(store).execute(
			'MATCH (f:Function) WHERE f.name STARTS WITH \'au\' RETURN f.name', PROJECT);
		assert.deepStrictEqual(r.rows, [['auth']]);
	});
});

// ─── BM25 extended index (signature/docstring/returnType) ────────────────────

function buildStoreWithSignatures(): CodebaseGraphStore {
	const store = new CodebaseGraphStore();
	store.upsertNode({
		project: PROJECT, label: 'Function', name: 'PerformReachabilityAnalysis',
		qualifiedName: 'FRealtimeGC::PerformReachabilityAnalysis',
		filePath: 'Runtime/CoreUObject/Private/UObject/GarbageCollection.cpp',
		properties: {
			signature: 'void PerformReachabilityAnalysis(ProcessObjectArray& Objects, bool bForce)',
			docstring: 'Process garbage collection reachability for async objects',
			returnType: 'void',
			paramTypes: ['ProcessObjectArray', 'bool'],
		},
	});
	store.upsertNode({
		project: PROJECT, label: 'Function', name: 'CollectReferences',
		qualifiedName: 'FRealtimeGC::CollectReferences',
		filePath: 'Runtime/CoreUObject/Private/UObject/GarbageCollection.cpp',
		properties: {
			signature: 'void CollectReferences(FReferenceCollector& Collector)',
			docstring: 'Collect object references during GC sweep',
		},
	});
	store.upsertNode({
		project: PROJECT, label: 'Function', name: 'ProcessAsync',
		qualifiedName: 'FRealtimeGC::ProcessAsync',
		filePath: 'Runtime/CoreUObject/Private/UObject/GarbageCollectionAsync.cpp',
		properties: {
			signature: 'void ProcessAsync()',
		},
	});
	// Add edges to give nodes degrees
	store.insertEdge({ project: PROJECT, sourceId: 1, targetId: 2, type: 'CALLS' });
	store.insertEdge({ project: PROJECT, sourceId: 1, targetId: 3, type: 'CALLS' });
	return store;
}

suite('BM25 extended index: signature/docstring (2026-07-19)', () => {

	test('search matches term in properties.signature', () => {
		const store = buildStoreWithSignatures();
		// "bForce" only appears in PerformReachabilityAnalysis signature, not in name/qn/filePath
		const r = store.search({ project: PROJECT, query: 'bForce', limit: 10 });
		assert.strictEqual(r.nodes.length, 1);
		assert.strictEqual(r.nodes[0].name, 'PerformReachabilityAnalysis');
	});

	test('search matches term in properties.docstring', () => {
		const store = buildStoreWithSignatures();
		// "sweep" only appears in CollectReferences docstring
		const r = store.search({ project: PROJECT, query: 'sweep', limit: 10 });
		assert.strictEqual(r.nodes.length, 1);
		assert.strictEqual(r.nodes[0].name, 'CollectReferences');
	});

	test('search matches term in properties.returnType', () => {
		const store = buildStoreWithSignatures();
		// "void" appears in returnType and signatures
		const r = store.search({ project: PROJECT, query: 'void', limit: 10 });
		assert.ok(r.nodes.length >= 1);
	});

	test('search matches paramTypes array elements', () => {
		const store = buildStoreWithSignatures();
		// "bForce" only appears in paramTypes (as part of signature)
		const r = store.search({ project: PROJECT, query: 'bForce', limit: 10 });
		assert.strictEqual(r.nodes.length, 1);
		assert.strictEqual(r.nodes[0].name, 'PerformReachabilityAnalysis');
	});

	test('multi-word query uses OR semantics (any word matches)', () => {
		const store = buildStoreWithSignatures();
		// "ProcessObjectArray CollectReferences ProcessAsync" — each word matches a different node
		const r = store.search({ project: PROJECT, query: 'ProcessObjectArray CollectReferences ProcessAsync', limit: 10 });
		// OR semantics: at least 2 of 3 should match (ProcessObjectArray→node1, CollectReferences→node2, ProcessAsync→node3)
		assert.ok(r.nodes.length >= 2, `expected >= 2 results, got ${r.nodes.length}`);
		const names = new Set(r.nodes.map(n => n.name));
		assert.ok(names.has('PerformReachabilityAnalysis'));
		assert.ok(names.has('CollectReferences'));
	});
});

// ─── filePattern glob → regex ────────────────────────────────────────────────

suite('filePattern glob matching (2026-07-19)', () => {

	test('*GarbageCollection* matches file paths containing GarbageCollection', () => {
		const store = buildStoreWithSignatures();
		// Query "void" matches all 3 nodes; filePattern narrows to GarbageCollection files
		const r = store.search({ project: PROJECT, query: 'void', filePattern: '*GarbageCollection*', limit: 10 });
		// Both GarbageCollection.cpp and GarbageCollectionAsync.cpp should match
		assert.ok(r.nodes.length >= 2);
		for (const n of r.nodes) {
			assert.ok(n.filePath!.includes('GarbageCollection'), `unexpected file: ${n.filePath}`);
		}
	});

	test('*.cpp matches all .cpp files', () => {
		const store = buildStoreWithSignatures();
		const r = store.search({ project: PROJECT, query: 'void', filePattern: '*.cpp', limit: 10 });
		assert.strictEqual(r.nodes.length, 3);  // all 3 are .cpp files
	});

	test('*Async.cpp matches only Async file', () => {
		const store = buildStoreWithSignatures();
		const r = store.search({ project: PROJECT, query: 'void', filePattern: '*Async.cpp', limit: 10 });
		assert.strictEqual(r.nodes.length, 1);
		assert.strictEqual(r.nodes[0].name, 'ProcessAsync');
	});

	test('non-matching filePattern returns empty', () => {
		const store = buildStoreWithSignatures();
		const r = store.search({ project: PROJECT, query: 'void', filePattern: '*NonExistent*', limit: 10 });
		assert.strictEqual(r.nodes.length, 0);
	});

	// 回归（2026-07-24）：glob '**' 曾被转成 '.*.*'，连续 `.*` 前缀在每个不匹配
	// 字符串上触发 O(n²) 灾难性回溯——9w+ 节点全表扫描时从毫秒膨胀到数十秒、卡死 UI。
	// _globToRegex 现已折叠连续 `.*` 为单个 `.*`（行为等价、性能数量级提升）。
	test('** globstar produces a collapsed (non-catastrophic) regex', () => {
		// 直接验证 _globToRegex 的输出不含连续 `.*`
		const store: any = new CodebaseGraphStore();
		const re: RegExp = store._globToRegex('**/GarbageCollection*.cpp');
		assert.ok(!re.source.includes('.*.*'),
			`_globToRegex must collapse consecutive '.*' (got "${re.source}")`);
		// 匹配行为：能命中嵌套目录下的 GarbageCollection 文件
		assert.ok(re.test('Source/Runtime/GarbageCollection.cpp'));
		assert.ok(re.test('A/B/C/GarbageCollectionImpl.cpp'));
		assert.ok(!re.test('Source/foo.cpp'));
	});

	test('** globstar search matches nested GarbageCollection files correctly', () => {
		const store = buildStoreWithSignatures();
		const t0 = Date.now();
		const r = store.search({ project: PROJECT, query: 'void', filePattern: '**/GarbageCollection*.cpp', limit: 10 });
		const ms = Date.now() - t0;
		// 正确性：命中所有 GarbageCollection 文件（globstar 跨目录匹配）
		assert.ok(r.nodes.length >= 2);
		for (const n of r.nodes) {
			assert.ok(n.filePath!.includes('GarbageCollection'), `unexpected file: ${n.filePath}`);
		}
		// 性能护栏：折叠后的正则不应出现灾难性回溯（宽松阈值，防回归）
		assert.ok(ms < 2000, `filePattern ** glob scan took ${ms}ms — possible catastrophic backtracking regression`);
	});
});

// ─── searchCode multi-factor ranking + grep truncation ───────────────────────

suite('searchCode multi-factor ranking (2026-07-19)', () => {

	function buildStoreForSearchCode(): CodebaseGraphStore {
		const store = new CodebaseGraphStore();
		// Function node (label=Function, +10 boost) — startLine=1 so line 1 content falls within range
		store.upsertNode({
			project: PROJECT, label: 'Function', name: 'handler', qualifiedName: 'Handler::process',
			filePath: 'src/handler.ts', startLine: 1, endLine: 30,
		});
		// Route node (label=Route, +15 boost) — startLine=1 so line 1 content falls within range
		store.upsertNode({
			project: PROJECT, label: 'Route', name: 'getUser', qualifiedName: 'GET /api/users',
			filePath: 'src/routes/users.ts', startLine: 1, endLine: 15,
		});
		// Function in vendored path (-50 penalty)
		store.upsertNode({
			project: PROJECT, label: 'Function', name: 'vendorFunc', qualifiedName: 'Vendor::func',
			filePath: 'node_modules/lib/func.js', startLine: 1, endLine: 10,
		});
		// Function in test path (-5 penalty)
		store.upsertNode({
			project: PROJECT, label: 'Function', name: 'testFunc', qualifiedName: 'Test::func',
			filePath: 'tests/func.test.ts', startLine: 1, endLine: 10,
		});
		// File nodes (needed for searchCode to iterate)
		store.upsertNode({ project: PROJECT, label: 'file', name: 'handler.ts', qualifiedName: 'handler.ts', filePath: 'src/handler.ts' });
		store.upsertNode({ project: PROJECT, label: 'file', name: 'users.ts', qualifiedName: 'users.ts', filePath: 'src/routes/users.ts' });
		store.upsertNode({ project: PROJECT, label: 'file', name: 'func.js', qualifiedName: 'func.js', filePath: 'node_modules/lib/func.js' });
		store.upsertNode({ project: PROJECT, label: 'file', name: 'func.test.ts', qualifiedName: 'func.test.ts', filePath: 'tests/func.test.ts' });
		return store;
	}

	function makeContentProvider(contents: Record<string, string>) {
		return (filePath: string): string | undefined => contents[filePath];
	}

	test('Route node ranks higher than Function (label +15 vs +10)', () => {
		const store = buildStoreForSearchCode();
		const contents: Record<string, string> = {
			'src/handler.ts': 'function handler() { return "target"; }',
			'src/routes/users.ts': 'route.getUser() { return "target"; }',
			'node_modules/lib/func.js': 'function vendorFunc() { return "target"; }',
			'tests/func.test.ts': 'function testFunc() { return "target"; }',
		};
		const r = searchCode(store, PROJECT, 'target', makeContentProvider(contents), 10, false);
		assert.ok(r.results.length >= 3);
		// Route should rank first (+15 > +10 > -5 > -50)
		const top = r.results[0];
		assert.strictEqual(top.node?.label, 'Route');
	});

	test('vendored path gets -50 penalty (ranks last)', () => {
		const store = buildStoreForSearchCode();
		const contents: Record<string, string> = {
			'src/handler.ts': 'function handler() { return "target"; }',
			'src/routes/users.ts': 'route.getUser() { return "target"; }',
			'node_modules/lib/func.js': 'function vendorFunc() { return "target"; }',
			'tests/func.test.ts': 'function testFunc() { return "target"; }',
		};
		const r = searchCode(store, PROJECT, 'target', makeContentProvider(contents), 10, false);
		// vendored should be last
		const last = r.results[r.results.length - 1];
		assert.ok(last.filePath.includes('node_modules'), `expected node_modules last, got: ${last.filePath}`);
	});

	test('test path gets -5 penalty (ranks above vendored)', () => {
		const store = buildStoreForSearchCode();
		const contents: Record<string, string> = {
			'src/handler.ts': 'function handler() { return "target"; }',
			'node_modules/lib/func.js': 'function vendorFunc() { return "target"; }',
			'tests/func.test.ts': 'function testFunc() { return "target"; }',
		};
		const r = searchCode(store, PROJECT, 'target', makeContentProvider(contents), 10, false);
		// Find test and vendored results
		const testResult = r.results.find(x => x.filePath.includes('tests/'));
		const vendoredResult = r.results.find(x => x.filePath.includes('node_modules/'));
		assert.ok(testResult, 'test result should exist');
		assert.ok(vendoredResult, 'vendored result should exist');
		// test (-5) should rank higher than vendored (-50)
		assert.ok(testResult.relevanceScore > vendoredResult.relevanceScore,
			`test score ${testResult.relevanceScore} should be > vendored ${vendoredResult.relevanceScore}`);
	});

	test('GREP_MAX_MATCHES truncation at 500', () => {
		const store = new CodebaseGraphStore();
		// Create one file node with 600 matching lines
		const lines: string[] = [];
		for (let i = 0; i < 600; i++) { lines.push(`line ${i} target`); }
		store.upsertNode({ project: PROJECT, label: 'file', name: 'big.ts', qualifiedName: 'big.ts', filePath: 'big.ts' });
		store.upsertNode({
			project: PROJECT, label: 'Function', name: 'big', qualifiedName: 'big',
			filePath: 'big.ts', startLine: 1, endLine: 600,
		});
		const contents = { 'big.ts': lines.join('\n') };
		const r = searchCode(store, PROJECT, 'target', makeContentProvider(contents), 1000, false);
		// Should be capped at 500 matches
		assert.strictEqual(r.totalMatches, 500, `expected 500, got ${r.totalMatches}`);
	});

	test('isFileIndexed flag set correctly', () => {
		const store = buildStoreForSearchCode();
		const contents: Record<string, string> = {
			'src/handler.ts': 'target',
			'src/routes/users.ts': 'target',
		};
		const r = searchCode(store, PROJECT, 'target', makeContentProvider(contents), 10, false);
		assert.ok(r.results.length >= 1);
		// All results should have isFileIndexed = true (files have graph nodes)
		for (const res of r.results) {
			assert.strictEqual(res.isFileIndexed, true, `expected isFileIndexed=true for ${res.filePath}`);
		}
	});

	test('defNodesCache: same file multiple matches only queries store once', () => {
		const store = new CodebaseGraphStore();
		store.upsertNode({ project: PROJECT, label: 'file', name: 'multi.ts', qualifiedName: 'multi.ts', filePath: 'multi.ts' });
		store.upsertNode({
			project: PROJECT, label: 'Function', name: 'multi', qualifiedName: 'multi',
			filePath: 'multi.ts', startLine: 1, endLine: 100,
		});
		// 5 matches in same file (all on lines 1-5, within startLine=1 endLine=100)
		const contents = { 'multi.ts': 'target\ntarget\ntarget\ntarget\ntarget' };
		const r = searchCode(store, PROJECT, 'target', makeContentProvider(contents), 10, false);
		// All 5 matches should have the same enclosing node
		assert.strictEqual(r.results.length, 5);
		for (const res of r.results) {
			assert.ok(res.node, 'each match should have enclosing node');
			assert.strictEqual(res.node!.name, 'multi');
		}
	});

	test('searchCode works with capital-F "File" label (C-version graph.db.zst compatibility)', () => {
		const store = new CodebaseGraphStore();
		// C 版索引器用 'File'（大写）而非 'file'（小写）
		store.upsertNode({ project: PROJECT, label: 'File', name: 'GarbageCollection.cpp', qualifiedName: 'GarbageCollection.cpp', filePath: 'Runtime/CoreUObject/Private/UObject/GarbageCollection.cpp' });
		store.upsertNode({
			project: PROJECT, label: 'Function', name: 'PerformReachabilityAnalysis',
			qualifiedName: 'FRealtimeGC::PerformReachabilityAnalysis',
			filePath: 'Runtime/CoreUObject/Private/UObject/GarbageCollection.cpp',
			startLine: 1, endLine: 100,
		});
		const contents = { 'Runtime/CoreUObject/Private/UObject/GarbageCollection.cpp': 'void PerformReachabilityAnalysis() { ProcessObjectArray(); }' };
		const r = searchCode(store, PROJECT, 'ProcessObjectArray', makeContentProvider(contents), 10, false);
		// Should find the match even though file node label is 'File' not 'file'
		assert.ok(r.results.length >= 1, `expected >= 1 result with 'File' label, got ${r.results.length}`);
		assert.strictEqual(r.results[0].node?.name, 'PerformReachabilityAnalysis');
	});
});

// ─── resolveSearchFileUri: C-version absolute filePath (2026-07-19 regression) ──
//
// 日志 vscode-app-1784436919877.log 显示：searchCode 已正确回退到 6046 个带 filePath 的节点，
// 但 query="GC::ProcessAsync" 仍返回 "no matches found"（耗时 4324ms 说明确实在读文件）。
// 根因：C 版 graph.db.zst 把 filePath 存成绝对路径（如 F:/GR_qiuzijian_main/UE5EA/...），
// 而旧代码用 URI.joinPath(rootUri, absolutePath) 把绝对路径当相对路径拼接成垃圾路径，
// 导致 _fileService.exists()=false、文件内容永远读不到。修复后绝对路径直接用 URI.file 解析。

suite('resolveSearchFileUri (C-version absolute filePath, 2026-07-19)', () => {
	const rootUri = URI.file('f:/GR_qiuzijian_main/S1Game');

	test('absolute Windows path is NOT joined onto rootUri (the bug)', () => {
		const abs = 'F:/GR_qiuzijian_main/UE5EA/Engine/Source/Runtime/CoreUObject/GarbageCollection.cpp';
		const uri = resolveSearchFileUri(rootUri, abs);
		const got = uri.fsPath.replace(/\\/g, '/');
		// 必须解析到绝对路径本身，而不能是 rootUri + 垃圾拼接
		assert.strictEqual(got.toLowerCase(), abs.toLowerCase());
		assert.ok(!got.toLowerCase().includes('s1game/f:'));
	});

	test('absolute *nix path is NOT joined onto rootUri', () => {
		const abs = '/home/user/project/src/GarbageCollection.cpp';
		const uri = resolveSearchFileUri(URI.file('/home/user/ws'), abs);
		assert.strictEqual(uri.fsPath.replace(/\\/g, '/'), abs);
	});

	test('relative path IS joined onto rootUri', () => {
		const uri = resolveSearchFileUri(rootUri, 'Engine/Source/foo.cpp');
		assert.strictEqual(
			uri.fsPath.replace(/\\/g, '/').toLowerCase(),
			'f:/GR_qiuzijian_main/S1Game/Engine/Source/foo.cpp'.toLowerCase()
		);
	});

	test('absolute path works when rootUri is undefined', () => {
		const abs = 'F:/x/y/GarbageCollection.cpp';
		const uri = resolveSearchFileUri(undefined, abs);
		assert.strictEqual(uri.fsPath.replace(/\\/g, '/').toLowerCase(), abs.toLowerCase());
	});

	test('relative path falls back to URI.file when rootUri undefined', () => {
		const uri = resolveSearchFileUri(undefined, 'src/foo.cpp');
		// URI.file 对相对路径会基于 cwd 解析，只需保证返回合法 file scheme 且保留文件段
		assert.strictEqual(uri.scheme, 'file');
		assert.ok(uri.fsPath.toLowerCase().includes('foo.cpp'));
	});
});

// ─── searchCode with absolute filePath (end-to-end regression via injected provider) ──
//
// 直接复用 graphSearchCode + 与修复后 searchCode 完全一致的缓存键（fn.filePath=绝对路径），
// 验证「C 版图用绝对 filePath」时搜索能命中（旧实现因 URI 拼错而永远读不到内容）。

suite('searchCode finds match with absolute filePath (2026-07-19 regression)', () => {

	function makeContentProvider(contents: Record<string, string>) {
		return (filePath: string): string | undefined => contents[filePath];
	}

	test('absolute-path Function node is found (no separate file node)', () => {
		const store = new CodebaseGraphStore();
		const absPath = 'F:/GR_qiuzijian_main/UE5EA/Engine/Source/Runtime/CoreUObject/GarbageCollection.cpp';
		// C 版图：Function 节点自带绝对 filePath，没有独立 file 节点 → 触发终极回退
		store.upsertNode({
			project: PROJECT, label: 'Function', name: 'ProcessAsync',
			qualifiedName: 'FRealtimeGC::ProcessAsync',
			filePath: absPath,
			startLine: 1, endLine: 100,
		});
		const contents = { [absPath]: 'void FRealtimeGC::ProcessAsync() { GC::ProcessAsync(Objects); }' };
		const r = searchCode(store, PROJECT, 'GC::ProcessAsync', makeContentProvider(contents), 10, false);
		assert.ok(r.results.length >= 1, `expected >= 1 match for absolute-path graph, got ${r.results.length}`);
		assert.strictEqual(r.results[0].node?.name, 'ProcessAsync');
		assert.strictEqual(r.totalMatches, 1);
	});

	test('mixed absolute + relative paths both found', () => {
		const store = new CodebaseGraphStore();
		const absPath = 'F:/GR_qiuzijian_main/UE5EA/Engine/Source/Runtime/CoreUObject/GarbageCollection.cpp';
		const relPath = 'Runtime/CoreUObject/Private/UObject/Collect.cpp';
		store.upsertNode({
			project: PROJECT, label: 'Function', name: 'ProcessAsync',
			qualifiedName: 'FRealtimeGC::ProcessAsync', filePath: absPath,
			startLine: 1, endLine: 100,
		});
		store.upsertNode({
			project: PROJECT, label: 'Function', name: 'CollectReferences',
			qualifiedName: 'FRealtimeGC::CollectReferences', filePath: relPath,
			startLine: 1, endLine: 100,
		});
		const contents: Record<string, string> = {
			[absPath]: 'void FRealtimeGC::ProcessAsync() { GC::ProcessAsync(); }',
			[relPath]: 'void FRealtimeGC::CollectReferences() { Collect(); }',
		};
		const r = searchCode(store, PROJECT, 'FRealtimeGC', makeContentProvider(contents), 10, false);
		assert.strictEqual(r.results.length, 2);
		const names = new Set(r.results.map(x => x.node?.name));
		assert.ok(names.has('ProcessAsync'));
		assert.ok(names.has('CollectReferences'));
	});
});

// ─── searchCode substring pre-filter (CPU perf guard, 2026-07-19) ──
// 字面量查询：文件内容若完全不含该子串，graphSearchCode 必须跳过逐行正则（直接 continue），
// 避免 6046 个文件 × 逐行 new RegExp().test() 把 CPU 打满。同时验证大小写不敏感。
suite('searchCode substring pre-filter (2026-07-19 CPU guard)', () => {
	function makeContentProvider(contents: Record<string, string>) {
		return (filePath: string): string | undefined => contents[filePath];
	}

	test('literal query is case-insensitive substring matched (no false skip)', () => {
		const store = new CodebaseGraphStore();
		const fp = 'Runtime/GarbageCollection.cpp';
		store.upsertNode({ project: PROJECT, label: 'Function', name: 'ProcessAsync', qualifiedName: 'FRealtimeGC::ProcessAsync', filePath: fp, startLine: 1, endLine: 100 });
		// 内容里是小写 gc::processasync，查询是大写 GC::PROCESSASYNC → 必须命中（大小写不敏感预过滤）
		const contents = { [fp]: 'void FRealtimeGC::ProcessAsync() { gc::processasync(Objects); }' };
		const r = searchCode(store, PROJECT, 'GC::PROCESSASYNC', makeContentProvider(contents), 10, false);
		assert.strictEqual(r.results.length, 1, 'case-insensitive substring pre-filter should NOT skip matching file');
		assert.strictEqual(r.results[0].node?.name, 'ProcessAsync');
	});

	test('literal query NOT present → file contributes nothing (pre-filter skips regex)', () => {
		const store = new CodebaseGraphStore();
		const fp = 'Runtime/GarbageCollection.cpp';
		store.upsertNode({ project: PROJECT, label: 'Function', name: 'ProcessAsync', qualifiedName: 'FRealtimeGC::ProcessAsync', filePath: fp, startLine: 1, endLine: 100 });
		// 内容完全不含 "GC::ProcessAsync"
		const contents = { [fp]: 'void OtherFunc() { DoWork(); }' };
		const r = searchCode(store, PROJECT, 'GC::ProcessAsync', makeContentProvider(contents), 10, false);
		assert.strictEqual(r.results.length, 0, 'absent literal query must yield no matches');
		assert.strictEqual(r.totalMatches, 0);
	});

	test('useRegex=true → no substring pre-filter (regex may match partial tokens)', () => {
		const store = new CodebaseGraphStore();
		const fp = 'Runtime/GarbageCollection.cpp';
		store.upsertNode({ project: PROJECT, label: 'Function', name: 'ProcessAsync', qualifiedName: 'FRealtimeGC::ProcessAsync', filePath: fp, startLine: 1, endLine: 100 });
		// 子串 "ProcessAsync" 存在，但用正则 \bProcessAsync\b 验证仍能命中
		const contents = { [fp]: 'void FRealtimeGC::ProcessAsync() { GC::ProcessAsync(Objects); }' };
		const r = searchCode(store, PROJECT, '\\bProcessAsync\\b', makeContentProvider(contents), 10, true);
		assert.strictEqual(r.results.length, 1, 'regex mode must still search and match');
	});
});

// ─── resolveSearchFileCandidates: multi-folder workspace (2026-07-19 regression) ──
//
// 日志 vscode-app-1784438761233.log 显示工作区有 2 个 folder：
//   target[0] = f:\GR_qiuzijian_main\S1Game   (name="VsSaros_S1Game")
//   target[1] = f:\GR_qiuzijian_main\UE5EA     (name="UE5EA")
// 旧实现 searchCode 只用 folders[0].uri 拼相对路径，导致 UE5EA 引擎文件
// （相对路径相对 UE5EA 根）被拼到 S1Game 根下 → 路径错误 → exists()=false →
// 文件永远读不到 → search_code 静默返回 "no matches found"。
// 修复：相对路径依次尝试每个 workspace folder，调用方取首个 exists() 的。

suite('resolveSearchFileCandidates (multi-folder workspace, 2026-07-19)', () => {
	const s1game = URI.file('f:/GR_qiuzijian_main/S1Game');
	const ue5ea = URI.file('f:/GR_qiuzijian_main/UE5EA');
	const roots = [s1game, ue5ea];

	test('relative path is tried against EVERY folder (not just folder[0])', () => {
		const rel = 'Engine/Source/Runtime/CoreUObject/GarbageCollection.cpp';
		const candidates = resolveSearchFileCandidates(roots, rel);
		// 应为 2 个候选：分别拼到 S1Game 与 UE5EA
		assert.strictEqual(candidates.length, 2);
		assert.strictEqual(
			candidates[0].fsPath.replace(/\\/g, '/').toLowerCase(),
			'f:/GR_qiuzijian_main/S1Game/Engine/Source/Runtime/CoreUObject/GarbageCollection.cpp'.toLowerCase()
		);
		assert.strictEqual(
			candidates[1].fsPath.replace(/\\/g, '/').toLowerCase(),
			'f:/GR_qiuzijian_main/UE5EA/Engine/Source/Runtime/CoreUObject/GarbageCollection.cpp'.toLowerCase()
		);
	});

	test('absolute path returns a SINGLE candidate (ignores folder list)', () => {
		const abs = 'F:/GR_qiuzijian_main/UE5EA/Engine/Source/Runtime/CoreUObject/GarbageCollection.cpp';
		const candidates = resolveSearchFileCandidates(roots, abs);
		assert.strictEqual(candidates.length, 1);
		assert.strictEqual(candidates[0].fsPath.replace(/\\/g, '/').toLowerCase(), abs.toLowerCase());
	});

	test('no folders → absolute path still resolves via URI.file', () => {
		const abs = 'F:/x/y/GarbageCollection.cpp';
		const candidates = resolveSearchFileCandidates([], abs);
		assert.strictEqual(candidates.length, 1);
		assert.strictEqual(candidates[0].fsPath.replace(/\\/g, '/').toLowerCase(), abs.toLowerCase());
	});

	test('no folders → relative path falls back to URI.file (cwd-based)', () => {
		const candidates = resolveSearchFileCandidates([], 'src/foo.cpp');
		assert.strictEqual(candidates.length, 1);
		assert.strictEqual(candidates[0].scheme, 'file');
	});
});

// ─── 说明：searchCode 的多 folder 解析发生在 CodebaseGraphService.searchCode 内 ──
// （_resolveSearchFileCandidates → 对每个候选 URI 调用 _fileService.exists，取首个存在者读盘）。
// 该逻辑依赖完整 service（DI: fileService/workspaceService），无法在轻量单测中实例化；
// 其纯函数核心 resolveSearchFileCandidates 已在上一个 suite 充分覆盖。
// 旧行为（只拼 folders[0].uri）会在「UE5EA 引擎文件相对路径相对 UE5EA 根」时拼错路径，
// 导致 exists()=false → 文件读不到 → search_code 静默 "no matches found"（见 1784438761233.log）。

// ─── 多 folder 图索引：store 层合并 + 跨项目检索（2026-07-19 实现） ────────────────
//
// 多 folder 工作区（S1Game + UE5EA）：每个 folder 独立持久化 graph.db.zst（项目名=folder 名），
// 启动时 mergeFromJSONAsync 合并进同一内存 store（ID 重映射 + 项目名覆盖），检索跨所有项目。

suite('multi-folder graph index (store merge + cross-project, 2026-07-19)', () => {

	function buildProjectStore(project: string, prefix: string): CodebaseGraphStore {
		const store = new CodebaseGraphStore();
		store.upsertNode({ project, label: 'file', name: `${prefix}.cpp`, qualifiedName: `${prefix}.cpp`, filePath: `${prefix}.cpp` });
		const fn = store.upsertNode({ project, label: 'Function', name: `${prefix}Func`, qualifiedName: `${prefix}::${prefix}Func`, filePath: `${prefix}.cpp`, startLine: 1, endLine: 5 });
		const cls = store.upsertNode({ project, label: 'Class', name: `${prefix}Class`, qualifiedName: `${prefix}::${prefix}Class`, filePath: `${prefix}.cpp`, startLine: 6, endLine: 20 });
		store.insertEdge({ project, sourceId: cls.id, targetId: fn.id, type: 'CONTAINS' });
		return store;
	}

	test('toJSON(project) only serializes that project; mergeFromJSONAsync appends without clearing', async () => {
		// 两个 folder 各自的独立 store（模拟各自 graph.db.zst）
		const s1 = buildProjectStore('S1Game', 's1');
		const ue = buildProjectStore('UE5EA', 'ue');

		const s1data = s1.toJSON('S1Game');
		const uedata = ue.toJSON('UE5EA');
		// project 范围导出省略 bm25（合并后由调用方 rebuildBM25）
		assert.strictEqual(s1data.bm25, undefined);
		assert.strictEqual(s1data.nodes.length, 3);

		// 合并进同一内存 store（模拟 bootstrap）
		const merged = new CodebaseGraphStore();
		await merged.mergeFromJSONAsync(s1data, 'S1Game');
		await merged.mergeFromJSONAsync(uedata, 'UE5EA');
		await merged.rebuildBM25();

		// 两个项目共存
		const projects = merged.listProjects().map(p => p.name).sort();
		assert.deepStrictEqual(projects, ['S1Game', 'UE5EA']);
		assert.strictEqual(merged.getNodeCount(), 6);
	});

	test('mergeFromJSONAsync remaps node/edge IDs to avoid collision', async () => {
		const a = buildProjectStore('A', 'a');
		const b = buildProjectStore('B', 'b');
		// 两个 store 的自增 id 都从 1 开始 → 未重映射会冲突
		const merged = new CodebaseGraphStore();
		await merged.mergeFromJSONAsync(a.toJSON('A'), 'A');
		await merged.mergeFromJSONAsync(b.toJSON('B'), 'B');
		// 6 个节点各自唯一 id（无覆盖）
		assert.strictEqual(merged.getAllNodes().length, 6);
		const ids = new Set(merged.getAllNodes().map(n => n.id));
		assert.strictEqual(ids.size, 6);
		// 边端点仍指向有效节点（无悬空）
		for (const e of merged.getAllEdges()) {
			assert.ok(merged.getNode(e.sourceId), 'edge source must exist after remap');
			assert.ok(merged.getNode(e.targetId), 'edge target must exist after remap');
		}
	});

	test('getAllFileNodes() spans all projects; single-project arg limits scope', async () => {
		const merged = new CodebaseGraphStore();
		await merged.mergeFromJSONAsync(buildProjectStore('S1Game', 's1').toJSON('S1Game'), 'S1Game');
		await merged.mergeFromJSONAsync(buildProjectStore('UE5EA', 'ue').toJSON('UE5EA'), 'UE5EA');

		const all = merged.getAllFileNodes();
		assert.strictEqual(all.length, 2, 'should find file node from both folders');
		const one = merged.getAllFileNodes('UE5EA');
		assert.strictEqual(one.length, 1);
		assert.strictEqual(one[0].project, 'UE5EA');
	});

	test('findNodeByQNAnyProject finds qn across folders', async () => {
		const merged = new CodebaseGraphStore();
		await merged.mergeFromJSONAsync(buildProjectStore('S1Game', 's1').toJSON('S1Game'), 'S1Game');
		await merged.mergeFromJSONAsync(buildProjectStore('UE5EA', 'ue').toJSON('UE5EA'), 'UE5EA');

		// 当前项目查不到 → 跨项目回退命中
		assert.strictEqual(merged.findNodeByQN('S1Game', 'ue::ueFunc'), undefined);
		const found = merged.findNodeByQNAnyProject('ue::ueFunc');
		assert.ok(found);
		assert.strictEqual(found!.project, 'UE5EA');
	});

	test('searchCode with empty project searches across all folders', async () => {
		const merged = new CodebaseGraphStore();
		await merged.mergeFromJSONAsync(buildProjectStore('S1Game', 's1').toJSON('S1Game'), 'S1Game');
		await merged.mergeFromJSONAsync(buildProjectStore('UE5EA', 'ue').toJSON('UE5EA'), 'UE5EA');

		// 文件内容：s1.cpp 与 ue.cpp 各含关键字 "TARGET"
		const contents: Record<string, string> = {
			's1.cpp': 'void s1Func() { TARGET_MARK(); }',
			'ue.cpp': 'void ueFunc() { TARGET_MARK(); }',
		};
		const provider = (fp: string): string | undefined => contents[fp];

		// 空 project → 跨所有 folder（应同时命中 s1.cpp 与 ue.cpp）
		const res = searchCode(merged, '', 'TARGET_MARK', provider, 50, false);
		const files = new Set(res.results.map(r => r.filePath));
		assert.ok(files.has('s1.cpp'), 'should hit S1Game file');
		assert.ok(files.has('ue.cpp'), 'should hit UE5EA file');

		// 指定单项目 → 仅该 folder
		const only = searchCode(merged, 'UE5EA', 'TARGET_MARK', provider, 50, false);
		const onlyFiles = new Set(only.results.map(r => r.filePath));
		assert.ok(onlyFiles.has('ue.cpp'));
		assert.ok(!onlyFiles.has('s1.cpp'));
	});
});
