/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainerLocation,
	Extensions as ViewExtensions,
	WindowEnablement,
} from '../../../../workbench/common/views.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { TdbamViewPane } from './tdbamViewPane.js';

// --- Constants -------------------------------------------------------------

const TDBAM_VIEW_CONTAINER_ID = 'tdbam.memory';
const TDBAM_VIEW_ID = 'tdbam.memory.view';

// Order: agentStudio top icons range 0~92, footer icons typically >100.
// We pick 95 so this icon sits AFTER agentStudio's last top icon (Self-Evolution @ 92)
// and BEFORE the footer/global icons. Adjust if collision.
const TDBAM_ICON_ORDER = 95;

// --- Icon registration -----------------------------------------------------

const tdbamIcon = registerIcon(
	'tdbam-memory',
	Codicon.database,
	localize('tdbamIcon', 'TDB-AM Memory')
);

// --- Workbench contribution -----------------------------------------------

class TdbamSidebarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.tdbam.sidebar';

	constructor() {
		super();
		this._registerSidebarIcon();
	}

	private _registerSidebarIcon(): void {
		const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

		// Register the sidebar ViewContainer (this creates the activity-bar icon
		// inside saros SidebarPart, which monitors ViewContainerLocation.Sidebar).
		const container = viewContainerRegistry.registerViewContainer({
			id: TDBAM_VIEW_CONTAINER_ID,
			title: localize2('tdbam.title', 'TDB-AM 记忆'),
			icon: tdbamIcon,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [TDBAM_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
			storageId: TDBAM_VIEW_CONTAINER_ID,
			hideIfEmpty: false,
			order: TDBAM_ICON_ORDER,
			windowEnablement: WindowEnablement.Both,
		}, ViewContainerLocation.Sidebar, { isDefault: true, doNotRegisterOpenCommand: true });

		// Register the actual ViewPane inside the container.
		viewsRegistry.registerViews([{
			id: TDBAM_VIEW_ID,
			name: localize2('tdbam.view.name', 'Memory'),
			ctorDescriptor: new SyncDescriptor(TdbamViewPane),
			canToggleVisibility: false,
			canMoveView: false,
			order: 0,
			windowEnablement: WindowEnablement.Both,
		}], container);
	}
}

registerWorkbenchContribution2(
	TdbamSidebarContribution.ID,
	TdbamSidebarContribution,
	WorkbenchPhase.BlockStartup
);
