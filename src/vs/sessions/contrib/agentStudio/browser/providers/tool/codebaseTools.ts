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
import { type SearchHelpers, redactSecrets } from './searchHelpers.js';
import { prepareQueryForRipgrep, escapeLiteralForRegex } from './regexValidator.js';
import { normalizeFileGlobForSearch, normalizeSearchPathFilter, searchRootCandidates, searchOutcomeHint } from './pathFilterNormalize.js';
import type { IAgentStudioService } from '../../../common/agentStudio.js';
import type { IWorkspaceFolder } from '../../../../../../platform/workspace/common/workspace.js';
import { detectProjectTemplates, type IProjectIndexTemplate } from '../../../common/codebaseProjectTemplates.js';

export interface CodebaseToolContext {
	register(definition: { definition: any; handler: any }): void;
	codebaseGraphService: ICodebaseGraphService;
	workspaceService: IWorkspaceContextService;
	fileService: IFileService;
	logService: ILogService;
	adrManager: AdrManager;
	/** 文件系统级 ripgrep 搜索（search_files 同款引擎），供图谱未命中时回退检索。 */
	searchHelpers: SearchHelpers;
	/** 工具 source 标识（用于 definition.source）。 */
	id: string;
	/** 工作区路径解析 + 沙箱校验（search_files / 其它工具读取前调用）。 */
	resolveAndCheckWorkspacePath: (agentId: string | undefined, requestedPath: string, checkSandbox?: boolean) => Promise<string>;
	/**
	 * 2026-08-09：Agent Studio 当前激活工作区。搜索/索引/get_architecture 等工具
	 * 应当基于此（用户在工作区下拉中选择的 sarosis-agents-client/main）而非
	 * `workspaceService.getWorkspace().folders`（multi-workspace folders 合并，
	 * 会把已切换走的工作区如 S1Game/UE5EA 一起带回来）。
	 */
	studioService?: IAgentStudioService;
	/**
	 * 2026-08-17：worktree 路径（最权威，含任务级覆盖）。agentOSService 每轮 turn
	 * 前通过 setParentWorktreePath 设置，builtinToolProvider 转发。搜索根应优先
	 * 指向它——否则 agent 绑定 worktree 分支时 search_code/search_files 仍在主仓
	 * 搜索（日志 1786957557603：roots=[sarosis-agents-client] 而 agent 绑定 feat-chat）。
	 */
	getParentWorktreePath?: () => string | undefined;
}

export function registerCodebaseTools(ctx: CodebaseToolContext): void {
	const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];
	const json = (obj: unknown): IToolResultContent[] => [{ type: 'text', text: JSON.stringify(obj, null, 2) }];

	/**
	 * 2026-08-09：搜索/索引/get_architecture 等工具的根应取【当前激活的 agent 工作区】
	 * （用户在工作区下拉中选定的 sarosis-agents-client），而非
	 * `ctx.workspaceService.getWorkspace().folders`（multi-workspace folders 合并，
	 * 会把已切换走的工作区如 S1Game/UE5EA 一起带回来）。无 active workspace 时回退到
	 * VS Code 全部 folders。
	 */
	const getSearchFolders = async (agentId?: string): Promise<IWorkspaceFolder[]> => {
		// 2026-08-17：worktree 感知。最权威来源是 getParentWorktreePath()（每轮 turn 前由
		// agentOSService 通过 setParentWorktreePath 设置，含任务级 worktreePath 覆盖）。
		// 其次回退 getAgentBinding(activeId, agentId).worktreePath；再回退主工作区根。
		const parentWorktree = ctx.getParentWorktreePath?.();
		const studioSvc = ctx.studioService;
		if (studioSvc) {
			const activeId = studioSvc.getActiveWorkspaceId();
			if (activeId) {
				let wtPath: string | undefined = parentWorktree;
				if (!wtPath && agentId) {
					try {
						const binding = await studioSvc.getAgentBinding(activeId, agentId);
						wtPath = binding?.worktreePath;
					} catch (err) {
						ctx.logService.warn('[BuiltinTools] getSearchFolders: failed to resolve worktree binding:', err);
					}
				}
				if (wtPath) {
					const clean = wtPath.replace(/[\\/]+$/, '');
					const wtUri = URI.file(clean);
					const ws = await studioSvc.getWorkspace(activeId);
					return [{
						uri: wtUri,
						name: ws?.name ?? (clean.split(/[\\/]/).pop() || clean),
						index: 0,
						toResource: (relativePath: string) => URI.joinPath(wtUri, relativePath),
					}];
				}
				const ws = await studioSvc.getWorkspace(activeId);
				if (ws?.path) {
					const uri = URI.file(ws.path);
					return [{
						uri,
						name: ws.name,
						index: 0,
						toResource: (relativePath: string) => URI.joinPath(uri, relativePath),
					}];
				}
			}
		}
		return ctx.workspaceService.getWorkspace().folders;
		};

		/**
		 * 超大项目检测（2026-08-19）—— 用于「从文件夹添加工作区」的多项目父目录：
		 * 不自动索引时，codebase 工具遇到未索引的根要判断是否该让 LLM 询问用户。
		 *
		 * 判定口径（不递归深扫，仅顶层 + 一层子目录，开销毫秒级）：
		 *  - 顶层条目数（文件+目录）超过阈值；
		 *  - 或命中任一项目模板特征（UE / Unity / Node / Java / .NET / Python）。
		 *
		 * 父目录形态（顶层是 S1Game/、UE5EA/ 等子文件夹，*.uproject/Engine 藏在子目录里）
		 * 需探测一层子目录的顶层名，否则漏判（与 searchHelpers._isUnrealRoot 的一层探测同法）。
		 *
		 * @returns 检测结果：超大与否 + 命中的模板 + 建议排除目录。
		 */
		const _detectLargeProject = async (
			rootPath: string,
		): Promise<{ large: boolean; templates: IProjectIndexTemplate[]; excludeDirs: string[]; topLevelCount: number }> => {
			try {
				const stat = await ctx.fileService.resolve(URI.file(rootPath));
				const children = stat?.children ?? [];
				const topLevelCount = children.length;
				const names = new Set(children.map(c => c.name ?? '').filter(Boolean));
				// 一层子目录探测：父目录形态下项目标记文件在子目录里
				const dirs = children.filter(c => c.isDirectory).slice(0, 20);
				for (const d of dirs) {
					try {
						const sub = await ctx.fileService.resolve(d.resource);
						for (const c of (sub?.children ?? [])) {
							if (c.name) { names.add(c.name); }
						}
					} catch { /* 单个子目录不可读，跳过 */ }
				}
				const templates = detectProjectTemplates([...names]);
				const excludeSet = new Set<string>();
				for (const t of templates) { for (const d of t.excludeDirs) { excludeSet.add(d.toLowerCase()); } }
				// 超大判定：顶层条目 > 120，或命中 ≥1 个「重型/多项目」模板（UE/Unity/Java/.NET）
				const heavyIds = new Set(['unreal', 'unity', 'java', 'dotnet']);
				const large = topLevelCount > 120 || templates.some(t => heavyIds.has(t.id));
				return { large, templates, excludeDirs: [...excludeSet], topLevelCount };
			} catch {
				return { large: false, templates: [], excludeDirs: [], topLevelCount: 0 };
			}
		};

		/**
		 * codebase 工具「无图」时的统一引导（2026-08-19）。
		 * - 超大项目 → 返回让 LLM 停下来询问用户是否构建索引的文案（不再无条件 index_repository）。
		 * - 非超大 → 保留原「Run index_repository first」轻提示。
		 */
		const noGraphGuidance = async (toolName: string): Promise<IToolResultContent[]> => {
			const folders = await getSearchFolders();
			const root = folders[0]?.uri?.fsPath;
			if (!root) { return text(`${toolName}: no graph loaded. Run index_repository first.`); }
			const det = await _detectLargeProject(root);
			if (!det.large) { return text(`${toolName}: no graph loaded. Run index_repository first.`); }

			let tpl = '';
			if (det.templates.length > 0) {
				const labels = det.templates.map(t => t.label).join(' / ');
				const excl = det.excludeDirs.join(', ');
				tpl = `检测到项目类型：${labels}。建议排除目录：${excl}（会自动并入通用排除集）。`;
			}
			return text(
				`${toolName}: 当前工作区「${root}」尚未构建代码索引，且这是一个超大目录（顶层 ${det.topLevelCount} 个条目${det.templates.length ? '，疑似多项目/重型项目' : ''}）。\n` +
				`为避免长时间卡顿，请在继续前先询问用户：是否需要在对应项目文件夹下构建索引？\n` +
				`${tpl ? tpl + '\n' : ''}` +
				`用户确认后，可调用 index_repository（推荐带上 exclude_dirs 缩小范围）；` +
				`若用户拒绝，则改用 search_code / search_files 这类不依赖索引的文件系统搜索，并尽量带 path_filter 收敛到具体子目录。`,
			);
		};

	/**
	 * search_graph 0 结果时的近似名建议（2026-07-26，事故 1785053998262）：
	 * 模型搜「CollectGarbageInternal」（UE4 命名/幻觉名）在 UE5EA 图谱必然 0 结果，
	 * 却把「符号不存在」误读为「名字不对」连试 7 个变体。这里把 namePattern 按
	 * camelCase/分隔符词段逐级截短（CollectGarbageInternal→CollectGarbage→Collect），
	 * 用首个有命中的前缀返回 top 5 节点名，让模型第一轮就能自我纠偏。
	 * 最多 2 次回退搜索（毫秒级），仅长复合名（≥6 字符、≥2 词段）触发。
	 */
	const _suggestSimilarNames = async (namePattern: string): Promise<string> => {
		const trimmed = namePattern.trim();
		if (trimmed.length < 6) { return ''; }
		const segs = trimmed.split(/(?=[A-Z])|[_:.\-/]+/).filter(s => s.length > 0);
		if (segs.length < 2) { return ''; }
		for (let drop = 1; drop <= Math.min(2, segs.length - 1); drop++) {
			const prefix = segs.slice(0, segs.length - drop).join('');
			if (prefix.length < 3 || prefix === trimmed) { continue; }
			try {
				const r = await ctx.codebaseGraphService.searchGraphAsync({ namePattern: prefix, limit: 5 });
				if (r.total > 0 && r.nodes.length > 0) {
					const names = [...new Set(r.nodes.map((n: any) => n?.name).filter(Boolean))].slice(0, 5);
					if (names.length > 0) { return names.join(', '); }
				}
			} catch { /* best effort */ }
		}
		return '';
	};

	// ── TOON 紧凑表输出（P2-#1） ──────────────────────────────────────
	// C 版 format:"toon" 对标：无缩进、无重复键名、单字符分隔，较 JSON 省 ~60% token。
	// 路径压缩为末段（…/dir/file.ts），保留定位所需信息同时大幅降 token。
	/** 紧凑表：header 行 + 每行用 | 连接；空值输出空串。 */
	const _toonTable = (headers: string[], rows: (string | number)[][]): string => {
		const lines = [headers.join('|')];
		for (const r of rows) {
			lines.push(r.map(c => (c === undefined || c === null ? '' : String(c))).join('|'));
		}
		return lines.join('\n');
	};

	/**
	 * 项目相对 filePath → 绝对路径（root/file）。
	 * 多 folder 工作区（如图谱含 S1Game + UE5EA 双项目）时，相对路径会让模型
	 * 误拼首个 folder 根导致 file_read "Unable to resolve nonexistent file"——
	 * 这里直接用节点所属 project 的索引根拼绝对路径，模型可原样 file_read。
	 * 已是绝对路径（盘符或 / 开头）或根不可解析时原样返回。
	 */
	const _absPath = (project: string | undefined, filePath: string): string => {
		const p = filePath.replace(/\\/g, '/');
		if (/^[a-zA-Z]:\//.test(p) || p.startsWith('/')) { return p; }
		const roots = ctx.codebaseGraphService.getProjectRoots();
		const root = project ? roots[project] : undefined;
		return root ? `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/${p}` : p;
	};

	/** 项目相对 filePath → 绝对 loc（root/file:line）；规则同 _absPath。 */
	const _absLoc = (project: string | undefined, filePath: string | undefined, startLine: number | undefined): string => {
		if (!filePath) { return '-'; }
		return `${_absPath(project, filePath)}:${startLine ?? '-'}`;
	};

	/**
	 * 截断警告文案（2026-07-26，对齐 Continue 的 Truncation warning 思路）：
	 * truncated 布尔字段模型常忽略、继续盲搜——把「如何缩小范围」直接写进输出。
	 */
	const _truncHint = (shown: number, total: number): string =>
		`Results truncated (showing ${shown} of ${total}). Narrow down: add filePattern to scope files, pass a more specific query, probe several names at once with identifier|alternation, or use project to limit to one project.`;

	/** search_graph 结果 → TOON 表（含可选 fields 列与 semantic_results 副表）。 */
	const _buildSearchGraphToon = (resp: any, fieldList?: string[]): string => {
		const nodes = (resp.nodes as any[]) || [];
		const headers = ['#', 'type', 'qn', 'loc', 'in', 'out'];
		if (fieldList && fieldList.length > 0) { headers.push(...fieldList); }
		const rows = nodes.map((n, i) => {
			const loc = _absLoc(n.project, n.filePath, n.startLine);
			const base: (string | number)[] = [
				i + 1,
				n.label || n.type || '-',
				n.qualifiedName || n.name || '-',
				loc,
				n.inDegree ?? 0,
				n.outDegree ?? 0,
			];
			if (fieldList && fieldList.length > 0) {
				const fields = (n.fields || n.properties || {}) as Record<string, unknown>;
				for (const f of fieldList) { base.push(fields[f] as string | number ?? ''); }
			}
			return base;
		});
		const head = `TOON search_graph: total=${resp.total ?? nodes.length} returned=${nodes.length} hasMore=${resp.hasMore ?? false}`;
		let out = head + '\n' + _toonTable(headers, rows);
		const sem = resp.semantic_results as any[] | undefined;
		if (sem && sem.length > 0) {
			const sheaders = ['#', 'type', 'qn', 'loc', 'score'];
			const srows = sem.map((s, i) => [
				i + 1,
				s.type || '-',
				s.qualifiedName || s.name || '-',
				_absLoc(s.project, s.filePath, s.startLine),
				s.score ?? '',
			]);
			out += '\n\nsemantic_results:\n' + _toonTable(sheaders, srows);
		}
		return out;
	};

	/** trace_path 结果 → TOON 表（风险列仅在 riskLabels 开启时存在）。 */
	const _buildTraceToon = (res: any): string => {
		const hops = (res.hops as any[]) || [];
		const hasRisk = hops.some(h => h.risk);
		const headers = ['d', 'type', 'qn', 'loc', ...(hasRisk ? ['risk'] : [])];
		const rows = hops.map((h: any) => {
			const node = h.node || {};
			const loc = _absLoc(node.project, node.filePath, node.startLine);
			const base: (string | number)[] = [
				h.depth ?? 0,
				node.label || node.type || '-',
				node.qualifiedName || node.name || '-',
				loc,
			];
			if (hasRisk) { base.push(h.risk || '-'); }
			return base;
		});
		const head = `TOON trace_path: found=${res.found ?? false} hops=${hops.length} depth=${res.totalDepth ?? 0}`;
		const summary = res.summary ? '\n' + res.summary : '';
		return head + summary + '\n' + _toonTable(headers, rows);
	};

	const ensureGraph = async (): Promise<boolean> => {
		// 竞态守卫：启动时 bootstrap 的 loadGraphMerge 可能仍在进行中，
		// 大图谱（10w+ 节点）加载需数十秒——期间判"无数据"会误导 LLM 触发全量重建
		await ctx.codebaseGraphService.whenGraphLoaded();
		if (!ctx.codebaseGraphService.hasGraphData()) {
			// Phase 2f：内存 store 为空时，从 SQLite 按需加载（仅当 sqliteBackend 启用时生效）
			if (!await ctx.codebaseGraphService.tryLoadFromSqlite()) {
				return false;
			}
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
					repo_path: { type: 'string', description: 'Repository path to index (optional, defaults to workspace root). For a multi-project parent directory, set this to a specific project subfolder to index only that project.' },
					mode: { type: 'string', enum: ['fast', 'moderate', 'full'], description: 'Indexing depth (optional, default: fast)' },
					force: { type: 'boolean', description: 'Force re-index even if graph already loaded (default: false)' },
					exclude_dirs: { type: 'array', items: { type: 'string' }, description: 'Additional directory names to exclude (merged with common defaults). Use values suggested by the no-graph guidance (e.g. Binaries, Intermediate, Content) to avoid indexing build/asset directories.' },
				},
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			const repoPath = args['repo_path'] as string | undefined;
			const mode = (args['mode'] as 'fast' | 'moderate' | 'full' | undefined) || 'fast';
			const force = (args['force'] as boolean | undefined) ?? false;
			const excludeDirs = Array.isArray(args['exclude_dirs'])
				? (args['exclude_dirs'] as unknown[]).map(String).filter(Boolean)
				: [];
			const folders = await getSearchFolders();
			if (folders.length === 0) {
				return text('index_repository error: no workspace folder open');
			}

			// 指定了 repo_path → 单目录索引；未指定 → 依次索引所有工作区目录
			let targetPaths = repoPath
				? [repoPath]
				: folders.map(f => f.uri.fsPath);

			// Guard: skip re-index if graph already loaded with data (unless force=true)
			// 竞态守卫：先等待启动时的图谱合并加载完成，再判定各 folder 是否已有数据。
			// 多目录按 folder 逐个检查——全部就绪则整体跳过；部分就绪则只索引缺失的 folder
			// （旧逻辑多目录永不跳过，配合 LLM 每会话先 index_status 的习惯 → 每次都全量重建）。
			await ctx.codebaseGraphService.whenGraphLoaded();
			if (!force) {
				const notReady = targetPaths.filter(p => !ctx.codebaseGraphService.hasProjectData(p));
				if (notReady.length === 0) {
					const status = ctx.codebaseGraphService.getIndexStatus();
					return text(`index_repository: graph already loaded (${status?.nodeCount ?? 0} nodes, ${status?.edgeCount ?? 0} edges from ${status?.fileCount ?? 0} files). ` +
						`Set force=true to re-index.`);
				}
				if (notReady.length < targetPaths.length) {
					ctx.logService.info(`[BuiltinTools] index_repository: ${targetPaths.length - notReady.length} folder(s) already indexed, only indexing: ${notReady.join(', ')}`);
				}
				targetPaths = notReady;
			}

			const results: string[] = [];
			for (const wsPath of targetPaths) {
				try {
					ctx.logService.info(`[BuiltinTools] [TRACE] index_repository tool → indexWorkspace: ${wsPath}`);
					const result = await ctx.codebaseGraphService.indexWorkspace(wsPath, {
						mode,
						excludeDirs,
					});
					results.push(`${wsPath}: ${result.success ? 'OK' : 'FAILED'} — ${result.message}`);
				} catch (err: any) {
					results.push(`${wsPath}: ERROR — ${err?.message || err}`);
				}
			}
			return text(results.join('\n'));
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
			if (!await ensureGraph()) {
				return noGraphGuidance('index_status');
			}
			// 优先用异步版本：内存 store 为空时从 SQLite 后端获取真实计数
			const status = await ctx.codebaseGraphService.getIndexStatusAsync();
			return json({ indexed: status.nodeCount > 0, ...status });
		},
	});

	// ── check_index_coverage ─────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'check_index_coverage',
			description: 'Report codebase indexing coverage: how many files were fully indexed vs ' +
				'skipped (unsupported/oversized/long-line), parse-errored, timed-out, or only partially parsed. ' +
				'Returns a summary with coverage percentage plus the explicit lists of skipped and error files ' +
				'(each with reason), so you can verify completeness and decide whether to re-index problematic files.',
			inputSchema: {
				type: 'object',
				properties: {
					includeFiles: { type: 'boolean', default: true, description: 'Include the skippedFiles/errorFiles lists (set false for summary only).' },
				},
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			if (!await ensureGraph()) {
				return noGraphGuidance('check_index_coverage');
			}
			const report = ctx.codebaseGraphService.getIndexCoverage();
			const includeFiles = (args['includeFiles'] as boolean | undefined) ?? true;
			if (!includeFiles) {
				const { skippedFiles, errorFiles, ...summary } = report;
				return json(summary);
			}
			return json(report);
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
		const roots = ctx.codebaseGraphService.getProjectRoots();
		const projects = ctx.codebaseGraphService.listProjects()
			.map(p => ({ ...p, rootPath: roots[p.name] ?? null }));
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

	// ── search_graph (PRIMARY code search — use this FIRST) ─────────
	ctx.register({
		definition: {
			name: 'search_graph',
			description: 'PRIMARY code-search tool — ALWAYS use this FIRST for any code-related query. ' +
				'IMPORTANT: search_graph matches node names/qualified_names/file_paths/signatures only — NOT source code content (function bodies, variable names, call sites). ' +
				'For searching INSIDE code content (grep-style), use "search_code" instead. ' +
				'Use this INSTEAD of search_files for code-structure questions like "who calls X?", "where is Y defined?", "what does Z depend on?". ' +
				'Supports three modes: (1) query="update settings" for natural-language search, (2) namePattern="Handler" for exact name matching, ' +
				'(3) semantic_query=["send","publish"] for vocabulary-bridging semantic search. Combine modes in a single call. ' +
				'Paginate with offset/limit when hasMore=true.',
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
				qnPattern: { type: 'string', description: 'Qualified-name pattern (regex, case-insensitive) to filter results by qualifiedName (e.g. "Controller::.*").' },
				includeConnected: { type: 'boolean', default: false, description: 'Include directly-connected nodes (edge type + neighbor name) for each result node, enabling one-hop graph exploration.' },
				fields: { type: 'array', items: { type: 'string' }, description: 'Extra per-node property columns to return (e.g. ["cyclomaticComplexity","returnType","paramTypes","signature","docstring","isTest"]). Pulled from node.properties; missing keys emit as null.' },
			semantic_query: { type: 'array', items: { type: 'string' }, description: 'MUST be an ARRAY of keyword strings (e.g. ["send","pubsub","publish"]) — NOT a single string. Each keyword is scored independently via 6-signal fusion; results reflect nodes that score well on ALL keywords (min-score re-ranking). Results appear in "semantic_results" field (separate from "results"). Requires index with similarity/semantic passes enabled (moderate or full mode).' },
			format: { type: 'string', enum: ['json', 'toon'], default: 'toon', description: 'Output format. "toon" (default) returns a compact pipe-delimited table (header row + one row per node), saving ~60% tokens — recommended for large result sets. Extra "fields" columns are appended after the degree columns; semantic_results render as a second table. "json" returns the full structured object.' },
			},
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			// SQLite 后端感知：启用时先查后端计数（避免 Phase 2f 把全图回载内存）；
			// 未启用时 hasGraphDataAsync===hasGraphData，走原 ensureGraph 磁盘回载路径。
			if (!await ctx.codebaseGraphService.hasGraphDataAsync() && !await ensureGraph()) { return noGraphGuidance('search_graph'); }
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
		// 新增参数（对标 C 版）：qnPattern / includeConnected / fields
		const qnPattern = args['qnPattern'] as string | undefined;
		const includeConnected = (args['includeConnected'] as boolean | undefined) ?? false;
		const fieldList = args['fields'] as string[] | undefined;
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
		// P0：SQLite 后端启用时检索走主进程 FTS5/LIKE（不回载全图）；未启用退化为同步内存路径
		const result = await ctx.codebaseGraphService.searchGraphAsync(searchParams);

		// ── qnPattern: filter by qualifiedName regex ──
		if (qnPattern && result.nodes.length > 0) {
			try {
				const re = new RegExp(qnPattern, 'i');
				result.nodes = result.nodes.filter((n: any) => n.qualifiedName && re.test(n.qualifiedName));
				result.total = result.nodes.length;
			} catch {
				return text(`search_graph error: invalid qnPattern regex "${qnPattern}"`);
			}
		}

		// ── fields + includeConnected: enrich each result node ──
		if (result.nodes.length > 0 && (fieldList || includeConnected)) {
			const MAX_CONNECTED = 20;
			for (const n of result.nodes) {
				if (fieldList && fieldList.length > 0) {
					const props = (n as any).properties || {};
					(n as any).fields = {};
					for (const f of fieldList) {
						(n as any).fields[f] = props[f] ?? null;
					}
				}
				if (includeConnected) {
					try {
						const edges = ctx.codebaseGraphService.getEdges((n as any).id);
						(n as any).connected = edges.slice(0, MAX_CONNECTED).map((e: any) => {
							const otherId = e.source === (n as any).id ? e.target : e.source;
							const other = ctx.codebaseGraphService.getNode(otherId);
							return { edgeType: e.type, neighborId: otherId, neighborName: other?.name ?? otherId };
						});
					} catch { /* best effort */ }
				}
			}
		}

		if (result.total === 0 && (!semanticResults || semanticResults.length === 0)) {
				// 空结果时提供诊断提示
				const totalNodes = ctx.codebaseGraphService.getTotalNodeCount();
				let hint = `search_graph returned 0 results. Graph has ${totalNodes} nodes total.`;
			if (searchParams.label && searchParams.namePattern) {
				hint += ` Searched label="${searchParams.label}" with namePattern="${searchParams.namePattern}". Try broader search: omit label, or use a partial name.`;
				const sug = await _suggestSimilarNames(searchParams.namePattern);
				if (sug) { hint += ` Did you mean: ${sug}?`; }
			} else if (searchParams.label) {
				hint += ` Searched only label="${searchParams.label}". Try without label to search all types.`;
			} else if (searchParams.namePattern) {
				hint += ` No nodes match namePattern="${searchParams.namePattern}". Try broader or partial name match.`;
				const sug = await _suggestSimilarNames(searchParams.namePattern);
				if (sug) { hint += ` Did you mean: ${sug}?`; }
			} else if (searchParams.query) {
					hint += ` BM25 search for "${searchParams.query}" returned 0 results. search_graph only matches node names/qualified_names/file_paths/signatures — NOT source code content (function bodies, variable names, call sites). To search inside code content, use the "search_code" tool instead (grep-based, matches any text in indexed files). Try different keywords, or use list_projects to verify the graph is indexed.`;
				} else if (semanticQuery) {
					hint += ` Semantic search for ${semanticQuery.length} keyword(s) returned 0 results. Try broader single-word queries, or ensure index was built with moderate/full mode.`;
				}
			// 命中全部落在其它已索引项目（2026-08-20，日志 1787221348803）：
			// 此前 sqlite `searchNodes` 不按 project 过滤，UE5EA 的 `LoadImage` 函数节点
			// 被当作本仓结果返回，模型据此判定图不可用并弃用 search_graph 达 65 次。
			// 收敛到当前项目后必须把「其它项目有、本项目没有」如实说明，否则模型会把
			// 0 命中误读为「符号不存在」。
			const _cross = (result as { crossProjectOnly?: { project: string; count: number }[] }).crossProjectOnly;
			if (_cross && _cross.length > 0) {
				hint += ` NOTE: ${_cross.map(c => `${c.count} match(es) in project "${c.project}"`).join(', ')}` +
					` — none in the current project. Those belong to a DIFFERENT indexed repository;` +
					` pass project="<name>" explicitly if you really meant to search it. For symbols in the current` +
					` project that are string literals / node-type names (not declarations), use search_code instead.`;
			}
			ctx.logService.warn(`[BuiltinTools] search_graph: 0 results (total=${totalNodes})`);
			const fmt0 = (args['format'] as string) || 'toon';
			if (fmt0 === 'toon') {
				return text(`TOON search_graph: total=0 returned=0 hasMore=false\n${hint}`);
			}
			return [{ type: 'text', text: JSON.stringify({ nodes: [], total: 0, hasMore: false, hint }, null, 2) }];
		}
	// Combine graph results with semantic results
	const response: any = { ...result };
	if (semanticResults && semanticResults.length > 0) {
		response.semantic_results = semanticResults;
	}
	// 多项目图谱：输出前把项目相对 filePath 还原为绝对路径（TOON/JSON 一致，
	// _absPath 对已绝对路径幂等），模型拿到的路径可直接 file_read。
	for (const n of (response.nodes as any[]) || []) {
		if (n.filePath) { n.filePath = _absPath(n.project, n.filePath); }
	}
	for (const s of (response.semantic_results as any[]) || []) {
		if (s.filePath) { s.filePath = _absPath(s.project, s.filePath); }
	}
	// [CBSearch] handler 结果汇总：最终召回规模（排查"找不到内容"的最后一环）
	ctx.logService.info(`[BuiltinTools] [CBSearch][trace] search_graph result: total=${response.total} returned=${((response.nodes as any[]) || []).length} semantic=${semanticResults?.length ?? 0} qnPattern=${qnPattern ?? '-'}`);
	// 截断警告文本化（Continue Truncation warning 思路）：hasMore 模型常忽略
	if (response.hasMore) {
		response.truncated_hint = _truncHint(((response.nodes as any[]) || []).length, Number(response.total) || 0);
	}
	const format = (args['format'] as string) || 'toon';
		if (format === 'toon') {
			let out = _buildSearchGraphToon(response, fieldList);
			// TOON 尾部追加 HINT 行（单列短行，UI 解析按 cols<4 跳过，安全）
			if (response.truncated_hint) { out += `\nHINT: ${response.truncated_hint}`; }
			return text(out);
		}
		return json(response);
		},
	});

	// ── query_graph (Cypher) ────────────────────────────────────────
	ctx.register({
		definition: {
		name: 'query_graph',
		description: 'PREFERRED for cross-file structural queries. Query the codebase graph with pattern-matching to find relationships. ' +
			'Use MATCH to select nodes/edges, WHERE to filter, RETURN to project. ' +
			'Faster and more precise than search_code for: "find all callers of X", "classes implementing interface Y", ' +
			'"functions called by module Z". Use graph_schema first to see node/edge types available.',
		inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Cypher query string. Example: MATCH (f:Function) WHERE f.inDegree >= 10 RETURN f.name ORDER BY f.inDegree DESC LIMIT 10. Ignored when graph="missed".' },
					project: { type: 'string', description: 'Project name (optional, defaults to current workspace)' },
					max_rows: { type: 'integer', description: 'Row limit (optional, default unlimited up to 100k ceiling)' },
					graph: { type: 'string', description: 'Graph selector. Omit for the main code graph. Use "missed" to return the structural graph of NOT-fully-indexed files (Project→Folder→File with kind=skipped/parse_error/timeout/partial and detail=reason).' },
				},
				required: ['query'],
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			if (!await ensureGraph()) { return noGraphGuidance('query_graph'); }
			const graph = args['graph'] as string | undefined;
			if (graph === 'missed') {
				const missed = ctx.codebaseGraphService.getMissedGraph();
				return json(missed);
			}
			const query = String(args['query'] ?? '');
			if (!query) { return text('query_graph error: "query" is required (unless graph="missed")'); }
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
							'routes', 'hotspots', 'crossBoundaries', 'layers', 'communities',
							'structure', 'dependencies', 'file_tree', 'fileTree', 'services'] },
						description: 'Aspects to include. "all" = everything; "overview" = languages+packages+entryPoints+hotspots; ' +
							'"structure" = packages+layers+fileTree; "dependencies" = crossBoundaries+packages; "file_tree" = fileTree; omit = all.',
					},
					path: { type: 'string', description: 'Optional directory prefix to scope architecture (e.g. src/app)' },
				},
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			if (!await ensureGraph()) { return noGraphGuidance('get_architecture'); }
			const rawAspects = args['aspects'] as string[] | undefined;
			const scopePath = args['path'] as string | undefined;
			// C 对齐的 aspect 别名 → 具体报告字段（token 高效）
			const ASPECT_ALIASES: Record<string, string[]> = {
				structure: ['packages', 'layers', 'fileTree'],
				dependencies: ['crossBoundaries', 'packages'],
				file_tree: ['fileTree'],
			};
			let aspects = rawAspects;
			if (rawAspects && rawAspects.length > 0 && rawAspects[0] !== 'all') {
				const expanded = new Set<string>();
				for (const a of rawAspects) {
					if (ASPECT_ALIASES[a]) { ASPECT_ALIASES[a].forEach(x => expanded.add(x)); }
					else { expanded.add(a); }
				}
				aspects = [...expanded];
			}
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
						if (c.top_nodes) {
							return c.top_nodes.some((n: any) => isInScope(n.filePath || n.path || ''));
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
		handler: async (args: Record<string, unknown>, _signal?: unknown, agentId?: string) => {
			if (!await ensureGraph()) { return noGraphGuidance('get_code_snippet'); }
			// alias: qualified_name → qualifiedName (MCP compatibility)
			if (!args['qualifiedName'] && args['qualified_name']) { args['qualifiedName'] = args['qualified_name']; }
			const qualifiedName = String(args['qualifiedName'] ?? '');
			if (!qualifiedName) { return text('get_code_snippet error: "qualifiedName" (or "qualified_name") is required'); }
			const contextLines = (args['contextLines'] as number | undefined) ?? 3;
			const includeNeighbors = (args['includeNeighbors'] as boolean | undefined) ?? false;
		const result = await ctx.codebaseGraphService.getCodeSnippet(qualifiedName, contextLines, includeNeighbors);
		if (!result) {
			// 图谱未索引该符号（如 C++ 源码未纳入索引）→ 回退到全工作区 ripgrep 文本检索。
			// 优先用完整限定名（命中 `GC::ProcessAsync(` 这类定义行），否则用末段叶子符号兜底。
			const leaf = qualifiedName.split(/::/).pop() || qualifiedName;
			let fb = await _fallbackGrepWorkspaceCached(qualifiedName, undefined, 30, Math.max(contextLines, 3), agentId);
			if (!fb && leaf !== qualifiedName) {
				fb = await _fallbackGrepWorkspaceCached(leaf, undefined, 30, Math.max(contextLines, 3), agentId);
			}
			if (fb) {
				ctx.logService.info(`[BuiltinTools] get_code_snippet fallback (filesystem grep) for: ${qualifiedName}`);
				return text(
					`Code snippet for "${qualifiedName}" not in code graph index (symbol may be in non-indexed source, ` +
					`e.g. C++ not covered by keepDirs). Falling back to filesystem grep:\n\n${fb}`,
				);
			}
			return text(`Code snippet not found for: ${qualifiedName}`);
		}
		// [CBSearch] snippet 命中追踪（含 filePath 与行范围，排查路径归属问题）
		ctx.logService.info(`[BuiltinTools] [CBSearch][trace] get_code_snippet hit: qn="${qualifiedName}" file=${result.filePath ?? '-'} lines=${result.startLine ?? '?'}-${result.endLine ?? '?'}`);
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
		if (!await ensureGraph()) { return noGraphGuidance('get_graph_schema'); }
		const schema = ctx.codebaseGraphService.getGraphSchema();
		// ADR detection (aligns with C version's adr_present + adr_hint)
		try {
			const folders = await getSearchFolders();
			if (folders.length > 0) {
				const adrs = await ctx.adrManager.list(folders[0].uri);
				if (adrs && adrs.length > 0) {
					(schema as any).adr_present = true;
				} else {
					(schema as any).adr_present = false;
					(schema as any).adr_hint = 'No ADRs found. Use manage_adr to create architecture decision records.';
				}
			}
		} catch { /* best effort */ }
		return json(schema);
	},
	});

	// ── trace_path ──────────────────────────────────────────────────
	ctx.register({
		definition: {
		name: 'trace_path',
		description: 'Trace full call paths through the code graph. Returns structured caller/callee chains with file locations. ' +
			'Modes: calls (follow CALLS edges — default), data_flow (CALLS+DATA_FLOWS with arg expressions), ' +
			'cross_service (through HTTP/async Route nodes). ' +
			'PREFERRED over search_code for: impact analysis, call chain tracing, data flow tracking. ' +
			'Use direction=up for callers, direction=down for callees.',
		inputSchema: {
				type: 'object',
				properties: {
					sourceName: { type: 'string', description: 'Source function name to trace from' },
					targetName: { type: 'string', description: 'Optional target function to find path to' },
					mode: { type: 'string', enum: ['calls', 'data_flow', 'cross_service'], default: 'calls', description: 'Trace mode. calls: follow CALLS edges. data_flow: CALLS+DATA_FLOWS. cross_service: through HTTP/async Routes.' },
					maxDepth: { type: 'number', description: 'Max trace depth (default 10)' },
					direction: { type: 'string', enum: ['both', 'callers', 'callees'], default: 'both', description: 'Trace direction' },
					includeTests: { type: 'boolean', default: true, description: 'Include test files in results. When false, test nodes are filtered out.' },
					riskLabels: { type: 'boolean', default: false, description: 'Add risk classification (CRITICAL/HIGH/MEDIUM/LOW) per hop based on in/out degree and depth.' },
				edgeTypes: { type: 'array', items: { type: 'string' }, description: 'Restrict traversal to these edge types (e.g. ["CALLS","HTTP_CALLS"]). Overrides mode-derived edge types when provided.' },
				format: { type: 'string', enum: ['json', 'toon'], default: 'toon', description: 'Output format. "toon" (default) returns a compact pipe-delimited table (depth|type|qn|loc[|risk]), saving ~60% tokens. "json" returns the full structured object.' },
			},
				required: ['sourceName'],
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			if (!await ensureGraph()) { return noGraphGuidance('trace_path'); }
			// alias: function_name → sourceName (MCP compatibility)
			if (!args['sourceName'] && args['function_name']) { args['sourceName'] = args['function_name']; }
			const sourceName = String(args['sourceName'] ?? '');
			const targetName = args['targetName'] as string | undefined;
			const mode = (args['mode'] as string | undefined) || 'calls';
			const maxDepth = args['maxDepth'] as number | undefined;
			const direction = args['direction'] as 'both' | 'callers' | 'callees' | undefined;
			const includeTests = (args['includeTests'] as boolean | undefined) ?? true;
			const riskLabels = (args['riskLabels'] as boolean | undefined) ?? false;
			const edgeTypes = args['edgeTypes'] as string[] | undefined;

			const result = ctx.codebaseGraphService.tracePathAdvanced(sourceName, targetName, {
				mode: mode as any,
				maxDepth,
				direction,
				includeTests,
				edgeTypes,
			});

	// risk_labels=false (default): strip risk columns to save tokens (matches C default).
	if (!riskLabels && result && Array.isArray(result.hops)) {
		result.hops = result.hops.map((h: any) => {
			const { risk, riskReason, ...rest } = h;
			return rest;
		});
	}
	// [CBSearch] trace 结果追踪：hops 数与源解析状态（排查"找不到内容"）
	ctx.logService.info(`[BuiltinTools] [CBSearch][trace] trace_path source="${sourceName}" target=${targetName ?? '-'} mode=${mode} hops=${result?.hops?.length ?? 0}${result?.error ? ` error=${result.error}` : ''}`);
	const traceFormat = (args['format'] as string) || 'toon';
		if (traceFormat === 'toon') {
			return text(_buildTraceToon(result));
		}
		return json(result);
		},
	});

	// ── 轻量 glob → regex 转换器（path_filter 从 RegExp 改为 glob 语法） ──
	// LLM 天然倾向 glob 语义（**=递归、*=通配、?=单字符），直接 RegExp 匹配
	// 会导致 `GarbageCollection/.cpp` 这样的 glob 被静默丢弃（/ 需转义）。
	// 本函数处理常见 glob 模式：**, *, ?, {a,b}, 保留已有正则能力。
	const _globToRegex = (pattern: string): RegExp => {
		// 如果 pattern 已经是正则字面量（/.../flags），直接解析
		const regexLiteral = /^\/(.+)\/([gimsu]*)$/.exec(pattern);
		if (regexLiteral) {
			return new RegExp(regexLiteral[1], regexLiteral[2]);
		}
		// 如果 pattern 含 ^/$ 锚点或 \\ 转义 → 可能是用户手写正则，直接尝试
		if (/^[\^]/.test(pattern) || /[$]$/.test(pattern) || /\\[dDwWsS]/.test(pattern)) {
			try { return new RegExp(pattern); } catch { /* fall through to glob */ }
		}
		// glob → regex: 先转义正则特殊字符，再还原 glob 通配符
		let rx = pattern
			// 2026-07-27（日志 1785118063787）：转义字符集必须含 `*`——此前漏了，
			// 导致 `*` 从未被转义为 `\*`，后续 `\\\*` 还原步骤全部匹配不到，裸 `*`
			// 留在正则里抛 SyntaxError（"Nothing to repeat"）。调用方普遍 catch
			// 静默兜底（pathFilter 过滤实际一直失效为"全过"），直到 search_files
			// 索引快路径的 warn 日志才暴露。
			.replace(/[.*,+^${}()|[\]\\]/g, '\\$&')  // 转义 regex 特殊字符（含 * 与 ,——,{a,b} 还原依赖）
			.replace(/\\\*\\\*/g, '<<<GLOBSTAR>>>')   // 保存 **
			.replace(/\\\*/g, '[^/]*')                 // * → 非斜杠通配
			.replace(/<<<GLOBSTAR>>>/g, '.*')          // ** → 匹配任意含 / 路径
			.replace(/\\\?/g, '[^/]')                   // ? → 单字符非斜杠
			.replace(/\\\{/g, '(').replace(/\\,/g, '|').replace(/\\\}/g, ')'); // {a,b} → (a|b)
		return new RegExp(rx);
	};

	// 直接文件 grep 回落已随 search_code 重构移除（2026-07-27）：search_code 改用
	// ripgrep（SearchHelpers.searchContent + resolvedPath + includePattern）直接扫盘，
	// 覆盖未索引目录，无需自建目录遍历 grep。

	// 全工作区 ripgrep 回落：图谱索引未命中（例如 C++ 源码未被索引进图谱）时，
	// 直接走 search_files 同款 ripgrep 引擎在整个工作区搜索，避免"图谱无结果即返回空"。
	// 遍历所有 workspace folder，逐个调用 SearchHelpers.searchContent 并合并。
	// 默认仅搜索源码文件（排除 HTML/模板/二进制/文档），避免回落结果被 HTML 标签污染。
	const SOURCE_CODE_GLOB = '{*.cpp,*.h,*.hpp,*.c,*.cc,*.cxx,*.cs,*.ts,*.tsx,*.js,*.jsx,*.py,*.java,*.go,*.rs,*.rb,*.lua,*.sql,*.m,*.mm,*.swift,*.kt,*.kts,*.scala,*.groovy,*.pl,*.pm,*.php,*.r,*.R,*.f,*.f90,*.f95,*.for,*.pas,*.pp,*.d,*.di,*.nim,*.ex,*.exs,*.erl,*.hrl,*.ml,*.mli,*.hs,*.lhs,*.clj,*.cljs,*.scm,*.ss,*.rkt,*.vim,*.el,*.lisp,*.asm,*.s,*.S}';
	/** fallback 单 folder 扫描超时（2026-07-26）：UE5EA 全量源码扫 30s+ 曾致连续白扫 */
	const _FALLBACK_GREP_TIMEOUT_MS = 15_000;
	const _fallbackGrepWorkspace = async (
		pattern: string,
		fileGlob: string | undefined,
		limit: number,
		contextLines: number,
		agentId?: string,
	): Promise<string | null> => {
		const effectiveGlob = fileGlob || SOURCE_CODE_GLOB;
		const folders = await getSearchFolders(agentId);
		if (folders.length === 0) { return null; }
		const parts: string[] = [];
		let totalMatches = 0;
		for (const f of folders) {
			// 2026-07-26（日志 1785078531442）：每 folder 15s 超时——UE5EA 全量引擎
			// 源码扫描 30s+ 无中断手段曾致 6×30s 白扫。超时返回引导文本（模型可据此
			// 用 filePattern/project 缩小范围）；超时结果非 null → 不会记入否定缓存。
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), _FALLBACK_GREP_TIMEOUT_MS);
			try {
				const out = await ctx.searchHelpers.searchContent(
					f.uri.fsPath, pattern, effectiveGlob, limit, 0, 'content', contextLines, ctrl.signal,
				);
				if (out && out.trim().length > 0 && !/no (matches|results)/i.test(out)) {
					parts.push(out.trim());
					// 粗略计数（避免重复浪费算力）
					totalMatches += (out.match(/\n/g) || []).length;
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (/cancel/i.test(msg)) {
					const rootLabel = f.name ?? f.uri.fsPath;
					ctx.logService.warn(`[BuiltinTools] [CBSearch][trace] fallback workspace grep TIMED OUT on ${rootLabel} (${_FALLBACK_GREP_TIMEOUT_MS}ms): pattern="${pattern.slice(0, 60)}"`);
					parts.push(`## ${rootLabel}\n(workspace grep timed out after ${_FALLBACK_GREP_TIMEOUT_MS / 1000}s on this large folder — partial coverage. Narrow down: pass filePattern to scope file types, or use the project parameter to search one project only.)`);
				}
				// 其余单个 folder 失败不影响其它 folder
			} finally {
				clearTimeout(timer);
			}
		}
		if (parts.length === 0) { return null; }
		return parts.join('\n\n');
	};
	// 2026-07-26（日志 1785078531442）：fallback 否定结果缓存——全工作区 ripgrep
	// 无结果时缓存 TTL 内直接返回 null。模型常用同一 pattern 反复触发 fallback，
	// 每次白扫 UE5EA 全量引擎源码 30s+（实测 6×30s 连续白扫）。变体 pattern 靠
	// search_code 的 recordSearchRepeat 熔断兜底（拦完全相同参数）。
	const _FALLBACK_NEG_TTL_MS = 60_000;
	const _fallbackNegCache = new Map<string, number>();
	const _fallbackGrepWorkspaceCached = async (
		pattern: string,
		fileGlob: string | undefined,
		limit: number,
		contextLines: number,
		agentId?: string,
	): Promise<string | null> => {
		const key = `${pattern}${fileGlob ?? ''}${contextLines}`;
		const negTs = _fallbackNegCache.get(key);
		if (negTs !== undefined && Date.now() - negTs < _FALLBACK_NEG_TTL_MS) {
			ctx.logService.info(`[BuiltinTools] [CBSearch][trace] fallback skipped (negative cache): pattern="${pattern.slice(0, 60)}"`);
			return null;
		}
		const out = await _fallbackGrepWorkspace(pattern, fileGlob, limit, contextLines, agentId);
		if (out === null) {
			_fallbackNegCache.set(key, Date.now());
			// 简单容量保护：超 200 条清空（TTL 短，正常不会累积）
			if (_fallbackNegCache.size > 200) { _fallbackNegCache.clear(); }
		}
		return out;
	};
	// ── search_files (ripgrep 文件系统搜索；与 search_code 并列) ──────
	ctx.register({
		definition: {
			name: 'search_files',
			description: 'Search file contents or find files by name. Use this instead of grep/rg/find/ls in terminal. Ripgrep-backed, faster than shell equivalents.\n\nContent search (mode=\'content\', default): regex search inside files — matching lines with line numbers. Use mode=\'files_with_matches\' for paths-only, mode=\'count\' for per-file counts.\n\nFile search (mode=\'files\'): find files by glob pattern (e.g., \'*.py\', \'*config*\'). Also use this instead of ls — results sorted by modification time.\n\nFor code-structure questions (callers, definitions, dependencies, class hierarchy), use search_graph or query_graph instead — the code knowledge graph understands code relationships, not just text patterns.',
			inputSchema: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'REQUIRED. The actual text to find: a regex for content search, or a glob (e.g., \'*.py\', \'*config*\') when mode=\'files\'. The search term ALWAYS goes here, never in `mode`.' },
					mode: { type: 'string', enum: ['content', 'files_with_matches', 'count', 'files'], default: 'content', description: 'What to do with `pattern` (this is the MODE selector, never the search term):\n- \'content\' (default): regex-search inside files, return matching lines with line numbers\n- \'files_with_matches\': regex-search inside files, return only the file paths that contain a match\n- \'count\': regex-search inside files, return match counts per file\n- \'files\': treat `pattern` as a filename glob and find files by NAME (use this instead of ls; sorted by modification time)' },
					path: { type: 'string', description: 'Directory or file to search in (default: current working directory)', default: '.' },
					file_glob: { type: 'string', description: 'Filter which files to search by glob (e.g., \'*.py\' to only search Python files). Applies to content/files_with_matches/count modes.' },
					limit: { type: 'integer', description: 'Maximum number of results to return (default: 50)', default: 50 },
					offset: { type: 'integer', description: 'Skip first N results for pagination (default: 0)', default: 0 },
					context: { type: 'integer', description: 'Number of context lines before and after each match (content mode only)', default: 0 },
				},
			// schema 强制 pattern：coerceOrReject 派发前即校验，模型漏参被就地拒绝
			// 并重生成（不会跑到 handler 抛错后被 guard 空转）。
			required: ['pattern'],
			},
			category: 'codebase',
			source: ctx.id,
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			// P2（2026-07-29，kimi zod-only）：旧 target/output_mode/query 别名恢复
			// 已移除——schema 单一 mode + required pattern 是唯一契约。
			const rawPattern = String(args['pattern'] || '');

			let mode = args['mode'] ? String(args['mode']) : 'content';
			// 归一未知/非法 mode → content
			if (!['content', 'files_with_matches', 'count', 'files'].includes(mode)) { mode = 'content'; }

			const pattern = rawPattern;
			if (!pattern) { throw new Error('search_files requires "pattern" (the search term). Example — content: search_files({pattern:"parseConfig"}); find files: search_files({mode:"files", pattern:"*.ts"}). Do NOT put the search term in `mode`.'); }

			// 内部两分支所需派生值（target: files vs content；outputMode: searchContent 词汇）
			const target = mode === 'files' ? 'files' : 'content';
			const outputMode = mode === 'files_with_matches' ? 'files_only' : mode === 'count' ? 'count' : 'content';

			const searchPath = String(args['path'] || '.');
			// file_glob 同样走归一化：LLM 可能用 `|` 分隔多个文件名（ripgrep glob 的
			// alternation 是 `{a,b}`，`|` 是字面字符 → 0 命中，日志 1787209228496）。
			const fileGlob = args['file_glob'] ? normalizeFileGlobForSearch(String(args['file_glob'])) : undefined;
			const limit = Math.min(Math.max(Number(args['limit'] ?? 50), 1), 200);
			const offset = Math.max(Number(args['offset'] ?? 0), 0);
			const contextLines = Math.min(Math.max(Number(args['context'] ?? 0), 0), 10);

			// ── 重复搜索熔断 ──
			const repeat = ctx.searchHelpers.recordSearchRepeat(agentId, pattern, target, searchPath, fileGlob, limit, offset);
			if (repeat.blocked) {
				return [{ type: 'text', text: repeat.blocked }];
			}

			// 读操作：仅解析相对路径为绝对路径，不触发沙箱判定
			const resolvedPath = await ctx.resolveAndCheckWorkspacePath(agentId, searchPath, false);

		let result: string;
		if (target === 'files') {
			const glob = ctx.searchHelpers.normalizeFileSearchGlob(pattern);
			// 2026-07-26（P1b，日志 1785078531442）：索引清单快路径——文件名 glob 直接
			// 匹配图谱已索引文件清单（主进程 DISTINCT SQL，亚秒级），命中充足直接返回，
			// 免去全 folder ripgrep 扫描（UE5EA 双 folder 实测 17.5s）。命中稀少时
			// 可能索引未覆盖（如部分文件跳过索引）→ 回落 ripgrep 保持完备性。
			let indexedResult: string | undefined;
			try {
				const indexedFiles = await ctx.codebaseGraphService.listIndexedFilePaths();
				if (indexedFiles.length > 0) {
					const re = _globToRegex(glob);
					const roots = ctx.codebaseGraphService.getProjectRoots();
					const matched: string[] = [];
					for (const f of indexedFiles) {
						if (re && !re.test(f.filePath)) { continue; }
						const root = roots[f.project];
						matched.push(root
							? `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/${f.filePath}`
							: f.filePath);
					}
					// 2026-07-27（日志 1785118063787）：阈值从 ≥10 降为 ≥1——精确文件名
					// 搜索（GarbageCollection.cpp 全图仅 1-2 个）是 files 查询主流形态，
					// ≥10 阈值使其永远回落 ripgrep 9s，快路径形同虚设。matched=0 才
					// 回落（索引未覆盖时保完备）；footer 注明索引范围防误读。
					if (matched.length >= 1) {
						const page = matched.slice(offset, offset + limit);
						const footer = offset + limit < matched.length
							? `\n\n[共 ${matched.length} 个文件（索引快路径，仅含已索引文件——新文件/未索引目录如 Intermediate 可能未覆盖），已显示 ${page.length}/${matched.length}。使用 offset=${offset + limit} 查看剩余，或用更精确的 pattern/file_glob 缩小范围。]`
							: `\n\n[共 ${matched.length} 个文件（索引快路径，仅含已索引文件——新文件/未索引目录如 Intermediate 可能未覆盖）]`;
						indexedResult = (page.join('\n') || '(no matching files)') + footer;
					}
				}
			} catch (err) {
				ctx.logService.warn(`[BuiltinTools] search_files indexed fast-path failed, fallback to ripgrep: ${err}`);
			}
			result = indexedResult ?? await ctx.searchHelpers.searchFilesByGlob(resolvedPath, glob, limit, offset, _signal);
		} else {
				result = await ctx.searchHelpers.searchContent(
					resolvedPath, pattern, fileGlob, limit, offset, outputMode, contextLines, _signal,
				);
			}

			// 结果后处理：大小截断 → 脱敏 → densify
		result = ctx.searchHelpers.enforceSearchSize(result);
		result = redactSecrets(result);
		if (!(target === 'files' || outputMode === 'files_only' || outputMode === 'count')) {
			// content 模式 >=5 条匹配时自动切换到路径分组紧凑格式
			result = ctx.searchHelpers.densifySearchOutput(result);
		}
		return [{ type: 'text', text: result }];
		},
	});

	ctx.register({
		definition: {
			name: 'search_code',
			description: 'Regular-expression (regex) text search over the codebase, backed by ripgrep (streams the filesystem — fast even on huge repos). ' +
				'Use it for raw string/pattern matching inside file bodies. For code STRUCTURE questions (callers, definitions, dependencies, call chains, class hierarchy) prefer search_graph / query_graph / trace_path — they understand code relationships, not just text. ' +
				'Query tips: multi-word "foo bar" auto-becomes foo.*bar; pipe alternation "SymA|SymB|SymC" matches any of them — use it to probe several candidates in ONE call instead of repeating searches. ' +
				// 2026-08-22（日志 1787363991734）：模型 7 次 search_code 想在
				// @comfyorg/litegraph bundle 里找符号全部 0 命中（node_modules 被
				// .gitignore + 默认 exclude 两层挡住），最后退化为 execute_code 跑 python
				// 手工扫文件。放行已实现（searchScopeOverride），但必须在 description 里
				// 说出来，否则模型不知道这条路可走。
				'Dependency sources ARE searchable: set path_filter to the package directory (e.g. node_modules/@scope/pkg/dist) and ' +
				'default ignore rules for that directory are lifted automatically — never hand-roll a script to read a bundle. ' +
				'Output may be truncated, so use targeted queries. Modes: compact (default, matching lines, token-efficient), full (with surrounding source), files (paths only).',
			inputSchema: {
				type: 'object',
				properties: {
				query: { type: 'string', description: 'Regex search pattern. Multi-word queries auto-convert to regex (foo bar → foo.*bar); pipe alternation SymA|SymB matches either.' },
				mode: { type: 'string', enum: ['compact', 'full', 'files'], default: 'compact', description: 'compact: matching lines with line numbers (default). full: with surrounding source. files: just file paths.' },
				filePattern: { type: 'string', description: 'File glob to RESTRICT which files are searched, passed straight to ripgrep (e.g. **/CoreUObject/**/*.cpp, src/**/*.ts). MUST be a specific path fragment — a bare extension wildcard like "*.cpp" does NOT narrow anything in a large multi-project repo (it matches tens of thousands of files).' },
				path_filter: { type: 'string', description: 'Directory or file to search in — a search ROOT (like `rg <path>`), resolved against each workspace folder when relative (e.g. Engine/Source/Runtime/CoreUObject, f:/.../CoreUObject, GarbageCollection.cpp). May also be a glob containing * (e.g. **/CoreUObject/**). A non-existent path returns an explicit error, NOT "no matches". To filter by file name/type instead, use filePattern. Accepts `path` as an alias (same meaning as search_files\' `path`). ALWAYS set this on a large multi-project repo — an unscoped search streams the entire tree.' },
					context: { type: 'number', description: 'Lines of context before and after each match (like grep -C). Compact/full modes.' },
					regex: { type: 'boolean', default: false, description: 'Treat query as a raw regex. When false (default), a plain literal is escaped and matched literally. Multi-word / pipe-alternation queries auto-enable regex.' },
				project: { type: 'string', description: 'Project name to scope the search to a single indexed folder (optional, defaults to ALL workspace folders). Use list_projects to discover names — e.g. "UE5EA" to search only engine sources in a multi-folder workspace.' },
				limit: { type: 'number', description: 'Max results (default 30, capped at 100)' },
				offset: { type: 'number', description: 'Skip the first N results for pagination (default 0). Increment by `limit` and re-call when results are truncated. Mirrors search_graph\'s offset/limit pagination so the two code-search tools share the same paging API.' },
			},
			required: ['query'],
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			// ── 2026-07-27 重构（复刻 continue 的 grep_search 机制）──────────────
			// 旧实现走「图谱内容 grep + 20s deadline + 复杂绝对路径提取 + 双 fallback」，
			// 在 UE5EA(33186 文件) 上大量部分覆盖撞 deadline（9-21s/次，subagent 超时主因）。
			// continue 的 grep_search = 纯 ripgrep 扫盘（流式、亚秒级）+ filePattern 前置
			// includePattern（非后置假缩放）+ 正则校验回传 warning + 硬截断 refine 引导。
			// 本 handler 改用 ctx.searchHelpers.searchContent（同款 ripgrep 引擎，已带
			// regex 失败回退纯文本 + signal 取消），彻底移除图谱 deadline grep 与 fallback。
		// P2（2026-07-29，kimi zod-only）：别名恢复已移除——schema 是唯一契约，
		// 发错参数名在 coerce 层即被拒（missing required 带正确参数名）。
		//
		// ★ 2026-08-20 修正上述判断：coerce 层只拒「缺 required」，对【多余的未知参数】
		// 不报错也不告警 → 静默丢弃。而 search_files 的搜索根参数叫 `path`、search_code
		// 叫 `path_filter`，模型极易混用：日志 1787214724132 实证 44 次 search_code 里
		// 40 次 root=- （零收窄、全库 rg），模型 thinking 中三次抱怨「path 参数仍被忽略」
		// 却无法自救（没有任何错误回传）。故为 `path` 恢复别名映射，与 search_files 对齐。

		const rawQuery = String(args['query'] ?? '');
		if (!rawQuery) { return text('search_code requires "query" (the search term). Example: search_code({query:"FooBar"}) or search_code({query:"SymA|SymB", mode:"files"}).'); }
			let mode = (args['mode'] as string | undefined) || 'compact';
			if (!['compact', 'full', 'files'].includes(mode)) { mode = 'compact'; }
		const filePattern = args['filePattern'] as string | undefined;
		// ── filePattern 归一化（2026-07-28，日志 1785231958842）：裸文件名/裸扩展
		// glob（*.cpp、GarbageCollection.cpp）无 `/` 时补 `**/`，否则引擎 _globToRegex
		// 中 `*` 不跨目录，只匹配各搜索根直属文件→嵌套恒 0 命中（log 中 8 次空）。
		const normalizedFilePattern = filePattern ? normalizeFileGlobForSearch(filePattern) : undefined;
		// `path` 别名：与 search_files 参数名统一，避免混用导致静默全库扫（见上方注释）。
		const _pathAliasRaw = typeof args['path'] === 'string' ? (args['path'] as string) : undefined;
		const _pathFilterRaw = typeof args['path_filter'] === 'string' ? (args['path_filter'] as string) : undefined;
		const pathFilter = _pathFilterRaw ?? _pathAliasRaw;
		if (!_pathFilterRaw && _pathAliasRaw) {
			ctx.logService.info(`[BuiltinTools][CBSearch] search_code: accepted "path" as alias for "path_filter" (value="${_pathAliasRaw}") — model used search_files' parameter name.`);
		}
			const contextLines = Math.min(Math.max((args['context'] as number | undefined) ?? 0, 0), 10);
		const limit = Math.min(Math.max((args['limit'] as number | undefined) ?? 30, 1), 100);
		const offset = Math.min(Math.max((args['offset'] as number | undefined) ?? 0, 0), 1000);
		const scopedProject = (args['project'] as string | undefined) ?? undefined;

			// ── query 语义：字面 vs 正则（对齐 continue looksLikeLiteralSearch）──
			let useRegex = (args['regex'] as boolean | undefined) ?? false;
			let searchQuery = rawQuery;
			// 多词 → foo.*bar；无空格的 A|B → alternation（代码搜索几乎总是 OR 意图）
			if (!useRegex && rawQuery.includes(' ')) {
				searchQuery = rawQuery.split(/\s+/).filter(Boolean).join('.*');
				useRegex = true;
			} else if (!useRegex && rawQuery.includes('|') && !rawQuery.includes(' ')) {
				useRegex = true;
			}
			// 显式/字面：非正则时转义字面量（ripgrep isRegExp=true，故字面量须先转义）
			let regexWarning: string | undefined;
			if (!useRegex) {
				searchQuery = escapeLiteralForRegex(searchQuery);
			} else {
				// 正则：过 continue 式校验/净化，warning 回传给模型
				const prepared = prepareQueryForRipgrep(searchQuery);
				searchQuery = prepared.query;
				regexWarning = prepared.warning;
			}

		// 重复搜索熔断（对齐 search_files）：相同参数累计 ≥3 次直接拦截。
		// target 传固定值而非 mode（2026-08-20，日志 1787214724132）：search_code 的
		// mode（compact/full/files）只改【输出格式】、不改 rg 结果集，旧实现把它塞进
		// 签名 → 模型对 "LoadImage" 先 mode=files 搜 2 次、再 mode=compact 搜 2 次，
		// 4 次全部放行（每次换 mode 都算新签名）。
		const repeat = ctx.searchHelpers.recordSearchRepeat(agentId, searchQuery, 'search_code', normalizedFilePattern ?? pathFilter ?? '', undefined, limit, offset);
		if (repeat.blocked) { return text(repeat.blocked); }

		// ── P0 超大 roots 预检（2026-08-18，日志 1787038807642：60s×6 超时）──────
		// 未带任何收窄参数时，对「UE 形态的巨型根」直接拒绝执行并返回引导：全库 rg 是
		// 分钟级（UE 引擎源码数 GB）→ 60s 硬超时反复烧光预算。一次往返让模型带上
		// path_filter/project 重发——优于超时失败。
		//
		// 2026-08-19：原门槛是 `folders.length >= 2`，但搜索根已收敛为「Agent Studio
		// active workspace 单根」（getSearchFolders），多 folder 情形几乎不再出现 →
		// 预检形同失效。且真实痛点已变成「单 root 指向多项目父目录」（如
		// F:\GR_qiuzijian_main 内含 S1Game/UE5EA）——_isUnrealRoot 能识别该父目录形态。
		// 故改为：只要搜索根本身是 UE 形态就拦，不再看 folder 数量。
		if (!pathFilter && !normalizedFilePattern && !scopedProject) {
			const allFolders = (await getSearchFolders(agentId)).map(f => f.uri.fsPath);
			if (allFolders.length >= 1) {
				const unrealFlags = await Promise.all(allFolders.map(f => ctx.searchHelpers.isUnrealRoot(f).catch(() => false)));
				if (unrealFlags.some(Boolean)) {
					return text(
						'search_code: this call would scan the ENTIRE search root (' +
						allFolders.join(', ') + ') — a large Unreal-engine / multi-project tree, ' +
						'so it would hit the 60s timeout. ' +
						'Re-send with ONE of: path_filter (a subdirectory, e.g. "S1Game/Source" or "Engine/Source/Runtime/CoreUObject"), ' +
						'filePattern (a specific path-fragment glob, NOT a bare "*.cpp"), ' +
						'or project=<folder-name> to pick a single indexed root. ' +
						'For code-structure questions prefer search_graph (indexed, no filesystem scan).'
					);
				}
			}
		}

		// ── P1（2026-07-29，对齐 kimi Grep / search_files 的搜索根模型）─────────
		// path_filter = 搜索根（目录或文件路径），不再塞进 includePattern（glob 语义）。
		// 旧 include-glob 路线须处理 相对/绝对 × 文件/目录 四象限，已致 4 起事故
		//（1785134772329 绝对文件、1785224874547 绝对目录、1785228894680 根目录名首段、
		// 1785231958842 裸 glob）。分流：含 `*` → includePattern glob（先清洗 **/ ./ 前缀与
		// 根目录名首段）；否则 stat 判定——文件→单文件 grep、目录→搜索根；全候选不存在时，
		// 带扩展名的按裸文件名 glob（**/name）兜底，目录形态才显式报错（≠ no matches）。
		let includeGlob: string | undefined = normalizedFilePattern;
		let explicitSearchRoot: string | undefined;
		if (pathFilter && !normalizedFilePattern) {
			const rootDirNames = (await getSearchFolders(agentId))
				.map(f => f.uri.fsPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '');
			const pf = normalizeSearchPathFilter(pathFilter, rootDirNames);
			if (pf.includes('*')) {
				includeGlob = pf;
			} else if (pf) {
				const candidates = searchRootCandidates(
					pf,
					(await getSearchFolders(agentId)).map(f => f.uri.fsPath),
				);
				if (candidates.length === 0) {
					// 无 workspace folder 时的兜底解析（沙箱校验）；失败即"不存在"
					try {
						candidates.push(await ctx.resolveAndCheckWorkspacePath(agentId, pf, false));
					} catch { /* fall through → 显式不存在报错 */ }
				}
				for (const c of candidates) {
					try {
						await ctx.fileService.stat(URI.file(c));
						explicitSearchRoot = c;
						break;
					} catch { /* 尝试下一个候选 */ }
				}
				if (!explicitSearchRoot) {
					const isAbs = /^[a-zA-Z]:\//.test(pf) || pf.startsWith('/');
					if (!isAbs && /\.[A-Za-z0-9]{1,10}$/.test(pf)) {
						// 相对裸文件名（GarbageCollection.cpp）：模型意图是按文件名过滤
						// （绝对路径不兜底——`**/f:/...` 是畸形 glob，事故 1785134772329）
						includeGlob = `**/${pf}`;
					} else {
						return text(`search_code: path_filter 路径不存在: ${pathFilter}（已按搜索根解析并检查所有 workspace 根）。\npath_filter 是搜索根（目录或文件路径）；按文件名过滤请改用 filePattern（glob，如 **/*.cpp）；确认路径存在后重试，或去掉 path_filter 全库搜索。`);
					}
				}
			}
			// pf 为空（裸根名）→ 不过滤
		}

			// ripgrep outputMode 映射：files → files_only；compact/full → content（带行号匹配行）
			const outputMode = mode === 'files' ? 'files_only' : 'content';
			// full 模式多给几行上下文（对齐旧 full 语义：匹配点前后源码）
			const effContext = mode === 'full' ? Math.max(contextLines, 3) : contextLines;

		// ── project → 单 folder scope；否则跨【所有】workspace folders 搜索并合并 ──
		// 事故（日志 1785151024653）：project 未指定时旧实现只搜 resolveAndCheckWorkspacePath('.')
		// 解析出的【单个】路径（多根工作区下恒为第一个允许根），导致像 UE5EA 这类第二/第三个
		// workspace folder 完全搜不到——112 次 search_code 里 51 次 "(no matches)"，命中的
		// 引擎源码符号全靠 search_files 的索引快路径（自带跨 project 绝对路径）意外补位。
		// 修复：project=ALL 时遍历 getSearchFolders() 逐个搜索，
		// 结果按 folder 分段合并（与 _fallbackGrepWorkspace 相同的多 folder 语义）。
		let searchRoots: { label: string; path: string }[];
		if (explicitSearchRoot) {
			// path_filter 搜索根优先（kimi：path overrides workspaceDir）。文件或目录均可——
			// searchContent 内部对文件路径走 fileService 单文件 grep。
			const dirName = explicitSearchRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || explicitSearchRoot;
			searchRoots = [{ label: dirName, path: explicitSearchRoot }];
		} else if (scopedProject) {
				const roots = ctx.codebaseGraphService.getProjectRoots();
				const root = roots[scopedProject];
				const resolvedPath = await ctx.resolveAndCheckWorkspacePath(agentId, root ?? '.', false);
				searchRoots = [{ label: scopedProject, path: resolvedPath }];
			} else {
				const folders = await getSearchFolders(agentId);
				if (folders.length > 0) {
					// 使用目录名（fsPath 末段）作 label，与 _fallbackGrepWorkspace 的命名约定一致；
					// 不用 f.name（workspace folder 显示名，可能为 "VsSaros_S1Game" 这样的自定义名称）。
					searchRoots = folders.map(f => {
						const dirName = f.uri.fsPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || f.uri.fsPath;
						return { label: dirName, path: f.uri.fsPath };
					});
				} else {
					searchRoots = [{ label: 'workspace', path: await ctx.resolveAndCheckWorkspacePath(agentId, '.', false) }];
				}
			}

			ctx.logService.info(`[BuiltinTools] [CBSearch][trace] search_code(ripgrep) query="${rawQuery.slice(0, 60)}" searchQuery="${searchQuery.slice(0, 80)}" regex=${useRegex} mode=${mode} include=${includeGlob ?? '-'} root=${explicitSearchRoot ?? '-'} project=${scopedProject ?? 'ALL'} roots=[${searchRoots.map(r => r.label).join(', ')}]`);

			const perRootResults: string[] = [];
			let anyMatches = false;
			for (const root of searchRoots) {
				let r = await ctx.searchHelpers.searchContent(
					root.path, searchQuery, includeGlob, limit, offset, outputMode, effContext, _signal,
				);
				r = redactSecrets(r);
				if (outputMode === 'content' && mode !== 'full') {
					r = ctx.searchHelpers.densifySearchOutput(r);
				}
				const isEmpty = /^\(no matches\)$/.test(r.trim());
				if (!isEmpty) { anyMatches = true; }
				// 单 root（project 指定）时不加分段标题，保持旧输出格式；多 root 才分段标注来源
				perRootResults.push(searchRoots.length > 1 ? `## [${root.label}]\n${r}` : r);
			}
		let result = anyMatches
			? perRootResults.join('\n\n')
			: '(no matches)';
	// 空命中分「过滤问题」vs「符号问题」给不同引导（2026-07-28，日志 1785231958842）：
		// 空命中引导（P3 三合一）：①include 非空且全根 no-match → 过滤可能过严
		//（日志 1785228894680：同一 include 重写正则重试 12 次）；②无过滤仍 0 命中 →
		// 符号多半幻觉/拼写错误，先 search_files/search_graph 验证；③连续空命中达阈值 →
		// 强引导换 search_graph（exact-repeat 熔断拦不住换参重试，日志 1785231958842 子代理
		// 434s 烧光预算）。单次 searchOutcomeHint 调用覆盖三分支。
		const _emptyStreak = ctx.searchHelpers.recordSearchCodeEmptyStreak(agentId, !anyMatches);
		if (!anyMatches) {
			// 降级态（ripgrep 不可用）如实提示：不得让模型以为 include 过滤以 rg 语义生效。
			// 末参回显实际搜索根 + `.worktrees` 排除声明（2026-08-20，日志 1787217670299）。
			result += searchOutcomeHint(
				includeGlob, _emptyStreak.streak, _emptyStreak.shouldGuide,
				ctx.searchHelpers.isContentSearchDegraded(),
				searchRoots.map(r => r.label),
			);
		}

		// 同一「搜索意图」换参重搜引导（2026-08-20，日志 1787211923566）：
		// exact-repeat 熔断只拦相同参数、empty-streak 只拦连续 0 命中，而实测模型对
		// 同一符号换 root/换正则搜 6 次且次次有命中，两道闸门全部绕过 → 跑满 50/50
		// 迭代上限、输出大量近似重复文字。此处按归一化意图指纹计数并回传引导，
		// 促其改用 search_graph（结构关系）或直接读已定位的文件。
		const _intentRepeat = ctx.searchHelpers.recordSearchIntentRepeat(agentId, rawQuery);
		if (_intentRepeat.shouldGuide) {
			result += `\n\n[search-loop] You have searched for this same target ${_intentRepeat.count} times with different parameters. ` +
				`Repeating the search is unlikely to reveal anything new — change approach instead:\n` +
				`- Use \`search_graph\` to follow structural relations (callers/callees/definitions) rather than text matching.\n` +
				`- If the symbol was already located above, open that file with \`file_read\` and reason from its contents.\n` +
				`- If it genuinely does not exist in this workspace, state that conclusion and move on.`;
		}

		// 结果后处理：大小截断兜底（densify/redact 已按 root 分别做过）
		result = ctx.searchHelpers.enforceSearchSize(result);

		// Truncation warning（对齐 continue：达上限即引导 refine）
		const parts: string[] = [result];
		if (regexWarning) { parts.push(`[regex] ${regexWarning}`); }
		return text(parts.join('\n\n'));
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
					scope: { type: 'string', description: 'Directory prefix to limit change detection (e.g. src/app). Only changed files under this path are analyzed.' },
					depth: { type: 'number', default: 5, description: 'Max BFS hops for downstream impact propagation (default 5).' },
				},
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			if (!await ensureGraph()) { return noGraphGuidance('detect_changes'); }
			try {
				const result = await ctx.codebaseGraphService.detectChanges({
					since: args['since'] as string | undefined,
					baseBranch: args['baseBranch'] as string | undefined,
					impactAnalysis: args['impactAnalysis'] as boolean | undefined,
					scope: args['scope'] as string | undefined,
					depth: args['depth'] as number | undefined,
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
			description: 'Ingest runtime traces into the codebase graph to enrich runtime call edges. ' +
				'Accepts either OpenTelemetry OTLP JSON (resourceSpans / flat span array) or a simplified ' +
				'[{caller, callee, count}] array (P2 lightweight format).',
			inputSchema: {
				type: 'object',
				properties: {
					otlp_json: {
						type: 'string',
						description: 'OTLP JSON trace data, OR a simplified JSON array ' +
							'[{"caller":"foo","callee":"bar","count":42,"edgeType":"CALLS"}]. ' +
							'Arrays containing caller/callee (and no traceId/spanId) are auto-detected as the simplified format.',
					},
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

			const folders = await getSearchFolders();
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

	// ── export_artifact (P2-#3) ─────────────────────────────────────
	// Expose GraphPersistence.exportArtifact: dump current graph as a portable
	// compressed artifact (graph.db.zst + artifact.json) for team sharing / Git branch.
	ctx.register({
		definition: {
			name: 'export_artifact',
			description: 'Export the current codebase graph as a portable compressed artifact (.codebase-memory/graph.db.zst + artifact.json) for team sharing or Git branching. ' +
				'Defaults to the workspace .codebase-memory directory. Run index_repository first if no graph is loaded. ' +
				'Returns the artifact size, node count, and edge count.',
			inputSchema: {
				type: 'object',
				properties: {
					target_path: { type: 'string', description: 'Destination path for graph.db.zst (optional, defaults to {workspace}/.codebase-memory/graph.db.zst)' },
					slim: { type: 'boolean', description: 'Slim tier (default true): exclude rebuildable BM25 index and 3D layout for a smaller artifact; BM25 is rebuilt automatically on import. Set false for full-fidelity export.', default: true },
				},
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			if (!await ensureGraph()) {
				return noGraphGuidance('export_artifact');
			}
			const overridePath = args['target_path'] as string | undefined;
			let targetPath = overridePath;
			if (!targetPath) {
				const folders = await getSearchFolders();
				if (folders.length === 0) {
					return text('export_artifact error: no workspace folder open and no target_path provided');
				}
				targetPath = URI.joinPath(URI.file(folders[0].uri.fsPath), '.codebase-memory', 'graph.db.zst').fsPath;
			}
			try {
				const slim = args['slim'] === false ? false : true;
				const result = await ctx.codebaseGraphService.exportArtifact(targetPath, { slim });
				return json({ success: true, path: targetPath, slim, ...result });
			} catch (err: any) {
				return text(`export_artifact error: ${err?.message || err}`);
			}
		},
	});

	// ── import_artifact (P2-#3) ─────────────────────────────────────
	// Expose GraphPersistence.importArtifact: load a portable artifact and replace the current graph.
	ctx.register({
		definition: {
			name: 'import_artifact',
			description: 'Import a codebase graph from a portable compressed artifact (graph.db.zst / graph.db.gz / graph.json) and replace the current in-memory graph. ' +
				'Use after a teammate shares an artifact via Git, or to restore a previously exported snapshot. ' +
				'Returns whether the import succeeded.',
			inputSchema: {
				type: 'object',
				properties: {
					source_path: { type: 'string', description: 'Path to the artifact to import (graph.db.zst / graph.db.gz / graph.json). Defaults to {workspace}/.codebase-memory/graph.db.zst' },
				},
			},
			category: 'codebase',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>) => {
			const overridePath = args['source_path'] as string | undefined;
			let sourcePath = overridePath;
			if (!sourcePath) {
				const folders = await getSearchFolders();
				if (folders.length === 0) {
					return text('import_artifact error: no workspace folder open and no source_path provided');
				}
				sourcePath = URI.joinPath(URI.file(folders[0].uri.fsPath), '.codebase-memory', 'graph.db.zst').fsPath;
			}
			try {
				const ok = await ctx.codebaseGraphService.importArtifact(sourcePath);
				if (!ok) {
					return text(`import_artifact: failed to load artifact at ${sourcePath} (file missing, unrecognized format, or failed integrity check)`);
				}
				const status = ctx.codebaseGraphService.getIndexStatus();
				return json({ success: true, path: sourcePath, nodeCount: status.nodeCount, edgeCount: status.edgeCount });
			} catch (err: any) {
				return text(`import_artifact error: ${err?.message || err}`);
			}
		},
	});

	ctx.logService.info('[BuiltinTools] _registerCodebaseTools: 17 codebase tools registered (index_repository, index_status, check_index_coverage, list_projects, delete_project, search_graph, query_graph, get_architecture, get_code_snippet, get_graph_schema, trace_path, grep, detect_changes, ingest_traces, manage_adr, export_artifact, import_artifact)');
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
				project: r.node.project,
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
