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
import { IRequestService, asText } from '../../../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IToolProvider, IToolDefinition, IToolCall, IToolResult, IToolResultContent, ToolSecurityLevel } from '../../../common/providers.js';
import { BUNDLED_TOOL_DEFINITIONS } from '../../../common/bundled-tools/bundledTools.js';
import { ISkillRegistry } from '../../../common/skills.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ITerminalService } from '../../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IAgentStudioService } from '../../../common/agentStudio.js';


type ToolHandler = (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => Promise<IToolResultContent[]>;

interface IToolDescriptor {
	readonly definition: IToolDefinition;
	readonly handler: ToolHandler;
	/** 返回 false 表示当前环境不支持该工具，listTools 会跳过它。 */
	readonly available?: () => boolean;
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
	) {
		super();
		this._registerCoreTools();
		this._registerSkillTools();
		this._registerBundledTools();
	}

	// ─── 路径安全校验 ─────────────────────────────────────────────────────

	/**
	 * 检查请求的路径是否在允许的工作区目录内。
	 * 同时检查 VS Code 工作区文件夹和 Sarosis Agent 工作区路径。
	 * Windows 路径大小写不敏感。
	 *
	 * @param agentId 当前 agent 的 ID，用于查找 Sarosis workspace 路径
	 * @param requestedPath 请求的文件/目录路径
	 * @throws Error 如果路径不在任何允许的工作区内
	 */
	private async _checkWorkspacePath(agentId: string | undefined, requestedPath: string): Promise<void> {
		const normalizedUri = URI.file(requestedPath);
		const requestedFsPath = normalizedUri.fsPath;
		const normalizedRequest = requestedFsPath.replace(/[\\/]+$/, '').toLowerCase();

		// 收集所有允许的根路径
		const allowedRoots: string[] = [];

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
				}
			} catch (err) {
				this.logService.warn(`[BuiltinTools] Failed to resolve Sarosis workspace for agent ${agentId}:`, err);
			}
		}

		// 检查请求路径是否在任一允许根目录下
		const isAllowed = allowedRoots.some(root => {
			const normalizedRoot = root.toLowerCase();
			return normalizedRequest === normalizedRoot ||
			       normalizedRequest.startsWith(normalizedRoot + '\\') ||
			       normalizedRequest.startsWith(normalizedRoot + '/');
		});

		if (!isAllowed) {
			const allowedList = allowedRoots.length > 0
				? allowedRoots.map(r => `  - ${r}`).join('\n')
				: '  (无 — 请确认已正确配置工作区)';
			throw new Error(
				`安全沙箱限制：路径 "${requestedPath}" 不在允许的工作区目录内。\n` +
				`当前允许的工作区目录：\n${allowedList}\n` +
				`请在上述目录内操作，或在 Sarosis 工作区设置中配置正确的路径。`
			);
		}
	}

	// ─── IToolProvider 实现 ─────────────────────────────────────────────

	async listTools(_agentId: string): Promise<IToolDefinition[]> {
		const out: IToolDefinition[] = [];
		for (const [name, t] of this._tools) {
			// 检查环境可用性
			if (t.available && !t.available()) { continue; }
			// 检查用户是否禁用了该工具
			if (this._disabledTools.has(name)) { continue; }
			out.push(t.definition);
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

			// 路径遍历保护：检查请求的路径是否在工作区目录内
			await this._checkWorkspacePath(agentId, requestedPath);

			const normalizedUri = URI.file(requestedPath);
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

			// 路径遍历保护：检查请求的路径是否在工作区目录内
			await this._checkWorkspacePath(agentId, requestedPath);

			const normalizedUri = URI.file(requestedPath);
			const content = String(args['content'] ?? '');
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

			// 路径遍历保护：检查请求的路径是否在工作区目录内
			await this._checkWorkspacePath(agentId, requestedPath);

			const normalizedUri = URI.file(requestedPath);
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

			// 路径遍历保护：检查请求的路径是否在工作区目录内
			await this._checkWorkspacePath(agentId, requestedPath);

			const normalizedUri = URI.file(requestedPath);
			const query = String(args['query'] ?? '');
			const limit = Math.min(Math.max(Number(args['maxResults'] ?? 50), 1), 500);
			if (!query) { throw new Error('query is required'); }
			const hits: string[] = [];
			await this._walkAndGrep(normalizedUri, query, hits, limit);
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
			handler: async (args, signal) => {
				const command = String(args['command'] ?? '').trim();
				if (!command) { throw new Error('command is required'); }
				const cwd = args['cwd'] ? String(args['cwd']) : undefined;
				const timeoutSec = Math.min(Math.max(Number(args['timeout'] ?? 30), 1), 300);

				return this._executeTerminalCommand(command, cwd, timeoutSec, signal);
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

	// ─── Skill 按需读取工具 ───────────────────────────────────────────

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
			// 解析工作目录
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
			this.register({
				definition: { ...def, source: this.id },
				handler: async () => [{
					type: 'text' as const,
					text: `Tool "${def.name}" is defined but not yet implemented natively. ` +
						`Configure an MCP server that provides this tool, or it will be available ` +
						`when a matching provider is registered.`,
				}],
			});
		}
	}

	private async _walkAndGrep(dir: URI, query: string, out: string[], limit: number): Promise<void> {
		if (out.length >= limit) { return; }
		let stat;
		try { stat = await this.fileService.resolve(dir); } catch { return; }
		if (!stat.isDirectory || !stat.children) { return; }
		for (const child of stat.children) {
			if (out.length >= limit) { return; }
			if (child.isDirectory) {
				// 跳过常见噪声目录
				if (child.name === 'node_modules' || child.name === '.git' || child.name === 'out' || child.name === 'dist') { continue; }
				await this._walkAndGrep(child.resource, query, out, limit);
				continue;
			}
			if (!child.isFile) { continue; }
			if (typeof child.size === 'number' && child.size > 512 * 1024) { continue; } // skip > 512 KiB
			try {
				const buf = await this.fileService.readFile(child.resource);
				const text = buf.value.toString();
				const lines = text.split('\n');
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].includes(query)) {
						out.push(`${child.resource.fsPath}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
						if (out.length >= limit) { return; }
					}
				}
			} catch { /* skip binary */ }
		}
	}
}

// FileType 仅在某些类型守卫处使用，确保 import 不被 tree-shake 报 unused
void FileType;
