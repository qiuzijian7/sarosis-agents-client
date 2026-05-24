/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import {
	IAgentTaskBoardService,
	IAgentStudioService,
	IAgentDelegationService,
	ITaskOrchestrationService,
} from '../common/agentStudio.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import type { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { TaskDetailEditorInput } from './taskDetailEditorInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';

interface IIncomingMessage {
	readonly id?: string;
	readonly direction?: string;
	readonly type?: string;
	readonly payload?: unknown;
}

/**
 * Task Overview EditorPane — Kanban board rendered as a WebView using the
 * shared React TaskBoardPanel component.
 *
 * Architecture: identical to `HtmlPreviewEditorPane` — we own a `<div>`
 * container, create an `IWebviewElement`, and mount it via
 * `webview.mountTo(container, mainWindow)`. The webview loads the same
 * `webview.js` bundle used by the main Agent Studio panel, but with
 * `window.__AGENT_STUDIO_PANEL_TYPE__ = 'taskboard'` so React renders
 * only the `TaskBoardPanel`.
 *
 * Communication: the React app uses `sendRequest()` from `messageClient.ts`
 * which sends `postMessage` to the host. We route `taskBoard.*` requests
 * to the appropriate service and also handle `taskBoard.openTaskDetail`
 * to open the task detail editor.
 */
export class TaskOverviewEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.taskOverview';

	private _container: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@ILogService private readonly _logService: ILogService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@IAgentTaskBoardService private readonly _taskBoardService: IAgentTaskBoardService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
		@IAgentDelegationService private readonly _delegationService: IAgentDelegationService,
		@ITaskOrchestrationService private readonly _taskOrchestrationService: ITaskOrchestrationService,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super(TaskOverviewEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('task-overview-editor');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.position = 'relative';
		this._container.style.background = 'var(--vscode-editor-background)';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);

		// Re-create webview on every setInput (pane may have been moved between groups)
		this._disposeWebview();

		try {
			const mediaUri = this._getMediaUri();

			this._webview = this._webviewService.createWebviewElement({
				title: 'Task Overview',
				options: {
					enableFindWidget: false,
					retainContextWhenHidden: true,
				},
				contentOptions: {
					allowScripts: true,
					localResourceRoots: [mediaUri],
				},
				extension: undefined,
			});

			this._register(this._webview);

			// Route messages from the webview to host services
			this._register(this._webview.onMessage(async (e) => {
				await this._handleMessage(e.message as IIncomingMessage);
			}));

			// Push task-board change events into the webview
			this._register(this._taskBoardService.onDidChangeTaskBoard(() => {
				if (this._webview) {
					void this._webview.postMessage({
						direction: 'toWebview',
						type: 'taskBoard.changed',
						data: {},
					});
				}
			}));

			// Push orchestration plan events into the webview
			this._register(this._taskOrchestrationService.onDidChangePlan((plan) => {
				if (this._webview) {
					void this._webview.postMessage({
						direction: 'toWebview',
						type: 'orchestration.planUpdated',
						data: plan,
					});
				}
			}));

			// Push focus/highlight task events into the webview
			this._register(this._taskOrchestrationService.onDidFocusTask((taskTitle: string) => {
				if (this._webview) {
					void this._webview.postMessage({
						direction: 'toWebview',
						type: 'taskBoard.focusTask',
						data: { taskTitle },
					});
				}
			}));

			// Mount and set HTML
			this._webview.mountTo(this._container!, mainWindow);
			this._webview.setHtml(this._getWebviewHtml(mediaUri));

			this._logService.info('[TaskOverviewEditorPane] WebView mounted');
		} catch (err) {
			this._logService.error('[TaskOverviewEditorPane] Failed to create webview:', err);
			if (this._container) {
				DOM.clearNode(this._container);
				const errorEl = document.createElement('div');
				errorEl.style.padding = '20px';
				errorEl.style.color = 'var(--vscode-errorForeground, #f48771)';
				errorEl.textContent = `任务看板加载失败: ${err instanceof Error ? err.message : String(err)}`;
				this._container.appendChild(errorEl);
			}
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
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

	// ─── Media URI ──────────────────────────────────────────────────────────

	private _getMediaUri(): URI {
		const appRoot = (this._environmentService as INativeEnvironmentService).appRoot;
		return URI.joinPath(
			URI.file(appRoot),
			'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'media',
		);
	}

	// ─── WebView HTML ───────────────────────────────────────────────────────

	private _getWebviewHtml(mediaUri: URI): string {
		const nonce = this._generateNonce();
		const scriptUri = asWebviewUri(URI.joinPath(mediaUri, 'webview.js')).toString() + '?_=' + Date.now();
		const styleUri = asWebviewUri(URI.joinPath(mediaUri, 'webview.css')).toString() + '?_=' + Date.now();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' vscode-webview: vscode-resource:; style-src 'nonce-${nonce}' 'unsafe-inline' vscode-webview: vscode-resource:; img-src data: https: vscode-webview: vscode-resource:; font-src data: vscode-webview: vscode-resource:;">
	<title>Task Overview</title>
	<link rel="stylesheet" nonce="${nonce}" href="${styleUri}">
	<style nonce="${nonce}">
		body { margin: 0; padding: 0; overflow: hidden; height: 100vh; background: var(--as-bg-primary, var(--vscode-editor-background)); color: var(--as-fg-primary, var(--vscode-foreground)); font-family: var(--vscode-font-family); }
		#root { width: 100%; height: 100%; }
	</style>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}">
		window.__AGENT_STUDIO_PANEL_TYPE__ = 'taskboard';
		window.__AS_BUNDLE_LOADED__ = false;
	</script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	private _generateNonce(): string {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		for (let i = 0; i < 32; i++) {
			result += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return result;
	}

	// ─── Message Router ─────────────────────────────────────────────────────

	private async _handleMessage(message: IIncomingMessage): Promise<void> {
		if (!message || message.direction !== 'toHost' || !message.type) {
			return;
		}

		const { id, type, payload } = message;
		const p = (payload ?? {}) as Record<string, unknown>;

		this._logService.info(`[TaskOverviewEditorPane] _handleMessage: type=${type}, id=${id}`);

		try {
			const result = await this._dispatch(type, p);
			if (id) {
				this._sendResponse(id, type, result);
			}
		} catch (err: unknown) {
			const error = err instanceof Error ? err : new Error(String(err));
			this._logService.error(`[TaskOverviewEditorPane] Error handling ${type}:`, error);
			if (id) {
				this._sendError(id, type, error.message);
			}
		}
	}

	private async _dispatch(type: string, p: Record<string, unknown>): Promise<unknown> {
		switch (type) {
			// ─── Task Board CRUD ──────────────────────────────────
			case 'taskBoard.list':
				return this._taskBoardService.getTasks(p.workspaceId as string | undefined);
			case 'taskBoard.create':
				return this._taskBoardService.createTask(p as Record<string, unknown>);
			case 'taskBoard.update':
				return this._taskBoardService.updateTask(p.id as string, p as Record<string, unknown>);
			case 'taskBoard.delete':
				return this._taskBoardService.deleteTask(p.id as string);
			case 'taskBoard.archive':
				return this._taskBoardService.archiveTask(p.id as string);

			// ─── Workspace ───────────────────────────────────────
			case 'workspace.list':
				return this._agentStudioService.getWorkspaces();
			case 'workspace.get':
				return this._agentStudioService.getWorkspace(p.id as string);
			case 'workspace.create':
				return this._agentStudioService.createWorkspace(p as Record<string, unknown>);
			case 'workspace.delete':
				return this._agentStudioService.deleteWorkspace(p.id as string);
			case 'workspace.update':
				return this._agentStudioService.updateWorkspace(p.id as string, p as Record<string, unknown>);
			case 'workspace.updateLayout':
				return this._agentStudioService.updateWorkspaceLayout(p.workspaceId as string, {
					nodes: p.nodes as any,
					edges: p.edges as any,
					viewport: p.viewport as any,
				});
			case 'workspace.active':
				return { workspaceId: undefined };

			// ─── Employees ───────────────────────────────────────
			case 'employees.list':
				return this._agentStudioService.getEmployees(p.workspaceId as string | undefined);
			case 'employees.get':
				return this._agentStudioService.getEmployee(p.id as string);
			case 'employees.create':
				return this._agentStudioService.createEmployee(p as Record<string, unknown>);
			case 'employees.update':
				return this._agentStudioService.updateEmployee(p.id as string, p.data as Record<string, unknown>);
			case 'employees.delete':
				return this._agentStudioService.deleteEmployee(p.id as string);
			case 'employees.export':
				return this._agentStudioService.exportEmployee(p.id as string);
			case 'employees.import':
				return this._agentStudioService.importEmployee(
					p.exportData as any,
					p.workspaceId as string | undefined,
				);
			case 'employees.selected':
				this._agentStudioService.fireSelectEmployee(p.employeeId as string | null);
				return undefined;

			// ─── Delegations ─────────────────────────────────────
			case 'delegation.list':
				return this._delegationService.getDelegations(p.workspaceId as string | undefined);
			case 'delegation.get':
				return this._delegationService.getDelegation(p.id as string);
			case 'delegation.create':
				return this._delegationService.createDelegation(p as Record<string, unknown>);
			case 'delegation.update':
				return this._delegationService.updateDelegation(p.id as string, p as Record<string, unknown>);
			case 'delegation.delete':
				return this._delegationService.deleteDelegation(p.id as string);
			case 'delegation.autoPlan':
				return this._delegationService.executePlan(p.goal as string, p.workspaceId as string);

			// ─── Orchestration ───────────────────────────────────
			case 'orchestration.listPlans':
				return this._taskOrchestrationService.listPlans(p.workspaceId as string | undefined);
			case 'orchestration.plan': {
				const goal = p.goal as string;
				const workspaceId = p.workspaceId as string;
				const plannerId = p.plannerId as string | undefined;
				return this._taskOrchestrationService.createPlan(goal, workspaceId, plannerId || '');
			}
			case 'orchestration.getPlan':
				return this._taskOrchestrationService.getPlan(p.planId as string);
			case 'orchestration.approve':
				return this._taskOrchestrationService.approvePlan(p.planId as string);
			case 'orchestration.reject':
				return this._taskOrchestrationService.rejectPlan(p.planId as string);
			case 'orchestration.taskAction':
				return this._taskOrchestrationService.taskAction(
					p.planId as string,
					p.taskId as string,
					p.action as any,
				);
			case 'orchestration.approveTask':
				return this._taskOrchestrationService.approveTask(
					p.planId as string,
					p.taskId as string,
					p.comment as string | undefined,
				);
			case 'orchestration.rejectTask':
				return this._taskOrchestrationService.rejectTask(
					p.planId as string,
					p.taskId as string,
					p.comment as string | undefined,
				);
			case 'orchestration.commentTask':
				return this._taskOrchestrationService.commentTask(
					p.planId as string,
					p.taskId as string,
					p.comment as string,
				);
			case 'orchestration.blockTask':
				return this._taskOrchestrationService.blockTask(
					p.planId as string,
					p.taskId as string,
					p.reason as string | undefined,
				);
			case 'orchestration.unblockTask':
				return this._taskOrchestrationService.unblockTask(
					p.planId as string,
					p.taskId as string,
				);
			case 'orchestration.updateTask':
				return this._taskOrchestrationService.updateTask(
					p.planId as string,
					p.taskId as string,
					p.updates as Record<string, unknown>,
				);
			case 'orchestration.decomposeTask':
				return this._taskOrchestrationService.decomposeTask(
					p.planId as string,
					p.taskId as string,
					p.workspaceId as string,
					p.plannerId as string,
				);

			// ─── Open task detail in editor ──────────────────────
			case 'taskBoard.openTaskDetail': {
				const taskId = p.taskId as string;
				const taskTitle = p.taskTitle as string;
				if (taskId) {
					const input = TaskDetailEditorInput.getOrCreate(taskId, taskTitle || 'Task');
					this._editorService.openEditor(input, { pinned: false });
				}
				return undefined;
			}

			// ─── Open overview (no-op, already here) ─────────────
			case 'taskBoard.openOverview':
				return undefined;

			default:
				this._logService.warn(`[TaskOverviewEditorPane] Unhandled message type: ${type}`);
				return undefined;
		}
	}

	private _sendResponse(id: string, type: string, data: unknown): void {
		if (!this._webview) { return; }
		void this._webview.postMessage({
			id,
			direction: 'toWebview',
			type: `${type}.response`,
			data,
		});
	}

	private _sendError(id: string, type: string, message: string): void {
		if (!this._webview) { return; }
		void this._webview.postMessage({
			id,
			direction: 'toWebview',
			type: `${type}.response`,
			error: { code: 'ERROR', message },
		});
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────

	private _disposeWebview(): void {
		if (this._webview) {
			this._webview.dispose();
			this._webview = undefined;
		}
		if (this._container) {
			DOM.clearNode(this._container);
		}
	}
}
