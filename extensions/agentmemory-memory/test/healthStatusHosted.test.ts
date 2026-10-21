/*---------------------------------------------------------------------------------------------
 *  healthStatusHosted.test.ts — 宿主模式的健康状态（2026-10-21）
 *
 *  病根：宿主模式（网关进程内**直跑**引擎）下**没有"远端 server"**这回事
 *   ⇒ `_serverAvailable`（HTTP 模式的可达标志）**恒 false** ⇒ `getHealthStatus()` **恒 degraded** ✗✗
 *   ⇒ 面板的降级告警横幅**一直亮** ⇒ 告警恒亮 = 告警失效（用户开始忽略一切告警）✗
 *
 *  本守卫钉住：宿主模式必须如实报 **healthy**（引擎就在进程内，取数路径就是本进程）✓
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AgentMemoryProviderV2 } from '../src/agentMemoryProviderV2.js';

declare function suite(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void | Promise<void>): void;

suite('健康状态（宿主模式）', () => {
	test('宿主模式（hosted=true）⇒ status=healthy、serverAvailable=true（不得恒 degraded）', () => {
		const p = new AgentMemoryProviderV2({ hosted: true });
		const st = p.getHealthStatus() as { status?: string; serverAvailable?: boolean; mode?: string };
		assert.equal(st.status, 'healthy', `宿主模式必须报 healthy，实际 ${JSON.stringify(st)}`);
		assert.equal(st.serverAvailable, true, '宿主模式没有"远端 server 不可达"这回事 ⇒ serverAvailable 应为 true');
		assert.equal(st.mode, 'hosted', '要标明是宿主模式（便于排查）');
	});

	test('非宿主模式保持原语义（serverAvailable 决定 healthy/degraded）', () => {
		// 渲染侧（HTTP 模式）构造时不传 hosted ⇒ 此时不该被当成 hosted
		const p = new AgentMemoryProviderV2({});
		const st = p.getHealthStatus() as { status?: string; mode?: string };
		assert.notEqual(st.mode, 'hosted', '非宿主模式不得标 hosted');
		assert.ok(st.status === 'healthy' || st.status === 'degraded', `status 必须是 healthy/degraded，实际 ${st.status}`);
	});
});