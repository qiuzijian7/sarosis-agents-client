/*---------------------------------------------------------------------------------------------
 *  spawn-detached.mjs —— 把一个 node 脚本**完全脱离**当前控制台启动，然后立刻退出。
 *
 *  ★★ 2026-10-25（用户报「F5 无法启动」）
 *
 *  `.cmd` 里原来用 `start "" /b node start-dev-app.mjs`：`start /b` 让子进程**共享当前
 *  控制台并继承 std 句柄**，而启动器要常驻（记录子进程退出码）⇒ 父进程的 stdout 管道永远
 *  拿不到 EOF ⇒ VS Code 的 `preLaunchTask` 一直不结束 ⇒ 卡在"启动 preLaunchTask…"，
 *  应用其实已经起来，但 attach 永远等不到（实测 `cmd` 60s 不返回，而 app-exit.log 里已 READY）。
 *
 *  实测对照（同机）：
 *    `start /b powershell -Command "Start-Sleep 60"`  ⇒ 父进程也阻塞到 60s
 *    ⇒ 与我们的脚本无关，是 `start /b` 的共享控制台语义本身。
 *
 *  这里改用 Node 的 `detached: true` + `stdio: 'ignore'`：子进程**不继承任何句柄**，
 *  本进程立刻退出 ⇒ 管道立即关闭 ⇒ preLaunchTask 秒级返回 ✓
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const script = process.argv[2];
if (!script || !fs.existsSync(script)) {
	console.error(`[spawn-detached] script not found: ${script ?? '(missing)'}`);
	process.exit(2);
}

const logDir = path.join(os.homedir(), '.vssaros-dev', 'logs');
fs.mkdirSync(logDir, { recursive: true });
const outFd = fs.openSync(path.join(logDir, 'launcher.log'), 'a');
const errFd = fs.openSync(path.join(logDir, 'launcher.log'), 'a');

const child = spawn(process.execPath, [path.resolve(script)], {
	detached: true,
	stdio: ['ignore', outFd, errFd],
	cwd: path.dirname(path.resolve(script)),
	env: process.env,
	windowsHide: true,
});
child.unref();
fs.closeSync(outFd);
fs.closeSync(errFd);

// ── 等启动器给出"结论"再退出（2026-10-25）───────────────────────────────────────
// 以前这里 spawn 完立刻退出 ⇒ 任务永远"成功"⇒ 启动器即使 ABORT（out/ 残缺、端口全死…）
// VS Code 也照样去 attach，然后干等 90s —— 用户看到的就是「F5 没反应」，原因只躺在日志里 ✗。
// 现在：盯着 app-exit.log 里**本次启动器 pid** 之后的行，看到结论就退出：
//   START / SKIP / HANDOFF ⇒ exit 0（继续 attach）
//   ABORT                 ⇒ exit 1，并把原因打到任务终端 ⇒ VS Code 弹「preLaunchTask 失败」✓
// 子进程已 detached 且 stdio 指向文件，本进程退出不会影响它（也不会再卡住任务管道）。
const EXIT_LOG = path.join(logDir, 'app-exit.log');
const TIMEOUT_MS = Number(process.env.DSH_DEV_VERDICT_TIMEOUT_MS) > 0 ? Number(process.env.DSH_DEV_VERDICT_TIMEOUT_MS) : 180000;
const marker = `LAUNCH pid=${child.pid}`;
const started = Date.now();
let printed = 0;

const poll = () => {
	let lines = [];
	try { lines = fs.readFileSync(EXIT_LOG, 'utf8').split(/\r?\n/); } catch { /* 还没写 */ }
	const at = lines.findIndex((l) => l.includes(marker));
	if (at >= 0) {
		const mine = lines.slice(at).filter(Boolean);
		// 只回显关键行，避免几十行 PLUGIN 刷屏
		for (const l of mine.slice(printed)) {
			if (/LAUNCH|WATCH|TRANSPILE|OUT |PORTS|PORTBUSY|PORTRANDOM|START|SKIP|ABORT|HANDOFF|原因|处理/.test(l)) {
				console.log(l.slice(24).trim());
			}
		}
		printed = mine.length;
		const verdict = mine.find((l) => /\s(ABORT|START  port=|SKIP|HANDOFF)/.test(l));
		if (verdict) {
			if (/\sABORT/.test(verdict)) {
				console.error('\n[start-dev-app] 启动被拒绝（见上面的 ABORT 原因）。详细日志：' + EXIT_LOG);
				process.exit(1);
			}
			process.exit(0);
		}
	}
	if (Date.now() - started > TIMEOUT_MS) {
		console.log(`[start-dev-app] ${Math.round(TIMEOUT_MS / 1000)}s 内启动器未给出结论 ⇒ 交给 attach 继续等（看 ${EXIT_LOG}）`);
		process.exit(0);
	}
	setTimeout(poll, 300);
};
poll();
