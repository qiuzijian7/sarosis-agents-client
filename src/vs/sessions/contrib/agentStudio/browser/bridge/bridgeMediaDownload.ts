/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 入站媒体（飞书图片 / 文件）的**二进制**下载出口。
 *
 * ## 为什么不能照抄 Telegram 的做法
 *
 * `platforms/telegram.ts#_downloadFile` 直接用渲染进程 `fetch` + `arrayBuffer()` ——
 * 对 Telegram 可行（简单 GET 不带 CORS 预检），但**飞书不行**：
 * 飞书 OpenAPI 不返回 CORS 头，桌面端 renderer（origin = `vscode-file://vscode-app`）直连会被拦，
 * 实测报 `net::ERR_FAILED`（详见 `platforms/feishu.ts` 文件头的两轮事故记录）。
 *
 * ## 为什么必须走 `binary: true`
 *
 * 主进程 HTTP 出口（`VSSAROS_LLM_CHANNEL#httpRequest`）的**文本**通路会按 UTF-8 解码响应体，
 * 二进制字节必然被破坏（`common/llmBridge.ts` 的注释原话：「文本路径的 `response.text()`
 * 会按 UTF-8 解码破坏字节」）。因此那里预留了 `binary: true` —— 主进程返回 base64 + contentType，
 * 本模块负责把它还原成 `Uint8Array` 交给 `InboundAttachment.data`。
 *
 * 装配侧用法（`bridge/bridge.contribution.ts`）：
 * ```ts
 * const downloadBinary = createMainProcessBinaryDownload(this._mainProcessService);
 * registerFeishuPlatformIfConfigured(..., downloadBinary);
 * ```
 * 未注入时飞书平台对媒体消息只投递占位文本（**不静默丢消息**）。
 */

import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { VSSAROS_LLM_CHANNEL, type IHttpRequestResult } from '../../common/llmBridge.js';

/** 二进制下载函数：给定 URL（+ 可选请求头如 Authorization）返回字节与 content-type。 */
export type BridgeBinaryDownload = (
	url: string,
	headers?: Record<string, string>,
) => Promise<{ bytes: Uint8Array; contentType?: string }>;

/** base64 → 字节。纯函数，渲染进程与测试都可用（不依赖 Node `Buffer`）。 */
export function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

/** 去掉 `; charset=utf-8` 之类的参数并 trim；无有效值 → undefined。 */
export function normalizeMime(contentType?: string): string | undefined {
	if (!contentType) { return undefined; }
	const mime = contentType.split(';')[0]?.trim();
	return mime && mime.length > 0 && mime.includes('/') ? mime : undefined;
}

/** 按扩展名猜 mime（下载响应没有 content-type 时用）；未知回退 image/png 或 application/octet-stream。 */
export function guessMimeFromName(fileName: string | undefined, kind: 'image' | 'file'): string {
	const fallback = kind === 'image' ? 'image/png' : 'application/octet-stream';
	if (!fileName) { return fallback; }
	const ext = /\.([a-z0-9]+)$/i.exec(fileName.trim())?.[1]?.toLowerCase();
	if (!ext) { return fallback; }
	const table: Record<string, string> = {
		png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
		webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
		pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
		json: 'application/json', zip: 'application/zip',
		doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', opus: 'audio/opus', ogg: 'audio/ogg',
		mp4: 'video/mp4', mov: 'video/quicktime',
	};
	return table[ext] ?? fallback;
}

/**
 * 构造主进程二进制下载器。
 * 主进程通道不可用（非 Electron / 通道未注册）时返回 undefined，调用方应降级。
 */
export function createMainProcessBinaryDownload(
	mainProcessService?: IMainProcessService,
): BridgeBinaryDownload | undefined {
	if (!mainProcessService) { return undefined; }
	let channel;
	try {
		channel = mainProcessService.getChannel(VSSAROS_LLM_CHANNEL);
	} catch {
		return undefined;
	}
	if (!channel) { return undefined; }

	return async (url: string, headers?: Record<string, string>) => {
		const r = await channel.call<IHttpRequestResult>('httpRequest', {
			url,
			method: 'GET',
			headers,
			// ★ 关键：走二进制通路（base64 返回）。不传则主进程按 UTF-8 解文本，字节被破坏。
			binary: true,
		});
		if (!r || !r.ok) {
			throw new Error(`HTTP ${r?.status ?? 0} ${r?.statusText ?? ''}`.trim());
		}
		if (typeof r.base64 !== 'string' || r.base64.length === 0) {
			throw new Error('响应缺少 base64（binary 通路未生效？）');
		}
		return { bytes: base64ToBytes(r.base64), contentType: r.contentType };
	};
}
