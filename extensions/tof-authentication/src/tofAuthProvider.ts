/*---------------------------------------------------------------------------------------------
 *  TofAuthenticationProvider — vscode.AuthenticationProvider 实现
 *
 *  实现 vscode.AuthenticationProvider 接口，让 VS Code 把 'tof' 当作内置身份提供者。
 *  扩展宿主进程跑 Node http（LoopbackAuthServer + 网关调用），完全绕过渲染进程
 *  的 Mixed Content / CORS 限制。
 *
 *  除了标准接口，额外暴露两个 commands 给渲染进程拿完整 user 信息（因为
 *  vscode.AuthenticationSession 只能携带 account.id 和 account.label，没有 team 等）：
 *    - tofAuth.getCurrentUser: 返回 ITofUser | undefined
 *    - tofAuth.getCurrentTicket: 返回 string | undefined
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { TofLoopbackServer } from './tofAuthServer';
import { fetchWhoami } from './tofGatewayClient';
import { ITofUser, ITofConfig, ITofStoredSession, TofAuthError } from './types';

const SECRET_KEY = 'tof.session.v1';
const SESSION_SCOPES = ['identity'];
const PROVIDER_ID = 'tof';

export class TofAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {
	private readonly _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	private readonly _disposable: vscode.Disposable;

	private _sessionsPromise: Promise<vscode.AuthenticationSession[]>;
	private _currentUser: ITofUser | undefined;
	private _currentTicket: string | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this._sessionsPromise = this._readSessions();

		this._disposable = vscode.Disposable.from(
			this._onDidChangeSessions,
			// 暴露 commands 给渲染进程
			vscode.commands.registerCommand('tofAuth.getCurrentUser', () => this._currentUser),
			vscode.commands.registerCommand('tofAuth.getCurrentTicket', () => this._currentTicket),
			// secrets 跨窗口同步
			this.context.secrets.onDidChange(e => {
				if (e.key === SECRET_KEY) {
					this._checkForUpdates();
				}
			})
		);
	}

	get onDidChangeSessions() {
		return this._onDidChangeSessions.event;
	}

	dispose(): void {
		this._disposable.dispose();
	}

	// --- vscode.AuthenticationProvider ---

	async getSessions(scopes?: string[]): Promise<vscode.AuthenticationSession[]> {
		const sessions = await this._sessionsPromise;
		return sessions;
	}

	async createSession(scopes: string[]): Promise<vscode.AuthenticationSession> {
		const config = this._getConfig();
		if (!config.paasid) {
			throw new TofAuthError('缺少 paasid 配置', 'missing_config');
		}

		const server = new TofLoopbackServer();
		try {
			await server.start(config.timeoutSeconds);
			const signinUrl = server.buildSigninUrl(config);
			// 传入字符串而非 URI 对象，避免 vscode.Uri.parse 对查询字符串做 percentDecode
			// 后再 toString() 重新编码时导致 ? 被编码为 %3F 等过度编码问题。
			// openUri 内部检测到字符串时会保留原始字符串传递给主进程。
			const opened = await vscode.env.openExternal(signinUrl as unknown as vscode.Uri);
			if (!opened) {
				throw new TofAuthError('无法打开系统浏览器', 'browser_open_failed');
			}

			const ticket = await server.waitForTicket();
			const user = await fetchWhoami(ticket, config.gatewayBaseUrl);

			const session = this._buildSession(ticket, user);
			const previous = await this._sessionsPromise;
			const removed = previous.filter(s => s.id === session.id);
			const next = [...previous.filter(s => s.id !== session.id), session];

			await this._storeSession({ id: session.id, ticket, user, createdAt: Date.now() });

			this._currentUser = user;
			this._currentTicket = ticket;
			this._sessionsPromise = Promise.resolve(next);
			this._onDidChangeSessions.fire({ added: [session], removed, changed: [] });

			return session;
		} catch (e) {
			if (e instanceof TofAuthError) {
				throw e;
			}
			throw new TofAuthError(`登录失败：${(e as Error).message}`, 'login_failed');
		} finally {
			await server.stop();
		}
	}

	async removeSession(sessionId: string): Promise<void> {
		const previous = await this._sessionsPromise;
		const removed = previous.filter(s => s.id === sessionId);
		const remaining = previous.filter(s => s.id !== sessionId);

		await this._storeSession(undefined);
		this._currentUser = undefined;
		this._currentTicket = undefined;
		this._sessionsPromise = Promise.resolve(remaining);
		this._onDidChangeSessions.fire({ added: [], removed, changed: [] });
	}

	// --- internals ---

	private _getConfig(): ITofConfig {
		const cfg = vscode.workspace.getConfiguration('sessions.agentStudio.tof');
		return {
			paasid: cfg.get<string>('paasid') || 'sls_mcp_app',
			siteBaseUrl: cfg.get<string>('siteBaseUrl') || 'http://saroasis-mcp.woa.com',
			gatewayBaseUrl: cfg.get<string>('gatewayBaseUrl') || 'http://21.169.46.116:8080',
			timeoutSeconds: cfg.get<number>('loginTimeout') || 180,
		};
	}

	private _buildSession(ticket: string, user: ITofUser): vscode.AuthenticationSession {
		return {
			id: `tof-${user.staff_id}`,
			accessToken: ticket,
			account: { id: user.staff_id, label: user.login_name },
			scopes: SESSION_SCOPES,
		};
	}

	private async _readSessions(): Promise<vscode.AuthenticationSession[]> {
		const raw = await this.context.secrets.get(SECRET_KEY);
		if (!raw) {
			return [];
		}
		try {
			const stored: ITofStoredSession = JSON.parse(raw);
			this._currentUser = stored.user;
			this._currentTicket = stored.ticket;
			return [this._buildSession(stored.ticket, stored.user)];
		} catch (e) {
			await this.context.secrets.delete(SECRET_KEY);
			return [];
		}
	}

	private async _storeSession(data: ITofStoredSession | undefined): Promise<void> {
		if (!data) {
			await this.context.secrets.delete(SECRET_KEY);
		} else {
			await this.context.secrets.store(SECRET_KEY, JSON.stringify(data));
		}
	}

	private async _checkForUpdates(): Promise<void> {
		const previous = await this._sessionsPromise;
		this._sessionsPromise = this._readSessions();
		const current = await this._sessionsPromise;

		const added: vscode.AuthenticationSession[] = [];
		const removed: vscode.AuthenticationSession[] = [];

		current.forEach(s => {
			if (!previous.some(p => p.id === s.id)) {
				added.push(s);
			}
		});
		previous.forEach(s => {
			if (!current.some(c => c.id === s.id)) {
				removed.push(s);
			}
		});

		if (added.length || removed.length) {
			this._onDidChangeSessions.fire({ added, removed, changed: [] });
		}
	}
}
