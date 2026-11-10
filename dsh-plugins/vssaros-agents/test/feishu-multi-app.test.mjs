// @vssaros/dsh-agents — 多飞书应用单测（2026-11-04）
//   跑法：node dsh-plugins/vssaros-agents/test/feishu-multi-app.test.mjs
//
// 需求：一个客户端里不同 bot 用不同的飞书应用（各自 appId / appSecret）。
// 这里守的是几类"静默错"：
//   ① 额外应用把默认应用的凭据/开关写没了（老绑定、老入站突然失效）；
//   ② 同一应用在一台机器上连了两条（飞书只推给随机一条 ⇒ 一半消息丢失，日志还是绿的）；
//   ③ bot B 拿着 bot A 应用的 token 发消息（以错误的机器人出现，或被拒）；
//   ④ 消息路由到另一个应用的绑定上（A 应用收到的消息交给了 B 应用的 bot）。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	describeFeishuApps, readBotFeishuApps, readImAccounts, resolveFeishuApp,
	saveBotFeishuApp, saveFeishu, saveFeishuApp,
} from '../lib/imCredentials.js';
import { readFeishuAppsEnabled, readInboundEnabled, setFeishuAppEnabled, setInboundEnabled } from '../lib/imInboundState.js';
import { acquireFeishuAppLock, feishuAppHolder, feishuAppLockKey } from '../lib/imFeishuAppLock.js';
import { imLockPath, tryAcquireImLock } from '../lib/imInboundLock.js';
import { createFeishuAppInbounds } from '../lib/feishuAppInbounds.js';
import {
	allowDeadLetterSender, createBinding, createBindingHub, deleteBinding,
	dispatchImToAgent, findBindingForChat, inboundKeyOf, updateBinding,
} from '../lib/bindings.js';
import { listDeadLetters, recordDeadLetter } from '../lib/deadLetters.js';
import { createFeishuAdapter } from '../lib/adapters/feishu.js';
import { createFeishuGateway } from '../lib/adapters/feishuInbound.js';
import { appIdOfEvent, feishuEventBus } from '../lib/feishuEventBus.js';

let pass = 0;
const fails = [];
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'vsa-multi-app-')); dirs.push(d); return d; };
const configOf = () => ({ dataRoot: tmp() });
const A = 'cli_aaaa1111', B = 'cli_bbbb2222', C = 'cli_cccc3333';

/* ── ① 凭据：默认应用不变，额外应用另存 ─────────────────────────────── */
await checkAsync('额外应用另存，不动默认应用；secret 不进视图', async () => {
	const config = configOf();
	await saveFeishu(config, { appId: A, appSecret: 'sa' });
	const apps = await saveFeishuApp(config, { appId: B, appSecret: 'sb', name: '测试机器人' });
	assert.deepEqual(apps.map((x) => [x.appId, x.isDefault, x.configured, x.name]), [[A, true, true, ''], [B, false, true, '测试机器人']]);
	assert.ok(!JSON.stringify(apps).includes('sb') && !JSON.stringify(apps).includes('sa'), 'secret 明文进了视图');
	const acc = await readImAccounts(config);
	assert.equal(acc.feishu.appId, A);
	assert.equal(acc.feishuApps[B].appSecret, 'sb');
});
await checkAsync('改默认应用凭据不会抹掉额外应用', async () => {
	const config = configOf();
	await saveFeishuApp(config, { appId: B, appSecret: 'sb' });
	await saveFeishu(config, { appId: A, appSecret: 'sa' });
	assert.equal((await readImAccounts(config)).feishuApps[B].appSecret, 'sb');
});
await checkAsync('解析：空/默认 ⇒ 默认应用；额外 ⇒ 自己的 secret；未知 ⇒ 未配置', async () => {
	const config = configOf();
	await saveFeishu(config, { appId: A, appSecret: 'sa' });
	await saveFeishuApp(config, { appId: B, appSecret: 'sb' });
	assert.deepEqual([await resolveFeishuApp(config, ''), await resolveFeishuApp(config, A)].map((x) => [x.appId, x.appSecret, x.isDefault]),
		[[A, 'sa', true], [A, 'sa', true]]);
	const b = await resolveFeishuApp(config, B);
	assert.deepEqual([b.appId, b.appSecret, b.configured, b.isDefault], [B, 'sb', true, false]);
	const c = await resolveFeishuApp(config, C);
	assert.deepEqual([c.configured, c.appSecret], [false, '']);
});
await checkAsync('改名/留空 secret 保留原值；删除；拒绝默认重复、坏 appId、bot 写入', async () => {
	const config = configOf();
	await saveFeishu(config, { appId: A, appSecret: 'sa' });
	await saveFeishuApp(config, { appId: B, appSecret: 'sb' });
	await saveFeishuApp(config, { appId: B, name: '改名' });
	assert.equal((await readImAccounts(config)).feishuApps[B].appSecret, 'sb', '留空 secret 被清掉了');
	await assert.rejects(saveFeishuApp(config, { appId: A, appSecret: 'x' }), (e) => e.httpStatus === 409);
	await assert.rejects(saveFeishuApp(config, { appId: 'bad id', appSecret: 'x' }), (e) => e.httpStatus === 400);
	await assert.rejects(saveFeishuApp(config, { appId: C }), (e) => e.httpStatus === 400, '新应用没 secret 应拒');
	await assert.rejects(saveFeishuApp(config, { appId: C, appSecret: 'x', actor: { kind: 'bot' } }), (e) => e.httpStatus === 403);
	const left = await saveFeishuApp(config, { appId: B, remove: true });
	assert.deepEqual(left.map((x) => x.appId), [A]);
	assert.equal((await readImAccounts(config)).feishuApps, undefined);
	assert.equal((await describeFeishuApps(config)).length, 1);
});

/* ── 入站开关：额外应用单独记，写默认平台时不丢 ─────────────────────── */
await checkAsync('额外应用的「上次已启动」与平台开关互不覆盖', async () => {
	const config = configOf();
	await setFeishuAppEnabled(config, B, true);
	await setInboundEnabled(config, 'feishu', true);
	await setInboundEnabled(config, 'telegram', true);
	assert.deepEqual(await readFeishuAppsEnabled(config), { [B]: true });
	assert.equal((await readInboundEnabled(config)).feishu, true);
	await setFeishuAppEnabled(config, B, false);
	assert.deepEqual(await readFeishuAppsEnabled(config), {});
	assert.equal((await readInboundEnabled(config)).telegram, true);
});

/* ── ② 每个应用一条连接：按应用的锁 ─────────────────────────────────── */
const lockAt = (home, key, body) => writeFileSync(imLockPath(key, home), JSON.stringify({ format: 1, platform: key, heartbeatAt: Date.now(), ...body }));
check('锁键：feishu-<appId 小写>，坏 appId 直接拒', () => {
	assert.equal(feishuAppLockKey('cli_AbC123'), 'feishu-cli_abc123');
	assert.throws(() => feishuAppLockKey('../x'));
});
await checkAsync('占用判断：别人的应用锁；别人的老锁且同应用；老锁没写 appId 时读其默认应用', async () => {
	const home = tmp();
	const alive = () => true;
	assert.equal(await feishuAppHolder(A, { home, isAlive: alive, pid: 1 }), null);
	lockAt(home, feishuAppLockKey(B), { pid: 777, dataRoot: 'x' });
	assert.equal((await feishuAppHolder(B, { home, isAlive: alive, pid: 1 })).lock, 'app');
	assert.equal(await feishuAppHolder(B, { home, isAlive: alive, pid: 777 }), null, '自己的锁不算别人占着');
	assert.equal(await feishuAppHolder(B, { home, isAlive: () => false, pid: 1 }), null, '死进程的锁不算');
	lockAt(home, 'feishu', { pid: 888, dataRoot: 'r', appId: A });
	assert.equal((await feishuAppHolder(A, { home, isAlive: alive, pid: 1 })).lock, 'legacy');
	assert.equal(await feishuAppHolder(C, { home, isAlive: alive, pid: 1 }), null, '老锁是别的应用 ⇒ 不冲突');
	const root = tmp();
	writeFileSync(join(root, 'agent-im-accounts.json'), JSON.stringify({ version: 1, accounts: { feishu: { appId: C, appSecret: 's' } } }));
	lockAt(home, 'feishu', { pid: 888, dataRoot: root });
	assert.equal((await feishuAppHolder(C, { home, isAlive: alive, pid: 1 })).dataRoot, root, '老版本锁要回落读持有者的默认应用');
});
await checkAsync('拿锁：默认应用拿应用锁 + 老锁；额外应用只拿应用锁；释放后都删', async () => {
	const home = tmp();
	const def = await acquireFeishuAppLock(A, { isDefault: true, home, heartbeat: false });
	assert.deepEqual(def.keys, [feishuAppLockKey(A), 'feishu']);
	assert.equal(JSON.parse(readFileSync(imLockPath('feishu', home), 'utf8')).appId, A, '老锁要写 appId 给别人判断');
	const extra = await acquireFeishuAppLock(B, { home, heartbeat: false });
	assert.deepEqual(extra.keys, [feishuAppLockKey(B)]);
	await def.release(); await extra.release();
	assert.ok(![feishuAppLockKey(A), 'feishu', feishuAppLockKey(B)].some((k) => existsSync(imLockPath(k, home))));
});
await checkAsync('别人占着同一应用 ⇒ 拿不到并说明谁占着', async () => {
	const home = tmp();
	lockAt(home, feishuAppLockKey(B), { pid: 4242, dataRoot: 'other' });
	const r = await acquireFeishuAppLock(B, { home, heartbeat: false, isAlive: () => true });
	assert.equal(r.ok, false);
	assert.equal(r.holder.pid, 4242);
});

/* ── 管理器：归一、单连接、锁随连接走 ───────────────────────────────── */
function fakeGateway(onStart) {
	let st = { status: 'idle', lastError: '' };
	let starts = 0;
	return {
		get starts() { return starts; },
		async start() { starts += 1; st = onStart ? onStart() : { status: 'ready', lastError: '' }; },
		async stop() { st = { status: 'stopped', lastError: '' }; },
		state() { return { ...st }; },
	};
}
function manager({ defaultAppId = A, acquireOk = true, onStart } = {}) {
	const made = new Map(); const acquired = []; const released = [];
	const def = fakeGateway(onStart);
	const m = createFeishuAppInbounds({
		defaultGateway: def,
		makeGateway: (id) => { const g = fakeGateway(onStart); made.set(id, g); return g; },
		resolveDefaultAppId: async () => defaultAppId,
		acquire: async (appId, opts) => {
			acquired.push([appId, opts.isDefault]);
			return acquireOk ? { ok: true, release: async () => { released.push(appId); } } : { ok: false, holder: { pid: 9, appId } };
		},
		describeHolder: (h) => `占用 ${h.appId}`,
	});
	return { m, def, made, acquired, released };
}
await checkAsync('等于默认应用的 appId 归到默认网关（同进程不会对同一应用连两次）', async () => {
	const { m, def, made, acquired } = manager();
	assert.equal(await m.keyOf(A), '');
	await m.start(A);
	assert.equal(def.starts, 1);
	assert.equal(made.size, 0);
	assert.deepEqual(acquired, [[A, true]]);
});
await checkAsync('额外应用：按需建网关、拿自己的锁；已连时再 start 不会多开一条', async () => {
	const { m, made, acquired } = manager();
	await m.start(B);
	await m.start(B);
	assert.equal(made.get(B).starts, 1, '重复 start 开了第二条连接');
	assert.deepEqual(acquired, [[B, false]]);
	assert.deepEqual(Object.keys(m.appStates()), [B]);
});
await checkAsync('锁被占 ⇒ 409 且不连；不可恢复错误 ⇒ 放锁；stop/forget ⇒ 放锁', async () => {
	const busy = manager({ acquireOk: false });
	await assert.rejects(busy.m.start(B), (e) => e.httpStatus === 409 && /占用/.test(e.message));
	/* ★ 2026-11-09：抢锁失败时**不再**预先建网关（原来会留一个永不启动的 idle 网关）。 */
	assert.equal(busy.made.size, 0, '锁被占不许连，也不许残留网关');
	assert.equal((busy.made.get(B)?.starts ?? 0), 0);
	assert.deepEqual(Object.keys(busy.m.appStates()), []);
	const dead = manager({ onStart: () => ({ status: 'error', lastError: 'unavailable：缺少 app_secret' }) });
	await dead.m.start(B);
	assert.deepEqual(dead.released, [B]);
	assert.equal(dead.m.holds(B), false);
	const ok = manager();
	await ok.m.start(B); await ok.m.stop(B);
	assert.deepEqual(ok.released, [B]);
	await ok.m.start(C); await ok.m.forget(C);
	assert.deepEqual(ok.released, [B, C]);
	assert.deepEqual(Object.keys(ok.m.appStates()), [B]);
});
await checkAsync('默认应用换成了一个正在跑的额外应用 ⇒ 拒绝再连默认', async () => {
	let def = A;
	const made = new Map();
	const m = createFeishuAppInbounds({
		defaultGateway: fakeGateway(), makeGateway: (id) => { const g = fakeGateway(); made.set(id, g); return g; },
		resolveDefaultAppId: async () => def, acquire: async () => ({ ok: true, release: async () => undefined }),
	});
	await m.start(B);
	def = B;
	await assert.rejects(m.start(''), (e) => e.httpStatus === 409);
});

/* ── ④ 路由：按 (飞书应用, chatId) 匹配 ─────────────────────────────── */
check('老绑定（无 appId）只收默认应用的消息；额外应用的绑定只收自己的', () => {
	const list = [
		{ id: 'old', platform: 'feishu', chatId: 'oc_1' },
		{ id: 'b', platform: 'feishu', chatId: 'oc_1', appId: B },
		{ id: 'tg', platform: 'telegram', chatId: 'oc_1' },
	];
	assert.equal(findBindingForChat(list, 'feishu', 'oc_1').id, 'old', '不传 opts 的老调用行为必须不变');
	assert.equal(findBindingForChat(list, 'feishu', 'oc_1', { appId: '', defaultAppId: A }).id, 'old');
	assert.equal(findBindingForChat(list, 'feishu', 'oc_1', { appId: A, defaultAppId: A }).id, 'old');
	assert.equal(findBindingForChat(list, 'feishu', 'oc_1', { appId: B, defaultAppId: A }).id, 'b');
	assert.equal(findBindingForChat(list, 'feishu', 'oc_1', { appId: C, defaultAppId: A }), null);
	assert.equal(findBindingForChat(list, 'telegram', 'oc_1', { appId: B }).id, 'tg', '非飞书不看应用');
});
const AGENTS = { scanAgents: async () => ({ agents: [{ id: 'coder', name: 'Coder' }, { id: 'arch', name: 'Arch' }] }) };
await checkAsync('同一个群可以被不同应用的机器人各绑一个 bot；同应用重复仍 409', async () => {
	const config = configOf();
	const deps = { ...AGENTS, appConfigured: async () => true, defaultFeishuAppId: async () => A };
	await createBinding(config, { platform: 'feishu', chatId: 'oc_g', targetId: 'coder' }, deps);
	const { binding } = await createBinding(config, { platform: 'feishu', chatId: 'oc_g', targetId: 'arch', appId: B }, deps);
	assert.equal(binding.appId, B);
	await assert.rejects(createBinding(config, { platform: 'feishu', chatId: 'oc_g', targetId: 'arch', appId: B }, deps),
		(e) => e.httpStatus === 409);
	await assert.rejects(createBinding(config, { platform: 'feishu', chatId: 'oc_g', targetId: 'arch', appId: A }, deps),
		(e) => e.httpStatus === 409, '显式写默认应用 = 与老绑定冲突');
});
await checkAsync('appId 写成默认应用会存成空；更新可清掉 appId；未配置的应用拒绝绑定', async () => {
	const config = configOf();
	const deps = { ...AGENTS, appConfigured: async (_p, id) => id !== C, defaultFeishuAppId: async () => A };
	const { binding } = await createBinding(config, { platform: 'feishu', chatId: 'oc_x', targetId: 'coder', appId: A }, deps);
	assert.equal('appId' in binding, false);
	const moved = await updateBinding(config, { id: binding.id, appId: B }, deps);
	assert.equal(moved.binding.appId, B);
	const back = await updateBinding(config, { id: binding.id, appId: '' }, deps);
	assert.equal('appId' in back.binding, false, '清空 appId 没生效（旧值被展开留下了）');
	await assert.rejects(createBinding(config, { platform: 'feishu', chatId: 'oc_y', targetId: 'coder', appId: C }, deps),
		(e) => e.httpStatus === 400 && e.message.includes(C));
});
await checkAsync('入站：别的应用的消息不会落到这条绑定上', async () => {
	const config = configOf();
	writeFileSync(join(config.dataRoot, 'agent-bindings.json'), JSON.stringify({ version: 1, bindings: [
		{ id: 'b', platform: 'feishu', chatId: 'oc_z', chatType: 'p2p', targetKind: 'agent', targetId: 'coder', appId: B, enabled: true, direction: 'both', allowFrom: [] },
	] }));
	const hub = createBindingHub({ config, log: () => undefined, defaultFeishuAppId: async () => A, scanAgents: AGENTS.scanAgents });
	const other = await hub.handleInbound({ platform: 'feishu', appId: C, chatId: 'oc_z', chatType: 'p2p', messageId: 'om_1', userId: 'ou_u', content: 'hi' });
	assert.equal(other.reason, 'unbound');
	const viaDefault = await hub.handleInbound({ platform: 'feishu', chatId: 'oc_z', chatType: 'p2p', messageId: 'om_2', userId: 'ou_u', content: 'hi' });
	assert.equal(viaDefault.reason, 'unbound', '默认应用的消息不该进额外应用的绑定');
	const own = await hub.handleInbound({ platform: 'feishu', appId: B, chatId: 'oc_z', chatType: 'p2p', messageId: 'om_3', userId: 'ou_u', content: 'hi' });
	assert.notEqual(own.reason, 'unbound', '自己应用的消息应当匹配到绑定');
	assert.equal(hub.recentChats().find((x) => x.appId === B)?.chatId, 'oc_z', '最近会话要带出应用');
});

/* ── ③ 出站：按绑定的应用取凭据，token 分开缓存 ────────────────────── */
await checkAsync('两条绑定走两个应用：各换各的 token、各用各的 Bearer', async () => {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push({ url, auth: init.headers.authorization || '', app: body.app_id || '' });
		if (url.includes('tenant_access_token')) {
			return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok-' + body.app_id, expire: 7200 }));
		}
		return new Response(JSON.stringify({ code: 0 }));
	};
	const secrets = { '': ['cli_dflt0000', 'sd'], [B]: [B, 'sb'] };
	const asked = [];
	const adapter = createFeishuAdapter({ fetchImpl, resolveApp: async (appId) => {
		asked.push(appId);
		const [id, secret] = secrets[appId] || [];
		return id ? { appId: id, appSecret: secret, configured: true } : { configured: false };
	} });
	await adapter.send({ chatId: 'oc_1', appId: '' }, 'a');
	await adapter.send({ chatId: 'oc_2', appId: B }, 'b');
	await adapter.send({ chatId: 'oc_2', appId: B }, 'c');
	const sends = calls.filter((c) => c.url.includes('im/v1/messages'));
	assert.deepEqual(sends.map((c) => c.auth), ['Bearer tok-cli_dflt0000', `Bearer tok-${B}`, `Bearer tok-${B}`]);
	assert.equal(calls.filter((c) => c.url.includes('tenant_access_token')).length, 2, 'token 没按应用缓存');
	assert.deepEqual(asked, ['', B, B]);
	await assert.rejects(adapter.send({ chatId: 'oc_3', appId: C }, 'x'), (e) => /cli_cccc3333/.test(e.message));
});
await checkAsync('路由层把绑定的应用交给适配器', async () => {
	const config = configOf();
	const got = [];
	const hub = createBindingHub({ config, log: () => undefined });
	hub.register({ id: 'feishu', async send(ctx) { got.push([ctx.appId, ctx.sessionKey]); } });
	await hub.deliver({ id: 'x', platform: 'feishu', chatId: 'oc_9', appId: B, enabled: true, direction: 'both' }, 'hi');
	await hub.deliver({ id: 'y', platform: 'feishu', chatId: 'oc_9', enabled: true, direction: 'both' }, 'hi');
	assert.deepEqual(got, [[B, `chat:feishu:${B}:oc_9`], ['', 'chat:feishu:oc_9']]);
});

/* ── 进程内扇出：同一应用只有一条连接，别的插件共用它 ─────────────── */
await checkAsync('总线：按应用订阅/投递；一个订阅者抛错不挡别人；退订后不再收到', async () => {
	const root = {};
	const bus = feishuEventBus(root);
	assert.equal(feishuEventBus(root), bus, '同一 root 必须拿到同一条总线（HMR 后订阅不能丢）');
	const got = [];
	const off = bus.subscribe(A, (p) => { got.push(['a', p.n]); });
	bus.subscribe(A, () => { throw new Error('boom'); });
	bus.subscribe(B, (p) => { got.push(['b', p.n]); });
	assert.equal(bus.publish(A, { n: 1 }), 1, '只数成功投递的订阅者');
	assert.equal(bus.publish(C, { n: 2 }), 0);
	off();
	bus.publish(A, { n: 3 });
	bus.publish(B, { n: 4 });
	assert.deepEqual(got, [['a', 1], ['b', 4]]);
	assert.equal(appIdOfEvent({ header: { app_id: ' cli_x ' } }), 'cli_x');
});
await checkAsync('总线：active 跟着提供方的连接状态走；撤销只撤自己登记的那份', async () => {
	const bus = feishuEventBus({});
	let status = 'ready';
	const withdraw = bus.provide(A, () => ({ status }));
	assert.equal(bus.active(A), true);
	status = 'connecting'; assert.equal(bus.active(A), true);
	status = 'error'; assert.equal(bus.active(A), false);
	status = 'ready';
	const second = bus.provide(A, () => ({ status: 'ready' }));
	withdraw();
	assert.equal(bus.active(A), true, '旧登记撤销时把新登记也撤了');
	second();
	assert.equal(bus.active(A), false);
});
await checkAsync('网关：原始事件先扇出、再按 Bots 自己的逻辑解析；扇出出错不影响 Bots', async () => {
	let onEvent;
	const raw = []; const parsed = [];
	const gw = createFeishuGateway({
		transport: { async start(h) { onEvent = h.onEvent; return { close() {} }; } },
		onRaw: (p) => { raw.push(p.header.event_id); if (p.header.event_id === 'e2') { throw new Error('subscriber bug'); } },
		onMessage: (m) => { parsed.push(m.messageId); },
		log: () => undefined,
	});
	await gw.start();
	const ev = (id, mid) => ({ schema: '2.0', header: { event_id: id, event_type: 'im.message.receive_v1', app_id: A },
		event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_u' } },
			message: { message_id: mid, chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: '{"text":"hi"}' } } });
	onEvent(ev('e1', 'om_1')); onEvent(ev('e2', 'om_2'));
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(raw, ['e1', 'e2']);
	assert.deepEqual(parsed, ['om_1', 'om_2']);
	await gw.stop();
});
await checkAsync('管理器：连上后登记为提供方，stop / 不可恢复时撤销', async () => {
	const bus = feishuEventBus({});
	const make = (onStart) => createFeishuAppInbounds({
		defaultGateway: fakeGateway(onStart), makeGateway: () => fakeGateway(onStart),
		resolveDefaultAppId: async () => A, acquire: async () => ({ ok: true, release: async () => undefined }), bus,
	});
	const m = make();
	await m.start(B);
	assert.equal(bus.active(B), true);
	await m.start('');
	assert.deepEqual([bus.active(A), m.defaultAppId()], [true, A]);
	await m.stop(B);
	assert.equal(bus.active(B), false);
	const dead = make(() => ({ status: 'error', lastError: 'unavailable：缺少 app_secret' }));
	await dead.start(C);
	assert.equal(bus.active(C), false);
});

/* ── ⑥ 2026-11-09 防串台回归：两个应用同时收同一条消息 & 辅助键按应用隔离 ── */
check('★ 入站幂等键按应用分开；老调用（无 appId / 无 default）键逐字不变', () => {
	const base = { platform: 'feishu', messageId: 'om_same', userId: 'ou_u', content: 'hi' };
	assert.notEqual(inboundKeyOf({ ...base, appId: A }, A), inboundKeyOf({ ...base, appId: B }, A),
		'同一条消息在两个应用里必须各算「第一次」');
	assert.equal(inboundKeyOf(base, ''), 'feishu:om_same', '老键不许变（否则存量落盘键全量重放）');
	assert.equal(inboundKeyOf({ platform: 'telegram', messageId: 'x' }, ''), 'telegram:x', '非飞书不受影响');
	assert.notEqual(inboundKeyOf({ platform: 'feishu', userId: 'ou_u', content: 'hi' }, A),
		inboundKeyOf({ platform: 'feishu', appId: B, userId: 'ou_u', content: 'hi' }, A), '退化键也要带应用');
});
await checkAsync('★ 同一 messageId 由两个应用先后送达 ⇒ 两条各进自己的绑定（不是 duplicate）', async () => {
	const config = configOf();
	writeFileSync(join(config.dataRoot, 'agent-bindings.json'), JSON.stringify({ version: 1, bindings: [
		{ id: 'a', platform: 'feishu', chatId: 'oc_g', chatType: 'p2p', targetKind: 'agent', targetId: 'coder', enabled: true, direction: 'both', allowFrom: [] },
		{ id: 'b', platform: 'feishu', chatId: 'oc_g', chatType: 'p2p', targetKind: 'agent', targetId: 'arch', appId: B, enabled: true, direction: 'both', allowFrom: [] },
	] }));
	const hub = createBindingHub({
		config, log: () => undefined, defaultFeishuAppId: async () => A, scanAgents: AGENTS.scanAgents,
		dispatchAgent: async (_cfg, binding) => ({ sessionId: 's-' + binding.id }),
	});
	const base = { platform: 'feishu', chatId: 'oc_g', chatType: 'p2p', messageId: 'om_same', userId: 'ou_u', content: 'hi' };
	const r1 = await hub.handleInbound({ ...base, appId: A });
	const r2 = await hub.handleInbound({ ...base, appId: B });
	assert.notEqual(r1.reason, 'duplicate');
	assert.notEqual(r2.reason, 'duplicate', '第二个应用的消息被静默丢掉了 ✗');
	assert.equal(r1.binding?.id, 'a');
	assert.equal(r2.binding?.id, 'b');
	assert.equal((await hub.handleInbound({ ...base, appId: A })).reason, 'duplicate', '同一应用重投仍要去重');
});
await checkAsync('删除绑定按应用精确匹配；多条候选且没指定 ⇒ 拒删不误伤', async () => {
	const config = configOf();
	const deps = { ...AGENTS, appConfigured: async () => true, defaultFeishuAppId: async () => A };
	await createBinding(config, { platform: 'feishu', chatId: 'oc_del', targetId: 'coder' }, deps);
	const { binding: bb } = await createBinding(config, { platform: 'feishu', chatId: 'oc_del', targetId: 'arch', appId: B }, deps);
	await assert.rejects(deleteBinding(config, { platform: 'feishu', chatId: 'oc_del' }), (e) => e.httpStatus === 409);
	const out = await deleteBinding(config, { platform: 'feishu', chatId: 'oc_del', appId: B });
	assert.equal(out.removed, 1);
	assert.equal(out.bindings.some((b) => b.id === bb.id), false);
	assert.equal(out.bindings.length, 1, '默认应用那条不许被一起删掉');
});
await checkAsync('一键加白按死信里的 appId 落到对应的绑定', async () => {
	const config = configOf();
	writeFileSync(join(config.dataRoot, 'agent-bindings.json'), JSON.stringify({ version: 1, bindings: [
		{ id: 'a', platform: 'feishu', chatId: 'oc_dl', targetKind: 'agent', targetId: 'coder', enabled: true, direction: 'both', allowFrom: [] },
		{ id: 'b', platform: 'feishu', chatId: 'oc_dl', targetKind: 'agent', targetId: 'arch', appId: B, enabled: true, direction: 'both', allowFrom: [] },
	] }));
	const rec = await recordDeadLetter(config, { reason: 'no-whitelist', platform: 'feishu', appId: B, chatId: 'oc_dl', userId: 'ou_b', text: 'hi' });
	await allowDeadLetterSender(config, { id: rec.item.id });
	const after = JSON.parse(readFileSync(join(config.dataRoot, 'agent-bindings.json'), 'utf8')).bindings;
	assert.deepEqual(after.find((b) => b.id === 'b').allowFrom, ['ou_b']);
	assert.deepEqual(after.find((b) => b.id === 'a').allowFrom, [], '别把用户加进另一个应用的绑定');
});
await checkAsync('锁：别人持有时并发抢锁零赢家；同进程幂等且锁文件不是半个 JSON', async () => {
	const home = mkdtempSync(join(tmpdir(), 'vssaros-lock-race-'));
	dirs.push(home);
	const own = await tryAcquireImLock('race-own', { home, pid: process.pid, dataRoot: '/owner' });
	assert.equal(own.ok, true);
	const rs = await Promise.all([
		tryAcquireImLock('race-own', { home, pid: 999999, dataRoot: '/x' }),
		tryAcquireImLock('race-own', { home, pid: 999998, dataRoot: '/y' }),
	]);
	assert.equal(rs.filter((r) => r.ok).length, 0, '别人持有时并发不许有人抢走');
	const again = await Promise.all([
		tryAcquireImLock('race-own', { home, pid: process.pid, dataRoot: '/a' }),
		tryAcquireImLock('race-own', { home, pid: process.pid, dataRoot: '/b' }),
	]);
	assert.equal(again.filter((r) => r.ok).length, 2, '同进程重复拿锁仍是幂等成功');
	assert.doesNotThrow(() => JSON.parse(readFileSync(imLockPath('race-own', home), 'utf8')), '锁文件不许是半个 JSON');
});

/* ── ⑦ 2026-11-09 Bot 设置页「飞书配置」：全局应用池 + 每 Bot 选型 ────────── */
await checkAsync('Bot 飞书应用映射：可读写、未配置应用拒选、多 Bot 共用、清空回默认', async () => {
	const config = configOf();
	await saveFeishu(config, { appId: A, appSecret: 'sa' });
	await saveFeishuApp(config, { appId: B, appSecret: 'sb', name: 'B应用' });
	assert.deepEqual(await readBotFeishuApps(config), {});
	await assert.rejects(saveBotFeishuApp(config, { botId: 'bot1', appId: C }), (e) => e.httpStatus === 400);
	await assert.rejects(saveBotFeishuApp(config, { botId: 'bot1', appId: B, actor: { kind: 'bot' } }), (e) => e.httpStatus === 403);
	assert.deepEqual(await saveBotFeishuApp(config, { botId: 'bot1', appId: B }), { bot1: B });
	assert.deepEqual(await saveBotFeishuApp(config, { botId: 'bot2', appId: B }), { bot1: B, bot2: B }, '全局池共享：两个 Bot 可共用同一个应用');
	assert.deepEqual(await readBotFeishuApps(config), { bot1: B, bot2: B });
	assert.deepEqual(await saveBotFeishuApp(config, { botId: 'bot1', appId: '' }), { bot2: B });
	assert.deepEqual((await describeFeishuApps(config)).map((a) => a.appId), [A, B], '写映射不影响凭据池');
});
check('入站路由：绑定没写 appId 时按 Bot 选的应用匹配；不传 botApps 保持旧行为', () => {
	const list = [{ id: 'b', platform: 'feishu', chatId: 'oc_g', targetId: 'bot1', enabled: true }];
	const b = (extra) => findBindingForChat(list, 'feishu', 'oc_g', Object.assign({ defaultAppId: A }, extra));
	assert.equal(b({ appId: B, botApps: { bot1: B } })?.id, 'b');
	assert.equal(b({ appId: A, botApps: { bot1: B } }), null, '别的应用的消息不许进这个 Bot');
	assert.equal(b({ appId: B }), null, '不传 botApps 时逐字保持旧行为');
});
await checkAsync('出站：绑定没写 appId 但 Bot 选了应用 ⇒ 用该应用的身份发', async () => {
	const config = configOf();
	const got = [];
	const hub = createBindingHub({ config, log: () => undefined, botApps: async () => ({ bot1: B }) });
	hub.register({ id: 'feishu', async send(ctx) { got.push(ctx.appId); } });
	await hub.deliver({ id: 'x', platform: 'feishu', chatId: 'oc_1', targetId: 'bot1', enabled: true, direction: 'both' }, 'hi');
	assert.deepEqual(got, [B]);
});

/* ── ⑧ 2026-11-10 派发失败不再静默 / 不再误报（真机：飞书发 test 无返回）────── */
const BOUND = { id: 'b', platform: 'feishu', chatId: 'oc_diag', chatType: 'p2p', targetKind: 'agent', targetId: 'knowledge-base-expert' };
await checkAsync('★ 派发：agent 名单扫描抛错 ⇒ 503 + 扫描诊断，不误报「bot 不存在」', async () => {
	await assert.rejects(
		() => dispatchImToAgent(configOf(), {}, BOUND, { content: 'test' }, {
			scanAgents: async () => { throw new Error('内置根读取失败'); },
			registeredAgentIds: async () => [],
		}),
		(e) => e.httpStatus === 503 && /agent 名单不可用/.test(e.message)
			&& /内置根读取失败/.test(e.message) && !/bot 不存在/.test(e.message),
	);
});
await checkAsync('★ 派发：名单正常但 id 不在其中 ⇒ 404 且列出当前名单', async () => {
	await assert.rejects(
		() => dispatchImToAgent(configOf(), {}, BOUND, { content: 'test' }, {
			scanAgents: async () => ({ agents: [{ id: 'coder' }, { id: 'architect' }], errors: [] }),
			registeredAgentIds: async () => [],
		}),
		(e) => e.httpStatus === 404 && /绑定指向的 bot 不存在/.test(e.message)
			&& /当前名单 2 个：coder, architect/.test(e.message),
	);
});
await checkAsync('★ 派发：内置根失效（名单 0 个）⇒ 用已注册 preset 名单兜底继续派发', async () => {
	const steered = [];
	const state = { agents: { get: () => ({ steer: (m) => steered.push(m) }) } };
	await dispatchImToAgent(configOf(), state, BOUND, { content: 'test', userId: 'ou_u' }, {
		scanAgents: async () => ({ agents: [], errors: ['内置 agent 目录读取失败'] }),
		registeredAgentIds: async () => ['coder', 'knowledge-base-expert'],
		ensureSession: async () => ({ sessionId: 's1', created: true }),
		renameSession: async () => {},
	});
	assert.equal(steered.length, 1, '兜底命中后仍要真正派发');
	assert.equal(steered[0].source.to, 'knowledge-base-expert');
});
await checkAsync('★ 派发失败：给 IM 回一条限流错误提示（第二条被 loopGuard 挡住）', async () => {
	const config = configOf();
	writeFileSync(join(config.dataRoot, 'agent-bindings.json'), JSON.stringify({ version: 1, bindings: [
		{ id: 'b', platform: 'feishu', chatId: 'oc_err', chatType: 'p2p', targetKind: 'agent',
			targetId: 'coder', enabled: true, direction: 'both', allowFrom: ['ou_u'] },
	] }));
	const sent = [], dead = [];
	const hub = createBindingHub({
		config, log: () => {}, defaultFeishuAppId: async () => A,
		scanAgents: async () => ({ agents: [{ id: 'coder', name: 'Coder' }] }),
		dispatchAgent: async () => { throw new Error('模拟派发失败'); },
		deadLetters: { record: async (e) => { dead.push(e); } },
	});
	hub.register({ id: 'feishu', async send(_ctx, text) { sent.push(text); } });
	const m = (id) => ({ platform: 'feishu', chatId: 'oc_err', chatType: 'p2p', messageId: id, userId: 'ou_u', content: 'test' });
	await hub.handleInbound(m('om_err_1'));
	await hub.handleInbound(m('om_err_2'));
	assert.equal(sent.length, 1, '同一会话 1 分钟内只回一条错误提示');
	assert.match(sent[0], /消息未送达/);
	assert.match(sent[0], /模拟派发失败/);
	assert.equal(dead.length, 2, '两条都仍要记死信');
	assert.match(dead[0].detail, /模拟派发失败/);
});

await checkAsync('★ 归属声明：skipAppIds 里的应用不派发、不记死信，chat_id 仍进最近会话', async () => {
	const config = configOf();
	const dead = [], dispatched = [];
	const hub = createBindingHub({
		config, log: () => {}, defaultFeishuAppId: async () => A,
		skipAppIds: async () => [A],
		scanAgents: async () => ({ agents: [{ id: 'coder', name: 'Coder' }] }),
		dispatchAgent: async () => { dispatched.push(1); return { ok: true }; },
		deadLetters: { record: async (e) => { dead.push(e); } },
	});
	const m = (id, appId) => ({ platform: 'feishu', appId, chatId: 'oc_owned', chatType: 'p2p', messageId: id, userId: 'ou_u', content: 'hi' });
	const r = await hub.handleInbound(m('om_own_1', A));
	assert.equal(r.reason, 'skip-app');
	assert.equal(dispatched.length, 0, '归 SuperAgent 的应用不能被 router 派发');
	// hub 外层会把所有 ok:false 交给 deps.deadLetters.record；「哪些 reason 真落盘」由
	// recordDeadLetter 的 DEAD_LETTER_REASONS 白名单决定 ⇒ 必须用真实函数验证，mock 会绕过它。
	assert.equal(dead[0]?.reason, 'skip-app', 'router 应给出 skip-app 而不是 unbound');
	const recorded = await recordDeadLetter(config, { reason: 'skip-app', platform: 'feishu', appId: A, chatId: 'oc_owned', text: 'hi' });
	assert.equal(recorded.skipped, true, 'skip-app 不在 DEAD_LETTER_REASONS 里 ⇒ 不该落死信');
	assert.equal((await listDeadLetters(config)).total, 0, '死信文件里不应出现这条');
	assert.ok(JSON.stringify(hub.recentChats()).includes('oc_owned'), 'noteRecent 必须在跳过前执行，否则设置页拿不到 chat_id');
	// 未列入 skip 的应用（真机 cli_aa8b… → 知识库专家）照常派发，防误伤。
	writeFileSync(join(config.dataRoot, 'agent-bindings.json'), JSON.stringify({ version: 1, bindings: [
		{ id: 'b', platform: 'feishu', chatId: 'oc_owned', chatType: 'p2p', targetKind: 'agent',
			targetId: 'coder', enabled: true, direction: 'both', allowFrom: ['ou_u'], appId: B },
	] }));
	const r2 = await hub.handleInbound(m('om_own_2', B));
	assert.equal(r2.ok, true, '未列入 skip 的应用仍要派发');
	assert.equal(dispatched.length, 1);
});

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
if (fails.length) {
	console.error(`✗ 多飞书应用单测：${fails.length} 失败 / ${pass} 通过`);
	for (const f of fails) { console.error('  - ' + f); }
	process.exit(1);
}
console.log(`✓ 多飞书应用单测 ${pass}/${pass} 全部通过`);
