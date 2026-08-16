/*---------------------------------------------------------------------------------------------
 *  comfyTvLoader — load ComfyTV stage metadata from a ComfyUI runner and register
 *  schema nodes (no Vue runtime involved; the "无 Vue 桥" decision is preserved).
 *
 *  ComfyTV is a ComfyUI custom-node; its backend exposes
 *    GET /comfytv/stages → { stages: [ { node_id, kind, variant, workflow_kind } ] }
 *  We fetch that through an injected runner/fetch, map each stage to a NodeSpec via
 *  `registerComfyTVNode`, and return the registered list for the palette.
 *--------------------------------------------------------------------------------------------*/

import { registerComfyTVNode, getNodeSpec, patchComfyTVWorkflowOptions, type NodeSpec } from './registry.js';

export interface ComfyTVStageMeta {
	node_id: string;
	kind?: string;
	variant?: string;
	workflow_kind?: string;
}

export interface ComfyTVStagesResponse {
	stages?: ComfyTVStageMeta[];
}

export interface ComfyTVLoadResult {
	registered: NodeSpec[];
	skipped: string[];
	error?: string;
}

/** Map a ComfyTV stage meta into the schema accepted by registerComfyTVNode. Pure. */
export function comfyTVStageToSpec(stage: ComfyTVStageMeta): NodeSpec {
	const shortName = stage.node_id.replace(/^ComfyTV\./, '');
	return {
		type: stage.node_id,
		kind: 'schema',
		title: stage.variant && stage.variant !== 'generator' ? `${shortName} (${stage.variant})` : shortName,
		category: 'comfyTV',
		inputs: [], // ComfyTV inputs are dynamic (upstream ports); resolved at run time
		outputs: [{ name: stage.kind ?? 'image', type: comfyTVKindToPort(stage.kind) }],
		color: '#e879f9',
		comfyTV: { stageKind: stage.kind, workflowKind: stage.workflow_kind },
	};
}

/** Map a ComfyTV output kind to our PortType vocabulary. Pure. */
export function comfyTVKindToPort(kind?: string): NodeSpec['outputs'][number]['type'] {
	switch (kind) {
		case 'image': case 'image-batch': return 'IMAGE';
		case 'video': return 'VIDEO';
		case 'audio': return 'AUDIO';
		case 'text': case 'text-batch': return 'TEXT';
		default: return 'ANY';
	}
}

/**
 * Register all stages from a `/comfytv/stages` response.
 * Duplicates are reported in `skipped`. Returns what was registered.
 */
export function registerComfyTVStages(response: ComfyTVStagesResponse): ComfyTVLoadResult {
	const registered: NodeSpec[] = [];
	const skipped: string[] = [];
	for (const stage of response.stages ?? []) {
		if (!stage.node_id || typeof stage.node_id !== 'string') {
			skipped.push(`missing node_id: ${JSON.stringify(stage)}`);
			continue;
		}
		const spec = comfyTVStageToSpec(stage);
		if (registerComfyTVNode({
			type: spec.type,
			kind: stage.kind,
			workflowKind: stage.workflow_kind,
			inputs: [],
			outputs: spec.outputs.map(p => ({ name: p.name, type: p.type })),
			title: spec.title,
		})) {
			registered.push(getNodeSpec(spec.type)!);
		} else {
			skipped.push(`duplicate ${spec.type}`);
		}
	}
	return { registered, skipped };
}

/**
 * Fetch and register ComfyTV stages from a runner's base URL.
 * Errors are swallowed into `result.error` (graceful: palette simply has no ComfyTV group).
 */
export async function loadComfyTVStages(
	baseUrl: string,
	fetchImpl: typeof fetch = fetch as typeof fetch,
	opts?: { signal?: AbortSignal },
): Promise<ComfyTVLoadResult> {
	const empty: ComfyTVLoadResult = { registered: [], skipped: [] };
	try {
		const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/comfytv/stages`, {
			method: 'GET',
			signal: opts?.signal,
		});
		if (!res.ok) {
			return { ...empty, error: `HTTP ${res.status}` };
		}
		const body = (await res.json()) as ComfyTVStagesResponse;
		if (!Array.isArray(body.stages)) {
			return { ...empty, error: 'missing stages array' };
		}
		const result = registerComfyTVStages(body);
		// ComfyTV ImageStage 的 workflow COMBO options 由 /comfytv/workflows 动态生成
		//（generators.py labels_for → workflowCombo）。拉取真实 workflow 列表并 patch
		// 到已注册 spec 的 workflow 控件，使下拉可选项与 ComfyTV 一致。
		void refreshComfyTVWorkflowOptions(baseUrl, fetchImpl, opts).catch(() => undefined);
		return result;
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

export interface ComfyTVWorkflowsResponse {
	workflows?: Array<{ id?: number | string; kind?: string; label?: string; default?: boolean }>;
}

/** 拉取 /comfytv/workflows，把 label 列表 patch 进已注册 ComfyTV 节点的 workflow 控件。 */
export async function refreshComfyTVWorkflowOptions(
	baseUrl: string,
	fetchImpl: typeof fetch = fetch as typeof fetch,
	opts?: { signal?: AbortSignal },
): Promise<void> {
	try {
		const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/comfytv/workflows`, {
			method: 'GET',
			signal: opts?.signal,
		});
		if (!res.ok) { return; }
		const body = (await res.json()) as ComfyTVWorkflowsResponse;
		const labels = (body.workflows ?? [])
			.map(w => typeof w?.label === 'string' && w.label ? w.label : undefined)
			.filter((l): l is string => !!l);
		if (labels.length > 0) {
			patchComfyTVWorkflowOptions(labels);
		}
	} catch { /* 非致命：无 runner 时保持回退 options */ }
}
