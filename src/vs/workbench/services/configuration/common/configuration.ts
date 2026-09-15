/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { IAnyWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';

/**
 * ★ [Saros] 工作区（folder）级配置目录 —— 本产品**不读** VS Code 的 `.vscode/`，
 * 统一用自己的工作区数据目录 `.sarosworkspace/`（与 agentStudio 的
 * `WORKSPACE_DATA_DIR` 同源，agents / workflows / checkpoints / tasks 都在其中）。
 *
 * 这一行是「folder 级配置放在哪」的**唯一真源**，它同时派生出：
 *   `<folder>/.sarosworkspace/settings.json`（folder 级设置，见 FOLDER_SETTINGS_PATH）
 *   `<folder>/.sarosworkspace/{tasks,launch,mcp}.json`（见下方 WORKSPACE_STANDALONE_CONFIGURATIONS）
 *
 * ⚠ 不要为了「兼容只认 .vscode 的第三方扩展」改回去：本产品的定位就是
 * 「不读工作区 `.vscode/`」（安全理由见 `sessions/services/configuration/browser/configurationService.ts`
 * 的「方案 C」说明：`.vscode/` 在**工作区内、模型可写**，读它等于让被约束者改写约束）。
 */
export const FOLDER_CONFIG_FOLDER_NAME = '.sarosworkspace';
export const FOLDER_SETTINGS_NAME = 'settings';
export const FOLDER_SETTINGS_PATH = `${FOLDER_CONFIG_FOLDER_NAME}/${FOLDER_SETTINGS_NAME}.json`;

export const defaultSettingsSchemaId = 'vscode://schemas/settings/default';
export const userSettingsSchemaId = 'vscode://schemas/settings/user';
export const profileSettingsSchemaId = 'vscode://schemas/settings/profile';
export const machineSettingsSchemaId = 'vscode://schemas/settings/machine';
export const workspaceSettingsSchemaId = 'vscode://schemas/settings/workspace';
export const folderSettingsSchemaId = 'vscode://schemas/settings/folder';
export const launchSchemaId = 'vscode://schemas/launch';
export const tasksSchemaId = 'vscode://schemas/tasks';
export const mcpSchemaId = 'vscode://schemas/mcp';

export const APPLICATION_SCOPES = [ConfigurationScope.APPLICATION, ConfigurationScope.APPLICATION_MACHINE];
export const PROFILE_SCOPES = [ConfigurationScope.MACHINE, ConfigurationScope.WINDOW, ConfigurationScope.RESOURCE, ConfigurationScope.LANGUAGE_OVERRIDABLE, ConfigurationScope.MACHINE_OVERRIDABLE];
export const LOCAL_MACHINE_PROFILE_SCOPES = [ConfigurationScope.WINDOW, ConfigurationScope.RESOURCE, ConfigurationScope.LANGUAGE_OVERRIDABLE];
export const LOCAL_MACHINE_SCOPES = [ConfigurationScope.APPLICATION, ...LOCAL_MACHINE_PROFILE_SCOPES];
export const REMOTE_MACHINE_SCOPES = [ConfigurationScope.MACHINE, ConfigurationScope.APPLICATION_MACHINE, ConfigurationScope.WINDOW, ConfigurationScope.RESOURCE, ConfigurationScope.LANGUAGE_OVERRIDABLE, ConfigurationScope.MACHINE_OVERRIDABLE];
export const WORKSPACE_SCOPES = [ConfigurationScope.WINDOW, ConfigurationScope.RESOURCE, ConfigurationScope.LANGUAGE_OVERRIDABLE, ConfigurationScope.MACHINE_OVERRIDABLE];
export const FOLDER_SCOPES = [ConfigurationScope.RESOURCE, ConfigurationScope.LANGUAGE_OVERRIDABLE, ConfigurationScope.MACHINE_OVERRIDABLE];

export const TASKS_CONFIGURATION_KEY = 'tasks';
export const LAUNCH_CONFIGURATION_KEY = 'launch';
export const MCP_CONFIGURATION_KEY = 'mcp';

export const WORKSPACE_STANDALONE_CONFIGURATIONS = Object.create(null);
WORKSPACE_STANDALONE_CONFIGURATIONS[TASKS_CONFIGURATION_KEY] = `${FOLDER_CONFIG_FOLDER_NAME}/${TASKS_CONFIGURATION_KEY}.json`;
WORKSPACE_STANDALONE_CONFIGURATIONS[LAUNCH_CONFIGURATION_KEY] = `${FOLDER_CONFIG_FOLDER_NAME}/${LAUNCH_CONFIGURATION_KEY}.json`;
WORKSPACE_STANDALONE_CONFIGURATIONS[MCP_CONFIGURATION_KEY] = `${FOLDER_CONFIG_FOLDER_NAME}/${MCP_CONFIGURATION_KEY}.json`;
export const USER_STANDALONE_CONFIGURATIONS = Object.create(null);
USER_STANDALONE_CONFIGURATIONS[TASKS_CONFIGURATION_KEY] = `${TASKS_CONFIGURATION_KEY}.json`;
USER_STANDALONE_CONFIGURATIONS[MCP_CONFIGURATION_KEY] = `${MCP_CONFIGURATION_KEY}.json`;

export type ConfigurationKey = { type: 'defaults' | 'user' | 'workspaces' | 'folder'; key: string };

export interface IConfigurationCache {

	needsCaching(resource: URI): boolean;
	read(key: ConfigurationKey): Promise<string>;
	write(key: ConfigurationKey, content: string): Promise<void>;
	remove(key: ConfigurationKey): Promise<void>;

}

export type RestrictedSettings = {
	default: ReadonlyArray<string>;
	application?: ReadonlyArray<string>;
	userLocal?: ReadonlyArray<string>;
	userRemote?: ReadonlyArray<string>;
	workspace?: ReadonlyArray<string>;
	workspaceFolder?: ResourceMap<ReadonlyArray<string>>;
};

export const IWorkbenchConfigurationService = refineServiceDecorator<IConfigurationService, IWorkbenchConfigurationService>(IConfigurationService);
export interface IWorkbenchConfigurationService extends IConfigurationService {
	/**
	 * Restricted settings defined in each configuration target
	 */
	readonly restrictedSettings: RestrictedSettings;

	/**
	 * Event that triggers when the restricted settings changes
	 */
	readonly onDidChangeRestrictedSettings: Event<RestrictedSettings>;

	/**
	 * A promise that resolves when the remote configuration is loaded in a remote window.
	 * The promise is resolved immediately if the window is not remote.
	 */
	whenRemoteConfigurationLoaded(): Promise<void>;

	/**
	 * Initialize configuration service for the given workspace
	 * @param arg workspace Identifier
	 */
	initialize(arg: IAnyWorkspaceIdentifier): Promise<void>;

	/**
	 * Returns true if the setting can be applied for all profiles otherwise false.
	 * @param setting
	 */
	isSettingAppliedForAllProfiles(setting: string): boolean;
}

export const TASKS_DEFAULT = '{\n\t\"version\": \"2.0.0\",\n\t\"tasks\": []\n}';

export const APPLY_ALL_PROFILES_SETTING = 'workbench.settings.applyToAllProfiles';
