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
}

// ─── 文生图（主进程侧执行）───────────────────────────────────────────────────

/**
 * 文生图参数（OpenAI 兼容 `/images/generations` 端点）。
 */
export interface IImageGenBridgeParams {
	/** images endpoint URL，例如 `${baseUrl}/images/generations` */
	readonly url: string;
	readonly apiKey: string;
	/** 请求体（含 model/prompt/size/n 等） */
	readonly body: Record<string, unknown>;
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
	const hay = `${m.id ?? ''} ${m.name ?? ''} ${m.description ?? ''}`.toLowerCase();
	// Explicit generation phrases ("text to image", "image generation", …)
	if (/(text[- ]to[- ]image|image[- ]generation|image[- ]gen|generate[ -]images|text2image|t2i)/.test(hay)) {
		return true;
	}
	// Common text→image model markers (OpenAI dalle/gpt-image, Stability,
	// Flux, Seedream, Ideogram, Hunyuan image, etc.)
	return /(^|[^a-z])(dall-?e|gpt-image|flux|stable-diffusion|sdxl|sd3|seedream|ideogram|imagen|recraft|kandinsky|sana|hunyuan[- _]image|kolors|pixart)([^a-z]|$)/.test(hay);
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
