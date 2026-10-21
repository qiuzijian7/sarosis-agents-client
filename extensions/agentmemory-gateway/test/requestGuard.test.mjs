/*---------------------------------------------------------------------------------------------
 *  requestGuard.mjs 单测（2026-10-20）
 *
 *  运行：node --test extensions/agentmemory-gateway/test/
 *
 *  钉住的是「网页能不能调网关的写接口」。两头都不能错：
 *   · 判松 ⇒ 本机任意网页可跨域删记忆（修复前的现状：CORS `*` + 无鉴权）；
 *   · 判严 ⇒ IDE 自己的渲染进程（`vscode-file://vscode-app`）或 dsh 插件（Node，无 Origin）被挡 ⇒
 *     记忆页/注入整体失效。
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import test from 'node:test';

import { checkRequest, isAllowedOrigin, isLoopbackHost, parseAllowedOrigins } from '../host/requestGuard.mjs';

const NONE = parseAllowedOrigins(undefined);
const policy = (extra = NONE, bindHost) => ({ bindHost, allowed: extra });
const H = 'localhost:3112';

test('无 Origin（Node 客户端：dsh 插件 / 主进程探活 / curl）⇒ 放行，且不回 CORS 头', () => {
	const v = checkRequest({ host: '127.0.0.1:3112' }, policy());
	assert.deepEqual(v, { ok: true });
});

test('IDE 渲染进程与 webview ⇒ 放行，并回显 Origin（不是 *）', () => {
	assert.deepEqual(checkRequest({ origin: 'vscode-file://vscode-app', host: H }, policy()), { ok: true, allowOrigin: 'vscode-file://vscode-app' });
	const wv = checkRequest({ origin: 'vscode-webview://1a2b3c', host: H }, policy());
	assert.equal(wv.ok, true);
	assert.equal(wv.allowOrigin, 'vscode-webview://1a2b3c');
});

test('★ 普通网页 / null / 伪装前缀 ⇒ 403', () => {
	for (const origin of ['https://evil.example', 'http://127.0.0.1:6944', 'null', 'vscode-file://vscode-app.evil.com', 'vscode-webview://', 'file://']) {
		const v = checkRequest({ origin, host: H }, policy());
		assert.equal(v.ok, false, origin);
		assert.equal(v.status, 403, origin);
	}
});

test('AGENTMEMORY_ALLOWED_ORIGINS：精确匹配扩展；* 恢复全放行', () => {
	const extra = parseAllowedOrigins(' http://127.0.0.1:6944 , https://a.example ');
	assert.equal(isAllowedOrigin('http://127.0.0.1:6944', extra), true);
	assert.equal(isAllowedOrigin('http://127.0.0.1:69440', extra), false);
	assert.equal(checkRequest({ origin: 'https://whatever', host: H }, policy(parseAllowedOrigins('*'))).ok, true);
});

test('★ DNS rebinding：回环绑定时 Host 必须是回环地址', () => {
	const v = checkRequest({ host: 'attacker.example:3112' }, policy());
	assert.equal(v.ok, false);
	assert.equal(v.status, 421);
	assert.equal(checkRequest({ host: undefined }, policy()).ok, false, '缺 Host 也拒（HTTP/1.1 必带）');
	for (const h of ['127.0.0.1:3112', 'localhost:3111', '[::1]:3112', 'LOCALHOST']) {
		assert.equal(isLoopbackHost(h), true, h);
	}
	assert.equal(isLoopbackHost('127.0.0.1.evil.com'), false);
});

test('mesh 跨机（AGENTMEMORY_HOST=0.0.0.0）⇒ 不查 Host（对端用局域网 IP 访问），Origin 规则照旧', () => {
	assert.equal(checkRequest({ host: '192.168.1.20:3111' }, policy(NONE, '0.0.0.0')).ok, true);
	assert.equal(checkRequest({ host: '192.168.1.20:3111', origin: 'https://evil.example' }, policy(NONE, '0.0.0.0')).ok, false);
});
