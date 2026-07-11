/* Offline, zero-dependency stand-in for `rehype-raw` + `rehype-sanitize`.
 *
 * `react-markdown` v9 does NOT render raw HTML unless `rehype-raw` is present —
 * it leaves raw HTML in the hast tree as `{ type: 'raw', value }` nodes.
 * This plugin parses those `raw` nodes into real hast via the browser's
 * `DOMParser` (available in the VS Code webview runtime), then sanitises the
 * result through a *strict allowlist*:
 *   - no `script` / `style` / `iframe` / `object` / `embed` / `form` / `input`
 *     / `link` / `meta` / `head` / `body` / `html` / `frame` elements
 *   - no `on*` event handlers, no inline `style`
 *   - no `javascript:` / `data:` / `vbscript:` URLs in `href` / `src`
 *
 * This is intentionally stricter than Glyph's default sanitise (smaller XSS
 * surface), matching the project's "offline zero extra deps" constraint — we
 * reimplemented the capability instead of installing the two npm packages
 * (which currently cannot be installed in this workspace: the webview's
 * `@blocksuite/presets@^0.20.0` has no matching version on the registry, so any
 * `npm install` fails before it even reaches `rehype-raw`).
 *
 * NOTE: `DOMParser` only exists in the browser/webview runtime. In a non-DOM
 * environment (e.g. the Node unit-test runner) `raw` nodes are left untouched
 * (no-op) so the rest of the tree still renders. The allowlist logic in
 * `sanitizeChildren` is a pure function and is unit-tested directly.
 */

import type { Plugin } from 'unified';
import type { Root, RootContent, ElementContent, Properties } from 'hast';

// Tags permitted in raw HTML. Deliberately excludes anything that can execute
// script or pull in external resources (iframe/object/embed/frame), form
// controls, and document-structure tags.
const ALLOWED_TAGS = new Set([
	'div', 'span', 'p', 'br', 'hr', 'section', 'article', 'header', 'footer',
	'main', 'aside', 'nav', 'details', 'summary', 'blockquote', 'pre', 'code',
	'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
	'caption', 'figure', 'figcaption', 'img', 'a', 'strong', 'em', 'b', 'i',
	'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'kbd', 'abbr',
	'cite', 'q', 'time', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'address', 'bdi', 'bdo', 'dfn', 'rp', 'rt', 'ruby', 'wbr', 'var', 'samp',
]);

// Attributes allowed on every allowed tag.
const GLOBAL_ATTRS = new Set(['class', 'id', 'title', 'lang', 'dir', 'align', 'width', 'height']);

// Extra attributes allowed on specific tags.
const TAG_ATTRS: Record<string, Set<string>> = {
	a: new Set(['href', 'target', 'rel', 'download']),
	img: new Set(['src', 'alt', 'width', 'height', 'title', 'loading']),
	td: new Set(['colspan', 'rowspan']),
	th: new Set(['colspan', 'rowspan', 'scope']),
	time: new Set(['datetime']),
	blockquote: new Set(['cite']),
	q: new Set(['cite']),
	abbr: new Set(['title']),
};

const URL_ATTRS = new Set(['href', 'src']);
// Protocols we accept in URL-bearing attributes.
const SAFE_URL_RE = /^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i;

// Map HTML attribute names to their hast/React property names so React renders
// them correctly (e.g. `class` → `className`, `colspan` → `colSpan`).
const ATTR_NAME_MAP: Record<string, string> = {
	class: 'className',
	for: 'htmlFor',
	colspan: 'colSpan',
	rowspan: 'rowSpan',
	readonly: 'readOnly',
	tabindex: 'tabIndex',
	maxlength: 'maxLength',
	crossorigin: 'crossOrigin',
	contenteditable: 'contentEditable',
};

function isSafeUrl(url: string): boolean {
	const u = url.trim();
	if (/^(javascript|data|vbscript):/i.test(u)) return false;
	return SAFE_URL_RE.test(u);
}

/** Drop disallowed attributes from a single element's properties. */
export function sanitizeAttrs(tag: string, props: Properties): Properties {
	const allowed = new Set([...GLOBAL_ATTRS, ...(TAG_ATTRS[tag] ?? [])]);
	const out: Properties = {};
	for (const [k, v] of Object.entries(props)) {
		const kl = k.toLowerCase();
		if (kl.startsWith('on')) continue; // drop all event handlers
		if (kl === 'style') continue; // no inline styles (XSS surface)
		if (!allowed.has(kl)) continue;
		if (URL_ATTRS.has(kl) && typeof v === 'string' && !isSafeUrl(v)) continue;
		out[ATTR_NAME_MAP[kl] ?? k] = v;
	}
	// Harden `target="_blank"` against reverse-tabnabbing.
	if (tag === 'a' && props.target === '_blank' && !out.rel) {
		out.rel = 'noopener noreferrer';
	}
	return out;
}

/** Recursively sanitise a list of hast children through the allowlist. */
export function sanitizeChildren(children: ElementContent[]): ElementContent[] {
	const out: ElementContent[] = [];
	for (const child of children) {
		if (child.type === 'text') {
			out.push(child);
			continue;
		}
		if (child.type === 'element') {
			const tag = child.tagName.toLowerCase();
			if (!ALLOWED_TAGS.has(tag)) {
				// Disallowed element (e.g. <script>, <style>, <iframe>, <object>,
				// <embed>, <form>, ...): drop it *and* its descendants entirely.
				// We never unwrap, so even a `<script>`'s text never reaches the DOM.
				continue;
			}
			out.push({
				type: 'element',
				tagName: tag,
				properties: sanitizeAttrs(tag, child.properties ?? {}),
				children: sanitizeChildren(child.children ?? []),
			});
		}
		// comments / doctypes / etc. are dropped
	}
	return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function domToHast(node: any): ElementContent | null {
	if (node.nodeType === 3 /* TEXT_NODE */) {
		return { type: 'text', value: node.nodeValue ?? '' };
	}
	if (node.nodeType === 1 /* ELEMENT_NODE */) {
		const props: Properties = {};
		for (const attr of Array.from(node.attributes)) {
			props[attr.name.toLowerCase()] = attr.value;
		}
		const kids = Array.from(node.childNodes)
			.map(domToHast)
			.filter((x): x is ElementContent => x !== null);
		return {
			type: 'element',
			tagName: node.tagName.toLowerCase(),
			properties: props,
			children: kids,
		};
	}
	return null; // comment, doctype, etc.
}

function htmlToHast(value: string): ElementContent[] {
	// `DOMParser` is only available in a browser/webview runtime. In Node (our
	// unit-test runner) it is absent, so we no-op and leave `raw` untouched.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const DP = (globalThis as any).DOMParser;
	if (!DP) return [];
	const doc = new DP().parseFromString(value, 'text/html');
	const parsed = Array.from(doc.body.childNodes)
		.map(domToHast)
		.filter((x): x is ElementContent => x !== null);
	return sanitizeChildren(parsed);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function processRaw(nodes: any[]): any[] {
	const out: any[] = [];
	for (const node of nodes) {
		if (node && node.type === 'raw' && typeof node.value === 'string') {
			out.push(...htmlToHast(node.value));
		} else {
			if (node && node.type === 'element' && Array.isArray(node.children)) {
				node.children = processRaw(node.children);
			}
			out.push(node);
		}
	}
	return out;
}

export const rehypeRawSafe: Plugin<[], Root> = () => (tree: Root) => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tree.children = processRaw(tree.children as any[]) as any;
};
