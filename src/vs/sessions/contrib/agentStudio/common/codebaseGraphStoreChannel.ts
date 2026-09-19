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
	/** WAL checkpoint（压缩 WAL，防读变慢） */
	checkpoint(): Promise<void>;
	/**
	 * ★★★ 2026-09-18（P1-1 第二步）：把当前图库导出为「**SQLite 快照**」制品（`VACUUM INTO` 到 targetPath）。
	 *
	 * 动机：制品格式是 gzip + JSON ⇒ 载入端必须**解析 JSON**（真机 3 folder ≈ **7320ms**）。而 SQLite
	 * 快照可被直接打开、按页取出 ⇒ 载入端**完全不解析 JSON** ✓。
	 * ⚠ 仅主进程能做（renderer 没有原生模块）；`targetPath` **必须不存在**（SQLite 规定）⇒ 调用方
	 * 写临时名再原子改名；失败必须可回退（旧的 JSON 制品路径保持不变）。
	 */
	exportSnapshot(targetPath: string): Promise<{ nodeCount: number; edgeCount: number }>;
	clear(): Promise<void>;
	deleteProject(project: string, opts?: { keepFileHashes?: boolean }): Promise<void>;

	/**
	 * **按需**空间回收（2026-09-19）：归还 SQLite freelist 并把库切到 `auto_vacuum=INCREMENTAL`。
	 *
	 * ⚠ 会在**宿主线程**（主进程）阻塞数秒~数十秒（全量 VACUUM）⇒ 只允许由显式维护动作调用，
	 *   不得挂在启动/索引路径上。低于阈值（freelist < 64MB）时默认跳过，返回 `skipped`。
	 */
	reclaimSpace(opts?: { force?: boolean; migrateToIncremental?: boolean }): Promise<{
		skipped?: 'below-threshold';
		beforeMb: number; afterMb: number; freedMb: number;
		freelistBeforeMb: number; freelistAfterMb: number;
		autoVacuumBefore: number; autoVacuumAfter: number;
	}>;
	/** 删除单文件所有节点/边/FTS（增量索引补丁用，替代全量重建），返回被删节点 id。 */
	deleteNodesByFile(project: string, filePath: string): Promise<number[]>;

	// ── 读 ──
	getNode(id: number): Promise<GraphNode | undefined>;
	getNodeByQN(project: string, qn: string): Promise<GraphNode | undefined>;
	getNodesByFile(project: string, filePath: string): Promise<GraphNode[]>;
	/**
	 * 全文/子串检索。`project` 传入时**下推到 SQL** 限定单项目（2026-09-15）——
	 * 缺省跨全部项目：SQLite 是跨工作区共享的持久层，跨库检索会让**候选池被历史工作区
	 * 的项目占满**（实测 needle="test" 的 231 条候选全是 S1Game/UE5EA，本项目命中不进池），
	 * 调用方（`searchGraphAsync`）必须传当前工作区的 project。
	 *
	 * @param excludeTypes 需要排除的节点类型（**非符号**容器/桩节点，2026-09-15）。
	 *   同样必须**下推到 SQL**：只在 renderer 后置过滤的话，`LIMIT` 已经先把符号丢掉了
	 *   —— Find Symbol 搜 `test` 时 200 条候选被 `label='file'` 的 `*.test.ts` 桩节点占满，
	 *   真正的符号根本不进池（与 project 完全同一条教训）。比较大小写不敏感。
	 *   约定值见 `common/codebaseIndexDefaults.ts` 的 `NON_SYMBOL_NODE_TYPES`。
	 *
	 * @param nameOnly 只匹配 `name` 列（**符号名检索**，2026-09-15）。FTS 索引含
	 *   `qualified_name`/`file_path`/`body` ⇒ 不限定列时搜 `test` 会命中 QN 里的
	 *   `…/classifyLLM.test.ts`（返回 `MockClassifyLLM`，用户截图报障）。
	 *   实现上会**跳过 FTS 直接走 `name LIKE`**（FTS 是词元匹配，`testHelper` 会被漏掉）。
	 */
	searchNodes(query: string, nodeType?: string, limit?: number, project?: string, excludeTypes?: readonly string[], nameOnly?: boolean): Promise<GraphNode[]>;
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
	/**
	 * 分页读节点。
	 * @param afterId **keyset 游标**（2026-09-16，第 4 参）：只返回 `id > afterId` 的行，优先于
	 *   `offset`。`LIMIT/OFFSET` 在大表上是 O(offset) 累计（每页从头跳过前 offset 行）⇒ 全量载入
	 *   必须用 keyset。返回项按 `id ASC` 稳定有序，调用方取**最后一项的 id** 作下一页游标。
	 */
	getAllNodes(project?: string, limit?: number, offset?: number, afterId?: number): Promise<GraphNode[]>;
	/** 分页读边。`afterId` 语义同 `getAllNodes`；返回的 `GraphEdge.id` 是行 id（**仅作游标**）。 */
	getAllEdges(project?: string, limit?: number, offset?: number, afterId?: number): Promise<GraphEdge[]>;

	// ─── ★★★ 2026-09-18（P1-1 步骤3）：**任意 SQLite 快照路径**的只读分页读取 ──────────────
	// 为什么要单独一组方法：上面那些读取方法都只作用于「本机缓存库」（host 里那一个 store 实例）；
	// 而「队友共享的制品 / 新机器冷启动」要读的是**用户目录里的 `graph.db.sqlite` 快照** ⇒
	// 必须按路径**另开一个只读实例**（renderer 没有原生模块，只能在主进程做）。
	// 语义与上面四个方法**逐一对应**（分页游标 `afterId` 口径也相同）。
	snapshotListProjects(dbPath: string): Promise<{ name: string; nodeCount: number; edgeCount: number }[]>;
	snapshotGetTotalNodeCount(dbPath: string, project?: string): Promise<number>;
	snapshotGetAllNodes(dbPath: string, project?: string, limit?: number, offset?: number, afterId?: number): Promise<GraphNode[]>;
	snapshotGetAllEdges(dbPath: string, project?: string, limit?: number, offset?: number, afterId?: number): Promise<GraphEdge[]>;
	/** 释放某个快照的只读实例（载入收尾时调用；不调用也不会立刻泄漏 —— 下次同路径会复用同一实例）。 */
	closeSnapshot(dbPath: string): Promise<void>;
	getNodeCount(project?: string): Promise<number>;
	/**
	 * ★★ 2026-09-19（**增量追平**）：本项目在 SQLite 里的**最大节点 id**（空表 / 无该项目 ⇒ 0）。
	 *
	 * 用途：内存 store 的节点 id **单调递增**，而全量同步（`_syncGraphToSqlite`）是**用内存 id 显式写入**的
	 * （见 `_syncIncrementalToSqlite` 头部的正确性前提 ✓）⇒ 「DB 里缺的节点」必然是 **id 大于 DB 现有 max**
	 * 的那一批 ✓。于是追平只需：一次标量查询 → 在内存里筛出 id > max 的节点 → **按文件**走既有增量补丁，
	 * 而不必 `deleteProject` + 重插整项目（实测全量 **128s** ✗✗）。
	 * ⚠ 若 DB 缺的是 **id ≤ max** 的节点（补丁删了却没插上就崩），本值**看不出来** ⇒ 调用方必须
	 * **补后再核一次节点数**，仍落后才回退全量 ✓（两步式，别只信一步）。
	 */
	getMaxNodeId(project: string): Promise<number>;
	/**
	 * ★★ 2026-09-19（P0-1）：**显式跨调用事务**（全量同步原子化）——
	 * `begin → deleteProject → 逐批 upsert → commit`；任一步抛错 ⇒ `abort`（ROLLBACK）。
	 * ⇒ 崩在中间 = **DB 原样** ✓✓（此前逐批各自 COMMIT ⇒ 崩在中间 = 项目残缺 ✗）。
	 * 三者**必须成对**（begin 之后必有 commit/abort ✓）。语义与风险见 store 头注 ✓。
	 */
	beginProjectSync(project: string): Promise<void>;
	commitProjectSync(project: string): Promise<void>;
	/** 回滚显式事务（幂等 ✓）。 */
	abortProjectSync(project: string): Promise<void>;
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
