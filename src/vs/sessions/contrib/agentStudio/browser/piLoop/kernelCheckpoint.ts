/*---------------------------------------------------------------------------------------------
 *  pi 内核驱动器 —— checkpoint 断点续跑（2026-09-20 自 piTurnKernel.ts 拆出，D2）。
 *
 *  双向对齐 legacy：
 *    · 恢复（executor:691-711/877-895）：messages 优先 / loopMessages 回落（旧快照兼容）+
 *      迭代计数接续；**phase 故意不恢复**（快照最多陈旧 3 轮，据它跳 LLM 会重复执行
 *      副作用工具 —— 重跑整轮只多烧 token、无正确性损失，有 turnHostContract 测试守护）；
 *    · 落盘（turnPostIteration:441-472）：每 3 轮 `buildCheckpointSnapshot` → sink，
 *      fire-and-forget 不阻塞循环；sink 由 agentDriverService 注入（workspace storage），
 *      缺省零行为变更。
 *--------------------------------------------------------------------------------------------*/

import type { IAgentTurnRequest } from '../../common/providers.js';
import type { AgentRunState } from '../../common/agentRunState.js';
import { buildCheckpointSnapshot } from '../parts/turnHelpers.js';
import { piMessagesToLoopMessages } from './kernelMessages.js';
import type { AgentMessage } from './types.js';
import type { IPiKernelHost } from './piTurnKernel.js';

/** resumeFrom 的恢复结果（种子消息 + 迭代偏移）。 */
export interface IResumeResolution {
	readonly restoredMessages: readonly import('../../common/agentRunState.js').AgentRunMessage[] | undefined;
	readonly restoredIteration: number;
}

/** 从 request.resumeFrom 解析恢复点（纯解析+日志；不碰任何状态）。 */
export function resolveResume(request: IAgentTurnRequest, log: IPiKernelHost['_logService']): IResumeResolution {
	const restored = request.resumeFrom;
	if (!restored) {
		return { restoredMessages: undefined, restoredIteration: 0 };
	}
	let restoredMessages: IResumeResolution['restoredMessages'];
	let restoredIteration = 0;
	const persisted = (restored.messages && restored.messages.length > 0 ? restored.messages : restored.loopMessages) ?? undefined;
	if (persisted && persisted.length > 0) {
		restoredMessages = [...persisted];
		log.info(`[PiKernel] Resume: restored ${persisted.length} messages (from ${restored.messages?.length ? 'messages' : 'loopMessages(legacy)'})`);
	}
	if (typeof restored.iteration === 'number' && restored.iteration > 0) {
		restoredIteration = restored.iteration;
		log.info(`[PiKernel] Resume: restored iteration=${restoredIteration}`);
	}
	return { restoredMessages, restoredIteration };
}

export interface ICheckpointWriterDeps {
	readonly request: IAgentTurnRequest;
	readonly host: IPiKernelHost;
	/** 迭代预算基准（background 子代理 1000 / 主代理 100 / 测试缝）。 */
	readonly baseMaxTurns: number;
	readonly restoredIteration: number;
	readonly getRunState: () => AgentRunState;
	readonly getTranscript: () => readonly AgentMessage[];
}

export interface ICheckpointWriter {
	/** emit 钩子：turn_end 时按节奏落盘（含 restored 偏移）。 */
	readonly onTurnEnd: () => void;
}

/** checkpoint 落盘器：每 3 轮快照一次（turnPostIteration 的 CHECKPOINT_PERSIST_INTERVAL 同款节奏）。 */
export function createCheckpointWriter(deps: ICheckpointWriterDeps): ICheckpointWriter {
	const { request, host, baseMaxTurns, restoredIteration, getRunState, getTranscript } = deps;
	let piTurnCounter = 0;
	return {
		onTurnEnd() {
			const sink = request.checkpointSink;
			const absoluteIteration = restoredIteration + piTurnCounter;
			piTurnCounter++;
			if (!sink || absoluteIteration % 3 !== 0) { return; }
			try {
				const snapshot = buildCheckpointSnapshot(
					getRunState(),
					{
						maxIterations: baseMaxTurns,
						remaining: Math.max(0, baseMaxTurns - absoluteIteration),
						consumed: absoluteIteration,
						graceCall: false,
						graceUsed: false,
					},
					piMessagesToLoopMessages(getTranscript()),
					'react', // pi 内核即 ReAct 单循环；混跑时 legacy resume 据此恢复范式覆盖
					absoluteIteration,
				);
				void Promise.resolve(sink(snapshot)).catch(err =>
					host._logService.warn('[PiKernel] checkpoint sink failed: ' + (err instanceof Error ? err.message : String(err))),
				);
			} catch (snapshotError) {
				host._logService.warn('[PiKernel] Checkpoint snapshot failed: ' + (snapshotError instanceof Error ? snapshotError.message : String(snapshotError)));
			}
		},
	};
}
