#!/usr/bin/env node
/**
 * 右栏浏览器 CDP 中转的真机探针（2026-11-07，P0 · 单一实例）。只读，不改任何东西。
 *
 * 前提：VsSaros（dev 或安装版）已用含 `DshRightbarCdpRelay` 的版本启动；右栏「浏览器」页签开着。
 * 跑法：node scripts/probe-rightbar-browser.mjs [--data <数据根，默认 ~/.vssaros-dev>]
 *
 * 逐项 PASS / FAIL / SKIP：
 *  ① 发现文件在、主进程活着；② 错 token 被拒；③ 对 token：列出右栏页面（可见的排最前）；
 *  ④ 白名单外的命令被拒（Target.createTarget / Target.closeTarget / Browser.close）；⑤ 非 http(s) 导航被拒；
 *  ⑥ 附着到右栏那一页，读出它的 URL / 标题 / 可见 cookie 数 —— 应与人在右栏看见的一致（这就是「同一页」）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const at = process.argv.indexOf('--data');
const dataRoot = at > 0 ? process.argv[at + 1] : join(homedir(), '.vssaros-dev');
const file = join(dataRoot, 'dsh-run', 'rightbar-cdp.json');
const results = [];
const say = (check, state, detail) => { results.push(state); console.log(`${state.padEnd(4)} ${check}: ${detail}`); };

let endpoint;
try {
	endpoint = JSON.parse(readFileSync(file, 'utf8'));
} catch {
	say('①', 'SKIP', `没有 ${file}（主进程还没跑新代码：重启 VsSaros 后再试）`);
	process.exit(0);
}
let alive = false;
try { process.kill(endpoint.pid, 0); alive = true; } catch (error) { alive = error?.code === 'EPERM'; }
say('①', alive ? 'PASS' : 'FAIL', `${file} → pid ${endpoint.pid}${alive ? '' : '（进程已不在：文件是残留）'}`);
if (!alive) { process.exit(1); }

/** One connection; `send` resolves with `{ result } | { error }`. */
async function connect(url) {
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('timeout')), 3000);
		ws.onopen = () => { clearTimeout(timer); resolve(); };
		ws.onerror = () => { clearTimeout(timer); reject(new Error('refused')); };
	});
	let id = 0;
	const pending = new Map();
	ws.onmessage = event => {
		const message = JSON.parse(String(event.data));
		if (typeof message.id === 'number' && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
	};
	return {
		send: (method, params = {}, sessionId) => new Promise(resolve => {
			const n = ++id;
			pending.set(n, resolve);
			ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
			setTimeout(() => { if (pending.delete(n)) { resolve({ error: { message: 'timeout' } }); } }, 10_000);
		}),
		close: () => ws.close(),
	};
}

// ②
const wrong = endpoint.wsUrl.replace(/[0-9a-f]$/, c => (c === '0' ? '1' : '0'));
try {
	const c = await connect(wrong);
	c.close();
	say('②', 'FAIL', '错 token 也连上了');
} catch {
	say('②', 'PASS', '错 token 在握手时被拒');
}

const conn = await connect(endpoint.wsUrl);
try {
	// ③
	const version = await conn.send('Browser.getVersion');
	const targets = await conn.send('Target.getTargets');
	const pages = (targets.result?.targetInfos ?? []).filter(t => t.type === 'page');
	say('③', pages.length ? 'PASS' : 'SKIP', pages.length
		? `${version.result?.product ?? '?'}；右栏页面 ${pages.length} 个：${pages.map(p => `${p.title || '(无标题)'} <${p.url}>`).join('；')}`
		: '中转在，但右栏里没有页面（打开右栏的「浏览器」页签后再跑）');
	// ④
	const refused = [];
	for (const method of ['Target.createTarget', 'Target.closeTarget', 'Browser.close']) {
		const res = await conn.send(method, method === 'Target.createTarget' ? { url: 'about:blank' } : { targetId: pages[0]?.targetId ?? 'x' });
		refused.push(`${method}=${res.error ? res.error.code : 'ALLOWED'}`);
	}
	say('④', refused.every(r => r.endsWith('-32601')) ? 'PASS' : 'FAIL', refused.join(', '));
	if (pages.length) {
		const attached = await conn.send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true });
		const sessionId = attached.result?.sessionId;
		// 右栏页签开着但还没打开过网页 ⇒ 没有渲染进程，Runtime.* 不回；插件会先导航 about:blank（core/rightbar.js），这里照做
		if (!pages[0].url) { await conn.send('Page.navigate', { url: 'about:blank' }, sessionId); }
		// ⑤
		const nav = await conn.send('Page.navigate', { url: 'file:///C:/Windows/win.ini' }, sessionId);
		say('⑤', nav.error?.code === -32602 ? 'PASS' : 'FAIL', nav.error ? `file:// 被拒：${nav.error.message}` : 'file:// 导航居然放行了');
		// ⑥
		const read = await conn.send('Runtime.evaluate', { expression: 'JSON.stringify({ url: location.href, title: document.title, cookies: (() => { try { return document.cookie ? document.cookie.split(";").length : 0; } catch { return "n/a"; } })() })', returnByValue: true }, sessionId);
		const value = read.result?.result?.value;
		say('⑥', value ? 'PASS' : 'FAIL', value ? `工具看到的就是右栏这一页：${value}（与右栏地址栏对一下）` : `读不到：${JSON.stringify(read.error ?? read.result)}`);
	}
} finally {
	conn.close();
}
process.exitCode = results.includes('FAIL') ? 1 : 0;
