/*---------------------------------------------------------------------------------------------
 * piTurnDriver.ts —— **Pi Turn Driver**（六件套的装配点，doc §2/§5）。
 *
 * 用 vendored pi 内核（`vendor/agentLoop.ts`）驱动一个 **craft 最小路径**的 turn，
 * 产出我方 `IChatStreamDelta`（对外契约不变 ⇒ UI/会话/审批/图谱零改动）。
 *
 * P0 范围（本文件的边界）：
 *   · 只跑通"文本 + 工具调用 + 续跑"的最小链路；
 *   · `modelStream`（我方模型流源）与工具执行器都由宿主注入 ⇒ **本文件不依赖 LMBridge/工具系统**，
 *     可独立单测（见 `test/browser/piCoreAdapters.test.ts`）；
 *   · 不接 `executeAgentTurnDirect`（那是热点文件，且正在经历 turnKernel 重构）——
 *     P1 才做内核替换（双跑对拍为准入）。
 *--------------------------------------------------------------------------------------------*/

import { agentLoop } from './vendor/piLoop.js';
import { createPiStreamFn } from './streamFnAdapter.js';
import type { SarosModelStreamSource } from './streamFnAdapter.js';
import { convertToLlm } from './contextAdapter.js';
import { agentEventToChatDeltas } from './eventAdapter.js';
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool, Model, StreamFn } from './piCoreTypes.js';
import type { IChatStreamDelta } from '../../common/providers.js';

export interface PiCraftTurnParams {
	/** pi `Model` 描述（loop 只透传给 streamFn；api/provider/id 供装配 partial 用）。 */
	readonly model: Model;
	readonly systemPrompt: string;
	/** 会话历史（pi `Message` 形状；P1 由宿主从我方会话转换）。 */
	readonly history?: readonly AgentMessage[];
	/** 本轮用户输入。 */
	readonly prompt: string;
	/** 本轮可用工具（已用 `toPiAgentTool` 适配）。 */
	readonly tools?: readonly AgentTool[];
	/** 我方模型流源（LMBridge 适配；P1 接线）。 */
	readonly modelStream: SarosModelStreamSource;
	readonly signal?: AbortSignal;
	/** turn 边界回调（P1 接 StateAdapter ⇒ checkpoint 每 3 轮）。 */
	readonly onTurnBoundary?: (turnIndex: number) => void;
}

/**
 * 跑一个 craft 最小路径的 turn。
 * 返回的异步生成器逐个产出我方 `IChatStreamDelta`（与 legacy `executeAgentTurnDirect` 同一契约）。
 */
export async function* runPiCraftTurn(params: PiCraftTurnParams): AsyncGenerator<IChatStreamDelta, void> {
	const userMsg: AgentMessage = { role: 'user', content: params.prompt, timestamp: Date.now() };
	const context: AgentContext = {
		systemPrompt: params.systemPrompt,
		messages: [...(params.history ?? [])],
		tools: params.tools ? [...params.tools] : undefined,
	};
	const config: AgentLoopConfig = {
		model: params.model,
		convertToLlm,
	};
	const streamFn: StreamFn = createPiStreamFn(params.modelStream);

	const events = agentLoop([userMsg], context, config, params.signal, streamFn);
	let turnIndex = 0;
	for await (const ev of events) {
		if (ev.type === 'turn_end') {
			turnIndex++;
			params.onTurnBoundary?.(turnIndex);
		}
		for (const d of agentEventToChatDeltas(ev)) {
			yield d;
		}
	}
	await events.result();
}
