/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { alert } from '../../base/browser/ui/aria/aria.js';
import { Codicon } from '../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../base/common/keyCodes.js';
import { localize, localize2 } from '../../nls.js';
import { Categories } from '../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuRegistry, registerAction2 } from '../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { Menus } from './menus.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../platform/keybinding/common/keybindingsRegistry.js';
import { registerIcon } from '../../platform/theme/common/iconRegistry.js';
import { IsAuxiliaryWindowContext, IsWindowAlwaysOnTopContext } from '../../workbench/common/contextkeys.js';
import { IWorkbenchLayoutService, Parts } from '../../workbench/services/layout/browser/layoutService.js';
import { SessionsWelcomeVisibleContext, SidebarContentVisibleContext } from '../common/contextkeys.js';

// Register Icons
const panelCloseIcon = registerIcon('agent-panel-close', Codicon.close, localize('agentPanelCloseIcon', "Icon to close the panel."));
const sidebarToggleCollapsedIcon = registerIcon('agent-sidebar-toggle-collapsed', Codicon.layoutSidebarLeftOff, localize('agentSidebarToggleCollapsedIcon', "Icon for the sessions sidebar when content is collapsed."));
const sidebarToggleExpandedIcon = registerIcon('agent-sidebar-toggle-expanded', Codicon.layoutSidebarLeft, localize('agentSidebarToggleExpandedIcon', "Icon for the sessions sidebar when content is expanded."));

/**
 * [Sarosis] Toggle the sidebar content panel visibility.
 * The activity bar icon strip always stays visible; this action
 * only expands/collapses the content panel next to it.
 *
 * Uses setPartHidden which routes to the sessions workbench's
 * setSideBarHidden(), which in turn toggles the content panel
 * collapsed state rather than hiding the entire sidebar.
 */
class ToggleSidebarVisibilityAction extends Action2 {

	static readonly ID = 'workbench.action.agentToggleSidebarVisibility';

	constructor() {
		super({
			id: ToggleSidebarVisibilityAction.ID,
			title: localize2('toggleSidebar', 'Toggle Primary Side Bar Visibility'),
			icon: sidebarToggleCollapsedIcon,
			toggled: {
				condition: SidebarContentVisibleContext,
				icon: sidebarToggleExpandedIcon,
			},
			metadata: {
				description: localize('openAndCloseSidebar', 'Open/Show and Close/Hide Sidebar Content'),
			},
			category: Categories.View,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyB
			},
			menu: [
				{
					id: Menus.TitleBarLeftLayout,
					group: 'navigation',
					order: 0,
					when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SessionsWelcomeVisibleContext.toNegated())
				},
				{
					id: Menus.TitleBarContext,
					group: 'navigation',
					order: 0,
					when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SessionsWelcomeVisibleContext.toNegated())
				}
			]
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const contextKeyService = accessor.get(IContextKeyService);

		// [Sarosis] The sidebar (activity bar icon strip) is always visible.
		// This action toggles the content panel. We check the SidebarContentVisibleContext
		// to determine whether content is currently expanded.
		const isContentVisible = SidebarContentVisibleContext.getValue(contextKeyService);
		layoutService.setPartHidden(!!isContentVisible, Parts.SIDEBAR_PART);

		// Announce visibility change to screen readers
		const alertMessage = isContentVisible
			? localize('sidebarContentCollapsed', "Primary Side Bar content collapsed")
			: localize('sidebarContentExpanded', "Primary Side Bar content expanded");
		alert(alertMessage);
	}
}

class ToggleSecondarySidebarVisibilityAction extends Action2 {

	static readonly ID = 'workbench.action.agentToggleSecondarySidebarVisibility';

	constructor() {
		super({
			id: ToggleSecondarySidebarVisibilityAction.ID,
			title: localize2('toggleSecondarySidebar', 'Toggle Secondary Side Bar Visibility'),
			icon: panelCloseIcon,
			metadata: {
				description: localize('openAndCloseSecondarySidebar', 'Open/Show and Close/Hide Secondary Side Bar'),
			},
			category: Categories.View,
			f1: true,
			menu: [
				{
					id: Menus.TitleBarContext,
					order: 1,
					when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SessionsWelcomeVisibleContext.toNegated())
				}
			]
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const isCurrentlyVisible = layoutService.isVisible(Parts.AUXILIARYBAR_PART);

		layoutService.setPartHidden(isCurrentlyVisible, Parts.AUXILIARYBAR_PART);

		// Announce visibility change to screen readers
		const alertMessage = isCurrentlyVisible
			? localize('secondarySidebarHidden', "Secondary Side Bar hidden")
			: localize('secondarySidebarVisible', "Secondary Side Bar shown");
		alert(alertMessage);
	}
}

class TogglePanelVisibilityAction extends Action2 {

	static readonly ID = 'workbench.action.agentTogglePanelVisibility';

	constructor() {
		super({
			id: TogglePanelVisibilityAction.ID,
			title: localize2('togglePanel', 'Toggle Panel Visibility'),
			category: Categories.View,
			f1: true,
			icon: panelCloseIcon,
			menu: [
				{
					id: Menus.PanelTitle,
					group: 'navigation',
					order: 2,
					when: IsAuxiliaryWindowContext.toNegated()
				}
			]
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		layoutService.setPartHidden(layoutService.isVisible(Parts.PANEL_PART), Parts.PANEL_PART);
	}
}

registerAction2(ToggleSidebarVisibilityAction);
registerAction2(ToggleSecondarySidebarVisibilityAction);
registerAction2(TogglePanelVisibilityAction);

// Floating window controls: always-on-top
MenuRegistry.appendMenuItem(Menus.TitleBarRightLayout, {
	command: {
		id: 'workbench.action.toggleWindowAlwaysOnTop',
		title: localize('toggleWindowAlwaysOnTop', "Toggle Always on Top"),
		icon: Codicon.pin,
		toggled: {
			condition: IsWindowAlwaysOnTopContext,
			icon: Codicon.pinned,
		},
	},
	when: IsAuxiliaryWindowContext,
	group: 'navigation',
	order: 0
});
