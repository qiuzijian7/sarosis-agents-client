#!/usr/bin/env node
// run-workbench-open-external-check.mjs —— 「每个工作台的外开按钮」自检
//
// 两层：
//  ① 行为：把 client.js 里真实的 buildWorkbenchDeepLink / parseDeepLinkWorkbench 抠出来跑，
//     断言外开链接长什么样、深链怎么解析（hash 优先）。
//  ② 结构：Frame 真的渲染了按钮、CSS 存在、深链读取走 hash（防止有人把按钮删了/改回只读 query）。
//
// 用法：node dsh-plugins/vssaros-workbenches/test/run-workbench-open-external-check.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const FILE = 'dsh-plugins/vssaros-workbenches/lib/client.js';
const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
const ok = (n) => { pass += 1; console.log('  ✓ ' + n); };
const bad = (n, d = '') => { fail += 1; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); };
const ck = (n, cond, d = '') => (cond ? ok(n) : bad(n, d));

/** 抠出模块级函数（缩进对齐的 `\n\t\t}` 收尾）。 */
function extract(name) {
	const start = src.indexOf('function ' + name);
	if (start < 0) { return ''; }
	const end = src.indexOf('\n\t\t}\n', start);
	return end < 0 ? '' : src.slice(start, end + 4);
}

console.log('[wb-open-external] 工作台外开按钮');

// ── ① 行为 ─────────────────────────────────────────────────────────────
const linkSrc = extract('buildWorkbenchDeepLink');
const parseSrc = extract('parseDeepLinkWorkbench');
ck('能抠出 buildWorkbenchDeepLink', !!linkSrc);
ck('能抠出 parseDeepLinkWorkbench', !!parseSrc);

if (linkSrc && parseSrc) {
	const build = new Function(linkSrc + '\nreturn buildWorkbenchDeepLink;')();
	const parse = new Function(parseSrc + '\nreturn parseDeepLinkWorkbench;')();

	const withToken = build('http://127.0.0.1:6474', '/', '?token=abc123', 'vssaros/studio');
	ck('带 token：query + hash 都在', withToken === 'http://127.0.0.1:6474/?token=abc123#wb=vssaros%2Fstudio&alone=1', withToken);
	const noToken = build('http://127.0.0.1:6474', '/', '', 'vssaros/marketplace');
	ck('无 token：不带 ?', noToken === 'http://127.0.0.1:6474/#wb=vssaros%2Fmarketplace&alone=1', noToken);
	const withPath = build('http://h:1', '/app/', '?x=1', 'vssaros/kb');
	ck('保留非根 pathname', withPath === 'http://h:1/app/#wb=vssaros%2Fkb&alone=1', withPath);
	ck('id 会被 URL 编码（含 / 也要编）', build('http://h', '/', '', 'a/b c').endsWith('#wb=a%2Fb%20c&alone=1'));

	ck('hash 深链能解析', parse('', '#wb=vssaros/studio', '') === 'vssaros/studio');
	ck('query 深链仍兼容', parse('?wb=vssaros%2Fkanban', '', '') === 'vssaros/kanban');
	ck('localStorage 标记仍兼容', parse('', '', 'vssaros:agents') === 'vssaros/agents');
	ck('hash 优先于 query', parse('?wb=vssaros/a', '#wb=vssaros/b', 'vssaros/c') === 'vssaros/b');
	ck('都没有 ⇒ 空串（不误伤普通打开）', parse('', '', '') === '');
	ck('vssaros: 前缀归一成 vssaros/', parse('', '#wb=vssaros:studio', '') === 'vssaros/studio');
}

// ── ② 静态结构 ─────────────────────────────────────────────────────────
ck('Frame 渲染了外开按钮（data 锚点）', /'data-vssaros-wb-open-external':\s*entry\.id/.test(src));
ck('按钮点击走 openWorkbenchInBrowser（带结果回调）', /openWorkbenchInBrowser\(entry\.id,\s*\(ok\)/.test(src));
ck('openWorkbenchInBrowser 先同步开空白窗（防弹窗拦截）',
	/function openWorkbenchInBrowser[\s\S]{0,600}window\.open\('', '_blank'\)/.test(src));
ck('拿到链接后再导航（异步）', /win\.location\.href = url/.test(src));
ck('深链读取已接入 hash 通道', /parseDeepLinkWorkbench\(window\.location\.search,\s*window\.location\.hash/.test(src));
ck('CSS 定义了 .vssWbActions（S2 一体条）', /\.vssWbActions\s*\{[^}]*position:absolute/.test(src));
ck('外开在 S2 一体条内（不再是独立浮动钮）', /className: 'wbAct wbActOpen'/.test(src));
ck('默认位右边缘垂直居中（不落 header 行）', /\.vssWbActions\s*\{[^}]*right:12px;[^}]*top:50%/.test(src));
ck('弹窗被拦截时给可视化状态', /dataset\.state\s*=\s*ok\s*\?\s*'opened'\s*:\s*'blocked'/.test(src));

// ★ 2026-10-26「外开只显示工作台」：链接带 alone=1，进入后收起 dsh 左侧会话栏
ck('外开链接带 alone=1', /&alone=1/.test(src));
ck('有 isAloneDeepLink 判定（hash 与 query 都认）', /function isAloneDeepLink\(search, hash\)/.test(src));
ck('打开工作台后按 alone 收起左侧栏', /if \(alone\) \{[\s\S]{0,600}ctx\.layout\.toggleSidebar\(\)/.test(src));
// `setSidebar` 会被 clamp 到 264，必须用 toggle 才能真正归零
ck('收起侧栏用 toggleSidebar（setSidebar 夹到 264，关不掉）', !/ctx\.layout\.setSidebar\(0\)/.test(src));

// 外开链接的 host 来自运行时 location —— 不允许写死某台机器
ck('没有写死主机名/端口', !/https?:\/\/(127\.0\.0\.1|localhost):\d+/.test(src));

// ── ③ 带 token 的深链（白屏 bug 的修复点）─────────────────────────────
const serverSrc = fs.readFileSync(path.join(ROOT, 'dsh-plugins/vssaros-workbenches/lib/index.js'), 'utf8').replace(/\r\n/g, '\n');
ck('服务端提供 /link 路由', /path:\s*`\$\{PREFIX\}\/link`/.test(serverSrc));
ck('服务端用 connection.authenticatedUrl 现签 token', /const base = ctx\.connection\.authenticatedUrl\(/.test(serverSrc));
// 2026-10-26 真机 bug：外开链接的 origin 取错了来源。 
// 旧写法用 request.url 的 host 兜底成 dsh.internal，而 request.url 是相对路径 ⇒ 域名外泄、DNS 失败。
// request.url 是相对路径 ⇒ 外开打开 dsh.internal（DNS 失败）。现在必须走 resolveOrigin。
ck('origin 走 resolveOrigin（不再用 reqUrl.host）', /resolveOrigin\(hostHeader, port\)/.test(serverSrc));
ck('缺 wb 参数时 400', /missing-wb[\s\S]{0,80}400/.test(serverSrc));
// ⚠ token 属于当前进程：宿主重启后旧链接必然 401 ⇒ 必须每次点击现取，不能挂载时预取
ck('不再挂载时预取（改为点击现取）', !/React\.useEffect\([\s\S]{0,400}requestWorkbenchLink\(entry\.id\)/.test(src));
ck('请求带客户端 origin（服务端 ctx 没有 webServer）', /origin=\$\{encodeURIComponent\(origin\)\}/.test(src));
ck('预取地址指向 /link', /LINK_PATH_PREFIX = '\/api\/vssaros-workbenches\/link'/.test(src));

// 行为：同步开空白窗 → 现取带 token 的链接 → 导航（token 属当前进程，不能缓存）
{
	const body = extract('openWorkbenchInBrowser');
	const linkBody = extract('requestWorkbenchLink');
	ck('能抠出 openWorkbenchInBrowser', !!body);
	ck('能抠出 requestWorkbenchLink', !!linkBody);
	if (body && linkBody) {
		const mk = ({ fresh, openThrows } = {}) => {
			const win = { closed: false, location: { href: '' }, close() { win.closed = true; } };
			const calls = { open: 0, openUrl: '', fetchUrl: '' };
			const window = {
				open: (u) => { calls.open += 1; calls.openUrl = String(u); if (openThrows) { throw new Error('blocked'); } return u === '' ? win : { closed: false }; },
				location: { origin: 'http://127.0.0.1:6474', pathname: '/', search: '?token=old' },
			};
			const fetch = async (url) => {
				calls.fetchUrl = String(url);
				if (!fresh) { return { ok: false, json: async () => ({}) }; }
				return { ok: true, json: async () => ({ url: fresh }) };
			};
			const build = (o, p, s, id) => o + '/fallback#wb=' + encodeURIComponent(id);
			const api = new Function('window', 'fetch', 'buildWorkbenchDeepLink', 'LINK_PATH_PREFIX', 'async ' + linkBody + '\n' + body + '\nreturn { openWorkbenchInBrowser, requestWorkbenchLink };')(window, fetch, build, '/api/vssaros-workbenches/link');
			return { api, win, calls };
		};

		// ① 正常路径
		{
			const fresh = 'http://127.0.0.1:6474/?token=fresh#wb=vssaros%2Fstudio&alone=1';
			const { api, win, calls } = mk({ fresh });
			let reported = null;
			const ret = api.openWorkbenchInBrowser('vssaros/studio', (ok) => { reported = ok; });
			ck('同步返回 true（不阻塞点击手势）', ret === true);
			ck('先同步开空白窗占位', calls.open === 1 && calls.openUrl === '' && win.location.href === '');
			await new Promise((r) => setTimeout(r, 0));
			ck('拿到链接后导航到带 token 的地址', win.location.href === fresh, win.location.href);
			ck('请求带客户端 origin', calls.fetchUrl.includes('origin=' + encodeURIComponent('http://127.0.0.1:6474')), calls.fetchUrl);
			ck('回调上报成功', reported === true);
		}

		// ② 取链接失败 ⇒ 回落本地拼（且不阻断）
		{
			const { api, win } = mk({ fresh: '' });
			api.openWorkbenchInBrowser('vssaros/studio');
			await new Promise((r) => setTimeout(r, 0));
			ck('取不到 ⇒ 回落本地拼', String(win.location.href).includes('/fallback#wb=vssaros%2Fstudio'), win.location.href);
		}

		// ③ 弹窗被拦截 ⇒ 回调报失败（按钮可变橙）
		{
			const { api } = mk({ fresh: 'http://x', openThrows: true });
			let reported = null;
			api.openWorkbenchInBrowser('vssaros/studio', (ok) => { reported = ok; });
			await new Promise((r) => setTimeout(r, 0));
			ck('open 被拦截 ⇒ 回调 false', reported === false);
		}
	}
}

console.log(`\n[wb-open-external] ${pass} passing / ${fail} failing`);
process.exit(fail ? 1 : 0);
