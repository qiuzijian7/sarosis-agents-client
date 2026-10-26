// @vssaros/dsh-agents — IM 绑定：纯函数 + 存储 CRUD 单测（P0，2026-10-27）
//   跑法：node dsh-plugins/vssaros-agents/test/bindings.test.mjs
//
// 为什么要单测：绑定的三条策略**全是安全默认**（fail-closed 白名单、只认 @、只有人能绑），
//   写错的后果是"外部 IM 能驱动你的 bot"或"绑了却谁都不理"。这类错在真机上很难复现。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	BINDING_MENTION_POLICIES, BINDING_PLATFORMS, createBinding, deleteBinding,
	findBindingForChat, findOutboundBindings, inboundKeyOf, listBindings, normalizeBinding,
	readBindings, shouldAcceptInbound, splitOutbound, updateBinding,
} from '../lib/bindings.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
	try { fn(); pass += 1; }
	catch (e) { fails.push(`${name} → ${String((e && e.message) || e).split('\n')[0]}`); }
};
const checkAsync = async (name, fn) => {
	try { await fn(); pass += 1; }
	catch (e) { fails.push(`${name} → ${String((e && e.message) || e).split('\n')[0]}`); }
};

const AGENTS = [
	{ id: 'coder', name: 'Coder', presetId: 'vssaros-coder' },
	{ id: 'architect', name: 'Code Architect', presetId: 'vssaros-architect' },
];
const deps = {
	scanAgents: async () => ({ agents: AGENTS }),
	groupExists: async (_cfg, id) => id === 'g1',
};

/* ── normalizeBinding ─────────────────────────────────────────────────── */
check('缺省值：loopback / agent / p2p / both / at / 启用', () => {
	const b = normalizeBinding({ targetId: 'coder' });
	assert.equal(b.platform, 'loopback');
	assert.equal(b.targetKind, 'agent');
	assert.equal(b.chatType, 'p2p');
	assert.equal(b.direction, 'both');
	assert.equal(b.mentionPolicy, 'at');
	assert.equal(b.enabled, true, '新建默认启用');
	assert.deepEqual(b.allowFrom, []);
});
check('★ 非法值一律回落（不因为写错一个词就把策略放开）', () => {
	const b = normalizeBinding({ targetId: 'coder', platform: 'telegram', direction: 'up', mentionPolicy: 'x' });
	assert.ok(BINDING_PLATFORMS.includes(b.platform), b.platform);
	assert.equal(b.direction, 'both');
	assert.ok(BINDING_MENTION_POLICIES.includes(b.mentionPolicy));
});
check('allowFrom 支持逗号串与数组，并去空', () => {
	assert.deepEqual(normalizeBinding({ targetId: 'c', allowFrom: ' u1 , u2 ,,' }).allowFrom, ['u1', 'u2']);
	assert.deepEqual(normalizeBinding({ targetId: 'c', allowFrom: ['u3'] }).allowFrom, ['u3']);
});
check('dispatchMode 接受 turn 别名（→ followup）', () => {
	assert.equal(normalizeBinding({ targetId: 'c', dispatchMode: 'turn' }).dispatchMode, 'followup');
	assert.equal(normalizeBinding({ targetId: 'c' }).dispatchMode, 'steer');
});
check('局部更新：只改给的字段，其余保留', () => {
	const cur = normalizeBinding({ targetId: 'coder', platform: 'feishu', chatId: 'oc_1', allowFrom: ['u1'] });
	const next = normalizeBinding({ enabled: false }, cur);
	assert.equal(next.platform, 'feishu');
	assert.equal(next.chatId, 'oc_1');
	assert.deepEqual(next.allowFrom, ['u1']);
	assert.equal(next.enabled, false);
});

/* ── shouldAcceptInbound（五道判定）──────────────────────────────────── */
const BASE = normalizeBinding({ targetId: 'coder', chatId: 'c1', allowFrom: ['u1'] });
check('放行：私聊 + 白名单命中', () => {
	assert.deepEqual(shouldAcceptInbound(BASE, { userId: 'u1', chatType: 'p2p' }), { ok: true, reason: 'ok' });
});
check('★ 停用 ⇒ disabled', () => {
	assert.equal(shouldAcceptInbound({ ...BASE, enabled: false }, { userId: 'u1' }).reason, 'disabled');
});
check('方向只出不进 ⇒ direction', () => {
	assert.equal(shouldAcceptInbound({ ...BASE, direction: 'out' }, { userId: 'u1' }).reason, 'direction');
});
check('★ 白名单为空 ⇒ no-whitelist（fail-closed，与 channels 同口径）', () => {
	assert.equal(shouldAcceptInbound({ ...BASE, allowFrom: [] }, { userId: 'u1' }).reason, 'no-whitelist');
});
check('★ 发送者不在白名单 ⇒ sender', () => {
	assert.equal(shouldAcceptInbound(BASE, { userId: 'u2' }).reason, 'sender');
});
check('★ 群聊 + 只认 @ + 没 @ ⇒ no-mention', () => {
	assert.equal(shouldAcceptInbound({ ...BASE, chatType: 'group' }, { userId: 'u1', chatType: 'group' }).reason, 'no-mention');
});
check('群聊 + 只认 @ + 有 @ ⇒ 放行', () => {
	assert.equal(shouldAcceptInbound({ ...BASE, chatType: 'group' }, { userId: 'u1', chatType: 'group', mentionsBot: true }).reason, 'ok');
});
check('群聊 + 全部消息 ⇒ 不需要 @', () => {
	assert.equal(shouldAcceptInbound({ ...BASE, chatType: 'group', mentionPolicy: 'all' }, { userId: 'u1', chatType: 'group' }).reason, 'ok');
});
check('空 binding 不抛（返回 disabled）', () => {
	assert.equal(shouldAcceptInbound(undefined, { userId: 'u1' }).reason, 'disabled');
});

/* ── 幂等键 ─────────────────────────────────────────────────────────── */
check('messageId 优先；缺了退化成指纹（同人同前缀内容视为重复）', () => {
	assert.equal(inboundKeyOf({ platform: 'feishu', messageId: 'om_1' }), 'feishu:om_1');
	const a = inboundKeyOf({ platform: 'feishu', userId: 'u1', content: 'hello world 1234' });
	const b = inboundKeyOf({ platform: 'feishu', userId: 'u1', content: 'hello world 1234' });
	assert.equal(a, b);
	assert.notEqual(a, inboundKeyOf({ platform: 'feishu', userId: 'u2', content: 'hello world 1234' }));
});

/* ── 出站分段 ───────────────────────────────────────────────────────── */
check('短文本 ⇒ 1 段；空文本 ⇒ 0 段', () => {
	assert.deepEqual(splitOutbound('hi'), ['hi']);
	assert.deepEqual(splitOutbound(''), []);
	assert.deepEqual(splitOutbound(null), []);
});
check('★ 超长按换行切，且总长不丢字', () => {
	const line = 'x'.repeat(50);
	const text = Array.from({ length: 200 }, () => line).join('\n');   // 10k+
	const segs = splitOutbound(text, 3000);
	assert.ok(segs.length >= 3, `段数=${segs.length}`);
	assert.ok(segs.every((s) => s.length <= 3000), '每段都不能超限');
	assert.equal(segs.join('').length, text.length, '拼回去必须一字不差');
});
check('没有换行也硬切（不会返回一段超长文本）', () => {
	const segs = splitOutbound('y'.repeat(100), 30);
	assert.ok(segs.every((s) => s.length <= 30));
	assert.equal(segs.join('').length, 100);
});

/* ── 查找 ───────────────────────────────────────────────────────────── */
check('按 (platform, chatId) 找绑定', () => {
	const list = [normalizeBinding({ targetId: 'a', chatId: 'c1' }), normalizeBinding({ targetId: 'b', chatId: 'c2' })];
	assert.equal(findBindingForChat(list, 'loopback', 'c2').targetId, 'b');
	assert.equal(findBindingForChat(list, 'loopback', 'nope'), null);
	assert.equal(findBindingForChat(list, 'feishu', 'c1'), null, '平台也要匹配');
});
check('★ 出站候选：排除停用与「只进不出」', () => {
	const list = [
		{ ...normalizeBinding({ targetId: 'g1', targetKind: 'group', chatId: 'a' }) },
		{ ...normalizeBinding({ targetId: 'g1', targetKind: 'group', chatId: 'b' }), enabled: false },
		{ ...normalizeBinding({ targetId: 'g1', targetKind: 'group', chatId: 'c' }), direction: 'in' },
	];
	const hit = findOutboundBindings(list, 'group', 'g1');
	assert.deepEqual(hit.map((b) => b.chatId), ['a']);
});

/* ── 存储 CRUD（临时 dataRoot，不碰真机数据）────────────────────────── */
const root = mkdtempSync(join(tmpdir(), 'vssaros-bind-'));
const config = { dataRoot: root };

await checkAsync('★ 新建：写入文件，且列表带回 targetName', async () => {
	const r = await createBinding(config, { targetKind: 'agent', targetId: 'coder', chatId: 'oc_a', allowFrom: ['u1'] }, deps);
	assert.equal(r.bindings.length, 1);
	const onDisk = await readBindings(config);
	assert.equal(onDisk.length, 1);
	const listed = await listBindings(config, deps);
	assert.equal(listed.bindings[0].targetName, 'Coder');
});
await checkAsync('★ 只有人能建（bot 建 ⇒ 403）', async () => {
	await assert.rejects(
		() => createBinding(config, { targetKind: 'agent', targetId: 'coder', chatId: 'oc_x', allowFrom: ['u1'], actor: { kind: 'bot', agentId: 'coder' } }, deps),
		(e) => e.httpStatus === 403,
	);
});
await checkAsync('★ 同一个 IM 会话不能绑两次（否则入站不知道给谁）', async () => {
	await assert.rejects(
		() => createBinding(config, { targetKind: 'agent', targetId: 'architect', chatId: 'oc_a', allowFrom: ['u1'] }, deps),
		(e) => e.httpStatus === 409,
	);
});
await checkAsync('目标不存在 ⇒ 400', async () => {
	await assert.rejects(
		() => createBinding(config, { targetKind: 'agent', targetId: 'ghost', chatId: 'oc_b', allowFrom: ['u1'] }, deps),
		(e) => e.httpStatus === 400,
	);
});
await checkAsync('局部更新生效，且不破坏唯一性', async () => {
	const before = (await readBindings(config))[0];
	const r = await updateBinding(config, { id: before.id, enabled: false, chatName: '研发群' }, deps);
	assert.equal(r.binding.enabled, false);
	assert.equal(r.binding.chatName, '研发群');
	assert.equal(r.binding.chatId, 'oc_a', '没给的字段要保留');
});
await checkAsync('按 id 删除 / 按 (platform, chatId) 删除', async () => {
	const cur = await readBindings(config);
	assert.equal(cur.length, 1);
	const r1 = await deleteBinding(config, { platform: 'loopback', chatId: 'oc_a' });
	assert.equal(r1.removed, 1);
	await assert.rejects(() => deleteBinding(config, { platform: 'loopback', chatId: 'oc_a' }), (e) => e.httpStatus === 404);
});

/* ── 飞书传输层校验 + 密钥不外泄（P1）────────────────────────────────── */
await checkAsync('★ 飞书绑定没配 webhookUrl ⇒ 400（不能"以为绑好了"却发不出去）', async () => {
	await assert.rejects(
		() => createBinding(config, { targetKind: 'agent', targetId: 'coder', chatId: 'oc_f1', platform: 'feishu', allowFrom: ['u1'] }, deps),
		(e) => e.httpStatus === 400 && /webhookUrl/.test(e.message),
	);
});
await checkAsync('webhookUrl 不是 http(s) ⇒ 400', async () => {
	await assert.rejects(
		() => createBinding(config, { targetKind: 'agent', targetId: 'coder', chatId: 'oc_f2', platform: 'feishu', webhookUrl: 'ftp://x', allowFrom: ['u1'] }, deps),
		(e) => e.httpStatus === 400,
	);
});
await checkAsync('★ 列表**永不返回** webhookSecret，只给 hasSecret', async () => {
	const r = await createBinding(config, {
		targetKind: 'agent', targetId: 'architect', chatId: 'oc_f3', platform: 'feishu',
		webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', webhookSecret: 'top-secret', allowFrom: ['u1'],
	}, deps);
	const listed = await listBindings(config, deps);
	const one = listed.bindings.find((b) => b.id === r.binding.id);
	assert.equal(one.webhookSecret, undefined, '密钥不能出现在响应里');
	assert.equal(one.hasSecret, true);
	assert.equal(one.webhookUrl, 'https://open.feishu.cn/open-apis/bot/v2/hook/x');
	// 但磁盘上要有（出站要用）
	const onDisk = (await readBindings(config)).find((b) => b.id === r.binding.id);
	assert.equal(onDisk.webhookSecret, 'top-secret');
});
await checkAsync('更新时「密钥留空」= 保留原值（不是清除）', async () => {
	const cur = (await readBindings(config)).find((b) => b.chatId === 'oc_f3');
	const r = await updateBinding(config, { id: cur.id, chatName: '只改名字' }, deps);
	assert.equal(r.binding.webhookSecret, 'top-secret', '没给 webhookSecret 就该保留');
	// 显式给空串才算清除
	const r2 = await updateBinding(config, { id: cur.id, webhookSecret: '' }, deps);
	assert.equal(r2.binding.webhookSecret, '');
});

try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }

/* ── 汇总 ──────────────────────────────────────────────────────────── */
const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ IM 绑定单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
