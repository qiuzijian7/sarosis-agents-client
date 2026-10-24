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

/** 跑一条命令并取 stdout（失败返回空串，绝不抛）。 */
const execSyncSafe = (cmd) => {
	const r = spawnSync('cmd.exe', ['/d', '/s', '/c', cmd], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
	return String(r.stdout || '');
};

const portFree = (port) => new Promise((resolve) => {
	const srv = net.createServer();
	srv.once('error', () => resolve(false));
	srv.once('listening', () => srv.close(() => resolve(true)));
	srv.listen(port, '127.0.0.1');
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
		process.exit(0);
	}
	if (hasVisibleAppWindow()) {
		note('SKIP a dev instance is already running (visible window present), attach to it');
		process.exit(0);
	}
	note('SKIP-ZOMBIE 实例在跑但**没有桌面窗口**（窗口已销毁、IDE 主窗口仍被隐藏）⇒ 屏幕上看不到 app');
	if (process.env.DSH_DEV_FORCE_RESTART !== '1') {
		note('        处理：① 设 $env:DSH_DEV_FORCE_RESTART=1 再 F5（自动结束僵尸实例并重开）；② 或手动结束 Saroasis harness.exe 后 F5');
		process.exit(0);
	}
	note('        按 DSH_DEV_FORCE_RESTART=1 ⇒ 结束僵尸实例后重开');
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
for (let k = 0; k < CANDIDATES.length; k++) {
	const [d, i] = CANDIDATES[k];
	const waitMs = (d === DEFAULT_PAIR[0] && i === DEFAULT_PAIR[1]) ? 20000 : 3000;
	if (await waitFreePair(d, i, waitMs)) { chosen = [d, i]; break; }
	const dd = WHO_OWNS(d), di = WHO_OWNS(i);
	note(`PORTBUSY ${d}=${dd.alive ? dd.name + ' pid ' + dd.pid : 'GHOST'} ${i}=${di.alive ? di.name + ' pid ' + di.pid : 'GHOST'}`);
}
if (!chosen) {
	note(`ABORT 所有候选端口都被占用/幽灵占用 ⇒ 不启动。处理：关掉占用者；或注销会话/重启机器释放幽灵端口；或 $env:DSH_DEV_PORTS='<dbg>:<inspect>' 并同步改 launch.json`);
	process.exit(2);
}

debugPort = chosen[0];
inspectPort = chosen[1];

// 让 attach 配置**永远**跟着实际端口走（否则 F5 必然连不上）。
// ⚠ 必须无条件同步：幽灵端口释放后我们会回到 9799，而 launch.json 可能还停在上一轮换的
//   9222（本机 14:52 → 14:57 就撞到过一次）⇒ 两边又不一致。这里读文件里的**当前**端口再改。
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
	const curI = portAfter('Attach to Main Process', text);
	let next = text;
	if (curD && curD !== debugPort) { next = next.replace(new RegExp(`("port"\\s*:\\s*)${curD}\\b`, 'g'), `$1${debugPort}`); }
	if (curI && curI !== inspectPort) { next = next.replace(new RegExp(`("port"\\s*:\\s*)${curI}\\b`, 'g'), `$1${inspectPort}`); }
	next = next.replace(new RegExp(`\\(${curD}\\)`, 'g'), `(${debugPort})`);
	if (next !== text) {
		fs.writeFileSync(lj, next);
		note(`LAUNCHJSON synced port ${curD}→${debugPort}, ${curI}→${inspectPort}（attach 指向真实端口，F5 可直接用）`);
	}
} catch (e) {
	note(`LAUNCHJSON sync failed: ${String(e && e.message).slice(0, 120)} ⇒ 请手动把 launch.json 的 port 改成 ${debugPort}`);
}
note(`PORTS inspect=${inspectPort} debug=${debugPort}`);


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

const srcNewest = newestUnder(path.join(REPO, 'src'), /\.ts$/);
const outNewest = newestUnder(path.join(REPO, 'out'), /\.js$/);
if (srcNewest.t > outNewest.t) {
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

const deploy = spawnSync(process.execPath, [path.join(HERE, 'dsh-plugin-deploy.mjs'), '--changed'], {
	cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 300000,
});
const deployLines = String(deploy.stdout || '').split(/\r?\n/).filter((l) => /^✓|⚠/.test(l.trim()));
if (deployLines.length) {
	deployLines.forEach((l) => note('PLUGIN ' + l.trim().replace(/^✓\s*/, '')));
} else {
	note('PLUGIN no changes (all dsh plugins in profile match repo)');
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
	if (await devtoolsAlive(debugPort)) {
		clearInterval(readyTimer);
		note(`READY  debug=${debugPort} attach-ready after ${Math.round((Date.now() - readyStart) / 1000)}s`);
	}
}, 2000);

child.on('exit', (code, signal) => {
	clearInterval(readyTimer);
	const hex = typeof code === 'number' && code !== 0 ? '0x' + (code >>> 0).toString(16).toUpperCase().padStart(8, '0') : '-';
	note(`EXIT   pid=${child.pid} code=${code} signal=${signal ?? '-'} hex=${hex}`);
});
child.on('error', (err) => note(`ERROR  spawn failed: ${err.message}`));
