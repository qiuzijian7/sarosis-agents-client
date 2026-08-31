/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Dispatch 层 — 参考 Hermes-Agent `tools/tool_search.py::dispatch_*` + `model_tools.py`。
 *
 * 职责：
 *   1. 接收桥接工具调用（tool_search / tool_describe / tool_call）
 *   2. tool_search: 在 catalog 中 BM25 检索，返回匹配工具列表
 *   3. tool_describe: 返回指定工具的 schema
 *   4. tool_call: 解析目标工具名+参数，scope 门控后返回 (underlyingName, args)
 *      — 实际执行由 Executor 层完成（走完整 guardrail/approval 链）
 *
 * 与 Hermes 的对齐点：
 *   - build_catalog + BM25 + substring fallback
 *   - resolve_underlying_call: 解析 tool_call 参数，返回 (name, args, error)
 *   - scoped_deferrable_names: scope 门控双重检查
 *
 * 与 Hermes 的差异：
 *   - Hermes 的 dispatch_tool_call 直接递归 handle_function_call 执行
 *   - Saros 的 dispatch 仅解析 + scope 检查，执行交给 Executor（保持 dispatch 纯函数）
 */

import { IToolDefinition } from './providers.js';
import {
	isBridgeTool, TOOL_SEARCH_BRIDGE_TOOLS,
} from './toolsetConfig.js';
import {
	IAssemblyResult, DEFAULT_TOOL_SEARCH_CONFIG, IToolSearchConfig,
	scopedDeferrableNames,
} from './toolSearchAssembler.js';

// ─── Catalog ─────────────────────────────────────────────────────────────

interface ICatalogEntry {
	name: string;
	description: string;
	schema: IToolDefinition;
	/** MCP 服务器名（如 "codebase-memory"），非 MCP 工具为空 */
	serverName: string;
	/** 预分词的搜索文本 */
	tokens: string[];
}

const TOKEN_RE = /[A-Za-z0-9]+/g;

function tokenize(text: string): string[] {
	if (!text) { return []; }
	return (text.match(TOKEN_RE) ?? []).map(t => t.toLowerCase());
}

function entrySearchText(td: IToolDefinition): string {
	const name = td.name ?? '';
	// 清理 MCP 描述中的 "[via MCP server \"X\"]" 噪声前缀
	const rawDesc = td.description ?? '';
	const desc = rawDesc.replace(/^\[via MCP server "[^"]*"\]\s*/, '');
	const params = (td.inputSchema as any)?.properties ?? {};
	const paramNames = Object.keys(params).join(' ');
	// snake_case / dotted / hyphenated 名称拆分为单词
	const nameWords = name.replace(/[_\-\.:]/g, ' ');
	// 提取 MCP 服务器名作为额外搜索关键词（如 "codebase-memory"）
	const serverName = extractMcpServerName(td.category);
	return `${nameWords} ${desc} ${paramNames} ${serverName}`;
}

/** 从 category 提取 MCP 服务器名（如 "mcp:codebase_memory" → "codebase memory"） */
function extractMcpServerName(category?: string): string {
	if (!category || !category.startsWith('mcp:')) { return ''; }
	return category.slice(4).replace(/[_\-\.]/g, ' ');
}

function buildCatalog(deferred: IToolDefinition[]): ICatalogEntry[] {
	const catalog: ICatalogEntry[] = [];
	for (const td of deferred) {
		if (!td.name) { continue; }
		catalog.push({
			name: td.name,
			description: td.description ?? '',
			schema: td,
			serverName: extractMcpServerName(td.category),
			tokens: tokenize(entrySearchText(td)),
		});
	}
	return catalog;
}

// ─── BM25 检索 ────────────────────────────────────────────────────────────

/**
 * BM25 评分 — 参考 Hermes `_bm25_score`。
 */
function bm25Score(
	queryTokens: string[],
	docTokens: string[],
	docLengths: number[],
	avgDl: number,
	docFreq: Map<string, number>,
	nDocs: number,
	k1 = 1.5,
	b = 0.75,
): number {
	if (docTokens.length === 0) { return 0; }
	let score = 0;
	const dl = docTokens.length;
	const docTf: Map<string, number> = new Map();
	for (const t of docTokens) {
		docTf.set(t, (docTf.get(t) ?? 0) + 1);
	}
	for (const q of queryTokens) {
		const df = docFreq.get(q) ?? 0;
		if (df === 0) { continue; }
		const idf = Math.log(1 + (nDocs - df + 0.5) / (df + 0.5));
		const tf = docTf.get(q) ?? 0;
		if (tf === 0) { continue; }
		const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / Math.max(avgDl, 1)));
		score += idf * norm;
	}
	return score;
}

/**
 * 搜索 catalog — 参考 Hermes `search_catalog`。
 * BM25 检索 + substring fallback。
 */
export function searchCatalog(
	catalog: ICatalogEntry[],
	query: string,
	limit: number,
): ICatalogEntry[] {
	if (catalog.length === 0 || limit <= 0) { return []; }
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) { return []; }

	const docLengths = catalog.map(e => e.tokens.length);
	const avgDl = docLengths.reduce((a, b) => a + b, 0) / Math.max(catalog.length, 1);
	const docFreq: Map<string, number> = new Map();
	for (const e of catalog) {
		const seen = new Set(e.tokens);
		for (const t of seen) {
			docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
		}
	}
	const nDocs = catalog.length;

	const scored: Array<{ score: number; entry: ICatalogEntry }> = [];
	for (const entry of catalog) {
		const s = bm25Score(queryTokens, entry.tokens, docLengths, avgDl, docFreq, nDocs);
		if (s > 0) {
			scored.push({ score: s, entry });
		}
	}

	if (scored.length === 0) {
		// Substring fallback
		const ql = query.toLowerCase();
		for (const entry of catalog) {
			if (entry.name.toLowerCase().includes(ql)) {
				scored.push({ score: 0.1, entry });
			}
		}
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map(s => s.entry);
}

// ─── Dispatch: tool_search ────────────────────────────────────────────────

export interface IDispatchResult {
	/** 返回给 LLM 的文本 */
	text: string;
	/** 是否成功 */
	success: boolean;
}

/**
 * 执行 tool_search 桥接工具。
 * 参考 Hermes `dispatch_tool_search`。
 */
export function dispatchToolSearch(
	args: Record<string, unknown>,
	catalog: ICatalogEntry[],
	config: IToolSearchConfig,
): IDispatchResult {
	const query = String(args.query ?? '').trim();
	if (!query) {
		return { text: 'Error: query is required', success: false };
	}
	const rawLimit = args.limit;
	const limit = rawLimit != null
		? Math.max(1, Math.min(config.maxSearchLimit, Number(rawLimit) || config.searchDefaultLimit))
		: config.searchDefaultLimit;

	const hits = searchCatalog(catalog, query, limit);
	if (hits.length === 0) {
		return {
			text: `No tools found matching "${query}".`,
			success: true,
		};
	}
	const lines = hits.map(h => {
		const serverTag = h.schema.category?.startsWith('mcp:')
			? ` [MCP:${h.schema.category.slice(4)}]` : '';
		// 清理 MCP 描述噪声
		const cleanDesc = (h.description || '').replace(/^\[via MCP server "[^"]*"\]\s*/, '').slice(0, 120);
		return `  - ${h.name}${serverTag}: ${cleanDesc}`;
	});

	// 中性引导（对齐 OpenClaw：search 方法仅返回结果列表，不附加领域引导）
	// 不区分 MCP/非 MCP —— 让 LLM 通过 tool_describe 自行判断工具能力
	const guidance = '\n\nUse tool_describe to load a tool\'s schema, then tool_call to execute.';
	return {
		text: `Found ${hits.length} tool(s):\n${lines.join('\n')}${guidance}`,
		success: true,
	};
}

// ─── Dispatch: tool_describe ──────────────────────────────────────────────

/**
 * 执行 tool_describe 桥接工具。
 * 参考 Hermes `dispatch_tool_describe`。
 */
export function dispatchToolDescribe(
	args: Record<string, unknown>,
	catalog: ICatalogEntry[],
	/**
	 * 已直接下发给 LLM 的工具（assembly.toolDefs）。
	 *
	 * catalog 只含 deferred（被折叠）工具；而 core / Always 优先级的工具（如
	 * renderMermaidDiagram）是**直发**的，不进 deferredDefs。若只在 catalog 中查找，
	 * 这类工具明明就在 LLM 的工具列表里，describe 却报 "not found" 并误导模型去
	 * tool_search —— 而 tool_search 同样搜不到它，形成死循环。
	 * 故这里对直发工具做兜底查找。
	 */
	visibleDefs?: readonly IToolDefinition[],
): IDispatchResult {
	const name = String(args.name ?? '').trim();
	if (!name) {
		return { text: 'Error: name is required', success: false };
	}
	const entry = catalog.find(e => e.name === name);
	if (!entry) {
		const visible = visibleDefs?.find(t => t.name === name);
		if (visible) {
			return {
				text: `Tool: ${visible.name}\nDescription: ${visible.description || ''}\n` +
					`Parameters:\n${JSON.stringify(visible.inputSchema || {}, null, 2)}`,
				success: true,
			};
		}
		return {
			text: `Error: Tool "${name}" not found. Use tool_search to find available tools.`,
			success: false,
		};
	}
	const schema = entry.schema.inputSchema || {};
	const desc = entry.schema.description || '';
	return {
		text: `Tool: ${name}\nDescription: ${desc}\nParameters:\n${JSON.stringify(schema, null, 2)}`,
		success: true,
	};
}

// ─── Dispatch: tool_call (resolve) ────────────────────────────────────────

export interface IResolveResult {
	/** 解析出的真实工具名（null 表示解析失败） */
	underlyingName: string | null;
	/** 解析出的参数 */
	underlyingArgs: Record<string, unknown>;
	/** 错误消息（解析失败时） */
	error: string | null;
}

/**
 * 解析 tool_call 的参数为 (underlyingName, args, error)。
 * 参考 Hermes `resolve_underlying_call`。
 *
 * 仅做解析和基本校验，不做 scope 检查（scope 检查由 Executor 在执行前做）。
 */
export function resolveUnderlyingCall(args: Record<string, unknown>): IResolveResult {
	// 兼容 LLM 使用 "tool" 替代 "name" 的情况（如 MCP 风格的 {server, tool, arguments}）
	const name = String(args.name ?? args.tool ?? '').trim();
	if (!name) {
		return { underlyingName: null, underlyingArgs: {}, error: "tool_call requires a 'name' (or 'tool') argument" };
	}
	if (isBridgeTool(name)) {
		return {
			underlyingName: null,
			underlyingArgs: {},
			error: `tool_call cannot invoke '${name}' (it is itself a bridge tool)`,
		};
	}
	let rawArgs = args.arguments;
	if (rawArgs == null) { rawArgs = {}; }
	if (typeof rawArgs === 'string') {
		try {
			rawArgs = JSON.parse(rawArgs);
		} catch (e) {
			return {
				underlyingName: null,
				underlyingArgs: {},
				error: `tool_call 'arguments' is not valid JSON: ${e}`,
			};
		}
	}
	if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
		return {
			underlyingName: null,
			underlyingArgs: {},
			error: "tool_call 'arguments' must be an object",
		};
	}
	return {
		underlyingName: name,
		underlyingArgs: rawArgs as Record<string, unknown>,
		error: null,
	};
}

// ─── Scope 检查 ──────────────────────────────────────────────────────────

/**
 * 检查目标工具是否在 session 的 deferrable 范围内。
 * 参考 Hermes `scoped_deferrable_names` + Executor 中的双重检查。
 */
export function isToolInScope(
	toolName: string,
	scopedDeferrable: Set<string>,
): boolean {
	return scopedDeferrable.has(toolName);
}

// ─── Dispatcher 入口 ─────────────────────────────────────────────────────

export interface IDispatcherContext {
	/** Assembly 结果（含 deferredDefs） */
	assembly: IAssemblyResult;
	/** session 的 scoped deferrable 工具名集合 */
	scopedNames: Set<string>;
	/** 配置 */
	config: IToolSearchConfig;
}

/**
 * 构建 Dispatcher 上下文。
 * 参考 Hermes `_tool_search_scoped_names` — 缓存 scoped names 以避免每次重建。
 *
 * 2026-07-03: 新增 Catalog 指纹复用（借鉴 OpenClaw `catalogEntriesFingerprint` + `ReusableCatalogSnapshot`）。
 * deferredDefs 未变化时复用预构建的 ICatalogEntry[]（含预分词 tokens），避免 BM25 文档统计重复计算。
 */
export function buildDispatcherContext(
	assembly: IAssemblyResult,
	config: IToolSearchConfig = DEFAULT_TOOL_SEARCH_CONFIG,
): IDispatcherContext {
	const scopedNames = scopedDeferrableNames(assembly.deferredDefs);
	return { assembly, scopedNames, config };
}

// ─── Catalog 指纹复用（借鉴 OpenClaw `reusableCatalogSnapshots`）─────────
//
// OpenClaw 设计：工具集未变化时，catalog entries（含预分词 tokens）可跨 session 复用。
// Saros 实现：模块级 LRU 缓存，fingerprint = 工具名列表排序哈希。
// 工具集不变 → 跳过 buildCatalog() 的 tokenize + entry 构造 → 节省 ~5ms。

/** 缓存的 Catalog 条目（含预分词 tokens） */
interface CachedCatalog {
	fingerprint: string;
	entries: ICatalogEntry[];
}

/** LRU 上限：对齐 OpenClaw `reusableCatalogSnapshots` Map */
const CATALOG_CACHE_MAX = 4;
const _catalogCache = new Map<string, CachedCatalog>();

/**
 * 计算 deferredDefs 的指纹。
 * 参考 OpenClaw `catalogEntriesFingerprint`：
 *   - 包含 id/source/sourceName/name/label/description/parameters
 *   - 排序后连接，确保顺序无关
 *   - 完整 description + inputSchema（参数变化也会失效缓存）
 */
function computeCatalogFingerprint(deferredDefs: IToolDefinition[]): string {
	const parts = deferredDefs
		.map(t => {
			// 稳定的 JSON 序列化（key 排序）
			let schemaStr: string;
			try {
				schemaStr = JSON.stringify(t.inputSchema ?? {});
			} catch {
				schemaStr = '{}';
			}
			return `${t.name ?? ''}|${t.category ?? ''}|${(t.description ?? '').replace(/\s+/g, ' ').trim()}|${schemaStr}`;
		})
		.sort();
	return parts.join('\n');
}

/**
 * 构建 Catalog（带指纹缓存）。
 * 参考 OpenClaw `applyToolCatalogCompaction` 的 fingerprint 复用逻辑。
 */
export function buildCatalogCached(deferredDefs: IToolDefinition[]): ICatalogEntry[] {
	const fingerprint = computeCatalogFingerprint(deferredDefs);
	const cached = _catalogCache.get(fingerprint);
	if (cached) {
		// 命中：移到最后（LRU 语义）
		_catalogCache.delete(fingerprint);
		_catalogCache.set(fingerprint, cached);
		return cached.entries;
	}

	// 未命中：构建新 catalog
	const entries = buildCatalog(deferredDefs);

	// LRU 驱逐
	while (_catalogCache.size >= CATALOG_CACHE_MAX) {
		const oldest = _catalogCache.keys().next().value;
		if (oldest !== undefined) { _catalogCache.delete(oldest); }
	}
	_catalogCache.set(fingerprint, { fingerprint, entries });

	return entries;
}

export interface IToolCallDispatchResult {
	/** dispatch 类型 */
	type: 'search' | 'describe' | 'call_resolved' | 'call_error';
	/** 返回给 LLM 的文本（search/describe/call_error 时） */
	text?: string;
	/** 解析出的真实工具名（call_resolved 时） */
	underlyingName?: string;
	/** 解析出的参数（call_resolved 时） */
	underlyingArgs?: Record<string, unknown>;
	/** 是否成功 */
	success: boolean;
}

/**
 * Dispatch 入口 — 参考 Hermes `model_tools.py` 中的桥接工具分发。
 *
 * 对于 tool_search / tool_describe：直接返回结果文本。
 * 对于 tool_call：解析 + scope 检查，返回 underlyingName/args 供 Executor 执行。
 */
export function dispatchBridgeTool(
	bridgeToolName: string,
	args: Record<string, unknown>,
	ctx: IDispatcherContext,
): IToolCallDispatchResult {
	// 2026-07-03: 使用 buildCatalogCached 替代 buildCatalog
	// 借鉴 OpenClaw catalog 指纹复用：deferredDefs 不变时跳过 tokenize + entry 构造
	const catalog = buildCatalogCached(ctx.assembly.deferredDefs);

	if (bridgeToolName === TOOL_SEARCH_BRIDGE_TOOLS.search) {
		const r = dispatchToolSearch(args, catalog, ctx.config);
		return { type: 'search', text: r.text, success: r.success };
	}

	if (bridgeToolName === TOOL_SEARCH_BRIDGE_TOOLS.describe) {
		const r = dispatchToolDescribe(args, catalog, ctx.assembly.toolDefs);
		return { type: 'describe', text: r.text, success: r.success };
	}

	if (bridgeToolName === TOOL_SEARCH_BRIDGE_TOOLS.call) {
		const resolved = resolveUnderlyingCall(args);
		if (resolved.error || !resolved.underlyingName) {
			return {
				type: 'call_error',
				text: resolved.error ?? 'tool_call could not be resolved',
				success: false,
			};
		}
		// Scope 门控：deferred 工具 ∪ 已直发给 LLM 的工具。
		// ctx.scopedNames 只含 deferred；core/Always 工具是直发的（如 renderMermaidDiagram），
		// 若只按 scopedNames 门控，LLM 经 tool_call 调用直发工具会被误拒。
		const inDeferredScope = isToolInScope(resolved.underlyingName, ctx.scopedNames);
		const inVisible = ctx.assembly.toolDefs.some(t => t.name === resolved.underlyingName);
		if (!inDeferredScope && !inVisible) {
			return {
				type: 'call_error',
				text: `'${resolved.underlyingName}' is not available in this session. Use tool_search to find tools you can call.`,
				success: false,
			};
		}
		return {
			type: 'call_resolved',
			underlyingName: resolved.underlyingName,
			underlyingArgs: resolved.underlyingArgs,
			success: true,
		};
	}

	return {
		type: 'call_error',
		text: `Unknown bridge tool: ${bridgeToolName}`,
		success: false,
	};
}
