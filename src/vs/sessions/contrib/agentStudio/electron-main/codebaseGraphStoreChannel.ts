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
			case 'getNode': return s.getNode(args![0] as number) as unknown as T;
			case 'getNodeByQN': return s.getNodeByQN(args![0] as string, args![1] as string) as unknown as T;
			case 'getNodesByFile': return s.getNodesByFile(args![0] as string, args![1] as string) as unknown as T;
			case 'searchNodes': return s.searchNodes(args![0] as string, args![1] as string | undefined, args![2] as number | undefined) as unknown as T;
			case 'semanticSearch': return s.semanticSearch(args![0] as string, args![1] as number | undefined) as unknown as T;
			case 'getEdges': return s.getEdges(args![0] as number | undefined, args![1] as number | undefined, args![2] as number | undefined) as unknown as T;
			case 'getTotalNodeCount': return s.getTotalNodeCount(args![0] as string | undefined) as unknown as T;
			case 'getTotalEdgeCount': return s.getTotalEdgeCount() as unknown as T;
			case 'getVisualizationNodes': return s.getVisualizationNodes(args![0] as number, args![1] as number, args![2] as string | undefined) as unknown as T;
			case 'getVisualizationEdges': return s.getVisualizationEdges(args![0] as number, args![1] as number) as unknown as T;
			case 'listProjects': return s.listProjects() as unknown as T;
			case 'getNodeTypes': return s.getNodeTypes(args![0] as string | undefined) as unknown as T;
			case 'getEdgeTypes': return s.getEdgeTypes(args![0] as string | undefined) as unknown as T;
			case 'getAllNodes': return s.getAllNodes(args![0] as string | undefined, args![1] as number | undefined, args![2] as number | undefined) as unknown as T;
			case 'getAllEdges': return s.getAllEdges(args![0] as string | undefined, args![1] as number | undefined, args![2] as number | undefined) as unknown as T;
			case 'getNodeCount': return s.getNodeCount(args![0] as string | undefined) as unknown as T;
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
