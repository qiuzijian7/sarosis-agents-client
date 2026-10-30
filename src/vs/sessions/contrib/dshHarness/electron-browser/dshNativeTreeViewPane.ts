/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件侧栏的**原生**承载（清单 `view.kind = 'native'`）。
 *
 * ★ 2026-10-30（用户要求：「IDE 侧的 activitybar 中，插件的 sideview 要求改用 vscode 原生的 UI 和功能」）：
 *
 * 此前所有插件侧栏都是 `DshPluginViewPane` —— 一个 `WebContentsView` 加载插件自托管的 HTML 页
 * （`/x/<module>/?surface=sideview`）。它的问题不是"不好看"，而是**功能是假的**：
 * - 手绘 `<header>` ⇒ 没有视图标题栏的折叠 / 拖动 / 溢出菜单；
 * - 手绘列表 ⇒ 没有键盘导航、没有无障碍语义、没有原生 hover，展开状态也不持久化；
 * - 自研右键菜单 ⇒ 不跟主题、不参与 Esc/滚动/失焦的统一关闭；
 * - 还得额外喂 `DshOverlayFreeze`（浮层让位）与一套主进程可见性对账心跳 —— 全是网页承载的副作用。
 *
 * 本类用 VS Code 自己的 `ViewPane` + `WorkbenchObjectTree` 重画同一份内容：标题栏、工具栏、
 * 右键菜单、键盘导航、主题、列表样式全部由框架提供，本类只负责"取数 + 说明这一行长什么样"。
 *
 * ## 取数口径（为什么是 HTTP 而不是控制桥）
 * 控制桥（`ide.request`）是**插件问 IDE**；侧栏是**IDE 问插件**，方向相反。原生视图要的是
 * "与插件页同一份数据" ⇒ 直接取插件自己的 JSON 接口（清单 `view.data.route`），
 * 同一个 `origin`、同一套 cookie 与权限口径。这样侧栏与编辑区页不会各算一份
 * （本仓已经为"两个 dashboard 不是同一份数据"付过代价）。
 *
 * ## 与插件页宿主的关系
 * **不是**替代品：编辑区完整页（`DshPluginPageEditorInput`）仍是插件自托管页，本类只管侧栏。
 * 所以插件可以只把侧栏切成 `native`，编辑区页一行都不用改。
 */

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IDshHostStatus } from '../common/dshHarness.js';
import { IDshHarnessService } from './dshHarnessService.js';
import { DshStatusBox } from './dshStatusBox.js';

/**
 * 原生侧栏里的一行。刻意做成**通用形状**（不写死某插件的字段）：
 * 后续插件迁过来时只需在 `NATIVE_DATA_SOURCES` 里加一个解码器，树与宿主一行都不用改。
 */
export interface IDshNativeRow {
	/** 行身份：选中 / 定位 / 持久化都靠它（同一份数据里必须唯一）。 */
	readonly handle: string;
	readonly label: string;
	/** 副标题（灰字）。 */
	readonly description?: string;
	/** 右侧那段短文本（时间 / 计数）。 */
	readonly badge?: string;
	/** 图标颜色（`#rrggbb`）；缺省用主题前景色。 */
	readonly color?: string;
	readonly icon?: ThemeIcon;
	/** hover 文本；缺省用 label。 */
	readonly tooltip?: string;
}

/** 数据源：把插件 JSON 解成一维行。认不出的形状如实退化，不猜。 */
interface IDshNativeDataSource {
	readonly route: string;
	decode(json: unknown): readonly IDshNativeRow[];
}

interface INativeRowTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly description: HTMLElement;
	readonly badge: HTMLElement;
}

export class DshNativeTreeViewPane extends ViewPane {

	private _tree: WorkbenchObjectTree<IDshNativeRow, void> | undefined;
	private _treeContainer: HTMLElement | undefined;
	private _statusContainer: HTMLElement | undefined;
	private _status: DshStatusBox | undefined;
	private _statusBoxOwned: IDisposable | undefined;

	private _rows: readonly IDshNativeRow[] = [];
	private _loading = false;
	private _started = false;
	private _lastHostState: string | undefined;

	private readonly _onDidChangeContent = this._register(new Emitter<void>());
	readonly onDidChangeContent: Event<void> = this._onDidChangeContent.event;

	/** 刷新节流：Host 的进度事件很密，合并成一次。 */
	private readonly _refreshScheduler = this._register(new RunOnceScheduler(() => void this.refresh(), 250));

	constructor(
		/** 容器 id（SyncDescriptor 静态参数）：诊断标识。 */
		private readonly _containerId: string,
		/** 清单声明的形态名（如 `vssaros.agents.roster`）：决定用哪个解码器。 */
		private readonly _viewType: string,
		options: IViewPaneOptions,
		@IDshHarnessService private readonly _dsh: IDshHarnessService,
		@ICommandService private readonly _commands: ICommandService,
		@ILogService private readonly _log: ILogService,
		@IConfigurationService configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// Host 起来 / 重启 ⇒ 数据源换了（端口会变），必须重取。
		this._register(this._dsh.onDidChangeStatus(status => this._onHostStatus(status)));
		// 插件集合变化（装了 / 停用）⇒ 这个容器可能整个换人。
		this._register(this._dsh.onDidChangePlugins(() => this._refreshScheduler.schedule()));
		// 首次可见才取数：与插件页宿主的"懒启动"同口径，启动期不制造请求。
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				void this._start();
			}
		}));
	}

	// ── 渲染 ────────────────────────────────────────────────────────────────

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		// 说明区（Host 没起来 / 没数据 / 取数失败）：**明说**，不要让人对着空白面板猜。
		this._statusContainer = container.appendChild(document.createElement('div'));
		this._statusContainer.className = 'dsh-native-view-status';
		this._statusContainer.style.cssText = 'display:none;padding:12px 10px;flex-direction:column;align-items:flex-start;gap:8px;';

		this._treeContainer = container.appendChild(document.createElement('div'));
		this._treeContainer.className = 'dsh-native-view-tree';
		this._treeContainer.style.cssText = 'height:100%;overflow:hidden;';

		this._createTree();
	}

	private _createTree(): void {
		if (!this._treeContainer || this._tree) {
			return;
		}
		const delegate: IListVirtualDelegate<IDshNativeRow> = {
			getHeight: () => 22,
			getTemplateId: () => 'row',
		};
		const renderer: ITreeRenderer<IDshNativeRow, void, INativeRowTemplate> = {
			templateId: 'row',
			renderTemplate: (templateContainer: HTMLElement): INativeRowTemplate => {
				const row = templateContainer.appendChild(document.createElement('div'));
				row.className = 'dsh-native-row';
				row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:0 8px;height:22px;overflow:hidden;';

				const icon = row.appendChild(document.createElement('span'));
				icon.className = 'dsh-native-row-icon';
				icon.style.cssText = 'flex:0 0 16px;display:inline-flex;align-items:center;justify-content:center;';

				const label = row.appendChild(document.createElement('span'));
				label.className = 'dsh-native-row-label';
				label.style.cssText = 'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

				const description = row.appendChild(document.createElement('span'));
				description.className = 'dsh-native-row-desc';
				description.style.cssText = 'flex:0 0 auto;opacity:.7;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%;';

				const badge = row.appendChild(document.createElement('span'));
				badge.className = 'dsh-native-row-badge';
				badge.style.cssText = 'flex:0 0 auto;opacity:.6;font-size:11px;';

				return { row, icon, label, description, badge };
			},
			renderElement: (node: ITreeNode<IDshNativeRow, void>, _index: number, template: INativeRowTemplate): void => {
				// 树把行包成 `ITreeNode`，真正的内容在 `.element`（这是原生树的约定）。
				const item = node.element;
				template.label.textContent = item.label;
				template.description.textContent = item.description ?? '';
				template.badge.textContent = item.badge ?? '';
				template.row.title = item.tooltip ?? item.label;

				template.icon.textContent = '';
				if (item.icon) {
					// 原生 codicon 字体图标：与工作台其它列表同一套，不自己画 SVG。
					const el = template.icon.appendChild(document.createElement('span'));
					el.className = `codicon ${item.icon.id}`;
					if (item.color) {
						el.style.color = item.color;
					}
				}
			},
			disposeTemplate: (template: INativeRowTemplate): void => {
				template.row.remove();
			},
		};

		this._tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<IDshNativeRow, void>,
			`dshNativeView:${this._containerId}`,
			this._treeContainer,
			delegate,
			[renderer],
			{
				identityProvider: { getId: (row: IDshNativeRow) => row.handle },
				horizontalScrolling: false,
				multipleSelectionSupport: false,
				// 列表样式跟随所在视图（侧栏 / 辅助栏的配色由框架算好）。
				overrideStyles: this.getLocationBasedColors().listOverrideStyles,
				accessibilityProvider: {
					getAriaLabel: (row: IDshNativeRow) => row.label,
					getWidgetAriaLabel: () => localize('dshNativeView.aria', "插件面板"),
				},
			},
		));
	}

	/**
	 * 把行灌进树。
	 *
	 * `WorkbenchObjectTree` 是**对象树**（不是 AsyncDataTree）⇒ 没有 `setInput`，
	 * 根节点用 `setChildren(null, …)` 换。行本身是不可展开的叶子，所以不传 `collapsible`。
	 */
	private _setRows(rows: readonly IDshNativeRow[]): void {
		if (!this._tree) {
			return;
		}
		const children: IObjectTreeElement<IDshNativeRow>[] = rows.map(row => ({
			element: row,
			collapsible: false,
		}));
		this._tree.setChildren(null, children);
	}

	// ── 生命周期 ────────────────────────────────────────────────────────────

	private async _start(): Promise<void> {
		if (this._started) {
			return;
		}
		this._started = true;
		await this.refresh();
	}

	/** Host 状态跃迁：起来就取数；从 running 掉下去就把旧数据清掉（不假装新鲜）。 */
	private _onHostStatus(status: IDshHostStatus): void {
		const previous = this._lastHostState;
		this._lastHostState = status.state;
		if (previous === status.state) {
			return;
		}
		if (status.state === 'running') {
			this._refreshScheduler.schedule();
			return;
		}
		if (previous === 'running') {
			this._rows = [];
			this._setRows([]);
			this._showHostStatus(status);
		}
	}

	// ── 取数 ────────────────────────────────────────────────────────────────

	/** 重新取一次（供树 / 外部命令调用）。 */
	async refresh(): Promise<void> {
		if (this._loading) {
			return;
		}
		const status = this._dsh.status;
		if (status.state !== 'running' || !status.origin) {
			this._showHostStatus(status);
			return;
		}
		const source = NATIVE_DATA_SOURCES[this._viewType];
		if (!source) {
			this._showNote(localize('dshNativeView.noSource', "这个原生视图还没有数据源（视图形态 {0} 未被 IDE 支持）。", this._viewType));
			return;
		}

		this._loading = true;
		try {
			const response = await fetch(status.origin + source.route, {
				credentials: 'include',
				headers: { accept: 'application/json' },
			});
			if (!response.ok) {
				this._showNote(localize('dshNativeView.httpError', "读取数据失败：{0}（HTTP {1}）", source.route, String(response.status)));
				return;
			}
			const json: unknown = await response.json();
			this._rows = source.decode(json);
			this._setRows(this._rows);
			if (this._rows.length === 0) {
				this._showNote(localize('dshNativeView.empty', "这里还没有内容。"));
			} else {
				this._hideStatus();
			}
			this._onDidChangeContent.fire();
		} catch (e) {
			// 取数失败**必须**说出来：空白面板块最难查（页面宿主那条路也吃过这个亏）。
			const message = String((e as Error)?.message ?? e);
			this._log.warn(`[dshNativeView] ${this._viewType} 取数失败：${message}`);
			this._showNote(localize('dshNativeView.fetchError', "读取数据失败：{0}", message));
		} finally {
			this._loading = false;
		}
	}

	// ── 状态区 ──────────────────────────────────────────────────────────────

	private _showHostStatus(status: IDshHostStatus): void {
		if (!this._statusContainer) {
			return;
		}
		this._statusContainer.textContent = '';
		this._statusContainer.style.display = 'flex';
		if (!this._status) {
			this._status = new DshStatusBox(this._dsh, this._commands, this._log);
			// DshStatusBox 自身没有需要释放的资源 ⇒ 这里只留一个占位，便于将来接上时不用改结构。
			this._statusBoxOwned = { dispose: () => { this._status = undefined; } };
			this._register(this._statusBoxOwned);
		}
		this._status.render(this._statusContainer, status);
	}

	/** 一段纯文字的说明（空 / 出错 / 没有数据源）。 */
	private _showNote(text: string): void {
		if (!this._statusContainer) {
			return;
		}
		this._statusContainer.textContent = '';
		this._statusContainer.style.display = 'flex';
		const box = this._statusContainer.appendChild(document.createElement('div'));
		box.style.cssText = 'display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.5;opacity:.9;';
		const icon = box.appendChild(document.createElement('span'));
		icon.className = `codicon ${Codicon.info.id}`;
		icon.style.cssText = 'flex:0 0 16px;margin-top:2px;';
		const body = box.appendChild(document.createElement('span'));
		body.textContent = text;
	}

	private _hideStatus(): void {
		if (!this._statusContainer) {
			return;
		}
		this._statusContainer.style.display = 'none';
		this._statusContainer.textContent = '';
	}

	// ── 布局 / 焦点 ──────────────────────────────────────────────────────────

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		const statusHeight = this._statusContainer?.style.display === 'none' ? 0 : (this._statusContainer?.offsetHeight ?? 0);
		this._tree?.layout(Math.max(0, height - statusHeight), width);
	}

	override focus(): void {
		super.focus();
		this._tree?.domFocus();
	}
}

/**
 * 形态名 → 数据源。第一项 = agents 名册（本次迁移的样板）。
 *
 * ⚠ 解码器面对的是**外部 JSON**：字段缺失 / 类型不对一律退化成"没有那个字段"，
 *   不做猜测性转换（例如不把 `live: {}` 猜成"有 3 个会话"）。
 */
const NATIVE_DATA_SOURCES: Readonly<Record<string, IDshNativeDataSource>> = {
	'vssaros.agents.roster': {
		// 与 `/x/agents/?surface=sideview` 与编辑区完整页**同一份**接口（见 vssaros-agents/lib/index.js）。
		route: '/x/agents/api/agents',
		decode(json: unknown): readonly IDshNativeRow[] {
			const root = json as { agents?: unknown } | undefined;
			const agents = Array.isArray(root?.agents) ? root!.agents : [];
			const rows: IDshNativeRow[] = [];
			for (const raw of agents) {
				const a = raw as Record<string, unknown>;
				const id = typeof a.id === 'string' ? a.id : '';
				if (!id) {
					continue; // 没有 id 的行无法定位，跳过而不是渲染一行点不动的条目
				}
				const name = typeof a.name === 'string' && a.name ? a.name : id;
				const live = a.live as { sessions?: unknown } | null | undefined;
				const sessions = typeof live?.sessions === 'number' ? live.sessions : 0;
				const description = typeof a.description === 'string' ? a.description : '';
				rows.push({
					handle: `agent:${id}`,
					label: name,
					...(description ? { description } : {}),
					...(typeof a.color === 'string' ? { color: a.color } : {}),
					icon: Codicon.account,
					...(sessions > 0 ? { badge: String(sessions) } : {}),
					tooltip: description ? `${name}\n${description}` : name,
				});
			}
			return rows;
		},
	},
};
