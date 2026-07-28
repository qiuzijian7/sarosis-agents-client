/**
 * codebaseGraphArchitecture 测试（2026-07-27，日志 1785084338635 app 卡死修复）
 *
 * 覆盖两个卡死修复点：
 * 1. analyzePackages 的 edgeCount 从 O(P×E×N) 重写为 O(N+E)——语义等价性断言
 *    （任一端点属于该包的边计入；跨包边两端各计一次，同包边只计一次）。
 * 2. detectCommunities 大库规模保护——>30000 节点时跳过 Leiden，
 *    communities=[] 且 communitiesSkipped 带说明（分钟级主线程阻塞防护）。
 */
import assert from 'assert';
import { analyzeArchitecture } from '../../browser/codebaseGraphArchitecture.js';

// ─── 最小 store mock（analyzeArchitecture 仅使用 getAllNodes/getAllEdges） ───
function makeStore(nodes: any[], edges: any[]): any {
	return {
		getAllNodes: () => nodes,
		getAllEdges: () => edges,
	};
}

function makeNode(id: number, pkg: string, label: string = 'function'): any {
	return {
		id, name: `n${id}`, label,
		filePath: `${pkg}/file${id}.cpp`,
		project: 'P', startLine: 1, endLine: 10,
		inDegree: 1, outDegree: 1,
	};
}

suite('analyzePackages: O(N+E) 重写后的 edgeCount 语义等价（卡死修复 1785084338635）', () => {

	test('同包边只计一次、跨包边两端各计一次', async () => {
		// 结构：src 包节点 1,2；lib 包节点 3
		// 边：1→2（src 内）、1→3（跨包）、3→1（跨包）
		const nodes = [makeNode(1, 'src'), makeNode(2, 'src'), makeNode(3, 'lib')];
		const edges = [
			{ sourceId: 1, targetId: 2, type: 'CALLS', project: 'P' },   // src 内
			{ sourceId: 1, targetId: 3, type: 'CALLS', project: 'P' },   // src→lib 跨包
			{ sourceId: 3, targetId: 1, type: 'CALLS', project: 'P' },   // lib→src 跨包
		];
		const report = await analyzeArchitecture(makeStore(nodes, edges), 'P');
		const src = report.packages.find((p: any) => p.name === 'src');
		const lib = report.packages.find((p: any) => p.name === 'lib');
		assert.ok(src && lib, '两个 package 都应在报告中');
		// src：同包边(1→2) 计 1 + 两条跨包边各计 1 = 3
		assert.strictEqual(src.edgeCount, 3, `src edgeCount 应为 3（1 同包 + 2 跨包），got ${src.edgeCount}`);
		// lib：无同包边 + 两条跨包边各计 1 = 2
		assert.strictEqual(lib.edgeCount, 2, `lib edgeCount 应为 2（2 跨包），got ${lib.edgeCount}`);
	});

	test('端点不属于任何包的边不计数（无 filePath 节点）', async () => {
		const ghost = makeNode(9, 'src'); ghost.filePath = undefined;
		const nodes = [makeNode(1, 'src'), ghost];
		const edges = [{ sourceId: 1, targetId: 9, type: 'CALLS', project: 'P' }];
		const report = await analyzeArchitecture(makeStore(nodes, edges), 'P');
		const src = report.packages.find((p: any) => p.name === 'src');
		assert.strictEqual(src.edgeCount, 1, '仅源端属于 src 的边计 1 次');
	});
});

suite('detectCommunities: 大库规模保护（Leiden 分钟级阻塞防护）', () => {

	test('>30000 节点跳过社区检测，返回 communitiesSkipped 说明', async () => {
		const N = 30_001;
		const nodes: any[] = [];
		for (let i = 0; i < N; i++) { nodes.push(makeNode(i, 'pkg' + (i % 5))); }
		const report = await analyzeArchitecture(makeStore(nodes, []), 'P');
		assert.deepStrictEqual(report.communities, [], '大库 communities 应为空数组');
		assert.ok(typeof report.communitiesSkipped === 'string' && report.communitiesSkipped.includes('30000'),
			`应有 communitiesSkipped 说明，got: ${report.communitiesSkipped}`);
	});

	test('≤30000 节点正常跑社区检测（无 communitiesSkipped）', async () => {
		const nodes = [makeNode(1, 'a'), makeNode(2, 'a'), makeNode(3, 'b')];
		const edges = [{ sourceId: 1, targetId: 2, type: 'CALLS', project: 'P' }];
		const report = await analyzeArchitecture(makeStore(nodes, edges), 'P');
		assert.strictEqual(report.communitiesSkipped, undefined, '小库不应有跳过标记');
		assert.ok(Array.isArray(report.communities), '小库 communities 正常返回数组');
	});
});
