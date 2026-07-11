/* GitHub-style blockquote alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
 * `[!WARNING]`, `[!CAUTION]`).
 *
 * Ported behavior from `remark-github-blockquote-alert` (not installed offline).
 * A remark plugin detects an alert marker on the first paragraph of a blockquote,
 * strips the marker text, and tags the node with `markdown-alert` /
 * `markdown-alert-<type>` classes; the `blockquote` component override
 * (`AlertBlock`) renders the styled box. */

import { visit } from 'unist-util-visit';

const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;

export function remarkAlert(): (tree: unknown) => void {
	return (tree: unknown) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		visit(tree as any, 'blockquote', (node: any) => {
			const first = node.children?.[0];
			if (!first || first.type !== 'paragraph') return;
			const text = first.children?.[0];
			if (!text || text.type !== 'text') return;
			const m = ALERT_RE.exec(text.value);
			if (!m) return;
			const type = m[1].toLowerCase();
			text.value = text.value.slice(m[0].length);
			// Drop a now-empty leading text node so we don't render a blank line.
			if (text.value === '') first.children.shift();
			node.data = node.data ?? {};
			node.data.hName = 'blockquote';
			node.data.hProperties = {
				className: ['markdown-alert', `markdown-alert-${type}`],
				'data-alert-type': type,
			};
		});
	};
}
