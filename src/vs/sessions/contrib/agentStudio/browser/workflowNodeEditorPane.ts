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
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { AgentStudioWebviewController } from './agentStudioWebviewController.js';
import { WorkflowNodeEditorInput } from './workflowNodeEditorInput.js';
import { IWorkflowStorageService } from '../common/workflowStorage.js';

/**
 * WorkflowNodeEditorPane — 单个节点的编辑器，开在**独立 editor tab**（2026-09-13，P2）。
 *
 * ★ 复用策略（零新增编辑器装配代码）：
 *   与 `WorkflowEditorPane` 一样用 `panelType='workflow-editor'` 起 webview（同一套
 *   React App / store / 快照库 / runner 装配），只多传一个 `initialData.focusNodeId`
 *   → webview 侧加载完画布后自动打开该节点的**全屏编辑器**（P0 已实现的浮层）。
 *   这样「节点编辑器」不需要第二份渲染实现，也不会与卡片内联逻辑分叉。
 *
 * ★ 与画布 tab 的关系：resource 不同（`saros-workflow-node:` vs `saros-workflow:`）
 *   → 两个 tab 可并存（画布 + 节点编辑器并排）。跨 tab 的数据同步见
 *   `workflow.nodeValuesChanged` 的回流链路（host 侧广播，P2b）。
 */
export class WorkflowNodeEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.workflowNodePane';

	private _container: HTMLElement | undefined;
	private _webviewController: AgentStudioWebviewController | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkflowStorageService private readonly workflowStorageService: IWorkflowStorageService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(WorkflowNodeEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = DOM.$('div.workflow-node-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		this._container.style.overflow = 'hidden';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof WorkflowNodeEditorInput) || !this._container) {
			return;
		}
		if (token.isCancellationRequested) { return; }

		// 每次打开都从磁盘读最新工作流（画布 tab 可能刚保存过）。
		let workflowData = await this.workflowStorageService.getWorkflow(input.workflowId).catch(() => undefined);
		if (token.isCancellationRequested) { return; }
		if (!workflowData) {
			this.notificationService.error(`工作流不存在或已被删除：${input.workflowId}`);
			return;
		}

		// 同一节点重复打开 → 复用已存在的 webview（避免重建闪烁）。
		if (this._webviewController) {
			this.logService.info(`[WorkflowNodeEditorPane] reuse existing webview for ${input.workflowId}/${input.nodeId}`);
			return;
		}

		DOM.clearNode(this._container);
		this._webviewController = this.instantiationService.createInstance(
			AgentStudioWebviewController,
			this._container,
			'workflow-editor' as const,
			{
				type: 'workflow',
				workflow: workflowData,
				// ★ 关键：webview 侧据此自动打开该节点的全屏编辑器（见 P0 的浮层）。
				focusNodeId: input.nodeId,
			},
		);
		this.logService.info(`[WorkflowNodeEditorPane] opened node editor tab: ${input.workflowId}/${input.nodeId}`);
	}

	private _disposeWebview(): void {
		if (this._webviewController) {
			this._webviewController.dispose();
			this._webviewController = undefined;
		}
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
		// 与 WorkflowEditorPane 同因：tab 切换会让容器从 DOM 隐藏 → 尺寸归零 →
		// ResizeObserver 在面板重新出现且尺寸未变时**不会触发** → webview 停在旧尺寸。
		// 这里在可见时强制同步一次布局（对冷启动路径也起到「踢一脚」的作用）。
		if (visible && this._webviewController && this._container) {
			const rect = this._container.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				this._webviewController.layout(rect.width, rect.height);
			}
		}
	}

	override clearInput(): void {
		this._disposeWebview();
		super.clearInput();
	}

	override dispose(): void {
		this._disposeWebview();
		super.dispose();
	}
}
