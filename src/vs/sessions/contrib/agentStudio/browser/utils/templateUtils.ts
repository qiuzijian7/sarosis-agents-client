/*---------------------------------------------------------------------------------------------
 *  Agent Studio Host - Template Variable Utilities
 *  Runtime side of the {{variable}} system. Mirrors the webview
 *  `utils/templateUtils.ts` (Mustache-style double-brace identifiers).
 *
 *  Used by `WorkflowExecutionService` to substitute node data.prompt
 *  values just before sending them to an agent. Variable sources:
 *    1. executionState.context  (taskTitle / taskDescription / ...)
 *    2. data.variables           (per-node static values, cc-wf-studio parity)
 *    3. upstream node outputs    (key: <nodeId>.output, plus the special
 *                                 `$prev` alias for the most recent node)
 *--------------------------------------------------------------------------------------------*/

export const HOST_VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

/** Extract the set of variable names referenced in a template. */
export function extractHostVariables(text: string): string[] {
	if (!text) { return []; }
	const matches = text.matchAll(HOST_VARIABLE_PATTERN);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of matches) {
		const name = m[1];
		if (!seen.has(name)) {
			seen.add(name);
			out.push(name);
		}
	}
	return out;
}

/** Substitutes values. Undefined variables are preserved as `{{name}}`. */
export function substituteHostVariables(
	text: string,
	values: Record<string, string>,
): string {
	if (!text) { return text ?? ''; }
	return text.replace(HOST_VARIABLE_PATTERN, (match, varName: string) => {
		const v = values[varName];
		return v !== undefined ? v : match;
	});
}

/** List of variable names in `text` that have no entry in `values`. */
export function getUndefinedHostVariables(
	text: string,
	values: Record<string, string>,
): string[] {
	return extractHostVariables(text).filter(v => !(v in values));
}

/**
 * Build the runtime value map for a single node execution.
 *
 * Layered (later wins, but the lookup is single-key so order is informational):
 *   1. executionState.context  (e.g. taskTitle, taskDescription, taskConsumed flag)
 *   2. data.variables          (per-node static value overrides)
 *   3. upstream node outputs   (key: <nodeId>.output, plus `$prev` for last)
 *   4. workflow name           (`workflowName`)
 *
 * `consumed` is a special token: when the first consuming node already
 * received `taskDescription`, the context flag is set and the value is
 * hidden from later nodes (see workflowExecutionService v10).
 */
export function buildRuntimeValueMap(args: {
	context: Record<string, unknown> | undefined;
	nodeVariables: Record<string, string> | undefined;
	upstreamOutputs: Record<string, string> | undefined;
	workflowName: string;
}): Record<string, string> {
	const values: Record<string, string> = {};
	const ctx = args.context ?? {};

	// Layer 1: execution context. Skip the consumed taskDescription once a
	// downstream node has taken it (workflowExecutionService v10 behaviour).
	const consumed = Boolean(ctx['_taskConsumed']);
	for (const [k, v] of Object.entries(ctx)) {
		if (k.startsWith('_')) { continue; } // internal flag (e.g. _taskConsumed)
		if (consumed && k === 'taskDescription') { continue; }
		if (typeof v === 'string') {
			values[k] = v;
		} else if (v !== undefined && v !== null) {
			values[k] = String(v);
		}
	}
	// Alias: `input` resolves to the workflow's user-provided input (taskDescription).
	if (values['taskDescription'] !== undefined) {
		values['input'] = values['taskDescription'];
	}

	// Layer 2: per-node static values (cc-wf-studio `data.variables`).
	if (args.nodeVariables) {
		for (const [k, v] of Object.entries(args.nodeVariables)) {
			values[k] = v;
		}
	}

	// Layer 3: upstream node outputs. Keys: <nodeId>.output and `$prev` alias
	// (the most recent upstream node's output).
	if (args.upstreamOutputs) {
		// Strip the `.output` suffix for direct lookup (so {{myNode}} also works).
		for (const [nodeId, out] of Object.entries(args.upstreamOutputs)) {
			values[`${nodeId}.output`] = out;
			values[nodeId] = out;
		}
		// `$prev` = most recent upstream (already a flattened string).
		const lastId = Object.keys(args.upstreamOutputs).pop();
		if (lastId) {
			const lastOut = args.upstreamOutputs[lastId];
			values['$prev'] = lastOut;
			values['$prev.output'] = lastOut;
		}
	}

	// Layer 4: workflow metadata.
	values['workflowName'] = args.workflowName;

	return values;
}
