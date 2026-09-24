/**
 * browser_* / CDP 的**真机端到端验证**（P1-2，2026-09-24）。
 *
 * 用法：`npm run verify-browser-cdp`（或 `node scripts/verify-browser-cdp.mjs [port]`）
 *
 * 前置：Chrome 需开着远程调试。两种开法（脚本会打印同样的引导）：
 *   ① 浏览器地址栏打开 chrome://inspect/#remote-debugging 并勾选允许远程调试；
 *   ② 或 `chrome.exe --remote-debugging-port=9222 --user-data-dir=<临时目录>`。
 *
 * ⚠ 它只操作**自己创建的** tab，并把"拒绝关闭非自己创建的 tab"作为一项断言。
 *
 * ## 它测的是真代码，不是副本
 *
 * 用 esbuild 把仓库里的**真实模块**打成一个 bundle 后 import：
 *   • `common/browserCdp.ts`  → `CdpConnection`（JSON-RPC 关联）+ `CdpTargetManager`（目标选择/attach/创建/关闭）
 *   • `browser/browserCdpClient.ts` → 导航/快照/点击/输入/滚动/后退的高层编排
 *   • `browser/browserCdpSnapshot.ts` → 注入脚本（**真的注入到 Chrome 页面里执行**）
 *
 * 脚本自己只补最外面那层"IPC shell"：主进程通道做的是
 * 「net.fetch 发现 /json/version → 建 WebSocket → 分发 op」，这里换成 Node 的
 * `fetch` + 原生 `WebSocket` 做同样的事（Electron 主进程与其等价，差别只有 net.fetch/native）。
 * 也就是说：除 IPC 那一跳与 `net.fetch` 之外，**整条链路跑的都是产品代码**。
 *
 * ## 安全边界（重要）
 *
 *   • 只操作**自己创建的** tab（`CdpTargetManager.ensurePage` 的 ③ 分支）；
 *   • 结束前用 `closeOwnedPage()` 关掉它；
 *   • 额外断言"拒绝关闭非自己创建的 tab" —— 这条是硬约束，必须验证；
 *   • 全程不读用户 tab 的内容（只 `Target.getTargets` 列 id/url）。
 */

import path from 'path';
import fs from 'fs';
import esbuild from 'esbuild';
import { pathToFileURL } from 'url';

/** 仓库根 = 本脚本所在目录的上一级（脚本可放在任意工作副本里跑）。 */
const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.argv[2] ?? 9222);
/** 打包产物落在仓库根的隐藏临时文件，脚本结束（含异常路径）必定删除。 */
const BUNDLE = path.join(ROOT, '.tmp-verify-cdp-bundle.mjs');

const results = [];
let failed = 0;
function check(name, ok, detail) {
	results.push(`${ok ? '  ✔' : '  ✖'} ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) { failed++; }
}
function section(title) { results.push(`\n${title}`); }
const logger = { info: () => { }, warn: m => results.push(`    [warn] ${m}`) };

// ─── 打包真实模块 ───────────────────────────────────────────────────────────

const tsResolvePlugin = {
	name: 'ts-js-resolve',
	setup(build) {
		build.onResolve({ filter: /\.js$/ }, args => {
			if (!args.path.startsWith('.') && !args.path.startsWith('/')) { return undefined; }
			const candidate = args.path.replace(/\.js$/, '.ts');
			const resolved = path.resolve(args.resolveDir, candidate);
			return fs.existsSync(resolved) ? { path: resolved, namespace: 'file' } : undefined;
		});
	},
};

await esbuild.build({
	stdin: {
		contents: [
			`export { CdpConnection, CdpTargetManager } from './src/vs/sessions/contrib/agentStudio/common/browserCdp.js';`,
			`export { BrowserCdpClient } from './src/vs/sessions/contrib/agentStudio/browser/browserCdpClient.js';`,
			`export { SAROS_REF_ATTR, normalizeRawSnapshot, formatImages } from './src/vs/sessions/contrib/agentStudio/browser/browserCdpSnapshot.js';`,
		].join('\n'),
		resolveDir: ROOT,
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	outfile: BUNDLE,
	plugins: [tsResolvePlugin],
	logLevel: 'warning',
	tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
});

const { CdpConnection, CdpTargetManager, BrowserCdpClient, SAROS_REF_ATTR, formatImages } = await import(pathToFileURL(BUNDLE).href);

// ─── IPC shell（等价于 electron-main/browserCdpChannel.ts 的 switch）─────────

let conn;
let manager;

async function connect() {
	if (conn && manager) { return { conn, manager }; }
	const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
	const socket = new WebSocket(version.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('WS open timeout')), 5000);
		socket.onopen = () => { clearTimeout(timer); resolve(); };
		socket.onerror = () => { clearTimeout(timer); reject(new Error('WS handshake failed')); };
	});
	conn = new CdpConnection(socket, logger);
	manager = new CdpTargetManager(conn, logger);
	conn.onClosed(() => manager.clearSessions());
	return { conn, manager };
}

const invoker = async req => {
	try {
		switch (req.op) {
			case 'status': {
				const { conn } = await connect();
				const v = await conn.send('Browser.getVersion', undefined, undefined, 5000);
				return { ok: true, result: { ok: true, endpoint: `http://127.0.0.1:${PORT}`, connected: true, browser: v.product } };
			}
			case 'list': return { ok: true, result: await (await connect()).manager.list() };
			case 'ensurePage': return { ok: true, result: await (await connect()).manager.ensurePage(req.url) };
			case 'closePage': return { ok: true, result: await (await connect()).manager.closeOwned(req.targetId) };
			case 'command': {
				const { conn, manager } = await connect();
				const sessionId = req.sessionId ?? await manager.ensureSession(req.targetId);
				return { ok: true, result: await conn.send(req.method, req.params, sessionId, req.timeoutMs ?? 20000) };
			}
			case 'reset': conn?.dispose(); conn = undefined; manager = undefined; return { ok: true, result: { ok: true } };
			default: return { ok: false, error: `unknown op ${req.op}` };
		}
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
};

// ─── 场景 ───────────────────────────────────────────────────────────────────

/** 直接发原始 CDP 命令（夹具注入 / 断言用）。 */
async function raw(page, method, params, timeoutMs) {
	const res = await invoker({ op: 'command', targetId: page.targetId, sessionId: page.sessionId, method, params, timeoutMs });
	if (!res.ok) { throw new Error(`${method}: ${res.error}`); }
	return res.result;
}
/** 页内求值取回值（检查 exceptionDetails —— 与产品代码同一纪律）。 */
async function evaluate(page, expression) {
	const r = await raw(page, 'Runtime.evaluate', { expression, returnByValue: true });
	if (r?.exceptionDetails) { throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); }
	return r?.result?.value;
}

const FIXTURE = [
	`document.body.innerHTML = '<h1>Probe page</h1>'`,
	`  + '<a href="#one" id="link">First link</a>'`,
	`  + '<input id="text" placeholder="Your name">'`,
	`  + '<button id="btn">Press me</button>'`,
	`  + '<div id="tall" style="height:3000px">tall</div>'`,
	// ↓ `browser_get_images` 要区分的四类情况：正文大图 / 同 URL 去重 / 图标尺寸过滤 / data: 内联跳过。
	//   刻意用**加载不到**的地址：尺寸改由 CSS 决定（`getBoundingClientRect` 兜底），于是这段断言
	//   离线可重复，不依赖任何外网资源（真加载一张图会让结果随网络抖动）。
	`  + '<img id="photo1" src="http://127.0.0.1:1/photo.png" style="width:300px;height:200px" alt="架构图">'`,
	`  + '<img id="photo2" src="http://127.0.0.1:1/photo.png" style="width:300px;height:200px">'`,
	`  + '<img id="icon" src="http://127.0.0.1:1/icon.png" style="width:32px;height:32px" alt="avatar">'`,
	`  + '<img id="inline" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="width:200px;height:200px">';`,
	`window.__clicked = false;`,
	`document.getElementById('btn').addEventListener('click', function () { window.__clicked = true; });`,
	`window.scrollTo(0, 0);`,
	`'injected'`,
].join('\n');

const client = new BrowserCdpClient(invoker, logger);
let createdTargetId = '';

try {
	section(`CDP 真机验证（127.0.0.1:${PORT}）`);

	// ① status / 发现 / 握手
	const status = await client.status();
	check('status: 端点可达且已连接', status.ok === true, status.ok ? status.browser : status.error);
	if (!status.ok) {
		// 端点没开时把引导文案打出来（这正是产品里模型会看到的东西）。
		console.log(results.join('\n'));
		console.log('\n' + (status.error ?? ''));
		fs.rmSync(BUNDLE, { force: true });
		process.exit(2);
	}
	check('status: 含 Chrome 版本串', /Chrome\/\d+/.test(status.browser ?? ''), status.browser);

	// ② 列 target（只读，不碰用户 tab）
	const before = await invoker({ op: 'list' });
	check('list: 返回 page target 列表', before.ok === true && Array.isArray(before.result), `count=${before.result?.length}`);
	const baselineIds = new Set((before.result ?? []).map(t => t.targetId));

	// ③ ensurePage 应**新建** tab 而不是抢用用户的
	const page = await client.page();
	createdTargetId = page.targetId;
	check('ensurePage: 新建了自己的 tab（未抢用用户 tab）', !baselineIds.has(page.targetId), page.url);
	check('ensurePage: 拿到 flatten sessionId', typeof page.sessionId === 'string' && page.sessionId.length > 0, page.sessionId);

	// ④ 空页面快照
	const blank = await client.snapshot();
	check('snapshot: 空白页 0 个可交互元素', blank.nodes.length === 0, `nodes=${blank.nodes.length}`);

	// ⑤ 注入夹具 → 快照（这一段是注入脚本在真实 Chrome 里跑）
	await evaluate(page, FIXTURE);
	const snap = await client.snapshot();
	const roles = snap.nodes.map(n => `${n.role}:${n.name}`);
	check('snapshot: 识别出 link / textbox / button', snap.nodes.length === 3, roles.join(' | '));
	check('snapshot: 标题与正文摘录已采集', snap.headings.includes('h1 Probe page') && snap.textExcerpt.includes('Probe page'), `headings=${snap.headings.join(',')}`);
	check('snapshot: ref 已写进页面 DOM', await evaluate(page, `!!document.querySelector('[${SAROS_REF_ATTR}="1"]')`) === true);

	const byRole = r => snap.nodes.find(n => n.role === r);
	const linkRef = byRole('link')?.ref;
	const textRef = byRole('textbox')?.ref;
	const btnRef = byRole('button')?.ref;
	check('snapshot: 三类元素都有 ref', [linkRef, textRef, btnRef].every(r => typeof r === 'number'));

	// ⑤.5 图片清单（`browser_get_images`）—— 这份脚本此前**只覆盖 6 个工具**，图片是第 7 个、
	//      也是唯一没有真机覆盖的新工具（单测只能验渲染层，注入脚本的真实 DOM 行为验不到）。
	const imgs = await client.images();
	check('images: 只列出正文大图（同 URL 去重）', imgs.images.length === 1, imgs.images.map(i => i.src).join(' | '));
	check('images: 过滤掉图标尺寸（两维都 < 100）', !imgs.images.some(i => i.src.includes('icon.png')));
	check('images: data: 内联图跳过并如实计数（绝不进上下文）', imgs.skippedInline === 1, `skippedInline=${imgs.skippedInline}`);
	check('images: 尺寸走 rect 兜底、alt 采集到',
		imgs.images[0]?.width === 300 && imgs.images[0]?.height === 200 && imgs.images[0]?.alt === '架构图',
		JSON.stringify(imgs.images[0]));

	// ⑤.6 登录墙自诊断：真实页面标题 → 分类器 → 通知，整条链在真实 Chrome 里跑一遍
	//      （单测用的是构造出来的标题，这里用真 `document.title` 走同一个注入脚本读回来）。
	const realTitle = await evaluate(page, 'document.title');
	await evaluate(page, "document.title = '小红书 - 你访问的页面不见了'");
	const wallText = formatImages(await client.images());
	check('images: 占位页标题触发登录墙自诊断', wallText.includes('This is NOT the page content') && wallText.includes('zh-page-gone'));
	check('images: 自诊断含可执行下一步（要手输的地址 + 9222）',
		wallText.includes('chrome://inspect/#remote-debugging') && wallText.includes('9222'));
	await evaluate(page, `document.title = ${JSON.stringify(realTitle)}`);
	check('images: 普通标题不触发（"狼来了"会让这条通知整个失效）',
		!formatImages(await client.images()).includes('This is NOT the page content'));

	// ⑥ 点击（真实鼠标事件）
	const clickOut = await client.click(btnRef);
	check('click: 事件真的打到了元素上（监听器被触发）', await evaluate(page, 'window.__clicked === true') === true);
	check('click: 返回里带新快照', clickOut.includes('Interactive elements'));

	// ⑦ 输入（真实输入管线）
	await client.type(textRef, 'hello');
	check('type: 值写入成功', await evaluate(page, `document.getElementById('text').value`) === 'hello');
	await client.type(textRef, ' world', { append: true });
	check('type(append): 续写而非替换', await evaluate(page, `document.getElementById('text').value`) === 'hello world');

	// ⑧ 滚动（比较前后差值 —— 前面的 click 会 scrollIntoView，单看"非零"会假阳性）
	const scrollBefore = await evaluate(page, 'Math.round(window.scrollY)');
	const scrollOut = await client.scroll('down', 500);
	const scrollAfter = await evaluate(page, 'Math.round(window.scrollY)');
	check('scroll: 页面真的滚了', scrollAfter > scrollBefore, `scrollY ${scrollBefore} → ${scrollAfter}; ${scrollOut.slice(0, 50)}…`);

	// ⑨ Enter（submit 路径）
	await client.pressEnter();
	check('pressEnter: 无异常', true);

	// ⑩ 真实导航（走网络）+ readyState 轮询
	const navOut = await client.navigate('https://example.com');
	check('navigate: 到达目标页并带回快照', navOut.includes('example.com'), navOut.split('\n')[0]);
	check('navigate: 抓到了页面可交互元素', /Interactive elements \((\d+)\)/.test(navOut) && !navOut.includes('(none found'), (navOut.match(/Interactive elements \(\d+\)/) ?? [''])[0]);
	check('navigate: 拿到网页标题', navOut.includes('Example Domain'), navOut.split('\n')[0]);

	// ⑪ 后退
	const backOut = await client.back();
	check('back: 回到上一页', backOut.includes('about:blank'), backOut.split('\n')[0]);

	// ⑫ ref 失效时的错误必须可读（而不是静默失败）
	let staleMsg = '';
	try { await client.click(999999); } catch (err) { staleMsg = err.message; }
	check('click: 过期/不存在的 ref 给出可读错误', /not found on the page/.test(staleMsg) && /browser_snapshot/.test(staleMsg), staleMsg.slice(0, 90));

	// ⑬ 硬约束：拒绝关闭非自己创建的 tab（拿用户 tab 的 id 去试 —— 管理器必须拒绝）
	const userTarget = (before.result ?? [])[0];
	if (userTarget) {
		const refusal = await invoker({ op: 'closePage', targetId: userTarget.targetId });
		check('closePage: 拒绝关闭用户自己的 tab', refusal.ok === false && /不是本工具创建/.test(refusal.error ?? ''), refusal.error?.slice(0, 60));
	} else {
		check('closePage: 拒绝关闭用户自己的 tab', true, '(无用户 tab 可测，跳过)');
	}

} catch (err) {
	check('场景执行未抛异常', false, err instanceof Error ? `${err.message}` : String(err));
} finally {
	// ⑭ 清理：关掉自己创建的 tab
	try {
		if (createdTargetId) {
			await client.closeOwnedPage();
			const after = await invoker({ op: 'list' });
			check('cleanup: 自己创建的 tab 已关闭', !(after.result ?? []).some(t => t.targetId === createdTargetId));
		}
	} catch (err) {
		check('cleanup: 关闭自己的 tab', false, err instanceof Error ? err.message : String(err));
	}
	conn?.dispose();
	fs.rmSync(BUNDLE, { force: true });
}

console.log(results.join('\n'));
console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项失败`}（共 ${results.filter(r => /^\s+[✔✖]/.test(r)).length} 项断言）`);
process.exit(failed === 0 ? 0 : 1);
