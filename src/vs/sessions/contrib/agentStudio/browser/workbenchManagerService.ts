/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Workbench Manager Service — Dashboard「管理工作台」的数据面与控制面。
 *
 * ── 为什么必须落在 IDE 侧（而不是 dsh 插件页）────────────────────────────
 * pin / 显隐 / 顺序**全是壳侧状态**（`workbench.activity.pinnedViewlets2` 由 `CompositeBar`
 * 独占持有），插件页既读不到也写不了。
 *
 * ── 三个写操作怎么落到内核 ──────────────────────────────────────────────
 * `ActivitybarPart` / `PaneCompositeBar` 原先只有读接口（`getPinnedPaneCompositeIds()` 等），
 * 本轮给它们补了三个公开写方法（`setPaneCompositePinned` / `setPaneCompositeHidden` /
 * `movePaneComposite`），内部用的全是既有的 private 手段，不改任何既有行为。
 *
 * ── 两个必须由本服务自己记账的点 ────────────────────────────────────────
 * ① **隐藏**：VS Code 原生没有「用户隐藏容器」这个概念 —— `hideIfEmpty` 是注册期属性，
 *    `IViewsService.isViewContainerVisible()` 说的是「侧栏当前打开哪个容器」。所以清单存
 *    `vssaros.workbench.hiddenViewContainers`，并在容器集变化时重新施加。
 * ② **pin 状态与隐藏清单一起存**：隐藏时容器被从 composite bar 摘掉，`isPinned` 就读不到了；
 *    恢复时 `addComposite` 出来的条目**默认未 pin** ⇒ 不把 pin 一起存下来，恢复后会掉进溢出菜单。
 *
 * ── 顺序 ────────────────────────────────────────────────────────────────
 * 拖拽直接改 composite bar 的顺序，持久化由它自己做（`saveCachedViewContainers()`）。
 * 本服务只负责「恢复默认顺序」（按注册期 `order` 重排）与「按最近使用排序」。
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { getActivityBarControl, IActivityBarControl } from '../../../../workbench/browser/parts/activitybar/activityBarControl.js';
import { IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../../workbench/common/views.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { AgentStudioDashboardEditorInput } from './agentStudioDashboardEditorInput.js';
import { CodebaseGraphViewerEditorInput } from './codebaseGraphViewerEditorInput.js';
import { TaskOverviewEditorInput } from './taskOverviewEditorInput.js';

export const IWorkbenchManagerService = createDecorator<IWorkbenchManagerService>('workbenchManagerService');

/** Dashboard 工作台卡片点开时要打开的容器（用户要求：默认排活动栏第一位，见 `_seedDashboardFirst`）。 */
const DASHBOARD_CONTAINER_ID = 'agentStudio.dashboard';

/** 隐藏清单（含隐藏前的 pin 状态）。 */
const HIDDEN_KEY = 'vssaros.workbench.hiddenViewContainers';
/** 一次性顺序迁移标记（防止每次启动都把 Dashboard 搬回最前）。 */
const SEED_KEY = 'vssaros.workbench.orderSeed';
/** 「按最近使用排序」用的时间戳表。 */
const LAST_OPENED_KEY = 'vssaros.workbench.lastOpened';

interface IHiddenRecord {
	readonly id: string;
	/** 隐藏前是否固定 —— 恢复时要补回去（见文件头 ②）。 */
	readonly pinned: boolean;
}

/**
 * 寄居在别的容器里的模块（有独立页面但不占容器）。
 *
 * ⚠ 2026-10-12 起**暂无条目**：原先唯一的一条是记忆库（寄居 `agentStudio.knowledgeBase`），
 * 「资料库」拆分后它已升为真容器 `agentStudio.memory` ⇒ 从本表移除（保留机制备用）。
 */
interface IVirtualWorkbench {
	readonly id: string;
	/** 寄居的容器 id。 */
	readonly containerId: string;
	readonly title: string;
	readonly icon: ThemeIcon;
	readonly summary: string;
	open(): Promise<unknown>;
}

export interface IWorkbenchEntry {
	/** 唯一 id：容器条目 = 容器 id；寄居条目 = 自有 id（如 `workbench.memory`）。 */
	readonly id: string;
	/** 实际操作的目标容器（寄居条目指向它寄居的那个容器）。 */
	readonly containerId: string;
	readonly title: string;
	readonly icon: ThemeIcon;
	/** 注册期顺序（「恢复默认顺序」用）。 */
	readonly order: number;
	readonly pinned: boolean;
	readonly hidden: boolean;
	/** 展示用一行说明（**不是真源**，只是卡片副标题）。 */
	readonly summary: string;
	/** 寄居条目：不能 pin / 显隐 / 排序（那些是容器的属性）。 */
	readonly virtual: boolean;
}

export interface IWorkbenchManagerService {
	readonly _serviceBrand: undefined;
	/** 任何会影响活动栏的操作之后触发（pin / 显隐 / 排序 / 打开）。 */
	readonly onDidChange: Event<void>;
	/** 全部工作台（按活动栏实际顺序；隐藏的也在列表里，标记 `hidden`）。 */
	listWorkbenches(): IWorkbenchEntry[];
	/** 固定在活动栏 ↔ 收进底部「…」溢出菜单。 */
	setPinned(id: string, pinned: boolean): void;
	/** 从活动栏完全移除（连溢出菜单一起）↔ 恢复。 */
	setHidden(id: string, hidden: boolean): void;
	/** 把 `id` 移到 `toId` 之前（`before=false` 为之后）。 */
	move(id: string, toId: string, before?: boolean): void;
	/** 打开：切活动栏页签 + 打开关联编辑器面板（如有）；隐藏态先自动恢复。 */
	open(id: string): Promise<void>;
	/** 回到注册期顺序。 */
	resetOrder(): void;
	/** 按最近打开时间重排。 */
	sortByRecentUse(): void;
	/** 应用隐藏清单 + 一次性顺序迁移。由贡献在 `WorkbenchPhase.AfterRestored` 调用。 */
	initialize(): Promise<void>;
}

/** 卡片副标题（展示用，不是真源 —— 真源是各容器的注册信息）。 */
const CONTAINER_SUMMARY: Readonly<Record<string, string>> = {
	'agentStudio.workspace': '文件与工作区',
	'vssaros.dsh.codebase': '代码图谱：节点 / 关系 / 索引状态',
	'agentStudio.search': '全局搜索',
	'workbench.view.scm': 'Git 变更',
	'sessionHistory.view': '历史会话',
	'agentStudio.presetAgent': '预设 Agent 列表',
	'agentStudio.tasks': '看板卡片与任务详情',
	'agentStudio.workflow': '工作流引擎与画布',
	'agentStudio.integration': '技能 / MCP',
	'agentStudio.knowledgeBase': '知识库检索 / 导入 / 构建',
	// ★ 2026-10-12（「资料库」拆分）：原来这里只有 kb 一条，另三格拆出来时漏了副标题 ⇒ 卡片上留白。
	'agentStudio.memory': '长期记忆与 4-Tier 分层（只读快照）',
	'agentStudio.media': '媒体资产库：最近图片 / 视频 / 音频',
	'agentStudio.plugins': '插件中心',
	'agentStudio.dashboard': '会话遥测 / 用量汇总',
};

function titleOf(container: ViewContainer): string {
	const title = container.title;
	return typeof title === 'string' ? title : title.value;
}

function iconOf(container: ViewContainer): ThemeIcon {
	return ThemeIcon.isThemeIcon(container.icon) ? container.icon : ThemeIcon.fromId('window');
}

export class WorkbenchManagerService extends Disposable implements IWorkbenchManagerService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	/** 寄居条目（能力等价于容器，但没有自己的活动栏格子）。 */
	private readonly _virtualWorkbenches: readonly IVirtualWorkbench[];

	constructor(
		@IViewDescriptorService private readonly _viewDescriptorService: IViewDescriptorService,
		@IViewsService private readonly _viewsService: IViewsService,
		@IEditorService private readonly _editorService: IEditorService,
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _log: ILogService,
	) {
		super();

		// ★ 2026-10-12（「资料库」拆分）：**寄居条目已清空**。
		// 原先这里挂着唯一一条虚拟工作台 `workbench.memory`（寄居 `agentStudio.knowledgeBase`，
		// 「打开」走命令 `agentStudio.openMemoryDetail`）。记忆库现在是**真容器** `agentStudio.memory`
		// （静态注册 + `DSH_MODULE_CONTAINERS` 都提供它）⇒ 再列一条虚拟的会出现**两张「记忆库」卡片**，
		// 而且虚拟那条的「打开」会跳到「知识库」✗（`open()` 用的是 `virtual.containerId`）。
		// 机制**保留**：`IVirtualWorkbench` / 条目上的 `virtual` 标记 / `_operableContainerId()` 的
		// 置灰分支都还在，以后再有「有独立页面但不占容器」的模块，在这里加一条即可。
		this._virtualWorkbenches = [];

		// 容器集会变（dsh 引擎下插件装卸会动态注册 / 注销）⇒ 新出现的容器若在隐藏清单里，要重新施加。
		this._register(this._viewDescriptorService.onDidChangeViewContainers(() => {
			const bar = this._activityBar();
			if (bar) {
				this._applyHidden(bar);
			}
			this._onDidChange.fire();
		}));
	}

	// ─── 读 ─────────────────────────────────────────────────────────────

	listWorkbenches(): IWorkbenchEntry[] {
		const bar = this._activityBar();
		const pinnedIds = bar ? this._safePinnedIds(bar) : [];
		const hidden = this._readHidden();
		const hiddenIds = new Set(hidden.map(h => h.id));

		// 顺序：活动栏实际顺序（= pinned 的顺序）优先，其余按注册期 order。
		const containers = [...this._sidebarContainers()].sort((a, b) => {
			const ia = pinnedIds.indexOf(a.id);
			const ib = pinnedIds.indexOf(b.id);
			if (ia >= 0 && ib >= 0) { return ia - ib; }
			if (ia >= 0) { return -1; }
			if (ib >= 0) { return 1; }
			return (a.order ?? 0) - (b.order ?? 0);
		});

		const entries: IWorkbenchEntry[] = containers.map(container => ({
			id: container.id,
			containerId: container.id,
			title: titleOf(container),
			icon: iconOf(container),
			// `ViewContainer.order` 是可选的（未指定 = 0），卡片上要显示成数字，所以早兜底。
			order: container.order ?? 0,
			pinned: pinnedIds.includes(container.id) || (hidden.find(h => h.id === container.id)?.pinned ?? false),
			hidden: hiddenIds.has(container.id),
			summary: CONTAINER_SUMMARY[container.id] ?? '',
			virtual: false,
		}));

		// 寄居条目插在它寄居的容器后面（寄居容器不在 ⇒ 不显示，免得给出点了没东西的入口）。
		for (const virtual of this._virtualWorkbenches) {
			const hostIndex = entries.findIndex(e => e.containerId === virtual.containerId);
			if (hostIndex < 0) {
				continue;
			}
			entries.splice(hostIndex + 1, 0, {
				id: virtual.id,
				containerId: virtual.containerId,
				title: virtual.title,
				icon: virtual.icon,
				order: entries[hostIndex].order,
				pinned: entries[hostIndex].pinned,
				hidden: entries[hostIndex].hidden,
				summary: virtual.summary,
				virtual: true,
			});
		}
		return entries;
	}

	// ─── 写 ─────────────────────────────────────────────────────────────

	setPinned(id: string, pinned: boolean): void {
		const containerId = this._operableContainerId(id);
		const bar = this._activityBar();
		if (!bar || !containerId) {
			return;
		}
		bar.setPaneCompositePinned(containerId, pinned);
		this._log.info(`[WorkbenchManager] pin ${containerId} = ${pinned}`);
		this._onDidChange.fire();
	}

	setHidden(id: string, hidden: boolean): void {
		const containerId = this._operableContainerId(id);
		const bar = this._activityBar();
		if (!bar || !containerId) {
			return;
		}
		const previous = this._readHidden();
		const rest = previous.filter(h => h.id !== containerId);
		if (hidden) {
			bar.setPaneCompositeHidden(containerId, true);
			this._writeHidden([...rest, { id: containerId, pinned: bar.getPinnedPaneCompositeIds().includes(containerId) }]);
		} else {
			const saved = previous.find(h => h.id === containerId);
			bar.setPaneCompositeHidden(containerId, false);
			// `addComposite` 恢复出来的条目默认未 pin ⇒ 按隐藏前记下的状态补回来，
			// 否则用户看到的是「恢复了，但图标跑进溢出菜单」。
			if (saved?.pinned) {
				bar.setPaneCompositePinned(containerId, true);
			}
			this._writeHidden(rest);
		}
		this._log.info(`[WorkbenchManager] hidden ${containerId} = ${hidden}`);
		this._onDidChange.fire();
	}

	move(id: string, toId: string, before = true): void {
		const containerId = this._operableContainerId(id);
		const toContainerId = this._operableContainerId(toId);
		const bar = this._activityBar();
		if (!bar || !containerId || !toContainerId) {
			return;
		}
		bar.movePaneComposite(containerId, toContainerId, before);
		this._onDidChange.fire();
	}

	async open(id: string): Promise<void> {
		const virtual = this._virtualWorkbenches.find(v => v.id === id);
		const containerId = virtual ? virtual.containerId : id;
		// 隐藏态先恢复：一个看不见的工作台，「打开」本来也没意义。
		if (this._readHidden().some(h => h.id === containerId)) {
			this.setHidden(containerId, false);
		}
		this._recordOpen(id);
		await this._viewsService.openViewContainer(containerId, true);
		if (virtual) {
			await virtual.open();
		} else {
			await this._openRelatedEditor(containerId);
		}
		this._onDidChange.fire();
	}

	resetOrder(): void {
		this._reorder(containers => [...containers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
		this._log.info('[WorkbenchManager] 已恢复默认顺序。');
	}

	sortByRecentUse(): void {
		const last = this._readLastOpened();
		this._reorder(containers => [...containers].sort((a, b) =>
			(last[b.id] ?? 0) - (last[a.id] ?? 0) || (a.order ?? 0) - (b.order ?? 0)));
	}

	async initialize(): Promise<void> {
		const bar = this._activityBar();
		if (!bar) {
			this._log.info('[WorkbenchManager] 活动栏不可用（本布局不渲染它），跳过一次初始化。');
			return;
		}
		this._applyHidden(bar);
		this._seedDashboardFirst(bar);
	}

	// ─── 内部 ───────────────────────────────────────────────────────────

	/**
	 * 一次性迁移：让 Dashboard 落在活动栏第一位（用户要求）。
	 *
	 * ⚠ 只改注册期 `order` 对「已用过窗口」无效 —— 顺序早已写进 storage
	 * `workbench.activity.pinnedViewlets2`，`updateCompositeBarItemsFromStorage()` 以它为准。
	 * 所以这里做一次性搬运，且**仅当它仍停在旧默认位置（最后一个）**时才搬：用户自己拖过就不动。
	 */
	private _seedDashboardFirst(bar: IActivityBarControl): void {
		if (this._storageService.getBoolean(SEED_KEY, StorageScope.PROFILE, false)) {
			return;
		}
		this._storageService.store(SEED_KEY, true, StorageScope.PROFILE, StorageTarget.USER);

		const pinnedIds = this._safePinnedIds(bar);
		const index = pinnedIds.indexOf(DASHBOARD_CONTAINER_ID);
		if (index < 0 || index !== pinnedIds.length - 1 || pinnedIds.length < 2) {
			return;      // 没装 / 已被用户挪走 / 只有一个 —— 都不动
		}
		bar.movePaneComposite(DASHBOARD_CONTAINER_ID, pinnedIds[0], true);
		this._log.info('[WorkbenchManager] 首次迁移：Dashboard 移到活动栏第一位。');
	}

	private _applyHidden(bar: IActivityBarControl): void {
		for (const record of this._readHidden()) {
			bar.setPaneCompositeHidden(record.id, true);
		}
	}

	/** 按注册期顺序（或调用方给的自定义顺序）重排活动栏。 */
	private _reorder(sort: (containers: ViewContainer[]) => ViewContainer[]): void {
		const bar = this._activityBar();
		if (!bar) {
			return;
		}
		const hiddenIds = new Set(this._readHidden().map(h => h.id));
		const containers = sort(this._sidebarContainers().filter(c => !hiddenIds.has(c.id)));
		// 依次把第 i 个挪到第 i-1 个之后 ⇒ 形成目标链（`move(..., before=false)` = 插到后面）。
		for (let i = 1; i < containers.length; i++) {
			bar.movePaneComposite(containers[i].id, containers[i - 1].id, false);
		}
		this._onDidChange.fire();
	}

	/** 容器 → 关联编辑器面板（没有条目 = 这个工作台没有容器级编辑器面板）。 */
	private async _openRelatedEditor(containerId: string): Promise<void> {
		const input =
			containerId === 'vssaros.dsh.codebase' ? CodebaseGraphViewerEditorInput.getOrCreate()
				: containerId === 'agentStudio.tasks' ? TaskOverviewEditorInput.getOrCreate()
					: containerId === DASHBOARD_CONTAINER_ID ? AgentStudioDashboardEditorInput.getOrCreate()
						: undefined;
		if (!input) {
			return;
		}
		await this._editorService.openEditor(input, { pinned: true });
	}

	/**
	 * 可操作容器 id：寄居条目返回 undefined（它们没自己的格子，pin/显隐/排序都该置灰）。
	 * 顺带把「容器已经不存在」也挡掉 —— fail-soft，不抛错。
	 */
	private _operableContainerId(id: string): string | undefined {
		if (this._virtualWorkbenches.some(v => v.id === id)) {
			return undefined;
		}
		return this._sidebarContainers().some(c => c.id === id) ? id : undefined;
	}

	private _sidebarContainers(): ViewContainer[] {
		return [...this._viewDescriptorService.getViewContainersByLocation(ViewContainerLocation.Sidebar)];
	}

	/**
	 * 取活动栏控制面。
	 *
	 * 走注册表（`activityBarControl.ts`）而不是注入 `IWorkbenchLayoutService`：
	 * `getPart()` / `shouldRenderPart()` 只在 `Layout` 实现类上、**不在服务接口**里；
	 * 而且某些布局（agents）里活动栏部件根本不创建 —— 注册表拿不到就是 `undefined`，
	 * 语义天然正确，不需要 try/catch 兜「Unknown part」。
	 */
	private _activityBar(): IActivityBarControl | undefined {
		return getActivityBarControl(ViewContainerLocation.Sidebar);
	}

	private _safePinnedIds(bar: IActivityBarControl): string[] {
		try {
			return bar.getPinnedPaneCompositeIds();
		} catch {
			return [];
		}
	}

	// ─── storage ────────────────────────────────────────────────────────

	private _readHidden(): IHiddenRecord[] {
		return this._readJson<IHiddenRecord[]>(HIDDEN_KEY, []);
	}

	private _writeHidden(records: readonly IHiddenRecord[]): void {
		this._writeJson(HIDDEN_KEY, records);
	}

	private _readLastOpened(): Record<string, number> {
		return this._readJson<Record<string, number>>(LAST_OPENED_KEY, {});
	}

	private _recordOpen(id: string): void {
		const last = this._readLastOpened();
		last[id] = Date.now();
		this._writeJson(LAST_OPENED_KEY, last);
	}

	private _readJson<T>(key: string, fallback: T): T {
		const raw = this._storageService.get(key, StorageScope.PROFILE);
		if (!raw) {
			return fallback;
		}
		try {
			const parsed = JSON.parse(raw);
			return parsed ?? fallback;
		} catch {
			// 畸形内容一律当没有（不猜、也不把坏数据写回去）。
			this._log.warn(`[WorkbenchManager] ${key} 内容不可解析，按空处理。`);
			return fallback;
		}
	}

	private _writeJson(key: string, value: unknown): void {
		this._storageService.store(key, JSON.stringify(value), StorageScope.PROFILE, StorageTarget.USER);
	}
}
