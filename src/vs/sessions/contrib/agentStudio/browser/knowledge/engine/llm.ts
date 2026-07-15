/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — LLM structured-output adapter
 *
 *  Port of `langchain_core` `llm.with_structured_output(schema)` + the RAG `chat`
 *  completion. The original relies on LangChain's `with_structured_output`; here we
 *  speak directly to an OpenAI-compatible `/chat/completions` endpoint and coerce
 *  the model to emit JSON via (in priority order):
 *     1. `response_format: { type: 'json_schema', json_schema: {...} }`
 *     2. tool-calling with a single forced tool
 *     3. prompt-instructed JSON (lowest fidelity fallback)
 *
 *  This keeps the engine dependency-free (uses the platform `fetch`). A VS Code
 *  glue layer supplies credentials/URL from the existing provider configuration.
 *--------------------------------------------------------------------------------------------*/

import { JsonSchema } from './types.js';

export interface ChatModelOptions {
	/** Base URL of an OpenAI-compatible API, e.g. https://openrouter.ai/api/v1 */
	baseUrl: string;
	apiKey: string;
	/** Model id, e.g. openai/gpt-4o-mini */
	model: string;
	/** Optional organization / custom header passthrough. */
	headers?: Record<string, string>;
	/** Override fetch (testing / custom transport). */
	fetchImpl?: typeof fetch;
	/** Request timeout in ms (default 120000). */
	timeoutMs?: number;
	/** Emit warnings when a JSON-extraction strategy falls back. */
	verboseFallback?: boolean;
}

export interface ExtractRequest {
	system?: string;
	/** User prompt. Caller is responsible for `{var}` substitution. */
	prompt: string;
	schema: JsonSchema;
	temperature?: number;
	/** Optional external cancellation signal (merged with the timeout signal). */
	abortSignal?: AbortSignal;
}

/** Callback for streaming tokens. Return `true` to abort early. */
export type StreamTokenCallback = (token: string, accumulated: string) => boolean | void;

/**
 * The structured-LLM contract used by the engine. Decouples AutoType/OMem from
 * any concrete provider so the engine stays portable + testable.
 */
export interface IChatModel {
	/** Extract a JSON object conforming to `req.schema` from `req.prompt`. */
	extract<T = Record<string, unknown>>(req: ExtractRequest): Promise<T>;
	/** Free-form completion (used by RAG `chat`). Returns the answer text. */
	complete(system: string | undefined, user: string, temperature?: number): Promise<string>;
	/**
	 * Streaming completion (Phase 4.1). Calls `onToken` for each delta,
	 * returns the full accumulated text. If `onToken` returns `true`, abort early.
	 */
	streamComplete?(system: string | undefined, user: string, onToken: StreamTokenCallback, temperature?: number): Promise<string>;
}

const SYSTEM_JSON = 'You are a precise data-extraction assistant. Always respond with valid JSON matching the requested schema and nothing else.';

function buildJsonSchemaBody(req: ExtractRequest, opt: ChatModelOptions) {
	const messages = [
		{ role: 'system', content: req.system ?? SYSTEM_JSON },
		{ role: 'user', content: req.prompt },
	];
	const toolName = 'record';
	const tool = {
		type: 'function',
		function: {
			name: toolName,
			description: req.schema.description ?? 'Structured extraction result',
			parameters: req.schema,
		},
	};
	return { messages, toolName, tool };
}

/**
 * OpenAI-compatible implementation of {@link IChatModel}.
 */
export class OpenAICompatibleJsonModel implements IChatModel {
	private readonly opt: ChatModelOptions;
	private readonly _fetch: typeof fetch;

	constructor(opt: ChatModelOptions) {
		this.opt = opt;
		this._fetch = opt.fetchImpl ?? (globalThis.fetch as unknown as typeof fetch);
		if (!this._fetch) { throw new Error('fetch is not available in this environment'); }
	}

	private _url(path: string): string {
		const base = this.opt.baseUrl.replace(/\/+$/, '');
		const p = path.replace(/^\/+/, '');
		return `${base}/${p}`;
	}

	private async _post(body: unknown, signal: AbortSignal): Promise<any> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			...(this.opt.apiKey ? { Authorization: `Bearer ${this.opt.apiKey}` } : {}),
			...(this.opt.headers ?? {}),
		};
		const res = await this._fetch(this._url('chat/completions'), {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
		}
		return res.json();
	}

	async complete(system: string | undefined, user: string, temperature = 0.2): Promise<string> {
		const body = {
			model: this.opt.model,
			temperature,
			stream: false,
			messages: [
				...(system ? [{ role: 'system', content: system }] : []),
				{ role: 'user', content: user },
			],
		};
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.opt.timeoutMs ?? 120_000);
		try {
			const data = await this._post(body, controller.signal);
			return data?.choices?.[0]?.message?.content ?? '';
		} finally {
			clearTimeout(timer);
		}
	}

	async streamComplete(
		system: string | undefined,
		user: string,
		onToken: StreamTokenCallback,
		temperature = 0.2,
	): Promise<string> {
		const body = {
			model: this.opt.model,
			temperature,
			stream: true,
			messages: [
				...(system ? [{ role: 'system', content: system }] : []),
				{ role: 'user', content: user },
			],
		};
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.opt.timeoutMs ?? 120_000);
		try {
			const res = await this._fetch(this._url('chat/completions'), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(this.opt.apiKey ? { Authorization: `Bearer ${this.opt.apiKey}` } : {}),
					...(this.opt.headers ?? {}),
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!res.ok || !res.body) {
				const text = await res.text().catch(() => '');
				throw new Error(`LLM stream HTTP ${res.status}: ${text.slice(0, 500)}`);
			}
			// Parse SSE stream
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let accumulated = '';
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) { break; }
				buffer += decoder.decode(value, { stream: true });
				// Process complete SSE lines
				const lines = buffer.split('\n');
				buffer = lines.pop()!; // keep incomplete line
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
					const dataStr = trimmed.slice(6);
					if (dataStr === '[DONE]') { continue; }
					try {
						const chunk = JSON.parse(dataStr);
						const delta = chunk?.choices?.[0]?.delta?.content;
						if (typeof delta === 'string' && delta) {
							accumulated += delta;
							const shouldAbort = onToken(delta, accumulated);
							if (shouldAbort) {
								reader.cancel();
								return accumulated;
							}
						}
					} catch { /* skip malformed chunks */ }
				}
			}
			return accumulated;
		} finally {
			clearTimeout(timer);
		}
	}

	async extract<T = Record<string, unknown>>(req: ExtractRequest): Promise<T> {
		const { messages, toolName, tool } = buildJsonSchemaBody(req, this.opt);
		const signal = requestSignal(this.opt.timeoutMs, req.abortSignal);

		// Strategy 1: native json_schema response_format (OpenAI / many compatibles).
		try {
			const data = await this._post({
				model: this.opt.model,
				temperature: req.temperature ?? 0,
				stream: false,
				messages,
				response_format: { type: 'json_schema', json_schema: { name: 'extract', strict: false, schema: req.schema } },
			}, signal);
			const content = data?.choices?.[0]?.message?.content;
			if (typeof content === 'string' && content.trim()) {
				return JSON.parse(stripCodeFence(content)) as T;
			}
		} catch (e) {
			// fall through to tool-calling
			if (this.opt.verboseFallback) { console.warn('[OpenAIJsonModel] json_schema failed, trying tool_call:', e); }
		}

		// Strategy 2: forced tool call.
		try {
			const data = await this._post({
				model: this.opt.model,
				temperature: req.temperature ?? 0,
				stream: false,
				messages,
				tools: [tool],
				tool_choice: { type: 'function', function: { name: toolName } },
			}, signal);
			const msg = data?.choices?.[0]?.message;
			const tc = msg?.tool_calls?.[0];
			if (tc?.function?.arguments) {
				return JSON.parse(tc.function.arguments) as T;
			}
			if (typeof msg?.content === 'string' && msg.content.trim()) {
				return JSON.parse(stripCodeFence(msg.content)) as T;
			}
		} catch (e) {
			if (this.opt.verboseFallback) { console.warn('[OpenAIJsonModel] tool_call failed, trying instructed JSON:', e); }
		}

		// Strategy 3: instruct the model to emit JSON.
		const instructed = `${req.prompt}\n\nReturn ONLY a JSON object matching this schema, no prose, no markdown fences:\n${JSON.stringify(req.schema)}`;
		const data = await this._post({
			model: this.opt.model,
			temperature: req.temperature ?? 0,
			stream: false,
			messages: [
				{ role: 'system', content: SYSTEM_JSON },
				{ role: 'user', content: instructed },
			],
		}, signal);
		const content = data?.choices?.[0]?.message?.content ?? '';
		return JSON.parse(stripCodeFence(content)) as T;
	}
}

function abortAfter(timeoutMs?: number): AbortSignal {
	const controller = new AbortController();
	setTimeout(() => controller.abort(), timeoutMs ?? 120_000);
	return controller.signal;
}

/**
 * 合并「超时信号」与「调用方外部中止信号」：任一触发都会中止 fetch。
 * 无外部信号时退化为纯超时信号（行为与 abortAfter 一致）。
 */
function requestSignal(timeoutMs: number | undefined, external?: AbortSignal): AbortSignal {
	if (!external) { return abortAfter(timeoutMs); }
	const controller = new AbortController();
	const onExternal = () => controller.abort((external as AbortSignal & { reason?: unknown }).reason);
	if (external.aborted) {
		controller.abort((external as AbortSignal & { reason?: unknown }).reason);
		return controller.signal;
	}
	external.addEventListener('abort', onExternal, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs ?? 120_000);
	controller.signal.addEventListener('abort', () => {
		clearTimeout(timer);
		external.removeEventListener('abort', onExternal);
	}, { once: true });
	return controller.signal;
}

/** Strip ```json ... ``` fences if the model wrapped its JSON. */
export function stripCodeFence(s: string): string {
	let t = s.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
	if (fence) { t = fence[1].trim(); }
	return t;
}
