/* Convert remark-math `math` / `inlineMath` mdast nodes into hast elements that
 * carry the raw TeX in a `data-tex` attribute. The actual KaTeX rendering is done
 * in the React layer (`MarkdownContent`'s `div`/`span` overrides) via
 * `katex.renderToString` + `dangerouslySetInnerHTML`, which keeps inline styles
 * intact without needing `rehype-raw` + `rehype-sanitize` (both unavailable
 * offline). This is a deliberate, self-contained substitute for `rehype-katex`.
 */

import { visit } from 'unist-util-visit';

export function remarkMathToKatex(): (tree: unknown) => void {
	return (tree: unknown) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		visit(tree as any, (node: any) => {
			if (node.type === 'math') {
				node.data = {
					hName: 'div',
					hProperties: { className: ['katex-block'], 'data-tex': node.value ?? '' },
				};
			} else if (node.type === 'inlineMath') {
				node.data = {
					hName: 'span',
					hProperties: { className: ['katex-inline'], 'data-tex': node.value ?? '' },
				};
			}
		});
	};
}
