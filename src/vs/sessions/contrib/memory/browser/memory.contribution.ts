/*---------------------------------------------------------------------------------------------
 *  Memory Side View — agentmemory 4-Tier Consolidation Model
 *  Sidebar contribution: registers the Memory view container and view pane.
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
import { MemoryViewPane } from './memoryViewPane.js';

// --- Constants -------------------------------------------------------------

const MEMORY_VIEW_CONTAINER_ID = 'memory.view';
const MEMORY_VIEW_ID = 'memory.view.main';

// Order: agentStudio top icons range 0~92, footer icons typically >100.
// We pick 95 so this icon sits AFTER agentStudio's last top icon (Self-Evolution @ 92)
// and BEFORE the footer/global icons. Adjust if collision.
const MEMORY_ICON_ORDER = 95;

// --- Icon registration -----------------------------------------------------

const memoryIcon = registerIcon(
	'memory-view',
	Codicon.database,
	localize('memoryIcon', 'Memory')
);

// --- Workbench contribution ------------------------------------------------

class MemorySidebarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.memory.sidebar';

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
			id: MEMORY_VIEW_CONTAINER_ID,
			title: localize2('memory.title', 'Memory'),
			icon: memoryIcon,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [MEMORY_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
			storageId: MEMORY_VIEW_CONTAINER_ID,
			hideIfEmpty: false,
			order: MEMORY_ICON_ORDER,
			windowEnablement: WindowEnablement.Both,
		}, ViewContainerLocation.Sidebar, { isDefault: true, doNotRegisterOpenCommand: true });

		// Register the actual ViewPane inside the container.
		viewsRegistry.registerViews([{
			id: MEMORY_VIEW_ID,
			name: localize2('memory.view.name', 'Memory'),
			ctorDescriptor: new SyncDescriptor(MemoryViewPane),
			canToggleVisibility: false,
			canMoveView: false,
			order: 0,
			windowEnablement: WindowEnablement.Both,
		}], container);
	}
}

registerWorkbenchContribution2(
	MemorySidebarContribution.ID,
	MemorySidebarContribution,
	WorkbenchPhase.BlockStartup
);
