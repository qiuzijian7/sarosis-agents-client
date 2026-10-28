// @vssaros/dsh-agents — 出站富媒体（2026-10-27）
//   跑法：node dsh-plugins/vssaros-agents/test/outbound-media.test.mjs
//
// 链路：assistant message 的 image part → finalAssistantContent → deliverForEntry
//        → deliver（图只跟第一段）→ adapter.send(ctx, text, images) → sendPhoto
//
// 三条最容易写错的：
//   ① 长答复会被**切成多段**，图必须只跟第一段（否则同一条图发 N 次）
//   ② 只有图、没有文本时 `splitOutbound('')` 返回空数组 ⇒ 必须补一个空段，否则整条不发
//   ③ Telegram 的 caption 上限 1024 ⇒ 超了要**另发一条文本**，不能截断丢内容
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildMultipartFormData, imageExtensionOf } from '../lib/adapters/media.js';
import { createTelegramAdapter } from '../lib/adapters/telegram.js';
import { createDiscordAdapter } from '../lib/adapters/discord.js';
import { createBindingHub } from '../lib/bindings.js';
import { finalAssistantContent } from '../lib/core/relay.js';

let pass = 0;
const fails = [];
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

const root = mkdtempSync(join(tmpdir(), 'vssaros-obm-'));
const config = { dataRoot: root };

/* ══ ① 从事件里取图 ═════════════════════════════════════════════════════ */

const ev = (parts, interrupted = false) => ({ type: 'assistant/message', data: { message: { content: parts }, interrupted } });

check('纯文本 ⇒ images 为空数组', () => {
	const r = finalAssistantContent([ev([{ type: 'text', text: '  hello  ' }])]);
	assert.equal(r.text, 'hello');
	assert.deepEqual(r.images, []);
});

check('★ 文本 + 图片 ⇒ 两样都拿到', () => {
	const r = finalAssistantContent([
		ev([
			{ type: 'text', text: '看这张图' },
			{ type: 'image', mediaType: 'image/png', data: 'QUJD', name: 'a.png' },
		]),
	]);
	assert.equal(r.text, '看这张图');
	assert.equal(r.images.length, 1);
	assert.equal(r.images[0].mediaType, 'image/png');
	assert.equal(r.images[0].data, 'QUJD');
	assert.equal(r.images[0].name, 'a.png');
});

check('★ 只有图片没有文本 ⇒ 也算有产出（text 为空串，不能判成 null）', () => {
	const r = finalAssistantContent([ev([{ type: 'image', mediaType: 'image/jpeg', data: 'QQ==' }])]);
	assert.ok(r, '有图就不该返回 null —— 否则整条答复会被当成"没产出"');
	assert.equal(r.text, '');
	assert.equal(r.images.length, 1);
});

check('多轮 ⇒ 取最后一个 assistant/message', () => {
	const r = finalAssistantContent([
		ev([{ type: 'text', text: '旧' }]),
		ev([{ type: 'text', text: '新' }, { type: 'image', data: 'X', mediaType: 'image/png' }]),
	]);
	assert.equal(r.text, '新');
	assert.equal(r.images.length, 1);
});

check('没有 assistant/message ⇒ null', () => {
	assert.equal(finalAssistantContent([]), null);
	assert.equal(finalAssistantContent([{ type: 'tool/result' }]), null);
});

check('image part 没有 data ⇒ 丢弃（不产出空的坏 part）', () => {
	const r = finalAssistantContent([ev([{ type: 'text', text: 't' }, { type: 'image', data: '' }])]);
	assert.equal(r.images.length, 0);
});

/* ══ ② multipart 构造 ══════════════════════════════════════════════════ */

check('★ multipart：字段与文件都在，且以 boundary 收尾', () => {
	const { body, contentType } = buildMultipartFormData(
		{ chat_id: '123', caption: '说明' },
		{ field: 'photo', filename: 'a.png', mimeType: 'image/png', buffer: Buffer.from('PNGBYTES') },
	);
	const text = body.toString('utf8');
	assert.ok(contentType.startsWith('multipart/form-data; boundary='), contentType);
	const boundary = contentType.split('boundary=')[1];
	assert.ok(text.includes(`name="chat_id"`));
	assert.ok(text.includes('123'));
	assert.ok(text.includes('说明'));
	assert.ok(text.includes(`name="photo"; filename="a.png"`), text.slice(0, 400));
	assert.ok(text.includes('Content-Type: image/png'));
	assert.ok(text.includes('PNGBYTES'));
	assert.ok(text.trimEnd().endsWith(`--${boundary}--`), '必须以结束 boundary 收尾');
});

check('字段值为 undefined 时跳过（不发 name="" 这种坏字段）', () => {
	const { body } = buildMultipartFormData({ a: 1, b: undefined, c: null }, null);
	const text = body.toString('utf8');
	assert.ok(text.includes('name="a"'));
	assert.ok(!text.includes('name="b"'));
	assert.ok(!text.includes('name="c"'));
});

check('imageExtensionOf：png → png，其它 → jpg', () => {
	assert.equal(imageExtensionOf('image/png'), 'png');
	assert.equal(imageExtensionOf('image/jpeg'), 'jpg');
	assert.equal(imageExtensionOf(''), 'jpg');
});

/* ══ ③ Telegram sendPhoto ══════════════════════════════════════════════ */

const tgCalls = (impl) => {
	const calls = [];
	const adapter = createTelegramAdapter({
		getCreds: async () => ({ botToken: 'TOK' }),
		fetchImpl: async (url, init) => {
			calls.push({ url: String(url), init });
			return impl ? impl(url, init) : { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
		},
	});
	return { adapter, calls };
};

await checkAsync('无图 ⇒ 仍走 sendMessage（既有行为不变）', async () => {
	const { adapter, calls } = tgCalls();
	await adapter.send({ chatId: '1' }, '文字');
	assert.equal(calls.length, 1);
	assert.ok(calls[0].url.endsWith('/sendMessage'));
	assert.equal(JSON.parse(calls[0].init.body).text, '文字');
});

await checkAsync('★ 有图 + 短文本 ⇒ sendPhoto（multipart + caption）', async () => {
	const { adapter, calls } = tgCalls();
	await adapter.send({ chatId: '1' }, '看这张', [{ mediaType: 'image/png', data: Buffer.from('P').toString('base64'), name: 'x.png' }]);
	assert.equal(calls.length, 1, '短文本不该额外发一条');
	assert.ok(calls[0].url.endsWith('/sendPhoto'), calls[0].url);
	assert.ok(String(calls[0].init.headers['content-type']).startsWith('multipart/form-data'));
	const text = calls[0].init.body.toString('utf8');
	assert.ok(text.includes('name="caption"'));
	assert.ok(text.includes('看这张'));
	assert.ok(text.includes('name="photo"'));
});

await checkAsync('★ 有图 + 长文本（>1024）⇒ sendPhoto 不发 caption，另发 sendMessage 全文', async () => {
	const { adapter, calls } = tgCalls();
	const long = 'x'.repeat(1500);
	await adapter.send({ chatId: '1' }, long, [{ mediaType: 'image/jpeg', data: 'QQ==' }]);
	assert.equal(calls.length, 2, '应当是 sendPhoto + sendMessage 各一次：' + JSON.stringify(calls.map((c) => c.url.slice(-12))));
	assert.ok(calls[0].url.endsWith('/sendPhoto'));
	assert.ok(!calls[0].init.body.toString('utf8').includes('name="caption"'), '长文本不该塞进 caption');
	assert.ok(calls[1].url.endsWith('/sendMessage'));
	assert.equal(JSON.parse(calls[1].init.body).text.length, 1500, '全文要完整发出，不能截断');
});

await checkAsync('多图 ⇒ 只发第一张（Telegram 单条只能一张）', async () => {
	const { adapter, calls } = tgCalls();
	await adapter.send({ chatId: '1' }, 'x', [
		{ mediaType: 'image/png', data: 'QQ==' },
		{ mediaType: 'image/png', data: 'Qg==' },
	]);
	assert.equal(calls.length, 1);
	assert.ok(calls[0].url.endsWith('/sendPhoto'));
});

await checkAsync('sendPhoto 失败 ⇒ 如实抛（带 description）', async () => {
	const { adapter } = tgCalls(async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request: photo invalid' }) }));
	await assert.rejects(
		() => adapter.send({ chatId: '1' }, 'x', [{ mediaType: 'image/png', data: 'QQ==' }]),
		/photo invalid/,
	);
});

/* ══ ④ deliver：图只跟第一段 ═══════════════════════════════════════════ */

function makeHub() {
	const got = [];
	const hub = createBindingHub({ config, log: () => undefined });
	hub.register({
		id: 'loopback',
		async send(ctx, text, images) { got.push({ text, images: images || [] }); },
	});
	return { hub, got };
}

const binding = { id: 'b1', platform: 'loopback', chatId: 'c1', chatType: 'p2p', enabled: true, direction: 'both' };

await checkAsync('★ 长文本分成多段时，图片只跟第一段', async () => {
	const { hub, got } = makeHub();
	/* ⚠ 必须**超过** `OUT_SEGMENT_CHARS`（3000）才会被切段；
	   上一版用了刚好 3000，`<= limit` 不分段，于是这条断言测不到"图只跟第一段"。 */
	const long = 'a'.repeat(3500);
	const r = await hub.deliver(binding, long, [{ mediaType: 'image/png', data: 'QQ==' }]);
	assert.ok(r.segments >= 2, '这段文本应当被切成多段：' + r.segments);
	assert.equal(got.length, r.segments);
	assert.equal(got[0].images.length, 1, '第一段要带图');
	for (let i = 1; i < got.length; i += 1) {
		assert.equal(got[i].images.length, 0, '第 ' + (i + 1) + ' 段不该带图（否则同一张图发多次）');
	}
	assert.equal(r.images, 1);
});

await checkAsync('★ 只有图没有文本 ⇒ 仍要发出去（补一个空段）', async () => {
	const { hub, got } = makeHub();
	const r = await hub.deliver(binding, '', [{ mediaType: 'image/png', data: 'QQ==' }]);
	assert.equal(r.ok, true);
	assert.equal(got.length, 1);
	assert.equal(got[0].text, '');
	assert.equal(got[0].images.length, 1);
});

await checkAsync('既无文本也无图 ⇒ empty（不发请求）', async () => {
	const { hub, got } = makeHub();
	const r = await hub.deliver(binding, '', []);
	assert.equal(r.reason, 'empty');
	assert.equal(got.length, 0);
});

await checkAsync('超过 2 张 ⇒ 上游就截到 2 张', async () => {
	const { hub, got } = makeHub();
	await hub.deliver(binding, 'x', [
		{ mediaType: 'image/png', data: 'QQ==' },
		{ mediaType: 'image/png', data: 'Qg==' },
		{ mediaType: 'image/png', data: 'Qw==' },
	]);
	assert.equal(got[0].images.length, 2);
});

await checkAsync('没有 data 的图被过滤掉（不发坏的 part）', async () => {
	const { hub, got } = makeHub();
	await hub.deliver(binding, 'x', [{ mediaType: 'image/png', data: '' }]);
	assert.equal(got[0].images.length, 0);
});

try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }

/* ══ ⑤ Discord 出站图片（multipart，字段名必须是 files[0]）════════════════ */

const dcCalls = () => {
	const calls = [];
	const adapter = createDiscordAdapter({
		resolve: async () => ({ botToken: 'TOK' }),
		fetchImpl: async (url, init) => {
			calls.push({ url: String(url), init });
			return { ok: true, status: 200, text: async () => '{"id":"m1"}' };
		},
	});
	return { adapter, calls };
};

await checkAsync('Discord：无图 ⇒ 仍是 JSON（既有行为不变）', async () => {
	const { adapter, calls } = dcCalls();
	await adapter.send({ chatId: 'c1' }, '文字');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].init.headers['content-type'], 'application/json');
	assert.equal(JSON.parse(calls[0].init.body).content, '文字');
});

await checkAsync('★ Discord：有图 ⇒ multipart，文件字段名是 files[0]', async () => {
	const { adapter, calls } = dcCalls();
	await adapter.send({ chatId: 'c1' }, '看图', [{ mediaType: 'image/png', data: Buffer.from('PNG').toString('base64'), name: 'a.png' }]);
	assert.equal(calls.length, 1);
	const ct = String(calls[0].init.headers['content-type']);
	assert.ok(ct.startsWith('multipart/form-data'), ct);
	const text = calls[0].init.body.toString('utf8');
	assert.ok(text.includes('name="content"'), '文本要走普通字段：' + text.slice(0, 200));
	assert.ok(text.includes('name="files[0]"'), 'Discord 只认 files[n]，写 file 会被忽略：' + text.slice(0, 300));
	assert.ok(text.includes('filename="a.png"'));
	assert.ok(text.includes('PNG'));
});

await checkAsync('★ Discord：只有图没有文本 ⇒ 仍要发（不能判成 empty）', async () => {
	const { adapter, calls } = dcCalls();
	const r = await adapter.send({ chatId: 'c1' }, '   ', [{ mediaType: 'image/png', data: 'QQ==' }]);
	assert.equal(r.ok, true);
	assert.equal(calls.length, 1);
	assert.ok(String(calls[0].init.headers['content-type']).startsWith('multipart/form-data'));
});

await checkAsync('Discord：空文本且无图 ⇒ skipped（不占 API 调用）', async () => {
	const { adapter, calls } = dcCalls();
	const r = await adapter.send({ chatId: 'c1' }, '   ');
	assert.equal(r.skipped, 'empty');
	assert.equal(calls.length, 0);
});

await checkAsync('Discord：有图但 429 ⇒ 仍如实报 retry_after', async () => {
	const adapter = createDiscordAdapter({
		resolve: async () => ({ botToken: 'TOK' }),
		fetchImpl: async () => ({ ok: false, status: 429, text: async () => '{"retry_after":1.5}' }),
	});
	await assert.rejects(() => adapter.send({ chatId: 'c1' }, 'x', [{ mediaType: 'image/png', data: 'QQ==' }]), /retry_after=1\.5s/);
});

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 出站富媒体单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
