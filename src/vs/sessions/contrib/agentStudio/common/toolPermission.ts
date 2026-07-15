/*---------------------------------------------------------------------------------------------
 *  Hard Permission (MiMo-Code-inspired)
 *
 *  `hardPermission` is an INVARIANT layer appended AFTER all other tool filtering
 *  (enabledToolsets / allowlist / toolsetsOverride / disabledToolsets). Tools matched by
 *  the hard-permission policy are unconditionally removed from the LLM-visible tool list
 *  and cannot be re-enabled by toolset config, user approval, or an agent prompt.
 *
 *  This mirrors MiMo-Code's `hardPermission` post-append: e.g. plan mode locks every
 *  file-write / execute tool so the agent literally cannot mutate the workspace no matter
 *  what it (or the user) tries.
 *
 *  Pure + dependency-free → fully unit-testable.
 *--------------------------------------------------------------------------------------------*/

import type { IToolDefinition } from './providers.js';

export interface IHardPermissionPolicy {
	/** Tool-name / prefix patterns that are unconditionally denied. */
	readonly deniedToolPatterns: readonly string[];
	/** Optional human-readable reason shown to the user / logged. */
	readonly reason?: string;
}

/**
 * True if `toolName` is matched by the hard-permission policy.
 * Supports exact match and trailing-`*` prefix match.
 */
export function isToolHardDenied(toolName: string, policy: IHardPermissionPolicy | undefined): boolean {
	if (!policy || policy.deniedToolPatterns.length === 0) {
		return false;
	}
	return policy.deniedToolPatterns.some((p) => {
		if (p === toolName) { return true; }
		if (p.endsWith('*') && toolName.startsWith(p.slice(0, -1))) { return true; }
		return false;
	});
}

/**
 * Strip hard-denied tools from a list *after* all other filtering has run.
 * Pure: returns a new array; never mutates the input.
 */
export function applyHardPermission<T extends { name: string }>(
	tools: readonly T[],
	policy: IHardPermissionPolicy | undefined,
): T[] {
	if (!policy || policy.deniedToolPatterns.length === 0) {
		return tools.slice();
	}
	return tools.filter((t) => !isToolHardDenied(t.name, policy));
}

/**
 * The default hard-permission policy for plan mode: every file-write / execute tool is
 * unconditionally locked. The agent may read and plan but cannot mutate the workspace.
 */
export function planModeHardPermission(): IHardPermissionPolicy {
	return {
		deniedToolPatterns: [
			'write', 'write_to_file', 'apply_diff', 'create_file', 'edit_file',
			'edit', 'rename_file', 'delete_file', 'file_write', 'file_edit',
			'terminal_cmd',
		],
		reason: 'plan mode: write/execute tools are locked by hard permission',
	};
}

export type { IToolDefinition };
