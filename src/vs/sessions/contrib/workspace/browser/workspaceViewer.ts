/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { IAsyncDataSource, ITreeNode, ITreeFilter, TreeVisibility, ITreeSorter } from '../../../../base/browser/ui/tree/tree.js';
import { ICompressibleTreeRenderer } from '../../../../base/browser/ui/tree/objectTree.js';
import { ICompressedTreeNode } from '../../../../base/browser/ui/tree/compressedObjectTreeModel.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IProgressService } from '../../../../platform/progress/common/progress.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';

//#region Workspace Tree Element Interface

export interface IWorkspaceTreeElement {
	resource: URI;
	name: string;
	isDirectory: boolean;
	children?: IWorkspaceTreeElement[];
}

//#endregion

//#region Tree Delegate

export class WorkspaceDelegate implements IListVirtualDelegate<IWorkspaceTreeElement> {
	static readonly ITEM_HEIGHT = 22;

	getHeight(element: IWorkspaceTreeElement): number {
		return WorkspaceDelegate.ITEM_HEIGHT;
	}

	getTemplateId(element: IWorkspaceTreeElement): string {
		return 'workspace-element';
	}
}

//#endregion

//#region Tree Data Source

export class WorkspaceDataSource implements IAsyncDataSource<IWorkspaceTreeElement, IWorkspaceTreeElement> {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IProgressService _progressService: IProgressService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) { }

	hasChildren(element: IWorkspaceTreeElement): boolean {
		const result = element.isDirectory;
		this.logService.info(`[WorkspaceDataSource] hasChildren(${element.name}): ${result}`);
		return result;
	}

	async getChildren(element: IWorkspaceTreeElement): Promise<IWorkspaceTreeElement[]> {
		this.logService.info(`[WorkspaceDataSource] getChildren(${element.name}), has children prop: ${!!element.children}`);

		// 如果元素有预定义的 children（如虚拟根节点），直接返回
		if (element.children) {
			this.logService.info(`[WorkspaceDataSource] Returning ${element.children.length} predefined children`);
			return element.children;
		}

		if (!element.isDirectory) {
			return [];
		}

		try {
			this.logService.info(`[WorkspaceDataSource] Resolving: ${element.resource.toString()}`);
			const stat = await this.fileService.resolve(element.resource, { resolveSingleChildDescendants: true });
			if (stat.children) {
				this.logService.info(`[WorkspaceDataSource] Resolved ${stat.children.length} children`);
				return stat.children.map(child => ({
					resource: child.resource,
					name: basename(child.resource),
					isDirectory: child.isDirectory,
				}));
			}
			this.logService.info('[WorkspaceDataSource] No children found');
			return [];
		} catch (error) {
			this.logService.error(`[WorkspaceDataSource] Error resolving ${element.resource.toString()}:`, error);
			this.notificationService.error(error);
			return [];
		}
	}
}

//#endregion

//#region Tree Renderer

interface IWorkspaceTemplateData {
	container: HTMLElement;
	icon: HTMLElement;
	name: HTMLElement;
}

export class WorkspaceRenderer implements ICompressibleTreeRenderer<IWorkspaceTreeElement, any, IWorkspaceTemplateData> {
	static readonly TEMPLATE_ID = 'workspace-element';

	readonly templateId: string = WorkspaceRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IWorkspaceTemplateData {
		const element = DOM.append(container, DOM.$('.workspace-file-entry'));
		const icon = DOM.append(element, DOM.$('.workspace-file-icon'));
		const name = DOM.append(element, DOM.$('.workspace-file-name'));

		return { container: element, icon, name };
	}

	renderElement(node: { element: IWorkspaceTreeElement }, index: number, templateData: IWorkspaceTemplateData): void {
		const element = node.element;

		// Set icon based on file type
		templateData.icon.className = 'workspace-file-icon';
		if (element.isDirectory) {
			templateData.icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.folder));
		} else {
			templateData.icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.file));
		}

		// Set name
		templateData.name.textContent = element.name;
		templateData.name.title = element.resource.fsPath;
	}

	renderCompressedElements(node: ITreeNode<ICompressedTreeNode<IWorkspaceTreeElement>, any>, index: number, templateData: IWorkspaceTemplateData): void {
		const elements = node.element.elements;
		const lastElement = elements[elements.length - 1];

		// Set icon based on last element's type
		templateData.icon.className = 'workspace-file-icon';
		if (lastElement.isDirectory) {
			templateData.icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.folder));
		} else {
			templateData.icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.file));
		}

		// Show compressed path (joined names)
		templateData.name.textContent = elements.map(e => e.name).join('/');
		templateData.name.title = lastElement.resource.fsPath;
	}

	disposeTemplate(templateData: IWorkspaceTemplateData): void {
		// Clean up if needed
	}
}

//#endregion

//#region Tree Filter

export class WorkspaceFilter implements ITreeFilter<IWorkspaceTreeElement> {
	filter(element: IWorkspaceTreeElement): TreeVisibility {
		return TreeVisibility.Visible;
	}
}

//#endregion

//#region Tree Sorter

export class WorkspaceSorter implements ITreeSorter<IWorkspaceTreeElement> {
	compare(a: IWorkspaceTreeElement, b: IWorkspaceTreeElement): number {
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

export class WorkspaceAccessibilityProvider implements IListAccessibilityProvider<IWorkspaceTreeElement> {
	getAriaLabel(element: IWorkspaceTreeElement): string {
		return element.name;
	}

	getWidgetAriaLabel(): string {
		return localize('workspaceTree', "Workspace");
	}
}

//#endregion
