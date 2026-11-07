/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * PackageInstallerRegistry 实现 —— 按 kind 管理 IPackageInstaller。
 * ★ P3（2026-11-07）：`SkillInstaller` 已退役 —— 技能安装整体迁到 dsh 侧
 *   `@vssaros/dsh-marketplace`（`installSkillContent` / `installBundle`，
 *   `resolveOp` 里 `install` + `kind:'skill'` 固定走 `local-write`）。
 *   当前注册：agent / mcp / knowledge / workflow 四类。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IPackageInstaller, IPackageInstallerRegistry } from '../common/packageInstaller.js';
import { PackageKind } from '../common/marketplace.js';
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
		// 注册四类资源的 installer（skill 已迁 dsh 侧）
		// workflow: 导入到工作区 .vssarosworkspace/workflows/
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
