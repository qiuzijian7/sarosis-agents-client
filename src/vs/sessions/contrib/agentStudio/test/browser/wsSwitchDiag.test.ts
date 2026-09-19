/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 切换工作区「卡住」诊断的不变量（2026-09-16）。
 *
 * 用户报「每次切换工作区 app 就卡住」，而手上那份 6969 行日志有两个致命缺口：
 *   ① **没有时间戳**（格式是 `file:line LEVEL [Tag] msg`）⇒ 事后算不出任何一步耗时；
 *   ② **主线程被同步阻塞时日志自身也写不出去** ⇒ 最后一行只是「阻塞前最后落盘的那条」。
 *
 * 于是只能靠两件事定位：**阶段标记 + 看门狗事后补报**（回答「卡在哪一步、卡了多久」），
 * 以及关键步骤**自己算耗时**。本文件把这两件事钉住：
 *   · **纯函数**（报告格式）直接单测 —— 一条缺时长或缺阶段名的报告等于没写；
 *   · **接线**用源码级断言（与 `guardrailWiring.test.ts` 同一手法）—— 这些标记/耗时散落在
 *     7 个文件里（切换入口、配置重算、图谱解压解析、prune、BM25、内存配置重读、prompts 扫描），
 *     删掉任何一处都会让「卡住」重新变成不可定位的问题。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/wsSwitchDiag.test.ts
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { ILogService } from '../../../../platform/log/common/log.js';
import {
	WS_BLOCK_REPORT_MS,
	WS_HEARTBEAT_MS,
	WS_LATENCY_WARN_MS,
	WS_LATENCY_WINDOW_MS,
	formatBlockReport,
	formatLatencyReport,
	formatResumeReport,
	startMainThreadWatchdog,
	wsStage,
	wsStageAge,
	wsStageName,
} from '../../browser/wsSwitchDiag.js';

/** 读取仓库内某文件（测试从仓库根跑，所有路径都相对 cwd）。 */
function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

/** 源码级接线断言：文件里必须出现这个 needle。 */
function wired(rel: string, needle: string, why: string): void {
	assert.ok(read(rel).includes(needle), `[${rel}] 缺少「${needle}」—— ${why}`);
}

suite('切换卡住诊断 — 报告格式（纯函数）', () => {

	test('★★★ 阻塞报告必须同时带**时长**与**阶段名**（缺任一项都无法定位）', () => {
		const line = formatBlockReport(3230, 'graph: 解析 JSON（graph.db.zst）', 3300, WS_HEARTBEAT_MS, 2140);
		assert.ok(line.includes('3230'), `必须报阻塞时长：${line}`);
		assert.ok(line.includes('graph: 解析 JSON'), `必须报阶段名（否则不知道卡在哪）：${line}`);
		assert.ok(line.includes('2140MB'), `应带 renderer 堆占用（区分「重活」与「GC/内存压力」）：${line}`);
		assert.ok(line.includes(String(WS_HEARTBEAT_MS)), `应说明心跳间隔（测量口径）：${line}`);
	});

	test('★ 取不到堆占用时不得出现 undefined / MB（日志里出现这两个都很误导）', () => {
		const line = formatBlockReport(2500, 'switch: x', 2500, WS_HEARTBEAT_MS, undefined);
		assert.ok(!line.includes('undefined'), line);
		assert.ok(!line.includes('MB'), line);
	});

	test('★ 恢复报告必须带累计阻塞时长（跨多个心跳周期时看总账）', () => {
		assert.ok(formatResumeReport(5100, 'switch: configurationService.initialize').includes('5100'));
	});

	test('★★★ 交互延迟报告必须带**排队时长 + 阶段 + 窗口**（它才是「点一下要等多久」）', () => {
		const line = formatLatencyReport(420, 'graph: 解析 JSON（graph.db.zst）', WS_LATENCY_WINDOW_MS, 25);
		assert.ok(line.includes('420'), `必须报排队时长：${line}`);
		assert.ok(line.includes('graph: 解析 JSON'), `必须报阶段：${line}`);
		assert.ok(line.includes('5s'), `必须报统计窗口（否则不知道是多久内的最慢）：${line}`);
		assert.ok(line.includes('25'), `应带样本数（判断是一次偶发还是一直如此）：${line}`);
	});

	test('★ 阶段标记可读回（看门狗报的就是这个名字）；且不带标记时也有默认值', () => {
		wsStage('unit-test-stage');
		assert.strictEqual(wsStageName(), 'unit-test-stage');
		// 传入「未来时间」以保证确定性（不依赖真实 sleep）
		assert.ok(wsStageAge(Date.now() + 1234) >= 1234, '阶段年龄应可计算');
	});

	test('★★★ 看门狗真的测得出来：忙等 200ms 必然落一条「阻塞」+ 一条「恢复」', async () => {
		// 这条测的是**测量机制本身**（心跳漂移），不是格式 —— 机制错了，真机上就永远没有阻塞日志，
		// 而「没有阻塞日志」又会与「探针没跑」混为一谈（正是本次要避免的失败模式）。
		const lines: string[] = [];
		const fakeLog = { info: (m: string) => { lines.push(String(m)); } } as unknown as ILogService;
		const watchdog = startMainThreadWatchdog(fakeLog, { intervalMs: 20, thresholdMs: 50, maxReports: 5 });
		try {
			await new Promise<void>(resolve => setTimeout(resolve, 60)); // 先让心跳正常跑几拍
			wsStage('unit-test-blocking-stage');
			const t0 = Date.now();
			while (Date.now() - t0 < 200) { /* 忙等：模拟主线程被同步重活占住 */ }
			await new Promise<void>(resolve => setTimeout(resolve, 80)); // 阻塞结束后让下一拍跑出来
		} finally {
			watchdog.dispose();
		}

		const blocked = lines.find(l => l.includes('主线程阻塞'));
		assert.ok(blocked, `必须上报阻塞（否则真机上永远定位不到卡住）：${lines.join(' | ') || '(无输出)'}`);
		assert.ok(blocked!.includes('unit-test-blocking-stage'), `必须带当时阶段：${blocked}`);
		const ms = Number(/阻塞 ≈(\d+)ms/.exec(blocked!)?.[1] ?? '0');
		assert.ok(ms >= 50, `报出的阻塞时长应 ≥ 阈值，实际 ${ms}ms：${blocked}`);
		assert.ok(lines.some(l => l.includes('主线程恢复')), `恢复也要报（否则不知道卡了多久/是否结束）：${lines.join(' | ')}`);
	});

	test('★★★ 切片式饱和必须被「交互延迟」抓到（第一版只有漂移 ⇒ 真机一条都没报）', async () => {
		// 复现真机形态：每片忙 30ms 再让出（与 `_parseGraphStreaming` 的 8ms 切片同形），
		// **没有任何单片超过阻塞阈值** ⇒ 漂移通道永远不响，只有排队延迟能抓到它。
		const lines: string[] = [];
		const fakeLog = { info: (m: string) => { lines.push(String(m)); } } as unknown as ILogService;
		const watchdog = startMainThreadWatchdog(fakeLog, {
			intervalMs: 20,
			thresholdMs: 1_000_000, // 形同关闭：本用例要证明的正是「没有连续阻塞也照样能定位」
			latencyWarnMs: 20,
			latencyWindowMs: 60,
			maxReports: 5,
		});
		try {
			wsStage('unit-test-sliced-saturation');
			for (let i = 0; i < 20; i++) {
				const t0 = Date.now();
				while (Date.now() - t0 < 30) { /* 一片 30ms 的同步重活 */ }
				await new Promise<void>(resolve => setTimeout(resolve, 0)); // 切片后让出
			}
		} finally {
			watchdog.dispose();
		}

		const latency = lines.find(l => l.includes('交互延迟'));
		assert.ok(latency,
			`切片式饱和必须上报（否则「切换后卡几十秒」在日志里永远无迹可寻）：${lines.join(' | ') || '(无输出)'}`);
		assert.ok(latency!.includes('unit-test-sliced-saturation'), `必须带当时阶段：${latency}`);
		assert.ok(!lines.some(l => l.includes('主线程阻塞')),
			'每片都短于阻塞阈值 ⇒ 不该报「连续阻塞」——两种形态要能区分，否则无法判断该优化哪一类');
	});
});

suite('切换卡住诊断 — 接线不变量', () => {

	const SIDE = 'src/vs/sessions/browser/parts/sidebarPart.ts';
	const LAYOUT = 'src/vs/sessions/services/configuration/browser/agentLayoutWorkspaceService.ts';
	const PERSIST = 'src/vs/sessions/contrib/agentStudio/browser/codebaseGraphPersistence.ts';
	const BOOTSTRAP = 'src/vs/sessions/contrib/agentStudio/browser/codebaseGraphBootstrap.ts';
	const SERVICE = 'src/vs/sessions/contrib/agentStudio/browser/codebaseGraphService.ts';
	const MEMORY = 'src/vs/sessions/contrib/agentStudio/browser/codebaseMemoryMcpService.ts';
	const PROMPTS = 'src/vs/sessions/contrib/chat/browser/promptsService.ts';
	const DIAG_CONTRIB = 'src/vs/sessions/contrib/agentStudio/browser/wsSwitchDiag.contribution.ts';
	const MAIN = 'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts';

	test('★★★ 切换入口（`_enterWorkspaceFile`）必须逐步打阶段 + 记耗时', () => {
		wired(SIDE, "wsStage('switch: configurationService.initialize（原地换工作区）')",
			'本链上最重的一步（整套重算配置模型 + fire folder 变更）必须有阶段标记');
		wired(SIDE, 'initializeWorkspaceInPlace 完成（',
			'日志没有时间戳 ⇒ 这一步的耗时必须自己算，否则无法判断「卡的是不是它」');
	});

	test('★★★ 配置模型重算必须有阶段 + 耗时（每次切换都会走，头号嫌疑）', () => {
		wired(LAYOUT, "wsStage('config: WorkspaceService.initialize", '阶段标记');
		wired(LAYOUT, 'configurationService.initialize 完成（', '耗时（覆盖 super.initialize）');
	});

	test('★★★ 图谱加载必须**分阶段**报耗时：解压 / 解析 / 路径迁移 / 校验 / 写入', () => {
		wired(PERSIST, '[loadMerge] 阶段耗时（',
			'汇总行 —— 旧日志只有调用方的总数（`merged … (5432ms)`），无法判断该优化哪一段');
		for (const phase of ["'解压制品'", "'解析 JSON'", "'路径迁移'", "'完整性校验'", "'写入内存 store'"]) {
			wired(PERSIST, `timed(${phase}`, `分段计时：${phase}`);
		}
	});

	test('★★ 图谱 bootstrap / prune / BM25 都要有阶段标记或耗时（阻塞期日志写不出去）', () => {
		wired(BOOTSTRAP, 'graph: bootstrap（', 'bootstrap 阶段标记');
		wired(BOOTSTRAP, 'folder 变化回调（图谱 bootstrap', 'folder 变化回路的同步段（在 fire 里跑）');
		wired(BOOTSTRAP, 'loadGraphMerge("${project}") 返回 ${loaded}，耗时', '每个 folder 的加载耗时（多 folder 时要知道是哪个慢）');
		wired(BOOTSTRAP, 'bootstrap 完成（本轮共', '本轮总耗时');
		wired(SERVICE, 'graph: prune 外来项目', 'prune 阶段（实测一次丢 176836 个节点）');
		wired(SERVICE, '[prune] 完成（', 'prune 总耗时（含「什么都没丢」的快路径，否则无法排除它）');
		wired(SERVICE, 'graph: 重建 BM25（', 'BM25 阶段标记');
		wired(SERVICE, 'BM25 重建完成（', 'BM25 耗时');
	});

	test('★★ 切换链上另外两个 handler 也要能自证快慢（用户日志末段正是它们）', () => {
		wired(MEMORY, "'codebaseMemory: 重读 .code-workspace 配置'",
			'CodebaseMemory 配置重读（阶段 + 耗时，经 wsStepAsync）');
		wired(PROMPTS, 'super 耗时 ', '`listPromptFiles` 是用户日志的最后一行 ⇒ 必须能回答「是它慢还是之后别人慢」');
		wired(PROMPTS, 'prompts: 扫描 prompt 文件', '阶段标记');
	});

	test('★★★ 看门狗必须自注册且相位足够早（否则「没有阻塞日志」无法与「探针没跑」区分）', () => {
		wired(DIAG_CONTRIB, 'workbench.contrib.wsSwitchDiag', '贡献 id');
		wired(DIAG_CONTRIB, 'WorkbenchPhase.BlockStartup',
			'相位必须早于任何一次切换（否则第一次切换的阻塞无从记录）');
		wired(MAIN, "import './wsSwitchDiag.contribution.js'",
			'自注册贡献必须被主入口 import，否则整条诊断链根本没加载');
	});

	test('★ 诊断阈值必须与注释里的口径一致（心跳 200ms / 阻塞 2s / 延迟 300ms、窗口 5s）', () => {
		assert.strictEqual(WS_HEARTBEAT_MS, 200);
		assert.strictEqual(WS_BLOCK_REPORT_MS, 2000);
		assert.strictEqual(WS_LATENCY_WARN_MS, 300);
		assert.strictEqual(WS_LATENCY_WINDOW_MS, 5000);
	});

	test('★★★ 阶段名必须能跨模块边界送到焦点埋点（真机连续出现「未注册阶段提供者」✗）', () => {
		// 背景：焦点埋点在 `sessions/browser/`，阶段名在 `sessions/contrib/`（反向 import 不允许 ✗）
		// ⇒ 靠"注入"传值。教训：注入写在**贡献文件**里被并行会话回退过多次 ✗（该目录今日被覆盖 3+ 次），
		// 而 `startMainThreadWatchdog()` **一定**会被调用（日志里的「交互延迟」行就是它打的 ✓）
		// ⇒ 主路径改为在**看门狗内部**直接发布 `globalThis.__SAROSIS_WS_STAGE__` ✓（跨模块实例共享 ✓）。
		// ⚠ 刻意**只断言 `wsSwitchDiag.ts`**（稳定 ✓），**不断言** contribution 文件里的那份双保险 ✗
		//   —— 它随时可能被别的会话整体回退，断言它只会让测试常年红 ✗✓
		const WATCHDOG_REL = 'src/vs/sessions/contrib/agentStudio/browser/wsSwitchDiag.ts';
		const FOCUS_TRACE_REL = 'src/vs/sessions/browser/agentChat/focusTrace.ts';
		wired(WATCHDOG_REL, '__SAROSIS_WS_STAGE__', '看门狗必须把"当前阶段名"发布到 globalThis（否则焦点埋点读不到 ⇒ 又白测一轮 ✗）');
		wired(WATCHDOG_REL, 'wsStageAge()', '发布内容要带"已持续 Ns"（区分"刚进入阶段"与"阶段里卡久了" ✓）');
		// 消费端必须**优先**读全局钩子 ✓（模块级注册在"同一模块被加载成两个实例"时会静默失效 ✗）
		wired(FOCUS_TRACE_REL, '__SAROSIS_WS_STAGE__', '焦点埋点必须优先读全局钩子，否则又会写「未注册阶段提供者」✗');
	});
});
