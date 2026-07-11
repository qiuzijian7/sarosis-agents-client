import { type ComponentPropsWithoutRef } from 'react';

export interface TaskListItemProps extends ComponentPropsWithoutRef<'li'> {
	/** Frontmatter line offset so the stamped `data-task-line` is absolute. */
	fmLineOffset?: number;
}

export function TaskListItem(props: TaskListItemProps): React.ReactElement {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { node: _node, fmLineOffset = 0, children, ...rest } = props as any;
	// `data-task-line` (relative to body) was stamped by `remarkTaskLines`; make
	// it absolute within the full note so the host flips the right line.
	const relLine = rest['data-task-line'];
	const absLine = typeof relLine === 'number' ? relLine + fmLineOffset : undefined;
	const cls = ['kb-task-item', rest.className].filter(Boolean).join(' ');
	return (
		<li
			{...rest}
			className={cls}
			{...(absLine != null ? { 'data-task-line': absLine } : {})}
		>
			{children}
		</li>
	);
}
