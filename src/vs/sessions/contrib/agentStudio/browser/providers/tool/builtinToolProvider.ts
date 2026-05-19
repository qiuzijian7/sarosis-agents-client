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
 *   filesystem: file_read, file_write, file_list, file_search
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
import { IToolProvider, IToolDefinition, IToolCall, IToolResult, IToolResultContent } from '../../../common/providers.js';
import { BUNDLED_TOOL_DEFINITIONS } from '../../../common/bundled-tools/bundledTools.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<IToolResultContent[]>;

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

	async executeTool(_agentId: string, toolCall: IToolCall): Promise<IToolResult> {
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
		try {
			const content = await t.handler(toolCall.arguments ?? {});
			return { toolCallId: toolCall.id, success: true, content };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[BuiltinTools] ${toolCall.name} failed: ${msg}`);
			return { toolCallId: toolCall.id, success: false, content: [], error: msg };
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
			handler: async args => {
				const uri = URI.file(String(args['path']));
				const buf = await this.fileService.readFile(uri);
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
			},
			handler: async args => {
				const uri = URI.file(String(args['path']));
				const content = String(args['content'] ?? '');
				await this.fileService.writeFile(uri, VSBuffer.fromString(content));
				return text(`wrote ${content.length} chars to ${uri.fsPath}`);
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
			handler: async args => {
				const uri = URI.file(String(args['path']));
				const stat = await this.fileService.resolve(uri);
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
				name: 'file_search',
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
			handler: async args => {
				const root = URI.file(String(args['path']));
				const query = String(args['query'] ?? '');
				const limit = Math.min(Math.max(Number(args['maxResults'] ?? 50), 1), 500);
				if (!query) { throw new Error('query is required'); }
				const hits: string[] = [];
				await this._walkAndGrep(root, query, hits, limit);
				return [{ type: 'text', text: hits.join('\n') || '(no matches)' }];
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
