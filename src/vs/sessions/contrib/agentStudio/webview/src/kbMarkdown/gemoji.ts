/* `:shortcode:` → emoji replacement (full gemoji dataset).
 *
 * Glyph uses the `remark-gemoji` package, which pulls the full gemoji dataset
 * (~1800 emoji). Offline we cannot install it at runtime, so the complete
 * shortcode→emoji map is baked into `gemojiData.ts` (generated once from the
 * official wooorm/gemoji dataset). Unmatched `:foo:` stays literal text.
 */

import { findAndReplace } from 'mdast-util-find-and-replace';
import type { Plugin } from 'unified';
import { GEMOJI } from './gemojiData';

const RE = /:([a-z0-9_+-]+):/g;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const remarkGemoji: Plugin = () => (tree: any) => {
	findAndReplace(tree, [
		[
			RE,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(_match: string, name: string) => {
				const e = GEMOJI[name];
				return e ? { type: 'text', value: e } : false;
			},
		],
	]);
};

export { remarkGemoji };
