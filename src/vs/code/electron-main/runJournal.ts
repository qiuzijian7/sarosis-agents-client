/*---------------------------------------------------------------------------------------------
 *  Run journal (main process)
 *
 *  ★★ 2026-10-24：为什么需要它
 *
 *  本仓有**两条互不相通的启动路径**：
 *    ① `scripts/start-dev-app.*`（`Launch & Attach Dev`）：自己 spawn exe，能拿到 (code, signal)，
 *       并把子进程 stdout/stderr 落盘 ⇒ 崩溃/被杀/正常退出都留痕 ✓
 *    ② `.vscode/launch.json` 里的 **launch 型**配置（`Launch VS Code Internal（launch：调试结束会
 *       关掉应用）` 等）：由 js-debug 直接 spawn exe。这条路**完全没有** START/EXIT 记录，
 *       而 js-debug 在调试会话结束时会按 `cleanUp: wholeBrowser` **直接杀掉应用**
 *       ⇒ 用户看到"用着用着自动关闭"，而我们的日志里**一条痕迹都没有** ✗✗。
 *
 *  这个模块把**每条路径**都补上最小可观测性（写进与该路径无关的 `logs/app-exit.log`）：
 *    · `START  [run] src=<来源> pid=… argv=…`
 *    · `EXIT   [run] src=… pid=… reason=will-quit`
 *    · `PREV-DIED [run] pid=… src=… survived=<秒>s`  ← 上次运行**没有**走 will-quit 就消失
 *      （= 崩溃 / 被 js-debug 杀掉 / 被 Stop-Process），本行在下一次启动时补记。
 *
 *  `survived` 由运行期每 30s 刷新的 marker 得到，所以即使进程被硬杀，也能知道"活了多久"。
 *  来源标签：`DSH_LAUNCH_SRC` 环境变量（launch.json 里置 `debug-launch`，启动器置 `launcher`）。
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface IRunJournalLogger {
	info(message: string): void;
}

interface IRunMarker {
	pid: number;
	src: string;
	startedAt: number;
	aliveAt?: number;
}

/** 与 `scripts/start-dev-app.mjs` 的 `note()` 保持同一种行格式，便于同一个文件里对照。 */
function stamp(): string {
	const d = new Date();
	const p = (n: number, w = 2) => String(n).padStart(w, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function pidAlive(pid: number): boolean {
	if (!pid || pid === process.pid) {
		return false;
	}
	try {
		process.kill(pid, 0);   // 只探活，不发信号
		return true;
	} catch {
		return false;
	}
}

/**
 * 安装运行日志。应在主进程**尽早**调用（`CodeApplication` 构造函数里），
 * 这样即便后面马上崩，`START` 也已经落盘。
 */
export function installRunJournal(logger: IRunJournalLogger): void {
	const argv = process.argv;
	const arg = argv.find(a => a.startsWith('--user-data-dir='));
	let userData = arg ? arg.slice('--user-data-dir='.length) : '';
	if (!userData) {
		try { userData = app.getPath('userData'); } catch { return; }
	}
	const logsDir = path.join(userData, 'logs');
	const exitLog = path.join(logsDir, 'app-exit.log');
	const markerPath = path.join(userData, 'run-marker.json');

	const src = String(process.env['DSH_LAUNCH_SRC'] ?? '').trim() || 'direct';
	const pid = process.pid;
	const startedAt = Date.now();

	const write = (line: string) => {
		try {
			fs.mkdirSync(logsDir, { recursive: true });
			fs.appendFileSync(exitLog, `${stamp()}  [run] ${line}\n`, 'utf8');
		} catch { /* 日志失败不能影响启动 */ }
	};

	// ① 上次运行有没有"无声消失"（崩溃 / 被 js-debug 杀 / 被 Stop-Process）
	try {
		if (fs.existsSync(markerPath)) {
			const prev = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as IRunMarker;
			if (prev?.pid && !pidAlive(prev.pid)) {
				const survived = prev.aliveAt && prev.startedAt ? Math.round((prev.aliveAt - prev.startedAt) / 1000) : undefined;
				write(`PREV-DIED pid=${prev.pid} src=${prev.src ?? '?'} survived=${survived ?? '?'}s（上次未走 will-quit ⇒ 崩溃 / 被调试器 cleanUp 杀掉 / 被强杀；dump 见 Crashpad）`);
			}
		}
	} catch { /* marker 损坏就当没有 */ }

	write(`START pid=${pid} src=${src} argv=${argv.slice(1).join(' ').slice(0, 300)}`);

	const mark = (aliveAt: number) => {
		try { fs.writeFileSync(markerPath, JSON.stringify({ pid, src, startedAt, aliveAt } satisfies IRunMarker), 'utf8'); } catch { /* ignore */ }
	};
	mark(startedAt);
	// 10s 一次：太小会白写盘，太大则"活了几秒就崩"算不准（30s 时短命运行一律显示 0s ✗）
	const timer = setInterval(() => mark(Date.now()), 10_000);
	// `TimeoutHandle`（src/typings/base-common.d.ts 的空接口）类型上没有 unref，运行时才有
	// ⇒ 结构化断言调用（与 dshHostSupervisor.ts 同口径），不做 `as any`。
	(timer as { unref?: () => void })?.unref?.();

	app.on('will-quit', () => {
		clearInterval(timer);
		write(`EXIT  pid=${pid} src=${src} reason=will-quit`);
		try { fs.unlinkSync(markerPath); } catch { /* ignore */ }
	});

	// ★★ 2026-10-24：`will-quit` 抓不到 `app.exit(code)` / `process.exit(code)`（它们**跳过**
	//   will-quit）—— 真机撞到过 `EXIT code=1` 却没有任何收尾日志的情况，无法判断是谁退的。
	//   以下四个钩子把"立刻退出"的路径也留痕（App 侧 `debugExit`）：
	//     · process 'exit'：拿得到真实退出码（含 app.exit）
	//     · app 'quit'：正常退出的兜底
	//     · render-process-gone：窗口渲染进程崩/被杀（reason=crashed|oom|killed…）
	//     · uncaughtException / unhandledRejection：把堆栈写进同一个日志（stderr 可能来不及刷盘）
	process.on('exit', (code) => {
		write(`EXIT  pid=${pid} src=${src} code=${code} reason=process-exit（app.exit()/process.exit() 也走这里）`);
		try { fs.unlinkSync(markerPath); } catch { /* ignore */ }
	});
	app.on('quit', (_event, code) => {
		write(`QUIT  pid=${pid} src=${src} code=${code}`);
	});
	app.on('render-process-gone', (_event, contents, details) => {
		let url = '';
		try { url = String(contents?.getURL?.() ?? '').slice(0, 120); } catch { /* ignore */ }
		write(`RENDER-GONE url=${url || '(unknown)'} reason=${details?.reason ?? '?'} exitCode=${details?.exitCode ?? '?'}`);
	});
	const soleUncaught = process.listenerCount('uncaughtException') === 0;
	process.on('uncaughtException', (err) => {
		write(`UNCAUGHT ${String((err as Error)?.stack ?? err).slice(0, 1500)}`);
		if (soleUncaught) {
			try { console.error(err); } catch { /* ignore */ }
			process.exit(1);   // 保持 Node 默认语义（未捕获异常 ⇒ 退出码 1）
		}
	});
	// VS Code 内部大量用 `Canceled` 表示"预期内的取消"（如 `Canceled: Canceled`），它们会以
	// unhandledRejection 形式出现且**不是问题**；全量记录会把日志淹掉（实测一次启动就 7+ 条）。
	// 只记"看起来真有问题"的，并对同一条消息做 60s 去重。
	const isBenignRejection = (text: string) => /^(Canceled|Canceled: Canceled|CanceledError|Error: Canceled|AbortError)/i.test(text.trim());
	const seenRejection = new Map<string, number>();
	process.on('unhandledRejection', (reason) => {
		const r = reason as { stack?: string };
		const text = String(r?.stack ?? reason);
		if (isBenignRejection(text)) { return; }
		const key = text.slice(0, 120);
		const last = seenRejection.get(key) ?? 0;
		if (Date.now() - last < 60_000) { return; }
		seenRejection.set(key, Date.now());
		write(`UNHANDLED-REJECTION ${text.slice(0, 1200)}`);
	});

	logger.info(`[RunJournal] src=${src} pid=${pid} ⇒ ${exitLog}`);
}
