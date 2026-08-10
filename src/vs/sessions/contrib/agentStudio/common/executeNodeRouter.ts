/*---------------------------------------------------------------------------------------------
 *  executeNodeRouter — decide how a workflow node is executed, based on its type.
 *
 *  With the LiteGraph canvas, three tiers of nodes coexist on one graph:
 *   - 'sarosis' : existing Sarosis node types (start/end/task/prompt/agent/skill/tool/
 *                 ifElse/switch/askUser/group) — routed to the existing executor.
 *   - 'comfyStage' : ComfyTV-style stages (`ComfyTV.*` or node.type 'comfyStage') —
 *                 routed to the Comfy runner with stage schema + bindings.
 *   - 'comfyNative' : ComfyUI native nodes (any registered LiteGraph native type,
 *                 or node.type 'comfy' with a workflowId) — routed to the Comfy runner.
 *
 *  Pure + unit-testable; no DI, no DOM.
 *--------------------------------------------------------------------------------------------*/

import { WorkflowNodeType } from './workflowStorage.js';

export type ExecutionRoute =
	| 'sarosis'
	| 'comfyStage'
	| 'comfyNative'
	| 'unknown';

export interface RouteNodeLike {
	type: string;
	data?: { mode?: string; workflowId?: string; stageClass?: string; comfy?: { mode?: 'workflow' | 'stage' } };
}

const SAROSIS_TYPES = new Set<string>([
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
 * Classify a node's execution route.
 *  - sarosis types → 'sarosis'
 *  - `ComfyTV.*` / type 'comfyStage' → 'comfyStage'
 *  - type 'comfy' with comfy.mode === 'stage' → 'comfyStage'
 *  - type 'comfy' (workflow mode) / any other registered native → 'comfyNative'
 *  - everything else → 'unknown'
 */
export function routeNodeExecution(node: RouteNodeLike): ExecutionRoute {
	if (SAROSIS_TYPES.has(node.type)) {
		return 'sarosis';
	}
	if (node.type.startsWith('ComfyTV.') || node.type === WorkflowNodeType.ComfyStage) {
		return 'comfyStage';
	}
	if (node.type === WorkflowNodeType.Comfy) {
		const mode = node.data?.comfy?.mode ?? node.data?.mode;
		return mode === 'stage' ? 'comfyStage' : 'comfyNative';
	}
	// Native ComfyUI node types (KSampler, LoadImage, …) carry no Sarosis prefix.
	if (node.type.length > 0 && !node.type.includes('.') && node.type !== WorkflowNodeType.Group) {
		return 'comfyNative';
	}
	return 'unknown';
}

/** Human-readable label for the route (logging / status panel). */
export function routeLabel(route: ExecutionRoute): string {
	switch (route) {
		case 'sarosis': return 'Sarosis 执行器';
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
