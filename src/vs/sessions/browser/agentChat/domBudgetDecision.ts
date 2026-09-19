/*---------------------------------------------------------------------------------------------
 *  domBudgetDecision.ts — 「DOM 窗口裁剪」的**纯决策**（无 DOM 依赖 ⇒ 可单测）
 *
 *  背景（2026-09-19 app 卡死取证，两份 renderer.log 实证）：
 *   · 09:18 实例：msgs 85→107，dom 116k→**132k**
 *   · 11:01 实例：msgs 85→117，dom 102k→**121k**（12:36:35 起硬冻结：单线程 46–53% CPU、
 *     调试端口 9335 回 000、主进程 `Runtime.evaluate` 超时、日志停在 `_executeToolCalls: begin`）
 *
 *  结论：节点膨胀的主因是**单条消息的节点密度**（长代码块 + 工具卡 + 语法高亮 span，
 *  实测均值 ≈1000 节点/条），**不是消息条数** —— 故原判据「条数 > 120 才裁剪」在本案
 *  **从未触发**（117 < 120）✗ ⇒ 节点一路涨到死亡区（app 自带看门狗 `DOM_ERROR_NODES=120k`）。
 *
 *  本模块把判据升级为「**节点预算**」：页面节点超预算即裁剪，且用更小的保留窗口，
 *  让页面在到达 12 万死亡区**之前**先降下来。
 *
 *  ⚠ 纯函数、零副作用 ⇒ 只做判定，卸载动作由 `AgentChatPanelBase._trimDistantMessages` 执行。
 *--------------------------------------------------------------------------------------------*/

/**
 * ★★★ 2026-09-19（用户报「LLM 长时间执行，突然 LLM 的气泡 UI 消失」）：
 * 把「**不得卸载**的消息下标」并入保留窗口 —— **只扩大、绝不缩小** ✓。
 *
 * 为什么必须有（日志 + 代码取证 ✓）：
 *   保留窗口 = **视口 ± 缓冲** ✓（用户停在哪儿就保哪儿 ✓，这本身是对的 ✓）。
 *   但**用户可能停在中间**：滚上去看历史、或搜索跳到旧消息 ✓
 *   —— 真机日志里 `agentChatPanel.dropdowns.ts:1155` 正是「跳转完成后立刻裁剪」✓。
 *   此时**尾部会被整条 remove** ✗✗ ⇒ 正在执行（或刚输出完）的那条 assistant 气泡
 *   **从 DOM 消失** ✓（数据 `_messages` 没丢 ✓，但若不重渲染就**不会回来** ⇒
 *   用户看到的就是"气泡突然没了" ✓）。
 *   ⇒ 规则：**尾部那条** + **最后一条 assistant** 永久留在窗口内 ✓（常数条，不抵消裁剪收益 ✓）。
 *
 * @param keepFrom     原保留窗口起点（含缓冲；来自视口 ✓）
 * @param keepTo       原保留窗口终点（含缓冲 ✓）
 * @param count        已渲染消息条数
 * @param protectedIdx 必须保留的下标（负数/越界/非整数自动忽略 ✓）
 * @returns 扩大后的窗口；`count <= 0` 或窗口本身为空时**原样返回**（不越权改动 ✓）
 */
export function withProtectedRange(
	keepFrom: number,
	keepTo: number,
	count: number,
	protectedIdx: readonly number[],
): { keepFrom: number; keepTo: number } {
	if (count <= 0) { return { keepFrom, keepTo }; }
	// 先把调用方给的区间**归一化**到 [0, count-1] ✓（即使传反了 also 安全 ✓）
	const lo = Math.max(0, Math.min(keepFrom, keepTo));
	const hi = Math.min(count - 1, Math.max(keepFrom, keepTo));
	let from = lo;
	let to = hi;
	for (const raw of protectedIdx) {
		if (!Number.isInteger(raw) || raw < 0 || raw >= count) { continue; }
		if (raw < from) { from = raw; }
		if (raw > to) { to = raw; }
	}
	return { keepFrom: from, keepTo: to };
}

export interface DomTrimLimits {
	/** DOM 中消息元素数上限（超出即卸载远端）。 */
	readonly messageLimit: number;
	/** 常规（条数触发）时视口上下各保留的缓冲条数。 */
	readonly messageKeep: number;
	/** **页面总节点预算**：超过即裁剪。 */
	readonly nodeBudget: number;
	/** 节点预算触发时保留的缓冲条数（更激进：先保命，滚回去会按需重建）。 */
	readonly nodeKeep: number;
}

/**
 * 默认阈值。
 *
 * `nodeBudget` 取 **40k**：明显早于 `AgentChatService.DOM_WARN_NODES = 60k`（该值只是**告警**，
 * 不触发任何动作）与 `DOM_ERROR_NODES = 120k`（死亡区）。留出提前量的原因：从「安排裁剪」
 * 到「真正卸载」还要等一个空闲帧（`requestIdleCallback`），而流式期页面节点仍在涨。
 */
export const DOM_TRIM_LIMITS: DomTrimLimits = {
	messageLimit: 120,
	messageKeep: 24,
	nodeBudget: 40_000,
	nodeKeep: 8,
};

export type DomTrimReason = 'under-limits' | 'message-count' | 'node-budget';

export interface DomTrimDecision {
	/** 是否需要执行裁剪。 */
	readonly shouldTrim: boolean;
	/** 保留「可见区间 ± 本缓冲」条，其余卸载。 */
	readonly keepBuffer: number;
	/** 判定来源（供日志/单测区分「条数触发」与「预算触发」）。 */
	readonly reason: DomTrimReason;
}

/**
 * 判定是否需要裁剪 DOM 窗口。
 *
 * **节点预算优先于条数**：预算是「卡死前兆」，条数只是「长会话卫生」。两者同时命中时
 * 用更小的保留窗口（`nodeKeep`）—— 先保命。
 */
export function decideDomTrim(
	messageCount: number,
	nodeCount: number,
	limits: DomTrimLimits = DOM_TRIM_LIMITS,
): DomTrimDecision {
	if (nodeCount > limits.nodeBudget) {
		// 只有一条消息时无可卸载（可视窗口 = 全部）⇒ 不裁，交给密度诊断报告
		return messageCount > 1
			? { shouldTrim: true, keepBuffer: limits.nodeKeep, reason: 'node-budget' }
			: { shouldTrim: false, keepBuffer: limits.nodeKeep, reason: 'under-limits' };
	}
	if (messageCount > limits.messageLimit) {
		return { shouldTrim: true, keepBuffer: limits.messageKeep, reason: 'message-count' };
	}
	return { shouldTrim: false, keepBuffer: limits.messageKeep, reason: 'under-limits' };
}

/**
 * 裁剪后仍超预算 ⇒ 卸载消息已无法再降，**主因是单条消息的节点密度**。
 * 返回一句可落盘的说明（`null` = 正常）。
 *
 * 这是「大代码块折叠 / 懒高亮」的**立项依据**：没有它，日志里只会看到「裁剪了却还超预算」，
 * 后人无从判断该往哪个方向修。
 */
export function describeDensityOverBudget(
	nodeCount: number,
	messageCount: number,
	limits: DomTrimLimits = DOM_TRIM_LIMITS,
): string | null {
	if (nodeCount <= limits.nodeBudget) { return null; }
	const per = messageCount > 0 ? Math.round(nodeCount / messageCount) : nodeCount;
	return `[AgentChatPanel] DOM 仍超预算：nodes=${nodeCount} > budget=${limits.nodeBudget}、`
		+ `messages=${messageCount}（≈${per} 节点/条）—— 卸载消息已降不下来，`
		+ `说明主因是**单条消息的节点密度**（长代码块 / 工具卡 / 语法高亮 span）`
		+ `⇒ 下一步该做「大代码块折叠 or 懒高亮」，而不是继续缩保留条数。`;
}
