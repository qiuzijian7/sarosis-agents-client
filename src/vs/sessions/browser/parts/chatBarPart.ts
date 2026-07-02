/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatBarPart.css';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { PANEL_ACTIVE_TITLE_BORDER, PANEL_ACTIVE_TITLE_FOREGROUND, PANEL_DRAG_AND_DROP_BORDER, PANEL_INACTIVE_TITLE_FOREGROUND, SIDE_BAR_TITLE_BORDER } from '../../../workbench/common/theme.js';
import { agentsPanelBackground, agentsPanelBorder, agentsPanelForeground, agentsBadgeBackground, agentsBadgeForeground } from '../../common/theme.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../workbench/common/views.js';
import { IExtensionService } from '../../../workbench/services/extensions/common/extensions.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import { LayoutPriority } from '../../../base/browser/ui/splitview/splitview.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../../../workbench/browser/parts/paneCompositePart.js';
import { Part } from '../../../workbench/browser/part.js';
import { ActionsOrientation } from '../../../base/browser/ui/actionbar/actionbar.js';
import { IPaneCompositeBarOptions } from '../../../workbench/browser/parts/paneCompositeBar.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { Extensions } from '../../../workbench/browser/panecomposite.js';
import { Menus } from '../menus.js';
import { ActiveChatBarContext, ChatBarFocusContext } from '../../common/contextkeys.js';
import { assertReturnsDefined } from '../../../base/common/types.js';

/**
 * Minimal ChatBarPart stub.
 *
 * The multi-chat business logic (ChatPanelManager, ChatCompositeBar, agent
 * loading, streaming, etc.) has been removed — the canonical multi-chat
 * implementation now lives in {@link NativeChatEditorPane} (one editor tab
 * per chat, managed by VS Code's native editor tab bar).
 *
 * This class is retained as a layout-system placeholder: it is registered
 * in {@link PaneCompositePartService} under `ViewContainerLocation.ChatBar`
 * and hidden by default (`chatBar: false` in all layout modes). It exists
 * solely so the VS Code part infrastructure has a part to instantiate at
 * that location slot.
 *
 * If a future layout change re-enables the ChatBar part, the multi-chat
 * functionality should be re-implemented via NativeChatEditorInput tabs,
 * not by restoring the old ChatPanelManager architecture.
 */
export class ChatBarPart extends AbstractPaneCompositePart {

	static readonly activeViewSettingsKey = 'workbench.chatbar.activepanelid';
	static readonly pinnedViewsKey = 'workbench.chatbar.pinnedPanels';
	static readonly placeholderViewContainersKey = 'workbench.chatbar.placeholderPanels';
	static readonly viewContainersWorkspaceStateKey = 'workbench.chatbar.viewContainersWorkspaceState';

	override readonly minimumWidth: number = 300;
	override get maximumWidth(): number {
		return Math.max(300, this.layoutService.mainContainerDimension.width * 0.5);
	}
	override readonly minimumHeight: number = 0;
	override readonly maximumHeight: number = Number.POSITIVE_INFINITY;
	override get snap(): boolean { return false; }

	protected _lastLayout: { readonly width: number; readonly height: number; readonly top: number; readonly left: number } | undefined;

	get preferredHeight(): number | undefined {
		return this.layoutService.mainContainerDimension.height * 0.4;
	}

	readonly priority = LayoutPriority.High;

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
	) {
		super(
			Parts.CHATBAR_PART,
			{
				hasTitle: false,
				trailingSeparator: true,
				borderWidth: () => 0,
			},
			ChatBarPart.activeViewSettingsKey,
			ActiveChatBarContext.bindTo(contextKeyService),
			ChatBarFocusContext.bindTo(contextKeyService),
			'chatbar',
			'chatbar',
			undefined,
			SIDE_BAR_TITLE_BORDER,
			ViewContainerLocation.ChatBar,
			Extensions.ChatBar,
			Menus.ChatBarTitle,
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
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		// Minimal: no ChatCompositeBar, no ChatPanelManager, no agent loading.
		// The part is hidden by default (chatBar: false in layoutPolicy).
	}

	override updateStyles(): void {
		super.updateStyles();
		const container = assertReturnsDefined(this.getContainer());
		container.style.setProperty('--part-background', this.getColor(agentsPanelBackground) || '');
		container.style.setProperty('--part-border-color', this.getColor(agentsPanelBorder) || 'transparent');
		container.style.setProperty('--part-foreground', this.getColor(agentsPanelForeground) || '');
		container.style.backgroundColor = this.getColor(agentsPanelBackground) || '';
	}

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.CHATBAR_PART)) {
			return;
		}
		this._lastLayout = { width, height, top, left };
		super.layout(width, height, top, left);
		Part.prototype.layout.call(this, width, height, top, left);
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		return {
			partContainerClass: 'chatbar',
			pinnedViewContainersKey: ChatBarPart.pinnedViewsKey,
			placeholderViewContainersKey: ChatBarPart.placeholderViewContainersKey,
			viewContainersWorkspaceStateKey: ChatBarPart.viewContainersWorkspaceStateKey,
			icon: false,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			activityHoverOptions: {
				position: () => HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: () => { },
			compositeSize: 0,
			iconSize: 16,
			overflowActionSize: 30,
			colors: theme => ({
				activeBackgroundColor: theme.getColor(agentsPanelBackground),
				inactiveBackgroundColor: theme.getColor(agentsPanelBackground),
				activeBorderBottomColor: theme.getColor(PANEL_ACTIVE_TITLE_BORDER),
				activeForegroundColor: theme.getColor(PANEL_ACTIVE_TITLE_FOREGROUND),
				inactiveForegroundColor: theme.getColor(PANEL_INACTIVE_TITLE_FOREGROUND),
				badgeBackground: theme.getColor(agentsBadgeBackground),
				badgeForeground: theme.getColor(agentsBadgeForeground),
				dragAndDropBorder: theme.getColor(PANEL_DRAG_AND_DROP_BORDER)
			}),
			compact: true
		};
	}

	protected shouldShowCompositeBar(): boolean {
		return false;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	override toJSON(): object {
		return {
			type: Parts.CHATBAR_PART
		};
	}
}
