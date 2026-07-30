/*---------------------------------------------------------------------------------------------
 *  Sarosis Agents — Canvas Editor Controller
 *
 *  编排层：持有内存模型，协调视图、布局引擎、节点操作的调用。
 *  负责 undo/redo、保存、键盘命令路由。
 *--------------------------------------------------------------------------------------------*/

import type { IMindmapData, INodePosition } from '../../common/mindmap/mindmapTypes.js';
import { LayoutEngine } from '../../common/mindmap/layoutEngine.js';
import {
	addChild, addSibling, deleteAndFocusParent, flipBranch, toggleBalancedLayout,
	type INodeOperationResult,
} from '../../common/mindmap/nodeOperations.js';
import { buildForest, findTreeForNode,
	getDirectChildNodes, getParentNode, getDescendants } from '../../common/mindmap/treeModel.js';
import { applyBranchColors } from '../../common/mindmap/branchColors.js';
import { updateAllEdgeSides } from '../../common/mindmap/edgeSides.js';

// ─── 快照（undo/redo） ────────────────────────────────────────────────────

interface ISnapshot {
	data: IMindmapData;
	selection: string | null;
}

// ─── Controller ───────────────────────────────────────────────────────────

export class CanvasEditorController {

	private _data: IMindmapData;
	private _layoutEngine: LayoutEngine;

	/** 选中的节点 ID */
	private _selectedNodeId: string | null = null;

	/** undo 栈 */
	private _undoStack: ISnapshot[] = [];
	private _redoStack: ISnapshot[] = [];
	private _maxUndo = 50;

	/** 变更回调 */
	onDataChanged: ((data: IMindmapData) => void) | null = null;
	onSelectionChanged: ((nodeId: string | null) => void) | null = null;
	onLayoutApplied: ((positions: Map<string, INodePosition>) => void) | null = null;
	onFocusRequest: ((nodeId: string) => void) | null = null;
	onNavigateToNode: ((nodeId: string) => void) | null = null;

	constructor(data: IMindmapData) {
		this._data = data;
		this._layoutEngine = new LayoutEngine();
	}

	get data(): IMindmapData { return this._data; }
	get selectedNodeId(): string | null { return this._selectedNodeId; }

	// ── 选择 ───────────────────────────────────────────────────────────

	selectNode(nodeId: string | null): void {
		this._selectedNodeId = nodeId;
		if (nodeId) { this.recordVisit(nodeId); }
		this.onSelectionChanged?.(nodeId);
	}

	// ── 快照（操作前推入 undo 栈） ─────────────────────────────────────

	private pushUndo(): void {
		const snapshot: ISnapshot = {
			data: JSON.parse(JSON.stringify(this._data)),
			selection: this._selectedNodeId,
		};
		this._undoStack.push(snapshot);
		if (this._undoStack.length > this._maxUndo) {
			this._undoStack.shift();
		}
		this._redoStack = [];
	}

	// ── Undo / Redo ────────────────────────────────────────────────────

	undo(): void {
		if (this._undoStack.length === 0) { return; }
		this._redoStack.push({
			data: JSON.parse(JSON.stringify(this._data)),
			selection: this._selectedNodeId,
		});
		const snap = this._undoStack.pop()!;
		this._data = snap.data;
		this._selectedNodeId = snap.selection;
		this.onDataChanged?.(this._data);
		this.onSelectionChanged?.(this._selectedNodeId);
	}

	redo(): void {
		if (this._redoStack.length === 0) { return; }
		this._undoStack.push({
			data: JSON.parse(JSON.stringify(this._data)),
			selection: this._selectedNodeId,
		});
		const snap = this._redoStack.pop()!;
		this._data = snap.data;
		this._selectedNodeId = snap.selection;
		this.onDataChanged?.(this._data);
		this.onSelectionChanged?.(this._selectedNodeId);
	}

	// ── 导航历史（参观栈，上限 50） ────────────────────────────────────

	private _visitHistory: string[] = [];
	private _visitIndex = -1;
	private _maxVisits = 50;

	/** 记录节点访问（选择改变时自动调用） */
	recordVisit(nodeId: string): void {
		if (this._visitIndex >= 0 && this._visitHistory[this._visitIndex] === nodeId) {
			return;
		}
		// 截断前进栈
		this._visitHistory = this._visitHistory.slice(0, this._visitIndex + 1);
		this._visitHistory.push(nodeId);
		if (this._visitHistory.length > this._maxVisits) {
			this._visitHistory.shift();
		}
		this._visitIndex = this._visitHistory.length - 1;
	}

	get canGoBack(): boolean { return this._visitIndex > 0; }
	get canGoForward(): boolean { return this._visitIndex < this._visitHistory.length - 1; }

	goBack(): string | null {
		if (!this.canGoBack) { return null; }
		this._visitIndex--;
		this._selectedNodeId = this._visitHistory[this._visitIndex];
		return this._selectedNodeId;
	}

	goForward(): string | null {
		if (!this.canGoForward) { return null; }
		this._visitIndex++;
		this._selectedNodeId = this._visitHistory[this._visitIndex];
		return this._selectedNodeId;
	}

	// ── 节点引用 ───────────────────────────────────────────────────────

	/** 生成节点引用命令 URI */
	generateNodeLink(nodeId: string): string {
		const label = this._data.nodes.find(n => n.id === nodeId)?.text || 'Untitled';
		return `command:sarosis.canvas.revealNode?${encodeURIComponent(JSON.stringify({ nodeId, label }))}`;
	}

	/** 根据节点 ID 导航（供 URI handler 调用） */
	navigateToNode(nodeId: string): boolean {
		const node = this._data.nodes.find(n => n.id === nodeId);
		if (!node) { return false; }
		this._selectedNodeId = nodeId;
		this.recordVisit(nodeId);
		this.onNavigateToNode?.(nodeId);
		return true;
	}

	// ── 节点操作 ───────────────────────────────────────────────────────

	private applyOperation(result: INodeOperationResult | null): void {
		if (!result) { return; }
		this._data = result.data;

		// 重排受影响的子树
		if (result.relayoutParentId) {
			const layout = this._layoutEngine.computeChildrenLayout(this._data, result.relayoutParentId);
			this._applyPositions(layout.positions);
		}

		this.onDataChanged?.(this._data);

		// 聚焦新节点或父节点
		const focusId = result.newNodeId ?? result.focusNodeId;
		if (focusId) {
			this._selectedNodeId = focusId;
			this.onSelectionChanged?.(focusId);
			this.onFocusRequest?.(focusId);
		}
	}

	addChild(initialText: string = ''): void {
		if (!this._selectedNodeId) { return; }
		this.pushUndo();
		const result = addChild(this._data, this._selectedNodeId, {
			nodeWidth: 300, nodeHeight: 60, horizontalGap: 80, verticalGap: 20,
		}, initialText);
		this.applyOperation(result);
	}

	addSibling(initialText: string = ''): void {
		if (!this._selectedNodeId) { return; }
		this.pushUndo();
		const result = addSibling(this._data, this._selectedNodeId, {
			nodeWidth: 300, nodeHeight: 60, horizontalGap: 80, verticalGap: 20,
		}, initialText);
		this.applyOperation(result);
	}

	deleteNode(): void {
		if (!this._selectedNodeId) { return; }
		const current = this._data.nodes.find(n => n.id === this._selectedNodeId);
		if (!current) { return; }
		const parent = getParentNode(this._selectedNodeId, this._data);
		if (!parent) { return; } // 不删根
		this.pushUndo();
		const result = deleteAndFocusParent(this._data, this._selectedNodeId);
		this.applyOperation(result);
	}

	flipBranch(): void {
		if (!this._selectedNodeId) { return; }
		this.pushUndo();
		const result = flipBranch(this._data, this._selectedNodeId);
		this.applyOperation(result);
	}

	toggleBalance(): void {
		// 对选中节点的父节点做平衡切换
		if (!this._selectedNodeId) { return; }
		const node = this._data.nodes.find(n => n.id === this._selectedNodeId);
		if (!node) { return; }
		const parent = getParentNode(this._selectedNodeId, this._data);
		if (!parent) {
			// 如果选中节点本身是根（或节点有多子），直接对选中节点操作
			const children = getDirectChildNodes(node.id, this._data);
			if (children.length >= 2) {
				this.pushUndo();
				const result = toggleBalancedLayout(this._data, node.id);
				this.applyOperation(result);
			}
			return;
		}
		this.pushUndo();
		const result = toggleBalancedLayout(this._data, parent.id);
		this.applyOperation(result);
	}

	// ── 布局 ───────────────────────────────────────────────────────────

	relayout(): void {
		this.pushUndo();
		const layout = this._layoutEngine.computeLayout(this._data);
		this._applyPositions(layout.positions);
		this.onDataChanged?.(this._data);
	}

	relayoutSubtree(): void {
		if (!this._selectedNodeId) { return; }
		this.pushUndo();
		const layout = this._layoutEngine.computeChildrenLayout(this._data, this._selectedNodeId);
		this._applyPositions(layout.positions);
		this.onDataChanged?.(this._data);
	}

	layoutForest(groupNodeId: string): void {
		this.pushUndo();
		const { positions, groupBounds } = this._layoutEngine.computeForestLayout(this._data, groupNodeId);
		this._applyPositions(positions);
		if (groupBounds) {
			const groupNode = this._data.nodes.find(n => n.id === groupNodeId);
			if (groupNode) {
				groupNode.x = groupBounds.x;
				groupNode.y = groupBounds.y;
				groupNode.width = groupBounds.width;
				groupNode.height = groupBounds.height;
			}
		}
		this.onDataChanged?.(this._data);
	}

	// ── 着色 ───────────────────────────────────────────────────────────

	applyColors(): void {
		applyBranchColors(this._data);
		this.onDataChanged?.(this._data);
	}

	// ── 保存 ───────────────────────────────────────────────────────────

	getJsonData(): string {
		// 更新边侧再序列化
		updateAllEdgeSides(this._data);
		// 移除内部 content 字段（序列化时只用 text）
		const cleaned = JSON.parse(JSON.stringify(this._data));
		for (const node of cleaned.nodes) {
			if (node.content !== undefined && node.text === node.content) {
				delete node.content;
			}
			if (!node.text) {
				delete node.text;
			}
		}
		return JSON.stringify(cleaned, null, '\t');
	}

	// ── 选中整个树 ────────────────────────────────────────────────────

	selectTree(): string[] {
		if (!this._selectedNodeId) { return []; }
		const forest = buildForest(this._data);
		const treeNode = findTreeForNode(forest, this._selectedNodeId);
		if (!treeNode) { return []; }
		let root = treeNode;
		while (root.parent) { root = root.parent; }
		const desc = getDescendants(root);
		return [root.node.id, ...desc.map(d => d.node.id)];
	}

	// ── 辅助 ───────────────────────────────────────────────────────────

	private _applyPositions(positions: Map<string, INodePosition>): void {
		for (const [nodeId, pos] of positions) {
			const node = this._data.nodes.find(n => n.id === nodeId);
			if (node) {
				node.x = pos.x;
				node.y = pos.y;
			}
		}
		this.onLayoutApplied?.(positions);
	}
}
