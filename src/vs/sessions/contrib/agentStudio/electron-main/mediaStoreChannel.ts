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

/**
 * 「这件资产刚落进 IDE 库」的回执（供外部把同一份字节**再推一份**给 dsh 媒体库）。
 *
 * ★ 2026-10-26：媒体库真源已搬到 dsh 侧（`@vssaros/dsh-media` 的 `media-store/`），
 *   而 ComfyUI / 工作流的产出仍是 IDE 主进程写进自己的 `media.db`。
 *   这里只负责"发生时吱一声"，真正怎么推（HTTP + 认证 cookie）由 dshHarness 那边实现 ——
 *   本 channel **不依赖** dshHarness，接线在 `app.ts` 一处完成（依赖方向：壳 → 两个通道）。
 */
export interface IMediaDshPushInput {
	/** IDE 库里的资产 id（推送方用它当 `originId` ⇒ 与 dsh 的 `ideSync` 幂等） */
	readonly id: string;
	readonly filePath?: string;
	readonly fileName?: string;
	readonly kind?: string;
	readonly mime?: string;
	readonly ext?: string;
	readonly provider?: string;
	readonly metaJson?: string;
}

/** 主进程 channel：把 IMediaBackend 方法派发到 MediaStore（文件 + SQLite）。 */
export class MediaStoreChannel<TContext> extends Disposable implements IServerChannel<TContext> {

	// 避免与 Disposable._store 字段名碰撞（TS2416 + TS4114）——与 CodebaseGraphStoreChannel._sqliteStore 对齐
	private _mediaStore: MediaStore | null;
	private _rootDir: string;
	/** 构造失败原因（better-sqlite3 原生绑定缺失等），透传给 renderer 便于定位。 */
	private _initError: string | undefined;
	/** 「入库后顺手推给 dsh」的钩子（可选；见 {@link IMediaDshPushInput}）。 */
	private _dshPush: ((input: IMediaDshPushInput) => void) | undefined;

	/**
	 * 接线（`app.ts` 在建好 dshHarnessChannel 之后调一次）。
	 * ⚠ 钩子必须是**同步返回、内部自己 fire-and-forget** 的函数：这里绝不 await，
	 *   否则 dsh 的慢/死会把 IDE 自己的入库路径拖住。
	 */
	setDshPush(sink: (input: IMediaDshPushInput) => void): void {
		this._dshPush = sink;
	}

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
				case 'importAsset': {
					const request = (args?.[0] ?? {}) as MediaImportRequest;
					// ⚠ `MediaStore.importAsset` 是 **async**（落盘 + 下载远程 ref）⇒ 必须 await
					const asset = await this._mediaStore.importAsset(request);
					// ★ 2026-10-26：IDE 侧写完立刻**推一份**给 dsh 媒体库（真源）。
					//   失败/没有 Host 都只记日志 —— 调用方拿到的仍是 IDE 库里的那条（行为不变）。
					//   `originId` 用 IDE 资产 id（与 `ideSync` 同约定）⇒ 推过的不会再被 sync 插一条。
					try {
						this._dshPush?.({
							id: asset.id,
							filePath: asset.filePath,
							fileName: asset.fileName,
							kind: asset.kind,
							mime: asset.mime,
							provider: asset.provider,
							metaJson: request.metaJson,
						});
					} catch (err) {
						this._log('warn', `media push 钩子抛错（忽略）：${(err as Error)?.message ?? String(err)}`);
					}
					return asset;
				}
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
