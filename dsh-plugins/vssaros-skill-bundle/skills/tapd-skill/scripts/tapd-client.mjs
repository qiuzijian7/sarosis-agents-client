/**
 * VsSaros addition: the TAPD Open API client shared by the two bundled TAPD skills
 * (`tapd-skill` and `saroasis-platform`). Both talk only to https://api.tapd.cn:
 * the mcporter-internal MCP login and the intranet platform proxy have been retired.
 *
 * The API account ships with the product (BUNDLED_TAPD_CREDENTIALS), so a fresh install
 * works with no setup. A credentials file or environment variables override it;
 * DSH_SUPERAGENT_TAPD_BUNDLED=off disables the shipped account entirely.
 * Secrets are only ever turned into an Authorization header, never printed or returned.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TAPD_API_BASE = 'https://api.tapd.cn';
export const TAPD_WORKSPACE_DEFAULT = '68880148';

/** The VsSaros TAPD API account, compiled into the shipped skill bundle. */
export const BUNDLED_TAPD_CREDENTIALS = Object.freeze({
	TAPD_CLIENT_ID: 'tapd-app-889817',
	TAPD_CLIENT_SECRET: '6E9C1B81-5443-6CFC-0D84-27C8DAEDB6FB',
});

/** Only these keys may come from a credentials file; nothing else in an `.env` reaches the skill. */
export const TAPD_ENV_KEYS = Object.freeze([
	'DSH_SUPERAGENT_TAPD_BEARER', 'DSH_SUPERAGENT_TAPD_USER', 'DSH_SUPERAGENT_TAPD_PASSWORD',
	'TAPD_CLIENT_ID', 'TAPD_CLIENT_SECRET', 'TAPD_API_USER', 'TAPD_API_PWD', 'TAPD_API_TOKEN',
	'TAPD_API_BASE', 'TAPD_WORKSPACE_ID', 'TAPD_HTTP_TIMEOUT_MS', 'DSH_SUPERAGENT_TAPD_BUNDLED',
]);
const LINE = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i;

/** `KEY=VALUE` lines, quotes and `#` comments; unknown keys are dropped. */
export function parseTapdEnv(text) {
	const values = {};
	for (const line of String(text ?? '').split(/\r?\n/)) {
		const match = LINE.exec(line);
		if (!match) { continue; }
		const key = match[1].toUpperCase();
		if (!TAPD_ENV_KEYS.includes(key)) { continue; }
		let value = match[2] ?? '';
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		values[key] = value;
	}
	return values;
}

/** An explicit file, else `<DSH_HOME>/tapd.env`, else `~/.vssaros/dsh-home/tapd.env`. */
export function tapdEnvFile(env = process.env) {
	const explicit = env.TAPD_ENV_FILE || env.DSH_SUPERAGENT_TAPD_ENV_FILE;
	if (explicit) { return String(explicit); }
	const home = env.DSH_HOME || join(homedir(), '.vssaros', 'dsh-home');
	return join(String(home), 'tapd.env');
}

/** Shipped account (lowest priority), then the credentials file, then the process environment. */
export function tapdEnvironment(base = process.env) {
	const bundled = String(base.DSH_SUPERAGENT_TAPD_BUNDLED ?? '').trim().toLowerCase() === 'off'
		? {} : BUNDLED_TAPD_CREDENTIALS;
	let file = {};
	try { file = parseTapdEnv(readFileSync(tapdEnvFile(base), 'utf8')); } catch { /* A missing file is fine. */ }
	return { ...bundled, ...file, ...base };
}

const basic = (user, password, method) => ({ header: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, method });

/** Five accepted credentials, highest priority first. Throws when the shipped account is off and none is set. */
export function tapdAuthorization(env) {
	if (env.DSH_SUPERAGENT_TAPD_BEARER) { return { header: `Bearer ${env.DSH_SUPERAGENT_TAPD_BEARER}`, method: 'Bearer DSH_SUPERAGENT_TAPD_BEARER' }; }
	if (env.DSH_SUPERAGENT_TAPD_USER && env.DSH_SUPERAGENT_TAPD_PASSWORD) {
		return basic(env.DSH_SUPERAGENT_TAPD_USER, env.DSH_SUPERAGENT_TAPD_PASSWORD, 'Basic DSH_SUPERAGENT_TAPD_USER/PASSWORD');
	}
	if (env.TAPD_CLIENT_ID && env.TAPD_CLIENT_SECRET) { return basic(env.TAPD_CLIENT_ID, env.TAPD_CLIENT_SECRET, 'Basic TAPD_CLIENT_ID/SECRET (shipped API account)'); }
	if (env.TAPD_API_USER && env.TAPD_API_PWD) { return basic(env.TAPD_API_USER, env.TAPD_API_PWD, 'Basic TAPD_API_USER/PWD'); }
	if (env.TAPD_API_TOKEN) { return { header: `Bearer ${env.TAPD_API_TOKEN}`, method: 'Bearer TAPD_API_TOKEN' }; }
	throw new Error('No TAPD Open API credentials. Set TAPD_CLIENT_ID + TAPD_CLIENT_SECRET, or remove '
		+ 'DSH_SUPERAGENT_TAPD_BUNDLED=off to use the account shipped with VsSaros.');
}

/** TAPD answers unknown paths with HTTP 200 and this string; treat it as a failure. */
export function parseTapdResponse(text, { pathname = '', httpStatus = 200, tapd = true } = {}) {
	let json;
	try { json = JSON.parse(text); } catch { throw new Error(`TAPD returned non-JSON (HTTP ${httpStatus}): ${String(text).slice(0, 200)}`); }
	if (!tapd) { return json; }
	if (typeof json?.data === 'string' && /Hello world from TAPD API/i.test(json.data)) {
		throw new Error(`接口不存在：${pathname}（TAPD 对未知路径返回 "Hello world"，不是数据）`);
	}
	if (json?.status !== 1) { throw new Error(`TAPD 返回失败：${String(text).slice(0, 300)}`); }
	return json;
}

/**
 * One TAPD Open API request. GET puts the fields in the query, POST sends them as
 * `application/x-www-form-urlencoded` (the format TAPD's Open API accepts).
 */
export async function tapdRequest({
	method = 'GET', pathname, params = {}, base = TAPD_API_BASE, workspace = TAPD_WORKSPACE_DEFAULT,
	env = process.env, fetchImpl = globalThis.fetch, timeoutMs, authorization, tapd = true,
}) {
	const fields = new URLSearchParams();
	if (tapd) { fields.set('workspace_id', String(workspace)); }
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null && value !== '') { fields.set(key, String(value)); }
	}
	const query = fields.toString();
	const url = `${String(base).replace(/\/+$/, '')}${pathname}${method === 'GET' && query ? '?' + query : ''}`;
	const auth = authorization ?? tapdAuthorization(tapdEnvironment(env));
	const shown = `${method} ${pathname}${query ? '?' + decodeURIComponent(query.replace(/\+/g, ' ')) : ''}`;
	const timeout = Math.max(3000, Number(timeoutMs) || Number(env.TAPD_HTTP_TIMEOUT_MS) || 20000);
	let res;
	try {
		res = await fetchImpl(url, { method, signal: AbortSignal.timeout(timeout),
			headers: { authorization: auth.header, accept: 'application/json',
				...method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {} },
			...method === 'POST' ? { body: query } : {} });
	} catch (e) {
		throw new Error(`请求失败（网络或超时 ${timeout}ms）：${e?.message ?? e}\n  ${shown}`);
	}
	const text = await res.text();
	if (res.status === 401 || res.status === 403) { throw new Error(`TAPD 拒绝了凭据（HTTP ${res.status}）：检查 ${auth.method}`); }
	if (!res.ok) { throw new Error(`HTTP ${res.status}：${text.slice(0, 300)}\n  ${shown}`); }
	return { json: parseTapdResponse(text, { pathname, httpStatus: res.status, tapd }), shown, url, method: auth.method };
}

/** A client bound to one base/workspace, for callers that issue many requests. */
export function createTapdClient(options = {}) {
	const { base = TAPD_API_BASE, workspace = TAPD_WORKSPACE_DEFAULT, env = process.env, fetchImpl = globalThis.fetch } = options;
	const auth = tapdAuthorization(tapdEnvironment(env));
	const request = (method, pathname, params, extra = {}) => tapdRequest({ method, pathname, params,
		base, workspace, fetchImpl, authorization: auth, ...extra });
	return { request, auth, base, workspace };
}
