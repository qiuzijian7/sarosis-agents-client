/*---------------------------------------------------------------------------------------------
 *  domWidget — addDOMWidget-style bridge (ComfyUI frontend architecture).
 *
 *  The installed @comfyorg/litegraph (0.17.2) does not ship `addDOMWidget`
 *  (that helper lives in the ComfyUI frontend), but it DOES ship everything
 *  the architecture needs:
 *   - `node.addCustomWidget()` accepts duck-typed widget objects
 *   - `node.arrange()` (called by `drawNode` every frame) assigns each widget
 *     its `y` / `computedHeight` BELOW the title bar and port rows, and grows
 *     the node when widgets overflow
 *   - `node.computeSize()` accounts widget heights via `widget.computeSize()`
 *
 *  So instead of overlay containers positioned by a hand-rolled inset formula
 *  (which had to reverse-engineer LiteGraph's layout and kept drifting over
 *  the pins), a schema node carries ONE `type: 'dom'` widget: LiteGraph owns
 *  the layout (position + node height), the React card only renders content
 *  into the rectangle LiteGraph assigned. The overlay sync reads `widget.y` /
 *  `widget.computedHeight` — it never computes layout itself.
 *
 *  Height feedback: the React content height varies (progress bar, error
 *  banner, output preview appear/disappear). `NodeCard` marks its node dirty
 *  after every render (`markFormHeightDirty`); the canvas rAF loop measures
 *  `scrollHeight` once per dirty node and calls `setDomFormContentHeight`,
 *  which resizes the node to fit. No per-frame layout reads → no thrash.
 *--------------------------------------------------------------------------------------------*/

/** Widget `type` marker. `toConcreteWidget()` returns undefined for unknown
 *  types (wrapLegacyWidgets=false), so click processing falls through to our
 *  inert `mouse()` handler and the canvas keeps working. */
export const DOM_WIDGET_TYPE = 'dom';

/** Name of the single form widget hosted by schema nodes. */
export const DOM_FORM_WIDGET_NAME = '__saros_form';

/** LiteGraph layout constants mirrored for estimates (graph units). */
const SLOT_HEIGHT = 20;
/** `BaseWidget.margin` — widget area starts 15 graph units from the node edge. */
export const DOM_WIDGET_MARGIN = 15;
/** Vertical gap LiteGraph adds around each widget (`computedHeight = h + 4`). */
export const DOM_WIDGET_VPAD = 4;

/** Structural type of the node surface we touch (real LGraphNode satisfies it). */
export interface DomWidgetNode {
	widgets?: DomFormWidget[];
	size: [number, number];
	inputs?: unknown[];
	outputs?: unknown[];
	addCustomWidget?(widget: unknown): unknown;
	arrange?(): void;
	setSize(size: [number, number]): void;
	setDirtyCanvas?(fg: boolean, bg: boolean): void;
}

/** The duck-typed widget object LiteGraph carries for us. */
export interface DomFormWidget {
	type: typeof DOM_WIDGET_TYPE;
	name: string;
	/** Node-local y assigned by `node.arrange()` (LiteGraph layout). */
	y: number;
	/** Last drawn y — used by `getWidgetOnPos` hit-testing. */
	last_y?: number;
	/** Total row height incl. LiteGraph's 4px widget gap (set by arrange()). */
	computedHeight: number;
	/** Desired CONTENT height in graph units (feedback from the React card). */
	userHeight: number;
	/** Last content height fed back (graph units). Used by the convergence
	 *  guard in `setDomFormContentHeight` to break the per-frame measure→
	 *  setSize→commit→mark-dirty loop on stable-height cards (e.g. EmojiStage). */
	lastFedHeight?: number;
	/** Never persisted — the widget is re-created from the spec on load. */
	serialize: false;
	options: Record<string, unknown>;
	hidden: boolean;
	/** LiteGraph calls this for fixed-height widgets in arrange()/computeSize(). */
	computeSize(width?: number): [number, number];
	/** Canvas draw — the DOM overlay renders the content, so: no-op. */
	draw(): void;
	/** Inert pointer handling: don't swallow the event, don't block dragging. */
	mouse(): boolean;
}

/** Rough content-height estimate for a schema card (used before the first
 *  DOM measurement lands — avoids a one-frame zero-height flash). Pure. */
export function estimateFormHeight(input: { controlCount: number; hasPrompt: boolean }): number {
	const rows = input.controlCount;
	const controls = rows * 28;
	const prompt = input.hasPrompt ? 40 : 0;
	// run button + output/actions allowance + card padding
	const chrome = 40 + 56 + 14;
	return controls + prompt + chrome;
}

/** Node-local y where the widget area starts (port rows + gap). Pure.
 *
 *  BODY-RELATIVE coordinates: in litegraph 0.17 the title bar is drawn ABOVE
 *  `pos[1]`, so node-local y=0 is the top of the node BODY, not the title.
 *  Slots sit at (i + 0.7) * SLOT_HEIGHT; `arrange()` starts widgets at
 *  (slots bottom) + 2 = maxPorts * SLOT_HEIGHT + 6. Mirrors that exactly so
 *  the pre-arrange estimate lands on the same y `arrange()` will assign. */
export function estimateFormTop(inputCount: number, outputCount: number): number {
	return Math.max(inputCount, outputCount, 0) * SLOT_HEIGHT + 6;
}

/** Find the form widget hosted by a node (undefined when none). */
export function getDomFormWidget(node: DomWidgetNode | null | undefined): DomFormWidget | undefined {
	return node?.widgets?.find(w => w?.type === DOM_WIDGET_TYPE && w?.name === DOM_FORM_WIDGET_NAME);
}

/**
 * Attach the form widget to a node (idempotent). Call from the node
 * constructor AND from `configure()` so old saves (which never serialized
 * the widget) self-heal on load.
 */
export function ensureDomFormWidget(
	node: DomWidgetNode,
	opts: { estimateHeight: number; estimateTop: number },
): DomFormWidget {
	const existing = getDomFormWidget(node);
	if (existing) { return existing; }
	const widget: DomFormWidget = {
		type: DOM_WIDGET_TYPE,
		name: DOM_FORM_WIDGET_NAME,
		y: opts.estimateTop,
		computedHeight: opts.estimateHeight + DOM_WIDGET_VPAD,
		userHeight: opts.estimateHeight,
		serialize: false,
		options: {},
		hidden: false,
		computeSize(width?: number): [number, number] {
			return [width ?? 0, widget.userHeight];
		},
		draw(): void { /* rendered by the DOM overlay */ },
		mouse(): boolean { return false; },
	};
	if (node.addCustomWidget) {
		node.addCustomWidget(widget);
	} else {
		node.widgets = node.widgets ?? [];
		node.widgets.push(widget);
	}
	return widget;
}

/**
 * Feed a measured content height (graph/design units) back into the layout:
 * updates the widget's desired height, re-runs LiteGraph's arrangement, and
 * resizes the node so the widget area exactly wraps the content.
 * Returns true when anything changed.
 *
 * 重要：之前早期 return `if (widget.userHeight === h)` 在 userHeight 已等于 h
 * 时直接退出，可能导致 node.size[1] 偏大后永远不修正（节点画布背景看着比
 * 卡片内容高一截，「节点高度异常」）。改为只在 userHeight 和 size 都匹配时
 * 才 early-return。
 */
export function setDomFormContentHeight(node: DomWidgetNode, contentHeight: number): boolean {
	const widget = getDomFormWidget(node);
	if (!widget) { return false; }
	const h = Math.max(40, Math.ceil(contentHeight));
	// ── Convergence guard (fixes per-frame height-feedback jitter) ──────────
	// The canvas rAF loop marks a node dirty after every React commit, then
	// re-measures scrollHeight here. For cards whose content is stable (e.g.
	// EmojiStage's fixed grid + editor panel) this creates a closed loop:
	// measure → setSize (+1px) → React commit → mark dirty → measure again,
	// forever oscillating the node size (977↔1093 in logs) and spamming the
	// height-feedback warning. Once the measured height equals the last value
	// we applied, skip the write so the loop converges. First growth still
	// passes because widget.lastFedHeight starts undefined.
	if (widget.lastFedHeight === h) {
		return false;
	}
	widget.lastFedHeight = h;
	widget.userHeight = h;
	widget.computedHeight = h + DOM_WIDGET_VPAD;
	// Re-arrange so widget.y reflects the current slots. arrange() throws when
	// the node isn't attached to a graph yet (NullGraphError) — safe to skip,
	// the first drawNode will arrange it.
	try { node.arrange?.(); } catch { /* not attached yet */ }
	const target = Math.ceil(widget.y + h + 8);
	const current = node.size?.[1] ?? 0;
	if (Math.abs(current - target) > 1) {
		node.setSize([node.size[0], target]);
	}
	node.setDirtyCanvas?.(true, true);
	return true;
}

// ── Dirty tracking: React card renders → one scrollHeight read next frame ──

const dirtyNodes = new Set<string>();

/** Mark a node's card content as potentially resized (called post-render). */
export function markFormHeightDirty(nodeId: string): void {
	dirtyNodes.add(nodeId);
}

/** Consume the dirty flag for a node (true = caller should re-measure). */
export function takeFormHeightDirty(nodeId: string): boolean {
	return dirtyNodes.delete(nodeId);
}

/** Drop dirty state (node removed / canvas torn down). */
export function clearFormHeightDirty(nodeId?: string): void {
	if (nodeId === undefined) { dirtyNodes.clear(); } else { dirtyNodes.delete(nodeId); }
}
