/*---------------------------------------------------------------------------------------------
 *  主进程侧的 KB SQLite FTS5 channel 宿主。
 *
 *  对齐 `codebaseGraphStoreChannel.ts` 的 `IServerChannel` 范式：
 *  - 在 electron-main 内持有 `KbSqliteStore`（原生 better-sqlite3）
 *  - 通过 `registerChannel(KB_SQLITE_STORE_CHANNEL, this)` 暴露给 renderer
 *  - renderer 侧经 `ProxyChannel.toService` 透明代理
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILoggerService } from '../../../../platform/log/common/log.js';
import { KbSqliteStore } from '../node/kbSqliteStore.js';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * 主进程 channel：把 `IKbSqliteBackend` 方法派发到 SQLite 存储。
 * DB 在此进程内打开（renderer sandbox 不能加载原生 better-sqlite3）。
 */
export class KbSqliteStoreChannel<TContext> extends Disposable implements IServerChannel<TContext> {

	// 避免与 Disposable._store 字段名碰撞（TS2416 + TS4114）—— 与 CodebaseGraphStoreChannel._sqliteStore 对齐
	private readonly _sqliteStore = new KbSqliteStore();

	constructor(
		private readonly _dbPath: string,
		private readonly _loggerService: ILoggerService,
	) {
		super();
	}

	private _log(level: LogLevel, msg: string, ...args: unknown[]): void {
		const logger = this._loggerService.getLogger('kb-sqlite');
		if (!logger) { return; }
		if (level === 'error') { logger.error(msg, ...args); }
		else if (level === 'warn') { logger.warn(msg, ...args); }
		else if (level === 'info') { logger.info(msg, ...args); }
		else { logger.debug(msg, ...args); }
	}

	// IServerChannel — 无 listen 事件
	listen<T>(_: TContext, event: string): Event<any> { return Event.None; }

	async call(_ctx: TContext, command: string, args?: any[]): Promise<any> {
		try {
			switch (command) {
				case 'open': {
					const [dbPath, opts] = (args ?? []) as [string, { readOnly?: boolean } | undefined];
					const realPath = dbPath || this._dbPath;
					this._log('info', `open ${realPath}`);
					this._sqliteStore.open(realPath, opts);
					return undefined;
				}
				case 'close':
					this._sqliteStore.close();
					return undefined;
				case 'upsertDocsBatch':
					this._sqliteStore.upsertDocsBatch((args?.[0] ?? []) as any);
					return undefined;
				case 'deleteDoc':
					this._sqliteStore.deleteDoc(String(args?.[0] ?? ''));
					return undefined;
				case 'clear':
					this._sqliteStore.clear();
					return undefined;
				case 'search':
					return this._sqliteStore.search(String(args?.[0] ?? ''), Number(args?.[1] ?? 20));
				case 'getAllDocs':
					return this._sqliteStore.getAllDocs();
				case 'getDocCount':
					return this._sqliteStore.getDocCount();
				case 'getMaxMtime':
					return this._sqliteStore.getMaxMtime();
				case 'getAllUris':
					return this._sqliteStore.getAllUris();
				default:
					this._log('warn', `unknown command: ${command}`);
					return undefined;
			}
		} catch (err: any) {
			this._log('error', `${command} failed: ${err?.message || String(err)}`);
			throw err;
		}
	}

	override dispose(): void {
		try { this._sqliteStore.close(); } catch { /* ignore */ }
		super.dispose();
	}
}
