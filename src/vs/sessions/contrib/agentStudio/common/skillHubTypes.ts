/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill Hub 类型定义 —— 描述开源技能仓库和安装服务接口。
 *
 * 一个 Skill Hub 是一个包含 SKILL.md 文件的远程 Git 仓库或目录索引。
 * 用户可以从 Hub 浏览并安装 skill 到本项目的工作区目录中。
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';


// ─── Hub 定义 ────────────────────────────────────────────────────

/**
 * 单个 Hub 的连接配置。
 */
export interface ISkillHubDefinition {
	/** 唯一标识 */
	readonly id: string;
	/** 显示名称 */
	readonly name: string;
	/** 描述 */
	readonly description: string;
	/**
	 * Hub 类型：
	 * - `github`     : GitHub 仓库，通过 GitHub API 获取目录列表
	 * - `git`        : 通用 Git 仓库，通过 raw URL 获取
	 * - `url`        : 直接 URL 索引（返回 JSON 目录）
	 * - `local`      : 本地路径
	 */
	readonly type: 'github' | 'git' | 'url' | 'local';
	/**
	 * Hub 地址：
	 * - github: `owner/repo` 或完整 URL
	 * - git   : 仓库 clone URL
	 * - url   : 索引 JSON 的 URL
	 * - local : 本地目录绝对路径
	 */
	readonly url: string;
	/** 可选：仓库内的 skills 子目录路径（默认 `/`） */
	readonly skillsPath?: string;
	/** 可选：分支名（默认 `main`） */
	readonly branch?: string;
	/** 图标（emoji 或 URL） */
	readonly icon?: string;
	/** 官方标记 */
	readonly official?: boolean;
}

/**
 * Hub 中一个可安装的 Skill 条目。
 */
export interface ISkillHubEntry {
	/** Skill ID（由 name 派生） */
	readonly id: string;
	/** Skill 名称 */
	readonly name: string;
	/** 描述 */
	readonly description: string;
	/** 分类 */
	readonly category?: string;
	/** 激活模式 */
	readonly activation?: string;
	/** 所属 Hub ID */
	readonly hubId: string;
	/**
	 * SKILL.md 的可访问 URL 或路径。
	 * 用于下载内容。
	 */
	readonly contentUrl: string;
	/** 是否已安装到本项目中 */
	installed?: boolean;
	/** 可选：作者/创建者 */
	readonly author?: string;
	/** 可选：版本 */
	readonly version?: string;
	/** 可选：下载次数 */
	readonly downloadCount?: number;
	/** 可选：图标（emoji 或 URL） */
	readonly icon?: string;
	/** 可选：标签列表 */
	readonly tags?: readonly string[];
}

/**
 * 安装结果
 */
export interface ISkillInstallResult {
	readonly success: boolean;
	readonly skillId: string;
	readonly skillName: string;
	readonly error?: string;
}

/** webkitdirectory 上传的单个文件（相对路径 + 内容） */
export interface ISkillFolderUploadFile {
	/** 已去掉根文件夹名的相对路径（'/' 分隔），如 'SKILL.md'、'scripts/run.sh' */
	readonly relativePath: string;
	readonly data: Uint8Array;
}

/** 安装成功后派发的事件载荷 */
export interface ISkillInstallEvent {
	readonly skillId: string;
	readonly skillName: string;
}

// ─── 服务接口 ────────────────────────────────────────────────────

export const ISkillInstallService = createDecorator<ISkillInstallService>('skillInstallService');

export interface ISkillInstallService {
	readonly _serviceBrand: undefined;

	/** 获取内置 Hub 列表 */
	getHubs(): readonly ISkillHubDefinition[];

	/** 从指定 Hub 获取可安装的 skill 列表 */
	fetchHubEntries(hubId: string): Promise<readonly ISkillHubEntry[]>;

	/** 刷新所有 Hub 条目（清缓存） */
	refreshAll(): Promise<void>;

	/** 当 Hub 条目变更时触发 */
	readonly onDidChangeEntries: Event<void>;

	/** 安装一个 Hub skill 到当前工作区 */
	installFromHub(hubId: string, entryId: string): Promise<ISkillInstallResult>;

	/** 从本地文件路径安装 skill（SKILL.md） */
	installFromFile(filePath: string): Promise<ISkillInstallResult>;

	/** 从原始 SKILL.md 文本内容安装 skill */
	installFromContent(content: string): Promise<ISkillInstallResult>;

	/**
	 * 从本地文件夹安装 skill：选中包含 SKILL.md 的文件夹，
	 * 整体复制到 ~/.vssaros/skills/<id>/（过滤垃圾文件）并初始化 .git。
	 */
	installFromFolder(folderUri: URI): Promise<ISkillInstallResult>;

	/**
	 * 从 webkitdirectory 上传的文件列表安装 skill（renderer 沙箱安全的文件夹选择方案，
	 * 不依赖原生文件对话框 IPC）。relativePath 为已去掉根文件夹名的相对路径。
	 */
	installFromFolderUpload(files: readonly ISkillFolderUploadFile[]): Promise<ISkillInstallResult>;

	/** 卸载一个已安装的 skill（从工作区目录删除） */
	uninstallSkill(skillId: string): Promise<boolean>;

	/**
	 * 重命名已安装的 skill：重命名目录、更新 SKILL.md frontmatter、
	 * 迁移 lock 溯源条目并刷新 registry（保留 .git 历史）。
	 * @param newName 新显示名（frontmatter `name`）
	 * @param newId 可选，新 slug/id（目录名与唯一标识，须匹配 `^[a-z][a-z0-9_-]*$`）。
	 *              留空则按 name 自动 slug 化；显式指定时会写入 frontmatter `id` 作为权威键，
	 *              可用于给中文名技能指定稳定 id 或让同名技能以不同 id 共存。
	 */
	renameSkill(skillId: string, newName: string, newId?: string): Promise<ISkillInstallResult>;

	/**
	 * 将版本号写入已安装 skill 的 SKILL.md frontmatter `version` 字段并刷新 registry。
	 * 用于发布商城成功后同步本地版本——否则本地无 version 被视为 '0'，
	 * 商城状态检查会误报「有升级」（实际刚发布的就是最新版）。
	 */
	setSkillVersion(skillId: string, version: string): Promise<boolean>;

	/**
	 * 从 git 仓库安装技能：浅克隆（主进程 isomorphic-git）→ 定位 SKILL.md
	 * （根目录优先 / 唯一嵌套目录 / URL 指定的子目录）→ 复制到 ~/.vssaros/skills/<id>。
	 * 支持 GitHub/GitLab 的 `/tree/<branch>/<subdir>` 子目录链接；仅 http(s) URL。
	 * 重复 id 拒绝安装（与其他安装路径一致）。
	 */
	installFromGit(url: string): Promise<ISkillInstallResult>;

	/** 检查指定 skill 是否已安装到工作区 */
	isInstalled(skillId: string): boolean;

	/** 获取指定 Hub 的所有条目（使用缓存） */
	getCachedEntries(hubId: string): readonly ISkillHubEntry[];

	/** 安装成功后派发（skillId + skillName），供 UI 自动打开该技能详情 */
	readonly onDidInstallSkill: Event<ISkillInstallEvent>;
}

// ─── 内置 Hub 预设 ───────────────────────────────────────────────

export const BUILTIN_SKILL_HUBS: readonly ISkillHubDefinition[] = [
	{
		id: 'anthropic-skills',
		name: 'Anthropic Skills',
		description: 'Anthropic 官方 Claude 技能集 — 代码、写作、分析等最佳实践 prompt',
		type: 'github',
		url: 'anthropics/skills',
		skillsPath: '/',
		branch: 'main',
		icon: '🅰️',
		official: true,
	},
	{
		id: 'hermes-skills',
		name: 'Hermes Skills',
		description: 'Hermes-Agent 社区技能库 — 包含多种工具集成和自动化技能',
		type: 'github',
		url: 'nicobailey/hermes',
		skillsPath: '/skills',
		branch: 'main',
		icon: '🪽',
		official: true,
	},
	{
		id: 'awesome-copilot',
		name: 'Awesome Copilot Skills',
		description: '社区贡献的 GitHub Copilot / Claude Code 技能集合',
		type: 'github',
		url: 'awesome-copilot/skills',
		skillsPath: '/',
		branch: 'main',
		icon: '⭐',
	},
	{
		id: 'prompt-skills',
		name: 'Prompt Engineering Skills',
		description: '高质量 prompt 工程技能模板 — 适用于代码生成、文档编写、数据分析等场景',
		type: 'github',
		url: 'prompt-engineering/skills-collection',
		skillsPath: '/skills',
		branch: 'main',
		icon: '✨',
	},
];
