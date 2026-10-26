// @vssaros/dsh-agents — 飞书入站骨架 + 跨重启幂等（P2，2026-10-27）
//   跑法：node dsh-plugins/vssaros-agents/test/feishu-inbound.test.mjs
//
// 为什么单测（还没凭据）：
//   · 解析层写错的后果是**静默丢消息**（比如把群消息当私聊、把 @ 占位符留在正文里）
//   · 防环写错的后果是 **IM→bot→IM 自激**（我们自己的消息被当用户输入）
//   · 幂等只在内存 ⇒ Host 重启后同一条被回两遍，看起来像"重复 bot"
// 这三条都能在没有网络的情况下钉死，所以先钉死再等凭据。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	createFeishuGateway, createSdkTransport, parseFeishuEvent, stripAtPlaceholders, textOfContent,
} from '../lib/adapters/feishuInbound.js';
import { flushInboundSeen, markInboundSeen, resetInboundSeenCache, seenPathOf } from '../lib/imSeen.js';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 文本抽取 ─────────────────────────────────────────────────────────── */
check('@ 占位符被去掉，且不留多余空格', () => {
	assert.equal(stripAtPlaceholders('@_user_1 你好  @_user_2  world'), '你好 world');
});
check('content 是 JSON 字符串 ⇒ 取 text', () => {
	assert.equal(textOfContent('{"text":"@_user_1 帮我看下"}'), '帮我看下');
});
check('content 不是 JSON ⇒ 原样返回（不抛）', () => {
	assert.equal(textOfContent('裸文本'), '裸文本');
	assert.equal(textOfContent(''), '');
	assert.equal(textOfContent(undefined), '');
});

/* ── 事件解析 ─────────────────────────────────────────────────────────── */
const wrap = (event, type = 'im.message.receive_v1') => ({ header: { event_type: type }, event });

check('challenge 走单独分支（HTTP 校验用）', () => {
	assert.deepEqual(parseFeishuEvent({ challenge: 'abc' }), { kind: 'challenge', challenge: 'abc' });
});
check('非 im.message.receive_v1 ⇒ ignore 并写明原因', () => {
	const r = parseFeishuEvent(wrap({}, 'im.chat.updated_v1'));
	assert.equal(r.kind, 'ignore');
	assert.match(r.reason, /unsupported-event/);
});
check('★ sender_type=app ⇒ 丢弃（防环：我们自己的消息不能回灌）', () => {
	const r = parseFeishuEvent(wrap({
		sender: { sender_type: 'app', sender_id: { open_id: 'ou_bot' } },
		message: { chat_id: 'oc_1', message_id: 'om_1', chat_type: 'group', message_type: 'text', content: '{"text":"hi"}' },
	}));
	assert.deepEqual(r, { kind: 'ignore', reason: 'from-app' });
});
check('缺 chat_id / message_id ⇒ ignore', () => {
	const r = parseFeishuEvent(wrap({ sender: { sender_type: 'user' }, message: { message_type: 'text', content: '{"text":"x"}' } }));
	assert.equal(r.reason, 'missing-chat-or-message-id');
});
check('非文本消息 ⇒ ignore（P2 只处理文本，别当成空消息塞进去）', () => {
	const r = parseFeishuEvent(wrap({
		sender: { sender_type: 'user' },
		message: { chat_id: 'oc_1', message_id: 'om_2', message_type: 'image', content: '{}' },
	}));
	assert.match(r.reason, /unsupported-message-type:image/);
});
check('空正文 ⇒ ignore', () => {
	const r = parseFeishuEvent(wrap({
		sender: { sender_type: 'user' },
		message: { chat_id: 'oc_1', message_id: 'om_3', message_type: 'text', content: '{"text":"@_user_1"}' },
	}));
	assert.equal(r.reason, 'empty-text');
});
check('★ 私聊消息：字段齐（platform/chatId/messageId/userId/正文已去占位符）', () => {
	const r = parseFeishuEvent(wrap({
		sender: { sender_type: 'user', sender_id: { open_id: 'ou_u1', union_id: '张三' } },
		message: { chat_id: 'oc_dm', message_id: 'om_4', chat_type: 'p2p', message_type: 'text', content: '{"text":"你好"}' },
	}));
	assert.equal(r.kind, 'message');
	assert.equal(r.msg.platform, 'feishu');
	assert.equal(r.msg.chatType, 'p2p');
	assert.equal(r.msg.chatId, 'oc_dm');
	assert.equal(r.msg.messageId, 'om_4');
	assert.equal(r.msg.userId, 'ou_u1');
	assert.equal(r.msg.content, '你好');
	assert.equal(r.msg.mentionsBot, false);
});
check('★ 群聊里没 @ ⇒ mentionsBot=false（交给策略层决定不处理）', () => {
	const r = parseFeishuEvent(wrap({
		sender: { sender_type: 'user', sender_id: { open_id: 'ou_u1' } },
		message: { chat_id: 'oc_g', message_id: 'om_5', chat_type: 'group', message_type: 'text', content: '{"text":"大家好"}' },
	}));
	assert.equal(r.msg.chatType, 'group');
	assert.equal(r.msg.mentionsBot, false);
});
check('★ 群聊里 @ 了 ⇒ mentionsBot=true，且占位符已从正文去掉', () => {
	const r = parseFeishuEvent(wrap({
		sender: { sender_type: 'user', sender_id: { open_id: 'ou_u1' } },
		message: {
			chat_id: 'oc_g', message_id: 'om_6', chat_type: 'group', message_type: 'text',
			content: '{"text":"@_user_1 帮我看下这个报错"}',
			mentions: [{ key: '@_user_1', name: 'Coder', id: { open_id: 'ou_bot' } }],
		},
	}));
	assert.equal(r.msg.mentionsBot, true);
	assert.equal(r.msg.content, '帮我看下这个报错');
	assert.equal(r.msg.mentions.length, 1);
	assert.equal(r.msg.mentions[0].openId, 'ou_bot');
});

/* ── 网关：连接 / 事件 / 重连 / 停止 ─────────────────────────────────── */
await checkAsync('★ 收到事件 ⇒ 解析后交给 onMessage；app 消息不交', async () => {
	const got = [];
	let emit = () => undefined;
	const gw = createFeishuGateway({
		transport: { start: async ({ onEvent }) => { emit = onEvent; return { close: () => undefined }; } },
		onMessage: (m) => got.push(m),
		log: () => undefined,
	});
	await gw.start();
	assert.equal(gw.state().status, 'ready');
	emit(wrap({ sender: { sender_type: 'user', sender_id: { open_id: 'u' } }, message: { chat_id: 'c', message_id: 'm1', chat_type: 'p2p', message_type: 'text', content: '{"text":"1"}' } }));
	emit(wrap({ sender: { sender_type: 'app' }, message: { chat_id: 'c', message_id: 'm2', chat_type: 'p2p', message_type: 'text', content: '{"text":"2"}' } }));
	await sleep(20);
	assert.equal(got.length, 1, '只应收到用户那条');
	await gw.stop();
	assert.equal(gw.state().status, 'stopped');
});
await checkAsync('★ transport 起不来 ⇒ 退避重试；stop 后不再重试', async () => {
	let tries = 0;
	const gw = createFeishuGateway({
		transport: { start: async () => { tries += 1; throw new Error('unavailable：没装 SDK'); } },
		onMessage: () => undefined,
		log: () => undefined,
		baseDelayMs: 5,
		maxDelayMs: 20,
	});
	await gw.start();
	await sleep(80);
	assert.ok(tries >= 2, `应至少重试 2 次，实际 ${tries}`);
	const before = tries;
	await gw.stop();
	await sleep(60);
	assert.equal(tries, before, 'stop 之后不许再重连');
	assert.equal(gw.state().status, 'stopped');
});
await checkAsync('★ SDK transport 缺凭据 ⇒ 明确 unavailable（不假装在连）', async () => {
	const t = createSdkTransport({ appId: '', appSecret: '' });
	await assert.rejects(() => t.start({}), /unavailable：缺少 app_id/);
});
await checkAsync('★ SDK 没装 ⇒ unavailable 并给出安装指引', async () => {
	const t = createSdkTransport({ appId: 'a', appSecret: 'b', importSdk: async () => { throw new Error('MODULE_NOT_FOUND'); } });
	await assert.rejects(() => t.start({}), /未安装 @larksuiteoapi\/node-sdk/);
});

/* ── 跨重启幂等 ───────────────────────────────────────────────────────── */
const root = mkdtempSync(join(tmpdir(), 'vssaros-seen-'));
const config = { dataRoot: root };

await checkAsync('★ 首次为 true，重复为 false', async () => {
	resetInboundSeenCache();
	assert.equal(await markInboundSeen(config, 'feishu:om_1'), true);
	assert.equal(await markInboundSeen(config, 'feishu:om_1'), false);
	assert.equal(await markInboundSeen(config, 'feishu:om_2'), true);
});
await checkAsync('★ 落盘后"重启"（清内存缓存）仍认得旧键', async () => {
	await markInboundSeen(config, 'feishu:om_persist');
	await flushInboundSeen(config);
	resetInboundSeenCache();   // 模拟 Host 重启：内存没了，文件还在
	assert.equal(await markInboundSeen(config, 'feishu:om_persist'), false, '重启后必须仍认为是重复');
	assert.equal(await markInboundSeen(config, 'feishu:om_new'), true);
});
await checkAsync('空键不记（避免把脏输入写进文件）', async () => {
	assert.equal(await markInboundSeen(config, ''), true);
	assert.equal(await markInboundSeen(config, ''), true);
});
check('幂等文件就在 dataRoot 下（便于排查/手工清）', () => {
	assert.ok(seenPathOf(config).endsWith('agent-im-seen.json'), seenPathOf(config));
});

try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }

/* ── 汇总 ──────────────────────────────────────────────────────────── */
const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 飞书入站单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
