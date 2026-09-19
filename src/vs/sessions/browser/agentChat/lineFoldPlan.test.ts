/*---------------------------------------------------------------------------------------------
 *  lineFoldPlan.test.ts — 「逐行输出折叠」判据单测 + **接线断言**
 *
 *  钉住的回归（2026-09-19「页面 10.6 万节点」取证 ✓）：
 *   · 终端输出卡**每行 3 个节点**且**原先无上限** ✗（真机单条 264~422 行 ⇒ 单卡上千节点 ✓）；
 *   · 这些卡**执行完默认折叠** ✓，却仍把行全建进 DOM ✗✗ —— 本轮的核心修复就是"折叠态不建行" ✓。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/browser/agentChat/lineFoldPlan.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	LINE_FOLD_LIMITS,
	planLineFold,
	planNextChunk,
} from './lineFoldPlan.js';

suite('逐行输出折叠计划（DOM 预算回归）', () => {

	test('★★ 短输出（≤ head+tail）⇒ **不折叠**（绝大多数命令/ diff 无感 ✓）', () => {
		const limit = LINE_FOLD_LIMITS.head + LINE_FOLD_LIMITS.tail;
		const p = planLineFold(limit);
		assert.strictEqual(p.folded, false, '刚好到阈值不该折叠');
		assert.strictEqual(p.headEnd, limit);
		assert.strictEqual(p.tailStart, limit, '未折叠 ⇒ 头尾相接 ⇒ 全渲染 ✓');
		assert.strictEqual(p.hiddenCount, 0);
	});

	test('★★★ 超一行即折叠：首尾各保留，中间进"折叠区" ✓', () => {
		const limit = LINE_FOLD_LIMITS.head + LINE_FOLD_LIMITS.tail;
		const p = planLineFold(limit + 1);
		assert.strictEqual(p.folded, true);
		assert.strictEqual(p.headEnd, LINE_FOLD_LIMITS.head);
		assert.strictEqual(p.tailStart, limit + 1 - LINE_FOLD_LIMITS.tail);
		assert.strictEqual(p.hiddenCount, 1, '只隐藏中间那 1 行 ✓');
	});

	test('★★★ 真机量级（1000 行）⇒ 渲染量被钉在 head+tail ✓', () => {
		const p = planLineFold(1000);
		assert.strictEqual(p.headEnd, LINE_FOLD_LIMITS.head);
		assert.strictEqual(p.tailStart, 1000 - LINE_FOLD_LIMITS.tail);
		assert.strictEqual(p.hiddenCount, 1000 - LINE_FOLD_LIMITS.head - LINE_FOLD_LIMITS.tail);
		// 节点数对照：原 1000 行 ≈ 3000 节点 ✗ ⇒ 现在 (120+40) 行 ≈ 480 节点 ✓
		assert.ok(p.headEnd + (1000 - p.tailStart) === LINE_FOLD_LIMITS.head + LINE_FOLD_LIMITS.tail);
	});

	test('★ 阈值可注入（便于按场景调参 ✓）', () => {
		const p = planLineFold(10, { head: 3, tail: 2 });
		assert.strictEqual(p.folded, true);
		assert.strictEqual(p.headEnd, 3);
		assert.strictEqual(p.tailStart, 8);
		assert.strictEqual(p.hiddenCount, 5);
	});

	test('★ 脏输入安全（负数 / NaN / 小数 ⇒ 归一化，不抛错 ✗）', () => {
		assert.deepStrictEqual(planLineFold(-5), { folded: false, headEnd: 0, tailStart: 0, hiddenCount: 0 });
		assert.deepStrictEqual(planLineFold(NaN), { folded: false, headEnd: 0, tailStart: 0, hiddenCount: 0 });
		assert.strictEqual(planLineFold(200.9).headEnd, LINE_FOLD_LIMITS.head, '小数按截断处理 ✓');
		// head/tail 传 0 ⇒ 全部折叠（合法但极端；只要求不炸 ✓）
		assert.deepStrictEqual(planLineFold(5, { head: 0, tail: 0 }),
			{ folded: true, headEnd: 0, tailStart: 5, hiddenCount: 5 });
	});

	test('★★★ 逐批展开：每次只加 chunk 行（DOM 只随用户点击增长 ✓）', () => {
		const first = planNextChunk(120, 960);
		assert.strictEqual(first.start, 120);
		assert.strictEqual(first.end, 120 + LINE_FOLD_LIMITS.chunk);
		assert.strictEqual(first.remaining, 960 - first.end);
		// 再点一次 ⇒ 继续往后 ✓
		const second = planNextChunk(first.end, 960);
		assert.strictEqual(second.start, first.end);
		assert.strictEqual(second.remaining, 960 - second.end);
	});

	test('★★ 末批封顶到 `to`（不许越界 ⇒ 不重复渲染尾部 ✓）', () => {
		const c = planNextChunk(900, 960);
		assert.strictEqual(c.end, 960);
		assert.strictEqual(c.remaining, 0, 'remaining=0 ⇒ 调用方撤掉"展开"入口 ✓');
	});

	test('★ 脏输入安全（from>to / chunk≤0 / 小数 ✓）', () => {
		const c = planNextChunk(100, 50);
		assert.ok(c.end <= 100, 'from>to 不得越界 ✓');
		assert.strictEqual(planNextChunk(0, 10, 0).end, 1, 'chunk≤0 ⇒ 至少 1 行，避免死循环 ✗');
		assert.strictEqual(planNextChunk(0.9, 10.9, 2.9).start, 0);
	});
});

// ─── 接线断言：纯函数正确 ≠ 生效 ✗（本仓今日已两次栽在"写了没接线/被回退"✓）──────

suite('折叠与懒渲染必须真的接上（源码级断言）', () => {

	const REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.fileCards.ts';
	const readSrc = (): string => {
		const abs = path.join(process.cwd(), REL);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};

	test('★★★ 终端输出必须走「首尾保留 + 逐批展开」（不得再逐行无限建 DOM ✗）', () => {
		const src = readSrc();
		assert.ok(src.includes('renderFoldedOutputLines(output, stdoutLines'),
			'终端 stdout 必须走折叠渲染（否则每行 3 节点的老问题回来 ✗）');
		assert.ok(src.includes("from './lineFoldPlan.js'"),
			'必须复用折叠计划模块（阈值/策略单点定义 ✓）');
		assert.ok(src.includes('renderFoldedOutputLines(output, stderrLines'),
			'stderr 同样要折叠（它也是逐行 ✓）');
		// 折叠计划模块本身必须导出这两个能力（逐批展开依赖它 ✓）
		const planPath = path.join(process.cwd(), 'src/vs/sessions/browser/agentChat/lineFoldPlan.ts');
		const planSrc = fs.readFileSync(planPath, 'utf8');
		assert.ok(planSrc.includes('export function planLineFold') && planSrc.includes('export function planNextChunk'),
			'折叠计划必须导出 planLineFold / planNextChunk ✓');
	});

	test('★★★ 折叠态**不得**提前建正文（"折叠着也吃上千节点"就是本 bug ✗）', () => {
		const src = readSrc();
		assert.ok(src.includes('renderBodyOnce'),
			'必须存在"延后建正文"的钩子（折叠态零行 ✓；首次展开才建 ✓）');
		// 两处钩子：写文件 diff 卡 + 终端卡（各一个 `let renderBodyOnce` ✓）
		const decls = src.split('let renderBodyOnce').length - 1;
		assert.ok(decls >= 2, `写文件卡与终端卡都该有延后钩子（实际 ${decls} 处 ✗）`);
	});
});
