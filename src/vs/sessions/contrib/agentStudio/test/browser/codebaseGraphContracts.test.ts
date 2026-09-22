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
import * as fs from 'fs';
import * as path from 'path';
import { CodebaseGraphStore, GraphNode } from '../../browser/codebaseGraphStore.js';
import { isAbsoluteGraphPath, excludeDirsForProfile, COMMON_EXCLUDE_DIRS, shouldRecordHashAfterParse, matchesExcludeDir, shouldDeferGraphLoad, planForeignProjectPrune } from '../../common/codebaseIndexDefaults.js';
import { SLICE_BUDGET_MS, SLICE_CHECK_EVERY, sliceBudgetExceeded, yieldToEventLoop } from '../../common/asyncSlice.js';

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

	// ── 契约 4b：基线判据/清理必须**按项目**（2026-09-21，安装版 UE 95k 实证）────
	//
	// 真机链：UE 工作区 ~~9547 节点 / 95532 哈希~~ 被判「残缺」⇒ 触发**清哈希 + 95k 文件全量重索引**
	// （内存暴涨、与解析期看门狗 abort 互相打架）。而 store 里多项目共享（同一 Session 内含本仓 + UE），
	// 旧实现读**全库**计数、清**全库**哈希 ⇒ 一个坏项目把**健康项目**也拖进全量重建 ✗✗。
	test('★★ 基线判据/清理必须按项目 —— 坏项目不得拖累健康项目', () => {
		const store = new CodebaseGraphStore();
		// 健康项目 test：2 个文件 × 2 节点（每文件 2 个 ⇒ 不残缺）
		addFn(store, 'a1', 'src/a.ts'); addFn(store, 'a2', 'src/a.ts');
		addFn(store, 'b1', 'src/b.ts'); addFn(store, 'b2', 'src/b.ts');
		store.upsertFileHash({ project: PROJECT, relPath: 'src/a.ts', sha256: '', mtimeNs: 1, size: 10 });
		store.upsertFileHash({ project: PROJECT, relPath: 'src/b.ts', sha256: '', mtimeNs: 1, size: 10 });
		// 坏项目 ue：有哈希**无节点**（解析大面积失败被固化 —— deficient 的典型形态）
		store.upsertFileHash({ project: 'ue', relPath: 'src/x.ts', sha256: '', mtimeNs: 1, size: 10 });

		assert.strictEqual(store.getNodeCount(PROJECT), 4);
		assert.strictEqual(store.getFileHashCount(PROJECT), 2, '必须支持按项目计数 ✓');
		assert.strictEqual(store.getFileHashCount('ue'), 1);
		assert.strictEqual(store.getFileHashCount(), 3, '不传参仍是全库（向后兼容 ✓）');

		// 清「坏项目」：健康项目的基线必须原样保留 ✗✓
		store.clearFileHashes('ue');
		assert.strictEqual(store.getFileHashCount('ue'), 0, '坏项目应被清空（触发它自己的全量重建）');
		assert.strictEqual(store.getFileHashCount(PROJECT), 2, '清一个项目**不得**动到另一个项目 ✗✗');
		assert.strictEqual(store.getNodeCount(PROJECT), 4, '清哈希不得动节点');
	});

	// ── 契约 4c：gaveUp 哈希不得当作「成功索引过」（2026-09-21，UE 95k 实证）────
	//
	// 解析失败达上限也会记哈希（为停"每轮重报 added"的翻烧饼 ✓），但那些文件**没有节点** ✗。
	// 旧判据把它们当成功基线 ⇒ `4547 节点 / 95532 哈希 < 2` ⇒ 判残缺 ⇒ **95k 文件全量重索引** ✗✗。
	test('★★ gaveUp 哈希：仍算基线（防翻烧饼），但不计入健康度分母', () => {
		const store = new CodebaseGraphStore();
		addFn(store, 'ok1', 'src/ok.ts'); addFn(store, 'ok2', 'src/ok.ts');
		store.upsertFileHash({ project: PROJECT, relPath: 'src/ok.ts', sha256: '', mtimeNs: 1, size: 10 });
		// 3 个"放弃"哈希（解析失败被固化 —— 无节点）
		for (const p of ['x', 'y', 'z']) {
			store.upsertFileHash({ project: PROJECT, relPath: `src/${p}.ts`, sha256: '', mtimeNs: 1, size: 10, gaveUp: true });
		}

		assert.strictEqual(store.getFileHashCount(PROJECT), 4, '总数含 gaveUp（增量基线口径 ✓）');
		assert.strictEqual(store.getGaveUpFileHashCount(PROJECT), 3, '必须能单独数出放弃数');
		assert.strictEqual(store.getOkFileHashCount(PROJECT), 1, '成功份 = 总数 − 放弃数 ✓');

		// 健康度：用"成功份"当分母 ⇒ 2 节点 / 1 文件 = 2 ⇒ 不残缺 ✓（旧口径 2/4 = 0.5 ⇒ 误判残缺 ✗✗）
		const nodesPerFile = store.getNodeCount(PROJECT) / store.getOkFileHashCount(PROJECT);
		assert.ok(nodesPerFile >= 2, `按成功份算应健康，实际 ${nodesPerFile}`);
	});

	// ── 契约 4d：分批清哈希必须**轮转覆盖**（2026-09-21，超大仓修复）────────
	//
	// 真机（UE 9.5 万文件）：一次清光 ⇒ 全量解析 ⇒ 内存撞硬上限被中止 ⇒ 永不收敛 ✗。
	// 分批的前提是「每轮取**下一批**」——靠 Map 插入顺序 + "被清者重解析后追加到末尾"实现 ✓。
	// 若哪天有人改成"清最后 N 个"或"随机 N 个"，就会**反复清同一批** ⇒ 永远修不完 ✗✗ ⇒ 必须钉住。
	test('★★ 分批清哈希必须轮转覆盖（不清光、每轮轮到下一批、不跨项目）', () => {
		const store = new CodebaseGraphStore();
		for (const p of ['a', 'b', 'c', 'd', 'e']) {
			store.upsertFileHash({ project: PROJECT, relPath: `src/${p}.ts`, sha256: '', mtimeNs: 1, size: 10 });
		}
		// 另一个项目（UE 那类）：不得被本项目的修复波及 ✗
		store.upsertFileHash({ project: 'ue', relPath: 'src/x.ts', sha256: '', mtimeNs: 1, size: 10 });

		// 第 1 轮：清 2 个（按插入序 ⇒ a, b）
		assert.strictEqual(store.clearFileHashesBounded(PROJECT, 2), 2);
		assert.strictEqual(store.getFileHash(PROJECT, 'src/a.ts'), undefined);
		assert.strictEqual(store.getFileHash(PROJECT, 'src/b.ts'), undefined);

		// 模拟"重解析后哈希追加到末尾"（真实路径就是这样）
		for (const p of ['a', 'b']) {
			store.upsertFileHash({ project: PROJECT, relPath: `src/${p}.ts`, sha256: '', mtimeNs: 2, size: 11 });
		}

		// 第 2 轮：必须轮到 **c, d**（不得又清刚重解析的 a, b ✗）
		assert.strictEqual(store.clearFileHashesBounded(PROJECT, 2), 2);
		assert.strictEqual(store.getFileHash(PROJECT, 'src/c.ts'), undefined, '第 2 轮应轮到下一批 ✓');
		assert.strictEqual(store.getFileHash(PROJECT, 'src/d.ts'), undefined);
		assert.ok(store.getFileHash(PROJECT, 'src/a.ts') !== undefined, '刚重解析的那批不得被立刻再清 ✗✗');

		// 第 3 轮：剩下的一把清完（e, a, b）
		assert.strictEqual(store.clearFileHashesBounded(PROJECT, 99), 3);
		assert.strictEqual(store.getFileHashCount(PROJECT), 0);

		// 全程未动别的项目 ✓
		assert.strictEqual(store.getFileHashCount('ue'), 1, '分批清理必须严格限定在目标项目 ✗');
		// 边界：limit<=0 ⇒ 不清（防「配置填 0 被误当成清光」✗）
		assert.strictEqual(store.clearFileHashesBounded('ue', 0), 0);
		assert.strictEqual(store.getFileHashCount('ue'), 1, 'limit=0 不得清任何东西 ✗');
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

/**
 * 非主 root 大图的**延迟加载**判据（2026-09-15 用户裁决「方案 C」）。
 *
 * 事故：`_bootstrap()` 无条件加载所有 folder 的图 ⇒ 切到「含大图非主 root」的工作区
 * 整窗卡死数十秒（实测 UE5EA 24.6MB / 87.6 万节点 —— 而它只是 S1Game 工作区的**非主** root，
 * 默认检索作用域根本到不了它）。修法：非主 root 超过阈值 ⇒ 延迟到真正用到时再加载。
 */
suite('方案 C — 非主 root 大图延迟加载判据', () => {

	const MB = 1024 * 1024;

	test('★★★ 主 root 永不延迟（它就是默认检索作用域）', () => {
		// 实测：sarosis 主 root 8.2MB、S1Game 主 root 7MB —— 都超默认阈值 5MB，
		// 但延迟它们等于让「首次查询」直接缺数据。
		assert.strictEqual(shouldDeferGraphLoad(0, Math.round(8.2 * MB), 5), false);
		assert.strictEqual(shouldDeferGraphLoad(0, 100 * MB, 5), false);
	});

	test('★★★ 非主 root 超过阈值 ⇒ 延迟（本事故主角：UE5EA 24.6MB）', () => {
		assert.strictEqual(
			shouldDeferGraphLoad(1, Math.round(24.6 * MB), 5),
			true,
			'UE5EA（S1Game 工作区的非主 root）必须被延迟',
		);
	});

	test('★ 非主 root 未超阈值 ⇒ 照常加载（小图不影响检索完整性）', () => {
		// 实测：sarosis 的两个非主 root（Saros-agents-pocket / saros-marketplace）≈ 0MB
		assert.strictEqual(shouldDeferGraphLoad(1, 0, 5), false);
		assert.strictEqual(shouldDeferGraphLoad(1, 4 * MB, 5), false);
		// 边界：**等于**阈值不延迟（判据是严格大于）
		assert.strictEqual(shouldDeferGraphLoad(1, 5 * MB, 5), false);
	});

	test('★★ 阈值 <= 0 ⇒ 关闭延迟，保持旧行为（打开工作区即加载全部）', () => {
		assert.strictEqual(shouldDeferGraphLoad(1, 100 * MB, 0), false);
		assert.strictEqual(shouldDeferGraphLoad(1, 100 * MB, -1), false);
	});

	test('★★ 已延迟的保持延迟（幂等：folder 事件重复触发不会把它加载回来）', () => {
		assert.strictEqual(
			shouldDeferGraphLoad(1, 0, 5, true),
			true,
			'已在延迟集合 ⇒ 保持，不再 stat / 不再改判',
		);
	});

	test('★ 读不到大小（size=0）不延迟 —— 与「文件不存在 ⇒ 不延迟、走原逻辑」一致', () => {
		assert.strictEqual(shouldDeferGraphLoad(2, 0, 5), false);
	});
});

/**
 * 顺序不变量（**源码级**）：延迟加载必须在「无图 ⇒ 对全部 folder 建索引」的判定**之前**触发。
 *
 * 为什么必须源码级：这是**调用顺序**契约 —— 纯函数判据测不到它，而顺序错了就会绕过延迟加载、
 * 直接对超大图谱触发一次全量重建（正是方案 C 要避免的重活；`_bootstrap()` 里也有一条同源教训：
 * 「artifact 存在但加载失败 ⇒ 跳过自动索引」，都是为了别对超大/损坏图谱反复重建）。
 */
suite('方案 C — 「先补延迟图、再判有无图」顺序不变量', () => {

	const TOOLS = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/codebaseTools.ts';
	const DELEG = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/delegationTools.ts';

	/**
	 * 剥注释 —— 源码级顺序断言必须只看代码。
	 *
	 * ⚠ 本轮实测踩到：我在 `codebaseTools` 里加的**说明注释**本身就写了「必须放在
	 * `hasGraphData()` 判定之前」⇒ `indexOf('hasGraphData()')` 命中的是**注释**，
	 * 位置在任何调用之前 ⇒ 断言假失败。同一坑本套件与 `guardrailWiring` 都记过。
	 */
	const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
	const readSrc = (rel: string) => stripComments(fs.readFileSync(path.join(process.cwd(), rel), 'utf8'));

	test('★ codebase 工具预检：ensureDeferredGraphsLoaded 必须早于 hasGraphData()', () => {
		const src = readSrc(TOOLS);
		const idx = src.indexOf('const ensureGraph = async ()');
		assert.ok(idx > 0, '应能找到 ensureGraph()');
		const body = src.slice(idx, idx + 900);
		// 用带点的调用形态锚定，避开任何残留文字命中。
		const deferAt = body.indexOf('ensureDeferredGraphsLoaded(');
		const hasAt = body.indexOf('.hasGraphData()');
		assert.ok(deferAt > 0, '必须触发延迟加载');
		assert.ok(hasAt > 0, '应保留 hasGraphData() 判定');
		assert.ok(deferAt < hasAt, '延迟加载必须早于 hasGraphData() —— 否则会绕开延迟直接全量重建');
	});

	test('★ 子代理预检：ensureDeferredGraphsLoaded 必须早于 hasGraphData()', () => {
		const src = readSrc(DELEG);
		const idx = src.indexOf('_ensureGraphReadyForExplore');
		assert.ok(idx > 0, '应能找到 _ensureGraphReadyForExplore()');
		const body = src.slice(idx, idx + 1400);
		const deferAt = body.indexOf('ensureDeferredGraphsLoaded(');
		const hasAt = body.indexOf('.hasGraphData()');
		assert.ok(deferAt > 0 && hasAt > 0, '必须同时有延迟加载与 hasGraphData() 判定');
		assert.ok(deferAt < hasAt, '延迟加载必须早于「无图 ⇒ 建全部 folder 索引」的判定');
	});
});

/**
 * 大图加载的**时间预算切片**（方案 ①）与**可感知进度**（方案 ⑥），2026-09-15 用户裁决。
 *
 * 背景：原实现按**固定条数**让出主线程（每 2000 个 JSON 元素 / 每 8000 条记录 / 每 1000 个节点）。
 * 固定条数的单次连续占用随「元素大小 / 机器快慢」浮动 ⇒ 大图下单批可达 50~200ms
 * ⇒ 用户看到的是「切换工作区时整窗一顿一顿」（实测 UE5EA 87.6 万节点）。
 * 且加载期只给一句「正在读取并解析制品…」挂几十秒 ⇒ 用户判定为卡死。
 */
suite('方案 ①/⑥ — 时间预算切片 + 可感知加载进度', () => {

	const PERSIST = 'src/vs/sessions/contrib/agentStudio/browser/codebaseGraphPersistence.ts';
	const STORE = 'src/vs/sessions/contrib/agentStudio/browser/codebaseGraphStore.ts';
	const SERVICE = 'src/vs/sessions/contrib/agentStudio/browser/codebaseGraphService.ts';
	const readSrc = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

	/**
	 * 剥注释后再断言。
	 *
	 * ⚠ 负向断言（「不得残留 X」）必须只看**代码**：本轮实测再次踩到 —— 我在源码里把旧常量
	 * 写进了说明注释（「让出策略从每 `PARSE_YIELD_EVERY`（2000）个元素改为…」）
	 * ⇒ `includes('PARSE_YIELD_EVERY')` 命中注释 ⇒ 断言假失败。
	 * 这是本仓第 N 次同一个坑（`guardrailWiring` / `workspaceFolderWriters` 都记过）。
	 */
	const readCode = (rel: string) =>
		readSrc(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

	test('★★ 切片工具语义：预算判定 + 让出必须异步', async () => {
		assert.ok(SLICE_BUDGET_MS > 0 && SLICE_BUDGET_MS <= 16, '预算必须在 (0,16] —— 超过一帧就没有意义');
		assert.ok(SLICE_CHECK_EVERY >= 16, '检查间隔太小会让 performance.now() 的开销超过工作本身');
		// 刚取的时间戳 ⇒ 未超预算；时间原点（0）⇒ 早已超预算
		assert.strictEqual(sliceBudgetExceeded(performance.now()), false);
		assert.strictEqual(sliceBudgetExceeded(0), true);

		let released = false;
		const p = yieldToEventLoop().then(() => { released = true; });
		assert.strictEqual(released, false, '让出必须是异步的 —— 同步返回等于没让');
		await p;
		assert.strictEqual(released, true);
	});

	test('★★★ 三处大循环必须都按**时间预算**让出（不得退回固定条数）', () => {
		const persist = readCode(PERSIST);
		assert.ok(!persist.includes('PARSE_YIELD_EVERY'), '解析侧不得残留固定条数常量');
		assert.ok(persist.includes('sliceBudgetExceeded(sliceStart)'), '解析侧必须按预算判定');

		const store = readCode(STORE);
		assert.ok(!store.includes('YIELD_EVERY'), 'store 不得残留固定条数常量');
		// 节点循环 + 边循环 + BM25（增量 removed/added + 全量）⇒ 至少 4 处
		const hits = (store.match(/sliceBudgetExceeded\(sliceStart\)/g) ?? []).length;
		assert.ok(hits >= 4, `store 内至少 4 处按预算让出，实际 ${hits}`);
		// 让出后必须重置基准，否则会「一直超预算 ⇒ 每项都让出」。
		const resets = (store.match(/sliceStart = performance\.now\(\)/g) ?? []).length;
		assert.ok(resets >= hits, '每次让出后必须重置 sliceStart（否则退化成每项都让出）');
	});

	test('★★★ 加载进度必须**节流**（8ms 切片 ⇒ 每让出都推 UI 会到每秒上百次）', () => {
		const src = readSrc(PERSIST);
		assert.ok(src.includes('PROGRESS_THROTTLE_MS'), '必须有节流常量');
		assert.ok(src.includes('now - lastReportAt < PROGRESS_THROTTLE_MS'), '必须有实际节流判断');
		assert.ok(
			src.includes('onProgress?: (line: string) => void'),
			'loadMerge 必须接受进度回调',
		);
	});

	test('★★ 进度必须接到 UI 事件（只写日志用户看不到）', () => {
		const svc = readSrc(SERVICE);
		const idx = svc.indexOf('const loaded = await persistence.loadMerge(');
		assert.ok(idx > 0, '应能找到 loadMerge 调用');
		const call = svc.slice(idx, idx + 360);
		assert.ok(call.includes('_onDidGraphLoadProgress.fire('), '阶段内进度必须推到 UI 事件');
		assert.ok(
			svc.includes('重建全文索引（BM25）：${done}/${total}'),
			'BM25 重建阶段也要回报进度（它是合并后的第二个重活）',
		);
	});
});

/**
 * 方案 C 的补强：**切换工作区时清理「本贡献类对 folder 的记账」**（2026-09-15 用户日志实证）。
 *
 * 用户提供 `vscode-app-1789479656705.log` 后发现的真 bug：
 * 窗口从 `S1Game + UE5EA` 切到本仓（3 根）时，service 侧 `_pruneForeignProjects()` 把 store 里的
 * S1Game 图丢了（`store nodes=0` ✓），但 **bootstrap 的三个集合没跟着清**：
 *   · `_readyFolders` 仍含 S1Game ⇒ 切回 S1Game 时 `toLoad` 过滤会**跳过加载**（图谱看起来空了）；
 *   · `_deferredFolders` 仍含 UE5EA ⇒ 在别的工作区用 codebase 功能时会把 **25MB 巨图**读进内存。
 */
suite('方案 C 补强 — 切换工作区时的记账清理', () => {

	const BOOTSTRAP = 'src/vs/sessions/contrib/agentStudio/browser/codebaseGraphBootstrap.ts';
	const readSrc = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
	const readCode = (rel: string) =>
		readSrc(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

	test('★★★ folder 变化时必须忘掉「已离开工作区」的记账（三个集合都要修剪）', () => {
		const src = readCode(BOOTSTRAP);
		const def = 'private _forgetFoldersNotInWorkspace(reason: string): void';
		const idx = src.indexOf(def);
		assert.ok(idx > 0, '必须有清理方法');
		const body = src.slice(idx, idx + 1500);
		for (const set of ['_readyFolders', '_deferredFolders', '_pendingIndex']) {
			assert.ok(
				body.includes(`for (const key of [...this.${set}`),
				`${set} 必须被修剪 —— 与 service 侧 _pruneForeignProjects 同口径`,
			);
		}
		assert.ok(body.includes('current.has(key)'), '必须与「当前工作区」求交集');
		assert.ok(
			!body.includes('this._readyFolders.clear()'),
			'不得整体清空 —— folder 事件可能只是新增一个 root，清空会导致其余 folder 被重复加载',
		);

		// 调用点：必须在 onDidChangeWorkspaceFolders 里，且**早于** re-bootstrap。
		const hIdx = src.indexOf('onDidChangeWorkspaceFolders');
		assert.ok(hIdx > 0, '应能找到 folder 变化监听');
		const handler = src.slice(hIdx, hIdx + 1600);
		const forgetAt = handler.indexOf('_forgetFoldersNotInWorkspace(');
		const bootAt = handler.indexOf('this._bootstrap()');
		assert.ok(forgetAt > 0, 'folder 变化时必须调用清理');
		assert.ok(bootAt > 0 && forgetAt < bootAt, '清理必须早于 re-bootstrap（否则刚清完又按旧记账跳过）');
	});

	test('★★★ 按需加载必须**先过滤、再算 isLast**（否则 BM25 不重建 ⇒ 新节点搜不到）', () => {
		const src = readCode(BOOTSTRAP);
		const idx = src.indexOf('private async _loadDeferredGraphs(reason: string): Promise<void>');
		assert.ok(idx > 0, '应能找到 _loadDeferredGraphs');
		const body = src.slice(idx, idx + 1600);
		const filterAt = body.indexOf('const pending = all.filter(');
		const lastAt = body.indexOf('const isLast = i === pending.length - 1');
		assert.ok(filterAt > 0, '必须先过滤掉已离开工作区的 folder（否则会把旧工作区巨图读进内存）');
		assert.ok(lastAt > 0, 'isLast 必须基于**过滤后**的 pending 计算');
		assert.ok(filterAt < lastAt, '顺序：先过滤，再算 isLast');
	});
});

/**
 * 切换工作区时的**落盘安全**与**降卡**（2026-09-15 数据丢失事故 + 用户报「切换时 app 卡住」）。
 *
 * 事故（用户日志 `vscode-app-1789480089965.log`，21:47:32）：
 *   ① 增量索引结束 → `_scheduleSaveGraph(root, 'sarosis-agents-client')` 排入 30s 防抖；
 *   ② 用户切走工作区 → `_pruneForeignProjects` 把该项目从 store 删掉（`store nodes=0`）；
 *   ③ **定时器随后才触发** → `_saveGraph` 拿到 0 节点 → 把 **99 字节**写进原本
 *      **8.2MB / 176620 节点**的 `.codebase-memory/graph.db.zst`（用户索引被毁）。
 * 同一时刻的卡顿：prune 同步跑（丢 176836 节点）+ 切换后立刻 `loadGraphMerge S1Game (5432ms)`。
 */
suite('切换工作区时的落盘安全与降卡（2026-09-15）', () => {

	const SVC = 'src/vs/sessions/contrib/agentStudio/browser/codebaseGraphService.ts';
	const BOOTSTRAP = 'src/vs/sessions/contrib/agentStudio/browser/codebaseGraphBootstrap.ts';
	const readCode = (rel: string) =>
		fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

	test('★★★ 「0 节点」必须在 `persistence.save` **之前**拦住（事后无法挽回）', () => {
		// 原守卫在 save 之后才跑、且只在 `totalCount > 0` 时告警 ⇒ store 全空时**沉默照写** ✗。
		const src = readCode(SVC);
		const idx = src.indexOf('private async _saveGraph(rootPath: string, project?: string): Promise<void>');
		assert.ok(idx > 0, '应能找到 _saveGraph');
		const body = src.slice(idx, idx + 2600);
		const guardAt = body.indexOf('savedCount === 0');
		const saveAt = body.indexOf('persistence.save(');
		assert.ok(guardAt > 0, '必须有「0 节点不写盘」守卫');
		assert.ok(saveAt > 0, '应能定位 persistence.save 调用');
		assert.ok(guardAt < saveAt, '守卫必须在 save **之前** —— 落地即覆盖，事后无法挽回');
		assert.ok(
			body.slice(guardAt, saveAt).includes('return;'),
			'命中守卫必须直接 return（跳过写盘，保留磁盘上完好的制品）',
		);
	});

	test('★★★ prune 必须在**删项目之前**取消过期 root 的待发落盘（竞态源头）', () => {
		const src = readCode(SVC);
		const idx = src.indexOf('private _pruneForeignProjects(reason: string): string[] {');
		assert.ok(idx > 0, '应能找到 _pruneForeignProjects');
		const body = src.slice(idx, idx + 2600);
		const cancelAt = body.indexOf('clearTimeout(pending.timer)');
		const deleteAt = body.indexOf('this.deleteProject(');
		assert.ok(cancelAt > 0, 'prune 必须取消待发落盘');
		assert.ok(deleteAt > 0, '应能定位 deleteProject 调用');
		assert.ok(cancelAt < deleteAt, '取消必须发生在删数据**之前** —— 否则定时器醒来时数据已空');
		// 判据必须是 root（而非项目名）：`_pendingSaves` 的 project 可能为 undefined。
		assert.ok(
			body.slice(cancelAt - 400, cancelAt + 400).includes('_isRootInCurrentWorkspace('),
			'取消判据必须用 root 是否仍在工作区',
		);
		assert.ok(body.includes('_pendingSaves'), '必须遍历待发落盘表');
	});

	test('★★★ folder 变化时的 prune 必须**推迟**（同步跑会卡住切换 UI）', () => {
		// 异常栈实证：`_pruneForeignProjects ← (anonymous) ← _deliver ← fire ← updateWorkspaceAndInitializeConfiguration`
		// ⇒ 它在 onDidChangeWorkspaceFolders 的**同步派发**里执行，而它要删 17.6 万个节点。
		const src = readCode(SVC);
		const idx = src.indexOf('onDidChangeWorkspaceFolders(() =>');
		assert.ok(idx > 0, '应能找到 folder 变化监听');
		const handler = src.slice(idx, idx + 1400);
		assert.ok(
			handler.includes('setTimeout(() => this._pruneForeignProjects('),
			'prune 必须推迟到本次事件派发之后',
		);
		assert.ok(
			!/\n\t\t\tthis\._pruneForeignProjects\('workspace folders changed'\);/.test(handler),
			'不得再同步调用 prune',
		);
	});

	test('★★★ folder 变化时的图谱加载必须**推迟**（实测 5432ms 紧贴切换）', () => {
		const src = readCode(BOOTSTRAP);
		const idx = src.indexOf('onDidChangeWorkspaceFolders((e: IWorkspaceFoldersChangeEvent) =>');
		assert.ok(idx > 0, '应能找到 folder 变化监听');
		const handler = src.slice(idx, idx + 1800);
		const bootAt = handler.indexOf('this._bootstrap()');
		assert.ok(bootAt > 0, '仍必须在 folder 变化后重新 bootstrap');
		const setTimeoutAt = handler.lastIndexOf('setTimeout(', bootAt);
		assert.ok(setTimeoutAt > 0, 'bootstrap 必须包在 setTimeout 里（先让切换跑完）');
		// 清理必须仍然同步 —— 它是纯内存操作，且要赶在 re-bootstrap 之前生效。
		assert.ok(
			handler.indexOf('_forgetFoldersNotInWorkspace(') < setTimeoutAt,
			'记账清理仍须同步执行，且早于被推迟的 bootstrap',
		);
	});

	test('★★★ 空制品必须视为「缺失」并允许重建（否则「有制品、无图谱、永不重建」）', () => {
		// 事故善后：被写坏的 99 字节制品仍**存在** ⇒ 会命中「制品存在但加载失败 ⇒ 跳过 auto-index」
		// ⇒ 用户从此既没有图、也永远不会重建。故「跳过 auto-index」必须带「制品非空」条件。
		const src = readCode(BOOTSTRAP);
		assert.ok(src.includes('artifactStat.size'), '必须读取制品大小');
		assert.ok(src.includes('EMPTY_ARTIFACT_BYTES'), '必须有「空制品」阈值常量');
		const skipAt = src.indexOf('skipping auto-index to avoid full rescan');
		assert.ok(skipAt > 0, '应能找到「制品存在但加载失败」分支');
		const guard = src.slice(Math.max(0, skipAt - 800), skipAt);
		assert.ok(
			guard.includes('artifactBytes >= EMPTY_ARTIFACT_BYTES'),
			'跳过 auto-index 必须带「制品非空」条件 —— 空制品要允许重建',
		);
		assert.ok(
			src.includes('treating it as missing and allowing re-index'),
			'空制品分支必须留日志（否则用户/我们看不出它被当成缺失处理）',
		);
	});

	test('★★★「加载成功但 0 节点」必须按**未加载**处理（否则永远不重建）', () => {
		// 实测（`vscode-app-1789480447320.log`）：被写坏的 99 字节制品**仍能成功解压成空图**
		// ⇒ `loadGraphMerge` 返回 true ⇒ 旧代码直接 `_readyFolders.add` 并打印
		// 「Loaded existing graph」⇒ 该 folder 永远不会重建 ✗✗。
		const src = readCode(BOOTSTRAP);
		const readyAt = src.indexOf('Loaded existing graph for folder');
		assert.ok(readyAt > 0, '应能找到「已加载」分支');
		const before = src.slice(Math.max(0, readyAt - 1000), readyAt);
		assert.ok(
			before.includes('getProjectNodeCount(project)'),
			'必须用**项目节点数**判定是否真的加载到数据（不能只看 loadGraphMerge 的返回值）',
		);
		assert.ok(before.includes('mergedNodes > 0'), '只有 mergedNodes > 0 才算 ready');
		assert.ok(
			before.includes('readyFolders.add(key)') || src.slice(readyAt, readyAt + 160).includes('_readyFolders.add(key)'),
			'ready 标记必须在 mergedNodes > 0 分支内',
		);
		assert.ok(src.includes('treating as NOT loaded'), '空图必须有明确日志');

		// 服务必须真的暴露这个方法（接口 + 实现），否则 bootstrap 无法判断。
		const svc = readCode(SVC);
		assert.ok(svc.includes('getProjectNodeCount(project: string): number;'), '接口必须声明 getProjectNodeCount');
		assert.ok(svc.includes('getProjectNodeCount(project: string): number {'), '必须有实现');

		// ★★★ 2026-09-16：**判据必须是事实（解析成功但 0 节点），不能只比字节数**。
		// 用户场景：PJDB\S1Game 留下一份 **10KB** 空图（能正常解压、零节点）—— 只比字节数会把它
		// 归进「≥1KB ⇒ 巨图损坏 ⇒ 跳过自动索引」⇒ 该 folder **既没有图、也永远不会重建** ✗。
		assert.ok(svc.includes('isLastMergeEmpty(rootPath: string): boolean;'), '接口必须声明 isLastMergeEmpty');
		assert.ok(svc.includes('isLastMergeEmpty(rootPath: string): boolean {'), '必须有实现');
		assert.ok(
			svc.includes('this._emptyArtifactRoots.add(rootPath);'),
			'「解析成功但 0 节点」必须留下标记 —— 调用方要靠它区分「空制品」与「损坏/巨大的制品」',
		);
		assert.ok(
			svc.includes('treating as NOT loaded (empty / garbage artifact)'),
			'「解析成功但 0 节点」必须按「未加载」返回 false（否则调用方标记 ready ⇒ 永不重建）',
		);
		assert.ok(
			src.includes('isLastMergeEmpty(') && src.includes('&& !parsedButEmpty)'),
			'bootstrap 的「跳过 auto-index」必须排除空制品 —— 用事实而不是字节数',
		);
	});
});

/**
 * 按 **root** 剪枝（2026-09-16 用户报「GR_ 与 PJDB 同名 S1Game 互相污染」）。
 *
 * 事故：切到 `D:\GR_\S1Game` 时，内存里那份来自 `D:\PJDB\S1Game` 的 `S1Game`（**同名**）
 * 被旧判据（只比项目名）判为「属于本工作区」而保留 ⇒ 旧工作区的图继续驻留内存并污染检索。
 * 修法：判定以 **root** 为准 —— **项目名不是身份**。
 */
suite('★ 按 root 剪枝：同名不同 root 必须丢弃', () => {

	const GR = 'd:/gr_/s1game';
	const PJDB = 'd:/pjdb/s1game';
	const MAP = (entries: readonly (readonly [string, string])[]) => new Map(entries);

	test('★★★ 旧工作区的同名项目（映射里的 root 不在本工作区）必须丢弃', () => {
		// 工作区 = GR_\S1Game；内存里那个 S1Game 的 root 映射只指向 PJDB ⇒ 是**外来**的
		assert.deepStrictEqual(
			planForeignProjectPrune(['S1Game'], ['S1Game'], MAP([[PJDB, 'S1Game']]), [GR]),
			['S1Game'],
			'名字相同也不能保留 —— 身份是 root',
		);
	});

	test('★ 本工作区 root 在映射里 ⇒ 保留', () => {
		assert.deepStrictEqual(
			planForeignProjectPrune(['S1Game'], ['S1Game'], MAP([[GR, 'S1Game']]), [GR]),
			[],
		);
	});

	test('⚠ 同名跨多个 root（数据已合并）⇒ 保留，由服务侧告警（纯函数无法按 root 拆分）', () => {
		// store / SQLite 以**项目名**为唯一键 ⇒ 两个 root 同名时两份数据已合并；
		// 这里若丢弃会把**当前工作区**的数据一起删掉 ⇒ 只能保留 + 告警（见 `[prune] same-name`）。
		assert.deepStrictEqual(
			planForeignProjectPrune(['S1Game'], ['S1Game'], MAP([[GR, 'S1Game'], [PJDB, 'S1Game']]), [GR]),
			[],
		);
	});

	test('★ 无 root 信息（_default / 从 SQLite 按名载入）⇒ 退回按名判据（保守，不误删）', () => {
		assert.deepStrictEqual(
			planForeignProjectPrune(['S1Game', 'other'], ['S1Game'], MAP([]), [GR]),
			['other'],
		);
		// 完全不给 root 参数 = 旧调用方行为（按名）
		assert.deepStrictEqual(planForeignProjectPrune(['S1Game', 'other'], ['S1Game']), ['other']);
	});

	test('★ 无工作区 ⇒ 返回空数组（宁可不判断，也不误删）', () => {
		assert.deepStrictEqual(planForeignProjectPrune(['S1Game'], [], MAP([[PJDB, 'S1Game']]), [GR]), []);
		assert.deepStrictEqual(planForeignProjectPrune(['S1Game'], []), []);
	});
});

/**
 * 切换工作区后**按需加载**（2026-09-16，用户报「切工作区卡住」的根因修复）。
 *
 * 数据链：切换本身 99~157ms（`initializeWorkspaceInPlace 完成`）；而紧随其后的图谱加载
 * 3.6~6s（`bootstrap 完成（本轮共 3860ms）` = 解压 240 + 解析 1712 + 写入 store 834 + …），
 * 期间主线程被切片式占满 ⇒ 看门狗实测 `⚠ 交互延迟 ≈584ms`（点一下要等半秒）。
 * 修法：切换触发的 `_bootstrap` 传 `deferLoads`，**制品存在就延迟**到「真正要用图」时；
 * 三个入口（codebase 工具 / 子代理预检 / codebase UI）都必须能触发它。
 */
suite('★ 切换后按需加载（不得在切换后立刻加载图谱）', () => {

	const readSrc = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
	const BOOT = 'src/vs/sessions/contrib/agentStudio/browser/codebaseGraphBootstrap.ts';
	const AUTO = 'src/vs/sessions/contrib/agentStudio/browser/widgets/codebaseGraphAutoBuild.ts';

	test('★★★ 切换触发必须走 deferLoads，且**制品存在才延迟**', () => {
		const boot = readSrc(BOOT);
		assert.ok(boot.includes('_bootstrap({ deferLoads: true })'),
			'folder 变化后的 re-bootstrap 必须传 deferLoads —— 否则切换后仍会跑 3.6~6s 的加载');
		assert.ok(boot.includes('until first codebase use — workspace switch must stay instant'),
			'必须留下明确日志（否则日后无法判断「为什么切过去没有图」）');
		assert.ok(boot.includes('if (wantDeferLoad && sizeBytes > 0)'),
			'⚠ 必须只在**制品存在**时延迟：制品不存在时延迟会让新 folder **永远不会被索引**');
		assert.ok(boot.includes('scheduling auto-index'),
			'「无图 ⇒ 排自动索引」的原路必须仍在（新 folder 靠它被索引）');
	});

	test('★★★ codebase UI 必须触发按需加载（否则 UI 会误判「无图」而发起全量索引）', () => {
		const auto = readSrc(AUTO);
		assert.ok(auto.includes("ensureDeferredGraphsLoaded('codebase UI open')"),
			'Find Symbol / Open File 打开时必须先触发按需加载');
		const at = auto.indexOf("ensureDeferredGraphsLoaded('codebase UI open')");
		const after = auto.indexOf('indexWorkspace(', at);
		assert.ok(at > 0 && (after === -1 || after > at),
			'触发按需加载必须**早于** `indexWorkspace(` —— 顺序反了就变成「有制品却全量重建」');
	});
});

/**
 * ★★★ 图谱**关键不变量**（2026-09-19 合并重建）。
 *
 * 为什么单独一个套件：这些不变量是近期若干真实事故的**唯一守门人**，但此前分散的断言
 * 被并发改动整体覆盖过一次（contracts 56 → 40）⇒ 修复全变成"纸面的" ✗。
 * 每条都对应一次实测事故，改动前请先确认"当初为什么加"。
 */
suite('★★★ 图谱关键不变量（勿回退）', () => {
	const stripC4 = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
	const read4 = (rel: string) => stripC4(fs.readFileSync(path.join(process.cwd(), rel), 'utf8'));
	const B = 'src/vs/sessions/contrib/agentStudio/browser/';
	const N = 'src/vs/sessions/contrib/agentStudio/node/';

	test('① 读了的图谱配置必须**注册**（否则用户改不了、永远拿默认值）', () => {
		const c = fs.readFileSync(path.join(process.cwd(), B + 'agentStudio.contribution.ts'), 'utf8');
		for (const key of ['sqliteBackend', 'artifactFormat', 'memoryBudgetMb', 'excludeProfile']) {
			assert.ok(c.includes(`saros.codebaseGraph.${key}`),
				`设置 ${key} 必须注册 —— 曾因注册被覆盖导致 SQLite 快照档不可用（代码在读、界面里却没有）✗`);
		}
	});

	test('② FTS5 不得在全量同步收尾做整库重建', () => {
		const svc = read4(B + 'codebaseGraphService.ts');
		assert.ok(!svc.includes('this._sqliteBackend.rebuildFTS()'),
			'FTS 已随批量写逐节点建好 ⇒ 收尾 `rebuild` 是整库重索引（大仓上最贵的一段）✗');
	});

	test('③ 内存判据必须是**本轮增量**（不得回到绝对堆占用）', () => {
		const svc = read4(B + 'codebaseGraphService.ts');
		assert.ok(svc.includes('_memBaselineBytes'), '必须有「本轮基线」字段');
		assert.ok(svc.includes('growthBytes'),
			'必须按「当前 − 基线」判超限 —— 拿整个 renderer 堆比预算会让每轮索引一开场就误报 ✗');
	});

	test('④ 解析并行度不得硬顶 4（须用满 hc-1，且保留防内存峰值上限）', () => {
		const p = read4(B + 'codebaseGraphParserPool.ts');
		assert.ok(p.includes('Math.min(16, hc - 1)'), '必须用 (hc-1)，并保留上限 16');
		assert.ok(!/Math\.min\(4, ?Math\.max\(1, ?\(navigator\.hardwareConcurrency/.test(p),
			'不得回退成硬顶 4 —— 8/16 核机器上白白限速解析 ✗');
	});

	test('⑤ SQLite 载入同步判据须看**节点数**（「存在」≠「可用」，且「非空」≠「不落后」）', () => {
		const svc = read4(B + 'codebaseGraphService.ts');
		assert.ok(svc.includes('usableCount'), '必须核对节点数，否则「存在但 0 节点」会被 skip sync ✗');
		assert.ok(svc.includes('has EMPTY'), '「存在但为空」必须写明在日志里（不得静默跳过同步 ✗）');
		// ★ 2026-09-19 实测补充：只判「存在且 >0」**仍不够** —— 真机出现
		// `already has project "…" (167810 nodes) — skip sync` 而制品是 **180115**（差 1.2 万）⇒ **永不追平** ✗✗
		// ⇒ ①检索看到残缺图（正确性问题）②`canSkipArtifactParse`（要求 sqlite ≥ artifact）恒 false
		//   ⇒ 每次载入都要解析 JSON 制品（2.4–4.3s，「切工作区卡死」主因段）。
		assert.ok(svc.includes('const expectedCount = this._graph.store.getNodeCount(proj)'),
			'必须取「本次载入的节点数」作为期望值 —— 否则无从判断落后 ✗');
		// ★ 2026-09-19 实测补充（**容差**）：首版「任何落后都全量重同步」在实机让「只落后 170 节点」
		// 触发了 **82s 全量重同步** ✗✗ ⇒ 小漂移应交给**增量补丁**按文件收敛，只对大落后自愈。
		assert.ok(svc.includes('const behindTolerance = Math.max(2000, Math.floor(expectedCount * 0.02))'),
			'必须有落后**容差**（max(2000, 2%)）—— 否则小漂移也会付 82s 全量重同步 ✗');
		assert.ok(/const behind = usableCount > 0 && lag > behindTolerance/.test(svc),
			'「落后」判据须用容差：lag > behindTolerance 才算不可用并重新同步（自愈 ✓）');
		assert.ok(svc.includes('is behind (') && svc.includes('仅落后'),
			'大落后（is behind）与**小落后（≤容差）**都必须写明数字，不得静默 ✗');
	});

	/**
	 * ⑪ 为什么值得钉：全量同步实测 **82–134s**（180115 节点 + 522085 边，IPC + FTS 逐批插入）。
	 * 它一度由**载入路径 `await`** 触发 ⇒ 实机 `loadGraphMerge(...) 耗时 91648ms` ✗✗（切工作区/开窗口卡死）。
	 * 现在统一走「后台入口」：带「同步中」守卫（防两条链路并发 delete+insert 互相覆盖）与冷却
	 * （防失败后每次载入都反复付上百秒）✓。
	 */
	test('⑪ SQLite 追平必须**后台**跑：载入路径不得 await，且要有守卫 + 冷却', () => {
		const svc = read4(B + 'codebaseGraphService.ts');
		assert.ok(svc.includes('_scheduleSqliteCatchUp'),
			'必须走统一的后台入口（否则两处触发点各自 fire-and-forget ⇒ 并发覆盖 ✗）');
		assert.ok(svc.includes('_sqliteCatchUpInFlight'),
			'必须有「同步中」守卫 —— 同一 project 同时只跑一个追平任务 ✗');
		assert.ok(/FULL_SYNC_MIN_INTERVAL_MS\s*=\s*5 \* 60 \* 1000/.test(svc),
			'必须有冷却（5 分钟）—— 否则追平失败后每次载入都再付上百秒 ✗');
		assert.ok(!svc.includes('await this._syncGraphToSqlite(proj);'),
			'载入路径**不得 await** 全量同步 —— 实机把载入拖到 91.6s ✗✗（载入只需要内存 store ✓）');
		assert.ok(svc.split('_scheduleSqliteCatchUp(').length - 1 >= 3,
			'载入路径与 freshness 两处触发点都必须改走该入口（+1 处定义）');
	});

	/**
	 * ⑫ 为什么值得钉：全量重同步实测 **128s**（`deleteProject` + 重插 180k 节点 + 522k 边 + FTS）。
	 * 而「DB 缺了哪些节点」其实有**确定性特征**：内存 id **单调递增**，且全量同步是**按内存 id 显式写入**的
	 * ⇒ 缺的都是 `id > DB 的 max` 那批 ⇒ 一次标量查询 + 复用按文件补丁即可追平（秒级）✓✓。
	 * 这层优化若被回退（比如有人删掉 `getMaxNodeId` 直接走全量），就会**静默**回到 128s ✗ ⇒ 必须钉住。
	 */
	test('⑫ 落后追平必须**先增量**（maxNodeId → 按文件补丁），仍落后才退回全量', () => {
		const svc = read4(B + 'codebaseGraphService.ts');
		const chan = read4('src/vs/sessions/contrib/agentStudio/common/codebaseGraphStoreChannel.ts');
		const nodeStore = read4(N + 'codebaseGraphSqliteStore.ts');
		assert.ok(chan.includes('getMaxNodeId'), '契约必须暴露 getMaxNodeId（追平的判据来源）');
		// ★★★ 真机验证抓到的真 bug（2026-09-19）：只加「契约 + 实现」漏了**主进程分发器** ⇒
		// 运行期 `CodebaseGraphStoreChannel: invalid call: getMaxNodeId` ⇒ renderer **静默**降级回全量（128s）✗✗
		// ⇒ 这套链路是「契约 → 分发器 → 实现 →（ProxyChannel 客户端）」**四方**一致，不是三方 ✗。
		assert.ok(read4('src/vs/sessions/contrib/agentStudio/electron-main/codebaseGraphStoreChannel.ts').includes("case 'getMaxNodeId':"),
			'主进程 channel 分发器必须补 case —— 漏了会 invalid call，且失败被吞成"降级回全量"（优化静默失效 ✗✗）');
		assert.ok(nodeStore.includes('MAX(id) AS maxId'),
			'主进程实现必须用 MAX(id) 算标量（别把整表拉回 renderer ✗）');
		assert.ok(svc.includes('_catchUpSqlite'), '必须有两步式追平入口（先增量 → 仍落后才全量）');
		assert.ok(svc.includes('this._sqliteBackend.getMaxNodeId(project)'),
			'增量追平必须用 getMaxNodeId 定位缺失批次');
		assert.ok(svc.includes('await this._syncIncrementalToSqlite(project, [...missingFiles])'),
			'增量追平必须**复用**按文件补丁（别另写一份 ✗）');
		assert.ok(/after \+ tol >= expected/.test(svc) && svc.includes('退回全量'),
			'补完必须**再核一次**节点数：仍超容差才退回全量（缺 id ≤ max 的情况只能靠它兜 ✗）');
		assert.ok(/share <= 0\.2/.test(svc),
			'漂移文件占比 > 20% 必须直接走全量 —— 逐个补已不比整体重插划算 ✗');
	});

	/**
	 * ⑭ 为什么值得钉（**真机 P0，2026-09-20**）：全量同步跑 **84s** 后整批 abort ——
	 * `SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: nodes.project, nodes.qualified_name`。
	 * 根因链：DB 侧有 `UNIQUE(project, qualified_name)`，而显式 id 的 upsert 只有
	 * `ON CONFLICT(id)`（SQLite 一条 INSERT 只能有一个冲突目标）⇒ 两条**不同 id** 撞同一个
	 * qualified_name 时**无解** ⇒ `upsertNodesBatch` 整批回滚 ⇒ DB **永远落后**，
	 * 「下次载入/查询会重试」⇒ **每个窗口白付 84s** ✗✗✗（且增量补丁走同一分支 ⇒ 同样静默失败 ——
	 * 这正是「DB 怎么落后几千节点」的答案 ✓）。
	 * ⚠ 它非常**静默**：日志里只有一行 WARN，现象只是"搜索结果略旧" ⇒ 极易被忽略 ✗ ⇒ 必须钉住。
	 */
	test('⑭ 全量同步必须对 (project, qualified_name) 去重，且 store 侧必须有 UNIQUE 兜底', () => {
		const svc = read4(B + 'codebaseGraphService.ts');
		const nodeStore = read4(N + 'codebaseGraphSqliteStore.ts');

		// ① 渲染侧：下发前去重（否则撞 UNIQUE ⇒ 整批 abort）
		assert.ok(svc.includes('remapDroppedNodeId') && svc.includes('duplicateNodes'),
			'全量同步必须按 (project, qualified_name) 去重并统计重复数（否则 84s 整批 abort ✗✗）');
		assert.ok(svc.includes('const syncNodes = duplicateNodes > 0 ? [...byQualifiedName.values()] : nodes;'),
			'去重后的集合必须真正用于下发（不是只统计不下发 ✗）');
		// ② 去重后必须**重映射边的端点** —— 否则被丢掉的节点留下悬空边 ✗✗
		assert.ok(/remapDroppedNodeId\.get\(e\.sourceId\)/.test(svc) && /remapDroppedNodeId\.get\(e\.targetId\)/.test(svc),
			'边的 sourceId/targetId 必须重映射到幸存节点（否则悬空边 ✗）');
		// ③ 去重后日志必须可见（重复数增长 = 重解析泄漏的证据 ✓）
		assert.ok(svc.includes('个重复 (project, qualified_name) 节点'),
			'重复数必须打出来 —— 它是「内存里有重复」的唯一可见证据 ✓');

		// ④ store 侧兜底：显式 id 分支必须能识别并化解 UNIQUE(project, qualified_name) 冲突
		//    （增量补丁不走渲染侧去重 ⇒ 只靠这条兜底 ✗✓）
		assert.ok(nodeStore.includes('function isUniqueQualifiedNameError'),
			'store 必须能识别 qualified_name 的 UNIQUE 冲突（窄判据，别把别的错误也兜掉 ✗）');
		assert.ok(nodeStore.includes('DELETE FROM nodes WHERE project = ? AND qualified_name = ? AND id <> ?'),
			'冲突时必须删掉占位的那条再插（保留本次的显式 id ⇒ 与内存 id 仍对齐 ✓）');
		assert.ok(/if \(!isUniqueQualifiedNameError\(err\)\) \{ throw err; \}/.test(nodeStore),
			'非该冲突的错误必须原样抛出（不能把 IO/其它约束错误也吞掉 ✗）');
	});

	/**
	 * ⑯ 为什么值得钉（**2026-09-21，安装版 UE 实证**）：UE 工作区报
	 * `[baseline] deficient graph: 4547 nodes / 95532 hashes — clearing hashes to force full re-index`
	 * ⇒ 触发 **95k 文件全量重索引**（heap 228→656→1221MB 一路涨，与解析期内存看门狗 abort 互相打架 ✗✗）。
	 * 而 store 是**多项目共享**的（同一窗口内含本仓 + UE）⇒ 旧实现读**全库**计数、清**全库**哈希，
	 * 一个坏项目会把**健康项目**也拖进全量重建 ✗。判据必须落回「本轮回合的那个 project」✓。
	 */
	/**
	 * ⑰ 为什么值得钉（**2026-09-21**）：`gaveUp` 是「基线」与「健康度」两条语义的**唯一分界线**：
	 *   · 增量分类基线（`hasBaseline`）⇒ 必须**含** gaveUp（否则失败文件每轮重报 added ⇒ 翻烧饼 ✗）；
	 *   · 健康度/残缺判据 ⇒ 必须**只算**非 gaveUp（否则把"放弃"当"成功" ⇒ 大仓误判残缺 ⇒ 95k 全量 ✗✗）。
	 * 谁把这行改回 `getFileHashCount(...)` 当分母，UE 那种仓就会**静默**回到全量重建 ✗ ⇒ 钉住。
	 */
	test('⑰ gaveUp 必须由解析侧标记，且健康度/残缺判据只能用它当分母', () => {
		const svc = read4(B + 'codebaseGraphService.ts');
		const store = read4(B + 'codebaseGraphStore.ts');
		// ① 解析侧：失败达上限记哈希时必须带 gaveUp 标记
		assert.ok(/const gaveUp = status === 'parse_error' \|\| status === 'timeout';/.test(svc),
			'解析侧必须把「放弃」识别出来（parse_error/timeout 达上限）');
		assert.ok(svc.includes('await this._recordFileHash(project, relPath, absPath, gaveUp);'),
			'记哈希时必须把 gaveUp 传下去（否则健康度仍会把放弃当成功 ✗）');
		assert.ok(svc.includes('...(gaveUp ? { gaveUp: true } : {}),'),
			'非放弃路径**不得**写该字段（缺省 = 成功，旧制品同口径 ✓）');
		// ② 判据侧：分母只能用「成功份」
		assert.ok(svc.includes('this._graph.store.getOkFileHashCount(project)'),
			'残缺判据的分母必须是 getOkFileHashCount（成功份）✗✓');
		assert.ok(!/const nodesPerFile = hashCount > 0 \? nodeCount \/ hashCount/.test(svc) || svc.includes('getOkFileHashCount'),
			'健康度的 nodesPerFile 必须按成功份算');
		// ③ store 侧：两条计数必须真的分开
		assert.ok(/getGaveUpFileHashCount\(project\?: string\)/.test(store) && /getOkFileHashCount\(project\?: string\)/.test(store),
			'store 必须提供 gaveUp / ok 两个计数');
		// ④ 反向保护：增量基线仍须含 gaveUp（不得顺手也换成 ok 口径 ✗）
		assert.ok(/const hasBaseline = graphNodeCount > 0 && this\._graph\.store\.getFileHashCount\(project\) > 0;/.test(svc),
			'hasBaseline 必须仍用**总数**（含 gaveUp）—— 否则失败文件每轮重报 added 翻烧饼 ✗');
	});

	/**
	 * ⑱ 为什么值得钉（**2026-09-21**）：超大仓（UE 9.5 万文件）残缺修复**必须分批** ——
	 * 一次清光哈希 ⇒ 全判 added ⇒ 一次解析 95k 文件 ⇒ 堆每 30s +~1GB ⇒ 撞硬上限中止
	 * ⇒ 「残缺 → 全量 → 中止 → 仍残缺」**永不收敛** ✗✗（真机实测）。
	 * 三步缺一不可：① 用 `clearFileHashesBounded` 只清一批；② 本轮**强制走全量扫描**
	 * （快路径只解析 watcher 变更集，被清的那批不在里面 ⇒ 清了等于没清 ✗✗）；
	 * ③ 批次可配（默认 4000 ≈ +170MB，依据 43MB/1000 文件的实测）。
	 */
	test('⑱ 残缺修复必须分批（bounded clear + 强制扫描轮 + 批次可配且已注册）', () => {
		const svc = read4(B + 'codebaseGraphService.ts');
		const store = read4(B + 'codebaseGraphStore.ts');
		const contrib = fs.readFileSync(path.join(process.cwd(), B + 'agentStudio.contribution.ts'), 'utf8');

		// ① 只清一批（不得退回全清 ✗）
		assert.ok(svc.includes('this._graph.store.clearFileHashesBounded(project, batch)'),
			'残缺修复必须分批清哈希（一次清光 ⇒ 95k 全量 ⇒ 撞硬上限不收敛 ✗✗）');
		assert.ok(!/this\._graph\.store\.clearFileHashes\(project\)/.test(svc),
			'不得退回「一次清光本项目哈希」（那是旧的不收敛实现 ✗）');
		assert.ok(/clearFileHashesBounded\(project: string, limit: number\): number/.test(store),
			'store 必须提供 bounded clear 并返回实际清掉的条数（日志要报账 ✓）');

		// ② 修复轮**必须走全量扫描**（否则清了的文件没人重解析）
		assert.ok(/let repairRound = false;/.test(svc) && /if \(hasChangeSet && hasBaseline && !repairRound\)/.test(svc),
			'修复轮必须强制走扫描分支 —— 快路径只解析 watcher 变更集，被清的批次不在里面 ⇒ 清了等于没清 ✗✗');

		// ③ 批次可配 + 依据可查 + 设置项已注册（契约 ① 的口径：读了就必须注册 ✓）
		assert.ok(/const DEFICIENT_REPAIR_BATCH_FILES = 4000;/.test(svc),
			'默认批次必须有常量（4000）且带取值依据注释（43MB/1000 文件实测 ✓）');
		assert.ok(svc.includes('saros.codebaseGraph.repairBatchFiles'), '批次必须可配（大仓可调）');
		assert.ok(contrib.includes("'saros.codebaseGraph.repairBatchFiles'"),
			'读了配置就必须注册设置项（否则用户看不到也改不了、永远拿默认值 ✗）');
		// ④ 轮数必须可见（否则"修了没修完"无从判断）
		assert.ok(/≈ \$\{rounds\} 轮收敛/.test(svc) || svc.includes('轮收敛'),
			'日志必须报「预计多少轮收敛」（进度可判 ✓）');

		// ⑤ 安全阀：分批必须**有界** —— 若项目天生"每文件 < 2 节点"，比率永不达标 ⇒
		//   不加上限会**无界重解析**（每轮内存有界但白烧 CPU/IO ✗）
		assert.ok(/const DEFICIENT_REPAIR_MAX_ROUNDS = \d+;/.test(svc),
			'分批修复必须有会话内轮数上限（防无界重解析 ✗）');
		assert.ok(/attempt\.rounds >= DEFICIENT_REPAIR_MAX_ROUNDS/.test(svc) && svc.includes('停止自动修复'),
			'到上限必须停止自动修复并**明确提示**手动处理（绝不静默 ✗）');
		assert.ok(/private readonly _repairAttempts = new Map/.test(svc),
			'轮数记账必须按项目（多项目不得互相影响 ✓）');
	});

	/**
	 * ⑲ 为什么值得钉（**用户报障 2026-09-21**）：未索引过的 folder（如 `vssaros-homepage`）
	 * 在 bootstrap 里照例读制品 ⇒ ENOENT ⇒ 旧实现无差别
	 * `ERR [GraphPersistence] failed to read graph artifact: … nonexistent file` + 堆栈 ✗。
	 * 行为其实是对的（返回 null ⇒ `loaded=false` ⇒ 走自动索引 ✓），**错的只是日志级别**：
	 * ① 用户以为环境坏了；② 真故障的读取失败会被这类噪音淹没 ✗✗。
	 */
	test('⑲ 制品不存在 = 正常待索引（debug），不得报 ERR；判断必须窄', () => {
		const p = read4(B + 'codebaseGraphPersistence.ts');
		assert.ok(p.includes('function isArtifactMissingError'), '必须有「制品不存在」的判定函数');
		assert.ok(/FileOperationResult\.FILE_NOT_FOUND/.test(p),
			'必须优先按**类型**判定（FileOperationResult.FILE_NOT_FOUND 最可靠 ✓）');
		assert.ok(/nonexistent file\|no such file\|ENOENT\|FileNotFound/.test(p),
			'还必须有消息兜底（provider 包装后类型可能丢失 ✓）');
		assert.ok(p.includes('graph artifact not found'), '不存在 ⇒ 必须降到 debug（不再是 ERR ✗）');
		assert.ok(/if \(isArtifactMissingError\(e\)\)/.test(p), 'catch 必须先判"不存在"再决定级别');
		// 反向保护：非"不存在"的错误仍必须 error（不得顺手全降级 ⇒ 真故障静默 ✗✗）
		assert.ok(/this\._logService\?\.error\('\[GraphPersistence\]', `failed to read graph artifact/.test(p),
			'其它读取/解压失败仍必须 error（真故障不得静默 ✗）');
	});

	test('⑯ 残缺图判据/清理必须按项目（否则一个坏项目让全库全量重建 ✗✗）', () => {
		const svc = read4(B + 'codebaseGraphService.ts');
		const store = read4(B + 'codebaseGraphStore.ts');
		// 正向：判据与清理都带本轮回合的 project
		assert.ok(svc.includes('this._graph.store.getFileHashCount(project)'), '判据必须按项目读基线规模');
		// 2026-09-21 形态更新：清理已从「一次清光本项目」升级为「**分批**清本项目」（见 ⑱ ✓）——
		// 语义要求不变：**必须限定在本项目**（不得退回 `clearFileHashes()` 全库 ✗）
		assert.ok(svc.includes('this._graph.store.clearFileHashesBounded(project, batch)'),
			'清理必须按项目且分批（只清被判残缺的那个项目，且一轮只清一批 ✓）');
		// 负向：不得退回全库清理（一个坏项目会拖累全部项目付一次全量 ✗✗）
		assert.ok(!/clearFileHashes\(\)/.test(svc), '不得退回 `clearFileHashes()`（全库清理 ✗）');
		// store 侧必须真的支持按项目（可选参数 = 向后兼容 ✓）
		assert.ok(/getFileHashCount\(project\?: string\)/.test(store), 'store.getFileHashCount 必须支持可选 project');
		assert.ok(/clearFileHashes\(project\?: string\)/.test(store), 'store.clearFileHashes 必须支持可选 project');
	});

	/**
	 * ⑮ 为什么值得钉（**2026-09-20，方案 B**）：真机 `💾 保存图谱: 96 MB` 前后，检索报
	 * `sqlite fetch slow: 2387ms` —— 而空闲库上同一检索的三条 SQL 都是毫秒级
	 * （LIKE 125–142ms / FTS 内层 2ms / 外层 2ms）⇒ 慢的是**与落盘争用**的等待 ✗✓。
	 * ⇒ 落盘必须给**在飞的检索**让路。
	 * ⚠ 但"让路"极易退化成**静默不落盘**（制品停在旧版本 ✗✗）⇒ 三个安全阀一个都不能少：
	 * ① 唯一出口（所有落盘路径都经 `_fireSaveOrDefer`）② 饥饿上限优先（不得无限推迟）
	 * ③ 检索结束立刻补跑 + 取消/dispose 时清理重试定时器。
	 */
	test('⑮ 检索在飞时推迟 zst 落盘：唯一出口 + 饥饿上限优先 + 补跑/清理齐全', () => {
		const svc = read4(B + 'codebaseGraphService.ts');

		// ① 在飞计数：必须用薄包装包住真正的实现（否则每个 return 分支都要记得减 ✗）
		assert.ok(svc.includes('private async _searchGraphAsyncImpl('), '实现必须改名，由薄包装统一计数');
		assert.ok(/this\._searchesInFlight\+\+;/.test(svc) && /this\._searchesInFlight--;/.test(svc),
			'必须成对增减在飞计数');
		assert.ok(/finally \{[\s\S]{0,120}this\._searchesInFlight--;/.test(svc), '减计数必须放 finally（异常/提前返回也不能漏 ✗）');

		// ② 让路判据 + 唯一出口
		assert.ok(/if \(this\._searchesInFlight > 0 && !starved\)/.test(svc),
			'检索在飞且未到饥饿上限 ⇒ 必须推迟落盘');
		assert.ok(svc.includes('this._fireSaveOrDefer(key, rootPath, project);'),
			'延时到期也必须经唯一出口（不得直接 _saveGraph ✗）');

		// ③ 数据安全：饥饿上限必须优先于让路（否则连续检索流会让制品永不更新 ✗✗）
		assert.ok(/const starved = \(Date\.now\(\) - first\) >= SAVE_MAX_DEFER_MS;/.test(svc),
			'必须有饥饿判据，且以「首个待发请求」计时');
		assert.ok(/即使有检索在飞也强制落盘/.test(svc), '饥饿到点时必须强制落盘并记日志 ✓');

		// ④ 补跑与清理（缺一 ⇒ 落盘丢失 / dispose 后误触发 ✗）
		assert.ok(svc.includes('_flushSavesDeferredBySearch'), '检索全部结束必须立刻补跑被推迟的落盘');
		assert.ok(/SAVE_DEFER_BY_SEARCH_MS/.test(svc), '推迟后必须有重试间隔');
		assert.ok(svc.includes('_saveRetryTimers'), '重试定时器必须可追踪（取消/dispose 时清理 ✓）');
		assert.ok(/for \(const t of this\._saveRetryTimers\.values\(\)\) \{ clearTimeout\(t\); \}/.test(svc),
			'dispose 必须清掉重试定时器（否则 dispose 后仍触发落盘 ✗）');
	});

	/**
	 * ⑬ 为什么值得钉：全量同步原子化是**四方链路 + 一个成对纪律**，任何一方缺位都会**静默退化成
	 * 非原子**（崩在中间 = 项目残缺 ✗✗，而追平只能在下一次载入才补 ✗）。本套件把「契约/分发器/
	 * 实现/客户端**四方都在** + begin/commit/abort 成对 + abort 在 finally」钉死 ✓。
	 * （今天已抓过一次「只加契约+实现、漏了分发器」的真 bug ⇒ 这里**一次到位** ✓✓。）
	 */
	test('⑬ P0-1 全量同步必须**原子化**：begin/commit/abort 成对且四方一致', () => {
		const svc = read4(B + 'codebaseGraphService.ts');
		const chan = read4('src/vs/sessions/contrib/agentStudio/common/codebaseGraphStoreChannel.ts');
		const host = read4('src/vs/sessions/contrib/agentStudio/electron-main/codebaseGraphStoreChannel.ts');
		const store = read4(N + 'codebaseGraphSqliteStore.ts');
		for (const m of ['beginProjectSync', 'commitProjectSync', 'abortProjectSync']) {
			assert.ok(chan.includes(`${m}(`), `契约必须声明 ${m}`);
			assert.ok(host.includes(`case '${m}':`), `分发器必须有 ${m} 的 case（漏了会 invalid call ✗✗）`);
			assert.ok(store.includes(`${m}(`), `store 必须实现 ${m}`);
		}
		assert.ok(svc.includes('beginProjectSync(project)'), '全量同步必须**开**显式事务 ✓');
		assert.ok(svc.includes('commitProjectSync(project)'), '全量同步必须**提交** ✓');
		assert.ok(svc.includes('abortProjectSync(project)'), '失败必须**回滚** ✓（否则崩在中间 = 项目残缺 ✗✗）');
		assert.ok(/finally\s*\{[\s\S]*abortProjectSync/.test(svc), 'abort 必须在 finally 里（异常路径也要回滚 ✓）');
		// 事务存续期不得 checkpoint（WAL checkpoint 在打开的写事务里被拒 ✗）。
		// ⚠ 断言**基于代码**而非注释 —— `read4` 是**剥注释**读法 ✗✗（注释里的字样会被剥掉 ⇒ 假红 ✗，
		//   本条正是踩了它 ✗✓）：断言「commit 之后的代码里仍有 checkpoint()」✓。
		const commitIdx = svc.indexOf('commitProjectSync(project)');
		assert.ok(commitIdx > 0, '全量同步必须 commit ✓');
		assert.ok(svc.slice(commitIdx).includes('checkpoint()'), 'commit 之后必须仍有 checkpoint（事务内的会被拒 ✗）');
	});

	test('⑥ 驼峰分词 + 两步 BM25（含截断兜底）必须仍在', () => {
		const st = read4(N + 'codebaseGraphSqliteStore.ts');
		assert.ok(st.includes('camelSplitTokens'), '驼峰分词（对齐 CBM camel_split）不能丢');
		assert.ok(st.includes('rowid AS rid'), '两步 BM25 的「内层纯 FTS」不能丢（否则 WAND 提前终止失效）');
		assert.ok(st.includes('two-step truncated'), '候选被截断时必须有精确兜底查询（宁慢不丢）');
	});

	test('⑦ SQLite 快照档：失败必须**回退写 JSON 并告警**（不得留空/半截制品）', () => {
		const svc = read4(B + 'codebaseGraphService.ts');
		// ① 快照必须核对节点数 —— 否则会写出「成功的空快照」（比不写更糟 ✗）
		assert.ok(svc.includes('snapshot node count mismatch'), '快照必须核对节点数（空/半截快照不可信）');
		// ② 失败必须响亮告警并说明会回退（静默会让用户以为快照档正在生效 ✗）
		assert.ok(/SQLite 快照导出失败（将回退写 JSON 制品）/.test(svc),
			'快照失败必须 WARN 且写明「将回退写 JSON 制品」—— 这是切档后唯一的安全网');
		// ③ 回退条件必须覆盖「快照未成功」，否则 sqlite 档失败时两份制品都没有
		assert.ok(svc.includes("if (artifactFormat !== 'sqlite' || !snapshotOk)"),
			'回退条件必须含 `!snapshotOk`（否则 sqlite 档导出失败 ⇒ 磁盘上什么都不剩 ✗）');
		// ④ 原子落盘：先 .tmp 再 move（半写制品会误导 canSkipArtifactParse 的判据）
		assert.ok(svc.includes("const tmpPath = snapPath + '.tmp'") && svc.includes('this._fileService.move('),
			'快照必须先写 .tmp 再 move（原子）');
	});

	test('⑧ 内存趋势采样：只在增长时打印 + dispose 必须清理定时器', () => {
		const svc = read4(B + 'codebaseGraphService.ts');
		assert.ok(svc.includes('_ensureMemTrajectorySampler()'), '必须有**惰性**启动的采样器（不为从不看图的工作区起定时器）');
		assert.ok(svc.includes('mem-trajectory'), '必须有一条可 grep 的趋势行（这是趋势的唯一数据源）');
		assert.ok(/growth < 32 \* 1048576/.test(svc),
			'必须只在增长超阈值时打印 —— 否则每 5 分钟一条「没变化」的纯噪音 ✗（本会话刚犯过同类错）');
		assert.ok(svc.includes('clearInterval(this._memTrajectoryTimer)'), 'dispose 必须清理定时器（否则泄漏 ✗）');
	});

	test('⑨ P2-1 索引通道：契约 / worker 入口 / renderer 代理**三方一致**（方案 B：worker 直连）', () => {
		const base = 'src/vs/sessions/contrib/agentStudio/';
		// ⚠ 三方**都必须剥注释**再断言：这三份文件的 header 里**刻意**写着反面例子
		//（「曾用 mainProcessService.getChannel」「曾是本地字面量 'index'」「原草案是回调式 onProgress」）
		// ⇒ 不剥注释的负向断言必然假红 ✗（本仓第 N 次踩这条，见 footerPills「黑白灰」套件的同款教训 ✓）
		const contract = read4(base + 'common/codebaseGraphIndexChannel.ts');
		const worker = read4(base + 'node/codebaseGraphIndexWorkerMain.ts');
		const proxy = read4(base + 'browser/codebaseGraphIndexProxy.ts');

		// ① 方法集一致：契约声明 / 入口实现，任一漏一个都是运行期「不是函数」✗
		// ⚠ 代理侧**不再手写四方法转发** —— 它把整个服务交给 `ProxyChannel.toService` 透明代理
		//（方法集由契约保证 ✓）。代理侧要钉的是另外两条形状约束（见 ③），
		// 四方法的**行为**覆盖在 `test/browser/codebaseGraphIndexProxy.test.ts`（6 条，走真实 IPC 往返 ✓）。
		for (const m of ['runIndex', 'cancel', 'isRunning', 'getProgress']) {
			assert.ok(contract.includes(`${m}(`), `契约必须声明 ${m}`);
			assert.ok(worker.includes(`${m}(`), `worker 入口的服务必须实现 ${m} —— 漏了调用时才炸 ✗`);
		}

		// ② worker **身份单点定义**，两侧都从它取（漂移会静默拿到 undefined ✗）
		assert.ok(contract.includes('CODEBASE_GRAPH_INDEX_WORKER'), '契约必须导出 worker 身份常量');
		assert.ok(contract.includes("channel: 'index'"), '常量里必须写清入口模块注册的通道名');
		assert.ok(worker.includes('CODEBASE_GRAPH_INDEX_WORKER.channel'),
			'入口模块必须复用契约里的通道名 —— 两边各写一份，漂移后取通道得到 undefined 且**不报错** ✗');
		assert.ok(worker.includes('ProxyChannel.fromService'),
			'入口模块必须用 ProxyChannel.fromService 把服务暴露成 channel（照抄 watcherMain ✓）');

		// ③ 代理必须是**方案 B（worker 直连）**，且不得回退到主进程通道
		assert.ok(proxy.includes('createWorker('),
			'代理必须用 utilityProcessWorkerWorkbenchService.createWorker 起进程（框架既定客户端用法 ✓）');
		assert.ok(proxy.includes('ProxyChannel.toService<ICodebaseGraphIndexChannel>'), '代理必须用 ProxyChannel 透明转发');
		assert.ok(proxy.includes('CODEBASE_GRAPH_INDEX_WORKER'),
			'代理必须复用 worker 身份常量（不得硬编码 moduleId / 通道名字符串 ✗）');
		assert.ok(!proxy.includes('mainProcessService'),
			'不得回退成「经主进程通道取代理」✗ —— main 侧 createWorker 是窗口服务端，不提供 client channel');
		assert.ok(!/\bCODEBASE_GRAPH_INDEX_CHANNEL\b/.test(contract),
			'旧的 main 进程通道名常量应已删除 —— 留着是死代码，且会误导后人以为还有一条 renderer→main 路径 ✗');
		// 负向：不得回退成回调式推送 —— ProxyChannel 只做请求/响应（写代理时踩到并修正的坑 ✓）
		assert.ok(!/\bonProgress\s*\(/.test(contract), '不得回退成回调式 onProgress（ProxyChannel 不支持宿主推送 ✗）');

		// ④ ★★ 钉住两个「看起来对、实测**全部调用永久挂起**」的写法（详见代理文件头的「坑 1 / 坑 2」）
		//  坑 1：代理是 `ProxyChannel.toService` 的返回值 = **Proxy**，它的 `get` 陷阱对**任意**字符串键
		//        都返回函数（**包括 `then`** ✗）⇒ 一旦被 **Promise 决议过程**碰到（如 async 函数 return 它），
		//        会被当 thenable 采纳 ⇒ 调 `then` ⇒ 宿主抛 `Method not found: then` ⇒ 而 then 的返回值
		//        没人看 ⇒ **外层 promise 永不结算** ⇒ 所有调用挂起且不报错 ✗✗（实测：6 条用例全超时 50s）。
		assert.ok(!/async\s*\(\s*\)\s*=>\s*[\s\S]{0,160}ProxyChannel\.toService/.test(proxy),
			'不得用 async 箭头包装 toService —— then 陷阱会让**所有调用永久挂起**、且不报错也不超时 ✗✗');
		assert.ok(proxy.includes('return ProxyChannel.toService<ICodebaseGraphIndexChannel>('),
			'必须在**同步**路径 return toService(...)（配合上一条，保证不被当成 thenable ✗）');
		//  坑 2：`getDelayedChannel(getWorker().then(...))` 会在**构造期**就调用 getWorker() ✗
		//        ⇒ ①惰性失效（打开窗口就起进程）；②启动失败变成**无人处理的 rejection**。
		//        ⇒ 取通道必须写成**函数**，只在第一次方法调用时才真跑 ✓。
		assert.ok(!/getDelayedChannel\(\s*getWorker\(\)/.test(proxy),
			'不得在构造期求值 getWorker()（惰性失效 + 未处理 rejection ✗）—— 取通道必须写成函数');
		assert.ok(proxy.includes('const getChannel = ()'),
			'取通道必须写成**函数式惰性**（构造零成本、首次调用才起进程 ✓）');
		// ⚠ 写成 `call:` / `listen:`（属性定义形态）—— 用 `call(` 会**假红**（实参括号在 `:` 之后 ✗，
		// 我第一次就写错了；「我的模式写错」是本仓高频坑 ✓）。
		assert.ok(/\bcall\s*:/.test(proxy) && /\blisten\s*:/.test(proxy),
			'延迟通道必须补全 IChannel 的 call / listen 两个形状（缺 listen 会在取事件时炸 ✗）');
	});

	/**
	 * ⑩ 为什么值得钉：`[阻塞Nms]` 是**排期决策的唯一依据**（本轮就是靠它推翻了"克隆检测/边匹配是首块"✗），
	 * 而它的采集有个**静默失真**：`_maxBlockMs` 是模块级全局累加器、**只在被读时清零**
	 * ⇒ 两次读取之间的**任何**时间窗里的最大阻塞都会算到"下一个读取者"头上 ✗。
	 * 真机症状（一眼可判）：`解压制品=537ms[阻塞2999ms]` —— 段只有 537ms 却报 2999ms 连续阻塞，
	 * **物理上不可能**（连续阻塞不可能长于所在窗口 ✓）。根因就是本仓有**两个**读取者
	 * （`loadMerge` 的 `timed` 与增量索引的 `_seg`）而没有任何一处清零 ✗✗。
	 */
	test('⑩ `[阻塞Nms]` 的每个消费者都必须在**序列开头**清零（否则读数是旧账，会误导排期）', () => {
		const diag = read4(B + 'wsSwitchDiag.ts');
		assert.ok(diag.includes('export function resetMaxBlockMs'),
			'必须导出 resetMaxBlockMs —— 把「丢掉陈旧累积」做成显式接口，而不是让每个消费者自己猜 ✓');
		assert.ok(/export function resetMaxBlockMs\(\): void \{\s*_maxBlockMs = 0;/.test(diag),
			'resetMaxBlockMs 必须是「直接清零」✗ 不得先读走 —— 读走等于把旧账记到自己头上 ✗');

		// 「**有 take 就必须有 reset**」：两个消费者都要在序列开头清零
		for (const rel of [B + 'codebaseGraphPersistence.ts', B + 'codebaseGraphService.ts']) {
			const src = read4(rel);
			assert.ok(src.includes('takeMaxBlockMs()'), `${rel} 应按段读取阻塞值`);
			assert.ok(src.includes('resetMaxBlockMs()'),
				`${rel} 必须在序列开头调用 resetMaxBlockMs() —— 否则本序列第一段会揽下` +
				'「自上次读取以来」的全局最大阻塞（真机：`解压制品=537ms[阻塞2999ms]` 物理上不可能 ✗✗）');
		}
	});
});
