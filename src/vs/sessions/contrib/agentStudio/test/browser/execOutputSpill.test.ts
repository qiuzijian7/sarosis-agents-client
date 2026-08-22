/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 超限输出落盘决策回归测试（2026-08-22）。
 *
 * 替代原先的「中段永久丢弃」。两组关键断言：
 *  - **不为小输出制造文件**（否则每条命令都留垃圾）
 *  - **回收策略确实回收**（否则无限堆积磁盘）
 */

import assert from 'assert';
import {
	decideOutputSpill, spillFileName, spillNoticeMessage, selectSpillFilesToDelete,
	isStaleSpillFile, SPILL_THRESHOLD_BYTES, SPILL_INLINE_HEAD_BYTES, SPILL_MAX_FILES, SPILL_MAX_AGE_MS,
} from '../../browser/providers/tool/execOutputSpill.js';

suite('execOutputSpill — decideOutputSpill', () => {

	test('★ 小输出不落盘（不为每条命令制造垃圾文件）', () => {
		for (const s of ['', 'ok', 'a'.repeat(1000), 'b'.repeat(SPILL_THRESHOLD_BYTES)]) {
			const d = decideOutputSpill(s);
			assert.strictEqual(d.shouldSpill, false, `len=${s.length}`);
			assert.strictEqual(d.inlineHead, s, '不落盘时内容必须完整保留');
		}
	});

	test('★ 恰好超过阈值 1 字符 → 落盘（边界）', () => {
		const d = decideOutputSpill('c'.repeat(SPILL_THRESHOLD_BYTES + 1));
		assert.strictEqual(d.shouldSpill, true);
		assert.strictEqual(d.totalChars, SPILL_THRESHOLD_BYTES + 1);
	});

	test('★ 内联头部切在行边界（不把一行截半误导模型）', () => {
		const line = 'x'.repeat(100);
		const text = Array.from({ length: 2000 }, () => line).join('\n');
		const d = decideOutputSpill(text);
		assert.strictEqual(d.shouldSpill, true);
		assert.ok(!d.inlineHead.endsWith('x'.repeat(1)) || d.inlineHead.split('\n').pop() === line,
			'末尾应是完整行');
		assert.ok(d.inlineHead.length <= SPILL_INLINE_HEAD_BYTES, '头部不应超过预算');
	});

	test('★ 无换行的超长单行仍能切（不能因找不到换行而返回全文）', () => {
		const d = decideOutputSpill('y'.repeat(SPILL_THRESHOLD_BYTES * 2));
		assert.strictEqual(d.shouldSpill, true);
		assert.strictEqual(d.inlineHead.length, SPILL_INLINE_HEAD_BYTES);
	});

	test('totalChars 反映原始长度（供提示文案用）', () => {
		const text = 'z'.repeat(100_000);
		assert.strictEqual(decideOutputSpill(text).totalChars, 100_000);
	});
});

suite('execOutputSpill — spillFileName', () => {

	test('文件名可排序且含毫秒 + 序号', () => {
		const n = spillFileName(new Date(2026, 7, 22, 13, 5, 9, 42), 7);
		assert.strictEqual(n, 'exec-20260822-130509-042-007.log');
	});

	test('★ 同一毫秒内不同序号 → 不重名', () => {
		const d = new Date(2026, 7, 22, 1, 2, 3, 4);
		assert.notStrictEqual(spillFileName(d, 1), spillFileName(d, 2));
	});

	test('序号回绕不产生非法文件名', () => {
		const n = spillFileName(new Date(2026, 0, 1, 0, 0, 0, 0), 1234);
		assert.match(n, /^exec-\d{8}-\d{6}-\d{3}-\d{3}\.log$/);
	});
});

suite('execOutputSpill — spillNoticeMessage', () => {

	test('★ 明确「没有丢」+ 给出可执行的检索方式 + 禁止重跑', () => {
		const msg = spillNoticeMessage('C:\\Users\\me\\.vssaros\\tmp\\exec-1.log', 200_000, 'first lines here');
		assert.match(msg, /first lines here/, '必须包含内联头部');
		assert.match(msg, /Nothing was lost/i, '必须澄清信息未丢失');
		assert.match(msg, /exec-1\.log/, '必须给出路径');
		assert.match(msg, /search_code/, '必须给出检索方式');
		assert.match(msg, /file_read/, '必须给出分页读方式');
		assert.match(msg, /Do NOT re-run/i, '必须禁止为看输出而重跑命令');
		assert.match(msg, /200000 characters/, '必须告知总量');
	});
});

suite('execOutputSpill — 回收策略', () => {

	const NOW = 1_700_000_000_000;
	const mk = (i: number, ageMs: number) => ({
		name: `exec-20260822-000000-000-${String(i).padStart(3, '0')}.log`,
		mtimeMs: NOW - ageMs,
	});

	test('★ 超龄文件被回收', () => {
		const files = [mk(1, SPILL_MAX_AGE_MS + 1000), mk(2, 1000)];
		const del = selectSpillFilesToDelete(files, NOW);
		assert.deepStrictEqual(del, [files[0].name]);
	});

	test('★ 超量文件被回收（保留最新 SPILL_MAX_FILES 个）', () => {
		const files = Array.from({ length: SPILL_MAX_FILES + 5 }, (_, i) => mk(i, i * 1000));
		const del = selectSpillFilesToDelete(files, NOW);
		assert.strictEqual(del.length, 5, '应删最旧的 5 个');
		// 最新的（age 最小）必须保留
		assert.ok(!del.includes(files[0].name));
		// 最旧的必须被删
		assert.ok(del.includes(files[files.length - 1].name));
	});

	test('★★ 只回收自己产生的文件（绝不碰 tmp/ 里其他东西）', () => {
		const files = [
			{ name: 'important-user-file.txt', mtimeMs: NOW - SPILL_MAX_AGE_MS * 10 },
			{ name: 'plan-draft.md', mtimeMs: NOW - SPILL_MAX_AGE_MS * 10 },
			{ name: 'exec-notmine.log', mtimeMs: NOW - SPILL_MAX_AGE_MS * 10 },
			mk(1, SPILL_MAX_AGE_MS + 1),
		];
		const del = selectSpillFilesToDelete(files, NOW);
		assert.deepStrictEqual(del, [files[3].name],
			'tmp/ 是共享目录，只能删严格匹配自己命名格式的文件');
	});

	test('未超龄未超量 → 不删任何东西', () => {
		const files = Array.from({ length: 5 }, (_, i) => mk(i, i * 1000));
		assert.deepStrictEqual(selectSpillFilesToDelete(files, NOW), []);
	});

	test('空目录 → 不删', () => {
		assert.deepStrictEqual(selectSpillFilesToDelete([], NOW), []);
	});

	test('isStaleSpillFile 只对自己的命名格式生效', () => {
		assert.strictEqual(isStaleSpillFile('exec-20260822-000000-000-001.log', NOW - SPILL_MAX_AGE_MS - 1, NOW), true);
		assert.strictEqual(isStaleSpillFile('other.log', NOW - SPILL_MAX_AGE_MS - 1, NOW), false);
		assert.strictEqual(isStaleSpillFile('exec-20260822-000000-000-001.log', NOW - 1000, NOW), false);
	});
});
