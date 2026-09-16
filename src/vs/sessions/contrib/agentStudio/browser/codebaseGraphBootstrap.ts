/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase Graph Bootstrap — 工作区打开后自动加载/索引代码图谱，用户无感知。
 *
 * 多 folder 工作区（如 S1Game + UE5EA）：每个 folder 各自持久化 graph.db.zst，
 * 用唯一项目名（folder 目录名）区分；启动时依次合并进同一内存 store（跨 folder 检索）。
 *
 * 1. 工作区打开时遍历所有 folder，检查各自是否已有 graph.db.zst
 * 2. 有 → 合并加载（loadGraphMerge，毫秒级）
 * 3. 无 → 延迟 5s 后自动索引该 folder（后台，不阻塞 UI）
 * 4. 全部加载/索引完成后启动文件监听 → 文件变更时自动增量索引
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { runWhenGlobalIdle } from '../../../../base/common/async.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICodebaseGraphService, IIndexConfig } from './codebaseGraphService.js';
import { ICodebaseMemoryMcpService, IIndexConfig as IUserIndexConfig } from './codebaseMemoryMcpService.js';
import { URI } from '../../../../base/common/uri.js';
import { shouldDeferGraphLoad } from '../common/codebaseIndexDefaults.js';
import { wsStage } from './wsSwitchDiag.js';

const LOG_TAG = '[CodebaseGraph]';
const AUTO_INDEX_DELAY_MS = 5000; // 5s delay after workspace open

class CodebaseGraphBootstrapContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.codebaseGraphBootstrap';

	private _autoIndexTimer: any;
	/** 已加载/已索引的 folder（归一化 fsPath） */
	private readonly _readyFolders = new Set<string>();
	/**
	 * **正在加载中**的 folder（归一化 fsPath）。
	 *
	 * 2026-09-15 修：`_readyFolders` 只在加载**完成后**才 add，而一次 `loadGraphMerge`
	 * 要 10~40s（大图）——期间任何再次触发的 `_bootstrap()`（工作区切换、folder 事件）
	 * 都会把同一 folder **再加载一遍**。实测日志（20260915T132615）：
	 * ```
	 * 13:26:45 [loadGraphMerge] merged ...sarosis... store nodes=341560
	 * 13:26:53 [loadGraphMerge] merged ...sarosis... store nodes=522257   ← 同一制品被合并两次
	 * ```
	 * 后果（实测制品 `graph.db.zst` 358,887 节点去重后仅 180,753，**49.6% 冗余**）：
	 * 内存节点翻倍 → `_ensureSqliteFreshness` 恒判「sqlite 落后」→ 每次查询触发全量重同步
	 * → 查询与写事务竞争（单次检索 2.3s 且候选残缺）。
	 * 注：`mergeFromJSONAsync` 现已幂等（同 qn 跳过），此处是**源头**防重复发起（省掉一次解析）。
	 */
	private readonly _loadingFolders = new Set<string>();
	/** 待自动索引的 folder（归一化 fsPath → 原始 fsPath） */
	private readonly _pendingIndex = new Map<string, string>();

	/**
	 * **被延迟加载**的 folder（归一化 fsPath → 原始 fsPath，2026-09-15 方案 C）。
	 *
	 * 判据：**非主 root**（不在 `folders[0]`）且其 `graph.db.zst` 超过
	 * `saros.codebaseGraph.deferLargeNonPrimaryRootsMB`（默认 5MB）。
	 * 这些 folder 的图**不**在打开/切换工作区时加载，改为
	 * `ensureDeferredGraphsLoaded()`（codebase 工具 / 子代理预检会调）时再加载。
	 */
	private readonly _deferredFolders = new Map<string, string>();

	constructor(
		@ICodebaseGraphService private readonly _graphService: ICodebaseGraphService,
		@ICodebaseMemoryMcpService private readonly _cbmService: ICodebaseMemoryMcpService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();

		// Subscribe to index progress logs
		this._register(this._graphService.onDidIndexProgress(line => {
			this._logService.info(LOG_TAG, line);
		}));

		this._register(this._graphService.onDidIndexComplete(result => {
			if (!result.success) {
				this._logService.warn(LOG_TAG, `Auto-index failed: ${result.message}`);
				return;
			}
			this._logService.info(LOG_TAG, `Auto-index complete: ${result.message}`);
			// 启动文件监听（增量重索引触发源，P2-#8）
			//
			// ① 增量索引由 **watcher 自己**触发（watcher 必然已存在、排除集未变）⇒ **无需**刷新：
			//    旧实现每轮都重启一次 ⇒ 重跑 `_excludeResolver.resolve()`（读 `.cbmignore` + 工作区配置）
			//    + 替换 root 条目 + `[exclude]` / `Starting graph watcher` / `Watching` 三条日志。
			//    用户 2026-09-15 日志里正是「每轮增量完成后紧跟这三条」。
			if (result.kind === 'incremental') { return; }
			// ② ★ 用「**刚完成索引的那个 root**」而不是 `_primaryFolder()`（= folders[0]）：
			//    多 folder 工作区下否则永远只刷新第一个 folder 的 watcher，而真正可能改了排除集
			//    （索引会写 `.cbmignore`）的那个 folder 的 watcher 永不刷新。
			//    与 `_onWatcherChange`（用事件携带的 `rootPath`）/ `_resolveActiveProject`
			//    是同一条教训：「别用 folders[0] 代替事件所属 root」。
			void this._startWatching(result.rootPath || this._primaryFolder());
		}));

		// Listen for workspace folder changes
		this._register(this._workspaceService.onDidChangeWorkspaceFolders((e: IWorkspaceFoldersChangeEvent) => {
			// ★ 2026-09-16 诊断：本回调在 `onDidChangeWorkspaceFolders` 的**同步 fire** 里跑
			// （即 `configurationService.updateWorkspaceAndInitializeConfiguration` 的那一步）⇒
			// 这里打的任何重活都直接算在「切换耗时」上。阶段标记供看门狗事后补报。
			wsStage(`switch: folder 变化回调（图谱 bootstrap，+${e.added.length} -${e.removed.length}）`);
			const tHandler = Date.now();
			// ★★★ 2026-09-15（用户日志实证）：**必须先忘掉已离开工作区的 folder**。
			//
			// 事故（日志 `vscode-app-1789479656705.log`）：窗口从 `S1Game + UE5EA` 切到本仓（3 根）时
			//   · service 侧 `_pruneForeignProjects()` 已把 store 里的 S1Game 图丢掉（`store nodes=0` ✓）；
			//   · 但**本贡献类的集合没跟着清**：`_readyFolders` 仍含 S1Game、`_deferredFolders` 仍含 UE5EA
			//     ⇒ 两个后果：
			//     ① 切回 S1Game 时 `_bootstrap()` 的 `toLoad` 过滤 `!this._readyFolders.has(key)`
			//        会**跳过加载** ⇒ store 里没有图（用户视角「图谱空了」），只能靠 sqlite 兜底；
			//     ② 在别的工作区里用 codebase 功能 ⇒ `ensureDeferredGraphsLoaded()` 会把
			//        **UE5EA 的 25MB 巨图**读进内存（它已不属于本窗口）—— 正是方案 C 要避免的重活 ✗。
			// ⇒ 修剪口径与 prune **保持一致**：只保留当前工作区仍存在的 folder。
			this._forgetFoldersNotInWorkspace('workspace folders changed');
			// ★ 2026-09-16 诊断：把「同步部分」的耗时明确打出来 —— 这一步是 `onDidChangeWorkspaceFolders`
			// **同步链**上的，用户感知的「卡住」就是这条链（图谱加载虽然已推迟到下一个任务，
			// 但那条任务随后同样跑在主线程上，见 `_bootstrap` 的阶段标记与 loadGraphMerge 耗时）。
			this._logService.info(LOG_TAG, `folder 变化回调的同步部分完成（${Date.now() - tHandler}ms；图谱加载已推迟到下一个任务）`);
			if (e.added.length > 0) {
				// ★★★ 2026-09-16（用户报「切工作区卡住」的实测结论）：**切换后不再立刻加载图谱**，
				// 改为**按需加载**（首次用到 codebase 时）—— 由 `_bootstrap({ deferLoads: true })` 登记。
				//
				// 历程与数据：
				//   · 2026-09-15 只把加载 `setTimeout(…, 0)` 推到切换之后 —— 但**加载本身仍在跑**：
				//     实测一次 3.6~6s（`bootstrap 完成（本轮共 3860ms）` = 解压 240ms + 解析 1712ms
				//     + 写入 store 834ms + …），期间主线程被**切片式占满** —— 看门狗实测
				//     `⚠ 交互延迟 … 最慢一次排队 ≈584ms`（用户点一下要等半秒），这正是「卡住」的来源。
				//   · 而加载**不参与切换的可见结果**（folder / sideview / 配置）⇒ 与方案 C 同一逻辑：
				//     放到**真正要用图**时再加载。
				//
				// 三个「真正要用图」的入口都已覆盖：
				//   ① codebase 工具预检 `codebaseTools.ensureGraph()` → `ensureDeferredGraphsLoaded()`；
				//   ② 子代理预检 `delegate_task` → 同上；
				//   ③ **codebase UI**（Find Symbol / Open File）→ `ensureGraphForUi()` 也会先触发它
				//      ⚠ 不加这条，UI 会误判「无图」而直接发起**全量索引**（方向完全错、且重得多）。
				setTimeout(() => {
					this._bootstrap({ deferLoads: true }).catch(err => this._logService.error(LOG_TAG, 'Re-bootstrap failed:', err));
				}, 0);
			}
		}));

		// 懒加载：不在 app 启动时立即加载图谱。
		// 18w+ 节点的解压 + 反序列化 + BM25 重建是 CPU/内存密集的重活，
		// 若在启动阶段与 getAgents（磁盘 IO）、插件激活、Codebuddy /v3/config
		// 等任务并发执行，会把 CPU + 内存 + 磁盘同时打满 → 初次打开工作流"整个电脑卡"。
		// 改为 runWhenGlobalIdle 延迟到 UI 空闲后再后台加载（时间切片已保证不冻结交互）。
		this._register(runWhenGlobalIdle(() => {
			this._bootstrap().catch(err => this._logService.error(LOG_TAG, 'Bootstrap failed:', err));
		}));

		// ★ 方案 C：把「按需加载被延迟的图谱」暴露给服务层 ——
		// 供 codebase 工具预检（`codebaseTools.ensureGraph()`）与
		// 子代理预检（`delegationTools._ensureGraphReadyForExplore()`）调用。
		this._register(this._graphService.registerDeferredGraphLoader(reason => this._loadDeferredGraphs(reason)));
	}

	private _normalize(p: string): string {
		return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
	}

	private _basename(p: string): string {
		const norm = p.replace(/[\\/]+$/, '').replace(/\\/g, '/');
		const idx = norm.lastIndexOf('/');
		return idx >= 0 ? norm.substring(idx + 1) : norm;
	}

	private _primaryFolder(): string {
		const folders = this._workspaceService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri.fsPath : '';
	}

	/**
	 * 忘掉**已不属于当前工作区**的 folder（`_readyFolders` / `_deferredFolders` / `_pendingIndex`）。
	 *
	 * 与 service 侧 `_pruneForeignProjects()` 是**同一件事的两半**：那一半丢内存图，
	 * 这一半丢「本贡献类对 folder 的记账」。只做一半 ⇒ 两边状态互相矛盾（后果见调用点注释）。
	 *
	 * ⚠ 为什么是「与当前工作区求交集」而不是「整体清空」：folder 事件也可能只是**新增**一个 root，
	 * 此时其余 folder 的图仍在 store 里、确实 ready ✓；整体清空会让它们被**重复加载**
	 * —— 本文件顶部记过那条教训：同一制品被合并两次 ⇒ 49.6% 节点冗余。
	 */
	private _forgetFoldersNotInWorkspace(reason: string): void {
		const current = new Set(this._workspaceService.getWorkspace().folders.map(f => this._normalize(f.uri.fsPath)));
		let ready = 0;
		let deferred = 0;
		let pending = 0;
		for (const key of [...this._readyFolders]) {
			if (!current.has(key)) { this._readyFolders.delete(key); ready++; }
		}
		for (const key of [...this._deferredFolders.keys()]) {
			if (!current.has(key)) { this._deferredFolders.delete(key); deferred++; }
		}
		for (const key of [...this._pendingIndex.keys()]) {
			if (!current.has(key)) { this._pendingIndex.delete(key); pending++; }
		}
		if (ready || deferred || pending) {
			this._logService.info(LOG_TAG, `forgot folders that left the workspace (${reason}): ready=${ready}, deferred=${deferred}, pendingIndex=${pending}`);
		}
	}

	/**
	 * 判定工作区是否由 `.code-workspace` 文件打开（区别于「从文件夹添加」）。
	 * 检查每个 folder 根目录是否直接存在 `.code-workspace` 文件（与
	 * codebaseMemoryMcpService._initWorkspaceFileConfig 的根目录检测口径一致）。
	 * 任何 folder 命中即视为 code-workspace 工作区。
	 */
	private async _hasCodeWorkspaceFile(): Promise<boolean> {
		try {
			const folders = this._workspaceService.getWorkspace().folders;
			for (const f of folders) {
				try {
					const rootStat = await this._fileService.resolve(f.uri);
					if (!rootStat?.children) { continue; }
					const has = rootStat.children.some(c =>
						!c.isDirectory && (c.name ?? '').toLowerCase().endsWith('.code-workspace'));
					if (has) { return true; }
				} catch { /* 单个 folder 不可读，跳过 */ }
			}
		} catch { /* ignore */ }
		return false;
	}

	private async _bootstrap(opts?: { deferLoads?: boolean }): Promise<void> {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			this._logService.info(LOG_TAG, 'No workspace folder open, skipping.');
			return;
		}

		this._logService.info(LOG_TAG, `Bootstrapping ${folders.length} workspace folder(s): ${folders.map(f => f.uri.fsPath).join(', ')}`);
		// ★ 2026-09-16 诊断（用户报「切换工作区就卡住」）：本方法在工作区 folder 变化后被 `setTimeout(…,0)`
		// 触发，紧接着就是**同步的解压+解析+合并**（实测 5.4s/16 万节点）⇒ 打阶段标记供看门狗事后补报。
		wsStage(`graph: bootstrap（${folders.length} 个 folder 待检查）`);
		const tBootstrap = Date.now();

		// 2026-08-19：从文件夹添加工作区（根目录无 .code-workspace 文件）时【禁用自动索引】。
		// 已有图照常合并加载 + 启动 watcher（增量）；只有「无图」时才走 auto-index，且仅当
		// 存在 .code-workspace 文件才允许。无 .code-workspace 的裸文件夹/多项目父目录，
		// 索引改由 LLM 在 codebase 工具触发时询问用户后手动发起（见 codebaseTools.noGraphGuidance）。
		const allowAutoIndex = await this._hasCodeWorkspaceFile();

		// 收集需要合并加载的 folder（不含已 ready 的、也不含**正在加载中**的）
		const toLoad = folders.filter(f => {
			const key = this._normalize(f.uri.fsPath);
			return !this._readyFolders.has(key) && !this._loadingFolders.has(key);
		});

		// ★ 方案 C 判据（2026-09-15 用户裁决）：非主 root 的大图**延迟加载**。
		// 判据本体在 `common/codebaseIndexDefaults.shouldDeferGraphLoad()`（纯函数、可单测）。
		const deferMB = this._configurationService.getValue<number>('saros.codebaseGraph.deferLargeNonPrimaryRootsMB') ?? 5;

		for (let i = 0; i < toLoad.length; i++) {
			const folder = toLoad[i];
			const key = this._normalize(folder.uri.fsPath);
			const project = this._basename(folder.uri.fsPath) || '_default';
			const graphFileUri = URI.joinPath(folder.uri, '.codebase-memory', 'graph.db.zst');

			// ★★★ 非主 root 的大图 ⇒ **不在打开/切换工作区时加载**（用户裁决方案 C）。
			//
			// 为什么：图谱解压/反序列化是 CPU/内存密集的**同步**重活 —— 实测
			// sarosis 8.2MB ⇒ 21.6s / 17.9 万节点、S1Game 7MB ⇒ 6.8s / 16 万节点、
			// **UE5EA 24.6MB ⇒ 数十秒 / 87.6 万节点** ⇒ 每次切到「含大图非主 root」的工作区
			// 整窗卡死数十秒（用户报「切换工作区后 app 卡死」）。
			//
			// 而**默认检索作用域只到主 root**（`_resolveActiveProject()` 按 folder 顺序取第一个
			// 有映射的项目，`searchGraphAsync` 用 `params.project ?? _projectName`）
			// ⇒ 非主图对「打开工作区」这个动作并不必要 ⇒ 延迟到**真正用到**时（codebase 工具 /
			// 子代理预检会调 `ensureDeferredGraphsLoaded()`）再加载 ✓。
			//
			// 小图（实测 pocket/marketplace ~0MB）照常加载 ⇒ 检索完整性不受影响 ✓。
			// 阈值 0 = 关闭延迟（保持旧行为：打开工作区即加载全部）。
			const folderIndex = folders.findIndex(f => this._normalize(f.uri.fsPath) === key);
			const alreadyDeferred = this._deferredFolders.has(key);
			// ★ 2026-09-16：**切换触发**（`deferLoads`）时要**不问大小**地延迟 ⇒ 必须拿到体积；
			// 其余情况维持原优化（只对「可能被延迟」的 folder 才 stat，避免无谓 IO）。
			const wantDeferLoad = opts?.deferLoads === true;
			const sizeBytes = (wantDeferLoad || (deferMB > 0 && folderIndex > 0 && !alreadyDeferred))
				? await this._sizeBytes(graphFileUri)
				: 0;

			// ★★★ 2026-09-16（切换触发的按需加载）：**制品存在就延迟**，与大小无关。
			// 依据见 folder 变化回调处的说明（切换 99~157ms vs 加载 3.6~6s + 交互延迟 ≈0.58s）。
			// ⚠ 制品**不存在**（`sizeBytes === 0`）时**不能**延迟 —— 必须落到下面「无图 ⇒ 排自动索引」
			//    的原路，否则新加入工作区的 folder 永远不会被索引。
			if (wantDeferLoad && sizeBytes > 0) {
				if (!alreadyDeferred) {
					this._deferredFolders.set(key, folder.uri.fsPath);
					this._logService.info(LOG_TAG, `Deferring graph for "${project}" until first codebase use — workspace switch must stay instant (artifact ${(sizeBytes / 1024 / 1024).toFixed(1)} MB).`);
				}
				continue;
			}

			if (shouldDeferGraphLoad(folderIndex, sizeBytes, deferMB, alreadyDeferred)) {
				this._deferredFolders.set(key, folder.uri.fsPath);
				if (!alreadyDeferred) {
					this._logService.info(LOG_TAG, `Deferring large non-primary root graph for "${project}" (${Math.round(sizeBytes / 1024 / 1024)} MB > ${deferMB} MB) — loads on first codebase use.`);
				}
				continue;
			}

			// 合并加载；BM25 仅在最后一个 folder 加载后重建一次（避免重复重建开销）
			const isLast = i === toLoad.length - 1;
			let loaded = false;
			this._loadingFolders.add(key);
			// ★ 2026-09-16 诊断：**每个 folder 的加载耗时**单独打一行（旧日志只有 service 内部的
			// `merged … (Xms)`，看不出「是哪个 folder 慢、以及它相对本轮的其它步骤如何」）。
			const tFolder = Date.now();
			try {
				loaded = await this._graphService.loadGraphMerge(graphFileUri.fsPath, project, isLast);
			} catch { /* 读取/解析异常，落入下方区分逻辑 */ } finally {
				this._loadingFolders.delete(key);
			}
			this._logService.info(LOG_TAG, `loadGraphMerge("${project}") 返回 ${loaded}，耗时 ${Date.now() - tFolder}ms`);
			// ★★★ 2026-09-15（用户日志 `vscode-app-1789480447320.log`）：
			// **「加载成功但 0 节点」必须按「没加载」处理**。
			//
			// 实测：被落盘竞态写坏的 **99 字节** `graph.db.zst` **仍能成功解压成一张空图**
			// ⇒ `loadGraphMerge` 返回 `true` ⇒ 旧代码在此直接 `_readyFolders.add(key)` 并打印
			// 「Loaded existing graph」—— 于是该 folder **永远不会重建** ✗✗
			// （日志实证：`merged ... (131ms), store nodes=0` 紧跟
			//  `Loaded existing graph for folder "sarosis-agents-client".`）。
			//
			// ⇒ 空图不算 ready，让它落到下面「制品存在但加载失败」的分支；
			//   空制品由 `EMPTY_ARTIFACT_BYTES` 判据**放行** ⇒ 允许 auto-index 把它重建回来 ✓。
			// 注（2026-09-16）：service 侧现在**自己**就把「解析成功但 0 节点」判为 `false`（并置
			// `isLastMergeEmpty` 标记）⇒ 下面这段是**双保险**，防止将来有人改动 service 语义而这里失守。
			const mergedNodes = loaded ? this._graphService.getProjectNodeCount(project) : 0;
			if (loaded && mergedNodes === 0) {
				this._logService.warn(LOG_TAG, `Graph for "${project}" merged but the store holds 0 nodes — treating as NOT loaded (empty / truncated artifact).`);
			}
			if (loaded && mergedNodes > 0) {
				this._logService.info(LOG_TAG, `Loaded existing graph for folder "${project}".`);
				this._readyFolders.add(key);
				this._pendingIndex.delete(key);
				// 多 folder：每个已加载 folder 单独启动监听（增量索引，互不覆盖）
				await this._startWatching(folder.uri.fsPath);
				continue;
			}

			// 2026-09-15：用户可能在合并加载期间就切走了工作区（切换不 reload renderer）——
			// 此时该 folder 已不属于本窗口，`loadGraphMerge` 会**主动丢弃**它（防跨工作区污染）。
			// 必须在这里静默跳过，否则会打出「制品存在但加载失败」的**假警报**，把真正原因盖掉。
			const stillInWorkspace = this._workspaceService.getWorkspace().folders
				.some(f => this._normalize(f.uri.fsPath) === key);
			if (!stillInWorkspace) {
				this._logService.info(LOG_TAG, `Folder "${project}" left the workspace during load — skipping (no auto-index).`);
				continue;
			}

			// 未加载成功：区分「图文件存在但加载失败」与「图文件缺失」。
			// 图文件存在但加载失败（如过大/损坏/内存不足）时【跳过自动索引】——
			// 否则会对超大图谱反复全量重建（用户视角"莫名扫描"），且几乎必然再次失败。
			// 此时保留内存/sqlite 兜底读取，用户可手动触发索引。
			let graphFileExists = false;
			let artifactBytes = 0;
			try {
				const artifactStat = await this._fileService.stat(graphFileUri);
				graphFileExists = true;
				artifactBytes = artifactStat.size;
			} catch { /* 文件不存在 */ }

			// ★★★ 2026-09-15（数据丢失事故的**善后**）：**空制品**不能按「加载失败」处理。
			//
			// 事故背景：落盘竞态曾把 8.2MB / 176620 节点的 `graph.db.zst` 覆盖成 **99 字节**
			// （根因与本侧守卫见 `_saveGraph` / `_pruneForeignProjects` 的注释）。
			// 那个文件**仍然存在**，于是会命中下面这条「制品存在但加载失败 ⇒ 跳过 auto-index」
			// ⇒ 用户从此**既没有图、也永远不会重建** ✗（"制品在，却什么都没有"）。
			//
			// 判据：< 1KB 的制品不可能是「过大/损坏/OOM」那一类 —— 那条保护是为几十 MB 的巨图设的。
			// 小于阈值只可能是**被写坏 / 被截断** ⇒ 应当**允许自动索引**把它重建回来 ✓。
			//
			// ★★★ 2026-09-16（用户报「PJDB\S1Game 一份 **10KB** 空图永远不重建」）：
			// **字节数只是代理，不是判据** —— 落盘竞态写出的空图完全可能是 10KB（能正常解压、零节点），
			// 只比字节数就会把它归进「巨图损坏 ⇒ 跳过」，于是同样**既没有图、也永远不会重建** ✗。
			// 现改用**事实**：`isLastMergeEmpty()`（service 在紧邻的 `loadGraphMerge` 里记录
			// 「解析成功但 0 节点」）⇒ 与文件大小无关地允许重建；
			// 字节数只保留给「**连解析都没成功**」的碎片 —— 那种情况无法判断内容，只能靠体积论证
			// 「不可能是巨图」（这条是既有裁决：对超大/损坏图谱反复全量重建远比不加载糟糕）。
			const EMPTY_ARTIFACT_BYTES = 1024;
			const parsedButEmpty = this._graphService.isLastMergeEmpty(folder.uri.fsPath);
			if (graphFileExists && artifactBytes >= EMPTY_ARTIFACT_BYTES && !parsedButEmpty) {
				this._logService.warn(LOG_TAG, `Graph artifact exists but failed to load for "${project}" — skipping auto-index to avoid full rescan (artifact may be too large / corrupted / OOM). Use in-memory/sqlite fallback or manually re-index.`);
				continue;
			}
			if (graphFileExists) {
				this._logService.warn(LOG_TAG, parsedButEmpty
					? `Graph artifact for "${project}" is a VALID but EMPTY graph (${artifactBytes} bytes, 0 nodes) — treating it as missing and allowing re-index.`
					: `Graph artifact for "${project}" is effectively EMPTY (${artifactBytes} bytes) and did not load — treating it as missing and allowing re-index.`);
			}

			// 无既有图谱 → 加入待索引队列。
			// 区分"首次索引"与"图谱丢失"：.codebase-memory 目录存在但 graph.db.zst 缺失，
			// 说明图谱曾被创建过（外部删除 / 保存中断 / 引擎目录被刷新），值得 warn 提醒。
			let graphLost = false;
			try {
				await this._fileService.stat(URI.joinPath(folder.uri, '.codebase-memory'));
				graphLost = true;
			} catch { /* 目录也不存在 = 首次索引 */ }
			if (!allowAutoIndex) {
				this._logService.info(LOG_TAG, `No existing graph for folder "${project}", but auto-index is disabled (no .code-workspace file) — deferring to manual/LLM-triggered indexing.`);
				continue;
			}
			if (graphLost) {
				this._logService.warn(LOG_TAG, `Graph artifact missing but .codebase-memory dir exists for "${project}" (external deletion or interrupted save?), scheduling auto-index...`);
			} else {
				this._logService.info(LOG_TAG, `No existing graph for folder "${project}", scheduling auto-index...`);
			}
			this._pendingIndex.set(key, folder.uri.fsPath);
		}

		if (this._pendingIndex.size > 0) {
			this._scheduleAutoIndex();
		}

		// ★ 2026-09-16 诊断：本轮 bootstrap 的总耗时（含各 folder 的同步解压/合并）。
		// 用户报「切换工作区就卡住」时，这一行与上面的「阶段耗时」行一起，能确定「卡的是加载还是别的」。
		this._logService.info(LOG_TAG, `bootstrap 完成（本轮共 ${Date.now() - tBootstrap}ms；待索引 ${this._pendingIndex.size} 个 folder，图谱加载已推迟 ${AUTO_INDEX_DELAY_MS}ms）`);
	}

	/** `uri` 的字节数（不存在/读不到 ⇒ 0 ⇒ 判据按"不延迟"处理，保持旧行为）。 */
	private async _sizeBytes(uri: URI): Promise<number> {
		try {
			const stat = await this._fileService.stat(uri);
			return stat.size;
		} catch {
			return 0;
		}
	}

	/**
	 * 加载**被延迟**的非主 root 大图（方案 C 的「按需」半边）。
	 *
	 * 由 `ICodebaseGraphService.ensureDeferredGraphsLoaded()` 触发
	 * （codebase 工具预检 / 子代理预检）。语义：
	 *   · 一次取走集合并清空 ⇒ 重复调用是空操作（服务侧还有 in-flight 去重）；
	 *   · 顺序加载，**最后一个**才重建 BM25 —— 与 `_bootstrap()` 同口径：store 跨项目，
	 *     必须等全部合并完再重建一次，否则新加入的节点不进 BM25 ⇒ 搜不到；
	 *   · 失败只 warn 且**不** auto-index —— 与 `_bootstrap()` 里「artifact 存在但加载失败
	 *     ⇒ 跳过自动索引」同一教训：对超大/损坏图谱反复全量重建远比不加载糟糕
	 *     （用户视角"莫名扫描"）。
	 */
	private async _loadDeferredGraphs(reason: string): Promise<void> {
		if (this._deferredFolders.size === 0) { return; }
		const current = new Set(this._workspaceService.getWorkspace().folders.map(f => this._normalize(f.uri.fsPath)));
		const all = [...this._deferredFolders.entries()];
		this._deferredFolders.clear();

		// ★ 必须先**过滤掉已不属于本窗口**的 folder（延迟期间用户可能已切走工作区，
		//   切换不 reload renderer）—— 否则会把旧工作区的巨图读进内存（正是方案 C 要避免的重活）。
		// ⚠ 顺序很重要：**先过滤，再算 isLast**。否则"最后一个"可能正是被跳过的那个，
		//   导致 BM25 不重建（`loadGraphMerge(..., rebuildBM25=false)` 全部落空）⇒ 新合并的节点搜不到。
		const pending = all.filter(([key]) => current.has(key));
		const left = all.filter(([key]) => !current.has(key));
		if (left.length > 0) {
			this._logService.info(LOG_TAG, `Deferred load (${reason}): discarding ${left.length} folder(s) that left the workspace: ${left.map(([, p]) => this._basename(p)).join(', ')}`);
		}
		if (pending.length === 0) { return; }
		this._logService.info(LOG_TAG, `Loading ${pending.length} deferred graph(s) on demand (${reason}): ${pending.map(([, p]) => this._basename(p)).join(', ')}`);

		for (let i = 0; i < pending.length; i++) {
			const key = pending[i][0];
			const fsPath = pending[i][1];
			const project = this._basename(fsPath) || '_default';
			const graphFileUri = URI.joinPath(URI.file(fsPath), '.codebase-memory', 'graph.db.zst');
			const isLast = i === pending.length - 1;

			let loaded = false;
			this._loadingFolders.add(key);
			try {
				loaded = await this._graphService.loadGraphMerge(graphFileUri.fsPath, project, isLast);
			} catch { /* 落到下方处理 */ } finally {
				this._loadingFolders.delete(key);
			}

			if (loaded) {
				this._readyFolders.add(key);
				this._logService.info(LOG_TAG, `Deferred graph for "${project}" loaded on demand.`);
				await this._startWatching(fsPath);
			} else {
				this._logService.warn(LOG_TAG, `Deferred graph for "${project}" failed to load — keeping it unloaded (no auto-index).`);
			}
		}
	}

	private _scheduleAutoIndex(): void {
		if (this._pendingIndex.size === 0) { return; }
		clearTimeout(this._autoIndexTimer);
		this._autoIndexTimer = setTimeout(() => {
			this._autoIndex().catch(err =>
				this._logService.warn(LOG_TAG, 'Auto-index failed:', err));
		}, AUTO_INDEX_DELAY_MS);
	}

	/**
	 * 读取用户在「代码库索引」面板保存的配置（P2）。
	 * 此前 auto-index 硬编码 `mode:'fast'` + `excludeDirs:[]`，完全绕过用户配置，
	 * 导致「面板里改了排除目录，但启动自动索引仍按默认扫」。
	 */
	private async _readUserIndexConfig(): Promise<IUserIndexConfig | undefined> {
		try {
			await this._cbmService.ensureConfigReady();
			return this._cbmService.getIndexConfig();
		} catch (err: any) {
			this._logService.warn(LOG_TAG, `Failed to read user index config, falling back to defaults: ${err?.message || err}`);
			return undefined;
		}
	}

	/** 启动 watcher，并把用户配置的排除目录一并传入（否则 watcher 与索引扫描口径不一致）。 */
	private async _startWatching(rootPath: string): Promise<void> {
		if (!rootPath) { return; }
		const userConfig = await this._readUserIndexConfig();
		this._graphService.startWatching(rootPath, userConfig?.excludeDirs, userConfig?.keepDirs);
	}

	private async _autoIndex(): Promise<void> {
		// [TRACE] codebaseGraphBootstrap._autoIndex 入口
		this._logService.info(LOG_TAG, `[TRACE] codebaseGraphBootstrap._autoIndex triggered: pending=${this._pendingIndex.size} folders`);
		const userConfig = await this._readUserIndexConfig();
		// subPath 是全局单值配置：多 folder 工作区下无法判定它属于哪个 folder，故仅单 folder 时透传
		const singleFolder = this._workspaceService.getWorkspace().folders.length === 1;
		// 逐 folder 索引（每个 folder 用其目录名作为唯一项目名，避免多 folder 覆盖）
		const pending = [...this._pendingIndex.entries()];
		for (const [key, rootPath] of pending) {
			// 2026-09-15：自动索引有 5s 延迟（AUTO_INDEX_DELAY_MS），期间用户可能已切走工作区
			// （切换不 reload renderer）⇒ 该 folder 不再属于本窗口，**不得**再为它建图。
			const stillInWorkspace = this._workspaceService.getWorkspace().folders
				.some(f => this._normalize(f.uri.fsPath) === key);
			if (!stillInWorkspace) {
				this._pendingIndex.delete(key);
				this._logService.info(LOG_TAG, `Skipped auto-index for "${rootPath}" — left the workspace before the delay elapsed.`);
				continue;
			}
			const project = this._basename(rootPath) || '_default';
			const config: IIndexConfig = {
				mode: userConfig?.mode ?? 'fast',
				excludeDirs: userConfig?.excludeDirs ?? [], // 空 = 仅用默认；graphService 会与默认表取并集
				keepDirs: userConfig?.keepDirs,
				subPath: singleFolder ? userConfig?.subPath : undefined,
				projectName: project,
			};
			this._logService.info(LOG_TAG, `Starting auto-index: ${rootPath} (project=${project}, mode=${config.mode}, exclude=${config.excludeDirs.length} items, subPath=${config.subPath || '(none)'})`);
			try {
				const result = await this._graphService.indexWorkspace(rootPath, config);
				if (result.success) {
					this._readyFolders.add(key);
					this._pendingIndex.delete(key);
					// 多 folder：每个已索引 folder 单独启动监听（增量索引，互不覆盖）。
					// keepDirs 一并透传：与全量索引扫描口径一致（否则 Content/script 等保留目录
					// 在 watcher/增量扫描中被整目录排除，产生幻影 deleted）。
					this._graphService.startWatching(rootPath, config.excludeDirs, config.keepDirs);
					this._logService.info(LOG_TAG, `Auto-index completed for "${project}": ${result.message}`);
				}
			} catch (err: any) {
				this._logService.warn(LOG_TAG, `Auto-index failed for "${project}": ${err?.message || err}`);
			}
		}
	}
}



registerWorkbenchContribution2(
	CodebaseGraphBootstrapContribution.ID,
	CodebaseGraphBootstrapContribution as any,
	WorkbenchPhase.AfterRestored,
);
