/*---------------------------------------------------------------------------------------------
 *  workflowRun — run a whole workflow graph through the Comfy runners (P0).
 *
 *  Executes every executable node in topological order (upstream first) so
 *  media outputs land in the shared snapshot store before their downstream
 *  consumers run. Execution stops on the first failure (the failing card shows
 *  an error banner; the caller surfaces the reason in the toolbar).
 *
 *  Pure helper `isComfyExecutableSpec`; the async `runGraphExecution` performs
 *  IO only through injected runner / snapshot store / card store — testable
 *  with fakes.
 *--------------------------------------------------------------------------------------------*/

import type { IComfyRunner } from './comfyRunner.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { CardStateStore } from './cardState.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';
import { runSingleNode, comfyOutputsToFxSnapshots } from './nodeExecutor.js';
import { runStageWorkflow, StageWorkflowUnavailableError } from './stageWorkflowExecutor.js';
import { isFxNode, isFxChainNode } from './fxChain.js';
import type { MediaSnapshotEntry } from './mediaSnapshot.js';
import { isInstantNode } from './instantNodes.js';
import { runInstantNode } from './instantExecutor.js';
import { isRelightNode } from './relightEditor.js';
import { runRelightNode } from './relightExecutor.js';
import { isPosterNode } from './posterEditor.js';
import { runPosterNode } from './posterExecutor.js';
import { isLayerEditorNode } from './layerEditor.js';
import { runLayerEditorNode } from './layerExecutor.js';
import { isStoryboardEditorNode } from './storyboardEditor.js';
import { runStoryboardEditorNode } from './storyboardExecutor.js';
import { isMaterialNode } from './materialEditor.js';
import { runMaterialNode } from './materialExecutor.js';
import { isScene3DNode } from './scene3dEditor.js';
import { runScene3DNode } from './scene3dExecutor.js';
import { buildExecutionPlan, type ExecutionNodeLike, type ExecutionEdgeLike } from './executionGraph.js';

/** A registered ComfyTV stage's extra metadata. */
export interface ComfyTVSpecMeta {
	kind?: string;
	workflowKind?: string;
}

/** Store node with optional editor data (Prompt 节点的 text 等). */
export interface RunNode extends ExecutionNodeLike {
	data?: Record<string, unknown>;
}

/**
 * A node spec kind is executable when it maps to a Comfy class_type.
 * Sarosis orchestration nodes (kind 'react') and unregistered nodes are skipped.
 */
export function isComfyExecutableSpec(spec: { kind?: string } | undefined): boolean {
	return spec?.kind === 'schema' || spec?.kind === 'native';
}

/**
 * Collect text values from upstream orchestration nodes that a media stage can
 * consume. Currently: a Sarosis Prompt node's `data.prompt` feeds the stage's
 * prompt input — the first non-empty prompt wins. Pure.
 */
export function collectOrchestrationValues(
	nodes: RunNode[],
	upstreams: string[] | undefined,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!upstreams) { return out; }
	for (const id of upstreams) {
		const node = nodes.find(n => n.id === id);
		const data = node?.data;
		if (!node || !data) { continue; }
		if (node.type === 'prompt' && out.prompt === undefined) {
			const text = data.prompt;
			if (typeof text === 'string' && text.length > 0) { out.prompt = text; }
		}
	}
	return out;
}

export interface GraphRunOptions {
	nodes: RunNode[];
	edges: ExecutionEdgeLike[];
	/** resolve the spec for a node type (from the node registry) */
	getSpec: (type: string) => { kind?: string; comfyTV?: ComfyTVSpecMeta } | undefined;
	/** resolve the runner to use; undefined when nothing is connected */
	resolveRunner: () => IComfyRunner | undefined;
	snapshotStore: MediaSnapshotStore;
	cardState: CardStateStore;
	/** optional persisted form values per node id (double-click editor) */
	nodeValues?: Record<string, Record<string, unknown>>;
	/** called before each node starts (canvas can highlight it) */
	onNodeStart?: (step: { id: string; type: string }) => void;
	signal?: AbortSignal;
}

export interface GraphRunResult {
	success: boolean;
	/** true when the graph has a cycle → nothing ran */
	hasCycle: boolean;
	/** node ids that completed successfully */
	ran: string[];
	/** the first failing node (null when all ran) */
	failed: { nodeId: string; error: string } | null;
	/** per-node results of successful runs */
	results: Record<string, SingleNodeRunResult>;
}

/** Progress callback accepted by both runSingleNode and runStageWorkflow. */
export type RunProgress = (p: { progress?: number; value?: number }) => void;

export interface NodeExecutionInput {
	runner: IComfyRunner;
	nodeId: string;
	type: string;
	getSpec: (type: string) => { kind?: string; comfyTV?: ComfyTVSpecMeta } | undefined;
	values: Record<string, unknown>;
	/** upstream node ids — snapshots feed `upstream_*` bindings (P2) */
	upstreams?: string[];
	store: MediaSnapshotStore;
	onProgress?: RunProgress;
	signal?: AbortSignal;
}

/**
 * Collect the first available snapshot ref per media kind across upstream nodes
 * for FX-chain threading: a `video` upstream that carries an fx chain is
 * injected as its FULL packed value (`{"__fxvideo__": …}`) so the next fx stage
 * appends its spec entry; plain media falls back to the `/view` URL. Pure.
 */
export function collectUpstreamValues(
	store: MediaSnapshotStore,
	upstreams: string[] | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!upstreams) { return out; }
	for (const nodeId of upstreams) {
		for (const entry of store.byNode(nodeId)) {
			const kind = entry.media.kind;
			if (kind === 'unknown' || out[kind]) { continue; }
			out[kind] = entry.media.fxChain && kind === 'video'
				? entry.media.fxChain
				: entry.media.ref;
		}
	}
	return out;
}

/** ComfyTV no-Run picker stages: choose one candidate snapshot → emit it locally. */
export function isPickerNode(type: string): boolean {
	return type === 'ComfyTV.ImagePickerStage'
		|| type === 'ComfyTV.VideoPickerStage'
		|| type === 'ComfyTV.AudioPickerStage';
}

/** ComfyTV no-Run loader stages: emit the snapshot chosen in the node popup. */
export function isLoaderNode(type: string): boolean {
	return type === 'ComfyTV.ImageLoaderStage'
		|| type === 'ComfyTV.VideoLoaderStage'
		|| type === 'ComfyTV.AudioLoaderStage'
		|| type === 'ComfyTV.TextLoaderStage'
		|| type.startsWith('ComfyTV.Asset');
}

/** All snapshots produced by the upstream nodes (candidates for a picker). Pure. */
export function collectUpstreamCandidates(
	store: MediaSnapshotStore,
	upstreams: string[] | undefined,
): MediaSnapshotEntry[] {
	const out: MediaSnapshotEntry[] = [];
	for (const id of upstreams ?? []) { out.push(...store.byNode(id)); }
	return out;
}

/** Local picker execution: emit the candidate chosen by selected_index (1-based, ComfyTV semantics). */
async function runPickerNode(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const candidates = collectUpstreamCandidates(input.store, input.upstreams);
	if (!candidates.length) {
		return { promptId: '', status: 'error', error: '选择器没有上游候选：请先连接上游生成节点并执行', entries: [] };
	}
	const idx = Math.max(0, Math.min((Number(input.values?.selected_index) || 1) - 1, candidates.length - 1));
	const picked = candidates[idx];
	const entry: MediaSnapshotEntry = {
		nodeId: input.nodeId,
		port: 'output',
		key: `${input.nodeId}:output:0`,
		media: picked.media,
		index: 0,
	};
	input.store.put(entry);
	return { promptId: '', status: 'success', entries: [entry] };
}

/** Local loader execution: emit the snapshot the user picked in the popup. */
async function runLoaderNode(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const mine = input.store.byNode(input.nodeId).filter(e => e.media.kind !== 'unknown');
	if (!mine.length) {
		return { promptId: '', status: 'error', error: '请先在节点弹窗中选择文件', entries: [] };
	}
	return { promptId: '', status: 'success', entries: [mine[0]] };
}

/**
 * Unified node executor shared by the single-node editor popup and the
 * workflow Run: schema nodes execute as their FULL ComfyTV workflow (degrading
 * to single-node when the runner has no ComfyTV extension), everything else
 * executes as a single ComfyUI class_type. ComfyTV fx-chain stages (builders
 * + the FX Chain terminal) run as single-node prompts with the threaded
 * fx value injected on the video input and fx-aware output extraction.
 * ComfyTV pickers/loaders (P2) resolve locally without any backend call.
 */
export async function runNodeOrStage(input: NodeExecutionInput): Promise<SingleNodeRunResult> {
	const { runner, nodeId, type, getSpec, values, upstreams, store, onProgress, signal } = input;
	if (isInstantNode(type)) { return runInstantNode(input); }
	if (isRelightNode(type)) { return runRelightNode(input); }
	if (isPosterNode(type)) { return runPosterNode(input); }
	if (isLayerEditorNode(type)) { return runLayerEditorNode(input); }
	if (isStoryboardEditorNode(type)) { return runStoryboardEditorNode(input); }
	if (isMaterialNode(type)) { return runMaterialNode(input); }
	if (isScene3DNode(type)) { return runScene3DNode(input); }
	if (isPickerNode(type)) { return runPickerNode(input); }
	if (isLoaderNode(type)) { return runLoaderNode(input); }
	if (isFxNode(type)) {
		const fxValues = { ...collectUpstreamValues(store, upstreams), ...values };
		return runSingleNode({
			runner, nodeId, type, values: fxValues, store,
			// The chain terminal emits a real video snapshot (standard
			// extraction); intermediate builders emit the threaded fx value.
			extractOutputs: isFxChainNode(type) ? undefined : comfyOutputsToFxSnapshots,
			onProgress: (p) => onProgress?.({ value: p.value }),
			signal,
		});
	}
	const spec = getSpec(type);
	if (spec?.kind === 'schema') {
		return runStageWorkflow({
			runner,
			nodeId,
			type,
			kind: spec.comfyTV?.kind ?? type.replace(/^ComfyTV\./, '').replace(/Stage$/, '').toLowerCase(),
			workflowKind: spec.comfyTV?.workflowKind,
			values,
			upstreams,
			store,
			onProgress: (p) => onProgress?.({ progress: p.progress }),
			signal,
		}).catch((err: unknown): SingleNodeRunResult => {
			if (err instanceof StageWorkflowUnavailableError) {
				return runSingleNode({ runner, nodeId, type, values, store, onProgress: (p) => onProgress?.({ value: p.value }), signal });
			}
			return { promptId: '', status: 'error', error: err instanceof Error ? err.message : String(err), entries: [] };
		});
	}
	return runSingleNode({ runner, nodeId, type, values, store, onProgress: (p) => onProgress?.({ value: p.value }), signal });
}

/**
 * Execute the executable sub-graph upstream-first. Stops on the first failure.
 */
export async function runGraphExecution(options: GraphRunOptions): Promise<GraphRunResult> {
	const { nodes, edges, getSpec, resolveRunner, snapshotStore, cardState, nodeValues, onNodeStart, signal } = options;
	const result: GraphRunResult = { success: false, hasCycle: false, ran: [], failed: null, results: {} };
	const plan = buildExecutionPlan(nodes, edges, type => isComfyExecutableSpec(getSpec(type)));
	result.hasCycle = plan.hasCycle;
	if (plan.hasCycle) { return result; }
	const runner = resolveRunner();
	if (!runner) { return result; }

	for (const step of plan.steps) {
		if (signal?.aborted) { break; }
		onNodeStart?.(step);
		cardState.set(step.id, { runState: 'running', progress: 5 });
		// P2-tail: orchestration nodes are skipped, but their data flows into the
		// media node's values (e.g. Prompt 文本 → prompt). Editor values win.
		const values = { ...collectOrchestrationValues(nodes, step.upstreams), ...(nodeValues?.[step.id] ?? {}) };
		const progress = (p: { progress?: number; value?: number }) =>
			cardState.set(step.id, { runState: 'running', progress: p.progress ?? p.value ?? 50 });
		const r = await runNodeOrStage({
			runner,
			nodeId: step.id,
			type: step.type,
			getSpec,
			values,
			upstreams: step.upstreams,
			store: snapshotStore,
			onProgress: progress,
			signal,
		});
		if (r.status === 'success') {
			cardState.set(step.id, { runState: 'success', progress: 100, durationMs: r.durationMs });
			result.ran.push(step.id);
			result.results[step.id] = r;
		} else {
			cardState.set(step.id, { runState: 'error', progress: 0, errorMsg: r.error ?? '执行失败' });
			result.failed = { nodeId: step.id, error: r.error ?? '执行失败' };
			return result;
		}
	}
	result.success = true;
	return result;
}
