import { useCallback, type ReactElement, type ElementType } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function MarkdownHeading({ tag, ...props }: { tag: string } & Record<string, any>): ReactElement {
	const { id, children, node: _node, ...rest } = props;
	const onClick = useCallback(
		(e: React.MouseEvent<HTMLAnchorElement>) => {
			if (id) {
				e.preventDefault();
				document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
			}
		},
		[id],
	);
	const El = tag as ElementType;
	return (
		<El id={id} {...rest}>
			{id && (
				<a className="kb-heading-anchor" href={`#${id}`} onClick={onClick}>
					#
				</a>
			)}
			{children}
		</El>
	);
}
