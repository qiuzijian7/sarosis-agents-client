/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * PackageInstallerRegistry 实现 —— 按 kind 管理 IPackageInstaller。
 * 当前注册：SkillInstaller。
 * Agent/MCP/Knowledge Installer 将在后续阶段（P1/P2）补充。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IPackageInstaller, IPackageInstallerRegistry } from '../common/packageInstaller.js';
import { PackageKind } from '../common/marketplace.js';
import { SkillInstaller } from './installers/skillInstaller.js';
import { AgentInstaller } from './installers/agentInstaller.js';
import { McpInstaller } from './installers/mcpInstaller.js';
import { KnowledgeInstaller } from './installers/knowledgeInstaller.js';

export class PackageInstallerRegistry extends Disposable implements IPackageInstallerRegistry {
	declare readonly _serviceBrand: undefined;

	private readonly _installers = new Map<PackageKind, IPackageInstaller>();

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// 注册四类资源的 installer
		// skill/agent: 完整（registry reload + 版本溯源）
		// mcp: 文件落地（config.json），平台 IMcpService 自动注册留后续增强
		// knowledge: 文件落地（docs/index.json），RAG registry 留后续增强
		this.register(instantiationService.createInstance(SkillInstaller));
		this.register(instantiationService.createInstance(AgentInstaller));
		this.register(instantiationService.createInstance(McpInstaller));
		this.register(instantiationService.createInstance(KnowledgeInstaller));
	}

	register(installer: IPackageInstaller): void {
		this._installers.set(installer.kind, installer);
	}

	get(kind: PackageKind): IPackageInstaller | undefined {
		return this._installers.get(kind);
	}
}
