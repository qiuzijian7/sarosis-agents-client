// @vssaros/dsh-agents — DM 配对单测（**OpenClaw 同构**，2026-10-27）
//   跑法：node dsh-plugins/vssaros-agents/test/pairing.test.mjs
//
// 这层的错都很贵：
//   · 码可猜测 / 不过期 ⇒ 陌生人能自己批自己（等于没有准入）
//   · 每发一句生成新码 ⇒ 对方永远不知道该填哪个
//   · 待处理不设上限 ⇒ 被刷爆（文件无限增长，界面一屏乱码）
//   · 批准写成"给群权限" ⇒ 批准一个私聊联系人，顺手把群也开了
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	PAIR_ALPHABET, PAIR_CODE_LEN, PAIR_MAX_PENDING, PAIR_TTL_MS,
	approvePairing, approvedUserIds, listPairings, newPairCode, normalizeCode,
	pairingPathOf, requestPairing, revokePairing,
} from '../lib/pairing.js';

let pass = 0;
const fails = [];
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const fresh = () => mkdtempSync(join(tmpdir(), 'vssaros-pair-'));

/* ── 码格式 ─────────────────────────────────────────────────────────────── */
check('★ 码 8 位、不含易混字符 0 O 1 I', () => {
	assert.equal(PAIR_CODE_LEN, 8);
	for (let i = 0; i < 200; i += 1) {
		const c = newPairCode();
		assert.equal(c.length, 8);
		assert.ok(!/[0O1I]/.test(c), '不该出现 0/O/1/I：' + c);
		assert.ok(c.split('').every((ch) => PAIR_ALPHABET.includes(ch)));
	}
});
check('normalizeCode：去空格/连字符并转大写（手抄容错）', () => {
	assert.equal(normalizeCode(' ab-cd 12 '), 'ABCD12');
	assert.equal(normalizeCode(undefined), '');
});

/* ── 请求 ───────────────────────────────────────────────────────────────── */
const root = fresh();
const config = { dataRoot: root };
const T0 = 1_700_000_000_000;

await checkAsync('★ 首次请求生成 8 位码 + 1 小时过期', async () => {
	const r = await requestPairing(config, { platform: 'feishu', chatId: 'c1', userId: 'u1', userName: '张三' }, { now: () => T0 });
	assert.equal(r.code.length, 8);
	assert.equal(r.expiresAt, T0 + PAIR_TTL_MS);
	assert.equal(r.reused, false);
});

await checkAsync('★ 同一人重复请求 ⇒ 复用同一个码（不刷屏）', async () => {
	const first = await requestPairing(config, { platform: 'feishu', chatId: 'c1', userId: 'u1' }, { now: () => T0 + 1000 });
	const again = await requestPairing(config, { platform: 'feishu', chatId: 'c1', userId: 'u1' }, { now: () => T0 + 2000 });
	assert.equal(again.code, first.code);
	assert.equal(again.reused, true);
	const list = await listPairings(config, { now: () => T0 + 3000 });
	assert.equal(list.requests.length, 1, '不该出现两条');
});

await checkAsync('★ 每渠道最多 3 条待处理，超出忽略（throttled）', async () => {
	const dir = fresh();
	const cfg = { dataRoot: dir };
	for (let i = 1; i <= PAIR_MAX_PENDING; i += 1) {
		const r = await requestPairing(cfg, { platform: 'feishu', userId: 'u' + i }, { now: () => T0 });
		assert.ok(r.code, `第 ${i} 条应成功`);
	}
	const over = await requestPairing(cfg, { platform: 'feishu', userId: 'u4' }, { now: () => T0 });
	assert.equal(over.throttled, true);
	assert.equal(over.reason, 'too-many-pending');
	// 别的渠道不受影响（配额按平台算）
	const other = await requestPairing(cfg, { platform: 'telegram', userId: 'u4' }, { now: () => T0 });
	assert.ok(other.code);
});

await checkAsync('缺 platform / userId ⇒ 400', async () => {
	await assert.rejects(() => requestPairing(config, { platform: 'feishu' }), (e) => e.httpStatus === 400);
});

/* ── 过期 ───────────────────────────────────────────────────────────────── */
await checkAsync('★ 过期请求被清理，且码不再可批准', async () => {
	const dir = fresh();
	const cfg = { dataRoot: dir };
	const r = await requestPairing(cfg, { platform: 'feishu', userId: 'u9' }, { now: () => T0 });
	const later = T0 + PAIR_TTL_MS + 1;
	const list = await listPairings(cfg, { now: () => later });
	assert.equal(list.requests.length, 0, '过期应被清掉');
	await assert.rejects(
		() => approvePairing(cfg, { code: r.code }, { now: () => later }),
		(e) => e.httpStatus === 404,
	);
});

/* ── 批准 ───────────────────────────────────────────────────────────────── */
await checkAsync('★ 批准：码从待处理移到 DM 白名单（大小写/空格容错）', async () => {
	const dir = fresh();
	const cfg = { dataRoot: dir };
	const r = await requestPairing(cfg, { platform: 'feishu', chatId: 'c7', userId: 'u7', userName: '李四' }, { now: () => T0 });
	const messy = r.code.slice(0, 4).toLowerCase() + ' ' + r.code.slice(4);
	const ap = await approvePairing(cfg, { code: messy, platform: 'feishu' }, { now: () => T0 + 10 });
	assert.equal(ap.userId, 'u7');
	assert.equal(ap.userName, '李四');
	const list = await listPairings(cfg, { now: () => T0 + 20 });
	assert.equal(list.requests.length, 0, '批准后不该还在待处理里');
	assert.equal(list.allowed.length, 1);
	assert.deepEqual(await approvedUserIds(cfg, 'feishu'), ['u7']);
	assert.deepEqual(await approvedUserIds(cfg, 'telegram'), [], '别的平台不该被顺带批准');
});

await checkAsync('★ 同一个码只能批准一次（第二次 404）', async () => {
	const dir = fresh();
	const cfg = { dataRoot: dir };
	const r = await requestPairing(cfg, { platform: 'feishu', userId: 'u8' }, { now: () => T0 });
	await approvePairing(cfg, { code: r.code }, { now: () => T0 + 1 });
	await assert.rejects(() => approvePairing(cfg, { code: r.code }, { now: () => T0 + 2 }), (e) => e.httpStatus === 404);
});

await checkAsync('平台不符 ⇒ 404（防止拿 A 平台的码批 B 平台）', async () => {
	const dir = fresh();
	const cfg = { dataRoot: dir };
	const r = await requestPairing(cfg, { platform: 'feishu', userId: 'u10' }, { now: () => T0 });
	await assert.rejects(
		() => approvePairing(cfg, { code: r.code, platform: 'telegram' }, { now: () => T0 }),
		(e) => e.httpStatus === 404,
	);
});

await checkAsync('空码 ⇒ 400', async () => {
	await assert.rejects(() => approvePairing(config, { code: '   ' }), (e) => e.httpStatus === 400);
});

/* ── 撤销 ───────────────────────────────────────────────────────────────── */
await checkAsync('★ 撤销只删该平台该用户（不误伤别人）', async () => {
	const dir = fresh();
	const cfg = { dataRoot: dir };
	const a = await requestPairing(cfg, { platform: 'feishu', userId: 'a1' }, { now: () => T0 });
	const b = await requestPairing(cfg, { platform: 'feishu', userId: 'b1' }, { now: () => T0 });
	await approvePairing(cfg, { code: a.code }, { now: () => T0 });
	await approvePairing(cfg, { code: b.code }, { now: () => T0 });
	const r = await revokePairing(cfg, { platform: 'feishu', userId: 'a1' });
	assert.equal(r.removed, 1);
	assert.deepEqual(await approvedUserIds(cfg, 'feishu'), ['b1']);
});

/* ── 存储 ───────────────────────────────────────────────────────────────── */
await checkAsync('文件落在 dataRoot 下（便于排查/手工清除）', async () => {
	assert.ok(pairingPathOf(config).endsWith('agent-im-pairing.json'));
});

try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ DM 配对单测（OpenClaw 同构）${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
