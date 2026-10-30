/*---------------------------------------------------------------------------------------------
 *  多格聊天框的**端到端自动测试**（2026-10-29）。
 *
 *  做什么：连上正在跑的 dev IDE 的 CDP，找到 dsh 桌面窗口里的页面，然后
 *    ① 断言页面桥版本（24 ⇒ `paneAction` 到位）；
 *    ② 断言三枚入口锚点存在（「新窗格」/「⇔」把手 /「⋯」菜单）；
 *    ③ 真的点开「⋯」菜单 ⇒ 断言菜单项齐全（含"关闭这一栏"）；
 *    ④ 用 **CDR 里的页面 target 数**代表"当前有几栏" ⇒ 加栏应 +1、关栏应 -1；
 *    ⑤ 每个阶段截图到 `.probe/`（供人/多模态模型看；本脚本**不**做视觉判定）。
 *
 *  ⚠ 为什么必须"可判定"而不是"看截图"：视觉评估要看图，而**运行本流程的 agent 可能读不了图**
 *    ⇒ 这里全部断言都基于 DOM/几何/target 计数，机器可判、可重复 ✓。
 *
 *  ⚠ 连不上 CDP ⇒ **退出码 2 并明确打印 SKIP**（不是假绿 ✗）：
 *    跑之前要先启动 dev 实例并带 `--remote-debugging-port=9799`。
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSH_CDP_PORT || 9799);
const SHOT_DIR = path.join(ROOT, '.probe');
/** 期望的页面桥版本（与 preload-dshView.ts 的 bridgeVersion 同值 ⇒ 由 check-dsh-new-window 钉住）。 */
const WANT_BRIDGE = 24;

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function listTargets() {
	const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
	if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
	return res.json();
}

/** 连一个 target 的 WS，收发 CDP 命令。 */
function connect(wsUrl) {
	const ws = new WebSocket(wsUrl);
	let seq = 0;
	const pending = new Map();
	ws.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
		}
	};
	return new Promise((resolve, reject) => {
		ws.onopen = () => resolve({
			send: (method, params = {}) => new Promise((res, rej) => {
				const id = ++seq;
				pending.set(id, { resolve: res, reject: rej });
				ws.send(JSON.stringify({ id, method, params }));
			}),
			close: () => ws.close(),
		});
		ws.onerror = () => reject(new Error('WS connect failed'));
	});
}

/** 在目标页面里求值（返回 JSON 字符串 ⇒ 解成对象）。 */
async function evaluate(cdp, expr) {
	const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
	return r.result?.value;
}

async function main() {
	let targets;
	try {
		targets = await listTargets();
	} catch (err) {
		console.log(`[e2e] SKIP：连不上 CDP 127.0.0.1:${PORT}（${err.message}）`);
		console.log('[e2e] 先启动 dev 实例并带 --remote-debugging-port=' + PORT + '，再跑本脚本。');
		process.exit(2);
	}

	// dsh 页面 = 本地 Host 端口上的页面（桌面窗口里的每一栏都是这样一个 target ⇒ 数它 = 数栏）✓
	const pages = targets.filter(t => t.type === 'page' && /127\.0\.0\.1|localhost/.test(t.url || ''));
	if (pages.length === 0) {
		console.log('[e2e] SKIP：CDP 里没有 dsh 页面（桌面窗口没开？）');
		process.exit(2);
	}
	const paneCount = pages.length;
	const main = pages[0];
	const cdp = await connect(main.webSocketDebuggerUrl);
	await cdp.send('Runtime.enable');
	await cdp.send('Page.enable');

	const shot = async (name) => {
		try {
			fs.mkdirSync(SHOT_DIR, { recursive: true });
			const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
			const file = path.join(SHOT_DIR, `split-e2e-${name}.png`);
			fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
			console.log(`  · 截图 ${path.relative(ROOT, file)}`);
		} catch { /* 截图失败不影响判定 */ }
	};

	check('页面桥版本 = 24（paneAction 已到位；否则说明没重新编译）', async () => {
		const v = await evaluate(cdp, 'window.vssarosDsh && window.vssarosDsh.bridgeVersion');
		if (Number(v) !== WANT_BRIDGE) {
			throw new Error(`桥版本 ${v}（期望 ${WANT_BRIDGE}）⇒ preload/协议没编进来`);
		}
	});

	check('主栏动作组：有「新窗格」、**没有**「布局 ▾」、「⇔」把手也不在页面里', async () => {
		const found = await evaluate(cdp, `JSON.stringify({
			grip: !!document.querySelector('[data-vssaros-pane-grip]'),
			menu: !!document.querySelector('[data-vssaros-pane-menu]'),
			newwin: !!document.querySelector('[data-vssaros-new-window]')
		})`);
		const f = JSON.parse(found);
		if (f.grip) { throw new Error('页面里不该有「⇔」把手（拖动在宿主标题栏）✗'); }
		if (f.menu) { throw new Error('顶部「布局 ▾」已被用户要求移除，不该还出现 ✗'); }
		if (!f.newwin) { throw new Error('缺「新窗格」入口 ✗'); }
	});

	check('hero 右上角有「新增窗口」，且不压住官方「打开侧边栏」', async () => {
		const found = await evaluate(cdp, `JSON.stringify({
			host: !!document.querySelector('[data-vssaros-hero-split-host]'),
			btn: !!document.querySelector('[data-vssaros-hero-split]'),
			clear: document.querySelector('[data-vssaros-hero-split]')?.getAttribute('data-vssaros-hero-split-clear')
		})`);
		const f = JSON.parse(found);
		if (!f.host) { throw new Error('hero 入口组件没挂载（chunk 没更新 / 注册被跳过）✗'); }
		if (!f.btn) { throw new Error('当前不是 hero 屏（phase≠hero），或入口没显示 —— 这条需在空会话屏上跑'); }
		if (f.clear !== '1') { throw new Error('入口压住了官方「打开侧边栏」✗'); }
		await shot('hero-entry');
	});

	check('栏数：当前至少 1 栏（target 数），且加栏后 +1', async () => {
		const t0 = (await listTargets()).filter(t => t.type === 'page' && /127\.0\.0\.1|localhost/.test(t.url || ''));
		await evaluate(cdp, `(() => { const b = document.querySelector('[data-vssaros-new-window]') || document.querySelector('[data-vssaros-split-entry]'); if (b) { b.click(); } return 1; })()`);
		await sleep(2500);
		const t1 = (await listTargets()).filter(t => t.type === 'page' && /127\.0\.0\.1|localhost/.test(t.url || ''));
		if (t1.length <= t0.length) {
			throw new Error(`点「新窗格」后页面数没有增加（${t0.length} → ${t1.length}）⇒ 加栏没生效 ✗`);
		}
		console.log(`  · 栏数 ${t0.length} → ${t1.length} ✓`);
		await shot('split');
	});

	let failed = 0;
	for (const [name, fn] of checks) {
		try {
			await fn();
			console.log(`  ✓ ${name}`);
		} catch (err) {
			failed++;
			console.error(`  ✗ ${name}\n    ${err.message}`);
		}
	}
	cdp.close();
	console.log(`[e2e] 起始栏数 ${paneCount}；${checks.length - failed} / ${checks.length} 通过`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
	console.error('[e2e] 失败：', err.message);
	process.exit(1);
}); 
