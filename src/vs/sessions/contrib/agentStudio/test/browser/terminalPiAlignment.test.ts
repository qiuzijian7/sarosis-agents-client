/*---------------------------------------------------------------------------------------------
 * Copyright (c) Sarosis. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * terminal/execute_code 与 pi（bash 工具）对齐回归测试（2026-09-21）。
 *
 * ## 本轮四件事（每件都对应一个真机可复现的缺口）
 *
 * 1. **P0-① 超时 marker 在 poll 路径丢失**（`app.ts`）——
 *    marker 原先只拼进「传给 `onDone` 的结果对象」，而后台任务没有 `onDone`
 *    （`if (payload?.background)` 分支不传回调），渲染侧 execute_code 的"直播"模式
 *    恰恰全程走后台任务 + poll ⇒ marker 被丢弃 ⇒ `parseTimeoutSecondsFromStderr` 判不出超时
 *    ⇒ 走泛化失败分支（真机实证 `stderr=0c` + `execute_code failed (exit -1)`），
 *    专为长任务写的 `timeoutGuidanceMessage`（background / 更大 timeout 两条出路）**永远打不出来**。
 *
 * 2. **P0-② terminal 中段输出不可找回** —— 旧实现 head+tail 64KB，中段直接丢弃、
 *    不落盘、不给总量 ⇒ 模型只能重跑命令。pi 的对照做法是「保留 + 全量落临时文件 +
 *    `[Showing lines x-y of total. Full output: <path>]`」。
 *
 * 3. **P0-③ 60s 静默硬顶** —— `min(timeoutSec*1000, 60_000)` 让任何 >60 的 timeout 失效
 *    （schema 只写 default:30），pi 则默认无超时、只在调用方要求时计时。
 *
 * 4. **P1-④⑤ 每次 3s 空等 + none 档无退出码静默** —— Git Bash 从不被注入 shell integration，
 *    探测却每次等满 3s；none 档拿不到退出码时也不告知（模型按"有输出=成功"理解，曾误判 `no-such-file`）。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/terminalPiAlignment.test.ts
 */
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	truncateTerminalOutput,
	spilledOutputFooter,
	unavailableExitCodeNote,
} from '../../browser/providers/tool/terminalOutputDiagnosis.js';

suite('terminal ↔ pi 对齐（2026-09-21）', () => {

	const readSrc = (rel: string): string => {
		const abs = path.join(process.cwd(), rel);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};
	/** 剥注释（本仓教训：注释里会刻意引用旧写法/旧日志作取证，连注释查会假红 ✓）。 */
	const code = (rel: string): string => readSrc(rel)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');

	const CORE = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/coreTools.ts';
	const APP = 'src/vs/code/electron-main/app.ts';

	// ─── P0-①：超时 marker 必须同时进 collector（poll 唯一可见通道）───────
	test('★★★ app.ts：超时 marker 必须双写 stderrCollector，否则 poll 永远看不到超时', () => {
		const src = code(APP);
		const markerPushIdx = src.indexOf('stderrCollector.push(Buffer.from(marker');
		assert.ok(markerPushIdx !== -1,
			'marker 必须 push 进 stderrCollector —— 后台任务没有 onDone，只拼进结果对象等于丢弃 ✗');
		// 同一分支里仍要拼进结果对象（前台路径语义不变 ✓）
		const branchEnd = src.indexOf('}, timeoutMs) : undefined;', markerPushIdx);
		assert.ok(branchEnd !== -1, '找不到 timeout 分支结尾（结构变了？）');
		const branch = src.slice(markerPushIdx, branchEnd);
		assert.ok(branch.includes('stderr: partialErr + marker'),
			'结果对象里也要带 marker（前台 await 路径靠它）✗');
		assert.ok(branch.includes('stderrCollector.push'),
			'poll 路径靠 collector —— 这是本轮修复的核心 ✗');
		// poll 响应必须取自 collector（否则推了也没人读）
		const pollIdx = src.indexOf('return { success: !handle.settled, stdout:');
		assert.ok(pollIdx !== -1, '找不到 poll 分支 ✗');
		assert.ok(src.slice(pollIdx, pollIdx + 260).includes('stderrCollector.decode('),
			'poll 必须回 stderrCollector.decode(...) 的内容（marker 的可见通道）✗');
	});

	test('★★★ app.ts：marker 文案保持唯一解析契约（win32 走 tree / 其他走 process）', () => {
		const src = code(APP);
		assert.ok(src.includes('[timeout: process tree killed after'), 'win32 的 tree 文案不能被改（parseTimeoutSecondsFromStderr 依赖）✗');
		assert.ok(src.includes('[timeout: process killed after'), '非 win32 文案不能被改 ✗');
	});

	// ─── P0-②：截断必须保留头尾并给出「丢了多少」──────────────────────
	test('★★ 截断保留头尾 + omittedChars 精确等于实际丢弃量', () => {
		const body = 'HEAD' + 'x'.repeat(200) + 'TAIL';
		const r = truncateTerminalOutput(body, 64);
		assert.strictEqual(r.truncated, true);
		assert.ok(r.text.startsWith('HEAD'), '头部必须保留（前导结论常在头）✗');
		assert.ok(r.text.endsWith('TAIL'), '尾部必须保留（错误与结论在尾）✗');
		assert.ok(r.text.includes(`(${r.omittedChars} chars omitted from the middle)`),
			'省略标记里的数字必须与实际丢弃量一致（否则是假信息 ✗）');
		// 头尾保留 half*2，故丢弃量 = 总长 - 保留的整数长度
		const half = Math.floor(64 / 2);
		assert.strictEqual(r.omittedChars, body.length - half * 2);
	});

	test('★ 未超限时**不截断**（不引入省略标记与省略文案）', () => {
		const r = truncateTerminalOutput('short output', 65536);
		assert.strictEqual(r.truncated, false);
		assert.strictEqual(r.text, 'short output');
		assert.strictEqual(r.omittedChars, 0);
	});

	test('★★★ 落盘 footer 必须给出路径 + 总量 + 检索方式，并劝阻重跑', () => {
		const f = spilledOutputFooter('C:\\Users\\u\\.vssaros\\tmp\\exec-1.log', 123456);
		assert.ok(f.includes('C:\\Users\\u\\.vssaros\\tmp\\exec-1.log'), '必须给出可 file_read 的绝对路径 ✗');
		assert.ok(f.includes('123456'), '必须给出总量（模型据此判断值不值得读）✗');
		assert.ok(/file_read/.test(f) && /search_code/.test(f), '必须给出可执行的取回方式 ✗');
		assert.ok(/Nothing was lost/i.test(f), '必须明确「没丢」（否则模型会重跑命令）✗');
		assert.ok(/instead of re-running/i.test(f), '必须劝阻重跑 ✗');
	});

	// ─── P0-③：60s 硬顶必须消失，超时文案必须可执行 ───────────────────
	test('★★★ coreTools：不得再有 60s 静默硬顶（timeout 参数必须真的生效）', () => {
		const src = code(CORE);
		assert.ok(!src.includes('hardCapMs'), '`hardCapMs`（60s 硬顶）必须整体移除 —— 它让 >60 的 timeout 静默失效 ✗');
		assert.ok(src.includes('const timeoutMs = timeoutSec * 1000;'),
			'timeoutMs 必须直接由 timeoutSec 得出（上限由 handler clamp 到 300 把关）✗');
	});

	test('★★★ 超时文案必须点破「未证明完成」并给出两条出路', () => {
		const src = code(CORE);
		const idx = src.indexOf('const timeoutPromise = new Promise<string>');
		assert.ok(idx !== -1, '找不到 timeoutPromise ✗');
		const block = src.slice(idx, idx + 1400);
		assert.ok(/NOT proven to have finished/.test(block), '必须点破「命令没有被证明跑完」（否则模型当成失败重发）✗');
		assert.ok(/execute_code/.test(block) && /background:true/.test(block),
			'必须给出长任务出路：execute_code background + poll ✗');
		assert.ok(/max 300/.test(block), '必须说明 timeout 上限（P0-③ 去硬顶后的可行动作）✗');
		assert.ok(/Do NOT re-send/.test(block), '必须劝阻原样重发（必然再超时）✗');
	});

	// ─── P0-②：terminal 落盘接线（只截断时才落盘，失败不阻断）──────────
	test('★★★ coreTools：截断时落盘，落盘失败不改变结果（never-worse）', () => {
		const src = code(CORE);
		assert.ok(src.includes('const maxLen = SPILL_THRESHOLD_BYTES;'),
			'阈值必须与 execute_code 落盘共用同一常量（防两处漂移）✗');
		assert.ok(src.includes('const trunc = truncateTerminalOutput(sanitizedOutput, maxLen);'),
			'必须走纯函数截断 ✗');
		assert.ok(src.includes('if (trunc.truncated) {'), '只在实际截断时才落盘（不为小输出制造文件）✗');
		assert.ok(src.includes('const footer = await spillTerminalOutput(command, sanitizedOutput);'),
			'截断时必须尝试落盘全量输出 ✗');
		// 落盘失败 ⇒ footer 为 undefined ⇒ 保持内联截断
		assert.ok(src.includes('if (footer) { finalOutput = `${finalOutput}\\n\\n${footer}`; }'),
			'footer 仅在落盘成功时追加（失败退化为纯截断，绝不把成功命令变错误）✗');
	});

	test('★★ 落盘目标必须与 execute_code 同约定（沙箱允许根内、可回收、IO 失败即退）', () => {
		const src = code(CORE);
		const idx = src.indexOf('async function spillTerminalOutput');
		assert.ok(idx !== -1, '找不到 spillTerminalOutput ✗');
		const body = src.slice(idx, idx + 2200);
		assert.ok(body.includes('SarosPath.tmp') && body.includes('resolveSarosPath(userDataRootFromPath('),
			'必须落到 ~/.vssaros/tmp（沙箱允许根内 ⇒ 模型 file_read 不触发越界卡片）✗');
		assert.ok(body.includes('selectSpillFilesToDelete('), '必须按数量/时长回收（否则无限堆积）✗');
		assert.ok(/catch/.test(body) && body.includes('return undefined;'),
			'任何 IO 失败都必须优雅退化为 undefined（落盘只是优化）✗');
	});

	// ─── P1-④：能力负结果缓存（只缓存负结果！）────────────────────────
	test('★★★ coreTools：能力探测负结果缓存 —— 且**只**缓存负结果', () => {
		const src = code(CORE);
		assert.ok(src.includes('_capabilityProbeNegativeCache'),
			'必须有负结果缓存（Git Bash 每次白等 3s）✗');
		assert.ok(src.includes('_capabilityProbeNegativeCache.set(profileKey, Date.now() + PROBE_NEGATIVE_TTL_MS);'),
			'负结果必须带 TTL 写入 ✗');
		// 关键：正结果不得缓存 —— 否则跳过探测 ⇒ 拿不到 commandDetection ⇒ 静默退化成 idle 猜判定
		const setCount = (src.match(/_capabilityProbeNegativeCache\.set\(/g) ?? []).length;
		assert.strictEqual(setCount, 1, '负缓存只能有**一处**写入点（缓存正结果会静默丢掉真实 exit code ✗）');
		const guardIdx = src.lastIndexOf('if (!probeSkipped && !commandDetection', src.indexOf('_capabilityProbeNegativeCache.set('));
		assert.ok(guardIdx !== -1 && src.slice(guardIdx, guardIdx + 200).includes('COMMAND_DETECTION_WAIT_MS - 100'),
			'只有「等满了探测窗口」才可缓存 —— 瞬时缺失可能只是启动慢，不能当成「永不注入」✗');
	});

	// ─── P1-⑤：none 档拿不到退出码必须显式声明（且触发面要收窄）────────
	test('★★★ coreTools：none 档无退出码时必须附说明（防「有输出 = 成功」误读）', () => {
		const src = code(CORE);
		assert.ok(src.includes("if (strategy === 'none' && parsedExit === undefined"),
			'必须按「none 档 + 无退出码」双条件触发 ✗');
		assert.ok(src.includes('hintedOutput = `${hintedOutput}\\n\\n${unavailableExitCodeNote()}`;'),
			'必须把说明追加到结果里（pi 走 spawn 恒有退出码；PTY 路线做不到，但不能静默）✗');
		const note = unavailableExitCodeNote();
		assert.ok(/could not be observed/i.test(note), '必须明确「退出码不可观测」✗');
		assert.ok(/do NOT read this as success or failure/i.test(note), '不得让模型按成败任一侧理解 ✗');
		assert.ok(/execute_code/.test(note), '必须给出出路（结果导向命令走 execute_code）✗');
	});

	test('★★ 触发面必须收窄：可疑提示 或 结果导向命令 —— 否则每次调用都加税', () => {
		const src = code(CORE);
		const idx = src.indexOf("if (strategy === 'none' && parsedExit === undefined");
		assert.ok(idx !== -1, '找不到 none 档说明分支 ✗');
		const cond = src.slice(idx, idx + 260);
		assert.ok(cond.includes('suspicionRaised || isSlowStartCommand(command)'),
			'只在「已出现可疑/失败提示」或「结果导向命令（构建/测试/安装/lint）」时加说明 ✗' +
			'（`ls`/`git status` 的输出自解释，退出码缺失对决策无增量）');
		// 两个提示分支都必须置位该标志（漏一个 ⇒ 该分支下的 none 档不再点名）
		const setCount = (src.match(/suspicionRaised = true;/g) ?? []).length;
		assert.strictEqual(setCount, 2, 'failure / masked-success 两个提示分支都必须置位 suspicionRaised ✗');
	});

	// ─── 「转后台」（2026-09-21，用户需求：terminal 卡片加「转后台」+ 自动打开控制台 ✓）──────
	// 语义：与「跳过」**互补** —— 跳过 = 杀进程（不可逆 ✗）；转后台 = 进程留在真实终端
	// 继续跑（可逆 ✓）+ 控制台自动打开 ✓ + 当前轮立即放行 ✓。
	test('★★ 「转后台」链路：detach 信号带 reason + 实例不销毁 + 控制台自动打开 ✓', () => {
		const core = code(CORE);
		// ① abort 分支必须按 signal.reason 区分 detach 与 interrupt ✓
		assert.ok(/signal\.reason === 'detach'/.test(core), 'abort 分支必须读 signal.reason 区分 detach ✗');
		// ② detach 时必须置位标记 ✓
		assert.ok(/detachedToBackground = true/.test(core), 'detach 必须置位 detachedToBackground ✗');
		// ③ detach 收尾必须**自动打开控制台**（revealTerminal = 显示面板 + 置活动实例 ✓）
		assert.ok(/revealTerminal\(instance\)/.test(core), 'detach 必须 revealTerminal（自动打开控制台 ✓）✗');
		// ④ 回给模型的文案必须含 DETACHED 标记 ✓
		assert.ok(/\[DETACHED\]/.test(core), '必须返回 [DETACHED] 文案 ✗');

		const os = readSrc('src/vs/sessions/contrib/agentStudio/browser/agentOSService.ts');
		// ⑤ 服务层：detach 控制器 abort 必须带 reason（否则工具侧区分不了 ✗✓）
		assert.ok(/_toolDetachController\.abort\('detach'\)/.test(os), 'detachCurrentTool 必须 abort(\'detach\') ✗');
		// ⑥ 组合信号必须透传 detach 的 reason ✓
		assert.ok(/ctrl\.abort\('detach'\)/.test(os), '_composeParentSignal 必须透传 reason ✗');
	});

	test('★★ 转后台的实例**不得销毁**（dispose ⇒ pty kill ⇒ 进程被杀 ⇒ 转后台失去意义 ✗✗）', () => {
		const core = code(CORE);
		// detach 分支必须在 dispose 之前 return（实例保活 ✓✓）
		const detachIdx = core.indexOf('if (detachedToBackground) {');
		assert.ok(detachIdx !== -1, '找不到 detach 收尾分支 ✗');
		const disposeIdx = core.indexOf('instance.dispose()', detachIdx);
		assert.ok(disposeIdx !== -1, '找不到销毁段 ✗');
		const detachBody = core.slice(detachIdx, disposeIdx);
		assert.ok(/return text\(/.test(detachBody), 'detach 分支必须在销毁段**之前** return ✗✓');
	});

	test('★★ 卡片按钮只在 terminal 工具出现（execute_code 是 child_process，无终端可开 ✗）', () => {
		const cards = readSrc('src/vs/sessions/browser/agentChat/agentChatPanel.fileCards.ts');
		assert.ok(/key === 'terminal' && this\._onDetachCurrentTool/.test(cards),
			'「转后台」按钮必须 gate 在 key===\'terminal\' ✗（execute_code 有 background:true 参数 ✓）');
		assert.ok(/terminal-detach-btn/.test(cards), '按钮 class 缺失 ✗');
	});
});
