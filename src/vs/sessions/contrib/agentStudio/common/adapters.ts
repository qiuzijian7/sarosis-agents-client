/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { AgentOSError } from './errors.js';

/**
 * 适配器基类 — 所有 Provider Adapter 继承此类
 *
 * 提供通用生命周期、日志、错误处理能力。
 * 子类只需实现 `connectNativeAPI()` 方法。
 *
 * 使用示例：
 * ```typescript
 * export class OpenClawMemoryAdapter
 *   extends BaseProviderAdapter<OpenClawMemoryClient>
 *   implements IMemoryProvider { ... }
 * ```
 */
export abstract class BaseProviderAdapter<TNativeAPI> extends Disposable {

	protected _nativeAPI: TNativeAPI | undefined;
	protected readonly _logService: ILogService;
	protected readonly _context: IAgentOSPluginContext;

	constructor(
		protected readonly _pluginId: string,
		context: IAgentOSPluginContext,
	) {
		super();
		this._context = context;
		this._logService = context.logService;
	}

	// ─── 子类必须实现 ────────────────────────────────────────────────

	/**
	 * 连接到原生 API（由子类实现）
	 * 在首次调用 `ensureConnected()` 时触发。
	 */
	protected abstract connectNativeAPI(): Promise<TNativeAPI>;

	// ─── 懒初始化 ────────────────────────────────────────────────────

	/**
	 * 确保原生 API 可用（懒初始化）
	 * 线程安全：并发调用只会初始化一次。
	 */
	protected async ensureConnected(): Promise<TNativeAPI> {
		if (!this._nativeAPI) {
			this._logService.info(`[${this._pluginId}] Connecting to native API...`);
			try {
				this._nativeAPI = await this.connectNativeAPI();
				this._logService.info(`[${this._pluginId}] Native API connected`);
			} catch (error) {
				this._logService.error(`[${this._pluginId}] Failed to connect to native API`, error);
				throw this.wrapError('connect', error);
			}
		}
		return this._nativeAPI;
	}

	// ─── 错误处理 ────────────────────────────────────────────────────

	/**
	 * 错误包装：将原生错误转换为 OS 标准错误 (AgentOSError)
	 */
	protected wrapError(operation: string, error: unknown): AgentOSError {
		return new AgentOSError(
			`[${this._pluginId}] ${operation} failed`,
			error instanceof Error ? error : new Error(String(error)),
			this._pluginId,
		);
	}

	// ─── 生命周期 ────────────────────────────────────────────────────

	override dispose(): void {
		if (this._nativeAPI) {
			this._logService.info(`[${this._pluginId}] Adapter disposed, native API cleared`);
			this._nativeAPI = undefined;
		}
		super.dispose();
	}
}

// ─── Plugin Context Interface ───────────────────────────────────────────

/**
 * 插件激活时传入的上下文对象
 * 提供插件所需的 VSCode 服务和 OS 中间层访问能力。
 */
export interface IAgentOSPluginContext {
	readonly extensionPath: string;
	readonly globalStoragePath: string;
	readonly workspaceStoragePath: string;

	// VSCode 核心服务
	readonly configurationService: IConfigurationService;
	readonly logService: ILogService;
	readonly notificationService: INotificationService;
	readonly instantiationService: IInstantiationService;

	// OS 中间层（用于注册能力槽）
	readonly agentOSService: IAgentOSService;
}

// ─── Agent Capability Enum ────────────────────────────────────────────

export const enum AgentCapability {
	Model = 'model',
	Memory = 'memory',
	Tool = 'tool',
	Planning = 'planning',
	Execution = 'execution',
	Retrieval = 'retrieval',
	Kanban = 'kanban',
}

// ─── Capability Plugin Interface ───────────────────────────────────────

/**
 * Agent 能力插件接口
 * 所有 Provider 插件（OpenClaw / Hermes / Knot 等）均实现此接口。
 */
export interface IAgentCapabilityPlugin {
	readonly id: string;
	readonly name: string;
	readonly version: string;

	/**
	 * 此插件提供哪些能力槽
	 */
	readonly capabilities: AgentCapability[];

	/**
	 * 激活插件 — 在此方法中注册各能力槽的 Provider
	 */
	activate(context: IAgentOSPluginContext): Promise<void>;

	/**
	 * 停用插件 — 清理资源
	 */
	deactivate(): Promise<void>;
}

// ─── 前向类型引用 ────────────────────────────────────────────────────
// 避免循环依赖，这些接口在实际使用文件中 import

import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAgentOSService } from './agentOS.js';
