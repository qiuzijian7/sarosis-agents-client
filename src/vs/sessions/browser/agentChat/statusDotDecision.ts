/*---------------------------------------------------------------------------------------------
 *  statusDotDecision.ts — agent 状态圆点的纯决策函数。
 *
 *  与 streamPinDecision.ts 同属「把易错的判定逻辑抽成纯函数以便单测锁定」的惯例。
 *
 *  背景：`AgentStatus` 是 agent 实体上的字段，header 头像右下角圆点的颜色由它决定。
 *  该字段此前全仓无人回写，圆点恒为灰色「空闲」。修复后在发送链路回写，
 *  但这带来一个必须锁定的约束：**写入必须严格配对**，否则圆点会卡在绿色。
 *--------------------------------------------------------------------------------------------*/

import { AgentStatus } from './agentChatTypes.js';

/**
 * 状态是否真的发生了变化。
 *
 * 存在的理由：`setAgentStatus()` 每次发送/结束都会被调用，若不变也走一遍 DOM 写入
 * （改 backgroundColor + 查两次 querySelector）就是纯浪费。这是廉价的幂等守卫。
 *
 * 注意两端都做 `?? Idle` 归一：agent 实体上的 status 可能是 undefined
 * （旧数据 / 自定义 agent 未声明），undefined 与 Idle 在视觉上等价，
 * 不应被判为「变化」而触发无谓重绘。
 */
export function didAgentStatusChange(
	previous: AgentStatus | undefined,
	next: AgentStatus,
): boolean {
	return (previous ?? AgentStatus.Idle) !== (next ?? AgentStatus.Idle);
}

/**
 * 发送链路的状态映射（2026-09-18 简化）。
 *
 * 产品决策：**只区分「发送中」与「空闲」**。`thinking` 需要逐 delta 判定、
 * `error` 会引入「何时清除」的额外状态机，当前语义下不值得 ——
 * 故本函数只有两个返回值。
 *
 * @param isSending 是否正处于发送/流式输出中
 */
export function resolveSendPhaseStatus(isSending: boolean): AgentStatus {
	return isSending ? AgentStatus.Working : AgentStatus.Idle;
}
