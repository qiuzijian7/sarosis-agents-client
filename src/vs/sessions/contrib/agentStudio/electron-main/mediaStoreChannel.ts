/*---------------------------------------------------------------------------------------------
 *  主进程侧的媒体资产库 channel 宿主（生成图片管理，P1）。
 *
 *  对齐 kbSqliteStoreChannel 的 IServerChannel 范式：
 *  - electron-main 内持有 MediaStore（better-sqlite3 + fs）
 *  - registerChannel(MEDIA_STORE_CHANNEL, this) 暴露给 renderer
 *  - renderer 侧经 ProxyChannel.toService 透明代理（browser/mediaStoreProxy.ts）
 *--------------------------------------------------------------------------------------------*/

import { existsSync, promises as fsp, readFileSync } from 'fs';
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
	private _mediaStore: MediaStore | null;
	private _rootDir: string;
	/** 构造失败原因（better-sqlite3 原生绑定缺失等），透传给 renderer 便于定位。 */
	private _initError: string | undefined;

	constructor(
		defaultRootDir: string,
		private readonly configPath: string,
		private readonly _loggerService: ILoggerService,
	) {
		super();
		this._rootDir = this._loadPersistedRootDir(defaultRootDir);
		let store: MediaStore | null = null;
		try {
			store = new MediaStore({ rootDir: this._rootDir });
		} catch (err: any) {
			this._initError = err?.message || String(err);
			this._log('error', `MediaStore init failed: ${this._initError}`);
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

	/** 读取持久化的自定义根目录（configPath JSON `{ rootDir }`），无效则回退默认。 */
	private _loadPersistedRootDir(defaultRootDir: string): string {
		try {
			if (existsSync(this.configPath)) {
				const parsed = JSON.parse(readFileSync(this.configPath, 'utf8')) as { rootDir?: unknown };
				if (typeof parsed?.rootDir === 'string' && parsed.rootDir.trim()) {
					return parsed.rootDir.trim();
				}
			}
		} catch { /* 损坏配置忽略，回退默认 */ }
		return defaultRootDir;
	}

	private _persistRootDir(rootDir: string): void {
		// 异步落盘：调用方（`setRootDir`）是同步接口，而**主线程上的同步写**一旦撞上 I/O 卡死
		// （2026-10-12 三次现场都是 NtWriteFile 永不返回）就是整个 IDE 假死。内存里的 `_rootDir`
		// 才是权威值，配置文件只供下次启动读回 ⇒ 不必等它落盘，失败只记一条日志。
		void fsp.writeFile(this.configPath, JSON.stringify({ rootDir }, null, 2), 'utf8').catch(err => {
			this._log('warn', `persist media rootDir failed: ${(err as Error).message}`);
		});
	}

	getRootDir(): string {
		return this._rootDir;
	}

	/** 修改媒体库根目录：先试新目录能否打开（失败抛错、不破坏现有 store），成功后持久化。 */
	setRootDir(newDir: string): { rootDir: string } {
		const resolved = newDir.trim();
		if (!resolved) { throw new Error('媒体库路径不能为空'); }
		const store = new MediaStore({ rootDir: resolved });
		this._mediaStore = store;
		this._rootDir = resolved;
		this._persistRootDir(resolved);
		this._log('info', `media rootDir changed to: ${resolved}`);
		return { rootDir: resolved };
	}

	listen<T>(_: TContext, event: string): Event<any> { return Event.None; }

	/**
	 * 惰性（重新）打开 store。
	 *
	 * ★ 2026-10-19 真机事故：构造期一次 `disk I/O error`（磁盘瞬态 / 上次进程残留的 `-wal`/`-shm`）
	 *   之后，本 channel 就永远走 `!this._mediaStore` 分支 ⇒ **整个窗口**媒体库都读不到，
	 *   用户看到的只有「读取媒体库失败」（重启才好 ✗）。
	 *   ⇒ 每次调用先补一次；`MediaStore` 内部已做"失败关句柄 + 空 wal 清附属文件"的恢复，
	 *   所以这个重试是真的有机会成功，而不是空转。
	 */
	private _tryOpen(): MediaStore | null {
		try {
			const store = new MediaStore({ rootDir: this._rootDir });
			this._initError = undefined;
			this._log('info', `MediaStore opened (rootDir=${this._rootDir})`);
			return store;
		} catch (err: any) {
			this._initError = err?.message || String(err);
			this._log('error', `MediaStore open failed: ${this._initError}`);
			return null;
		}
	}

	async call(_ctx: TContext, command: string, args?: any[]): Promise<any> {
		if (!this._mediaStore) {
			this._mediaStore = this._tryOpen();
			if (!this._mediaStore) {
				throw new Error(`媒体库不可用：${this._initError ?? '未知原因'}`);
			}
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
				case 'getAsDataUrl':
					return this._mediaStore.getAsDataUrl(String(args?.[0] ?? ''));
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
				case 'setTags':
					await this._mediaStore.setTags(String(args?.[0] ?? ''), Array.isArray(args?.[1]) ? (args[1] as string[]) : []);
					return undefined;
				case 'listTags':
					return this._mediaStore.listTags();
				case 'localize':
					return this._mediaStore.localize(String(args?.[0] ?? ''));
				case 'stats':
					return this._mediaStore.stats();
				case 'purgeDeleted':
					return this._mediaStore.purgeDeleted();
				case 'cleanOrphaned':
					return this._mediaStore.cleanOrphaned();
				case 'getRootDir':
					return this.getRootDir();
				case 'setRootDir':
					return this.setRootDir(String(args?.[0] ?? ''));
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
