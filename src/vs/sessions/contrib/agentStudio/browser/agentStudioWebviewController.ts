/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import { Disposable } from "../../../../base/common/lifecycle.js";
import {
	IWebviewElement,
	IWebviewService,
} from "../../../../workbench/contrib/webview/browser/webview.js";
import { asWebviewUri } from "../../../../workbench/contrib/webview/common/webview.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { URI } from "../../../../base/common/uri.js";
import { mainWindow } from "../../../../base/browser/window.js";
import {
	IAgentStudioService,
	IAgentChatService,
	IAgentDelegationService,
	IAgentTaskBoardService,
	ITaskOrchestrationService,
	IConfigMdService,
} from "../common/agentStudio.js";
import { ISkillRegistry } from "../common/skills.js";
import type { IChatStreamDelta } from "../common/agentStudio.js";
import type { AgentExportData } from "../../../common/agentStudioTypes.js";
import {
	IEnvironmentService,
	type INativeEnvironmentService,
} from "../../../../platform/environment/common/environment.js";
import type {
	RequestType,
	IResponseMessage,
	IEventMessage,
	IOrchestrationApproveTaskPayload,
	IOrchestrationRejectTaskPayload,
	IOrchestrationCommentTaskPayload,
	IOrchestrationBlockTaskPayload,
	IOrchestrationUnblockTaskPayload,
} from "./messageProtocol.js";
import type { AgentStudioPanelType } from "../common/constants.js";
import { WORKSPACE_DATA_DIR, AGENTS_DIR } from "../common/constants.js";
import { IModelSelectorService } from "../common/modelSelector.js";
import { IAgentOSService } from "../common/agentOS.js";
import type { IToolApprovalHandler, ToolApprovalDecision, IToolApprovalRequest } from "../common/providers.js";
import { IWorkbenchThemeService } from "../../../../workbench/services/themes/common/workbenchThemeService.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { VSBuffer } from "../../../../base/common/buffer.js";
import { IModelService } from "../../../../editor/common/services/model.js";
import { IOpenerService } from "../../../../platform/opener/common/opener.js";
import {
	IEditorService,
	SIDE_GROUP,
} from "../../../../workbench/services/editor/common/editorService.js";
import {
	GroupsOrder,
	IEditorGroupsService,
} from "../../../../workbench/services/editor/common/editorGroupsService.js";
import type {
	IProviderInfo,
	IProviderSelectPayload,
	IEmployeeExportPayload,
	IEmployeeImportPayload,
	IWorkspaceSessionCreatePayload,
	IOrchestrationTaskActionPayload,
	IConfigMdEventPayload,
	IConfigMdChatSendPayload,
	IConfigMdWriteSourcePayload,
	IConfigMdApplyPatchPayload,
	IConfigMdRenderHtmlPayload,
	IFileOpenPayload,
	IFileOpenUntitledTextPayload,
	IFileApplyCodePayload,
	IChatJumpToCheckpointPayload,
	IChatToolApprovePayload,
	IChatToolApprovalRequestPayload,
	IChatAddCheckpointPayload,
	IChatGetCheckpointPayload,
	IChatListCheckpointsPayload,
	IChatDeleteCheckpointPayload,
} from "./messageProtocol.js";
import type {
	ICheckpoint,
} from "../common/checkpointTypes.js";
import {
	WorkspaceSessionService,
	type IWorkspaceSessionService,
} from "./workspaceSessionService.js";
import { HtmlPreviewEditorInput } from "./htmlPreviewEditorInput.js";
import { TaskOverviewEditorInput } from "./taskOverviewEditorInput.js";

interface IIncomingMessage {
	readonly id?: string;
	readonly direction?: string;
	readonly type?: string;
	readonly payload?: unknown;
}

/**
 * WebView Controller - manages the lifecycle of the Agent Studio WebView
 * and routes postMessage communication to Host Services.
 *
 * Each panel instance receives a `panelType` that tells the React app which
 * component to render: 'canvas' | 'chat' | 'taskboard'.
 * When panelType is undefined, the full app (legacy single-pane mode) is rendered.
 */
export class AgentStudioWebviewController extends Disposable {
	private _webview: IWebviewElement | undefined;
	private readonly _sessionService: IWorkspaceSessionService;

	/**
	 * The (employeeId, agentSessionId) pair this chat panel is currently
	 * showing. Updated by the webview via `chat.activeSessionChanged`
	 * whenever the user picks a different employee or switches session.
	 *
	 * Used (a) to filter `onDidRequestChatSend` events so only the chat
	 * panel actually showing the target employee handles imgui submits,
	 * preventing duplicate sends across multiple chat panels, and
	 * (b) to register into `IConfigMdService.setActiveAgentSession` so
	 * the preview pane can route imgui submits into the correct Fork
	 * session.
	 */
	private _activeChatEmployeeId: string | undefined;
	private _activeChatAgentSessionId: string | undefined;

	/** Pending tool approval requests: toolCallId → resolve function */
	private readonly _pendingToolApprovals = new Map<string, { resolve: (decision: ToolApprovalDecision) => void }>();

	constructor(
		private readonly container: HTMLElement,
		private readonly panelType: AgentStudioPanelType | undefined,
		@IWebviewService private readonly webviewService: IWebviewService,
		@ILogService private readonly logService: ILogService,
		@IEnvironmentService
		private readonly _environmentService: IEnvironmentService,
		@IAgentStudioService
		private readonly agentStudioService: IAgentStudioService,
		@IAgentChatService private readonly agentChatService: IAgentChatService,
		@IAgentDelegationService
		private readonly agentDelegationService: IAgentDelegationService,
		@IAgentTaskBoardService
		private readonly agentTaskBoardService: IAgentTaskBoardService,
		@IModelSelectorService
		private readonly modelSelectorService: IModelSelectorService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@IWorkbenchThemeService
		private readonly workbenchThemeService: IWorkbenchThemeService,
		@IFileService private readonly fileService: IFileService,
		@ITaskOrchestrationService
		private readonly taskOrchestrationService: ITaskOrchestrationService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService
		private readonly editorGroupsService: IEditorGroupsService,
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IConfigMdService private readonly _configMdService: IConfigMdService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@IModelService private readonly modelService: IModelService,
	) {
		super();
		this._sessionService = new WorkspaceSessionService(
			logService,
			this.fileService,
			agentStudioService,
		);
		this._createWebview();
		this._registerServiceListeners();

		// Register tool approval handler (wires UI approval flow)
		const approvalHandler: IToolApprovalHandler = {
			requestApproval: (request: IToolApprovalRequest): Promise<ToolApprovalDecision> => {
				return new Promise<ToolApprovalDecision>((resolve) => {
					// Store resolve function
					this._pendingToolApprovals.set(request.toolCallId, { resolve });
					
					// Send event to webview to show approval UI
					this._sendEvent('chat.toolApprovalRequest', {
						toolCallId: request.toolCallId,
						toolName: request.toolName,
						arguments: request.arguments,
						securityLevel: request.securityLevel as any, // ToolSecurityLevel enum -> string
						reason: request.reason,
					} as IChatToolApprovalRequestPayload);
				});
			},
		};
		this.agentOSService.setToolApprovalHandler(approvalHandler);
		this.logService.info('[AgentStudioWebviewController] Tool approval handler registered');
	}

	private _getMediaUri(): URI {
		// The media folder is alongside the compiled source
		const appRoot = (this._environmentService as INativeEnvironmentService)
			.appRoot;
		return URI.joinPath(
			URI.file(appRoot),
			"src",
			"vs",
			"sessions",
			"contrib",
			"agentStudio",
			"webview",
			"media",
		);
	}

	private _createWebview(): void {
		const mediaUri = this._getMediaUri();

		this._webview = this.webviewService.createWebviewElement({
			title: "Agent Studio",
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

		// Mount WebView to container
		this._webview.mountTo(this.container, mainWindow);

		// Set HTML content that loads the React bundle
		this._webview.setHtml(this._getWebviewHtml());

		// Listen for messages from WebView
		this._register(
			this._webview.onMessage(async (message) => {
				await this._handleMessage(message.message as IIncomingMessage);
			}),
		);
	}

	private _getWebviewHtml(): string {
		// Generate CSP nonce
		const nonce = this._generateNonce();

		// Convert the media folder URI to a webview-accessible URI
		const mediaUri = this._getMediaUri();
		const scriptUri =
			asWebviewUri(URI.joinPath(mediaUri, "webview.js")).toString() +
			"?_=" +
			Date.now();
		const styleUri =
			asWebviewUri(URI.joinPath(mediaUri, "webview.css")).toString() +
			"?_=" +
			Date.now();

		const initialTheme =
			this.workbenchThemeService.getColorTheme().settingsId || "";

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' vscode-webview: vscode-resource:; style-src 'nonce-${nonce}' 'unsafe-inline' vscode-webview: vscode-resource:; img-src data: https: vscode-webview: vscode-resource:; font-src data: vscode-webview: vscode-resource:;">
	<title>Agent Studio</title>
	<link rel="stylesheet" nonce="${nonce}" href="${styleUri}">
	<style nonce="${nonce}">
		body { margin: 0; padding: 0; overflow: hidden; height: 100vh; background: var(--as-bg-primary, var(--vscode-editor-background)); color: var(--as-fg-primary, var(--vscode-foreground)); font-family: var(--vscode-font-family); }
		#root { width: 100%; height: 100%; }
	</style>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}">
		// Tell the React app which panel to render
		window.__AGENT_STUDIO_PANEL_TYPE__ = ${this.panelType ? `'${this.panelType}'` : "undefined"};
		// Initial theme from configuration
		window.__AGENT_STUDIO_INITIAL_THEME__ = '${initialTheme}';

		// ── Early diagnostics: catch ALL messages and errors before React loads ──
		window.__AS_MSG_LOG__ = [];
		window.addEventListener('message', function(e) {
			var d = e.data;
			if (d && d.direction === 'toWebview') {
				window.__AS_MSG_LOG__.push(d.type);
				console.log('[AS-EARLY] postMessage received: type=' + d.type);
			}
		});
		window.addEventListener('error', function(e) {
			console.error('[AS-EARLY] Script error:', e.message, e.filename, e.lineno);
		});
		console.log('[AS-EARLY] Inline script executed, panelType=' + window.__AGENT_STUDIO_PANEL_TYPE__);
		// Track whether the bundle script fires
		window.__AS_BUNDLE_LOADED__ = false;
	</script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
	<script nonce="${nonce}">
		// ── Post-bundle diagnostics ──
		if (window.__AS_BUNDLE_LOADED__) {
			console.log('[AS-EARLY] webview.js bundle executed successfully');
		} else {
			console.error('[AS-EARLY] webview.js bundle DID NOT execute — likely a load error (CSP? 404? syntax?)');
			console.error('[AS-EARLY] scriptUri was: ${scriptUri}');
		}
		// Also check if acquireVsCodeApi exists
		console.log('[AS-EARLY] acquireVsCodeApi exists:', typeof acquireVsCodeApi);
	</script>
</body>
</html>`;
	}

	private _generateNonce(): string {
		const chars =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
		let result = "";
		for (let i = 0; i < 32; i++) {
			result += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return result;
	}

	// ─── Message Router ─────────────────────────────────────────────────────────

	private async _handleMessage(message: IIncomingMessage): Promise<void> {
		if (!message || message.direction !== "toHost") {
			return;
		}

		const { id, type, payload } = message;

		if (!type) {
			return;
		}

		this.logService.info(
			`[AgentStudio] _handleMessage: type=${type}, id=${id}, panelType=${this.panelType}, payload=${JSON.stringify(payload)?.slice(0, 200)}`,
		);

		try {
			const result = await this._dispatch(type as RequestType, payload);
			if (id) {
				this._sendResponse(id, type as RequestType, result);
			}
		} catch (err: unknown) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.logService.error(`[AgentStudio] Error handling ${type}:`, error);
			if (id) {
				this._sendError(id, type as RequestType, error.message);
			}
		}
	}

	private async _dispatch(
		type: RequestType,
		payload: unknown,
	): Promise<unknown> {
		const p = payload as Record<string, unknown>;

		switch (type) {
			// ─── Employees ──────────────────────────────────────────
			case "employees.list":
				return this.agentStudioService.getEmployees(
					p.workspaceId as string | undefined,
				);
			case "employees.get":
				return this.agentStudioService.getEmployee(p.id as string);
			case "employees.create":
				return this.agentStudioService.createEmployee(
					p as Record<string, unknown>,
				);
			case "employees.update":
				return this.agentStudioService.updateEmployee(
					p.id as string,
					p.data as Record<string, unknown>,
				);
			case "employees.delete":
				return this.agentStudioService.deleteEmployee(p.id as string);
			case "employees.selected":
				this.agentStudioService.fireSelectEmployee(
					((p as Record<string, unknown>).employeeId as string | null) ?? null,
				);
				return undefined;
			case "employees.export":
				return this.agentStudioService.exportEmployee(
					(p as unknown as IEmployeeExportPayload).id,
				);
			case "employees.import":
				return this.agentStudioService.importEmployee(
					(p as unknown as IEmployeeImportPayload)
						.exportData as unknown as AgentExportData,
					(p as unknown as IEmployeeImportPayload).workspaceId,
				);
			case "employees.syncPositions": {
				// Sync multiple agent positions to agent.yaml + employees.json
				const positions = p.positions as Array<{
					id: string;
					position: { x: number; y: number };
				}>;
				if (positions && Array.isArray(positions)) {
					const promises = positions.map(({ id, position }) =>
						this.agentStudioService
							.updateEmployeePosition(id, position)
							.catch((err) =>
								this.logService.debug(
									`[AgentStudio] syncPositions: failed for ${id}`,
									err,
								),
							),
					);
					await Promise.all(promises);
				}
				return undefined;
			}

			// ─── Workspaces ─────────────────────────────────────────
			case "workspace.list":
				return this.agentStudioService.getWorkspaces();
			case "workspace.get":
				return this.agentStudioService.getWorkspace(p.id as string);
			case "workspace.create":
				return this.agentStudioService.createWorkspace(
					p as Record<string, unknown>,
				);
			case "workspace.delete":
				return this.agentStudioService.deleteWorkspace(p.id as string);
			case "workspace.update":
				return this.agentStudioService.updateWorkspace(
					p.id as string,
					p as Record<string, unknown>,
				);
			case "workspace.updateLayout":
				return this.agentStudioService.updateWorkspaceLayout(
					p.workspaceId as string,
					{
						nodes: p.nodes as unknown[],
						edges: p.edges as unknown[],
						viewport: p.viewport as
							| { x: number; y: number; zoom: number }
							| undefined,
					} as never,
				);

			// ── Worktrees ───────────────────────
			case "worktree.list":
				return this.agentStudioService.getWorktrees(
					p.workspaceId as string,
				);
			// ─── Connections ────────────────────────────────────────
			case "workspace.connections.list":
				return this.agentStudioService.getConnections(p.workspaceId as string);
			case "workspace.connections.add":
				return this.agentStudioService.addConnection(p.workspaceId as string, {
					sourceId: p.sourceId as string,
					targetId: p.targetId as string,
					type: p.type as never,
					label: p.label as string | undefined,
				});
			case "workspace.connections.remove":
				return this.agentStudioService.removeConnection(
					p.workspaceId as string,
					p.connectionId as string,
				);

			// ─── Chat ───────────────────────────────────────────────
			case "chat.send":
				return this._handleChatSend(p);
			case "chat.history":
				return this.agentChatService.getHistory(
					p.employeeId as string,
					p.sessionId as string | undefined,
				);
			case "chat.clear":
				return this.agentChatService.clearHistory(
					p.employeeId as string,
					p.sessionId as string | undefined,
				);
			case "chat.cancel":
				this.agentChatService.cancelStream(
					p.employeeId as string,
					p.agentSessionId as string | undefined,
				);
				// Also cancel the OS-level agent loop (active tool executions, etc.)
				// This mirrors VS Code Copilot Chat's pattern of cancelling both the
				// stream and any active tool invocations.
				this.agentOSService.cancelAgentLoop();
				return undefined;
			case "chat.activeSessionChanged":
				return this._handleChatActiveSessionChanged(p);

			// ─── Delegations ────────────────────────────────────────
			case "delegation.list":
				return this.agentDelegationService.getDelegations(
					p.workspaceId as string | undefined,
				);
			case "delegation.get":
				return this.agentDelegationService.getDelegation(p.id as string);
			case "delegation.create":
				return this.agentDelegationService.createDelegation(
					p as Record<string, unknown>,
				);
			case "delegation.update":
				return this.agentDelegationService.updateDelegation(
					p.id as string,
					p as Record<string, unknown>,
				);
			case "delegation.delete":
				return this.agentDelegationService.deleteDelegation(p.id as string);
			case "delegation.autoPlan":
				return this.agentDelegationService.executePlan(
					p.goal as string,
					p.workspaceId as string,
				);

			// ─── Task Board ─────────────────────────────────────────
			case "taskBoard.list":
				return this.agentTaskBoardService.getTasks(
					p.workspaceId as string | undefined,
				);
			case "taskBoard.create":
				return this.agentTaskBoardService.createTask(
					p as Record<string, unknown>,
				);
			case "taskBoard.update":
				return this.agentTaskBoardService.updateTask(
					p.id as string,
					p as Record<string, unknown>,
				);
			case "taskBoard.delete":
				return this.agentTaskBoardService.deleteTask(p.id as string);
			case "taskBoard.archive":
				return this.agentTaskBoardService.archiveTask(p.id as string);

			// ─── Sessions ───────────────────────────────────────────
			case "session.list":
				return this.agentStudioService.getSessions();
			case "session.get":
				return this.agentStudioService.getSession(p.id as string);
			case "session.create":
				return this.agentStudioService.createSession(
					p as Record<string, unknown>,
				);
			case "session.delete":
				return this.agentStudioService.deleteSession(p.id as string);

			// ─── Providers (Model Provider 列表) ────────────────────
			case "providers.list":
				return this._handleProvidersList();
			case "providers.select":
				return this._handleProvidersSelect(
					p as unknown as IProviderSelectPayload,
				);
			case "providers.getSelection":
				return this._handleProvidersGetSelection();
			case "providers.getSelectionForEmployee":
				return this._handleProvidersGetSelectionForEmployee(
					p.employeeId as string,
				);
			case "providers.openSettings":
				return this._handleProvidersOpenSettings(p as { providerId?: string });

			// ─── Workspace Sessions (Fork) ─────────────────────────
			case "workspaceSession.list":
				return this._sessionService.getSessions(p.workspaceId as string);
			case "workspaceSession.get":
				return this._sessionService.getSession(
					p.workspaceId as string,
					p.sessionId as string,
				);
			case "workspaceSession.create": {
				const { workspaceId, name, source, scheduledTaskId, idempotencyKey } =
					p as unknown as IWorkspaceSessionCreatePayload;
				return this._sessionService.createSession({
					workspaceId,
					name,
					source: source as any,
					scheduledTaskId,
					idempotencyKey,
				});
			}
			case "workspaceSession.delete":
				return this._sessionService.deleteSession(
					p.workspaceId as string,
					p.sessionId as string,
				);
			case "workspaceSession.archive":
				return this._sessionService.archiveSession(
					p.workspaceId as string,
					p.sessionId as string,
				);
			case "workspaceSession.switch":
				return this._sessionService.setActiveSession(
					p.workspaceId as string,
					p.sessionId as string,
				);
			case "workspaceSession.switchRoot":
				return this._sessionService.setActiveSession(
					p.workspaceId as string,
					null,
				);
			case "workspaceSession.updateStatus":
				return this._sessionService.updateSessionStatus(
					p.workspaceId as string,
					p.sessionId as string,
					p.status as any,
					p.error as string | undefined,
				);

			// ─── Agent Sessions (per-agent, Root mode) ─────────────
			case "agentSession.list":
				return (this.agentChatService as any).listAgentSessions(
					p.employeeId as string,
				);
			case "agentSession.create":
				return (this.agentChatService as any).createAgentSession(
					p.employeeId as string,
					p.name as string | undefined,
				);
			case "agentSession.rename":
				return (this.agentChatService as any).renameAgentSession(
					p.employeeId as string,
					p.sessionId as string,
					p.name as string,
				);
			case "agentSession.delete":
				return (this.agentChatService as any).deleteAgentSession(
					p.employeeId as string,
					p.sessionId as string,
				);
			case "agentSession.getActive":
				return (this.agentChatService as any).getOrCreateActiveSession(
					p.employeeId as string,
					p.name as string | undefined,
				);

			// ─── Orchestration ─────────────────────────────────────
			case "orchestration.plan": {
				const plan = await this.taskOrchestrationService.createPlan(
					p.goal as string,
					p.workspaceId as string,
					p.plannerId as string,
				);
				// Auto-open Task Overview in the left editor area
				try {
					const input = TaskOverviewEditorInput.getOrCreate();
					const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
					const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
					await this.editorService.openEditor(input, { pinned: true, preserveFocus: true }, targetGroup);
					this.logService.info(`[AgentStudio] Auto-opened TaskOverviewEditorPane for plan ${plan.id}`);
				} catch (err) {
					this.logService.warn('[AgentStudio] Failed to auto-open TaskOverviewEditorPane:', err);
				}
				return plan;
			}
			case "orchestration.approve":
				return this.taskOrchestrationService.approvePlan(p.planId as string);
			case "orchestration.approveWithoutExecute":
				return this.taskOrchestrationService.approveWithoutExecute(p.planId as string);
			case "orchestration.reject":
				return this.taskOrchestrationService.rejectPlan(p.planId as string);
			case "orchestration.updatePlan": {
				const updatePlanPayload = p as unknown as { planId: string; updates: Record<string, unknown> };
				return this.taskOrchestrationService.updatePlan(
					updatePlanPayload.planId,
					updatePlanPayload.updates as { goal?: string; summary?: string },
				);
			}
			case "orchestration.getPlan":
				return this.taskOrchestrationService.getPlan(p.planId as string);
			case "orchestration.listPlans":
				return this.taskOrchestrationService.listPlans(
					p.workspaceId as string | undefined,
				);
			case "orchestration.taskAction": {
				const actionPayload = p as unknown as IOrchestrationTaskActionPayload;
				return this.taskOrchestrationService.taskAction(
					actionPayload.planId,
					actionPayload.taskId,
					actionPayload.action,
				);
			}
			// ─── Human-in-the-Loop Actions ─────────────────────────────
			case "orchestration.approveTask": {
				const approvePayload = p as unknown as IOrchestrationApproveTaskPayload;
				return this.taskOrchestrationService.approveTask(
					approvePayload.planId,
					approvePayload.taskId,
					approvePayload.comment,
				);
			}
			case "orchestration.rejectTask": {
				const rejectPayload = p as unknown as IOrchestrationRejectTaskPayload;
				return this.taskOrchestrationService.rejectTask(
					rejectPayload.planId,
					rejectPayload.taskId,
					rejectPayload.comment,
				);
			}
			case "orchestration.commentTask": {
				const commentPayload = p as unknown as IOrchestrationCommentTaskPayload;
				return this.taskOrchestrationService.commentTask(
					commentPayload.planId,
					commentPayload.taskId,
					commentPayload.comment,
				);
			}
			case "orchestration.blockTask": {
				const blockPayload = p as unknown as IOrchestrationBlockTaskPayload;
				return this.taskOrchestrationService.blockTask(
					blockPayload.planId,
					blockPayload.taskId,
					blockPayload.reason,
				);
			}
			case "orchestration.unblockTask": {
				const unblockPayload = p as unknown as IOrchestrationUnblockTaskPayload;
				return this.taskOrchestrationService.unblockTask(
					unblockPayload.planId,
					unblockPayload.taskId,
				);
			}
			case "taskBoard.openOverview": {
				const { taskTitle } = p as { taskTitle: string };
				// Open Task Overview in the left editor area
				const input = TaskOverviewEditorInput.getOrCreate();
				const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
				const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
				await this.editorService.openEditor(input, { pinned: true, preserveFocus: false }, targetGroup);
				// Trigger focus/highlight on the matching task card
				this.taskOrchestrationService.focusTaskInBoard(taskTitle);
				return;
			}

			// ─── ConfigMD ─────────────────────────────────────────
			case "configmd.getResource":
				return this._configMdService.resolveState(p.employeeId as string);
			case "configmd.readSource":
				return this._configMdService.readSource(p.employeeId as string);
			case "configmd.writeSource": {
				const wp = p as unknown as IConfigMdWriteSourcePayload;
				return this._configMdService.writeSource(wp.employeeId, wp.markdown, {
					origin: wp.origin,
					baseVersion: wp.baseVersion,
				});
			}
			case "configmd.applyPatch": {
				const ap = p as unknown as IConfigMdApplyPatchPayload;
				return this._configMdService.applyPatch(ap.employeeId, ap.patches, {
					origin: ap.origin,
					baseVersion: ap.baseVersion,
				});
			}
			case "configmd.renderHtml": {
				const rp = p as unknown as IConfigMdRenderHtmlPayload;
				return this._configMdService.renderHtml(rp.employeeId, rp.markdown);
			}
			case "confightml.event":
			case "configmd.event": {
				const ep = p as unknown as IConfigMdEventPayload;
				return this._configMdService.handleHtmlEvent(
					ep.employeeId,
					ep.eventName,
					ep.payload,
					ep.agentSessionId,
				);
			}
			case "configmd.chatSend": {
				const cp = p as unknown as IConfigMdChatSendPayload;
				return this._configMdService.handleChatSend(cp.employeeId, cp.message, {
					context: cp.context,
					showInChat: cp.showInChat,
					agentSessionId: cp.agentSessionId,
				});
			}
			case "configmd.chatHistory":
				return this.agentChatService.getHistory(
					p.employeeId as string,
					p.sessionId as string | undefined,
				);
			case "configmd.notify":
				this.logService.info(
					`[ConfigMD] Notification from ${p.employeeId}: ${p.message} [${p.level || "info"}]`,
				);
				return undefined;
			case "configmd.uploadParser":
				return this._configMdService.uploadParser(
					p.employeeId as string,
					p.content as string,
					p.fileName as string | undefined,
				);
			case "configmd.uploadStyles":
				return this._configMdService.uploadStyles(
					p.employeeId as string,
					p.content as string,
					p.fileName as string | undefined,
				);
			case "configmd.removeParser":
				return this._configMdService.removeParser(p.employeeId as string);
			case "configmd.getInfo":
				return this._configMdService.getInfo(p.employeeId as string);
			case "configmd.previewToFile":
				return this._configMdService.previewToFile(p.employeeId as string);

			case "configmd.listAgents": {
				// List all agents that have config.md configured
				const employees = await this.agentStudioService.getEmployees(undefined);
				const configMdAgents = employees.filter(emp => emp.configMd && emp.agentDir);
				return configMdAgents.map(emp => ({
					id: emp.id,
					name: emp.name,
					role: emp.role,
					workspaceId: emp.workspaceId,
				}));
			}
			// ─── Files ────────────────────────────────────────────
			case "files.open": {
				const fp = p as unknown as IFileOpenPayload;
				return this._handleOpenFile(fp);
			}
			case "files.openHtmlPreview": {
				const fp = p as unknown as IFileOpenPayload;
				return this._handleOpenHtmlPreview(fp);
			}
			case "files.openUntitledText": {
				const fp = p as unknown as IFileOpenUntitledTextPayload;
				return this._handleOpenUntitledText(fp);
			}

			case "files.applyCode": {
				const ap = p as unknown as IFileApplyCodePayload;
				return this._handleApplyCode(ap);
			}
			case "chat.addCheckpoint": {
				const acp = p as unknown as IChatAddCheckpointPayload;
				return this._handleAddCheckpoint(acp);
			}
			case "chat.getCheckpoint": {
				const gcp = p as unknown as IChatGetCheckpointPayload;
				return this._handleGetCheckpoint(gcp);
			}
			case "chat.listCheckpoints": {
				const lcp = p as unknown as IChatListCheckpointsPayload;
				return this._handleListCheckpoints(lcp);
			}
			case "chat.deleteCheckpoint": {
				const dcp = p as unknown as IChatDeleteCheckpointPayload;
				return this._handleDeleteCheckpoint(dcp);
			}
			case "chat.jumpToCheckpoint": {
				const cp = p as unknown as IChatJumpToCheckpointPayload;
				return this._handleJumpToCheckpoint(cp);
			}
			case "chat.toolApprove": {
				const tp = p as unknown as IChatToolApprovePayload;
				return this._handleToolApprove(tp);
			}

			// ─── Skills ────────────────────────────────────────────
			case "skills.list":
				return this._handleSkillsList();

			default:
				throw new Error(`Unknown message type: ${type}`);

		}
	}

	/**
	 * Webview tells us which (employeeId, agentSessionId) is currently
	 * displayed in this chat panel. We update local state and register
	 * with `IConfigMdService` so imgui form submits originating in a
	 * preview pane can be routed back to the right session.
	 *
	 * We also use this to filter `onDidRequestChatSend` events: when
	 * multiple chat panels are open (different Forks), only the one
	 * whose registered employeeId matches will respond — otherwise the
	 * same imgui submit would be sent twice.
	 */
	private _handleChatActiveSessionChanged(
		payload: Record<string, unknown>,
	): void {
		if (this.panelType !== "chat") {
			// Non-chat panels don't own a chat session.
			return;
		}
		const prevEmployeeId = this._activeChatEmployeeId;
		const employeeId =
			(payload.employeeId as string | null | undefined) || undefined;
		const agentSessionId =
			(payload.agentSessionId as string | null | undefined) || undefined;
		this._activeChatEmployeeId = employeeId;
		this._activeChatAgentSessionId = agentSessionId;
		this.logService.info(
			`[AgentStudio] chat.activeSessionChanged: employeeId=${employeeId || "<none>"} ` +
			`agentSessionId=${agentSessionId || "<none>"} (panelType=${this.panelType})`,
		);
		// Clear the previous registration if the employee changed,
		// otherwise the registry would keep pointing at a stale session
		// for the prior employee.
		if (prevEmployeeId && prevEmployeeId !== employeeId) {
			this._configMdService.setActiveAgentSession(prevEmployeeId, undefined);
		}
		if (employeeId) {
			this._configMdService.setActiveAgentSession(employeeId, agentSessionId);
		}
	}

	private _handleChatSend(payload: Record<string, unknown>): {
		status: string;
		employeeId: string;
	} {
		const employeeId = payload.employeeId as string;
		const message = payload.message as string;
		let agentSessionId = payload.agentSessionId as string | undefined;
		const workspaceSessionId = payload.workspaceSessionId as string | undefined;
		const workspaceId = payload.workspaceId as string | undefined;

		// If we're in a Fork but no agentSessionId was provided, lazily create one
		if (workspaceId && workspaceSessionId && !agentSessionId) {
			this._ensureAgentSessionAndSend(
				employeeId,
				message,
				workspaceId,
				workspaceSessionId,
				payload,
			);
			return { status: "streaming", employeeId };
		}

		// Root mode without an agentSessionId: lazily create one. This path
		// is normally avoided because the chat input front-end (`useChatStore.
		// sendMessage`) calls `agentSession.getActive` BEFORE invoking us, but
		// imgui-form submits arrive here directly via `onDidRequestChatSend`
		// and may carry no sessionId at all when the user has never sent a
		// message yet. Without this branch, the user message would be
		// persisted under cache key `employeeId` (no session suffix) and
		// `_persistToSessionFile` would skip writing to disk entirely —
		// causing the message to vanish on the next reload.
		if (!agentSessionId) {
			this._ensureRootSessionAndSend(employeeId, message, payload);
			return { status: "streaming", employeeId };
		}

		// Persist the user message to chat history so it survives refreshes.
		const userMessage: import("../../../common/agentStudioTypes.js").ChatMessage =
		{
			id: `msg_${Date.now()}_user_${Math.random().toString(36).substring(2, 9)}`,
			role: "user",
			content: message,
			employeeId,
			agentSessionId,
			timestamp: new Date().toISOString(),
		};
		this.agentChatService
			.appendMessage(employeeId, userMessage)
			.catch((err) =>
				this.logService.error(
					"[AgentStudio] Failed to persist user message:",
					err,
				),
			);

		this._runChatStream(employeeId, message, payload);

		return { status: "streaming", employeeId };
	}

	/**
	 * Root-mode equivalent of `_ensureAgentSessionAndSend`: when a message
	 * arrives with no agentSessionId AND no Fork context (i.e. an imgui
	 * submit on a fresh chat panel), call into AgentChatService to either
	 * pick the most-recent session or auto-create one, then forward the
	 * message through the normal persist + stream pipeline.
	 *
	 * We also update the chat panel's registered session via
	 * `setActiveAgentSession` and broadcast `workspace.sessionUpdated` so
	 * the webview's `useChatStore.activeAgentSessionId` follows along —
	 * otherwise the next reload would still default-load against `null`
	 * and miss the message we just persisted.
	 */
	private async _ensureRootSessionAndSend(
		employeeId: string,
		message: string,
		payload: Record<string, unknown>,
	): Promise<void> {
		try {
			const sessionName = message.trim().substring(0, 30) || "新对话";
			const meta = await (
				this.agentChatService as any
			).getOrCreateActiveSession(employeeId, sessionName);
			const agentSessionId = meta?.id as string | undefined;
			if (!agentSessionId) {
				throw new Error("getOrCreateActiveSession returned no id");
			}
			this.logService.info(
				`[AgentStudio] _ensureRootSessionAndSend: ensured session ${agentSessionId} for ${employeeId}`,
			);

			// Mirror chat-input flow: keep the registry & webview in sync
			// so subsequent imgui submits (and the post-reload history load)
			// aim at the same session.
			this._configMdService.setActiveAgentSession(employeeId, agentSessionId);
			if (this._activeChatEmployeeId === employeeId) {
				this._activeChatAgentSessionId = agentSessionId;
			}
			this._sendEvent("workspace.sessionUpdated", {
				agentId: employeeId,
				agentSessionId,
			});

			// Persist the user message under the resolved session.
			const userMessage: import("../../../common/agentStudioTypes.js").ChatMessage =
			{
				id: `msg_${Date.now()}_user_${Math.random().toString(36).substring(2, 9)}`,
				role: "user",
				content: message,
				employeeId,
				agentSessionId,
				timestamp: new Date().toISOString(),
			};
			this.agentChatService
				.appendMessage(employeeId, userMessage)
				.catch((err) =>
					this.logService.error(
						"[AgentStudio] Failed to persist user message:",
						err,
					),
				);

			// Run the chat stream with the resolved agentSessionId.
			const enrichedPayload = { ...payload, agentSessionId };
			this._runChatStream(employeeId, message, enrichedPayload);
		} catch (err) {
			this.logService.error(
				"[AgentStudio] _ensureRootSessionAndSend failed:",
				err,
			);
			this._sendEvent("chat.stream.error", {
				employeeId,
				sessionId: "",
				error: `Failed to ensure agent session: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	/**
	 * Lazily create an AgentSession entry in the Fork, then proceed with the chat.
	 * This is called when the webview sends a message in Fork mode but hasn't been
	 * assigned an agentSessionId yet (first message for this Agent in this Fork).
	 */
	private async _ensureAgentSessionAndSend(
		employeeId: string,
		message: string,
		workspaceId: string,
		workspaceSessionId: string,
		payload: Record<string, unknown>,
	): Promise<void> {
		try {
			const entry = await this._sessionService.ensureAgentSession(
				workspaceId,
				workspaceSessionId,
				employeeId,
			);
			const agentSessionId = entry.sessionId;

			// Persist the user message with the resolved agentSessionId
			const userMessage: import("../../../common/agentStudioTypes.js").ChatMessage =
			{
				id: `msg_${Date.now()}_user_${Math.random().toString(36).substring(2, 9)}`,
				role: "user",
				content: message,
				employeeId,
				agentSessionId,
				timestamp: new Date().toISOString(),
			};
			this.agentChatService
				.appendMessage(employeeId, userMessage)
				.catch((err) =>
					this.logService.error(
						"[AgentStudio] Failed to persist user message:",
						err,
					),
				);

			// Notify webview of the newly assigned agentSessionId
			this._sendEvent("workspace.sessionUpdated", {
				workspaceId,
				sessionId: workspaceSessionId,
				agentId: employeeId,
				agentSessionId,
			});

			// Run the chat stream with the resolved agentSessionId
			const enrichedPayload = { ...payload, agentSessionId };
			this._runChatStream(employeeId, message, enrichedPayload);
		} catch (err) {
			this.logService.error(
				"[AgentStudio] _ensureAgentSessionAndSend failed:",
				err,
			);
			this._sendEvent("chat.stream.error", {
				employeeId,
				sessionId: "",
				error: `Failed to create agent session: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	/**
	 * Run the chat stream in the background. This is fire-and-forget from
	 * the webview's perspective — all results flow through events.
	 */
	private async _runChatStream(
		employeeId: string,
		message: string,
		payload: Record<string, unknown>,
	): Promise<void> {
		const agentSessionId = payload.agentSessionId as string | undefined;
		const sessionIdForEvent = agentSessionId || "";
		let capturedProviderSessionId: string | undefined;
		try {
			const chatMessage = await this.agentChatService.sendMessage(
				employeeId,
				message,
				{
					model: payload.model as string | undefined,
					systemPrompt: payload.systemPrompt as string | undefined,
					temperature: payload.temperature as number | undefined,
					workspaceId: payload.workspaceId as string | undefined,
					agentSessionId,
					explicitSkillIds: payload.explicitSkillIds as string[] | undefined,
				},
				(delta: IChatStreamDelta) => {
					// Capture provider session ID from metadata (e.g. Knot AG-UI threadId)
					if (!capturedProviderSessionId && delta.metadata) {
						const psid =
							(delta.metadata as Record<string, unknown>).sessionId ||
							(delta.metadata as Record<string, unknown>).threadId ||
							(delta.metadata as Record<string, unknown>).thread_id;
						if (typeof psid === "string" && psid) {
							capturedProviderSessionId = psid;
						}
					}
					// ── 最终防线：strip undefined/non-string from the chunk before
					// sending across the host→webview boundary ─────────────────
					// Even though all upstream layers (BYOK, LM bridge, executionProvider,
					// agentOSService._adaptModelDelta) now coerce content to string, this
					// is the single funnel through which every text delta reaches the
					// webview's textBuffer. A defensive scrub here guarantees that even
					// if a future provider regression yields undefined in `content` /
					// `error`, the webview never sees the literal "undefined" string
					// produced by template-string coercion.
					const safeChunk = (() => {
						const d: any = delta;
						const out: any = { ...d };
						if ('content' in out && typeof out.content !== 'string') {
							out.content = '';
						}
						if ('error' in out && typeof out.error !== 'string') {
							out.error = out.error == null ? undefined : String(out.error);
						}
						return out;
					})();
					this._sendEvent("chat.stream.delta", {
						employeeId,
						sessionId: sessionIdForEvent,
						chunks: [safeChunk],
					});
				},
			);

			// If we captured a provider session ID, persist it to the session index
			if (capturedProviderSessionId && agentSessionId) {
				(this.agentChatService as any)
					.updateProviderSessionId(
						employeeId,
						agentSessionId,
						capturedProviderSessionId,
					)
					.catch((err: unknown) =>
						this.logService.error(
							"[AgentStudio] Failed to store providerSessionId:",
							err,
						),
					);
			}

			// Phase 3: parse `configmd-patch` and `configmd-command` blocks
			// out of the assistant reply so the agent can drive imgui forms
			// from the conversation (e.g. `imgui.set_one`, `imgui.toast`)
			// without needing a separate "tool call" path. Errors here are
			// non-fatal — the user-visible chat stream has already completed.
			if (chatMessage?.content) {
				try {
					const { patches, commands } = this._configMdService.parseModelOutput(
						chatMessage.content,
					);
					if (patches.length > 0) {
						this.logService.info(
							`[AgentStudio] Applying ${patches.length} configmd-patch op(s) from assistant reply`,
						);
						this._configMdService
							.applyPatch(employeeId, patches, { origin: "model" })
							.catch((err: unknown) =>
								this.logService.warn(
									`[AgentStudio] applyPatch from model failed:`,
									err,
								),
							);
					}
					for (const cmd of commands) {
						this.logService.info(
							`[AgentStudio] Pushing configmd-command '${cmd.name}' from assistant reply`,
						);
						this._configMdService.sendCommandToHtml(employeeId, cmd);
					}
				} catch (err) {
					this.logService.warn("[AgentStudio] parseModelOutput failed:", err);
				}
			}

			this._sendEvent("chat.stream.complete", {
				employeeId,
				sessionId: sessionIdForEvent,
				message: chatMessage,
			});
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			this.logService.error(
				`[AgentStudio] _runChatStream error for ${employeeId}:`,
				error,
			);

			this._sendEvent("chat.stream.error", {
				employeeId,
				sessionId: sessionIdForEvent,
				error: errMsg,
			});

			this._sendEvent("chat.stream.complete", {
				employeeId,
				sessionId: sessionIdForEvent,
				message: { content: "", error: errMsg },
			});
		}
	}

	// ─── Outgoing Messages ──────────────────────────────────────────────────────

	private _sendResponse(id: string, type: RequestType, data: unknown): void {
		const response: IResponseMessage = {
			id,
			direction: "toWebview" as const,
			type: `${type}.response` as `${RequestType}.response`,
			data,
		};
		if (this._webview) {
			this._webview.postMessage(response).then(
				(delivered) => {
					if (!delivered) {
						this.logService.warn(
							`[AgentStudio] _sendResponse FAILED to deliver: type=${type}.response, id=${id}`,
						);
					}
				},
				(err) => {
					this.logService.error(
						`[AgentStudio] _sendResponse REJECTED: type=${type}.response`,
						err,
					);
				},
			);
		} else {
			this.logService.warn(
				`[AgentStudio] _sendResponse: no webview for type=${type}.response, id=${id}`,
			);
		}
	}

	private _sendError(id: string, type: RequestType, message: string): void {
		const response: IResponseMessage = {
			id,
			direction: "toWebview" as const,
			type: `${type}.response` as `${RequestType}.response`,
			error: { code: "ERROR", message },
		};
		this._webview?.postMessage(response);
	}

	private _sendEvent(type: string, data: unknown): void {
		const event: IEventMessage = {
			direction: "toWebview" as const,
			type: type as IEventMessage["type"],
			data,
		};
		this.logService.info(
			`[AgentStudio] _sendEvent: type=${type}, hasWebview=${!!this._webview}, panelType=${this.panelType}`,
		);
		if (this._webview) {
			const result = this._webview.postMessage(event);
			if (type.startsWith("chat.stream")) {
				result.then(
					(delivered) => {
						if (!delivered) {
							this.logService.warn(
								`[AgentStudio] postMessage FAILED to deliver: type=${type} — webview iframe not ready or missing`,
							);
						}
					},
					(err) => {
						this.logService.error(
							`[AgentStudio] postMessage REJECTED: type=${type}`,
							err,
						);
					},
				);
			}
		}
	}

	// ─── Service Event Listeners (push changes to WebView) ──────────────────────

	/**
	 * Resolve a IFileOpenPayload into an absolute filesystem path and open it
	 * in the host's center editor area (first/leftmost editor group).
	 *
	 * Agent Studio uses a two-column layout: the Agent Studio panels live in a
	 * locked editor group; we must open files in the first (center) group, or
	 * create a side group when only one exists.
	 */
	private async _handleOpenFile(payload: IFileOpenPayload): Promise<void> {
		let absPath: string | undefined = payload.path;

		if (!absPath && payload.employeeId) {
			const employee = await this.agentStudioService.getEmployee(
				payload.employeeId,
			);
			if (!employee) {
				throw new Error(`Employee '${payload.employeeId}' not found`);
			}
			if (!employee.agentDir) {
				throw new Error(`Agent '${employee.name}' has no agentDir`);
			}
			if (!employee.workspaceId) {
				throw new Error(`Agent '${employee.name}' has no workspaceId`);
			}
			const agentDirUri = await this._resolveAgentDirUri(
				employee.workspaceId,
				employee.agentDir,
			);
			if (!agentDirUri) {
				throw new Error(
					`Workspace '${employee.workspaceId}' has no path; cannot resolve agent dir for ${employee.id}`,
				);
			}
			const cfg = employee.configMd;
			let rel: string | undefined;
			switch (payload.kind || "configMd") {
				case "configMd":
					rel = cfg?.mdPath || "config.md";
					break;
				case "configMdParser":
					rel = cfg?.parserPath;
					break;
				case "configMdStyles":
					rel = cfg?.stylesPath;
					break;
			}
			if (!rel) {
				throw new Error(`No file configured for kind='${payload.kind}'`);
			}
			absPath = URI.joinPath(agentDirUri, rel).fsPath;
		}

		if (!absPath) {
			throw new Error("files.open requires path or employeeId");
		}

		const resource = URI.file(absPath);
		const groups = this.editorGroupsService.getGroups(
			GroupsOrder.CREATION_TIME,
		);
		const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];

		this.logService.info(
			`[AgentStudioWebviewController] files.open → ${resource.toString()}`,
		);
		await this.editorService.openEditor(
			{
				resource,
				options: {
					preserveFocus: payload.preserveFocus ?? false,
					pinned: payload.pinned ?? false,
				},
			},
			targetGroup,
		);
	}

	/**
	 * Open an in-memory text buffer as an *untitled* editor in the host's
	 * center editor area. No file is read or written; the buffer lives only
	 * in the editor model and is discarded on close.
	 *
	 * Used by the ConfigMD "Demo" button so users can inspect the sample
	 * DSL without overwriting their agent's real config.md.
	 *
	 * Implementation note: VS Code's `editorService.openEditor` accepts an
	 * `IUntitledTextResourceEditorInput` shape with `resource` set to a
	 * `untitled:` URI (or undefined to auto-generate one) plus `contents`
	 * and `languageId`. We synthesise a unique URI per call so multiple
	 * Demo clicks open distinct tabs instead of re-using the same dirty
	 * buffer.
	 */
	/**
	 * Apply code content to a file (Void-inspired Apply Code Blocks).
	 * Writes the code content to the specified file path, replacing existing content.
	 */
	private async _handleApplyCode(
		payload: IFileApplyCodePayload,
	): Promise<void> {
		const { path: filePath, content } = payload;
		if (!filePath) {
			throw new Error('files.applyCode requires path');
		}

		this.logService.info(
			`[AgentStudioWebviewController] files.applyCode → ${filePath} (${content.length} chars)`,
		);

		const resource = URI.file(filePath);
		const model = this.modelService.getModel(resource);
		if (model) {
			// File is already open in editor — apply edit via model
			const editOperation = {
				range: model.getFullModelRange(),
				text: content,
			};
			model.applyEdits([editOperation]);
		} else {
			// File not open — write directly via file service
			const buffer = VSBuffer.fromString(content);
			await this.fileService.writeFile(resource, buffer);
		}
	}

	/**
	 * Navigate to a checkpoint (Void-inspired time-travel navigation).
	 * TODO: CheckpointService depends on Node.js APIs (fs, sqlite3) and must run
	 * in the extension host process. Re-implement via IAgentStudioService or IPC.
	 */
	private async _handleJumpToCheckpoint(
		payload: IChatJumpToCheckpointPayload,
	): Promise<void> {
		this.logService.warn(
			'[AgentStudioWebviewController] chat.jumpToCheckpoint is not yet available in browser context',
		);
		throw new Error('Checkpoint functionality is not yet available in browser context. Needs Node.js process implementation.');
	}

	/**
	 * Handle tool approval/rejection from the webview (Void-inspired ToolApproval).
	 * Routes the decision to the ToolApprovalService.
	 */
	private async _handleToolApprove(
		payload: IChatToolApprovePayload,
	): Promise<void> {
		this.logService.info(
			`[AgentStudioWebviewController] chat.toolApprove → ${payload.toolCallId} decision=${payload.decision}`,
		);

		// Resolve the pending approval promise
		const pending = this._pendingToolApprovals.get(payload.toolCallId);
		if (pending) {
			this._pendingToolApprovals.delete(payload.toolCallId);

			// Convert decision string to ToolApprovalDecision enum
			let decision: ToolApprovalDecision;
			switch (payload.decision) {
				case 'allow_once':
					decision = ToolApprovalDecision.AllowOnce;
					break;
				case 'allow_always':
					decision = ToolApprovalDecision.AllowAlways;
					break;
				case 'deny':
					decision = ToolApprovalDecision.Deny;
					break;
				case 'allow_session':
				case 'allow_workspace':
					// Treat as AllowOnce for now (frontend concepts)
					decision = ToolApprovalDecision.AllowOnce;
					break;
				default:
					decision = ToolApprovalDecision.Deny;
			}

			pending.resolve(decision);
		} else {
			this.logService.warn(
				`[AgentStudioWebviewController] No pending approval for toolCallId=${payload.toolCallId}`,
			);
		}
	}

	/**
	 * Handle add checkpoint request from webview.
	 * TODO: CheckpointService depends on Node.js APIs (fs, sqlite3) and must run
	 * in the extension host process. Re-implement via IAgentStudioService or IPC.
	 */
	private async _handleAddCheckpoint(
		payload: IChatAddCheckpointPayload,
	): Promise<void> {
		this.logService.warn(
			'[AgentStudioWebviewController] chat.addCheckpoint is not yet available in browser context',
		);
		throw new Error('Checkpoint functionality is not yet available in browser context. Needs Node.js process implementation.');
	}

	/**
	 * Handle get checkpoint request from webview.
	 * TODO: CheckpointService depends on Node.js APIs (fs, sqlite3) and must run
	 * in the extension host process. Re-implement via IAgentStudioService or IPC.
	 */
	private async _handleGetCheckpoint(
		payload: IChatGetCheckpointPayload,
	): Promise<ICheckpoint | undefined> {
		this.logService.warn(
			'[AgentStudioWebviewController] chat.getCheckpoint is not yet available in browser context',
		);
		return undefined;
	}

	/**
	 * Handle list checkpoints request from webview.
	 * TODO: CheckpointService depends on Node.js APIs (fs, sqlite3) and must run
	 * in the extension host process. Re-implement via IAgentStudioService or IPC.
	 */
	private async _handleListCheckpoints(
		payload: IChatListCheckpointsPayload,
	): Promise<ICheckpoint[]> {
		this.logService.warn(
			'[AgentStudioWebviewController] chat.listCheckpoints is not yet available in browser context',
		);
		return [];
	}

	/**
	 * Handle delete checkpoint request from webview.
	 * TODO: CheckpointService depends on Node.js APIs (fs, sqlite3) and must run
	 * in the extension host process. Re-implement via IAgentStudioService or IPC.
	 */
	private async _handleDeleteCheckpoint(
		payload: IChatDeleteCheckpointPayload,
	): Promise<void> {
		this.logService.warn(
			'[AgentStudioWebviewController] chat.deleteCheckpoint is not yet available in browser context',
		);
	}

	private async _handleOpenUntitledText(
		payload: IFileOpenUntitledTextPayload,
	): Promise<void> {
		const contents = payload.contents ?? "";
		const languageId = payload.languageId || "plaintext";
		// Synthesise an untitled URI. Including the title (if any) makes the
		// tab label readable; appending a counter avoids collisions when the
		// user clicks the same Demo button repeatedly.
		const safeTitle =
			(payload.title || "Untitled")
				.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
				.slice(0, 64) || "Untitled";
		const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const resource = URI.from({
			scheme: "untitled",
			path: `/${safeTitle}-${id}`,
		});

		const groups = this.editorGroupsService.getGroups(
			GroupsOrder.CREATION_TIME,
		);
		const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];

		this.logService.info(
			`[AgentStudioWebviewController] files.openUntitledText → ${resource.toString()} ` +
			`(${contents.length} chars, languageId=${languageId})`,
		);

		await this.editorService.openEditor(
			{
				resource,
				contents,
				languageId,
				options: {
					preserveFocus: payload.preserveFocus ?? false,
					pinned: payload.pinned ?? true,
				},
			},
			targetGroup,
		);
	}

	/**
	 * Resolve an HTML file path and render it as a webview preview in the host's
	 * center editor area (browser-like view rather than text source).
	 *
	 * Strategy:
	 *  1) Read the HTML file content.
	 *  2) Create an IOverlayWebview, set its HTML content, allow local resource
	 *     access for the file's parent directory.
	 *  3) Wrap in a WebviewInput and open it via IEditorService into the
	 *     center editor group.
	 *  4) On any failure, fall back to the simple-browser extension via the
	 *     `simpleBrowser.show` command (if registered).
	 */
	private async _handleOpenHtmlPreview(
		payload: IFileOpenPayload,
	): Promise<void> {
		// Reuse _handleOpenFile's path-resolution logic (path or employeeId+kind)
		let absPath: string | undefined = payload.path;
		if (!absPath && payload.employeeId) {
			const employee = await this.agentStudioService.getEmployee(
				payload.employeeId,
			);
			if (!employee?.agentDir) {
				throw new Error(`Agent '${payload.employeeId}' has no agentDir`);
			}
			if (!employee.workspaceId) {
				throw new Error(`Agent '${payload.employeeId}' has no workspaceId`);
			}
			const agentDirUri = await this._resolveAgentDirUri(
				employee.workspaceId,
				employee.agentDir,
			);
			if (!agentDirUri) {
				throw new Error(
					`Workspace '${employee.workspaceId}' has no path; cannot resolve agent dir for ${employee.id}`,
				);
			}
			const cfg = employee.configMd;
			let rel: string | undefined;
			switch (payload.kind || "configMd") {
				case "configMd":
					rel = cfg?.mdPath || "config.md";
					break;
				case "configMdParser":
					rel = cfg?.parserPath;
					break;
				case "configMdStyles":
					rel = cfg?.stylesPath;
					break;
			}
			if (!rel) {
				throw new Error(`No file configured for kind='${payload.kind}'`);
			}
			absPath = URI.joinPath(agentDirUri, rel).fsPath;
		}
		if (!absPath) {
			throw new Error("files.openHtmlPreview requires path or employeeId");
		}

		const fileUri = URI.file(absPath);

		// Open the rendered HTML inside the workbench editor area using a
		// custom EditorPane (HtmlPreviewEditorPane) that mounts an
		// IWebviewElement directly into its own DOM container.
		//
		// We DO NOT use `IWebviewWorkbenchService.openWebview` /
		// `WebviewInput` here, because that path uses an `IOverlayWebview`
		// whose iframe is positioned via CSS anchor-positioning. On this
		// fork's Chromium build that path produces an invisible iframe and
		// the editor tab content area stays blank black.
		//
		// Falling back to the system browser (via IOpenerService) is kept
		// as a safety net — the in-editor render is the primary route.
		try {
			this.logService.info(
				`[AgentStudioWebviewController] openHtmlPreview → ${fileUri.toString()} (in-editor pane)`,
			);
			const groups = this.editorGroupsService.getGroups(
				GroupsOrder.CREATION_TIME,
			);
			const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];

			const previewInput = this.instantiationService.createInstance(
				HtmlPreviewEditorInput,
				fileUri,
				this._titleForPath(absPath),
				payload.employeeId,
				payload.workspaceId,
				payload.workspaceSessionId,
				payload.agentSessionId,
			);
			await this.editorService.openEditor(
				previewInput,
				{
					preserveFocus: payload.preserveFocus ?? false,
					pinned: payload.pinned ?? true,
				},
				targetGroup,
			);
			this.logService.info(
				`[AgentStudioWebviewController] openHtmlPreview opened in-editor OK`,
			);
			return;
		} catch (err) {
			this.logService.warn(
				`[AgentStudioWebviewController] in-editor preview failed; falling back to external browser:`,
				err,
			);
		}

		// Fallback 1: open in the user's default system browser.
		try {
			const ok = await this.openerService.open(fileUri, { openExternal: true });
			if (ok) {
				this.logService.info(
					`[AgentStudioWebviewController] openHtmlPreview opened externally OK`,
				);
				return;
			}
		} catch (err) {
			this.logService.warn(
				`[AgentStudioWebviewController] openExternal failed; trying simpleBrowser:`,
				err,
			);
		}

		// Fallback 2: bundled simple-browser extension command.
		try {
			await this.commandService.executeCommand(
				"simpleBrowser.show",
				fileUri.toString(),
			);
		} catch (err) {
			this.logService.error(
				`[AgentStudioWebviewController] simpleBrowser fallback failed:`,
				err,
			);
			throw err;
		}
	}

	private _titleForPath(absPath: string): string {
		const m = /[\\/]([^\\/]+)$/.exec(absPath);
		return m ? `预览：${m[1]}` : "预览";
	}

	/**
	 * Resolve the absolute filesystem URI for an employee's agent directory.
	 *
	 * `agentDir` stored on `Employee` is just the leaf folder name (e.g.
	 * `researcher-nlmniq3`), NOT an absolute path. The actual location is
	 *   `<workspace.path>/<WORKSPACE_DATA_DIR>/<AGENTS_DIR>/<agentDir>/`
	 *
	 * Returns `undefined` when the workspace has no `path` (e.g. global/in-memory
	 * workspaces). Callers must handle this case (typically by throwing a clear
	 * error since the on-disk preview file cannot be located).
	 */
	private async _resolveAgentDirUri(
		workspaceId: string,
		agentDir: string,
	): Promise<URI | undefined> {
		if (!agentDir) {
			return undefined;
		}
		const workspace = await this.agentStudioService.getWorkspace(workspaceId);
		if (!workspace?.path) {
			return undefined;
		}
		return URI.joinPath(
			URI.file(workspace.path),
			WORKSPACE_DATA_DIR,
			AGENTS_DIR,
			agentDir,
		);
	}

	private _registerServiceListeners(): void {
		this._register(
			this.agentStudioService.onDidChangeEmployees(() => {
				this._sendEvent("employees.changed", {});
			}),
		);

		this._register(
			this.agentStudioService.onDidSelectEmployee(
				(employeeId: string | null) => {
					this.logService.info(
						`[AgentStudio] onDidSelectEmployee → _sendEvent('employee.selected', {employeeId=${employeeId}}) panelType=${this.panelType}`,
					);
					this._sendEvent("employee.selected", { employeeId });
				},
			),
		);

		this._register(
			this.agentStudioService.onDidChangeWorkspace((id: string) => {
				this._sendEvent("workspace.changed", { workspaceId: id });
			}),
		);

		this._register(
			this.agentDelegationService.onDidChangeDelegations(() => {
				this._sendEvent("delegations.changed", {});
			}),
		);

		this._register(
			this.agentTaskBoardService.onDidChangeTaskBoard(() => {
				this._sendEvent("taskBoard.changed", {});
			}),
		);

		// Listen for agent session list changes (create/rename/delete/update after message)
		// and push agentSessions.changed to the webview so the L0 panel refreshes automatically.
		this._register(
			this.agentChatService.onDidChangeAgentSessions(
				({ employeeId }: { employeeId: string }) => {
					this.logService.info(
						`[AgentStudio] agentSessions changed for ${employeeId}, notifying webview`,
					);
					this._sendEvent("agentSessions.changed", { employeeId });
				},
			),
		);

		// Listen for active workspace switching from the global toolbar
		const onActiveWorkspaceChanged = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.workspaceId) {
				this._sendEvent("workspace.activeChanged", {
					workspaceId: detail.workspaceId,
				});
			}
		};
		document.addEventListener(
			"agent-studio:active-workspace-changed",
			onActiveWorkspaceChanged,
		);
		this._register({
			dispose: () =>
				document.removeEventListener(
					"agent-studio:active-workspace-changed",
					onActiveWorkspaceChanged,
				),
		});

		// Listen for Model Provider changes (auth status, model list, provider add/remove)
		// Debounce: during startup, onDidChangeAvailableModels can fire many times
		// in rapid succession as providers register, resolve models, and transition
		// auth status.  Without a debounce, the webview may see a transient state
		// where a registered provider (e.g. lm:knot) is temporarily absent from
		// getModelProviders(), causing the ProviderStore to prematurely remove it
		// and fall back to a different provider.  A short delay coalesces these
		// rapid events so the webview only sees the stable final state.
		let providersChangedTimer: ReturnType<typeof setTimeout> | undefined;
		this._register(
			this.modelSelectorService.onDidChangeAvailableModels(() => {
				this.logService.info(
					"[AgentStudio] Model providers changed, notifying webview",
				);
				if (providersChangedTimer) {
					clearTimeout(providersChangedTimer);
				}
				providersChangedTimer = setTimeout(() => {
					providersChangedTimer = undefined;
					this._handleProvidersList()
						.then((providers) => {
							this._sendEvent("providers.changed", { providers });
						})
						.catch((err) => {
							this.logService.error(
								"[AgentStudio] Failed to get providers for event",
								err,
							);
						});
				}, 150);
			}),
		);
		this._register({
			dispose: () => {
				if (providersChangedTimer) {
					clearTimeout(providersChangedTimer);
				}
			},
		});

		// Listen for VS Code native theme changes — push to WebView immediately
		this._register(
			this.workbenchThemeService.onDidColorThemeChange((newTheme) => {
				const theme = newTheme.settingsId || newTheme.label;
				this.logService.info(
					`[AgentStudio] VS Code theme changed to "${theme}", notifying webview`,
				);
				this._sendEvent("theme.changed", { theme });
			}),
		);

		// Listen for Workspace Session changes (Fork CRUD)
		this._register(
			this._sessionService.onDidChangeWorkspaceSessions(
				(workspaceId: string) => {
					this._sendEvent("workspace.sessionUpdated", { workspaceId });
				},
			),
		);

		// Listen for Orchestration plan/task changes
		this._register(
			this.taskOrchestrationService.onDidChangePlan((plan) => {
				this._sendEvent("orchestration.planUpdated", plan);
			}),
		);
		this._register(
			this.taskOrchestrationService.onDidChangeTask(({ planId, task }) => {
				this._sendEvent("orchestration.taskUpdated", { planId, task });
			}),
		);

		// Push focus/highlight task events to WebView
		this._register(
			this.taskOrchestrationService.onDidFocusTask((taskTitle: string) => {
				this._sendEvent("taskBoard.focusTask", { taskTitle });
			}),
		);

		// Wire up the orchestration service's stream event callback so that
		// background task execution can push chat.stream.* events to the webview.
		this.taskOrchestrationService.setStreamEventCallback((eventType: string, payload: Record<string, unknown>) => {
			this._sendEvent(eventType as any, payload);
		});

		// Listen for ConfigMD source / html / command events to push to WebView
		this._register(
			this._configMdService.onDidChangeSource(
				({ employeeId, markdown, version, origin }) => {
					this._sendEvent("configmd.sourceChanged", {
						employeeId,
						markdown,
						version,
						origin,
					});
				},
			),
		);
		this._register(
			this._configMdService.onDidRenderHtml(
				({ employeeId, html, version, stylesContent }) => {
					this._sendEvent("configmd.htmlRendered", {
						employeeId,
						html,
						version,
						stylesContent,
					});
				},
			),
		);
		this._register(
			this._configMdService.onDidEmitCommand(({ employeeId, command }) => {
				this._sendEvent("configmd.command", { employeeId, command });
			}),
		);

		// Forward imgui-originated chat sends through this controller's own
		// chat.send pipeline (creates a user message, persists, streams
		// deltas back to the webview UI). Only the chat panel controller
		// needs to react — canvas/taskboard panels would double-send.
		//
		// IMPORTANT: when the user types in the chat input, the webview's
		// `useChatStore.sendMessage` does an *optimistic* append of the user
		// message to its local `messages[]` state BEFORE invoking `chat.send`.
		// imgui submissions bypass that store entirely (they originate inside
		// a separate preview iframe and arrive at the host directly), so the
		// chat panel webview never sees the user-side bubble — it only sees
		// the assistant stream that follows. We compensate by firing an
		// explicit `chat.userMessageAppended` event so the webview can mirror
		// the same optimistic append the chat input would have done.
		this._register(
			this._configMdService.onDidRequestChatSend(
				({
					employeeId,
					message,
					agentSessionId,
					workspaceId,
					workspaceSessionId,
				}) => {
					if (this.panelType !== "chat") {
						return;
					}
					// Avoid duplicate sends when multiple chat panels are open: only
					// the panel currently displaying this employee should respond.
					// If no panel has registered yet (fresh open, before the webview
					// has finished sending its first `chat.activeSessionChanged`),
					// fall through and handle the message — losing it would feel
					// broken for the very first imgui submit after open.
					if (
						this._activeChatEmployeeId &&
						this._activeChatEmployeeId !== employeeId
					) {
						this.logService.info(
							`[AgentStudioWebviewController] imgui→chat.send for ${employeeId} ignored by panel ` +
							`showing ${this._activeChatEmployeeId}`,
						);
						return;
					}
					// Also avoid duplicate sends when multiple sessions for the same
					// employee are open: only the panel with the matching agent session
					// should respond.
					if (
						this._activeChatAgentSessionId &&
						this._activeChatAgentSessionId !== agentSessionId
					) {
						this.logService.info(
							`[AgentStudioWebviewController] imgui→chat.send for ${employeeId}/${agentSessionId} ignored by panel ` +
							`with session ${this._activeChatAgentSessionId}`,
						);
						return;
					}
					this.logService.info(
						`[AgentStudioWebviewController] imgui→chat.send ${employeeId} ` +
						`(workspaceId=${workspaceId || "<none>"}, sessionId=${agentSessionId || "<none>"})`,
					);
					// 1) Notify webview UI to append the user bubble (mirrors what
					//    the chat input would have done before sending).
					this._sendEvent("chat.userMessageAppended", {
						employeeId,
						agentSessionId,
						message: {
							id: `msg_${Date.now()}_user_imgui_${Math.random().toString(36).substring(2, 9)}`,
							role: "user",
							content: message,
							timestamp: new Date().toISOString(),
						},
					});
					// 2) Run the actual chat send pipeline (persist + stream).
					//    workspaceId is forwarded so the Fork-mode lazy-create path
					//    fires when needed — i.e. the preview was opened from a
					//    Fork chat panel even though the user has never sent a
					//    message there. Without it the message would be persisted
					//    against the Root default session and "vanish" relative to
					//    the Fork's view.
					void this._handleChatSend({
						employeeId,
						message,
						agentSessionId,
						workspaceId,
						workspaceSessionId,
					});
				},
			),
		);
	}

	// ─── Provider Handlers ─────────────────────────────────────────────────────

	private async _handleProvidersList(): Promise<IProviderInfo[]> {
		const providers = this.agentOSService.getModelProviders();
		const result: IProviderInfo[] = [];

		for (const provider of providers) {
			const authStatus = provider.getAuthStatus();
			let models: Array<{
				id: string;
				name: string;
				descriptionZh?: string;
				descriptionEn?: string;
				maxInputTokens?: number;
				maxOutputTokens?: number;
				maxAllowedSize?: number;
				supportsToolCall?: boolean;
				supportsImages?: boolean;
				supportsReasoning?: boolean;
				onlyReasoning?: boolean;
				temperature?: number;
				vendor?: string;
				credits?: string;
			}> = [];
			let agents: { id: string; name: string; models?: string[] }[] = [];

			try {
				const modelList = await provider.listModels();
				models = modelList.map((m) => ({
					id: m.id,
					name: m.name || m.id,
					descriptionZh: m.descriptionZh,
					descriptionEn: m.descriptionEn,
					maxInputTokens: m.maxInputTokens,
					maxOutputTokens: m.maxOutputTokens,
					maxAllowedSize: m.maxAllowedSize,
					supportsToolCall: m.supportsToolCall,
					supportsImages: m.supportsImages,
					supportsReasoning: m.supportsReasoning,
					onlyReasoning: m.onlyReasoning,
					temperature: m.temperature,
					vendor: m.vendor,
					credits: m.credits,
				}));
			} catch {
				// ignore
			}

			if (provider.supportsAgents && provider.listAgents) {
				try {
					const agentList = await provider.listAgents();
					agents = agentList.map((a) => ({
						id: a.id,
						name: a.name || a.id,
						models: a.models,
					}));
				} catch {
					// ignore
				}
			}

			result.push({
				id: provider.id,
				name: provider.name,
				authStatus: authStatus,
				supportsAgents: provider.supportsAgents,
				models,
				agents,
			});
		}

		return result;
	}

	private _handleProvidersSelect(payload: IProviderSelectPayload): void {
		this.logService.info(
			`[AgentStudio] _handleProvidersSelect: providerId=${payload.providerId}, modelId=${payload.modelId}, ` +
			`agentId=${payload.agentId}, employeeId=${payload.employeeId}, panelType=${this.panelType}`,
		);

		this.modelSelectorService.setSelection({
			providerId: payload.providerId,
			modelId: payload.modelId,
			agentId: payload.agentId,
		});
		if (payload.agentId) {
			this.modelSelectorService.setSelectedAgentId(payload.agentId);
		}

		// Persist provider/model/agent selection to the active employee's agent.yaml
		// and update the employee record in employees.json so it survives window reload
		if (payload.employeeId) {
			this._persistProviderSelection(payload).catch((err) => {
				this.logService.error(
					"[AgentStudio] _persistProviderSelection failed",
					err,
				);
			});
		} else {
			this.logService.warn(
				"[AgentStudio] _handleProvidersSelect: no employeeId — skipping persistence",
			);
		}
	}

	/**
	 * Persist provider selection to both agent.yaml and employees.json.
	 * Runs sequentially to avoid race conditions between file writes and
	 * the employees.changed event that triggers a UI reload.
	 */
	private async _persistProviderSelection(
		payload: IProviderSelectPayload,
	): Promise<void> {
		const { employeeId, providerId, agentId } = payload;
		let { modelId } = payload;

		// Normalize modelId: strip knot-style prefix like "knot/<uuid>::" so that
		// only the bare model name (e.g. "deepseek-v3.1") is persisted.
		if (modelId && modelId.includes("::")) {
			const bare = modelId.split("::").pop()!;
			this.logService.info(
				`[AgentStudio] Normalizing modelId: "${modelId}" → "${bare}"`,
			);
			modelId = bare;
		}

		// 1) Write to agent.yaml first (does NOT fire employees.changed)
		try {
			await this.agentStudioService.updateEmployeeModelConfig(employeeId!, {
				providerId,
				modelId,
				agentId,
			});
			this.logService.info(
				`[AgentStudio] agent.yaml updated for employee ${employeeId}`,
			);
		} catch (err) {
			this.logService.error(
				"[AgentStudio] Failed to persist model config to agent.yaml",
				err,
			);
		}

		// 2) Update employees.json (fires employees.changed → triggers UI reload)
		try {
			await this.agentStudioService.updateEmployee(employeeId!, {
				provider: providerId,
				model: modelId,
			});
			this.logService.info(
				`[AgentStudio] employees.json updated for employee ${employeeId}: provider=${providerId}, model=${modelId}`,
			);
		} catch (err) {
			this.logService.error(
				"[AgentStudio] Failed to update employee provider/model",
				err,
			);
		}
	}

	private _handleProvidersGetSelection(): IProviderSelectPayload | null {
		const selection = this.modelSelectorService.getSelection();
		if (!selection) {
			return null;
		}
		return {
			providerId: selection.providerId,
			modelId: selection.modelId,
			agentId: selection.agentId,
		};
	}

	/**
	 * Read provider/model/agent selection from the employee's agent.yaml.
	 * Falls back to the global ModelSelectorService selection if agent.yaml
	 * doesn't have valid model config.
	 */
	private async _handleProvidersGetSelectionForEmployee(
		employeeId: string,
	): Promise<IProviderSelectPayload | null> {
		if (!employeeId) {
			return this._handleProvidersGetSelection();
		}

		try {
			const config =
				await this.agentStudioService.getEmployeeModelConfig(employeeId);
			if (config && config.providerId && config.modelId) {
				this.logService.info(
					`[AgentStudio] Restored model selection from agent.yaml for employee ${employeeId}: ` +
					`${config.providerId}/${config.modelId}${config.agentId ? ` [agent: ${config.agentId}]` : ""}`,
				);
				return {
					providerId: config.providerId,
					modelId: config.modelId,
					agentId: config.agentId,
				};
			}
		} catch (err) {
			this.logService.debug(
				"[AgentStudio] Could not read model config from agent.yaml, falling back to global",
				err,
			);
		}

		// Fallback to global selection
		return this._handleProvidersGetSelection();
	}

	private _handleProvidersOpenSettings(payload: { providerId?: string }): void {
		this.modelSelectorService.openSettings(payload.providerId);
	}

	// ─── Skills ─────────────────────────────────────────────────────

	/**
	 * Handle `skills.list` message from webview.
	 * Returns all registered skills in a format suitable for the webview.
	 */
	private async _handleSkillsList(): Promise<Array<{ id: string; name: string; category: string; activation: string; description?: string }>> {
		console.error('[AgentStudioWebviewController._handleSkillsList] called');
		await this.skillRegistry.whenReady();
		console.error('[AgentStudioWebviewController._handleSkillsList] whenReady resolved');
		const skills = this.skillRegistry.getSkills();
		console.error(`[AgentStudioWebviewController._handleSkillsList] got ${skills.length} skills`);
		for (const s of skills) {
			console.error(`[AgentStudioWebviewController._handleSkillsList] skill: ${s.id} (${s.name})`);
		}
		return skills.map(skill => ({
			id: skill.id,
			name: skill.name,
			category: skill.category || 'uncategorized',
			activation: skill.activation,
			description: skill.description || undefined,
		}));
	}

	// ─── Public API ─────────────────────────────────────────────────────────────

	layout(width: number, height: number): void {
		// WebView auto-fills container, but notify if needed
		if (this._webview) {
			this.container.style.width = `${width}px`;
			this.container.style.height = `${height}px`;
		}
	}
}
