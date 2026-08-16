/*---------------------------------------------------------------------------------------------
 *  comfyTVLiteGraphNodes — real LiteGraph node classes for ComfyTV schema stages.
 *
 *  Renders the stage parameter panel (prompt / workflow / seed / width / …) as
 *  native LiteGraph widgets drawn on the canvas. Because the panel is part of
 *  the node itself, it follows the node's draw order (graph._nodes array) —
 *  overlapping nodes then stack correctly (unlike the previous DOM-overlay
 *  cards which lived on a separate layer and interleaved with canvas node UI).
 *
 *  Widget values are mirrored into `this.properties` (the same persistence
 *  channel as the store via toLiteGraph / fromLiteGraph). onConfigure re-
 *  hydrates widget values from incoming properties so loading a workflow
 *  shows its saved parameters.
 *--------------------------------------------------------------------------------------------*/

import { LiteGraph, LGraphNode } from '@comfyorg/litegraph';
import type { NodeSpec } from './registry';

const STAGE_COLOR = '#e879f9';

/**
 * Build an LGraphNode subclass for a ComfyTV schema stage. Widgets are created
 * once in the constructor from the spec's widget definitions; onConfigure syncs
 * their values from the serialized properties.
 */
export function createComfyTVNodeClass(spec: NodeSpec): typeof LGraphNode {
	return class ComfyTVStageNode extends LGraphNode {
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
			this._initWidgets();
		}

		/** Create stage parameter widgets once. */
		private _initWidgets(): void {
			for (const w of spec.widgets ?? []) {
				const current = (this.properties?.[w.name] as unknown) ?? w.default;
				// Persist widget edits back into properties AND notify the graph
				// so the store (graph.on_change → syncGraphToStore) picks them up.
				const commit = (v: unknown) => {
					this.properties[w.name] = v;
					this.graph?.change?.();
				};
				if (w.type === 'COMBO') {
					this.addWidget('combo', w.name, String(current ?? ''), (v: string) => commit(v), {
						values: w.options ?? [],
					});
				} else if (w.type === 'INT') {
					this.addWidget('number', w.name, Number(current ?? 0), (v: number) => commit(Math.round(v)), {
						min: w.min ?? 0, max: w.max ?? 9999, step: (w.step ?? 1) * 10,
					});
				} else if (w.type === 'FLOAT') {
					this.addWidget('number', w.name, Number(current ?? 0), (v: number) => commit(v), {
						min: w.min ?? 0, max: w.max ?? 1, step: (w.step ?? 0.01) * 10,
					});
				} else if (w.type === 'BOOLEAN') {
					this.addWidget('toggle', w.name, Boolean(current), (v: boolean) => commit(v));
				} else if (w.type === 'TEXT') {
					const widget = this.addWidget('text', w.name, String(current ?? ''), (v: string) => commit(v));
					// Multiline prompt box (ComfyTV's MainPromptInput equivalent).
					if (w.name === 'prompt') {
						widget.options = { ...(widget.options ?? {}), multiline: true };
					}
				}
			}
		}

		override onConfigure(config: Record<string, unknown>): void {
			super.onConfigure?.(config);
			// Re-hydrate widget values from incoming properties (workflow load).
			const props = this.properties ?? {};
			for (const widget of this.widgets ?? []) {
				const name = (widget as { name?: string }).name;
				if (name && name in props) {
					(widget as { value: unknown }).value = props[name];
				}
			}
		}
	};
}

const registered = new Set<string>();

/**
 * Register a ComfyTV schema stage as a LiteGraph node class (idempotent per type).
 * Called alongside registerComfyTVNode / registerDefaultComfyTVStages so the
 * stage renders its parameter panel natively on the canvas.
 */
export function registerComfyTVLiteGraphNode(spec: NodeSpec): void {
	if (registered.has(spec.type)) { return; }
	LiteGraph.registerNodeType(spec.type, createComfyTVNodeClass(spec));
	registered.add(spec.type);
}

/** Reset registration (tests). */
export function unregisterComfyTVLiteGraphNodes(): void {
	for (const type of registered) {
		try {
			LiteGraph.unregisterNodeType(type);
		} catch { /* not registered */ }
	}
	registered.clear();
}
