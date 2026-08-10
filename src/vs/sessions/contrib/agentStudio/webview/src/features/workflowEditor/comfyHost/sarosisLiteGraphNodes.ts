/*---------------------------------------------------------------------------------------------
 *  sarosisLiteGraphNodes — real LiteGraph node classes for Sarosis custom node types.
 *
 *  Previously, Sarosis nodes (start/end/task/prompt/agent/skill/tool/ifElse/switch/
 *  askUser/group) were filtered out of the LiteGraph canvas because the engine had
 *  no node class for them and would render a giant empty rectangle. Here we register
 *  a real LGraphNode subclass per type so the engine can draw them natively:
 *   - title from node label/properties
 *   - input/output ports typed by our PortType vocabulary
 *   - per-type parameter widgets (prompt → prompt text, agent → agentId/model, …)
 *
 *  Widget values are mirrored into `this.properties`, which is the persistence
 *  channel shared with the store (toLiteGraph writes data → properties;
 *  fromLiteGraph reads properties → data). `onConfigure` re-hydrates widget
 *  values from the incoming properties so loading a workflow shows the params.
 *
 *  Registration is idempotent and mirrors `registerSarosisNodes()` in registry.ts.
 *--------------------------------------------------------------------------------------------*/

import { LiteGraph, LGraphNode } from '@comfyorg/litegraph';

export interface SarosisNodeConfig {
	type: string;
	title: string;
	color?: string;
	inputs?: Array<{ name: string; type: string }>;
	outputs?: Array<{ name: string; type: string }>;
	widgets?: Array<{ type: 'text' | 'button' | 'toggle'; name: string; value: unknown; multiline?: boolean }>;
}

const NODE_CONFIGS: SarosisNodeConfig[] = [
	{ type: 'Sarosis.Start', title: '开始', color: '#22c55e', outputs: [{ name: 'value', type: 'SAROSIS_JSON' }] },
	{ type: 'Sarosis.End', title: '结束', color: '#ef4444', inputs: [{ name: 'value', type: 'SAROSIS_JSON' }] },
	{ type: 'Sarosis.Task', title: '任务', color: '#3b82f6', inputs: [{ name: 'value', type: 'SAROSIS_JSON' }], outputs: [{ name: 'value', type: 'SAROSIS_JSON' }], widgets: [{ type: 'text', name: 'taskId', value: '' }] },
	{ type: 'Sarosis.Prompt', title: '提示', color: '#8b5cf6', inputs: [{ name: 'value', type: 'SAROSIS_JSON' }], outputs: [{ name: 'output', type: 'TEXT' }], widgets: [{ type: 'text', name: 'prompt', value: '', multiline: true }] },
	{ type: 'Sarosis.Agent', title: 'Agent', color: '#f97316', inputs: [{ name: 'value', type: 'SAROSIS_JSON' }], outputs: [{ name: 'value', type: 'SAROSIS_JSON' }], widgets: [{ type: 'text', name: 'agentId', value: '' }] },
	{ type: 'Sarosis.Skill', title: 'Skill', color: '#eab308', inputs: [{ name: 'value', type: 'SAROSIS_JSON' }], outputs: [{ name: 'value', type: 'SAROSIS_JSON' }], widgets: [{ type: 'text', name: 'skillName', value: '' }] },
	{ type: 'Sarosis.Tool', title: 'Tool', color: '#10b981', inputs: [{ name: 'value', type: 'SAROSIS_JSON' }], outputs: [{ name: 'value', type: 'SAROSIS_JSON' }], widgets: [{ type: 'text', name: 'toolName', value: '' }] },
	{ type: 'Sarosis.IfElse', title: 'If/Else', color: '#ef4444', inputs: [{ name: 'value', type: 'SAROSIS_JSON' }], outputs: [{ name: 'true', type: 'SAROSIS_JSON' }, { name: 'false', type: 'SAROSIS_JSON' }], widgets: [{ type: 'text', name: 'evaluationTarget', value: '' }] },
	{ type: 'Sarosis.Switch', title: 'Switch', color: '#a855f7', inputs: [{ name: 'value', type: 'SAROSIS_JSON' }], outputs: [{ name: 'case', type: 'SAROSIS_JSON' }], widgets: [{ type: 'text', name: 'evaluationTarget', value: '' }] },
	{ type: 'Sarosis.AskUser', title: '询问', color: '#06b6d4', inputs: [{ name: 'value', type: 'SAROSIS_JSON' }], outputs: [{ name: 'answer', type: 'SAROSIS_JSON' }], widgets: [{ type: 'text', name: 'questionText', value: '' }] },
	{ type: 'Sarosis.Group', title: '分组', color: '#888780' },
];

/** Build the LGraphNode subclass for a Sarosis node config. */
export function createSarosisNodeClass(cfg: SarosisNodeConfig): typeof LGraphNode {
	return class SarosisNode extends LGraphNode {
		constructor() {
			super(cfg.title);
			this.color = cfg.color ?? '#888';
			this.boxcolor = cfg.color ?? '#888';
			for (const inp of cfg.inputs ?? []) {
				this.addInput(inp.name, inp.type, { label: inp.name } as never);
			}
			for (const out of cfg.outputs ?? []) {
				this.addOutput(out.name, out.type, { label: out.name } as never);
			}
			this._initWidgets();
		}

		/** Create parameter widgets once (constructor). */
		private _initWidgets(): void {
			for (const w of cfg.widgets ?? []) {
				const current = (this.properties?.[w.name] as unknown) ?? w.value;
				// Persist widget edits back into properties AND notify the graph
				// so the store (graph.on_change → syncGraphToStore) picks the
				// parameter up on the next save.
				const commit = (v: unknown) => {
					this.properties[w.name] = v;
					this.graph?.change?.();
				};
				if (w.type === 'text') {
					const widget = this.addWidget('text', w.name, String(current), (v: string) => {
						commit(v);
					});
					if (w.multiline) {
						// ComfyUI-style multiline prompt widget (auto-expands).
						widget.options = { multiline: true };
					}
				} else if (w.type === 'toggle') {
					this.addWidget('toggle', w.name, Boolean(current), (v: boolean) => {
						commit(v);
					});
				} else if (w.type === 'button') {
					this.addWidget('button', w.name, null, () => { /* no-op */ });
				}
			}
		}

		override onConfigure(config: Record<string, unknown>): void {
			super.onConfigure?.(config);
			const label = (config as Record<string, unknown>).title;
			if (typeof label === 'string' && label.length > 0) {
				this.title = label;
			}
			// Re-hydrate widget values from the incoming properties so a loaded
			// workflow shows its saved parameters on the canvas. We match widgets
			// by name and only update their value — the widgets themselves were
			// created once in the constructor (0.17.2 widget system).
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

let registered = false;

/** Register all Sarosis node classes onto LiteGraph (idempotent). */
export function registerSarosisLiteGraphNodes(): void {
	if (registered) { return; }
	for (const cfg of NODE_CONFIGS) {
		const cls = createSarosisNodeClass(cfg);
		LiteGraph.registerNodeType(cfg.type, cls);
	}
	registered = true;
}

/** Reset registration (used by tests). */
export function unregisterSarosisLiteGraphNodes(): void {
	for (const cfg of NODE_CONFIGS) {
		try {
			LiteGraph.unregisterNodeType(cfg.type);
		} catch {
			// node type not registered — ignore
		}
	}
	registered = false;
}

/** Public config list (tests + diagnostics). */
export function sarosisNodeConfigs(): SarosisNodeConfig[] {
	return NODE_CONFIGS;
}
