/*---------------------------------------------------------------------------------------------
 *  mediaAssets.ts — 媒体资产库 webview 客户端（镜像 host 侧 mediaStoreChannel 契约）。
 *
 *  生成图片管理（P1）：资产元数据存主进程 media.db + 文件，webview 经 sendRequest
 *  走 host controller → ProxyChannel → 主进程 MediaStoreChannel。所有函数 IPC 可序列化。
 *--------------------------------------------------------------------------------------------*/

import { sendRequest } from '../../bridge/messageClient';

export interface MediaAsset {
	readonly id: string;
	readonly workflowId?: string;
	readonly nodeId?: string;
	readonly provider?: string;
	readonly kind: string;
	readonly ref: string;
	readonly fileName?: string;
	readonly mime?: string;
	readonly metaJson?: string;
	readonly createdAt: number;
	readonly sizeBytes?: number;
	readonly isDeleted: boolean;
	readonly board?: string;
	readonly favorite: boolean;
	readonly filePath?: string;
}

export interface MediaImportRequest {
	ref?: string;
	base64?: string;
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
	query?: string;
	board?: string;
	favorite?: boolean;
	includeDeleted?: boolean;
	limit?: number;
	offset?: number;
}

export interface MediaListResult {
	readonly total: number;
	readonly items: MediaAsset[];
}

export async function mediaImport(req: MediaImportRequest): Promise<MediaAsset> {
	return sendRequest<MediaImportRequest, MediaAsset>('media.import', req);
}

export async function mediaList(filter: MediaListFilter = {}): Promise<MediaListResult> {
	return sendRequest<MediaListFilter, MediaListResult>('media.list', filter);
}

export async function mediaGet(id: string): Promise<MediaAsset | null> {
	return sendRequest<{ id: string }, MediaAsset | null>('media.get', { id });
}

/** 把资产解析成 webview 可加载的 URL（本地镜像走 host 转换；http/data 原样）。 */
export async function resolveAssetUrl(a: MediaAsset): Promise<string | null> {
	if (/^(https?|data):/i.test(a.ref)) { return a.ref; }
	if (a.filePath) { return mediaGetUrl(a.id); }
	return null;
}

/** 本地镜像经 host 转 vscode-webview:// URL；URL 引用原样返回。 */
export async function mediaGetUrl(id: string): Promise<string | null> {
	return sendRequest<{ id: string }, string | null>('media.getUrl', { id });
}

export async function mediaRemove(id: string): Promise<void> {
	await sendRequest<{ id: string }, undefined>('media.remove', { id });
}

export async function mediaRestore(id: string): Promise<void> {
	await sendRequest<{ id: string }, undefined>('media.restore', { id });
}

export async function mediaSetFavorite(id: string, favorite: boolean): Promise<void> {
	await sendRequest<{ id: string; favorite: boolean }, undefined>('media.setFavorite', { id, favorite });
}

export async function mediaSetBoard(id: string, board: string | null): Promise<void> {
	await sendRequest<{ id: string; board: string | null }, undefined>('media.setBoard', { id, board });
}

export interface MediaStats {
	readonly assetCount: number;
	readonly deletedCount: number;
	readonly totalBytes: number;
	readonly dirSizeBytes: number;
}

export interface MediaPurgeResult {
	readonly count: number;
	readonly freedBytes: number;
}

export interface MediaQuotaResult {
	readonly removed: number;
	readonly freedBytes: number;
}

export async function mediaStats(): Promise<MediaStats | null> {
	return sendRequest<undefined, MediaStats | null>('media.stats', undefined);
}

export async function mediaPurgeDeleted(): Promise<MediaPurgeResult> {
	return sendRequest<undefined, MediaPurgeResult>('media.purgeDeleted', undefined);
}

export async function mediaEnforceQuota(opts?: { maxDays?: number; maxTotalBytes?: number }): Promise<MediaQuotaResult> {
	return sendRequest<{ maxDays?: number; maxTotalBytes?: number }, MediaQuotaResult>('media.enforceQuota', opts ?? {});
}
