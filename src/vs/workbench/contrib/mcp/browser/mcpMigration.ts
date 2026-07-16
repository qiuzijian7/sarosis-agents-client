/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMcpServerConfiguration, IMcpServerVariable, IMcpStdioServerConfiguration, McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { IStringDictionary } from '../../../../base/common/collections.js';
import { mcpConfigurationSection } from '../../../contrib/mcp/common/mcpConfiguration.js';
import { IWorkbenchMcpManagementService } from '../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { parse } from '../../../../base/common/jsonc.js';
import { isObject, Mutable } from '../../../../base/common/types.js';
import { IJSONEditingService } from '../../../services/configuration/common/jsonEditing.js';

interface IMcpConfiguration {
	inputs?: IMcpServerVariable[];
	servers?: IStringDictionary<IMcpServerConfiguration>;
}

export class McpConfigMigrationContribution extends Disposable implements IWorkbenchContribution {

	static ID = 'workbench.mcp.config.migration';

	constructor(
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IFileService private readonly fileService: IFileService,
		@IJSONEditingService private readonly jsonEditingService: IJSONEditingService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.migrateMcpConfig();
	}

	private async migrateMcpConfig(): Promise<void> {
		// VsSaros: 不扫描 settings.json 中的 MCP 配置，统一使用 ~/.saros/mcp.json
		// 保留一次性迁移逻辑（将旧 settings.json 中的 MCP 配置迁移到独立文件），但不持续监视
		try {
			const userMcpConfig = await this.parseMcpConfig(this.userDataProfileService.currentProfile.settingsResource);
			if (userMcpConfig && userMcpConfig.servers && Object.keys(userMcpConfig.servers).length > 0) {
				await Promise.all(Object.entries(userMcpConfig.servers).map(([name, config], index) => this.mcpManagementService.install({ name, config, inputs: index === 0 ? userMcpConfig.inputs : undefined })));
				await this.removeMcpConfig(this.userDataProfileService.currentProfile.settingsResource);
			}
		} catch (error) {
			this.logService.error(`MCP migration: Failed to migrate user MCP config`, error);
		}
		// VsSaros: 不持续监视 settings.json 中的 MCP 配置变更
	}

	private async parseMcpConfig(settingsFile: URI): Promise<IMcpConfiguration | undefined> {
		try {
			const content = await this.fileService.readFile(settingsFile);
			const settingsObject: IStringDictionary<unknown> = parse(content.value.toString());
			if (!isObject(settingsObject)) {
				return undefined;
			}
			const mcpConfiguration = settingsObject[mcpConfigurationSection] as IMcpConfiguration;
			if (mcpConfiguration && mcpConfiguration.servers) {
				for (const [, config] of Object.entries(mcpConfiguration.servers)) {
					if (config.type === undefined) {
						(<Mutable<IMcpServerConfiguration>>config).type = (<IMcpStdioServerConfiguration>config).command ? McpServerType.LOCAL : McpServerType.REMOTE;
					}
				}
			}
			return mcpConfiguration;
		} catch (error) {
			if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
				this.logService.warn(`MCP migration: Failed to parse MCP config from ${settingsFile}:`, error);
			}
			return;
		}
	}

	private async removeMcpConfig(settingsFile: URI): Promise<void> {
		try {
			await this.jsonEditingService.write(settingsFile, [
				{
					path: [mcpConfigurationSection],
					value: undefined
				}
			], true);
		} catch (error) {
			this.logService.warn(`MCP migration: Failed to remove MCP config from ${settingsFile}:`, error);
		}
	}
}
