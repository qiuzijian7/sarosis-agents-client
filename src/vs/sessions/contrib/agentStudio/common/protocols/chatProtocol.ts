/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 聊天协议适配器 —— 按「线协议」而非「厂商」划分的编解码契约。
 *
 * 背景（重构于 P0-1）：原先协议差异由 4 个语义重叠的标志决定：
 *   `responseFormat`（'openai'|'anthropic'）、`apiKeyHeader`（'bearer'|'x-api-key'）、
 *   `anthropicVersion`、`isAnthropic` —— 构造体看前者、鉴权看中间者、缓存看最后者，
 *   新增第 3 种协议需要在多处 if 分支里补丁。
 *
 * 现在收敛为单一 `api` 字段 + 本接口的两个方法：
 *   - `buildRequest()`：产出 url/headers/body/parseMode
 *   - `createParser()`：产出流式状态机（push / finish）
 *
 * 新增一种线协议 = 新增一个实现文件，零改动既有代码。
 */

import type { IModelDelta } from '../providers.js';

/** 支持的线协议标识（对齐 Pi 的 `Api` 思路：按协议分，不按厂商分）。 */
export type ChatApi = 'openai-completions' | 'anthropic-messages';

/** 流式解析模式：普通 OpenAI SSE，或需要 `AnthropicStreamState` 的原生 Anthropic SSE。 */
export type ParseMode = 'sse-openai' | 'sse-anthropic';

/** 鉴权方式（由协议决定，不再作为独立标志外泄）。 */
export interface ProtocolAuth {
	readonly kind: 'bearer' | 'x-api-key';
	/** 仅 `x-api-key` 时使用，如 Anthropic 的 '2023-06-01'。 */
	readonly anthropicVersion?: string;
}

/**
 * 构建请求所需的最小上下文。
 * 刻意不依赖 `IModelProvider`/`IConfigurationService` 等具体类型，
 * 以便 renderer 与主进程两侧都以纯数据调用。
 */
export interface ProtocolRequestInput {
	readonly modelId: string;
	readonly messages: readonly unknown[];
	readonly options: Readonly<Record<string, unknown>>;
	readonly context?: Readonly<Record<string, unknown>>;
	/** 已解析的端点基础 URL。 */
	readonly baseUrl: string;
	/** API 密钥（可能为空，如 ollama 等本地端点）。 */
	readonly apiKey: string;
}

/** 构建产物：传输层直接消费，不解释协议语义。 */
export interface ProtocolRequest {
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly body: Record<string, unknown>;
	/** 告知流式解析走哪条路径，取代原先的 `responseFormat` 外泄。 */
	readonly parseMode: ParseMode;
}

/** 流式解析状态机 —— 每个请求新建一个实例。 */
export interface IChatStreamParser {
	/** 解析一行（SSE data 行或 NDJSON 行）为 delta 序列。 */
	pushLine(line: string): IModelDelta[];
	/** 流结束时冲刷未终止的 buffer。 */
	finish(remainingBuffer: string): IModelDelta[];
	/** 是否已收到任何有效数据（用于决定是否走整段 JSON 兜底）。 */
	readonly receivedData: boolean;
}

export interface IChatProtocol {
	readonly api: ChatApi;
	/** 组装 HTTP 请求（含鉴权头）。 */
	buildRequest(input: ProtocolRequestInput): ProtocolRequest;
	/** 新建流式解析器。 */
	createParser(): IChatStreamParser;
}
