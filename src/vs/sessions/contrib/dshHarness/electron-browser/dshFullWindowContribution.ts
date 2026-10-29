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
// ★ 2026-10-29：aux（子）窗口的 JS 上下文**禁止** createElement（真机日志）：
//   "Not allowed to create elements in child window JavaScript context. Always use the main window"
//   ⇒ 凡是往 aux 窗口里插的 DOM 元素，**一律用主窗口的 document 建** ✓（与自绘标题条同一手法）。
import { mainWindow } from '../../../../base/browser/window.js';
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
import { buildArrangedTree, computeSplitLayout, moveSplitLeaf, pickDropZone, removeSplitLeaf, splitLeaves, type DshSplitNode } from '../common/dshSplitLayout.js';
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
 * **抓手带**的高度（px）—— 每栏顶部留出的一条可拖动区域（2026-10-29，拖拽堆叠）。
 *
 * 为什么需要它：原生 `WebContentsView` 画在 **DOM 之上** ⇒ 页面里没有"栏的外壳"可放抓手
 *   （社区 split-workspace 的 pane 是 DOM ⇒ 它们有外壳，我们没有 ✗）。
 * ⇒ 只能让每栏顶部**空出**这一条（原生视图从 `y + GRAB_H` 开始）⇒ 缝隙里露出我们的抓手带 ⇒
 *   鼠标能命中它 ⇒ 可以把这一栏拖到别处 ✓。
 *
 * ⚠ 只在**多栏**时留（单栏没有可拖的对象 ⇒ 平白少 8px 顶部不好）⇒ 见 `layout()` ✓。
 */
const DESKTOP_PANE_GRAB_H = 10;

/**
 * **主栏最小宽度**（2026-10-29 真机两次）：主栏是带官方**三栏**布局的完整客户端
 * （左侧栏 ≈236 + 中栏 + 官方右栏）⇒ 低于这个宽度时 dsh 会把侧栏折成图标条、中栏挤成 0（黑屏）。
 * 420 实测不够（截图里 520 就是黑的）⇒ 取 **720**（侧栏 + 约 480 的中栏）。
 */
const DESKTOP_MAIN_MIN_W = 720;

/** 右栏最少要有多少宽度（低于它就没什么可看的了 ⇒ 分屏前提示用户）✓。 */
const DESKTOP_PANE_MIN_W = 320;

/**
 * 桌面窗口**最多几栏**（2026-10-29）。
 *
 * 为什么定 3：社区的 pane 树不限数量，是因为它们每个 pane 只是**同页里的一段 DOM**；
 * 我们每个 pane 是**一整个 dsh 客户端页面**（各拉一份 roster、各占一组连接与内存）⇒
 * 栏数线性放大成本 ⇒ 封顶 **3**（主栏 + 2 个右栏），再多就把窗口挤得没法用了 ✗。
 */
const MAX_DESKTOP_PANES = 3;

/**
 * 分屏比例的**持久化键**（IDE storage，APPLICATION scope）。
 *
 * ⚠ 只存**比例**、不存栏数：栏绑的是**新会话**，跨重启恢复没有意义（社区能恢复是因为它们
 *   恢复的是**同一批会话**；我们这里的会话每次开窗都是新的 ⇒ 只继承比例即可）✓。
 */
const SPLIT_RATIO_STORAGE_KEY = 'dsh.desktop.split.ratio.v1';

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

	/**
	 * 取（或现建）某栏的**抓手带**（DOM）。
	 *
	 * ⚠ 原生视图盖在 DOM 之上 ⇒ 抓手带必须落在"栏顶部那条 8px 空隙"里（见 `DESKTOP_PANE_GRAB_H`）
	 *   ⇒ 才可见、可点 ✓（与自绘标题条同一手法）。
	 * ⚠ 左键拖 = 把这一栏**拖到别处**；右键 = 兜底菜单（移到最左/最右/关闭）✓（用户选的 A+C）。
	 */
	/**
	 * 用**主窗口**的 document 造一个元素（往 aux 窗口里插的 DOM 元素都走这里）。
	 *
	 * ⚠⚠ 为什么不能用 `container.ownerDocument`（2026-10-29 真机日志踩过）：
	 *   aux 是**子窗口**，它的 JS 上下文**禁止 createElement** ⇒ 直接抛
	 *   `Not allowed to create elements in child window JavaScript context` ⇒
	 *   抓手带 / 分隔条 / 预览框**全都建不出来**（表现为"分屏能开、但拖不动"）✗✗。
	 *   ⇒ 一律用主窗口 document 建（自绘标题条一直这么做，所以它一直能用）✓。
	 */
	private _createInMainWindow(tag: string): HTMLElement | undefined {
		try {
			const doc = mainWindow?.document ?? (typeof document !== 'undefined' ? document : undefined);
			if (!doc) {
				this._log.warn('[dshHarness] DOM: 拿不到 document ⇒ 建不了元素');
				return undefined;
			}
			return doc.createElement(tag);
		} catch (err) {
			this._log.warn('[dshHarness] DOM: 主窗口 createElement 失败：' + String((err as Error)?.message ?? err));
			return undefined;
		}
	}

	private _ensureGrabBar(windowId: number, container: HTMLElement, win: Window, paneId: string): HTMLElement | undefined {
		let bars = this._grabBars.get(windowId);
		if (!bars) {
			bars = new Map();
			this._grabBars.set(windowId, bars);
		}
		const existing = bars.get(paneId);
		if (existing) { return existing; }
		// ⚠ 用**主窗口** document 建（aux 子窗口禁止 createElement ⇒ 见 `_createInMainWindow`）✓
		const el = this._createInMainWindow('div');
		if (!el) { return undefined; }
		try {
			container.appendChild(el);
		} catch (err) {
			this._log.warn('[dshHarness] pane grab: 挂到 aux 容器失败 ⇒ 这一栏不可拖动：' + String((err as Error)?.message ?? err));
			return undefined;
		}
		el.setAttribute('data-vssaros-pane-grab', paneId);
		// ⚠⚠ `pointer-events:auto` **必须显式写**（2026-10-29 真机：aux 容器的 DOM 层默认
		//   `pointer-events:none`（工作台层不可交互）⇒ 不写这句 ⇒ 抓手带**建得出来、看得见，
		//   却收不到 mousedown** ⇒ 表现为"分屏能开、但拖不动"✗✗ ⇒ 自绘标题条一直写着这一句 ✓）。
		//   同时给它一个**常驻浅底**（透明的话用户根本不知道那儿能拖）✓。
		el.style.cssText = 'position:absolute;display:none;height:10px;cursor:grab;z-index:4;pointer-events:auto;'
			+ 'background:var(--vscode-editorWidget-background, rgba(128,128,128,.10));'
			+ 'border-bottom:1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.22));';
		el.title = '拖动这一栏可重排（放到别的栏的左/右/上/下）；右键这一栏有更多操作';
		el.addEventListener('mouseenter', () => { el.style.background = 'var(--vscode-editorHoverWidget-background, rgba(128,128,128,.2))'; });
		el.addEventListener('mouseleave', () => { el.style.background = 'transparent'; });
		el.addEventListener('mousedown', (ev) => { this._beginPaneDrag(windowId, container, win, paneId, ev); });
		el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); this._showPaneMenu(windowId, container, win, paneId, ev); });
		bars.set(paneId, el);
		return el;
	}

	/**
	 * 开始拖动某一栏（鼠标按住抓手带 ⇒ 拖 ⇒ 落到别栏的某一边）。
	 *
	 * 落点判定：指针落在**哪一栏** ⇒ 按中线判方向（左/右/上/下）⇒ 拖动时画预览框 ✓。
	 * 松手 ⇒ `moveSplitLeaf` 重排树 ⇒ 立刻重排原生视图 ✓（几何在 common 里，有单测）。
	 */
	private _beginPaneDrag(windowId: number, container: HTMLElement, win: Window, sourcePaneId: string, _ev: MouseEvent): void {
		const entry = this._desktopWindows.get(windowId);
		if (!entry?.tree) { return; }
		let targetPaneId: string | undefined;
		let zone: 'left' | 'right' | 'top' | 'bottom' | undefined;
		const onMove = (e: MouseEvent) => {
			const rects = this._lastRects.get(windowId);
			if (!rects) { return; }
			targetPaneId = undefined;
			zone = undefined;
			for (const [paneId, r] of rects) {
				if (paneId === sourcePaneId) { continue; }
				const z = pickDropZone(r, e.clientX, e.clientY);
				if (z) { targetPaneId = paneId; zone = z; break; }
			}
			this._showDragPreview(container, rects, targetPaneId, zone);
		};
		const onUp = () => {
			win.removeEventListener('mousemove', onMove);
			win.removeEventListener('mouseup', onUp);
			this._clearDragPreview();
			if (!targetPaneId || !zone || !entry.tree) { return; }
			const moved = moveSplitLeaf(entry.tree, sourcePaneId, targetPaneId, zone);
			if (!moved) {
				this._log.warn('[dshHarness] pane drag: 重排失败（保持原布局）');
				return;
			}
			// ★ "往它已经在的那一侧拖"⇒ 树顺序不变 ⇒ 视觉上"没动"（2026-10-29 用户反馈：
			//   "松手无法移动位置"—— 其实是把右栏往右拖，它本来就在右边）。
			//   ⇒ 这时改成**交换**两栏（把目标往反方向插到被拖栏旁边）⇒ 用户感知"换了位置" ✓
			if (splitLeaves(moved).join('|') === splitLeaves(entry.tree).join('|')) {
				const reverse = zone === 'left' ? 'right' : zone === 'right' ? 'left' : zone === 'top' ? 'bottom' : 'top';
				const swapped = moveSplitLeaf(entry.tree, targetPaneId, sourcePaneId, reverse);
				if (swapped) {
					entry.tree = swapped;
					entry.layout?.();
					this._log.info(`[dshHarness] pane drag: ${sourcePaneId} ⇄ ${targetPaneId}（同侧拖动 ⇒ 交换）`);
					return;
				}
			}
			entry.tree = moved;
			entry.layout?.();
			this._log.info(`[dshHarness] pane drag: ${sourcePaneId} ⇒ ${targetPaneId} 的 ${zone}`);
		};
		win.addEventListener('mousemove', onMove);
		win.addEventListener('mouseup', onUp);
	}

	/** 拖拽预览框（半透明 ⇒ 告诉用户"会落到这儿"）✓。 */
	private _showDragPreview(container: HTMLElement, rects: Map<string, { x: number; y: number; width: number; height: number }>, targetPaneId: string | undefined, zone: 'left' | 'right' | 'top' | 'bottom' | undefined): void {
		this._clearDragPreview();
		if (!targetPaneId || !zone) { return; }
		const r = rects.get(targetPaneId);
		if (!r) { return; }
		const el = this._ensurePreviewEl(container);
		if (!el) { return; }
		const horizontal = zone === 'left' || zone === 'right';
		el.style.display = 'block';
		el.style.left = (zone === 'left' ? r.x : zone === 'right' ? r.x + r.width / 2 : r.x) + 'px';
		el.style.top = (zone === 'top' ? r.y : zone === 'bottom' ? r.y + r.height / 2 : r.y) + 'px';
		el.style.width = (horizontal ? r.width / 2 : r.width) + 'px';
		el.style.height = (horizontal ? r.height : r.height / 2) + 'px';
	}

	private _ensurePreviewEl(container: HTMLElement): HTMLElement | undefined {
		if (this._previewEl) { return this._previewEl; }
		// ⚠ 主窗口 document 建（aux 子窗口禁 createElement ⇒ 见 `_createInMainWindow`）✓
		const el = this._createInMainWindow('div');
		if (!el) { return undefined; }
		// ⚠ `position: fixed` ⇒ 坐标就是窗口坐标（与 `_lastRects` 同一坐标系 ✓）
		el.style.cssText = 'position:fixed;display:none;z-index:9;border:2px solid var(--vscode-focusBorder, #007fd4);background:rgba(0,127,212,.18);pointer-events:none;border-radius:3px;';
		try {
			container.appendChild(el);
		} catch { /* 挂不上就不显示预览（不影响拖拽本身） */ }
		this._previewEl = el;
		return el;
	}

	private _clearDragPreview(): void {
		if (this._previewEl) { this._previewEl.style.display = 'none'; }
	}

	/**
	 * 抓手带**右键菜单**（兜底 C：不能靠拖也要能重排 / 关闭）。
	 *
	 * 三项：移到最左 / 移到最右 / 关闭这一栏；主栏**不可关闭**（关了这扇窗就空了）⇒ 置灰 ✓。
	 */
	private _showPaneMenu(windowId: number, container: HTMLElement, win: Window, paneId: string, ev: MouseEvent): void {
		const entry = this._desktopWindows.get(windowId);
		if (!entry?.tree) { return; }
		const leaves = splitLeaves(entry.tree);
		const first = leaves[0];
		const last = leaves[leaves.length - 1];
		const isMain = paneId === entry.viewId;
		// ⚠ 主窗口 document 建（aux 子窗口禁 createElement ⇒ 见 `_createInMainWindow`）✓
		const menu = this._createInMainWindow('div');
		if (!menu) { return; }
		try {
			container.appendChild(menu);
		} catch { return; }
		menu.style.cssText = `position:fixed;left:${ev.clientX}px;top:${ev.clientY}px;z-index:20;min-width:132px;padding:4px;border-radius:6px;border:1px solid var(--vscode-dropdown-border, rgba(128,128,128,.4));background:var(--vscode-dropdown-background, #252526);color:var(--vscode-dropdown-foreground, #ccc);box-shadow:0 6px 18px rgba(0,0,0,.4);font-size:12px;pointer-events:auto;`;
		const addItem = (label: string, disabled: boolean, action: () => void) => {
			const item = this._createInMainWindow('button');
			if (!item) { return; }
			item.textContent = label;
			item.style.cssText = `display:block;width:100%;text-align:left;padding:5px 8px;border:none;background:transparent;color:inherit;font:inherit;cursor:${disabled ? 'default' : 'pointer'};opacity:${disabled ? '.45' : '1'};`;
			item.addEventListener('click', () => {
				menu.remove();
				if (!disabled) { action(); }
			});
			menu.appendChild(item);
		};
		addItem('移到最左', paneId === first, () => {
			const moved = moveSplitLeaf(entry.tree!, paneId, first, 'left');
			if (moved) { entry.tree = moved; entry.layout?.(); }
		});
		addItem('移到最右', paneId === last, () => {
			const moved = moveSplitLeaf(entry.tree!, paneId, last, 'right');
			if (moved) { entry.tree = moved; entry.layout?.(); }
		});
		addItem('关闭这一栏', isMain, () => { void this._closePane(windowId, paneId); });
		const close = () => { menu.remove(); win.removeEventListener('mousedown', close, true); };
		win.setTimeout(() => win.addEventListener('mousedown', close, true), 0);
	}

	/** 关掉某一栏（视图回收 + 从树里摘掉 + 停巡检 + 重排）✓。 */
	private async _closePane(windowId: number, paneId: string): Promise<void> {
		const entry = this._desktopWindows.get(windowId);
		if (!entry?.tree) { return; }
		if (paneId === entry.viewId) { return; }   // 主栏不关（关了这扇窗就空了）
		const next = removeSplitLeaf(entry.tree, paneId);
		// ⚠ 关掉**最后一个**右栏 ⇒ 树塌缩成 undefined ⇒ 也要 dispose + 重排（主栏铺满），
		//   不许提前 return（否则那一栏视图还在、关不掉 ✗）
		entry.tree = next;
		entry.paneViewIds = (entry.paneViewIds ?? []).filter(id => id !== paneId);
		entry.splitViewId = entry.paneViewIds.length > 1 ? entry.paneViewIds[entry.paneViewIds.length - 1] : undefined;
		void this._dsh.disposeView(paneId).catch(() => undefined);
		const watchers = this._splitWatchers.get(windowId);
		const watcher = watchers?.get(paneId);
		if (watcher && watchers) { clearInterval(watcher.timer); watchers.delete(paneId); }
		this._grabBars.get(windowId)?.delete(paneId);
		entry.layout?.();
		this._log.info(`[dshHarness] pane close: 已关闭 ${paneId}（剩 ${entry.paneViewIds.length} 栏）`);
	}

	private _installSplitBar(windowId: number, container: HTMLElement, win: Window): void {
		const bars: HTMLElement[] = [];
		for (let i = 0; i < MAX_DESKTOP_PANES - 1; i++) {
			const bar = this._createSplitBar(windowId, container, win, i);
			if (!bar) { break; }
			bars.push(bar);
		}
		this._splitBars.set(windowId, bars);
	}

	/** 建一条缝（DOM）；失败返回 undefined（并**如实记日志**）✓。 */
	private _createSplitBar(windowId: number, container: HTMLElement, win: Window, index: number): HTMLElement | undefined {
		// ⚠ 用**主窗口** document 建（aux 子窗口禁止 createElement ⇒ 见 `_createInMainWindow`）✓
		const bar = this._createInMainWindow('div');
		if (!bar) {
			this._log.warn('[dshHarness] split bar: 建不出来 ⇒ 不装分隔条（分屏仍可用，只是不能拖动）');
			return undefined;
		}
		try {
			container.appendChild(bar);
		} catch (err) {
			this._log.warn('[dshHarness] split bar: 挂到 aux 容器失败 ⇒ 不装分隔条（分屏仍可用，只是不能拖动）：' + String((err as Error)?.message ?? err));
			return undefined;
		}
		bar.setAttribute('data-vssaros-splitbar', String(index + 1));
		// ⚠ `pointer-events:auto` 同样**必须显式写**（aux 的 DOM 层默认 pointer-events:none ⇒
		//   不写就收不到 mousedown ⇒ 分隔条拖不动）✓（与自绘标题条同一口径）。
		bar.style.cssText = 'position:absolute;top:0;bottom:0;width:8px;display:none;cursor:col-resize;z-index:3;pointer-events:auto;background:var(--vscode-editorWidget-background, rgba(128,128,128,.10));';

		let dragging = false;
		const onMove = (ev: MouseEvent) => {
			if (!dragging) { return; }
			// ⚠⚠ 分隔条拖动**暂禁**（2026-10-29）：两段式布局落地后它的旧语义（改 `_splitRatio`）
			//   会把主栏拖没（真机截图：主栏塌成一条折叠侧栏 + 黑底）✗。
			//   正确语义 = 按 divider 的 path 改**树里相邻两栏的 sizes**（社区 min 夹取公式），下轮接。
			//   ⇒ 比例先走「⋯」菜单（ratio33/50/67，已持久化 ✓）。
			void index;
			void ev;
		};
		const onUp = () => { dragging = false; };
		bar.addEventListener('mousedown', (ev) => {
			dragging = true;
			ev.preventDefault();
		});
		win.addEventListener('mousemove', onMove);
		win.addEventListener('mouseup', onUp);
		return bar;
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
	private async _paneActionByView(viewId: string, action: DshPaneAction): Promise<boolean> {
		let entry: { windowId: number; viewId: string; splitViewId?: string; paneViewIds?: string[]; tree?: DshSplitNode; layout?: () => void } | undefined;
		for (const e of this._desktopWindows.values()) {
			if (e.viewId === viewId || (e.paneViewIds ?? []).includes(viewId)) { entry = e; break; }
		}
		if (!entry?.tree) {
			this._log.warn('[dshHarness] pane action: 找不到该视图所属的桌面窗口');
			return false;
		}
		if (action === 'close') {
			if (viewId === entry.viewId) { return false; }   // 主栏不关（关了这扇窗就空了）
			await this._closePane(entry.windowId, viewId);
			return true;
		}
		// 比例（分隔条拖不动 ⇒ 走菜单）：两段式布局 ⇒ 比例 = **主栏（左列）占宽**
		//   （菜单文案「左栏 1/3 / 左右各半 / 左栏 2/3」与之一致 ✓）；有右栏在就能调 ✓
		if (action === 'ratio33' || action === 'ratio50' || action === 'ratio67') {
			this._splitRatio = action === 'ratio33' ? 1 / 3 : action === 'ratio50' ? 1 / 2 : 2 / 3;
			this._persistSplitRatio();
			entry.layout?.();
			return true;
		}
		const leaves = splitLeaves(entry.tree);
		if (leaves.length < 2) { return false; }
		// 目标 = 最左/最上 ⇒ 第一个叶子；最右/最下 ⇒ 最后一个叶子 ✓
		const target = action === 'moveLeft' || action === 'moveTop' ? leaves[0] : leaves[leaves.length - 1];
		const zone = action === 'moveLeft' ? 'left' : action === 'moveRight' ? 'right' : action === 'moveTop' ? 'top' : 'bottom';
		const moved = moveSplitLeaf(entry.tree, viewId, target, zone);
		if (!moved) { return false; }
		entry.tree = moved;
		entry.layout?.();
		this._log.info(`[dshHarness] pane action: ${viewId} ⇒ ${action}（目标 ${target}）`);
		return true;
	}

	private async _ensureSplitPane(viewId: string): Promise<boolean> {
		let entry: { windowId: number; viewId: string; splitViewId?: string; paneViewIds?: string[]; tree?: DshSplitNode; layout?: () => void } | undefined;
		for (const e of this._desktopWindows.values()) {
			if (e.viewId === viewId || (e.paneViewIds ?? []).includes(viewId)) { entry = e; break; }
		}
		if (!entry) {
			this._log.warn('[dshHarness] split pane: 找不到该视图所属的桌面窗口 ⇒ 放弃');
			return false;
		}
		// ⚠ **并发重入守卫**（2026-10-29 真机：一次点击打出两条"已分屏"日志、右栏 id 还相同）：
		//   两次调用都在 `await createView` 期间 ⇒ 都看到 panes.length === 1 ⇒ 都去新建 ✗
		//   ⇒ 同一扇窗口 800ms 内只接受一次分屏请求（顺带防手抖双击）✓
		const now = Date.now();
		if (now - (this._splitStartedAt.get(entry.windowId) ?? 0) < 800) {
			this._log.info('[dshHarness] split pane: 800ms 内的重复请求 ⇒ 忽略（防止并发建出两栏）');
			return false;
		}
		this._splitStartedAt.set(entry.windowId, now);
		const panes = entry.paneViewIds ?? [entry.viewId];
		// ① 已有右栏 ⇒ 换绑**最后一栏**到一条新会话（用户连续点 = 连续开新对话，而不是叠一堆视图）✓
		if (panes.length > 1) {
			const last = panes[panes.length - 1];
			if (panes.length >= MAX_DESKTOP_PANES) {
				this._notifications.warn(`dsh 桌面窗口：最多 ${MAX_DESKTOP_PANES} 栏（每个窗格是一整个客户端页面，再多会互相拖慢）。这一栏已换成新会话。`);
			}
			const fresh = await this._ensurePopoutSessionId(entry.windowId, undefined, `R${Date.now().toString(36)}`);
			if (!fresh) {
				this._log.warn('[dshHarness] split pane: 新会话没起来 ⇒ 该栏保持原样');
				return false;
			}
			await this._dsh.rebindSession(last, fresh)
				.catch(err => this._log.warn('[dshHarness] split pane: 换绑新会话失败', err));
			return true;
		}
		// ② 还没有右栏 ⇒ 建一个（chat-only：只要对话区）
		const sessionId = await this._ensurePopoutSessionId(entry.windowId, undefined, 'R');
		if (!sessionId) {
			this._log.warn('[dshHarness] split pane: 新会话没起来 ⇒ 不加分栏');
			return false;
		}
		const splitViewId = `dsh-desk-split-w${entry.windowId}-${Date.now().toString(36)}`;
		// 第 7 参 `overrideChatOnlyUi = true` ⇒ 右栏**只要对话区**（官方侧栏/右栏被裁掉 ⇒ 不重复侧栏）；
		// 末参 `isolatedPool = true` ⇒ 右栏独占一个网络分区（不与左栏抢那 6 条连接）✓
		await this._dsh.createView(splitViewId, entry.windowId, 'chat', sessionId, undefined, undefined, true, true);
		entry.splitViewId = splitViewId;
		entry.paneViewIds = [...panes, splitViewId];
		// ★ 2026-10-29（布局树 + 自动分格）：先追到最右，再按 **settleAuto** 重排成网格
		//   （复刻 split-workspace：2=左右、3=L 形、4=2×2、≥5 网格；**主栏恒在第一位** ✓）
		const newLeaf: DshSplitNode = { type: 'leaf', viewId: splitViewId };
		const tree = entry.tree;
		if (!tree) {
			entry.tree = newLeaf;
		} else if (tree.type === 'split') {
			entry.tree = { ...tree, sizes: [...tree.sizes.map(() => 1), 1], children: [...tree.children, newLeaf] };
		} else {
			entry.tree = { type: 'split', dir: 'h', sizes: [1, 1], children: [tree, newLeaf] };
		}
		entry.tree = buildArrangedTree(splitLeaves(entry.tree));
		entry.layout?.();          // 重排成两栏（分隔条也在这时露出来）✓
		await this._dsh.setViewVisible(splitViewId, true, true).catch(() => undefined);
		// 启动存活巡检（20s 一次）⇒ 右栏崩了/被回收了 ⇒ 收掉它（见 `_checkSplitPane`）✓
		this._startSplitWatcher(entry.windowId, splitViewId);
		this._log.info(`[dshHarness] split pane: 窗口 ${entry.windowId} 已分屏（右栏 ${splitViewId} / 会话 ${sessionId}）`);
		return true;
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
			this._dropSplitPane(windowId, '右栏视图已被回收');
			return;
		}
		const alive = await this._dsh.waitViewSelector(splitViewId, '[data-composer-card]', 200).catch(() => false);
		if (alive) {
			watcher.sawComposer = true;
			watcher.misses = 0;
			return;
		}
		if (!watcher.sawComposer) { return; }   // 还没出现过 composer ⇒ 可能仍在加载
		watcher.misses++;
		if (watcher.misses >= 3) {
			this._dropSplitPane(windowId, `右栏连续 ${watcher.misses} 次无响应`);
		}
	}

	/**
	 * 收掉**最后一栏**（自愈用）：dispose 视图 + 清登记 + 清巡检 + 重排 ✓。
	 *
	 * ⚠ 用户视角 = 那一栏消失（还有别的栏就留在那儿，没有就回到单栏）⇒ **可见的**自愈。
	 */
	private _dropSplitPane(windowId: number, reason: string): void {
		const entry = this._desktopWindows.get(windowId);
		if (!entry) { return; }
		const panes = entry.paneViewIds ?? [entry.viewId];
		if (panes.length <= 1) { return; }          // 只有主栏 ⇒ 没有可收的
		const dropId = panes[panes.length - 1];
		// 清巡检（这一栏的定时器）
		const watchers = this._splitWatchers.get(windowId);
		const watcher = watchers?.get(dropId);
		if (watcher && watchers) {
			clearInterval(watcher.timer);
			watchers.delete(dropId);
		}
		// 摘登记（`splitViewId` 始终指"最后一栏"）✓
		entry.paneViewIds = panes.slice(0, -1);
		entry.splitViewId = entry.paneViewIds.length > 1 ? entry.paneViewIds[entry.paneViewIds.length - 1] : undefined;
		void this._dsh.disposeView(dropId).catch(() => undefined);
		// ★ settleAuto：关栏后自动回网格（split-workspace 同纪律：只在 add/close 时重排）✓
		if (entry.tree) { entry.tree = buildArrangedTree(splitLeaves(entry.tree)); }
		entry.layout?.();     // 重排（分隔条随之隐藏/补位）✓
		this._log.warn(`[dshHarness] split pane: ${reason} ⇒ 已收掉那一栏（剩 ${entry.paneViewIds.length} 栏）`);
		// ★ 2026-10-29：弹一条通知 ⇒ 用户知道右栏去哪了（否则只是"凭空消失"✗）。
		this._notifications.warn(`dsh 桌面窗口：有一栏异常已收掉（${reason}）。若要再来一栏，点会话头右侧的「新窗格」。`);
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
	private readonly _desktopWindows = new Map<number, { windowId: number; viewId: string; sideViewId?: string; splitViewId?: string; paneViewIds?: string[]; tree?: DshSplitNode; layout?: () => void }>();

	/**
	 * **左右分屏**时右栏占的宽度比例（0.2 ~ 0.8，0.5 = 各半）。
	 *
	 * 用户拖动中间的分隔条时改它（`_installSplitBar`）⇒ 立即重排两个原生视图 ✓。
	 */
	/**
	 * **左右分屏**时右栏占的宽度比例（0.2 ~ 0.8，0.5 = 各半）。
	 *
	 * 用户拖动中间的分隔条时改它（`_installSplitBar`）⇒ 立即重排两个原生视图 ✓。
	 *
	 * ★ 2026-10-29（3 栏 + 持久化）：**两栏**时用它；**三栏及以上一律等分**
	 *   （多缝拖动会把比例算成一团乱麻 ⇒ 只在两栏时开放拖动）✓。
	 *   比例**持久化在 IDE storage**（键 `dsh.desktop.split.ratio.v1`）⇒ 下次开窗沿用 ✓
	 *   （⚠ 只存比例、不存栏数：栏绑的是**新会话**，跨重启恢复没有意义 —— 社区能恢复是因为它们
	 *   恢复的是**同一批会话**，我们这里的会话每次开窗都是新的 ⇒ 只继承比例即可 ✓）。
	 */
	private _splitRatio = 0.5;

	/**
	 * 各扇桌面窗口的**分隔条**元素（键 = windowId）。
	 *
	 * ⚠ 分隔条是 **DOM**，而原生视图盖在 DOM 之上 ⇒ 只有落在两栏之间的缝隙里才看得见
	 *   （位置由 `layout()` 写，宽度 = `DESKTOP_SPLIT_GAP`）✓。
	 */
	private readonly _splitBars = new Map<number, HTMLElement[]>();

	/**
	 * 右栏的**存活巡检**状态（键 = windowId）。
	 *
	 * 为什么要巡检：主进程的 page-alive 看门狗对 `surface='chat'` 视图会自动重载最多 2 次，
	 * 但**超限后只打日志、不回收视图** ⇒ 右栏会留一块白屏，而渲染侧还记着它
	 * ⇒ 表现为"右栏空着、也不报错"✗ ⇒ 这里兜底：右栏没了 / 长期无响应 ⇒ 收掉它、回到单栏 ✓。
	 */
	private readonly _splitWatchers = new Map<number, Map<string, { timer: ReturnType<typeof setInterval>; sawComposer: boolean; misses: number }>>();

	/**
	 * 每栏的**抓手带**（DOM；键 = windowId → paneId）。
	 *
	 * ⚠ 原生视图盖在 DOM 之上 ⇒ 抓手带必须落在"栏顶部那 8px 空隙"里才可见、可点 ✓。
	 */
	private readonly _grabBars = new Map<number, Map<string, HTMLElement>>();

	/** 最近一次布局算出的每栏矩形（拖拽时判定"落在哪栏、哪个方向"用）✓。 */
	private readonly _lastRects = new Map<number, Map<string, { x: number; y: number; width: number; height: number }>>();

	/** 拖拽过程中的**预览框**（DOM；一次只有一个）✓。 */
	private _previewEl: HTMLElement | undefined;

	/**
	 * 每扇窗口**上一次发起分屏**的时间（键 = windowId）。
	 *
	 * ⚠ 防并发重入（2026-10-29 真机：一次点击打出两条"已分屏"日志、右栏 id 还相同）：
	 *   两次调用都在 `await createView` 期间 ⇒ 都看到"还没有右栏"⇒ 都去新建 ✗。
	 */
	private readonly _splitStartedAt = new Map<number, number>();

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
		const layout = () => {
			const rect = container.getBoundingClientRect();
			if (rect.width < 1 || rect.height < 1) { return; }
			const zoom = getZoomFactor(win);
			const entry = this._desktopWindows.get(windowId);
			// ★ 2026-10-29（两段式布局，修"侧栏被隔断"）：**主栏 = 全高左列**（它的官方侧栏/页签条
			//   是它页面的一部分 ⇒ 上下分屏时若主栏只占上半，侧栏就被切到上方 ✗ —— 用户截图实证）。
			//   ⇒ 改成 VS Code 式：主栏固定全高左列（宽 = `_splitRatio`），**右栏们的树只占右侧内容区**，
			//   在内容区内自由左右/上下分格 ✓（树里从此只有右栏 ⇒ 主栏天然不可被移动/关闭 ✓）。
			const content: DshSplitNode | undefined = entry?.tree;
			const contentLeaves = content ? splitLeaves(content) : [];
			const key = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height), zoom, contentLeaves.join('|'), JSON.stringify(content ?? null), this._splitRatio].join(',');
			if (key === lastLayoutKey) { return; }   // 矩形没变 ⇒ 不重发（防抖）
			lastLayoutKey = key;
			// 让出自绘标题条的高度（原生视图盖在 DOM 上，不留位就把它遮住 ✗）
			const area = { x: rect.left, y: rect.top + titleBarH, width: rect.width, height: Math.max(1, rect.height - titleBarH) };
			const bars = this._splitBars.get(windowId) ?? [];
			const grabs = this._grabBars.get(windowId) ?? new Map<string, HTMLElement>();
			// 主栏：全高左列
			// ⚠ **最小宽度 720px**（2026-10-29 两张真机截图实证，420 不够）：主栏是**带官方三栏布局**
			//   的完整客户端（左侧栏 236 + 中栏 + 官方右栏）⇒ 压到 520 时侧栏折叠成图标条、中栏被挤成 0
			//   （整块黑）✗ ⇒ 下限按"侧栏 + 可用的中栏"给到 **720**；上限 75% ⇒ 右栏至少有 1/4 ✓。
			const mainW = contentLeaves.length > 0
				? Math.max(DESKTOP_MAIN_MIN_W, Math.min(Math.round(area.width * 0.75), Math.round(area.width * this._splitRatio)))
				: Math.round(area.width);
			// ⚠ 窗口本身不够宽时**不要硬分**：主栏 720 + 右栏最少 320 ⇒ 需要 ≥1048 才排得开。
			//   排不开就**明确告诉用户**（而不是让 dsh 挤成黑屏 ✗）。
			if (contentLeaves.length > 0 && area.width < DESKTOP_MAIN_MIN_W + DESKTOP_PANE_MIN_W) {
				this._log.warn(`[dshHarness] split pane: 窗口只有 ${Math.round(area.width)}px 宽 < ${DESKTOP_MAIN_MIN_W + DESKTOP_PANE_MIN_W}px ⇒ 主栏会被挤坏（请拉宽窗口，或用「⋯」把左栏调到 2/3）`);
			}
			void this._dsh.layoutView(chatViewId, {
				windowId, x: area.x, y: area.y, width: mainW, height: area.height, zoomFactor: zoom,
			});
			// ★ 自检（2026-10-29，真机"主栏只剩左侧一条 + 其余黑"）：把**每一栏的 bounds 与 zoom 落日志**。
			//   现场需要区分三种可能：① 视图宽度被算小；② zoom 被放大（页面内容 > 视图 ⇒ 只看到左上角）；
			//   ③ 页面自己渲染异常。只看截图分不出，日志能 ✓（每次布局变化打一次，不刷屏）。
			this._log.info(`[dshHarness] layout: win=${Math.round(area.width)}x${Math.round(area.height)} zoom=${zoom} panes=${1 + contentLeaves.length} main=x${Math.round(area.x)} w${mainW} h${Math.round(area.height)} content=${contentLeaves.length ? `x${Math.round(area.x + mainW + DESKTOP_SPLIT_GAP)} w${Math.max(1, Math.round(area.width - mainW - DESKTOP_SPLIT_GAP))}` : '(none)'}`);
			const hideAll = () => {
				for (const bar of bars) { bar.style.display = 'none'; }
				for (const grab of grabs.values()) { grab.style.display = 'none'; }
			};
			if (contentLeaves.length === 0) {
				// 只有主栏 ⇒ 铺满，隐藏分隔条/抓手
				this._lastRects.delete(windowId);
				hideAll();
				return;
			}
			{
				// 右栏们的树（右侧内容区内自由分格；每栏顶部留抓手带 + 右侧留 gap）
				const contentArea = { x: area.x + mainW + DESKTOP_SPLIT_GAP, y: area.y, width: Math.max(1, area.width - mainW - DESKTOP_SPLIT_GAP), height: area.height };
				const { rects, dividers } = computeSplitLayout(content!, contentArea);
				this._lastRects.set(windowId, new Map(rects));
				contentLeaves.forEach((paneId, i) => {
					const r = rects.get(paneId);
					if (!r) { return; }
					const isLast = i === contentLeaves.length - 1;
					const width = Math.max(1, r.width - (isLast ? 0 : DESKTOP_SPLIT_GAP));
					void this._dsh.layoutView(paneId, {
						windowId, x: r.x, y: r.y + DESKTOP_PANE_GRAB_H,
						width, height: Math.max(1, r.height - DESKTOP_PANE_GRAB_H), zoomFactor: zoom,
					});
					// 抓手带：没有就现建（栏数会变 ⇒ 按需创建）✓
					const grab = this._ensureGrabBar(windowId, container, win, paneId) ?? grabs.get(paneId);
					if (grab) {
						grab.style.display = 'block';
						grab.style.left = (r.x - rect.left) + 'px';
						grab.style.top = (r.y - rect.top) + 'px';
						grab.style.width = width + 'px';
					}
				});
				dividers.forEach((d, idx) => {
					const bar = bars[idx];
					if (!bar) { return; }
					bar.style.display = 'block';
					if (d.dir === 'h') {
						bar.style.left = (d.pos - rect.left - DESKTOP_SPLIT_GAP / 2 - 4) + 'px';
						bar.style.top = (contentArea.y - rect.top) + 'px';
						bar.style.width = '8px';
						bar.style.height = contentArea.height + 'px';
					} else {
						bar.style.left = (contentArea.x - rect.left) + 'px';
						bar.style.top = (d.pos - rect.top - DESKTOP_SPLIT_GAP / 2 - 4) + 'px';
						bar.style.width = contentArea.width + 'px';
						bar.style.height = '8px';
					}
				});
				for (let k = dividers.length; k < bars.length; k++) { bars[k].style.display = 'none'; }
				return;
			}
		};
		const layoutSoon = () => { layout(); win.setTimeout(layout, 120); win.setTimeout(layout, 420); };
		// ★ 2026-10-29（分屏）：中间那条可拖动的分隔条（平时隐藏，有右栏才出现）✓
		this._installSplitBar(windowId, container, win);
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
			//   ⚠ **先取所有栏 id 再摘**（摘了就取不到了）—— 每一栏都要回收，
			//   否则成孤儿视图、它那条会话还在后台跑 ✗。
			const panes = this._desktopWindows.get(windowId)?.paneViewIds ?? [chatViewId];
			this._desktopWindows.delete(windowId);
			for (const paneId of panes) {
				void this._dsh.disposeView(paneId).catch(() => undefined);
			}
			this._splitBars.delete(windowId);
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
		this._desktopWindows.set(windowId, { windowId, viewId: chatViewId, paneViewIds: [chatViewId], layout });
		this._log.info(`[dshHarness] composed desktop opened (window ${windowId}, chat ${chatViewId}, session ${sessionId ?? '(无)'})`);
		return true;
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
