// @vssaros/dsh-agents — 派发正文预算单测（2026-10-26）
//   跑法：node dsh-plugins/vssaros-agents/test/dispatch-budget.test.mjs
//
// 为什么要有：`digest` 会把最多 50 条消息拼成一条派给成员，单条消息还可能是几万字日志。
// 一旦不加预算，成员会话会被撑爆（模型报错或静默丢历史），而**界面看起来一切正常**
// —— 这种"只在高负载下炸"的问题必须用断言钉住。
import assert from 'node:assert/strict';
import { clipBody, clipDispatchText, digestText } from '../lib/groups.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
	try { fn(); pass += 1; }
	catch (e) { fails.push(`${name} → ${String((e && e.message) || e).split('\n')[0]}`); }
};

/* ── clipBody ───────────────────────────────────────────────────────── */
check('短正文原样返回（不引入标记）', () => {
	assert.equal(clipBody('你好', 800), '你好');
});
check('★ 长正文截到 limit + 明示还剩多少字', () => {
	const s = 'a'.repeat(1000);
	const out = clipBody(s, 800);
	assert.ok(out.startsWith('a'.repeat(800)));
	assert.ok(/本条还有 200 字/.test(out), out.slice(-30));
});
check('尾部空白先剥掉（避免"还有 3 字"其实全是空格）', () => {
	assert.equal(clipBody('hi   ', 800), 'hi');
});
check('空值安全', () => {
	assert.equal(clipBody(null), '');
	assert.equal(clipBody(undefined), '');
});

/* ── clipDispatchText ──────────────────────────────────────────────── */
check('未超预算 ⇒ 一字不改（正常场景零影响）', () => {
	const s = 'x'.repeat(100);
	assert.equal(clipDispatchText(s, 12_000), s);
});
check('★ 超预算 ⇒ 保头 60% + 保尾 40%，中间标出省略量', () => {
	const head = 'HEAD'.repeat(10);
	const tail = 'TAIL'.repeat(10);
	const s = head + 'M'.repeat(5000) + tail;
	const out = clipDispatchText(s, 1000);
	assert.ok(out.startsWith(head.slice(0, 10)), '应保留开头');
	assert.ok(out.endsWith(tail.slice(-10)), '应保留结尾');
	assert.ok(/中间省略 \d+ 字/.test(out), '应标注省略量');
	const m = /中间省略 (\d+) 字/.exec(out);
	assert.equal(Number(m[1]), s.length - 1000);
});
check('截断后总长可控（≤ 预算 + 标记）', () => {
	const out = clipDispatchText('y'.repeat(50_000), 1000);
	assert.ok(out.length < 1100, `len=${out.length}`);
});
check('★ 截断标记里写明"完整内容见群聊记录"（成员知道去哪看全文）', () => {
	const out = clipDispatchText('z'.repeat(20_000), 12_000);
	assert.ok(/完整内容见群聊记录/.test(out));
});

/* ── digestText ────────────────────────────────────────────────────── */
check('空数组 ⇒ 空串', () => {
	assert.equal(digestText([]), '');
});
check('单条走总量预算，不加编号', () => {
	assert.equal(digestText(['就一条']), '就一条');
	const long = digestText(['q'.repeat(20_000)]);
	assert.ok(/正文过长/.test(long));
	assert.ok(!/^1\./.test(long));
});
check('★ 多条 ⇒ 抬头写总条数 + 从 1 开始编号', () => {
	const out = digestText(['甲', '乙', '丙']);
	assert.ok(/汇总 3 条群消息/.test(out), out.split('\n')[0]);
	assert.ok(/\n1\. 甲\n2\. 乙\n3\. 丙$/.test(out), out);
});
check('★ 超过 maxRows ⇒ 只带最近 N 条，并写明更早丢了几条', () => {
	const rows = Array.from({ length: 120 }, (_, i) => `第${i + 1}条`);
	const out = digestText(rows, { maxRows: 50 });
	assert.ok(/更早 70 条未附上/.test(out), out.split('\n')[0]);
	// 编号应接在丢掉的部分之后：第一条是第 71 条
	assert.ok(/\n71\. 第71条/.test(out), out.split('\n')[2]);
	assert.ok(/\n120\. 第120条/.test(out));
});
check('★ 总量撞预算 ⇒ 停在中途并标注"另有 N 条因篇幅未附上"', () => {
	// 每条 800 字，12k 预算大约只能放 14 条 ⇒ 必然触发中途停止
	const rows = Array.from({ length: 40 }, () => 'w'.repeat(800));
	const out = digestText(rows, { budget: 4000, bodyLimit: 800, maxRows: 50 });
	assert.ok(/另有 \d+ 条因篇幅未附上/.test(out), out.split('\n')[0]);
	assert.ok(out.length <= 4200, `len=${out.length}`);
});
check('★ 预算小到一条都放不下 ⇒ 仍给第一条（不返回空壳）', () => {
	const out = digestText(['甲'.repeat(500), '乙'], { budget: 120, bodyLimit: 800 });
	assert.ok(/甲/.test(out), out);
	assert.ok(out.length > 10);
});
check('单条超长在 digest 里会按 bodyLimit 截断（不是整条丢）', () => {
	const out = digestText(['a'.repeat(5000), 'b'], { bodyLimit: 100 });
	assert.ok(/本条还有 4900 字/.test(out), out.slice(0, 200));
});

/* ── 汇总 ──────────────────────────────────────────────────────────── */
const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 派发预算单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
