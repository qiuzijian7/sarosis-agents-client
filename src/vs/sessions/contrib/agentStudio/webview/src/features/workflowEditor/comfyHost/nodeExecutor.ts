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
	return {
		[PROMPT_NODE_KEY]: {
			class_type: type,
			inputs: { ...values },
		},
	};
}

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
				? { kind: m.kind, ref: comfyViewUrl(baseUrl, m.ref, String(m.meta?.subfolder ?? ''), String(m.meta?.type ?? 'output')), meta: m.meta }
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
			const ref = packed.url.startsWith('/') || packed.url.startsWith('http')
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
				? { kind: m.kind, ref: comfyViewUrl(baseUrl, m.ref, String(m.meta?.subfolder ?? ''), String(m.meta?.type ?? 'output')), meta: m.meta }
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
}

export interface SingleNodeRunOptions {
	/** runner to execute through */
	runner: IComfyRunner;
	/** logical node id (used for snapshot keys) */
	nodeId: string;
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
		const entries = extract(runner.baseUrl, nodeOutputs, nodeId);
		for (const e of entries) {
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
