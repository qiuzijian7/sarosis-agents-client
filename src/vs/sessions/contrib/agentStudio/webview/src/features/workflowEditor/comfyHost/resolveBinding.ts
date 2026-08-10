/*---------------------------------------------------------------------------------------------
 *  resolveBinding — parse ComfyTV-style bindings into concrete input values.
 *
 *  Binding grammar (aligned with ComfyTV's `_UPSTREAM_PAT` resolver):
 *   - `upstream_image:value`          → the whole value of the upstream `image` port
 *   - `upstream_image:value[0]`       → the first element of the upstream image port
 *   - `upstream_image:masked`         → mask-composited variant of the upstream image port
 *   - `main_prompt`                   → text output of the Prompt node
 *   - `option:seed`                   → current node widget value `seed`
 *   - `computed:width`                → computed value (width/height, etc.)
 *   - `literal:<json>`                → a literal JSON value
 *   - `{{var}}` inside binding value  → template-variable resolution (pre-pass)
 *
 *  NOTE: in `upstream_<port>:value`, `<port>` is the upstream INPUT PORT NAME
 *  (kind, e.g. `image`), NOT a node id — the port's value comes from whichever
 *  upstream node is connected to it. This matches ComfyTV semantics.
 *
 *  Pure and unit-testable; throws `BindingError` when a source is unavailable and
 *  no default is provided.
 *--------------------------------------------------------------------------------------------*/

export class BindingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BindingError';
	}
}

/** What an upstream input port can provide (resolved from the connected node). */
export interface UpstreamSource {
	/** full value of the port (e.g. images[]) */
	value: unknown;
	/** element at index */
	at(index: number): unknown;
	/** is a mask-composited variant available? */
	hasMask: boolean;
	/** rendered mask output (undefined when unavailable) */
	masked?: unknown;
}

export interface BindingContext {
	/** input port name → resolved upstream source (from whichever node is connected) */
	upstreams: Record<string, UpstreamSource>;
	/** current node widget values keyed by widget name */
	widgets: Record<string, unknown>;
	/** prompt-node text outputs (nodeId → text) for `main_prompt` */
	promptTexts: Record<string, string>;
	/** computed values provider (e.g. width/height) */
	computeds?: Record<string, unknown>;
	/** template-variable resolver: {{key}} → value */
	resolveTemplateVar?: (name: string) => unknown;
}

export interface ResolvedBinding {
	value: unknown;
	/** set when a mask-composited input was used */
	usedMask?: boolean;
	/** input port name the value came from */
	sourcePort?: string;
}

const UPSTREAM_RE = /^upstream_([A-Za-z0-9_]+):(value|masked)(?:\[(\d+)\])?$/;

/**
 * Resolve a binding string. Returns `ResolvedBinding`.
 * Throws BindingError when a required upstream source is missing and no default is given.
 */
export function resolveBinding(
	binding: string,
	ctx: BindingContext,
	defaultValue?: unknown,
	depth = 0,
): ResolvedBinding {
	if (depth > 5) {
		throw new BindingError(`binding recursion too deep: ${binding}`);
	}

	// 1. template-variable pre-pass: resolve {{var}} embedded anywhere
	const withVars = resolveTemplateVars(binding, ctx);
	if (withVars !== binding) {
		return { value: withVars };
	}

	// 2. literal:<json>
	if (binding.startsWith('literal:')) {
		try {
			return { value: JSON.parse(binding.slice('literal:'.length)) };
		} catch {
			return { value: binding.slice('literal:'.length) };
		}
	}

	// 3. upstream_<port>:value[n] / upstream_<port>:masked
	const m = UPSTREAM_RE.exec(binding);
	if (m) {
		const port = m[1];
		const kind = m[2];
		const idx = m[3] !== undefined ? Number(m[3]) : undefined;
		const source = ctx.upstreams[port];
		if (!source) {
			if (defaultValue !== undefined) {
				return { value: defaultValue };
			}
			throw new BindingError(`upstream source missing for port "${port}" (binding "${binding}")`);
		}
		if (kind === 'masked') {
			if (!source.hasMask) {
				if (defaultValue !== undefined) { return { value: defaultValue }; }
				throw new BindingError(`mask not available on port "${port}" (binding "${binding}")`);
			}
			return { value: source.masked ?? source.value, usedMask: true, sourcePort: port };
		}
		// kind === 'value'
		if (idx !== undefined) {
			return { value: source.at(idx), sourcePort: port };
		}
		return { value: source.value, sourcePort: port };
	}

	// 4. main_prompt → text output of the first prompt node
	if (binding === 'main_prompt') {
		const nodeId = Object.keys(ctx.promptTexts)[0];
		if (nodeId && ctx.promptTexts[nodeId] !== undefined) {
			return { value: ctx.promptTexts[nodeId] };
		}
		if (defaultValue !== undefined) { return { value: defaultValue }; }
		throw new BindingError('main_prompt: no prompt node output available');
	}

	// 5. option:<widgetName>
	if (binding.startsWith('option:')) {
		const name = binding.slice('option:'.length);
		if (name in ctx.widgets) {
			return { value: ctx.widgets[name] };
		}
		if (defaultValue !== undefined) { return { value: defaultValue }; }
		throw new BindingError(`option widget missing: ${name}`);
	}

	// 6. computed:<name>
	if (binding.startsWith('computed:')) {
		const name = binding.slice('computed:'.length);
		if (ctx.computeds?.[name] !== undefined) {
			return { value: ctx.computeds[name] };
		}
		if (defaultValue !== undefined) { return { value: defaultValue }; }
		throw new BindingError(`computed value missing: ${name}`);
	}

	// 7. plain scalar passthrough
	return { value: binding };
}

/** Resolve all `{{key}}` template variables inside a string. Returns the string unchanged if none. */
export function resolveTemplateVars(text: string, ctx: BindingContext): string {
	if (!text.includes('{{')) { return text; }
	const re = /\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g;
	return text.replace(re, (_m, name: string) => {
		const v = ctx.resolveTemplateVar?.(name);
		if (v === undefined || v === null) { return ''; }
		return typeof v === 'string' ? v : JSON.stringify(v);
	});
}

/**
 * Resolve a map of bindings (binding name → binding string) into concrete values.
 * Entries resolving to `undefined` are skipped (pruning empty optional slots).
 */
export function resolveBindingsMap(
	bindings: Record<string, string>,
	ctx: BindingContext,
	defaults: Record<string, unknown> = {},
): { values: Record<string, unknown>; usedMask: boolean; sources: Record<string, string> } {
	const values: Record<string, unknown> = {};
	const sources: Record<string, string> = {};
	let usedMask = false;
	for (const [name, binding] of Object.entries(bindings)) {
		const r = resolveBinding(binding, ctx, defaults[name]);
		if (r.value === undefined) { continue; }
		values[name] = r.value;
		if (r.usedMask) { usedMask = true; }
		if (r.sourcePort) {
			sources[name] = r.sourcePort;
		}
	}
	return { values, usedMask, sources };
}

/** True if a binding string is "present" (non-empty and not a bare placeholder). */
export function isBindingEmpty(binding: string | undefined | null): boolean {
	return !binding || binding.trim() === '' || binding.trim() === 'literal:null';
}
