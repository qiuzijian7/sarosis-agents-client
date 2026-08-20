/*---------------------------------------------------------------------------------------------
 *  executeNodeRouter — decide how a workflow node is executed, based on its type.
 *
 *  With the LiteGraph canvas, three tiers of nodes coexist on one graph:
 *   - 'saros'   : existing Saros node types (start/end/task/prompt/agent/skill/tool/
 *                 ifElse/switch/askUser/group) — routed to the existing executor.
 *   - 'comfyStage' : ComfyTV-style stages (`ComfyTV.*` or node.type 'comfyStage') —
 *                 routed to the Comfy runner with stage schema + bindings.
 *   - 'comfyNative' : ComfyUI native nodes (any registered LiteGraph native type,
 *                 or node.type 'comfy' with a workflowId) — routed to the Comfy runner.
 *
 *  Pure + unit-testable; no DI, no DOM.
 *
 *  ⚠️ 现状：本模块目前**没有生产调用方**（只被单测引用）。实际分派由
 *  webview 侧 `comfyHost/nodeExecutor.ts` + `workflowRun.ts` 承担。保留它作为
 *  路由判定的规范表述；接线前请先跑本文件的单测确认判定表仍符合预期。
 *--------------------------------------------------------------------------------------------*/

import { WorkflowNodeType } from './workflowStorage.js';

export type ExecutionRoute =
	| 'saros'
	| 'comfyStage'
	| 'comfyNative'
	| 'unknown';

export interface RouteNodeLike {
	type: string;
	data?: { mode?: string; workflowId?: string; stageClass?: string; comfy?: { mode?: 'workflow' | 'stage' } };
}

const SAROS_TYPES = new Set<string>([
	WorkflowNodeType.Start,
	WorkflowNodeType.End,
	WorkflowNodeType.Task,
	WorkflowNodeType.Prompt,
	WorkflowNodeType.Agent,
	WorkflowNodeType.Skill,
	WorkflowNodeType.Tool,
	WorkflowNodeType.IfElse,
	WorkflowNodeType.Switch,
	WorkflowNodeType.AskUser,
	WorkflowNodeType.Group,
]);

/**
 * 归一化命名空间前缀：`Saros.Prompt` → `prompt`、`Saros.IfElse` → `ifElse`。
 *
 * ★ 必须有：`WorkflowNodeType` 的枚举值仍是裸小写（'prompt'/'ifElse'/…），而画布
 * 节点 type 自 P1 起统一为 `Saros.*` 全名（palette 直接产出、loadWorkflow 迁移旧数据）。
 * 不归一化则全名节点既不在 SAROS_TYPES、又因含 '.' 落不到 native 分支 → 一律
 * 判为 'unknown'（编排节点被静默跳过执行）。
 */
function stripSarosPrefix(type: string): string {
	if (!type.startsWith('Saros.')) { return type; }
	const bare = type.slice('Saros.'.length);
	return bare.charAt(0).toLowerCase() + bare.slice(1);
}

/**
 * Classify a node's execution route.
 *  - saros types（裸小写或 `Saros.*` 全名）→ 'saros'
 *  - `ComfyTV.*` / type 'comfyStage' → 'comfyStage'
 *  - type 'comfy' with comfy.mode === 'stage' → 'comfyStage'
 *  - type 'comfy' (workflow mode) / any other registered native → 'comfyNative'
 *  - everything else → 'unknown'
 */
export function routeNodeExecution(node: RouteNodeLike): ExecutionRoute {
	const bare = stripSarosPrefix(node.type);
	if (SAROS_TYPES.has(bare)) {
		return 'saros';
	}
	if (node.type.startsWith('ComfyTV.') || node.type === WorkflowNodeType.ComfyStage) {
		return 'comfyStage';
	}
	if (node.type === WorkflowNodeType.Comfy) {
		const mode = node.data?.comfy?.mode ?? node.data?.mode;
		return mode === 'stage' ? 'comfyStage' : 'comfyNative';
	}
	// Native ComfyUI node types (KSampler, LoadImage, …) carry no Saros prefix.
	if (node.type.length > 0 && !node.type.includes('.') && node.type !== WorkflowNodeType.Group) {
		return 'comfyNative';
	}
	return 'unknown';
}

/** Human-readable label for the route (logging / status panel). */
export function routeLabel(route: ExecutionRoute): string {
	switch (route) {
		case 'saros': return 'Saros 执行器';
		case 'comfyStage': return 'Comfy Runner（stage）';
		case 'comfyNative': return 'Comfy Runner（原生节点）';
		default: return '未注册（跳过）';
	}
}

/**
 * Validate that a Comfy node has the minimum config for invocation.
 * Returns a list of issues (empty = OK).
 */
export function validateComfyNodeConfig(node: RouteNodeLike): string[] {
	const issues: string[] = [];
	if (node.type === WorkflowNodeType.Comfy || node.type === WorkflowNodeType.ComfyStage) {
		const data = node.data ?? {};
		if (data.comfy?.mode === 'stage' && !(data.comfy as Record<string, unknown>).stageClass && !data.stageClass) {
			issues.push(`ComfyStage node ${node.type}: missing stageClass`);
		}
		if ((data.comfy?.mode ?? data.mode) === 'workflow' && !(data.comfy as Record<string, unknown>).workflowId && !data.workflowId) {
			issues.push(`Comfy node ${node.type}: missing workflowId`);
		}
	}
	return issues;
}
