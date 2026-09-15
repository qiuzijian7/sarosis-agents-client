/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../base/common/errors.js';
import { Schemas } from '../../base/common/network.js';
import { FileService } from '../../platform/files/common/fileService.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IPolicyService } from '../../platform/policy/common/policy.js';
import { IUriIdentityService } from '../../platform/uriIdentity/common/uriIdentity.js';
import { IUserDataProfilesService } from '../../platform/userDataProfile/common/userDataProfile.js';
import { INativeWindowConfiguration } from '../../platform/window/common/window.js';
import { IAnyWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import { Workbench } from '../../workbench/browser/workbench.js';
import { DesktopMain } from '../../workbench/electron-browser/desktop.main.js';
import { WorkspaceService } from '../../workbench/services/configuration/browser/configurationService.js';
import { ConfigurationCache } from '../../workbench/services/configuration/common/configurationCache.js';
import { INativeWorkbenchEnvironmentService } from '../../workbench/services/environment/electron-browser/environmentService.js';
import { IRemoteAgentService } from '../../workbench/services/remote/common/remoteAgentService.js';
import { IUserDataProfileService } from '../../workbench/services/userDataProfile/common/userDataProfile.js';
import { AgentLayoutWorkbench } from '../browser/agentLayoutWorkbench.js';
import { AgentLayoutWorkspaceService } from '../services/configuration/browser/agentLayoutWorkspaceService.js';

/**
 * [Saros] 「IDE 底座 + Agent 布局」的窗口入口实现。
 *
 * 与 sessions 侧的 `SessionsMain` 是**同一层级**的东西（都实现
 * `workbench/electron-browser/desktop.main.ts` 的 `IDesktopMain`：`main(configuration)`），
 * 但走的服务图完全不同 —— 本类继承**标准 `DesktopMain`**，所以拿到的是标准窗口的
 * 全套 services / 贡献 / 启动流程，只替换两处：
 *
 * 1. Workbench 实现 → `AgentLayoutWorkbench`（Agent 布局 + 额外 part）；
 * 2. workspace/configuration 服务 → `AgentLayoutWorkspaceService`（方案 C 的配置隔离）。
 *
 * ★ 这就是「入口换子类」（方案 2）：**标准 `DesktopMain` 的默认路径一行没变**
 * （`getWorkbenchConstructor()` 默认返回 `Workbench`、`createWorkspaceService()` 默认返回
 * 标准 `WorkspaceService`），所以普通 IDE 窗口不受影响。
 *
 * ⚠ 作为入口时，本模块**必须**同时引入标准贡献注册（见 `agentLayout.desktop.main.ts`），
 * 否则窗口起来后没有任何服务与部件。`desktop.main.js` 只带 `DesktopMain` 类本身。
 */
export class AgentLayoutDesktopMain extends DesktopMain {

	protected override getWorkbenchConstructor(): typeof Workbench {
		return AgentLayoutWorkbench;
	}

	/**
	 * ★ 换成 `AgentLayoutWorkspaceService` —— 保住方案 C 的配置隔离。
	 *
	 * 标准 `DesktopMain` 建的是**标准** `WorkspaceService`，它会加载 folder 配置模型
	 * ⇒ 那个窗口会读 `<folder>/.vscode/settings.json`。而本方法返回的**同一个**对象会被
	 * 同时注册成 `IWorkspaceContextService` 与 `IWorkbenchConfigurationService`
	 * （见基类 `initServices()`），所以这一处覆写同时保住两侧行为。
	 *
	 * 方法体与基类逐字一致，**只把 `new WorkspaceService(...)` 换成子类** ——
	 * 其余（`ConfigurationCache` 的构造参数、`initialize()` 与错误兜底）刻意保持原样，
	 * 避免与上游漂移。
	 */
	protected override async createWorkspaceService(
		workspace: IAnyWorkspaceIdentifier,
		environmentService: INativeWorkbenchEnvironmentService,
		userDataProfileService: IUserDataProfileService,
		userDataProfilesService: IUserDataProfilesService,
		fileService: FileService,
		remoteAgentService: IRemoteAgentService,
		uriIdentityService: IUriIdentityService,
		logService: ILogService,
		policyService: IPolicyService
	): Promise<WorkspaceService> {
		const configurationCache = new ConfigurationCache([Schemas.file, Schemas.vscodeUserData] /* Cache all non native resources */, environmentService, fileService);
		const workspaceService = new AgentLayoutWorkspaceService({ remoteAuthority: environmentService.remoteAuthority, configurationCache }, environmentService, userDataProfileService, userDataProfilesService, fileService, remoteAgentService, uriIdentityService, logService, policyService);

		try {
			await workspaceService.initialize(workspace);

			return workspaceService;
		} catch (error) {
			onUnexpectedError(error);

			return workspaceService;
		}
	}
}

export function main(configuration: INativeWindowConfiguration): Promise<void> {
	const workbench = new AgentLayoutDesktopMain(configuration);

	return workbench.open();
}
