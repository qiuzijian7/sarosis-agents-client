/*---------------------------------------------------------------------------------------------
 *  本地 Loopback HTTP server — 捕获 TOF OAuth 回调返回的 identity ticket
 *
 *  流程：
 *    1. start() 启动 http.createServer 监听 127.0.0.1:0（随机端口）
 *    2. 浏览器登录后网关 302 → http://127.0.0.1:<port>/got?identity=<ticket>&state=<state>
 *    3. waitForTicket() 返回 identity ticket
 *    4. stop() 关闭 server
 *
 *  扩展宿主进程是 Node 环境，可直接 import http，没有 sandbox 限制。
 *--------------------------------------------------------------------------------------------*/
import * as http from 'http';
import { randomBytes } from 'crypto';
import { URL } from 'url';
import { TofAuthError } from './types';

const TAIHU_SIGNIN_URL = 'https://passport.woa.com/modules/passport/signin.ashx';
const TOF_CALLBACK_PATH = '/api/v1/auth/tof/callback';

export class TofLoopbackServer {
	private readonly _server: http.Server;
	private readonly _state: string;
	private _port: number | undefined;
	private _resolveTicket: ((ticket: string) => void) | undefined;
	private _reject: ((err: Error) => void) | undefined;
	private _timeoutHandle: NodeJS.Timeout | undefined;

	constructor() {
		this._state = randomBytes(16).toString('base64url');
		this._server = http.createServer((req, res) => this._handleRequest(req, res));
	}

	get state(): string {
		return this._state;
	}

	get redirectUri(): string {
		if (this._port === undefined) {
			throw new Error('Server is not started yet');
		}
		return `http://127.0.0.1:${this._port}/got`;
	}

	/**
	 * 构造浏览器登录 URL，回调指向本 server。
	 */
	buildSigninUrl(config: { paasid: string; siteBaseUrl: string }): string {
		const gwCallback = `${config.siteBaseUrl.replace(/\/$/, '')}${TOF_CALLBACK_PATH}?cb_port=${this._port}&state=${encodeURIComponent(this._state)}`;
		return `${TAIHU_SIGNIN_URL}?oauth=true&appkey=${encodeURIComponent(config.paasid)}&url=${encodeURIComponent(gwCallback)}`;
	}

	async start(timeoutSeconds: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const portTimeout = setTimeout(() => {
				reject(new TofAuthError('启动本地回调服务超时', 'server_start_timeout'));
			}, 5000);

			this._server.on('listening', () => {
				const address = this._server.address();
				if (typeof address === 'object' && address) {
					this._port = address.port;
				} else {
					clearTimeout(portTimeout);
					reject(new TofAuthError('无法确定本地服务端口', 'no_port'));
					return;
				}
				clearTimeout(portTimeout);

				// 整体登录超时
				this._timeoutHandle = setTimeout(() => {
					this._fail(new TofAuthError(`登录超时（${timeoutSeconds}s）`, 'login_timeout'));
				}, timeoutSeconds * 1000);

				resolve();
			});

			this._server.on('error', (err: NodeJS.ErrnoException) => {
				clearTimeout(portTimeout);
				this._fail(new TofAuthError(`本地回调服务错误：${err.message}`, 'server_error'));
			});

			this._server.listen(0, '127.0.0.1');
		});
	}

	/**
	 * 等待浏览器跳回 /got?identity=...&state=...，返回 identity ticket。
	 */
	waitForTicket(): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			this._resolveTicket = resolve;
			this._reject = reject;
		});
	}

	async stop(): Promise<void> {
		if (this._timeoutHandle) {
			clearTimeout(this._timeoutHandle);
			this._timeoutHandle = undefined;
		}
		return new Promise<void>((resolve) => {
			this._server.close(() => resolve());
		});
	}

	private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		try {
			const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
			if (reqUrl.pathname !== '/got') {
				res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end('<html><body><h2>404 Not Found</h2></body></html>');
				return;
			}
			const identity = reqUrl.searchParams.get('identity') ?? '';
			const stateParam = reqUrl.searchParams.get('state') ?? '';
			if (stateParam !== this._state) {
				res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end('<html><body><h2>Login Failed</h2><p>state mismatch</p></body></html>');
				this._fail(new TofAuthError('state 不匹配，可能存在 CSRF 攻击', 'state_mismatch'));
				return;
			}
			if (!identity || identity.length < 10) {
				res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end('<html><body><h2>Login Failed</h2><p>missing identity</p></body></html>');
				this._fail(new TofAuthError('回调缺少 identity 票据', 'missing_identity'));
				return;
			}
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Login Success</title></head><body style="font-family:sans-serif;max-width:560px;margin:80px auto;text-align:center"><h2>Login Success</h2><p>Identity ticket received.</p><p style="color:#888">You can close this page and return to the Sarosis client.</p></body></html>');
			this._succeed(identity);
		} catch (e) {
			this._fail(e instanceof Error ? e : new Error(String(e)));
		}
	}

	private _succeed(ticket: string): void {
		if (this._resolveTicket) {
			const resolve = this._resolveTicket;
			this._resolveTicket = undefined;
			this._reject = undefined;
			resolve(ticket);
		}
	}

	private _fail(err: Error): void {
		if (this._reject) {
			const reject = this._reject;
			this._resolveTicket = undefined;
			this._reject = undefined;
			reject(err);
		}
	}
}
