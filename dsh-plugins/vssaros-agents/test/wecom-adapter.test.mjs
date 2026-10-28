// @vssaros/dsh-agents — 企业微信适配器单测（2026-10-27）
//   跑法：node dsh-plugins/vssaros-agents/test/wecom-adapter.test.mjs
//
// 为什么这一层**必须**离线测完：企业微信的入站要**公网回调**，本地根本跑不到。
// 而加密/验签/XML 解析是纯计算 —— 错一位就全错，且真机上只会表现为
// "回调一直失败"，连失败原因都看不到（企业微信不告诉你哪一步错）。
//
// 六组：密钥派生 / 加解密往返 / 验签 / XML / 消息解析 / 出站与回调
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
	buildWecomReplyXml, createWecomAdapter, decryptWecomMessage, encryptWecomMessage,
	handleWecomCallback, parseWecomEnvelope, parseWecomMessage, verifyWecomSignature,
	wecomKeyOf, wecomSignature, xmlField,
} from '../lib/adapters/wecom.js';

let pass = 0;
const fails = [];
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

/* 测试用固定凭据（不是真实值） */
const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';   // 43 字符
const CORP = 'ww_test_corp';
const TOKEN = 'test_token';

/* ══ 密钥派生 ═══════════════════════════════════════════════════════════ */

check('43 字符 key ⇒ 32 字节；长度不对要报错（不静默截断）', () => {
	assert.equal(wecomKeyOf(KEY).length, 32);
	assert.throws(() => wecomKeyOf('short'), /必须是 43 字符/);
	assert.throws(() => wecomKeyOf(''), /必须是 43 字符/);
});

/* ══ 加解密往返 ═════════════════════════════════════════════════════════ */

check('★ 加密 → 解密 往返一致（含中文与 emoji）', () => {
	const text = '<xml><Content><![CDATA[你好，世界 🚀]]></Content></xml>';
	const enc = encryptWecomMessage(text, KEY, CORP);
	assert.ok(enc.length > 0);
	const back = decryptWecomMessage(enc, KEY, { corpId: CORP });
	assert.equal(back.msg, text);
	assert.equal(back.corpId, CORP);
});

check('★ corpId 不匹配 ⇒ 抛（防跨企业投递）', () => {
	const enc = encryptWecomMessage('<xml>hi</xml>', KEY, 'ww_other');
	assert.throws(() => decryptWecomMessage(enc, KEY, { corpId: CORP }), /corpId 不匹配/);
});

check('key 不对 ⇒ 解密失败（补位或长度校验兜住）', () => {
	const enc = encryptWecomMessage('<xml>hi</xml>', KEY, CORP);
	const wrong = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';   // 另一个 43 字符 key
	assert.throws(() => decryptWecomMessage(enc, wrong, { corpId: CORP }));
});

/* ══ 验签 ═══════════════════════════════════════════════════════════════ */

check('★ 签名按**字典序**排序后拼接（换参数顺序结果不变）', () => {
	const a = wecomSignature(TOKEN, '1700000000', 'nonce123', 'CIPHER');
	const b = wecomSignature(TOKEN, '1700000000', 'nonce123', 'CIPHER');
	assert.equal(a, b);
	/* 手工对照：sha1(sort([t, ts, n, e]).join('')) */
	const expect = createHash('sha1')
		.update(['CIPHER', '1700000000', 'nonce123', TOKEN].sort().join(''), 'utf8')
		.digest('hex');
	assert.equal(a, expect);
	assert.equal(a.length, 40);
});

check('★ 验签：改一个字符就不过', () => {
	const ts = '1700000000';
	const nonce = 'n1';
	const enc = 'CIPHER';
	const sig = wecomSignature(TOKEN, ts, nonce, enc);
	assert.equal(verifyWecomSignature({ token: TOKEN, timestamp: ts, nonce, encrypt: enc, signature: sig }), true);
	assert.equal(verifyWecomSignature({ token: TOKEN, timestamp: ts, nonce, encrypt: 'CIPHE2', signature: sig }), false);
	assert.equal(verifyWecomSignature({ token: TOKEN, timestamp: ts, nonce, encrypt: enc, signature: sig.toUpperCase() }), true, '大小写不敏感');
	assert.equal(verifyWecomSignature({ token: '', timestamp: ts, nonce, encrypt: enc, signature: sig }), false, '没有 token 一律不过');
});

/* ══ XML ═══════════════════════════════════════════════════════════════ */

check('xmlField：CDATA / 普通标签 / 缺失字段', () => {
	const xml = '<xml><A><![CDATA[值1]]></A><B>值2</B></xml>';
	assert.equal(xmlField(xml, 'A'), '值1');
	assert.equal(xmlField(xml, 'B'), '值2');
	assert.equal(xmlField(xml, 'C'), '');
});

check('信封解析：ToUserName / Encrypt / AgentID', () => {
	const env = parseWecomEnvelope('<xml><ToUserName><![CDATA[c]]></ToUserName><Encrypt><![CDATA[E]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>');
	assert.equal(env.toUserName, 'c');
	assert.equal(env.encrypt, 'E');
	assert.equal(env.agentId, '1000002');
});

/* ══ 消息解析 ═══════════════════════════════════════════════════════════ */

const textXml = '<xml><ToUserName><![CDATA[c]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName>'
	+ '<CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType>'
	+ '<Content><![CDATA[帮我看下这个报错]]></Content><MsgId>123456</MsgId><AgentID>1000002</AgentID></xml>';

check('★ 文本消息 ⇒ 我们的 msg 形状（私聊）', () => {
	const r = parseWecomMessage(textXml);
	assert.equal(r.ignored, false);
	assert.equal(r.msg.platform, 'wecom');
	assert.equal(r.msg.chatType, 'p2p');
	assert.equal(r.msg.userId, 'zhangsan');
	assert.equal(r.msg.content, '帮我看下这个报错');
	assert.equal(r.msg.messageId, '123456');
	assert.equal(r.msg.agentId, '1000002');
	assert.equal(r.msg.mentionsBot, true, '能收到就说明已经 @ 了（群机器人语义）');
});

check('★ 有 ChatId ⇒ 群消息', () => {
	const r = parseWecomMessage(textXml.replace('</xml>', '<ChatId><![CDATA[grp1]]></ChatId></xml>'));
	assert.equal(r.msg.chatType, 'group');
	assert.equal(r.msg.chatId, 'grp1');
});

check('非文本 / event / 空内容 都要 ignore 且能说清原因', () => {
	const img = textXml.replace('text', 'image');
	assert.equal(parseWecomMessage(img).reason, 'non-text');
	const ev = textXml.replace('text', 'event');
	assert.equal(parseWecomMessage(ev).reason, 'event');
	const empty = textXml.replace('帮我看下这个报错', '');
	assert.equal(parseWecomMessage(empty).reason, 'empty-content');
});

check('★ 回包 XML：内容里的 `]]>` 要拆成两段 CDATA（CDATA 不解析实体）', () => {
	const xml = buildWecomReplyXml({ toUser: 'u', fromUser: 'c', content: 'a]]>b' });
	/* 4 个字段各一个 CDATA 段；内容里的 `]]>` 被拆开后总闭合符会比段数多 1 */
	assert.ok(xml.includes(']]]]><![CDATA[>'), '必须用标准拆分写法：' + xml);
	assert.equal((xml.match(/\]\]>/g) || []).length, 5, '4 段 + 1 个拆分点：' + xml);
	/* ⚠ 不用 `xmlField` 验"解析回来一致"：那个简化解析器只认第一段 CDATA，
	   不还原拆分写法（企业微信发给我们时也不会含 `]]>`，它自己会处理）。 */
});

/* ══ 出站 ═══════════════════════════════════════════════════════════════ */

await checkAsync('★ 出站：先换 token 再发；token 有缓存（第二次不再换）', async () => {
	const calls = [];
	let tokenFetches = 0;
	const adapter = createWecomAdapter({
		resolve: async () => ({ corpId: CORP, secret: 'sec', agentId: '1000002' }),
		fetchImpl: async (url, init) => {
			calls.push({ url: String(url), init });
			if (String(url).includes('/gettoken')) {
				tokenFetches += 1;
				return { ok: true, status: 200, text: async () => JSON.stringify({ errcode: 0, access_token: 'T' + tokenFetches, expires_in: 7200 }) };
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ errcode: 0, errmsg: 'ok' }) };
		},
	});
	await adapter.send({ chatId: 'zhangsan' }, '第一条');
	await adapter.send({ chatId: 'zhangsan' }, '第二条');
	assert.equal(tokenFetches, 1, '第二次应命中缓存');
	assert.equal(adapter.id, 'wecom');
	const sendCall = calls.find((c) => c.url.includes('message/send'));
	assert.ok(sendCall.url.includes('access_token=T1'), sendCall.url);
	const body = JSON.parse(sendCall.init.body);
	assert.equal(body.touser, 'zhangsan');
	assert.equal(body.msgtype, 'text');
	assert.equal(body.text.content, '第一条');
	assert.equal(body.agentid, 1000002, 'agentid 要转成数字（企业微信要求）');
});

await checkAsync('缺凭据 / 缺 Agent ID ⇒ unavailable（不假装发出去）', async () => {
	const a1 = createWecomAdapter({ resolve: async () => ({ corpId: 'c' }), fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
	await assert.rejects(() => a1.send({ chatId: 'u' }, 'x'), /缺少 Corp ID \/ Secret/);
	const a2 = createWecomAdapter({ resolve: async () => ({ corpId: 'c', secret: 's' }), fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
	await assert.rejects(() => a2.send({ chatId: 'u' }, 'x'), /缺少 Agent ID/);
});

await checkAsync('★ errcode 非 0 ⇒ 抛（带 errcode 与 errmsg）', async () => {
	const adapter = createWecomAdapter({
		resolve: async () => ({ corpId: CORP, secret: 's', agentId: '1' }),
		fetchImpl: async (url) => (String(url).includes('/gettoken')
			? { ok: true, status: 200, text: async () => JSON.stringify({ errcode: 0, access_token: 'T' }) }
			: { ok: true, status: 200, text: async () => JSON.stringify({ errcode: 81013, errmsg: 'user & party & tag all invalid' }) }),
	});
	await assert.rejects(() => adapter.send({ chatId: 'nobody' }, 'x'), /81013.*invalid|invalid.*81013/);
});

/* ══ 回调 ═══════════════════════════════════════════════════════════════ */

/** 构造一次合法回调（签名 + 密文都由本模块自己算，保证协议自洽）。 */
function makeCallback(method, { inner = '', query = {}, corpId = CORP } = {}) {
	const ts = '1700000000';
	const nonce = 'n1';
	/* ⚠ `opts.corpId` 固定为 CORP（消费方的期望值）；`corpId` 参数只用来**加密时**换尾部，
	   这样"密文里的 corpId 与期望不一致"那一条才真的能测到。 */
	const opts = { token: TOKEN, encodingAesKey: KEY, corpId: CORP };
	if (method === 'GET') {
		const echo = encryptWecomMessage('echo-plain-123', KEY, corpId);
		const sig = wecomSignature(TOKEN, ts, nonce, echo);
		return { input: { method: 'GET', query: { ...query, echostr: echo, timestamp: ts, nonce, msg_signature: sig } }, opts };
	}
	const enc = encryptWecomMessage(inner, KEY, corpId);
	const sig = wecomSignature(TOKEN, ts, nonce, enc);
	const body = '<xml><ToUserName><![CDATA[' + corpId + ']]></ToUserName>'
		+ '<Encrypt><![CDATA[' + enc + ']]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>';
	return { input: { method: 'POST', body, query: { ...query, timestamp: ts, nonce, msg_signature: sig } }, opts };
}

await checkAsync('★ GET 验证：解密 echostr 后**原样**返回明文', async () => {
	const { input, opts } = makeCallback('GET');
	const r = await handleWecomCallback(opts, input);
	assert.equal(r.status, 200);
	assert.equal(r.body, 'echo-plain-123');
});

await checkAsync('★ GET 验证：签名错 ⇒ 401（不放行）', async () => {
	const { input, opts } = makeCallback('GET');
	input.query.msg_signature = 'deadbeef';
	const r = await handleWecomCallback(opts, input);
	assert.equal(r.status, 401);
});

await checkAsync('★ POST：验签 + 解密 + 派发（msg 形状正确）', async () => {
	const { input, opts } = makeCallback('POST', { inner: textXml });
	const got = [];
	opts.onMessage = async (m) => { got.push(m); };
	const r = await handleWecomCallback(opts, input);
	assert.equal(r.status, 200);
	assert.equal(got.length, 1);
	assert.equal(got[0].content, '帮我看下这个报错');
	assert.equal(got[0].platform, 'wecom');
});

await checkAsync('★ POST：签名错 ⇒ 401 且不派发', async () => {
	const { input, opts } = makeCallback('POST', { inner: textXml });
	let called = 0;
	opts.onMessage = async () => { called += 1; };
	input.query.msg_signature = 'x'.repeat(40);
	const r = await handleWecomCallback(opts, input);
	assert.equal(r.status, 401);
	assert.equal(called, 0);
});

await checkAsync('★ POST：corpId 不匹配 ⇒ 400（跨企业投递挡住）', async () => {
	const { input, opts } = makeCallback('POST', { inner: textXml, corpId: 'ww_other' });
	const r = await handleWecomCallback(opts, input);
	assert.equal(r.status, 400);
	assert.equal(r.body, 'decrypt failed');
});

await checkAsync('POST：非文本消息 ⇒ 200 空包（不重投），但不派发', async () => {
	const { input, opts } = makeCallback('POST', { inner: textXml.replace('text', 'image') });
	let called = 0;
	opts.onMessage = async () => { called += 1; };
	const r = await handleWecomCallback(opts, input);
	assert.equal(r.status, 200);
	assert.equal(r.body, '');
	assert.equal(r.ignored, 'non-text');
	assert.equal(called, 0);
});

await checkAsync('★ onMessage 抛错仍回 200（否则企业微信会重投同一条）', async () => {
	const { input, opts } = makeCallback('POST', { inner: textXml });
	opts.onMessage = async () => { throw new Error('boom'); };
	const r = await handleWecomCallback(opts, input);
	assert.equal(r.status, 200);
});

await checkAsync('回调未配置 ⇒ 503（说清缺什么）', async () => {
	const r = await handleWecomCallback({ token: '', encodingAesKey: '', corpId: '' }, { method: 'GET' });
	assert.equal(r.status, 503);
	assert.ok(String(r.body).includes('未配置'));
});

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 企业微信适配器单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
