/*---------------------------------------------------------------------------------------------
 *  mediaGalleryUtils.ts — 媒体库画廊的纯工具函数（便于单测）。
 *
 *  ⚠ 2026-10-19：webview 里的媒体库浮层（`MediaGallery.tsx`）已删除（统一到编辑区页
 *  `MediaGalleryEditorPane`），本文件**现在只被单测**（`test/.../workflowMediaAssets.test.ts`）
 *  与"壳外的纯函数"引用 —— 原生 pane 有它自己的本地实现（两个世界不能互相 import：
 *  webview 被 `src/tsconfig.json` 排除、由 esbuild 单独打包）。
 *  ⇒ 这两个函数若要改，记得**同时**看 `browser/mediaGalleryEditorPane.ts` 末尾的同名实现。
 *--------------------------------------------------------------------------------------------*/

/** 人类可读字节数（B/KB/MB/GB），整数省略多余小数（1 KB 而非 1.0 KB）。 */
export function formatBytes(n: number | undefined): string {
	if (!n) { return '0 B'; }
	const units = ['B', 'KB', 'MB', 'GB'];
	let v = n, i = 0;
	while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
	const s = v.toFixed(v >= 100 ? 0 : 1).replace(/\.0$/, '');
	return `${s} ${units[i]}`;
}

/** 从资产导出友好的文件名：fileName → ComfyUI filename= 参数 → URL 尾部文件名 → key+kind。 */
export function assetFileName(a: { fileName?: string; ref: string; id: string; kind: string }): string {
	if (a.fileName) { return a.fileName; }
	// ComfyUI /view?filename=out_00001_.png&subfolder=&type=output —— 文件名在 query 参数里
	const q = /[?&]filename=([^&#]+)/.exec(a.ref);
	if (q) { return decodeURIComponent(q[1]); }
	const m = /[^/?#]+\.[A-Za-z0-9]{2,5}(?:[?#]|$)/.exec(a.ref);
	if (m) { return m[0].replace(/[?#].*$/, ''); }
	const ext = a.kind === 'image' ? 'png' : a.kind === 'video' ? 'mp4' : 'bin';
	return `${a.id}.${ext}`;
}
