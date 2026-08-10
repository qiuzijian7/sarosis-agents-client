/*---------------------------------------------------------------------------------------------
 *  capsLoader — load ComfyTV stage capabilities (/comfytv/caps) and populate the
 *  editor's schema-driven form fields (P3).
 *
 *  Caps payload (ComfyTV api/stages.py + src/api/schemas/caps.ts):
 *    {
 *      caps_by_kind:  { [kind]: { upstream_kinds, option_keys, computed_keys } },
 *      fallback_caps: { … },
 *      option_labels: { "option:seed": "Stage seed", … }
 *    }
 *--------------------------------------------------------------------------------------------*/

import { buildStageOptionsFromCaps, setStageOptions } from './registry.js';

export interface StageCaps {
	upstream_kinds?: string[];
	option_keys?: string[];
	computed_keys?: string[];
}

export interface CapsPayload {
	caps_by_kind?: Record<string, StageCaps>;
	fallback_caps?: StageCaps;
	option_labels?: Record<string, string>;
}

/**
 * GET /comfytv/caps and register per-kind editor options. Returns success.
 * Fails silently (returns false) when the runner has no ComfyTV extension.
 */
export async function loadComfyTVCaps(
	baseUrl: string,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const res = await fetchImpl(`${baseUrl}/comfytv/caps`, { method: 'GET', signal });
		if (!res.ok) { return false; }
		const body = (await res.json()) as CapsPayload;
		const byKind = body?.caps_by_kind;
		if (!byKind || typeof byKind !== 'object') { return false; }
		const labels = body.option_labels ?? {};
		let any = false;
		for (const [kind, caps] of Object.entries(byKind)) {
			const keys = caps?.option_keys;
			if (!Array.isArray(keys) || keys.length === 0) { continue; }
			setStageOptions(kind, buildStageOptionsFromCaps(keys, labels));
			any = true;
		}
		return any;
	} catch {
		return false;
	}
}
