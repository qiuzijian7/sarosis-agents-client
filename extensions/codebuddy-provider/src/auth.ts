/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CodeBuddy Auth — cli-external-link authentication for copilot.tencent.com.
 *
 * - Flow: cli-external-link (state + browser + poll)
 * - Token: ~/.codebuddy/local_storage/ (gzip+base64) or cli-external-link flow
 * - Refresh: POST /v2/plugin/auth/token/refresh (via X-Refresh-Token header)
 * - Supports: iOA mode, apiKeyHelper
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { execFile } from 'child_process';
import { ICredentialData, AuthStatus, TokenSource } from '@saros/shared';

/** CodeBuddy-specific token data with source tracking */
export interface ICodeBuddyTokenData extends ICredentialData {
	source?: TokenSource;
}

/** Auth state data (from /auth/state endpoint) */
interface IAuthState {
	state: string;
	authUrl: string;
}

const CODEBUDDY_DEFAULT_ENDPOINT = 'https://copilot.tencent.com';

/** Keys used in globalState */
const GS_KEY_TOKEN = 'codebuddy.tokenData';

/**
 * CodeBuddy authentication manager.
 */
export class CodeBuddyAuth {
	private _cachedToken: ICodeBuddyTokenData | undefined;
	private _authStatus: AuthStatus = 'logged-out';
	private _refreshPromise: Promise<boolean> | null = null;
	private _localStorageWatchTimer: ReturnType<typeof setInterval> | undefined;

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly _globalState: vscode.Memento,
	) {
		this._loadToken();
		this._startLocalStorageWatch();
	}

	dispose(): void {
		this._onDidChange.dispose();
		if (this._localStorageWatchTimer) {
			clearInterval(this._localStorageWatchTimer);
		}
	}

	get authStatus(): AuthStatus { return this._authStatus; }

	// ---- Token persistence ----

	private _loadToken(): void {
		const raw = this._globalState.get<string>(GS_KEY_TOKEN);
		if (!raw) {
			this._cachedToken = undefined;
			this._authStatus = 'logged-out';
			return;
		}
		try {
			const data = JSON.parse(raw) as ICodeBuddyTokenData;
			if (data.accessToken && data.expiresAt > Date.now()) {
				this._cachedToken = data;
				this._authStatus = 'logged-in';
				console.log(`[CodeBuddy] Token loaded from globalState (source: ${data.source ?? 'unknown'})`);
			} else if (data.refreshToken) {
				this._cachedToken = data;
				this._authStatus = 'logged-in';
				// Don't await here, just trigger refresh. getAccessToken() will wait if needed.
				void this._refreshCodeBuddyToken();
			} else {
				this._cachedToken = undefined;
				this._authStatus = 'logged-out';
			}
		} catch {
			this._cachedToken = undefined;
			this._authStatus = 'logged-out';
		}
	}

	private async _saveToken(data: ICodeBuddyTokenData): Promise<void> {
		this._cachedToken = data;
		this._authStatus = 'logged-in';
		await this._globalState.update(GS_KEY_TOKEN, JSON.stringify(data));
	}

	private async _clearToken(): Promise<void> {
		this._cachedToken = undefined;
		this._authStatus = 'logged-out';
		await this._globalState.update(GS_KEY_TOKEN, undefined);
	}

	// ---- Auth: Get access token ----

	async getAccessToken(): Promise<string | undefined> {
		// Priority order (highest first), matching CodeBuddy's getAuthSourceInfo() (L139 @34531-34950):
		// 1. Cached token from globalState (from login) — highest priority (session.auth.accessToken)
		// 2. CODEBUDDY_AUTH_TOKEN env var (Bearer token)
		// 3. apiKeyHelper (executable command)
		// 4. CODEBUDDY_API_KEY env var (API key)
		// 5. ~/.codebuddy/local_storage (fallback)

		// 1. Cached token from globalState (from login) — equivalent to session.auth.accessToken
		if (this._cachedToken) {
			console.log(`[CodeBuddy Auth] Checking cached token: expiresAt=${new Date(this._cachedToken.expiresAt).toISOString()}, now=${new Date().toISOString()}, hasRefresh=${!!this._cachedToken.refreshToken}, source=${this._cachedToken.source}`);
			if (this._cachedToken.expiresAt > Date.now() + 5 * 60_000) {
				console.log(`[CodeBuddy Auth] ✅ Using cached token (len=${this._cachedToken.accessToken.length}, prefix=${this._cachedToken.accessToken.substring(0, 10)}..., source=${this._cachedToken.source})`);
				return this._cachedToken.accessToken;
			}
			if (this._cachedToken.refreshToken) {
				console.log('[CodeBuddy Auth] Token expired, attempting refresh...');
				const refreshed = await this._refreshCodeBuddyToken();
				if (refreshed) { 
					console.log(`[CodeBuddy Auth] ✅ Token refreshed successfully (len=${this._cachedToken!.accessToken.length}, prefix=${this._cachedToken!.accessToken.substring(0, 10)}..., source=${this._cachedToken!.source})`);
					return this._cachedToken!.accessToken; 
				}
				console.warn('[CodeBuddy Auth] ⚠️ Token refresh failed, will try other sources');
			}
		}

		// 2. CODEBUDDY_AUTH_TOKEN env var (Bearer token)
		const envAuthToken = process.env.CODEBUDDY_AUTH_TOKEN?.trim();
		if (envAuthToken) {
			console.log(`[CodeBuddy Auth] ✅ Using token from CODEBUDDY_AUTH_TOKEN env var (len=${envAuthToken.length}, prefix=${envAuthToken.substring(0, 10)}...)`);
			return envAuthToken;
		}

		// 3. apiKeyHelper
		const helperToken = await this._executeApiKeyHelper();
		if (helperToken) {
			console.log(`[CodeBuddy Auth] ✅ Using token from apiKeyHelper (len=${helperToken.length}, prefix=${helperToken.substring(0, 10)}...)`);
			return helperToken;
		}

		// 4. CODEBUDDY_API_KEY env var (API key)
		// Note: CODEBUDDY_API_KEY can be invalid, but we still try it (same as CodeBuddy behavior)
		// If it fails, the HTTP 401 error will be thrown and user will see the error
		// Skip if CODEBUDDY_API_KEY_DISABLED is set (per official doc section 4)
		const apiKeyDisabled = process.env.CODEBUDDY_API_KEY_DISABLED;
		const envApiKey = apiKeyDisabled ? undefined : process.env.CODEBUDDY_API_KEY?.trim();
		if (envApiKey) {
			console.log(`[CodeBuddy Auth] ⚠️ Using token from CODEBUDDY_API_KEY env var (len=${envApiKey.length}, prefix=${envApiKey.substring(0, 10)}...). If this fails with 401, consider removing this env var or setting CODEBUDDY_API_KEY_DISABLED=1`);
			return envApiKey;
		}

		// 5. ~/.codebuddy/local_storage (fallback)
		const lsToken = this._readTokenFromLocalStorage();
		if (lsToken && lsToken.expiresAt > Date.now() + 5 * 60_000) {
			console.log(`[CodeBuddy Auth] ✅ Using token from ~/.codebuddy/local_storage (len=${lsToken.accessToken.length}, prefix=${lsToken.accessToken.substring(0, 10)}..., source=${lsToken.source})`);
			await this._saveToken(lsToken);
			this._onDidChange.fire();
			return lsToken.accessToken;
		}

		console.debug('[CodeBuddy Auth] ❌ No valid CodeBuddy access token found');
		await this._clearToken();
		this._onDidChange.fire();
		return undefined;
	}

	// ---- apiKeyHelper ----

	private async _executeApiKeyHelper(): Promise<string | undefined> {
		const config = vscode.workspace.getConfiguration('codebuddy');
		const helper = config.get<string>('apiKeyHelper');
		if (!helper || typeof helper !== 'string' || helper.trim().length === 0) {
			return undefined;
		}

		try {
			const result = await new Promise<string>((resolve, reject) => {
				execFile(helper.trim(), { timeout: 10_000 }, (err, stdout) => {
					if (err) { reject(err); } else { resolve(stdout.trim()); }
				});
			});
			if (result) { return result; }
		} catch (err) {
			console.warn('[CodeBuddy] apiKeyHelper execution failed:', err);
		}
		return undefined;
	}

	// ---- Read token from ~/.codebuddy/local_storage ----

	private _readTokenFromLocalStorage(): ICodeBuddyTokenData | undefined {
		try {
			const homeDir = process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy');
			const lsDir = path.join(homeDir, 'local_storage');

			if (!fs.existsSync(lsDir)) { return undefined; }

			const files = fs.readdirSync(lsDir);
			for (const file of files) {
				try {
					const filePath = path.join(lsDir, file);
					const content = fs.readFileSync(filePath, 'utf8');
					const parsed = JSON.parse(content);

					if (typeof parsed === 'string' && parsed.startsWith('H4sI')) {
						const decoded = this._decodeGzipBase64(parsed);
						if (decoded) {
							const token = this._extractTokenFromDecodedEntry(decoded);
							if (token) {
								console.log(`[CodeBuddy] Found token in ${file} (source: local_storage)`);
								return token;
							}
						}
					}
				} catch {
					// Skip files that can't be parsed
				}
			}

			console.debug('[CodeBuddy] No valid token found in ~/.codebuddy/local_storage');
			return undefined;
		} catch (err) {
			console.warn('[CodeBuddy] Error reading local_storage:', err);
			return undefined;
		}
	}

	// ---- Local storage file watch ----

	private _startLocalStorageWatch(): void {
		this._localStorageWatchTimer = setInterval(() => {
			const fileToken = this._readTokenFromLocalStorage();
			if (fileToken && fileToken.accessToken) {
				// Check if token has changed or is newer
				if (!this._cachedToken || 
					fileToken.accessToken !== this._cachedToken.accessToken ||
					fileToken.expiresAt > this._cachedToken.expiresAt) {
					console.log('[CodeBuddy] Local storage token updated, syncing...');
					this._saveToken(fileToken).catch(err => 
						console.error('[CodeBuddy] Failed to save token from local storage:', err)
					);
					this._onDidChange.fire();
				}
			}
		}, 30_000); // Check every 30 seconds
	}

	private _detectIOAMode(): boolean {
		try {
			const homeDir = process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy');
			const lsDir = path.join(homeDir, 'local_storage');
			if (!fs.existsSync(lsDir)) { return false; }

			for (const file of fs.readdirSync(lsDir)) {
				try {
					const content = fs.readFileSync(path.join(lsDir, file), 'utf8');
					const parsed = JSON.parse(content);
					if (parsed === 'iOA') {
						console.log('[CodeBuddy] iOA mode detected');
						return true;
					}
				} catch {
					// Skip
				}
			}
		} catch {
			// Ignore
		}
		return false;
	}

	private _decodeGzipBase64(encoded: string): any | undefined {
		try {
			const buffer = Buffer.from(encoded, 'base64');
			const decompressed = zlib.gunzipSync(buffer);
			return JSON.parse(decompressed.toString());
		} catch {
			return undefined;
		}
	}

	private _extractTokenFromDecodedEntry(data: any): ICodeBuddyTokenData | undefined {
		try {
			// Path 1: session.auth.accessToken (standard cli-external-link flow)
			const auth = data?.session?.auth;
			if (auth?.accessToken) {
				const expiresAt = this._calcExpiry(auth.expiresAt, auth.expires_in);
				return {
					accessToken: auth.accessToken,
					refreshToken: auth.refreshToken,
					expiresAt,
					source: 'local_storage',
				};
			}

			// Path 2: session.accounts[].auth.accessToken (multi-account / iOA)
			const accounts: any[] = data?.session?.accounts;
			if (Array.isArray(accounts)) {
				const now = Date.now();
				for (const account of accounts) {
					const accAuth = account?.auth;
					if (accAuth?.accessToken) {
						const expiresAt = this._calcExpiry(accAuth.expiresAt, accAuth.expires_in);
						if (expiresAt > now) {
							return {
								accessToken: accAuth.accessToken,
								refreshToken: accAuth.refreshToken,
								expiresAt,
								source: 'local_storage',
							};
						}
					}
				}
			}

			// Path 3: Deep scan for accessToken
			return this._deepFindToken(data);
		} catch {
			return undefined;
		}
	}

	private _calcExpiry(expiresAt?: number, expires_in?: number): number {
		if (expiresAt) {
			return expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
		}
		if (expires_in) {
			return Date.now() + expires_in * 1000;
		}
		return Date.now() + 3600_000;
	}

	private _deepFindToken(data: any, depth = 0): ICodeBuddyTokenData | undefined {
		if (depth > 5 || !data || typeof data !== 'object') { return undefined; }
		if (data.accessToken && typeof data.accessToken === 'string' && data.accessToken.length > 10) {
			return {
				accessToken: data.accessToken,
				refreshToken: data.refreshToken,
				expiresAt: this._calcExpiry(data.expiresAt, data.expires_in),
				source: 'local_storage',
			};
		}
		const skipKeys = new Set(['models', 'config', 'links', 'commitMessage', 'completion', 'productName', '$schema']);
		for (const key of Object.keys(data)) {
			if (skipKeys.has(key)) { continue; }
			const val = data[key];
			if (val && typeof val === 'object') {
				const found = this._deepFindToken(val, depth + 1);
				if (found) { return found; }
			}
		}
		return undefined;
	}

	// ---- cli-external-link Auth Flow ----

	private _getServerUrl(): string {
		return vscode.workspace.getConfiguration('codebuddy').get<string>('endpoint') || CODEBUDDY_DEFAULT_ENDPOINT;
	}

	private _getPlatform(): string {
		return vscode.workspace.getConfiguration('codebuddy').get<string>('authPlatform') || 'ide';
	}

	private async _requestAuthState(): Promise<IAuthState> {
		const serverUrl = this._getServerUrl();
		const platform = this._getPlatform();
		const url = `${serverUrl}/v2/plugin/auth/state?platform=${platform}`;

		console.log(`[CodeBuddy] Requesting auth state: platform=${platform}, url=${url}`);

		// fetch with explicit timeout — without this, a misconfigured system proxy
		// (e.g. ProxyEnable=1 pointing at a dead 127.0.0.1:8888 Fiddler port) causes
		// the request to hang silently with no error log, so the user only sees the
		// "Requesting auth state" line and the login UI stuck at "正在打开浏览器…".
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 30_000);
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-No-Authorization': 'true',
					'X-No-User-Id': 'true',
					'X-No-Enterprise-Id': 'true',
					'X-No-Department-Info': 'true',
				},
				body: '{}',
				signal: controller.signal,
			});

			if (!response.ok) {
				const errText = await response.text().catch(() => response.statusText);
				throw new Error(`Request auth state failed: HTTP ${response.status} - ${errText}`);
			}

			const data = await response.json() as { data?: { state?: string; authUrl?: string } };
			if (!data.data?.state || !data.data?.authUrl) {
				throw new Error('Invalid auth state response: missing state or authUrl');
			}

			// iOA mode: append ?ioa=1 to authUrl
			let authUrl = data.data.authUrl;
			if (this._detectIOAMode()) {
				const separator = authUrl.includes('?') ? '&' : '?';
				authUrl += `${separator}ioa=1`;
				console.log('[CodeBuddy] iOA mode: appended ioa=1 to authUrl');
			}

			console.log(`[CodeBuddy] Auth state received: state=${data.data.state}`);
			return { state: data.data.state, authUrl };
		} catch (err) {
			// Node's fetch wraps the real cause (e.g. ECONNREFUSED) in err.cause —
			// surface it so users can see the underlying network/proxy error rather
			// than a useless "fetch failed" message.
			const cause = (err as { cause?: { code?: string; message?: string; address?: string; port?: number } })?.cause;
			const causeStr = cause
				? ` (cause: ${cause.code ?? ''} ${cause.message ?? ''}${cause.address ? ` at ${cause.address}:${cause.port}` : ''})`
				: '';
			if (err instanceof Error && err.name === 'AbortError') {
				throw new Error(`请求 CodeBuddy auth state 超时（30s）。可能原因：系统代理设置异常（请检查 Windows 设置 → 网络 → 代理），或网络无法访问 ${serverUrl}。${causeStr}`);
			}
			console.error('[CodeBuddy] _requestAuthState failed:', err, 'cause:', cause);
			throw new Error(`请求 CodeBuddy auth state 失败：${err instanceof Error ? err.message : String(err)}${causeStr}`);
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private async _pollForToken(state: string, cancellationToken: vscode.CancellationToken): Promise<ICodeBuddyTokenData> {
		const serverUrl = this._getServerUrl();
		const url = `${serverUrl}/v2/plugin/auth/token?state=${state}`;

		const maxAttempts = 120;
		const intervalMs = 1000;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (cancellationToken.isCancellationRequested) {
				throw new Error('用户取消登录');
			}

			try {
				// Per-attempt timeout — without this a single hung poll fetch can stall
				// the whole login flow for the default socket timeout (~minutes).
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 10_000);
				try {
					const response = await fetch(url, {
						method: 'GET',
						headers: {
							'X-No-Authorization': 'true',
							'X-No-User-Id': 'true',
							'X-No-Enterprise-Id': 'true',
							'X-No-Department-Info': 'true',
						},
						signal: controller.signal,
					});

					if (!response.ok) {
						console.warn(`[CodeBuddy] Poll attempt ${attempt + 1} failed: HTTP ${response.status}`);
						await new Promise(resolve => setTimeout(resolve, intervalMs));
						continue;
					}

					const data = await response.json() as {
						data?: {
							accessToken?: string;
							refreshToken?: string;
							expiresAt?: number;
						};
					};

					if (data.data?.accessToken) {
						console.log('[CodeBuddy] Token received from poll');
						const expiresAt = this._calcExpiry(data.data.expiresAt);
						return {
							accessToken: data.data.accessToken,
							refreshToken: data.data.refreshToken,
							expiresAt,
							source: 'cli_external_link',
						};
					}

					console.debug(`[CodeBuddy] Poll attempt ${attempt + 1}: token not ready yet`);
				} finally {
					clearTimeout(timeoutId);
				}
			} catch (err) {
				// AbortError on a single poll is expected when the 10s timeout fires —
				// log + continue to next attempt rather than aborting the whole login.
				const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
				console.warn(`[CodeBuddy] Poll attempt ${attempt + 1} error:`, err instanceof Error ? err.message : err, 'cause:', cause);
			}

			await new Promise(resolve => setTimeout(resolve, intervalMs));
		}

		throw new Error('登录超时：未在预期时间内完成登录');
	}

	private async _refreshCodeBuddyToken(): Promise<boolean> {
		// If already refreshing, return the existing promise (prevent concurrent refreshes)
		if (this._refreshPromise) {
			return this._refreshPromise;
		}

		this._refreshPromise = this._doRefreshToken();
		try {
			return await this._refreshPromise;
		} finally {
			this._refreshPromise = null;
		}
	}

	private async _doRefreshToken(): Promise<boolean> {
		if (!this._cachedToken?.refreshToken) { return false; }

		try {
			const serverUrl = this._getServerUrl();
			const url = `${serverUrl}/v2/plugin/auth/token/refresh`;

			// Refresh can also hang on a misconfigured system proxy; give it a 15s
			// hard timeout so callers don't sit on a stuck refresh.
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 15_000);
			let response: Response;
			try {
				response = await fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-Refresh-Token': this._cachedToken.refreshToken,
						'X-Auth-Refresh-Source': 'plugin',
					},
					body: '{}',
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timeoutId);
			}

			// Handle 401/403: refresh_token is invalid, clear token and prompt re-login
			if (response.status === 401 || response.status === 403) {
				console.error(`[CodeBuddy] Token refresh failed: HTTP ${response.status} (refresh_token invalid)`);
				await this._clearToken();
				this._onDidChange.fire();
				return false;
			}

			// Handle 5xx: server error, keep token and retry later
			if (!response.ok) {
				console.warn(`[CodeBuddy] Token refresh failed: HTTP ${response.status}`);
				return false;
			}

			const data = await response.json() as {
				data?: {
					accessToken?: string;
					refreshToken?: string;
					expiresAt?: number;
				};
			};

			if (!data.data?.accessToken) {
				console.warn('[CodeBuddy] Token refresh response missing accessToken');
				return false;
			}

			await this._saveToken({
				accessToken: data.data.accessToken,
				refreshToken: data.data.refreshToken ?? this._cachedToken.refreshToken,
				expiresAt: this._calcExpiry(data.data.expiresAt),
				source: this._cachedToken.source,
			});

			console.log('[CodeBuddy] Token refreshed successfully');
			return true;
		} catch (err) {
			// Surface err.cause (e.g. ECONNREFUSED on a dead proxy) so logs are
			// actionable instead of just "TypeError: fetch failed".
			const cause = (err as { cause?: { code?: string; message?: string; address?: string; port?: number } })?.cause;
			console.error('[CodeBuddy] Token refresh error:', err instanceof Error ? err.message : err, 'cause:', cause);
			return false;
		}
	}

	// ---- Login / Logout ----

	async login(): Promise<void> {
		const config = vscode.workspace.getConfiguration('codebuddy');
		await config.update('status', '登录中（正在准备认证流程）...', vscode.ConfigurationTarget.Global);

		const result = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'CodeBuddy 登录',
				cancellable: true,
			},
			async (progress, cancellationToken) => {
				try {
					// Try ~/.codebuddy/local_storage
					progress.report({ message: '检查本地 CodeBuddy 登录态...' });
					const lsToken = this._readTokenFromLocalStorage();
					if (lsToken && lsToken.accessToken && lsToken.expiresAt > Date.now()) {
						progress.report({ message: '发现本地登录态，保存认证信息...' });
						await this._saveToken(lsToken);
						await config.update('status', '已登录（复用本地登录态）', vscode.ConfigurationTarget.Global);
						this._onDidChange.fire();
						return '登录成功！（复用本地 CodeBuddy 登录态）';
					}

					// Fallback: cli-external-link flow
					progress.report({ message: '请求认证状态...' });
					const authState = await this._requestAuthState();

					progress.report({ message: '请在浏览器中完成登录...' });
					await vscode.env.openExternal(vscode.Uri.parse(authState.authUrl));

					progress.report({ message: '等待登录完成...' });
					const tokenData = await this._pollForToken(authState.state, cancellationToken);

					progress.report({ message: '保存认证信息...' });
					await this._saveToken(tokenData);
					await config.update('status', '已登录', vscode.ConfigurationTarget.Global);
					this._onDidChange.fire();

					return '登录成功！';
				} catch (err) {
					await config.update('status', '未登录（登录失败）', vscode.ConfigurationTarget.Global);
					throw err;
				}
			},
		);

		if (result) {
			void vscode.window.showInformationMessage(`CodeBuddy ${result}`);
		}
	}

	async logout(): Promise<void> {
		await this._clearToken();
		const config = vscode.workspace.getConfiguration('codebuddy');
		try {
			await config.update('status', '未登录（请运行 CodeBuddy: Login 命令登录）', vscode.ConfigurationTarget.Global);
		} catch (err) {
			console.error('[CodeBuddy] Failed to clear configuration:', err);
		}
		this._onDidChange.fire();
		void vscode.window.showInformationMessage('CodeBuddy 已登出。');
	}
}
