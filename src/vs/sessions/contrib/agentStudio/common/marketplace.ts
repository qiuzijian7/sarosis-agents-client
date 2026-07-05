/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Marketplace 服务接口 —— 对接 VsSaros 商城服务端，实现 agent/skill/mcp/知识库
 * 的浏览、下载、上传与升级检查。
 *
 * 商城服务端地址由配置项 `saros.marketplace.url` 指定（默认线上地址）。
 * 登录态（JWT token）持久化到 IStorageService。
 *
 * 资源包格式：package.tar.gz 内含 manifest.json + 资源文件，详见商城设计文档。
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

/** 资源类型 */
export type PackageKind = 'agent' | 'skill' | 'mcp' | 'knowledge' | 'workflow';

/** 商城用户 */
export interface IMarketplaceUser {
	readonly id: string;
	readonly username: string;
	readonly displayName?: string;
	readonly role: 'user' | 'admin';
	readonly avatarUrl?: string;
}

/** 资源包列表项 */
export interface IMarketplacePackage {
	readonly id: string;
	readonly kind: PackageKind;
	readonly slug: string;
	readonly name: string;
	readonly description?: string;
	readonly category?: string;
	readonly icon?: string;
	readonly visibility: 'public' | 'private';
	readonly tags: readonly string[];
	readonly latestVersion?: string;
	readonly downloads?: number;
	/** 使用指南（Markdown 格式，用于详情页"描述"Tab展示） */
	readonly useGuide?: string;
	/** 作者名称 */
	readonly authorName?: string;
	/** 更新时间戳（毫秒） */
	readonly updatedAt?: number;
	/** 版本列表（列表接口可能不返回，详情接口返回） */
	readonly versions?: readonly IMarketplaceVersion[];
}

/** 资源版本 */
export interface IMarketplaceVersion {
	readonly id: string;
	readonly version: string;
	readonly changelog?: string;
	readonly sha256: string;
	readonly size: number;
	readonly isLatest: boolean;
	readonly createdAt: number;
	/** 版本的 manifest（含 MCP 配置等），从服务端获取 */
	readonly manifest?: any;
}

/** 资源包详情（含版本列表） */
export interface IMarketplacePackageDetail extends IMarketplacePackage {
	readonly author?: { id: string; username: string; displayName?: string };
	readonly versions: readonly IMarketplaceVersion[];
}

/** 升级信息 */
export interface IUpgradeInfo {
	readonly kind: PackageKind;
	readonly storeId: string;
	readonly current: string;
	readonly latest: string;
	readonly changelog?: string;
	readonly downloadUrl: string;
	readonly sha256: string;
	readonly size: number;
}

/** 升级检查项 */
export interface IUpgradeCheckItem {
	readonly kind: PackageKind;
	readonly storeId: string;
	readonly version: string;
}

/** 下载安装结果 */
export interface IInstallResult {
	readonly kind: PackageKind;
	readonly storeId: string;
	readonly version: string;
	/** 安装到的本地目录 URI */
	readonly targetDir: string;
}

/** 发布选项 */
export interface IPublishOptions {
	/** 版本号（覆盖 manifest 中的 version） */
	readonly version?: string;
	/** 显示名称（覆盖 manifest 中的 name） */
	readonly name?: string;
	/** 描述（覆盖 manifest 中的 description） */
	readonly description?: string;
	/** 分类（覆盖 manifest 中的 category） */
	readonly category?: string;
	/** 作者（覆盖 manifest 中的 author） */
	readonly author?: string;
	/** 可见性：公开或私有 */
	readonly visibility?: 'public' | 'private';
	/** 标签列表 */
	readonly tags?: readonly string[];
	/** 使用指南（Markdown 格式） */
	readonly useGuide?: string;
	/** 变更日志（随上传版本提交，作为 x-changelog 请求头） */
	readonly changelog?: string;
	/** 关联的 skill 包 slug 列表 */
	readonly skillRefs?: readonly string[];
	/** 关联的 MCP 包 slug 列表 */
	readonly mcpRefs?: readonly string[];
}

/** 列表查询参数 */
export interface IListPackagesOptions {
	readonly kind?: PackageKind;
	readonly q?: string;
	readonly category?: string;
	readonly page?: number;
	readonly pageSize?: number;
	readonly sort?: 'recent' | 'popular' | 'name';
}

export const IMarketplaceService = createDecorator<IMarketplaceService>('marketplaceService');

export interface IMarketplaceService {
	readonly _serviceBrand: undefined;

	/** 登录态变化事件 */
	readonly onDidChangeLogin: Event<void>;

	/** 商城服务端地址 */
	readonly endpoint: string;

	// ── 认证 ──────────────────────────────────────────────
	isLoggedIn(): boolean;
	getCurrentUser(): IMarketplaceUser | undefined;
	login(username: string, password: string): Promise<void>;
	/** 用 TOF 票据登录商城（复用 VsSaros 登录态） */
	loginWithTof(): Promise<void>;
	logout(): void;

	// ── 浏览 ──────────────────────────────────────────────
	listPackages(opts?: IListPackagesOptions): Promise<{ items: readonly IMarketplacePackage[]; total: number }>;
	getPackage(slug: string): Promise<IMarketplacePackageDetail>;

	// ── 下载安装 ──────────────────────────────────────────
	/**
	 * 下载指定版本并安装到本地资源目录。
	 * - agent  → ~/.saros/agents/custom/{id}/
	 * - skill  → ~/.saros/skills/{id}/
	 * - mcp    → ~/.saros/mcp/{id}/
	 * - knowledge → ~/.saros/knowledge-base/{id}/
	 */
	download(storeId: string, version: string, kind: PackageKind): Promise<IInstallResult>;

	// ── 卸载 ──────────────────────────────────────────────
	/**
	 * 卸载已安装的资源包：删除本地安装目录 + 从 installed-packages.json 移除记录。
	 */
	uninstall(storeId: string, kind: PackageKind): Promise<void>;

	// ── 已安装查询 ────────────────────────────────────────
	/**
	 * 读取本地 installed-packages.json，返回已安装的资源列表。
	 */
	getInstalled(): Promise<readonly { kind: PackageKind; storeId: string; version: string }[]>;

	// ── 上传发布 ──────────────────────────────────────────
	/**
	 * 将本地资源打包发布到商城。localId 为本地资源标识（对应 manifest.id = slug）。
	 */
	publish(localId: string, kind: PackageKind, opts?: IPublishOptions): Promise<{ version: string }>;

	// ── 升级检查 ──────────────────────────────────────────
	/** 批量检查已安装资源是否有更新 */
	checkUpgrades(items: readonly IUpgradeCheckItem[]): Promise<readonly IUpgradeInfo[]>;
}

/** 商城配置键 */
export const MARKETPLACE_URL_SETTING = 'saros.marketplace.url';
export const MARKETPLACE_AUTO_CHECK_SETTING = 'saros.marketplace.autoCheckUpdates';
export const MARKETPLACE_UPDATE_INTERVAL_SETTING = 'saros.marketplace.updateInterval';
