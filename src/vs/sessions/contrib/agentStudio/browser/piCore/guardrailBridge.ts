/*---------------------------------------------------------------------------------------------
 * guardrailBridge.ts —— **Guardrail 桥**（六件套之一，doc §3.6）。
 *
 * 把我方护栏族接到 pi 的钩子上，**语义不削弱**：
 *   · pi `Agent` 的 `beforeToolCall`（可 `{ block: true, reason }` / 改参）⇐ 我方
 *     `detectToolCallLoop`（工具循环）/ `detectArgumentChurn`（参数抖动）/ XML 泄漏 / 审批门；
 *   · **length 截断 ⇒ 整批 tool call 作废**（pi 原生语义：流式参数经 salvage 可能"合法但不完整"）
 *     —— 与我方逐工具处理并存，length 时优先"整批作废"；
 *   · **`truncated-text`（stop 但尾部结构截断，`detectTruncatedTail`）⇒ pi `agentLoopContinue` 续跑**
 *     （我今天加的机制 ⇒ pi 的原生续跑原语，doc §3.6）。
 *
 * 本期（P0）：只定义钩子形状与映射（不接线）。
 *--------------------------------------------------------------------------------------------*/

import type { AgentToolCall } from './piCoreTypes.js';

/** pi `beforeToolCall` 的返回形状（block 则回 error tool result；否则可用改写后的参数继续）。 */
export interface PiBeforeToolCallResult {
	readonly block?: boolean;
	readonly reason?: string;
	readonly args?: Record<string, unknown>;
}

/** 我方护栏判定口（P1 由 detectToolCallLoop / detectArgumentChurn / 审批门 适配实现）。 */
export type SarosToolGuard = (call: AgentToolCall) => PiBeforeToolCallResult | undefined;

/**
 * 组合多个护栏为 pi 的 `beforeToolCall`（P1 接线用）。P0 占位：返回 undefined = 放行。
 *
 * 语义对齐 pi：任一护栏返回 `{ block:true }` ⇒ block；`args` 改写取第一个非空的。
 */
export function composeBeforeToolCall(guards: readonly SarosToolGuard[]): (call: AgentToolCall) => PiBeforeToolCallResult | undefined {
	return (call) => {
		for (const g of guards) {
			const r = g(call);
			if (r?.block) { return r; }
			if (r?.args) { return r; }
		}
		return undefined;
	};
}

// TODO(P1, doc §3.6)：length 截断 ⇒ 整批 tool call 作废（pi 原生）；
// TODO(P1, doc §3.6)：truncated-text ⇒ agentLoopContinue（接我方 detectTruncatedTail + 续写指令）。
