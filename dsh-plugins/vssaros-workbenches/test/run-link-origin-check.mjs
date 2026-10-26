#!/usr/bin/env node
// run-link-origin-check.mjs —— 「外开链接的 origin」自检（2026-10-26 真机 bug 的守门人）
//
// bug 现场：外开打开的是 `http://dsh.internal/?token=…`，浏览器报
//   「This site can't be reached / DNS_PROBE_FINISHED_NXDOMAIN」。
// 根因：`new URL(request.url, 'http://dsh.internal')` 的 host 被当成真实 origin，
//   而 request.url 是相对路径 ⇒ 兜底串外泄。
//
// 这里把服务端真实的 `resolveOrigin()` 抠出来跑，钉死三件事：
//   ① 内部占位名绝不能出现在结果里
//   ② 真实 Host 头要保留（localhost / 自定义域名）
//   ③ 没 Host 时回落到 127.0.0.1:<port>
//
// 用法：node dsh-plugins/vssaros-workbenches/test/run-link-origin-check.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const FILE = 'dsh-plugins/vssaros-workbenches/lib/index.js';
const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
const ok = (n) => { pass += 1; console.log('  ✓ ' + n); };
const bad = (n, d = '') => { fail += 1; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); };
const ck = (n, c, d = '') => (c ? ok(n) : bad(n, d));

console.log('[link-origin] 外开链接 origin');

// ── 抠出真实实现 ───────────────────────────────────────────────────────
const start = src.indexOf('export function resolveOrigin');
const end = src.indexOf('\n}\n', start);
ck('能抠出 resolveOrigin', start >= 0 && end > start);
const body = start >= 0 && end > start ? src.slice(start, end + 2) : '';
const resolveOrigin = body
	? new Function('hostHeader', 'port', body.replace('export function', 'function') + '\nreturn resolveOrigin;')(undefined, undefined)
	: null;

if (!resolveOrigin) {
	console.log(`\n[link-origin] ${pass} passing / ${fail} failing`);
	process.exit(1);
}

// ① 空 Host ⇒ 回环 + 端口
ck('空 Host ⇒ http://127.0.0.1:6474', resolveOrigin('', 6474) === 'http://127.0.0.1:6474', resolveOrigin('', 6474));
ck('null Host ⇒ 回环', resolveOrigin(null, 6474) === 'http://127.0.0.1:6474', resolveOrigin(null, 6474));

// ② 内部占位名必须被拒绝（这就是 bug 的直接原因）
ck('dsh.internal ⇒ 回落到回环（不再是 dsh.internal）',
	resolveOrigin('dsh.internal', 6474) === 'http://127.0.0.1:6474', resolveOrigin('dsh.internal', 6474));
ck('dsh.internal:6474 ⇒ 同样回落',
	resolveOrigin('dsh.internal:6474', 6474) === 'http://127.0.0.1:6474', resolveOrigin('dsh.internal:6474', 6474));
ck('DSH.INTERNAL 大小写不敏感', resolveOrigin('DSH.INTERNAL', 6474) === 'http://127.0.0.1:6474', resolveOrigin('DSH.INTERNAL', 6474));

// ③ 真实 Host 要保留
ck('localhost:6474 ⇒ 原样保留', resolveOrigin('localhost:6474', 6474) === 'http://localhost:6474', resolveOrigin('localhost:6474', 6474));
ck('127.0.0.1:6474 ⇒ 原样保留', resolveOrigin('127.0.0.1:6474', 6474) === 'http://127.0.0.1:6474', resolveOrigin('127.0.0.1:6474', 6474));
ck('自定义域名 ⇒ 原样保留', resolveOrigin('dsh.example.com', 6474) === 'http://dsh.example.com', resolveOrigin('dsh.example.com', 6474));
ck('前后空格被裁掉', resolveOrigin('  localhost:6474  ', 6474) === 'http://localhost:6474', resolveOrigin('  localhost:6474  ', 6474));
// 名字里含 dsh.internal 但不是占位名（如 dsh.internal.corp）应保留
ck('dsh.internal.corp 不算占位名', resolveOrigin('dsh.internal.corp', 6474) === 'http://dsh.internal.corp', resolveOrigin('dsh.internal.corp', 6474));

// ③b pickOrigin：客户端上报优先（真机 500 的修复点）
const pStart = src.indexOf('export function pickOrigin');
const pEnd = src.indexOf('\n}\n', pStart);
const pickSrc = pStart >= 0 && pEnd > pStart ? src.slice(pStart, pEnd + 2) : '';
ck('能抠出 pickOrigin', !!pickSrc);
if (pickSrc) {
	const pickOrigin = new Function(pickSrc.replace('export function', 'function') + '\nreturn pickOrigin;')();
	ck('客户端上报 origin 优先', pickOrigin('http://127.0.0.1:6474', '', undefined) === 'http://127.0.0.1:6474');
	ck('localhost 上报也保留', pickOrigin('http://localhost:6474', '', undefined) === 'http://localhost:6474');
	ck('上报值同样是 dsh.internal ⇒ 跳过', (() => {
		try { return pickOrigin('http://dsh.internal', 'dsh.internal', undefined) === null; } catch (e) { return true; }
	})(), '应当抛错（没有可用来源）');
	ck('Host 头可兜底', pickOrigin('', 'localhost:6474', undefined) === 'http://localhost:6474');
	ck('都没有时用 port', pickOrigin('', '', 6474) === 'http://127.0.0.1:6474');
	ck('port 无效 ⇒ 抛出明确错误（不再拼出 :undefined）', (() => {
		try { pickOrigin('', '', undefined); return false; } catch (e) { return /origin/i.test(String(e.message)); }
	})());
}

// ④ 源码级：/link 里不许再把 dsh.internal 当 origin
const linkStart = src.indexOf('path: `${PREFIX}/link`');
const linkSeg = linkStart >= 0 ? src.slice(linkStart, linkStart + 1600) : '';
ck('/link 调用了 pickOrigin（客户端 origin 优先）', /pickOrigin\(claimed, hostHeader, port\)/.test(linkSeg));
ck('/link 读取客户端上报的 origin 参数', /searchParams\.get\('origin'\)/.test(linkSeg));
ck('/link 的 500 会透出真实原因', /hasWebServer:/.test(linkSeg) && /error: String/.test(linkSeg));
ck('/link 不再用 reqUrl.host 当 origin', !/\$\{reqUrl\.protocol\}\/\/\$\{reqUrl\.host\}/.test(linkSeg));
ck('/link 返回 origin 便于排查', /Response\.json\(\{ url:[^}]*origin/.test(linkSeg));

console.log(`\n[link-origin] ${pass} passing / ${fail} failing`);
process.exit(fail ? 1 : 0);
