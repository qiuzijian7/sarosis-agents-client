/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
import { $ } from '../../../../../base/browser/dom.js';

interface FileChange {
	path: string;
	status: 'modified' | 'added' | 'deleted' | 'renamed';
	additions: number;
	deletions: number;
	agent?: string;
}

/**
 * Changes View - 变更管理面板
 * 功能：查看Agent产生的代码变更、文件diff、提交历史、撤回操作
 */
export class ChangesViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private changes: FileChange[] = [];

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('changes-view');

		// Header
		const header = $('div.changes-header');
		const title = $('h3.changes-title');
		title.textContent = '📝 Changes';
		header.appendChild(title);

		const actions = $('div.changes-header-actions');
		const commitBtn = $('button.changes-action-btn.primary');
		commitBtn.textContent = '✓ Commit All';
		commitBtn.onclick = () => this._commitAll();
		actions.appendChild(commitBtn);

		const revertBtn = $('button.changes-action-btn');
		revertBtn.textContent = '↩ Revert All';
		revertBtn.onclick = () => this._revertAll();
		actions.appendChild(revertBtn);

		const refreshBtn = $('button.changes-action-btn');
		refreshBtn.textContent = '↻';
		refreshBtn.onclick = () => this._refreshChanges();
		actions.appendChild(refreshBtn);
		header.appendChild(actions);
		container.appendChild(header);

		// Summary
		const summary = $('div.changes-summary');
		this._updateSummary(summary);
		container.appendChild(summary);

		// Changes list
		this.listContainer = $('div.changes-list');
		this._renderChanges();
		container.appendChild(this.listContainer);
	}

	private _updateSummary(summary: HTMLElement): void {
		const modified = this.changes.filter(c => c.status === 'modified').length;
		const added = this.changes.filter(c => c.status === 'added').length;
		const deleted = this.changes.filter(c => c.status === 'deleted').length;
		const totalAdditions = this.changes.reduce((sum, c) => sum + c.additions, 0);
		const totalDeletions = this.changes.reduce((sum, c) => sum + c.deletions, 0);

		summary.innerHTML = `
			<div class="summary-stats">
				<span class="stat modified">M ${modified}</span>
				<span class="stat added">A ${added}</span>
				<span class="stat deleted">D ${deleted}</span>
			</div>
			<div class="summary-diff">
				<span class="additions">+${totalAdditions}</span>
				<span class="deletions">-${totalDeletions}</span>
			</div>
		`;
	}

	private _renderChanges(): void {
		this.listContainer.innerHTML = '';

		if (this.changes.length === 0) {
			const empty = $('div.changes-empty');
			empty.innerHTML = `
				<div class="empty-icon">✨</div>
				<p>No pending changes</p>
				<p class="empty-hint">Agent-produced changes will appear here for review</p>
			`;
			this.listContainer.appendChild(empty);
			return;
		}

		// Group by agent
		const byAgent = new Map<string, FileChange[]>();
		for (const change of this.changes) {
			const agent = change.agent || 'Unknown Agent';
			if (!byAgent.has(agent)) {
				byAgent.set(agent, []);
			}
			byAgent.get(agent)!.push(change);
		}

		for (const [agent, agentChanges] of byAgent) {
			const group = $('div.changes-group');

			const groupHeader = $('div.changes-group-header');
			groupHeader.textContent = `🤖 ${agent} (${agentChanges.length} files)`;
			group.appendChild(groupHeader);

			for (const change of agentChanges) {
				const item = $('div.change-item');
				item.classList.add(`change-${change.status}`);

				const statusIcon = $('span.change-status');
				statusIcon.textContent = this._getStatusIcon(change.status);
				statusIcon.title = change.status;
				item.appendChild(statusIcon);

				const pathEl = $('span.change-path');
				pathEl.textContent = change.path;
				item.appendChild(pathEl);

				const diffEl = $('span.change-diff');
				diffEl.innerHTML = `<span class="add">+${change.additions}</span> <span class="del">-${change.deletions}</span>`;
				item.appendChild(diffEl);

				const itemActions = $('div.change-actions');
				const viewBtn = $('button.change-action');
				viewBtn.textContent = '👁';
				viewBtn.title = 'View diff';
				viewBtn.onclick = () => this._viewDiff(change);
				itemActions.appendChild(viewBtn);

				const revertBtn = $('button.change-action');
				revertBtn.textContent = '↩';
				revertBtn.title = 'Revert file';
				revertBtn.onclick = () => this._revertFile(change);
				itemActions.appendChild(revertBtn);
				item.appendChild(itemActions);

				group.appendChild(item);
			}

			this.listContainer.appendChild(group);
		}
	}

	private _getStatusIcon(status: string): string {
		switch (status) {
			case 'modified': return 'M';
			case 'added': return 'A';
			case 'deleted': return 'D';
			case 'renamed': return 'R';
			default: return '?';
		}
	}

	private _commitAll(): void {
		// TODO: Implement commit
	}

	private _revertAll(): void {
		this.changes = [];
		this._renderChanges();
	}

	private _refreshChanges(): void {
		// TODO: Refresh from git status
	}

	private _viewDiff(_change: FileChange): void {
		// TODO: Open diff editor
	}

	private _revertFile(change: FileChange): void {
		this.changes = this.changes.filter(c => c.path !== change.path);
		this._renderChanges();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			this.listContainer.style.height = `${height - 90}px`;
		}
	}
}
