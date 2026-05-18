/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IAgentStudioService, IAgentChatService, IAgentDelegationService, IAgentTaskBoardService, ITaskOrchestrationService } from '../common/agentStudio.js';
import type { IChatStreamDelta } from '../common/agentStudio.js';
import type { AgentExportData } from '../../../common/agentStudioTypes.js';
import { IEnvironmentService, type INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import type { RequestType, IResponseMessage, IEventMessage } from './messageProtocol.js';
import type { AgentStudioPanelType } from '../common/constants.js';
import { IModelSelectorService } from '../common/modelSelector.js';
import { IAgentOSService } from '../common/agentOS.js';
import { IWorkbenchThemeService } from '../../../../workbench/services/themes/common/workbenchThemeService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
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
} from './messageProtocol.js';
import { WorkspaceSessionService, type IWorkspaceSessionService } from './workspaceSessionService.js';
import { ConfigMdService } from './configMdService.js';

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
	private readonly _configMdService: ConfigMdService;

	constructor(
		private readonly container: HTMLElement,
		private readonly panelType: AgentStudioPanelType | undefined,
		@IWebviewService private readonly webviewService: IWebviewService,
		@ILogService private readonly logService: ILogService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IAgentChatService private readonly agentChatService: IAgentChatService,
		@IAgentDelegationService private readonly agentDelegationService: IAgentDelegationService,
		@IAgentTaskBoardService private readonly agentTaskBoardService: IAgentTaskBoardService,
	@IModelSelectorService private readonly modelSelectorService: IModelSelectorService,
	@IAgentOSService private readonly agentOSService: IAgentOSService,
	@IWorkbenchThemeService private readonly workbenchThemeService: IWorkbenchThemeService,
	@IFileService private readonly fileService: IFileService,
	@ITaskOrchestrationService private readonly taskOrchestrationService: ITaskOrchestrationService,
	) {
		super();
		this._sessionService = new WorkspaceSessionService(logService, this.fileService, agentStudioService);
		this._configMdService = new ConfigMdService(logService, this.fileService, agentStudioService, agentChatService);
		this._register(this._configMdService);
		this._createWebview();
		this._registerServiceListeners();
	}

	private _getMediaUri(): URI {
		// The media folder is alongside the compiled source
		const appRoot = (this._environmentService as INativeEnvironmentService).appRoot;
		return URI.joinPath(URI.file(appRoot), 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'media');
	}

	private _createWebview(): void {
		const mediaUri = this._getMediaUri();

		this._webview = this.webviewService.createWebviewElement({
			title: 'Agent Studio',
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
		this._register(this._webview.onMessage(async (message) => {
			await this._handleMessage(message.message as IIncomingMessage);
		}));
	}

	private _getWebviewHtml(): string {
		// Generate CSP nonce
		const nonce = this._generateNonce();

		// Convert the media folder URI to a webview-accessible URI
		const mediaUri = this._getMediaUri();
		const scriptUri = asWebviewUri(URI.joinPath(mediaUri, 'webview.js'));
		const styleUri = asWebviewUri(URI.joinPath(mediaUri, 'webview.css'));

		const initialTheme = this.workbenchThemeService.getColorTheme().settingsId || '';

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' 'unsafe-inline'; img-src data: https:; font-src data:;">
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
		window.__AGENT_STUDIO_PANEL_TYPE__ = ${this.panelType ? `'${this.panelType}'` : 'undefined'};
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
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		for (let i = 0; i < 32; i++) {
			result += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return result;
	}

	// ─── Message Router ─────────────────────────────────────────────────────────

	private async _handleMessage(message: IIncomingMessage): Promise<void> {
		if (!message || message.direction !== 'toHost') {
			return;
		}

		const { id, type, payload } = message;

		if (!type) {
			return;
		}

		this.logService.info(`[AgentStudio] _handleMessage: type=${type}, id=${id}, panelType=${this.panelType}, payload=${JSON.stringify(payload)?.slice(0, 200)}`);

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

	private async _dispatch(type: RequestType, payload: unknown): Promise<unknown> {
		const p = payload as Record<string, unknown>;

		switch (type) {
			// ─── Employees ──────────────────────────────────────────
			case 'employees.list':
				return this.agentStudioService.getEmployees(p.workspaceId as string | undefined);
			case 'employees.get':
				return this.agentStudioService.getEmployee(p.id as string);
			case 'employees.create':
				return this.agentStudioService.createEmployee(p as Record<string, unknown>);
			case 'employees.update':
				return this.agentStudioService.updateEmployee(p.id as string, p.data as Record<string, unknown>);
			case 'employees.delete':
				return this.agentStudioService.deleteEmployee(p.id as string);
			case 'employees.selected':
				this.agentStudioService.fireSelectEmployee((p as Record<string, unknown>).employeeId as string | null ?? null);
				return undefined;
			case 'employees.export':
				return this.agentStudioService.exportEmployee((p as unknown as IEmployeeExportPayload).id);
			case 'employees.import':
				return this.agentStudioService.importEmployee(
					(p as unknown as IEmployeeImportPayload).exportData as unknown as AgentExportData,
					(p as unknown as IEmployeeImportPayload).workspaceId,
				);
			case 'employees.syncPositions': {
				// Sync multiple agent positions to agent.yaml + employees.json
				const positions = p.positions as Array<{ id: string; position: { x: number; y: number } }>;
				if (positions && Array.isArray(positions)) {
					const promises = positions.map(({ id, position }) =>
						this.agentStudioService.updateEmployeePosition(id, position).catch(err =>
							this.logService.debug(`[AgentStudio] syncPositions: failed for ${id}`, err),
						),
					);
					await Promise.all(promises);
				}
				return undefined;
			}

		// ─── Workspaces ─────────────────────────────────────────
		case 'workspace.list':
			return this.agentStudioService.getWorkspaces();
		case 'workspace.get':
			return this.agentStudioService.getWorkspace(p.id as string);
		case 'workspace.create':
			return this.agentStudioService.createWorkspace(p as Record<string, unknown>);
		case 'workspace.delete':
			return this.agentStudioService.deleteWorkspace(p.id as string);
		case 'workspace.update':
			return this.agentStudioService.updateWorkspace(p.id as string, p as Record<string, unknown>);
		case 'workspace.updateLayout':
			return this.agentStudioService.updateWorkspaceLayout(p.workspaceId as string, {
				nodes: p.nodes as unknown[],
				edges: p.edges as unknown[],
				viewport: p.viewport as { x: number; y: number; zoom: number } | undefined,
			} as never);

			// ─── Connections ────────────────────────────────────────
			case 'workspace.connections.list':
				return this.agentStudioService.getConnections(p.workspaceId as string);
			case 'workspace.connections.add':
				return this.agentStudioService.addConnection(p.workspaceId as string, {
					sourceId: p.sourceId as string,
					targetId: p.targetId as string,
					type: p.type as never,
					label: p.label as string | undefined,
				});
			case 'workspace.connections.remove':
				return this.agentStudioService.removeConnection(p.workspaceId as string, p.connectionId as string);

			// ─── Chat ───────────────────────────────────────────────
			case 'chat.send':
				return this._handleChatSend(p);
			case 'chat.history':
				return this.agentChatService.getHistory(p.employeeId as string, p.sessionId as string | undefined);
			case 'chat.clear':
				return this.agentChatService.clearHistory(p.employeeId as string, p.sessionId as string | undefined);
			case 'chat.cancel':
				this.agentChatService.cancelStream(p.employeeId as string);
				return undefined;

			// ─── Delegations ────────────────────────────────────────
			case 'delegation.list':
				return this.agentDelegationService.getDelegations(p.workspaceId as string | undefined);
			case 'delegation.get':
				return this.agentDelegationService.getDelegation(p.id as string);
			case 'delegation.create':
				return this.agentDelegationService.createDelegation(p as Record<string, unknown>);
			case 'delegation.update':
				return this.agentDelegationService.updateDelegation(p.id as string, p as Record<string, unknown>);
			case 'delegation.delete':
				return this.agentDelegationService.deleteDelegation(p.id as string);
		case 'delegation.autoPlan':
			return this.agentDelegationService.executePlan(p.goal as string, p.workspaceId as string);

		// ─── Task Board ─────────────────────────────────────────
		case 'taskBoard.list':
			return this.agentTaskBoardService.getTasks(p.workspaceId as string | undefined);
		case 'taskBoard.create':
			return this.agentTaskBoardService.createTask(p as Record<string, unknown>);
		case 'taskBoard.update':
			return this.agentTaskBoardService.updateTask(p.id as string, p as Record<string, unknown>);
		case 'taskBoard.delete':
			return this.agentTaskBoardService.deleteTask(p.id as string);
		case 'taskBoard.archive':
			return this.agentTaskBoardService.archiveTask(p.id as string);

		// ─── Sessions ───────────────────────────────────────────
			case 'session.list':
				return this.agentStudioService.getSessions();
			case 'session.get':
				return this.agentStudioService.getSession(p.id as string);
			case 'session.create':
				return this.agentStudioService.createSession(p as Record<string, unknown>);
			case 'session.delete':
				return this.agentStudioService.deleteSession(p.id as string);

		// ─── Providers (Model Provider 列表) ────────────────────
			case 'providers.list':
				return this._handleProvidersList();
			case 'providers.select':
				return this._handleProvidersSelect(p as unknown as IProviderSelectPayload);
			case 'providers.getSelection':
				return this._handleProvidersGetSelection();
			case 'providers.getSelectionForEmployee':
				return this._handleProvidersGetSelectionForEmployee(p.employeeId as string);
			case 'providers.openSettings':
				return this._handleProvidersOpenSettings(p as { providerId?: string });

		// ─── Workspace Sessions (Fork) ─────────────────────────
			case 'workspaceSession.list':
				return this._sessionService.getSessions(p.workspaceId as string);
			case 'workspaceSession.get':
				return this._sessionService.getSession(p.workspaceId as string, p.sessionId as string);
			case 'workspaceSession.create': {
				const { workspaceId, name, source, scheduledTaskId, idempotencyKey } = p as unknown as IWorkspaceSessionCreatePayload;
				return this._sessionService.createSession({ workspaceId, name, source: source as any, scheduledTaskId, idempotencyKey });
			}
			case 'workspaceSession.delete':
				return this._sessionService.deleteSession(p.workspaceId as string, p.sessionId as string);
			case 'workspaceSession.archive':
				return this._sessionService.archiveSession(p.workspaceId as string, p.sessionId as string);
			case 'workspaceSession.switch':
				return this._sessionService.setActiveSession(p.workspaceId as string, p.sessionId as string);
			case 'workspaceSession.switchRoot':
				return this._sessionService.setActiveSession(p.workspaceId as string, null);
			case 'workspaceSession.updateStatus':
				return this._sessionService.updateSessionStatus(
					p.workspaceId as string,
					p.sessionId as string,
					p.status as any,
					p.error as string | undefined,
				);

		// ─── Agent Sessions (per-agent, Root mode) ─────────────
			case 'agentSession.list':
				return (this.agentChatService as any).listAgentSessions(p.employeeId as string);
			case 'agentSession.create':
				return (this.agentChatService as any).createAgentSession(p.employeeId as string, p.name as string | undefined);
			case 'agentSession.rename':
				return (this.agentChatService as any).renameAgentSession(p.employeeId as string, p.sessionId as string, p.name as string);
			case 'agentSession.delete':
				return (this.agentChatService as any).deleteAgentSession(p.employeeId as string, p.sessionId as string);
			case 'agentSession.getActive':
				return (this.agentChatService as any).getOrCreateActiveSession(p.employeeId as string, p.name as string | undefined);

		// ─── Orchestration ─────────────────────────────────────
			case 'orchestration.plan':
				return this.taskOrchestrationService.createPlan(p.goal as string, p.workspaceId as string, p.plannerId as string);
			case 'orchestration.approve':
				return this.taskOrchestrationService.approvePlan(p.planId as string);
			case 'orchestration.reject':
				return this.taskOrchestrationService.rejectPlan(p.planId as string);
			case 'orchestration.getPlan':
				return this.taskOrchestrationService.getPlan(p.planId as string);
			case 'orchestration.listPlans':
				return this.taskOrchestrationService.listPlans(p.workspaceId as string | undefined);
			case 'orchestration.taskAction': {
				const actionPayload = p as unknown as IOrchestrationTaskActionPayload;
				return this.taskOrchestrationService.taskAction(actionPayload.planId, actionPayload.taskId, actionPayload.action);
			}

		// ─── ConfigMD ─────────────────────────────────────────
			case 'configmd.getResource':
				return this._configMdService.resolveState(p.employeeId as string);
			case 'configmd.readSource':
				return this._configMdService.readSource(p.employeeId as string);
			case 'configmd.writeSource': {
				const wp = p as unknown as IConfigMdWriteSourcePayload;
				return this._configMdService.writeSource(wp.employeeId, wp.markdown, {
					origin: wp.origin,
					baseVersion: wp.baseVersion,
				});
			}
			case 'configmd.applyPatch': {
				const ap = p as unknown as IConfigMdApplyPatchPayload;
				return this._configMdService.applyPatch(ap.employeeId, ap.patches, {
					origin: ap.origin,
					baseVersion: ap.baseVersion,
				});
			}
			case 'configmd.renderHtml': {
				const rp = p as unknown as IConfigMdRenderHtmlPayload;
				return this._configMdService.renderHtml(rp.employeeId, rp.markdown);
			}
			case 'confightml.event':
			case 'configmd.event': {
				const ep = p as unknown as IConfigMdEventPayload;
				return this._configMdService.handleHtmlEvent(ep.employeeId, ep.eventName, ep.payload, ep.agentSessionId);
			}
			case 'configmd.chatSend': {
				const cp = p as unknown as IConfigMdChatSendPayload;
				return this._configMdService.handleChatSend(cp.employeeId, cp.message, {
					context: cp.context,
					showInChat: cp.showInChat,
					agentSessionId: cp.agentSessionId,
				});
			}
			case 'configmd.chatHistory':
				return this.agentChatService.getHistory(p.employeeId as string, p.sessionId as string | undefined);
			case 'configmd.notify':
				this.logService.info(`[ConfigMD] Notification from ${p.employeeId}: ${p.message} [${p.level || 'info'}]`);
				return undefined;

			default:
				throw new Error(`Unknown message type: ${type}`);
		}
	}

	private _handleChatSend(payload: Record<string, unknown>): { status: string; employeeId: string } {
		const employeeId = payload.employeeId as string;
		const message = payload.message as string;
		let agentSessionId = payload.agentSessionId as string | undefined;
		const workspaceSessionId = payload.workspaceSessionId as string | undefined;
		const workspaceId = payload.workspaceId as string | undefined;

		// If we're in a Fork but no agentSessionId was provided, lazily create one
		if (workspaceId && workspaceSessionId && !agentSessionId) {
			this._ensureAgentSessionAndSend(employeeId, message, workspaceId, workspaceSessionId, payload);
			return { status: 'streaming', employeeId };
		}

		// Persist the user message to chat history so it survives refreshes.
		const userMessage: import('../../../common/agentStudioTypes.js').ChatMessage = {
			id: `msg_${Date.now()}_user_${Math.random().toString(36).substring(2, 9)}`,
			role: 'user',
			content: message,
			employeeId,
			agentSessionId,
			timestamp: new Date().toISOString(),
		};
		this.agentChatService.appendMessage(employeeId, userMessage).catch(err =>
			this.logService.error('[AgentStudio] Failed to persist user message:', err),
		);

		this._runChatStream(employeeId, message, payload);

		return { status: 'streaming', employeeId };
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
			const entry = await this._sessionService.ensureAgentSession(workspaceId, workspaceSessionId, employeeId);
			const agentSessionId = entry.sessionId;

			// Persist the user message with the resolved agentSessionId
			const userMessage: import('../../../common/agentStudioTypes.js').ChatMessage = {
				id: `msg_${Date.now()}_user_${Math.random().toString(36).substring(2, 9)}`,
				role: 'user',
				content: message,
				employeeId,
				agentSessionId,
				timestamp: new Date().toISOString(),
			};
			this.agentChatService.appendMessage(employeeId, userMessage).catch(err =>
				this.logService.error('[AgentStudio] Failed to persist user message:', err),
			);

			// Notify webview of the newly assigned agentSessionId
			this._sendEvent('workspace.sessionUpdated', {
				workspaceId,
				sessionId: workspaceSessionId,
				agentId: employeeId,
				agentSessionId,
			});

			// Run the chat stream with the resolved agentSessionId
			const enrichedPayload = { ...payload, agentSessionId };
			this._runChatStream(employeeId, message, enrichedPayload);
		} catch (err) {
			this.logService.error('[AgentStudio] _ensureAgentSessionAndSend failed:', err);
			this._sendEvent('chat.stream.error', {
				employeeId,
				sessionId: '',
				error: `Failed to create agent session: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	/**
	 * Run the chat stream in the background. This is fire-and-forget from
	 * the webview's perspective — all results flow through events.
	 */
	private async _runChatStream(employeeId: string, message: string, payload: Record<string, unknown>): Promise<void> {
		const agentSessionId = payload.agentSessionId as string | undefined;
		const sessionIdForEvent = agentSessionId || '';
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
				},
				(delta: IChatStreamDelta) => {
					// Capture provider session ID from metadata (e.g. Knot AG-UI threadId)
					if (!capturedProviderSessionId && delta.metadata) {
						const psid = (delta.metadata as Record<string, unknown>).sessionId
							|| (delta.metadata as Record<string, unknown>).threadId
							|| (delta.metadata as Record<string, unknown>).thread_id;
						if (typeof psid === 'string' && psid) {
							capturedProviderSessionId = psid;
						}
					}
					this._sendEvent('chat.stream.delta', {
						employeeId,
						sessionId: sessionIdForEvent,
						chunks: [delta],
					});
				},
			);

			// If we captured a provider session ID, persist it to the session index
			if (capturedProviderSessionId && agentSessionId) {
				(this.agentChatService as any).updateProviderSessionId(
					employeeId, agentSessionId, capturedProviderSessionId,
				).catch((err: unknown) =>
					this.logService.error('[AgentStudio] Failed to store providerSessionId:', err),
				);
			}

			this._sendEvent('chat.stream.complete', {
				employeeId,
				sessionId: sessionIdForEvent,
				message: chatMessage,
			});
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			this.logService.error(`[AgentStudio] _runChatStream error for ${employeeId}:`, error);

			this._sendEvent('chat.stream.error', {
				employeeId,
				sessionId: sessionIdForEvent,
				error: errMsg,
			});

			this._sendEvent('chat.stream.complete', {
				employeeId,
				sessionId: sessionIdForEvent,
				message: { content: '', error: errMsg },
			});
		}
	}

	// ─── Outgoing Messages ──────────────────────────────────────────────────────

	private _sendResponse(id: string, type: RequestType, data: unknown): void {
		const response: IResponseMessage = {
			id,
			direction: 'toWebview' as const,
			type: `${type}.response` as `${RequestType}.response`,
			data,
		};
		if (this._webview) {
			this._webview.postMessage(response).then(
				(delivered) => {
					if (!delivered) {
						this.logService.warn(`[AgentStudio] _sendResponse FAILED to deliver: type=${type}.response, id=${id}`);
					}
				},
				(err) => {
					this.logService.error(`[AgentStudio] _sendResponse REJECTED: type=${type}.response`, err);
				}
			);
		} else {
			this.logService.warn(`[AgentStudio] _sendResponse: no webview for type=${type}.response, id=${id}`);
		}
	}

	private _sendError(id: string, type: RequestType, message: string): void {
		const response: IResponseMessage = {
			id,
			direction: 'toWebview' as const,
			type: `${type}.response` as `${RequestType}.response`,
			error: { code: 'ERROR', message },
		};
		this._webview?.postMessage(response);
	}

	private _sendEvent(type: string, data: unknown): void {
		const event: IEventMessage = {
			direction: 'toWebview' as const,
			type: type as IEventMessage['type'],
			data,
		};
		this.logService.info(`[AgentStudio] _sendEvent: type=${type}, hasWebview=${!!this._webview}, panelType=${this.panelType}`);
		if (this._webview) {
			const result = this._webview.postMessage(event);
			if (type.startsWith('chat.stream')) {
				result.then(
					(delivered) => {
						if (!delivered) {
							this.logService.warn(`[AgentStudio] postMessage FAILED to deliver: type=${type} — webview iframe not ready or missing`);
						}
					},
					(err) => {
						this.logService.error(`[AgentStudio] postMessage REJECTED: type=${type}`, err);
					}
				);
			}
		}
	}

	// ─── Service Event Listeners (push changes to WebView) ──────────────────────

	private _registerServiceListeners(): void {
		this._register(this.agentStudioService.onDidChangeEmployees(() => {
			this._sendEvent('employees.changed', {});
		}));

		this._register(this.agentStudioService.onDidSelectEmployee((employeeId: string | null) => {
			this.logService.info(`[AgentStudio] onDidSelectEmployee → _sendEvent('employee.selected', {employeeId=${employeeId}}) panelType=${this.panelType}`);
			this._sendEvent('employee.selected', { employeeId });
		}));

		this._register(this.agentStudioService.onDidChangeWorkspace((id: string) => {
			this._sendEvent('workspace.changed', { workspaceId: id });
		}));

		this._register(this.agentDelegationService.onDidChangeDelegations(() => {
			this._sendEvent('delegations.changed', {});
		}));

		this._register(this.agentTaskBoardService.onDidChangeTaskBoard(() => {
			this._sendEvent('taskBoard.changed', {});
		}));

		// Listen for active workspace switching from the global toolbar
		const onActiveWorkspaceChanged = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.workspaceId) {
				this._sendEvent('workspace.activeChanged', { workspaceId: detail.workspaceId });
			}
		};
		document.addEventListener('agent-studio:active-workspace-changed', onActiveWorkspaceChanged);
		this._register({ dispose: () => document.removeEventListener('agent-studio:active-workspace-changed', onActiveWorkspaceChanged) });

		// Listen for Model Provider changes (auth status, model list, provider add/remove)
		this._register(this.modelSelectorService.onDidChangeAvailableModels(() => {
			this.logService.info('[AgentStudio] Model providers changed, notifying webview');
			this._handleProvidersList().then(providers => {
				this._sendEvent('providers.changed', { providers });
			}).catch(err => {
				this.logService.error('[AgentStudio] Failed to get providers for event', err);
			});
		}));

		// Listen for VS Code native theme changes — push to WebView immediately
		this._register(this.workbenchThemeService.onDidColorThemeChange((newTheme) => {
			const theme = newTheme.settingsId || newTheme.label;
			this.logService.info(`[AgentStudio] VS Code theme changed to "${theme}", notifying webview`);
			this._sendEvent('theme.changed', { theme });
		}));

		// Listen for Workspace Session changes (Fork CRUD)
		this._register(this._sessionService.onDidChangeWorkspaceSessions((workspaceId: string) => {
			this._sendEvent('workspace.sessionUpdated', { workspaceId });
		}));

		// Listen for Orchestration plan/task changes
		this._register(this.taskOrchestrationService.onDidChangePlan((plan) => {
			this._sendEvent('orchestration.planUpdated', plan);
		}));
		this._register(this.taskOrchestrationService.onDidChangeTask(({ planId, task }) => {
			this._sendEvent('orchestration.taskUpdated', { planId, task });
		}));

		// Listen for ConfigMD source / html / command events to push to WebView
		this._register(this._configMdService.onDidChangeSource(({ employeeId, markdown, version, origin }) => {
			this._sendEvent('configmd.sourceChanged', { employeeId, markdown, version, origin });
		}));
		this._register(this._configMdService.onDidRenderHtml(({ employeeId, html, version, stylesContent }) => {
			this._sendEvent('configmd.htmlRendered', { employeeId, html, version, stylesContent });
		}));
		this._register(this._configMdService.onDidEmitCommand(({ employeeId, command }) => {
			this._sendEvent('configmd.command', { employeeId, command });
		}));
	}

	// ─── Provider Handlers ─────────────────────────────────────────────────────

	private async _handleProvidersList(): Promise<IProviderInfo[]> {
		const providers = this.agentOSService.getModelProviders();
		const result: IProviderInfo[] = [];

		for (const provider of providers) {
			const authStatus = provider.getAuthStatus();
			let models: { id: string; name: string }[] = [];
			let agents: { id: string; name: string; models?: string[] }[] = [];

			try {
				const modelList = await provider.listModels();
				models = modelList.map(m => ({ id: m.id, name: m.name || m.id }));
			} catch {
				// ignore
			}

			if (provider.supportsAgents && provider.listAgents) {
				try {
					const agentList = await provider.listAgents();
					agents = agentList.map(a => ({ id: a.id, name: a.name || a.id, models: a.models }));
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
			`[AgentStudio] _handleProvidersSelect: providerId=${payload.providerId}, modelId=${payload.modelId}, `
			+ `agentId=${payload.agentId}, employeeId=${payload.employeeId}, panelType=${this.panelType}`
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
			this._persistProviderSelection(payload).catch(err => {
				this.logService.error('[AgentStudio] _persistProviderSelection failed', err);
			});
		} else {
			this.logService.warn('[AgentStudio] _handleProvidersSelect: no employeeId — skipping persistence');
		}
	}

	/**
	 * Persist provider selection to both agent.yaml and employees.json.
	 * Runs sequentially to avoid race conditions between file writes and
	 * the employees.changed event that triggers a UI reload.
	 */
	private async _persistProviderSelection(payload: IProviderSelectPayload): Promise<void> {
		const { employeeId, providerId, agentId } = payload;
		let { modelId } = payload;

		// Normalize modelId: strip knot-style prefix like "knot/<uuid>::" so that
		// only the bare model name (e.g. "deepseek-v3.1") is persisted.
		if (modelId && modelId.includes('::')) {
			const bare = modelId.split('::').pop()!;
			this.logService.info(`[AgentStudio] Normalizing modelId: "${modelId}" → "${bare}"`);
			modelId = bare;
		}

		// 1) Write to agent.yaml first (does NOT fire employees.changed)
		try {
			await this.agentStudioService.updateEmployeeModelConfig(employeeId!, {
				providerId,
				modelId,
				agentId,
			});
			this.logService.info(`[AgentStudio] agent.yaml updated for employee ${employeeId}`);
		} catch (err) {
			this.logService.error('[AgentStudio] Failed to persist model config to agent.yaml', err);
		}

		// 2) Update employees.json (fires employees.changed → triggers UI reload)
		try {
			await this.agentStudioService.updateEmployee(employeeId!, {
				provider: providerId,
				model: modelId,
			});
			this.logService.info(`[AgentStudio] employees.json updated for employee ${employeeId}: provider=${providerId}, model=${modelId}`);
		} catch (err) {
			this.logService.error('[AgentStudio] Failed to update employee provider/model', err);
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
	private async _handleProvidersGetSelectionForEmployee(employeeId: string): Promise<IProviderSelectPayload | null> {
		if (!employeeId) {
			return this._handleProvidersGetSelection();
		}

		try {
			const config = await this.agentStudioService.getEmployeeModelConfig(employeeId);
			if (config && config.providerId && config.modelId) {
				this.logService.info(
					`[AgentStudio] Restored model selection from agent.yaml for employee ${employeeId}: `
					+ `${config.providerId}/${config.modelId}${config.agentId ? ` [agent: ${config.agentId}]` : ''}`,
				);
				return {
					providerId: config.providerId,
					modelId: config.modelId,
					agentId: config.agentId,
				};
			}
		} catch (err) {
			this.logService.debug('[AgentStudio] Could not read model config from agent.yaml, falling back to global', err);
		}

		// Fallback to global selection
		return this._handleProvidersGetSelection();
	}

	private _handleProvidersOpenSettings(payload: { providerId?: string }): void {
		this.modelSelectorService.openSettings(payload.providerId);
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
