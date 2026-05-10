/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentCapabilityPlugin, AgentCapability } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { IAgentOSPluginContext } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { KnotAGUIModelProvider } from './knotModelProvider.js';

/**
 * Knot AG-UI Model Provider Plugin
 * 
 * 实现 IAgentCapabilityPlugin，将 Knot AG-UI 注册为 IModelProvider。
 * 用户可在 Settings 中配置 token/endpoint/agent，并在 UI 中从所有已安装的 Model Provider 中选择具体模型。
 */

export class KnotAguiPlugin implements IAgentCapabilityPlugin {
	readonly id = 'knot-agui';
	readonly name = 'Knot AG-UI Model Provider';
	readonly version = '1.0.0';
	readonly capabilities = [AgentCapability.Model];

	private _disposables: { dispose(): void }[] = [];

	async activate(context: IAgentOSPluginContext): Promise<void> {
		const os = context.agentOSService;

		// 从 Settings 读取配置
		const config = context.configurationService;
		const token = config.getValue<string>('knot.auth.token');
		const endpoint = config.getValue<string>('knot.endpoint') || 'https://knot.woa.com/api/v1';
		const defaultAgent = config.getValue<string>('knot.defaultAgent');

		// 创建 Model Provider（支持多 Agent/模型）
		const provider = new KnotAGUIModelProvider({
			token,
			endpoint,
			defaultAgent,
			configurationService: config,
			logService: context.logService,
		});

		// 注册到 OS 中间层
		this._disposables.push(os.registerModelProvider(provider));

		// 监听配置变化（用户在 Settings 中修改 token/endpoint 时热重载）
		this._disposables.push(
			config.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('knot')) {
					provider.reloadConfiguration();
				}
			}),
		);

		context.logService.info('[Knot-AGUI] Plugin activated, provider registered.');
	}

	async deactivate(): Promise<void> {
		for (const d of this._disposables) {
			d.dispose();
		}
		this._disposables = [];
	}
}
