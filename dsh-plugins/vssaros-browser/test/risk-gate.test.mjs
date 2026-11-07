// vssaros-browser：高危动作闸、结果未知记账、站点规则、「页面内容只作数据」（2026-11-07，P1）。
// 纯函数部分直接测；接线部分用一个假 ctx + 假页面（不碰真 Chrome）跑 `execute`，断言审批之前就拒、拒了不碰页面。
// 运行：node dsh-plugins/vssaros-browser/test/risk-gate.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuleReader, entryMatches, hostOf, siteEntryMatches } from '../lib/core/allowRules.js';
import {
	PAGE_DATA_NOTICE, classifyRisk, createOutcomeLedger, deleteConfirmProblem, isCertainFailure, navigationRefusal, withDataNotice,
} from '../lib/core/riskGate.js';

let pass = 0;
const fail = [];
const check = async (name, fn) => { try { await fn(); pass += 1; } catch (error) { fail.push(`${name} → ${error.stack?.split('\n').slice(0, 3).join(' | ') ?? error}`); } };

await check('导航闸：拒 file / javascript / chrome 与云元数据地址；普通 https 与本机放行', () => {
	for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'chrome://settings', 'view-source:https://a.com',
		'http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/', 'http://100.100.100.200/latest', 'http://[fd00:ec2::254]/']) {
		assert.ok(navigationRefusal(url), url);
	}
	for (const url of ['https://github.com/', 'http://localhost:5173/', 'about:blank', '']) { assert.equal(navigationRefusal(url), undefined, url); }
});

const button = (name, extra = {}) => ({ found: true, tag: 'button', type: '', role: '', autocomplete: '', name, cardForm: false, ...extra });
await check('支付：卡号字段输入、付款按钮、卡号表单里回车 ⇒ payment；Tab 与普通按钮不算', () => {
	assert.equal(classifyRisk('type', { ...button(''), tag: 'input', autocomplete: 'cc-number' })?.kind, 'payment');
	for (const name of ['立即支付', '提交订单', 'Pay now', 'Place order', 'Buy now', '确认付款']) { assert.equal(classifyRisk('click', button(name))?.kind, 'payment', name); }
	assert.equal(classifyRisk('click', button('下一步', { cardForm: true, type: 'submit' }))?.kind, 'payment', '卡号表单的提交按钮');
	assert.equal(classifyRisk('pressEnter', { ...button(''), cardForm: true })?.kind, 'payment');
	assert.equal(classifyRisk('pressKey', { ...button(''), cardForm: true }, { key: 'Enter' })?.kind, 'payment');
	assert.equal(classifyRisk('pressKey', { ...button(''), cardForm: true }, { key: 'Tab' }), undefined, 'Tab 不提交');
	for (const name of ['搜索', 'Sign in', '下一页', '支付宝账号设置说明文档里的一大段介绍文字，碰巧有支付两个字但不是按钮也不该被拦下来']) {
		assert.equal(classifyRisk('click', name.length > 40 ? { ...button(name), tag: 'div' } : button(name)), undefined, name);
	}
	assert.equal(classifyRisk('type', { ...button(''), tag: 'input', autocomplete: 'email' }), undefined);
	assert.equal(classifyRisk('click', { found: false }), undefined);
});

await check('删除：删除类按钮要 confirm:true + 逐字 label；对不上就拒', () => {
	const el = button('删除仓库');
	const risk = classifyRisk('click', el);
	assert.equal(risk?.kind, 'delete');
	assert.match(deleteConfirmProblem('click', {}, risk, el), /confirm: true/);
	assert.match(deleteConfirmProblem('click', { confirm: true, label: '删除' }, risk, el), /对不上/);
	assert.equal(deleteConfirmProblem('click', { confirm: true, label: '  删除仓库 ' }, risk, el), undefined);
	assert.equal(classifyRisk('click', button('Delete branch'))?.kind, 'delete');
});

await check('结果未知记账：发出后出错 ⇒ 未观察前拒重放；观察过 / 成功点击后清账；确定的失败不记', () => {
	const ledger = createOutcomeLedger();
	ledger.settle('S', 'click', { ref: 5 }, { ok: false, error: new Error('CDP Input.dispatchMouseEvent timed out'), url: 'https://shop.example/cart' });
	assert.match(ledger.replayRefusal('S', 'click', { ref: 5 }) ?? '', /结果未知/);
	assert.equal(ledger.replayRefusal('S', 'click', { ref: 6 }), undefined, '别的动作不受影响');
	assert.equal(ledger.replayRefusal('T', 'click', { ref: 5 }), undefined, '别的会话不受影响');
	ledger.settle('S', 'snapshot', {}, { ok: true });
	assert.equal(ledger.replayRefusal('S', 'click', { ref: 5 }), undefined, 'snapshot 之后可以重新决定');
	ledger.settle('S', 'type', { ref: 2 }, { ok: false, error: new Error('ref [2] not found on the page (ref-not-found)') });
	assert.equal(ledger.pending('S'), undefined, 'ref 不在 = 没发出去，不记');
	ledger.settle('S', 'pressEnter', {}, { ok: false, error: new Error('socket hang up') });
	assert.ok(ledger.replayRefusal('S', 'pressEnter', {}));
	ledger.settle('S', 'click', { ref: 9 }, { ok: true });
	assert.equal(ledger.pending('S'), undefined, '成功点击带回新快照 = 观察过');
	assert.equal(isCertainFailure(new Error('browser.click 未获准（rejected）')), true);
});

await check('站点规则：browser::click@host（含 glob）只在那个站点命中；不带 @ 的语义不变；IDE 侧读者不会误命中', () => {
	assert.equal(siteEntryMatches('browser::click@github.com', 'browser', 'click', 'github.com'), true);
	assert.equal(siteEntryMatches('browser::click@github.com', 'browser', 'click', 'gitlab.com'), false);
	assert.equal(siteEntryMatches('browser::*@*.example.com', 'browser', 'type', 'docs.example.com'), true);
	assert.equal(siteEntryMatches('browser::click@github.com', 'browser', 'click', ''), false, '读不到站点 ⇒ 不命中');
	assert.equal(siteEntryMatches('browser::click', 'browser', 'click', 'github.com'), false);
	assert.equal(entryMatches('browser::click@github.com', 'browser', 'click'), false, 'IDE 侧同构读者不把它当 browser::click');
	assert.equal(hostOf('https://GitHub.com/a'), 'github.com');
	const dir = mkdtempSync(join(tmpdir(), 'allow-'));
	try {
		const file = join(dir, 'tool-allow.json');
		writeFileSync(file, JSON.stringify({ global: ['browser::click@github.com', 'browser::scroll'] }));
		const reader = createRuleReader(file);
		assert.equal(reader.match('browser', 'click', 'github.com'), 'browser::click@github.com');
		assert.equal(reader.match('browser', 'click', 'evil.com'), undefined);
		assert.equal(reader.match('browser', 'click'), undefined, '不给站点 ⇒ 站点条目不命中');
		assert.equal(reader.match('browser', 'scroll'), 'browser::scroll');
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

await check('页面内容只作数据：带页面内容的结果首行加声明，其余不加、不重复加', () => {
	assert.ok(withDataNotice('snapshot', 'Page: x').startsWith(PAGE_DATA_NOTICE));
	assert.equal(withDataNotice('snapshot', withDataNotice('snapshot', 'x')).split(PAGE_DATA_NOTICE).length, 2);
	assert.equal(withDataNotice('status', '{}'), '{}');
	assert.equal(withDataNotice('type', 'Typed'), 'Typed');
});

// ── 接线：假 ctx + 假页面跑 execute ──────────────────────────────────────────────
const plugin = await import('../lib/index.js');
/** 一个只认 Runtime.evaluate 的假 CDP 宿主：`elements` 给出 ref → 元素信息；记下发过的命令。 */
function fakeWorld(elements, href = 'https://shop.example/cart') {
	const sent = [];
	return {
		sent,
		answer(method, params) {
			sent.push(method);
			if (method === 'Runtime.evaluate') {
				const expression = String(params?.expression ?? '');
				const ref = /data-saros-ref="(\d+)"/.exec(expression)?.[1];
				if (expression.includes('cardForm')) {
					const el = ref === undefined ? elements.focus : elements[ref];
					return { result: { value: el ? { ...el, href } : { found: false, href } } };
				}
				// client.click 的定位脚本：元素在 ⇒ 给个坐标
				if (ref !== undefined && expression.includes('getBoundingClientRect')) {
					return { result: { value: elements[ref] ? { ok: true, x: 10, y: 10, label: elements[ref].name } : { ok: false, reason: 'ref-not-found' } } };
				}
				return { result: { value: null } };
			}
			return {};
		},
	};
}
async function loadTool(world, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'risk-'));
	const approvals = [];
	let tool;
	const ctx = {
		logger: { info() {}, warn() {} },
		tools: { register(def) { tool = def; return { dispose() {} }; } },
		provide() {}, effect(fn) { fn(); }, on() { return () => {}; },
		get: name => name === 'approval' ? { request: async req => { approvals.push(req); return options.outcome ?? 'allowed-once'; } } : undefined,
	};
	plugin.apply(ctx, { launchDedicated: true, rightbar: false, dataRoot: dir, allowRulesPath: join(dir, 'none.json'), settleMs: 0, ...options.config });
	// 把 CDP 宿主换成假的：页面已在、命令由 world 应答
	const { CdpHost } = await import('../lib/core/host.js');
	CdpHost.prototype._connection = async function () { return {}; };
	CdpHost.prototype.ensurePage = async () => ({ targetId: 'T1', sessionId: 'S1', url: 'https://shop.example/cart' });
	CdpHost.prototype.command = async (method, params) => world.answer(method, params);
	return { tool, approvals, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const run = (tool, params, agent = 'sess-1') => tool.execute(params, { agent: { id: agent }, callId: 'c1' }).then(v => ({ ok: true, v }), e => ({ ok: false, e: e.message }));

await check('接线：付款按钮在审批之前就拒，且不发任何输入事件', async () => {
	const world = fakeWorld({ 3: button('立即支付') });
	const { tool, approvals, cleanup } = await loadTool(world, { config: { allowActions: true } });
	try {
		const r = await run(tool, { op: 'click', ref: 3 });
		assert.equal(r.ok, false); assert.match(r.e, /付款 \/ 下单永远由人自己完成/);
		assert.equal(approvals.length, 0, '不为必然被拒的调用问人');
		assert.ok(!world.sent.some(m => m.startsWith('Input.')), '没碰页面');
	} finally { cleanup(); }
});

await check('接线：删除按钮——缺 confirm 先拒；带对 confirm+label 时即使 allowActions 也要问人', async () => {
	const world = fakeWorld({ 4: button('删除仓库') });
	const { tool, approvals, cleanup } = await loadTool(world, { config: { allowActions: true }, outcome: 'rejected' });
	try {
		const r1 = await run(tool, { op: 'click', ref: 4 });
		assert.match(r1.e, /confirm: true/); assert.equal(approvals.length, 0);
		const r2 = await run(tool, { op: 'click', ref: 4, confirm: true, label: '删除仓库' });
		assert.match(r2.e, /未获准/); assert.equal(approvals.length, 1, 'allowActions 也放不过删除');
		assert.match(approvals[0].displayReason.zh, /删除/);
		assert.ok(!world.sent.some(m => m.startsWith('Input.')));
	} finally { cleanup(); }
});

await check('接线：导航到元数据地址在审批之前就拒', async () => {
	const world = fakeWorld({});
	const { tool, approvals, cleanup } = await loadTool(world, {});
	try {
		const r = await run(tool, { op: 'navigate', url: 'http://169.254.169.254/latest/meta-data/' });
		assert.match(r.e, /元数据/); assert.equal(approvals.length, 0); assert.ok(!world.sent.includes('Page.navigate'));
	} finally { cleanup(); }
});

await check('接线：点击发出后出错 ⇒ 未 snapshot 前拒重放（不再发事件）', async () => {
	const world = fakeWorld({ 7: button('发送') });
	const { tool, cleanup } = await loadTool(world, { config: { allowActions: true } });
	const { CdpHost } = await import('../lib/core/host.js');
	try {
		CdpHost.prototype.command = async (method, params) => { if (method.startsWith('Input.')) { throw new Error('CDP Input.dispatchMouseEvent timed out'); } return world.answer(method, params); };
		const r1 = await run(tool, { op: 'click', ref: 7 });
		assert.match(r1.e, /timed out/);
		const before = world.sent.length;
		const r2 = await run(tool, { op: 'click', ref: 7 });
		assert.match(r2.e, /拒绝重放/);
		assert.equal(world.sent.length, before, '重放被拒时不碰页面');
		const r3 = await run(tool, { op: 'click', ref: 7 }, 'sess-2');
		assert.match(r3.e, /timed out/, '别的会话不受影响');
	} finally { cleanup(); }
});

if (fail.length) {
	console.log(`risk-gate: ${pass} passed, ${fail.length} failed\n  ${fail.join('\n  ')}`);
	process.exit(1);
}
console.log(`risk-gate: ${pass} passed`);
process.exit(0);
