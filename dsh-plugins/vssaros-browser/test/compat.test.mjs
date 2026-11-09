#!/usr/bin/env node
// §4 兼容层：DS Bot 别名归一 + 截图体积闸（零依赖，直接 node 跑）。
import assert from 'node:assert/strict';
import { ALIASES, UNMAPPED_ALIASES, normalizeOpCall } from '../lib/core/alias.js';
import { MAX_SCREENSHOT_BYTES, screenshotSizeProblem } from '../lib/core/screenshot.js';

const fails = [];
let passed = 0;
const check = (name, fn) => {
	try { fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error.message}`); }
};

// 与 lib/index.js 的 KNOWN_OPS 对齐；守卫 check-browser-compat.mjs 会静态对账这份清单。
const KNOWN_OPS = [
	'status', 'snapshot', 'images', 'navigate', 'click', 'type', 'pressEnter', 'pressKey', 'scroll', 'back', 'reset',
	'login', 'cookies', 'evaluate', 'waitFor', 'find', 'storage', 'media', 'screenshot', 'handoff', 'resume', 'task',
];

check('所有别名归一后的 op 都命中 KNOWN_OPS（不会造出第二套工具）', () => {
	for (const [name, make] of Object.entries(ALIASES)) {
		const params = normalizeOpCall({ op: name }).params;
		assert.ok(KNOWN_OPS.includes(params.op), `${name} → ${params.op} 不在 KNOWN_OPS`);
	}
});

check('别名参数映射逐条正确', () => {
	assert.deepEqual(normalizeOpCall({ op: 'browser_open', url: 'https://example.com' }).params,
		{ op: 'navigate', url: 'https://example.com' });
	assert.deepEqual(normalizeOpCall({ op: 'browser_snapshot' }).params, { op: 'snapshot', format: 'aria' });
	assert.deepEqual(normalizeOpCall({ op: 'browser_click', ref: 'e12', confirm: true, label: '删除' }).params,
		{ op: 'click', ref: 'e12', confirm: true, label: '删除' });
	assert.deepEqual(normalizeOpCall({ op: 'browser_type', ref: '3', text: 'hi' }).params,
		{ op: 'type', ref: '3', text: 'hi' });
	assert.deepEqual(normalizeOpCall({ op: 'browser_press', key: 'Enter' }).params,
		{ op: 'pressKey', key: 'Enter' });
	assert.deepEqual(normalizeOpCall({ op: 'browser_handoff', reason: 'login', note: '请扫码' }).params,
		{ op: 'handoff', text: '请扫码' });
	assert.deepEqual(normalizeOpCall({ op: 'browser_task', goal: '找作者' }).params,
		{ op: 'task', goal: '找作者' });
	assert.equal(normalizeOpCall({ op: 'read_browser', from: 2 }).params.op, 'snapshot');
	assert.equal(normalizeOpCall({ op: 'browser_resume' }).params.op, 'resume');
	assert.equal(normalizeOpCall({ op: 'browser_screenshot' }).params.op, 'screenshot');
	assert.equal(normalizeOpCall({ op: 'browser_back' }).params.op, 'back');
});

check('未命中别名时逐字不变；危险别名明确不映射', () => {
	const original = { op: 'click', ref: '1' };
	const result = normalizeOpCall(original);
	assert.equal(result.mapped, false);
	assert.equal(result.params, original);
	assert.equal(normalizeOpCall({ op: '' }).mapped, false);
	assert.equal(normalizeOpCall(undefined).mapped, false);
	for (const name of Object.keys(UNMAPPED_ALIASES)) {
		assert.equal(Object.hasOwn(ALIASES, name), false, `${name} 不该被映射`);
	}
	assert.equal(Object.keys(UNMAPPED_ALIASES).length, 4);
});

check('别名的 params 子对象会保留（不吞掉嵌套参数）', () => {
	const out = normalizeOpCall({ op: 'browser_open', url: 'https://a', params: { x: 1 } }).params;
	assert.equal(out.op, 'navigate');
	assert.deepEqual(out.params, { x: 1 });
});

check('截图体积闸：小图放行、空图拒、超 180KB 拒且给出降质提示', () => {
	assert.equal(MAX_SCREENSHOT_BYTES, 180 * 1024);
	assert.equal(screenshotSizeProblem('A'.repeat(1000)), undefined);
	assert.equal(screenshotSizeProblem(''), '截图为空，没有生成图片附件。');
	assert.equal(screenshotSizeProblem(undefined).includes('为空'), true);
	const tooBig = screenshotSizeProblem('A'.repeat(300 * 1024));
	assert.match(tooBig, /超过 180KB 上限/);
	assert.match(tooBig, /降低 quality/);
	assert.match(tooBig, /snapshot 读文字/);
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
