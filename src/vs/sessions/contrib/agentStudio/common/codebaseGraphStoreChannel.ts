/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * renderer ↔ main 进程之间的 Codebase Graph SQLite 后端 IPC 契约（Phase 2 接线）。
 *
 * 图数据本体常驻 **main 进程**的 SQLite 文件（mmap，非 V8 堆），renderer 经此 channel
 * 只取「查询结果」/ 只发「写入请求」，从而绕开 renderer 的 V8 4GB 上限。
 *
 * 类型说明：契约复用以 `import type` 引入 `browser/codebaseGraphService.ts` 的
 * `GraphNode` / `GraphEdge` / `VisualizationNode`（纯数据结构，可 IPC 序列化）；
 * 因为是类型导入，编译期擦除，不会把 renderer 代码打进 main 进程 bundle。
 */

// 仅类型导入：esbuild/tsc 擦除，不引入 renderer 运行时依赖
import type { GraphNode, GraphEdge, VisualizationNode } from '../browser/codebaseGraphService.js';

/** main 进程注册的 channel 名（renderer 经 `mainProcessService.getChannel` 访问） */
export const CODEBASE_GRAPH_STORE_CHANNEL = 'vssaros-codebase-graph-store';

/** 文件哈希 IPC 负载（与内存 store 的 FileHash 同构，避免结构耦合） */
export interface IGraphFileHash {
	project: string;
	relPath: string;
	sha256: string;
	mtimeNs: number;
	size: number;
}

/**
 * renderer 侧看到的 SQLite 后端接口（= `node/codebaseGraphSqliteStore.ts` 的公开方法子集）。
 * 所有方法 async，参数与返回值均为 IPC 可序列化结构。
 */
export interface ICodebaseGraphSqliteBackend {
	open(dbPath: string, opts?: { mmapSizeBytes?: number; readOnly?: boolean }): Promise<void>;
	close(): Promise<void>;

	// ── 写 ──
	upsertNode(node: GraphNode & { id?: string | number }): Promise<number>;
	upsertNodesBatch(nodes: (GraphNode & { id?: string | number })[]): Promise<number[]>;
	upsertEdge(edge: GraphEdge & { sourceId?: number; targetId?: number }): Promise<void>;
	upsertEdgesBatch(edges: (GraphEdge & { sourceId?: number; targetId?: number })[]): Promise<void>;
	setFileHash(key: string, data: Record<string, unknown>): Promise<void>;
	getFileHash(key: string): Promise<Record<string, unknown> | undefined>;
	setLayout(nodeId: number, x: number, y: number, z: number): Promise<void>;
	rebuildFTS(): Promise<void>;
	clear(): Promise<void>;
	deleteProject(project: string, opts?: { keepFileHashes?: boolean }): Promise<void>;

	// ── 读 ──
	getNode(id: number): Promise<GraphNode | undefined>;
	getNodeByQN(project: string, qn: string): Promise<GraphNode | undefined>;
	getNodesByFile(project: string, filePath: string): Promise<GraphNode[]>;
	searchNodes(query: string, nodeType?: string, limit?: number): Promise<GraphNode[]>;
	semanticSearch(query: string, limit?: number): Promise<{ node: GraphNode; score: number }[]>;
	getEdges(nodeId?: number, offset?: number, limit?: number): Promise<GraphEdge[]>;
	getTotalNodeCount(project?: string): Promise<number>;
	getTotalEdgeCount(): Promise<number>;
	getVisualizationNodes(offset: number, limit: number, project?: string): Promise<{ nodes: VisualizationNode[]; total: number }>;
	getVisualizationEdges(offset: number, limit: number): Promise<GraphEdge[]>;
	listProjects(): Promise<{ name: string; nodeCount: number; edgeCount: number }[]>;
	getNodeTypes(project?: string): Promise<Record<string, number>>;
	getEdgeTypes(project?: string): Promise<Record<string, number>>;

	// ── 读（Phase 2b 新增，对齐内存 store API 以支持翻转）──
	getAllNodes(project?: string, limit?: number, offset?: number): Promise<GraphNode[]>;
	getAllEdges(project?: string, limit?: number, offset?: number): Promise<GraphEdge[]>;
	getNodeCount(project?: string): Promise<number>;
	getTopNodesByDegree(project: string, maxNodes: number): Promise<GraphNode[]>;
	getEdgesBetweenNodes(ids: number[]): Promise<GraphEdge[]>;
	getEdgesBySource(nodeId: number): Promise<GraphEdge[]>;

	// ── 主进程流式 grep（P2）：内容不跨 IPC，只有命中行回传 ──
	// project 可选（2026-07-26）：缺省跨全部项目（多项目图谱下内容搜索系统性
	// 需要，如 S1Game+UE5EA）；传入时限定单项目（工具层 project 参数透传）。
	grepContent(query: string, opts: {
		project?: string;
		roots: string[];
		/** project→root 直拼映射（2026-07-26）：消除逐文件 existsSync 探测 IO */
		rootByProject?: Record<string, string>;
		filePattern?: string;
		limit?: number;
		useRegex?: boolean;
		maxFiles?: number;
		/** wall-clock 预算（2026-07-26）：跨项目大清单到点返回部分结果 */
		deadlineMs?: number;
	}): Promise<{ matches: { filePath: string; lineNo: number; text: string }[]; scannedFiles: number; totalFiles: number }>;

	/** 已索引文件清单（P1b，2026-07-26）：search_files target=files 快路径；project 缺省跨全部项目。 */
	listIndexedFilePaths(project?: string): Promise<{ filePath: string; project: string }[]>;
}
