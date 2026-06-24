/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Template Variable Utilities
 *  Reference: cc-wf-studio packages/vscode/src/webview/src/utils/template-utils.ts
 *
 *  Lightweight Mustache-style {{variableName}} substitution utility used by:
 *    1. The canvas node editor (UI side): extract / detect / display variables.
 *    2. The host workflow executor (runtime side): substitute values into
 *       prompts before sending them to the agent.
 *
 *  Variable syntax:
 *    - {{name}}            (alphanumeric + underscore identifier)
 *    - {{$alias}}          (runtime aliases like $prev, $preNode)
 *    - {{taskTitle}}       (camelCase supported)
 *    - Undefined variables are left as the original `{{name}}` placeholder
 *      (matches cc-wf-studio behaviour; the LLM sees the unresolved token).
 *--------------------------------------------------------------------------------------------*/

export const VARIABLE_PATTERN = /\{\{(\$?[\w-]+(?:\.[\w-]+)*)\}\}/g;

/**
 * Extract the set of variable names referenced inside a template string.
 * Returns a deduplicated list, preserving first-seen order.
 *
 * @example
 *   extractVariables('Build a {{feature}} using {{stack}}')
 *   // => ['feature', 'stack']
 */
export function extractVariables(text: string): string[] {
	if (!text) { return []; }
	const matches = text.matchAll(VARIABLE_PATTERN);
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

/**
 * Substitute `{{name}}` placeholders with values from a record.
 * Undefined variables are left intact (the original `{{name}}` token is preserved)
 * so the LLM can see what is missing.
 *
 * @example
 *   substituteVariables('Hello {{name}}', { name: 'world' })
 *   // => 'Hello world'
 *   substituteVariables('Hi {{missing}}', {})
 *   // => 'Hi {{missing}}'
 */
export function substituteVariables(
	text: string,
	values: Record<string, string>,
): string {
	if (!text) { return text ?? ''; }
	return text.replace(VARIABLE_PATTERN, (match, varName: string) => {
		const v = values[varName];
		// `?? match` keeps the placeholder visible when the variable is missing.
		return v !== undefined ? v : match;
	});
}

/**
 * Return the list of variable names referenced in `text` that have no value
 * in the supplied `values` map. Useful for surfacing "missing inputs" in the UI.
 */
export function getUndefinedVariables(
	text: string,
	values: Record<string, string>,
): string[] {
	return extractVariables(text).filter(v => !(v in values));
}

/**
 * True if every variable referenced in `text` is present in `values`.
 */
export function isFullyDefined(
	text: string,
	values: Record<string, string>,
): boolean {
	return getUndefinedVariables(text, values).length === 0;
}

/**
 * Build a human-readable list of detected variables for the node badge /
 * property-panel footer. Returns null when there are no variables, so callers
 * can render a `null` badge cleanly.
 *
 * @example
 *   formatVariableBadge('{{a}} + {{b}}')
 *   // => '2 variables'
 */
export function formatVariableBadge(text: string): string | null {
	const n = extractVariables(text).length;
	if (n === 0) { return null; }
	return `${n} variable${n === 1 ? '' : 's'}`;
}
