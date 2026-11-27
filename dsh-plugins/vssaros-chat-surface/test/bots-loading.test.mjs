/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../lib/client.workspaces.js', import.meta.url), 'utf8');
let definition;
new Function('window', source)({ __ModuleLoader__: { load(value) { definition = value; } } });
const { fetchBotsData } = definition.factory(() => ({})).__test;
const HOME = '/x/agents/api/home';
const ROOMS = '/x/agents/api/rooms';
const BINDINGS = '/x/agents/api/bindings';
const home = { agents: [{ id: 'helper', registered: true }], home: { helper: { sessions: [{ id: 'latest' }] } }, presetsPending: true };
const json = value => ({ ok: true, json: async () => value });
const flush = () => new Promise(resolve => setImmediate(resolve));

function fetchFixture(overrides = {}) {
	const signals = new Map();
	const fetch = (url, init) => {
		signals.set(url, init.signal);
		if (Object.hasOwn(overrides, url)) { return overrides[url](); }
		return json(url === HOME ? home : url === ROOMS ? { rooms: [{ id: 'room' }] } : { bindings: [{ targetId: 'helper', platform: 'feishu' }] });
	};
	return { fetch, signals };
}

test('名册、最近会话、群聊、IM 和 pending 状态保留，成功后计时器被清理', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const f = fetchFixture();
	const result = await fetchBotsData(f.fetch);
	assert.deepEqual({ ok: result.ok, agents: result.agents, home: result.home, rooms: result.rooms, roomsError: result.roomsError, imBadges: result.imBadges, pending: result.presetsPending },
		{ ok: true, agents: home.agents, home: home.home, rooms: [{ id: 'room' }], roomsError: '', imBadges: { helper: { count: 1, platforms: ['feishu'] } }, pending: true });
	t.mock.timers.tick(8000);
	assert.deepEqual([...f.signals.values()].map(signal => signal.aborted), [false, false, false]);
});

test('群聊请求和 IM 响应体挂起时独立超时，不拖垮名册并取消请求', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const f = fetchFixture({
		[ROOMS]: () => new Promise(() => {}),
		[BINDINGS]: () => ({ ok: true, json: () => new Promise(() => {}) }),
	});
	const loading = fetchBotsData(f.fetch);
	await flush();
	t.mock.timers.tick(2000);
	const result = await loading;
	assert.deepEqual({ ok: result.ok, agents: result.agents, rooms: result.rooms, roomsError: result.roomsError, imBadges: result.imBadges },
		{ ok: true, agents: home.agents, rooms: [], roomsError: '读取超时（2s 未返回）', imBadges: {} });
	assert.deepEqual([HOME, ROOMS, BINDINGS].map(url => f.signals.get(url).aborted), [false, true, true]);
});

test('名册响应体挂起时 8 秒超时并取消，不会无限等待', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const f = fetchFixture({ [HOME]: () => ({ ok: true, json: () => new Promise(() => {}) }) });
	let settled = false;
	const loading = fetchBotsData(f.fetch).then(result => { settled = true; return result; });
	await flush();
	t.mock.timers.tick(7999);
	await flush();
	assert.equal(settled, false);
	t.mock.timers.tick(1);
	assert.deepEqual(await loading, { ok: false, error: '读取超时（8s 未返回）' });
	assert.equal(f.signals.get(HOME).aborted, true);
});

test('附加接口 HTTP 失败只降级该数据，名册 HTTP 失败保留真实错误', async () => {
	const failure = () => ({ ok: false, status: 404 });
	const result = await fetchBotsData(fetchFixture({ [ROOMS]: failure, [BINDINGS]: failure }).fetch);
	assert.deepEqual({ ok: result.ok, agents: result.agents, rooms: result.rooms, roomsError: result.roomsError, imBadges: result.imBadges },
		{ ok: true, agents: home.agents, rooms: [], roomsError: 'HTTP 404', imBadges: {} });
	assert.deepEqual(await fetchBotsData(fetchFixture({ [HOME]: failure }).fetch), { ok: false, error: 'HTTP 404' });
});

test('fetch 同步抛错也转为可渲染的名册错误', async () => {
	const f = fetchFixture({ [HOME]: () => { throw new Error('network unavailable'); } });
	assert.deepEqual(await fetchBotsData(f.fetch), { ok: false, error: 'network unavailable' });
});

test('错误提示不臆断插件缺失、不指向新建菜单，注册中不显示空名册', () => {
	assert.equal(source.includes('agents 插件没装、或 Host 没起来'), false);
	assert.equal(source.includes('点 ＋ → 刷新名册'), false);
	assert.ok(source.includes('点击顶部刷新按钮重试'));
	assert.ok(source.includes('ready && !list.length && bots.presetsPending !== true'));
});
