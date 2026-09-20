/*---------------------------------------------------------------------------------------------
 * stateAdapter.ts —— **State 适配器**（六件套之一，doc §3.5）。
 *
 * pi 轻量 loop 是**内存态**（不持久化）；我方的运行状态机是 `AgentRunState`
 *（快照 + 每 3 轮 checkpoint + restoreRunState）。
 *
 * 本期（P0）：只定义桥接接口与映射表（不接线）。
 * P1 落点（TODO）：
 *   · pi turn 边界（turn_start/turn_end）⇒ 我方 `patchRetry` / checkpoint（每 3 轮）；
 *   · pi 的重试/续跑计数 ⇐ 我方 `AgentRetryCounters`（lengthTruncated/truncatedText/toolCallLost/…）；
 *   · pi `agentLoopContinue` 续跑 ⇒ 我方 `restoreRunState` 快照恢复（粗粒度先保留）。
 *
 * ⚠ pi harness 的 durable 三段式（planned→effect_pending→outcome）属 P2 增强，不在本层。
 *--------------------------------------------------------------------------------------------*/

/**
 * pi turn 计数与我方 `AgentRetryCounters` 的映射表（P1 接线用）。
 *
 * pi 侧没有显式的 retry 计数器（重试走 `isRetryableAssistantError` + 退避，次数由 config 上限控制），
 * 我方则有分类计数（lengthTruncated / truncatedText / toolCallLost / reasoningOnly / emptyResponse …）。
 * 映射关系在 GuardrailBridge 落地时确定（它持有这些计数的权威来源）。
 */
export interface IPiStateBridge {
	/** pi 到达一个 turn 边界（turn_end）时回调（P1：驱动 checkpoint 每 3 轮）。 */
	readonly onTurnBoundary?: (turnIndex: number) => void;
}

/** P0 占位：返回一个 no-op 桥（保持类型与文档一致，避免 P1 再改签名）。 */
export function createNoopPiStateBridge(): Required<IPiStateBridge> {
	return { onTurnBoundary: () => { /* P1 接线 */ } };
}
