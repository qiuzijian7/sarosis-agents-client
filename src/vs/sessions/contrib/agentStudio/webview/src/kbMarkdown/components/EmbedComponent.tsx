/* Renders a note embed (`![[note]]`). The remarkWikilink plugin emits a `<div
 * class="markdown-embed" data-embed-target=… data-embed-path=…>` placeholder;
 * this component fetches the target's markdown from the host and re-renders it
 * through `MarkdownContent`, extending the embed chain for cycle detection. */

import { useEffect, useState } from 'react';
import { useEmbedContext } from '../EmbedContext';
import { requestNoteContent } from '../embedBridge';
import { MarkdownContent } from '../MarkdownContent';
import { extractHeadingSection } from '../headingSection';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function EmbedComponent(props: any): React.ReactElement {
	const target = props['data-embed-target'] as string | undefined;
	const path = props['data-embed-path'] as string | undefined;
	const heading = props['data-embed-heading'] as string | undefined;
	const broken = 'data-embed-broken' in props;
	const ctx = useEmbedContext();
	const [content, setContent] = useState<string | null>(null);
	const [error, setError] = useState(false);

	useEffect(() => {
		if (broken || !path) {
			setError(true);
			return;
		}
		if (ctx.chain.includes(path)) {
			// Cycle: this file is already being rendered up the embed chain.
			setError(true);
			return;
		}
		let alive = true;
		requestNoteContent(path, heading)
			.then((md) => {
				if (!alive) return;
				if (!md) {
					setError(true);
					return;
				}
				// `![[note#heading]]` — slice to the section under `heading`.
				// Falls back to the whole note when the heading isn't found so
				// the embed still renders instead of going blank.
				const sliced = heading ? extractHeadingSection(md, heading) || md : md;
				setContent(sliced);
			})
			.catch(() => {
				if (alive) setError(true);
			});
		return () => {
			alive = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [path, heading, broken]);

	if (error || !path) {
		return (
			<div className="markdown-embed markdown-embed--broken">
				⚠ 无法嵌入笔记：{target}
				{broken ? '（链接无效）' : ''}
			</div>
		);
	}
	if (content === null) {
		return <div className="markdown-embed markdown-embed--loading">嵌入中…</div>;
	}
	return (
		<div className="markdown-embed">
			<MarkdownContent
				content={content}
				filePath={path}
				workspaceFiles={ctx.workspaceFiles}
				onOpenWikilink={ctx.onOpenWikilink}
			/>
		</div>
	);
}
