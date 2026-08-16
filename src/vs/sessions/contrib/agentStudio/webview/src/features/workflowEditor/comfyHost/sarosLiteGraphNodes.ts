/*---------------------------------------------------------------------------------------------
 *  sarosLiteGraphNodes — real LiteGraph node classes for Saros custom node types.
 *
 *  Previously, Saros nodes (start/end/task/prompt/agent/skill/tool/ifElse/switch/
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
 *  Registration is idempotent and mirrors `registerSarosNodes()` in registry.ts.
 *--------------------------------------------------------------------------------------------*/

import { LiteGraph, LGraphNode } from '@comfyorg/litegraph';
import { comfyDrawWidgets } from '../comfyNodeStyle.js';
import { getNodeSpec } from './registry.js';

export interface SarosNodeConfig {
	type: string;
	title: string;
	color?: string;
	inputs?: Array<{ name: string; type: string }>;
	outputs?: Array<{ name: string; type: string }>;
	widgets?: Array<{ type: 'text' | 'button' | 'toggle'; name: string; value: unknown; multiline?: boolean }>;
}

const NODE_CONFIGS: SarosNodeConfig[] = [
	{ type: 'Saros.Start', title: '开始', color: '#22c55e', outputs: [{ name: 'value', type: 'SAROS_JSON' }] },
	{ type: 'Saros.End', title: '结束', color: '#ef4444', inputs: [{ name: 'value', type: 'SAROS_JSON' }] },
	{ type: 'Saros.Task', title: '任务', color: '#3b82f6', inputs: [{ name: 'value', type: 'SAROS_JSON' }], outputs: [{ name: 'value', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'taskId', value: '' }] },
	{ type: 'Saros.Prompt', title: '提示', color: '#8b5cf6', inputs: [{ name: 'value', type: 'SAROS_JSON' }], outputs: [{ name: 'output', type: 'TEXT' }], widgets: [{ type: 'text', name: 'prompt', value: '', multiline: true }] },
	{ type: 'Saros.Agent', title: 'Agent', color: '#f97316', inputs: [{ name: 'value', type: 'SAROS_JSON' }], outputs: [{ name: 'value', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'agentId', value: '' }] },
	{ type: 'Saros.Skill', title: 'Skill', color: '#eab308', inputs: [{ name: 'value', type: 'SAROS_JSON' }], outputs: [{ name: 'value', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'skillName', value: '' }] },
	{ type: 'Saros.Tool', title: 'Tool', color: '#10b981', inputs: [{ name: 'value', type: 'SAROS_JSON' }], outputs: [{ name: 'value', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'toolName', value: '' }] },
	{ type: 'Saros.IfElse', title: 'If/Else', color: '#ef4444', inputs: [{ name: 'value', type: 'SAROS_JSON' }], outputs: [{ name: 'true', type: 'SAROS_JSON' }, { name: 'false', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'evaluationTarget', value: '' }] },
	{ type: 'Saros.Switch', title: 'Switch', color: '#a855f7', inputs: [{ name: 'value', type: 'SAROS_JSON' }], outputs: [{ name: 'case', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'evaluationTarget', value: '' }] },
	{ type: 'Saros.AskUser', title: '询问', color: '#06b6d4', inputs: [{ name: 'value', type: 'SAROS_JSON' }], outputs: [{ name: 'answer', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'questionText', value: '' }] },
	{ type: 'Saros.Group', title: '分组', color: '#888780' },
	{ type: 'Saros.Subflow', title: '子流程', color: '#64748b', inputs: [{ name: 'value', type: 'SAROS_JSON' }], outputs: [{ name: 'value', type: 'SAROS_JSON' }] },
	{ type: 'Saros.ProviderPicker', title: 'Provider 选择', color: '#8b5cf6', inputs: [], outputs: [{ name: 'config', type: 'TEXT' }], widgets: [
		{ type: 'text', name: 'providerId', value: '' },
		{ type: 'text', name: 'modelId', value: '' },
	] },
	// NOTE: Saros.ModelImageGen is deliberately NOT here. It migrated to a
	// schema node (kind='schema' + backendKind='provider', see registry.ts) and
	// gets its LiteGraph class from schemaLiteGraphNodes (canvas title/ports +
	// addDOMWidget form). A duplicate SarosNode config here would OVERWRITE
	// that class at registration time (registerNodeType: last write wins),
	// resurrecting the old canvas widgets (providerId/modelId/…) underneath
	// the DOM card — the "两层参数 UI" bug.
];

/** Build the LGraphNode subclass for a Saros node config. */
export function createSarosNodeClass(cfg: SarosNodeConfig): typeof LGraphNode {
	return class SarosNode extends LGraphNode {
		// LiteGraph's `configure()` does `if (!info.title) this.title =
		// this.constructor.title` — without a static title the instance title
		// gets wiped to undefined on every load (blank title bar).
		static override title = cfg.title;
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

		/**
		 * Override `drawWidgets` on the Saros subclass instead of relying on
		 * the `LGraphNode.prototype.drawWidgets` patch from
		 * `applyComfyNodeStyle`. LiteGraph 0.17's subclass `extends LGraphNode`
		 * still resolves `drawWidgets` through the prototype chain, so the
		 * Saros nodes were double-painted — once by the original
		 * 0.17 `drawWidgets` (TextWidget.draw 渲染 label+value 文字，无背景框
		 * 的"参数面板上面一层") and once by our `comfyDrawWidgets` (字段框).
		 * Owning the override on the subclass guarantees a single render path.
		 */
		override drawWidgets(
			this: Parameters<typeof comfyDrawWidgets>[0],
			ctx: CanvasRenderingContext2D,
			options: unknown,
		): void {
			comfyDrawWidgets.call(this, ctx, options);
		}
	};
}

let registered = false;

/** Register all Saros node classes onto LiteGraph (idempotent). */
export function registerSarosLiteGraphNodes(): void {
	if (registered) { return; }
	for (const cfg of NODE_CONFIGS) {
		// Defensive: a node that migrated to kind='schema' owns its LiteGraph
		// class via schemaLiteGraphNodes (canvas title/ports + addDOMWidget
		// form). Never overwrite that registration — registerNodeType is
		// last-write-wins and we run after registerSarosNodes().
		if (getNodeSpec(cfg.type)?.kind === 'schema') { continue; }
		const cls = createSarosNodeClass(cfg);
		LiteGraph.registerNodeType(cfg.type, cls);
	}
	registered = true;
}

/** Reset registration (used by tests). */
export function unregisterSarosLiteGraphNodes(): void {
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
export function sarosNodeConfigs(): SarosNodeConfig[] {
	return NODE_CONFIGS;
}
