// ============================================================================
// Start the dev app and record how it dies (exit code + signal).
//
// Why Node instead of PowerShell (2026-10-24): the PowerShell recorder kept
// writing `EXIT code=(unknown)` because $proc.ExitCode was unreadable whenever
// the process was terminated by someone else / crashed hard -- exactly the
// cases we need to tell apart. Node's 'exit' event always gives (code, signal):
//
//   code=null signal=SIGTERM/SIGKILL  => killed externally (taskkill /F = code 1,
//                                        Stop-Process = code -1/signal null)
//   code=0xC000001D (3221225501)      => V8/Chromium ImmediateCrash
//   code=0xE06D7363 (3765269347)      => unhandled C++ exception
//   code=0                            => the app quit itself (window close etc.)
//
// Everything lands in ~/.vssaros-dev/logs/app-exit.log, and the child's
// stdout/stderr go to app-stdout-<ts>.log / app-stderr-<ts>.log (the only
// place a native crash stack can appear, since WER is disabled on this box).
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const EXE = path.join(REPO, '.build', 'electron', 'Saroasis harness.exe');
/** dev 专用 user-data-dir（`DevToolsActivePort` 也在这里，用来查真实调试端口）。 */
const USER_DATA_DIR = path.join(os.homedir(), '.vssaros-dev');
const LOG_DIR = path.join(os.homedir(), '.vssaros-dev', 'logs');
const EXIT_LOG = path.join(LOG_DIR, 'app-exit.log');
fs.mkdirSync(LOG_DIR, { recursive: true });

const note = (line) => {
	const stamp = new Date().toLocaleString('sv-SE').replace(' ', ' ') + '.' + String(Date.now() % 1000).padStart(3, '0');
	try { fs.appendFileSync(EXIT_LOG, `${stamp}  ${line}\n`, 'utf8'); } catch { /* ignore */ }
};

// 第一行必须在**任何探测之前**写下：只要 F5 触发了 preLaunchTask，这里就一定有记录。
// 好处：以后"F5 没反应"能一眼区分——完全没有这行 ⇒ 任务没跑（IDE 侧问题）；
// 有这行却没有后续 ⇒ 卡在某一步（配下面的看门狗定位）。
note(`LAUNCH pid=${process.pid} argv=${process.argv.slice(2).join(' ').slice(0, 160) || '(none)'}`);

// 看门狗：30s 还没走到 START ⇒ 说明卡在端口探测/进程查询/编译上，把已知状态写出来。
const STAGE = { stage: 'init' };
const setStage = (s) => { STAGE.stage = s; };
const bootWatchdog = setTimeout(() => {
	note(`WATCHDOG 启动器 30s 仍停在 stage=${STAGE.stage} ⇒ 这一步卡住了（端口幽灵 / PowerShell 查询 / 编译）`);
	note(`WATCHDOG 现场：node=${process.version} pid=${process.pid}`);
}, 30000);
bootWatchdog.unref?.();

/** 跑一条命令并取 stdout（失败返回空串，绝不抛）。 */
const execSyncSafe = (cmd) => {
	const r = spawnSync('cmd.exe', ['/d', '/s', '/c', cmd], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
	return String(r.stdout || '');
};

const portFree = (port) => new Promise((resolve) => {
	// ⚠ 必须带超时：幽灵端口上 `listen` 可能既不报 error 也不报 listening ⇒ Promise 永不
	//   settle ⇒ 启动器**在写第一条日志之前挂住** ⇒ 用户看到的就是「F5 毫无反应」，
	//   连 app-exit.log 都没有一行（2026-10-25 实测：多个 node 进程卡死在这里）✗
	let settled = false;
	const done = (v) => { if (!settled) { settled = true; resolve(v); } };
	const timer = setTimeout(() => { try { srv.close(); } catch { /* ignore */ } done(false); }, 1500);
	timer.unref?.();
	const srv = net.createServer();
	srv.once('error', () => { clearTimeout(timer); done(false); });
	srv.once('listening', () => { clearTimeout(timer); srv.close(() => done(true)); });
	try { srv.listen(port, '127.0.0.1'); } catch { clearTimeout(timer); done(false); }
});

const running = () => {
	const r = spawnSync('tasklist', ['/fi', 'IMAGENAME eq Saroasis harness.exe', '/fo', 'csv'], { encoding: 'utf8', windowsHide: true });
	return String(r.stdout || '').split(/\r?\n/).filter((l) => /Saroasis/.test(l)).length;
};

if (!fs.existsSync(EXE)) {
	note('ABORT exe not found (run: npm run transpile-client)');
	process.exit(1);
}
// 已经在跑时不能无脑 SKIP：真机 2026-10-24 15:29 出现过"进程活着、窗口全隐藏"
// （桌面窗口已销毁 + IDE 主窗口被 desktop 模式藏着 ⇒ 屏幕上什么都没有），
// 此时 F5 连续三次都被 SKIP 掉 ⇒ 用户看到的就是「F5 卡住、没有 app」✗。
// ⇒ 先探一下**这本实例还有没有桌面窗口**（读 DevToolsActivePort 找真实端口，CDP 里看有没有
//   VsSaros — Desktop 页面）：没有就明确告知，并允许 `DSH_DEV_FORCE_RESTART=1` 直接换掉它。
// 「屏幕上到底有没有它的窗口」用 Win32 枚举（scripts/has-visible-window.ps1）判定。
// 不用 CDP：DevToolsActivePort 可能过期 ⇒ 连错端口误判；aux 桌面窗口也没有 MainWindowHandle。
/**
 * 把已经在跑的实例的窗口提到最前（2026-10-26）。
 *
 * ★ 为什么必须有这一步：F5 走到 SKIP 分支时**不会**起新实例，屏幕上也不会有任何变化；
 *   而那扇已存在的窗口常常被别的（最大化的）应用窗口盖住 ⇒ 用户看到的就是"按了 F5 毫无反应"
 *   （本次报障：实例在跑、桌面窗口可见，但被 CodeBuddy 最大化的窗口完全盖住 ✗）。
 *   ⇒ SKIP 时把它的窗口提上来，让"F5 ⇒ 看到 app"这件事在两种分支下都成立 ✓。
 */
const raiseExistingWindow = () => {
	const ps1 = path.join(HERE, 'raise-dev-window.ps1');
	const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
	return String(r.stdout || '').trim().split(/\r?\n/).pop() || `NO-OUTPUT(${r.status})`;
};

const hasVisibleAppWindow = () => {
	const ps1 = path.join(HERE, 'has-visible-window.ps1');
	const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
	const n = Number(String(r.stdout || '').trim().split(/\r?\n/).pop());
	return Number.isFinite(n) && n > 0;
};

if (running() > 0) {
	// 宽限期：刚启动 90 秒内**本来就没有**桌面窗口（Host 冷启动 + 页面装配要 10~40s），
	// 这时候做"有没有桌面窗口"的判定会把正常启动误报成僵尸（2026-10-24 实测：起后 4 秒
	// 再按 F5 就打印了 SKIP-ZOMBIE）✗ ⇒ 先看最早那个实例活了多久。
	// 让 PowerShell 直接算"最早那个实例活了多久"（自己做 FILETIME 换算容易被格式坑到）
	const ageRaw = String(execSyncSafe(`powershell -NoProfile -Command "\$p = Get-Process -Name 'Saroasis harness' -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1; if (\$p) { [int]((Get-Date) - \$p.StartTime).TotalSeconds }"`)).trim();
	const ageSec = /^\d+$/.test(ageRaw) ? Number(ageRaw) : -1;
	if (ageSec >= 0 && ageSec < 90) {
		note(`SKIP a dev instance is still starting (age=${ageSec}s < 90s grace), attach to it`);
		note(`RAISE ${raiseExistingWindow()}`);
		process.exit(0);
	}
	if (hasVisibleAppWindow()) {
		note('SKIP a dev instance is already running (visible window present), attach to it');
		// ★ 2026-10-26：SKIP 也必须让用户**看到**那个已存在的窗口（否则"F5 没反应" ✗）。
		//   顺带提示"主进程代码比这个实例新"——这类改动只在重启后生效，用户往往不知道 ✗。
		note(`RAISE ${raiseExistingWindow()}`);
		process.exit(0);
	}
	// ★★ 2026-10-24（用户报「F5 无法启动」）：这里原来只**提示**、不动手，于是 F5 每次都被挡
	//   回去 —— 旧实例进程活着但桌面窗口已销毁 ⇒ 屏幕上什么都没有，新实例又不许起 ⇒ 看起来
	//   "F5 完全失效"。僵尸实例本来就没有可用界面，直接换掉没有任何损失 ⇒ **自动清理后重开**。
	//   想保留现场排查时设 `DSH_DEV_KEEP_ZOMBIE=1`。
	note('SKIP-ZOMBIE 实例在跑但**没有桌面窗口**（窗口已销毁、IDE 主窗口仍被隐藏）⇒ 屏幕上看不到 app');
	if (process.env.DSH_DEV_KEEP_ZOMBIE === '1') {
		note('        已设 DSH_DEV_KEEP_ZOMBIE=1 ⇒ 保留僵尸实例不处理（手动结束 Saroasis harness.exe 后 F5）');
		process.exit(0);
	}
	note('        AUTO-RESTART 结束僵尸实例后重开（DSH_DEV_KEEP_ZOMBIE=1 可关）');
	spawnSync('taskkill', ['/F', '/IM', 'Saroasis harness.exe'], { windowsHide: true });
	await new Promise((r) => setTimeout(r, 4000));
}

// ── 端口：**钉死**，不再自动漂移（2026-10-24 修「F5 起了但没 attach」）──────────────
// 病根：`.vscode/launch.json` 的 attach 配置写死 `port: 9799`，而这里原来会在 9799 被
// 幽灵 socket 占住时自动换 9899/9999… ⇒ 应用在 9899 启动、调试器去连 9799 ⇒ 45s 超时，
// 表现就是"程序启动了但没 attach"（日志里 `PORTS ... debug=9899` 就是这一刻）。
// 现在：只认 9799/5888；被占就**等它释放**（幽灵通常几十秒内消失），等不到就明确失败，
// 绝不偷偷换端口 —— 宁可 F5 报错，也不要"看起来起来了其实没调试"。
// 需要换端口时显式覆盖，并同步改 launch.json：
//   $env:DSH_DEV_PORTS='9899:5890'
const PORTS_ENV = (process.env.DSH_DEV_PORTS ?? '').trim();
let debugPort = 9799;
let inspectPort = 5888;
if (/^\d+:\d+$/.test(PORTS_ENV)) {
	const [d, i] = PORTS_ENV.split(':').map(Number);
	debugPort = d; inspectPort = i;
	note(`PORTS override by DSH_DEV_PORTS ⇒ debug=${debugPort} inspect=${inspectPort} (launch.json must match)`);
}

const WHO_OWNS = (port) => {
	// 返回 { alive:boolean, name:string } —— 用来区分"真有人占"和"幽灵 socket"
	const out = execSyncSafe(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess"`);
	const pid = Number(String(out).trim());
	if (!pid) { return { alive: false, name: '' }; }
	const name = String(execSyncSafe(`powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName"`)).trim();
	return { alive: !!name, name, pid };
};

// 候选端口对（默认第一组）。强杀实例后 socket 常常变成"幽灵"：**占用者进程已死但端口仍
// LISTENING**，本机实测 9799 被 pid 47524（已退出）占住超过 3 分钟。幽灵只能靠重启/注销
// 释放，所以这里不再死等 —— 默认组等 20s，等不到就换下一组，并**同步改写 launch.json 的
// port**，让 attach 永远指向真实端口（否则又会变成"应用起来了但调试器连错端口"）。
const CANDIDATES = [[9799, 5888], [9222, 5999], [9333, 6001], [9444, 6003], [9555, 6005]];
const DEFAULT_PAIR = [debugPort, inspectPort];

const waitFreePair = async (d, i, ms) => {
	const t = Date.now();
	while (!(await portFree(d)) || !(await portFree(i))) {
		if (Date.now() - t > ms) { return false; }
		await new Promise((r) => setTimeout(r, 1000));
	}
	return true;
};

let chosen = null;
// DSH_DEV_PORTS 显式指定时**跳过自动挑端口**（以前会被下面的候选循环覆盖，等于没生效）
const portsOverridden = /^\d+:\d+$/.test(PORTS_ENV);
for (let k = 0; portsOverridden ? false : k < CANDIDATES.length; k++) {
	const [d, i] = CANDIDATES[k];
	// 先看是"真有活进程占着"还是"幽灵"：
	//   · 活进程 ⇒ 值得等（可能正在退出），默认组等 20s、其它 3s；
	//   · 幽灵  ⇒ 占用者进程已死，端口几秒内**不会**释放 ⇒ 立刻换下一组。
	// 以前不分这两种，默认组在幽灵上白等 20s ⇒ 用户按完 F5 要等 30s 才见窗口，
	// 主观上就是"按了没反应"（2026-10-25 实测 LAUNCH→PORTBUSY 之间 21s 空档）✗
	const freeNow = (await portFree(d)) && (await portFree(i));
	if (freeNow) { chosen = [d, i]; break; }
	const dd = WHO_OWNS(d), di = WHO_OWNS(i);
	const ghostOnly = !dd.alive && !di.alive;
	note(`PORTBUSY ${d}=${dd.alive ? dd.name + ' pid ' + dd.pid : 'GHOST'} ${i}=${di.alive ? di.name + ' pid ' + di.pid : 'GHOST'}${ghostOnly ? ' ⇒ 幽灵，直接换下一组' : ' ⇒ 等待释放'}`);
	if (ghostOnly) { continue; }
	const waitMs = (d === DEFAULT_PAIR[0] && i === DEFAULT_PAIR[1]) ? 20000 : 3000;
	if (await waitFreePair(d, i, waitMs)) { chosen = [d, i]; break; }
	note(`PORTWAIT ${d}/${i} 等 ${waitMs / 1000}s 仍被占用 ⇒ 换下一组`);
}
if (!chosen) {
	// 全部候选都不可用（通常是幽灵累积）⇒ 交给系统分配（0），启动后从 DevToolsActivePort
	// 读回真实端口再同步 launch.json ⇒ 保证 F5 **永不**因为端口问题失败。
	debugPort = 0;
	inspectPort = 0;
	note('PORTRANDOM 所有候选端口都不可用（幽灵累积）⇒ 改用系统分配（--remote-debugging-port=0 / --inspect=0）');
}

if (chosen) {
	debugPort = chosen[0];
	inspectPort = chosen[1];
}

// 让 attach 配置**永远**跟着实际端口走（否则 F5 必然连不上）。
// ⚠ 时机很关键：必须等**本实例真的起来**（READY）再改。否则"第二次启动因单实例锁
//   立刻 exit 0（handoff）"也会跑一遍同步，把已经正确的端口又改回它自己选的那个
//   ⇒ launch.json 与实际端口错开（本机 21:24 就撞到：实例在 9333，launch.json 被改回 9222）。
/** 系统分配端口时（debugPort===0），从 DevToolsActivePort 读回真实端口。 */
const resolveRandomDebugPort = () => {
	try {
		const raw = String(fs.readFileSync(path.join(USER_DATA_DIR, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0].trim();
		const n = Number(raw);
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch { return 0; }
};

const syncLaunchJsonPorts = () => {
	try {
		const lj = path.join(REPO, '.vscode', 'launch.json');
		const text = fs.readFileSync(lj, 'utf8');
		const portAfter = (marker, src) => {
			const at = src.indexOf(marker);
			if (at < 0) { return 0; }
			const m = /"port"\s*:\s*(\d+)/.exec(src.slice(at, at + 4000));
			return m ? Number(m[1]) : 0;
		};
		const curD = portAfter('Launch & Attach Dev', text);
		const curR = portAfter('Attach to VS Code Renderer', text);   // 也是 chrome attach，必须同端口
		const curI = portAfter('Attach to Main Process', text);
		// ⚠ 替换值必须用回调：`$1` 后面紧跟数字时（`$19333`）会被当成"第 19333 组"，写坏文件
		const setPort = (src, from, to) => src.replace(new RegExp(`("port"\\s*:\\s*)${from}\\b`, 'g'), (_m, p1) => p1 + to);
		let next = text;
		if (curD && curD !== debugPort) { next = setPort(next, curD, debugPort); }
		if (curR && curR !== debugPort && curR !== curD) { next = setPort(next, curR, debugPort); }
		if (curI && curI !== inspectPort) { next = setPort(next, curI, inspectPort); }
		next = next.split(`(${curD})`).join(`(${debugPort})`);
		if (curR && curR !== curD) { next = next.split(`(${curR})`).join(`(${debugPort})`); }
		if (next !== text) {
			fs.writeFileSync(lj, next);
			note(`LAUNCHJSON synced port ${curD}→${debugPort}, ${curI}→${inspectPort}（attach 指向真实端口，F5 可直接用）`);
		}
	} catch (e) {
		note(`LAUNCHJSON sync failed: ${String(e && e.message).slice(0, 120)} ⇒ 请手动把 launch.json 的 port 改成 ${debugPort}`);
	}
};
note(`PORTS inspect=${inspectPort} debug=${debugPort}`);
setStage('ports');


// ── 保证「改完重启立刻生效」（2026-10-24）────────────────────────────────────────
// 两条独立的部署链，任一条没走完，重启后看到的就还是旧代码：
//   ① src/ → out/：页面与主进程读的是 out/，改了 src 不编译 = 白改；
//   ② dsh-plugins/<x> → profile/node_modules/@vssaros/<pkg>：宿主只读 profile 那份，
//      且页面 URL 的 ?rev 由入口的 (mtime,ctime,size) 决定、响应头是
//      `max-age=31536000, immutable` ⇒ 入口元数据不变时浏览器会一直吃旧 chunk。
// 这里在**启动前**把两件事做完，并把结论写进 app-exit.log，避免再靠猜。
const newestUnder = (root, re) => {
	let best = 0, name = '';
	(function walk(dir, depth) {
		if (depth > 12) { return; }
		let es;
		try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of es) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') { walk(p, depth + 1); } continue; }
			if (!re.test(e.name)) { continue; }
			let st; try { st = fs.statSync(p); } catch { continue; }
			if (st.mtimeMs > best) { best = st.mtimeMs; name = path.relative(REPO, p); }
		}
	})(root, 0);
	return { t: best, name };
};

// ── 并发编译检测 + out/ 完整性预检（2026-10-25）──────────────────────────────────
// 现场：`npm run watch-client-transpile` 与启动器里的 `npm run transpile-client` **都会先
// `cleanDir(out/)`**。两者同时在跑 ⇒ out/ 被清空后只写回一两千个文件，应用起来 0.3 秒就
// `exit=1`（日志里几乎没线索），表现是"F5 起了又没了 / 完全没反应"✗。
// 这里做两道闸：
//   ① 检测到 watch 正在跑 ⇒ **跳过自己的编译**（别去跟它抢 out/），只做完整性检查；
//   ② 生成代码前先确认 out/ 真的完整（关键入口存在 + 文件数够）⇒ 不完整就明确 ABORT。
const countWatchProcs = () => {
	// ⚠ 必须排除**探测语句自身**：查询命令的命令行里也含 `watch-client-transpile` 这几个字，
	//   不加 `Get-CimInstance` 过滤会把自己（cmd + powershell 两个进程）也数进去
	//   ⇒ 曾经在 watch 已经全部结束时仍报"检测到 2 个"（2026-10-25 实测）✗
	const ps = "Get-CimInstance Win32_Process"
		+ " | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch 'Get-CimInstance'"
		+ " -and ($_.CommandLine -like '*watch-client-transpile*' -or $_.CommandLine -like '*transpile --watch*') }"
		+ " | Measure-Object | Select-Object -ExpandProperty Count";
	const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
	const n = Number(String(r.stdout || '').trim());
	return Number.isFinite(n) ? n : 0;
};

const OUT_REQUIRED = [
	'out/main.js',
	'out/bootstrap-node.js',
	'out/vs/code/electron-main/main.js',
	'out/vs/sessions/sessions.desktop.main.js',
	'out/vs/workbench/workbench.desktop.main.js',
];
const countFiles = (root) => {
	let n = 0;
	(function walk(d) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) { walk(p); } else { n++; } } })(root);
	return n;
};
// 正常 21800+；被并发清空时实测只剩 1300~2500。可用环境变量覆盖（便于自测这道闸）
const OUT_MIN_FILES = Number(process.env.DSH_DEV_OUT_MIN_FILES) > 0 ? Number(process.env.DSH_DEV_OUT_MIN_FILES) : 20000;

const watchCount = countWatchProcs();
const srcNewest = newestUnder(path.join(REPO, 'src'), /\.ts$/);
const outNewest = newestUnder(path.join(REPO, 'out'), /\.js$/);

// ★ 2026-10-26：SKIP 分支看不到这里（它在上面就 exit 了）⇒ 这条只对"真起了新实例"有效：
//   `out/` 比本次启动还新 ⇒ watch 刚在编译，本次跑的可能是半新不旧的产物 ⇒ 明确留痕。
if (outNewest.t > Date.now()) {
	note(`STALE out/ 比本次启动还新（${outNewest.name}）⇒ watch 正在改产物，看到的行为可能不一致`);
}

if (watchCount > 0) {
	note(`WATCH 检测到 ${watchCount} 个 transpile --watch 进程 ⇒ 跳过启动器自己的编译（避免互相清空 out/）`);
	if (srcNewest.t > outNewest.t) {
		note(`WATCH ⚠ src 比 out 新（${srcNewest.name}）⇒ 那份改动正由 watch 编译，本次启动可能不含它`);
	}
} else if (srcNewest.t > outNewest.t) {
	note(`TRANSPILE src is newer than out (${srcNewest.name}) ⇒ running transpile-client`);
	const r = spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm run transpile-client'], {
		cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 600000,
	});
	const tail = String(r.stdout || '').split(/\r?\n/).filter((l) => /Done in|ERROR|Build failed/.test(l)).slice(-2).join(' | ');
	note(`TRANSPILE ${r.status === 0 ? 'ok' : 'FAILED status=' + r.status} ${tail.slice(0, 180)}`);
	if (r.status !== 0) {
		note('ABORT transpile failed ⇒ refusing to start with stale out/ (see app-exit.log tail)');
		process.exit(1);
	}
} else {
	note(`TRANSPILE skipped (out is newer: ${outNewest.name})`);
}

// ② 完整性闸：不完整就别起（否则会 0.3 秒 exit=1，且看不出原因）
{
	// out/ 里最能代表"资源已拷"的几个非 JS 文件 —— 缺了它们窗口根本加载不出来
	const OUT_RESOURCES = [
		'out/vs/sessions/electron-browser/sessions-dev.html',
		'out/vs/code/electron-browser/workbench/workbench-dev.html',
	];
	let missing = OUT_REQUIRED.filter((rel) => !fs.existsSync(path.join(REPO, rel)));
	let missingRes = OUT_RESOURCES.filter((rel) => !fs.existsSync(path.join(REPO, rel)));
	let files = countFiles(path.join(REPO, 'out'));

	// ★ 2026-10-25：JS 齐了、只缺资源 ⇒ 不是"正在编译"，而是 watch 的资源拷贝阶段失败了
	//   （`npm run watch` 启动时先 cleanDir(out/)，app 若正在跑、占着文件，copyAllNonTsFiles
	//   就会失败，watch 只打一行 "Initial build failed" 然后**永远不再补**）⇒ out/ 永久残缺，
	//   每次 F5 都 ABORT ⇒ 用户看到的就是「F5 没反应」。
	//   ⇒ 这里直接**增量补齐资源**（不清空 out/，与仍在运行的 watch 共存安全）。
	if (!missing.length && (missingRes.length || files < OUT_MIN_FILES)) {
		note(`OUT 资源缺失（文件数 ${files}${missingRes.length ? '；缺 ' + missingRes.map((r) => path.basename(r)).join(', ') : ''}）⇒ 增量补齐 src/ 非 TS 资源`);
		const r = spawnSync(process.execPath, [path.join(HERE, 'copy-src-resources.mjs')], {
			cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 300000,
		});
		const last = String(r.stdout || '').trim().split(/\r?\n/).pop() || '';
		note(`OUT ${last || 'copy-src-resources 无输出 status=' + r.status}`);
		missingRes = OUT_RESOURCES.filter((rel) => !fs.existsSync(path.join(REPO, rel)));
		files = countFiles(path.join(REPO, 'out'));
	}

	missing = OUT_REQUIRED.filter((rel) => !fs.existsSync(path.join(REPO, rel)));
	if (missing.length || missingRes.length || files < OUT_MIN_FILES) {
		const gone = [...missing, ...missingRes];
		note(`ABORT out/ 不完整（文件数 ${files} < ${OUT_MIN_FILES}${gone.length ? '；缺 ' + gone.join(', ') : ''}）`);
		note(watchCount > 0
			? '        原因：transpile --watch 正在重建 out/ ⇒ 等它跑完再按 F5（或结束 watch 进程后由本启动器编译）'
			: '        处理：npm run transpile-client（完整编译后再 F5）');
		process.exit(1);
	}
	note(`OUT ok (${files} 个文件，关键入口与资源齐全)`);
	setStage('out');
}

// ③ 逐文件闸：src 里每个 .ts 都要有对应的 out/*.js（2026-10-25）
//   现场：`builtinAgents.ts` 里被写进了未转义的反引号（模板字符串被截断）⇒ esbuild 对这**一个**
//   文件失败，watch/transpile 都只是跳过它 ⇒ out/ 少 1 个 js、其余全部正常 ⇒ 主进程 import 时
//   ERR_MODULE_NOT_FOUND，卡在"进程在、窗口无" —— 前两道闸都看不出来 ✗。
//   这里找出缺失的 js，逐个用 esbuild 转一次：转得过就补上；转不过就 ABORT 并给出**行列号**。
{
	const missingJs = [];
	(function walk(dir, rel) {
		let es;
		try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of es) {
			const r = rel ? rel + '/' + e.name : e.name;
			if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue; }
			if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts')) { continue; }
			if (!fs.existsSync(path.join(REPO, 'out', r.replace(/\.ts$/, '.js')))) { missingJs.push(r); }
		}
	})(path.join(REPO, 'src'), '');

	if (missingJs.length) {
		note(`OUT 缺 ${missingJs.length} 个转译产物：${missingJs.slice(0, 3).join(', ')}${missingJs.length > 3 ? ' …' : ''}`);
		let esbuild = null;
		try {
			const { createRequire } = await import('node:module');
			esbuild = createRequire(path.join(REPO, 'package.json'))('esbuild');
		} catch { /* 没装 esbuild 就只能报告 */ }
		const broken = [];
		for (const rel of missingJs.slice(0, 50)) {
			const src = path.join(REPO, 'src', rel);
			if (!esbuild) { broken.push(`${rel}（esbuild 不可用，无法自检）`); continue; }
			try {
				// 与 build/next/index.ts 的 transformOptions 保持一致（DI 参数装饰器需要 experimentalDecorators）
				const res = await esbuild.transform(fs.readFileSync(src, 'utf8'), {
					loader: 'ts', format: 'esm', target: 'es2024', sourcemap: 'inline', sourcesContent: false, sourcefile: rel,
					tsconfigRaw: JSON.stringify({ compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } }),
				});
				const dst = path.join(REPO, 'out', rel.replace(/\.ts$/, '.js'));
				fs.mkdirSync(path.dirname(dst), { recursive: true });
				fs.writeFileSync(dst, res.code);
			} catch (e) {
				const er = (e && e.errors && e.errors[0]) || {};
				const loc = er.location ? `${er.location.line}:${er.location.column}` : '?';
				broken.push(`src/${rel}:${loc}  ${String(er.text || e).slice(0, 120)}`);
			}
		}
		if (broken.length) {
			for (const b of broken.slice(0, 5)) { note(`ABORT 源码无法转译 ⇒ ${b}`); }
			note('        处理：修掉上面的语法错误（常见：模板字符串里写了未转义的 ` 反引号），保存后再 F5');
			process.exit(1);
		}
		note(`OUT 已就地补转 ${missingJs.length} 个文件 ✓`);
	}
}

setStage('deploy');
const deploy = spawnSync(process.execPath, [path.join(HERE, 'dsh-plugin-deploy.mjs'), '--changed'], {
	cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 300000,
});
const deployLines = String(deploy.stdout || '').split(/\r?\n/).filter((l) => /^✓|⚠/.test(l.trim()));
if (deployLines.length) {
	deployLines.forEach((l) => note('PLUGIN ' + l.trim().replace(/^✓\s*/, '')));
} else {
	note('PLUGIN no changes (all dsh plugins in profile match repo)');
}

// ── spawn 前最后复查（2026-10-25）────────────────────────────────────────────────
// "选端口 → 编译 → 部署" 期间可能已经有别的实例起来了（连按两次 F5、或另一个会话刚启动）。
// 这时若照旧 spawn，第二个实例会 `Starting inspector on 127.0.0.1:5999 failed: address
// already in use` + `Cannot start http server for devtools` ⇒ 秒退 code=1，
// 日志上极易被误读成"崩了"。⇒ 这里复查实例与端口，能复用就复用、能换就换。
if (running() > 0) {
	note('SKIP 启动前复查：已有实例在跑（并发启动/连按 F5）⇒ 直接 attach，不再起第二个');
	process.exit(0);
}
if (!(await portFree(debugPort)) || !(await portFree(inspectPort))) {
	note(`PORTLATE debug=${debugPort}/inspect=${inspectPort} 在编译/部署期间被占用 ⇒ 重新选一组`);
	let repick = null;
	for (const [d, i] of CANDIDATES) {
		if (await portFree(d) && await portFree(i)) { repick = [d, i]; break; }
	}
	if (!repick) {
		note('ABORT 没有可用的 debug/inspect 端口对 ⇒ 不启动');
		process.exit(2);
	}
	debugPort = repick[0];
	inspectPort = repick[1];
	note(`PORTS inspect=${inspectPort} debug=${debugPort}（重选）`);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const outLog = path.join(LOG_DIR, `app-stdout-${stamp}.log`);
const errLog = path.join(LOG_DIR, `app-stderr-${stamp}.log`);
const outFd = fs.openSync(outLog, 'a');
const errFd = fs.openSync(errLog, 'a');

const args = [
	REPO,
	`--inspect=${inspectPort}`,
	`--remote-debugging-port=${debugPort}`,
	'--no-cached-data',
	'--skip-sessions-welcome',
	`--user-data-dir=${USER_DATA_DIR}`,
];

// Extra switches without editing this file (A/B testing), e.g.
//   $env:DSH_DEV_EXTRA_ARGS='--force-device-scale-factor=1'
//
// ★ 2026-10-24（用户要求去掉）：这里曾有一条「RDP 会话自动加 `--disable-gpu`」。
//   它已被证伪，删掉：
//     · 崩溃真实原因不是 GPU，而是本机 Windows 的 USER 原子表已被别的程序耗尽
//       （16320/16384），导致 LoadCursor 加载 exe 内**资源光标**（col-resize / zoom-in /
//       grab …）失败 → Chromium CHECK → 0xC00001D 整进程退出；`--disable-gpu` 下同样崩。
//     · 真正解法在 `src/vs/code/electron-main/cursorCrashGuard.ts`：把危险 CSS 光标改写
//       成系统光标（日志里 `[CursorGuard] installed …`）。
//     · 代价只是白让渲染走软件合成，远程会话里更卡。
//   需要临时关 GPU 时仍可手动传：$env:DSH_DEV_EXTRA_ARGS='--disable-gpu'
let extra = (process.env.DSH_DEV_EXTRA_ARGS ?? '').trim();

if (extra) {
	const parts = extra.split(/\s+/).filter(Boolean);
	args.push(...parts);
	note(`EXTRA  ${parts.join(' ')}`);
}

setStage('spawn');
note(`START  port=${debugPort}`);
note(`CONSOLE ${errLog}`);

const child = spawn(EXE, args, {
	cwd: REPO,
	detached: true,
	stdio: ['ignore', outFd, errFd],
	windowsHide: false,
	env: {
		...process.env,
		NODE_ENV: 'development',
		VSCODE_DEV: '1',
		VSCODE_CLI: '1',
		VSCODE_SKIP_PRELAUNCH: '1',
		ELECTRON_ENABLE_LOGGING: '1',
		ELECTRON_ENABLE_STACK_DUMPING: '1',
		// 让主进程的 runJournal 把 START/EXIT/PREV-DIED 标成 launcher（与 launch.json 那两条的
		// `debug-launch` 区分开）—— 两条启动路径共用一个 app-exit.log，靠这个字段分辨来源 ✓
		DSH_LAUNCH_SRC: 'launcher',
	},
});
note(`PID    ${child.pid}`);

// 确认 devtools 真的开始监听 —— 这是 "attach 能否成功" 的唯一可靠信号。
// 日志里出现 `READY debug=9799` ⇒ 调试器一定能连上；出现 `NOTREADY` ⇒ 一定是 app 侧没起来。
const devtoolsAlive = (port) => new Promise((resolve) => {
	const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, (res) => {
		res.resume();
		resolve(res.statusCode === 200);
	});
	req.on('timeout', () => { req.destroy(); resolve(false); });
	req.on('error', () => resolve(false));
});
const readyStart = Date.now();
const readyTimer = setInterval(async () => {
	if (child.exitCode !== null) { clearInterval(readyTimer); return; }
	if (Date.now() - readyStart > 90000) {
		clearInterval(readyTimer);
		note(`NOTREADY debug=${debugPort} 90s 内 devtools 未监听 ⇒ attach 会超时（先看 app-stderr-*.log）`);
		return;
	}
	// 系统分配端口（0）时，先从 DevToolsActivePort 读回真实端口
	if (debugPort === 0) {
		const real = resolveRandomDebugPort();
		if (real) { debugPort = real; note(`PORTRANDOM 真实调试端口 = ${real}（来自 DevToolsActivePort）`); }
	}
	if (debugPort && await devtoolsAlive(debugPort)) {
		clearInterval(readyTimer);
		clearTimeout(bootWatchdog);
		setStage('ready');
		note(`READY  debug=${debugPort} attach-ready after ${Math.round((Date.now() - readyStart) / 1000)}s`);
		// --inspect=0 时真实端口只出现在 stderr：`Debugger listening on ws://127.0.0.1:PORT/`
		if (!inspectPort) {
			try {
				const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(fs.readFileSync(errLog, 'utf8'));
				if (m) { inspectPort = Number(m[1]); note(`PORTRANDOM 真实 inspect 端口 = ${inspectPort}（来自 stderr）`); }
			} catch { /* ignore */ }
		}
		// 只有确认本实例真的起来了才改 launch.json（理由见 syncLaunchJsonPorts 的注释）
		syncLaunchJsonPorts();
	}
}, 2000);

child.on('exit', (code, signal) => {
	clearInterval(readyTimer);
	const hex = typeof code === 'number' && code !== 0 ? '0x' + (code >>> 0).toString(16).toUpperCase().padStart(8, '0') : '-';
	note(`EXIT   pid=${child.pid} code=${code} signal=${signal ?? '-'} hex=${hex}`);
	// 秒退 + 0：多半是单实例锁把启动转交给了已在跑的实例（handoff）⇒ 明确说出来，
	// 免得又变成"F5 完全没反应，也不知道为什么"。
	if (code === 0 && Date.now() - readyStart < 15000) {
		note('HANDOFF 本次 spawn 秒退(0) ⇒ 已有实例持有 profile 锁，无需再启动（attach 到已在跑的那个）');
	}
	// 秒退且非 0：最常见是端口被别人抢了（连按 F5 / 另一会话刚起）⇒ 直接点名，别让日志像"崩溃"
	if (typeof code === 'number' && code !== 0 && Date.now() - readyStart < 15000) {
		let portClash = false;
		try {
			const tailText = fs.readFileSync(errLog, 'utf8');
			portClash = /address already in use|Cannot start http server for devtools/i.test(tailText);
			if (portClash) {
				note('PORT-CLASH 秒退原因：调试端口已被占用（另一个实例刚起来）⇒ 这不是崩溃，直接 attach 到那个实例即可');
			}
		} catch { /* 读不到就算了 */ }
		if (!portClash) {
			note('KILL? 秒退且非端口冲突 ⇒ 外部结束（taskkill / TerminateProcess 都是 code=1，且不留 dump/will-quit）');
		}
	}
	// 非零退出码 1 + 没有 dump + 没有 will-quit 收尾 ⇒ 典型"被外部 TerminateProcess"
	// 让用户直接知道去哪儿取证（审计已配好：Scripts\enable-process-audit.ps1 已执行过）
	if (code === 1) {
		note('KILL? code=1（TerminateProcess 语义）⇒ 若 app-exit.log 里没有 [run] EXIT code=1 这一行，就是被外部杀的');
		note('      取证：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\show-kill-forensics.ps1');
	}
});
child.on('error', (err) => note(`ERROR  spawn failed: ${err.message}`));
