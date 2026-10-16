/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 聊天框 instance 的 dsh 承载（方案 5.12 第 2 步）：engine=dsh 时，`NativeChatEditorPane`
 * 的内容区（agentPart 聊天区）承载一个 `surface=chat` 的 WebContentsView ——
 * dsh 的聊天 UI 出现在聊天框里，而不是文件编辑器区。
 *
 * 通过 `setDshChatHostFactory` 注入到 browser 层的 pane（pane 只认接口，不依赖本模块）。
 * 视图 id 按 chatId 稳定（`dsh-chat-<chatId>`）：切标签 / 重开同一聊天复用同一视图，不重载页面。
 * 会话绑定（chatId → dsh 会话，经控制桥 session.start）与 chat-surface 换皮是 P2 的内容。
 */

import { $, append, getWindow } from '../../../../base/browser/dom.js';
import { getZoomFactor, onDidChangeZoomLevel } from '../../../../base/browser/browser.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { BrowserOverlayManager, BrowserOverlayType } from '../../../../workbench/contrib/browserView/electron-browser/overlayManager.js';
import { IDshChatBinding, IDshChatHostContext, IDshChatInput, setDshChatHostFactory } from '../../agentStudio/browser/dshChatHost.js';
import { DshHarnessSettings } from '../common/dshHarness.js';
import { dshChatNewSessionId, dshChatSessionId, dshChatWorktreeSessionId, resolvePresetSessionId } from '../common/dshChatSession.js';
// 人格事实的**落表**（2026-10-12）：页面侧经桥上报 → 本宿主按 (agentId, sessionId) 写进
// 会话历史侧栏读的那张 PROFILE 表。格式与容错口径由该纯模块独占（parse ↔ write 同一个文件，
// 不会出现"写的人和读的人各理解一套"）。
import { PERSONA_STORAGE_KEY, personaSessionKey, writePersonaFact } from '../../sessionHistory/common/sessionPersona.js';
import { IDshHarnessService } from './dshHarnessService.js';
import { DshOverlayFreeze, dshViewPlaceholderCssText } from './dshOverlayFreeze.js';
import { DshStatusBox } from './dshStatusBox.js';

/** 编辑器服务会拦截 HTMLElement.focus；直接调用原型方法，避免焦点被转回工作台。 */
const originalHtmlElementFocus = HTMLElement.prototype.focus;

/**
 * 通知类浮层要**占满聊天框多大比例**才值得让位（见 `_hasBlockingOverlay`）。
 * 0.4 的取法：角落 toast ≈ 350×100，聊天框通常 ≈ 400×600 ⇒ ≈ 15%（忽略）；
 * 通知中心是全高面板（≈100%）⇒ 让位。
 */
const NOTIFICATION_BLOCK_AREA_RATIO = 0.4;

class DshChatBinding extends Disposable implements IDshChatBinding {
	private readonly _placeholder: HTMLElement;
	private readonly _statusBox: HTMLElement;
	private readonly _status: DshStatusBox;
	private readonly _overlayManager: BrowserOverlayManager;

	private _chatId: string;
	private _viewId: string | undefined;
	private _creatingView: Promise<void> | undefined;
	private _paneVisible = true;
	private _overlayVisible = false;
	private _rectZero = true;
	private _viewShown = false;
	/**
	 * 「以为显示了」是否已由**主进程的实际状态**背书（见 `_verifyMainVisible`）。
	 *
	 * 为什么需要这一位：主进程的视图可能被**单独**置为隐藏（窗口重置 / 视图重建 / 另一个 renderer 的
	 * `resetWindow` / 视图被移出池……），而浏览器侧的 `_viewShown` 缓存还是 true ⇒ `_updateVisibility()`
	 * 的早退让**再没有任何人**去调 `setViewVisible(true)`，页面永久停在 0x0 / `visibilityState=hidden`。
	 *
	 * 2026-10-11 实测（自证干净的一轮 e2e）：dataset 的三个前置条件**全绿**
	 * （`shown=true` / `rectZero=false` / `overlay=false`）而主进程侧 nativeVisible=false ⇒
	 * 「视图尺寸 0x0 / 打字进不去 / Ctrl+Shift+P / 看板卡」一串断言全跟着红，且**永不恢复**——
	 * 因为自愈定时器的条件 `need = … && !show` 在这种情形下恰好不成立。
	 */
	private _viewShownConfirmed = false;
	/** `_verifyMainVisible` 去重：同一时刻只对账一次。 */
	private _verifyingMainVisible = false;
	/** `_verifyMainVisible` 节流（ms 时间戳）：主进程一时修不好时，别让它变成"对账→重放→对账"的紧循环。 */
	private _lastVerifyAt = 0;
	/** 上一次"确认它在显示"的时刻（ms）；超过 TTL 视为过期 ⇒ 需要重新对账。 */
	private _viewShownConfirmedAt = 0;
	/**
	 * 已显示时**每 5s 与主进程对一次账**（心跳）。
	 *
	 * 为什么"确认过"还不够：主进程的视图可能被**静默**置为隐藏——最典型的就是 `resetWindow`
	 * （工作台 Eventually 相位回收上一个 renderer 的孤儿视图）在工作台启动早期**晚于**聊天视图创建，
	 * 视图重建 / 别的 renderer 的 dispose 同理；这些路径浏览器侧**收不到任何事件**。若那次"确认"发生在
	 * 被隐藏**之前**，只确认一次就再也不会复查 ⇒ 一样永久卡 0x0。5s 一次 IPC 换"永不卡住"。
	 */
	private _shownRecheck: ReturnType<typeof setInterval> | undefined;
	// ── 方案 5.15：preset → 会话 ────────────────────────────────────────────
	/** 当前聊天运行的 preset（undefined = 尚未习得，跟随基座会话）。 */
	private _preset: string | undefined;
	/** 无后缀基座会话实际运行的 preset（startSession 结果习得）。 */
	private _basePreset: string | undefined;
	/** 绑定序号：视图先建、绑定后台跑之后，用它判定"这次绑定是否仍是最新的一次"。 */
	/**
	 * 本会话当前所在的 worktree 绝对路径（方案 C，2026-10-12）；`undefined` = 主工作区。
	 *
	 * 为什么必须持久化：会话 id 由 `vssaros-chat-<chatId>[--<preset>]--wt-<目录名+短哈希>` 派生，
	 * 而**初始绑定**（`_ensureView`）必须回到同一个 id —— 否则 pane 一重载（切标签、重开编辑器）
	 * 就悄悄回到主工作区的会话 ✗，用户只会觉得"worktree 没生效"。与 preset 状态同一条存储记录。
	 */
	private _worktree: string | undefined;
	private _bindSeq = 0;
	/** preset → 会话 id（本 pane 运行期内习得/派生；确定性派生见 common/dshChatSession）。 */
	private readonly _presetSessions = new Map<string, string>();
	/** 进行中的切换（并发点选去重）。 */
	private _switching: Promise<void> | undefined;
	/** 当前聊天输入（pane 切标签时经 setChatId 更新；preset 状态随 input 持久化）。 */
	private _input: IDshChatInput;
	/** 隐藏自愈定时器：视图应显示却因遮挡/零宽判定隐藏时，每秒重算一次直到恢复（事件漏网的兜底）。 */
	private _hiddenRecheck: ReturnType<typeof setInterval> | undefined;

	/**
	 * 浮层让位时的**冻结帧**（让位前抓一帧贴到占位上，避免聊天区变空白）。
	 *
	 * 缘由与口径见 `dshOverlayFreeze.ts` 文件头；与侧栏 pane（`dshPluginViewPane`）共用同一个实现。
	 */
	private _freeze!: DshOverlayFreeze;

	constructor(
		private readonly _ctx: IDshChatHostContext,
		private readonly _dsh: IDshHarnessService,
		private readonly _keybindingService: IKeybindingService,
		private readonly _commands: ICommandService,
		private readonly _log: ILogService,
		private readonly _storage: IStorageService,
	) {
		super();
		this._chatId = _ctx.input.chatId;
		this._input = _ctx.input;
		// 方案 5.15：恢复切换后的 preset（基座 preset 一并恢复，用于"切回基座"的 id 解析）。
		// 真源是工作区存储（idle flush 落盘，不靠优雅退出）；input 字段是重启序列化路径的兜底。
		this._loadPresetState(this._chatId);
		_ctx.container.style.position = 'relative';
		this._placeholder = append(_ctx.container, $('.dsh-chat-instance-view'));
		this._placeholder.tabIndex = 0;
		// 底色 = 编辑器主题底色：原生视图因浮层让位而藏起来时露的就是这一层 ——
		// 不给底色就是整块空白（容器本身透明 ✗）。抓帧失败/来不及时的兜底也靠它 ✓。
		this._placeholder.style.cssText = dshViewPlaceholderCssText('var(--vscode-editor-background)');
		this._statusBox = append(_ctx.container, $('.dsh-chat-instance-status'));
		this._statusBox.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;color:var(--vscode-descriptionForeground);background:var(--vscode-editor-background);';
		this._status = new DshStatusBox(_dsh, this._commands, _log);
		this._overlayManager = this._register(new BrowserOverlayManager(getWindow(_ctx.container)));
		// 冻结帧：判据与"因浮层让位而隐藏"同源（已恢复显示 / 已不在遮挡 ⇒ 在途那帧作废 ✓）
		this._freeze = new DshOverlayFreeze(this._placeholder, this._dsh, () => !this._overlayVisible || this._viewShown,
			line => this._log.warn(`[dshHarness] ${line}`));

		this._register(this._dsh.onDidChangeStatus(s => {
			this._status.render(this._statusBox, s);
			if (s.state === 'running') {
				void this._ensureView();
			}
			// 控制桥连上后工作区才注册：状态变化时刷新一次，并顺带刷新诊断 dataset。
			void this._refreshWorkspaceSync();
		}));
		// 主进程注册完成/上报变化时刷新（聊天框可能先于注册完成挂载）；再加一个周期性刷新兜底。
		this._register(this._dsh.onDidWorkspaceSync(() => this._updateVisibility()));
		const wsTimer = getWindow(_ctx.container).setInterval(() => void this._refreshWorkspaceSync(), 15_000);
		this._register(toDisposable(() => getWindow(_ctx.container).clearInterval(wsTimer)));
		this._register(this._dsh.onDidPageEvent(e => {
			if (e.viewId !== this._viewId) {
				return;
			}
			if (e.kind === 'keydown') {
				// 页面未处理的快捷键交给工作台（与上游 browserEditor 相同做法）。
				try {
					this._keybindingService.dispatchEvent(new StandardKeyboardEvent(new KeyboardEvent('keydown', e.event)), this._placeholder);
				} catch (err) {
					this._log.error('[dshHarness] chat key dispatch failed', err);
				}
			} else if (e.kind === 'focus') {
				originalHtmlElementFocus.call(this._placeholder);
			} else if (e.kind === 'command' && e.command.method === 'switchPreset') {
				// 方案 5.15：已有会话切 preset（空白会话页面侧已直切，不会走到这里）。
				void this._switchPreset(e.command.presetId);
			} else if (e.kind === 'command' && e.command.method === 'openSession') {
				// header「历史会话」菜单：切到指定会话（宿主是会话绑定的权威，走既有 rebind 通路）。
				void this._openSession(e.command.sessionId, e.command.agentPreset);
			} else if (e.kind === 'command' && e.command.method === 'newChat') {
				// header「新建会话」/ Commands 的「Preset」行：开一个新聊天页签
				// （引擎设置为 dsh ⇒ 新页签仍是 dsh 聊天；带 preset 时新页签直接绑该 preset 的会话）。
				void this._newChat(e.command.agentPreset);
			} else if (e.kind === 'command' && e.command.method === 'newSession') {
				// header 的「＋ 新建会话」：**本页签内**换一段新对话（不新建编辑器）。
				// 2026-10-12 用户要求：页签内的 ＋ 就该在本页签继续，新开 group 页签是**顶部**那个 ＋ 的事。
				void this._newSessionInPlace();
			} else if (e.kind === 'command' && e.command.method === 'switchWorktree') {
				// header 的 worktree 下拉（方案 C）：**本会话**换到那个 worktree（新会话 + 沿用当前 preset）。
				void this._switchWorktree(e.command.path);
			} else if (e.kind === 'command' && e.command.method === 'sessionTitle') {
				// 外层页签文案 = dsh 会话标题（页面侧读到后经 `window.vssarosDsh.sessionTitle` 上报）。
				// `NativeChatEditorInput.setSessionName` 正是为此提供的：其注释写明"重命名来自别处
				//（如会话历史侧栏）时，打开着的编辑器要跟随变更"，且页签**只显示 session 名、不做拼接**
				// ⇒ 这里直接透传即可；`title === null`（页面暂无标题）会回落原标签（该方法内部已处理）。
				//
				// 用可选探测而不是扩 `IDshChatInput` 接口：宿主层拿到的本就是窄接口面（运行时对象
				// 就是 NativeChatEditorInput）。缺方法只记一条 warn，不静默失败。
				const input = this._ctx.input as { setSessionName?: (name: string | null) => void };
				if (typeof input.setSessionName === 'function') {
					input.setSessionName(e.command.title);
				} else {
					this._log.warn('[dshHarness] chat tab label: input.setSessionName unavailable (title not applied)');
				}
			} else if (e.kind === 'command' && e.command.method === 'sessionPersona') {
				// 本会话人格（历史会话侧栏的标记）：页面侧读 dsh 投影得到，宿主负责 join 壳侧身份后落表。
				this._applyPersonaFact(e.command);
			} else if (e.kind === 'command') {
				// ★ 2026-10-13：**不许静默** ✗ —— 上面这条链只处理"聊天宿主自己负责"的少数方法；
				// 其余（`openTerminal` / `reveal` / `showUncommittedDiff` / `notify` …）由
				// `DshPageCommandContribution` 统一处理 ✓。一旦那个贡献点没加载（窗口入口不同 / 开关关掉），
				// 这些命令就会**点了没反应、日志里也什么都没有** ✗✗ —— 「在终端打开没反应」就是这样查了半天 ✓。
				this._log.trace(`[dshHarness] chat page command not handled by this host (expected: page-command contribution): ${e.command.method}`);
			}
		}));
		this._register(this._overlayManager.onDidChangeOverlayState(() => this._checkOverlays()));
		this._register(onDidChangeZoomLevel(id => {
			if (id === _ctx.windowId) {
				this._layoutView();
			}
		}));
		const win = getWindow(_ctx.container);
		const resizeObserver = new win.ResizeObserver(() => {
			this._updateVisibility();
			if (this._viewId && this._paneVisible && !this._rectZero) {
				this._layoutView();
			}
		});
		resizeObserver.observe(this._placeholder);
		this._register(toDisposable(() => resizeObserver.disconnect()));
		// 聊天标签彻底关闭（输入销毁）时释放本 pane 认领的全部视图（幂等，与 dispose 同路）。
		this._register(_ctx.input.onWillDispose(() => {
			this._dsh.releaseChatViews(this);
		}));

		this._status.render(this._statusBox, this._dsh.status);
		void this._dsh.ensureStarted().catch(e => this._log.error('[dshHarness] start failed', e));
		this._updateVisibility();
	}

	/** 视图基础 id 带窗口号（方案 7.x：多窗口共用主进程视图表，窗口间不撞）；同 chatId 多开由分配器加后缀仲裁。 */
	private _viewBaseFor(chatId: string): string {
		return `dsh-chat-w${this._ctx.windowId}-${chatId}`;
	}

	setChatId(chatId: string, input?: IDshChatInput): void {
		if (chatId === this._chatId) {
			return;
		}
		const old = this._viewId;
		this._chatId = chatId;
		if (input) {
			this._input = input;
		}
		this._loadPresetState(chatId);
		this._presetSessions.clear();
		this._viewId = undefined;
		this._viewShown = false;
		this._viewShownConfirmed = false;
		if (old) {
			void this._dsh.setViewVisible(old, false);
		}
		if (this._dsh.status.state === 'running') {
			void this._ensureView();
		}
		this._updateVisibility();
	}

	setVisible(visible: boolean): void {
		this._paneVisible = visible;
		this._updateVisibility();
	}

	layout(): void {
		this._layoutView();
	}

	focus(): void {
		if (this._viewId && this._dsh.status.state === 'running') {
			this._dsh.noteActiveChatView(this._viewId, this);
			originalHtmlElementFocus.call(this._placeholder);
			void this._dsh.setViewVisible(this._viewId, this._shouldShow, true);
		}
	}

	override dispose(): void {
		if (this._hiddenRecheck !== undefined) {
			clearInterval(this._hiddenRecheck);
			this._hiddenRecheck = undefined;
		}
		if (this._shownRecheck !== undefined) {
			clearInterval(this._shownRecheck);
			this._shownRecheck = undefined;
		}
		this._viewId = undefined;
		// pane 销毁 = 这个聊天框不再存在：释放它认领的全部视图（同 pane 内切标签 parked 的也算）。
		this._dsh.releaseChatViews(this);
		super.dispose();
	}

	private get _shouldShow(): boolean {
		return this._paneVisible && !this._overlayVisible && !this._rectZero && this._dsh.status.state === 'running' && !!this._viewId;
	}

	private _ensureView(): Promise<void> {
		if (this._viewId) {
			return Promise.resolve();
		}
		if (!this._creatingView) {
			const viewId = this._dsh.claimChatViewId(this._viewBaseFor(this._chatId), this);
			// 方案 7.x：chatId → dsh 会话（控制桥 session.start，幂等接管）。web 端没有会话深链，
			// 会话 id 经 preload 参数交给 @vssaros/dsh-chat-surface，在页面里 openSession。
			// 没有工作区路径时不绑定（页面保持官方默认形态），Host 重启后 dsh 会话仍在、页面自动重开。
			// 方案 5.15：恢复/切换到 preset 时绑定该 preset 的专属会话（确定性派生 id）。
			const presetAtBind = this._preset;
			// 恢复上次所在的 worktree（方案 C）：不恢复的话，pane 一重载就悄悄回到主工作区的会话 ✗。
			const cwdAtBind = this._worktree ?? this._ctx.workspacePath;
			const sessionId = cwdAtBind ? this._sessionIdFor(presetAtBind, cwdAtBind) : '';
			// 绑定决策**留痕**（2026-10-12）：新页签"没有 session.start"是最难查的一种 —— 页面会继续显示
			// **上一个选中的会话**，看起来就像"新建聊天打开了已有会话" ✗。这一行让"到底派生了什么 id、
			// 有没有 cwd"一眼可见（有无 session.start 也就有了对照）。
			this._log.info(`[dshHarness] chat ${this._chatId} bind: cwd=${cwdAtBind ?? '(无，不绑定)'} sessionId=${sessionId || '(无)'} preset=${presetAtBind ?? '(base)'}`);
			// 绑定（startSession：幂等接管 + 派生 preset 专属 id）与**视图创建并行**：
			// 页面按 argv 里的 sessionId 立刻开始加载（chat-surface 每 500 ms 轮询，会话没就绪就重试，
			// 见其 client.js），而绑定要排在 Host 的 workspace 注册之后（用户机器实测 ~4 s）。
			// 串行（原来的 `bind.then(createView)`）等于让页面白白空等这段时间。
			const bind: Promise<string | undefined> = sessionId
				? this._dsh.startSession({ cwd: cwdAtBind!, sessionId, agentPreset: presetAtBind })
					.then(r => {
						this._recordSession(presetAtBind, r.sessionId, r.agentPreset ?? undefined);
						return r.sessionId;
					}, e => {
						this._log.warn(`[dshHarness] session.start failed for chat ${this._chatId}`, e);
						return undefined;
					})
				: Promise.resolve(undefined);
			// 视图立刻创建（页面从此并行加载），但 `_creatingView` 仍等绑定完成才 resolve——
			// 调用方（以及 e2e）依赖"resolve 时视图已绑好"这条既有语义。
			const bindSeq = ++this._bindSeq;
			this._creatingView = this._dsh.createView(viewId, this._windowId, 'chat', sessionId).then(() => {
				this._viewId = viewId;
				this._placeholder.dataset.sessionId = sessionId;
				this._layoutView();
				this._updateVisibility();
				// 绑定拿到的会话 id 与请求的不同（Host 派生/接管了别的会话）时，让页面切过去。
				// 只在这次绑定仍是最新的一次时做：期间用户切了 preset（那是更新的一次绑定）就不能回退。
				return bind.then(actual => {
					if (bindSeq === this._bindSeq && actual && actual !== sessionId && this._viewId === viewId) {
						this._placeholder.dataset.sessionId = actual;
						void this._dsh.rebindSession(viewId, actual);
					}
				});
			}, e => this._log.error('[dshHarness] createView failed', e)).finally(() => this._creatingView = undefined);
		}
		return this._creatingView;
	}

	private get _windowId(): number {
		return getWindow(this._placeholder).vscodeWindowId;
	}

	// ── 方案 5.15：preset 切换 ─────────────────────────────────────────────

	/** 读取某 chatId 的持久化 preset 状态（工作区存储优先，input 序列化字段兜底）。 */
	private _loadPresetState(chatId: string): void {
		let stored: { preset?: string; basePreset?: string; worktree?: string } = {};
		try {
			const raw = this._storage.get(`dshHarness.chatPreset.${chatId}`, StorageScope.WORKSPACE, '');
			stored = raw ? JSON.parse(raw) : {};
		} catch { /* 损坏视为无 */ }
		this._preset = stored.preset ?? this._input.dshPreset;
		this._basePreset = stored.basePreset ?? this._input.dshBasePreset;
		// worktree 没有 input 兜底（pane input 不序列化它）：只有存储这一处真源，取不到就当主工作区 ✓。
		this._worktree = typeof stored.worktree === 'string' && stored.worktree ? stored.worktree : undefined;
	}

	// ── 人格事实落表（2026-10-12）────────────────────────────────────────────

	/**
	 * 把页面报上来的「本会话人格」写进**会话历史侧栏读的那张表**（PROFILE / USER）。
	 *
	 * 身份拼接是这里唯一一处 join（写错 = "什么都不显示、也不报错"）：
	 *   · dsh 会话 id ← `vssaros-chat-<sanitize(chatId)>[--preset][--wt-…]`（**不可逆**的派生）；
	 *   · 侧栏的键 = `agentId::sessionId`（`sessionHistoryView._sessionKey`）。
	 *   页面只知道前者，宿主页签手里才有后者（`NativeChatEditorInput.agentId/.sessionId`）
	 *   ⇒ 所以这条事实必须经宿主，页面自己写不了那个键。
	 *
	 * 同一个 chatId 在不同 preset 下对应**不同 dsh 会话**，但侧栏一行只认 `agentId::sessionId`
	 * ⇒ 后报的覆盖先报的：当前绑定的那个 preset 才是"这一行现在的人格"，符合侧栏语义。
	 *
	 * `personaId === null` = 跟随 Agent 自带人设（挂载期事实，不是"未知"）⇒ **删掉**该条。
	 * 身份还不全（新页签尚未绑会话）⇒ 记 warn 后丢弃 —— **绝不猜键**（猜出来的键永远匹配不上）。
	 */
	private _applyPersonaFact(command: { personaId: string | null; name?: string; applicable?: boolean }): void {
		const agentId = this._input.agentId;
		const sessionId = this._input.sessionId;
		if (!agentId || !sessionId) {
			this._log.warn(`[dshHarness] persona fact dropped: chat ${this._chatId} 还没有 (agentId, sessionId) 身份（新页签未绑会话）`);
			return;
		}
		try {
			const key = personaSessionKey(agentId, sessionId);
			const raw = this._storage.get(PERSONA_STORAGE_KEY, StorageScope.PROFILE, '');
			const next = writePersonaFact(raw, key, command.personaId ? { id: command.personaId, ...(command.name ? { name: command.name } : {}) } : undefined);
			// 无变化就不落盘（页面侧已去过重，这是第二道：重复 store 会白白触发一次存储变更事件）。
			if (next === raw) {
				return;
			}
			this._storage.store(PERSONA_STORAGE_KEY, next, StorageScope.PROFILE, StorageTarget.USER);
			this._log.info(`[dshHarness] persona fact ${command.personaId ?? '(跟随自带人设)'} → ${key}（applicable=${String(command.applicable)}）`);
		} catch (e) {
			// 存储不可用不该把"切人格"本身带崩：人格在 dsh 侧已经生效，这只是侧栏标记。
			this._log.warn('[dshHarness] persona fact not persisted', e);
		}
	}

	/** 持久化当前 preset 状态（切回基座 preset 时存 undefined = 未显式切换）+ 当前 worktree（方案 C）。 */
	private _savePresetState(): void {
		const preset = this._preset === this._basePreset ? undefined : this._preset;
		this._storage.store(`dshHarness.chatPreset.${this._chatId}`, JSON.stringify({ preset, basePreset: this._basePreset, ...(this._worktree ? { worktree: this._worktree } : {}) }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/**
	 * 当前应绑定的会话 id。
	 *
	 * `dir` = 这次要跑在哪个目录（缺省 = 本窗口主工作区）：
	 *   · 主工作区 ⇒ 既有规则（未显式切 preset 时基座无后缀 id；否则按确定性规则解析，含已知映射）；
	 *   · 其他目录（worktree）⇒ 带 `--wt-` 段的专属会话。**不查 `_presetSessions` 映射**：那张表按
	 *     preset 存，在 worktree 语境下会指向主工作区的会话 ✗，所以 worktree 一律走纯函数派生 ✓。
	 */
	private _sessionIdFor(preset: string | undefined, dir?: string): string {
		const target = dir ?? this._ctx.workspacePath;
		if (target && this._isWorktreeDir(target)) {
			return dshChatWorktreeSessionId(this._chatId, preset, target);
		}
		if (!preset) {
			return dshChatSessionId(this._chatId);
		}
		return resolvePresetSessionId(this._chatId, preset, { basePreset: this._basePreset, known: this._presetSessions });
	}

	/**
	 * 该目录是否是一个 worktree（≠ 本窗口主工作区目录）。
	 * 路径比较：统一分隔符 + 去尾斜杠 + 大小写不敏感（Windows 为主；Linux 上"仅大小写不同"的两个目录
	 * 会被当成同一个 —— 可接受，且比"每次判成 worktree"安全得多）。
	 */
	private _isWorktreeDir(dir: string): boolean {
		const main = this._ctx.workspacePath;
		if (!main) { return true; }
		const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '');
		const a = norm(dir);
		const b = norm(main);
		return a !== b && a.toLowerCase() !== b.toLowerCase();
	}

	/** 习得一条 preset → 会话映射；基座会话额外习得它实际运行的 preset 并持久化。 */
	private _recordSession(requestedPreset: string | undefined, sessionId: string, actualPreset: string | undefined): void {
		const preset = actualPreset ?? requestedPreset;
		if (!preset) {
			return;
		}
		this._presetSessions.set(preset, sessionId);
		this._placeholder.dataset.dshPreset = preset;
		if (sessionId === dshChatSessionId(this._chatId) && this._basePreset !== preset) {
			this._basePreset = preset;
			this._input.setDshBasePreset?.(preset);
			this._savePresetState();
		}
	}

	private _switchPreset(presetId: string): Promise<void> {
		if (!this._switching) {
			this._switching = this._doSwitchPreset(presetId)
				.catch(e => this._log.warn(`[dshHarness] switchPreset ${presetId} failed for chat ${this._chatId}`, e))
				.finally(() => this._switching = undefined);
		}
		return this._switching;
	}

	/** 已有会话切 preset：换到该 preset 的专属会话（各自历史独立；空白直切在页面侧已完成，不到这里）。 */
	private async _doSwitchPreset(presetId: string): Promise<void> {
		if (presetId === this._preset) {
			return;
		}
		const cwd = this._ctx.workspacePath;
		const viewId = this._viewId;
		if (!cwd || !viewId || this._dsh.status.state !== 'running') {
			this._log.warn(`[dshHarness] switchPreset ${presetId} ignored: workspace/view/host not ready (chat ${this._chatId})`);
			return;
		}
		const target = this._sessionIdFor(presetId);
		// 这是更新的一次绑定：让仍在途的初始绑定结果不再回写/回退（它可能晚于本次完成）。
		this._bindSeq++;
		const res = await this._dsh.startSession({ cwd, sessionId: target, agentPreset: presetId });
		this._recordSession(presetId, res.sessionId, res.agentPreset ?? undefined);
		this._preset = res.agentPreset ?? presetId;
		// 切回基座 preset = 回到未显式切换状态（重载后绑基座会话）。
		this._input.setDshPreset?.(this._preset === this._basePreset ? undefined : this._preset);
		this._savePresetState();
		await this._dsh.rebindSession(viewId, res.sessionId);
		this._placeholder.dataset.sessionId = res.sessionId;
	}

	/**
	 * 把当前会话切到另一个**目录**（dsh 聊天 header 的 worktree 下拉；方案 C，2026-10-12）。
	 *
	 * ⚠ 2026-10-14：**工作区 chip 也走这一条**（页面侧 `client.workspace.js` 的「切换工作区」）——
	 * 工作区切换在宿主这里与 worktree 切换是**同一个动作**（换目录 ⇒ 新会话），
	 * 而 {@link _isWorktreeDir} 只判"是不是本窗口主工作区"⇒ 对任意非主目录都成立 ✓。
	 * 所以两处共用本方法（不新增同义命令：那只会多出一条会各自漂移的入口 ✗）。
	 *
	 * 与 preset 切换**共用 single-flight**（`_switching`）：两者都是"换一次会话绑定"，并发跑会互相覆盖 ✗。
	 */
	private _switchWorktree(worktreePath: string): Promise<void> {
		if (!this._switching) {
			this._switching = this._doSwitchWorktree(worktreePath)
				.catch(e => this._log.warn(`[dshHarness] switchWorktree ${worktreePath} failed for chat ${this._chatId}`, e))
				.finally(() => this._switching = undefined);
		}
		return this._switching;
	}

	/**
	 * 换目录 = **新会话**（沿用当前 preset；worktree 下拉与「切换工作区」两个入口共用）。
	 *
	 * 为什么只能新开会话：dsh 的会话 cwd 在 `session.start` 时定死，桥面**没有**"改已有会话 cwd"的方法
	 * ⇒ 换目录只能新建；会话 id 带 `--wt-` 段 ⇒ 每个目录各有一段历史，**切回来就是幂等接管** ✓
	 * （不需要另存映射表）。
	 *
	 * 为什么不把新目录注册成 dsh 工作区：`DshWorkspaceReportContribution` 已经把"各仓库的 git worktree"
	 * 一并上报（主进程 `workspace.ensure`）⇒ `session.start` 后页面按 `sessionIds` 反查归属能查到 ✓。
	 *
	 * preset 沿用当前值：用户在这里选的 agent 不该因为换目录而丢（代价是它在新会话里**重新装配**，
	 * 工具/模型/skills 重新锁定 —— UI 必须在菜单里如实说明"会新建会话"）。
	 */
	private async _doSwitchWorktree(worktreePath: string): Promise<void> {
		const viewId = this._viewId;
		const preset = this._preset;
		if (!viewId || this._dsh.status.state !== 'running') {
			this._log.warn(`[dshHarness] switchWorktree ignored: view/host not ready (chat ${this._chatId})`);
			return;
		}
		const isWorktree = this._isWorktreeDir(worktreePath);
		const target = this._sessionIdFor(preset, worktreePath);
		if (target === this._placeholder.dataset.sessionId) {
			return;   // 已在该目录的会话上（幂等：菜单里再点一次当前项不该有任何动静）
		}
		this._bindSeq++;
		const res = await this._dsh.startSession({ cwd: worktreePath, sessionId: target, agentPreset: preset });
		this._recordSession(preset, res.sessionId, res.agentPreset ?? undefined);
		this._preset = res.agentPreset ?? preset;
		// 主工作区 ⇒ 清掉 worktree 记账（等价于"切回主干的老会话"）；
		// ⚠ 记录的是**用户选的那个目录**（不是 `res.sessionId` 反推 —— id 里只有哈希，反推不可靠）。
		this._worktree = isWorktree ? worktreePath : undefined;
		this._input.setDshPreset?.(this._preset === this._basePreset ? undefined : this._preset);
		this._savePresetState();
		await this._dsh.rebindSession(viewId, res.sessionId);
		this._placeholder.dataset.sessionId = res.sessionId;
		if (this._worktree) {
			this._placeholder.dataset.dshWorktree = this._worktree;
		} else {
			delete this._placeholder.dataset.dshWorktree;
		}
		this._log.info(`[dshHarness] chat ${this._chatId} switched to ${isWorktree ? 'worktree' : 'main dir'} ${worktreePath} (session ${res.sessionId}, preset ${this._preset ?? '(base)'})`);
	}

	/**
	 * 切到指定 dsh 会话（header「历史会话」菜单）。宿主是**会话绑定的权威**，所以走**既有 rebind 通路**
	 * （`dsh.rebindSession` → 页面 `vssaros-dsh-rebind` → 对齐工作区 + openSession），与 preset 切换同源，
	 * 避免"页面私自换会话、宿主 slot 还指着旧的"这种分叉。
	 *
	 * `agentPreset` 由页面从会话快照带上来：有则同步 preset 记账，让后续 switchPreset 从正确的会话派生。
	 */
	private async _openSession(sessionId: string, agentPreset?: string): Promise<void> {
		const viewId = this._viewId;
		if (!viewId || this._dsh.status.state !== 'running') {
			this._log.warn(`[dshHarness] openSession ignored: view/host not ready (chat ${this._chatId})`);
			return;
		}
		// 这是更新的一次绑定：让仍在途的初始绑定结果不再回写/回退（同 _doSwitchPreset）。
		this._bindSeq++;
		if (agentPreset) {
			// 第三个参数是"该会话实际运行的 preset"（页面从会话快照读到的就是它，故与第二个同值）。
			this._recordSession(agentPreset, sessionId, agentPreset);
			this._preset = agentPreset;
			this._input.setDshPreset?.(this._preset === this._basePreset ? undefined : this._preset);
			this._savePresetState();
		}
		await this._dsh.rebindSession(viewId, sessionId);
		this._placeholder.dataset.sessionId = sessionId;
	}

	/**
	 * 新建聊天页签（header 的「新建会话」/ Commands 的「Preset」行）：页面无法创建编辑器，执行官方命令代劳。
	 * 语义与原生面板的 `_onNewSession` 一致 —— 都是"新开一个对话页签"，不是"给当前会话换绑"。
	 *
	 * `agentPreset`（可选，2026-10-11 加）：新页签**直接绑该 preset 的专属会话** —— 这就是 chat-surface
	 * 「切换 preset = 新建一个会话」的全部含义（preset 决定会话组合，首回合后 Host 锁定 ⇒ 只能新开会话；
	 * 而"换人格"是另一条路，在当前会话内继续，见 agents 模块的 `/x/agents/api/persona`）。
	 * 实现走命令参数 ⇒ `NativeChatEditorInput.setDshPreset()`（**必须在 openEditor 之前**设，
	 * 因为 pane 打开时就按它做 `session.start` 绑定）。
	 */
	private async _newChat(agentPreset?: string): Promise<void> {
		try {
			await this._commands.executeCommand('agentStudio.newChatInEditor', agentPreset ? { presetId: agentPreset } : undefined);
			this._log.info(`[dshHarness] new chat opened (chat ${this._chatId}${agentPreset ? `, preset ${agentPreset}` : ''})`);
		} catch (e) {
			this._log.warn('[dshHarness] newChat command failed', e);
		}
	}

	/**
	 * **本页签内**新建会话（dsh 聊天 header 的「＋ 新建会话」；2026-10-12 用户要求）。
	 *
	 * 与 {@link _newChat}（新开一个对话页签）的区别只在**落点**：这里不新建编辑器，直接给当前页签
	 * 换一个**全新的** dsh 会话（历史独立；preset 与 cwd 沿用当前值）。
	 *
	 * 与 `_doSwitchWorktree` 同构：共用 single-flight（`_switching`，两者都是"换一次会话绑定"，
	 * 并发跑会互相覆盖 ✗）+ `_bindSeq` 防回退 + `rebindSession` 回推 + 更新 `dataset.sessionId`。
	 *
	 * 为什么 id 必须**不**确定（见 `dshChatNewSessionId`）：其它派生规则靠"同一 (chatId,preset,worktree)
	 * 恒等"实现幂等接管，而"再给我一个新会话"每次都必须不同 —— 否则第二次点还是回到同一个 ✗。
	 */
	private _newSessionInPlace(): Promise<void> {
		if (!this._switching) {
			this._switching = this._doNewSessionInPlace()
				.catch(e => this._log.warn(`[dshHarness] newSession failed for chat ${this._chatId}`, e))
				.finally(() => this._switching = undefined);
		}
		return this._switching;
	}

	private async _doNewSessionInPlace(): Promise<void> {
		const viewId = this._viewId;
		// cwd 沿用**当前会话所在目录**：worktree 语境下不要把它悄悄切回主工作区 ✗（同 _doSwitchWorktree）。
		const cwd = this._worktree ?? this._ctx.workspacePath;
		if (!cwd || !viewId || this._dsh.status.state !== 'running') {
			this._log.warn(`[dshHarness] newSession ignored: workspace/view/host not ready (chat ${this._chatId})`);
			return;
		}
		const preset = this._preset;
		const target = dshChatNewSessionId(this._chatId, Date.now().toString(36));
		// 这是更新的一次绑定：让仍在途的初始绑定结果不再回写/回退（同 _doSwitchPreset）。
		this._bindSeq++;
		const res = await this._dsh.startSession({ cwd, sessionId: target, agentPreset: preset });
		this._recordSession(preset, res.sessionId, res.agentPreset ?? undefined);
		this._preset = res.agentPreset ?? preset;
		this._input.setDshPreset?.(this._preset === this._basePreset ? undefined : this._preset);
		this._savePresetState();
		await this._dsh.rebindSession(viewId, res.sessionId);
		this._placeholder.dataset.sessionId = res.sessionId;
		this._log.info(`[dshHarness] chat ${this._chatId} new session in this tab (session ${res.sessionId}, preset ${this._preset ?? '(base)'})`);
	}

	private _layoutView(retries = 2): void {
		if (!this._viewId) {
			return;
		}
		const win = getWindow(this._placeholder);
		const rect = this._placeholder.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) {
			if (retries > 0 && this._paneVisible) {
				win.requestAnimationFrame(() => this._layoutView(retries - 1));
			}
			return;
		}
		this._checkOverlays();
		void this._dsh.layoutView(this._viewId, {
			windowId: this._windowId,
			x: rect.left,
			y: rect.top,
			width: rect.width,
			height: rect.height,
			zoomFactor: getZoomFactor(win),
		});
	}

	/** 命令面板等浮层覆盖聊天区时临时隐藏原生视图（与完整面板同一口径）。 */
	/**
	 * 是否有**需要让位**的浮层压住聊天框。
	 *
	 * 为什么不能"有浮层就让位"：`BrowserOverlayManager.OVERLAY_DEFINITIONS` 把
	 * `notification-toast-container` 也算浮层，而 VS Code 的**错误通知是粘性的**（不自动消失）。
	 * 通知 toast 停在窗口右下角、正好与聊天框矩形相交 ⇒ 整块聊天框被隐藏、状态层也因
	 * 「running + 有视图」而隐藏 ⇒ 用户看到的是"dsh 聊天框空白，重启也不恢复"
	 * （实测：一条「Unable to write to User Settings …」就这样把聊天框永久挡成空白）。
	 *
	 * 所以只对**通知类**按面积判定：通知中心是全高面板（面积占比高）仍需让位，角落 toast 忽略；
	 * 菜单 / 快速输入 / hover / 对话框这类真·浮层一律让位 —— 原生视图永远盖在 DOM 之上，
	 * 不让位就会被压在下面看不见。
	 */
	private _hasBlockingOverlay(): boolean {
		const overlays = this._overlayManager.getOverlappingOverlays(this._placeholder);
		if (!overlays.length) {
			return false;
		}
		const rect = this._placeholder.getBoundingClientRect();
		const paneArea = Math.max(1, rect.width * rect.height);
		return overlays.some(o => {
			if (o.type !== BrowserOverlayType.Notification) {
				return true;
			}
			return (o.rect.width * o.rect.height) / paneArea >= NOTIFICATION_BLOCK_AREA_RATIO;
		});
	}

	private _checkOverlays(): void {
		// ★ 必须与 `_updateVisibility()` 用**同一个**判定（`_hasBlockingOverlay`）。
		//
		// 这里曾经写的是"有任意相交浮层就让位"（`overlays.length > 0`），于是与下面那套"按面积占比"的
		// 口径打架：`BrowserOverlayManager.OVERLAY_DEFINITIONS` 把 `notification-toast-container` 也算浮层，
		// 而 VS Code 的错误通知是**粘性**的 ⇒ 角落一个 toast 就把原生视图隐藏；更糟的是 `_layoutView()`
		// **每次都调本方法**（见那里），所以 `_updateVisibility()` 里的自愈刚把 `_overlayVisible` 算回 false，
		// 下一次布局又被按回 true ⇒ 聊天框空白且**再也不恢复**。
		//
		// 实测（2026-10-11 e2e）：sticky-error 守卫红在 `notify=ok vis=false`，且同一轮里
		// "视图尺寸 0x0 / 聊天框被编辑器标签挤没 / 分栏后 shown=false"等一串断言全跟着红——一个卡住的
		// 标志位连累一片。判定只在 `_hasBlockingOverlay` 一处，别在第二处重写。
		const blocking = this._hasBlockingOverlay();
		if (blocking !== this._overlayVisible) {
			this._overlayVisible = blocking;
			this._updateVisibility();
		}
	}

	private async _refreshWorkspaceSync(): Promise<void> {
		await this._dsh.getWorkspaceSync().catch(() => undefined);
		this._updateVisibility();
	}

	private _updateVisibility(): void {
		const rect = this._placeholder.getBoundingClientRect();
		this._rectZero = rect.width === 0 || rect.height === 0;
		// 遮挡标志无条件重算（廉价的 DOM 查询）：只信 onDidChangeOverlayState 事件会在 toast 自然消失时
		// 漏更新而永久卡住（e2e 实测多次），这里自愈；事件路径保留做快速响应。
		this._overlayVisible = this._hasBlockingOverlay();
		const show = this._shouldShow;
		// 这一次隐藏是不是"因浮层让位"：是的话，让位与抓帧必须**合成一次调用**（主进程内先抓后藏）——
		// 拆开会让两条 IPC 赛跑、抓到离屏空帧（见 `dshOverlayFreeze.ts` 文件头）。恢复显示时清掉帧 ✓。
		const freezeHide = !show && this._overlayVisible && this._viewShown;
		if (show) {
			this._freeze.clear();
		}
		// 「插入引用」的落点跟随"在场"状态（pane 可见且布局矩形非零）。浮层遮挡不算离开——
		// 命令面板/通知打开时用户仍在这个聊天里（实测：F1 浮层触发的隐藏会把落点清掉，命令随即找不到目标）。
		if (this._viewId) {
			if (this._paneVisible && !this._rectZero) {
				// 在场时重新仲裁：持有的视图若被另一个在场聊天框占用（同一 chatId 多开），换到自己的视图。
				const proper = this._dsh.claimChatViewId(this._viewBaseFor(this._chatId), this);
				if (proper !== this._viewId) {
					this._viewId = undefined;
					this._viewShown = false;
					this._viewShownConfirmed = false;
					void this._ensureView();
					return;
				}
				this._dsh.noteActiveChatView(this._viewId, this);
			} else {
				this._dsh.clearActiveChatView(this._viewId, this);
			}
		}
		this._statusBox.style.display = this._dsh.status.state === 'running' && this._viewId ? 'none' : 'flex';
		// 诊断用：渲染进程侧的判定输入，可与主进程 listViews 对照。
		const d = this._placeholder.dataset;
		d.viewId = this._viewId ?? '';
		d.chatId = this._chatId;
		d.hostState = this._dsh.status.state;
		d.shown = String(show);
		d.rectZero = String(this._rectZero);
		d.overlay = String(this._overlayVisible);
		const ws = this._dsh.workspaceSync;
		d.wsReported = String(ws.reported);
		d.wsRegistered = String(ws.registered);
		d.wsRejected = String(ws.rejected);
		d.activeChat = String(!!this._viewId && this._dsh.activeChatViewId === this._viewId);
		if (!this._viewId || show === this._viewShown) {
			// 「以为显示了」≠「主进程真的显示了」：主进程可能被**单独**置为隐藏（窗口重置 / 视图重建 /
			// 另一个 renderer 的 resetWindow…），而这里的缓存还是 true ⇒ 早退之后**再没有任何人**调
			// `setViewVisible(true)`，页面永久 0x0 / hidden（2026-10-11 实测：三个前置条件全绿而主进程
			// nativeVisible=false）。所以这一态也必须**与主进程对账**，不能只信本地缓存。
			this._verifyMainVisible(show);
			this._armHiddenRecheck(show);
			this._armShownRecheck(show);
			return;
		}
		this._viewShown = show;
		// 刚下的"显示/隐藏"结论还没被主进程背书 ⇒ 交给 `_verifyMainVisible` 对账；未确认期间
		// `_armHiddenRecheck` 会保持 1s 复算，直到对上（或需要重放）。健康路径上这只是一次 IPC。
		this._viewShownConfirmed = false;
		if (show) {
			this._layoutView();
			void this._dsh.setViewVisible(this._viewId, true);
		} else if (freezeHide) {
			// 让位 + 贴帧（`hideAndFreeze` 自己会把视图藏起来 ⇒ **不要**再发 setViewVisible(false)）
			this._freeze.hideAndFreeze(this._viewId);
		} else {
			void this._dsh.setViewVisible(this._viewId, false);
		}
		this._verifyMainVisible(show);
		this._armHiddenRecheck(show);
		this._armShownRecheck(show);
	}

	/**
	 * 与主进程**对账**："我说要显示"必须由主进程的实际状态（`nativeVisible`，Electron 侧的真相）背书。
	 *
	 * 只在"该显示、以为已显示、但还没被背书"时问一次；确认后**不再问**（健康路径零额外开销——一次
	 * IPC 换"永不卡住"）。不一致就作废缓存，让 `_updateVisibility()` 重放（重新 `_layoutView()`
	 * ＋ `setViewVisible(true)`）。
	 *
	 * 口径同本文件其它自愈点：本地缓存 `_viewShown` 只是**意图**，主进程的 `nativeVisible` 才是**事实**。
	 */
	private _verifyMainVisible(show: boolean): void {
		// 已确认且未过期（TTL 5s）⇒ 不必问：健康路径因此只有每 5s 一次 IPC（心跳）。
		if (!show || !this._viewId || this._verifyingMainVisible || this._isShownConfirmed()) {
			return;
		}
		// 节流：不一致时"重放"会再次走到这里，不节流会变成 IPC 紧循环；1s 一次足够自愈。
		const now = Date.now();
		if (now - this._lastVerifyAt < 1_000) {
			return;
		}
		this._lastVerifyAt = now;
		const viewId = this._viewId;
		this._verifyingMainVisible = true;
		void this._dsh.listViews().then(views => {
			this._verifyingMainVisible = false;
			if (this._viewId !== viewId) {
				return;      // 期间换了视图：这次结论作废
			}
			const info = views.find(v => v.viewId === viewId);
			if (info?.nativeVisible) {
				this._viewShownConfirmed = true;
				this._viewShownConfirmedAt = Date.now();
			} else {
				// 主进程没显示（或该视图已不在池里）⇒ 作废"已显示"，重放一次。
				this._viewShown = false;
				this._viewShownConfirmed = false;
				this._viewShownConfirmedAt = 0;
				this._updateVisibility();
			}
		}, () => {
			this._verifyingMainVisible = false;      // 查询失败不动结论，等下一次
		});
	}

	/** 最近 5s 内确认过"主进程真的在显示它"（确认会过期 ⇒ 靠心跳复查）。 */
	private _isShownConfirmed(): boolean {
		return this._viewShownConfirmed && Date.now() - this._viewShownConfirmedAt < 5_000;
	}

	/** 已显示时的心跳：只要"该显示"，就每 5s 与主进程对一次账（静默隐藏的唯一兜底）。 */
	private _armShownRecheck(show: boolean): void {
		const need = show && !!this._viewId && this._paneVisible;
		if (need && this._shownRecheck === undefined) {
			this._shownRecheck = setInterval(() => this._verifyMainVisible(true), 5_000);
		} else if (!need && this._shownRecheck !== undefined) {
			clearInterval(this._shownRecheck);
			this._shownRecheck = undefined;
		}
	}

	/**
	 * 需要"持续复算"的两种情形，恢复即停：
	 *   ① 该显示却没显示（遮挡事件漏网 / 零宽后无 resize ⇒ 都能自愈）；
	 *   ② 该显示、以为已显示，但**尚未与主进程对过账**（见 `_verifyMainVisible`：主进程可能被单独
	 *      置为隐藏而浏览器侧不知情 ⇒ 不持续复算就会永久卡在 0x0）。
	 */
	private _armHiddenRecheck(show: boolean): void {
		const need = !!this._viewId && this._paneVisible && (!show || !this._isShownConfirmed());
		if (need && this._hiddenRecheck === undefined) {
			this._hiddenRecheck = setInterval(() => this._updateVisibility(), 1_000);
		} else if (!need && this._hiddenRecheck !== undefined) {
			clearInterval(this._hiddenRecheck);
			this._hiddenRecheck = undefined;
		}
	}
}

/**
 * 启动早期（BlockRestore）注册宿主工厂：必须在恢复的聊天标签创建 pane 之前完成。
 * engine=dsh 且总开关打开时接管聊天框内容区；否则返回 undefined，pane 保持 legacy DOM 面板。
 */
export class DshChatHostContribution extends Disposable {
	static readonly ID = 'sessions.dshHarness.chatHost';

	constructor(
		@IDshHarnessService dsh: IDshHarnessService,
		@IConfigurationService config: IConfigurationService,
		@IKeybindingService keybinding: IKeybindingService,
		@ICommandService commands: ICommandService,
		@ILogService log: ILogService,
		@IStorageService storage: IStorageService,
	) {
		super();
		setDshChatHostFactory(ctx => {
			const enabled = config.getValue<boolean>(DshHarnessSettings.Enabled);
			const engine = config.getValue<string>(DshHarnessSettings.ChatEngine);
			if (!enabled || engine !== 'dsh') {
				return undefined;
			}
			return new DshChatBinding(ctx, dsh, keybinding, commands, log, storage);
		});
	}

	override dispose(): void {
		setDshChatHostFactory(undefined);
		super.dispose();
	}
}
