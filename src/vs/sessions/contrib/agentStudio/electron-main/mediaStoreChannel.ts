/*---------------------------------------------------------------------------------------------
 *  主进程侧的媒体资产库 channel 宿主（生成图片管理，P1）。
 *
 *  对齐 kbSqliteStoreChannel 的 IServerChannel 范式：
 *  - electron-main 内持有 MediaStore（better-sqlite3 + fs）
 *  - registerChannel(MEDIA_STORE_CHANNEL, this) 暴露给 renderer
 *  - renderer 侧经 ProxyChannel.toService 透明代理（browser/mediaStoreProxy.ts）
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILoggerService } from '../../../../platform/log/common/log.js';
import { MediaStore } from '../node/mediaStore.js';
import type { MediaImportRequest, MediaListFilter } from '../common/mediaStoreChannel.js';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** 主进程 channel：把 IMediaBackend 方法派发到 MediaStore（文件 + SQLite）。 */
export class MediaStoreChannel<TContext> extends Disposable implements IServerChannel<TContext> {

	// 避免与 Disposable._store 字段名碰撞（TS2416 + TS4114）——与 CodebaseGraphStoreChannel._sqliteStore 对齐
	private readonly _mediaStore: MediaStore | null;

	constructor(
		rootDir: string,
		private readonly _loggerService: ILoggerService,
	) {
		super();
		let store: MediaStore | null = null;
		try {
			store = new MediaStore({ rootDir });
		} catch (err: any) {
			this._log('error', `MediaStore init failed: ${err?.message || String(err)}`);
		}
		this._mediaStore = store;
	}

	private _log(level: LogLevel, msg: string, ...args: unknown[]): void {
		const logger = this._loggerService.getLogger('media-store');
		if (!logger) { return; }
		if (level === 'error') { logger.error(msg, ...args); }
		else if (level === 'warn') { logger.warn(msg, ...args); }
		else if (level === 'info') { logger.info(msg, ...args); }
		else { logger.debug(msg, ...args); }
	}

	listen<T>(_: TContext, event: string): Event<any> { return Event.None; }

	async call(_ctx: TContext, command: string, args?: any[]): Promise<any> {
		if (!this._mediaStore) {
			throw new Error('media store unavailable (better-sqlite3 failed to load)');
		}
		try {
			switch (command) {
				case 'importAsset':
					return this._mediaStore.importAsset((args?.[0] ?? {}) as MediaImportRequest);
				case 'list':
					return this._mediaStore.list((args?.[0] ?? {}) as MediaListFilter);
				case 'get':
					return this._mediaStore.get(String(args?.[0] ?? ''));
				case 'getFilePath':
					return this._mediaStore.getFilePath(String(args?.[0] ?? ''));
				case 'remove':
					await this._mediaStore.remove(String(args?.[0] ?? ''));
					return undefined;
				case 'restore':
					await this._mediaStore.restore(String(args?.[0] ?? ''));
					return undefined;
				case 'setFavorite':
					await this._mediaStore.setFavorite(String(args?.[0] ?? ''), !!args?.[1]);
					return undefined;
				case 'setBoard':
					await this._mediaStore.setBoard(String(args?.[0] ?? ''), args?.[1] == null ? null : String(args[1]));
					return undefined;
				case 'stats':
					return this._mediaStore.stats();
				case 'purgeDeleted':
					return this._mediaStore.purgeDeleted();
				case 'enforceQuota':
					return this._mediaStore.enforceQuota((args?.[0] ?? {}) as { maxDays?: number; maxTotalBytes?: number });
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
		super.dispose();
	}
}
