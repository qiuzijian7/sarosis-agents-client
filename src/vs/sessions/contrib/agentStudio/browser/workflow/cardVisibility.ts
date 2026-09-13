/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 聊天卡「节点是否出现」的**唯一规则表**（2026-09-13 质量评估 P2-6）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  背景：这条规则此前**分散**在 `workflowExecutionService` 的 5 处调用点，
 *  每处各写一遍 `node.type !== Agent && !== Start && !== AskUser [&& _nodeOnFlowChain(…)]`
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  由此产生两个实际问题（本次一并收敛）：
 *    · **新增节点类型时「它该不该出现在聊天卡」没有单点可查** —— 只能翻遍调用点；
 *    · **各处已出现漂移** —— catch 分支曾漏掉 FLOW 筛选，导致数据辅助节点失败时
 *      发出一个没有对应卡片的 `subagent_end`，被 controller **静默丢弃**
 *      （2026-09-13 已修，见 P2-3）。
 *
 *  现集中为两个纯函数（无 vscode 依赖 → 可单测、可复用，与 `flowChain.ts` 同风格）：
 *    · `isCardEligibleNodeType(type)`  —— **类型维度**（含专属展示通道的排除）
 *    · `isNodeVisibleOnCard(conns, node)` —— **类型 + FLOW 链**（常规调用点用这个）
 *
 *  ⚠ 渲染侧的另两道过滤**不在本模块**（它们作用于「已出卡的节点内部」而非「是否出卡」）：
 *    · `__workflow__` 合成根卡（`agentChatPanel.workflowCards.ts` 的 `continue`）；
 *    · 媒体 port 过滤（同上：`output` → `matte` → 其余，且始终排除 `port:'video'`）。
 */

import { isNodeOnFlowChain, type IFlowConnectionLike } from './flowChain.js';

/**
 * **不出现在聊天卡**的节点类型 —— 每个都有专属展示通道，出卡会造成重复/噪音。
 *
 * ⚠ 用**字面量**而非 `WorkflowNodeType` 枚举 import，原因有两条：
 *   ① 该枚举定义在 `common/workflowStorage.ts`，是 **`const enum`** —— esbuild
 *      （测试 runner 用它）无法跨文件在运行时引用，import 会直接报
 *      「No matching export」✗；
 *   ② 本模块要保持「零依赖纯函数」（可单测、可被任意层复用），与 `flowChain.ts`
 *      的 `IFlowConnectionLike` 同策略。
 *   取值与 `WorkflowNodeType` 的一致性由 `test/browser/cardVisibility.test.ts` 的
 *   字面量断言锁定（改枚举取值时该测试会提醒你同步这里）。
 */
export const CARD_EXCLUDED_NODE_TYPES: ReadonlySet<string> = new Set([
	/** Agent：`_executeAgentNode` 发带 task/输出的**更丰富**版本 → 避免双卡。 */
	'agent',
	/** Start：由 root `__workflow__` 容器卡代表整个执行。 */
	'start',
	/** AskUser：专属**交互卡**（选项 / 表单 / 自定义输入），不占节点行。 */
	'askUser',
]);

/** 该节点类型是否**可以**出现在聊天卡（仅类型维度；FLOW 链见下）。 */
export function isCardEligibleNodeType(type: string | undefined): boolean {
	return !!type && !CARD_EXCLUDED_NODE_TYPES.has(type);
}

/**
 * 节点是否应出现在聊天卡的**阶段列表**里（类型 + FLOW 链两个维度）。
 *
 * FLOW 链规则（2026-09-10 用户规则，见 `flowChain.ts` 头注释）：只有 `flowOut→flowIn`
 * 控制连线上的节点才展示为「阶段」；数据连线的辅助节点（loader / picker 等）不占阶段位
 * —— 执行不受影响，只是不进卡片列表。
 *
 * 用**结构类型**而非 `WorkflowGraphNode`：避免跨层类型依赖，调用方传 `{ id, type }` 即可。
 */
export function isNodeVisibleOnCard(
	connections: readonly IFlowConnectionLike[] | undefined,
	node: { id: string; type?: string },
): boolean {
	if (!isCardEligibleNodeType(node.type)) { return false; }
	return isNodeOnFlowChain(connections, node.id);
}

/**
 * 聊天卡文本字段的**长度上限**（2026-09-13 P2-5 收敛）。
 *
 * 背景：这些上限此前是散落在各发射点的**裸字面量**（200 / 400 / 2000 / 4000）——
 * 「为什么是 400」「改了会不会撑爆卡片」无从判断，也容易在新增节点类型时随手写新值 ✗。
 *
 * ⚠ 与「节点类型」无关，**按语义分档**（值保持不变，仅提取为具名常量）：
 *   · `subtitle`  —— 一行副标题，超出必然被 CSS 截断；
 *   · `nodeOutput` —— 业务节点的 output **大多是引用文本**（媒体节点是 data URL/ref），
 *     400 字符只用于让用户辨认「产出了什么」；
 *   · `agentOutput` —— Agent 输出是**有价值的自然语言**，给更多余量；
 *   · `orchestrationOutput` —— 编排链的任务输出（`taskOrchestrationService`）。
 */
export const CARD_TEXT_LIMITS = Object.freeze({
	/** 节点副标题（`subagent_start.task`）—— Agent 的 prompt 摘要。 */
	subtitle: 200,
	/** 节点输出摘要（`subagent_end.output`）—— 媒体节点的 output 是引用文本，无需全文。 */
	nodeOutput: 400,
	/** Agent 节点输出 —— 自然语言内容，给更多余量。 */
	agentOutput: 4000,
	/** 编排链 / 看板任务输出（`taskOrchestrationService`）。 */
	orchestrationOutput: 2000,
});
