import { type ComponentPropsWithoutRef } from 'react';

const TITLES: Record<string, string> = {
	note: 'Note',
	tip: 'Tip',
	important: 'Important',
	warning: 'Warning',
	caution: 'Caution',
};

export function AlertBlock(props: ComponentPropsWithoutRef<'blockquote'>): React.ReactElement {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { node: _node, children, ...rest } = props as any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const className: string = (rest as any).className || '';
	const isAlert = /(^|\s)markdown-alert(\s|$)/.test(className);
	if (!isAlert) return <blockquote {...rest}>{children}</blockquote>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const type = ((rest as any)['data-alert-type'] as string) || 'note';
	const title = TITLES[type] ?? type;
	return (
		<div className={className} role="alert">
			<div className="markdown-alert-title">{title}</div>
			<div className="markdown-alert-body">{children}</div>
		</div>
	);
}
