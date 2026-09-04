/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { IModelSelection, IModelInfo, IModelAgentInfo, ModelAuthStatus } from './providers.js';

// ─── Model Selector Service ───────────────────────────────────────────────

export const IModelSelectorService = createDecorator<IModelSelectorService>('modelSelectorService');

/**
 * 模型选择器服务 — 管理 UI 层的模型选择交互
 *
 * Model Slot 特殊性：用户需显式选择使用哪个 Provider 的哪个模型，
 * 而非由 OS 自动按优先级选择。
 *
 * 部分 Provider 支持 Agent 选择（如 Knot），此时还需选择 Agent。
 */
export interface IModelSelectorService {
	readonly _serviceBrand: undefined;

	// ─── 当前选择 ───────────────────────────────────────────────

	readonly onDidChangeSelection: Event<IModelSelection>;
	getSelection(): IModelSelection | undefined;
	setSelection(selection: IModelSelection): void;

	/**
	 * 获取指定 agent 专属的模型选择（若该 agent 曾选过 provider/model）。
	 * 未配置时回退到全局当前选择 `getSelection()`。
	 * 用于让「知识库专家」等 agent 拥有独立的 provider/model 配置。
	 */
	getSelectionForAgent(agentId: string): IModelSelection | undefined;

	/**
	 * 获取指定 agent 显式专属的模型选择（仅当用户曾为该 agent 单独选过
	 * provider/model 时返回，不会回退到全局当前选择）。
	 * 用于判断「知识库专家」等 agent 是否被用户单独配置过。
	 */
	getExplicitSelectionForAgent(agentId: string): IModelSelection | undefined;

	/**
	 * 为指定 agent 保存其专属的模型选择。
	 */
	setSelectionForAgent(agentId: string, selection: IModelSelection): void;

	// ─── 可用模型列表（汇聚所有已注册 Model Provider）────────────────

	readonly onDidChangeAvailableModels: Event<void>;
	getAvailableModels(): Promise<IModelSelectorItem[]>;

	// ─── Agent 选择（仅支持 Agent 的 Provider）────────────────────

	/**
	 * 当前选中的 Provider 是否支持 Agent 选择
	 */
	currentProviderSupportsAgents(): boolean;

	/**
	 * 获取当前 Provider 的 Agent 列表
	 */
	getAvailableAgents(): Promise<IModelAgentInfo[]>;

	/**
	 * 获取当前选中的 Agent ID
	 */
	getSelectedAgentId(): string | undefined;

	/**
	 * 设置选中的 Agent ID（会更新 IModelSelection）
	 */
	setSelectedAgentId(agentId: string | undefined): void;

	readonly onDidChangeAgent: Event<string | undefined>;

	// ─── UI 操作 ───────────────────────────────────────────────

	/**
	 * 显示快速选择器（QuickPick）— 选择 Provider/Model
	 */
	showQuickPick(): Promise<IModelSelection | undefined>;

	/**
	 * 显示 Agent 选择器（QuickPick）— 仅当 Provider 支持 Agent 时可用
	 */
	showAgentQuickPick(): Promise<string | undefined>;

	/**
	 * 打开对应 Provider 的设置页面
	 */
	openSettings(providerId?: string): void;
}

// ─── Model Selector Item ─────────────────────────────────────────────────

/**
 * 模型选择器列表项（UI 展示用）
 */
export interface IModelSelectorItem {
	readonly provider: IModelSelectorProviderInfo;
	readonly model: IModelInfo;
}

export interface IModelSelectorProviderInfo {
	readonly id: string;          // e.g. 'demo-agui'
	readonly name: string;        // e.g. 'Knot AG-UI'
	readonly icon?: string;       // URI string
	readonly authStatus: ModelAuthStatus;
	/** Whether the provider supports agent selection (e.g. knot) */
	readonly supportsAgents?: boolean;
}

// ─── Model Selection Storage ──────────────────────────────────────────────

/**
 * 模型选择持久化（存储在 workspace/global state）
 */
export interface IModelSelectionStorage {
	/**
	 * 全局默认模型（Settings 配置）
	 */
	getGlobalDefault(): IModelSelection | undefined;
	setGlobalDefault(selection: IModelSelection): void;

	/**
	 * 工作区级别覆盖
	 */
	getWorkspaceSelection(): IModelSelection | undefined;
	setWorkspaceSelection(selection: IModelSelection): void;

	/**
	 * 最近使用记录
	 */
	getRecentSelections(limit?: number): IModelSelection[];
	addRecentSelection(selection: IModelSelection): void;
}
