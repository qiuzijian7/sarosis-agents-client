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
import { isAbsoluteGraphPath, excludeDirsForProfile, COMMON_EXCLUDE_DIRS, shouldRecordHashAfterParse, matchesExcludeDir, shouldDeferGraphLoad } from '../../common/codebaseIndexDefaults.js';
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
	});
});
