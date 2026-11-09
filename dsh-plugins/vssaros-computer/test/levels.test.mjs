#!/usr/bin/env node
// 档位 / 调用分类 / 状态文件测试。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	BACKGROUND_OPS, FOREGROUND_OPS, LEVELS, OBSERVE_OPS, REFUSED_OPS,
	classifyOp, defaultState, gateCall, isProtectedApp, levelAllows, levelFor,
	readState, writeState,
} from '../lib/core/levels.js';

const fails = [];
let passed = 0;
const check = (name, fn) => {
	try { fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error.message}`); }
};

check('只读 op 集与主进程中继的 method 一一对应（含 P2 getStatus）', () => {
	assert.equal(OBSERVE_OPS.length, 10);
	for (const op of ['getVersion', 'listApps', 'listWindows', 'getWindowState',
		'getAccessibilityTree', 'screenshot', 'getScreenSize', 'getCursorPosition',
		'checkPermissions', 'getStatus']) {
		assert.ok(OBSERVE_OPS.includes(op), `缺 ${op}`);
		assert.equal(classifyOp(op), 'observe');
	}
	assert.ok(!OBSERVE_OPS.includes('click'));
});

check('三类 op 互不重叠；未识别一律最高危', () => {
	for (const op of OBSERVE_OPS) {
		assert.ok(!BACKGROUND_OPS.includes(op));
		assert.ok(!FOREGROUND_OPS.includes(op));
	}
	for (const op of BACKGROUND_OPS) assert.ok(!FOREGROUND_OPS.includes(op));
	assert.equal(classifyOp('click'), 'background');
	assert.equal(classifyOp('activateApp'), 'foreground');
	assert.equal(classifyOp('nope'), 'foreground');
	assert.equal(classifyOp(undefined), 'foreground');
});

check('四档矩阵', () => {
	assert.deepEqual(LEVELS, ['off', 'view', 'background', 'foreground']);
	for (const kind of ['observe', 'background', 'foreground']) {
		assert.equal(levelAllows('off', kind), false);
		assert.equal(levelAllows('foreground', kind), true);
	}
	assert.equal(levelAllows('view', 'observe'), true);
	assert.equal(levelAllows('view', 'background'), false);
	assert.equal(levelAllows('background', 'background'), true);
	assert.equal(levelAllows('background', 'foreground'), false);
});

check('gateCall：P0 硬闸拒绝所有动作，任何档位都一样', () => {
	for (const level of LEVELS) {
		assert.match(gateCall('click', level).message, /P0 只读层不开放/);
		assert.match(gateCall('unknownProbe', level).message, /P0 只读层不开放/);
	}
	assert.equal(gateCall('screenshot', 'view').ok, true);
	assert.equal(gateCall('screenshot', 'off').ok, false);
	assert.match(gateCall('screenshot', 'off').message, /档位 off/);
});

check('gateCall：永久拒绝名单 / 空 op / 关掉 P0 闸后的档位行为', () => {
	for (const op of REFUSED_OPS) assert.match(gateCall(op, 'foreground').message, /永久禁止/);
	assert.equal(gateCall('', 'view').code, -32602);
	assert.equal(gateCall('click', 'view', { p0ReadOnly: false }).ok, false);
	assert.equal(gateCall('click', 'background', { p0ReadOnly: false }).ok, true);
	assert.equal(gateCall('activateApp', 'foreground', { p0ReadOnly: false }).ok, true);
});

check('状态文件：坏数据回默认、按 Bot 取档、未登记用 fallback', () => {
	assert.deepEqual(defaultState(), { version: 1, levels: {}, grants: {}, once: {} });
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-computer-'));
	try {
		const file = join(dir, 'computer-control.json');
		writeFileSync(file, '{broken');
		assert.deepEqual(readState(file), defaultState());
		writeFileSync(file, JSON.stringify({ version: 2, levels: { a: 'foreground' } }));
		assert.deepEqual(readState(file), defaultState());
		const state = { version: 1, levels: { river: 'view', chief: 'off', bogus: 'admin' } };
		writeState(file, state);
		const back = readState(file);
		assert.equal(back.levels.river, 'view');
		assert.equal(back.levels.chief, 'off');
		assert.equal(back.levels.bogus, undefined, '非法档位不该被接纳');
		assert.equal(levelFor(back, 'river'), 'view');
		assert.equal(levelFor(back, 'nobody'), 'view');
		assert.equal(levelFor(back, 'nobody', 'off'), 'off');
		assert.equal(readFileSync(file, 'utf8').includes('river'), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

check('受保护应用命中自身 / 系统设置 / 凭据管理器，不误伤普通应用', () => {
	for (const name of ['VsSaros', 'Code - OSS', 'DSH Computer Use.app', '系统设置', 'Credential Manager']) {
		assert.ok(isProtectedApp(name), name);
	}
	for (const name of ['Notepad', 'Chrome', '', undefined]) assert.equal(isProtectedApp(name), false);
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
