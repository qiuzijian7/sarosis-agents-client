/*---------------------------------------------------------------------------------------------
 *  Session History View — sidebar ViewPane
 *
 *  Displays all Agent Studio chat sessions **grouped by Workspace**（2026-10-12 重构），with:
 *  - 折叠工作区分组头（计数 / 运行中绿点）；组内默认 5 条空闲会话 + 「展开其余」
 *      · 口径与判据全在 `../common/sessionGrouping.ts`（纯函数，有单测），本文件只做 DOM
 *      · **正在运行 / 等待用户**的会话始终显示且不占那 5 条配额
 *  - Agent filter dropdown
 *  - Workspace/search filter（搜索命中时不做截断，否则「搜到的行被折叠掉了」）
 *  - Expandable session items showing user messages (newest first)
 *  - Copy button per message
 *  - Click-to-navigate: jumps to the message in the Agent Studio chat editor
 *
 *  ★ 行首**不放圆形图标**（2026-10-12 用户要求）：agent 圆形头像已移除，会话归属由副行的
 *    agent 名承担；会话内热切换的「人格」用**非圆形**标记表达（见 `PERSONA_MARK`）。
 *--------------------------------------------------------------------------------------------*/

import './media/sessionHistoryView.css';
import * as DOM from '../../../../base/browser/dom.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
// ★ 2026-10-19（A1 第 4 步）：dsh 引擎下新建会话要走 dsh ⇒ 需要"IDE agent → dsh preset"的 id 派生。
import { agentPresetIdOf } from '../../agentStudio/common/chatSessionBackend.js';
// ★ 2026-10-19：dsh 会话要进侧栏（两套数据源合并；见 `common/dshSessionIndex.ts` 文件头）。
//   `optional`：legacy 引擎 / 极早期启动时服务可能还没注册 ⇒ 缺席就退化成"只显示 IDE 会话"，
//   绝不能让整个侧栏注入失败 ✗。
import { IDshHarnessService } from '../../dshHarness/electron-browser/dshHarnessService.js';
import type { IDshSessionSummary } from '../../dshHarness/common/dshSessionIndex.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentChatService, IAgentStudioService, IChatStreamDelta } from '../../../common/agentStudioService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { NativeChatEditorInput } from '../../agentStudio/browser/nativeChatEditorInput.js';
import { NativeChatEditorPane } from '../../agentStudio/browser/nativeChatEditorPane.js';
import { EditorsOrder } from '../../../../workbench/common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { ISelectOptionItem } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { defaultSelectBoxStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { userDataRootFromRoamingHome } from '../../../contrib/agentStudio/common/sarosPaths.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { localize } from '../../../../nls.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { DisposableStore, isDisposable } from '../../../../base/common/lifecycle.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IBridgeService } from '../../agentStudio/browser/bridge/bridgeService.js';
import {
	buildSessionGroups,
	computeGroupWindow,
	ISessionGroup,
	IWorkspaceRef,
	nextExtraShown,
	parseStringArray,
} from '../common/sessionGrouping.js';
import { IPersonaFact, parsePersonaMap, personaGlyphOf, personaLabelOf } from '../common/sessionPersona.js';
// 「清空所有会话」的范围判据（纯函数 ⇒ `common/clearAllPlan.test.ts` 有守卫 ✓）
import { planClearAll } from '../common/clearAllPlan.js';

const $ = DOM.$;

/**
 * 人格标记的落点（2026-10-12）。三种形态都**不是圆形**，等 `doc/session-sideview-workspace-mockup.html`
 * §三的 Q1 拍板后改这一个常量即可：
 *   - `'sub'`   —— 副行文字 `Saros · 人格：架构评审 · 26m`（**当前默认**，最干净、零新增行内元素）
 *   - `'chip'`  —— 标题左侧圆角 chip `[架] 架构评审 标题`
 *   - `'title'` —— 标题右侧圆角 chip `标题 [架] 架构评审 open`
 *
 * ⚠ 类型必须写成联合字面量（不能省略注解）：省略后 TS 会把类型收窄成 `'sub'`，
 *   另两个分支的比较会被判为「无交集」而报错 ✗。
 */
const PERSONA_MARK: 'sub' | 'chip' | 'title' = 'sub';

// ─── Agent color palette (aligned with Task Board agentColors.ts) ──────────
// Deterministic per-agentId color for visual differentiation in the session list.

const AGENT_COLOR_PALETTE = [
	'#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#eab308',
	'#06b6d4', '#a855f7', '#f43f5e', '#84cc16', '#6366f1', '#d946ef',
];

/** djb2 hash → palette index. Same agentId always gets the same color. */
function _getAgentColorIndex(agentId: string): number {
	let hash = 5381;
	for (let i = 0; i < agentId.length; i++) {
		hash = ((hash << 5) + hash) + agentId.charCodeAt(i);
		hash = hash & hash; // force 32-bit
	}
	return Math.abs(hash) % AGENT_COLOR_PALETTE.length;
}

function _getAgentColor(agentId: string): string {
	return AGENT_COLOR_PALETTE[_getAgentColorIndex(agentId)];
}

/**
 * 内联 SVG 小图标（16×16 viewBox + currentColor 填充）。
 *
 * 为什么不用 emoji：`🤖`（agent 徽章）与 `📌`（pin）在窄侧栏会因字体缺字
 * 渲染成**紫色方块**（用户截图实证），且与整体气质不符 ⇒ 2026-09-15 起全部改 SVG。
 */
function _icon(path: string, size = 12): SVGSVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	p.setAttribute('fill', 'currentColor');
	p.setAttribute('d', path);
	svg.appendChild(p);
	return svg;
}

const ICON_PENCIL = 'M11.488 1.65a1.5 1.5 0 0 1 2.122 0l.74.74a1.5 1.5 0 0 1 0 2.122l-1.69 1.69-2.862-2.862l1.69-1.69zM8.92 4.222l2.862 2.862-6.36 6.36-3.39.74a.5.5 0 0 1-.58-.58l.74-3.39 6.728-6.992z';
const ICON_TRASH = 'M6.5 1a.5.5 0 0 0-.5.5V2H3.5a.5.5 0 0 0 0 1H4v10a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 12 13V3h.5a.5.5 0 0 0 0-1H10v-.5a.5.5 0 0 0-.5-.5h-3zM5 3h6v10a.5.5 0 0 1-.5.5h-5A.5.5 0 0 1 5 13V3zm2 2.5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5z';
const ICON_PIN = 'M9.5 1a.5.5 0 0 1 .5.5v1l2.4 1.6a.5.5 0 0 1 .22.42V7a.5.5 0 0 1-.5.5H9.6V12a.5.5 0 0 1-1 0V7.5H4.9a.5.5 0 0 1-.5-.5V4.52a.5.5 0 0 1 .22-.42L7 2.5v-1a.5.5 0 0 1 .5-.5h2z';
/** 链接/绑定图标（feather "link"）：飞书绑定标识与绑定按钮共用。 */
const ICON_LINK = 'M7.775 3.275a.75.75 0 001.06 1.06l1.25-1.25a2 2 0 112.83 2.83l-2.5 2.5a2 2 0 01-2.83 0 .75.75 0 00-1.06 1.06 3.5 3.5 0 004.95 0l2.5-2.5a3.5 3.5 0 00-4.95-4.95l-1.25 1.25zm-4.69 9.64a2 2 0 010-2.83l2.5-2.5a2 2 0 012.83 0 .75.75 0 001.06-1.06 3.5 3.5 0 00-4.95 0l-2.5 2.5a3.5 3.5 0 004.95 4.95l1.25-1.25a.75.75 0 00-1.06-1.06l-1.25 1.25a2 2 0 01-2.83 0z';

interface SessionInfo {
	agentId: string;
	agentName: string;
	/** ★ 2026-09-23：`Agent.icon`（emoji 字符串）—— 人格 chip 的 glyph 用它，缺则用名字首字。 */
	agentIcon?: string;
	sessionId: string;
	sessionName: string;
	messageCount: number;
	updatedAt: number;
	/**
	 * 会话所属工作区（`AgentStudioSession.workspaceId`）。
	 *
	 * ⚠ 会话索引（`AgentSessionMeta`）里**没有**这个字段 ⇒ 只能由 `getSessions()`
	 * 旁路解析一次（见 `_getSessionWorkspaceMap`）。取不到就是 `undefined`
	 * ⇒ 落「未分组」，**不猜**归属。
	 */
	workspaceId?: string;
	/**
	 * 本会话当前生效的**人格**（会话内热切换，dsh 侧投影 key `vssaros-persona`）。
	 *
	 * `personaId` 其实是**另一个 agent 的 id**（见 `dsh-plugins/vssaros-agents/lib/core/persona.js`），
	 * 所以展示名 / 字形可复用 agent 信息。
	 * `undefined` = 该会话没切换过（跟随本 Agent 自带人设）⇒ **不渲染任何人格标记**。
	 *
	 * ⚠ 目前**恒为 undefined**：VsSaros 侧还没有读这条事实的通路（`AgentSessionMeta` /
	 * `AgentStudioSession` 都没有该字段）。通路方案见
	 * `doc/session-sideview-workspace-mockup.html` §六（三条候选，推荐「页面上报 + 落索引」）。
	 * 本文件已经按「有值就渲染」写好，通路接通后无需再改渲染层。
	 */
	personaId?: string;
	personaName?: string;
	/** 人格（= 另一个 agent）的 `Agent.icon`（emoji）—— 人格 chip 的 glyph 用它。 */
	personaIcon?: string;
	/**
	 * ★ 2026-10-19：这条来自 **dsh 侧**（`storages/session_projcache`），不是 IDE 的
	 * `chat-history` 索引。两条来源的 `sessionId` 命名空间不同 ⇒ 打开动作必须分流
	 * （dsh 条目走 `openDshSessionChat`，IDE 条目走 `NativeChatEditorInput`）✗ 混用会打不开。
	 */
	dshSession?: boolean;
}

interface UserMessageInfo {
	id: string;
	content: string;
	timestamp: number;
}

interface SessionData {
	info: SessionInfo;
	messages: UserMessageInfo[];
	chatOpen: boolean;
	pinned: boolean;
}

/**
 * 分组列表的**渲染指令**（见 `_planGroupRender`）。
 *
 * 为什么要有这一层：分组头、「展开其余」与会话行必须按顺序建成一棵树（行要挂进所属分组的
 * body），而渲染是**分批 rAF 让出**的 ⇒ 扁平有序的 op 列表正好，渲染时把 `body` 一个个传下去。
 */
type IRenderOp =
	| { readonly kind: 'group'; readonly group: ISessionGroup<SessionData>; readonly collapsed: boolean }
	| { readonly kind: 'item'; readonly session: SessionData }
	| { readonly kind: 'expand'; readonly group: ISessionGroup<SessionData>; readonly hidden: number }
	| { readonly kind: 'collapse'; readonly group: ISessionGroup<SessionData> };

/**
 * 会话运行指示灯状态（2026-09-15 用户需求）。
 *
 * - `running`  → 绿色闪烁（执行中）
 * - `awaiting` → 黄色闪烁（等待用户交互：clarify 提问 / 工具审批 / 确认框）
 * - `done`     → 白色常亮（执行完毕，用户查看后熄灭）
 * - `error`    → 红色常亮（执行报错）
 *
 * 数据源：`IAgentChatService.onDidStreamDelta` 的全局广播（`phase_change` /
 * `ask_user_start` / `tool_approval_request` / `done` / `error` 等），
 * **不新增 agent 内核状态**，纯 UI 侧推导。
 */
type SessionRunPhase = 'running' | 'awaiting' | 'done' | 'error';

export class SessionHistoryViewPane extends ViewPane {

	private container: HTMLElement | undefined;
	private sessionListEl: HTMLElement | undefined;
	private agentSelect: SelectBox | undefined;
	private searchInput: InputBox | undefined;
	private newSessionPanel: HTMLElement | undefined;
	private newSessionPanelDisposables: DisposableStore | undefined;
	private newSessionState: { agentId: string; name: string; busy: boolean } | undefined;
	private agentSelectContainer: HTMLElement | undefined;
	private searchInputContainer: HTMLElement | undefined;

	/**
	 * 「清空所有会话」的内联危险面板（与「新建会话」面板同层、互斥显示）。
	 *
	 * 为什么是**内联面板**而不是弹窗：116 条这种量级的破坏性操作需要「范围 / 跳过项 / 结果」
	 * 三块信息同时可见，侧栏宽度下弹窗装不下；内联面板与既有 `_renderFilterBar` 的
	 * `new-session` 面板同构 ⇒ 样式与生命周期都能复用（2026-10-19 mockup 稿 A + C）。
	 */
	private clearPanel: HTMLElement | undefined;
	private clearPanelDisposables: DisposableStore | undefined;
	/** 面板上的三个开关（内存态，不持久化 —— 破坏性操作的默认不许被"上次"带偏）。 */
	private _clearOptions = { skipRunning: true, skipPinned: true };
	/** 正在清空（防重入：面板按钮与右键菜单都指向同一条执行路径）。 */
	private _clearBusy = false;

	private allSessions: SessionData[] = [];
	private filteredSessions: SessionData[] = [];
	private currentAgentFilter = '';
	private currentSearchTerm = '';
	private _reloadTimer: any = undefined;

	/**
	 * 抖动修复（2026-09-15）：后台刷新期间暂存列表滚动位置。
	 * 列表是 `clearNode` + 全量重建（无 keyed diff），重建会把 `scrollTop` 归零 ✗
	 * —— 发消息触发后台刷新时，用户若已滚到列表中段会被「弹回顶部」，配合
	 * 清空/回填的高度突变即表现为抖动。重建前后各存/取一次即可消除 ✓。
	 */
	private _pendingScrollTop: number | undefined = undefined;

	// ─── 工作区分组状态（2026-10-12 重构）───────────────────────────────────────
	/** `getWorkspaces()` 的原始顺序 —— 分组顺序就是它（空工作区不输出，见 sessionGrouping）。 */
	private _workspaces: readonly IWorkspaceRef[] = [];

	/**
	 * dsh 侧会话 id 集合（每次 `_loadSessions` 刷新）。
	 * 轮询靠"集合变了没有"判断要不要重载 —— 直接比数组内容会让每轮都重载（抖动 ✗）。
	 */
	private _dshSessionIds = new Set<string>();
	/** dsh 会话轮询句柄（只看可见的侧栏：藏起来还每 5s 读盘是纯浪费 ✗）。 */
	private _dshPollTimer: ReturnType<typeof setInterval> | undefined;
	/**
	 * `sessionId → workspaceId` 的缓存。
	 *
	 * 为什么要缓存：`getSessions()` 是**整文件读** `~/.vssaros/sessions.json`，而本面板的
	 * 重载是高频路径（发消息 / 切 agent / 切工作区都会触发静默重载）⇒ 每次重读是纯浪费 ✗。
	 * 由 `onDidChangeSessions` / `onDidChangeWorkspace` 失效（同 `_agentInfoCache` 的做法）。
	 */
	private _sessionWorkspaceCache: ReadonlyMap<string, string> | undefined;
	/** 折叠的分组 key（`workspaceId`；未分组用 `UNGROUPED_GROUP_KEY`），持久化。 */
	private readonly _collapsedGroups = new Set<string>();
	/**
	 * 每组「展开其余」的**额外**显示条数（内存态，不持久化）。
	 * 与 dsh desktop 一致：关闭再打开工作区即回到折叠投影（那里同样只记在浏览器内存）。
	 */
	private readonly _groupExtraShown = new Map<string, number>();
	private static readonly COLLAPSED_GROUPS_KEY = 'sessionHistoryView.collapsedWorkspaces';
	/**
	 * 人格事实的存储键：`{"agentId::sessionId":{"id":"<personaId>","name":"<显示名>"}}`。
	 * 由「会话内热切换人格」的通路写入（**尚未接通**，见 `_getPersonaMap()`）。
	 */
	private static readonly PERSONA_KEY = 'sessionHistoryView.personaBySession';

	/** Pinned session keys (agentId\u0000sessionId), persisted across reloads. */
	private readonly pinnedSessions = new Set<string>();
	/** Manual session ordering (agentId\u0000sessionId, display order), persisted. */
	private sessionOrder: string[] = [];
	private static readonly PINNED_KEY = 'sessionHistoryView.pinnedSessions';
	private static readonly ORDER_KEY = 'sessionHistoryView.sessionOrder';
	/** Pending single-click expand timer — cancelled on double-click so the open-chat action wins. */
	private _pendingExpandTimer: any = undefined;

	/**
	 * 运行指示灯：`sessionKey` → 阶段（**内存态**，重启后重置 —— 它本来就是实时语义）。
	 * 由 `onDidStreamDelta` 驱动，就地更新 DOM（不重建列表，避免抖动）。
	 */
	private readonly _runPhases = new Map<string, SessionRunPhase>();

	/**
	 * 已查看过的会话 key（持久化）：`done` 态且命中此集合 ⇒ 白点熄灭。
	 * 只表达「用户看过这个完成态」，与 `updatedAt` 无关。
	 */
	private readonly _readKeys = new Set<string>();
	private static readonly READ_KEY = 'sessionHistoryView.readSessions';
	/** 已读集合上限（超出淘汰最旧的），避免 storage 无限膨胀。 */
	private static readonly MAX_READ_KEYS = 500;

	/**
	 * 多选：当前被选中的会话 key（`agentId::sessionId`）。
	 *
	 * 语义（2026-09-15 用户需求：item 支持多选 + delete 按钮可删除 session）：
	 * - 普通左键 = 单选（并保留原有的展开/折叠行为）；
	 * - Ctrl/Cmd + 左键 = 切换该项选中态（不触发展开）；
	 * - Shift + 左键 = 从锚点到该项的区间选中（不触发展开）；
	 * - 每项的删除按钮：若该项属于「多选集合」且集合 > 1，则删除整个选中集合，
	 *   否则只删除该项（确认框会写明数量）。
	 */
	private readonly selectedKeys = new Set<string>();
	/** Shift 区间选择的锚点 key。 */
	private _selectionAnchorKey: string | undefined;

	/**
	 * 打开会话聊天时的目标 group 解析器。默认 `undefined` ⇒ 走主窗口 Agent 编辑器区；
	 * 独立聊天窗口里的那份会话侧栏会注入一个解析器，让会话在本窗口内打开。
	 */
	private _openGroupResolver: (() => IEditorGroup | undefined) | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ILogService private readonly logService: ILogService,
		@IAgentChatService private readonly chatService: IAgentChatService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IStorageService private readonly storageService: IStorageService,
		@IDialogService private readonly dialogService: IDialogService,
		@IBridgeService private readonly bridgeService: IBridgeService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@IDshHarnessService private readonly dshHarness: IDshHarnessService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._loadPersistedState();
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		this.container = DOM.append(parent, $('.session-history-container'));

		// Filter bar
		this._renderFilterBar(this.container);

		// Session list
		this.sessionListEl = DOM.append(this.container, $('.session-history-list'));

		// 点击列表空白处清空多选
		this._register(DOM.addDisposableListener(this.sessionListEl, DOM.EventType.MOUSE_DOWN, (e) => {
			const target = e.target as HTMLElement | null;
			if (target?.closest('.session-history-item')) { return; }
			this._clearSelection();
		}));

		// 稿 C：列表**空白处**右键 ⇒ 「清空所有会话…」（会话条目上的右键仍是既有那条菜单 ✗ 不抢）
		this._register(DOM.addDisposableListener(this.sessionListEl, DOM.EventType.CONTEXT_MENU, (e) => {
			const target = e.target as HTMLElement | null;
			if (target?.closest('.session-history-item')) { return; }
			e.preventDefault();
			e.stopPropagation();
			this._showMoreMenu(e as MouseEvent);
		}));

		// Load sessions
		this._loadSessions();

		// ★ 2026-10-19：改名的**页面回执** —— 有 `error` 就如实说出来，没有才刷新列表。
		//   （`renameDshSession` 返回 true 只代表"请求已推给页面"，成败在回执里 ⇒ 不许提前报成功 ✗）
		this._register(this.dshHarness.onDidDshSessionRenamed(r => {
			if (r.error) {
				this.notificationService.warn(`dsh 会话改名失败：${r.error}`);
				return;
			}
			this.logService.info(`[SessionHistoryView] dsh session ${r.sessionId} renamed to "${r.title ?? ''}"（页面回执）`);
			this._scheduleSilentReload();
		}));

		// ★ 2026-10-19：dsh 会话**实时**同步（5s 轮询，只在侧栏可见时跑；见 `_pollDshSessions`）。
		//   dsh 侧没有任何事件通道能推到 IDE 渲染进程（Host 是另一个进程），轮询是最小可靠形态。
		this._dshPollTimer = setInterval(() => void this._pollDshSessions(), 5000);
		this._register({ dispose: () => { if (this._dshPollTimer) { clearInterval(this._dshPollTimer); this._dshPollTimer = undefined; } } });

		// Sync open/closed state when the active editor changes (agent switch, session switch, etc.)
		this._register(this.editorService.onDidActiveEditorChange(() => {
			this._syncOpenState();
		}));

		// 运行指示灯（2026-09-15 用户需求）：订阅全局流式 delta，**就地**更新状态点。
		// ⚠ 必须就地更新：本列表是 clearNode 全量重建（无 keyed diff），若每个 delta
		// 都走一次 `_loadSessions`，长会话期间列表会持续抖动（见 `_pendingScrollTop` 注释）。
		this._register(this.chatService.onDidStreamDelta(e => {
			this._onStreamDelta(e.agentId, e.sessionId, e.delta);
		}));

		// Reload sessions when sessions change in any chat editor (debounced)
		this._register(this.chatService.onDidChangeAgentSessions(() => {
			this.logService.info('[SessionHistoryView] onDidChangeAgentSessions: reloading sessions');
			this._scheduleSilentReload();
		}));

		// ★ 2026-10-12（人格通路）：**人格事实的写入方在别的进程里** —— dsh 聊天的宿主经页面桥收到上报后，
		// 按 (agentId, sessionId) 写进 PROFILE 表（`sessionPersona.writePersonaFact`）。
		// 那条路径**不会** fire `onDidChangeAgentSessions`（切人格既不新建也不改会话）
		// ⇒ 不订阅存储变更，用户切完人格回头看侧栏就是"没有标记"，要等下一次静默重载才出现 ✗。
		// `onDidChangeValue(scope, key, disposable)` 的第三个参数是它要求的 disposable 容器（key 过滤也在这一层做）。
		const personaChangeScope = this._register(new DisposableStore());
		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, SessionHistoryViewPane.PERSONA_KEY, personaChangeScope)(() => this._scheduleSilentReload()));

		// ★ 2026-09-21（用户需求）：**切换 agent / 工作区 / provider 后 item 要同步更新**。
		// ⚠ 这条路径**不会** fire `onDidChangeAgentSessions`（它只在会话 CRUD / 消息数变化时 fire）
		// ⇒ 必须显式订阅，否则切了 agent/工作区列表还停在上一套数据上。
		// ★ 2026-10-12：工作区变化 ⇒ 分组的**名字 / 路径 / 成员**都可能变 ⇒ 让工作区清单缓存失效。
		this._register(this.agentStudioService.onDidChangeActiveWorkspace(() => {
			this._workspaces = [];
			this._reloadForContextChange('active workspace changed');
		}));
		this._register(this.agentStudioService.onDidChangeWorkspace(() => {
			this._workspaces = [];
			this._reloadForContextChange('workspace list changed');
		}));
		// ★ 2026-10-12：会话注册表变化（新建 / 删除会话、workspaceId 被改）⇒ 归属缓存失效。
		// ⚠ 这条与 `chatService.onDidChangeAgentSessions` **不是**同一条：后者只在会话 CRUD /
		//    消息数变化时 fire，**不覆盖** `AgentStudioService.createSession` 那一路 ✗。
		this._register(this.agentStudioService.onDidChangeSessions(() => {
			this._sessionWorkspaceCache = undefined;
			this._reloadForContextChange('session registry changed');
		}));
		this._register(this.agentStudioService.onDidChangeAgents(() => {
			// ★ 2026-09-23（用户需求）：显示名 / 头像可能被改了 ⇒ 必须让 `id → {name,avatar,icon}`
			// 缓存失效，否则 item 会一直显示旧名字、旧头像（缓存见 `_getAgentInfoMap`）。
			// `updateAgent()`（Agent 设置页改名 / 换头像都走它）末尾**一定**会 fire 本事件 ⇒
			// 这条就是「改头像后 session item 同步更新」的落点。
			this._agentInfoCache = undefined;
			this._reloadForContextChange('agents changed');
		}));
		this._register(this.agentStudioService.onDidSelectAgent(() => {
			this._reloadForContextChange('active agent changed');
		}));

		// 飞书绑定状态：初始拉取 + 订阅绑定变更即时刷新（badge / 按钮态）
		this._refreshFeishuBindings();
		try {
			this._register(this.bridgeService.getEngine().onDidChangeBindings(() => {
				this._refreshFeishuBindings();
				this._scheduleSilentReload();
			}));
		} catch { /* 引擎未就绪：绑定功能静默降级 */ }
	}

	/** sessionId → 绑定的飞书 chat_id（渲染 badge/按钮态用）。 */
	private readonly _feishuBoundBySession = new Map<string, string>();
	/** 渠道默认会话 id（非精确绑定，badge 显示默认态）。 */
	private _feishuDefaultSessionId: string | null = null;

	/** 从 bridge 引擎重建「会话→飞书 chat_id」反查表 + 默认会话。 */
	private _refreshFeishuBindings(): void {
		this._feishuBoundBySession.clear();
		try {
			const engine = this.bridgeService.getEngine();
			for (const b of engine.listSessionBindings('feishu')) {
				this._feishuBoundBySession.set(b.agentSessionId, b.conversationId);
			}
			this._feishuDefaultSessionId = engine.getChannelDefaultSession('feishu')?.agentSessionId ?? null;
		} catch { /* 引擎未就绪：保持空表 */ }
	}

	/**
	 * 会话 item 的飞书绑定交互：输入 chat_id 绑定/换绑；已有绑定时清空输入即解绑。
	 * 完成后经 onDidChangeBindings 事件全量刷新（badge/按钮态/header 标识）。
	 */
	private async _promptFeishuBinding(sessionData: SessionData): Promise<void> {
		const { info } = sessionData;
		const current = this._feishuBoundBySession.get(info.sessionId);
		const input = await this.quickInputService.input({
			title: current ? '切换飞书绑定' : '绑定飞书会话',
			prompt: current
				? `当前绑定：${current}。输入新的 chat_id 换绑；清空并回车 = 解绑`
				: '输入飞书群聊/私聊的 chat_id（群设置底部「会话 ID」字段），该会话将接收其消息',
			value: current ?? '',
			placeHolder: 'oc_xxxxxxxxxxxxxxxx',
		});
		if (input === undefined) { return; } // Esc 取消
		const chatId = input.trim();
		try {
			const engine = this.bridgeService.getEngine();
			if (!chatId) {
				if (current) {
					engine.unbindConversationSession('feishu', current);
					this.notificationService.info(`已解除飞书会话 ${current} 的绑定`);
				}
				return;
			}
			engine.bindConversationToSession('feishu', chatId, info.agentId, info.sessionId);
			this.notificationService.info(`已将飞书会话 ${chatId} 绑定到「${info.sessionName || info.sessionId}」`);
		} catch (err) {
			this.logService.warn('[SessionHistoryView] feishu bind failed:', err);
			this.notificationService.error(`绑定操作失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * 防抖 + silent 刷新（保留滚动位置）。
	 *
	 * 抖动修复（2026-09-15）：`silent` 表示这是一次**后台刷新**而非首次加载。
	 * 若照常插入 "Loading sessions..." 占位行，列表会被清成单行 → 高度崩塌 → 重建
	 * → 高度回弹，表现为列表抖动 ⇒ 后台刷新一律 silent，并在重建前暂存 `scrollTop`
	 * 供重建后还原（本类是 `clearNode` 全量重建，无 keyed diff）。
	 */
	private _scheduleSilentReload(): void {
		if (this._reloadTimer) { clearTimeout(this._reloadTimer); }
		this._reloadTimer = setTimeout(() => {
			this._reloadTimer = undefined;
			if (this.sessionListEl) {
				this._pendingScrollTop = this.sessionListEl.scrollTop;
			}
			this._loadSessions({ silent: true });
		}, 300);
	}

	/**
	 * agent / 工作区这类**上下文**变化后的刷新：走一次防抖 silent 重载。
	 *
	 * `_discoverAgentIds()` 每次都重新扫目录（早期版本的 30s TTL 缓存已被移除），
	 * 所以这里只需触发重载 —— 重载会重新发现 agent 并重新读取每个 agent 的会话索引，
	 * item 上的 agent 名 / 归属 / 时间随之同步。
	 */
	private _reloadForContextChange(reason: string): void {
		this.logService.info(`[SessionHistoryView] context changed (${reason}) → reload sessions`);
		this._scheduleSilentReload();
	}

	private _renderFilterBar(parent: HTMLElement): void {
		const filterBar = DOM.append(parent, $('.session-history-filter-bar'));

		// Row 1: search (using VS Code native InputBox)
		const searchRow = DOM.append(filterBar, $('.session-history-filter-row'));
		this.searchInputContainer = DOM.append(searchRow, $('.session-history-filter-search-wrapper'));
		this.searchInput = this._register(new InputBox(this.searchInputContainer, this.contextViewService, {
			placeholder: 'Search messages...',
			ariaLabel: 'Search messages',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this._register(this.searchInput.onDidChange((value) => {
			this.currentSearchTerm = value.toLowerCase();
			this._applyFilters();
		}));
		// Enter 提交搜索：`onDidChange` 只覆盖「输入即筛选」，输入法组合态（IME）
		// 或粘贴后立即回车时值可能尚未同步到 `currentSearchTerm`，此处以当前
		// `inputElement.value` 为准强制重跑一次筛选，并交出焦点让列表刷新可见。
		// ⚠ 必须用 `addDisposableListener`（原生 KeyboardEvent）—— 与下方重命名输入框
		// 同理：`addStandardDisposableListener` 包装出的 `StandardKeyboardEvent` 没有
		// `key` 属性，`e.key` 恒为 undefined 会导致 Enter 判定失效。
		const searchInput = this.searchInput;
		this._register(DOM.addDisposableListener(searchInput.inputElement, DOM.EventType.KEY_DOWN, (e) => {
			if ((e as KeyboardEvent).key !== 'Enter') {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this.currentSearchTerm = searchInput.value.toLowerCase();
			this._applyFilters();
			searchInput.inputElement.blur();
		}));

		// Row 2: agent filter (using VS Code native SelectBox)
		const filterRow = DOM.append(filterBar, $('.session-history-filter-row'));
		this.agentSelectContainer = DOM.append(filterRow, $('.session-history-filter-select-container'));
		this.agentSelect = this._register(new SelectBox(
			[{ text: '🤖 All Agents' }],
			0,
			this.contextViewService,
			defaultSelectBoxStyles,
			{ useCustomDrawn: true },
		));
		this.agentSelect.render(this.agentSelectContainer);
		// Maintain a parallel agentId list because ISelectOptionItem only carries `text`
		this._agentOptionIds = [''];
		this._register(this.agentSelect.onDidSelect((selected) => {
			const idx = typeof selected.index === 'number' ? selected.index : 0;
			this.currentAgentFilter = this._agentOptionIds[idx] ?? '';
			this._applyFilters();
		}));

		// Row 3: "New session" toggle button + 右侧「更多」（＝「清空所有会话…」的入口，稿 A）
		const newRow = DOM.append(filterBar, $('div.session-history-new-row'));
		const newBtn = DOM.append(newRow, $<HTMLButtonElement>('button.session-history-new-btn'));
		newBtn.title = localize('newSession', "New session");
		newBtn.textContent = `+ ${localize('newSession', "New session")}`;
		this._register(DOM.addDisposableListener(newBtn, DOM.EventType.CLICK, () => {
			void this._toggleNewSessionPanel();
		}));
		const moreBtn = DOM.append(newRow, $<HTMLButtonElement>('button.session-history-more-btn'));
		moreBtn.title = localize('sessionHistory.moreActions', "More actions...");
		moreBtn.textContent = '···';
		moreBtn.setAttribute('aria-label', localize('sessionHistory.moreActions', "More actions..."));
		this._register(DOM.addDisposableListener(moreBtn, DOM.EventType.CLICK, (e) => {
			this._showMoreMenu(e as MouseEvent);
		}));

		this.newSessionPanel = DOM.append(filterBar, $('.session-history-new-panel'));
		this.newSessionPanel.style.display = 'none';
		// 「清空所有会话」的内联危险面板（稿 A / 稿 C 共用同一块）
		this.clearPanel = DOM.append(filterBar, $('div.session-history-clear-panel'));
		this.clearPanel.style.display = 'none';
	}

	private _agentOptionIds: string[] = [''];

	/**
	 * Populate the agent filter dropdown with discovered agent IDs.
	 * Called from _loadSessions after agent discovery.
	 */
	private _updateAgentFilterOptions(agentIds: string[]): void {
		if (!this.agentSelect) { return; }
		const options: ISelectOptionItem[] = [
			{ text: '🤖 All Agents' },
			...agentIds.map(id => ({ text: `🤖 ${id}` })),
		];
		this._agentOptionIds = ['', ...agentIds];

		// Preserve current selection if it's still in the list
		const prevId = this.currentAgentFilter;
		const prevIndex = this._agentOptionIds.indexOf(prevId);
		const selectedIndex = prevIndex >= 0 ? prevIndex : 0;

		this.agentSelect.setOptions(options, selectedIndex);
	}

	/**
	 * dsh 会话摘要 → 侧栏条目。
	 *
	 * 分组归属：**只按 cwd 与工作区主根相等**判断（大小写/分隔符归一）。
	 * 拿不到就 `undefined`（落「未分组」）—— dsh 的 cwd 完全可能不在当前 IDE 工作区里，
	 * 那是**真事实**，不能硬塞进某个组 ✗。
	 */
	private _dshSessionData(s: IDshSessionSummary): SessionData {
		const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
		const ws = this._workspaces.find(w => !!w.path && norm(w.path) === norm(s.cwd));
		return {
			info: {
				// 伪 agentId：dsh 会话不属于任何 IDE agent（`agentName` 用它的 preset 显示）
				agentId: 'dsh',
				agentName: s.agentPreset || 'dsh',
				sessionId: s.id,
				// 没标题就显示 id（**不编**"新对话"——那会让用户以为会话有名字）
				sessionName: s.title || s.id,
				messageCount: s.turns ?? 0,
				updatedAt: s.updatedAt,
				...(ws ? { workspaceId: ws.id } : {}),
				dshSession: true,
			},
			messages: [],
			// 消息历史在 dsh 侧（zstd / 投影），**不走** IDE 的 `getMessages(agentId, sessionId)` —— 那条会空手而归
			_messagesLoaded: true,
			chatOpen: false,
			pinned: false,
		} as SessionData;
	}

	/**
	 * 轮询 dsh 会话（5s）：只有"id 集合真的变了"才静默重载。
	 *
	 * 为什么用轮询而不是 fs.watch：projcache 是 dsh 自己按事件落盘的，一个会话在对话期间会**反复写**
	 * （每轮都变 mtime）⇒ watch 会把"正在说话"变成"列表每 5s 重建一次"（抖动 ✗）；
	 * 而侧栏关心的是"有没有新会话 / 有没有会话消失"，比 id 集合最省。
	 */
	private async _pollDshSessions(): Promise<void> {
		if (!this.dshHarness || !this.isVisible()) { return; }
		try {
			const list = await this.dshHarness.listDshSessions();
			const next = new Set(list.map(s => s.id));
			let changed = next.size !== this._dshSessionIds.size;
			if (!changed) {
				for (const id of next) {
					if (!this._dshSessionIds.has(id)) { changed = true; break; }
				}
			}
			if (changed) {
				this.logService.info(`[SessionHistoryView] dsh session set changed (${this._dshSessionIds.size} → ${next.size}) ⇒ reload`);
				this._scheduleSilentReload();
			}
		} catch { /* 读不到就下一轮再来（不影响 IDE 会话） */ }
	}

	private async _loadSessions(options: { silent?: boolean } = {}): Promise<void> {
		try {
			// 抖动修复（2026-09-15）：`silent` 表示这是一次**后台刷新**（发消息/改名等
			// messageCount 变化触发的 onDidChangeAgentSessions）而非首次加载。后台刷新
			// 若照常插入 "Loading sessions..." 占位行，列表会在每次发消息时被清空成
			// 一个 40px 的单行 → 高度崩塌 → 重建 → 高度回弹，表现为「抖动」✗。
			// 首次加载（renderBody）仍显示占位 ✓。
			const isBackgroundRefresh = options.silent === true && !!this.sessionListEl?.firstChild;
			if (this.sessionListEl && !isBackgroundRefresh) {
				DOM.clearNode(this.sessionListEl);
				const loading = DOM.append(this.sessionListEl, $('.session-history-empty'));
				DOM.append(loading, $('.session-history-empty-text')).textContent = 'Loading sessions...';
			}

			// Discover agent IDs by scanning the agents data directory.
			const agentIds = await this._discoverAgentIds();
			this.logService.info(`[SessionHistoryView] _loadSessions: discovered ${agentIds.length} agent IDs: ${agentIds.join(', ')}`);

			// Populate agent filter dropdown
			this._updateAgentFilterOptions(agentIds);

			const sessionDataList: SessionData[] = [];
			let totalCount = 0;

			// ★ 2026-09-23（用户需求）：item 要显示 agent 名称 —— `listAgentSessions()`
			// 只返回会话索引、不含 agent 显示信息 ⇒ 这里取一次 `id → {name,icon}` 映射
			// （带缓存，见 `_getAgentInfoMap`）。
			const agentInfos = await this._getAgentInfoMap();

			// ★ 2026-10-12：分组所需的工作区归属 + 人格事实（两者都带缓存，见字段注释）。
			// ⚠ 都是**一次读取**，绝不能放进下面的会话循环（`getSessions()` 是整文件读 ✗）。
			await this._ensureWorkspaces();
			const sessionWorkspaceIds = await this._getSessionWorkspaceMap();
			const personaBySession = this._getPersonaMap();

			// Load only session index (fast, no history) to avoid blocking the UI
			// when there are hundreds of sessions. History is lazy-loaded on expand.
			for (const agentId of agentIds) {
				try {
					const sessions = await this.chatService.listAgentSessions(agentId);
					this.logService.info(`[SessionHistoryView] agent ${agentId} has ${sessions.length} sessions`);
					for (const session of sessions) {
						const hasOpenChat = this._findOpenEditorForSession(agentId, session.id) !== null;
						// ★ 2026-10-12：人格事实（另一个人格 agent 的 id/名/icon）——
						// 与所属 agent 分开取，别把两者的 icon 混用 ✗。
						const persona = personaBySession.get(this._sessionKey(agentId, session.id));
						sessionDataList.push({
							info: {
								agentId,
								// 显示名优先，查不到（agent 定义缺失 / 别处手写的目录）回退到 id
								agentName: agentInfos.get(agentId)?.name ?? agentId,
								// ★ emoji（`Agent.icon`）—— 人格 chip 的 glyph 用它（见 `PERSONA_MARK`）
								agentIcon: agentInfos.get(agentId)?.icon,
								sessionId: session.id,
								sessionName: session.name,
								messageCount: session.messageCount,
								updatedAt: typeof session.updatedAt === 'string'
									? new Date(session.updatedAt).getTime()
									: Date.now(),
								// ★ 2026-10-12：工作区归属 + 人格（缺省 ⇒ 落「未分组」/ 不显示人格标记）
								// ★ 2026-10-13：**会话索引里的归属优先**（`AgentSessionMeta.workspaceId`，由
								// `agentChatService.createAgentSession` 在创建时盖章 —— 那是聊天创建会话**唯一**的
								// 写入点），注册表（`_getSessionWorkspaceMap`）只作兜底：老会话在索引里没有该字段，
								// 而注册表在真机上常常**整份不存在**（2026-10-13 盘证）⇒ 两者都取不到就是 undefined，
								// 落「未分组」，**不猜**归属。
								workspaceId: session.workspaceId ?? sessionWorkspaceIds.get(session.id),
								personaId: persona?.id,
								personaName: persona?.name,
								personaIcon: persona?.id ? agentInfos.get(persona.id)?.icon : undefined,
							},
							messages: [],           // lazy-loaded on expand
							_messagesLoaded: false,  // tracks whether history was fetched
							chatOpen: hasOpenChat,
							pinned: this.pinnedSessions.has(this._sessionKey(agentId, session.id)),
						} as SessionData);
						totalCount++;
					}
				} catch (err) {
					this.logService.warn(`[SessionHistoryView] Failed to list sessions for agent ${agentId}:`, err);
				}
			}

			// ── ★ 2026-10-19：把 **dsh 侧会话**并进来 ────────────────────────────────
			// 用户报「新增的聊天框会话，在左侧会话历史中，没有实时同步更新」。真因是**两套数据源**：
			// 上面这段读的是 IDE 自己的 `chat-history/<agent>/sessions.json`（只有 IDE 自己
			// `createAgentSession()` 时才写），而 dsh 引擎下聊天在 dsh 侧开会话 ⇒ 侧栏永远是空的
			// （截图 "No sessions found"）。这里把 dsh 侧的 projcache 摘要追加进来。
			// ⚠ 不覆盖、不去重：两套 id 命名空间不同（`sess_xxx` vs `vssaros-chat-…`），去重会误杀。
			if (this.dshHarness) {
				try {
					const dshList = await this.dshHarness.listDshSessions();
					this._dshSessionIds = new Set(dshList.map(s => s.id));
					for (const s of dshList) {
						sessionDataList.push(this._dshSessionData(s));
						totalCount++;
					}
					this.logService.info(`[SessionHistoryView] _loadSessions: +${dshList.length} dsh session(s)`);
				} catch (err) {
					// 侧栏不能因为"补充数据源"整块失败（dsh 没起 / 目录没权限）
					this.logService.warn('[SessionHistoryView] listDshSessions failed', err);
					this._dshSessionIds = new Set();
				}
			}

			this.logService.info(`[SessionHistoryView] _loadSessions: total ${totalCount} sessions (history lazy)`);
			sessionDataList.sort((a, b) => this._compareSessions(a, b));
			this.allSessions = sessionDataList;

			// 清掉已消失会话的选中态（删除/归档/换工作区后可能残留）
			const aliveKeys = new Set(sessionDataList.map(s => this._sessionKey(s.info.agentId, s.info.sessionId)));
			for (const key of [...this.selectedKeys]) {
				if (!aliveKeys.has(key)) { this.selectedKeys.delete(key); }
			}
			if (this._selectionAnchorKey && !aliveKeys.has(this._selectionAnchorKey)) {
				this._selectionAnchorKey = undefined;
			}

			// Batch-render to avoid blocking the UI with large session lists
			await this._applyFiltersIncremental({ silent: options.silent });
		} catch (err) {
			this.logService.error('[SessionHistoryView] Failed to load sessions:', err);
			if (this.sessionListEl) {
				DOM.clearNode(this.sessionListEl);
				const errorEl = DOM.append(this.sessionListEl, $('.session-history-empty'));
				DOM.append(errorEl, $('.session-history-empty-text')).textContent = 'Failed to load sessions.';
			}
		}
	}

	/**
	 * Apply filters and render the **grouped** list incrementally to avoid
	 * blocking the UI when there are hundreds of sessions.
	 */
	private async _applyFiltersIncremental(options: { silent?: boolean } = {}): Promise<void> {
		const agentFilter = this.currentAgentFilter;
		const searchTerm = this.currentSearchTerm;

		this.filteredSessions = this.allSessions.filter(s => {
			if (agentFilter && s.info.agentId !== agentFilter) { return false; }
			if (searchTerm) {
				const inTitle = s.info.sessionName.toLowerCase().includes(searchTerm);
				if (!inTitle) { return false; }
			}
			return true;
		});

		if (!this.sessionListEl) { return; }

		// 抖动修复（2026-09-15）：后台刷新（发消息等）走**同步整帧重建**并还原滚动位置。
		// 原路径在「清空 → 空容器 → 逐帧 rAF 回填」之间会暴露至少一帧的空列表 +
		// 高度突变，表现为抖动 ✗。后台刷新本就发生在已有内容之上，无需分批让出。
		// 分批让出仅保留给**用户显式操作**（首载/改筛选/搜索）——那些场景列表内容
		// 整体换血，分批可避免长任务卡顿 ✓。
		if (options.silent) {
			const previousScrollTop = this._pendingScrollTop ?? this.sessionListEl.scrollTop;
			this._pendingScrollTop = undefined;
			DOM.clearNode(this.sessionListEl);
			this._renderAllSessionsSync(this.sessionListEl);
			// 同帧内同步还原，浏览器不会绘制中间态 ⇒ 视觉上无跳动 ✓。
			this.sessionListEl.scrollTop = previousScrollTop;
			return;
		}

		DOM.clearNode(this.sessionListEl);

		const plan = this._planGroupRender();
		if (plan.length === 0) {
			this._renderEmptyState(this.sessionListEl);
			return;
		}

		// Render in batches: 20 **ops** per frame, yielding to the UI between batches.
		// ⚠ 计数单位是 op（含分组头 / 「展开其余」），不是会话条数 —— 它们不占会话配额。
		const BATCH_SIZE = 20;
		let body: HTMLElement = this.sessionListEl;
		for (let i = 0; i < plan.length; i += BATCH_SIZE) {
			const chunk = plan.slice(i, i + BATCH_SIZE);
			for (const op of chunk) {
				body = this._renderGroupOp(body, op);
			}
			// Yield to the UI so the user can scroll/interact during rendering
			if (i + BATCH_SIZE < plan.length) {
				await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			}
		}
	}

	/**
	 * 同步渲染全部分组（含空态）—— 供后台刷新 / 折叠 / 「展开其余」走单帧重建使用。
	 * 与 `_applyFiltersIncremental` 的非静默分支共用同一套渲染逻辑。
	 */
	private _renderAllSessionsSync(container: HTMLElement): void {
		const plan = this._planGroupRender();
		if (plan.length === 0) {
			this._renderEmptyState(container);
			return;
		}
		let body: HTMLElement = container;
		for (const op of plan) {
			body = this._renderGroupOp(body, op);
		}
	}

	private _renderEmptyState(container: HTMLElement): void {
		const empty = DOM.append(container, $('.session-history-empty'));
		DOM.append(empty, $('.session-history-empty-icon')).textContent = '💬';
		DOM.append(empty, $('.session-history-empty-text')).textContent = 'No sessions found';
	}

	// ─── 工作区分组的渲染（2026-10-12）────────────────────────────────────────

	/**
	 * 算出这一帧要渲染的**有序指令列表**（分组头 → 组内可见条目 → 展开/收起）。
	 *
	 * 判据全部来自纯模块 `sessionGrouping`（有单测），本函数只做装配 —— 也就是说
	 * 「哪些会话可见」这件事在这里**不可被改写**（要改口径就去改纯函数 + 它的测试）。
	 */
	private _planGroupRender(): IRenderOp[] {
		const groups = buildSessionGroups(
			this.filteredSessions,
			this._workspaces,
			s => s.info.workspaceId,
			// 本模块不引入 nls 依赖（它要被单测直接 import）⇒ 文案由调用方给。
			{ ungroupedTitle: localize('sessionHistory.ungrouped', "未分组") },
		);
		// 搜索 / agent 过滤命中时**不做截断**：否则「刚搜到的那条被 5 条配额折叠掉了」✗。
		const searching = !!this.currentSearchTerm;

		const plan: IRenderOp[] = [];
		for (const group of groups) {
			const collapsed = this._collapsedGroups.has(group.key);
			const window = computeGroupWindow(
				group.sessions,
				this._groupExtraShown.get(group.key) ?? 0,
				s => this._isActiveSession(s),
				{ unlimited: searching },
			);
			plan.push({ kind: 'group', group, collapsed });
			if (collapsed) { continue; }
			for (const session of window.visible) { plan.push({ kind: 'item', session }); }
			if (window.canExpand) { plan.push({ kind: 'expand', group, hidden: window.hiddenIdle }); }
			else if (window.canCollapse) { plan.push({ kind: 'collapse', group }); }
		}
		return plan;
	}

	/** 执行一条渲染指令；返回「后续条目应挂到哪个容器」。 */
	private _renderGroupOp(body: HTMLElement, op: IRenderOp): HTMLElement {
		switch (op.kind) {
			case 'group':
				return this._renderGroupShell(body, op.group, op.collapsed);
			case 'item': {
				const item = DOM.append(body, $('.session-history-item'));
				this._renderSessionItem(item, op.session);
				return body;
			}
			case 'expand':
				this._renderGroupMoreRow(body, op.group, localize('sessionHistory.expandMore', "展开其余 {0} 条", op.hidden), () => this._expandGroup(op.group.key));
				return body;
			case 'collapse':
				this._renderGroupMoreRow(body, op.group, localize('sessionHistory.collapseGroup', "收起"), () => this._collapseGroup(op.group.key));
				return body;
		}
	}

	/** 分组壳（组头 + body）；返回 body 供后续条目挂载。 */
	private _renderGroupShell(container: HTMLElement, group: ISessionGroup<SessionData>, collapsed: boolean): HTMLElement {
		const groupEl = DOM.append(container, $('.session-history-group'));
		groupEl.setAttribute('data-workspace-key', group.key);
		if (group.missing) { groupEl.classList.add('missing'); }
		if (group.ungrouped) { groupEl.classList.add('ungrouped'); }
		if (collapsed) { groupEl.classList.add('collapsed'); }

		const header = DOM.append(groupEl, $('.session-history-group-header'));
		header.title = group.path || group.title;
		DOM.append(header, $('.session-history-group-chevron')).textContent = collapsed ? '▶' : '▼';
		// 图标是**几何符号**而不是圆形头像：未分组 ◇ / 已删除工作区 ⚠ / 正常 ▣。
		DOM.append(header, $('.session-history-group-icon')).textContent = group.ungrouped ? '◇' : (group.missing ? '⚠' : '▣');
		DOM.append(header, $('.session-history-group-name')).textContent = group.title;
		if (group.path) {
			DOM.append(header, $('.session-history-group-path')).textContent = group.path;
		}
		const meta = DOM.append(header, $('.session-history-group-meta'));
		const activeCount = group.sessions.filter(s => this._isActiveSession(s)).length;
		if (activeCount > 0) {
			const live = DOM.append(meta, $('.session-history-group-live'));
			live.title = localize('sessionHistory.groupActive', "{0} 个会话正在运行或等待你", activeCount);
			DOM.append(live, $('.session-history-group-live-dot'));
			DOM.append(live, $('span')).textContent = String(activeCount);
		}
		const countEl = DOM.append(meta, $('.session-history-group-count'));
		// 计数 = 该工作区下**全部**会话（含被 5 条配额折叠掉的）—— 否则用户以为会话丢了。
		countEl.textContent = String(group.sessions.length);

		/**
		 * ★★ 多根徽标（2026-10-24 用户报「左侧工作区看不出多根」）。
		 *
		 * `group.roots` 由 `sessionGrouping` 从 `Workspace.relatedFolders` 算出来，
		 * **只在 `length > 1` 时有值** ⇒ 单根工作区不显示任何东西（不制造噪音）。
		 *
		 * 为什么徽标比"改名字"更合适：多根工作区的两个根常常**同名**（`...\S1Game` ×2），
		 * 光靠名字区分要么变很长、要么仍然歧义；「2 根」是**结构化信息**，一眼就知道这组含两个根，
		 * 悬停还能看到每个根的完整路径。
		 *
		 * ⚠ 用内联样式而不是新增 CSS 类：本文件对应的 css 在别处，加类要两个文件一起改，
		 *   而这个徽标只有一种形态（不值得为它加一条全局样式）。
		 */
		const groupRoots = Array.isArray(group.roots) ? group.roots : [];
		if (groupRoots.length > 1) {
			const rootsBadge = $<HTMLElement>('span.session-history-group-roots');
			rootsBadge.textContent = localize('sessionHistory.groupRoots', "{0} 根", groupRoots.length);
			rootsBadge.title = groupRoots
				.map((r, i) => localize('sessionHistory.groupRootItem',
					"{0}：{1}",
					i === 0 ? localize('sessionHistory.groupRootPrimary', "主根") : localize('sessionHistory.groupRootRelated', "关联根"),
					r))
				.join('\n');
			rootsBadge.style.cssText = 'flex:0 0 auto;font-size:10px;line-height:15px;padding:0 5px;'
				+ 'border-radius:7px;white-space:nowrap;cursor:help;'
				+ 'background:rgba(128,128,128,.18);color:var(--vscode-descriptionForeground,#999);';
			// 插在计数之前（视觉顺序：名称 … 路径 … N 根 · 计数）
			header.insertBefore(rootsBadge, countEl);
		}
		this._register(DOM.addDisposableListener(header, DOM.EventType.CLICK, () => this._toggleGroupCollapsed(group.key)));

		return DOM.append(groupEl, $('.session-history-group-items'));
	}

	/** 组尾的「展开其余 N 条」/「收起」行。 */
	private _renderGroupMoreRow(body: HTMLElement, group: ISessionGroup<SessionData>, label: string, onClick: () => void): void {
		const row = DOM.append(body, $('.session-history-group-more'));
		row.textContent = label;
		row.setAttribute('data-workspace-key', group.key);
		this._register(DOM.addDisposableListener(row, DOM.EventType.CLICK, (e) => {
			e.stopPropagation();
			onClick();
		}));
	}

	/** 该会话是否「正在运行 / 等待用户」⇒ 不占 5 条配额、且**始终显示**。 */
	private _isActiveSession(sessionData: SessionData): boolean {
		const phase = this._runPhases.get(this._sessionKey(sessionData.info.agentId, sessionData.info.sessionId));
		return phase === 'running' || phase === 'awaiting';
	}

	/** 折叠 / 展开一个工作区分组（持久化）。 */
	private _toggleGroupCollapsed(key: string): void {
		if (this._collapsedGroups.has(key)) {
			this._collapsedGroups.delete(key);
		} else {
			this._collapsedGroups.add(key);
		}
		this._saveCollapsedGroups();
		this._rebuildListKeepingScroll();
	}

	/** 「展开其余」：每组每次 +5 条（内存态，不持久化 —— 与 dsh desktop 一致）。 */
	private _expandGroup(key: string): void {
		this._groupExtraShown.set(key, nextExtraShown(this._groupExtraShown.get(key) ?? 0));
		this._rebuildListKeepingScroll();
	}

	/** 「收起」：回到该组的默认 5 条投影。 */
	private _collapseGroup(key: string): void {
		this._groupExtraShown.set(key, 0);
		this._rebuildListKeepingScroll();
	}

	/**
	 * 整帧重建列表并**还原滚动位置**。
	 *
	 * 为什么必须还原：折叠 / 展开会改变列表高度，而重建是 `clearNode` + 全量回填 ⇒
	 * `scrollTop` 归零。用户点了第 3 组的「展开其余」却被弹回列表顶部 ✗。
	 */
	private _rebuildListKeepingScroll(): void {
		if (!this.sessionListEl) { return; }
		this._pendingScrollTop = this.sessionListEl.scrollTop;
		void this._applyFiltersIncremental({ silent: true });
	}

	/**
	 * Lazy-load chat history for a session when first expanded.
	 * Returns the user messages (newest first), or [] on error.
	 */
	private async _loadSessionHistory(sessionData: SessionData): Promise<UserMessageInfo[]> {
		const { agentId, sessionId } = sessionData.info;

		// Prevent duplicate loads
		if ((sessionData as any)._messagesLoaded) {
			return sessionData.messages;
		}
		(sessionData as any)._messagesLoading = true;

		try {
			const history = await this.chatService.getHistory(agentId, sessionId);
			const userMessages: UserMessageInfo[] = history
				.filter(m => m.role === 'user')
				.map(m => ({
					id: m.id,
					content: m.content,
					timestamp: (typeof m.timestamp === 'string' ? new Date(m.timestamp).getTime() : Date.now()),
				}))
				.sort((a, b) => b.timestamp - a.timestamp);

			sessionData.messages = userMessages;
			(sessionData as any)._messagesLoaded = true;
			(sessionData as any)._messagesLoading = false;

			// 更新已渲染 item 的计数（0 不显示 ⇒ 懒加载后首次出现消息时需**新建**该元素）
			const itemEl = this.sessionListEl?.querySelector(`[data-session-id="${sessionId}"]`)?.closest('.session-history-item');
			if (itemEl) {
				const subRight = itemEl.querySelector('.session-history-sub-right');
				if (subRight) {
					let countEl = subRight.querySelector('.session-history-count') as HTMLElement | null;
					if (userMessages.length > 0 && !countEl) {
						countEl = document.createElement('span');
						countEl.className = 'session-history-count';
						subRight.appendChild(countEl);
					}
					if (countEl) {
						countEl.textContent = String(userMessages.length);
						countEl.title = `${userMessages.length} messages`;
					}
				}
			}

			return userMessages;
		} catch (err) {
			this.logService.warn(`[SessionHistoryView] Failed to load history for session ${sessionId}:`, err);
			(sessionData as any)._messagesLoading = false;
			return [];
		}
	}

	/**
	 * Discover agent IDs by scanning the global chat history directory.
	 * Layout: ~/.vssaros/chat-history/{agentId}/sessions.json
	 */
	private async _discoverAgentIds(): Promise<string[]> {
		const agentIds: string[] = [];

		try {
			// userRoamingDataHome = ~/.vssaros/User/ → up one level = ~/.vssaros/
			const userDataRoot = userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
			const chatHistoryRoot = URI.joinPath(userDataRoot, 'chat-history');
			this.logService.info(`[SessionHistoryView] _discoverAgentIds: scanning ${chatHistoryRoot.fsPath}`);

			if (!(await this.fileService.exists(chatHistoryRoot))) {
				this.logService.info(`[SessionHistoryView] _discoverAgentIds: chat-history dir does not exist: ${chatHistoryRoot.fsPath}`);
				return agentIds;
			}

			const children = await this.fileService.resolve(chatHistoryRoot);
			if (children.children) {
				for (const child of children.children) {
					if (child.isDirectory) {
						const indexUri = URI.joinPath(child.resource, 'sessions.json');
						try {
							if (await this.fileService.exists(indexUri)) {
								agentIds.push(child.name);
							}
						} catch {
							// Directory but no sessions.json — skip
						}
					}
				}
			}
		} catch (err) {
			this.logService.warn('[SessionHistoryView] _discoverAgentIds: failed to scan chat-history dir:', err);
		}

		return agentIds;
	}

	/**
	 * Sync the open/closed state for all sessions by re-scanning open editors.
	 * Called when the active editor changes (agent switch, session switch).
	 * In-place updates the status dots and "open" tags without full re-render.
	 */
	private _syncOpenState(): void {
		if (!this.sessionListEl) { return; }

		const items = this.sessionListEl.querySelectorAll('.session-history-item');
		items.forEach((item) => {
			// ★ 2026-09-15：改用 `data-session-key` 直接反查。原实现靠「标题文本 +
			// agent 徽章文本」匹配 —— item 结构一改（本次重构去掉 🤖 emoji）就失效，
			// 且不同 agent 下同名会话会误配。
			const key = item.getAttribute('data-session-key');
			if (!key) { return; }
			const sessionData = this.allSessions.find(s => this._sessionKey(s.info.agentId, s.info.sessionId) === key);
			if (!sessionData) { return; }

			const nowOpen = this._findOpenEditorForSession(sessionData.info.agentId, sessionData.info.sessionId) !== null;
			sessionData.chatOpen = nowOpen;

			// 「open」标记：行 1 标题右侧的绿色小字
			const titleLine = item.querySelector('.session-history-title-line');
			const openTag = item.querySelector('.session-history-open-tag');
			if (nowOpen && titleLine && !openTag) {
				const tag = document.createElement('span');
				tag.className = 'session-history-open-tag';
				tag.textContent = 'open';
				titleLine.appendChild(tag);
			} else if (!nowOpen && openTag) {
				openTag.remove();
			}

			// 会话已打开 ⇒ 视为「用户已查看」，白点熄灭（用户需求）
			if (nowOpen) { this._readKeys.add(key); }

			this._applyDotState(item as HTMLElement, key, sessionData);
		});
	}

	/**
	 * Start rename mode for a session. Replaces the title span with an inline
	 * input. Enter (or blur) commits the new name; Escape restores the original.
	 */
	private _startRenameSession(sessionData: SessionData, titleEl: HTMLElement, itemEl: HTMLElement): void {
		const { info } = sessionData;

		// Never stack a second editor on top of an in-flight rename.
		const existingInput = itemEl.querySelector<HTMLInputElement>('.session-history-rename-input');
		if (existingInput) {
			existingInput.focus();
			existingInput.select();
			return;
		}

		const original = info.sessionName ?? titleEl.textContent ?? '';

		// Build input
		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'session-history-rename-input';
		input.value = original;
		input.maxLength = 100;
		input.placeholder = 'Session name';

		// Replace the title with the input
		titleEl.replaceWith(input);

		// Capture phase so the mousedown never reaches the item's expand handler.
		const swallowEvent = (e: Event) => e.stopPropagation();
		input.addEventListener('mousedown', swallowEvent, true);
		input.addEventListener('click', swallowEvent, true);

		let finished = false;
		const restoreTitle = (text: string): HTMLSpanElement => {
			const newTitle = document.createElement('span');
			newTitle.className = 'session-history-title';
			newTitle.textContent = text;
			newTitle.title = `${text} — Double-click to rename`;
			DOM.addStandardDisposableListener(newTitle, DOM.EventType.DBLCLICK, (e) => {
				e.stopPropagation();
				this._startRenameSession(sessionData, newTitle, itemEl);
			});
			input.replaceWith(newTitle);
			return newTitle;
		};

		/**
		 * Whether another session already carries this display name.
		 *
		 * 重名在 UI 上是允许的（不阻断重命名），仅在日志中留痕，用于排查
		 * 「用户以为改名失败、其实只是和别的会话同名」这类反馈。
		 */
		const isDuplicateName = (name: string): boolean => {
			return this.allSessions.some((other) =>
				other.info.sessionId !== info.sessionId
				&& other.info.agentId === info.agentId
				&& (other.info.sessionName ?? '') === name
			);
		};

		const finish = async (commit: boolean) => {
			if (finished) { return; }
			finished = true;

			input.removeEventListener('mousedown', swallowEvent, true);
			input.removeEventListener('click', swallowEvent, true);

			const typed = input.value.trim();
			const newName = typed || original;
			// Escape (or an emptied box) reverts the displayed title without persisting.
			restoreTitle(commit && typed ? newName : original);

			if (!commit || !typed || newName === original) {
				return;
			}

			if (isDuplicateName(newName)) {
				this.logService.info(`[SessionHistoryView] session ${info.sessionId} renamed to "${newName}" (duplicate display name)`);
			}

			// ★ 2026-10-19：**dsh 会话**改名必须走 dsh（它有真源），不能写 IDE 的 `chat-history`
			//   （dsh 会话不在那份索引里 ⇒ 写了等于改名了个寂寞 ✗）。
			//   路径：`renameDshSession` → 主进程 → preload → 页面 `ctx.sessions.rename`。
			//   ⚠ 它要求该会话**正在某个聊天页签里显示**（改名只能由页面做）；不在 ⇒ 如实提示，
			//   并且**不改本地显示**（乐观更新 = 假成功 ✗，等页面回执再刷新）。
			if (info.dshSession) {
				const ok = await this.dshHarness.renameDshSession(info.sessionId, newName);
				if (!ok) {
					this.notificationService.info('这条 dsh 会话当前没有在聊天框里打开，改名只能在聊天框里做 —— 请先打开它再改名。');
					restoreTitle(original);
					return;
				}
				this.logService.info(`[SessionHistoryView] dsh session ${info.sessionId} rename requested → "${newName}"（等页面回执）`);
				return;
			}

			try {
				// ★ 2026-09-20：这是**用户手动**改名 ⇒ 传 `userInitiated`，
				// 服务端会给会话打 `userRenamed` 标记，避免之后被「首条消息自动命名」覆盖。
				await this.chatService.renameAgentSession(info.agentId, info.sessionId, newName, { userInitiated: true });
				this.logService.info(`[SessionHistoryView] renamed session ${info.sessionId} to "${newName}"`);
				// Update local cache so subsequent reloads reflect the change
				info.sessionName = newName;
				// 同步已打开的聊天页签 label（否则侧边栏改名后页签名保持不变）
				this._syncEditorTabLabel(info.agentId, info.sessionId, newName);
			} catch (err) {
				this.logService.warn(`[SessionHistoryView] Failed to rename session ${info.sessionId}:`, err);
			}
		};

		// Enter commits the rename, Escape abandons it.
		// ⚠ 必须用 `addDisposableListener`（传**原生** KeyboardEvent）而非
		// `addStandardDisposableListener`：后者会把事件包装成 `StandardKeyboardEvent`，
		// 而该类**没有 `key` 属性**（只有 `keyCode`/`code`，见 `base/browser/keyboardEvent.ts:51-74`）
		// ⇒ `e.key` 恒为 `undefined` ⇒ 条件恒真 ⇒ Enter 永远被 return 掉、重命名无声失效。
		this._register(DOM.addDisposableListener(input, DOM.EventType.KEY_DOWN, (e) => {
			const key = (e as KeyboardEvent).key;
			if (key !== 'Enter' && key !== 'Escape') {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			void finish(key === 'Enter');
		}));
		// Clicking elsewhere confirms the edit, mirroring the Enter key.
		this._register(DOM.addStandardDisposableListener(input, DOM.EventType.BLUR, () => {
			void finish(true);
		}));

		input.focus();
		input.select();
	}

	private _findOpenEditorForSession(agentId: string, sessionId: string): { pane: NativeChatEditorPane; editor: NativeChatEditorInput; groupId: number } | null {
		const editors = this.editorService.getEditors(EditorsOrder.SEQUENTIAL);
		for (const { editor, groupId } of editors) {
			if (editor instanceof NativeChatEditorInput) {
				// Must match both agentId AND sessionId — an editor for the same
				// agent but different session won't have the target messages.
				if (editor.agentId === agentId && editor.sessionId === sessionId) {
					// Find the pane for this editor
					const group = this.editorGroupsService.getGroup(groupId);
					if (group) {
						const pane = group.activeEditorPane;
						if (pane instanceof NativeChatEditorPane) {
							return { pane, editor, groupId };
						}
					}
				}
			}
		}
		return null;
	}

	/**
	 * Push a renamed session name onto the matching open chat editor so its tab
	 * label follows the sidebar. Only the label is touched — the pane's runtime
	 * state (messages, agent binding) is left alone.
	 */
	private _syncEditorTabLabel(agentId: string, sessionId: string, newName: string): void {
		const openEditor = this._findOpenEditorForSession(agentId, sessionId);
		if (!openEditor) {
			return;
		}
		openEditor.editor.setSessionName(newName);
	}

	private _applyFilters(): void {
		const agentFilter = this.currentAgentFilter;
		const searchTerm = this.currentSearchTerm;

		this.filteredSessions = this.allSessions.filter(s => {
			if (agentFilter && s.info.agentId !== agentFilter) { return false; }
			if (searchTerm) {
				const inTitle = s.info.sessionName.toLowerCase().includes(searchTerm);
				const inMessages = s.messages.some(m => m.content.toLowerCase().includes(searchTerm));
				if (!inTitle && !inMessages) { return false; }
			}
			return true;
		});

		this._renderSessionList();
	}

	private _renderSessionList(): void {
		if (!this.sessionListEl) { return; }
		DOM.clearNode(this.sessionListEl);
		// 同步整帧重建（分组结构由 `_planGroupRender` 决定）⇒ 与后台刷新同一条路径。
		this._renderAllSessionsSync(this.sessionListEl);
	}

	/**
	 * 人格 chip —— **圆角矩形**（不是圆形）：`[glyph] 名字`。
	 *
	 * 为什么不做成头像：人格表达的是「本会话按谁的人设工作」这个**状态**，不是第二个身份 ⇒
	 * 标签既能一眼区分「会话所属 agent」与「会话内切换的人格」，又不会与头像语义打架。
	 * glyph 取人格（= 另一个 agent）的 `Agent.icon`，缺则取名字首字。
	 */
	private _buildPersonaChip(info: SessionInfo, label: string): HTMLElement {
		const chip = $<HTMLElement>('span.session-history-persona-chip');
		chip.title = localize('sessionHistory.personaTitle', "本会话已热切换人格：{0}（只改提示词人设，工具与模型不变）", label);
		DOM.append(chip, $('span.session-history-persona-chip-glyph')).textContent = personaGlyphOf(label, info.personaIcon);
		DOM.append(chip, $('span.session-history-persona-chip-name')).textContent = label;
		return chip;
	}

	private _renderSessionItem(item: HTMLElement, sessionData: SessionData): void {
		const { info, messages, chatOpen, pinned } = sessionData;

		// 人格标记的文案（`name` → `id`）；空串 = 该会话没切换过人格 ⇒ **一个标记都不画**。
		const personaLabel = info.personaId
			? personaLabelOf({ id: info.personaId, name: info.personaName })
			: '';

		// Allow finding this item by sessionId for lazy-load updates
		item.setAttribute('data-session-id', info.sessionId);
		item.setAttribute('data-agent-id', info.agentId);
		item.setAttribute('data-session-key', this._sessionKey(info.agentId, info.sessionId));
		if (info.personaId) { item.setAttribute('data-persona-id', info.personaId); }
		item.draggable = true;

		// F2 renaming: items are focusable so the shortcut can target the item the
		// user is navigating with the keyboard (mirrors the tree/explorer convention).
		item.tabIndex = 0;
		this._register(DOM.addDisposableListener(item, DOM.EventType.KEY_DOWN, (e) => {
			if (e.keyCode !== KeyCode.F2) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this._triggerRename(sessionData);
		}));


		// 多选态：重渲染后按 selectedKeys 还原（选中集合与展开态正交）
		if (this.selectedKeys.has(this._sessionKey(info.agentId, info.sessionId))) {
			item.classList.add('selected');
		}

		// ── Header：精简两行（2026-09-15 重构，用户选定方案 A）─────────────────
		// 行 1：箭头 + 标题（+ open 小字）
		// 行 2：状态点 + agent 名 · 相对时间 ……… 计数（右对齐）
		// 右侧：rename / delete —— **常驻占位**、hover 才可见（避免标题宽度抖动）
		const header = DOM.append(item, $('.session-history-item-header'));

		const arrow = DOM.append(header, $('.session-history-expand-arrow'));
		arrow.textContent = '▶';

		const infoEl = DOM.append(header, $('.session-history-info'));

		// 行 1
		const titleLine = DOM.append(infoEl, $('.session-history-title-line'));
		if (pinned) {
			const pinEl = DOM.append(titleLine, $('.session-history-pin'));
			pinEl.title = 'Pinned';
			pinEl.appendChild(_icon(ICON_PIN, 11));
		}
		// ★ 2026-10-12（用户要求）：会话行**前面不放圆形图标** —— agent 圆形头像已整块删除，
		// 会话归属由行 2 的 agent 名表达。人格是「标签」而不是第二个身份 ⇒ 用**非圆形**的
		// 圆角 chip 或纯文字（落点由 `PERSONA_MARK` 决定，默认落副行）。
		if (personaLabel && PERSONA_MARK === 'chip') {
			titleLine.appendChild(this._buildPersonaChip(info, personaLabel));
		}
		const title = DOM.append(titleLine, $('.session-history-title'));
		title.textContent = info.sessionName || 'Untitled Session';
		title.title = `${info.sessionName || 'Untitled Session'} — Double-click to open chat, Ctrl/Cmd+click to multi-select, right-click for actions`;
		// 飞书绑定标识：该会话被某 chat_id 绑定（或为渠道默认会话）时显示
		const boundChatId = this._feishuBoundBySession.get(info.sessionId);
		const isDefaultFeishu = !boundChatId && this._feishuDefaultSessionId === info.sessionId;
		if (boundChatId || isDefaultFeishu) {
			const feTag = DOM.append(titleLine, $('.session-history-feishu-tag'));
			feTag.title = boundChatId
				? `已绑定飞书会话：${boundChatId}（该群/私聊消息将进入此会话）`
				: '飞书渠道默认会话（未精确绑定的消息将进入此会话）';
			feTag.appendChild(_icon(ICON_LINK, 11));
		}
		// 人格 chip 的「标题右侧」落点：排在 `open` 之前（`open` 是本行最后一个标记）。
		if (personaLabel && PERSONA_MARK === 'title') {
			titleLine.appendChild(this._buildPersonaChip(info, personaLabel));
		}
		if (chatOpen) {
			const openTag = DOM.append(titleLine, $('.session-history-open-tag'));
			openTag.textContent = 'open';
		}

		// 行 2
		const subLine = DOM.append(infoEl, $('.session-history-sub-line'));
		// 状态点由 `_applyDotState(item, …)` 按 DOM 查询后设置，这里不需要引用。
		DOM.append(subLine, $('.session-history-status-dot'));
		const agentNameEl = DOM.append(subLine, $('.session-history-agent-name'));
		agentNameEl.textContent = info.agentName;
		agentNameEl.title = `Agent: ${info.agentName}`;
		// 人格（默认落点）：`Saros · 人格：架构评审 · 26m` —— 纯文字、无图标、不进标题行。
		if (personaLabel && PERSONA_MARK === 'sub') {
			DOM.append(subLine, $('.session-history-sep')).textContent = '·';
			const personaEl = DOM.append(subLine, $('.session-history-persona'));
			personaEl.textContent = localize('sessionHistory.personaInline', "人格：{0}", personaLabel);
			personaEl.title = localize('sessionHistory.personaTitle', "本会话已热切换人格：{0}（只改提示词人设，工具与模型不变）", personaLabel);
		}
		const sepEl = DOM.append(subLine, $('.session-history-sep'));
		sepEl.textContent = '·';
		const timeEl = DOM.append(subLine, $('.session-history-time'));
		timeEl.textContent = this._formatRelativeTime(info.updatedAt);
		timeEl.title = info.updatedAt ? new Date(info.updatedAt).toLocaleString() : '';
		const subRight = DOM.append(subLine, $('.session-history-sub-right'));
		// 计数去 badge 化：0 不显示（用户需求：满屏 `0` 圆角块太抢眼）
		if (messages.length > 0) {
			const count = DOM.append(subRight, $('.session-history-count'));
			count.textContent = String(messages.length);
			count.title = `${messages.length} messages`;
		}

		// 右侧操作组（常驻占位 ⇒ hover 时标题不位移）
		const actions = DOM.append(header, $('.session-history-actions'));

		// 飞书绑定按钮：未绑定 hover 才可见；已绑定常显蓝色（点击切换/解绑）
		const bindBtn = DOM.append(actions, $<HTMLButtonElement>('.session-history-bind-btn'));
		if (boundChatId) { bindBtn.classList.add('bound'); }
		bindBtn.title = boundChatId
			? `飞书绑定：${boundChatId}（点击切换或解绑）`
			: '绑定飞书会话（chat_id）';
		bindBtn.appendChild(_icon(ICON_LINK));
		this._register(DOM.addDisposableListener(bindBtn, DOM.EventType.CLICK, (e) => {
			e.stopPropagation();
			void this._promptFeishuBinding(sessionData);
		}));

		// ★ 2026-10-19：**重命名**按钮 dsh 会话也给 —— 走 `renameDshSession`（页面 `ctx.sessions.rename`）
		//   ⇒ 真的会落在 dsh 那边（`_startRenameSession` 里分流，不在就如实提示）。
		const editBtn = DOM.append(actions, $<HTMLButtonElement>('.session-history-rename-btn'));
		editBtn.title = 'Rename session';
		editBtn.appendChild(_icon(ICON_PENCIL));
		this._register(DOM.addDisposableListener(editBtn, DOM.EventType.CLICK, (e) => {
			e.stopPropagation();
			this._startRenameSession(sessionData, title, item);
		}));

		// ★ 删除按钮**只给 IDE 会话**：会话控制器**没有删除 API**（实测：`dsh-api-session-controller/client.js`
		//   全文无 delete/remove/archive/purge）⇒ 给了就是"点了没反应"的假入口 ✗。
		//   （「固定」按钮两来源都给：它是本地持久化 ✓。）
		if (!info.dshSession) {
		// Delete button — hover（或选中态）才可见。
		// 多选时（该项属于选中集合且集合 > 1）一次删除整个选中集合。
		const deleteBtn = DOM.append(actions, $<HTMLButtonElement>('.session-history-delete-btn'));
		deleteBtn.appendChild(_icon(ICON_TRASH));
		const isPartOfMultiSelection = () =>
			this.selectedKeys.has(this._sessionKey(info.agentId, info.sessionId)) && this.selectedKeys.size > 1;
		deleteBtn.title = isPartOfMultiSelection() ? 'Delete selected sessions' : 'Delete session';
		this._register(DOM.addDisposableListener(deleteBtn, DOM.EventType.CLICK, (e) => {
			e.stopPropagation();
			void this._deleteSessionsForItem(sessionData);
		}));
		}

		// 运行指示灯：绿闪（执行中）/ 黄闪（等待用户）/ 白常亮（完成未读）/ 红（报错）
		this._applyDotState(item, this._sessionKey(info.agentId, info.sessionId), sessionData);

		// Messages container
		const messagesContainer = DOM.append(item, $('.session-history-messages-container'));

		let expanded = false;

		const toggleExpand = () => {
			expanded = !expanded;
			if (expanded) {
				item.classList.add('expanded');
				arrow.textContent = '▼';
				// Lazy-load history on first expand
				void this._renderMessages(messagesContainer, sessionData);
			} else {
				item.classList.remove('expanded');
				arrow.textContent = '▶';
				DOM.clearNode(messagesContainer);
			}
		};

		// Single click selects the item, then expands/collapses (delayed so a
		// double-click cancels it and opens the chat instead of toggling twice).
		// Modifier clicks extend the selection and never toggle expansion.
		this._register(DOM.addDisposableListener(header, DOM.EventType.CLICK, (e) => {
			const mouseEvent = e as MouseEvent;
			if (mouseEvent.ctrlKey || mouseEvent.metaKey || mouseEvent.shiftKey) {
				this._extendSelection(sessionData, { range: mouseEvent.shiftKey });
				return;
			}
			this._selectSingle(sessionData);
			this._pendingExpandTimer = setTimeout(() => {
				this._pendingExpandTimer = undefined;
				toggleExpand();
			}, 220);
		}));

		// Double click opens the agent chat (focus input if already open).
		this._register(DOM.addDisposableListener(header, DOM.EventType.DBLCLICK, (e) => {
			e.stopPropagation();
			if (this._pendingExpandTimer) {
				clearTimeout(this._pendingExpandTimer);
				this._pendingExpandTimer = undefined;
			}
			void this._openSessionChat(sessionData);
		}));

		// Right-click context menu: pin / rename / delete.
		this._register(DOM.addDisposableListener(header, DOM.EventType.CONTEXT_MENU, (e) => {
			e.preventDefault();
			e.stopPropagation();
			this._showContextMenu(sessionData, e as MouseEvent);
		}));

		// Drag & drop reordering.
		this._register(DOM.addDisposableListener(item, 'dragstart', (e) => {
			const dragEvent = e as DragEvent;
			dragEvent.dataTransfer?.setData('text/plain', item.getAttribute('data-session-key') ?? '');
			if (dragEvent.dataTransfer) { dragEvent.dataTransfer.effectAllowed = 'move'; }
			item.classList.add('dragging');
		}));
		this._register(DOM.addDisposableListener(item, 'dragend', () => {
			item.classList.remove('dragging');
		}));
		this._register(DOM.addDisposableListener(item, 'dragover', (e) => {
			const dragEvent = e as DragEvent;
			dragEvent.preventDefault();
			if (dragEvent.dataTransfer) { dragEvent.dataTransfer.dropEffect = 'move'; }
		}));
		this._register(DOM.addDisposableListener(item, 'drop', (e) => {
			const dragEvent = e as DragEvent;
			e.preventDefault();
			e.stopPropagation();
			const draggedKey = dragEvent.dataTransfer?.getData('text/plain');
			const targetKey = item.getAttribute('data-session-key') ?? '';
			if (draggedKey && targetKey && draggedKey !== targetKey) {
				this._reorderSession(draggedKey, targetKey);
			}
		}));
	}

	private async _renderMessages(container: HTMLElement, sessionData: SessionData): Promise<void> {
		DOM.clearNode(container);

		// Lazy-load history if not yet fetched
		if (!(sessionData as any)._messagesLoaded) {
			// Show loading indicator
			const loading = DOM.append(container, $('.session-history-messages-loading'));
			loading.textContent = 'Loading messages...';
			container.appendChild(loading);

			await this._loadSessionHistory(sessionData);
			if ((sessionData as any)._messagesLoading) { return; } // already loading elsewhere

			// Re-render with loaded messages
			this._renderMessagesLoaded(container, sessionData);
			return;
		}

		this._renderMessagesLoaded(container, sessionData);
	}

	private _renderMessagesLoaded(container: HTMLElement, sessionData: SessionData): void {
		DOM.clearNode(container);

		if (sessionData.messages.length === 0) {
			const empty = DOM.append(container, $('.session-history-messages-empty'));
			empty.textContent = 'No user messages in this session';
			return;
		}

		const header = DOM.append(container, $('.session-history-messages-header'));
		DOM.append(header, $('span')).textContent = 'User Messages';
		DOM.append(header, $('span.sort-indicator')).textContent = '↓ Newest first';

		for (const msg of sessionData.messages) {
			this._renderMessageItem(container, msg, sessionData);
		}
	}

	private _renderMessageItem(container: HTMLElement, msg: UserMessageInfo, sessionData: SessionData): void {
		const msgEl = DOM.append(container, $('.session-history-message'));

		const avatar = DOM.append(msgEl, $('.session-history-avatar'));
		avatar.textContent = 'U';

		const body = DOM.append(msgEl, $('.session-history-message-body'));

		const header = DOM.append(body, $('.session-history-message-header'));
		const roleLabel = DOM.append(header, $('.session-history-message-role'));
		roleLabel.textContent = 'USER';
		const timeLabel = DOM.append(header, $('.session-history-message-time'));
		timeLabel.textContent = this._formatTime(msg.timestamp);

		const textEl = DOM.append(body, $('.session-history-message-text'));
		textEl.textContent = msg.content;

		// Action buttons
		const actions = DOM.append(msgEl, $('.session-history-message-actions'));

		// Go-to button
		const gotoBtn = DOM.append(actions, $<HTMLButtonElement>('.session-history-action-btn.session-history-goto-btn'));
		gotoBtn.title = sessionData.chatOpen ? 'Jump to message in chat' : 'Open chat and jump to message';
		{ const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('fill', 'currentColor'); p.setAttribute('d', 'M13.05 2.95a6.24 6.24 0 0 1 0 8.84L9.1 15.74l-.7-.71l3.95-3.95a5.25 5.25 0 0 0 0-7.42a5.25 5.25 0 0 0-7.42 0l-3.95 4l-.71-.71l3.95-4a6.24 6.24 0 0 1 8.83 0zM5.85 7.42l3.94-3.95l.71.71l-3.95 4a5.24 5.24 0 0 0 0 7.41a5.25 5.25 0 0 0 7.42 0l3.95-4l.71.71l-3.95 4a6.25 6.25 0 0 1-8.84 0a6.24 6.24 0 0 1 0-8.84l.01-.04z'); svg.appendChild(p); gotoBtn.appendChild(svg); }
		this._register(DOM.addDisposableListener(gotoBtn, DOM.EventType.CLICK, (e) => {
			e.stopPropagation();
			this._navigateToMessage(sessionData, msg.id);
		}));

		// Copy button
		const copyBtn = DOM.append(actions, $<HTMLButtonElement>('.session-history-action-btn.session-history-copy-btn'));
		copyBtn.title = 'Copy message';
		{ const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('fill', 'currentColor'); p.setAttribute('d', 'M4 4.085V2.5A1.5 1.5 0 0 1 5.5 1H13.5A1.5 1.5 0 0 1 15 2.5v8A1.5 1.5 0 0 1 13.5 12H13v-1h.5a.5.5 0 0 0 .5-.5v-8a.5.5 0 0 0-.5-.5h-8a.5.5 0 0 0-.5.5v.585H4zM2.5 3A1.5 1.5 0 0 0 1 4.5v8A1.5 1.5 0 0 0 2.5 14h8A1.5 1.5 0 0 0 12 12.5v-8A1.5 1.5 0 0 0 10.5 3h-8zM2 4.5a.5.5 0 0 1 .5-.5h8a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8z'); svg.appendChild(p); copyBtn.appendChild(svg); }
		this._register(DOM.addDisposableListener(copyBtn, DOM.EventType.CLICK, (e) => {
			e.stopPropagation();
			this._copyMessage(msg.content, copyBtn);
		}));

		// Click on message body also navigates
		this._register(DOM.addDisposableListener(msgEl, DOM.EventType.CLICK, () => {
			this._navigateToMessage(sessionData, msg.id);
		}));
	}

	private async _navigateToMessage(sessionData: SessionData, messageId: string): Promise<void> {
		const { agentId, sessionId } = sessionData.info;

		try {
			// Check if chat is already open
			const openEditor = this._findOpenEditorForSession(agentId, sessionId);

			if (openEditor) {
				// Already open: switch to the specific editor tab (pinned so close icon shows)
				await this.editorService.openEditor(openEditor.editor, { pinned: true, revealIfOpened: true }, openEditor.groupId);
				await this._retryScrollToMessage(agentId, sessionId, messageId);
			} else {
				// Not open: create new editor input and open
				// Tab title format: agentName (sessionName)
				const displayName = `${sessionData.info.agentName} (${sessionData.info.sessionName})`;
				const input = NativeChatEditorInput.create(
					`session-history-${sessionId}`,
					agentId,
					sessionId,
					displayName,
				);

				const agentPart = (this.editorGroupsService as unknown as { agentPart?: IEditorGroupsService }).agentPart;
				if (agentPart?.activeGroup) {
					await agentPart.activeGroup.openEditor(input, { pinned: true });
				} else {
					await this.editorService.openEditor(input, { pinned: true });
				}

				// Wait for the editor to load the session and messages, then scroll
				await this._retryScrollToMessage(agentId, sessionId, messageId);
			}
		} catch (err) {
			this.logService.error('[SessionHistoryView] Failed to navigate to message:', err);
		}
	}

	/**
	 * Retry scrollToMessage with exponential backoff. Before each attempt,
	 * force-reload the correct session's history into the chat panel so that
	 * the target message appears in the DOM even if the editor restored a
	 * different session from runtime state.
	 */
	private async _retryScrollToMessage(agentId: string, sessionId: string, messageId: string): Promise<void> {
		const delays = [300, 600, 1000, 1500, 2000, 2500, 2000, 1000];
		for (let attempt = 0; attempt < delays.length; attempt++) {
			await new Promise(resolve => setTimeout(resolve, delays[attempt]));
			const openEditor = this._findOpenEditorForSession(agentId, sessionId);
			if (!openEditor) { continue; }
			const chatPanel = (openEditor.pane as any)._chatPanel as any;
			if (!chatPanel || typeof chatPanel.setMessages !== 'function') { continue; }

			// Force-load the correct session's messages into the panel
			try {
				const history = await this.chatService.getHistory(agentId, sessionId);
				const adapted = (openEditor.pane as any)._adaptHistoryMessages
					? (openEditor.pane as any)._adaptHistoryMessages(history)
					: history;
				if (Array.isArray(adapted) && adapted.length > 0) {
					chatPanel.setMessages(adapted);
					// Allow DOM to settle after setMessages
					await new Promise(resolve => setTimeout(resolve, 100));
				}
			} catch (err) {
				this.logService.warn(`[SessionHistoryView] failed to load history for scroll:`, err);
			}

			// Now try scrolling
			chatPanel.scrollToMessage?.(messageId);

			const messagesContainer = chatPanel.messagesContainer as HTMLElement | undefined;
			if (messagesContainer) {
				const found = messagesContainer.querySelector(`[data-msg-id="${messageId}"]`);
				if (found) {
					this.logService.info(`[SessionHistoryView] scrolled to message ${messageId} on attempt ${attempt + 1}`);
					return;
				}
			}
		}
		this.logService.warn(`[SessionHistoryView] failed to scroll to message ${messageId} after ${delays.length} attempts`);
	}

	private _copyMessage(content: string, btn: HTMLButtonElement): void {
		navigator.clipboard.writeText(content).then(() => {
			btn.classList.add('copied');
			setTimeout(() => btn.classList.remove('copied'), 1500);
		}).catch(() => {
			// Fallback
			const ta = document.createElement('textarea');
			ta.value = content;
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			document.body.removeChild(ta);
			btn.classList.add('copied');
			setTimeout(() => btn.classList.remove('copied'), 1500);
		});
	}

	private _formatTime(timestamp: number): string {
		try {
			const d = new Date(timestamp);
			const now = new Date();
			const diffMs = now.getTime() - d.getTime();
			const diffMins = Math.floor(diffMs / 60000);

			if (diffMins < 1) { return 'Just now'; }
			if (diffMins < 60) { return `${diffMins}m ago`; }

			const diffHours = Math.floor(diffMins / 60);
			if (diffHours < 24) { return `${diffHours}h ago`; }

			const diffDays = Math.floor(diffHours / 24);
			if (diffDays < 7) { return `${diffDays}d ago`; }

			return d.toLocaleDateString();
		} catch {
			return '';
		}
	}

	// ─── Multi-selection ──────────────────────────────────────────────────

	/** 单选：清空后只选中当前项。 */
	private _selectSingle(sessionData: SessionData): void {
		const key = this._sessionKey(sessionData.info.agentId, sessionData.info.sessionId);
		this.selectedKeys.clear();
		this.selectedKeys.add(key);
		this._selectionAnchorKey = key;
		this._syncSelectionUi();
	}

	/**
	 * 追加选择：`range` 为真时按当前显示顺序做区间选择（Shift+点击），
	 * 否则切换单项（Ctrl/Cmd+点击）。
	 */
	private _extendSelection(sessionData: SessionData, options: { range: boolean }): void {
		const key = this._sessionKey(sessionData.info.agentId, sessionData.info.sessionId);

		if (options.range && this._selectionAnchorKey) {
			const keys = this.filteredSessions.map(s => this._sessionKey(s.info.agentId, s.info.sessionId));
			const from = keys.indexOf(this._selectionAnchorKey);
			const to = keys.indexOf(key);
			if (from >= 0 && to >= 0) {
				const start = Math.min(from, to);
				const end = Math.max(from, to);
				for (let i = start; i <= end; i++) {
					this.selectedKeys.add(keys[i]);
				}
				this._syncSelectionUi();
				return;
			}
		}

		if (this.selectedKeys.has(key)) {
			this.selectedKeys.delete(key);
		} else {
			this.selectedKeys.add(key);
		}
		this._selectionAnchorKey = key;
		this._syncSelectionUi();
	}

	/** 把选中集合投影到已渲染的 DOM 上（不重建列表）。 */
	private _syncSelectionUi(): void {
		const items = this.sessionListEl?.querySelectorAll<HTMLElement>('.session-history-item');
		items?.forEach(itemEl => {
			const key = itemEl.getAttribute('data-session-key') ?? '';
			itemEl.classList.toggle('selected', this.selectedKeys.has(key));
			const deleteBtn = itemEl.querySelector<HTMLElement>('.session-history-delete-btn');
			if (deleteBtn) {
				const multi = this.selectedKeys.has(key) && this.selectedKeys.size > 1;
				deleteBtn.title = multi ? 'Delete selected sessions' : 'Delete session';
				deleteBtn.classList.toggle('multi', multi);
			}
		});
	}

	private _clearSelection(): void {
		this.selectedKeys.clear();
		this._selectionAnchorKey = undefined;
		this._syncSelectionUi();
	}

	/** 当前选中集合对应的会话数据（按列表显示顺序）。 */
	private _getSelectedSessions(): SessionData[] {
		return this.filteredSessions.filter(s => this.selectedKeys.has(this._sessionKey(s.info.agentId, s.info.sessionId)));
	}

	// ─── Session actions: pin / rename / delete / open / reorder ──────────

	/**
	 * ★ 2026-09-23（用户需求）：`agentId → { name, icon }` 的**带缓存**映射。
	 *
	 * ⚠ 为什么要缓存：`_loadSessions()` 是高频路径（发消息触发的 silent 重载也走它），
	 * 每次都 `getAgents()` 是纯浪费 ⇒ 复用缓存；由 `onDidChangeAgents`
	 * （`updateAgent()` 一定会 fire）清掉 ⇒ 改名字后 item 能同步更新。
	 *
	 * ★ 2026-10-12：不再收 `avatar`（SVG data URI）—— 行首**不再画圆形头像**（用户要求），
	 * 只留 `icon`（emoji）供人格 chip 的 glyph 用（见 `PERSONA_MARK`）。
	 */
	private _agentInfoCache: ReadonlyMap<string, { name: string; icon?: string }> | undefined;

	private async _getAgentInfoMap(): Promise<ReadonlyMap<string, { name: string; icon?: string }>> {
		if (this._agentInfoCache) { return this._agentInfoCache; }

		const infos = new Map<string, { name: string; icon?: string }>();
		try {
			const agents = await this.agentStudioService.getAgents();
			for (const agent of agents) {
				// ⚠ 只收「有显示名」的；空名/纯空白视为没有 ⇒ 调用方回退到 agentId。
				if (agent.name && agent.name.trim()) {
					infos.set(agent.id, {
						name: agent.name.trim(),
						// emoji（`Agent.icon`）—— 人格 chip glyph 回退链的第一级。
						icon: agent.icon || undefined,
					});
				}
			}
		} catch (err) {
			this.logService.warn('[SessionHistoryView] failed to resolve agent display info:', err);
		}
		// 失败也写缓存（空 map）：否则 I/O 出错会退化成「每次重载都重试一次慢查询」。
		this._agentInfoCache = infos;
		return infos;
	}

	// ─── 工作区分组 / 人格事实（2026-10-12 重构）──────────────────────────────
	//
	// ⚠ 这里原先有一个 `_renderAgentAvatar()`（行首 18px 圆形头像，三级回退
	//   avatar → icon → 首字母）。**已按用户要求整块删除**：会话行前面不放圆形图标。
	//   若将来要恢复某个非圆形形态，数据侧只需重新收 `Agent.icon`（`_getAgentInfoMap`
	//   已经留着它）。

	/**
	 * 拉取（并缓存）工作区清单。
	 *
	 * 分组顺序 = 这个数组的顺序（`getWorkspaces()` 的返回序）⇒ **不能用 Map 替代**
	 * （Map 会丢顺序，而"用户自己排的工作区顺序"必须稳定）。
	 * 空数组视为「还没拉到」，由工作区变更事件清空重取。
	 */
	private async _ensureWorkspaces(): Promise<readonly IWorkspaceRef[]> {
		if (this._workspaces.length > 0) { return this._workspaces; }
		try {
			const workspaces = await this.agentStudioService.getWorkspaces();
			/**
			 * ★★ 2026-10-24（用户报「左侧工作区看不出多根」的**真正根因**）：
			 *
			 * `getWorkspaces()` 返回的 `Workspace` **本来就带 `relatedFolders`**，
			 * 但这里 `.map()` 只挑 `id / name / path` ⇒ **多根信息在这一行被丢掉**，
			 * 下游 `IWorkspaceRef` 拿不到 ⇒ 分组永远只有 1 个根 ⇒
			 * 「N 根」徽标不可能出现，同名的两个根也只能显示成两个一模一样的组头。
			 *
			 * ⇒ 补上 `relatedFolders`（原样透传，不做裁剪：分组侧自己会算 roots[0]=主根）。
			 */
			this._workspaces = workspaces
				.filter(w => !!w?.id)
				.map(w => ({ id: w.id, name: w.name, path: w.path, relatedFolders: w.relatedFolders }));
		} catch (err) {
			// 失败**不缓存**（保持空数组）⇒ 下次重载会重试。本次分组全体落「未分组」，
			// 但**不会丢会话** —— 这是有意的降级：宁可暂时没有分组头，也不能让列表空掉 ✓。
			this.logService.warn('[SessionHistoryView] failed to resolve workspaces for grouping:', err);
		}
		return this._workspaces;
	}

	/**
	 * `sessionId → workspaceId`（一次整文件读全局 `~/.vssaros/sessions.json`）。
	 *
	 * ⚠ 归属**只**记在会话注册表（`AgentStudioSession.workspaceId`）里；会话索引
	 * （`AgentSessionMeta`）没有该字段 ⇒ 只能这样旁路解析。查不到就是没有 ⇒ 未分组。
	 */
	private async _getSessionWorkspaceMap(): Promise<ReadonlyMap<string, string>> {
		if (this._sessionWorkspaceCache) { return this._sessionWorkspaceCache; }
		const map = new Map<string, string>();
		try {
			for (const session of await this.agentStudioService.getSessions()) {
				const workspaceId = (session?.workspaceId ?? '').trim();
				if (session?.id && workspaceId) { map.set(session.id, workspaceId); }
			}
		} catch (err) {
			this.logService.warn('[SessionHistoryView] failed to resolve session → workspace map:', err);
			return map;   // 失败不写缓存 ⇒ 下次重试
		}
		this._sessionWorkspaceCache = map;
		return map;
	}

	/**
	 * 人格事实的**读口子**（键 = `agentId::sessionId`）。
	 *
	 * 现状：dsh 侧的「会话内热切换人格」事实**还没有任何通路**能到 VsSaros
	 * （`AgentSessionMeta` / `AgentStudioSession` 都没有该字段，`ChatMessage.source`
	 * 也只有 `'user' | 'task'`），所以本函数先读一个**双方约定的存储键**。
	 * 通路接通后（三条候选见 `doc/session-sideview-workspace-mockup.html` §六）
	 * 由写入侧填这个键即可 ⇒ **渲染 / 分组 / 配额一行都不用改** ✓。
	 *
	 * 值格式：`{"agentId::sessionId":{"id":"<personaId>","name":"<显示名>"}}`；
	 * 坏值一律降级为空表（`parsePersonaMap` 已有单测）。
	 */
	private _getPersonaMap(): ReadonlyMap<string, IPersonaFact> {
		let raw = '';
		try {
			raw = this.storageService.get(SessionHistoryViewPane.PERSONA_KEY, StorageScope.PROFILE, '');
		} catch (err) {
			this.logService.debug('[SessionHistoryView] persona map unavailable:', err);
			return new Map<string, IPersonaFact>();
		}
		return parsePersonaMap(raw);
	}

	/** `agentId → 显示名`（由 `_getAgentInfoMap()` 派生；供新建会话面板的 chips 使用）。 */
	private async _resolveAgentNames(agentIds: string[]): Promise<ReadonlyMap<string, string>> {
		const all = await this._getAgentInfoMap();
		const names = new Map<string, string>();
		for (const id of agentIds) {
			const name = all.get(id)?.name;
			if (name) { names.set(id, name); }
		}
		return names;
	}

	/**
	 * Toggle the inline "new session" panel that lives just under the
	 * "+ New session" button. The panel lets the user pick an agent (chips)
	 * and name the session, then calls `createAgentSession` on confirm.
	 */
	private async _toggleNewSessionPanel(): Promise<void> {
		if (!this.newSessionPanel) { return; }

		// Already open? Close it.
		if (this.newSessionPanel.style.display !== 'none') {
			this._closeNewSessionPanel();
			return;
		}

		const agentIds = await this._discoverAgentIds();
		if (agentIds.length === 0) {
			await this.dialogService.info(
				localize('newSession.noAgents', "No agents found"),
				localize('newSession.noAgentsDetail', "There are no agents with an existing chat-history directory yet. Create or open an agent chat first."),
			);
			return;
		}

		// Resolve human-readable agent names (id → name) for the dropdown.
		const agentNames = await this._resolveAgentNames(agentIds);

		// Tear down any previous disposable store before re-rendering.
		this._disposeNewSessionPanel();
		this.newSessionPanelDisposables = this._register(new DisposableStore());

		this.newSessionState = {
			agentId: this.currentAgentFilter && agentIds.includes(this.currentAgentFilter) ? this.currentAgentFilter : agentIds[0],
			name: '',
			busy: false,
		};

		DOM.clearNode(this.newSessionPanel);
		this._renderNewSessionPanel(agentIds, agentNames);
		this.newSessionPanel.style.display = 'flex';

		// Focus the session name input for keyboard-driven flow.
		const nameInputEl = this.newSessionPanel.querySelector<HTMLInputElement>('.session-history-new-name-input .input');
		nameInputEl?.focus();
	}

	private _closeNewSessionPanel(): void {
		if (this.newSessionPanel) {
			this.newSessionPanel.style.display = 'none';
			DOM.clearNode(this.newSessionPanel);
		}
		this._disposeNewSessionPanel();
		this.newSessionState = undefined;
	}

	private _disposeNewSessionPanel(): void {
		this.newSessionPanelDisposables?.clear();
		this.newSessionPanelDisposables = undefined;
	}

	private _renderNewSessionPanel(agentIds: string[], agentNames: ReadonlyMap<string, string>): void {
		if (!this.newSessionPanel) { return; }

		const state = this.newSessionState;
		if (!state) { return; }

		// Agent label
		const agentLabel = DOM.append(this.newSessionPanel, $('.session-history-new-label'));
		agentLabel.textContent = localize('newSession.agentLabel', "Agent");

		// Agent select (native dropdown — reuses the same SelectBox as the
		// top-level agent filter for consistency).
		const agentSelectContainer = DOM.append(this.newSessionPanel, $('.session-history-new-agent-select-container'));
		const agentOptions: ISelectOptionItem[] = agentIds.map(id => ({
			text: agentNames.get(id) || id,
			description: agentNames.has(id) ? id : undefined,
		}));
		const initialIdx = Math.max(0, agentIds.indexOf(state.agentId));
		const agentSelect = this.newSessionPanelDisposables?.add(new SelectBox(agentOptions, initialIdx, this.contextViewService, defaultSelectBoxStyles, {
			ariaLabel: localize('newSession.agentAriaLabel', "Agent for the new session"),
			useCustomDrawn: true,
		}));
		if (agentSelect) {
			agentSelect.render(agentSelectContainer);
			this.newSessionPanelDisposables?.add(agentSelect.onDidSelect((selected) => {
				const idx = typeof selected.index === 'number' ? selected.index : 0;
				state.agentId = agentIds[idx] ?? state.agentId;
				// Re-focus the name input for keyboard flow.
				const nameInputEl = this.newSessionPanel?.querySelector<HTMLInputElement>('.session-history-new-name-input .input');
				nameInputEl?.focus();
			}));
		}

		// Name label
		const nameLabel = DOM.append(this.newSessionPanel, $('.session-history-new-label'));
		nameLabel.textContent = localize('newSession.nameLabel', "Session name (optional)");

		// Name input (re-using VS Code InputBox)
		const nameInputContainer = DOM.append(this.newSessionPanel, $('.session-history-new-name-input'));
		const nameInput = this.newSessionPanelDisposables?.add(new InputBox(nameInputContainer, this.contextViewService, {
			placeholder: localize('newSession.namePlaceholder', "Leave blank to use default"),
			ariaLabel: localize('newSession.nameAriaLabel', "Session name"),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		if (nameInput) {
			nameInput.value = state.name;
			this.newSessionPanelDisposables?.add(nameInput.onDidChange((value) => {
				state.name = value;
			}));
			// Enter to confirm.
			// ⚠ 监听挂在真正的 `<input>`（`inputElement`）上，而不是外层容器 `element`：
			// 键盘事件从内层 `.input` 冒泡虽然也能到达容器，但直接挂在输入元素上更可靠，
			// 且避免被容器上其它监听干扰。同时不用 `e instanceof KeyboardEvent` 判断
			// （跨 realm 时会误判），直接读原生事件的 `.key`。
			this.newSessionPanelDisposables?.add(DOM.addDisposableListener(nameInput.inputElement, DOM.EventType.KEY_DOWN, (e) => {
				if ((e as KeyboardEvent).key === 'Enter' && !state.busy) {
					e.preventDefault();
					void this._confirmNewSession();
				}
			}));
		}

		// Actions row
		const actions = DOM.append(this.newSessionPanel, $('.session-history-new-actions'));

		const createBtn = DOM.append(actions, $<HTMLButtonElement>('button.monaco-button.session-history-new-create-btn'));
		createBtn.textContent = localize('newSession.create', "Create");
		this.newSessionPanelDisposables?.add(DOM.addDisposableListener(createBtn, DOM.EventType.CLICK, () => {
			void this._confirmNewSession();
		}));

		const cancelBtn = DOM.append(actions, $<HTMLButtonElement>('button.session-history-new-cancel-btn'));
		cancelBtn.textContent = localize('newSession.cancel', "Cancel");
		this.newSessionPanelDisposables?.add(DOM.addDisposableListener(cancelBtn, DOM.EventType.CLICK, () => {
			this._closeNewSessionPanel();
		}));
	}

	private async _confirmNewSession(): Promise<void> {
		const state = this.newSessionState;
		if (!state || state.busy) { return; }
		state.busy = true;

		const agentId = state.agentId;
		const name = state.name.trim();

		// ★ A1 第 4 步（2026-10-19）：**dsh 引擎下新建必须建 dsh 会话**（与聊天框同源）。
		//   否则侧栏建的是 IDE 会话（`sess_xxx`），而聊天框用的是 dsh 会话 ⇒ 仍然两套 ✗ ——
		//   这正是"统一数据源"要消掉的最后一处不一致。
		//   dsh 会话由**宿主**起（页面开不了编辑器）：这里开一个聊天页签并带 preset，
		//   宿主派生会话 id → `session.start` → rebind；侧栏 5s 轮询会看到它。
		//   ⚠ `presetId` 必须走与 dsh 插件**同一套**派生规则（`agentPresetIdOf`），
		//     否则会落到不存在的 preset ⇒ dsh 静默按默认处理 ⇒ 用户选的 agent 白选 ✗。
		if (this.configurationService.getValue<string>('sessions.dshHarness.chatEngine') === 'dsh') {
			const presetId = agentPresetIdOf(agentId);
			try {
				await this.commandService.executeCommand('agentStudio.newChatInEditor', { presetId });
				this.logService.info(`[SessionHistoryView] 新建（dsh 引擎）：已开聊天页签，preset=${presetId}（会话由宿主在 dsh 侧起）`);
				this._closeNewSessionPanel();
				void this._loadSessions();
				return;
			} catch (err) {
				state.busy = false;
				this.logService.warn(`[SessionHistoryView] 新建 dsh 会话失败（不回落 IDE 会话 ⇒ 那会又变成两套）:`, err);
				this.notificationService.error(`新建 dsh 会话失败：${String((err as Error)?.message ?? err)}`);
				return;
			}
		}

		try {
			const created = await this.chatService.createAgentSession(agentId, name || undefined);
			this.logService.info(`[SessionHistoryView] created session ${created.id} for agent ${agentId}`);
			this._closeNewSessionPanel();
			void this._loadSessions();
		} catch (err) {
			state.busy = false;
			this.logService.warn(`[SessionHistoryView] failed to create session for agent ${agentId}:`, err);
		}
	}

	// ─── 运行指示灯（2026-09-15 用户需求）────────────────────────────────────
	//
	// 颜色语义（与用户约定）：
	//   running  → 绿色闪烁（执行中）
	//   awaiting → 黄色闪烁（要求用户交互：clarify 提问 / 工具审批 / 确认框）
	//   done     → 白色常亮（执行完毕），**用户查看后熄灭**
	//   error    → 红色常亮（执行报错）
	//
	// 数据全部来自 `IAgentChatService.onDidStreamDelta` 的全局广播，不新增内核状态。

	/** 收到流式 delta ⇒ 更新指示灯（就地刷新 DOM，不重建列表）。 */
	private _onStreamDelta(agentId: string, sessionId: string, delta: IChatStreamDelta): void {
		const phase = SessionHistoryViewPane._classifyDelta(delta);
		if (!phase) { return; }

		const key = this._sessionKey(agentId, sessionId);
		// delta 是全局广播（含 workflow / 后台任务 / 非本列表会话）⇒ 只关心列表里的
		if (!this.allSessions.some(s => this._sessionKey(s.info.agentId, s.info.sessionId) === key)) { return; }

		const prev = this._runPhases.get(key);
		// 「等待用户」优先级最高：clarify / 审批之后 loop 往往紧接着收尾（done），
		// 若让 done/running 覆盖 awaiting，用户就再也看不到「该你回答了」的提示。
		if (prev === 'awaiting' && (phase === 'done' || phase === 'running')) { return; }

		this._runPhases.set(key, phase);

		if (phase === 'done') {
			// 新一轮完成 ⇒ 清掉「已读」，让白点重新亮起（否则新内容会被当成看过了）
			if (this._readKeys.delete(key)) { this._saveRead(); }
		}

		// ★ 2026-10-12（分组配额带来的新情况）：原本**被「每组 5 条空闲」折叠掉**的会话
		//   现在开始跑了 —— 按口径「运行中始终可见」⇒ 必须重建一次把它顶出来，
		//   否则用户看不到它在跑（就地刷点对它无效，那一行压根没渲染 ✗）。
		//   ⚠ 只在**相位变化**时重建（prev !== phase）：长回合里每个 delta 都重建会抖动 ✗。
		if (prev !== phase && (phase === 'running' || phase === 'awaiting') && !this._isSessionRendered(key)) {
			this._scheduleSilentReload();
			return;
		}

		this._syncRunStateUi();
	}

	/** 该会话当前是否真的渲染在列表里（被 5 条配额折叠掉、或所在分组被折叠时都是 false）。 */
	private _isSessionRendered(key: string): boolean {
		return !!this.sessionListEl?.querySelector(`.session-history-item[data-session-key="${key}"]`);
	}

	/** delta → 指示灯阶段；返回 `undefined` 表示该 delta 不改变灯的状态。 */
	private static _classifyDelta(delta: IChatStreamDelta): SessionRunPhase | undefined {
		switch (delta.type) {
			case 'error':
				return 'error';
			case 'done':
				return 'done';

			// ── 等待用户交互（黄闪）──────────────────────────────────────
			case 'tool_approval_request':
			case 'ask_user_start':
			case 'ask_user_progress':
			case 'questions':
			case 'question_carousel':
			case 'confirmation':
				return 'awaiting';

			case 'phase_change':
				if (delta.phase === 'awaiting_approval') { return 'awaiting'; }
				if (delta.phase === 'error') { return 'error'; }
				if (delta.phase === 'idle') { return 'done'; }
				return 'running';

			// ── 执行中（绿闪）────────────────────────────────────────────
			case 'text':
			case 'thinking':
			case 'tool_start':
			case 'tool_args':
			case 'tool_progress':
			case 'tool_end':
			case 'tool_result':
			case 'progress':
				return 'running';

			default:
				// 其余 delta（memory_* / usage / todos / skill_* / codebase_operation…）
				// 与「这一轮是否在跑」无关 ⇒ 不改灯，避免误报。
				return undefined;
		}
	}

	/** 就地刷新所有 item 的指示灯（列表 DOM 已存在时用；不重建）。 */
	private _syncRunStateUi(): void {
		if (!this.sessionListEl) { return; }
		this.sessionListEl.querySelectorAll('.session-history-item').forEach(el => {
			const item = el as HTMLElement;
			const key = item.getAttribute('data-session-key');
			if (!key) { return; }
			const sessionData = this.allSessions.find(s => this._sessionKey(s.info.agentId, s.info.sessionId) === key);
			if (sessionData) { this._applyDotState(item, key, sessionData); }
		});
	}

	/** 把某个 item 的状态点刷成当前阶段对应的颜色 / 动画。 */
	private _applyDotState(item: HTMLElement, key: string, sessionData: SessionData): void {
		const dot = item.querySelector('.session-history-status-dot') as HTMLElement | null;
		if (!dot) { return; }

		dot.classList.remove('run-running', 'run-awaiting', 'run-done', 'run-error', 'is-read', 'open');

		const phase = this._runPhases.get(key);
		if (!phase) {
			// 无运行状态 ⇒ 回落为「agent 色 + 低透明度」，chat 打开时点亮（原有语义）
			dot.style.setProperty('--agent-color', _getAgentColor(sessionData.info.agentName));
			dot.classList.toggle('open', sessionData.chatOpen);
			dot.title = sessionData.chatOpen
				? `Chat is currently open — ${sessionData.info.agentName}`
				: `Agent: ${sessionData.info.agentName}`;
			return;
		}

		dot.style.removeProperty('--agent-color');

		switch (phase) {
			case 'running':
				dot.classList.add('run-running');
				dot.title = 'Agent is working…';
				break;
			case 'awaiting':
				dot.classList.add('run-awaiting');
				dot.title = 'Waiting for your input';
				break;
			case 'error':
				dot.classList.add('run-error');
				dot.title = 'Last run failed';
				break;
			case 'done': {
				const read = this._readKeys.has(key) || sessionData.chatOpen;
				dot.classList.add('run-done');
				if (read) { dot.classList.add('is-read'); }
				dot.title = read ? 'Completed' : 'Completed — not viewed yet';
				break;
			}
		}
	}

	/** 标记会话已查看（白点熄灭），并持久化。 */
	private _markRead(key: string): void {
		if (this._readKeys.has(key)) { return; }
		this._readKeys.add(key);
		this._saveRead();
		this._syncRunStateUi();
	}

	/** 相对时间（`just now` / `5m` / `3h` / `2d` / 日期）。 */
	private _formatRelativeTime(ts: number): string {
		if (!ts || !Number.isFinite(ts)) { return ''; }
		const diff = Date.now() - ts;
		if (diff < 60_000) { return 'just now'; }
		const minutes = Math.floor(diff / 60_000);
		if (minutes < 60) { return `${minutes}m`; }
		const hours = Math.floor(minutes / 60);
		if (hours < 24) { return `${hours}h`; }
		const days = Math.floor(hours / 24);
		if (days < 30) { return `${days}d`; }
		return new Date(ts).toLocaleDateString();
	}

	private _sessionKey(agentId: string, sessionId: string): string {
		return `${agentId}::${sessionId}`;
	}

	/** Stable ordering: pinned first, then manual order, then updatedAt desc. */
	private _compareSessions(a: SessionData, b: SessionData): number {
		if (a.pinned !== b.pinned) { return a.pinned ? -1 : 1; }
		const aKey = this._sessionKey(a.info.agentId, a.info.sessionId);
		const bKey = this._sessionKey(b.info.agentId, b.info.sessionId);
		const ai = this.sessionOrder.indexOf(aKey);
		const bi = this.sessionOrder.indexOf(bKey);
		if (ai !== -1 || bi !== -1) {
			return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
		}
		return b.info.updatedAt - a.info.updatedAt;
	}

	private _loadPersistedState(): void {
		try {
			const pinnedRaw = this.storageService.get(SessionHistoryViewPane.PINNED_KEY, StorageScope.PROFILE);
			if (pinnedRaw) {
				const arr = JSON.parse(pinnedRaw);
				if (Array.isArray(arr)) {
					for (const k of arr) { if (typeof k === 'string') { this.pinnedSessions.add(k); } }
				}
			}
		} catch { /* ignore corrupt data */ }
		try {
			const orderRaw = this.storageService.get(SessionHistoryViewPane.ORDER_KEY, StorageScope.PROFILE);
			if (orderRaw) {
				const arr = JSON.parse(orderRaw);
				if (Array.isArray(arr)) {
					this.sessionOrder = arr.filter((k): k is string => typeof k === 'string');
				}
			}
		} catch { /* ignore corrupt data */ }
		try {
			// ★ 2026-10-12：折叠的工作区分组（坏值降级为空集 —— 最多是分组全展开，不是列表空白）。
			for (const key of parseStringArray(this.storageService.get(SessionHistoryViewPane.COLLAPSED_GROUPS_KEY, StorageScope.PROFILE))) {
				this._collapsedGroups.add(key);
			}
		} catch { /* ignore corrupt data */ }
		try {
			// 已读集合（运行指示灯：白色「完成未读」点，用户查看后熄灭）
			const readRaw = this.storageService.get(SessionHistoryViewPane.READ_KEY, StorageScope.PROFILE);
			if (readRaw) {
				const arr = JSON.parse(readRaw);
				if (Array.isArray(arr)) {
					for (const k of arr) { if (typeof k === 'string') { this._readKeys.add(k); } }
				}
			}
		} catch { /* ignore corrupt data */ }
	}

	private _savePinned(): void {
		this.storageService.store(SessionHistoryViewPane.PINNED_KEY, JSON.stringify([...this.pinnedSessions]), StorageScope.PROFILE, StorageTarget.USER);
	}

	/** 持久化已读集合（超出上限时淘汰最旧的，避免 storage 无限膨胀）。 */
	private _saveRead(): void {
		try {
			while (this._readKeys.size > SessionHistoryViewPane.MAX_READ_KEYS) {
				const oldest = this._readKeys.values().next().value as string | undefined;
				if (oldest === undefined) { break; }
				this._readKeys.delete(oldest);
			}
			this.storageService.store(SessionHistoryViewPane.READ_KEY, JSON.stringify([...this._readKeys]), StorageScope.PROFILE, StorageTarget.USER);
		} catch { /* ignore quota errors */ }
	}

	/** 持久化折叠的工作区分组（空集直接删键，避免 storage 里留一个 `[]`）。 */
	private _saveCollapsedGroups(): void {
		try {
			if (this._collapsedGroups.size === 0) {
				this.storageService.remove(SessionHistoryViewPane.COLLAPSED_GROUPS_KEY, StorageScope.PROFILE);
			} else {
				this.storageService.store(
					SessionHistoryViewPane.COLLAPSED_GROUPS_KEY,
					JSON.stringify([...this._collapsedGroups]),
					StorageScope.PROFILE,
					StorageTarget.USER,
				);
			}
		} catch { /* ignore quota errors */ }
	}

	private _saveOrder(): void {
		if (this.sessionOrder.length === 0) {
			this.storageService.remove(SessionHistoryViewPane.ORDER_KEY, StorageScope.PROFILE);
		} else {
			this.storageService.store(SessionHistoryViewPane.ORDER_KEY, JSON.stringify(this.sessionOrder), StorageScope.PROFILE, StorageTarget.USER);
		}
	}

	private _showContextMenu(sessionData: SessionData, event: MouseEvent): void {
		const pinned = sessionData.pinned;

		// ★★ 收集本次菜单创建的 Action，菜单关闭即释放（2026-09-15，修 `[LEAKED DISPOSABLE]`）。
		// 泄漏栈：`new Action`（`base/common/actions.ts:74`）← `Object.getActions`
		// （本文件 :1691/:1695/:1698/:1702）← `ContextMenuHandler.showContextMenu` ✓
		// 成因：Action 是 `Disposable`（`Action extends Disposable` ✓），
		// 而 `showContextMenu` **不接管**它们的生命周期 ✗ ⇒ 每次右键泄漏 4 个 Action ✓。
		//
		// ⚠ 两个写法要点（照 MEMORY.md 第 17 条）：
		//   ① Action 必须**提到 `getActions` 外面**创建 ✓ —— 回调可能被调用多次 ✗，
		//      写在回调里会重复创建、且无法与 `onHide` 一一对应 ✓；
		//   ② `IAction` 在本仓**不继承** `IDisposable` ✗ ⇒ 必须 `isDisposable()` 守卫 ✓
		//      （否则 `store.add(a)` 报 TS2741 ✓）。
		const store = new DisposableStore();
		// ★ 2026-10-19：**dsh 会话**不提供「重命名 / 删除」—— 与上面不渲染那两个按钮同一条口径
		//   （dsh 侧没有删除 API；改名也没有可接的通道）⇒ 菜单里给出同样是假入口 ✗。
		const isDsh = sessionData.info.dshSession === true;
		const actions: IAction[] = [
			new Action('sessionHistory.open', localize('openSession', "Open"), undefined, true, () => {
				void this._openSessionChat(sessionData);
			}),
			new Separator(),
			new Action('sessionHistory.pin', pinned ? localize('unpinSession', "Unpin") : localize('pinSession', "Pin"), undefined, true, () => {
				this._togglePin(sessionData);
			}),
			// 重命名：两个来源都有（dsh 走 `renameDshSession` ⇒ 真的落在 dsh 侧 ✓）
			new Action('sessionHistory.rename', localize('renameSession', "Rename"), undefined, true, () => {
				this._triggerRename(sessionData);
			}),
			// 删除：**只有 IDE 会话**（dsh 侧没有删除 API ⇒ 给了就是假入口 ✗）
			...(isDsh ? [] : [
				new Separator(),
				new Action('sessionHistory.delete', localize('deleteSession', "Delete"), undefined, true, () => {
					void this._deleteSession(sessionData);
				}),
			]),
		];
		actions.forEach(a => { if (isDisposable(a)) { store.add(a); } });

		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: event.clientX, y: event.clientY }),
			getActions: () => actions,
			// ⚠ `showContextMenu()` 返回 **void**（不是 Promise）⇒ 不能 `.finally()` ✗；
			//    正确钩子是 delegate 的 `onHide` ✓（`platform/contextview/browser/contextView.ts:43`）
			onHide: () => store.dispose(),
		});
	}

	/**
	 * 稿 A（`+ New session` 行右端 `···`）/ 稿 C（列表空白右键）共用的那枚菜单。
	 *
	 * 只放「清空所有会话…」一项：它是唯一一个**没有别的地方能发起**的动作 ——
	 * 新建会话有那颗大按钮、固定/重命名/删除都在条目右键里 ⇒ 重复入口只会制造第二处漂移点。
	 */
	private _showMoreMenu(event: MouseEvent): void {
		const store = new DisposableStore();
		const clearAll = new Action('sessionHistory.clearAll', localize('clearAllSessions', "Clear all sessions…"), undefined, true, () => {
			this._toggleClearPanel(true);
		});
		// 同 `_showContextMenu`：Action 是 Disposable 但 `IAction` 不继承它 ⇒ 必须 `isDisposable` 守卫。
		if (isDisposable(clearAll)) { store.add(clearAll); }

		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: event.clientX, y: event.clientY }),
			getActions: () => [clearAll],
			onHide: () => store.dispose(),
		});
	}

	// ─────────────────────────────────────────────────────────────────────────
	// 「清空所有会话」（2026-10-19，mockup 稿 A + C；`doc/session-sideview-clear-all-mockup.html`）
	// ─────────────────────────────────────────────────────────────────────────

	/** 开 / 关内联危险面板；与「新建会话」面板互斥（同层两块面板同时开会互相挤 ✗）。 */
	private _toggleClearPanel(open?: boolean): void {
		if (!this.clearPanel) { return; }
		const next = open ?? this.clearPanel.style.display === 'none';
		this.clearPanel.style.display = next ? '' : 'none';
		if (next) {
			if (this.newSessionPanel) { this.newSessionPanel.style.display = 'none'; }
			this._renderClearPanel();
		} else {
			this.clearPanelDisposables?.clear();
		}
	}

	/**
	 * 这次「清空」的**范围**与三类跳过项。
	 *
	 * ⚠ 范围只认 **agent 筛选**，**不认搜索词**：搜索是"找东西"，不是"定义范围" ——
	 *   把"清空所有会话"变成"清空搜索结果"会让名字与结果对不上 ✗（面板里也如实写明 ✔）。
	 * ⚠ 三类跳过：运行/等待中（`_isActiveSession`）、已固定、聊天区**正打开** ——
	 *   打开的会话一律跳过：既有的 `deleteAgentSession` 只删数据、不关编辑器，
	 *   删掉会让聊天区指着一条已不存在的会话 ✗ ⇒ 想删它，请先关掉那个页签（文案里写明 ✓）。
	 */
	private _collectClearTargets(): {
		targets: SessionData[];
		skippedRunning: number;
		skippedPinned: number;
		skippedOpen: number;
		/** 运行中 / 等待中的**总数**（与开关无关 ⇒ 面板上那个数字不随勾选跳变 ✓）。 */
		runningCount: number;
		pinnedCount: number;
	} {
		// 判据在 `common/clearAllPlan.ts`（纯函数 ⇒ 有行为网守卫 ✓）；这里只补"是否运行中"这一项视图事实。
		const plan = planClearAll({
			sessions: this.allSessions.map(s => ({
				agentId: s.info.agentId,
				sessionId: s.info.sessionId,
				pinned: s.pinned,
				chatOpen: s.chatOpen,
			})),
			agentFilter: this.currentAgentFilter,
			skipRunning: this._clearOptions.skipRunning,
			skipPinned: this._clearOptions.skipPinned,
			isActive: (s) => {
				const data = this.allSessions.find(d => d.info.agentId === s.agentId && d.info.sessionId === s.sessionId);
				return !!data && this._isActiveSession(data);
			},
		});
		// 回映射到 `SessionData`（`deleteAgentSession` 要的是 agentId + sessionId）
		const targets = plan.targets
			.map(s => this.allSessions.find(d => d.info.agentId === s.agentId && d.info.sessionId === s.sessionId))
			.filter((d): d is SessionData => !!d);
		return {
			targets,
			skippedRunning: plan.skippedRunning,
			skippedPinned: plan.skippedPinned,
			skippedOpen: plan.skippedOpen,
			runningCount: plan.runningCount,
			pinnedCount: plan.pinnedCount,
		};
	}

	/** 面板标题里写的范围说明（当前 agent 筛选；不带搜索词 —— 见 `_collectClearTargets`）。 */
	private _clearScopeLabel(): string {
		return this.currentAgentFilter || localize('clearAll.scopeAll', "All Agents");
	}

	/** 渲染面板：`confirm` 态 → `running` 态 → `done` 态（三个态各自 `clearNode` 重建，无隐藏分支）。 */
	private _renderClearPanel(stage: 'confirm' | 'running' | 'done' = 'confirm', result?: {
		done: number; skippedRunning: number; skippedPinned: number; skippedOpen: number; failed: { name: string; reason: string }[];
	}): void {
		if (!this.clearPanel) { return; }
		// ⚠ 收窄到局部 const：下面闭包（`skipRow` / `rerenderKeepingInput`）里再用 `this.clearPanel`
		//   TS 就不再收窄（类属性在闭包中可变）⇒ `DOM.append` 报 TS2769 ✗。
		const panel: HTMLElement = this.clearPanel;
		this.clearPanelDisposables?.clear();
		this.clearPanelDisposables = new DisposableStore();
		const store = this.clearPanelDisposables;
		DOM.clearNode(panel);

		const { targets, skippedOpen, runningCount, pinnedCount } = this._collectClearTargets();
		const total = targets.length;

		const head = DOM.append(panel, $('div.session-history-clear-head'));
		head.textContent = localize('clearAll.title', "Clear all sessions");

		// ★ 文案随状态变：结果态再说"将删除 N 个"与屏幕上的事实不符 ✗（MEMORY：可见文案必须描述真发生的事）
		const desc = DOM.append(panel, $('div.session-history-clear-desc'));
		if (stage === 'done') {
			desc.textContent = localize('clearAll.descDone', "Scope: {0}. {1} sessions matched.", this._clearScopeLabel(), result ? result.done : 0);
		} else {
			desc.textContent = localize('clearAll.desc', "Permanently delete {0} sessions and their message history. This cannot be undone. Scope: {1}.", total, this._clearScopeLabel());
		}

		if (stage === 'confirm') {
			// ── 跳过项（各自带真实数量，不许写"部分"这种含糊词）────────────────────
			const skipRow = (id: string, checked: boolean, text: string, onToggle: (v: boolean) => void) => {
				const label = DOM.append(panel, $<HTMLLabelElement>('label.session-history-clear-opt'));
				const box = DOM.append(label, $<HTMLInputElement>('input'));
				box.type = 'checkbox';
				box.id = id;
				box.checked = checked;
				const span = DOM.append(label, $('span'));
				span.textContent = text;
				store.add(DOM.addDisposableListener(box, DOM.EventType.CHANGE, () => onToggle(box.checked)));
			};
			// ⚠ 勾选项切换会重建面板 ⇒ **必须把已输入的确认词带回来**（否则用户勾一下开关就得重打一遍 ✗）
			const rerenderKeepingInput = () => {
				const typed = panel.querySelector<HTMLInputElement>('input.session-history-clear-input')?.value ?? '';
				this._renderClearPanel('confirm');
				const again = panel.querySelector<HTMLInputElement>('input.session-history-clear-input');
				if (again) { again.value = typed; again.dispatchEvent(new Event('input')); }
			};
			skipRow('sh-clear-skip-running', this._clearOptions.skipRunning,
				localize('clearAll.skipRunning', "Skip running / waiting sessions ({0})", runningCount),
				(v) => { this._clearOptions.skipRunning = v; rerenderKeepingInput(); });
			skipRow('sh-clear-skip-pinned', this._clearOptions.skipPinned,
				localize('clearAll.skipPinned', "Keep pinned sessions ({0})", pinnedCount),
				(v) => { this._clearOptions.skipPinned = v; rerenderKeepingInput(); });

			if (skippedOpen > 0) {
				// 这类**没有开关**（没有"安全删掉打开中会话"的路径）⇒ 只做说明，不许给个点了会出事的勾选项 ✗
				const note = DOM.append(panel, $('div.session-history-clear-note'));
				note.textContent = localize('clearAll.skipOpen', "Sessions opened in the chat area are kept ({0}) — close those tabs first if you want them gone.", skippedOpen);
			}

			// ── 强确认：必须手打「清空」两个字 ─────────────────────────────────
			const hint = DOM.append(panel, $('div.session-history-clear-hint'));
			hint.textContent = localize('clearAll.typeToConfirm', "Type {0} to confirm:", localize('clearAll.confirmWord', "清空"));
			const input = DOM.append(panel, $<HTMLInputElement>('input.session-history-clear-input'));
			input.type = 'text';
			input.placeholder = localize('clearAll.confirmWord', "清空");
			input.setAttribute('aria-label', localize('clearAll.typeToConfirm', "Type {0} to confirm:", localize('clearAll.confirmWord', "清空")));

			const actions = DOM.append(panel, $('div.session-history-clear-actions'));
			const cancelBtn = DOM.append(actions, $<HTMLButtonElement>('button.session-history-clear-cancel'));
			cancelBtn.textContent = localize('clearAll.cancel', "Cancel");
			const goBtn = DOM.append(actions, $<HTMLButtonElement>('button.session-history-clear-go'));
			goBtn.textContent = localize('clearAll.go', "Clear {0} sessions", total);
			goBtn.disabled = true;

			const syncGo = () => { goBtn.disabled = input.value.trim() !== localize('clearAll.confirmWord', "清空") || total === 0; };
			store.add(DOM.addDisposableListener(input, DOM.EventType.INPUT, syncGo));
			store.add(DOM.addDisposableListener(cancelBtn, DOM.EventType.CLICK, () => this._toggleClearPanel(false)));
			store.add(DOM.addDisposableListener(goBtn, DOM.EventType.CLICK, () => { void this._runClearAll(); }));
			syncGo();
			input.focus();
			return;
		}

		if (stage === 'running') {
			const bar = DOM.append(panel, $('div.session-history-clear-bar'));
			const fill = DOM.append(bar, $('div.session-history-clear-bar-fill'));
			fill.style.width = '0%';
			const text = DOM.append(panel, $('div.session-history-clear-progress'));
			text.textContent = localize('clearAll.progress', "Deleting… {0} / {1}", 0, total);
			return;
		}

		// ── 结果态：成功 / 跳过（三类分开）/ 失败（可展开原因）─────────────────
		const r = result!;
		const ok = Math.max(0, r.done - r.failed.length);
		const box = DOM.append(panel, $('div.session-history-clear-result'));
		DOM.append(box, $('div.session-history-clear-ok')).textContent = localize('clearAll.resultOk', "✓ Cleared {0} sessions", ok);
		if (r.skippedRunning + r.skippedPinned + r.skippedOpen > 0) {
			const parts: string[] = [];
			if (r.skippedRunning) { parts.push(localize('clearAll.resSkippedRunning', "running {0}", r.skippedRunning)); }
			if (r.skippedPinned) { parts.push(localize('clearAll.resSkippedPinned', "pinned {0}", r.skippedPinned)); }
			if (r.skippedOpen) { parts.push(localize('clearAll.resSkippedOpen', "opened {0}", r.skippedOpen)); }
			DOM.append(box, $('div.session-history-clear-skip')).textContent = localize('clearAll.resultSkipped', "↷ Skipped: {0}", parts.join(' · '));
		}
		if (r.failed.length) {
			DOM.append(box, $('div.session-history-clear-bad')).textContent = localize('clearAll.resultFailed', "✗ Failed {0}", r.failed.length);
			const list = DOM.append(box, $('ul.session-history-clear-fail-list'));
			for (const f of r.failed.slice(0, 8)) {
				DOM.append(list, $('li')).textContent = `${f.name}: ${f.reason}`;
			}
			if (r.failed.length > 8) {
				DOM.append(list, $('li')).textContent = localize('clearAll.moreFailures', "…and {0} more", r.failed.length - 8);
			}
		}
		const actions2 = DOM.append(panel, $('div.session-history-clear-actions'));
		const closeBtn = DOM.append(actions2, $<HTMLButtonElement>('button.session-history-clear-cancel'));
		closeBtn.textContent = localize('clearAll.close', "Close");
		store.add(DOM.addDisposableListener(closeBtn, DOM.EventType.CLICK, () => this._toggleClearPanel(false)));
	}

	/** 真正执行：逐条走既有 `deleteAgentSession`（真删、不可撤销），中途更新进度，失败不吞。 */
	private async _runClearAll(): Promise<void> {
		if (this._clearBusy) { return; }
		const { targets, skippedRunning, skippedPinned, skippedOpen } = this._collectClearTargets();
		if (targets.length === 0) { return; }

		this._clearBusy = true;
		this._renderClearPanel('running');

		const failed: { name: string; reason: string }[] = [];
		let done = 0;
		for (let i = 0; i < targets.length; i++) {
			const s = targets[i];
			const key = this._sessionKey(s.info.agentId, s.info.sessionId);
			try {
				await this.chatService.deleteAgentSession(s.info.agentId, s.info.sessionId);
				this.pinnedSessions.delete(key);
				this.selectedKeys.delete(key);
				this.sessionOrder = this.sessionOrder.filter(k => k !== key);
				this.logService.info(`[SessionHistoryView] clear-all: deleted session ${s.info.sessionId}`);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				failed.push({ name: s.info.sessionName || s.info.sessionId, reason });
				this.logService.warn(`[SessionHistoryView] clear-all: failed to delete session ${s.info.sessionId}:`, err);
			}
			done = i + 1;
			// 进度就地更新（不重建面板 ⇒ 不闪、不丢焦点）
			const fill = this.clearPanel?.querySelector<HTMLElement>('.session-history-clear-bar-fill');
			const text = this.clearPanel?.querySelector<HTMLElement>('.session-history-clear-progress');
			if (fill) { fill.style.width = Math.round(done / targets.length * 100) + '%'; }
			if (text) { text.textContent = localize('clearAll.progress', "Deleting… {0} / {1}", done, targets.length); }
		}

		this._clearBusy = false;
		this._selectionAnchorKey = undefined;
		this._savePinned();
		this._saveOrder();
		await this._loadSessions();
		this._renderClearPanel('done', {
			done: targets.length,
			skippedRunning, skippedPinned, skippedOpen,
			failed,
		});
	}

	private _togglePin(sessionData: SessionData): void {
		const key = this._sessionKey(sessionData.info.agentId, sessionData.info.sessionId);
		if (this.pinnedSessions.has(key)) {
			this.pinnedSessions.delete(key);
		} else {
			this.pinnedSessions.add(key);
		}
		sessionData.pinned = this.pinnedSessions.has(key);
		this._savePinned();
		this.allSessions.sort((a, b) => this._compareSessions(a, b));
		this._applyFilters();
	}

	/** 删除按钮入口：属于多选集合时删除整个集合，否则只删除该项。 */
	private async _deleteSessionsForItem(sessionData: SessionData): Promise<void> {
		const key = this._sessionKey(sessionData.info.agentId, sessionData.info.sessionId);
		const targets = this.selectedKeys.has(key) && this.selectedKeys.size > 1
			? this._getSelectedSessions()
			: [sessionData];
		await this._deleteSessions(targets);
	}

	private async _deleteSession(sessionData: SessionData): Promise<void> {
		await this._deleteSessions([sessionData]);
	}

	/**
	 * 删除一个或多个会话（带确认框）。
	 * 多选时确认文案写明数量，避免「只点了一个按钮却删掉一堆」的意外。
	 */
	private async _deleteSessions(sessions: SessionData[]): Promise<void> {
		if (sessions.length === 0) { return; }

		const single = sessions.length === 1;
		const confirmed = await this.dialogService.confirm({
			message: single
				? localize('deleteSession.confirm', "Delete session '{0}'?", sessions[0].info.sessionName || 'Untitled Session')
				: localize('deleteSessions.confirm', "Delete {0} selected sessions?", sessions.length),
			detail: localize('deleteSession.detail', "This permanently deletes the session and its message history. This action cannot be undone."),
			primaryButton: localize('delete', "Delete"),
		});
		if (!confirmed.confirmed) { return; }

		for (const sessionData of sessions) {
			const { agentId, sessionId } = sessionData.info;
			try {
				await this.chatService.deleteAgentSession(agentId, sessionId);
				this.logService.info(`[SessionHistoryView] deleted session ${sessionId}`);
				const key = this._sessionKey(agentId, sessionId);
				this.pinnedSessions.delete(key);
				this.selectedKeys.delete(key);
				this.sessionOrder = this.sessionOrder.filter(k => k !== key);
			} catch (err) {
				this.logService.warn(`[SessionHistoryView] failed to delete session ${sessionId}:`, err);
			}
		}

		this._selectionAnchorKey = undefined;
		this._savePinned();
		this._saveOrder();
		await this._loadSessions();
	}

	/** Trigger rename from the context menu — find the rendered title element and start inline edit. */
	private _triggerRename(sessionData: SessionData): void {
		const { agentId, sessionId } = sessionData.info;
		const items = this.sessionListEl?.querySelectorAll<HTMLElement>('.session-history-item');
		items?.forEach((itemEl) => {
			if (itemEl.getAttribute('data-session-id') === sessionId && itemEl.getAttribute('data-agent-id') === agentId) {
				const titleEl = itemEl.querySelector<HTMLElement>('.session-history-title');
				if (titleEl) {
					this._startRenameSession(sessionData, titleEl, itemEl);
				}
			}
		});
	}

	/**
	 * 注入打开会话的目标 group 解析器（供独立聊天窗口的会话侧栏使用）。
	 * 传 `undefined` 恢复默认行为（主窗口 Agent 编辑器区）。
	 */
	setOpenGroupResolver(resolver: (() => IEditorGroup | undefined) | undefined): void {
		this._openGroupResolver = resolver;
	}

	/**
	 * 打开会话聊天时使用的目标 group。
	 *
	 * 默认 = 主窗口的 Agent 编辑器区（`agentPart`）。独立聊天窗口里的那份
	 * 会话侧栏会通过 `setOpenGroupResolver()` 覆写，让双击会话在**本窗口**内
	 * 打开，而不是跑回主窗口。
	 */
	protected getPreferredOpenGroup(): IEditorGroup | undefined {
		if (this._openGroupResolver) {
			return this._openGroupResolver();
		}
		const agentPart = (this.editorGroupsService as unknown as { agentPart?: IEditorGroupsService }).agentPart;
		return agentPart?.activeGroup;
	}

	private async _openSessionChat(sessionData: SessionData): Promise<void> {
		const { agentId, sessionId, sessionName } = sessionData.info;

		// 打开即视为「已查看」⇒ 完成态白点熄灭（用户需求）
		this._markRead(this._sessionKey(agentId, sessionId));

		// ★ 2026-10-19：**dsh 会话**不能走 IDE 的 `NativeChatEditorInput`（那条读的是
		//   `chat-history/<agent>/<sessionId>.json`，dsh 会话根本没有这个文件 ⇒ 打开即空 ✗）。
		//   正确路径 = 让聊天宿主 rebind（与页面里点历史会话同一条路）。
		if (sessionData.info.dshSession) {
			const ok = await this.dshHarness?.openDshSessionChat(sessionId) ?? false;
			if (!ok) {
				this.notificationService.info(
					'这是 dsh 会话：请先在聊天框区域打开一个聊天页签，再点它切换（当前窗口没有可用的聊天视图）。',
				);
			}
			return;
		}

		// Already open: reveal the tab and focus its input box.
		const openEditor = this._findOpenEditorForSession(agentId, sessionId);
		if (openEditor) {
			await this.editorService.openEditor(openEditor.editor, { pinned: true, revealIfOpened: true }, openEditor.groupId);
			openEditor.pane.focusInput();
			return;
		}

		// Not open: create a new editor input, open it in a **new group**, then focus the input.
		const displayName = `${agentId} (${sessionName})`;
		const input = NativeChatEditorInput.create(`session-history-${sessionId}`, agentId, sessionId, displayName);
		await this._openChatInNewGroup(input);
		const opened = this._findOpenEditorForSession(agentId, sessionId);
		if (opened) {
			opened.pane.focusInput();
		}
	}

	/** 聊天框所在的 editor part（主窗口 = Agent 编辑器区 `agentPart`；独立窗口没有这个属性）。 */
	private get _chatEditorPart(): IEditorGroupsService | undefined {
		return (this.editorGroupsService as unknown as { agentPart?: IEditorGroupsService }).agentPart;
	}

	/**
	 * ★ 2026-09-22（用户需求）：把聊天编辑器打开在一个**新建的 group** 里。
	 *
	 * 为什么：原来直接 `targetGroup.openEditor(...)`，而**一个 group 同时只能有一个 active
	 * editor** ⇒ 会把用户**正在看的那个聊天框顶掉** ✗。改为在聊天框区域里从基准 group
	 * **向右分裂出一个新 group**，新聊天框显示在新分屏中，原有聊天框原样保留 ✓。
	 *
	 * ⚠ 独立聊天窗口（popout）里**不新建 group**：那里只有一个 group，分裂会把本就很窄的
	 *   窗口切成两半 ✗ ⇒ 该场景（`_openGroupResolver` 已被注入）沿用"在当前 group 打开"。
	 *
	 * ⚠ 连续打开多个未打开的会话会**逐次累积分屏**（每次 +1 个 group）—— 这是"新建 group"
	 *   规格的直接结果；若将来想限制，可在此处改为「复用聊天区里第一个空 group」。
	 */
	private async _openChatInNewGroup(input: NativeChatEditorInput): Promise<void> {
		const baseGroup = this.getPreferredOpenGroup();
		const part = this._chatEditorPart;

		// 独立窗口 / 聊天区不存在 ⇒ 只能就地打开
		if (this._openGroupResolver || !part) {
			if (baseGroup) {
				await baseGroup.openEditor(input, { pinned: true });
			} else {
				await this.editorService.openEditor(input, { pinned: true });
			}
			return;
		}

		// 分裂基准：优先 `getPreferredOpenGroup()`（= 聊天区 active group），否则该区域当前 active
		const anchor = baseGroup ?? part.activeGroup;
		if (!anchor) {
			await this.editorService.openEditor(input, { pinned: true });
			return;
		}

		let targetGroup: IEditorGroup;
		try {
			targetGroup = part.addGroup(anchor, GroupDirection.RIGHT);
		} catch (err) {
			// addGroup 失败（group 已失效等）⇒ 退化为就地打开，别把这次双击吞掉
			this.logService.warn('[SessionHistoryView] addGroup failed, falling back to existing group:', err);
			await anchor.openEditor(input, { pinned: true });
			return;
		}

		await targetGroup.openEditor(input, { pinned: true });
	}

	private _reorderSession(draggedKey: string, targetKey: string): void {
		const currentKeys = this.filteredSessions.map(s => this._sessionKey(s.info.agentId, s.info.sessionId));
		const fromIdx = currentKeys.indexOf(draggedKey);
		if (fromIdx < 0) { return; }
		currentKeys.splice(fromIdx, 1);
		const toIdx = currentKeys.indexOf(targetKey);
		if (toIdx < 0) { return; }
		currentKeys.splice(toIdx + 1, 0, draggedKey);
		this.sessionOrder = currentKeys;
		this._saveOrder();
		this.allSessions.sort((a, b) => this._compareSessions(a, b));
		this._renderSessionList();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	override focus(): void {
		super.focus();
	}
}
