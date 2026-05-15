/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { IAsyncDataSource, ITreeNode, ITreeFilter, TreeVisibility, ITreeSorter } from '../../../../../base/browser/ui/tree/tree.js';
import { ICompressibleTreeRenderer } from '../../../../../base/browser/ui/tree/objectTree.js';
import { ICompressedTreeNode } from '../../../../../base/browser/ui/tree/compressedObjectTreeModel.js';
import { IFileService, IFileStat, FileKind } from '../../../../../platform/files/common/files.js';
import { basename } from '../../../../../base/common/resources.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IResourceLabel, ResourceLabels } from '../../../../../workbench/browser/labels.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { WORKSPACE_DATA_DIR } from '../../common/constants.js';

//#region Workspace Explorer Tree Element Interface

/**
 * Represents a node in the workspace explorer tree.
 *
 * - Root nodes are workspace folders (isWorkspaceRoot = true)
 * - Child nodes are files/directories within a workspace
 * - Workspaces without a local path are shown as virtual roots with info children
 */
export interface IWorkspaceExplorerElement {
	/** URI of the file/directory */
	resource: URI;
	/** Display name */
	name: string;
	/** Whether this is a directory */
	isDirectory: boolean;
	/** Whether this is a workspace root folder */
	isWorkspaceRoot?: boolean;
	/** Workspace ID (set on root nodes for identification) */
	workspaceId?: string;
	/** Pre-computed children for virtual root nodes */
	children?: IWorkspaceExplorerElement[];
	/**
	 * True when the workspace root has no associated local path.
	 * The node is rendered as a folder but its children come from
	 * metadata (description, created date) rather than the filesystem.
	 */
	isVirtualWorkspace?: boolean;
	/** Optional description text (shown for virtual workspace info nodes) */
	description?: string;
	/** If true, this is a read-only info/label node — not openable */
	isInfoNode?: boolean;
}

//#endregion

//#region Tree Delegate

export class WorkspaceExplorerDelegate implements IListVirtualDelegate<IWorkspaceExplorerElement> {
	static readonly ITEM_HEIGHT = 22;

	getHeight(_element: IWorkspaceExplorerElement): number {
		return WorkspaceExplorerDelegate.ITEM_HEIGHT;
	}

	getTemplateId(_element: IWorkspaceExplorerElement): string {
		return WorkspaceExplorerRenderer.TEMPLATE_ID;
	}
}

//#endregion

//#region Tree Data Source

export class WorkspaceExplorerDataSource implements IAsyncDataSource<IWorkspaceExplorerElement, IWorkspaceExplorerElement> {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) { }

	hasChildren(element: IWorkspaceExplorerElement): boolean {
		// Info nodes are leaf nodes — never expandable
		if (element.isInfoNode) {
			return false;
		}
		// Virtual workspace roots with predefined children are expandable
		if (element.children && element.children.length > 0) {
			return true;
		}
		return element.isDirectory && !element.isVirtualWorkspace;
	}

	/**
	 * Hidden directory/file names that should be excluded from the tree.
	 * This includes the internal workspace data directory and common VCS directories.
	 */
	private static readonly HIDDEN_NAMES = new Set<string>([
		WORKSPACE_DATA_DIR,   // '.sarosisworkspace'
		'.git',
		'.svn',
		'.hg',
		'.DS_Store',
		'Thumbs.db',
		'node_modules',
	]);

	async getChildren(element: IWorkspaceExplorerElement): Promise<IWorkspaceExplorerElement[]> {
		// If element has predefined children (e.g. virtual root or virtual workspace), return them
		if (element.children) {
			this.logService.info(`[WorkspaceExplorer] getChildren(${element.name}): returning ${element.children.length} predefined children`);
			return element.children;
		}

		// Info nodes and virtual workspaces with no children array — nothing to expand
		if (element.isInfoNode) {
			return [];
		}

		// Virtual workspace roots without a real path have no filesystem children
		if (element.isVirtualWorkspace) {
			return [];
		}

		if (!element.isDirectory) {
			return [];
		}

		try {
			this.logService.info(`[WorkspaceExplorer] Resolving: ${element.resource.toString()}`);
			const stat: IFileStat = await this.fileService.resolve(element.resource, { resolveSingleChildDescendants: false });
			if (stat.children) {
				const children = stat.children
					.filter((child: IFileStat) => {
						const name = basename(child.resource);
						// Filter out hidden/internal entries
						if (WorkspaceExplorerDataSource.HIDDEN_NAMES.has(name)) {
							return false;
						}
						return true;
					})
					.map((child: IFileStat) => ({
						resource: child.resource,
						name: basename(child.resource),
						isDirectory: child.isDirectory,
					}));
				this.logService.info(`[WorkspaceExplorer] Resolved ${stat.children.length} raw children, ${children.length} after filtering for: ${element.name}`);
				return children;
			}
			this.logService.info(`[WorkspaceExplorer] No children found for: ${element.name}`);
			return [];
		} catch (error) {
			this.logService.error(`[WorkspaceExplorer] Error resolving ${element.resource.toString()}:`, error);
			return [];
		}
	}
}

//#endregion

//#region Tree Renderer

interface IWorkspaceExplorerTemplateData {
	readonly templateDisposables: DisposableStore;
	readonly elementDisposables: DisposableStore;
	readonly label: IResourceLabel;
	readonly container: HTMLElement;
}

/**
 * Tree renderer that uses ResourceLabels for proper file icon theme support.
 * This ensures file icons match the user's selected icon theme (e.g., Seti, Material Icons).
 */
export class WorkspaceExplorerRenderer implements ICompressibleTreeRenderer<IWorkspaceExplorerElement, FuzzyScore, IWorkspaceExplorerTemplateData> {
	static readonly TEMPLATE_ID = 'workspace-explorer-element';

	readonly templateId: string = WorkspaceExplorerRenderer.TEMPLATE_ID;

	constructor(
		private readonly labels: ResourceLabels,
	) { }

	renderTemplate(container: HTMLElement): IWorkspaceExplorerTemplateData {
		const templateDisposables = new DisposableStore();
		const elementDisposables = new DisposableStore();

		// Create a resource label in the container — this handles icon + name rendering
		const label = templateDisposables.add(this.labels.create(container, { supportHighlights: true }));

		return { templateDisposables, elementDisposables, label, container };
	}

	renderElement(node: ITreeNode<IWorkspaceExplorerElement, FuzzyScore>, _index: number, templateData: IWorkspaceExplorerTemplateData): void {
		templateData.elementDisposables.clear();
		const element = node.element;
		this._renderNode(element, templateData);
	}

	renderCompressedElements(node: ITreeNode<ICompressedTreeNode<IWorkspaceExplorerElement>, FuzzyScore>, _index: number, templateData: IWorkspaceExplorerTemplateData): void {
		templateData.elementDisposables.clear();
		const elements = node.element.elements;
		const lastElement = elements[elements.length - 1];

		// For compressed paths, show joined names but use the last element's resource for icon
		const compressedName = elements.map((e: IWorkspaceExplorerElement) => e.name).join('/');

		templateData.label.setResource(
			{
				resource: lastElement.resource,
				name: compressedName,
			},
			{
				fileKind: lastElement.isWorkspaceRoot
					? FileKind.ROOT_FOLDER
					: lastElement.isDirectory
						? FileKind.FOLDER
						: FileKind.FILE,
				extraClasses: lastElement.isWorkspaceRoot ? ['workspace-root-entry'] : undefined,
			}
		);
	}

	private _renderNode(element: IWorkspaceExplorerElement, templateData: IWorkspaceExplorerTemplateData): void {
		// Info nodes (read-only label items inside virtual workspaces)
		if (element.isInfoNode) {
			templateData.label.setResource(
				{
					resource: element.resource,
					name: element.name,
				},
				{
					fileKind: FileKind.FILE,
					extraClasses: ['workspace-info-node'],
					hideIcon: true,
				}
			);
			return;
		}

		const fileKind = element.isWorkspaceRoot
			? FileKind.ROOT_FOLDER
			: element.isDirectory
				? FileKind.FOLDER
				: FileKind.FILE;

		const extraClasses: string[] = [];
		if (element.isWorkspaceRoot) {
			extraClasses.push('workspace-root-entry');
		}
		if (element.isVirtualWorkspace) {
			extraClasses.push('workspace-virtual-entry');
		}

		templateData.label.setResource(
			{
				resource: element.resource,
				name: element.name,
				description: element.isVirtualWorkspace ? element.description : undefined,
			},
			{
				fileKind,
				extraClasses: extraClasses.length > 0 ? extraClasses : undefined,
			}
		);
	}

	disposeTemplate(templateData: IWorkspaceExplorerTemplateData): void {
		templateData.elementDisposables.dispose();
		templateData.templateDisposables.dispose();
	}
}

//#endregion

//#region Tree Filter

export class WorkspaceExplorerFilter implements ITreeFilter<IWorkspaceExplorerElement, FuzzyScore> {

	/**
	 * Additional hidden patterns beyond the DataSource filter.
	 * Names starting with '.' are generally hidden (like .git, .sarosisworkspace, etc.)
	 */
	filter(element: IWorkspaceExplorerElement): TreeVisibility {
		// Workspace roots (real & virtual) are always visible
		if (element.isWorkspaceRoot) {
			return TreeVisibility.Visible;
		}

		// Info nodes are always visible
		if (element.isInfoNode) {
			return TreeVisibility.Visible;
		}

		const name = element.name;

		// Hide the internal workspace data directory and other dot-dirs/dot-files
		if (name === WORKSPACE_DATA_DIR) {
			return TreeVisibility.Hidden;
		}

		return TreeVisibility.Visible;
	}
}

//#endregion

//#region Tree Sorter

export class WorkspaceExplorerSorter implements ITreeSorter<IWorkspaceExplorerElement> {
	compare(a: IWorkspaceExplorerElement, b: IWorkspaceExplorerElement): number {
		// Workspace roots maintain their order
		if (a.isWorkspaceRoot && b.isWorkspaceRoot) {
			return a.name.localeCompare(b.name);
		}

		// Directories first
		if (a.isDirectory && !b.isDirectory) {
			return -1;
		}
		if (!a.isDirectory && b.isDirectory) {
			return 1;
		}

		// Then sort by name
		return a.name.localeCompare(b.name);
	}
}

//#endregion

//#region Tree Accessibility Provider

export class WorkspaceExplorerAccessibilityProvider implements IListAccessibilityProvider<IWorkspaceExplorerElement> {
	getAriaLabel(element: IWorkspaceExplorerElement): string {
		if (element.isWorkspaceRoot) {
			return localize('workspaceRoot', "{0} (workspace)", element.name);
		}
		return element.name;
	}

	getWidgetAriaLabel(): string {
		return localize('workspaceExplorerTree', "Workspace Explorer");
	}
}

//#endregion
