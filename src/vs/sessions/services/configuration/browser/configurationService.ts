/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { Queue } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { JSONPath, ParseError, parse } from '../../../../base/common/json.js';
import { applyEdits, setProperty } from '../../../../base/common/jsonEdit.js';
import { Edit, FormattingOptions } from '../../../../base/common/jsonFormatter.js';
import { deepClone, equals } from '../../../../base/common/objects.js';
import { distinct, equals as arrayEquals } from '../../../../base/common/arrays.js';
import { OS, OperatingSystem } from '../../../../base/common/platform.js';
import { IConfigurationChange, IConfigurationChangeEvent, IConfigurationData, IConfigurationOverrides, IConfigurationUpdateOptions, IConfigurationUpdateOverrides, IConfigurationValue, ConfigurationTarget, isConfigurationOverrides, isConfigurationUpdateOverrides } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationChangeEvent, ConfigurationModel } from '../../../../platform/configuration/common/configurationModels.js';
import { DefaultConfiguration, IPolicyConfiguration, NullPolicyConfiguration, PolicyConfiguration } from '../../../../platform/configuration/common/configurations.js';
import { Extensions, IConfigurationRegistry, IRegisteredConfigurationPropertySchema, keyFromOverrideIdentifiers } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService, FileOperationError, FileOperationResult } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IPolicyService, NullPolicyService } from '../../../../platform/policy/common/policy.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder, Workspace } from '../../../../platform/workspace/common/workspace.js';
import { UserConfiguration } from '../../../../workbench/services/configuration/browser/configuration.js';
import { APPLICATION_SCOPES, APPLY_ALL_PROFILES_SETTING, IWorkbenchConfigurationService, RestrictedSettings } from '../../../../workbench/services/configuration/common/configuration.js';
import { Configuration } from '../../../../workbench/services/configuration/common/configurationModels.js';
import { IUserDataProfileService } from '../../../../workbench/services/userDataProfile/common/userDataProfile.js';

// Import to register configuration contributions
import '../../../../workbench/services/configuration/browser/configurationService.js';

class SessionsDefaultConfiguration extends DefaultConfiguration {

	protected override getDefaultValue(_key: string, propertySchema: IRegisteredConfigurationPropertySchema): unknown {
		if (propertySchema.agentsWindow) {
			return deepClone(propertySchema.agentsWindow.default);
		}
		return super.getDefaultValue(_key, propertySchema);
	}

}

/**
 * Agent Studio（agents 窗口）的配置服务。
 *
 * ★★ **本项目不从 `<folder>/.vscode/settings.json` 读取任何数据**（用户 2026-09-13 定规）。
 *
 * 来源只有三层：默认值（含 `agentsWindow` 覆写）、策略（policy）、用户级
 * `~/.vssaros/User/settings.json`。**folder 级（`.vscode/settings.json`）与
 * `.code-workspace` 的 `settings` 段一律不加载**，folder 配置模型恒为空。
 *
 * 理由（与「授权表不放 `.vscode/`」同源，见 `common/toolAllowStore.ts` 注释）：
 * `.vscode/settings.json` 在**工作区内、模型可写** —— 读取它等于让「被约束者改写约束」：
 * 仓库里（或被注入到文件/网页/issue 的指令）写一条 `sessions.agentStudio.*` /
 * `chat.agent.*` 就能改掉模型、provider、自动批准档位、技能开关等本产品的行为。
 *
 * 同理也**不往那里写**：`updateValue` 的 `WORKSPACE` / `WORKSPACE_FOLDER` 目标会抛错，
 * 而不是静默改写到用户级（那等于把「工作区作用域」升级成「全局作用域」= 放宽权限）。
 *
 * 注：这只约束 agents 窗口（本项目）。标准 workbench 仍按 VS Code 原生语义读取
 * 工作区设置 —— 那是编辑器本身的能力，不在本约定范围内。
 */
export class ConfigurationService extends Disposable implements IWorkbenchConfigurationService {

	declare readonly _serviceBrand: undefined;

	private _configuration: Configuration;
	private readonly defaultConfiguration: DefaultConfiguration;
	private readonly policyConfiguration: IPolicyConfiguration;
	private readonly userConfiguration: UserConfiguration;
	private readonly agentsWindowReadOnlyKeys = new Set<string>();

	private readonly _onDidChangeConfiguration = this._register(new Emitter<IConfigurationChangeEvent>());
	readonly onDidChangeConfiguration = this._onDidChangeConfiguration.event;

	readonly onDidChangeRestrictedSettings = Event.None;
	readonly restrictedSettings: RestrictedSettings = { default: [] };

	private readonly configurationRegistry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

	private readonly settingsResource: URI;
	private readonly configurationEditing: ConfigurationEditing;

	constructor(
		userDataProfileService: IUserDataProfileService,
		private readonly workspaceService: IWorkspaceContextService,
		uriIdentityService: IUriIdentityService,
		fileService: IFileService,
		policyService: IPolicyService,
		private readonly logService: ILogService,
	) {
		super();

		this.settingsResource = userDataProfileService.currentProfile.settingsResource;
		this.defaultConfiguration = this._register(new SessionsDefaultConfiguration(logService));
		this.policyConfiguration = policyService instanceof NullPolicyService ? new NullPolicyConfiguration() : this._register(new PolicyConfiguration(this.defaultConfiguration, policyService, logService));
		this.initAgentsWindowReadOnlyKeys();
		this.userConfiguration = this._register(new UserConfiguration(userDataProfileService.currentProfile.settingsResource, userDataProfileService.currentProfile.tasksResource, userDataProfileService.currentProfile.mcpResource, { exclude: [...this.agentsWindowReadOnlyKeys] }, fileService, uriIdentityService, logService));
		this.configurationEditing = new ConfigurationEditing(fileService, this);

		this._configuration = new Configuration(
			ConfigurationModel.createEmptyModel(logService),
			ConfigurationModel.createEmptyModel(logService),
			ConfigurationModel.createEmptyModel(logService),
			ConfigurationModel.createEmptyModel(logService),
			ConfigurationModel.createEmptyModel(logService),
			ConfigurationModel.createEmptyModel(logService),
			new ResourceMap(),
			ConfigurationModel.createEmptyModel(logService),
			new ResourceMap<ConfigurationModel>(),
			this.workspaceService.getWorkspace() as Workspace,
			this.logService
		);

		this._register(this.defaultConfiguration.onDidChangeConfiguration(({ defaults, properties }) => this.onDefaultConfigurationChanged(defaults, properties)));
		this._register(this.policyConfiguration.onDidChangeConfiguration(configurationModel => this.onPolicyConfigurationChanged(configurationModel)));
		this._register(this.userConfiguration.onDidChangeConfiguration(userConfiguration => this.onUserConfigurationChanged(userConfiguration)));
	}

	async initialize(): Promise<void> {
		const [defaultModel, policyModel, userModel] = await Promise.all([
			this.defaultConfiguration.initialize(),
			this.policyConfiguration.initialize(),
			this.userConfiguration.initialize()
		]);
		const workspace = this.workspaceService.getWorkspace() as Workspace;
		this._configuration = new Configuration(
			defaultModel,
			policyModel,
			ConfigurationModel.createEmptyModel(this.logService),
			userModel,
			ConfigurationModel.createEmptyModel(this.logService),
			ConfigurationModel.createEmptyModel(this.logService),
			new ResourceMap(),
			ConfigurationModel.createEmptyModel(this.logService),
			new ResourceMap<ConfigurationModel>(),
			workspace,
			this.logService
		);
		// ★ 刻意**不**加载 `<folder>/.vscode/settings.json`：见类注释。
	}

	// #region IWorkbenchConfigurationService

	getConfigurationData(): IConfigurationData {
		return this._configuration.toData();
	}

	getValue<T>(): T;
	getValue<T>(section: string): T;
	getValue<T>(overrides: IConfigurationOverrides): T;
	getValue<T>(section: string, overrides: IConfigurationOverrides): T;
	getValue(arg1?: unknown, arg2?: unknown): unknown {
		const section = typeof arg1 === 'string' ? arg1 : undefined;
		const overrides = isConfigurationOverrides(arg1) ? arg1 : isConfigurationOverrides(arg2) ? arg2 : undefined;
		return this._configuration.getValue(section, overrides);
	}

	updateValue(key: string, value: unknown): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides): Promise<void>;
	updateValue(key: string, value: unknown, target: ConfigurationTarget): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides, target: ConfigurationTarget, options?: IConfigurationUpdateOptions): Promise<void>;
	async updateValue(key: string, value: unknown, arg3?: unknown, arg4?: unknown, _options?: IConfigurationUpdateOptions): Promise<void> {
		const overrides: IConfigurationUpdateOverrides | undefined = isConfigurationUpdateOverrides(arg3) ? arg3
			: isConfigurationOverrides(arg3) ? { resource: arg3.resource, overrideIdentifiers: arg3.overrideIdentifier ? [arg3.overrideIdentifier] : undefined } : undefined;
		const target: ConfigurationTarget | undefined = (overrides ? arg4 : arg3) as ConfigurationTarget | undefined;

		if (overrides?.overrideIdentifiers) {
			overrides.overrideIdentifiers = distinct(overrides.overrideIdentifiers);
			overrides.overrideIdentifiers = overrides.overrideIdentifiers.length ? overrides.overrideIdentifiers : undefined;
		}

		const inspect = this.inspect(key, { resource: overrides?.resource, overrideIdentifier: overrides?.overrideIdentifiers ? overrides.overrideIdentifiers[0] : undefined });
		if (inspect.policyValue !== undefined) {
			throw new Error(`Unable to write ${key} because it is configured in system policy.`);
		}

		if (this.agentsWindowReadOnlyKeys.has(key)) {
			throw new Error(`Unable to write ${key} because it is read-only in the Agents window.`);
		}

		// Remove the setting, if the value is same as default value
		if (equals(value, inspect.defaultValue)) {
			value = undefined;
		}

		if (overrides?.overrideIdentifiers?.length && overrides.overrideIdentifiers.length > 1) {
			const overrideIdentifiers = overrides.overrideIdentifiers.sort();
			const existingOverrides = this._configuration.localUserConfiguration.overrides.find(override => arrayEquals([...override.identifiers].sort(), overrideIdentifiers));
			if (existingOverrides) {
				overrides.overrideIdentifiers = existingOverrides.identifiers;
			}
		}

		const path = overrides?.overrideIdentifiers?.length ? [keyFromOverrideIdentifiers(overrides.overrideIdentifiers), key] : [key];

		const settingsResource = this.getSettingsResource(target, overrides?.resource ?? undefined);
		await this.configurationEditing.write(settingsResource, path, value);
		await this.reloadConfiguration();
	}

	/**
	 * 解析 `updateValue` 应写入的文件 —— **只有用户级** `settings.json`。
	 *
	 * `WORKSPACE` / `WORKSPACE_FOLDER` 目标会落到 `<folder>/.vscode/settings.json`，
	 * 那是**工作区内、模型可写**的文件：本项目既不从它读、也不往它写（见类注释）。
	 *
	 * 这里**明确抛错**而不是悄悄改写到用户级 —— 把「工作区作用域」静默升级成
	 * 「全局作用域」等于**放宽权限**（例如一条只想在某个仓库生效的授权变成处处生效）。
	 */
	private getSettingsResource(target: ConfigurationTarget | undefined, resource: URI | undefined): URI {
		if (target === ConfigurationTarget.WORKSPACE_FOLDER || target === ConfigurationTarget.WORKSPACE) {
			const where = resource ? (this.workspaceService.getWorkspaceFolder(resource)?.uri.fsPath ?? resource.toString()) : 'workspace';
			throw new Error(`Unable to write workspace settings for ${where}: VsSaros does not read or write '<folder>/.vscode/settings.json'.`);
		}
		return this.settingsResource;
	}

	inspect<T>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<T> {
		return this._configuration.inspect<T>(key, overrides);
	}

	keys(): { default: string[]; policy: string[]; user: string[]; workspace: string[]; workspaceFolder: string[] } {
		return this._configuration.keys();
	}

	async reloadConfiguration(_target?: ConfigurationTarget | IWorkspaceFolder): Promise<void> {
		const userModel = await this.userConfiguration.initialize();
		const previousData = this._configuration.toData();
		const change = this._configuration.compareAndUpdateLocalUserConfiguration(userModel);
		// 无 folder 级配置可重载 —— 见类注释（不读 `.vscode/settings.json`）。
		this.triggerConfigurationChange(change, previousData, ConfigurationTarget.USER);
	}

	hasCachedConfigurationDefaultsOverrides(): boolean {
		return false;
	}

	async whenRemoteConfigurationLoaded(): Promise<void> { }

	isSettingAppliedForAllProfiles(key: string): boolean {
		const scope = this.configurationRegistry.getConfigurationProperties()[key]?.scope;
		if (scope && APPLICATION_SCOPES.includes(scope)) {
			return true;
		}
		const allProfilesSettings = this.getValue<string[]>(APPLY_ALL_PROFILES_SETTING) ?? [];
		return Array.isArray(allProfilesSettings) && allProfilesSettings.includes(key);
	}

	// #endregion

	private initAgentsWindowReadOnlyKeys(): void {
		const properties = this.configurationRegistry.getConfigurationProperties();
		for (const key in properties) {
			if (properties[key].agentsWindow?.readOnly) {
				this.agentsWindowReadOnlyKeys.add(key);
			}
		}
	}

	private updateAgentsWindowReadOnlyKeys(changedProperties: string[]): void {
		const properties = this.configurationRegistry.getConfigurationProperties();
		for (const key of changedProperties) {
			if (properties[key]?.agentsWindow?.readOnly) {
				this.agentsWindowReadOnlyKeys.add(key);
			} else {
				this.agentsWindowReadOnlyKeys.delete(key);
			}
		}
	}

	// #region Configuration change handlers

	private onDefaultConfigurationChanged(defaults: ConfigurationModel, properties?: string[]): void {
		if (properties) {
			this.updateAgentsWindowReadOnlyKeys(properties);
		}
		const previousData = this._configuration.toData();
		const change = this._configuration.compareAndUpdateDefaultConfiguration(defaults, properties);
		this._configuration.updateLocalUserConfiguration(this.userConfiguration.reparse({ exclude: [...this.agentsWindowReadOnlyKeys] }));
		this.triggerConfigurationChange(change, previousData, ConfigurationTarget.DEFAULT);
	}

	private onPolicyConfigurationChanged(policyConfiguration: ConfigurationModel): void {
		const previousData = this._configuration.toData();
		const change = this._configuration.compareAndUpdatePolicyConfiguration(policyConfiguration);
		this.triggerConfigurationChange(change, previousData, ConfigurationTarget.DEFAULT);
	}

	private onUserConfigurationChanged(userConfiguration: ConfigurationModel): void {
		const previousData = this._configuration.toData();
		const change = this._configuration.compareAndUpdateLocalUserConfiguration(userConfiguration);
		this.triggerConfigurationChange(change, previousData, ConfigurationTarget.USER);
	}

	private triggerConfigurationChange(change: IConfigurationChange, previousData: IConfigurationData, target: ConfigurationTarget): void {
		if (change.keys.length) {
			const workspace = this.workspaceService.getWorkspace() as Workspace;
			const event = new ConfigurationChangeEvent(change, { data: previousData, workspace }, this._configuration, workspace, this.logService);
			event.source = target;
			this._onDidChangeConfiguration.fire(event);
		}
	}

	// #endregion
}

class ConfigurationEditing {

	private readonly queue = new Queue<void>();

	constructor(
		private readonly fileService: IFileService,
		private readonly configurationService: ConfigurationService,
	) { }

	write(settingsResource: URI, path: JSONPath, value: unknown): Promise<void> {
		return this.queue.queue(() => this.doWriteConfiguration(settingsResource, path, value));
	}

	private async doWriteConfiguration(settingsResource: URI, path: JSONPath, value: unknown): Promise<void> {
		let content: string;
		try {
			const fileContent = await this.fileService.readFile(settingsResource);
			content = fileContent.value.toString();
		} catch (error) {
			if ((error as FileOperationError).fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				content = '{}';
			} else {
				throw error;
			}
		}

		const parseErrors: ParseError[] = [];
		parse(content, parseErrors, { allowTrailingComma: true, allowEmptyContent: true });
		if (parseErrors.length > 0) {
			throw new Error('Unable to write into the settings file. Please open the file to correct errors/warnings in the file and try again.');
		}

		const edits = this.getEdits(content, path, value);
		content = applyEdits(content, edits);

		await this.fileService.writeFile(settingsResource, VSBuffer.fromString(content));
	}

	private getEdits(content: string, path: JSONPath, value: unknown): Edit[] {
		const { tabSize, insertSpaces, eol } = this.formattingOptions;

		if (!path.length) {
			const newContent = JSON.stringify(value, null, insertSpaces ? ' '.repeat(tabSize) : '\t');
			return [{
				content: newContent,
				length: content.length,
				offset: 0
			}];
		}

		return setProperty(content, path, value, { tabSize, insertSpaces, eol });
	}

	private _formattingOptions: Required<FormattingOptions> | undefined;
	private get formattingOptions(): Required<FormattingOptions> {
		if (!this._formattingOptions) {
			let eol = OS === OperatingSystem.Linux || OS === OperatingSystem.Macintosh ? '\n' : '\r\n';
			const configuredEol = this.configurationService.getValue<string>('files.eol', { overrideIdentifier: 'jsonc' });
			if (configuredEol && typeof configuredEol === 'string' && configuredEol !== 'auto') {
				eol = configuredEol;
			}
			this._formattingOptions = {
				eol,
				insertSpaces: !!this.configurationService.getValue('editor.insertSpaces', { overrideIdentifier: 'jsonc' }),
				tabSize: this.configurationService.getValue('editor.tabSize', { overrideIdentifier: 'jsonc' })
			};
		}
		return this._formattingOptions;
	}
}
