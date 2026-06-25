/*---------------------------------------------------------------------------------------------
 *  Tof 网关客户端 — 调 /api/v1/whoami 验证 ticket 并获取用户身份
 *
 *  扩展宿主进程是 Node 环境，可直接 import http/https，没有渲染进程的
 *  Mixed Content / CORS 限制（"Failed to fetch"）。
 *--------------------------------------------------------------------------------------------*/
import * as http from 'http';
import * as https from 'https';
import { ITofUser, TofAuthError } from './types';

export interface IWhoamiResult {
	statusCode: number;
	body: string;
}

/**
 * 调用网关 /api/v1/whoami。
 * @param ticket x-tai-identity 票据
 * @param gatewayBaseUrl 网关 base URL，例如 http://21.169.46.116:8080
 */
export async function fetchWhoami(ticket: string, gatewayBaseUrl: string): Promise<ITofUser> {
	const url = `${gatewayBaseUrl.replace(/\/$/, '')}/api/v1/whoami`;
	const result = await sendGet(url, { 'x-tai-identity': ticket, 'Accept': 'application/json' });

	if (result.statusCode === 401) {
		let detail = '';
		try {
			const errData = JSON.parse(result.body) as { detail?: { message?: string }; message?: string };
			detail = errData?.detail?.message ?? errData?.message ?? '';
		} catch { /* ignore */ }
		throw new TofAuthError(`网关拒绝了凭据（401）：${detail}`, 'identity_rejected');
	}
	if (result.statusCode >= 400) {
		throw new TofAuthError(`whoami 失败：HTTP ${result.statusCode}`, 'whoami_failed');
	}

	let data: Partial<ITofUser>;
	try {
		data = JSON.parse(result.body) as Partial<ITofUser>;
	} catch {
		throw new TofAuthError('whoami 返回数据无法解析为 JSON', 'whoami_invalid');
	}
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
}

function sendGet(url: string, headers: Record<string, string>): Promise<IWhoamiResult> {
	return new Promise((resolve, reject) => {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch (e) {
			reject(new TofAuthError(`无效 URL: ${url}`, 'invalid_url'));
			return;
		}

		const isHttps = parsed.protocol === 'https:';
		const requestFn = isHttps ? https.request : http.request;
		const options = {
			hostname: parsed.hostname,
			port: parsed.port || (isHttps ? 443 : 80),
			path: `${parsed.pathname}${parsed.search}`,
			method: 'GET',
			headers,
		};

		const timeoutHandle = setTimeout(() => {
			clientReq.destroy();
			reject(new TofAuthError('whoami 请求超时（30s）', 'whoami_timeout'));
		}, 30000);

		const clientReq = requestFn(options, (res: http.IncomingMessage) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => { body += chunk; });
			res.on('end', () => {
				clearTimeout(timeoutHandle);
				resolve({ statusCode: res.statusCode ?? 0, body });
			});
		});

		clientReq.on('error', (err: Error) => {
			clearTimeout(timeoutHandle);
			reject(new TofAuthError(`whoami 请求失败：${err.message}`, 'gateway_unreachable'));
		});

		clientReq.end();
	});
}
