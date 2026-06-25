/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内置 Tool Provider —— 见 `common/providers.ts` 中的 `IToolProvider` 契约。
 *
 * 设计借鉴 Hermes-Agent `tools/registry.py`：
 *   - 每个工具用一个常量描述符注册（schema + handler + check）。
 *   - `category` 充当 hermes 的 toolset，便于 UI 按组展示与启停。
 *   - `check_fn` 决定该工具在当前环境是否可用（例如 shell_exec 仅在桌面端）。
 *
 * 与 hermes 不同的地方：
 *   - 这里的 handler 是 TS async 函数，返回 IToolResultContent[]（更贴合 IMcpTool 风格）。
 *   - 不做 prompt-cache TTL 缓存（VSCode renderer 周期短，不必要）。
 *   - 文件操作走 IFileService，而非 Node.js fs；所以在 web 端也能跑 file_read/file_write。
 *
 * 工具集合：
 *   utility   : echo, get_current_time, math_eval
 *   filesystem: file_read, file_write, file_list, search_files
 *   shell     : shell_exec (仅 desktop)
 *   web       : http_get, web_search (web_search 需要外部 provider，未配置则降级)
 *
 *   另外，从 Hermes-Agent 迁移了 69 个 bundled tool 定义（schema-only）。
 *   这些工具只有 schema，handler 为存根，返回"未实现"提示。
 *   实际执行需通过 MCP 服务器或后续实现的 Provider。
 */

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IFileService, FileType } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { INativeEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { IRequestService, asText } from '../../../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IToolProvider, IToolDefinition, IToolCall, IToolResult, IToolResultContent, ToolSecurityLevel, IAgentTurnRequest, IChatStreamDelta } from '../../../common/providers.js';
import { BUNDLED_TOOL_DEFINITIONS } from '../../../common/bundled-tools/bundledTools.js';
import { ISkillRegistry } from '../../../common/skills.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ITerminalService } from '../../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IAgentStudioService, ITaskOrchestrationService, IAgentTaskBoardService } from '../../../../../common/agentStudioService.js';
import { TaskBoardStatus, TaskSource } from '../../../common/types.js';
import { ITriageService } from '../../../common/triageService.js';
import { ISwarmService, SwarmWorkerSpec } from '../../../common/swarmService.js';
import { ICheckpointService } from '../../../common/checkpointService.js';
import { IAgentOSService } from '../../../common/agentOS.js';
import { SubAgentType, SubAgentResult, UnifiedSubAgentDispatch } from '../../../common/unifiedSubAgentDispatch.js';
import { IterationBudget } from '../../../common/iterationBudget.js';
import { IWorkflowStorageService, IStoredWorkflow } from '../../../common/workflowStorage.js';
import { resolveWorkspacePath } from '../../../common/workspacePathResolver.js';


type ToolHandler = (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => Promise<IToolResultContent[]>;

/**
 * Kanban 工具中已实现真实 handler 的名字集合。
 * 这些工具由 _registerKanbanTools() 注册，_registerBundledTools() 会跳过它们的 stub。
 */
	const KANBAN_TOOLS_WITH_HANDLER = new Set<string>([
	'kanban_create',
	'kanban_complete',
	'kanban_block',
	'kanban_unblock',
	'kanban_show',
	'kanban_list',
	'kanban_heartbeat',
	'kanban_comment',
	'kanban_link',
	'kanban_specify',
	'kanban_decompose',
	'kanban_swarm',
]);

/**
 * Workflow 工具中已实现真实 handler 的名字集合。
 * 这些工具由 _registerWorkflowTools() 注册，_registerBundledTools() 会跳过它们的 stub。
 */
const WORKFLOW_TOOLS_WITH_HANDLER = new Set<string>([
	'workflow_list',
	'workflow_get',
	'workflow_get_schema',
	'workflow_apply',
]);

/**
 * Module-level Emitter for AI-driven workflow changes.
 * Defined outside the class to avoid TDZ (Temporal Dead Zone) issues
 * with static field initializers referencing the class itself.
 * The controller subscribes to `.event`; the workflow_apply handler fires it.
 */
export const workflowAppliedEmitter = new Emitter<{ workflow: IStoredWorkflow; description?: string }>();

interface IToolDescriptor {
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

export class BuiltinToolProvider extends Disposable implements IToolProvider {

	readonly id: string = 'saros.builtin-tools';
	readonly name: string = 'Sarosis Built-in Tools';

	private readonly _tools = new Map<string, IToolDescriptor>();
	private readonly _disabledTools = new Set<string>();
	private readonly _onDidChangeTools = this._register(new Emitter<void>());
	readonly onDidChangeTools: Event<void> = this._onDidChangeTools.event;

	// v17: worktree path inherited from the parent agent's execution context.
	// Set by `setParentWorktreePath()` before each turn; cleared on turn end.
	// Used by the `delegate_task` tool to propagate the worktree to sub-agents.
	private _parentWorktreePath: string | undefined;

	/**
	 * v17: set the worktree path inherited from the parent agent's request.
	 * This is consulted by the `delegate_task` tool when dispatching
	 * sub-agents so the entire subagent tree operates in the same worktree.
	 */
	setParentWorktreePath(path: string | undefined): void {
		this._parentWorktreePath = path;
	}

	/**
	 * v17: read the currently-set parent worktree (used by delegate_task).
	 */
	getParentWorktreePath(): string | undefined {
		return this._parentWorktreePath;
	}

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IRequestService private readonly requestService: IRequestService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IAgentStudioService private readonly studioService: IAgentStudioService,
		@IAgentOSService private readonly agentOS: IAgentOSService,
		@ITaskOrchestrationService private readonly orchestrationService: ITaskOrchestrationService,
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
		@ITriageService private readonly triageService: ITriageService,
		@ISwarmService private readonly swarmService: ISwarmService,
	@ICheckpointService private readonly checkpointService: ICheckpointService,
	@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
	@IWorkflowStorageService private readonly workflowStorageService: IWorkflowStorageService,
	) {
		super();
		this._registerCoreTools();
		this._registerMemoryTools();
		this._registerSkillTools();
		this._registerBundledTools();
		this._registerDelegationTools();
		this._registerKanbanTools();
		this._registerWorkflowTools();
	}

	// ─── 路径安全校验 ─────────────────────────────────────────────────────

	/**
	 * 检查请求的路径是否在允许的工作区目录内，并将相对路径解析为绝对路径。
	 * 同时检查 VS Code 工作区文件夹和 Sarosis Agent 工作区路径。
	 * Windows 路径大小写不敏感。
	 *
	 * @param agentId 当前 agent 的 ID，用于查找 Sarosis workspace 路径
	 * @param requestedPath 请求的文件/目录路径（支持相对路径，如 "."、"./src"）
	 * @returns 解析后的绝对路径
	 * @throws Error 如果路径不在任何允许的工作区内
	 */
	private async _resolveAndCheckWorkspacePath(agentId: string | undefined, requestedPath: string): Promise<string> {
		// 收集所有允许的根路径
		const allowedRoots: string[] = [];

		// ─── 优先判定：worktree 独占沙箱 ───────────────────────────────
		// 沙箱边界【只】取决于 AgentBinding.worktreePath（per-workspace × agent
		// 的运行时实例状态）。Agent 本身是全局定义，不携带 worktreePath；
		// 同一 agent 在不同 workspace 下可绑定不同 worktree，故必须按
		// (workspaceId × agentId) 查 binding。
		// 这是一条独立逻辑——表示"该 agent 运行时被限制在此 worktree 内"。
		// 切勿 fallback 到 Workspace.worktreePath：后者是【另一条独立逻辑】
		// （用户切换当前工作区的 SCM 视角，由 sourceControl.contribution 处理），
		// 与 agent 沙箱无关，二者不可耦合。
		// 工具执行无 sessionId 上下文，按 Q2 兜底用 getActiveWorkspaceId() 解析
		// 当前运行 workspace。
		let worktreeRoot: string | undefined;
		let activeWsId: string | undefined;
		if (agentId) {
			try {
				activeWsId = this.studioService.getActiveWorkspaceId();
				if (activeWsId) {
					const binding = await this.studioService.getAgentBinding(activeWsId, agentId);
					if (binding?.worktreePath) {
						worktreeRoot = binding.worktreePath.replace(/[\\/]+$/, '');
					}
				}
			} catch (err) {
				this.logService.warn(`[BuiltinTools] Failed to resolve worktree for agent ${agentId}:`, err);
			}
		}

		if (worktreeRoot) {
			// 独占模式：仅允许 worktree 目录
			allowedRoots.push(worktreeRoot);
			this.logService.info(`[BuiltinTools] Agent ${agentId} is worktree-sandboxed to: ${worktreeRoot}`);
		} else {
			// ─── 常规模式：未绑定 worktree，沿用多根工作区 ───────────────
			// 1. VS Code 工作区文件夹
			const vscodeFolders = this.workspaceService.getWorkspace().folders;
			for (const folder of vscodeFolders) {
				allowedRoots.push(folder.uri.fsPath.replace(/[\\/]+$/, ''));
			}

			// 2. Sarosis Agent 工作区路径（agent 是全局，运行 workspace 取自
			//    getActiveWorkspaceId — 已在上面解析为 activeWsId）。
			if (activeWsId) {
				try {
					const workspace = await this.studioService.getWorkspace(activeWsId);
					if (workspace?.path) {
						allowedRoots.push(workspace.path.replace(/[\\/]+$/, ''));
					}
					// 关联代码仓库（多仓库管理）— 全部纳入沙箱允许根
					for (const rf of workspace?.relatedFolders ?? []) {
						if (rf?.path) {
							allowedRoots.push(rf.path.replace(/[\\/]+$/, ''));
						}
					}
				} catch (err) {
					this.logService.warn(`[BuiltinTools] Failed to resolve Sarosis workspace for agent ${agentId}:`, err);
				}
			}
		}

		// 边界校验：用 URI + isEqualOrParent（见 workspacePathResolver.ts），
		// 替代旧的手动 `canonicalize`（一刀切 toLowerCase + startsWith）。
		// 后者在大小写敏感文件系统（Linux）上会把 `/Foo/x` 误判为落在 `/foo`
		// 沙箱内，是一处跨平台越界隐患；新实现按 scheme/平台正确处理大小写、
		// 盘符与正/反斜杠归一化。
		const { resolvedPath, isAllowed, normalizedRoots } = resolveWorkspacePath(requestedPath, allowedRoots);

		if (!isAllowed) {
			const allowedList = normalizedRoots.length > 0
				? normalizedRoots.map(r => `  - ${r}`).join('\n')
				: '  (无 — 请确认已正确配置工作区)';
			if (worktreeRoot) {
				throw new Error(
					`安全沙箱限制：该 Agent 实例已绑定 worktree，仅允许在 worktree 目录内操作。\n` +
					`路径 "${requestedPath}" (解析后: "${resolvedPath}") 超出了 worktree 边界。\n` +
					`当前 worktree 工作区：\n${allowedList}\n` +
					`请在该 worktree 目录内操作。如需访问其它目录，请解除该 Agent 的 worktree 绑定。`
				);
			}
			throw new Error(
				`安全沙箱限制：路径 "${requestedPath}" (解析后: "${resolvedPath}") 不在允许的工作区目录内。\n` +
				`当前允许的工作区目录：\n${allowedList}\n` +
				`请在上述目录内操作，或在 Sarosis 工作区设置中配置正确的路径。`
			);
		}

		return resolvedPath;
	}

	// ─── IToolProvider 实现 ─────────────────────────────────────────────

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
		// 如果工具有动态描述构建器，使用它生成动态描述
		if (t.descriptionBuilder) {
			const dynamicDesc = t.descriptionBuilder(_agentId);
			out.push({ ...t.definition, description: dynamicDesc });
		} else {
			out.push(t.definition);
		}
	}
	return out;
}

	/**
	 * 获取所有工具定义（包括被禁用的，供 UI 显示）
	 */
	async getAllToolDefinitions(_agentId: string): Promise<IToolDefinition[]> {
		const out: IToolDefinition[] = [];
		for (const t of this._tools.values()) {
			if (t.available && !t.available()) { continue; }
			out.push(t.definition);
		}
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

	async executeTool(_agentId: string, toolCall: IToolCall, signal?: AbortSignal): Promise<IToolResult> {
		const t = this._tools.get(toolCall.name);
		if (!t) {
			return {
				toolCallId: toolCall.id,
				success: false,
				content: [],
				error: `Unknown tool: ${toolCall.name}`,
			};
		}
		if (t.available && !t.available()) {
			return {
				toolCallId: toolCall.id,
				success: false,
				content: [],
				error: `Tool not available in this environment: ${toolCall.name}`,
			};
		}
		// 检查 abort signal
		if (signal?.aborted) {
			return {
				toolCallId: toolCall.id,
				success: false,
				content: [],
				error: 'Tool execution was cancelled',
				metadata: { timedOut: true, retryable: true },
			};
		}
		const startTime = Date.now();
		try {
			const content = await t.handler(toolCall.arguments ?? {}, signal, _agentId);
			return {
				toolCallId: toolCall.id,
				success: true,
				content,
				metadata: { executionTimeMs: Date.now() - startTime },
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[BuiltinTools] ${toolCall.name} failed: ${msg}`);
			return {
				toolCallId: toolCall.id,
				success: false,
				content: [],
				error: msg,
				metadata: { executionTimeMs: Date.now() - startTime, retryable: true },
			};
		}
	}

	// ─── 公共注册接口 ───────────────────────────────────────────────────

	register(descriptor: IBuiltinToolRegistration): IDisposable {
		const name = descriptor.definition.name;
		if (this._tools.has(name)) {
			this.logService.warn(`[BuiltinTools] overwriting existing tool: ${name}`);
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

	// ─── 内置工具集 ─────────────────────────────────────────────────────

	private _registerCoreTools(): void {
		this.logService.info('[BuiltinTools] _registerCoreTools: starting to register core tools');
		const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

		// ── utility ─────────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'echo',
				description: 'Echo back the input text. Mostly used to verify tool plumbing.',
				inputSchema: {
					type: 'object',
					properties: { text: { type: 'string', description: 'Text to echo' } },
					required: ['text'],
				},
				category: 'utility',
				source: this.id,
			},
			handler: async args => text(String(args['text'] ?? '')),
		});

		this.register({
			definition: {
				name: 'get_current_time',
				description: 'Return the current date/time. Optionally formatted in UTC.',
				inputSchema: {
					type: 'object',
					properties: { utc: { type: 'boolean', description: 'Use UTC formatting' } },
				},
				category: 'utility',
				source: this.id,
			},
			handler: async args => {
				const now = new Date();
				return text(args['utc'] ? now.toISOString() : now.toLocaleString());
			},
		});

		this.register({
			definition: {
				name: 'math_eval',
				description: 'Evaluate a simple arithmetic expression. Only +,-,*,/,(),. and digits are allowed.',
				inputSchema: {
					type: 'object',
					properties: { expr: { type: 'string', description: 'Arithmetic expression' } },
					required: ['expr'],
				},
				category: 'utility',
				source: this.id,
			},
			handler: async args => {
				const expr = String(args['expr'] ?? '');
				if (!/^[\d+\-*/().\s]+$/.test(expr)) {
					throw new Error('expression contains forbidden characters');
				}
				// eslint-disable-next-line no-new-func
				const fn = new Function(`"use strict"; return (${expr});`);
				return text(String(fn()));
			},
		});

		// ── filesystem ─────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'file_read',
				description: 'Read a UTF-8 text file. Returns the full file content (max 256 KiB).',
				inputSchema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Absolute path or workspace-relative path' },
					},
					required: ['path'],
				},
				category: 'filesystem',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const requestedPath = String(args['path'] || '');
				if (!requestedPath) {
					throw new Error('path is required');
				}

				// 路径遍历保护：检查请求的路径是否在工作区目录内，并将相对路径解析为绝对路径
				const resolvedPath = await this._resolveAndCheckWorkspacePath(agentId, requestedPath);

				const normalizedUri = URI.file(resolvedPath);
				const buf = await this.fileService.readFile(normalizedUri);
				if (buf.value.byteLength > 256 * 1024) {
					throw new Error(`file too large (${buf.value.byteLength} bytes), use a streaming tool`);
				}
				return text(buf.value.toString());
			},
		});

		this.register({
			definition: {
				name: 'file_write',
				description: 'Write a UTF-8 text file (overwrites). Creates parent directories as needed.',
				inputSchema: {
					type: 'object',
					properties: {
						path: { type: 'string' },
						content: { type: 'string' },
					},
					required: ['path', 'content'],
				},
				category: 'filesystem',
				source: this.id,
				securityLevel: ToolSecurityLevel.Dangerous,
			},
			handler: async (args, _signal, agentId) => {
				const requestedPath = String(args['path'] || '');
				if (!requestedPath) {
					throw new Error('path is required');
				}

				// 路径遍历保护：检查请求的路径是否在工作区目录内，并将相对路径解析为绝对路径
				const resolvedPath = await this._resolveAndCheckWorkspacePath(agentId, requestedPath);

				const normalizedUri = URI.file(resolvedPath);
				const content = String(args['content'] ?? '');
				// Checkpoint (Void-inspired): snapshot the file's current content
				// BEFORE overwriting, so the user can time-travel back to this state.
				// Pass the new content so the checkpoint can compute +N/-N diff stats.
				if (agentId) {
					await this.checkpointService.captureBeforeToolEdit(agentId, normalizedUri.toString(), content);
				}
				await this.fileService.writeFile(normalizedUri, VSBuffer.fromString(content));
				return text(`wrote ${content.length} chars to ${normalizedUri.fsPath}`);
			},
		});

		this.register({
			definition: {
				name: 'file_list',
				description: 'List entries in a directory. Returns an array of { name, type, size }.',
				inputSchema: {
					type: 'object',
					properties: { path: { type: 'string' } },
					required: ['path'],
				},
				category: 'filesystem',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const requestedPath = String(args['path'] || '');
				if (!requestedPath) {
					throw new Error('path is required');
				}

				// 路径遍历保护：检查请求的路径是否在工作区目录内，并将相对路径解析为绝对路径
				const resolvedPath = await this._resolveAndCheckWorkspacePath(agentId, requestedPath);

				const normalizedUri = URI.file(resolvedPath);
				const stat = await this.fileService.resolve(normalizedUri);
				const rows = (stat.children ?? []).map(c => ({
					name: c.name,
					type: c.isDirectory ? 'dir' : 'file',
					size: typeof c.size === 'number' ? c.size : 0,
				}));
				return [{ type: 'text', text: JSON.stringify(rows, null, 2) }];
			},
		});

		this.register({
			definition: {
				name: 'search_files',
				description: 'Recursively grep a directory for a literal substring. Returns matching path:line snippets.',
				inputSchema: {
					type: 'object',
					properties: {
						path: { type: 'string' },
						query: { type: 'string' },
						maxResults: { type: 'number', description: 'Default 50' },
					},
					required: ['path', 'query'],
				},
				category: 'filesystem',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const requestedPath = String(args['path'] || '');
				if (!requestedPath) {
					throw new Error('path is required');
				}

				// 路径遍历保护：检查请求的路径是否在工作区目录内，并将相对路径解析为绝对路径
				const resolvedPath = await this._resolveAndCheckWorkspacePath(agentId, requestedPath);

				const normalizedUri = URI.file(resolvedPath);
				const query = String(args['query'] ?? '');
				const limit = Math.min(Math.max(Number(args['maxResults'] ?? 50), 1), 500);
				if (!query) { throw new Error('query is required'); }
				const hits: string[] = [];
				await this._walkAndGrep(normalizedUri, query, hits, limit, _signal);
				return [{ type: 'text', text: hits.join('\n') || '(no matches)' }];
			},
		});

		// ── terminal ────────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'terminal',
				description: 'Execute a shell command and return the output. Works on desktop only. Returns stdout, stderr, and exit code.',
				inputSchema: {
					type: 'object',
					properties: {
						command: { type: 'string', description: 'Shell command to execute' },
						cwd: { type: 'string', description: 'Working directory (defaults to workspace root)' },
						timeout: { type: 'number', description: 'Command timeout in seconds (default: 30)' },
					},
					required: ['command'],
				},
				category: 'terminal',
				source: this.id,
				securityLevel: ToolSecurityLevel.Dangerous,
			},
			available: () => typeof process !== 'undefined' || typeof navigator !== 'undefined',
			handler: async (args, signal, agentId) => {
				const command = String(args['command'] ?? '').trim();
				if (!command) { throw new Error('command is required'); }
				// cwd 必须落在 agent 的允许工作区内：传了就校验越界，没传则解析为有效根
				// （绑定 worktree 的 agent 即 worktree 根，否则为工作区根）。
				const requestedCwd = args['cwd'] ? String(args['cwd']) : '.';
				const resolvedCwd = await this._resolveAndCheckWorkspacePath(agentId, requestedCwd);
				const timeoutSec = Math.min(Math.max(Number(args['timeout'] ?? 30), 1), 300);

				return this._executeTerminalCommand(command, resolvedCwd, timeoutSec, signal);
			},
		});

		// ── web ────────────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'http_get',
				description: 'HTTP GET request. Returns response body as text (max 1 MiB).',
				inputSchema: {
					type: 'object',
					properties: {
						url: { type: 'string' },
						headers: { type: 'object', additionalProperties: { type: 'string' } },
					},
					required: ['url'],
				},
				category: 'web',
				source: this.id,
				securityLevel: ToolSecurityLevel.Cautious,
			},
			handler: async args => {
				const url = String(args['url'] ?? '');
				if (!/^https?:\/\//i.test(url)) {
					throw new Error('url must start with http:// or https://');
				}
				const headers = (args['headers'] as Record<string, string> | undefined) ?? {};
				const ctx = await this.requestService.request({ type: 'GET', url, headers, callSite: 'saros.builtinTool.http_get' }, CancellationToken.None);
				const body = (await asText(ctx)) ?? '';
				if (body.length > 1024 * 1024) {
					throw new Error('response body exceeded 1 MiB');
				}
				return text(`HTTP ${ctx.res.statusCode}\n\n${body.slice(0, 1024 * 1024)}`);
			},
		});
	}

	// ─── Memory 召回工具 ─────────────────────────────────────────────

	/**
	 * 注册 Memory 相关工具。
	 *
	 * 设计动机：LLM 在 system prompt 里反复看到 “recall / 召回 / save and recall” 等字眼
	 * （来自 tdb-am-memory 扩展描述、bundledTools 描述、builtinMemoryProvider 提示等），
	 * 经常会幻觉调用一个不存在的 `recall` 工具，导致 toolCallUtils 抛出
	 * `Tool "recall" does not exist` 错误。
	 *
	 * 这里把幻觉变成实际能力：通过 IAgentOSService.getActiveMemoryProvider().searchMemory()
	 * 调用当前活跃的 Memory Provider（默认 builtinMemoryProvider；接入 TDB-AM 后是
	 * TdbAmMemoryProvider，会走 vendor /search/memories）。
	 *
	 * 懒查询：在 handler 内部解析 provider，避免构造期循环依赖（builtinToolProvider 自身
	 * 也是 IToolProvider，会被 IAgentOSService 注册）。
	 */

	/** 记忆去重相似度阈值（Jaccard 相似度 ≥ 此值视为重复） */
	private static readonly MEMORY_DUPLICATE_THRESHOLD = 0.85;

	/**
	 * 计算两段文本的相似度（基于字符 3-gram 的 Jaccard 相似度）。
	 * 返回值范围 [0, 1]，1 表示完全相同。
	 *
	 * 选择 Jaccard + 字符 n-gram 的原因：
	 *   - 实现简单，无外部依赖；
	 *   - 对短文本（记忆条目通常 < 500 字）效果较好；
	 *   - 对拼写错误、词序变化有一定鲁棒性。
	 */
	private _computeTextSimilarity(text1: string, text2: string): number {
		const s1 = text1.toLowerCase().trim();
		const s2 = text2.toLowerCase().trim();
		if (s1 === s2) { return 1.0; }
		if (Math.abs(s1.length - s2.length) > Math.max(s1.length, s2.length) * 0.3) {
			// 长度差异超过 30% 大概率不相似，快速返回 0 以节省计算
			return 0.0;
		}

		const n = 3; // character n-gram size
		const getNgrams = (s: string): Set<string> => {
			if (s.length < n) { return new Set([s]); }
			const grams = new Set<string>();
			for (let i = 0; i <= s.length - n; i++) {
				grams.add(s.slice(i, i + n));
			}
			return grams;
		};

		const g1 = getNgrams(s1);
		const g2 = getNgrams(s2);
		const intersection = new Set([...g1].filter(g => g2.has(g)));
		const union = new Set([...g1, ...g2]);
		if (union.size === 0) { return 1.0; }
		return intersection.size / union.size;
	}

	/**
	 * 检查新记忆内容是否与已有记忆重复。
	 * 返回重复记忆的 id；若无重复返回 null。
	 */
	private _findDuplicateMemory(entries: Array<{ id: string; content: string; [key: string]: unknown }>, newContent: string): string | null {
		for (const entry of entries) {
			const sim = this._computeTextSimilarity(entry.content, newContent);
			if (sim >= BuiltinToolProvider.MEMORY_DUPLICATE_THRESHOLD) {
				return entry.id;
			}
		}
		return null;
	}

	private _registerMemoryTools(): void {
		const self = this;

		// ── memory_remember ─────────────────────────────────────
		this.register({
			definition: {
				name: 'memory_remember',
				description: 'Save a memory entry (short-term or long-term). Use this to persist important information across sessions. Automatically detects and merges duplicate content (similarity >= 0.85) by updating the existing entry.',
				inputSchema: { type: 'object', properties: {
					content: { type: 'string', description: 'Memory content to save' },
					memory_type: { type: 'string', enum: ['short_term', 'long_term'], description: 'Memory type (default: long_term)' },
					tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering' },
					importance: { type: 'number', description: 'Importance score 0-10 (default: 5)' },
				}, required: ['content'] },
				category: 'memory',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				if (!agentId) { return [{ type: 'text', text: 'memory_remember error: agentId is required' }]; }
				const content = args['content'] as string;
				if (!content) { return [{ type: 'text', text: 'memory_remember error: content is required' }]; }
				const memType = (args['memory_type'] as string || 'long_term') === 'short_term' ? 'short_term' : 'long_term';
				const tags = Array.isArray(args['tags']) ? args['tags'] as string[] : undefined;
				const importance = typeof args['importance'] === 'number' ? Math.max(0, Math.min(10, args['importance'] as number)) : 5;
				const entry = {
					id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
					type: memType,
					content,
					timestamp: Date.now(),
					importance,
					metadata: tags ? { tags } : undefined,
				};
				const file = self._getMemFile(agentId, memType === 'short_term' ? 'short-term.jsonl' : 'long-term.jsonl');
				try { await self.fileService.createFolder(URI.joinPath(file, '..')); } catch {}
				const existing = await self._readJsonl(file);

				// 去重检查：若与新内容相似的记忆已存在，则更新已有记忆而非重复写入
				const dupId = self._findDuplicateMemory(existing, content);
				if (dupId) {
					// 更新已有记忆：刷新时间戳，若新重要性更高则覆盖
					const idx = existing.findIndex((e: any) => e.id === dupId);
					if (idx >= 0) {
						existing[idx].timestamp = Date.now();
						if (importance > (existing[idx].importance ?? 5)) {
							existing[idx].importance = importance;
						}
						if (tags) { existing[idx].metadata = { ...(existing[idx].metadata ?? {}), tags }; }
					}
					if (memType === 'short_term') { while (existing.length > 200) existing.shift(); }
					await self._writeAtomic(file, existing);
					return [{ type: 'text', text: `Memory updated (duplicate detected, similarity >= ${BuiltinToolProvider.MEMORY_DUPLICATE_THRESHOLD}): ${content.slice(0, 100)}\n[memory_file: ${file.toString()}]` }];
				}

				// 无重复，写入新记忆
				existing.push(entry);
				if (memType === 'short_term') { while (existing.length > 200) existing.shift(); }
				await self._writeAtomic(file, existing);
				return [{ type: 'text', text: `Memory saved (${memType}, importance=${importance}): ${content.slice(0, 100)}\n[memory_file: ${file.toString()}]` }];
			},
		});

		// ── memory_search ──────────────────────────────────────
		this.register({
			definition: {
				name: 'memory_search',
				description: 'Search memories by keyword, tag, or time range. Returns matching entries sorted by recency.',
				inputSchema: { type: 'object', properties: {
					query: { type: 'string', description: "Search query. Supports prefixes: tag:foo, type:short, type:long, after:YYYY-MM-DD, before:YYYY-MM-DD, recent:7d (or 24h)" },
					limit: { type: 'number', description: 'Max results (default: 10)' },
				}, required: ['query'] },
				category: 'memory',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				if (!agentId) { return [{ type: 'text', text: 'memory_search error: agentId is required' }]; }
				const query = (args['query'] as string) || '';
				const limit = typeof args['limit'] === 'number' ? Math.min(args['limit'] as number, 50) : 10;
				let typeFilter: 'short_term' | 'long_term' | undefined;
				let tagFilter: string | undefined;
				const tokens = query.split(/\s+/);
				const remaining: string[] = [];
				for (const tok of tokens) {
					if (tok.startsWith('type:')) {
						const v = tok.slice(5);
						typeFilter = v === 'short' ? 'short_term' : v === 'long' ? 'long_term' : undefined;
					} else if (tok.startsWith('tag:')) {
						tagFilter = tok.slice(4);
					} else {
						remaining.push(tok);
					}
				}
				const textQuery = remaining.join(' ').trim().toLowerCase();
				const [shortTerm, longTerm] = await Promise.all([
					typeFilter === 'long_term' ? Promise.resolve([] as any[]) : self._readJsonl(self._getMemFile(agentId, 'short-term.jsonl')),
					typeFilter === 'short_term' ? Promise.resolve([] as any[]) : self._readJsonl(self._getMemFile(agentId, 'long-term.jsonl')),
				]);
				const all = [...shortTerm, ...longTerm];
				const matched = all.filter(e => {
					if (textQuery && !e.content.toLowerCase().includes(textQuery)) { return false; }
					if (tagFilter) {
						const tags = (e.metadata?.['tags'] as string[] | undefined) ?? [];
						if (!Array.isArray(tags) || !tags.includes(tagFilter)) { return false; }
					}
					return true;
				});
				matched.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
				const slice = matched.slice(0, limit);
			if (slice.length === 0) { return [{ type: 'text', text: 'No matching memories found.' }]; }
			const lines = slice.map(e => `- [${e.type}] ${new Date(e.timestamp).toLocaleString()}: ${e.content.slice(0, 200)}`);
			const memFiles = [
				`[memory_file: ${self._getMemFile(agentId, 'short-term.jsonl').toString()}]`,
				`[memory_file: ${self._getMemFile(agentId, 'long-term.jsonl').toString()}]`,
			];
			return [{ type: 'text', text: `Found ${slice.length} matching memories:\n${lines.join('\n')}\n${memFiles.join('\n')}` }];
			},
		});

		// ── memory_delete ──────────────────────────────────────
		this.register({
			definition: {
				name: 'memory_delete',
				description: 'Delete a memory entry by its ID. Use memory_search first to find the entry ID.',
				inputSchema: { type: 'object', properties: {
					id: { type: 'string', description: 'Memory entry ID to delete' },
					memory_type: { type: 'string', enum: ['short_term', 'long_term'], description: 'Memory type to delete from' },
				}, required: ['id', 'memory_type'] },
				category: 'memory',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				if (!agentId) { return [{ type: 'text', text: 'memory_delete error: agentId is required' }]; }
				const id = args['id'] as string;
				const memType = (args['memory_type'] as string || 'long_term') === 'short_term' ? 'short_term' : 'long_term';
				if (!id) { return [{ type: 'text', text: 'memory_delete error: id is required' }]; }
				const file = self._getMemFile(agentId, memType === 'short_term' ? 'short-term.jsonl' : 'long-term.jsonl');
				const existing = await self._readJsonl(file);
				const before = existing.length;
				const filtered = existing.filter(e => e.id !== id);
			if (filtered.length === before) {
				return [{ type: 'text', text: `Memory entry ${id} not found in ${memType}.\n[memory_file: ${file.toString()}]` }];
			}
			await self._writeAtomic(file, filtered);
			return [{ type: 'text', text: `Deleted memory entry ${id} from ${memType}.\n[memory_file: ${file.toString()}]` }];
			},
		});

		// ── memory_list ────────────────────────────────────────
		this.register({
			definition: {
				name: 'memory_list',
				description: 'List all memory entries of a given type.',
				inputSchema: { type: 'object', properties: {
					memory_type: { type: 'string', enum: ['short_term', 'long_term'], description: 'Memory type to list (default: long_term)' },
					limit: { type: 'number', description: 'Max entries to return (default: 20)' },
				} },
				category: 'memory',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				if (!agentId) { return [{ type: 'text', text: 'memory_list error: agentId is required' }]; }
				const memType = (args['memory_type'] as string || 'long_term') === 'short_term' ? 'short_term' : 'long_term';
				const limit = typeof args['limit'] === 'number' ? Math.min(args['limit'] as number, 50) : 20;
				const file = self._getMemFile(agentId, memType === 'short_term' ? 'short-term.jsonl' : 'long-term.jsonl');
				const entries = await self._readJsonl(file);
				entries.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
				const slice = entries.slice(0, limit);
			if (slice.length === 0) { return [{ type: 'text', text: `No ${memType} memories found.\n[memory_file: ${file.toString()}]` }]; }
			const lines = slice.map(e => `[${e.id.slice(-8)}] ${new Date(e.timestamp).toLocaleString()}: ${e.content.slice(0, 200)}`);
			return [{ type: 'text', text: `${memType} memories (${slice.length}/${entries.length}):\n${lines.join('\n')}\n[memory_file: ${file.toString()}]` }];
			},
		});

		this.logService.info('[BuiltinTools] _registerMemoryTools: 4 memory tools registered');
	}

	// ─── Skill 按需读取工具 ───────────────────────────────────────

	/**
	 * 注册 Skill 相关工具 —— 借鉴 OpenClaw 的按需加载模式。
	 * 模型在 systemPrompt 中看到轻量目录后，通过这些工具按需读取完整内容。
	 */
	private _registerSkillTools(): void {
		const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];
		const MAX_SKILL_BYTES = 256_000; // 单个 skill 内容上限 256KB

		this.register({
			definition: {
				name: 'read_skill',
				description: 'Read the full instructions of an installed skill by its id. Use this when you need detailed instructions from a skill listed in <available_skills>.',
				inputSchema: {
					type: 'object',
					properties: {
						skill_id: {
							type: 'string',
							description: 'The skill id (from <available_skills> in system prompt)',
						},
					},
					required: ['skill_id'],
				},
				category: 'skills',
				source: this.id,
			},
			handler: async args => {
				const skillId = String(args['skill_id'] ?? '').trim();
				if (!skillId) {
					throw new Error('skill_id is required');
				}

				const skill = this.skillRegistry.getSkill(skillId);
				if (!skill) {
					// 尝试模糊匹配（按 name）
					const allSkills = this.skillRegistry.getSkills();
					const byName = allSkills.find(s => s.name.toLowerCase() === skillId.toLowerCase());
					if (byName) {
						const content = byName.prompt.slice(0, MAX_SKILL_BYTES);
						return text([
							`# Skill: ${byName.name}`,
							byName.description ? `_${byName.description}_` : '',
							`Activation: ${byName.activation}`,
							byName.match ? `Match keywords: ${byName.match.join(', ')}` : '',
							byName.recommendedTools ? `Recommended tools: ${byName.recommendedTools.join(', ')}` : '',
							'',
							'---',
							'',
							content,
						].filter(Boolean).join('\n'));
					}
					throw new Error(`Skill not found: "${skillId}". Use list_skills to see available skill ids.`);
				}

				const content = skill.prompt.slice(0, MAX_SKILL_BYTES);
				return text([
					`# Skill: ${skill.name}`,
					skill.description ? `_${skill.description}_` : '',
					`Activation: ${skill.activation}`,
					skill.match ? `Match keywords: ${skill.match.join(', ')}` : '',
					skill.recommendedTools ? `Recommended tools: ${skill.recommendedTools.join(', ')}` : '',
					'',
					'---',
					'',
					content,
				].filter(Boolean).join('\n'));
			},
		});

		this.register({
			definition: {
				name: 'list_skills',
				description: 'List all installed skills with their ids, names, descriptions, and activation modes. Use when you need to browse or search available skills.',
				inputSchema: {
					type: 'object',
					properties: {
						filter: {
							type: 'string',
							description: 'Optional keyword to filter skills by name or description',
						},
						category: {
							type: 'string',
							description: 'Optional category to filter by',
						},
					},
				},
				category: 'skills',
				source: this.id,
			},
			handler: async args => {
				const filter = String(args['filter'] ?? '').toLowerCase().trim();
				const category = String(args['category'] ?? '').toLowerCase().trim();

				let skills = [...this.skillRegistry.getSkills()].filter(s => s.enabled !== false);

				if (filter) {
					skills = skills.filter(s =>
						s.name.toLowerCase().includes(filter) ||
						s.description.toLowerCase().includes(filter) ||
						(s.match?.some(m => m.toLowerCase().includes(filter)) ?? false)
					);
				}
				if (category) {
					skills = skills.filter(s => (s.category ?? '').toLowerCase() === category);
				}

				if (skills.length === 0) {
					return text('No skills found matching the given criteria.');
				}

				const rows = skills.map(s => [
					`- **${s.name}** (id: \`${s.id}\`)`,
					`  ${s.description || 'No description'}`,
					`  Activation: ${s.activation} | Source: ${s.source}${s.category ? ` | Category: ${s.category}` : ''}`,
				].join('\n'));

				return text([
					`Found ${skills.length} skill(s):`,
					'',
					...rows,
				].join('\n'));
			},
		});

		this.logService.info('[BuiltinTools] _registerSkillTools: read_skill and list_skills registered');
	}

	/**
	 * 执行终端命令并收集输出。
	 * 创建一个临时终端实例，发送命令，收集输出，然后销毁终端。
	 */
	private async _executeTerminalCommand(
		command: string,
		cwd: string | undefined,
		timeoutSec: number,
		signal?: AbortSignal,
	): Promise<IToolResultContent[]> {
		// 如果已被取消，直接返回
		if (signal?.aborted) {
			return [{ type: 'text', text: 'Command execution was cancelled before it started.' }];
		}

		try {
			// 工作目录：调用方已通过 _resolveAndCheckWorkspacePath 校验为允许根内的绝对路径。
			// 仅在异常缺失时回退到 VS Code 工作区文件夹（不应发生）。
			const workspaceFolders = this.workspaceService.getWorkspace().folders;
			const effectiveCwd = cwd ?? (workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined);

			// 创建临时终端实例
			const instance = await this.terminalService.createTerminal({
				config: {
					type: 'Task',
					name: `Agent: ${command.slice(0, 40)}`,
					cwd: effectiveCwd,
					isFeatureTerminal: true,
					hideFromUser: false,
				},
			});

			if (!instance) {
				return [{ type: 'text', text: `Error: Failed to create terminal instance for command execution.` }];
			}

			// 收集输出数据
			const outputChunks: string[] = [];
			let dataListener: IDisposable | undefined;
			let exitListener: IDisposable | undefined;

			const IDLE_TIMEOUT_MS = 1500; // 1.5s 无新输出视为命令完成

			const outputPromise = new Promise<string>((resolve) => {
				let idleTimer: ReturnType<typeof setTimeout>;

				const markIdle = () => {
					clearTimeout(idleTimer);
					idleTimer = setTimeout(() => resolve(''), IDLE_TIMEOUT_MS);
				};

				// 监听数据输出
				dataListener = instance.onData((data: string) => {
					// 去除 ANSI 转义序列和终端垃圾信息
					const clean = data
						// ANSI SGR (颜色、样式)
						.replace(/\x1b\[[0-9;:?]*[a-zA-Z]/g, '')
						// ANSI OSC (窗口标题等)
						.replace(/\x1b\][^\x07]*\x07/g, '')
						.replace(/\x1b\][^\x1b]*\x1b\\/g, '')
						// 其他控制字符
						.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
						.replace(/\r\n/g, '\n')
						.replace(/\r/g, '\n');
					outputChunks.push(clean);
					markIdle();
				});

				// 监听退出（非交互式 shell 可能触发）
				exitListener = instance.onExit((e) => {
					clearTimeout(idleTimer);
					const code = typeof e === 'number' ? e : (e as any).exitCode;
					resolve(`Exit code: ${code}\n`);
				});

				// 初始 idle 计时器（处理无输出命令）
				idleTimer = setTimeout(() => resolve(''), IDLE_TIMEOUT_MS);
			});

			// v27: hard cap timeout at 60s regardless of user input. Reasons:
			// 1. Long-running interactive commands (REPL, watch, tail -f) can
			//    keep onData firing and starve the 1.5s idle timer; the user
			//    asked for 300s but the actual hang is unbounded.
			// 2. If the host event loop is saturated (e.g. WorkspaceExplorer
			//    re-render loop flooding the log), setTimeout callbacks can
			//    be delayed for many seconds — `Math.min(maxSec, 60)` ensures
			//    the tool always returns within a reasonable time.
			// 3. Per the user's stuck-terminal bug report, default 30s
			//    wasn't enough because the timeout itself didn't fire while
			//    the event loop was busy. Capping at 60s gives the underlying
			//    Promise.race a tight bound that will fire under load.
			const hardCapMs = 60_000;
			const timeoutMs = Math.min(timeoutSec * 1000, hardCapMs);

			// v27: log the actual command at the start of execution so the
			// log shows what was sent (currently only the tool name is
			// logged, which makes debugging hangs like this one painful —
			// we can't tell from the log whether the agent sent `dir`,
			// `tail -f`, or an interactive command).
			this.logService.info(
				`[BuiltinTools] terminal: command="${command.slice(0, 200)}" cwd=${effectiveCwd ?? '(none)'} ` +
				`timeout=${timeoutSec}s hardCap=${hardCapMs}ms`,
			);

			// v27: defensive `await instance.sendText(command, true)` — if
			// the underlying transport hangs, the abort/timeout promises
			// can't be set up because we never reach `Promise.race`. We
			// race the sendText itself against a 5s cushion past the
			// hard cap to ensure no matter which sub-step hangs, the tool
			// always returns.
			const sendTextTimeoutMs = hardCapMs + 5_000;
			const sendTextTimeout = new Promise<void>((resolve) => {
				setTimeout(() => resolve(), sendTextTimeoutMs);
			});
			await Promise.race([instance.sendText(command, true), sendTextTimeout]);

			// 等待输出或超时
			let result = '';

			const abortPromise = signal
				? new Promise<string>((resolve) => {
					const onAbort = () => resolve('[CANCELLED] Command execution was cancelled by user.\n');
					signal.addEventListener('abort', onAbort, { once: true });
				})
				: new Promise<string>(() => { /* never resolves */ });

			const timeoutPromise = new Promise<string>((resolve) => {
				setTimeout(() => resolve(`[TIMEOUT] Command timed out after ${timeoutMs / 1000}s\n`), timeoutMs);
			});

			result = await Promise.race([outputPromise, timeoutPromise, abortPromise]);

			// 等待一小段时间让剩余数据到达
			await new Promise<void>(resolve => setTimeout(resolve, 300));

			// 清理监听器
			dataListener?.dispose();
			exitListener?.dispose();

			// 合并输出
			let fullOutput = outputChunks.join('') + result;

			// 后处理：去除 PowerShell 欢迎信息、提示符重复等多余内容
			fullOutput = fullOutput
				// PowerShell 版本提示行
				.replace(/PowerShell\s+\d+\.\d+\.\d+.*\n?/gi, '')
				// 升级通知
				.replace(/A new PowerShell stable release is available:.*\n?/gi, '')
				.replace(/Upgrade now, or check out the release page at:.*\n?/gi, '')
				.replace(/https:\/\/aka\.ms\/PowerShell-Release\?tag=.*\n?/gi, '')
				// 多余的空行压缩
				.replace(/\n{3,}/g, '\n\n')
				.trim();

			// 尝试销毁终端实例
			try {
				if (instance) {
					instance.dispose();
				}
			} catch { /* ignore */ }

			// 截断过长输出
			const maxLen = 65536;
			const truncated = fullOutput.length > maxLen;
			const finalOutput = truncated
				? fullOutput.slice(0, maxLen) + `\n... (output truncated, ${fullOutput.length - maxLen} chars omitted)`
				: fullOutput;

			return [{ type: 'text', text: finalOutput || '(no output)' }];
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return [{ type: 'text', text: `Error executing command: ${msg}` }];
		}
	}

	/**
	 * 加载从 Hermes-Agent 迁移的打包工具定义。
	 * 这些工具只有 schema，handler 为存根，引导用户配置 MCP 服务器。
	 * 同名工具（已有原生 handler）不会被覆盖。
	 */
	private _registerBundledTools(): void {
		this.logService.info(`[BuiltinTools] _registerBundledTools: loading ${BUNDLED_TOOL_DEFINITIONS.length} bundled tool definitions`);
		for (const def of BUNDLED_TOOL_DEFINITIONS) {
			if (this._tools.has(def.name)) {
				// 原生工具优先，不覆盖
				continue;
			}
			// delegate_task 有真实 handler，不在 bundled 中注册 stub
			if (def.name === 'delegate_task') {
				continue;
			}
			// kanban_* 核心工具有真实 handler（见 _registerKanbanTools），不注册 stub
			if (KANBAN_TOOLS_WITH_HANDLER.has(def.name)) {
				continue;
			}
			// workflow_* 工具有真实 handler（见 _registerWorkflowTools），不注册 stub
			if (WORKFLOW_TOOLS_WITH_HANDLER.has(def.name)) {
				continue;
			}
			this.register({
				definition: { ...def, source: this.id },
				handler: async () => [{

					type: 'text' as const,
					text: `Tool "${def.name}" is defined but not yet implemented natively. ` +
						`Configure an MCP server that provides this tool, or it will be available ` +
						`when a matching provider is registered.`,
				}],
				isStub: true, // 标记为 stub — listTools 会跳过，防止 LLM 尝试调用
			});
		}
	}

	/**
	 * 注册委派/子代理相关工具（delegate_task）。
	 * 这些工具需要真实的 handler，不能只是 stub。
	 */
	private _registerDelegationTools(): void {
		// delegate_task — LLM 自主委派任务给子代理
		this.register({
			definition: {
				name: 'delegate_task',
				description: 'Delegate a task (or multiple tasks) to a sub-agent. ' +
					'The sub-agent runs independently and returns its result. ' +
					'Use this when a task can be performed in parallel or requires a separate context. ' +
					'Supports both single task (task) and batch tasks (tasks).',
				inputSchema: {
					type: 'object',
					properties: {
						task: { type: 'string', description: 'Single task description to delegate' },
						tasks: { type: 'array', items: { type: 'string' }, description: 'Multiple task descriptions to delegate in parallel' },
						model: { type: 'string', description: 'Optional model to use for the sub-agent' },
						toolsets: { type: 'array', items: { type: 'string' }, description: 'Optional tool sets to enable for the sub-agent' },
					},
					required: [],
				},
				category: 'delegation',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const task = args['task'] as string | undefined;
				const tasks = args['tasks'] as string[] | undefined;

				if (!task && (!tasks || tasks.length === 0)) {
					throw new Error('delegate_task: either "task" or "tasks" must be provided');
				}

				// v17: inherit the parent agent's worktree so the subagent tree
				// operates in the same working directory.
				const inheritedWorktree = this.getParentWorktreePath();

				// Build executeFn that delegates to AgentOS
				const executeFn = (request: IAgentTurnRequest, _budget: IterationBudget): AsyncIterable<IChatStreamDelta> => {
					return this.agentOS.executeAgentTurn(request);
				};

				try {
					if (task) {
						// Single task mode — use dispatch()
						const result = await (this.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch).dispatch(
							agentId ?? 'unknown',
							task,
							executeFn,
							{ type: SubAgentType.General, worktreePath: inheritedWorktree },
						);
						if (result.success) {
							return [{ type: 'text', text: result.output ?? '(no output)' }];
						} else {
							return [{ type: 'text', text: `Sub-agent failed: ${result.error ?? 'unknown error'}` }];
						}
					} else {
						// Batch tasks mode — use dispatchParallelExplore()
						// v17: per-task worktree inherited from the parent agent.
						const perTaskOptions = inheritedWorktree
							? tasks!.map(() => ({ worktreePath: inheritedWorktree }))
							: undefined;
						const results = await (this.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch).dispatchParallelExplore(
							agentId ?? 'unknown',
							tasks!,
							executeFn,
							undefined, // context
							perTaskOptions as Array<{ priority?: 'low' | 'medium' | 'high'; maxIterations?: number; timeout?: number }> | undefined,
							undefined, // eventSink
						);
						const lines = results.map((r: SubAgentResult, i: number) => [
							`Task ${i + 1}: ${r.success ? 'SUCCESS' : 'FAILED'}`,
							r.success ? `  Output: ${r.output ?? '(empty)'}` : `  Error: ${r.error ?? 'unknown'}`,
						].join('\n'));
						return [{ type: 'text', text: lines.join('\n\n') }];
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `delegate_task error: ${msg}` }];
				}
			},
			descriptionBuilder: (agentId: string) => {
				try {
					const dispatch = this.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch;
					const config = dispatch.getConfig();
					return `Delegate a task (or multiple tasks) to a sub-agent. ` +
						`The sub-agent runs independently and returns its result. ` +
						`Use this when the task can be decomposed into independent parallel subtasks, ` +
						`or when the task requires a separate context window. ` +
						`Supports both single task (task) and batch tasks (tasks). ` +
						`You can run up to ${config.maxConcurrent} sub-agents in parallel ` +
						`(max ${config.maxSpawnDepth} levels deep). ` +
						`\n\n` +
						`## When to use:\n` +
						`- The task can be decomposed into 2+ independent subtasks\n` +
						`- You need to run multiple independent investigations simultaneously\n` +
						`- The subtask is complex enough to benefit from a dedicated context\n` +
						`\n\n` +
						`## When NOT to use:\n` +
						`- The task is simple and can be completed in one turn\n` +
						`- You need to maintain ongoing context/memory across steps\n` +
						`- You are already at maximum spawn depth\n`;
				} catch {
					return 'Delegate a task (or multiple tasks) to a sub-agent. ' +
						'The sub-agent runs independently and returns its result. ' +
						'Use this when a task can be performed in parallel or requires a separate context. ' +
						'Supports both single task (task) and batch tasks (tasks).';
				}
			},
		});
		this.logService.info('[BuiltinTools] _registerDelegationTools: delegate_task registered');
	}

	/**
	 * 注册看板（kanban）核心工具的真实 handler。
	 * 参考 Hermes-Agent 的 kanban 工具语义，落地到本项目的 IAgentTaskBoardService。
	 *
	 * 实现的 9 个工具（Hermes 全集）：
	 *  - kanban_create：创建任务卡（编排者用），默认进入 triage 待规划
	 *  - kanban_complete：标记任务完成（写入 result 摘要）
	 *  - kanban_block：阻塞任务（记录原因），状态 → blocked
	 *  - kanban_unblock：解除阻塞，状态 → todo
	 *  - kanban_show：查看单个任务详情
	 *  - kanban_list：列出当前 workspace 任务（可按状态过滤）
	 *  - kanban_heartbeat：刷新任务活跃时间（updatedAt），避免被诊断判为 stranded/stuck
	 *  - kanban_comment：向任务追加一条结构化评论（写入 description）
	 *  - kanban_link：建立父子依赖（child.dependencies += parent）
	 *
	 * agentId → workspaceId 通过 studioService.getAgent(agentId) 解析。
	 */
	private _registerKanbanTools(): void {
		// 辅助：从 agentId 解析当前 agent 及其运行 workspaceId
		// （agent 是全局定义，运行 workspace 取自 getActiveWorkspaceId）。
		const resolveWorkspaceId = async (agentId: string | undefined): Promise<{ workspaceId: string; assigneeId?: string; assigneeName?: string } | undefined> => {
			if (!agentId) { return undefined; }
			try {
				const workspaceId = this.studioService.getActiveWorkspaceId();
				if (workspaceId) {
					const agent = await this.studioService.getAgent(agentId);
					return { workspaceId, assigneeId: agent?.id ?? agentId, assigneeName: agent?.name };
				}
			} catch (err) {
				this.logService.warn(`[BuiltinTools] kanban: failed to resolve workspace for agent ${agentId}:`, err);
			}
			return undefined;
		};

		// ─── kanban_create ────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'kanban_create',
				description: 'Create a new kanban task card. The task starts in the "triage" column ' +
					'(awaiting decomposition/refinement). Use this to break down work into trackable cards. ' +
					'Optionally assign to a named agent.',
				inputSchema: {
					type: 'object',
					properties: {
						title: { type: 'string', description: 'Task title' },
						description: { type: 'string', description: 'Task description (optional)' },
						assignee: { type: 'string', description: 'Assignee name (optional)' },
					},
					required: ['title'],
				},
				category: 'kanban',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const title = args['title'] as string | undefined;
				if (!title || !title.trim()) {
					throw new Error('kanban_create: "title" is required');
				}
				const description = args['description'] as string | undefined;
				const assignee = args['assignee'] as string | undefined;

				const ctx = await resolveWorkspaceId(agentId);
				if (!ctx) {
					return [{ type: 'text', text: 'kanban_create error: could not resolve a workspace for the current agent.' }];
				}
				try {
					const task = await this.taskBoardService.createTask({
						title: title.trim(),
						description,
						status: TaskBoardStatus.Triage,
						source: TaskSource.Manual,
						workspaceId: ctx.workspaceId,
						assigneeName: assignee,
					});
					return [{ type: 'text', text: `Created kanban task #${task.id.slice(-6)} "${task.title}" (status: triage).` }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `kanban_create error: ${msg}` }];
				}
			},
		});

		// ─── kanban_complete ──────────────────────────────────────────────
		this.register({
			definition: {
				name: 'kanban_complete',
				description: 'Mark a kanban task as completed, with an optional result summary. ' +
					'Moves the task to the "done" column.',
				inputSchema: {
					type: 'object',
					properties: {
						task_id: { type: 'string', description: 'Task ID to complete (full ID or last-6 short ID)' },
						result: { type: 'string', description: 'Result summary (optional)' },
					},
					required: ['task_id'],
				},
				category: 'kanban',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const taskId = args['task_id'] as string | undefined;
				if (!taskId) {
					throw new Error('kanban_complete: "task_id" is required');
				}
				const result = args['result'] as string | undefined;
				try {
					const resolvedId = await this._resolveKanbanTaskId(taskId, agentId);
					if (!resolvedId) {
						return [{ type: 'text', text: `kanban_complete error: task "${taskId}" not found.` }];
					}
					await this.taskBoardService.updateTask(resolvedId, {
						status: TaskBoardStatus.Done,
						...(result ? { description: result } : {}),
					});
					return [{ type: 'text', text: `Completed kanban task #${resolvedId.slice(-6)}.` }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `kanban_complete error: ${msg}` }];
				}
			},
		});

		// ─── kanban_block ─────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'kanban_block',
				description: 'Block a kanban task, indicating it is waiting on a dependency or needs human input. ' +
					'Moves the task to the "blocked" status. A reason is required.',
				inputSchema: {
					type: 'object',
					properties: {
						task_id: { type: 'string', description: 'Task ID to block (full ID or last-6 short ID)' },
						reason: { type: 'string', description: 'Reason for blocking' },
					},
					required: ['task_id', 'reason'],
				},
				category: 'kanban',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const taskId = args['task_id'] as string | undefined;
				const reason = args['reason'] as string | undefined;
				if (!taskId) {
					throw new Error('kanban_block: "task_id" is required');
				}
				if (!reason || !reason.trim()) {
					throw new Error('kanban_block: "reason" is required');
				}
				try {
					const resolvedId = await this._resolveKanbanTaskId(taskId, agentId);
					if (!resolvedId) {
						return [{ type: 'text', text: `kanban_block error: task "${taskId}" not found.` }];
					}
					const existing = await this.taskBoardService.getTask(resolvedId);
					const note = `[BLOCKED] ${reason.trim()}`;
					const newDesc = existing?.description ? `${existing.description}\n${note}` : note;
					await this.taskBoardService.updateTask(resolvedId, {
						status: TaskBoardStatus.Blocked,
						description: newDesc,
					});
					return [{ type: 'text', text: `Blocked kanban task #${resolvedId.slice(-6)}: ${reason.trim()}` }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `kanban_block error: ${msg}` }];
				}
			},
		});

		// ─── kanban_unblock ───────────────────────────────────────────────
		this.register({
			definition: {
				name: 'kanban_unblock',
				description: 'Unblock a kanban task that was previously blocked. Moves it back to the "todo" column.',
				inputSchema: {
					type: 'object',
					properties: {
						task_id: { type: 'string', description: 'Task ID to unblock (full ID or last-6 short ID)' },
					},
					required: ['task_id'],
				},
				category: 'kanban',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const taskId = args['task_id'] as string | undefined;
				if (!taskId) {
					throw new Error('kanban_unblock: "task_id" is required');
				}
				try {
					const resolvedId = await this._resolveKanbanTaskId(taskId, agentId);
					if (!resolvedId) {
						return [{ type: 'text', text: `kanban_unblock error: task "${taskId}" not found.` }];
					}
					await this.taskBoardService.updateTask(resolvedId, { status: TaskBoardStatus.Todo });
					return [{ type: 'text', text: `Unblocked kanban task #${resolvedId.slice(-6)} (status: todo).` }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `kanban_unblock error: ${msg}` }];
				}
			},
		});

		this.logService.info('[BuiltinTools] _registerKanbanTools: kanban_create/complete/block/unblock registered');

		// ─── kanban_show ──────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'kanban_show',
				description: 'Show the full details of a single kanban task: title, description, status, ' +
					'assignee, priority, dependencies, and timestamps.',
				inputSchema: {
					type: 'object',
					properties: {
						task_id: { type: 'string', description: 'Task ID to show (full ID or last-6 short ID)' },
					},
					required: ['task_id'],
				},
				category: 'kanban',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const taskId = args['task_id'] as string | undefined;
				if (!taskId) {
					throw new Error('kanban_show: "task_id" is required');
				}
				try {
					const resolvedId = await this._resolveKanbanTaskId(taskId, agentId);
					if (!resolvedId) {
						return [{ type: 'text', text: `kanban_show error: task "${taskId}" not found.` }];
					}
					const task = await this.taskBoardService.getTask(resolvedId);
					if (!task) {
						return [{ type: 'text', text: `kanban_show error: task "${taskId}" not found.` }];
					}
					const lines = [
						`Task #${task.id.slice(-6)} (${task.id})`,
						`  title:        ${task.title}`,
						`  status:       ${task.status}`,
						`  priority:     ${task.priority ?? '(none)'}`,
						`  assignee:     ${task.assigneeName ?? '(unassigned)'}`,
						`  source:       ${task.source}${task.sourceId ? ` (${task.sourceId})` : ''}`,
						`  dependencies: ${task.dependencies && task.dependencies.length ? task.dependencies.map(d => `#${d.slice(-6)}`).join(', ') : '(none)'}`,
						`  createdAt:    ${task.createdAt}`,
						`  updatedAt:    ${task.updatedAt}`,
						...(task.completedAt ? [`  completedAt:  ${task.completedAt}`] : []),
						``,
						`  description:`,
						task.description ? task.description.split('\n').map(l => `    ${l}`).join('\n') : '    (empty)',
					];
					return [{ type: 'text', text: lines.join('\n') }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `kanban_show error: ${msg}` }];
				}
			},
		});

		// ─── kanban_list ──────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'kanban_list',
				description: 'List kanban tasks in the current workspace, optionally filtered by status. ' +
					'Returns a compact one-line-per-task summary. Use status="triage|todo|ready|running|blocked|done|cancelled|archived".',
				inputSchema: {
					type: 'object',
					properties: {
						status: { type: 'string', description: 'Filter by status (optional). One of: triage, todo, ready, running, blocked, done, cancelled, archived.' },
						limit: { type: 'number', description: 'Max number of tasks to return (default 50)' },
					},
					required: [],
				},
				category: 'kanban',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const statusFilter = args['status'] as string | undefined;
				const limit = typeof args['limit'] === 'number' ? args['limit'] as number : 50;
				try {
					const ctx = await this._resolveKanbanWorkspaceId(agentId);
					const tasks = await this.taskBoardService.getTasks(ctx);
					let filtered = tasks;
					if (statusFilter) {
						const wanted = statusFilter.trim().toLowerCase();
						filtered = tasks.filter(t => t.status === wanted);
					}
					filtered = filtered.slice(0, Math.max(1, limit));
					if (filtered.length === 0) {
						return [{ type: 'text', text: statusFilter ? `No kanban tasks with status "${statusFilter}".` : 'No kanban tasks found.' }];
					}
					const header = `${filtered.length} task(s)${statusFilter ? ` (status=${statusFilter})` : ''}:`;
					const rows = filtered.map(t => {
						const assignee = t.assigneeName ? ` @${t.assigneeName}` : '';
						const prio = t.priority ? ` [${t.priority}]` : '';
						return `  #${t.id.slice(-6)} ${t.status.padEnd(9)}${prio}${assignee} — ${t.title}`;
					});
					return [{ type: 'text', text: [header, ...rows].join('\n') }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `kanban_list error: ${msg}` }];
				}
			},
		});

		// ─── kanban_heartbeat ─────────────────────────────────────────────
		this.register({
			definition: {
				name: 'kanban_heartbeat',
				description: 'Signal that work on a task is still actively progressing. Refreshes the task\'s ' +
					'last-active timestamp so diagnostics do not flag it as stuck or stranded. Call periodically ' +
					'during long-running work.',
				inputSchema: {
					type: 'object',
					properties: {
						task_id: { type: 'string', description: 'Task ID to heartbeat (full ID or last-6 short ID)' },
						note: { type: 'string', description: 'Optional short progress note (appended as a comment)' },
					},
					required: ['task_id'],
				},
				category: 'kanban',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const taskId = args['task_id'] as string | undefined;
				if (!taskId) {
					throw new Error('kanban_heartbeat: "task_id" is required');
				}
				const note = args['note'] as string | undefined;
				try {
					const resolvedId = await this._resolveKanbanTaskId(taskId, agentId);
					if (!resolvedId) {
						return [{ type: 'text', text: `kanban_heartbeat error: task "${taskId}" not found.` }];
					}
					if (note && note.trim()) {
						// Append a heartbeat comment; updateTask refreshes updatedAt anyway.
						const existing = await this.taskBoardService.getTask(resolvedId);
						const stamp = new Date().toISOString();
						const line = `[HEARTBEAT ${stamp}] ${note.trim()}`;
						const newDesc = existing?.description ? `${existing.description}\n${line}` : line;
						await this.taskBoardService.updateTask(resolvedId, { description: newDesc });
					} else {
						// No-content touch: re-write title to bump updatedAt without semantic change.
						const existing = await this.taskBoardService.getTask(resolvedId);
						await this.taskBoardService.updateTask(resolvedId, { title: existing?.title ?? '' });
					}
					return [{ type: 'text', text: `Heartbeat recorded for kanban task #${resolvedId.slice(-6)}.` }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `kanban_heartbeat error: ${msg}` }];
				}
			},
		});

		// ─── kanban_comment ───────────────────────────────────────────────
		this.register({
			definition: {
				name: 'kanban_comment',
				description: 'Add a comment to a kanban task. The comment is appended to the task description ' +
					'with an author + timestamp prefix. Use this to record progress, findings, or blackboard updates.',
				inputSchema: {
					type: 'object',
					properties: {
						task_id: { type: 'string', description: 'Task ID to comment on (full ID or last-6 short ID)' },
						body: { type: 'string', description: 'Comment text' },
					},
					required: ['task_id', 'body'],
				},
				category: 'kanban',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const taskId = args['task_id'] as string | undefined;
				const body = args['body'] as string | undefined;
				if (!taskId) {
					throw new Error('kanban_comment: "task_id" is required');
				}
				if (!body || !body.trim()) {
					throw new Error('kanban_comment: "body" is required');
				}
				try {
					const resolvedId = await this._resolveKanbanTaskId(taskId, agentId);
					if (!resolvedId) {
						return [{ type: 'text', text: `kanban_comment error: task "${taskId}" not found.` }];
					}
					const ctx = await this._resolveKanbanWorkspaceId(agentId);
					let authorName = 'agent';
					if (agentId) {
						try {
							const agent = await this.studioService.getAgent(agentId);
							if (agent?.name) { authorName = agent.name; }
						} catch { /* ignore */ }
					}
					void ctx;
					const existing = await this.taskBoardService.getTask(resolvedId);
					const stamp = new Date().toISOString();
					const line = `[COMMENT ${authorName} ${stamp}] ${body.trim()}`;
					const newDesc = existing?.description ? `${existing.description}\n${line}` : line;
					await this.taskBoardService.updateTask(resolvedId, { description: newDesc });
					return [{ type: 'text', text: `Comment added to kanban task #${resolvedId.slice(-6)}.` }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `kanban_comment error: ${msg}` }];
				}
			},
		});

		// ─── kanban_link ──────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'kanban_link',
				description: 'Create a dependency link between two kanban tasks: the child task depends on the ' +
					'parent task (the parent must complete before the child can start). Used to express task ordering.',
				inputSchema: {
					type: 'object',
					properties: {
						parent_id: { type: 'string', description: 'Parent task ID — must complete first (full or short ID)' },
						child_id: { type: 'string', description: 'Child task ID — depends on the parent (full or short ID)' },
					},
					required: ['parent_id', 'child_id'],
				},
				category: 'kanban',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const parentArg = args['parent_id'] as string | undefined;
				const childArg = args['child_id'] as string | undefined;
				if (!parentArg) {
					throw new Error('kanban_link: "parent_id" is required');
				}
				if (!childArg) {
					throw new Error('kanban_link: "child_id" is required');
				}
				try {
					const parentId = await this._resolveKanbanTaskId(parentArg, agentId);
					if (!parentId) {
						return [{ type: 'text', text: `kanban_link error: parent task "${parentArg}" not found.` }];
					}
					const childId = await this._resolveKanbanTaskId(childArg, agentId);
					if (!childId) {
						return [{ type: 'text', text: `kanban_link error: child task "${childArg}" not found.` }];
					}
					if (parentId === childId) {
						return [{ type: 'text', text: 'kanban_link error: a task cannot depend on itself.' }];
					}
					const child = await this.taskBoardService.getTask(childId);
					const deps = new Set<string>(child?.dependencies ?? []);
					if (deps.has(parentId)) {
						return [{ type: 'text', text: `kanban_link: #${childId.slice(-6)} already depends on #${parentId.slice(-6)}.` }];
					}
					deps.add(parentId);
					await this.taskBoardService.updateTask(childId, { dependencies: Array.from(deps) });
					return [{ type: 'text', text: `Linked: kanban task #${childId.slice(-6)} now depends on #${parentId.slice(-6)}.` }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `kanban_link error: ${msg}` }];
				}
			},
		});

		this.logService.info('[BuiltinTools] _registerKanbanTools: 9 kanban tools registered (create/complete/block/unblock/show/list/heartbeat/comment/link)');

		// ─── kanban_specify ───────────────────────────────────────────────
		this.register({
			definition: {
				name: 'kanban_specify',
				description: 'Refine a rough kanban task into a structured specification (Goal / Approach / ' +
					'Acceptance criteria / Out of scope) using an LLM, then move it from triage to todo.',
				inputSchema: {
					type: 'object',
					properties: {
						task_id: { type: 'string', description: 'Task ID to specify (full or last-6 short ID)' },
					},
					required: ['task_id'],
				},
				category: 'kanban',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const taskId = args['task_id'] as string | undefined;
				if (!taskId) {
					throw new Error('kanban_specify: "task_id" is required');
				}
				try {
					const resolvedId = await this._resolveKanbanTaskId(taskId, agentId);
					if (!resolvedId) {
						return [{ type: 'text', text: `kanban_specify error: task "${taskId}" not found.` }];
					}
					const updated = await this.triageService.specify(resolvedId);
					return [{ type: 'text', text: `Specified kanban task #${resolvedId.slice(-6)} (status: ${updated.status}).\n\n${updated.description ?? ''}` }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `kanban_specify error: ${msg}` }];
				}
			},
		});

		// ─── kanban_decompose ─────────────────────────────────────────────
		this.register({
			definition: {
				name: 'kanban_decompose',
				description: 'Decompose a kanban task into 2-N concrete subtasks using an LLM, creating child ' +
					'tasks with parent dependencies. fanout=true → independent/parallel subtasks; false → sequential.',
				inputSchema: {
					type: 'object',
					properties: {
						task_id: { type: 'string', description: 'Parent task ID to decompose (full or last-6 short ID)' },
						fanout: { type: 'boolean', description: 'true=parallel/independent subtasks (default), false=sequential' },
						max_subtasks: { type: 'number', description: 'Maximum number of subtasks (default 6, hard cap 12)' },
						assignee: { type: 'string', description: 'Default assignee for created subtasks (optional)' },
					},
					required: ['task_id'],
				},
				category: 'kanban',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const taskId = args['task_id'] as string | undefined;
				if (!taskId) {
					throw new Error('kanban_decompose: "task_id" is required');
				}
				const fanout = typeof args['fanout'] === 'boolean' ? args['fanout'] as boolean : undefined;
				const maxSubTasks = typeof args['max_subtasks'] === 'number' ? args['max_subtasks'] as number : undefined;
				const assignee = args['assignee'] as string | undefined;
				try {
					const resolvedId = await this._resolveKanbanTaskId(taskId, agentId);
					if (!resolvedId) {
						return [{ type: 'text', text: `kanban_decompose error: task "${taskId}" not found.` }];
					}
					const children = await this.triageService.decompose(resolvedId, { fanout, maxSubTasks, assignee });
					const list = children.map(c => `  #${c.id.slice(-6)} — ${c.title}`).join('\n');
					return [{ type: 'text', text: `Decomposed kanban task #${resolvedId.slice(-6)} into ${children.length} subtask(s):\n${list}` }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `kanban_decompose error: ${msg}` }];
				}
			},
		});

		this.logService.info('[BuiltinTools] _registerKanbanTools: kanban_specify/decompose registered (LLM triage)');

		// ─── kanban_swarm ─────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'kanban_swarm',
				description: 'Spawn a multi-agent swarm: build a kanban topology (root → parallel workers → ' +
					'verifier → synthesizer), run workers in parallel as sub-agents, then verify and synthesize ' +
					'their outputs into a final result. Use for complex goals that benefit from parallel specialized agents.',
				inputSchema: {
					type: 'object',
					properties: {
						title: { type: 'string', description: 'Swarm title (becomes the root task title)' },
						goal: { type: 'string', description: 'Overall goal, injected into every worker context' },
						workers: {
							type: 'array',
							description: 'Worker specs (at least 1)',
							items: {
								type: 'object',
								properties: {
									title: { type: 'string', description: 'Worker card title' },
									body: { type: 'string', description: 'What this worker should do' },
									profile: { type: 'string', description: 'Worker role/persona (optional)' },
									priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Scheduling priority' },
								},
								required: ['title', 'body'],
							},
						},
						enable_verifier: { type: 'boolean', description: 'Enable verifier stage (default true when >=2 workers)' },
						enable_synthesizer: { type: 'boolean', description: 'Enable synthesizer stage (default true)' },
					},
					required: ['title', 'workers'],
				},
				category: 'kanban',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const title = args['title'] as string | undefined;
				const rawWorkers = args['workers'] as Array<Record<string, unknown>> | undefined;
				if (!title) {
					throw new Error('kanban_swarm: "title" is required');
				}
				if (!Array.isArray(rawWorkers) || rawWorkers.length === 0) {
					throw new Error('kanban_swarm: "workers" must be a non-empty array');
				}
				const workers: SwarmWorkerSpec[] = [];
				for (const w of rawWorkers) {
					const wTitle = w['title'] as string | undefined;
					const wBody = w['body'] as string | undefined;
					if (!wTitle || !wBody) { continue; }
					const priority = w['priority'] as 'low' | 'medium' | 'high' | undefined;
					workers.push({
						title: wTitle,
						body: wBody,
						profile: w['profile'] as string | undefined,
						priority,
					});
				}
				if (workers.length === 0) {
					throw new Error('kanban_swarm: no valid workers (each needs title + body)');
				}
				try {
					const workspaceId = await this._resolveKanbanWorkspaceId(agentId);
					const swarmId = await this.swarmService.createSwarm({
						title,
						goal: args['goal'] as string | undefined,
						workspaceId,
						workers,
						enableVerifier: typeof args['enable_verifier'] === 'boolean' ? args['enable_verifier'] as boolean : undefined,
						enableSynthesizer: typeof args['enable_synthesizer'] === 'boolean' ? args['enable_synthesizer'] as boolean : undefined,
					});
					return [{ type: 'text', text: `Swarm "${title}" started (${swarmId}) with ${workers.length} worker(s). The topology is on the board; workers run in parallel, then verify + synthesize.` }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `kanban_swarm error: ${msg}` }];
				}
			},
		});

		this.logService.info('[BuiltinTools] _registerKanbanTools: kanban_swarm registered (multi-agent collaboration)');
	}

	/**
	 * 解析 kanban 工具传入的 task_id —— 支持完整 ID 或末 6 位短 ID。
	 * 先尝试精确匹配，再在当前 agent 的 workspace 任务里按短 ID 后缀匹配。
	 */
	private async _resolveKanbanTaskId(taskId: string, agentId: string | undefined): Promise<string | undefined> {
		// 1. 精确匹配
		const exact = await this.taskBoardService.getTask(taskId);
		if (exact) { return exact.id; }

		// 2. 短 ID（末 6 位）后缀匹配，限定在当前 workspace 内
		// （agent 全局，运行 workspace 取自 getActiveWorkspaceId）。
		let workspaceId: string | undefined;
		if (agentId) {
			try {
				workspaceId = this.studioService.getActiveWorkspaceId();
			} catch { /* ignore */ }
		}
		const all = await this.taskBoardService.getTasks(workspaceId);
		const normalized = taskId.replace(/^#/, '');
		const matches = all.filter(t => t.id.endsWith(normalized));
		if (matches.length === 1) { return matches[0].id; }
		return undefined;
	}

	/**
	 * 解析当前 agent 所属的 workspaceId（用于 kanban_list / kanban_comment 等需要按 workspace 过滤的工具）。
	 * agentId 缺失或解析失败时返回 undefined（调用方据此回退到全量查询）。
	 */
	private async _resolveKanbanWorkspaceId(agentId: string | undefined): Promise<string | undefined> {
		if (!agentId) { return undefined; }
		try {
			// agent 是全局定义；运行 workspace 取自 getActiveWorkspaceId。
			return this.studioService.getActiveWorkspaceId();
		} catch {
			return undefined;
		}
	}

	private async _walkAndGrep(dir: URI, query: string, out: string[], limit: number, signal?: AbortSignal): Promise<void> {
		// Hard global cap on files we will read+grep regardless of `limit`.
		// This protects against pathological recursion (huge build trees, symlink
		// loops, accidentally pointing at C:\) which can OOM the renderer because
		// each file we open allocates a UTF-8 string copy of the buffer.
		const MAX_FILES_VISITED = 5_000;
		const filesVisited = { count: 0 };
		const seenDirs = new Set<string>();
		const NOISE_DIRS = new Set<string>([
			'node_modules', '.git', 'out', 'dist', 'build', '.build',
			'.next', '.cache', '.vscode-test', 'coverage', '__pycache__',
			'target', '.gradle', '.idea', 'bin', 'obj', '.pnpm-store',
			'.yarn', '.parcel-cache', '.turbo', '.nuxt', '.svelte-kit',
			'.angular', 'venv', '.venv', 'env', '.env',
		]);
		// Extension blacklist — we never grep into binary-shaped files. The toString()
		// on a 500KB binary creates a large garbage string + thousands of split parts,
		// which is a major contributor to OOM under parallel execution.
		const BINARY_EXT_RE = /\.(?:exe|dll|so|dylib|node|pak|asar|wasm|bin|obj|lib|a|o|class|jar|pyc|pyo|whl|zip|tar|gz|tgz|bz2|7z|rar|xz|zst|png|jpe?g|gif|bmp|ico|webp|tif|tiff|svg|psd|mp3|wav|ogg|flac|mp4|mov|avi|mkv|webm|pdf|docx?|xlsx?|pptx?|sqlite|db|map|woff2?|ttf|eot|otf)$/i;

		const walk = async (current: URI): Promise<void> => {
			if (signal?.aborted) { return; }
			if (out.length >= limit) { return; }
			if (filesVisited.count >= MAX_FILES_VISITED) { return; }
			const key = current.toString();
			if (seenDirs.has(key)) { return; }
			seenDirs.add(key);

			let stat;
			try { stat = await this.fileService.resolve(current); } catch { return; }
			if (!stat.isDirectory || !stat.children) { return; }

			for (const child of stat.children) {
				if (signal?.aborted) { return; }
				if (out.length >= limit) { return; }
				if (filesVisited.count >= MAX_FILES_VISITED) { return; }

				if (child.isDirectory) {
					if (NOISE_DIRS.has(child.name) || child.name.startsWith('.')) { continue; }
					await walk(child.resource);
					continue;
				}
				if (!child.isFile) { continue; }
				// Skip binary files by extension before any I/O.
				if (BINARY_EXT_RE.test(child.name)) { continue; }
				// Existing 512 KiB safety net (we keep it as a second line of defense).
				if (typeof child.size === 'number' && child.size > 512 * 1024) { continue; }

				filesVisited.count++;

				try {
					const buf = await this.fileService.readFile(child.resource);
					// Quick binary-content sniff: if the first 1 KiB contains a NUL byte,
					// treat as binary. UTF-8 / UTF-16 text never legitimately contains NUL
					// in real source files; this catches cases the extension list missed.
					const raw = buf.value.buffer;
					const sniffLen = Math.min(raw.length, 1024);
					let isBinary = false;
					for (let i = 0; i < sniffLen; i++) {
						if (raw[i] === 0) { isBinary = true; break; }
					}
					if (isBinary) { continue; }

					const text = buf.value.toString();
					// Hard cap per-file string size to keep heap pressure bounded even
					// if the size hint was missing/wrong.
					const safeText = text.length > 256 * 1024 ? text.substring(0, 256 * 1024) : text;
					const lines = safeText.split('\n');
					for (let i = 0; i < lines.length; i++) {
						if (signal?.aborted) { return; }
						if (lines[i].includes(query)) {
							out.push(`${child.resource.fsPath}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
							if (out.length >= limit) { return; }
						}
					}
				} catch { /* unreadable / binary — skip */ }
			}
		};

		await walk(dir);
	}

	// ─── Workflow AI Editing Tools ────────────────────────────────────────

	/**
	 * Workflow node type schema — describes all available node types the AI
	 * can create when generating workflows.
	 */
	private static readonly WORKFLOW_NODE_SCHEMA = {
		nodeTypes: [
			{
				type: 'start', label: 'Start', category: 'system',
				description: 'Entry point of the workflow. Every workflow must have exactly one Start node.',
				dataSchema: { label: 'string (default: "Start")' },
				positionHint: { x: 80, y: 250 },
			},
			{
				type: 'end', label: 'End', category: 'system',
				description: 'Exit point of the workflow. Every workflow must have exactly one End node.',
				dataSchema: { label: 'string (default: "End")' },
				positionHint: { x: 600, y: 250 },
			},
			{
				type: 'prompt', label: 'Prompt', category: 'basic',
				description: 'A prompt template with variable substitution.',
				dataSchema: { label: 'string', prompt: 'string (template text)', variables: 'Record<string, string> (optional)' },
			},
			{
				type: 'agent', label: 'Agent', category: 'basic',
			description: 'Execute a specific agent. Use agentId to reference an existing agent from availableAgents. ' +
				'IMPORTANT: Also populate agentConfig with { providerId, modelId } from the agent\'s model field.',
			dataSchema: {
				label: 'string',
				agentId: 'string — MUST be one of the availableAgents ids',
				agentConfig: '{ providerId?: string (preferred), modelId?: string (the agent\'s model) }',
			},
		},
			{
				type: 'skill', label: 'Skill', category: 'basic',
				description: 'Execute a named skill with arguments.',
				dataSchema: { label: 'string', skillName: 'string', skillArgs: 'Record<string, string> (optional)' },
			},
			{
				type: 'tool', label: 'Tool', category: 'basic',
				description: 'Execute a tool with parameters.',
				dataSchema: { label: 'string', toolName: 'string', toolParams: 'Record<string, string> (optional)' },
			},
			{
				type: 'task', label: 'Task', category: 'basic',
				description: 'A discrete task with an optional executor.',
				dataSchema: { label: 'string', executorId: 'string (optional)', taskId: 'string (optional)' },
			},
			{
			type: 'ifElse', label: 'If/Else', category: 'controlFlow',
			description: 'Binary conditional branching (True/False). ' +
				'Output port IDs: "branch-0" (True) and "branch-1" (False). Connections from this node MUST specify fromPort.',
			dataSchema: {
				label: 'string',
				evaluationTarget: 'string',
				branches: '[{ id: string, label: string, condition: string }] (2 branches: True and False)',
			},
			outputPorts: ['branch-0', 'branch-1'],
		},
		{
			type: 'switch', label: 'Switch', category: 'controlFlow',
			description: 'Multi-way branching with 2-N cases. ' +
				'Output port IDs: "branch-0", "branch-1", ..., "branch-{N-1}". Last branch is Default. Each connection from this node MUST specify fromPort.',
			dataSchema: {
				label: 'string',
				evaluationTarget: 'string',
				branches: '[{ id: string, label: string, condition: string }] (N branches, last one is Default)',
			},
			outputPortPattern: 'branch-{index}',
		},
		{
			type: 'ifElse', label: 'If/Else', category: 'controlFlow',
			description: 'Binary conditional branching. ' +
				'Output port IDs: "branch-0" (True) and "branch-1" (False). Connections from this node MUST specify fromPort.',
			dataSchema: {
				label: 'string',
				evaluationTarget: 'string',
				branches: '[{ id: string, label: string, condition: string }] (2 branches: True/False)',
			},
			outputPorts: ['branch-0', 'branch-1'],
		},
		{
			type: 'switch', label: 'Switch', category: 'controlFlow',
			description: 'Multi-way branching based on evaluation target. ' +
				'Output port IDs: "branch-0", "branch-1", ..., "branch-{N-1}" (one per branch, last one is Default). Connections from this node MUST specify fromPort.',
			dataSchema: {
				label: 'string',
				evaluationTarget: 'string',
				branches: '[{ id: string, label: string, condition: string, isDefault?: boolean }] (N branches, last one is Default)',
			},
			outputPortPattern: 'branch-{index}',
		},
			{
			type: 'askUser', label: 'Ask User', category: 'controlFlow',
			description: 'Present a question and branch based on user selection. ' +
				'Output port IDs: "option-0", "option-1", ..., "option-{N-1}" (one per option). Each connection from this node MUST specify fromPort.',
			dataSchema: { label: 'string', questionText: 'string', options: '[{ label: string, description?: string }]', multiSelect: 'boolean (optional)' },
			outputPortPattern: 'option-{index}',
		},
			{
				type: 'group', label: 'Group', category: 'layout',
				description: 'Visual grouping container. Does NOT participate in execution logic. Child nodes reference this via parentId.',
				dataSchema: { label: 'string', style: '{ width?: number, height?: number }' },
			},
		],
		positioningGuidelines: {
			horizontalSpacing: 300,
			verticalSpacing: 150,
			startPosition: { x: 80, y: 250 },
		},
		connectionRules: {
			noSelfLoops: true,
			startNodeCannotHaveInputs: true,
			endNodeCannotHaveOutputs: true,
			noDuplicateEdges: true,
			portHandlesRequired: 'For multi-port nodes (ifElse, switch, condition, askUser), connections MUST include fromPort. ' +
				'ifElse/condition: fromPort = "branch-0" or "branch-1". ' +
				'switch: fromPort = "branch-{index}". ' +
				'askUser: fromPort = "option-{index}". ' +
				'Single-port nodes (start, end, task, prompt, agent, skill, tool, loop, parallel) do not need fromPort.',
		},
		portNaming: {
			ifElse: { pattern: 'branch-{index}', ports: ['branch-0 (True)', 'branch-1 (False)'] },
			switch: { pattern: 'branch-{index}', example: 'branch-0, branch-1, branch-2, ...' },
			condition: { pattern: 'branch-{index}', ports: ['branch-0 (True)', 'branch-1 (False)'] },
			askUser: { pattern: 'option-{index}', example: 'option-0, option-1, ...' },
		},
	};

	private _registerWorkflowTools(): void {
		const resolveWorkspaceId = (): string | undefined => {
			return this.studioService.getActiveWorkspaceId();
		};

		// ── workflow_list ──────────────────────────────────────────────
		this.register({
			definition: {
				name: 'workflow_list',
				description: 'List all workflows in the current workspace. Returns workflow IDs, names, and descriptions.',
				inputSchema: {
					type: 'object',
					properties: {},
					required: [],
				},
				category: 'workflow',
				source: this.id,
			},
			handler: async (_args, _signal, _agentId) => {
				const wsId = resolveWorkspaceId();
				if (!wsId) {
					return [{ type: 'text', text: 'No active workspace. Please select a workspace first.' }];
				}
				try {
					const workflows = await this.workflowStorageService.listWorkflows(wsId);
					if (workflows.length === 0) {
						return [{ type: 'text', text: 'No workflows found in the current workspace. Create one first using the Workflow Editor.' }];
					}
					const summary = workflows.map(w => ({
						id: w.id,
						name: w.name || '(unnamed)',
						description: w.description || '',
						nodeCount: w.nodes?.length ?? 0,
						connectionCount: w.connections?.length ?? 0,
					}));
					return [{ type: 'text', text: JSON.stringify(summary, null, 2) }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `workflow_list error: ${msg}` }];
				}
			},
		});

		// ── workflow_get ───────────────────────────────────────────────
		this.register({
			definition: {
				name: 'workflow_get',
				description: 'Get the full state of a specific workflow by ID. Returns all nodes, edges, and metadata. ' +
					'Use this before modifying a workflow so you can see the current structure.',
				inputSchema: {
					type: 'object',
					properties: {
						workflow_id: { type: 'string', description: 'The workflow ID (from workflow_list).' },
					},
					required: ['workflow_id'],
				},
				category: 'workflow',
				source: this.id,
			},
			handler: async (args, _signal, _agentId) => {
				const wsId = resolveWorkspaceId();
				if (!wsId) {
					return [{ type: 'text', text: 'No active workspace.' }];
				}
				const workflowId = args['workflow_id'] as string | undefined;
				if (!workflowId) {
					return [{ type: 'text', text: 'workflow_get error: workflow_id is required.' }];
				}
				try {
					const wf = await this.workflowStorageService.getWorkflow(workflowId, wsId);
					if (!wf) {
						return [{ type: 'text', text: `Workflow "${workflowId}" not found.` }];
					}
					// Return a clean summary for AI consumption
					const summary = {
						id: wf.id,
						name: wf.name,
						description: wf.description,
						nodes: wf.nodes ?? [],
						connections: wf.connections ?? [],
					};
					return [{ type: 'text', text: JSON.stringify(summary, null, 2) }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `workflow_get error: ${msg}` }];
				}
			},
		});

		// ── workflow_get_schema ─────────────────────────────────────────
		this.register({
			definition: {
				name: 'workflow_get_schema',
				description: 'Get the schema of all available workflow node types, INCLUDING the list of ' +
					'available agents you can reference. Use this to understand what node types are available, ' +
					'their required data fields, valid agentId values, and positioning guidelines before creating or modifying a workflow.',
				inputSchema: {
					type: 'object',
					properties: {},
					required: [],
				},
				category: 'workflow',
				source: this.id,
			},
			handler: async () => {
				// Dynamically fetch available agents so the AI knows valid agentId values
				let availableAgents: Array<{ id: string; name: string; role: string; model: string }> = [];
				try {
					const agents = await this.studioService.getAgents();
					availableAgents = agents.map(a => ({
						id: a.id,
						name: a.name,
						role: a.role,
						model: a.model,
					}));
				} catch (err) {
					this.logService.warn('[BuiltinTools] workflow_get_schema: failed to fetch agents:', err);
				}

				// Enhance the agent node type description to reference available agents
				const enhancedNodeTypes = BuiltinToolProvider.WORKFLOW_NODE_SCHEMA.nodeTypes.map(nt => {
					if (nt.type === 'agent') {
						const agentIds = availableAgents.map(a => a.id).join(', ');
						return {
							...nt,
							description: nt.description +
								` IMPORTANT: agentId MUST be one of: [${agentIds || '(no agents available — ask the user to create one first)'}]. ` +
								'Use the exact agent.id value. If the user wants an agent node but the right agent does not exist, ' +
								'ask them to create it first.',
							dataSchema: {
								...nt.dataSchema,
								agentId: `string — one of: [${agentIds || '(none)'}]`,
								agentConfig: '{ modelId?: string (the model to use for this step), tools?: string[], memory?: string }',
							},
						};
					}
					return nt;
				});

				const schema = {
					...BuiltinToolProvider.WORKFLOW_NODE_SCHEMA,
					nodeTypes: enhancedNodeTypes,
					availableAgents,
				};

				return [{ type: 'text', text: JSON.stringify(schema, null, 2) }];
			},
		});

		// ── workflow_apply ──────────────────────────────────────────────
		this.register({
			definition: {
				name: 'workflow_apply',
				description: 'Apply a complete workflow definition (all nodes and connections) to create or replace a workflow. ' +
					'IMPORTANT: Always include the Start and End nodes. Provide ALL nodes and connections — this replaces the entire workflow. ' +
					'Use this for major structural changes. For small edits, get the current workflow via workflow_get, modify it, and apply.\n\n' +
					'NODE FORMAT (CRITICAL): Each node must have id, type, position, and a data object containing all content.\n' +
					'Example: { "id":"dev","type":"agent","position":{"x":320,"y":200},"data":{"label":"Coder","agentId":"coder","agentConfig":{"modelId":"claude-sonnet-4-20250514"}} }\n' +
					'DO NOT put label/agentId/agentConfig at the top level — they go inside data.',
				inputSchema: {
					type: 'object',
					properties: {
						workflow_id: { type: 'string', description: 'The workflow ID to update (from workflow_list).' },
						name: { type: 'string', description: 'Workflow name (optional, preserved if omitted).' },
						description: { type: 'string', description: 'Workflow description (optional, preserved if omitted).' },
						nodes: {
							type: 'array',
							description: 'All nodes. Each node: { id(string), type(string), position({x,y}), data({label, ...typeFields}) }. ' +
								'CRITICAL: put label/agentId/agentConfig/other content inside `data`, NOT at top level.',
							items: {
								type: 'object',
								properties: {
									id: { type: 'string', description: 'Unique node id' },
									type: { type: 'string', description: 'Node type from workflow_get_schema' },
									position: {
										type: 'object',
										properties: { x: { type: 'number' }, y: { type: 'number' } },
										required: ['x', 'y'],
									},
									data: {
										type: 'object',
										description: 'Content fields: label (required), plus type-specific fields (agentId, agentConfig, prompt, etc.)',
									},
								},
								required: ['id', 'type', 'position'],
							},
						},
						connections: {
							type: 'array',
							description: 'All connections (edges) between nodes. Each connection: id (string), from (source node id), to (target node id). ' +
								'CRITICAL for multi-port nodes (ifElse/switch/condition/askUser): MUST also include fromPort (string). ' +
								'ifElse/condition: fromPort is "branch-0" or "branch-1". switch: "branch-0", "branch-1", etc. askUser: "option-0", "option-1", etc.',
							items: {
								type: 'object',
								properties: {
									id: { type: 'string', description: 'Unique edge id' },
									from: { type: 'string', description: 'Source node id' },
									to: { type: 'string', description: 'Target node id' },
									fromPort: { type: 'string', description: 'Required for multi-port nodes (branch-0, option-0, etc.)' },
								},
								required: ['id', 'from', 'to'],
							},
						},
						change_description: { type: 'string', description: 'Brief description of what changed (for user feedback).' },
					},
					required: ['workflow_id', 'nodes', 'connections'],
				},
				category: 'workflow',
				source: this.id,
			},
			handler: async (args, _signal, _agentId) => {
				const wsId = resolveWorkspaceId();
				if (!wsId) {
					return [{ type: 'text', text: 'workflow_apply error: No active workspace.' }];
				}

				const workflowId = args['workflow_id'] as string | undefined;
				if (!workflowId) {
					return [{ type: 'text', text: 'workflow_apply error: workflow_id is required.' }];
				}

				const nodes = args['nodes'] as Array<Record<string, unknown>> | undefined;
				const connections = args['connections'] as Array<Record<string, unknown>> | undefined;
				const name = args['name'] as string | undefined;
				const description = args['description'] as string | undefined;
				const changeDescription = args['change_description'] as string | undefined;

				if (!Array.isArray(nodes)) {
					return [{ type: 'text', text: 'workflow_apply error: nodes must be an array.' }];
				}
				if (!Array.isArray(connections)) {
					return [{ type: 'text', text: 'workflow_apply error: connections must be an array.' }];
				}

				try {
					// Validate: must have Start and End nodes
					const hasStart = nodes.some(n => n.type === 'start' || n.id === 'start');
					const hasEnd = nodes.some(n => n.type === 'end' || n.id === 'end');
					if (!hasStart || !hasEnd) {
						return [{ type: 'text', text: 'workflow_apply validation error: Workflow must have both a Start node and an End node.' }];
					}

					// Normalize node format: AI may send fields (label, agentId, agentConfig etc.)
					// at the top level instead of nested inside `data`. Move them into `data`
					// so loadWorkflow() in the webview sees them correctly.
					const fixups: string[] = [];
					const KNOWN_META_KEYS = new Set(['id', 'type', 'position', 'parentId', 'style', 'data', 'name']);
					for (const node of nodes) {
						const data = (node.data as Record<string, unknown>) || {};
						let hasMoved = false;
						const movedFields: string[] = [];
						for (const key of Object.keys(node)) {
							if (!KNOWN_META_KEYS.has(key) && !(key in data)) {
								data[key] = node[key];
								movedFields.push(key);
								hasMoved = true;
							}
						}
						if (hasMoved) {
							fixups.push(`Node "${node.id}" (${node.type}): moved ${movedFields.join(', ')} into data`);
						}
						if (hasMoved || Object.keys(data).length > 0) {
							(node as Record<string, unknown>).data = data;
						}
						// Ensure label is always set (fallback to id)
						if (!data.label) {
							data.label = (node.name as string) || (node.id as string) || (node.type as string);
							(node as Record<string, unknown>).data = data;
							fixups.push(`Node "${node.id}": set label="${data.label}" (was missing)`);
						}
					}

					// Auto-populate agent node configs from the workflow's bound agent.
					// AI may forget to set agentConfig.providerId / modelId; we fill them here
					// as a server-side guarantee so agent nodes never show "No provider selected".
					try {
						const existingWf = await this.workflowStorageService.getWorkflow(workflowId, wsId);
						if (existingWf?.agentId) {
							const workflowAgent = await this.studioService.getAgent(existingWf.agentId);
							if (workflowAgent?.model) {
								const defaultModelId = typeof workflowAgent.model === 'string'
									? workflowAgent.model
									: Array.isArray(workflowAgent.model)
										? workflowAgent.model[0]
										: (workflowAgent.model as { primary: string })?.primary;
								const defaultProviderId = (workflowAgent as any).providerId || '';

								for (const node of nodes) {
									if (node.type === 'agent') {
										const data = (node.data as Record<string, unknown>) || {};
										if (!data.agentId) {
											data.agentId = existingWf.agentId;
											fixups.push(`Node "${node.id}" (agent): auto-set agentId="${existingWf.agentId}"`);
										}
										const cfg = (data.agentConfig as Record<string, unknown>) || {};
										if (!cfg.providerId && !cfg.modelId) {
											data.agentConfig = {
												providerId: defaultProviderId || '',
												modelId: defaultModelId || '',
											};
											fixups.push(`Node "${node.id}" (agent): auto-set agentConfig={ providerId:"${defaultProviderId || ''}", modelId:"${defaultModelId || ''}" }`);
										} else if (!cfg.modelId && defaultModelId) {
											cfg.modelId = defaultModelId;
											data.agentConfig = cfg;
											fixups.push(`Node "${node.id}" (agent): auto-set modelId="${defaultModelId}" (was missing)`);
										} else if (cfg.modelId && !cfg.providerId && defaultProviderId) {
											cfg.providerId = defaultProviderId;
											data.agentConfig = cfg;
											fixups.push(`Node "${node.id}" (agent): auto-set providerId="${defaultProviderId}" (was missing)`);
										}
										(node as Record<string, unknown>).data = data;
									}
								}
							}
						}
					} catch {
						// Non-fatal: if we can't resolve the agent, proceed with whatever the AI provided
					}

					// v6: Auto-default prompt templates for AI-generated workflow nodes.
					//   - All nodes with a `data.prompt` field get a placeholder when empty.
					//   - The FIRST prompt-bearing node (in BFS order from Start) defaults to `{{input}}`.
					//   - All other prompt-bearing nodes default to `{{$prev.output}}` (most recent upstream output).
					try {
						const PROMPT_NODE_TYPES = new Set(['prompt', 'agent']);
						const promptBearing: string[] = [];  // node ids in BFS order
						const seen = new Set<string>(['start']);
						const queue: string[] = ['start'];
						// Build adjacency list once for the BFS
						const adj = new Map<string, string[]>();
						for (const c of connections as Array<{ from: string; to: string }>) {
							const list = adj.get(c.from) ?? [];
							list.push(c.to);
							adj.set(c.from, list);
						}
						while (queue.length > 0) {
							const cur = queue.shift()!;
							for (const next of adj.get(cur) ?? []) {
								if (seen.has(next)) { continue; }
								seen.add(next);
								const nn = nodes.find(n => n.id === next);
								if (nn && PROMPT_NODE_TYPES.has(nn.type as string)) {
									promptBearing.push(next);
								}
								queue.push(next);
							}
						}

						for (let i = 0; i < promptBearing.length; i++) {
							const nid = promptBearing[i];
							const node = nodes.find(n => n.id === nid);
							if (!node) { continue; }
							const data = (node.data as Record<string, unknown>) || {};
							const currentPrompt = (data.prompt as string | undefined) ?? '';
							if (currentPrompt.trim().length > 0) { continue; }  // AI explicitly set it
							const defaultTpl = i === 0
								? '{{input}}'                       // first prompt-bearing node
								: '{{$prev.output}}';               // all others
							data.prompt = defaultTpl;
							(node as Record<string, unknown>).data = data;
							fixups.push(
								`Node "${nid}" (${node.type}): auto-set prompt="${defaultTpl}" ` +
								`(${i === 0 ? 'first prompt node → {{input}}' : 'downstream → {{$prev.output}}'})`,
							);
						}
					} catch (err) {
						// Non-fatal — proceed without the prompt defaults.
						this.logService.warn('[BuiltinTools] workflow_apply: prompt template defaulting failed', err);
					}

					// Build the patch
					const patch: Partial<IStoredWorkflow> = {
						nodes: nodes as unknown as IStoredWorkflow['nodes'],
						connections: connections as unknown as IStoredWorkflow['connections'],
					};
					if (name !== undefined) { patch.name = name; }
					if (description !== undefined) { patch.description = description; }

					const updated = await this.workflowStorageService.updateWorkflow(workflowId, patch, wsId);

					// Notify the controller to push changes to the webview
					workflowAppliedEmitter.fire({ workflow: updated, description: changeDescription });

					const nodeCount = nodes.length;
					const connCount = connections.length;
					let resultText = `Workflow "${updated.name || workflowId}" updated successfully. ${nodeCount} nodes, ${connCount} connections applied.`;
					if (fixups.length > 0) {
						resultText += '\n\n[Format fixes applied — please use the correct format next time to avoid these automatic corrections:]';
						for (const f of fixups) {
							resultText += `\n  • ${f}`;
						}
						resultText += '\n\nReminder: put all content fields (label, agentId, agentConfig, etc.) inside the `data` object in each node.';
					}
					return [{ type: 'text', text: resultText }];
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `workflow_apply error: ${msg}` }];
				}
			},
		});

		this.logService.info('[BuiltinTools] _registerWorkflowTools: 4 workflow tools registered (list/get/schema/apply)');
	}

	// ── Memory helpers ──────────────────────────────────────────

	private _getMemFile(agentId: string, fileName: string): URI {
		const safe = agentId.replace(/[^A-Za-z0-9_.-]/g, '_');
		return URI.joinPath(this.environmentService.userHome, '.saros', 'memory', safe, fileName);
	}

	private async _readJsonl(file: URI): Promise<any[]> {
		try {
			const buf = await this.fileService.readFile(file);
			const text = buf.value.toString();
			const out: any[] = [];
			for (const raw of text.split('\n')) {
				const line = raw.trim();
				if (!line) { continue; }
				try { out.push(JSON.parse(line)); } catch {}
			}
			return out;
		} catch {
			return [];
		}
	}

	private async _writeAtomic(file: URI, entries: any[]): Promise<void> {
		const text = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
		const tmpFile = URI.joinPath(file, '..', `.mem_${Date.now()}_${Math.random().toString(36).slice(2)}`);
		try {
			await this.fileService.writeFile(tmpFile, VSBuffer.fromString(text));
			await this.fileService.move(tmpFile, file, true);
		} catch (err) {
			try { await this.fileService.del(tmpFile); } catch {}
			throw err;
		}
	}
}

// FileType 仅在某些类型守卫处使用，确保 import 不被 tree-shake 报 unused
void FileType;
