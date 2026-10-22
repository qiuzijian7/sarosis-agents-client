/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { KbGraphEditorInput } from './kbGraphEditorInput.js';
import { KbGraphView, DEFAULT_GRAPH_FORCES, type IGraphForces } from './views/knowledgeBase/kbGraphView.js';
import { KbLinkGraph, IKbGraphRoot } from './views/knowledgeBase/kbGraph.js';
import { KbNoteEditorInput } from './kbNoteEditorInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * KnowledgeBaseGraphEditorPane — 在中栏文件编辑器打开知识库「关系图谱」。
 *
 * 挂载 KbGraphView（Canvas 力导向图），节点双击 → 在中间栏打开对应笔记的
 * WYSIWYG 编辑器（KbNoteEditorInput）。完全对齐 SiYuan 的图谱中心 Tab 行为。
 *
 * 浮动工具条含「构建图谱」按钮：重新扫描知识库分区（库 + 笔记）的 [[双链]]，
 * 重建力导向图数据并刷新画布（笔记有改动时无需重新从侧边栏打开图谱）。
 */
/**
 * ⚙ 面板配置的持久化键（★ 2026-10-19 P1）。
 *
 * 用 **PROFILE** 作用域 + **USER** 目标：这是"我的看图习惯"（力参数、标签阈值），
 * 不是项目配置 ⇒ 跨工作区保留；**不写进 workspace 设置**（否则会污染团队共享配置 ✗）。
 */
const GRAPH_PREFS_KEY = 'agentStudio.kbGraph.prefs';

/** ⚙ 面板持久化的形状（缺字段 = 用默认值） */
interface IGraphPrefs {
	forces?: Partial<IGraphForces>;
	labelMinScale?: number;
	/** 聚焦深度（1–3） */
	focusDepth?: number;
}

/** 滑杆定义（⚙ 面板按这张表生成，加参数只改这里 ✓） */
interface IForceSlider {
	readonly key: keyof IGraphForces;
	readonly label: string;
	readonly min: number;
	readonly max: number;
	readonly step: number;
	readonly hint: string;
}

export class KnowledgeBaseGraphEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.kbGraphPane';

	private _container: HTMLElement | undefined;
	private _graphView: KbGraphView | undefined;
	/** 工具条上的「N 节点 · M 连线」计数（2026-10-19） */
	private _countEl: HTMLElement | undefined;
	private _roots: IKbGraphRoot[] = [];
	/** ⚙ 参数面板根元素（`undefined` = 当前未打开） */
	private _settingsEl: HTMLElement | undefined;
	/** 聚焦时向外看几跳（1–3，⚙ 面板可调；默认 1 = 直接邻居） */
	private _focusDepth = 1;
	/** 「聚焦 / 全图」按钮（⚙ 面板里"按标题聚焦"之后要同步它的文案） */
	private _focusBtn: HTMLButtonElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super(KnowledgeBaseGraphEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = DOM.$('div.kb-graph-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.position = 'relative';
		this._container.style.overflow = 'hidden';
		this._container.style.background = 'var(--vscode-editor-background)';
		parent.appendChild(this._container);

		// 切回图谱 Tab（或首次聚焦）时重新扫描磁盘构建图谱：删除文档后内存图谱不会自动剔除，
		// 不刷新会残留已删节点（「关系图谱中的节点异常」）。磁盘 walk 天然排除已删文件。
		this._register(this.onDidFocus(() => {
			if (this._graphView && this._roots.length > 0) {
				void this._rebuildGraphData();
			}
		}));
	}

	override async setInput(
		input: EditorInput,
		_options: IEditorOptions | undefined,
		_context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, _options, _context, token);

		if (!(input instanceof KbGraphEditorInput) || !this._container) {
			return;
		}
		if (token.isCancellationRequested) {
			return;
		}

		this._disposeGraph();
		this._roots = input.roots ?? [];

		const host = DOM.$('div.kb-graph-host');
		host.style.position = 'absolute';
		host.style.inset = '0';
		this._container.appendChild(host);

		const graphView = this.instantiationService.createInstance(KbGraphView);
		graphView.render(host);
		// ★ 2026-10-19（P1）：先把持久化的力参数 / 标签阈值应用到实例，再 loadGraph
		//   ⇒ 首次布局直接就是用户上次调好的手感（否则会按默认参数跑一遍再跳变 ✗）
		this._applyPrefs(graphView);
		graphView.onNodeClick(e => {
			// 双击文档节点 → 在中间栏打开对应文档
			if (!e.node) { return; }
			const uri = URI.parse(e.node.id);
			const ext = uri.path.split('.').pop()?.toLowerCase();
			if (ext === 'md' || ext === 'markdown') {
				// 笔记：.md 无 resource resolver（仅绑定 KbNoteEditorInput），须显式用
				// Block 编辑器，否则会回退到默认纯文本编辑器。
				const name = e.node.label;
				this.editorService.openEditor(
					new KbNoteEditorInput(uri, `${name}.md`),
					{ pinned: true },
					this.group,
				);
			} else {
				// 其它来源（库/raw/*.html 原始导入、.canvas 等）：交给 resolver 打开对应编辑器。
				// 此前一律强当作 markdown 笔记打开，导致原始来源孤立节点（html）点不开「对应文档」。
				void this.editorService.openEditor(
					{ resource: uri, options: { pinned: true } },
					this.group,
				);
			}
		});

		graphView.loadGraph(input.nodes, input.links);
		this._graphView = graphView;

		this._renderToolbar();
	}

	/** 浮动工具条：构建图谱 + 重新布局。 */
	private _renderToolbar(): void {
		if (!this._container) { return; }
		const bar = DOM.$('div.kb-graph-toolbar');
		bar.style.cssText = [
			'position:absolute', 'top:10px', 'right:10px', 'z-index:10',
			'display:flex', 'gap:6px', 'padding:4px',
			'background:var(--vscode-editorWidget-background,#252526)',
			'border:1px solid var(--vscode-widget-border,#3c3c3c)',
			'border-radius:6px', 'box-shadow:0 2px 8px rgba(0,0,0,.4)',
		].join(';');

		const buildBtn = DOM.$('button.kb-graph-tbtn') as HTMLButtonElement;
		buildBtn.textContent = '🔄 构建图谱';
		buildBtn.title = '重新扫描知识库（库 + 笔记）的 [[双链]] 并重建图谱';
		buildBtn.style.cssText = this._btnCss();
		buildBtn.onclick = () => void this._rebuildGraph(buildBtn);

		const layoutBtn = DOM.$('button.kb-graph-tbtn');
		layoutBtn.textContent = '⤢ 重新布局';
		layoutBtn.title = '重新执行力导向布局';
		layoutBtn.style.cssText = this._btnCss();
		layoutBtn.onclick = () => this._graphView?.relayout();

		// ★ 2026-10-19（P1）：**孤点开关**（对齐 Obsidian Filters 里的 Orphans）——
		//   库大时孤立笔记会把主体淹没；但默认保持"显示"，藏起来容易让人以为笔记丢了 ✓。
		const orphanBtn = DOM.$('button.kb-graph-tbtn') as HTMLButtonElement;
		orphanBtn.style.cssText = this._btnCss();
		const syncOrphanBtn = () => {
			const on = this._graphView?.getShowOrphans() ?? true;
			orphanBtn.textContent = on ? '◌ 孤点' : '◌ 孤点·隐';
			orphanBtn.title = on ? '当前显示孤立笔记（度数 0）—— 点击隐藏它们' : '当前隐藏孤立笔记 —— 点击显示';
			orphanBtn.style.opacity = on ? '1' : '0.55';
		};
		orphanBtn.onclick = () => {
			const view = this._graphView;
			if (!view) { return; }
			view.setShowOrphans(!view.getShowOrphans());
			// 隐藏/显示孤点后视野要重新贴合（否则空出一大片或被挤到角落 ✗）
			view.fitToView();
			syncOrphanBtn();
			this._updateCount();
		};
		syncOrphanBtn();

		// ★ 2026-10-19（P1）：**适应视图** —— 画布跑偏后一键缩放到全图（原先只能靠滚轮找回来 ✗）
		const fitBtn = DOM.$('button.kb-graph-tbtn') as HTMLButtonElement;
		fitBtn.textContent = '适应';
		fitBtn.title = '把整张图缩放到画布内（居中）';
		fitBtn.style.cssText = this._btnCss();
		fitBtn.onclick = () => this._graphView?.fitToView();

		// ★ 2026-10-19（P1）：**局部聚焦**（对齐 Obsidian Local graph）——
		//   只显示选中（或悬停）节点的 1 跳邻居；再点一次回全图。
		const focusBtn = DOM.$('button.kb-graph-tbtn') as HTMLButtonElement;
		this._focusBtn = focusBtn;
		focusBtn.style.cssText = this._btnCss();
		focusBtn.onclick = () => {
			const view = this._graphView;
			if (!view) { return; }
			if (view.getLocalFocusId()) {
				view.setLocalFocus(null);
			} else {
				const target = view.getSelectedNodeId() ?? view.getHoveredNodeId();
				if (!target) {
					// 没有目标 ⇒ **如实提示**，不静默（否则又是"点了没反应"✗）
					if (this._countEl) { this._countEl.textContent = '先在图上点一个节点，再点「聚焦」'; }
					return;
				}
				view.setLocalFocus(target, this._focusDepth);
			}
			// ★ 2026-10-19：**自动适应视野** —— 否则聚焦后视野仍是全图尺度，子图缩成一小团，
			//   等于白聚焦 ✗（`fitToView()` 默认只看可见节点 ⇒ 正好把这 N 跳铺满画布 ✓）。
			view.fitToView();
			this._syncFocusBtn();
			this._updateCount();
		};
		this._syncFocusBtn();

		// ★ 2026-10-19：**规模计数**（"N 节点 · M 连线"）—— 用户看到 "20 节点 · 0 连线"
		//   就能自己判断"是没建双链"，而不是以为图谱功能坏了（真机反馈的困惑点之一）。
		this._countEl = DOM.$('span.kb-graph-count') as HTMLElement;
		this._countEl.style.cssText = 'font-size:11px;opacity:.7;padding:0 6px;align-self:center;white-space:nowrap';
		this._updateCount();

		// ★ 2026-10-19（P1）：**⚙ 参数面板**（对齐 Obsidian 的 Forces / Display）——
		//   力参数原先硬编码在 `_simulateStep` 里，用户既看不出含义也改不了 ✗。
		const settingsBtn = DOM.$('button.kb-graph-tbtn') as HTMLButtonElement;
		settingsBtn.textContent = '⚙';
		settingsBtn.title = '图谱参数（排斥力 / 连线吸引 / 向心力 / 标签阈值）';
		settingsBtn.style.cssText = this._btnCss();
		settingsBtn.onclick = (ev) => {
			ev.stopPropagation();
			this._toggleSettingsPanel();
		};

		bar.append(this._countEl, orphanBtn, fitBtn, focusBtn, settingsBtn, buildBtn, layoutBtn);
		this._container.appendChild(bar);
	}

	/** 刷新工具条上的"N 节点 · M 连线"计数（图规模变化后调用）。 */
	private _updateCount(): void {
		const view = this._graphView;
		if (!this._countEl || !view) { return; }
		const stats = view.getStats();
		const visible = view.getVisibleCount();
		// 过滤生效时显示「可见/总数」，否则只显示总数（少一个数字，别制造噪声 ✓）
		this._countEl.textContent = visible === stats.nodes
			? `${stats.nodes} 节点 · ${stats.links} 连线`
			: `${visible}/${stats.nodes} 节点 · ${stats.links} 连线`;
	}

	// -----------------------------------------------------------------------
	// ⚙ 参数面板（力参数 / 标签阈值）＋ 持久化（2026-10-19 P1）
	// -----------------------------------------------------------------------

	/** 同步「聚焦 / 全图」按钮的文案与状态（⚙ 面板里搜索聚焦后也要刷新 ✓）。 */
	private _syncFocusBtn(): void {
		const btn = this._focusBtn;
		if (!btn) { return; }
		const focused = !!this._graphView?.getLocalFocusId();
		btn.textContent = focused ? '全图' : '聚焦';
		btn.title = focused
			? '退出局部聚焦，回到全图'
			: `只显示选中（或悬停）节点的 ${this._focusDepth} 跳邻居`;
		btn.style.opacity = focused ? '1' : '0.85';
	}

	/** 开关 ⚙ 面板（再次点击关闭；打开时按当前值初始化滑杆）。 */
	private _toggleSettingsPanel(): void {
		if (this._settingsEl) {
			this._settingsEl.remove();
			this._settingsEl = undefined;
			return;
		}
		const view = this._graphView;
		if (!view || !this._container) { return; }

		const panel = DOM.$('div.kb-graph-settings') as HTMLElement;
		panel.style.cssText = [
			'position:absolute', 'top:50px', 'right:10px', 'z-index:11', 'width:236px',
			'padding:10px', 'display:flex', 'flex-direction:column', 'gap:8px',
			'background:var(--vscode-editorWidget-background,#252526)',
			'border:1px solid var(--vscode-widget-border,#3c3c3c)',
			'border-radius:6px', 'box-shadow:0 4px 14px rgba(0,0,0,.45)',
			'font-size:11px', 'color:var(--vscode-foreground,#ccc)',
		].join(';');

		const title = DOM.$('div') as HTMLElement;
		title.textContent = '图谱参数';
		title.style.cssText = 'font-weight:600;font-size:12px;margin-bottom:2px';
		panel.appendChild(title);

		// 三个力参数（对应 IGraphForces 的三个字段）
		const sliders: IForceSlider[] = [
			{ key: 'repulsion', label: '排斥力', min: 0.06, max: 0.34, step: 0.01, hint: '越大节点越分散' },
			{ key: 'spring', label: '连线吸引', min: 0.04, max: 0.6, step: 0.01, hint: '越大相连节点越紧' },
			{ key: 'center', label: '向心力', min: 0.001, max: 0.03, step: 0.001, hint: '越大整体越聚拢' },
		];
		const forces = view.getForces();
		for (const spec of sliders) {
			panel.appendChild(this._sliderRow(spec, forces[spec.key], v => {
				// 拖滑杆即时生效（setForces 内部只是**重新加热**，不重置坐标 ✓）
				view.setForces({ [spec.key]: v } as Partial<IGraphForces>);
				this._savePrefs();
			}));
		}

		// 标签阈值（Obsidian 的 Display 那一档）
		panel.appendChild(this._sliderRow(
			{ label: '标签阈值', min: 0.2, max: 1.5, step: 0.1, hint: '缩到多小才隐藏标签（越大越早隐藏）' },
			view.getLabelMinScale(),
			v => { view.setLabelMinScale(v); this._savePrefs(); },
		));

		// 聚焦深度（配合工具条「聚焦」按钮：向外看几跳邻居）
		panel.appendChild(this._sliderRow(
			{ label: '聚焦深度', min: 1, max: 3, step: 1, hint: '「聚焦」时向外看几跳（1 = 直接邻居）' },
			this._focusDepth,
			v => {
				this._focusDepth = Math.round(v);
				const focusedId = view.getLocalFocusId();
				// 正在聚焦中 ⇒ 立即按新深度重算并重新适应视野（否则要退出再聚焦才生效 ✗）
				if (focusedId) {
					view.setLocalFocus(focusedId, this._focusDepth);
					view.fitToView();
				}
			},
		));

		// 按标题聚焦（★ 2026-10-19：**不依赖 IDE 右键菜单**就能"看某一篇周围" ——
		//   图谱 Tab 是 Singleton、菜单入口还得改 input 语义；一个输入框最省且立刻可用。
		//   顺带补上了 P2 里的"搜索定位" ✓）
		const searchRow = DOM.$('div') as HTMLElement;
		searchRow.style.cssText = 'display:flex;flex-direction:column;gap:2px';
		const searchTip = DOM.$('div') as HTMLElement;
		searchTip.textContent = '按标题聚焦';
		searchTip.style.cssText = 'opacity:.9';
		const searchInput = DOM.$('input') as HTMLInputElement;
		searchInput.type = 'text';
		searchInput.placeholder = '输入笔记名，回车聚焦';
		searchInput.style.cssText = 'width:100%;box-sizing:border-box;padding:3px 6px;border-radius:3px;'
			+ 'border:1px solid var(--vscode-input-border,#3c3c3c);background:var(--vscode-input-background,#1e1e1e);'
			+ 'color:var(--vscode-input-foreground,#ccc);font-size:11px';
		searchInput.onkeydown = ev => {
			if (ev.key !== 'Enter') { return; }
			ev.preventDefault();
			const hit = view.findNodeByLabel(searchInput.value);
			if (!hit) {
				// 没找到 ⇒ 就地说明（不静默，也不关面板）
				searchTip.textContent = '没找到匹配的笔记';
				searchTip.style.color = 'var(--vscode-editorWarning-foreground,#dcdcaa)';
				return;
			}
			searchTip.textContent = '按标题聚焦';
			searchTip.style.color = '';
			view.setLocalFocus(hit, this._focusDepth);
			view.fitToView();
			this._syncFocusBtn();
			this._updateCount();
		};
		searchRow.append(searchTip, searchInput);
		panel.appendChild(searchRow);

		const reset = DOM.$('button.kb-graph-tbtn') as HTMLButtonElement;
		reset.textContent = '恢复默认';
		reset.style.cssText = this._btnCss();
		reset.onclick = () => {
			view.setForces({ ...DEFAULT_GRAPH_FORCES });
			view.setLabelMinScale(0.6);
			this._savePrefs();
			// 重建面板刷新滑杆位置（比逐个 set 值稳）
			this._settingsEl?.remove();
			this._settingsEl = undefined;
			this._toggleSettingsPanel();
		};
		panel.appendChild(reset);

		this._container.appendChild(panel);
		this._settingsEl = panel;
	}

	/** 生成一行滑杆（标签 + 当前值 + range + 提示）。 */
	private _sliderRow(
		spec: Pick<IForceSlider, 'label' | 'min' | 'max' | 'step' | 'hint'>,
		initial: number,
		onChange: (v: number) => void,
	): HTMLElement {
		const row = DOM.$('div') as HTMLElement;
		row.style.cssText = 'display:flex;flex-direction:column;gap:2px';

		const head = DOM.$('div') as HTMLElement;
		head.style.cssText = 'display:flex;justify-content:space-between;opacity:.9';
		const name = DOM.$('span') as HTMLElement;
		name.textContent = spec.label;
		const value = DOM.$('span') as HTMLElement;
		value.style.cssText = 'opacity:.7;font-variant-numeric:tabular-nums';
		value.textContent = String(initial);
		head.append(name, value);

		const input = DOM.$('input') as HTMLInputElement;
		input.type = 'range';
		input.min = String(spec.min);
		input.max = String(spec.max);
		input.step = String(spec.step);
		input.value = String(initial);
		input.style.cssText = 'width:100%';
		input.oninput = () => {
			const v = Number(input.value);
			value.textContent = String(v);
			onChange(v);
		};

		const hint = DOM.$('div') as HTMLElement;
		hint.textContent = spec.hint;
		hint.style.cssText = 'opacity:.5;font-size:10px';

		row.append(head, input, hint);
		return row;
	}

	/** 读取持久化配置（坏数据一律忽略 ⇒ 用默认值，绝不让面板打不开 ✗）。 */
	private _loadPrefs(): IGraphPrefs {
		try {
			const raw = this.storageService.get(GRAPH_PREFS_KEY, StorageScope.PROFILE);
			if (!raw) { return {}; }
			const parsed = JSON.parse(raw) as IGraphPrefs;
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}

	/** 保存当前配置（PROFILE / USER —— 个人的看图习惯，不污染团队工作区配置）。 */
	private _savePrefs(): void {
		const view = this._graphView;
		if (!view) { return; }
		const prefs: IGraphPrefs = {
			forces: view.getForces(),
			labelMinScale: view.getLabelMinScale(),
			focusDepth: this._focusDepth,
		};
		try {
			this.storageService.store(GRAPH_PREFS_KEY, JSON.stringify(prefs), StorageScope.PROFILE, StorageTarget.USER);
		} catch (e) {
			this.logService.warn(`[KB Graph] 保存图谱参数失败：${String((e as Error)?.message ?? e)}`);
		}
	}

	/** 把持久化配置应用到指定图谱实例（`loadGraph` **之前**调用，让首次布局就用对的参数）。 */
	private _applyPrefs(view: KbGraphView): void {
		const prefs = this._loadPrefs();
		if (prefs.forces) { view.setForces(prefs.forces, false); }
		if (typeof prefs.labelMinScale === 'number') { view.setLabelMinScale(prefs.labelMinScale); }
		if (typeof prefs.focusDepth === 'number') {
			this._focusDepth = Math.max(1, Math.min(3, Math.round(prefs.focusDepth)));
		}
	}

	private _btnCss(): string {
		return [
			'border:none', 'background:transparent', 'color:var(--vscode-foreground,#ccc)',
			'font-size:12px', 'padding:4px 8px', 'border-radius:4px',
			'cursor:pointer', 'white-space:nowrap',
		].join(';');
	}

	/** 重新扫描知识库分区并重建力导向图（纯数据重建，不触碰工具条按钮状态）。 */
	private async _rebuildGraphData(): Promise<void> {
		if (!this._graphView || this._roots.length === 0) { return; }
		try {
			const linkGraph = new KbLinkGraph(this.fileService);
			await linkGraph.build(this._roots);
			const { nodes, links } = linkGraph.getGraphData();
			this._graphView.loadGraph(nodes, links);
			this._updateCount();
		} catch (err) {
			this.logService.error(`[KB Graph] 构建图谱失败：${err}`);
		}
	}

	/** 重新扫描知识库分区并重建力导向图（工具条「🔄 构建图谱」按钮）。 */
	private async _rebuildGraph(btn: HTMLButtonElement): Promise<void> {
		if (!this._graphView) { return; }
		if (this._roots.length === 0) {
			this.logService.warn('[KB Graph] 无可用的知识库分区根目录，无法构建图谱');
			return;
		}
		const original = btn.textContent;
		btn.disabled = true;
		btn.textContent = '⏳ 构建中…';
		btn.style.opacity = '0.6';
		try {
			await this._rebuildGraphData();
		} finally {
			btn.disabled = false;
			btn.textContent = original;
			btn.style.opacity = '';
		}
	}

	override layout(dimension: DOM.Dimension): void {
		this._graphView?.resize();
	}

	private _disposeGraph(): void {
		if (this._graphView) {
			this._graphView.dispose();
			this._graphView = undefined;
		}
		// ⚙ 面板引用的是旧 view / 旧 DOM ⇒ 字段也必须清（`clearNode` 只清 DOM 节点，
		// 不清这个引用 ⇒ 下次点 ⚙ 会误判"已打开"而直接 return ✗）
		this._settingsEl = undefined;
		if (this._container) {
			DOM.clearNode(this._container);
		}
	}

	override dispose(): void {
		this._disposeGraph();
		super.dispose();
	}
}
