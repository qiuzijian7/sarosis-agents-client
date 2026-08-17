/*---------------------------------------------------------------------------------------------
 *  Plan File Utilities (MiMo-Code-inspired)
 *
 *  Generates plan file paths and provides path-matching utilities for the
 *  plan-mode hard-permission exception (plan files are the ONLY writable
 *  files in plan mode, mirroring MiMo's `.mimocode/plans/*.md` pattern).
 *
 *  Pure + dependency-free → fully unit-testable.
 *--------------------------------------------------------------------------------------------*/

import { join } from '../../../../base/common/path.js';

/**
 * Generate a plan file path: `<sarosRoot>/plans/<timestamp>-<slug>.md`
 *
 * Mirrors MiMo-Code's `Session.plan()` → `.mimocode/plans/<ts>-<slug>.md`.
 * The plan file is the ONLY file writable in plan mode (hardPermission exception).
 */
export function generatePlanPath(
	sarosRoot: string,
	userMessage: string,
	timestamp: number = Date.now(),
): string {
	const slug = slugify(userMessage.slice(0, 60));
	const ts = new Date(timestamp).toISOString().replace(/[:.]/g, '-').slice(0, 19);
	return join(sarosRoot, 'plans', `${ts}-${slug}.md`);
}

/**
 * Convert arbitrary text to a URL/filesystem-safe slug.
 * Preserves CJK characters (common in Chinese user messages).
 */
export function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.trim()
		.replace(/[^\w\u4e00-\u9fff]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return slug || 'plan';
}

/**
 * Glob pattern matching plan files (relative to saros root).
 * Used by hardPermission to allow writes to plan files only.
 */
export const PLAN_FILE_GLOB = 'plans/*.md';

/**
 * Check if a file path is a plan file (matches `plans/*.md` pattern).
 * Supports both absolute and relative paths.
 *
 * NOTE: This only checks the PATH SHAPE. For security, always use in combination
 * with `isPlanFilePathInRoot()` which validates the resolved path against the
 * intended plan root directory.
 */
export function isPlanFilePath(filePath: string): boolean {
	if (!filePath) { return false; }
	const normalized = filePath.replace(/\\/g, '/').toLowerCase();
	// Match: plans/foo.md, /plans/foo.md, ~/.vssaros/plans/foo.md
	return /(^|\/)plans\/[^/]+\.md$/.test(normalized);
}

/**
 * Validate that a plan file path resolves to within the plan root directory.
 * Prevents path traversal (../), symlink escape, and cross-device attacks.
 *
 * @param filePath The candidate plan file path
 * @param planRoot The expected plan root directory (~/.vssaros/plans)
 * @returns true if the resolved path is within planRoot
 */
export function isPlanFilePathInRoot(filePath: string, planRoot: string): boolean {
	if (!filePath || !planRoot) { return false; }
	try {
		const resolvedFile = normalizePath(filePath);
		const resolvedRoot = normalizePath(planRoot + '/');
		return resolvedFile.startsWith(resolvedRoot) && !resolvedFile.includes('/../');
	} catch {
		return false;
	}
}

/** Normalize a path: resolve segments, strip trailing separators, lowercase on Windows. */
function normalizePath(p: string): string {
	// Resolve parent references and normalize separators
	const segments = p.replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
	const resolved: string[] = [];
	for (const seg of segments) {
		if (seg === '..') { resolved.pop(); continue; }
		resolved.push(seg);
	}
	return resolved.join('/').toLowerCase();
}
