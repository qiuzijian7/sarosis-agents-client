/* A small remark plugin that turns `[[name]]`, `[[name|alias]]`, and
 * `[[name#heading]]` text into clickable links, and `![[name]]` /
 * `![[name#heading]]` into inline note embeds, resolved against the active vault.
 *
 * Ported from Glyph's `src/lib/wikilink.ts`. The resolved target is the note's
 * absolute `file://` URI (carried in `data-wikilink-path` / `data-embed-path`),
 * which the webview posts to the host via `kbblocks.openDoc`.
 *
 * Embeds are block-level, but the scan runs on text inside a paragraph, so a
 * second pass hoists a paragraph whose only content is embeds up to block level
 * and drops the wrapping `<p>`; an embed sharing its paragraph with other text
 * falls back to a plain (navigable) wikilink.
 */

import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { isImageFile } from './markdownExtensions';
import { resolveWikilink } from './wikilinkResolver';
import type { WorkspaceFile } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Node {
	type: string;
	data?: { embed?: boolean; embedParsed?: ParsedWikilink; [key: string]: unknown };
	[key: string]: unknown;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Parent extends Node {
	children: Node[];
}

const WIKILINK_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;

export interface WikilinkPluginOptions {
	workspaceFiles?: WorkspaceFile[];
	currentFilePath?: string;
}

interface ParsedWikilink {
	rawTarget: string;
	baseTarget: string;
	heading?: string;
	alias?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface TextNode extends Node {
	type: 'text';
	value: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface LinkNode extends Node {
	type: 'link';
	url: string;
	title?: null;
	children: TextNode[];
	data: {
		hName: 'a';
		hProperties: Record<string, string | string[]>;
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface EmbedNode extends Node {
	type: 'embed';
	children: [];
	data: {
		embed: true;
		embedParsed: ParsedWikilink;
		hName: 'div';
		hProperties: Record<string, string | string[]>;
	};
}

function parseInner(raw: string): ParsedWikilink {
	const pipe = raw.indexOf('|');
	const targetWithHeading = (pipe >= 0 ? raw.slice(0, pipe) : raw).trim();
	const alias = pipe >= 0 ? raw.slice(pipe + 1).trim() : '';
	const hash = targetWithHeading.indexOf('#');
	const baseTarget = hash >= 0 ? targetWithHeading.slice(0, hash) : targetWithHeading;
	const heading = hash >= 0 ? targetWithHeading.slice(hash + 1).trim() : '';
	return {
		rawTarget: targetWithHeading,
		baseTarget: baseTarget.trim(),
		heading: heading || undefined,
		alias: alias || undefined,
	};
}

function buildLinkNode(parsed: ParsedWikilink, options: WikilinkPluginOptions): LinkNode {
	const resolved = resolveWikilink(parsed.rawTarget, options.workspaceFiles ?? [], options.currentFilePath);
	const broken = resolved.uri === null;
	const display = parsed.alias ?? parsed.baseTarget;

	const hProperties: Record<string, string | string[]> = {
		className: broken ? ['wikilink', 'wikilink--broken'] : ['wikilink'],
		dataWikilink: parsed.baseTarget,
	};
	if (!broken && resolved.uri) hProperties.dataWikilinkPath = resolved.uri;
	if (broken) hProperties.dataWikilinkBroken = '';
	if (parsed.heading) hProperties.dataWikilinkHeading = parsed.heading;

	return {
		type: 'link',
		url: '#',
		title: null,
		children: [{ type: 'text', value: display }],
		data: { hName: 'a', hProperties },
	};
}

function buildEmbedNode(parsed: ParsedWikilink, options: WikilinkPluginOptions): EmbedNode {
	const resolved = resolveWikilink(parsed.rawTarget, options.workspaceFiles ?? [], options.currentFilePath);
	const broken = resolved.uri === null;

	const hProperties: Record<string, string | string[]> = {
		className: ['markdown-embed'],
		dataEmbedTarget: parsed.baseTarget,
	};
	if (!broken && resolved.uri) hProperties.dataEmbedPath = resolved.uri;
	if (broken) hProperties.dataEmbedBroken = '';
	if (parsed.heading) hProperties.dataEmbedHeading = parsed.heading;

	return {
		type: 'embed',
		children: [],
		data: { embed: true, embedParsed: parsed, hName: 'div', hProperties },
	};
}

const remarkWikilink: Plugin<[WikilinkPluginOptions?]> =
	(options = {}) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(tree: any) => {
		// Pass 1: replace `[[...]]` / `![[...]]` inside text nodes.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		visit(tree, 'text', (node: TextNode, index: number | undefined, parent: Parent | undefined) => {
			const parentNode = parent as Parent;
			const at = index as number;
			if (
				parentNode.type === 'inlineCode' ||
				parentNode.type === 'code' ||
				parentNode.type === 'link'
			) {
				return;
			}

			const value = node.value;
			WIKILINK_RE.lastIndex = 0;
			if (!WIKILINK_RE.test(value)) return;

			WIKILINK_RE.lastIndex = 0;
			const replacement: Node[] = [];
			let cursor = 0;
			let match: RegExpExecArray | null = WIKILINK_RE.exec(value);
			while (match !== null) {
				const [whole, bang, inner] = match;
				if (match.index > cursor) {
					replacement.push({ type: 'text', value: value.slice(cursor, match.index) } as TextNode);
				}
				const parsed = parseInner(inner);
				if (bang && !isImageFile(parsed.baseTarget) && parentNode.type === 'paragraph') {
					replacement.push(buildEmbedNode(parsed, options));
				} else {
					if (bang) replacement.push({ type: 'text', value: '!' } as TextNode);
					replacement.push(buildLinkNode(parsed, options));
				}
				cursor = match.index + whole.length;
				match = WIKILINK_RE.exec(value);
			}
			if (cursor < value.length) {
				replacement.push({ type: 'text', value: value.slice(cursor) } as TextNode);
			}

			parentNode.children.splice(at, 1, ...replacement);
			return at + replacement.length;
		});

		// Pass 2: normalize embeds sitting inside a paragraph.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		visit(tree, 'paragraph', (node: Parent, index: number | undefined, parent: Parent | undefined) => {
			const embeds = node.children.filter((c) => c.data?.embed);
			if (embeds.length === 0) return;

			const standalone = node.children.every(
				(c) => c.data?.embed || (c.type === 'text' && (c.value as string).trim() === ''),
			);

			if (standalone) {
				const parentNode = parent as Parent;
				const at = index as number;
				parentNode.children.splice(at, 1, ...embeds);
				return at + embeds.length;
			}

			node.children = node.children.map((c) =>
				c.data?.embed ? buildLinkNode(c.data.embedParsed as ParsedWikilink, options) : c,
			);
		});
	};

export { remarkWikilink };
