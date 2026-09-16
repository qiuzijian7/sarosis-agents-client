/*---------------------------------------------------------------------------------------------
 *  codebaseGraphPersistence.test.ts — 图谱持久化单元测试（tdd）。
 *
 *  覆盖 2026-07-22 新增能力：
 *  - 双档导出：slim 档剔除 bm25/layout；全量档保留
 *  - 导入完整性校验：结构损坏/字段错误/悬挂边 >30% → 拒绝；artifact.json 计数不符 → 告警放行
 *  - slim 档加载后自动 rebuildBM25（否则 search_graph query 静默无结果）
 *
 *  运行：
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/test/browser/codebaseGraphPersistence.test.ts
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { GraphPersistence, IArrayParseStats, PARSE_BATCH_ELEMENTS, forEachArrayBatch } from '../../browser/codebaseGraphPersistence.js';
import { CodebaseGraphStore } from '../../browser/codebaseGraphStore.js';

const PROJECT = 'test';
const TARGET = '/work/.codebase-memory/graph.db.zst';

/** 内存文件系统（GraphPersistence 仅需 writeFile/readFile/move/del/stat）。 */
class MemFS {
	readonly files = new Map<string, Uint8Array>();
	private _norm(uri: URI): string { return uri.fsPath.replace(/\\/g, '/'); }

	async writeFile(uri: URI, buf: VSBuffer): Promise<void> {
		this.files.set(this._norm(uri), new Uint8Array(buf.buffer));
	}
	async readFile(uri: URI): Promise<{ value: VSBuffer }> {
		const b = this.files.get(this._norm(uri));
		if (!b) { throw new Error(`ENOENT: ${this._norm(uri)}`); }
		return { value: VSBuffer.wrap(b) };
	}
	async move(src: URI, dst: URI): Promise<void> {
		const b = this.files.get(this._norm(src));
		if (!b) { throw new Error(`ENOENT: ${this._norm(src)}`); }
		this.files.set(this._norm(dst), b);
		this.files.delete(this._norm(src));
	}
	async del(uri: URI): Promise<void> { this.files.delete(this._norm(uri)); }
	async stat(uri: URI): Promise<any> {
		const b = this.files.get(this._norm(uri));
		if (!b) { throw new Error(`ENOENT: ${this._norm(uri)}`); }
		return { size: b.length, mtime: 1, isFile: true, isDirectory: false };
	}
	get(path: string): Uint8Array | undefined { return this.files.get(path); }
	set(path: string, bytes: Uint8Array): void { this.files.set(path, bytes); }
}

function makeLog() {
	const warns: string[] = [];
	return {
		warns,
		log: { info() { }, error() { }, debug() { }, trace() { }, warn(_t: string, m: string) { warns.push(m); } },
	};
}

function buildStore(): CodebaseGraphStore {
	const store = new CodebaseGraphStore();
	const a = store.upsertNode({ project: PROJECT, label: 'Function', name: 'auth', qualifiedName: 'auth', properties: {} });
	const b = store.upsertNode({ project: PROJECT, label: 'Function', name: 'login', qualifiedName: 'login', properties: {} });
	store.insertEdge({ project: PROJECT, sourceId: a.id, targetId: b.id, type: 'CALLS' });
	return store;
}

/** gzip 压缩（与 persistence 相同的纯 gzip 流格式）。 */
async function gzipText(text: string): Promise<Uint8Array> {
	const cs = new CompressionStream('gzip');
	const stream = new Blob([text]).stream().pipeThrough(cs);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(bytes: Uint8Array): Promise<string> {
	const ds = new DecompressionStream('gzip');
	const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
	return await new Response(stream).text();
}

function artifactJsonPath(target: string): string {
	return target.replace(/graph\.db\.\w+$/, 'artifact.json');
}

suite('GraphPersistence dual-tier export (slim vs full)', () => {

	test('full save keeps bm25; slim save strips bm25/layout', async () => {
		const fs = new MemFS();
		const p = new GraphPersistence(fs as any, makeLog().log as any);
		const store = buildStore();

		await p.save(store, TARGET, undefined);
		const fullJson = JSON.parse(await gunzipText(fs.get(TARGET)!));
		assert.ok(fullJson.bm25 !== null && fullJson.bm25 !== undefined, 'full tier should keep bm25');

		await p.save(store, TARGET, undefined, { slim: true });
		const slimJson = JSON.parse(await gunzipText(fs.get(TARGET)!));
		assert.strictEqual(slimJson.bm25, null, 'slim tier must strip bm25');
		assert.deepStrictEqual(slimJson.layout, [], 'slim tier must strip layout');
		assert.strictEqual(slimJson.nodes.length, 2, 'slim still keeps nodes');
		assert.strictEqual(slimJson.edges.length, 1, 'slim still keeps edges');
	});

	test('exportArtifact defaults to slim tier', async () => {
		const fs = new MemFS();
		const p = new GraphPersistence(fs as any, makeLog().log as any);
		await p.exportArtifact(buildStore(), TARGET);
		const json = JSON.parse(await gunzipText(fs.get(TARGET)!));
		assert.strictEqual(json.bm25, null, 'exportArtifact default should be slim');
	});

	test('exportArtifact slim=false keeps bm25', async () => {
		const fs = new MemFS();
		const p = new GraphPersistence(fs as any, makeLog().log as any);
		await p.exportArtifact(buildStore(), TARGET, { slim: false });
		const json = JSON.parse(await gunzipText(fs.get(TARGET)!));
		assert.ok(json.bm25 !== null, 'slim=false should keep bm25');
	});
});

suite('GraphPersistence import integrity check', () => {

	test('rejects structurally corrupt artifact (nodes not an array)', async () => {
		const fs = new MemFS();
		fs.set(TARGET, await gzipText(JSON.stringify({ nodes: { bad: 1 }, edges: [] })));
		const p = new GraphPersistence(fs as any, makeLog().log as any);
		const ok = await p.load(new CodebaseGraphStore(), TARGET);
		assert.strictEqual(ok, false, 'corrupt structure must be rejected');
	});

	test('rejects node with missing required fields', async () => {
		const fs = new MemFS();
		fs.set(TARGET, await gzipText(JSON.stringify({
			nodes: [{ id: 1 }],  // 缺 name/project
			edges: [],
		})));
		const p = new GraphPersistence(fs as any, makeLog().log as any);
		const ok = await p.load(new CodebaseGraphStore(), TARGET);
		assert.strictEqual(ok, false);
	});

	test('rejects artifact with >30% dangling edges', async () => {
		const fs = new MemFS();
		fs.set(TARGET, await gzipText(JSON.stringify({
			nodes: [
				{ id: 1, project: 'x', label: 'Function', name: 'a', qualifiedName: 'a', inDegree: 0, outDegree: 0 },
				{ id: 2, project: 'x', label: 'Function', name: 'b', qualifiedName: 'b', inDegree: 0, outDegree: 0 },
			],
			edges: [
				{ id: 1, project: 'x', sourceId: 1, targetId: 999, type: 'CALLS' },
				{ id: 2, project: 'x', sourceId: 998, targetId: 2, type: 'CALLS' },
				{ id: 3, project: 'x', sourceId: 997, targetId: 996, type: 'CALLS' },
			],
		})));
		const p = new GraphPersistence(fs as any, makeLog().log as any);
		const ok = await p.load(new CodebaseGraphStore(), TARGET);
		assert.strictEqual(ok, false, 'mostly-dangling edges must be rejected');
	});

	test('artifact.json count mismatch warns but still loads', async () => {
		const fs = new MemFS();
		const { log, warns } = makeLog();
		const p = new GraphPersistence(fs as any, log as any);
		await p.save(buildStore(), TARGET, undefined);
		// 篡改 meta 计数
		fs.set(artifactJsonPath(TARGET), new TextEncoder().encode(JSON.stringify({
			schema_version: 1, compression: 'gzip', original_size: 1, compressed_size: 1,
			node_count: 999, edge_count: 888, created_at: 'x',
		})));
		const store = new CodebaseGraphStore();
		const ok = await p.load(store, TARGET);
		assert.strictEqual(ok, true, 'meta mismatch should not block load');
		assert.ok(warns.some(w => w.includes('meta mismatch')), `expected meta mismatch warning, got ${JSON.stringify(warns)}`);
		assert.strictEqual(store.getNodeCount(), 2);
	});
});

suite('GraphPersistence slim artifact → BM25 auto-rebuild on load', () => {

	test('load of slim artifact triggers rebuildBM25 and BM25 search works', async () => {
		const fs = new MemFS();
		const p = new GraphPersistence(fs as any, makeLog().log as any);
		await p.save(buildStore(), TARGET, undefined, { slim: true });

		const store = new CodebaseGraphStore();
		let rebuilds = 0;
		// 必须透传参数：rebuildBM25(onProgress?, force?)，force=true 才是全量重建。
		// 早期 stub 写成 `async () => orig()` 丢掉了 force，slim 加载会走增量（脏集为空→空转），
		// BM25 索引为空，下方 search 断言失败。
		const orig = store.rebuildBM25.bind(store);
		store.rebuildBM25 = async (onProgress?: (done: number, total: number) => void, force?: boolean) => {
			rebuilds++;
			return orig(onProgress, force);
		};

		const ok = await p.load(store, TARGET);
		assert.strictEqual(ok, true);
		assert.strictEqual(rebuilds, 1, 'slim load must trigger exactly one BM25 rebuild');
		assert.strictEqual(store.getNodeCount(), 2);

		// BM25 重建后 query 检索可用
		const res = store.search({ project: PROJECT, query: 'auth', limit: 10 });
		assert.ok(res.total >= 1, `BM25 search should find 'auth' after rebuild, got total=${res.total}`);
	});

	test('load of full artifact does NOT rebuild BM25', async () => {
		const fs = new MemFS();
		const p = new GraphPersistence(fs as any, makeLog().log as any);
		await p.save(buildStore(), TARGET, undefined);

		const store = new CodebaseGraphStore();
		let rebuilds = 0;
		const orig = store.rebuildBM25.bind(store);
		store.rebuildBM25 = async (onProgress?: (done: number, total: number) => void, force?: boolean) => {
			rebuilds++;
			return orig(onProgress, force);
		};

		const ok = await p.load(store, TARGET);
		assert.strictEqual(ok, true);
		assert.strictEqual(rebuilds, 0, 'full artifact carries bm25 → no rebuild');
	});
});

suite('GraphPersistence streaming loader (special chars inside strings)', () => {

	test('streaming parse preserves braces/commas/quotes/backslashes inside node fields', async () => {
		const fs = new MemFS();
		const artifact = {
			nodes: [{
				id: 1, project: 'x', label: 'Function',
				// name 含反斜杠：扫描器须正确保留（路径归一化只作用于 filePath/qualifiedName，不动 name）
				name: 'a}b]c,d"e\\f', qualifiedName: 'a}b]c,d"e',
				filePath: 'src/a{b}c.ts', inDegree: 0, outDegree: 0,
				symbols: [{ name: 'sym"1', kind: 'fn' }],
			}],
			edges: [{ id: 1, project: 'x', sourceId: 1, targetId: 1, type: 'CALLS' }],
			fileHashes: [{ relPath: 'src/a{b}c.ts', hash: 'h', mtime: 1 }],
			bm25: null, layout: [], nextNodeId: 2, nextEdgeId: 2,
		};
		fs.set(TARGET, await gzipText(JSON.stringify(artifact)));
		const p = new GraphPersistence(fs as any, makeLog().log as any);
		const store = new CodebaseGraphStore();
		const ok = await p.load(store, TARGET);
		assert.strictEqual(ok, true, 'artifact with special chars in strings must load');
		const node = store.getNode(1);
		assert.ok(node, 'node 1 should be loaded');
		// name 含 { } , [ ] " 与反斜杠，扫描器须原样保留
		assert.strictEqual(node!.name, 'a}b]c,d"e\\f');
		assert.strictEqual(node!.qualifiedName, 'a}b]c,d"e');
		assert.strictEqual(node!.filePath, 'src/a{b}c.ts');
		assert.strictEqual(store.getEdgeCount(), 1);
	});

	test('streaming parse handles many nodes without blocking (round-trip count)', async () => {
		const fs = new MemFS();
		const nodes: any[] = [];
		for (let i = 1; i <= 5000; i++) {
			nodes.push({ id: i, project: 'x', label: 'Function', name: `fn${i}`, qualifiedName: `fn${i}`, inDegree: 0, outDegree: 0 });
		}
		fs.set(TARGET, await gzipText(JSON.stringify({ nodes, edges: [], fileHashes: [], bm25: null, layout: [], nextNodeId: 5001, nextEdgeId: 1 })));
		const p = new GraphPersistence(fs as any, makeLog().log as any);
		const store = new CodebaseGraphStore();
		const ok = await p.load(store, TARGET);
		assert.strictEqual(ok, true);
		assert.strictEqual(store.getNodeCount(), 5000, 'all 5000 nodes should stream-parse');
	});
});

/**
 * **批量解析**（2026-09-16，用户报「切换工作区卡住」的性能改动）。
 *
 * 事故数据：单 folder「解析 JSON」阶段 **10177ms**（合计 12369ms / 共 12372ms 的 merge）。
 * 旧实现是**逐元素** `json.slice()` + `JSON.parse()`（18 万次小解析），大头是搬运开销；
 * 改为按 `PARSE_BATCH_ELEMENTS` 一批、一次原生解析。
 *
 * ⚠ 风险面全在**批边界**上：切片范围是 `[首个元素起点, 末个元素终点]`，再补外层方括号。
 * 所以这里把「缩进/换行分隔」「嵌套结构」「字符串里含 `]` `,` `\"` `\\`」「跨多批」「空数组」
 * 逐项钉住 —— 任何一项错都会静默丢/重元素（数量对不上时才暴露）。
 */
suite('forEachArrayBatch — 批量解析（性能改动的不变量）', () => {

	const collect = async (arrayText: string): Promise<{ items: any[]; batches: number[] }> => {
		const items: any[] = [];
		const batches: number[] = [];
		// 传「去掉外层方括号的文本」即可：openIdx 指向 `[`、closeIdx 指向 `]` 之后一位
		// （与调用方 `vStart` / `vEnd` 同口径 —— 那是 `_skipJsonValue` 给出的值域）
		await forEachArrayBatch<any>(arrayText, 0, arrayText.length, batch => {
			batches.push(batch.length);
			for (const it of batch) { items.push(it); }
		});
		return { items, batches };
	};

	test('★★★ 跨多批 + 缩进换行 + 嵌套 + 特殊字符：必须与原生 JSON.parse 完全一致', async () => {
		const expected: any[] = [];
		const total = PARSE_BATCH_ELEMENTS * 2 + 7; // 刻意多出 7 个 ⇒ 末批不满，边界更容易露馅
		for (let i = 0; i < total; i++) {
			expected.push({
				id: i,
				// 字符串里塞满会干扰扫描器的字符：`]` `,` `"` `\` 与嵌套方括号
				name: i % 3 === 0 ? `n]${i},x"y\\z[${i}]` : `n${i}`,
				nested: [i, { k: `v${i}`, arr: [[i]] }],
			});
		}
		// 缩进 + 换行：元素之间不再是紧凑的 `,` —— 切片必须仍然合法 JSON
		const text = JSON.stringify(expected, null, 1);

		const { items, batches } = await collect(text);
		assert.deepStrictEqual(items, expected, '批解析结果必须与原生 JSON.parse 逐字段一致');
		assert.ok(batches.length >= 3, `共 ${total} 个元素 / 每批上限 ${PARSE_BATCH_ELEMENTS} ⇒ 应至少 3 批，实际 ${batches.length}`);
		for (const n of batches) {
			assert.ok(n > 0 && n <= PARSE_BATCH_ELEMENTS, `单批元素数必须在 (0, ${PARSE_BATCH_ELEMENTS}]：${n}`);
		}
	});

	test('★ 边界形态：空数组 / 单元素 / 前后空白 / 紧凑分隔', async () => {
		for (const text of ['[]', '[ ]', '[\n]', '[1]', '[ 1 , 2 ]', '[{"a":1},{"b":[2,3]}]']) {
			const { items } = await collect(text);
			assert.deepStrictEqual(items, JSON.parse(text), `形态 ${JSON.stringify(text)} 必须与原生一致`);
		}
	});

	test('★★ 诊断出参（stats）：必须报准元素数与批数（「解析分解」行的数据源）', async () => {
		const arrText = JSON.stringify(Array.from({ length: PARSE_BATCH_ELEMENTS + 3 }, (_, i) => ({ id: i })));
		const stats: IArrayParseStats = { elements: 0, scanMs: 0, parseMs: 0, batches: 0 };
		let got = 0;
		await forEachArrayBatch<any>(arrText, 0, arrText.length, items => { got += items.length; }, stats);
		assert.strictEqual(got, PARSE_BATCH_ELEMENTS + 3);
		assert.strictEqual(stats.elements, PARSE_BATCH_ELEMENTS + 3, '元素数必须与实际一致（否则「解析分解」行会误导）');
		assert.strictEqual(stats.batches, 2, '应恰好 2 批（边界 + 末批不满）');
		assert.ok(stats.scanMs >= 0 && stats.parseMs >= 0, '两类耗时都要有（哪怕极小）');
	});

	test('★★★ 返回值 = 数组终点：调用方据此**跳过「值边界扫描」**（省掉同一段文本的第二遍扫描）', async () => {
		// 这一条是 2026-09-16 第二轮优化的安全网：`_parseGraphStreaming` 现在**不再**为
		// nodes/edges/fileHashes 预先 `_skipJsonValue` 求值边界，而是直接用本函数的返回值推进游标。
		// 返回值错 1 个字符 ⇒ 后续键全部解析错位（且**不会**报错，只会静默丢数据）。
		for (const text of ['[]', '[ ]', '[1,2]', '[ 1 , 2 ]', '[{"a":1},{"b":[2,3]}]']) {
			const end = await forEachArrayBatch<any>(text, 0, text.length, () => { /* 只关心游标 */ });
			assert.strictEqual(text[end - 1], ']', `返回位置的前一个字符必须是闭合方括号：${JSON.stringify(text)} ⇒ ${end}`);
			assert.strictEqual(end, text.length, `孤立数组 ⇒ 终点应正好等于文本长度：${JSON.stringify(text)} ⇒ ${end}`);
		}

		// 真实形态：数组后面还有别的键 ⇒ 用返回的终点继续解析，必须正好落在**分隔逗号**上
		const json = '{"nodes":[{"id":1},{"id":2}],"edges":[{"id":9}],"fileHashes":[{"relPath":"a","hash":"h"}]}';
		const vStart = json.indexOf('[', json.indexOf('"nodes"'));
		let nodes = 0;
		const end = await forEachArrayBatch<any>(json, vStart, json.length, items => { nodes += items.length; });
		assert.strictEqual(nodes, 2);
		assert.strictEqual(json[end], ',', `终点之后必须是分隔逗号（多/少一个字符都会让后续键错位）：…${json.slice(Math.max(0, end - 2), end + 2)}…`);
	});

	test('★★ 真实载入路径：超过两批且带缩进的制品必须完整（批边界回归）', async () => {
		const fs = new MemFS();
		const nodes: any[] = [];
		const total = PARSE_BATCH_ELEMENTS * 2 + 3;
		for (let i = 1; i <= total; i++) {
			nodes.push({ id: i, project: 'x', label: 'Function', name: `fn${i}`, qualifiedName: `fn${i}`, inDegree: 0, outDegree: 0 });
		}
		fs.set(TARGET, await gzipText(JSON.stringify(
			{ nodes, edges: [], fileHashes: [], bm25: null, layout: [], nextNodeId: total + 1, nextEdgeId: 1 },
			null, 1,
		)));
		const p = new GraphPersistence(fs as any, makeLog().log as any);
		const store = new CodebaseGraphStore();
		assert.strictEqual(await p.load(store, TARGET), true);
		assert.strictEqual(store.getNodeCount(), total, '数量必须与外层一致（丢/重都会露馅）');
		// 批边界两侧逐个点名：首个 / 第 1 批末尾 / 第 2 批开头 / 第 2 批末尾 / 末个
		for (const id of [1, PARSE_BATCH_ELEMENTS, PARSE_BATCH_ELEMENTS + 1, PARSE_BATCH_ELEMENTS * 2, total]) {
			assert.ok(store.getNode(id), `批边界附近的节点 ${id} 不得丢或重`);
		}
	});
});

export {};
