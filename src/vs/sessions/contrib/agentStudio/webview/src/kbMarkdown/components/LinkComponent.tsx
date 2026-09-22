import { type ComponentPropsWithoutRef, useCallback } from 'react';
import { isOpenableRelativeHref } from '../relativePath';

export interface LinkComponentProps extends ComponentPropsWithoutRef<'a'> {
	onOpenWikilink?: (uri: string, heading?: string) => void;
	/** Open a relative markdown link resolved against the current note. */
	onOpenRelativeFile?: (href: string) => void;
	/** Open an external (http/mailto) URL via the host. */
	onOpenExternal?: (url: string) => void;
}

export function LinkComponent(props: LinkComponentProps): React.ReactElement {
	const { href, children, onOpenWikilink, onOpenRelativeFile, onOpenExternal, node: _node, ...rest } =
		props as LinkComponentProps & { node?: unknown };

	const restAny = rest as Record<string, unknown>;
	const wikilinkTarget = restAny['data-wikilink'];
	const isWikilink = typeof wikilinkTarget === 'string';
	const wikilinkPath = restAny['data-wikilink-path'] as string | undefined;
	const wikilinkHeading = restAny['data-wikilink-heading'] as string | undefined;
	const wikilinkBroken = 'data-wikilink-broken' in restAny;

	const handleClick = useCallback(
		async (e: React.MouseEvent<HTMLAnchorElement>) => {
			if (isWikilink) {
				e.preventDefault();
				if (wikilinkBroken || !wikilinkPath) {
					// ★ 2026-09-22：此前这里是**裸 return** ⇒ 点击完全静默（无跳转、无提示、无日志），
					// 用户只能感知「点了没反应」，无从判断原因（索引未就绪？文件被删？）。
					// 断链是**数据问题**而非交互问题，至少要留下可见线索。
					// eslint-disable-next-line no-console
					console.warn(`[wikilink] 未能解析「${String(wikilinkTarget ?? '')}」——`
						+ '可能知识库索引尚未就绪，或目标笔记已删除/改名。');
					return;
				}
				onOpenWikilink?.(wikilinkPath, wikilinkHeading);
				return;
			}
			if (!href) return;
			if (href.startsWith('#')) {
				e.preventDefault();
				const id = decodeURIComponent(href.slice(1));
				if (id) document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
				return;
			}
			if (onOpenRelativeFile && isOpenableRelativeHref(href)) {
				e.preventDefault();
				onOpenRelativeFile(href);
				return;
			}
			e.preventDefault();
			onOpenExternal?.(href);
		},
		[href, isWikilink, wikilinkBroken, wikilinkPath, wikilinkHeading, onOpenWikilink, onOpenRelativeFile, onOpenExternal],
	);

	if (isWikilink) {
		return (
			// Wikilinks resolve to in-app file URIs, not URLs — navigation routes through onClick by design.
			<a
				href="#"
				onClick={handleClick}
				aria-disabled={wikilinkBroken ? true : undefined}
				{...rest}
				// ★ 2026-09-22：断链补一条 hover 提示（此前无任何 UI 反馈）
				title={wikilinkBroken
					? `未找到笔记「${String(wikilinkTarget ?? '')}」：可能索引尚未就绪，或目标已删除/改名`
					: (rest as { title?: string }).title}
			>
				{children}
			</a>
		);
	}

	const isExternal =
		!!href &&
		(href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:'));
	return (
		<a href={href ?? '#'} onClick={handleClick} {...rest}>
			{children}
			{isExternal && (
				<span className="kb-ext-link" aria-hidden>
					{' ↗'}
				</span>
			)}
		</a>
	);
}
