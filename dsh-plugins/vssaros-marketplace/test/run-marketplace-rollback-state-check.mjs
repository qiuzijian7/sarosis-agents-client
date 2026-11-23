#!/usr/bin/env node
// @vssaros/dsh-marketplace — 回滚 UI 状态 / 接线守卫（★ 2026-11-23）
//
// 守什么：
//   ① 分组与选点的纯判据（同一资源的多个备份点、最近优先、脏值过滤）；
//   ② UI 真的接了 Host 的 rollbackList / rollbackRestore 两条 op（不能只画个抽屉）；
//   ③ op 在 dispatch 的只读 / 写集合里（否则页面点了会被当「不认识的动作」）。
//
// 跑法：node --test dsh-plugins/vssaros-marketplace/test/run-marketplace-rollback-state-check.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const context = vm.createContext({ window: {}, AbortController, setTimeout, clearTimeout, DOMException });
vm.runInContext(await readFile(new URL('../lib/client.state.js', import.meta.url), 'utf8'), context);
const { groupRollbackPoints, pickRollbackPoint } = context.window.MarketplaceState;

const POINTS = [
	{ id: 'demo-skill', kind: 'skill', ts: '2026-11-22T10-00-00-000Z', createdAt: '2026-11-22T10:00:00.000Z' },
	{ id: 'demo-skill', kind: 'skill', ts: '2026-11-23T12-34-56-789Z', createdAt: '2026-11-23T12:34:56.789Z' },
	{ id: 'codebase-mcp', kind: 'mcp', ts: '2026-11-21T08-00-00-000Z' },
	null,
	{ id: '', kind: 'skill', ts: '2026-11-23T12-00-00-000Z' },
	{ id: 'no-ts', kind: 'skill' },
	{ id: 'extra-field', kind: 'agent', ts: '2026-11-20T08-00-00-000Z', dir: '/should/not/leak' },
];

test('① groupRollbackPoints：按 kind:id 分组，组内与组间都按时间倒序', () => {
	const out = groupRollbackPoints(POINTS);
	assert.equal(out.total, POINTS.length, 'total 是原始条目数（含脏值，便于显示「扫到几条」）');
	assert.equal(out.groups.length, 3, '脏值与无 id/ts 的条目被过滤');
	assert.equal(out.groups[0].id, 'demo-skill', '最近的组排最前');
	assert.equal(out.groups[0].latest.ts, '2026-11-23T12-34-56-789Z');
	assert.equal(out.groups[0].points.length, 2);
	assert.equal(out.groups[0].points[0].ts, '2026-11-23T12-34-56-789Z');
	assert.equal(out.groups[0].points[1].ts, '2026-11-22T10-00-00-000Z');
	assert.equal('dir' in out.groups[2].latest, false, '磁盘路径不许混进 UI 投影');
	// ⚠ client.state.js 跑在 vm context 里 ⇒ 对象原型属于另一个 realm，不能用 deepStrictEqual 比字面量
	[groupRollbackPoints(null), groupRollbackPoints('bad'), groupRollbackPoints([])].forEach(function (empty) {
		assert.equal(empty.groups.length, 0);
		assert.equal(empty.total, 0);
	});
});

test('② pickRollbackPoint：缺省取最近，可指定 ts，找不到返回 null', () => {
	const groups = groupRollbackPoints(POINTS).groups;
	assert.equal(pickRollbackPoint(groups, 'skill:demo-skill').ts, '2026-11-23T12-34-56-789Z');
	assert.equal(pickRollbackPoint(groups, 'skill:demo-skill', '2026-11-22T10-00-00-000Z').ts, '2026-11-22T10-00-00-000Z');
	assert.equal(pickRollbackPoint(groups, 'skill:demo-skill', 'not-exist'), null);
	assert.equal(pickRollbackPoint(groups, 'mcp:missing'), null);
	assert.equal(pickRollbackPoint(null, 'skill:demo-skill'), null);
	assert.equal(pickRollbackPoint(groups, 'mcp:codebase-mcp').kind, 'mcp');
});

test('③ 商城页真的接了两条回滚 op（不是只画 UI）', async () => {
	const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
	assert.match(src, /action\('rollbackList'/, '打开抽屉要拉备份点');
	assert.match(src, /action\('rollbackRestore'/, '点恢复要真的调用 Host');
	assert.match(src, /function RollbackDrawer/, '要有可回滚版本抽屉');
	assert.match(src, /可回滚版本/, '要有可见入口');
	assert.match(src, /groupRollbackPoints\(s\.items\)/, '抽屉必须用 state 真源分组');
	assert.match(src, /pickRollbackPoint\(/, '恢复必须按选中的备份点取值');
});

test('④ 两条 op 在 dispatch 的声明面里（否则会被当成未知动作）', async () => {
	const dispatch = await readFile(new URL('../lib/dispatch.js', import.meta.url), 'utf8');
	const readSet = /LOCAL_READ_OPS = new Set\(([^)]*)\)/.exec(dispatch)?.[1] ?? '';
	const writeSet = /LOCAL_WRITE_OPS = new Set\(([^)]*)\)/.exec(dispatch)?.[1] ?? '';
	assert.match(readSet, /'rollbackList'/);
	assert.match(writeSet, /'rollbackRestore'/);
	const host = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
	assert.match(host, /op === 'rollbackList'/);
	assert.match(host, /op === 'rollbackRestore'/);
	assert.match(host, /upgradeBackup\.js/, 'Host 必须 import 回滚真源');
});
