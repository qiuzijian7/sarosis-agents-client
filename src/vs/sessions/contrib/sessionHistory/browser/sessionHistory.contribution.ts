/*---------------------------------------------------------------------------------------------
 *  Session History View — sidebar contribution
 *  Registers the Session History view container and view pane in the sidebar,
 *  allowing users to browse all chat sessions, filter by agent/workspace,
 *  view user messages (newest first), and jump to specific messages in the
 *  Agent Studio chat editor.
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
import { SessionHistoryViewPane } from './sessionHistoryView.js';

// --- Constants -------------------------------------------------------------

export const SESSION_HISTORY_VIEW_CONTAINER_ID = 'sessionHistory.view';
export const SESSION_HISTORY_VIEW_ID = 'sessionHistory.view.main';

// Order: after SourceControl(30) separator, before Agents(60).
const SESSION_HISTORY_ICON_ORDER = 50;

// --- Icon registration -----------------------------------------------------

const sessionHistoryIcon = registerIcon(
	'session-history-view',
	Codicon.commentDiscussion,
	localize('sessionHistoryIcon', 'Session History')
);

// --- Workbench contribution ------------------------------------------------

class SessionHistorySidebarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.sessionHistory.sidebar';

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
			id: SESSION_HISTORY_VIEW_CONTAINER_ID,
			title: localize2('sessionHistory.title', 'Session History'),
			icon: sessionHistoryIcon,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SESSION_HISTORY_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
			storageId: SESSION_HISTORY_VIEW_CONTAINER_ID,
			hideIfEmpty: false,
			order: SESSION_HISTORY_ICON_ORDER,
			windowEnablement: WindowEnablement.Both,
		}, ViewContainerLocation.Sidebar, { isDefault: true, doNotRegisterOpenCommand: true });

		// Register the actual ViewPane inside the container.
		viewsRegistry.registerViews([{
			id: SESSION_HISTORY_VIEW_ID,
			name: localize2('sessionHistory.view.name', 'Session History'),
			ctorDescriptor: new SyncDescriptor(SessionHistoryViewPane),
			canToggleVisibility: false,
			canMoveView: false,
			order: 0,
			windowEnablement: WindowEnablement.Both,
		}], container);
	}
}

registerWorkbenchContribution2(
	SessionHistorySidebarContribution.ID,
	SessionHistorySidebarContribution,
	WorkbenchPhase.BlockStartup
);
