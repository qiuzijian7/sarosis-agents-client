/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 主进程侧的 Codebase Graph SQLite channel 宿主。
 *
 * 在 electron-main 内持有 `CodebaseGraphSqliteStore`（原生 `@vscode/sqlite3`），
 * 通过 `registerChannel(CODEBASE_GRAPH_STORE_CHANNEL, this)` 暴露给 renderer；
 * renderer 侧经 `ProxyChannel.toService` 透明代理（见 `browser/codebaseGraphStoreProxy.ts`）。
 *
 * 对齐 `electron-main/llmMainChannel.ts` 的 `IServerChannel` 范式。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILoggerService } from '../../../../platform/log/common/log.js';
import { CodebaseGraphSqliteStore } from '../node/codebaseGraphSqliteStore.js';
import type { IGraphStoreOpenOptions } from '../node/codebaseGraphSqliteStore.js';
import { CODEBASE_GRAPH_STORE_CHANNEL } from '../common/codebaseGraphStoreChannel.js';
import type { GraphNode, GraphEdge } from '../browser/codebaseGraphService.js';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * 主进程 channel：把 `ICodebaseGraphSqliteBackend` 方法子集派发到 SQLite 存储。
 * 宿主构造在 main 进程，DB 在此进程内打开（renderer sandbox 不能加载原生模块）。
 */
export class CodebaseGraphStoreChannel<TContext> extends Disposable implements IServerChannel<TContext> {

	// 避免与 Disposable._store 字段名碰撞（TS2416 + TS4114 override）
	private readonly _sqliteStore = new CodebaseGraphSqliteStore();
	private _opened?: Promise<void>;
	private readonly _dbPath: string;

	/**
	 * ★★★ 2026-09-18（P1-1 步骤3）：**按路径**打开/缓存「只读快照」实例。
	 *
	 * 用途：读取队友共享的制品 / 新机器冷启动时的 `graph.db.sqlite` —— 它不是本机缓存库，
	 * 必须另开实例（只有主进程有原生 SQLite 模块）。语义与缓存库那套读取方法完全一致 ✓
	 * （复用同一个 `CodebaseGraphSqliteStore` 类，`open(path, { readOnly: true })` ⇒ `?mode=ro` ✓）。
	 */
	private readonly _snapshotStores = new Map<string, Promise<CodebaseGraphSqliteStore>>();

	/** 同一路径只打开一次；**打开失败不进缓存**（否则一个坏路径会让后续重试全部立刻失败 ✗）。 */
	private _snapshotStore(dbPath: string): Promise<CodebaseGraphSqliteStore> {
		let pending = this._snapshotStores.get(dbPath);
		if (!pending) {
			pending = (async () => {
				const store = new CodebaseGraphSqliteStore();
				await store.open(dbPath, { readOnly: true });
				return store;
			})();
			pending.catch(() => { this._snapshotStores.delete(dbPath); });
			this._snapshotStores.set(dbPath, pending);
		}
		return pending;
	}

	/** 释放只读快照实例（载入收尾调用）。 */
	private async _closeSnapshot(dbPath: string): Promise<void> {
		const pending = this._snapshotStores.get(dbPath);
		if (!pending) { return; }
		this._snapshotStores.delete(dbPath);
		try {
			const store = await pending;
			await store.close();
		} catch { /* 打不开的实例无需关闭 */ }
	}

	// 注：本宿主在 app.ts 手动构造（非 DI 容器），故 logger 以位置参数传入，不使用 @ILoggerService 装饰器。
	constructor(
		dbPath: string,
		private readonly _loggerService: ILoggerService,
	) {
		super();
		this._dbPath = dbPath;
	}

	private _log(level: LogLevel, msg: string, ...args: unknown[]): void {
		const logger = this._loggerService.getLogger('codebase-graph');
		if (!logger) { return; }
		if (level === 'error') { logger.error(msg, ...args); }
		else if (level === 'warn') { logger.warn(msg, ...args); }
		else { logger.info(msg, ...args); }
	}

	/** 惰性打开 DB：首个 IPC 调用时才 open，避免主进程启动期拖慢 */
	private _ensureOpened(): Promise<void> {
		if (!this._opened) {
			this._log('info', `Opening SQLite backend at ${this._dbPath}`);
			this._opened = this._sqliteStore.open(this._dbPath).catch(err => {
				this._log('error', 'Failed to open SQLite backend:', err);
				this._opened = undefined;
				throw err;
			});
		}
		return this._opened;
	}

	listen<T>(_ctx: TContext, _event: string): Event<T> {
		throw new Error('CodebaseGraphStoreChannel: events are not supported');
	}

	async call<T>(_ctx: TContext, command: string, args?: unknown[]): Promise<T> {
		await this._ensureOpened();
		const s = this._sqliteStore;
		switch (command) {
			case 'open': return s.open(args![0] as string, args![1] as IGraphStoreOpenOptions | undefined) as unknown as T;
			case 'close': return s.close() as unknown as T;
			case 'upsertNode': return s.upsertNode(args![0] as GraphNode & { id?: string | number }) as unknown as T;
			case 'upsertNodesBatch': return s.upsertNodesBatch(args![0] as (GraphNode & { id?: string | number })[]) as unknown as T;
			case 'upsertEdge': return s.upsertEdge(args![0] as GraphEdge & { sourceId?: number; targetId?: number }) as unknown as T;
			case 'upsertEdgesBatch': return s.upsertEdgesBatch(args![0] as (GraphEdge & { sourceId?: number; targetId?: number })[]) as unknown as T;
			case 'setFileHash': return s.setFileHash(args![0] as string, args![1] as Record<string, unknown>) as unknown as T;
			case 'getFileHash': return s.getFileHash(args![0] as string) as unknown as T;
			case 'setLayout': return s.setLayout(args![0] as number, args![1] as number, args![2] as number, args![3] as number) as unknown as T;
			case 'rebuildFTS': return s.rebuildFTS() as unknown as T;
			case 'clear': return s.clear() as unknown as T;
			case 'deleteProject': return s.deleteProject(args![0] as string, args![1] as { keepFileHashes?: boolean } | undefined) as unknown as T;
			case 'deleteNodesByFile': return s.deleteNodesByFile(args![0] as string, args![1] as string) as unknown as T;
			case 'checkpoint': return s.checkpoint() as unknown as T;
			// 显式维护：归还 freelist + 切 INCREMENTAL（阻塞数秒~数十秒，见 store 注释）
			case 'reclaimSpace': return s.reclaimSpace(args?.[0] as { force?: boolean; migrateToIncremental?: boolean } | undefined) as unknown as T;
			// ★ 2026-09-18（P1-1 第二步）：导出 SQLite 快照制品（VACUUM INTO）—— 载入端可跳过 JSON 解析
			case 'exportSnapshot': return s.exportSnapshot(args![0] as string) as unknown as T;
			// ─── ★★★ 2026-09-18（P1-1 步骤3）：按**任意路径**的只读快照实例分页读取 ───────────
			// 参数顺序统一为「dbPath 优先，其后与缓存库那套同名方法一一对应」✓
			case 'snapshotListProjects': return this._snapshotStore(args![0] as string).then(x => x.listProjects()) as unknown as T;
			case 'snapshotGetTotalNodeCount': return this._snapshotStore(args![0] as string).then(x => x.getTotalNodeCount(args![1] as string | undefined)) as unknown as T;
			case 'snapshotGetAllNodes': return this._snapshotStore(args![0] as string).then(x => x.getAllNodes(args![1] as string | undefined, args![2] as number | undefined, args![3] as number | undefined, args![4] as number | undefined)) as unknown as T;
			case 'snapshotGetAllEdges': return this._snapshotStore(args![0] as string).then(x => x.getAllEdges(args![1] as string | undefined, args![2] as number | undefined, args![3] as number | undefined, args![4] as number | undefined)) as unknown as T;
			case 'closeSnapshot': return this._closeSnapshot(args![0] as string) as unknown as T;
			case 'getNode': return s.getNode(args![0] as number) as unknown as T;
			case 'getNodeByQN': return s.getNodeByQN(args![0] as string, args![1] as string) as unknown as T;
			case 'getNodesByFile': return s.getNodesByFile(args![0] as string, args![1] as string) as unknown as T;
			// project 参数（第 4 位，2026-09-15）：下推到 SQL 限定单项目 —— 见 store 内 searchNodes 注释
			// excludeTypes 参数（第 5 位，2026-09-15）：下推到 SQL 排除非符号桩节点（同上）
			// nameOnly 参数（第 6 位，2026-09-15）：只匹配 name 列（符号名检索，同上）
			case 'searchNodes': return s.searchNodes(args![0] as string, args![1] as string | undefined, args![2] as number | undefined, args![3] as string | undefined, args![4] as readonly string[] | undefined, args![5] as boolean | undefined) as unknown as T;
			case 'semanticSearch': return s.semanticSearch(args![0] as string, args![1] as number | undefined) as unknown as T;
			case 'getEdges': return s.getEdges(args![0] as number | undefined, args![1] as number | undefined, args![2] as number | undefined) as unknown as T;
			case 'getTotalNodeCount': return s.getTotalNodeCount(args![0] as string | undefined) as unknown as T;
			case 'getTotalEdgeCount': return s.getTotalEdgeCount() as unknown as T;
			case 'getVisualizationNodes': return s.getVisualizationNodes(args![0] as number, args![1] as number, args![2] as string | undefined) as unknown as T;
			case 'getVisualizationEdges': return s.getVisualizationEdges(args![0] as number, args![1] as number) as unknown as T;
			case 'listProjects': return s.listProjects() as unknown as T;
			case 'getNodeTypes': return s.getNodeTypes(args![0] as string | undefined) as unknown as T;
			case 'getEdgeTypes': return s.getEdgeTypes(args![0] as string | undefined) as unknown as T;
			// afterId（第 4 位，2026-09-16）：keyset 分页游标，透传给 SQL 的 `id > ?`（见 store 内注释）
			case 'getAllNodes': return s.getAllNodes(args![0] as string | undefined, args![1] as number | undefined, args![2] as number | undefined, args![3] as number | undefined) as unknown as T;
			case 'getAllEdges': return s.getAllEdges(args![0] as string | undefined, args![1] as number | undefined, args![2] as number | undefined, args![3] as number | undefined) as unknown as T;
			case 'getNodeCount': return s.getNodeCount(args![0] as string | undefined) as unknown as T;
			// ★★ 2026-09-19（增量追平）：⚠ **本行是补上的** —— 真机验证时抓到的真 bug：
			// 只加了契约 + store 实现、漏了本分发器 ⇒ 运行期抛 `invalid call: getMaxNodeId` ✗
			// ⇒ renderer 静默降级回全量（128s）⇒ 优化等于没做 ✗✗。
			// 教训：这套「接口 → 分发器 → 实现」是**四方**一致（还有 ProxyChannel 的订阅侧），不是三方。
			case 'getMaxNodeId': return s.getMaxNodeId(args![0] as string) as unknown as T;
			// ★★ 2026-09-19（P0-1）：显式事务三方法 —— **四方一致**（契约 → 本分发器 → 实现 → 客户端 ✗✗，
			//   今天已抓过一次「只加契约+实现、漏了分发器」的真 bug ✓，这次一次到位 ✓）。
			case 'beginProjectSync': return s.beginProjectSync(args![0] as string) as unknown as T;
			case 'commitProjectSync': return s.commitProjectSync(args![0] as string) as unknown as T;
			case 'abortProjectSync': return s.abortProjectSync(args![0] as string) as unknown as T;
			case 'getTopNodesByDegree': return s.getTopNodesByDegree(args![0] as string, args![1] as number) as unknown as T;
			case 'getEdgesBetweenNodes': return s.getEdgesBetweenNodes(args![0] as number[]) as unknown as T;
			case 'getEdgesBySource': return s.getEdgesBySource(args![0] as number) as unknown as T;
			case 'grepContent': return s.grepContent(args![0] as string, args![1] as { project?: string; roots: string[]; filePattern?: string; limit?: number; useRegex?: boolean; maxFiles?: number }) as unknown as T;
			case 'listIndexedFilePaths': return s.listIndexedFilePaths(args![0] as string | undefined) as unknown as T;
		}
		throw new Error(`CodebaseGraphStoreChannel: invalid call: ${command}`);
	}
}

export { CODEBASE_GRAPH_STORE_CHANNEL };
