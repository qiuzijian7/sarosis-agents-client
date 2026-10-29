// @vssaros/dsh-agents — 飞书出站适配器单测（P1，2026-10-27）
//   跑法：node dsh-plugins/vssaros-agents/test/feishu-adapter.test.mjs
//
// 为什么单测（不联网）：签名算法写错时，**消息是"发出去"了但飞书拒收**，
//   日志里只有一句 code=19021；没有单测就只能靠线上试。这里把算法与错误分支都钉住。
import assert from 'node:assert/strict';

import { buildWebhookPayload, createFeishuAdapter, feishuSign } from '../lib/adapters/feishu.js';

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

/* ── 签名与请求体 ─────────────────────────────────────────────────────── */
check('签名是 base64，且随 secret / timestamp 变化', () => {
	const a = feishuSign('1700000000', 's1');
	const b = feishuSign('1700000000', 's2');
	const c = feishuSign('1700000001', 's1');
	assert.match(a, /^[A-Za-z0-9+/=]+$/, '必须是 base64：' + a);
	assert.notEqual(a, b, '换 secret 必须换签名');
	assert.notEqual(a, c, '换 timestamp 必须换签名');
	assert.equal(a, feishuSign('1700000000', 's1'), '同输入必须同输出（纯函数）');
});
check('不带 secret ⇒ 请求体里**没有** timestamp/sign（带空 sign 会被飞书拒）', () => {
	const body = buildWebhookPayload('hi');
	assert.equal(body.msg_type, 'text');
	assert.equal(JSON.parse(body.content).text, 'hi');
	assert.equal(body.timestamp, undefined);
	assert.equal(body.sign, undefined);
});
check('带 secret ⇒ 请求体含 timestamp(string) + sign', () => {
	const body = buildWebhookPayload('hi', { timestamp: 1700000000, secret: 'sec' });
	assert.equal(body.timestamp, '1700000000');
	assert.equal(body.sign, feishuSign('1700000000', 'sec'));
	assert.equal(JSON.parse(body.content).text, 'hi');
});
check('文本被原样保留（换行/中文/emoji 不转义坏）', () => {
	const text = '第一行\n第二行 · 中文 ✅';
	const body = buildWebhookPayload(text);
	assert.equal(JSON.parse(body.content).text, text);
});

/* ── send 的各条分支 ─────────────────────────────────────────────────── */
const fakeRes = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

await checkAsync('★ 既没 webhookUrl 也没应用凭据 ⇒ 抛 unavailable（不静默成功）', async () => {
	const a = createFeishuAdapter({ fetchImpl: async () => fakeRes(200, { code: 0 }) });
	await assert.rejects(() => a.send({ chatId: 'oc_x' }, 'x'), /没有 webhook URL，且「设置 → 渠道」里没有飞书应用凭据/);
});
await checkAsync('★ 应用模式：没 webhookUrl ⇒ 换 token 后发到 im/v1/messages（receive_id=chat_id）', async () => {
	const calls = [];
	const a = createFeishuAdapter({
		resolveApp: async () => ({ appId: 'cli_1', appSecret: 'sec_1', configured: true }),
		fetchImpl: async (url, init) => {
			calls.push({ url, init });
			if (url.includes('/auth/v3/tenant_access_token/internal')) {
				return fakeRes(200, { code: 0, tenant_access_token: 't-1', expire: 7200 });
			}
			return fakeRes(200, { code: 0, data: { message_id: 'om_1' } });
		},
	});
	const r = await a.send({ chatId: 'oc_1' }, '你好');
	assert.deepEqual(r, { ok: true, via: 'app' });
	assert.equal(calls.length, 2);
	assert.match(calls[0].url, /tenant_access_token\/internal$/);
	assert.equal(JSON.parse(calls[0].init.body).app_id, 'cli_1');
	assert.match(calls[1].url, /\/im\/v1\/messages\?receive_id_type=chat_id$/);
	assert.equal(calls[1].init.headers.authorization, 'Bearer t-1');
	const body = JSON.parse(calls[1].init.body);
	assert.equal(body.receive_id, 'oc_1');
	assert.equal(body.msg_type, 'text');
	assert.equal(JSON.parse(body.content).text, '你好');
});
await checkAsync('★ 应用模式：tenant_access_token 会被缓存（第二条不再换 token）', async () => {
	let tokenCalls = 0; let msgCalls = 0;
	const a = createFeishuAdapter({
		now: () => 1700000000000,
		resolveApp: async () => ({ appId: 'a', appSecret: 'b', configured: true }),
		fetchImpl: async (url) => {
			if (url.includes('tenant_access_token')) { tokenCalls += 1; return fakeRes(200, { code: 0, tenant_access_token: 't', expire: 7200 }); }
			msgCalls += 1; return fakeRes(200, { code: 0 });
		},
	});
	await a.send({ chatId: 'oc' }, '1');
	await a.send({ chatId: 'oc' }, '2');
	assert.equal(tokenCalls, 1, `token 只该换 1 次，实际 ${tokenCalls}`);
	assert.equal(msgCalls, 2);
});
await checkAsync('★ 应用模式：飞书返回 code!=0 ⇒ 抛错且不重试', async () => {
	let msgCalls = 0;
	const a = createFeishuAdapter({
		resolveApp: async () => ({ appId: 'a', appSecret: 'b', configured: true }),
		fetchImpl: async (url) => {
			if (url.includes('tenant_access_token')) { return fakeRes(200, { code: 0, tenant_access_token: 't', expire: 7200 }); }
			msgCalls += 1;
			return fakeRes(200, { code: 230002, msg: 'bot not in chat' });
		},
	});
	await assert.rejects(() => a.send({ chatId: 'oc' }, 't'), /飞书拒绝（code=230002/);
	assert.equal(msgCalls, 1);
});
await checkAsync('★ 应用模式：token 换取失败 ⇒ unavailable（不猜、不静默）', async () => {
	const a = createFeishuAdapter({
		resolveApp: async () => ({ appId: 'a', appSecret: 'b', configured: true }),
		fetchImpl: async () => fakeRes(200, { code: 10003, msg: 'invalid param' }),
	});
	await assert.rejects(() => a.send({ chatId: 'oc' }, 't'), /换取 tenant_access_token 失败（HTTP 200，code=10003/);
});
await checkAsync('★ 填了 webhookUrl 就走 webhook（应用模式不插手）', async () => {
	let tokenAsked = 0;
	const a = createFeishuAdapter({
		resolveApp: async () => { tokenAsked += 1; return { appId: 'a', appSecret: 'b', configured: true }; },
		fetchImpl: async () => fakeRes(200, { code: 0 }),
	});
	const r = await a.send({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', chatId: 'oc' }, 'hi');
	assert.equal(r.via, 'webhook');
	assert.equal(tokenAsked, 0);
});
await checkAsync('成功：POST 到那个 URL，body 带 msg_type/content/sign', async () => {
	const calls = [];
	const a = createFeishuAdapter({
		now: () => 1700000000000,
		fetchImpl: async (url, init) => {
			calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
			return fakeRes(200, { code: 0, msg: 'success' });
		},
	});
	const r = await a.send({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', webhookSecret: 'sec' }, '你好');
	assert.deepEqual(r, { ok: true, via: 'webhook' });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/bot/v2/hook/abc');
	assert.equal(calls[0].body.msg_type, 'text');
	assert.equal(calls[0].body.timestamp, '1700000000');
	assert.equal(calls[0].body.sign, feishuSign('1700000000', 'sec'));
	assert.equal(calls[0].headers['content-type'], 'application/json');
});
await checkAsync('★ 飞书返回 code!=0 ⇒ 抛错且**不重试**（重试只会把同一条拒两遍）', async () => {
	let n = 0;
	const a = createFeishuAdapter({
		fetchImpl: async () => { n += 1; return fakeRes(200, { code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' }); },
	});
	await assert.rejects(() => a.send({ webhookUrl: 'https://x/y', webhookSecret: 's' }, 't'), /飞书拒绝（code=19021/);
	assert.equal(n, 1, `只该请求 1 次，实际 ${n}`);
});
await checkAsync('★ HTTP 非 2xx ⇒ 抛错（不重试）', async () => {
	let n = 0;
	const a = createFeishuAdapter({ fetchImpl: async () => { n += 1; return fakeRes(500, { msg: 'boom' }); } });
	await assert.rejects(() => a.send({ webhookUrl: 'https://x/y' }, 't'), /HTTP 500/);
	assert.equal(n, 1);
});
await checkAsync('★ 网络异常 ⇒ 重试 1 次（共 2 次）后抛错', async () => {
	let n = 0;
	const a = createFeishuAdapter({ fetchImpl: async () => { n += 1; throw new Error('ETIMEDOUT'); } });
	await assert.rejects(() => a.send({ webhookUrl: 'https://x/y' }, 't'), /飞书出站失败：ETIMEDOUT/);
	assert.equal(n, 2, `应重试一次（共 2 次），实际 ${n}`);
});

/* ── 汇总 ──────────────────────────────────────────────────────────── */
const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 飞书适配器单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
