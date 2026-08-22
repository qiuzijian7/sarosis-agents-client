/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	detectLineEnding, normalizeLineEndings, convertToLineEnding,
	findClosestMatch, findAllOccurrences, computePatch, CLOSEST_MATCH_HINT_LIMIT,
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
