/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `unknown tool "pwsh"` / `"read"` 的**作用域探测**（`vssaros-agents` 的 `probeToolScope`）。
 *
 * 背景：这两个工具的顶层 profile 行被官方 `dsh-web-app` 硬编码 `disabled: true`
 * （rc.2 `cordis.patch.yml:483`）⇒ 只能由 **agent preset** 提供，工具注册在 preset 层；
 * 全局视图看不到它们 ⇒ 只有"某个会话的 agent 作用域"能回答"这个会话到底有没有工具"。
 *
 * 这条探测是**纯诊断**：只读、只记日志、永不抛。这里验证它的三条硬要求。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshToolScopeProbe
 */

import assert from 'assert';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MOD = 'dsh-plugins/vssaros-agents/lib/index.js';

type Probe = (toolsOf: unknown, presetId: unknown, created: unknown) => void;

let probe: Probe;

/** 造一个假的 tools 服务：`view(agent).visible` 是 Map（有 keys()）。 */
function fakeTools(names: string[]): unknown {
	return { view: () => ({ visible: new Map(names.map(n => [n, {}])) }) };
}

/** 捕获 console.log。 */
function capture(fn: () => void): string[] {
	const out: string[] = [];
	const orig = console.log;
	console.log = (...args: unknown[]) => { out.push(args.map(String).join(' ')); };
	try { fn(); } finally { console.log = orig; }
	return out;
}

suite('作用域探测（unknown tool 诊断）', () => {

	suiteSetup(async () => {
		const mod = await import(pathToFileURL(path.join(process.cwd(), MOD)).href) as { probeToolScope: Probe };
		probe = mod.probeToolScope;
	});

	test('1) 有 pwsh/read ⇒ 打印「在」；缺 ⇒ 打印「缺」', () => {
		const log1 = capture(() => probe(() => fakeTools(['pwsh', 'read', 'run_code']), 'p-full', { agent: {} }));
		assert.strictEqual(log1.length, 1, '应该打一行');
		assert.match(log1[0], /preset=p-full/, '必须标明是哪个 preset');
		assert.match(log1[0], /pwsh=在/, 'pwsh 在时必须打「在」');
		assert.match(log1[0], /read=在/, 'read 在时必须打「在」');

		const log2 = capture(() => probe(() => fakeTools(['run_code']), 'p-empty', { agent: {} }));
		assert.match(log2[0], /pwsh=缺/, 'pwsh 缺时必须打「缺」');
		assert.match(log2[0], /read=缺/, 'read 缺时必须打「缺」');
	});

	test('2) 同一个 preset 只打一次（不许每次建会话都刷）', () => {
		const logs = capture(() => {
			probe(() => fakeTools(['pwsh']), 'p-dup', { agent: {} });
			probe(() => fakeTools(['pwsh']), 'p-dup', { agent: {} });
			probe(() => fakeTools(['pwsh']), 'p-dup', { agent: {} });
		});
		assert.strictEqual(logs.length, 1, '同一 preset 只许打一行，实际 ' + logs.length);
	});

	test('3) 拿不到 tools / agent / view 时静默，绝不抛（诊断不许影响建会话）', () => {
		assert.doesNotThrow(() => probe(undefined, 'p-noTools', { agent: {} }));
		assert.doesNotThrow(() => probe(() => undefined, 'p-nullTools', { agent: {} }));
		assert.doesNotThrow(() => probe(() => ({ view: () => undefined }), 'p-noView', { agent: {} }));
		assert.doesNotThrow(() => probe(() => fakeTools(['pwsh']), 'p-noAgent', {}));
		// toolsOf 本身抛错也不许冒出来
		assert.doesNotThrow(() => probe(() => { throw new Error('boom'); }, 'p-throw', { agent: {} }));
	});
});
