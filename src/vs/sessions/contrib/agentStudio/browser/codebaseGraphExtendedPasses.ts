/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extended Pipeline Passes — 对标原版 C 项目缺失的 5 个 pass。
 *
 * P1-10: pass_usages — 变量/类型引用边 (USAGE)
 * P1-11: pass_semantic_edges — 语义相似边 (SEMANTICALLY_RELATED)
 * P1-12: pass_similarity — MinHash+LSH 近似克隆检测 (SIMILAR_TO)
 * P1-13: pass_tests — 测试文件/函数检测 (TESTS 边)
 * P1-14: gRPC/GraphQL/tRPC 服务调用检测 (GRPC_CALLS/GRAPHQL_CALLS/TRPC_CALLS)
 */

import { CodebaseGraphStore, GraphNode } from './codebaseGraphStore.js';

/** MinHash 排列数（签名长度）。48 在阈值 0.7 附近分辨率为 ~1/48，兼顾精度与存储。 */
export const MINHASH_PERM = 48;
// LSH 分带参数：48 维签名切成 12 band × 4 行（band 数决定召回率，行数由 48/12 决定）
const NUM_BANDS = 12;
const ROWS_PER_BAND = 4;

// ─── P1-10: pass_usages — 变量/类型引用边 ──────────────────────────────

export interface UsageEdge {
	sourceQN: string;   // 引用所在函数的 QN
	targetQN: string;   // 被引用的类型/变量名
	type: 'USAGE';
}

/**
 * 提取变量/类型引用边。
 * 从 AST 中检测 type_annotation, type_identifier, identifier 引用。
 */
export function extractUsages(rootNode: any, relPath: string): UsageEdge[] {
	const edges: UsageEdge[] = [];
	const enclosingFuncs: string[] = [];  // stack of enclosing function QNs

	function visit(node: any): void {
		// Track enclosing function
		if (node.type === 'function_declaration' || node.type === 'method_definition' || node.type === 'function_definition' || node.type === 'function_declaration') {
			const nameNode = node.childForFieldName('name');
			if (nameNode) {
				enclosingFuncs.push(`${relPath}::${nameNode.text}`);
			}
		}

		// Detect type annotations (TypeScript/Python type hints)
		if (node.type === 'type_annotation' || node.type === 'type_identifier' || node.type === 'type_hint') {
			const typeName = node.text;
			if (enclosingFuncs.length > 0 && typeName && typeName.length > 1) {
				edges.push({
					sourceQN: enclosingFuncs[enclosingFuncs.length - 1],
					targetQN: typeName,
					type: 'USAGE',
				});
			}
		}

		// Detect variable references in new expressions (class instantiation)
		if (node.type === 'new_expression' || node.type === 'object_creation_expression') {
			const callee = node.childForFieldName('class') || node.childForFieldName('type');
			if (callee && enclosingFuncs.length > 0) {
				edges.push({
					sourceQN: enclosingFuncs[enclosingFuncs.length - 1],
					targetQN: callee.text,
					type: 'USAGE',
				});
			}
		}

		for (const child of node.children || []) {
			visit(child);
		}

		// Pop enclosing function
		if (node.type === 'function_declaration' || node.type === 'method_definition' || node.type === 'function_definition') {
			enclosingFuncs.pop();
		}
	}

	visit(rootNode);
	return edges;
}

// ─── P1-11: pass_semantic_edges — 语义相似边 ───────────────────────────

export interface SemanticEdge {
	sourceQN: string;
	targetQN: string;
	type: 'SEMANTICALLY_RELATED';
	score: number;  // 0-1 similarity
}

/**
 * 构建语义相似边。
 * 基于函数名相似度 + 参数签名相似度。
 */
export function buildSemanticEdges(nodes: GraphNode[]): SemanticEdge[] {
	const edges: SemanticEdge[] = [];
	const functions = nodes.filter(n => n.label === 'function' || n.label === 'method');

	// Build name token index
	const tokenIndex: Map<string, number[]> = new Map();  // token → node indices
	for (let i = 0; i < functions.length; i++) {
		const tokens = tokenize(functions[i].name);
		for (const token of tokens) {
			if (!tokenIndex.has(token)) { tokenIndex.set(token, []); }
			tokenIndex.get(token)!.push(i);
		}
	}

	// For each function, find similar functions via shared tokens
	for (let i = 0; i < functions.length; i++) {
		const tokens = tokenize(functions[i].name);
		const candidates = new Set<number>();
		for (const token of tokens) {
			const indices = tokenIndex.get(token) || [];
			for (const idx of indices) {
				if (idx !== i) { candidates.add(idx); }
			}
		}

		for (const j of candidates) {
			if (j <= i) { continue; } // avoid duplicates
			const score = jaccardSimilarity(tokens, tokenize(functions[j].name));
			if (score >= 0.5) { // threshold
				edges.push({
					sourceQN: functions[i].qualifiedName,
					targetQN: functions[j].qualifiedName,
					type: 'SEMANTICALLY_RELATED',
					score,
				});
			}
		}
	}

	return edges;
}

// ─── P1-12: pass_similarity — MinHash+LSH 近似克隆检测 ──────────────────

export interface SimilarityEdge {
	sourceQN: string;
	targetQN: string;
	type: 'SIMILAR_TO';
	jaccardEstimate: number;  // 0-1
}

/**
 * MinHash 签名计算。
 * 用于快速近似 Jaccard 相似度，检测近似克隆代码。
 */
export class MinHash {
	private _hashFunctions: ((s: string) => number)[];
	private _numPerm: number;

	constructor(numPerm: number = MINHASH_PERM) {
		this._numPerm = numPerm;
		this._hashFunctions = [];
		// Generate hash functions: h_i(x) = (a_i * hash(x) + b_i) mod P
		const P = 2147483647; // large prime
		for (let i = 0; i < numPerm; i++) {
			const a = (i * 1103515245 + 12345) % P + 1;
			const b = (i * 6364136223846793005 + 1) % P;
			this._hashFunctions.push((s: string) => {
				const h = this._stringHash(s);
				return ((a * h + b) % P + P) % P;
			});
		}
	}

	/** Compute MinHash signature for a set of tokens */
	compute(tokens: string[]): number[] {
		const signature = new Array(this._numPerm).fill(Infinity);
		for (const token of tokens) {
			for (let i = 0; i < this._numPerm; i++) {
				const h = this._hashFunctions[i](token);
				if (h < signature[i]) { signature[i] = h; }
			}
		}
		return signature;
	}

	/** Estimate Jaccard similarity from two signatures */
	estimateSimilarity(sigA: number[], sigB: number[]): number {
		let matches = 0;
		for (let i = 0; i < this._numPerm; i++) {
			if (sigA[i] === sigB[i]) { matches++; }
		}
		return matches / this._numPerm;
	}

	private _stringHash(s: string): number {
		let hash = 0;
		for (let i = 0; i < s.length; i++) {
			hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
		}
		return Math.abs(hash);
	}
}

/**
 * 检测近似克隆代码。
 * 使用 MinHash + LSH (Locality-Sensitive Hashing) 快速查找相似函数。
 */
export function detectSimilarCode(nodes: GraphNode[], store: CodebaseGraphStore, threshold: number = 0.7): SimilarityEdge[] {
	const edges: SimilarityEdge[] = [];
	const minHash = new MinHash(MINHASH_PERM);

	// 读取解析期预计算的代码体 MinHash 签名（code-based，而非名字相似）。
	// 仅对拥有签名、且为函数/方法类型的节点做克隆检测。
	const signatures: Map<number, number[]> = new Map();
	const functions = nodes.filter(n =>
		(n.label === 'function' || n.label === 'method') &&
		Array.isArray((n.properties as any)?.minHash) &&
		((n.properties as any).minHash as number[]).length === MINHASH_PERM);

	for (const func of functions) {
		signatures.set(func.id, (func.properties as any).minHash as number[]);
	}

	// LSH: band-based candidate generation
	const numBands = 12;
	const rowsPerBand = 4;  // MINHASH_PERM(48) / 12 = 4
	const buckets: Map<string, number[]>[] = Array.from({ length: numBands }, () => new Map());

	for (const [nodeId, sig] of signatures) {
		for (let b = 0; b < numBands; b++) {
			const bandStart = b * rowsPerBand;
			const bandEnd = bandStart + rowsPerBand;
			const bandKey = sig.slice(bandStart, bandEnd).join(',');
			const bucket = buckets[b].get(bandKey) || [];
			bucket.push(nodeId);
			buckets[b].set(bandKey, bucket);
		}
	}

	// Generate candidates from LSH buckets
	const candidates = new Set<string>();
	for (const band of buckets) {
		for (const bucket of band.values()) {
			if (bucket.length < 2) { continue; }
			for (let i = 0; i < bucket.length; i++) {
				for (let j = i + 1; j < bucket.length; j++) {
					candidates.add(`${bucket[i]}:${bucket[j]}`);
				}
			}
		}
	}

	// Verify candidates with exact MinHash similarity
	for (const candidate of candidates) {
		const [idA, idB] = candidate.split(':').map(Number);
		const sigA = signatures.get(idA)!;
		const sigB = signatures.get(idB)!;
		const sim = minHash.estimateSimilarity(sigA, sigB);
		if (sim >= threshold) {
			const nodeA = store.getNode(idA);
			const nodeB = store.getNode(idB);
			if (nodeA && nodeB) {
				edges.push({
					sourceQN: nodeA.qualifiedName,
					targetQN: nodeB.qualifiedName,
					type: 'SIMILAR_TO',
					jaccardEstimate: sim,
				});
			}
		}
	}

	return edges;
}

/**
 * 增量克隆检测：只检测 `newNodeIds` 与全量节点之间的相似关系（新节点 vs 全量），
 * 跳过全量自配对。
 *
 * 为什么需要（2026-08-21，日志 1787282021811）：
 * `detectSimilarCode` 对传入的 nodes 做「nodes vs nodes」全配对——LSH 候选生成阶段
 * 每个 bucket 内部 O(n²) 配对 + 后续 MinHash 校验，对 12.4w 节点是同步无 yield 的重活。
 * 增量索引只改了 1 个文件，却调用无参全量版 → 每次保存都同步卡死 renderer 数秒。
 *
 * 语义正确性：SIMILAR_TO 是无向边且「旧↔旧」的克隆关系早在**全量索引**时已生成并
 * 落盘（insertEdge 按端点去重，幂等）。增量阶段只需补齐「新节点 ↔ 已有节点」的
 * 新克隆关系；新节点之间的克隆也由本函数覆盖（newNodeIds 内两两也会命中同一 bucket）。
 *
 * 实现与全量版同构：复用同一套 LSH bucket（全量签名索引），但候选生成只从
 * `newNodeIds` 出发查 bucket，复杂度从 O(全量²) 降到 O(新节点数 × bucket 平均大小)。
 *
 * 时间切片（2026-08-27）：即便降到了 O(新 × bucket)，**桶构建阶段仍是 O(全量函数数)**
 * 的 `slice().join(',')` 字符串操作，此前完全同步无 yield——12.4w 函数节点的建桶会
 * 独占主线程。现改为 async，桶构建与候选校验每 YIELD_EVERY 项让出一次主线程。
 *
 * 签名缓存：全量签名 Map 在同一图未大改时可跨轮复用，见 _signatureCache。
 * 由 store 的节点数变化驱动失效（保守：节点数变化即重建）。
 */
export async function detectSimilarCodeIncremental(
	newNodeIds: Set<number>,
	allNodes: GraphNode[],
	store: CodebaseGraphStore,
	threshold: number = 0.7,
): Promise<SimilarityEdge[]> {
	const edges: SimilarityEdge[] = [];
	const minHash = new MinHash(MINHASH_PERM);
	const YIELD_EVERY = 2000;

	// 全量函数签名 + LSH 桶（跨轮缓存）。2026-09-03：签名 Map 与桶都改为维护式增量
	// （旧实现：节点数一变即全量重建 Map + 全量建桶，+520 节点的轮次实测 2804ms）。
	const { signatures, entry } = getSignaturesCached(allNodes, store, newNodeIds);

	// 本次新增/变更节点里，有签名的函数节点才参与配对。
	// 直接从 newNodeIds 出发（O(新节点数)）；旧实现遍历全量签名 Map 逐个 getNode 再 filter，
	// 12.4w 项白扫一遍。
	const newFunctions: GraphNode[] = [];
	for (const id of newNodeIds) {
		if (signatures.has(id)) {
			const n = store.getNode(id);
			if (n) { newFunctions.push(n); }
		}
	}
	if (newFunctions.length === 0) { return edges; }

	const numBands = NUM_BANDS;
	const rowsPerBand = ROWS_PER_BAND;
	let buckets = entry.buckets;
	if (!buckets) {
		// 首次（或大规模删除后）：全量建桶（时间切片，避免独占主线程）
		buckets = Array.from({ length: numBands }, () => new Map<string, number[]>());
		let processed = 0;
		for (const [nodeId, sig] of signatures) {
			for (let b = 0; b < numBands; b++) {
				const bandKey = sig.slice(b * rowsPerBand, b * rowsPerBand + rowsPerBand).join(',');
				const bucket = buckets[b].get(bandKey);
				if (bucket) { bucket.push(nodeId); } else { buckets[b].set(bandKey, [nodeId]); }
			}
			if (++processed % YIELD_EVERY === 0) {
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}
		}
		entry.buckets = buckets;
	} else {
		// 增量插桶：只处理本轮签名有变动的 id（O(新节点数 × numBands)）。
		// 旧 band 条目残留无害：候选校验一律取 signatures 中的当前签名，
		// 已删除节点由 getNode 拦截；签名未变的重复条目被候选 Set 去重吸收。
		for (const id of newNodeIds) {
			const sig = signatures.get(id);
			if (!sig) { continue; }
			for (let b = 0; b < numBands; b++) {
				const bandKey = sig.slice(b * rowsPerBand, b * rowsPerBand + rowsPerBand).join(',');
				const bucket = buckets[b].get(bandKey);
				if (bucket) { bucket.push(id); } else { buckets[b].set(bandKey, [id]); }
			}
		}
	}

	// 只从新节点出发生成候选（与全量版相反的方向，语义等价且无向）
	const candidates = new Set<string>();
	for (const newFn of newFunctions) {
		const sig = signatures.get(newFn.id)!;
		for (let b = 0; b < numBands; b++) {
			const bandStart = b * rowsPerBand;
			const bandEnd = bandStart + rowsPerBand;
			const bandKey = sig.slice(bandStart, bandEnd).join(',');
			const bucket = buckets[b].get(bandKey) || [];
			for (const otherId of bucket) {
				if (otherId === newFn.id) { continue; }
				const a = Math.min(newFn.id, otherId);
				const b2 = Math.max(newFn.id, otherId);
				candidates.add(`${a}:${b2}`);
			}
		}
	}

	// 候选校验同样切片：哈希桶大的仓库（大量相似样板代码）候选可达数十万条
	let verified = 0;
	for (const candidate of candidates) {
		const [idA, idB] = candidate.split(':').map(Number);
		const sigA = signatures.get(idA)!;
		const sigB = signatures.get(idB)!;
		const sim = minHash.estimateSimilarity(sigA, sigB);
		if (sim >= threshold) {
			const nodeA = store.getNode(idA);
			const nodeB = store.getNode(idB);
			if (nodeA && nodeB) {
				edges.push({
					sourceQN: nodeA.qualifiedName,
					targetQN: nodeB.qualifiedName,
					type: 'SIMILAR_TO',
					jaccardEstimate: sim,
				});
			}
		}
		if (++verified % YIELD_EVERY === 0) {
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}
	}

	return edges;
}

/**
 * 全量函数签名缓存：nodeId → MinHash 签名。
 *
 * 增量索引每轮都要为 LSH 建桶而重建这张 12.4w 项的 Map（filter + 属性访问），
 * 属纯 CPU 且结果在「图未大改」时不变。
 *
 * 演进（2026-09-03）：旧判据「节点数变化即全量重建」在有新节点的增量轮次恒失效
 * （+520 节点 → 重建 12.4w 项 Map + 全量 LSH 建桶，实测 2804ms 占增量索引 84%）。
 * 改为**维护式增量**：变更节点的签名 upsert（函数体变了签名变；不再是函数/无签名则移除），
 * 仅当无缓存或节点数大幅下降（大规模删除，死 id 占比过高）才全量重建。
 * LSH 桶挂在同一缓存 entry 上：首次全量建，之后每轮只增量插入变更 id 的 band 条目。
 *
 * 缓存为模块级 WeakMap（键为 store 实例），避免多 project 互相污染与内存泄漏。
 */
const _signatureCache = new WeakMap<CodebaseGraphStore, {
	nodeCount: number;
	signatures: Map<number, number[]>;
	/** LSH 桶（NUM_BANDS 个 band → bandKey → nodeId[]）。首次构建后跨轮增量维护。 */
	buckets: Map<string, number[]>[] | undefined;
}>();

/** 判断节点是否为带有效 MinHash 签名的函数/方法节点。 */
function isSigNode(n: GraphNode): boolean {
	const p = n.properties as any;
	return (n.label === 'function' || n.label === 'method') &&
		Array.isArray(p?.minHash) && p.minHash.length === MINHASH_PERM;
}

function getSignaturesCached(
	allNodes: GraphNode[],
	store: CodebaseGraphStore,
	newNodeIds?: Set<number>,
): { signatures: Map<number, number[]>; entry: { nodeCount: number; signatures: Map<number, number[]>; buckets: Map<string, number[]>[] | undefined } } {
	const nodeCount = store.getNodeCount();
	let cached = _signatureCache.get(store);
	if (!cached || nodeCount < cached.nodeCount * 0.9) {
		// 无缓存，或大规模删除（死 id 残留占比过高）→ 全量重建；桶一并作废。
		const signatures = new Map<number, number[]>();
		for (const n of allNodes) {
			if (isSigNode(n)) { signatures.set(n.id, (n.properties as any).minHash as number[]); }
		}
		cached = { nodeCount, signatures, buckets: undefined };
		_signatureCache.set(store, cached);
		return { signatures, entry: cached };
	}
	// 增量维护：本轮变更节点的签名 upsert / 移除。已删除节点的死 id 保留在 Map 中
	// 无害（候选校验时 getNode 拦截），仅在下一轮全量重建时清理。
	if (newNodeIds && newNodeIds.size > 0) {
		for (const id of newNodeIds) {
			const n = store.getNode(id);
			if (n && isSigNode(n)) { cached.signatures.set(id, (n.properties as any).minHash as number[]); }
			else { cached.signatures.delete(id); }
		}
	}
	cached.nodeCount = nodeCount;
	return { signatures: cached.signatures, entry: cached };
}

// ─── P1-13: pass_tests — 测试文件/函数检测 ──────────────────────────────

export interface TestDetection {
	isTestFile: boolean;
	testFramework?: string;  // jest, mocha, pytest, go test, junit
	testFunctions: string[]; // QNs of test functions
}

/**
 * 检测测试文件和测试函数。
 *
 * 测试文件模式：
 * - *.test.ts, *.spec.ts, *.test.js, *.spec.js (Jest/Mocha)
 * - test_*.py, *_test.py (pytest)
 * - *_test.go (Go test)
 * - *Test.java, *Tests.java (JUnit)
 */
export function detectTests(filePath: string, rootNode: any): TestDetection {
	const fileName = filePath.split('/').pop() || filePath;
	const result: TestDetection = { isTestFile: false, testFunctions: [] };

	// Detect test framework from file name
	if (/\.test\.(ts|js|tsx|jsx)$/.test(fileName) || /\.spec\.(ts|js|tsx|jsx)$/.test(fileName)) {
		result.isTestFile = true;
		result.testFramework = 'jest';
	} else if (/^test_.*\.py$/.test(fileName) || /.*_test\.py$/.test(fileName)) {
		result.isTestFile = true;
		result.testFramework = 'pytest';
	} else if (/_test\.go$/.test(fileName)) {
		result.isTestFile = true;
		result.testFramework = 'go-test';
	} else if (/Test(s)?\.java$/.test(fileName)) {
		result.isTestFile = true;
		result.testFramework = 'junit';
	}

	// Detect test functions in AST
	if (result.isTestFile) {
		function visit(node: any): void {
			// Jest/Mocha: test(), it(), describe()
			if (node.type === 'call_expression') {
				const func = node.childForFieldName('function');
				if (func && (func.text === 'test' || func.text === 'it' || func.text === 'describe')) {
					const args = node.childForFieldName('arguments');
					if (args) {
						const firstArg = args.children[0];
						if (firstArg) {
							result.testFunctions.push(firstArg.text.replace(/['"]/g, ''));
						}
					}
				}
			}

			// Python: def test_*
			if (node.type === 'function_definition') {
				const nameNode = node.childForFieldName('name');
				if (nameNode && nameNode.text.startsWith('test_')) {
					result.testFunctions.push(nameNode.text);
				}
			}

			// Go: func Test*(t *testing.T)
			if (node.type === 'function_declaration') {
				const nameNode = node.childForFieldName('name');
				if (nameNode && nameNode.text.startsWith('Test')) {
					result.testFunctions.push(nameNode.text);
				}
			}

			// Java: @Test void method
			if (node.type === 'method_declaration') {
				const nameNode = node.childForFieldName('name');
				if (nameNode && (nameNode.text.startsWith('test') || nameNode.text.startsWith('should'))) {
					result.testFunctions.push(nameNode.text);
				}
			}

			for (const child of node.children || []) {
				visit(child);
			}
		}
		visit(rootNode);
	}

	return result;
}

// ─── P1-14: gRPC/GraphQL/tRPC 服务调用检测 ──────────────────────────────

export interface ServiceCallEdge {
	sourceQN: string;
	targetQN: string;
	type: 'GRPC_CALLS' | 'GRAPHQL_CALLS' | 'TRPC_CALLS';
	serviceName?: string;
	methodName?: string;
}

/**
 * 检测 gRPC/GraphQL/tRPC 服务调用。
 *
 * gRPC: 检测 .proto 文件中的 service/rpc 声明 + 客户端 stub 调用
 * GraphQL: 检测 query/mutation 字符串 + gql`` 模板标签
 * tRPC: 检测 trpc.router() + procedure 调用 (client.query/mutation)
 */
export function detectServiceCalls(rootNode: any, relPath: string, fileContent: string): ServiceCallEdge[] {
	const edges: ServiceCallEdge[] = [];

	// ── gRPC detection ──
	// .proto files: service FooService { rpc Bar(Request) returns (Response); }
	if (relPath.endsWith('.proto')) {
		const serviceRegex = /service\s+(\w+)\s*\{([^}]*)\}/g;
		let match;
		while ((match = serviceRegex.exec(fileContent)) !== null) {
			const serviceName = match[1];
			const body = match[2];
			const rpcRegex = /rpc\s+(\w+)\s*\(/g;
			let rpcMatch;
			while ((rpcMatch = rpcRegex.exec(body)) !== null) {
				edges.push({
					sourceQN: `${relPath}::${serviceName}`,
					targetQN: `${serviceName}.${rpcMatch[1]}`,
					type: 'GRPC_CALLS',
					serviceName,
					methodName: rpcMatch[1],
				});
			}
		}
	}

	// ── GraphQL detection ──
	// gql`query GetUsers { ... }` or gql`mutation CreateUser { ... }`
	const gqlRegex = /gql\s*`?\s*(query|mutation|subscription)\s+(\w+)/g;
	let gqlMatch;
	while ((gqlMatch = gqlRegex.exec(fileContent)) !== null) {
		edges.push({
			sourceQN: `${relPath}::${gqlMatch[2]}`,
			targetQN: gqlMatch[2],
			type: 'GRAPHQL_CALLS',
			methodName: gqlMatch[2],
		});
	}

	// ── tRPC detection ──
	// client.query('getUser') or client.mutation('createUser')
	const trpcRegex = /\.(query|mutation)\s*\(\s*['"`](\w+)['"`]/g;
	let trpcMatch;
	while ((trpcMatch = trpcRegex.exec(fileContent)) !== null) {
		edges.push({
			sourceQN: `${relPath}::tRPC`,
			targetQN: trpcMatch[2],
			type: 'TRPC_CALLS',
			methodName: trpcMatch[2],
		});
	}

	// ── AST-based gRPC client stub detection ──
	// TypeScript: client.sayHello(HelloRequest)
	function visit(node: any): void {
		if (node.type === 'call_expression') {
			const func = node.childForFieldName('function');
			if (func && func.type === 'member_expression') {
				const obj = func.childForFieldName('object');
				const prop = func.childForFieldName('property');
				if (obj && prop) {
					// Check if object name contains "Client" (common gRPC pattern)
					if (obj.text.includes('Client') || obj.text.includes('client')) {
						edges.push({
							sourceQN: `${relPath}::${obj.text}`,
							targetQN: `${obj.text}.${prop.text}`,
							type: 'GRPC_CALLS',
							methodName: prop.text,
						});
					}
				}
			}
		}
		for (const child of node.children || []) {
			visit(child);
		}
	}
	visit(rootNode);

	return edges;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function tokenize(name: string): string[] {
	if (!name) { return []; }
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_\-\.\/\\]/g, ' ')
		.split(/\s+/)
		.filter(w => w.length > 0)
		.map(w => w.toLowerCase());
}

function jaccardSimilarity(a: string[], b: string[]): number {
	const setA = new Set(a);
	const setB = new Set(b);
	let intersection = 0;
	for (const item of setA) {
		if (setB.has(item)) { intersection++; }
	}
	const union = setA.size + setB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
