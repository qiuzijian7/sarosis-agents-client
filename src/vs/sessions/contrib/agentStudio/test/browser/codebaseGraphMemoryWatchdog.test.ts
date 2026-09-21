/*---------------------------------------------------------------------------------------------
 *  codebaseGraphMemoryWatchdog.test.ts — 解析期内存看门狗（2026-09-21，UE 95k 文件 OOM 实证）
 *
 *  实证（日志 vscode-app-1789978945531，UE 项目 e:\GR_Main，95532 文件）：
 *    watcher +53 ~89 → deficient 判定清哈希强全量 → 解析阶段 heap 348→2230MB（每 30s +~950MB）
 *    → 日志在 16:22:01 戛然而止（~4GB V8 上限处 renderer OOM）。
 *    阶段边界的 `_reportGraphMemory` 只在 `_seg` 触发——解析是单一最长阶段 ⇒ 崩溃前永不响 ✗。
 *
 *  本文件钉住：
 *    ① 纯决策 `resolveParseHeapAction` 的判定矩阵（硬上限用绝对堆 / 软告警用本轮相对增量 —— 口径不同是刻意的 ✗勿合并）；
 *    ② 三条解析循环（增量 runOne / 全量并行 worker / 主线程兜底）都挂了看门狗；
 *    ③ abort 语义：WARN + 进度提示 + `cts.cancel()`（不是静默停）；
 *    ④ 配置键 `saros.codebaseGraph.hardHeapLimitMb` 已注册（读了就必须注册，本仓有「读了没注册」事故前科 ✗）；
 *    ⑤ 中止后的消息带可判读标记（日志复盘时能一眼看出本轮是提前中止而非完整跑完）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/codebaseGraphMemoryWatchdog.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveParseHeapAction } from '../../browser/codebaseGraphMemoryWatchdog.js';

const MB = 1048576;

suite('解析期内存看门狗（resolveParseHeapAction）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★★★ 硬上限用**绝对堆**判定：越过即 abort（与基线无关 ✓）', () => {
		assert.strictEqual(resolveParseHeapAction({ usedBytes: 3073 * MB, baselineBytes: 0, budgetBytes: 512 * MB, hardLimitBytes: 3072 * MB }), 'abort');
		assert.strictEqual(resolveParseHeapAction({ usedBytes: 3072 * MB, baselineBytes: 0, budgetBytes: 512 * MB, hardLimitBytes: 3072 * MB }), 'ok',
			'恰好等于上限不中止（边界 ✓）');
		// 基线很低但绝对堆已越线 ⇒ 仍 abort（崩溃是绝对的，不看增量 ✗）
		assert.strictEqual(resolveParseHeapAction({ usedBytes: 3100 * MB, baselineBytes: 3000 * MB, budgetBytes: 512 * MB, hardLimitBytes: 3072 * MB }), 'abort');
	});

	test('★★ 软告警用**本轮相对增量**判定（基线已知时）：超预算 ×1.5 ⇒ soft', () => {
		// 堆 600MB、基线 100MB、预算 512MB ⇒ 增量 500MB < 768MB ⇒ ok
		assert.strictEqual(resolveParseHeapAction({ usedBytes: 600 * MB, baselineBytes: 100 * MB, budgetBytes: 512 * MB, hardLimitBytes: 3072 * MB }), 'ok');
		// 增量 800MB > 768MB ⇒ soft
		assert.strictEqual(resolveParseHeapAction({ usedBytes: 900 * MB, baselineBytes: 100 * MB, budgetBytes: 512 * MB, hardLimitBytes: 3072 * MB }), 'soft');
	});

	test('基线未知（baseline=0）⇒ 软告警禁用（不拿陈旧基线误报 ✓）；硬上限不受影响', () => {
		assert.strictEqual(resolveParseHeapAction({ usedBytes: 2000 * MB, baselineBytes: 0, budgetBytes: 512 * MB, hardLimitBytes: 3072 * MB }), 'ok');
		assert.strictEqual(resolveParseHeapAction({ usedBytes: 4000 * MB, baselineBytes: 0, budgetBytes: 512 * MB, hardLimitBytes: 3072 * MB }), 'abort');
	});

	test('硬上限为 0 ⇒ 硬中止禁用（配置 0=默认由服务层解析成 3072，0 永不到这里；防御性保留 ✓）', () => {
		assert.strictEqual(resolveParseHeapAction({ usedBytes: 99999 * MB, baselineBytes: 0, budgetBytes: 512 * MB, hardLimitBytes: 0 }), 'ok');
	});
});

suite('解析期内存看门狗 —— 接线（源码级）', () => {

	const SVC = 'src/vs/sessions/contrib/agentStudio/browser/codebaseGraphService.ts';
	const CONTRIB = 'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts';
	const readSrc = (rel: string): string => {
		const abs = path.join(process.cwd(), rel);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};
	const code = (rel: string): string => readSrc(rel)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');

	test('★★★ 三条解析循环都挂看门狗（增量 runOne / 全量并行 worker / 主线程兜底）', () => {
		const src = code(SVC);
		const calls = src.split('this._parseMemoryWatchdog(').length - 1;
		assert.strictEqual(calls, 3, `_parseMemoryWatchdog 必须恰好挂在三处解析循环（实际 ${calls}）✗`);
		// 增量路径：本次 OOM 的发生路径 —— 解析结果全部攒在 parseResults 里，必须按 push 数检查
		assert.ok(src.includes('parseResults.length % CodebaseGraphService.PARSE_MEM_CHECK_EVERY === 0'),
			'增量 runOne 必须按 parseResults 增长数检查 ✗');
	});

	test('★★★ abort 必须**取消本轮**（cts.cancel）+ WARN + 进度提示（不是静默停 ✗）', () => {
		const src = code(SVC);
		const idx = src.indexOf('private _parseMemoryWatchdog(');
		assert.ok(idx !== -1, '找不到 _parseMemoryWatchdog ✗');
		const body = src.slice(idx, idx + 2600);
		assert.ok(body.includes("resolveParseHeapAction({"), '必须复用纯决策函数（别就地再写判定 ✗）');
		assert.ok(body.includes('cts.cancel()'), 'abort 必须取消本轮解析 ✗');
		assert.ok(body.includes('内存超限'), 'abort 必须给用户可见的进度提示 ✗');
		assert.ok(body.includes('已解析部分照常收尾落盘') || body.includes('已解析部分照常保留'),
			'日志必须说明部分索引会保留（收敛语义 ✓）');
	});

	test('★★★ 硬上限配置键已注册（读了就必须注册 ✓）', () => {
		const contrib = code(CONTRIB);
		assert.ok(contrib.includes("'saros.codebaseGraph.hardHeapLimitMb'"), '配置键必须注册 ✗');
		const svc = code(SVC);
		assert.ok(svc.includes("getValue<number>('saros.codebaseGraph.hardHeapLimitMb')"), '服务必须读该键 ✗');
	});

	test('★★ 中止后结果消息带可判读标记（复盘时一眼看出是提前中止 ✓）', () => {
		const src = code(SVC);
		const marks = src.split('内存超限已提前中止').length - 1;
		assert.ok(marks >= 2, `增量与全量两条完成消息都要带中止标记（实际 ${marks}）✗`);
	});
});
