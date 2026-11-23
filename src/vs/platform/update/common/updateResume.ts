/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Windows Setup 包后台下载的**断点续传判据**（2026-11-23，纯逻辑、零 IO）。
 *
 * 真机背景：安装包实测约 477MB，慢网下一次下载被中断就得从头再来。原实现每次都把
 * `CodeSetup-<quality>-<version>.exe.tmp` 覆盖写，且 `cleanup()` 会先删掉它 ⇒ 完全没有续传。
 *
 * 口径（保守优先，任何不确定都退回全量下载）：
 *  · 只有 `.tmp` 与同批 `.tmp.meta`（记录 url / version / sha256）**同时**存在且匹配当前
 *    更新，才允许发 `Range` 请求；换版本 / 换地址 / 换包哈希 ⇒ 丢弃重下；
 *  · 服务端必须回 **206** 且 `Content-Range` 的起点等于本地已有字节数，否则回退全量；
 *  · 最终仍有 `checksum(downloadPath, sha256hash)` 兜底 —— 拼接错位一定装不进去；
 *  · 校验失败的 `.tmp` / `.meta` 必须删掉，避免坏前缀被反复续传。
 *
 * ⚠ 本文件不碰文件系统 / 网络，接入在 `electron-main/updateService.win32.ts`。
 */

export interface IResumeMeta {
	readonly url: string;
	readonly version: string;
	readonly sha256hash?: string;
}

export interface IResumeCandidate {
	readonly partialSize: number;
	readonly meta?: IResumeMeta;
}

export interface IResumeDecision {
	readonly mode: 'fresh' | 'resume';
	/** 已确认可保留的字节数；`fresh` 时 0。 */
	readonly size: number;
	readonly reason: string;
	readonly rangeHeader?: string;
}

/** 超过这个大小的残留文件一律不续传（宁可重下，也不拼一个可疑的大文件）。 */
export const MAX_RESUME_BYTES = 2 * 1024 * 1024 * 1024;

export function decideResume(
	partial: IResumeCandidate,
	update: { readonly url?: string; readonly version: string; readonly sha256hash?: string },
): IResumeDecision {
	const fresh = (reason: string): IResumeDecision => ({ mode: 'fresh', size: 0, reason });
	const meta = partial.meta;
	if (!meta) {
		return fresh('没有可信的续传标记，全量下载');
	}
	if (meta.version !== update.version) {
		return fresh('残留文件属于另一个版本，丢弃重下');
	}
	if (meta.url !== update.url) {
		return fresh('下载地址变了，丢弃重下');
	}
	if (meta.sha256hash && update.sha256hash && meta.sha256hash !== update.sha256hash) {
		return fresh('安装包校验值变了，丢弃重下');
	}
	const size = partial.partialSize;
	if (!Number.isFinite(size) || size <= 0 || size > MAX_RESUME_BYTES) {
		return fresh('残留文件大小不可信，丢弃重下');
	}
	return {
		mode: 'resume',
		size,
		reason: `从 ${size} 字节处续传`,
		rangeHeader: `bytes=${size}-`,
	};
}

/** 206 且 Content-Range 起点对得上，才允许追加写；其它一律回退全量。 */
export function acceptResumeResponse(statusCode: number, contentRange: string | undefined, expectedStart: number): boolean {
	if (statusCode !== 206 || !contentRange) {
		return false;
	}
	const m = /^bytes\s+(\d+)\s*-\s*\d+\s*\/\s*(\d+|\*)$/i.exec(contentRange.trim());
	if (!m) {
		return false;
	}
	return Number(m[1]) === expectedStart;
}

/** 边车元数据的信任边界：只认白名单字段，脏值整份丢弃。 */
export function validateResumeMeta(value: unknown): IResumeMeta | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const v = value as Record<string, unknown>;
	if (typeof v.url !== 'string' || !v.url || typeof v.version !== 'string' || !v.version) {
		return undefined;
	}
	return {
		url: v.url.slice(0, 2048),
		version: v.version.slice(0, 128),
		...(typeof v.sha256hash === 'string' && v.sha256hash ? { sha256hash: v.sha256hash.slice(0, 128) } : {}),
	};
}

/**
 * `cleanup()` 的保留判据：当前版本的成品、半成品与边车都要留下，
 * 其它版本（以及其它临时文件）照旧清理，避免缓存无限增长。
 */
export function shouldKeepPartialFile(fileName: string, quality: string, version: string): boolean {
	const base = `${quality}-${version}.exe`;
	return fileName.endsWith(base) || fileName.endsWith(`${base}.tmp`) || fileName.endsWith(`${base}.tmp.meta`);
}
