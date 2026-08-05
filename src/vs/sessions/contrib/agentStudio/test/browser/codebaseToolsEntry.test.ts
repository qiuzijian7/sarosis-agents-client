/*---------------------------------------------------------------------------------------------
 *  codebaseToolsEntry.test.ts — codebase 工具入口冒烟测试（tdd）。
 *
 *  目的：保证 2026-07-22 各功能改动的【工具调用入口】接线正常：
 *  - search_graph → searchGraphAsync（SQLite 后端感知）、参数透传、空结果诊断、无图提示
 *  - search_code → service.searchCode、别名兼容（pattern/path/output_mode/file_glob）、必填校验
 *  - export_artifact → slim 参数透传（默认 true / 显式 false）
 *  - import_artifact → 成功/失败（含 integrity check 失败文案）
 *
 *  运行：
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/test/browser/codebaseToolsEntry.test.ts
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { registerCodebaseTools } from '../../browser/providers/tool/codebaseTools.js';

interface IToolEntry { definition: { name: string }; handler: (args: Record<string, unknown>) => Promise<any> }

function parseJson(result: any): any {
	assert.ok(Array.isArray(result) && result.length > 0, 'tool result should be content array');
	assert.strictEqual(result[0].type, 'text');
	return JSON.parse(result[0].text);
}

function resultText(result: any): string {
	if (typeof result === 'string') { return result; }
	assert.ok(Array.isArray(result) && result.length > 0);
	return result[0].text;
}

function makeCtx(serviceOverrides: Record<string, unknown> = {}, ctxOverrides: Record<string, unknown> = {}) {
	const tools = new Map<string, IToolEntry>();
	const service: Record<string, any> = {
		hasGraphData: () => true,
		hasGraphDataAsync: async () => true,
		tryLoadFromSqlite: async () => true,
		whenGraphLoaded: async () => { /* 竞态守卫桩：测试环境图谱同步就绪 */ },
		hasProjectData: () => true,
		getTotalNodeCount: () => 1,
		getEdges: () => [],
		getNode: () => undefined,
	// 默认无项目根映射 → loc 维持相对路径（兼容旧断言）；多项目用例显式覆盖
	getProjectRoots: () => ({}),
	// search_files 索引快路径依赖（默认空清单 → 快路径不命中，回落 ripgrep）
	listIndexedFilePaths: async () => [],
	...serviceOverrides,
	};
	// search_code 熔断依赖 searchHelpers.recordSearchRepeat（默认不拦截；
	// 熔断用例用 recordSearchRepeatBehavior 覆盖）
	const recordBehavior = ctxOverrides['recordSearchRepeatBehavior'] as undefined
		| ((...a: any[]) => { count: number; warning?: string; blocked?: string });
	const ctx = {
		register: (t: IToolEntry) => tools.set(t.definition.name, t),
		hasTool: (name: string) => tools.has(name),
		codebaseGraphService: service,
		workspaceService: { getWorkspace: () => ({ folders: [{ uri: URI.file('/wk') }] }) },
	fileService: {
		async resolve(): Promise<never> { throw new Error('ENOENT'); },
		async readFile(): Promise<never> { throw new Error('ENOENT'); },
		async exists(): Promise<boolean> { return false; },
		// search_code P1 搜索根 stat 预检：默认不存在；用例可用 statBehavior 覆盖
		stat: (ctxOverrides['statBehavior'] as undefined | ((...a: any[]) => Promise<unknown>))
			?? (async (): Promise<never> => { throw new Error('ENOENT'); }),
	},
	searchHelpers: {
		recordSearchRepeat: recordBehavior ?? ((..._a: any[]) => ({ count: 1 })),
		// search_code 连续空结果连击（2026-07-28）默认不引导；用例可用
		// recordSearchCodeEmptyStreakBehavior 覆盖以定制连击行为。
		recordSearchCodeEmptyStreak: (ctxOverrides['recordSearchCodeEmptyStreakBehavior'] as undefined
			| ((...a: any[]) => { streak: number; shouldGuide: boolean }))
			?? ((..._a: any[]) => ({ streak: 0, shouldGuide: false })),
		// search_code 重构（2026-07-27）改用 ripgrep 引擎 searchContent；用例可用
		// searchContentBehavior 覆盖以捕获入参 / 定制返回。默认返回单行匹配文本。
		searchContent: (ctxOverrides['searchContentBehavior'] as undefined | ((...a: any[]) => Promise<string>))
			?? (async (..._a: any[]) => 'src/a.ts:3: const foo = 1;'),
		searchFilesByGlob: async (..._a: any[]) => '(no matching files)',
		normalizeFileSearchGlob: (g: string) => g,
		enforceSearchSize: (s: string) => s,
		densifySearchOutput: (s: string) => s,
		// searchOutcomeHint 降级提示依赖（codebaseTools 空命中 hint 参数）；
		// 默认 ripgrep 正常（不降级）。
		isContentSearchDegraded: () => false,
	},
		// search_code 重构后用 resolveAndCheckWorkspacePath 解析 searchPath（project→folder）
		resolveAndCheckWorkspacePath: (ctxOverrides['resolvePathBehavior'] as undefined | ((...a: any[]) => Promise<string>))
			?? (async (_agent: string | undefined, p: string) => (p === '.' ? '/wk' : p)),
		logService: { info() { }, warn() { }, error() { }, debug() { }, trace() { } },
		adrManager: undefined,
	};
	registerCodebaseTools(ctx as any);
	return tools;
}

function getTool(tools: Map<string, IToolEntry>, name: string): IToolEntry {
	const t = tools.get(name);
	assert.ok(t, `tool "${name}" should be registered`);
	return t!;
}

suite('codebase tool entries: search_graph (2026-07-22 wiring)', () => {

	test('search_graph routes through searchGraphAsync and passes query params', async () => {
		let captured: any;
		const tools = makeCtx({
			searchGraphAsync: async (params: any) => {
				captured = params;
				return { nodes: [{ id: 1, name: 'auth', qualifiedName: 'svc.auth', type: 'Function', filePath: 'src/a.ts' }], total: 1, hasMore: false };
			},
			searchGraph: () => { throw new Error('sync searchGraph should not be called on async path'); },
		});
		const out = await getTool(tools, 'search_graph').handler({ query: 'auth', format: 'json' });
		const json = parseJson(out);
		assert.strictEqual(captured.query, 'auth');
		assert.strictEqual(json.total, 1);
		assert.strictEqual(json.nodes[0].name, 'auth');
	});

	test('search_graph zero-result returns diagnostic hint', async () => {
		const tools = makeCtx({
			searchGraphAsync: async () => ({ nodes: [], total: 0, hasMore: false }),
			getTotalNodeCount: () => 42,
		});
		const out = await getTool(tools, 'search_graph').handler({ query: 'nothing', format: 'json' });
		const json = parseJson(out);
		assert.strictEqual(json.total, 0);
		assert.ok(String(json.hint).includes('42 nodes'), `hint should mention total nodes, got: ${json.hint}`);
	});

	test('search_graph without graph returns no-graph message', async () => {
		const tools = makeCtx({
			hasGraphData: () => false,
			hasGraphDataAsync: async () => false,
			tryLoadFromSqlite: async () => false,
		});
		const out = await getTool(tools, 'search_graph').handler({ query: 'x' });
		assert.ok(resultText(out).includes('no graph loaded'), `expected no-graph message, got: ${resultText(out)}`);
	});

	// ── 2026-07-26：0 结果近似名建议（Did you mean，事故 1785053998262）──

	test('namePattern 0 结果时按词干给出 Did you mean 建议', async () => {
		const seen: string[] = [];
		const tools = makeCtx({
			searchGraphAsync: async (params: any) => {
				seen.push(params.namePattern ?? '');
				const np = params.namePattern as string;
				// 全名不存在（UE4 命名幻觉），词干存在（UE5EA 实际符号）
				if (np === 'CollectGarbageInternal') { return { nodes: [], total: 0, hasMore: false }; }
				if (np === 'CollectGarbage') {
					return {
						nodes: [
							{ id: 1, name: 'CollectGarbage', qualifiedName: 'a::CollectGarbage', type: 'function', filePath: 'GC.cpp' },
							{ id: 2, name: 'CollectGarbageImpl', qualifiedName: 'a::CollectGarbageImpl', type: 'function', filePath: 'GC.cpp' },
						],
						total: 2, hasMore: false,
					};
				}
				return { nodes: [], total: 0, hasMore: false };
			},
			getTotalNodeCount: () => 249322,
		});
		const out = await getTool(tools, 'search_graph').handler({ namePattern: 'CollectGarbageInternal', format: 'json' });
		const json = parseJson(out);
		assert.strictEqual(json.total, 0);
		assert.ok(String(json.hint).includes('Did you mean: CollectGarbage'), `hint 应含近似名建议，got: ${json.hint}`);
		// 先全名搜索 0 结果，再词干回退搜索（camelCase 截短）
		assert.deepStrictEqual(seen, ['CollectGarbageInternal', 'CollectGarbage'], `回退序列异常: ${JSON.stringify(seen)}`);
	});

	test('所有词干也无命中 → 不附加 Did you mean', async () => {
		const tools = makeCtx({
			searchGraphAsync: async () => ({ nodes: [], total: 0, hasMore: false }),
			getTotalNodeCount: () => 249322,
		});
		const out = await getTool(tools, 'search_graph').handler({ namePattern: 'ZxqwvNotExist', format: 'json' });
		const json = parseJson(out);
		assert.strictEqual(json.total, 0);
		assert.ok(!String(json.hint).includes('Did you mean'), `无命中时不应有建议，got: ${json.hint}`);
	});

	test('短/单段 namePattern 不触发回退搜索（无多余调用）', async () => {
		const seen: string[] = [];
		const tools = makeCtx({
			searchGraphAsync: async (params: any) => { seen.push(params.namePattern ?? ''); return { nodes: [], total: 0, hasMore: false }; },
			getTotalNodeCount: () => 1,
		});
		await getTool(tools, 'search_graph').handler({ namePattern: 'Foo', format: 'json' });
		assert.deepStrictEqual(seen, ['Foo'], '短名不应触发回退搜索');
	});
});

suite('codebase tool entries: 多项目 loc 绝对化（2026-07-26，事故 1785073599983）', () => {
	// 事故背景：多 folder 图谱（S1Game + UE5EA）中 search_graph 的 TOON loc 列
	// 输出项目相对路径，模型误拼首个 folder 根 → file_read "Unable to resolve
	// nonexistent file" ×7 + terminal 瞎猜 F:\Mode。修复：loc 输出项目根拼接的绝对路径。

	const roots = { UE5EA: 'f:/UE5EA', S1Game: 'f:/GR_qiuzijian_main/S1Game' };
	const gcRelPath = 'Engine/Source/Runtime/CoreUObject/Private/UObject/GarbageCollection.cpp';

	test('search_graph TOON loc 列输出项目根拼接的绝对路径', async () => {
		const tools = makeCtx({
			getProjectRoots: () => roots,
			searchGraphAsync: async () => ({
				nodes: [
					{ id: 1, name: 'CollectGarbage', qualifiedName: 'UE5EA::CollectGarbage', type: 'function', project: 'UE5EA', filePath: gcRelPath, startLine: 2330 },
					{ id: 2, name: 'Foo', qualifiedName: 'S1Game::Foo', type: 'function', project: 'S1Game', filePath: 'Source/Foo.cpp', startLine: 5 },
				],
				total: 2, hasMore: false,
			}),
		});
		const out = await getTool(tools, 'search_graph').handler({ query: 'CollectGarbage' }); // 默认 format=toon
		const txt = resultText(out);
		assert.ok(txt.includes(`f:/UE5EA/${gcRelPath}:2330`), `UE5EA 节点 loc 应为绝对路径，got:\n${txt}`);
		assert.ok(txt.includes('f:/GR_qiuzijian_main/S1Game/Source/Foo.cpp:5'), `S1Game 节点 loc 应为绝对路径，got:\n${txt}`);
	});

	test('search_graph JSON 模式 nodes.filePath 同样绝对化（模型可读）', async () => {
		const tools = makeCtx({
			getProjectRoots: () => roots,
			searchGraphAsync: async () => ({
				nodes: [{ id: 1, name: 'CollectGarbage', qualifiedName: 'UE5EA::CollectGarbage', type: 'function', project: 'UE5EA', filePath: gcRelPath, startLine: 2330 }],
				total: 1, hasMore: false,
			}),
		});
		const out = await getTool(tools, 'search_graph').handler({ query: 'CollectGarbage', format: 'json' });
		const json = parseJson(out);
		assert.strictEqual(json.nodes[0].filePath, `f:/UE5EA/${gcRelPath}`, 'json 模式 nodes.filePath 也应绝对化');
	});

	test('根不可解析（未知 project）时 loc 原样输出相对路径', async () => {
		const tools = makeCtx({
			getProjectRoots: () => ({}),
			searchGraphAsync: async () => ({
				nodes: [{ id: 1, name: 'x', qualifiedName: 'p::x', type: 'function', project: 'Unknown', filePath: 'a/b.cpp', startLine: 1 }],
				total: 1, hasMore: false,
			}),
		});
		const out = await getTool(tools, 'search_graph').handler({ query: 'x' });
		const txt = resultText(out);
		assert.ok(txt.includes('a/b.cpp:1'), `未知 project 应回退相对路径，got:\n${txt}`);
	});

	test('search_code(ripgrep) 结果文本原样透传（路径由 ripgrep resolvedPath 保证，无图谱绝对化后处理）', async () => {
		// 重构后 search_code 走 ripgrep，路径直接来自文件系统匹配结果，不再有
		// 图谱 enriched/_project 绝对化后处理（该逻辑已随重构移除）。
		const tools = makeCtx({
			getProjectRoots: () => roots,
		}, {
			searchContentBehavior: async () => `f:/UE5EA/${gcRelPath}:2330: void CollectGarbage()`,
		});
		const out = await getTool(tools, 'search_code').handler({ query: 'CollectGarbage' });
		const txt = resultText(out);
		assert.ok(txt.includes(`f:/UE5EA/${gcRelPath}`), `ripgrep 命中路径应原样透传，got: ${txt}`);
		assert.ok(!txt.includes('_project'), '不应出现内部 _project 字段');
	});

	test('list_projects 输出附带 rootPath', async () => {
		const tools = makeCtx({
			getProjectRoots: () => roots,
			listProjects: () => [
				{ name: 'S1Game', nodeCount: 100, edgeCount: 200, fileCount: 10 },
				{ name: 'UE5EA', nodeCount: 249000, edgeCount: 500000, fileCount: 20000 },
			],
		});
		const out = await getTool(tools, 'list_projects').handler({});
		const json = parseJson(out);
		assert.strictEqual(json.count, 2);
		assert.strictEqual(json.projects[0].rootPath, 'f:/GR_qiuzijian_main/S1Game');
		assert.strictEqual(json.projects[1].rootPath, 'f:/UE5EA');
	});
});

suite('codebase tool entries: search_code (2026-07-27 ripgrep 重构)', () => {

	// 捕获 searchContent 入参的辅助 ctxOverrides（重构后 search_code 走 ripgrep 引擎）
	function captureCtx(capture: (a: { path: string; query: string; glob?: string; limit: number; outputMode: string; context: number }) => void, ret = 'src/a.ts:3: const foo = 1;') {
		return {
			searchContentBehavior: async (path: string, query: string, glob: string | undefined, limit: number, _offset: number, outputMode: string, context: number) => {
				capture({ path, query, glob, limit, outputMode, context });
				return ret;
			},
		};
	}

	test('search_code 走 ripgrep searchContent 并返回匹配文本', async () => {
		let called = false;
		const tools = makeCtx({}, captureCtx(() => { called = true; }));
		const out = await getTool(tools, 'search_code').handler({ query: 'foo' });
		assert.ok(called, 'searchHelpers.searchContent should be invoked');
		assert.ok(resultText(out).includes('const foo = 1;'), `expected ripgrep text, got: ${resultText(out)}`);
	});

	test('P2 zod-only：别名不再恢复（pattern 不再映射 query → 缺参错误）', async () => {
		// P2（2026-07-29）移除别名层后，handler 直接读规范参数名；pattern-only
		// 调用在 handler 内即报缺 query（生产中 coerce 层会更早 reject）。
		let called = false;
		const tools = makeCtx({}, captureCtx(() => { called = true; }));
		const out = await getTool(tools, 'search_code').handler({ pattern: 'foo' });
		assert.ok(!called, '别名不再恢复，searchContent 不应执行');
		assert.ok(resultText(out).includes('requires "query"'), `应报缺 query，got: ${resultText(out)}`);
	});

	test('search_code requires query', async () => {
		const tools = makeCtx({}, captureCtx(() => { }));
		const out = await getTool(tools, 'search_code').handler({});
		assert.ok(resultText(out).includes('requires "query"'), `expected required error, got: ${resultText(out)}`);
	});

	test('字面查询被转义（regex=false 默认）', async () => {
		let seen: string | undefined;
		const tools = makeCtx({}, captureCtx((a) => { seen = a.query; }));
		await getTool(tools, 'search_code').handler({ query: 'a.b(c)' });
		assert.strictEqual(seen, 'a\\.b\\(c\\)', '字面量应转义正则元字符（ripgrep isRegExp=true）');
	});

	test('多词查询 → foo.*bar（自动 regex，不转义）', async () => {
		let seen: string | undefined;
		const tools = makeCtx({}, captureCtx((a) => { seen = a.query; }));
		await getTool(tools, 'search_code').handler({ query: 'foo bar' });
		assert.strictEqual(seen, 'foo.*bar', '多词空格 → .*');
	});

	test('identifier pipe alternation 自动 regex 且原样透传（事故 1785078531442）', async () => {
		let seen: string | undefined;
		const tools = makeCtx({}, captureCtx((a) => { seen = a.query; }));
		await getTool(tools, 'search_code').handler({ query: 'GAllowIncrementalReachability|IncrementalReachabilityTimeLimit' });
		assert.strictEqual(seen, 'GAllowIncrementalReachability|IncrementalReachabilityTimeLimit', '无空格 A|B 走 alternation regex，原样传给 ripgrep（不转义）');
	});

	test('含点号/正则片段的无空格 alternation 也自动 regex（放宽判定 1785081279790）', async () => {
		let seen: string | undefined;
		const tools = makeCtx({}, captureCtx((a) => { seen = a.query; }));
		await getTool(tools, 'search_code').handler({ query: 'gc.IncrementalGCStepSize|gc.CreateGCClusters|\\.Ref' });
		assert.strictEqual(seen, 'gc.IncrementalGCStepSize|gc.CreateGCClusters|\\.Ref', 'alternation regex 原样透传');
	});

	test('pipe with space 走多词 .* 规则（非 alternation）', async () => {
		let seen: string | undefined;
		const tools = makeCtx({}, captureCtx((a) => { seen = a.query; }));
		await getTool(tools, 'search_code').handler({ query: 'a|b c' });
		assert.strictEqual(seen, 'a|b.*c', '含空格走多词 .* 规则');
	});

	test('search_code 连续相同参数触发熔断（recordSearchRepeat blocked）', async () => {
		const tools = makeCtx({}, {
			recordSearchRepeatBehavior: () => ({ count: 4, blocked: 'SEARCH REPEAT BLOCKED: same search 4 times' }),
		});
		const out = await getTool(tools, 'search_code').handler({ query: 'Foo' });
		assert.ok(resultText(out).includes('SEARCH REPEAT BLOCKED'), '熔断消息应直接返回');
	});

	test('project → 解析为对应 folder 根路径作 searchPath scope', async () => {
		let seenPath: string | undefined;
		const tools = makeCtx({
			getProjectRoots: () => ({ UE5EA: 'f:/UE5EA' }),
		}, {
			searchContentBehavior: async (path: string) => { seenPath = path; return 'f:/UE5EA/Engine/x.cpp:1: hit'; },
			resolvePathBehavior: async (_a: string | undefined, p: string) => p,
		});
		await getTool(tools, 'search_code').handler({ query: 'hit', project: 'UE5EA' });
		assert.strictEqual(seenPath, 'f:/UE5EA', 'project 应解析为该 folder 根路径作为 ripgrep 搜索根');
	});

	test('缺省 project → 遍历全部 workspace folders（searchPath=各 folder 根路径）', async () => {
		// 事故 1785151024653 修复后，缺省不再 resolveAndCheckWorkspacePath('.') 搜单根，
		// 而是遍历 workspace folders 逐个搜（多根工作区下避免漏搜第二/三个 folder）。
		let seenPath: string | undefined;
		const tools = makeCtx({}, {
			searchContentBehavior: async (path: string) => { seenPath = path; return 'a.ts:1: hit'; },
			resolvePathBehavior: async (_a: string | undefined, p: string) => p,
		});
		await getTool(tools, 'search_code').handler({ query: 'hit' });
		assert.strictEqual(seenPath, URI.file('/wk').fsPath, '缺省应搜全部 folder（searchPath=folder 根路径）');
	});

	test('path_filter 相对裸文件名（stat 不存在）→ **/<file> glob 兜底', async () => {
		let seenGlob: string | undefined;
		const tools = makeCtx({}, captureCtx((a) => { seenGlob = a.glob; }));
		await getTool(tools, 'search_code').handler({ query: 'hit', path_filter: 'GarbageCollection.h' });
		assert.strictEqual(seenGlob, '**/GarbageCollection.h', '相对裸文件名按文件名过滤兜底（P1 保持旧结果）');
	});

	test('path_filter 相对目录（stat 存在）→ 搜索根替换，不再走 include glob（P1 搜索根模型）', async () => {
		// 事故 1785224874547/1785228894680 的根治：目录作搜索根（rg <dir> 等价），
		// 而非 **/<dir>/** include glob（四象限补丁的源头）。
		let seen: { path: string; glob?: string } | undefined;
		const tools = makeCtx({}, {
			...captureCtx((a) => { seen = a; }),
			statBehavior: async (uri: { fsPath: string }) => ({ isDirectory: true, _p: uri.fsPath }),
		});
		await getTool(tools, 'search_code').handler({ query: 'hit', path_filter: 'Runtime/CoreUObject' });
		assert.ok(seen, 'searchContent 应被调用');
		assert.ok(seen!.path.endsWith('/Runtime/CoreUObject'), `目录应成为搜索根，got path=${seen!.path}`);
		assert.strictEqual(seen!.glob, undefined, '搜索根语义下不再传 include glob');
	});

	test('path_filter 绝对路径（stat 存在）→ 直接作搜索根（文件/目录均可）', async () => {
		// 事故 1785134772329/1785224874547 的根治：绝对路径不再进 includePattern。
		let seen: { path: string; glob?: string } | undefined;
		const tools = makeCtx({}, {
			...captureCtx((a) => { seen = a; }),
			statBehavior: async () => ({ isDirectory: false }),
		});
		await getTool(tools, 'search_code').handler({ query: 'hit', path_filter: 'f:/gr/ue5ea/Engine/Source/Runtime/CoreUObject/Private/UObject/GarbageCollection.cpp' });
		assert.ok(seen, 'searchContent 应被调用');
		assert.strictEqual(seen!.path, 'f:/gr/ue5ea/Engine/Source/Runtime/CoreUObject/Private/UObject/GarbageCollection.cpp', '绝对文件直通为搜索路径');
		assert.strictEqual(seen!.glob, undefined, '不再拼 **/f:/... 畸形 glob');
	});

	test('path_filter 路径不存在（stat 全失败）→ 显式报错而非假 no matches（对齐 kimi stat 预检）', async () => {
		const tools = makeCtx({}, captureCtx(() => { /* 不应到达 */ }));
		const out = await getTool(tools, 'search_code').handler({ query: 'hit', path_filter: 'No/Such/Dir' });
		const t = resultText(out);
		assert.ok(t.includes('路径不存在'), `应显式报路径不存在，got: ${t}`);
		assert.ok(!t.includes('no matches') || t.includes('路径不存在'), '不能与 no matches 混淆');
	});

	test('path_filter 为 glob（含 *）→ 清洗后走 includePattern', async () => {
		let seenGlob: string | undefined;
		const tools = makeCtx({}, captureCtx((a) => { seenGlob = a.glob; }));
		// 根名首段（wk）应被剥掉（1785228894680 glob 形态）
		await getTool(tools, 'search_code').handler({ query: 'hit', path_filter: '**/wk/Engine/Source/**' });
		assert.strictEqual(seenGlob, 'Engine/Source/**', 'glob 剥 **/ 前缀与根名首段后走 includePattern');
	});

	test('filePattern 裸文件名/裸扩展 glob 补 **/ 前缀（log 1785231958842）', async () => {
		let seenGlob: string | undefined;
		const tools = makeCtx({}, captureCtx((a) => { seenGlob = a.glob; }));
		await getTool(tools, 'search_code').handler({ query: 'hit', filePattern: 'GarbageCollection.cpp' });
		assert.strictEqual(seenGlob, '**/GarbageCollection.cpp', '裸文件名应补 **/ 才能匹配嵌套');

		const tools2 = makeCtx({}, captureCtx((a) => { seenGlob = a.glob; }));
		await getTool(tools2, 'search_code').handler({ query: 'hit', filePattern: '*.cpp' });
		assert.strictEqual(seenGlob, '**/*.cpp', '裸扩展 glob 应补 **/');

		const tools3 = makeCtx({}, captureCtx((a) => { seenGlob = a.glob; }));
		await getTool(tools3, 'search_code').handler({ query: 'hit', filePattern: '**/CoreUObject/**/*.ts' });
		assert.strictEqual(seenGlob, '**/CoreUObject/**/*.ts', '已含 / 的模式原样透传');
	});

	test('search_code 无过滤空命中 → 追加"验证符号名"hint（log 1785231958842）', async () => {
		const tools = makeCtx({}, {
			searchContentBehavior: async () => '(no matches)',
			recordSearchCodeEmptyStreakBehavior: () => ({ streak: 1, shouldGuide: false }),
		});
		const out = await getTool(tools, 'search_code').handler({ query: 'SomeHallucinatedSymbol' });
		const txt = resultText(out);
		assert.ok(txt.includes('no path filter'), '应说明未用过滤');
		assert.ok(txt.includes('search_files') || txt.includes('search_graph'), '应引导先验证符号名');
		assert.ok(!txt.includes('too restrictive'), '无过滤时不应提示过滤过严');
	});

	test('search_code 有过滤空命中 → 提示"过滤过严"而非"验证符号名"', async () => {
		const tools = makeCtx({}, {
			searchContentBehavior: async () => '(no matches)',
			recordSearchCodeEmptyStreakBehavior: () => ({ streak: 1, shouldGuide: false }),
		});
		const out = await getTool(tools, 'search_code').handler({ query: 'Sym', path_filter: '**/Narrow/**' });
		const txt = resultText(out);
		assert.ok(txt.includes('too restrictive'), '有过滤空命中应提示过滤过严');
		assert.ok(!txt.includes('no path filter'), '有过滤时不应用无过滤 hint');
	});

	test('mode=full → ripgrep content + 至少 3 行上下文', async () => {
		let seenCtx: number | undefined; let seenMode: string | undefined;
		const tools = makeCtx({}, captureCtx((a) => { seenCtx = a.context; seenMode = a.outputMode; }));
		await getTool(tools, 'search_code').handler({ query: 'foo', mode: 'full' });
		assert.strictEqual(seenMode, 'content', 'full → content outputMode');
		assert.ok((seenCtx ?? 0) >= 3, 'full 模式至少 3 行上下文');
	});

	test('search_code 连续空结果达阈值 → 输出追加 graph 引导（log 1785231958842）', async () => {
		// 模拟 0 命中 + 连击达阈值 → 结果应含 searchCodeEmptyStreakHint 引导文本。
		const tools = makeCtx({}, {
			searchContentBehavior: async () => '(no matches)',
			recordSearchCodeEmptyStreakBehavior: () => ({ streak: 3, shouldGuide: true }),
		});
		const out = await getTool(tools, 'search_code').handler({ query: 'SomeHallucinatedSymbol' });
		const txt = resultText(out);
		assert.ok(txt.includes('3 times in a row'), '应含连击次数');
		assert.ok(txt.includes('search_graph'), '应引导转 search_graph');
		assert.ok(txt.includes('STOP retrying'), '应要求停止重试 search_code');
	});

	test('search_code 空结果但未达阈值 → 不追加 graph 引导', async () => {
		const tools = makeCtx({}, {
			searchContentBehavior: async () => '(no matches)',
			recordSearchCodeEmptyStreakBehavior: () => ({ streak: 1, shouldGuide: false }),
		});
		const out = await getTool(tools, 'search_code').handler({ query: 'SomeSymbol' });
		const txt = resultText(out);
		assert.ok(!txt.includes('STOP retrying'), '未达阈值不应出现 graph 引导');
		assert.ok(txt.includes('(no matches)'), '空结果原文应保留');
	});

	test('search_graph hasMore 时 TOON 输出尾部带 HINT 行（Continue 风格截断警告）', async () => {
		const tools = makeCtx({
			getProjectRoots: () => ({}),
			searchGraphAsync: async () => ({
				nodes: [{ id: 1, name: 'x', qualifiedName: 'p::x', type: 'function', filePath: 'a/b.cpp', startLine: 1 }],
				total: 100, hasMore: true,
			}),
		});
		const out = await getTool(tools, 'search_graph').handler({ query: 'x', limit: 1 });
		const txt = resultText(out);
		assert.ok(txt.includes('HINT: Results truncated'), `TOON 尾部应有 HINT 行，got:\n${txt}`);
		assert.ok(txt.includes('identifier|alternation'), 'HINT 应教模型用 alternation 缩小范围');
	});

	test('正则问题模式回传 regex warning（对齐 continue regexValidator）', async () => {
		const tools = makeCtx({}, captureCtx(() => { }, 'match line'));
		const out = await getTool(tools, 'search_code').handler({ query: '(?<=foo)bar', regex: true });
		assert.ok(resultText(out).includes('[regex]'), `应回传 regex warning，got: ${resultText(out)}`);
		assert.ok(resultText(out).includes('PCRE2'), 'lookbehind 应提示需 PCRE2');
	});
});

suite('codebase tool entries: export/import artifact (slim tier)', () => {

	test('export_artifact defaults slim=true and passes through slim=false', async () => {
		const calls: { path: string; opts: any }[] = [];
		const tools = makeCtx({
			exportArtifact: async (path: string, opts: any) => { calls.push({ path, opts }); return { size: 100, nodeCount: 2, edgeCount: 1 }; },
		});
		const tool = getTool(tools, 'export_artifact');
		const out1 = await tool.handler({ target_path: '/tmp/g1/graph.db.zst' });
		assert.strictEqual(parseJson(out1).slim, true, 'default should be slim');
		await tool.handler({ target_path: '/tmp/g2/graph.db.zst', slim: false });
		assert.deepStrictEqual(calls.map(c => c.opts), [{ slim: true }, { slim: false }]);
	});

	test('export_artifact without graph returns no-graph message', async () => {
		const tools = makeCtx({
			hasGraphData: () => false,
			tryLoadFromSqlite: async () => false,
			exportArtifact: async () => { throw new Error('should not be called'); },
		});
		const out = await getTool(tools, 'export_artifact').handler({ target_path: '/tmp/g/graph.db.zst' });
		assert.ok(resultText(out).includes('no graph loaded'));
	});

	test('import_artifact success returns summary; failure mentions integrity check', async () => {
		const okTools = makeCtx({
			importArtifact: async () => true,
			getIndexStatus: () => ({ nodeCount: 7, edgeCount: 3 }),
		});
		const okOut = await getTool(okTools, 'import_artifact').handler({ source_path: '/tmp/g/graph.db.zst' });
		const okJson = parseJson(okOut);
		assert.strictEqual(okJson.success, true);
		assert.strictEqual(okJson.nodeCount, 7);
		assert.strictEqual(okJson.edgeCount, 3);

		const failTools = makeCtx({ importArtifact: async () => false });
		const failOut = await getTool(failTools, 'import_artifact').handler({ source_path: '/tmp/g/graph.db.zst' });
		assert.ok(resultText(failOut).includes('integrity check'), `failure message should mention integrity check, got: ${resultText(failOut)}`);
	});
});

export {};
