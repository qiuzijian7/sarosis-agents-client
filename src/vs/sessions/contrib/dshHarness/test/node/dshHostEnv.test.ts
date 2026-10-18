/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Host 子进程环境的**环回绕代理**判据（`ensureLoopbackNoProxy` / `sanitizedEnv`）。
 *
 * 与
 * `deepseek-harness-for-vscode/src/extension.ts:30-34` 同源：Host 的插件页是经 `http://127.0.0.1:<port>`
 * 加载的，用户环境若配了系统代理而 `NO_PROXY` 没排除环回 ⇒ 页面被代理劫持、且日志里看不出原因 ✗。
 *
 * 这里只钉**纯逻辑**（不 spawn、不读真盘）：等价性、大小写、`*` 逃生、幂等、以及
 * `sanitizedEnv` 的集成点（显式传 `NO_PROXY` 也必须含环回）。
 */

import assert from 'assert';
import { ensureLoopbackNoProxy, LOOPBACK_NO_PROXY, sanitizedEnv } from '../../electron-main/dshRuntimeManager.js';

/** 按大小写无关收集 `no_proxy` 的键名（Windows 上可能有两个写法）。 */
function noProxyKeys(env: NodeJS.ProcessEnv): string[] {
	return Object.keys(env).filter(k => k.toLowerCase() === 'no_proxy');
}

suite('dshHarness / host env — loopback bypasses proxy', () => {

	test('没有 NO_PROXY 时补上环回三项', () => {
		const env: NodeJS.ProcessEnv = {};
		ensureLoopbackNoProxy(env);
		assert.strictEqual(env.NO_PROXY, LOOPBACK_NO_PROXY.join(','));
	});

	test('用户已有条目原样保留，缺的项追加在后面', () => {
		const env: NodeJS.ProcessEnv = { NO_PROXY: 'corp.example.com,127.0.0.1' };
		ensureLoopbackNoProxy(env);
		assert.strictEqual(env.NO_PROXY, 'corp.example.com,127.0.0.1,localhost,::1');
	});

	test('大小写无关去重：已有 LOCALHOST 就不再追加 localhost', () => {
		const env: NodeJS.ProcessEnv = { NO_PROXY: 'LOCALHOST,::1' };
		ensureLoopbackNoProxy(env);
		assert.strictEqual(env.NO_PROXY, 'LOCALHOST,::1,127.0.0.1');
	});

	test('NO_PROXY=* （全绕）视为已满足，不追加也不改写', () => {
		const env: NodeJS.ProcessEnv = { NO_PROXY: '*' };
		ensureLoopbackNoProxy(env);
		assert.strictEqual(env.NO_PROXY, '*');
	});

	test('NO_PROXY 与 no_proxy 两个键合并成一个（否则子进程里谁生效说不清）', () => {
		const env: NodeJS.ProcessEnv = { NO_PROXY: 'a.example.com', no_proxy: 'b.example.com' };
		ensureLoopbackNoProxy(env);
		assert.deepStrictEqual(noProxyKeys(env), ['NO_PROXY']);
		assert.strictEqual(env.NO_PROXY, 'a.example.com,b.example.com,127.0.0.1,localhost,::1');
	});

	test('幂等：连续两次调用逐字相同', () => {
		const once: NodeJS.ProcessEnv = { NO_PROXY: 'corp.example.com' };
		ensureLoopbackNoProxy(once);
		const twice: NodeJS.ProcessEnv = { NO_PROXY: 'corp.example.com' };
		ensureLoopbackNoProxy(ensureLoopbackNoProxy(twice));
		// ⚠ 只比"两次相等"是**假守卫**：整段追加热全被摘掉时两边同样"相等" ⇒ 必须同时钉住期望值
		// （2026-10-16 反向突变实测抓到：摘掉追加逻辑后这条仍然绿）。
		assert.strictEqual(once.NO_PROXY, 'corp.example.com,127.0.0.1,localhost,::1');
		assert.strictEqual(twice.NO_PROXY, once.NO_PROXY);
	});

	test('sanitizedEnv 的集成点：调用方显式传 NO_PROXY 时也保证环回，且键收敛为一个', () => {
		const env = sanitizedEnv({ NO_PROXY: 'corp.example.com', no_proxy: undefined });
		assert.deepStrictEqual(noProxyKeys(env), ['NO_PROXY']);
		assert.strictEqual(env.NO_PROXY, 'corp.example.com,127.0.0.1,localhost,::1');
	});
});
