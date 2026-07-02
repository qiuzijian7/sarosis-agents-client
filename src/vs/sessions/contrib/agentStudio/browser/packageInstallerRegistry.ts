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
import { WorkflowInstaller } from './installers/workflowInstaller.js';

export class PackageInstallerRegistry extends Disposable implements IPackageInstallerRegistry {
	declare readonly _serviceBrand: undefined;

	private readonly _installers = new Map<PackageKind, IPackageInstaller>();

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// 注册五类资源的 installer
		// skill/agent/mcp/knowledge: 完整（registry reload + 版本溯源）
		// workflow: 导入到工作区 .sarosisworkspace/workflows/
		this.register(instantiationService.createInstance(SkillInstaller));
		this.register(instantiationService.createInstance(AgentInstaller));
		this.register(instantiationService.createInstance(McpInstaller));
		this.register(instantiationService.createInstance(KnowledgeInstaller));
		this.register(instantiationService.createInstance(WorkflowInstaller));
	}

	register(installer: IPackageInstaller): void {
		this._installers.set(installer.kind, installer);
	}

	get(kind: PackageKind): IPackageInstaller | undefined {
		return this._installers.get(kind);
	}
}
