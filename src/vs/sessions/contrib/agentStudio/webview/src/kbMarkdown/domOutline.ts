/* Build the heading outline (TOC) by reading the *rendered* DOM instead of the
 * raw markdown source.
 *
 * Why this exists: `outline.extractOutline` slugifies the **raw** source text of
 * each heading (`# :wave: Hello` → `wave-hello`), while `rehypeSlug` slugifies the
 * **rendered** heading text (`👋 Hello` → `hello`) and assigns that as the element
 * `id`. When a heading contains gemoji (`:wave:`), inline code (`` `x` ``), or links
 * (`[t](u)`), the two slugs diverge, so clicking a TOC entry calls
 * `getElementById('wave-hello')` and silently misses the heading.
 *
 * Reading the `id` directly off the rendered `<h1>…<h6>` elements guarantees the
 * TOC ids are byte-identical to what the browser actually anchors to — exactly
 * how Glyph stays consistent (single github-slugger over rendered text).
 *
 * `outline.ts` is kept as a DOM-free pure function for offline tests / fallback. */

import type { IOutlineItem } from './outline';

export function collectDomOutline(root: ParentNode | null): IOutlineItem[] {
	if (!root) return [];
	const nodes = root.querySelectorAll('h1,h2,h3,h4,h5,h6');
	const items: IOutlineItem[] = [];
	nodes.forEach((node) => {
		const id = node.id;
		// Skip headings that `rehypeSlug` did not tag (e.g. empty titles).
		if (!id) return;
		const tag = (node.tagName || 'H1').toUpperCase();
		const level = Number(tag.slice(1)) || 1;
		items.push({ level, text: node.textContent ?? '', id });
	});
	return items;
}
