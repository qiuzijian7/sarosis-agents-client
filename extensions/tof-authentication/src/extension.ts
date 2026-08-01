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
import * as fs from 'fs';
import { URL } from 'url';
import { execFile } from 'child_process';
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
	// 支持自动跟随重定向（最多 5 次）。
	// 用法: vscode.commands.executeCommand('marketplace.proxyRequest', { url, method, body, headers })
	context.subscriptions.push(
		vscode.commands.registerCommand('marketplace.proxyRequest', async (opts: {
			url: string;
			method: string;
			body?: string;
			headers?: Record<string, string>;
			binary?: boolean;
		}): Promise<{ statusCode: number; body: string; headers: Record<string, string> }> => {
			const doRequest = (reqUrl: string, redirectCount: number): Promise<{ statusCode: number; body: string; headers: Record<string, string> }> => {
				return new Promise((resolve, reject) => {
					if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }
					const parsed = new URL(reqUrl);
					const lib = parsed.protocol === 'https:' ? https : http;
					// Auto-add Content-Length for POST/PUT with body (prevents socket hang up)
					const finalHeaders: Record<string, string> = { ...opts.headers };
					if (opts.body && opts.body.length > 0 && !finalHeaders['Content-Length'] && !finalHeaders['content-length']) {
						finalHeaders['Content-Length'] = String(Buffer.byteLength(opts.body, 'utf-8'));
					}
					const reqOptions: http.RequestOptions = {
						hostname: parsed.hostname,
						port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
						path: parsed.pathname + parsed.search,
						method: opts.method || 'GET',
						headers: finalHeaders,
						timeout: 30000,
					};

					const req = lib.request(reqOptions, (res) => {
						// 跟随重定向 (301/302/303/307/308)
						if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
							const redirectUrl = new URL(res.headers.location, reqUrl).href;
							res.resume(); // 丢弃当前响应体
							doRequest(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
							return;
						}
						const chunks: Buffer[] = [];
						res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
						res.on('end', () => {
							const buf = Buffer.concat(chunks);
							const respHeaders: Record<string, string> = {};
							for (const [k, v] of Object.entries(res.headers)) {
								if (typeof v === 'string') { respHeaders[k] = v; }
								else if (Array.isArray(v)) { respHeaders[k] = v.join(', '); }
							}
							// binary 模式返回 base64，否则返回字符串
							const body = opts.binary ? buf.toString('base64') : buf.toString('utf-8');
							resolve({ statusCode: res.statusCode || 0, body, headers: respHeaders });
						});
					});

					req.on('error', (err) => reject(err));
					req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
					if (opts.body) { req.write(opts.body); }
					req.end();
				});
			};
			return doRequest(opts.url, 0);
		})
	);

	// Extract tar.gz file in the extension host (Node.js environment)
	// Usage: vscode.commands.executeCommand('marketplace.extractTar', { tarFile, extractDir })
	context.subscriptions.push(
		vscode.commands.registerCommand('marketplace.extractTar', async (opts: {
			tarFile: string;
			extractDir: string;
		}): Promise<void> => {
			// Ensure extract dir exists
			fs.mkdirSync(opts.extractDir, { recursive: true });

			return new Promise((resolve, reject) => {
				execFile('tar', ['-xzf', opts.tarFile, '-C', opts.extractDir], (err) => {
					if (err) {
						reject(new Error(`tar extraction failed: ${err.message}`));
					} else {
						resolve();
					}
				});
			});
		})
	);

	// Create tar.gz from a directory in the extension host (for publish)
	// Usage: vscode.commands.executeCommand('marketplace.createTar', { sourceDir, outputFile })
	// 排除规则：不打包 VCS 元数据、编译缓存、系统垃圾文件，避免泄漏本地 git 历史与机器相关产物
	const TAR_EXCLUDES = ['.git', '.svn', '.hg', '__pycache__', '*.pyc', '*.pyo', '.DS_Store', 'Thumbs.db'];
	context.subscriptions.push(
		vscode.commands.registerCommand('marketplace.createTar', async (opts: {
			sourceDir: string;
			outputFile: string;
		}): Promise<void> => {
			return new Promise((resolve, reject) => {
				const args = [...TAR_EXCLUDES.map(e => `--exclude=${e}`), '-czf', opts.outputFile, '-C', opts.sourceDir, '.'];
				execFile('tar', args, (err) => {
					if (err) {
						reject(new Error(`tar compression failed: ${err.message}`));
					} else {
						resolve();
					}
				});
			});
		})
	);

	// Stream download HTTP response directly to file (avoids IPC for large files)
	// Usage: vscode.commands.executeCommand('marketplace.downloadToFile', { url, headers, savePath })
	context.subscriptions.push(
		vscode.commands.registerCommand('marketplace.downloadToFile', async (opts: {
			url: string;
			headers?: Record<string, string>;
			savePath: string;
		}): Promise<{ statusCode: number; headers: Record<string, string> }> => {
			return new Promise((resolve, reject) => {
				const doDownload = (reqUrl: string, redirectCount: number) => {
					if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }
					const parsed = new URL(reqUrl);
					const lib = parsed.protocol === 'https:' ? https : http;
					const req = lib.request(parsed, {
						method: 'GET',
						headers: opts.headers || {},
						timeout: 300000, // 5 min for large files
					}, (res) => {
						if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
							res.resume();
							doDownload(new URL(res.headers.location, reqUrl).href, redirectCount + 1);
							return;
						}
						if (res.statusCode && res.statusCode >= 400) {
							reject(new Error(`HTTP ${res.statusCode}`));
							return;
						}
						const writeStream = fs.createWriteStream(opts.savePath);
						res.pipe(writeStream);
						writeStream.on('finish', () => {
							writeStream.close();
							const respHeaders: Record<string, string> = {};
							for (const [k, v] of Object.entries(res.headers)) {
								if (typeof v === 'string') { respHeaders[k] = v; }
							}
							resolve({ statusCode: res.statusCode ?? 0, headers: respHeaders });
						});
						writeStream.on('error', reject);
					});
					req.on('error', reject);
					req.on('timeout', () => { req.destroy(new Error('Download timeout')); });
					req.end();
				};
				doDownload(opts.url, 0);
			});
		})
	);

	// Stream upload a file via HTTP POST (avoids IPC for large files)
	// Usage: vscode.commands.executeCommand('marketplace.uploadFromFile', { url, filePath, headers })
	context.subscriptions.push(
		vscode.commands.registerCommand('marketplace.uploadFromFile', async (opts: {
			url: string;
			filePath: string;
			headers?: Record<string, string>;
		}): Promise<{ statusCode: number; text: string }> => {
			return new Promise((resolve, reject) => {
				const stat = fs.statSync(opts.filePath);
				const parsed = new URL(opts.url);
				const lib = parsed.protocol === 'https:' ? https : http;
				const reqOptions: http.RequestOptions = {
					hostname: parsed.hostname,
					port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
					path: parsed.pathname + parsed.search,
					method: 'POST',
					headers: { ...opts.headers, 'Content-Length': stat.size },
					timeout: 300000, // 5 min for large files
				};
				const req = lib.request(reqOptions, (res) => {
					let data = '';
					res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
					res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, text: data }));
				});
				req.on('error', reject);
				req.on('timeout', () => { req.destroy(new Error('Upload timeout')); });
				// Stream file to request
				const readStream = fs.createReadStream(opts.filePath);
				readStream.pipe(req);
				readStream.on('error', reject);
			});
		})
	);
}

export function deactivate(): void {
	// provider 在 context.subscriptions 中，会被自动 dispose
}
