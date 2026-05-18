/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP Tool Provider —— 把上游 VSCode 的 IMcpService 暴露的工具桥接为 IToolProvider。
 *
 * 设计要点：
 *   - 不重新实现 MCP 客户端：上游 `vs/workbench/contrib/mcp/common/mcpService.ts`
 *     已经做完了 server 发现、stdio/http 传输、能力协商、tools 列表 observable。
 *   - 我们只观察 `IMcpService.servers`，把每台 server 的 `tools` 平铺成
 *     `<serverPrefix>.<toolName>` 形式，避免命名冲突 —— 与 hermes 的
 *     `mcp-<server>` toolset 命名思路同构。
 *   - 调用 `executeTool` 时按前缀路由到对应 IMcpServer.tools 中的 IMcpTool。
 *   - tools 列表来自 IObservable，所以变化时通过 onDidChangeTools 通知 OS。
 *
 * NB: 该 Provider 在 web 与 desktop 端都可用。stdio 类 server 仅 desktop 能跑，
 * 但是否能跑由 IMcpService 自己决定，这里只做透明转发。
 */

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IObservable, autorun } from '../../../../../../base/common/observable.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IMcpService, IMcpServer, IMcpTool, McpConnectionState } from '../../../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { IToolProvider, IToolDefinition, IToolCall, IToolResult, IToolResultContent } from '../../../common/providers.js';

const SEPARATOR = '__'; // tool name 中的 server-prefix 与原 tool name 之间的分隔符

interface IRoutedTool {
	server: IMcpServer;
	tool: IMcpTool;
}

export class McpToolProvider extends Disposable implements IToolProvider {

	readonly id: string = 'sarosis.mcp-tools';
	readonly name: string = 'MCP Tools';

	private readonly _routes = new Map<string, IRoutedTool>();
	private readonly _disabledTools = new Set<string>();
	private readonly _onDidChangeTools = this._register(new Emitter<void>());
	readonly onDidChangeTools: Event<void> = this._onDidChangeTools.event;

	constructor(
		@IMcpService private readonly mcpService: IMcpService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._wire();
	}

	async listTools(_agentId: string): Promise<IToolDefinition[]> {
		const out: IToolDefinition[] = [];
		for (const [routedName, { server, tool }] of this._routes) {
			// 跳过被用户禁用的工具
			if (this._disabledTools.has(routedName)) { continue; }
			out.push(this._toDefinition(routedName, server, tool));
		}
		return out;
	}

	/**
	 * 获取所有工具定义（包括被禁用的，供 UI 显示）
	 */
	async getAllToolDefinitions(_agentId: string): Promise<IToolDefinition[]> {
		const out: IToolDefinition[] = [];
		for (const [routedName, { server, tool }] of this._routes) {
			out.push(this._toDefinition(routedName, server, tool));
		}
		return out;
	}

	/**
	 * 检查工具是否已启用
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
			this.logService.info(`[McpToolProvider] Enabled tool: ${toolName}`);
		}
	}

	/**
	 * 禁用工具
	 */
	async disableTool(_agentId: string, toolName: string): Promise<void> {
		if (this._routes.has(toolName) && !this._disabledTools.has(toolName)) {
			this._disabledTools.add(toolName);
			this._onDidChangeTools.fire();
			this.logService.info(`[McpToolProvider] Disabled tool: ${toolName}`);
		}
	}

	/**
	 * 获取所有工具的启用状态
	 */
	async getToolsEnabledState(_agentId: string): Promise<Record<string, boolean>> {
		const state: Record<string, boolean> = {};
		for (const name of this._routes.keys()) {
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
			if (!this._routes.has(name)) { continue; }
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
			this.logService.info(`[McpToolProvider] Batch updated tool enabled state`);
		}
	}

	async executeTool(_agentId: string, call: IToolCall): Promise<IToolResult> {
		const routed = this._routes.get(call.name);
		if (!routed) {
			return { toolCallId: call.id, success: false, content: [], error: `Unknown MCP tool: ${call.name}` };
		}
		// 等待 server 启动到 Running 状态
		const state = routed.server.connectionState.get();
		if (state.state === McpConnectionState.Kind.Stopped || state.state === McpConnectionState.Kind.Error) {
			try {
				await routed.server.start();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { toolCallId: call.id, success: false, content: [], error: `MCP server start failed: ${msg}` };
			}
		}
		try {
			const res = await routed.tool.call(call.arguments ?? {}, undefined, CancellationToken.None);
			return {
				toolCallId: call.id,
				success: !res.isError,
				content: this._adaptContent(res.content),
				error: res.isError ? this._extractErrorText(res.content) : undefined,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[McpToolProvider] ${call.name} failed: ${msg}`);
			return { toolCallId: call.id, success: false, content: [], error: msg };
		}
	}

	// ─── 内部 ────────────────────────────────────────────────

	private _wire(): void {
		// 监听 IMcpService.servers，每当 server 列表或某 server 的 tools 列表变化时刷新路由表
		this._register(autorun(reader => {
			const servers = (this.mcpService.servers as IObservable<readonly IMcpServer[]>).read(reader);
			const next = new Map<string, IRoutedTool>();
			for (const server of servers) {
				const tools = server.tools.read(reader);
				const prefix = this._serverPrefix(server);
				for (const tool of tools) {
					const routedName = `${prefix}${SEPARATOR}${this._sanitize(tool.definition.name)}`;
					next.set(routedName, { server, tool });
				}
			}
			// 仅在变化时更新（避免无意义的 onDidChange）
			if (!this._sameRoutes(next)) {
				this._routes.clear();
				for (const [k, v] of next) { this._routes.set(k, v); }
				this._onDidChangeTools.fire();
				this.logService.info(`[McpToolProvider] tool routes updated: ${this._routes.size} tool(s)`);
			}
		}));
	}

	private _sameRoutes(next: Map<string, IRoutedTool>): boolean {
		if (next.size !== this._routes.size) { return false; }
		for (const k of next.keys()) {
			if (!this._routes.has(k)) { return false; }
		}
		return true;
	}

	private _serverPrefix(server: IMcpServer): string {
		// IMcpServer.definition.id 在所有 collection 中是稳定的，按 hermes 同款做 sanitize
		return this._sanitize(server.definition.id);
	}

	private _sanitize(name: string): string {
		return name.replace(/[^A-Za-z0-9_]/g, '_');
	}

	private _toDefinition(routedName: string, server: IMcpServer, tool: IMcpTool): IToolDefinition {
		const def = tool.definition;
		const desc = def.description
			? `[via MCP server "${server.definition.label}"] ${def.description}`
			: `MCP tool from "${server.definition.label}"`;
		return {
			name: routedName,
			description: desc,
			inputSchema: def.inputSchema as Record<string, unknown>,
			category: `mcp:${this._sanitize(server.definition.id)}`,
			source: this.id,
		};
	}

	private _adaptContent(content: readonly any[] | undefined): IToolResultContent[] {
		if (!content) { return []; }
		const out: IToolResultContent[] = [];
		for (const c of content) {
			if (!c || typeof c !== 'object') { continue; }
			switch (c.type) {
				case 'text':
					out.push({ type: 'text', text: String(c.text ?? '') });
					break;
				case 'image':
					out.push({ type: 'image', data: String(c.data ?? ''), mimeType: String(c.mimeType ?? 'image/png') });
					break;
				case 'resource':
				case 'resource_link':
					out.push({ type: 'resource', text: String(c.uri ?? c.resource?.uri ?? ''), mimeType: c.mimeType });
					break;
				default:
					// 未知类型转字符串保留信息
					out.push({ type: 'text', text: JSON.stringify(c) });
			}
		}
		return out;
	}

	private _extractErrorText(content: readonly any[] | undefined): string {
		if (!content) { return 'MCP tool reported error'; }
		for (const c of content) {
			if (c?.type === 'text' && typeof c.text === 'string') { return c.text; }
		}
		return 'MCP tool reported error';
	}

	override dispose(): void {
		this._routes.clear();
		super.dispose();
	}
}

