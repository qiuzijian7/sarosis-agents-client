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
 *   - 使用 VS Code MCP 系统的 `tool.id` 作为路由名（含 `mcp_` 前缀 + 64 字符限制），
 *     不自创命名方案。例: `mcp_codebase-mem_get_architecture`。
 *   - 调用 `executeTool` 时按 `tool.id` 路由到对应 IMcpServer.tools 中的 IMcpTool。
 *   - tools 列表来自 IObservable，所以变化时通过 onDidChangeTools 通知 OS。
 *   - 工具描述透传 MCP server 原始描述（不自加前缀），保留 server 端的自文档化引导。
 *   - 安全等级从 MCP ToolAnnotations 推断，无注解时从描述首句启发式推断。
 *
 * NB: 该 Provider 在 web 与 desktop 端都可用。stdio 类 server 仅 desktop 能跑，
 * 但是否能跑由 IMcpService 自己决定，这里只做透明转发。
 */

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IObservable, autorun } from '../../../../../../base/common/observable.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IMcpService, IMcpServer, IMcpTool, McpConnectionState, IMcpToolCallContext } from '../../../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { IToolProvider, IToolDefinition, IToolCall, IToolResult, IToolResultContent, ToolSecurityLevel } from '../../../common/providers.js';

// 不再需要 SEPARATOR — 使用 VS Code MCP 系统的 tool.id 作为路由名

interface IRoutedTool {
	server: IMcpServer;
	tool: IMcpTool;
}

export class McpToolProvider extends Disposable implements IToolProvider {

	readonly id: string = 'saros.mcp-tools';
	readonly name: string = 'MCP Tools';

	private readonly _routes = new Map<string, IRoutedTool>();
	private readonly _disabledTools = new Set<string>();
	/** 缓存 _inferSecurityLevel 结果，避免每次 _toDefinition 调用都重新推断 */
	private readonly _securityLevelCache = new Map<string, ToolSecurityLevel>();
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

	async executeTool(_agentId: string, call: IToolCall, signal?: AbortSignal): Promise<IToolResult> {
		let routed = this._routes.get(call.name);
		// Fallback: 如果 LLM 用 tool.id（如 mcp_codebase-memo_get_architecture）调用，
		// 但路由表用的是 referenceName（如 get_architecture），尝试反向查找
		if (!routed) {
			for (const [name, entry] of this._routes) {
				if (entry.tool.id === call.name || entry.tool.referenceName === call.name) {
					routed = entry;
					this.logService.info(`[McpToolProvider] executeTool fallback: "${call.name}" → "${name}"`);
					break;
				}
			}
		}
		if (!routed) {
			return { toolCallId: call.id, success: false, content: [], error: `Unknown MCP tool: ${call.name}` };
		}
		// 检查是否已被取消
		if (signal?.aborted) {
			return { toolCallId: call.id, success: false, content: [], error: 'Tool execution was cancelled', metadata: { timedOut: true, retryable: true } };
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
		const startTime = Date.now();
		try {
			// D2: 透传 worktreePath 到 MCP 调用上下文，使 server 能感知当前任务工作根
			// （看板 / 并发任务 worktree 隔离）。call 不携带 worktreePath 时（非看板场景）
			// context 保持 undefined，行为不变。
			// IMcpToolCallContext 通过结构化类型扩展承载 worktreePath，由 server 决定是否
			// 据此切换工作根；协议层真正的 per-call cwd 隔离（roots 动态更新 / 独立实例）
			// 为中期目标，此处仅完成契约透传。
			const mcpCallContext: IMcpToolCallContext | undefined = call.worktreePath
				? ({ chatSessionResource: undefined, worktreePath: call.worktreePath } as unknown as IMcpToolCallContext)
				: undefined;
			const res = await routed.tool.call(call.arguments ?? {}, mcpCallContext, CancellationToken.None);
			const elapsed = Date.now() - startTime;
			if (res.isError) {
				const errText = this._extractErrorText(res.content);
				this.logService.warn(`[McpToolProvider] ${call.name} failed (${elapsed}ms): ${errText}`);
			} else {
				this.logService.debug(`[McpToolProvider] ${call.name} succeeded (${elapsed}ms)`);
			}
			return {
				toolCallId: call.id,
				success: !res.isError,
				content: this._adaptContent(res.content),
				error: res.isError ? this._extractErrorText(res.content) : undefined,
				metadata: { executionTimeMs: elapsed, mcpServer: routed.server.definition.id },
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[McpToolProvider] ${call.name} failed: ${msg}`);
			return { toolCallId: call.id, success: false, content: [], error: msg, metadata: { executionTimeMs: Date.now() - startTime, retryable: true } };
		}
	}

	// ─── 内部 ────────────────────────────────────────────────

	private _wire(): void {
		// 监听 IMcpService.servers，每当 server 列表或某 server 的 tools 列表变化时刷新路由表
		this._register(autorun(reader => {
			const servers = (this.mcpService.servers as IObservable<readonly IMcpServer[]>).read(reader);
			this.logService.debug(`[McpToolProvider] _wire autorun fired: ${servers.length} server(s)`);

			// 第一遍：收集所有工具和 referenceName，检测碰撞
			const allTools: Array<{ server: IMcpServer; tool: IMcpTool; refName: string }> = [];
			const refNameCount = new Map<string, number>();
			for (const server of servers) {
				const tools = server.tools.read(reader);
				const connState = server.connectionState.get();
				this.logService.debug(
					`[McpToolProvider] Server: id=${server.definition.id}, connState=${connState.state}, tools=${tools.length}`
				);
				for (const tool of tools) {
					const refName = tool.referenceName || tool.definition.name;
					allTools.push({ server, tool, refName });
					refNameCount.set(refName, (refNameCount.get(refName) ?? 0) + 1);
				}
			}

			// 第二遍：构建路由表 — 优先使用 referenceName（短名），碰撞时回退到 tool.id
			const next = new Map<string, IRoutedTool>();
			for (const { server, tool, refName } of allTools) {
				const routedName = (refNameCount.get(refName) ?? 0) <= 1 ? refName : tool.id;
				next.set(routedName, { server, tool });
				this.logService.debug(`[McpToolProvider]   route: ${routedName}${routedName === refName ? '' : ' (ref=' + refName + ')'}`);
			}

			// 仅在变化时更新（避免无意义的 onDidChange）
			if (!this._sameRoutes(next)) {
				this._routes.clear();
				this._securityLevelCache.clear();
				for (const [k, v] of next) { this._routes.set(k, v); }
				this._onDidChangeTools.fire();
				this.logService.info(`[McpToolProvider] tool routes updated: ${this._routes.size} tool(s)`);
			} else {
				this.logService.debug(`[McpToolProvider] routes unchanged (${this._routes.size} tool(s))`);
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

	private _sanitize(name: string): string {
		return name.replace(/[^A-Za-z0-9_]/g, '_');
	}

	private _toDefinition(routedName: string, server: IMcpServer, tool: IMcpTool): IToolDefinition {
		const def = tool.definition;
		// 透传 MCP server 原始描述，不自加前缀。
		// codebase-memory-mcp 的描述是自文档化的（含 "Use INSTEAD OF grep" 等引导），
		// 添加前缀会干扰 LLM 对描述语义的解析。
		const desc = def.description || `MCP tool from server "${server.definition.label}"`;
		return {
			name: routedName,
			description: desc,
			inputSchema: def.inputSchema as Record<string, unknown>,
			category: `mcp:${this._sanitize(server.definition.id)}`,
			source: this.id,
			securityLevel: this._inferSecurityLevel(tool),
		};
	}

	/**
	 * 从 MCP ToolAnnotations 或描述启发式推断安全等级。
	 *
	 * 优先级：
	 * 1. MCP 协议 annotations.readOnlyHint === true → Safe
	 * 2. MCP 协议 annotations.destructiveHint === true → Dangerous
	 * 3. 无 annotations → 从描述首句推断（首句描述主要操作，避免正文中的示例误判）
	 *
	 * 首句匹配优于全文匹配：codebase-memory-mcp 的 search_graph 描述中
	 * "update settings" 是搜索示例而非写操作，全文匹配会误判为 Dangerous。
	 */
	private _inferSecurityLevel(tool: IMcpTool): ToolSecurityLevel {
		const toolName = tool.definition.name;
		// 缓存命中 → 直接返回，不打日志
		const cached = this._securityLevelCache.get(toolName);
		if (cached !== undefined) {
			return cached;
		}

		const annotations = (tool.definition as any).annotations;
		let result: ToolSecurityLevel;
		// 1. MCP 协议标准注解
		if (annotations?.readOnlyHint === true) {
			result = ToolSecurityLevel.Safe;
			this.logService.debug(`[McpToolProvider] _inferSecurityLevel: ${toolName} → Safe (annotations.readOnlyHint=true)`);
		} else if (annotations?.destructiveHint === true) {
			result = ToolSecurityLevel.Dangerous;
			this.logService.debug(`[McpToolProvider] _inferSecurityLevel: ${toolName} → Dangerous (annotations.destructiveHint=true)`);
		} else {
			// 2. 无注解时从描述首句推断
			result = this._inferFromDescription(toolName, tool.definition.description);
		}

		this._securityLevelCache.set(toolName, result);
		return result;
	}

	/**
	 * 从描述首句推断安全等级。
	 * 取描述的第一个句子（到第一个 ". " 为止），检查是否以只读或破坏性动词开头。
	 */
	private _inferFromDescription(toolName: string, description: string | undefined): ToolSecurityLevel {
		if (!description) {
			this.logService.debug(`[McpToolProvider] _inferSecurityLevel: ${toolName} → Cautious (no description)`);
			return ToolSecurityLevel.Cautious;
		}

		// 取首句：到第一个 ". " 或前 100 字符
		const firstSentenceMatch = description.match(/^(.+?\. )/);
		const firstSentence = (firstSentenceMatch ? firstSentenceMatch[1] : description.slice(0, 100)).toLowerCase();

		// 只读动词：描述首句以这些动词开头通常表示读取/查询操作
		const readOnlyVerbs = /^(get|search|list|query|trace|read|check|find|inspect|view|show|count|detect|execute)\b/i;
		// 破坏性动词：描述首句以这些动词开头通常表示写入/修改操作
		const destructiveVerbs = /^(write|delete|create|index|ingest|manage|modify|remove|insert|build|rebuild|deploy)\b/i;

		const isReadOnly = readOnlyVerbs.test(firstSentence);
		const isDestructive = destructiveVerbs.test(firstSentence);

		let result: ToolSecurityLevel;
		if (isDestructive && !isReadOnly) {
			result = ToolSecurityLevel.Dangerous;
		} else if (isReadOnly && !isDestructive) {
			result = ToolSecurityLevel.Safe;
		} else if (isReadOnly && isDestructive) {
			// 两个都匹配（如 "create or update"）→ 偏向 Dangerous
			result = ToolSecurityLevel.Dangerous;
		} else {
			result = ToolSecurityLevel.Cautious;
		}

		this.logService.debug(`[McpToolProvider] _inferSecurityLevel: ${toolName} → ${result} (first sentence: "${firstSentence.trim().slice(0, 60)}")`);
		return result;
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
		// 收集所有 text 内容，保留 codebase-memory-mcp 返回的结构化错误中的 hint 字段
		const texts: string[] = [];
		for (const c of content) {
			if (c?.type === 'text' && typeof c.text === 'string') {
				texts.push(c.text);
			}
		}
		if (texts.length === 0) { return 'MCP tool reported error'; }
		// 多个 text 块时合并（可能包含 error + hint），用换行分隔
		return texts.join('\n');
	}

	override dispose(): void {
		this._routes.clear();
		super.dispose();
	}
}

