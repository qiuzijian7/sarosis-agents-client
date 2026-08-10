/*---------------------------------------------------------------------------------------------
 *  comfyObjectInfoLoader — fetch `/object_info` from a ComfyUI runner and register
 *  native nodes dynamically (so palette + canvas can drop real ComfyUI nodes).
 *
 *  ComfyUI /object_info shape:
 *    { "<ClassName>": { input: { required: { name: [type, opts?] }, optional: {...} },
 *                       output: ["LATENT"], output_name: ["LATENT"],
 *                       display_name, category, ... } }
 *  We feed each entry into `registerComfyUINativeNode` (already tested).
 *--------------------------------------------------------------------------------------------*/

import { registerComfyUINativeNode, getNodeSpec, type NodeSpec } from './registry.js';

export interface ComfyObjectInfoEntry {
	input?: {
		required?: Record<string, [string, Record<string, unknown>?]>;
		optional?: Record<string, [string, Record<string, unknown>?]>;
	};
	output?: string[];
	output_name?: string[];
	display_name?: string;
	category?: string;
}

export type ComfyObjectInfo = Record<string, ComfyObjectInfoEntry>;

export interface ObjectInfoLoadResult {
	registered: NodeSpec[];
	skipped: string[];
	error?: string;
	total: number;
}

/**
 * Register native nodes from an /object_info payload.
 * `categoryFilter` limits registration (e.g. only 'sampling' nodes) — useful for
 * keeping the palette manageable; pass a predicate or undefined for all.
 */
export function registerObjectInfoNodes(
	info: ComfyObjectInfo,
	opts?: { categoryFilter?: (category: string | undefined) => boolean },
): ObjectInfoLoadResult {
	const registered: NodeSpec[] = [];
	const skipped: string[] = [];
	let total = 0;

	for (const [className, def] of Object.entries(info)) {
		if (!def || typeof def !== 'object') { continue; }
		total++;
		if (opts?.categoryFilter && !opts.categoryFilter(def.category)) {
			skipped.push(className);
			continue;
		}
		if (registerComfyUINativeNode({
			class_name: className,
			display_name: def.display_name,
			category: def.category,
			input: def.input,
			output: def.output,
			output_name: def.output_name,
		})) {
			const spec = getNodeSpec(className);
			if (spec) { registered.push(spec); }
		} else {
			skipped.push(className);
		}
	}
	return { registered, skipped, total };
}

/**
 * Fetch + register native nodes from a runner's /object_info.
 * Graceful: any HTTP/parse error → result.error, no throw.
 */
export async function loadObjectInfoNodes(
	baseUrl: string,
	fetchImpl: typeof fetch = fetch as typeof fetch,
	opts?: { signal?: AbortSignal; categoryFilter?: (category: string | undefined) => boolean },
): Promise<ObjectInfoLoadResult> {
	const empty: ObjectInfoLoadResult = { registered: [], skipped: [], total: 0 };
	try {
		const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/object_info`, {
			method: 'GET',
			signal: opts?.signal,
		});
		if (!res.ok) {
			return { ...empty, error: `HTTP ${res.status}` };
		}
		const body = (await res.json()) as ComfyObjectInfo;
		if (!body || typeof body !== 'object') {
			return { ...empty, error: 'invalid object_info payload' };
		}
		return registerObjectInfoNodes(body, { categoryFilter: opts?.categoryFilter });
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}
