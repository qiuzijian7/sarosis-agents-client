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
import * as platform from '../../../../base/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SearchSortOrder, SEARCH_EXCLUDE_CONFIG, ViewMode, DEFAULT_MAX_SEARCH_RESULTS, SemanticSearchBehavior } from '../../../../workbench/services/search/common/search.js';

// [Saros] The Sessions window deliberately does NOT import the full workbench
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

// [Saros] The Sessions window does NOT import the full workbench `search.contribution.ts`,
// which is where the entire `search` configuration schema (and crucially its DEFAULT values)
// is registered. Without these defaults, `configurationService.getValue('search')` returns an
// object missing the `decorations` and `searchView` sub-nodes, so the native SearchView crashes
// at render time:
//   - FileMatchRenderer.renderElement → reads `search.decorations.colors` (undefined → throws)
//   - SearchWidget.submitSearch / RefreshTreeController → reads `search.searchView.semanticSearchBehavior`
// We backfill the same `search` configuration node here so the defaults resolve correctly.
// (Schema kept in sync with workbench/contrib/search/browser/search.contribution.ts.)
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'search',
	order: 13,
	title: localize('searchConfigurationTitle', "Search"),
	type: 'object',
	properties: {
		[SEARCH_EXCLUDE_CONFIG]: {
			type: 'object',
			markdownDescription: localize('exclude', "Configure glob patterns for excluding files and folders in fulltext searches and file search in quick open."),
			default: { '**/node_modules': true, '**/bower_components': true, '**/*.code-search': true },
			additionalProperties: {
				anyOf: [
					{ type: 'boolean', description: localize('exclude.boolean', "The glob pattern to match file paths against. Set to true or false to enable or disable the pattern.") },
					{
						type: 'object',
						properties: {
							when: {
								type: 'string',
								pattern: '\\w*\\$\\(basename\\)\\w*',
								default: '$(basename).ext',
								markdownDescription: localize({ key: 'exclude.when', comment: ['\\$(basename) should not be translated'] }, 'Additional check on the siblings of a matching file. Use \\$(basename) as variable for the matching file name.')
							}
						}
					}
				]
			},
			scope: ConfigurationScope.RESOURCE
		},
		'search.mode': {
			type: 'string',
			enum: ['view', 'reuseEditor', 'newEditor'],
			default: 'view',
			markdownDescription: localize('search.mode', "Controls where new `Search: Find in Files` and `Find in Folder` operations occur."),
		},
		'search.useRipgrep': {
			type: 'boolean',
			description: localize('useRipgrep', "This setting is deprecated and now falls back on \"search.usePCRE2\"."),
			default: true
		},
		'search.useIgnoreFiles': {
			type: 'boolean',
			markdownDescription: localize('useIgnoreFiles', "Controls whether to use `.gitignore` and `.ignore` files when searching for files."),
			default: true,
			scope: ConfigurationScope.RESOURCE
		},
		'search.useGlobalIgnoreFiles': {
			type: 'boolean',
			markdownDescription: localize('useGlobalIgnoreFiles', "Controls whether to use your global gitignore file when searching for files."),
			default: false,
			scope: ConfigurationScope.RESOURCE
		},
		'search.useParentIgnoreFiles': {
			type: 'boolean',
			markdownDescription: localize('useParentIgnoreFiles', "Controls whether to use `.gitignore` and `.ignore` files in parent directories when searching for files."),
			default: false,
			scope: ConfigurationScope.RESOURCE
		},
		'search.quickOpen.includeSymbols': {
			type: 'boolean',
			description: localize('search.quickOpen.includeSymbols', "Whether to include results from a global symbol search in the file results for Quick Open."),
			default: false
		},
		'search.ripgrep.maxThreads': {
			type: 'number',
			description: localize('search.ripgrep.maxThreads', "Number of threads to use for searching. When set to 0, the engine automatically determines this value."),
			default: 0
		},
		'search.quickOpen.includeHistory': {
			type: 'boolean',
			description: localize('search.quickOpen.includeHistory', "Whether to include results from recently opened files in the file results for Quick Open."),
			default: true,
		},
		'search.quickOpen.history.filterSortOrder': {
			type: 'string',
			enum: ['default', 'recency'],
			default: 'default',
			description: localize('filterSortOrder', "Controls sorting order of editor history in quick open when filtering.")
		},
		'search.followSymlinks': {
			type: 'boolean',
			description: localize('search.followSymlinks', "Controls whether to follow symlinks while searching."),
			default: true
		},
		'search.smartCase': {
			type: 'boolean',
			description: localize('search.smartCase', "Search case-insensitively if the pattern is all lowercase, otherwise, search case-sensitively."),
			default: false
		},
		'search.globalFindClipboard': {
			type: 'boolean',
			default: false,
			description: localize('search.globalFindClipboard', "Controls whether the Search view should read or modify the shared find clipboard on macOS."),
			included: platform.isMacintosh
		},
		'search.maxResults': {
			type: ['number', 'null'],
			default: DEFAULT_MAX_SEARCH_RESULTS,
			markdownDescription: localize('search.maxResults', "Controls the maximum number of search results, this can be set to `null` (empty) to return unlimited results.")
		},
		'search.collapseResults': {
			type: 'string',
			enum: ['auto', 'alwaysCollapse', 'alwaysExpand'],
			default: 'alwaysExpand',
			description: localize('search.collapseAllResults', "Controls whether the search results will be collapsed or expanded."),
		},
		'search.useReplacePreview': {
			type: 'boolean',
			default: true,
			description: localize('search.useReplacePreview', "Controls whether to open Replace Preview when selecting or replacing a match."),
		},
		'search.showLineNumbers': {
			type: 'boolean',
			default: false,
			description: localize('search.showLineNumbers', "Controls whether to show line numbers for search results."),
		},
		'search.usePCRE2': {
			type: 'boolean',
			default: false,
			description: localize('search.usePCRE2', "Whether to use the PCRE2 regex engine in text search."),
		},
		'search.actionsPosition': {
			type: 'string',
			enum: ['auto', 'right'],
			default: 'right',
			description: localize('search.actionsPosition', "Controls the positioning of the actionbar on rows in the Search view.")
		},
		'search.searchOnType': {
			type: 'boolean',
			default: true,
			description: localize('search.searchOnType', "Search all files as you type.")
		},
		'search.seedWithNearestWord': {
			type: 'boolean',
			default: false,
			description: localize('search.seedWithNearestWord', "Enable seeding search from the word nearest the cursor when the active editor has no selection.")
		},
		'search.seedOnFocus': {
			type: 'boolean',
			default: false,
			markdownDescription: localize('search.seedOnFocus', "Update the search query to the editor's selected text when focusing the Search view.")
		},
		'search.searchOnTypeDebouncePeriod': {
			type: 'number',
			default: 300,
			markdownDescription: localize('search.searchOnTypeDebouncePeriod', "When search on type is enabled, controls the timeout in milliseconds between a character being typed and the search starting.")
		},
		'search.sortOrder': {
			type: 'string',
			enum: [SearchSortOrder.Default, SearchSortOrder.FileNames, SearchSortOrder.Type, SearchSortOrder.Modified, SearchSortOrder.CountDescending, SearchSortOrder.CountAscending],
			default: SearchSortOrder.Default,
			description: localize('search.sortOrder', "Controls sorting order of search results.")
		},
		'search.decorations.colors': {
			type: 'boolean',
			description: localize('search.decorations.colors', "Controls whether search file decorations should use colors."),
			default: true
		},
		'search.decorations.badges': {
			type: 'boolean',
			description: localize('search.decorations.badges', "Controls whether search file decorations should use badges."),
			default: true
		},
		'search.defaultViewMode': {
			type: 'string',
			enum: [ViewMode.Tree, ViewMode.List],
			default: ViewMode.List,
			description: localize('search.defaultViewMode', "Controls the default search result view mode.")
		},
		'search.quickAccess.preserveInput': {
			type: 'boolean',
			description: localize('search.quickAccess.preserveInput', "Controls whether the last typed input to Quick Search should be restored when opening it the next time."),
			default: false
		},
		'search.experimental.closedNotebookRichContentResults': {
			type: 'boolean',
			description: localize('search.experimental.closedNotebookResults', "Show notebook editor rich content results for closed notebooks."),
			default: false
		},
		'search.searchView.semanticSearchBehavior': {
			type: 'string',
			description: localize('search.searchView.semanticSearchBehavior', "Controls the behavior of the semantic search results displayed in the Search view."),
			enum: [SemanticSearchBehavior.Manual, SemanticSearchBehavior.RunOnEmpty, SemanticSearchBehavior.Auto],
			default: SemanticSearchBehavior.Manual,
			tags: ['preview'],
		},
		'search.searchView.keywordSuggestions': {
			type: 'boolean',
			description: localize('search.searchView.keywordSuggestions', "Enable keyword suggestions in the Search view."),
			default: false,
			tags: ['preview'],
		},
	}
});

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
