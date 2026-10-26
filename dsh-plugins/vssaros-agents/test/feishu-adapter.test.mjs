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

await checkAsync('★ 没配 webhookUrl ⇒ 直接抛（不静默成功）', async () => {
	const a = createFeishuAdapter({ fetchImpl: async () => fakeRes(200, { code: 0 }) });
	await assert.rejects(() => a.send({}, 'x'), /没有配置飞书 webhook URL/);
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
	assert.deepEqual(r, { ok: true });
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
