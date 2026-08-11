/*---------------------------------------------------------------------------------------------
 *  Node Mentions — "@[node:label]" reference syntax in prompts (P2).
 *
 *  Docs: docs/Agent-画布编排设计方案.md P2 → 5.3 Prompt 引用语法.
 *  Aligned with infinite-canvas Composer: prompts can reference upstream node
 *  outputs by label, e.g.:
 *    "把这张图改成夜晚风格 @[node:参考图]"
 *  The referenced node's latest text/image snapshot is injected:
 *    - TEXT  → appended to the prompt text (injected[]),
 *    - IMAGE → collected for img2img / reference-image slots (images[]).
 *
 *  Pure + DOM-free. The caller (runNodeOrStage / buildGenerateFlow) resolves the
 *  store to snapshots; this module only needs a `lookup(nodeId)` accessor.
 *--------------------------------------------------------------------------------------------*/

import type { MediaSnapshotStore } from './mediaSnapshotStore.js';

export interface NodeMentionsOptions {
	/** Resolve a node's id → its latest media snapshots. Defaults to store.byNode. */
	lookup?: (nodeId: string) => Array<{ port: string; media: { kind: string; ref: string } }>;
}

export interface NodeMentionsResult {
	/** Prompt text with all mentions replaced by the referenced text (or removed when not text). */
	text: string;
	/** Referenced node labels (for diagnostics / attribution). */
	referenced: string[];
	/** Text snippets injected (in mention order). */
	injected: string[];
	/** Image refs collected (for img2img / reference-image slots). */
	images: string[];
	/** Mention tokens that could not be resolved (left in place). */
	unresolved: string[];
}

/** Matches "@[node:LABEL]" where LABEL is any non-] text. */
export const NODE_MENTION_RE = /@\[node:([^\]]+)\]/g;

/**
 * Resolve every "@[node:label]" mention in `text`.
 *
 * For each mention:
 *   - resolve the label against the nodes (via the provided `nodes` list +
 *     the standard resolveNodeRef label match),
 *   - look up the node's latest snapshot: kind 'text' → inject the ref text;
 *     kind 'image' → push the ref into `images` and drop the token;
 *     otherwise (unresolved) → leave the token untouched.
 *
 * The `nodes` param is the store-shaped node list (label lookup);
 * `lookup` resolves a nodeId → snapshots (defaults to a MediaSnapshotStore).
 */
export function resolveNodeMentions(
	text: string,
	nodes: Array<{ id: string; type?: string; data?: { label?: string } }>,
	options: NodeMentionsOptions = {},
): NodeMentionsResult {
	const lookup = options.lookup;
	const result: NodeMentionsResult = { text, referenced: [], injected: [], images: [], unresolved: [] };

	if (!text || !text.includes('@[')) { return result; }

	const out: string[] = [];
	let lastIndex = 0;
	let m: RegExpExecArray | null;

	const re = new RegExp(NODE_MENTION_RE);
	while ((m = re.exec(text)) !== null) {
		const [token, label] = m;
		const node = resolveMentionNode(nodes, label);
		const replaced = resolveOneMention(node, token, label, lookup, result);
		// Replace only when resolved; otherwise keep the original token.
		out.push(text.slice(lastIndex, m.index));
		out.push(replaced ?? token);
		lastIndex = m.index + token.length;
		if (re.lastIndex === m.index) { re.lastIndex++; } // guard zero-length
	}
	out.push(text.slice(lastIndex));
	result.text = out.join('');

	return result;
}

function resolveMentionNode(
	nodes: Array<{ id: string; type?: string; data?: { label?: string } }>,
	label: string,
): { id: string; label?: string } | undefined {
	const exact = nodes.find(n => n.id === label);
	if (exact) { return { id: exact.id, label: exact.data?.label ?? exact.id }; }
	const byLabel = nodes.find(n => n.data?.label === label);
	if (byLabel) { return { id: byLabel.id, label: byLabel.data?.label }; }
	const lower = label.toLowerCase();
	const ci = nodes.find(n => (n.data?.label ?? '').toLowerCase() === lower);
	return ci ? { id: ci.id, label: ci.data?.label } : undefined;
}

/** Resolve a single mention. Returns the replacement text or null when unresolved. */
function resolveOneMention(
	node: { id: string; label?: string } | undefined,
	token: string,
	label: string,
	lookup: NodeMentionsOptions['lookup'],
	result: NodeMentionsResult,
): string | null {
	if (!node) {
		result.unresolved.push(label);
		return null;
	}
	const snapshots = lookup?.(node.id) ?? [];
	// Latest text snapshot wins (last entry on the port).
	const textSnap = [...snapshots].reverse().find(s => s.media.kind === 'text');
	const imgSnap = [...snapshots].reverse().find(s => s.media.kind === 'image');

	if (textSnap) {
		result.referenced.push(node.label ?? node.id);
		result.injected.push(String(textSnap.media.ref));
		// Prefer the raw payload text over the ref key when the backend returns text.
		return textSnap.media.ref;
	}
	if (imgSnap) {
		result.referenced.push(node.label ?? node.id);
		result.images.push(imgSnap.media.ref);
		// Image references are handled by the caller (img2img slot) — drop the token.
		return '';
	}
	result.unresolved.push(label);
	return null;
}

/**
 * Convenience: resolve mentions against a MediaSnapshotStore instance.
 */
export function createStoreLookup(store: MediaSnapshotStore): (nodeId: string) => Array<{ port: string; media: { kind: string; ref: string } }> {
	return (nodeId) => store.byNode(nodeId).map(e => ({ port: e.port, media: e.media }));
}
