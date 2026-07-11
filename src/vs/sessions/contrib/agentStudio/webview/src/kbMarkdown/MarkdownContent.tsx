/* The markdown rendering core: frontmatter block + react-markdown wired with the
 * full plugin/component set (GFM, math, alerts, gemoji, wikilinks, syntax
 * highlighting, sanitized-by-default output). This is the single source of
 * truth for KB note text rendering, replacing the old BlockSuite/AFFiNE editor.
 */

import React, { useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import katex from 'katex';
import { buildRemarkPlugins, buildRehypePlugins } from './pipeline';
import { parseFrontmatter } from './frontmatter';
import { EmbedProvider, useEmbedContext } from './EmbedContext';
import { LinkComponent } from './components/LinkComponent';
import { ImageComponent } from './components/ImageComponent';
import { CodeBlockComponent } from './components/CodeBlockComponent';
import { EmbedComponent } from './components/EmbedComponent';
import { MarkdownHeading } from './components/MarkdownHeading';
import { TaskListItem } from './components/TaskListItem';
import { TaskCheckbox } from './components/TaskCheckbox';
import { AlertBlock } from './components/AlertBlock';
import { FrontmatterBlock } from './components/FrontmatterBlock';
import type { WorkspaceFile } from './types';

export interface MarkdownContentProps {
	content: string;
	filePath?: string;
	workspaceFiles?: WorkspaceFile[];
	onOpenWikilink?: (uri: string, heading?: string) => void;
	/** Open a relative markdown link resolved against the current note (host resolves). */
	onOpenRelativeFile?: (href: string) => void;
	/** Open an external URL via the host. */
	onOpenExternal?: (url: string) => void;
	/** Toggle a GFM task checkbox at the given absolute (1-based) source line. */
	onToggleTask?: (line: number) => void;
	showFrontmatter?: boolean;
}

// Block-level routing for `<div>`: an embed placeholder → EmbedComponent, a
// KaTeX block → rendered math, everything else → plain div.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DivComponent(props: any): React.ReactElement {
	const { node: _node, ...rest } = props;
	if ('data-embed-target' in rest) {
		return <EmbedComponent {...rest} />;
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const cls = (rest as any).className || '';
	if (typeof cls === 'string' && cls.includes('katex-block')) {
		const tex = (rest as any)['data-tex'] as string;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const onMouse: any = undefined;
		return (
			<div
				className="katex-block"
				dangerouslySetInnerHTML={{ __html: renderKatex(tex, true) }}
				{...{ onMouse }}
			/>
		);
	}
	return <div {...rest} />;
}

// Inline routing for `<span>`: KaTeX inline math only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function SpanComponent(props: any): React.ReactElement {
	const { node: _node, ...rest } = props;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const cls = (rest as any).className || '';
	if (typeof cls === 'string' && cls.includes('katex-inline')) {
		const tex = (rest as any)['data-tex'] as string;
		return (
			<span className="katex-inline" dangerouslySetInnerHTML={{ __html: renderKatex(tex, false) }} />
		);
	}
	return <span {...rest} />;
}

function renderKatex(tex: string, displayMode: boolean): string {
	try {
		return katex.renderToString(tex ?? '', { displayMode, throwOnError: false, output: 'html' });
	} catch {
		return tex ?? '';
	}
}

/** Block dangerous URL schemes that react-markdown's default urlTransform might
 * still let through when authored in markdown. */
function safeUrl(url: string): string {
	if (/^(javascript|vbscript|file):/i.test(url)) return '#';
	if (/^data:/i.test(url) && !/^data:image\//i.test(url)) return '#';
	return url;
}

export function MarkdownContent(props: MarkdownContentProps): React.ReactElement {
	const {
		content,
		filePath,
		workspaceFiles = [],
		onOpenWikilink,
		onOpenRelativeFile,
		onOpenExternal,
		onToggleTask,
		showFrontmatter = true,
	} = props;

	const frontmatter = useMemo(
		() => (showFrontmatter ? parseFrontmatter(content) : null),
		[content, showFrontmatter],
	);
	const body = frontmatter ? frontmatter.body : content;

	// Task line numbers stamped by `remarkTaskLines` are relative to `body`;
	// add the frontmatter offset so they become absolute within the full note
	// (the host flips the corresponding line in the original `.md`).
	const fmLineOffset = frontmatter
		? content.slice(0, content.length - body.length).split('\n').length - 1
		: 0;

	const parentEmbed = useEmbedContext();
	const embedValue = useMemo(() => {
		const base = parentEmbed.chain;
		const chain = filePath && !base.includes(filePath) ? [...base, filePath] : base;
		return { workspaceFiles, onOpenWikilink, chain };
	}, [parentEmbed.chain, filePath, workspaceFiles, onOpenWikilink]);

	const remarkPlugins = useMemo(
		() => buildRemarkPlugins({ workspaceFiles, filePath }),
		[workspaceFiles, filePath],
	);
	const rehypePlugins = useMemo(() => buildRehypePlugins(), []);

	const handleOpenRelativeFile = useCallback(
		(href: string) => {
			onOpenRelativeFile?.(href);
		},
		[onOpenRelativeFile],
	);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const LinkWithWikilink = useCallback(
		(p: any) => (
			<LinkComponent
				{...p}
				onOpenWikilink={onOpenWikilink}
				onOpenRelativeFile={onOpenRelativeFile ? handleOpenRelativeFile : undefined}
				onOpenExternal={onOpenExternal}
			/>
		),
		[onOpenWikilink, handleOpenRelativeFile, onOpenRelativeFile, onOpenExternal],
	);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const TaskListLi = useCallback(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(p: any) => <TaskListItem {...p} fmLineOffset={fmLineOffset} />,
		[fmLineOffset],
	);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const TaskCheckboxComp = useCallback(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(p: any) => <TaskCheckbox {...p} onToggleTask={onToggleTask} />,
		[onToggleTask],
	);

	return (
		<EmbedProvider value={embedValue}>
			{frontmatter && <FrontmatterBlock data={frontmatter} />}
		<ReactMarkdown
			remarkPlugins={remarkPlugins}
			rehypePlugins={rehypePlugins}
			urlTransform={safeUrl}
			// Keep raw HTML in the tree as `raw` nodes (default), so our
			// `rehypeRawSafe` plugin — not an unsafe auto-parse — handles them.
			remarkRehypeOptions={{ allowDangerousHtml: false }}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				components={{
					a: LinkWithWikilink,
					img: ImageComponent,
					pre: CodeBlockComponent,
					li: TaskListLi,
					input: TaskCheckboxComp,
					div: DivComponent,
					span: SpanComponent,
					blockquote: AlertBlock,
				h1: (p: any) => <MarkdownHeading tag="h1" {...p} />,
				h2: (p: any) => <MarkdownHeading tag="h2" {...p} />,
				h3: (p: any) => <MarkdownHeading tag="h3" {...p} />,
				h4: (p: any) => <MarkdownHeading tag="h4" {...p} />,
				h5: (p: any) => <MarkdownHeading tag="h5" {...p} />,
				h6: (p: any) => <MarkdownHeading tag="h6" {...p} />,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any}
			>
				{body}
			</ReactMarkdown>
		</EmbedProvider>
	);
}
