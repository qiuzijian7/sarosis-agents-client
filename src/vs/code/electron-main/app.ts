/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, Details, GPUFeatureStatus, net, powerMonitor, protocol, session, Session, systemPreferences, WebFrameMain } from 'electron';
import { addUNCHostToAllowlist, disableUNCAccessRestrictions } from '../../base/node/unc.js';
import { validatedIpcMain } from '../../base/parts/ipc/electron-main/ipcMain.js';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { resolveTerminalEncoding } from '../../base/node/terminalEncoding.js';
import { ProcessOutputCollector } from '../../sessions/contrib/agentStudio/common/processOutputDecoder.js';
import { hostname, release } from 'os';
import { existsSync } from 'fs';
import { dispatchWorktreeDebug, resolveWorktreeDebugPlan } from './worktreeDebugStrategies.js';
import { initWindowsVersionInfo } from '../../base/node/windowsVersion.js';
import { VSBuffer } from '../../base/common/buffer.js';
import { toErrorMessage } from '../../base/common/errorMessage.js';
import { Event } from '../../base/common/event.js';
import { parse } from '../../base/common/jsonc.js';
import { getPathLabel } from '../../base/common/labels.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../base/common/lifecycle.js';
import { Schemas, VSCODE_AUTHORITY } from '../../base/common/network.js';
import { join, posix } from '../../base/common/path.js';
import { INodeProcess, IProcessEnvironment, isLinux, isLinuxSnap, isMacintosh, isWindows, OS } from '../../base/common/platform.js';
import { assertType } from '../../base/common/types.js';
import { URI } from '../../base/common/uri.js';
import { generateUuid } from '../../base/common/uuid.js';

// 后台 execute_code 任务注册表（P0-2）：spawn 后常驻，供 poll/kill 控制面访问。
// 模块级单例：app 主进程全程唯一，足以在多次 IPC 调用间持有子进程句柄。
interface IBgExecHandle {
	child: ChildProcess;
	stdoutCollector: ProcessOutputCollector;
	stderrCollector: ProcessOutputCollector;
	localEncoding: string;
	settled: boolean;
	exitCode: number;
	timeoutHandle?: ReturnType<typeof setTimeout>;
}
const _bgExecs = new Map<string, IBgExecHandle>();
import { registerContextMenuListener } from '../../base/parts/contextmenu/electron-main/contextmenu.js';
import { getDelayedChannel, ProxyChannel, StaticRouter } from '../../base/parts/ipc/common/ipc.js';
import { Server as ElectronIPCServer } from '../../base/parts/ipc/electron-main/ipc.electron.js';
import { Client as MessagePortClient } from '../../base/parts/ipc/electron-main/ipc.mp.js';
import { Server as NodeIPCServer } from '../../base/parts/ipc/node/ipc.net.js';
import { IProxyAuthService, ProxyAuthService } from '../../platform/native/electron-main/auth.js';
import { localize } from '../../nls.js';
import { IBackupMainService } from '../../platform/backup/electron-main/backup.js';
import { BackupMainService } from '../../platform/backup/electron-main/backupMainService.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ElectronExtensionHostDebugBroadcastChannel } from '../../platform/debug/electron-main/extensionHostDebugIpc.js';
import { IDiagnosticsService, IGPULogMessage } from '../../platform/diagnostics/common/diagnostics.js';
import { DiagnosticsMainService, IDiagnosticsMainService } from '../../platform/diagnostics/electron-main/diagnosticsMainService.js';
import { DialogMainService, IDialogMainService } from '../../platform/dialogs/electron-main/dialogMainService.js';
import { IEncryptionMainService } from '../../platform/encryption/common/encryptionService.js';
import { EncryptionMainService } from '../../platform/encryption/electron-main/encryptionMainService.js';
import { ipcBrowserViewChannelName } from '../../platform/browserView/common/browserView.js';
import { ipcBrowserViewGroupChannelName } from '../../platform/browserView/common/browserViewGroup.js';
import { BrowserViewMainService, IBrowserViewMainService } from '../../platform/browserView/electron-main/browserViewMainService.js';
import { BrowserViewGroupMainService, IBrowserViewGroupMainService } from '../../platform/browserView/electron-main/browserViewGroupMainService.js';
import { NativeParsedArgs } from '../../platform/environment/common/argv.js';
import { IEnvironmentMainService } from '../../platform/environment/electron-main/environmentMainService.js';
import { isLaunchedFromCli } from '../../platform/environment/node/argvHelper.js';
import { getResolvedShellEnv } from '../../platform/shell/node/shellEnv.js';
import { IExtensionHostStarter, ipcExtensionHostStarterChannelName } from '../../platform/extensions/common/extensionHostStarter.js';
import { ExtensionHostStarter } from '../../platform/extensions/electron-main/extensionHostStarter.js';
import { IExternalTerminalMainService } from '../../platform/externalTerminal/electron-main/externalTerminal.js';
import { LinuxExternalTerminalService, MacExternalTerminalService, WindowsExternalTerminalService } from '../../platform/externalTerminal/node/externalTerminalService.js';
import { ISandboxHelperMainService } from '../../platform/sandbox/electron-main/sandboxHelperService.js';
import { SandboxHelperService } from '../../platform/sandbox/node/sandboxHelper.js';
import { LOCAL_FILE_SYSTEM_CHANNEL_NAME } from '../../platform/files/common/diskFileSystemProviderClient.js';
import { IFileService } from '../../platform/files/common/files.js';
import { DiskFileSystemProviderChannel } from '../../platform/files/electron-main/diskFileSystemProviderServer.js';
import { DiskFileSystemProvider } from '../../platform/files/node/diskFileSystemProvider.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { ProcessMainService } from '../../platform/process/electron-main/processMainService.js';
import { IKeyboardLayoutMainService, KeyboardLayoutMainService } from '../../platform/keyboardLayout/electron-main/keyboardLayoutMainService.js';
import { ILaunchMainService, LaunchMainService } from '../../platform/launch/electron-main/launchMainService.js';
import { ILifecycleMainService, LifecycleMainPhase, ShutdownReason } from '../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILoggerService, ILogService } from '../../platform/log/common/log.js';
import { IMenubarMainService, MenubarMainService } from '../../platform/menubar/electron-main/menubarMainService.js';
import { INativeHostMainService, NativeHostMainService } from '../../platform/native/electron-main/nativeHostMainService.js';
import { IMeteredConnectionService } from '../../platform/meteredConnection/common/meteredConnection.js';
import { METERED_CONNECTION_CHANNEL } from '../../platform/meteredConnection/common/meteredConnectionIpc.js';
import { MeteredConnectionChannel } from '../../platform/meteredConnection/electron-main/meteredConnectionChannel.js';
import { MeteredConnectionMainService } from '../../platform/meteredConnection/electron-main/meteredConnectionMainService.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { getRemoteAuthority } from '../../platform/remote/common/remoteHosts.js';
import { SharedProcess } from '../../platform/sharedProcess/electron-main/sharedProcess.js';
import { ISignService } from '../../platform/sign/common/sign.js';
import { IStateService } from '../../platform/state/node/state.js';
import { StorageDatabaseChannel } from '../../platform/storage/electron-main/storageIpc.js';
import { ApplicationStorageMainService, IApplicationStorageMainService, IStorageMainService, StorageMainService } from '../../platform/storage/electron-main/storageMainService.js';
import { resolveCommonProperties } from '../../platform/telemetry/common/commonProperties.js';
import { ITelemetryService, TelemetryLevel } from '../../platform/telemetry/common/telemetry.js';
import { TelemetryAppenderClient } from '../../platform/telemetry/common/telemetryIpc.js';
import { ITelemetryServiceConfig, TelemetryService } from '../../platform/telemetry/common/telemetryService.js';
import { getPiiPathsFromEnvironment, getTelemetryLevel, isInternalTelemetry, NullTelemetryService, supportsTelemetry } from '../../platform/telemetry/common/telemetryUtils.js';
import { IUpdateService } from '../../platform/update/common/update.js';
import { UpdateChannel } from '../../platform/update/common/updateIpc.js';
import { AbstractUpdateService } from '../../platform/update/electron-main/abstractUpdateService.js';
import { CrossAppUpdateCoordinator } from '../../platform/update/electron-main/crossAppUpdateIpc.js';
import { NotAvailableUpdateDialog } from '../../platform/update/electron-main/notAvailableUpdateDialog.js';
import { MacOSCrossAppSecretSharing } from '../../platform/secrets/electron-main/macOSCrossAppSecretSharing.js';
import { DarwinUpdateService } from '../../platform/update/electron-main/updateService.darwin.js';
import { LinuxUpdateService } from '../../platform/update/electron-main/updateService.linux.js';
import { SnapUpdateService } from '../../platform/update/electron-main/updateService.snap.js';
import { Win32UpdateService } from '../../platform/update/electron-main/updateService.win32.js';
import { IOpenURLOptions, IURLService } from '../../platform/url/common/url.js';
import { URLHandlerChannelClient, URLHandlerRouter } from '../../platform/url/common/urlIpc.js';
import { NativeURLService } from '../../platform/url/common/urlService.js';
import { ElectronURLListener } from '../../platform/url/electron-main/electronUrlListener.js';
import { IWebviewManagerService } from '../../platform/webview/common/webviewManagerService.js';
import { WebviewMainService } from '../../platform/webview/electron-main/webviewMainService.js';
import { isFolderToOpen, isWorkspaceToOpen, IWindowOpenable } from '../../platform/window/common/window.js';
import { getAllWindowsExcludingOffscreen, IWindowsMainService, OpenContext } from '../../platform/windows/electron-main/windows.js';
import { ICodeWindow } from '../../platform/window/electron-main/window.js';
import { WindowsMainService } from '../../platform/windows/electron-main/windowsMainService.js';
import { ActiveWindowManager } from '../../platform/windows/node/windowTracker.js';
import { hasWorkspaceFileExtension } from '../../platform/workspace/common/workspace.js';
import { IWorkspacesService } from '../../platform/workspaces/common/workspaces.js';
import { IWorkspacesHistoryMainService, WorkspacesHistoryMainService } from '../../platform/workspaces/electron-main/workspacesHistoryMainService.js';
import { WorkspacesMainService } from '../../platform/workspaces/electron-main/workspacesMainService.js';
import { IWorkspacesManagementMainService, WorkspacesManagementMainService } from '../../platform/workspaces/electron-main/workspacesManagementMainService.js';
import { IPolicyService } from '../../platform/policy/common/policy.js';
import { PolicyChannel } from '../../platform/policy/common/policyIpc.js';
import { IUserDataProfilesMainService } from '../../platform/userDataProfile/electron-main/userDataProfile.js';
import { IExtensionsProfileScannerService } from '../../platform/extensionManagement/common/extensionsProfileScannerService.js';
import { IExtensionsScannerService } from '../../platform/extensionManagement/common/extensionsScannerService.js';
import { ExtensionsScannerService } from '../../platform/extensionManagement/node/extensionsScannerService.js';
import { UserDataProfilesHandler } from '../../platform/userDataProfile/electron-main/userDataProfilesHandler.js';
import { ProfileStorageChangesListenerChannel } from '../../platform/userDataProfile/electron-main/userDataProfileStorageIpc.js';
import { Promises, RunOnceScheduler, runWhenGlobalIdle } from '../../base/common/async.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { resolveMachineId, resolveSqmId, resolveDevDeviceId, validateDevDeviceId } from '../../platform/telemetry/electron-main/telemetryUtils.js';
import { ExtensionsProfileScannerService } from '../../platform/extensionManagement/node/extensionsProfileScannerService.js';
import { LoggerChannel } from '../../platform/log/electron-main/logIpc.js';
import { ILoggerMainService } from '../../platform/log/electron-main/loggerService.js';
import { IInitialProtocolUrls, IProtocolUrl } from '../../platform/url/electron-main/url.js';
import { IUtilityProcessWorkerMainService, UtilityProcessWorkerMainService } from '../../platform/utilityProcess/electron-main/utilityProcessWorkerMainService.js';
import { ipcUtilityProcessWorkerChannelName } from '../../platform/utilityProcess/common/utilityProcessWorkerService.js';
import { ILocalPtyService, LocalReconnectConstants, TerminalIpcChannels, TerminalSettingId } from '../../platform/terminal/common/terminal.js';
import { ElectronPtyHostStarter } from '../../platform/terminal/electron-main/electronPtyHostStarter.js';
import { PtyHostService } from '../../platform/terminal/node/ptyHostService.js';
import { ElectronAgentHostStarter } from '../../platform/agentHost/electron-main/electronAgentHostStarter.js';
import { AgentHostProcessManager } from '../../platform/agentHost/node/agentHostService.js';
import { AgentHostEnabledSettingId } from '../../platform/agentHost/common/agentService.js';
import { NODE_REMOTE_RESOURCE_CHANNEL_NAME, NODE_REMOTE_RESOURCE_IPC_METHOD_NAME, NodeRemoteResourceResponse, NodeRemoteResourceRouter } from '../../platform/remote/common/electronRemoteResources.js';
import { Lazy } from '../../base/common/lazy.js';
import { IAuxiliaryWindowsMainService } from '../../platform/auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { AuxiliaryWindowsMainService } from '../../platform/auxiliaryWindow/electron-main/auxiliaryWindowsMainService.js';
import { normalizeNFC } from '../../base/common/normalization.js';
import { ICSSDevelopmentService, CSSDevelopmentService } from '../../platform/cssDev/node/cssDevService.js';
import { INativeMcpDiscoveryHelperService, NativeMcpDiscoveryHelperChannelName } from '../../platform/mcp/common/nativeMcpDiscoveryHelper.js';
import { NativeMcpDiscoveryHelperService } from '../../platform/mcp/node/nativeMcpDiscoveryHelperService.js';
import { IMcpGatewayService, McpGatewayChannelName } from '../../platform/mcp/common/mcpGateway.js';
import { McpGatewayService } from '../../platform/mcp/node/mcpGatewayService.js';
import { McpGatewayChannel } from '../../platform/mcp/node/mcpGatewayChannel.js';
import { LlmMainChannel } from '../../sessions/contrib/agentStudio/electron-main/llmMainChannel.js';
import { CodebaseGraphStoreChannel } from '../../sessions/contrib/agentStudio/electron-main/codebaseGraphStoreChannel.js';
import { CODEBASE_GRAPH_STORE_CHANNEL } from '../../sessions/contrib/agentStudio/common/codebaseGraphStoreChannel.js';
import { KbSqliteStoreChannel } from '../../sessions/contrib/agentStudio/electron-main/kbSqliteStoreChannel.js';
import { KB_SQLITE_STORE_CHANNEL } from '../../sessions/contrib/agentStudio/common/kbSqliteStoreChannel.js';
import { GitVersionChannel } from '../../sessions/contrib/agentStudio/electron-main/gitVersionChannel.js';
import { ComfyLaunchChannel } from '../../sessions/contrib/agentStudio/electron-main/comfyLaunchChannel.js';
import { ConfigHtmlServerChannel } from '../../sessions/contrib/agentStudio/electron-main/configHtmlServerChannel.js';
import { VoxLaunchChannel } from '../../sessions/contrib/agentStudio/electron-main/voxLaunchChannel.js';
import { LarkCliChannel } from '../../sessions/contrib/agentStudio/electron-main/larkCliChannel.js';
import { BridgeStoreChannel } from '../../sessions/contrib/agentStudio/electron-main/bridgeStoreChannel.js';
import { RemoteControlChannel } from '../../sessions/contrib/agentStudio/electron-main/remoteControlChannel.js';
import { GIT_VERSION_CHANNEL } from '../../sessions/contrib/agentStudio/common/gitVersionBackend.js';
import { MediaStoreChannel } from '../../sessions/contrib/agentStudio/electron-main/mediaStoreChannel.js';
import { MEDIA_STORE_CHANNEL } from '../../sessions/contrib/agentStudio/common/mediaStoreChannel.js';
import { SubAgentKernelProcChannel } from '../../sessions/contrib/agentStudio/electron-main/subAgentKernelProcChannel.js';
import { SUBAGENT_KERNEL_PROC_CHANNEL } from '../../sessions/contrib/agentStudio/common/subAgentKernelProcChannel.js';
import { KbDocConvertChannel } from '../../sessions/contrib/agentStudio/electron-main/kbDocConvertChannel.js';
import { VSSAROS_LLM_CHANNEL } from '../../sessions/contrib/agentStudio/common/llmBridge.js';
import { IWebContentExtractorService } from '../../platform/webContentExtractor/common/webContentExtractor.js';
import { NativeWebContentExtractorService } from '../../platform/webContentExtractor/electron-main/webContentExtractorService.js';
import { AgentNetworkFilterService, IAgentNetworkFilterService } from '../../platform/networkFilter/common/networkFilterService.js';
import { ITerminalSandboxService, NullTerminalSandboxService } from '../../platform/sandbox/common/terminalSandboxService.js';
import { CrossAppIPCService, ICrossAppIPCService } from '../../platform/crossAppIpc/electron-main/crossAppIpcService.js';
import { AgentsLastRunningTracker } from './agentsLastRunningTracker.js';
import ErrorTelemetry from '../../platform/telemetry/electron-main/errorTelemetry.js';

/**
 * The main VS Code application. There will only ever be one instance,
 * even if the user starts many instances (e.g. from the command line).
 */
export class CodeApplication extends Disposable {

	private static readonly SECURITY_PROTOCOL_HANDLING_CONFIRMATION_SETTING_KEY = {
		[Schemas.file]: 'security.promptForLocalFileProtocolHandling' as const,
		[Schemas.vscodeRemote]: 'security.promptForRemoteFileProtocolHandling' as const
	};

	private windowsMainService: IWindowsMainService | undefined;
	private auxiliaryWindowsMainService: IAuxiliaryWindowsMainService | undefined;
	private nativeHostMainService: INativeHostMainService | undefined;

	constructor(
		private readonly mainProcessNodeIpcServer: NodeIPCServer,
		private readonly userEnv: IProcessEnvironment,
		@IInstantiationService private readonly mainInstantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@ILoggerService private readonly loggerService: ILoggerService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStateService private readonly stateService: IStateService,
		@IFileService private readonly fileService: IFileService,
		@IProductService private readonly productService: IProductService,
		@IUserDataProfilesMainService private readonly userDataProfilesMainService: IUserDataProfilesMainService
	) {
		super();

		this.configureSession();
		this.registerListeners();
	}

	private configureSession(): void {

		//#region Security related measures (https://electronjs.org/docs/tutorial/security)
		//
		// !!! DO NOT CHANGE without consulting the documentation !!!
		//

		const isUrlFromWindow = (requestingUrl?: string | undefined) => requestingUrl?.startsWith(`${Schemas.vscodeFileResource}://${VSCODE_AUTHORITY}`);
		const isUrlFromWebview = (requestingUrl: string | undefined) => requestingUrl?.startsWith(`${Schemas.vscodeWebview}://`);

		const alwaysAllowedPermissions = new Set(['pointerLock', 'notifications']);

		const allowedPermissionsInWebview = new Set([
			...alwaysAllowedPermissions,
			'clipboard-read',
			'clipboard-sanitized-write',
			// TODO(deepak1556): Should be removed once migration is complete
			// https://github.com/microsoft/vscode/issues/239228
			'deprecated-sync-clipboard-read',
		]);

		const allowedPermissionsInCore = new Set([
			...alwaysAllowedPermissions,
			'media',
			'local-fonts',
			// TODO(deepak1556): Should be removed once migration is complete
			// https://github.com/microsoft/vscode/issues/239228
			'deprecated-sync-clipboard-read',
		]);

		session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
			if (isUrlFromWebview(details.requestingUrl)) {
				return callback(allowedPermissionsInWebview.has(permission));
			}
			if (isUrlFromWindow(details.requestingUrl)) {
				return callback(allowedPermissionsInCore.has(permission));
			}
			return callback(false);
		});

		session.defaultSession.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
			if (isUrlFromWebview(details.requestingUrl)) {
				return allowedPermissionsInWebview.has(permission);
			}
			if (isUrlFromWindow(details.requestingUrl)) {
				return allowedPermissionsInCore.has(permission);
			}
			return false;
		});

		//#endregion

		//#region Request filtering

		// Block all SVG requests from unsupported origins
		const supportedSvgSchemes = new Set([Schemas.file, Schemas.vscodeFileResource, Schemas.vscodeRemoteResource, Schemas.vscodeManagedRemoteResource, 'devtools']);

		// But allow them if they are made from inside an webview
		const isSafeFrame = (requestFrame: WebFrameMain | null | undefined): boolean => {
			for (let frame: WebFrameMain | null | undefined = requestFrame; frame; frame = frame.parent) {
				if (frame.url.startsWith(`${Schemas.vscodeWebview}://`)) {
					return true;
				}
			}
			return false;
		};

		const isSvgRequestFromSafeContext = (details: Electron.OnBeforeRequestListenerDetails | Electron.OnHeadersReceivedListenerDetails): boolean => {
			return details.resourceType === 'xhr' || isSafeFrame(details.frame);
		};

		const isAllowedVsCodeFileRequest = (details: Electron.OnBeforeRequestListenerDetails) => {
			const frame = details.frame;
			if (!frame || !this.windowsMainService) {
				return false;
			}

			// Check to see if the request comes from one of the main windows (or shared process) and not from embedded content
			const windows = getAllWindowsExcludingOffscreen();
			for (const window of windows) {
				if (frame.processId === window.webContents.mainFrame.processId) {
					return true;
				}
			}

			return false;
		};

		const isAllowedWebviewRequest = (uri: URI, details: Electron.OnBeforeRequestListenerDetails): boolean => {
			if (uri.path !== '/index.html') {
				return true; // Only restrict top level page of webviews: index.html
			}

			const frame = details.frame;
			if (!frame || !this.windowsMainService) {
				return false;
			}

			// Check to see if the request comes from one of the main editor windows.
			for (const window of this.windowsMainService.getWindows()) {
				if (window.win) {
					if (frame.processId === window.win.webContents.mainFrame.processId) {
						return true;
					}
				}
			}

			return false;
		};

		session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
			const uri = URI.parse(details.url);
			if (uri.scheme === Schemas.vscodeWebview) {
				if (!isAllowedWebviewRequest(uri, details)) {
					this.logService.error('Blocked vscode-webview request', details.url);
					return callback({ cancel: true });
				}
			}

			if (uri.scheme === Schemas.vscodeFileResource) {
				if (!isAllowedVsCodeFileRequest(details)) {
					this.logService.error('Blocked vscode-file request', details.url);
					return callback({ cancel: true });
				}
			}

			// Block most svgs
			if (uri.path.endsWith('.svg')) {
				const isSafeResourceUrl = supportedSvgSchemes.has(uri.scheme);
				if (!isSafeResourceUrl) {
					return callback({ cancel: !isSvgRequestFromSafeContext(details) });
				}
			}

			return callback({ cancel: false });
		});

		// Configure SVG header content type properly
		// https://github.com/microsoft/vscode/issues/97564
		session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
			const responseHeaders = details.responseHeaders as Record<string, (string) | (string[])>;
			const contentTypes = (responseHeaders['content-type'] || responseHeaders['Content-Type']);

			if (contentTypes && Array.isArray(contentTypes)) {
				const uri = URI.parse(details.url);
				if (uri.path.endsWith('.svg')) {
					if (supportedSvgSchemes.has(uri.scheme)) {
						responseHeaders['Content-Type'] = ['image/svg+xml'];

						return callback({ cancel: false, responseHeaders });
					}
				}

				// remote extension schemes have the following format
				// http://127.0.0.1:<port>/vscode-remote-resource?path=
				if (!uri.path.endsWith(Schemas.vscodeRemoteResource) && contentTypes.some(contentType => contentType.toLowerCase().includes('image/svg'))) {
					return callback({ cancel: !isSvgRequestFromSafeContext(details) });
				}
			}

			return callback({ cancel: false });
		});

		//#endregion

		//#region Allow CORS for the PRSS CDN

		// https://github.com/microsoft/vscode-remote-release/issues/9246
		session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
			if (details.url.startsWith('https://vscode.download.prss.microsoft.com/')) {
				const responseHeaders = details.responseHeaders ?? Object.create(null);

				if (responseHeaders['Access-Control-Allow-Origin'] === undefined) {
					responseHeaders['Access-Control-Allow-Origin'] = ['*'];
					return callback({ cancel: false, responseHeaders });
				}
			}

			return callback({ cancel: false });
		});

		//#endregion

		//#region Code Cache

		type SessionWithCodeCachePathSupport = Session & {
			/**
			 * Sets code cache directory. By default, the directory will be `Code Cache` under
			 * the respective user data folder.
			 */
			setCodeCachePath?(path: string): void;
		};

		const defaultSession = session.defaultSession as unknown as SessionWithCodeCachePathSupport;
		if (typeof defaultSession.setCodeCachePath === 'function' && this.environmentMainService.codeCachePath) {
			// Make sure to partition Chrome's code cache folder
			// in the same way as our code cache path to help
			// invalidate caches that we know are invalid
			// (https://github.com/microsoft/vscode/issues/120655)
			defaultSession.setCodeCachePath(join(this.environmentMainService.codeCachePath, 'chrome'));
		}

		//#endregion

		//#region UNC Host Allowlist (Windows)

		if (isWindows) {
			if (this.configurationService.getValue('security.restrictUNCAccess') === false) {
				disableUNCAccessRestrictions();
			} else {
				addUNCHostToAllowlist(this.configurationService.getValue('security.allowedUNCHosts'));
			}
		}

		//#endregion
	}

	/**
	 * 本地控制台编码，供 `vscode:execCode` 解码子进程输出用（2026-08-22）。
	 *
	 * `resolveTerminalEncoding()` 在 Windows 上要 spawn 一次 `chcp`，而 execute_code
	 * 是高频工具 —— 故按进程缓存 Promise（并发调用共享同一次探测）。
	 * 探测失败不阻塞执行：返回 undefined，解码器会用 gbk 作为回退候选。
	 */
	private _execCodeEncodingPromise: Promise<string | undefined> | undefined;
	private _resolveExecCodeEncoding(): Promise<string | undefined> {
		if (!this._execCodeEncodingPromise) {
			this._execCodeEncodingPromise = resolveTerminalEncoding()
				.catch(() => undefined);
		}
		return this._execCodeEncodingPromise;
	}

	private registerListeners(): void {

		// Dispose on shutdown
		Event.once(this.lifecycleMainService.onWillShutdown)(() => this.dispose());

		// Contextmenu via IPC support
		registerContextMenuListener();

		// Accessibility change event
		app.on('accessibility-support-changed', (event, accessibilitySupportEnabled) => {
			this.windowsMainService?.sendToAll('vscode:accessibilitySupportChanged', accessibilitySupportEnabled);
		});

		// macOS dock activate
		app.on('activate', async (event, hasVisibleWindows) => {
			this.logService.trace('app#activate');

			// Mac only event: open new window when we get activated
			if (!hasVisibleWindows) {
				await this.windowsMainService?.openEmptyWindow({ context: OpenContext.DOCK });
			}
		});

		//#region Security related measures (https://electronjs.org/docs/tutorial/security)
		//
		// !!! DO NOT CHANGE without consulting the documentation !!!
		//
		app.on('web-contents-created', (event, contents) => {

			// Auxiliary Window: delegate to `AuxiliaryWindow` class
			if (contents?.opener?.url.startsWith(`${Schemas.vscodeFileResource}://${VSCODE_AUTHORITY}/`)) {
				this.logService.trace('[aux window]  app.on("web-contents-created"): Registering auxiliary window');

				this.auxiliaryWindowsMainService?.registerWindow(contents);
			}

			// Handle any in-page navigation
			contents.on('will-navigate', event => {
				if (BrowserViewMainService.isBrowserViewWebContents(contents)) {
					return; // Allow navigation in integrated browser views
				}

				this.logService.error('webContents#will-navigate: Prevented webcontent navigation');

				event.preventDefault(); // Prevent any in-page navigation
			});

			// All Windows: only allow about:blank auxiliary windows to open
			// For all other URLs, delegate to the OS.
			contents.setWindowOpenHandler(details => {

				// about:blank windows can open as window witho our default options
				if (details.url === 'about:blank') {
					this.logService.trace('[aux window] webContents#setWindowOpenHandler: Allowing auxiliary window to open on about:blank');

					return {
						action: 'allow',
						overrideBrowserWindowOptions: this.auxiliaryWindowsMainService?.createWindow(details)
					};
				}

				// Any other URL: delegate to OS
				else {
					this.logService.trace(`webContents#setWindowOpenHandler: Prevented opening window with URL ${details.url}}`);

					this.nativeHostMainService?.openExternal(undefined, details.url);

					return { action: 'deny' };
				}
			});
		});

		//#endregion

		let macOpenFileURIs: IWindowOpenable[] = [];
		let runningTimeout: Timeout | undefined = undefined;
		app.on('open-file', (event, path) => {
			path = normalizeNFC(path); // macOS only: normalize paths to NFC form

			this.logService.trace('app#open-file: ', path);
			event.preventDefault();

			// Keep in array because more might come!
			macOpenFileURIs.push(hasWorkspaceFileExtension(path) ? { workspaceUri: URI.file(path) } : { fileUri: URI.file(path) });

			// Clear previous handler if any
			if (runningTimeout !== undefined) {
				clearTimeout(runningTimeout);
				runningTimeout = undefined;
			}

			// Handle paths delayed in case more are coming!
			runningTimeout = setTimeout(async () => {
				await this.windowsMainService?.open({
					context: OpenContext.DOCK /* can also be opening from finder while app is running */,
					cli: this.environmentMainService.args,
					urisToOpen: macOpenFileURIs,
					gotoLineMode: false,
					preferNewWindow: true /* dropping on the dock or opening from finder prefers to open in a new window */
				});

				macOpenFileURIs = [];
				runningTimeout = undefined;
			}, 100);
		});

		app.on('new-window-for-tab', async () => {
			await this.windowsMainService?.openEmptyWindow({ context: OpenContext.DESKTOP }); //macOS native tab "+" button
		});

		//#region Bootstrap IPC Handlers

		validatedIpcMain.handle('vscode:fetchShellEnv', event => {

			// Prefer to use the args and env from the target window
			// when resolving the shell env. It is possible that
			// a first window was opened from the UI but a second
			// from the CLI and that has implications for whether to
			// resolve the shell environment or not.
			//
			// Window can be undefined for e.g. the shared process
			// that is not part of our windows registry!
			const window = this.windowsMainService?.getWindowByWebContents(event.sender); // Note: this can be `undefined` for the shared process
			let args: NativeParsedArgs;
			let env: IProcessEnvironment;
			if (window?.config) {
				args = window.config;
				env = { ...process.env, ...window.config.userEnv };
			} else {
				args = this.environmentMainService.args;
				env = process.env;
			}

			// Resolve shell env
			return this.resolveShellEnvironment(args, env, false);
		});

		validatedIpcMain.on('vscode:toggleDevTools', event => event.sender.toggleDevTools());
		validatedIpcMain.on('vscode:openDevTools', event => event.sender.openDevTools());

		validatedIpcMain.on('vscode:reloadWindow', event => event.sender.reload());

		validatedIpcMain.handle('vscode:notifyZoomLevel', async (event, zoomLevel: number | undefined) => {
			const window = this.windowsMainService?.getWindowByWebContents(event.sender);
			if (window) {
				window.notifyZoomLevel(zoomLevel);
			}
		});

		// Git execution handler: allows renderer processes to execute git commands
		// via the main process (which has access to child_process).
		//
		// ★ 2026-09-15 新增两个可选参数：
		//
		// ① `env` —— **白名单**环境变量（目前仅 `GIT_INDEX_FILE`）。
		//    用途：worktree checkpoint 需要「用**隔离索引**快照工作树」：
		//    `git add -A` + `write-tree` 必须写到**另一个**索引文件，否则 `add -A`
		//    会把用户所有改动都 stage 掉（改坏真实暂存区）。
		//    为什么白名单而非任意 env：这是 renderer → main 的通道，只放行确实需要的键，
		//    避免变成通用的「设置任意环境变量」能力。
		//
		// ② `timeoutMs` —— 覆盖默认 30s，**钳制在 [1s, 600s]**。
		//    必要性（实测）：`add -A` 用全新索引时必须**逐文件**计算 hash 才能与旧索引比较，
		//    大仓（本仓 src/vs 规模）可能超过 30s；`git worktree add` 在大仓上同样可能超时
		//    （上游 agentHost 给的是 180s，见 `agentHostGitService.ts` 的 `_runGit` 调用）。
		//    超时过短会把**本来会成功**的操作杀掉，并留下半成品。
		const GIT_ENV_WHITELIST = new Set(['GIT_INDEX_FILE']);
		validatedIpcMain.handle('vscode:execGit', async (event, cwd: string, args: string[], env?: Record<string, string>, timeoutMs?: number) => {
			const extraEnv: Record<string, string> = {};
			if (env && typeof env === 'object') {
				for (const key of Object.keys(env)) {
					if (GIT_ENV_WHITELIST.has(key) && typeof env[key] === 'string') {
						extraEnv[key] = env[key];
					}
				}
			}
			const effectiveTimeoutMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
				? Math.min(600_000, Math.max(1_000, timeoutMs))
				: 30_000;

			return new Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }>((resolve) => {
				const child = spawn('git', args, {
					cwd,
					env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
					windowsHide: true,
				});

				let stdout = '';
				let stderr = '';
				let settled = false;

				// Timeout: kill the process to prevent indefinite hanging
				// (e.g. git waiting for auth, network issues with remote refs).
				// 默认 30s；调用方可通过第 5 个参数放宽（见上方 `effectiveTimeoutMs`）。
				const timeoutHandle = setTimeout(() => {
					if (!settled) {
						settled = true;
						try { child.kill('SIGKILL'); } catch { /* ignore */ }
						resolve({ success: false, stdout, stderr: stderr + `\n[timeout: git process killed after ${effectiveTimeoutMs}ms]`, exitCode: -1 });
					}
				}, effectiveTimeoutMs);

				child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
				child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

				child.on('error', (err) => {
					if (!settled) {
						settled = true;
						clearTimeout(timeoutHandle);
						resolve({ success: false, stdout, stderr: err.message, exitCode: -1 });
					}
				});

				child.on('close', (code) => {
					if (!settled) {
						settled = true;
						clearTimeout(timeoutHandle);
					resolve({ success: code === 0, stdout, stderr, exitCode: code ?? -1 });
				}
			});
		});
	});

	// Generic code/script execution handler: lets the renderer run shell commands
	// (python3/node/shell, e.g. the anysearch CLI) via the main process child_process.
	// Non-interactive, single-shot with a REAL exit code + timeout kill — distinct from
	// the pty-based `terminal` tool (interactive shell, no reliable exit code, idle-detect).
	// Backs the agentStudio `execute_code` tool (researcher subagent runs anysearch via it).
	validatedIpcMain.handle('vscode:execCode', async (event, payload: { command?: string; script?: string; interpreter?: string; cwd?: string; timeoutMs?: number; shell?: string; pathPrefix?: string; background?: boolean; taskId?: string; action?: 'poll' | 'kill' }) => {
		// 本地控制台编码：Windows 下探测 chcp（简中通常 cp936）。用于把 shell 自身的
		// 非 UTF-8 错误信息正确解码（见 processOutputDecoder 头注释）。
		// 探测走一次 `chcp` 子进程，故按进程缓存 —— execute_code 是高频工具。
		const localEncoding = (await this._resolveExecCodeEncoding()) ?? 'utf-8';

		// ── 后台执行控制面（P0-2）：poll / kill 已注册的后台任务 ──
		if (payload?.action === 'poll' || payload?.action === 'kill') {
			const handle = _bgExecs.get(payload.taskId ?? '');
			if (!handle) {
				return { success: false, stdout: '', stderr: `unknown exec task: ${payload.taskId ?? '(empty)'}`, exitCode: -1 };
			}
			if (payload.action === 'kill') {
				handle.settled = true;
				if (handle.timeoutHandle) { clearTimeout(handle.timeoutHandle); }
				if (process.platform === 'win32' && handle.child.pid) {
					await new Promise<void>((res) => execFile('taskkill', ['/pid', String(handle.child.pid), '/T', '/F'], () => res()));
				} else {
					try { handle.child.kill('SIGKILL'); } catch { /* ignore */ }
				}
				_bgExecs.delete(payload.taskId!);
				// ★ 2026-09-19（日志 1789813310143 取证）：**必须回 `done: true`**。
				// 渲染侧 `compatibilityTools` 的 poll/kill 文案只看 `ctrl.done`
				// （`ctrl.done ? 'finished' : 'still running'`）—— 此处原先只回 `killed: true`
				// ⇒ kill **实际成功**（settled 已置、句柄已删、taskkill /T /F 已执行），
				// 模型却收到「still running (exit -1)」，据此判定「kill 未立即生效（execFileSync
				// 阻塞中）」并开始**修一个不存在的 sync I/O 阻塞**（同一会话连续 20+ 轮被带偏）。
				// 这是典型的「**控制面回假信号 ⇒ agent 追错方向**」，与本仓「绝不静默/失真上报」相悖。
				return { success: true, done: true, stdout: handle.stdoutCollector.decode(handle.localEncoding), stderr: handle.stderrCollector.decode(handle.localEncoding), exitCode: handle.exitCode, killed: true };
			}
			// poll：返回当前累积输出 + 完成状态（不阻塞等待结束）
			return { success: !handle.settled, stdout: handle.stdoutCollector.decode(handle.localEncoding), stderr: handle.stderrCollector.decode(handle.localEncoding), exitCode: handle.exitCode, done: handle.settled };
		}

		// startExec：spawn 子进程并收集输出。foreground 通过 onDone 解析结果；
		// background 不传 onDone，仅把句柄写入 _bgExecs 供 poll 读取（P0-2）。
		const startExec = (onDone?: (r: { success: boolean; stdout: string; stderr: string; exitCode: number }) => void): IBgExecHandle => {
			// 2026-08-29（日志 1787974178941）：execute_code **不再被强制封顶 120s**。
			// 完全尊重调用方传入的 timeoutMs：> 0 计时；<= 0 / 非数字 → 不限时。
			const _reqTimeoutMs = Number(payload?.timeoutMs);
			const timeoutMs = Number.isFinite(_reqTimeoutMs) && _reqTimeoutMs > 0 ? Math.max(_reqTimeoutMs, 1000) : 0;
			// PYTHONIOENCODING/PYTHONUTF8：Windows 终端默认 GBK 编码，Python print()
			// 遇到 emoji 等非 GBK 字符会抛 UnicodeEncodeError（exit 1）。强制 UTF-8
			// 模式让任何 Python 脚本都能安全输出 Unicode（其他平台无副作用）。
			const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } as NodeJS.ProcessEnv & Record<string, string>;
			// Hermes 环境归一（2026-08-18）：可选 shell 路径（Git Bash）+ PATH 前缀
			// （coreutils 目录）。非登录 bash -c 不 source /etc/profile，必须显式把
			// usr\bin 前置到 PATH，head/tail/grep 等才可用；MSYS_NO_PATHCONV 禁路径改写。
			const useShell = payload?.shell ?? true;
			if (payload?.pathPrefix && env.PATH && !String(env.PATH).toLowerCase().startsWith(payload.pathPrefix.toLowerCase())) {
				env.PATH = `${payload.pathPrefix};${env.PATH}`;
			}
			if (payload?.shell) {
				env.MSYS_NO_PATHCONV = '1';
				env.MSYS2_ARG_CONV_EXCL = '*';
			}
			let child: ChildProcess;
			if (payload?.script !== undefined && payload?.interpreter) {
				// heredoc 脚本：spawn <interpreter>（无参数）并从 stdin 喂入脚本。
				// python3/node 无参数时从 stdin 读取并执行脚本 —— 跨平台（Windows cmd
				// 不支持 `python3 << 'EOF'` heredoc，会报 "此时不应有 <<"，exit 1）。
				child = spawn(payload.interpreter, [], {
					cwd: payload?.cwd,
					env,
					windowsHide: true,
				});
				child.stdin?.write(payload.script);
				child.stdin?.end();
			} else {
				const command = payload?.command ?? '';
				child = spawn(command, [], {
					cwd: payload?.cwd,
					env,
					windowsHide: true,
					shell: useShell,
				});
			}

			// ── 输出解码（2026-08-22，日志 1787363991734）─────────────────────
			// 收集字节 + 结束时整体解码，避免 CP936 mojibake 与跨 chunk 多字节切断。
			const stdoutCollector = new ProcessOutputCollector();
			const stderrCollector = new ProcessOutputCollector();
			child.stdout?.on('data', (data: Buffer) => stdoutCollector.push(data));
			child.stderr?.on('data', (data: Buffer) => stderrCollector.push(data));
			const handle: IBgExecHandle = { child, stdoutCollector, stderrCollector, localEncoding, settled: false, exitCode: -1, timeoutHandle: undefined };
			// 宽限落定定时器：见下方 `child.on('exit')` 的注释；统一由 `finish` 清理（幂等）。
			let settleGraceHandle: ReturnType<typeof setTimeout> | undefined;
			const finish = (r: { success: boolean; stdout: string; stderr: string; exitCode: number }) => {
				if (handle.settled) { return; }
				handle.settled = true;
				handle.exitCode = r.exitCode;
				if (handle.timeoutHandle) { clearTimeout(handle.timeoutHandle); }
				if (settleGraceHandle) { clearTimeout(settleGraceHandle); }
				onDone?.(r);
			};
			// timeoutMs=0 表示不限时：不安装 kill timer，进程跑到自己结束为止。
			handle.timeoutHandle = timeoutMs > 0 ? setTimeout(() => {
				if (!handle.settled) {
					const partialOut = stdoutCollector.decode(localEncoding);
					const partialErr = stderrCollector.decode(localEncoding);
					// ★★ 2026-09-21（P0-①，pi/bash 对比取证）：超时 marker **必须同时写进 stderrCollector**。
					//
					// 此前只把 marker 拼进「传给 onDone 的结果对象」—— 而**后台任务没有 onDone**
					// （`if (payload?.background)` 分支调用 `startExec()` 不传回调），渲染侧
					// `execute_code` 的"直播"模式又恰恰全程走后台任务 + poll（`poll` 只回
					// `stderrCollector.decode()`）⇒ marker 被丢弃 ⇒ 渲染侧
					// `parseTimeoutSecondsFromStderr` 判不出超时 ⇒ 走泛化失败分支
					// （真机实证：`stderr=0c` + `execute_code failed (exit -1)`），
					// 于是专为长任务写的 `timeoutGuidanceMessage`（background:true / 更大 timeout
					// 两条出路 + "别原样重发"）**永远打不出来** ✗ —— 恰好是它最该生效的场景。
					// 现在 marker 双写：collector（poll 可见）+ 结果对象（前台路径不变 ✓）。
					const killedAfter = Math.round(timeoutMs / 1000);
					const useTreeKill = process.platform === 'win32' && !!child.pid;
					const marker = useTreeKill
						? `\n[timeout: process tree killed after ${killedAfter}s]`
						: `\n[timeout: process killed after ${killedAfter}s]`;
					stderrCollector.push(Buffer.from(marker, 'utf8'));
					const settleTimeout = () => finish({ success: false, stdout: partialOut, stderr: partialErr + marker, exitCode: -1 });
					// Windows：shell:true 时 child 是 cmd.exe/bash，child.kill() 只杀 shell
					// 进程，不杀其 spawn 的子进程（如 node script.mjs 卡在 top-level await）。
					// 用 taskkill /T /F 杀整棵进程树；失败则回退 child.kill()。
					if (useTreeKill) {
						execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => settleTimeout());
					} else {
						try { child.kill('SIGKILL'); } catch { /* ignore */ }
						settleTimeout();
					}
				}
			}, timeoutMs) : undefined;

			child.on('error', (err) => {
				finish({ success: false, stdout: stdoutCollector.decode(localEncoding), stderr: err.message, exitCode: -1 });
			});

			child.on('close', (code) => {
				finish({ success: code === 0, stdout: stdoutCollector.decode(localEncoding), stderr: stderrCollector.decode(localEncoding), exitCode: code ?? -1 });
			});

			// ── 2026-09-19（日志 1789813310143 取证）：**子进程已退出，但管道没关** ⇒ `close` 永不触发 ──
			// 现象（该日志里的实测）：`[execute_code poll] task … — still running (exit -1)` 无限重复，
			// 而同一条命令 `tasklist //FI "IMAGENAME eq node.exe"` 显示**没有任何 node.exe** ——
			// 子进程早没了，控制面却永远报"在跑"；agent 因此写下「矛盾点：后台任务 still running，
			// 但无 node.exe 进程」并被引向"修 sync I/O"的错误方向。
			// 成因：`close` 的语义是「进程退出 **且** stdout/stderr 全部 EOF」。只要有**孙进程**
			// （或 reparent 的守护进程、shell 包装层）继承了这两个管道，EOF 就永不到来；而
			// `timeoutMs = 0`（不限时，2026-08-29 的既定行为）时**没有任何兜底定时器** ⇒
			// 句柄永远 `settled=false` / `exitCode=-1`。
			// 处理：`exit`（进程真的没了）后给管道 1s 宽限期，用**已收到的输出**落定；
			// 若 1s 内 `close` 到达，以 close 的完整输出为准（`finish` 幂等、先到先得）。
			// ⚠ 刻意**不**改 `timeoutMs=0` 的"不限时"语义（那是 08-29 的既定裁定）——
			// 本修复只保证"任务不结束"不再等于"永远无法上报"。
			child.on('exit', (code) => {
				if (handle.settled || settleGraceHandle) { return; }
				settleGraceHandle = setTimeout(() => {
					finish({ success: code === 0, stdout: stdoutCollector.decode(localEncoding), stderr: stderrCollector.decode(localEncoding), exitCode: code ?? -1 });
				}, 1000);
			});
			return handle;
		};

		// ── 后台执行：spawn 后即返回 taskId，不阻塞当前轮（P0-2）──
		if (payload?.background) {
			const taskId = (payload.taskId && !_bgExecs.has(payload.taskId)) ? payload.taskId : generateUuid();
			const handle = startExec();
			_bgExecs.set(taskId, handle);
			return { success: true, stdout: '', stderr: '', exitCode: 0, background: true, taskId, pid: handle.child.pid ?? -1 };
		}

		// ── 前台执行：等待进程结束 ──
		return new Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }>((resolve) => {
			startExec(resolve);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Launch a worktree ("debug" it) — dispatch by project type. The strategy
	// resolver lives in worktreeDebugStrategies.ts; it supports vscode-fork /
	// web / node / python (explicit .vscode/launch.json > marker auto-detect),
	// with a folder-open fallback for unknown types.
	// ─────────────────────────────────────────────────────────────────────────
	validatedIpcMain.handle('vscode:launchWorktreeDebug', async (_event, payload: { worktreePath: string }) => {
		const worktreePath = payload?.worktreePath?.trim();
		if (!worktreePath || !existsSync(worktreePath)) {
			return { success: false, stderr: `worktree path not found: ${worktreePath}` };
		}
		return dispatchWorktreeDebug(worktreePath, process.execPath);
	});

	// "Debug in terminal" flow: resolve the build + launch commands without
	// executing them, so the renderer can run them in the integrated terminal
	// and the user sees the compile output live.
	validatedIpcMain.handle('vscode:resolveWorktreeDebugPlan', async (_event, payload: { worktreePath: string }) => {
		const worktreePath = payload?.worktreePath?.trim();
		if (!worktreePath || !existsSync(worktreePath)) {
			return { success: false, stderr: `worktree path not found: ${worktreePath}` };
		}
		return resolveWorktreeDebugPlan(worktreePath, process.execPath);
	});

	// Renderer → main process HTTP fetch channel: bypasses CORS (the renderer's
	// browser fetch() is subject to origin checks that can block DuckDuckGo /
	// anysearch API endpoints — DDG returns 403 for origin vscode-file://vscode-app).
	// Uses Chromium's net.fetch (Electron main process, no CORS constraints).
	// Backs the agentStudio web_search / web_extract tools in the renderer process.
	validatedIpcMain.handle('vscode:webFetch', async (_event, payload: { url: string; method?: string; headers?: Record<string, string>; body?: string; binary?: boolean }) => {
		const url = (payload?.url ?? '').trim();
		if (!url) { throw new Error('url is required'); }

		// net.fetch 使用 Chromium 网络栈：自动处理重定向、HTTPS、压缩，
		// 且无 CORS 限制。比 Node.js http/https 模块更可靠。
		// method/body 支持：ComfyUI 代理（comfy.fetch）需要 POST /prompt。
		const response = await net.fetch(url, {
			method: payload?.method ?? 'GET',
			headers: payload?.headers ?? { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36' },
			...(payload?.body !== undefined ? { body: payload.body } : {}),
		});

		// ★ binary 模式：ComfyUI 的 `/view?filename=…` 返回 PNG/JPEG 二进制。
		//   走 `response.text()` 会用 UTF-8 解码字节流 → 非法序列被替换成 U+FFFD
		//   → 图像**不可逆损坏**。instant stage（Rotate/Mirror/Crop）需要真实
		//   像素做 canvas 变换，因此必须以 base64 原样回传。
		//   非 binary 调用路径（web_search / prompt / history JSON）保持原样。
		if (payload?.binary) {
			const buf = Buffer.from(await response.arrayBuffer());
			// ★ 4MB 上限 + **截断标记**（2026-09-15）：
			//   此前是**静默** `subarray(0, 4MB)` ⇒ 调用方拿到"看似成功"的残缺 dataURL
			//   （mp4 头完好、尾部缺失）⇒ 抠像 / GIF 编码 / 视频解码阶段才失败，
			//   报错点离根因很远 ✗（用户实测：AnimatedEmoji 原片"固化成功"但②/③ 仍失败）。
			//   现在把 `truncated` / `totalBytes` 一并回传，由上层显式判失败并走落盘回退。
			const cap = 4 * 1024 * 1024;
			return {
				ok: response.ok,
				status: response.status,
				statusText: response.statusText,
				// 4MB cap 与文本路径一致（ComfyUI 单张预览图远小于此）。
				base64: buf.subarray(0, cap).toString('base64'),
				contentType: response.headers.get('content-type') ?? 'application/octet-stream',
				truncated: buf.byteLength > cap,
				totalBytes: buf.byteLength,
			};
		}

		const body = await response.text();
		return {
			ok: response.ok,
			status: response.status,
			statusText: response.statusText,
			body: body.slice(0, 4 * 1024 * 1024), // 4MB cap — ComfyUI prompt/history/images fit
		};
	});

	// ComfyUI 一键启动 / 路径查询 / 路径写入：逻辑已抽离到独立 channel
	// （sessions/contrib/agentStudio/electron-main/comfyLaunchChannel.ts），
	// 此处仅负责注册其生命周期。
	this._register(new ComfyLaunchChannel(this.logService, this.configurationService));

	// ConfigHTML URL 模式：本地面板服务按需拉起 / 停止（如测试面板 127.0.0.1:5600）。
	// 逻辑在 sessions/contrib/agentStudio/electron-main/configHtmlServerChannel.ts。
	this._register(new ConfigHtmlServerChannel(this.logService, this.lifecycleMainService));

	// Vox 口播视频节点（Vox.DirectorStage）本地 pipeline 执行：
	// 逻辑在 sessions/contrib/agentStudio/electron-main/voxLaunchChannel.ts。
	this._register(new VoxLaunchChannel(this.logService, this.configurationService));

	// 飞书 CLI（@larksuite/cli）探测 / 安装 / 升级：
	// 逻辑在 sessions/contrib/agentStudio/electron-main/larkCliChannel.ts。
	// 必须放主进程：探测与安装都要 child_process（渲染进程没有）。
	this._register(new LarkCliChannel(this.logService));

	// 渠道绑定状态（chat_id ↔ Agent / 专属会话）的文件存储：
	// 逻辑在 sessions/contrib/agentStudio/electron-main/bridgeStoreChannel.ts。
	// 必须放主进程：渲染进程沙箱里拿不到 fs（否则绑定只存内存、重启即丢）。
	this._register(new BridgeStoreChannel(this.logService));

	// 远程控制（被控端）：屏幕采集 / WebRTC 宿主窗口 / nut-js 驱动级键鼠注入。
	// 逻辑在 sessions/contrib/agentStudio/electron-main/remoteControlChannel.ts。
	this._register(new RemoteControlChannel(this.logService));

	// 知识库「非文本素材 → 文本」：用本机 python(pypdf) 提取 PDF 文字层，
	// 供「批量构建笔记」把 PDF 素材转成 md 再构建（素材枚举只收 md）。
	// 逻辑在 sessions/contrib/agentStudio/electron-main/kbDocConvertChannel.ts。
	// 必须放主进程：渲染进程没有 child_process，而提取要 spawn python。
	this._register(new KbDocConvertChannel(this.logService, this.configurationService));

	// AI 抠图（去背景）2026-09-06 起由 ComfyUI 自定义节点 saros_cutout 执行
	// （webview 侧 comfyHost/comfyCutout.ts），主进程不再承载 ONNX 推理与模型缓存。

	// ──────────────────────────────────────────────────────────
	// 内存诊断: 定期采样 + 超阈值自动 dump heap snapshot
	// 用法:
	//   启动时加 --memory-diag          → 开启(默认关闭)
	//   加 --memory-diag-threshold=4096 → 超过 4GB 时 dump(默认 6GB)
	//   输出到 %TEMP%\sarosis-heap-*.heapsnapshot
	//
	// 不影响正常使用;不传参 = 完全无开销。
	// ──────────────────────────────────────────────────────────
	if (this.environmentMainService.args['memory-diag']) {
		const _MB = (bytes: number) => Math.round(bytes / 1024 / 1024);
		const _thresholdMB = Number(this.environmentMainService.args['memory-diag-threshold']) || 6144; // default 6 GB
		const _log = this.logService;
		const _tmpDir = process.env.TEMP || process.env.TMP || '/tmp';
		let _dumpCount = 0;

		_log.info(`[MemoryDiag] ENABLED — sampling every 60s, auto-dump at >${_thresholdMB} MB`);

		const _interval = setInterval(() => {
			const mem = process.memoryUsage();
			const rssMB = _MB(mem.rss);
			const heapMB = _MB(mem.heapUsed);
			const externalMB = _MB(mem.external);

			_log.info(
				`[MemoryDiag] rss=${rssMB}MB heap=${heapMB}MB external=${externalMB}MB ` +
				`(heapTotal=${_MB(mem.heapTotal)}MB)`
			);

			if (rssMB > _thresholdMB) {
				_dumpCount++;
				const ts = new Date().toISOString().replace(/[:.]/g, '-');
				const path = `${_tmpDir}\\sarosis-heap-${ts}-${_dumpCount}.heapsnapshot`;

				try {
					// eslint-disable-next-line @typescript-eslint/no-var-requires
					const v8 = require('v8') as typeof import('v8');
					v8.writeHeapSnapshot(path);
					_log.error(
						`[MemoryDiag] ⚠ RSS ${rssMB}MB > ${_thresholdMB}MB threshold — ` +
						`heap snapshot #${_dumpCount} written to ${path}`
					);
				} catch (e) {
					_log.error(`[MemoryDiag] failed to write heap snapshot: ${e}`);
				}
			}
		}, 60_000); // 每 60 秒采样一次

		// 进程退出时清理
		app.on('before-quit', () => clearInterval(_interval));
	}

	//#endregion
}

	async startup(): Promise<void> {
		this.logService.debug('Starting VS Code');
		this.logService.debug(`from: ${this.environmentMainService.appRoot}`);
		this.logService.debug('args:', this.environmentMainService.args);

		// 端口必须在**任何窗口创建之前**确定并注入渲染侧（渲染进程继承主进程环境变量）
		this._initAgentMemoryEndpoint();
		// BYOK → AGENTMEMORY_LLM_*（供网关 LLM 压缩；同样需在窗口/网关创建前注入）
		this._initAgentMemoryLlm();

		// Make sure we associate the program with the app user model id
		// This will help Windows to associate the running program with
		// any shortcut that is pinned to the taskbar and prevent showing
		// two icons in the taskbar for the same app.
		const win32AppUserModelId = this.productService.win32AppUserModelId;
		if (isWindows && win32AppUserModelId) {
			app.setAppUserModelId(win32AppUserModelId);
		}

		// Fix native tabs on macOS 10.13
		// macOS enables a compatibility patch for any bundle ID beginning with
		// "com.microsoft.", which breaks native tabs for VS Code when using this
		// identifier (from the official build).
		// Explicitly opt out of the patch here before creating any windows.
		// See: https://github.com/microsoft/vscode/issues/35361#issuecomment-399794085
		try {
			if (isMacintosh && this.configurationService.getValue('window.nativeTabs') === true && !systemPreferences.getUserDefault('NSUseImprovedLayoutPass', 'boolean')) {
				systemPreferences.setUserDefault('NSUseImprovedLayoutPass', 'boolean', true);
			}
		} catch (error) {
			this.logService.error(error);
		}

		// Main process server (electron IPC based)
		const mainProcessElectronServer = new ElectronIPCServer();
		Event.once(this.lifecycleMainService.onWillShutdown)(e => {
			if (e.reason === ShutdownReason.KILL) {
				// When we go down abnormally, make sure to free up
				// any IPC we accept from other windows to reduce
				// the chance of doing work after we go down. Kill
				// is special in that it does not orderly shutdown
				// windows.
				mainProcessElectronServer.dispose();
			}
		});

		// Resolve unique machine ID
		const [machineId, sqmId, devDeviceId] = await Promise.all([
			resolveMachineId(this.stateService, this.logService),
			resolveSqmId(this.stateService, this.logService),
			resolveDevDeviceId(this.stateService, this.logService)
		]);

		// Shared process
		const { sharedProcessReady, sharedProcessClient } = this.setupSharedProcess(machineId, sqmId, devDeviceId);

		// Services
		const appInstantiationService = await this.initServices(machineId, sqmId, devDeviceId, sharedProcessReady);

		// Error telemetry
		appInstantiationService.invokeFunction(accessor => this._register(new ErrorTelemetry(accessor.get(ILogService), accessor.get(ITelemetryService))));

		// Metered connection telemetry
		appInstantiationService.invokeFunction(accessor => {
			(accessor.get(IMeteredConnectionService) as MeteredConnectionMainService).setTelemetryService(accessor.get(ITelemetryService));
		});

		// Auth Handler
		appInstantiationService.invokeFunction(accessor => accessor.get(IProxyAuthService));

		// Transient profiles handler
		this._register(appInstantiationService.createInstance(UserDataProfilesHandler));

		// Init Channels
		appInstantiationService.invokeFunction(accessor => this.initChannels(accessor, mainProcessElectronServer, sharedProcessClient));

		// Setup Protocol URL Handlers
		const initialProtocolUrls = await appInstantiationService.invokeFunction(accessor => this.setupProtocolUrlHandlers(accessor, mainProcessElectronServer));

		// Setup vscode-remote-resource protocol handler
		this.setupManagedRemoteResourceUrlHandler(mainProcessElectronServer);

		// Signal phase: ready - before opening first window
		this.lifecycleMainService.phase = LifecycleMainPhase.Ready;

		// Open Windows
		await appInstantiationService.invokeFunction(accessor => this.openFirstWindow(accessor, initialProtocolUrls));

		// Signal phase: after window open
		this.lifecycleMainService.phase = LifecycleMainPhase.AfterWindowOpen;

		// Post Open Windows Tasks
		this.afterWindowOpen(appInstantiationService);

		// Set lifecycle phase to `Eventually` after a short delay and when idle (min 2.5sec, max 5sec)
		const eventuallyPhaseScheduler = this._register(new RunOnceScheduler(() => {
			this._register(runWhenGlobalIdle(() => {

				// Signal phase: eventually
				this.lifecycleMainService.phase = LifecycleMainPhase.Eventually;

				// Eventually Post Open Window Tasks
				this.eventuallyAfterWindowOpen();
			}, 2500));
		}, 2500));
		eventuallyPhaseScheduler.schedule();
	}

	private async setupProtocolUrlHandlers(accessor: ServicesAccessor, mainProcessElectronServer: ElectronIPCServer): Promise<IInitialProtocolUrls | undefined> {
		const windowsMainService = this.windowsMainService = accessor.get(IWindowsMainService);
		const urlService = accessor.get(IURLService);
		const nativeHostMainService = this.nativeHostMainService = accessor.get(INativeHostMainService);
		const dialogMainService = accessor.get(IDialogMainService);

		// Install URL handlers that deal with protocl URLs either
		// from this process by opening windows and/or by forwarding
		// the URLs into a window process to be handled there.

		const app = this;
		urlService.registerHandler({
			async handleURL(uri: URI, options?: IOpenURLOptions): Promise<boolean> {
				return app.handleProtocolUrl(windowsMainService, dialogMainService, urlService, uri, options);
			}
		});

		const activeWindowManager = this._register(new ActiveWindowManager({
			onDidOpenMainWindow: nativeHostMainService.onDidOpenMainWindow,
			onDidFocusMainWindow: nativeHostMainService.onDidFocusMainWindow,
			getActiveWindowId: () => nativeHostMainService.getActiveWindowId(-1)
		}));
		const activeWindowRouter = new StaticRouter(ctx => activeWindowManager.getActiveClientId().then(id => ctx === id));
		const urlHandlerRouter = new URLHandlerRouter(activeWindowRouter, this.logService);
		const urlHandlerChannel = mainProcessElectronServer.getChannel('urlHandler', urlHandlerRouter);
		urlService.registerHandler(new URLHandlerChannelClient(urlHandlerChannel));

		const initialProtocolUrls = await this.resolveInitialProtocolUrls(windowsMainService, dialogMainService);
		this._register(new ElectronURLListener(initialProtocolUrls?.urls, urlService, windowsMainService, this.environmentMainService, this.productService, this.logService));

		return initialProtocolUrls;
	}

	private setupManagedRemoteResourceUrlHandler(mainProcessElectronServer: ElectronIPCServer) {
		const notFound = (): Electron.ProtocolResponse => ({ statusCode: 404, data: 'Not found' });
		const remoteResourceChannel = new Lazy(() => mainProcessElectronServer.getChannel(
			NODE_REMOTE_RESOURCE_CHANNEL_NAME,
			new NodeRemoteResourceRouter(),
		));

		protocol.registerBufferProtocol(Schemas.vscodeManagedRemoteResource, (request, callback) => {
			const url = URI.parse(request.url);
			if (!url.authority.startsWith('window:')) {
				return callback(notFound());
			}

			remoteResourceChannel.value.call<NodeRemoteResourceResponse>(NODE_REMOTE_RESOURCE_IPC_METHOD_NAME, [url]).then(
				r => callback({ ...r, data: Buffer.from(r.body, 'base64') }),
				err => {
					this.logService.warn('error dispatching remote resource call', err);
					callback({ statusCode: 500, data: String(err) });
				});
		});
	}

	private async resolveInitialProtocolUrls(windowsMainService: IWindowsMainService, dialogMainService: IDialogMainService): Promise<IInitialProtocolUrls | undefined> {

		/**
		 * Protocol URL handling on startup is complex, refer to
		 * {@link IInitialProtocolUrls} for an explainer.
		 */

		// Windows/Linux: protocol handler invokes CLI with --open-url
		const protocolUrlsFromCommandLine = this.environmentMainService.args['open-url'] ? this.environmentMainService.args._urls || [] : [];
		if (protocolUrlsFromCommandLine.length > 0) {
			this.logService.trace('app#resolveInitialProtocolUrls() protocol urls from command line:', protocolUrlsFromCommandLine);
		}

		// macOS: open-url events that were received before the app is ready
		const protocolUrlsFromEvent = ((global as { getOpenUrls?: () => string[] }).getOpenUrls?.() || []);
		if (protocolUrlsFromEvent.length > 0) {
			this.logService.trace(`app#resolveInitialProtocolUrls() protocol urls from macOS 'open-url' event:`, protocolUrlsFromEvent);
		}

		if (protocolUrlsFromCommandLine.length + protocolUrlsFromEvent.length === 0) {
			return undefined;
		}

		const protocolUrls = [
			...protocolUrlsFromCommandLine,
			...protocolUrlsFromEvent
		].map(url => {
			try {
				return { uri: URI.parse(url), originalUrl: url };
			} catch {
				this.logService.trace('app#resolveInitialProtocolUrls() protocol url failed to parse:', url);

				return undefined;
			}
		});

		const openables: IWindowOpenable[] = [];
		const urls: IProtocolUrl[] = [];

		for (const protocolUrl of protocolUrls) {
			if (!protocolUrl) {
				continue; // invalid
			}

			const windowOpenable = this.getWindowOpenableFromProtocolUrl(protocolUrl.uri);
			if (windowOpenable) {
				if ((process as INodeProcess).isEmbeddedApp) {
					this.logService.trace('app#resolveInitialProtocolUrls() agents app skipping window openable:', protocolUrl.uri.toString(true));
					continue; // Agents app: skip all window openables (file/folder/workspace)
				}

				if (await this.shouldBlockOpenable(windowOpenable, windowsMainService, dialogMainService)) {
					this.logService.trace('app#resolveInitialProtocolUrls() protocol url was blocked:', protocolUrl.uri.toString(true));

					continue; // blocked
				} else {
					this.logService.trace('app#resolveInitialProtocolUrls() protocol url will be handled as window to open:', protocolUrl.uri.toString(true), windowOpenable);

					openables.push(windowOpenable); // handled as window to open
				}
			} else {
				this.logService.trace('app#resolveInitialProtocolUrls() protocol url will be passed to active window for handling:', protocolUrl.uri.toString(true));

				urls.push(protocolUrl); // handled within active window
			}
		}

		return { urls, openables };
	}

	private async shouldBlockOpenable(openable: IWindowOpenable, windowsMainService: IWindowsMainService, dialogMainService: IDialogMainService): Promise<boolean> {
		let openableUri: URI;
		let message: string;
		if (isWorkspaceToOpen(openable)) {
			openableUri = openable.workspaceUri;
			message = localize('confirmOpenMessageWorkspace', "An external application wants to open '{0}' in {1}. Do you want to open this workspace file?", openableUri.scheme === Schemas.file ? getPathLabel(openableUri, { os: OS, tildify: this.environmentMainService }) : openableUri.toString(true), this.productService.nameShort);
		} else if (isFolderToOpen(openable)) {
			openableUri = openable.folderUri;
			message = localize('confirmOpenMessageFolder', "An external application wants to open '{0}' in {1}. Do you want to open this folder?", openableUri.scheme === Schemas.file ? getPathLabel(openableUri, { os: OS, tildify: this.environmentMainService }) : openableUri.toString(true), this.productService.nameShort);
		} else {
			openableUri = openable.fileUri;
			message = localize('confirmOpenMessageFileOrFolder', "An external application wants to open '{0}' in {1}. Do you want to open this file or folder?", openableUri.scheme === Schemas.file ? getPathLabel(openableUri, { os: OS, tildify: this.environmentMainService }) : openableUri.toString(true), this.productService.nameShort);
		}

		if (openableUri.scheme !== Schemas.file && openableUri.scheme !== Schemas.vscodeRemote) {

			// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
			//
			// NOTE: we currently only ask for confirmation for `file` and `vscode-remote`
			// authorities here. There is an additional confirmation for `extension.id`
			// authorities from within the window.
			//
			// IF YOU ARE PLANNING ON ADDING ANOTHER AUTHORITY HERE, MAKE SURE TO ALSO
			// ADD IT TO THE CONFIRMATION CODE BELOW OR INSIDE THE WINDOW!
			//
			// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

			return false;
		}

		const askForConfirmation = this.configurationService.getValue<unknown>(CodeApplication.SECURITY_PROTOCOL_HANDLING_CONFIRMATION_SETTING_KEY[openableUri.scheme]);
		if (askForConfirmation === false) {
			return false; // not blocked via settings
		}

		const { response, checkboxChecked } = await dialogMainService.showMessageBox({
			type: 'warning',
			buttons: [
				localize({ key: 'open', comment: ['&& denotes a mnemonic'] }, "&&Yes"),
				localize({ key: 'cancel', comment: ['&& denotes a mnemonic'] }, "&&No")
			],
			message,
			detail: localize('confirmOpenDetail', "If you did not initiate this request, it may represent an attempted attack on your system. Unless you took an explicit action to initiate this request, you should press 'No'"),
			checkboxLabel: openableUri.scheme === Schemas.file ? localize('doNotAskAgainLocal', "Allow opening local paths without asking") : localize('doNotAskAgainRemote', "Allow opening remote paths without asking"),
			cancelId: 1
		});

		if (response !== 0) {
			return true; // blocked by user choice
		}

		if (checkboxChecked) {
			// Due to https://github.com/microsoft/vscode/issues/195436, we can only
			// update settings from within a window. But we do not know if a window
			// is about to open or can already handle the request, so we have to send
			// to any current window and any newly opening window.
			const request = { channel: 'vscode:disablePromptForProtocolHandling', args: openableUri.scheme === Schemas.file ? 'local' : 'remote' };
			windowsMainService.sendToFocused(request.channel, request.args);
			windowsMainService.sendToOpeningWindow(request.channel, request.args);
		}

		return false; // not blocked by user choice
	}

	private getWindowOpenableFromProtocolUrl(uri: URI): IWindowOpenable | undefined {
		if (!uri.path) {
			return undefined;
		}

		// File path
		if (uri.authority === Schemas.file) {
			const fileUri = URI.file(uri.fsPath);

			if (hasWorkspaceFileExtension(fileUri)) {
				return { workspaceUri: fileUri };
			}

			return { fileUri };
		}

		// Remote path
		else if (uri.authority === Schemas.vscodeRemote) {

			// Example conversion:
			// From: vscode://vscode-remote/wsl+ubuntu/mnt/c/GitDevelopment/monaco
			//   To: vscode-remote://wsl+ubuntu/mnt/c/GitDevelopment/monaco

			const secondSlash = uri.path.indexOf(posix.sep, 1 /* skip over the leading slash */);
			let authority: string;
			let path: string;
			if (secondSlash !== -1) {
				authority = uri.path.substring(1, secondSlash);
				path = uri.path.substring(secondSlash);
			} else {
				authority = uri.path.substring(1);
				path = '/';
			}

			let query = uri.query;
			const params = new URLSearchParams(uri.query);
			if (params.get('windowId') === '_blank') {
				// Make sure to unset any `windowId=_blank` here
				// https://github.com/microsoft/vscode/issues/191902
				params.delete('windowId');
				query = params.toString();
			}

			const remoteUri = URI.from({ scheme: Schemas.vscodeRemote, authority, path, query, fragment: uri.fragment });

			if (hasWorkspaceFileExtension(path)) {
				return { workspaceUri: remoteUri };
			}

			if (/:[\d]+$/.test(path)) {
				// path with :line:column syntax
				return { fileUri: remoteUri };
			}

			return { folderUri: remoteUri };
		}
		return undefined;
	}

	private async handleProtocolUrl(windowsMainService: IWindowsMainService, dialogMainService: IDialogMainService, urlService: IURLService, uri: URI, options?: IOpenURLOptions): Promise<boolean> {
		this.logService.trace('app#handleProtocolUrl():', uri.toString(true), options);

		// Agents app: ensure the agents window is open, then let other handlers process the URL.
		if ((process as INodeProcess).isEmbeddedApp) {
			this.logService.trace('app#handleProtocolUrl() agents app handling protocol URL:', uri.toString(true));

			// Skip window openables (file/folder/workspace) for security
			const windowOpenable = this.getWindowOpenableFromProtocolUrl(uri);
			if (windowOpenable) {
				this.logService.trace('app#handleProtocolUrl() agents app skipping window openable:', uri.toString(true));
				return true;
			}

			// Ensure agents window is open to receive the URL
			const windows = await windowsMainService.openAgentsWindow({ context: OpenContext.LINK, cli: this.environmentMainService.args });
			const window = windows.at(0);
			window?.focus();
			await window?.ready();

			// Return false to let subsequent handlers (e.g., URLHandlerChannelClient) forward the URL
			return false;
		}

		// Support 'workspace' URLs (https://github.com/microsoft/vscode/issues/124263)
		if (uri.scheme === this.productService.urlProtocol && uri.path === 'workspace') {
			uri = uri.with({
				authority: Schemas.file,
				path: URI.parse(uri.query).path,
				query: ''
			});
		}

		let shouldOpenInNewWindow = false;

		// We should handle the URI in a new window if the URL contains `windowId=_blank`
		const params = new URLSearchParams(uri.query);
		if (params.get('windowId') === '_blank') {
			this.logService.trace(`app#handleProtocolUrl() found 'windowId=_blank' as parameter, setting shouldOpenInNewWindow=true:`, uri.toString(true));

			params.delete('windowId');
			uri = uri.with({ query: params.toString() });

			shouldOpenInNewWindow = true;
		}

		// or if no window is open (macOS only)
		else if (isMacintosh && windowsMainService.getWindowCount() === 0) {
			this.logService.trace(`app#handleProtocolUrl() running on macOS with no window open, setting shouldOpenInNewWindow=true:`, uri.toString(true));

			shouldOpenInNewWindow = true;
		}

		// Pass along whether the application is being opened via a Continue On flow
		const continueOn = params.get('continueOn');
		if (continueOn !== null) {
			this.logService.trace(`app#handleProtocolUrl() found 'continueOn' as parameter:`, uri.toString(true));

			params.delete('continueOn');
			uri = uri.with({ query: params.toString() });

			this.environmentMainService.continueOn = continueOn ?? undefined;
		}

		// Extract session parameter to open a specific chat session in the target window
		const session = params.get('session');
		if (session !== null) {
			this.logService.trace(`app#handleProtocolUrl() found 'session' as parameter:`, uri.toString(true));

			params.delete('session');
			uri = uri.with({ query: params.toString() });
		}

		// Check if the protocol URL is a window openable to open...
		const windowOpenableFromProtocolUrl = this.getWindowOpenableFromProtocolUrl(uri);
		if (windowOpenableFromProtocolUrl) {
			if (await this.shouldBlockOpenable(windowOpenableFromProtocolUrl, windowsMainService, dialogMainService)) {
				this.logService.trace('app#handleProtocolUrl() protocol url was blocked:', uri.toString(true));

				return true; // If openable should be blocked, behave as if it's handled
			} else {
				this.logService.trace('app#handleProtocolUrl() opening protocol url as window:', windowOpenableFromProtocolUrl, uri.toString(true));

				const window = (await windowsMainService.open({
					context: OpenContext.LINK,
					cli: { ...this.environmentMainService.args },
					urisToOpen: [windowOpenableFromProtocolUrl],
					forceNewWindow: shouldOpenInNewWindow,
					gotoLineMode: true
					// remoteAuthority: will be determined based on windowOpenableFromProtocolUrl
				})).at(0);

				window?.focus(); // this should help ensuring that the right window gets focus when multiple are opened

				// Open chat session in the target window if requested
				if (window && session) {
					window.sendWhenReady('vscode:openChatSession', CancellationToken.None, session);
				}

				return true;
			}
		}

		// ...or if we should open in a new window and then handle it within that window
		if (shouldOpenInNewWindow) {
			this.logService.trace('app#handleProtocolUrl() opening empty window and passing in protocol url:', uri.toString(true));

			const window = (await windowsMainService.open({
				context: OpenContext.LINK,
				cli: { ...this.environmentMainService.args },
				forceNewWindow: true,
				forceEmpty: true,
				gotoLineMode: true,
				remoteAuthority: getRemoteAuthority(uri)
			})).at(0);

			await window?.ready();

			return urlService.open(uri, options);
		}

		this.logService.trace('app#handleProtocolUrl(): not handled', uri.toString(true), options);

		return false;
	}

	private setupSharedProcess(machineId: string, sqmId: string, devDeviceId: string): { sharedProcessReady: Promise<MessagePortClient>; sharedProcessClient: Promise<MessagePortClient> } {
		const sharedProcess = this._register(this.mainInstantiationService.createInstance(SharedProcess, machineId, sqmId, devDeviceId));

		this._register(sharedProcess.onDidCrash(() => this.windowsMainService?.sendToFocused('vscode:reportSharedProcessCrash')));

		const sharedProcessClient = (async () => {
			this.logService.trace('Main->SharedProcess#connect');

			const port = await sharedProcess.connect();

			this.logService.trace('Main->SharedProcess#connect: connection established');

			return new MessagePortClient(port, 'main');
		})();

		const sharedProcessReady = (async () => {
			await sharedProcess.whenReady();

			return sharedProcessClient;
		})();

		return { sharedProcessReady, sharedProcessClient };
	}

	private async initServices(machineId: string, sqmId: string, devDeviceId: string, sharedProcessReady: Promise<MessagePortClient>): Promise<IInstantiationService> {
		const services = new ServiceCollection();

		// Update
		switch (process.platform) {
			case 'win32':
				services.set(IUpdateService, new SyncDescriptor(Win32UpdateService));
				break;

			case 'linux':
				if (isLinuxSnap) {
					services.set(IUpdateService, new SyncDescriptor(SnapUpdateService, [process.env['SNAP'], process.env['SNAP_REVISION']]));
				} else {
					services.set(IUpdateService, new SyncDescriptor(LinuxUpdateService));
				}
				break;

			case 'darwin':
				services.set(IUpdateService, new SyncDescriptor(DarwinUpdateService));
				break;
		}

		// Windows
		services.set(IWindowsMainService, new SyncDescriptor(WindowsMainService, [machineId, sqmId, devDeviceId, this.userEnv], false));
		services.set(IAuxiliaryWindowsMainService, new SyncDescriptor(AuxiliaryWindowsMainService, undefined, false));

		// Dialogs
		const dialogMainService = new DialogMainService(this.logService, this.productService);
		services.set(IDialogMainService, dialogMainService);

		// Launch
		services.set(ILaunchMainService, new SyncDescriptor(LaunchMainService, undefined, false /* proxied to other processes */));

		// Diagnostics
		services.set(IDiagnosticsMainService, new SyncDescriptor(DiagnosticsMainService, undefined, false /* proxied to other processes */));
		services.set(IDiagnosticsService, ProxyChannel.toService(getDelayedChannel(sharedProcessReady.then(client => client.getChannel('diagnostics')))));

		// Encryption
		services.set(IEncryptionMainService, new SyncDescriptor(EncryptionMainService));

		// Cross-app IPC
		services.set(ICrossAppIPCService, new SyncDescriptor(CrossAppIPCService));

		// Browser View
		services.set(IBrowserViewMainService, new SyncDescriptor(BrowserViewMainService, undefined, false /* proxied to other processes */));
		services.set(IBrowserViewGroupMainService, new SyncDescriptor(BrowserViewGroupMainService, undefined, false /* proxied to other processes */));

		// Keyboard Layout
		services.set(IKeyboardLayoutMainService, new SyncDescriptor(KeyboardLayoutMainService));

		// Native Host
		services.set(INativeHostMainService, new SyncDescriptor(NativeHostMainService, undefined, false /* proxied to other processes */));

		// Metered Connection
		const meteredConnectionService = new MeteredConnectionMainService(this.configurationService);
		services.set(IMeteredConnectionService, meteredConnectionService);

		// Web Contents Extractor
		services.set(ITerminalSandboxService, new SyncDescriptor(NullTerminalSandboxService));
		services.set(IAgentNetworkFilterService, new SyncDescriptor(AgentNetworkFilterService, undefined, true));
		services.set(IWebContentExtractorService, new SyncDescriptor(NativeWebContentExtractorService, undefined, false /* proxied to other processes */));

		// Webview Manager
		services.set(IWebviewManagerService, new SyncDescriptor(WebviewMainService));

		// Menubar
		services.set(IMenubarMainService, new SyncDescriptor(MenubarMainService));

		// Extension Host Starter
		services.set(IExtensionHostStarter, new SyncDescriptor(ExtensionHostStarter));

		// Storage
		services.set(IStorageMainService, new SyncDescriptor(StorageMainService));
		services.set(IApplicationStorageMainService, new SyncDescriptor(ApplicationStorageMainService));

		// Terminal
		const ptyHostStarter = new ElectronPtyHostStarter({
			graceTime: LocalReconnectConstants.GraceTime,
			shortGraceTime: LocalReconnectConstants.ShortGraceTime,
			scrollback: this.configurationService.getValue<number>(TerminalSettingId.PersistentSessionScrollback) ?? 100
		}, this.configurationService, this.environmentMainService, this.lifecycleMainService, this.logService);
		const ptyHostService = new PtyHostService(
			ptyHostStarter,
			this.configurationService,
			this.logService,
			this.loggerService
		);
		services.set(ILocalPtyService, ptyHostService);

		// Agent Host
		if (this.configurationService.getValue(AgentHostEnabledSettingId)) {
			const agentHostStarter = new ElectronAgentHostStarter(this.configurationService, this.environmentMainService, this.lifecycleMainService, this.logService);
			this._register(new AgentHostProcessManager(agentHostStarter, this.logService, this.loggerService));
		}

		// External terminal
		if (isWindows) {
			services.set(IExternalTerminalMainService, new SyncDescriptor(WindowsExternalTerminalService));
		} else if (isMacintosh) {
			services.set(IExternalTerminalMainService, new SyncDescriptor(MacExternalTerminalService));
		} else if (isLinux) {
			services.set(IExternalTerminalMainService, new SyncDescriptor(LinuxExternalTerminalService));
		}
		services.set(ISandboxHelperMainService, new SyncDescriptor(SandboxHelperService));

		// Backups
		const backupMainService = new BackupMainService(this.environmentMainService, this.configurationService, this.logService, this.stateService);
		services.set(IBackupMainService, backupMainService);

		// Workspaces
		const workspacesManagementMainService = new WorkspacesManagementMainService(this.environmentMainService, this.logService, this.userDataProfilesMainService, backupMainService, dialogMainService);
		services.set(IWorkspacesManagementMainService, workspacesManagementMainService);
		services.set(IWorkspacesService, new SyncDescriptor(WorkspacesMainService, undefined, false /* proxied to other processes */));
		services.set(IWorkspacesHistoryMainService, new SyncDescriptor(WorkspacesHistoryMainService, undefined, false));

		// URL handling
		services.set(IURLService, new SyncDescriptor(NativeURLService, undefined, false /* proxied to other processes */));

		// Telemetry
		if (supportsTelemetry(this.productService, this.environmentMainService)) {
			const isInternal = isInternalTelemetry(this.productService, this.configurationService);
			const channel = getDelayedChannel(sharedProcessReady.then(client => client.getChannel('telemetryAppender')));
			const appender = new TelemetryAppenderClient(channel);
			const commonProperties = resolveCommonProperties(release(), hostname(), process.arch, this.productService.commit, this.productService.version, machineId, sqmId, devDeviceId, isInternal, this.productService.date, this.productService.telemetryAppName);
			const piiPaths = getPiiPathsFromEnvironment(this.environmentMainService);
			const config: ITelemetryServiceConfig = { appenders: [appender], commonProperties, piiPaths, sendErrorTelemetry: true };

			services.set(ITelemetryService, new SyncDescriptor(TelemetryService, [config], false));
		} else {
			services.set(ITelemetryService, NullTelemetryService);
		}

		// Default Extensions Profile Init
		services.set(IExtensionsProfileScannerService, new SyncDescriptor(ExtensionsProfileScannerService, undefined, true));
		services.set(IExtensionsScannerService, new SyncDescriptor(ExtensionsScannerService, undefined, true));

		// Utility Process Worker
		services.set(IUtilityProcessWorkerMainService, new SyncDescriptor(UtilityProcessWorkerMainService, undefined, true));

		// Proxy Auth
		services.set(IProxyAuthService, new SyncDescriptor(ProxyAuthService));

		// MCP
		services.set(INativeMcpDiscoveryHelperService, new SyncDescriptor(NativeMcpDiscoveryHelperService));
		services.set(IMcpGatewayService, new SyncDescriptor(McpGatewayService));

		// Dev Only: CSS service (for ESM)
		services.set(ICSSDevelopmentService, new SyncDescriptor(CSSDevelopmentService, undefined, true));

		// Init services that require it
		await Promises.settled([
			backupMainService.initialize(),
			workspacesManagementMainService.initialize()
		]);

		return this.mainInstantiationService.createChild(services);
	}

	private initChannels(accessor: ServicesAccessor, mainProcessElectronServer: ElectronIPCServer, sharedProcessClient: Promise<MessagePortClient>): void {

		// Channels registered to node.js are exposed to second instances
		// launching because that is the only way the second instance
		// can talk to the first instance. Electron IPC does not work
		// across apps until `requestSingleInstance` APIs are adopted.

		const disposables = this._register(new DisposableStore());

		const launchChannel = ProxyChannel.fromService(accessor.get(ILaunchMainService), disposables, { disableMarshalling: true });
		this.mainProcessNodeIpcServer.registerChannel('launch', launchChannel);

		const diagnosticsChannel = ProxyChannel.fromService(accessor.get(IDiagnosticsMainService), disposables, { disableMarshalling: true });
		this.mainProcessNodeIpcServer.registerChannel('diagnostics', diagnosticsChannel);

		// Policies (main & shared process)
		const policyChannel = disposables.add(new PolicyChannel(accessor.get(IPolicyService)));
		mainProcessElectronServer.registerChannel('policy', policyChannel);
		sharedProcessClient.then(client => client.registerChannel('policy', policyChannel));

		// Local Files
		const diskFileSystemProvider = this.fileService.getProvider(Schemas.file);
		assertType(diskFileSystemProvider instanceof DiskFileSystemProvider);
		const fileSystemProviderChannel = disposables.add(new DiskFileSystemProviderChannel(diskFileSystemProvider, this.logService, this.environmentMainService));
		mainProcessElectronServer.registerChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME, fileSystemProviderChannel);
		sharedProcessClient.then(client => client.registerChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME, fileSystemProviderChannel));

		// User Data Profiles
		const userDataProfilesService = ProxyChannel.fromService(accessor.get(IUserDataProfilesMainService), disposables);
		mainProcessElectronServer.registerChannel('userDataProfiles', userDataProfilesService);
		sharedProcessClient.then(client => client.registerChannel('userDataProfiles', userDataProfilesService));

		// Initialize cross-app IPC on supported platforms so all consumers
		// (update coordination, secret sharing, etc.) share one connection.
		const crossAppIPCService = accessor.get(ICrossAppIPCService);
		if (isMacintosh || isWindows) {
			crossAppIPCService.initialize();
		}

		// Update (with cross-app coordination on macOS/Windows where crossAppIPC is available)
		const localUpdateService = accessor.get(IUpdateService);
		let effectiveUpdateService: IUpdateService = localUpdateService;
		const isInsiderOrExploration = this.productService.quality === 'insider' || this.productService.quality === 'exploration';
		if ((isMacintosh || isWindows) && isInsiderOrExploration) {
			const updateCoordinator = this._register(new CrossAppUpdateCoordinator(
				localUpdateService as AbstractUpdateService,
				this.logService,
				this.lifecycleMainService,
				crossAppIPCService,
			));
			effectiveUpdateService = updateCoordinator;
		}
		const updateChannel = new UpdateChannel(effectiveUpdateService);
		mainProcessElectronServer.registerChannel('update', updateChannel);

		// Show a native "no updates available" dialog from the focused app's main
		// process to avoid double dialogs across apps and ensure a native dialog.
		this._register(new NotAvailableUpdateDialog(effectiveUpdateService, accessor.get(IDialogMainService)));

		// Cross-app secret sharing (macOS only, demand-driven)
		if (isMacintosh) {
			this._register(new MacOSCrossAppSecretSharing(
				accessor.get(IStorageMainService),
				accessor.get(IEncryptionMainService),
				accessor.get(IStateService),
				this.logService,
				this.environmentMainService,
				accessor.get(ILaunchMainService),
				this.lifecycleMainService,
				crossAppIPCService,
			));
		}

		// Metered Connection
		const meteredConnectionChannel = new MeteredConnectionChannel(accessor.get(IMeteredConnectionService) as MeteredConnectionMainService);
		mainProcessElectronServer.registerChannel(METERED_CONNECTION_CHANNEL, meteredConnectionChannel);
		sharedProcessClient.then(client => client.registerChannel(METERED_CONNECTION_CHANNEL, meteredConnectionChannel));

		// Process
		const processChannel = ProxyChannel.fromService(new ProcessMainService(this.logService, accessor.get(IDiagnosticsService), accessor.get(IDiagnosticsMainService)), disposables);
		mainProcessElectronServer.registerChannel('process', processChannel);

		// Encryption
		const encryptionChannel = ProxyChannel.fromService(accessor.get(IEncryptionMainService), disposables);
		mainProcessElectronServer.registerChannel('encryption', encryptionChannel);

		// Browser View
		const browserViewChannel = ProxyChannel.fromService(accessor.get(IBrowserViewMainService), disposables);
		mainProcessElectronServer.registerChannel(ipcBrowserViewChannelName, browserViewChannel);
		sharedProcessClient.then(client => client.registerChannel(ipcBrowserViewChannelName, browserViewChannel));

		// Browser View Group
		const browserViewGroupChannel = ProxyChannel.fromService(accessor.get(IBrowserViewGroupMainService), disposables);
		mainProcessElectronServer.registerChannel(ipcBrowserViewGroupChannelName, browserViewGroupChannel);
		sharedProcessClient.then(client => client.registerChannel(ipcBrowserViewGroupChannelName, browserViewGroupChannel));

		// Signing
		const signChannel = ProxyChannel.fromService(accessor.get(ISignService), disposables);
		mainProcessElectronServer.registerChannel('sign', signChannel);

		// Keyboard Layout
		const keyboardLayoutChannel = ProxyChannel.fromService(accessor.get(IKeyboardLayoutMainService), disposables);
		mainProcessElectronServer.registerChannel('keyboardLayout', keyboardLayoutChannel);

		// Native host (main & shared process)
		this.nativeHostMainService = accessor.get(INativeHostMainService);
		const nativeHostChannel = ProxyChannel.fromService(this.nativeHostMainService, disposables);
		mainProcessElectronServer.registerChannel('nativeHost', nativeHostChannel);
		sharedProcessClient.then(client => client.registerChannel('nativeHost', nativeHostChannel));

		// Web Content Extractor
		const webContentExtractorChannel = ProxyChannel.fromService(accessor.get(IWebContentExtractorService), disposables);
		mainProcessElectronServer.registerChannel('webContentExtractor', webContentExtractorChannel);

		// Workspaces
		const workspacesChannel = ProxyChannel.fromService(accessor.get(IWorkspacesService), disposables);
		mainProcessElectronServer.registerChannel('workspaces', workspacesChannel);

		// Menubar
		const menubarChannel = ProxyChannel.fromService(accessor.get(IMenubarMainService), disposables);
		mainProcessElectronServer.registerChannel('menubar', menubarChannel);

		// URL handling
		const urlChannel = ProxyChannel.fromService(accessor.get(IURLService), disposables);
		mainProcessElectronServer.registerChannel('url', urlChannel);

		// Webview Manager
		const webviewChannel = ProxyChannel.fromService(accessor.get(IWebviewManagerService), disposables);
		mainProcessElectronServer.registerChannel('webview', webviewChannel);

		// Storage (main & shared process)
		const storageChannel = disposables.add((new StorageDatabaseChannel(this.logService, accessor.get(IStorageMainService))));
		mainProcessElectronServer.registerChannel('storage', storageChannel);
		sharedProcessClient.then(client => client.registerChannel('storage', storageChannel));

		// Profile Storage Changes Listener (shared process)
		const profileStorageListener = disposables.add((new ProfileStorageChangesListenerChannel(accessor.get(IStorageMainService), accessor.get(IUserDataProfilesMainService), this.logService)));
		sharedProcessClient.then(client => client.registerChannel('profileStorageListener', profileStorageListener));

		// Terminal
		const ptyHostChannel = ProxyChannel.fromService(accessor.get(ILocalPtyService), disposables);
		mainProcessElectronServer.registerChannel(TerminalIpcChannels.LocalPty, ptyHostChannel);

		// External Terminal
		const externalTerminalChannel = ProxyChannel.fromService(accessor.get(IExternalTerminalMainService), disposables);
		mainProcessElectronServer.registerChannel('externalTerminal', externalTerminalChannel);

		// Sandbox Helper
		const sandboxHelperChannel = ProxyChannel.fromService(accessor.get(ISandboxHelperMainService), disposables);
		mainProcessElectronServer.registerChannel('sandboxHelper', sandboxHelperChannel);

		// MCP
		const mcpDiscoveryChannel = ProxyChannel.fromService(accessor.get(INativeMcpDiscoveryHelperService), disposables);
		mainProcessElectronServer.registerChannel(NativeMcpDiscoveryHelperChannelName, mcpDiscoveryChannel);
		const mcpGatewayChannel = this._register(new McpGatewayChannel(mainProcessElectronServer, accessor.get(IMcpGatewayService), accessor.get(ILoggerMainService)));
		mainProcessElectronServer.registerChannel(McpGatewayChannelName, mcpGatewayChannel);

		// AgentStudio LLM：把 chat 流式网络调用委派到主进程（对齐 Void void-channel-llmMessage）
		const llmChannel = new LlmMainChannel(accessor.get(ILoggerService));
		mainProcessElectronServer.registerChannel(VSSAROS_LLM_CHANNEL, llmChannel);

		// AgentStudio Codebase Graph：把图存储（SQLite mmap，根治 V8 4GB）宿主在主进程，
		// renderer 经 ProxyChannel 代理访问。DB 落 ${userDataPath}/codebase-graph/graph.db。
		const graphStoreChannel = new CodebaseGraphStoreChannel(
			join(this.environmentMainService.userDataPath, 'codebase-graph', 'graph.db'),
			accessor.get(ILoggerService),
		);
		mainProcessElectronServer.registerChannel(CODEBASE_GRAPH_STORE_CHANNEL, graphStoreChannel);
		// ★ 2026-09-19（实测：1.5GB 图谱库中 503.9MB≈33% 是 freelist 死页）：**显式维护入口**。
		// 为什么做成"手动 + 主进程全局函数"而不是自动：
		//   · 全量 `VACUUM` 会阻塞主线程数秒~数十秒（1-2GB 库），**绝不能**放进启动/索引路径
		//     —— 那正是本次在排查的"卡死"形态；
		//   · 需要用户/运维在方便时触发（例如刚删掉一个不再需要的大项目之后）。
		// 用法（主进程 devtools / CDP `Runtime.evaluate`）：`await __SAROSIS_GRAPH_RECLAIM()`
		//   `__SAROSIS_GRAPH_RECLAIM({ force: true })` 可无视 64MB 阈值强制跑一次。
		(globalThis as unknown as Record<string, unknown>)['__SAROSIS_GRAPH_RECLAIM'] = async (
			opts?: { force?: boolean; migrateToIncremental?: boolean },
		) => {
			const logger = accessor.get(ILoggerService).getLogger('codebase-graph');
			const t0 = Date.now();
			logger?.info(`[graph-maintain] reclaimSpace 开始（VACUUM 会阻塞主线程，用时取决于库大小）…`);
			try {
				const stats = await graphStoreChannel.call(undefined as never, 'reclaimSpace', [opts]);
				logger?.info(`[graph-maintain] 完成：${JSON.stringify(stats)}（耗时 ${Date.now() - t0}ms）`);
				return stats;
			} catch (err) {
				logger?.error(`[graph-maintain] 失败：${(err as Error)?.message ?? String(err)}（耗时 ${Date.now() - t0}ms）`);
				throw err;
			}
		};

		// ★ 2026-09-19（P2-1 Step 3）：**这里曾注册过「图谱索引通道」宿主，现已移除** ✗。
		// 原因：索引编排要跑在 **utility process**，而 main 侧的 `createWorker` 是「服务某个窗口请求的
		// **服务端**」（参数含 `reply.windowId`、返回值只有终止信息，**不提供 client channel** ✗）
		// ⇒ 「renderer → main → main 委托 worker」这条路走不通（曾被定为方案 A，读实现后否定）。
		// 现行形态：**renderer 自己起索引进程** ✓ —— `utilityProcessWorkerWorkbenchService.createWorker(...)`
		// （见 `sessions/contrib/agentStudio/browser/codebaseGraphIndexProxy.ts` 与契约 header 的「方案 B」）。
		// ⚠ 不要因为「图**存储**通道是在这里注册的」就顺手把索引通道也加回来 ——
		//   那等于把 CPU 密集的索引编排放回**窗口管理与 IPC 共享的**主进程，会冻结主进程 ✗✗。

		// AgentStudio KB：全文检索存储宿主在主进程（FTS5，根治大库 OOM）。
		const kbStoreChannel = new KbSqliteStoreChannel(
			join(this.environmentMainService.userDataPath, 'kb-sqlite', 'kb.db'),
			accessor.get(ILoggerService),
		);
		mainProcessElectronServer.registerChannel(KB_SQLITE_STORE_CHANNEL, kbStoreChannel);

		// AgentStudio 版本管理：isomorphic-git + fs 宿主在主进程。
		// renderer 为 Chromium 沙箱（无 Node require，preload require 亦为受限 polyfill），
		// 无法加载 fs/isomorphic-git，故 agent/skill/workflow/kb 的 git 操作全部经此 channel 代理。
		const gitVersionChannel = this._register(new GitVersionChannel());
		mainProcessElectronServer.registerChannel(GIT_VERSION_CHANNEL, gitVersionChannel);

		// AgentStudio 媒体资产库（生成图片管理，P1）：文件 + SQLite 元数据宿主在主进程，
		// renderer 经 ProxyChannel 代理（browser/mediaStoreProxy.ts）。DB/文件落
		// ${userDataPath}/media/（dev 为 ~/.vssaros-dev/media）。
		const mediaStoreChannel = new MediaStoreChannel(
			join(this.environmentMainService.userDataPath, 'media'),
			join(this.environmentMainService.userDataPath, 'media-store-config.json'),
			accessor.get(ILoggerService),
		);
		mainProcessElectronServer.registerChannel(MEDIA_STORE_CHANNEL, mediaStoreChannel);

		// 子代理内核进程档（P1）：utilityProcess 隔离体的 fork/转发宿主。
		// 通道只搬消息字节；工具执行/审批/凭证全在 renderer 真宿主（内核 RPC 回源）。
		const subAgentKernelProcChannel = new SubAgentKernelProcChannel(this.logService);
		mainProcessElectronServer.registerChannel(SUBAGENT_KERNEL_PROC_CHANNEL, subAgentKernelProcChannel);


		// Logger
		const loggerChannel = new LoggerChannel(accessor.get(ILoggerMainService),);
		mainProcessElectronServer.registerChannel('logger', loggerChannel);
		sharedProcessClient.then(client => client.registerChannel('logger', loggerChannel));

		// Extension Host Debug Broadcasting
		const electronExtensionHostDebugBroadcastChannel = new ElectronExtensionHostDebugBroadcastChannel(accessor.get(IWindowsMainService));
		mainProcessElectronServer.registerChannel('extensionhostdebugservice', electronExtensionHostDebugBroadcastChannel);

		// Extension Host Starter
		const extensionHostStarterChannel = ProxyChannel.fromService(accessor.get(IExtensionHostStarter), disposables);
		mainProcessElectronServer.registerChannel(ipcExtensionHostStarterChannelName, extensionHostStarterChannel);

		// Utility Process Worker
		const utilityProcessWorkerChannel = ProxyChannel.fromService(accessor.get(IUtilityProcessWorkerMainService), disposables);
		mainProcessElectronServer.registerChannel(ipcUtilityProcessWorkerChannelName, utilityProcessWorkerChannel);
	}

	private async openFirstWindow(accessor: ServicesAccessor, initialProtocolUrls: IInitialProtocolUrls | undefined): Promise<ICodeWindow[]> {
		const windowsMainService = this.windowsMainService = accessor.get(IWindowsMainService);
		this.auxiliaryWindowsMainService = accessor.get(IAuxiliaryWindowsMainService);

		const context = isLaunchedFromCli(process.env) ? OpenContext.CLI : OpenContext.DESKTOP;
		const args = this.environmentMainService.args;

		// If launched solely for cross-app secret sharing, don't open any windows
		if (args['share-secrets-with-agents-app']) {
			const hasOtherArgs = args._.length > 0 || args['folder-uri'] || args['file-uri'];
			if (!hasOtherArgs) {
				return [];
			}
		}

		// Handle agents window first based on context
		if ((process as INodeProcess).isEmbeddedApp || (args['agents'] && this.productService.quality !== 'stable')) {
			return windowsMainService.openAgentsWindow({
				context,
				cli: args,
				initialStartup: true
			});
		}

		// Then check for windows from protocol links to open
		if (initialProtocolUrls) {

			// Openables can open as windows directly
			if (initialProtocolUrls.openables.length > 0) {
				return windowsMainService.open({
					context,
					cli: args,
					urisToOpen: initialProtocolUrls.openables,
					gotoLineMode: true,
					initialStartup: true
					// remoteAuthority: will be determined based on openables
				});
			}

			// Protocol links with `windowId=_blank` on startup
			// should be handled in a special way:
			// We take the first one of these and open an empty
			// window for it. This ensures we are not restoring
			// all windows of the previous session.
			// If there are any more URLs like these, they will
			// be handled from the URL listeners installed later.

			if (initialProtocolUrls.urls.length > 0) {
				for (const protocolUrl of initialProtocolUrls.urls) {
					const params = new URLSearchParams(protocolUrl.uri.query);
					if (params.get('windowId') === '_blank') {

						// It is important here that we remove `windowId=_blank` from
						// this URL because here we open an empty window for it.

						params.delete('windowId');
						protocolUrl.originalUrl = protocolUrl.uri.toString(true);
						protocolUrl.uri = protocolUrl.uri.with({ query: params.toString() });

						return windowsMainService.open({
							context,
							cli: args,
							forceNewWindow: true,
							forceEmpty: true,
							gotoLineMode: true,
							initialStartup: true
							// remoteAuthority: will be determined based on openables
						});
					}
				}
			}
		}

		const macOpenFiles: string[] = (global as { macOpenFiles?: string[] }).macOpenFiles ?? [];
		const hasCliArgs = args._.length;
		const hasFolderURIs = !!args['folder-uri'];
		const hasFileURIs = !!args['file-uri'];
		const noRecentEntry = args['skip-add-to-recently-opened'] === true;
		const waitMarkerFileURI = args.wait && args.waitMarkerFilePath ? URI.file(args.waitMarkerFilePath) : undefined;
		const remoteAuthority = args.remote || undefined;
		const forceProfile = args.profile;
		const forceTempProfile = args['profile-temp'];

		// Started without file/folder arguments
		if (!hasCliArgs && !hasFolderURIs && !hasFileURIs) {

			// Force new window
			if (args['new-window'] || forceProfile || forceTempProfile) {
				return windowsMainService.open({
					context,
					cli: args,
					forceNewWindow: true,
					forceEmpty: true,
					noRecentEntry,
					waitMarkerFileURI,
					initialStartup: true,
					remoteAuthority,
					forceProfile,
					forceTempProfile
				});
			}

			// mac: open-file event received on startup
			if (macOpenFiles.length) {
				return windowsMainService.open({
					context: OpenContext.DOCK,
					cli: args,
					urisToOpen: macOpenFiles.map(path => {
						path = normalizeNFC(path); // macOS only: normalize paths to NFC form

						return (hasWorkspaceFileExtension(path) ? { workspaceUri: URI.file(path) } : { fileUri: URI.file(path) });
					}),
					noRecentEntry,
					waitMarkerFileURI,
					initialStartup: true,
					// remoteAuthority: will be determined based on macOpenFiles
				});
			}
		}

		// default: read paths from cli
		return windowsMainService.open({
			context,
			cli: args,
			forceNewWindow: args['new-window'],
			diffMode: args.diff,
			mergeMode: args.merge,
			noRecentEntry,
			waitMarkerFileURI,
			gotoLineMode: args.goto,
			initialStartup: true,
			remoteAuthority,
			forceProfile,
			forceTempProfile
		});
	}

	private afterWindowOpen(instantiationService: IInstantiationService): void {

		// Accurate Windows version info
		if (isWindows) {
			initWindowsVersionInfo();
		}

		// Windows: mutex
		this.installMutex();

		// Remote Authorities
		protocol.registerHttpProtocol(Schemas.vscodeRemoteResource, (request, callback) => {
			callback({
				url: request.url.replace(/^vscode-remote-resource:/, 'http:'),
				method: request.method
			});
		});

		// Start to fetch shell environment (if needed) after window has opened
		// Since this operation can take a long time, we want to warm it up while
		// the window is opening.
		// We also show an error to the user in case this fails.
		this.resolveShellEnvironment(this.environmentMainService.args, process.env, true);

		// Crash reporter
		this.updateCrashReporterEnablement();

		// macOS: rosetta translation warning
		if (isMacintosh && app.runningUnderARM64Translation) {
			this.windowsMainService?.sendToFocused('vscode:showTranslatedBuildWarning');
		}

		// Power telemetry
		instantiationService.invokeFunction(accessor => {
			const telemetryService = accessor.get(ITelemetryService);

			type PowerEvent = {
				readonly idleState: string;
				readonly idleTime: number;
				readonly thermalState: string;
				readonly onBattery: boolean;
			};
			type PowerEventClassification = {
				idleState: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The system idle state (active, idle, locked, unknown).' };
				idleTime: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'The system idle time in seconds.' };
				thermalState: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The system thermal state (unknown, nominal, fair, serious, critical).' };
				onBattery: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'Whether the system is running on battery power.' };
				owner: 'chrmarti';
				comment: 'Tracks OS power suspend and resume events for reliability insights.';
			};

			const getPowerEventData = (): PowerEvent => ({
				idleState: powerMonitor.getSystemIdleState(60),
				idleTime: powerMonitor.getSystemIdleTime(),
				thermalState: powerMonitor.getCurrentThermalState(),
				onBattery: powerMonitor.isOnBatteryPower()
			});

			this._register(Event.fromNodeEventEmitter(powerMonitor, 'suspend')(() => {
				telemetryService.publicLog2<PowerEvent, PowerEventClassification>('power.suspend', getPowerEventData());
			}));

			this._register(Event.fromNodeEventEmitter(powerMonitor, 'resume')(() => {
				telemetryService.publicLog2<PowerEvent, PowerEventClassification>('power.resume', getPowerEventData());
			}));
		});

		// GPU crash telemetry for skia graphite out of order recording failures
		// Refs https://github.com/microsoft/vscode/issues/284162
		if (isMacintosh) {
			instantiationService.invokeFunction(accessor => {
				const telemetryService = accessor.get(ITelemetryService);
				type GPUFeatureStatusWithSkiaGraphite = GPUFeatureStatus & {
					skia_graphite: string;
				};
				const initialGpuFeatureStatus = app.getGPUFeatureStatus() as GPUFeatureStatusWithSkiaGraphite;
				const skiaGraphiteEnabled: string = initialGpuFeatureStatus['skia_graphite'];
				if (skiaGraphiteEnabled === 'enabled') {
					const gpuInfoUpdate = Event.fromNodeEventEmitter(app, 'gpu-info-update');
					const pendingGpuInfoListener = this._register(new MutableDisposable());
					this._register(Event.fromNodeEventEmitter<{ details: Details }>(app, 'child-process-gone', (event, details) => ({ event, details }))(({ details }) => {
						if (details.type === 'GPU' && details.reason === 'crashed') {
							// Wait for gpu-info-update which fires after the GPU process
							// restarts and the feature status is refreshed. At the time
							// child-process-gone fires, getGPUFeatureStatus() still
							// returns the pre-crash status.
							pendingGpuInfoListener.value = Event.once(gpuInfoUpdate)(() => {
								const currentGpuFeatureStatus = app.getGPUFeatureStatus();
								const currentRasterizationStatus: string = currentGpuFeatureStatus['rasterization'];
								if (currentRasterizationStatus !== 'enabled') {
									// Get last 10 GPU log messages (only the message field)
									let gpuLogMessages: string[] = [];
									type AppWithGPULogMethod = typeof app & {
										getGPULogMessages(): IGPULogMessage[];
									};
									const customApp = app as AppWithGPULogMethod;
									if (typeof customApp.getGPULogMessages === 'function') {
										gpuLogMessages = customApp.getGPULogMessages().slice(-10).map(log => log.message);
									}

									type GpuCrashEvent = {
										readonly gpuFeatureStatus: string;
										readonly gpuLogMessages: string;
									};
									type GpuCrashClassification = {
										gpuFeatureStatus: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'Current GPU feature status.' };
										gpuLogMessages: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'Last 10 GPU log messages collected after the crash and GPU process restart.' };
										owner: 'deepak1556';
										comment: 'Tracks GPU process crashes that would result in fallback mode.';
									};

									telemetryService.publicLog2<GpuCrashEvent, GpuCrashClassification>('gpu.crash.fallback', {
										gpuFeatureStatus: JSON.stringify(currentGpuFeatureStatus),
										gpuLogMessages: JSON.stringify(gpuLogMessages)
									});
								}
							});
						}
					}));
				}
			});
		}

		{
			interface NetworkProcessLaunchedDetails {
				readonly pid: number;
			}
			interface NetworkProcessGoneDetails {
				readonly pid: number;
				readonly exitCode: number;
				readonly crashed: boolean;
				readonly crashedPreIPC: boolean;
			}

			type AppWithNetworkProcessEvents = typeof app & {
				on(event: 'network-process-launched', listener: (event: Electron.Event, details: NetworkProcessLaunchedDetails) => void): typeof app;
				on(event: 'network-process-gone', listener: (event: Electron.Event, details: NetworkProcessGoneDetails) => void): typeof app;
			};

			const customApp = app as AppWithNetworkProcessEvents;

			instantiationService.invokeFunction(accessor => {
				const telemetryService = accessor.get(ITelemetryService);

				type NetworkProcessLaunchedClassification = {
					owner: 'deepak1556';
					comment: 'Tracks network process launch events.';
				};

				type NetworkProcessGoneClassification = {
					exitCode: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'The exit code of the network process.' };
					crashed: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'Whether the network process crashed.' };
					crashedPreIPC: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'Whether the network process crashed before IPC was established.' };
					owner: 'deepak1556';
					comment: 'Tracks network process gone events for reliability insights.';
				};

				this._register(Event.fromNodeEventEmitter<NetworkProcessLaunchedDetails>(customApp, 'network-process-launched', (_event, details) => details)(details => {
					this.logService.info(`[network process] launched with pid ${details.pid}`);

					telemetryService.publicLog2<{}, NetworkProcessLaunchedClassification>('networkProcess.launched', {});
				}));

				this._register(Event.fromNodeEventEmitter<NetworkProcessGoneDetails>(customApp, 'network-process-gone', (_event, details) => details)(details => {
					this.logService.info(`[network process] gone - pid: ${details.pid}, exitCode: ${details.exitCode}, crashed: ${details.crashed}, crashedPreIPC: ${details.crashedPreIPC}`);

					telemetryService.publicLog2<{ exitCode: number; crashed: boolean; crashedPreIPC: boolean }, NetworkProcessGoneClassification>('networkProcess.gone', {
						exitCode: details.exitCode,
						crashed: details.crashed,
						crashedPreIPC: details.crashedPreIPC
					});
				}));
			});
		}

		// Agents app: write a marker into the host VS Code's user-data dir so
		// that, after a future update which removes the sub-application, the
		// host VS Code can detect that the Agents app was running and restore
		// the appropriate windows on next launch.
		if ((process as INodeProcess).isEmbeddedApp) {
			const hostUserRoamingDataHome = this.environmentMainService.parentAppUserRoamingDataHome;
			if (hostUserRoamingDataHome) {
				this._register(instantiationService.createInstance(AgentsLastRunningTracker, hostUserRoamingDataHome));
			}
		}
	}

	private async installMutex(): Promise<void> {
		const win32MutexName = this.productService.win32MutexName;
		if (isWindows && win32MutexName) {
			try {
				const WindowsMutex = await import('@vscode/windows-mutex');
				const mutex = new WindowsMutex.Mutex(win32MutexName);
				Event.once(this.lifecycleMainService.onWillShutdown)(() => mutex.release());
			} catch (error) {
				this.logService.error(error);
			}
		}
	}

	private async resolveShellEnvironment(args: NativeParsedArgs, env: IProcessEnvironment, notifyOnError: boolean): Promise<typeof process.env> {
		try {
			return await getResolvedShellEnv(this.configurationService, this.logService, args, env);
		} catch (error) {
			const errorMessage = toErrorMessage(error);
			if (notifyOnError) {
				this.windowsMainService?.sendToFocused('vscode:showResolveShellEnvError', errorMessage);
			} else {
				this.logService.error(errorMessage);
			}
		}

		return {};
	}

	private async updateCrashReporterEnablement(): Promise<void> {

		// If enable-crash-reporter argv is undefined then this is a fresh start,
		// based on `telemetry.enableCrashreporter` settings, generate a UUID which
		// will be used as crash reporter id and also update the json file.

		try {
			const argvContent = await this.fileService.readFile(this.environmentMainService.argvResource);
			const argvString = argvContent.value.toString();
			const argvJSON = parse<{ 'enable-crash-reporter'?: boolean }>(argvString);
			const telemetryLevel = getTelemetryLevel(this.configurationService);
			const enableCrashReporter = telemetryLevel >= TelemetryLevel.CRASH;

			// Initial startup
			if (argvJSON['enable-crash-reporter'] === undefined) {
				const additionalArgvContent = [
					'',
					'	// Allows to disable crash reporting.',
					'	// Should restart the app if the value is changed.',
					`	"enable-crash-reporter": ${enableCrashReporter},`,
					'',
					'	// Unique id used for correlating crash reports sent from this instance.',
					'	// Do not edit this value.',
					`	"crash-reporter-id": "${generateUuid()}"`,
					'}'
				];
				const newArgvString = argvString.substring(0, argvString.length - 2).concat(',\n', additionalArgvContent.join('\n'));

				await this.fileService.writeFile(this.environmentMainService.argvResource, VSBuffer.fromString(newArgvString));
			}

			// Subsequent startup: update crash reporter value if changed
			else {
				const newArgvString = argvString.replace(/"enable-crash-reporter": .*,/, `"enable-crash-reporter": ${enableCrashReporter},`);
				if (newArgvString !== argvString) {
					await this.fileService.writeFile(this.environmentMainService.argvResource, VSBuffer.fromString(newArgvString));
				}
			}
		} catch (error) {
			this.logService.error(error);

			// Inform the user via notification
			this.windowsMainService?.sendToFocused('vscode:showArgvParseWarning');
		}
	}

	private eventuallyAfterWindowOpen(): void {

		// Validate Device ID is up to date (delay this as it has shown significant perf impact)
		// Refs: https://github.com/microsoft/vscode/issues/234064
		validateDevDeviceId(this.stateService, this.logService);

		// macOS: eagerly register the embedded app with Launch Services
		this.registerEmbeddedAppWithLaunchServices();

		// 启动 agentmemory 内嵌网关子进程（新记忆框架）。
		// agentmemory server 监听 127.0.0.1:3111，提供 BM25+Vector+Graph 混合搜索。
		this.startAgentMemoryGateway();
	}

	private registerEmbeddedAppWithLaunchServices(): void {
		if (!isMacintosh || (process as INodeProcess).isEmbeddedApp || !this.productService.embedded?.nameShort || this.productService.quality === 'stable') {
			return;
		}

		const stateKey = 'launchServices.registeredEmbeddedApp';
		const currentVersion = this.productService.version;
		if (this.stateService.getItem<string>(stateKey) === currentVersion) {
			this.logService.trace('Embedded app already registered with Launch Services for this version, skipping.');
			return;
		}

		// appRoot points to Contents/Resources/app on macOS
		const embeddedAppPath = join(this.environmentMainService.appRoot, '..', '..', 'Applications', `${this.productService.embedded.nameLong}.app`);
		const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
		this.logService.trace('Registering embedded app with Launch Services:', embeddedAppPath);
		const child = execFile(lsregister, ['-f', embeddedAppPath], { timeout: 30_000 }, (error) => {
			if (error) {
				this.logService.error('Failed to register embedded app with Launch Services:', error.message);
			} else {
				this.stateService.setItem(stateKey, currentVersion);
			}
		});
		child.unref();
	}

	/**
	 * 启动 agentmemory 轻量文件服务器子进程。
	 *
	 * 这不是 agentmemory + iii-engine，而是一个 ~60 行的 Node.js HTTP 文件服务器，
	 * 仅提供 JSONL 文件的原子读写。所有智能算法（BM25、Vector、RRF、衰减、
	 * 隐私过滤）在 renderer 进程内运行，无需外部 exe 或 npm 包。
	 *
	 * 零外部依赖：
	 *   - 无 iii-engine（Rust 二进制）
	 *   - 无 agentmemory npm 包
	 *   - 无 Docker
	 */

	/**
	 * 启动 agentmemory 轻量文件服务器子进程。
	 *
	 * 这不是 agentmemory + iii-engine，而是一个 ~60 行的 Node.js HTTP 文件服务器，
	 * 仅提供 JSONL 文件的原子读写。所有智能算法（BM25、Vector、RRF、衰减、
	 * 隐私过滤）在 renderer 进程内运行，无需外部 exe 或 npm 包。
	 *
	 * 零外部依赖：
	 *   - 无 iii-engine（Rust 二进制）
	 *   - 无 agentmemory npm 包
	 *   - 无 Docker
	 *   - 用户完全无感（自动启动，无安装步骤）
	 *
	 * 端点：
	 *   GET  /mem/<agentId>/<file>  → 读取 JSONL
	 *   PUT  /mem/<agentId>/<file>  → 原子写入 JSONL
	 *   GET  /health                → 健康检查
	 *
	 * 容错：
	 *   - host.mjs 找不到时只记录 warning，不阻塞 saros 启动（降级到内存模式）
	 *   - 子进程异常退出时记录 error，不影响其他功能
	 *   - saros 退出时通过 SIGTERM 触发优雅关闭
	 */
	private startAgentMemoryGateway(): void {
		try {
			const appRoot = this.environmentMainService.appRoot;

			// 候选 host 路径（开发模式 vs 打包后）
			const hostCandidates = [
				join(appRoot, 'extensions', 'agentmemory-gateway', 'host', 'host.mjs'),
				join(appRoot, '..', 'extensions', 'agentmemory-gateway', 'host', 'host.mjs'),
				join(process.resourcesPath ?? appRoot, 'app', 'extensions', 'agentmemory-gateway', 'host', 'host.mjs'),
			];

			let hostPath: string | undefined;
			for (const candidate of hostCandidates) {
				if (existsSync(candidate)) {
					hostPath = candidate;
					break;
				}
			}

			if (!hostPath) {
				this.logService.warn('[agentmemory-gateway] host.mjs 未找到，跳过启动（将降级到内存模式）。已尝试: ' + hostCandidates.join(' | '));
				return;
			}

			// 端口全局唯一，而「dev 版（~/.vssaros-dev）」与「安装版（~/.vssaros）」是两个独立
			// app 形态、各有一份数据目录 —— 同时运行时后启动的一方必然 EADDRINUSE 崩溃
			// （2026-09-16 实测：dev 网关启动 2.9s 后 exit code=1，stderr = listen EADDRINUSE，
			// 此后该窗口永无自有网关，只能静默连上对方的网关 ⇒ 记忆跨环境串味）。
			// ⇒ 无条件先探活：
			//   · 可达且 dataDir 相同 → 复用（同形态多窗口）
			//   · 可达但 dataDir 不同 → 复用 + **显式警告**（不再静默）
			//   · 不可达 → spawn 自己的
			void this._probeOrSpawnAgentMemoryGateway(hostPath);

			// 退出时清掉自愈计时器，避免 shutdown 过程中又拉起一个网关子进程
			this._register(this.lifecycleMainService.onWillShutdown(() => this._stopAgentMemoryGatewayRetry()));
		} catch (err) {
			this.logService.error(`[agentmemory-gateway] 启动逻辑异常（已忽略）: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** 探活本进程端口：已被占用则复用既有网关（并校验数据目录是否一致），否则 spawn 自己的。 */
	private async _probeOrSpawnAgentMemoryGateway(hostPath: string): Promise<void> {
		const port = process.env['AGENTMEMORY_PORT'] ?? '3111';
		const localDataDir = process.env['AGENTMEMORY_DATA_DIR'] ?? join(this.environmentMainService.userDataPath, '.agentmemory');
		try {
			const res = await net.fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
			if (res.ok) {
				let remoteDataDir: string | undefined;
				try { remoteDataDir = ((await res.json()) as { dataDir?: string })?.dataDir; } catch { /* 旧版网关无 json body */ }
				const same = remoteDataDir !== undefined && this._isSamePath(remoteDataDir, localDataDir);
				if (remoteDataDir !== undefined && !same) {
					// 多开同形态（多个 --user-data-dir 但端口相同）时，后启者会撞上先启者的网关。
					// 旧实现在此「复用远端网关」⇒ 两个实例的记忆读写落到**同一份 dataDir**，
					// 正是端口隔离要防的串味。改为不复用：交给 spawn，由派生端口起自己的网关。
					this.logService.warn(
						`[agentmemory-gateway] 端口 ${port} 已被**其他数据目录**的网关占用：远端 dataDir=${remoteDataDir}，本窗口 dataDir=${localDataDir}。`
						+ '本窗口不复用该网关（避免记忆串库），将改用自己的端口重新拉起。'
					);
					this._spawnAgentMemoryGateway(hostPath);
					return;
				} else {
					this.logService.info(`[agentmemory-gateway] 端口 ${port} 已被占用（dataDir=${remoteDataDir ?? '未知'}），复用既有网关`);
				}
				this._agentMemoryGatewayRetryCount = 0; // 已有可用网关 ⇒ 自愈计数归零
				return;
			}
		} catch { /* 探活失败 → 端口空闲，继续 spawn */ }
		this._spawnAgentMemoryGateway(hostPath);
	}

	/**
	 * 确定本进程的 agentmemory 网关端口，并把结果**注入渲染侧**（2026-09-16 用户裁决）。
	 *
	 * 规则（两侧必须一致；渲染侧见 `extensions/agentmemory-memory/src/serverConfig.ts`）：
	 *   · 安装版 → 3111（保持既有行为不变，零迁移）
	 *   · dev    → 3112
	 *   · `AGENTMEMORY_PORT` 显式设置时优先
	 *
	 * 注入通道：`process.env.AGENTMEMORY_URL` —— 渲染进程继承主进程环境变量，而渲染侧
	 * `serverBase()` 优先读它（另有「按 `VSCODE_DEV` 推导」与「实测探测」两级兜底）。
	 * ⚠ **必须在创建第一个窗口之前调用**（否则该窗口的渲染进程继承不到）。
	 */
	private _initAgentMemoryEndpoint(): void {
		const port = this._resolveAgentMemoryPort();
		process.env['AGENTMEMORY_PORT'] = String(port);
		if (!process.env['AGENTMEMORY_URL']) {
			process.env['AGENTMEMORY_URL'] = `http://127.0.0.1:${port}`;
		}
		this.logService.info(`[agentmemory-gateway] 端口确定: ${port}（isBuilt=${this.environmentMainService.isBuilt}；渲染侧经 AGENTMEMORY_URL 继承，可用 AGENTMEMORY_PORT 覆盖）`);
	}

	/** 端口规则见 `_initAgentMemoryEndpoint()`；本方法是**唯一真源**。 */
	private _resolveAgentMemoryPort(): number {
		const explicit = Number.parseInt(process.env['AGENTMEMORY_PORT'] ?? '', 10);
		if (Number.isInteger(explicit) && explicit > 0 && explicit < 65536) { return explicit; }
		// isBuilt（= !VSCODE_DEV，见 platform/environment/common/environmentService.ts）是 dev / 打包 的
		// 正确判据（**不能**用 app.isPackaged）。
		const base = this.environmentMainService.isBuilt ? 3111 : 3112;
		// 多开隔离：端口若只按形态分配，则「同形态 + 不同 user-data-dir」的多个实例
		// 必然撞同一个端口（后启者 EADDRINUSE）。这里对**非默认数据目录**做确定性偏移，
		// 使每个实例稳定拿到自己的端口 —— 确定性意味着同一实例重启后端口不变，
		// 且渲染侧可用同一算法独立推导，无需跨进程通信。
		const defaultDataDir = join(this.environmentMainService.userDataPath, '.agentmemory');
		const dataDir = process.env['AGENTMEMORY_DATA_DIR'] ?? defaultDataDir;
		if (this._isSamePath(dataDir, defaultDataDir)) {
			return base;
		}
		return base + 10 + (this._hashString(this._normalizePathForHash(dataDir)) % 90);
	}

	/** 与 `_isSamePath` 同一套归一化：Windows 大小写不敏感、分隔符可能混用。 */
	private _normalizePathForHash(p: string): string {
		return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	}

	/** 稳定字符串哈希（FNV-1a 32 位）：仅用于端口派生，不涉安全。 */
	private _hashString(s: string): number {
		let h = 0x811c9dc5;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		return h;
	}

	/**
	 * P0-3（2026-09-19）：把 BYOK 配置注入 `AGENTMEMORY_LLM_*` env（供网关的 LLM 压缩使用）。
	 *
	 * 背景：agentmemory 的 LLM 压缩/固化（`consolidationLlm` / `compressor`）只读
	 * `AGENTMEMORY_LLM_BASE_URL`/`AGENTMEMORY_LLM_API_KEY` env，而 BYOK 的配置在 VS Code settings
	 * （`sessions.agentStudio.provider.<id>.apiKey`）⇒ 两者不通 ⇒ 用户配了 BYOK 也不会启用 LLM 压缩。
	 * 本方法在 startup 时读第一个已配置的 BYOK provider（OpenAI 兼容，按优先级降序，排除 anthropic），
	 * 注入 env ⇒ 网关 spawn 时继承 ⇒ `isLlmConfigured()` 为 true ⇒ `isConsolidationLlmEnabled()` 默认启用。
	 * ⚠ 必须在创建第一个窗口/网关之前调用（与 `_initAgentMemoryEndpoint()` 同位置）。
	 * ⚠ anthropic 被排除：`openAICompatible: false`（`callChatCompletion` 用 OpenAI 兼容格式）。
	 */
	private _initAgentMemoryLlm(): void {
		try {
			if (process.env['AGENTMEMORY_LLM_API_KEY']) {
				this.logService.debug('[agentmemory-llm] AGENTMEMORY_LLM_API_KEY 已显式设置，跳过 BYOK 注入');
				return;
			}
			// OpenAI 兼容 BYOK provider（按优先级降序；anthropic 不兼容，排除）
			const candidates: Array<{ id: string; defaultBaseUrl: string }> = [
				{ id: 'openrouter', defaultBaseUrl: 'https://openrouter.ai/api/v1' },
				{ id: 'gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
				{ id: 'nous', defaultBaseUrl: 'https://api.nous.com/v1' },
				{ id: 'ollama', defaultBaseUrl: 'http://localhost:11434' },
				{ id: 'main', defaultBaseUrl: '' },
			];
			for (const c of candidates) {
				const apiKey = (this.configurationService.getValue<string>(`sessions.agentStudio.provider.${c.id}.apiKey`) || '').trim();
				if (!apiKey) continue;
				const baseUrl = (this.configurationService.getValue<string>(`sessions.agentStudio.provider.${c.id}.baseUrl`) || c.defaultBaseUrl || '').trim();
				if (!baseUrl) continue;
				process.env['AGENTMEMORY_LLM_BASE_URL'] = baseUrl;
				process.env['AGENTMEMORY_LLM_API_KEY'] = apiKey;
				// P1-1（2026-09-19）：同时注入 **embedding** env（复用 BYOK apiKey ⇒ 远端 embedding provider 自动启用）。
				//   openrouter/ollama 是 OpenAI 兼容 ⇒ 走 `OpenAIEmbeddingProvider`；gemini 走 `GeminiEmbeddingProvider`。
				//   模型可用 `OPENAI_EMBEDDING_MODEL` / `GEMINI_EMBEDDING_MODEL` env 覆盖（满足"检查 model 的配置"）。
				if (c.id === 'openrouter') {
					process.env['OPENAI_API_KEY'] = apiKey;
					process.env['OPENAI_BASE_URL'] = baseUrl;
					if (!process.env['OPENAI_EMBEDDING_MODEL']) { process.env['OPENAI_EMBEDDING_MODEL'] = 'openai/text-embedding-3-small'; }
				} else if (c.id === 'gemini') {
					process.env['GEMINI_API_KEY'] = apiKey;
				} else if (c.id === 'ollama') {
					process.env['OPENAI_BASE_URL'] = baseUrl; // ollama 无 key，OpenAI 兼容端点
					if (!process.env['OPENAI_EMBEDDING_MODEL']) { process.env['OPENAI_EMBEDDING_MODEL'] = 'nomic-embed-text'; }
				}
				this.logService.info(`[agentmemory-llm] 已从 BYOK(${c.id}) 注入 AGENTMEMORY_LLM_* + embedding env（baseUrl=${baseUrl}）⇒ LLM 压缩 + 远端 embedding 默认启用`);
				return;
			}
			this.logService.debug('[agentmemory-llm] 未检测到已配置的 BYOK provider ⇒ LLM 压缩保持关闭（synthetic 降级）');
		} catch (err) {
			this.logService.warn(`[agentmemory-llm] BYOK 注入失败（已忽略）: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Windows 路径大小写不敏感且分隔符可能不一致 ⇒ 归一化后再比较。 */
	private _isSamePath(a: string, b: string): boolean {
		const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
		return norm(a) === norm(b);
	}

	/** 自愈重试状态：只在「子进程异常退出」时推进；成功复用/重新拉起后归零。 */
	private _agentMemoryGatewayRetryCount = 0;
	private _agentMemoryGatewayRetryTimer: ReturnType<typeof setTimeout> | undefined;
	// 首探 1s：网关重建索引实测约 4.3s，旧值 3s 偏长会让竞争期 loadContext 返空。
	// 超出表长后不再「永久放弃」，改为 5 分钟长期重试（占端口者退出后仍能拿回）。
	private static readonly AGENTMEMORY_GATEWAY_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000];
	private static readonly AGENTMEMORY_GATEWAY_RETRY_STEADY_MS = 300_000;

	/**
	 * 网关于进程异常退出后的自愈。
	 *
	 * 背景（用户日志实测）：dev 窗口启动时若端口被安装版占用 ⇒ EADDRINUSE ⇒ 子进程 code=1 退出，
	 * 此后**从不重试** ⇒ 对方退出后端口长期空置、该窗口记忆调用连续 80 分钟全部
	 * `ERR_CONNECTION_REFUSED`，直到对方实例重启才「偶然」恢复。
	 * ⇒ 必须有人负责把释放出来的端口重新拿起：退避重试，且每次都**先探活**
	 * （期间若已被别的实例拉起就直接复用，不会再造端口冲突）。
	 */
	private _scheduleAgentMemoryGatewayRetry(hostPath: string): void {
		const delays = CodeApplication.AGENTMEMORY_GATEWAY_RETRY_DELAYS_MS;
		if (this._agentMemoryGatewayRetryCount === delays.length) {
			this.logService.warn(`[agentmemory-gateway] 自愈重试 ${delays.length} 次仍未成功，转入 ${CodeApplication.AGENTMEMORY_GATEWAY_RETRY_STEADY_MS / 1000}s 长期重试（本窗口记忆降级；如需换端口请设置 AGENTMEMORY_PORT）。`);
		}
		const delay = this._agentMemoryGatewayRetryCount < delays.length
			? delays[this._agentMemoryGatewayRetryCount]
			: CodeApplication.AGENTMEMORY_GATEWAY_RETRY_STEADY_MS;
		this._agentMemoryGatewayRetryCount++;
		this._agentMemoryGatewayRetryTimer = setTimeout(() => {
			this._agentMemoryGatewayRetryTimer = undefined;
			this.logService.info(`[agentmemory-gateway] 自愈重试 #${this._agentMemoryGatewayRetryCount}（延迟 ${delay}ms）…`);
			void this._probeOrSpawnAgentMemoryGateway(hostPath);
		}, delay);
	}

	private _stopAgentMemoryGatewayRetry(): void {
		if (this._agentMemoryGatewayRetryTimer !== undefined) {
			clearTimeout(this._agentMemoryGatewayRetryTimer);
			this._agentMemoryGatewayRetryTimer = undefined;
		}
	}

	/** spawn agentmemory 网关子进程（单实例或多开且端口空闲时调用）。 */
	private _spawnAgentMemoryGateway(hostPath: string): void {
		try {
			const env: NodeJS.ProcessEnv = {
				...process.env,
				AGENTMEMORY_PORT: process.env['AGENTMEMORY_PORT'] ?? '3111',
				AGENTMEMORY_DATA_DIR: process.env['AGENTMEMORY_DATA_DIR'] ?? join(this.environmentMainService.userDataPath, '.agentmemory'),
				// 技能文件根目录（与渲染进程 skillRegistryService 读取路径一致）
				AGENTMEMORY_SKILLS_DIR: process.env['AGENTMEMORY_SKILLS_DIR'] ?? join(this.environmentMainService.userDataPath, 'skills'),
				// Plan C: point the gateway at the sibling agentmemory-memory extension
				// so it can import the compiled BM25 index module (single source of truth).
				// host.mjs 位于 <extRoot>/agentmemory-gateway/host/host.mjs，兄弟扩展在
				// <extRoot>/agentmemory-memory/out/，需从 host.mjs 向上 3 级到 extensions/
				// 再加 agentmemory-memory（dev 与打包后目录结构一致，相对路径通用）。
				AGENTMEMORY_EXT_ROOT: hostPath ? join(hostPath, '..', '..', '..', 'agentmemory-memory') : undefined,
			};

			// 用 Electron 内置 Node 跑子进程
			env['ELECTRON_RUN_AS_NODE'] = '1';

			this.logService.info(`[agentmemory-gateway] 启动文件服务器子进程: node host=${hostPath}`);

			const childProc: ChildProcess = spawn(process.execPath, [hostPath], {
				env,
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});

			childProc.stdout?.setEncoding('utf8');
			childProc.stderr?.setEncoding('utf8');

			let stdoutBuf = '';
			childProc.stdout?.on('data', (chunk: string) => {
				stdoutBuf += chunk;
				let nl: number;
				while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
					const line = stdoutBuf.slice(0, nl).trim();
					stdoutBuf = stdoutBuf.slice(nl + 1);
					if (!line) { continue; }
					try {
						const obj = JSON.parse(line);
						if (obj && typeof obj === 'object') {
							const kind = obj.kind ?? 'log';
							const msg = obj.msg ?? JSON.stringify(obj);
							if (kind === 'error') {
								this.logService.error(`[agentmemory-gateway] ${msg}`);
								if (obj.stack) {
									this.logService.error(`[agentmemory-gateway]   stack: ${obj.stack}`);
								}
							} else if (kind === 'ready') {
								this.logService.info(`[agentmemory-gateway] ✅ 网关就绪: port=${obj.port} dataDir=${obj.dataDir}`);
							} else {
								this.logService.info(`[agentmemory-gateway] ${msg}`);
							}
						} else {
							this.logService.info(`[agentmemory-gateway] ${line}`);
						}
					} catch {
						this.logService.info(`[agentmemory-gateway] ${line}`);
					}
				}
			});

			childProc.stderr?.on('data', (chunk: string) => {
				const s = String(chunk).trim();
				if (s) {
					this.logService.warn(`[agentmemory-gateway/stderr] ${s}`);
				}
			});

			childProc.on('exit', (code, signal) => {
				// 非零退出 = 网关不可用（本窗口此后只能降级或复用他实例网关）⇒ 必须是 warning，
				// 否则「子进程退出: code=1」会淹没在 info 里，用户只看得到 renderer 侧那条没有任何原因的
				// "gateway UNREACHABLE"。
				if (code !== 0 && signal === null) {
					this.logService.warn(
						`[agentmemory-gateway] 子进程异常退出: code=${code}（详见上方 [agentmemory-gateway/stderr] 行；`
						+ '最常见原因是端口被另一实例占用 EADDRINUSE，此时本窗口无自有网关，记忆读写会复用/降级到其他实例的网关）'
					);
					// 自愈：占端口的一方退出后端口会释放，必须有人重新拿起它
					this._scheduleAgentMemoryGatewayRetry(hostPath);
				} else {
					this.logService.info(`[agentmemory-gateway] 子进程退出: code=${code} signal=${signal}`);
				}
			});

			childProc.on('error', (err) => {
				this.logService.error(`[agentmemory-gateway] spawn 错误: ${err.message}`);
			});

			// 注册关闭时的 cleanup
			this._register(this.lifecycleMainService.onWillShutdown(() => {
				if (childProc.exitCode === null && !childProc.killed) {
					this.logService.info('[agentmemory-gateway] saros 关闭中，发送 SIGTERM');
					try {
						childProc.kill('SIGTERM');
					} catch (err) {
						this.logService.warn(`[agentmemory-gateway] kill SIGTERM 失败: ${err instanceof Error ? err.message : String(err)}`);
					}
					setTimeout(() => {
						if (childProc.exitCode === null && !childProc.killed) {
							try { childProc.kill('SIGKILL'); } catch { /* ignore */ }
						}
					}, 1000);
				}
			}));
		} catch (err) {
			this.logService.error(`[agentmemory-gateway] 启动逻辑异常（已忽略）: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
