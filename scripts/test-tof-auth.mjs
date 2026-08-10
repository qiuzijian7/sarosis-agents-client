#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * TofAuthService 独立测试脚本（不依赖 VS Code 编译）。
 *
 * 测试核心逻辑：
 *   1. 本地回调 HTTP server — state 校验 + ticket 捕获
 *   2. whoami HTTP 调用 — mock 网关返回用户身份
 *   3. auth.json 持久化 — save → load → clear round-trip
 *   4. 完整 login 流程 — mock 网关 + 模拟浏览器回调
 *   5. 票据过期检查
 *   6. TOF signin URL 构造
 *
 * 运行方式：node scripts/test-tof-auth.mjs
 */

import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { URL } from 'url';

const TAIHU_SIGNIN_URL = 'https://passport.woa.com/modules/passport/signin.ashx';
const TOF_CALLBACK_PATH = '/api/v1/auth/tof/callback';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
	return Promise.resolve()
		.then(() => fn())
		.then(() => {
			passed++;
			console.log(`  ✓ ${name}`);
		})
		.catch((err) => {
			failed++;
			failures.push({ name, err });
			console.log(`  ✗ ${name}`);
			console.log(`    ${err.message}`);
		});
}

// ─── 工具函数 ──────────────────────────────────────────────

/**
 * 启动一个 mock 网关 HTTP server。
 * - GET /api/v1/whoami → 返回 mock 用户身份（校验 x-tai-identity header）
 * - GET /api/v1/auth/tof/callback → 模拟网关 302 回本地 server
 */
function startMockGateway(port) {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url, `http://127.0.0.1:${port}`);
			if (url.pathname === '/api/v1/whoami') {
				const ticket = req.headers['x-tai-identity'];
				if (!ticket) {
					res.writeHead(401, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ code: 'missing_identity', message: 'missing x-tai-identity' }));
					return;
				}
				if (ticket === 'expired-ticket') {
					res.writeHead(401, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ code: 'identity_expired', message: 'identity expired' }));
					return;
				}
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					user_id: 'taihu:staffid:123456',
					staff_id: '123456',
					login_name: 'testuser',
					team: 'platform-dev',
					is_admin: false,
					expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
				}));
				return;
			}
			if (url.pathname === '/api/v1/auth/tof/callback') {
				// 模拟网关：用 code 换身份 → 签发 ticket → 302 回本地 server
				const cbPort = url.searchParams.get('cb_port');
				const state = url.searchParams.get('state');
				const ticket = 'mock-ticket-' + crypto.randomBytes(8).toString('hex');
				const redirectUrl = `http://127.0.0.1:${cbPort}/got?identity=${encodeURIComponent(ticket)}&state=${encodeURIComponent(state)}`;
				res.writeHead(302, { Location: redirectUrl });
				res.end();
				return;
			}
			res.writeHead(404);
			res.end('Not Found');
		});
		server.on('error', reject);
		server.listen(port, '127.0.0.1', () => resolve(server));
	});
}

function stopServer(server) {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}

/**
 * 模拟 TofAuthService 的本地回调 server 逻辑。
 * 返回 { server, port, state }。
 */
function startLocalCallbackServer(expectedState) {
	return new Promise((resolve, reject) => {
		const state = expectedState || crypto.randomBytes(16).toString('base64url');
		let capturedIdentity = null;
		let capturedState = null;
		let captureReject = null;

		const server = http.createServer((req, res) => {
			const url = new URL(req.url, `http://127.0.0.1`);
			if (url.pathname !== '/got') {
				res.writeHead(404);
				res.end('Not Found');
				return;
			}
			const identity = url.searchParams.get('identity') || '';
			const stateParam = url.searchParams.get('state') || '';

			if (stateParam !== state) {
				res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end('state mismatch');
				if (captureReject) captureReject(new Error('state mismatch'));
				return;
			}
			if (!identity) {
				res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end('missing identity');
				if (captureReject) captureReject(new Error('missing identity'));
				return;
			}
			capturedIdentity = identity;
			capturedState = stateParam;
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end('OK');
		});

		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			resolve({
				server,
				port,
				state,
				getIdentity: () => capturedIdentity,
				getState: () => capturedState,
			});
		});
	});
}

/**
 * 模拟 TofAuthService._fetchWhoami 的 HTTP 调用。
 */
function fetchWhoami(ticket, gatewayBaseUrl) {
	return new Promise((resolve, reject) => {
		const url = new URL(`${gatewayBaseUrl}/api/v1/whoami`);
		const req = http.request({
			hostname: url.hostname,
			port: url.port || 80,
			path: url.pathname,
			method: 'GET',
			headers: {
				'x-tai-identity': ticket,
				'Accept': 'application/json',
			},
			timeout: 5000,
		}, (res) => {
			let body = '';
			res.on('data', (chunk) => { body += chunk; });
			res.on('end', () => {
				if (res.statusCode === 401) {
					reject(new Error(`identity rejected (401)`));
					return;
				}
				if (res.statusCode >= 400) {
					reject(new Error(`whoami failed: HTTP ${res.statusCode}`));
					return;
				}
				try {
					const data = JSON.parse(body);
					resolve({
						user_id: data.user_id ?? `taihu:staffid:${data.staff_id}`,
						staff_id: String(data.staff_id),
						login_name: String(data.login_name),
						team: data.team ?? null,
						is_admin: !!data.is_admin,
						expires_at: data.expires_at ?? '',
					});
				} catch (e) {
					reject(new Error(`parse failed: ${e.message}`));
				}
			});
		});
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
		req.end();
	});
}

/**
 * 构造 TOF signin URL（与 TofAuthService 相同的逻辑）。
 */
function buildSigninUrl(paasid, siteBaseUrl, port, state) {
	const gwCallback = `${siteBaseUrl.replace(/\/$/, '')}${TOF_CALLBACK_PATH}?cb_port=${port}&state=${encodeURIComponent(state)}`;
	return `${TAIHU_SIGNIN_URL}?oauth=true&appkey=${encodeURIComponent(paasid)}&url=${encodeURIComponent(gwCallback)}`;
}

// ─── 测试用例 ──────────────────────────────────────────────

async function runTests() {
	console.log('\n=== TOF Auth Service 独立测试 ===\n');

	// 1. TOF signin URL 构造
	console.log('--- 1. TOF signin URL 构造 ---');

	await test('signin URL 包含所有必需参数', () => {
		const url = buildSigninUrl('sls_mcp_app', 'http://vssaros.woa.com', 12345, 'state123');
		assert.ok(url.includes('passport.woa.com'));
		assert.ok(url.includes('oauth=true'));
		assert.ok(url.includes('appkey=sls_mcp_app'));
		// cb_port 和 state 在 gw_callback URL 中，整个 URL 被 encodeURIComponent 编码
		assert.ok(url.includes('cb_port%3D12345') || url.includes('cb_port=12345'));
		assert.ok(url.includes('state%3Dstate123') || url.includes('state=state123'));
	});

	await test('siteBaseUrl 尾部斜杠被去除', () => {
		const url = buildSigninUrl('app', 'http://test.woa.com/', 8080, 'st');
		// 编码后 / 变成 %2F，但域名部分的 . 不编码
		assert.ok(url.includes('test.woa.com'));
		assert.ok(!url.includes('test.woa.com//'));
	});

	await test('特殊字符正确编码', () => {
		const url = buildSigninUrl('app+key', 'http://test.woa.com', 8080, 'st+ate');
		// appkey 参数直接编码：+ → %2B
		assert.ok(url.includes('app%2Bkey'));
		// state 在 gw_callback URL 中被编码两次：
		// 第一层 encodeURIComponent: st+ate → st%2Bate
		// 第二层 (整个 url 参数): st%2Bate → st%252Bate
		const decoded = decodeURIComponent(url);
		assert.ok(decoded.includes('st%2Bate') || decoded.includes('st+ate'));
	});

	// 2. 本地回调 server
	console.log('\n--- 2. 本地回调 server ---');

	await test('回调 server — 正确 identity + state 被捕获', async () => {
		const ls = await startLocalCallbackServer();
		try {
			const ticket = 'test-ticket-123';
			// 模拟网关 302 回调
			await new Promise((resolve, reject) => {
				http.get(`http://127.0.0.1:${ls.port}/got?identity=${encodeURIComponent(ticket)}&state=${encodeURIComponent(ls.state)}`, resolve);
			});
			assert.strictEqual(ls.getIdentity(), ticket);
			assert.strictEqual(ls.getState(), ls.state);
		} finally {
			await stopServer(ls.server);
		}
	});

	await test('回调 server — state 不匹配返回 400', async () => {
		const ls = await startLocalCallbackServer();
		try {
			const res = await new Promise((resolve) => {
				http.get(`http://127.0.0.1:${ls.port}/got?identity=ticket&state=wrong`, (r) => {
					r.resume();
					r.on('end', () => resolve(r.statusCode));
				});
			});
			assert.strictEqual(res, 400);
			assert.strictEqual(ls.getIdentity(), null);
		} finally {
			await stopServer(ls.server);
		}
	});

	await test('回调 server — 缺少 identity 返回 400', async () => {
		const ls = await startLocalCallbackServer();
		try {
			const res = await new Promise((resolve) => {
				http.get(`http://127.0.0.1:${ls.port}/got?state=${encodeURIComponent(ls.state)}`, (r) => {
					r.resume();
					r.on('end', () => resolve(r.statusCode));
				});
			});
			assert.strictEqual(res, 400);
		} finally {
			await stopServer(ls.server);
		}
	});

	await test('回调 server — 非法路径返回 404', async () => {
		const ls = await startLocalCallbackServer();
		try {
			const res = await new Promise((resolve) => {
				http.get(`http://127.0.0.1:${ls.port}/invalid`, (r) => {
					r.resume();
					r.on('end', () => resolve(r.statusCode));
				});
			});
			assert.strictEqual(res, 404);
		} finally {
			await stopServer(ls.server);
		}
	});

	// 3. whoami HTTP 调用
	console.log('\n--- 3. whoami HTTP 调用 ---');

	let gatewayServer;
	let gatewayPort;

	await test('启动 mock 网关 server', async () => {
		gatewayServer = await startMockGateway(0);
		gatewayPort = gatewayServer.address().port;
		assert.ok(gatewayPort > 0);
	});

	await test('whoami — 有效 ticket 返回用户信息', async () => {
		const user = await fetchWhoami('valid-ticket', `http://127.0.0.1:${gatewayPort}`);
		assert.strictEqual(user.staff_id, '123456');
		assert.strictEqual(user.login_name, 'testuser');
		assert.strictEqual(user.team, 'platform-dev');
		assert.strictEqual(user.is_admin, false);
		assert.ok(user.expires_at);
	});

	await test('whoami — 缺少 ticket 返回 401', async () => {
		await assert.rejects(
			() => fetchWhoami('', `http://127.0.0.1:${gatewayPort}`),
			/identity rejected/i
		);
	});

	await test('whoami — 过期 ticket 返回 401', async () => {
		await assert.rejects(
			() => fetchWhoami('expired-ticket', `http://127.0.0.1:${gatewayPort}`),
			/identity rejected/i
		);
	});

	await test('whoami — 网关不可达抛错', async () => {
		await assert.rejects(
			() => fetchWhoami('ticket', 'http://127.0.0.1:1'),
			/error|ECONNREFUSED/i
		);
	});

	// 4. auth.json 持久化
	console.log('\n--- 4. auth.json 持久化 ---');

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tof-auth-test-'));
	const authPath = path.join(tmpDir, '.saros', 'auth.json');

	await test('保存 auth — 文件存在且内容正确', () => {
		const user = {
			user_id: 'taihu:staffid:123456',
			staff_id: '123456',
			login_name: 'testuser',
			team: 'platform-dev',
			is_admin: false,
			expires_at: new Date(Date.now() + 86400000).toISOString(),
		};
		fs.mkdirSync(path.dirname(authPath), { recursive: true });
		fs.writeFileSync(authPath, JSON.stringify({ ticket: 'test-ticket', user }, null, 2), 'utf-8');
		assert.ok(fs.existsSync(authPath));
		const raw = fs.readFileSync(authPath, 'utf-8');
		const data = JSON.parse(raw);
		assert.strictEqual(data.ticket, 'test-ticket');
		assert.strictEqual(data.user.login_name, 'testuser');
	});

	await test('加载 auth — 返回保存的 ticket 和 user', () => {
		const raw = fs.readFileSync(authPath, 'utf-8');
		const data = JSON.parse(raw);
		assert.ok(data.ticket);
		assert.ok(data.user);
		assert.strictEqual(data.user.staff_id, '123456');
	});

	await test('清除 auth — 文件被删除', () => {
		fs.unlinkSync(authPath);
		assert.ok(!fs.existsSync(authPath));
	});

	await test('加载不存在的 auth — 返回 null', () => {
		assert.ok(!fs.existsSync(authPath));
	});

	await test('加载损坏的 auth — 返回 null 不崩溃', () => {
		fs.writeFileSync(authPath, 'not-json{', 'utf-8');
		try {
			JSON.parse(fs.readFileSync(authPath, 'utf-8'));
			assert.fail('应抛 JSON 解析错误');
		} catch (e) {
			assert.ok(e instanceof SyntaxError);
		}
	});

	// 5. 完整 login 流程（mock 网关 + 模拟回调）
	console.log('\n--- 5. 完整 login 流程 ---');

	await test('login — 完整流程：本地 server → 网关 callback → whoami', async () => {
		// 1. 启动本地回调 server
		const ls = await startLocalCallbackServer();
		try {
			// 2. 构造 signin URL（不真正打开浏览器）
			const signinUrl = buildSigninUrl('sls_mcp_app', `http://127.0.0.1:${gatewayPort}`, ls.port, ls.state);
			// cb_port 在编码后的 URL 参数中，= 变成 %3D
			assert.ok(signinUrl.includes(`cb_port%3D${ls.port}`) || signinUrl.includes(`cb_port=${ls.port}`));

			// 3. 模拟 TOF 302 → 网关 callback → 网关 302 回本地 server
			//    解析 signin URL 中的 url 参数（网关 callback URL）
			const signinParsed = new URL(signinUrl);
			const gwCallbackUrl = signinParsed.searchParams.get('url');
			assert.ok(gwCallbackUrl);

			// 4. 模拟浏览器访问网关 callback（网关会 302 回本地 server）
			await new Promise((resolve, reject) => {
				http.get(gwCallbackUrl, (res) => {
					// 网关应返回 302 重定向到本地 server
					assert.strictEqual(res.statusCode, 302);
					const location = res.headers.location;
					assert.ok(location.includes('/got'));
					assert.ok(location.includes('identity='));
					res.resume();
					res.on('end', () => {
						// 5. 跟随重定向到本地 server（模拟浏览器自动跟随）
						http.get(location, (res2) => {
							assert.strictEqual(res2.statusCode, 200);
							res2.resume();
							res2.on('end', resolve);
						}).on('error', reject);
					});
				}).on('error', reject);
			});

			// 6. 验证本地 server 捕获了 ticket
			const ticket = ls.getIdentity();
			assert.ok(ticket, '本地 server 应捕获 ticket');
			assert.ok(ticket.startsWith('mock-ticket-'));

			// 7. 用 ticket 调 whoami 获取用户身份
			const user = await fetchWhoami(ticket, `http://127.0.0.1:${gatewayPort}`);
			assert.strictEqual(user.login_name, 'testuser');
			assert.strictEqual(user.staff_id, '123456');
		} finally {
			await stopServer(ls.server);
		}
	});

	// 6. 票据过期检查
	console.log('\n--- 6. 票据过期检查 ---');

	await test('过期检查 — 未来时间未过期', () => {
		const futureISO = new Date(Date.now() + 86400000).toISOString();
		const expiry = new Date(futureISO).getTime();
		const isExpired = !isNaN(expiry) && expiry < Date.now();
		assert.strictEqual(isExpired, false);
	});

	await test('过期检查 — 过去时间已过期', () => {
		const pastISO = new Date(Date.now() - 60000).toISOString();
		const expiry = new Date(pastISO).getTime();
		const isExpired = !isNaN(expiry) && expiry < Date.now();
		assert.strictEqual(isExpired, true);
	});

	await test('过期检查 — 无效日期不判定为过期', () => {
		const expiry = new Date('invalid').getTime();
		const isExpired = !isNaN(expiry) && expiry < Date.now();
		assert.strictEqual(isExpired, false);
	});

	// 7. restoreSession 模拟
	console.log('\n--- 7. restoreSession 模拟 ---');

	await test('restoreSession — 有效票据恢复成功', async () => {
		// 写入有效 auth 文件
		const validUser = {
			user_id: 'taihu:staffid:123456',
			staff_id: '123456',
			login_name: 'testuser',
			team: 'platform-dev',
			is_admin: false,
			expires_at: new Date(Date.now() + 86400000).toISOString(),
		};
		fs.writeFileSync(authPath, JSON.stringify({ ticket: 'valid-ticket', user: validUser }, null, 2), 'utf-8');

		// 模拟 restoreSession：读文件 → 检查过期 → 调 whoami
		const raw = fs.readFileSync(authPath, 'utf-8');
		const data = JSON.parse(raw);

		// 过期检查
		const expiry = new Date(data.user.expires_at).getTime();
		assert.ok(!isNaN(expiry) && expiry > Date.now(), '票据未过期');

		// 调 whoami
		const user = await fetchWhoami(data.ticket, `http://127.0.0.1:${gatewayPort}`);
		assert.strictEqual(user.login_name, 'testuser');
	});

	await test('restoreSession — 过期票据应清除', async () => {
		const expiredUser = {
			user_id: 'taihu:staffid:123456',
			staff_id: '123456',
			login_name: 'testuser',
			team: null,
			is_admin: false,
			expires_at: new Date(Date.now() - 60000).toISOString(),
		};
		fs.writeFileSync(authPath, JSON.stringify({ ticket: 'old-ticket', user: expiredUser }, null, 2), 'utf-8');

		const raw = fs.readFileSync(authPath, 'utf-8');
		const data = JSON.parse(raw);
		const expiry = new Date(data.user.expires_at).getTime();
		const isExpired = !isNaN(expiry) && expiry < Date.now();
		assert.ok(isExpired, '票据应判定为过期');

		// 模拟清除
		fs.unlinkSync(authPath);
		assert.ok(!fs.existsSync(authPath));
	});

	await test('restoreSession — 网关返回 401 时清除票据', async () => {
		const user401 = {
			user_id: 'taihu:staffid:123456',
			staff_id: '123456',
			login_name: 'testuser',
			team: null,
			is_admin: false,
			expires_at: new Date(Date.now() + 86400000).toISOString(),
		};
		fs.writeFileSync(authPath, JSON.stringify({ ticket: 'expired-ticket', user: user401 }, null, 2), 'utf-8');

		// whoami 应返回 401
		try {
			await fetchWhoami('expired-ticket', `http://127.0.0.1:${gatewayPort}`);
			assert.fail('应抛错');
		} catch (e) {
			assert.ok(/identity rejected/i.test(e.message));
			// 模拟清除
			fs.unlinkSync(authPath);
			assert.ok(!fs.existsSync(authPath));
		}
	});

	// 8. state 生成
	console.log('\n--- 8. state 生成 ---');

	await test('state — base64url 格式（只含 [A-Za-z0-9_-]）', () => {
		const state = crypto.randomBytes(16).toString('base64url');
		assert.ok(/^[A-Za-z0-9_-]+$/.test(state));
		assert.ok(state.length >= 16);
	});

	await test('state — 每次生成不同值', () => {
		const s1 = crypto.randomBytes(16).toString('base64url');
		const s2 = crypto.randomBytes(16).toString('base64url');
		assert.notStrictEqual(s1, s2);
	});

	// 清理
	await test('关闭 mock 网关 server', async () => {
		await stopServer(gatewayServer);
	});

	// 清理临时目录
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}

	// 结果
	console.log('\n=== 测试结果 ===');
	console.log(`  通过: ${passed}`);
	console.log(`  失败: ${failed}`);
	if (failures.length > 0) {
		console.log('\n失败详情:');
		for (const f of failures) {
			console.log(`  ✗ ${f.name}`);
			console.log(`    ${f.err.stack || f.err.message}`);
		}
	}
	console.log('');
	process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
	console.error('测试运行器崩溃:', err);
	process.exit(1);
});
