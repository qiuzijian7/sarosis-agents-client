/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「弹出窗口 = dsh 官方客户端完整 UI」（2026-10-17，用户拍板的三项决策）：
 *
 *   · 触发：sessions 窗口标题栏右上角的「Pop Out Chat to New Window」（`agentStudio.popoutChat`）；
 *   · 形态：**新开一个独立窗口**，里面整窗承载 dsh 官方 Web Client（`surface='full'`，
 *     带官方侧栏 / 顶栏 / 右侧栏；preload 只对 `surface='chat'` 套 chat-only CSS ✓），
 *     替换掉旧的「自绘聊天框 aux 窗口」；
 *   · 会话：**跟随当前聊天会话** —— 取本窗口最近聚焦聊天视图实际绑定的 dsh 会话 id
 *     （主进程 `describe()` 透出的 `sessionId`），经启动参数传给页面，chat-surface 在页面侧
 *     openSession（同主窗口聊天框的既有通路 ✓）。
 *
 * 承载方式：aux 窗口（`IAuxiliaryWindowService.open`）只做"壳 + 全窗占位 div"，
 * 真正的界面是主进程 `dshViewHost` 的 WebContentsView —— 它本就支持"按 windowId 把视图
 * 挂到 aux 窗口"（layout 时检测挂载点 ✓）。窗口关闭时主进程也会回收挂在它上面的视图
 * （`_watchWindow` 的 closed 回收 ✓），这里再主动 dispose 一次（幂等）。
 *
 * 页面桥命令：事件是**广播**的，本窗口渲染进程一样收得到弹窗视图的命令。这里只处理
 * "换会话"这一族（openSession / newSession —— 弹窗自己的视图，自己换绑即可）；
 * 其余（openModulePage / newChat 等要动 IDE 界面的）留给 `DshPageCommandContribution`
 * 那套全局处理（作用于主窗口），与聊天宿主"只处理自己负责的少数方法"同口径。
 */

import { getZoomFactor } from '../../../../base/browser/browser.js';
import { $, append } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
// ★ 2026-10-29（右栏自愈可见化）：自愈时弹一条通知 ⇒ 用户知道"右栏为什么没了"，而不是莫名消失。
import { INotificationService } from '../../../../platform/notification/common/notification.js';
// ★ 2026-10-29（分屏比例持久化）：比例存 **IDE storage** ⇒ 下次开窗沿用。
//   ⚠ 不能放页面 localStorage：各栏是**不同分区**的页面（右栏独占 desktop-pool-* 分区）
//   ⇒ localStorage 互不可见 ⇒ 放页面里右栏必然读不到 ✗。
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { FocusMode, INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IAuxiliaryWindowService } from '../../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { setDshFullWindowOpener, setDshPaneActionOpener, setDshSplitPaneOpener, type DshPaneAction } from '../../../common/dshFullWindow.js';
import { dshChatNewSessionId } from '../common/dshChatSession.js';
import { DshHarnessSettings } from '../common/dshHarness.js';
// ★ 2026-10-29（拖拽堆叠）：布局用**树**（h/v split + 权重）⇒ 能表达左右/上下混合、2×2、L 形。
//   几何与重排是**纯函数**（common/dshSplitLayout.ts，有单测）⇒ 这里只负责"把结果摆到原生视图上"。
import { buildArrangedTree, canSplitRect, checkPaneBounds, computeMainColumnWidth, computePaneGeometry, dockSplitLeaf, equalizeSplitNodeAt, equalizeSplitSizes, holeViewRect, insertSplitLeafBeside, moveSplitLeaf, pickSplitTarget, ratioForMainWidth, removeSplitLeaf, resizeSplitDivider, splitLeaves, swapSplitLeaves, type DshDropTarget, type DshDropZone, type DshSplitNode, type IDshPaneBox, type IDshSplitRect } from '../common/dshSplitLayout.js';
// ★ 2026-10-30（按已确认的效果图实现多格外壳：标题栏 / 分隔条 / 挖洞式落点 / 原生菜单 / 撤销）
import { DESKTOP_PANE_HEAD_H, DshDesktopSplitChrome, type IDshChromePane, type IDshSplitChromeActions } from './dshDesktopSplitChrome.js';
import type { IContextMenuItem } from '../../../../base/parts/contextmenu/common/contextmenu.js';
// ★ 2026-10-30（运行时自测）：读环境变量 `VSSAROS_DSH_SPLIT_SELFTEST` ⇒ 开窗后自动跑一遍多格场景。
import { process as sandboxProcess } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { decideSessionStartRetry, SESSION_START_MAX_ATTEMPTS, sessionStartRetryDelayMs } from '../common/dshDesktopSessionStart.js';
import { IDshHarnessService } from './dshHarnessService.js';

/**
 * 「启动时把 IDE 主窗口收进了任务栏」这一事实的**共享标记**（桌面窗口侧收，页面命令侧读）。
 *
 * 为什么需要跨类传：收起来之后，页面里那些"在 IDE 里打开"的命令（文件卡、终端、设置页…）
 * 全都作用在**看不见的窗口**上 ⇒ 用户看到的就是"点了没反应"（本仓的高频缺陷形态 ✗）。
 * 所以那些命令到达时，先把 IDE 主窗口还原到前台（`DshPageCommandContribution._handle` 开头）。
 * 只在"我们真的收起来过"时才做 ⇒ 手动 popout（两窗并排）时不会抢焦点 ✓。
 */
export const dshIdeWindowHidden = { value: false };

/**
 * 桌面窗口自绘标题条的高度：与 `windows.ts` 里 overlay 的 **29** 一致
 * （Windows 11 上原生标题栏的最小高度，含 1px 窗框 —— `windowImpl.updateWindowControls` 会自己减掉）。
 */
const DESKTOP_TITLEBAR_H = 29;

/**
 * **左右分屏**时两栏之间留的缝隙宽度（px）。
 *
 * 为什么要有缝：`WebContentsView` 是**原生层**，画在 DOM 之上 ⇒ 中间的分隔条（DOM）只有落在
 * 缝隙里才看得见（与自绘标题条"留出 29px"同一手法，见 `_installTitleBar`）✓。
 */
const DESKTOP_SPLIT_GAP = 8;

/**
 * **主栏最小宽度**（2026-10-29 真机两次）：主栏是带官方**三栏**布局的完整客户端
 * （左侧栏 ≈236 + 中栏 + 官方右栏）⇒ 低于这个宽度时 dsh 会把侧栏折成图标条、中栏挤成 0（黑屏）。
 * 420 实测不够（截图里 520 就是黑的）⇒ 取 **720**（侧栏 + 约 480 的中栏）。
 */
const DESKTOP_MAIN_MIN_W = 720;

/** 右栏最少要有多少宽度（低于它就没什么可看的了 ⇒ 分屏前提示用户）✓。 */
const DESKTOP_PANE_MIN_W = 320;

/** 每格最小宽 / 高（拆分、拖分隔条都按它夹取；与效果图一致）。 */
const DESKTOP_CELL_MIN_W = 200;
const DESKTOP_CELL_MIN_H = 160;

/**
 * 右侧**最多几格**（不含主栏；2026-10-30 按已确认的效果图定为 **6**）。
 * ⚠ 每格是一整个 dsh 客户端页面（各一份 roster / 连接 / 内存）⇒ 成本随格数线性涨 ⇒ 必须封顶。
 */
const MAX_DESKTOP_SPLIT_PANES = 6;

/** 关闭后多久真正回收那一格的视图（这段时间内「撤销」是瞬时的；之后撤销 = 用原会话重建）。 */
const DESKTOP_CLOSE_GRACE_MS = 30_000;

/**
 * 分屏比例的**持久化键**（IDE storage，APPLICATION scope）。
 *
 * ⚠ 只存**比例**、不存栏数：栏绑的是**新会话**，跨重启恢复没有意义（社区能恢复是因为它们
 *   恢复的是**同一批会话**；我们这里的会话每次开窗都是新的 ⇒ 只继承比例即可）✓。
 */
const SPLIT_RATIO_STORAGE_KEY = 'dsh.desktop.split.ratio.v1';

/** 右侧一格的元信息（标题栏显示 + 撤销关闭时用原会话重建）。 */
interface IDeskPaneMeta {
	readonly title: string;
	readonly sessionId: string;
}

/** 撤销快照：树 + 主栏比例 + 当时的右侧格子。 */
interface IDeskSnapshot {
	readonly tree: DshSplitNode | undefined;
	readonly ratio: number;
	readonly panes: readonly string[];
}

/** 一扇桌面窗口的登记（`paneViewIds[0]` 恒为主栏）。 */
interface IDeskEntry {
	windowId: number;
	viewId: string;
	sideViewId?: string;
	splitViewId?: string;
	paneViewIds?: string[];
	/** 右侧格子的树（**不含主栏**：主栏是全高左列）。 */
	tree?: DshSplitNode;
	layout?: () => void;
	chrome?: DshDesktopSplitChrome;
	dom?: { readonly win: Window; readonly container: HTMLElement };
	meta?: Map<string, IDeskPaneMeta>;
	seq?: number;
	maxId?: string;
	hole?: { id: string; zone: DshDropTarget };
	/** 当前被我们隐藏的视图（最大化 / 挖洞 / 软关闭）。 */
	hidden?: Set<string>;
	undo?: IDeskSnapshot[];
	/** 软关闭中（等待回收）的格子 ⇒ 回收定时器。 */
	closing?: Map<string, ReturnType<typeof setTimeout>>;
	/** 一次拖动（分隔条 / 主栏宽）开始前的快照（松手时入撤销栈）。 */
	resizeBase?: IDeskSnapshot;
}

export class DshFullWindowContribution extends Disposable {
	static readonly ID = 'sessions.dshHarness.fullWindow';

	constructor(
		@IDshHarnessService private readonly _dsh: IDshHarnessService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IAuxiliaryWindowService private readonly _auxWindowService: IAuxiliaryWindowService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly _log: ILogService,
		// 启动自动开窗成功后把 **IDE 主窗口藏起来**（"F5 只看到这个窗口"）；关窗/回 IDE 再 `showWindow` 还回去。
		// ⚠ `focusWindow` 对**已隐藏**的窗口无效（主进程 `doFocusWindow` 只处理最小化）⇒ 必须先 `showWindow` ✓。
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		// ★ 2026-10-29（用户：desktop 窗口左上角 logo/品牌名**右侧**加版本号）⇒ 需要产品版本。
		@IProductService private readonly _productService: IProductService,
		// ★ 2026-10-29（右栏自愈可见化）：自愈/失败时弹通知（否则用户只看到"右栏莫名消失"✗）。
		@INotificationService private readonly _notifications: INotificationService,
		// ★ 2026-10-29（分屏比例持久化）：比例存 IDE storage（各栏跨分区，页面 localStorage 不共享 ✗）。
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		// 恢复上次的分屏比例（拖过分隔条就记住 ⇒ 下次开窗沿用）✓
		this._splitRatio = this._readSplitRatio();
		// 与聊天宿主同一门槛：总开关关闭或 engine=legacy 时不接管，popout 走旧实现。
		const enabled = this._configurationService.getValue<boolean>(DshHarnessSettings.Enabled) !== false;
		const engine = this._configurationService.getValue<string>(DshHarnessSettings.ChatEngine);
		if (!enabled || engine !== 'dsh') {
			// ★ 2026-10-21：主进程可能以**隐藏**方式建窗（`VSSAROS_START_HIDDEN=1`，见 windowImpl）。
			//   这些"不接管"的分支必须自己把窗口显示出来，否则 return 之后**一个窗口都没有** ✗。
			void this._showIdeWindow(`harness 未启用（engine=${engine}）`);
			return;
		}
		setDshFullWindowOpener(args => this._open(args));
		this._register(toDisposable(() => setDshFullWindowOpener(undefined)));
		// ★ 2026-10-29（分屏）：页面里那枚「新窗格」按钮 ⇒ 在**当前这扇窗口**内加一栏
		//   （用户原话："希望是在当前窗口下，分屏出一个聊天框"，不要弹独立窗口）✓
		setDshSplitPaneOpener(viewId => this._ensureSplitPane(viewId));
		this._register(toDisposable(() => setDshSplitPaneOpener(undefined)));
		// ★ 2026-10-29（栏动作）：页面菜单驱动（移到最左/最右/最上/最下、关闭这一栏）。
		//   ⚠ 为什么不做拖拽：aux 窗口的 DOM 层**收不到鼠标事件**（真机证据：抓手带 mousedown 从不触发）
		//   ⇒ 交互放页面里（页面在原生视图内，事件正常）✓
		setDshPaneActionOpener((viewId, action) => this._paneActionByView(viewId, action));
		this._register(toDisposable(() => setDshPaneActionOpener(undefined)));

		// ★ 2026-10-21（用户第二轮："希望 F5 可以默认直接启动 dsh 窗口，**不要显示 IDE 窗口**"）：
		//   启动时自动打开桌面窗口，成功后就**把 IDE 主窗口隐藏掉**（hide，不是 minimize：连任务栏也不要）。
		//   配合 `VSSAROS_START_HIDDEN=1`（F5 的 launch.json 里带）——窗口从出生起就不显示，零闪烁 ✓。
		//   为什么要延时开窗：构造发生在 `WorkbenchPhase.BlockRestore` 期间，此刻布局/工作区还没落定 ——
		//   立刻 `_open()` 会让 `_ensurePopoutSessionId` 拿不到工作区目录（⇒ 停官方 hero）、
		//   也可能在建窗时和首帧布局打架。留一拍（2.5s）让"会话解析 + 建窗 + 布局"都在稳定态发生 ✓。
		//   只开一次：`_openWindow` 单例复用；关窗后也不会偷偷再开（用户要的话点标题栏那个 Pop Out ✓）。
		if (this._configurationService.getValue<boolean>(DshHarnessSettings.OpenDesktopOnStartup) === false) {
			// 用户关掉了"启动即开桌面窗口"⇒ 这时候 IDE 必须露出来（隐藏启动模式下尤其重要）
			void this._showIdeWindow('设置里关闭了启动即打开桌面窗口');
			return;
		}
		const timer = setTimeout(async () => {
			// ★ 2026-10-27（真机：一次启动出现**两扇**桌面窗口）：本贡献跑在 IDE 主窗口渲染进程里，
			//   **渲染进程重载**（心跳自愈等）会重造它 ⇒ 2.5s 后又走一遍 ⇒ 多一扇空壳（用户可能盯着
			//   那扇空壳 ⇒ 白屏 / 看不到侧栏里应有的行）。⇒ 先问主进程"本窗口的启动自动开窗做过没"，
			//   做过就跳过。状态在主进程 ⇒ 重载不清零 ✓（放渲染侧保存就会随重载丢失 ✗）。
			const first = await this._dsh.claimDesktopAutoOpen(this._nativeHostService.windowId).catch(err => {
				this._log.warn('[dshHarness] startup: claimDesktopAutoOpen failed（按首次处理）', err);
				return true;
			});
			if (!first) {
				this._log.info('[dshHarness] startup: 本窗口的启动自动开窗已经做过（渲染进程重载过）⇒ 不再开第二扇桌面窗口');
				return;
			}
			this._log.info('[dshHarness] startup: open the dsh desktop window by default');
			// ★ 2026-10-22（用户："启动 app 时，能否仅启动窗口版"）：**窗口壳一出来就藏 IDE**，不再等 Host。
			//   真机日志（`logs/20261022T084749`）：08:47:57.58 请求开窗 → Host 冷启动到 08:48:13.6 才就绪 →
			//   08:48:14.19 渲染侧 20s 兜底先把 IDE **亮了出来** → 08:48:15.59 桌面窗口才出来、再把 IDE 藏回去
			//   ⇒ 用户看到 IDE 闪了 1.4s ✗。根因 = 旧流程「先等 Host 就绪、再建桌面窗口」⇒ 桌面窗口的出现时间
			//   被 Host 冷启动（17s+）绑死，兜底闹钟与它赛跑。
			//   ⇒ 现在 `_open` 先建窗口壳（带"正在启动"占位）再等 Host；壳出来那一刻（~3s）就藏 IDE ⇒
			//     **Host 冷启动多久都不再需要露出 IDE** ✓。窗口壳本身开不出来 ⇒ 退出应用（见下，不露 IDE）。
			let settled = false;
			const settle = () => {
				if (!settled) {
					settled = true;
					void this._settleIdeWindowAfterStartup(true);
				}
			};
			// ★ 2026-10-22（用户："app 启动后只显示 desktop 模式，**不要打开 IDE**"）：
			//   开窗失败也**不再**把 IDE 亮出来 —— 桌面模式就是这个 app 的全部界面，
			//   露出 IDE 等于"启动失败反而切回 IDE"✗。改为打日志 + 退出（不留一个没有界面的进程 ✓）。
			void this._open({}, settle)
				.then(opened => opened ? settle() : this._quit('桌面窗口没有开出来'))
				.catch(err => {
					this._log.warn('[dshHarness] startup: opening the dsh desktop window failed', err);
					return this._quit('桌面窗口开窗失败');
				});
			// ★ 2026-10-28（用户：「首次打开加载时间太长」）：这个延时原本是 2.5s，纯粹是"等布局稳定"的空等
			//   —— 用户在打包版首启要面对 30s+ 的等待，前面再加 2.5s 白屏毫无收益。
			//   `_open` 自身已经是"先建壳、再等 Host"（壳里带占位文案）⇒ 提前到 800ms，
			//   会话解析那一步改为**等工作区就绪**（见 `_ensurePopoutSessionId`），不靠这个延时兜。
		}, 800);
		this._register(toDisposable(() => clearTimeout(timer)));
		// 渲染进程侧的兜底：**20s** 内连桌面窗口**壳**都没开出来 ⇒ 显示 IDE（主进程 `windowImpl` 那边还有一道
		// 45s 的，且露过一次面就作废）。2026-10-22 起壳不再等 Host（见上）⇒ 正常路径 ~3s 就置位，
		// 这道闹钟只兜"辅助窗口本身建不出来"这种真故障 ✓。
		const watchdog = setTimeout(() => {
			if (!this._desktopWindowOpened) {
				// 同上：兜底也不许亮 IDE（用户 2026-10-22 明确要求）⇒ 打日志 + 退出
				void this._quit('20s 内桌面窗口没有开出来');
			}
		}, 20_000);
		this._register(toDisposable(() => clearTimeout(watchdog)));
	}

	/** 启动自动开窗后是否由我们把 IDE 主窗口藏起来了（关桌面窗口时要还回去；见 `dshIdeWindowHidden`）。 */
	private _ideHiddenByStartup = false;
	/** 桌面窗口是否已经真的开出来过（20s 兜底用；2026-10-22 起"壳出来"就算）。 */
	private _desktopWindowOpened = false;
	/** "显示 IDE"请求的代数：每次 `_showIdeWindow` +1，用来让交错的"启动后隐藏"作废。 */
	private _ideShowEpoch = 0;
	/** 桌面窗口里那条「会话启动失败」提示条（2026-10-27；成功/关窗时撤掉）。 */
	private _startupBanner: HTMLElement | undefined;

	/**
	 * 开窗结果落定 ⇒ 成功就**隐藏** IDE 主窗口，失败就把它**显示出来**。
	 *
	 * 为什么用 hide 不用 minimize：用户要的是"不要显示 IDE 窗口"——最小化还留着任务栏按钮；
	 * hide 之后屏幕上/任务栏里都只剩桌面窗口。回程由侧栏那枚「回到 IDE」（`showWindow` + 聚焦）负责 ✓。
	 * 为什么失败要 show：否则窗口是隐藏的，用户面对的是"点了 F5 什么都没出现" ✗。
	 */
	private async _settleIdeWindowAfterStartup(opened: boolean): Promise<void> {
		if (!opened) {
			await this._quit('桌面窗口没有开出来');
			return;
		}
		this._desktopWindowOpened = true;
		// 记下此刻的"显示请求代数"：等待期间若有人要求显示 IDE（例如 Host 秒挂 ⇒ `_showIdeWindow`），
		// 就**不许**再把它藏回去 —— 否则用户面前只剩一个写着"启动失败"的桌面窗口、IDE 却被我们藏了 ✗
		// （2026-10-22 起窗口壳先于 Host 出现 ⇒ "藏"与"显"可能交错，必须有这道闸 ✓）。
		const showEpoch = this._ideShowEpoch;
		try {
			// 让新窗口先拿到前台：紧接着隐藏主窗口时，若桌面窗口还没抢到焦点，整应用会闪到后台
			await new Promise<void>(resolve => setTimeout(resolve, 350));
			if (showEpoch !== this._ideShowEpoch) {
				this._log.info('[dshHarness] startup: IDE 主窗口在等待期间被要求显示 ⇒ 不再隐藏');
				return;
			}
			this._log.info('[dshHarness] startup: desktop window is up ⇒ hiding the IDE main window');
			await this._nativeHostService.hideWindow({ targetWindowId: this._nativeHostService.windowId });
			this._ideHiddenByStartup = true;
			dshIdeWindowHidden.value = true;
			// ★ 2026-10-21：装「desktop 守卫」—— 我们藏起来的窗口**不许再露面**。
			//   为什么需要：用户在桌面窗口点「登录」⇒ 走 TOF 浏览器流程 ⇒ **窗口层面**的外部动作
			//   （系统把焦点还给本应用的窗口）会把 IDE 主窗口拉到前台（真机日志：桌面窗口 BLUR 后 1.6s
			//   IDE 主窗口 FOCUS ✗）⇒ 只在命令分发处拦**拦不住**（那不是命令）⇒ 守卫落在主进程 ✓。
			await this._dsh.setIdeWindowHidden(true, this._nativeHostService.windowId);
		} catch (err) {
			this._log.warn('[dshHarness] startup: hiding the IDE main window failed', err);
		}
	}

	/** 显示并聚焦 IDE 主窗口（隐藏/最小化都能拉回来）。`showWindow` 内部会先 restore 再 show ✓。 */
	private async _showIdeWindow(reason: string): Promise<void> {
		this._desktopWindowOpened = true;   // 已经决定露出 IDE ⇒ 兜底闹钟不必再响
		this._ideShowEpoch++;               // 让还在等待中的"启动后隐藏"作废（见 `_settleIdeWindowAfterStartup`）
		try {
			this._log.info(`[dshHarness] startup: showing the IDE main window（${reason}）`);
			// ⚠ **先撤守卫再显示**：守卫会把这个窗口的 show/focus 事件压回去 ⇒ 不撤就是"刚 show 就被藏" ✗
			//   （用户点「回到 IDE」/ 桌面窗口关闭时走的就是这条 ⇒ 必须先撤 ✓）。
			await this._dsh.setIdeWindowHidden(false, this._nativeHostService.windowId);
			await this._nativeHostService.showWindow({ targetWindowId: this._nativeHostService.windowId });
			await this._nativeHostService.focusWindow({ targetWindowId: this._nativeHostService.windowId, mode: FocusMode.Force });
			dshIdeWindowHidden.value = false;
			this._ideHiddenByStartup = false;
		} catch (err) {
			this._log.warn(`[dshHarness] startup: showing the IDE main window failed（${reason}）`, err);
		}
	}

	/**
	 * 桌面窗口被关掉后的收场（**2026-10-23 用户口径，三条规则按"还剩几个可见窗口"判定**）：
	 *
	 *   ① 只开着桌面窗口 ⇒ 关桌面窗口 ⇒ **退出应用** ← 本函数负责
	 *   ② 只开着 IDE 窗口   ⇒ 关 IDE 窗口 ⇒ 退出（主进程 `dshHarnessChannel` 的 close 拦截负责）
	 *   ③ 两个都开着       ⇒ 关哪个都只关它自己，应用保持 ← 本函数**不许退**
	 *
	 * 判据 = IDE 主窗口这一刻是否**可见**：
	 *   · 桌面模式下它被我们藏着（`_ideHiddenByStartup`）⇒ 关掉桌面窗口后屏幕上什么都不剩
	 *     ⇒ 必须退出，否则留下"没有界面却活着"的隐形进程 ✗（也不能把 IDE 亮出来 —— 那是
	 *     2026-10-22 用户明确否决的"关一个窗口反而冒出一个 IDE"✗）；
	 *   · 手动 popout（IDE 与桌面窗口并排）⇒ IDE 还开着、用户还在里面 ⇒ **不能退** ✓。
	 */
	private _quitAfterDesktopClosed(): void {
		// ★ 2026-10-29（桌面窗口多开）：**还有别的桌面窗口开着** ⇒ 关掉这一扇不是"最后一个界面"
		//   ⇒ 绝不退出应用（否则用户关掉第 2 扇就把第 1 扇一起带走 ✗）。
		if (this._desktopWindows.size > 0) {
			this._log.info(`[dshHarness] 桌面窗口已关闭；还有 ${this._desktopWindows.size} 扇桌面窗口在屏 ⇒ 只关它自己（应用保持）`);
			return;
		}
		if (!this._ideHiddenByStartup) {
			// ③ IDE 仍可见 ⇒ 只是关掉了另一个窗口，应用照常
			this._log.info('[dshHarness] 桌面窗口已关闭；IDE 主窗口仍可见 ⇒ 只关它自己（应用保持）');
			return;
		}
		// **同步**清标记 ⇒ 同一次关窗里两个 onUnload（启动期 + 拼装期）都触发时只退一次 ✓
		this._ideHiddenByStartup = false;
		void this._quit('桌面窗口已关闭（它是最后一个可见窗口）');
	}

	/**
	 * 退出应用（桌面模式下所有"不该露 IDE"的收场都走这里：开窗失败 / 启动期关窗 / 关窗）。
	 * 打日志 + `quit()`；退出失败只记日志（用户已经关窗了，再抛错只会污染控制台）。
	 */
	/**
	 * 装**分隔条**（每条缝一枚；最多 `MAX_DESKTOP_PANES - 1` 条）。
	 *
	 * ⚠ 它是 **DOM**，而原生视图盖在 DOM 之上 ⇒ 只有落在两栏之间的缝隙里才看得见
	 *   （位置与显示与否由 `layout()` 写，宽度 = `DESKTOP_SPLIT_GAP`）✓。
	 * ⚠ aux 窗口里 `createElement` 可能被禁 ⇒ 建不出来就**如实记日志**并放弃分隔条
	 *   （分屏本身仍可用，只是不能拖）✓。
	 * ⚠ **只有第 1 条缝可拖**（两栏时调 `_splitRatio`）；三栏时等分、缝不可拖
	 *   （多缝自由拖动会把比例算成乱麻，先不做）✓。
	 */
	/**
	 * 读回上次的分屏比例（IDE storage；键 `dsh.desktop.split.ratio.v1`）。
	 *
	 * ⚠ 读到非法值（手改过 storage / 旧版本遗留）⇒ 回退 0.5，不让窗口排版崩掉 ✓。
	 */
	private _readSplitRatio(): number {
		try {
			const raw = this._storageService.get(SPLIT_RATIO_STORAGE_KEY, StorageScope.APPLICATION);
			const value = typeof raw === 'string' ? Number(raw) : NaN;
			return Number.isFinite(value) && value >= 0.2 && value <= 0.8 ? value : 0.5;
		} catch (err) {
			this._log.warn('[dshHarness] split ratio: 读比例失败 ⇒ 用默认 0.5', err);
			return 0.5;
		}
	}

	/** 记住当前比例（拖分隔条时调用）✓。 */
	private _persistSplitRatio(): void {
		try {
			this._storageService.store(SPLIT_RATIO_STORAGE_KEY, String(this._splitRatio), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} catch (err) {
			this._log.warn('[dshHarness] split ratio: 写比例失败（不影响分屏本身）', err);
		}
	}

	// ==== 多格（按已确认的效果图 doc/mockups/dsh-split-panes.html）==========================

	private _findEntry(viewId: string): IDeskEntry | undefined {
		for (const e of this._desktopWindows.values()) {
			if (e.viewId === viewId || (e.paneViewIds ?? []).includes(viewId)) { return e; }
		}
		return undefined;
	}

	private _rightPanes(entry: IDeskEntry): string[] {
		return (entry.paneViewIds ?? [entry.viewId]).filter(id => id !== entry.viewId);
	}

	private _snapshot(entry: IDeskEntry): IDeskSnapshot {
		return { tree: entry.tree, ratio: this._splitRatio, panes: this._rightPanes(entry) };
	}

	private _pushUndo(entry: IDeskEntry, snap: IDeskSnapshot = this._snapshot(entry)): void {
		const stack = entry.undo ?? (entry.undo = []);
		stack.push(snap);
		if (stack.length > 30) { stack.shift(); }
	}

	/** 隐藏 / 显示某一格的原生视图（带缓存 ⇒ 不重复发 IPC）。 */
	private _setPaneVisible(entry: IDeskEntry, id: string, visible: boolean): void {
		const hidden = entry.hidden ?? (entry.hidden = new Set());
		if (visible && hidden.has(id)) {
			hidden.delete(id);
			void this._dsh.setViewVisible(id, true, false).catch(() => undefined);
		} else if (!visible && !hidden.has(id)) {
			hidden.add(id);
			void this._dsh.setViewVisible(id, false).catch(() => undefined);
		}
	}

	private _title(entry: IDeskEntry, id: string): string {
		return entry.meta?.get(id)?.title ?? '会话';
	}

	/**
	 * 关闭一格（**软关闭**：先藏起来、`DESKTOP_CLOSE_GRACE_MS` 后才真正回收视图）⇒ 「撤销」是瞬时的；
	 * 会话本身**不删**（它在 Host 侧，过了宽限期撤销也能用原会话重建这一格）✓。
	 * 相邻格补位、**不**自动重排（效果图约定：手动布局不被覆盖）✓。
	 */
	private _closePane(windowId: number, paneId: string, recordUndo = true): boolean {
		const entry = this._desktopWindows.get(windowId);
		if (!entry?.tree || paneId === entry.viewId || !splitLeaves(entry.tree).includes(paneId)) { return false; }
		if (recordUndo) { this._pushUndo(entry); }
		entry.tree = removeSplitLeaf(entry.tree, paneId);
		entry.paneViewIds = (entry.paneViewIds ?? []).filter(id => id !== paneId);
		entry.splitViewId = this._rightPanes(entry).at(-1);
		if (entry.maxId === paneId) { entry.maxId = undefined; }
		this._setPaneVisible(entry, paneId, false);
		this._stopSplitWatcher(windowId, paneId);
		const closing = entry.closing ?? (entry.closing = new Map());
		clearTimeout(closing.get(paneId));
		closing.set(paneId, setTimeout(() => this._disposePane(windowId, paneId), DESKTOP_CLOSE_GRACE_MS));
		entry.layout?.();
		this._log.info(`[dshHarness] pane close: 已关闭 ${paneId}（剩 ${this._rightPanes(entry).length} 格；${DESKTOP_CLOSE_GRACE_MS / 1000}s 内可撤销）`);
		if (recordUndo) { entry.chrome?.toast(`已关闭「${this._title(entry, paneId)}」· 会话仍保留`, true); }
		return true;
	}

	/** 真正回收一格的视图（软关闭到期 / 窗口关闭 / 自愈）。 */
	private _disposePane(windowId: number, paneId: string): void {
		const entry = this._desktopWindows.get(windowId);
		if (entry) {
			clearTimeout(entry.closing?.get(paneId));
			entry.closing?.delete(paneId);
			entry.hidden?.delete(paneId);
			if (entry.tree && splitLeaves(entry.tree).includes(paneId)) { entry.tree = removeSplitLeaf(entry.tree, paneId); }
			entry.paneViewIds = (entry.paneViewIds ?? []).filter(id => id !== paneId);
			if (entry.maxId === paneId) { entry.maxId = undefined; }
		}
		this._stopSplitWatcher(windowId, paneId);
		void this._dsh.disposeView(paneId).catch(() => undefined);
	}

	/** 撤销：回到上一个快照（软关闭中的格子瞬时恢复；已回收的用原会话重建）。 */
	private async _undo(windowId: number): Promise<void> {
		const entry = this._desktopWindows.get(windowId);
		const snap = entry?.undo?.pop();
		if (!entry || !snap) { entry?.chrome?.toast('没有可撤销的操作', false); return; }
		const now = new Set(this._rightPanes(entry));
		const want = new Set(snap.panes);
		for (const id of now) {
			if (!want.has(id)) { this._disposePane(windowId, id); }
		}
		for (const id of want) {
			if (now.has(id)) { continue; }
			const pending = entry.closing?.get(id);
			if (pending !== undefined) {
				clearTimeout(pending);
				entry.closing!.delete(id);
			} else {
				const meta = entry.meta?.get(id);
				if (!meta) { continue; }
				await this._dsh.createView(id, windowId, 'chat', meta.sessionId, undefined, undefined, true, true);
				(entry.hidden ?? (entry.hidden = new Set())).add(id);
			}
			entry.paneViewIds = [...(entry.paneViewIds ?? [entry.viewId]), id];
			this._startSplitWatcher(windowId, id);
		}
		entry.tree = snap.tree;
		entry.splitViewId = this._rightPanes(entry).at(-1);
		entry.maxId = undefined;
		if (this._splitRatio !== snap.ratio) { this._splitRatio = snap.ratio; this._persistSplitRatio(); }
		entry.layout?.();
		this._log.info('[dshHarness] pane undo: 已撤销上一步');
		entry.chrome?.toast('已撤销', false);
	}

	private _movePane(windowId: number, sourceId: string, targetId: string, zone: DshDropTarget): void {
		const entry = this._desktopWindows.get(windowId);
		if (!entry?.tree) { return; }
		const next = zone === 'center' ? swapSplitLeaves(entry.tree, sourceId, targetId) : moveSplitLeaf(entry.tree, sourceId, targetId, zone);
		if (!next) { this._log.warn('[dshHarness] pane drag: 重排失败（保持原布局）'); return; }
		this._pushUndo(entry);
		entry.tree = next;
		entry.maxId = undefined;
		entry.layout?.();
		const where = zone === 'center' ? '交换位置' : `的${({ left: '左侧', right: '右侧', top: '上方', bottom: '下方' } as const)[zone]}`;
		this._log.info(`[dshHarness] pane drag: ${sourceId} ⇒ ${targetId} ${zone}`);
		entry.chrome?.toast(zone === 'center' ? `已与「${this._title(entry, targetId)}」交换位置` : `已移到「${this._title(entry, targetId)}」${where}`, true);
	}

	private _toggleMax(windowId: number, id: string): void {
		const entry = this._desktopWindows.get(windowId);
		if (!entry) { return; }
		entry.maxId = entry.maxId === id ? undefined : id;
		entry.layout?.();
		this._log.info(`[dshHarness] pane ${entry.maxId ? 'maximize' : 'restore'}: ${id}`);
	}

	private _dockPane(windowId: number, id: string, edge: DshDropZone): void {
		const entry = this._desktopWindows.get(windowId);
		const next = entry?.tree ? dockSplitLeaf(entry.tree, id, edge) : undefined;
		if (!entry || !next) { return; }
		this._pushUndo(entry);
		entry.tree = next;
		entry.maxId = undefined;
		entry.layout?.();
		entry.chrome?.toast(`已移到${({ left: '最左（整列）', right: '最右（整列）', top: '最上（整行）', bottom: '最下（整行）' } as const)[edge]}`, true);
	}

	private _arrange(windowId: number): void {
		const entry = this._desktopWindows.get(windowId);
		if (!entry?.tree) { return; }
		this._pushUndo(entry);
		entry.tree = buildArrangedTree(splitLeaves(entry.tree), this._contentAspect(windowId));
		entry.maxId = undefined;
		entry.layout?.();
		entry.chrome?.toast('已自动排列', true);
	}

	private _equalizeAll(windowId: number): void {
		const entry = this._desktopWindows.get(windowId);
		if (!entry?.tree) { return; }
		this._pushUndo(entry);
		entry.tree = equalizeSplitSizes(entry.tree);
		entry.layout?.();
	}

	private _closeMany(windowId: number, keep: string | undefined): void {
		const entry = this._desktopWindows.get(windowId);
		if (!entry?.tree) { return; }
		const ids = splitLeaves(entry.tree).filter(id => id !== keep);
		if (ids.length === 0) { return; }
		this._pushUndo(entry);
		for (const id of ids) { this._closePane(windowId, id, false); }
		entry.chrome?.toast(keep ? '已关闭其他格 · 会话仍保留' : '已关闭全部窗格 · 会话仍保留', true);
	}

	/** 某一格的右键菜单（Electron 原生菜单 ⇒ 画在所有原生视图之上）。 */
	private _paneMenuItems(windowId: number, id: string): IContextMenuItem[] {
		const entry = this._desktopWindows.get(windowId);
		const n = entry?.tree ? splitLeaves(entry.tree).length : 0;
		const full = n >= MAX_DESKTOP_SPLIT_PANES;
		const sep: IContextMenuItem = { type: 'separator' };
		return [
			{ label: '向右拆分', enabled: !full, click: () => { void this._splitFrom(windowId, id, 'right'); } },
			{ label: '向下拆分', enabled: !full, click: () => { void this._splitFrom(windowId, id, 'bottom'); } },
			{ label: entry?.maxId === id ? '还原' : '最大化', click: () => this._toggleMax(windowId, id) },
			sep,
			{ label: '移到最左（整列）', enabled: n >= 2, click: () => this._dockPane(windowId, id, 'left') },
			{ label: '移到最右（整列）', enabled: n >= 2, click: () => this._dockPane(windowId, id, 'right') },
			{ label: '移到最上（整行）', enabled: n >= 2, click: () => this._dockPane(windowId, id, 'top') },
			{ label: '移到最下（整行）', enabled: n >= 2, click: () => this._dockPane(windowId, id, 'bottom') },
			sep,
			{ label: '平均分配所有格', enabled: n >= 2, click: () => this._equalizeAll(windowId) },
			{ label: '自动排列', enabled: n >= 2, click: () => this._arrange(windowId) },
			sep,
			{ label: '关闭其他格', enabled: n >= 2, click: () => this._closeMany(windowId, id) },
			{ label: '关闭这一格', click: () => { this._closePane(windowId, id); } },
		];
	}

	private _splitFrom(windowId: number, id: string, zone: DshDropZone): Promise<boolean> {
		const entry = this._desktopWindows.get(windowId);
		return entry ? this._ensureSplitPane(entry.viewId, { target: id, zone }) : Promise.resolve(false);
	}

	/** 外壳（DOM 标题栏 / 分隔条）的回调 ⇒ 落到树与视图上。 */
	private _chromeActions(windowId: number): IDshSplitChromeActions {
		const entryOf = () => this._desktopWindows.get(windowId);
		return {
			move: (s, t, z) => this._movePane(windowId, s, t, z),
			close: id => { this._closePane(windowId, id); },
			split: (id, z) => { void this._splitFrom(windowId, id, z); },
			toggleMax: id => this._toggleMax(windowId, id),
			resizeDivider: (d, pointer, commit) => {
				const entry = entryOf();
				if (!entry?.tree) { return; }
				entry.resizeBase ??= this._snapshot(entry);
				const next = resizeSplitDivider(entry.tree, d.path, d.index, pointer, d.node, d.dir === 'h' ? DESKTOP_CELL_MIN_W : DESKTOP_CELL_MIN_H);
				if (next) { entry.tree = next; entry.layout?.(); }
				if (commit) {
					this._pushUndo(entry, entry.resizeBase);
					entry.resizeBase = undefined;
					this._log.info(`[dshHarness] pane resize: ${d.dir === 'h' ? '左右' : '上下'}分隔条 ⇒ ${pointer}`);
				}
			},
			equalizeDivider: d => {
				const entry = entryOf();
				const next = entry?.tree ? equalizeSplitNodeAt(entry.tree, d.path) : undefined;
				if (!entry || !next) { return; }
				this._pushUndo(entry);
				entry.tree = next;
				entry.layout?.();
			},
			resizeMain: (mainWidth, commit) => {
				const entry = entryOf();
				const area = this._lastAreas.get(windowId);
				if (!entry || !area) { return; }
				entry.resizeBase ??= this._snapshot(entry);
				this._splitRatio = ratioForMainWidth(area.width, mainWidth, DESKTOP_MAIN_MIN_W, DESKTOP_PANE_MIN_W);
				entry.layout?.();
				if (commit) {
					this._persistSplitRatio();
					this._pushUndo(entry, entry.resizeBase);
					entry.resizeBase = undefined;
					this._log.info(`[dshHarness] main resize: 比例 ${this._splitRatio.toFixed(3)}`);
				}
			},
			resetMain: () => {
				const entry = entryOf();
				if (!entry) { return; }
				this._pushUndo(entry);
				this._splitRatio = 0.5;
				this._persistSplitRatio();
				entry.layout?.();
			},
			hole: h => {
				const entry = entryOf();
				if (!entry) { return; }
				entry.hole = h;
				entry.layout?.();
			},
			menuItems: id => this._paneMenuItems(windowId, id),
			undo: () => { void this._undo(windowId); },
			log: m => this._log.info(m),
		};
	}
	/**
	 * 在**当前这扇桌面窗口**里分屏出一栏新聊天（2026-10-29）。
	 *
	 * 用户原话："新窗口点击后，弹出了一个独立的 desktop 窗口，希望是在当前窗口下，分屏出一个聊天框" ⇒
	 * 目标形态 = 同一个窗口里**左右两栏**：左栏 = 原来的会话，右栏 = 一条**新会话**的纯聊天框
	 * （右栏是 chat-only ⇒ 官方侧栏/右栏被裁掉 ⇒ 不会与左栏重复一套侧栏 ✓）。
	 *
	 * 两栏各自独立：会话 id（`-R` 后缀）+ 网络分区（左栏 desktop / 右栏 desktop-pool-1）
	 * ⇒ 同一 host:port 的 6 条 HTTP/1.1 连接上限不会互相饿死 ✓（判定见 `common/dshChatPartition.ts`）。
	 *
	 * @param viewId 发起请求的那个视图（宿主从页面命令事件里带）⇒ 据它定位是哪扇窗口 ✓
	 * @returns 是否真的加上了这一栏
	 */
	/**
	 * 对"某一栏"执行动作（2026-10-29）：移到极端位置 / 关掉它。**页面菜单**驱动 ✓。
	 *
	 * ⚠ 为什么不是拖拽：aux 窗口的 DOM 层**收不到鼠标事件**（真机：DOM 抓手带能建、能看见，
	 *   但 `mousedown` 从不触发）⇒ 拖拽在这条路上做不到 ⇒ 交互只能放页面里（页面在原生视图内）✓。
	 */
	/**
	 * 页面菜单（主栏「布局 ▾」等，经桥 `paneAction`）⇒ 落到某扇窗口的格子上。
	 * ⚠ 右侧每格自己的操作在宿主画的**标题栏**里（不经桥）；这里只处理页面发来的那几项 ✓。
	 */
	private async _paneActionByView(viewId: string, action: DshPaneAction): Promise<boolean> {
		const entry = this._findEntry(viewId);
		if (!entry) {
			this._log.warn('[dshHarness] pane action: 找不到该视图所属的桌面窗口');
			return false;
		}
		const w = entry.windowId;
		this._log.info(`[dshHarness] pane action: ${viewId} ⇒ ${action}`);
		switch (action) {
			case 'ratio33': case 'ratio50': case 'ratio67':
				this._pushUndo(entry);
				this._splitRatio = action === 'ratio33' ? 1 / 3 : action === 'ratio50' ? 1 / 2 : 2 / 3;
				this._persistSplitRatio();
				entry.layout?.();
				return true;
			case 'arrange': this._arrange(w); return !!entry.tree;
			case 'equalize': this._equalizeAll(w); return !!entry.tree;
			case 'closeAll': this._closeMany(w, undefined); return true;
			case 'close': return viewId !== entry.viewId && this._closePane(w, viewId);
			case 'moveLeft': case 'moveRight': case 'moveTop': case 'moveBottom': {
				if (viewId === entry.viewId) { return false; }
				const edge = action === 'moveLeft' ? 'left' : action === 'moveRight' ? 'right' : action === 'moveTop' ? 'top' : 'bottom';
				this._dockPane(w, viewId, edge);
				return true;
			}
		}
	}

	/**
	 * 在这扇桌面窗口的右侧**新开一格**（新会话、chat-only、独立分区）。
	 *
	 * · 不指定位置（主栏「新窗格」）⇒ 切开**最大**的那一格（宽就左右切、高就上下切，放不下就换方向）；
	 * · 指定位置（某格标题栏「向右/向下拆分」）⇒ 切开那一格；
	 * · 放不下 / 已满 6 格 ⇒ **明确告诉用户**，不切出窄条、也不偷偷换绑别的格子 ✓（与效果图一致）。
	 * · **不**自动重排已有格子（手动布局不被覆盖）✓。
	 */
	private async _ensureSplitPane(viewId: string, at?: { target: string; zone: DshDropZone }): Promise<boolean> {
		const entry = this._findEntry(viewId);
		if (!entry) {
			this._log.warn('[dshHarness] split pane: 找不到该视图所属的桌面窗口 ⇒ 放弃');
			return false;
		}
		// ⚠ **并发重入守卫**（2026-10-29 真机：一次点击打出两条"已分屏"日志、右栏 id 还相同）：
		//   两次调用都在 `await createView` 期间 ⇒ 都看到同一份旧状态 ⇒ 都去新建 ✗
		//   ⇒ 同一扇窗口 800ms 内只接受一次分屏请求（顺带防手抖双击）✓
		const now = Date.now();
		if (now - (this._splitStartedAt.get(entry.windowId) ?? 0) < 800) {
			this._log.info('[dshHarness] split pane: 800ms 内的重复请求 ⇒ 忽略（防止并发建出两栏）');
			return false;
		}
		this._splitStartedAt.set(entry.windowId, now);
		const say = (msg: string) => {
			this._log.info('[dshHarness] split pane: ' + msg);
			if (entry.chrome) { entry.chrome.toast(msg, false); } else { this._notifications.info(msg); }
		};
		if (this._rightPanes(entry).length >= MAX_DESKTOP_SPLIT_PANES) {
			say(`最多 ${MAX_DESKTOP_SPLIT_PANES} 格（每格都是一个完整的聊天客户端）`);
			return false;
		}
		// 落点：先算好再建视图（放不下就别白建一个会话）
		let place: { target: string; zone: DshDropZone } | undefined;
		if (entry.tree) {
			const rects = this._lastRects.get(entry.windowId) ?? new Map();
			if (at) {
				const r = rects.get(at.target);
				if (r && !entry.maxId && !canSplitRect(r, at.zone, DESKTOP_CELL_MIN_W, DESKTOP_CELL_MIN_H)) {
					say(at.zone === 'right' ? '这一格太窄，放不下左右两格' : '这一格太矮，放不下上下两格');
					return false;
				}
				place = at;
			} else {
				const pick = pickSplitTarget(rects, DESKTOP_CELL_MIN_W, DESKTOP_CELL_MIN_H);
				if (!pick) {
					say('右侧空间不够再切一格了：先把主栏调窄，或关掉一格');
					return false;
				}
				place = { target: pick.viewId, zone: pick.zone };
			}
		}
		const before = this._snapshot(entry);
		const seq = (entry.seq ?? 0) + 1;
		entry.seq = seq;
		// 会话后缀按**序号**错开（R / R2 / R3…，单调递增）⇒ 关掉再开也不会与现存格子撞同一会话 ✓
		const suffix = seq === 1 ? 'R' : `R${seq}`;
		const sessionId = await this._ensurePopoutSessionId(entry.windowId, undefined, suffix);
		if (!sessionId) {
			say('新会话没起来，没有加格子');
			return false;
		}
		const splitViewId = `dsh-desk-split-w${entry.windowId}-${Date.now().toString(36)}`;
		// 第 7 参 `overrideChatOnlyUi = true` ⇒ 右栏**只要对话区**（官方侧栏/右栏被裁掉 ⇒ 不重复侧栏）；
		// 末参 `isolatedPool = true` ⇒ 右栏独占一个网络分区（不与左栏抢那 6 条连接）✓
		await this._dsh.createView(splitViewId, entry.windowId, 'chat', sessionId, undefined, undefined, true, true);
		(entry.meta ?? (entry.meta = new Map())).set(splitViewId, { title: `新会话 ${seq}`, sessionId });
		entry.paneViewIds = [...(entry.paneViewIds ?? [entry.viewId]), splitViewId];
		entry.splitViewId = splitViewId;
		entry.tree = !entry.tree || !place
			? { type: 'leaf', viewId: splitViewId }
			: insertSplitLeafBeside(entry.tree, place.target, splitViewId, place.zone) ?? insertSplitLeafBeside(entry.tree, splitLeaves(entry.tree).at(-1)!, splitViewId, 'right')!;
		entry.maxId = undefined;
		this._pushUndo(entry, before);
		(entry.hidden ?? (entry.hidden = new Set())).add(splitViewId);   // 新视图建出来是隐藏的 ⇒ 交给 layout 显示
		entry.layout?.();
		await this._dsh.setViewVisible(splitViewId, true, true).catch(() => undefined);
		entry.hidden?.delete(splitViewId);
		// 启动存活巡检（20s 一次）⇒ 那一格崩了/被回收了 ⇒ 收掉它（见 `_checkSplitPane`）✓
		this._startSplitWatcher(entry.windowId, splitViewId);
		this._log.info(`[dshHarness] split pane: 窗口 ${entry.windowId} 已分屏（右栏 ${splitViewId} / 会话 ${sessionId}${place ? ` / 切开 ${place.target} ${place.zone}` : ''}）`);
		return true;
	}

	private _stopSplitWatcher(windowId: number, viewId: string): void {
		const watchers = this._splitWatchers.get(windowId);
		const w = watchers?.get(viewId);
		if (w && watchers) { clearInterval(w.timer); watchers.delete(viewId); }
	}

	/** 给某个右栏起一个存活巡检（20s 一次；每栏一个）✓。 */
	private _startSplitWatcher(windowId: number, viewId: string): void {
		let watchers = this._splitWatchers.get(windowId);
		if (!watchers) {
			watchers = new Map();
			this._splitWatchers.set(windowId, watchers);
		}
		const old = watchers.get(viewId);
		if (old) { clearInterval(old.timer); }
		watchers.set(viewId, {
			timer: setInterval(() => { void this._checkSplitPane(windowId, viewId); }, 20_000),
			sawComposer: false,
			misses: 0,
		});
	}

	/**
	 * 右栏**存活巡检**（20s 一次）。
	 *
	 * 两种坏法：
	 *  ① 视图槽**已被回收**（崩溃 / 被主进程 dispose）⇒ `listViews()` 里找不到 ⇒ 立刻回落单栏 ✓；
	 *  ② 视图还在但**长期无响应**（白屏、页面卡死且看门狗已放弃）⇒ 连续 3 次探测不到 composer ⇒ 回落 ✓。
	 *
	 * ⚠ 探测必须给 **200ms** 而不是 0：主进程 `waitViewSelector` 的实现里 timeout=0 会**立即超时**
	 *   返回 false（连"视图还在、只是还没 composer"都分不出来）⇒ 会误杀刚建好的右栏 ✗。
	 * ⚠ 只在**曾经出现过** composer 之后才开始计 miss（`sawComposer`）⇒ 右栏还在加载时不算坏 ✓。
	 */
	private async _checkSplitPane(windowId: number, splitViewId: string): Promise<void> {
		const watcher = this._splitWatchers.get(windowId)?.get(splitViewId);
		if (!watcher) { return; }
		const entry = this._desktopWindows.get(windowId);
		if (!entry || !(entry.paneViewIds ?? []).includes(splitViewId)) { return; }   // 已被换掉 / 窗口关了
		const views = await this._dsh.listViews().catch(() => undefined);
		if (!views) { return; }                                        // 查不到就下轮再说
		if (!views.some(v => v.viewId === splitViewId)) {
			this._dropSplitPane(windowId, splitViewId, '那一格的视图已被回收');
			return;
		}
		const alive = await this._dsh.waitViewSelector(splitViewId, '[data-composer-card]', 200).catch(() => false);
		if (alive) {
			watcher.sawComposer = true;
			watcher.misses = 0;
			return;
		}
		if (!watcher.sawComposer) { return; }   // 还没出现过 composer ⇒ 可能仍在加载
		if (entry.hidden?.has(splitViewId)) { return; }   // 被我们藏着（最大化其它格 / 挖洞）⇒ 不算坏
		watcher.misses++;
		if (watcher.misses >= 3) {
			this._dropSplitPane(windowId, splitViewId, `那一格连续 ${watcher.misses} 次无响应`);
		}
	}

	/**
	 * 收掉**出问题的那一格**（自愈用）：dispose 视图 + 清登记 + 清巡检 + 重排 ✓。
	 *
	 * ⚠ 2026-10-30 修：旧实现收的是"最后一栏"而不是出问题的那一格（多格时会误杀好格子）✗。
	 * ⚠ 用户视角 = 那一格消失（其余格子补位、不重排）⇒ **可见的**自愈 + 通知。
	 */
	private _dropSplitPane(windowId: number, paneId: string, reason: string): void {
		const entry = this._desktopWindows.get(windowId);
		if (!entry || !this._rightPanes(entry).includes(paneId)) { return; }
		this._disposePane(windowId, paneId);
		entry.splitViewId = this._rightPanes(entry).at(-1);
		entry.layout?.();
		this._log.warn(`[dshHarness] split pane: ${reason} ⇒ 已收掉那一格（剩 ${this._rightPanes(entry).length} 格）`);
		// ★ 2026-10-29：弹一条通知 ⇒ 用户知道那一格去哪了（否则只是"凭空消失"✗）。
		this._notifications.warn(`dsh 桌面窗口：有一格异常已收掉（${reason}）。若要再来一格，点会话头右侧的「新窗格」。`);
	}

	private async _quit(reason: string): Promise<void> {
		this._log.info(`[dshHarness] ${reason} ⇒ 退出应用（桌面模式下不再把 IDE 主窗口露出来）`);
		try {
			await this._nativeHostService.quit();
		} catch (err) {
			this._log.warn(`[dshHarness] quit failed（${reason}）`, err);
		}
	}

	/**
	 * 已开着的**桌面窗口**（2026-10-29 起**可多开**；键 = vscodeWindowId）。
	 *
	 * 为什么从单例改成 Map：多窗口并行是明确的产品需求（"像 codex 一样同时开多个聊天窗口"）
	 * ⇒ 一扇一扇地开，每扇有**自己的会话**（会话 id 按窗口 id 派生 ⇒ 天然不共享）与
	 * **自己的网络分区**（第 2..N 扇各占一个 ⇒ 两扇窗口不会互相饿死）✓。
	 *
	 * ⚠ **复用语义保留**：默认（`newWindow` 缺省）仍是**聚焦已开着的窗口**、不新开
	 *   （那是 2026-10-17 修「点 agent 条目弹出一叠透明窗口」的定稿）⇒ 只有显式 `newWindow` 才另开一扇 ✓。
	 */
	private readonly _desktopWindows = new Map<number, IDeskEntry>();

	/**
	 * **主栏宽度比例**（1/3 ~ 2/3 映射到主栏可用区间，见 `computeMainColumnWidth`）。
	 *
	 * 拖主栏右侧的分隔条 / 主栏「布局 ▾」菜单改它 ⇒ 立即重排 ✓。
	 * 比例**持久化在 IDE storage**（键 `dsh.desktop.split.ratio.v1`）⇒ 下次开窗沿用 ✓
	 * （⚠ 只存比例、不存格子：格子绑的是**新会话**，跨重启恢复没有意义）。
	 */
	private _splitRatio = 0.5;

	/**
	 * 右栏的**存活巡检**状态（键 = windowId）。
	 *
	 * 为什么要巡检：主进程的 page-alive 看门狗对 `surface='chat'` 视图会自动重载最多 2 次，
	 * 但**超限后只打日志、不回收视图** ⇒ 右栏会留一块白屏，而渲染侧还记着它
	 * ⇒ 表现为"右栏空着、也不报错"✗ ⇒ 这里兜底：右栏没了 / 长期无响应 ⇒ 收掉它、回到单栏 ✓。
	 */
	private readonly _splitWatchers = new Map<number, Map<string, { timer: ReturnType<typeof setInterval>; sawComposer: boolean; misses: number }>>();

	/** 最近一次布局算出的每格外框（「新窗格」挑哪一格切、拆分前判放不放得下）✓。 */
	private readonly _lastRects = new Map<number, Map<string, IDshSplitRect>>();

	/**
	 * 每扇窗口**上一次发起分屏**的时间（键 = windowId）。
	 *
	 * ⚠ 防并发重入（2026-10-29 真机：一次点击打出两条"已分屏"日志、右栏 id 还相同）：
	 *   两次调用都在 `await createView` 期间 ⇒ 都看到"还没有右栏"⇒ 都去新建 ✗。
	 */
	private readonly _splitStartedAt = new Map<number, number>();

	/** 每扇窗口最近一次布局的可用区域（视图坐标系；自测判越界用）✓。 */
	private readonly _lastAreas = new Map<number, { x: number; y: number; width: number; height: number }>();

	/**
	 * 右侧内容区的**宽高比**（自动分格用；2026-10-30 自测抓到）。
	 *
	 * ⚠ 两段式布局下内容区通常**又窄又高**（1280 宽窗口：463×801）⇒ 用默认 1.2 会把 2 个右栏排成
	 *   左右各 ~230px（太窄没法用）✗ ⇒ 必须按真实内容区算 ⇒ 2 栏变上下 ✓。
	 */
	private _contentAspect(windowId: number): number {
		const a = this._lastAreas.get(windowId);
		if (!a || a.height < 1) { return 1.2; }
		const mainW = computeMainColumnWidth(a.width, this._splitRatio, true, DESKTOP_MAIN_MIN_W, DESKTOP_PANE_MIN_W);
		return Math.max(0.1, (a.width - mainW - DESKTOP_SPLIT_GAP) / a.height);
	}

	/**
	 * **多格运行时自测**（2026-10-30；环境变量 `VSSAROS_DSH_SPLIT_SELFTEST=1` 时开窗后自动跑）。
	 *
	 * 为什么在宿主里跑而不是外部 CDP 脚本：本机启动路径下 `--remote-debugging-port` 不生效，
	 * 而且 agent 读不了截图 ⇒ 只能让**宿主自己**驱动场景、用**原生 `getBounds()`** 判定、写日志 ✓。
	 * 每步一行 `[dshHarness] selftest: PASS|FAIL <步骤> …`，末行 `selftest: DONE <通过>/<总数>`。
	 */
	private async _runSplitSelfTest(windowId: number): Promise<void> {
		const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
		const entry = this._desktopWindows.get(windowId);
		const chrome = entry?.chrome;
		const dom = entry?.dom;
		if (!entry || !chrome || !dom) { return; }
		const mainId = entry.viewId;
		const doc = dom.container.ownerDocument;
		let pass = 0;
		let total = 0;
		const ok = (name: string, cond: boolean, detail = '') => {
			total++;
			if (cond) { pass++; }
			this._log.info(`[dshHarness] selftest: ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
		};
		const zoomOf = () => getZoomFactor(dom.win);
		/** 当前**可见**的原生视图矩形（CSS 像素；主进程给的是设备像素 ⇒ 除以 zoom）。 */
		const views = async () => {
			await sleep(700);   // layoutView / setViewVisible 是异步 IPC ⇒ 等它落地再读
			const z = zoomOf();
			const all = await this._dsh.listViews().catch(() => []);
			const ids = new Set(entry.paneViewIds ?? [mainId]);
			return all.filter(v => ids.has(v.viewId) && v.nativeVisible)
				.map(v => ({ viewId: v.viewId, x: v.bounds.x / z, y: v.bounds.y / z, width: v.bounds.width / z, height: v.bounds.height / z }));
		};
		const right = () => (entry.tree ? splitLeaves(entry.tree) : []);
		const box = (id: string) => this._lastRects.get(windowId)?.get(id);
		const center = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
		const fire = (target: EventTarget, type: string, x: number, y: number) => target.dispatchEvent(new MouseEvent(type, {
			bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'click' || type === 'dblclick' ? 0 : 1,
		}));
		const click = (el: HTMLElement | undefined) => { if (el) { const c = center(el); fire(el, 'mousedown', c.x, c.y); fire(el, 'mouseup', c.x, c.y); fire(el, 'click', c.x, c.y); } };
		/** 走真实的 DOM 输入路径：在 el 上按下 ⇒ 窗口上分步移动 ⇒ 松开。 */
		const drag = async (el: HTMLElement, x: number, y: number, beforeUp?: () => void) => {
			const r = el.getBoundingClientRect();
			const sx = r.left + Math.min(40, r.width / 3);
			const sy = r.top + r.height / 2;
			fire(el, 'mousedown', sx, sy);
			for (let i = 1; i <= 8; i++) { fire(dom.win, 'mousemove', sx + (x - sx) * i / 8, sy + (y - sy) * i / 8); await sleep(15); }
			beforeUp?.();
			fire(dom.win, 'mouseup', x, y);
			await sleep(60);
		};
		/**
		 * **点得到吗**：元素中心的命中测试必须落在它自己身上（pointer-events / 层级对），
		 * 且该点上方**没有任何可见原生视图**（原生视图盖在 DOM 之上 ⇒ 盖住了就点不到）✓。
		 */
		const reachable = (el: HTMLElement | undefined, vs: { viewId: string; x: number; y: number; width: number; height: number }[]) => {
			if (!el) { return 'missing'; }
			const c = center(el);
			const hit = doc.elementFromPoint(c.x, c.y);
			if (!hit || (hit !== el && !el.contains(hit))) { return `命中的是 ${hit?.tagName ?? 'null'}`; }
			const cover = vs.find(v => c.x > v.x && c.x < v.x + v.width && c.y > v.y && c.y < v.y + v.height);
			return cover ? `被原生视图 ${cover.viewId.slice(-6)} 盖住` : '';
		};
		const savedRatio = this._splitRatio;
		try {
			this._log.info('[dshHarness] selftest: START（走 DOM 输入路径）');
			await sleep(2500);
			let vs = await views();
			ok('1 格：主栏铺满', vs.length === 1 && Math.abs(vs[0].width - (this._lastAreas.get(windowId)?.width ?? 0)) <= 2);

			// 「新窗格」⇒ 与页面按钮同一个宿主入口（页面桥 splitChatPane ⇒ _ensureSplitPane）
			await this._ensureSplitPane(mainId); await sleep(900);
			await this._ensureSplitPane(mainId); await sleep(900);
			const [A, B] = right();
			vs = await views();
			ok('新窗格 ×2 ⇒ 右侧 2 格', right().length === 2 && vs.length === 3, right().join(','));
			const area = this._lastAreas.get(windowId)!;
			ok('原生视图互不重叠、都在窗口内', checkPaneBounds(vs, area, 100).length === 0, checkPaneBounds(vs, area, 100).join('; '));
			ok('主栏 ≥ 720（带官方三栏布局，不会黑屏）', (vs.find(v => v.viewId === mainId)?.width ?? 0) >= 719);

			const reach: string[] = [];
			for (const id of right()) {
				for (const act of ['close', 'split-right', 'split-down']) {
					const why = reachable(chrome.buttonOf(id, act), vs);
					if (why) { reach.push(`${id.slice(-6)}.${act}: ${why}`); }
				}
				const head = chrome.headOf(id);
				const why = head ? reachable(head.firstElementChild as HTMLElement, vs) : 'missing';
				if (why) { reach.push(`${id.slice(-6)}.head: ${why}`); }
			}
			for (const d of chrome.dividerEls) { const why = reachable(d, vs); if (why) { reach.push(`divider: ${why}`); } }
			{ const why = reachable(chrome.mainDividerEl, vs); if (why) { reach.push(`mainDivider: ${why}`); } }
			ok('标题栏 / ✕ / 拆分按钮 / 分隔条 都点得到（命中测试 + 不被原生视图盖住）', reach.length === 0, reach.join('; '));

			// 拖动标题栏：B ⇒ A 的左边缘（放不下就应拒绝）
			const ra = box(A)!;
			const order0 = right().join(',');
			await drag(chrome.headOf(B)!, ra.x + 12, ra.y + ra.height / 2);
			if (canSplitRect(ra, 'left', DESKTOP_CELL_MIN_W, DESKTOP_CELL_MIN_H)) {
				ok('拖 B 标题栏到 A 左边缘 ⇒ B 在 A 左侧', (box(B)?.x ?? 0) < (box(A)?.x ?? 0), right().join(','));
			} else {
				ok('A 太窄 ⇒ 拖到它左边缘被拒绝（不切出窄条）', right().join(',') === order0);
			}
			const o1 = right().join(',');
			const rb = box(B)!;
			await drag(chrome.headOf(A)!, rb.x + rb.width / 2, rb.y + rb.height / 2);
			ok('拖 A 到 B 中央 ⇒ 交换位置', right().join(',') === o1.split(',').reverse().join(','), `${o1} → ${right().join(',')}`);

			// 分隔条
			const div = chrome.dividerEls[0];
			const dm = div ? chrome.dividerOf(div) : undefined;
			if (div && dm) {
				const horiz = dm.dir === 'h';
				const first = right()[0];
				const dim = () => { const r = box(first)!; return horiz ? r.width : r.height; };
				const s0 = dim();
				const c = center(div);
				await drag(div, horiz ? c.x - 40 : c.x, horiz ? c.y : c.y - 40);
				const s1 = dim();
				ok(`拖${horiz ? '左右' : '上下'}分隔条 −40 ⇒ 前一格缩小约 40`, Math.abs((s0 - s1) - 40) <= 12,
					`${Math.round(s0)} → ${Math.round(s1)}（cursor=${div.style.cursor} bar=${Math.round(dm.bar.x)},${Math.round(dm.bar.y)} ${Math.round(dm.bar.width)}x${Math.round(dm.bar.height)}）`);
			} else {
				ok('2 格之间有分隔条', false);
			}

			// 主栏分隔条：拖到最左 ⇒ 下限；双击 ⇒ 复位
			const md = chrome.mainDividerEl!;
			await drag(md, 0, center(md).y);
			vs = await views();
			ok('主栏分隔条拖到最左 ⇒ 主栏 = 下限 720', Math.abs((vs.find(v => v.viewId === mainId)?.width ?? 0) - Math.min(DESKTOP_MAIN_MIN_W, Math.round(area.width * 0.75))) <= 2);
			fire(md, 'dblclick', center(md).x, center(md).y);
			await sleep(200);

			// Esc 取消 / 拖到主栏拒绝
			const o2 = JSON.stringify(entry.tree);
			const rb2 = box(right()[1])!;
			await drag(chrome.headOf(right()[0])!, rb2.x + 10, rb2.y + rb2.height / 2, () => dom.win.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
			ok('拖动中按 Esc ⇒ 取消、布局不变', JSON.stringify(entry.tree) === o2 && !entry.hole);
			await drag(chrome.headOf(right()[0])!, area.x + 200, area.y + 200);
			ok('拖到主栏上 ⇒ 拒绝、布局不变', JSON.stringify(entry.tree) === o2);

			// 关闭 + 撤销
			const victim = right()[0];
			click(chrome.buttonOf(victim, 'close'));
			vs = await views();
			const only = right()[0];
			ok('点 ✕ ⇒ 剩 1 格并铺满右侧、被关的那格不可见', right().length === 1 && !vs.some(v => v.viewId === victim)
				&& Math.abs((box(only)?.width ?? 0) - (area.width - (vs.find(v => v.viewId === mainId)?.width ?? 0) - DESKTOP_SPLIT_GAP)) <= 3);
			click(chrome.undoButton);
			vs = await views();
			ok('点标题条「撤销」⇒ 那一格回来且可见', right().includes(victim) && vs.some(v => v.viewId === victim), right().join(','));

			// 向下拆分（最高那一格）
			const tallest = right().reduce((m, id) => ((box(id)?.height ?? 0) > (box(m)?.height ?? 0) ? id : m));
			const canDown = canSplitRect(box(tallest)!, 'bottom', DESKTOP_CELL_MIN_W, DESKTOP_CELL_MIN_H);
			const n0 = right().length;
			click(chrome.buttonOf(tallest, 'split-down'));
			// 新开一格要先起会话再建视图（真机 1~4s）⇒ 轮询等它就绪，别用固定延时 ✓
			for (let i = 0; i < 40 && right().length === n0; i++) { await sleep(250); }
			await sleep(400);
			const C = right().find(id => id !== A && id !== B);
			if (canDown) {
				ok('点「向下拆分」⇒ 新格在它正下方', !!C && Math.abs((box(C)?.x ?? -1) - (box(tallest)?.x ?? -2)) < 2 && (box(C)?.y ?? 0) > (box(tallest)?.y ?? 0));
			} else {
				ok('空间不够 ⇒「向下拆分」被拒绝', !C);
			}
			vs = await views();
			ok(`${right().length} 格互不重叠`, checkPaneBounds(vs, area, 100).length === 0, checkPaneBounds(vs, area, 100).join('; '));

			// 最大化 / 还原（双击标题栏）
			const m = right()[0];
			fire(chrome.headOf(m)!, 'dblclick', center(chrome.headOf(m)!).x, center(chrome.headOf(m)!).y);
			vs = await views();
			ok('双击标题栏 ⇒ 最大化（其余格隐藏）', entry.maxId === m && vs.filter(v => v.viewId !== mainId).length === 1);
			fire(chrome.headOf(m)!, 'dblclick', center(chrome.headOf(m)!).x, center(chrome.headOf(m)!).y);
			vs = await views();
			ok('再双击 ⇒ 还原', !entry.maxId && vs.length === 1 + right().length);

			// 全部关掉
			for (const id of [...right()]) { click(chrome.buttonOf(id, 'close')); await sleep(80); }
			vs = await views();
			ok('逐个点 ✕ ⇒ 主栏回到铺满', right().length === 0 && vs.length === 1 && Math.abs(vs[0].width - area.width) <= 2);
		} catch (err) {
			ok('自测异常', false, String((err as Error)?.message ?? err));
		}
		this._splitRatio = savedRatio;
		this._persistSplitRatio();
		entry.undo = [];
		entry.layout?.();
		this._log.info(`[dshHarness] selftest: DONE ${pass}/${total}`);
	}

	/**
	 * 给桌面窗口铺一条**自绘标题条**，返回它的高度（2026-10-23，起因见 `_open` 里那段说明）。
	 *
	 * 三件事：
	 *  ① 底色 / 前景取**当前主题**（`--vscode-titleBar-active*`，取不到退回编辑器底色）⇒ 与页面同色；
	 *  ② `-webkit-app-region: drag` 把拖拽补回来（`frame:false` 的窗口没有原生标题栏，否则拖不动 ✗）；
	 *  ③ 顺手把 Electron 画的三个窗控按钮染成同色系（窗口没有 overlay 时主进程只 warn 跳过，不会抛 ✓）。
	 */
	private _installTitleBar(auxWindow: Awaited<ReturnType<IAuxiliaryWindowService['open']>>, title: string): number {
		const win = auxWindow.window;
		const container = auxWindow.container;
		let bg = '';
		let fg = '';
		try {
			const cs = win.getComputedStyle(container);
			bg = (cs.getPropertyValue('--vscode-titleBar-activeBackground') || '').trim();
			fg = (cs.getPropertyValue('--vscode-titleBar-activeForeground') || '').trim();
			if (!bg || bg === 'transparent') { bg = (cs.getPropertyValue('--vscode-editor-background') || '').trim(); }
			if (!fg || fg === 'transparent') { fg = (cs.getPropertyValue('--vscode-foreground') || '').trim(); }
		} catch { /* 取不到主题色 ⇒ 用兜底色 */ }
		bg = bg && bg !== 'transparent' ? bg : '#1b1c1f';
		fg = fg && fg !== 'transparent' ? fg : '#e6e6e6';

		try {
			const bar = append(container, $('.vssaros-desk-titlebar'));
			bar.style.cssText = [
				'position:absolute', 'left:0', 'top:0', 'right:0',
				`height:${DESKTOP_TITLEBAR_H}px`, 'box-sizing:border-box',
				'display:flex', 'align-items:center', 'gap:8px', 'padding-left:12px',
				'font-size:12px', 'line-height:1', 'white-space:nowrap', 'overflow:hidden',
				'z-index:2', 'pointer-events:auto',
				// 拖拽 + 不许选中文字（否则拖窗口会顺手选中标题）
				'-webkit-app-region:drag', 'user-select:none',
				`background:${bg}`, `color:${fg}`,
			].join(';');
			/*
			 * ★ 2026-10-29（用户：左上角 logo 和品牌名**右侧**加版本号）：
			 *   原来整条标题条只有一行文字（`bar.textContent = title`）⇒ 只能显示品牌名。
			 *   现在拆成「品牌名 + 版本号」两个节点：版本号小一号、淡一点，紧跟在品牌名右侧。
			 */
			const brand = append(bar, $('span.vssaros-desk-brand'));
			brand.style.cssText = 'flex:none;font-weight:600;';
			brand.textContent = title;
			const version = append(bar, $('span.vssaros-desk-version'));
			version.style.cssText = [
				'flex:none', 'margin-left:8px', 'font-size:11px', 'font-weight:400',
				`color:${fg}`, 'opacity:.62', 'letter-spacing:.02em',
			].join(';');
			version.textContent = `v${this._productService.version}`;
			// 窗控按钮（Electron 画在我们这条 DOM 之上）：颜色跟着主题走
			void this._nativeHostService.updateWindowControls({
				targetWindowId: win.vscodeWindowId,
				height: DESKTOP_TITLEBAR_H,
				backgroundColor: bg,
				foregroundColor: fg,
			}).catch(() => undefined);
		} catch (err) {
			this._log.warn('[dshHarness] desktop titlebar: 自绘标题条失败（退回无标题条，窗口仍可用）', err);
			return 0;
		}
		return DESKTOP_TITLEBAR_H;
	}

	/**
	 * 在桌面窗口里显示一条**失败提示条**（2026-10-27）。
	 *
	 * 为什么必须显示：会话创建失败时桌面窗口会停在官方 hero（输入框被官方 `inert` 禁用），
	 * 页面自身不会说原因 ⇒ 用户只看到"窗口开了但不能用"，日志里才有答案 ✗。
	 *
	 * ⚠ 位置与层级：dsh 界面是主进程的 `WebContentsView`，画在窗口 DOM **之上**；
	 *   但自绘标题条（`z-index:2`）证明 DOM 也能盖在它上面 ⇒ 这里沿用同一招（`z-index:3`），
	 *   贴在标题条正下方。右侧留 132px 给 Electron 画的窗控按钮（不要压住它们 ✗）。
	 *
	 * @param onRetry 「重试」按钮的动作（重新走一遍会话启动）。
	 */
	private _showStartupBanner(
		container: HTMLElement,
		titleBarH: number,
		message: string,
		attempt: number,
		onRetry: () => void,
		/**
		 * 提示条的性质（2026-10-29）。
		 *
		 * · `error`   —— **真的失败**（不可重试 / 重试用尽）：黄条 + 「重试」按钮 ✓；
		 * · `waiting` —— **正在重试**（这类错误多半是"桥/会话通道还没就绪"，等一等就好）：
		 *   用**信息色**、**不给「重试」按钮**（此刻给按钮会误导成"必须手动点"），
		 *   措辞也从"失败"改成"正在等待…" ✓。
		 *
		 * 为什么必须分级（真机 2026-10-29）：Host ready 之后 mux 路由还要几秒才可用，
		 * 于是 `startSession` 头一两次必然失败 ⇒ 旧口径把**正在重试**也写成
		 * 「会话启动失败（第 2/3 次）」⇒ 用户看到红色"失败"，其实几十秒后自己就好了 ✗✗。
		 */
		level: 'error' | 'waiting' = 'error'
	): void {
		const banner = append(container, $('.vssaros-desk-banner'));
		const waiting = level === 'waiting';
		banner.style.cssText = [
			'position:absolute', 'left:0', 'right:132px', `top:${titleBarH}px`,
			'box-sizing:border-box', 'display:flex', 'align-items:center', 'gap:10px',
			'padding:6px 10px', 'font-size:12px', 'line-height:1.4',
			'z-index:3', 'pointer-events:auto', 'user-select:text',
			waiting
				? 'background:var(--vscode-editorWidget-background, #252526)'
				: 'background:var(--vscode-inputValidation-warningBackground, #5a3a00)',
			waiting
				? 'color:var(--vscode-foreground, #cccccc)'
				: 'color:var(--vscode-inputValidation-warningForeground, #ffffff)',
			waiting
				? 'border-bottom:1px solid var(--vscode-editorWidget-border, #454545)'
				: 'border-bottom:1px solid var(--vscode-inputValidation-warningBorder, #b89500)',
		].join(';');
		const text = append(banner, $('span'));
		text.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;';
		text.textContent = waiting
			? `正在等待会话通道就绪（第 ${attempt}/${SESSION_START_MAX_ATTEMPTS} 次）…：${message}`
			: `会话启动失败（第 ${attempt}/${SESSION_START_MAX_ATTEMPTS} 次）：${message}`;
		if (!waiting) {
			const retry = append(banner, $('button.vssaros-desk-banner-retry'));
			retry.style.cssText = [
				'flex:none', 'padding:3px 10px', 'font-size:12px', 'cursor:pointer',
				'background:var(--vscode-button-background, #0e639c)',
				'color:var(--vscode-button-foreground, #ffffff)',
				'border:1px solid var(--vscode-button-border, transparent)', 'border-radius:2px',
			].join(';');
			retry.textContent = '重试';
			retry.addEventListener('click', () => onRetry());
		}
		this._startupBanner?.remove();
		this._startupBanner = banner;
	}

	/** 撤掉失败提示条（会话启动成功 / 窗口关掉时）。 */
	private _clearStartupBanner(): void {
		this._startupBanner?.remove();
		this._startupBanner = undefined;
	}

	/**
	 * **拼装式 desktop**（2026-10-18 起的默认形态）：左=会话列表页、右=dsh 聊天（`surface=chat`）。
	 *
	 * 为什么这样拼（而不是上游 `createAuxiliaryEditorPart`）：
	 *  · 上游那条经**渲染进程 `window.open`** 建窗，在本构建里实测窗口永远是 `about:blank`
	 *    （窗口存在但从不加载 ⇒ 白窗，`/json/list` 里也没有它的 page target）✗；
	 *  · 本贡献用的 `IAuxiliaryWindowService.open()` 是**已验证可用**的那条路（官方整页形态一直用它）✓；
	 *  · 聊天用 `surface=chat`（长期稳定、输入正常），**不加载会整页卡死的官方 full 页** ✓；
	 *  · 左侧直接复用 dsh 自己的会话页 `/x/sessions/`（与主窗口同一份 Host 数据 ⇒ 会话池天然共享 ✓）。
	 *
	 * 右侧工作台页签 = P2（先把"能进会话、能打字"这条主线立住）。
	 */
	private async _openComposed(auxWindow: Awaited<ReturnType<IAuxiliaryWindowService['open']>>, windowId: number, sessionId: string | undefined, booting?: HTMLElement, titleBarH = 0, windowTitle = 'VsSaros — Desktop'): Promise<boolean> {
		const win = auxWindow.window;
		const container = auxWindow.container;
		container.style.background = 'var(--vscode-editor-background)';
		win.document.title = windowTitle;

		const stamp = Date.now().toString(36);
		const chatViewId = `dsh-desk-chat-w${windowId}-${stamp}`;

		// ★ 2026-10-18（复刻官方 desktop 布局）：**单个 `surface=chat` 视图 + 保留官方 chrome**
		//   （`overrideChatOnlyUi = false`）—— 官方侧栏（品牌头 / 新会话 / 插件 / 自动化任务 /
		//   工作区分组会话 / 页脚）与右栏都由 dsh 自己画，我们只把「工作区」区换成多根单条目那套
		//   （`client.workspaces.js`，判据是 `data-vssaros-chat-only=0`）。
		//   为什么不拼 3 个视图：官方侧栏/右栏本来就在这一页里，拼出来只会重复且更难对齐 ✓。
		// 末一个参数 `isolatedPool = true`：弹窗用**独立网络分区**，不与主窗口争同一个 host:port 的 6 条并发连接
		//（真机实测：共享池被占满后三页 fetch 全超时、create 永不返回；见 DSH_VIEW_PARTITION_DESKTOP 注释）。
		await this._dsh.createView(chatViewId, windowId, 'chat', sessionId, undefined, undefined, false, true);
		// ★★ 2026-10-28（用户："第一次启动，dsh desktop 会**闪一下 dsh web profile 的默认样式**，然后才切到 vssaros"）：
		//   **占位先别撤**。视图在 `createView` 里是 `setVisible(false)` 的，而官方 UI 会先 paint
		//   一帧、我们的换皮 chunk（品牌头 / 多根侧栏 / 页签条）后到 ⇒ 视图一显示就露出"默认样式"，
		//   视觉上正是"闪一下"。⇒ 让占位一直盖着，等换皮锚点出现再显示视图（见下面的 `waitViewSelector`），
		//   到那一刻才撤占位（撤早了会在缩窗瞬间露边）。

		/**
		 * 把原生视图贴回容器矩形。
		 *
		 * ★★ 2026-10-24（用户："切换到全屏时，没有实时刷新 UI"）：
		 *   原来只有 `ResizeObserver(container)` + `auxWindow.onDidLayout` 两个触发点。全屏切换（Windows）
		 *   是**系统动画 + 0~2 次尺寸变化**，实测会出现：RO 在容器还没换尺寸时先触发一次、之后**不再触发**，
		 *   `onDidLayout` 也只在 main 报窗口 bounds 时才有 ⇒ 原生 `WebContentsView` 停在全屏前的矩形上，
		 *   右边/下边露出一块空底色 ✗。
		 *   ⇒ 现在四保险：① 窗口 `resize`（全屏一定会触发）；② 文档 `fullscreenchange`（含延迟两次重排，
		 *   覆盖动画中间那帧）；③ 保留 RO / onDidLayout；④ **500ms 轻量自愈**（矩形变了才补发，事件丢了也能自恢复）。
		 *   ⚠ 每次都做"矩形没变就不发"的防抖 ⇒ 自愈不会刷 IPC ✓
		 */
		let lastLayoutKey = '';
		// ★ 2026-10-30：多格外壳（DOM 标题栏 / 分隔条 / 挖洞式落点 / 原生菜单 / 标题条撤销），按效果图实现
		const chrome = new DshDesktopSplitChrome(win, container, this._chromeActions(windowId));
		const layout = () => {
			const rect = container.getBoundingClientRect();
			if (rect.width < 1 || rect.height < 1) { return; }
			const zoom = getZoomFactor(win);
			const entry = this._desktopWindows.get(windowId);
			// ★ 两段式布局：**主栏 = 全高左列**（官方侧栏/页签条是它页面的一部分 ⇒ 不许被上下切开）；
			//   右侧格子们的树只占右侧内容区，在区内自由左右/上下分格（主栏不在树里 ⇒ 不可移动/关闭）✓。
			const content: DshSplitNode | undefined = entry?.tree;
			const leaves = content ? splitLeaves(content) : [];
			const maxId = entry?.maxId && leaves.includes(entry.maxId) ? entry.maxId : undefined;
			const hole = entry?.hole && leaves.includes(entry.hole.id) ? entry.hole : undefined;
			const key = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height), zoom,
				JSON.stringify(content ?? null), this._splitRatio, maxId ?? '', hole ? `${hole.id}:${hole.zone}` : ''].join(',');
			if (key === lastLayoutKey) { return; }   // 什么都没变 ⇒ 不重发（防抖）
			lastLayoutKey = key;
			// 让出自绘标题条的高度（原生视图盖在 DOM 上，不留位就把它遮住 ✗）
			const area = { x: rect.left, y: rect.top + titleBarH, width: rect.width, height: Math.max(1, rect.height - titleBarH) };
			this._lastAreas.set(windowId, area);
			// ⚠ 主栏最小 720（带官方三栏布局，压窄会侧栏折叠 + 中栏黑屏）；比例映射到可用区间（纯函数，有单测）
			const mainW = computeMainColumnWidth(area.width, this._splitRatio, leaves.length > 0, DESKTOP_MAIN_MIN_W, DESKTOP_PANE_MIN_W);
			void this._dsh.layoutView(chatViewId, {
				windowId, x: area.x, y: area.y, width: mainW, height: area.height, zoomFactor: zoom,
			});
			const main = { x: area.x, y: area.y, width: mainW, height: area.height };
			const origin = { x: rect.left, y: rect.top };
			if (!entry || !content || leaves.length === 0) {
				this._lastRects.delete(windowId);
				chrome.update({ origin, zoom, main, mainDivider: undefined, panes: [], dividers: [], maxId: undefined, count: 0, maxCount: MAX_DESKTOP_SPLIT_PANES, narrowTip: undefined });
				return;
			}
			const contentArea = { x: area.x + mainW + DESKTOP_SPLIT_GAP, y: area.y, width: Math.max(1, area.width - mainW - DESKTOP_SPLIT_GAP), height: area.height };
			const geo = computePaneGeometry(content, contentArea, DESKTOP_SPLIT_GAP, DESKTOP_PANE_HEAD_H);
			this._lastRects.set(windowId, new Map([...geo.panes].map(([id, g]) => [id, g.box] as const)));
			const fullGeo: IDshPaneBox = {
				box: contentArea,
				head: { x: contentArea.x, y: contentArea.y, width: contentArea.width, height: DESKTOP_PANE_HEAD_H },
				view: { x: contentArea.x, y: contentArea.y + DESKTOP_PANE_HEAD_H, width: contentArea.width, height: Math.max(1, contentArea.height - DESKTOP_PANE_HEAD_H) },
			};
			const shown: IDshChromePane[] = [];
			for (const id of leaves) {
				if (maxId && id !== maxId) { this._setPaneVisible(entry, id, false); continue; }
				const g = maxId ? fullGeo : geo.panes.get(id);
				if (!g) { continue; }
				// 挖洞：拖动时目标格让出落点那一半 ⇒ DOM 落点提示露出来（中央 = 整格让出）
				const view: IDshSplitRect | undefined = hole && hole.id === id ? holeViewRect(g, hole.zone) : g.view;
				if (view) {
					void this._dsh.layoutView(id, { windowId, x: view.x, y: view.y, width: view.width, height: view.height, zoomFactor: zoom });
					this._setPaneVisible(entry, id, true);
				} else {
					this._setPaneVisible(entry, id, false);
				}
				const meta = entry.meta?.get(id);
				shown.push({ id, title: meta?.title ?? '会话', meta: meta ? '#' + meta.sessionId.slice(-4) : '', geo: g });
			}
			if (!hole && !chrome.dragging) {
				this._log.info(`[dshHarness] layout: win=${Math.round(area.width)}x${Math.round(area.height)} zoom=${zoom} panes=${1 + leaves.length} main=w${mainW} content=x${Math.round(contentArea.x)} w${Math.round(contentArea.width)}${maxId ? ` max=${maxId}` : ''}`);
			}
			const narrow = area.width < DESKTOP_MAIN_MIN_W + DESKTOP_PANE_MIN_W
				? `窗口偏窄（${Math.round(area.width)}px < ${DESKTOP_MAIN_MIN_W + DESKTOP_PANE_MIN_W}px），右侧放不下多格` : undefined;
			chrome.update({
				origin, zoom, main,
				mainDivider: { x: area.x + mainW, y: area.y, width: DESKTOP_SPLIT_GAP, height: area.height },
				panes: shown,
				dividers: maxId ? [] : geo.dividers,
				maxId, count: leaves.length, maxCount: MAX_DESKTOP_SPLIT_PANES, narrowTip: narrow,
			});
		};
		const layoutSoon = () => { layout(); win.setTimeout(layout, 120); win.setTimeout(layout, 420); };
		layout();
		win.requestAnimationFrame(() => { layout(); win.requestAnimationFrame(layout); });
		const resizeObserver = new win.ResizeObserver(layout);
		resizeObserver.observe(container);
		const layoutSub = auxWindow.onDidLayout(() => layout());
		win.addEventListener('resize', layout);
		win.addEventListener('fullscreenchange', layoutSoon);
		const layoutTimer = win.setInterval(layout, 500);

		// ★ 等我们的换皮装好再显示。
		//   锚点选 **`data-vssaros-wb-tabstrip`**（页签条外壳）而不是里面的 `data-vssaros-wb-tabs`：
		//   外壳是**常驻 overlay**（`client.workbenchNav` 一渲染就有节点，几何测不到时只是 `display:none`），
		//   而里面那个只在"有页签"时才存在 ⇒ 拿它当锚点会在新会话首屏永远等不到（每次都白等满超时 ✗）。
		//   超时（9s）也照常显示 —— 页面本身出问题时不许白屏 ✗。
		const vssarosReady = await this._dsh.waitViewSelector(chatViewId, '[data-vssaros-wb-tabstrip]', 9_000).catch(() => false);
		if (!vssarosReady) {
			this._log.warn('[dshHarness] desktop: 等换皮超时（9s）⇒ 仍然显示视图（可能是页面本身有问题）');
		}
		await this._dsh.setViewVisible(chatViewId, true, true);
		// 视图已显示（原生层盖住 DOM）⇒ 这时才撤占位（见上面 createView 后的注释）
		booting?.remove();

		const focusChat = () => { void this._dsh.setViewVisible(chatViewId, true, true).catch(() => undefined); };
		win.setTimeout(focusChat, 0);
		win.setTimeout(focusChat, 400);
		win.addEventListener('focus', focusChat);

		const unloadSub = auxWindow.onUnload(() => {
			resizeObserver.disconnect();
			layoutSub.dispose();
			win.removeEventListener('resize', layout);
			win.removeEventListener('fullscreenchange', layoutSoon);
			win.clearInterval(layoutTimer);
			// ★ 2026-10-29（多开 + 分屏）：关掉一扇 ⇒ 从登记表里摘掉（其余窗口不受影响）✓
			//   ⚠ **先取所有格 id 再摘**（摘了就取不到了）—— 每一格都要回收（含**软关闭中**等待回收的），
			//   否则成孤儿视图、它那条会话还在后台跑 ✗。
			const closingEntry = this._desktopWindows.get(windowId);
			const panes = [...(closingEntry?.paneViewIds ?? [chatViewId]), ...(closingEntry?.closing?.keys() ?? [])];
			for (const t of closingEntry?.closing?.values() ?? []) { clearTimeout(t); }
			this._desktopWindows.delete(windowId);
			for (const paneId of panes) {
				void this._dsh.disposeView(paneId).catch(() => undefined);
			}
			chrome.dispose();
			this._lastRects.delete(windowId);
			// ★ 右栏的存活巡检也要停（否则窗口关了还在跑定时器 ⇒ 泄漏 + 误报）✓
			const watchers = this._splitWatchers.get(windowId);
			if (watchers) {
				for (const w of watchers.values()) { clearInterval(w.timer); }
				this._splitWatchers.delete(windowId);
			}
			// ★★ 2026-10-24（修「F5 起来后 app 自己没了」）：
			//   `onUnload` 是 **DOM 的 unload 事件**，页面**导航/重载同样会触发** —— 本机实测：
			//   桌面窗口从 about:blank 跳到真实页面时就会触发一次，于是这条分支把刚启动的 app
			//   直接退掉了（main.log 里那一刻**没有任何窗口关闭事件**，只有 `quit() requested`，
			//   退出码 0 ⇒ 完全不像崩溃，最容易被误判成"F5 没反应/没起来"）。
			//   ⇒ 延后判定：窗口真的没了（`closed`）才退；还活着说明只是导航 ✓
			setTimeout(() => {
				// ① 已经有（另一扇）桌面窗口在屏 ⇒ 这次 unload 只是"换窗"：启动壳被拼装好的
				//    桌面窗口取代时，旧窗会走一次 unload（真机：window 2 → window 3）✗ 不能退。
				if (this._desktopWindows.size > 0) {
					this._log.info(`[dshHarness] 桌面窗口 ${windowId} 的 unload 后还有 ${this._desktopWindows.size} 扇桌面窗口在屏 ⇒ 只是关掉一扇，不退出应用`);
					return;
				}
				// ② 窗口**真的还活着** ⇒ 只是页面导航/重载（unload 也会触发）⇒ 不退出。
				//   ⚠ 判活不能只看 `win.closed`：真机 2026-10-24 15:24 撞到过一次「窗口已销毁但
				//   closed 仍为 false」⇒ 被误判成"导航"⇒ 不退出 ⇒ 桌面窗口没了、IDE 还被我们藏着
				//   ⇒ 屏幕上什么都没有、进程却活着（"F5 卡住但看不到 app"的现场）✗。
				//   改为探活 `document`：窗口销毁后访问它会抛异常或为 null；导航/重载时拿到的是
				//   新 document（readyState=loading|interactive|complete）⇒ 能可靠区分 ✓
				let alive = false;
				try {
					alive = !win.closed && !!win.document && String(win.document.readyState) !== '';
				} catch {
					alive = false;
				}
				if (alive) {
					this._log.info('[dshHarness] 桌面窗口 unload 后仍活着（页面导航/重载）⇒ 不退出应用');
					return;
				}
				// ③ 真的没了：关掉桌面窗口 ⇒ 退出应用（用户 2026-10-22："关闭 desktop 窗口时，更不要打开 IDE"）
				this._quitAfterDesktopClosed();
			}, 1200);
		});
		this._register(toDisposable(() => {
			unloadSub.dispose();
			resizeObserver.disconnect();
			layoutSub.dispose();
		}));

		// ⚠⚠ `tree` **必须为空**（2026-10-30 真机 debug 定位）：两段式布局里 `tree` 是"**右栏**的树"，
		//   主栏不在树里。这里曾写成 `tree: leaf(chatViewId)` ⇒ 布局把**主栏自己**当成内容区的叶子
		//   搬到 x=728/w552 ⇒ 左侧 0~728 全黑、主栏被挤到右半（用户截图"左侧空白 + 布局错乱"）✗✗。
		this._desktopWindows.set(windowId, { windowId, viewId: chatViewId, paneViewIds: [chatViewId], layout, chrome, dom: { win, container } });
		this._log.info(`[dshHarness] composed desktop opened (window ${windowId}, chat ${chatViewId}, session ${sessionId ?? '(无)'})`);
		// ★ 运行时自测（只在显式设了环境变量时跑；正常用户永远不会触发）✓
		let selfTest: string | undefined;
		// ⚠ trim：cmd 里 `set X=1 && …` 会把值设成 "1 "（带尾随空格）⇒ 严格比较永远不成立（2026-10-30 踩过）
		try { selfTest = sandboxProcess?.env?.['VSSAROS_DSH_SPLIT_SELFTEST']?.trim(); } catch { selfTest = undefined; }
		if (selfTest === '1' && !this._selfTestStarted) {
			this._selfTestStarted = true;
			void this._runSplitSelfTest(windowId);
		}
		// ★ DOM 探针（`VSSAROS_DSH_PROBE=1`）：把"入口该不该显示"的**现场事实**打进日志。
		//   为什么需要：页面里的判据（hero / 挂载）我只能靠猜 ⇒ 连续几轮"改了看不到"都是猜错 ✗
		//   ⇒ 用 `waitViewSelector` 逐个查选择器，把真相落日志 ✓（正常用户永不触发）
		let probe: string | undefined;
		try { probe = sandboxProcess?.env?.['VSSAROS_DSH_PROBE']?.trim(); } catch { probe = undefined; }
		if (probe === '1') {
			void this._probeHeroEntry(chatViewId);
		}
		return true;
	}

	/** 自测只跑一次（多扇窗口时只在第一扇上跑）✓。 */
	private _selfTestStarted = false;

	/**
	 * **hero 入口的 DOM 探针**（2026-10-30；`VSSAROS_DSH_PROBE=1` 时开窗后跑一次）。
	 *
	 * 只做一件事：把"入口该不该显示"的现场事实逐条打进日志 ——
	 *   ① `[data-conversation-content]` 在不在（判据的前提）；
	 *   ② 它上面有没有 `data-conversation-session`（有 = 已进会话 ⇒ 入口本就该藏）；
	 *   ③ 外壳 `[data-vssaros-hero-split-host]` 在不在（不在 = 组件没挂载 ⇒ 注册/缓存问题 ✗）；
	 *   ④ 按钮 `[data-vssaros-hero-split]` 在不在（在 = 显示成功）；
	 *   ⑤ 对照组：`[data-vssaros-wb-tabstrip]`（页签条）与 `[data-composer-card]`（输入框）在不在。
	 * ⇒ 看日志就能区分"没挂载 / 判据错 / 显示了但被盖住"三种坏法，不用再猜 ✓。
	 */
	private async _probeHeroEntry(viewId: string): Promise<void> {
		const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
		await sleep(3_000);   // 让页面把换皮 chunk 装完
		const has = async (label: string, selector: string) => {
			const ok = await this._dsh.waitViewSelector(viewId, selector, 500).catch(() => false);
			this._log.info(`[dshHarness] probe: ${ok ? 'YES' : 'no '} ${label}  ⇐ ${selector}`);
			return ok;
		};
		this._log.info('[dshHarness] probe: ==== hero 入口现场 ====');
		const content = await has('会话根容器', '[data-conversation-content]');
		// ⚠ "有没有 data-conversation-session" **不能**用来判 hero（空会话首屏也有它）⇒ 只作参考
		await has('根容器已绑定会话（仅供参考，不能当判据）', '[data-conversation-content][data-conversation-session]');
		const heroPhase = await has('★ 官方 phase = hero', '[data-conversation-content][data-content-phase="hero"]');
		await has('入口外壳（组件已挂载）', '[data-vssaros-hero-split-host]');
		await has('入口外壳=shown', '[data-vssaros-hero-split-host="shown"]');
		await has('入口按钮', '[data-vssaros-hero-split]');
		await has('★ 入口没有压住官方按钮（几何自证）', '[data-vssaros-hero-split-clear="1"]');
		await has('对照·官方「打开侧边栏」', '[data-sidebar-right-expand], [data-sidebar-right-toggle]');
		await has('对照·页签条', '[data-vssaros-wb-tabstrip]');
		await has('对照·输入框', '[data-composer-card]');
		// ★ 「布局 ▾」已按用户要求移除 ⇒ 这两行用来正反确认：
		//   动作组那枚「新窗格」在（说明动作组真的渲染了，反证后面那条"没有"不是因整组不渲染）✓
		await has('动作组·新窗格', '[data-vssaros-new-window]');
		//   ⚠ 期望 **no**（选择器等不到 ⇒ 已移除；若 YES 说明旧 chunk 还在缓存里）
		await has('顶部「布局 ▾」（期望 no）', '[data-vssaros-pane-menu]');
		this._log.info(`[dshHarness] probe: 结论 = 容器${content ? '在' : '缺'}、phase=${heroPhase ? 'hero（入口该显）' : '非 hero（入口该藏）'}`);
	}

	/**
	 * @param onShellOpened 桌面窗口**壳**一出现就回调（此刻 Host 可能还在冷启动）——启动流程用它藏 IDE。
	 *   复用已开窗口时不回调（调用方按返回值兜底）。
	 */
	private async _open(args: { chatId?: string; newWindow?: boolean }, onShellOpened?: () => void): Promise<boolean> {
		// ★ 2026-10-17（用户报「点 agent 条目弹出一叠透明窗口」）：定位触发源 —— 记**调用栈**。
		//   popoutChat 正常只在标题栏按钮被点时才走到这里；如果日志里出现而用户没点按钮，
		//   栈里就是真凶（桥命令 / 其他贡献误调）。
		this._log.info(`[dshHarness] full window open REQUEST (chatId=${args.chatId ?? '(无)'})\n${new Error('caller trace').stack ?? '(no stack)'}`);
		// ★ 同日：单例复用 —— 已开着的全窗 ⇒ 聚焦 + 换绑到目标会话，**不再新开**（与 agents 窗口同病同治：
		//   此前每触发一次新开一个，叠成一屏）。
		// ★ 2026-10-29（桌面窗口多开）：默认仍**复用**；`args.newWindow` 为真才**另开一扇** ✓。
		if (!args.newWindow) {
			for (const [wid, entry] of [...this._desktopWindows]) {
				try {
					// ★ 2026-10-17（用户要求「desktop 与 IDE 里的 dsh 会话互不影响」）：**不再换绑**。
					//   从前每次点弹出都会跟随当前聊天会话 ⇒ 两边显示同一条会话、输入互相可见（用户截图实证）。
					//   现在弹窗有自己的会话（见 _ensurePopoutSessionId），复用只做聚焦 ✓。
					// focus=true 同时把键盘焦点交给原生视图（见 _open 里 focusView 的说明）
					await this._dsh.setViewVisible(entry.viewId, true, true);
					this._log.info(`[dshHarness] desktop window already open (view ${entry.viewId}) ⇒ 聚焦复用，不再新开`);
					return true;
				} catch {
					// 视图已没了（窗口被关 / 视图被回收）⇒ 这扇窗失效 ⇒ 记下并继续看下一扇 ✓
					this._desktopWindows.delete(wid);
				}
			}
		}
		// ★ 2026-10-22（用户："启动 app 时，能否仅启动窗口版"）：**先建窗口壳，再等 Host**。
		//   旧顺序是 `ensureStarted()` → `open()`：Host 冷启动 17s+ 期间屏幕上**没有任何**桌面窗口 ⇒
		//   启动流程只能让 IDE 先露面兜底（真机：IDE 闪了 1.4s）✗。现在壳 ~3s 就出来（带"正在启动"占位），
		//   `onShellOpened` 一响启动流程就能把 IDE 藏起来 ⇒ Host 多慢都不必露出 IDE ✓。
		// ★ 2026-10-23（用户："窗口的 titlebar 颜色风格与当前不一致"）：**不再用原生标题栏**。
		//   原生标题栏的颜色由系统主题决定（用户机器是浅色系统 + 我们的深色界面 ⇒ 白条压着深色页面 ✗），
		//   Electron 也没有"按窗口改原生标题栏颜色"的 API（`setTitleBarOverlay` 对原生标题栏的窗口必抛，
		//   见 `windowImpl.updateWindowControls` 里那条守卫）。⇒ 换成 VS Code 主窗口同一套：
		//   `titleBarStyle:'hidden'` + `titleBarOverlay`（窗控按钮由 Electron 画、颜色由我们给），
		//   我们自己铺一条 29px 的**可拖拽**标题条（`frame:false` 的窗口否则拖不动 ✗），
		//   并把原生视图整体下移 29px（`WebContentsView` 盖在 DOM 之上 ⇒ 不留位就看不见这条）。
		const auxWindow = await this._auxWindowService.open({
			bounds: { width: 1280, height: 840 },
		});
		const win = auxWindow.window;
		const windowId = win.vscodeWindowId;
		// ★ 2026-10-29（多开）：第 2 扇起标题带序号 ⇒ 用户分得清哪扇是哪扇 ✓
		const windowNo = this._desktopWindows.size + 1;
		const windowTitle = windowNo > 1 ? `VsSaros — Desktop ${windowNo}` : 'VsSaros — Desktop';
		win.document.title = windowTitle;
		auxWindow.container.style.background = 'var(--vscode-editor-background)';
		// 自绘标题条（颜色取当前主题 ⇒ 与页面一致；拖拽也由它承担）
		const titleBarH = this._installTitleBar(auxWindow, windowTitle);
		// 占位（原生视图盖上来之前别让用户对着一块纯色猜）。⚠ 用**主窗口** document 建元素（aux 的 createElement 被禁）。
		const booting = append(auxWindow.container, $('.dsh-desktop-booting'));
		booting.style.cssText = `position:absolute;inset:${titleBarH}px 0 0 0;display:flex;align-items:center;justify-content:center;color:var(--vscode-descriptionForeground);font-size:13px;`;
		// ★ 2026-10-28（用户：「首次打开加载时间太长」）：文案分阶段。原来一句话挂到底，
		//   用户看不出是"卡住了"还是"在干活"⇒ 首启 30s 的体感比实际更糟。
		booting.textContent = '正在启动后台服务…（首次启动或插件更新后需要十几秒，之后会快很多）';
		// Host 就绪前用户就把窗口关了 ⇒ **退出应用**（2026-10-22 用户要求：桌面模式下不露 IDE）：
		//   · 隐藏启动下 IDE 主窗口**从出生就是隐藏的**（`_ideHiddenByStartup` 可能还没置位）⇒
		//     只走 `_quitAfterDesktopClosed` 会判"不是我们藏的"而跳过 ⇒ 进程活着却没有界面 ✗；
		//   · 所以"启动流程自动开的窗"被关时一律退出（用户已经关掉唯一可见的窗口 = 关掉这个 app ✓）。
		let closedWhileBooting = false;
		// 只有**启动流程**自动开的窗（带 `onShellOpened`）或"IDE 已被我们藏起来"时才退；
		// 手动 popout（IDE 还露着、用户在用）关掉桌面窗口不该把整个 app 带走 ✓
		const quitsOnClose = !!onShellOpened || this._ideHiddenByStartup;
		const bootUnload = auxWindow.onUnload(() => {
			closedWhileBooting = true;
			this._ideHiddenByStartup = false;   // 同步清 ⇒ 拼装期那个 onUnload 若同时触发不会重复退出
			// 同上（2026-10-24）：unload 也可能是导航/重载 ⇒ 延后确认窗口真的没了才退。
			if (quitsOnClose) {
				setTimeout(() => {
					// 判活口径与 `_openComposed` 里一致：探 document，而不是只看 `closed` ✗
					let alive = false;
					try { alive = !win.closed && !!win.document && String(win.document.readyState) !== ''; } catch { alive = false; }
					if (!alive) { void this._quit('桌面窗口在启动阶段被关闭'); }
				}, 1200);
			}
		});
		onShellOpened?.();
		try {
			await this._dsh.ensureStarted();
			// 第 2 阶段：后台进程已起 ⇒ 换文案（剩下的是等会话通道 + 建视图 + 页面首帧）
			booting.textContent = '后台服务已启动，正在等待会话通道就绪…';
		} catch (err) {
			booting.textContent = `VsSaros 后台服务启动失败：${String((err as Error)?.message ?? err)}`;
			bootUnload.dispose();
			throw err;
		}
		// ★★ 2026-10-29（真机 logs/20261029T101501）：Host 说 ready 时，mux 升级路由还没注册
		//   （mux route available +4777 ms after Host ready，历史样本到 +11.4s）⇒ 这段时间里任何
		//   session.start 都必然失败 ⇒ 桌面窗口原本只能退避重试（4s/12s）并弹一条假的"启动失败"黄条。
		//   ⇒ 发起会话之前先等路由通：一次成功、没有黄条，也不必白等 8~16s。
		//   等不到（Host 没了 / 超过 20s）⇒ 照旧走原来的失败重试路径。
		const muxReady = await this._dsh.waitForMuxReady();
		if (muxReady) {
			booting.textContent = '后台服务已就绪，正在加载界面…';
		} else {
			this._log.warn('[dshHarness] full window: mux 路由未在等待窗口内就绪 ⇒ 照旧走会话重试');
			booting.textContent = '后台服务已启动，正在加载界面…';
		}
		if (closedWhileBooting) {
			bootUnload.dispose();
			this._log.info('[dshHarness] desktop window closed while the Host was starting ⇒ 不再继续建视图');
			return false;
		}
		// 会话解析放在窗口之后：独立会话 id 依赖 windowId（见 _ensurePopoutSessionId）
		// ★ 2026-10-27：失败时**在窗口里显示原因 + 重试按钮**（否则用户只看到 hero + 禁用输入框，
		//   而答案只在日志里 ✗）；重试 = 重新跑一遍这整段（含再建视图）。
		const sessionId = await this._ensurePopoutSessionId(windowId, (message, attempt, level) => {
			this._showStartupBanner(auxWindow.container, titleBarH, message, attempt, () => {
				this._clearStartupBanner();
				void this._open(args).catch(err => this._log.warn('[dshHarness] desktop: 会话重试失败', err));
			}, level ?? 'error');
		});
		if (sessionId) {
			this._clearStartupBanner();
		}
		// ★ 2026-10-18（默认形态）：**拼装式 desktop** —— 左=会话列表页、右=dsh 聊天（surface=chat）。
		//   为什么不用上游 `createAuxiliaryEditorPart`：它经渲染进程 `window.open` 建窗，在这个构建里
		//   建出来的窗口 URL 永远是 `about:blank`（真机实测：窗口存在但从不加载 → 白窗），而本贡献用的
		//   `IAuxiliaryWindowService.open()` 是**已验证可用**的那条路 ✓。
		//   聊天用 `surface=chat`（长期稳定）；不加载会整页卡死的官方 full 页 ✓。
		const popoutStyle = this._configurationService.getValue<string>(DshHarnessSettings.PopoutStyle) ?? 'composed';
		if (popoutStyle === 'composed') {
			// 启动期的关窗处理一直留到拼装完成（它注册了自己的 onUnload）⇒ 中途关窗也能正确收场 ✓
			//（两者都触发时 `_quitAfterDesktopClosed` / `_quit` 是幂等的：标记先同步清掉）
			try {
				return await this._openComposed(auxWindow, windowId, sessionId, booting, titleBarH, windowTitle);
			} finally {
				bootUnload.dispose();
			}
		}
		bootUnload.dispose();
		// web 档有自己的占位（文案不同）⇒ 先撤掉启动占位，免得两层叠字
		booting.remove();
		const container = auxWindow.container;
		container.style.background = 'var(--vscode-editor-background)';
		win.document.title = 'VsSaros — DeepSeek Harness';

		// 加载提示占位（原生视图盖上来之前别让用户对着一块纯色猜）。
		// ⚠ 元素必须用**主窗口** document 创建（aux 窗口的 createElement 被禁，见分层约定）。
		const placeholder = append(container, $('.dsh-full-window-placeholder'));
		placeholder.style.cssText = `position:absolute;inset:${titleBarH}px 0 0 0;display:flex;align-items:center;justify-content:center;color:var(--vscode-descriptionForeground);font-size:13px;`;
		placeholder.textContent = '正在加载 dsh 客户端…';

		const viewId = `dsh-full-w${windowId}-${Date.now().toString(36)}`;
		await this._dsh.createView(viewId, windowId, 'full', sessionId);

		// ★ 2026-10-24（"切换到全屏时，没有实时刷新 UI"）：与拼装式那处同款四保险，
		//   详见上面那段注释（窗口 resize / fullscreenchange（含延迟重排）/ RO+onDidLayout / 500ms 自愈）。
		let lastLayoutKey = '';
		const layout = () => {
			const rect = container.getBoundingClientRect();
			if (rect.width < 1 || rect.height < 1) {
				return;
			}
			const zoom = getZoomFactor(win);
			const key = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height), zoom].join(',');
			if (key === lastLayoutKey) { return; }   // 矩形没变 ⇒ 不重发（防抖）
			lastLayoutKey = key;
			void this._dsh.layoutView(viewId, {
				windowId,
				x: rect.left,
				y: rect.top + titleBarH,
				width: rect.width,
				height: Math.max(1, rect.height - titleBarH),
				zoomFactor: zoom,
			});
		};
		const layoutSoon = () => { layout(); win.setTimeout(layout, 120); win.setTimeout(layout, 420); };
		// 首帧布局双保险（与聊天宿主同款：容器挂上当帧矩形可能还是 0）。
		layout();
		win.requestAnimationFrame(() => { layout(); win.requestAnimationFrame(layout); });
		const resizeObserver = new win.ResizeObserver(layout);
		resizeObserver.observe(container);
		const layoutSub = auxWindow.onDidLayout(() => layout());
		win.addEventListener('resize', layout);
		win.addEventListener('fullscreenchange', layoutSoon);
		const layoutTimer = win.setInterval(layout, 500);

		/**
		 * 让原生视图**拿到键盘焦点**。
		 *
		 * 2026-10-17 真机「弹窗里输入框无法输入」：自证显示 `opened=true` / `disabled=false` /
		 * roster 716，但**键一直不进页面** —— 鼠标能用（命中测试走窗口层），键盘却留在 aux 窗口的
		 * workbench 渲染层上。`setViewVisible(viewId, true, **focus=true**)` 本来就会
		 * `webContents.focus()`，但**只在创建时调一次**：那一刻 aux 窗口往往还没真正成为前台
		 * （`open()` 刚返回 / 尚未 show），这次 focus 会丢 ✗。
		 * ⇒ 之后的每次"窗口获得焦点 / 页面加载完成 / 布局变化"都**重新聚焦一次**（幂等：
		 *   主进程 `setVisible` 对同值早退，但 focus 仍会执行 ✓）。
		 * ⚠ e2e 用 CDP `Input.insertText` 是**合成输入**，绕过原生焦点 ⇒ 测不出这一类问题；
		 *   页面侧另用 `document.hasFocus()` / `inputDiag.keys` 兜（见 PAGE_SURFACE_REPORT）✓。
		 */
		const focusView = () => {
			void this._dsh.setViewVisible(viewId, true, true).catch(() => undefined);
		};
		await this._dsh.setViewVisible(viewId, true, true);
		// 视图就位后撤掉加载占位（页面首帧由主进程底色候选染色，见 createView）。
		placeholder.remove();
		// 首次聚焦常常落空（窗口还没前台）⇒ 补几次（一次宏任务 + 两个短延时，代价可忽略）
		win.setTimeout(focusView, 0);
		win.setTimeout(focusView, 400);
		win.setTimeout(focusView, 1500);
		win.addEventListener('focus', focusView);
		win.addEventListener('mousedown', focusView);
		// 窗口级焦点进出也记（2026-10-17 第二轮取证：主进程日志里视图在 FOCUS/BLUR 反复，
		// 而页面 keys 恒 0 ⇒ 必须知道**窗口**有没有成为前台）。同时在获得焦点时主动聚焦视图。
		this._log.info(`[dshHarness] full window created (isFocused=${win.document.hasFocus?.() ?? 'n/a'})`);
		win.addEventListener('focus', () => this._log.info('[dshHarness] full window FOCUS ⇒ focus view'));
		win.addEventListener('blur', () => this._log.info('[dshHarness] full window BLUR'));
		// 显式把窗口提到前台（Electron 里 window.focus() 会激活所属 BrowserWindow；
		// 弹窗刚打开时有时停留在后台 ⇒ 键盘进不来、鼠标却能用）。
		try { win.focus(); } catch { /* 某些平台不支持，忽略 */ }

		this._wirePageCommands(viewId, args.chatId);
		this._desktopWindows.set(windowId, { windowId, viewId });

		// 关窗收尾：释放视图（主进程对关闭窗口也有一次回收，这里主动 + 幂等）并断开布局订阅。
		const unloadSub = auxWindow.onUnload(() => {
			resizeObserver.disconnect();
			layoutSub.dispose();
			win.removeEventListener('resize', layout);
			win.removeEventListener('fullscreenchange', layoutSoon);
			win.clearInterval(layoutTimer);
			// ★ 2026-10-29（多开）：关掉一扇 ⇒ 从登记表里摘掉 ✓
			this._desktopWindows.delete(windowId);
			void this._dsh.disposeView(viewId).catch(() => undefined);
		});
		this._register(toDisposable(() => {
			// 贡献释放（窗口重载）而弹窗还活着时：弹窗 DOM 随 renderer 一起没了，视图交主进程回收。
			unloadSub.dispose();
			resizeObserver.disconnect();
			layoutSub.dispose();
		}));

		this._log.info(`[dshHarness] full window opened (view ${viewId}, session ${sessionId ?? '(无，官方默认页)'})`);
		return true;
	}

	/**
	 * 等第一个工作区目录出现（最多 `timeoutMs`，每 150ms 探一次）。
	 *
	 * 为什么要等（2026-10-28）：启动开窗延时缩到 800ms 后，此刻 `workspaceContextService` 里
	 * 可能还没有目录（工作区恢复晚于这个点）⇒ 直接把"还没到"当成"没打开工作区"。
	 */
	private async _waitForWorkspaceCwd(timeoutMs: number): Promise<string | undefined> {
		const read = () => this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		const first = read();
		if (first) {
			return first;
		}
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await new Promise<void>(resolve => setTimeout(resolve, 150));
			const cwd = read();
			if (cwd) {
				this._log.info(`[dshHarness] full window: 工作区在等待中出现（${cwd}）`);
				return cwd;
			}
		}
		return undefined;
	}

	/**
	 * 弹窗自己的会话（**与 IDE 里的聊天互相独立**，2026-10-17 用户要求）。
	 *
	 * 背景变更：此前弹窗「跟随当前聊天会话」（`_resolveFollowSessionId` 三级回退）—— 好处是内容连续，
	 * 但两边是**同一条会话**：任何一边输入，另一边即时同步（用户截图实证），这是他们要的"互不影响"的反面 ✗。
	 *
	 * 现在的语义：
	 *   · 会话 id 由 **本 IDE 窗口** 派生（`dshChatNewSessionId('full-popout', <windowId>)`）⇒ 稳定、可复用；
	 *   · `session.start` 幂等（同 id 接管）⇒ 重开弹窗回到**同一条 desktop 会话**，历史还在；
	 *   · 与聊天视图各自持有不同 sessionId ⇒ **零共享**，互不影响 ✓。
	 *
	 * 取不到工作区目录 ⇒ 返回 undefined，弹窗停在官方默认页（hero），由用户在页内选工作区
	 * （页面侧 0.2.100+ 已能自己把 roster 拉起来，hero 不再是死路 ✓）。
	 */
	private async _ensurePopoutSessionId(
		windowId: number,
		/**
		 * 失败/重试时把原因显示给用户（含第几次重试）；成功时会被清掉。见 `_showStartupBanner`。
		 *
		 * 第三个参数 `level`：`'waiting'` = **正在重试**（还没失败）；`'error'` = 真的失败 ✗。
		 */
		reporter?: (message: string, attempt: number, level?: 'error' | 'waiting') => void,
		/**
		 * 会话 id 的**分栏后缀**（2026-10-29 分屏）：缺省 = 主栏；右栏传 `'R'` ⇒ 会话 id 带 `-R`。
		 *
		 * ⚠ 为什么必须不同：两栏若绑**同一条**会话 ⇒ 两边显示同一条对话、输入互相可见
		 *   （这正是 2026-10-17 桌面窗口与 IDE 聊天"互不影响"那次踩过的坑）⇒ id 必须错开 ✓。
		 */
		suffix?: string
	): Promise<string | undefined> {
		// ★ 2026-10-28：启动开窗延时从 2.5s 缩到 800ms 之后，工作区可能**还没落定** ⇒
		//   这里不能再"取不到就当没有"，而要**等一会儿**（最多 3s）。否则会把"还在加载"误判成
		//   "没打开工作区" ⇒ 弹窗停在 hero + 一条红色失败提示（比慢一点更糟 ✗）。
		const cwd = await this._waitForWorkspaceCwd(3_000);
		if (!cwd) {
			this._log.warn('[dshHarness] full window: no workspace folder ⇒ 停在官方默认页（弹窗内可选工作区）');
			reporter?.('没有打开工作区，无法创建会话 —— 请在 IDE 里打开一个工作区后再开桌面窗口', 1);
			return undefined;
		}
		// ⚠ suffix：分屏右栏要一条**独立**的会话 ⇒ id 必须错开（否则两栏同一条对话 ✗）。
		const target = dshChatNewSessionId('full-popout', suffix ? `${windowId}-${suffix}` : String(windowId));
		// ★ 2026-10-27（用户报「弹窗停在 hero、输入框禁用」）：**失败要重试，也要让用户看见**。
		//   真机：Host ready 后 0.8s 就发起了 `session.start`，报 `vssaros-agents (@vssaros/dsh-agents):
		//   never started`；而 mux 路由要到 ready 之后 **11.4s** 才可用 ⇒ 那是"插件还没挂载完"，
		//   重试就能过。以前一次失败就直接放弃 ⇒ 桌面窗口永远停在 hero、且**页面上没有任何说明**
		//   （用户只看到"窗口开了但不能用"）✗。
		for (let attempt = 1; ; attempt++) {
			try {
				const res = await this._dsh.startSession({ cwd, sessionId: target });
				this._log.info(`[dshHarness] full window uses its own session: ${res.sessionId} (cwd=${cwd})`);
				return res.sessionId;
			} catch (err) {
				const message = String((err as Error)?.message ?? err);
				this._log.warn(`[dshHarness] full window: 独立会话启动失败（第 ${attempt}/${SESSION_START_MAX_ATTEMPTS} 次）：${message}`);
				if (decideSessionStartRetry(message, attempt, SESSION_START_MAX_ATTEMPTS) !== 'retry') {
					this._log.warn('[dshHarness] full window: 判为不可重试 ⇒ 回落官方默认页');
					reporter?.(message, attempt, 'error');
					return undefined;
				}
				// ★ 2026-10-29：这一跳**还没失败**，只是"桥/会话通道还没就绪"（真机：Host ready 后
				//   mux 路由还要几秒 ⇒ 头一两次必然失败，但几十秒后自己就好了）⇒ 提示条按"等待中"显示，
				//   不写"失败"、也不给「重试」按钮（给按钮会让人以为必须手动点 ✗）。
				reporter?.(message, attempt, 'waiting');
				await new Promise<void>(resolve => setTimeout(resolve, sessionStartRetryDelayMs(attempt)));
			}
		}
	}

	/**
	 * 弹窗视图的「换会话」族桥命令：视图是自己的，直接换绑，不经过聊天宿主。
	 * 其余命令不在这里接（聊天宿主同口径：留给全局贡献 / 记 trace，**不许静默** ✗）。
	 */
	private _wirePageCommands(viewId: string, chatId: string | undefined): void {
		this._register(this._dsh.onDidPageEvent(e => {
			if (e.viewId !== viewId || e.kind !== 'command') {
				return;
			}
			if (e.command.method === 'openSession') {
				void this._dsh.rebindSession(viewId, e.command.sessionId)
					.catch(err => this._log.warn(`[dshHarness] full window openSession failed`, err));
			} else if (e.command.method === 'newSession') {
				void this._newSession(viewId, chatId);
			} else {
				this._log.trace(`[dshHarness] full window page command not handled here (expected: page-command contribution): ${e.command.method}`);
			}
		}));
	}

	/** 弹窗内「＋ 新建会话」：派生新 id + startSession + rebind（与聊天宿主 `_doNewSessionInPlace` 同构）。 */
	private async _newSession(viewId: string, chatId: string | undefined): Promise<void> {
		const cwd = this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		if (!cwd) {
			this._log.warn('[dshHarness] full window newSession ignored: no workspace folder');
			return;
		}
		const target = dshChatNewSessionId(chatId ?? `full-${viewId}`, Date.now().toString(36));
		const res = await this._dsh.startSession({ cwd, sessionId: target });
		await this._dsh.rebindSession(viewId, res.sessionId);
	}
}
