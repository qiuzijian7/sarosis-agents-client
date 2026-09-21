/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 请求构造实现 —— `chatProtocol.IRequestBuilder` 的落地，与响应侧
 * `protocolRegistry.STREAM_PARSERS` 对称。
 *
 * 从 `builtInBYOKModelProvider._buildRequestBody` +
 * `_buildAnthropicRequestBody` + URL 拼接中抽出。抽出前的状况：
 *   - URL 拼接逻辑在 `builtInBYOKModelProvider:490` 与 `mainProcessModelProvider:178`
 *     各写一遍（`baseUrl.replace(/\/+$/,'') + '/' + path.replace(/^\/+/,'')`）；
 *   - `_buildRequestBody` 是 `protected` 方法，依赖 `this._definition` / `this._models` /
 *     `this._logService`，静态分析无法调用，只能靠实例化 provider 才能测；
 *   - 「请求用 Anthropic 原生体 ⇒ 响应用 Anthropic SSE」这层耦合靠调用方
 *     另行 `if (isAnthropicStream)` 判断，与 body 构造分支分居两处。
 *
 * 抽出后：构造是纯函数（无 IO、不读配置），URL / body / parseMode 一次产出，
 * 两端 provider 共用，且可独立单测（见 `test/browser/requestBuilder.test.ts`）。
 *
 * 日志经 `onLog` 注入而非直接持有 `ILogService` —— 保持本模块可在
 * 无 DOM、无 VS Code 依赖的测试环境中加载（与 `sseParsers.ts` 同一约束）。
 */

import type { BuiltRequest, IRequestBuilder, ParseMode, RequestBuildInput } from './chatProtocol.js';
import type { IModelInfo } from '../providers.js';
import { MessageFormatConverter } from '../adapters/messageFormatConverter.js';
import { isStrictApplicable } from '../adapters/toolSchemaStrict.js';

/** 结构化日志回调（与 `ChatStreamHooks.log` 同形，便于直连调用方直接透传）。 */
export type RequestBuildLogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

/**
 * provider 的协议特征 —— 决定走哪条构造分支。
 *
 * 这些字段来自 `IBuiltInProviderDefinition`。之所以不直接传整个 definition：
 * 本模块（`common/`）不应依赖 `browser/` 的 provider 类型，否则反向耦合。
 */
export interface RequestBuilderProfile {
	/** 是否使用 Anthropic 原生请求体格式（`/v1/messages`）。 */
	readonly responseFormat?: 'openai' | 'anthropic';
	/** 是否按 Anthropic 语义处理消息与工具（cache_control 断点等）。 */
	readonly isAnthropic?: boolean;
	/**
	 * 模型 → 模型信息查询（用于读取 `capabilityConfig.reasoningType`）。
	 *
	 * 直连侧查 `this._models`（动态拉取的模型列表），主进程侧无此列表故不传。
	 * 差异用注入吸收，构造逻辑本身仍只有一份。
	 */
	readonly getModel?: (modelId: string) => IModelInfo | undefined;
	/**
	 * **provider 级** strict 工具开关（2026-09-21）。
	 *
	 * - `true` / `false`：provider 明确判定（覆盖模型级声明）；
	 * - `undefined`：交给模型级 `capabilityConfig.strictToolSchema` 决定（官方 OpenAI / Azure
	 *   端点的 provider 会直接给 `true`）。
	 *
	 * 之所以放在 profile：本模块在 `common/`，不应反向依赖 `browser/` 的 provider 判定逻辑，
	 * 由调用方把"这家 provider 能不能 strict"作为协议特征注入（与 responseFormat 同姿态）。
	 */
	readonly strictToolSchema?: boolean;
}

/** 默认端点路径 —— 未显式配置时按协议推定。 */
export const DEFAULT_OPENAI_CHAT_PATH = 'v1/chat/completions';
export const DEFAULT_ANTHROPIC_CHAT_PATH = 'v1/messages';

/**
 * 拼接 baseUrl 与端点路径，容忍两侧多余斜杠。
 *
 * 抽出的直接动因：该表达式此前在两处 provider 里逐字重复
 * （`baseUrl.replace(/\/+$/, '')` + `path.replace(/^\/+/, '')`），
 * 任一处忘记去尾斜杠就会产出 `https://host//v1/chat/completions`。
 */
export function joinUrl(baseUrl: string, chatPath: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/${chatPath.replace(/^\/+/, '')}`;
}

/**
 * 请求构造器。
 *
 * 用法（provider 内）：
 * ```ts
 * const built = requestBuilder.build({
 *     modelId, messages, options, context,
 *     baseUrl: this._getBaseUrl(),
 *     chatEndpointPath: this._definition.chatEndpointPath,
 * });
 * ```
 * 返回的 `parseMode` 直接喂给 `runChatStream`，无需调用方再判一次协议。
 */
export class RequestBuilder implements IRequestBuilder {

	constructor(
		private readonly _profile: RequestBuilderProfile,
		private readonly _onLog?: RequestBuildLogFn,
		private readonly _providerId: string = 'unknown',
	) { }

	build(input: RequestBuildInput): BuiltRequest {
		const isAnthropic = this._profile.responseFormat === 'anthropic';

		const defaultPath = isAnthropic ? DEFAULT_ANTHROPIC_CHAT_PATH : DEFAULT_OPENAI_CHAT_PATH;
		const url = joinUrl(input.baseUrl, input.chatEndpointPath || defaultPath);

		if (isAnthropic) {
			return {
				url,
				body: this._buildAnthropicBody(input),
				parseMode: 'sse-anthropic',
			};
		}
		return {
			url,
			body: this._buildOpenAICompatibleBody(input),
			parseMode: 'sse-openai',
		};
	}

	/** 日志前缀，保持与原 provider 内的 `[BYOK:<id>]` 格式一致，便于比对既有日志。 */
	private _log(level: 'info' | 'warn' | 'error', message: string): void {
		this._onLog?.(level, `[BYOK:${this._providerId}] _streamChat: ${message}`);
	}

	/** 原生 Anthropic Messages 请求体（`/v1/messages`）。 */
	private _buildAnthropicBody(input: RequestBuildInput): Record<string, unknown> {
		const { modelId, messages, options, context } = input;

		const { messages: anthropicMessages, systemPrompt } = MessageFormatConverter.toAnthropic(messages, {
			systemPrompt: options.systemPrompt,
			tools: options.tools,
			forkContext: options.forkContext,
		});

		const body: Record<string, unknown> = {
			model: modelId,
			// Anthropic 要求 max_tokens 必填；未指定时给一个合理默认值。
			max_tokens: options.maxTokens ?? 8192,
			stream: true,
		};
		if (systemPrompt) {
			body.system = systemPrompt;
		}
		body.messages = anthropicMessages;

		// 抓包对齐：注入 previous_response_id（与 OpenAI 路径一致）
		if (context?.previousResponseId) {
			body.previous_response_id = context.previousResponseId;
		}
		if (options.temperature !== undefined) {
			body.temperature = options.temperature;
		}
		if (options.tools && options.tools.length > 0) {
			body.tools = MessageFormatConverter.toAnthropicToolDefinitions(
				options.tools,
				options.forkContext,
				true,
				options.systemPrompt,
			);
		}

		// ── Thinking / Reasoning（Anthropic 原生 extended thinking）──
		if (options.reasoning?.enabled) {
			const budget = options.reasoning.budget;
			if (budget && budget > 0) {
				body.thinking = { type: 'enabled', budget_tokens: budget };
				this._log('info', `reasoning: thinking budget_tokens=${budget}`);
			}
		}
		return body;
	}

	/** OpenAI 兼容请求体（`/chat/completions`，含 Fork 前缀缓存与 reasoning 参数）。 */
	private _buildOpenAICompatibleBody(input: RequestBuildInput): Record<string, unknown> {
		const { modelId, messages, options, context } = input;

		const body: Record<string, unknown> = {
			model: modelId,
			messages: MessageFormatConverter.toOpenAI(messages, {
				isAnthropic: this._profile.isAnthropic,
				tools: options.tools,
				capabilityConfig: undefined, // BYOK provider 统一使用 OpenAI 兼容格式
				// Fork 前缀缓存（请求构造端接 ForkContext）：透传 agent 冻结 system + 父级
				// ForkContext，使构造端能在冻结前缀边界注入 cache_control 断点（Anthropic 兼容）。
				systemPrompt: options.systemPrompt,
				forkContext: options.forkContext,
			}),
			stream: true,
		};

		// 抓包对齐：注入 previous_response_id（= 上一次响应流 chunk 的 id），
		// 让服务端按响应链衔接上下文。由 agentOS 经 IChatContext 下传。
		if (context?.previousResponseId) {
			body.previous_response_id = context.previousResponseId;
		}
		if (options.temperature !== undefined) {
			body.temperature = options.temperature;
		}
		if (options.maxTokens !== undefined) {
			body.max_tokens = options.maxTokens;
		}

		this._applyTools(body, options, modelId);

		// ── Thinking / Reasoning 参数注入 ─────────────────────────────
		// 按模型 capabilityConfig.reasoningType 决定 API 形态（参考 void）：
		//   - 'effort-slider'（OpenAI o 系列 / xAI / DeepSeek）→ reasoning_effort: 'low'|'medium'|'high'
		//   - 'budget-slider' + Anthropic 兼容 → thinking: { type: 'enabled', budget_tokens: N }
		//   - 'budget-slider' + OpenAI 兼容 → 退化为 reasoning_effort（按 budget 粗分档）
		this._applyReasoning(body, input);

		return body;
	}

	/**
	 * strict 工具模式是否生效：**provider 级声明优先**，否则看模型级 `capabilityConfig`。
	 *
	 * 不做"全局强制开"：OpenRouter / Ollama / Nous / 任意自建 OpenAI 兼容网关对 `strict`
	 * 字段的处理各不相同（透传 / 忽略 / 直接 400），全局开会把风险平摊给所有用户。
	 */
	private _resolveStrictToolSchema(modelId: string): boolean {
		if (this._profile.strictToolSchema !== undefined) {
			return this._profile.strictToolSchema;
		}
		return this._profile.getModel?.(modelId)?.capabilityConfig?.strictToolSchema === true;
	}

	/** 工具面：注入 tool 定义与 `tool_choice`，并记录工具统计。 */
	private _applyTools(body: Record<string, unknown>, options: RequestBuildInput['options'], modelId: string): void {
		if (options.tools && options.tools.length > 0) {
			// Fork 前缀缓存：Anthropic 兼容时把最后一个工具定义也打上 cache 断点，
			// 使 system + tools 共同构成父/子 fork 共享的冻结缓存前缀。
			const strictToolSchema = this._resolveStrictToolSchema(modelId);
			body.tools = MessageFormatConverter.toOpenAIToolDefinitions(
				options.tools,
				options.forkContext,
				this._profile.isAnthropic,
				options.systemPrompt,
				strictToolSchema,
			);
			if (strictToolSchema) {
				// 可观测性：strict 是**按工具**生效的，必须能回答"哪些工具没进 strict、为什么"
				// （否则线上只会看到参数结构偶发变化，无从归因）。
				const fallback = options.tools.filter(t => !isStrictApplicable(t.inputSchema)).map(t => t.name);
				this._log('info',
					`tools strict mode ON: ${options.tools.length - fallback.length}/${options.tools.length} `
					+ `tools declared strict, ${fallback.length} fell back to plain mode`
					+ (fallback.length > 0 ? ` [${fallback.join(', ')}]` : ''));
			}
			// 透传上层（agent loop 续跑兜底）指定的 tool_choice；默认 'auto'。
			// 'required' 用于强制模型在续跑这一轮必须调用工具，治"宣告意图却不动手"。
			body.tool_choice = options.toolChoice ?? 'auto';
			const mcpToolCount = options.tools.filter(t => t.category?.startsWith('mcp:')).length;
			this._log(
				'info',
				`sending ${options.tools.length} tools ` +
				`(MCP: ${mcpToolCount}, builtin: ${options.tools.length - mcpToolCount}) ` +
				`with tool_choice=${body.tool_choice}\n` +
				`  tool names: [${options.tools.map(t => t.name).join(', ')}]`
			);
			return;
		}

		// 无工具面：正常路径不设 tool_choice（'auto'/'required' 在没有 tools 时
		// 无意义，部分网关还会校验报错）。唯一例外是收尾轮的 'none' ——
		// 它是「禁止调用工具」的协议级声明，与空工具面构成双保险
		// （对齐 MiMo-Code 的 toolChoice:"none"）。
		if (options.toolChoice === 'none') {
			body.tool_choice = 'none';
			this._log('info', `NO tools + tool_choice='none' (final wrap-up round — model must answer from gathered context)`);
		} else {
			this._log('warn', `NO tools in request (options.tools is empty or undefined)`);
		}
	}

	/** reasoning 参数：按模型能力与协议形态选择 `thinking` 或 `reasoning_effort`。 */
	private _applyReasoning(body: Record<string, unknown>, input: RequestBuildInput): void {
		const { options, modelId } = input;
		if (!options.reasoning?.enabled) {
			return;
		}

		const reasoningType = this._profile.getModel?.(modelId)?.capabilityConfig?.reasoningType;
		const effort = options.reasoning.effort;
		const budget = options.reasoning.budget;

		if (this._profile.isAnthropic || reasoningType === 'budget-slider') {
			if (budget && budget > 0) {
				// Anthropic 原生 extended thinking
				body.thinking = { type: 'enabled', budget_tokens: budget };
				this._log('info', `reasoning: thinking budget_tokens=${budget}`);
			} else if (effort) {
				body.reasoning_effort = effort;
				this._log('info', `reasoning: reasoning_effort=${effort}`);
			}
			return;
		}

		// OpenAI o 系列 / DeepSeek / 其它 OpenAI 兼容：reasoning_effort
		body.reasoning_effort = effort
			?? (budget != null ? (budget >= 6144 ? 'high' : budget >= 3072 ? 'medium' : 'low') : 'medium');
		this._log('info', `reasoning: reasoning_effort=${body.reasoning_effort}`);
	}
}

/**
 * Provider 实现便捷入口 —— 直接产出一个绑定好 profile 的 builder。
 *
 * 之所以提供工厂而非让 provider `new RequestBuilder(...)`：
 * 让 `RequestBuildLogFn` 到 `LogFn` 的形参适配集中在一处
 * （两者签名相同但语义层次不同，见 `runChatStream.LogFn`）。
 */
export function createRequestBuilder(
	profile: RequestBuilderProfile,
	onLog?: RequestBuildLogFn,
	providerId?: string,
): IRequestBuilder {
	return new RequestBuilder(profile, onLog, providerId);
}

/** 便捷再导出：调用方通常同时需要这两个协议标识。 */
export type { BuiltRequest, IRequestBuilder, ParseMode, RequestBuildInput };
