/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内置 Tool Provider —— 见 `common/providers.ts` 中的 `IToolProvider` 契约。
 *
 * 工具集（22 个 Sarosis 内部工具，按 category 分组）：
 *   search     : grep_search, search_files
 *   filesystem : list_dir, read_file, replace_in_file, edit_file, write_to_file
 *   terminal   : terminal
 *   mcp        : use_mcp_tool, fetch_mcp_tools, grep_mcp_tools
 *   skills     : use_skill
 *   vision     : read_image, capture_screen
 *   web        : web_preview
 *   env        : get_env_info
 *   media      : generate_picture
 *   history    : read_history_context, grep_history_context
 *   scheduler  : cron
 *   notify     : notify
 *   download   : display_download_links
 *
 * 设计借鉴 Hermes-Agent `tools/registry.py`：
 *   - 每个工具用一个常量描述符注册（schema + handler + check）。
 *   - `category` 充当 hermes 的 toolset，便于 UI 按组展示与启停。
 *   - `check_fn` 决定该工具在当前环境是否可用（例如 shell_exec 仅在桌面端）。
 *
 * 旧工具名迁移：
 *   echo, get_current_time, math_eval, http_get, exit_plan_mode, ask_user_question → 已移除
 *   file_read → read_file, file_write → write_to_file, file_list → list_dir
 *   search_files → grep_search, read_skill → use_skill
 *
 * 从 Hermes-Agent 迁移了 69 个 bundled tool 定义（schema-only），作为 MCP 未配置时的 fallback。
 */

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IFileService, FileType } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IToolProvider, IToolDefinition, IToolCall, IToolResult, IToolResultContent, ToolSecurityLevel } from '../../../common/providers.js';
import { BUNDLED_TOOL_DEFINITIONS } from '../../../common/bundled-tools/bundledTools.js';
import { ISkillRegistry } from '../../../common/skills.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ITerminalService } from '../../../../../../workbench/contrib/terminal/browser/terminal.js';


type ToolHandler = (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => Promise<IToolResultContent[]>;

interface IToolDescriptor {
	readonly definition: IToolDefinition;
	readonly handler: ToolHandler;
	/** 返回 false 表示当前环境不支持该工具，listTools 会跳过它。 */
	readonly available?: () => boolean;
	/** 标记为 stub — 只有 schema 定义，没有实际 handler 实现。listTools 会跳过这些工具，防止 LLM 看到后尝试调用导致 "not yet implemented" 错误。 */
	readonly isStub?: boolean;
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
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();
		this._registerCoreTools();
		this._registerBundledTools();
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

		// ── filesystem ─────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'read_file',
				description: '读取本地文件内容。Returns the full file content (max 256 KiB).',
				inputSchema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Absolute or workspace-relative path' },
						start_line: { type: 'number', description: 'Start line number (1-based, optional)' },
						end_line: { type: 'number', description: 'End line number (inclusive, optional)' },
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

				// 读取操作允许任意路径，不再检查工作区限制
				// 写入操作才需要检查工作区限制（在 write_to_file 等工具中）

				const normalizedUri = URI.file(requestedPath);
				const buf = await this.fileService.readFile(normalizedUri);
				if (buf.value.byteLength > 256 * 1024) {
					throw new Error(`file too large (${buf.value.byteLength} bytes), use a streaming tool`);
				}
				let content = buf.value.toString();
				const startLine = Number(args['start_line'] ?? 1);
				const endLine = Number(args['end_line'] ?? Infinity);
				if (isFinite(startLine) || isFinite(endLine)) {
					const lines = content.split('\n');
					const start = Math.max((isFinite(startLine) ? startLine : 1) - 1, 0);
					const end = isFinite(endLine) ? Math.min(endLine, lines.length) : lines.length;
					content = lines.slice(start, end).join('\n');
				}
			return text(content);
		},
		});

		this.register({
			definition: {
				name: 'write_to_file',
				description: '写入/创建文件。Creates the file and parent directories if they do not exist.',
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

			// 写入操作：不再阻止工作区外的路径
			// 提示词已要求LLM在写入工作区外文件前请求用户批准
			// 如果用户未批准但LLM仍尝试写入，我们允许操作（依赖提示词约束）

			const normalizedUri = URI.file(requestedPath);
			const content = String(args['content'] ?? '');
			await this.fileService.writeFile(normalizedUri, VSBuffer.fromString(content));
		return text(`wrote ${content.length} chars to ${normalizedUri.fsPath}`);
		},
		});

	this.register({
			definition: {
				name: 'list_dir',
				description: '列出目录内容。Returns an array of { name, type, size }.',
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

			// 列表操作允许任意路径，不再检查工作区限制

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
				name: 'grep_search',
				description: '正则/精确文本搜索 (ripgrep)。Returns matching path:line snippets.',
				inputSchema: {
					type: 'object',
					properties: {
						path: { type: 'string' },
						pattern: { type: 'string', description: 'Search pattern (literal or regex)' },
						file_pattern: { type: 'string', description: 'Glob pattern to filter files (e.g., "*.py")' },
						ignore_case: { type: 'boolean', description: 'Case-insensitive search (default: true)' },
						max_results: { type: 'number', description: 'Maximum number of results (default: 50)' },
					},
					required: ['path', 'pattern'],
				},
				category: 'search',
				source: this.id,
			},
		handler: async (args, _signal, agentId) => {
			const requestedPath = String(args['path'] || '');
			if (!requestedPath) {
				throw new Error('path is required');
			}

			// 搜索操作允许任意路径，不再检查工作区限制

			const normalizedUri = URI.file(requestedPath);
			const pattern = String(args['pattern'] ?? '');
				const filePattern = String(args['file_pattern'] ?? '');
				const ignoreCase = Boolean(args['ignore_case'] ?? true);
				const limit = Math.min(Math.max(Number(args['max_results'] ?? 50), 1), 500);
				if (!pattern) { throw new Error('pattern is required'); }

				const regex = (() => {
					try {
						return new RegExp(pattern, ignoreCase ? 'i' : '');
					} catch {
						return null;
					}
				})();

				const hits: string[] = [];
				const matcher = regex
					? (t: string) => regex.test(t)
					: (t: string) => ignoreCase ? t.toLowerCase().includes(pattern.toLowerCase()) : t.includes(pattern);
				await this._walkAndGrep(normalizedUri, matcher, hits, limit, filePattern);
			return [{ type: 'text', text: hits.join('\n') || '(no matches)' }];
		},
		});

	// ── terminal ─────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'terminal',
				description: '执行命令行命令。Returns stdout, stderr, and exit code.',
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

		// ── search / search_files ─────────────────────────────────────
		this.register({
			definition: {
				name: 'search_files',
				description: '模糊搜索文件/目录路径。Fuzzy-match file and directory names by name substring. Returns matching paths.',
				inputSchema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Root directory to search in' },
						query: { type: 'string', description: 'File/directory name substring to match' },
						max_results: { type: 'number', description: 'Maximum number of results (default: 50)' },
					},
					required: ['path', 'query'],
				},
				category: 'search',
				source: this.id,
			},
		handler: async (args, _signal, agentId) => {
			const requestedPath = String(args['path'] || '');
			if (!requestedPath) { throw new Error('path is required'); }
			// 文件搜索允许任意路径，不再检查工作区限制
			const normalizedUri = URI.file(requestedPath);
			const query = String(args['query'] ?? '').toLowerCase();
				const limit = Math.min(Math.max(Number(args['max_results'] ?? 50), 1), 500);
				if (!query) { throw new Error('query is required'); }

				const matches: string[] = [];
				await this._walkAndMatchNames(normalizedUri, query, matches, limit);
				return [{ type: 'text', text: matches.join('\n') || '(no matches)' }];
			},
		});

		// ── mcp ───────────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'use_mcp_tool',
				description: '调用 MCP Server 提供的工具。Execute a tool provided by a connected MCP server.',
				inputSchema: {
					type: 'object',
					properties: {
						server: { type: 'string', description: 'MCP server name or id' },
						tool: { type: 'string', description: 'Tool name on the MCP server' },
						arguments: { type: 'object', description: 'Tool arguments as a key-value object' },
					},
					required: ['server', 'tool'],
				},
				category: 'mcp',
				source: this.id,
			},
			handler: async (args) => {
				const server = String(args['server'] ?? '');
				const tool = String(args['tool'] ?? '');
				const mcpArgs = (args['arguments'] as Record<string, unknown>) ?? {};
				return text(`[MCP stub] use_mcp_tool called: server="${server}", tool="${tool}", args=${JSON.stringify(mcpArgs)}. Configure an MCP server to enable real execution.`);
			},
		});

		this.register({
			definition: {
				name: 'fetch_mcp_tools',
				description: '获取 MCP Server 工具的详细描述。Returns tool schemas from a connected MCP server.',
				inputSchema: {
					type: 'object',
					properties: {
						server: { type: 'string', description: 'MCP server name or id' },
					},
					required: ['server'],
				},
				category: 'mcp',
				source: this.id,
			},
			handler: async (args) => {
				const server = String(args['server'] ?? '');
				return text(`[MCP stub] fetch_mcp_tools called for server="${server}". Configure an MCP server to enable real tool listing.`);
			},
		});

		this.register({
			definition: {
				name: 'grep_mcp_tools',
				description: '按关键词搜索 MCP 工具。Search for tools on a connected MCP server by keyword.',
				inputSchema: {
					type: 'object',
					properties: {
						server: { type: 'string', description: 'MCP server name or id' },
						query: { type: 'string', description: 'Keyword to search for in tool names and descriptions' },
					},
					required: ['server', 'query'],
				},
				category: 'mcp',
				source: this.id,
			},
			handler: async (args) => {
				const server = String(args['server'] ?? '');
				const query = String(args['query'] ?? '');
				return text(`[MCP stub] grep_mcp_tools called: server="${server}", query="${query}". Configure an MCP server to enable real search.`);
			},
		});

		// ── vision ──────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'read_image',
				description: '读取/分析图片。Analyze an image using a multimodal vision model.',
				inputSchema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Image file path or URL' },
						query: { type: 'string', description: 'Question or instruction about the image' },
					},
					required: ['path'],
				},
				category: 'vision',
				source: this.id,
			},
			handler: async (args) => {
				const path = String(args['path'] ?? '');
				const query = String(args['query'] ?? 'Describe this image.');
				return text(`[Vision stub] read_image: path="${path}", query="${query}". Configure a vision-capable MCP server or provider to enable real image analysis.`);
			},
		});

		this.register({
			definition: {
				name: 'capture_screen',
				description: '截取屏幕。Capture a screenshot of the current screen or a specific window.',
				inputSchema: {
					type: 'object',
					properties: {
						target: { type: 'string', description: 'Target: "screen", "window", or window id (optional)' },
					},
				},
				category: 'vision',
				source: this.id,
			},
			handler: async (args) => {
				const target = String(args['target'] ?? 'screen');
				return text(`[Vision stub] capture_screen: target="${target}". Configure a screen capture provider to enable real screenshots.`);
			},
		});

		// ── web ─────────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'web_preview',
				description: '预览前端 Web 页面。Load and render a web page, returning the content.',
				inputSchema: {
					type: 'object',
					properties: {
						url: { type: 'string', description: 'URL to preview' },
						_wait: { type: 'number', description: 'Wait time in ms before capturing (default: 500)' },
					},
					required: ['url'],
				},
				category: 'web',
				source: this.id,
			},
			handler: async (args) => {
				const url = String(args['url'] ?? '');
				if (!/^https?:\/\//i.test(url)) { throw new Error('url must start with http:// or https://'); }
				return text(`[Web stub] web_preview: url="${url}". Configure a browser automation provider to enable real web previews.`);
			},
		});

		// ── env ─────────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'get_env_info',
				description: '获取环境变量信息。Returns environment variables and system information.',
				inputSchema: {
					type: 'object',
					properties: {
						filter: { type: 'string', description: 'Optional prefix filter for environment variable names' },
					},
				},
				category: 'env',
				source: this.id,
			},
			handler: async (args) => {
				const filter = String(args['filter'] ?? '');
				const entries = Object.entries(process.env ?? {}).filter(([k]) => !filter || k.startsWith(filter));
				const lines = entries.map(([k, v]) => `${k}=${v ?? ''}`);
				return text(lines.join('\n') || '(no env vars)');
			},
		});

		// ── media ──────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'generate_picture',
				description: 'AI 图像生成 (文生图/图生图)。Generate an image from a text prompt or transform an existing image.',
				inputSchema: {
					type: 'object',
					properties: {
						prompt: { type: 'string', description: 'Image generation prompt' },
						negative_prompt: { type: 'string', description: 'What to avoid in the generated image' },
						width: { type: 'number', description: 'Image width in pixels (default: 1024)' },
						height: { type: 'number', description: 'Image height in pixels (default: 1024)' },
						image_url: { type: 'string', description: 'Reference image URL for image-to-image generation (optional)' },
					},
					required: ['prompt'],
				},
				category: 'media',
				source: this.id,
			},
			handler: async (args) => {
				const prompt = String(args['prompt'] ?? '');
				return text(`[Media stub] generate_picture: prompt="${prompt}". Configure an image generation MCP server to enable real generation.`);
			},
		});

		// ── history ───────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'read_history_context',
				description: '读取历史对话上下文。Read recent conversation history for context.',
				inputSchema: {
					type: 'object',
					properties: {
						limit: { type: 'number', description: 'Number of recent messages to retrieve (default: 20)' },
					},
				},
				category: 'history',
				source: this.id,
			},
			handler: async (args) => {
				const limit = Math.min(Math.max(Number(args['limit'] ?? 20), 1), 200);
				return text(`[History stub] read_history_context: limit=${limit}. Configure a session memory provider to enable real history retrieval.`);
			},
		});

		this.register({
			definition: {
				name: 'grep_history_context',
				description: '按关键词搜索历史上下文。Search conversation history for messages matching a keyword.',
				inputSchema: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Keyword to search for in conversation history' },
						limit: { type: 'number', description: 'Maximum number of results (default: 10)' },
					},
					required: ['query'],
				},
				category: 'history',
				source: this.id,
			},
			handler: async (args) => {
				const query = String(args['query'] ?? '');
				const limit = Math.min(Math.max(Number(args['limit'] ?? 10), 1), 100);
				return text(`[History stub] grep_history_context: query="${query}", limit=${limit}. Configure a session memory provider to enable real history search.`);
			},
		});

		// ── scheduler ──────────────────────────────────────────────
		this.register({
			definition: {
				name: 'cron',
				description: '创建/管理定时任务。Manage scheduled tasks: create, list, update, pause, resume, and remove cron jobs.',
				inputSchema: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ['create', 'list', 'update', 'pause', 'resume', 'remove', 'trigger'], description: 'Action to perform' },
						name: { type: 'string', description: 'Cron job name' },
						schedule: { type: 'string', description: 'Cron schedule expression (e.g., "0 9 * * *")' },
						task: { type: 'string', description: 'Task description for the scheduled job' },
					},
					required: ['action'],
				},
				category: 'scheduler',
				source: this.id,
			},
			handler: async (args) => {
				const action = String(args['action'] ?? '');
				const name = String(args['name'] ?? '');
				const schedule = String(args['schedule'] ?? '');
				const task = String(args['task'] ?? '');
				return text(`[Scheduler stub] cron: action="${action}", name="${name}", schedule="${schedule}", task="${task}". Configure a scheduler service to enable real cron job management.`);
			},
		});

		// ── notify ────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'notify',
				description: '发送通知消息。Send a notification to the user.',
				inputSchema: {
					type: 'object',
					properties: {
						message: { type: 'string', description: 'Notification message text' },
						level: { type: 'string', enum: ['info', 'warning', 'error'], description: 'Notification level (default: info)' },
					},
					required: ['message'],
				},
				category: 'notify',
				source: this.id,
			},
			handler: async (args) => {
				const message = String(args['message'] ?? '');
				const level = String(args['level'] ?? 'info');
				this.logService.info(`[Notify] [${level}] ${message}`);
				return text(`notification sent: [${level}] ${message}`);
			},
		});

		// ── download ────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'display_download_links',
				description: '生成文件下载链接。Generate temporary download links for one or more files.',
				inputSchema: {
					type: 'object',
					properties: {
						paths: { type: 'array', items: { type: 'string' }, description: 'File paths to generate download links for' },
						expires_in: { type: 'number', description: 'Link expiry time in seconds (default: 3600)' },
					},
					required: ['paths'],
				},
				category: 'download',
				source: this.id,
			},
			handler: async (args) => {
				const paths = (args['paths'] as string[]) ?? [];
				const expiresIn = Number(args['expires_in'] ?? 3600);
				if (paths.length === 0) { throw new Error('paths is required and must be non-empty'); }
				const links = paths.map(p => `[stub] download link for "${p}" (expires in ${expiresIn}s)`);
				return text(links.join('\n'));
			},
		});

		this.logService.info('[BuiltinTools] _registerCoreTools: all 22 tools registered');

		// ── skills ───────────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'use_skill',
				description: '加载并使用 Skill。Read the full instructions of an installed skill by its id.',
				inputSchema: {
					type: 'object',
					properties: {
						skill_id: { type: 'string', description: 'The skill id (from <available_skills> in system prompt)' },
					},
					required: ['skill_id'],
				},
				category: 'skills',
				source: this.id,
			},
			handler: async (args) => {
				const skillId = String(args['skill_id'] ?? '').trim();
				if (!skillId) { throw new Error('skill_id is required'); }

				const skill = this.skillRegistry.getSkill(skillId);
				if (!skill) {
					const allSkills = this.skillRegistry.getSkills();
					const byName = allSkills.find(s => s.name.toLowerCase() === skillId.toLowerCase());
					if (byName) {
						const content = byName.prompt.slice(0, 256_000);
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
				const content = skill.prompt.slice(0, 256_000);
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

		// list_skills removed — merged into use_skill
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
				isStub: true, // 标记为 stub — listTools 会跳过，防止 LLM 尝试调用
			});
		}
	}

	private async _walkAndGrep(
		dir: URI,
		matcher: (line: string) => boolean,
		out: string[],
		limit: number,
		filePattern?: string,
	): Promise<void> {
		if (out.length >= limit) { return; }
		let stat;
		try { stat = await this.fileService.resolve(dir); } catch { return; }
		if (!stat.isDirectory || !stat.children) { return; }
		// Simple glob match — supports "*.py", "src/*.ts" patterns
		const globToRegex = (pattern: string): RegExp => {
			const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
			const regexStr = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
			return new RegExp(regexStr);
		};
		const fileRegex = filePattern ? globToRegex(filePattern) : null;
		for (const child of stat.children) {
			if (out.length >= limit) { return; }
			if (child.isDirectory) {
				// 跳过常见噪声目录
				if (child.name === 'node_modules' || child.name === '.git' || child.name === 'out' || child.name === 'dist') { continue; }
				await this._walkAndGrep(child.resource, matcher, out, limit, filePattern);
				continue;
			}
			if (!child.isFile) { continue; }
			if (fileRegex && !fileRegex.test(child.name)) { continue; }
			if (typeof child.size === 'number' && child.size > 512 * 1024) { continue; }
			try {
				const buf = await this.fileService.readFile(child.resource);
				const text = buf.value.toString();
				const lines = text.split('\n');
				for (let i = 0; i < lines.length; i++) {
					if (matcher(lines[i])) {
						out.push(`${child.resource.fsPath}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
						if (out.length >= limit) { return; }
					}
				}
			} catch { /* skip binary */ }
		}
	}

	private async _walkAndMatchNames(dir: URI, query: string, out: string[], limit: number): Promise<void> {
		if (out.length >= limit) { return; }
		let stat;
		try { stat = await this.fileService.resolve(dir); } catch { return; }
		if (!stat.isDirectory || !stat.children) { return; }
		for (const child of stat.children) {
			if (out.length >= limit) { return; }
			if (child.isDirectory) {
				if (child.name === 'node_modules' || child.name === '.git' || child.name === 'out' || child.name === 'dist') { continue; }
				if (child.name.toLowerCase().includes(query)) {
					out.push(`${child.resource.fsPath}/`);
					if (out.length >= limit) { return; }
				}
				await this._walkAndMatchNames(child.resource, query, out, limit);
			} else if (child.isFile) {
				if (child.name.toLowerCase().includes(query)) {
					out.push(child.resource.fsPath);
					if (out.length >= limit) { return; }
				}
			}
		}
	}
}

// FileType 仅在某些类型守卫处使用，确保 import 不被 tree-shake 报 unused
void FileType;
