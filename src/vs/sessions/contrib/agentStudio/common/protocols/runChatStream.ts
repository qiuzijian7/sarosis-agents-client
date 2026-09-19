/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 聊天流式编排 —— renderer 与 Electron 主进程共享的单一实现来源。
 *
 * 背景（重构于 P0-1 第二阶段）：此前的编排逻辑（重试退避 → 读取流 → 切分行 →
 * 解析 → 收尾 done）在下列两处各有一份逐字重复的实现：
 *   - `browser/builtInBYOKModelProvider.ts`  `_streamChat` + `_sendRequestWithRetry`
 *   - `node/llmBridgeNode.ts`                `streamChatCompletions`
 *
 * 二者唯一的真实差异是「副作用如何落地」与「传输由谁执行」，
 * 均通过 {@link ChatStreamHooks} 注入，编排本身只有一份：
 *   - 直连路径：注入直连 `fetch`、VS Code `ILogService`、健康上报。
 *   - 主进程路径：注入 Node `fetch`（带 300s 超时与外部 signal 联动）、模块级 log 回调。
 *
 * 传输以 {@link ChatTransport} 注入而非写死 `fetch`，从而在不复制编排的前提下
 * 容纳两端的取消/超时语义差异。
 */

import type { IModelDelta } from '../providers.js';
import { AnthropicStreamState } from '../llmBridge.js';
import type { ParseMode } from './chatProtocol.js';
import {
	extractJsonPayload,
	extractUsage,
	parseContentFromJson,
	processRemainingBuffer,
	parseFullJsonFallback,
} from './sseParsers.js';

// ─── 重试配置（两端共用）──────────────────────────────────────────────────────

/** 可重试的 HTTP 状态码。 */
export const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

/** 最大重试次数（不含首次请求）。 */
export const DEFAULT_MAX_RETRIES = 3;

/** 指数退避基值（毫秒）。 */
export const BASE_RETRY_DELAY_MS = 1000;

// ─── 注入点 ──────────────────────────────────────────────────────────────────

/**
 * HTTP 传输函数。
 *
 * 两端语义不同，故注入而非内置：主进程侧需额外处理 300s 超时与外部 signal 联动，
 * 直连侧只做裸 `fetch`。实现方负责超时/取消细节，编排只关心「拿到或抛错」。
 */
export type ChatTransport = (request: {
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly body: string;
	readonly signal?: AbortSignal;
}) => Promise<Response>;

/** 健康状态回调（直连侧写 provider 健康标记，主进程侧仅记录）。 */
export type HealthFn = (status: 'healthy' | 'degraded' | 'unhealthy') => void;

/** 结构化日志回调。 */
export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

/**
 * 编排钩子 —— 两端差异化的副作用全部经此注入。
 *
 * 所有成员可选：未提供时使用无副作用的默认值，使编排本身保持纯粹。
 */
export interface ChatStreamHooks {
	readonly transport: ChatTransport;
	readonly log?: LogFn;
	readonly onHealth?: HealthFn;
	/** 缓存命中日志（原直连路径特有，主进程路径不传）。 */
	readonly onCacheHit?: (cachedTokens: number, inputTokens: number | undefined) => void;
	/** 错误信息前缀（如 `MyProvider: `），用于拼接用户可见错误文案。 */
	readonly errorPrefix?: string;
	/**
	 * 每个响应流 chunk 解码后回调（直连路径用于抓包对齐的响应日志；主进程路径不传）。
	 *
	 * 在解析前调用，因此回调方拿到的是原始 SSE 文本切片。
	 */
	readonly onResponseChunk?: (chunk: string, chunkIndex: number) => void;
	/**
	 * 流读取结束（正常或异常）后回调，携带本轮收集到的全部 chunk。
	 *
	 * 与 {@link onResponseChunk} 分开是为了让调用方在 finally 语义下写响应日志，
	 * 无论流是否正常结束都能落盘。
	 */
	readonly onResponseBodyComplete?: (chunks: readonly string[], modelId: string) => void;
}

/** 一次流式聊天的输入。 */
export interface ChatStreamInput {
	readonly url: string;
	readonly apiKey: string;
	readonly body: Record<string, unknown>;
	/** 附加请求头（如会话 id 头）；会覆盖同名默认头。 */
	readonly extraHeaders?: Record<string, string>;
	/** 外部取消信号。 */
	readonly signal?: AbortSignal;
	/** 鉴权方式 —— 取代由 `apiKeyHeader` 标志推定的旧写法。 */
	readonly auth: 'bearer' | 'x-api-key';
	/** 仅 `x-api-key` 时使用。 */
	readonly anthropicVersion?: string;
	/** 流式解析模式。 */
	readonly parseMode?: ParseMode;
}

// ─── 内部工具 ────────────────────────────────────────────────────────────────

/** 可被取消的延时；`signal` 中止时立即返回，使退避期间可被外部打断。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>(resolve => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/** 组装请求头：默认头 → 附加头 → 鉴权头（附加头可覆盖默认头，鉴权头优先级最高）。 */
function buildHeaders(input: ChatStreamInput): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		...(input.extraHeaders ?? {}),
	};
	if (!input.apiKey) {
		return headers;
	}
	if (input.auth === 'x-api-key') {
		headers['x-api-key'] = input.apiKey;
		if (!headers['anthropic-version']) {
			headers['anthropic-version'] = input.anthropicVersion || '2023-06-01';
		}
	} else {
		headers['Authorization'] = `Bearer ${input.apiKey}`;
	}
	return headers;
}

// ─── 主编排 ──────────────────────────────────────────────────────────────────

/**
 * 执行一次流式 chat completion：重试退避 → 流式解析 → 收尾 done。
 *
 * 这是 renderer 直连与主进程 IPC 两条路径共用的唯一实现。
 * 返回的生成器可被 `yield*` 委托（含返回值传递），error delta 已产出后即结束。
 *
 * @param input 请求参数（url/headers/body/取消信号）
 * @param hooks 传输与副作用注入点
 */
export async function* runChatStream(
	input: ChatStreamInput,
	hooks: ChatStreamHooks,
): AsyncGenerator<IModelDelta, void, unknown> {
	const { transport } = hooks;
	const log: LogFn = hooks.log ?? (() => { });
	const onHealth: HealthFn = hooks.onHealth ?? (() => { });
	const prefix = hooks.errorPrefix ?? '';
	const { signal } = input;

	const parseMode = input.parseMode ?? 'sse-openai';
	const anthropicState = parseMode === 'sse-anthropic' ? new AnthropicStreamState() : undefined;
	const headers = buildHeaders(input);
	const body = JSON.stringify(input.body);

	let lastError = '';

	for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
		if (signal?.aborted) {
			yield { type: 'error', error: 'Aborted' };
			return;
		}

		let response: Response;
		try {
			response = await transport({ url: input.url, headers, body, signal });
		} catch (err) {
			log('error', `fetch error: ${err}`);
			onHealth('unhealthy');
			if (attempt < DEFAULT_MAX_RETRIES) {
				const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
				log('info', `network error, retrying in ${delayMs}ms...`);
				await delay(delayMs, signal);
				continue;
			}
			yield { type: 'error', error: `${prefix}Network error — ${err}` };
			return;
		}

		if (response.ok) {
			onHealth('healthy');
			yield* readStream(response, anthropicState, body, hooks);
			return;
		}

		// 不可重试（如 401/403/404）：直接失败
		if (!RETRIABLE_STATUS_CODES.has(response.status)) {
			const text = await response.text().catch(() => '');
			log('error', `HTTP error (non-retriable): ${response.status} — ${text.slice(0, 500)}`);
			onHealth('unhealthy');
			yield { type: 'error', error: `${prefix}${response.status} ${response.statusText} — ${text.slice(0, 500)}` };
			return;
		}

		// 可重试（429/500/502/503）：尊重 Retry-After，否则指数退避
		const text = await response.text().catch(() => '');
		lastError = `${response.status} ${response.statusText} — ${text.slice(0, 500)}`;
		log('warn', `HTTP error (retriable): ${lastError}`);

		if (attempt < DEFAULT_MAX_RETRIES) {
			let delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
			const retryAfter = response.headers.get('Retry-After');
			if (retryAfter) {
				const parsed = parseInt(retryAfter, 10);
				if (!isNaN(parsed) && parsed > 0) {
					delayMs = parsed * 1000;
				}
			}
			onHealth('degraded');
			log('info', `retrying in ${delayMs}ms (attempt ${attempt + 1}/${DEFAULT_MAX_RETRIES})`);
			await delay(delayMs, signal);
		}
	}

	onHealth('unhealthy');
	log('error', `all retries exhausted, last error: ${lastError}`);
	yield { type: 'error', error: `${prefix}${lastError}` };
}

/**
 * 读取响应流并逐条产出 delta，末尾保证产出一个 `done`。
 *
 * 收尾 `done` 放在 `finally` 中：即使流中途抛错（已产出 error delta），
 * 也仍会冲刷 Anthropic 工具块并收尾，与重构前两处实现的行为一致。
 */
async function* readStream(
	response: Response,
	anthropicState: AnthropicStreamState | undefined,
	requestBody: string,
	hooks: ChatStreamHooks,
): AsyncGenerator<IModelDelta, void, unknown> {
	const log: LogFn = hooks.log ?? (() => { });
	const onHealth: HealthFn = hooks.onHealth ?? (() => { });

	const reader = response.body?.getReader();
	if (!reader) {
		yield { type: 'error', error: `${hooks.errorPrefix ?? ''}No response body` };
		return;
	}

	const decoder = new TextDecoder();
	let buffer = '';
	let sseDataFound = false;
	let fullBodyForFallback = '';
	let capturedResponseId: string | undefined;
	let capturedFinishReason: string | undefined;
	const responseChunks: string[] = [];
	let chunkIndex = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) { break; }

			const chunk = decoder.decode(value, { stream: true });
			buffer += chunk;
			fullBodyForFallback += chunk;

			// 抓包对齐：直连路径需要原始的逐 chunk SSE 文本（主进程路径不传回调，零开销）
			if (hooks.onResponseChunk) {
				chunkIndex++;
				responseChunks.push(chunk);
				hooks.onResponseChunk(chunk, chunkIndex);
			}

			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) { continue; }

				const jsonPayload = extractJsonPayload(trimmed);
				if (jsonPayload === null) { continue; }
				if (jsonPayload === '[DONE]') {
					sseDataFound = true;
					continue;
				}

				try {
					const parsed = JSON.parse(jsonPayload);
					sseDataFound = true;

					if (typeof parsed.id === 'string' && parsed.id) {
						capturedResponseId = parsed.id;
					}

					// 原生 Anthropic SSE：走专用解析器，不触碰 OpenAI 兼容路径
					if (anthropicState) {
						yield* anthropicState.push(parsed);
						continue;
					}

					const usageDelta = extractUsage(parsed, hooks.onCacheHit);
					if (usageDelta) { yield usageDelta; }

					const content = parsed.choices?.[0]?.delta || parsed.choices?.[0]?.message;
					if (!content) {
						const finishReason = parsed.choices?.[0]?.finish_reason;
						if (finishReason) { capturedFinishReason = finishReason; }
						continue;
					}
					yield* parseContentFromJson(content);
				} catch {
					log('warn', `malformed JSON line: ${jsonPayload.slice(0, 200)}`);
				}
			}
		}

		const remainingDeltas = processRemainingBuffer(buffer, anthropicState);
		if (remainingDeltas.length > 0) { sseDataFound = true; }
		yield* remainingDeltas;

		// 兜底：整个响应体不是 SSE（如网关退化为整段 JSON）
		if (!sseDataFound && fullBodyForFallback.trim()) {
			log('info', `no streaming data found, trying full JSON fallback (bodyLen=${fullBodyForFallback.length})`);
			yield* parseFullJsonFallback(fullBodyForFallback, anthropicState);
		}
	} catch (streamErr) {
		log('error', `stream read error: ${streamErr}`);
		onHealth('degraded');
		yield { type: 'error', error: `${hooks.errorPrefix ?? ''}Stream error — ${streamErr}` };
	} finally {
		// 抓包对齐：无论流正常结束还是抛错，都要落响应日志
		hooks.onResponseBodyComplete?.(responseChunks, requestBody);
		// 原生 Anthropic：工具块在此统一 flush，done 携带 responseId / stop_reason
		if (anthropicState) {
			yield* anthropicState.finish();
			return;
		}

		const doneDeltaBase: IModelDelta = capturedResponseId
			? { type: 'done', responseId: capturedResponseId }
			: { type: 'done' };
		const doneDelta: IModelDelta = capturedFinishReason
			? { ...doneDeltaBase, finishReason: capturedFinishReason }
			: doneDeltaBase;
		yield doneDelta;
	}
}
