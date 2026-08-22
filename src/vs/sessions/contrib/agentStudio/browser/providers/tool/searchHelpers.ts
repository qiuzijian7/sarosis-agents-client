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
import { IFileService, type IFileStat } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ISearchService, QueryType, type ITextQuery, type IFileQuery, type ISearchComplete } from '../../../../../../workbench/services/search/common/search.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { advanceSearchCodeEmptyStreak, advanceSearchIntentRepeat, globToRegexForSearch, searchQueryFingerprint } from './pathFilterNormalize.js';
import { computeSearchScopeOverride, applyExcludeOverride, applyNoiseDirsOverride, type ISearchScopeOverride } from './searchScopeOverride.js';
import {
	terminalSearchFingerprintTokens,
	terminalSearchRepeatBlockedMessage,
	type ITerminalSearchPattern,
} from './terminalCommandGuards.js';
import { extractExcludeDirNames } from '../../../common/codebaseIndexDefaults.js';

export class SearchHelpers {
	// 重复搜索熔断：连续相同搜索 ≥N 次直接拦截（P3 2026-07-29：只拦不警，
	// 删除 warn 档——告警形同虚设，模型照样重试；kimi 零治理靠信息回传，本项目
	// 保留硬拦一挡防烧钱，日志 1785231958842 证明模型会空转 434s）。
	private static readonly SEARCH_REPEAT_BLOCK = 3;
	// search_code 连续空结果引导阈值：连击达其倍数即提示转 search_graph
	//（日志 1785231958842：模型对同一目标反复换符号猜测，exact-repeat 熔断拦不住——
	// 每次 query 都不同，故按「连续 0 命中」连击而非「相同参数」计数）。
	// 阈值内联于 recordSearchCodeEmptyStreak（子代理 2 / 主 agent 3）。
	// 结果大小上限（对齐 Hermes max_result_size_chars）与单条匹配截断长度
	private static readonly SEARCH_MAX_RESULT_CHARS = 100_000;
	private static readonly SEARCH_LINE_MAX_CHARS = 500;

	/**
	 * 搜索工具默认排除目录（`search_files` / `search_code` 两路统一）。
	 *
	 * 覆盖四类噪声：
	 *  - 通用构建/依赖产物：node_modules / .git / build / dist / out / .next 等
	 *  - **git worktree 副本**：.worktrees / .worktree（事故 1787211509467，见下）
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
		// ★ git worktree 副本（事故 1787211509467，2026-08-20）
		// worktree 是主仓库的**完整源码副本**（每个分支一份），既不是构建产物也不在
		// .gitignore 里，因此此前完全不被排除。本仓实测：主仓 src 9112 个 .ts，
		// 而 .worktrees（feat-agentloop / feat-chat / feat-workflow 三份）合计 33480 个
		// —— 搜索空间膨胀 4.7 倍，且全是其他分支的**过期代码**。
		// 危害不止于慢：日志实证模型把 root 指向
		// `.worktrees/feat-chat/src/.../workflowRun.ts` 并据此分析，等于**基于过期分支
		// 代码下结论**；同名文件多份还会让模型反复搜索验证「到底改哪个」，
		// 直接推高 delegate_task 时长（该次 423107ms=7min，占总时长 77%，用户遂手动中断）。
		// 需要跨 worktree 检索时显式传 path_filter 指向具体 worktree 即可绕过本排除。
		'**/.worktrees/**', '**/.worktree/**',
		// UE (Unreal) 构建产物：事故 1785143114444
		'**/Intermediate/**', '**/Saved/**', '**/Binaries/**', '**/DerivedDataCache/**',
		// out-build/out-test/out-vscode（Saros 自身仓库）
		'**/out-build/**', '**/out-test/**', '**/out-vscode/**',
		// 敏感文件（P4 2026-07-29，对齐 kimi SENSITIVE_FILTER_RG_ARGS）：密钥/凭据
		// 永不进 grep 结果（redactSecrets 是后过滤，此处源头排除更彻底）
		'**/.env', '**/.env.*',
		'**/id_rsa', '**/id_rsa.*', '**/id_ed25519', '**/id_ed25519.*', '**/id_ecdsa', '**/id_ecdsa.*',
		'**/.aws', '**/.aws/**', '**/.gcp', '**/.gcp/**',
	];

	/**
	 * UE 形态 root 的**额外**运行时排除（2026-08-18，日志 1787038807642：双仓库 root
	 * 全量 rg 60s×6 超时）。仅当搜索 root 探测为 Unreal 形态（直下/一层子目录含
	 * `Engine/` 目录或 `*.uproject` 文件）时叠加——普通项目零影响，避免 ASP.NET
	 * `Content`、常规 `ThirdParty` 目录被误伤。
	 *
	 * 排除原则：**非源码的海量目录**（资产/第三方库/文档/模板），`Source` 与
	 * `Plugins` 是真正的搜索目标（引擎原生代码、游戏插件源码），绝不排除。
	 * 与 codebaseIndexDefaults.UNREAL_EXCLUDE_DIRS（索引建议清单）语义不同：
	 * 此处服务于运行时 grep，ThirdParty/Content 里的东西 grep 永远不该翻。
	 */
	private static readonly UNREAL_EXTRA_EXCLUDE_GLOBS: readonly string[] = [
		'**/Content/**',          // 资产目录（uasset/umap 二进制为主；rg 跳内容但目录遍历仍耗时）
		'**/ThirdParty/**',       // UE 第三方库（GB 级：ICU/ffmpeg/PhysX 源码副本，非本项目代码）
		'**/Documentation/**',    // 引擎文档
		'**/Templates/**',        // 引擎模板工程
		'**/FeaturePacks/**',     // 特性包（二进制 upack）
		'**/Samples/**',          // 示例工程
		'**/Automation/**',       // 构建自动化（UBT 生成脚本，噪声居多）
	];

	/** UE 形态 walk-fallback 的等价目录名集（与 UNREAL_EXTRA_EXCLUDE_GLOBS 目录段一致）。 */
	private static readonly UNREAL_EXTRA_NOISE_DIRS: ReadonlySet<string> = new Set([
		'Content', 'ThirdParty', 'Documentation', 'Templates', 'FeaturePacks', 'Samples', 'Automation',
	]);

	/** UE 形态探测缓存（root fsPath → 是否 UE）。进程级，探测一次复用。 */
	private static readonly _unrealRootCache = new Map<string, boolean>();

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

	/**
	 * 用户工作区配置的排除项（`search.exclude` / `files.exclude`）—— 打通「索引口径」与
	 * 「grep 口径」（2026-08-19）。
	 *
	 * 此前索引器会读 `.code-workspace` 的 search.exclude（extractExcludeDirNames），但
	 * 运行时 grep 只用本类硬编码表 → 用户在 code-workspace 里排掉 Plugins/Config/Programs
	 * 之类的巨型目录后，索引变小了但 search_code / search_files 照旧全扫（大工作区仍是
	 * 分钟级）。现把用户配置一并并入 ripgrep excludePattern 与 walk-fallback 目录名集。
	 *
	 * 只取「干净目录段」（extractExcludeDirNames 语义），文件级 glob 交给 rg 自身与
	 * DEFAULT_EXCLUDE_GLOBS 处理，避免把 `*.log` 这类误当目录名。
	 */
	private _userExcludeCache: { globs: Readonly<Record<string, boolean>>; dirs: ReadonlySet<string> } | undefined;
	private _userExclude(): { globs: Readonly<Record<string, boolean>>; dirs: ReadonlySet<string> } {
		if (this._userExcludeCache) { return this._userExcludeCache; }
		const names: string[] = [];
		try {
			const cfg = this.configurationService;
			if (cfg) {
				names.push(...extractExcludeDirNames(cfg.getValue('search.exclude')));
				names.push(...extractExcludeDirNames(cfg.getValue('files.exclude')));
			}
		} catch { /* 配置读取失败 → 视为无额外排除 */ }
		const globs: Record<string, boolean> = {};
		const dirs = new Set<string>();
		for (const n of names) {
			globs[`**/${n}/**`] = true;
			dirs.add(n);
		}
		this._userExcludeCache = { globs, dirs };
		if (dirs.size > 0) {
			this.logService.info(`[BuiltinTools] search: merged ${dirs.size} user exclude dir(s) from search.exclude/files.exclude: ${[...dirs].join(', ')}`);
		}
		return this._userExcludeCache;
	}

	/** UE 形态叠加后的 IExpression（再叠加用户配置排除），惰性构造一次复用。 */
	private _effectiveExcludeExprCache = new Map<boolean, Readonly<Record<string, boolean>>>();
	private _effectiveExcludeExpr(isUnreal: boolean): Readonly<Record<string, boolean>> {
		const cached = this._effectiveExcludeExprCache.get(isUnreal);
		if (cached) { return cached; }
		const expr: Record<string, boolean> = { ...SearchHelpers._defaultExcludeExpr() };
		if (isUnreal) {
			for (const g of SearchHelpers.UNREAL_EXTRA_EXCLUDE_GLOBS) { expr[g] = true; }
		}
		Object.assign(expr, this._userExclude().globs);
		this._effectiveExcludeExprCache.set(isUnreal, expr);
		return expr;
	}

	/**
	 * 「搜索根显式指向被默认排除的目录」时的放行决策（2026-08-22，日志 1787363991734）。
	 *
	 * 背景与实测证据见 `searchScopeOverride.ts` 头注释。要点：模型 7 次 search_code 想
	 * 在 `@comfyorg/litegraph` bundle 里找符号全部 0 命中，最后退化为用 execute_code
	 * 跑 python 手工扫文件 —— 因为 `node_modules` 同时被 `.gitignore`（第一层）与
	 * `DEFAULT_EXCLUDE_GLOBS`（第二层）挡住，且**两层都无法通过任何参数绕过**。
	 *
	 * 决策原则：显式把根指到被排除目录里，本身就是最强的意图表达，此时继续排除必然
	 * 0 结果且不给解释。只放行路径中实际出现的那些目录名，其余排除项保持不变。
	 *
	 * 结果按 resolvedPath 缓存 —— 同一次搜索里 `searchContent` 的正则失败回退路径会
	 * 再算一次，且相同根在一个 turn 内常被反复搜索。
	 */
	private _scopeOverrideCache = new Map<string, ISearchScopeOverride>();
	private _scopeOverride(resolvedPath: string): ISearchScopeOverride {
		const cached = this._scopeOverrideCache.get(resolvedPath);
		if (cached) { return cached; }
		const scope = computeSearchScopeOverride(resolvedPath, SearchHelpers.NOISE_DIR_NAMES);
		// 上限保护：长 turn 里根路径可能很多，超限清空重算（决策是纯函数，重算无副作用）
		if (this._scopeOverrideCache.size > 200) { this._scopeOverrideCache.clear(); }
		this._scopeOverrideCache.set(resolvedPath, scope);
		if (scope.hasOverride) {
			this.logService.info(`[BuiltinTools] search scope override: ${scope.reason}`);
		}
		return scope;
	}

	/**
	 * 探测 root 是否 Unreal 形态：直下（或一层子目录中任一）存在 `Engine` 目录
	 * 或 `*.uproject` 文件。覆盖三种真实形态：
	 *   - root=UE5EA（引擎安装根，直下有 Engine/）
	 *   - root=S1Game（游戏项目根，直下有 *.uproject）
	 *   - root=GR_Release_New（多仓库父目录，S1Game/UE5EA 在一层子目录里）
	 * 探测失败（权限/网络盘）保守返回 false（不叠加，走默认排除）。
	 * 进程级缓存 per root，仅首次一次 resolve。
	 */
	private async _isUnrealRoot(root: string): Promise<boolean> {
		const cached = SearchHelpers._unrealRootCache.get(root);
		if (cached !== undefined) { return cached; }
		let isUnreal = false;
		try {
			const top = await this.fileService.resolve(URI.file(root));
			if (this._hasUnrealMarker(top.children)) {
				isUnreal = true;
			} else {
				// 一层子目录探测（父目录形态）：只看目录项，最多探 ~20 个防病态展开
				const dirs = (top.children ?? []).filter(c => c.isDirectory).slice(0, 20);
				for (const d of dirs) {
					try {
						const sub = await this.fileService.resolve(d.resource);
						if (this._hasUnrealMarker(sub.children)) { isUnreal = true; break; }
					} catch { /* 单个子目录探测失败继续 */ }
				}
			}
		} catch { /* resolve 失败 → 保守 false */ }
		SearchHelpers._unrealRootCache.set(root, isUnreal);
		return isUnreal;
	}

	private _hasUnrealMarker(children: readonly IFileStat[] | undefined): boolean {
		if (!children) { return false; }
		for (const c of children) {
			const name = c.name ?? '';
			if (c.isDirectory && name.toLowerCase() === 'engine') { return true; }
			if (name.toLowerCase().endsWith('.uproject')) { return true; }
		}
		return false;
	}

	/**
	 * walk-fallback 用的额外噪声目录名集 = UE 形态叠加 ∪ 用户 search.exclude/files.exclude。
	 * 都为空时返回 undefined（调用方据此跳过额外判断）。
	 */
	private async _extraNoiseDirs(root: string): Promise<ReadonlySet<string> | undefined> {
		const userDirs = this._userExclude().dirs;
		const isUnreal = await this._isUnrealRoot(root);
		if (!isUnreal && userDirs.size === 0) { return undefined; }
		const merged = new Set<string>(userDirs);
		if (isUnreal) { for (const d of SearchHelpers.UNREAL_EXTRA_NOISE_DIRS) { merged.add(d); } }
		return merged;
	}

	/** 公开包装：供工具层做超大 roots 预检（见 codebaseTools search_code）。 */
	public async isUnrealRoot(root: string): Promise<boolean> {
		return this._isUnrealRoot(root);
	}

	/** Node-walk fallback 的目录名黑名单（等价 DEFAULT_EXCLUDE_GLOBS 里的目录名部分）。 */
	private static readonly NOISE_DIR_NAMES: ReadonlySet<string> = new Set([
		// 通用
		'node_modules', '.git', 'out', 'dist', 'build', '.build',
		'.next', '.cache', '.vscode-test', 'coverage', '__pycache__',
		'target', '.gradle', '.idea', 'bin', 'obj', '.pnpm-store',
		'.yarn', '.parcel-cache', '.turbo', '.nuxt', '.svelte-kit',
		'.angular', 'venv', '.venv', 'env', '.env',
		// ★ git worktree 副本（事故 1787211509467）——与 DEFAULT_EXCLUDE_GLOBS 保持一致
		'.worktrees', '.worktree',
		// UE (Unreal) 构建产物
		'Intermediate', 'Saved', 'Binaries', 'DerivedDataCache',
		// Saros 自身仓库
		'out-build', 'out-test', 'out-vscode',
	]);

	// 每个 agent 的重复搜索计数：签名 → 累计次数（非「连续」）。
	// 2026-08-20 由 `{ key, count }`（只记上一次签名）改为 per-bucket Map：
	// 旧实现 `prev.key === key ? count+1 : 1` 只认【连续】相同，中间隔一次别的搜索
	// 即重置 —— 日志 1787214724132 实证 `wf-node-control` 在 3 个不相邻的轮次各搜一次
	// （line 7863/8303/8768），熔断计数每次都归零，3 次全部放行。
	private _searchRepeatMap = new Map<string, Map<string, number>>();
	/** 单个 bucket 内保留的签名上限（防长 turn 无界增长；超限清空该桶重新计数）。 */
	private static readonly SEARCH_REPEAT_KEYS_PER_BUCKET = 200;
	/** search_code 连续空结果（0 matches）连击计数，按 agentId 分桶。 */
	private _searchCodeEmptyStreakMap = new Map<string, number>();
	/**
	 * 同一「搜索意图指纹」的累计次数，按 `agentId::fingerprint` 分桶
	 * （2026-08-20，日志 1787211923566：换参重搜绕过前两道闸门）。
	 */
	private _searchIntentRepeatMap = new Map<string, number>();
	/**
	 * terminal **搜索类命令**的意图指纹累计次数，按 `agentId::fingerprint` 分桶
	 * （2026-08-21，事故 1787282838177：模型绕开 search_* 工具改用 shell grep，
	 * 前三道闸门全程零拦截 → 47 轮 78 工具 → 上下文 4.4 万 token → 压缩挂死）。
	 * 与 `_searchIntentRepeatMap` **分开存**：两者阈值语义相同但来源不同，
	 * 混用会让「search_code 搜 2 次 + terminal grep 1 次」被算成 3 次而误拦。
	 */
	private _terminalSearchRepeatMap = new Map<string, number>();
	/** 指纹桶上限（与 SEARCH_REPEAT_KEYS_PER_BUCKET 同义，防长 turn 无界增长）。 */
	private static readonly TERMINAL_SEARCH_KEYS_LIMIT = 200;

	/**
	 * ripgrep 可用性门控。VS Code 内置 `searchService` 内部 spawn ripgrep，
	 * 在某些环境下（Extension Host 进程无法 spawn 该 exe）会持续抛 ENOENT，
	 * 导致每次搜索都报错。首次失败后永久回退到 `fileService` 实现的 Node walk，
	 * 避免反复报错（回退路径功能等价，仅速度略慢）。
	 */
	private _ripgrepBroken = false;

	/**
	 * 内容搜索是否处于 ripgrep 不可用的慢速 walk 降级态（2026-08-05）。
	 * 供 search_code 等调用方在 0 命中时如实提示（不得声称 include 过滤以
	 * ripgrep 语义生效——walk 回退过滤语义不同且大树可能未扫全）。
	 */
	isContentSearchDegraded(): boolean { return this._ripgrepBroken; }

	constructor(
		private readonly fileService: IFileService,
		private readonly searchService: ISearchService,
		private readonly logService: ILogService,
		/** 可选：用于读取 `search.exclude` / `files.exclude`，把用户排除口径并入 grep。 */
		private readonly configurationService?: IConfigurationService,
	) { }

	/**
	 * 跟踪重复搜索，对齐 Hermes-Agent 的 repeated-search guard（P3：只拦不警）。
	 * 签名包含分页参数（limit/offset），因此合法翻页不会触发熔断。
	 * 累计 ≥3 次返回 blocked（直接拦截，不执行 rg）。
	 *
	 * 2026-08-20：计数口径由「连续相同」改为「累计相同」——非相邻的重复搜索
	 * 同样是纯浪费（结果不会变），旧的连续口径被「隔一次别的搜索」轻易绕过。
	 *
	 * @param target 影响搜索【结果集】的维度（如 search_files 的 files/content）。
	 *   注意：不要传入仅影响【输出格式】的参数（如 search_code 的 compact/full/files），
	 *   否则模型换个 mode 重搜同一 pattern 就会被算作新签名而放行。
	 */
	recordSearchRepeat(
		agentId: string | undefined, pattern: string, target: string, searchPath: string,
		fileGlob: string | undefined, limit: number, offset: number,
	): { count: number; blocked?: string } {
		const bucket = agentId ?? '';
		const key = JSON.stringify([pattern, target, searchPath, fileGlob ?? null, limit, offset]);
		let keyMap = this._searchRepeatMap.get(bucket);
		if (!keyMap) {
			keyMap = new Map<string, number>();
			this._searchRepeatMap.set(bucket, keyMap);
		} else if (keyMap.size > SearchHelpers.SEARCH_REPEAT_KEYS_PER_BUCKET && !keyMap.has(key)) {
			// 长 turn 防无界增长：签名数超限且本次是全新签名 → 清空重新计数
			// （宁可漏拦，不可泄漏内存；正在累计中的热点签名会一并清掉，可接受）。
			keyMap.clear();
		}
		const count = (keyMap.get(key) ?? 0) + 1;
		keyMap.set(key, count);

		if (count >= SearchHelpers.SEARCH_REPEAT_BLOCK) {
			return {
				count,
				blocked:
					`BLOCKED: 你已发起 ${count} 次完全相同的搜索（pattern=${pattern}, target=${target}），结果不会有任何变化。` +
					`你已掌握这些信息，请停止重复搜索，转而推进任务（可调整 pattern/路径，或用 offset 翻页查看被截断的结果）。`,
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
		// 阈值内联（P3）：子代理（agentId 前缀 subagent-）预算更紧阈值 2，主 agent 3。
		const threshold = bucket.startsWith('subagent-') ? 2 : 3;
		const result = advanceSearchCodeEmptyStreak(
			this._searchCodeEmptyStreakMap.get(bucket) ?? 0, isEmpty, threshold,
		);
		this._searchCodeEmptyStreakMap.set(bucket, result.streak);
		return result;
	}

	/**
	 * 同一「搜索意图」重复次数跟踪（2026-08-20，日志 1787211923566）。
	 *
	 * 补上前两道闸门之间的盲区：
	 *   - `recordSearchRepeat`：只拦**参数完全相同**的调用；
	 *   - `recordSearchCodeEmptyStreak`：只在**连续 0 命中**时引导；
	 *   - 本方法：按**归一化后的搜索意图指纹**计数，无论换 root、换正则写法、
	 *     有无命中都累计 —— 实测事故里模型对 `LoadImage` 搜了 6 次（次次有命中、
	 *     参数各不相同），前两道闸门全部绕过，最终跑满 50/50 迭代上限。
	 *
	 * @returns count 该意图累计次数；shouldGuide 达阈值后为 true（此后每次均为 true）
	 */
	recordSearchIntentRepeat(
		agentId: string | undefined, query: string | undefined,
	): { count: number; shouldGuide: boolean; fingerprint: string | undefined } {
		const fingerprint = searchQueryFingerprint(query);
		if (!fingerprint) { return { count: 0, shouldGuide: false, fingerprint: undefined }; }
		const bucket = `${agentId ?? ''}::${fingerprint}`;
		// 阈值：子代理 2 / 主 agent 3（2026-08-20 各下调 1）。原为 3/4，而日志
		// 1787214724132 中 `loadimage`、`ownsnapshots` 恰好各搜 4 次 —— 卡在主 agent
		// 阈值边界上，前 3 次全部白跑、只在最后一次才给引导，等于没拦住。
		const threshold = (agentId ?? '').startsWith('subagent-') ? 2 : 3;
		const result = advanceSearchIntentRepeat(this._searchIntentRepeatMap.get(bucket) ?? 0, threshold);
		this._searchIntentRepeatMap.set(bucket, result.count);
		return { ...result, fingerprint };
	}

	/**
	 * terminal **搜索类命令**的重复意图跟踪（2026-08-21，事故 1787282838177）。
	 *
	 * 补上第四道闸门 —— 前三道（recordSearchRepeat / EmptyStreak / IntentRepeat）
	 * **只覆盖 search_code / search_files 工具**，模型改用 `terminal` 跑 shell grep
	 * 即可全部绕过。事故实证：47 轮迭代、78 个工具调用，大量 Select-String /
	 * Get-ChildItem 反复搜同一批文件，零拦截，上下文涨到 4.4 万 token 触发压缩。
	 *
	 * 与 `recordSearchIntentRepeat` 的差异：
	 *  - 只对 `TERMINAL_SEARCH_COMMAND_PATTERNS` 命中的命令调用（build/run/test 不计数）；
	 *  - 指纹先由 `terminalSearchFingerprintTokens` 做 shell 感知的 token 提取
	 *    （拆管道、剥 flag、按 kind 决定路径是否进指纹），再复用
	 *    `searchQueryFingerprint` 做最终归一 —— 两者共用归一器，因此
	 *    `grep -r "LoadImage"` 与 `search_code query="\bLoadImage\b"` 指纹一致（`loadimage`）；
	 *  - **独立计数桶**：不与 search_* 的意图计数混用，避免「search_code 2 次 +
	 *    terminal 1 次」被算成 3 次而误拦。
	 *
	 * 阈值与 `recordSearchIntentRepeat` 一致（子代理 2 / 主 agent 3）：terminal 搜索
	 * 比 search_code 更贵（无索引、全树扫描、输出更冗长），没有放宽的理由。
	 *
	 * @returns count 累计次数；blocked 达阈值时为拦截原因（调用方应直接返回、不执行命令）
	 */
	recordTerminalSearchRepeat(
		agentId: string | undefined, command: string, hit: ITerminalSearchPattern,
	): { count: number; fingerprint?: string; blocked?: string } {
		const tokens = terminalSearchFingerprintTokens(command, hit.kind);
		const fingerprint = searchQueryFingerprint(tokens);
		// 指纹过短/为空（如 `dir /s` 无任何搜索词）→ 不计数，避免误伤宽泛枚举
		if (!fingerprint) { return { count: 0 }; }

		const bucket = `${agentId ?? ''}::${fingerprint}`;
		// 防长 turn 无界增长（对齐 recordSearchRepeat 的桶上限策略：宁可漏拦不可泄漏）
		if (this._terminalSearchRepeatMap.size > SearchHelpers.TERMINAL_SEARCH_KEYS_LIMIT
			&& !this._terminalSearchRepeatMap.has(bucket)) {
			this._terminalSearchRepeatMap.clear();
		}
		const threshold = (agentId ?? '').startsWith('subagent-') ? 2 : 3;
		const result = advanceSearchIntentRepeat(this._terminalSearchRepeatMap.get(bucket) ?? 0, threshold);
		this._terminalSearchRepeatMap.set(bucket, result.count);

		if (result.shouldGuide) {
			return {
				count: result.count,
				fingerprint,
				blocked: terminalSearchRepeatBlockedMessage(result.count, fingerprint, hit),
			};
		}
		return { count: result.count, fingerprint };
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
			const scope = this._scopeOverride(resolvedPath);
			const query: IFileQuery = {
				type: QueryType.File,
				filePattern: pattern,
				folderQueries: [{ folder: folderUri, disregardIgnoreFiles: scope.disregardIgnoreFiles || undefined }],
				sortByScore: true,
				// 默认排除 node_modules / .git / build / UE Intermediate & Saved 等噪声目录；
				// UE 形态 root 额外叠加 Content/ThirdParty/Documentation 等非源码海量目录。
				// 搜索根显式指向被排除目录时放行该目录（见 searchScopeOverride）。
				excludePattern: applyExcludeOverride(
					this._effectiveExcludeExpr(await this._isUnrealRoot(resolvedPath)), scope),
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
			const scope = this._scopeOverride(resolvedPath);
			const query: ITextQuery = {
				type: QueryType.Text,
				contentPattern: { pattern, isRegExp: true, isCaseSensitive: false, isWordMatch: false },
				folderQueries: [{ folder: folderUri, disregardIgnoreFiles: scope.disregardIgnoreFiles || undefined }],
				includePattern: fileGlob ? { [fileGlob]: true } : undefined,
				// 默认排除 node_modules / .git / build / UE Intermediate & Saved 等噪声目录
				// （事故 1785143114444：9220ms outlier 由 UE Intermediate/Build 贡献）；
				// UE 形态 root 额外叠加 Content/ThirdParty 等非源码海量目录（1787038807642）。
				// 搜索根显式指向被排除目录时放行该目录（见 searchScopeOverride）。
				excludePattern: applyExcludeOverride(
					this._effectiveExcludeExpr(await this._isUnrealRoot(resolvedPath)), scope),
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
					const plainScope = this._scopeOverride(resolvedPath);
					const plainQuery: ITextQuery = {
						type: QueryType.Text,
						contentPattern: { pattern, isRegExp: false, isCaseSensitive: false, isWordMatch: false },
						folderQueries: [{ folder: URI.file(resolvedPath), disregardIgnoreFiles: plainScope.disregardIgnoreFiles || undefined }],
						includePattern: fileGlob ? { [fileGlob]: true } : undefined,
						excludePattern: applyExcludeOverride(
							this._effectiveExcludeExpr(await this._isUnrealRoot(resolvedPath)), plainScope),
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
		resolvedPath: string, pattern: string, fileGlob: string | undefined,
		limit: number, offset: number, _outputMode: string, signal?: AbortSignal,
	): Promise<string> {
		const normalizedUri = URI.file(resolvedPath);
		const stat = await this._statOrNull(resolvedPath);
		if (stat === null) { return '(no such file or directory)'; }
		if (!stat.isDirectory) { return await this._grepSingleFile(normalizedUri, pattern, limit, offset, signal, _outputMode, 0); }
		const hits: string[] = [];
		// 兑现 fileGlob（此前形参被丢弃：文件名过滤完全失效 → 全树逐文件 grep，
		// 5000 文件预算在 Engine/Plugins 等噪声目录耗尽，永远到不了 Engine/Source——
		// 日志 1785894964584：12+ 次 search_code 恒 27-32s 全 no matches）。
		const globRe = globToRegexForSearch(fileGlob ?? '');
		await this._walkAndGrep(normalizedUri, pattern, hits, Math.min(limit + offset, 500), signal, globRe);
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
		// 搜索根显式指向被排除目录时放行该目录（与 ripgrep 路径保持等价语义）
		const NOISE = applyNoiseDirsOverride(SearchHelpers.NOISE_DIR_NAMES, this._scopeOverride(resolvedPath));
		// UE 形态 root：追加 Content/ThirdParty 等非源码海量目录（进程级缓存探测）；
		// 并叠加用户 search.exclude/files.exclude 的目录名
		const unrealNoise = await this._extraNoiseDirs(resolvedPath);

		// glob → regex（2026-08-05 换用共享转换器：原版不支持 {a,b} 花括号——
		// SOURCE_CODE_GLOB 等花括号模式在 rg 不可用的 node 回退下恒不匹配）。
		const regex = globToRegexForSearch(pattern) ?? /^.*$/i;

		const walk = async (dir: string): Promise<void> => {
			if (visited >= MAX_VISIT) { return; }
			if (signal?.aborted) { return; }
			const entries = await this.fileService.resolve(URI.file(dir));
			if (!entries.children) { return; }
			for (const c of entries.children) {
				if (visited >= MAX_VISIT || signal?.aborted) { return; }
				const fullPath = `${dir}/${c.name}`.replace(/\\/g, '/');
				if (c.isDirectory) {
					if (NOISE.has(c.name) || unrealNoise?.has(c.name) || c.name.startsWith('.')) { continue; }
					await walk(fullPath);
				} else {
					// 敏感文件跳过（P5，补齐 _nodeFileSearch 与 _walkAndGrep/ripgrep 一致）
					if (/^\.env(?:\..*)?$|^id_(?:rsa|ed25519|ecdsa)(?:\..*)?$/i.test(c.name)) { continue; }
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

	private async _walkAndGrep(dir: URI, query: string, out: string[], limit: number, signal?: AbortSignal, fileGlobRe?: RegExp): Promise<void> {
		// Hard global cap on files we will read+grep regardless of `limit`.
		// This protects against pathological recursion (huge build trees, symlink
		// loops, accidentally pointing at C:\) which can OOM the renderer because
		// each file we open allocates a UTF-8 string copy of the buffer.
		const MAX_FILES_VISITED = 5_000;
		// glob 过滤生效时，不命中文件不读不占预算（只耗目录 resolve）——
		// 目录访问单独设上限防符号链接环/畸形树无界遍历。
		const MAX_DIRS_VISITED = 30_000;
		const filesVisited = { count: 0 };
		const dirsVisited = { count: 0 };
		const seenDirs = new Set<string>();
		const rootFs = fileGlobRe ? dir.fsPath.replace(/\\/g, '/') : '';
		// 搜索根显式指向被排除目录时放行该目录（与 ripgrep 路径保持等价语义）
		const NOISE_DIRS = applyNoiseDirsOverride(SearchHelpers.NOISE_DIR_NAMES, this._scopeOverride(dir.fsPath));
		// UE 形态 root：追加 Content/ThirdParty 等非源码海量目录（进程级缓存探测）；
		// 并叠加用户 search.exclude/files.exclude 的目录名
		const unrealNoise = await this._extraNoiseDirs(dir.fsPath);
		// Extension blacklist — we never grep into binary-shaped files. The toString()
		// on a 500KB binary creates a large garbage string + thousands of split parts,
		// which is a major contributor to OOM under parallel execution.
		const BINARY_EXT_RE = /\.(?:exe|dll|so|dylib|node|pak|asar|wasm|bin|obj|lib|a|o|class|jar|pyc|pyo|whl|zip|tar|gz|tgz|bz2|7z|rar|xz|zst|png|jpe?g|gif|bmp|ico|webp|tif|tiff|svg|psd|mp3|wav|ogg|flac|mp4|mov|avi|mkv|webm|pdf|docx?|xlsx?|pptx?|sqlite|db|map|woff2?|ttf|eot|otf|uasset|umap|upk|ubulk|uexp)$/i;

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
			if (dirsVisited.count >= MAX_DIRS_VISITED) { return; }
			const key = current.toString();
			if (seenDirs.has(key)) { return; }
			seenDirs.add(key);
			dirsVisited.count++;

			let stat;
			try { stat = await this.fileService.resolve(current); } catch { return; }
			if (!stat.isDirectory || !stat.children) { return; }

			for (const child of stat.children) {
				if (signal?.aborted) { return; }
				if (out.length >= limit) { return; }
				if (filesVisited.count >= MAX_FILES_VISITED) { return; }
				if (dirsVisited.count >= MAX_DIRS_VISITED) { return; }

				if (child.isDirectory) {
					if (NOISE_DIRS.has(child.name) || unrealNoise?.has(child.name) || child.name.startsWith('.')) { continue; }
					await walk(child.resource);
					continue;
				}
			if (!child.isFile) { continue; }
			// Skip binary files by extension before any I/O.
			if (BINARY_EXT_RE.test(child.name)) { continue; }
			// 敏感文件跳过（P4，对齐 kimi SENSITIVE_FILTER；.aws/.gcp 目录已被 dot-dir skip 覆盖）
			if (/^\.env(?:\..*)?$|^id_(?:rsa|ed25519|ecdsa)(?:\..*)?$/i.test(child.name)) { continue; }
				// Existing 512 KiB safety net (we keep it as a second line of defense).
				if (typeof child.size === 'number' && child.size > 512 * 1024) { continue; }

				// fileGlob 过滤：不命中文件名 glob 的文件不读、不占 filesVisited 预算
				//（此前形参丢弃 → 全树逐文件 grep，预算在噪声目录耗尽——日志 1785894964584）
				if (fileGlobRe) {
					const childFs = child.resource.fsPath.replace(/\\/g, '/');
					const rel = childFs.startsWith(rootFs) ? childFs.slice(rootFs.length).replace(/^\//, '') : child.name;
					if (!fileGlobRe.test(rel)) { continue; }
				}

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
