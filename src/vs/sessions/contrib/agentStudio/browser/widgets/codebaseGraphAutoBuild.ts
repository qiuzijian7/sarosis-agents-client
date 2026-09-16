/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「无图也能用」的共用逻辑（2026-09-15，用户要求）。
 *
 * 背景：Find Symbol（Alt+Shift+S）/ Open File in Solution（Alt+Shift+O）以前在 `run()` 首行
 * `if (!graphService.hasGraphData()) { logService.info(...); return; }` 上**静默返回** ——
 * 图谱未构建时按快捷键连 UI 都不弹，用户只看到「按了没反应」。现在两个模态改为**无条件打开**，
 * 由本模块负责打开后的三件事：
 *
 *  ① 图谱可用（含 SQLite-only 场景）→ 直接刷新列表（正常路径，不打扰）；
 *  ② **尚未构建** → 在 UI 内提示并**自动触发建图**，把 `onDidIndexProgress` 的进度行实时写进
 *     提示条，完成后自动刷新列表；
 *  ③ 失败 / 无工作区 / 索引锁被其他窗口占用 → 给出**可读原因**（不再静默）。
 *
 * ★ 为什么配置读取在这里而不是 service：`ICodebaseMemoryMcpService` 依赖
 * `ICodebaseGraphService`（它调用 `indexWorkspace`），service 反向依赖会成环 ⇒ 只能由模态层
 * 读取用户配置（可同时注入两者，与 `codebaseGraphBootstrap._readUserIndexConfig` 同口径）。
 */

import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/path.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { GRAPH_LOAD_DONE_PREFIX, ICodebaseGraphService, IIndexConfig } from '../codebaseGraphService.js';
import { ICodebaseMemoryMcpService } from '../codebaseMemoryMcpService.js';

export type GraphNoticeKind = 'info' | 'progress' | 'success' | 'warn' | 'error';

/** 提示区宿主：由模态实现（`CodebaseGraphModal.setNotice` + 自己的列表刷新）。 */
export interface IGraphNoticeHost {
	/** `kind` 可省（缺省 info）；传空串 = 清空/隐藏提示条（见 `CodebaseGraphModal.setNotice`）。 */
	setNotice(text: string, kind?: GraphNoticeKind): void;
	/** 图谱就绪（本来就有 / 刚建好）→ 调用方刷新列表。 */
	refresh(): void;
}

const TAG = '[CodebaseGraph:AutoBuild]';

/**
 * 保证「UI 有图可用」：已就绪则直接 refresh；未构建则自动建图并把进度写进提示区。
 *
 * @param disposables 调用方（模态）自己的 store —— 进度/完成监听随模态关闭一并释放
 *                    （模态内部 store 已接 `CodebaseGraphModal.onDispose`，不会泄漏）。
 */
export async function ensureGraphForUi(
	deps: {
		graphService: ICodebaseGraphService;
		cbmService: ICodebaseMemoryMcpService;
		workspaceService: IWorkspaceContextService;
		logService: ILogService;
	},
	host: IGraphNoticeHost,
	disposables: DisposableStore,
): Promise<void> {
	const { graphService, cbmService, workspaceService, logService } = deps;

	// refresh **去重**：`onDidIndexComplete` 与 `indexWorkspace()` 的 resolve 会先后触发，
	// 不去重就会刷新两次 —— 对模态是白跑一次搜索，对 QuickPick 命令是**弹出两个 picker**。
	let refreshed = false;
	const refreshOnce = () => {
		if (refreshed) { return; }
		refreshed = true;
		host.refresh();
	};

	// ★ **加载**进展无条件订阅（不只制品合并那条路径）：
	//   ① `_loadGraphFromSqlite()`（SQLite 按需载入，实测 13~32s —— 正是用户日志里「LLM 输出时
	//      app 无响应」的那条）也会发进展，且它没有独立完成事件 ⇒ 用终态前缀 `GRAPH_LOAD_DONE_PREFIX`
	//      告知「已结束」，此时清提示并刷新列表；
	//   ② 若加载在 UI 打开**之后**才开始（并发工具/延迟加载触发），这里也能让用户看到状态。
	disposables.add(graphService.onDidGraphLoadProgress(line => {
		if (line.startsWith(GRAPH_LOAD_DONE_PREFIX)) { host.setNotice(''); refreshOnce(); return; }
		host.setNotice(`代码图谱正在加载：${line} —— 请稍候…`, 'progress');
	}));

	// ① 快速路径：内存 store 里已有图 → 直接刷新（不打扰、无 await 抖动）
	if (graphService.hasGraphData()) { refreshOnce(); return; }

	// ①b ★★★ 2026-09-16：**切换工作区后的图谱是「按需加载」的**（见 bootstrap 的 folder 变化回调：
	// 加载一次 3.6~6s 且期间交互延迟实测 ≈0.58s ⇒ 不再在切换后立刻加载）。
	// 「打开 codebase UI」正是「真正要用图」的入口之一 ⇒ 这里主动触发它。
	// ⚠ 必须**早于**「无图 ⇒ 自动建图」的判断：否则会退化成**全量索引** —— 磁盘上明明有现成制品，
	// 那既重得多、方向也错（用户日志里 `bootstrap 完成（待索引 0 个 folder）` 正是「有制品」的证据）。
	// 无待加载项时是空操作（幂等 + 进行中去重，见 `ensureDeferredGraphsLoaded`）。
	host.setNotice('代码图谱尚未载入内存，正在按需加载（首次使用需几秒）…', 'progress');
	await graphService.ensureDeferredGraphsLoaded('codebase UI open');
	if (disposables.isDisposed) { return; } // 模态已被用户关掉 ⇒ 不做后续动作
	if (graphService.hasGraphData()) { host.setNotice(''); refreshOnce(); return; }

	// ② **加载中 / 构建中**：显示 codebase 状态并**等它结束**（提示用户稍候）。
	//    ★ 必须排在「未就绪 → 自动建图」之前：加载期间 `isIndexing === false` 且
	//    `hasGraphData() === false`（数据还没进 store），不做区分就会**在加载中再发起一次全量
	//    索引**（与加载抢 store、双倍开销）。加载不发 `onDidIndexProgress` ⇒ 另订阅
	//    `onDidGraphLoadProgress`（见 service 内 `isGraphLoading` 注释）。
	if (graphService.isGraphLoading || graphService.isIndexing) {
		_attachProgress(graphService, host, disposables, refreshOnce);
		await _waitWhileBusy(graphService, host, disposables);
		if (disposables.isDisposed) { return; } // 模态/通知已被用户关掉 ⇒ 不做后续动作
		if (graphService.isGraphLoading || graphService.isIndexing) {
			// 超过等待上限仍在忙（超大图 / 卡住）→ 如实告知，不再尝试建图
			host.setNotice('代码图谱仍在加载/构建中（等待已超 10 分钟）—— 请稍后再试，或在「代码库索引」面板查看进度。', 'warn');
			return;
		}
		// 忙完再判一次数据：加载成功 ⇒ 有数据；制品损坏/为空 ⇒ 落到下面走自动建图
		let nowReady = false;
		try {
			nowReady = await graphService.hasGraphDataAsync();
		} catch {
			nowReady = graphService.hasGraphData();
		}
		if (nowReady) { host.setNotice(''); refreshOnce(); return; }
	}

	// 未就绪就**先给反馈**：这段等待在 `hasGraphDataAsync()` 内部（`whenGraphLoaded` +
	// SQLite 计数）可能有一小段无进展的窗口 —— 先说明状态，提示会在就绪后被清掉。
	host.setNotice('代码图谱数据尚未就绪，正在检查…', 'progress');

	// 再等**异步**就绪判定：`hasGraphDataAsync()` 内部 `await whenGraphLoaded()`
	// （service 契约：所有「图是否有数据」的判定路径必须先等它），并带 SQLite 计数回退
	// （内存 store 空但 SQLite 有数据的场景）。
	let ready = false;
	try {
		ready = await graphService.hasGraphDataAsync();
	} catch {
		ready = graphService.hasGraphData();
	}
	if (ready) { host.setNotice(''); refreshOnce(); return; }

	// ③ 已在索引中（本窗口其他入口 / LLM 工具 / 启动自动索引）→ 只显示进度，不重复发起。
	if (graphService.isIndexing) {
		_attachProgress(graphService, host, disposables, refreshOnce);
		host.setNotice('代码图谱正在构建中，完成后将自动刷新列表…', 'progress');
		return;
	}

	// ④ 解析索引根：优先当前工作区已注册的 root（多 folder 取第一个），其次 workspace folder[0]
	let rootPath = Object.values(graphService.getProjectRoots())[0];
	if (!rootPath) {
		rootPath = workspaceService.getWorkspace().folders[0]?.uri.fsPath ?? '';
	}
	if (!rootPath) {
		host.setNotice('未打开工作区文件夹，无法构建代码图谱 —— 请先打开一个文件夹后重试。', 'warn');
		return;
	}

	const config = await _resolveIndexConfig(cbmService, workspaceService, rootPath, logService);

	_attachProgress(graphService, host, disposables, refreshOnce);
	host.setNotice(`当前工作区尚未构建代码图谱，已自动开始构建（${config.mode} 模式）…`, 'progress');
	logService.info(TAG, `auto build started: root="${rootPath}" project="${config.projectName}" mode=${config.mode}`);

	try {
		const result = await graphService.indexWorkspace(rootPath, config);
		if (result?.success) {
			host.setNotice(`代码图谱构建完成：${result.message}`, 'success');
			refreshOnce();
		} else {
			host.setNotice(`代码图谱构建未完成：${result?.message ?? 'unknown'}`, 'warn');
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		// `_lockIndex` 抛 'Index already locked'（同工作区其他窗口在建图）⇒ 这不是故障，
		// 要给出可读原因，否则用户又回到「没反应」的困惑里。
		host.setNotice(/locked/i.test(msg)
			? '另一个窗口正在构建该工作区的代码图谱（索引锁被占用），请稍后重试。'
			: `代码图谱构建失败：${msg}`, 'warn');
		logService.warn(TAG, `auto build failed for "${rootPath}": ${msg}`);
	}
}

/**
 * 订阅**构建**进展与完成事件，实时刷新提示条。监听随模态关闭（或命令回调）释放。
 *
 * ★ 加载进展不在本函数订阅：`ensureGraphForUi` 里**无条件**订阅（见那里的注释）——
 * 加载可能在 UI 打开之后才开始，挂在这里会漏掉那段窗口；而 `onDidIndexProgress` 只覆盖索引。
 */
function _attachProgress(
	graphService: ICodebaseGraphService,
	host: IGraphNoticeHost,
	disposables: DisposableStore,
	onReady: () => void,
): void {
	disposables.add(graphService.onDidIndexProgress(line => host.setNotice(`正在构建代码图谱：${line} —— 请稍候…`, 'progress')));
	disposables.add(graphService.onDidIndexComplete(result => {
		if (result?.success) {
			host.setNotice(`代码图谱构建完成：${result.message}`, 'success');
			onReady();
		} else {
			host.setNotice(`代码图谱构建失败：${result?.message ?? 'unknown'}`, 'error');
		}
	}));
}

/** 等待上限：超过就如实告知「仍在忙」，而不是无限期显示进度条。 */
const BUSY_WAIT_LIMIT_MS = 10 * 60 * 1000;
/** 状态刷新节拍（同时是加载路径的轮询间隔）。 */
const BUSY_TICK_MS = 500;

/**
 * 等「加载 / 构建」结束，期间以固定节拍刷新提示条（含已等待秒数，让用户确信没有卡死）。
 *
 * - **加载**：没有完成事件 ⇒ 用 `whenGraphLoaded()` 轮询（它内部带超时，返回不代表结束，故循环再判）。
 * - **构建**：`onDidIndexComplete` 会收尾（见 `_attachProgress`），这里只负责状态刷新。
 * - **忙等保护**：`whenGraphLoaded()` 在「非加载」时立即返回 ⇒ 必须补一个 sleep，否则会 500ms
 *   都不停地空转烧 CPU。
 * - **可中断**：UI 关闭（`disposables` 已 dispose）即退出，不做无谓工作。
 */
async function _waitWhileBusy(
	graphService: ICodebaseGraphService,
	host: IGraphNoticeHost,
	disposables: DisposableStore,
): Promise<void> {
	let waitedMs = 0;
	let last = '';
	const setWait = (text: string) => {
		if (text === last) { return; } // 避免同一句重复写 DOM / 通知
		last = text;
		host.setNotice(text, 'progress');
	};
	while (!disposables.isDisposed && (graphService.isGraphLoading || graphService.isIndexing)) {
		const secs = Math.round(waitedMs / 1000);
		if (waitedMs >= BUSY_WAIT_LIMIT_MS) { return; }
		setWait(graphService.isGraphLoading
			? `代码图谱正在加载（已等待 ${secs}s，大图需数十秒）—— 完成后会自动刷新本窗口，请稍候…`
			: `代码图谱正在构建（已等待 ${secs}s）—— 完成后会自动刷新本窗口，请稍候…`);
		await graphService.whenGraphLoaded(BUSY_TICK_MS);
		await new Promise<void>(resolve => setTimeout(resolve, BUSY_TICK_MS));
		waitedMs += BUSY_TICK_MS;
	}
}

/**
 * 给**非模态**入口（`Shift+Alt+F` / `Alt+G` / `Alt+M` 三条 QuickPick 命令）用的宿主：
 * 这些命令没有可挂提示条的窗口，通知是唯一合适的通道 ⇒ 用**一条可更新的通知**
 * （`updateMessage` + 无限进度条）承载「正在构建/构建完成/失败」，
 * 构建完成时回调 `onGraphReady`（调用方通常在这里**重跑本命令**，让 picker 直接出数据）。
 *
 * @param disposables 调用方的监听 store（可选）。★ 传了才有的保护：**用户手动关掉通知**
 *   即释放它 —— 否则「按了几次快捷键都没图」的场景会累积 store（每次一套
 *   `onDidIndexProgress`/`onDidIndexComplete` 监听）与 `_waitWhileBusy` 的 500ms 轮询循环，
 *   而且用户明确关掉后仍会在建图完成时**突然重跑命令**（弹一个他没再要的 picker）。
 */
export function makeNotificationHost(
	notificationService: INotificationService,
	onGraphReady: () => void,
	disposables?: DisposableStore,
): IGraphNoticeHost {
	let handle: INotificationHandle | undefined;
	let progressOn = false;
	return {
		setNotice: (text, kind = 'info') => {
			const severity = kind === 'error' ? Severity.Error : (kind === 'warn' ? Severity.Warning : Severity.Info);
			const wantProgress = kind === 'progress';
			if (!handle) {
				handle = notificationService.notify({
					severity,
					message: text || '代码图谱',
					source: 'codebase-graph',
					progress: wantProgress ? { infinite: true } : undefined,
				});
				progressOn = wantProgress;
				if (disposables && !disposables.isDisposed) {
					const sub = handle.onDidClose(() => {
						sub.dispose();
						// 延到下一个宏任务：不在 Emitter 的回调里同步 dispose 监听列表（正在迭代）
						setTimeout(() => disposables?.dispose(), 0);
					});
				}
				return;
			}
			handle.updateSeverity(severity);
			handle.updateMessage(text || '代码图谱');
			// 进度条按需开关（`INotificationHandle.progress` 支持通知显示后再切换）
			if (wantProgress && !progressOn) { handle.progress.infinite(); progressOn = true; }
			else if (!wantProgress && progressOn) { handle.progress.done(); progressOn = false; }
		},
		refresh: onGraphReady,
	};
}

/**
 * 读用户配置（与 `codebaseGraphBootstrap._autoIndex` 完全同口径）：
 * `ensureConfigReady()` → `getIndexConfig()`；失败/缺失时退回 `{ mode:'fast', excludeDirs: [] }`
 * （空 excludeDirs = 仅用默认表，graphService 会与默认表取并集）。
 * `subPath` 是全局单值配置，多 folder 下无法判定归属 ⇒ 仅单 folder 透传。
 * `projectName` 用 folder basename（多 folder 下每个 folder 唯一项目名，与 bootstrap 一致）。
 */
async function _resolveIndexConfig(
	cbmService: ICodebaseMemoryMcpService,
	workspaceService: IWorkspaceContextService,
	rootPath: string,
	logService: ILogService,
): Promise<IIndexConfig> {
	const singleFolder = workspaceService.getWorkspace().folders.length === 1;
	let userConfig: { mode?: IIndexConfig['mode']; excludeDirs?: string[]; keepDirs?: string[]; subPath?: string } | undefined;
	try {
		await cbmService.ensureConfigReady();
		userConfig = cbmService.getIndexConfig();
	} catch (err: unknown) {
		logService.warn(TAG, `read user index config failed, using defaults: ${err instanceof Error ? err.message : err}`);
	}
	return {
		mode: userConfig?.mode ?? 'fast',
		excludeDirs: userConfig?.excludeDirs ?? [],
		keepDirs: userConfig?.keepDirs,
		subPath: singleFolder ? userConfig?.subPath : undefined,
		projectName: basename(rootPath) || '_default',
	};
}
