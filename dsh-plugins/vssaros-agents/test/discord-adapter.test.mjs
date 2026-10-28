// @vssaros/dsh-agents — Discord 适配器单测（2026-10-27）
//   跑法：node dsh-plugins/vssaros-agents/test/discord-adapter.test.mjs
//
// 为什么要测这一层：Discord 的坑都在协议细节上，且**真机很难复现**：
//   · MESSAGE_CONTENT 没开 ⇒ content 为空（消息收到了但正文全空）—— 必须 ignore 且能说清原因
//   · `author.bot` 不挡 ⇒ 两个 bot 互刷（防环第一道）
//   · WS 的 stop / 重连写错 ⇒ 界面显示"已连接"但实际不再收消息（Telegram 那次踩过）
// 这些用假 transport 全都能跑，不需要真的 token。
import assert from 'node:assert/strict';

import {
	DISCORD_INTENTS, DISCORD_INTENT_PARTS,
	createDiscordAdapter, createDiscordGateway, parseDiscordMessage,
} from '../lib/adapters/discord.js';
import { imageMediaTypeOfFile } from '../lib/adapters/media.js';

let pass = 0;
const fails = [];
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

/* ══ 解析 ═══════════════════════════════════════════════════════════════ */

const guildMsg = {
	id: 'm1', channel_id: 'c1', guild_id: 'g1', content: '帮我看下这个报错',
	author: { id: 'u1', username: 'zhangsan', global_name: '张三', bot: false },
	mentions: [{ id: 'bot-1', username: 'mybot', bot: true }],
	referenced_message: null,
};

check('★ 群消息 ⇒ chatType=group，字段映射正确', () => {
	const r = parseDiscordMessage(guildMsg, { botUserId: 'bot-1' });
	assert.equal(r.ignored, false);
	assert.equal(r.msg.platform, 'discord');
	assert.equal(r.msg.chatType, 'group');
	assert.equal(r.msg.chatId, 'c1');
	assert.equal(r.msg.guildId, 'g1');
	assert.equal(r.msg.userId, 'u1');
	assert.equal(r.msg.userName, '张三', 'global_name 优先于 username');
	assert.equal(r.msg.content, '帮我看下这个报错');
	assert.equal(r.msg.mentionsBot, true);
});

check('★ 私聊（无 guild_id）⇒ chatType=p2p', () => {
	const dm = { ...guildMsg, guild_id: undefined, channel_id: 'dm1' };
	const r = parseDiscordMessage(dm, { botUserId: 'bot-1' });
	assert.equal(r.msg.chatType, 'p2p');
	assert.equal(r.msg.chatId, 'dm1');
});

check('★ author.bot ⇒ from-bot（防环第一道）', () => {
	const r = parseDiscordMessage({ ...guildMsg, author: { id: 'b2', username: 'other', bot: true } }, {});
	assert.equal(r.ignored, true);
	assert.equal(r.reason, 'from-bot');
});

check('★ content 为空 ⇒ empty-content + 说明（大概率是没开 MESSAGE_CONTENT）', () => {
	const r = parseDiscordMessage({ ...guildMsg, content: '' }, { botUserId: 'bot-1' });
	assert.equal(r.ignored, true);
	assert.equal(r.reason, 'empty-content');
	assert.ok(String(r.note).includes('MESSAGE_CONTENT'), '提示里要点出最常见的那个原因');
});

check('★ 填了 botUserId ⇒ @别人的 bot 不算叫我', () => {
	const other = { ...guildMsg, mentions: [{ id: 'bot-9', username: 'otherbot', bot: true }] };
	assert.equal(parseDiscordMessage(other, { botUserId: 'bot-1' }).msg.mentionsBot, false);
	assert.equal(parseDiscordMessage(other, {}).msg.mentionsBot, true, '没填 botUserId 时退回"有 mention 即算"');
});

check('★ 引用了 bot 的消息 ⇒ repliesToBot', () => {
	const r = parseDiscordMessage({
		...guildMsg,
		referenced_message: { id: 'old', author: { id: 'bot-1', bot: true } },
	}, { botUserId: 'bot-1' });
	assert.equal(r.msg.repliesToBot, true);
});

check('intents 位掩码与常量一致（37377）', () => {
	const sum = Object.values(DISCORD_INTENT_PARTS).reduce((a, b) => a + b, 0);
	assert.equal(sum, DISCORD_INTENTS);
	assert.ok((DISCORD_INTENTS & DISCORD_INTENT_PARTS.MESSAGE_CONTENT) !== 0, '必须含 MESSAGE_CONTENT');
	assert.ok((DISCORD_INTENTS & DISCORD_INTENT_PARTS.DIRECT_MESSAGES) !== 0, '必须含 DIRECT_MESSAGES');
});

/* ══ 出站 ═══════════════════════════════════════════════════════════════ */

await checkAsync('★ 出站：POST /channels/{id}/messages + Bot 头', async () => {
	const calls = [];
	const adapter = createDiscordAdapter({
		resolve: async () => ({ botToken: 'TOK' }),
		fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '{}' }; },
	});
	const r = await adapter.send({ chatId: 'c1' }, '你好');
	assert.equal(r.ok, true);
	assert.equal(adapter.id, 'discord');
	assert.ok(calls[0].url.startsWith('https://discord.com/api/v10/channels/c1/messages'), calls[0].url);
	assert.equal(calls[0].init.headers.authorization, 'Bot TOK');
	assert.equal(JSON.parse(calls[0].init.body).content, '你好');
});

await checkAsync('没 token ⇒ unavailable（不假装发出去）', async () => {
	const adapter = createDiscordAdapter({ resolve: async () => ({}), fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
	await assert.rejects(() => adapter.send({ chatId: 'c1' }, 'x'), /unavailable：缺少 Bot Token/);
});

await checkAsync('★ 429 ⇒ 抛错并带 retry_after（不静默重试）', async () => {
	const adapter = createDiscordAdapter({
		resolve: async () => ({ botToken: 'T' }),
		fetchImpl: async () => ({ ok: false, status: 429, text: async () => '{"retry_after":2.5}' }),
	});
	await assert.rejects(() => adapter.send({ chatId: 'c1' }, 'x'), /retry_after=2\.5s/);
});

await checkAsync('空文本 ⇒ skipped（不发请求）', async () => {
	let called = 0;
	const adapter = createDiscordAdapter({
		resolve: async () => ({ botToken: 'T' }),
		fetchImpl: async () => { called += 1; return { ok: true, status: 200, text: async () => '{}' }; },
	});
	const r = await adapter.send({ chatId: 'c1' }, '   ');
	assert.equal(r.skipped, 'empty');
	assert.equal(called, 0);
});

/* ══ 网关（假 transport）═════════════════════════════════════════════════ */

/** 假 WebSocket 传输：不连网络，手动推帧。 */
function makeFakeTransport() {
	let handlers = null;
	const sent = [];
	const urls = [];
	return {
		available: true,
		create(h) {
			handlers = h;
			urls.push(h.url);
			return { send: (o) => sent.push(o), close: () => { queueMicrotask(() => handlers.onClose({ code: 1000, reason: 'by test' })); } };
		},
		push(frame) { handlers.onFrame(frame); },
		closeWith(code) { handlers.onClose({ code, reason: 'test' }); },
		sent, urls,
	};
}

const okFetch = (url) => Promise.resolve({
	ok: true, status: 200,
	text: async () => JSON.stringify({ url: 'wss://gw.test' }),
});

/**
 * 启动网关并推进到「握手完成」。
 *
 * ⚠ `start()` 现在会等到收到 `op=10 HELLO` 才返回（这样 4004/连接失败才能影响 start 的结果）。
 *   所以测试必须**先发起 start、再推 HELLO、最后 await**，不能先 await 再推 —— 那会死等。
 */
async function startWithHello(gw, tp, interval = 41250) {
	const p = gw.start();
	await new Promise((r) => setTimeout(r, 5));
	tp.push({ op: 10, d: { heartbeat_interval: interval } });
	await p;
}

await checkAsync('★ HELLO ⇒ 发 IDENTIFY（op2 + intents + token）', async () => {
	const tp = makeFakeTransport();
	const gw = createDiscordGateway({
		transport: tp, fetchImpl: okFetch, resolve: async () => ({ botToken: 'TOK' }),
		onMessage: async () => undefined, sleep: () => new Promise(() => {}),
	});
	/* start 会等到 HELLO 才返回 ⇒ 先发起、再断言 url、推 HELLO、最后 await */
	const starting = gw.start();
	await new Promise((r) => setTimeout(r, 5));
	assert.ok(tp.urls[0].startsWith('wss://gw.test'), tp.urls[0]);
	tp.push({ op: 10, d: { heartbeat_interval: 41250 } });
	await starting;
	await new Promise((r) => setTimeout(r, 10));
	const identify = tp.sent.find((f) => f.op === 2);
	assert.ok(identify, '应当发出 IDENTIFY：' + JSON.stringify(tp.sent));
	assert.equal(identify.d.token, 'TOK');
	assert.equal(identify.d.intents, DISCORD_INTENTS);
	await gw.stop();
});

await checkAsync('★ READY ⇒ ready + botUserId；MESSAGE_CREATE ⇒ onMessage', async () => {
	const tp = makeFakeTransport();
	const got = [];
	const gw = createDiscordGateway({
		transport: tp, fetchImpl: okFetch, resolve: async () => ({ botToken: 'TOK' }),
		onMessage: async (m) => { got.push(m); }, sleep: () => new Promise(() => {}),
	});
	await startWithHello(gw, tp);
	tp.push({ op: 0, s: 1, t: 'READY', d: { user: { id: 'bot-1' }, session_id: 'sess' } });
	assert.equal(gw.state().status, 'ready');
	tp.push({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: guildMsg });
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(got.length, 1);
	assert.equal(got[0].mentionsBot, true, 'READY 里拿到的 botUserId 应当用于 @ 判定');
	assert.ok(gw.state().lastEventAt > 0);
	await gw.stop();
});

await checkAsync('★ content 空的消息不进 onMessage（但要能查原因）', async () => {
	const tp = makeFakeTransport();
	const got = [];
	const logs = [];
	const gw = createDiscordGateway({
		transport: tp, fetchImpl: okFetch, resolve: async () => ({ botToken: 'TOK' }),
		onMessage: async (m) => { got.push(m); }, log: (m) => logs.push(m), sleep: () => new Promise(() => {}),
	});
	await startWithHello(gw, tp);
	tp.push({ op: 0, s: 1, t: 'READY', d: { user: { id: 'bot-1' } } });
	tp.push({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { ...guildMsg, content: '' } });
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(got.length, 0);
	assert.ok(logs.some((l) => String(l).includes('empty-content')), '要在日志里说清原因：' + JSON.stringify(logs));
	await gw.stop();
});

await checkAsync('★ onMessage 抛错不断连接', async () => {
	const tp = makeFakeTransport();
	let calls = 0;
	const gw = createDiscordGateway({
		transport: tp, fetchImpl: okFetch, resolve: async () => ({ botToken: 'TOK' }),
		onMessage: async () => { calls += 1; throw new Error('boom'); },
		log: () => undefined, sleep: () => new Promise(() => {}),
	});
	await startWithHello(gw, tp);
	tp.push({ op: 0, s: 1, t: 'READY', d: { user: { id: 'bot-1' } } });
	tp.push({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: guildMsg });
	await new Promise((r) => setTimeout(r, 10));
	tp.push({ op: 0, s: 3, t: 'MESSAGE_CREATE', d: guildMsg });
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(calls, 2, '第一条抛错后第二条仍应被处理');
	await gw.stop();
});

await checkAsync('★ stop() ⇒ stopped（不给"显示已连接但其实不收"留口子）', async () => {
	const tp = makeFakeTransport();
	const gw = createDiscordGateway({
		transport: tp, fetchImpl: okFetch, resolve: async () => ({ botToken: 'TOK' }),
		onMessage: async () => undefined, sleep: () => new Promise(() => {}),
	});
	await startWithHello(gw, tp);
	tp.push({ op: 0, s: 1, t: 'READY', d: { user: { id: 'bot-1' } } });
	assert.equal(gw.state().status, 'ready');
	await gw.stop();
	assert.equal(gw.state().status, 'stopped');
});

await checkAsync('★ 4004（鉴权失败）⇒ start 抛错（不重试）', async () => {
	const tp = makeFakeTransport();
	const gw = createDiscordGateway({
		transport: tp, fetchImpl: okFetch, resolve: async () => ({ botToken: 'BAD' }),
		onMessage: async () => undefined, sleep: () => new Promise(() => {}),
	});
	const p = gw.start();
	/* ⚠ 必须先等 fetch(/gateway/bot) 与 transport.create 完成，否则 handlers 还是 null，
	   closeWith 会打在空对象上（这正是第一版测试报错了的地方，不是实现的问题） */
	await new Promise((r) => setTimeout(r, 10));
	tp.closeWith(4004);
	await assert.rejects(() => p, /鉴权失败（4004）/);
	assert.equal(gw.state().status, 'error');
});

await checkAsync('拿不到 gateway 地址 ⇒ start 抛（不假装在连）', async () => {
	const tp = makeFakeTransport();
	const gw = createDiscordGateway({
		transport: tp,
		fetchImpl: async () => ({ ok: false, status: 401, text: async () => '401: Unauthorized' }),
		resolve: async () => ({ botToken: 'T' }),
		onMessage: async () => undefined, sleep: () => new Promise(() => {}),
	});
	await assert.rejects(() => gw.start(), /拿 gateway 地址失败：HTTP 401/);
});

/* ── 富媒体（2026-10-27）：Discord 附件是公开 CDN url，直接 fetch ──────────── */

check('imageMediaTypeOfFile：mime 优先，退回扩展名，都不认识就不猜', () => {
	assert.equal(imageMediaTypeOfFile('image/png', ''), 'image/png');
	assert.equal(imageMediaTypeOfFile('', 'shot.JPG'), 'image/jpeg');
	assert.equal(imageMediaTypeOfFile('', 'a.jpeg'), 'image/jpeg');
	assert.equal(imageMediaTypeOfFile('', 'a.png'), 'image/png');
	assert.equal(imageMediaTypeOfFile('image/webp', 'a.png'), '', 'mime 明确不支持时不该被扩展名救回来… ');
	assert.equal(imageMediaTypeOfFile('', 'a.pdf'), '');
	assert.equal(imageMediaTypeOfFile('', ''), '');
});

check('★ 带图片附件 ⇒ 收进 attachments；非图片不收', () => {
	const withImg = {
		...guildMsg, content: '',
		attachments: [
			{ id: 'a1', filename: 'shot.png', content_type: 'image/png', size: 1234, url: 'https://cdn.discordapp.com/x.png' },
			{ id: 'a2', filename: 'doc.pdf', content_type: 'application/pdf', size: 999, url: 'https://cdn.discordapp.com/y.pdf' },
		],
	};
	const r = parseDiscordMessage(withImg, { botUserId: 'bot-1' });
	assert.equal(r.ignored, false, '纯图片消息不该被当成"空内容"丢掉');
	assert.equal(r.msg.attachments.length, 1);
	assert.equal(r.msg.attachments[0].mimeType, 'image/png');
	assert.equal(r.msg.attachments[0].url, 'https://cdn.discordapp.com/x.png');
	assert.equal(r.msg.content, '[图片]', '没有文本时给占位');
});

check('★ 防环优先：bot 发的带图消息仍然被丢', () => {
	const r = parseDiscordMessage({
		...guildMsg, content: '',
		author: { id: 'b2', username: 'other', bot: true },
		attachments: [{ id: 'a1', filename: 'x.png', content_type: 'image/png', url: 'https://cdn/x.png' }],
	}, { botUserId: 'bot-1' });
	assert.equal(r.ignored, true);
	assert.equal(r.reason, 'from-bot', '先判 bot 再判内容 —— 两个 bot 互刷图片是最容易出的事故');
});

check('既无文本也无图片 ⇒ 仍是 empty-content（并提示可能是没开 MESSAGE_CONTENT）', () => {
	const r = parseDiscordMessage({ ...guildMsg, content: '', attachments: [] }, { botUserId: 'bot-1' });
	assert.equal(r.reason, 'empty-content');
	assert.ok(String(r.note).includes('MESSAGE_CONTENT'));
});

await checkAsync('★ 网关：图片下载后挂 msg.images（base64 + mediaType）', async () => {
	const tp = makeFakeTransport();
	const got = [];
	let fetched = [];
	const gw = createDiscordGateway({
		transport: tp,
		fetchImpl: async (url) => {
			fetched.push(String(url));
			if (String(url).includes('/gateway/bot')) { return { ok: true, status: 200, text: async () => JSON.stringify({ url: 'wss://gw.test' }) }; }
			return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('png-bytes') };
		},
		resolve: async () => ({ botToken: 'TOK' }),
		onMessage: async (m) => { got.push(m); },
		log: () => undefined, sleep: () => new Promise(() => {}),
	});
	await startWithHello(gw, tp);
	tp.push({ op: 0, s: 1, t: 'READY', d: { user: { id: 'bot-1' } } });
	tp.push({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: {
		...guildMsg, content: '',
		attachments: [{ id: 'a1', filename: 's.png', content_type: 'image/png', url: 'https://cdn/s.png' }],
	} });
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(got.length, 1);
	assert.equal(got[0].images.length, 1);
	assert.equal(got[0].images[0].mediaType, 'image/png');
	assert.equal(Buffer.from(got[0].images[0].data, 'base64').toString(), 'png-bytes');
	assert.ok(fetched.some((u) => u === 'https://cdn/s.png'), '应当真的去下 CDN：' + JSON.stringify(fetched));
	await gw.stop();
});

await checkAsync('★ 下载失败 ⇒ 消息仍派发（只是没有图）', async () => {
	const tp = makeFakeTransport();
	const got = [];
	const gw = createDiscordGateway({
		transport: tp,
		fetchImpl: async (url) => {
			if (String(url).includes('/gateway/bot')) { return { ok: true, status: 200, text: async () => JSON.stringify({ url: 'wss://gw.test' }) }; }
			throw new Error('cdn 502');
		},
		resolve: async () => ({ botToken: 'TOK' }),
		onMessage: async (m) => { got.push(m); },
		log: () => undefined, sleep: () => new Promise(() => {}),
	});
	await startWithHello(gw, tp);
	tp.push({ op: 0, s: 1, t: 'READY', d: { user: { id: 'bot-1' } } });
	tp.push({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: {
		...guildMsg, content: '',
		attachments: [{ id: 'a1', filename: 's.png', content_type: 'image/png', url: 'https://cdn/s.png' }],
	} });
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(got.length, 1, '图片下载失败不该丢掉整条消息');
	assert.equal(got[0].images, undefined);
	assert.equal(got[0].content, '[图片]');
	await gw.stop();
});

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ Discord 适配器单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
