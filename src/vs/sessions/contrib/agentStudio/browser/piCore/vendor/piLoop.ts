/* ---------------------------------------------------------------------------
 * piLoop.ts —— 对 vendored bundle（`piAgentLoop.bundle.ts`，esbuild 产物 + @ts-nocheck）的
 * **类型化包装**。本文件是 bundle 的唯一类型边界：bundle 内部的运行时忠实性由
 * "esbuild 自真实源码打包"保证，这里只把导出函数收口到 `piCoreTypes` 的形状上。
 * -------------------------------------------------------------------------*/
import {
	agentLoop as rawAgentLoop,
	agentLoopContinue as rawAgentLoopContinue,
	createAssistantMessageEventStream as rawCreateStream,
} from './piAgentLoop.bundle.js';
import type {
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	AssistantMessageEventStream,
	PiAgentEventStream,
	StreamFn,
} from '../piCoreTypes.js';

/** pi 的 AssistantMessageEventStream 工厂（装配事件流的入口，StreamFnAdapter 用）。 */
export const createAssistantMessageEventStream = rawCreateStream as unknown as () => AssistantMessageEventStream;

/** pi 轻量 agent loop（新 prompt 起一轮）。 */
export const agentLoop = rawAgentLoop as unknown as (
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
) => PiAgentEventStream;

/** pi 轻量 agent loop（从当前上下文续跑 —— 我方截断续写/重试的映射点，doc §3.6）。 */
export const agentLoopContinue = rawAgentLoopContinue as unknown as (
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
) => PiAgentEventStream;
