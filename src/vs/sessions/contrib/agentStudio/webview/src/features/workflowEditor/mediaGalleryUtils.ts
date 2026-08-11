/*---------------------------------------------------------------------------------------------
 *  mediaGalleryUtils.ts — 媒体库画廊的纯工具函数（便于单测）。
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
