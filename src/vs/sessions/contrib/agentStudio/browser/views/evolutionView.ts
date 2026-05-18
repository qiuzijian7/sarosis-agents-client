/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Evolution View — 自进化历史列表面板。
 *
 * 在 Activity Bar 中显示一个 🧬 按钮，点击后展开历史进化列表。
 * 点击列表中的某条记录，在编辑器区域打开 HTML 格式的详情页。
 */

import './media/evolutionView.css';

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
import { IEditorService, SIDE_GROUP } from '../../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { $ } from '../../../../../base/browser/dom.js';
import { ISelfEvolutionService, IEvolutionRecord } from '../../common/selfEvolution.js';
import { EvolutionDetailEditorInput } from '../evolutionDetailEditorInput.js';

export class EvolutionViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private headerBadge!: HTMLElement;
	private emptyState!: HTMLElement;
	private records: IEvolutionRecord[] = [];

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
		@ISelfEvolutionService private readonly evolutionService: ISelfEvolutionService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.evolutionService.onDidChangeRecords(() => this._refresh()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('evolution-view');

		// Header with count
		const header = $('div.evolution-header');
		const title = $('h3.evolution-title');
		title.textContent = '🧬 Self-Evolution';
		header.appendChild(title);

		this.headerBadge = $('span.evolution-count');
		header.appendChild(this.headerBadge);
		container.appendChild(header);

		// Action bar
		const actionBar = $('div.evolution-actions');
		const refreshBtn = $('button.evolution-action-btn');
		refreshBtn.textContent = '↻ Refresh';
		refreshBtn.title = 'Reload evolution records';
		refreshBtn.addEventListener('click', () => {
			this.evolutionService.reload().then(() => this._refresh());
		});
		actionBar.appendChild(refreshBtn);
		container.appendChild(actionBar);

		// Empty state
		this.emptyState = $('div.evolution-empty');
		this.emptyState.innerHTML = `
			<div class="empty-icon">🧬</div>
			<div class="empty-text">No evolution records yet</div>
			<div class="empty-hint">Agents will self-evolve as they learn from conversations.</div>
		`;
		container.appendChild(this.emptyState);

		// List container
		this.listContainer = $('div.evolution-list');
		container.appendChild(this.listContainer);

		// Initial load
		setTimeout(() => this._refresh(), 0);
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible) {
			this._refresh();
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			// Available height: total minus header (~40px), actions (~36px), some padding
			this.listContainer.style.height = `${Math.max(0, height - 80)}px`;
		}
	}

	private _refresh(): void {
		this.records = [...this.evolutionService.getRecords()];
		this.headerBadge.textContent = `${this.records.length}`;

		if (this.records.length === 0) {
			this.emptyState.style.display = '';
			this.listContainer.style.display = 'none';
			return;
		}

		this.emptyState.style.display = 'none';
		this.listContainer.style.display = '';

		// Render list items
		this.listContainer.innerHTML = '';
		for (const record of this.records) {
			const item = this._renderRecordItem(record);
			this.listContainer.appendChild(item);
		}
	}

	private _renderRecordItem(record: IEvolutionRecord): HTMLElement {
		const item = $('div.evolution-item');
		item.classList.add(`trigger-${record.trigger}`);

		// Click handler — open detail in editor area
		item.addEventListener('click', () => this._openRecordDetail(record));

		// Top row: emoji + agent name + timestamp
		const topRow = $('div.evolution-item-top');

		const agentLabel = $('span.evolution-agent');
		agentLabel.textContent = `${record.agentEmoji || '🤖'} ${record.agentName}`;
		topRow.appendChild(agentLabel);

		const timeLabel = $('span.evolution-time');
		timeLabel.textContent = this._formatTime(record.timestamp);
		timeLabel.title = record.timestamp;
		topRow.appendChild(timeLabel);
		item.appendChild(topRow);

		// Summary
		const summaryEl = $('div.evolution-item-summary');
		summaryEl.textContent = record.summary;
		item.appendChild(summaryEl);

		// Tags row: trigger + actions
		const tagsRow = $('div.evolution-item-tags');

		const triggerTag = $('span.evolution-tag.trigger');
		triggerTag.textContent = this._formatTrigger(record.trigger);
		tagsRow.appendChild(triggerTag);

		for (const action of record.actions) {
			const actionTag = $('span.evolution-tag.action');
			actionTag.textContent = this._formatAction(action);
			tagsRow.appendChild(actionTag);
		}

		// Stats
		if (record.fileDiffs.length > 0) {
			const fileTag = $('span.evolution-tag.files');
			fileTag.textContent = `📄 ${record.fileDiffs.length} files`;
			tagsRow.appendChild(fileTag);
		}
		if (record.generatedSkills.length > 0) {
			const skillTag = $('span.evolution-tag.skills');
			skillTag.textContent = `💡 ${record.generatedSkills.length} skills`;
			tagsRow.appendChild(skillTag);
		}

		item.appendChild(tagsRow);

		// Workspace label
		const wsLabel = $('div.evolution-item-workspace');
		wsLabel.textContent = `📁 ${record.workspaceName}`;
		item.appendChild(wsLabel);

		return item;
	}

	private _openRecordDetail(record: IEvolutionRecord): void {
		const input = EvolutionDetailEditorInput.getOrCreate(record);
		const groups = this.editorGroupsService.getGroups(0 /* GroupsOrder.CREATION_TIME */);
		if (groups.length <= 1) {
			this.editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
		} else {
			this.editorService.openEditor(input, { pinned: true }, groups[0]);
		}
	}

	private _formatTime(iso: string): string {
		try {
			const d = new Date(iso);
			const now = new Date();
			const diffMs = now.getTime() - d.getTime();
			const diffMins = Math.floor(diffMs / 60000);
			const diffHours = Math.floor(diffMs / 3600000);
			const diffDays = Math.floor(diffMs / 86400000);

			if (diffMins < 1) { return 'just now'; }
			if (diffMins < 60) { return `${diffMins}m ago`; }
			if (diffHours < 24) { return `${diffHours}h ago`; }
			if (diffDays < 7) { return `${diffDays}d ago`; }
			return d.toLocaleDateString();
		} catch {
			return iso;
		}
	}

	private _formatTrigger(trigger: string): string {
		const map: Record<string, string> = {
			nudge_memory: '🧠 Memory',
			nudge_skill: '⚡ Skill',
			nudge_combined: '🔄 Combined',
			curator: '📋 Curator',
			manual: '👤 Manual',
		};
		return map[trigger] || trigger;
	}

	private _formatAction(action: string): string {
		const map: Record<string, string> = {
			skill_created: '✨ Skill Created',
			skill_updated: '📝 Skill Updated',
			skill_merged: '🔗 Skill Merged',
			skill_archived: '📦 Archived',
			memory_updated: '🧠 Memory Updated',
			config_updated: '⚙️ Config Updated',
			file_modified: '📄 File Modified',
		};
		return map[action] || action;
	}
}
