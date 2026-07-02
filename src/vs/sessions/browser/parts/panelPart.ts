/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../workbench/browser/parts/panel/media/panelpart.css';
import './media/panelPart.css';
import { IAction } from '../../../base/common/actions.js';
import { ActionsOrientation } from '../../../base/browser/ui/actionbar/actionbar.js';
import { ActivePanelContext, PanelFocusContext } from '../../../workbench/common/contextkeys.js';
import { IWorkbenchLayoutService, Parts, Position } from '../../../workbench/services/layout/browser/layoutService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { PANEL_TITLE_BORDER, PANEL_ACTIVE_TITLE_FOREGROUND, PANEL_INACTIVE_TITLE_FOREGROUND, PANEL_ACTIVE_TITLE_BORDER, PANEL_DRAG_AND_DROP_BORDER } from '../../../workbench/common/theme.js';
import { agentsBadgeBackground, agentsBadgeForeground, agentsPanelBackground, agentsPanelBorder, agentsPanelForeground } from '../../common/theme.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { IExtensionService } from '../../../workbench/services/extensions/common/extensions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../workbench/common/views.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { Menus } from '../menus.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../../../workbench/browser/parts/paneCompositePart.js';
import { Part } from '../../../workbench/browser/part.js';
import { IPaneCompositeBarOptions } from '../../../workbench/browser/parts/paneCompositeBar.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { Extensions } from '../../../workbench/browser/panecomposite.js';

/**
 * Panel part specifically for agent sessions workbench.
 * This is a simplified version of the PanelPart for agent session contexts.
 */
export class PanelPart extends AbstractPaneCompositePart {

	//#region IView

		readonly minimumWidth: number = 300;
		readonly maximumWidth: number = Number.POSITIVE_INFINITY;
		readonly minimumHeight: number = 77;
		readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	get preferredHeight(): number | undefined {
		return this.layoutService.mainContainerDimension.height * 0.4;
	}

	get preferredWidth(): number | undefined {
		const activeComposite = this.getActivePaneComposite();

		if (!activeComposite) {
			return undefined;
		}

		const width = activeComposite.getOptimalWidth();
		if (typeof width !== 'number') {
			return undefined;
		}

		return Math.max(width, 300);
	}

	//#endregion

	static readonly activePanelSettingsKey = 'workbench.agentsession.panelpart.activepanelid';

	/** Visual margin values for the card-like appearance */
	static readonly MARGIN_BOTTOM = 10;
	static readonly MARGIN_LEFT = 10;
	static readonly MARGIN_RIGHT = 10;

	override async create(parent: HTMLElement): Promise<void> {
		const result = await super.create(parent);
		// [Sarosis Debug] Log registered composites and composite bar state
		const composites = this.getPaneComposites();
		console.log('[PanelPart] Registered pane composites:', composites.map(c => ({ id: c.id, name: c.name, order: c.order })));
		const compositeBar = (this as any).paneCompositeBar?.value;
		if (compositeBar) {
			const items = compositeBar.getItems?.() ?? [];
			console.log('[PanelPart] CompositeBar visible items:', items.map((i: any) => i.id));
		} else {
			console.log('[PanelPart] CompositeBar not created');
		}
		return result;
	}

	constructor(
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IExtensionService extensionService: IExtensionService,
		@IMenuService menuService: IMenuService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super(
			Parts.PANEL_PART,
			{ hasTitle: true, trailingSeparator: true },
			PanelPart.activePanelSettingsKey,
			ActivePanelContext.bindTo(contextKeyService),
			PanelFocusContext.bindTo(contextKeyService),
			'panel',
			'panel',
			undefined,
			PANEL_TITLE_BORDER,
			ViewContainerLocation.Panel,
			Extensions.Panels,
			Menus.PanelTitle,
			notificationService,
			storageService,
			contextMenuService,
			layoutService,
			keybindingService,
			hoverService,
			instantiationService,
			themeService,
			viewDescriptorService,
			contextKeyService,
			extensionService,
			menuService,
		);

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('workbench.panel.showLabels')) {
				this.updateCompositeBar(true);
			}
		}));
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());

		// Store background and border as CSS variables for the card styling on .part
		container.style.setProperty('--part-background', this.getColor(agentsPanelBackground) || '');
		container.style.setProperty('--part-border-color', this.getColor(agentsPanelBorder) || 'transparent');
		container.style.setProperty('--part-foreground', this.getColor(agentsPanelForeground) || '');
		container.style.backgroundColor = this.getColor(agentsPanelBackground) || '';

		// Clear inline borders - the card appearance uses CSS border-radius instead
		container.style.borderTopColor = '';
		container.style.borderTopStyle = '';
		container.style.borderTopWidth = '';
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		return {
			partContainerClass: 'panel',
			pinnedViewContainersKey: 'workbench.agentsession.panel.pinnedPanels',
			placeholderViewContainersKey: 'workbench.agentsession.panel.placeholderPanels',
			viewContainersWorkspaceStateKey: 'workbench.agentsession.panel.viewContainersWorkspaceState',
			icon: this.configurationService.getValue('workbench.panel.showLabels') === false,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			activityHoverOptions: {
				position: () => this.layoutService.getPanelPosition() === Position.BOTTOM && !this.layoutService.isPanelMaximized() ? HoverPosition.ABOVE : HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: actions => this.fillExtraContextMenuActions(actions),
			compositeSize: 0,
			iconSize: 16,
			compact: true,
			overflowActionSize: 44,
			colors: theme => ({
				activeBackgroundColor: theme.getColor(agentsPanelBackground),
				inactiveBackgroundColor: theme.getColor(agentsPanelBackground),
				activeBorderBottomColor: theme.getColor(PANEL_ACTIVE_TITLE_BORDER),
				activeForegroundColor: theme.getColor(PANEL_ACTIVE_TITLE_FOREGROUND),
				inactiveForegroundColor: theme.getColor(PANEL_INACTIVE_TITLE_FOREGROUND),
				badgeBackground: theme.getColor(agentsBadgeBackground),
				badgeForeground: theme.getColor(agentsBadgeForeground),
				dragAndDropBorder: theme.getColor(PANEL_DRAG_AND_DROP_BORDER)
			})
		};
	}

	private fillExtraContextMenuActions(_actions: IAction[]): void { }

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.PANEL_PART)) {
			return;
		}

		// [Sarosis Debug] Trace when layout receives height <= 0
		if (height <= 0) {
			console.trace(`[PanelPart] layout height<=0: height=${height}, width=${width}, top=${top}, left=${left}`);
		}

		// Layout content with reduced dimensions to account for visual margins and border
		const borderTotal = 2; // 1px border on each side
		const marginLeft = this.layoutService.isVisible(Parts.SIDEBAR_PART) ? 0 : PanelPart.MARGIN_LEFT;
		// 右侧不再留 MARGIN_RIGHT，让内容铺满到右边框
		super.layout(
			width - marginLeft - borderTotal,
			height - PanelPart.MARGIN_BOTTOM - borderTotal,
			top, left
		);

		// Restore the full grid-allocated dimensions so that Part.relayout() works correctly.
		Part.prototype.layout.call(this, width, height, top, left);

		// [Sarosis Debug] Inspect width chain after layout settles
		setTimeout(() => this._inspectWidthChain(width), 200);
	}

	private _inspectWidthChain(gridWidth: number): void {
		const container = this.getContainer();
		if (!container) { return; }

		const content = container.querySelector('.content') as HTMLElement | null;
		const pane = container.querySelector('.pane') as HTMLElement | null;
		const paneBody = container.querySelector('.pane-body') as HTMLElement | null;
		const monaco = container.querySelector('.monaco-editor') as HTMLElement | null;
		const replEl = container.querySelector('.repl') as HTMLElement | null;
		const scrollable = container.querySelector('.monaco-scrollable-element') as HTMLElement | null;

		const log: any = { gridWidth };

		if (container) {
			const r = container.getBoundingClientRect();
			log.panel = { rectW: r.width, inlineStyleW: container.style.width, classList: [...container.classList], computedW: getComputedStyle(container).width };
		}
		if (content) {
			const r = content.getBoundingClientRect();
			log.content = { rectW: r.width, rectX: r.x, rectRight: r.right, inlineStyleW: content.style.width, computedW: getComputedStyle(content).width, boxSizing: getComputedStyle(content).boxSizing, padding: getComputedStyle(content).paddingRight };
		}
		if (pane) {
			const r = pane.getBoundingClientRect();
			log.pane = { rectW: r.width, rectX: r.x, rectRight: r.right, inlineStyleW: pane.style.width, computedW: getComputedStyle(pane).width };
		}
		if (paneBody) {
			const r = paneBody.getBoundingClientRect();
			log.paneBody = { rectW: r.width, rectX: r.x, rectRight: r.right, inlineStyleW: paneBody.style.width, computedW: getComputedStyle(paneBody).width, paddingR: getComputedStyle(paneBody).paddingRight, classes: [...paneBody.classList] };
		}
		if (monaco) {
			const r = monaco.getBoundingClientRect();
			log.monacoEditor = { rectW: r.width, rectX: r.x, rectRight: r.right, inlineStyleW: monaco.style.width, computedW: getComputedStyle(monaco).width, inlineStyleR: monaco.style.right };
		}
		if (scrollable) {
			const r = scrollable.getBoundingClientRect();
			log.monacoScrollable = { rectW: r.width, rectX: r.x, rectRight: r.right, inlineStyleW: scrollable.style.width, computedW: getComputedStyle(scrollable).width };
		}
		if (replEl) {
			const r = replEl.getBoundingClientRect();
			log.repl = { rectW: r.width, rectX: r.x, rectRight: r.right, inlineStyleW: replEl.style.width, computedW: getComputedStyle(replEl).width };
		}

		console.log('[PanelPart] Width chain inspect:', JSON.stringify(log, null, 2));
	}

	protected override shouldShowCompositeBar(): boolean {
		return true;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	toJSON(): object {
		return {
			type: Parts.PANEL_PART
		};
	}
}
