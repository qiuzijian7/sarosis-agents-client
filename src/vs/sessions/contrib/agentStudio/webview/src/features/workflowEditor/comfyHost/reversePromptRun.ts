/*---------------------------------------------------------------------------------------------
 *  Reverse Prompt Run — orchestrate a reverse-prompt on a ModelImageGen node (P2).
 *
 *  Docs: docs/Agent-画布编排设计方案.md P2 → 5.4 反推提示词.
 *
 *  Flow (called from the webview when a `__reverse_prompt__` op arrives):
 *    1. Find the target node (id or label) and the first upstream IMAGE snapshot.
 *    2. Resolve provider/model via buildReversePromptRequest.
 *    3. Call the reversePrompt.generate RPC (host streams provider.chat).
 *    4. Write the returned description back into the node's `prompt`.
 *
 *  Pure orchestration — the RPC and snapshot store are injected, so the module
 *  is unit-testable without the real host channel.
 *--------------------------------------------------------------------------------------------*/

import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { ProviderInfo } from '../../../../store/useProviderStore.js';

export interface ReversePromptRunInput {
	/** Target node id (or label). */
	target: string;
	/** Snapshot store (upstream image lookup). */
	store: MediaSnapshotStore;
	/** All canvas nodes (label resolution). */
	nodes: Array<{ id: string; data?: { label?: string } }>;
	/** All canvas edges. */
	edges: Array<{ source: string; target: string }>;
	/** Available providers for auto-routing. */
	providers: ProviderInfo[];
	/** RPC — streams the provider chat description of the image. */
	reversePrompt: (args: { providerId: string; modelId: string; imageRef: string; prompt?: string }) => Promise<{ text: string }>;
}

export interface ReversePromptRunResult {
	ok: boolean;
	error?: string;
	/** Target node id that was updated. */
	nodeId?: string;
	/** The description written to the node's prompt. */
	prompt?: string;
}

/**
 * Execute a reverse-prompt for a node: resolve upstream image, pick provider,
 * call the RPC, write the result back. Returns the new prompt.
 */
export async function runReversePrompt(input: ReversePromptRunInput): Promise<ReversePromptRunResult> {
	// 1. Resolve target node (id → label → case-insensitive).
	const target = resolveNode(input.nodes, input.target);
	if (!target) { return { ok: false, error: `找不到节点 "${input.target}"` }; }

	// 2. Find the first upstream IMAGE snapshot.
	const upstreamIds = input.edges.filter(e => e.target === target.id).map(e => e.source);
	let imageRef: string | undefined;
	for (const uid of upstreamIds) {
		const snaps = input.store.byNode(uid);
		const img = [...snaps].reverse().find(s => s.media.kind === 'image');
		if (img) { imageRef = img.media.ref; break; }
	}
	if (!imageRef) { return { ok: false, error: `节点 "${target.id}" 上游没有可用的图片快照` }; }

	// 3. Pick provider/model (explicit value > auto-route).
	const nodeData = (target as { data?: Record<string, unknown> }).data ?? {};
	const providerId = typeof nodeData.providerId === 'string' ? nodeData.providerId : undefined;
	const modelId = typeof nodeData.modelId === 'string' ? nodeData.modelId : undefined;
	const provider = providerId ? input.providers.find(p => p.id === providerId) : undefined;
	const chosen = provider ?? input.providers.find(p => p.authStatus === 'authenticated');
	if (!chosen) { return { ok: false, error: '没有可用的已认证 Provider（反推提示词需要文本模型）' }; }
	const model = modelId ? chosen.models?.find(m => m.id === modelId) : undefined;
	const chosenModel = model
		?? chosen.models?.find(m => m.supportsImages || m.supportsImageGen)
		?? chosen.models?.[0];
	if (!chosenModel) { return { ok: false, error: `Provider "${chosen.id}" 没有可用模型` }; }

	// 4. Call the RPC.
	try {
		const r = await input.reversePrompt({
			providerId: chosen.id,
			modelId: chosenModel.id,
			imageRef,
		});
		if (!r.text?.trim()) { return { ok: false, error: '模型未返回描述文本' }; }
		return { ok: true, nodeId: target.id, prompt: r.text.trim() };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Resolve a node ref (id → label → case-insensitive label). */
export function resolveNode(
	nodes: Array<{ id: string; data?: { label?: string } }>,
	ref: string,
): { id: string; data?: Record<string, unknown> } | undefined {
	const exact = nodes.find(n => n.id === ref);
	if (exact) { return exact as never; }
	const labelHit = nodes.find(n => n.data?.label === ref);
	if (labelHit) { return labelHit as never; }
	const lower = ref.toLowerCase();
	return nodes.find(n => (n.data?.label ?? '').toLowerCase() === lower) as never;
}
