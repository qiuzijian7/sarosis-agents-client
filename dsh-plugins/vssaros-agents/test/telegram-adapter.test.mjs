// @vssaros/dsh-agents — Telegram 适配器单测（2026-10-27）
//   跑法：node dsh-plugins/vssaros-agents/test/telegram-adapter.test.mjs
//
// 这一层没有 SDK 兜底，全靠这几条自己写对：
//   ① 防环：`from.is_bot` 必须丢（两个 bot 在群里会互相触发到打爆额度）
//   ② 偏移量必须推进（否则同一条 update 被反复取到 ⇒ 同一条被回两遍）
//   ③ 出站失败必须抛且带原因（429 的 retry_after 要露出来，不能装成功）
//   ④ 群/私聊与 @ 判定（mentionPolicy='at' 全靠它）
import assert from 'node:assert/strict';

import {
	TELEGRAM_API_ROOT, createHttpTransport, createTelegramAdapter, createTelegramGateway, imageMediaTypeOf, parseTelegramUpdate,
} from '../lib/adapters/telegram.js';

let pass = 0;
const fails = [];
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

/* ── 解析 ───────────────────────────────────────────────────────────────── */
const priv = {
	update_id: 1,
	message: {
		message_id: 11, chat: { id: 100, type: 'private' },
		from: { id: 555, is_bot: false, username: 'alice', first_name: 'Alice' },
		text: '你好',
	},
};
const grp = {
	update_id: 2,
	message: {
		message_id: 22, chat: { id: -100200, type: 'supergroup', title: '评测群' },
		from: { id: 777, is_bot: false, username: 'bob' },
		text: '@my_bot 帮我看看',
		entities: [{ type: 'mention', offset: 0, length: 7 }],
	},
};

check('私聊：p2p + 字段齐全', () => {
	const r = parseTelegramUpdate(priv);
	assert.equal(r.kind, 'message');
	assert.equal(r.message.chatType, 'p2p');
	assert.equal(r.message.chatId, '100');
	assert.equal(r.message.userId, '555');
	assert.equal(r.message.userName, 'alice');
	assert.equal(r.message.content, '你好');
	assert.equal(r.message.mentionsBot, false);
});
check('★ 群聊（supergroup）：group + 命中 @ 用户名', () => {
	const r = parseTelegramUpdate(grp, { botUsername: 'my_bot' });
	assert.equal(r.message.chatType, 'group');
	assert.equal(r.message.mentionsBot, true);
	assert.equal(r.message.chatName, '评测群');
});
check('★ @ 判定：填了 botUsername 时按用户名精确匹配（@别的 bot 不算）', () => {
	const other = { ...grp, message: { ...grp.message, text: '@another_bot hi', entities: [{ type: 'mention' }] } };
	assert.equal(parseTelegramUpdate(other, { botUsername: 'my_bot' }).message.mentionsBot, false);
});
check('没填 botUsername ⇒ 有 mention entity 就算 @（与飞书侧同一近似）', () => {
	assert.equal(parseTelegramUpdate(grp).message.mentionsBot, true);
	const noEnt = { ...grp, message: { ...grp.message, text: '随便说', entities: [] } };
	assert.equal(parseTelegramUpdate(noEnt).message.mentionsBot, false);
});
check('★ 防环：from.is_bot ⇒ from-app', () => {
	const bot = { update_id: 3, message: { message_id: 33, chat: { id: 1, type: 'private' }, from: { id: 9, is_bot: true }, text: '我是另一个 bot' } };
	const r = parseTelegramUpdate(bot);
	assert.equal(r.kind, 'ignore');
	assert.equal(r.reason, 'from-app');
});
check('回复 bot 的消息 ⇒ repliesToBot', () => {
	const replyMsg = {
		update_id: 4,
		message: {
			message_id: 44, chat: { id: 100, type: 'private' },
			from: { id: 555, is_bot: false },
			text: '继续',
			reply_to_message: { message_id: 11, from: { id: 2, is_bot: true } },
		},
	};
	assert.equal(parseTelegramUpdate(replyMsg).message.repliesToBot, true);
});
check('非文本 / 不支持的会话 ⇒ ignore 且带 reason', () => {
	assert.equal(parseTelegramUpdate({ update_id: 5, message: { chat: { id: 1, type: 'private' }, from: {}, photo: [] } }).reason, 'no-text');
	assert.equal(parseTelegramUpdate({ update_id: 6, message: { chat: { id: 1, type: 'channel' }, from: {}, text: 'x' } }).reason, 'unsupported-chat');
	assert.equal(parseTelegramUpdate({ update_id: 7 }).reason, 'no-message');
});
check('edited_message 也能解析（编辑后重投不丢）', () => {
	const edited = { update_id: 8, edited_message: { ...priv.message, text: '改过的' } };
	assert.equal(parseTelegramUpdate(edited).message.content, '改过的');
});

/* ── 出站 ───────────────────────────────────────────────────────────────── */
await checkAsync('★ 出站：POST sendMessage（URL 带 token、chat_id/text 正确）', async () => {
	const calls = [];
	const a = createTelegramAdapter({
		getCreds: async () => ({ values: { botToken: 'TOK' } }),
		fetchImpl: async (url, init) => {
			calls.push({ url, body: JSON.parse(init.body) });
			return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 99 } }) };
		},
	});
	const r = await a.send({ chatId: '-100200' }, '你好');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, `${TELEGRAM_API_ROOT}/botTOK/sendMessage`);
	assert.equal(calls[0].body.chat_id, '-100200');
	assert.equal(calls[0].body.text, '你好');
	assert.equal(r.messageId, 99);
});
await checkAsync('★ 没有 token ⇒ unavailable（不假装成功）', async () => {
	const a = createTelegramAdapter({ getCreds: async () => ({}), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
	await assert.rejects(() => a.send({ chatId: '1' }, 'x'), /unavailable：缺少 telegram botToken/);
});
await checkAsync('★ 429 ⇒ 抛错并带 retry_after（不在适配器里静默重试）', async () => {
	const a = createTelegramAdapter({
		getCreds: async () => ({ values: { botToken: 'T' } }),
		fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 } }) }),
	});
	await assert.rejects(() => a.send({ chatId: '1' }, 'x'), /retry_after=7s/);
});

/* ── 长轮询传输 ─────────────────────────────────────────────────────────── */
await checkAsync('getUpdates：带 offset 与 timeout；缺 token 抛 unavailable', async () => {
	const urls = [];
	const t = createHttpTransport({
		getCreds: async () => ({ values: { botToken: 'T' } }),
		fetchImpl: async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => ({ ok: true, result: [{ update_id: 1 }] }) }; },
	});
	const rows = await t.getUpdates({ offset: 5, timeoutSec: 0 });
	assert.equal(rows.length, 1);
	assert.ok(urls[0].includes('/botT/getUpdates'));
	assert.ok(urls[0].includes('offset=5'));
	const empty = createHttpTransport({ getCreds: async () => ({}), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) });
	await assert.rejects(() => empty.getUpdates({}), /unavailable：缺少 telegram botToken/);
});

/* ── 网关 ───────────────────────────────────────────────────────────────── */
await checkAsync('★ 网关：拉到的 update 交给 onMessage，且 offset 推进', async () => {
	const got = [];
	const seenOffsets = [];
	let round = 0;
	let gw = null;
	gw = createTelegramGateway({
		pollTimeoutSec: 0,
		transport: {
			async getMe() { return 'my_bot'; },
			async getUpdates({ offset }) {
				round += 1;
				seenOffsets.push(offset);
				if (round === 1) { return [{ ...priv, update_id: 10 }]; }
				await gw.stop();
				return [];
			},
		},
		onMessage: async (m) => { got.push(m); },
	});
	await gw.start();
	await new Promise((r) => setTimeout(r, 1200));
	assert.equal(got.length, 1, `onMessage 应被调用一次，实际 ${got.length}`);
	assert.equal(got[0].content, '你好');
	assert.equal(seenOffsets[1], 11, `第二轮 getUpdates 的 offset 应是 11（实际 ${JSON.stringify(seenOffsets)}）`);
	assert.equal(gw.state().status, 'stopped', `stop 后状态应是 stopped（实际 ${gw.state().status}）`);
});
await checkAsync('★ 网关：起不来就抛（不假装在连）', async () => {
	const gw = createTelegramGateway({
		pollTimeoutSec: 0,
		transport: { async getUpdates() { throw new Error('unavailable：缺少 telegram botToken'); } },
	});
	await assert.rejects(() => gw.start(), /unavailable：缺少 telegram botToken/);
});
await checkAsync('网关：onMessage 抛错不打断循环（记日志继续）', async () => {
	let calls = 0;
	const logs = [];
	const gw = createTelegramGateway({
		pollTimeoutSec: 0,
		log: (lv, m) => logs.push(lv + ':' + m),
		transport: {
			async getUpdates({ offset }) {
				calls += 1;
				if (calls === 1) { return [{ ...priv, update_id: 20 }]; }
				await gw.stop();
				return [];
			},
		},
		onMessage: async () => { throw new Error('派发炸了'); },
	});
	await gw.start();
	await new Promise((r) => setTimeout(r, 1000));
	assert.ok(logs.some((x) => x.includes('warn') && x.includes('派发炸了')), '应记一条 warn：' + JSON.stringify(logs.slice(0, 3)));
});

/* ── 富媒体（2026-10-27）：IM 图片 → prompt 的 image part ───────────────── */

check('imageMediaTypeOf：只放行 jpeg / png（标错比丢掉更糟）', () => {
	assert.equal(imageMediaTypeOf('image/jpeg'), 'image/jpeg');
	assert.equal(imageMediaTypeOf('IMAGE/JPG'), 'image/jpeg');
	assert.equal(imageMediaTypeOf('image/png'), 'image/png');
	assert.equal(imageMediaTypeOf('image/webp'), '', 'webp 不放行');
	assert.equal(imageMediaTypeOf('application/pdf'), '');
	assert.equal(imageMediaTypeOf(''), '');
});

check('★ photo（多档尺寸）⇒ 取最大档，content 占位 [图片]', () => {
	const r = parseTelegramUpdate({
		update_id: 30,
		message: {
			message_id: 7, chat: { id: 9, type: 'private' }, from: { id: 1, first_name: 'Z' },
			photo: [{ file_id: 'small', file_size: 100 }, { file_id: 'big', file_size: 9000 }],
		},
	}, {});
	assert.equal(r.kind, 'message');
	assert.equal(r.message.attachments.length, 1);
	assert.equal(r.message.attachments[0].fileId, 'big', '应当取最后一档（最大尺寸）');
	assert.equal(r.message.attachments[0].mimeType, 'image/jpeg');
	assert.equal(r.message.content, '[图片]', '纯图片没有文本 ⇒ 给占位，下游按"有内容"处理');
});

check('photo + caption ⇒ content 用 caption（不是 [图片]）', () => {
	const r = parseTelegramUpdate({
		update_id: 31,
		message: { message_id: 8, chat: { id: 9, type: 'private' }, from: { id: 1 }, caption: '看这个报错', photo: [{ file_id: 'p1' }] },
	}, {});
	assert.equal(r.message.content, '看这个报错');
	assert.equal(r.message.attachments.length, 1);
});

check('image document 用它的 mime；非 image document 不算附件', () => {
	const png = parseTelegramUpdate({ update_id: 32, message: { message_id: 9, chat: { id: 9, type: 'private' }, from: { id: 1 },
		document: { file_id: 'd1', mime_type: 'image/png', file_name: 'shot.png' } } }, {});
	assert.equal(png.message.attachments[0].mimeType, 'image/png');
	assert.equal(png.message.attachments[0].fileName, 'shot.png');
	const pdf = parseTelegramUpdate({ update_id: 33, message: { message_id: 10, chat: { id: 9, type: 'private' }, from: { id: 1 },
		document: { file_id: 'd2', mime_type: 'application/pdf' } } }, {});
	assert.equal(pdf.kind, 'ignore', 'pdf 既不是文本也不是图片 ⇒ 忽略');
	assert.equal(pdf.reason, 'no-text');
});

await checkAsync('★ 网关：图片下载后挂 msg.images（base64 + mediaType）', async () => {
	const got = [];
	let round = 0;
	let downloads = 0;
	let gw = null;
	gw = createTelegramGateway({
		pollTimeoutSec: 0,
		transport: {
			async getMe() { return 'my_bot'; },
			async getUpdates() {
				round += 1;
				if (round === 1) {
					return [{ update_id: 40, message: { message_id: 11, chat: { id: 9, type: 'private' }, from: { id: 1 },
						photo: [{ file_id: 'f1', file_size: 10 }] } }];
				}
				await gw.stop();
				return [];
			},
			async download(fileId) {
				downloads += 1;
				assert.equal(fileId, 'f1');
				return { buffer: Buffer.from('fake-jpeg'), filePath: 'p.jpg' };
			},
		},
		onMessage: async (m) => { got.push(m); },
		log: () => undefined,
	});
	await gw.start();
	await new Promise((r) => setTimeout(r, 1200));
	assert.equal(downloads, 1, '应当调用一次 download');
	assert.equal(got.length, 1);
	assert.equal(got[0].images.length, 1);
	assert.equal(got[0].images[0].mediaType, 'image/jpeg');
	assert.equal(Buffer.from(got[0].images[0].data, 'base64').toString(), 'fake-jpeg');
});

await checkAsync('★ 下载失败 ⇒ 消息仍派发（只是没有图，不能丢整条）', async () => {
	const got = [];
	let round = 0;
	let gw = null;
	gw = createTelegramGateway({
		pollTimeoutSec: 0,
		transport: {
			async getMe() { return 'my_bot'; },
			async getUpdates() {
				round += 1;
				if (round === 1) {
					return [{ update_id: 41, message: { message_id: 12, chat: { id: 9, type: 'private' }, from: { id: 1 },
						photo: [{ file_id: 'f2' }] } }];
				}
				await gw.stop();
				return [];
			},
			async download() { throw new Error('cdn 502'); },
		},
		onMessage: async (m) => { got.push(m); },
		log: () => undefined,
	});
	await gw.start();
	await new Promise((r) => setTimeout(r, 1200));
	assert.equal(got.length, 1, '图片下载失败不该让整条消息丢掉');
	assert.equal(got[0].images, undefined);
	assert.equal(got[0].content, '[图片]');
});

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ Telegram 适配器单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
