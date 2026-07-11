/* Resolving relative file references (markdown links, image sources) against the
 * directory of the document that contains them.
 *
 * Ported from Glyph's `src/lib/relativePath.ts`, trimmed to the match modes the
 * KB webview actually needs (markdown + images). The workspace root clamp is
 * optional; when `root` is omitted (single-file mode) resolution is unconstrained.
 */

import { isMarkdownFile } from './markdownExtensions';

export function normalizeRelativePath(docPath: string, target: string): string {
	const cleanTarget = target.split('#')[0];
	const sep = docPath.includes('\\') ? '\\' : '/';
	const dir = docPath.replace(/[/\\][^/\\]*$/, '');
	const combined = `${dir}${sep}${cleanTarget}`;
	// Preserve the leading separator run verbatim (POSIX `/`, UNC/verbatim `\\`)
	// so it isn't collapsed away when we rejoin the segments.
	const lead = combined.match(/^[/\\]+/)?.[0] ?? '';
	const out: string[] = [];
	for (const seg of combined.slice(lead.length).split(/[/\\]+/)) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') {
			if (out.length > 0) out.pop();
			continue;
		}
		out.push(seg);
	}
	return lead + out.join(sep);
}

export function resolveWorkspacePath(
	docPath: string,
	target: string,
	root: string | undefined,
): string | null {
	const resolved = normalizeRelativePath(docPath, target);
	if (root && !isPathInside(resolved, root)) return null;
	return resolved;
}

export function isRelativeLocalHref(href: string): boolean {
	if (!href) return false;
	if (href.startsWith('#')) return false;
	if (href.startsWith('//')) return false; // protocol-relative URL
	if (href.startsWith('/') || href.startsWith('\\')) return false; // POSIX / UNC absolute
	// A URL scheme (`http:`, `mailto:`, `data:`) or a Windows drive (`C:\`).
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return false;
	return true;
}

/** A relative link the KB opens in-workspace (rather than the browser): a local
 * markdown/canvas document. The trailing `#heading` is ignored here. */
export function isOpenableRelativeHref(href: string | undefined): href is string {
	if (!href || !isRelativeLocalHref(href)) return false;
	const target = href.split('#')[0];
	return isMarkdownFile(target);
}

function isPathInside(resolved: string, root: string): boolean {
	const a = resolved.replace(/[/\\]+/g, '/').toLowerCase();
	const b = root.replace(/[/\\]+/g, '/').toLowerCase().replace(/\/$/, '');
	return a === b || a.startsWith(b + '/');
}
