#!/usr/bin/env node
// run-link-route-check.mjs —— 直接跑 `apply()`，验证 `/link` 路由真的能签出可用的外开链接。
//
// 为什么值得写：这个 bug 反复了两轮，根因是**宿主侧服务没 inject 全**
//   （`ctx.inject(['connection'])` 的子 ctx 上没有 `webServer` ⇒ port undefined
//    ⇒ origin 拼成 `http://127.0.0.1:undefined` ⇒ 500 ⇒ 前端回落成无 token 链接
//    ⇒ 浏览器报 `dsh web authentication required`）。
// 只做静态断言（"代码里有 pickOrigin"）盖不住这类问题，必须**跑 handler**。
//
// 用法：node dsh-plugins/vssaros-workbenches/test/run-link-route-check.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SRC = path.join(ROOT, 'dsh-plugins/vssaros-workbenches/lib/index.js');

let pass = 0;
let fail = 0;
const ok = (n) => { pass += 1; console.log('  ✓ ' + n); };
const bad = (n, d = '') => { fail += 1; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); };
const ck = (n, c, d = '') => (c ? ok(n) : bad(n, d));

/** 构造一个假宿主 ctx，跑真实的 apply()，把注册的路由抓出来。 */
function boot({ port = 6474, token = 'TESTTOKEN', hasWebServer = true, injected = [] } = {}) {
	const routes = new Map();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-link-'));
	const ctx = {
		logger: () => ({ warn() {}, info() {} }),
		effect: (fn) => { fn(); return () => {}; },
		reflect: { provide: () => ({}) },
		inject: (deps, cb) => {
			injected.push(...deps);
			const webCtx = {
				connection: {
					/** 真实实现是 `baseUrl + '?token=<进程 token>'` */
					authenticatedUrl: (base) => `${base}?token=${token}`,
					fetch: { register: (r) => { routes.set(r.path, r); } },
				},
			};
			// ⚠ 必须**按 deps 决定**给不给 webServer —— 真实服务的语义就是这样。
			//   若这里无条件给，`ctx.inject(['connection'])`（少声明依赖）这个 bug 就测不出来。
			if (hasWebServer && deps.includes('webServer')) { webCtx.webServer = { port, host: '127.0.0.1' }; }
			cb(webCtx);
		},
	};
	apply(ctx, { root });
	return { routes, injected, root };
}

const call = async (route, url) => {
	const res = await route.fetch(new Request(url));
	let body = null;
	try { body = await res.json(); } catch { body = null; }
	return { status: res.status, body };
};

console.log('[link-route] /link 路由（实跑 apply）');

// ① 必须申请到 webServer 依赖 —— 这就是那个 bug 的根
{
	const { injected } = boot();
	ck('apply 声明了 webServer 依赖', injected.includes('webServer'), injected.join(','));
	ck('apply 声明了 connection 依赖', injected.includes('connection'), injected.join(','));
}

// ② 正常路径：没有客户端 origin、没有 Host 头，也能靠 webServer.port 拼对
{
	const { routes } = boot({ port: 6474, token: 'TK1' });
	const route = [...routes.entries()].find(([k]) => k.endsWith('/link'));
	ck('注册了 /link 路由', !!route, [...routes.keys()].join(','));
	if (route) {
		const { status, body } = await call(route[1], 'http://dsh.internal/api/vssaros-workbenches/link?wb=vssaros%2Fstudio');
		ck('/link 返回 200', status === 200, String(status));
		ck('链接含现签 token', /[?&]token=TK1/.test(String(body?.url)), String(body?.url));
		ck('链接 host 是回环地址（不是 dsh.internal）',
			String(body?.url).startsWith('http://127.0.0.1:6474/'), String(body?.url));
		ck('链接 hash 带工作台 id', String(body?.url).includes('#wb=vssaros%2Fstudio'), String(body?.url));
		// ★ 外开 = 只显示工作台：链接必须带 alone=1（前端据此收起左侧会话栏）
		ck('链接带 alone=1（进去后收起左侧栏）', /[#&]alone=1/.test(String(body?.url)), String(body?.url));
		ck('响应里带 origin 便于排查', body?.origin === 'http://127.0.0.1:6474', String(body?.origin));
	}
}

// ③ 客户端上报 origin 时优先用它（用户可能用 localhost / 域名访问）
{
	const { routes } = boot({ port: 6474, token: 'TK2' });
	const route = [...routes.values()].find((r) => String(r.path).endsWith('/link'));
	if (route) {
		const { body } = await call(route, 'http://dsh.internal/api/vssaros-workbenches/link?wb=vssaros%2Fkb&origin=' + encodeURIComponent('http://localhost:9999'));
		ck('客户端 origin 优先', String(body?.url).startsWith('http://localhost:9999/'), String(body?.url));
		ck('origin 原样回传', body?.origin === 'http://localhost:9999', String(body?.origin));
	}
}

// ④ 缺 wb ⇒ 400（不是 500）
{
	const { routes } = boot();
	const route = [...routes.values()].find((r) => String(r.path).endsWith('/link'));
	if (route) {
		const { status, body } = await call(route, 'http://dsh.internal/api/vssaros-workbenches/link');
		ck('缺 wb ⇒ 400', status === 400, String(status));
		ck('缺 wb 的错误码可读', body?.error === 'missing-wb', String(body?.error));
	}
}

// ⑤ 真的拿不到 origin 时，报清楚的 500，而不是拼出 :undefined
{
	const { routes } = boot({ hasWebServer: false });
	const route = [...routes.values()].find((r) => String(r.path).endsWith('/link'));
	if (route) {
		const { status, body } = await call(route, 'http://dsh.internal/api/vssaros-workbenches/link?wb=vssaros%2Fkb');
		ck('没有 webServer ⇒ 500（不返回半成品链接）', status === 500, String(status));
		ck('500 里透出真实原因', /origin/i.test(String(body?.error)), String(body?.error));
		ck('500 里带 hasWebServer=false（诊断用）', body?.hasWebServer === false, JSON.stringify(body));
	}
}

// ⑥ 源码级：不许再用 reqUrl.host 当 origin
{
	const src = fs.readFileSync(SRC, 'utf8');
	ck('不再用 reqUrl.host 当 origin', !/\$\{reqUrl\.host\}/.test(src));
	ck('inject 列表含 webServer', /ctx\.inject\(\['connection',\s*'webServer'\]/.test(src));
}

console.log(`\n[link-route] ${pass} passing / ${fail} failing`);
process.exit(fail ? 1 : 0);
