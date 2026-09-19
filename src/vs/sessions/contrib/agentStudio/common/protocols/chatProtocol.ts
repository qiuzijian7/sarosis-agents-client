/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 聊天线协议的类型边界。
 *
 * 本文件承载**请求侧**契约 —— 与响应侧的 `protocolRegistry.IStreamParser` 对称：
 *   - 请求侧：{@link IRequestBuilder} —— 把「怎么拼 URL / 请求体」从 provider 里抽出来；
 *   - 响应侧：`protocolRegistry.resolveStreamParser` —— 把「怎么解码响应流」查表分派。
 *   两者共同构成「按线协议划分」的编解码边界，且都已落到独立实现上。
 *
 * 为什么按「线协议」而非「厂商」划分：
 *   同一家厂商可能提供多种线协议（如 OpenAI 的 `/chat/completions` 与 `/responses`），
 *   不同厂商也可能共用一种（DeepSeek / Groq / Ollama 都用 OpenAI 兼容格式）。
 *   按厂商划分会把这些差异塞进标志位。
 *
 * 历史（P0-1 重构）：原先协议差异由 4 个语义重叠的标志决定 ——
 *   `responseFormat`（'openai'|'anthropic'）、`apiKeyHeader`（'bearer'|'x-api-key'）、
 *   `anthropicVersion`、`isAnthropic`；构造体看前者、鉴权看中间者、缓存看最后者，
 *   新增第 3 种协议需要在多处 if 分支里打补丁。
 * 现在收敛为单一 `ParseMode` 字段，由 `protocolRegistry.STREAM_PARSERS` 查表分派。
 *
 * 历史（P1）：本文件曾声明 `IChatProtocol`（buildRequest + createParser）与
 * `IChatStreamParser` 等一整套契约，但**始终零实现、零引用** —— 实际加协议的路径是改
 * `_buildRequest()` 里的分支 + 在 `STREAM_PARSERS` 注册解析器，从不经过那些接口。
 * 挂空的抽象会误导读者以为「加协议 = 新增一个 IChatProtocol 实现」，故先删除。
 *
 * 随后补齐（P2）：按当初定下的正确顺序 —— 先把 `builtInBYOKModelProvider` 里
 * 「按 provider 拼 url / headers / body」的逻辑抽成 `buildRequestBody` 独立函数，
 * 再让它满足 {@link IRequestBuilder} —— 接口才落地。**先有实现形状，后有接口**，
 * 而非先声明接口等实现（后者会产出与真实用法错位的抽象）。
 *
 * 与响应侧的对称性：两侧都是「一个纯函数/工厂 + 一个查表分派」——
 *   请求 buildRequest(input) → { url, body, parseMode }
 *   响应 resolveStreamParser(parseMode) → IStreamParser
 * 新增线协议 = 请求侧加一个 builder 分支 + 响应侧注册一个解析器。
 */

import type { IChatContext, IChatMessage, IModelOptions } from '../providers.js';
import type { IModelDelta } from '../providers.js';

/**
 * 支持的线协议标识（对齐 pi 的 `Api` 思路：按协议分，不按厂商分）。
 *
 * 新增一种线协议 = 在此联合类型加一项 + 在 `protocolRegistry.STREAM_PARSERS` 注册解析器。
 * 因 `STREAM_PARSERS` 声明为 `Record<ParseMode, …>`，漏注册会在**编译期**报错。
 */
export type ChatApi = 'openai-completions' | 'anthropic-messages';

/**
 * 流式解析模式 —— 决定响应体如何解码。
 *
 * 与 `ChatApi` 分开的原因：请求体的构造与响应体的解码是两个独立的关注点，
 * 允许组合（例如某网关用 OpenAI 格式发请求、以 Anthropic SSE 回响应）。
 */
export type ParseMode = 'sse-openai' | 'sse-anthropic';
/**
 * 一次请求构造所需的全部输入。
 *
 * 刻意只放「构造请求体时真正需要的字段」，不含 `apiKey` / `signal` 等
 * 传输层关注点 —— 那些由 `runChatStream.ChatStreamInput` 承载。
 * 这条边界让 builder 保持纯粹（无 IO、可单测），也避免鉴权信息流过构造逻辑。
 */
export interface RequestBuildInput {
	/** 目标模型 id（写入 body.model）。 */
	readonly modelId: string;
	/**
	 * 对话消息（含 system 提示的归并规则由 builder 决定）。
	 *
	 * 刻意不加 `readonly`：`MessageFormatConverter.toOpenAI` 会先经
	 * `buildWireMessages` 做 wire 收口（可能重建数组），需要可变入参。
	 * builder 自身仍不修改调用方数组 —— 约束由转换器保证。
	 */
	messages: IChatMessage[];
	/** 模型选项：temperature / maxTokens / tools / reasoning 等。 */
	readonly options: IModelOptions;
	/** 上下文附加字段（previousResponseId、fork 前缀缓存等）。 */
	readonly context?: IChatContext;
	/** 已解析的 baseUrl（不含端点路径）。 */
	readonly baseUrl: string;
	/** 端点路径（如 `chat/completions`、`v1/messages`）；缺省时按协议取默认值。 */
	readonly chatEndpointPath?: string;
}

/**
 * 请求构造的产出 —— 恰好是 `runChatStream` 所需的三样东西。
 *
 * `parseMode` 与 `body` 一同产出是有意为之：**请求格式决定了响应该怎么解码**
 * （发 Anthropic 原生体 → 必回 Anthropic SSE）。把它留在这里可避免调用方
 * 另起一段 if 自行推定，否则两处判断迟早漂移。
 */
export interface BuiltRequest {
	/** 完整请求 URL。 */
	readonly url: string;
	/** 请求体（未序列化；由 `runChatStream` 统一 JSON.stringify）。 */
	readonly body: Record<string, unknown>;
	/** 该请求对应的响应解析模式。 */
	readonly parseMode: ParseMode;
}

/**
 * 请求构造器契约 —— 与响应侧 `IStreamParser` 对称。
 *
 * 实现是**纯函数**：只读输入、产出 URL 与请求体，不发起 IO、不读配置服务。
 * 调用方（provider）负责把自身状态（baseUrl、definition）解出来喂进去，
 * 因此同一份构造逻辑可在 renderer 与主进程两侧复用而不携带环境依赖。
 *
 * 为何不做成「按 ParseMode 查表」的注册表（响应侧那样）：
 * 响应侧的分派键是**响应**协议，而构造请求时还不知道响应会是什么；
 * 键只能是**请求**协议（`responseFormat`），当前仅 openai / anthropic 两个分支，
 * 且二者的 body 结构差异是整段的（非几行参数）。故保持「一个函数内早返回」，
 * 待请求协议增至 3 种以上、或出现需要独立测试的复杂协议时再抽注册表。
 */
export interface IRequestBuilder {
	/** 按输入构造请求；纯函数，同样输入必得同样输出。 */
	build(input: RequestBuildInput): BuiltRequest;
}



/**
 * 流式解析器契约的转发声明。
 *
 * 实现与工厂见 `protocolRegistry.ts`。此处再导出一次是为了让
 * 「协议相关类型都从本文件取」这一直觉成立，避免调用方到处找定义。
 */
export type { IStreamParser, OnCacheHit, StreamParserFactory } from './protocolRegistry.js';

/** 解析器产出的 delta 类型（再导出，便于协议实现方只依赖本文件）。 */
export type { IModelDelta };
