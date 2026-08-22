/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bundled MCP Server Presets — 从 Hermes-Agent 迁移的 MCP 服务器预置配置
 *
 * 这些预置定义了常见的 MCP 服务器启动配置，用户在 Saros 中
 * 添加 MCP 服务器时可直接选择预置，简化配置流程。
 *
 * 数据源（BundledResourceService 运行时装载，三级优先级）：
 *   1. 用户覆盖：~/.vssaros/mcp-presets/*.json
 *   2. 内置资源：resources/.agents/mcp-presets/*.json
 *      （由 scripts/export-bundled-resources.mjs 从本文件导出，保持与硬编码一致）
 *   3. FALLBACK_PRESETS 硬编码兜底（`getMcpPresets()` 的初始值）
 */

/**
 * MCP 服务器传输类型
 */
export type McpTransportType = 'stdio' | 'http';

/**
 * 内置 MCP 的"自动安装并配置"描述（editor pane 一键执行）。
 * - checkCommands: 任一命令在 PATH 中存在 → 视为已安装（跳过安装步骤）。
 * - install: 依次在 shell 中执行的安装命令（如 pip install …）。
 * - envKeys: 可选环境变量提示（渲染为配置引导，如 COMFY_BIN）。
 */
export interface IMcpAutoInstall {
	readonly checkCommands: readonly string[];
	readonly install: readonly string[];
	/**
	 * 「环境变量名 → 命令名」映射：自动安装时把命令的**绝对路径**注入到对应
	 * 环境变量（写入 MCP 配置的 env）。解决「MCP 客户端启动服务器的环境通常
	 * 不含 shell PATH」的问题（如 comfy-mcp 需要 COMFY_BIN 指向 comfy 绝对路径）。
	 * 例如 `{ COMFY_BIN: "comfy" }` → 解析 `comfy` 绝对路径 → env.COMPY_BIN。
	 */
	readonly resolveEnv?: Readonly<Record<string, string>>;
}

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
	/** 一键"自动安装并配置"流程（见 IMcpAutoInstall）。 */
	readonly autoInstall?: IMcpAutoInstall;
}

// ── Hardcoded fallback (used when JSON loading fails) ─────────────────────
// Note: "codebase-memory-mcp" external binary preset was removed (2026-07-03).
// Codebase indexing now uses the built-in ICodebaseGraphService (tree-sitter WASM).
// Codebase tools (search_graph, query_graph, etc.) are registered by builtinToolProvider._registerCodebaseTools().
const FALLBACK_PRESETS: readonly IMcpServerPreset[] = [
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
	{
		id: "comfy-mcp",
		name: "Comfy MCP",
		description: "Drive the local ComfyUI engine via MCP (official Comfy-Org/comfy-mcp). Generate images/video/audio/3D, run workflows, search installed nodes & models, fetch outputs.",
		transportType: "stdio",
		command: "comfy-mcp",
		icon: "🎨",
		builtin: true,
		envKeys: ["COMFY_BIN"],
		autoInstall: {
			checkCommands: ["comfy-mcp", "comfy"],
			install: ['pip install "comfy-cli>=1.14.0"', "pip install comfy-mcp"],
			// ★ comfy-mcp 内部封装调用 comfy-cli 的 `comfy` 二进制。MCP host 启动
			//   环境不含 shell PATH → 必须把 comfy 的绝对路径注入 COMFY_BIN。
			resolveEnv: { COMFY_BIN: "comfy" },
		},
	},
	{
		id: "figma",
		name: "Figma",
		description: "Figma 官方 Dev Mode MCP Server（远程托管，Streamable HTTP）。读取设计稿的布局、样式、变量、资源与 Code Connect 代码映射，用于设计转代码（design-to-code）。需通过 Figma OAuth 登录授权。",
		transportType: "http",
		url: "https://mcp.figma.com/mcp",
		icon: "🎨",
		builtin: true,
	},
	{
		id: "figma-developer-mcp",
		name: "Figma Developer (stdio)",
		description: "社区版 figma-developer-mcp（GLips/Figma-Context-MCP）。本地 stdio 运行，通过 FIGMA_API_KEY 读取 Figma 文件并输出简化后的布局/样式数据（get_figma_data、download_figma_images）。适合无法使用官方 OAuth 或需要本地自托管的场景。",
		transportType: "stdio",
		command: "npx",
		args: ["-y", "figma-developer-mcp", "--stdio"],
		envKeys: ["FIGMA_API_KEY"],
		builtin: true,
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
