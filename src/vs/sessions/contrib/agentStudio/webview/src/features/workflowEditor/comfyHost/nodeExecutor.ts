/*---------------------------------------------------------------------------------------------
 *  nodeExecutor — single-node Comfy execution from the canvas.
 *
 *  "Click a ComfyTV node → type a prompt → generate an image" loop. A pure,
 *  injectable layer that:
 *    1. builds a single-node api.json prompt (class_type + inputs),
 *    2. runs it through an IComfyRunner (/prompt + /history poll),
 *    3. normalizes /history outputs into MediaSnapshotEntry[] and stores them
 *       into a MediaSnapshotStore so node cards render thumbnails.
 *
 *  All functions are pure except `runSingleNode` which performs IO through the
 *  injected runner/store — unit-testable with fake runners.
 *--------------------------------------------------------------------------------------------*/

import type { IComfyRunner, ComfyRunResult, ComfyRunProgress } from './comfyRunner.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { MediaSnapshotEntry, MediaRef } from './mediaSnapshot.js';
import { normalizeOutputSlot, comfyViewUrl } from './mediaSnapshot.js';
import { unpackFxVideo } from './fxChain.js';
import { materializeComfyImageRefs } from './comfyImagePersist.js';
// ⚠ 见 messageClient.ts 同款注释：命名导入在 esbuild IIFE bundle 下取到的是
// CJS `module.exports`（只含前 5 个 export function）。createComfyFetch 不在其中。
// Fallback: 用 IIFE-side-effect 挂在 globalThis.__vssarosBridge 上的副本。
const _bridge = (globalThis as { __vssarosBridge?: { createComfyFetch: typeof import('../../../bridge/messageClient.js')['createComfyFetch'] } }).__vssarosBridge
	?? (() => { throw new Error('vssarosBridge not initialised — messageClient.ts side-effect not executed'); })();
const { createComfyFetch } = _bridge;

/** A single-node api.json prompt: nodeKey → { class_type, inputs }. */
export type SingleNodePrompt = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** Stable node key used in the api.json prompt (ComfyUI accepts any string id). */
export const PROMPT_NODE_KEY = '1';

/**
 * Unwrap a /history `outputs` object to the slot layer for a single-node run.
 * ComfyUI keys outputs by node id; we ask for the PROMPT_NODE_KEY, but fall back
 * to the first (only) node's outputs when the runner keyed it differently.
 * Pure.
 */
export function unwrapNodeOutputs(
	outputs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!outputs) { return undefined; }
	const direct = outputs[PROMPT_NODE_KEY];
	if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
		return direct as Record<string, unknown>;
	}
	const keys = Object.keys(outputs);
	if (keys.length === 1) {
		const v = outputs[keys[0]];
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			return v as Record<string, unknown>;
		}
	}
	return outputs;
}

/**
 * Build a single-node api.json prompt.
 * The node's own type is used as class_type; values are passed straight through
 * as inputs. Pure.
 */
export function buildNodeApiPrompt(type: string, values: Record<string, unknown>): SingleNodePrompt {
	const inputs: Record<string, unknown> = { ...values };
	// ComfyTV 自定义节点（class_type 以 ComfyTV. 开头）的 inputs 在 ComfyUI 端声明为 required，
	// 但前端控件只覆盖子集；缺失的 key 会触发 `required_input_missing`（execution.py 按 key 存在性判断）。
	// 单节点降级路径也须补 key 兜底（类型按 /object_info 的 INPUT_TYPES 定义）。
	if (type.startsWith('ComfyTV.')) {
		for (const [k, v] of Object.entries(COMFYTV_RUNTIME_INPUTS)) {
			if (!(k in inputs)) { inputs[k] = v; }
		}
	}
	return {
		[PROMPT_NODE_KEY]: {
			class_type: type,
			inputs,
		},
	};
}

/**
 * ComfyTV 自定义节点 required inputs 兜底值（类型对齐 /object_info 的 INPUT_TYPES）。
 * 这些字段由 ComfyTV 后端在运行期解析（session/project 上下文），前端无对应控件。
 * aspect_ratio/workflow 是 COMBO，兜底值必须落在 options 内（否则报 value_not_in_list）。
 */
const COMFYTV_RUNTIME_INPUTS: Record<string, unknown> = {
	// 类型严格对齐 /object_info 的 INPUT_TYPES（INT→number、COMBO→options 内值、STRING→string）。
	force_run_token: 0,            // INT，运行期 bump 使缓存失效
	project_id: '',                // STRING，由 projectStore 填充
	parent_output_id: 0,           // INT，lineage parent
	workflow: 'Local SD1.5',       // COMBO，须在 options 内
	resolution: '1K',              // COMBO options: 480P/720P/1K/1080P/1440P/2K/2160P/4K
	aspect_ratio: '1:1',           // COMBO options: 1:1/9:16/16:9/3:4/4:3/3:2/2:3/4:5/5:4/21:9
	batch_size: 1,                 // INT
	main_prompt: '',               // STRING
	selected_index: 1,             // INT
	custom_params: '{}',           // STRING（JSON）
	// 注意：texts/images 是 io.Autogrow.Input（COMFY_AUTOGROW_V3 连线槽位，min:0 可空），
	// 不能兜底——给 []/'' 会破坏类型；无上游连线时 ComfyUI 允许为空。
};

/**
 * Normalize a **single node's** ComfyUI /history outputs (already unwrapped from
 * the prompt-node key, i.e. slot-layer `{ images: [...], gifs: [...] }`) into
 * snapshot entries usable by cards. Every slot's media list is flattened;
 * image/video/audio refs are turned into `/view` URLs
 * (baseUrl + filename/subfolder/type), text stays inline.
 *
 * All outputs map onto the node's primary `output` port with ascending indices
 * so that `primarySnapshotKey(nodeId)` picks the first image.
 *
 * Pure.
 */
export function comfyOutputsToSnapshots(
	baseUrl: string,
	outputs: Record<string, unknown> | undefined,
	nodeId: string,
): MediaSnapshotEntry[] {
	if (!outputs) { return []; }
	const entries: MediaSnapshotEntry[] = [];
	let index = 0;
	for (const slotName of Object.keys(outputs)) {
		const media = normalizeOutputSlot(slotName, outputs[slotName]);
		for (const m of media) {
			const resolved: MediaRef = m.kind === 'image' || m.kind === 'video' || m.kind === 'audio'
				? {
					kind: m.kind,
					ref: comfyViewUrl(baseUrl, m.ref, String(m.meta?.subfolder ?? ''), String(m.meta?.type ?? 'output')),
					meta: m.meta,
					locator: m.locator,
					fxChain: m.fxChain,
				}
				: m;
			entries.push({
				nodeId,
				port: 'output',
				key: `${nodeId}:output:${index}`,
				media: resolved,
				index,
			});
			index++;
		}
	}
	return entries;
}

/**
 * Normalize a single node's /history outputs where the node may produce a
 * ComfyTV **fx-threaded video** (`{"__fxvideo__": {"url", "chain"}}`). The
 * packed slot becomes a video snapshot pointing at the inner URL, carrying the
 * full packed value in `media.fxChain` so downstream fx stages re-inject the
 * chain (single render at the FX Chain terminal). Non-fx slots fall through to
 * the standard normalization. Pure.
 */
export function comfyOutputsToFxSnapshots(
	baseUrl: string,
	outputs: Record<string, unknown> | undefined,
	nodeId: string,
): MediaSnapshotEntry[] {
	if (!outputs) { return []; }
	const entries: MediaSnapshotEntry[] = [];
	let index = 0;
	for (const slotName of Object.keys(outputs)) {
		const raw = outputs[slotName];
		const looksPacked = typeof raw === 'string' && raw.trim().startsWith('{');
		const packed = looksPacked ? unpackFxVideo(raw) : { url: '', entries: [] };
		if (looksPacked && packed.url) {
			// 只有以 `/` 开头的相对绝对路径才补 baseUrl 前缀；完整 http(s)/data/blob
			// URL 直接使用（否则会拼成 `http://host/http://host/…` 的损坏地址）。
			const ref = packed.url.startsWith('/')
				? `${baseUrl.replace(/\/$/, '')}/${packed.url.replace(/^\//, '')}`
				: packed.url;
			entries.push({
				nodeId,
				port: 'output',
				key: `${nodeId}:output:${index}`,
				media: { kind: 'video', ref, fxChain: raw as string },
				index,
			});
			index++;
			continue;
		}
		const media = normalizeOutputSlot(slotName, raw);
		for (const m of media) {
			const resolved: MediaRef = m.kind === 'image' || m.kind === 'video' || m.kind === 'audio'
				? {
					kind: m.kind,
					ref: comfyViewUrl(baseUrl, m.ref, String(m.meta?.subfolder ?? ''), String(m.meta?.type ?? 'output')),
					meta: m.meta,
					locator: m.locator,
					fxChain: m.fxChain,
				}
				: m;
			entries.push({ nodeId, port: 'output', key: `${nodeId}:output:${index}`, media: resolved, index });
			index++;
		}
	}
	return entries;
}

/** What a single-node run returns. */
export interface SingleNodeRunResult {
	promptId: string;
	status: ComfyRunResult['status'];
	error?: string;
	durationMs?: number;
	/** snapshot entries written to the store (empty on failure) */
	entries: MediaSnapshotEntry[];
	/**
	 * W2 端口感知路由：gate 节点（IfElse）执行后给出的分支名（'true'/'false'）。
	 * 调度器据此只激活匹配 sourceHandle 的出边；其他节点不产出该字段。
	 */
	branch?: string;
}

export interface SingleNodeRunOptions {
	/** runner to execute through */
	runner: IComfyRunner;
	/** logical node id (used for snapshot keys) */
	nodeId: string;
	/** 快照归档键（= stageUid）。缺省回退 nodeId（见 StageWorkflowRunOptions）。 */
	snapshotKey?: string;
	/** ComfyUI class_type (e.g. "ComfyTV.ImageStage" or "KSampler") */
	type: string;
	/** widget/input values (prompt, seed, …) */
	values: Record<string, unknown>;
	/** snapshot store receiving the media */
	store: MediaSnapshotStore;
	/** custom output extractor (ComfyTV fx-chain stages override the default) */
	extractOutputs?: (baseUrl: string, outputs: Record<string, unknown> | undefined, nodeId: string) => MediaSnapshotEntry[];
	onProgress?: (p: ComfyRunProgress) => void;
	signal?: AbortSignal;
}

/**
 * Execute a single node through a runner and persist media outputs.
 *
 * Errors are caught and returned in `result.error` (graceful UI); a thrown
 * /prompt error is distinguished from an execution error by the runner itself
 * (HTTP non-2xx throws, /history error status returns status:'error').
 */
export async function runSingleNode(options: SingleNodeRunOptions): Promise<SingleNodeRunResult> {
	const { runner, nodeId, type, values, store } = options;
	// 快照归档键：优先 stageUid（与 nodeCard 读侧一致），缺省 nodeId。
	const snapshotKey = options.snapshotKey ?? nodeId;
	const empty: SingleNodeRunResult = { promptId: '', status: 'error', entries: [] };
	try {
		const prompt = buildNodeApiPrompt(type, values);
		const result = await runner.invoke({
			prompt,
			onProgress: options.onProgress,
			signal: options.signal,
		});
		if (result.status !== 'success') {
			return {
				promptId: result.promptId,
				status: result.status,
				error: result.error ?? (result.status === 'canceled' ? '已取消' : 'ComfyUI 执行失败'),
				durationMs: result.durationMs,
				entries: [],
			};
		}
		// /history outputs keyed by ComfyUI node id → unwrap to the slot layer.
		const nodeOutputs = unwrapNodeOutputs(result.outputs);
		const extract = options.extractOutputs ?? comfyOutputsToSnapshots;
		const entries = extract(runner.baseUrl, nodeOutputs, snapshotKey);
		// 物化 ComfyUI /view 引用为自包含 data: URL，app 重启后仍可显示。
		const persisted = await materializeComfyImageRefs(entries, runner.baseUrl, createComfyFetch(runner.baseUrl));
		for (const e of persisted) {
			store.put(e);
		}
		return { promptId: result.promptId, status: 'success', durationMs: result.durationMs, entries };
	} catch (err) {
		return {
			...empty,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
