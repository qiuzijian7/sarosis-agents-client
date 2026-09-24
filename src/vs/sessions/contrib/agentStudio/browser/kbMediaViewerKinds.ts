/*---------------------------------------------------------------------------------------------
 *  KbMediaViewer 的「接管的文件类型」单一真源（★ 2026-09-24）。
 *
 *  为什么单独一个模块：这份清单同时被三处使用 ——
 *    · `kbMediaViewerPane.ts`（决定 webview 侧渲染器种类 + 图片 MIME）
 *    · `agentStudio.contribution.ts`（`editorResolverService.registerEditor` 的 glob 列表）
 *    · 单测
 *  写在 pane 里会导致「注册了 glob 但 pane 不认」（或反之）这类静默漂移，而 pane 依赖大量
 *  workbench 模块、无法在 node 单测里 import ⇒ 把**纯数据 + 纯函数**抽出来。
 *
 *  接管范围：
 *    · pdf / docx —— 2026-09-23（此前会被当文本打开 ⇒ 满屏二进制乱码）
 *    · 位图与 svg —— 2026-09-24（用户要求「知识库中的 png/svg 图片要在 editorPane 中显示」）
 *--------------------------------------------------------------------------------------------*/

/** 渲染器种类（webview 侧据此分发）。 */
export type KbMediaKind = 'pdf' | 'docx' | 'image';

/** 扩展名（小写，不含点）→ 渲染器种类。 */
export const KB_MEDIA_KINDS: Record<string, KbMediaKind> = {
	pdf: 'pdf',
	docx: 'docx',
	// ── 图片（2026-09-24）────────────────────────────────────────────────────
	// ⚠ 只列**浏览器原生可渲染**的位图 + svg：其它（psd/tiff/heic…）交给系统程序打开。
	//   svg 走 `<img src="data:image/svg+xml;base64,…">`：img 嵌入时 SVG 内部的脚本**不会执行**
	//   （浏览器规范行为）⇒ 与 pdf/docx 一样安全，无需额外消毒。
	png: 'image',
	jpg: 'image',
	jpeg: 'image',
	jfif: 'image',
	gif: 'image',
	webp: 'image',
	bmp: 'image',
	avif: 'image',
	ico: 'image',
	svg: 'image',
};

/** 图片扩展名 → MIME（webview 侧用它拼 `data:` URI；不猜、不依赖浏览器嗅探）。 */
export const KB_IMAGE_MIMES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	jfif: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	bmp: 'image/bmp',
	avif: 'image/avif',
	ico: 'image/x-icon',
	svg: 'image/svg+xml',
};

/** 取扩展名（小写、不含点）；无扩展名 ⇒ 空串。 */
export function extOfPath(path: string): string {
	const name = path.split(/[\\/]/).pop() ?? '';
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** 该资源是否由 KbMediaViewer 接管（pane 与 resolver 用同一判据）。 */
export function isKbMediaViewerFile(resource: { path: string }): boolean {
	return !!KB_MEDIA_KINDS[extOfPath(resource.path)];
}

/** 该资源的渲染器种类（不接管 ⇒ undefined）。 */
export function mediaKindOf(resource: { path: string }): KbMediaKind | undefined {
	return KB_MEDIA_KINDS[extOfPath(resource.path)];
}

/** 图片的 MIME（非图片 ⇒ undefined）。 */
export function imageMimeOf(path: string): string | undefined {
	return KB_IMAGE_MIMES[extOfPath(path)];
}

/**
 * resolver 注册用的 glob + 标签（`editorResolverService.registerEditor` 逐个注册）。
 *
 * ⚠ 顺序即优先级（内置查看器按文件类型精确匹配，优先于默认文本编辑器）。
 * 新增类型只改这里 ⇒ pane / resolver / 单测同时生效。
 */
export const KB_MEDIA_VIEWER_GLOBS: ReadonlyArray<{ pattern: string; labelKey: string; label: string }> = [
	{ pattern: '*.pdf', labelKey: 'kb.pdfPreview', label: 'PDF 预览' },
	{ pattern: '*.docx', labelKey: 'kb.docxPreview', label: 'Word 预览' },
	{ pattern: '*.png', labelKey: 'kb.imagePreview', label: '图片预览' },
	{ pattern: '*.jpg', labelKey: 'kb.imagePreview', label: '图片预览' },
	{ pattern: '*.jpeg', labelKey: 'kb.imagePreview', label: '图片预览' },
	{ pattern: '*.jfif', labelKey: 'kb.imagePreview', label: '图片预览' },
	{ pattern: '*.gif', labelKey: 'kb.imagePreview', label: '图片预览' },
	{ pattern: '*.webp', labelKey: 'kb.imagePreview', label: '图片预览' },
	{ pattern: '*.bmp', labelKey: 'kb.imagePreview', label: '图片预览' },
	{ pattern: '*.avif', labelKey: 'kb.imagePreview', label: '图片预览' },
	{ pattern: '*.ico', labelKey: 'kb.imagePreview', label: '图片预览' },
	{ pattern: '*.svg', labelKey: 'kb.imagePreview', label: '图片预览' },
];
