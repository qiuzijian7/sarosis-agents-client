import { type ComponentPropsWithoutRef } from 'react';

export interface TaskCheckboxProps extends ComponentPropsWithoutRef<'input'> {
	/** Called with the absolute (1-based) source line of the owning task item. */
	onToggleTask?: (line: number) => void;
}

/* A GFM task-list checkbox that round-trips back to the source `.md`.
 *
 * The owning `<li>` carries `data-task-line` (absolute 1-based line). We render
 * the checkbox as interactive (never disabled): clicking it asks the host to
 * flip `[ ]` ↔ `[x]` on that line, and the re-render from the saved markdown is
 * the single source of truth for the visual state. We `preventDefault` so the
 * browser doesn't also toggle the box — the markdown rewrite does that.
 */
export function TaskCheckbox(props: TaskCheckboxProps): React.ReactElement {
	const { type, onToggleTask, ...rest } = props;
	if (type !== 'checkbox' || !onToggleTask) {
		// Non-task checkbox, or a read-only embed (no `onToggleTask`): render as-is,
		// keeping GFM's native `disabled` state so it can't be toggled.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return <input type={type} {...(rest as any)} />;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const handleClick = (e: React.MouseEvent<HTMLInputElement>) => {
		if (!onToggleTask) return;
		const li = e.currentTarget.closest('li');
		const lineStr = li?.getAttribute('data-task-line');
		if (lineStr == null) return;
		e.preventDefault();
		onToggleTask(parseInt(lineStr, 10));
	};

	// Drop `disabled` (GFM marks task boxes disabled) and `checked`'s
	// uncontrolled warning by letting React treat `checked` as the value.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { disabled: _disabled, ...safeRest } = rest as any;
	return (
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		<input
			type="checkbox"
			{...safeRest}
			onClick={handleClick}
		/>
	);
}
