/*---------------------------------------------------------------------------------------------
 *  stageWorkflowExecutor — P1: execute a ComfyTV stage as its FULL ComfyUI workflow.
 *
 *  A ComfyTV stage (e.g. ComfyTV.ImageStage) is not a plain class_type — it maps
 *  to a complete workflow saved in ComfyTV's workflow DB. Executing it properly
 *  means:
 *
 *    1. GET /comfytv/workflows?kind=…      → pick the (default) workflow label
 *    2. GET /comfytv/workflows/config?kind&label → { api_json, result, inputs(bindings), … }
 *    3. clone api_json, inject form/upstream values into the bound inputs
 *       (bindings: node_id → input_name → { from, default, cast, prefix, suffix })
 *    4. POST /prompt (runner.invoke) with the injected prompt
 *    5. read the workflow's result node output and persist it as snapshots
 *
 *  All helpers are pure except the async fetch/invoke path (injected runner).
 *  When the runner has no ComfyTV extension (plain ComfyUI) or the workflow
 *  hasn't been prepared, `runStageWorkflow` throws `StageWorkflowUnavailableError`
 *  so callers can degrade to single-node execution.
 *--------------------------------------------------------------------------------------------*/

import type { IComfyRunner } from './comfyRunner.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { MediaSnapshotEntry } from './mediaSnapshot.js';
import { comfyOutputsToSnapshots } from './nodeExecutor.js';
import type { MediaKind } from './mediaSnapshot.js';

/** One bound input inside a workflow config (ComfyTV WorkflowInputBinding). */
export interface WorkflowInputBindingSpec {
	/** stage input name that provides the value (e.g. "prompt") */
	from?: string;
	default?: unknown;
	prefix?: string;
	suffix?: string;
	required?: boolean;
	error?: string;
	cast?: string;
}

/** bindings keyed node_id → input_name → spec. */
export type WorkflowBindings = Record<string, Record<string, WorkflowInputBindingSpec>>;

export interface StageWorkflowApiJson {
	[nodeId: string]: {
		class_type: string;
		inputs: Record<string, unknown>;
	};
}

export interface StageWorkflowConfig {
	api_json: StageWorkflowApiJson;
	result?: { type?: string; node?: string };
	inputs?: WorkflowBindings;
	sizing?: unknown;
	prune_when_missing?: unknown[];
	meta?: Record<string, unknown>;
}

export interface StageWorkflowListEntry {
	id?: number | string;
	kind?: string;
	label?: string;
	default?: boolean;
	state?: string;
}

export interface StageWorkflowListResponse {
	kinds?: string[];
	workflows?: StageWorkflowListEntry[];
	recent_added?: string[];
}

/** Thrown when the runner / workflow DB cannot serve a stage workflow → degrade. */
export class StageWorkflowUnavailableError extends Error { }

/** Parsed result of a ComfyTV `upstream_<kind>[:variant][idx]` binding `from`. */
export interface UpstreamFrom {
	kind: MediaKind | 'model';
	variant: 'annotated' | 'value' | 'masked' | undefined;
	index: number | undefined;
}

const UPSTREAM_RE = /^upstream_(image|video|audio|text|model)(?::(annotated|value|masked))?(?:\[(\d+)\])?$/;

/**
 * Parse a ComfyTV upstream binding `from` (e.g. "upstream_image:annotated[0]").
 * Mirrors ComfyTV's `_UPSTREAM_PAT` in runners/_workflow_resolve.py. Pure.
 */
export function matchUpstreamFrom(from: string): UpstreamFrom | null {
	const m = UPSTREAM_RE.exec(from);
	if (!m) { return null; }
	return {
		kind: m[1] as UpstreamFrom['kind'],
		variant: (m[2] ?? undefined) as UpstreamFrom['variant'],
		index: m[3] !== undefined ? Number(m[3]) : undefined,
	};
}

/**
 * Convert a `/view?filename=…&subfolder=…&type=…` URL into ComfyUI's annotated
 * filepath `subfolder/filename [type]` — mirrors ComfyTV `_view_url_to_annotated`.
 * Pure; returns the input unchanged when it doesn't look like a /view URL.
 */
export function viewUrlToAnnotated(url: string): string {
	const qIdx = url.indexOf('?');
	if (qIdx < 0) { return url; }
	const qs = new URLSearchParams(url.slice(qIdx + 1));
	const filename = qs.get('filename');
	if (!filename) { return url; }
	const subfolder = qs.get('subfolder') ?? '';
	const type = qs.get('type') ?? 'output';
	const prefix = subfolder ? `${subfolder}/` : '';
	return `${prefix}${filename} [${type}]`;
}

/**
 * Collect the first available snapshot ref per media kind across upstream nodes.
 * Order: upstreams order, then entry index. Ref is a `/view?` URL (or text).
 */
export function collectUpstreamRefs(
	store: MediaSnapshotStore,
	upstreams: string[] | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!upstreams) { return out; }
	for (const nodeId of upstreams) {
		for (const entry of store.byNode(nodeId)) {
			const kind = entry.media.kind;
			if (kind === 'unknown' || out[kind]) { continue; }
			out[kind] = entry.media.ref;
		}
	}
	return out;
}

/**
 * Resolve a binding `from` against form values + upstream snapshot refs.
 * Supported forms (mirrors ComfyTV bindings):
 *   - upstream_<kind>[:annotated|value|masked][idx] → upstream ref (annotated variant converted)
 *   - main_prompt                          → values.prompt / values.main_prompt
 *   - option:<key>                         → values.<key>
 *   - literal:<value>                      → the literal itself
 *   - anything else                        → values.<from>
 * Pure.
 */
export function resolveBindingValue(
	from: string,
	values: Record<string, unknown>,
	upstreamValues: Record<string, string> | undefined,
): { has: boolean; value: unknown } {
	const upstream = matchUpstreamFrom(from);
	if (upstream) {
		const url = upstreamValues?.[upstream.kind];
		if (url) {
			const v = upstream.variant === 'annotated' ? viewUrlToAnnotated(url) : url;
			return { has: true, value: v };
		}
		return { has: false, value: undefined };
	}
	if (from === 'main_prompt') {
		const v = values['prompt'] ?? values['main_prompt'];
		return v !== undefined && v !== null && v !== '' ? { has: true, value: v } : { has: false, value: undefined };
	}
	if (from.startsWith('option:')) {
		const v = values[from.slice(7)];
		return v !== undefined && v !== null && v !== '' ? { has: true, value: v } : { has: false, value: undefined };
	}
	if (from.startsWith('literal:')) {
		return { has: true, value: from.slice(8) };
	}
	const v = values[from];
	return v !== undefined && v !== null && v !== '' ? { has: true, value: v } : { has: false, value: undefined };
}

/**
 * Pick the workflow label to use for a kind: prefer the default flag, else the
 * first entry. Pure.
 */
export function pickDefaultWorkflowLabel(
	resp: StageWorkflowListResponse | undefined,
	kind: string | undefined,
): string | undefined {
	const list = resp?.workflows ?? [];
	const byKind = kind ? list.filter(w => w.kind === kind) : list;
	const def = byKind.find(w => w.default);
	return def?.label ?? byKind[0]?.label;
}

/**
 * Clone api_json and inject values into the bound inputs. For each binding
 * (node_id.input_name), resolve the value via `resolveBindingValue` (form values
 * + upstream snapshot refs); fall back to the binding's `default`; apply
 * `cast`/`prefix`/`suffix`. Unbound inputs are left untouched. Pure.
 */
export function injectWorkflowValues(
	apiJson: StageWorkflowApiJson,
	bindings: WorkflowBindings | undefined,
	values: Record<string, unknown>,
	upstreamValues?: Record<string, string>,
): { prompt: StageWorkflowApiJson; applied: number } {
	const prompt: StageWorkflowApiJson = {};
	let applied = 0;
	for (const [nodeId, node] of Object.entries(apiJson)) {
		const inputs = { ...(node.inputs ?? {}) };
		const nodeBindings = bindings?.[nodeId];
		if (nodeBindings) {
			for (const [inputName, spec] of Object.entries(nodeBindings)) {
				const key = spec.from ?? inputName;
				const resolved = resolveBindingValue(key, values, upstreamValues);
				let raw: unknown;
				if (resolved.has) {
					raw = resolved.value;
				} else if (spec.default !== undefined) {
					raw = spec.default;
				} else {
					continue;
				}
				let v: unknown = raw;
				switch (spec.cast) {
					case 'int': v = Math.round(Number(raw)); break;
					case 'float': v = Number(raw); break;
					case 'string': v = String(raw); break;
					case 'boolean': v = raw === true || raw === 'true' || raw === 1 || raw === '1'; break;
				}
				if (spec.prefix || spec.suffix) {
					v = `${spec.prefix ?? ''}${v}${spec.suffix ?? ''}`;
				}
				inputs[inputName] = v;
				applied++;
			}
		}
		prompt[nodeId] = { ...node, inputs };
	}
	return { prompt, applied };
}

async function fetchJson(
	runner: IComfyRunner,
	path: string,
	signal?: AbortSignal,
): Promise<unknown | undefined> {
	// Any network / HTTP failure means the ComfyTV extension is unavailable —
	// callers degrade to single-node execution (StageWorkflowUnavailableError).
	try {
		const res = await runner.fetchApi?.(path, { method: 'GET', signal });
		if (!res?.ok) { return undefined; }
		return await res.json();
	} catch {
		return undefined;
	}
}

/** GET /comfytv/workflows?kind=… via the runner's ComfyTV extension. */
export async function fetchStageWorkflowList(
	runner: IComfyRunner,
	kind: string | undefined,
	opts?: { signal?: AbortSignal },
): Promise<StageWorkflowListResponse | undefined> {
	const q = kind ? `?kind=${encodeURIComponent(kind)}` : '';
	const body = await fetchJson(runner, `/comfytv/workflows${q}`, opts?.signal);
	return Array.isArray((body as StageWorkflowListResponse | undefined)?.workflows) ? body as StageWorkflowListResponse : undefined;
}

/** GET /comfytv/workflows/config?kind&label via the runner's ComfyTV extension. */
export async function fetchStageWorkflowConfig(
	runner: IComfyRunner,
	kind: string,
	label: string,
	opts?: { signal?: AbortSignal },
): Promise<StageWorkflowConfig | undefined> {
	const body = await fetchJson(runner, `/comfytv/workflows/config?kind=${encodeURIComponent(kind)}&label=${encodeURIComponent(label)}`, opts?.signal);
	const cfg = body as StageWorkflowConfig | undefined;
	return cfg && typeof cfg?.api_json === 'object' ? cfg : undefined;
}

/** Normalize the result node's /history output into slot-layer outputs. Pure. */
export function extractResultOutputs(
	outputs: Record<string, unknown>,
	resultNode: string | undefined,
): Record<string, unknown> | undefined {
	if (resultNode && outputs[resultNode] && typeof outputs[resultNode] === 'object') {
		return outputs[resultNode] as Record<string, unknown>;
	}
	// fallback: single node, or anything under the prompt node key
	const direct = outputs['1'];
	if (direct && typeof direct === 'object') { return direct as Record<string, unknown>; }
	const keys = Object.keys(outputs);
	if (keys.length === 1) {
		const v = outputs[keys[0]];
		if (v && typeof v === 'object') { return v as Record<string, unknown>; }
	}
	return outputs;
}

export interface StageWorkflowRunOptions {
	runner: IComfyRunner;
	/** logical node id (snapshot keys) */
	nodeId: string;
	/** stage class type (e.g. "ComfyTV.ImageStage") */
	type: string;
	/** stage kind (e.g. "image") — used for workflow lookup */
	kind: string;
	/** workflow kind override (spec.comfyTV.workflowKind) */
	workflowKind?: string;
	/** form/editor values (prompt, seed, …) */
	values: Record<string, unknown>;
	/** upstream node ids (P2: their snapshots feed `upstream_*` bindings) */
	upstreams?: string[];
	store: MediaSnapshotStore;
	onProgress?: (p: { progress?: number }) => void;
	signal?: AbortSignal;
}

export interface StageWorkflowRunResult {
	promptId: string;
	status: 'success' | 'error' | 'canceled';
	error?: string;
	durationMs?: number;
	entries: MediaSnapshotEntry[];
}

/**
 * Run a stage as its full workflow. Throws StageWorkflowUnavailableError when
 * the runner has no ComfyTV extension or the workflow can't be resolved —
 * callers should then degrade to single-node execution.
 */
export async function runStageWorkflow(options: StageWorkflowRunOptions): Promise<StageWorkflowRunResult> {
	const { runner, nodeId, type, kind, workflowKind, values, upstreams, store, onProgress, signal } = options;
	if (!runner.fetchApi) {
		throw new StageWorkflowUnavailableError('runner 不支持 ComfyTV workflow 扩展');
	}
	const wfKind = workflowKind || kind;
	const list = await fetchStageWorkflowList(runner, wfKind, { signal });
	const label = pickDefaultWorkflowLabel(list, wfKind);
	if (!label) {
		throw new StageWorkflowUnavailableError(`kind ${wfKind} 没有可用 workflow`);
	}
	const cfg = await fetchStageWorkflowConfig(runner, wfKind, label, { signal });
	if (!cfg) {
		throw new StageWorkflowUnavailableError(`workflow ${wfKind}/${label} 未准备（需在 ComfyTV 中打开过一次）`);
	}
	// P2: inject upstream snapshots (first ref per media kind) so chained
	// stages consume their predecessor's output.
	const upstreamValues = collectUpstreamRefs(store, upstreams);
	const { prompt } = injectWorkflowValues(cfg.api_json, cfg.inputs, values, upstreamValues);
	const started = Date.now();
	const run = await runner.invoke({
		prompt,
		onProgress: (p) => onProgress?.({ progress: p.value }),
		signal,
	});
	const durationMs = run.durationMs ?? Date.now() - started;
	if (run.status !== 'success') {
		return {
			promptId: run.promptId,
			status: run.status,
			error: run.error ?? (run.status === 'canceled' ? '已取消' : 'workflow 执行失败'),
			durationMs,
			entries: [],
		};
	}
	// The result node's /history output is already slot-layer (e.g. { images: [...] }).
	const resultNode = cfg.result?.node;
	const slotOutputs = extractResultOutputs(run.outputs ?? {}, resultNode);
	const entries: MediaSnapshotEntry[] = slotOutputs
		? comfyOutputsToSnapshots(runner.baseUrl, slotOutputs, nodeId)
		: [];
	for (const e of entries) { store.put(e); }
	return { promptId: run.promptId, status: 'success', durationMs, entries };
}
