/*---------------------------------------------------------------------------------------------
 *  writeStepIds — 画布节点的「写能力」解析（P0①）。
 *
 *  用途：给 `buildParallelExecutionPlan` 的 `isWriteStep` 提供信号，使**同层内至多一个
 *  可写节点**（写者不占并发槽空等）。正确性由调度层写互斥锁兜底（见 common/writeExclusion.ts），
 *  本模块只做「计划层预防」。
 *
 *  为什么信号来自 host：webview **不 import `common/`**（写工具名单 `DESTRUCTIVE_TOOL_PATTERNS`
 *  在 common 侧），故由 host 在 `agents.list` / `tools.list` 响应里附上 `writeCapable`
 *  布尔值（见 browser/agentStudioWebviewController.ts 的两个 handler）。
 *
 *  ★ 缺信号时**不判为写**（返回 undefined → 不加入集合）：计划层缺信号时保守方向取反
 *    ——若缺信号就判写，会把所有 `Saros.Agent` 节点串行化，直接回归并行探索这个主用法。
 *    此时仍由调度层写锁保证不并发写（正确性不受影响），只是少了「不占槽」这个优化。
 *--------------------------------------------------------------------------------------------*/

import { isAgentNodeType, isToolNodeType } from './workflowRunShared.js';

/** 节点最小结构（store 节点即可直接传入）。 */
export interface WriteStepNodeLike {
	readonly id: string;
	readonly type?: string;
	readonly data?: Record<string, unknown> | undefined;
}

/** 能力查询（缺省/未知 → 返回 undefined，按「不判写」处理）。 */
export interface IWriteStepLookups {
	/** agentId → 该 agent 是否可写（host `agents.list` 的 `writeCapable`）。 */
	readonly agentWriteCapable: (agentId: string) => boolean | undefined;
	/** toolName → 该工具是否写类（host `tools.list` 的 `writeCapable`）。 */
	readonly toolWriteCapable: (toolName: string) => boolean | undefined;
}

/**
 * 收集「可写节点」id 集合。
 *
 * 覆盖两类节点（这两类是画布并行写冲突的实际来源）：
 *   - `Saros.Agent`（`data.agentId` → agent 工具面含写工具）
 *   - `Saros.Tool`（`data.toolName` → 写类工具）
 * `Saros.Skill` / `Saros.Task` 无能力信号 → 不判写（由调度层写锁兜底）。
 * Pure + DOM-free。
 */
export function collectWriteStepIds(
	nodes: readonly WriteStepNodeLike[],
	lookups: IWriteStepLookups,
): Set<string> {
	const out = new Set<string>();
	for (const node of nodes) {
		const type = node.type ?? '';
		const data = node.data ?? {};
		if (isAgentNodeType(type)) {
			const agentId = typeof data.agentId === 'string' ? data.agentId : '';
			if (agentId && lookups.agentWriteCapable(agentId) === true) { out.add(node.id); }
			continue;
		}
		if (isToolNodeType(type)) {
			const toolName = typeof data.toolName === 'string' ? data.toolName : '';
			if (toolName && lookups.toolWriteCapable(toolName) === true) { out.add(node.id); }
		}
	}
	return out;
}
