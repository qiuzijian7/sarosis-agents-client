/* The markdown remark/rehype pipeline, assembled outside the render tree so the
 * plugin order lives in one documented place (ported from Glyph's
 * `src/lib/markdown/pipeline.ts`).
 *
 * Adapted for the offline workspace: instead of `rehype-katex` +
 * `remark-frontmatter` (not installed), we:
 *  - strip YAML frontmatter in `MarkdownContent` before parsing (see frontmatter.ts)
 *  - render math via `remarkMathToKatex` + KaTeX in the React layer
 *  - add heading `id`s via a hand-written `rehypeSlug`
 *  - GitHub-style alerts via the `blockquote` component override (no plugin)
 *  - gemoji via a curated local map
 *  - raw HTML via a hand-written `rehypeRawSafe` (offline stand-in for
 *    `rehype-raw` + `rehype-sanitize`): it parses `<...>` blocks left as `raw`
 *    nodes into real hast and sanitises them through a strict allowlist.
 *
 * react-markdown v9 leaves raw HTML as `raw` nodes unless `rehype-raw` is
 * present (so by default no `javascript:`/script injection renders); our
 * `rehypeRawSafe` opts in *safely* with an allowlist. `urlTransform` (set in
 * MarkdownContent) additionally guards link/image protocols.
 */

import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { remarkWikilink } from './wikilink';
import { remarkGemoji } from './gemoji';
import { remarkMathToKatex } from './remarkMathToKatex';
import { remarkAlert } from './remarkAlert';
import { remarkTaskLines } from './remarkTaskLines';
import { rehypeSlug } from './rehypeSlug';
import { rehypeRawSafe } from './rehypeRawSafe';
import type { WorkspaceFile } from './types';

export interface MarkdownFeatures {
	gfm?: boolean;
	math?: boolean;
	emoji?: boolean;
	wikilinks?: boolean;
	alerts?: boolean;
	rawHtml?: boolean;
}

export interface RemarkPipelineOptions {
	workspaceFiles?: WorkspaceFile[];
	filePath?: string;
	features?: Partial<MarkdownFeatures>;
}

export function buildRemarkPlugins({
	workspaceFiles,
	filePath,
	features = {},
}: RemarkPipelineOptions): PluggableList {
	const plugins: PluggableList = [];
	if (features.gfm !== false) plugins.push(remarkGfm);
	if (features.math !== false) plugins.push(remarkMath, remarkMathToKatex);
	if (features.emoji !== false) plugins.push(remarkGemoji);
	if (features.alerts !== false) plugins.push(remarkAlert);
	// Annotate GFM task-list items with their source line so checkboxes can
	// round-trip back to the `.md` (Glyph's `onTaskToggle(line)` equivalent).
	plugins.push(remarkTaskLines);
	if (features.wikilinks !== false) {
		plugins.push([remarkWikilink, { workspaceFiles, currentFilePath: filePath }]);
	}
	return plugins;
}

export function buildRehypePlugins(features: Partial<MarkdownFeatures> = {}): PluggableList {
	const plugins: PluggableList = [rehypeSlug];
	// Raw HTML support (offline stand-in for `rehype-raw` + `rehype-sanitize`).
	// `rehypeRawSafe` parses `<...>` left as `raw` hast nodes into real elements
	// and sanitises them through a strict allowlist. On by default.
	if (features.rawHtml !== false) plugins.push(rehypeRawSafe);
	return plugins;
}
