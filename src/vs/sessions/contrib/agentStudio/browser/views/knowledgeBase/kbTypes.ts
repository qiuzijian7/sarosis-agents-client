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
	/**
	 * 外部配置的自定义根目录（用户「配置文件夹为知识库」指定）。
	 * 存在时 vaultUri 优先返回它，根目录设置改变不会影响它；缺省（默认 Vault）
	 * 时 vaultUri 跟随全局知识库根目录（STORAGE_ROOT_DIR）。
	 */
	customPath?: string;
	/**
	 * 关联（链接）的外部文件夹绝对路径列表。
	 * 与「导入文件夹（拷贝）」不同，关联模式**不移动 / 不复制文件**，
	 * 仅把该目录登记为索引根，由内核原地扫描其中的 .md 进行索引 / 图谱 / 反链。
	 * 持久化在 vaults 列表（saveVaults）。
	 */
	linkedFolders?: string[];
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
	| 'url';

export const KB_IMPORT_ITEMS: { kind: KbImportKind; label: string; sub: string; icon: string }[] = [
	{ kind: 'obsidian', label: '导入 Obsidian 库', sub: '.md + 双链', icon: '📕' },
	{ kind: 'files', label: '导入文件', sub: 'PDF / DOC / MD / TXT …', icon: '📄' },
	{ kind: 'folder', label: '导入文件夹', sub: '关联原位 / 拷贝', icon: '📁' },
	{ kind: 'url', label: '导入链接 / URL', sub: '小红书/抖音/知乎/YouTube…', icon: '🔗' },
];

export function newVaultId(): string {
	// 21 位时间戳 ID（仿 SiYuan ast.NewNodeID：14 位时间 + 7 位随机）
	const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
	let rand = '';
	for (let i = 0; i < 7; i++) { rand += Math.floor(Math.random() * 36).toString(36); }
	return `${ts}-${rand}`;
}
