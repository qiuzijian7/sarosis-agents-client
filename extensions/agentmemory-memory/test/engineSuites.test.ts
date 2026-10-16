/*---------------------------------------------------------------------------------------------
 *  engineSuites.test.ts — 把 `src/__tests__/` 的 8 个套件接进**会跑**的 runner（2026-10-14）
 *
 *  ⚠⚠ 为什么需要这个文件：`scripts/run-unit-tests.mjs` **只扫 `out-test/test/`**（＝源 `test/`），
 *     而 `tsconfig.test.json` 的 include 把 `src` 与 `test` 两个目录都收进来（源 `src/__tests__/` 下的
 *     测试会被编到 `out-test/src/__tests__/`）⇒ **那 8 个套件从来没有入口、从来没跑过** ✗✗。
 *     实测铁证：在 `amV2.test.ts` 里写 `assert(false)` ⇒ `npm run test:unit` **照样报 25 passed** ✗。
 *     （讽刺的是 `run-unit-tests.mjs` 自己的注释就在警告"写完不引用 = 零覆盖 ✓" —— 它自己漏扫了 ✗。）
 *
 *  ★ 本文件刻意是**最小侵入**的接法：**不改** runner 的扫描逻辑（那是基础设施、会影响别的流水线 ✗），
 *    只是在它会扫到的 `test/` 里放一个入口，把 8 个套件跑一遍、并把失败**如实上报** ✓。
 *
 *  ⚠ 8 个套件有**两种**上报方式（历史原因，没统一）：
 *    ① 4 个（`bm25Index`/`privacyFilter`/`vectorIndex`/`vectorIndexDim`）用 `./testRunner.js` 的
 *       `describe/it` ⇒ 结果进它的 `_results` ⇒ 用 `getResults()` 读（**最可靠** ✓）；
 *    ② `amV2`/`amV2Integration`/`memoryRWR` 自带 `passed/failed` 计数且**只 `console.log`、不 throw** ✗
 *       ⇒ 只能**劫持 `console.log` 解析汇总行**；`amReplication` 自带计数且**会 throw** ✓。
 *    ⚠ ② 里那三个**不能**当作"不用管"：不 throw ⇒ **失败会被静默吞掉** ✗ —— 那正是本次要堵的洞 ✓。
 *    ⚠ `printSummary()` **绝不能调**（它结尾 `process.exit` ✗，会把整个 mocha 进程带走 ✗）。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { getResults, drainAsync } from '../src/__tests__/testRunner.js';
import { runBM25Tests } from '../src/__tests__/bm25Index.test.js';
import { runPrivacyFilterTests } from '../src/__tests__/privacyFilter.test.js';
import { runVectorTests } from '../src/__tests__/vectorIndex.test.js';
import { runVectorDimensionTests } from '../src/__tests__/vectorIndexDim.test.js';
import { runAmV2Tests } from '../src/__tests__/amV2.test.js';
import { runAmV2IntegrationTests } from '../src/__tests__/amV2Integration.test.js';
import { runMemoryRWRTests } from '../src/__tests__/memoryRWR.test.js';
import { runAmReplicationTests } from '../src/__tests__/amReplication.test.js';

// 与 `test/` 其它文件同法：runner 用 mocha tdd UI 注入全局 suite/test，不可 import 'mocha' ✓
declare function suite(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void | Promise<void>): void;

/** 跑一个"只 console.log 汇总、不 throw"的套件 ⇒ 劫持 log 解析出失败数（没有汇总行也算失败 ✗）。 */
async function runQuietSuite(label: string, runner: () => Promise<void>): Promise<{ passed: number; failed: number; note: string }> {
	const logs: string[] = [];
	const origLog = console.log;
	console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
	let thrown = '';
	try {
		await runner();
	} catch (e) {
		thrown = String((e as Error)?.message ?? e);
	} finally {
		console.log = origLog;
	}
	// ⚠⚠ **不要**在这里按 `thrown` 早返回（2026-10-14 反向突变抓到的 bug ✗）：
	//   套件在 `throw` **之前**已经把汇总行打出来了 ⇒ 早返回会**丢掉数字** ✗
	//   （实测现象：`amV2 0/1` 而不是 `430/431` ✗）。⇒ 先按汇总行取数字，`thrown` 只作为附加说明 ✓
	// ⚠ 找汇总行的条件**不能**要求出现 "Result" 字样：`amReplication` 打的是
	//   `amReplication: 13 passed, 1 failed`（**没有** Result ✗）⇒ 直接按"数字 + passed/failed"找 ✓
	const line = logs.find(l => /\d+\s+passed,\s*\d+\s+failed/i.test(l)) ?? '';
	// ⚠ `total` 必须**可选**：`amReplication` 打的是 `13 passed, 1 failed`（**没有** total ✗），
	//   而 `amV2` 打的是 `431 passed, 0 failed, 431 total`（有 ✓）⇒ 要求 total 会把前者误判成"没跑完" ✗
	const m = /(\d+)\s+passed,\s*(\d+)\s+failed(?:,\s*(\d+)\s+total)?/i.exec(line);
	if (!m) {
		// ⚠ 没有汇总行**必须**算失败：否则"套件悄悄不打印"＝失败被吞（正是要堵的洞 ✗）
		return { passed: 0, failed: 1, note: thrown ? `套件抛出且无汇总：${thrown.slice(0, 110)}` : `没找到汇总行（套件可能没跑完）` };
	}
	// ⚠ 即使**抛出了**也要用汇总行的数字：套件在 `throw` 之前已经把汇总打出来了 ✓
	//   （2026-10-14 给 amV2/amV2Integration/memoryRWR 加了 throw 后，走 catch 分支会**丢掉数字** ✗）
	return {
		passed: Number(m[1]), failed: Number(m[2]),
		note: line.trim().slice(0, 100) + (thrown ? `（并抛出：${thrown.slice(0, 60)}）` : ''),
	};
}

suite('引擎侧 src/__tests__ 的 8 个套件（此前**无入口 ⇒ 从未跑过**）', () => {
	test('8 个套件全部跑完且**零失败**（含"只 log 不 throw"的那三个）', async () => {
		// ① 四个走 testRunner 的套件（同步注册 + async 落定）
		const before = getResults().length;
		runBM25Tests();
		runPrivacyFilterTests();
		runVectorTests();
		runVectorDimensionTests();
		await drainAsync();
		const viaRunner = getResults().slice(before);
		const runnerFailed = viaRunner.filter(r => !r.passed);

		// ② 三个"只 log 不 throw" + 一个"会 throw"的
		// ⚠⚠ **必须串行**（2026-10-14 实测踩到 ✗）：`runQuietSuite` 靠**劫持 `console.log`** 拿汇总，
		//   而劫持是**全局的** ⇒ 用 `Promise.all` 并发跑时几个套件会**互相覆盖**劫持（后一个保存的
		//   `origLog` 是前一个的劫持版 ⇒ 恢复时层层套娃）⇒ 表现为**随机有套件收不到汇总** ✗✗
		//   （实测：`amV2`/`memoryRWR` 解析失败、`amV2Integration`/`amReplication` 却正常 ✓）。
		const quiet: Array<{ passed: number; failed: number; note: string }> = [];
		quiet.push(await runQuietSuite('amV2', runAmV2Tests));
		quiet.push(await runQuietSuite('amV2Integration', runAmV2IntegrationTests));
		quiet.push(await runQuietSuite('memoryRWR', runMemoryRWRTests));
		quiet.push(await runQuietSuite('amReplication', runAmReplicationTests));
		const quietPassed = quiet.reduce((s, r) => s + r.passed, 0);
		const quietFailed = quiet.reduce((s, r) => s + r.failed, 0);

		const detail = [
			`testRunner 系 ${viaRunner.length - runnerFailed.length}/${viaRunner.length}`
			+ `【before=${before} total=${getResults().length} 注册=${before + viaRunner.length}】`,
			...quiet.map((r, i) => `${['amV2', 'amV2Integration', 'memoryRWR', 'amReplication'][i]} ${r.passed}/${r.passed + r.failed}`),
		].join(' · ');
		const total = viaRunner.length + quietPassed + quietFailed;

		// ⚠ 同时守住"接上来了这么多条"：若某天某个套件被删/不再被 import，总数会掉 ⇒ 立刻红 ✓
		assert(total >= 500, `接入的断言总量应 ≥500（实测 500+），实际 ${total} —— 是否有套件没跑？ [${detail}]`);
		assert(
			runnerFailed.length === 0 && quietFailed === 0,
			`有套件失败：testRunner 系 ${runnerFailed.length} 条（${runnerFailed.slice(0, 3).map(r => r.name).join('; ')}）`
			+ ` · ${quiet.map((r, i) => (r.failed ? `${['amV2', 'amV2Integration', 'memoryRWR', 'amReplication'][i]}: ${r.note}` : '')).filter(Boolean).join(' · ')}`
			+ ` ［${detail}］`,
		);
	});
});
