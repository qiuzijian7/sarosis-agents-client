/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 流式协议注册表 —— `ParseMode` → 流式解析器，用查表取代 `runChatStream` 里的二元 if。
 *
 * 为什么要注册表（对齐 pi 的 `apiFor(model)` 思路）：
 *   重构前 `runChatStream` 里是这样分派的 ——
 *     const anthropicState = parseMode === 'sse-anthropic' ? new AnthropicStreamState() : undefined;
 *   然后把这个 `| undefined` 一路传进 `readStream` / `processRemainingBuffer` /
 *   `parseFullJsonFallback`，让这三个函数各自再判一次 `if (anthropicState)`。
 *   加第三种协议要同时改 4 处，且「为 undefined 时走 OpenAI」这个隐含默认散落在各层。
 *
 *   现在收敛为：resolveStreamParser(parseMode) 返回一个解析器实例，
 *   下游只调用实例方法，不再感知具体协议。
 *   新增一种协议 = 在此表加一项 + 新增一个协议文件，`runChatStream` 零改动。
 *
 * 与 `chatProtocol.ts` 的分工：
 *   `chatProtocol.ts` 定义**请求侧**契约（buildRequest：url/headers/body）与 ParseMode 联合类型；
 *   本文件定义**响应侧**的分派（createParser：流式状态机）。
 *   两者共同构成「按线协议划分」的编解码边界。
 */

import { AnthropicStreamState } from '../llmBridge.js';
import type { IModelDelta } from '../providers.js';
import type { ParseMode } from './chatProtocol.js';
import { extractUsage, parseContentFromJson } from './sseParsers.js';

/**
 * 流式解析器 —— 每个响应流新建一个实例。
 *
 * 这一层刻意做成「实例 + 方法」而非「纯函数 + 状态参数」：
 * Anthropic 的 tool_use 块需要跨 SSE 事件累积（`content_block_start` 开块、
 * 多个 `input_json_delta` 追加、`content_block_stop` 收口），状态必须挂在实例上；
 * OpenAI 侧无跨事件状态，但实现同样的接口即可，下游无需区分。
 */
export interface IStreamParser {
	/** 解析一条已 JSON.parse 的 SSE 事件，返回本次产生的 delta。 */
	push(parsed: unknown): IModelDelta[];
	/** 流结束时冲刷未终止的 buffer。 */
	finishBuffer(remainingBuffer: string): IModelDelta[];
	/** 整段响应体非 SSE（网关退化为单个 JSON）时的兜底解析。 */
	finishFullBody(fullBody: string): IModelDelta[];
	/** 流彻底结束时的收尾 flush（Anthropic 在此收口工具块并产出 done）。 */
	end(): IModelDelta[];
	/**
	 * 本协议是否自行产出 `done`。
	 *
	 * Anthropic 的 `done` 需要携带 `stop_reason` 与 `response_id`，由状态机收尾时产出；
	 * OpenAI 兼容路径的 `done` 由 `runChatStream` 依据捕获到的 id / finish_reason 组装
	 * （它可能在多个 chunk 中分散出现，状态机拿不到完整视图）。
	 * 故用此标志让 `runChatStream` 决定由谁产出，避免两边都产出或都不产出。
	 */
	readonly producesDone: boolean;
}

// ─── OpenAI 兼容（/chat/completions 风格 SSE） ────────────────────────────────

/**
 * OpenAI 兼容协议的解析器。
 *
 * 无跨事件状态：每个 `choices[0]` 独立产出 delta，故 push 是纯函数式的。
 * 注意 usage / finish_reason 的捕获**不在这里** —— 它们分散在多个 chunk，
 * 由 `runChatStream` 统一累积（见 `IStreamParser.producesDone` 的说明）。
 */
class OpenAICompletionsStreamParser implements IStreamParser {
	readonly producesDone = false;

	constructor(
		private readonly _onCacheHit?: (cachedTokens: number, inputTokens: number | undefined) => void,
	) { }

	push(parsed: unknown): IModelDelta[] {
		const event = parsed as {
			usage?: unknown;
			choices?: Array<{ delta?: unknown; message?: unknown }>;
		};

		const deltas: IModelDelta[] = [];

		const usageDelta = extractUsage(event, this._onCacheHit);
		if (usageDelta) { deltas.push(usageDelta); }

		const content = event.choices?.[0]?.delta ?? event.choices?.[0]?.message;
		if (content) {
			deltas.push(...parseContentFromJson(content));
		}
		return deltas;
	}

	finishBuffer(remainingBuffer: string): IModelDelta[] {
		const payload = takeJsonPayload(remainingBuffer);
		if (payload === undefined) { return []; }
		return this.push(payload);
	}

	finishFullBody(fullBody: string): IModelDelta[] {
		const payload = takeJsonPayload(fullBody);
		if (payload === undefined) {
			return fallbackPlainText(fullBody);
		}
		const event = payload as { choices?: Array<{ message?: unknown }> };
		const deltas: IModelDelta[] = [];
		const usageDelta = extractUsage(event, this._onCacheHit);
		if (usageDelta) { deltas.push(usageDelta); }
		const message = event.choices?.[0]?.message;
		if (message) {
			deltas.push(...parseContentFromJson(message));
		}
		return deltas;
	}

	end(): IModelDelta[] {
		return [];
	}
}

// ─── Anthropic native（/v1/messages 风格 SSE） ────────────────────────────────

/**
 * 原生 Anthropic Messages 协议的解析器。
 *
 * 委托给 `AnthropicStreamState` —— 那是既有的、经过验证的状态机
 * （`llmBridge.ts:303`），本层只做接口适配，不重复实现。
 * 之所以不直接让 `AnthropicStreamState` 实现本接口：它在 `llmBridge.ts` 里
 * 还被请求侧的缓存逻辑引用，改动其形状会影响面过大。
 */
class AnthropicMessagesStreamParser implements IStreamParser {
	readonly producesDone = true;

	private readonly _state = new AnthropicStreamState();

	push(parsed: unknown): IModelDelta[] {
		return this._state.push(parsed);
	}

	finishBuffer(remainingBuffer: string): IModelDelta[] {
		const payload = takeJsonPayload(remainingBuffer);
		if (payload === undefined) { return []; }
		return this._state.push(payload);
	}

	finishFullBody(fullBody: string): IModelDelta[] {
		const payload = takeJsonPayload(fullBody);
		if (payload === undefined) { return []; }
		return this._state.push(payload);
	}

	end(): IModelDelta[] {
		return this._state.finish();
	}
}

// ─── 注册表 ──────────────────────────────────────────────────────────────────

/** 缓存命中回调 —— 由调用方注入，用于打点「读到缓存的 token 数」。 */
export type OnCacheHit = (cachedTokens: number, inputTokens: number | undefined) => void;

/** 解析器工厂：每次请求新建实例，故以函数形式存放而非共享实例。 */
export type StreamParserFactory = (onCacheHit?: OnCacheHit) => IStreamParser;

/**
 * `ParseMode` → 解析器工厂。
 *
 * 新增协议：在此加一项（TypeScript 会用 `Record<ParseMode, …>` 强制穷尽，
 * 漏加会在编译期报错，不会退化成静默走默认分支）。
 *
 * 参数 `onCacheHit`：缓存命中的日志回调，仅 OpenAI 兼容路径使用
 * （Anthropic 的 usage 在 `message_delta` 事件里由状态机自行处理）。
 */
export const STREAM_PARSERS: Record<ParseMode, StreamParserFactory> = {
	'sse-openai': onCacheHit => new OpenAICompletionsStreamParser(onCacheHit),
	'sse-anthropic': () => new AnthropicMessagesStreamParser(),
};

/** 未显式指定协议时的默认值（OpenAI 兼容端点占绝大多数）。 */
export const DEFAULT_PARSE_MODE: ParseMode = 'sse-openai';

/**
 * 按 parseMode 取解析器实例。
 *
 * 未知取值（如配置里写了将来才支持的值）静默回落到默认协议而非抛错 ——
 * 与重构前 `parseMode === 'sse-anthropic' ? … : undefined` 的宽容行为一致，
 * 避免因配置笔误导致整个会话不可用。
 */
export function resolveStreamParser(
	parseMode?: ParseMode,
	onCacheHit?: (cachedTokens: number, inputTokens: number | undefined) => void,
): IStreamParser {
	const factory = STREAM_PARSERS[parseMode ?? DEFAULT_PARSE_MODE] ?? STREAM_PARSERS[DEFAULT_PARSE_MODE];
	return factory(onCacheHit);
}

// ─── 共享工具 ────────────────────────────────────────────────────────────────

/** 剥掉 SSE 的 `data:` 前缀并解析 JSON；非 JSON / `[DONE]` / 空 → undefined。 */
function takeJsonPayload(raw: string): unknown | undefined {
	const trimmed = raw.trim();
	if (!trimmed) { return undefined; }
	let payload = trimmed;
	if (payload.startsWith('data:')) {
		payload = payload.slice('data:'.length).trim();
	}
	if (!payload || payload === '[DONE]') { return undefined; }
	try {
		return JSON.parse(payload);
	} catch {
		// 不完整的尾部数据（SSE 分片截断）—— 丢弃而非报错
		return undefined;
	}
}

/**
 * 整段响应体不是 JSON 时的兜底：当作纯文本产出。
 *
 * 排除 HTML 错误页（网关 502 等会返回 HTML）与超大响应体，
 * 避免把错误页当成模型输出渲染到界面。
 */
function fallbackPlainText(fullBody: string): IModelDelta[] {
	const trimmed = fullBody.trim();
	if (trimmed.length === 0 || trimmed.length >= 100000 || trimmed.startsWith('<')) {
		return [];
	}
	return [{ type: 'text', content: trimmed }];
}
