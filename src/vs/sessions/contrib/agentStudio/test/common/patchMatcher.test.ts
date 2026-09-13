/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	detectLineEnding, normalizeLineEndings, convertToLineEnding,
	findClosestMatch, findAllOccurrences, computePatch, CLOSEST_MATCH_HINT_LIMIT,
	buildEditedRegionContext, PATCH_CONTEXT_LINES, computeInsert,
} from '../../common/patchMatcher.js';

/**
 * patch 工具行为契约（2026-08-21，日志 1787311348450 三个缺陷的回归防线）。
 *
 * 这些用例直接对应线上真实故障：
 *  · CRLF 文件 + LF search  → 旧实现必然 not_found（本仓源文件普遍 CRLF）
 *  · 未命中                 → 旧实现返回"成功"文本，模型拿不到纠错信号
 *  · replace_all 零命中     → 旧实现 split/join 静默把原文写回并报 Patched
 *  · 多处命中未开 all       → 旧实现静默只改第一处
 */
suite('patchMatcher', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * ★★ 2026-09-13：`patch` 的回显必须与 `file_read` **同等脱敏**。
	 *
	 * `patch` 有两条回显文件原文的路径：
	 *   1. **成功** —— 「Updated region」= 改动区 ± `PATCH_CONTEXT_LINES`(3) 行
	 *      （`buildEditedRegionContext`）；
	 *   2. **失败**（`not_found`）—— 回传「Closest match」**原文片段**，上限
	 *      `CLOSEST_MATCH_HINT_LIMIT`(2000) 字符。
	 *
	 * 而 `file_read` 对**同一批字节**是脱敏的 → 此前 `patch` 是一条绕过 `file_read`
	 * 的「读文件」通道。失败路径尤其危险：**不需要模型先知道任何文本**，
	 * 发一个近似但不匹配的 search 就能拿回最多 2000 字符明文（比成功路径的 ±3 行更宽）。
	 */
	/**
	 * ★★ 「照抄重试」必须真的可行（2026-09-13，审计日志 `vscode-app-1789281483413` 时发现）。
	 *
	 * 失败文案会对模型说 **「Copy this verbatim into "search" and retry」** ——
	 * 这只有在 `snippet` **切自原文**时才成立（见 `patchMatcher` 模块注释里的
	 * 「关键实现约束」）。若哪天有人把 snippet 改成切自归一化副本，这条建议就变成
	 * **空头支票**：模型照抄也永远对不上，表现为**同一个文件反复失败** ——
	 * 正是日志里 `kb-mockup.css` 连败两次的形态（模型照做却仍 not_found）。
	 *
	 * 本 suite 把「提示可执行」变成**可断言的不变量**，而不是靠注释提醒。
	 */
	suite('★ 失败提示必须可执行（snippet 必须切自原文）', () => {

		const FILE = [
			'/* ── Tree node (b3-list-item style) ── */',
			'.kb-node {',
			'\tdisplay: flex; align-items: center; gap: 4px;',
			'\tpadding: 0 6px;',
			'\tmin-width: 0;',
			'\tbox-sizing: border-box;',
			'}',
			'',
			'.other { color: red; }',
		].join('\n');

		test('★★ blockAnchor 命中时，snippet 必须能在原文里精确找到', () => {
			// 首尾行与文件一致、**中间内容漂移** → 触发 blockAnchor 策略。
			// 注意 search 用 4 行：文件块是 7 行，而漂移窗口是 [i+1, i+2n-1]
			// → 文件块行数必须 ≤ 2n-1 才可能命中（见下方「设计边界」用例）。
			const search = [
				'/* ── Tree node (b3-list-item style) ── */',
				'.kb-node {',
				'\tWRONG middle content that is not in the file',
				'}',
			].join('\n');
			const hit = findClosestMatch(FILE, search);
			assert.ok(hit, '应给出最接近的候选（否则提示为空，模型无从下手）');
			assert.strictEqual(hit.strategy, 'blockAnchor', `实际策略：${hit.strategy}`);
			assert.ok(
				FILE.includes(hit.snippet),
				`snippet 必须切自原文，否则「照抄重试」是空头支票：\n${JSON.stringify(hit.snippet)}`,
			);
		});

		test('★★ 短 search（不足块长一半）也必须拿到提示 —— 日志实测的真实形态', () => {
			// 证据（`vscode-app-1789281483413`）：目标块是 13 行的 `.kb-node { … }`，
			// 而模型只引用首尾锚点 + 少量中间行。旧上界 `2n-1` 会让 3~6 行的 search
			// **什么都拿不到**，文案退化为「No similar block was found either」，
			// 模型只能被迫重读整个文件（同一会话里 search 够长的调用反而拿到了提示）。
			const search = [
				'/* ── Tree node (b3-list-item style) ── */',
				'\tWRONG middle content that is not in the file',
				'}',
			].join('\n');
			const hit = findClosestMatch(FILE, search);
			assert.ok(hit, '放宽跨度上限后必须能给出提示（否则模型无从下手）');
			assert.strictEqual(hit.strategy, 'blockAnchor', `实际策略：${hit.strategy}`);
			assert.ok(FILE.includes(hit.snippet), '且 snippet 仍必须切自原文（可照抄）');
		});

		test('★ 设计边界：锚点跨度过大（超过跨度上限）时宁可不给', () => {
			// 上界 = max(2n-1, ANCHOR_SPAN_FLOOR=40)：把收尾锚点放得足够远，
			// 仍应放弃（避免锚点张冠李戴给出错误片段）。
			const long = ['/* ── Tree node (b3-list-item style) ── */'];
			for (let i = 0; i < 60; i++) { long.push(`\t.filler-${i} { color: red; }`); }
			long.push('}');
			const search = [
				'/* ── Tree node (b3-list-item style) ── */',
				'\tWRONG middle',
				'}',
			].join('\n');
			assert.strictEqual(
				findClosestMatch(long.join('\n'), search),
				undefined,
				'超出跨度上限时宁可不给提示，也不要给一个可能张冠李戴的片段',
			);
		});

		test('★★ 任意策略命中的 snippet 都必须可照抄', () => {
			const searches = [
				['/* ── Tree node (b3-list-item style) ── */', '\tWRONG', '}'],       // blockAnchor
				['.kb-node {', '\tdisplay: flex;', '\tpadding: 0 6px;'],               // indentationFlexible
				['display: flex; align-items: center; gap: 4px;', 'padding: 0 6px;'],  // lineTrimmed（缺行首缩进）
			];
			for (const lines of searches) {
				const hit = findClosestMatch(FILE, lines.join('\n'));
				if (!hit) { continue; }
				assert.ok(
					FILE.includes(hit.snippet),
					`strategy=${hit.strategy} 的 snippet 必须可在原文中精确找到：${JSON.stringify(hit.snippet)}`,
				);
			}
		});

		test('★★ 控制组：首尾行都不在文件里时不得硬凑候选（宁可不给提示）', () => {
			const hit = findClosestMatch(FILE, 'NOT IN FILE AT ALL\nSTILL NOT\nNOPE');
			assert.strictEqual(hit, undefined, '没有真实锚点就不该编造 snippet');
		});
	});

	suite('★ 回显脱敏（与 file_read 同等）', () => {

		const FILE = [
			'export const config = {',
			'\tapiKey: "AKIAIOSFODNN7EXAMPLE",',
			'\tpassword: "hunter2",',
			'};',
		].join('\n');

		test('★★ 成功回显（改动区 ±3 行）里的密钥必须被遮蔽', () => {
			const out = buildEditedRegionContext(FILE, 1, 1);
			assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'), `AWS key 泄露：${out}`);
			assert.ok(!out.includes('hunter2'), `口令泄露：${out}`);
			assert.ok(out.includes('<redacted'), out);
			// 行号格式必须不变（模型要能原样复制进下一次 search）
			assert.match(out, /^1\|export const config = \{$/m);
		});

		test('★★ 失败回显（Closest match 原文片段）里的密钥必须被遮蔽', () => {
			// 单行近似（缩进不同）→ 精确匹配失败 → 走 findClosestMatch 的 lineTrimmed 分支
			const out = computePatch(FILE, '  apiKey: "AKIAIOSFODNN7EXAMPLE",', 'x', false, 'cfg.ts');
			assert.strictEqual(out.ok, false);
			const msg = (out as { message: string }).message;
			assert.ok(msg.includes('Closest match'), `仍应给出最接近原文（功能不得退化）：${msg}`);
			assert.ok(!msg.includes('AKIAIOSFODNN7EXAMPLE'), `AWS key 泄露：${msg}`);
		});

		test('★★ 控制组：普通代码不被误伤（回显逐字可用）', () => {
			const plain = 'export function add(a: number, b: number) {\n\treturn a + b;\n}';
			const expected = plain.split('\n').map((l, i) => `${i + 1}|${l}`).join('\n');
			assert.strictEqual(buildEditedRegionContext(plain, 1, 3), expected);
		});

		test('★ 先脱敏再截断：密钥不会被截断点切成两半而漏过', () => {
			// 密钥落在 2000 字符截断边界附近。若**先截断**，token 被切一半 → 正则再也
			// 匹配不上 → 前缀（`AKIA…`）会留在消息里。故断言连前缀都不能出现。
			const longLine = 'x'.repeat(CLOSEST_MATCH_HINT_LIMIT - 10) + ' AKIAIOSFODNN7EXAMPLE';
			const out = computePatch(longLine, longLine + '  ', 'y', false, 'f.ts');
			assert.strictEqual(out.ok, false);
			const msg = (out as { message: string }).message;
			assert.ok(!msg.includes('AKIA'), `截断边界处的密钥前缀泄露：…${msg.slice(-120)}`);
		});
	});

	suite('行尾探测与转换', () => {
		test('纯 CRLF 判为 CRLF', () => {
			assert.strictEqual(detectLineEnding('a\r\nb\r\nc'), 'CRLF');
		});
		test('纯 LF 判为 LF', () => {
			assert.strictEqual(detectLineEnding('a\nb\nc'), 'LF');
		});
		test('无换行默认 LF', () => {
			assert.strictEqual(detectLineEnding('single line'), 'LF');
		});
		test('混合行尾按多数派', () => {
			assert.strictEqual(detectLineEnding('a\r\nb\r\nc\nd'), 'CRLF');
			assert.strictEqual(detectLineEnding('a\nb\nc\r\nd'), 'LF');
		});
		test('CRLF 不被误计为 LF（关键：\\r\\n 只算一次 CRLF）', () => {
			// 若实现把 \r\n 同时计入 crlf 和 lf，此例会退化成 LF
			assert.strictEqual(detectLineEnding('x\r\ny'), 'CRLF');
		});
		test('normalizeLineEndings 统一 CRLF / 孤立 CR', () => {
			assert.strictEqual(normalizeLineEndings('a\r\nb\rc\nd'), 'a\nb\nc\nd');
		});
		test('convertToLineEnding 往返一致', () => {
			const lf = 'a\nb\nc';
			assert.strictEqual(convertToLineEnding(lf, 'CRLF'), 'a\r\nb\r\nc');
			assert.strictEqual(convertToLineEnding(lf, 'LF'), lf);
			assert.strictEqual(normalizeLineEndings(convertToLineEnding(lf, 'CRLF')), lf);
		});
		test('convertToLineEnding 不产生 \\r\\r\\n（已是 CRLF 时需先归一）', () => {
			assert.strictEqual(convertToLineEnding(normalizeLineEndings('a\r\nb'), 'CRLF'), 'a\r\nb');
		});
	});

	suite('★ CRLF 文件 + LF search（线上根因）', () => {
		const file = 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n';

		test('LF search 能命中 CRLF 文件', () => {
			const r = computePatch(file, 'const b = 2;\nconst c = 3;', 'const b = 9;\nconst c = 9;', false, 'f.ts');
			assert.ok(r.ok, r.ok ? '' : r.message);
			assert.ok(r.ok && r.content.includes('const b = 9;\r\nconst c = 9;'), '替换后应为 CRLF');
		});
		test('替换后文件行尾保持 CRLF，不引入裸 LF', () => {
			const r = computePatch(file, 'const b = 2;', 'x\ny', false, 'f.ts');
			assert.ok(r.ok);
			if (r.ok) {
				assert.ok(r.content.includes('x\r\ny'), 'replace 内的换行也须转成 CRLF');
				assert.ok(!/[^\r]\n/.test(r.content), `不应存在裸 LF: ${JSON.stringify(r.content)}`);
			}
		});
		test('lineEndingAdjusted 标记被置位（用于回报模型）', () => {
			const r = computePatch(file, 'const b = 2;\nconst c = 3;', 'z', false, 'f.ts');
			assert.ok(r.ok && r.lineEndingAdjusted === true);
		});
		test('单行 search 无换行时不算 adjusted', () => {
			const r = computePatch(file, 'const b = 2;', 'z', false, 'f.ts');
			assert.ok(r.ok && r.lineEndingAdjusted === false);
		});
		test('LF 文件 + CRLF search 也能命中（反向）', () => {
			const lfFile = 'a\nb\nc\n';
			const r = computePatch(lfFile, 'a\r\nb', 'X', false, 'f.ts');
			assert.ok(r.ok, r.ok ? '' : r.message);
			assert.ok(r.ok && r.content === 'X\nc\n');
		});
	});

	suite('★ 失败必须是失败（不得静默成功）', () => {
		test('未命中 → not_found', () => {
			const r = computePatch('hello world', 'nope', 'x', false, 'f.ts');
			assert.ok(!r.ok);
			assert.strictEqual(r.ok === false && r.reason, 'not_found');
		});
		test('未命中时报出文件行尾风格', () => {
			const r = computePatch('a\r\nb\r\n', 'zzz', 'x', false, 'f.ts');
			assert.ok(!r.ok && r.message.includes('CRLF'));
		});
		test('★ replace_all 零命中也必须失败（旧实现静默写回原文报成功）', () => {
			const r = computePatch('hello world', 'nope', 'x', true, 'f.ts');
			assert.ok(!r.ok, 'replace_all 找不到时绝不能返回成功');
			assert.strictEqual(r.ok === false && r.reason, 'not_found');
		});
		test('★ 多处命中且未开 replace_all → multiple_occurrences（旧实现静默改第一处）', () => {
			const r = computePatch('x\nx\nx', 'x', 'y', false, 'f.ts');
			assert.ok(!r.ok);
			assert.strictEqual(r.ok === false && r.reason, 'multiple_occurrences');
			assert.ok(r.ok === false && r.message.includes('3 times'));
		});
		test('多处命中且开了 replace_all → 全部替换', () => {
			const r = computePatch('x\nx\nx', 'x', 'y', true, 'f.ts');
			assert.ok(r.ok);
			assert.ok(r.ok && r.replacedCount === 3);
			assert.ok(r.ok && r.content === 'y\ny\ny');
		});
		test('search === replace → identical_search_replace（避免无意义写盘）', () => {
			const r = computePatch('abc', 'b', 'b', false, 'f.ts');
			assert.ok(!r.ok);
			assert.strictEqual(r.ok === false && r.reason, 'identical_search_replace');
		});
		test('仅行尾不同的 search/replace 也算 identical', () => {
			const r = computePatch('a\r\nb', 'a\r\nb', 'a\nb', false, 'f.ts');
			assert.ok(!r.ok && r.reason === 'identical_search_replace');
		});
	});

	suite('★ 未命中时回传"文件中的真实原文"', () => {
		test('行尾/尾空白差异 → lineTrimmed，snippet 取自原文', () => {
			const file = 'function f() {\r\n\treturn 1;\r\n}\r\n';
			// 模型少给了 tab
			const r = computePatch(file, 'function f() {\nreturn 1;\n}', 'x', false, 'f.ts');
			assert.ok(!r.ok);
			if (!r.ok) {
				assert.ok(r.message.includes('lineTrimmed'), r.message);
				// snippet 必须含真实的 tab（原文），否则模型照抄回来仍对不上
				assert.ok(r.message.includes('\treturn 1;'), '应回传含 tab 的原文');
			}
		});
		test('整体缩进层级不同 → indentationFlexible', () => {
			const file = 'class A {\n    method() {\n        return 1;\n    }\n}\n';
			const r = computePatch(file, 'method() {\nreturn 1;\n}', 'x', false, 'f.ts');
			assert.ok(!r.ok);
			if (!r.ok) {
				assert.ok(/lineTrimmed|indentationFlexible/.test(r.message), r.message);
			}
		});
		test('中间内容漂移 + ≥3 行 → blockAnchor', () => {
			const file = 'start\nMIDDLE-CHANGED\nend\n';
			const r = computePatch(file, 'start\nmiddle\nend', 'x', false, 'f.ts');
			assert.ok(!r.ok);
			if (!r.ok) {
				assert.ok(r.message.includes('blockAnchor'), r.message);
				assert.ok(r.message.includes('MIDDLE-CHANGED'), '应回传文件里的真实中间行');
			}
		});
		test('两行片段不启用 blockAnchor（避免短片段误报）', () => {
			const file = 'aaa\nZZZ\n';
			const r = computePatch(file, 'aaa\nbbb', 'x', false, 'f.ts');
			assert.ok(!r.ok);
			if (!r.ok) { assert.ok(!r.message.includes('blockAnchor'), r.message); }
		});
		test('完全无相似片段 → 提示重新 file_read', () => {
			const r = computePatch('aaa\nbbb\n', 'totally-unrelated-xyz', 'x', false, 'f.ts');
			assert.ok(!r.ok);
			if (!r.ok) {
				assert.ok(!r.message.includes('Closest match'));
				assert.ok(r.message.includes('file_read'), r.message);
			}
		});
		test('★ 超长片段被截断到上限（防炸上下文）', () => {
			const long = 'x'.repeat(CLOSEST_MATCH_HINT_LIMIT * 2);
			const file = `head\n  ${long}\ntail\n`;
			const r = computePatch(file, `head\n${long}\ntail`, 'z', false, 'f.ts');
			assert.ok(!r.ok);
			if (!r.ok) {
				assert.ok(r.message.includes('(truncated)'), '应截断');
				assert.ok(r.message.length < CLOSEST_MATCH_HINT_LIMIT + 800, `消息过长: ${r.message.length}`);
			}
		});
	});

	suite('findAllOccurrences', () => {
		test('不重叠计数', () => {
			assert.deepStrictEqual(findAllOccurrences('aaaa', 'aa'), [0, 2]);
		});
		test('空 search 返回空（不死循环）', () => {
			assert.deepStrictEqual(findAllOccurrences('abc', ''), []);
		});
		test('无命中返回空', () => {
			assert.deepStrictEqual(findAllOccurrences('abc', 'z'), []);
		});
	});

	suite('替换正确性', () => {
		test('replace_all 逆序替换后内容正确（下标不错位）', () => {
			const r = computePatch('a1a2a3', 'a', 'LONGER', true, 'f.ts');
			assert.ok(r.ok);
			assert.ok(r.ok && r.content === 'LONGER1LONGER2LONGER3');
		});
		test('替换为空串（删除）可用', () => {
			const r = computePatch('keep\r\nDROP\r\nkeep2\r\n', 'DROP\r\n', '', false, 'f.ts');
			assert.ok(r.ok);
			assert.ok(r.ok && r.content === 'keep\r\nkeep2\r\n');
		});
		test('只替换第一处时其余保持不变', () => {
			const r = computePatch('x-x', 'x', 'y', false, 'f.ts');
			// 'x' 出现 2 次 → 应报错而非静默改第一处
			assert.ok(!r.ok && r.reason === 'multiple_occurrences');
		});
		test('唯一命中时正常替换', () => {
			const r = computePatch('foo bar baz', 'bar', 'QUX', false, 'f.ts');
			assert.ok(r.ok && r.content === 'foo QUX baz' && r.replacedCount === 1);
		});
		test('findClosestMatch 对精确命中也能返回（诊断器不崩）', () => {
			const m = findClosestMatch('a\nb\nc\n', 'b');
			assert.ok(m && m.snippet === 'b');
		});
		});

	/**
	 * P0（2026-09-12）：patch 成功回传「改动区域」。
	 *
	 * 起因：此前 patch 成功只回一句 "Patched X — replaced N occurrences"，模型手里
	 * 仍是被改动**之前**的文本 —— 要继续修改邻近区域就只能重新 file_read 整个文件，
	 * 同一文件连续 patch 时反复付出「读 + 上下文」的代价。回传改动区域后，模型可
	 * 直接续写；格式与 file_read 的 `LINE_NUM|CONTENT` 严格对齐，便于原样复制。
	 */
	suite('★ P0 改动区域行号与上下文回传', () => {
		test('单处替换：行号指向替换后的正确行', () => {
			// 1:a  2:b  3:c  4:d
			const r = computePatch('a\nb\nc\nd\n', 'c', 'C', false, 'f.ts');
			assert.ok(r.ok);
			assert.strictEqual(r.editedLineStart, 3, 'c 在第 3 行');
			assert.strictEqual(r.editedLineEnd, 3, '单行替换 → 起止同行');
		});
		test('replace 为多行 → 结束行随之扩展', () => {
			const r = computePatch('a\nb\nc\nd\n', 'b', 'B1\nB2\nB3', false, 'f.ts');
			assert.ok(r.ok);
			assert.strictEqual(r.editedLineStart, 2);
			assert.strictEqual(r.editedLineEnd, 4, '3 行替换 → 2..4');
		});
		test('首行替换 → 起始行为 1', () => {
			const r = computePatch('a\nb\n', 'a', 'A', false, 'f.ts');
			assert.ok(r.ok && r.editedLineStart === 1 && r.editedLineEnd === 1);
		});
		test('CRLF 文件下行号同样正确（\\r 不干扰计数）', () => {
			const r = computePatch('a\r\nb\r\nc\r\n', 'b', 'B', false, 'f.ts');
			assert.ok(r.ok);
			assert.strictEqual(r.editedLineStart, 2);
			assert.strictEqual(r.editedLineEnd, 2);
		});
		test('替换为删除（空 replace）→ 区域塌缩为起始行', () => {
			const r = computePatch('a\nDROP\nc\n', 'DROP\n', '', false, 'f.ts');
			assert.ok(r.ok);
			assert.strictEqual(r.editedLineStart, 2);
			assert.strictEqual(r.editedLineEnd, 2);
		});
		test('replace_all 多处 → 取首处范围，replacedCount 仍报总数', () => {
			const r = computePatch('x\nx\nx\n', 'x', 'y', true, 'f.ts');
			assert.ok(r.ok);
			assert.strictEqual(r.editedLineStart, 1, '首处在第 1 行');
			assert.strictEqual(r.editedLineEnd, 1);
			assert.strictEqual(r.replacedCount, 3, '总数不受影响');
		});
		test('buildEditedRegionContext：格式与 file_read 一致（LINE_NUM|CONTENT）', () => {
			assert.strictEqual(buildEditedRegionContext('a\nb\nc\nd\ne\nf\ng\n', 4, 4, 1), '3|c\n4|d\n5|e');
		});
		test('buildEditedRegionContext：默认前后各 PATCH_CONTEXT_LINES 行', () => {
			assert.strictEqual(PATCH_CONTEXT_LINES, 3, '默认 3 行');
			const content = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n');
			assert.strictEqual(
				buildEditedRegionContext(content, 5, 5),
				'2|L2\n3|L3\n4|L4\n5|L5\n6|L6\n7|L7\n8|L8',
			);
		});
		test('buildEditedRegionContext：越界自动夹紧到文件首尾', () => {
			assert.strictEqual(buildEditedRegionContext('a\nb\n', 1, 1, 5), '1|a\n2|b\n3|');
			assert.strictEqual(buildEditedRegionContext('a\nb\nc\n', 3, 3, 5), '1|a\n2|b\n3|c\n4|');
		});
		test('buildEditedRegionContext：CRLF 内容不残留 \\r（对齐 file_read 输出）', () => {
			assert.strictEqual(buildEditedRegionContext('a\r\nb\r\nc\r\n', 2, 2, 1), '1|a\n2|b\n3|c');
		});
		test('buildEditedRegionContext：单行文件不越界', () => {
			assert.strictEqual(buildEditedRegionContext('only', 1, 1, 3), '1|only');
		});
	});

	/**
	 * P2（2026-09-12）：行号插入模式 —— 对齐 Cline `editor` 的 `insert_line`。
	 * 用于「无既有文本可锚定」的场景（新增 import / 追加 EOF / 插入新函数），
	 * 行号直接取自 file_read 的 `LINE_NUM|CONTENT` 输出。
	 */
	suite('★ P2 行号插入模式（insert_line）', () => {
		test('插在第 1 行之前 → 成为首行', () => {
			const r = computeInsert('a\nb\nc\n', 1, 'X', 'f.ts');
			assert.ok(r.ok, r.ok ? '' : r.message);
			assert.strictEqual(r.content, 'X\na\nb\nc\n');
			assert.strictEqual(r.editedLineStart, 1);
			assert.strictEqual(r.editedLineEnd, 1);
		});
		test('插在中间行之前', () => {
			const r = computeInsert('a\nb\nc\n', 2, 'X', 'f.ts');
			assert.ok(r.ok);
			assert.strictEqual(r.content, 'a\nX\nb\nc\n');
			assert.strictEqual(r.editedLineStart, 2);
		});
		test('★ 追加到 EOF（文件以换行结尾）→ 不多出空行', () => {
			// 'a\nb\n' 共 3 行（末尾空行按 file_read 语义也算一行）→ 边界 4
			const r = computeInsert('a\nb\n', 4, 'X', 'f.ts');
			assert.ok(r.ok, r.ok ? '' : r.message);
			assert.strictEqual(r.content, 'a\nb\nX', '不应产生 a\\nb\\n\\nX（Cline splice 会多留空行）');
			assert.strictEqual(r.editedLineStart, 3, 'X 实际落在第 3 行');
		});
		test('★ 追加到 EOF（文件无末尾换行）', () => {
			const r = computeInsert('a\nb', 3, 'X', 'f.ts');
			assert.ok(r.ok, r.ok ? '' : r.message);
			assert.strictEqual(r.content, 'a\nb\nX');
			assert.strictEqual(r.editedLineStart, 3);
		});
		test('插入多行文本 → 区域随之扩展', () => {
			const r = computeInsert('a\nb\n', 2, 'X1\nX2\nX3', 'f.ts');
			assert.ok(r.ok);
			assert.strictEqual(r.content, 'a\nX1\nX2\nX3\nb\n');
			assert.strictEqual(r.editedLineStart, 2);
			assert.strictEqual(r.editedLineEnd, 4);
		});
		test('★ CRLF 文件：插入文本行尾随之转 CRLF（且不产生 \\r\\r\\n）', () => {
			const r = computeInsert('a\r\nb\r\n', 2, 'X\nY', 'f.ts');
			assert.ok(r.ok, r.ok ? '' : r.message);
			assert.strictEqual(r.content, 'a\r\nX\r\nY\r\nb\r\n');
			assert.ok(!/\r\r/.test(r.content), `不应出现 \\r\\r: ${JSON.stringify(r.content)}`);
			assert.strictEqual(r.lineEnding, 'CRLF');
			assert.strictEqual(r.lineEndingAdjusted, true, 'LF 入参 → 已转换');
		});
		test('CRLF 文件 + CRLF 入参 → 不算 adjusted', () => {
			const r = computeInsert('a\r\nb\r\n', 1, 'X\r\nY', 'f.ts');
			assert.ok(r.ok && r.lineEndingAdjusted === false, r.ok ? '' : r.message);
		});
		test('LF 文件 + LF 入参 → 不算 adjusted', () => {
			const r = computeInsert('a\nb\n', 1, 'X', 'f.ts');
			assert.ok(r.ok && r.lineEndingAdjusted === false);
		});
		test('★ insert_line 越界 → invalid_insert_line（含合法范围与 EOF 提示）', () => {
			const r = computeInsert('a\nb\nc\n', 99, 'X', 'f.ts');
			assert.ok(!r.ok);
			assert.strictEqual(r.ok === false && r.reason, 'invalid_insert_line');
			assert.ok(r.message.includes('1..5'), `应给出合法范围: ${r.message}`);
			assert.ok(r.message.includes('append at EOF'), `应提示 EOF 边界: ${r.message}`);
		});
		test('insert_line = 0 / 负数 / 非整数 / NaN → 一律拒绝', () => {
			for (const bad of [0, -1, 2.5, NaN]) {
				const r = computeInsert('a\nb\n', bad, 'X', 'f.ts');
				assert.ok(!r.ok && r.reason === 'invalid_insert_line', `应拒绝 insert_line=${bad}`);
			}
		});
		test('空插入文本 → empty_insert', () => {
			const r = computeInsert('a\nb\n', 1, '', 'f.ts');
			assert.ok(!r.ok);
			assert.strictEqual(r.ok === false && r.reason, 'empty_insert');
		});
		test('插入到空文件', () => {
			const r = computeInsert('', 1, 'X', 'f.ts');
			assert.ok(r.ok, r.ok ? '' : r.message);
			assert.strictEqual(r.content, 'X');
			assert.strictEqual(r.editedLineStart, 1);
		});
		test('插入后回传的 region 与插入结果自洽（可直接复用）', () => {
			const r = computeInsert('a\nb\nc\n', 2, 'NEW', 'f.ts');
			assert.ok(r.ok);
			const region = buildEditedRegionContext(r.content, r.editedLineStart, r.editedLineEnd);
			assert.ok(region.includes('2|NEW'), `region 应含插入行: ${region}`);
		});
	});

		/**
		* 2026-08-22 日志 1787386409745 回归防线（Tier 0 优化）：
		*  · identical_search_replace 已应用 → 报"已存在/已应用"，救重发浪费
		*  · not_found 不再把"行尾"列为必须匹配项去误导（CRLF 仅附中性说明）
		*/
		suite('no-op / 已应用信号与 not_found 行尾提示精度', () => {
		test('identical_search_replace 但块已存在于文件 → 报已应用、提示停止重发', () => {
			// 模型重发了已生效的 patch：search===replace，且该块确实已在文件中
			const r = computePatch('const a = 1;\nconst b = 2;\n', 'const a = 1;', 'const a = 1;', false, 'f.ts');
			assert.ok(!r.ok && r.reason === 'identical_search_replace');
			assert.ok(r.message.includes('already'), `应提示已应用: ${r.message}`);
			assert.ok(r.message.toLowerCase().includes('stop'), `应提示停止重发: ${r.message}`);
		});
		test('identical_search_replace 且块不在文件 → 报 no-op（不误导为已应用）', () => {
			const r = computePatch('completely-different-content\n', 'const a = 1;', 'const a = 1;', false, 'f.ts');
			assert.ok(!r.ok && r.reason === 'identical_search_replace');
			assert.ok(r.message.includes('no-op'), `应提示 no-op: ${r.message}`);
			assert.ok(!r.message.toLowerCase().includes('already'), `不应提示已应用: ${r.message}`);
		});
		test('not_found 命中 CRLF 文件但差异在文本 → 不再误导"行尾"为必须项', () => {
			// 文件 CRLF，search 内容完全不相关（非行尾问题）。旧实现会无脑附加
			// "including ... line endings (this file uses CRLF)" 误导模型。
			const r = computePatch('a\r\nb\r\nc\r\n', 'totally-unrelated-xyz', 'x', false, 'f.ts');
			assert.ok(!r.ok && r.reason === 'not_found');
			assert.ok(!r.message.includes('including whitespace, indentation and line endings'),
				`不应把行尾列为必须匹配项: ${r.message}`);
			// 仅附中性说明：行尾已自动归一、差异在文本本身
			assert.ok(r.message.includes('CRLF'), `应附 CRLF 中性说明: ${r.message}`);
			assert.ok(r.message.includes('normalized automatically'), `应说明行尾已自动归一: ${r.message}`);
		});
		test('not_found 命中 LF 文件 → 不附加任何行尾说明', () => {
			const r = computePatch('a\nb\nc\n', 'totally-unrelated-xyz', 'x', false, 'f.ts');
			assert.ok(!r.ok && r.reason === 'not_found');
			assert.ok(!r.message.includes('line ending'), `LF 文件不应提及行尾: ${r.message}`);
		});
		});
});
