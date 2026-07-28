/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { URI } from '../../../../../base/common/uri.js';
import { IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { IAsyncDataSource, ITreeNode, ITreeFilter, TreeVisibility, ITreeSorter } from '../../../../../base/browser/ui/tree/tree.js';
import { ICompressibleTreeRenderer } from '../../../../../base/browser/ui/tree/objectTree.js';
import { ICompressedTreeNode } from '../../../../../base/browser/ui/tree/compressedObjectTreeModel.js';
import { IFileService, IFileStat, FileKind } from '../../../../../platform/files/common/files.js';
import { basename, dirname, joinPath } from '../../../../../base/common/resources.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { match as globMatch } from '../../../../../base/common/glob.js';
import { IResourceLabel, ResourceLabels } from '../../../../../workbench/browser/labels.js';
import { DisposableStore, IDisposable, dispose, toDisposable } from '../../../../../base/common/lifecycle.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { InputBox, MessageType } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { IContextViewProvider } from '../../../../../base/browser/ui/contextview/contextview.js';
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { createSingleCallFunction } from '../../../../../base/common/functional.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { IKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { timeout } from '../../../../../base/common/async.js';
import { Event as VSEvent } from '../../../../../base/common/event.js';
import Severity from '../../../../../base/common/severity.js';
import { IEditableData } from '../../../../../workbench/common/views.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';


//#region Workspace Explorer Tree Element Interface

/**
 * Represents a node in the workspace explorer tree.
 *
 * - Root nodes are workspace folders (isWorkspaceRoot = true)
 * - Child nodes are files/directories within a workspace
 * - Workspaces without a local path are shown as virtual roots with info children
 */
export interface IWorkspaceExplorerElement {
	/** URI of the file/directory */
	resource: URI;
	/** Display name */
	name: string;
	/** Whether this is a directory */
	isDirectory: boolean;
	/** Whether this is a workspace root folder */
	isWorkspaceRoot?: boolean;
	/** Workspace ID (set on root nodes for identification) */
	workspaceId?: string;
	/** Pre-computed children for virtual root nodes */
	children?: IWorkspaceExplorerElement[];
	/**
	 * True when the workspace root has no associated local path.
	 * The node is rendered as a folder but its children come from
	 * metadata (description, created date) rather than the filesystem.
	 */
	isVirtualWorkspace?: boolean;
	/** Optional description text (shown for virtual workspace info nodes) */
	description?: string;
	/** If true, this is a read-only info/label node — not openable */
	isInfoNode?: boolean;
	/** If true, this is a placeholder node shown when a directory is empty */
	isEmptyPlaceholder?: boolean;
	/**
	 * True when this root node represents a *related folder* (an additional
	 * code repository linked to the active workspace) rather than the
	 * workspace's primary home directory. Used to render a distinguishing
	 * description label (e.g. "关联仓库").
	 */
	isRelatedFolder?: boolean;
	/** True when this related-folder root is a git repository. */
	isGitRepo?: boolean;
	/** 该目录正在被 codebase graph 索引（workspace view 中显示 ⏳ 指示器）。 */
	isIndexing?: boolean;
	/**
	 * Glob patterns (from .code-workspace `settings.files.exclude`) that
	 * should hide matching child entries. Set on root nodes and propagated
	 * to all descendants so getChildren can filter at any depth.
	 */
	excludePatterns?: string[];
}

//#endregion

//#region Tree Delegate

export class WorkspaceExplorerDelegate implements IListVirtualDelegate<IWorkspaceExplorerElement> {
	static readonly ITEM_HEIGHT = 22;

	getHeight(_element: IWorkspaceExplorerElement): number {
		return WorkspaceExplorerDelegate.ITEM_HEIGHT;
	}

	getTemplateId(_element: IWorkspaceExplorerElement): string {
		return WorkspaceExplorerRenderer.TEMPLATE_ID;
	}
}

//#endregion

//#region Tree Data Source

export class WorkspaceExplorerDataSource implements IAsyncDataSource<IWorkspaceExplorerElement, IWorkspaceExplorerElement> {
	/**
	 * v27: cache the last child fingerprint per resource path so we can
	 * detect no-op re-resolutions (e.g. when a file watcher busy-loop
	 * re-triggers getChildren for the same path repeatedly). The Map is
	 * deliberately unbounded — it's just string fingerprints, each
	 * ~1 KB, so even 10K entries would be ~10 MB. For a workspace
	 * explorer the realistic upper bound is hundreds.
	 */
	private static _lastFingerprints = new Map<string, string>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	hasChildren(element: IWorkspaceExplorerElement): boolean {
		// Info nodes are leaf nodes — never expandable
		if (element.isInfoNode) {
			return false;
		}
		// Virtual workspace roots with predefined children are expandable
		if (element.children && element.children.length > 0) {
			return true;
		}
		return element.isDirectory && !element.isVirtualWorkspace;
	}

	/**
	 * Hidden directory/file names that should be excluded from the tree.
	 * This includes common VCS directories and OS metadata files.
	 */
	private static readonly HIDDEN_NAMES = new Set<string>([
		'.git',
		'.svn',
		'.hg',
		'.DS_Store',
		'Thumbs.db',
		'node_modules',
	]);

	async getChildren(element: IWorkspaceExplorerElement): Promise<IWorkspaceExplorerElement[]> {
		// If element has predefined children (e.g. virtual root or virtual workspace), return them
		if (element.children) {
			this.logService.info(`[WorkspaceExplorer] getChildren(${element.name}): returning ${element.children.length} predefined children`);
			return element.children;
		}

		// Info nodes and virtual workspaces with no children array — nothing to expand
		if (element.isInfoNode) {
			return [];
		}

		// Virtual workspace roots without a real path have no filesystem children
		if (element.isVirtualWorkspace) {
			return [];
		}

		if (!element.isDirectory) {
			return [];
		}

		try {
			this.logService.info(`[WorkspaceExplorer] Resolving: ${element.resource.toString()}`);
			const stat: IFileStat = await this.fileService.resolve(element.resource, { resolveSingleChildDescendants: false });
			if (stat.children) {
				// Use exclude patterns propagated from the workspace root element
				// (sourced from .code-workspace settings.files.exclude). Also merge
				// any files.exclude from VS Code's configuration service for
				// completeness (user/workspace settings).
				const configExclude = this.configurationService.getValue<Record<string, boolean>>('files.exclude', { resource: element.resource }) ?? {};
				const configPatterns = Object.entries(configExclude)
					.filter(([, enabled]) => enabled === true)
					.map(([pattern]) => pattern);
				const allPatterns = [...new Set([...(element.excludePatterns ?? []), ...configPatterns])];

				const filtered: string[] = [];
				const children = stat.children
					.filter((child: IFileStat) => {
						const name = basename(child.resource);
						// Filter out hidden/internal entries
						if (WorkspaceExplorerDataSource.HIDDEN_NAMES.has(name)) {
							filtered.push(name);
							return false;
						}
						// Filter out entries matching files.exclude patterns
						for (const pattern of allPatterns) {
							if (globMatch(pattern, name)) {
								filtered.push(name);
								return false;
							}
						}
						return true;
					})
					.map((child: IFileStat) => ({
						resource: child.resource,
						name: basename(child.resource),
						isDirectory: child.isDirectory,
						// Propagate exclude patterns to children so nested
						// directories also filter their contents.
						excludePatterns: element.excludePatterns,
					}));
				// v27: dedupe consecutive identical resolutions to avoid flooding
				// the log when a parent render loop (or a busy file watcher)
				// re-triggers getChildren for the same path. We compare the
				// child name+isDirectory fingerprint; if it matches the last
				// cached signature for this element, we skip the info log.
				// First-time resolution always logs.
				const fingerprint = children
					.map(c => `${c.name}:${c.isDirectory ? 'd' : 'f'}`)
					.sort()
					.join('|');
				const lastFp = WorkspaceExplorerDataSource._lastFingerprints.get(element.resource.toString());
				if (lastFp === fingerprint) {
					// Same children as last time — debug-level only to keep
					// the log readable while still letting users opt in to
					// the noise via log level config.
					this.logService.debug(
						`[WorkspaceExplorer] No change for: ${element.name} (children=${children.length})`,
					);
				} else {
					this.logService.info(
						`[WorkspaceExplorer] Resolved ${stat.children.length} raw children, ${children.length} after filtering for: ${element.name}${filtered.length > 0 ? ` (filtered out: ${filtered.join(', ')})` : ''}`,
					);
					WorkspaceExplorerDataSource._lastFingerprints.set(element.resource.toString(), fingerprint);
				}

				// When all children were filtered out, show "empty folder" placeholder
				if (children.length === 0 && stat.children.length > 0) {
					return [{
						resource: URI.joinPath(element.resource, '.empty-placeholder'),
						name: localize('emptyFolder', "工作区目录为空"),
						isDirectory: false,
						isInfoNode: true,
						isEmptyPlaceholder: true,
					}];
				}

				return children;
			}

			// Directory has no children at all — show "empty folder" placeholder
			this.logService.info(`[WorkspaceExplorer] No children found for: ${element.name}`);
			return [{
				resource: URI.joinPath(element.resource, '.empty-placeholder'),
				name: localize('emptyFolder2', "工作区目录为空"),
				isDirectory: false,
				isInfoNode: true,
				isEmptyPlaceholder: true,
			}];
		} catch (error) {
			this.logService.error(`[WorkspaceExplorer] Error resolving ${element.resource.toString()}:`, error);
			return [];
		}
	}
}

//#endregion

//#region Tree Renderer

interface IWorkspaceExplorerTemplateData {
	readonly templateDisposables: DisposableStore;
	readonly elementDisposables: DisposableStore;
	readonly label: IResourceLabel;
	readonly container: HTMLElement;
	/**
	 * Inline "+" action button rendered at the right edge of a workspace
	 * root row. Lets the user add a related folder directly from the
	 * collapsible workspace-name header. Hidden for non-root rows.
	 */
	readonly addButton: HTMLElement;
}

/**
 * Tree renderer that uses ResourceLabels for proper file icon theme support.
 * This ensures file icons match the user's selected icon theme (e.g., Seti, Material Icons).
 */
export class WorkspaceExplorerRenderer implements ICompressibleTreeRenderer<IWorkspaceExplorerElement, FuzzyScore, IWorkspaceExplorerTemplateData> {
	static readonly TEMPLATE_ID = 'workspace-explorer-element';

	readonly templateId: string = WorkspaceExplorerRenderer.TEMPLATE_ID;

	constructor(
		private readonly labels: ResourceLabels,
		/**
		 * Invoked when the user clicks the inline "+" on a workspace root row.
		 * The owning view wires this to `showAddRelatedFolder`. The clicked
		 * root's workspace id is passed so the action targets the right one.
		 */
		private readonly onAddRelatedFolder?: (workspaceId: string | undefined) => void,
		/**
		 * Returns the in-flight rename editing state for an element, or
		 * `undefined` when it is not being renamed. When defined, the row
		 * renders an inline {@link InputBox} (VS Code Explorer convention)
		 * instead of the normal label. Supplied by the owning view.
		 */
		private readonly getEditableData?: (element: IWorkspaceExplorerElement) => IEditableData | undefined,
		/** Context-view provider required by the rename {@link InputBox}. */
		private readonly contextViewProvider?: IContextViewProvider,
		/** Used to keep the rename input open while a context menu is showing. */
		private readonly contextMenuService?: IContextMenuService,
	) { }

	renderTemplate(container: HTMLElement): IWorkspaceExplorerTemplateData {
		const templateDisposables = new DisposableStore();
		const elementDisposables = new DisposableStore();

		// Create a resource label in the container — this handles icon + name rendering
		const label = templateDisposables.add(this.labels.create(container, { supportHighlights: true }));

		// Inline "+" action button, pinned to the right edge of the row. It is
		// only made visible for workspace root rows in `_renderNode`.
		const addButton = DOM.append(container, DOM.$('span.workspace-root-add-action'));
		addButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		addButton.setAttribute('role', 'button');
		addButton.setAttribute('tabindex', '0');
		addButton.title = localize('addRelatedFolderInline', "添加关联文件夹");
		addButton.style.display = 'none';

		return { templateDisposables, elementDisposables, label, container, addButton };
	}

	renderElement(node: ITreeNode<IWorkspaceExplorerElement, FuzzyScore>, _index: number, templateData: IWorkspaceExplorerTemplateData): void {
		templateData.elementDisposables.clear();
		const element = node.element;

		// ─── Rename edit mode ────────────────────────────────────────
		// When the owning view has marked this element as "editable" (the
		// user invoked Rename / F2), swap the normal label for an inline
		// InputBox — mirroring VS Code's native Explorer behaviour.
		const editableData = this.getEditableData?.(element);
		if (editableData && this.contextViewProvider) {
			// Hide the label + the inline "+" while editing.
			templateData.addButton.style.display = 'none';
			templateData.label.element.style.display = 'none';
			templateData.elementDisposables.add(this._renderInputBox(templateData.container, element, editableData));
			return;
		}

		templateData.label.element.style.display = 'flex';
		this._renderNode(element, templateData);
	}

	renderCompressedElements(node: ITreeNode<ICompressedTreeNode<IWorkspaceExplorerElement>, FuzzyScore>, _index: number, templateData: IWorkspaceExplorerTemplateData): void {
		templateData.elementDisposables.clear();
		// Compressed rows are never workspace roots (roots are incompressible),
		// so the inline "+" must stay hidden here.
		templateData.addButton.style.display = 'none';
		const elements = node.element.elements;
		const lastElement = elements[elements.length - 1];

		// For compressed paths, show joined names but use the last element's resource for icon
		const compressedName = elements.map((e: IWorkspaceExplorerElement) => e.name).join('/');

		templateData.label.setResource(
			{
				resource: lastElement.resource,
				name: compressedName,
			},
			{
				fileKind: lastElement.isWorkspaceRoot
					? FileKind.ROOT_FOLDER
					: lastElement.isDirectory
						? FileKind.FOLDER
						: FileKind.FILE,
				extraClasses: lastElement.isWorkspaceRoot ? ['workspace-root-entry'] : undefined,
			}
		);
	}

	private _renderNode(element: IWorkspaceExplorerElement, templateData: IWorkspaceExplorerTemplateData): void {
		// Reset the inline "+" button to hidden by default; it is only shown
		// for the workspace's *primary* root row (see below).
		templateData.addButton.style.display = 'none';

		// Info nodes (read-only label items inside virtual workspaces)
		if (element.isInfoNode) {
			const infoClasses = ['workspace-info-node'];
			if (element.isEmptyPlaceholder) {
				infoClasses.push('workspace-empty-placeholder');
			}
			templateData.label.setResource(
				{
					resource: element.resource,
					name: element.name,
				},
				{
					fileKind: FileKind.FILE,
					extraClasses: infoClasses,
					hideIcon: true,
				}
			);
			return;
		}

		const fileKind = element.isWorkspaceRoot
			? FileKind.ROOT_FOLDER
			: element.isDirectory
				? FileKind.FOLDER
				: FileKind.FILE;

		const extraClasses: string[] = [];
		if (element.isWorkspaceRoot) {
			extraClasses.push('workspace-root-entry');
		}
		if (element.isVirtualWorkspace) {
			extraClasses.push('workspace-virtual-entry');
		}
		if (element.isRelatedFolder) {
			extraClasses.push('workspace-related-folder-entry');
		}
		if (element.isIndexing) {
			extraClasses.push('workspace-indexing-entry');
		}

		// Description shown to the right of the root name:
		//  - virtual workspaces show their description text
		//  - related folders show a "关联仓库" / "关联仓库 · Git" tag
		let description: string | undefined;
		if (element.isVirtualWorkspace) {
			description = element.description;
		} else if (element.isRelatedFolder) {
			description = element.isGitRepo
				? localize('relatedFolderGit', "关联仓库 · Git")
				: localize('relatedFolder', "关联仓库");
		}

		templateData.label.setResource(
			{
				resource: element.resource,
				name: element.name,
				description,
			},
			{
				fileKind,
				extraClasses: extraClasses.length > 0 ? extraClasses : undefined,
			}
		);

		// ─── Inline "+" on the workspace's primary root row ──────────
		// The "+" lets the user add a related folder straight from the
		// collapsible workspace-name header. We only show it on the workspace's
		// PRIMARY root (the home directory or a virtual workspace root) — not on
		// related-folder roots, which already *are* added folders.
		const isPrimaryRoot = !!element.isWorkspaceRoot && !element.isRelatedFolder;
		if (isPrimaryRoot && this.onAddRelatedFolder) {
			templateData.addButton.style.display = '';
			const workspaceId = element.workspaceId;
			const trigger = (e: Event) => {
				// Stop the tree from treating this as a row open/expand toggle.
				DOM.EventHelper.stop(e, true);
				this.onAddRelatedFolder?.(workspaceId);
			};
			templateData.elementDisposables.add(DOM.addDisposableListener(templateData.addButton, DOM.EventType.CLICK, trigger));
			templateData.elementDisposables.add(DOM.addDisposableListener(templateData.addButton, DOM.EventType.MOUSE_DOWN, e => DOM.EventHelper.stop(e, true)));
			templateData.elementDisposables.add(DOM.addDisposableListener(templateData.addButton, DOM.EventType.KEY_DOWN, e => {
				const kbd = e as KeyboardEvent;
				if (kbd.key === 'Enter' || kbd.key === ' ') {
					trigger(e);
				}
			}));
		}
	}

	disposeTemplate(templateData: IWorkspaceExplorerTemplateData): void {
		templateData.elementDisposables.dispose();
		templateData.templateDisposables.dispose();
	}

	/**
	 * Render an inline rename {@link InputBox} into the row container, seeded
	 * with the element's current name. Closely follows VS Code's native
	 * Explorer `renderInputBox`:
	 *  - Shows a file-kind icon (via a throwaway ResourceLabel) next to the box.
	 *  - Pre-selects the file name *stem* (everything before the last dot) so a
	 *    quick retype keeps the extension.
	 *  - Commits on Enter (when valid) / cancels on Escape.
	 *  - Commits on blur, but stays open while a context menu / context view is
	 *    focused so validation popups don't dismiss it prematurely.
	 *  - Live-validates through {@link IEditableData.validationMessage}.
	 */
	private _renderInputBox(container: HTMLElement, element: IWorkspaceExplorerElement, editableData: IEditableData): IDisposable {
		// A dedicated label just to show the correct file/folder icon next to
		// the input box (its text part is hidden).
		const label = this.labels.create(container);
		const fileKind = element.isWorkspaceRoot
			? FileKind.ROOT_FOLDER
			: element.isDirectory
				? FileKind.FOLDER
				: FileKind.FILE;

		const value = element.name || '';
		const parent = dirname(element.resource);
		label.setResource(
			{ resource: joinPath(parent, value || ' '), name: value || ' ' },
			{ fileKind, extraClasses: ['workspace-explorer-item-edited'] }
		);

		// Hide the label's text part — only its icon should remain visible.
		const firstChild = label.element.firstElementChild as HTMLElement | null;
		if (firstChild) {
			firstChild.style.display = 'none';
		}

		const inputBox = new InputBox(label.element, this.contextViewProvider!, {
			validationOptions: {
				validation: (val) => {
					const message = editableData.validationMessage(val);
					if (!message || message.severity !== Severity.Error) {
						return null;
					}
					return { content: message.content, formatContent: true, type: MessageType.ERROR };
				}
			},
			ariaLabel: localize('workspaceRenameInputAria', "请输入名称，按 Enter 确认或 Esc 取消。"),
			inputBoxStyles: defaultInputBoxStyles,
		});

		const lastDot = value.lastIndexOf('.');
		inputBox.value = value;
		inputBox.focus();
		inputBox.select({ start: 0, end: lastDot > 0 && !element.isDirectory ? lastDot : value.length });

		const done = createSingleCallFunction((success: boolean, finishEditing: boolean) => {
			label.element.style.display = 'none';
			const newValue = inputBox.value;
			dispose(toDispose);
			label.element.remove();
			if (finishEditing) {
				editableData.onFinish(newValue, success);
			}
		});

		const showInputBoxNotification = () => {
			if (inputBox.isInputValid()) {
				const message = editableData.validationMessage(inputBox.value);
				if (message) {
					inputBox.showMessage({
						content: message.content,
						formatContent: true,
						type: message.severity === Severity.Info ? MessageType.INFO : message.severity === Severity.Warning ? MessageType.WARNING : MessageType.ERROR,
					});
				} else {
					inputBox.hideMessage();
				}
			}
		};
		showInputBoxNotification();

		const toDispose: IDisposable[] = [
			inputBox,
			DOM.addStandardDisposableListener(inputBox.inputElement, DOM.EventType.KEY_DOWN, (e: IKeyboardEvent) => {
				if (e.equals(KeyCode.Enter)) {
					if (!inputBox.validate()) {
						done(true, true);
					}
				} else if (e.equals(KeyCode.Escape)) {
					done(false, true);
				}
			}),
			DOM.addStandardDisposableListener(inputBox.inputElement, DOM.EventType.KEY_UP, () => {
				showInputBoxNotification();
			}),
			DOM.addDisposableListener(inputBox.inputElement, DOM.EventType.BLUR, async () => {
				while (true) {
					await timeout(0);
					const ownerDocument = inputBox.inputElement.ownerDocument;
					if (!ownerDocument.hasFocus()) {
						break;
					}
					if (DOM.isActiveElement(inputBox.inputElement)) {
						return;
					} else if (DOM.isHTMLElement(ownerDocument.activeElement) && DOM.hasParentWithClass(ownerDocument.activeElement, 'context-view')) {
						if (this.contextMenuService) {
							await VSEvent.toPromise(this.contextMenuService.onDidHideContextMenu);
						} else {
							break;
						}
					} else {
						break;
					}
				}
				done(inputBox.isInputValid(), true);
			}),
			label,
		];

		return toDisposable(() => {
			done(false, false);
		});
	}
}

//#endregion

//#region Tree Filter

export class WorkspaceExplorerFilter implements ITreeFilter<IWorkspaceExplorerElement, FuzzyScore> {

	filter(element: IWorkspaceExplorerElement): TreeVisibility {
		// Workspace roots (real & virtual) are always visible
		if (element.isWorkspaceRoot) {
			return TreeVisibility.Visible;
		}

		// Info nodes are always visible
		if (element.isInfoNode) {
			return TreeVisibility.Visible;
		}

		return TreeVisibility.Visible;
	}
}

//#endregion

//#region Tree Sorter

export class WorkspaceExplorerSorter implements ITreeSorter<IWorkspaceExplorerElement> {
	compare(a: IWorkspaceExplorerElement, b: IWorkspaceExplorerElement): number {
		// Workspace roots maintain their order
		if (a.isWorkspaceRoot && b.isWorkspaceRoot) {
			return a.name.localeCompare(b.name);
		}

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

export class WorkspaceExplorerAccessibilityProvider implements IListAccessibilityProvider<IWorkspaceExplorerElement> {
	getAriaLabel(element: IWorkspaceExplorerElement): string {
		if (element.isWorkspaceRoot) {
			return localize('workspaceRoot', "{0} (workspace)", element.name);
		}
		return element.name;
	}

	getWidgetAriaLabel(): string {
		return localize('workspaceExplorerTree', "Workspace Explorer");
	}
}

//#endregion
