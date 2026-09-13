/*---------------------------------------------------------------------------------------------
 *  proxyHealth.test.ts — AgentMemoryProviderProxy 健康状态回归测试（X8，2026-09-10）
 *
 *  背景：网关不可达时读路径静默返回空默认，用户以为"没记忆"。X8 把连接状态暴露为
 *  getHealthStatus()（本地判定不发包），供记忆面板显示告警条。本测试锁定其状态机。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AgentMemoryProviderProxy } from '../src/agentMemoryProviderProxy.js';

declare function suite(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void | Promise<void>): void;

// 指向必然不可达的端口（port 1 无服务），保证 offline 判定稳定
const savedUrl = process.env['AGENTMEMORY_URL'];

suite('proxyHealth — 网关健康状态（X8）', () => {
	suiteSetup(() => { process.env['AGENTMEMORY_URL'] = 'http://127.0.0.1:1'; });
	suiteTeardown(() => {
		if (savedUrl === undefined) { delete process.env['AGENTMEMORY_URL']; }
		else { process.env['AGENTMEMORY_URL'] = savedUrl; }
	});

	test('初始状态为 unknown（未探活、未调用）', () => {
		const p = new AgentMemoryProviderProxy();
		const st = p.getHealthStatus();
		assert.strictEqual(st.status, 'unknown');
		assert.strictEqual(st.gatewayUp, false);
		assert.ok(st.baseUrl.includes('127.0.0.1'), `baseUrl=${st.baseUrl}`);
	});

	test('探活失败（端口不可达）→ offline，供 UI 显示告警条', async () => {
		const p = new AgentMemoryProviderProxy();
		p.probeGateway();
		// 探活是 fire-and-forget：轮询等待状态迁移（连接拒绝通常立即返回）
		for (let i = 0; i < 50; i++) {
			if (p.getHealthStatus().status !== 'unknown') { break; }
			await new Promise(r => setTimeout(r, 50));
		}
		const st = p.getHealthStatus();
		assert.strictEqual(st.status, 'offline', `实际状态=${st.status}`);
		assert.strictEqual(st.gatewayUp, false);
	});

	test('注入的 logger 被真实调用（原型方法 this 绑定正确）', async () => {
		// 用**原型方法**的 logger 复现真实 ILogService 形态：若内部按 (logger.warn)(m)
		// 调用会丢失 this → 抛错被 void async 吞 → 日志静默消失（2026-09-10 实测 bug）
		class MockLog {
			msgs: string[] = [];
			warn(m: string): void { this.msgs.push(m); }
			info(m: string): void { this.msgs.push(m); }
		}
		const log = new MockLog();
		const p = new AgentMemoryProviderProxy(log);
		p.probeGateway();
		for (let i = 0; i < 50; i++) {
			if (log.msgs.length > 0) { break; }
			await new Promise(r => setTimeout(r, 50));
		}
		assert.ok(log.msgs.some(m => m.includes('UNREACHABLE')), `logger 未收到日志: ${JSON.stringify(log.msgs)}`);
	});

	test('健康状态不发起网络请求（纯本地判定）', () => {
		const p = new AgentMemoryProviderProxy();
		// 连续调用应完全一致且立即返回（若走网络会有延迟/异常）
		const a = p.getHealthStatus();
		const b = p.getHealthStatus();
		assert.deepStrictEqual(a, b);
	});

	// P1-12（2026-09-11）：超时与连接错误分级去抖。
	// 背景：sweep 期间多个方法（observe/triggerHook/onTaskCompleted）同时 5s 超时，
	// 两个不同方法的超时瞬间凑满"连续 2 次"→ 误判 UNREACHABLE。
	test('P1-12: 连续 2 次超时不判 down，第 3 次才判', async () => {
		const origFetch = globalThis.fetch;
		try {
			const p = new AgentMemoryProviderProxy();
			// 先成功一次 → 状态 up
			globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => '{}' })) as unknown as typeof fetch;
			await p._call('loadContext', 'a', 's');
			assert.strictEqual(p.getHealthStatus().status, 'healthy', '先置为 healthy');
			// 两次超时
			const abortErr = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
			globalThis.fetch = (async () => { throw abortErr; }) as unknown as typeof fetch;
			await p._call('observe', 'a');
			await p._call('observe', 'a');
			assert.strictEqual(p.getHealthStatus().status, 'healthy', '2 次超时不应判 down（可能只是网关忙）');
			await p._call('observe', 'a');
			assert.strictEqual(p.getHealthStatus().status, 'offline', '第 3 次超时判 down');
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	test('P1-12: 连接错误仍 2 次判 down（进程真没了）', async () => {
		const origFetch = globalThis.fetch;
		try {
			const p = new AgentMemoryProviderProxy();
			globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => '{}' })) as unknown as typeof fetch;
			await p._call('loadContext', 'a', 's');
			const connErr = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3111'), { name: 'TypeError' });
			globalThis.fetch = (async () => { throw connErr; }) as unknown as typeof fetch;
			await p._call('observe', 'a');
			assert.strictEqual(p.getHealthStatus().status, 'healthy', '1 次连接错误不判 down（去抖）');
			await p._call('observe', 'a');
			assert.strictEqual(p.getHealthStatus().status, 'offline', '第 2 次连接错误判 down');
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});
