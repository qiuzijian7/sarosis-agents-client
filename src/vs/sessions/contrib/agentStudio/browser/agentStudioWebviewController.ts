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
import { IAgentStudioService, IAgentChatService, IAgentDelegationService, IAgentTaskBoardService, IChatStreamDelta } from '../common/agentStudio.js';
import { IEnvironmentService, type INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import type { RequestType, IResponseMessage, IEventMessage } from './messageProtocol.js';
import type { AgentStudioPanelType } from '../common/constants.js';

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
	) {
		super();
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

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' 'unsafe-inline'; img-src data: https:; font-src data:;">
	<title>Agent Studio</title>
	<link rel="stylesheet" nonce="${nonce}" href="${styleUri}">
	<style nonce="${nonce}">
		body { margin: 0; padding: 0; overflow: hidden; height: 100vh; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
		#root { width: 100%; height: 100%; }
	</style>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}">
		// Tell the React app which panel to render
		window.__AGENT_STUDIO_PANEL_TYPE__ = ${this.panelType ? `'${this.panelType}'` : 'undefined'};
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

	// ─── Message Router ─────────────────────────────────────────────────────────

	private async _handleMessage(message: IIncomingMessage): Promise<void> {
		if (!message || message.direction !== 'toHost') {
			return;
		}

		const { id, type, payload } = message;

		if (!id || !type) {
			return;
		}

		try {
			const result = await this._dispatch(type as RequestType, payload);
			this._sendResponse(id, type as RequestType, result);
		} catch (err: unknown) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.logService.error(`[AgentStudio] Error handling ${type}:`, error);
			this._sendError(id, type as RequestType, error.message);
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

			default:
				throw new Error(`Unknown message type: ${type}`);
		}
	}

	private async _handleChatSend(payload: Record<string, unknown>): Promise<unknown> {
		const employeeId = payload.employeeId as string;
		const message = payload.message as string;

		// Stream deltas will be sent as events to WebView
		const chatMessage = await this.agentChatService.sendMessage(
			employeeId,
			message,
			{
				model: payload.model as string | undefined,
				systemPrompt: payload.systemPrompt as string | undefined,
				temperature: payload.temperature as number | undefined,
				workspaceId: payload.workspaceId as string | undefined,
			},
			(delta: IChatStreamDelta) => {
				this._sendEvent('chat.stream.delta', {
					employeeId,
					sessionId: '',
					chunks: [delta],
				});
			},
		);

		// Send completion event
		this._sendEvent('chat.stream.complete', {
			employeeId,
			sessionId: '',
			message: chatMessage,
		});

		return chatMessage;
	}

	// ─── Outgoing Messages ──────────────────────────────────────────────────────

	private _sendResponse(id: string, type: RequestType, data: unknown): void {
		const response: IResponseMessage = {
			id,
			direction: 'toWebview' as const,
			type: `${type}.response` as `${RequestType}.response`,
			data,
		};
		this._webview?.postMessage(response);
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
		this._webview?.postMessage(event);
	}

	// ─── Service Event Listeners (push changes to WebView) ──────────────────────

	private _registerServiceListeners(): void {
		this._register(this.agentStudioService.onDidChangeEmployees(() => {
			this._sendEvent('employees.changed', {});
		}));

		this._register(this.agentStudioService.onDidChangeWorkspace((id) => {
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
