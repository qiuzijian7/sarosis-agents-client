/*---------------------------------------------------------------------------------------------
 *  schemaLiteGraphNodes — LiteGraph node class for ComfyTV schema stages.
 *
 *  WHY: the React parameter card lives in a DOM overlay layer that renders
 *  ABOVE the LiteGraph canvas. When two nodes overlap, the canvas still draws
 *  each node's own title bar (below the overlay), while the overlay draws the
 *  parameter card on top — so a lower node's title bar shows ABOVE an upper
 *  node's card, producing the "interleaved layers" bug.
 *
 *  FIX: give schema stages a real LiteGraph class with `title_mode = NO_TITLE`
 *  so LiteGraph does NOT draw its own title bar. The React card then covers
 *  the whole node rect (including the title area) and the entire node is a
 *  single DOM layer → z-order follows draw order cleanly.
 *
 *  The class only suppresses the title bar and exposes ports; the parameter
 *  panel stays in the React card (rich interactions: run button, output
 *  preview, actions). Widgets are intentionally NOT added to the canvas node
 *  (the card renders them), so nothing is drawn twice.
 *--------------------------------------------------------------------------------------------*/

import { LiteGraph, LGraphNode } from '@comfyorg/litegraph';
import type { NodeSpec } from './registry';

const STAGE_COLOR = '#e879f9';

/** Port type → color (ComfyTV-inspired palette so users can tell image vs
 * text vs video pins apart at a glance). LiteGraph's `renderingColor` uses
 * `slot.color_off` for unconnected and `slot.color_on` for connected pins;
 * we set both so the colour stays consistent regardless of link state. */
const PORT_TYPE_COLOR: Record<string, string> = {
	// ComfyTV-style
	'COMFYTV_IMAGE': '#a855f7',  // purple
	'COMFYTV_IMAGES': '#a855f7',
	'COMFYTV_TEXT': '#3b82f6',   // blue
	'COMFYTV_VIDEO': '#10b981',  // green
	'COMFYTV_AUDIO': '#f59e0b',  // amber
	'COMFYTV_MODEL': '#ef4444',  // red
	// Generic fallbacks
	'IMAGE': '#a855f7',
	'TEXT': '#3b82f6',
	'STRING': '#3b82f6',
	'VIDEO': '#10b981',
	'AUDIO': '#f59e0b',
};

export function portTypeColor(t: string): string {
	return PORT_TYPE_COLOR[t] ?? PORT_TYPE_COLOR[String(t).toUpperCase()] ?? '#22c55e';
}

/** Build an LGraphNode subclass for a ComfyTV schema stage.
 *
 * ComfyTV-style: let LiteGraph draw the title bar and port dots/labels on the
 * canvas. Our React card only covers the content area (widgets) — NOT the
 * title bar or ports. This is the key difference from our previous approach:
 * we used to hide the title bar and suppress port drawing, then re-render
 * them in DOM. That caused persistent "two-layer UI" misalignment.
 *
 * With the canvas drawing title + ports, and the DOM card sitting INSIDE the
 * content area, everything aligns naturally at any zoom level. */
export function createSchemaNodeClass(spec: NodeSpec): typeof LGraphNode {
	class SchemaStageNode extends LGraphNode {
		// LiteGraph's `configure()` falls back to `constructor.title` when the
		// serialized node has no title, and `getTitle()` reads it too — so the
		// display name must live here, not only on the instance.
		static override title = spec.title;

		// NO override of title_mode — LiteGraph draws the title bar.
		// NO override of drawSlots — LiteGraph draws the port dots/labels.
		// NO override of getInputSlotPos/getOutputSlotPos — LiteGraph's default
		// vertical stacking aligns with the canvas-drawn ports.

		constructor() {
			super(spec.title);
			this.title = spec.title;
			this.color = spec.color ?? STAGE_COLOR;
			this.boxcolor = spec.color ?? STAGE_COLOR;
			for (const inp of spec.inputs ?? []) {
				const colour = portTypeColor(inp.type);
				this.addInput(inp.name, inp.type, { label: inp.name, color_off: colour, color_on: colour } as never);
			}
			for (const out of spec.outputs ?? []) {
				const colour = portTypeColor(out.type);
				this.addOutput(out.name, out.type, { label: out.name, color_off: colour, color_on: colour } as never);
			}
			// Give the node a minimum body so the card has room even before the
			// first layout pass.
			this.size = [Math.max(this.size?.[0] ?? 220, 230), 300];
		}

		// Older workflows persisted the node's TYPE (or a truncated fragment of
		// it) as the title, e.g. "ComfyTV.ImageStage" or "t". Restoring such a
		// value would show internal implementation detail in the title bar, so
		// we drop it and keep the spec title. A genuine user rename (any other
		// string) is preserved.
		override configure(info: Parameters<LGraphNode['configure']>[0]): void {
			super.configure(info);
			if (!isUsableNodeTitle(this.title, spec.type)) {
				this.title = spec.title;
			}
		}
	}
	return SchemaStageNode;
}

/** False for empty / type-string / single-character titles (legacy dirty data). */
export function isUsableNodeTitle(title: unknown, specType?: string): boolean {
	if (typeof title !== 'string') { return false; }
	const t = title.trim();
	if (t.length < 2) { return false; }
	if (specType && t === specType) { return false; }
	// "ComfyTV.ImageStage" / "Sarosis.ModelImageGen" style type strings.
	if (/^(?:ComfyTV|Comfy|Sarosis)\./i.test(t)) { return false; }
	return true;
}

const registered = new Set<string>();

/** Register a schema stage as a LiteGraph node class (idempotent per type). */
export function registerSchemaLiteGraphNode(spec: NodeSpec): void {
	if (registered.has(spec.type)) { return; }
	LiteGraph.registerNodeType(spec.type, createSchemaNodeClass(spec));
	registered.add(spec.type);
}

/** Reset registration (tests). */
export function unregisterSchemaLiteGraphNodes(): void {
	for (const type of registered) {
		try {
			LiteGraph.unregisterNodeType(type);
		} catch { /* not registered */ }
	}
	registered.clear();
}
