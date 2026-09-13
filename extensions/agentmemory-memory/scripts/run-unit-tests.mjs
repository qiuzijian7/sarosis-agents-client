/*---------------------------------------------------------------------------------------------
 *  run-unit-tests.mjs — test/*.test.ts 的运行入口（极简 mocha --ui=tdd 子集）
 *
 *  背景（2026-09-11）：test/ 下的测试文件（compressor / graphAndIndexes / proxyHealth）
 *  此前**从未被执行**——tsconfig 的 rootDir=src 把它们排除在编译之外，也没有 runner
 *  引用它们（写了不跑 = 零覆盖）。本脚本 + tsconfig.test.json 补上这条链路：
 *    npx tsc -p tsconfig.test.json   →  out-test/{src,test}
 *    node scripts/run-unit-tests.mjs →  执行 out-test/test/*.test.js
 *
 *  提供的全局（与测试文件中的 declare 声明对应）：suite / test / suiteSetup / suiteTeardown
 *--------------------------------------------------------------------------------------------*/

import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const suites = [];
let current = null;

globalThis.suite = (name, fn) => {
	current = { name, tests: [], setup: [], teardown: [] };
	suites.push(current);
	fn();
	current = null;
};
globalThis.test = (name, fn) => {
	if (!current) { throw new Error(`test('${name}') 必须在 suite() 内注册`); }
	current.tests.push({ name, fn });
};
globalThis.suiteSetup = (fn) => { if (current) { current.setup.push(fn); } };
globalThis.suiteTeardown = (fn) => { if (current) { current.teardown.push(fn); } };

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const testDir = path.join(here, '..', 'out-test', 'test');

let passed = 0;
const failures = [];

const files = readdirSync(testDir).filter(f => f.endsWith('.test.js')).sort();
if (files.length === 0) {
	console.error(`✗ 未找到测试文件（先运行: npx tsc -p tsconfig.test.json）\n  dir=${testDir}`);
	process.exit(1);
}
// 1) 加载（注册 suite/test）
for (const f of files) {
	await import(pathToFileURL(path.join(testDir, f)).href);
}
// 2) 执行
const t0 = Date.now();
for (const s of suites) {
	console.log(`\n📦 ${s.name}`);
	for (const fn of s.setup) { await fn(); }
	for (const t of s.tests) {
		try {
			await t.fn();
			passed++;
			console.log(`  ✓ ${t.name}`);
		} catch (err) {
			failures.push({ suite: s.name, test: t.name, err });
			console.log(`  ✗ ${t.name}`);
			console.log(`      ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	for (const fn of s.teardown) { await fn(); }
}

const total = passed + failures.length;
console.log(`\n══════════ Unit Test Results: ${passed} passed, ${failures.length} failed, ${total} total (${Date.now() - t0}ms) ══════════`);
if (failures.length > 0) {
	for (const f of failures) {
		console.error(`FAIL [${f.suite}] ${f.test}: ${f.err instanceof Error ? f.err.stack : String(f.err)}`);
	}
	process.exit(1);
}
