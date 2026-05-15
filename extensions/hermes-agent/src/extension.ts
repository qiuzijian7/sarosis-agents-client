/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentCapabilityPlugin, AgentCapability, IAgentOSPluginContext } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { HermesModelProvider } from './hermesModelProvider.js';
import { HermesExecutionProvider } from './hermesExecutionProvider.js';
import { HermesToolProvider } from './hermesToolProvider.js';
import { HermesMemoryProvider } from './hermesMemoryProvider.js';
import { HermesBridge } from './hermesBridge.js';
import { HermesSettingsEditorPane } from './hermesSettingsEditorPane.js';
import { HermesSettingsEditorInput } from './hermesSettingsEditorInput.js';
import { Registry } from '../../../src/vs/platform/registry/common/platform.js';
import { IEditorPaneRegistry } from '../../../src/vs/workbench/browser/editor.js';
import { EditorExtensions } from '../../../src/vs/workbench/common/editor.js';
import { EditorPaneDescriptor } from '../../../src/vs/workbench/browser/editor.js';
import { SyncDescriptor } from '../../../src/vs/platform/instantiation/common/descriptors.js';
import { IEditorService } from '../../../src/vs/workbench/services/editor/common/editorService.js';
import { SIDE_GROUP } from '../../../src/vs/workbench/services/editor/common/editorService.js';
import './media/hermesSettingsEditorPane.css';

/**
 * Hermes Agent Plugin
 *
 * 实现 IAgentCapabilityPlugin，将 Hermes Agent 注册为多能力槽 Provider。
 * 支持可插拔架构，在插件内容框中显示配置界面。
 *
 * 四大能力槽:
 *   1. Model     — 28+ 模型提供商 (Anthropic, OpenRouter, Gemini, etc.)
 *   2. Execution — AIAgent.run_conversation() 自主执行循环
 *   3. Tool      — 70+ 内置工具 (web, files, terminal, browser, etc.)
 *   4. Memory    — 内置文件记忆 + 9 种插件记忆提供商
 *
 * 双重注册架构 (与 knot-agui 一致):
 *   1. IAgentCapabilityPlugin → 注册 4 个能力槽 Provider (扩展能力层)
 *   2. chatPlugins → 注册标准插件目录 (插件发现层，显示在插件页面)
 *   3. HermesSettingsEditorPane → 独立的设置编辑器 (点击插件时打开)
 *
 * 内嵌 hermes/ 目录关联完整仓库代码，方便升级:
 *   - hermes/ 目录包含 hermes-agent 完整源码
 *   - 支持通过 git pull 升级仓库版本
 *   - 通过 "Hermes: Upgrade Repository" 命令触发升级
 *   - 也可配置 sessions.agentStudio.hermes.hermesSourcePath 指向外部仓库
 */

const HERMES_CONFIG_PREFIX = 'sessions.agentStudio.hermes';

export class HermesAgentPlugin implements IAgentCapabilityPlugin {
	readonly id = 'hermes-agent';
	readonly name = 'Hermes Agent';
	readonly version = '1.0.0';
	readonly capabilities = [
		AgentCapability.Model,
		AgentCapability.Execution,
		AgentCapability.Tool,
		AgentCapability.Memory,
	];

	private _disposables: { dispose(): void }[] = [];
	private _modelProvider: HermesModelProvider | undefined;
	private _executionProvider: HermesExecutionProvider | undefined;
	private _toolProvider: HermesToolProvider | undefined;
	private _memoryProvider: HermesMemoryProvider | undefined;
	private _bridge: HermesBridge | undefined;
	private _editorPaneRegistered = false;
	private _context: IAgentOSPluginContext | undefined;

	async activate(context: IAgentOSPluginContext): Promise<void> {
		const os = context.agentOSService;
		const config = context.configurationService;
		this._context = context;

		context.logService.info('[Hermes] Plugin activating...');

		// ─── 1. 创建共享 Bridge 进程 ────────────────────────────
		const bridgeConfig = {
			pythonPath: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.pythonPath`) || 'python3',
			hermesSourcePath: HermesBridge.resolveHermesSourcePath({
				hermesSourcePath: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.hermesSourcePath`) || '',
			}),
			hermesHome: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.hermesHome`) || '',
			provider: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.provider`) || '',
			model: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.model`) || '',
			apiKey: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.apiKey`) || '',
			baseUrl: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.baseUrl`) || '',
			enabledToolsets: config.getValue<string[]>(`${HERMES_CONFIG_PREFIX}.enabledToolsets`) || [],
			disabledToolsets: config.getValue<string[]>(`${HERMES_CONFIG_PREFIX}.disabledToolsets`) || [],
			maxIterations: config.getValue<number>(`${HERMES_CONFIG_PREFIX}.maxIterations`) || 90,
			memoryProvider: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.memoryProvider`) || '',
			timeout: config.getValue<number>('hermes.timeout') || 300000,
			streaming: config.getValue<boolean>('hermes.streaming') ?? true,
		};

		this._bridge = new HermesBridge(bridgeConfig);
		(globalThis as any).__hermesBridge = this._bridge;

		// Auto-start if configured
		const autoStart = config.getValue<boolean>(`${HERMES_CONFIG_PREFIX}.autoStart`) ?? true;
		if (autoStart) {
			try {
				await this._bridge.start();
				context.logService.info('[Hermes] Bridge started successfully');
			} catch (err) {
				context.logService.warn('[Hermes] Bridge auto-start failed (will retry on first use):', err);
			}
		}

		// ─── 2. 创建并注册 4 个能力槽 Provider ──────────────────

		// Model Provider (28+ model providers)
		this._modelProvider = new HermesModelProvider(context);
		this._disposables.push(os.registerModelProvider(this._modelProvider));

		// Execution Provider (AIAgent.run_conversation loop)
		this._executionProvider = new HermesExecutionProvider(context);
		this._disposables.push(os.registerExecutionProvider(this._executionProvider));

		// Tool Provider (70+ built-in tools)
		this._toolProvider = new HermesToolProvider(context);
		this._disposables.push(os.registerToolProvider(this._toolProvider));

		// Memory Provider (built-in + 9 plugin providers)
		this._memoryProvider = new HermesMemoryProvider(context);
		this._disposables.push(os.registerMemoryProvider(this._memoryProvider));

		// ─── 3. 监听配置变化 ────────────────────────────────────

		this._disposables.push(
			config.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(HERMES_CONFIG_PREFIX) || e.affectsConfiguration('hermes')) {
					this._onConfigChanged();
				}
			}),
		);

		// ─── 4. 注册设置 EditorPane ─────────────────────────────

		this._registerSettingsEditorPane();
		this._registerOpenSettingsCommand(context);

		// ─── 5. 注册命令处理 ─────────────────────────────────────

		this._registerCommandHandlers(context);

		context.logService.info('[Hermes] Plugin activated. All 4 capability providers registered. Settings pane available via hermes.openSettings.');
	}

	// ─── Command Handlers ──────────────────────────────────────

	private _registerCommandHandlers(context: IAgentOSPluginContext): void {
		const bridge = this._bridge;

		// hermes.start
		(globalThis as any).__hermesStart = async () => {
			if (!bridge) { return; }
			try {
				await bridge.start();
				context.logService.info('[Hermes] Bridge started');
			} catch (err) {
				context.notificationService.error(`Failed to start Hermes bridge: ${err}`);
			}
		};

		// hermes.stop
		(globalThis as any).__hermesStop = async () => {
			if (!bridge) { return; }
			await bridge.stop();
			context.logService.info('[Hermes] Bridge stopped');
		};

		// hermes.restart
		(globalThis as any).__hermesRestart = async () => {
			if (!bridge) { return; }
			await bridge.restart();
			context.logService.info('[Hermes] Bridge restarted');
		};

		// hermes.selectModel
		(globalThis as any).__hermesSelectModel = async () => {
			// This triggers the model selector UI
			if (this._modelProvider) {
				await this._modelProvider.reloadConfiguration();
			}
		};

		// hermes.listTools
		(globalThis as any).__hermesListTools = async () => {
			if (!bridge?.isRunning) {
				context.notificationService.info('Hermes bridge is not running. Start it first.');
				return;
			}
			try {
				const tools = await bridge.request('list_tools', {}) as Array<{ name: string; toolset: string; description: string }>;
				context.notificationService.info(`Hermes has ${tools.length} tools available across ${new Set(tools.map(t => t.toolset)).size} toolsets.`);
			} catch (err) {
				context.notificationService.error(`Failed to list tools: ${err}`);
			}
		};

		// hermes.upgradeRepo
		(globalThis as any).__hermesUpgradeRepo = async () => {
			const config = context.configurationService;
			const sourcePath = config.getValue<string>(`${HERMES_CONFIG_PREFIX}.hermesSourcePath`)
				|| HermesBridge.resolveHermesSourcePath({ hermesSourcePath: '' });

			context.notificationService.info(`Upgrading Hermes repository at ${sourcePath}...`);
			// The actual git pull will be done by the bridge or a script
			try {
				await bridge?.request('upgrade_repo', { path: sourcePath });
				context.notificationService.info('Hermes repository upgraded successfully.');
			} catch (err) {
				context.notificationService.warn(`Upgrade requires manual git pull in ${sourcePath}`);
			}
		};

		// hermes.installDeps
		(globalThis as any).__hermesInstallDeps = async () => {
			const config = context.configurationService;
			const pythonPath = config.getValue<string>(`${HERMES_CONFIG_PREFIX}.pythonPath`) || 'python3';
			const sourcePath = config.getValue<string>(`${HERMES_CONFIG_PREFIX}.hermesSourcePath`)
				|| HermesBridge.resolveHermesSourcePath({ hermesSourcePath: '' });

			context.notificationService.info(`Installing Hermes dependencies in ${sourcePath}...`);
			try {
				await bridge?.request('install_deps', { pythonPath, path: sourcePath });
				context.notificationService.info('Hermes dependencies installed successfully.');
			} catch (err) {
				context.notificationService.warn(`Install deps failed: ${err}. Try running: ${pythonPath} -m pip install -e ${sourcePath}`);
			}
		};
	}

	// ─── Settings Editor Pane ───────────────────────────────────

	private _registerSettingsEditorPane(): void {
		if (this._editorPaneRegistered) { return; }

		try {
			Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
				EditorPaneDescriptor.create(
					HermesSettingsEditorPane,
					HermesSettingsEditorPane.ID,
					'Hermes Settings',
				),
				[
					new SyncDescriptor(HermesSettingsEditorInput),
				],
			);
			this._editorPaneRegistered = true;
		} catch (e) {
			console.warn('[Hermes] EditorPane registration warning:', e);
		}
	}

	private _registerOpenSettingsCommand(context: IAgentOSPluginContext): void {
		const editorService = context.instantiationService.invokeFunction(
			(accessor) => accessor.get(IEditorService)
		);

		(globalThis as any).__hermesOpenSettings = () => {
			const input = HermesSettingsEditorInput.getInstance();
			editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
		};
	}

	// ─── Config Change ─────────────────────────────────────────

	private async _onConfigChanged(): Promise<void> {
		if (!this._context) { return; }

		const config = this._context.configurationService;
		const newConfig = {
			pythonPath: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.pythonPath`) || 'python3',
			hermesSourcePath: HermesBridge.resolveHermesSourcePath({
				hermesSourcePath: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.hermesSourcePath`) || '',
			}),
			hermesHome: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.hermesHome`) || '',
			provider: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.provider`) || '',
			model: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.model`) || '',
			apiKey: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.apiKey`) || '',
			baseUrl: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.baseUrl`) || '',
			enabledToolsets: config.getValue<string[]>(`${HERMES_CONFIG_PREFIX}.enabledToolsets`) || [],
			disabledToolsets: config.getValue<string[]>(`${HERMES_CONFIG_PREFIX}.disabledToolsets`) || [],
			maxIterations: config.getValue<number>(`${HERMES_CONFIG_PREFIX}.maxIterations`) || 90,
			memoryProvider: config.getValue<string>(`${HERMES_CONFIG_PREFIX}.memoryProvider`) || '',
			timeout: config.getValue<number>('hermes.timeout') || 300000,
			streaming: config.getValue<boolean>('hermes.streaming') ?? true,
		};

		if (this._bridge) {
			this._bridge.updateConfig(newConfig);
			try {
				await this._bridge.restart();
				await this._modelProvider?.reloadConfiguration();
				this._toolProvider?.invalidateCache();
			} catch (err) {
				this._context.logService.error('[Hermes] Config change restart failed:', err);
			}
		}
	}

	// ─── Deactivation ───────────────────────────────────────────

	async deactivate(): Promise<void> {
		if (this._bridge) {
			await this._bridge.stop();
			this._bridge = undefined;
			(globalThis as any).__hermesBridge = undefined;
		}

		this._modelProvider = undefined;
		this._executionProvider = undefined;
		this._toolProvider = undefined;
		this._memoryProvider = undefined;

		for (const d of this._disposables) {
			d.dispose();
		}
		this._disposables = [];
		this._context = undefined;
	}
}
