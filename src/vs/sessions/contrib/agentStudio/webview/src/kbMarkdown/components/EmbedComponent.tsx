/* Renders a note embed (`![[note]]`). The remarkWikilink plugin emits a `<div
 * class="markdown-embed" data-embed-target=… data-embed-path=…>` placeholder;
 * this component fetches the target's markdown from the host and re-renders it
 * through `MarkdownContent`, extending the embed chain for cycle detection. */

import { useEffect, useState } from 'react';
import { kbLog } from '../kbDebug';
import { useEmbedContext } from '../EmbedContext';
import { requestNoteContentDetailed } from '../embedBridge';
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
	const [reason, setReason] = useState('');

	useEffect(() => {
		if (broken) {
			setError(true);
			return;
		}
		// ★★ 2026-09-24：`broken=false` 且无 path ⇒ **瞬时态**（宿主的名清单未到，首帧必然如此），
		//   保持 loading 并把失败清零 —— 旧代码把它当永久失败且成功后不清零 ⇒ 内容读到了仍报错。
		if (!path) {
			setError(false); setReason(''); setContent(null);
			return;
		}
		if (ctx.chain.includes(path)) {
			// Cycle: this file is already being rendered up the embed chain.
			setError(true);
			return;
		}
		let alive = true;
		setError(false); setReason(''); setContent(null);
		requestNoteContentDetailed(path, heading)
			.then((r) => {
				if (!alive) return;
				const md = r.markdown;
				if (!md) {
					kbLog('note-embed', `内容为空: path=${path} error=${r.error ?? '(无)'}`);
					setReason(r.error ?? '内容为空');
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

	if (error) {
		return (
			<div className="markdown-embed markdown-embed--broken">
				⚠ 无法嵌入笔记：{target}
				{broken ? '（链接无效）' : (reason ? `（${reason}）` : '')}
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
