/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import * as DOM from '../../../../base/browser/dom.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';
import type { IWorkflow, IWorkflowStep } from '../common/crewTeam.js';

const STEP_TYPE_LABELS: Record<string, string> = {
	task: 'Task',
	condition: 'Condition',
	parallel: 'Parallel',
	loop: 'Loop',
};

const STEP_TYPE_ICONS: Record<string, string> = {
	task: '📋',
	condition: '🔀',
	parallel: '⇉',
	loop: '🔄',
};

/**
 * WorkflowEditorPane — renders a workflow's details (name, description,
 * step list) as native DOM inside the editor area.
 *
 * This is a lightweight editor pane (no webview) that shows a read-only
 * view of the workflow definition.
 */
export class WorkflowEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.workflowPane';

	private _container: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(WorkflowEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = DOM.$('div.workflow-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflow = 'auto';
		this._container.style.padding = '20px';
		this._container.style.background = 'var(--vscode-editor-background)';
		this._container.style.color = 'var(--vscode-foreground)';
		this._container.style.fontSize = '13px';
		this._container.style.lineHeight = '1.6';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		_options: IEditorOptions | undefined,
		_context: IEditorOpenContext,
		_token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, _options, _context, _token);

		if (!(input instanceof WorkflowEditorInput) || !this._container) {
			return;
		}

		const wf = input.workflow;
		this._render(wf);
	}

	private _render(wf: IWorkflow): void {
		if (!this._container) { return; }
		this._container.innerHTML = '';

		// ─── Header ───────────────────────────────────────────────
		const header = DOM.$('div.workflow-editor-header');
		header.style.marginBottom = '20px';
		header.style.paddingBottom = '16px';
		header.style.borderBottom = '1px solid var(--vscode-panel-border)';

		const title = DOM.$('h1.workflow-editor-title');
		title.textContent = wf.name;
		title.style.margin = '0 0 8px 0';
		title.style.fontSize = '22px';
		title.style.fontWeight = '600';
		header.appendChild(title);

		if (wf.description) {
			const desc = DOM.$('p.workflow-editor-description');
			desc.textContent = wf.description;
			desc.style.margin = '0';
			desc.style.color = 'var(--vscode-descriptionForeground)';
			desc.style.fontSize = '14px';
			header.appendChild(desc);
		}

		const meta = DOM.$('div.workflow-editor-meta');
		meta.style.marginTop = '12px';
		meta.style.fontSize = '11px';
		meta.style.color = 'var(--vscode-descriptionForeground)';
		meta.style.display = 'flex';
		meta.style.gap = '16px';

		const statusBadge = DOM.$('span');
		statusBadge.textContent = wf.isActive ? 'Active' : 'Inactive';
		statusBadge.style.padding = '2px 8px';
		statusBadge.style.borderRadius = '10px';
		statusBadge.style.background = wf.isActive
			? 'var(--vscode-testing-iconPassed)'
			: 'var(--vscode-badge-background)';
		statusBadge.style.color = wf.isActive
			? 'var(--vscode-editor-background)'
			: 'var(--vscode-badge-foreground)';
		statusBadge.style.fontWeight = '600';
		meta.appendChild(statusBadge);

		const stepCount = DOM.$('span');
		stepCount.textContent = `${wf.steps?.length ?? 0} steps`;
		meta.appendChild(stepCount);

		const createdAt = DOM.$('span');
		createdAt.textContent = `Created: ${new Date(wf.createdAt).toLocaleDateString()}`;
		meta.appendChild(createdAt);

		header.appendChild(meta);
		this._container.appendChild(header);

		// ─── Steps ────────────────────────────────────────────────
		const stepsSection = DOM.$('div.workflow-editor-steps');
		const stepsTitle = DOM.$('h2');
		stepsTitle.textContent = 'Steps';
		stepsTitle.style.fontSize = '16px';
		stepsTitle.style.fontWeight = '600';
		stepsTitle.style.marginBottom = '12px';
		stepsSection.appendChild(stepsTitle);

		if (wf.steps && wf.steps.length > 0) {
			for (let i = 0; i < wf.steps.length; i++) {
				const step = wf.steps[i];
				stepsSection.appendChild(this._renderStep(step, i));
			}
		} else {
			const empty = DOM.$('div');
			empty.textContent = 'No steps defined.';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			empty.style.fontStyle = 'italic';
			stepsSection.appendChild(empty);
		}

		this._container.appendChild(stepsSection);
	}

	private _renderStep(step: IWorkflowStep, index: number): HTMLElement {
		const card = DOM.$('div.workflow-step-card');
		card.style.background = 'var(--vscode-textBlockQuote-background)';
		card.style.border = '1px solid var(--vscode-panel-border)';
		card.style.borderRadius = '6px';
		card.style.padding = '12px 16px';
		card.style.marginBottom = '8px';

		// Step header: index + icon + type + name
		const stepHeader = DOM.$('div');
		stepHeader.style.display = 'flex';
		stepHeader.style.alignItems = 'center';
		stepHeader.style.gap = '8px';
		stepHeader.style.marginBottom = '4px';

		const stepIndex = DOM.$('span');
		stepIndex.textContent = `${index + 1}.`;
		stepIndex.style.fontWeight = '600';
		stepIndex.style.color = 'var(--vscode-textLink-foreground)';
		stepIndex.style.minWidth = '20px';
		stepHeader.appendChild(stepIndex);

		const icon = DOM.$('span');
		icon.textContent = STEP_TYPE_ICONS[step.type] ?? '📌';
		stepHeader.appendChild(icon);

		const typeBadge = DOM.$('span');
		typeBadge.textContent = STEP_TYPE_LABELS[step.type] ?? step.type;
		typeBadge.style.fontSize = '10px';
		typeBadge.style.fontWeight = '600';
		typeBadge.style.textTransform = 'uppercase';
		typeBadge.style.padding = '1px 6px';
		typeBadge.style.borderRadius = '3px';
		typeBadge.style.background = 'var(--vscode-badge-background)';
		typeBadge.style.color = 'var(--vscode-badge-foreground)';
		stepHeader.appendChild(typeBadge);

		const nameEl = DOM.$('span');
		nameEl.textContent = step.name;
		nameEl.style.fontWeight = '600';
		stepHeader.appendChild(nameEl);

		card.appendChild(stepHeader);

		// Step details
		const details = DOM.$('div');
		details.style.marginLeft = '28px';
		details.style.fontSize = '12px';
		details.style.color = 'var(--vscode-descriptionForeground)';

		if (step.executorId) {
			const exec = DOM.$('div');
			exec.textContent = `Executor: ${step.executorId}`;
			details.appendChild(exec);
		}
		if (step.taskId) {
			const tid = DOM.$('div');
			tid.textContent = `Task: ${step.taskId}`;
			details.appendChild(tid);
		}
		if (step.type === 'condition' && step.condition) {
			const cond = DOM.$('div');
			cond.textContent = `Condition: ${step.condition}`;
			cond.style.fontFamily = 'var(--vscode-editor-font-family)';
			cond.style.fontSize = '11px';
			cond.style.background = 'var(--vscode-textCodeBlock-background)';
			cond.style.padding = '2px 6px';
			cond.style.borderRadius = '3px';
			cond.style.marginTop = '2px';
			details.appendChild(cond);
		}
		if (step.type === 'parallel' && step.parallelSteps) {
			const ps = DOM.$('div');
			ps.textContent = `Parallel steps: ${step.parallelSteps.join(', ')}`;
			details.appendChild(ps);
		}
		if (step.type === 'loop' && step.loopConfig) {
			const lc = DOM.$('div');
			lc.textContent = `Loop over: ${step.loopConfig.items} (as ${step.loopConfig.itemVariable})`;
			details.appendChild(lc);
		}
		if (step.nextStepId) {
			const next = DOM.$('div');
			next.textContent = `Next step: ${step.nextStepId}`;
			details.appendChild(next);
		}

		card.appendChild(details);
		return card;
	}

	override layout(_dimension: DOM.Dimension): void {
		// No special layout needed — container fills via CSS
	}
}
