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
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CanvasEditorInput } from './canvasEditorInput.js';
import { CanvasEditorController } from './canvasEditorController.js';
import { CanvasViewport } from './view/canvasViewport.js';
import type { IMindmapData, IMindmapNode } from '../../common/mindmap/mindmapTypes.js';
import { getDirectChildNodes, buildForest, findTreeForNode,
	getNextSibling, getPrevSibling } from '../../common/mindmap/treeModel.js';
import { createMindmapEdge } from '../../common/mindmap/edgeSides.js';

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
	}

	static readonly ID = 'workbench.editor.agentStudio.canvasEditorPane';

	private _container: HTMLElement | undefined;
	private _viewport: CanvasViewport | undefined;
	private _controller: CanvasEditorController | undefined;
	private _toolbar: HTMLElement | undefined;
	private _outlineEl: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
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

		// Wire controller → viewport & save
		this._controller.onDataChanged = (updatedData) => {
			input.mindmapData = updatedData;
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

		this._viewport.onNodeDblClick = (nodeId) => {
			this._controller!.selectNode(nodeId);
			this._editingNodeId = nodeId;
			this._render();
		};

		this._viewport.onNodeDragEnd = (nodeId, x, y) => {
			const nd = data.nodes.find(n => n.id === nodeId);
			if (!nd) { return; }
			const dx = x - nd.x;
			const dy = y - nd.y;
			nd.x = x;
			nd.y = y;
			const descIds = this._viewport!._subtreeDescendantMap?.get(nodeId);
			if (descIds) {
				for (const descId of descIds) {
					const descNode = data.nodes.find(n => n.id === descId);
					if (descNode) {
						descNode.x += dx;
						descNode.y += dy;
					}
				}
			}
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
			const newNode: IMindmapNode = {
				id, type: 'text', x: x - 150, y: y - 30, width: 300, height: 60, text: '',
			};
			data.nodes.push(newNode);
			this._editingNodeId = id;
			this._controller!.selectNode(id);
			this._render();
			this._renderOutline();
			this._debouncedSave(input);
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
	cmdDeleteNode(): void { this._controller?.deleteNode(); }
	cmdEditNode(): void {
		if (this._controller?.selectedNodeId) {
			this._editingNodeId = this._controller.selectedNodeId;
			this._render();
		}
	}
	cmdSaveAndExit(): void {
		this._editingNodeId = null;
		this._render();
	}
	cmdRelayout(): void { this._controller?.relayout(); }
	cmdApplyColors(): void { this._controller?.applyColors(); }
	cmdFlipBranch(): void { this._controller?.flipBranch(); }
	cmdToggleBalance(): void { this._controller?.toggleBalance(); }
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

	toggleOutline(): void {
		if (!this._outlineEl) { return; }
		const visible = this._outlineEl.style.display !== 'none';
		this._outlineEl.style.display = visible ? 'none' : 'block';
	}

	private _renderOutline(): void {
		if (!this._outlineEl || !this._controller || this._outlineEl.style.display === 'none') { return; }
		this._outlineEl.innerHTML = '';

		const data = this._controller.data;
		const forest = buildForest(data);
		const selId = this._controller.selectedNodeId;

		for (const root of forest) {
			this._renderOutlineNode(root, this._outlineEl, 0, selId);
		}
	}

	private _renderOutlineNode(treeNode: ReturnType<typeof buildForest>[0], parentEl: HTMLElement, depth: number, selId: string | null): void {
		const row = DOM.$('div');
		row.style.cssText = `display:flex;align-items:center;padding:2px 4px 2px ${8 + depth * 12}px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
		if (treeNode.node.id === selId) {
			row.style.background = 'var(--vscode-list-activeSelectionBackground)';
			row.style.color = 'var(--vscode-list-activeSelectionForeground)';
		}

		const icon = DOM.$('span');
		icon.textContent = treeNode.children.length > 0 ? '▼' : '●';
		icon.style.cssText = 'margin-right:4px;font-size:10px;flex-shrink:0;';
		row.appendChild(icon);

		const label = DOM.$('span');
		label.textContent = (treeNode.node.text || treeNode.node.content || '(empty)').slice(0, 40);
		label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
		row.appendChild(label);

		row.onclick = () => {
			this._controller?.selectNode(treeNode.node.id);
			this._selectedTreeIds = new Set([treeNode.node.id]);
			this._render();
			this._renderOutline();
			// 缩放至节点
			if (this._viewport && this._controller) {
				const n = treeNode.node;
				this._viewport.centerOn({
					minX: n.x - 100, minY: n.y - 100,
					maxX: n.x + n.width + 100, maxY: n.y + n.height + 100,
				}, 50);
			}
		};

		parentEl.appendChild(row);

		for (const child of treeNode.children) {
			this._renderOutlineNode(child, parentEl, depth + 1, selId);
		}
	}

	// ── 渲染 ───────────────────────────────────────────────────────

	private _selectedTreeIds = new Set<string>();
	private _editingNodeId: string | null = null;

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
		bar.appendChild(addBtn('撤销', '撤销 (Ctrl+Z)', () => this.cmdUndo()));
		bar.appendChild(addBtn('重做', '重做 (Ctrl+Y)', () => this.cmdRedo()));
		bar.appendChild(addBtn('大纲', '大纲面板', () => this.toggleOutline()));
		bar.appendChild(addBtn('←', '后退 (Alt+←)', () => this.cmdGoBack()));
		bar.appendChild(addBtn('→', '前进 (Alt+→)', () => this.cmdGoForward()));
		bar.appendChild(addBtn('🔗', '复制节点链接', () => this.cmdCopyNodeLink()));
		bar.appendChild(addBtn('适应', '适应窗口', () => this.cmdFitViewport()));

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
