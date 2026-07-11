/* Resolves a `[[wikilink]]` target against the list of notes in the open vault.
 *
 * Ported from Glyph's `src/lib/wikilinkResolver.ts`, adapted to resolve against
 * {@link WorkspaceFile} entries (which carry an absolute `file://` URI) instead
 * of raw file-path strings. The resolved value is the target note's URI, which
 * the webview later posts to the host via `kbblocks.openDoc`.
 */

import type { WorkspaceFile, ResolvedWikilink } from './types';

const PATH_SEP = /[\\/]/;

export function splitTargetAndHeading(input: string): { target: string; heading?: string } {
	const idx = input.indexOf('#');
	if (idx < 0) return { target: input };
	const heading = input.slice(idx + 1).trim();
	return { target: input.slice(0, idx), heading: heading || undefined };
}

export function stemOf(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

export function dirOf(path: string): string {
	const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return idx >= 0 ? path.slice(0, idx) : '';
}

function normalizeTarget(raw: string): string {
	let t = raw.trim();
	if (t.toLowerCase().endsWith('.md')) t = t.slice(0, -3);
	if (t.toLowerCase().endsWith('.markdown')) t = t.slice(0, -8);
	return t;
}

export function resolveWikilink(
	rawTarget: string,
	workspaceFiles: WorkspaceFile[],
	currentFilePath?: string,
): ResolvedWikilink {
	const { target, heading } = splitTargetAndHeading(rawTarget);
	const cleaned = normalizeTarget(target);
	if (!cleaned || workspaceFiles.length === 0) return { uri: null, heading };

	const lower = cleaned.toLowerCase();

	// Two match modes:
	//  1. relative-path-ish target ("folder/note") → match the suffix of any path
	//  2. bare name → match by stem
	const looksLikePath = cleaned.includes('/') || cleaned.includes('\\');
	// Path-suffix matching normalizes separators: vault URIs arrive with `/`
	// separators, while a wikilink target is authored with `/`, so
	// `[[Notes/Ingredients]]` still matches `…/Notes/Ingredients`.
	const targetSuffix = `/${lower.replace(/\\/g, '/')}`;

	const candidates: WorkspaceFile[] = [];
	for (const file of workspaceFiles) {
		if (looksLikePath) {
			const noExt = file.uri
				.replace(/\.[^./\\]+$/, '')
				.replace(/\\/g, '/')
				.toLowerCase();
			if (noExt.endsWith(targetSuffix)) {
				candidates.push(file);
			}
		} else if (stemOf(file.name).toLowerCase() === lower) {
			candidates.push(file);
		}
	}

	if (candidates.length === 0) return { uri: null, heading };
	if (candidates.length === 1) return { uri: candidates[0].uri, heading };

	// Disambiguate: prefer same-directory as the current file.
	if (currentFilePath) {
		const currentDir = dirOf(currentFilePath);
		const sameDir = candidates.find((c) => dirOf(c.uri) === currentDir);
		if (sameDir) return { uri: sameDir.uri, heading };
	}
	// Stable fallback: shortest path, then lexicographic.
	candidates.sort((a, b) => a.uri.length - b.uri.length || a.uri.localeCompare(b.uri));
	return { uri: candidates[0].uri, heading };
}
