/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 搜索相关 helper 集合 —— 从 `builtinToolProvider.ts` 抽取，降低主文件体积。
 *
 * 该集群高度内聚，仅依赖三个平台服务（IFileService / ISearchService / ILogService）
 * 与自身状态（ripgrep 可用性门控、重复搜索熔断计数），不触碰主类的其它 20+ 服务。
 * 外部调用方（coreTools 的 search_files / search_content 注册器）通过实例方法访问。
 */

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { ISearchService, QueryType, type ITextQuery, type IFileQuery, type ISearchComplete } from '../../../../../../workbench/services/search/common/search.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { advanceSearchCodeEmptyStreak, searchCodeEmptyStreakThresholdFor } from './pathFilterNormalize.js';

export class SearchHelpers {
	// 重复搜索熔断：连续相同搜索计数阈值（对齐 Hermes-Agent）
	private static readonly SEARCH_REPEAT_WARN = 3;
	private static readonly SEARCH_REPEAT_BLOCK = 4;
	// search_code 连续空结果引导阈值：连击达其倍数即提示转 search_graph
	//（日志 1785231958842：模型对同一目标反复换符号猜测，exact-repeat 熔断拦不住——
	// 每次 query 都不同，故按「连续 0 命中」连击而非「相同参数」计数）。
	// 阈值按 agentId 类型由 searchCodeEmptyStreakThresholdFor 决定（子代理更敏感）。
	// 结果大小上限（对齐 Hermes max_result_size_chars）与单条匹配截断长度
	private static readonly SEARCH_MAX_RESULT_CHARS = 100_000;
	private static readonly SEARCH_LINE_MAX_CHARS = 500;

	/**
	 * 搜索工具默认排除目录（`search_files` / `search_code` 两路统一）。
	 *
	 * 覆盖三类噪声：
	 *  - 通用构建/依赖产物：node_modules / .git / build / dist / out / .next 等
	 *  - UE (Unreal Engine) 项目产物：Intermediate / Saved / Binaries / Build / DerivedDataCache
	 *    事故 1785143114444：code-explorer 子代理 search_files 9220ms outlier 全部由 UE 构建产物贡献
	 *  - 缓存/临时：.cache / .parcel-cache / .turbo 等
	 *
	 * 与 codebaseMemoryMcpService.DEFAULT_EXCLUDE_DIRS 语义对齐（后者服务于图谱索引，
	 * 本处服务于运行时 grep，用途独立但排除项应尽量重合，避免图谱不含 / grep 却搜到的
	 * 一致性错位）。ripgrep 侧通过 IExpression 生效；Node-walk fallback 通过
	 * NOISE_DIR_NAMES 名字集合达成等价效果。
	 */
	private static readonly DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
		// 通用构建/依赖
		'**/node_modules/**', '**/.git/**', '**/out/**', '**/dist/**',
		'**/build/**', '**/.next/**', '**/.cache/**', '**/coverage/**',
		'**/__pycache__/**', '**/target/**', '**/.gradle/**', '**/bin/**', '**/obj/**',
		'**/.pnpm-store/**', '**/.yarn/**', '**/.parcel-cache/**', '**/.turbo/**',
		'**/.nuxt/**', '**/.svelte-kit/**', '**/.angular/**',
		'**/venv/**', '**/.venv/**',
		// UE (Unreal) 构建产物：事故 1785143114444
		'**/Intermediate/**', '**/Saved/**', '**/Binaries/**', '**/DerivedDataCache/**',
		// out-build/out-test/out-vscode（Sarosis 自身仓库）
		'**/out-build/**', '**/out-test/**', '**/out-vscode/**',
	];

	/** IExpression 形态，惰性构造一次复用。 */
	private static _defaultExcludeExprCache: Readonly<Record<string, boolean>> | undefined;
	private static _defaultExcludeExpr(): Readonly<Record<string, boolean>> {
		if (!SearchHelpers._defaultExcludeExprCache) {
			const expr: Record<string, boolean> = {};
			for (const g of SearchHelpers.DEFAULT_EXCLUDE_GLOBS) { expr[g] = true; }
			SearchHelpers._defaultExcludeExprCache = expr;
		}
		return SearchHelpers._defaultExcludeExprCache;
	}

	/** Node-walk fallback 的目录名黑名单（等价 DEFAULT_EXCLUDE_GLOBS 里的目录名部分）。 */
	private static readonly NOISE_DIR_NAMES: ReadonlySet<string> = new Set([
		// 通用
		'node_modules', '.git', 'out', 'dist', 'build', '.build',
		'.next', '.cache', '.vscode-test', 'coverage', '__pycache__',
		'target', '.gradle', '.idea', 'bin', 'obj', '.pnpm-store',
		'.yarn', '.parcel-cache', '.turbo', '.nuxt', '.svelte-kit',
		'.angular', 'venv', '.venv', 'env', '.env',
		// UE (Unreal) 构建产物
		'Intermediate', 'Saved', 'Binaries', 'DerivedDataCache',
		// Sarosis 自身仓库
		'out-build', 'out-test', 'out-vscode',
	]);

	// 每个 agent 的重复搜索状态：{ 上次搜索签名, 连续次数 }
	private _searchRepeatMap = new Map<string, { key: string | null; count: number }>();
	/** search_code 连续空结果（0 matches）连击计数，按 agentId 分桶。 */
	private _searchCodeEmptyStreakMap = new Map<string, number>();

	/**
	 * ripgrep 可用性门控。VS Code 内置 `searchService` 内部 spawn ripgrep，
	 * 在某些环境下（Extension Host 进程无法 spawn 该 exe）会持续抛 ENOENT，
	 * 导致每次搜索都报错。首次失败后永久回退到 `fileService` 实现的 Node walk，
	 * 避免反复报错（回退路径功能等价，仅速度略慢）。
	 */
	private _ripgrepBroken = false;

	constructor(
		private readonly fileService: IFileService,
		private readonly searchService: ISearchService,
		private readonly logService: ILogService,
	) { }

	/**
	 * 跟踪连续相同搜索，对齐 Hermes-Agent 的 repeated-search guard。
	 * 签名包含分页参数（limit/offset），因此合法翻页不会触发熔断。
	 * 连续 ≥3 次返回 warning，连续 ≥4 次返回 blocked（直接拦截，不执行 rg）。
	 */
	recordSearchRepeat(
		agentId: string | undefined, pattern: string, target: string, searchPath: string,
		fileGlob: string | undefined, limit: number, offset: number,
	): { count: number; warning?: string; blocked?: string } {
		const bucket = agentId ?? '';
		const key = JSON.stringify([pattern, target, searchPath, fileGlob ?? null, limit, offset]);
		const prev = this._searchRepeatMap.get(bucket) ?? { key: null, count: 0 };
		const count = prev.key === key ? prev.count + 1 : 1;
		this._searchRepeatMap.set(bucket, { key, count });

		if (count >= SearchHelpers.SEARCH_REPEAT_BLOCK) {
			return {
				count,
				blocked:
					`BLOCKED: 你已连续 ${count} 次发起完全相同的搜索（pattern=${pattern}, target=${target}），结果没有任何变化。` +
					`你已掌握这些信息，请停止重复搜索，转而推进任务（可调整 pattern/路径，或用 offset 翻页查看被截断的结果）。`,
			};
		}
		if (count >= SearchHelpers.SEARCH_REPEAT_WARN) {
			return {
				count,
				warning:
					`警告：你已连续 ${count} 次发起相同的搜索，结果未变化。请使用已获取的信息，避免重复搜索。`,
			};
		}
		return { count };
	}

	/**
	 * search_code 连续空结果（0 matches）连击跟踪。
	 * 与 recordSearchRepeat 互补：后者按「相同参数」计数（模型换 query 就绕过），
	 * 本方法按「连续 0 命中」计数——专门拦「同一目标反复换符号猜测」的空转
	 * （日志 1785231958842：子代理 434s 烧光预算正因 search_code 反复空命中）。
	 *
	 * @param isEmpty 本次 search_code 是否 0 命中（命中/非空时重置为 0）
	 * @returns streak 当前连击数；shouldGuide 当连击达阈值倍数时为 true（周期性提醒不刷屏）
	 */
	recordSearchCodeEmptyStreak(
		agentId: string | undefined, isEmpty: boolean,
	): { streak: number; shouldGuide: boolean } {
		const bucket = agentId ?? '';
		const result = advanceSearchCodeEmptyStreak(
			this._searchCodeEmptyStreakMap.get(bucket) ?? 0, isEmpty,
			searchCodeEmptyStreakThresholdFor(agentId),
		);
		this._searchCodeEmptyStreakMap.set(bucket, result.streak);
		return result;
	}

	/** 文件搜索裸名 glob 包裹（对齐 Hermes：不含 '/' 且不以 '*' 开头的 pattern 包成 '*pattern'）。 */
	normalizeFileSearchGlob(pattern: string): string {
		if (!pattern.includes('/') && !pattern.startsWith('*')) {
			return `*${pattern}`;
		}
		return pattern;
	}

	/** 结果大小上限兜底（对齐 Hermes max_result_size_chars），超长截断并提示。 */
	enforceSearchSize(text: string): string {
		const MAX = SearchHelpers.SEARCH_MAX_RESULT_CHARS;
		if (text.length <= MAX) { return text; }
		return text.slice(0, MAX) +
			`\n\n[Hint: 结果已超过 ${MAX} 字符上限被截断。请缩小 pattern/file_glob 范围，或使用 offset/limit 分页。`;
	}

	/**
	 * 搜索结果尾部信息（对齐 Hermes total_count + truncated hint）。
	 * 始终给出总数让模型可智能判断是否需翻页；被 limit 截断时额外给出 next offset。
	 */
	private _appendSearchFooter(
		out: string, total: number, shown: number, offset: number, limit: number, unit: 'match' | 'file',
	): string {
		if (total === 0) { return out; }
		const label = unit === 'file' ? '个文件' : '条匹配';
		if (offset + limit < total) {
			return `${out}\n\n[共 ${total} ${label}，已显示 ${shown}/${total}。使用 offset=${offset + limit} 查看剩余，或用更精确的 pattern/file_glob 缩小范围。]`;
		}
		return `${out}\n\n[共 ${total} ${label}]`;
	}

	/**
	 * 文件搜索：glob 模式匹配文件名，按修改时间排序。
	 * 优先使用 ripgrep (`rg --files -g <pattern>`)，不可用时回退 Node.js walk。
	 */
	async searchFilesByGlob(
		resolvedPath: string, pattern: string, limit: number, offset: number, signal?: AbortSignal,
	): Promise<string> {
		if (this._ripgrepBroken) {
			return this._nodeFileSearch(resolvedPath, pattern, limit, offset, signal);
		}
		try {
			const folderUri = URI.file(resolvedPath);
			const query: IFileQuery = {
				type: QueryType.File,
				filePattern: pattern,
				folderQueries: [{ folder: folderUri }],
				sortByScore: true,
				// 默认排除 node_modules / .git / build / UE Intermediate & Saved 等噪声目录
				excludePattern: { ...SearchHelpers._defaultExcludeExpr() },
			};
			const result: ISearchComplete = await this.searchService.fileSearch(query, CancellationToken.None);
			return this._formatSearchComplete(result, 'files_only', limit, offset);
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			this._noteRgBroken(reason);
			return this._nodeFileSearch(resolvedPath, pattern, limit, offset, signal);
		}
	}

	/**
	 * 内容搜索：rg 优先，回退 Node.js walk。
	 */
	private async _statOrNull(resolvedPath: string): Promise<{ isDirectory: boolean } | null> {
		try { return await this.fileService.resolve(URI.file(resolvedPath)); } catch { return null; }
	}

	async searchContent(
		resolvedPath: string, pattern: string, fileGlob: string | undefined,
		limit: number, offset: number, outputMode: string, contextLines: number,
		signal?: AbortSignal,
	): Promise<string> {
		// 单文件目标：直接走 fileService 逐行 grep，完全不依赖 ripgrep。
		// 对齐 Void 的 search_in_file（内存 model 逐行匹配，零 ripgrep 进程/二进制依赖，
		// renderer 安全）。ripgrep 仅在目录级树搜索这一快路径上保留。
		const targetStat = await this._statOrNull(resolvedPath);
		if (targetStat && !targetStat.isDirectory) {
			return this._grepSingleFile(URI.file(resolvedPath), pattern, limit, offset, signal, outputMode, contextLines);
		}
		if (this._ripgrepBroken) {
			return this._searchContentWalkFallback(resolvedPath, pattern, fileGlob, limit, offset, outputMode, signal);
		}
		try {
			const folderUri = URI.file(resolvedPath);
			const query: ITextQuery = {
				type: QueryType.Text,
				contentPattern: { pattern, isRegExp: true, isCaseSensitive: false, isWordMatch: false },
				folderQueries: [{ folder: folderUri }],
				includePattern: fileGlob ? { [fileGlob]: true } : undefined,
				// 默认排除 node_modules / .git / build / UE Intermediate & Saved 等噪声目录
				// （事故 1785143114444：9220ms outlier 由 UE Intermediate/Build 贡献）
				excludePattern: { ...SearchHelpers._defaultExcludeExpr() },
				surroundingContext: contextLines,
				maxResults: 5000,
			};
			// 2026-07-26（日志 1785078531442）：signal 接线到 textSearch——fallback
			// 全量扫描 UE5EA 级目录 30s+ 无中断手段；外部超时 AbortController 可取消。
			const cts = new CancellationTokenSource();
			const onAbort = () => cts.cancel();
			if (signal) {
				if (signal.aborted) { cts.cancel(); } else { signal.addEventListener('abort', onAbort, { once: true }); }
			}
			let result: ISearchComplete;
			try {
				result = await this.searchService.textSearch(query, cts.token);
			} finally {
				if (signal) { signal.removeEventListener('abort', onAbort); }
				cts.dispose();
			}
			return this._formatSearchComplete(result, outputMode, limit, offset);
		} catch (e) {
			// 取消（外部超时/中止）必须向上传播——不能落入 walk fallback（更慢）
			if (isCancellationError(e)) { throw e; }
			const reason = e instanceof Error ? e.message : String(e);
			// 若错误是 regex 语法问题（如 LLM 传了非法正则），回退为纯文本搜索
			if (/regex|quantifier|invalid.*pattern|unterminated|bad.*escape/i.test(reason)) {
				try {
					const plainQuery: ITextQuery = {
						type: QueryType.Text,
						contentPattern: { pattern, isRegExp: false, isCaseSensitive: false, isWordMatch: false },
						folderQueries: [{ folder: URI.file(resolvedPath) }],
						includePattern: fileGlob ? { [fileGlob]: true } : undefined,
						excludePattern: { ...SearchHelpers._defaultExcludeExpr() },
						surroundingContext: contextLines,
						maxResults: 5000,
					};
					const plainResult = await this.searchService.textSearch(plainQuery, CancellationToken.None);
					this.logService.info(`[BuiltinTools] searchContent: regex failed ("${reason}"), fell back to plain-text search`);
					return this._formatSearchComplete(plainResult, outputMode, limit, offset);
				} catch (e2) {
					// plain-text 仍然失败 → 最终回退 Node.js walk
				}
			}
			this._noteRgBroken(reason);
			return this._searchContentWalkFallback(resolvedPath, pattern, fileGlob, limit, offset, outputMode, signal);
		}
	}

	/**
	 * 判定 `searchService` 的失败是否由 ripgrep spawn 失败导致。
	 * 是则永久关闭 ripgrep 快路径（仅记一次 info，避免反复刷屏）；
	 * 否则按普通异常保留 warn 并保留 ripgrep 以便下次重试。
	 */
	private _noteRgBroken(reason: string): void {
		if (/rg\.exe|ripgrep|rgProcessError|ENOENT|spawn/i.test(reason)) {
			if (!this._ripgrepBroken) {
				this._ripgrepBroken = true;
				this.logService.info(`[BuiltinTools] ripgrep unavailable (${reason}); permanently falling back to Node.js walk for search tools`);
			}
		} else {
			this.logService.warn(`[BuiltinTools] search failed (${reason}), falling back to Node.js walk`);
		}
	}

	private async _searchContentWalkFallback(
		resolvedPath: string, pattern: string, _fileGlob: string | undefined,
		limit: number, offset: number, _outputMode: string, signal?: AbortSignal,
	): Promise<string> {
		const normalizedUri = URI.file(resolvedPath);
		const stat = await this._statOrNull(resolvedPath);
		if (stat === null) { return '(no such file or directory)'; }
		if (!stat.isDirectory) { return await this._grepSingleFile(normalizedUri, pattern, limit, offset, signal, _outputMode, 0); }
		const hits: string[] = [];
		await this._walkAndGrep(normalizedUri, pattern, hits, Math.min(limit + offset, 500), signal);
		const total = hits.length;
		const paged = hits.slice(offset, offset + limit);
		return this._appendSearchFooter(paged.join('\n') || '(no matches)', total, paged.length, offset, limit, 'match');
	}

	/**
	 * ISearchComplete → 搜索结果字符串（替代 _formatRgOutput）。
	 */
	private _formatSearchComplete(result: ISearchComplete, outputMode: string, limit: number, offset: number): string {
		const fileMatches = result.results ?? [];
		if (outputMode === 'files_only') {
			const files = fileMatches.map(m => m.resource.fsPath);
			const p = files.slice(offset, offset + limit);
			return this._appendSearchFooter(p.join('\n') || '(no matching files)', files.length, p.length, offset, limit, 'file');
		}
		if (outputMode === 'count') {
			const c = new Map<string, number>();
			for (const fm of fileMatches) { c.set(fm.resource.fsPath, fm.results?.length ?? 0); }
			const e = [...c.entries()].slice(offset, offset + limit);
			return this._appendSearchFooter(e.map(([f, n]) => `${f}: ${n} match(es)`).join('\n') || '(no matches)', c.size, e.length, offset, limit, 'file');
		}
		const matches: { file: string; line: number; text: string }[] = [];
		for (const fm of fileMatches) {
			for (const r of fm.results ?? []) {
				if ('rangeLocations' in r) {
					for (const rl of r.rangeLocations) {
						matches.push({ file: fm.resource.fsPath, line: rl.source.startLineNumber, text: r.previewText.slice(0, SearchHelpers.SEARCH_LINE_MAX_CHARS) });
					}
				}
			}
		}
		const t = matches.length;
		const p = matches.slice(offset, offset + limit);
		if (p.length === 0) { return '(no matches)'; }
		return this._appendSearchFooter(p.map(m => `${m.file}:${m.line}: ${m.text}`).join('\n'), t, p.length, offset, limit, 'match');
	}

	/**
	 * densify：路径分组紧凑格式（对齐 Hermes `to_dict(densify=True)`）。
	 * 当匹配数 >= 5 时，将 `file:line: content` 扁平列表转换为：
	 *   path/to/file1.py
	 *     10: def foo():
	 *     25: return bar
	 *   path/to/file2.py
	 *     3: import os
	 * 减少每条路径重复导致的 token 浪费。
	 *
	 * 输入格式: `file:line: content` 或 `file-line- content`（context 行）
	 */
	densifySearchOutput(out: string): string {
		const lines = out.split('\n');
		// 匹配 "file:line: content" 或 "file-line- content"
		const RE = /^(.+?)[:-](\d+)[:-]\s(.*)$/;
		const matches = lines.map(l => l.match(RE)).filter(Boolean) as RegExpMatchArray[];

		if (matches.length < 5) { return out; }

		// 按文件路径分组
		const groups = new Map<string, { sep: string; line: string; text: string }[]>();
		for (const m of matches) {
			const file = m[1];
			if (!groups.has(file)) { groups.set(file, []); }
			groups.get(file)!.push({ sep: m[0].includes('-') ? '-' : ':', line: m[2], text: m[3] });
		}

		const result: string[] = [];
		for (const [file, items] of groups) {
			result.push(file);
			for (const item of items) {
				result.push(`  ${item.line}${item.sep} ${item.text}`);
			}
			result.push(''); // 文件间空行
		}

		// 追加 footer（不参与分组）
		const footerStart = out.lastIndexOf('[共 ');
		if (footerStart > 0) {
			result.push(out.slice(footerStart));
		}

		return result.join('\n');
	}

	/**
	 * Node.js 文件搜索（rg 不可用时的回退）：walk 目录树并 glob 匹配文件名。
	 */
	private async _nodeFileSearch(
		resolvedPath: string, pattern: string, limit: number, offset: number, signal?: AbortSignal,
	): Promise<string> {
		// mtime 由 IFileService.resolve() 的 children[].mtime 提供（无需 fs.statSync，
		// fs 模块在 renderer 进程中不可用，同 file_read bug）。
		const results: { path: string; mtime: number }[] = [];
		const MAX_VISIT = 5_000;
		let visited = 0;
		const NOISE = SearchHelpers.NOISE_DIR_NAMES;

		// 简易 glob → regex
		const globToRegex = (g: string): RegExp => {
			let r = g.replace(/\./g, '\\.').replace(/\*\*/g, '<<<RECURSIVE>>>')
				.replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '[^/\\\\]')
				.replace(/<<<RECURSIVE>>>/g, '.*');
			return new RegExp(`^${r}$`, 'i');
		};
		const regex = globToRegex(pattern);

		const walk = async (dir: string): Promise<void> => {
			if (visited >= MAX_VISIT) { return; }
			if (signal?.aborted) { return; }
			const entries = await this.fileService.resolve(URI.file(dir));
			if (!entries.children) { return; }
			for (const c of entries.children) {
				if (visited >= MAX_VISIT || signal?.aborted) { return; }
				const fullPath = `${dir}/${c.name}`.replace(/\\/g, '/');
				if (c.isDirectory) {
					if (NOISE.has(c.name) || c.name.startsWith('.')) { continue; }
					await walk(fullPath);
				} else {
					visited++;
					if (regex.test(fullPath)) {
						try {
							results.push({ path: fullPath, mtime: c.mtime ?? 0 });
						} catch { results.push({ path: fullPath, mtime: 0 }); }
					}
				}
			}
		};

		await walk(resolvedPath.replace(/\\/g, '/'));
		results.sort((a, b) => b.mtime - a.mtime);
		const total = results.length;
		const paged = results.slice(offset, offset + limit);
		const out = paged.map(r => r.path).join('\n') || '(no matching files)';
		return this._appendSearchFooter(out, total, paged.length, offset, limit, 'file');
	}

	/**
	 * 单文件内容搜索（对齐 rg "rg pattern file" 行为）。
	 * 读取文件内容按行匹配，返回 `filePath:lineNum: lineContent` 格式。
	 * 用于 `searchContent` 在 rg 不可用且目标为单文件时的回退。
	 */
	private async _grepSingleFile(
		fileUri: URI, pattern: string, limit: number, offset: number, signal?: AbortSignal,
		outputMode: string = 'content', contextLines: number = 0,
	): Promise<string> {
		// 预编译正则（对齐 _walkAndGrep）。用 'i'（非 'gi'）：逐行 test 不需要全局标志，
		// 且 global 会让 RegExp.lastIndex 在多次 test 间串味，导致漏匹配（既有 bug，此处修正）。
		let regex: RegExp | null = null;
		try { regex = new RegExp(pattern, 'i'); } catch {}
		const matchFn = regex
			? (line: string) => regex!.test(line)
			: (line: string) => line.toLowerCase().includes(pattern.toLowerCase());

		let content: { value: { toString(): string } };
		try { content = await this.fileService.readFile(fileUri); } catch {
			return '(cannot read file)';
		}
		const text = typeof content.value === 'string' ? content.value : content.value.toString();
		const safeText = text.length > 256 * 1024 ? text.substring(0, 256 * 1024) : text;
		const lines = safeText.split('\n');

		// 先收集全部命中行号（与上下文窗口计算无关，避免重复扫描）
		const matchIdx: number[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (signal?.aborted) { break; }
			if (matchFn(lines[i])) { matchIdx.push(i); }
		}

		// files_only：只报文件路径（对齐 _formatSearchComplete 的 files_only 语义）
		if (outputMode === 'files_only') {
			if (matchIdx.length === 0) { return '(no matching files)'; }
			return this._appendSearchFooter(fileUri.fsPath, 1, 1, offset, limit, 'file');
		}
		// count：报告该文件命中行数
		if (outputMode === 'count') {
			const c = matchIdx.length;
			const out = c === 0 ? '(no matches)' : `${fileUri.fsPath}: ${c} match(es)`;
			return this._appendSearchFooter(out, c, c === 0 ? 0 : 1, offset, limit, 'file');
		}

		// content（默认）/ 带 context 的上下文窗口
		const hits: string[] = [];
		const seen = new Set<number>();
		for (const mi of matchIdx) {
			if (signal?.aborted) { break; }
			const from = contextLines > 0 ? Math.max(0, mi - contextLines) : mi;
			const to = contextLines > 0 ? Math.min(lines.length - 1, mi + contextLines) : mi;
			for (let j = from; j <= to; j++) {
				if (seen.has(j)) { continue; }
				seen.add(j);
				// 命中行用 ':'，上下文行用 '-'（与 ripgrep/grep 输出一致，便于 densifySearchOutput 识别）
				const sep = j === mi ? ':' : '-';
				hits.push(`${fileUri.fsPath}:${j + 1}${sep} ${lines[j].trim().slice(0, SearchHelpers.SEARCH_LINE_MAX_CHARS)}`);
			}
		}

		const total = hits.length;
		const paged = hits.slice(offset, offset + limit);
		const out = paged.join('\n') || '(no matches)';
		return this._appendSearchFooter(out, total, paged.length, offset, limit, 'match');
	}

	private async _walkAndGrep(dir: URI, query: string, out: string[], limit: number, signal?: AbortSignal): Promise<void> {
		// Hard global cap on files we will read+grep regardless of `limit`.
		// This protects against pathological recursion (huge build trees, symlink
		// loops, accidentally pointing at C:\) which can OOM the renderer because
		// each file we open allocates a UTF-8 string copy of the buffer.
		const MAX_FILES_VISITED = 5_000;
		const filesVisited = { count: 0 };
		const seenDirs = new Set<string>();
		const NOISE_DIRS = SearchHelpers.NOISE_DIR_NAMES;
		// Extension blacklist — we never grep into binary-shaped files. The toString()
		// on a 500KB binary creates a large garbage string + thousands of split parts,
		// which is a major contributor to OOM under parallel execution.
		const BINARY_EXT_RE = /\.(?:exe|dll|so|dylib|node|pak|asar|wasm|bin|obj|lib|a|o|class|jar|pyc|pyo|whl|zip|tar|gz|tgz|bz2|7z|rar|xz|zst|png|jpe?g|gif|bmp|ico|webp|tif|tiff|svg|psd|mp3|wav|ogg|flac|mp4|mov|avi|mkv|webm|pdf|docx?|xlsx?|pptx?|sqlite|db|map|woff2?|ttf|eot|otf)$/i;

		// 预编译正则（对齐 Hermes rg regex 语义），无效正则回退为字面子串匹配
		let regex: RegExp | null = null;
		try { regex = new RegExp(query, 'gi'); } catch { /* keep regex=null → use includes */ }
		const matchFn = regex
			? (line: string) => regex!.test(line)
			: (line: string) => line.includes(query);

		const walk = async (current: URI): Promise<void> => {
			if (signal?.aborted) { return; }
			if (out.length >= limit) { return; }
			if (filesVisited.count >= MAX_FILES_VISITED) { return; }
			const key = current.toString();
			if (seenDirs.has(key)) { return; }
			seenDirs.add(key);

			let stat;
			try { stat = await this.fileService.resolve(current); } catch { return; }
			if (!stat.isDirectory || !stat.children) { return; }

			for (const child of stat.children) {
				if (signal?.aborted) { return; }
				if (out.length >= limit) { return; }
				if (filesVisited.count >= MAX_FILES_VISITED) { return; }

				if (child.isDirectory) {
					if (NOISE_DIRS.has(child.name) || child.name.startsWith('.')) { continue; }
					await walk(child.resource);
					continue;
				}
				if (!child.isFile) { continue; }
				// Skip binary files by extension before any I/O.
				if (BINARY_EXT_RE.test(child.name)) { continue; }
				// Existing 512 KiB safety net (we keep it as a second line of defense).
				if (typeof child.size === 'number' && child.size > 512 * 1024) { continue; }

				filesVisited.count++;

				try {
					const buf = await this.fileService.readFile(child.resource);
					// Quick binary-content sniff: if the first 1 KiB contains a NUL byte,
					// treat as binary. UTF-8 / UTF-16 text never legitimately contains NUL
					// in real source files; this catches cases the extension list missed.
					const raw = buf.value.buffer;
					const sniffLen = Math.min(raw.length, 1024);
					let isBinary = false;
					for (let i = 0; i < sniffLen; i++) {
						if (raw[i] === 0) { isBinary = true; break; }
					}
					if (isBinary) { continue; }

					const text = buf.value.toString();
					// Hard cap per-file string size to keep heap pressure bounded even
					// if the size hint was missing/wrong.
					const safeText = text.length > 256 * 1024 ? text.substring(0, 256 * 1024) : text;
					const lines = safeText.split('\n');
					for (let i = 0; i < lines.length; i++) {
						if (signal?.aborted) { return; }
						if (matchFn(lines[i])) {
							out.push(`${child.resource.fsPath}:${i + 1}: ${lines[i].trim().slice(0, SearchHelpers.SEARCH_LINE_MAX_CHARS)}`);
							if (out.length >= limit) { return; }
						}
					}
				} catch { /* unreadable / binary — skip */ }
			}
		};

		await walk(dir);
	}
}

// ── 密钥脱敏（对齐 Hermes redact_sensitive_text；原 coreTools 模块级，提取为共享导出）──
// search_files / file_read / file_write / terminal 等工具输出统一脱敏，避免重复定义。
const _REDACT_PATTERNS_WHOLE: ReadonlyArray<readonly [RegExp, string]> = [
	// PEM 私钥块
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<REDACTED PRIVATE KEY>'],
	// JWT
	[/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<REDACTED JWT>'],
	// AWS Access Key
	[/\bAKIA[0-9A-Z]{16}\b/g, '<REDACTED AWS KEY>'],
	// GitHub tokens
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<REDACTED>'],
	[/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '<REDACTED>'],
	// GitLab
	[/\bglpat-[A-Za-z0-9_-]{20}\b/g, '<REDACTED>'],
	// Slack
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '<REDACTED>'],
	// OpenAI / Anthropic
	[/\bsk-[A-Za-z0-9]{20,}\b/g, '<REDACTED>'],
	[/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '<REDACTED>'],
];

const _REDACT_PATTERN_ASSIGN = /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|auth)\b)(\s*[:=]\s*)(['"]?)[^\s'"]+/gi;

/** 脱敏密钥（对齐 Hermes redact_sensitive_text）。search_files / file_read / file_write / terminal 等工具输出复用。 */
export function redactSecrets(input: string): string {
	if (!input) { return input; }
	let out = input;
	for (const [re, mask] of _REDACT_PATTERNS_WHOLE) {
		out = out.replace(re, mask);
	}
	out = out.replace(_REDACT_PATTERN_ASSIGN,
		(_m, key: string, sep: string, q: string) => `${key}${sep}${q}<REDACTED>${q}`);
	return out;
}
