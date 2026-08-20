/*---------------------------------------------------------------------------------------------
 *  nodeTypeAliases — 节点类型命名统一（P1：根治双轨制 bug）
 *
 *  历史遗留：NodePalette/store 用**小写**（'prompt'/'agent'/'ifElse'…，ReactFlow 时代
 *  的产物），而 registry/workflowRun/canvasExport 用**命名空间**（'Saros.Prompt'/
 *  'Saros.Agent'…）。两套命名互不认识，导致同一类 bug 反复出现：
 *    - canvasExport.isExportable 只认 Saros.* → 小写节点导出时静默丢失（已修）
 *    - workflowRun.isAgentNodeType 只认 Saros.* → 小写节点画布 Run 时静默跳过
 *    - collectOrchestrationValues 的 Prompt→stage 文本注入失配
 *
 *  统一为**命名空间形态**（`Saros.*`，与 registry 的 registerNodeSpec 一致）：
 *   - palette 直接产出 Saros.*（见 store.nodeCategories）
 *   - 旧持久化工作流 JSON 里的小写 type 在 loadWorkflow 入口归一化迁移
 *   - normalizeNodeType() 幂等：已是命名空间形态（Saros. / ComfyTV. / Comfy. 前缀）的原样返回
 *--------------------------------------------------------------------------------------------*/

/**
 * 旧小写类型 → 命名空间类型。仅包含**曾经**由 palette 产出的类型；
 * ComfyTV. / Comfy. 前缀的类型从来就是命名空间形态，不在此表。
 */
export const LEGACY_NODE_TYPE_MAP: Readonly<Record<string, string>> = Object.freeze({
	start: 'Saros.Start',
	end: 'Saros.End',
	prompt: 'Saros.Prompt',
	agent: 'Saros.Agent',
	skill: 'Saros.Skill',
	tool: 'Saros.Tool',
	task: 'Saros.Task',
	ifElse: 'Saros.IfElse',
	switch: 'Saros.Switch',
	askUser: 'Saros.AskUser',
	loop: 'Saros.Loop',
	parallel: 'Saros.Parallel',
	group: 'Saros.Group',
	merge: 'Saros.Merge',
	// 'condition' 是更早的 ifElse 别名（steps fallback 路径仍可能出现）
	condition: 'Saros.IfElse',
});

/**
 * 归一化节点类型为命名空间形态。幂等（已归一化的原样返回）。
 * 未知类型原样返回（ComfyTV. / Comfy. 前缀、第三方自定义都走这条）。
 */
export function normalizeNodeType(type: string | undefined): string {
	if (!type) { return ''; }
	return LEGACY_NODE_TYPE_MAP[type] ?? type;
}

/** 批量归一化节点数组的 type 字段（loadWorkflow 迁移旧数据用）。返回新数组。 */
export function normalizeNodeTypes<T extends { type?: string }>(nodes: readonly T[]): T[] {
	return nodes.map(n => {
		const normalized = normalizeNodeType(n.type);
		return normalized === n.type ? n : { ...n, type: normalized };
	});
}
