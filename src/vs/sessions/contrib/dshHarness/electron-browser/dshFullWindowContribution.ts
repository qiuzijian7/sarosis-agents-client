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
import { FocusMode, INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IAuxiliaryWindowService } from '../../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { setDshFullWindowOpener } from '../../../common/dshFullWindow.js';
import { dshChatNewSessionId } from '../common/dshChatSession.js';
import { DshHarnessSettings } from '../common/dshHarness.js';
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
	) {
		super();
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
	private async _quit(reason: string): Promise<void> {
		this._log.info(`[dshHarness] ${reason} ⇒ 退出应用（桌面模式下不再把 IDE 主窗口露出来）`);
		try {
			await this._nativeHostService.quit();
		} catch (err) {
			this._log.warn(`[dshHarness] quit failed（${reason}）`, err);
		}
	}

	/** 已开着的全窗（单例复用；关闭时清掉）。`sideViewId` = 拼装式的左侧会话列表视图。 */
	private _openWindow: { windowId: number; viewId: string; sideViewId?: string } | undefined;

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
			bar.textContent = title;
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
		onRetry: () => void
	): void {
		const banner = append(container, $('.vssaros-desk-banner'));
		banner.style.cssText = [
			'position:absolute', 'left:0', 'right:132px', `top:${titleBarH}px`,
			'box-sizing:border-box', 'display:flex', 'align-items:center', 'gap:10px',
			'padding:6px 10px', 'font-size:12px', 'line-height:1.4',
			'z-index:3', 'pointer-events:auto', 'user-select:text',
			'background:var(--vscode-inputValidation-warningBackground, #5a3a00)',
			'color:var(--vscode-inputValidation-warningForeground, #ffffff)',
			'border-bottom:1px solid var(--vscode-inputValidation-warningBorder, #b89500)',
		].join(';');
		const text = append(banner, $('span'));
		text.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;';
		text.textContent = `会话启动失败（第 ${attempt}/${SESSION_START_MAX_ATTEMPTS} 次）：${message}`;
		const retry = append(banner, $('button.vssaros-desk-banner-retry'));
		retry.style.cssText = [
			'flex:none', 'padding:3px 10px', 'font-size:12px', 'cursor:pointer',
			'background:var(--vscode-button-background, #0e639c)',
			'color:var(--vscode-button-foreground, #ffffff)',
			'border:1px solid var(--vscode-button-border, transparent)', 'border-radius:2px',
		].join(';');
		retry.textContent = '重试';
		retry.addEventListener('click', () => onRetry());
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
	private async _openComposed(auxWindow: Awaited<ReturnType<IAuxiliaryWindowService['open']>>, windowId: number, sessionId: string | undefined, booting?: HTMLElement, titleBarH = 0): Promise<boolean> {
		const win = auxWindow.window;
		const container = auxWindow.container;
		container.style.background = 'var(--vscode-editor-background)';
		win.document.title = 'VsSaros — Desktop';

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
		// 原生视图已建好、马上盖上来 ⇒ 撤掉"正在启动"占位（留着也被盖住，但缩窗瞬间会露边 ✗）
		booting?.remove();

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
			const key = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height), zoom].join(',');
			if (key === lastLayoutKey) { return; }   // 矩形没变 ⇒ 不重发（防抖）
			lastLayoutKey = key;
			// 让出自绘标题条的高度（原生视图盖在 DOM 上，不留位就把它遮住 ✗）
			void this._dsh.layoutView(chatViewId, {
				windowId, x: rect.left, y: rect.top + titleBarH,
				width: rect.width, height: Math.max(1, rect.height - titleBarH), zoomFactor: zoom,
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

		await this._dsh.setViewVisible(chatViewId, true, true);

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
			if (this._openWindow?.viewId === chatViewId) { this._openWindow = undefined; }
			void this._dsh.disposeView(chatViewId).catch(() => undefined);
			// ★★ 2026-10-24（修「F5 起来后 app 自己没了」）：
			//   `onUnload` 是 **DOM 的 unload 事件**，页面**导航/重载同样会触发** —— 本机实测：
			//   桌面窗口从 about:blank 跳到真实页面时就会触发一次，于是这条分支把刚启动的 app
			//   直接退掉了（main.log 里那一刻**没有任何窗口关闭事件**，只有 `quit() requested`，
			//   退出码 0 ⇒ 完全不像崩溃，最容易被误判成"F5 没反应/没起来"）。
			//   ⇒ 延后判定：窗口真的没了（`closed`）才退；还活着说明只是导航 ✓
			setTimeout(() => {
				// ① 已经有（另一扇）桌面窗口在屏 ⇒ 这次 unload 只是"换窗"：启动壳被拼装好的
				//    桌面窗口取代时，旧窗会走一次 unload（真机：window 2 → window 3）✗ 不能退。
				if (this._openWindow) {
					this._log.info(`[dshHarness] 桌面窗口 ${windowId} 的 unload 后已有窗口 ${this._openWindow.windowId} 在屏 ⇒ 只是换窗，不退出应用`);
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

		this._openWindow = { windowId, viewId: chatViewId };
		this._log.info(`[dshHarness] composed desktop opened (window ${windowId}, chat ${chatViewId}, session ${sessionId ?? '(无)'})`);
		return true;
	}

	/**
	 * @param onShellOpened 桌面窗口**壳**一出现就回调（此刻 Host 可能还在冷启动）——启动流程用它藏 IDE。
	 *   复用已开窗口时不回调（调用方按返回值兜底）。
	 */
	private async _open(args: { chatId?: string }, onShellOpened?: () => void): Promise<boolean> {
		// ★ 2026-10-17（用户报「点 agent 条目弹出一叠透明窗口」）：定位触发源 —— 记**调用栈**。
		//   popoutChat 正常只在标题栏按钮被点时才走到这里；如果日志里出现而用户没点按钮，
		//   栈里就是真凶（桥命令 / 其他贡献误调）。
		this._log.info(`[dshHarness] full window open REQUEST (chatId=${args.chatId ?? '(无)'})\n${new Error('caller trace').stack ?? '(no stack)'}`);
		// ★ 同日：单例复用 —— 已开着的全窗 ⇒ 聚焦 + 换绑到目标会话，**不再新开**（与 agents 窗口同病同治：
		//   此前每触发一次新开一个，叠成一屏）。
		if (this._openWindow) {
			try {
				const { viewId } = this._openWindow;
				// ★ 2026-10-17（用户要求「desktop 与 IDE 里的 dsh 会话互不影响」）：**不再换绑**。
				//   从前每次点弹出都会跟随当前聊天会话 ⇒ 两边显示同一条会话、输入互相可见（用户截图实证）。
				//   现在弹窗有自己的会话（见 _ensurePopoutSessionId），复用只做聚焦 ✓。
				// focus=true 同时把键盘焦点交给原生视图（见 _open 里 focusView 的说明）
				await this._dsh.setViewVisible(viewId, true, true);
				this._log.info(`[dshHarness] full window already open (view ${viewId}) ⇒ 聚焦复用，不再新开`);
				return true;
			} catch {
				this._openWindow = undefined;   // 窗口已被关/视图已没 ⇒ 落回新建
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
		win.document.title = 'VsSaros — Desktop';
		auxWindow.container.style.background = 'var(--vscode-editor-background)';
		// 自绘标题条（颜色取当前主题 ⇒ 与页面一致；拖拽也由它承担）
		const titleBarH = this._installTitleBar(auxWindow, 'VsSaros — Desktop');
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
			// 第 2 阶段：后台服务就绪 ⇒ 换文案（剩下的是建视图 + 页面首帧）
			booting.textContent = '后台服务已就绪，正在加载界面…';
		} catch (err) {
			booting.textContent = `VsSaros 后台服务启动失败：${String((err as Error)?.message ?? err)}`;
			bootUnload.dispose();
			throw err;
		}
		if (closedWhileBooting) {
			bootUnload.dispose();
			this._log.info('[dshHarness] desktop window closed while the Host was starting ⇒ 不再继续建视图');
			return false;
		}
		// 会话解析放在窗口之后：独立会话 id 依赖 windowId（见 _ensurePopoutSessionId）
		// ★ 2026-10-27：失败时**在窗口里显示原因 + 重试按钮**（否则用户只看到 hero + 禁用输入框，
		//   而答案只在日志里 ✗）；重试 = 重新跑一遍这整段（含再建视图）。
		const sessionId = await this._ensurePopoutSessionId(windowId, (message, attempt) => {
			this._showStartupBanner(auxWindow.container, titleBarH, message, attempt, () => {
				this._clearStartupBanner();
				void this._open(args).catch(err => this._log.warn('[dshHarness] desktop: 会话重试失败', err));
			});
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
				return await this._openComposed(auxWindow, windowId, sessionId, booting, titleBarH);
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
		this._openWindow = { windowId, viewId };

		// 关窗收尾：释放视图（主进程对关闭窗口也有一次回收，这里主动 + 幂等）并断开布局订阅。
		const unloadSub = auxWindow.onUnload(() => {
			resizeObserver.disconnect();
			layoutSub.dispose();
			win.removeEventListener('resize', layout);
			win.removeEventListener('fullscreenchange', layoutSoon);
			win.clearInterval(layoutTimer);
			if (this._openWindow?.viewId === viewId) {
				this._openWindow = undefined;
			}
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
		/** 失败时把原因显示给用户（含第几次重试）；成功时会被清掉。见 `_showStartupBanner`。 */
		reporter?: (message: string, attempt: number) => void
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
		const target = dshChatNewSessionId('full-popout', String(windowId));
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
					reporter?.(message, attempt);
					return undefined;
				}
				reporter?.(message, attempt);
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
