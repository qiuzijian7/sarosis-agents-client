/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';

/**
 * 知识库分区：对应 SiYuan 的「待处理 / 已内化」概念。
 *  - library：库（输入区 / 待索引的原始导入，对应 mockup 的「库」）
 *  - notes ：笔记（已规整索引的内容树，对应 mockup 的「笔记」）
 */
export type KbSection = 'library' | 'notes';

export const KB_SECTION_LABEL: Record<KbSection, string> = {
	library: '库',
	notes: '笔记',
};

/**
 * 知识库（Vault / 笔记本）。仿 SiYuan 的 Box：
 *  - 磁盘上一个文件夹 = 一个 Vault
 *  - 元数据保存于 storage（id 即文件夹名，类似 SiYuan 用 ID 命名目录）
 */
export interface IKbVault {
	id: string;
	name: string;
	icon: string;
	sort: number;
	sortMode: KbSortMode;
	closed: boolean;
	/** Vault 根目录的绝对磁盘路径（fsPath） */
	path: string;
}

/**
 * 排序模式。完整对齐 SiYuan file-tree 的 14 种排序 + 自定义。
 */
export type KbSortMode =
	| 'fileNameASC' | 'fileNameDESC'
	| 'fileNameNatASC' | 'fileNameNatDESC'
	| 'createdASC' | 'createdDESC'
	| 'modifiedASC' | 'modifiedDESC'
	| 'refCountASC' | 'refCountDESC'
	| 'docSizeASC' | 'docSizeDESC'
	| 'subDocCountASC' | 'subDocCountDESC'
	| 'custom';

export interface IKbSortGroup {
	group: string;
	options: { value: KbSortMode; label: string }[];
}

/** 与 SiYuan sortMenu() 完全对应的排序菜单结构（config.d.ts IFileTree.sort）。 */
export const KB_SORT_GROUPS: IKbSortGroup[] = [
	{
		group: '文件名',
		options: [
			{ value: 'fileNameASC', label: '文件名 (A-Z)' },
			{ value: 'fileNameDESC', label: '文件名 (Z-A)' },
			{ value: 'fileNameNatASC', label: '文件名自然 (A-Z)' },
			{ value: 'fileNameNatDESC', label: '文件名自然 (Z-A)' },
		],
	},
	{
		group: '创建时间',
		options: [
			{ value: 'createdASC', label: '创建时间 (从旧到新)' },
			{ value: 'createdDESC', label: '创建时间 (从新到旧)' },
		],
	},
	{
		group: '编辑时间',
		options: [
			{ value: 'modifiedASC', label: '编辑时间 (从旧到新)' },
			{ value: 'modifiedDESC', label: '编辑时间 (从新到旧)' },
		],
	},
	{
		group: '其它',
		options: [
			{ value: 'docSizeASC', label: '文档大小 (从小到大)' },
			{ value: 'docSizeDESC', label: '文档大小 (从大到小)' },
			{ value: 'subDocCountASC', label: '子文档数 (少到多)' },
			{ value: 'subDocCountDESC', label: '子文档数 (多到少)' },
			{ value: 'custom', label: '自定义（拖拽）' },
		],
	},
];

/** 树节点。section 标记其归属分区。 */
export interface IKbNode {
	name: string;
	/** 绝对 fs 路径 */
	path: string;
	uri: URI;
	isDirectory: boolean;
	section: KbSection;
	size: number;
	mtime: number;
	ctime: number;
	/** 子文档数（仅目录，用于排序与计数） */
	childCount: number;
}

/** 导入来源类型（库分区导入下拉）。 */
export type KbImportKind =
	| 'obsidian'
	| 'files'
	| 'folder'
	| 'feishu'
	| 'xiaohongshu'
	| 'bilibili'
	| 'douyin'
	| 'zhihu';

export const KB_IMPORT_ITEMS: { kind: KbImportKind; label: string; sub: string; icon: string }[] = [
	{ kind: 'obsidian', label: '导入 Obsidian 库', sub: '.md + 双链', icon: '📕' },
	{ kind: 'files', label: '导入文件', sub: 'PDF / DOC / MD / TXT …', icon: '📄' },
	{ kind: 'folder', label: '导入文件夹', sub: '递归扫描', icon: '📁' },
	{ kind: 'feishu', label: '飞书知识库', sub: 'feishu.cn/wiki/…', icon: '📘' },
	{ kind: 'xiaohongshu', label: '小红书', sub: 'xiaohongshu.com/…', icon: '📕' },
	{ kind: 'bilibili', label: 'B 站视频', sub: 'bilibili.com/video/…', icon: '▶️' },
	{ kind: 'douyin', label: '抖音', sub: 'douyin.com/…', icon: '🎵' },
	{ kind: 'zhihu', label: '知乎文章', sub: 'zhihu.com/question/…', icon: '💬' },
];

export function newVaultId(): string {
	// 21 位时间戳 ID（仿 SiYuan ast.NewNodeID：14 位时间 + 7 位随机）
	const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
	let rand = '';
	for (let i = 0; i < 7; i++) { rand += Math.floor(Math.random() * 36).toString(36); }
	return `${ts}-${rand}`;
}
