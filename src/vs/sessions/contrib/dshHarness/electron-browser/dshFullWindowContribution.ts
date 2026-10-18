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
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IAuxiliaryWindowService } from '../../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { setDshFullWindowOpener } from '../../../common/dshFullWindow.js';
import { dshChatNewSessionId } from '../common/dshChatSession.js';
import { DshHarnessSettings } from '../common/dshHarness.js';
import { IDshHarnessService } from './dshHarnessService.js';

export class DshFullWindowContribution extends Disposable {
	static readonly ID = 'sessions.dshHarness.fullWindow';

	constructor(
		@IDshHarnessService private readonly _dsh: IDshHarnessService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IAuxiliaryWindowService private readonly _auxWindowService: IAuxiliaryWindowService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		// 与聊天宿主同一门槛：总开关关闭或 engine=legacy 时不接管，popout 走旧实现。
		const enabled = this._configurationService.getValue<boolean>(DshHarnessSettings.Enabled) !== false;
		const engine = this._configurationService.getValue<string>(DshHarnessSettings.ChatEngine);
		if (!enabled || engine !== 'dsh') {
			return;
		}
		setDshFullWindowOpener(args => this._open(args));
		this._register(toDisposable(() => setDshFullWindowOpener(undefined)));
	}

	/** 已开着的全窗（单例复用；关闭时清掉）。`sideViewId` = 拼装式的左侧会话列表视图。 */
	private _openWindow: { windowId: number; viewId: string; sideViewId?: string } | undefined;

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
	private async _openComposed(auxWindow: Awaited<ReturnType<IAuxiliaryWindowService['open']>>, windowId: number, sessionId: string | undefined): Promise<boolean> {
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

		const layout = () => {
			const rect = container.getBoundingClientRect();
			if (rect.width < 1 || rect.height < 1) { return; }
			void this._dsh.layoutView(chatViewId, { windowId, x: rect.left, y: rect.top, width: rect.width, height: rect.height, zoomFactor: getZoomFactor(win) });
		};
		layout();
		win.requestAnimationFrame(() => { layout(); win.requestAnimationFrame(layout); });
		const resizeObserver = new win.ResizeObserver(layout);
		resizeObserver.observe(container);
		const layoutSub = auxWindow.onDidLayout(() => layout());

		await this._dsh.setViewVisible(chatViewId, true, true);

		const focusChat = () => { void this._dsh.setViewVisible(chatViewId, true, true).catch(() => undefined); };
		win.setTimeout(focusChat, 0);
		win.setTimeout(focusChat, 400);
		win.addEventListener('focus', focusChat);

		const unloadSub = auxWindow.onUnload(() => {
			resizeObserver.disconnect();
			layoutSub.dispose();
			if (this._openWindow?.viewId === chatViewId) { this._openWindow = undefined; }
			void this._dsh.disposeView(chatViewId).catch(() => undefined);
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

	private async _open(args: { chatId?: string }): Promise<boolean> {
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
		await this._dsh.ensureStarted();

		const auxWindow = await this._auxWindowService.open({
			// 官方客户端自带顶栏 ⇒ 窗口用原生标题栏（拖动 / 最小化 / 关闭都有了，不用自绘）。
			nativeTitlebar: true,
			bounds: { width: 1280, height: 840 },
		});
		const win = auxWindow.window;
		const windowId = win.vscodeWindowId;
		// 会话解析放在窗口之后：独立会话 id 依赖 windowId（见 _ensurePopoutSessionId）
		const sessionId = await this._ensurePopoutSessionId(windowId);
		// ★ 2026-10-18（默认形态）：**拼装式 desktop** —— 左=会话列表页、右=dsh 聊天（surface=chat）。
		//   为什么不用上游 `createAuxiliaryEditorPart`：它经渲染进程 `window.open` 建窗，在这个构建里
		//   建出来的窗口 URL 永远是 `about:blank`（真机实测：窗口存在但从不加载 → 白窗），而本贡献用的
		//   `IAuxiliaryWindowService.open()` 是**已验证可用**的那条路 ✓。
		//   聊天用 `surface=chat`（长期稳定）；不加载会整页卡死的官方 full 页 ✓。
		const popoutStyle = this._configurationService.getValue<string>(DshHarnessSettings.PopoutStyle) ?? 'composed';
		if (popoutStyle === 'composed') {
			return await this._openComposed(auxWindow, windowId, sessionId);
		}
		const container = auxWindow.container;
		container.style.background = 'var(--vscode-editor-background)';
		win.document.title = 'VsSaros — DeepSeek Harness';

		// 加载提示占位（原生视图盖上来之前别让用户对着一块纯色猜）。
		// ⚠ 元素必须用**主窗口** document 创建（aux 窗口的 createElement 被禁，见分层约定）。
		const placeholder = append(container, $('.dsh-full-window-placeholder'));
		placeholder.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--vscode-descriptionForeground);font-size:13px;';
		placeholder.textContent = '正在加载 dsh 客户端…';

		const viewId = `dsh-full-w${windowId}-${Date.now().toString(36)}`;
		await this._dsh.createView(viewId, windowId, 'full', sessionId);

		const layout = () => {
			const rect = container.getBoundingClientRect();
			if (rect.width < 1 || rect.height < 1) {
				return;
			}
			void this._dsh.layoutView(viewId, {
				windowId,
				x: rect.left,
				y: rect.top,
				width: rect.width,
				height: rect.height,
				zoomFactor: getZoomFactor(win),
			});
		};
		// 首帧布局双保险（与聊天宿主同款：容器挂上当帧矩形可能还是 0）。
		layout();
		win.requestAnimationFrame(() => { layout(); win.requestAnimationFrame(layout); });
		const resizeObserver = new win.ResizeObserver(layout);
		resizeObserver.observe(container);
		const layoutSub = auxWindow.onDidLayout(() => layout());

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
	private async _ensurePopoutSessionId(windowId: number): Promise<string | undefined> {
		const cwd = this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		if (!cwd) {
			this._log.warn('[dshHarness] full window: no workspace folder ⇒ 停在官方默认页（弹窗内可选工作区）');
			return undefined;
		}
		const target = dshChatNewSessionId('full-popout', String(windowId));
		try {
			const res = await this._dsh.startSession({ cwd, sessionId: target });
			this._log.info(`[dshHarness] full window uses its own session: ${res.sessionId} (cwd=${cwd})`);
			return res.sessionId;
		} catch (err) {
			this._log.warn('[dshHarness] full window: 独立会话启动失败 ⇒ 回落官方默认页', err);
			return undefined;
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
