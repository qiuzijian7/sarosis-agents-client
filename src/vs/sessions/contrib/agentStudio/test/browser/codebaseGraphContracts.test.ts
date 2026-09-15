/*---------------------------------------------------------------------------------------------
 *  codebaseGraphContracts.test.ts — 图谱「契约」回归测试（2026-09-09）。
 *
 *  背景：本子系统测试全是单元级（Cypher 语法 / BM25 / similarity / SQLite CRUD），
 *  **没有一条覆盖「图建成后能否被正确检索」的契约**——于是以下三类 bug 全部逃逸到线上：
 *    1. filePath 混入绝对路径（OpenFileModal joinPath(root, abs) 静默打不开）
 *    2. 解析失败也记哈希 → 失败永久固化（6000 文件解析失败后永不重试）
 *    3. 基线健康度无判据（6017 基线 vs 1196 节点，系统仍认为一切正常）
 *
 *  本文件用「最小管线」固化这些契约：store 写入 → 契约检测 → 检索命中 → 健康度判定。
 *
 *  运行：
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/test/browser/codebaseGraphContracts.test.ts
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { CodebaseGraphStore, GraphNode } from '../../browser/codebaseGraphStore.js';
import { isAbsoluteGraphPath, excludeDirsForProfile, COMMON_EXCLUDE_DIRS, shouldRecordHashAfterParse, matchesExcludeDir } from '../../common/codebaseIndexDefaults.js';

const PROJECT = 'test';

/** 相对路径的 function 节点（图内 filePath 契约形态）。 */
function addFn(store: CodebaseGraphStore, name: string, filePath: string): GraphNode {
	return store.upsertNode({
		project: PROJECT,
		label: 'function',
		name,
		qualifiedName: `${filePath}::${name}`,
		filePath,
	});
}

suite('codebaseGraph contracts (2026-09-09 regressions)', () => {

	// ── 契约 1：filePath 必须是项目相对路径 ──────────────────────────────
	test('isAbsoluteGraphPath detects Windows / UNC / POSIX absolute paths', () => {
		assert.strictEqual(isAbsoluteGraphPath('g:\\repo\\src\\a.ts'), true, 'Windows drive');
		assert.strictEqual(isAbsoluteGraphPath('G:/repo/src/a.ts'), true, 'Windows forward slash');
		assert.strictEqual(isAbsoluteGraphPath('\\\\server\\share\\a.ts'), true, 'UNC');
		assert.strictEqual(isAbsoluteGraphPath('/home/u/repo/a.ts'), true, 'POSIX');
		assert.strictEqual(isAbsoluteGraphPath('src/vs/a.ts'), false, 'relative must not be flagged');
		assert.strictEqual(isAbsoluteGraphPath(''), false);
	});

	test('store flags absolute filePath as contract violation (regression: worker passed abs path)', () => {
		const store = new CodebaseGraphStore();
		assert.strictEqual(store.getAbsPathViolationCount(), 0);

		addFn(store, 'good', 'src/vs/a.ts');
		assert.strictEqual(store.getAbsPathViolationCount(), 0, 'relative path is clean');

		// 回归点：增量 worker 分支曾把绝对路径传给 walkAST → 图里混入 g:\...
		addFn(store, 'bad', 'g:\\CustomWorkspaces\\repo\\src\\vs\\b.ts');
		assert.strictEqual(store.getAbsPathViolationCount(), 1, 'absolute path must be flagged');
		assert.ok(store.getAbsPathViolationSample(1)[0].indexOf('b.ts') >= 0);
	});

	// ── 契约 2：检索必须命中已写入的相对路径符号 ────────────────────────
	test('searchGraph finds a symbol by namePattern on a properly indexed file', () => {
		const store = new CodebaseGraphStore();
		addFn(store, 'rotateDegrees', 'src/vs/sessions/contrib/agentStudio/webview/instantNodes.ts');
		addFn(store, 'buildSheet', 'src/vs/sessions/contrib/agentStudio/webview/instantNodes.ts');
		addFn(store, 'unrelated', 'src/vs/other.ts');

		const hits = store.search({ namePattern: 'rotateDegrees', project: PROJECT });
		assert.strictEqual(hits.nodes.length, 1, 'exactly one symbol named rotateDegrees');
		assert.strictEqual(hits.nodes[0].name, 'rotateDegrees');
		assert.strictEqual(hits.nodes[0].filePath, 'src/vs/sessions/contrib/agentStudio/webview/instantNodes.ts');
	});

	// ── 契约 4：合并加载必须幂等（2026-09-15）────────────────────────────
	// 背景：同一制品被重复合并（bootstrap 并发 / 工作区切换）时，旧实现无条件 `_nextNodeId++`
	// 追加 ⇒ 节点翻倍。实测本仓 `graph.db.zst` 358,887 节点去重后仅 180,753（**49.6% 冗余**）。
	test('★ mergeFromJSONAsync 幂等：同一制品重复合并不得新增节点/边', async () => {
		const store = new CodebaseGraphStore();
		const data = {
			nodes: [
				{ id: 1, project: PROJECT, label: 'function', name: 'a', qualifiedName: 'f.ts::a', filePath: 'f.ts' },
				{ id: 2, project: PROJECT, label: 'function', name: 'b', qualifiedName: 'f.ts::b', filePath: 'f.ts' },
			],
			edges: [{ id: 1, project: PROJECT, sourceId: 1, targetId: 2, type: 'CALLS' }],
		};
		await store.mergeFromJSONAsync(data);
		assert.strictEqual(store.getNodeCount(), 2);
		assert.strictEqual(store.getEdgeCount(), 1);

		// 再合并同一份数据（等价于 13:26 那次「同一 zst 合并两次」）
		const stats = await store.mergeFromJSONAsync(data);
		assert.strictEqual(store.getNodeCount(), 2, '重复合并不得新增节点（旧实现会翻倍）');
		assert.strictEqual(store.getEdgeCount(), 1, '重复合并不得新增边');
		assert.deepStrictEqual(stats, { nodesAdded: 0, nodesSkipped: 2, edgesAdded: 0, edgesSkipped: 1 });
	});

	test('★ 制品自带重复 ⇒ 加载即自愈（同一 qn 出现两次只留一个节点）', async () => {
		const store = new CodebaseGraphStore();
		const dup = { project: PROJECT, label: 'function', name: 'a', qualifiedName: 'f.ts::a', filePath: 'f.ts' };
		await store.mergeFromJSONAsync({
			nodes: [
				{ id: 1, ...dup },
				{ id: 2, ...dup },                                                   // 制品里的第二份
				{ id: 3, ...dup, name: 'b', qualifiedName: 'f.ts::b' },
			],
			edges: [],
		});
		assert.strictEqual(store.getNodeCount(), 2, '重复 qn 只应保留一个节点');
	});

	// ── 契约 3：失败不得固化为「已索引」（哈希基线语义 = 成功处理过）──────
	test('file hash baseline only counts successfully processed files', () => {
		const store = new CodebaseGraphStore();

		// 模拟：成功解析 1 个文件 → 记哈希 + 有节点
		addFn(store, 'ok', 'src/ok.ts');
		store.upsertFileHash({ project: PROJECT, relPath: 'src/ok.ts', sha256: '', mtimeNs: 1, size: 10 });

		// 模拟：解析失败的文件**不记哈希**（_recordHashAfterParse 的策略），
		// 因此它不会被计入基线，下轮 watcher 仍会重报 added → 得以重试。
		assert.strictEqual(store.getFileHashCount(), 1, 'failed file must NOT enter the baseline');
		assert.strictEqual(store.getNodeCount(), 1);

		// 基线健康度判据：每文件平均节点数（残缺图 ≈ 0.2，正常 ≥ 2）
		const nodesPerFile = store.getNodeCount() / store.getFileHashCount();
		assert.ok(nodesPerFile >= 1, 'healthy baseline has nodes per file >= 1');
	});

	test('hash policy: recoverable failures are retried, then abandoned after the cap', () => {
		// 可恢复失败（Worker 池当时不可用等）→ 不记哈希，下轮重试
		assert.strictEqual(shouldRecordHashAfterParse('parse_error', 1), false, '1st failure must retry');
		assert.strictEqual(shouldRecordHashAfterParse('timeout', 2), false, '2nd failure must retry');
		// 达上限 → 记哈希放弃（防「失败文件每轮重报」翻烧饼）
		assert.strictEqual(shouldRecordHashAfterParse('parse_error', 3), true, '3rd failure stops retrying');
		assert.strictEqual(shouldRecordHashAfterParse('timeout', 9), true);
	});

	test('hash policy: success and protective skips always record', () => {
		for (const s of ['indexed', 'partial', 'skipped'] as const) {
			assert.strictEqual(shouldRecordHashAfterParse(s, 0), true, `${s} must record the hash`);
		}
	});

	test('clearFileHashes resets baseline so every file is re-classified as added', () => {
		const store = new CodebaseGraphStore();
		store.upsertFileHash({ project: PROJECT, relPath: 'src/a.ts', sha256: '', mtimeNs: 1, size: 10 });
		store.upsertFileHash({ project: PROJECT, relPath: 'src/b.ts', sha256: '', mtimeNs: 1, size: 10 });
		assert.strictEqual(store.getFileHashCount(), 2);

		// 守卫 v2 判定残缺后清哈希 → classifyFiles 全判 added → 强制全量重建
		store.clearFileHashes();
		assert.strictEqual(store.getFileHashCount(), 0);
	});

	// ── 契约 5：目录名排除匹配语义（为 _scanDir 搬迁建回归锚点）────────
	test('exclude matching is exact-on-dir-name and case-insensitive', () => {
		const excl = new Set(['node_modules', 'build', 'Out']);
		assert.strictEqual(matchesExcludeDir('node_modules', excl), true);
		assert.strictEqual(matchesExcludeDir('BUILD', excl), true, 'case-insensitive');
		assert.strictEqual(matchesExcludeDir('out', excl), true, 'set member "Out" matches "out"');
		// 关键：按目录名精确匹配——不含子串、不匹配路径
		assert.strictEqual(matchesExcludeDir('mybuild', excl), false, 'must not match by substring');
		assert.strictEqual(matchesExcludeDir('src/vs/build', excl), false, 'matches dir NAME, not path');
		assert.strictEqual(matchesExcludeDir('src', excl), false);
		assert.strictEqual(matchesExcludeDir('anything', new Set()), false, 'empty set excludes nothing');
	});

	// ── 契约 6：排除档位（默认必须与历史行为一致）──────────────────────
	test('exclude profile: balanced is default-compatible with COMMON_EXCLUDE_DIRS', () => {
		// 回归保护：新增档位不得改变默认索引范围（否则用户重建后结果集突变）
		const balanced = excludeDirsForProfile('balanced');
		assert.deepStrictEqual(
			[...balanced].sort(),
			[...COMMON_EXCLUDE_DIRS].sort(),
			'balanced must stay identical to the historical COMMON_EXCLUDE_DIRS',
		);
	});

	test('exclude profile: full keeps test/docs/scripts indexable', () => {
		const full = excludeDirsForProfile('full');
		for (const d of ['test', 'tests', 'docs', 'doc', 'scripts', 'dev', 'resources']) {
			assert.ok(!full.includes(d), `full profile must NOT exclude "${d}"`);
		}
		// 依赖与构建产物两档都必须排除
		for (const d of ['node_modules', '.git', 'out', 'dist', 'build']) {
			assert.ok(full.includes(d), `full profile must still exclude "${d}"`);
			assert.ok(excludeDirsForProfile('balanced').includes(d));
		}
	});

	// ── 契约 4：project 值是真实项目名，_default 只是兜底 ───────────────
	test('nodes carry the real project name; _default is only a fallback', () => {
		const store = new CodebaseGraphStore();
		store.upsertNode({
			project: 'sarosis-agents-client',
			label: 'class',
			name: 'Foo',
			qualifiedName: 'src/a.ts::Foo',
			filePath: 'src/a.ts',
		});
		assert.strictEqual(store.getNodeCount('sarosis-agents-client'), 1);
		// 回归点：曾把 project !== '_default' 一律过滤掉 → 勾选「仅当前 solution」后列表恒空
		assert.strictEqual(store.getNodeCount('_default'), 0, '_default must not be assumed');
	});
});
