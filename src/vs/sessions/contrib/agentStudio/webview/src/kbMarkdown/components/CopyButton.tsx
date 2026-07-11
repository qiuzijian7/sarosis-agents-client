import { useState } from 'react';

export function CopyButton({ text }: { text: string }): React.ReactElement {
	const [copied, setCopied] = useState(false);
	return (
		<button
			className="kb-copy-btn"
			onClick={() => {
				navigator.clipboard
					?.writeText(text)
					.then(() => {
						setCopied(true);
						window.setTimeout(() => setCopied(false), 1200);
					})
					.catch(() => undefined);
			}}
		>
			{copied ? '已复制' : '复制'}
		</button>
	);
}
