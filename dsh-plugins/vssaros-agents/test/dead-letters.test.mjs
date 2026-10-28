// @vssaros/dsh-agents — 入站死信单测（2026-10-27）
//   跑法：node dsh-plugins/vssaros-agents/test/dead-letters.test.mjs
//
// 三条边界最容易写错，写错了这一层就没意义：
//   ① `duplicate` 也记 ⇒ 飞书重投会瞬间刷满（正常去重被当成故障）
//   ② `pairing-required` 也记 ⇒ 把"挂起等批准"说成"失败"，用户按错的方向排查
//   ③ 不设上限 ⇒ 文件无限增长；不截断正文 ⇒ 整段外部消息长期留在磁盘上
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	DEAD_LETTER_CAP, DEAD_LETTER_REASONS, DEAD_LETTER_TEXT_MAX,
	clearDeadLetters, clipText, deadLettersPathOf, listDeadLetters, recordDeadLetter,
} from '../lib/deadLetters.js';

let pass = 0;
const fails = [];
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const fresh = () => mkdtempSync(join(tmpdir(), 'vssaros-dlq-'));

/* ── 纯函数 ─────────────────────────────────────────────────────────────── */
check('clipText：压平空白 + 超长截断', () => {
	assert.equal(clipText('a\n\n  b   c'), 'a b c');
	const long = 'x'.repeat(DEAD_LETTER_TEXT_MAX + 50);
	const got = clipText(long);
	assert.equal(got.length, DEAD_LETTER_TEXT_MAX + 1, '截断后应带一个省略号');
	assert.ok(got.endsWith('…'));
});
check('不该记的 reason 不在表里（duplicate / pairing-required 明确排除）', () => {
	assert.ok(!DEAD_LETTER_REASONS.has('duplicate'));
	assert.ok(!DEAD_LETTER_REASONS.has('pairing-required'));
	assert.ok(!DEAD_LETTER_REASONS.has('ok'));
	assert.ok(DEAD_LETTER_REASONS.has('sender'));
	assert.ok(DEAD_LETTER_REASONS.has('dispatch-error'));
	assert.ok(DEAD_LETTER_REASONS.has('loop'));
});

/* ── 记录 ───────────────────────────────────────────────────────────────── */
const root = fresh();
const config = { dataRoot: root };
const T0 = 1_700_000_000_000;

await checkAsync('★ 记录一条：字段齐全 + 正文截断', async () => {
	const r = await recordDeadLetter(config, {
		reason: 'sender', platform: 'feishu', chatId: 'oc_1', chatType: 'p2p',
		userId: 'ou_x', userName: '张三', messageId: 'm1',
		text: 'y'.repeat(1000),
	}, { now: () => T0 });
	assert.equal(r.recorded, true);
	assert.equal(r.item.text.length, DEAD_LETTER_TEXT_MAX + 1);
	const list = await listDeadLetters(config);
	assert.equal(list.total, 1);
	const one = list.items[0];
	assert.equal(one.reason, 'sender');
	assert.equal(one.userName, '张三');
	assert.equal(one.chatId, 'oc_1');
});

await checkAsync('★ duplicate 不记（重投会把列表刷满）', async () => {
	const dir = fresh();
	const r = await recordDeadLetter({ dataRoot: dir }, { reason: 'duplicate', platform: 'feishu', text: 'x' });
	assert.equal(r.skipped, true);
	assert.equal((await listDeadLetters({ dataRoot: dir })).total, 0);
});

await checkAsync('★ pairing-required 不记（那是"挂起等批准"，不是失败）', async () => {
	const dir = fresh();
	const r = await recordDeadLetter({ dataRoot: dir }, { reason: 'pairing-required', platform: 'feishu' });
	assert.equal(r.skipped, true);
	assert.equal((await listDeadLetters({ dataRoot: dir })).total, 0);
});

await checkAsync('★ 有界 FIFO：超过上限时丢最旧的', async () => {
	const dir = fresh();
	const cfg = { dataRoot: dir };
	for (let i = 0; i < DEAD_LETTER_CAP + 5; i += 1) {
		await recordDeadLetter(cfg, { reason: 'sender', platform: 'feishu', messageId: 'm' + i, text: 't' + i }, { now: () => T0 + i });
	}
	const all = await listDeadLetters(cfg, { limit: DEAD_LETTER_CAP });
	assert.equal(all.total, DEAD_LETTER_CAP);
	// 最新的在前，最旧的已被挤掉
	assert.equal(all.items[0].messageId, 'm' + (DEAD_LETTER_CAP + 4));
	assert.ok(!all.items.some((x) => x.messageId === 'm0'), '最旧的应被挤掉');
});

await checkAsync('新的在前 + limit 生效', async () => {
	const dir = fresh();
	const cfg = { dataRoot: dir };
	for (let i = 0; i < 5; i += 1) {
		await recordDeadLetter(cfg, { reason: 'sender', platform: 'feishu', messageId: 'm' + i }, { now: () => T0 + i });
	}
	const list = await listDeadLetters(cfg, { limit: 3 });
	assert.equal(list.items.length, 3);
	assert.deepEqual(list.items.map((x) => x.messageId), ['m4', 'm3', 'm2']);
	assert.equal(list.total, 5, 'total 是总数，不是本页条数');
});

await checkAsync('按 reason 过滤', async () => {
	const dir = fresh();
	const cfg = { dataRoot: dir };
	await recordDeadLetter(cfg, { reason: 'sender', platform: 'feishu' }, { now: () => T0 });
	await recordDeadLetter(cfg, { reason: 'no-mention', platform: 'feishu' }, { now: () => T0 + 1 });
	const only = await listDeadLetters(cfg, { reason: 'no-mention' });
	assert.equal(only.total, 1);
	assert.equal(only.items[0].reason, 'no-mention');
});

await checkAsync('★ 清空返回清掉的条数，之后为空', async () => {
	const dir = fresh();
	const cfg = { dataRoot: dir };
	await recordDeadLetter(cfg, { reason: 'sender', platform: 'feishu' }, { now: () => T0 });
	await recordDeadLetter(cfg, { reason: 'loop', platform: 'feishu' }, { now: () => T0 + 1 });
	const r = await clearDeadLetters(cfg);
	assert.equal(r.cleared, 2);
	assert.equal((await listDeadLetters(cfg)).total, 0);
});

await checkAsync('文件落在 dataRoot 下，且写出来是 0600 友好的 JSON', async () => {
	const dir = fresh();
	const cfg = { dataRoot: dir };
	await recordDeadLetter(cfg, { reason: 'sender', platform: 'feishu', text: 'hi' }, { now: () => T0 });
	const body = JSON.parse(readFileSync(deadLettersPathOf(cfg), 'utf8'));
	assert.equal(body.version, 1);
	assert.equal(body.items.length, 1);
	assert.ok(deadLettersPathOf(cfg).endsWith('agent-im-deadletters.json'));
});

await checkAsync('坏文件（非 JSON）⇒ 当空表，不抛', async () => {
	const dir = fresh();
	const cfg = { dataRoot: dir };
	const { writeFileSync, mkdirSync } = await import('node:fs');
	mkdirSync(dir, { recursive: true });
	writeFileSync(deadLettersPathOf(cfg), 'not-json', 'utf8');
	assert.equal((await listDeadLetters(cfg)).total, 0);
});

try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 入站死信单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
