// vssaros-browser：时限授权、人机交接、HTTP 路由、ARIA 快照、按目标委托（2026-11-07，P1 / P2）。
// 运行：node dsh-plugins/vssaros-browser/test/assist.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGrantStore, hostMatches, normalizeHostPattern, parseGrants, untilOf } from '../lib/core/grants.js';
import { createHandoffs, resumeText } from '../lib/core/handoff.js';
import { createRouteHandler } from '../lib/core/routes.js';
import { paginate, renderAxTree } from '../lib/core/aria.js';
import { INNER_OPS, parseAction, runBrowserTask } from '../lib/core/task.js';

let pass = 0;
const fail = [];
const check = async (name, fn) => { try { await fn(); pass += 1; } catch (error) { fail.push(`${name} → ${error.stack?.split('\n').slice(0, 3).join(' | ') ?? error}`); } };
const tmp = () => mkdtempSync(join(tmpdir(), 'assist-'));

// ── 时限授权 ───────────────────────────────────────────────────────────────────
await check('授权：三档时限；主机名只认 host / *.host；子域通配不含裸域', () => {
	const now = new Date('2026-11-07T10:00:00');
	assert.equal(Date.parse(untilOf('hour', now)) - now.getTime(), 3_600_000);
	assert.equal(Date.parse(untilOf('week', now)) - now.getTime(), 7 * 86_400_000);
	assert.equal(new Date(untilOf('today', now)).getHours(), 23);
	assert.throws(() => untilOf('forever', now));
	for (const bad of ['', '*', '*.', 'a..b', 'http://x.com', 'x.com:8080', 'x.com/a', '.x.com']) { assert.equal(normalizeHostPattern(bad), undefined, bad); }
	assert.equal(normalizeHostPattern(' GitHub.com '), 'github.com');
	assert.equal(hostMatches('*.github.com', 'gist.github.com'), true);
	assert.equal(hostMatches('*.github.com', 'github.com'), false);
	assert.equal(hostMatches('*.github.com', 'evilgithub.com'), false);
	assert.deepEqual(parseGrants('{oops'), []);
});

await check('授权存储：新增 / 匹配 / 过期即失效 / 撤销；坏文件 = 没有授权', () => {
	const dir = tmp();
	try {
		let clock = Date.parse('2026-11-07T10:00:00Z');
		const store = createGrantStore(join(dir, 'g.json'), () => clock);
		assert.equal(store.match('click', 'shop.example.com'), undefined);
		const g = store.add({ host: 'shop.example.com', duration: 'hour' });
		assert.equal(store.match('click', 'shop.example.com')?.id, g.id);
		assert.equal(store.match('click', 'other.com'), undefined);
		assert.equal(store.match('evaluate', 'shop.example.com'), undefined, 'evaluate 不在可授权动作里');
		assert.equal(store.match('reset', 'shop.example.com'), undefined);
		assert.ok(readFileSync(join(dir, 'g.json'), 'utf8').includes('"version": 1'));
		clock += 3_600_001;
		assert.equal(store.match('click', 'shop.example.com'), undefined, '过期');
		assert.deepEqual(store.list(), []);
		const g2 = store.add({ host: '*.example.com', duration: 'week', ops: ['click', 'evaluate'] });
		assert.deepEqual(g2.ops, ['click'], '不可授权的动作被丢掉');
		assert.equal(store.revoke(g2.id), true);
		assert.equal(store.match('click', 'a.example.com'), undefined);
		assert.throws(() => store.add({ host: 'x.com', duration: 'hour', ops: ['evaluate'] }), /没有可授权的动作/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 交接 ───────────────────────────────────────────────────────────────────────
await check('交接：开卡挡动作；人点完成 ⇒ resume 放行；叫停 ⇒ resume 前一直挡、resume 后放行', () => {
	const h = createHandoffs();
	assert.equal(h.blockOf('S'), undefined);
	const card = h.open({ session: 'S', reason: '扫码登录' });
	assert.match(h.blockOf('S'), /正在等用户/);
	assert.equal(h.blockOf('T'), undefined, '别的会话不受影响');
	assert.match(resumeText(h.resume('S')), /还没开始/);
	assert.equal(h.act(card.id, 'takeover').state, 'taken');
	assert.match(h.blockOf('S'), /用户已接管/);
	assert.equal(h.act(card.id, 'done').state, 'done');
	assert.equal(h.blockOf('S'), undefined, '完成了就不挡');
	assert.match(resumeText(h.resume('S')), /用户已完成/);
	assert.equal(h.act(card.id, 'stop'), undefined, '结束的卡不能再点');
	const c2 = h.open({ session: 'S', reason: '验证码' });
	h.act(c2.id, 'stop');
	assert.match(h.blockOf('S'), /停止/);
	assert.match(resumeText(h.resume('S')), /叫停/);
	assert.equal(h.blockOf('S'), undefined, 'resume 确认后不再挡');
	const c3 = h.open({ session: 'S', reason: '登录', kind: 'login' });
	h.finish('S', 'login');
	assert.equal(h.blockOf('S'), undefined, 'login(done) 验过就收掉');
	assert.equal(h.list().find(c => c.id === c3.id).state, 'done');
	h.forget('S');
	assert.equal(h.list().length, 0);
});

// ── HTTP 路由 ──────────────────────────────────────────────────────────────────
function fakeReq(method, url, { body, headers = {} } = {}) {
	const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
	return Object.assign(req, { method, url, headers });
}
function fakeRes() {
	const res = { status: 0, body: '', writeHead(status) { res.status = status; }, end(text) { res.body = String(text ?? ''); } };
	return res;
}
await check('路由：先过 Host 的围栏；写操作要 JSON + 自定义头；授权 / 交接都写得进去', async () => {
	const dir = tmp();
	try {
		const grants = createGrantStore(join(dir, 'g.json'));
		const handoffs = createHandoffs();
		const card = handoffs.open({ session: 'S', reason: '登录' });
		const handler = createRouteHandler({ grants, handoffs, reject: req => (req.headers.cookie === 'ok' ? undefined : 401), currentUrl: async () => 'https://a.example.com/x' });
		const H = { cookie: 'ok' };
		const W = { ...H, 'content-type': 'application/json', 'x-vssaros-browser': '1' };
		let res = fakeRes(); await handler(fakeReq('GET', '/x/vssaros-browser/api/state'), res);
		assert.equal(res.status, 401, '没过围栏');
		res = fakeRes(); await handler(fakeReq('GET', '/x/vssaros-browser/api/state', { headers: H }), res);
		const state = JSON.parse(res.body);
		assert.equal(state.page, 'https://a.example.com/x'); assert.equal(state.handoffs[0].id, card.id);
		res = fakeRes(); await handler(fakeReq('POST', '/x/vssaros-browser/api/grants', { headers: { ...H, 'content-type': 'application/json' }, body: { host: 'a.example.com', duration: 'hour' } }), res);
		assert.equal(res.status, 403, '缺 x-vssaros-browser 头');
		res = fakeRes(); await handler(fakeReq('POST', '/x/vssaros-browser/api/grants', { headers: W, body: { host: 'a.example.com', duration: 'forever' } }), res);
		assert.equal(res.status, 400);
		res = fakeRes(); await handler(fakeReq('POST', '/x/vssaros-browser/api/grants', { headers: W, body: { host: 'a.example.com', duration: 'hour' } }), res);
		assert.equal(res.status, 200); assert.ok(grants.match('click', 'a.example.com'));
		res = fakeRes(); await handler(fakeReq('POST', '/x/vssaros-browser/api/handoffs/act', { headers: W, body: { id: card.id, action: 'done' } }), res);
		assert.equal(JSON.parse(res.body).handoff.state, 'done');
		res = fakeRes(); await handler(fakeReq('POST', '/x/vssaros-browser/api/grants', { headers: W, body: 'x'.repeat(20_000) }), res);
		assert.equal(res.status, 413);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── ARIA ───────────────────────────────────────────────────────────────────────
await check('ARIA 渲染：层级 + 正文 + 可交互节点编号；透明容器上提；重复文字不重出', () => {
	const v = value => ({ type: 'string', value });
	const nodes = [
		{ nodeId: '1', role: v('RootWebArea'), name: v('Shop'), childIds: ['2', '6'] },
		{ nodeId: '2', role: v('navigation'), name: v(''), childIds: ['3'] },
		{ nodeId: '3', role: v('generic'), name: v(''), childIds: ['4'] },
		{ nodeId: '4', role: v('link'), name: v('首页'), backendDOMNodeId: 40, childIds: ['5'] },
		{ nodeId: '5', role: v('StaticText'), name: v('首页') },
		{ nodeId: '6', role: v('main'), name: v(''), childIds: ['7', '8', '9'] },
		{ nodeId: '7', role: v('heading'), name: v('购物车'), properties: [{ name: 'level', value: { type: 'integer', value: 1 } }] },
		{ nodeId: '8', role: v('StaticText'), name: v('共 3 件商品') },
		{ nodeId: '9', role: v('checkbox'), name: v('全选'), backendDOMNodeId: 90, properties: [{ name: 'checked', value: { type: 'tristate', value: 'true' } }] },
	];
	const { lines, refs } = renderAxTree(nodes);
	assert.deepEqual(lines, ['- navigation', '  - link "首页" [1]', '- main', '  - heading "购物车" [level=1]', '  - text: "共 3 件商品"', '  - checkbox "全选" [checked] [2]']);
	assert.deepEqual(refs, [{ ref: 1, backendDOMNodeId: 40 }, { ref: 2, backendDOMNodeId: 90 }]);
	const pages = paginate(Array.from({ length: 100 }, (_, i) => 'x'.repeat(50) + i), 1000);
	assert.ok(pages.length > 1 && pages.every(p => p.join('\n').length <= 1000));
	assert.equal(pages.flat().length, 100, '分页不丢行');
});

// ── 委托 ───────────────────────────────────────────────────────────────────────
const scripted = replies => {
	const calls = [];
	return { calls, llm: { async *stream(options) { calls.push(options); const reply = replies.shift() ?? '{"done":true,"answer":"(out)"}'; yield { type: 'text-delta', text: reply }; } } };
};
await check('委托：JSON 动作逐步执行；done 收尾；非 JSON 当回答；禁用 op 被拒；步数上限；用量记在会话名下', async () => {
	assert.deepEqual(parseAction('```json\n{"op":"click","ref":3}\n```'), { op: 'click', ref: 3 });
	assert.deepEqual(parseAction('好的 {"op":"type","text":"a}b"} 然后'), { op: 'type', text: 'a}b' });
	assert.equal(parseAction('没有 JSON'), undefined);
	assert.ok(!INNER_OPS.includes('evaluate') && !INNER_OPS.includes('cookies') && !INNER_OPS.includes('task'));
	const executed = [];
	const step = async params => { executed.push(params.op); return params.op === 'snapshot' ? 'Page: X\n[1] button "Go"' : 'ok'; };
	const m = scripted(['{"op":"click","ref":1}', '{"op":"evaluate","expression":"1"}', '{"done":true,"answer":"找到了：张三"}']);
	const out = await runBrowserTask({ goal: '找作者', llm: m.llm, provider: 'p', model: 'm', sessionId: 'S1', step });
	assert.match(out, /找到了：张三/); assert.match(out, /refused/);
	assert.deepEqual(executed, ['snapshot', 'click'], 'evaluate 没被执行');
	assert.ok(m.calls.every(c => c.sessionId === 'S1' && c.purpose === 'browser-task' && c.provider === 'p' && c.model === 'm'));
	const m2 = scripted(Array.from({ length: 20 }, () => '{"op":"scroll","direction":"down","amount":500}'));
	const out2 = await runBrowserTask({ goal: 'g', maxSteps: 3, llm: m2.llm, provider: 'p', model: 'm', step: async () => 'ok' });
	assert.match(out2, /3 步内没完成/); assert.equal(m2.calls.length, 3);
	const m3 = scripted(['这页上没有作者信息。']);
	assert.match(await runBrowserTask({ goal: 'g', llm: m3.llm, provider: 'p', model: 'm', step: async () => 'ok' }), /这页上没有作者信息/);
	const m4 = scripted(['{"op":"click","ref":1}']);
	const out4 = await runBrowserTask({ goal: 'g', llm: m4.llm, provider: 'p', model: 'm',
		step: async p => { if (p.op === 'click') { throw new Error('browser.click 未获准（rejected）⇒ 已拒绝执行'); } return 'ok'; } });
	assert.match(out4, /已停止：browser.click 未获准/); assert.equal(m4.calls.length, 1, '人拒了就不再问模型');
	const m5 = scripted(['{"op":"handoff","text":"请扫码"}']);
	assert.match(await runBrowserTask({ goal: 'g', llm: m5.llm, provider: 'p', model: 'm', step: async () => 'ok' }), /## 交接[\s\S]*请扫码/);
});

// ── 接线：execute 里交接挡动作、task 每步走同一条闸 ─────────────────────────────────
const plugin = await import('../lib/index.js');
const { CdpHost } = await import('../lib/core/host.js');
async function loadTool(config = {}, extra = {}) {
	const dir = tmp();
	const approvals = [];
	let tool;
	const ctx = {
		logger: { info() {}, warn() {} },
		tools: { register(def) { tool = def; return { dispose() {} }; } },
		provide() {}, effect(fn) { fn(); }, on() { return () => {}; },
		get: name => name === 'approval' ? { request: async req => { approvals.push(req); return extra.outcome ?? 'allowed-once'; } } : name === 'llm' ? extra.llm : undefined,
	};
	plugin.apply(ctx, { launchDedicated: true, rightbar: false, dataRoot: dir, allowRulesPath: join(dir, 'none.json'), grantsPath: join(dir, 'grants.json'), settleMs: 0, ...config });
	const sent = [];
	CdpHost.prototype._connection = async function () { return {}; };
	CdpHost.prototype.ensurePage = async () => ({ targetId: 'T1', sessionId: 'S1', url: 'https://shop.example.com/' });
	CdpHost.prototype.command = async (method, params) => {
		sent.push(method);
		if (method === 'Runtime.evaluate') {
			const expr = String(params?.expression ?? '');
			if (expr.includes('cardForm')) { return { result: { value: { found: true, href: 'https://shop.example.com/', tag: 'button', type: '', role: '', autocomplete: '', name: '下一页', cardForm: false } } }; }
			if (expr.includes('getBoundingClientRect')) { return { result: { value: { ok: true, x: 1, y: 1, label: '下一页' } } }; }
			if (expr === 'location.href') { return { result: { value: 'https://shop.example.com/' } }; }
		}
		return { result: { value: null } };
	};
	return { tool, approvals, sent, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const run = (tool, params, agent = { id: 'sess-1' }) => tool.execute(params, { agent, callId: 'c' }).then(v => ({ ok: true, v }), e => ({ ok: false, e: e.message }));

await check('接线：handoff 开卡后动作被拒（只读照常）；时限授权让同站点击免问', async () => {
	const t = await loadTool();
	try {
		const h = await run(t.tool, { op: 'handoff', text: '请扫码登录' });
		assert.match(h.v, /已请用户接手/);
		const blocked = await run(t.tool, { op: 'click', ref: 1 });
		assert.match(blocked.e, /正在等用户/);
		assert.equal(t.approvals.length, 0);
		assert.ok((await run(t.tool, { op: 'resume' })).v.includes('还没开始'));
		// 授权：直接写授权文件（等价于人在右栏页签里点了「1 小时」），换一个会话点击 ⇒ 不问
		const { createGrantStore: store } = await import('../lib/core/grants.js');
		store(join(t.dir, 'grants.json')).add({ host: 'shop.example.com', duration: 'hour' });
		const clicked = await run(t.tool, { op: 'click', ref: 1 }, { id: 'sess-2' });
		assert.equal(clicked.ok, true, clicked.e);
		assert.equal(t.approvals.length, 0, '授权内不问');
	} finally { t.cleanup(); }
});

await check('接线：task 的内层动作照样问人；被拒就停；用当前会话的模型', async () => {
	const m = scripted(['{"op":"click","ref":1}', '{"done":true,"answer":"x"}']);
	const t = await loadTool({}, { llm: m.llm, outcome: 'rejected' });
	try {
		const out = await run(t.tool, { op: 'task', goal: '翻到下一页' }, { id: 'sess-3', options: { provider: 'prov', model: 'mod' } });
		assert.equal(out.ok, true, out.e);
		assert.match(out.v, /已停止：browser.click 未获准/);
		assert.equal(t.approvals.length, 1, '内层点击也走审批');
		assert.equal(m.calls[0].provider, 'prov'); assert.equal(m.calls[0].model, 'mod'); assert.equal(m.calls[0].sessionId, 'sess-3');
		const nested = await run(t.tool, { op: 'task', goal: 'x' }, { id: 'sess-3' });
		assert.match(nested.e, /取不到当前会话的模型/);
	} finally { t.cleanup(); }
});

if (fail.length) {
	console.log(`assist: ${pass} passed, ${fail.length} failed\n  ${fail.join('\n  ')}`);
	process.exit(1);
}
console.log(`assist: ${pass} passed`);
process.exit(0);
