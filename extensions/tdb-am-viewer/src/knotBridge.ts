/*---------------------------------------------------------------------------------------------
 *  Knot → OpenAI Bridge
 *
 *  Lightweight HTTP server that exposes an OpenAI-compatible
 *  /v1/chat/completions endpoint and translates each call into a Knot AG-UI
 *  request:  POST {endpoint}/apigw/api/v1/agents/agui/{agentId}
 *
 *  TDB-AM gateway is configured to point its `llm.baseUrl` at this bridge.
 *  This file runs INSIDE the extension host process — no spawned child.
 *
 *  Streaming note: TDB-AM uses Vercel AI SDK in non-streaming mode for L1/L2/L3
 *  extraction, so we currently buffer Knot's SSE stream and return a single
 *  non-stream OpenAI response. If `stream: true` is requested by the client
 *  we still buffer and re-emit a minimal SSE conforming to OpenAI's chunk
 *  schema (one delta + final [DONE]).
 *
 *  Prompt cache passthrough: if Knot's SSE metadata carries token usage
 *  (including any of `cached_tokens` / `cache_read_tokens` / `prompt_cache_tokens`),
 *  we forward it in the OpenAI-format `usage.prompt_tokens_details.cached_tokens`
 *  field so sarosis BYOK provider's existing cache-detection code path picks it
 *  up automatically — no special-casing of Knot in BYOK.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import { URL } from 'node:url';

export interface KnotBridgeOptions {
	port: number;
	knotEndpoint: string;
	knotToken: string;
	knotUser?: string;
	knotAgentId: string;
	logger: (msg: string) => void;
}

interface OpenAIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
}

interface OpenAIChatRequest {
	model?: string;
	messages: OpenAIMessage[];
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
}

/**
 * Aggregated usage extracted from Knot SSE events.
 *
 * Field names map directly onto OpenAI's `usage` shape so we can drop them
 * straight into the response without any further translation.
 */
interface ExtractedUsage {
	/** Whether at least one usage signal was observed (lets us distinguish "no data" from zero). */
	seen: boolean;
	promptTokens: number;
	completionTokens: number;
	/** Tokens served from the prompt cache — surfaced as `prompt_tokens_details.cached_tokens`. */
	cachedTokens: number;
	/** Tokens written into the prompt cache during this turn (Anthropic-style). */
	cacheWriteTokens: number;
}

/**
 * Field-name candidates we accept when scraping Knot SSE metadata.
 *
 * Knot has historically returned token statistics under several different
 * keys depending on which model is wired up behind the AG-UI agent. Rather
 * than hard-code one shape we accept any of these and pick the first match
 * in priority order.
 */
const PROMPT_TOKEN_KEYS = ['prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens'];
const COMPLETION_TOKEN_KEYS = ['completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens'];
const CACHED_TOKEN_KEYS = [
	'cached_tokens',
	'cache_read_input_tokens',
	'cache_read_tokens',
	'prompt_cache_tokens',
	'cachedTokens',
	'cacheReadTokens',
];
const CACHE_WRITE_TOKEN_KEYS = [
	'cache_creation_input_tokens',
	'cache_write_tokens',
	'cacheCreationInputTokens',
	'cacheWriteTokens',
];

const TAG = '[knot-bridge]';

export class KnotBridge {
	private server: http.Server | undefined;
	private opts: KnotBridgeOptions;

	constructor(opts: KnotBridgeOptions) {
		this.opts = opts;
	}

	get baseUrl(): string {
		return `http://127.0.0.1:${this.opts.port}/v1`;
	}

	updateOptions(patch: Partial<KnotBridgeOptions>): void {
		this.opts = { ...this.opts, ...patch };
	}

	async start(): Promise<void> {
		if (this.server) {
			return;
		}
		this.server = http.createServer((req, res) => this.handle(req, res));
		await new Promise<void>((resolve, reject) => {
			this.server!.once('error', reject);
			this.server!.listen(this.opts.port, '127.0.0.1', () => {
				this.opts.logger(`${TAG} listening on http://127.0.0.1:${this.opts.port}`);
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		if (!this.server) {
			return;
		}
		await new Promise<void>(resolve => this.server!.close(() => resolve()));
		this.server = undefined;
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.opts.port}`);
			if (req.method === 'GET' && url.pathname === '/v1/models') {
				return this.respondModels(res);
			}
			if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
				const body = await this.readJson<OpenAIChatRequest>(req);
				return this.handleChat(body, res);
			}
			res.statusCode = 404;
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ error: { message: 'not found', type: 'not_found' } }));
		} catch (err) {
			const msg = (err as Error).message;
			this.opts.logger(`${TAG} request error: ${msg}`);
			res.statusCode = 500;
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ error: { message: msg, type: 'internal_error' } }));
		}
	}

	private async readJson<T>(req: http.IncomingMessage): Promise<T> {
		const chunks: Buffer[] = [];
		for await (const c of req) {
			chunks.push(c as Buffer);
		}
		const raw = Buffer.concat(chunks).toString('utf-8');
		return JSON.parse(raw) as T;
	}

	private respondModels(res: http.ServerResponse): void {
		res.statusCode = 200;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({
			object: 'list',
			data: [{
				id: this.opts.knotAgentId || 'knot-default',
				object: 'model',
				created: Math.floor(Date.now() / 1000),
				owned_by: 'knot',
			}],
		}));
	}

	private collapseMessages(messages: OpenAIMessage[]): { user: string; system: string | undefined } {
		const systemParts: string[] = [];
		const userParts: string[] = [];
		for (const m of messages) {
			if (!m || typeof m.content !== 'string') continue;
			if (m.role === 'system') {
				systemParts.push(m.content);
			} else if (m.role === 'user') {
				userParts.push(m.content);
			} else if (m.role === 'assistant') {
				// Inline previous turns to keep context for Knot single-message API.
				userParts.push(`[Previous assistant turn]: ${m.content}`);
			}
		}
		return {
			user: userParts.join('\n\n').trim(),
			system: systemParts.length ? systemParts.join('\n\n').trim() : undefined,
		};
	}

	private async handleChat(req: OpenAIChatRequest, res: http.ServerResponse): Promise<void> {
		const agentId = this.opts.knotAgentId;
		if (!agentId) {
			res.statusCode = 400;
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ error: { message: 'tdbam.knotAgentId is not configured', type: 'config_error' } }));
			return;
		}

		const { user, system } = this.collapseMessages(req.messages ?? []);
		const url = `${this.opts.knotEndpoint.replace(/\/+$/, '')}/apigw/api/v1/agents/agui/${encodeURIComponent(agentId)}`;
		const knotBody: Record<string, unknown> = {
			input: {
				message: user,
				conversation_id: '',
				stream: true,
				enable_web_search: false,
				chat_extra: system ? { system_prompt: system } : {},
			},
		};
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Accept': 'text/event-stream',
			'x-knot-api-token': this.opts.knotToken,
		};
		if (this.opts.knotUser) {
			headers['x-knot-api-user'] = this.opts.knotUser;
		}

		this.opts.logger(`${TAG} -> knot agent=${agentId} msg_len=${user.length}`);

		let knotResp: Response;
		try {
			knotResp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(knotBody) });
		} catch (err) {
			res.statusCode = 502;
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ error: { message: `knot fetch failed: ${(err as Error).message}`, type: 'upstream_error' } }));
			return;
		}

		if (!knotResp.ok || !knotResp.body) {
			const text = await knotResp.text().catch(() => knotResp.statusText);
			res.statusCode = knotResp.status || 502;
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ error: { message: `knot HTTP ${knotResp.status}: ${text}`, type: 'upstream_error' } }));
			return;
		}

		const { fullText, usage } = await this.collectKnotStream(knotResp);
		const completion = this.buildOpenAIResponse(fullText, req.model || agentId, usage);

		if (usage.seen && usage.cachedTokens > 0) {
			this.opts.logger(`${TAG} cache hit: cached=${usage.cachedTokens} / prompt=${usage.promptTokens}`);
		}

		if (req.stream) {
			res.statusCode = 200;
			res.setHeader('Content-Type', 'text/event-stream');
			res.setHeader('Cache-Control', 'no-cache');
			res.setHeader('Connection', 'keep-alive');
			const chunkData = {
				id: completion.id,
				object: 'chat.completion.chunk',
				created: completion.created,
				model: completion.model,
				choices: [{ index: 0, delta: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
			};
			res.write(`data: ${JSON.stringify(chunkData)}\n\n`);

			// Emit a usage-only chunk before [DONE] so streaming clients can pick up
			// prompt-cache statistics. Mirrors OpenAI's `stream_options.include_usage`
			// behaviour: choices=[] + usage=...
			if (usage.seen) {
				const usageChunk = {
					id: completion.id,
					object: 'chat.completion.chunk',
					created: completion.created,
					model: completion.model,
					choices: [],
					usage: completion.usage,
				};
				res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
			}

			res.write('data: [DONE]\n\n');
			res.end();
		} else {
			res.statusCode = 200;
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify(completion));
		}
	}

	/**
	 * Collect Knot's AG-UI SSE stream and concatenate textual deltas. While we
	 * walk the events, we also opportunistically scrape token-usage metadata
	 * from any object that looks like a usage block, so the bridge can forward
	 * prompt-cache info to OpenAI-compatible callers.
	 *
	 * The Knot AG-UI protocol emits events whose JSON payload typically contains
	 * `data` or `content` fields. We inspect a few common shapes; unknown event
	 * types are silently skipped (they're usually metadata).
	 */
	private async collectKnotStream(resp: Response): Promise<{ fullText: string; usage: ExtractedUsage }> {
		const reader = resp.body!.getReader();
		const decoder = new TextDecoder('utf-8');
		let buffer = '';
		let collected = '';
		const usage: ExtractedUsage = {
			seen: false,
			promptTokens: 0,
			completionTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		};
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nlIdx: number;
			while ((nlIdx = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nlIdx).replace(/\r$/, '');
				buffer = buffer.slice(nlIdx + 1);
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (!payload || payload === '[DONE]') continue;
				try {
					const obj = JSON.parse(payload) as Record<string, unknown>;
					const piece = this.extractDelta(obj);
					if (piece) collected += piece;
					this.extractUsage(obj, usage);
				} catch {
					// Non-JSON SSE payload — append raw text as fallback.
					collected += payload;
				}
			}
		}
		return { fullText: collected.trim(), usage };
	}

	private extractDelta(obj: Record<string, unknown>): string {
		// Try the most common AG-UI shapes.
		const candidates: unknown[] = [
			obj['delta'],
			obj['content'],
			(obj['data'] as Record<string, unknown> | undefined)?.['content'],
			(obj['output'] as Record<string, unknown> | undefined)?.['content'],
			(obj['message'] as Record<string, unknown> | undefined)?.['content'],
		];
		for (const c of candidates) {
			if (typeof c === 'string' && c.length > 0) return c;
		}
		return '';
	}

	/**
	 * Walk a Knot SSE event JSON object looking for token usage statistics.
	 * Mutates the provided ExtractedUsage in place. Tries multiple known
	 * locations in priority order to be tolerant of different upstream models.
	 *
	 * Locations probed:
	 *   1. Top-level: `obj.usage`, `obj.metadata.usage`, `obj.metadata.token_usage`
	 *   2. AG-UI nested: `obj.data.usage`, `obj.data.metadata.usage`
	 *   3. Direct fields on the object itself (some events flatten usage)
	 */
	private extractUsage(obj: Record<string, unknown>, usage: ExtractedUsage): void {
		const candidates: Array<Record<string, unknown> | undefined> = [
			obj['usage'] as Record<string, unknown> | undefined,
			(obj['metadata'] as Record<string, unknown> | undefined)?.['usage'] as Record<string, unknown> | undefined,
			(obj['metadata'] as Record<string, unknown> | undefined)?.['token_usage'] as Record<string, unknown> | undefined,
			(obj['data'] as Record<string, unknown> | undefined)?.['usage'] as Record<string, unknown> | undefined,
			((obj['data'] as Record<string, unknown> | undefined)?.['metadata'] as Record<string, unknown> | undefined)?.['usage'] as Record<string, unknown> | undefined,
			// Last resort: scan the top-level object itself for known token fields
			// (some Knot models emit { event: 'finish', prompt_tokens: …, cached_tokens: … }).
			obj,
		];

		for (const block of candidates) {
			if (!block || typeof block !== 'object') continue;
			const got = this.harvestTokenFields(block, usage);
			if (got) {
				usage.seen = true;
				// Prefer the first block that yielded data — later blocks would
				// otherwise double-count when multiple shapes coexist in one event.
				return;
			}
		}
	}

	/**
	 * Read known token fields out of a single object into ExtractedUsage.
	 * Returns true when at least one field was found.
	 *
	 * Numeric coercion is strict: we only accept plain finite numbers to
	 * avoid being fooled by accidental string concatenation upstream.
	 */
	private harvestTokenFields(block: Record<string, unknown>, usage: ExtractedUsage): boolean {
		let touched = false;

		const promptT = this.firstNumberField(block, PROMPT_TOKEN_KEYS);
		if (promptT !== undefined) { usage.promptTokens = promptT; touched = true; }

		const completionT = this.firstNumberField(block, COMPLETION_TOKEN_KEYS);
		if (completionT !== undefined) { usage.completionTokens = completionT; touched = true; }

		// `cached_tokens` may sit at the top of `usage` or nested under
		// `usage.prompt_tokens_details.cached_tokens` (OpenAI canonical shape).
		const cachedTopLevel = this.firstNumberField(block, CACHED_TOKEN_KEYS);
		if (cachedTopLevel !== undefined) { usage.cachedTokens = cachedTopLevel; touched = true; }
		const promptDetails = block['prompt_tokens_details'] as Record<string, unknown> | undefined;
		if (promptDetails && typeof promptDetails === 'object') {
			const nested = this.firstNumberField(promptDetails, CACHED_TOKEN_KEYS);
			if (nested !== undefined) { usage.cachedTokens = nested; touched = true; }
		}

		const cacheWrite = this.firstNumberField(block, CACHE_WRITE_TOKEN_KEYS);
		if (cacheWrite !== undefined) { usage.cacheWriteTokens = cacheWrite; touched = true; }

		return touched;
	}

	private firstNumberField(block: Record<string, unknown>, keys: readonly string[]): number | undefined {
		for (const k of keys) {
			const v = block[k];
			if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
				return v;
			}
		}
		return undefined;
	}

	private buildOpenAIResponse(text: string, model: string, usage: ExtractedUsage) {
		const now = Math.floor(Date.now() / 1000);

		// Build the OpenAI-format usage block. When Knot reported nothing we
		// keep the historical zeros (callers tolerate that). When Knot did
		// report cache info we place it under `prompt_tokens_details.cached_tokens`,
		// which is the path sarosis BYOK provider already inspects — no special
		// handling for "Knot" needed downstream.
		const promptTokens = usage.seen ? usage.promptTokens : 0;
		const completionTokens = usage.seen ? usage.completionTokens : 0;
		const totalTokens = promptTokens + completionTokens;

		const usageBlock: Record<string, unknown> = {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: totalTokens,
		};
		if (usage.seen && usage.cachedTokens > 0) {
			usageBlock['prompt_tokens_details'] = { cached_tokens: usage.cachedTokens };
		}
		if (usage.seen && usage.cacheWriteTokens > 0) {
			// Anthropic-shaped fields, kept verbatim for completeness — BYOK provider
			// reads `cache_creation_input_tokens` directly off the top of `usage`.
			usageBlock['cache_creation_input_tokens'] = usage.cacheWriteTokens;
		}
		if (usage.seen && usage.cachedTokens > 0) {
			// Likewise: BYOK provider also accepts the Anthropic-shaped
			// `cache_read_input_tokens` at the top of `usage`. Emitting both
			// alias paths costs nothing and maximises consumer compatibility.
			usageBlock['cache_read_input_tokens'] = usage.cachedTokens;
		}

		return {
			id: `chatcmpl-knot-${now}-${Math.random().toString(36).slice(2, 8)}`,
			object: 'chat.completion',
			created: now,
			model,
			choices: [{
				index: 0,
				message: { role: 'assistant', content: text },
				finish_reason: 'stop',
			}],
			usage: usageBlock,
		};
	}
}
