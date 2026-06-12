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
	IConfigHtmlService,
} from "../common/agentStudio.js";
import { ISkillRegistry } from "../common/skills.js";
import { IWorkflowStorageService } from "../common/workflowStorage.js";
import { IWorkflowExecutionService } from "../common/workflowExecutionService.js";
import { IAgentStudioWebviewPool } from "./agentStudioWebviewPool.js";
import type { IChatStreamDelta } from "../common/agentStudio.js";
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
import { WORKSPACE_DATA_DIR, AGENTS_DIR, AGENT_STUDIO_WEBVIEW_ORIGIN } from "../common/constants.js";
import { IModelSelectorService } from "../common/modelSelector.js";
import { IAgentOSService } from "../common/agentOS.js";
import { IWorktreeService } from "../../worktree/common/worktreeService.js";
import type { IToolApprovalHandler, IToolApprovalRequest } from "../common/providers.js";
import { ToolApprovalDecision } from "../common/providers.js";
import { workflowAppliedEmitter } from './providers/tool/builtinToolProvider.js';
import { IWorkbenchThemeService } from "../../../../workbench/services/themes/common/workbenchThemeService.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { VSBuffer } from "../../../../base/common/buffer.js";
import { IModelService } from "../../../../editor/common/services/model.js";
import type { IDiffEditorOptions } from "../../../../editor/common/config/editorOptions.js";
import { IOpenerService } from "../../../../platform/opener/common/opener.js";
import { IRequestService, asText } from "../../../../platform/request/common/request.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { CancellationToken } from "../../../../base/common/cancellation.js";
import {
	IEditorService,
	SIDE_GROUP,
} from "../../../../workbench/services/editor/common/editorService.js";
import type { IResourceDiffEditorInput, IResourceMultiDiffEditorInput, ITextDiffEditorPane } from "../../../../workbench/common/editor.js";
import {
	GroupsOrder,
	IEditorGroupsService,
} from "../../../../workbench/services/editor/common/editorGroupsService.js";
import type {
	IProviderInfo,
	IProviderSelectPayload,
	IWorkspaceSessionCreatePayload,
	IOrchestrationTaskActionPayload,
	IConfigMdEventPayload,
	IConfigMdChatSendPayload,
	IConfigMdHtmlGeneratePayload,
	IConfigMdWriteSourcePayload,
	IConfigMdApplyPatchPayload,
	IConfigMdRenderHtmlPayload,
	IFileOpenPayload,
	IFileOpenUntitledTextPayload,
	IFileApplyCodePayload,
	IChatJumpToCheckpointPayload,
	IChatOpenCheckpointDiffPayload,
	IChatRevertAllCheckpointsPayload,
	IChatKeepAllCheckpointsPayload,
	IChatOpenAllCheckpointsDiffPayload,
	IChatToolApprovePayload,
	IChatToolApprovalRequestPayload,
	IChatAddCheckpointPayload,
	IChatGetCheckpointPayload,
	IChatListCheckpointsPayload,
	IChatDeleteCheckpointPayload,
	IMemoryListPayload,
	IMemoryDeletePayload,
	IMemoryListL0Response,
	IMemoryListL1Response,
	IMemoryDeleteResponse,
	IMemoryL0Item,
	IMemoryL1Item,
} from "./messageProtocol.js";
import type {
	ICheckpoint,
} from "../common/checkpointTypes.js";
import { ICheckpointService } from "../common/checkpointService.js";
import {
	WorkspaceSessionService,
	type IWorkspaceSessionService,
} from "./workspaceSessionService.js";
import { HtmlPreviewEditorInput } from "./htmlPreviewEditorInput.js";
import { TaskOverviewEditorInput } from "./taskOverviewEditorInput.js";
import { AgentSettingsEditorInput } from "./agentSettingsEditorInput.js";

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
	 * The (agentId, agentSessionId) pair this chat panel is currently
	 * showing. Updated by the webview via `chat.activeSessionChanged`
	 * whenever the user picks a different agent or switches session.
	 *
	 * Used (a) to filter `onDidRequestChatSend` events so only the chat
	 * panel actually showing the target agent handles imgui submits,
	 * preventing duplicate sends across multiple chat panels, and
	 * (b) to register into `IConfigHtmlService.setActiveAgentSession` so
	 * the preview pane can route imgui submits into the correct Fork
	 * session.
	 */
	private _activeChatAgentId: string | undefined;
	private _activeChatAgentSessionId: string | undefined;

	/** Pending tool approval requests: toolCallId → resolve function */
	private readonly _pendingToolApprovals = new Map<string, { resolve: (decision: ToolApprovalDecision) => void }>();

	/**
	 * Perf instrumentation: epoch ms when this controller was constructed
	 * (i.e. when the host started opening this panel). Injected into the
	 * webview HTML so the React app can measure program-start → first-paint.
	 */
	private readonly _perfCreateTs = Date.now();

	constructor(
		private readonly container: HTMLElement,
		private readonly panelType: AgentStudioPanelType | undefined,
		private readonly initialData: unknown = undefined,
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
		@IWorkspaceContextService
		private readonly workspaceContextService: IWorkspaceContextService,
		@ITaskOrchestrationService
		private readonly taskOrchestrationService: ITaskOrchestrationService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService
		private readonly editorGroupsService: IEditorGroupsService,
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IConfigHtmlService private readonly _configHtmlService: IConfigHtmlService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@IModelService private readonly modelService: IModelService,
		@IRequestService private readonly requestService: IRequestService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorktreeService private readonly worktreeService: IWorktreeService,
		@ICheckpointService private readonly checkpointService: ICheckpointService,
		@IWorkflowStorageService private readonly workflowStorageService: IWorkflowStorageService,
		@IWorkflowExecutionService private readonly workflowExecutionService: IWorkflowExecutionService,
		@IAgentStudioWebviewPool private readonly webviewPool: IAgentStudioWebviewPool,
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

		// Checkpoint: forward newly created checkpoints to the webview so it can
		// render an inline checkpoint card without an extra round-trip.
		this._register(
			this.checkpointService.onDidCreateCheckpoint((checkpoint) => {
				this._sendEvent('chat.checkpointCreated', {
					id: checkpoint.id,
					agentId: checkpoint.agentId,
					sessionId: checkpoint.sessionId,
					type: checkpoint.type,
					label: checkpoint.label,
					description: checkpoint.description,
					createdAt: checkpoint.createdAt,
					fileSnapshotIds: checkpoint.fileSnapshotIds,
					isGhost: checkpoint.isGhost,
					messageId: checkpoint.messageId,
					files: checkpoint.files,
				});
			}),
		);

		// Workflow execution: forward status updates and node state changes to webview
		// so the editor can show progress (current node, breakpoints, completion).
		// Always send the full IWorkflowExecutionState snapshot so the webview's
		// flat-detail handler (executionId/status/currentNodeId/nodeStates/breakpoints)
		// gets everything it needs in one event.
		const serializeExecutionState = (state: import('../common/workflowExecutionService.js').IWorkflowExecutionState) => ({
			executionId: state.executionId,
			workflowId: state.workflowId,
			status: state.status,
			currentNodeId: state.currentNodeId,
			startTime: state.startTime,
			endTime: state.endTime,
			error: state.error,
			nodeStates: Object.fromEntries(state.nodeStates),
			breakpoints: state.breakpoints ? Array.from(state.breakpoints) : undefined,
		});

		const sendFullStateFor = (executionId: string): boolean => {
			const fullState = this.workflowExecutionService.getExecutionState(executionId);
			if (!fullState) {
				return false;
			}
			this._sendEvent('workflow.executionUpdate', serializeExecutionState(fullState));
			return true;
		};

		this._register(
			this.workflowExecutionService.onDidExecutionStatusChange((state) => {
				this._sendEvent('workflow.executionUpdate', serializeExecutionState(state));
			}),
		);
		this._register(
			this.workflowExecutionService.onDidNodeExecutionStatusChange((e) => {
				sendFullStateFor(e.executionId);
			}),
		);
		this._register(
			this.workflowExecutionService.onDidChangeBreakpoints((e) => {
				if (!sendFullStateFor(e.executionId)) {
					// No matching execution (e.g. execution already cleared) — send minimal payload
					this._sendEvent('workflow.executionUpdate', {
						executionId: e.executionId,
						breakpoints: e.nodeIds,
					});
				}
			}),
		);

		// P4: forward fine-grained trace events to webview so the workflow
		// owner agent's chat can render subagent cards.
		this._register(
			this.workflowExecutionService.onDidExecutionTrace((trace) => {
				this._sendEvent('workflow.executionTrace', { ...trace });
			}),
		);
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
		this._createWebviewAsync();
	}

	private async _createWebviewAsync(): Promise<void> {
		const mediaUri = this._getMediaUri();

		// ── WAIT-FOR-POOL: if the pool is currently warming, wait for it ──
		// Creating a cold-path webview while the pool is spawning a renderer
		// process causes contention (same shared origin → same Chromium renderer).
		// Both end up taking 30+ seconds instead of 15. Better to wait for the
		// pool's instance and use the hot-path.
		if (!this.webviewPool.hasWarmWebview && this.webviewPool.isWarming) {
			this.logService.info(
				`[AS-PERF][wait-for-pool] panelType=${this.panelType} — pool is warming, waiting for hot instance...`
			);
			const waitStart = Date.now();
			const POOL_WAIT_TIMEOUT_MS = 120_000; // 2 minutes max wait
			const gotInstance = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => {
					sub.dispose();
					resolve(false);
				}, POOL_WAIT_TIMEOUT_MS);
				const sub = this.webviewPool.onDidBecomeAvailable(() => {
					clearTimeout(timer);
					sub.dispose();
					resolve(true);
				});
			});
			this.logService.info(
				`[AS-PERF][wait-for-pool] panelType=${this.panelType} — ` +
				`waited ${Date.now() - waitStart}ms, pool ${gotInstance ? 'delivered' : 'timed out'}`
			);
		}

		// ── HOT PATH: try to acquire a pre-warmed webview from the pool ──
		// The pool holds a fully bootstrapped webview (HTML rendered, React
		// bundle loaded and mounted). If available, we skip the entire cold
		// renderer-spawn + HTML parse + bundle-load path (saves 25-40s in dev).
		const pooled = this.webviewPool.acquire();
		if (pooled) {
			this.logService.info(
				`[AS-PERF][hot-path] panelType=${this.panelType} — acquired warm webview from pool ` +
				`(was warm for ${Date.now() - pooled.readyTs}ms)`
			);

			this._webview = pooled.webview;
			this._register(this._webview);

			// CRITICAL: iframes cannot be re-parented without losing state (Chromium
			// limitation). Use absolute-position overlay: keep the pool container on
			// document.body and position it precisely over our panel container.
			const poolContainer = pooled.container;
			poolContainer.style.position = 'absolute';
			poolContainer.style.overflow = '';
			poolContainer.removeAttribute('data-agent-studio-pool');

			// Track our panel container's geometry and mirror it onto the pool container.
			const syncLayout = () => {
				const rect = this.container.getBoundingClientRect();
				poolContainer.style.left = `${rect.left}px`;
				poolContainer.style.top = `${rect.top}px`;
				poolContainer.style.width = `${rect.width}px`;
				poolContainer.style.height = `${rect.height}px`;
			};
			syncLayout();

			// Re-sync on resize / layout changes.
			const resizeObserver = new ResizeObserver(syncLayout);
			resizeObserver.observe(this.container);
			this._register({ dispose: () => resizeObserver.disconnect() });
			this._register({ dispose: () => poolContainer.remove() });

			// CRITICAL: register the message handler BEFORE sending pool.activate.
			// When the webview processes pool.activate it will immediately start
			// making RPC requests (agents.list, workspace.list, etc.) — if the
			// onMessage handler isn't registered yet, those requests are lost and
			// the webview shows blank content (pending requests time out).
			this._register(
				this._webview.onMessage(async (message) => {
					await this._handleMessage(message.message as IIncomingMessage);
				}),
			);

			// Notify the webview to switch from '__pooled__' to the real panelType
			// and inject runtime data (theme, initial data, perf timestamps, etc.)
			this._webview.postMessage({
				direction: 'toWebview',
				type: 'pool.activate',
				data: {
					panelType: this.panelType ?? undefined,
					initialTheme: this.workbenchThemeService.getColorTheme().settingsId || '',
					cspNonce: undefined, // already set from pool HTML
					initialData: this.initialData ?? null,
					perfHostCreateTs: this._perfCreateTs,
					perfHtmlTs: Date.now(),
					perfRendererOrigin: Math.round((mainWindow.performance?.timeOrigin ?? Date.now())),
				},
			});
			return;
		}

		// ── COLD PATH: create a new webview from scratch ──
		this.logService.info(`[AS-PERF][cold-path] panelType=${this.panelType} — no pool instance, creating new webview`);

		// ── Inline bundles: read JS+CSS from disk so we can embed them
		// directly into the HTML. This lets us use a srcdoc iframe that
		// bypasses the `vscode-webview://` protocol handler entirely,
		// eliminating the ~24s cold-start stall during Electron startup.
		let bundleJs = '';
		let bundleCss = '';
		try {
			const [jsContent, cssContent] = await Promise.all([
				this.fileService.readFile(URI.joinPath(mediaUri, 'webview.js')),
				this.fileService.readFile(URI.joinPath(mediaUri, 'webview.css')),
			]);
			bundleJs = jsContent.value.toString();
			bundleCss = cssContent.value.toString();
		} catch (err) {
			this.logService.error('[AgentStudioWebviewController] Failed to read inline bundles, falling back to external refs', err);
		}

		const useInline = bundleJs.length > 0 && bundleCss.length > 0;

		// Always use the standard VS Code webview element for reliable
		// communication (acquireVsCodeApi / onMessage). When inline bundles
		// are available, we embed JS+CSS directly in the HTML — this avoids
		// the slow service-worker-proxied fetch of external resources while
		// still going through the trusted vscode-webview:// protocol.
		//
		// CRITICAL PERF: when `useInline` is true, ALL resources are embedded
		// directly in the HTML, so the service worker (which only exists to
		// proxy `vscode-webview-resource://` fetches) is pure overhead. Its
		// register + update + controllerchange handshake routinely takes
		// 20+ seconds during VS Code cold start (see workerReady in
		// `webview/browser/pre/index.html`). Disabling it cuts that out.
		this._webview = this.webviewService.createWebviewElement({
			title: "Agent Studio",
			// Pin a stable origin (only in inline mode, where there is no
			// service worker / external resource state to conflict). All
			// inline Agent Studio webviews then share ONE Chromium renderer
			// process, so the real chat panel can reuse the process already
			// spawned by the off-screen pre-warm holder instead of paying the
			// 25-40s cold renderer-spawn cost during dev startup.
			origin: useInline ? AGENT_STUDIO_WEBVIEW_ORIGIN : undefined,
			options: {
				enableFindWidget: false,
				retainContextWhenHidden: true,
				disableServiceWorker: useInline,
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [mediaUri],
			},
			extension: undefined,
		});

		this._register(this._webview);
		const _perfMountStart = Date.now();
		this._webview.mountTo(this.container, mainWindow);
		const _perfMountEnd = Date.now();
		this._webview.setHtml(
			this._getWebviewHtml(
				useInline ? bundleJs : undefined,
				useInline ? bundleCss : undefined,
			),
		);
		const _perfSetHtmlEnd = Date.now();
		this.logService.info(
			`[AS-PERF][host] panelType=${this.panelType} ` +
			`createWebviewElement+${_perfMountStart - this._perfCreateTs}ms ` +
			`mountTo=${_perfMountEnd - _perfMountStart}ms ` +
			`setHtml=${_perfSetHtmlEnd - _perfMountEnd}ms ` +
			`(inline=${useInline}, swDisabled=${useInline})`,
		);

		// Track when webview iframe element actually becomes ready (DOM 'ready' class)
		// — this is the moment service-worker handshake / pre/index.html boot finishes
		// and pending HTML payload gets flushed to the iframe.
		const _perfWebviewReadyDeadline = Date.now();
		const checkReady = () => {
			const el = (this._webview as any)?.element as HTMLIFrameElement | undefined;
			if (el?.classList.contains('ready')) {
				this.logService.info(
					`[AS-PERF][host] webview-iframe became 'ready' +` +
					`${Date.now() - _perfWebviewReadyDeadline}ms after setHtml ` +
					`(this is when pre/index.html finished bootstrap and HTML was flushed)`,
				);
				return;
			}
			setTimeout(checkReady, 50);
		};
		setTimeout(checkReady, 50);

		this._register(
			this._webview.onMessage(async (message) => {
				await this._handleMessage(message.message as IIncomingMessage);
			}),
		);
	}

	private _getWebviewHtml(inlineJs?: string, inlineCss?: string): string {
		// Generate CSP nonce
		const nonce = this._generateNonce();

		const useInline = !!inlineJs && !!inlineCss;

		// Convert the media folder URI to a webview-accessible URI (only used in fallback mode).
		let scriptTag: string;
		let styleTag: string;

		if (useInline) {
			// Inline mode: embed everything directly — no service worker needed.
			styleTag = `<style nonce="${nonce}">${inlineCss}</style>`;
			scriptTag = `<script nonce="${nonce}">${inlineJs}</script>`;
		} else {
			// Fallback: external refs loaded through service worker.
			const mediaUri = this._getMediaUri();
			const scriptUri = asWebviewUri(URI.joinPath(mediaUri, "webview.js")).toString();
			const styleUri = asWebviewUri(URI.joinPath(mediaUri, "webview.css")).toString();
			styleTag = `<link rel="stylesheet" nonce="${nonce}" href="${styleUri}">`;
			scriptTag = `<script nonce="${nonce}" src="${scriptUri}"></script>`;
		}

		const initialTheme =
			this.workbenchThemeService.getColorTheme().settingsId || "";

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: https: vscode-webview: vscode-resource:; font-src data: vscode-webview: vscode-resource:;">
	<title>Agent Studio</title>
	${styleTag}
	<style nonce="${nonce}">
		@keyframes as-spin { to { transform: rotate(360deg); } }
		body { margin: 0; padding: 0; overflow: hidden; height: 100vh; background: var(--as-bg-primary, var(--vscode-editor-background)); color: var(--as-fg-primary, var(--vscode-foreground)); font-family: var(--vscode-font-family); }
		#root { width: 100%; height: 100%; }
		#as-preload { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 16px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
		#as-preload svg { animation: as-spin 1s linear infinite; opacity: 0.7; }
		#as-preload span { font-size: 13px; letter-spacing: 0.4px; opacity: 0.8; }
	</style>
</head>
<body>
	<div id="root">
		<div id="as-preload">
			<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M21 12a9 9 0 1 1-6.219-8.56"/>
			</svg>
			<span>Agent Studio 加载中...</span>
		</div>
	</div>
	<script nonce="${nonce}">
		// Tell the React app which panel to render
		window.__AGENT_STUDIO_PANEL_TYPE__ = ${this.panelType ? `'${this.panelType}'` : "undefined"};
		// Initial theme from configuration
		window.__AGENT_STUDIO_INITIAL_THEME__ = '${initialTheme}';
		// Active CSP nonce. Exposed so React-rendered child iframes that use
		// srcdoc (which INHERITS this webview's nonce-based CSP) can stamp the
		// same nonce onto any inline <script>/<style> they inject — otherwise
		// those tags are blocked (the inherited 'nonce-...' policy has no
		// 'unsafe-inline', and CSP policies only intersect, never widen).
		window.__AGENT_STUDIO_CSP_NONCE__ = '${nonce}';
		// Optional initial data for the panel (e.g., workflow data for workflow-editor)
		window.__AGENT_STUDIO_INITIAL_DATA__ = ${this.initialData ? JSON.stringify(this.initialData) : 'null'};

		// ── Perf base timestamps (epoch ms, comparable across host/webview) ──
		// Renderer navigation start ≈ VS Code window/program start. Used by the
		// webview perfTrace as the "program start" origin.
		window.__AS_PERF_RENDERER_ORIGIN__ = ${Math.round((mainWindow.performance?.timeOrigin ?? Date.now()))};
		// When the host started opening this chat panel (controller construction).
		window.__AS_PERF_HOST_CREATE_TS__ = ${this._perfCreateTs};
		// When the host finished generating this HTML (just before bundle load).
		window.__AS_PERF_HTML_TS__ = ${Date.now()};

		// ── Early diagnostics: catch ALL messages and errors before React loads ──
		window.__AS_MSG_LOG__ = [];
		window.addEventListener('message', function(e) {
			var d = e.data;
			if (d && d.direction === 'toWebview') {
				window.__AS_MSG_LOG__.push(d.type);
			}
		});
		window.addEventListener('error', function(e) {
			console.error('[AS-EARLY] Script error:', e.message, e.filename, e.lineno);
		});
		console.log('[AS-EARLY] Inline script executed, panelType=' + window.__AGENT_STUDIO_PANEL_TYPE__);
		// Perf: when the webview actually started executing the injected HTML.
		// Gap from __AS_PERF_HTML_TS__ ≈ webview element creation + HTML transport.
		window.__AS_PERF_INLINE_TS__ = Date.now();
		// Track whether the bundle script fires
		window.__AS_BUNDLE_LOADED__ = false;
	</script>
	<!-- Single IIFE bundle — inlined or loaded externally.
	     When inlined, no service-worker-proxied fetch is needed. -->
	${scriptTag}
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

		// ── Perf relay from webview ──────────────────────────────────────
		// The webview pushes its first-load timeline here so the full
		// host→webview chain is visible in one log. Short-circuit before
		// dispatch (it is not a real RequestType).
		if (type === 'perf.report') {
			this._logPerfReport(payload);
			return;
		}

		// ── Lifecycle signal: pool.ready ─────────────────────────────────
		// The webview entry point emits pool.ready after React mounts.
		// It is consumed by AgentStudioWebviewPool._waitForReady — no
		// further dispatch needed. Short-circuit to avoid the default
		// "Unknown message type" throw in _dispatch.
		if (type === 'pool.ready') {
			return;
		}

		// ── Perf: log incoming message with timing for key types ─────────
		const perfTypes = new Set(['agents.list', 'skills.list', 'memory.listL0', 'memory.listL1']);
		const t0 = perfTypes.has(type) ? Date.now() : 0;

		this.logService.info(
			`[AgentStudio] _handleMessage: type=${type}, id=${id}, panelType=${this.panelType}, payload=${JSON.stringify(payload)?.slice(0, 200)}`,
		);

		try {
			const result = await this._dispatch(type as RequestType, payload);
			if (perfTypes.has(type)) {
				const elapsed = Date.now() - t0;
				this.logService.info(
					`[AS-PERF][host] _handleMessage '${type}' completed in ${elapsed}ms, ` +
					`resultSize=${JSON.stringify(result)?.length ?? 0}`
				);
			}
			if (id) {
				this._sendResponse(id, type as RequestType, result);
			}
		} catch (err: unknown) {
			if (perfTypes.has(type)) {
				const elapsed = Date.now() - t0;
				this.logService.warn(
					`[AS-PERF][host] _handleMessage '${type}' FAILED after ${elapsed}ms`
				);
			}
			const error = err instanceof Error ? err : new Error(String(err));
			this.logService.error(`[AgentStudio] Error handling ${type}:`, error);
			if (id) {
				this._sendError(id, type as RequestType, error.message);
			}
		}
	}

	/**
	 * Format the webview-reported first-load timeline into the host log so the
	 * complete program-start → chat-first-paint chain is visible in one place.
	 */
	private _logPerfReport(payload: unknown): void {
		try {
			const p = payload as {
				origin?: number;
				total?: number;
				bundleLoadMs?: number | null;
				openToPaintMs?: number | null;
				spawnMs?: number | null;
				downloadMs?: number | null;
				slowest?: { label: string; ms: number } | null;
				marks?: { label: string; sinceOrigin: number; sincePrev: number }[];
			};
			const marks = p?.marks ?? [];
			const timeline = marks
				.map((m) => `${m.label}=+${m.sinceOrigin}ms(\u0394${m.sincePrev}ms)`)
				.join('  ->  ');
			// NOTE: `total` is measured from VS Code program-start and therefore
			// INCLUDES the user's idle time before the panel was opened. The two
			// numbers below are the real, actionable latencies.
			this.logService.info(
				`[AS-PERF][webview] panelType=${this.panelType} ` +
				`★ bundle-load (HTML->first-mark) = ${p?.bundleLoadMs ?? '?'}ms, ` +
				`★ panel-open->first-paint = ${p?.openToPaintMs ?? '?'}ms, ` +
				`(program-start->first-paint = ${p?.total ?? '?'}ms, includes pre-open idle)`,
			);
			// Decisive split: where inside bundle-load the time actually goes.
			//   process-spawn = webview process spawn + HTML transport (no bundle)
			//   bundle-download = ESM module waterfall (SW proxy) + parse + eval
			this.logService.info(
				`[AS-PERF][webview]   \u21B3 split: process-spawn+html = ${p?.spawnMs ?? '?'}ms ` +
				`| bundle-download+parse = ${p?.downloadMs ?? '?'}ms`,
			);
			if (timeline) {
				this.logService.info(`[AS-PERF][webview] timeline: ${timeline}`);
			}
			if (p?.slowest) {
				this.logService.warn(
					`[AS-PERF][webview] SLOWEST post-load stage = "${p.slowest.label}" took ${p.slowest.ms}ms`,
				);
			}
		} catch (err) {
			this.logService.warn(`[AS-PERF][webview] failed to log perf report: ${err}`);
		}
	}

	private async _dispatch(
		type: RequestType,
		payload: unknown,
	): Promise<unknown> {
		const p = payload as Record<string, unknown>;

		switch (type) {
			// ─── Agents ────────────────────────────────────────────
			case "agents.list":
				return this.agentStudioService.getAgents();
			case "agents.get":
				return this.agentStudioService.getAgent(p.id as string);
			case "agents.create":
				return this.agentStudioService.createAgent(p as Record<string, unknown>);
			case "agents.update":
				return this.agentStudioService.updateAgent(p.id as string, p.data as Record<string, unknown>);
			case "agents.delete": {
				// 删除 Agent 前，先级联清理其 L0 对话与 L1 记忆。
				// 即使记忆清理失败也不阻断 Agent 删除本身（独立 try/catch，仅记日志）。
				const agentId = p.id as string;
				try {
					await this._cleanupAgentMemory(agentId);
				} catch (err) {
					this.logService.warn(
						`[AgentStudioWebviewController] cleanup memory for ${agentId} failed (non-fatal):`,
						err,
					);
				}
				return this.agentStudioService.deleteAgent(agentId);
			}
			case "agents.getLastSelected":
				return { agentId: await this.agentStudioService.getLastSelectedAgentId() };
			case "agents.selected":
				this.agentStudioService.fireSelectAgent(
					((p as Record<string, unknown>).agentId as string) ?? null,
				);
				return undefined;
			case "agents.openSettings": {
				const agentId = (p as Record<string, unknown>).agentId as string | undefined;
				const agentName = (p as Record<string, unknown>).agentName as string | undefined;
				if (!agentId) { return undefined; }
				const input = new AgentSettingsEditorInput(agentId, agentName);
				const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
				const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
				await this.editorService.openEditor(input, { pinned: true }, targetGroup);
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

			// ── Active workspace (used by webview to restore last session) ──
			case "workspace.getActive":
				// Resolve the workspace the webview should default to. We
				// prefer in-memory active id (set within this session), then
				// reverse-lookup by the IDE's currently opened folder, then
				// the persisted last-active id, and finally fall back to the
				// first workspace that has a `path` bound. This eliminates
				// the long-standing footgun where a stale "Test" workspace
				// (no `path`) would silently win because it was workspaces[0].
				return this.agentStudioService.resolveDefaultActiveWorkspaceId();
			case "workspace.setActive":
				// Persist + broadcast active workspace change. This makes the
				// webview's selection authoritative for native views (sandbox
				// roots, SCM, ActivityBar) and survives reloads via
				// last-active-workspace.json.
				await this.agentStudioService.setActiveWorkspace(p.id as string | undefined);
				return { ok: true };

			// ── Worktrees ───────────────────────
			case "worktree.list": {
				// Always use the host's active workspace ID instead of what the
				// webview passes (webview store may lag, or may be a different
				// workspace from what Source Control uses). This ensures the
				// dropdown always shows the SAME worktrees as the Source Control
				// panel (which also uses getActiveWorkspaceId).
				const wsId = this.agentStudioService.getActiveWorkspaceId()
					|| (p.workspaceId as string)
					|| undefined;
				if (!wsId) {
					this.logService.warn('[AgentStudio] worktree.list: no workspaceId (host active + webview payload both null)');
					return [];
				}
				const raw = await this.agentStudioService.getWorktrees(wsId);
				// Normalize IWorktreeDetail → { path, branch, repoRoot?, repoName? }
				// `branch` is optional (detached HEAD), fall back to `name`.
				return raw.map((wt: any) => ({
					path: wt.path,
					branch: wt.branch || wt.name || 'HEAD',
					repoRoot: wt.repoRoot,
					repoName: wt.repoName,
				}));
			}
			case "agent.worktree.switch": {
				const workspaceId = (p.workspaceId as string) || this.agentStudioService.getActiveWorkspaceId() || undefined;
				const agentId = (p.agentId as string) || undefined;
				const worktreePath = p.worktreePath as string | undefined;
				const worktreeBranch = p.worktreeBranch as string | undefined;
				if (!workspaceId || !agentId || !worktreePath) {
					throw new Error('agent.worktree.switch requires workspaceId, agentId, worktreePath');
				}
				await this.agentStudioService.upsertAgentBinding(workspaceId, agentId, {
					worktreePath,
					worktreeBranch,
				});
				// Notify webview so dropdown + other panels refresh
				this._sendEvent('agent.worktree.changed', {
					workspaceId,
					agentId,
					worktreePath,
					worktreeBranch,
				});
				return undefined;
			}
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
					(p.agentId) as string,
					p.sessionId as string | undefined,
				);
			case "chat.append":
				// v6: webview commits a synthesized message (e.g. wf_run_* with
				// subAgents + toolTrace) to the host so it persists across reloads.
				// Bypasses the `sendMessage` path (which kicks off a model turn).
				return this._handleChatAppend(p);
			case "chat.clear":
				return this.agentChatService.clearHistory(
					(p.agentId) as string,
					p.sessionId as string | undefined,
				);
			case "chat.cancel":
				this.agentChatService.cancelStream(
					(p.agentId) as string,
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
			case "providers.getSelectionForAgent":
				return this._handleProvidersGetSelectionForAgent(
					(p.agentId) as string,
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
					(p.agentId) as string,
				);
			case "agentSession.create":
				return (this.agentChatService as any).createAgentSession(
					(p.agentId) as string,
					p.name as string | undefined,
				);
			case "agentSession.rename":
				return (this.agentChatService as any).renameAgentSession(
					(p.agentId) as string,
					p.sessionId as string,
					p.name as string,
				);
			case "agentSession.delete":
				return (this.agentChatService as any).deleteAgentSession(
					(p.agentId) as string,
					p.sessionId as string,
				);
			case "agentSession.getActive":
				return (this.agentChatService as any).getOrCreateActiveSession(
					(p.agentId) as string,
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
				return this._configHtmlService.resolveState((p.agentId) as string);
			case "configmd.readSource":
				return this._configHtmlService.readSource((p.agentId) as string);
			case "configmd.writeSource": {
				const wp = p as unknown as IConfigMdWriteSourcePayload;
				return this._configHtmlService.writeSource((wp.agentId), wp.markdown, {
					origin: wp.origin,
					baseVersion: wp.baseVersion,
				});
			}
			case "configmd.applyPatch": {
				const ap = p as unknown as IConfigMdApplyPatchPayload;
				return this._configHtmlService.applyPatch(ap.agentId, ap.patches, {
					origin: ap.origin,
					baseVersion: ap.baseVersion,
				});
			}
			case "configmd.renderHtml": {
				const rp = p as unknown as IConfigMdRenderHtmlPayload;
				return this._configHtmlService.renderHtml((rp.agentId), rp.markdown);
			}
			case "confightml.event":
			case "configmd.event": {
				const ep = p as unknown as IConfigMdEventPayload;
				return this._configHtmlService.handleHtmlEvent(
					(ep.agentId),
					ep.eventName,
					ep.payload,
					ep.agentSessionId,
				);
			}
			case "configmd.chatSend": {
				const cp = p as unknown as IConfigMdChatSendPayload;
				return this._configHtmlService.handleChatSend((cp.agentId), cp.message, {
					context: cp.context,
					showInChat: cp.showInChat,
					agentSessionId: cp.agentSessionId,
				});
			}
			case "configmd.chatHistory":
				return this.agentChatService.getHistory(
					(p.agentId) as string,
					p.sessionId as string | undefined,
				);
			case "configmd.notify":
				this.logService.info(
					`[ConfigMD] Notification from ${(p.agentId)}: ${p.message} [${p.level || "info"}]`,
				);
				return undefined;
			case "configmd.uploadParser":
				return this._configHtmlService.uploadParser(
					(p.agentId) as string,
					p.content as string,
					p.fileName as string | undefined,
				);
			case "configmd.uploadStyles":
				return this._configHtmlService.uploadStyles(
					(p.agentId) as string,
					p.content as string,
					p.fileName as string | undefined,
				);
			case "configmd.removeParser":
				return this._configHtmlService.removeParser((p.agentId) as string);
			case "configmd.getInfo":
				return this._configHtmlService.getInfo((p.agentId) as string);
			case "configmd.previewToFile":
				return this._configHtmlService.previewToFile((p.agentId) as string);

			case "configmd.htmlGenerate": {
				const hp = p as unknown as IConfigMdHtmlGeneratePayload;
				return this._configHtmlService.htmlGenerate((hp.agentId), hp.message, {
					currentHtml: hp.currentHtml,
					model: hp.model,
				});
			}

			case "configmd.listAgents": {
				// List all agents that have config.md configured AND a bound agentDir
				// in the active workspace. configMd is a DEFINITION field (on Agent);
				// agentDir is RUNTIME state (on AgentBinding).
				const agents = await this.agentStudioService.getAgents();
				const wsId = this.agentStudioService.getActiveWorkspaceId();
				const bindings = wsId
					? await this.agentStudioService.getAgentBindings(wsId)
					: [];
				const bindingByAgent = new Map(bindings.map(b => [b.agentId, b]));
				return agents
					.filter(a => a.configMd && bindingByAgent.get(a.id)?.agentDir)
					.map(a => ({
						id: a.id,
						name: a.name,
						role: a.role,
						workspaceId: wsId,
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
			case "chat.openCheckpointDiff": {
				const ocp = p as unknown as IChatOpenCheckpointDiffPayload;
				return this._handleOpenCheckpointDiff(ocp);
			}
			case "chat.revertAllCheckpoints": {
				const rap = p as unknown as IChatRevertAllCheckpointsPayload;
				return this._handleRevertAllCheckpoints(rap);
			}
			case "chat.keepAllCheckpoints": {
				const kp = p as unknown as IChatKeepAllCheckpointsPayload;
				return this._handleKeepAllCheckpoints(kp);
			}
			case "chat.openAllCheckpointsDiff": {
				const oap = p as unknown as IChatOpenAllCheckpointsDiffPayload;
				return this._handleOpenAllCheckpointsDiff(oap);
			}
			case "chat.toolApprove": {
				const tp = p as unknown as IChatToolApprovePayload;
				return this._handleToolApprove(tp);
			}

			// ─── Skills ────────────────────────────────────────────
			case "skills.list":
				return this._handleSkillsList();

		// ─── Workflow Editor ──────────────────────────────────
		case "workflow.get": {
			const wp = p as unknown as { id: string; workspaceId?: string };
			return this._handleWorkflowGet(wp);
		}
		case "workflow.save": {
			const ws = p as unknown as { workflow: Record<string, unknown>; workspaceId?: string };
			return this._handleWorkflowSave(ws);
		}
		case "workflow.execute": {
			const ep = p as unknown as { workflowId: string; agentId?: string; context?: Record<string, unknown> };
			return this._handleWorkflowExecute(ep);
		}
		case "workflow.resume": {
			const rp = p as unknown as { executionId: string; userInput: string | string[] };
			return this._handleWorkflowResume(rp);
		}
		case "workflow.cancel": {
			const cp = p as unknown as { executionId: string };
			return this._handleWorkflowCancel(cp);
		}
		case "workflow.breakpoint.set": {
			const bp = p as unknown as { workflowId: string; nodeId: string; executionId?: string };
			return this._handleWorkflowBreakpointSet(bp);
		}
		case "workflow.breakpoint.clear": {
			const bp = p as unknown as { workflowId: string; nodeId: string; executionId?: string };
			return this._handleWorkflowBreakpointClear(bp);
		}
		case "workflow.breakpoint.get": {
			const bp = p as unknown as { workflowId: string };
			return this._handleWorkflowBreakpointGet(bp);
		}
		case "workflow.list": {
			const lp = p as unknown as { workspaceId?: string };
			return this._handleWorkflowList(lp);
		}
		case "workflow.reorder": {
			const rp = p as unknown as { orderedIds: string[]; workspaceId?: string };
			return this._handleWorkflowReorder(rp);
		}
		case "workflow.open": {
			const op = p as unknown as { workflowId: string };
			return this._handleWorkflowOpen(op);
		}
		case "workflow.submitVariables": {
			const vp = p as unknown as { executionId: string; values: Record<string, string> };
			return this._handleWorkflowSubmitVariables(vp);
		}

			// ─── Memory inspection (TDB-AM gateway proxy) ──────────
			case "memory.listL0": {
				const mp = p as unknown as IMemoryListPayload;
				return this._handleMemoryListL0(mp);
			}
			case "memory.listL1": {
				const mp = p as unknown as IMemoryListPayload;
				return this._handleMemoryListL1(mp);
			}
			case "memory.deleteL0": {
				const mp = p as unknown as IMemoryDeletePayload;
				return this._handleMemoryDelete(mp, "conversation");
			}
			case "memory.deleteL1": {
				const mp = p as unknown as IMemoryDeletePayload;
				return this._handleMemoryDelete(mp, "memory");
			}

			default:
				throw new Error(`Unknown message type: ${type}`);

		}
	}

	/**
	 * Webview tells us which (agentId, agentSessionId) is currently
	 * displayed in this chat panel. We update local state and register
	 * with `IConfigHtmlService` so imgui form submits originating in a
	 * preview pane can be routed back to the right session.
	 *
	 * We also use this to filter `onDidRequestChatSend` events: when
	 * multiple chat panels are open (different Forks), only the one
	 * whose registered agentId matches will respond — otherwise the
	 * same imgui submit would be sent twice.
	 */
	private _handleChatActiveSessionChanged(
		payload: Record<string, unknown>,
	): void {
		if (this.panelType !== "chat") {
			// Non-chat panels don't own a chat session.
			return;
		}
		const prevAgentId = this._activeChatAgentId;
		const agentId =
			((payload.agentId) as string | null | undefined) || undefined;
		const agentSessionId =
			(payload.agentSessionId as string | null | undefined) || undefined;
		this._activeChatAgentId = agentId;
		this._activeChatAgentSessionId = agentSessionId;
		this.logService.info(
			`[AgentStudio] chat.activeSessionChanged: agentId=${agentId || "<none>"} ` +
			`agentSessionId=${agentSessionId || "<none>"} (panelType=${this.panelType})`,
		);
		// Clear the previous registration if the agent changed,
		// otherwise the registry would keep pointing at a stale session
		// for the prior agent.
		if (prevAgentId && prevAgentId !== agentId) {
			this._configHtmlService.setActiveAgentSession(prevAgentId, undefined);
		}
		if (agentId) {
			this._configHtmlService.setActiveAgentSession(agentId, agentSessionId);
		}
	}

	private _handleChatSend(payload: Record<string, unknown>): {
		status: string;
		agentId: string;
	} {
		const agentId = (payload.agentId) as string;
		const message = payload.message as string;
		let agentSessionId = payload.agentSessionId as string | undefined;
		const workspaceSessionId = payload.workspaceSessionId as string | undefined;
		const workspaceId = payload.workspaceId as string | undefined;

		// If we're in a Fork but no agentSessionId was provided, lazily create one
		if (workspaceId && workspaceSessionId && !agentSessionId) {
			this._ensureAgentSessionAndSend(
				agentId,
				message,
				workspaceId,
				workspaceSessionId,
				payload,
			);
			return { status: "streaming", agentId };
		}

		// Root mode without an agentSessionId: lazily create one. This path
		// is normally avoided because the chat input front-end (`useChatStore.
		// sendMessage`) calls `agentSession.getActive` BEFORE invoking us, but
		// imgui-form submits arrive here directly via `onDidRequestChatSend`
		// and may carry no sessionId at all when the user has never sent a
		// message yet. Without this branch, the user message would be
		// persisted under cache key `agentId` (no session suffix) and
		// `_persistToSessionFile` would skip writing to disk entirely —
		// causing the message to vanish on the next reload.
		if (!agentSessionId) {
			this._ensureRootSessionAndSend(agentId, message, payload);
			return { status: "streaming", agentId };
		}

		// Persist the user message to chat history so it survives refreshes.
		// IMPORTANT: appendMessage MUST complete (cache populated) BEFORE
		// _runChatStream → agentChatService.sendMessage runs its dedup guard,
		// otherwise sendMessage won't see this message in _historyCache and will
		// persist a SECOND copy → duplicate user message after reload.
		const userMessage: import("../../../common/agentStudioTypes.js").ChatMessage =
		{
			id: `msg_${Date.now()}_user_${Math.random().toString(36).substring(2, 9)}`,
			role: "user",
			content: message,
			agentId,
			agentSessionId,
			timestamp: new Date().toISOString(),
		};
		void (async () => {
			try {
				await this.agentChatService.appendMessage(agentId, userMessage);
			} catch (err) {
				this.logService.error(
					"[AgentStudio] Failed to persist user message:",
					err,
				);
			}
			this._runChatStream(agentId, message, payload);
		})();

		return { status: "streaming", agentId };
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
		agentId: string,
		message: string,
		payload: Record<string, unknown>,
	): Promise<void> {
		try {
			const sessionName = message.trim().substring(0, 30) || "新对话";
			// 🔒 修复（2026-06-05）：之前用 `getOrCreateActiveSession` 在 session
			// index 非空时会**复用最近一条 existing session**，把整段历史回灌给
			// 模型（log 里 313 条跨主题/跨 worktree 串台即此故障）。改为
			// `createAgentSession` 强制新建：用户没有显式选中已有 session 就发消息，
			// 一律开全新会话，永远不带历史。要恢复旧会话必须从历史列表显式选中。
			const meta = await (
				this.agentChatService as any
			).createAgentSession(agentId, sessionName);
			const agentSessionId = meta?.id as string | undefined;
			if (!agentSessionId) {
				throw new Error("createAgentSession returned no id");
			}
			this.logService.info(
				`[AgentStudio] _ensureRootSessionAndSend: created fresh session ${agentSessionId} for ${agentId}`,
			);

			// Mirror chat-input flow: keep the registry & webview in sync
			// so subsequent imgui submits (and the post-reload history load)
			// aim at the same session.
			this._configHtmlService.setActiveAgentSession(agentId, agentSessionId);
			if (this._activeChatAgentId === agentId) {
				this._activeChatAgentSessionId = agentSessionId;
			}
			this._sendEvent("workspace.sessionUpdated", {
				agentId,
				agentSessionId,
			});

			// Persist the user message under the resolved session.
			// Await before streaming so sendMessage's dedup guard sees it (see
			// _handleChatSend note) — prevents a duplicate user message on reload.
			const userMessage: import("../../../common/agentStudioTypes.js").ChatMessage =
			{
				id: `msg_${Date.now()}_user_${Math.random().toString(36).substring(2, 9)}`,
				role: "user",
				content: message,
				agentId,
				agentSessionId,
				timestamp: new Date().toISOString(),
			};
			try {
				await this.agentChatService.appendMessage(agentId, userMessage);
			} catch (err) {
				this.logService.error(
					"[AgentStudio] Failed to persist user message:",
					err,
				);
			}

			// Run the chat stream with the resolved agentSessionId.
			const enrichedPayload = { ...payload, agentSessionId };
			this._runChatStream(agentId, message, enrichedPayload);
		} catch (err) {
			this.logService.error(
				"[AgentStudio] _ensureRootSessionAndSend failed:",
				err,
			);
			this._sendEvent("chat.stream.error", {
				agentId,
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
		agentId: string,
		message: string,
		workspaceId: string,
		workspaceSessionId: string,
		payload: Record<string, unknown>,
	): Promise<void> {
		try {
			const entry = await this._sessionService.ensureAgentSession(
				workspaceId,
				workspaceSessionId,
				agentId,
			);
			const agentSessionId = entry.sessionId;

			// Persist the user message with the resolved agentSessionId.
			// Await before streaming so sendMessage's dedup guard sees it (see
			// _handleChatSend note) — prevents a duplicate user message on reload.
			const userMessage: import("../../../common/agentStudioTypes.js").ChatMessage =
			{
				id: `msg_${Date.now()}_user_${Math.random().toString(36).substring(2, 9)}`,
				role: "user",
				content: message,
				agentId,
				agentSessionId,
				timestamp: new Date().toISOString(),
			};
			try {
				await this.agentChatService.appendMessage(agentId, userMessage);
			} catch (err) {
				this.logService.error(
					"[AgentStudio] Failed to persist user message:",
					err,
				);
			}

			// Notify webview of the newly assigned agentSessionId
			this._sendEvent("workspace.sessionUpdated", {
				workspaceId,
				sessionId: workspaceSessionId,
				agentId,
				agentSessionId,
			});

			// Run the chat stream with the resolved agentSessionId
			const enrichedPayload = { ...payload, agentSessionId };
			this._runChatStream(agentId, message, enrichedPayload);
		} catch (err) {
			this.logService.error(
				"[AgentStudio] _ensureAgentSessionAndSend failed:",
				err,
			);
			this._sendEvent("chat.stream.error", {
				agentId,
				sessionId: "",
				error: `Failed to create agent session: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	/**
	 * v6: webview commits a synthesized message (e.g. workflow `wf_run_*` with
	 * `subAgents` + `toolTrace`) to the host. This bypasses the model-stream
	 * path entirely — the message is just persisted so it survives a window
	 * reload. Idempotent: appendMessage on the host is a no-op for an existing
	 * id, so retries from the webview are safe.
	 */
	private async _handleChatAppend(payload: Record<string, unknown>): Promise<{ ok: boolean; id: string }> {
		const agentId = payload.agentId as string;
		const message = payload.message as import("../../../common/agentStudioTypes.js").ChatMessage | undefined;
		if (!agentId || !message) {
			throw new Error('chat.append: missing agentId or message');
		}
		// Defensive: ensure the message has an agentSessionId so the host's
		// noSession guard doesn't drop it.
		if (!message.agentSessionId) {
			this.logService.warn(
				`[AgentStudioWebviewController] chat.append: message ${message.id} missing agentSessionId; persisting anyway (host will fill from active session)`,
			);
		}
		await this.agentChatService.appendMessage(agentId, message);
		this.logService.info(
			`[AgentStudioWebviewController] chat.append: persisted ${message.id} (role=${message.role}, subAgents=${message.subAgents?.length ?? 0}, hasToolTrace=${(message.subAgents ?? []).some((sa: any) => (sa as any).toolTrace?.length > 0)})`,
		);
		return { ok: true, id: message.id };
	}

	/**
	 * Run the chat stream in the background. This is fire-and-forget from
	 * the webview's perspective — all results flow through events.
	 */
	private async _runChatStream(
		agentId: string,
		message: string,
		payload: Record<string, unknown>,
	): Promise<void> {
		const agentSessionId = payload.agentSessionId as string | undefined;
		const sessionIdForEvent = agentSessionId || "";
		let capturedProviderSessionId: string | undefined;
		let streamingTextBuffer: string = ''; // 流式文本缓冲区，用于增量工具检测 + 全量快照（参考 Void 的 fullTextSoFar）
		let streamingThinkingBuffer: string = ''; // 流式推理缓冲区，用于全量快照

		// ── Checkpoint: register the active session (so tool_edit checkpoints
		//    created deep inside the tool provider can resolve the sessionId) and
		//    drop a user_edit anchor for this turn (Void-inspired message boundary).
		if (agentSessionId) {
			try {
				this.checkpointService.setActiveSession(agentId, agentSessionId);
				// Anchor checkpoint: empty file set — it marks the message boundary;
				// actual file rollback is provided by the tool_edit checkpoints that
				// follow whenever the agent writes a file this turn.
				this.checkpointService
					.createCheckpoint({
						agentId,
						sessionId: agentSessionId,
						type: 'user_edit',
						fileSnapshots: [],
					})
					.catch((err) =>
						this.logService.warn(
							`[AgentStudio] Failed to create user_edit checkpoint: ${err}`,
						),
					);
			} catch (err) {
				this.logService.warn(`[AgentStudio] checkpoint anchor setup failed: ${err}`);
			}
		}
		try {
			const chatMessage = await this.agentChatService.sendMessage(
				agentId,
				message,
				{
					model: payload.model as string | undefined,
					systemPrompt: payload.systemPrompt as string | undefined,
					temperature: payload.temperature as number | undefined,
					workspaceId: payload.workspaceId as string | undefined,
					agentId,
					agentSessionId,
					explicitSkillIds: payload.explicitSkillIds as string[] | undefined,
					reasoning: payload.reasoning as { enabled: boolean; budget?: number; effort?: 'low' | 'medium' | 'high' } | undefined,
					chatMode: payload.chatMode as 'craft' | 'ask' | 'plan' | 'workflow' | undefined,
					attachments: payload.attachments as import('../../../common/agentStudioService.js').IChatAttachmentSend[] | undefined,
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

					// 增量工具检测 + 全量快照（参考 Void 的 fullTextSoFar）
					let chunksToSend: IChatStreamDelta[] = [safeChunk];
					if (safeChunk.type === 'text' && typeof safeChunk.content === 'string') {
						streamingTextBuffer += safeChunk.content;
						// 附加全量文本快照
						safeChunk.fullText = streamingTextBuffer;
						// 使用正则检测工具标签（简化版，仅检测完整标签）
						const toolTagRegex = /<(tool_call|function_call|tool_use|invoke)[\s\S]*?>[\s\S]*?<\/\1>/gi;
						const toolMatches: { index: number; toolName: string; fullMatch: string }[] = [];
						let regexMatch: RegExpExecArray | null;
						toolTagRegex.lastIndex = 0;
						while ((regexMatch = toolTagRegex.exec(streamingTextBuffer)) !== null) {
							// 从标签中提取工具名称
							const nameFromAttr = regexMatch[0].match(/(?:name|tool|function)\s*[:=]\s*["']?(\w+)["']?/i);
							const nameFromContent = regexMatch[0].match(/>(\w+)[\s]*<\//);
							const toolName = nameFromAttr?.[1] || nameFromContent?.[1] || 'unknown';
							toolMatches.push({ index: regexMatch.index, toolName, fullMatch: regexMatch[0] });
						}
						if (toolMatches.length > 0) {
							// 从 streamingTextBuffer 中移除工具 XML，创建新的 chunks
							const textBeforeTool = streamingTextBuffer.substring(0, toolMatches[0].index);
							chunksToSend = [
								{ ...safeChunk, content: textBeforeTool, type: 'text' } as IChatStreamDelta,
								...toolMatches.map(tm => ({
									type: 'tool_start' as const,
									toolCallId: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
									toolName: tm.toolName,
								})) as unknown as IChatStreamDelta[],
							];
							// 重置 buffer 为工具之后的文本
							streamingTextBuffer = streamingTextBuffer.substring(toolMatches[0].index + toolMatches[0].fullMatch.length);
						}
					}
					// 累积 thinking buffer 并附加全量快照
					if (safeChunk.type === 'thinking' && typeof safeChunk.content === 'string') {
						streamingThinkingBuffer += safeChunk.content;
						safeChunk.fullThinking = streamingThinkingBuffer;
					}
					// content_replace 时更新全量快照
					if (safeChunk.type === 'content_replace' && typeof safeChunk.content === 'string') {
						streamingTextBuffer = safeChunk.content;
						safeChunk.fullText = streamingTextBuffer;
					}
					// 🧹 discard_prior_text：Hermes synthetic-recovery 等价物 —— 丢弃此前的幻觉/过渡文本
					// 防止 conversation rot（fake-completion / unfinished-intent 文本污染历史并被下一轮喂回模型）
					if ((safeChunk as any).type === 'discard_prior_text') {
						const reason = (safeChunk as any).metadata?.reason ?? 'unknown';
						this.logService.info(
							`[AgentStudio] 🧹 Received discard_prior_text (reason=${reason}); clearing streaming buffers (text len=${streamingTextBuffer.length}, thinking len=${streamingThinkingBuffer.length})`,
						);
						streamingTextBuffer = "";
						streamingThinkingBuffer = "";
					}

					this._sendEvent("chat.stream.delta", {
						agentId,
						sessionId: sessionIdForEvent,
						chunks: chunksToSend,
					});
				},
			);

			// If we captured a provider session ID, persist it to the session index
			if (capturedProviderSessionId && agentSessionId) {
				(this.agentChatService as any)
					.updateProviderSessionId(
						agentId,
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
					const { patches, commands } = this._configHtmlService.parseModelOutput(
						chatMessage.content,
					);
					if (patches.length > 0) {
						this.logService.info(
							`[AgentStudio] Applying ${patches.length} configmd-patch op(s) from assistant reply`,
						);
						this._configHtmlService
							.applyPatch(agentId, patches, { origin: "model" })
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
						this._configHtmlService.sendCommandToHtml(agentId, cmd);
					}
				} catch (err) {
					this.logService.warn("[AgentStudio] parseModelOutput failed:", err);
				}
			}

			this._sendEvent("chat.stream.complete", {
				agentId,
				sessionId: sessionIdForEvent,
				message: chatMessage,
			});
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			this.logService.error(
				`[AgentStudio] _runChatStream error for ${agentId}:`,
				error,
			);

			this._sendEvent("chat.stream.error", {
				agentId,
				sessionId: sessionIdForEvent,
				error: errMsg,
			});

			this._sendEvent("chat.stream.complete", {
				agentId,
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
		this._postToWebview(response, `_sendResponse type=${type}.response, id=${id}`);
	}

	private _sendError(id: string, type: RequestType, message: string): void {
		const response: IResponseMessage = {
			id,
			direction: "toWebview" as const,
			type: `${type}.response` as `${RequestType}.response`,
			error: { code: "ERROR", message },
		};
		this._postToWebview(response, `_sendError type=${type}.response`);
	}

	private _sendEvent(type: string, data: unknown): void {
		const event: IEventMessage = {
			direction: "toWebview" as const,
			type: type as IEventMessage["type"],
			data,
		};
		this._postToWebview(event, `_sendEvent type=${type}`, type.startsWith("chat.stream"));
	}

	/**
	 * Unified message sender that routes through the standard VS Code webview element.
	 */
	private _postToWebview(msg: unknown, debugLabel: string, logDelivery = false): void {
		if (this._webview) {
			const result = this._webview.postMessage(msg);
			if (logDelivery) {
				result.then(
					(delivered) => {
						if (!delivered) {
							this.logService.warn(
								`[AgentStudio] postMessage FAILED to deliver: ${debugLabel} — webview iframe not ready or missing`,
							);
						}
					},
					(err) => {
						this.logService.error(
							`[AgentStudio] postMessage REJECTED: ${debugLabel}`,
							err,
						);
					},
				);
			}
		} else {
			this.logService.warn(
				`[AgentStudio] _postToWebview: no webview/iframe for ${debugLabel}`,
			);
		}
	}

	/**
	 * Public API for external components (e.g. SessionExplorerViewPane)
	 * to push events into this webview.
	 */
	sendEventToWebview(type: string, data: unknown): void {
		this._sendEvent(type, data);
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

		const resolvedAgentId = payload.agentId;
		if (!absPath && resolvedAgentId) {
			const agent = await this.agentStudioService.getAgent(resolvedAgentId);
			if (!agent) {
				throw new Error(`Agent '${resolvedAgentId}' not found`);
			}
			const wsId = this.agentStudioService.getActiveWorkspaceId();
			if (!wsId) {
				throw new Error(`Agent '${agent.name}' has no active workspace`);
			}
			const binding = await this.agentStudioService.getAgentBinding(wsId, resolvedAgentId);
			if (!binding?.agentDir) {
				throw new Error(`Agent '${agent.name}' has no agentDir`);
			}
			const agentDirUri = await this._resolveAgentDirUri(
				wsId,
				binding.agentDir,
			);
			if (!agentDirUri) {
				throw new Error(
					`Workspace '${wsId}' has no path; cannot resolve agent dir for ${agent.id}`,
				);
			}
			const cfg = agent.configMd;
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
			throw new Error("files.open requires path or agentId");
		}

		// Resolve relative paths against the owning workspace root. Tool cards
		// (e.g. file_read) frequently pass a *relative* path such as
		// `product.json` or `src/app.ts`. Feeding those straight into
		// `URI.file()` yields a bogus drive-root path (e.g. `/product.json`)
		// → "file not found".
		//
		// CRITICAL: the file_read tool resolves relative paths against a
		// *prioritized list of roots* — VS Code workspace folders FIRST, then
		// the Sarosis workspace.path, then any agent worktree path (see
		// builtinToolProvider._resolveAndCheckWorkspacePath). If we only join
		// against the Sarosis workspace.path here, we can produce a path the
		// tool never actually read from (file readable, but not openable). To
		// stay consistent we build the SAME candidate-root list and open the
		// first candidate that actually exists on disk.
		if (!this._isAbsolutePath(absPath)) {
			const resolved = await this._resolveRelativeOpenPath(
				absPath,
				payload.workspaceId,
				(payload.agentId),
			);
			if (resolved) {
				absPath = resolved;
			}
		}

		const resource = URI.file(absPath);
		const groups = this.editorGroupsService.getGroups(
			GroupsOrder.CREATION_TIME,
		);
		const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];

		this.logService.info(
			`[AgentStudioWebviewController] files.open → ${resource.toString()}${payload.lineNumber ? ` :${payload.lineNumber}` : ""}`,
		);
		// Build editor options. When a 1-based lineNumber is supplied (e.g.
		// file_read's start_line), reveal + select that line so the user lands
		// on the relevant location instead of the top of the file.
		const selection = payload.lineNumber && payload.lineNumber > 0
			? {
				startLineNumber: payload.lineNumber,
				startColumn: 1,
				endLineNumber: payload.lineNumber,
				endColumn: 1,
			}
			: undefined;
		await this.editorService.openEditor(
			{
				resource,
				options: {
					preserveFocus: payload.preserveFocus ?? false,
					pinned: payload.pinned ?? false,
					...(selection ? { selection } : {}),
				},
			},
			targetGroup,
		);
	}

	/**
	 * Test whether a path is absolute on the current platform.
	 * Handles POSIX (`/foo`), Windows drive (`C:\foo`, `C:/foo`) and UNC
	 * (`\\server\share`) forms without importing Node's `path` module
	 * (this controller runs in the renderer/browser context).
	 */
	private _isAbsolutePath(p: string): boolean {
		if (!p) {
			return false;
		}
		// POSIX absolute or UNC
		if (p.startsWith("/") || p.startsWith("\\\\")) {
			return true;
		}
		// Windows drive-letter absolute: C:\ or C:/
		return /^[a-zA-Z]:[\\/]/.test(p);
	}

	/**
	 * Resolve a *relative* `files.open` path to an absolute on-disk path,
	 * mirroring how the `file_read` tool resolves it.
	 *
	 * The tool (builtinToolProvider._resolveAndCheckWorkspacePath) tries a
	 * prioritized list of roots:
	 *   1. VS Code workspace folders (in order)
	 *   2. the Sarosis workspace.path for the owning agent/workspace
	 *   3. the agent's worktreePath (if any)
	 *
	 * It joins the relative path onto the FIRST root for reads, but here we
	 * cannot assume which root actually contained the file (the user may be
	 * looking at a workspace whose Sarosis path differs from the VS Code
	 * folder). So we build the same candidate list and return the first
	 * candidate that EXISTS on disk. Falls back to joining onto the first
	 * candidate root (so the editor surfaces a sensible "not found" path) and
	 * finally to the untouched relative path when no roots are known.
	 */
	private async _resolveRelativeOpenPath(
		relPath: string,
		workspaceId: string | undefined,
		agentId: string | undefined,
	): Promise<string | undefined> {
		const segments = relPath.split(/[\\/]+/).filter(Boolean);
		if (segments.length === 0) {
			return undefined;
		}

		const roots: URI[] = [];
		const pushRoot = (p: string | undefined | null) => {
			if (!p) { return; }
			const cleaned = p.replace(/[\\/]+$/, "");
			if (cleaned) { roots.push(URI.file(cleaned)); }
		};

		// 1. VS Code workspace folders (same as file_read's first roots).
		try {
			for (const folder of this.workspaceContextService.getWorkspace().folders) {
				pushRoot(folder.uri.fsPath);
			}
		} catch {
			/* ignore — context service may be unavailable */
		}

		// 2 & 3. Sarosis workspace.path + agent worktreePath.
		let wsId = workspaceId;
		try {
			if (agentId) {
				const resolvedWsId = wsId ?? this.agentStudioService.getActiveWorkspaceId();
				if (resolvedWsId) {
					const binding = await this.agentStudioService.getAgentBinding(resolvedWsId, agentId);
					if (!wsId) { wsId = binding?.workspaceId ?? resolvedWsId; }
					pushRoot(binding?.worktreePath);
				}
			}
		} catch {
			/* ignore */
		}
		if (wsId) {
			try {
				const workspace = await this.agentStudioService.getWorkspace(wsId);
				pushRoot(workspace?.path);
				// Also try the parent directory of workspace.path. The tool
				// often returns paths relative to the parent (e.g. the
				// workspace.path is .../project/.sarosisworkspace, and the
				// file path is .sarosisworkspace/workflows/...). Without the
				// parent root, joined paths get a double prefix.
				if (workspace?.path) {
					const workspaceUri = URI.file(workspace.path);
					const parentPath = URI.joinPath(workspaceUri, '..').fsPath;
					if (parentPath && parentPath !== workspace.path) {
						pushRoot(parentPath);
					}
				}
			} catch {
				/* ignore */
			}
		}

		if (roots.length === 0) {
			return undefined;
		}

		// De-duplicate roots while preserving priority order.
		const seen = new Set<string>();
		const uniqueRoots = roots.filter((r) => {
			const key = r.fsPath.toLowerCase();
			if (seen.has(key)) { return false; }
			seen.add(key);
			return true;
		});

		// Probe each candidate; open the first that actually exists.
		for (const root of uniqueRoots) {
			const candidate = URI.joinPath(root, ...segments);
			try {
				if (await this.fileService.exists(candidate)) {
					return candidate.fsPath;
				}
			} catch {
				/* ignore — try next root */
			}
		}

		// Nothing existed — fall back to the first root so the editor shows a
		// meaningful path in its "file not found" message.
		return URI.joinPath(uniqueRoots[0], ...segments).fsPath;
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
	 * Restores file contents from the snapshot and marks subsequent checkpoints
	 * as ghost. The webview is responsible for truncating chat history.
	 */
	private async _handleJumpToCheckpoint(
		payload: IChatJumpToCheckpointPayload,
	): Promise<void> {
		this.logService.info(
			`[AgentStudioWebviewController] chat.jumpToCheckpoint → ${payload.checkpointId}`,
		);
		await this.checkpointService.jumpToCheckpoint(
			(payload.agentId),
			payload.sessionId,
			payload.checkpointId,
		);
		// Persist the history truncation so the rollback survives a reload.
		// Without this, the webview truncates in-memory only and the next
		// loadHistory pulls the removed messages back from disk (Bug: messages
		// reappear after reload). messageId is the last message to KEEP.
		if (payload.truncateAfterMessageId) {
			try {
				await this.agentChatService.deleteMessagesAfter(
					(payload.agentId),
					payload.sessionId,
					payload.truncateAfterMessageId,
				);
			} catch (err) {
				this.logService.error(
					"[AgentStudioWebviewController] Failed to truncate history after checkpoint:",
					err,
				);
			}
		}
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
	 * Reads the current on-disk content of the given files and persists a snapshot.
	 */
	private async _handleAddCheckpoint(
		payload: IChatAddCheckpointPayload,
	): Promise<ICheckpoint | undefined> {
		this.logService.info(
			`[AgentStudioWebviewController] chat.addCheckpoint → ${payload.type} (${payload.fileUris?.length ?? 0} files)`,
		);
		return this.checkpointService.createCheckpointFromUris(
			(payload.agentId),
			payload.sessionId,
			payload.type,
			payload.fileUris ?? [],
			{
				label: payload.label,
				description: payload.description,
				messageId: payload.messageId,
			},
		);
	}

	/**
	 * Handle get checkpoint request from webview.
	 */
	private async _handleGetCheckpoint(
		payload: IChatGetCheckpointPayload,
	): Promise<ICheckpoint | undefined> {
		return this.checkpointService.getCheckpoint(
			(payload.agentId),
			payload.sessionId,
			payload.checkpointId,
		);
	}

	/**
	 * Handle list checkpoints request from webview.
	 */
	private async _handleListCheckpoints(
		payload: IChatListCheckpointsPayload,
	): Promise<ICheckpoint[]> {
		return this.checkpointService.listCheckpoints((payload.agentId), payload.sessionId);
	}

	/**
	 * Handle delete checkpoint request from webview.
	 */
	private async _handleDeleteCheckpoint(
		payload: IChatDeleteCheckpointPayload,
	): Promise<void> {
		await this.checkpointService.deleteCheckpoint(
			(payload.agentId),
			payload.sessionId,
			payload.checkpointId,
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
		// Reuse _handleOpenFile's path-resolution logic (path or agentId+kind)
		let absPath: string | undefined = payload.path;
		const resolvedAgentId = payload.agentId;
		if (!absPath && resolvedAgentId) {
			const agent = await this.agentStudioService.getAgent(resolvedAgentId);
			if (!agent) {
				throw new Error(`Agent '${resolvedAgentId}' not found`);
			}
			const wsId = this.agentStudioService.getActiveWorkspaceId();
			if (!wsId) {
				throw new Error(`Agent '${agent.name}' has no active workspace`);
			}
			const binding = await this.agentStudioService.getAgentBinding(wsId, resolvedAgentId);
			if (!binding?.agentDir) {
				throw new Error(`Agent '${resolvedAgentId}' has no agentDir`);
			}
			const agentDirUri = await this._resolveAgentDirUri(
				wsId,
				binding.agentDir,
			);
			if (!agentDirUri) {
				throw new Error(
					`Workspace '${wsId}' has no path; cannot resolve agent dir for ${agent.id}`,
				);
			}
			const cfg = agent.configMd;
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
			throw new Error("files.openHtmlPreview requires path or agentId");
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
				(payload.agentId),
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
	 * Resolve the absolute filesystem URI for an agent's directory.
	 *
	 * `agentDir` stored on the agent binding is just the leaf folder name (e.g.
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
			this.agentStudioService.onDidChangeAgents(() => {
				this._sendEvent("agents.changed", {});
			}),
		);

		this._register(
			this.agentStudioService.onDidSelectAgent(
				(agentId: string | null) => {
					this.logService.info(
						`[AgentStudio] onDidSelectAgent → _sendEvent('agent.selected', {agentId=${agentId}}) panelType=${this.panelType}`,
					);
					this._sendEvent("agent.selected", { agentId });
				},
			),
		);

		// Handle workflow run → inject execution prompt into chat panel
		this._register(
			this.agentStudioService.onDidRequestInjectPrompt(
				({ agentId, message }) => {
					// Only the chat panel should handle prompt injection
					if (this.panelType !== 'chat') { return; }
					// Only inject if this panel is showing the target agent (or no agent is active yet)
					if (this._activeChatAgentId && this._activeChatAgentId !== agentId) {
						return;
					}
					this.logService.info(
						`[AgentStudio] onDidRequestInjectPrompt → _sendEvent('chat.injectPrompt', len=${message.length})`,
					);
					this._sendEvent('chat.injectPrompt', { agentId, message });
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
				({ agentId }: { agentId: string }) => {
					this.logService.info(
						`[AgentStudio] agentSessions changed for ${agentId}, notifying webview`,
					);
					this._sendEvent("agentSessions.changed", { agentId });
				},
			),
		);

		// Listen for git worktree list changes (create/remove) and push
		// worktree.changed so the worktree dropdowns (agent node card +
		// WorktreeSwitcher) refresh their lists automatically.
		this._register(
			this.worktreeService.onDidChangeWorktrees(() => {
				this.logService.info(
					"[AgentStudio] worktrees changed, notifying webview",
				);
				this._sendEvent("worktree.changed", {});
			}),
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
			this._configHtmlService.onDidChangeSource(
				({ agentId, markdown, version, origin }) => {
					this._sendEvent("configmd.sourceChanged", {
						agentId,
						markdown,
						version,
						origin,
					});
				},
			),
		);
		this._register(
			this._configHtmlService.onDidRenderHtml(
				({ agentId, html, version, stylesContent }) => {
					this._sendEvent("configmd.htmlRendered", {
						agentId,
						html,
						version,
						stylesContent,
					});
				},
			),
		);
		this._register(
			this._configHtmlService.onDidEmitCommand(({ agentId, command }) => {
				this._sendEvent("configmd.command", { agentId, command });
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
			this._configHtmlService.onDidRequestChatSend(
				({
					agentId,
					message,
					agentSessionId,
					workspaceId,
					workspaceSessionId,
				}) => {
					if (this.panelType !== "chat") {
						return;
					}
					// Avoid duplicate sends when multiple chat panels are open: only
					// the panel currently displaying this agent should respond.
					// If no panel has registered yet (fresh open, before the webview
					// has finished sending its first `chat.activeSessionChanged`),
					// fall through and handle the message — losing it would feel
					// broken for the very first imgui submit after open.
					if (
						this._activeChatAgentId &&
						this._activeChatAgentId !== agentId
					) {
						this.logService.info(
							`[AgentStudioWebviewController] imgui→chat.send for ${agentId} ignored by panel ` +
							`showing ${this._activeChatAgentId}`,
						);
						return;
					}
					// Also avoid duplicate sends when multiple sessions for the same
					// agent are open: only the panel with the matching agent session
					// should respond.
					if (
						this._activeChatAgentSessionId &&
						this._activeChatAgentSessionId !== agentSessionId
					) {
						this.logService.info(
							`[AgentStudioWebviewController] imgui→chat.send for ${agentId}/${agentSessionId} ignored by panel ` +
							`with session ${this._activeChatAgentSessionId}`,
						);
						return;
					}
					this.logService.info(
						`[AgentStudioWebviewController] imgui→chat.send ${agentId} ` +
						`(workspaceId=${workspaceId || "<none>"}, sessionId=${agentSessionId || "<none>"})`,
					);
					// 1) Notify webview UI to append the user bubble (mirrors what
					//    the chat input would have done before sending).
					this._sendEvent("chat.userMessageAppended", {
						agentId,
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
						agentId,
						message,
						agentSessionId,
						workspaceId,
						workspaceSessionId,
					});
				},
			),
		);

		// Listen for AI-driven workflow changes (from workflow_apply tool)
		// and push the updated state to the webview workflow editor.
		this._register(
			workflowAppliedEmitter.event(({ workflow, description }) => {
				this.logService.info(
					`[AgentStudio] workflow_apply tool applied changes to ${workflow.id}, notifying webview`,
				);
				this._sendEvent('workflow.stateApplied', {
					workflow: {
						id: workflow.id,
						name: workflow.name,
						description: workflow.description,
						nodes: workflow.nodes ?? [],
						connections: workflow.connections ?? [],
					},
					description,
				});
			}),
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
				reasoningType?: 'budget-slider' | 'effort-slider' | false;
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
					reasoningType: m.capabilityConfig?.reasoningType,
					temperature: m.temperature,
					vendor: m.vendor,
					credits: m.credits,
				}));
				// [VISION-DEBUG] node 2: Host _handleProvidersList — provider source + per-model supportsImages
				this.logService.info(
					`[VISION-DEBUG][Host.providersList] providerId=${provider.id} providerName=${provider.name} ` +
					`modelCount=${models.length} models=` +
					JSON.stringify(models.map((m) => ({ id: m.id, vendor: m.vendor, img: m.supportsImages }))),
				);
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
			`agentId=${(payload.agentId)}, panelType=${this.panelType}`,
		);

		this.modelSelectorService.setSelection({
			providerId: payload.providerId,
			modelId: payload.modelId,
			agentId: (payload.agentId),
		});
		if ((payload.agentId)) {
			this.modelSelectorService.setSelectedAgentId((payload.agentId));
		}

		// Provider selection is managed by ModelSelectorService in-memory.
		// Persistence to agent.yaml is handled by the new
		// agent system (AgentInstanceService) — the legacy storage
		// path has been removed.
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
	 * @deprecated Legacy per-agent provider/model selection restore.
	 * The new agent system handles this via AgentInstanceService.
	 * Falls back to the global ModelSelectorService selection.
	 */
	private async _handleProvidersGetSelectionForAgent(
		agentId: string,
	): Promise<IProviderSelectPayload | null> {
		// Per-agent provider selection is deprecated — always fall back to global selection
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
		const t0 = Date.now();
		this.logService.info(`[AS-PERF][host] _handleSkillsList: waiting for skillRegistry.whenReady()...`);
		await this.skillRegistry.whenReady();
		const t1 = Date.now();
		this.logService.info(`[AS-PERF][host] _handleSkillsList: whenReady resolved in ${t1 - t0}ms`);
		const skills = this.skillRegistry.getSkills();
		const result = skills.map(skill => ({
			id: skill.id,
			name: skill.name,
			category: skill.category || 'uncategorized',
			activation: skill.activation,
			description: skill.description || undefined,
		}));
		this.logService.info(
			`[AS-PERF][host] _handleSkillsList: done in ${Date.now() - t0}ms, returned ${result.length} skills`
		);
		return result;
	}

	// ─── Memory inspection helpers (TDB-AM gateway proxy) ──────────────────────
	//
	// The webview cannot fetch http://127.0.0.1:<port> directly because the
	// renderer's CSP `connect-src` does not whitelist arbitrary loopback
	// origins. We forward through the host using `IRequestService` (same
	// path TdbamViewPane already uses) and translate the gateway's wire
	// format into a webview-friendly camelCase shape on the way out.
	//
	// `sessionKey` is derived from `agentId` via the same rule used by
	// `TdbAmMemoryProvider.deriveSessionKey()` — without an explicit
	// `metadata.sessionId` at write time, runtime falls back to
	// `agent:<agentId>`. Mirroring it here ensures the panel reads back
	// exactly what the runtime writes.

	private static readonly _DEFAULT_GATEWAY_PORT = 8420;

	private _gatewayBaseUrl(): string {
		const port = this.configurationService.getValue<number>("tdbam.gatewayPort") ?? AgentStudioWebviewController._DEFAULT_GATEWAY_PORT;
		return `http://127.0.0.1:${port}`;
	}

	private _deriveSessionKey(agentId: string): string {
		const trimmed = (agentId ?? "").trim();
		return trimmed.length > 0 ? `agent:${trimmed}` : "agent:default";
	}

	private async _gatewayPost<T>(pathSegment: string, body: unknown, callSite: string): Promise<T | null> {
		const url = `${this._gatewayBaseUrl()}${pathSegment}`;
		try {
			const ctx = await this.requestService.request({
				type: "POST",
				url,
				headers: { "Content-Type": "application/json" },
				data: JSON.stringify(body),
				callSite,
			}, CancellationToken.None);
			const text = await asText(ctx);
			if (!text) {
				return null;
			}
			return JSON.parse(text) as T;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[AgentStudioWebviewController] ${callSite} failed: ${msg}`);
			return null;
		}
	}

	private async _handleMemoryListL0(payload: IMemoryListPayload): Promise<IMemoryListL0Response> {
		const sessionKey = this._deriveSessionKey(payload.agentId);
		const limit = typeof payload.limit === "number" && payload.limit > 0 ? payload.limit : 200;

		type GatewayItem = {
			record_id: string;
			session_key?: string;
			session_id?: string;
			role?: string;
			message_text?: string;
			recorded_at?: string;
			timestamp?: number;
		};
		type GatewayResp = { items?: GatewayItem[]; total?: number; error?: string };

		const resp = await this._gatewayPost<GatewayResp>("/list/conversations", {
			limit,
			session_key: sessionKey,
		}, "agentStudio.memory.listL0");

		if (!resp || resp.error) {
			return { items: [], total: 0 };
		}

		const items: IMemoryL0Item[] = (resp.items ?? []).map((r) => ({
			recordId: r.record_id,
			sessionKey: r.session_key ?? sessionKey,
			sessionId: r.session_id ?? "",
			role: r.role ?? "",
			messageText: r.message_text ?? "",
			recordedAt: r.recorded_at ?? "",
			timestamp: typeof r.timestamp === "number" ? r.timestamp : 0,
		}));
		return { items, total: typeof resp.total === "number" ? resp.total : items.length };
	}

	private async _handleMemoryListL1(payload: IMemoryListPayload): Promise<IMemoryListL1Response> {
		const sessionKey = this._deriveSessionKey(payload.agentId);
		const limit = typeof payload.limit === "number" && payload.limit > 0 ? payload.limit : 200;

		type GatewayItem = {
			id?: string;
			content?: string;
			timestamp?: string;
		};
		type GatewayResp = { items?: GatewayItem[]; total?: number; error?: string };

		const resp = await this._gatewayPost<GatewayResp>("/list/memories", {
			type: "L1",
			limit,
			session_key: sessionKey,
		}, "agentStudio.memory.listL1");

		if (!resp || resp.error) {
			return { items: [], total: 0 };
		}

		const items: IMemoryL1Item[] = (resp.items ?? []).map((r) => ({
			recordId: r.id ?? "",
			content: r.content ?? "",
			updatedTime: r.timestamp ?? "",
		}));
		return { items, total: typeof resp.total === "number" ? resp.total : items.length };
	}

	private async _handleMemoryDelete(
		payload: IMemoryDeletePayload,
		layer: "conversation" | "memory",
	): Promise<IMemoryDeleteResponse> {
		const recordIds = Array.isArray(payload.recordIds)
			? payload.recordIds.filter((id) => typeof id === "string" && id.length > 0)
			: [];
		if (recordIds.length === 0) {
			return { deleted: 0, failed: [] };
		}

		type GatewayResp = { deleted?: number; failed?: string[]; error?: string };
		const callSite = layer === "conversation"
			? "agentStudio.memory.deleteL0"
			: "agentStudio.memory.deleteL1";
		const path = layer === "conversation" ? "/delete/conversation" : "/delete/memory";

		const resp = await this._gatewayPost<GatewayResp>(path, { record_ids: recordIds }, callSite);
		if (!resp || resp.error) {
			return { deleted: 0, failed: [...recordIds] };
		}
		return {
			deleted: typeof resp.deleted === "number" ? resp.deleted : 0,
			failed: Array.isArray(resp.failed) ? resp.failed : [],
		};
	}

	/**
	 * 删除指定 Agent 关联的所有 L0 对话与 L1 记忆。
	 *
	 * 用于在删除 Agent 时级联清理其记忆痕迹，避免 TDB-AM "所有对话" 视图
	 * 仍然残留已删除 Agent 的历史。
	 *
	 * 实现策略：
	 *  - sessionKey 取自 {@link _deriveSessionKey}（标准为 `agent:<agentId>`），
	 *    与 tdb-am-memory 扩展写入时的策略保持一致。
	 *  - 通过 `/list/conversations` + `/list/memories` 拉取该 sessionKey 下
	 *    全部 record_id（limit=500，与 tdbam 全量拉取一致），再批量调用
	 *    `/delete/conversation` 与 `/delete/memory`。
	 *  - 任意一步失败都不会抛错，只记录日志——Agent 删除流程不应被记忆
	 *    清理失败阻断（gateway 可能未启动）。
	 *
	 * @param agentId 被删除的 Agent ID
	 */
	private async _cleanupAgentMemory(agentId: string): Promise<void> {
		if (!agentId) {
			return;
		}
		const sessionKey = this._deriveSessionKey(agentId);
		const FETCH_LIMIT = 500;

		// 1) 收集 L0 record_ids
		type L0Item = { record_id?: string };
		type L0Resp = { items?: L0Item[]; error?: string };
		const l0Resp = await this._gatewayPost<L0Resp>("/list/conversations", {
			limit: FETCH_LIMIT,
			session_key: sessionKey,
		}, "agentStudio.cleanupAgentMemory.listL0");
		const l0RecordIds = (l0Resp?.items ?? [])
			.map((r) => r.record_id)
			.filter((id): id is string => typeof id === "string" && id.length > 0);

		// 2) 收集 L1 record_ids
		type L1Item = { id?: string };
		type L1Resp = { items?: L1Item[]; error?: string };
		const l1Resp = await this._gatewayPost<L1Resp>("/list/memories", {
			type: "L1",
			limit: FETCH_LIMIT,
			session_key: sessionKey,
		}, "agentStudio.cleanupAgentMemory.listL1");
		const l1RecordIds = (l1Resp?.items ?? [])
			.map((r) => r.id)
			.filter((id): id is string => typeof id === "string" && id.length > 0);

		this.logService.info(
			`[AgentStudioWebviewController] cleanupAgentMemory(${agentId}): sessionKey="${sessionKey}", L0=${l0RecordIds.length}, L1=${l1RecordIds.length}`,
		);

		// 3) 批量删除（每个网关接口一次调用即可批量删）
		type DelResp = { deleted?: number; failed?: string[]; error?: string };
		if (l0RecordIds.length > 0) {
			const resp = await this._gatewayPost<DelResp>("/delete/conversation", {
				record_ids: l0RecordIds,
			}, "agentStudio.cleanupAgentMemory.deleteL0");
			const failed = Array.isArray(resp?.failed) ? resp!.failed!.length : 0;
			this.logService.info(
				`[AgentStudioWebviewController] cleanupAgentMemory(${agentId}): L0 deleted=${resp?.deleted ?? 0}, failed=${failed}`,
			);
		}
		if (l1RecordIds.length > 0) {
			const resp = await this._gatewayPost<DelResp>("/delete/memory", {
				type: "L1",
				record_ids: l1RecordIds,
			}, "agentStudio.cleanupAgentMemory.deleteL1");
			const failed = Array.isArray(resp?.failed) ? resp!.failed!.length : 0;
			this.logService.info(
				`[AgentStudioWebviewController] cleanupAgentMemory(${agentId}): L1 deleted=${resp?.deleted ?? 0}, failed=${failed}`,
			);
		}
	}

	// ─── Public API ─────────────────────────────────────────────────────────────

	// ── Checkpoint Diff ──────────────────────────────

	/**
	 * Handle "open checkpoint diff" request from the webview.
	 * Writes the snapshot (checkpoint-time content) to a temp file and opens
	 * a diff editor (snapshot vs. current file content).
	 */
	private async _handleOpenCheckpointDiff(
		payload: IChatOpenCheckpointDiffPayload,
	): Promise<void> {
		const { checkpointId, fileUri, sessionId } = payload;
		const agentId = payload.agentId;
		this.logService.info(
			`[AgentStudioWebviewController] chat.openCheckpointDiff → ${checkpointId} file=${fileUri}`,
		);

		try {
			// 1. Read snapshot content (checkpoint-time file content).
			//    取整份快照列表后自行匹配，便于在 URI 不一致时打印诊断信息。
			const snapshots = await this.checkpointService.getFileSnapshots(
				agentId, sessionId, checkpointId,
			);
			const matched = snapshots.find(s => s.uri.toString() === fileUri);
			if (!matched) {
				this.logService.warn(
					`[AgentStudioWebviewController] No snapshot matched file=${fileUri} in checkpoint ${checkpointId}. ` +
					`Available snapshot uris=[${snapshots.map(s => s.uri.toString()).join(', ')}]`,
				);
				return;
			}
			const snapshotContent = matched.content;

			// 2. Write snapshot to a temp file under workspace home
			const wsId = this.agentStudioService.getActiveWorkspaceId();
			let baseDir: string;
			if (wsId) {
				const workspace = await this.agentStudioService.getWorkspace(wsId);
				baseDir = workspace?.path ?? (this._environmentService as INativeEnvironmentService).userHome.fsPath;
			} else {
				baseDir = (this._environmentService as INativeEnvironmentService).userHome.fsPath;
			}
			// 从快照 URI 取文件名（比 split('/') 更健壮，能正确处理 file:/// 等 scheme）。
			const fileName = matched.uri.path.split('/').filter(Boolean).pop() ?? 'file';
			const baseDirUri = URI.file(baseDir);
			const snapshotUri = URI.joinPath(baseDirUri, '.sarosisworkspace', 'checkpoint-diffs', checkpointId, fileName);
			await this.fileService.writeFile(snapshotUri, VSBuffer.fromString(snapshotContent));

			// 3. Build diff editor input and open
			const diffInput: IResourceDiffEditorInput = {
				original: { resource: snapshotUri },
				modified: { resource: matched.uri },
				label: `${fileName} (检查点快照)`,
			};
			const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
			const pane = await this.editorService.openEditor(diffInput, targetGroup);

			// 4. Force inline diff rendering (single column with +/- markers),
			//    覆盖全局 diffEditor.renderSideBySide 配置，匹配期望样式。
			const diffPane = pane as ITextDiffEditorPane | undefined;
			const diffControl = diffPane?.getControl?.();
			diffControl?.updateOptions({
				renderSideBySide: false,
				renderMarginRevertIcon: true,
				hideUnchangedRegions: { enabled: true },
			} as IDiffEditorOptions);

			this.logService.info(
				`[AgentStudioWebviewController] openCheckpointDiff opened inline diff for ${fileName} (group=${targetGroup === SIDE_GROUP ? 'SIDE' : 'first'})`,
			);

		} catch (err) {
			this.logService.error(
				`[AgentStudioWebviewController] openCheckpointDiff failed for ${fileUri}:`,
				err,
			);
		}
	}

	/**
	 * 撤销全部检查点：把每个被改过的文件还原到最早一次编辑前的原始内容
	 * （新建的文件删除），并 ghost 所有检查点。可选地截断持久化历史，使
	 * 回退在 reload 后仍然生效。
	 */
	private async _handleRevertAllCheckpoints(
		payload: IChatRevertAllCheckpointsPayload,
	): Promise<void> {
		this.logService.info(
			`[AgentStudioWebviewController] chat.revertAllCheckpoints (agent=${(payload.agentId)})`,
		);
		await this.checkpointService.revertAllCheckpoints(
			(payload.agentId),
			payload.sessionId,
		);
		if (payload.truncateAfterMessageId) {
			try {
				await this.agentChatService.deleteMessagesAfter(
					(payload.agentId),
					payload.sessionId,
					payload.truncateAfterMessageId,
				);
			} catch (err) {
				this.logService.error(
					"[AgentStudioWebviewController] revertAll: failed to truncate history:",
					err,
				);
			}
		}
	}

	/**
	 * 保留全部检查点：删除磁盘上所有检查点数据（快照文件 + index）。
	 * reload 后 listCheckpoints 返回空，CheckpointBar 不会显示。
	 * webview 侧 messages 中的 checkpoint 消息也已被移除（keepAllCheckpoints action）。
	 */
	private async _handleKeepAllCheckpoints(
		payload: IChatKeepAllCheckpointsPayload,
	): Promise<void> {
		this.logService.info(
			`[AgentStudioWebviewController] chat.keepAllCheckpoints (agent=${(payload.agentId)})`,
		);
		await this.checkpointService.deleteAllCheckpoints(
			(payload.agentId),
			payload.sessionId,
		);
	}

	/**
	 * 在一个多文件 diff 窗口（MultiDiffEditor）中显示所有检查点的全部改动：
	 * 对每个被改过的文件，original = 最早一次快照（首次编辑前的原始内容），
	 * modified = 当前磁盘内容。
	 */
	private async _handleOpenAllCheckpointsDiff(
		payload: IChatOpenAllCheckpointsDiffPayload,
	): Promise<void> {
		const { sessionId } = payload;
		const agentId = payload.agentId;
		this.logService.info(
			`[AgentStudioWebviewController] chat.openAllCheckpointsDiff (agent=${agentId})`,
		);

		try {
			const snapshots = await this.checkpointService.getAggregatedFileSnapshots(
				agentId, sessionId,
			);
			if (snapshots.length === 0) {
				this.logService.info('[AgentStudioWebviewController] openAllCheckpointsDiff: no snapshots');
				return;
			}

			// 解析临时快照写入根目录（与单文件 diff 一致）。
			const wsId = this.agentStudioService.getActiveWorkspaceId();
			let baseDir: string;
			if (wsId) {
				const workspace = await this.agentStudioService.getWorkspace(wsId);
				baseDir = workspace?.path ?? (this._environmentService as INativeEnvironmentService).userHome.fsPath;
			} else {
				baseDir = (this._environmentService as INativeEnvironmentService).userHome.fsPath;
			}
			const baseDirUri = URI.file(baseDir);

			// 为每个文件写出"原始内容"临时文件，并构造 diff 资源项。
			const resources: IResourceDiffEditorInput[] = [];
			for (const snap of snapshots) {
				const fileName = snap.uri.path.split('/').filter(Boolean).pop() ?? 'file';
				// 用 snapshotId 作为子目录，避免同名文件互相覆盖。
				const originalUri = URI.joinPath(
					baseDirUri, '.sarosisworkspace', 'checkpoint-diffs', '__all__', snap.id, fileName,
				);
				try {
					await this.fileService.writeFile(originalUri, VSBuffer.fromString(snap.content));
				} catch (err) {
					this.logService.warn(`[AgentStudioWebviewController] openAllCheckpointsDiff: failed to write temp for ${fileName}: ${err}`);
					continue;
				}
				resources.push({
					original: { resource: originalUri },
					modified: { resource: snap.uri },
					label: fileName,
				});
			}

			if (resources.length === 0) {
				this.logService.warn('[AgentStudioWebviewController] openAllCheckpointsDiff: no diff resources built');
				return;
			}

			// multiDiffSource 作为该窗口的唯一标识：再次打开会复用同一窗口。
			const multiDiffInput: IResourceMultiDiffEditorInput = {
				multiDiffSource: URI.from({ scheme: 'agent-checkpoint-alldiff', path: `/${agentId}/${sessionId}` }),
				label: '检查点全部变更',
				resources,
				isTransient: true,
			};
			const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
			await this.editorService.openEditor(multiDiffInput, targetGroup);

			this.logService.info(
				`[AgentStudioWebviewController] openAllCheckpointsDiff opened multi-diff with ${resources.length} files`,
			);
		} catch (err) {
			this.logService.error(
				'[AgentStudioWebviewController] openAllCheckpointsDiff failed:',
				err,
			);
		}
	}

	// ── Public API ─────────────────────────────────────

	// ── Workflow Editor handlers ──────────────────────

	/**
	 * Handle `workflow.get` — webview requests workflow data by ID.
	 */
	private async _handleWorkflowGet(payload: { id: string; workspaceId?: string }): Promise<Record<string, unknown> | null> {
		try {
			const wf = await this.workflowStorageService.getWorkflow(payload.id, payload.workspaceId);
			if (!wf) {
				return null;
			}
			return wf as unknown as Record<string, unknown>;
		} catch (err) {
			this.logService.error('[AgentStudioWebviewController] workflow.get failed', err);
			return null;
		}
	}

	/**
	 * Handle `workflow.save` — webview sends updated workflow data to persist.
	 */
	private async _handleWorkflowSave(payload: { workflow: Record<string, unknown>; workspaceId?: string }): Promise<{ success: boolean }> {
		try {
			const wf = payload.workflow as { id: string; name?: string };
			if (!wf.id) {
				return { success: false };
			}

			// v9: if the name changed, also rename the bound agent so they stay in sync.
			if (typeof wf.name === 'string') {
				const existing = await this.workflowStorageService.getWorkflow(wf.id);
				if (existing && existing.name !== wf.name && existing.agentId) {
					try {
						// v9: agent name = workflow name (no suffix)
						await this.agentStudioService.updateAgent(existing.agentId, {
							name: wf.name,
						});
						this.logService.info(
							`[AgentStudioWebviewController] Synced agent name: workflow="${existing.name}" → "${wf.name}", agentId=${existing.agentId}`,
						);
					} catch (err) {
						this.logService.warn('[AgentStudioWebviewController] Failed to sync agent name:', err);
					}
				}
			}

			await this.workflowStorageService.updateWorkflow(wf.id, payload.workflow, payload.workspaceId);
			// Also fire an event so the workflow list sidebar refreshes
			this._sendEvent('workflow.saved', { id: wf.id });
			return { success: true };
		} catch (err) {
			this.logService.error('[AgentStudioWebviewController] workflow.save failed', err);
			return { success: false };
		}
	}

	/**
	 * Handle `workflow.execute` — webview asks host to start executing a workflow.
	 * Returns the execution ID; status updates are pushed via `workflow.executionUpdate` events.
	 */
	private async _handleWorkflowExecute(payload: { workflowId: string; agentId?: string; context?: Record<string, unknown> }): Promise<Record<string, unknown> | null> {
		try {
			this.logService.info(`[AgentStudioWebviewController] workflow.execute: workflowId=${payload.workflowId}, agentId=${payload.agentId}`);
			const executionId = await this.workflowExecutionService.executeWorkflow(payload.workflowId, {
				agentId: payload.agentId,
				context: payload.context,
			});
			// P4: include the owner-agent session info so the webview can
			// auto-switch to the chat panel showing the live trace.
			const sessionInfo = this.workflowExecutionService.getExecutionSession(executionId);
			return sessionInfo
				? { executionId, sessionInfo }
				: { executionId };
		} catch (err) {
			this.logService.error('[AgentStudioWebviewController] workflow.execute failed', err);
			throw err;
		}
	}

	/**
	 * Handle `workflow.resume` — webview provides user input for a paused execution
	 * (e.g. AskUser node response, or resume after breakpoint).
	 */
	private async _handleWorkflowResume(payload: { executionId: string; userInput: string | string[] }): Promise<Record<string, unknown> | null> {
		try {
			this.logService.info(`[AgentStudioWebviewController] workflow.resume: executionId=${payload.executionId}`);
			await this.workflowExecutionService.resumeExecution(payload.executionId, payload.userInput);
			return { success: true };
		} catch (err) {
			this.logService.error('[AgentStudioWebviewController] workflow.resume failed', err);
			throw err;
		}
	}

	/**
	 * Handle `workflow.cancel` — webview asks host to cancel a running execution.
	 */
	private async _handleWorkflowCancel(payload: { executionId: string }): Promise<Record<string, unknown> | null> {
		try {
			this.logService.info(`[AgentStudioWebviewController] workflow.cancel: executionId=${payload.executionId}`);
			await this.workflowExecutionService.cancelExecution(payload.executionId);
			return { success: true };
		} catch (err) {
			this.logService.error('[AgentStudioWebviewController] workflow.cancel failed', err);
			throw err;
		}
	}

	/**
	 * v5a: Persist a breakpoint on a workflow node. Optionally applies it to
	 * a running execution for immediate effect.
	 */
	private async _handleWorkflowBreakpointSet(payload: { workflowId: string; nodeId: string; executionId?: string }): Promise<Record<string, unknown> | null> {
		try {
			this.logService.info(`[AgentStudioWebviewController] workflow.breakpoint.set: workflowId=${payload.workflowId}, nodeId=${payload.nodeId}`);
			await this.workflowExecutionService.setWorkflowBreakpoint(payload.workflowId, payload.nodeId, payload.executionId);
			return { success: true };
		} catch (err) {
			this.logService.error('[AgentStudioWebviewController] workflow.breakpoint.set failed', err);
			throw err;
		}
	}

	private async _handleWorkflowBreakpointClear(payload: { workflowId: string; nodeId: string; executionId?: string }): Promise<Record<string, unknown> | null> {
		try {
			this.logService.info(`[AgentStudioWebviewController] workflow.breakpoint.clear: workflowId=${payload.workflowId}, nodeId=${payload.nodeId}`);
			await this.workflowExecutionService.clearWorkflowBreakpoint(payload.workflowId, payload.nodeId, payload.executionId);
			return { success: true };
		} catch (err) {
			this.logService.error('[AgentStudioWebviewController] workflow.breakpoint.clear failed', err);
			throw err;
		}
	}

	private async _handleWorkflowBreakpointGet(payload: { workflowId: string }): Promise<Record<string, unknown> | null> {
		try {
			const nodeIds = await this.workflowExecutionService.getWorkflowBreakpoints(payload.workflowId);
			return { success: true, breakpoints: nodeIds };
		} catch (err) {
			this.logService.error('[AgentStudioWebviewController] workflow.breakpoint.get failed', err);
			throw err;
		}
	}

	/**
	 * v10: Handle `workflow.list` — return all workflows, optionally filtered by workspace.
	 */
	private async _handleWorkflowList(payload: { workspaceId?: string }): Promise<Record<string, unknown> | null> {
		try {
			const workflows = await this.workflowStorageService.listWorkflows(payload.workspaceId);
			// Return a minimal subset so the webview dropdown isn't bloated.
			return {
				workflows: workflows.map(w => ({
					id: w.id,
					name: w.name,
					agentId: w.agentId,
				})),
			};
		} catch (err) {
			this.logService.error('[AgentStudioWebviewController] workflow.list failed', err);
			throw err;
		}
	}

	/**
	 * v19: Handle `workflow.reorder` — webview sends new workflow order after drag-and-drop.
	 * Persists the order so it survives reloads.
	 */
	private async _handleWorkflowReorder(payload: { orderedIds: string[]; workspaceId?: string }): Promise<{ success: boolean }> {
		try {
			await this.workflowStorageService.reorderWorkflows(payload.orderedIds, payload.workspaceId);
			this.logService.info(`[AgentStudioWebviewController] workflow.reorder: saved order for ${payload.orderedIds.length} workflows`);
			return { success: true };
		} catch (err) {
			this.logService.error('[AgentStudioWebviewController] workflow.reorder failed', err);
			return { success: false };
		}
	}

	/**
	 * v19: Handle `workflow.open` — webview requests opening a workflow in the editor.
	 * Returns the full workflow data so the webview can load it directly.
	 */
	private async _handleWorkflowOpen(payload: { workflowId: string }): Promise<Record<string, unknown> | null> {
		try {
			this.logService.info(`[AgentStudioWebviewController] workflow.open: ${payload.workflowId}`);
			const wf = await this.workflowStorageService.getWorkflow(payload.workflowId);
			if (wf) {
				return { success: true, workflow: wf };
			}
			return { success: false };
		} catch (err) {
			this.logService.error('[AgentStudioWebviewController] workflow.open failed', err);
			return { success: false };
		}
	}

	/**
	 * v6: Handle `workflow.submitVariables` — webview provides variable values
	 * collected from the user before workflow execution starts.
	 */
	private async _handleWorkflowSubmitVariables(payload: { executionId: string; values: Record<string, string> }): Promise<Record<string, unknown> | null> {
		try {
			this.logService.info(`[AgentStudioWebviewController] workflow.submitVariables: executionId=${payload.executionId}, keys=${Object.keys(payload.values || {}).join(',')}`);
			await this.workflowExecutionService.submitWorkflowVariables(payload.executionId, payload.values);
			return { success: true };
		} catch (err) {
			this.logService.error('[AgentStudioWebviewController] workflow.submitVariables failed', err);
			throw err;
		}
	}

	layout(width: number, height: number): void {
		// WebView auto-fills container, but notify if needed
		if (this._webview) {
			this.container.style.width = `${width}px`;
			this.container.style.height = `${height}px`;
		}
	}
}
