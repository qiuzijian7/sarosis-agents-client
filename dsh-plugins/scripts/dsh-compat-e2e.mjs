#!/usr/bin/env node
// dsh-compat-e2e.mjs — DS Bot 兼容能力的**真机自检**（2026-11-09）
//
// 分两层：
//   --preflight  只查文件/版本/编译状态，不连任何进程 ⇒ 重启前后都能跑
//   --all        追加连运行中 dev app 的中继与 Host，验证运行时行为
//
//   node dsh-plugins/scripts/dsh-compat-e2e.mjs --preflight
//   node dsh-plugins/scripts/dsh-compat-e2e.mjs --all
//   node dsh-plugins/scripts/dsh-compat-e2e.mjs --all --wait 90   # 等 Host 起来
//
// ★ 只做只读/无副作用验证：绝不调 `stop`（会把中继锁进 stopped，只有托盘能 rearm），
//   绝不触发输入注入。默认档 view 下所有 observe 都安全。
// ★ 依据（以代码为准，不照设计稿）：
//   发现文件 app.ts:2033-2034 / desktopControlRelay.ts:121,159-163
//   WS 帧 desktopControlRelay.ts:57,179-226 / relay.js:5,99-121
//   Host Cookie dshHostHttp.ts:141-171 / 日志 dshHostSupervisor.ts:1700-1706
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const MODE = argv.includes('--preflight') ? 'preflight' : 'all';
const WAIT = Number(argv[argv.indexOf('--wait') + 1]) || 0;
const ARG = (flag, fallback) => {
	const at = argv.indexOf(flag);
	return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const DEV_ROOT = ARG('--data-root', join(homedir(), '.vssaros-dev'));
const RUN_DIR = join(DEV_ROOT, 'dsh-run');
const DSH_HOME = join(DEV_ROOT, 'dsh-home');
const DEV_PROFILE = join(DSH_HOME, 'profiles', 'vssaros');

const results = [];
const check = (name, ok, detail = '') => {
	results.push({ name, ok: !!ok, detail });
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const skip = (name, why) => { results.push({ name, ok: undefined, detail: why }); console.log(`  skip ${name} — ${why}`); };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };
const text = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PLUGINS = ['vssaros-local-agents', 'vssaros-computer', 'vssaros-browser', 'vssaros-chat-surface'];
const repoVersion = (name) => readJson(join(REPO, 'dsh-plugins', name, 'package.json'))?.version;
const installedVersion = (name) => {
	const direct = join(DEV_PROFILE, 'node_modules', `@vssaros/dsh-${name.replace(/^vssaros-/, '')}`, 'package.json');
	const found = readJson(direct)?.version;
	if (found) return found;
	// 也可能落在 .vssaros/plugins/<name>-<ver>-<hash>/ 暂存目录
	const stash = join(DEV_PROFILE, '.vssaros', 'plugins');
	if (!existsSync(stash)) return undefined;
	const dirs = readdirSync(stash).filter((entry) => entry.startsWith(`${name}-`)).sort();
	for (const dir of dirs.reverse()) {
		const version = readJson(join(stash, dir, 'package.json'))?.version;
		if (version) return version;
	}
	return undefined;
};

console.log(`\n== L0 预检（${DEV_ROOT}） ==`);
const nodeMajor = Number(process.versions.node.split('.')[0]);
const nodeMinor = Number(process.versions.node.split('.')[1]);
check('Node ≥ 22.13', nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13), `v${process.versions.node}`);
check('runtime 契约探针依赖的 rc.2 存在',
	existsSync(join(REPO, 'dsh-runtime', '0.2.1-rc.2', 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json')));

for (const name of PLUGINS) {
	const repo = repoVersion(name);
	const installed = installedVersion(name);
	check(`插件版本 · ${name}`, !!repo, `仓库=${repo} 已装=${installed ?? '(未安装)'}${repo && installed && repo !== installed ? ' ⇒ 待 F5 追平' : ''}`);
}
const patch = text(join(DEV_PROFILE, 'cordis.patch.yml'));
for (const name of ['vssaros-local-agents', 'vssaros-computer']) {
	const row = patch.split(/\r?\n/).find((line, index, all) =>
		line.includes(`id: ${name}`) ? true : all.slice(Math.max(0, index - 2), index).some((near) => near.includes(`id: ${name}`)));
	const enabled = /enabled:\s*true/.test(row ?? '') || new RegExp(`id:\\s*${name}[\\s\\S]{0,300}?enabled:\\s*true`).test(patch);
	check(`profile 启用 · ${name}`, enabled, enabled ? 'enabled:true' : 'enabled:false（功能不会加载）');
}

// mtime 会被 transpile / touch / 行尾转换干扰（本仓已出现过假阴性）⇒ 直接查编译产物内容。
const outMain = join(REPO, 'out', 'main.js');
const outApp = text(join(REPO, 'out', 'vs', 'code', 'electron-main', 'app.js'));
check('主进程已编译（out/app.js 含 presence 接线）',
	existsSync(outMain) && outApp.includes('DesktopControlPresence'),
	existsSync(outMain) ? (outApp.includes('DesktopControlPresence') ? '' : '需 npm run transpile-client') : 'out/main.js 不存在');
const compiledPresence = join(REPO, 'out', 'vs', 'sessions', 'contrib', 'dshHarness', 'electron-main', 'desktopControlPresence.js');
check('P2 presence 模块已转译', existsSync(compiledPresence),
	existsSync(compiledPresence) ? '' : '需 transpile-client');

console.log('\n== L1 运行时文件 ==');
const endpointFile = join(RUN_DIR, 'desktop-control.json');
const portFile = join(DSH_HOME, 'host-port.json');
const runFiles = existsSync(RUN_DIR) ? readdirSync(RUN_DIR) : [];
check('dsh-run 目录存在', existsSync(RUN_DIR), runFiles.slice(0, 8).join(', '));
check('desktop-control.json 存在', existsSync(endpointFile));
check('host-port.json 存在', existsSync(portFile), existsSync(portFile) ? JSON.stringify(readJson(portFile)) : '');
if (existsSync(RUN_DIR)) {
	const logs = runFiles.filter((name) => /^(host|harness)-[0-9a-f]+\.log$/.test(name));
	check('Host / harness 日志存在', logs.length > 0, logs.slice(-3).join(', '));
}

if (MODE === 'preflight') {
	console.log('\n[preflight] 未连接任何进程。加 --all 跑运行时自检。');
	finish();
}

// ── L2 运行时 ────────────────────────────────────────────────────────────
console.log('\n== L2 运行时自检（连接 dev app） ==');
let endpoint = readJson(endpointFile);
for (let i = 0; i < WAIT && !endpoint; i += 3) { await sleep(3000); endpoint = readJson(endpointFile); }
if (!endpoint) { skip('桌面控制中继全部用例', 'desktop-control.json 还没出现（dev app 未启动）'); finish(); }

check('发现文件字段合法',
	endpoint.version === 1 && Number.isInteger(endpoint.pid)
	&& /^ws:\/\/127\.0\.0\.1:\d+\/desktop-control\/vssaros\/[0-9a-f]{48}$/.test(endpoint.wsUrl ?? ''),
	`version=${endpoint.version} pid=${endpoint.pid}`);
let pidAlive = false;
try { process.kill(endpoint.pid, 0); pidAlive = true; } catch { /* stale */ }
check('发现文件 pid 存活', pidAlive);

const WebSocketImpl = globalThis.WebSocket;
if (!WebSocketImpl) { skip('WS 用例', '当前 Node 无全局 WebSocket'); finish(); }
const ws = new WebSocketImpl(endpoint.wsUrl);
await new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error('WS 握手超时 8s')), 8000);
	ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
	ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WS 握手失败')); });
}).catch((error) => { check('WS 握手', false, error.message); finish(); process.exit(1); });

check('WS 握手（loopback + 路径 token）', ws.readyState === 1);

const events = [];
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
	let message;
	try { message = JSON.parse(String(event.data)); } catch { return; }
	if (message.type === 'event') { events.push(message); return; }
	const entry = pending.get(message.id);
	if (!entry) return;
	pending.delete(message.id);
	clearTimeout(entry.timer);
	message.error ? entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code })) : entry.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++seq;
	const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, 8000);
	pending.set(id, { resolve, reject, timer });
	ws.send(JSON.stringify({ id, method, params }));
});

const version = await call('getVersion').catch((error) => ({ __error: error.message }));
check('getVersion', version?.protocol === 'vssaros-desktop-control' && version?.level === 'view'
	&& version?.p0ReadOnly === true && version?.methods?.length >= 10,
	version?.__error ?? JSON.stringify({ level: version?.level, methods: version?.methods?.length }));
const perms = await call('checkPermissions').catch((error) => ({ __error: error.message }));
check('checkPermissions（默认仍纯只读）',
	perms?.inputInjection === false && perms?.foregroundEnabled === false && perms?.userIdleGate === true,
	perms?.__error ?? JSON.stringify({ inputInjection: perms?.inputInjection, foregroundEnabled: perms?.foregroundEnabled }));
const status = await call('getStatus').catch((error) => ({ __error: error.message }));
check('getStatus 空闲态', status?.active === false && status?.stopped === false && status?.handoffState === 'idle',
	status?.__error ?? JSON.stringify(status));
const size = await call('getScreenSize').catch((error) => ({ __error: error.message }));
check('getScreenSize', size?.width > 0 && size?.height > 0, size?.__error ?? `${size?.width}×${size?.height}`);
const shot = await call('screenshot').catch((error) => ({ __error: error.message }));
check('screenshot 返回 dataUrl', /^data:image\/png;base64,/.test(shot?.dataUrl ?? ''),
	shot?.__error ?? `${Math.round((shot?.dataUrl ?? '').length / 1024)}KB @ ${shot?.width}×${shot?.height}`);
const windows = await call('listWindows').catch((error) => ({ __error: error.message }));
check('listWindows 明确 self-only', windows?.scope === 'self-only' && Array.isArray(windows?.windows),
	windows?.__error ?? `${windows?.windows?.length} 个窗口`);

// presence 状态机（不用 stop：会锁住中继且只有托盘能 rearm）
await call('reportStatus', { active: true, botId: 'e2e', appKey: 'selftest', handoffState: 'idle' }).catch(() => {});
const after = await call('getStatus').catch(() => ({}));
check('reportStatus → getStatus 生效 + event 广播',
	after?.active === true && after?.botId === 'e2e' && events.some((frame) => frame.method === 'status'),
	JSON.stringify(after));
await call('reportStatus', { active: false, botId: '', appKey: '', handoffState: 'idle' }).catch(() => {});

// Host HTTP：真源是 dsh-home/host.json 的 authUrl/origin；host-*.log 只作回退
// （日志里的 token 是历史会话的，直接抓第一条会 401 —— 见 dshHostSupervisor.ts:1303-1304）。
const hostState = readJson(join(DSH_HOME, 'host.json'));
const port = hostState?.origin ? Number(new URL(hostState.origin).port) : readJson(portFile)?.port;
if (!port) {
	skip('SSR 设置页用例', 'host.json / host-port.json 都没有可用端口');
} else {
	const logs = runFiles.filter((name) => /^host-[0-9a-f]+\.log$/.test(name))
		.map((name) => join(RUN_DIR, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	const candidates = [];
	if (hostState?.authUrl) candidates.push(hostState.authUrl);
	for (const file of logs.slice(0, 2)) {
		const found = text(file).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/g) ?? [];
		candidates.push(...found.reverse());
	}
	let cookie = '';
	let lastStatus = 0;
	for (const url of candidates.slice(0, 6)) {
		try {
			const exchange = await fetch(url, { redirect: 'manual' });
			lastStatus = exchange.status;
			const raw = exchange.headers.get('set-cookie') ?? '';
			if (exchange.status === 303 && raw) { cookie = raw.split(';')[0]; break; }
		} catch { /* 换下一个候选 */ }
	}
	check('Host auth exchange（303 + Set-Cookie）', !!cookie,
		`status=${lastStatus} 候选=${candidates.length} pid=${hostState?.pid ?? '?'}`);
	const laEnabled = /id:\s*vssaros-local-agents[\s\S]{0,400}?enabled:\s*true/.test(patch);
	if (!laEnabled) {
		skip('SSR 设置页用例', 'profile 里 vssaros-local-agents 未启用 ⇒ 页面不注册（启用并重启后重跑）');
	} else if (!cookie) {
		skip('SSR 设置页用例', '拿不到 Host Cookie');
	} else {
		{
			const origin = hostState?.origin ?? `http://127.0.0.1:${port}`;
			try {
				const state = await fetch(`${origin}/x/local-agents/api/state`, { headers: { cookie } });
				const body = await state.json().catch(() => ({}));
				check('/x/local-agents/api/state', state.status === 200 && Array.isArray(body.engines),
					`status=${state.status} engines=${body.engines?.length} routes=${body.routes?.length}`);
			} catch (error) { check('/x/local-agents/api/state', false, error.message); }
			try {
				const page = await fetch(`${origin}/x/local-agents/`, { headers: { cookie } });
				const html = await page.text();
				check('SSR 页面含严格 CSP 且零脚本',
					page.status === 200 && html.includes("default-src 'none'") && !html.includes('<script'),
					`status=${page.status}`);
			} catch (error) { check('SSR 页面', false, error.message); }
			try {
				const cross = await fetch(`${origin}/x/local-agents/refresh`, {
					method: 'POST', headers: { cookie, origin: 'http://evil.example' },
				});
				check('跨站 POST 被同源闸拒绝', cross.status === 403, `status=${cross.status}`);
			} catch (error) { check('跨站 POST', false, error.message); }
		}
	}
}

try { ws.close(); } catch { /* gone */ }
finish();

function finish() {
	const ok = results.filter((row) => row.ok === true).length;
	const bad = results.filter((row) => row.ok === false);
	const skipped = results.filter((row) => row.ok === undefined).length;
	console.log(`\n[dsh-compat-e2e] ${ok} 通过 / ${bad.length} 失败 / ${skipped} 跳过`);
	if (bad.length) { for (const row of bad) console.error(`  - ${row.name}: ${row.detail}`); process.exitCode = 1; }
	if (MODE === 'preflight') process.exit(process.exitCode ?? 0);
}
