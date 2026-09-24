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
import { isImageFile, isHtmlFile, diagramEmbedKindOf, type DiagramEmbedKind } from './markdownExtensions';
import { kbLog } from './kbDebug';
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

/**
 * 解析目标 → 「可用 uri + 是否断链」（★ 2026-09-24 诊断加固）。
 *
 * ⚠ 旧写法 `broken = resolved.uri === null` + `if (!broken && resolved.uri)` 写属性 ⇒ 当 uri 是
 *   **空串 / undefined** 时两者同时为假 ⇒ 节点上「既无 path 也无 broken」，组件侧表现为
 *   `broken=false, path=undefined` ⇒ 只显示「文件不可用或不在当前库内」，真因被完全掩盖
 *   （用户实测现象；根因是内核索引里 `uri: ''` 的合成条目按「最短优先」抢走了候选）。
 * 现在以「uri 是否非空」为**唯一判据** ⇒ path 与 broken 互补，结构上不可能同时缺失。
 *
 * 只在**可疑**失败时打点（真·目标不存在不打，避免正常断链刷屏）：
 *   · `rawUri` 非 null 但不合格（空串等）⇒ 清单被异常条目污染；
 *   · 清单为空 ⇒ workspaceFiles 没送达（推送竞态）。
 */
function resolveTarget(rawTarget: string, options: WikilinkPluginOptions, kind: string): { uri?: string; broken: boolean } {
	const files = options.workspaceFiles ?? [];
	const resolved = resolveWikilink(rawTarget, files, options.currentFilePath);
	const uri = typeof resolved.uri === 'string' && resolved.uri.length > 0 ? resolved.uri : undefined;
	if (!uri && (resolved.uri !== null || files.length === 0)) {
		kbLog(`resolve:${kind}`, `未取到可用 uri: target=${rawTarget} files=${files.length} rawUri=${JSON.stringify(resolved.uri)}`);
	}
	return { uri, broken: !uri };
}

function buildLinkNode(parsed: ParsedWikilink, options: WikilinkPluginOptions): LinkNode {
	const { uri, broken } = resolveTarget(parsed.rawTarget, options, 'wikilink');
	const display = parsed.alias ?? parsed.baseTarget;

	const hProperties: Record<string, string | string[]> = {
		className: broken ? ['wikilink', 'wikilink--broken'] : ['wikilink'],
		dataWikilink: parsed.baseTarget,
	};
	if (uri) hProperties.dataWikilinkPath = uri;
	else hProperties.dataWikilinkBroken = '';
	if (parsed.heading) hProperties.dataWikilinkHeading = parsed.heading;

	return {
		type: 'link',
		url: '#',
		title: null,
		children: [{ type: 'text', value: display }],
		data: { hName: 'a', hProperties },
	};
}

/**
 * `![[image.png]]`（Obsidian 图片 embed）→ mdast `image` 节点。
 * url 保留原始相对路径，由 MarkdownContent 的 ImgResolved 经 assetBaseUri 解析加载；
 * `|300` 形式的尺寸参数经 alt 透传（渲染层可选用）。
 */
function buildImageNode(parsed: ParsedWikilink): Node {
	const alt = parsed.alias ?? parsed.baseTarget.split('/').pop() ?? '';
	return {
		type: 'image',
		url: parsed.baseTarget,
		alt,
		data: { hName: 'img', hProperties: { className: ['kb-embed-image'] } },
	};
}

/**
 * `![[page.html]]`（活页面 embed）→ `<div class="kb-html-embed">` 占位节点。
 * 渲染层 HtmlEmbedComponent 向宿主请求 asWebviewUri 后用 sandbox iframe 加载（保留目标页
 * 自己的样式与脚本）。与笔记 embed（EmbedComponent，把目标当 markdown 重渲染）刻意分开。
 * `data.embed`/`embedParsed` 照旧带上 ⇒ Pass 2 的提升/降级逻辑对它一视同仁。
 */
function buildHtmlEmbedNode(parsed: ParsedWikilink, options: WikilinkPluginOptions): EmbedNode {
	const { uri, broken } = resolveTarget(parsed.rawTarget, options, 'html-embed');

	const hProperties: Record<string, string | string[]> = {
		className: ['kb-html-embed'],
		dataHtmlEmbedTarget: parsed.baseTarget,
	};
	if (uri) hProperties.dataHtmlEmbedPath = uri;
	else hProperties.dataHtmlEmbedBroken = '';

	return {
		type: 'htmlEmbed',
		children: [],
		data: { embed: true, embedParsed: parsed, hName: 'div', hProperties },
	};
}

/**
 * `![[x.drawio]]` / `![[x.mermaid]]` / `![[x.canvas]]`（图表文件 embed）→ 占位节点。
 * 渲染层 DiagramEmbedComponent 读目标文件内容后按 kind 渲染：
 * mermaid/drawio 经宿主渲染服务出 SVG，canvas 走内置只读迷你渲染器。
 * `data.embed`/`embedParsed` 照旧带上 ⇒ Pass 2 的提升/降级逻辑对它一视同仁。
 */
function buildDiagramEmbedNode(parsed: ParsedWikilink, kind: DiagramEmbedKind, options: WikilinkPluginOptions): EmbedNode {
	const { uri, broken } = resolveTarget(parsed.rawTarget, options, `diagram-embed(${kind})`);

	const hProperties: Record<string, string | string[]> = {
		className: ['kb-diagram-embed'],
		dataDiagramKind: kind,
		dataDiagramTarget: parsed.baseTarget,
	};
	if (uri) hProperties.dataDiagramPath = uri;
	else hProperties.dataDiagramBroken = '';

	return {
		type: 'diagramEmbed',
		children: [],
		data: { embed: true, embedParsed: parsed, hName: 'div', hProperties },
	};
}

function buildEmbedNode(parsed: ParsedWikilink, options: WikilinkPluginOptions): EmbedNode {
	const { uri, broken } = resolveTarget(parsed.rawTarget, options, 'note-embed');

	const hProperties: Record<string, string | string[]> = {
		className: ['markdown-embed'],
		dataEmbedTarget: parsed.baseTarget,
	};
	if (uri) hProperties.dataEmbedPath = uri;
	else hProperties.dataEmbedBroken = '';
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
				// `![[image.png]]` 图片 embed：渲染为 <img>（此前错误地降级为链接，图片永不显示）
				if (bang && isImageFile(parsed.baseTarget)) {
					replacement.push(buildImageNode(parsed));
				} else if (bang && isHtmlFile(parsed.baseTarget) && parentNode.type === 'paragraph') {
					// `![[page.html]]` 活页面 embed（2026-09-24）：sandbox iframe 加载本地 html
					replacement.push(buildHtmlEmbedNode(parsed, options));
				} else if (bang && parentNode.type === 'paragraph' && diagramEmbedKindOf(parsed.baseTarget)) {
					// `![[x.drawio|.mermaid|.mmd|.canvas]]` 图表文件 embed（2026-09-24）
					replacement.push(buildDiagramEmbedNode(parsed, diagramEmbedKindOf(parsed.baseTarget)!, options));
				} else if (bang && parentNode.type === 'paragraph') {
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
