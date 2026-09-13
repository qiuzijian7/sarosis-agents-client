/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbViewUtils.ts — 知识库视图的纯工具函数。
 *
 *  从 knowledgeBaseView.ts（巨型 ViewPane）中抽出的**无状态纯函数**，
 *  便于独立单元测试（kbViewUtils.test.ts）并降低主文件体积。
 *  这些函数不含任何 ViewPane 实例状态依赖，行为与原实现逐字一致。
 *--------------------------------------------------------------------------------------------*/

/** 自然排序比较（数字感知、大小写不敏感）：用于文件名排序 */
export function naturalCompare(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** 紧凑容量格式化（无空格）：1.2KB / 3.4MB，用于树节点 meta */
export function formatSizeCompact(bytes: number): string {
	if (bytes < 1024) { return `${bytes}B`; }
	if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)}KB`; }
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 完整容量格式化（带空格、支持 GB）：1.2 KB / 3.4 MB / 5.6 GB，用于汇总行 */
export function formatSizeFull(bytes: number): string {
	if (bytes < 1024) { return `${bytes} B`; }
	const kb = bytes / 1024;
	if (kb < 1024) { return `${kb.toFixed(1)} KB`; }
	const mb = kb / 1024;
	if (mb < 1024) { return `${mb.toFixed(1)} MB`; }
	return `${(mb / 1024).toFixed(1)} GB`;
}

/** 转义 CSS 属性选择器中的引号与反斜杠：用于 data-path 查询 */
export function cssEscapeAttribute(value: string): string {
	return value.replace(/["\\]/g, '\\$&');
}

/** 路径比较归一化：统一斜杠、去尾部斜杠、小写（兼容 Windows 盘符大小写差异） */
export function normalizePathForCompare(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 判断是否为绝对路径（兼容 Windows 盘符与 Unix 根路径） */
export function isAbsolutePath(path: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/');
}
