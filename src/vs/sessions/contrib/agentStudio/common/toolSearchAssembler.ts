/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Assembly 层 — 参考 Hermes-Agent `tools/tool_search.py::assemble_tool_defs`。
 *
 * 职责：
 *   1. 将工具列表分类为 visible（直接发给 LLM）和 deferrable（可折叠）
 *   2. 估算 deferrable 工具的 token 开销，按 threshold gate 决定是否激活
 *   3. 激活时用 3 个桥接 schema 替换 deferrable 工具
 *
 * 与 Hermes 的对齐点：
 *   - classify_tools: 核心工具不可折叠（isToolsetDeferrable=false）
 *   - estimate_tokens_from_schemas: chars/4 估算
 *   - should_activate: context_length × threshold_pct（默认 10%）
 *   - bridge_tool_schemas: tool_search / tool_describe / tool_call 三个独立桥接
 *
 * 与 Hermes 的差异：
 *   - Hermes 用 _HERMES_CORE_TOOLS 硬编码白名单；Sarosis 用 toolsetConfig 的 deferrable 标志
 *   - Hermes 的 threshold gate 每次都重新估算；Sarosis 同样无状态
 */

import { IToolDefinition } from './providers.js';
import {
	ToolsetPriority, getToolsetForTool, getToolsetPriority,
	isToolsetDeferrable, isBridgeTool, isCoreTool, isCoreToolset,
	TOOL_SEARCH_BRIDGE_TOOLS,
} from './toolsetConfig.js';

// ─── Token 估算 ──────────────────────────────────────────────────────────

/** 无 tokenizer 时的 chars/token 比率（与 Hermes 一致） */
const CHARS_PER_TOKEN = 4.0;

/**
 * 估算工具定义列表的 token 开销。
 * 使用 chars/4 规则，跨 provider 稳定。
 */
export function estimateTokensFromSchemas(toolDefs: IToolDefinition[]): number {
	let totalChars = 0;
	for (const td of toolDefs) {
		try {
			totalChars += JSON.stringify({
				name: td.name,
				description: td.description,
				inputSchema: td.inputSchema,
			}).length;
		} catch {
			totalChars += (td.name + (td.description ?? '')).length;
		}
	}
	return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

// ─── 配置 ──────────────────────────────────────────────────────────────────

export interface IToolSearchConfig {
	/** "auto" | "on" | "off" */
	enabled: 'auto' | 'on' | 'off';
	/** deferrable 工具占 context 的百分比阈值（仅 auto 模式生效） */
	thresholdPct: number;
	/** tool_search 默认返回数量 */
	searchDefaultLimit: number;
	/** tool_search 最大返回数量 */
	maxSearchLimit: number;
}

export const DEFAULT_TOOL_SEARCH_CONFIG: IToolSearchConfig = {
	enabled: 'auto',
	thresholdPct: 10.0,
	searchDefaultLimit: 5,
	maxSearchLimit: 20,
};

// ─── 分类 ──────────────────────────────────────────────────────────────────

/**
 * 判断工具是否可折叠。
 * 参考 Hermes `is_deferrable_tool_name`：
 *   - 桥接工具自身不可折叠
 *   - toolset 标记为 deferrable=false 的不可折叠
 */
export function isDeferrableTool(tool: IToolDefinition): boolean {
	// 2026-07-03: 统一单套桥接 — 不再有 mcp_tool_search/mcp_tool_call
	// 桥接工具自身不可折叠
	if (isBridgeTool(tool.name)) { return false; }
	// 双重保护第一层：核心工具白名单 — 永远直接发送给 LLM
	// 对齐 Hermes `is_deferrable_tool_name` 中的 `_core_tool_names()` 检查
	if (isCoreTool(tool.name)) { return false; }
	const toolsetId = (tool as any).toolset ?? getToolsetForTool(tool.name);
	// 双重保护第二层：核心 toolset — 整体保护，对齐 Hermes `_HERMES_CORE_TOOLS`
	if (isCoreToolset(toolsetId)) { return false; }
	if (!isToolsetDeferrable(toolsetId)) { return false; }
	// Always 优先级的工具不可折叠（即使 toolset 标记了 deferrable）
	if (getToolsetPriority(toolsetId) === ToolsetPriority.Always) { return false; }
	return true;
}

/**
 * 将工具列表分为 (visible, deferrable)。
 * 参考 Hermes `classify_tools`。
 */
export function classifyTools(
	toolDefs: Array<IToolDefinition & { enabled: boolean }>,
): {
	visible: Array<IToolDefinition & { enabled: boolean }>;
	deferrable: Array<IToolDefinition & { enabled: boolean }>;
} {
	const visible: Array<IToolDefinition & { enabled: boolean }> = [];
	const deferrable: Array<IToolDefinition & { enabled: boolean }> = [];
	for (const td of toolDefs) {
		// 2026-07-03: 统一单套桥接 — 桥接工具已在列表中（二次 assembly）时跳过
		if (isBridgeTool(td.name)) {
			continue;
		}
		if (isDeferrableTool(td)) {
			deferrable.push(td);
		} else {
			visible.push(td);
		}
	}
	return { visible, deferrable };
}

// ─── Threshold gate ──────────────────────────────────────────────────────

/**
 * 决定是否激活 Tool Search。
 * 参考 Hermes `should_activate`。
 */
export function shouldActivate(
	config: IToolSearchConfig,
	deferrableTokens: number,
	contextLength: number | undefined,
): boolean {
	if (config.enabled === 'off') { return false; }
	if (deferrableTokens <= 0) { return false; }
	if (config.enabled === 'on') { return true; }
	// auto
	if (!contextLength || contextLength <= 0) {
		// 无 context 大小，fallback 到固定 20K token 阈值
		return deferrableTokens >= 20_000;
	}
	const thresholdTokens = Math.floor(contextLength * (config.thresholdPct / 100.0));
	return deferrableTokens >= thresholdTokens;
}

// ─── 桥接工具 schema ──────────────────────────────────────────────────────

/**
 * 从 deferred 工具列表生成数据驱动的摘要。
 * 参考 OpenClaw `formatToolSearchCatalogDirectory`：
 *   - 按工具名排序（确定性）
 *   - 列出前 N 个工具的 name + 简短描述
 *   - 不预设任何领域关键词，完全从工具自身字段提取
 *
 * 设计原则：搜索算法应该是数据驱动的，不依赖硬编码的领域分类。
 * OpenClaw 的 `scoreEntry` 仅从 entry 的 name/id/label/description 评分，
 * 不预设 "codebase"/"memory" 等关键词——Sarosis 对齐此设计。
 */
function summarizeDeferredTools(
	deferred: Array<IToolDefinition & { enabled: boolean }>,
	maxShow = 6,
): string {
	// 按工具名排序（确定性输出）
	const sorted = [...deferred]
		.filter(t => t.name)
		.sort((a, b) => (a.name! < b.name! ? -1 : a.name! > b.name! ? 1 : 0));

	const shown = sorted.slice(0, maxShow);
	const omitted = sorted.length - shown.length;

	const lines = shown.map(t => {
		// 清理 MCP 描述噪声前缀
		const rawDesc = t.description ?? '';
		const desc = rawDesc.replace(/^\[via MCP server "[^"]*"\]\s*/, '').trim();
		const shortDesc = desc.length > 80 ? desc.slice(0, 77).trimEnd() + '...' : desc;
		return shortDesc ? `${t.name} (${shortDesc})` : t.name;
	});

	if (omitted > 0) {
		lines.push(`... and ${omitted} more`);
	}
	return lines.join('; ');
}

/**
 * 构建 3 个桥接工具的 schema。
 * 参考 OpenClaw `createToolSearchTools`：描述中性，不引导到特定领域。
 *
 * 设计原则（对齐 OpenClaw）：
 *   - 桥接工具描述应中性，不预设 "code analysis" 等领域引导
 *   - OpenClaw 的 tool_search 描述仅为 "Search the effective Tool Search catalog."
 *   - 工具分类摘要从 deferred 工具自身字段提取（数据驱动）
 */
export function bridgeToolSchemas(
	deferred: Array<IToolDefinition & { enabled: boolean }>,
	config: IToolSearchConfig,
): Array<IToolDefinition & { enabled: boolean }> {
	const count = deferred.length;

	// 从 deferred 工具中提取分类摘要（数据驱动，无硬编码领域词）
	const categoryHints = summarizeDeferredTools(deferred);

	const descSearch = (
		`Search ${count} additional tools not listed above. ` +
		`Available tools include: ${categoryHints}. ` +
		`Returns up to ${config.maxSearchLimit} matches with name and description. ` +
		`Follow with tool_describe to load a tool's full parameter schema, ` +
		`then tool_call to invoke it.`
	);
	const descDescribe = (
		`Load the full JSON schema for one tool returned by tool_search. ` +
		`Required before tool_call if the tool's parameters are unknown.`
	);
	const descCall = (
		`Invoke a deferred tool by name with the given arguments. ` +
		`Argument shape matches the tool's schema (see tool_describe). ` +
		`Policy, hooks, and approvals run exactly as for any directly-listed tool.`
	);

	return [
		{
			name: TOOL_SEARCH_BRIDGE_TOOLS.search,
			description: descSearch,
			inputSchema: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Keywords describing the capability you need (e.g. "create github issue").',
					},
					limit: {
						type: 'integer',
						description: `Maximum number of results to return. Default ${config.searchDefaultLimit}.`,
					},
				},
				required: ['query'],
			},
			category: 'utility',
			toolset: 'tool-search',
			enabled: true,
		} as IToolDefinition & { enabled: boolean },
		{
			name: TOOL_SEARCH_BRIDGE_TOOLS.describe,
			description: descDescribe,
			inputSchema: {
				type: 'object',
				properties: {
					name: {
						type: 'string',
						description: 'Exact tool name (as returned by tool_search).',
					},
				},
				required: ['name'],
			},
			category: 'utility',
			toolset: 'tool-search',
			enabled: true,
		} as IToolDefinition & { enabled: boolean },
		{
			name: TOOL_SEARCH_BRIDGE_TOOLS.call,
			description: descCall,
			inputSchema: {
				type: 'object',
				properties: {
					name: {
						type: 'string',
						description: 'Exact tool name to invoke.',
					},
				arguments: {
					type: 'string',
					description: 'Arguments for the tool as a JSON string (e.g. \'{"path":"."}\'), matching its schema.',
				},
				},
				required: ['name', 'arguments'],
			},
			category: 'utility',
			toolset: 'tool-search',
			enabled: true,
		} as IToolDefinition & { enabled: boolean },
	];
}

// ─── Assembly 结果 ─────────────────────────────────────────────────────────

export interface IAssemblyResult {
	/** 最终发给 LLM 的工具列表 */
	toolDefs: Array<IToolDefinition & { enabled: boolean }>;
	/** 是否激活了 Tool Search */
	activated: boolean;
	/** 折叠的工具数量 */
	deferredCount: number;
	/** 折叠工具的 token 估算 */
	deferredTokens: number;
	/** threshold token 值（仅 auto 模式有意义） */
	thresholdTokens: number;
	/** 折叠的工具定义（供 Dispatcher 构建 catalog 用） */
	deferredDefs: Array<IToolDefinition & { enabled: boolean }>;
}

/**
 * Assembly 入口 — 参考 Hermes `assemble_tool_defs`。
 *
 * 当 Tool Search 未激活（off / 无 deferrable / 低于阈值）时 passthrough。
 * 激活时用 3 个桥接 schema 替换 deferrable 工具。
 *
 * 幂等：输入中已包含桥接工具时会被过滤掉再分类。
 */
export function assembleToolDefs(
	toolDefs: Array<IToolDefinition & { enabled: boolean }>,
	options?: {
		contextLength?: number;
		config?: IToolSearchConfig;
	},
): IAssemblyResult {
	const config = options?.config ?? DEFAULT_TOOL_SEARCH_CONFIG;
	const contextLength = options?.contextLength;

	// 防御：过滤掉已存在的桥接工具（二次 assembly）
	// 2026-07-03: 统一为单套桥接（对齐 Hermes-Agent）
	// MCP 工具不再有专属的 mcp_tool_search/mcp_tool_call，而是通过 'mcp' toolset
	// 纳入 deferrable 池，LLM 通过统一的 tool_search/tool_describe/tool_call 路径发现。
	const incoming = toolDefs.filter(td => !isBridgeTool(td.name));

	const { visible, deferrable } = classifyTools(incoming);

	if (deferrable.length === 0) {
		return {
			toolDefs: incoming,
			activated: false,
			deferredCount: 0,
			deferredTokens: 0,
			thresholdTokens: 0,
			deferredDefs: [],
		};
	}

	const deferrableTokens = estimateTokensFromSchemas(deferrable);
	const shouldActivateResult = shouldActivate(config, deferrableTokens, contextLength);
	const thresholdTokens = Math.floor((contextLength ?? 0) * (config.thresholdPct / 100.0));

	if (!shouldActivateResult) {
		// 未激活：passthrough + 桥接工具
		// 2026-07-03: passthrough 模式也必须包含桥接工具。
		// incoming 包含所有工具（visible + deferrable 含 MCP），
		// _getEnabledTools Step 5b 会根据 mcpToolNameSet 移除 MCP 直发工具。
		// 桥接工具则保留给 LLM 通过 tool_search 发现 MCP/非核心工具。
		// 设计：桥接工具始终发送（token 开销仅 ~300 chars），
		// 确保 LLM 总有通路访问 codebase 等 MCP 工具。
		const bridge = bridgeToolSchemas(deferrable, config);
		return {
			toolDefs: [...incoming, ...bridge],
			activated: false,  // false → Step 5b 移除 MCP 直发工具，bridge 工具保留
			deferredCount: deferrable.length,
			deferredTokens: deferrableTokens,
			thresholdTokens,
			deferredDefs: deferrable,
		};
	}

	// 激活：用桥接 schema 替换 deferrable
	const bridge = bridgeToolSchemas(deferrable, config);
	const result = [...visible, ...bridge];

	return {
		toolDefs: result,
		activated: true,
		deferredCount: deferrable.length,
		deferredTokens: deferrableTokens,
		thresholdTokens,
		deferredDefs: deferrable,
	};
}

// ─── Scoped deferrable names ──────────────────────────────────────────────

/**
 * 返回 deferrable 工具名集合。
 * 参考 Hermes `scoped_deferrable_names`。
 *
 * 用于 Dispatcher 的 scope 门控：tool_call 只能调用此集合内的工具。
 */
export function scopedDeferrableNames(
	toolDefs: Array<IToolDefinition & { enabled: boolean }>,
): Set<string> {
	const names = new Set<string>();
	for (const td of toolDefs) {
		if (td.name && isDeferrableTool(td)) {
			names.add(td.name);
		}
	}
	return names;
}
