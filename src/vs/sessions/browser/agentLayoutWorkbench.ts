/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../base/common/errors.js';
import { Emitter, Event } from '../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../base/common/lifecycle.js';
import { IntervalTimer, RunOnceScheduler } from '../../base/common/async.js';
import { ISerializableView, ISerializedGrid, Orientation } from '../../base/browser/ui/grid/grid.js';
import { Workbench } from '../../workbench/browser/workbench.js';
import { Parts } from '../../workbench/services/layout/browser/layoutService.js';
import { IPaneCompositePart } from '../../workbench/browser/parts/paneCompositePart.js';
import { IEditorGroup, IEditorGroupsService, EditorGroupLayout } from '../../workbench/services/editor/common/editorGroupsService.js';
import { GroupModelChangeKind } from '../../workbench/common/editor.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { ILogService } from '../../platform/log/common/log.js';
import { AgentStudioEditorInput } from '../contrib/agentStudio/browser/agentStudioEditorInput.js';
import { NativeChatEditorInput } from '../contrib/agentStudio/browser/nativeChatEditorInput.js';
import { createAgentsLayoutGridDescriptor } from './layoutProfile.js';
import { getAgentEditorParts } from './parts/agentEditorParts.js';

/**
 * ★ 聊天框布局的持久化结构 —— 与 sessions 版
 * （`sessions/browser/workbench.ts` 的 `IAgentChatLayoutState`）**同一 key、同一形状**，
 * 便于两套窗口共用同一份状态（互不冲突：key 里含 workspace 作用域）。
 */
interface IAgentChatLayoutState {
	groupCount: number;
	/** 各组宽度比例（`agentPart.getLayout()` 原样快照）；缺省时退回等宽。 */
	layout?: EditorGroupLayout;
	/** 上次激活的 group 下标；恢复后聚焦它。 */
	activeGroupIndex?: number;
	editors: Array<{
		chatId: string;
		agentId?: string;
		sessionId?: string;
		name?: string;
		groupIndex: number;
		cliMode?: boolean;
	}>;
}

/**
 * [Saros] 「IDE 底座 + Agent 布局」的 Workbench 实现。
 *
 * 它**继承标准 `Workbench`**（不是 sessions 那个），因此拿到的是标准窗口的全套
 * services / 启动流程 / 贡献，只替换**布局**与**额外 part**。这正是该方案的要点：
 * 底座是 upstream 的，Agent 只作为一层布局叠加。
 *
 * 由 `AgentLayoutDesktopMain.getWorkbenchConstructor()` 返回（入口换实现，见
 * `sessions/electron-browser/agentLayoutDesktopMain.ts`），所以**不影响**标准 IDE 窗口
 * —— 那边仍然 `new Workbench(...)`。
 */
export class AgentLayoutWorkbench extends Workbench {

	/**
	 * ★ 把 agents 布局需要的额外 part 交给 `viewMap`。
	 *
	 * ── 为什么必须是这个方法 ──────────────────────────────────────────
	 *
	 * `Layout.createWorkbenchLayout()` 是**先建 `viewMap`、再 `deserialize`** 的：
	 * `fromJSON = ({type}) => viewMap[type]`，取到 `undefined` 会让
	 * `SerializableGrid.deserialize` **直接抛错**（表现成"窗口开不起来"，不是
	 * "部件不显示"）。所以 agents grid 引用的 `Parts.AGENT_EDITOR_PART` 必须在
	 * `viewMap` 组装**之前**就存在。
	 *
	 * 而 `createAdditionalPartViews()` 恰好被调用在那个位置，且它在
	 * `Workbench.startup()` 的 `renderWorkbench()`（`:172`）之后、
	 * `createWorkbenchLayout()`（`:175`）之内 ⇒ 是唯一能"同步实例化 + 注册"的窗口。
	 *
	 * ── 为什么用模块级访问器拿宿主 ────────────────────────────────────
	 *
	 * `workbench/browser/layout.ts` 里**根本没有 `instantiationService`**，本类
	 * 拿不到 DI，无法自己 `createInstance(AgentEditorPart, ...)`。而
	 * `IEditorGroupsService` 是 `InstantiationType.Eager` 单例，构造早于本方法，
	 * 所以从 `getAgentEditorParts()` 取一次即可。
	 *
	 * ⚠ `Part` 基类构造即 `layoutService.registerPart(this)`
	 * （`workbench/browser/part.ts:60`）—— 也就是说**「注册」= 「实例化」**，
	 * 这一次 `agentPart` 访问就是全部动作。
	 */
	protected override createAdditionalPartViews(): Record<string, ISerializableView> {
		const agentEditorParts = getAgentEditorParts();
		if (!agentEditorParts) {
			// 理论上不可达：Eager 单例在 InstantiationService 构造时就实例化。
			// 真走到这里说明注册顺序被改坏（见 `agentEditorParts.ts` 文件头）。
			// 此时**必须报错**而不是返回 `{}` —— 后者会退化成
			// `SerializableGrid.deserialize` 内部抛出的、极难定位的 undefined 错误。
			throw new Error('[Saros] AgentEditorParts 尚未实例化，无法提供 Parts.AGENT_EDITOR_PART');
		}

		// ★ activity bar 不在这里建 —— 它的注册必须更早（`renderWorkbench()` 的部件循环里
		// 标准那 8 个部件含 `ACTIVITYBAR_PART`，会先 `getPart()` 一次）。见
		// `getAdditionalPartsToRender()`。标准 `viewMap` 里本来就有它的条目。
		// ★★ 必须**包一层**覆写 `maximumWidth`，否则右栏边框**拖不动**（见类注释）。
		//
		// ⚠⚠ 上限**不能取「半窗」**（2026-09-15 真机实测修正）：
		// 最初这里写的是 `max(220, innerWidth / 2)`（照搬 sessions 的"最多半窗"设计），
		// 但 sessions 的右栏**默认宽度就是半窗** ⇒ 启动即顶到上限 ⇒ 边框**向左拖不动**
		// （向左 = 加宽右栏 ✓，正是用户报的症状 ✗）。
		// 真机证据（窗口 2560×1392）：`agentEditor 1280×1357` = 恰好 `innerWidth/2` ✓，
		// 且该边界的 sash 被打上 `minimum` 标记 ⇒ 拖拽被夹住 ✓。
		//
		// ⇒ 改为「给左邻留出最小宽度后**不再额外设限**」：右栏可以一直加宽到
		// 编辑器列撞上它自己的 `minimumWidth` 为止 —— 那个下限由 grid 依据编辑器视图
		// 自身的 `minimumWidth` 自动夹住 ✓，无需我们在这里重复设限 ✗。
		return {
			[Parts.AGENT_EDITOR_PART]: new AgentEditorMaxWidthView(
				agentEditorParts.agentPart,
				() => {
					// 至少留 48（侧栏折叠宽）+ 320（编辑器列最小宽）给左侧，
					// 其余全给右栏 ⇒ 边框左右都能拖 ✓。
					const reservedForLeft = 48 + 320;
					return Math.max(320, window.innerWidth - reservedForLeft);
				},
			),
		};
	}

	/**
	 * ★ 用 agents 的 grid 替换标准布局 —— 这就是「Agent 布局」本身。
	 *
	 * grid 本体是**纯函数** `createAgentsLayoutGridDescriptor()`
	 * （`sessions/browser/layoutProfile.ts`），与 agents 窗口用的是**同一份实现**
	 * ⇒ 两个窗口不会漂移（`sessionsConfigIsolation.test.ts` 有专门用例锁这一点）。
	 *
	 * 状态映射全部来自 `Layout.getAgentsLayoutState()` —— 本类不直接读
	 * `stateModel` / `titleBarPartView`（对子类未必可见，且要额外 import
	 * `LayoutStateKeys`）。所以这里只剩"注入 part id"这一件事。
	 *
	 * ⚠ 这里出现的每个 `Parts.*` 都必须已在 `createAdditionalPartViews()` 里备好
	 * 实例，否则 `SerializableGrid.deserialize` 会因为 `fromJSON` 取到 `undefined`
	 * 而直接抛错。
	 */
	/**
	 * ★ 把 `AGENT_EDITOR_PART` 追加进渲染列表。
	 *
	 * ⚠ 这一步**不可省**：`Workbench.renderWorkbench()` 的部件循环是**唯一**调用
	 * `part.create(parent)` 的地方，而 `EditorPart` 的内部 grid 正是在 `create()` 里建立的。
	 * 只在 `createAdditionalPartViews()` 里 `registerPart` 而不在这里渲染，grid 解出来时
	 * 会拿到一个未初始化的视图（`onDidChange` getter 读 undefined）—— 真机验证过，
	 * 崩在 `SerializableGrid.deserialize`。
	 *
	 * 时序：本方法（`renderWorkbench`，`workbench.ts:172`）**早于**
	 * `createAdditionalPartViews()`（`createWorkbenchLayout()`，`:175`），
	 * 所以到这里 `agentPart` 已经 `create()` 完毕。
	 */
	protected override getAdditionalPartsToRender(): { id: Parts; role: string; classes: string[]; options?: { restorePreviousState?: boolean } }[] {
		const agentEditorParts = getAgentEditorParts();
		if (!agentEditorParts) {
			throw new Error('[Saros] AgentEditorParts 尚未实例化，无法渲染 Parts.AGENT_EDITOR_PART');
		}

		// ★ 必须先真的取一次 `agentPart`：它是**惰性 getter**，而 `Part` 基类构造即
		// `layoutService.registerPart(this)` —— 不实例化就不会注册，紧接着
		// `renderWorkbench` 的循环里 `getPart(Parts.AGENT_EDITOR_PART)` 会抛
		// `Unknown part workbench.parts.agentEditor`（真机验证过）。
		void agentEditorParts.agentPart;

		// ★ activity bar 必须**在这里**创建（本方法在 `renderWorkbench()` 里被调用，
		// 而 `renderWorkbench()` 早于 `createWorkbenchLayout()`）。
		//
		// 本方法的循环随后会取**标准那 8 个部件**（含 `ACTIVITYBAR_PART`）并 `create()` 它们；
		// 而 sessions 的 `SidebarPart` 不自建 activity bar（它把图标条折进侧栏）
		// ⇒ 不在这里补建，`getPart(Parts.ACTIVITYBAR_PART)` 就会抛 `Unknown part`
		// 并中断整个 startup（真机验证过）。
		//
		// 标准 `viewMap` 里本来就有 `[Parts.ACTIVITYBAR_PART]`，所以**不需要**在
		// `createAdditionalPartViews()` 里重复注入（重复创建会产生两个部件实例）。
		void agentEditorParts.createActivityBarPart(
			this.getPart(Parts.SIDEBAR_PART) as unknown as IPaneCompositePart,
		);

		return [{
			id: Parts.AGENT_EDITOR_PART,
			role: 'main',
			classes: ['editor'],
			options: { restorePreviousState: false },
		}];
	}

	/**
	 * ★ 隐藏**记账部件**的 DOM。
	 *
	 * ── 为什么必须单独做这一步 ────────────────────────────────────────
	 *
	 * grid 里把 activity bar / aux bar / statusbar 标成 `visible: false` 只表示
	 * **grid 不布局它们**，**不等于 DOM 被隐藏**：这三个部件从未"可见过"，
	 * grid 也就不会对它们调用内部的 `ViewItem.setVisible(false)`，于是它们的元素
	 * 留在容器里、按自身 CSS（`.part { position: absolute }`）渲染 ⇒ 表现为
	 * **左边多出一条图标条 / 底部多一条状态栏**（真机验证：截图里左侧那条 activity bar）。
	 *
	 * ⚠ 不能用 `part.setVisible(false)` —— `Part.setVisible()` **不碰 DOM**，
	 * 它只 `this._onDidVisibilityChange.fire(visible)`（`workbench/browser/part.ts:193`）。
	 * 隐藏 DOM 的职责在 grid 的 `ViewItem` 上，所以这里直接置 `display: none`。
	 *
	 * 不影响记账：`Layout` 读的是部件**属性**（`activityBarPartView.minimumWidth`）与
	 * grid 的**缓存尺寸**（`getViewCachedVisibleSize`），都与 DOM 无关。
	 */
	/**
	 * ★★ agents 布局：**不要恢复 panel 的默认视图容器** —— 与 agents 窗口一致（底部没有 panel）。
	 *
	 * ── 为什么必须在**源头**拦住，而不是在 `restoreParts()` 之后再隐藏 ────────
	 *
	 * `Layout.initializeLayoutState()` 一旦记下 `containerToRestore.panel`，
	 * `restoreParts()` 里的"Restore Panel"任务就会在 **`restoreParts()` 返回之后**
	 * （它被推进 `layoutReadyPromises`，是 fire-and-forget，`await` 不到）调用
	 * `openViewContainer(Panel, …)` **把 panel 显示出来**。
	 *
	 * ⇒ 所以"在 `super.restoreParts()` 之后 `setPartHidden(true, PANEL_PART)`"**不可靠**：
	 * 隐藏发生在前、显示发生在后（真机确认 —— 这也是上一轮修了但没生效的原因）。
	 * 在源头不记录这个待恢复项，第 2 步就会直接 `return`。
	 */
	/**
	 * ★ agents 布局：侧栏在"用户从没选过容器"时打开 **Agent Studio** 的
	 * `agentStudio.workspace`（`contrib/agentStudio/browser/agentStudio.contribution.ts:3445`
	 * —— 侧栏容器、`isDefault: true`、`order: 10`），而不是标准底座的默认容器。
	 *
	 * ── 为什么必须换 ──────────────────────────────────────────────────
	 * 标准 `Layout.initializeLayoutState()`（`layout.ts:764` 起）决定侧栏恢复哪个容器：
	 * 取 storage 里的 `activeViewlet`，**否则**取 `getDefaultViewContainer(Sidebar)`。
	 * 我们继承的是标准 `Workbench` ⇒ 那个 fallback 是 **Explorer（资源管理器）**
	 * ⇒ `restoreParts()` 里推进 `layoutReadyPromises` 的 "Restore Sidebar" 任务
	 * 会把**文件树**打开，activity bar 也只剩标准那套（真机症状：侧栏变成文件浏览器、
	 * agent 的图标全不见）。
	 *
	 * ⚠ 这个缺口**原本被 `zenMode` 那个 ERR 掩盖着** —— `restoreParts()` 在那之前就中断了，
	 * 这一步根本没跑（当时侧栏是"两个图标 + 空内容"）。修好 ERR 之后它才露出来，
	 * 所以**不是** `try/finally` 引入的。
	 *
	 * ⚠ 只改 **fallback**：storage 里有值（用户选过容器）时仍以用户选择为准。
	 */
	protected override getAgentsSidebarDefaultContainerId(): string | undefined {
		return 'agentStudio.workspace';
	}

	protected override shouldRestorePanelViewContainer(): boolean {
		return false;
	}

	/**
	 * ★★ agents 布局：左上角收缩按钮 → **保留 activity bar、只折叠 side view**。
	 *
	 * 标准 `setPartHidden(true, SIDEBAR_PART)` → `setSideBarHidden(true)` 会把
	 * **整条侧栏**（含 48px 图标条）从 grid 隐掉 —— 真机症状：点一下收缩按钮，
	 * activity bar 也一起消失。
	 *
	 * sessions 窗口把这条路径**拦截**成"切内容区折叠态"；我们继承的是**标准**
	 * `Workbench` ⇒ 必须显式打开这个开关（见 `Layout.setPartHidden()` /
	 * `Layout.collapseAgentsSidebarContent()`）。
	 */
	protected override shouldCollapseAgentsSidebarInsteadOfHiding(): boolean {
		return true;
	}

	/**
	 * ★ agents 布局：启动后**展开侧栏内容区**（否则只剩 48px 图标条）。
	 *
	 * 放在 `restoreParts()` **之后**：那一步会恢复侧栏的视图容器（可能影响它的状态），
	 * 展开放在其后才不会被它覆盖。
	 *
	 * 注：sessions 侧栏的"展开"包含两件事 —— 切它自己的状态（`setContentCollapsed(false)`）
	 * 与 resize grid 节点；两件都在 `Layout.expandAgentsSidebarContent()` 里做，
	 * 因为 `workbenchGrid` 只在 `Layout` 作用域内可见。
	 */
	protected override async restoreParts(): Promise<void> {
		// ⚠⚠ **必须 try/finally，不能顺序 await**。
		//
		// `super.restoreParts()` 会在 `getZenModeConfiguration(this.configurationService).restore`
		// 那行**抛错**（`zenMode` 配置没进默认值模型 —— 真机日志有这条 ERR）。一旦它抛出，
		// `await` 直接拒绝 ⇒ 下面那句**根本不会执行**。
		// 实测踩过：写成顺序 `await super(); this.expand…()` 时，侧栏几何量**一直是 48×254**，
		// 与改动前逐字相同（编译产物里确认新方法在，进程也是新起的，所以不是缓存问题）。
		//
		// 而且上游那一步**后面还有** zen mode 恢复 / 编辑器居中 /
		// `Promises.settled(layoutReadyPromises)` 收尾，全都会被一起跳过。
		// 展开侧栏**不该**依赖上游那一步是否跑完。
		//
		// 这里**不吞异常**：`finally` 里只做自己的事，错误照旧向上抛，
		// 以免把上游那个 ERR 藏起来（那是另一条线要单独修的）。
		try {
			await super.restoreParts();
		} finally {
			this.expandAgentsSidebarContent();

			// ⚠ 这里**不再**搬 activity bar —— 侧栏自己的条已带 11 个条目，
			// 再搬一条会重复渲染两套图标（真机截图：两列图标 + 滚动条）。
			//
			// 留此注释是因为这里踩过一个**关键坑**（值得记住）：
			// 之前在这里搬完并 `activityBar.layout(48, h, 0, 0)`，而 `h` 取的是
			// `stripContainer.clientHeight` —— 它在 `createWorkbenchLayout()` 那一刻是 **0**
			// ⇒ 被 `if (height > 0)` 跳过 ⇒ 那条 bar 停在**内容高度 44px**
			// ⇒ **11 个条目全被挤进溢出菜单**（条里只剩 "Additional Views"）。
			// ⇒ 判据：**条里出现 "Additional Views" 就是"高度不够、条目被 overflow 收走"**，
			//   而不是"条目没进条"。

			// ★ ④ 右栏出聊天 —— 同上：上游那一步抛错也不该让它被跳过。
			// fire-and-forget：`restoreParts()` 的语义是同步的，而"打开编辑器"是异步的
			// （sessions 版也是这么做的：`this._openAgentStudioEditors().catch(...)`，
			// 见 `sessions/browser/workbench.ts:1205`）。
			//
			// ★ 2026-09-15：改为 `restoreAgentsChatLayout()` —— 先尝试**恢复上次的
			// 聊天框布局**（多聊天框 / 分屏 / 会话），读不到才退回 `openAgentsChat()`
			// 的「默认单 Chat」。此前这里直接调 `openAgentsChat()` ⇒ 每次启动都只剩
			// 一个默认聊天框（用户报「重启后聊天框没有恢复原样 / group 数量不对」）。
			this.restoreAgentsChatLayout().catch(error => onUnexpectedError(error));
		}
	}

	/**
	 * ★ ④ agents 布局：把 Agent Studio 的 **Chat** 开进右栏（`AGENT_EDITOR_PART`）。
	 *
	 * 右栏在 agents 窗口里承载 Agent Studio；我们这套入口下它是空的
	 * （真机截图：右列只有 `No editors open` 水印）。
	 *
	 * 照搬 sessions 版「Single Chat layout（每次启动）」分支
	 * （`sessions/browser/workbench.ts:1677-1705`）：
	 * 取 `agentPart.activeGroup` → 清掉残留 → `openEditor(AgentStudioEditorInput.getOrCreate('chat'))`。
	 * 我们的 `AGENT_EDITOR_PART` 建时就是 `restorePreviousState: false`（见
	 * `getAdditionalPartsToRender()`），所以每次启动都是"单个空组"，
	 * 与 sessions 那条分支的前提**完全一致**，可以直接照搬。
	 *
	 * ⚠ `AgentStudioEditorInput.getOrCreate('chat')` 是**单例**（同 panelType 返回同一实例），
	 * 所以这里先清掉组内残留的 AgentStudio 编辑器，避免"同一个实例挂在两个位置"。
	 *
	 * ⚠ `agentPart` 这个成员只有 sessions 版 `EditorGroupService` 才有，
	 * 所以按 `agentStudio.contribution.ts:308` 的同类做法做一次**结构化鸭子类型**转换，
	 * 而不是 import sessions 的类型（也免得在标准 IDE 窗口里出问题 —— 那边
	 * `getAgentEditorParts()` 本来就取不到，会直接 return）。
	 */
	protected async openAgentsChat(): Promise<void> {
		const agentPart = getAgentEditorParts()?.agentPart as unknown as IEditorGroupsService | undefined;
		if (!agentPart) {
			return;
		}

		const group = agentPart.activeGroup;
		const stale = group.editors.filter(editor => editor instanceof AgentStudioEditorInput);
		if (stale.length > 0) {
			await group.closeEditors(stale, { preserveFocus: true });
		}

		try {
			await group.openEditor(AgentStudioEditorInput.getOrCreate('chat'), { pinned: true, sticky: true });
		} catch (error) {
			onUnexpectedError(error);
		}
	}

	//#region ★ 聊天框布局持久化（2026-09-15 新增）
	//
	// ── 为什么必须在这里补一份 ──────────────────────────────────────────
	// 桌面 app 的窗口由**本类**承载（`agentLayoutDesktopMain.ts` 的
	// `getWorkbenchConstructor()` 返回 `AgentLayoutWorkbench`），而
	// `sessions/browser/workbench.ts` 只被 **web 构建**与旧的 `sessions.main.ts` 使用
	// ⇒ 那边的 `_storeAgentChatLayout` / `_restoreAgentChatLayout`
	// （key `vssaros.agentChatLayout.v1`）**在桌面 app 里从不执行**。
	// 本类此前只有 `openAgentsChat()`（等价于 sessions 版那条「每次启动都只开默认
	// 单 Chat」的分支）⇒ 用户新建的聊天框 / 分屏结构 / 会话全部丢失 —— 这正是
	// 「重启后聊天框没有恢复原样 / group 数量不对」的根因。
	//
	// ── 与 sessions 版同一 key / 同一语义，外加三条实测要点 ──────────────
	// ① **不能只在退出时保存**：本 app 常被 dev 脚本 / 任务管理器**强杀**（走不到
	//    SHUTDOWN flush），且实测会话期间 `onWillSaveState` 也不触发
	//    ⇒ 必须「变更即写 + 定期兜底写（20s，内容未变则跳过）」。
	// ② 恢复后**回写**（不删 key），保证磁盘状态恒等于界面状态。
	// ③ 恢复完成前**禁止写盘**（`_chatLayoutReady`），否则启动早期的 flush 会用
	//    「空布局」覆盖待恢复状态。
	//
	// 诊断日志统一 `[Sarosis][AgentChatLayout]` 前缀（与 sessions 版一致）：
	// 直接 grep `renderer.log` 即可判定「没存」还是「没恢复」。
	private static readonly AGENT_CHAT_LAYOUT_KEY = 'vssaros.agentChatLayout.v1';

	private _chatLayoutReady = false;
	private _lastStoredChatLayout: string | undefined;
	private readonly _chatLayoutDiagLogged = new Set<string>();
	private readonly _chatLayoutDisposables = this._register(new DisposableStore());
	private _chatLayoutServicesCache: { storage: IStorageService; log: ILogService } | undefined;

	/** 取持久化所需服务（借 `AgentEditorParts` 的 DI，见其 `instantiation` getter）。 */
	private _chatLayoutServices(): { storage: IStorageService; log: ILogService } | undefined {
		if (!this._chatLayoutServicesCache) {
			const parts = getAgentEditorParts();
			this._chatLayoutServicesCache = parts?.instantiation.invokeFunction(accessor => ({
				storage: accessor.get(IStorageService),
				log: accessor.get(ILogService),
			}));
		}
		return this._chatLayoutServicesCache;
	}

	private _chatLayoutLog(message: string): void {
		this._chatLayoutServices()?.log.info(`[Sarosis][AgentChatLayout] ${message}`);
	}

	/** 同一原因只打一次（定期保存每 20s 调用一次，避免刷屏）。 */
	private _chatLayoutLogOnce(key: string, message: string): void {
		if (this._chatLayoutDiagLogged.has(key)) {
			return;
		}
		this._chatLayoutDiagLogged.add(key);
		this._chatLayoutLog(message);
	}

	/** 读盘 + 解析（含诊断日志）。 */
	private _readAgentsChatLayout(): IAgentChatLayoutState | undefined {
		this._chatLayoutLog('restore: ENTER (AgentLayoutWorkbench)');
		const services = this._chatLayoutServices();
		if (!services) {
			this._chatLayoutLog('restore: ABORT — 拿不到 IStorageService（AgentEditorParts 未实例化）');
			return undefined;
		}
		const raw = services.storage.get(AgentLayoutWorkbench.AGENT_CHAT_LAYOUT_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			this._chatLayoutLog('restore: no persisted state → fall back to default single Chat layout');
			return undefined;
		}
		try {
			const parsed = JSON.parse(raw) as IAgentChatLayoutState;
			if (parsed && typeof parsed.groupCount === 'number' && Array.isArray(parsed.editors)) {
				// 可选字段形状不对时就地丢弃，而不是让整份状态失效。
				if (parsed.layout && !Array.isArray(parsed.layout.groups)) {
					parsed.layout = undefined;
				}
				if (typeof parsed.activeGroupIndex !== 'number') {
					parsed.activeGroupIndex = undefined;
				}
				this._lastStoredChatLayout = raw;
				this._chatLayoutLog(`restore: groupCount=${parsed.groupCount} editors=${parsed.editors.length} sizes=${parsed.layout ? 'yes' : 'no'} active=${parsed.activeGroupIndex ?? '-'}`);
				return parsed;
			}
			this._chatLayoutLog(`restore: malformed state ignored (${raw.slice(0, 200)})`);
		} catch (e) {
			this._chatLayoutLog(`restore: JSON.parse failed: ${e}`);
		}
		return undefined;
	}

	/** 写盘（内容未变则跳过；`force` 强制写）。 */
	private _storeAgentsChatLayout(force = false): void {
		const services = this._chatLayoutServices();
		if (!services) {
			this._chatLayoutLogOnce('store-no-storage', 'store SKIPPED: 拿不到 IStorageService（AgentEditorParts 未实例化）');
			return;
		}
		const agentPart = getAgentEditorParts()?.agentPart as unknown as IEditorGroupsService | undefined;
		if (!agentPart) {
			this._chatLayoutLogOnce('store-no-agentpart', 'store SKIPPED: agentPart 未创建');
			return;
		}
		if (!this._chatLayoutReady) {
			this._chatLayoutLogOnce('store-not-ready', 'store SKIPPED: 布局尚未就绪（_chatLayoutReady=false ⇒ 恢复流程没走到"已确定"那一步，见上面 restore 日志）');
			return;
		}

		const groups = agentPart.groups;
		const editors: IAgentChatLayoutState['editors'] = [];
		for (let i = 0; i < groups.length; i++) {
			for (const ed of groups[i].editors) {
				if (ed instanceof NativeChatEditorInput) {
					editors.push({ chatId: ed.chatId, agentId: ed.agentId, sessionId: ed.sessionId, name: ed.name, groupIndex: i, cliMode: ed.cliMode });
				}
			}
		}
		let layout: EditorGroupLayout | undefined;
		try {
			layout = agentPart.getLayout();
		} catch {
			layout = undefined; // grid 未就绪 → 退回等宽
		}
		const activeIndex = groups.indexOf(agentPart.activeGroup);
		const state: IAgentChatLayoutState = {
			groupCount: groups.length,
			layout,
			activeGroupIndex: activeIndex >= 0 ? activeIndex : undefined,
			editors,
		};
		const json = JSON.stringify(state);
		if (!force && json === this._lastStoredChatLayout) {
			return;
		}
		this._lastStoredChatLayout = json;
		services.storage.store(AgentLayoutWorkbench.AGENT_CHAT_LAYOUT_KEY, json, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._chatLayoutLog(`store: groupCount=${state.groupCount} editors=${editors.length} active=${state.activeGroupIndex ?? '-'} sizes=${layout ? 'yes' : 'no'} force=${force} (AgentLayoutWorkbench)`);
	}

	/**
	 * ★ 恢复聊天框布局；读不到就退回默认单 Chat（= 原 `openAgentsChat()`），
	 * 最后接上「变更即写 + 定期兜底写」。
	 */
	protected async restoreAgentsChatLayout(): Promise<void> {
		const agentPart = getAgentEditorParts()?.agentPart as unknown as IEditorGroupsService | undefined;
		if (!agentPart) {
			this._chatLayoutLogOnce('restore-no-agentpart', 'restore: ABORT — agentPart 未创建，跳过聊天框布局恢复');
			return;
		}

		const saved = this._readAgentsChatLayout();
		const shouldRestore = !!saved && saved.editors.length > 0;
		this._chatLayoutLog(`restore decision: found=${!!saved} editors=${saved?.editors.length ?? 0} groupCount=${saved?.groupCount ?? 0} → ${shouldRestore ? 'RESTORE saved layout' : 'fall back to default single Chat'}`);

		if (shouldRestore && saved) {
			const groups: IEditorGroup[] = [agentPart.activeGroup];
			for (let i = 1; i < saved.groupCount; i++) {
				const g = agentPart.addGroup(groups[groups.length - 1], 3 /* GroupDirection.RIGHT */);
				if (g) { groups.push(g); }
			}
			for (const ed of saved.editors) {
				const gi = Math.min(ed.groupIndex, groups.length - 1);
				const input = NativeChatEditorInput.create(ed.chatId, ed.agentId, ed.sessionId, ed.name);
				if (ed.cliMode) {
					input.setCliMode(true);
				}
				groups[gi].openEditor(input, { pinned: true, sticky: saved.groupCount === 1 });
			}
			// 组宽（sash）：仅在组数一致时回放 —— 数量不一致时 `applyLayout` 会合并/新建组，
			// 破坏刚按 groupIndex 摆好的聊天框。
			const savedGrid = saved.layout;
			if (savedGrid && Array.isArray(savedGrid.groups) && savedGrid.groups.length === groups.length) {
				try {
					agentPart.applyLayout(savedGrid);
				} catch (e) {
					this._chatLayoutLog(`applyLayout failed: ${e}`);
				}
			}
			const ai = saved.activeGroupIndex;
			if (typeof ai === 'number' && ai >= 0 && ai < groups.length) {
				groups[ai].focus();
			}
		} else {
			await this.openAgentsChat();
		}

		this._chatLayoutReady = true;
		// 恢复后**回写**（不删 key）：磁盘状态恒等于界面状态，任意时刻被杀都能恢复。
		this._storeAgentsChatLayout();
		this._chatLayoutLog(`layout settled: groups=${agentPart.groups.length} chatEditors=${agentPart.groups.reduce((n, g) => n + g.editors.filter(e => e instanceof NativeChatEditorInput).length, 0)}`);

		this._wireAgentsChatLayoutSaves(agentPart);
	}

	/** 接上「变更即写（800ms 防抖）+ 定期兜底（20s）+ flush 兜底」。 */
	private _wireAgentsChatLayoutSaves(agentPart: IEditorGroupsService): void {
		const schedule = this._chatLayoutDisposables.add(new RunOnceScheduler(() => this._storeAgentsChatLayout(), 800));
		const onDirty = () => schedule.schedule();

		this._chatLayoutDisposables.add(agentPart.onDidAddGroup(onDirty));
		this._chatLayoutDisposables.add(agentPart.onDidRemoveGroup(onDirty));
		this._chatLayoutDisposables.add(agentPart.onDidMoveGroup(onDirty));
		this._chatLayoutDisposables.add(agentPart.onDidChangeGroupIndex(onDirty));
		this._chatLayoutDisposables.add(agentPart.onDidChangeGroupMaximized(onDirty));
		// sash 拖动（组宽变化）：`AgentEditorPart` 暴露的转发事件（取不到就跳过）。
		const sizesEvent = (agentPart as unknown as { onDidChangeGroupSizes?: Event<void> }).onDidChangeGroupSizes;
		if (sizesEvent) {
			this._chatLayoutDisposables.add(sizesEvent(onDirty));
		}

		// 每个 group 的模型变化（开/关/移动聊天框）；group 动态增删，逐个跟踪。
		const tracked = new Map<IEditorGroup, IDisposable>();
		const track = (group: IEditorGroup) => {
			if (tracked.has(group)) {
				return;
			}
			const listener = group.onDidModelChange(e => {
				// 只响应「聊天框集合/位置变了」：EDITOR_ACTIVE（切换页签）、
				// EDITOR_LABEL（改名）等不改变持久化布局，一并触发会退化成
				// 「每次点击都写盘」。
				switch (e.kind) {
					case GroupModelChangeKind.EDITOR_OPEN:
					case GroupModelChangeKind.EDITOR_CLOSE:
					case GroupModelChangeKind.EDITOR_MOVE:
					case GroupModelChangeKind.EDITOR_PIN:
					case GroupModelChangeKind.EDITOR_STICKY:
						onDirty();
						break;
					default:
						break;
				}
			});
			tracked.set(group, listener);
			this._chatLayoutDisposables.add(listener);
		};
		for (const g of agentPart.groups) {
			track(g);
		}
		this._chatLayoutDisposables.add(agentPart.onDidAddGroup(g => track(g)));

		const services = this._chatLayoutServices();
		if (services) {
			this._chatLayoutDisposables.add(services.storage.onWillSaveState(() => this._storeAgentsChatLayout()));
		}
		// ★ 定期兜底：本 app 常被强杀（无 SHUTDOWN flush）⇒ 只靠退出时保存 = 永不保存。
		const autoSave = this._chatLayoutDisposables.add(new IntervalTimer());
		autoSave.cancelAndSet(() => this._storeAgentsChatLayout(), 20_000);
	}
	//#endregion

	/**
	 * ★★ agents 布局：给根容器补上 **`agent-sessions-workbench`** 类。
	 *
	 * ── 为什么必须补 ──────────────────────────────────────────────────
	 * sessions 那套部件 CSS **全部** scoped 在这个类下，例如
	 * `sessions/browser/parts/media/sidebarPart.css`：
	 * ```css
	 * .agent-sessions-workbench .part.sidebar > .composite.header-or-footer {
	 *     flex-direction: column;  width: 48px;  flex: 1;
	 * }
	 * .agent-sessions-workbench .part.sidebar .composite-bar-container { width: 48px; flex-direction: column; }
	 * .agent-sessions-workbench .part.sidebar.sidebar-content-expanded { display: grid !important; grid-template-columns: 48px 1fr; }
	 * ```
	 * 而这个类是由 **sessions 版 `Workbench`** 加到根容器上的
	 * （`sessions/browser/workbench.ts:899-907` 的 `workbenchClasses`）。
	 * 我们继承的是**标准** `Workbench` ⇒ 根上**没有**这个类
	 * ⇒ 上述规则全不匹配 ⇒ **竖直图标条宽度塌成 0**。
	 *
	 * 真机证据（探针宽度链）：
	 * `.monaco-action-bar.vertical` offset=`0×27`、`.composite-bar` offset=`0×27`，
	 * 而 `.composite-bar-container` 有 292px ⇒ 图标全被压没
	 * （用户报的"左侧 activitybar 丢失"）。
	 *
	 * ⚠ 顺带说明：sessions 侧栏的 `shouldShowCompositeBar()` **本来就返回 `true`**
	 * （`sessions/browser/parts/sidebarPart.ts:1218`），它的注释写着
	 * "placed in a header area … then **styled vertically via CSS** to create the Activity Bar look"
	 * ⇒ 结构是对的，**缺的只是这条 CSS 的作用域类**。
	 */
	// ⚠⚠ **不要**尝试用 `shouldRenderPart(id) => id !== Parts.ACTIVITYBAR_PART` 跳过 activity bar。
	// 2026-09-14 真机验证：跳过之后**布局整个塌掉** ——
	// `titlebar 1440×23`、`editor 1×2`、`agentEditor 1×2`、`sidebar 48×0`（且回到
	// `sidebar-content-collapsed`），即 grid 尺寸从未落地。
	// 原因（未完全证实，但方向明确）：不 `create()` 就没有 DOM/尺寸，
	// 而标准 `Layout` 的记账会在布局阶段读它（`getMaximumEditorDimensions()` 读
	// `activityBarPartView.minimumWidth`；`viewMap` 里也带着这一项）⇒ 布局阶段抛错。
	// ⇒ 若以后仍要"只注册不渲染"，必须同时处理 `viewMap` / 记账那两处读。

	protected override createWorkbenchLayout(): void {
		super.createWorkbenchLayout();

		// ★★ agents 布局：把 activity bar 的 DOM **折进侧栏的图标条容器**。
		//
		// ── 为什么 ────────────────────────────────────────────────────────
		// `createActivityBarPart(sidebarPart)` 的第二个参数就是**侧栏**
		// （`sessions/browser/parts/agentEditorParts.ts:102-104`），设计上它应由侧栏托管
		// —— 标准 `SidebarPart` 就是这么做的（`createInstance(ActivitybarPart, location, this)`）。
		// 但 sessions 的侧栏**不托管**它，而 `renderWorkbench()` 的部件循环又把它
		// `create()` 到了 `mainContainer` 下 ⇒ 它的 DOM 成了 `mainContainer` 里一个
		// **从不参与布局**的容器 ⇒ 0×0。
		//
		// 真机证据（探针全页面扫描）：容器条目**在**它里面，但整条 bar 是 0×0 ——
		// `.monaco-action-bar 0×0 items=3 parent=[composite-bar]`；
		// 而侧栏 header 里那条（48px，CSS 生效）**0 条目**。
		// ⇒ 用户看到"activitybar 丢失 / 缺 Session、版本管理等页签"。
		//
		// ⚠ 为什么**不能**改成"不渲染 activity bar"：实测布局会整个塌掉
		// （`editor 1×2`、`sidebar 48×0`）—— 不 `create()` 就没有尺寸，而标准 `Layout`
		// 的记账（`getMaximumEditorDimensions()` 读 `activityBarPartView.minimumWidth`、
		// `viewMap` 也带着这一项）在布局阶段会读它。
		// ⇒ 所以**保留它的 create()，只把它搬到侧栏里去**（两边都要）。
		//
		// 搬进去之后，sessions 那条 CSS（`.agent-sessions-workbench .part.sidebar
		// .composite-bar-container .action-item { width: 40px; height: 40px; … }`）
		// 正好作用到它的条目上 ⇒ 图标应恢复。
		this.mainContainer.classList.add('agent-sessions-workbench');

		// ⚠ 这里**不再**搬 activity bar（见 `moveActivityBarIntoAgentsSidebar` 的说明）：
		// 侧栏**自己**那条 composite bar 已经带 11 个容器条目 ⇒ 再搬一条会**重复渲染两套图标**
		// （真机截图：左侧两列图标 + 滚动条）。

		// ⚠ `CHATBAR_PART` 也在这里：sessions 版 `paneCompositePartService` 会建出它
		// （见 `agentLayout.desktop.main.ts` 的说明），而 agents grid 里没有它
		// ⇒ 同样会游离渲染。
		//
		// ★★ panel **同理**，但它与上面三个不同：它是**用户可切换**的部件，
		// 所以只在"agents 布局认为它应当隐藏"时才隐藏 DOM（`panelVisible === false`），
		// 不能无条件 `display: none`。
		// 真机症状：panel 默认隐藏时，`OUTPUT / DEBUG CONSOLE / TERMINAL` 标签游离渲染在窗口左上角。
		// ⚠⚠ `ACTIVITYBAR_PART` **不在这里** —— 这一点随着 ② 的落地而反转了：
		// 入口引入 sessions 版 `paneCompositePartService` 后，侧栏也变成 **sessions 侧栏**，
		// 而 sessions 侧栏的设计是**把 activity bar 图标条折进自己内部**
		// （所以它才需要 `createActivityBarPart(sidebarPart)`）。
		// ⇒ 对 activity bar 做 `display: none` 等于**把侧栏的图标条一起藏掉**
		// （真机症状：「左侧 activitybar 缺失」，只剩两个侧栏自己的切换按钮）。
		// 它不再是"游离元素"，而是侧栏的一部分，因此必须保持可见。
		// ★★ 修复「activitybar 图标不可见」：**给 activitybar 部件的 DOM 找宿主**。
		//
		// ── 机制（探针 + 日志双重确认）──────────────────────────────────
		// 标准 `Workbench.renderWorkbench()` 的部件循环**包含** `ACTIVITYBAR_PART`
		// 且会 `getPart(id).create(partContainer, options)`（`workbench.ts:346-374`）⇒
		// 部件与它的 `PaneCompositeBar`（11 个条目 ✓）都构造了；
		// **但该循环从不把 `partContainer` 挂进 DOM** —— 部件元素的挂载是
		// **grid** 干的（`SerializableGrid` 只挂**在 grid 里**的视图）。
		// 而我们的 grid 描述符**刻意不挂 `ACTIVITYBAR_PART`**
		// （`createGridDescriptor()` 的注释：挂进去会被排成 0×0，把条目压没）
		// ⇒ **activitybar 的元素成了孤儿** ✗ ⇒ 不可见 ⇒ 11 个条目无宿主 ✗
		// （探针：`.action-item 数量 = 0`、条高 13、部件表里没有 activitybar ✓）。
		// 早前它以"游离元素"身份可见（`48×1249 @(-8,568)`），靠的是后来移除的
		// "搬"代码 ⇒ 那次移除引入了本回归 ✓。
		//
		// ── 为什么挂进 `.composite-bar-container` ───────────────────────
		// sessions 侧栏的设计就是"把 activity bar 图标条折进侧栏"
		// （`createActivityBarPart(sidebarPart)`）；且 CSS 规则
		// `.agent-sessions-workbench .part.sidebar .composite-bar-container .action-item
		//   { width:40px; height:40px }` 的作用域**正好**覆盖挂进去之后的条目 ✓。
		// ⚠ 侧栏**自己**那条 bar 当前是**空的**（探针实测 0 条目 ✓）⇒ 不会重复；
		//   若以后它又有条目了，这里要先判重（见下方幂等检查）。
		const activityBarPart = this.getPart(Parts.ACTIVITYBAR_PART);
		// ⚠⚠ **必须挂 `activityBarPart.element`，不能用 `getElementById`**：
		// 孤儿元素此刻**还没挂进 document** ⇒ `getElementById` 返回 null ⇒ 什么都不挂
		// ⇒ 图标全部消失（2026-09-14 实测回归 ✓ 已回退）。
		// 另：探针能按 id 量到它 ⇒ `activityBarPart.element` 就是那个带 id 的容器 ✓
		//（`Part.create()` 收养传入的 partContainer ✓）。
		if (activityBarPart?.element) {
			const stripHost =
				this.mainContainer.querySelector('.part.sidebar .composite-bar-container')
				|| this.mainContainer.querySelector('.part.sidebar > .composite.header-or-footer');
			if (stripHost) {
				// 幂等：已在宿主里就不重复挂。
				if (activityBarPart.element.parentElement !== stripHost) {
					stripHost.appendChild(activityBarPart.element);
				}

				// ★ 修「-8px 偏移」：`.part` 的标准 CSS 是 `position: absolute`
				// （孤儿时代它靠这个飘在 `(-8,568)` ✓），领养进宿主后若仍绝对定位，
				// 会以最近 positioned 祖先（`.part.sidebar`，`position: relative` ✓）为基准
				// ⇒ 实测跑到 `(-8,84)` ✗。这里改回**文档流**，让它作为
				// `.composite-bar-container`（flex column ✓）的子项参与布局：
				// x 跟随宿主 ⇒ 偏移消失 ✓，宽度由下方 48px 定 ✓。
				const adopted = activityBarPart.element;
				adopted.style.position = 'static';
				adopted.style.left = '';
				adopted.style.top = '';
				adopted.style.width = '48px';
				adopted.style.height = '100%';
				// 挂好后必须重排一次：部件不在 grid ⇒ 没人给它尺寸
				// （`relayoutHostedActivityBar()` 会用侧栏的真实高度 ✓）。
				this.relayoutHostedActivityBar();
			}
		}

		const partsToHide = [Parts.AUXILIARYBAR_PART, Parts.STATUSBAR_PART, Parts.CHATBAR_PART];
		if (!this.getAgentsLayoutState().panelVisible) {
			partsToHide.push(Parts.PANEL_PART);
		}

		for (const partId of partsToHide) {
			const part = this.getPart(partId);
			// ⚠⚠ **必须判 `element`**：`Part.element` 只在 `create()` 里赋值
			// （同一教训见 `sessions/browser/workbench.ts:1868-1872` 的注释）。
			// `renderWorkbench` 的部件循环只 `create()` 标准 8 个 + 我们追加的那些，
			// `CHATBAR_PART` **不在其中** ⇒ 它没有 element（也就没有 DOM，本来无需隐藏）。
			// 少了这个判空 ⇒ 真机崩在 `createWorkbenchLayout`（在 grid 创建**之前**）
			// ⇒ 窗口整块空白。
			if (part?.element) {
				part.element.style.display = 'none';
			}
		}

		// ★★ 修「视图高度卡在 120px」：`AbstractPaneCompositePart.layout()` 开头是
		// `if (!this.layoutService.isVisible(this.partId)) return;` ✗ ——
		// 标准窗口把 `SIDEBAR_HIDDEN=true` 持久化过 ⇒ agents 窗口里
		// `isVisible(SIDEBAR_PART)` = false ⇒ **侧栏部件的 layout() 被早退** ✗
		// ⇒ 内部 split-view 从未赋尺寸 ⇒ 视图停在初始 120px ✗
		// （实锤：全部 dev 日志中 `partId=workbench.parts.sidebar` 的 layout 行 = 0 ✓，
		//  panel 的却有 ✓；`paneCompositePart.ts:593-596` ✓）。
		// ⚠ 必须放在**本方法末尾**：`workbenchGrid` 此时已建 ✓
		// （早期调用会 `Cannot read properties of undefined (reading 'getViewSize')` ✗ 真机踩过 ✓）。
		// 经我们的拦截 ⇒ 走 expand ✓ 顺带完成网格 resize + 部件 relayout ✓。
		if (this.shouldCollapseAgentsSidebarInsteadOfHiding() && !this.isVisible(Parts.SIDEBAR_PART)) {
			this.setPartHidden(false, Parts.SIDEBAR_PART);
		}

		// ★★ 标题栏「Toggle Panel」按钮（Ctrl+J）：显示/隐藏底部 Panel（Output/Debug/Terminal）。
		//
		// ── 为什么必须在这里注册（真机症状：点了按钮毫无反应、控制台无报错）───────
		// `titlebarPart.ts` 的按钮只做一件事：`document.dispatchEvent(new CustomEvent('agent-studio:toggle-panel'))`
		// （`sessions/browser/parts/titlebarPart.ts:247`）。但那个事件的监听器**只**注册在
		// **sessions 版 `Workbench`** 里（`sessions/browser/workbench.ts:1315`），而 agents 窗口跑的是
		// **本类**（`AgentLayoutWorkbench extends` **标准** `Workbench`，见文件头注释）⇒ 监听器从未注册
		// ⇒ 事件派发出去**没人接** ⇒ 什么也不发生，且不报错。
		//
		// ⚠ 本类继承标准 `Layout`，它的 `setPartHidden` **已支持** PANEL_PART
		// （`workbench/browser/layout.ts:2719` → `setPanelHidden()`），所以这里直接转发即可。
		//
		// ⚠ 同时要把 panel DOM 的 inline `display: none` 清掉：见**本方法上方**的 `partsToHide` 循环，
		// panel 默认隐藏时它给 `panelPart.element` 设了 inline `display: none`；而 grid 的
		// `setViewVisible` **只布局、绝不碰这个 inline 样式** ⇒ 不清它的话，panel 即使"网格可见"仍被 DOM 挡住。
		const togglePanelHandler: EventListener = () => {
			this.toggleAgentsPanel();
		};
		document.addEventListener('agent-studio:toggle-panel', togglePanelHandler);
		// `agent-studio:toggle-output` 是同一个动作的旧别名（按钮已移除，但保留以免其他入口失效）。
		document.addEventListener('agent-studio:toggle-output', togglePanelHandler);
		this._register({ dispose: () => {
			document.removeEventListener('agent-studio:toggle-panel', togglePanelHandler);
			document.removeEventListener('agent-studio:toggle-output', togglePanelHandler);
		} });
		// ★★ 标题栏「Toggle Sidebar Content」按钮（`codicon-layout-sidebar-left`）
		// → 折叠/展开**右侧 `AGENT_EDITOR_PART`（Agent Studio 栏）**。
		//
		// ── 为什么必须在这里注册（真机症状：点了按钮毫无反应、控制台无报错）───────
		// 该按钮只做一件事：`document.dispatchEvent(new CustomEvent('agent-studio:toggle-right-column'))`
		// （`sessions/browser/parts/titlebarPart.ts:258`，另见 `nativeChatEditorPane.ts:1063` 的
		// `onToggleCollapse`）。但监听器**只**注册在 sessions 版 `Workbench`
		// （`sessions/browser/workbench.ts:1303`），而 agents 窗口跑的是**本类**
		// ⇒ 事件没人接 ⇒ 什么也不发生 ✓（与 panel 按钮同一根因）。
		//
		// ⚠ 标准 `Layout.setPartHidden()` **没有** `AGENT_EDITOR_PART` 分支，且 `workbenchGrid`
		// 是 private ⇒ 真正的网格操作封装在 `Layout.toggleAgentsRightColumn()`（受保护接缝）。
		const toggleRightColumnHandler: EventListener = () => {
			this.toggleAgentsRightColumn();
		};
		document.addEventListener('agent-studio:toggle-right-column', toggleRightColumnHandler);
		this._register({ dispose: () => document.removeEventListener('agent-studio:toggle-right-column', toggleRightColumnHandler) });
	}

	/**
	 * ★ [Saros] 切换 agents 布局底部 Panel（Output/Debug/Terminal）的显示/隐藏。
	 *
	 * 转发到标准 `Layout.toggleAgentsPanelVisibility()`（受保护接缝）—— 它把 sessions 版
	 * （`sessions/browser/workbench.ts:2324-2377`）的关键语义补齐：可见性切换
	 * **+ panel 高度恢复（35%）+ 打开默认 pane composite + 清理 inline `display`**
	 * 四件事。只调 `setPartHidden` 会漏掉"高度恢复"与"打开容器"，
	 * 导致 panel 可见但高度为 0 / 内容空白。
	 */
	private toggleAgentsPanel(): void {
		// 标准 `Layout.setPartHidden(..., PANEL_PART)` **不会**恢复 panel 高度，也不会确保
		// 打开一个 pane composite ⇒ agents 布局下 panel 以 size=0 建成，只切换可见性的话
		// 会得到"网格可见但高度 0" ⇒ 真机症状：点按钮下方什么都不出现。
		// 因此转发到标准 `Layout` 的受保护接缝 `toggleAgentsPanelVisibility()`（`workbench/browser/layout.ts`），
		// 它完整实现了「可见性 + 高度恢复 + 打开默认容器 + 清理 inline display」。
		void super.toggleAgentsPanelVisibility();
	}

	protected override createGridDescriptor(): ISerializedGrid {
		return createAgentsLayoutGridDescriptor({
			...this.getAgentsLayoutState(),
			partIds: {
				titleBar: Parts.TITLEBAR_PART,
				sidebar: Parts.SIDEBAR_PART,
				editor: Parts.EDITOR_PART,
				panel: Parts.PANEL_PART,
				agentEditor: Parts.AGENT_EDITOR_PART,

				// ★ 标准 `Layout` 的记账假设"部件全集都在 grid 里"：
				// `getMaximumEditorDimensions()` 读 `activityBarPartView`，
				// storage 处理器读 `getViewCachedVisibleSize(auxiliaryBarPartView)`
				// （该方法本就是给**隐藏**视图用的，但视图必须先存在于 grid，否则 `View not found`）。
				// 这两个以 `visible: false` + `size: 0` 挂进来 —— 不占空间、不影响外观。
				//
				// ⚠⚠ **`activityBar` 故意不挂**（这一条是踩出来的）：
				// sessions 的设计是**把 activity bar 折进侧栏**（`createActivityBarPart(sidebarPart)`，
				// 它的 DOM 在侧栏内部，宽度由 `sidebarPart.css` 的 48px 规则决定）。
				// 一旦把 `ACTIVITYBAR_PART` 以 `size: 0, visible: false` 挂进 grid，
				// grid 就会给它 `0×0` 的布局 ⇒ **它内部那条 composite bar 被压成 0×0**
				// ⇒ 图标条目（11 个）全部不可见 ⇒ 用户看到"activitybar 丢失 / 缺 Session、版本管理等页签"。
				// 真机证据：页面上**两条** composite bar —— 侧栏 header 里那条 48px 但 **0 条目**，
				// 另一条 **0×0 却含条目**（就是被压扁的这条）。
				//
				// 去掉它是否安全（已逐项核对 `activityBarPartView` 在 `layout.ts` 的用途）：
				// - `getMaximumEditorDimensions()` 只是**读 `.minimumWidth`**（普通属性读，不需要在 grid 里）✓
				// - `moveViewTo(this.activityBarPartView, …)` 只在**侧栏换位**时走，agents 布局不改侧栏位置 ✓
				// - `viewMap` 只在 grid 反序列化**引用到该 type** 时才需要 —— 本描述符不再引用它 ✓
				auxiliaryBar: Parts.AUXILIARYBAR_PART,
				statusBar: Parts.STATUSBAR_PART,
			},
			verticalOrientation: Orientation.VERTICAL,
			includeLayoutBookkeepingParts: true,
		});
	}
}

/**
 * ★★ 包一层覆写 `maximumWidth` —— 修「右栏边框**拖不动**（无法向左拖 = 无法加宽右栏）」。
 *
 * ── 为什么必须包 ─────────────────────────────────────────────────────
 * 右栏是 `AgentEditorPart extends EditorPart`，而 `EditorPart` 的宽度约束
 * **转发给它内部的 `centeredLayoutWidget`**（`workbench/browser/parts/editor/editorPart.ts:1013-1015`）：
 * ```ts
 * get minimumWidth() { return Math.min(this.centeredLayoutWidget.minimumWidth, ...); }
 * get maximumWidth() { return this.centeredLayoutWidget.maximumWidth; }
 * ```
 * ⇒ 右栏**最大宽度**被那个常量锁死，而 grid 的 sash 拖拽**会读 `maximumWidth` 来夹住**
 * （sessions 版的原话："The grid/sash system reads maximumWidth to **clamp sash dragging**"，
 * `sessions/browser/workbench.ts:1896-1902`）。症状正是"往左拖不动"（往左 = 把右栏拖宽）。
 *
 * sessions 版为此**专门包了同样的壳**（`MaxWidthConstrainedView`，同文件 `:156`）；
 * 我们继承的是**标准** `Workbench`、走标准 `Layout` ⇒ **没有**这层 ⇒ 必须自己包。
 *
 * ⚠ 为什么不直接 import sessions 那个类：它在 `sessions/browser/workbench.ts` 里，
 * 而那个模块正是本方案**要避开的 sessions 底座**（导入会把它整个求值一遍，
 * 把刚撤掉的 sessions 覆盖又拉回来）。所以这里自带一份等价实现。
 *
 * ⚠ `maximumWidth` 是**动态**的（随窗口宽度变化）⇒ 除了转发内层 `onDidChange`，
 * 还必须在**窗口 resize** 时补发一次，否则 grid 不会重读它（内层视图在窗口缩放时
 * 未必发 `onDidChange`）。
 */
class AgentEditorMaxWidthView implements ISerializableView {
	readonly element: HTMLElement;
	private readonly _onDidChange = new Emitter<{ width: number; height: number } | undefined>();
	readonly onDidChange = this._onDidChange.event;
	private readonly _resizeListener: () => void;

	constructor(
		private readonly _inner: ISerializableView,
		private readonly _getMaxWidth: () => number,
	) {
		this.element = _inner.element;
		_inner.onDidChange(e => this._onDidChange.fire(e));
		this._resizeListener = () => this._onDidChange.fire(undefined);
		window.addEventListener('resize', this._resizeListener);
	}

	get minimumWidth(): number { return this._inner.minimumWidth; }
	get maximumWidth(): number { return this._getMaxWidth(); }
	get minimumHeight(): number { return this._inner.minimumHeight; }
	get maximumHeight(): number { return this._inner.maximumHeight; }

	layout(width: number, height: number, top: number, left: number): void {
		this._inner.layout(width, height, top, left);
	}

	// `ISerializableView` 要求 —— 必须转发，否则 grid **保存布局**时会拿到 undefined
	// （`SerializableGrid.toJSON()` 逐视图调用它）。
	toJSON(): object {
		return this._inner.toJSON();
	}

	dispose(): void {
		window.removeEventListener('resize', this._resizeListener);
		this._onDidChange.dispose();
	}
}
