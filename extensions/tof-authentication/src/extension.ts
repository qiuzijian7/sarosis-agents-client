/*---------------------------------------------------------------------------------------------
 *  TOF Authentication — 扩展入口
 *
 *  在扩展宿主进程注册 'tof' 身份提供者。扩展宿主是 Node 环境，
 *  LoopbackAuthServer 和 whoami 调用都直接用 Node http，没有
 *  渲染进程的 sandbox / Mixed Content / CORS 限制。
 *
 *  渲染进程通过 vscode.authentication.getSession('tof', [], { createIfNone: true })
 *  触发本扩展的 createSession()。
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { TofAuthenticationProvider } from './tofAuthProvider';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new TofAuthenticationProvider(context);

	context.subscriptions.push(
		vscode.authentication.registerAuthenticationProvider(
			'tof',
			'腾讯 OA (TOF)',
			provider,
			{ supportsMultipleAccounts: false }
		)
	);
	context.subscriptions.push(provider);

	// ── HTTP 代理命令 ──
	// 渲染进程的 fetch() 受 CORS 限制，无法直接访问外部 HTTP 服务。
	// 此命令在扩展宿主（Node.js 环境）中发起 HTTP 请求，绕过 CORS。
	// 用法: vscode.commands.executeCommand('marketplace.proxyRequest', { url, method, body, headers })
	context.subscriptions.push(
		vscode.commands.registerCommand('marketplace.proxyRequest', async (opts: {
			url: string;
			method: string;
			body?: string;
			headers?: Record<string, string>;
		}): Promise<{ statusCode: number; body: string; headers: Record<string, string> }> => {
			return new Promise((resolve, reject) => {
				const parsed = new URL(opts.url);
				const lib = parsed.protocol === 'https:' ? https : http;
				const reqOptions: http.RequestOptions = {
					hostname: parsed.hostname,
					port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
					path: parsed.pathname + parsed.search,
					method: opts.method || 'GET',
					headers: opts.headers || {},
					timeout: 15000,
				};

				const req = lib.request(reqOptions, (res) => {
					let data = '';
					res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
					res.on('end', () => {
						const respHeaders: Record<string, string> = {};
						for (const [k, v] of Object.entries(res.headers)) {
							if (typeof v === 'string') { respHeaders[k] = v; }
							else if (Array.isArray(v)) { respHeaders[k] = v.join(', '); }
						}
						resolve({ statusCode: res.statusCode || 0, body: data, headers: respHeaders });
					});
				});

				req.on('error', (err) => reject(err));
				req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
				if (opts.body) { req.write(opts.body); }
				req.end();
			});
		})
	);
}

export function deactivate(): void {
	// provider 在 context.subscriptions 中，会被自动 dispose
}
