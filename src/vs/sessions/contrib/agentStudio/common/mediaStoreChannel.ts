/*---------------------------------------------------------------------------------------------
 *  mediaStoreChannel.ts — 生成图片资产库契约（renderer ↔ 主进程 IPC）。
 *
 *  对齐 codebaseGraphStoreChannel / kbSqliteStoreChannel 的三端范式：
 *  本文件是 common（channel 名 + 接口）/ node（实现）/ browser（ProxyChannel 代理）
 *  唯一的类型与方法名来源。所有参数与返回值必须 IPC 可序列化。
 *
 *  存储模型（对齐 InvokeAI 资产库）：文件为主 + SQLite 元数据。
 *    - 文件：~/.vssaros/media/{yyyy}/{mm}/{id}.{ext}
 *    - 元数据：media.db 的 media_asset 表（better-sqlite3，主进程）
 *    - 软删除：is_deleted=1（回收站语义，restore 恢复）
 *--------------------------------------------------------------------------------------------*/

/** 主进程 channel 名（registerChannel / getChannel 共用）。 */
export const MEDIA_STORE_CHANNEL = 'vssaros-media-store';

// ─── 数据类型（IPC 可序列化）──────────────────────────────────────────

export interface MediaAsset {
	readonly id: string;
	/** 产生该资产的工作流 id（可为空 = 全局媒体库） */
	readonly workflowId?: string;
	/** 产生节点 id */
	readonly nodeId?: string;
	/** 'comfyui' | 'byok:<id>' | 'upload' | 'local' */
	readonly provider?: string;
	/** 'image' | 'video' | 'audio' | 'text' */
	readonly kind: string;
	/** 源引用：http(s) URL（ComfyUI /view 等）或本地文件相对名 */
	readonly ref: string;
	readonly fileName?: string;
	readonly mime?: string;
	/** 元数据 JSON：prompt/params/seed/model/width/height... */
	readonly metaJson?: string;
	/** unix 毫秒时间戳 */
	readonly createdAt: number;
	readonly sizeBytes?: number;
	readonly isDeleted: boolean;
	readonly board?: string;
	readonly favorite: boolean;
	/** 本地镜像文件的绝对路径（仅已落盘资产；其余为 URL 引用） */
	readonly filePath?: string;
}

// ─── 请求选项（全部可序列化）───────────────────────────────────────────

export interface MediaImportRequest {
	/** URL 引用（仅索引，不落盘）——ComfyUI /view、data URL、远端 http。 */
	ref?: string;
	/** base64 载荷：设置时解码落盘到 media 目录（本地镜像/上传）。 */
	base64?: string;
	/** 落盘扩展名（image → png/jpg/webp…）。 */
	ext?: string;
	kind?: string;
	mime?: string;
	workflowId?: string;
	nodeId?: string;
	provider?: string;
	metaJson?: string;
}

export interface MediaListFilter {
	workflowId?: string;
	provider?: string;
	kind?: string;
	/** 模糊匹配 fileName/ref/metaJson 文本 */
	query?: string;
	board?: string;
	favorite?: boolean;
	/** 默认 false：画廊只列未删除资产 */
	includeDeleted?: boolean;
	limit?: number;
	offset?: number;
}

export interface MediaListResult {
	readonly total: number;
	readonly items: MediaAsset[];
}

export interface MediaStats {
	readonly assetCount: number;
	readonly deletedCount: number;
	/** 未删除资产 meta.size_bytes 合计（仅落盘资产有值） */
	readonly totalBytes: number;
	/** media 目录实际磁盘占用（含缩略图等） */
	readonly dirSizeBytes: number;
}

export interface MediaQuotaResult {
	readonly removed: number;
	readonly freedBytes: number;
}

// ─── 后端接口（ProxyChannel 可代理的公开方法）─────────────────────────

export interface IMediaBackend {
	importAsset(entry: MediaImportRequest): Promise<MediaAsset>;
	list(filter: MediaListFilter): Promise<MediaListResult>;
	get(id: string): Promise<MediaAsset | null>;
	/** 本地文件绝对路径（URL 引用或文件缺失 → null）。 */
	getFilePath(id: string): Promise<string | null>;
	/** 把本地文件读成 data URL（webview 沙箱无法直接用本地路径，data URL 是唯一安全方式）。 */
	getAsDataUrl(id: string): Promise<string | null>;
	/** 软删除（回收站）。 */
	remove(id: string): Promise<void>;
	/** 从回收站恢复。 */
	restore(id: string): Promise<void>;
	setFavorite(id: string, favorite: boolean): Promise<void>;
	setBoard(id: string, board: string | null): Promise<void>;
	stats(): Promise<MediaStats>;
	/** 物理删除回收站资产（行 + 文件），返回清理数。 */
	purgeDeleted(): Promise<{ count: number; freedBytes: number }>;
	/**
	 * ★ 清理孤儿项：硬删 file_path 磁盘文件已缺失的活行（UI 表现为"不可用"）。
	 * app 重装 / rootDir 变化 / 外部删除文件时残留。返回清理数 + 释放的记录字节。
	 */
	cleanOrphaned(): Promise<{ count: number; freedBytes: number }>;
	/**
	 * 配额清理：按天龄/容量软删除最旧的未收藏、未分组资产，然后物理清理回收站。
	 * 任一维度缺省则不限制。返回清理数与释放字节数。
	 */
	enforceQuota(opts?: { maxDays?: number; maxTotalBytes?: number }): Promise<MediaQuotaResult>;
	/** 当前媒体库根目录（绝对路径）。 */
	getRootDir(): Promise<string>;
	/** 修改媒体库根目录（重新打开 SQLite + 后续资产落新目录）。返回新根目录。 */
	setRootDir(path: string): Promise<{ rootDir: string }>;
}
