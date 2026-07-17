/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioLogService } from './agentStudioLogService.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ITofAuthService } from '../common/tofAuth.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { Platform, platform } from '../../../../base/common/platform.js';

export type FeedbackType = 'bug' | 'feature';

export interface IFeedbackData {
	type: FeedbackType;
	description: string;
	/** base64 data-URL list of screenshots */
	images: string[];
}

export interface IFeedbackResult {
	success: boolean;
	issueUrl?: string;
	issueIid?: number;
	openedInBrowser?: boolean;
	error?: string;
}

export interface IFeedbackUserInfo {
	loginName: string;
	staffId: string;
	team: string | null;
}

export interface IFeedbackVersionInfo {
	version: string;
	commit: string;
	platform: string;
}

export const IFeedbackService = createDecorator<IFeedbackService>('feedbackService');

export interface IFeedbackService {
	readonly _serviceBrand: undefined;
	getUserInfo(): IFeedbackUserInfo | null;
	getVersionInfo(): IFeedbackVersionInfo;
	submitFeedback(data: IFeedbackData): Promise<IFeedbackResult>;
}

const GONGFENG_BASE = 'https://git.woa.com';
const GONGFENG_API = `${GONGFENG_BASE}/api/v4`;
const GONGFENG_PROJECT_PATH = 'zijianqiu%2Fvssaros-agents-client';
const TOKEN_STORAGE_KEY = 'feedback.gongfengToken';

export class FeedbackService extends Disposable implements IFeedbackService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IAgentStudioLogService private readonly logService: ILogService,
		@IRequestService private readonly requestService: IRequestService,
		@IProductService private readonly productService: IProductService,
		@ITofAuthService private readonly tofAuthService: ITofAuthService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
	}

	getUserInfo(): IFeedbackUserInfo | null {
		const user = this.tofAuthService.currentUser;
		if (!user) { return null; }
		return { loginName: user.login_name, staffId: user.staff_id, team: user.team };
	}

	getVersionInfo(): IFeedbackVersionInfo {
		const plat = platform === Platform.Windows ? 'win32-x64'
			: platform === Platform.Mac ? 'darwin-arm64' : 'linux-x64';
		return {
			version: this.productService.version,
			commit: (this.productService as { commit?: string }).commit ?? 'unknown',
			platform: plat,
		};
	}

	// ── OAuth2: auto-obtain Gongfeng access token ───────────────────

	/**
	 * Obtain a Gongfeng access token via OAuth2 client_credentials grant.
	 * Token is cached in IStorageService (valid 2h, refreshed automatically).
	 *
	 * Requires `gongfengClientId` + `gongfengClientSecret` in product.json
	 * (developer registers an OAuth app in Gongfeng once, then all users
	 *  get automatic authentication — no manual token setup needed).
	 */
	private async _getAccessToken(): Promise<string | null> {
		// 1. Check cache
		const cached = this.storageService.get(TOKEN_STORAGE_KEY, StorageScope.APPLICATION);
		if (cached) {
			try {
				const { token, expiresAt } = JSON.parse(cached) as { token: string; expiresAt: number };
				if (Date.now() < expiresAt) {
					this.logService.info('[Feedback] Using cached Gongfeng token');
					return token;
				}
			} catch { /* invalid cache, fall through */ }
		}

		// 2. Get new token via client_credentials
		const clientId = (this.productService as { gongfengClientId?: string }).gongfengClientId;
		const clientSecret = (this.productService as { gongfengClientSecret?: string }).gongfengClientSecret;
		if (!clientId || !clientSecret) {
			this.logService.warn('[Feedback] Gongfeng OAuth client_id/secret not configured in product.json');
			return null;
		}

		try {
			this.logService.info('[Feedback] Requesting Gongfeng access token via OAuth2 client_credentials');
			const response = await this.requestService.request({
				url: `${GONGFENG_BASE}/oauth/token`,
				type: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				data: `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`,
			} as any, CancellationToken.None);

			const buffer = await streamToBuffer(response.stream);
			const body = JSON.parse(buffer.toString());

			if (response.res.statusCode === 200 && body.access_token) {
				const expiresIn = (body.expires_in as number) ?? 7200;
				const expiresAt = Date.now() + expiresIn * 1000 - 60_000; // 1 min safety buffer
				this.storageService.store(TOKEN_STORAGE_KEY,
					JSON.stringify({ token: body.access_token, expiresAt }),
					StorageScope.APPLICATION, StorageTarget.MACHINE);
				this.logService.info('[Feedback] Gongfeng token obtained, expires in', expiresIn, 's');
				return body.access_token as string;
			} else {
				this.logService.warn('[Feedback] Token request failed:', response.res.statusCode, body.error ?? body.message);
				return null;
			}
		} catch (err) {
			this.logService.error('[Feedback] Token request error:', err);
			return null;
		}
	}

	// ── Submit feedback ──────────────────────────────────────────────

	async submitFeedback(data: IFeedbackData): Promise<IFeedbackResult> {
		const user = this.tofAuthService.currentUser;
		if (!user) {
			return { success: false, error: '未登录，请先登录 TOF 账号' };
		}

		const version = this.getVersionInfo();
		const typeLabel = data.type === 'bug' ? 'Bug 报告' : '需求建议';
		const labels = data.type === 'bug' ? 'bug' : 'feature-request';

		// 2. Build title
		const titlePrefix = data.type === 'bug' ? '[Bug]' : '[Feature]';
		const titleSummary = data.description.slice(0, 60).replace(/[\r\n]+/g, ' ');
		const title = `${titlePrefix} ${titleSummary}${data.description.length > 60 ? '...' : ''}`;

		// 3. Build description (Markdown)
		let description = `## 反馈信息\n\n`;
		description += `| 字段 | 值 |\n`;
		description += `|------|------|\n`;
		description += `| 类型 | ${typeLabel} |\n`;
		description += `| 提交者 | ${user.login_name} |\n`;
		description += `| Staff ID | ${user.staff_id} |\n`;
		description += `| 团队 | ${user.team ?? 'N/A'} |\n`;
		description += `| 版本 | v${version.version} (${version.commit.slice(0, 8)}) |\n`;
		description += `| 平台 | ${version.platform} |\n`;
		description += `| 提交时间 | ${new Date().toISOString()} |\n\n`;
		description += `## 问题描述\n\n${data.description}\n`;

		// 4. Try MCP method first (no token needed, uses Gongfeng MCP server)
		const mcpResult = await this._submitViaMcp(title, description, labels, data.images);
		if (mcpResult) {
			return mcpResult;
		}

		// 5. Fallback: OAuth2 API method
		const token = await this._getAccessToken();
		if (!token) {
			// No OAuth config → open Gongfeng new issue page in browser (OA SSO auto-login)
			return await this._openInBrowser(title, description, data.images.length);
		}

		// 5. Upload images (if any)
		if (data.images.length > 0) {
			description += `\n## 截图\n\n`;
			for (let i = 0; i < data.images.length; i++) {
				const uploadResult = await this._uploadImage(data.images[i], token);
				if (uploadResult.markdown) {
					description += `${uploadResult.markdown}\n\n`;
				} else {
					description += `> 截图 ${i + 1} 上传失败: ${uploadResult.error ?? 'unknown'}\n\n`;
				}
			}
		}

		// 5. Create issue via GitLab API v4
		try {
			const url = `${GONGFENG_API}/projects/${GONGFENG_PROJECT_PATH}/issues`;
			this.logService.info('[Feedback] Creating issue:', title);

			const response = await this.requestService.request({
				url,
				type: 'POST',
				headers: {
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				data: JSON.stringify({ title, description, labels }),
			} as any, CancellationToken.None);

			const buffer = await streamToBuffer(response.stream);
			const body = JSON.parse(buffer.toString());

			if (response.res.statusCode === 201 || response.res.statusCode === 200) {
				this.logService.info('[Feedback] Issue created:', body.iid, body.web_url);
				return { success: true, issueUrl: body.web_url, issueIid: body.iid };
			} else {
				const errMsg = typeof body.message === 'string'
					? body.message
					: Array.isArray(body.message) ? body.message.join('; ') : `HTTP ${response.res.statusCode}`;
				this.logService.warn('[Feedback] Issue creation failed:', errMsg);
				return { success: false, error: errMsg };
			}
		} catch (err) {
			this.logService.error('[Feedback] Request error:', err);
			return { success: false, error: String(err) };
		}
	}

	// ── Image upload (via globalThis.require('https')) ──────────────

	/**
	 * Upload a screenshot to Gongfeng project uploads API.
	 *
	 * Uses `globalThis.require('https')` to send multipart/form-data directly
	 * from the renderer process — same pattern as MarketplaceService.rawUpload().
	 * IRequestService doesn't support binary multipart bodies, so we bypass it.
	 *
	 * If `require` is unavailable (sandbox mode), returns an error and the
	 * issue description will note the screenshot could not be uploaded.
	 */
	private async _uploadImage(dataUrl: string, token: string): Promise<{ markdown?: string; error?: string }> {
		try {
			const g = globalThis as unknown as { require?: (module: string) => unknown };
			if (typeof g.require !== 'function') {
				return { error: 'require unavailable (sandbox)' };
			}
			const https = g.require('https') as typeof import('https');

			// Parse data URL: "data:image/png;base64,...."
			const match = dataUrl.match(/^data:(image\/[\w+]+);base64,(.+)$/);
			if (!match) { return { error: 'invalid data URL' }; }
			const mimeType = match[1];
			const base64Data = match[2];
			const ext = mimeType.split('/')[1].replace('+xml', '');
			const filename = `screenshot-${Date.now()}.${ext}`;

			// Construct multipart/form-data body
			const fileBuffer = Buffer.from(base64Data, 'base64');
			const boundary = '----FeedbackBoundary' + Math.random().toString(16).slice(2);
			const headerPart = Buffer.from(
				`--${boundary}\r\n` +
				`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
				`Content-Type: ${mimeType}\r\n\r\n`
			);
			const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`);
			const body = Buffer.concat([headerPart, fileBuffer, footerPart]);

			// Send HTTPS request
			return new Promise((resolve) => {
				const req = https.request({
					hostname: 'git.woa.com',
					port: 443,
					path: `/api/v4/projects/${GONGFENG_PROJECT_PATH}/uploads`,
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${token}`,
						'Content-Type': `multipart/form-data; boundary=${boundary}`,
						'Content-Length': body.length,
					},
				}, (res: import('http').IncomingMessage) => {
					let data = '';
					res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
					res.on('end', () => {
						if (res.statusCode === 201 || res.statusCode === 200) {
							try {
								const json = JSON.parse(data);
								resolve({ markdown: json.markdown });
							} catch {
								resolve({ error: 'parse error' });
							}
						} else {
							resolve({ error: `HTTP ${res.statusCode}` });
						}
					});
				});
				req.on('error', (err: Error) => resolve({ error: String(err) }));
				req.setTimeout(30_000, () => { req.destroy(); resolve({ error: 'timeout' }); });
				req.write(body);
				req.end();
			});
		} catch (err) {
			return { error: String(err) };
		}
	}

	// ── MCP method (no token needed, uses Gongfeng MCP HTTP gateway) ──

	/**
	 * Create issue via Gongfeng MCP HTTP gateway (mcpgw.knot.woa.com).
	 * Calls MCP JSON-RPC protocol directly via IRequestService — no need
	 * for the MCP server to be enabled in IMcpService.
	 *
	 * Flow: initialize → notifications/initialized → tools/call(create_issue)
	 *
	 * Returns null if MCP unavailable, so caller can fallback.
	 */
	private async _submitViaMcp(title: string, description: string, labels: string, images: string[]): Promise<IFeedbackResult | null> {
		const mcpUrl = 'https://mcpgw.knot.woa.com/gongfeng';

		let fullDescription = description;
		if (images.length > 0) {
			fullDescription += `\n\n---\n*附有 ${images.length} 张截图*`;
		}

		try {
			// 1. Initialize MCP session
			this.logService.info('[Feedback] MCP: initializing session...');
			const initRes = await this.requestService.request({
				url: mcpUrl,
				type: 'POST',
				headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
				data: JSON.stringify({
					jsonrpc: '2.0',
					method: 'initialize',
					params: {
						protocolVersion: '2024-11-05',
						capabilities: {},
						clientInfo: { name: 'vscode-feedback', version: '1.0' },
					},
					id: 0,
				}),
				callSite: 'feedback',
			}, CancellationToken.None);

			await streamToBuffer(initRes.stream); // drain
			this.logService.info('[Feedback] MCP: init response status', initRes.res.statusCode);

			// Extract session ID from response headers (HTTP headers are case-insensitive)
			const sessionId = (initRes.res.headers['mcp-session-id'] as string | undefined)
				?? (initRes.res.headers['Mcp-Session-Id'] as string | undefined);

			const reqHeaders: Record<string, string> = {
				'Content-Type': 'application/json',
				'Accept': 'application/json, text/event-stream',
			};
			if (sessionId) { reqHeaders['Mcp-Session-Id'] = sessionId; }

			// 2. Send initialized notification (no id, no response expected)
			await this.requestService.request({
				url: mcpUrl,
				type: 'POST',
				headers: reqHeaders,
				data: JSON.stringify({
					jsonrpc: '2.0',
					method: 'notifications/initialized',
				}),
				callSite: 'feedback',
			}, CancellationToken.None);

			// 3. Call create_issue tool
			this.logService.info('[Feedback] MCP: calling create_issue...');
			const callRes = await this.requestService.request({
				url: mcpUrl,
				type: 'POST',
				headers: reqHeaders,
				data: JSON.stringify({
					jsonrpc: '2.0',
					method: 'tools/call',
					params: {
						name: 'create_issue',
						arguments: {
							project_id: 'zijianqiu/vssaros-agents-client',
							title,
							description: fullDescription,
							labels,
						},
					},
					id: 1,
				}),
				callSite: 'feedback',
			}, CancellationToken.None);

			const callBuffer = await streamToBuffer(callRes.stream);
			let callText = callBuffer.toString();

			// Handle SSE response format (text/event-stream)
			const callContentType = (callRes.res.headers['content-type'] as string) || '';
			if (callContentType.includes('text/event-stream')) {
				const dataLines = callText.split('\n')
					.filter(line => line.startsWith('data:'))
					.map(line => line.slice(5).trim());
				if (dataLines.length > 0) {
					callText = dataLines.join('\n');
				}
			}

			this.logService.info('[Feedback] MCP: call response', callRes.res.statusCode, callContentType, callText.slice(0, 200));

			if (callRes.res.statusCode !== 200) {
				this.logService.warn('[Feedback] MCP: call failed, HTTP', callRes.res.statusCode, callText.slice(0, 200));
				return null;
			}

			// Parse JSON-RPC response
			let jsonResult: { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
			try {
				jsonResult = JSON.parse(callText);
			} catch {
				this.logService.warn('[Feedback] MCP: response not JSON:', callText.slice(0, 200));
				return null;
			}

			if (jsonResult.error) {
				this.logService.warn('[Feedback] MCP: RPC error:', jsonResult.error.message);
				return null;
			}

			// Extract tool result text
			const content = jsonResult.result?.content;
			if (!Array.isArray(content)) {
				this.logService.warn('[Feedback] MCP: no content in result');
				return null;
			}

			const resultText = content.map(c => c.text || '').join('\n').trim();
			this.logService.info('[Feedback] MCP: result text:', resultText.slice(0, 200));

			// Try to parse as JSON to extract issue URL
			try {
				const issueData = JSON.parse(resultText);
				return {
					success: true,
					issueUrl: issueData.web_url || issueData.url,
					issueIid: issueData.iid,
				};
			} catch {
				// If not JSON, check if text contains a URL
				const urlMatch = resultText.match(/https?:\/\/[^\s]+/);
				if (urlMatch) {
					return { success: true, issueUrl: urlMatch[0] };
				}
				this.logService.warn('[Feedback] MCP: could not parse issue URL from result');
				return null;
			}
		} catch (err) {
			this.logService.warn('[Feedback] MCP HTTP call failed:', err);
			return null;
		}
	}

	// ── Browser fallback (no OAuth config needed) ───────────────────

	/**
	 * Open Gongfeng's "new issue" page in the system browser with title and
	 * description pre-filled. Relies on OA SSO: if the user is already logged
	 * into OA in their browser, Gongfeng auto-logs-in — no token needed.
	 *
	 * Screenshots cannot be passed via URL; the description notes how many
	 * screenshots were attached and asks the user to upload them manually.
	 */
	private async _openInBrowser(title: string, description: string, imageCount: number): Promise<IFeedbackResult> {
		const fullDescription = imageCount > 0
			? `${description}\n\n---\n*附有 ${imageCount} 张截图，请在浏览器中手动上传*`
			: description;

		// Copy title + description to clipboard because URL params get over-encoded
		// by Electron's window.open pipeline (issue[title] → issue%5Btitle%5D).
		try {
			await navigator.clipboard.writeText(`${title}\n\n${fullDescription}`);
		} catch { /* clipboard may not be available in all contexts */ }

		// Open blank new-issue page — user pastes from clipboard.
		const url = `${GONGFENG_BASE}/zijianqiu/vssaros-agents-client/issues/new`;
		this.logService.info('[Feedback] Opening Gongfeng new issue in browser (OA SSO, no OAuth config)');
		window.open(url, '_blank');
		return { success: true, openedInBrowser: true };
	}
}
