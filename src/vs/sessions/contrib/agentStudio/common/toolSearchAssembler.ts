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
	isToolsetDeferrable, isBridgeTool, TOOL_SEARCH_BRIDGE_TOOLS,
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
	if (isBridgeTool(tool.name)) { return false; }
	if (tool.name === 'mcp_tool_search' || tool.name === 'mcp_tool_call') { return false; }
	const toolsetId = (tool as any).toolset ?? getToolsetForTool(tool.name);
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
		if (isBridgeTool(td.name) || td.name === 'mcp_tool_search' || td.name === 'mcp_tool_call') {
			// 桥接工具已在列表中（二次 assembly），跳过
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
 * 构建 3 个桥接工具的 schema。
 * 参考 Hermes `bridge_tool_schemas`。
 */
export function bridgeToolSchemas(
	deferred: Array<IToolDefinition & { enabled: boolean }>,
	config: IToolSearchConfig,
): Array<IToolDefinition & { enabled: boolean }> {
	const count = deferred.length;
	const descSearch = (
		`Search ${count} additional tools that are loaded on demand. ` +
		`Returns up to ${config.maxSearchLimit} matches with name and description. ` +
		`Follow with tool_describe to load a tool's full parameter schema, ` +
		`then tool_call to invoke it. ` +
		`Tools listed at the top of this system prompt are already available and do not need to be searched.`
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
						type: 'object',
						description: 'Arguments for the tool, matching its schema.',
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
	const incoming = toolDefs.filter(td =>
		!isBridgeTool(td.name) && td.name !== 'mcp_tool_search' && td.name !== 'mcp_tool_call'
	);

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
		// 未激活：passthrough，但保留 deferred 信息供日志
		return {
			toolDefs: incoming,
			activated: false,
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
