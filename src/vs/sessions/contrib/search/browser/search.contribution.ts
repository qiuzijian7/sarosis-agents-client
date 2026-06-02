/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight, KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ExplorerFolderContext } from '../../../../workbench/contrib/files/common/files.js';
import { IExplorerService } from '../../../../workbench/contrib/files/browser/files.js';
import { OpenEditorCommandId } from '../../../../workbench/contrib/searchEditor/browser/constants.js';
import { resolveResourcesForSearchIncludes } from '../../../../workbench/services/search/common/queryBuilder.js';
import { SESSIONS_FILES_VIEW_ID } from '../../files/browser/filesView.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISearchViewModelWorkbenchService } from '../../../../workbench/contrib/search/browser/searchTreeModel/searchViewModelWorkbenchService.js';
import { SearchViewModelWorkbenchService } from '../../../../workbench/contrib/search/browser/searchTreeModel/searchModel.js';

// [Sarosis] The Sessions window deliberately does NOT import the full workbench
// `search.contribution.ts` (which would register the native `workbench.view.search`
// container and clash with our AgentStudio search icon). However, the native
// `SearchView` — which `AgentStudioSearchViewPane` extends — depends on
// `ISearchViewModelWorkbenchService`, and that singleton is ONLY registered by
// the full search.contribution. Without it, constructing AgentStudioSearchViewPane
// throws an unresolved-dependency error and the search view pane silently fails
// to render (the container shows "Drag a view here to display.").
//
// `IReplaceService` and `ISearchHistoryService` are already registered via
// `search.common.contribution.ts` (imported in sessions.common.main.ts), so we
// only need to backfill the view-model service here.
registerSingleton(ISearchViewModelWorkbenchService, SearchViewModelWorkbenchService, InstantiationType.Delayed);

KeybindingsRegistry.registerKeybindingRule({
	id: OpenEditorCommandId,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF,
	weight: KeybindingWeight.WorkbenchContrib,
});

MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: {
		id: OpenEditorCommandId,
		title: localize2('openSearch', "Search"),
		icon: Codicon.search,
	},
	group: 'navigation',
	order: 0,
	when: ContextKeyExpr.equals('view', SESSIONS_FILES_VIEW_ID),
});

MenuRegistry.appendMenuItem(MenuId.MenubarViewMenu, {
	command: {
		id: OpenEditorCommandId,
		title: localize({ key: 'miSearch', comment: ['&& denotes a mnemonic'] }, "&&Search"),
	},
	group: '4_auxbar',
	order: 1,
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.files.action.findInFolder',
			title: localize2('findInFolder', "Find in Folder..."),
			menu: {
				id: MenuId.ExplorerContext,
				group: '4_search',
				order: 10,
				when: ExplorerFolderContext,
			},
		});
	}

	async run(accessor: ServicesAccessor, resource?: URI) {
		const explorerService = accessor.get(IExplorerService);
		const fileService = accessor.get(IFileService);
		const contextService = accessor.get(IWorkspaceContextService);
		const commandService = accessor.get(ICommandService);

		const resources = resource ? [resource] : explorerService.getContext(true).map(item => item.resource);
		const results = await fileService.resolveAll(resources.map(resource => ({ resource })));
		const folders: URI[] = [];

		for (const result of results) {
			if (result.success && result.stat) {
				folders.push(result.stat.isDirectory ? result.stat.resource : dirname(result.stat.resource));
			}
		}

		const filesToInclude = resolveResourcesForSearchIncludes(folders, contextService);
		await commandService.executeCommand(OpenEditorCommandId, {
			filesToInclude: filesToInclude.join(', '),
			showIncludesExcludes: true,
			location: 'reuse',
		});
	}
});
