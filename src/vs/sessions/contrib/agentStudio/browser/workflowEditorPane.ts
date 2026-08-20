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
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';
import { AgentStudioWebviewController } from './agentStudioWebviewController.js';
import { IWorkflowStorageService } from '../common/workflowStorage.js';
import { WorkflowVersionPanel } from './workflowVersionPanel.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';

/**
 * WorkflowEditorPane — WebView-based workflow editor using ReactFlow.
 *
 * Replaces the old DOM-based renderer. Uses AgentStudioWebviewController
 * with panelType 'workflow-editor' to reuse the existing webview infrastructure.
 * Workflow data is passed via `initialData` and injected as
 * `window.__AGENT_STUDIO_INITIAL_DATA__` into the webview.
 */
export class WorkflowEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.workflowPane';

	private _container: HTMLElement | undefined;
	private _webviewController: AgentStudioWebviewController | undefined;
	private _currentWorkflowId: string | undefined;
	/** v2 单行工具栏：webviewController 的宿主侧动作订阅（版本历史 / 删除） */
	private _toolbarDisposables = new DisposableStore();
	private _versionPanel: WorkflowVersionPanel | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkflowStorageService private readonly workflowStorageService: IWorkflowStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(WorkflowEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = DOM.$('div.workflow-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		this._container.style.overflow = 'hidden';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		_options: IEditorOptions | undefined,
		_context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, _options, _context, token);

		// ── DIAGNOSTIC LOG ──
		console.log('[WorkflowEditorPane.setInput] CALLED', {
			isWorkflowInput: input instanceof WorkflowEditorInput,
			hasContainer: !!this._container,
			inputType: input.constructor.name,
			tokenCancelled: token.isCancellationRequested,
		});

		if (!(input instanceof WorkflowEditorInput) || !this._container) {
			console.warn('[WorkflowEditorPane.setInput] EARLY RETURN — not WorkflowEditorInput or no container');
			return;
		}

		if (token.isCancellationRequested) {
			console.warn('[WorkflowEditorPane.setInput] EARLY RETURN — token cancelled');
			return;
		}

		const workflowId = input.workflow.id;

		// If the same workflow tab is being reactivated, keep the webview alive.
		// Otherwise (first open or different workflow), recreate the webview.
		if (this._webviewController && this._currentWorkflowId === workflowId) {
			// Same tab reactivation — the webview already has the latest state
			console.log('[WorkflowEditorPane.setInput] REUSING existing webview for workflowId=', workflowId);
			return;
		}

		console.log(`[WorkflowEditorPane.setInput] CREATING new webview for workflowId=${workflowId}, name=${input.workflow.name}, nodes=${input.workflow.nodes?.length ?? 0}`);
		console.log(`[WorkflowEditorPane.setInput] About to create AgentStudioWebviewController with panelType='workflow-editor', initialData=`, { type: 'workflow', workflowId: workflowId });

		// Different workflow or first open — dispose old and create new
		this._disposeWebview();
		this._toolbarDisposables.clear();

		this._currentWorkflowId = workflowId;

		// Read the latest workflow data from disk (may have been saved since the
		// WorkflowEditorInput was created)
		let workflowData = input.workflow;
		try {
			const fresh = await this.workflowStorageService.getWorkflow(workflowId);
			if (fresh) {
				workflowData = fresh;
				// Keep the EditorInput in sync
				input.updateWorkflowData(fresh);
			}
		} catch {
			// Fall back to the input's snapshot
		}

		// ── 横向分割布局：webview（左）+ 版本面板（右）──
		// v2 单行工具栏：原生 WorkflowToolbar 顶栏已移除——发布状态/上传/升级/
		// 版本历史/删除全部并入 webview 内的单行工具栏（经 RPC 触发，见
		// agentStudioWebviewController 的 workflow.publishState/publish/versionHistory/deleteWorkflow）。
		const splitContainer = DOM.$('div.workflow-split');
		splitContainer.style.display = 'flex';
		splitContainer.style.flex = '1';
		splitContainer.style.overflow = 'hidden';
		this._container.appendChild(splitContainer);

		// 工具栏下方的 webview 容器（左侧主区域）
		const webviewContainer = DOM.$('div.workflow-webview-container');
		webviewContainer.style.flex = '1';
		webviewContainer.style.overflow = 'hidden';
		splitContainer.appendChild(webviewContainer);

		// 版本历史侧边面板（右侧）
		this._disposeVersionPanel();
		const panel = this.instantiationService.createInstance(
			WorkflowVersionPanel,
			workflowId,
		);
		this._versionPanel = panel;
		this._register(panel);
		splitContainer.appendChild(panel.element);

		this._webviewController = this.instantiationService.createInstance(
			AgentStudioWebviewController,
			webviewContainer,
			'workflow-editor' as const,
			// Pass the workflow data as initialData — injected as __AGENT_STUDIO_INITIAL_DATA__
			{ type: 'workflow', workflow: workflowData },
		);
		// v2 单行工具栏：webview 内「发布 ▾」菜单的宿主侧动作（原 WorkflowToolbar 订阅迁移）
		this._toolbarDisposables.add(this._webviewController.onDidRequestWorkflowVersionHistory(() => {
			this._versionPanel?.toggle();
		}));
		this._toolbarDisposables.add(this._webviewController.onDidRequestWorkflowDeleteWorkflow(async ({ workflowId }) => {
			try {
				const wf = await this.workflowStorageService.getWorkflow(workflowId);
				await this.workflowStorageService.deleteWorkflow(workflowId);
				this.notificationService.info(`已删除工作流 "${wf?.name ?? workflowId}"`);
			} catch (err) {
				this.notificationService.error(
					`删除工作流失败: ${err instanceof Error ? err.message : String(err)}`
				);
				return;
			}
			if (this.input) {
				this.editorService.closeEditor({ editor: this.input, groupId: this.group.id });
			}
		}));
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
		this._webviewController?.layout(dimension.width, dimension.height);
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible && this._webviewController && this._container) {
			// Tab switch causes the panel container to be hidden/removed from DOM,
			// which zeros out getBoundingClientRect(). The ResizeObserver in the
			// pool hot path won't fire when the pane re-appears with the same CSS
			// dimensions as before — so we force a layout sync.
			// Also gives the webview a kick for the cold path (retainContextWhenHidden
			// keeps the iframe alive but may leave it at stale dimensions).
			const rect = this._container.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				this._webviewController.layout(rect.width, rect.height);
			}
		}
	}

	private _disposeWebview(): void {
		this._toolbarDisposables.clear();
		this._disposeVersionPanel();
		if (this._webviewController) {
			this._webviewController.dispose();
			this._webviewController = undefined;
		}
		if (this._container) {
			DOM.clearNode(this._container);
		}
	}

	private _disposeVersionPanel(): void {
		if (this._versionPanel) {
			this._versionPanel.dispose();
			this._versionPanel = undefined;
		}
	}

	override dispose(): void {
		this._disposeWebview();
		super.dispose();
	}
}
