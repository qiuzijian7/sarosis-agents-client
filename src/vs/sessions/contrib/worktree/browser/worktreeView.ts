/*--------------------------------------------------------------------------------------------- 
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/worktree.css';
import * as dom from '../../../../base/browser/dom.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { ICompressibleTreeRenderer } from '../../../../base/browser/ui/tree/objectTree.js';
import { ITreeNode } from '../../../../base/browser/ui/tree/tree.js';
import { ICompressedTreeNode, ICompressedTreeElement } from '../../../../base/browser/ui/tree/compressedObjectTreeModel.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchCompressibleObjectTree } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ViewPane, IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { WorktreeItem, WorktreeTreeDataProvider } from './worktreeDataProvider.js';
import { WorktreeCommands } from '../common/worktreeTypes.js';
import { IWorktreeService } from '../common/worktreeService.js';

const $ = dom.$;

// --- Tree Renderer ---

class WorktreeTreeRenderer implements ICompressibleTreeRenderer<WorktreeItem, void, IWorktreeTemplateData> {
	static readonly TEMPLATE_ID = 'worktreeItem';

	get templateId(): string { return WorktreeTreeRenderer.TEMPLATE_ID; }

	renderTemplate(container: HTMLElement): IWorktreeTemplateData {
		const element = dom.append(container, $('.worktree-item'));
		const icon = dom.append(element, $('.worktree-item-icon'));
		const label = dom.append(element, $('.worktree-item-label'));
		const desc = dom.append(element, $('.worktree-item-description'));
		return { element, icon, label, desc };
	}

	renderElement(node: ITreeNode<WorktreeItem, void>, _index: number, templateData: IWorktreeTemplateData): void {
		const item = node.element;
		templateData.label.textContent = item.label;
		templateData.desc.textContent = item.description ?? '';

		// Set icon
		const iconClasses = ThemeIcon.asClassNameArray(item.iconPath);
		templateData.icon.className = 'worktree-item-icon ' + iconClasses.join(' ');

		// Visual indicators
		templateData.element.classList.toggle('is-main', item.worktree.isMain);
		templateData.element.classList.toggle('is-detached', item.worktree.detached);
		templateData.element.classList.toggle('is-locked', item.worktree.locked);
		templateData.element.classList.toggle('is-prunable', item.worktree.prunable);
	}

	renderCompressedElements(_node: ITreeNode<ICompressedTreeNode<WorktreeItem>, void>, _index: number, _templateData: IWorktreeTemplateData): void {
		// No compression needed for worktree items
	}

	disposeTemplate(_templateData: IWorktreeTemplateData): void {
		// noop
	}
}

interface IWorktreeTemplateData {
	readonly element: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly desc: HTMLElement;
}

// --- Tree Delegate ---

class WorktreeTreeDelegate implements IListVirtualDelegate<WorktreeItem> {
	getHeight(_element: WorktreeItem): number {
		return 22;
	}

	getTemplateId(_element: WorktreeItem): string {
		return WorktreeTreeRenderer.TEMPLATE_ID;
	}
}

// --- View Pane ---

export class WorktreeViewPane extends ViewPane {

	private tree!: WorkbenchCompressibleObjectTree<WorktreeItem, void>;
	private dataProvider!: WorktreeTreeDataProvider;
	private readonly renderer = new WorktreeTreeRenderer();

	constructor(
		options: IViewPaneOptions,
		@IWorktreeService _worktreeService: IWorktreeService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.dataProvider = this._register(this.instantiationService.createInstance(WorktreeTreeDataProvider));

		const treeContainer = dom.append(container, $('.worktree-tree'));
		this.tree = <WorkbenchCompressibleObjectTree<WorktreeItem, void>>this.instantiationService.createInstance(
			WorkbenchCompressibleObjectTree,
			'WorktreeTree',
			treeContainer,
			new WorktreeTreeDelegate(),
			[this.renderer],
			{
				identityProvider: {
					getId: (element: WorktreeItem) => element.id
				},
				horizontalScrolling: true,
				multipleSelectionSupport: false,
				accessibilityProvider: {
					getAriaLabel: (element: WorktreeItem) => localize('worktreeAriaLabel', 'Worktree {0} at {1}', element.label, element.path),
					getWidgetAriaLabel: () => localize('worktreeTreeAriaLabel', 'Worktree List'),
				},
			}
		);

		this._register(this.tree.onDidOpen(e => {
			if (e.element) {
				this.openWorktree(e.element);
			}
		}));

		this._register(this.dataProvider.onDidChangeTreeData(() => {
			this.updateTree();
		}));

		// Set initial empty state
		this.tree.setChildren(null, []);

		// Initial refresh
		this.dataProvider.refresh();
	}

	private async updateTree(): Promise<void> {
		const children = await this.dataProvider.getChildren();
		const treeElements: ICompressedTreeElement<WorktreeItem>[] = children.map(c => ({
			element: c,
		}));
		this.tree.setChildren(null, treeElements);
	}

	override shouldShowWelcome(): boolean {
		return false;
	}

	private async openWorktree(item: WorktreeItem): Promise<void> {
		try {
			await this.commandService.executeCommand(WorktreeCommands.Open, item.path);
		} catch (e) {
			this.notificationService.error(localize('worktreeOpenError', 'Failed to open worktree: {0}', (e as Error).message));
		}
	}

	override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree.layout(height, width);
	}
}
