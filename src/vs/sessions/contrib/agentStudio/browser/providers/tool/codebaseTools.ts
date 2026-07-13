/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase Tools — 14 built-in codebase knowledge graph tools.
 *
 * Exposes ICodebaseGraphService (tree-sitter WASM) to the LLM,
 * replacing the external codebase-memory-mcp.exe binary.
 * Tool names match the original MCP tools for backward compatibility.
 */

import { URI } from '../../../../../../base/common/uri.js';
import { IToolResultContent } from '../../../common/providers.js';
import type { ICodebaseGraphService } from '../../codebaseGraphService.js';
import type { AdrManager } from '../../codebaseGraphAdr.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IFileService } from '../../../../../../platform/files/common/files.js';
import type { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';

export interface CodebaseToolContext {
	register(definition: { definition: any; handler: any }): void;
	codebaseGraphService: ICodebaseGraphService;
	workspaceService: IWorkspaceContextService;
	fileService: IFileService;
	logService: ILogService;
	adrManager: AdrManager;
}

export function registerCodebaseTools(ctx: CodebaseToolContext): void {
	const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];
	const json = (obj: unknown): IToolResultContent[] => [{ type: 'text', text: JSON.stringify(obj, null, 2) }];

	const ensureGraph = (): boolean => {
		if (!ctx.codebaseGraphService.hasGraphData()) {
			return false;
		}
		return true;
	};

	// ── index_repository ─────────────────────────────────────────────
	// Triggers indexing via ICodebaseMemoryMcpService (which delegates to ICodebaseGraphService).
	// We call ICodebaseGraphService directly here to avoid circular dependency
	// (ICodebaseMemoryMcpService depends on ICodebaseGraphService).
	ctx.register({
		definition: {
			name: 'index_repository',
			description: 'Build a code knowledge graph from the workspace. ' +
				'This is the prerequisite for all codebase tools (search_graph, query_graph, trace_path, get_architecture). ' +
				'The graph is persisted and reused across sessions. ' +
				'SKIPS automatically if a graph is already loaded — set force=true to override.',
			inputSchema: {
				type: 'object',
				properties: {
					repo_path: { type: 'string', description: 'Repository path to index (optional, defaults to workspace root)' },
					mode: { type: 'string', enum: ['fast', 'moderate', 'full'], description: 'Indexing depth (optional, default: fast)' },
					force: { type: 'boolean', description: 'Force re-index even if graph already loaded (default: false)' },
				},
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			const repoPath = args['repo_path'] as string | undefined;
			const mode = (args['mode'] as 'fast' | 'moderate' | 'full' | undefined) || 'fast';
			const force = (args['force'] as boolean | undefined) ?? false;
			const folders = ctx.workspaceService.getWorkspace().folders;
			if (folders.length === 0) {
				return text('index_repository error: no workspace folder open');
			}
			const wsPath = repoPath || folders[0].uri.fsPath;

			// Guard: skip re-index if graph already loaded with data (unless force=true)
			if (!force && ctx.codebaseGraphService.hasGraphData()) {
				const status = ctx.codebaseGraphService.getIndexStatus();
				const nodeCount = status?.nodeCount ?? 0;
				if (nodeCount > 0) {
					return text(`index_repository: graph already loaded (${nodeCount} nodes, ${status?.edgeCount ?? 0} edges from ${status?.fileCount ?? 0} files). ` +
						`Set force=true to re-index.`);
				}
			}

			try {
				const result = await ctx.codebaseGraphService.indexWorkspace(wsPath, {
					mode,
					excludeDirs: [],
				});
				return text(`Index ${result.success ? 'completed' : 'failed'}: ${result.message}`);
			} catch (err: any) {
				return text(`index_repository error: ${err?.message || err}`);
			}
		},
	});

	// ── index_status ─────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'index_status',
			description: 'Check whether a codebase graph is loaded and see statistics: ' +
				'node count, edge count, file count, and index freshness. ' +
				'Use to verify the graph is ready before calling search_graph or other analysis tools.',
			inputSchema: {
				type: 'object',
				properties: {
					project: { type: 'string', description: 'Project name (optional, defaults to current workspace)' },
				},
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async () => {
			if (!ensureGraph()) {
				return json({ indexed: false, hint: 'Run index_repository first' });
			}
			const status = ctx.codebaseGraphService.getIndexStatus();
			return json({ indexed: true, ...status });
		},
	});

	// ── list_projects ────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'list_projects',
			description: 'List all indexed projects in the codebase graph.',
		inputSchema: { type: 'object', properties: { _no_params: { type: 'boolean', description: 'No parameters needed' } } },
		category: 'codebase',
		source: 'saros.builtin-tools',
	},
	handler: async () => {
		const projects = ctx.codebaseGraphService.listProjects();
		return json({ projects, count: projects.length });
		},
	});

	// ── delete_project ──────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'delete_project',
			description: 'Delete an indexed project from the codebase graph.',
			inputSchema: {
				type: 'object',
				properties: {
					project: { type: 'string', description: 'Project name to delete' },
				},
				required: ['project'],
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			const project = String(args['project'] ?? '');
			if (!project) { return text('delete_project error: "project" is required'); }
			ctx.codebaseGraphService.deleteProject(project);
			return text(`Deleted project: ${project}`);
		},
	});

	// ── search_graph ─────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'search_graph',
			description: 'Search the code knowledge graph for functions, classes, routes, and variables. ' +
				'Three search modes: (1) query="update settings" for BM25 ranked full-text search with camelCase ' +
				'splitting and structural label boosting — recommended for natural-language discovery; ' +
				'(2) namePattern=".*regex.*" for exact pattern matching; (3) semantic_query=["send","publish"] ' +
				'for signal-fusion semantic search that bridges vocabulary (finds publish when you search send). ' +
				'Modes are independent and can be combined in a single call. ' +
				'PAGINATION: results are capped at limit (default 200). The response includes "total" (full match count) ' +
				'and "hasMore" (true when total > returned). Detect truncation with hasMore, then page by re-calling ' +
				'with offset=offset+limit until hasMore is false.',
			inputSchema: {
				type: 'object',
				properties: {
					project: { type: 'string', description: 'Project name (optional, defaults to current workspace)' },
					query: { type: 'string', description: 'Natural-language or keyword full-text search using BM25 ranking with camelCase splitting. Results ranked with structural boosting: Functions/Methods +10, Routes +8, Classes/Interfaces +5. Noise labels (File/Folder/Variable) are filtered out. When provided, namePattern is ignored.' },
					namePattern: { type: 'string', description: 'Name pattern (substring regex match, case-insensitive). Ignored if query is set.' },
					label: { type: 'string', description: 'Node label/type filter (e.g. function, class, file). "file" matches file paths.' },
					file_pattern: { type: 'string', description: 'Glob pattern to filter by file path (e.g. *.cpp, src/app/**). Narrow first with this before paginating large result sets.' },
					limit: { type: 'number', description: 'Max results per call (default 200). Response includes "total" and "hasMore" for pagination.' },
					offset: { type: 'number', description: 'Skip first N results. Increment by limit and re-call while hasMore is true.' },
					sortBy: { type: 'string', enum: ['name', 'inDegree', 'outDegree', 'degree'], description: 'Sort field' },
					sortDesc: { type: 'boolean', description: 'Sort descending' },
					minInDegree: { type: 'number', description: 'Minimum in-degree filter' },
					maxInDegree: { type: 'number', description: 'Maximum in-degree filter' },
					minOutDegree: { type: 'number', description: 'Minimum out-degree filter' },
					maxOutDegree: { type: 'number', description: 'Maximum out-degree filter' },
					relType: { type: 'string', description: 'Relationship type filter (uppercase, e.g. CALLS, IMPORTS, CONTAINS_FUNCTION)' },
					semantic_query: { type: 'array', items: { type: 'string' }, description: 'MUST be an ARRAY of keyword strings (e.g. ["send","pubsub","publish"]) — NOT a single string. Each keyword is scored independently via 6-signal fusion; results reflect nodes that score well on ALL keywords (min-score re-ranking). Results appear in "semantic_results" field (separate from "results"). Requires index with similarity/semantic passes enabled (moderate or full mode).' },
				},
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			if (!ensureGraph()) { return text('search_graph: no graph loaded. Run index_repository first.'); }
			// 旧 MCP 参数别名兼容：name_pattern → namePattern, file_pattern → filePattern, min_degree → minInDegree
			const searchParams = {
				project: args['project'] as string | undefined,
				query: args['query'] as string | undefined,
				namePattern: args['query'] ? undefined : ((args['namePattern'] || args['name_pattern']) as string | undefined),
				label: args['label'] as string | undefined,
				filePattern: (args['file_pattern'] || args['filePattern']) as string | undefined,
				limit: args['limit'] as number | undefined,
				offset: args['offset'] as number | undefined,
				sortBy: args['sortBy'] as any | undefined,
				sortDesc: args['sortDesc'] as boolean | undefined,
				minInDegree: (args['minInDegree'] || args['min_degree']) as number | undefined,
				maxInDegree: (args['maxInDegree'] || args['max_degree']) as number | undefined,
				minOutDegree: args['minOutDegree'] as number | undefined,
				maxOutDegree: args['maxOutDegree'] as number | undefined,
				relType: args['relType'] as string | undefined,
			};
			// relType 校验：必须全大写字母+下划线
			if (searchParams.relType && !/^[A-Z][A-Z_]*$/.test(searchParams.relType)) {
				return text(`search_graph error: relType must be uppercase letters and underscores, got "${searchParams.relType}"`);
			}

			// ── Semantic query (6-signal fusion, per-keyword min-score re-ranking) ──
			const semanticQuery = args['semantic_query'] as string[] | undefined;
			let semanticResults: any[] | undefined;
			if (semanticQuery && Array.isArray(semanticQuery) && semanticQuery.length > 0) {
				// Validate: must be array of strings
				if (semanticQuery.some(q => typeof q !== 'string')) {
					return text('search_graph error: semantic_query must be an array of keyword strings, e.g. ["send","pubsub","publish"] — not a single string.');
				}
				// Cap at 32 keywords (matching C version limit)
				const keywords = semanticQuery.slice(0, 32);
				const semanticLimit = (searchParams.limit || 200);
				try {
					semanticResults = runSemanticSearch(ctx, keywords, semanticLimit);
				} catch (err: any) {
					ctx.logService.warn(`[BuiltinTools] semantic search failed: ${err?.message || err}`);
					// Continue with regular search; semantic_results will be undefined
				}
			}

			ctx.logService.info(`[BuiltinTools] search_graph: query="${searchParams.query || '(none)'}", namePattern="${searchParams.namePattern || '(none)'}", label="${searchParams.label || '(none)'}", filePattern="${searchParams.filePattern || '(none)'}", semantic=${semanticQuery?.length || 0} keywords`);
			const result = ctx.codebaseGraphService.searchGraph(searchParams);
			if (result.total === 0 && (!semanticResults || semanticResults.length === 0)) {
				// 空结果时提供诊断提示
				const totalNodes = ctx.codebaseGraphService.getTotalNodeCount();
				let hint = `search_graph returned 0 results. Graph has ${totalNodes} nodes total.`;
				if (searchParams.label && searchParams.namePattern) {
					hint += ` Searched label="${searchParams.label}" with namePattern="${searchParams.namePattern}". Try broader search: omit label, or use a partial name.`;
				} else if (searchParams.label) {
					hint += ` Searched only label="${searchParams.label}". Try without label to search all types.`;
				} else if (searchParams.namePattern) {
					hint += ` No nodes match namePattern="${searchParams.namePattern}". Try broader or partial name match.`;
				} else if (searchParams.query) {
					hint += ` BM25 search for "${searchParams.query}" returned 0 results. Try different keywords or use list_projects to verify the graph is indexed.`;
				} else if (semanticQuery) {
					hint += ` Semantic search for ${semanticQuery.length} keyword(s) returned 0 results. Try broader single-word queries, or ensure index was built with moderate/full mode.`;
				}
				ctx.logService.warn(`[BuiltinTools] search_graph: 0 results (total=${totalNodes})`);
				return [{ type: 'text', text: JSON.stringify({ nodes: [], total: 0, hasMore: false, hint }, null, 2) }];
			}
			// Combine graph results with semantic results
			const response: any = { ...result };
			if (semanticResults && semanticResults.length > 0) {
				response.semantic_results = semanticResults;
			}
			return json(response);
		},
	});

	// ── query_graph (Cypher) ────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'query_graph',
			description: 'Query the codebase graph with pattern-matching syntax to find code relationships. ' +
				'Use MATCH to select nodes/edges, WHERE to filter, RETURN to project fields. ' +
				'Suitable for cross-file queries like "find all classes that implement interface X" or ' +
				'"list functions that call a specific module".',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Cypher query string. Example: MATCH (f:Function) WHERE f.inDegree >= 10 RETURN f.name ORDER BY f.inDegree DESC LIMIT 10' },
					project: { type: 'string', description: 'Project name (optional, defaults to current workspace)' },
					max_rows: { type: 'integer', description: 'Row limit (optional, default unlimited up to 100k ceiling)' },
				},
				required: ['query'],
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			if (!ensureGraph()) { return text('query_graph: no graph loaded. Run index_repository first.'); }
			const query = String(args['query'] ?? '');
			if (!query) { return text('query_graph error: "query" is required'); }
			const maxRows = args['max_rows'] as number | undefined;
			try {
				const result = ctx.codebaseGraphService.executeCypher(query, maxRows);
				return json(result);
			} catch (err: any) {
				return text(`query_graph error: ${err?.message || err}`);
			}
		},
	});

	// ── get_architecture ────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'get_architecture',
			description: 'Get high-level architecture overview — languages, packages, services, dependencies, ' +
				'and project structure at a glance. Includes "communities": Leiden community detection over ' +
				'the call/import graph, surfacing the de-facto modules (each with size, cohesion, and top nodes). ' +
				'Use aspects parameter to request only the dimensions you need (token efficient). ' +
				'To get deep structural info like fan-in/fan-out, coupling, and layer assignments, ' +
				'use "all" (or omit aspects) which includes communities + deadCode analysis.',
			inputSchema: {
				type: 'object',
				properties: {
					aspects: {
						type: 'array',
						items: { type: 'string', enum: ['all', 'overview', 'languages', 'packages', 'entryPoints',
							'routes', 'hotspots', 'crossBoundaries', 'layers', 'communities'] },
						description: 'Aspects to include. "all" = everything; "overview" = languages+packages+entryPoints+hotspots; omit = all.',
					},
					path: { type: 'string', description: 'Optional directory prefix to scope architecture (e.g. src/app)' },
				},
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			if (!ensureGraph()) { return text('get_architecture: no graph loaded. Run index_repository first.'); }
			const aspects = args['aspects'] as string[] | undefined;
			const scopePath = args['path'] as string | undefined;
			try {
				// 获取完整分析报告（async — allows abort signal to fire between packages, P2-6）
				const fullReport = aspects && aspects.length > 0 && aspects[0] !== 'all'
					? await ctx.codebaseGraphService.getArchitectureAdvanced(aspects)
					: await ctx.codebaseGraphService.getArchitecture();

				// Apply path scope filtering — limit results to nodes under the given directory prefix
				if (scopePath) {
					const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '');
					const isInScope = (filePath: string) =>
						normalize(filePath).startsWith(normalize(scopePath));

					if (fullReport.entryPoints) {
						fullReport.entryPoints = fullReport.entryPoints.filter((e: any) =>
							isInScope(e.filePath || e.path || ''));
					}
					if (fullReport.hotspots) {
						fullReport.hotspots = fullReport.hotspots.filter((h: any) =>
							isInScope(h.filePath || h.path || ''));
					}
					if (fullReport.packages) {
						fullReport.packages = fullReport.packages.filter((p: any) => {
							const pname = p.name || p.package || '';
							return normalize(pname).startsWith(normalize(scopePath)) || normalize(scopePath).startsWith(normalize(pname));
						});
					}
					if (fullReport.communities) {
						fullReport.communities = fullReport.communities.filter((c: any) => {
							if (c.topNodes) {
								return c.topNodes.some((n: any) => isInScope(n.filePath || n.path || ''));
							}
							if (c.packages) {
								return c.packages.some((p: string) =>
									normalize(p).startsWith(normalize(scopePath)));
							}
							return true; // keep community if can't determine
						});
					}
					fullReport._scopePath = scopePath;
					fullReport._scoped = true;
				}

				// aspect 过滤 (如果请求了特定方面)
				if (aspects && aspects.length > 0 && aspects[0] !== 'all') {
					const aspectSet = new Set(aspects);
					if (aspectSet.has('overview')) {
						['languages', 'packages', 'entryPoints', 'hotspots'].forEach(a => aspectSet.add(a));
					}
					const filtered: Record<string, any> = { totalNodes: fullReport.totalNodes, totalEdges: fullReport.totalEdges };
					if (scopePath) {
						filtered._scopePath = scopePath;
						filtered._scoped = true;
					}
					for (const [key, value] of Object.entries(fullReport)) {
						if (aspectSet.has(key)) { filtered[key] = value; }
					}
					return json(filtered);
				}

				return json(fullReport);
			} catch (err: any) {
				return text(`get_architecture error: ${err?.message || err}`);
			}
		},
	});

	// ── get_code_snippet ────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'get_code_snippet',
			description: 'Retrieve the full source code of a function, class, or method by its qualified name ' +
				'(e.g., "ClassName::methodName"). Includes configurable surrounding context lines ' +
				'and neighbor function source for reading code in its structural context.',
			inputSchema: {
				type: 'object',
				properties: {
					qualifiedName: { type: 'string', description: 'Qualified name of the function/class' },
					contextLines: { type: 'number', description: 'Lines of context before/after (default 3)' },
					includeNeighbors: { type: 'boolean', description: 'Include neighboring function source' },
				},
				required: ['qualifiedName'],
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			if (!ensureGraph()) { return text('get_code_snippet: no graph loaded. Run index_repository first.'); }
			const qualifiedName = String(args['qualifiedName'] ?? '');
			if (!qualifiedName) { return text('get_code_snippet error: "qualifiedName" is required'); }
			const contextLines = (args['contextLines'] as number | undefined) ?? 3;
			const includeNeighbors = (args['includeNeighbors'] as boolean | undefined) ?? false;
			const result = await ctx.codebaseGraphService.getCodeSnippet(qualifiedName, contextLines, includeNeighbors);
			if (!result) { return text(`Code snippet not found for: ${qualifiedName}`); }
			return json(result);
		},
	});

	// ── get_graph_schema ────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'get_graph_schema',
			description: 'Get the schema of the codebase graph: node labels, edge types, and counts.',
		inputSchema: { type: 'object', properties: { _no_params: { type: 'boolean', description: 'No parameters needed' } } },
		category: 'codebase',
		source: 'saros.builtin-tools',
	},
	handler: async () => {
		if (!ensureGraph()) { return text('get_graph_schema: no graph loaded. Run index_repository first.'); }
		return json(ctx.codebaseGraphService.getGraphSchema());
	},
	});

	// ── trace_path ──────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'trace_path',
			description: 'Trace call paths through the code graph. Modes: calls (default, follow CALLS edges), ' +
				'data_flow (CALLS+DATA_FLOWS with arg expressions), cross_service (through HTTP/async Route nodes). ' +
				'Use direction to control callers vs callees. Use INSTEAD OF grep for impact analysis or data flow tracing.',
			inputSchema: {
				type: 'object',
				properties: {
					sourceName: { type: 'string', description: 'Source function name to trace from' },
					targetName: { type: 'string', description: 'Optional target function to find path to' },
					mode: { type: 'string', enum: ['calls', 'data_flow', 'cross_service'], default: 'calls', description: 'Trace mode. calls: follow CALLS edges. data_flow: CALLS+DATA_FLOWS. cross_service: through HTTP/async Routes.' },
					maxDepth: { type: 'number', description: 'Max trace depth (default 10)' },
					direction: { type: 'string', enum: ['both', 'callers', 'callees'], default: 'both', description: 'Trace direction' },
				},
				required: ['sourceName'],
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			if (!ensureGraph()) { return text('trace_path: no graph loaded. Run index_repository first.'); }
			const sourceName = String(args['sourceName'] ?? '');
			const targetName = args['targetName'] as string | undefined;
			const mode = (args['mode'] as string | undefined) || 'calls';
			const maxDepth = args['maxDepth'] as number | undefined;
			const direction = args['direction'] as 'both' | 'callers' | 'callees' | undefined;
			const result = (maxDepth || direction)
				? ctx.codebaseGraphService.tracePathAdvanced(sourceName, targetName, { mode: mode as any, maxDepth, direction })
				: ctx.codebaseGraphService.tracePath(sourceName, targetName, mode);
			return json(result);
		},
	});

	// ── search_code ─────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'search_code',
			description: 'Graph-augmented code search. Finds text patterns, then enriches results with ' +
				'the knowledge graph: deduplicates matches into containing functions/classes. ' +
				'Modes: compact (default, signatures only — token efficient), full (with source), files (just paths). ' +
				'Multi-word queries are auto-converted to regex (\"foo bar\" → foo.*bar).',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Search pattern. Multi-word queries auto-convert to regex (foo bar → foo.*bar).' },
					mode: { type: 'string', enum: ['compact', 'full', 'files'], default: 'compact', description: 'compact: signatures+metadata (default). full: with source code. files: just file paths.' },
					filePattern: { type: 'string', description: 'Glob filter for file types (e.g. *.go, *.cpp)' },
					path_filter: { type: 'string', description: 'Regex filter on result file paths (e.g. ^src/ or \\.go$). Applied AFTER grep, limiting enriched results.' },
					context: { type: 'number', description: 'Lines of context around each match (like grep -C). Only in compact mode.' },
					limit: { type: 'number', description: 'Max results (default 30)' },
				},
				required: ['query'],
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			if (!ensureGraph()) { return text('search_code: no graph loaded. Run index_repository first.'); }
			const rawQuery = String(args['query'] ?? '');
			if (!rawQuery) { return text('search_code error: "query" is required'); }
			const mode = (args['mode'] as string | undefined) || 'compact';
			const filePattern = args['filePattern'] as string | undefined;
			const pathFilter = args['path_filter'] as string | undefined;
			const contextLines = (args['context'] as number | undefined) ?? 0;
			const limit = (args['limit'] as number | undefined) ?? 30;

			// 多词查询自动转 regex: "foo bar" → foo.*bar
			let searchQuery = rawQuery;
			if (rawQuery.includes(' ')) {
				const tokens = rawQuery.split(/\s+/).filter(Boolean);
				searchQuery = tokens.join('.*');
			}

			const raw = await ctx.codebaseGraphService.searchCode(searchQuery, limit * 5, filePattern); // oversample; filePattern 传递到底层
			if (!raw || raw.length === 0) {
				return text('search_code: no matches found.');
			}

			// 图谱富化：按文件分组查找图节点（O(#files) 而非 O(#results)）
			const fileSet = new Set(raw.map((r: any) => r.filePath || r.file || ''));
			const allNodes = ctx.codebaseGraphService.searchGraph({
				label: undefined,
				limit: 20000, // 获取所有节点
			}).nodes;
			const nodeMap = new Map<string, any[]>(); // filePath → nodes[]
			for (const n of allNodes) {
				if (!n.filePath || !fileSet.has(n.filePath)) { continue; }
				if (!nodeMap.has(n.filePath)) { nodeMap.set(n.filePath, []); }
				nodeMap.get(n.filePath)!.push(n);
			}

			const enriched = raw.map((r: any) => {
				const filePath = r.filePath || r.file || '';
				const lineNo = r.lineNo || r.line || 0;
				const fileNodes = nodeMap.get(filePath) || [];
				// 查找包含此位置的图节点
				const containingNode = fileNodes.find(n =>
					n.startLine && n.startLine <= lineNo && n.endLine && n.endLine >= lineNo
				);

				const isIndexed = fileNodes.length > 0;
				const entry: any = {
					filePath,
					lineNo,
					text: r.text || r.snippet || '',
					isIndexed,
				};
				if (containingNode) {
					entry.symbol = containingNode.name;
					entry.type = containingNode.type;
					entry.qualifiedName = containingNode.qualifiedName;
				}
				return entry;
			})
			// path_filter: 按文件路径正则过滤
			.filter((e: any) => {
				if (!pathFilter) { return true; }
				try {
					return new RegExp(pathFilter).test(e.filePath);
				} catch { return true; /* invalid regex → pass all */ }
			})
			.slice(0, limit);

			// Mode-based formatting
			if (mode === 'files') {
				const files = [...new Set(enriched.map((e: any) => e.filePath))];
				return json({ files, total_files: files.length });
			}
			if (mode === 'full') {
				// 读取源文件获取实际代码片段
				const fullResults = [];
				for (const e of enriched) {
					try {
						const wsFolders = ctx.workspaceService.getWorkspace().folders;
						let fileUri: URI | undefined;
						for (const folder of wsFolders) {
							const candidate = URI.joinPath(folder.uri, e.filePath);
							if (await ctx.fileService.exists(candidate)) { fileUri = candidate; break; }
						}
						if (fileUri && e.lineNo > 0) {
							const fileContent = (await ctx.fileService.readFile(fileUri)).value.toString();
							const lines = fileContent.split('\n');
							const ctxStart = Math.max(0, e.lineNo - 4);
							const ctxEnd = Math.min(lines.length, e.lineNo + 3);
							e.source = lines.slice(ctxStart, ctxEnd).map((l: string, i: number) => `${ctxStart + i + 1}: ${l}`).join('\n');
						}
					} catch { /* best effort */ }
					fullResults.push(e);
				}
				return json({ results: fullResults, total: fullResults.length, mode: 'full' });
			}
			// compact mode — signatures only, token efficient
			// 如果请求了 context 行, 按需读取文件
			if (contextLines > 0 && enriched.length > 0) {
				for (const e of enriched) {
					try {
						const wsFolders = ctx.workspaceService.getWorkspace().folders;
						let fileUri: URI | undefined;
						for (const folder of wsFolders) {
							const candidate = URI.joinPath(folder.uri, e.filePath);
							if (await ctx.fileService.exists(candidate)) { fileUri = candidate; break; }
						}
						if (fileUri && e.lineNo > 0) {
							const fileContent = (await ctx.fileService.readFile(fileUri)).value.toString();
							const lines = fileContent.split('\n');
							const ctxStart = Math.max(0, e.lineNo - contextLines - 1);
							const ctxEnd = Math.min(lines.length, e.lineNo + contextLines);
							e.context = lines.slice(ctxStart, ctxEnd).map((l: string, i: number) =>
								`${ctxStart + i + 1}: ${l}`).join('\n');
						}
					} catch { /* best effort */ }
				}
			}
			return json({ results: enriched, total: enriched.length, mode: 'compact' });
		},
	});

	// ── detect_changes ──────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'detect_changes',
			description: 'Detect code changes since a git reference (branch/commit) and optionally ' +
				'perform impact analysis on the codebase graph.',
			inputSchema: {
				type: 'object',
				properties: {
					since: { type: 'string', description: 'Git reference (commit/branch/tag)' },
					baseBranch: { type: 'string', description: 'Base branch for comparison (optional)' },
					impactAnalysis: { type: 'boolean', description: 'Run impact analysis (optional)' },
				},
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			if (!ensureGraph()) { return text('detect_changes: no graph loaded. Run index_repository first.'); }
			try {
				const result = await ctx.codebaseGraphService.detectChanges({
					since: args['since'] as string | undefined,
					baseBranch: args['baseBranch'] as string | undefined,
					impactAnalysis: args['impactAnalysis'] as boolean | undefined,
				});
				return json(result);
			} catch (err: any) {
				return text(`detect_changes error: ${err?.message || err}`);
			}
		},
	});

	// ── ingest_traces ───────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'ingest_traces',
			description: 'Ingest OpenTelemetry traces (OTLP JSON) into the codebase graph to enrich ' +
				'runtime call edges.',
			inputSchema: {
				type: 'object',
				properties: {
					otlp_json: { type: 'string', description: 'OTLP JSON trace data' },
				},
				required: ['otlp_json'],
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			const otlpJson = String(args['otlp_json'] ?? '');
			if (!otlpJson) { return text('ingest_traces error: "otlp_json" is required'); }
			try {
				const result = ctx.codebaseGraphService.ingestTraces(otlpJson);
				return json(result);
			} catch (err: any) {
				return text(`ingest_traces error: ${err?.message || err}`);
			}
		},
	});

	// ── manage_adr ──────────────────────────────────────────────────
	// ADR (Architecture Decision Records) management — stored alongside the graph.
	ctx.register({
		definition: {
			name: 'manage_adr',
			description: 'Manage Architecture Decision Records (ADR) for the codebase. ' +
				'Actions: list, get, create, update, delete.',
			inputSchema: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'], description: 'ADR action' },
					id: { type: 'string', description: 'ADR id (for get/update/delete)' },
					title: { type: 'string', description: 'ADR title (for create)' },
					content: { type: 'string', description: 'ADR content (for create/update)' },
				},
				required: ['action'],
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			const action = String(args['action'] ?? '');
			const id = args['id'] as string | undefined;
			const title = args['title'] as string | undefined;
			const content = args['content'] as string | undefined;

			const folders = ctx.workspaceService.getWorkspace().folders;
			if (folders.length === 0) {
				return text('manage_adr: no workspace folder open.');
			}
			const rootUri = folders[0].uri;

			try {
				switch (action) {
					case 'list': {
						const adrs = await ctx.adrManager.list(rootUri);
						return json(adrs.map((a: any) => ({
							id: a.id, title: a.title, status: a.status, date: a.date,
							tags: a.tags, deciders: a.deciders, filePath: a.filePath,
						})));
					}
					case 'get': {
						if (!id) { return text('manage_adr "get" requires "id" parameter.'); }
						const adr = await ctx.adrManager.get(rootUri, id);
						if (!adr) { return text(`manage_adr: ADR "${id}" not found.`); }
						return json({
							id: adr.id, title: adr.title, status: adr.status, date: adr.date,
							sections: adr.sections, tags: adr.tags, deciders: adr.deciders,
							filePath: adr.filePath,
						});
					}
					case 'create': {
						if (!title) { return text('manage_adr "create" requires "title" parameter.'); }
						const createdId = await ctx.adrManager.create(rootUri, {
							id, title,
							sections: content ? { decision: content } : undefined,
						});
						return json({ action: 'create', id: createdId, title });
					}
					case 'update': {
						if (!id) { return text('manage_adr "update" requires "id" parameter.'); }
						const sections: { [key: string]: string } = {};
						if (content) { sections['decision'] = content; }
						const success = await ctx.adrManager.update(rootUri, id, sections);
						return json({ action: 'update', id, success });
					}
					case 'delete': {
						if (!id) { return text('manage_adr "delete" requires "id" parameter.'); }
						const success = await ctx.adrManager.delete(rootUri, id);
						return json({ action: 'delete', id, success });
					}
					default:
						return text(`manage_adr: unknown action "${action}". Use list/get/create/update/delete.`);
				}
		} catch (err: any) {
			return text(`manage_adr error: ${err?.message || err}`);
		}
	},
	});

	ctx.logService.info('[BuiltinTools] _registerCodebaseTools: 14 codebase tools registered (index_repository, index_status, list_projects, delete_project, search_graph, query_graph, get_architecture, get_code_snippet, get_graph_schema, trace_path, search_code, detect_changes, ingest_traces, manage_adr)');
}

export function runSemanticSearch(ctx: CodebaseToolContext, keywords: string[], limit: number): any[] {
	// Per-keyword: run semantic search and normalize scores
	const keywordResults: { nodeId: string; nodeData: any; normalizedScore: number }[][] = [];

	for (const kw of keywords) {
		const results = ctx.codebaseGraphService.semanticSearch(kw, Math.max(limit, 50));
		if (results.length === 0) {
			keywordResults.push([]);
			continue;
		}
		const maxScore = Math.max(...results.map(r => r.score));

		const perKwResults = results.map(r => ({
			nodeId: String(r.node.id),
			nodeData: {
				id: String(r.node.id),
				name: r.node.name,
				type: r.node.label,
				qualifiedName: r.node.qualifiedName,
				filePath: r.node.filePath,
				inDegree: r.node.inDegree,
				outDegree: r.node.outDegree,
			},
			normalizedScore: maxScore > 0 ? r.score / maxScore : 0,
		}));

		keywordResults.push(perKwResults);
	}

	// Collect all node IDs that appear in ANY keyword result
	const nodeScores = new Map<string, { bestScore: number; perKeywordScores: (number | undefined)[]; nodeData: any }>();

	for (let ki = 0; ki < keywordResults.length; ki++) {
		for (const kr of keywordResults[ki]) {
			let entry = nodeScores.get(kr.nodeId);
			if (!entry) {
				entry = {
					bestScore: 0,
					perKeywordScores: new Array(keywords.length).fill(undefined),
					nodeData: kr.nodeData,
				};
				nodeScores.set(kr.nodeId, entry);
			}
			entry.perKeywordScores[ki] = kr.normalizedScore;
			// Min-score: use the smallest non-undefined score
			const validScores = entry.perKeywordScores.filter(s => s !== undefined) as number[];
			entry.bestScore = validScores.length > 0 ? Math.min(...validScores) : 0;
		}
	}

	// Filter to nodes matching ALL keywords, sort by min-score descending
	const fused = Array.from(nodeScores.entries())
		.filter(([_, entry]) => entry.perKeywordScores.every(s => s !== undefined))
		.map(([nodeId, entry]) => ({
			...entry.nodeData,
			score: entry.bestScore,
			perKeywordScores: entry.perKeywordScores,
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);

	return fused;
}
