/*---------------------------------------------------------------------------------------------
 *  UrlSafety — SSRF 防护（对齐 llm_wiki isPrivateNetworkHost + fetchImportUrl）
 *
 *  在所有 URL 请求前调用 validateSafeUrl()：
 *  - 拒绝内网 IP（127./10./172.16-31./192.168.）
 *  - 拒绝嵌入凭据（user:pass@host）
 *  - 拒绝非 http/https scheme
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';

const PRIVATE_IP_RANGES = [
	/^127\./,
	/^10\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^0\.0\.0\.0$/,
	/^localhost$/i,
	/^\[::1\]$/,
	/^\[fe80:/i,
];

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export interface SafetyResult {
	readonly safe: boolean;
	readonly reason?: string;
}

/** 检查 IP 是否为内网地址。 */
export function isPrivateNetworkHost(hostname: string): boolean {
	for (const re of PRIVATE_IP_RANGES) {
		if (re.test(hostname)) { return true; }
	}
	return false;
}

/**
 * 在发起 HTTP 请求前验证 URL 安全性。
 * 对齐 llm_wiki：fetchImportUrl 内的 isPrivateNetworkHost + scheme 检查。
 *
 * @param urlString 待验证的 URL
 * @returns { safe: boolean, reason?: string }
 */
export function validateSafeUrl(urlString: string): SafetyResult {
	if (!urlString || typeof urlString !== 'string') {
		return { safe: false, reason: 'URL is empty or invalid' };
	}

	let uri: URI;
	try {
		uri = URI.parse(urlString.trim());
	} catch {
		return { safe: false, reason: 'Failed to parse URL' };
	}

	// 仅允许 http/https
	if (!ALLOWED_SCHEMES.has(uri.scheme.toLowerCase())) {
		return { safe: false, reason: `Scheme '${uri.scheme}' is not allowed` };
	}

	// 拒绝嵌入凭据（user:pass@host）
	if (uri.authority.includes('@') && uri.authority.indexOf('@') < uri.authority.lastIndexOf('@')) {
		// 最后一个 @ 之前如果有:说明有 user:pass
		const lastAt = uri.authority.lastIndexOf('@');
		const beforeAt = uri.authority.substring(0, lastAt);
		if (beforeAt.includes(':')) {
			return { safe: false, reason: 'URL credentials are not allowed' };
		}
	}

	// 拒绝内网 IP
	const hostname = uri.authority.split('@').pop()?.split(':')[0]?.toLowerCase() ?? '';
	if (hostname && isPrivateNetworkHost(hostname)) {
		return { safe: false, reason: `Host '${hostname}' is a private network address` };
	}

	return { safe: true };
}
