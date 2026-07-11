/* Extract a heading outline (TOC) from markdown source, skipping frontmatter.
 * The `id` for each item uses the exact same slug + duplicate-suffix rule as
 * `rehypeSlug`, so TOC / wikilink `#anchor` targets resolve to the rendered
 * heading element instead of silently missing. */

import { slugify } from './rehypeSlug';

export interface IOutlineItem {
	level: number;
	text: string;
	id: string;
}

export function extractOutline(md: string): IOutlineItem[] {
	const items: IOutlineItem[] = [];
	const seen = new Map<string, number>();
	const fmMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
	const body = fmMatch ? md.slice(fmMatch[0].length) : md;
	for (const line of body.split(/\r?\n/)) {
		const m = /^(#{1,6})\s+(.*)$/.exec(line);
		if (!m) continue;
		const text = m[2].trim();
		const base = slugify(text) || 'section';
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		const id = count === 0 ? base : `${base}-${count}`;
		items.push({ level: m[1].length, text, id });
	}
	return items;
}

/**
 * Find the outline `id` for a `[[note#heading]]` target. Matches by case-folded
 * text or slug, returning the *first* occurrence when headings repeat. Returns
 * `undefined` when nothing matches (caller falls back to top of document).
 */
export function findHeadingId(outline: IOutlineItem[], heading: string): string | undefined {
	const target = heading.trim().toLowerCase();
	const targetSlug = slugify(heading);
	for (const item of outline) {
		if (item.text.trim().toLowerCase() === target || item.id === targetSlug) {
			return item.id;
		}
	}
	return undefined;
}
