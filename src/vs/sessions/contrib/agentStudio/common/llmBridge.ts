/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * LLM bridge —— **renderer 与主进程共享的常量 / 类型 / 纯函数**。
 *
 * ## ★ 本文件禁止任何 Node 依赖（静态 import 与动态 import 皆禁）
 *
 * 本文件被 renderer 侧 6 处引用（`providerView` / `providerSettingsRenderer` /
 * `modelsDevCatalog` / `mainProcessModelProvider` / `builtInBYOKModelProvider` /
 * `agentStudio.contribution`），而 renderer 是 Chromium 沙箱、**无 Node**
 * （`windows.ts` 设 `sandbox: true`，`globalThis.require` 已被 amdX 换成 AMD shim）。
 *
 * 静态 `import * as nodeHttps from 'https'` 会在**模块加载时**立即解析，抛
 *   `TypeError: Failed to resolve module specifier "https"`
 * 并炸掉整个 sessions workbench 启动（`sessions.ts:136 load` uncaught）——
 * 2026-08-21 已真实发生过一次。
 *
 * 网络实现（`streamChatCompletions` / `discoverModels` / `httpRequest` /
 * `generateImage`）已迁至 `node/llmBridgeNode.ts`，只被
 * `electron-main/llmMainChannel.ts` 引用。**不要把它们搬回来。**
 */

import type { IModelDelta } from './providers.js';

// ⚠ 本文件位于 common/ 层，**禁止静态 import 任何 Node 内置模块**。
// 唯一需要 Node 的是 insecureHttpRequest（忽略 TLS 证书），已改为在函数内动态
// import —— 原因与事故记录见该函数注释。`URL` 用全局标准 API（renderer 与 Node
// 都内建），不要 `import { URL } from 'url'`。

/**
 * IPC channel name for routing LLM chat completions + model discovery to the
 * electron-main process (aligns with Void's `void-channel-llmMessage`).
 *
 * 设计意图：把"有副作用/需隔离"的 LLM 网络调用从 renderer 移到主进程，
 * 让 UI 渲染进程只做 agent loop 编排与流式展示，避免大响应流/网络抖动拖垮 UI。
 */
export const VSSAROS_LLM_CHANNEL = 'vssaros-llm';

/** 单次 chat 请求的流式参数（经 IPC 从 renderer 传到主进程）。 */
export interface ISarosisLlmChatRequest {
	readonly requestId: string;
	readonly url: string;
	readonly apiKey: string;
	readonly body: Record<string, unknown>;
	readonly extraHeaders?: Record<string, string>;
	/** Response/streaming format expected from the endpoint. */
	readonly responseFormat?: 'openai' | 'anthropic';
	/** API key auth header scheme. */
	readonly apiKeyHeader?: 'bearer' | 'x-api-key';
	/** `anthropic-version` header value, used when apiKeyHeader === 'x-api-key'. */
	readonly anthropicVersion?: string;
}

export type LogLevel = 'info' | 'warn' | 'error';

export type LogFn = (level: LogLevel, msg: string, ...args: unknown[]) => void;

// ─── 流式聊天（主进程侧执行）─────────────────────────────────────────────────

export interface IChatStreamParams {
	readonly url: string;
	readonly apiKey: string;
	readonly body: Record<string, unknown>;
	readonly extraHeaders?: Record<string, string>;
	readonly signal?: AbortSignal;
	readonly log?: LogFn;
	readonly onHealth?: (status: 'healthy' | 'degraded' | 'unhealthy') => void;
	/** Response/streaming format expected from the endpoint. */
	readonly responseFormat?: 'openai' | 'anthropic';
	/** API key auth header scheme. */
	readonly apiKeyHeader?: 'bearer' | 'x-api-key';
	/** `anthropic-version` header value, used when apiKeyHeader === 'x-api-key'. */
	readonly anthropicVersion?: string;
}

// ─── 通用 HTTP 代理（主进程侧执行）──────────────────────────────────────────

/**
 * 通用 HTTP 请求参数（经 IPC 从 renderer 传到主进程执行）。
 * 用于设置页「测试连接 / 查询模型」等一次性请求——renderer（origin
 * `vscode-file://vscode-app`）直连第三方网关会被 CORS preflight 拦截，
 * 主进程 Node fetch 无此限制。
 */
export interface IHttpRequestParams {
	readonly url: string;
	readonly method?: string;
	readonly headers?: Record<string, string>;
	readonly timeoutMs?: number;
	/**
	 * 二进制响应：body 以 base64 返回（`base64` + `contentType` 字段填充，
	 * `body` 为空）。用于下载图片等二进制资源——文本路径的 `response.text()`
	 * 会按 UTF-8 解码破坏字节。
	 */
	readonly binary?: boolean;
	/**
	 * 忽略 TLS 证书错误（如公司代理 MITM 导致 ERR_CERT_COMMON_NAME_INVALID）。
	 * 仅用于可信的第三方只读元数据查询（如 models.dev），不用于密钥请求。
	 */
	readonly insecure?: boolean;
}

export interface IHttpRequestResult {
	readonly ok: boolean;
	readonly status: number;
	readonly statusText: string;
	readonly body: string;
	/** 仅 `binary: true` 时填充：响应字节的 base64。 */
	readonly base64?: string;
	/** 仅 `binary: true` 时填充：响应 Content-Type（缺失回退空串）。 */
	readonly contentType?: string;
}

// ─── Provider 文生图结果 URL 内联（宿主边界统一转 b64）──────────────────────────
//
// ## 为什么必须内联（2026-09-01 事故）
//
// 部分文生图/图片编辑 provider（如内部 mjai 网关）返回**带签名的外部 URL**（腾讯
// COS 等），签名约 30 分钟过期，且服务器**不带 Access-Control-Allow-Origin**。
// webview 侧：
//  - `<img src>` 裸加载虽不受 CORS 限制，但任何 `crossOrigin='anonymous'` 的
//    canvas 消费方（12+ 处编辑器/合成器：CropEditor/MaskPainter/emojiTextOverlay
//    /layerEditor/cameraWidget…）直接被 CORS 拦截（用户报障 ERR_FAILED）；
//  - webview fetch 同样被拦 → **webview 侧无法自救**；
//  - 签名过期后连 `<img src>` 也会 403，图片永久丢失。
//
// 因此在宿主边界（`imagegen.generate` → `_handleImageGenGenerate`）**统一把
// http(s) URL 下载为 b64**：主进程 Node fetch 无 CORS、签名尚在有效期。下游
// `providerImagesToMedia` 优先读 url——内联成功时**必须删掉 url 字段**才会生成
// `data:` 引用。下载失败保留原 url（优雅降级 = 现状）。

/** 单条 provider 生成图（url 与 b64 二选一）。 */
export interface IProviderImageEntry {
	readonly url?: string;
	readonly b64?: string;
	readonly mime?: string;
}

/** 下载器注入接口（生产 = 主进程 IPC binary httpRequest；测试 = 桩）。 */
export type DownloadImageB64 = (url: string) => Promise<{ base64: string; contentType: string }>;

/** 视为「需要内联」的外部 http(s) 引用（data:/blob:/相对路径跳过）。 */
export function isRemoteHttpUrl(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

/** 内联单张上限（base64 前的字节数）。超过则保留原 url，避免主进程内存膨胀。 */
export const IMAGE_INLINE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * 把 provider 图片结果里的外部 http(s) URL 就地内联为 b64（纯函数，下载器注入）。
 * 规则：
 *  - `data:`/`blob:`/相对路径 → 原样保留；
 *  - http(s) → 调 `download`；成功 → `{ b64, mime }`（**删除 url**，下游才会走
 *    b64 分支）；失败/超限 → 保留原 url 并把错误计入 `failures`；
 *  - 绝不抛错（单张失败不影响其余图片与主流程）。
 */
export async function inlineRemoteImageUrls(
	images: IProviderImageEntry[],
	download: DownloadImageB64,
): Promise<{ images: IProviderImageEntry[]; failures: string[] }> {
	const failures: string[] = [];
	const out = await Promise.all(images.map(async (img): Promise<IProviderImageEntry> => {
		const url = img.url;
		if (!url || !isRemoteHttpUrl(url)) { return img; }
		try {
			const { base64, contentType } = await download(url);
			if (!base64) { throw new Error('empty body'); }
			const mime = /^image\//i.test(contentType) ? contentType : (img.mime || 'image/png');
			return { b64: base64, mime, url: undefined };
		} catch (err) {
			failures.push(`${url.slice(0, 120)}: ${err instanceof Error ? err.message : String(err)}`);
			return img; // 优雅降级：保留原 url（现状行为）
		}
	}));
	return { images: out, failures };
}

// ─── 文生图（主进程侧执行）───────────────────────────────────────────────────

/**
 * 文生图 / 图生图参数（OpenAI 兼容 `/images/generations` 或 `/images/edits` 端点）。
 */
export interface IImageGenBridgeParams {
	/** images endpoint URL，例如 `${baseUrl}/images/generations` */
	readonly url: string;
	readonly apiKey: string;
	/**
	 * 请求体（含 model/prompt/size/n 等）。
	 * ★ img2img 协议：body 若含 `__imageDataUrl`（data: 或 http(s) 图片引用），
	 *   主进程改走 **multipart/form-data** 的 `/images/edits`（image 字段=参考图，
	 *   其余字段转 form 字段），并剥离该标记。JSON 与 multipart 由本函数内部分派。
	 */
	readonly body: Record<string, unknown>;
	/** HTTP 方法（默认 POST；部分网关需 GET） */
	readonly method?: 'POST' | 'GET';
	readonly extraHeaders?: Record<string, string>;
	/** API key auth header scheme（默认 'bearer'） */
	readonly apiKeyHeader?: 'bearer' | 'x-api-key';
	readonly signal?: AbortSignal;
	readonly log?: LogFn;
}

/**
 * Infer whether a model supports text→image generation from its id/description.
 * Shared by renderer (BuiltInBYOKModelProvider) and main-process (discoverModels)
 * so both sides label the same models as image-gen capable.
 */
export function inferImageGen(m: { id?: string; name?: string; description?: string }): boolean {
	let hay = `${m.id ?? ''} ${m.name ?? ''} ${m.description ?? ''}`.toLowerCase();
	// Explicit generation phrases ("text to image", "image generation", …)
	if (/(text[- ]to[- ]image|image[- ]generation|image[- ]gen|generate[ -]images|text2image|t2i)/.test(hay)) {
		return true;
	}
	// Common text→image model markers (OpenAI dalle/gpt-image, Stability,
	// Flux, Seedream, Ideogram, Hunyuan image, etc.)
	//
	// `image` is listed as a standalone marker (not just as part of `gpt-image` /
	// `hunyuan_image`) so generic `*-image` naming is covered too — e.g. LightAI's
	// `gemini-3.1-flash-image` / `gemini-3-pro-image` (Nano Banana family).
	// The `(^|[^a-z])…([^a-z]|$)` boundaries keep it from matching chat models
	// that merely contain the substring (there are none in practice, since chat
	// models never use `image` as a standalone word).
	// `picture_` 前缀：LightAI 编排域图片模型命名（picture_banana_2 / picture_gpt_image_2 …）
	if (/(^|[^a-z])picture_[a-z0-9_]+/.test(hay)) { return true; }
	// LightAI 编排域其它前缀（model_/video_/audio_）的 id 即使尾部含 "image"
	//（如 model_hunyuan_polygen_image 图生低模，属 3D）也不是图片模型——
	// 先剥掉 id token 再做家族词匹配，避免 `image` 误伤。
	if (/(^|\s)(model|video|audio)_[a-z0-9_]+(\s|$)/.test(hay)) {
		hay = hay.replace(/(model|video|audio)_[a-z0-9_]+/g, ' ');
	}
	return /(^|[^a-z])(dall-?e|gpt-image|flux|stable-diffusion|sdxl|sd3|seedream|ideogram|imagen|recraft|kandinsky|sana|hunyuan[- _]image|kolors|pixart|nano[- _]?banana|image)([^a-z]|$)/.test(hay);
}

/**
 * Infer whether a model supports text/image→video generation from its id/name.
 * 与 inferImageGen 同款启发式：
 *  - LightAI 编排域命名规范：`video_*` 前缀（video_minimax_h3 / video_keling_26 …）
 *  - 常见视频模型名标记（kling/可灵、seedance、wan/wanx、hunyuan-video、minimax video…）
 *  - 显式生成短语（text-to-video / image-to-video / video generation …）
 */
export function inferVideoGen(m: { id?: string; name?: string; description?: string }): boolean {
	const hay = `${m.id ?? ''} ${m.name ?? ''} ${m.description ?? ''}`.toLowerCase();
	if (/(text[- ]to[- ]video|image[- ]to[- ]video|video[- ]generation|video[- ]gen|generate[ -]videos|text2video|i2v|t2v)/.test(hay)) {
		return true;
	}
	// `video_` 前缀（LightAI 编排域命名）：与 discoverFloodModels 的分类一致，
	// 前缀即品类（video_gemini_omni_flash / video_minimax_h3 的前缀后都是字母，
	// 不能加 `([^a-z]|$)` 后界，否则整批漏判）。
	if (/(^|[^a-z])video_[a-z0-9_]+/.test(hay)) { return true; }
	// 常见视频模型家族标记（非编排域命名）
	return /(^|[^a-z])(kling|keling|seedance|wanx?[- _]?[0-9]|hunyuan[- _]video|minimax[- _]video|video_gen|sora|veo|runway|gen-?3|luma|pika|hailuo)([^a-z]|$)/.test(hay);
}

/**
 * Infer whether a model supports text/image→3D asset generation from its id/name.
 * 与 inferVideoGen 同款启发式：
 *  - LightAI 编排域命名规范：`model_*` 前缀（model_hunyuan_3_5 / model_tropo_3_1 …）
 *  - 常见 3D 生成模型标记（tripo、rodin、hunyuan3d、meshy、luma ai…）
 */
export function inferModelGen(m: { id?: string; name?: string; description?: string }): boolean {
	const hay = `${m.id ?? ''} ${m.name ?? ''} ${m.description ?? ''}`.toLowerCase();
	if (/(image[- ]to[- ]3d|text[- ]to[- ]3d|3d[- ]generation|3d[- ]gen|generate[ -]3d|model[- ]gen)/.test(hay)) {
		return true;
	}
	// `model_` 前缀（LightAI 编排域命名）：前缀即品类，同 video_ 不加后界
	if (/(^|[^a-z])model_[a-z0-9_]+/.test(hay)) { return true; }
	// 常见 3D 生成模型家族标记（非编排域命名）
	return /(^|[^a-z])(tripo|rodin|hunyuan[- _]?3d|meshy|luma[- _]?ai|3d[_ -]model|instant[- _]?mesh|csm)([^a-z]|$)/.test(hay);
}

/**
 * Infer whether a model supports text→audio generation (TTS / music / sfx) from its id/name.
 * 与 inferVideoGen / inferModelGen 同款启发式：
 *  - LightAI 编排域命名规范：`audio_` 前缀（audio_speech_28 …）
 *  - 常见音频生成模型家族标记（speech、tts、voice、suno、audio）
 */
export function inferAudioGen(m: { id?: string; name?: string; description?: string }): boolean {
	const hay = `${m.id ?? ''} ${m.name ?? ''} ${m.description ?? ''}`.toLowerCase();
	if (/(text[- ]to[- ]audio|audio[- ]generation|audio[- ]gen|generate[ -]audio|t2a|tts\b|speech[- ]synth)/.test(hay)) {
		return true;
	}
	// `audio_` 前缀（LightAI 编排域命名）：前缀即品类，同 video_/model_ 不加后界
	if (/(^|[^a-z])audio_[a-z0-9_]+/.test(hay)) { return true; }
	// 常见语音/音频家族标记（非编排域命名）
	return /(^|[^a-z])(speech[- _]?[0-9]|minimax[- _]?speech|seed[- _]?audio|suno|cosyvoice|fish[- _]?speech|gpt[- _]?sovits)([^a-z]|$)/.test(hay);
}

// ─── Anthropic native SSE parser (shared by renderer + main process) ────────

/**
 * Stateful parser for native Anthropic Messages API SSE streams.
 * Converts Anthropic events (`message_start` / `content_block_*` / `message_delta`
 * / `message_stop`) into the engine's `IModelDelta` stream (text / thinking /
 * tool_call / usage / done). Tool-call arguments are accumulated across
 * `input_json_delta` chunks and flushed on `content_block_stop`.
 *
 * The OpenAI-compatible path is completely unaffected — this is only used when
 * `IBYOKProviderDefinition.responseFormat === 'anthropic'`.
 */
export class AnthropicStreamState {
	private readonly _blocks = new Map<number, { id: string; name: string; json: string }>();
	private _stopReason: string | undefined;
	private _responseId: string | undefined;
	private _flushed = false;

	push(parsed: any): IModelDelta[] {
		const out: IModelDelta[] = [];
		const t = parsed?.type;
		if (t === 'message_start') {
			const msg = parsed.message;
			if (msg?.id) { this._responseId = msg.id; }
			if (msg?.usage) {
				const u = _extractAnthropicUsage(msg.usage);
				if (u) { out.push(u); }
			}
		} else if (t === 'content_block_start') {
			const cb = parsed.content_block;
			if (cb?.type === 'tool_use') {
				this._blocks.set(parsed.index, { id: cb.id, name: cb.name, json: '' });
			}
		} else if (t === 'content_block_delta') {
			const d = parsed.delta;
			if (d?.type === 'text_delta') {
				out.push({ type: 'text', content: d.text });
			} else if (d?.type === 'thinking_delta') {
				out.push({ type: 'thinking', content: d.thinking });
			} else if (d?.type === 'input_json_delta') {
				const b = this._blocks.get(parsed.index);
				if (b) { b.json += (d.partial_json || ''); }
			}
		} else if (t === 'content_block_stop') {
			const b = this._blocks.get(parsed.index);
			if (b) {
				out.push({ type: 'tool_call', toolCall: { id: b.id, name: b.name, arguments: b.json || '{}' } });
				this._blocks.delete(parsed.index);
			}
		} else if (t === 'message_delta') {
			if (parsed.usage) {
				const u = _extractAnthropicUsage(parsed.usage);
				if (u) { out.push(u); }
			}
			if (parsed.delta?.stop_reason) { this._stopReason = parsed.delta.stop_reason; }
		} else if (t === 'message_stop') {
			// no-op; finish() handles final flush + done
		}
		return out;
	}

	finish(): IModelDelta[] {
		const out: IModelDelta[] = [];
		// flush any tool blocks not yet closed
		for (const b of this._blocks.values()) {
			out.push({ type: 'tool_call', toolCall: { id: b.id, name: b.name, arguments: b.json || '{}' } });
		}
		this._blocks.clear();
		if (!this._flushed) {
			this._flushed = true;
			const done: IModelDelta = (this._responseId || this._stopReason)
				? {
					type: 'done',
					...(this._responseId ? { responseId: this._responseId } : {}),
					...(this._stopReason ? { finishReason: this._stopReason } : {}),
				}
				: { type: 'done' };
			out.push(done);
		}
		return out;
	}
}

function _extractAnthropicUsage(u: any): IModelDelta | null {
	const inputTokens = u?.input_tokens;
	const outputTokens = u?.output_tokens;
	const cachedTokens = u?.cache_read_input_tokens;
	const cacheWriteTokens = u?.cache_creation_input_tokens;
	if (inputTokens !== undefined || outputTokens !== undefined || cachedTokens !== undefined || cacheWriteTokens !== undefined) {
		return { type: 'usage', usage: { inputTokens, outputTokens, cachedTokens, cacheWriteTokens } };
	}
	return null;
}
