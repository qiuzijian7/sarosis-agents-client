/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sessionExplorer.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { IAsyncDataSource, ITreeNode, ITreeFilter, TreeVisibility } from '../../../../../base/browser/ui/tree/tree.js';
import { ICompressibleTreeRenderer } from '../../../../../base/browser/ui/tree/objectTree.js';
import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { toAction } from '../../../../../base/common/actions.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { WorkbenchCompressibleAsyncDataTree } from '../../../../../platform/list/browser/listService.js';
import { createFileIconThemableTreeContainerScope } from '../../../../../workbench/contrib/files/browser/views/explorerView.js';
import { IAgentStudioService } from '../../common/agentStudio.js';
import { IAgentChatService } from '../../common/agentStudio.js';
import type { Agent } from '../../common/types.js';
import type { AgentSessionMeta } from '../agentChatService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ActionBar, ActionsOrientation } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { URI } from '../../../../../base/common/uri.js';
import { WORKSPACE_DATA_DIR, AGENTS_DIR } from '../../common/constants.js';

// ─── Tree Element Types ──────────────────────────────────────────────────────

export const enum SessionExplorerItemType { AgentGroup, Session }

export interface IAgentGroupElement {
	readonly type: SessionExplorerItemType.AgentGroup;
	readonly employee: Agent;
	readonly sessionCount: number;
}

export interface ISessionElement {
	readonly type: SessionExplorerItemType.Session;
	readonly session: AgentSessionMeta;
	readonly agentId: string;
	readonly employeeName: string;
}

export type SessionExplorerElement = IAgentGroupElement | ISessionElement;

// ─── Tree Delegate ───────────────────────────────────────────────────────────

class SessionExplorerDelegate implements IListVirtualDelegate<SessionExplorerElement> {
	static readonly ITEM_HEIGHT = 22;
	getHeight(): number { return SessionExplorerDelegate.ITEM_HEIGHT; }
	getTemplateId(e: SessionExplorerElement): string {
		return e.type === SessionExplorerItemType.AgentGroup ? AgentGroupRenderer.TEMPLATE_ID : SessionItemRenderer.TEMPLATE_ID;
	}
}

// ─── Agent Group Renderer ────────────────────────────────────────────────────

interface IAgentGroupTemplate {
	label: HTMLSpanElement; count: HTMLSpanElement; actionBar: ActionBar; disposables: DisposableStore;
}

class AgentGroupRenderer implements ICompressibleTreeRenderer<IAgentGroupElement, FuzzyScore, IAgentGroupTemplate> {
	static readonly TEMPLATE_ID = 'sessionExplorer.agentGroup';
	readonly templateId = AgentGroupRenderer.TEMPLATE_ID;
	constructor(private readonly onDeleteAll: (agentId: string) => void) { }

	renderTemplate(container: HTMLElement): IAgentGroupTemplate {
		container.classList.add('session-group');
		const icon = DOM.$('.agent-icon');
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.account));
		container.appendChild(icon);
		const label = document.createElement('span'); label.classList.add('group-label'); container.appendChild(label);
		const count = document.createElement('span'); count.classList.add('group-count'); container.appendChild(count);
		const actionBar = new ActionBar(container, { orientation: ActionsOrientation.HORIZONTAL });
		container.appendChild(actionBar.domNode);
		return { label, count, actionBar, disposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<IAgentGroupElement, FuzzyScore>, _: number, t: IAgentGroupTemplate): void {
		const g = node.element;
		t.label.textContent = g.employee.name;
		t.count.textContent = `${g.sessionCount}`;
		t.disposables.clear(); t.actionBar.clear();
		t.actionBar.push(toAction({
			id: `se.clearAll.${g.employee.id}`, label: localize('clearAgent', "清空"), class: ThemeIcon.asClassName(Codicon.trash),
			run: () => this.onDeleteAll(g.employee.id),
		}), { icon: true, label: false });
	}

	renderCompressedElements(): void { }
	disposeTemplate(t: IAgentGroupTemplate): void { t.disposables.dispose(); t.actionBar.dispose(); }
}

// ─── Session Item Renderer ───────────────────────────────────────────────────

interface ISessionTemplate {
	label: HTMLSpanElement; desc: HTMLSpanElement; actionBar: ActionBar; disposables: DisposableStore;
}

class SessionItemRenderer implements ICompressibleTreeRenderer<ISessionElement, FuzzyScore, ISessionTemplate> {
	static readonly TEMPLATE_ID = 'sessionExplorer.sessionItem';
	readonly templateId = SessionItemRenderer.TEMPLATE_ID;
	constructor(private readonly onDelete: (agentId: string, sessionId: string) => void) { }

	renderTemplate(container: HTMLElement): ISessionTemplate {
		container.classList.add('session-item');
		const label = document.createElement('span'); label.classList.add('session-label'); container.appendChild(label);
		const desc = document.createElement('span'); desc.classList.add('session-description'); container.appendChild(desc);
		const actionBar = new ActionBar(container, { orientation: ActionsOrientation.HORIZONTAL });
		container.appendChild(actionBar.domNode);
		return { label, desc, actionBar, disposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<ISessionElement, FuzzyScore>, _: number, t: ISessionTemplate): void {
		const s = node.element;
		t.label.textContent = s.session.name;
		t.desc.textContent = `${s.session.messageCount} 条消息 · ${fmtTime(s.session.updatedAt)}`;
		t.disposables.clear(); t.actionBar.clear();
		t.actionBar.push(toAction({
			id: `se.delete.${s.session.id}`, label: localize('delete', "删除"), class: ThemeIcon.asClassName(Codicon.close),
			run: () => this.onDelete(s.agentId, s.session.id),
		}), { icon: true, label: false });
	}

	renderCompressedElements(): void { }
	disposeTemplate(t: ISessionTemplate): void { t.disposables.dispose(); t.actionBar.dispose(); }
}

function fmtTime(iso: string): string {
	const d = Date.now() - new Date(iso).getTime(); const m = Math.floor(d / 60000);
	if (m < 1) return '刚刚'; if (m < 60) return `${m} 分钟前`;
	const h = Math.floor(m / 60); if (h < 24) return `${h} 小时前`;
	const day = Math.floor(h / 24); if (day < 30) return `${day} 天前`;
	return new Date(iso).toLocaleDateString();
}

// ─── Data Source ──────────────────────────────────────────────────────────────

class SessionExplorerDataSource implements IAsyncDataSource<null, SessionExplorerElement> {
	constructor(
		private readonly svc: IAgentStudioService,
		private readonly chat: IAgentChatService,
		private readonly getFilterId: () => string | null,
		private readonly logService: ILogService,
	) { }
	hasChildren(e: null | SessionExplorerElement): boolean { return e === null || e.type === SessionExplorerItemType.AgentGroup; }
	async getChildren(e: null | SessionExplorerElement): Promise<SessionExplorerElement[]> {
		const filterId = this.getFilterId();
		if (e === null) {
			const wsId = this.svc.getActiveWorkspaceId();
			const emps = await this.svc.getAgents();
			this.logService.info(`[SessionExplorer] getChildren(root): wsId=${wsId}, agents=${emps.length}, filterId=${filterId ?? '(all)'}`);
			const filtered = filterId ? emps.filter(emp => emp.id === filterId) : emps;
			const out: IAgentGroupElement[] = [];
			for (const emp of filtered) {
				const ss = await (this.chat as any).listAgentSessions(emp.id) as AgentSessionMeta[];
				this.logService.info(`[SessionExplorer] agent ${emp.name}(${emp.id}): ${ss.length} sessions`);
				if (ss.length > 0) out.push({ type: SessionExplorerItemType.AgentGroup, employee: emp, sessionCount: ss.length });
			}
			this.logService.info(`[SessionExplorer] root result: ${out.length} agent groups`);
			return out;
		}
		if (e.type === SessionExplorerItemType.AgentGroup) {
			const ss = await (this.chat as any).listAgentSessions(e.employee.id) as AgentSessionMeta[];
			return ss.map(s => ({ type: SessionExplorerItemType.Session, session: s, agentId: e.employee.id, employeeName: e.employee.name }));
		}
		return [];
	}
}

class SessionExplorerFilter implements ITreeFilter<SessionExplorerElement> { filter() { return TreeVisibility.Visible; } }
class SessionExplorerA11y implements IListAccessibilityProvider<SessionExplorerElement> {
	getWidgetAriaLabel(): string { return localize('seAria', "Sessions"); }
	getAriaLabel(e: SessionExplorerElement): string {
		return e.type === SessionExplorerItemType.AgentGroup
			? `Agent ${e.employee.name} ${e.sessionCount} sessions`
			: `Session ${e.session.name} ${e.session.messageCount} msgs`;
	}
}

// ─── Main ViewPane ───────────────────────────────────────────────────────────

export class SessionExplorerViewPane extends ViewPane {
	private tree!: WorkbenchCompressibleAsyncDataTree<null, SessionExplorerElement, FuzzyScore>;
	private filterEmployeeId: string | null = null;
	private employees: Agent[] = [];
	private seHeaderContainer!: HTMLElement;
	private filterSelect!: HTMLSelectElement;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IAgentStudioService private readonly _studioService: IAgentStudioService,
		@IAgentChatService private readonly _chatService: IAgentChatService,
		@IEditorService private readonly _editorService: IEditorService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._logService.info('[SessionExplorer] renderBody called');
		container.classList.add('session-explorer-view');

		// ─── Header: filter + clear all ─────────────────────────
		this.seHeaderContainer = document.createElement('div');
		this.seHeaderContainer.classList.add('session-explorer-header');

		// Agent filter dropdown
		const filterLabel = document.createElement('label');
		filterLabel.classList.add('session-filter-label');
		filterLabel.textContent = localize('agentFilter', "Agent:");
		this.seHeaderContainer.appendChild(filterLabel);

		this.filterSelect = document.createElement('select');
		this.filterSelect.classList.add('session-filter-select');
		this._register(DOM.addDisposableListener(this.filterSelect, 'change', () => {
			this.filterEmployeeId = this.filterSelect.value || null;
			this.refresh();
		}));
		this.seHeaderContainer.appendChild(this.filterSelect);

		// Clear all button
		const clearAllBtn = document.createElement('button');
		clearAllBtn.classList.add('session-clear-all-btn');
		clearAllBtn.title = localize('clearAllSessions', "一键清空所有会话");
		clearAllBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.trash));
		this._register(DOM.addDisposableListener(clearAllBtn, DOM.EventType.CLICK, () => this._clearAllSessions()));
		this.seHeaderContainer.appendChild(clearAllBtn);

		container.appendChild(this.seHeaderContainer);

		// ─── Tree ────────────────────────────────────────────────
		const treeContainer = DOM.append(container, DOM.$('.session-tree-container'));
		this._register(createFileIconThemableTreeContainerScope(treeContainer, this.themeService));

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchCompressibleAsyncDataTree<null, SessionExplorerElement, FuzzyScore>,
			'SessionExplorer', treeContainer,
			new SessionExplorerDelegate(),
			{ isIncompressible: () => true },
			[new AgentGroupRenderer(id => this._deleteAllSessionsForAgent(id)), new SessionItemRenderer((eid, sid) => this._deleteSession(eid, sid))],
			new SessionExplorerDataSource(this._studioService, this._chatService, () => this.filterEmployeeId, this._logService),
			{
				accessibilityProvider: new SessionExplorerA11y(),
				filter: this.instantiationService.createInstance(SessionExplorerFilter),
				collapseByDefault: (e: SessionExplorerElement) => e.type === SessionExplorerItemType.AgentGroup ? false : false,
				multipleSelectionSupport: false,
				identityProvider: { getId(e: SessionExplorerElement) { return e.type === SessionExplorerItemType.AgentGroup ? e.employee.id : e.session.id; } },
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel(e: SessionExplorerElement) { return e.type === SessionExplorerItemType.AgentGroup ? e.employee.name : e.session.name; },
					getCompressedNodeKeyboardNavigationLabel(e: SessionExplorerElement[]) { return e.map(x => x.type === SessionExplorerItemType.AgentGroup ? x.employee.name : x.session.name).join('/'); },
				},
			},
		));

		this._register(this.tree.onDidOpen(e => { if (e.element?.type === SessionExplorerItemType.Session) this._openSession(e.element); }));
		this._register(this._chatService.onDidChangeAgentSessions(() => this.refresh()));
		this._register(this._studioService.onDidChangeEmployees(() => this.refresh()));
		this._register(this._studioService.onDidChangeActiveWorkspace(() => { this.filterEmployeeId = null; this.refresh(); }));
		this.tree.layout();
		this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		const headerHeight = this.seHeaderContainer?.offsetHeight ?? 0;
		this.tree?.layout(height - headerHeight, width);
	}

	override focus(): void {
		super.focus();
		this.tree?.domFocus();
	}

	private _updateFilterDropdown(): void {
		const sel = this.filterSelect;
		const prev = sel.value;
		DOM.clearNode(sel);
		const allOpt = document.createElement('option');
		allOpt.value = '';
		allOpt.textContent = localize('allAgents', "全部 Agent");
		sel.appendChild(allOpt);
		for (const emp of this.employees) {
			const opt = document.createElement('option');
			opt.value = emp.id;
			opt.textContent = emp.name;
			sel.appendChild(opt);
		}
		sel.value = prev || '';
	}

	private async _openSession(element: ISessionElement): Promise<void> {
		try {
			const wsId = this._studioService.getActiveWorkspaceId();
			if (!wsId) {
				this._notificationService.warn(localize('sessionNoWorkspace', "无法获取工作区路径"));
				return;
			}
			const binding = await this._studioService.getAgentBinding(wsId, element.agentId);
			if (!binding?.agentDir) {
				this._notificationService.warn(localize('sessionNoPath', "无法定位会话文件路径"));
				return;
			}
			const workspace = await this._studioService.getWorkspace(wsId);
			if (!workspace?.path) {
				this._notificationService.warn(localize('sessionNoWorkspace', "无法获取工作区路径"));
				return;
			}
			const sessionFileUri = URI.joinPath(
				URI.file(workspace.path),
				WORKSPACE_DATA_DIR,
				AGENTS_DIR,
				binding.agentDir,
				'sessions',
				`${element.session.id}.json`,
			);
			await this._editorService.openEditor({
				resource: sessionFileUri,
				options: { pinned: true },
			});
		} catch (err) { this._notificationService.error(String(err)); }
	}

	private async _deleteSession(agentId: string, sessionId: string): Promise<void> {
		const c = await this._dialogService.confirm({ message: localize('confirmDel', "确定删除此会话？"), primaryButton: localize('del', "&&删除") });
		if (!c.confirmed) return;
		try { await (this._chatService as any).deleteAgentSession(agentId, sessionId); } catch (e) { this._notificationService.error(String(e)); }
		this.refresh();
	}

	private async _deleteAllSessionsForAgent(agentId: string): Promise<void> {
		const c = await this._dialogService.confirm({ message: localize('confirmClearAgent', "确定清空此 Agent 的所有会话？"), primaryButton: localize('clear', "&&清空") });
		if (!c.confirmed) return;
		try {
			const ss = await (this._chatService as any).listAgentSessions(agentId) as AgentSessionMeta[];
			for (const s of ss) await (this._chatService as any).deleteAgentSession(agentId, s.id);
		} catch (e) { this._notificationService.error(String(e)); }
		this.refresh();
	}

	private async _clearAllSessions(): Promise<void> {
		const c = await this._dialogService.confirm({
			message: localize('confirmClearAll', "确定清空所有会话？"),
			detail: localize('clearAllDetail', "此操作不可恢复。"), primaryButton: localize('clearAll', "&&全部清空"), type: 'warning',
		});
		if (!c.confirmed) return;
		try {
			for (const emp of await this._studioService.getAgents()) {
				const ss = await (this._chatService as any).listAgentSessions(emp.id) as AgentSessionMeta[];
				for (const s of ss) await (this._chatService as any).deleteAgentSession(emp.id, s.id);
			}
		} catch (e) { this._notificationService.error(String(e)); }
		this.refresh();
	}

	private _treeInputSet = false;

	async refresh(): Promise<void> {
		const wsId = this._studioService.getActiveWorkspaceId();
		this.employees = await this._studioService.getAgents();
		this._logService.info(`[SessionExplorer] refresh: wsId=${wsId}, agents=${this.employees.length}`);
		this._updateFilterDropdown();
		if (!this._treeInputSet) {
			await this.tree?.setInput(null);
			this._treeInputSet = true;
		} else {
			await this.tree?.updateChildren();
		}
	}
}
