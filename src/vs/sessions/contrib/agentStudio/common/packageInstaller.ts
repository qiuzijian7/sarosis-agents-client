/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 资源包安装器抽象 —— 为 agent/skill/mcp/knowledge 四类资源提供统一的
 * 「解压目录 → 本地安装」与「本地资源 → 打包准备」适配接口。
 *
 * MarketplaceService 负责下载 tar.gz / 解压 / tar 打包 / 上传等通用流程，
 * 各 IPackageInstaller 只关心「目录 ↔ 本地资源注册表」的差异化逻辑。
 *
 * 详见 doc/marketplace-integration-analysis.md（方案 A）。
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { PackageKind, IInstallResult } from './marketplace.js';

/** 包清单（镜像服务端 manifest.json） */
export interface PackageManifest {
	readonly kind: PackageKind;
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly description?: string;
	readonly category?: string;
	readonly author?: string;
	readonly minAppVersion?: string;
	readonly files: readonly string[];
	/** kind 专属原始字段（透传，installer 按需读取） */
	readonly [key: string]: unknown;
	/** Agent 依赖的 skill 包 slug 列表（仅 kind=agent 时有效，可选） */
	readonly skillRefs?: readonly string[];
	/** Agent 依赖的 mcp 包 slug 列表（仅 kind=agent 时有效，可选） */
	readonly mcpRefs?: readonly string[];
	/** HTML 文件清单（仅 kind=agent，含 ConfigHTML 渲染资源） */
	readonly htmlFiles?: {
		/** HTML 入口文件（相对包根路径，如 "html/index.html"） */
		readonly entry: string;
		/** 资源文件列表（相对包根路径） */
		readonly assets?: readonly string[];
	};
}

/** 打包准备结果：本地资源目录 + 清单，由 MarketplaceService 负责 tar 打包 */
export interface IPreparePackResult {
	/** 本地资源所在目录（tar 打包根） */
	readonly localDir: URI;
	/** 生成的清单 */
	readonly manifest: PackageManifest;
}

/**
 * 单类资源的安装器。
 * 每个 kind 对应一个实现，封装该资源的存储格式与注册表交互。
 */
export interface IPackageInstaller {
	readonly _serviceBrand: undefined;
	/** 资源类型 */
	readonly kind: PackageKind;

	/**
	 * 将解压后的包目录安装到本地资源区，并注册到对应 registry。
	 * @param manifest 包清单
	 * @param extractedDir tar.gz 解压后的临时目录
	 * @param opts 安装选项（force=true 时覆盖已存在的同名技能）
	 */
	install(manifest: PackageManifest, extractedDir: URI, opts?: { force?: boolean }): Promise<IInstallResult>;

	/**
	 * 准备本地资源用于发布：返回资源目录 + 生成的清单。
	 * MarketplaceService 负责将 localDir 打包为 tar.gz。
	 * @param localId 本地资源标识（= manifest.id = 商城 slug/storeId）
	 */
	preparePack(localId: string): Promise<IPreparePackResult>;

	/**
	 * 获取本地已安装版本（供升级检查）。未安装或无版本返回 undefined。
	 */
	getInstalledVersion(storeId: string): string | undefined;
}

export const IPackageInstallerRegistry = createDecorator<IPackageInstallerRegistry>('packageInstallerRegistry');

/**
 * 安装器注册表 —— 按 kind 查询安装器。
 * 未注册的 kind 由 MarketplaceService 回退到通用「解压到目录」逻辑。
 */
export interface IPackageInstallerRegistry {
	readonly _serviceBrand: undefined;

	/** 注册安装器 */
	register(installer: IPackageInstaller): void;

	/** 按 kind 获取安装器 */
	get(kind: PackageKind): IPackageInstaller | undefined;
}
