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
import * as path from '../../../../../../base/common/path.js';
import { IFileService, FileType } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
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

	readonly id: string = 'sarosis.builtin-tools';
	readonly name: string = 'Sarosis Built-in Tools';

	private readonly _tools = new Map<string, IToolDescriptor>();
	private readonly _disabledTools = new Set<string>();
	private readonly _onDidChangeTools = this._register(new Emitter<void>());
	readonly onDidChangeTools: Event<void> = this._onDidChangeTools.event;

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
	) {
		super();
		this._registerCoreTools();
		this._registerMemoryTools();
		this._registerSkillTools();
		this._registerBundledTools();
		this._registerDelegationTools();
		this._registerKanbanTools();
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
		// 沙箱边界【只】取决于 Employee.worktreePath（agent 实例级 worktree）。
		// 这是一条独立逻辑——表示"该 agent 实例运行时被限制在此 worktree 内"。
		// 切勿 fallback 到 Workspace.worktreePath：后者是【另一条独立逻辑】
		// （用户切换当前工作区的 SCM 视角，由 sourceControl.contribution 处理），
		// 与 agent 实例沙箱无关，二者不可耦合。
		let worktreeRoot: string | undefined;
		if (agentId) {
			try {
				const employee = await this.studioService.getEmployee(agentId);
				if (employee?.worktreePath) {
					worktreeRoot = employee.worktreePath.replace(/[\\/]+$/, '');
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

			// 2. Sarosis Agent 工作区路径
			if (agentId) {
				try {
					const employee = await this.studioService.getEmployee(agentId);
					if (employee?.workspaceId) {
						const workspace = await this.studioService.getWorkspace(employee.workspaceId);
						if (workspace?.path) {
							allowedRoots.push(workspace.path.replace(/[\\/]+$/, ''));
						}
						// 关联代码仓库（多仓库管理）— 全部纳入沙箱允许根
						for (const rf of workspace?.relatedFolders ?? []) {
							if (rf?.path) {
								allowedRoots.push(rf.path.replace(/[\\/]+$/, ''));
							}
						}
					}
				} catch (err) {
					this.logService.warn(`[BuiltinTools] Failed to resolve Sarosis workspace for agent ${agentId}:`, err);
				}
			}
		}

		// 去重
		const uniqueRoots = [...new Set(allowedRoots)];

		// 如果是相对路径，基于第一个允许的工作区根目录解析为绝对路径
		let resolvedPath = requestedPath;
		if (!path.isAbsolute(requestedPath)) {
			if (uniqueRoots.length > 0) {
				resolvedPath = path.join(uniqueRoots[0], requestedPath);
				resolvedPath = path.normalize(resolvedPath);
			}
		}

		const normalizedUri = URI.file(resolvedPath);
		const requestedFsPath = normalizedUri.fsPath;
		// 归一化路径用于边界比较：统一分隔符为正斜杠 + 去尾斜杠 + 小写。
		// ⚠️ worktreeRoot/workspace.path 等可能保留正斜杠（如 G:/foo/bar），
		// 而 path.join + URI.file().fsPath 在 Windows 上产出反斜杠（G:\foo\bar），
		// 若不统一分隔符，startsWith 比较会因 `\` vs `/` 不一致而误判越界。
		const canonicalize = (p: string): string =>
			p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
		const normalizedRequest = canonicalize(requestedFsPath);

		// 检查请求路径是否在任一允许根目录下
		const isAllowed = uniqueRoots.some(root => {
			const normalizedRoot = canonicalize(root);
			return normalizedRequest === normalizedRoot ||
				normalizedRequest.startsWith(normalizedRoot + '/');
		});

		if (!isAllowed) {
			const allowedList = uniqueRoots.length > 0
				? uniqueRoots.map(r => `  - ${r}`).join('\n')
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
				const ctx = await this.requestService.request({ type: 'GET', url, headers, callSite: 'sarosis.builtinTool.http_get' }, CancellationToken.None);
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
	private _registerMemoryTools(): void {
		this.register({
			definition: {
				name: 'recall',
				description:
					'Recall (search) relevant memories from past sessions for the current agent. ' +
					'Returns past conversation snippets, summaries or facts that match the query. ' +
					'Use this when the user asks about something they discussed before, or when you ' +
					'need historical context to answer accurately.',
				inputSchema: {
					type: 'object',
					properties: {
						query: {
							type: 'string',
							description: 'Natural-language query describing what to recall (e.g. "上次我们讨论的 KV cache 方案").',
						},
						limit: {
							type: 'number',
							description: 'Max number of memory entries to return. Default 5, hard-capped at 20.',
						},
					},
					required: ['query'],
				},
				category: 'memory',
				source: this.id,
				securityLevel: ToolSecurityLevel.Safe,
			},
			handler: async (args, _signal, agentId) => {
				const query = String(args['query'] ?? '').trim();
				if (!query) {
					throw new Error('query is required');
				}
				const limit = Math.min(Math.max(Number(args['limit'] ?? 5), 1), 20);

				const provider = this.agentOS.getActiveMemoryProvider();
				if (!provider) {
					return [{
						type: 'text',
						text: '(no memory provider configured — recall is unavailable in this session)',
					}];
				}

				const effectiveAgentId = agentId ?? '';
				let entries;
				try {
					entries = await provider.searchMemory(effectiveAgentId, query);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.logService.warn(`[BuiltinTools.recall] ${provider.id} searchMemory failed: ${msg}`);
					return [{
						type: 'text',
						text: `(recall failed via provider "${provider.name}": ${msg})`,
					}];
				}

				if (!entries || entries.length === 0) {
					return [{
						type: 'text',
						text: `(no relevant memories found for query: ${query})`,
					}];
				}

				const trimmed = entries.slice(0, limit);
				const lines: string[] = [
					`Recalled ${trimmed.length} memory entr${trimmed.length === 1 ? 'y' : 'ies'} (provider: ${provider.name}):`,
					'',
				];
				trimmed.forEach((e, i) => {
					const when = e.timestamp ? new Date(e.timestamp).toISOString() : 'unknown-time';
					const score = typeof e.score === 'number' ? ` score=${e.score.toFixed(3)}` : '';
					lines.push(`--- [${i + 1}] type=${e.type}${score} ts=${when} ---`);
					lines.push((e.content ?? '').slice(0, 4_000));
					lines.push('');
				});
				return [{ type: 'text', text: lines.join('\n') }];
			},
		});

		this.logService.info('[BuiltinTools] _registerMemoryTools: recall registered');
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

			// 发送命令到终端
			await instance.sendText(command, true);

			// 等待输出或超时
			const timeoutMs = timeoutSec * 1000;
			let result = '';

			const abortPromise = signal
				? new Promise<string>((resolve) => {
					const onAbort = () => resolve('[CANCELLED] Command execution was cancelled by user.\n');
					signal.addEventListener('abort', onAbort, { once: true });
				})
				: new Promise<string>(() => { /* never resolves */ });

			const timeoutPromise = new Promise<string>((resolve) => {
				setTimeout(() => resolve(`[TIMEOUT] Command timed out after ${timeoutSec}s\n`), timeoutMs);
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
							{ type: SubAgentType.General },
						);
						if (result.success) {
							return [{ type: 'text', text: result.output ?? '(no output)' }];
						} else {
							return [{ type: 'text', text: `Sub-agent failed: ${result.error ?? 'unknown error'}` }];
						}
					} else {
						// Batch tasks mode — use dispatchParallelExplore()
						const results = await (this.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch).dispatchParallelExplore(
							agentId ?? 'unknown',
							tasks!,
							executeFn,
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
	 * agentId → workspaceId 通过 studioService.getEmployee(agentId) 解析。
	 */
	private _registerKanbanTools(): void {
		// 辅助：从 agentId 解析当前 employee 及其 workspaceId
		const resolveWorkspaceId = async (agentId: string | undefined): Promise<{ workspaceId: string; assigneeId?: string; assigneeName?: string } | undefined> => {
			if (!agentId) { return undefined; }
			try {
				const employee = await this.studioService.getEmployee(agentId);
				if (employee?.workspaceId) {
					return { workspaceId: employee.workspaceId, assigneeId: employee.id, assigneeName: employee.name };
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
							const employee = await this.studioService.getEmployee(agentId);
							if (employee?.name) { authorName = employee.name; }
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
		let workspaceId: string | undefined;
		if (agentId) {
			try {
				const employee = await this.studioService.getEmployee(agentId);
				workspaceId = employee?.workspaceId;
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
			const employee = await this.studioService.getEmployee(agentId);
			return employee?.workspaceId;
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
}

// FileType 仅在某些类型守卫处使用，确保 import 不被 tree-shake 报 unused
void FileType;
