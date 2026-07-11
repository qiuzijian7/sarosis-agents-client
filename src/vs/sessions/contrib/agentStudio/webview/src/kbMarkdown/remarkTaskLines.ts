/* Annotates each GFM task-list item (`- [ ]` / `- [x]`) with its source line
 * number, so the rendered checkbox can round-trip back to the original `.md`.
 *
 * Glyph does the same via `onTaskToggle(line)`: the host rewrites the single
 * line. We replicate it offline (zero extra deps) by walking the mdast and
 * stamping `data-task-line` (1-based line within the parsed body) onto each
 * checked `listItem`'s hast properties. `MarkdownContent` later adds the
 * frontmatter offset so the number is absolute within the full note.
 */

import type { Plugin } from 'unified';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walk(node: any): void {
	if (!node || typeof node !== 'object') return;
	if (node.type === 'listItem' && node.checked !== null && node.checked !== undefined) {
		const line = node.position?.start?.line;
		if (typeof line === 'number') {
			node.data = node.data || {};
			node.data.hProperties = {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				...(node.data.hProperties as any),
				'data-task-line': line,
			};
		}
	}
	if (Array.isArray(node.children)) {
		for (const child of node.children) walk(child);
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const remarkTaskLines: Plugin<[], any> = () => (tree) => {
	walk(tree);
};
