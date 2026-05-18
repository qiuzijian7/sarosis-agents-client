/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/evolutionDetailEditorPane.css';

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { EvolutionDetailEditorInput } from './evolutionDetailEditorInput.js';
import { IEvolutionRecord, IFileDiff, IGeneratedSkill } from '../common/selfEvolution.js';
import * as DOM from '../../../../base/browser/dom.js';

const { $: $$ } = DOM;

/**
 * Evolution Detail EditorPane — 在编辑器区域以 HTML 格式渲染进化详情。
 *
 * 展示信息：
 * - 哪个 Workspace 的 Agent
 * - 基于什么信息 (上下文摘要)
 * - 更新了哪些文件 (差异信息)
 * - 生成了什么 Skill
 * - 存储在什么位置
 */
export class EvolutionDetailEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.evolutionDetail';

	private _container: HTMLElement | undefined;
	private _record: IEvolutionRecord | undefined;
	private _initialized = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(EvolutionDetailEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('evolution-detail-editor');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflow = 'hidden';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		try {
			await super.setInput(input, options, context, token);

			if (!(input instanceof EvolutionDetailEditorInput)) {
				return;
			}

			this._record = (input as EvolutionDetailEditorInput).record;

			if (this._container && !this._initialized) {
				this._buildUI(this._container);
				this._initialized = true;
			} else if (this._container && this._initialized) {
				this._initialized = false;
				this._container.replaceChildren();
				this._buildUI(this._container);
				this._initialized = true;
			}
		} catch (err) {
			console.error('[EvolutionDetailEditorPane] setInput failed:', err);
			if (this._container) {
				this._container.textContent = `Error loading evolution detail: ${err}`;
			}
		}
	}

	private _buildUI(container: HTMLElement): void {
		if (!this._record) {
			container.textContent = 'No evolution record selected.';
			return;
		}

		const record = this._record;

		// Scrollable container
		const scrollContainer = $$('div.evolution-detail-scroll');
		container.appendChild(scrollContainer);

		// ─── Header ──────────────────────────────────────────
		this._renderHeader(scrollContainer, record);

		// ─── Separator ───────────────────────────────────────
		scrollContainer.appendChild($$('div.evolution-detail-separator'));

		// ─── Context Summary (基于什么信息) ──────────────────
		this._renderContextSection(scrollContainer, record);

		// ─── File Changes (差异信息) ─────────────────────────
		if (record.fileDiffs.length > 0) {
			this._renderFileDiffsSection(scrollContainer, record);
		}

		// ─── Generated Skills ────────────────────────────────
		if (record.generatedSkills.length > 0) {
			this._renderSkillsSection(scrollContainer, record);
		}

		// ─── Metadata ────────────────────────────────────────
		this._renderMetadataSection(scrollContainer, record);
	}

	// --- Header ---

	private _renderHeader(parent: HTMLElement, record: IEvolutionRecord): void {
		const header = $$('div.evolution-detail-header');

		const headerLeft = $$('div.evolution-detail-header-left');

		// Agent icon
		const iconContainer = $$('div.evolution-detail-icon');
		iconContainer.textContent = record.agentEmoji || '🧬';
		headerLeft.appendChild(iconContainer);

		// Title info
		const titleInfo = $$('div.evolution-detail-title-info');

		const nameEl = $$('h1.evolution-detail-name');
		nameEl.textContent = `${record.agentName} — Self Evolution`;
		titleInfo.appendChild(nameEl);

		const wsEl = $$('p.evolution-detail-workspace');
		wsEl.textContent = `📁 ${record.workspaceName} • ${record.workspaceId || 'local'}`;
		titleInfo.appendChild(wsEl);

		// Badges
		const badges = $$('div.evolution-detail-badges');

		const triggerBadge = $$('span.evolution-detail-badge.trigger');
		triggerBadge.textContent = this._formatTrigger(record.trigger);
		badges.appendChild(triggerBadge);

		for (const action of record.actions) {
			const actionBadge = $$('span.evolution-detail-badge.action');
			actionBadge.textContent = this._formatAction(action);
			badges.appendChild(actionBadge);
		}

		if (record.durationMs !== undefined) {
			const durationBadge = $$('span.evolution-detail-badge.duration');
			durationBadge.textContent = `⏱ ${(record.durationMs / 1000).toFixed(1)}s`;
			badges.appendChild(durationBadge);
		}

		if (record.tokensUsed !== undefined) {
			const tokenBadge = $$('span.evolution-detail-badge.tokens');
			tokenBadge.textContent = `📊 ${record.tokensUsed} tokens`;
			badges.appendChild(tokenBadge);
		}

		titleInfo.appendChild(badges);
		headerLeft.appendChild(titleInfo);
		header.appendChild(headerLeft);

		// Timestamp
		const headerRight = $$('div.evolution-detail-header-right');
		const timeEl = $$('span.evolution-detail-time');
		timeEl.textContent = this._formatFullTime(record.timestamp);
		headerRight.appendChild(timeEl);
		header.appendChild(headerRight);

		parent.appendChild(header);
	}

	// --- Context Section ---

	private _renderContextSection(parent: HTMLElement, record: IEvolutionRecord): void {
		const section = $$('div.evolution-detail-section');

		const title = $$('h2.evolution-detail-section-title');
		title.textContent = '📋 Evolution Context';
		section.appendChild(title);

		const contextBox = $$('div.evolution-detail-context-box');

		const summaryLabel = $$('div.evolution-detail-label');
		summaryLabel.textContent = 'What triggered this evolution:';
		contextBox.appendChild(summaryLabel);

		const summaryContent = $$('div.evolution-detail-context-content');
		summaryContent.textContent = record.contextSummary;
		contextBox.appendChild(summaryContent);

		if (record.detail) {
			const detailLabel = $$('div.evolution-detail-label');
			detailLabel.textContent = 'Detailed analysis:';
			contextBox.appendChild(detailLabel);

			const detailContent = $$('div.evolution-detail-context-detail');
			detailContent.textContent = record.detail;
			contextBox.appendChild(detailContent);
		}

		// Summary
		const summaryRow = $$('div.evolution-detail-summary-row');
		const summaryIcon = $$('span.evolution-detail-summary-icon');
		summaryIcon.textContent = '💡';
		summaryRow.appendChild(summaryIcon);
		const summaryText = $$('span.evolution-detail-summary-text');
		summaryText.textContent = record.summary;
		summaryRow.appendChild(summaryText);
		contextBox.appendChild(summaryRow);

		section.appendChild(contextBox);
		parent.appendChild(section);
	}

	// --- File Diffs Section ---

	private _renderFileDiffsSection(parent: HTMLElement, record: IEvolutionRecord): void {
		const section = $$('div.evolution-detail-section');

		const title = $$('h2.evolution-detail-section-title');
		title.textContent = `📄 File Changes (${record.fileDiffs.length})`;
		section.appendChild(title);

		for (const diff of record.fileDiffs) {
			section.appendChild(this._renderFileDiff(diff));
		}

		parent.appendChild(section);
	}

	private _renderFileDiff(diff: IFileDiff): HTMLElement {
		const card = $$('div.evolution-detail-diff-card');

		// Header: icon + path + change type badge
		const header = $$('div.evolution-detail-diff-header');

		const icon = $$('span.evolution-detail-diff-icon');
		icon.textContent = diff.changeType === 'created' ? '🆕' : diff.changeType === 'deleted' ? '🗑️' : '✏️';
		header.appendChild(icon);

		const pathEl = $$('span.evolution-detail-diff-path');
		pathEl.textContent = diff.filePath;
		pathEl.title = diff.fileUri?.toString() || diff.filePath;
		header.appendChild(pathEl);

		const typeBadge = $$('span.evolution-detail-diff-type');
		typeBadge.textContent = diff.changeType;
		typeBadge.classList.add(diff.changeType);
		header.appendChild(typeBadge);

		card.appendChild(header);

		// Stats line
		if (diff.linesAdded !== undefined || diff.linesRemoved !== undefined) {
			const stats = $$('div.evolution-detail-diff-stats');
			if (diff.linesAdded) {
				const added = $$('span.evolution-detail-diff-added');
				added.textContent = `+${diff.linesAdded}`;
				stats.appendChild(added);
			}
			if (diff.linesRemoved) {
				const removed = $$('span.evolution-detail-diff-removed');
				removed.textContent = `-${diff.linesRemoved}`;
				stats.appendChild(removed);
			}
			card.appendChild(stats);
		}

		// Before/After content (collapsible diff view)
		if (diff.before || diff.after) {
			const diffView = $$('div.evolution-detail-diff-content');

			if (diff.before) {
				const beforeBlock = $$('div.evolution-detail-diff-block.before');
				const beforeLabel = $$('div.evolution-detail-diff-block-label');
				beforeLabel.textContent = 'Before';
				beforeBlock.appendChild(beforeLabel);
				const beforeCode = $$('pre.evolution-detail-diff-code');
				const beforeCodeEl = document.createElement('code');
				beforeCodeEl.textContent = diff.before;
				beforeCode.appendChild(beforeCodeEl);
				beforeBlock.appendChild(beforeCode);
				diffView.appendChild(beforeBlock);
			}

			if (diff.after) {
				const afterBlock = $$('div.evolution-detail-diff-block.after');
				const afterLabel = $$('div.evolution-detail-diff-block-label');
				afterLabel.textContent = 'After';
				afterBlock.appendChild(afterLabel);
				const afterCode = $$('pre.evolution-detail-diff-code');
				const afterCodeEl = document.createElement('code');
				afterCodeEl.textContent = diff.after;
				afterCode.appendChild(afterCodeEl);
				afterBlock.appendChild(afterCode);
				diffView.appendChild(afterBlock);
			}

			card.appendChild(diffView);
		}

		return card;
	}

	// --- Skills Section ---

	private _renderSkillsSection(parent: HTMLElement, record: IEvolutionRecord): void {
		const section = $$('div.evolution-detail-section');

		const title = $$('h2.evolution-detail-section-title');
		title.textContent = `💡 Generated Skills (${record.generatedSkills.length})`;
		section.appendChild(title);

		for (const skill of record.generatedSkills) {
			section.appendChild(this._renderSkillCard(skill));
		}

		parent.appendChild(section);
	}

	private _renderSkillCard(skill: IGeneratedSkill): HTMLElement {
		const card = $$('div.evolution-detail-skill-card');

		// Header: action badge + name
		const header = $$('div.evolution-detail-skill-header');

		const actionIcon = $$('span.evolution-detail-skill-action');
		const actionIcons: Record<string, string> = {
			created: '✨',
			updated: '📝',
			merged: '🔗',
			archived: '📦',
		};
		actionIcon.textContent = actionIcons[skill.action] || '🔧';
		header.appendChild(actionIcon);

		const nameEl = $$('span.evolution-detail-skill-name');
		nameEl.textContent = skill.skillName;
		header.appendChild(nameEl);

		const actionBadge = $$('span.evolution-detail-skill-action-badge');
		actionBadge.textContent = skill.action;
		actionBadge.classList.add(skill.action);
		header.appendChild(actionBadge);

		card.appendChild(header);

		// Info grid
		const infoGrid = $$('div.evolution-detail-skill-info');

		// Skill ID
		const idRow = $$('div.evolution-detail-info-row');
		const idLabel = $$('span.evolution-detail-info-label');
		idLabel.textContent = 'ID';
		idRow.appendChild(idLabel);
		const idValue = $$('span.evolution-detail-info-value');
		idValue.textContent = skill.skillId;
		idRow.appendChild(idValue);
		infoGrid.appendChild(idRow);

		// Storage path
		const pathRow = $$('div.evolution-detail-info-row');
		const pathLabel = $$('span.evolution-detail-info-label');
		pathLabel.textContent = 'Storage';
		pathRow.appendChild(pathLabel);
		const pathValue = $$('span.evolution-detail-info-value');
		pathValue.textContent = skill.storagePath;
		pathValue.title = skill.storageUri?.toString() || skill.storagePath;
		pathRow.appendChild(pathValue);
		infoGrid.appendChild(pathRow);

		// Provenance
		const provRow = $$('div.evolution-detail-info-row');
		const provLabel = $$('span.evolution-detail-info-label');
		provLabel.textContent = 'Provenance';
		provRow.appendChild(provLabel);
		const provValue = $$('span.evolution-detail-info-value');
		const provMap: Record<string, string> = {
			foreground: '👤 User (foreground)',
			background_review: '🤖 Agent (background review)',
			curator: '📋 Curator (automated)',
		};
		provValue.textContent = provMap[skill.provenance] || skill.provenance;
		provRow.appendChild(provValue);
		infoGrid.appendChild(provRow);

		card.appendChild(infoGrid);

		return card;
	}

	// --- Metadata Section ---

	private _renderMetadataSection(parent: HTMLElement, record: IEvolutionRecord): void {
		const section = $$('div.evolution-detail-section');

		const title = $$('h2.evolution-detail-section-title');
		title.textContent = 'ℹ️ Metadata';
		section.appendChild(title);

		const infoGrid = $$('div.evolution-detail-info-grid');

		const fields: Array<[string, string]> = [
			['Record ID', record.id],
			['Timestamp', this._formatFullTime(record.timestamp)],
			['Agent ID', record.agentId],
			['Agent Name', `${record.agentEmoji || '🤖'} ${record.agentName}`],
			['Workspace', record.workspaceName],
			['Workspace ID', record.workspaceId || '—'],
			['Trigger', this._formatTrigger(record.trigger)],
			['Actions', record.actions.map(a => this._formatAction(a)).join(', ')],
			['Files Changed', `${record.fileDiffs.length}`],
			['Skills Generated', `${record.generatedSkills.length}`],
		];

		if (record.durationMs !== undefined) {
			fields.push(['Duration', `${(record.durationMs / 1000).toFixed(1)}s`]);
		}
		if (record.tokensUsed !== undefined) {
			fields.push(['Tokens Used', `${record.tokensUsed}`]);
		}

		for (const [label, value] of fields) {
			const row = $$('div.evolution-detail-info-row');
			const labelEl = $$('span.evolution-detail-info-label');
			labelEl.textContent = label;
			row.appendChild(labelEl);
			const valueEl = $$('span.evolution-detail-info-value');
			valueEl.textContent = value;
			row.appendChild(valueEl);
			infoGrid.appendChild(row);
		}

		section.appendChild(infoGrid);
		parent.appendChild(section);
	}

	// --- Helpers ---

	private _formatTrigger(trigger: string): string {
		const map: Record<string, string> = {
			nudge_memory: '🧠 Memory Nudge',
			nudge_skill: '⚡ Skill Nudge',
			nudge_combined: '🔄 Combined Nudge',
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

	private _formatFullTime(iso: string): string {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	override dispose(): void {
		super.dispose();
	}
}
