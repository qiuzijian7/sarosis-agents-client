/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bundled MCP Server Presets — 从 Hermes-Agent 迁移的 MCP 服务器预置配置
 *
 * 这些预置定义了常见的 MCP 服务器启动配置，用户在 Sarosis 中
 * 添加 MCP 服务器时可直接选择预置，简化配置流程。
 *
 * 资源文件化：
 *   - 预设定义已从硬编码迁移到 JSON 文件：resources/.agents/mcp-presets/*.json
 *   - 运行时通过 loadMcpPresetsFromResources() 从 JSON 文件加载
 *   - BUNDLED_MCP_PRESETS 作为 fallback，在 JSON 加载失败时使用
 */

/**
 * MCP 服务器传输类型
 */
export type McpTransportType = 'stdio' | 'http';

/**
 * MCP 服务器预置配置
 */
export interface IMcpServerPreset {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly transportType: McpTransportType;
	readonly command?: string;
	readonly args?: readonly string[];
	readonly url?: string;
	readonly envKeys?: readonly string[];
	readonly headers?: Readonly<Record<string, string>>;
	readonly icon?: string;
	/** Built-in MCP: auto-installed and auto-started on app launch. */
	readonly builtin?: boolean;
}

// ── Hardcoded fallback (used when JSON loading fails) ─────────────────────
const FALLBACK_PRESETS: readonly IMcpServerPreset[] = [
	{
		id: "codebase-memory-mcp",
		name: "Codebase Memory",
		description: "Code intelligence engine: full-indexes repositories into a knowledge graph of functions, classes, call chains, and cross-service links. 14 MCP tools for structural queries.",
		transportType: "stdio",
		command: "codebase-memory-mcp",
		icon: "🧠",
		builtin: true,
	},
	{
		id: "filesystem",
		name: "Filesystem",
		description: "Secure file system access for reading, writing, and searching files",
		transportType: "stdio",
		command: "npx",
		args: ["-y","@modelcontextprotocol/server-filesystem"],
	},
	{
		id: "github",
		name: "GitHub",
		description: "GitHub API access for repos, issues, PRs, and more",
		transportType: "stdio",
		command: "npx",
		args: ["-y","@modelcontextprotocol/server-github"],
		envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
	},
	{
		id: "gitlab",
		name: "GitLab",
		description: "GitLab API access for projects, issues, MRs, and more",
		transportType: "stdio",
		command: "npx",
		args: ["-y","@modelcontextprotocol/server-gitlab"],
		envKeys: ["GITLAB_PERSONAL_ACCESS_TOKEN"],
	},
	{
		id: "postgres",
		name: "PostgreSQL",
		description: "PostgreSQL database access with read-only queries",
		transportType: "stdio",
		command: "npx",
		args: ["-y","@modelcontextprotocol/server-postgres"],
		envKeys: ["POSTGRES_CONNECTION_STRING"],
	},
	{
		id: "sqlite",
		name: "SQLite",
		description: "SQLite database access for queries and schema inspection",
		transportType: "stdio",
		command: "npx",
		args: ["-y","@modelcontextprotocol/server-sqlite"],
	},
	{
		id: "brave-search",
		name: "Brave Search",
		description: "Web search using Brave Search API",
		transportType: "stdio",
		command: "npx",
		args: ["-y","@modelcontextprotocol/server-brave-search"],
		envKeys: ["BRAVE_API_KEY"],
	},
	{
		id: "puppeteer",
		name: "Puppeteer",
		description: "Browser automation using Puppeteer for web scraping and interaction",
		transportType: "stdio",
		command: "npx",
		args: ["-y","@modelcontextprotocol/server-puppeteer"],
	},
	{
		id: "memory",
		name: "Memory",
		description: "Knowledge graph-based persistent memory system",
		transportType: "stdio",
		command: "npx",
		args: ["-y","@modelcontextprotocol/server-memory"],
	},
	{
		id: "sequential-thinking",
		name: "Sequential Thinking",
		description: "Dynamic problem-solving through structured thinking steps",
		transportType: "stdio",
		command: "npx",
		args: ["-y","@modelcontextprotocol/server-sequential-thinking"],
	},
	{
		id: "time",
		name: "Time",
		description: "Time and timezone conversion utilities",
		transportType: "stdio",
		command: "uvx",
		args: ["mcp-server-time"],
	},
	{
		id: "notion",
		name: "Notion",
		description: "Notion workspace access for pages, databases, and content",
		transportType: "http",
		url: "https://mcp.notion.com/mcp",
	},
	{
		id: "slack",
		name: "Slack",
		description: "Slack workspace access for channels, messages, and users",
		transportType: "stdio",
		command: "npx",
		args: ["-y","@modelcontextprotocol/server-slack"],
		envKeys: ["SLACK_BOT_TOKEN","SLACK_TEAM_ID"],
	},
	{
		id: "google-drive",
		name: "Google Drive",
		description: "Google Drive file access and search",
		transportType: "stdio",
		command: "npx",
		args: ["-y","@modelcontextprotocol/server-google-drive"],
	},
	{
		id: "fetch",
		name: "Fetch",
		description: "HTTP request tool for fetching web content",
		transportType: "stdio",
		command: "uvx",
		args: ["mcp-server-fetch"],
	},
	{
		id: "codex",
		name: "Codex",
		description: "OpenAI Codex MCP server for code generation",
		transportType: "stdio",
		command: "codex",
		args: ["mcp-server"],
	},
	{
		id: "everything",
		name: "MCP Everything",
		description: "Test server with all MCP features (tools, resources, prompts, sampling)",
		transportType: "stdio",
		command: "npx",
		args: ["-y","@modelcontextprotocol/server-everything"],
	},
];

/**
 * 当前生效的 MCP 预设列表（可被 JSON 文件覆盖）。
 * 使用 `getMcpPresets()` 获取最新值。
 */
let _mcpPresets: IMcpServerPreset[] = [...FALLBACK_PRESETS];

/**
 * 获取当前的 MCP 预设列表。
 * 优先返回从 JSON 文件加载的预设；如果 JSON 加载失败，返回硬编码 fallback。
 */
export function getMcpPresets(): IMcpServerPreset[] {
	return _mcpPresets;
}

/**
 * 为了向后兼容，导出 `BUNDLED_MCP_PRESETS` 作为 `getMcpPresets()` 的别名。
 * @deprecated 使用 `getMcpPresets()` 代替。
 */
export const BUNDLED_MCP_PRESETS: readonly IMcpServerPreset[] = FALLBACK_PRESETS;

/**
 * 直接传入预设数组来更新（用于测试或自定义）。
 */
export function setMcpPresets(presets: IMcpServerPreset[]): void {
	_mcpPresets = presets;
}
