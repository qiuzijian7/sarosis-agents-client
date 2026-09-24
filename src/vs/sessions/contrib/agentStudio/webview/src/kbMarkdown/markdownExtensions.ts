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

/** 「活页面」嵌入目标（`![[page.html]]` → 沙箱 iframe 渲染，见 HtmlEmbedComponent）。 */
export function isHtmlFile(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.endsWith('.html') || lower.endsWith('.htm');
}

/** 图表文件嵌入目标（`![[x.drawio]]` / `![[x.mermaid]]` / `![[x.canvas]]` → DiagramEmbedComponent）。 */
export type DiagramEmbedKind = 'mermaid' | 'drawio' | 'canvas';

export function diagramEmbedKindOf(path: string): DiagramEmbedKind | undefined {
	const lower = path.toLowerCase();
	if (lower.endsWith('.mermaid') || lower.endsWith('.mmd')) { return 'mermaid'; }
	if (lower.endsWith('.drawio')) { return 'drawio'; }
	if (lower.endsWith('.canvas')) { return 'canvas'; }
	return undefined;
}
