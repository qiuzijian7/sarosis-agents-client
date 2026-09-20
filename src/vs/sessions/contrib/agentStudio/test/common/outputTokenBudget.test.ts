/*---------------------------------------------------------------------------------------------
 *  outputTokenBudget.test.ts — 确定性 token 预算（P0-4，2026-09-20）
 *
 *  钉住三条：① 预算内不截 ✓ ② 超预算**按整行**截（绝不切半行 ✗✓）+ 收敛指引 ✓
 *  ③ 未传预算 ⇒ 原样（行为不变 ✓）。
 *  运行：node test/common/run-all-common-tests.mjs（自动收 ✓）
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { truncateToTokenBudget, OUTPUT_TOKEN_BYTES } from '../../common/outputTokenBudget.js';

suite('outputTokenBudget — 确定性 token 预算（P0-4，2026-09-20）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★ 未传 / ≤0 预算 ⇒ 原样返回（行为不变 ✓）', () => {
		const out = 'a\nb\nc';
		assert.deepStrictEqual(truncateToTokenBudget(out, undefined), { text: out, truncated: false, droppedLines: 0 });
		assert.deepStrictEqual(truncateToTokenBudget(out, 0), { text: out, truncated: false, droppedLines: 0 });
		assert.deepStrictEqual(truncateToTokenBudget(out, -5), { text: out, truncated: false, droppedLines: 0 });
	});

	test('★ 预算内 ⇒ 不截 ✓', () => {
		const out = ['#|type|qn|loc', '1|Function|foo|a.ts:1', '2|Function|bar|b.ts:2'].join('\n');
		const r = truncateToTokenBudget(out, 1000); // 4000 字符预算 ≫ 输出
		assert.strictEqual(r.truncated, false);
		assert.strictEqual(r.text, out);
		assert.strictEqual(r.droppedLines, 0);
	});

	test('★★ 超预算 ⇒ **按整行**截（绝不切半行 ✗✓）+ 收敛指引 ✓', () => {
		// 每行 ~24 字符；预算 100 token = 400 字符 ⇒ 大约能放 ~16 行
		const lines = ['#|type|qn|loc'];
		for (let i = 1; i <= 50; i++) { lines.push(`${i}|Function|name_${i}|f${i}.ts:${i}`); }
		const out = lines.join('\n');
		const tokens = 10; // 40 字符预算
		const r = truncateToTokenBudget(out, tokens, 'narrow it');
		assert.strictEqual(r.truncated, true, '超预算必须截 ✓');
		assert.ok(r.droppedLines > 0);
		// ① 表头一定在 ✓
		assert.ok(r.text.startsWith('#|type|qn|loc'), '表头必须保留 ✓');
		// ② **绝不切半行**：每个保留行都必须是原输出里的**完整**行 ✗✓
		const bodyLines = r.text.split('\n').filter(l => !l.startsWith('HINT:'));
		for (const l of bodyLines) { assert.ok(lines.includes(l), `切出了非完整行：${JSON.stringify(l)} ✗✗`); }
		// ③ 收敛指引在 ✓
		assert.ok(r.text.includes('HINT:') && r.text.includes('narrow it'), '截断必须附收敛指引 ✓');
		// ④ 体量受控 ✓（marker 会略超预算，但主体 ≤ 预算 ✓）
		assert.ok(bodyLines.join('\n').length <= tokens * OUTPUT_TOKEN_BYTES, '主体必须在预算内 ✓');
	});

	test('★ 预算小到放不下任何行 ⇒ 只剩表头 + 指引（不崩 ✓）', () => {
		const out = 'HEADER-ROW\nrow1\nrow2';
		const r = truncateToTokenBudget(out, 1); // 4 字符预算 < 表头
		assert.strictEqual(r.truncated, true);
		// 连表头都放不下 ⇒ kept 为空 ⇒ 只有 marker
		assert.ok(r.text.includes('HINT:'), '至少要给收敛指引 ✓');
		assert.ok(!r.text.includes('row1'), '放不下的行绝不能出现 ✓');
	});
});
