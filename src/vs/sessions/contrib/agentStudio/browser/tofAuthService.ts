/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IRequestService, asJson } from '../../../../platform/request/common/request.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITofAuthService, ITofUser, TofAuthError } from '../common/tofAuth.js';
import {
	TOF_PAASID_SETTING,
	TOF_SITE_BASE_URL_SETTING,
	TOF_GATEWAY_BASE_URL_SETTING,
	TOF_LOGIN_TIMEOUT_SETTING,
} from '../common/constants.js';

// Taihu passport signin endpoint (oauth code mode)
const TAIHU_SIGNIN_URL = 'https://passport.woa.com/modules/passport/signin.ashx';
const TOF_CALLBACK_PATH = '/api/v1/auth/tof/callback';

/**
 * TOF 登录服务实现。
 *
 * 浏览器登录流程：
 *  1. 在 127.0.0.1 上启动 HTTP server，随机端口（需要 Node 环境）
 *  2. 构造 signin URL，用 IOpenerService 打开系统浏览器
 *  3. 用户在浏览器完成 iOA 登录
 *  4. TOF → 网关 callback → 网关 302 回 http://127.0.0.1:<port>/got?identity=<ticket>&state=<state>
 *  5. 本地 server 捕获 ticket，校验 state，关闭 server
 *  6. 用 ticket 调网关 /api/v1/whoami 获取用户身份
 *  7. 持久化 ticket + 用户信息到 ~/.saros/auth.json
 *
 * 降级模式（非 Electron 环境，require 不可用）：
 *  1. 打开浏览器到 passport.woa.com
 *  2. 用户完成登录后，浏览器跳转到 http://127.0.0.1:<port>/got?identity=<ticket>
 *  3. 用户从浏览器地址栏复制 ticket
 *  4. 在 VS Code 输入框中粘贴 ticket
 *  5. 调用 whoami 验证
 *
 * 文件持久化用 IFileService + IEnvironmentService.userHome（不依赖 Node fs/os/path）。
 * whoami HTTP 调用用 IRequestService（不依赖 Node http）。
 */
export class TofAuthService extends Disposable implements ITofAuthService {
	declare _serviceBrand: undefined;

	private _currentUser: ITofUser | null = null;
	private _currentTicket: string | null = null;
	private _isLoggingIn: boolean = false;

	private readonly _onDidChangeUser = this._register(new Emitter<ITofUser | null>());
	readonly onDidChangeUser = this._onDidChangeUser.event;

	get currentUser(): ITofUser | null { return this._currentUser; }
	get currentTicket(): string | null { return this._currentTicket; }
	get isLoggingIn(): boolean { return this._isLoggingIn; }

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IOpenerService private readonly openerService: IOpenerService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IRequestService private readonly requestService: IRequestService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super();
	}

	// --- 配置读取 -------------------------------------------------------------

	private _getConfig(): {
		paasid: string;
		siteBaseUrl: string;
		gatewayBaseUrl: string;
		timeoutSeconds: number;
	} {
		const paasid = this.configurationService.getValue<string>(TOF_PAASID_SETTING) || 'sls_mcp_app';
		const siteBaseUrl = this.configurationService.getValue<string>(TOF_SITE_BASE_URL_SETTING) || 'http://saroasis-mcp.woa.com';
		const gatewayBaseUrl = this.configurationService.getValue<string>(TOF_GATEWAY_BASE_URL_SETTING) || 'http://21.169.46.116:8080';
		const timeoutSeconds = this.configurationService.getValue<number>(TOF_LOGIN_TIMEOUT_SETTING) || 180;
		return { paasid, siteBaseUrl, gatewayBaseUrl, timeoutSeconds };
	}

	// --- 持久化 (用 IFileService，不依赖 Node fs) ------------------------------

	private async _getAuthFileUri(): Promise<URI> {
		const homeUri = await this.pathService.userHome();
		return URI.joinPath(homeUri, '.saros', 'auth.json');
	}

	private async _loadSavedAuth(): Promise<{ ticket: string; user: ITofUser } | null> {
		try {
			const uri = await this._getAuthFileUri();
			const exists = await this.fileService.exists(uri);
			if (!exists) {
				return null;
			}
			const content = await this.fileService.readFile(uri);
			const raw = content.value.toString();
			const data = JSON.parse(raw) as { ticket?: string; user?: ITofUser };
			if (!data.ticket || !data.user) {
				return null;
			}
			return { ticket: data.ticket, user: data.user };
		} catch (e) {
			this.logService.warn('[TofAuth] Failed to load saved auth:', e);
			return null;
		}
	}

	private async _saveAuth(ticket: string, user: ITofUser): Promise<void> {
		try {
			const homeUri = await this.pathService.userHome();
			const uri = URI.joinPath(homeUri, '.saros', 'auth.json');
			// 确保父目录存在
			const dirUri = URI.joinPath(homeUri, '.saros');
			try {
				await this.fileService.createFolder(dirUri);
			} catch {
				// 目录可能已存在，忽略
			}
			const content = JSON.stringify({ ticket, user }, null, 2);
			await this.fileService.writeFile(uri, VSBuffer.fromString(content));
			this.logService.info('[TofAuth] Auth saved to', uri.toString());
		} catch (e) {
			this.logService.error('[TofAuth] Failed to save auth:', e);
		}
	}

	private async _clearSavedAuth(): Promise<void> {
		try {
			const uri = await this._getAuthFileUri();
			const exists = await this.fileService.exists(uri);
			if (exists) {
				await this.fileService.del(uri);
			}
		} catch (e) {
			this.logService.warn('[TofAuth] Failed to clear saved auth:', e);
		}
	}

	// --- 登录 -----------------------------------------------------------------

	/**
	 * 检查 Node.js `require` 是否可用（用于本地 HTTP server）。
	 * 文件读写和 whoami 调用不依赖此检查。
	 */
	private _isNodeHttpAvailable(): boolean {
		try {
			// eslint-disable-next-line local/code-import-patterns
			return typeof require === 'function';
		} catch {
			return false;
		}
	}

	async login(): Promise<ITofUser> {
		if (this._isLoggingIn) {
			throw new TofAuthError('登录正在进行中，请稍候', 'already_in_progress');
		}

		const config = this._getConfig();
		if (!config.paasid) {
			throw new TofAuthError('缺少 paasid 配置，请在设置中配置 TOF PaasID', 'missing_config');
		}

		this._isLoggingIn = true;
		this.logService.info('[TofAuth] Starting TOF browser login...');

		try {
			// 1. 获取 ticket（自动 server 模式 或 手动粘贴模式）
			const ticket = this._isNodeHttpAvailable()
				? await this._runAutoLogin(config)
				: await this._runManualLogin(config);
			this.logService.info('[TofAuth] Got x-tai-identity ticket, length=', ticket.length);

			// 2. 用 ticket 调 /whoami 获取用户身份（用 IRequestService，不依赖 Node http）
			const user = await this._fetchWhoami(ticket, config.gatewayBaseUrl);
			this.logService.info(`[TofAuth] Login success: staff_id=${user.staff_id} login_name=${user.login_name}`);

			// 3. 持久化 + 更新状态
			await this._saveAuth(ticket, user);
			this._currentTicket = ticket;
			this._setUser(user);

			return user;
		} catch (e) {
			this.logService.error('[TofAuth] Login failed:', e);
			throw e;
		} finally {
			this._isLoggingIn = false;
		}
	}

	/**
	 * 自动模式：启动本地 HTTP server，打开浏览器，等待 TOF 回调返回 ticket。
	 * 需要 Node.js `http` 模块（Electron 渲染进程）。
	 */
	private _runAutoLogin(config: { paasid: string; siteBaseUrl: string; timeoutSeconds: number }): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			// 用 Web Crypto API 生成 state（不依赖 Node crypto）
			const stateBytes = new Uint8Array(16);
			crypto.getRandomValues(stateBytes);
			const state = btoa(String.fromCharCode(...stateBytes))
				.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
			let settled = false;

			/* eslint-disable @typescript-eslint/no-explicit-any, local/code-import-patterns */
			const http = require('http');
			/* eslint-enable @typescript-eslint/no-explicit-any, local/code-import-patterns */

			/* eslint-disable @typescript-eslint/no-explicit-any */
			const server = http.createServer((req: any, res: any) => {
				try {
					const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
					if (reqUrl.pathname !== '/got') {
						res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
						res.end('<html><body><h2>404 Not Found</h2></body></html>');
						return;
					}
					const identity = reqUrl.searchParams.get('identity') ?? '';
					const stateParam = reqUrl.searchParams.get('state') ?? '';

					if (stateParam !== state) {
						res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
						res.end('<html><body><h2>登录失败</h2><p>state 不匹配</p></body></html>');
						if (!settled) { settled = true; cleanup(); reject(new TofAuthError('state 不匹配', 'state_mismatch')); }
						return;
					}
					if (!identity) {
						res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
						res.end('<html><body><h2>登录失败</h2><p>回调未携带身份票据</p></body></html>');
						if (!settled) { settled = true; cleanup(); reject(new TofAuthError('回调未携带身份票据', 'missing_identity')); }
						return;
					}

					res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
					res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>登录成功</title></head><body style="font-family:sans-serif;max-width:560px;margin:80px auto;text-align:center"><h2>登录成功</h2><p>已获取身份票据。</p><p style="color:#888">现在可以关闭此页面，回到萨罗斯客户端。</p></body></html>');

					if (!settled) { settled = true; cleanup(); resolve(identity); }
				} catch (e) {
					this.logService.error('[TofAuth] Callback handler error:', e);
				}
			});
			/* eslint-enable @typescript-eslint/no-explicit-any */

			const cleanup = () => {
				if (timeoutHandle) { clearTimeout(timeoutHandle); }
				try { server.close(); } catch { /* ignore */ }
			};

			const timeoutHandle = setTimeout(() => {
				if (!settled) { settled = true; cleanup(); reject(new TofAuthError(`登录超时（${config.timeoutSeconds}s）`, 'timeout')); }
			}, config.timeoutSeconds * 1000);

			server.on('error', (err: Error) => {
				if (!settled) { settled = true; cleanup(); reject(new TofAuthError(`本地回调服务启动失败：${err.message}`, 'server_error')); }
			});

			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				const port = typeof address === 'object' && address ? address.port : 0;
				if (!port) {
					if (!settled) { settled = true; cleanup(); reject(new TofAuthError('无法确定本地回调端口', 'server_error')); }
					return;
				}

				const gwCallback = `${config.siteBaseUrl.replace(/\/$/, '')}${TOF_CALLBACK_PATH}?cb_port=${port}&state=${encodeURIComponent(state)}`;
				const signinUrl = `${TAIHU_SIGNIN_URL}?oauth=true&appkey=${encodeURIComponent(config.paasid)}&url=${encodeURIComponent(gwCallback)}`;

				this.logService.info(`[TofAuth] Local callback server listening on 127.0.0.1:${port}`);

				// 直接传字符串，不用 URI.parse —— URI.parse 会解码 url 参数值中的 %3F，
				// 然后 toString() 重新编码时可能改变编码格式，导致 passport.woa.com 无法正确解析
				this.openerService.open(signinUrl, { openExternal: true }).then(
					() => { /* browser opened */ },
					(err: Error) => {
						this.logService.error('[TofAuth] Failed to open browser:', err);
						this.notificationService.warn(`无法打开浏览器：${err.message}`);
					}
				);
			});
		});
	}

	/**
	 * 手动模式（降级）：打开浏览器，用户完成后手动粘贴 ticket。
	 * 用于非 Electron 环境（require 不可用）。
	 *
	 * 网关原始代码 `if not cb_port` 在 0/None 时拒绝，但正整数被接受。
	 * 用 cb_port=8765（安全端口），网关 302 回 http://127.0.0.1:8765/got?identity=<ticket>
	 * 浏览器显示"无法连接"（正常），用户从地址栏复制 URL。
	 */
	private async _runManualLogin(config: { paasid: string; siteBaseUrl: string }): Promise<string> {
		// 生成 state（用 Web Crypto API）
		const stateBytes = new Uint8Array(16);
		crypto.getRandomValues(stateBytes);
		const state = btoa(String.fromCharCode(...stateBytes))
			.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

		const gwCallback = `${config.siteBaseUrl.replace(/\/$/, '')}${TOF_CALLBACK_PATH}?cb_port=8765&state=${encodeURIComponent(state)}`;
		const signinUrl = `${TAIHU_SIGNIN_URL}?oauth=true&appkey=${encodeURIComponent(config.paasid)}&url=${encodeURIComponent(gwCallback)}`;

		this.logService.info('[TofAuth] Manual login mode, opening browser...');

		// 打开浏览器
		this.openerService.open(signinUrl, { openExternal: true }).then(
			() => { /* browser opened */ },
			(err: Error) => {
				this.logService.error('[TofAuth] Failed to open browser:', err);
				this.notificationService.warn(`无法自动打开浏览器：${err.message}。请手动访问登录链接（已记录到日志）。`);
				this.logService.warn(`[TofAuth] Manual signin URL: ${signinUrl}`);
			}
		);

		this.logService.info('[TofAuth] Waiting for user to copy ticket and confirm...');

		// 方案：剪贴板读取 + 手动输入双保险
		// 显示常驻通知，提供两个按钮：
		//  - 「从剪贴板读取」：用户复制浏览器地址栏 URL 后点此，自动读取剪贴板
		//  - 「手动粘贴」：弹输入框让用户粘贴
		const input = await new Promise<string | undefined>((resolve) => {
			let resolved = false;
			const done = (value: string | undefined) => {
				if (!resolved) {
					resolved = true;
					resolve(value);
				}
			};

			const handle = this.notificationService.prompt(
				Severity.Info,
				'OA 登录：在浏览器完成登录后，浏览器会跳转到"无法连接"页面。' +
				'请复制浏览器地址栏的完整 URL，然后点击下方「从剪贴板读取」完成登录。',
				[
					{
						label: '从剪贴板读取',
						run: async () => {
							try {
								const clip = await this.clipboardService.readText();
								if (clip && clip.includes('identity=')) {
									done(clip);
								} else {
									this.notificationService.warn('剪贴板中未找到有效的登录 URL，请先复制浏览器地址栏的完整 URL（包含 identity= 的那个），再点击「从剪贴板读取」。');
								}
							} catch (e) {
								this.logService.error('[TofAuth] Failed to read clipboard:', e);
								this.notificationService.warn('读取剪贴板失败，请改用「手动粘贴」。');
							}
						}
					},
					{
						label: '手动粘贴',
						run: async () => {
							const box = this.quickInputService.createInputBox();
							box.placeholder = '粘贴浏览器地址栏的完整 URL...';
							box.prompt = '复制浏览器地址栏 URL（http://127.0.0.1:8765/got?identity=...）粘贴到这里，按回车';
							box.ignoreFocusOut = true;
							box.show();
							box.onDidAccept(() => {
								const v = box.value;
								box.dispose();
								done(v);
							});
							box.onDidHide(() => {
								box.dispose();
							});
						}
					},
					{
						label: '取消',
						run: () => done(undefined)
					}
				],
				{ sticky: true }
			);
			handle.onDidClose(() => done(undefined));
		});

		if (!input || input.trim().length < 10) {
			throw new TofAuthError('未输入有效的身份票据', 'missing_identity');
		}

		const trimmed = input.trim();

		// 支持粘贴完整 URL 或直接粘贴 identity 票据值
		if (trimmed.startsWith('http') || trimmed.includes('identity=')) {
			try {
				const url = new URL(trimmed.startsWith('http') ? trimmed : `http://x/?${trimmed}`);
				const identity = url.searchParams.get('identity');
				if (identity && identity.length > 10) {
					return identity;
				}
			} catch {
				// URL 解析失败，尝试正则提取
			}
			const match = trimmed.match(/identity=([^&\s]+)/);
			if (match && match[1] && match[1].length > 10) {
				return decodeURIComponent(match[1]);
			}
		}

		return trimmed;
	}

	/**
	 * 调用网关 /api/v1/whoami 校验 ticket 并获取用户身份。
	 * 用 IRequestService（不依赖 Node http）。
	 */
	private async _fetchWhoami(ticket: string, gatewayBaseUrl: string): Promise<ITofUser> {
		const url = `${gatewayBaseUrl.replace(/\/$/, '')}/api/v1/whoami`;
		this.logService.info(`[TofAuth] Calling whoami: ${url}`);

		try {
			const response = await this.requestService.request({
				type: 'GET',
				url,
				headers: {
					'x-tai-identity': ticket,
					'Accept': 'application/json',
				},
				disableCache: true,
				callSite: 'tofAuth.whoami',
			}, CancellationToken.None);

			const status = response.res.statusCode;
			if (status === 401) {
				const errData = await asJson<{ detail?: { message?: string }; message?: string }>(response).catch(() => null);
				const detail = errData?.detail?.message ?? errData?.message ?? '';
				throw new TofAuthError(`网关拒绝了凭据（401）：${detail}`, 'identity_rejected');
			}
			if (status && status >= 400) {
				throw new TofAuthError(`whoami 失败：HTTP ${status}`, 'whoami_failed');
			}

			const data = await asJson<Partial<ITofUser>>(response);
			if (!data || !data.staff_id || !data.login_name) {
				throw new TofAuthError('whoami 返回数据缺少 staff_id / login_name', 'whoami_invalid');
			}

			return {
				user_id: data.user_id ?? `taihu:staffid:${data.staff_id}`,
				staff_id: String(data.staff_id),
				login_name: String(data.login_name),
				team: data.team ?? null,
				is_admin: !!data.is_admin,
				expires_at: data.expires_at ?? '',
			};
		} catch (e) {
			if (e instanceof TofAuthError) {
				throw e;
			}
			throw new TofAuthError(`无法连接网关 ${url}：${(e as Error).message}`, 'gateway_unreachable');
		}
	}

	// --- 登出 -----------------------------------------------------------------

	async logout(): Promise<void> {
		this.logService.info('[TofAuth] Logging out...');
		await this._clearSavedAuth();
		this._currentTicket = null;
		this._setUser(null);
	}

	// --- 恢复会话 -------------------------------------------------------------

	async restoreSession(): Promise<ITofUser | null> {
		// 文件读写和 whoami 调用用 VS Code 服务，不依赖 Node 模块
		const saved = await this._loadSavedAuth();
		if (!saved) {
			return null;
		}

		this.logService.info('[TofAuth] Found saved auth, validating ticket...');

		// 检查过期时间（本地粗检，避免不必要的网络请求）
		if (saved.user.expires_at) {
			const expiry = new Date(saved.user.expires_at).getTime();
			if (!isNaN(expiry) && expiry < Date.now()) {
				this.logService.info('[TofAuth] Saved ticket expired, clearing...');
				await this._clearSavedAuth();
				return null;
			}
		}

		const config = this._getConfig();
		try {
			const user = await this._fetchWhoami(saved.ticket, config.gatewayBaseUrl);
			this._currentTicket = saved.ticket;
			this._setUser(user);
			this.logService.info(`[TofAuth] Session restored: ${user.login_name}`);
			return user;
		} catch (e) {
			this.logService.warn('[TofAuth] Saved ticket validation failed, clearing:', e);
			await this._clearSavedAuth();
			return null;
		}
	}

	// --- 内部 -----------------------------------------------------------------

	private _setUser(user: ITofUser | null): void {
		this._currentUser = user;
		this._onDidChangeUser.fire(user);
	}
}
