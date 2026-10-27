#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  check-workbench-ui-css.mjs — **共享层 CSS 模板串完整性**守卫（2026-10-27 事故后新增）
 *
 * ## 事故复盘（为什么必须有这条）
 * 给 `vssaros-workbenches/lib/client.ui.js` 的 `WORKBENCH_UI_CSS` **注释里**插了一个反引号
 * （写成了 `` `--wb-f-lg` `` 这种 Markdown 风格），而这份 CSS 是 **JS 模板字符串**：
 *   反引号 ⇒ 模板串**提前闭合** ⇒ `:root {` 再没闭合 ⇒ 后面 200 行规则全被吞进 `:root`
 *   ⇒ **7 个工作台布局全崩**（所有元素竖排、标题巨大）。
 *
 * 症状离根因太远（看到的是"布局错乱"，写错的是"CSS 注释里的一个符号"）⇒ 人眼几乎定位不到 ✗✗
 * 所以把它变成机器判据。
 *
 * ## 判据
 *  ① 串内**不得出现反引号**（注释里也不行 —— 那是本次事故的直接原因）
 *  ② `{` / `}` 必须平衡（不平衡 = 有规则把后面的全吞了）
 *  ③ 必要片段必须齐（`:root {` / `.wb-toolbar {` / `--wb-f-title` / `@container`）
 *  ④ 末尾必须是完整规则（不能停在半个块里）
 *
 * 用法：node dsh-plugins/check-workbench-ui-css.mjs   （退出码 0 = 通过）
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const UI = path.join(HERE, 'vssaros-workbenches', 'lib', 'client.ui.js');
const MARK = 'const WORKBENCH_UI_CSS = `';

const problems = [];

if (!fs.existsSync(UI)) {
	problems.push('共享层 client.ui.js 不存在：' + UI);
} else {
	const src = fs.readFileSync(UI, 'utf8');
	const at = src.indexOf(MARK);
	if (at < 0) {
		problems.push('找不到 `' + MARK + '` 模板串起点（变量被改名？）');
	} else {
		const from = at + MARK.length;
		const endAt = src.slice(from).indexOf('`;');
		if (endAt < 0) {
			problems.push('CSS 模板串没有正常闭合（找不到 `; ）');
		} else {
			const css = src.slice(from, from + endAt);

			/* ① 反引号（本次事故根因） */
			if (css.includes('`')) {
				const lines = css.split(/\r?\n/);
				lines.forEach((l, i) => {
					if (l.includes('`')) {
						problems.push('CSS 串内第 ' + (i + 1) + ' 行出现**反引号** ⇒ 模板串会提前截断 ⇒ 所有工作台布局崩：' + l.trim().slice(0, 90));
					}
				});
			}

			/* ② 花括号平衡 */
			const open = (css.match(/\{/g) || []).length;
			const close = (css.match(/\}/g) || []).length;
			if (open !== close) {
				problems.push('花括号不平衡（{ ' + open + ' vs } ' + close + '）⇒ 后面的规则会被吞进未闭合的块里 ✗');
			}

			/* ③ 必要片段 */
			for (const need of [':root {', '.wb-toolbar {', '--wb-f-title', '@container']) {
				if (!css.includes(need)) {
					problems.push('缺少必要片段 `' + need + '` ⇒ 串可能被截断或刻度被删');
				}
			}

			/* ④ 末尾完整 */
			const tail = css.trimEnd();
			if (!/}\s*$/.test(tail)) {
				problems.push('串末尾不是完整的规则（应以 `}` 结尾），实际末尾：' + JSON.stringify(tail.slice(-40)));
			}

			if (!problems.length) {
				console.log('✓ 共享层 CSS 模板串完整（' + css.length + ' 字符 / ' + css.split(/\r?\n/).length + ' 行，{ ' + open + ' } ' + close + '）');
			}
		}
	}
}

if (problems.length) {
	console.error('✗ 共享层 CSS 检查失败（' + problems.length + ' 项）：');
	for (const p of problems) { console.error('  · ' + p); }
	process.exit(1);
}
