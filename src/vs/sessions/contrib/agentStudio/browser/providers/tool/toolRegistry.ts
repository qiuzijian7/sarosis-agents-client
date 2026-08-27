/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IToolDefinition, IToolResultContent } from '../../../common/providers.js';
import { getToolsetForTool } from '../../../common/toolsetConfig.js';

type ToolHandlerResult = IToolResultContent[] | { content: IToolResultContent[]; details?: Record<string, unknown> };
type ToolHandler = (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string, sessionId?: string, toolCallId?: string) => Promise<ToolHandlerResult>;

export interface IToolDescriptor {
	readonly definition: IToolDefinition;
	readonly handler: ToolHandler;
	/** 返回 false 表示当前环境不支持该工具，listTools 会跳过它。 */
	readonly available?: () => boolean;
	/** 标记为 stub — 只有 schema 定义，没有实际 handler 实现。listTools 会跳过这些工具，防止 LLM 看到后尝试调用导致 "not yet implemented" 错误。 */
	readonly isStub?: boolean;
	/**
	 * 动态描述构建器 — 当需要提供动态工具描述时使用。
	 * 参考 Hermes-Agent 的 _build_top_level_description() 设计。
	 * 如果提供此函数，listTools() 会调用它生成动态 description，
	 * 覆盖 definition.description 的静态值。
	 */
	readonly descriptionBuilder?: (agentId: string) => string;
}

/**
 * 公共注册接口 —— 让其他 contribution（如 SkillRegistry / 扩展）也能往中枢加 tool。
 * 通过 `BuiltinToolProvider.register(descriptor)` 调用。
 */
export interface IBuiltinToolRegistration extends IToolDescriptor { }

/**
 * 工具注册表 —— 封装工具描述符集合、启用状态与变更事件，
 * 以及 IToolProvider 的列表/状态查询方法。从 BuiltinToolProvider 抽出，
 * 使主类只负责接线（各 registerXxxTools 薄包装）与工具分发（executeTool）。
 */
export class ToolRegistry {
	private readonly _tools = new Map<string, IToolDescriptor>();
	private readonly _disabledTools = new Set<string>();
	private readonly _onDidChangeTools = new Emitter<void>();
	readonly onDidChangeTools: Event<void> = this._onDidChangeTools.event;

	constructor(private readonly logService: ILogService) { }

	register(descriptor: IBuiltinToolRegistration): IDisposable {
		const name = descriptor.definition.name;
		if (this._tools.has(name)) {
			// codebaseTools 等后注册的同类工具覆盖核心工具属正常行为（如 ripgrep 版 search_files），降级避免告警噪声。
			this.logService.debug(`[BuiltinTools] overwriting existing tool: ${name}`);
		}
		this._tools.set(name, descriptor);
		this._onDidChangeTools.fire();
		return toDisposable(() => {
			if (this._tools.get(name) === descriptor) {
				this._tools.delete(name);
				this._onDidChangeTools.fire();
			}
		});
	}

	resolveTool(name: string): IToolDescriptor | undefined {
		return this._tools.get(name);
	}

	hasTool(name: string): boolean {
		return this._tools.has(name);
	}

	toolNames(): IterableIterator<string> {
		return this._tools.keys();
	}

	get size(): number {
		return this._tools.size;
	}

	async listTools(_agentId: string): Promise<IToolDefinition[]> {
		const out: IToolDefinition[] = [];
		for (const [name, t] of this._tools) {
			// 检查环境可用性
			if (t.available && !t.available()) { continue; }
			// 检查用户是否禁用了该工具
			if (this._disabledTools.has(name)) { continue; }
			// 跳过 stub 工具 — 它们只有 schema 定义，没有实际 handler 实现
			// 暴露 stub 工具给 LLM 会导致 LLM 尝试调用，返回 "not yet implemented" 错误
			if (t.isStub) { continue; }
			// 自动推断 toolset（如果 definition 中未显式设置）
			const toolset = t.definition.toolset ?? getToolsetForTool(name);
			// 如果工具有动态描述构建器，使用它生成动态描述
			if (t.descriptionBuilder) {
				const dynamicDesc = t.descriptionBuilder(_agentId);
				out.push({ ...t.definition, description: dynamicDesc, toolset });
			} else {
				out.push({ ...t.definition, toolset });
			}
		}
		return out;
	}

	/**
	 * 获取所有工具定义（包括被禁用的，供 UI 显示）
	 */
	async getAllToolDefinitions(_agentId: string): Promise<IToolDefinition[]> {
		const out: IToolDefinition[] = [];
		let stubCount = 0;
		let unavailableCount = 0;
		for (const [name, t] of this._tools) {
			if (t.available && !t.available()) { unavailableCount++; continue; }
			if (t.isStub) { stubCount++; continue; }
			const toolset = t.definition.toolset ?? getToolsetForTool(name);
			out.push({ ...t.definition, toolset });
		}
		this.logService.info(`[BuiltinTools] getAllToolDefinitions: ${out.length} tools (skipped ${stubCount} stubs, ${unavailableCount} unavailable), total registered=${this._tools.size}`);
		return out;
	}

	/**
	 * 获取工具的启用状态
	 */
	async isToolEnabled(_agentId: string, toolName: string): Promise<boolean> {
		return !this._disabledTools.has(toolName);
	}

	/**
	 * 启用工具
	 */
	async enableTool(_agentId: string, toolName: string): Promise<void> {
		if (this._disabledTools.has(toolName)) {
			this._disabledTools.delete(toolName);
			this._onDidChangeTools.fire();
			this.logService.info(`[BuiltinTools] Enabled tool: ${toolName}`);
		}
	}

	/**
	 * 禁用工具
	 */
	async disableTool(_agentId: string, toolName: string): Promise<void> {
		if (this._tools.has(toolName) && !this._disabledTools.has(toolName)) {
			this._disabledTools.add(toolName);
			this._onDidChangeTools.fire();
			this.logService.info(`[BuiltinTools] Disabled tool: ${toolName}`);
		}
	}

	/**
	 * 获取所有工具的启用状态
	 */
	async getToolsEnabledState(_agentId: string): Promise<Record<string, boolean>> {
		const state: Record<string, boolean> = {};
		for (const name of this._tools.keys()) {
			state[name] = !this._disabledTools.has(name);
		}
		return state;
	}

	/**
	 * 批量设置工具的启用状态
	 */
	async setToolsEnabledState(_agentId: string, state: Record<string, boolean>): Promise<void> {
		let changed = false;
		for (const [name, enabled] of Object.entries(state)) {
			if (!this._tools.has(name)) { continue; }
			const currentlyEnabled = !this._disabledTools.has(name);
			if (enabled && !currentlyEnabled) {
				this._disabledTools.delete(name);
				changed = true;
			} else if (!enabled && currentlyEnabled) {
				this._disabledTools.add(name);
				changed = true;
			}
		}
		if (changed) {
			this._onDidChangeTools.fire();
			this.logService.info(`[BuiltinTools] Batch updated tool enabled state`);
		}
	}
}
