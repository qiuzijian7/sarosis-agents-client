/*---------------------------------------------------------------------------------------------
 * streamFnAdapter.ts —— **StreamFn 适配器**（六件套之一，doc §3.1）。
 *
 * 把我方 LMBridge/driver 的 `IModelDelta` 流适配成 pi 的 `StreamFn`
 * （= pi 内核与我方 LLM 栈之间的**唯一接缝**）。
 *
 * 契约要点（全部已核实）：
 *   · pi 要的是 `AssistantMessageEvent` 流（start / text_delta / … / toolcall_end / done / error），
 *     且**事件里携带的 `partial` / `done.message` 必须是组装好的 `AssistantMessage`** ——
 *     pi 的 `runLoop` 是从 `done.message.content` 里提取 toolCall 的 ⇒ **本适配器必须自己装配**；
 *   · 我方 `IModelDelta.tool_call` 是**完整**调用（参数已在上游组装完）⇒ 比 pi 的流式参数简单：
 *     `toolcall_start` + `toolcall_end` 背靠背发出即可；
 *   · finishReason 映射（我方 → pi `StopReason`）：
 *       stop/end_turn/(缺省) → 'stop'；length/max_tokens/max_completion_tokens → 'length'；
 *       tool_calls/tool_use → 'toolUse'；content_filter/error → **error 事件**（pi 的 done 不表达这两类）；
 *   · 我方 `truncated-text`（stop 但尾部结构截断）**不在本层处理** —— 它在 GuardrailBridge
 *     触发 `agentLoopContinue`（doc §3.6）；本层只如实上报 finishReason。
 *--------------------------------------------------------------------------------------------*/

import type { AssistantMessage, Context, Model, SimpleStreamOptions, StopReason, TextContent, ThinkingContent, ToolCall, Usage, StreamFn } from './piCoreTypes.js';
import { createAssistantMessageEventStream } from './vendor/piLoop.js';
import type { IModelDelta, IModelUsage } from '../../common/providers.js';

/** 我方模型流的供给口（由宿主注入，P1 由 LMBridge/driverService 适配实现）。 */
export type SarosModelStreamSource = (req: {
	readonly model: Model;
	readonly systemPrompt: string | undefined;
	/** pi 的 `Message[]`（已经过 `convertToLlm`；P1 由 LMBridge 侧转换消费）。 */
	readonly messages: readonly unknown[];
	readonly tools: readonly unknown[] | undefined;
	readonly signal: AbortSignal | undefined;
	readonly options: SimpleStreamOptions | undefined;
}) => AsyncIterable<IModelDelta>;

export interface PiStreamFnAdapterOptions {
	/** 在流结束时回调宿主（finishReason/usage/responseId 供我方 AgentRunState/缓存前缀记账）。 */
	readonly onDone?: (info: {
		readonly finishReason: string | undefined;
		readonly usage: IModelUsage | undefined;
		readonly responseId: string | undefined;
	}) => void;
}

/**
 * 创建一个 pi `StreamFn`：把 pi 的 (model, context, options) 调用转发到我方模型流源，
 * 并把 `IModelDelta` 流装配成 pi 的 `AssistantMessageEventStream`。
 */
export function createPiStreamFn(source: SarosModelStreamSource, opts?: PiStreamFnAdapterOptions): StreamFn {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
		void pumpStream(source, model, context, options, signal, stream, opts);
		return stream;
	};
}

type PiEventStream = ReturnType<typeof createAssistantMessageEventStream>;

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** 我方 `IModelUsage` → pi `Usage`（字段名已核实：inputTokens/outputTokens/cachedTokens/cacheWriteTokens/totalTokens/reasoning/credit）。 */
function toPiUsage(u: IModelUsage): Usage {
	const input = u.inputTokens ?? 0;
	const output = u.outputTokens ?? 0;
	return {
		input,
		output,
		cacheRead: u.cachedTokens ?? 0,
		cacheWrite: u.cacheWriteTokens ?? 0,
		...(u.reasoning !== undefined ? { reasoning: u.reasoning } : {}),
		totalTokens: u.totalTokens ?? (input + output),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.credit ?? 0 },
	};
}

/** finishReason 分类：done（stop/length/toolUse）还是 error。pi 的 done 只表达前三者。 */
function classifyFinishReason(fr: string | undefined): { kind: 'done'; reason: Extract<StopReason, 'stop' | 'length' | 'toolUse'> } | { kind: 'error'; message: string } {
	switch (fr) {
		case 'length': case 'max_tokens': case 'max_completion_tokens': return { kind: 'done', reason: 'length' };
		case 'tool_calls': case 'tool_use': return { kind: 'done', reason: 'toolUse' };
		case 'content_filter': case 'content-filter': return { kind: 'error', message: 'content_filter' };
		case 'error': return { kind: 'error', message: 'provider error' };
		default: return { kind: 'done', reason: 'stop' }; // stop / end_turn / undefined
	}
}

async function pumpStream(
	source: SarosModelStreamSource,
	model: Model,
	context: Context,
	options: SimpleStreamOptions | undefined,
	signal: AbortSignal | undefined,
	stream: PiEventStream,
	opts: PiStreamFnAdapterOptions | undefined,
): Promise<void> {
	const content: (TextContent | ThinkingContent | ToolCall)[] = [];
	let textBuf = '';
	let textIndex = -1;
	let thinkingBuf = '';
	let thinkingIndex = -1;
	let usage = emptyUsage();
	let lastModelUsage: IModelUsage | undefined;
	let finishReason: string | undefined;
	let responseId: string | undefined;
	let failed: { reason: 'aborted' | 'error'; message: string } | undefined;

	/** 组装当前 partial（pi 事件契约要求每个事件都带） */
	const partial = (): AssistantMessage => ({
		role: 'assistant',
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: 'pending',
		timestamp: Date.now(),
		...(responseId ? { responseId } : {}),
	});

	const ensureText = (): number => {
		if (textIndex < 0) {
			textIndex = content.length;
			content.push({ type: 'text', text: '' });
			stream.push({ type: 'text_start', contentIndex: textIndex, partial: partial() });
		}
		return textIndex;
	};
	const ensureThinking = (): number => {
		if (thinkingIndex < 0) {
			thinkingIndex = content.length;
			content.push({ type: 'thinking', thinking: '' });
			stream.push({ type: 'thinking_start', contentIndex: thinkingIndex, partial: partial() });
		}
		return thinkingIndex;
	};

	// ⚠ 必须先发 `start`：pi 的 streamAssistantResponse 只在 `start` 之后才开始转发 delta
	//   （vendored agentLoop 的 `if (partialMessage)` 守卫 —— partialMessage 只由 start 设置）。
	//   漏发 ⇒ 所有 text/thinking/toolcall delta 被静默丢弃（done.message 仍可用，掩盖得很隐蔽）。
	stream.push({ type: 'start', partial: partial() });

	try {
		for await (const d of source({ model, systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools, signal, options })) {
			if (signal?.aborted) { failed = { reason: 'aborted', message: 'aborted' }; break; }
			switch (d.type) {
				case 'text': {
					const chunk = d.content ?? '';
					if (!chunk) { break; }
					const idx = ensureText();
					textBuf += chunk;
					(content[idx] as TextContent).text = textBuf;
					stream.push({ type: 'text_delta', contentIndex: idx, delta: chunk, partial: partial() });
					break;
				}
				case 'thinking': {
					const chunk = d.content ?? '';
					if (!chunk) { break; }
					const idx = ensureThinking();
					thinkingBuf += chunk;
					(content[idx] as ThinkingContent).thinking = thinkingBuf;
					stream.push({ type: 'thinking_delta', contentIndex: idx, delta: chunk, partial: partial() });
					break;
				}
				case 'tool_call': {
					const tc = d.toolCall;
					if (!tc) { break; }
					// 我方 tool_call 是完整调用（参数已在上游组装完）⇒ 背靠背发 start+end。
					const toolCall: ToolCall = { type: 'toolCall', id: tc.id, name: tc.name, arguments: parseToolArgs(tc.name, tc.arguments) };
					const idx = content.length;
					content.push(toolCall);
					stream.push({ type: 'toolcall_start', contentIndex: idx, partial: partial() });
					stream.push({ type: 'toolcall_end', contentIndex: idx, toolCall, partial: partial() });
					break;
				}
				case 'usage': {
					if (d.usage) { usage = toPiUsage(d.usage); lastModelUsage = d.usage; }
					break;
				}
				case 'done': {
					finishReason = d.finishReason;
					responseId = d.responseId ?? responseId;
					break;
				}
				case 'error': {
					failed = { reason: 'error', message: d.error ?? 'unknown model error' };
					break;
				}
				case 'tool_progress': break; // 不进入正文（我方语义：仅 idle 续命 / UI 提示）
			}
		}
	} catch (err) {
		failed = { reason: 'error', message: err instanceof Error ? err.message : String(err) };
	}

	// 结束文本/思考块（pi 的 *_end 事件带最终内容）
	if (textIndex >= 0) { stream.push({ type: 'text_end', contentIndex: textIndex, content: textBuf, partial: partial() }); }
	if (thinkingIndex >= 0) { stream.push({ type: 'thinking_end', contentIndex: thinkingIndex, content: thinkingBuf, partial: partial() }); }

	opts?.onDone?.({ finishReason, usage: lastModelUsage, responseId });

	if (failed) {
		const message = partial();
		message.stopReason = failed.reason;
		message.errorMessage = failed.message;
		stream.push({ type: 'error', reason: failed.reason, error: message });
		stream.end(message);
		return;
	}

	const cls = classifyFinishReason(finishReason);
	if (cls.kind === 'error') {
		const message = partial();
		message.stopReason = 'error';
		message.errorMessage = cls.message;
		stream.push({ type: 'error', reason: 'error', error: message });
		stream.end(message);
		return;
	}
	const message = partial();
	message.stopReason = cls.reason;
	message.usage = usage;
	stream.push({ type: 'done', reason: cls.reason, message });
	stream.end(message);
}

/** 我方 `IToolCallInfo.arguments` 是 JSON 字符串 ⇒ 解析成 pi 的参数对象；解析失败按"参数不完整"throw（pi 语义）。 */
function parseToolArgs(toolName: string, argsJson: string | undefined): Record<string, unknown> {
	if (!argsJson) { return {}; }
	try {
		const v: unknown = JSON.parse(argsJson);
		if (v && typeof v === 'object' && !Array.isArray(v)) { return v as Record<string, unknown>; }
		throw new Error('arguments is not a JSON object');
	} catch (err) {
		throw new Error(`Tool "${toolName}" arguments are not complete/valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
}
