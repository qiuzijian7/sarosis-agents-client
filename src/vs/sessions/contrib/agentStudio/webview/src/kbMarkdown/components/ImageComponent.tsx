import { useState, type ComponentPropsWithoutRef } from 'react';

export function ImageComponent(props: ComponentPropsWithoutRef<'img'>): React.ReactElement {
	const { node: _node, ...rest } = props as ComponentPropsWithoutRef<'img'> & { node?: unknown };
	const [open, setOpen] = useState(false);
	const src = rest.src as string | undefined;

	return (
		<>
			<img
				{...rest}
				style={{ cursor: 'zoom-in', maxWidth: '100%', ...(rest.style || {}) }}
				onClick={() => setOpen(true)}
			/>
			{open && (
				<div className="kb-lightbox" onClick={() => setOpen(false)}>
					{src && <img src={src} alt={rest.alt} className="kb-lightbox-img" />}
				</div>
			)}
		</>
	);
}
