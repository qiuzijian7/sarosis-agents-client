/*---------------------------------------------------------------------------------------------
 *  domBudgetDecision.test.ts — 「DOM 预算裁剪」判据单测
 *
 *  钉住的回归（2026-09-19 app 卡死）：
 *   · 旧判据只看**条数** ⇒ 117 条消息 / 12.1 万节点时**恒不裁剪** ⇒ 撞 12 万死亡区后硬冻结 ✗；
 *   · 新判据必须在**节点超预算**时就裁，且用更小的保留窗口（先保命）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/browser/agentChat/domBudgetDecision.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	decideDomTrim,
	describeDensityOverBudget,
	DOM_TRIM_LIMITS,
	withProtectedRange,
	type DomTrimLimits,
} from './domBudgetDecision.js';

suite('DOM 预算裁剪判据（app 卡死回归）', () => {

	/** 与 AgentChatService 的看门狗阈值对齐（那边只是告警，本模块负责动作）。 */
	const DOM_WARN_NODES = 60_000;
	const DOM_ERROR_NODES = 120_000;

	test('★ 回归：条数未超上限但节点超预算 ⇒ 必须裁剪（旧判据在此恒不裁）', () => {
		// 真机：messages=117（< 120 上限）、dom nodes=121166（> 死亡线 120k）
		const d = decideDomTrim(117, 121_166);
		assert.strictEqual(d.shouldTrim, true, '节点超预算必须裁 —— 这正是冻结当刻的真机形态');
		assert.strictEqual(d.reason, 'node-budget');
		assert.strictEqual(d.keepBuffer, DOM_TRIM_LIMITS.nodeKeep);
	});

	test('预算触发用更激进的保留窗口（nodeKeep < messageKeep）', () => {
		assert.ok(DOM_TRIM_LIMITS.nodeKeep < DOM_TRIM_LIMITS.messageKeep,
			'预算触发是「卡死前兆」，保留窗口必须比常规更小');
		assert.strictEqual(decideDomTrim(50, DOM_TRIM_LIMITS.nodeBudget + 1).keepBuffer, DOM_TRIM_LIMITS.nodeKeep);
		assert.strictEqual(decideDomTrim(DOM_TRIM_LIMITS.messageLimit + 1, 1000).keepBuffer, DOM_TRIM_LIMITS.messageKeep);
	});

	test('预算阈值必须早于看门狗告警线（否则等不到动作）', () => {
		assert.ok(DOM_TRIM_LIMITS.nodeBudget < DOM_WARN_NODES,
			`动作阈值(${DOM_TRIM_LIMITS.nodeBudget}) 必须早于告警线(${DOM_WARN_NODES})`);
		assert.ok(DOM_TRIM_LIMITS.nodeBudget < DOM_ERROR_NODES);
	});

	test('条数触发（长会话常规路径）仍按 messageKeep', () => {
		const d = decideDomTrim(DOM_TRIM_LIMITS.messageLimit + 1, 5_000);
		assert.strictEqual(d.shouldTrim, true);
		assert.strictEqual(d.reason, 'message-count');
	});

	test('两者都正常 ⇒ 不裁剪', () => {
		const d = decideDomTrim(30, 8_000);
		assert.strictEqual(d.shouldTrim, false);
		assert.strictEqual(d.reason, 'under-limits');
	});

	test('只有 1 条消息且超预算 ⇒ 不裁（无可卸载，交给密度诊断）', () => {
		const d = decideDomTrim(1, DOM_TRIM_LIMITS.nodeBudget + 1);
		assert.strictEqual(d.shouldTrim, false, '单条消息时裁剪无意义（全在可视窗口）');
	});

	test('边界：恰好等于预算/上限 ⇒ 不动手（严格大于才触发）', () => {
		assert.strictEqual(decideDomTrim(DOM_TRIM_LIMITS.messageLimit, DOM_TRIM_LIMITS.nodeBudget).shouldTrim, false);
		assert.strictEqual(decideDomTrim(DOM_TRIM_LIMITS.messageLimit + 1, DOM_TRIM_LIMITS.nodeBudget).shouldTrim, true);
	});

	test('密度诊断：裁剪后仍超预算 ⇒ 明确指向「单条密度」而非条数', () => {
		const note = describeDensityOverBudget(121_166, 117);
		assert.ok(note, '超预算必须有可见说明（否则后人不知道裁剪为何没救回来）');
		assert.ok(note!.includes('121166'), '应带真实节点数便于比对日志');
		assert.ok(note!.includes(String(Math.round(121_166 / 117))), '应给出 ≈节点/条（121166/117 ≈ 1036）');
		assert.ok(note!.includes('折叠'), '应指明下一步方向（大代码块折叠/懒高亮）');
	});

	test('密度诊断：降下来后不再打扰', () => {
		assert.strictEqual(describeDensityOverBudget(DOM_TRIM_LIMITS.nodeBudget, 20), null);
		assert.strictEqual(describeDensityOverBudget(0, 0), null);
	});

	test('阈值可注入（便于后续按机器/场景调参）', () => {
		const custom: DomTrimLimits = { messageLimit: 10, messageKeep: 4, nodeBudget: 100, nodeKeep: 2 };
		assert.strictEqual(decideDomTrim(11, 50, custom).reason, 'message-count');
		assert.strictEqual(decideDomTrim(11, 101, custom).reason, 'node-budget');
		assert.strictEqual(decideDomTrim(9, 101, custom).keepBuffer, 2);
	});
});

// ─── ★★★ 尾部保护：修「LLM 长执行中气泡 UI 突然消失」（2026-09-19 用户报告）──────────

/**
 * 背景（用户报「LLM 长时间执行，突然 llm 的冒泡 UI 消失了」+ 真机日志 ✓）：
 * 裁剪的保留窗口 = **视口 ± 缓冲** ✓ —— 但长执行期间用户会**滚上去看历史**，
 * 或**搜索跳到旧消息**（真机日志里 `agentChatPanel.dropdowns.ts:1155` 正是"跳转完成后
 * 立刻裁剪" ✓）⇒ 此时窗口只覆盖**视口中段** ⇒ **尾部整条被 `el.remove()`** ✗✗
 * ⇒ 正在执行/刚输出的那条 assistant 气泡从 DOM 消失 ✓（数据 `_messages` 没丢 ✓，
 *   但不重渲染就回不来 ⇒ 用户看到的就是"气泡突然没了" ✓）。
 *
 * 本 suite 钉住 `withProtectedRange` 的**方向性**：只扩大 ✓、绝不缩小 ✓、脏输入安全 ✓。
 */
suite('DOM 裁剪：保护"不得卸载"的尾部（气泡消失回归）', () => {

	test('★★★ 视口停在中间 ⇒ 必须把尾部并入窗口（否则正在执行的气泡被卸载 ✗）', () => {
		// 50 条已渲染、用户停在中段（窗口 12..28）⇒ 尾部 49 必须并进来 ✓
		const w = withProtectedRange(12, 28, 50, [49]);
		assert.strictEqual(w.keepFrom, 12, '起点不该被改动（保护的是尾部 ✓）');
		assert.strictEqual(w.keepTo, 49, '终点必须扩到尾部 ⇒ 正在执行的气泡留在 DOM ✓');
	});

	test('★★★ 保护点在头部（跳历史后目标在上方）⇒ 反向扩大 ✓', () => {
		const w = withProtectedRange(40, 49, 50, [3]);
		assert.strictEqual(w.keepFrom, 3);
		assert.strictEqual(w.keepTo, 49);
	});

	test('★★ 保护点已在窗口内 ⇒ 窗口原样（绝不因保护而缩小 ✓）', () => {
		const w = withProtectedRange(10, 20, 30, [15, 20]);
		assert.deepStrictEqual(w, { keepFrom: 10, keepTo: 20 });
	});

	test('★★ 多个保护点 ⇒ 取并集（尾部那条 + 最后一条 assistant ✓）', () => {
		const w = withProtectedRange(30, 35, 60, [58, 45]);
		assert.deepStrictEqual(w, { keepFrom: 30, keepTo: 58 });
	});

	test('★ 脏输入安全（负数 / 越界 / 非整数 ⇒ 忽略，不把窗口搞坏 ✗）', () => {
		const w = withProtectedRange(5, 8, 10, [-1, 10, 99, 3.5, NaN]);
		assert.deepStrictEqual(w, { keepFrom: 5, keepTo: 8 });
	});

	test('★ 无已渲染消息（count=0）⇒ 原样返回（不越权改动 ✓）', () => {
		assert.deepStrictEqual(withProtectedRange(0, 0, 0, [0]), { keepFrom: 0, keepTo: 0 });
	});

	test('★ 调用方把区间传反也安全（内部归一化 ✓）', () => {
		assert.deepStrictEqual(withProtectedRange(7, 3, 10, []), { keepFrom: 3, keepTo: 7 });
	});

	test('★★★ 接线不可丢：`_trimDistantMessages` 必须真的并入保护（源码级断言 ✓）', () => {
		// 纯函数正确 ≠ 生效 ✗ —— 保护必须**被调用**才有意义（2026-09-19 的教训：
		// 同一天里已有两次"代码写对了但没接线/被回退"✓）⇒ 这里钉住调用点 ✓。
		const rel = 'src/vs/sessions/browser/agentChat/agentChatPanel.base.ts';
		const abs = path.join(process.cwd(), rel);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		const src = fs.readFileSync(abs, 'utf8');
		assert.ok(src.includes('withProtectedRange(rawFrom, rawTo, els.length, protectIdx)'),
			'裁剪必须把视口窗口与"保护尾部"合并（否则正在执行的气泡又会被卸载 ✗）');
		assert.ok(src.includes('_protectedTailIndexes(els)'),
			'保护下标必须来自 `_protectedTailIndexes`（尾部那条 + 最后一条 assistant ✓）');
	});
});
