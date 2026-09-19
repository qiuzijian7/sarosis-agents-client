/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 单轮 LLM 流消费段（原 `executeAgentTurnDirect` 主循环内联，agentTurnExecutor.ts
 * :2639 的 `messagesForLlm` 起 → :3113 的 `catch` 结束）。
 *
 * ## 分段抽取进度
 *
 * S3a（本文件当前形态）：**建流段**——plan 发送副本 → 发请求 → 自适应首 token
 * 超时 → 包 idle 超时。纯计算 + 建流，无 `yield`、无循环控制流、无跨轮状态。
 *
 * S3b（待抽）：异常分类与重试（瞬态错误 / 溢出压缩 / 首 token 超时）。
 * S3c（待抽）：delta 消费循环（约 25 个诊断计数器 + 工具调用组装）。
 *
 * ## S3c 抽取时的既有约束（已探明，勿遗忘）
 *
 * - 原段内 4 处 `break`/`continue` 直接作用于外层 `while` 主循环，generator 无法
 *   跨边界控制调用方循环，需改为在 return 值上回传信号：
 *     `'retry'` ← 原 `continue`（瞬态错误 :3039 / 溢出压缩 :3072 / 首 token 超时 :3090）
 *     `'break-loop'` ← 原 `break`（模型调用致命失败 :3112）
 * - `yield* _compressContextIfNeeded(true)` 要求抽出的消费段本身是 generator 且能
 *   委托压缩事件流（事件到达时序影响 UI 渲染，不能用回调收集）。
 * - idle 超时（`isTimeout` 且非首 token 超时）仍须 `throw` 冒泡到函数外，经
 *   `runAgentLoop → _executeWithFallback` 切换备用模型。
 *
 * @module agentStudio/turnLlmStream
 */

import type { IChatContext, IChatStreamDelta, IModelDelta, IChatMessage, IModelOptions, IModelProvider, IModelSelection } from '../common/providers.js';
import type { AgentRunMessage } from '../common/agentRunState.js';
import { computeAdaptiveFirstTokenTimeout, withStreamTimeout } from '../common/resilience.js';
import {
	appendMessages,
	isTransientStreamError,
	isContextOverflowError,
	TRANSIENT_ERROR_MAX_RETRIES,
	TRANSIENT_ERROR_BASE_DELAY_MS,
	TRANSIENT_ERROR_BACKOFF_FACTOR,
	TRANSIENT_ERROR_MAX_DELAY_MS,
} from '../common/agentRunState.js';
import { buildPlanSystemReminder } from '../common/chatModeConfig.js';
import { sanitizeToolResultText } from '../common/assistantVisibleText.js';
import { limitToolResultSize, safeStringifyToolResult } from './toolCallUtils.js';

/** 建流段实际读到的 host 面。 */
export interface IStreamHost {
	_logService: {
		info(message: string): void;
		warn(message: string, ...args: unknown[]): void;
		error(message: string, ...args: unknown[]): void;
	};
	_estimateMessagesTokens(messages: AgentRunMessage[]): number;
	_modelStreamTimeoutPolicy: { firstTokenTimeout?: number; [key: string]: unknown };
	_loopAbortController?: { signal: AbortSignal };
}

/** 模型无 delta 心跳的 idle 超时（与 policy 合并，此处仅作缺省）。 */
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 45_000;

/** 建流段依赖（只读）。 */
export interface ITurnStreamRequestDeps {
	readonly host: IStreamHost;
	readonly modelProvider: IModelProvider;
	readonly selection: IModelSelection;
	readonly modelOptions: IModelOptions;
	readonly context: IChatContext;
	/** 是否子代理（plan reminder 仅主代理注入） */
	readonly isSubAgent: boolean;
	/** 当前 work mode（plan 模式追加 system reminder） */
	readonly workMode: string;
	readonly planFilePath: string | undefined;
	readonly messages: () => AgentRunMessage[];
	readonly lastRealPromptTokens: number | undefined;
}

/** 建流段产出：带超时的流 + 本轮 prompt 粗估。 */
export interface ITurnStreamRequestResult {
	readonly stream: AsyncIterable<IModelDelta>;
	readonly estPromptTokens: number;
}

/**
 * 构建本轮 LLM 请求并包上自适应超时，返回可消费的流。
 *
 * 不读取/改写 `messages` 本体（plan reminder 只进**发送副本**），不持有跨轮状态。
 */
export function buildTurnLlmStream(deps: ITurnStreamRequestDeps): ITurnStreamRequestResult {
	const { host } = deps;

	// buildPlanSystemReminder（5 阶段规划工作流指引）此前生产代码零调用——
	// plan 阶段无任何工作流指引注入，只有 plan_exit 后的 buildBuildSwitchReminder
	// 还活着。现按其设计意图（chatModeConfig 注释：per-iteration injection）
	// 每轮 LLM 调用前注入到**发送副本**：
	//   - 不写入 messages 本体 → 长循环不堆积重复 reminder（压缩/checkpoint 亦不受污染）
	//   - 末尾追加 system 消息（与 buildBuildSwitchReminder 同 role），不破坏
	//     system 前缀缓存（fork 指纹基于首条 system + tools，不受末尾消息影响）
	// 仅主代理注入：plan 子代理（explore）继承的是只读权限天花板，
	// 不应收到「写计划文件 + plan_exit」的 5 阶段指令。
	const messagesForLlm = (deps.workMode === 'plan' && !deps.isSubAgent)
		? appendMessages(deps.messages(), { role: 'system', content: buildPlanSystemReminder(deps.planFilePath) })
		: deps.messages();
	// AgentRunMessage 是宽松结构（见 agentRunState.ts:34 说明），provider 侧要 IChatMessage[]，
	// 二者此前靠 `let messages: any[]` 隐式相通；收口成 AgentRunMessage[] 后需显式桥接。
	const rawStream = deps.modelProvider.chat(
		deps.selection.modelId,
		messagesForLlm as unknown as IChatMessage[],
		deps.modelOptions,
		deps.context,
	);

	// ─── 自适应首 token 超时（方案 B）────────────────────────────
	// 固定 45s 对大 prompt 冷缓存请求过紧（实测 hy3-ioa 34k tokens TTFB 46.4s，
	// 被误杀后 1.4s 网关实际正常返回）。prefill 耗时与 prompt 大小正相关，
	// 按估算 token 数阶梯放宽（>16k 每 8k +15s，封顶 115s < HTTP 120s）。
	// 取本轮粗估与上轮真实 prompt_tokens 的较大者，避免粗估低估导致宽限不足。
	const estPromptTokens = Math.max(
		host._estimateMessagesTokens(deps.messages()),
		deps.lastRealPromptTokens ?? 0,
	);
	const baseFirstTokenTimeout = host._modelStreamTimeoutPolicy.firstTokenTimeout ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
	const adaptiveFirstTokenTimeout = computeAdaptiveFirstTokenTimeout(estPromptTokens, baseFirstTokenTimeout);
	const callTimeoutPolicy = adaptiveFirstTokenTimeout !== baseFirstTokenTimeout
		? { ...host._modelStreamTimeoutPolicy, firstTokenTimeout: adaptiveFirstTokenTimeout }
		: host._modelStreamTimeoutPolicy;
	if (adaptiveFirstTokenTimeout !== baseFirstTokenTimeout) {
		host._logService.info(
			`[AgentOS] Adaptive first-token timeout: ${baseFirstTokenTimeout}ms → ${adaptiveFirstTokenTimeout}ms (estPromptTokens=${estPromptTokens})`,
		);
	}

	// 流式 idle 超时：模型静默挂起（无 delta 心跳超过阈值）时抛 TimeoutError，
	// 由下游 catch 重新抛出并触发 _executeWithFallback 的备用模型切换（对齐 LangGraph TimeoutPolicy）。
	const stream = withStreamTimeout(rawStream, callTimeoutPolicy as never, {
		signal: host._loopAbortController?.signal,
		log: (lvl: string, msg: string) => {
			if (lvl === 'error') { host._logService.error(msg); }
			else if (lvl === 'warn') { host._logService.warn(msg); }
			else { host._logService.info(msg); }
		},
	});

	return { stream, estPromptTokens };
}

/** 首 token 超时重试上限与固定退避（冷启动预热）。 */
const FIRST_TOKEN_TIMEOUT_MAX_RETRIES = 2;
const FIRST_TOKEN_TIMEOUT_RETRY_DELAY_MS = 2_000;

/** S3b 异常处置段依赖。 */
export interface ITurnStreamCatchDeps {
	readonly host: IStreamHost;
	readonly request: { readonly agentId: string; readonly sessionId?: string };
	readonly loopState: { iteration: number; overflowCompressionDone: boolean };
	/** 当前 messages（用于剥离悬空 assistant tool_calls） */
	readonly messages: () => AgentRunMessage[];
	readonly setMessages: (next: AgentRunMessage[]) => void;
	readonly syncMessages: () => void;
	readonly retry: () => { transientError: number; firstTokenTimeout: number };
	readonly patchRetry: (patch: { transientError?: number; firstTokenTimeout?: number }) => void;
	/** 强制上下文压缩；其事件流需原样透传给调用方 */
	readonly compressContext: (force: boolean) => AsyncGenerator<IChatStreamDelta>;
	readonly startedToolIds: ReadonlySet<string>;
	readonly endedToolIds: Set<string>;
	/** 恢复 runState 的 phase 字段（原 `runState = reduceRunState(...)`） */
	readonly setPhaseError: () => void;
}

/** S3b 异常处置段的控制流结果。 */
export type CatchDisposition =
	/** 原 `continue` —— 回到主循环重试 */
	| { readonly kind: 'retry' }
	/** 原 `break` —— 致命失败，结束本轮流式 */
	| { readonly kind: 'break-loop' };

/**
 * 处理模型调用的异常：瞬态重试 / 溢出压缩重试 / 首 token 超时重试 / 致命失败。
 *
 * ## 为什么是 generator 而非普通函数
 *
 * 两条路径需要向上层发事件：溢出压缩的 `yield* compressContext(true)` 必须原样透传
 * 压缩事件流；致命失败时要为悬挂的 `tool_start` 补发合成 `tool_result` + `tool_end`
 * （否则 webview 会留下永不消失的 spinner）。
 *
 * ## 唯一逃逸路径
 *
 * 流式 idle 超时（`isTimeout` 且非首 token 超时）仍 `throw`——须冒泡到函数外，经
 * `runAgentLoop → _executeWithFallback` 切换备用模型（对齐 LangGraph TimeoutPolicy）。
 */
export async function* handleTurnStreamError(
	error: unknown,
	deps: ITurnStreamCatchDeps,
): AsyncGenerator<IChatStreamDelta, CatchDisposition, void> {
	const { host, loopState } = deps;

	// 模型调用失败：显式置 phase=error（进 runState，供异常路径 checkpoint 读取）
	deps.setPhaseError();

	// ── 维度 3：瞬态错误重试（对齐 MiMo persistentRetrySchedule）────────
	// SSE 超时 / 网络中断 / HTTP 429/5xx 等瞬态错误用指数退避重试，
	// 避免 1 次瞬时抖动就中止整轮对话。TimeoutError 仍向上抛（触发 fallback 模型切换）。
	const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
	if (!isTimeout && isTransientStreamError(error) && deps.retry().transientError < TRANSIENT_ERROR_MAX_RETRIES) {
		deps.patchRetry({ transientError: deps.retry().transientError + 1 });
		const delay = Math.min(
			TRANSIENT_ERROR_BASE_DELAY_MS * Math.pow(TRANSIENT_ERROR_BACKOFF_FACTOR, deps.retry().transientError - 1),
			TRANSIENT_ERROR_MAX_DELAY_MS,
		);
		host._logService.warn(
			`[AgentOS] Transient stream error on iteration ${loopState.iteration}, ` +
			`retrying in ${delay}ms (attempt ${deps.retry().transientError}/${TRANSIENT_ERROR_MAX_RETRIES}): ` +
			`${error instanceof Error ? error.message : String(error)}`,
		);
		await new Promise(resolve => setTimeout(resolve, delay));
		return { kind: 'retry' };
	}

	// ── P0-1: 上下文溢出反应式压缩 + 自动重试（对齐 Hermes/OpenClaw）────
	// HTTP 400 code 11133 / invalid_parameter_value / context_length_exceeded 等
	// 溢出错误：先强制压缩当前消息，再用压缩产物重发一次，而非直接结束 turn。
	// 触发前提：非 timeout、确认为溢出错误、且本次 turn 尚未做过溢出压缩。
	// 压缩后 messages 更新为紧凑产物；若重试仍失败，第二次落入 error 分支正常结束。
	if (!isTimeout && isContextOverflowError(error) && !loopState.overflowCompressionDone) {
		loopState.overflowCompressionDone = true;
		// 剥离最后一条失败的 assistant 消息（对齐 OpenClaw removeLastAssistantMessage），
		// 避免把「触发 400 的悬空 tool_calls」留在压缩输入里再次污染。
		const currentMessages = deps.messages();
		if (currentMessages.length > 0) {
			const lastMessage = currentMessages[currentMessages.length - 1] as { role?: string; toolCalls?: unknown[] } | undefined;
			if (lastMessage && lastMessage.role === 'assistant' && Array.isArray(lastMessage.toolCalls) && lastMessage.toolCalls.length > 0) {
				deps.setMessages(currentMessages.slice(0, -1));
				deps.syncMessages();
				host._logService.warn(
					`[AgentOS] Overflow recovery: dropped trailing assistant tool_calls message before re-compression`,
				);
			}
		}
		// 强制压缩（force=true）：绕过 token 阈值/消息数下限/冷却/防抖判定，
		// 因为溢出 400 时服务端 maxInputTokens 可能小于本地 window×0.3，
		// 常规触发判定会误判为 below_token_threshold 而 skip。
		host._logService.warn(
			`[AgentOS] Context overflow detected (${error instanceof Error ? error.message.slice(0, 160) : String(error)}) — ` +
			`force-compressing + retry (overflowCompressionDone=${loopState.overflowCompressionDone})`,
		);
		yield* deps.compressContext(true);
		return { kind: 'retry' };
	}

	host._logService.error(`[AgentOS] Model call failed on iteration ${loopState.iteration}:`, error);

	// ── 首 token 超时（冷启动）有界重试（预热优化）──────────────
	// 网关/模型实例冷启动时 TTFT 可远超预期 prefill（实测 hy3-ioa 冷启动 TTFT≈86s
	// 被首 token 预算误杀，但流最终会在 86s 正常返回）。第一次请求本身就把网关
	// "预热"，重试通常立即恢复（见 agentModelAccess 恢复提示「网关预热后通常立即恢复」）。
	// 仅对「首 token 前」超时重试（idle 超时=中途静默挂起，重试无意义），有界 1 次，
	// 用尽后仍向上抛触发 _executeWithFallback 切换备用模型（保持既有 fallback 行为）。
	const isFirstTokenTimeout = isTimeout && /first-token/.test(error instanceof Error ? (error.message ?? '') : '');
	if (isFirstTokenTimeout && deps.retry().firstTokenTimeout < FIRST_TOKEN_TIMEOUT_MAX_RETRIES) {
		deps.patchRetry({ firstTokenTimeout: deps.retry().firstTokenTimeout + 1 });
		host._logService.warn(
			`[AgentOS] First-token timeout (cold-start?) on iteration ${loopState.iteration}, ` +
			`retrying same model (attempt ${deps.retry().firstTokenTimeout}/${FIRST_TOKEN_TIMEOUT_MAX_RETRIES}) — ` +
			`gateway usually warms up after first request: ${error instanceof Error ? error.message : String(error)}`,
		);
		await new Promise(resolve => setTimeout(resolve, FIRST_TOKEN_TIMEOUT_RETRY_DELAY_MS));
		return { kind: 'retry' };
	}

	// 流式 idle 超时（模型静默挂起）：作为硬失败向上抛出，
	// 经由 runAgentLoop → _executeWithFallback 切换到备用模型（对齐 LangGraph TimeoutPolicy）。
	if (isTimeout) {
		throw error;
	}

	// 如果是第一次迭代失败，尝试 fallback
	if (loopState.iteration === 1) {
		yield { type: 'error', content: `Model call failed: ${error instanceof Error ? error.message : String(error)}` };
	}

	// Reconcile any tool_start that was emitted during streaming before
	// the model call failed — webview must not be left with spinners.
	for (const orphanId of deps.startedToolIds) {
		if (deps.endedToolIds.has(orphanId)) {
			continue;
		}
		host._logService.warn(`[AgentOS] Orphaned tool_start after model error: ${orphanId} — emitting synthetic tool_result + tool_end`);
		const orphanResultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({ error: 'Model call failed before tool could execute' })));
		yield { type: 'tool_result', content: orphanResultStr, toolCallId: orphanId };
		yield { type: 'tool_end', toolCallId: orphanId, success: false };
		deps.endedToolIds.add(orphanId);
	}

	return { kind: 'break-loop' };
}
