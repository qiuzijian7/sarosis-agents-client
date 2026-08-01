/*---------------------------------------------------------------------------------------------
 *  Sarosis Agents — Canvas Editor Pane
 *
 *  EditorPane 用于 .canvas 文件的思维导图编辑。
 *  对齐 kbGraphEditorPane 模式。
 *  维护静态 _activePane 引用供键盘命令路由。
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { URI } from '../../../../../base/common/uri.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CanvasEditorInput } from './canvasEditorInput.js';
import { CanvasEditorController } from './canvasEditorController.js';
import { CanvasViewport } from './view/canvasViewport.js';
import type { IMindmapData, IMindmapNode, MindmapDirection } from '../../common/mindmap/mindmapTypes.js';
import { getDirectChildNodes, buildForest, findTreeForNode,
	getNextSibling, getPrevSibling, getParentNode } from '../../common/mindmap/treeModel.js';
import { createMindmapEdge } from '../../common/mindmap/edgeSides.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { parseFreeMindXmlAndConvert } from './freemindImport.js';

/** 静态活跃 pane 引用，供键盘命令（Action2）路由。 */
let _activePane: CanvasEditorPane | null = null;
export function getActiveCanvasPane(): CanvasEditorPane | null { return _activePane; }

/**
 * CanvasEditorPane — 中栏编辑器，渲染 .canvas 思维导图。
 */
export class CanvasEditorPane extends EditorPane {

	override layout(_dimension: DOM.Dimension): void {
		const rect = this._viewport?.container.getBoundingClientRect();
		const nodeCount = this._controller?.data.nodes.length ?? 0;
		this.logService.info(`[CanvasEditor] layout: containerRect=${rect?.width}x${rect?.height}, hasController=${!!this._controller}, nodeCount=${nodeCount}`);
		// 容器拿到真实尺寸后重新自适应：setInput 阶段容器可能为 0×0，导致初次 fit 失效、
		// 画布以 scale(0) 渲染而不可见。此处拿到真实尺寸再 fit 一次即可正常显示。
		if (this._viewport && this._controller && this._controller.data.nodes.length > 0) {
			const r = this._viewport.container.getBoundingClientRect();
			if (r.width > 0 && r.height > 0) {
				this.logService.info(`[CanvasEditor] layout: container has real size, triggering re-fit`);
				this._fitViewport(this._controller.data);
			} else {
				this.logService.info(`[CanvasEditor] layout: container STILL 0-size, skip re-fit`);
			}
		}
		// 容器拿到真实尺寸后重绘 minimap 内容 / 标尺（minimap 尺寸固定，但视口框需真实容器尺寸）
		this._viewport?.relayout();
	}

	static readonly ID = 'workbench.editor.agentStudio.canvasEditorPane';

	private _container: HTMLElement | undefined;
	private _viewport: CanvasViewport | undefined;
	private _controller: CanvasEditorController | undefined;
	private _toolbar: HTMLElement | undefined;
	private _directionBtn: HTMLElement | undefined;
	private _outlineEl: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileDialogService private readonly dialogService: IFileDialogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(CanvasEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = DOM.$('div.canvas-editor-pane');
		this._container.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;background:var(--vscode-editor-background);';
		parent.appendChild(this._container);

		// Toolbar
		this._toolbar = this._createToolbar();
		this._container.appendChild(this._toolbar);

		// Body: outline + viewport (horizontal split)
		const body = DOM.$('div.canvas-editor-body');
		body.style.cssText = 'display:flex;flex:1;min-height:0;overflow:hidden;';
		this._container.appendChild(body);

		// Outline panel (left sidebar)
		this._outlineEl = DOM.$('div.canvas-editor-outline');
		this._outlineEl.style.cssText = 'width:220px;border-right:1px solid var(--vscode-panel-border);overflow-y:auto;overflow-x:hidden;flex-shrink:0;font-size:12px;padding:4px 0;display:none;';
		body.appendChild(this._outlineEl);

		// Viewport container
		const vpContainer = DOM.$('div');
		vpContainer.style.cssText = 'flex:1;position:relative;overflow:hidden;';
		body.appendChild(vpContainer);
		this._viewport = new CanvasViewport(vpContainer);
	}

	override async setInput(
		input: EditorInput,
		_options: IEditorOptions | undefined,
		_context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		// Deactivate previous
		if (_activePane && _activePane !== this) { _activePane._onBlur(); }
		_activePane = this;

		await super.setInput(input, _options, _context, token);

		this.logService.info(`[CanvasEditor] setInput: inputType=${input?.constructor?.name ?? 'unknown'}, isCanvasInput=${input instanceof CanvasEditorInput}, hasContainer=${!!this._container}, hasViewport=${!!this._viewport}`);

		if (!(input instanceof CanvasEditorInput) || !this._container || !this._viewport) {
			this.logService.info('[CanvasEditor] setInput: early return (not canvas input or missing container/viewport)');
			return;
		}
		if (token.isCancellationRequested) {
			this.logService.info('[CanvasEditor] setInput: token cancelled, abort');
			return;
		}

		const data = input.mindmapData;
		this.logService.info(`[CanvasEditor] setInput: data nodes=${(data?.nodes ?? []).length}, edges=${(data?.edges ?? []).length}, mindmapFlag=${data?.mindmap}`);

		// Remove old viewport content
		const vpContainer = this._viewport.container.parentElement;
		if (vpContainer) {
			this._viewport.dispose();
			this._viewport = new CanvasViewport(vpContainer);
		}

		// Create controller
		this._controller = new CanvasEditorController(data);
		this._viewport.setRenderData(data);

		// ── 自动检测并应用思维导图布局 ──
		// 触发条件（满足其一即重排为树状放射布局）：
		//  1) data.mindmap === true：文件被显式标记为思维导图 → 保证树状布局；
		//  2) 网格启发式：≥80% 节点 y 相同（网格/平铺布局）。
		// 注意：仅满足条件 2 时若文件未标记，重排结果不会持久化为 mindmap 标记，
		// 下次打开仍会重新检测；满足条件 1 时标记已存在，重排后随保存固化。
		if (data.nodes.length >= 3 && (data.mindmap === true || this._isGridLayout(data.nodes))) {
			this.logService.info(`[CanvasEditor] applying mindmap relayout (mindmapFlag=${data.mindmap})`);
			this._applyMindmapLayout(data);
			this._viewport.setRenderData(data);  // 用重排后的数据重新渲染
			input.mindmapData = data;             // 同步到 input
		}

		// 自动选中根节点（第一个节点或入度最小的节点）
		if (data.nodes.length > 0) {
			const rootId = this._inferRootNodeId(data);
			this._controller.selectNode(rootId);
		}

		// Wire controller → viewport & save
		this._controller.onDataChanged = (updatedData) => {
			input.mindmapData = updatedData;
			this._rebuildSubtreeDescendants(updatedData);
			this._render();
			this._renderOutline();
			this._debouncedSave(input);
		};

		this._controller.onSelectionChanged = (_nodeId) => {
			this._render();
			this._renderOutline();
		};

		this._controller.onLayoutApplied = () => {
			this._render();
		};

		this._controller.onFocusRequest = (_nodeId) => {
			this._render();
		};

		this._controller.onNavigateToNode = (nodeId) => {
			// Zoom to target node (called from URI handler)
			const targetNode = data.nodes.find(n => n.id === nodeId);
			if (targetNode && this._viewport) {
				this._viewport.centerOn({
					minX: targetNode.x - 100, minY: targetNode.y - 100,
					maxX: targetNode.x + targetNode.width + 100,
					maxY: targetNode.y + targetNode.height + 100,
				}, 50);
			}
			this._render();
			this._renderOutline();
		};

		// Wire viewport → controller
		this._viewport.onNodeClick = (nodeId, e) => {
			if (e.altKey) {
				const treeIds = this._controller!.selectTree();
				this._selectedTreeIds = new Set(treeIds);
			} else {
				this._selectedTreeIds = new Set([nodeId]);
			}
			this._controller!.selectNode(nodeId);
			this._viewport!.container.focus();
		};

		// 键盘快捷键路由（Tab/Shift+Enter/Del/方向键/撤销重做/复制粘贴等）
		this._viewport.onKeyDown = (e) => this._handleCanvasKeyDown(e);

		// 节点引用链接（node:<id>）点击 → 跳转/聚焦目标节点
		this._viewport.onNodeLinkClick = (nodeId) => this.cmdNavigateToNode(nodeId);

		this._viewport.onToggleExpand = (nodeId) => {
			this._controller!.toggleExpand(nodeId);
		};

		// Resize 结束：尺寸已由 viewport 直接写回数据节点，仅刷新边与持久化（不重排，避免节点跳位）
		this._viewport.onNodeResizeEnd = (_nodeId, _width, _height) => {
			this._rebuildSubtreeDescendants(data);
			this._render();
			this._renderOutline();
			this._debouncedSave(input);
		};

		// Ctrl+点击节点 → 跳转源码
		this._viewport.onNavigateToSource = (nodeId) => {
			this._navigateToSource(nodeId);
		};

		// 选中连线时清空节点选中，避免 Delete 语义歧义
		this._viewport.onEdgeSelect = (edgeId) => {
			if (edgeId) {
				this._controller?.selectNode(null);
				this._editingNodeId = null;
				this._selectedTreeIds = new Set();
				this._render();
			}
		};

		this._controller!.onDirectionChanged = (dir) => {
			if (this._directionBtn) {
				this._directionBtn.textContent = this._directionLabel(dir);
			}
		};

		this._viewport.onNodeDblClick = (nodeId) => {
			this._controller!.selectNode(nodeId);
			this._editingNodeId = nodeId;
			this._render();
		};

		this._viewport.onNodeDragEnd = (nodeId, x, y, subtreeIds) => {
			// 坐标已由 viewport 实时更新（含子树），此处仅重新计算子树索引与持久化
			const nd = data.nodes.find(n => n.id === nodeId);
			if (!nd) { return; }
			this._rebuildSubtreeDescendants(data);
			this._render();
			this._renderOutline();
			this._debouncedSave(input);
		};

		this._viewport.onNodeTextChanged = (nodeId, text) => {
			const nd = data.nodes.find(n => n.id === nodeId);
			if (nd) {
				nd.text = text;
				this._editingNodeId = null;
				this._render();
				this._renderOutline();
				this._debouncedSave(input);
			}
		};

		this._viewport.onBackgroundClick = () => {
			this._controller!.selectNode(null);
			this._editingNodeId = null;
			this._selectedTreeIds = new Set();
			this._render();
		};

		this._viewport.onEdgeHandleClick = (edgeId, fromNodeId, toNodeId) => {
			// Insert node between: delete edge, create newNode, add fromNode→newNode and newNode→toNode
			const fromNode = data.nodes.find(n => n.id === fromNodeId);
			const toNode = data.nodes.find(n => n.id === toNodeId);
			if (!fromNode || !toNode) { return; }

			const midX = (fromNode.x + fromNode.width / 2 + toNode.x + toNode.width / 2) / 2 - 150;
			const midY = (fromNode.y + fromNode.height / 2 + toNode.y + toNode.height / 2) / 2 - 30;
			const newId = this._generateId();
			const newNode: IMindmapNode = {
				id: newId, type: 'text', x: midX, y: midY, width: 300, height: 60, text: '',
			};
			data.nodes.push(newNode);

			// Remove old edge
			data.edges = data.edges.filter(e => e.id !== edgeId);

			// Add two new edges
			const e1 = createMindmapEdge(this._generateId(), fromNodeId, newId, data.nodes);
			const e2 = createMindmapEdge(this._generateId(), newId, toNodeId, data.nodes);
			data.edges.push(e1, e2);

			this._controller?.selectNode(newId);
			this._editingNodeId = newId;
			this._rebuildSubtreeDescendants(data);
			this._render();
			this._renderOutline();
			this._debouncedSave(input);
		};

		this._viewport.onBackgroundDblClick = (x, y) => {
			const id = this._generateId();
			// 尺寸与落点对齐参考实现 handleDoubleClick：250×120，以点击处为中心（x-100, y-50）
			const newNode: IMindmapNode = {
				id, type: 'text', x: x - 100, y: y - 50, width: 250, height: 120, text: '',
			};
			data.nodes.push(newNode);
			this._editingNodeId = id;
			this._controller!.selectNode(id);
			this._render();
			this._renderOutline();
			this._debouncedSave(input);
		};

		// 框选结束 → 多选集合
		this._viewport.onSelectionEnd = (ids) => {
			if (ids.length === 0) { return; }
			this._selectedTreeIds = new Set(ids);
			this._controller!.selectNodes(ids);
			this._render();
			this._renderOutline();
		};

		// 视口活动节点变化 → 大纲双向高亮
		this._viewport.onActiveNodeChange = (id) => this._updateOutlineActive(id);

		// 自由连接 → 创建边
		this._viewport.onConnectEnd = (fromId, toId) => {
			const edgeId = this._controller!.connectNodes(fromId, toId);
			if (edgeId) {
				this._rebuildSubtreeDescendants(data);
				this._render();
				this._renderOutline();
				this._debouncedSave(input);
			}
		};

		// Populate subtree descendants for drag
		for (const node of data.nodes) {
			if (node.type === 'group') { continue; }
			const descSet = new Set<string>();
			const queue = [node.id];
			const visited = new Set([node.id]);
			while (queue.length > 0) {
				const id = queue.shift()!;
				const children = getDirectChildNodes(id, data);
				for (const child of children) {
					if (!visited.has(child.id)) {
						visited.add(child.id);
						descSet.add(child.id);
						queue.push(child.id);
					}
				}
			}
			this._viewport.setSubtreeDescendants(node.id, descSet);
		}

		this._render();
		this._renderOutline();
		this._fitViewport(data);
	}

	// ── 公开命令方法（供键盘 Action2 调用） ──────────────────────

	get controller(): CanvasEditorController | undefined { return this._controller; }

	cmdAddChild(): void { this._controller?.addChild(); }
	cmdAddSibling(): void { this._controller?.addSibling(); }
	cmdDeleteNode(): void {
		if (!this._controller) { return; }

		// 优先删除选中的连线（对齐参考实现：Delete 同时服务于节点与连线）
		const selEdge = this._viewport?.selectedEdgeId;
		if (selEdge) {
			const data = this._controller.data;
			const idx = data.edges.findIndex(e => e.id === selEdge);
			if (idx >= 0) {
				data.edges.splice(idx, 1);
				this._viewport!.selectEdge(null);
				this._rebuildSubtreeDescendants(data);
				this._render();
				this._renderOutline();
				if (this.input) { this._debouncedSave(this.input as CanvasEditorInput); }
			}
			return;
		}

		const sel = this._controller.selectedNodeId;
		if (!sel) { this.logService.info('[CanvasEditor] 删除失败：请先选择一个节点'); return; }
		const parent = getParentNode(sel, this._controller.data);
		if (!parent) { this.logService.info('[CanvasEditor] 删除失败：根节点不能删除'); return; }
		this._controller.deleteNode();
	}
	cmdEditNode(): void {
		if (this._controller?.selectedNodeId) {
			this._editingNodeId = this._controller.selectedNodeId;
			this._render();
		}
	}

	/**
	 * 键盘快捷键处理（复刻参考实现 handleKeyDown）：
	 *   Tab            添加子节点
	 *   Shift+Enter    添加兄弟节点（Enter 无修饰也加兄弟，符合思维导图习惯）
	 *   Delete/Backspace 删除选中节点（或选中连线）
	 *   Space          折叠/展开选中节点
	 *   F2             进入编辑
	 *   ↑↓←→          空间导航（按方向聚焦最近节点）
	 *   Ctrl/Cmd+C/V   复制 / 粘贴节点
	 *   Ctrl/Cmd+Z    撤销；Ctrl/Cmd+Shift+Z 或 Ctrl/Cmd+Y 重做
	 * 返回 true 表示已消费该按键（调用方会 preventDefault/stopPropagation）。
	 */
	private _handleCanvasKeyDown(e: KeyboardEvent): boolean {
		const ctrl = e.ctrlKey || e.metaKey;
		if (ctrl) {
			switch (e.key.toLowerCase()) {
				case 'c': this.cmdCopyNodes(); return true;
				case 'v': this.cmdPasteNodes(); return true;
				case 'z':
					if (e.shiftKey) { this.cmdRedo(); } else { this.cmdUndo(); }
					return true;
				case 'y': this.cmdRedo(); return true;
				default: return false;
			}
		}
		switch (e.key) {
			case 'Tab': this.cmdAddChild(); return true;
			case 'Enter': this.cmdAddSibling(); return true;
			case 'Delete':
			case 'Backspace': this.cmdDeleteNode(); return true;
			case ' ': this.cmdToggleExpand(); return true;
			case 'F2': this.cmdEditNode(); return true;
			case 'ArrowUp': this.cmdNavigate('up'); return true;
			case 'ArrowDown': this.cmdNavigate('down'); return true;
			case 'ArrowLeft': this.cmdNavigate('left'); return true;
			case 'ArrowRight': this.cmdNavigate('right'); return true;
			default: return false;
		}
	}

	/**
	 * 复制选中节点（Ctrl/Cmd+C）—— 复刻参考实现 handleKeyDown 的剪贴板逻辑：
	 * 只做节点数据的浅拷贝（text/type/尺寸/file/content 等），不复制连线。
	 */
	cmdCopyNodes(): void {
		if (!this._controller) { return; }
		const data = this._controller.data;
		const ids = this._selectedTreeIds.size > 0
			? [...this._selectedTreeIds]
			: (this._controller.selectedNodeId ? [this._controller.selectedNodeId] : []);
		if (ids.length === 0) { return; }

		this._clipboard = ids
			.map(id => data.nodes.find(n => n.id === id))
			.filter((n): n is IMindmapNode => !!n)
			.map(n => ({
			type: n.type, width: n.width, height: n.height,
			text: n.text, content: n.content, color: n.color,
			}));
		this.logService.info(`[CanvasEditor] 已复制 ${this._clipboard.length} 个节点`);
	}

	/**
	 * 粘贴节点（Ctrl/Cmd+V）—— 落点为当前视口中心，逐个偏移 PASTE_OFFSET(50) 避免完全重叠。
	 */
	cmdPasteNodes(): void {
		if (!this._controller || this._clipboard.length === 0) { return; }
		const data = this._controller.data;
		const center = this._viewport?.getViewportCenter() ?? { x: 0, y: 0 };
		const PASTE_OFFSET = 50;

		const newIds: string[] = [];
		this._clipboard.forEach((src, i) => {
			const id = this._generateId();
			const node: IMindmapNode = {
				id,
				type: src.type ?? 'text',
				x: center.x + i * PASTE_OFFSET,
				y: center.y + i * PASTE_OFFSET,
				width: src.width ?? 250,
				height: src.height ?? 120,
			text: src.text ?? '',
			content: src.content ?? '',
			color: src.color,
			};
			data.nodes.push(node);
			newIds.push(id);
		});

		this._selectedTreeIds = new Set(newIds);
		this._controller.selectNodes(newIds);
		this._rebuildSubtreeDescendants(data);
		this._render();
		this._renderOutline();
		if (this.input) { this._debouncedSave(this.input as CanvasEditorInput); }
		this.logService.info(`[CanvasEditor] 已粘贴 ${newIds.length} 个节点`);
	}
	cmdSaveAndExit(): void {
		this._editingNodeId = null;
		this._render();
	}
	cmdRelayout(): void { this._controller?.relayout(); }
	cmdApplyColors(): void { this._controller?.applyColors(); }
	cmdFlipBranch(): void { this._controller?.flipBranch(); }
	cmdToggleBalance(): void { this._controller?.toggleBalance(); }
	cmdToggleExpand(): void {
		if (this._editingNodeId) { return; }
		this._controller?.toggleExpand();
	}
	cmdSetDirection(mode: MindmapDirection): void {
		if (this._editingNodeId) { return; }
		this._controller?.setDirection(mode);
	}
	cmdCycleDirection(): void {
		if (this._editingNodeId) { return; }
		const current = this._controller?.data.direction ?? 'both';
		const cycle: MindmapDirection[] = ['both', 'right', 'left', 'tree', 'flower'];
		const idx = cycle.indexOf(current);
		const next = cycle[(idx + 1) % cycle.length];
		this._controller?.setDirection(next);
	}
	private _directionLabel(dir: MindmapDirection): string {
		const labels: Record<MindmapDirection, string> = {
			right: '方向:右', left: '方向:左', both: '方向:平衡', tree: '方向:树', flower: '方向:花瓣',
		};
		return labels[dir];
	}

	/** Ctrl+点击节点 → 跳转到该节点的 source（file:line）。 */
	private _navigateToSource(nodeId: string): void {
		const data = this._controller?.data;
		const node = data?.nodes.find(n => n.id === nodeId);
		if (!node || !node.source) {
			this.logService.info(`[CanvasEditor] 节点 ${nodeId} 无 source，无法跳转源码`);
			return;
		}
		this._openFileInEditor(node.source.file, node.source.line);
	}

	/** 打开文件；若绝对路径不存在，尝试按工作区文件夹相对解析。可选跳转到指定行。 */
	private async _openFileInEditor(filePath: string, lineNumber?: number): Promise<void> {
		const fileUri = URI.file(filePath);
		if (await this.fileService.exists(fileUri)) {
			await this._openAt(fileUri, lineNumber);
			return;
		}
		// 绝对路径不存在：尝试工作区相对路径
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			const candidate = URI.joinPath(folder.uri, filePath);
			if (await this.fileService.exists(candidate)) {
				await this._openAt(candidate, lineNumber);
				return;
			}
		}
		this.logService.warn(`[CanvasEditor] 源文件不存在，无法跳转: ${filePath}`);
	}

	private async _openAt(uri: URI, lineNumber?: number): Promise<void> {
		const group = this.editorGroupsService.activeGroup;
		if (typeof lineNumber === 'number' && lineNumber > 0) {
			await this.editorService.openEditor({
				resource: uri,
				options: {
					selection: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: 1 },
					revealIfOpened: true,
					preserveFocus: false,
				},
			}, group);
		} else {
			await this.editorService.openEditor({
				resource: uri,
				options: { preserveFocus: false },
			}, group);
		}
	}

	/** 命令：跳转当前选中节点的源码（无选中或无 source 时静默忽略）。 */
	cmdNavigateToSource(): void {
		const id = this._controller?.selectedNodeId;
		if (!id) { return; }
		this._navigateToSource(id);
	}
	cmdUndo(): void { this._controller?.undo(); }
	cmdRedo(): void { this._controller?.redo(); }
	cmdFitViewport(): void {
		if (this._controller) { this._fitViewport(this._controller.data); }
	}
	cmdGoBack(): void { this._navNavigate('back'); }
	cmdGoForward(): void { this._navNavigate('forward'); }
	cmdCopyNodeLink(): void {
		if (!this._controller?.selectedNodeId) { return; }
		const link = this._controller.generateNodeLink(this._controller.selectedNodeId);
		// Write to clipboard (use navigator.clipboard as fallback)
		try {
			void (navigator as any).clipboard?.writeText?.(link);
		} catch { /* ignore */ }
	}

	/** 跳转到节点引用（node:<id> 链接被点击、或复制的链接粘贴后被点击） */
	cmdNavigateToNode(nodeId: string): void {
		if (!this._controller || !this._viewport) { return; }
		const ok = this._controller.navigateToNode(nodeId);
		if (!ok) {
			this.logService.warn(`[CanvasEditor] 节点引用目标不存在: ${nodeId}`);
			return;
		}
		this._editingNodeId = null;
		this._selectedTreeIds = new Set([nodeId]);
		this._render();
		// 居中到目标节点
		const node = this._controller.data.nodes.find(n => n.id === nodeId);
		if (node) {
			this._viewport.centerOn(
				{ minX: node.x - 80, minY: node.y - 80, maxX: node.x + node.width + 80, maxY: node.y + node.height + 80 },
				40
			);
		}
	}

	private _navNavigate(direction: 'back' | 'forward'): void {
		if (!this._controller) { return; }
		const targetId = direction === 'back' ? this._controller.goBack() : this._controller.goForward();
		if (!targetId) { return; }
		this._editingNodeId = null;
		this._selectedTreeIds = new Set([targetId]);
		this._render();
		this._renderOutline();
		const targetNode = this._controller.data.nodes.find(n => n.id === targetId);
		if (targetNode && this._viewport) {
			this._viewport.centerOn({
				minX: targetNode.x - 100, minY: targetNode.y - 100,
				maxX: targetNode.x + targetNode.width + 100,
				maxY: targetNode.y + targetNode.height + 100,
			}, 50);
		}
		// Save on navigation
		const input = this.input as CanvasEditorInput;
		if (input) { this._debouncedSave(input); }
	}

	// 空间导航
	cmdNavigate(direction: 'up' | 'down' | 'left' | 'right'): void {
		if (!this._controller) { return; }
		const selId = this._controller.selectedNodeId;
		if (!selId) { return; }

		const data = this._controller.data;
		const forest = buildForest(data);
		const treeNode = findTreeForNode(forest, selId);
		if (!treeNode) { return; }

		// 退出编辑
		this._editingNodeId = null;

		let targetId: string | null = null;

		switch (direction) {
			case 'up': {
				const prev = getPrevSibling(treeNode);
				if (prev) { targetId = prev.node.id; }
				else if (treeNode.parent) {
					const siblings = treeNode.parent.children;
					targetId = siblings[siblings.length - 1].node.id;
				}
				break;
			}
			case 'down': {
				const next = getNextSibling(treeNode);
				if (next) { targetId = next.node.id; }
				else if (treeNode.parent) {
					targetId = treeNode.parent.children[0].node.id;
				}
				break;
			}
			case 'left': {
				if (treeNode.children.length > 0) {
					const leftKids = treeNode.children.filter(c => c.direction === 'left');
					if (leftKids.length > 0) {
						let best = leftKids[0];
						const nodeCy = treeNode.node.y + treeNode.node.height / 2;
						for (const k of leftKids) {
							const kCy = k.node.y + k.node.height / 2;
							if (Math.abs(kCy - nodeCy) < Math.abs((best.node.y + best.node.height / 2) - nodeCy)) {
								best = k;
							}
						}
						targetId = best.node.id;
					} else {
						targetId = treeNode.children[0].node.id;
					}
				} else if (treeNode.parent) {
					targetId = treeNode.parent.node.id;
				}
				break;
			}
			case 'right': {
				if (treeNode.children.length > 0) {
					const rightKids = treeNode.children.filter(c => c.direction === 'right');
					if (rightKids.length > 0) {
						let best = rightKids[0];
						const nodeCy = treeNode.node.y + treeNode.node.height / 2;
						for (const k of rightKids) {
							const kCy = k.node.y + k.node.height / 2;
							if (Math.abs(kCy - nodeCy) < Math.abs((best.node.y + best.node.height / 2) - nodeCy)) {
								best = k;
							}
						}
						targetId = best.node.id;
					} else {
						targetId = treeNode.children[0].node.id;
					}
				} else if (treeNode.parent) {
					targetId = treeNode.parent.node.id;
				}
				break;
			}
		}

		if (targetId) {
			this._controller.selectNode(targetId);
			this._selectedTreeIds = new Set([targetId]);
			this._render();
			this._renderOutline();
			// 缩放至目标
			const targetNode = data.nodes.find(n => n.id === targetId);
			if (targetNode && this._viewport) {
				this._viewport.centerOn({
					minX: targetNode.x - 100, minY: targetNode.y - 100,
					maxX: targetNode.x + targetNode.width + 100,
					maxY: targetNode.y + targetNode.height + 100,
				}, 50);
			}
			// 保存（导航触发）
			const input = this.input as CanvasEditorInput;
			if (input) { this._debouncedSave(input); }
		}
	}

	// ── 大纲 ───────────────────────────────────────────────────────

	private async cmdImportFreemind(): Promise<void> {
		const picks = await this.dialogService.showOpenDialog({
			title: '导入 FreeMind (.mm)',
			canSelectFiles: true,
			canSelectMany: false,
			filters: [{ name: 'FreeMind', extensions: ['mm'] }],
		});
		if (!picks || picks.length === 0) { return; }
		try {
			const content = await this.fileService.readFile(picks[0]);
			const text = content.value.toString();
			const data = parseFreeMindXmlAndConvert(text);
			if (!data) {
				this.notificationService.warn('FreeMind 文件解析失败：不是有效的 .mm 文件');
				return;
			}
			data.mindmap = true;
			this._controller?.importData(data);
			this._render();
			this._renderOutline();
			this.notificationService.info(`已导入 FreeMind：${data.nodes.length} 个节点、${data.edges.length} 条连线`);
		} catch (err) {
			this.notificationService.error(`导入 FreeMind 失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** 大纲双向高亮：根据活动节点 id 高亮对应大纲行并滚动可见。 */
	private _updateOutlineActive(id: string | null): void {
		if (!this._outlineEl) { return; }
		const rows = this._outlineEl.querySelectorAll('.outline-item');
		rows.forEach(r => {
			const el = r as HTMLElement;
			const match = el.dataset.nodeId === id;
			el.classList.toggle('outline-active', match);
			if (match) { el.scrollIntoView({ block: 'nearest' }); }
		});
	}

	/** 大纲行 hover：高亮画布节点并同步大纲高亮（双向联动）。 */
	private _onOutlineRowEnter(id: string): void {
		this._viewport?.setActiveNodeId(id);
		this._updateOutlineActive(id);
	}

	toggleOutline(): void {
		if (!this._outlineEl) { return; }
		const visible = this._outlineEl.style.display !== 'none';
		this._outlineEl.style.display = visible ? 'none' : 'block';
		// 切换为显示后，大纲此前因隐藏被 _renderOutline 跳过渲染，这里主动重渲染
		if (!visible) { this._renderOutline(); }
	}

	private _renderOutline(): void {
		if (!this._outlineEl || !this._controller || this._outlineEl.style.display === 'none') { return; }
		this._outlineEl.innerHTML = '';

		const data = this._controller.data;
		// includeGroups=true：让分组节点参与大纲森林（用户要求的「参与森林」）
		const forest = buildForest(data, true);
		const selId = this._controller.selectedNodeId;

		for (const root of forest) {
			this._renderOutlineNode(root, this._outlineEl, 0, selId, data);
		}
		this._updateOutlineActive(selId);
	}

	private _renderOutlineNode(treeNode: ReturnType<typeof buildForest>[0], parentEl: HTMLElement, depth: number, selId: string | null, data: IMindmapData): void {
		const node = treeNode.node;
		const hasChildren = data.edges.some(e => e.fromNode === node.id);
		const row = DOM.$('div');
		row.className = 'outline-item';
		row.dataset.nodeId = node.id;
		row.style.cssText = `display:flex;align-items:center;padding:2px 4px 2px ${8 + depth * 12}px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
		if (node.id === selId) {
			row.style.background = 'var(--vscode-list-activeSelectionBackground)';
			row.style.color = 'var(--vscode-list-activeSelectionForeground)';
		}

		const icon = DOM.$('span');
		if (hasChildren) {
			icon.textContent = node.expanded === false ? '▶' : '▼';
			icon.title = node.expanded === false ? '展开子树' : '折叠子树';
			icon.style.cursor = 'pointer';
			icon.onclick = (ev) => {
				ev.stopPropagation();
				this._controller?.toggleExpand(node.id);
			};
		} else {
			icon.textContent = '●';
		}
		icon.style.cssText = 'margin-right:4px;font-size:10px;flex-shrink:0;';
		row.appendChild(icon);

		const label = DOM.$('span');
		label.textContent = (node.type === 'group' ? (node.text || '分组') : (node.text || node.content || '(empty)')).slice(0, 40);
		label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
		row.appendChild(label);

		row.onclick = () => {
			this._controller?.selectNode(node.id);
			this._selectedTreeIds = new Set([node.id]);
			this._render();
			this._renderOutline();
			// 缩放至节点
			if (this._viewport && this._controller) {
				const n = node;
				this._viewport.centerOn({
					minX: n.x - 100, minY: n.y - 100,
					maxX: n.x + n.width + 100, maxY: n.y + n.height + 100,
				}, 50);
			}
		};
		row.onmouseenter = () => this._onOutlineRowEnter(node.id);

		parentEl.appendChild(row);

		for (const child of treeNode.children) {
			this._renderOutlineNode(child, parentEl, depth + 1, selId, data);
		}
	}

	// ── 渲染 ───────────────────────────────────────────────────────

	private _selectedTreeIds = new Set<string>();
	private _editingNodeId: string | null = null;
	/** Ctrl+C 剪贴板（仅节点数据，不含连线），对齐参考实现 InputHandler.clipboard */
	private _clipboard: Array<Partial<IMindmapNode>> = [];

	private _render(): void {
		if (!this._viewport || !this._controller) { return; }
		const allSelected = new Set([...this._selectedTreeIds]);
		if (this._controller.selectedNodeId) {
			allSelected.add(this._controller.selectedNodeId);
		}
		this.logService.info(`[CanvasEditor] _render: nodes=${this._controller.data.nodes.length}, edges=${this._controller.data.edges.length}, zoom=${this._viewport.zoom.toFixed(3)}, pan=(${this._viewport.panX.toFixed(1)},${this._viewport.panY.toFixed(1)})`);
		this._viewport.syncNodes(this._controller.data, allSelected, this._editingNodeId);
	}

	private _fitViewport(data: IMindmapData): void {
		if (!this._viewport || data.nodes.length === 0) { return; }
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const n of data.nodes) {
			if (n.type === 'group') { continue; }
			minX = Math.min(minX, n.x);
			minY = Math.min(minY, n.y);
			maxX = Math.max(maxX, n.x + n.width);
			maxY = Math.max(maxY, n.y + n.height);
		}
		if (minX === Infinity) { return; }
		const rectBefore = this._viewport.container.getBoundingClientRect();
		this.logService.info(`[CanvasEditor] _fitViewport: bounds=${minX.toFixed(0)},${minY.toFixed(0)},${maxX.toFixed(0)},${maxY.toFixed(0)} containerRect=${rectBefore.width}x${rectBefore.height}`);
		this._viewport.centerOn({ minX, minY, maxX, maxY }, 100);
		const rectAfter = this._viewport.container.getBoundingClientRect();
		this.logService.info(`[CanvasEditor] _fitViewport: after centerOn -> zoom=${this._viewport.zoom.toFixed(3)}, pan=(${this._viewport.panX.toFixed(1)},${this._viewport.panY.toFixed(1)}), containerRect=${rectAfter.width}x${rectAfter.height}`);
	}

	private _generateId(): string {
		return Array.from({ length: 16 }, () =>
			Math.floor(Math.random() * 16).toString(16)
		).join('');
	}

	private _rebuildSubtreeDescendants(data: IMindmapData): void {
		if (!this._viewport) { return; }
		for (const node of data.nodes) {
			if (node.type === 'group') { continue; }
			const descSet = new Set<string>();
			const queue = [node.id];
			const visited = new Set([node.id]);
			while (queue.length > 0) {
				const id = queue.shift()!;
				const children = getDirectChildNodes(id, data);
				for (const child of children) {
					if (!visited.has(child.id)) {
						visited.add(child.id);
						descSet.add(child.id);
						queue.push(child.id);
					}
				}
			}
			this._viewport.setSubtreeDescendants(node.id, descSet);
		}
	}

	// ── 保存 ───────────────────────────────────────────────────────

	private _saveTimer: ReturnType<typeof setTimeout> | null = null;

	private _debouncedSave(input: CanvasEditorInput): void {
		if (this._saveTimer) { clearTimeout(this._saveTimer); }
		this._saveTimer = setTimeout(() => {
			this._saveTimer = null;
			this._doSave(input);
		}, 500);
	}

	private async _doSave(input: CanvasEditorInput): Promise<void> {
		if (!this._controller) { return; }
		const json = this._controller.getJsonData();
		try {
			await this.fileService.writeFile(
				input.resource,
				VSBuffer.fromString(json),
			);
		} catch (err) {
			this.logService.warn('[CanvasEditor] Save failed:', err);
		}
	}

	// ── 思维导图布局自动检测与修复 ─────────────────────────────

	/**
	 * 检测节点是否为网格/平铺布局（y 坐标几乎全相同）。
	 * 判定标准：≥80% 的节点 y 值落在 [minY, minY+5] 范围内。
	 */
	private _isGridLayout(nodes: IMindmapNode[]): boolean {
		if (nodes.length < 3) { return false; }
		const yValues = nodes.map(n => n.y ?? 0).sort((a, b) => a - b);
		const minY = yValues[0];
		// 统计有多少节点的 y 值接近最小值（容差 5px）
		const nearMin = yValues.filter(y => Math.abs(y - minY) <= 5).length;
		return nearMin >= nodes.length * 0.8;
	}

	/**
	 * 对数据应用思维导图树状放射布局（就地修改 data）。
	 * 复用 kbMindmapGenerator 的布局算法核心逻辑。
	 */
	private _applyMindmapLayout(data: IMindmapData): void {
		const NODE_W = 280;
		const NODE_H = 80;
		const LEVEL_GAP = 72;
		const SIB_GAP = 24;

		const nodes = data.nodes;
		if (nodes.length === 0) { return; }

		// 标准化尺寸
		for (const n of nodes) {
			n.width = n.width || NODE_W;
			n.height = n.height || NODE_H;
		}

		const nodeMap = new Map(nodes.map(n => [n.id, n]));

		// 构建邻接表
		const out = new Map<string, string[]>();
		const indeg = new Map<string, number>();
		for (const n of nodes) {
			out.set(n.id, []);
			indeg.set(n.id, 0);
		}
		for (const e of data.edges) {
			if (nodeMap.has(e.fromNode) && nodeMap.has(e.toNode)) {
				out.get(e.fromNode)!.push(e.toNode);
				indeg.set(e.toNode, (indeg.get(e.toNode) ?? 0) + 1);
			}
		}

		// 推断根节点：入度最小 → 出度最大
		const rootId = [...nodes]
			.map(n => n.id)
			.sort((a, b) => {
				const di = (indeg.get(a) ?? 0) - (indeg.get(b) ?? 0);
				if (di !== 0) { return di; }
				return (out.get(b)?.length ?? 0) - (out.get(a)?.length ?? 0);
			})[0];

		// BFS 建树
		const visited = new Set<string>([rootId]);
		const treeChildren = new Map<string, string[]>();
		const queue: string[] = [rootId];
		while (queue.length) {
			const cur = queue.shift()!;
			treeChildren.set(cur, []);
			for (const nxt of out.get(cur) ?? []) {
				if (!visited.has(nxt)) {
					visited.add(nxt);
					treeChildren.get(cur)!.push(nxt);
					queue.push(nxt);
				}
			}
		}
		// 孤立/成环节点挂到根下
		for (const n of nodes) {
			if (!visited.has(n.id)) {
				visited.add(n.id);
				treeChildren.get(rootId)!.push(n.id);
			}
		}

		// 后序计算子树高度
		const layoutInfo = new Map<string, { children: string[]; subH: number }>();
		for (const n of nodes) { layoutInfo.set(n.id, { children: treeChildren.get(n.id) ?? [], subH: 0 }); }
		const measure = (id: string): number => {
			const ln = layoutInfo.get(id)!;
			if (ln.children.length === 0) {
				ln.subH = NODE_H;
			} else {
				let sum = 0;
				ln.children.forEach((c, i) => {
					sum += measure(c);
					if (i < ln.children.length - 1) { sum += SIB_GAP; }
				});
				ln.subH = Math.max(sum, NODE_H);
			}
			return ln.subH;
		};
		measure(rootId);

		// 前序放置
		const place = (id: string, x: number, centerY: number, dir: 'L' | 'R'): void => {
			const node = nodeMap.get(id)!;
			node.x = dir === 'R' ? x : x - NODE_W;
			node.y = centerY - NODE_H / 2;
			const ln = layoutInfo.get(id)!;
			let cursor = centerY - ln.subH / 2;
			for (const c of ln.children) {
				const childH = layoutInfo.get(c)!.subH;
				const cCenterY = cursor + childH / 2;
				const childX = dir === 'R'
					? node.x + NODE_W + LEVEL_GAP
					: node.x - LEVEL_GAP - NODE_W;
				place(c, childX, cCenterY, dir);
				cursor += childH + SIB_GAP;
			}
		};

		// 左右均衡分配子节点
		const rootChildren = layoutInfo.get(rootId)!.children;
		const sorted = [...rootChildren].sort((a, b) => layoutInfo.get(b)!.subH - layoutInfo.get(a)!.subH);
		const leftIds: string[] = [];
		const rightIds: string[] = [];
		let leftLoad = 0, rightLoad = 0;
		for (const c of sorted) {
			const h = layoutInfo.get(c)!.subH;
			if (leftLoad <= rightLoad) { leftIds.push(c); leftLoad += h + SIB_GAP; }
			else { rightIds.push(c); rightLoad += h + SIB_GAP; }
		}

		const groupHeight = (ids: string[]): number => {
			let s = 0;
			ids.forEach((id, i) => {
				s += layoutInfo.get(id)!.subH;
				if (i < ids.length - 1) { s += SIB_GAP; }
			});
			return s;
		};

		const root = nodeMap.get(rootId)!;
		root.x = -NODE_W / 2;
		root.y = -NODE_H / 2;

		let lCursor = -groupHeight(leftIds) / 2;
		for (const id of leftIds) {
			const h = layoutInfo.get(id)!.subH;
			place(id, root.x - LEVEL_GAP - NODE_W, lCursor + h / 2, 'L');
			lCursor += h + SIB_GAP;
		}
		let rCursor = -groupHeight(rightIds) / 2;
		for (const id of rightIds) {
			const h = layoutInfo.get(id)!.subH;
			place(id, root.x + NODE_W + LEVEL_GAP, rCursor + h / 2, 'R');
			rCursor += h + SIB_GAP;
		}

		// 更新边的连接面与箭头
		for (const e of data.edges) {
			const fn = nodeMap.get(e.fromNode);
			const tn = nodeMap.get(e.toNode);
			if (!fn || !tn) { continue; }
			const fc = fn.x! + fn.width! / 2;
			const tc = tn.x! + tn.width! / 2;
			e.fromSide = tc >= fc ? 'right' : 'left';
			e.toSide = tc >= fc ? 'left' : 'right';
			e.fromEnd = 'none';
			e.toEnd = 'arrow';
		}

		// 整体平移到正坐标
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const n of nodes) {
			minX = Math.min(minX, n.x ?? 0); minY = Math.min(minY, n.y ?? 0);
			maxX = Math.max(maxX, (n.x ?? 0) + (n.width ?? NODE_W));
			maxY = Math.max(maxY, (n.y ?? 0) + (n.height ?? NODE_H));
		}
		const offsetX = 80 - minX;
		const offsetY = 80 - minY;
		for (const n of nodes) {
			n.x = (n.x ?? 0) + offsetX;
			n.y = (n.y ?? 0) + offsetY;
		}

		this.logService.info(`[CanvasEditor] mindmap applied: ${nodes.length} nodes, bounds=${(maxX+offsetX-minX).toFixed(0)}x${(maxY+offsetY-minY).toFixed(0)}, root=${rootId}`);
	}

	/**
	 * 推断根节点 ID（入度最小 → 出度最大 → 第一个节点）。
	 */
	private _inferRootNodeId(data: IMindmapData): string {
		if (data.nodes.length === 0) { return ''; }
		if (data.nodes.length === 1) { return data.nodes[0].id; }

		const indeg = new Map<string, number>();
		const out = new Map<string, string[]>();
		for (const n of data.nodes) {
			indeg.set(n.id, 0);
			out.set(n.id, []);
		}
		for (const e of data.edges) {
			if (indeg.has(e.toNode)) { indeg.set(e.toNode, indeg.get(e.toNode)! + 1); }
			if (out.has(e.fromNode)) { out.get(e.fromNode)!.push(e.toNode); }
		}

		return [...data.nodes]
			.map(n => n.id)
			.sort((a, b) => {
				const di = (indeg.get(a) ?? 0) - (indeg.get(b) ?? 0);
				if (di !== 0) { return di; }
				return (out.get(b)?.length ?? 0) - (out.get(a)?.length ?? 0);
			})[0];
	}

	// ── 工具栏 ─────────────────────────────────────────────────────

	private _createToolbar(): HTMLElement {
		const bar = DOM.$('div.canvas-editor-toolbar');
		bar.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);flex-shrink:0;';

		const addBtn = (text: string, title: string, onClick: () => void) => {
			const btn = DOM.$('button');
			btn.textContent = text;
			btn.title = title;
			btn.style.cssText = 'padding:2px 8px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer;font-size:12px;';
			btn.onclick = onClick;
			return btn;
		};

		bar.appendChild(addBtn('+子', '添加子节点 (Tab)', () => this.cmdAddChild()));
		bar.appendChild(addBtn('+兄', '添加兄弟节点 (Shift+Enter)', () => this.cmdAddSibling()));
		bar.appendChild(addBtn('删除', '删除节点 (Del)', () => this.cmdDeleteNode()));
		bar.appendChild(addBtn('布局', '自动布局', () => this.cmdRelayout()));
		bar.appendChild(addBtn('着色', '分支着色', () => this.cmdApplyColors()));
		bar.appendChild(addBtn('翻转', '翻转分支', () => this.cmdFlipBranch()));
		bar.appendChild(addBtn('平衡', '平衡布局', () => this.cmdToggleBalance()));
		bar.appendChild(addBtn('折叠', '折叠/展开节点 (Space)', () => this.cmdToggleExpand()));
		const directionBtn = addBtn(this._directionLabel(this._controller?.data.direction ?? 'both'), '布局方向：平衡/右/左/树/花瓣（点击循环切换）', () => this.cmdCycleDirection());
		this._directionBtn = directionBtn;
		bar.appendChild(directionBtn);
		bar.appendChild(addBtn('撤销', '撤销 (Ctrl+Z)', () => this.cmdUndo()));
		bar.appendChild(addBtn('重做', '重做 (Ctrl+Y)', () => this.cmdRedo()));
		bar.appendChild(addBtn('大纲', '大纲面板', () => this.toggleOutline()));
		bar.appendChild(addBtn('←', '后退 (Alt+←)', () => this.cmdGoBack()));
		bar.appendChild(addBtn('→', '前进 (Alt+→)', () => this.cmdGoForward()));
		bar.appendChild(addBtn('🔗', '复制节点链接', () => this.cmdCopyNodeLink()));
		bar.appendChild(addBtn('适应', '适应窗口', () => this.cmdFitViewport()));
		bar.appendChild(addBtn('导入', '导入 FreeMind (.mm) 文件', () => this.cmdImportFreemind()));

		return bar;
	}

	// ── 生命周期 ───────────────────────────────────────────────────

	private _onBlur(): void {
		this._editingNodeId = null;
	}

	override getActionsContext(): unknown {
		return undefined;
	}

	override focus(): void {
		this._viewport?.container.focus();
	}

	override dispose(): void {
		if (_activePane === this) { _activePane = null; }
		if (this._saveTimer) {
			clearTimeout(this._saveTimer);
			this._saveTimer = null;
		}
		this._viewport?.dispose();
		this._viewport = undefined;
		this._controller = undefined;
		super.dispose();
	}
}
