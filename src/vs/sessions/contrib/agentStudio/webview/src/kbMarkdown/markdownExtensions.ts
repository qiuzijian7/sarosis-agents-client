/* File-extension predicates used by the markdown layer. */

export function isMarkdownFile(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.endsWith('.md') || lower.endsWith('.markdown');
}

export function isImageFile(path: string): boolean {
	const lower = path.toLowerCase();
	return (
		lower.endsWith('.png') ||
		lower.endsWith('.jpg') ||
		lower.endsWith('.jpeg') ||
		lower.endsWith('.gif') ||
		lower.endsWith('.webp') ||
		lower.endsWith('.svg') ||
		lower.endsWith('.bmp') ||
		lower.endsWith('.avif')
	);
}
