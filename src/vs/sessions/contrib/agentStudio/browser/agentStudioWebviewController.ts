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
import { IMainProcessService } from "../../../../platform/ipc/common/mainProcessService.js";
import { MEDIA_STORE_CHANNEL, type IMediaBackend, type MediaImportRequest, type MediaListFilter } from "../common/mediaStoreChannel.js";
import { createMediaStoreProxy } from "./mediaStoreProxy.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { URI } from "../../../../base/common/uri.js";
import { mainWindow, type CodeWindow } from "../../../../base/browser/window.js";
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
import { SAROS_CLAW_AGENT_ID } from "../common/constants.js";
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
import { canvasOpsRequestEmitter, resolveCanvasOps } from './providers/tool/canvasOpsBridge.js';
import { canvasContextStore } from './messageEnrichment/canvasContextStore.js';
import { IWorkbenchThemeService } from "../../../../workbench/services/themes/common/workbenchThemeService.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { VSBuffer, encodeBase64 } from "../../../../base/common/buffer.js";
import { IModelService } from "../../../../editor/common/services/model.js";
import type { IDiffEditorOptions } from "../../../../editor/common/config/editorOptions.js";
import { IOpenerService } from "../../../../platform/opener/common/opener.js";
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
	IConfigHtmlEventPayload,
	IConfigHtmlChatSendPayload,
	IConfigHtmlHtmlGeneratePayload,
	IConfigHtmlWriteHtmlPayload,
	IConfigHtmlGetHtmlPayload,
	IConfigHtmlChatSendStreamPayload,
	IConfigHtmlChatCancelStreamPayload,
	IConfigHtmlRunTerminalPayload,
	IConfigHtmlKvGetPayload,
	IConfigHtmlKvSetPayload,
	IConfigHtmlKvDeletePayload,
	IConfigHtmlKvListPayload,
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

	/** Layout-sync callback — set only when the pool hot path is used. */
	private _poolSyncLayout: (() => void) | undefined;

	/** Pending tool approval requests: toolCallId → resolve function */
	private readonly _pendingToolApprovals = new Map<string, { resolve: (decision: ToolApprovalDecision) => void }>();

	/**
	 * Perf instrumentation: epoch ms when this controller was constructed
	 * (i.e. when the host started opening this panel). Injected into the
	 * webview HTML so the React app can measure program-start → first-paint.
	 */
	private readonly _perfCreateTs = Date.now();

	/** Feature flag: if true, use Native Chat mode (skip webview creation) */
	private _useNativeMode = false;

	/** 媒体资产库后端（经主进程 ProxyChannel，懒初始化）。 */
	private _mediaBackend: IMediaBackend | null = null;
	private _getMediaBackend(): IMediaBackend | null {
		if (!this._mediaBackend && this.mainProcessService?.getChannel(MEDIA_STORE_CHANNEL)) {
			this._mediaBackend = createMediaStoreProxy(this.mainProcessService);
		}
		return this._mediaBackend;
	}

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
		@IWorktreeService private readonly worktreeService: IWorktreeService,
		@ICheckpointService private readonly checkpointService: ICheckpointService,
		@IWorkflowStorageService private readonly workflowStorageService: IWorkflowStorageService,
		@IWorkflowExecutionService private readonly workflowExecutionService: IWorkflowExecutionService,
		@IAgentStudioWebviewPool private readonly webviewPool: IAgentStudioWebviewPool,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
	) {
		super();

		// ── DIAGNOSTIC: confirm constructor is entered ──
		this.logService.info(`[AS-DIAG] AgentStudioWebviewController CONSTRUCTOR — panelType=${this.panelType}, hasInitialData=${!!this.initialData}, container=${!!this.container}`);

		// NativeChatEditorPane is now the sole chat renderer (React AgentChat deprecated).
		// For 'chat' panelType, always use native mode — skip webview creation.
		// workflow-editor / taskboard / settings still need the webview.
		this._useNativeMode = (this.panelType === 'chat' || this.panelType === undefined);

		// ── DIAGNOSTIC: log _useNativeMode value ──
		this.logService.info(`[AS-DIAG] _useNativeMode=${this._useNativeMode} (panelType=${this.panelType})`);

		if (this._useNativeMode) {
			// Native mode: skip webview creation, just set up session service
			// Register with _register() so it is disposed when the controller is disposed.
			this._sessionService = this._register(new WorkspaceSessionService(
				logService,
				this.fileService,
				agentStudioService,
			));
			// Note: We still need _registerServiceListeners() for non-webview features
			// but most listeners send events to webview which doesn't exist.
			// TODO: Consider removing this controller entirely in native mode.
			this.logService.info(`[AS-DIAG] EARLY RETURN — native mode enabled, skipping webview creation`);
			return; // Early return - no webview created
		}

		// Register with _register() so it is disposed when the controller is disposed.
		this._sessionService = this._register(new WorkspaceSessionService(
			logService,
			this.fileService,
			agentStudioService,
		));
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

		// Subscribe to ConfigHtml model write confirmations — show a tool card
		// in the chat UI with 同意 / 放弃 / 始终同意 buttons when the LLM tries
		// to modify config.html.
		this._register(
			this._configHtmlService.onDidRequestModelWriteConfirm(({ requestId, agentId, contentLen, preview }) => {
				const toolCallId = requestId; // reuse requestId as toolCallId
				this._pendingToolApprovals.set(toolCallId, {
					resolve: (decision: ToolApprovalDecision) => {
						// Map ToolApprovalDecision → 'approve' | 'deny' | 'always'
						const mapped: 'approve' | 'deny' | 'always' =
							decision === ToolApprovalDecision.AllowAlways ? 'always' :
							decision === ToolApprovalDecision.AllowOnce ? 'approve' : 'deny';
						this._configHtmlService.resolveModelWriteConfirm(requestId, mapped);
					},
				});
				this._sendEvent('chat.toolApprovalRequest', {
					toolCallId,
					toolName: 'config.html 写入',
					arguments: { agentId, contentLen, preview: preview.slice(0, 200) },
					securityLevel: 'safe',
					reason: `LLM 请求修改 agent "${agentId}" 的 config.html（${contentLen} 字符）`,
				} as IChatToolApprovalRequestPayload);
				this.logService.info(`[AgentStudioWebviewController] model write confirm card shown: agentId=${agentId} requestId=${requestId}`);
			}),
		);

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
				// Skip verbose logging for delta events — hundreds fire during streaming
				// and the console I/O contributes to UI thread saturation.
				if (trace.kind !== 'delta') {
					console.log(`[AgentStudioWebviewController] onDidExecutionTrace: kind=${trace.kind} node=${(trace as any).nodeId} execId=${trace.executionId} session=${trace.sessionId}`);
				}
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
			"out",
			"vs",
			"sessions",
			"contrib",
			"agentStudio",
			"webview",
			"media",
		);
	}

	/**
	 * 媒体资产库根目录（生成图片自动保存的落盘位置）。
	 *
	 * 必须加入 webview 的 `localResourceRoots`：`_handleMediaGetUrl` 会把已落盘
	 * 资产的绝对路径经 `asWebviewUri` 转成 `vscode-webview://`，而 webview 只允许
	 * 加载白名单目录下的本地文件——否则媒体库/节点缩略图会加载失败（图像不显示）。
	 *
	 * 与主进程 `MediaStoreChannel` 的 rootDir 保持一致：`${userDataPath}/media`
	 * （打包 `~/.vssaros/media`，dev `~/.vssaros-dev/media`）。
	 */
	private _getMediaLibraryUri(): URI {
		const userDataPath = (this._environmentService as INativeEnvironmentService)
			.userDataPath;
		return URI.joinPath(URI.file(userDataPath), "media");
	}

	/**
	 * 重新初始化 webview（iframe 跨 document 移动后重建通信通道）。
	 */
	reinitializeWebview(newSyncLayout?: () => void): void {
		this._createWebview();
		newSyncLayout?.();
	}

	private _createWebview(): void {
		this.logService.info(`[AS-DIAG] _createWebview() CALLED — panelType=${this.panelType}`);
		// Fire-and-forget, but surface any synchronous or early async errors
		this._createWebviewAsync().catch((err) => {
			// Use console.error directly (logService may not be available in catch)
			console.error('[AS-DIAG] _createWebviewAsync FAILED', err);
		});
	}

	private async _createWebviewAsync(): Promise<void> {
		// ── DIAGNOSTIC: confirm this method is actually entered ──
		this.logService.info(`[AS-DIAG] _createWebviewAsync ENTERED — panelType=${this.panelType}, hasInitialData=${!!this.initialData}`);
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

			// ── DIAGNOSTIC LOG: hot path initialData ──
			this.logService.info(`[AS-DIAG] HOT PATH — panelType=${this.panelType}, initialData type=${typeof this.initialData}, value=${JSON.stringify(this.initialData)?.substring(0, 500)}`);

			// CRITICAL: iframes cannot be re-parented without losing state (Chromium
			// limitation). Use absolute-position overlay: keep the pool container on
			// document.body and position it precisely over our panel container.
			// Layer discipline: the overlay must NEVER compete with VS Code UI —
			// keep z-index at 1 (above the plain container content, below VS Code
			// parts like the sidebar/panel which use higher z-indexes) and clip
			// the iframe so it can never bleed outside its mirrored rect.
			const poolContainer = pooled.container;
			poolContainer.style.position = 'absolute';
			poolContainer.style.overflow = 'hidden';
			poolContainer.style.zIndex = '1';
			poolContainer.removeAttribute('data-agent-studio-pool');

			// Track our panel container's geometry and mirror it onto the pool container.
			const syncLayout = () => {
				const rect = this.container.getBoundingClientRect();
				const hidden = rect.width <= 0 || rect.height <= 0;
				poolContainer.style.display = hidden ? 'none' : '';
				if (hidden) { return; }
				poolContainer.style.left = `${rect.left}px`;
				poolContainer.style.top = `${rect.top}px`;
				poolContainer.style.width = `${rect.width}px`;
				poolContainer.style.height = `${rect.height}px`;
			};
			syncLayout();

			// Store sync callback so layout() & setVisible() can
			// re-position the iframe when the editor pane is re-shown.
			this._poolSyncLayout = syncLayout;

			// Re-sync on resize / layout changes. A plain ResizeObserver misses
			// geometry shifts where the container keeps its size but moves (zoom,
			// layout/zoom-level changes, toolbar height changes) — window resize +
			// capture-phase scroll re-run the mirror for those cases.
			const resizeObserver = new ResizeObserver(syncLayout);
			resizeObserver.observe(this.container);
			this._register({ dispose: () => resizeObserver.disconnect() });
			const syncOnWindow = () => syncLayout();
			window.addEventListener('resize', syncOnWindow);
			window.addEventListener('scroll', syncOnWindow, true);
			this._register({
				dispose: () => {
					this._poolSyncLayout = undefined;
					window.removeEventListener('resize', syncOnWindow);
					window.removeEventListener('scroll', syncOnWindow, true);
					poolContainer.remove();
				}
			});

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
		// ── DIAGNOSTIC LOG: cold path initialData ──
		this.logService.info(`[AS-DIAG] COLD PATH — panelType=${this.panelType}, initialData type=${typeof this.initialData}, value=${JSON.stringify(this.initialData)?.substring(0, 500)}`);

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
				// allow the same webview document to call acquireVsCodeApi() multiple
				// times — the shared-renderer/pinned-origin setup re-executes the
				// bundle in some conditions and the default (single-acquire) throws
				// "An instance of the VS Code API has already been acquired", which
				// aborts the whole IIFE and leaves the panel on the loading spinner.
				allowMultipleAPIAcquire: true,
				// 第二个 root = 媒体资产库（生成图片落盘目录），否则 media.getUrl
				// 返回的 vscode-webview:// 资源会被拒绝加载。
				localResourceRoots: [mediaUri, this._getMediaLibraryUri()],
			},
			extension: undefined,
		});

		this._register(this._webview);
		const _perfMountStart = Date.now();
		// CRITICAL: iframes cannot be re-parented without losing state (Chromium
		// limitation). Mirror the HOT PATH and mount the webview into a
		// body-level absolute overlay that tracks our panel container's
		// geometry — instead of mounting it directly inside `this.container`
		// (which lives inside the collapsible grid column). This keeps the
		// iframe alive when the column is hidden (display:none) and lets the
		// "popout chat" feature reposition the overlay over a floating window
		// without reloading the iframe.
		const targetDoc = this.container.ownerDocument;
		const targetWindow = targetDoc.defaultView as CodeWindow;
		const coldOverlay = targetDoc.createElement('div');
		coldOverlay.style.position = 'absolute';
		// Keep the overlay beneath VS Code parts (sidebar/panel/editor chrome)
		// so it can never visually mask unrelated UI; it only needs to cover
		// the panel container itself (which sits at layer 0/auto).
		coldOverlay.style.zIndex = '1';
		coldOverlay.style.overflow = 'hidden';
		coldOverlay.setAttribute('data-agent-studio-overlay', 'cold');
		targetDoc.body.appendChild(coldOverlay);

		const coldSyncLayout = () => {
			const rect = this.container.getBoundingClientRect();
			const hidden = rect.width <= 0 || rect.height <= 0;
			coldOverlay.style.display = hidden ? 'none' : '';
			if (hidden) { return; }
			coldOverlay.style.left = `${rect.left}px`;
			coldOverlay.style.top = `${rect.top}px`;
			coldOverlay.style.width = `${rect.width}px`;
			coldOverlay.style.height = `${rect.height}px`;
		};
		coldSyncLayout();
		// Store sync callback so layout() & setVisible() can re-position the
		// iframe when the editor pane is re-shown.
		this._poolSyncLayout = coldSyncLayout;
		const coldResizeObserver = new ResizeObserver(coldSyncLayout);
		coldResizeObserver.observe(this.container);
		this._register({ dispose: () => coldResizeObserver.disconnect() });
		const coldSyncOnWindow = () => coldSyncLayout();
		targetWindow.addEventListener('resize', coldSyncOnWindow);
		targetWindow.addEventListener('scroll', coldSyncOnWindow, true);
		this._register({
			dispose: () => {
				this._poolSyncLayout = undefined;
				targetWindow.removeEventListener('resize', coldSyncOnWindow);
				targetWindow.removeEventListener('scroll', coldSyncOnWindow, true);
				coldOverlay.remove();
			}
		});

		this._webview.mountTo(coldOverlay, targetWindow);
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
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob: https: http://127.0.0.1:* http://localhost:* vscode-webview: vscode-resource:; font-src data: vscode-webview: vscode-resource:; connect-src data: blob: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*;">
	<title>Agent Studio</title>
	${styleTag}
	<style nonce="${nonce}">
		@keyframes as-spin { to { transform: rotate(360deg); } }
		html, body { margin: 0; padding: 0; overflow: hidden; height: 100%; }
		body { background: var(--as-bg-primary, var(--vscode-editor-background)); color: var(--as-fg-primary, var(--vscode-foreground)); font-family: var(--vscode-font-family); }
		#root { width: 100%; height: 100%; }
		/* Ensure standalone panels fill the full webview height */
		.panel-standalone, .agent-chat-root, .agent-chat { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
		/* agent-chat uses flex inside agent-chat-root; let it fill remaining height */
		.agent-chat { flex: 1 1 auto; min-height: 0; }
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

		// ── Fallback: if the bundle never reaches __AS_BUNDLE_LOADED__ = true
		//    (e.g. crash before index.tsx runs, or a duplicate acquireVsCodeApi
		//    that aborts the whole IIFE), the inline loading placeholder would
		//    sit forever. After 6s, force-remove it and show a diagnostic so
		//    the user is never stuck. ──────────────────────────────
		(function() {
			var done = false;
			function dismiss() {
				if (done) { return; }
				done = true;
				var el = document.getElementById('as-preload');
				if (el && el.parentNode) { el.parentNode.removeChild(el); }
			}
			// index.tsx first line sets this flag. If it appears, dismiss the placeholder.
			try {
				Object.defineProperty(window, '__AS_BUNDLE_LOADED__', {
					configurable: true,
					set: function(v) { if (v) { dismiss(); } }
				});
			} catch (e) { /* fallback already exists; relying on timeout */ }
			// Also clear the placeholder once React renders anything into #root.
			try {
				var root = document.getElementById('root');
				if (root) {
					var obs = new MutationObserver(function() {
						if (root.childElementCount > 0 && !document.getElementById('as-preload')) {
							dismiss();
						}
					});
					obs.observe(root, { childList: true });
				}
			} catch (e) { /* MutationObserver optional */ }
			// 6s hard timeout: show diagnostic.
			setTimeout(function() {
				if (done) { return; }
				var el = document.getElementById('as-preload');
				if (el) {
					el.innerHTML =
						'<div style="padding:16px;max-width:560px;text-align:left;font-family:Consolas,monospace;font-size:12px;line-height:1.6;">' +
						'<div style="color:#f48771;font-weight:600;margin-bottom:6px;">Agent Studio bundle did not finish loading (6s timeout)</div>' +
						'<div style="color:var(--vscode-descriptionForeground,#858585);">Open the webview DevTools (Command Palette → Developer: Toggle Webview Developer Tools) to inspect the console. Likely causes:</div>' +
						'<ul style="margin:6px 0 0 18px;color:var(--vscode-foreground,#ccc);">' +
						'<li>Duplicate acquireVsCodeApi() call (mitigated by window cache + try/catch)</li>' +
						'<li>An ESM import throws before the IIFE finishes (e.g. FileSystemError)</li>' +
						'<li>Try: Developer: Reload Webview or restart VS Code.</li>' +
						'</ul></div>';
				}
			}, 6000);
		})();
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

	/**
	 * Update the tab label of any open AgentSettingsEditorInput for the given
	 * agentId. Called after an agent rename so the editor tab stays in sync.
	 */
	private _syncEditorLabelsForAgent(agentId: string, agentName: string): void {
		try {
			const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			for (const group of groups) {
				for (const editor of group.editors) {
					if (editor instanceof AgentSettingsEditorInput && editor.agentId === agentId) {
						editor.setAgentName(agentName);
					}
				}
			}
		} catch (err) {
			this.logService.warn(`[AgentStudioWebviewController] _syncEditorLabelsForAgent failed: ${err instanceof Error ? err.message : String(err)}`);
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
			case "agents.presets":
				return this.agentStudioService.getAgentPresets();
			case "agents.get":
				return this.agentStudioService.getAgent(p.id as string);
			case "agents.create":
				return this.agentStudioService.createAgent(p as Record<string, unknown>);
		case "agents.update": {
			await this.agentStudioService.updateAgent(p.id as string, p.data as Record<string, unknown>);
			// If the name changed, sync all open editor tab labels that show this agent.
			const updatedAgent = await this.agentStudioService.getAgent(p.id as string);
			if (updatedAgent && (p.data as Record<string, unknown>)?.name) {
				this._syncEditorLabelsForAgent(updatedAgent.id, updatedAgent.name);
			}
			return undefined;
		}
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
				// 按 (agentId, sessionId) 精确取消，避免误杀其他并发聊天窗口的 loop。
				this.agentOSService.cancelAgentLoop(
					p.agentId as string | undefined,
					p.agentSessionId as string | undefined,
				);
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
			case "imagegen.generate":
				return this._handleImageGenGenerate(
					p as unknown as {
						providerId: string;
						modelId: string;
						prompt: string;
						negativePrompt?: string;
						width?: number;
						height?: number;
						numImages?: number;
					},
				);
			case "reversePrompt.generate":
				// P2: describe an image via a provider's chat (reverse prompt).
				return this._handleReversePromptGenerate(
					p as unknown as {
						providerId: string;
						modelId: string;
						imageRef: string;
						prompt?: string;
					},
				);
			case "comfy.fetch":
				// ComfyUI 跨源保护：仅放行 Origin http://127.0.0.1:8188（自 origin）。
				// webview fetch 必带 Origin: vscode-webview://... → 被 403 → Failed to fetch。
				// 主进程代理：node fetch 默认不带 Origin 头，绕开 ComfyUI 的 403。
				return this._handleComfyFetch(
					p as unknown as {
						url: string;
						method?: string;
						headers?: Record<string, string>;
						body?: string;
					},
				);
			case "comfy.launch":
				// ComfyUI 一键启动（--enable-cors-header）。主进程 comfy:launch handler。
				return this._handleComfyLaunch(p as unknown as { baseUrl?: string; port?: number } | undefined);
			case "comfy.getLaunchPaths":
				// 查询主进程解析的启动路径（含 overrides 来源 env/override/auto）。
				return this._handleComfyGetLaunchPaths();
			case "comfy.setLaunchPaths":
				// 写入 sarosis.comfyui.pythonPath/mainPath（持久化）。
				return this._handleComfySetLaunchPaths(p as unknown as { pythonPath?: string; mainPyPath?: string } | undefined);
			case "comfy.checkDeps":
				// 依赖检测：ComfyUI 安装/运行状态 + 本地模型文件列表。
				return this._handleComfyCheckDeps(p as unknown as { baseUrl?: string } | undefined);
			case "comfy.downloadModel":
				// 模型下载：流式下载到 models/<type>/<filename>，返回 taskId 供进度轮询。
				return this._handleComfyDownloadModel(p as unknown as { url: string; filename: string; type?: string } | undefined);
			case "comfy.getDownloadProgress":
				// 查询模型下载进度（前端 1s 轮询）。
				return this._handleComfyGetDownloadProgress();
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
			case "agentSession.fork": {
				// 会话分叉：深拷贝一份独立会话（试探性会话），不影响原会话。
				// Fork 前缀缓存：抓取父级最近一次迭代计算出的冻结前缀（system+tools），
				// 持久化到子会话 meta，使子会话请求与父级前缀对齐 → 命中 provider prompt cache。
				const parentForkContext = this.agentOSService.getForkContext(p.sessionId as string);
				return (this.agentChatService as any).forkAgentSession(
					(p.agentId) as string,
					p.sessionId as string,
					p.name as string | undefined,
					parentForkContext,
				);
			}
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
					p.sessionId as string | undefined,
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

			// ─── ConfigHtml ────────────────────────────────────────
			case "confightml.getHtml": {
				const gp = p as unknown as IConfigHtmlGetHtmlPayload;
				return this._configHtmlService.getHtml(gp.agentId);
			}
			case "confightml.writeHtml": {
				const wp = p as unknown as IConfigHtmlWriteHtmlPayload;
				return this._configHtmlService.writeHtml(wp.agentId, wp.html, {
					origin: wp.origin,
					baseVersion: wp.baseVersion,
				});
			}
			case "confightml.event": {
				const ep = p as unknown as IConfigHtmlEventPayload;
				return this._configHtmlService.handleHtmlEvent(
					ep.agentId,
					ep.eventName,
					ep.payload,
					ep.agentSessionId,
				);
			}
			case "confightml.chatSend": {
				const cp = p as unknown as IConfigHtmlChatSendPayload;
				return this._configHtmlService.handleChatSend(cp.agentId, cp.message, {
					context: cp.context,
					showInChat: cp.showInChat,
					agentSessionId: cp.agentSessionId,
				});
			}
			case "confightml.notify":
				this.logService.info(
					`[ConfigHtml] Notification from ${(p.agentId)}: ${p.message} [${p.level || "info"}]`,
				);
				return undefined;
			case "confightml.previewToFile":
				return this._configHtmlService.previewToFile((p.agentId) as string);

			case "confightml.htmlGenerate": {
				const hp = p as unknown as IConfigHtmlHtmlGeneratePayload;
				return this._configHtmlService.htmlGenerate(hp.agentId, hp.message, {
					currentHtml: hp.currentHtml,
					model: hp.model,
				});
			}
			case "confightml.chatSendStream": {
				const sp = p as unknown as IConfigHtmlChatSendStreamPayload;
				// Fire-and-forget: deltas flow back via onStreamDelta/onStreamDone events
				const agentId = sp.agentId;
				this._configHtmlService.handleChatSendStream(
					sp.requestId, agentId, sp.message,
					(delta) => this._sendEvent("confightml.chatStreamDelta", { requestId: sp.requestId, agentId, delta }),
					(ok, fullText, error) => this._sendEvent("confightml.chatStreamDone", { requestId: sp.requestId, agentId, ok, fullText, error }),
					{ agentSessionId: sp.agentSessionId },
				);
				return undefined;
			}
			case "confightml.chatCancelStream": {
				const cp = p as unknown as IConfigHtmlChatCancelStreamPayload;
				this._configHtmlService.cancelStream(cp.requestId, cp.agentId);
				return undefined;
			}
			case "confightml.runTerminal": {
				const rp = p as unknown as IConfigHtmlRunTerminalPayload;
				return this._configHtmlService.handleRunTerminal(
					rp.agentId, rp.command, rp.args,
					{ cwd: rp.cwd, env: rp.env },
				);
			}
			case "confightml.kvGet": {
				const kp = p as unknown as IConfigHtmlKvGetPayload;
				return this._configHtmlService.kvGet(kp.agentId, kp.key);
			}
			case "confightml.kvSet": {
				const kp = p as unknown as IConfigHtmlKvSetPayload;
				return this._configHtmlService.kvSet(kp.agentId, kp.key, kp.value);
			}
			case "confightml.kvDelete": {
				const kp = p as unknown as IConfigHtmlKvDeletePayload;
				return this._configHtmlService.kvDelete(kp.agentId, kp.key);
			}
			case "confightml.kvList": {
				const kp = p as unknown as IConfigHtmlKvListPayload;
				return this._configHtmlService.kvList(kp.agentId, kp.prefix);
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

			// ─── Media assets (生成图片管理 P1) ───────────────────
			case "media.import":
				return this._handleMediaImport(payload as MediaImportRequest);
			case "media.list":
				return this._handleMediaList(payload as MediaListFilter);
			case "media.get":
				return this._handleMediaGet(payload as { id: string });
			case "media.getUrl":
				return this._handleMediaGetUrl(payload as { id: string });
			case "media.remove":
				await this._handleMediaRemove(payload as { id: string });
				return undefined;
			case "media.restore":
				await this._handleMediaRestore(payload as { id: string });
				return undefined;
			case "media.setFavorite":
				await this._handleMediaSetFavorite(payload as { id: string; favorite: boolean });
				return undefined;
			case "media.setBoard":
				await this._handleMediaSetBoard(payload as { id: string; board: string | null });
				return undefined;
			case "media.stats":
				return this._handleMediaStats();
			case "media.purgeDeleted":
				return this._handleMediaPurgeDeleted();
			case "media.enforceQuota":
				return this._handleMediaEnforceQuota(payload as { maxDays?: number; maxTotalBytes?: number });

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
			case "workflow.canvasOpsResult": {
				// Agent-driven canvas (P0): webview replies with the applied result.
				// Forward it to the pending requestCanvasOps promise in the tool layer.
				const cr = p as unknown as {
					requestId: string;
					result: import('./providers/tool/canvasOpsBridge.js').CanvasOpsResult;
					workflowId?: string;
					canvasContext?: import('./messageEnrichment/canvasContextStore.js').CanvasContextSnapshot;
				};
				if (cr?.requestId) {
					const resolved = resolveCanvasOps(cr.requestId, cr.result);
					if (!resolved) {
						this.logService.warn(`[AgentStudioWebviewController] workflow.canvasOpsResult: unknown requestId=${cr.requestId} (already resolved/timed out)`);
					}
				}
				// Cache the canvas state snapshot so the `<canvas_context>` tag can
				// inject it into the next user message (P0 closure).
				if (cr?.canvasContext) {
					const wfId = cr.workflowId ?? 'default';
					canvasContextStore.set(wfId, cr.canvasContext);
				}
				return { success: true };
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
					workflowTrigger: payload.workflowTrigger as { workflowId: string; input?: string } | undefined,
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
		// Phase 3: Chat is now handled natively by NativeChatEditorPane.
		// Skip chat-specific events that the webview no longer handles.
		// Non-chat panels (workflow-editor, agent-settings, taskboard) still
		// receive their events normally.
		if (type.startsWith('chat.') || type === 'agentSessions.changed') {
			return;
		}
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
			const cfg = agent.configHtml;
			let rel: string | undefined;
			switch (payload.kind || "configHtml") {
				case "configHtml":
					rel = cfg?.htmlPath || "config.html";
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
		// the Saros workspace.path, then any agent worktree path (see
		// builtinToolProvider._resolveAndCheckWorkspacePath). If we only join
		// against the Saros workspace.path here, we can produce a path the
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
	 *   2. the Saros workspace.path for the owning agent/workspace
	 *   3. the agent's worktreePath (if any)
	 *
	 * It joins the relative path onto the FIRST root for reads, but here we
	 * cannot assume which root actually contained the file (the user may be
	 * looking at a workspace whose Saros path differs from the VS Code
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

		// 2 & 3. Saros workspace.path + agent worktreePath.
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
				// workspace.path is .../project/.sarosworkspace, and the
				// file path is .sarosworkspace/workflows/...). Without the
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
	 *
	 * HTML files (.html/.htm/.xhtml) get special treatment: after writing,
	 * they are opened via `HtmlPreviewEditorInput` which routes to
	 * `HtmlFileEditorPane` — showing the 编辑/HTML/预览 toggle and
	 * rendering the preview by default.
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
		const isHtml = /\.(html?|xhtml)$/i.test(filePath);

		// Always write the content to disk first.
		const buffer = VSBuffer.fromString(content);
		await this.fileService.writeFile(resource, buffer);

		// HTML files: open via HtmlPreviewEditorInput → HtmlFileEditorPane
		// (with the 3-mode toggle: 编辑 / HTML / 预览).
		if (isHtml) {
			this.logService.info('[AgentStudioWebviewController] files.applyCode: HTML detected — opening via HtmlPreviewEditorInput');
			const fileName = filePath.split(/[\\/]/).pop() || filePath;
			// Open in the center column (main text editor), NOT in a side/split
			// group, so the HTML editor pane appears in the middle editor area.
			const groups = this.editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE);
			const targetGroup = groups[0];
			const previewInput = new HtmlPreviewEditorInput(resource, `预览：${fileName}`);
			try {
				const pane = await this.editorService.openEditor(previewInput, { pinned: true }, targetGroup);
				this.logService.info(`[AgentStudioWebviewController] files.applyCode: opened, pane.getId()=${pane?.getId() ?? 'undefined'}`);
			} catch (err) {
				this.logService.error('[AgentStudioWebviewController] files.applyCode: openEditor failed for HTML', err);
			}
			return;
		}

		// Non-HTML files: apply edit to model if already open, otherwise
		// the write above is sufficient (user sees the updated file on next open).
		const model = this.modelService.getModel(resource);
		if (model) {
			// File is already open in editor — apply edit via model so the change
			// appears immediately without needing to re-open.
			const editOperation = {
				range: model.getFullModelRange(),
				text: content,
			};
			model.applyEdits([editOperation]);
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
			const cfg = agent.configHtml;
			let rel: string | undefined;
			switch (payload.kind || "configHtml") {
				case "configHtml":
					rel = cfg?.htmlPath || "config.html";
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

		// Listen for ConfigHtml html render / command events to push to WebView
		this._register(
			this._configHtmlService.onDidRenderHtml(
				({ agentId, html, version, stylesContent }) => {
					this._sendEvent("confightml.htmlRendered", {
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
				this._sendEvent("confightml.command", { agentId, command });
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
			workflowAppliedEmitter.event(({ workflow, description }: { workflow: import('../common/workflowStorage.js').IStoredWorkflow; description?: string }) => {
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

		// Agent-driven canvas (P0): forward canvas ops requests to the webview.
		this._register(
			canvasOpsRequestEmitter.event((req: import('./providers/tool/canvasOpsBridge.js').CanvasOpsRequest) => {
				this.logService.info(
					`[AgentStudio] canvas_apply_ops: forwarding ${req.ops.length} ops (requestId=${req.requestId}) to webview`,
				);
				this._sendEvent('workflow.canvasOps', req);
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
				supportsImageGen?: boolean;
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
					supportsImageGen: m.supportsImageGen,
					supportsReasoning: m.supportsReasoning,
					onlyReasoning: m.onlyReasoning,
					reasoningType: m.capabilityConfig?.reasoningType,
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
	 * 返回指定 agent 专属的 provider/model 选择（若该 agent 曾配置过）。
	 * 未配置时回退到全局 ModelSelectorService 选择。
	 */
	private async _handleProvidersGetSelectionForAgent(
		agentId: string,
	): Promise<IProviderSelectPayload | null> {
		const sel = this.modelSelectorService.getSelectionForAgent(agentId);
		if (!sel) {
			return null;
		}
		return {
			providerId: sel.providerId,
			modelId: sel.modelId,
			agentId: sel.agentId,
		};
	}

	private _handleProvidersOpenSettings(payload: { providerId?: string }): void {
		this.modelSelectorService.openSettings(payload.providerId);
	}

	/**
	 * 文生图：webview 请求指定 provider + model 生成图片。
	 * 走该 provider 的 generateImage()（主进程 channel / renderer 直连），
	 * 返回 `{ images: [{ url? | b64? }] }`。
	 */
	private async _handleImageGenGenerate(payload: {
		providerId: string;
		modelId: string;
		prompt: string;
		negativePrompt?: string;
		width?: number;
		height?: number;
		numImages?: number;
		imageInput?: string;
	}): Promise<{ images: Array<{ url?: string; b64?: string }> }> {
		const provider = this.agentOSService.getModelProviders().find(p => p.id === payload.providerId);
		if (!provider) {
			throw new Error(`未找到 Provider：${payload.providerId}`);
		}
		if (!provider.generateImage) {
			throw new Error(`Provider ${provider.name} 不支持文生图`);
		}
		const result = await provider.generateImage(
			{
				modelId: payload.modelId,
				prompt: payload.prompt,
				negativePrompt: payload.negativePrompt,
				width: payload.width,
				height: payload.height,
				numImages: payload.numImages,
				imageInput: payload.imageInput,
			},
			{ agentId: this.modelSelectorService.getSelectedAgentId?.() ?? undefined },
		);
		return { images: result.images ?? [] };
	}

	// ─── Reverse Prompt (P2) ────────────────────────────────────────

	/**
	 * Handle `reversePrompt.generate` — describe an image via a provider's chat
	 * (reverse prompt). The image reference (data URL or http(s) URL) is resolved
	 * to base64 and sent as an image content part alongside the instruction.
	 */
	private async _handleReversePromptGenerate(payload: {
		providerId: string;
		modelId: string;
		imageRef: string;
		prompt?: string;
	}): Promise<{ text: string }> {
		const provider = this.agentOSService.getModelProviders().find(p => p.id === payload.providerId);
		if (!provider) {
			throw new Error(`未找到 Provider：${payload.providerId}`);
		}
		if (typeof provider.chat !== 'function') {
			throw new Error(`Provider ${provider.name} 不支持文本对话（反推提示词需要）`);
		}
		const { data, mimeType } = await this._resolveImageData(payload.imageRef);
		const instruction = payload.prompt
			?? 'Describe this image in rich detail for image-generation purposes: subject, style, lighting, composition, colors, mood, and any text visible. Return a single detailed English prompt.';
		const parts: import('../common/providers.js').IChatContentPart[] = [
			{ type: 'text', text: instruction },
			{ type: 'image', data, mimeType: mimeType as import('../common/providers.js').ChatImageMimeType },
		];
		let text = '';
		for await (const delta of provider.chat(
			payload.modelId,
			[{ role: 'user', content: '', contentParts: parts }],
			{ temperature: 0.4 },
			{ agentId: this.modelSelectorService.getSelectedAgentId?.() ?? undefined },
		)) {
			if (delta.type === 'text' && delta.content) { text += delta.content; }
		}
		if (!text.trim()) {
			throw new Error('模型未返回描述文本');
		}
		return { text: text.trim() };
	}

	/** Resolve an image reference (data URL / http URL) to { data(base64), mimeType }. */
	private async _resolveImageData(ref: string): Promise<{ data: string; mimeType: string }> {
		// data URL: `data:image/png;base64,AAAA...`
		const dataUrlMatch = /^data:([^;]+);base64,(.+)$/s.exec(ref);
		if (dataUrlMatch) {
			return { data: dataUrlMatch[2], mimeType: dataUrlMatch[1] };
		}
		if (/^https?:\/\//.test(ref)) {
			const resp = await fetch(ref);
			if (!resp.ok) {
				throw new Error(`无法获取图片（HTTP ${resp.status}）`);
			}
			const buf = Buffer.from(await resp.arrayBuffer());
			const mimeType = resp.headers.get('content-type')?.split(';')[0] ?? 'image/png';
			return { data: buf.toString('base64'), mimeType };
		}
		throw new Error(`不支持的图片引用：${ref.slice(0, 64)}`);
	}

	/**
	 * Proxy a ComfyUI HTTP request from the webview.
	 *
	 * ComfyUI（aiohttp）跨源保护：仅放行 `Origin: http://127.0.0.1:8188`
	 * （自身 origin），任何其他 Origin（含 webview 的 vscode-webview://）
	 * 直接 403。webview 的 fetch 必带 Origin 头且无法自定义（受限头），
	 * 所以直连必然失败。主进程用 node fetch 调用（默认不带 Origin 头）
	 * 绕开该限制。返回 `{ ok, status, json|text, error }` 给 webview runner。
	 */
	private async _handleComfyFetch(payload: {
		url: string;
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		/**
		 * 二进制模式：以 base64 回传原始字节（`{ base64, contentType }`）。
		 * ComfyUI 的 `/view?filename=…` 返回 PNG/JPEG —— 走文本路径会被
		 * UTF-8 解码破坏（非法字节 → U+FFFD），instant stage（Rotate/Mirror/
		 * Crop）拿到的就不再是可解码的图像。必须显式走本分支。
		 */
		binary?: boolean;
	}): Promise<{ ok: boolean; status: number; json?: unknown; text?: string; base64?: string; contentType?: string; error?: string }> {
		if (!payload?.url || !/^https?:\/\//.test(payload.url)) {
			return { ok: false, status: 0, error: `comfy.fetch: 无效的 URL（${payload?.url?.slice(0, 64)}）` };
		}
		// 关键：本 controller 运行在 renderer（workbench）进程。renderer 的
		// fetch() 是浏览器 fetch，自动带 `Origin: vscode-file://vscode-app`；
		// ComfyUI 跨源保护仅放行 `Origin: http://127.0.0.1:8188`（自 origin）
		// → 任何 renderer 直连必然 403。
		// 与 webTools.ts 同款方案：走主进程 IPC `vscode:webFetch`
		// （Chromium 网络栈 net.fetch，无 CORS 限制、无 Origin 头）。
		try {
			const vscodeBridge = (globalThis as any).vscode;
			if (vscodeBridge?.ipcRenderer?.invoke) {
				const result = await vscodeBridge.ipcRenderer.invoke('vscode:webFetch', {
					url: payload.url,
					method: payload.method ?? 'GET',
					headers: payload.headers ?? {},
					body: payload.body,
					binary: payload.binary === true,
				}) as { ok?: boolean; status?: number; statusText?: string; body?: string; base64?: string; contentType?: string; error?: string };
				if (result?.error) { throw new Error(result.error); }
				const status = result.status ?? 0;
				if (payload.binary) {
					return {
						ok: status >= 200 && status < 300,
						status,
						base64: result.base64 ?? '',
						contentType: result.contentType ?? 'application/octet-stream',
					};
				}
				const body = result.body ?? '';
				if (status >= 200 && status < 300 || body.startsWith('{')) {
					const json = this._tryParseJson(body);
					if (json !== undefined) { return { ok: status >= 200 && status < 300, status, json }; }
				}
				return { ok: status >= 200 && status < 300, status, text: body };
			}
		} catch (ipcErr) {
			this.logService.info?.(`[AgentStudio] comfy.fetch: vscode:webFetch 失败，回退 requestService：${ipcErr}`);
		}
		// 回退：renderer requestService（浏览器 fetch，可能受 CORS 限制，
		// 但 ComfyUI 对同源 localhost 也许放行——尽力而为）。
		try {
			const resp = await fetch(payload.url, {
				method: payload.method ?? 'GET',
				headers: payload.headers,
				body: payload.body,
			});
			const status = resp.status;
			if (payload.binary) {
				// 同上：二进制必须以字节读出再 base64，绝不能过 text()。
				const buf = new Uint8Array(await resp.arrayBuffer().catch(() => new ArrayBuffer(0)));
				let bin = '';
				for (let i = 0; i < buf.length; i++) { bin += String.fromCharCode(buf[i]); }
				return {
					ok: resp.ok,
					status,
					base64: buf.length ? btoa(bin) : '',
					contentType: resp.headers.get('content-type') ?? 'application/octet-stream',
				};
			}
			const contentType = resp.headers.get('content-type') ?? '';
			if (contentType.includes('application/json')) {
				const json = await resp.json().catch(() => undefined);
				return { ok: resp.ok, status, json };
			}
			const text = await resp.text().catch(() => '');
			return { ok: resp.ok, status, text };
		} catch (err) {
			return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * ComfyUI 一键启动（--enable-cors-header）。走主进程 `comfy:launch` IPC
	 * （主进程有 child_process spawn + net.fetch 探活能力）。失败回退返回错误结果。
	 */
	private async _handleComfyLaunch(payload?: { baseUrl?: string; port?: number }): Promise<{
		ok: boolean;
		alreadyRunning?: boolean;
		starting?: boolean;
		pid?: number;
		version?: string;
		error?: string;
		pythonPath?: string;
		mainPyPath?: string;
		baseUrl?: string;
	}> {
		try {
			const vscodeBridge = (globalThis as any).vscode;
			if (vscodeBridge?.ipcRenderer?.invoke) {
				return await vscodeBridge.ipcRenderer.invoke('vscode:comfyLaunch', payload ?? {}) as {
					ok: boolean;
					alreadyRunning?: boolean;
					starting?: boolean;
					pid?: number;
					version?: string;
					error?: string;
					pythonPath?: string;
					mainPyPath?: string;
					baseUrl?: string;
				};
			}
			return { ok: false, error: 'comfy:launch: 主进程 IPC 不可用' };
		} catch (err) {
			return { ok: false, error: `comfy:launch 失败：${err instanceof Error ? err.message : String(err)}` };
		}
	}

	/** 透传到主进程 vscode:comfyGetLaunchPaths。 */
	private async _handleComfyGetLaunchPaths(): Promise<{ ok: boolean; pythonPath?: string; mainPyPath?: string; source?: string; overrides?: { pythonPath: string; mainPyPath: string }; error?: string }> {
		try {
			const vscodeBridge = (globalThis as any).vscode;
			if (vscodeBridge?.ipcRenderer?.invoke) {
				return await vscodeBridge.ipcRenderer.invoke('vscode:comfyGetLaunchPaths') as { ok: boolean; pythonPath?: string; mainPyPath?: string; source?: string; overrides?: { pythonPath: string; mainPyPath: string } };
			}
			return { ok: false, error: 'comfy:getLaunchPaths: 主进程 IPC 不可用' };
		} catch (err) {
			return { ok: false, error: `comfy:getLaunchPaths 失败：${err instanceof Error ? err.message : String(err)}` };
		}
	}

	/** 透传到主进程 vscode:comfySetLaunchPaths（写配置）。 */
	private async _handleComfySetLaunchPaths(payload?: { pythonPath?: string; mainPyPath?: string }): Promise<{ ok: boolean; error?: string }> {
		try {
			const vscodeBridge = (globalThis as any).vscode;
			if (vscodeBridge?.ipcRenderer?.invoke) {
				return await vscodeBridge.ipcRenderer.invoke('vscode:comfySetLaunchPaths', payload ?? {}) as { ok: boolean };
			}
			return { ok: false, error: 'comfy:setLaunchPaths: 主进程 IPC 不可用' };
		} catch (err) {
			return { ok: false, error: `comfy:setLaunchPaths 失败：${err instanceof Error ? err.message : String(err)}` };
		}
	}

	/** 透传到主进程 vscode:comfyCheckDeps（依赖检测）。 */
	private async _handleComfyCheckDeps(payload?: { baseUrl?: string }): Promise<unknown> {
		try {
			const vscodeBridge = (globalThis as any).vscode;
			if (vscodeBridge?.ipcRenderer?.invoke) {
				return await vscodeBridge.ipcRenderer.invoke('vscode:comfyCheckDeps', payload ?? {});
			}
			return { ok: false, error: 'comfy:checkDeps: 主进程 IPC 不可用' };
		} catch (err) {
			return { ok: false, error: `comfy:checkDeps 失败：${err instanceof Error ? err.message : String(err)}` };
		}
	}

	/** 透传到主进程 vscode:comfyDownloadModel（模型下载）。 */
	private async _handleComfyDownloadModel(payload?: { url: string; filename: string; type?: string }): Promise<unknown> {
		try {
			const vscodeBridge = (globalThis as any).vscode;
			if (vscodeBridge?.ipcRenderer?.invoke) {
				return await vscodeBridge.ipcRenderer.invoke('vscode:comfyDownloadModel', payload ?? {});
			}
			return { ok: false, error: 'comfy:downloadModel: 主进程 IPC 不可用' };
		} catch (err) {
			return { ok: false, error: `comfy:downloadModel 失败：${err instanceof Error ? err.message : String(err)}` };
		}
	}

	/** 透传到主进程 vscode:comfyGetDownloadProgress（下载进度查询）。 */
	private async _handleComfyGetDownloadProgress(): Promise<unknown> {
		try {
			const vscodeBridge = (globalThis as any).vscode;
			if (vscodeBridge?.ipcRenderer?.invoke) {
				return await vscodeBridge.ipcRenderer.invoke('vscode:comfyGetDownloadProgress');
			}
			return { ok: false, error: 'comfy:getDownloadProgress: 主进程 IPC 不可用' };
		} catch (err) {
			return { ok: false, error: `comfy:getDownloadProgress 失败：${err instanceof Error ? err.message : String(err)}` };
		}
	}

	/** 尝试 JSON 解析；失败返回 undefined（保持文本返回）。 */
	private _tryParseJson(body: string): unknown {
		if (!body) { return undefined; }
		try { return JSON.parse(body); } catch { return undefined; }
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

	// ─── Media assets (生成图片管理 P1) ─────────────────────────────────

	private async _handleMediaImport(req: MediaImportRequest) {
		const backend = this._getMediaBackend();
		if (!backend) { throw new Error('media store unavailable'); }
		return backend.importAsset(req);
	}

	private async _handleMediaList(filter: MediaListFilter) {
		const backend = this._getMediaBackend();
		if (!backend) { return { total: 0, items: [] }; }
		return backend.list(filter);
	}

	private async _handleMediaGet(payload: { id: string }) {
		const backend = this._getMediaBackend();
		if (!backend) { return null; }
		return backend.get(payload.id);
	}

	/** 返回 webview 可加载的资产 URL。
	 *
	 * 本地文件 → 读取为 base64 data URI（绕过 webview 资源协议：
	 * asWebviewUri 生成的 https://file+*.vscode-cdn.net 域名在 pooled
	 * webview 中无法被 DNS 解析 → ERR_NAME_NOT_RESOLVED）。
	 * http/data URL 引用 → 原样透传。 */
	private async _handleMediaGetUrl(payload: { id: string }) {
		const backend = this._getMediaBackend();
		if (!backend) { return null; }
		const asset = await backend.get(payload.id);
		if (!asset) { return null; }
		if (asset.ref && /^(https?|data):/i.test(asset.ref)) {
			return asset.ref;
		}
		if (asset.filePath) {
			try {
				const content = await this.fileService.readFile(URI.file(asset.filePath));
				// content.value 是 string | VSBuffer（VSBuffer 非 Uint8Array 子类，只有
				// buffer/byteLength）。用官方 encodeBase64 转 base64，它会按 buffer.byteLength
				// 精确遍历，避免 Buffer.from(value.buffer) 因底层 ArrayBuffer 多余字节
				// （Buffer 池复用）导致图片损坏无法显示。
				const value = content.value;
				const vsbuf = typeof value === 'string' ? VSBuffer.fromString(value) : value;
				const b64 = encodeBase64(vsbuf);
				const ext = asset.filePath.match(/\.(\w+)$/)?.[1] ?? 'png';
				const mime = ext === 'svg' ? 'image/svg+xml'
					: ext === 'webp' ? 'image/webp'
					: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
					: 'image/png';
				return `data:${mime};base64,${b64}`;
			} catch (err) {
				this.logService.error(`[MediaGetUrl] readFile failed for ${asset.filePath}: ${err}`);
				return null;
			}
		}
		return asset.ref || null;
	}

	private async _handleMediaRemove(payload: { id: string }) {
		const backend = this._getMediaBackend();
		if (!backend) { return; }
		await backend.remove(payload.id);
	}

	private async _handleMediaRestore(payload: { id: string }) {
		const backend = this._getMediaBackend();
		if (!backend) { return; }
		await backend.restore(payload.id);
	}

	private async _handleMediaSetFavorite(payload: { id: string; favorite: boolean }) {
		const backend = this._getMediaBackend();
		if (!backend) { return; }
		await backend.setFavorite(payload.id, !!payload.favorite);
	}

	private async _handleMediaSetBoard(payload: { id: string; board: string | null }) {
		const backend = this._getMediaBackend();
		if (!backend) { return; }
		await backend.setBoard(payload.id, payload.board ?? null);
	}

	private async _handleMediaStats() {
		const backend = this._getMediaBackend();
		if (!backend) { return null; }
		return backend.stats();
	}

	private async _handleMediaPurgeDeleted() {
		const backend = this._getMediaBackend();
		if (!backend) { return { count: 0, freedBytes: 0 }; }
		return backend.purgeDeleted();
	}

	private async _handleMediaEnforceQuota(opts: { maxDays?: number; maxTotalBytes?: number }) {
		const backend = this._getMediaBackend();
		if (!backend) { return { removed: 0, freedBytes: 0 }; }
		return backend.enforceQuota(opts);
	}

	// ─── Memory inspection helpers (AgentMemoryProvider) ──────────────────────
	//
	// Refactored from TDB-AM HTTP gateway proxy to in-process IMemoryProvider.
	// Uses agentOSService.getActiveMemoryProvider() for data access.

	private async _handleMemoryListL0(payload: IMemoryListPayload): Promise<IMemoryListL0Response> {
		try {
			const provider = this.agentOSService.getActiveMemoryProvider();
			if (!provider) { return { items: [], total: 0 }; }
			const results = await provider.searchMemory(payload.agentId || 'default', '');
			const items: IMemoryL0Item[] = (results || [])
				.filter(e => e.type === 'working')
				.slice(0, payload.limit ?? 200)
				.map(e => ({
					recordId: e.id,
					sessionKey: `agent:${payload.agentId ?? 'default'}`,
					sessionId: (e.metadata?.['sessionId'] as string) ?? '',
					role: (e.metadata?.['role'] as string) ?? '',
					messageText: e.content,
					recordedAt: e.timestamp ? new Date(e.timestamp).toISOString() : '',
					timestamp: e.timestamp ?? 0,
				}));
			return { items, total: items.length };
		} catch { return { items: [], total: 0 }; }
	}

	private async _handleMemoryListL1(payload: IMemoryListPayload): Promise<IMemoryListL1Response> {
		try {
			const provider = this.agentOSService.getActiveMemoryProvider();
			if (!provider) { return { items: [], total: 0 }; }
			const results = await provider.searchMemory(payload.agentId || 'default', '');
			// L1 = 长时 Episodic 层（KV.memories，原生类型 pattern/.../fact）；working/semantic/procedural 为独立层，排除
			const items: IMemoryL1Item[] = (results || [])
				.filter(e => e.type !== 'working' && e.type !== 'semantic' && e.type !== 'procedural')
				.slice(0, payload.limit ?? 200)
				.map(e => ({
					recordId: e.id,
					content: e.content,
					updatedTime: e.timestamp ? new Date(e.timestamp).toISOString() : '',
				}));
			return { items, total: items.length };
		} catch { return { items: [], total: 0 }; }
	}

	private async _handleMemoryDelete(
		payload: IMemoryDeletePayload,
		layer: "conversation" | "memory",
	): Promise<IMemoryDeleteResponse> {
		// IMemoryProvider doesn't expose deleteMemory — graceful degradation.
		this.logService.info(`[AgentStudioWebviewController] memory.delete (${layer}) not supported by in-process provider, skipping ${payload.recordIds?.length ?? 0} items`);
		return { deleted: 0, failed: [...(payload.recordIds ?? [])] };
	}

	/**
	 * 删除指定 Agent 关联的所有记忆（级联清理）。
	 * IMemoryProvider 不支持批量删除，此处为 no-op（优雅降级）。
	 */
	private async _cleanupAgentMemory(agentId: string): Promise<void> {
		if (!agentId) { return; }
		this.logService.info(`[AgentStudioWebviewController] cleanupAgentMemory(${agentId}): skipped (in-process provider doesn't support bulk delete)`);
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
			const snapshotUri = URI.joinPath(baseDirUri, '.sarosworkspace', 'checkpoint-diffs', checkpointId, fileName);
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
					baseDirUri, '.sarosworkspace', 'checkpoint-diffs', '__all__', snap.id, fileName,
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

			// v34: 不再为工作流创建/同步专用 agent——工作流与 agent 解耦。
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

			// v34: 画布 Run 默认在 saros-claw（内置主助理）中执行——不再创建/绑定专用 agent。
			// 若 webview 显式传了 agentId（用户指定）则优先使用。
			const agentId = payload.agentId || SAROS_CLAW_AGENT_ID;

			const executionId = await this.workflowExecutionService.executeWorkflow(payload.workflowId, {
				agentId,
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
		// If the pool hot path was used, re-sync the pool iframe position.
		// After a tab switch the panel container's bounding rect may return
		// 0,0,0,0 while hidden, and the ResizeObserver won't fire when the
		// pane becomes visible again with the same CSS dimensions — leaving
		// the iframe positioned at 0,0 and rendering blank/black.
		this._poolSyncLayout?.();
	}
}
