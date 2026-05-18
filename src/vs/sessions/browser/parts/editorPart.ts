/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../base/browser/window.js';
import { MainEditorPart as MainEditorPartBase } from '../../../workbench/browser/parts/editor/editorPart.js';
import { Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { IEditorGroupView } from '../../../workbench/browser/parts/editor/editor.js';
import { GroupIdentifier } from '../../../workbench/common/editor.js';
import { GroupDirection } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { ISerializedGrid, Orientation, SerializableGrid, ISerializedBranchNode, ISerializedLeafNode } from '../../../base/browser/ui/grid/grid.js';

export class MainEditorPart extends MainEditorPartBase {
	static readonly MARGIN_TOP = 0;
	static readonly MARGIN_LEFT = 10;
	static readonly MARGIN_BOTTOM = 0;

	// ── Zone root group IDs ─────────────────────────────────────────
	// Set during doCreateGridControl() and consumed by the workbench
	// bootstrap to track zone membership without calling addGroup().
	private _fileZoneRootGroupId: number = -1;
	private _agentZoneRootGroupId: number = -1;

	get fileZoneRootGroupId(): number { return this._fileZoneRootGroupId; }
	get agentZoneRootGroupId(): number { return this._agentZoneRootGroupId; }

	/**
	 * Height reserved for the workspace toolbar that overlays the titlebar.
	 * Used by workbench.ts to position the toolbar, NOT subtracted from the
	 * editor part content — the toolbar is absolutely positioned outside the
	 * editor part element.
	 */
	static readonly TOOLBAR_HEIGHT = 32;

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow)) {
			return;
		}

		const adjustedMargin = this.layoutService.isVisible(Parts.SIDEBAR_PART) ||
			this.layoutService.isVisible(Parts.CHATBAR_PART)
			? 0
			: MainEditorPart.MARGIN_LEFT;
		const adjustedWidth = width - adjustedMargin - 2 /* border width */;
		const adjustedHeight = height - MainEditorPart.MARGIN_TOP - MainEditorPart.MARGIN_BOTTOM - 2 /* border width */;

		super.layout(adjustedWidth, adjustedHeight, top, left);
	}

	/**
	 * [Sarosis] Override removeGroup to protect the two zone root groups
	 * from being removed (which would destroy the dual-zone layout).
	 * Sub-groups created by the user via split / drag-and-drop ARE
	 * removable — when the last editor is moved out of a sub-group,
	 * VS Code automatically calls removeGroup to clean it up.
	 */
	override removeGroup(group: IEditorGroupView | GroupIdentifier, preserveFocus?: boolean): void {
		const groupId = typeof group === 'number' ? group : group.id;

		// Protect the two zone root groups
		if (groupId === this._fileZoneRootGroupId || groupId === this._agentZoneRootGroupId) {
			return; // no-op: zone roots cannot be removed
		}

		// Allow removal of any other group (user-created sub-groups)
		super.removeGroup(group, preserveFocus);
	}

	/**
	 * [Sarosis] Two-zone editor area (file zone | agent-studio zone).
	 *
	 * Override the base EditorPart's grid creation to build a grid with
	 * TWO branch children under the root BranchNode (HORIZONTAL). Each
	 * branch has its own split-view-container in the DOM, giving each
	 * zone a truly independent sub-tree for drag/dock/resize within.
	 *
	 * DOM structure produced:
	 *   .grid-view-container
	 *     └── .monaco-grid-view
	 *         └── .monaco-grid-branch-node (root, HORIZONTAL)
	 *             └── .monaco-split-view2.horizontal
	 *                 └── .split-view-container
	 *                     ├── .split-view-view (file zone branch)
	 *                     │   └── .monaco-grid-branch-node (VERTICAL)
	 *                     │       └── .monaco-split-view2.vertical
	 *                     │           └── .split-view-container
	 *                     │               └── .split-view-view (fileRootGroup)
	 *                     └── .split-view-view (agent zone branch)
	 *                         └── .monaco-grid-branch-node (VERTICAL)
	 *                             └── .monaco-split-view2.vertical
	 *                                 └── .split-view-container
	 *                                     └── .split-view-view (agentRootGroup)
	 *
	 * Inside each zone, users can freely split / dock / merge / resize
	 * sub-groups. Splits stay inside their zone because each zone is a
	 * BranchNode subtree; combined with shouldForceSameOrientation(),
	 * horizontal splits at the zone-root level nest instead of escaping.
	 */
	protected override doCreateGridControl(): void {
		// Skip state restoration — sessions workbench always starts fresh
		// (createEditorPart passes { restorePreviousState: false }).
		// If for some reason willRestoreState is true, fall back to the
		// base implementation.
		if (this._willRestoreState) {
			console.warn('[SessionsEditorPart] willRestoreState=true, falling back to base grid creation');
			super.doCreateGridControl();
			return;
		}

		console.log('[SessionsEditorPart] Creating dual-branch grid (file zone + agent zone)');

		// Create two group views: one per zone
		const fileGroupView = this.doCreateGroupView();
		const agentGroupView = this.doCreateGroupView();

		this._fileZoneRootGroupId = fileGroupView.id;
		this._agentZoneRootGroupId = agentGroupView.id;

		// Build a serialized grid descriptor with two branch children.
		// Each branch wraps a single leaf (the zone root group).
		// The root orientation is HORIZONTAL → children sit side by side.
		// Each branch child is VERTICAL (orthogonal), giving each zone
		// its own split-view-container where UP/DOWN splits nest naturally.
		//
		// Initial widths: 30% file zone, 70% agent zone (using a nominal
		// 1000px — the grid will proportionally rescale on the first real layout call).
		const nominalWidth = 1000;
		const nominalHeight = 800;
		const fileZoneWidth = Math.round(nominalWidth * 0.3);
		const agentZoneWidth = nominalWidth - fileZoneWidth;

		const fileLeaf: ISerializedLeafNode = {
			type: 'leaf',
			data: fileGroupView.toJSON(),
			size: nominalHeight
		};

		const agentLeaf: ISerializedLeafNode = {
			type: 'leaf',
			data: agentGroupView.toJSON(),
			size: nominalHeight
		};

		const fileZoneBranch: ISerializedBranchNode = {
			type: 'branch',
			data: [fileLeaf],
			size: fileZoneWidth
		};

		const agentZoneBranch: ISerializedBranchNode = {
			type: 'branch',
			data: [agentLeaf],
			size: agentZoneWidth
		};

		const rootBranch: ISerializedBranchNode = {
			type: 'branch',
			data: [fileZoneBranch, agentZoneBranch],
			size: nominalHeight
		};

		const serializedGrid: ISerializedGrid = {
			root: rootBranch,
			orientation: Orientation.HORIZONTAL,
			width: nominalWidth,
			height: nominalHeight
		};

		// Deserialize the grid — this creates the nested BranchNode DOM
		// with two independent split-view-container elements.
		const gridWidget = SerializableGrid.deserialize<IEditorGroupView>(
			serializedGrid,
			{
				fromJSON: (json: any) => {
					// The deserializer receives the data we passed to leaf
					// nodes. Match by group id to return the correct view.
					if (json && json.id === fileGroupView.id) {
						return fileGroupView;
					}
					if (json && json.id === agentGroupView.id) {
						return agentGroupView;
					}
					// Fallback: create a new group view from serialized data
					return this.doCreateGroupView(json);
				}
			},
			{ styles: { separatorBorder: this.gridSeparatorBorder } }
		);

		// Activate the file zone root by default
		this.doSetGroupActive(fileGroupView);

		// Install the grid
		this.doSetGridWidget(gridWidget);

		// Standard post-creation steps
		this.updateContainer();
		this.notifyGroupIndexChange();

		// Verify the dual-branch structure was created
		const branchNodes = this.gridWidgetView.element.querySelectorAll('.monaco-grid-branch-node');
		console.log('[SessionsEditorPart] Grid created — branch nodes:', branchNodes.length,
			'file zone group:', this._fileZoneRootGroupId,
			'agent zone group:', this._agentZoneRootGroupId,
			'total groups:', this.groups.length);

		// Install collapse button after DOM is ready
		queueMicrotask(() => this.installFileZoneCollapseButton());
	}

	/**
	 * [Sarosis] Two-zone split containment — NO-OP with dual-branch grid.
	 *
	 * With the dual-branch grid layout (each zone is an independent
	 * BranchNode), horizontal splits inside a zone naturally create a
	 * HORIZONTAL child branch *within* the zone's VERTICAL BranchNode.
	 * They can never escape to the root level because the root is now
	 * a HORIZONTAL branch whose direct children are the two zone
	 * BranchNodes — not individual LeafNodes.
	 *
	 * Previously (with the flat addGroup approach), this hook was needed
	 * to prevent horizontal splits from creating siblings at the root
	 * level. That is no longer necessary and was actively preventing
	 * LEFT/RIGHT docking within a zone (forcing all splits to be
	 * vertical, so RIGHT dock ended up at the bottom instead).
	 *
	 * Return false for all directions → upstream grid behaviour applies
	 * → users can dock in any direction inside a zone.
	 */
	protected override shouldForceSameOrientation(_locationView: IEditorGroupView, _direction: GroupDirection): boolean {
		return false;
	}

	// ── File Zone Collapse/Expand Button ─────────────────────────

	private fileZoneCollapseBtn: HTMLElement | undefined;

	private installFileZoneCollapseButton(): void {
		const fileRootGroup = this.getGroup(this._fileZoneRootGroupId);
		if (!fileRootGroup?.element) {
			setTimeout(() => this.installFileZoneCollapseButton(), 50);
			return;
		}

		// Find the editor-actions toolbar container in the file zone title bar
		const actionsContainer = fileRootGroup.element.querySelector<HTMLElement>('.title .editor-actions');
		if (!actionsContainer) {
			setTimeout(() => this.installFileZoneCollapseButton(), 50);
			return;
		}

		// Remove existing button
		this.fileZoneCollapseBtn?.remove();

		// Create the collapse/expand button
		const btn = document.createElement('div');
		btn.className = 'file-zone-collapse-btn';

		const icon = document.createElement('a');
		icon.className = 'action-label codicon codicon-chevron-left';
		icon.title = 'Collapse File Zone';
		icon.tabIndex = 0;
		icon.role = 'button';
		btn.appendChild(icon);

		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.toggleFileZoneCollapse();
		});

		// Insert the button into the editor-actions container
		actionsContainer.appendChild(btn);
		this.fileZoneCollapseBtn = btn;

		this.updateCollapseButtonIcon();

		// Listen for maximize state changes to update the icon
		this._register(this.onDidChangeGroupMaximized(() => this.updateCollapseButtonIcon()));
	}

	private toggleFileZoneCollapse(): void {
		const agentGroup = this.getGroup(this._agentZoneRootGroupId);
		if (!agentGroup) return;

		this.toggleMaximizeGroup(agentGroup);
	}

	private updateCollapseButtonIcon(): void {
		const btn = this.fileZoneCollapseBtn;
		if (!btn) return;

		const icon = btn.querySelector<HTMLElement>('.codicon');
		if (!icon) return;

		const isCollapsed = this.hasMaximizedGroup();

		icon.classList.remove('codicon-chevron-left', 'codicon-chevron-right');
		icon.classList.add(isCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-left');
		icon.title = isCollapsed ? 'Expand File Zone' : 'Collapse File Zone';
	}
}
