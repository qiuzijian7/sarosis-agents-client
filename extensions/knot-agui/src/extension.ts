/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentCapabilityPlugin, AgentCapability } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { IAgentOSPluginContext } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { KnotAGUIModelProvider } from './knotModelProvider.js';
import { KnotSettingsEditorPane } from './knotSettingsEditorPane.js';
import { KnotSettingsEditorInput } from './knotSettingsEditorInput.js';
import { Registry } from '../../../src/vs/platform/registry/common/platform.js';
import { IEditorPaneRegistry } from '../../../src/vs/workbench/browser/editor.js';
import { EditorExtensions } from '../../../src/vs/workbench/common/editor.js';
import { EditorPaneDescriptor } from '../../../src/vs/workbench/browser/editor.js';
import { SyncDescriptor } from '../../../src/vs/platform/instantiation/common/descriptors.js';
import { IEditorService } from '../../../src/vs/workbench/services/editor/common/editorService.js';
import { SIDE_GROUP } from '../../../src/vs/workbench/services/editor/common/editorService.js';
import { ICommandService } from '../../../src/vs/platform/commands/common/commands.js';
import { CommandsRegistry } from '../../../src/vs/platform/commands/common/commands.js';
import './media/knotSettingsEditorPane.css';

/**
 * Knot AG-UI Model Provider Plugin
 *
 * 实现 IAgentCapabilityPlugin，将 Knot AG-UI 注册为 IModelProvider。
 * 用户可在独立的 Knot Settings EditorPane 中配置 token/endpoint/agent，
 * 该 EditorPane 在左侧编辑器区域打开（而非嵌入主 Settings 页面）。
 *
 * 同时通过 package.json 中的 `contributes.chatPlugins` 声明，将 ./plugin 目录注册为
 * 标准插件，使得 ExtensionAgentPluginDiscovery 能自动发现并展示在插件页面。
 *
 * 双重注册架构:
 *   1. IAgentCapabilityPlugin → 注册 IModelProvider（扩展能力层）
 *   2. chatPlugins → 注册标准插件目录（插件发现层）
 *   3. KnotSettingsEditorPane → 独立的设置编辑器（点击插件时打开）
 *
 * 两者协同工作：插件页面的启用/禁用操作通过 EnablementModel 传播，
 * 而 Model Provider 的可用性由扩展的激活状态决定。
 */

export class KnotAguiPlugin implements IAgentCapabilityPlugin {
	readonly id = 'knot-agui';
	readonly name = 'Knot AG-UI Model Provider';
	readonly version = '1.0.0';
	readonly capabilities = [AgentCapability.Model];

	private _disposables: { dispose(): void }[] = [];
	private _provider: KnotAGUIModelProvider | undefined;
	private _editorPaneRegistered = false;

	async activate(context: IAgentOSPluginContext): Promise<void> {
		const os = context.agentOSService;
		const log = context.logService;

		log.info('[Knot-AGUI][Diag] KnotAguiPlugin.activate() called');

		// 从 Settings 读取配置（与 package.json 中的配置键保持一致）
		const config = context.configurationService;
		const token = config.getValue<string>('sessions.agentStudio.knot.token');
		const apiUrl = config.getValue<string>('sessions.agentStudio.knot.apiUrl') || '';
		const endpoint = apiUrl || 'https://knot.woa.com';
		log.info(
			`[Knot-AGUI][Diag] settings: tokenPresent=${!!token} tokenLen=${token ? String(token).length : 0} `
			+ `apiUrl=${apiUrl || '<default>'} endpoint=${endpoint}`,
		);

		// 创建 Model Provider（支持多 Agent/模型）
		this._provider = new KnotAGUIModelProvider({
			token: token || '',
			endpoint,
			configurationService: config,
			logService: log,
		});

		// 注册到 OS 中间层
		const registration = os.registerModelProvider(this._provider);
		this._disposables.push(registration);

		// Sanity-check that the provider really showed up in the OS registry.
		try {
			const providers = (os as any).getModelProviders?.() ?? [];
			log.info(
				`[Knot-AGUI][Diag] After registerModelProvider: agentOS now has `
				+ `${providers.length} provider(s) [ids=${providers.map((p: any) => p.id).join(',') || '<none>'}]`,
			);
		} catch (e) {
			log.warn('[Knot-AGUI][Diag] Could not enumerate providers post-register:', e);
		}

		// 监听配置变化（用户在 Settings 中修改 token/endpoint 时热重载）
		this._disposables.push(
			config.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('sessions.agentStudio.knot') || e.affectsConfiguration('knot')) {
					log.info('[Knot-AGUI][Diag] Config change detected (knot.*) -- reloading provider');
					this._provider?.reloadConfiguration();
				}
			}),
		);

		// Register the Knot Settings EditorPane
		this._registerSettingsEditorPane();

		// Register the openSettings command handler via agentOS
		this._registerOpenSettingsCommand(context);

		log.info('[Knot-AGUI] Plugin activated, provider registered. Settings pane available via knot.openSettings.');
	}

	/**
	 * Register KnotSettingsEditorPane with the VS Code editor pane registry.
	 * This allows KnotSettingsEditorInput to be opened in the editor area.
	 */
	private _registerSettingsEditorPane(): void {
		if (this._editorPaneRegistered) { return; }

		try {
			Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
				EditorPaneDescriptor.create(
					KnotSettingsEditorPane,
					KnotSettingsEditorPane.ID,
					'Knot Settings',
				),
				[
					new SyncDescriptor(KnotSettingsEditorInput),
				],
			);
			this._editorPaneRegistered = true;
		} catch (e) {
			// May already be registered (e.g. hot reload)
			console.warn('[Knot-AGUI] EditorPane registration warning:', e);
		}
	}

	/**
	 * Register a command to open the Knot settings pane.
	 * Called when the user clicks the Knot plugin in the plugins view.
	 */
	private _registerOpenSettingsCommand(context: IAgentOSPluginContext): void {
		const editorService = context.instantiationService.invokeFunction(
			(accessor) => accessor.get(IEditorService)
		);

		// Register the knot.openSettings command handler
		const commandRegistration = CommandsRegistry.registerCommand('knot.openSettings', (accessor) => {
			const input = KnotSettingsEditorInput.getInstance();
			editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
		});
		this._disposables.push(commandRegistration);

		// Also expose a global function for fallback usage
		(globalThis as any).__knotOpenSettings = () => {
			const input = KnotSettingsEditorInput.getInstance();
			editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
		};
	}

	async deactivate(): Promise<void> {
		this._provider = undefined;
		for (const d of this._disposables) {
			d.dispose();
		}
		this._disposables = [];
	}
}
