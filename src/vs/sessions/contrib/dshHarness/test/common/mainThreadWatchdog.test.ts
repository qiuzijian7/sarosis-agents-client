/*---------------------------------------------------------------------------------------------
 *  mainThreadWatchdog.test.ts — 主线程停更看门狗（2026-10-22，三次卡死事故的取证工具）
 *
 * 现场（2026-10-22 20:03 那次）：主进程 `Runtime.evaluate` 超时、CPU 0%、38 线程全 Wait、
 * 渲染进程与 dsh Host 都被连带 —— 能确定「主线程被 native 阻塞」，但**指不出是哪个调用**，
 * 因为主线程一卡，连"写一行日志"都做不到 ✗。
 *
 * 本测试证明：**独立 worker** 能在主线程被真阻塞时照样落盘一行诊断，且**指名最后阶段**。
 * 用 `Atomics.wait()` 模拟阻塞 —— 它让出 CPU（0%，和 native 阻塞同形态），
 * 而不是忙等（忙等会污染 `cpu=%` 这个判读字段）。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { markMainThreadPhase } from '../../../../../code/electron-main/mainThreadBreadcrumb.js';
import { startMainThreadWatchdog } from '../../../../../code/electron-main/mainThreadWatchdog.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';

/** 轻量假 logger（看门狗只需要 info/warn；测试不依赖真日志设施）。 */
function fakeLog(): ILogService {
	const noop = (): void => { /* ignore */ };
	return { info: noop, warn: noop, error: noop, trace: noop, debug: noop, dispose: noop } as unknown as ILogService;
}

/** 真·阻塞当前线程 `ms` 毫秒（0% CPU，与 native 阻塞同形态）。 */
function blockThread(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

suite('mainThreadWatchdog / 主线程停更必须被独立 worker 抓到', () => {

	test('★ 阻塞 > stallMs ⇒ 落盘 STALL 行并指名最后阶段（带 CPU%）', async () => {
		const logPath = path.join(os.tmpdir(), `saros-hang-${Date.now()}.log`);
		const disposable = startMainThreadWatchdog(fakeLog(), { logPath, stallMs: 600, checkMs: 100 });
		try {
			markMainThreadPhase('credit-route');
			blockThread(2_500);              // 模拟主线程被 native 调用卡住
			await new Promise<void>(r => setTimeout(r, 500));   // 让 worker 至少跑一拍
		} finally {
			disposable.dispose();
		}
		const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
		assert.match(text, /STALL \d+s phase=credit-route/,
			`必须抓到停更并指名阶段（否则下次冻结还是只能猜）；实际：${JSON.stringify(text)}`);
		assert.match(text, /cpu=\d+%/, '要带 CPU 占用率 —— 判"在等(≈0%)"还是"在算(高)"的唯一依据 ✗');
	});

	test('★ 主线程一直在动 ⇒ 一行都不许报（不能制造噪音）', async () => {
		const logPath = path.join(os.tmpdir(), `saros-hang-idle-${Date.now()}.log`);
		const disposable = startMainThreadWatchdog(fakeLog(), { logPath, stallMs: 600, checkMs: 100 });
		try {
			for (let i = 0; i < 12; i++) {
				markMainThreadPhase('heartbeat');
				await new Promise<void>(r => setTimeout(r, 100));
			}
		} finally {
			disposable.dispose();
		}
		const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
		assert.strictEqual(text.trim(), '', `主线程活着时不许落盘任何 STALL（噪音会淹没真现场 ✗）；实际：${text}`);
	});

	test('SAROSIS_MAIN_WATCHDOG=0 ⇒ 关得掉（排障时可能需要）', async () => {
		const logPath = path.join(os.tmpdir(), `saros-hang-off-${Date.now()}.log`);
		const prev = process.env['SAROSIS_MAIN_WATCHDOG'];
		process.env['SAROSIS_MAIN_WATCHDOG'] = '0';
		try {
			const disposable = startMainThreadWatchdog(fakeLog(), { logPath, stallMs: 100, checkMs: 50 });
			markMainThreadPhase('credit-route');
			blockThread(600);
			await new Promise<void>(r => setTimeout(r, 300));
			disposable.dispose();
		} finally {
			if (prev === undefined) { delete process.env['SAROSIS_MAIN_WATCHDOG']; } else { process.env['SAROSIS_MAIN_WATCHDOG'] = prev; }
		}
		assert.strictEqual(fs.existsSync(logPath), false, '关掉后不许再落盘 ✗');
	});

	// ─── 接线守卫（防后人拆掉：拆了看门狗就静默失效，下次冻结又只能猜 ✗）───────────────
	const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

	test('*** watchdog must be wired into the main process + heartbeat + suspects', () => {
		// ① 主进程启动时必须启动它，并把诊断写到 <logsHome>/main-hang.log
		const main = read('src/vs/code/electron-main/main.ts');
		assert.ok(main.includes('startMainThreadWatchdog(logService'), 'main.ts must start the watchdog');
		assert.ok(main.includes("'main-hang.log'"), 'diagnostics must go to <logsHome>/main-hang.log (findable next time)');
		// ② 心跳每拍打点（否则面包屑不更新 ⇒ 看门狗把正常状态当成停更 ✗）
		const beat = read('src/vs/code/electron-main/mainHeartbeat.ts');
		assert.ok(/markMainThreadPhase\('heartbeat'\)/.test(beat), 'the heartbeat must touch the breadcrumb every tick');
		// ③ 已知可疑阶段必须打点（2026-10-22 那次冻结前的最后两个动作）
		const credit = read('src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts');
		assert.ok(credit.includes("markMainThreadPhase('credit-route')"), 'credit.route handler must be marked (it was the last log before the 2026-10-22 freeze)');
		const view = read('src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts');
		assert.ok(view.includes("markMainThreadPhase('dsh-view-probe')"), 'the 15s page probe must be marked');
		const store = read('src/vs/sessions/contrib/agentStudio/electron-main/codebaseGraphStoreChannel.ts');
		assert.ok(store.includes("markMainThreadPhase('sqlite-call')"), 'the sqlite IPC entry must be marked');
	});

	test('*** phase table is append-only (diagnostics on disk must stay readable)', () => {
		const src = read('src/vs/code/electron-main/mainThreadBreadcrumb.ts');
		// 头注里写着"只允许追加"；这里钉住前 4 个（已可能出现在历史诊断文件里）
		const m = /export const MAIN_PHASES = \[([\s\S]*?)\] as const;/.exec(src);
		assert.ok(m, 'MAIN_PHASES not found');
		const names = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
		assert.deepStrictEqual(names.slice(0, 4), ['idle', 'heartbeat', 'credit-route', 'dsh-view-probe'],
			'the first phase indices are an ABI (they appear in main-hang.log) -- append only, never reorder');
	});

/**
 * ★★ 2026-10-22（"卡在第一个 10 万行 chunk 的 commit/checkpoint"现场）：
 *   主进程 SQLite 的 commit / checkpoint / 批量写必须各自打阶段标记 —— 它们**不在** IPC 入口那一段里
 *   （入口早已把控制权还给事件循环），只有分开标，下次 STALL 才能直接说"卡在 sqlite-commit"。
 *   另外 UV_THREADPOOL_SIZE 必须调大：默认 4 个池线程被 SQLite 语句占满时，
 *   任何**同步** fs 调用都排队等池线程 ⇒ 主线程事件循环直接停摆（inspector 都执行不了）。
 */
suite('mainThreadWatchdog / SQLite 长尾必须被标记（否则 STALL 只写 heartbeat）', () => {

	test('★ 阶段表必须含 sqlite-commit / sqlite-checkpoint / sqlite-write', () => {
		const src = read('src/vs/code/electron-main/mainThreadBreadcrumb.ts');
		for (const phase of ['sqlite-commit', 'sqlite-checkpoint', 'sqlite-write']) {
			assert.ok(src.includes("'" + phase + "'"), '阶段表缺 ' + phase + '（卡在那一步只会写 phase=heartbeat ✗）');
		}
	});

	test('★ store 必须在 commit / checkpoint / 边批量写 三处打点', () => {
		const src = read('src/vs/sessions/contrib/agentStudio/node/codebaseGraphSqliteStore.ts');
		const pairs = [
			['async commitProjectSync(', 'sqlite-commit'],
			['async checkpoint()', 'sqlite-checkpoint'],
			['async upsertEdgesBatch(', 'sqlite-write'],
		];
		for (const pair of pairs) {
			const at = src.indexOf(pair[0]);
			assert.ok(at > 0, '找不到 ' + pair[0] + '（守卫不能空跑）');
			const head = src.slice(at, at + 600);
			assert.ok(head.indexOf('markMainThreadPhase(' + "'" + pair[1] + "'" + ')') > 0,
				pair[0] + ' 入口必须 markMainThreadPhase(' + pair[1] + ') ✗');
		}
	});

	test('★ main.ts 必须加大 libuv 线程池（否则同步 fs 被 SQLite 语句饿死）', () => {
		const src = read('src/vs/code/electron-main/main.ts');
		const at = src.indexOf('UV_THREADPOOL_SIZE');
		assert.ok(at > 0, '必须设置 UV_THREADPOOL_SIZE ✗');
		assert.ok(at < 4000, '必须在文件顶部设置（libuv 只读一次池大小）✗');
		assert.ok(src.slice(at, at + 120).indexOf('16') > 0, '池大小要是两位数（默认 4 不够）✗');
	});
});

});
