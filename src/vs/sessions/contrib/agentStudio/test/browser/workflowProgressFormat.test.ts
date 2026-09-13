/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 进度百分比格式化（2026-09-12 用户需求「生成的进度最多显示小数点后2位」）。
 *
 * 真实 bug 场景：ComfyUI 进度 = `value / max * 100`（如 5/11 → 45.45454545454546），
 * 直接插进 `` `生成中 ${prog}%` `` → 卡片上出现一长串小数 ✗。
 */
import assert from 'assert';
import { formatProgressPct } from '../../webview/src/features/workflowEditor/comfyHost/progressFormat.js';
import { formatProgressPct as formatProgressPctHost } from '../../common/progressFormat.js';

suite('formatProgressPct（进度百分比：最多 2 位小数）', () => {

	test('★★ 无限小数截到 2 位（用户反馈的实际值：5/11）', () => {
		assert.strictEqual(formatProgressPct(5 / 11 * 100), '45.45');
		assert.strictEqual(formatProgressPct(45.45454545454546), '45.45');
	});

	test('超过 2 位 → 四舍五入到 2 位', () => {
		assert.strictEqual(formatProgressPct(45.4567), '45.46');
		assert.strictEqual(formatProgressPct(1.0049), '1');
		// ★ 二进制浮点残差与 JS 原生同口径：1.005 实际存为 1.00499… → 不进位
		//   （`(1.005).toFixed(2) === '1.00'`）—— 这是 IEEE754 的既有行为，
		//   不是本函数的缺陷，故按同口径断言 ✓。
		assert.strictEqual(formatProgressPct(1.005), '1');
	});

	test('★ 不足 2 位不补零（避免「45.40%」这种噪音）', () => {
		assert.strictEqual(formatProgressPct(45.4), '45.4');
		assert.strictEqual(formatProgressPct(45), '45');
		assert.strictEqual(formatProgressPct(100), '100');
	});

	test('整数不出现小数点', () => {
		assert.strictEqual(formatProgressPct(0), '0');
		assert.strictEqual(formatProgressPct(40), '40');
	});

	test('★ 负数（本仓库的「不确定进度」哨兵 -1）→ 0，绝不显示 -1%', () => {
		assert.strictEqual(formatProgressPct(-1), '0');
		assert.strictEqual(formatProgressPct(-0.5), '0');
	});

	test('★ NaN / Infinity / 非数字 → 0（width:NaN% 会让进度条整条不渲染）', () => {
		assert.strictEqual(formatProgressPct(NaN), '0');
		assert.strictEqual(formatProgressPct(Infinity), '0');
		assert.strictEqual(formatProgressPct(-Infinity), '0');
		assert.strictEqual(formatProgressPct(undefined), '0');
		assert.strictEqual(formatProgressPct('abc'), '0');
	});

	test('极小值（浮点残差）不产生科学计数法', () => {
		assert.strictEqual(formatProgressPct(8.881784197001252e-16), '0');
		assert.ok(!formatProgressPct(0.004).includes('e'));
	});

	test('★ 拼接结果符合用户要求（最多 2 位小数）', () => {
		const msg = `生成中 ${formatProgressPct(4 + (92 / 9) * 4)}%`;
		assert.match(msg, /^生成中 \d+(\.\d{1,2})?%$/, `实际：${msg}`);
	});
});

/**
 * ★★ 跨 bundle 镜像实现的一致性（**防漂移**）。
 *
 * 宿主（`common/progressFormat.ts`，聊天卡）与 webview（`comfyHost/progressFormat.ts`，
 * 画布卡）是两个独立 bundle —— webview 的 tsconfig `rootDir: ./src` 不允许相对引用
 * `common/` ✗，只能各留一份实现。这条测试逐值比对，**改任何一边都会立刻失败** ✓。
 */
suite('formatProgressPct 镜像一致性（宿主 ↔ webview）', () => {

	const CASES: unknown[] = [
		0, 1, 45, 45.4, 45.45, 45.45454545454546, 45.4567, 99.999, 100, 100.4,
		5 / 11 * 100, 4 + (92 / 9) * 4, 4 + (92 / 11) * 5, 1 / 3 * 100,
		-1, -0.5, 0.004, NaN, Infinity, -Infinity, undefined, null, '', 'abc', '45.5',
	];

	test('★ 同一组输入 → 两边输出必须逐字相同', () => {
		for (const v of CASES) {
			assert.strictEqual(
				formatProgressPctHost(v),
				formatProgressPct(v),
				`输入 ${String(v)}：宿主='${formatProgressPctHost(v)}' webview='${formatProgressPct(v)}'`,
			);
		}
	});

	test('★ 两边输出都满足「最多 2 位小数」', () => {
		for (const v of CASES) {
			assert.match(formatProgressPctHost(v), /^\d+(\.\d{1,2})?$/, `宿主 ${String(v)}`);
			assert.match(formatProgressPct(v), /^\d+(\.\d{1,2})?$/, `webview ${String(v)}`);
		}
	});
});
