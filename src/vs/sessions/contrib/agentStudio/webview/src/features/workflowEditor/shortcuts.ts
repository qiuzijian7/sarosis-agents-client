/*---------------------------------------------------------------------------------------------
 *  shortcuts.ts — ComfyUI-style node-operation keyboard shortcuts + pure helpers.
 *
 *  The canvas relies on LiteGraph's own `processKey` for the baseline set
 *  (Ctrl+A/C/V, Delete/Backspace, Space pan, Escape) — those only fire once
 *  the <canvas> is focusable, so LiteGraphCanvas sets `canvas.tabIndex = 0`
 *  and focuses it on pointerdown.  This module adds the ComfyUI extras that
 *  litegraph does NOT provide: mute/bypass/collapse/duplicate/group/ungroup/
 *  fit-to-view/run.
 *
 *  All logic lives in pure functions so the e2e suite can verify the mapping
 *  and the mode math without a DOM.
 *--------------------------------------------------------------------------------------------*/

import { LGraphGroup, type LGraph } from '@comfyorg/litegraph';

/** Node execution modes (mirror LiteGraph.LGraphEventMode). */
export const NODE_MODE_ALWAYS = 0;
export const NODE_MODE_MUTE = 2; // LiteGraph.NEVER — ComfyUI "Mute"
export const NODE_MODE_BYPASS = 4; // LiteGraph.BYPASS — ComfyUI "Bypass"

export type ShortcutAction =
	| 'mute'
	| 'bypass'
	| 'collapse'
	| 'duplicate'
	| 'group'
	| 'ungroup'
	| 'fit'
	| 'run'
	| null;

/** Minimal shape of a KeyboardEvent needed to resolve an action. */
export interface ShortcutKeyInfo {
	ctrlKey?: boolean;
	metaKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
	key: string;
	code?: string;
}

/**
 * True when the event target is a text-entry element.  Shortcut handling
 * must never steal keystrokes from inputs/textarea/select/contentEditable.
 */
export function isEditableTarget(target: unknown): boolean {
	if (!target || typeof (target as { localName?: unknown }).localName !== 'string') {
		return false;
	}
	const el = target as HTMLElement;
	const tag = el.localName.toLowerCase();
	if (tag === 'input' || tag === 'textarea' || tag === 'select') { return true; }
	return el.isContentEditable === true;
}

/**
 * Map a keydown to the ComfyUI-style action it represents.
 * Keys handled natively by LiteGraph (Ctrl+A/C/V/Shift+V, Delete, Space,
 * Escape) deliberately resolve to null here — we must not double-handle.
 */
export function resolveShortcutAction(e: ShortcutKeyInfo): ShortcutAction {
	const mod = e.ctrlKey || e.metaKey;
	const key = (e.key ?? '').toLowerCase();
	if (mod && e.shiftKey && key === 'g') { return 'ungroup'; }
	if (mod && !e.altKey) {
		if (key === 'enter') { return 'run'; }
		if (key === 'm') { return 'mute'; }
		if (key === 'b') { return 'bypass'; }
		if (key === 'd') { return 'duplicate'; }
		if (key === 'g') { return 'group'; }
		if (key === '0') { return 'fit'; }
	}
	if (!mod && key === 'f') { return 'fit'; }
	if (!mod && e.altKey && key === 'c') { return 'collapse'; }
	return null;
}

/**
 * Toggle a node's execution mode between ALWAYS(0) and the requested mode
 * (MUTE=2 / BYPASS=4) — ComfyUI mute/bypass semantics.  Returns the number
 * of nodes updated.
 */
export function toggleModeForNodes(
	nodes: Array<{ mode?: number }>,
	targetMode: number,
): number {
	let changed = 0;
	for (const n of nodes) {
		n.mode = n.mode === targetMode ? NODE_MODE_ALWAYS : targetMode;
		changed++;
	}
	return changed;
}

/** Toggle collapse on each node (fallback to the collapsed flag). */
export function toggleCollapseForNodes(
	nodes: Array<{ collapsed?: boolean; collapse?: () => void }>,
): number {
	let changed = 0;
	for (const n of nodes) {
		if (typeof n.collapse === 'function') { n.collapse(); } else { n.collapsed = !n.collapsed; }
		changed++;
	}
	return changed;
}

/** Bounding box (graph units) of a set of nodes; null when empty. */
export function computeSelectionBounds(
	nodes: Array<{ pos: number[]; size?: number[] }>,
): { x: number; y: number; w: number; h: number } | null {
	if (!nodes.length) { return null; }
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const n of nodes) {
		const [x, y] = n.pos;
		const [w, h] = n.size ?? [100, 60];
		minX = Math.min(minX, x); minY = Math.min(minY, y);
		maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
	}
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Create a group that tightly wraps the given nodes and register it on the
 * graph.  Returns the new group (or null when there is nothing to group).
 * The group is positioned/sized by litegraph's own `resizeTo`, which already
 * accounts for the title bar height.
 */
export function createGroupForNodes(
	graph: Pick<LGraph, 'add'>,
	nodes: Array<{ pos: number[]; size?: number[] }>,
	title = 'Group',
	padding = 12,
): LGraphGroup | null {
	if (!nodes.length || !graph) { return null; }
	const group = new LGraphGroup(title);
	graph.add(group);
	// Size the group from the node bounding box. (litegraph's `resizeTo`
	// reads `boundingRect` off each item, which our plain node-shaped inputs
	// don't have — so we compute the box ourselves, mirroring resizeTo's
	// title-height compensation.)
	const b = computeSelectionBounds(nodes);
	if (!b) { return group; }
	group.pos = [b.x - padding, b.y - padding - group.titleHeight];
	group.size = [b.w + padding * 2, b.h + padding * 2 + group.titleHeight];
	return group;
}

/** Remove every group that contains at least one of the given nodes. */
export function removeGroupsContaining(
	graph: Pick<LGraph, 'remove'>,
	groups: LGraphGroup[],
	nodes: Array<{ pos: number[] }>,
): number {
	let removed = 0;
	for (const group of groups) {
		const b = group.boundingRect;
		const contains = nodes.some((n) =>
			n.pos[0] >= b[0] && n.pos[1] >= b[1] &&
			n.pos[0] <= b[0] + b[2] && n.pos[1] <= b[1] + b[3]);
		if (contains) {
			graph.remove(group);
			removed++;
		}
	}
	return removed;
}
