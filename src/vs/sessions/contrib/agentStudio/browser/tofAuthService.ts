/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IAuthenticationService, AuthenticationSession } from '../../../../workbench/services/authentication/common/authentication.js';
import { ITofAuthService, ITofUser, TofAuthError } from '../common/tofAuth.js';

/**
 * TOF 登录服务 — 渲染进程代理实现。
 *
 * 真正的 OAuth 流程（LoopbackAuthServer + 浏览器登录 + whoami 网关调用）已经
 * 迁移到扩展宿主进程里的 `extensions/tof-authentication/` 扩展。渲染进程本类
 * 通过 `IAuthenticationService`（VS Code 内部对应 `vscode.authentication`）
 * 触发扩展的 `createSession` / `getSessions` / `removeSession`，再通过
 * `ICommandService` 调 `tofAuth.getCurrentUser` / `tofAuth.getCurrentTicket`
 * 拿到完整的 ITofUser（AuthenticationSession 只能携带 account.id/label）。
 *
 * 这样设计的原因：渲染进程页面是 `vscode-file://`，对明文 HTTP 网关的
 * fetch 会被 Mixed Content / CORS 拦截，且 sandbox 不能起本地 HTTP server。
 * 扩展宿主是 Node 环境，没有这些限制。
 *
 * 文件持久化（auth.json）也完全移除，扩展用 SecretStorage 跨窗口同步。
 */
export class TofAuthService extends Disposable implements ITofAuthService {
	declare _serviceBrand: undefined;

	private static readonly PROVIDER_ID = 'tof';
	private static readonly SCOPES: readonly string[] = ['identity'];

	private _currentUser: ITofUser | null = null;
	private _currentTicket: string | null = null;
	private _isLoggingIn: boolean = false;
	private _sessionRestoring: Promise<ITofUser | null> | null = null;

	private readonly _onDidChangeUser = this._register(new Emitter<ITofUser | null>());
	readonly onDidChangeUser = this._onDidChangeUser.event;

	get currentUser(): ITofUser | null { return this._currentUser; }
	get currentTicket(): string | null { return this._currentTicket; }
	get isLoggingIn(): boolean { return this._isLoggingIn; }

	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// 监听 tof session 变化（多窗口同步、扩展主动 fire）
		this._register(this.authenticationService.onDidChangeSessions(e => {
			if (e.providerId !== TofAuthService.PROVIDER_ID) {
				return;
			}
			void this._onSessionChanged(e.event);
		}));
	}

	// --- 登录 -----------------------------------------------------------------

	async login(): Promise<ITofUser> {
		if (this._isLoggingIn) {
			throw new TofAuthError('登录正在进行中，请稍候', 'already_in_progress');
		}

		this._isLoggingIn = true;
		this.logService.info('[TofAuth] Triggering login via authentication provider...');

		try {
			// 触发扩展的 createSession()：扩展会起 LoopbackAuthServer、打开浏览器、调 whoami
			const session = await this.authenticationService.createSession(
				TofAuthService.PROVIDER_ID,
				TofAuthService.SCOPES,
				{ activateImmediate: true }
			);

			this._currentTicket = session.accessToken;

			// 扩展 createSession 完成后，缓存已更新；调命令拿完整 user
			const user = await this._fetchCurrentUser();
			if (!user) {
				throw new TofAuthError('登录完成但未能获取用户信息', 'no_user');
			}

			this._setUser(user);
			this.logService.info(`[TofAuth] Login success: staff_id=${user.staff_id} login_name=${user.login_name}`);
			return user;
		} catch (e) {
			this.logService.error('[TofAuth] Login failed:', e);
			throw e instanceof TofAuthError ? e : new TofAuthError(`登录失败：${(e as Error).message}`, 'login_failed');
		} finally {
			this._isLoggingIn = false;
		}
	}

	async logout(): Promise<void> {
		this.logService.info('[TofAuth] Logging out...');
		try {
			const sessions = await this.authenticationService.getSessions(TofAuthService.PROVIDER_ID);
			if (sessions.length > 0) {
				await this.authenticationService.removeSession(TofAuthService.PROVIDER_ID, sessions[0].id);
			}
			this._setUser(null);
			this._currentTicket = null;
		} catch (e) {
			this.logService.error('[TofAuth] Logout failed:', e);
			throw e;
		}
	}

	async restoreSession(): Promise<ITofUser | null> {
		// 避免重复恢复
		if (this._sessionRestoring) {
			return this._sessionRestoring;
		}

		this._sessionRestoring = (async () => {
			try {
				this.logService.info('[TofAuth] Restoring session from extension SecretStorage...');
				// 触发扩展激活并读取已存的 session
				const sessions = await this.authenticationService.getSessions(
					TofAuthService.PROVIDER_ID,
					TofAuthService.SCOPES,
					undefined,
					false // 不强制激活；如果扩展还没加载，先返回空
				);

				if (sessions.length === 0) {
					this.logService.info('[TofAuth] No saved session');
					return null;
				}

				const session: AuthenticationSession = sessions[0];
				this._currentTicket = session.accessToken;

				const user = await this._fetchCurrentUser();
				if (!user) {
					this.logService.warn('[TofAuth] Saved session exists but no user info, possibly expired');
					return null;
				}

				this._setUser(user);
				this.logService.info(`[TofAuth] Session restored: ${user.login_name}`);
				return user;
			} catch (e) {
				this.logService.warn('[TofAuth] Restore failed:', e);
				return null;
			}
		})();

		return this._sessionRestoring;
	}

	// --- 内部 -----------------------------------------------------------------

	private async _onSessionChanged(event: { added?: readonly AuthenticationSession[]; removed?: readonly AuthenticationSession[]; changed?: readonly AuthenticationSession[] }): Promise<void> {
		// 如果有 added/changed，重新读 user
		if (event.added?.length || event.changed?.length) {
			const user = await this._fetchCurrentUser();
			const ticket = await this._fetchCurrentTicket();
			if (user) {
				this._currentTicket = ticket;
				this._setUser(user);
			}
		} else if (event.removed?.length) {
			this._setUser(null);
		}
	}

	private async _fetchCurrentUser(): Promise<ITofUser | null> {
		try {
			const user = await this.commandService.executeCommand<ITofUser | undefined>('tofAuth.getCurrentUser');
			return user ?? null;
		} catch (e) {
			this.logService.warn('[TofAuth] Failed to fetch current user:', e);
			return null;
		}
	}

	private async _fetchCurrentTicket(): Promise<string | null> {
		try {
			const ticket = await this.commandService.executeCommand<string | undefined>('tofAuth.getCurrentTicket');
			return ticket ?? null;
		} catch {
			return null;
		}
	}

	private _setUser(user: ITofUser | null): void {
		this._currentUser = user;
		if (!user) {
			this._currentTicket = null;
		}
		this._onDidChangeUser.fire(user);
	}
}
