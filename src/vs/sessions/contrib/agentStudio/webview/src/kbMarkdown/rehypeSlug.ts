/* Custom `rehype-slug` replacement (the published `rehype-slug` package is not
 * installed offline). Adds a stable, unique `id` to every heading so in-document
 * anchor links (`#heading`) and the table-of-contents scrolling work. */

import { visit } from 'unist-util-visit';

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w一-龥\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

export function rehypeSlug(): (tree: unknown) => void {
	return (tree: unknown) => {
		const seen = new Map<string, number>();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		visit(tree as any, 'element', (node: any) => {
			if (!/^h[1-6]$/.test(node.tagName)) return;
			const text = toText(node);
			if (!text) return;
			let base = slugify(text) || 'section';
			const count = seen.get(base) ?? 0;
			seen.set(base, count + 1);
			const id = count === 0 ? base : `${base}-${count}`;
			node.properties = node.properties ?? {};
			node.properties.id = id;
		});
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toText(node: any): string {
	if (node.type === 'text') return node.value ?? '';
	if (!node.children) return '';
	return node.children.map(toText).join('');
}
