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

import { LiteGraph, LGraphNode, TitleMode } from '@comfyorg/litegraph';
import type { NodeSpec } from './registry';

const STAGE_COLOR = '#e879f9';

/** Build an LGraphNode subclass for a ComfyTV schema stage (no canvas title). */
export function createSchemaNodeClass(spec: NodeSpec): typeof LGraphNode {
	class SchemaStageNode extends LGraphNode {
		// Hide LiteGraph's own title bar so the overlay card owns the whole
		// node header — this is what keeps the layer ordering correct.
		static override title_mode = TitleMode.NO_TITLE;

		constructor() {
			super(spec.title);
			this.color = spec.color ?? STAGE_COLOR;
			this.boxcolor = spec.color ?? STAGE_COLOR;
			for (const inp of spec.inputs ?? []) {
				this.addInput(inp.name, inp.type, { label: inp.name } as never);
			}
			for (const out of spec.outputs ?? []) {
				this.addOutput(out.name, out.type, { label: out.name } as never);
			}
			// Give the node a minimum body so the card has room even before the
			// first layout pass.
			this.size = [Math.max(this.size?.[0] ?? 220, 230), 300];
		}
	}
	return SchemaStageNode;
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
