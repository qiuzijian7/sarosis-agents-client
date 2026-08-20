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

import { LiteGraph, LGraphNode, type INodeInputSlot, type INodeOutputSlot } from '@comfyorg/litegraph';
import type { NodeSpec } from './registry';
import { ensureDomFormWidget, estimateFormHeight, estimateFormTop } from './domWidget';

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
	'COMFYTV_PANORAMA': '#8b5cf6',   // violet
	'COMFYTV_MATERIAL': '#f97316',   // orange
	'COMFYTV_STORYBOARD': '#14b8a6', // teal
	'COMFYTV_TIMELINE': '#e879f9',   // fuchsia
	'COMFYTV_JSON': '#64748b',       // slate
	'SAROS_JSON': '#64748b',         // slate（编排节点通用数据端口，对齐 COMFYTV_JSON）
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
			// NO_TITLE 已回滚：标题栏走 LiteGraph canvas（默认），node.color 用作标题背景色。
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
			// Give the node a sensible body so the card has room even before
			// the first layout pass. The DOM form widget (below) refines the
			// height once the React content is measured.
			// Width floor 320 mirrors ComfyTV's RICH_STAGE_MIN_WIDTHS default
			// (stageRegistry.ts): at 230 the parameter rows (80px label + control)
			// were squeezed to unreadable widths.
			// Height floor 520 matches ComfyTV's addDOMWidget `getMinHeight`
			// floor for rich stages (main.ts: GENERIC_STAGE_MIN_HEIGHT=380, but
			// ImageStage cards include params + run button + OUTPUT + ACTIONS
			// and consistently measure ~520 design units). The first
			// scrollHeight read in the rAF loop converges the height further.
			// 走 setSize 而非 this.size = [...]（见 configure 内的同款注释）。
			this.setSize?.([Math.max(this.size?.[0] ?? 320, 320), Math.max(this.size?.[1] ?? 520, 520)]);
			// ComfyTV 架构对齐：参数（workflow/resolution/aspect_ratio/batch_size）与
			// prompt 一样由 DOM 卡片（NodeCard）渲染——canvas 不再 addWidget 这些参数。
			// ComfyTV 里这些 widget 全部 `options.hidden=true`（applyHiddenWidgetFlags
			// 设 w.hidden），LiteGraph 不画，改由 StageCard 的 StagePresetBar/CustomParams
			// 重新渲染。我们同样「参数 DOM 化」，canvas 只保留标题栏 + 端口圆点 + box，
			// 从而两个 schema 节点重叠时，下层 DOM 只盖上层 30px 标题栏（ComfyTV 同款
			// 小瑕疵），不再盖住 ~96px 的参数 widget（用户反馈的层级错误）。
			ensureFormWidget(this, spec);
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
			// Loaded nodes restore their saved (possibly pre-320-floor) width —
			// re-apply the width floor like ComfyTV's nodeCreated setSize does.
			if ((this.size?.[0] ?? 0) < 320) {
				// 走 setSize 而非 this.size = [...] —— LiteGraph 0.17 的 size getter
				// 会被 Object.defineProperty 拦截，直接赋值新数组可能让其他内部字段
				// 仍引用旧数组（数据竞争，syncOverlay 看到 stale size/pos），
				// 且 setSize 才触发布局（setDirtyCanvas → drawNode → arrange）。
				this.setSize?.([320, this.size?.[1] ?? 520]);
			}
			// Height self-heal: loaded nodes may have an old 300px height that
			// chops off the actions/output rows. Reapply the new 520 floor.
			else if ((this.size?.[1] ?? 0) < 520) {
				this.setSize?.([this.size[0], 520]);
			}
			// Self-heal nodes saved before the addDOMWidget migration: the
			// form widget is never serialized, so re-attach it on load.
			ensureFormWidget(this, spec);
			// Re-install LiteGraph ports from current spec (overrides may have
			// changed inputs/outputs since the file was saved).
			//
			// ⚠ CRITICAL: super.configure() (and LGraph.configure()'s post-pass)
			// populates input.link / output.links with live link references.
			// Blindly replacing the arrays wipes those references → links exist
			// in graph.links but nodes report originSlotExists:false /
			// targetSlotExists:false → no visible connection line AND no data
			// flow (e.g. ImageStage→ImagePicker). Fix: snapshot link state
			// before replacing, then restore into the new slot objects.
			const prevInputLinks = (this.inputs ?? []).map(p => p.link);
			const prevOutputLinks = (this.outputs ?? []).map(p => p.links);
			this.inputs = (spec.inputs ?? []).map((p, i) => ({ name: p.name, type: p.type, link: prevInputLinks[i] ?? null, dir: 'in' as const })) as unknown as INodeInputSlot[];
			this.outputs = (spec.outputs ?? []).map((p, i) => ({ name: p.name, type: p.type, links: prevOutputLinks[i] ?? null, dir: 'out' as const })) as unknown as INodeOutputSlot[];
		}
	}
	return SchemaStageNode;
}

/** addDOMWidget-style form widget: LiteGraph owns the widget area layout
 *  (y + node height via arrange/computeSize); the React card only renders
 *  into the rectangle LiteGraph assigns. See domWidget.ts. */
function ensureFormWidget(node: LGraphNode, spec: NodeSpec): void {
	const widgets = spec.widgets ?? [];
	// 参数（workflow/resolution/...）已 DOM 化（NodeCard 渲染），不再 addWidget。
	// form widget 排在端口行之下（estimateFormTop 只算端口行），controlCount 计入
	// 参数行高（参数 + prompt + 按钮 + OUTPUT + ACTIONS 都在同一张 DOM 卡片里）。
	const paramWidgets = widgets.filter(w => w.name !== 'prompt').length;
	ensureDomFormWidget(node as unknown as Parameters<typeof ensureDomFormWidget>[0], {
		estimateHeight: estimateFormHeight({
			controlCount: paramWidgets,
			hasPrompt: widgets.some(w => w.name === 'prompt'),
		}),
		estimateTop: estimateFormTop(spec.inputs?.length ?? 0, spec.outputs?.length ?? 0),
	});
}

/** False for empty / type-string / single-character titles (legacy dirty data). */
export function isUsableNodeTitle(title: unknown, specType?: string): boolean {
	if (typeof title !== 'string') { return false; }
	const t = title.trim();
	if (t.length < 2) { return false; }
	if (specType && t === specType) { return false; }
	// "ComfyTV.ImageStage" / "Saros.ModelImageGen" style type strings.
	if (/^(?:ComfyTV|Comfy|Saros)\./i.test(t)) { return false; }
	return true;
}

const registered = new Map<string, NodeSpec>();

/** Register a schema stage as a LiteGraph node class (idempotent per type).
 *
 *  The `LiteGraph.registerNodeType` call MUST survive esbuild's tree-shaking.
 *  Without it, schema nodes fall back to the generic `LGraphNode` class and
 *  lose the title/port overrides.
 *
 *  IMPORTANT: the node class CLOSES OVER `spec` (ports/widgets built in the
 *  constructor). When the same type is re-registered with a NEW spec object
 *  (e.g. refineStage swapping inputs/outputs/widgets), we MUST rebuild the
 *  class — otherwise nodes keep the stale first-registered ports. */
export function registerSchemaLiteGraphNode(spec: NodeSpec): void {
	const prev = registered.get(spec.type);
	if (prev === spec) { return; } // 同一 spec 对象 → 幂等跳过
	LiteGraph.registerNodeType(spec.type, createSchemaNodeClass(spec));
	registered.set(spec.type, spec);
}

/** Reset registration (tests). */
export function unregisterSchemaLiteGraphNodes(): void {
	for (const type of registered.keys()) {
		try {
			LiteGraph.unregisterNodeType(type);
		} catch { /* not registered */ }
	}
	registered.clear();
}
