// @vssaros/dsh-agents — AgentMemory 候选（记忆页签的只读块，2026-10-27）
//   跑法：node dsh-plugins/vssaros-agents/test/agentmemory-candidates.test.mjs
//
// 这一层的核心纪律：**不抛**。网关是可选增强，它离线不该让「记忆」页签整体报错 ——
// 三态（online / offline / unconfigured）由返回值表达，页面据此显示一行状态。
import assert from 'node:assert/strict';

import { agentMemoryGatewayUrl, listAgentMemoryCandidates, listAgentMemoryExtras } from '../lib/agentmemoryImport.js';

let pass = 0;
const fails = [];
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

/* 替换全局 fetch，跑完恢复 */
const withFetch = async (impl, fn) => {
	const old = globalThis.fetch;
	globalThis.fetch = impl;
	try { await fn(); } finally { globalThis.fetch = old; }
};

/* ── 地址解析（不猜端口）────────────────────────────────────────────── */
check('★ 未配置任何来源 ⇒ null（绝不猜端口）', () => {
	assert.equal(agentMemoryGatewayUrl({}, {}), null);
	assert.equal(agentMemoryGatewayUrl({}, { AGENTMEMORY_PORT: '' }), null);
});

check('四处来源的优先级：config > VSSAROS_ > AGENTMEMORY_URL > PORT', () => {
	assert.equal(agentMemoryGatewayUrl({ agentMemoryGatewayUrl: 'http://127.0.0.1:9' }, { VSSAROS_MEMORY_GATEWAY_URL: 'http://x:1' }), 'http://127.0.0.1:9');
	assert.equal(agentMemoryGatewayUrl({}, { VSSAROS_MEMORY_GATEWAY_URL: 'http://x:1', AGENTMEMORY_URL: 'http://x:2' }), 'http://x:1');
	assert.equal(agentMemoryGatewayUrl({}, { AGENTMEMORY_URL: 'http://x:2/' }), 'http://x:2');
	assert.equal(agentMemoryGatewayUrl({}, { AGENTMEMORY_PORT: '3112' }), 'http://127.0.0.1:3112');
});

/* ── 三态 ───────────────────────────────────────────────────────────── */
await checkAsync('★ 未配置 ⇒ state=unconfigured（不发请求）', async () => {
	let called = 0;
	await withFetch(async () => { called += 1; return { ok: true, text: async () => '[]' }; }, async () => {
		const r = await listAgentMemoryCandidates({}, 'coder', { env: {} });
		assert.equal(r.state, 'unconfigured');
		assert.equal(r.items.length, 0);
	});
	assert.equal(called, 0, '未配置时不该发请求');
});

await checkAsync('★ 在线 ⇒ 逐条返回（type/content 归一、空白折叠）', async () => {
	await withFetch(async (url, init) => {
		assert.ok(String(url).includes('/provider/searchMemory'), '端点应是 searchMemory：' + url);
		const body = JSON.parse(init.body);
		assert.deepEqual(body.args, ['coder', '', 40], '空 query = 全量列出（宿主路由空查询会回 []）');
		return {
			ok: true,
			text: async () => JSON.stringify([
				{ id: 'abc12345', type: 'preference', content: '  用户偏好\n中文答复  ' },
				{ id: 'def', content: '评测集在 D:\\eval' },
				{ nope: true },                       // 无 content ⇒ 丢弃
			]),
		};
	}, async () => {
		const r = await listAgentMemoryCandidates({ agentMemoryGatewayUrl: 'http://127.0.0.1:3112' }, 'coder', { env: {} });
		assert.equal(r.state, 'online');
		assert.equal(r.items.length, 2, '没有 content 的条目要丢掉：' + JSON.stringify(r.items));
		assert.equal(r.items[0].content, '用户偏好 中文答复', '连续空白要折叠成单个空格');
		assert.equal(r.items[1].type, 'note', '缺 type 时默认 note');
	});
});

await checkAsync('★ 离线 ⇒ state=offline + 带错误原因（不抛）', async () => {
	await withFetch(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3112'); }, async () => {
		const r = await listAgentMemoryCandidates({ agentMemoryGatewayUrl: 'http://127.0.0.1:3112' }, 'coder', { env: {} });
		assert.equal(r.state, 'offline');
		assert.equal(r.items.length, 0);
		assert.ok(String(r.error).includes('ECONNREFUSED'));
	});
});

await checkAsync('★ 返回形状不认识 ⇒ offline（不冒充空库）', async () => {
	await withFetch(async () => ({ ok: true, text: async () => '{"weird":true}' }), async () => {
		const r = await listAgentMemoryCandidates({ agentMemoryGatewayUrl: 'http://127.0.0.1:3112' }, 'coder', { env: {} });
		assert.equal(r.state, 'offline', '形状不对要判离线，不能返回空列表让人以为"库是空的"');
		assert.ok(String(r.error).includes('形状不认识'));
	});
});

await checkAsync('HTTP 非 2xx ⇒ offline 且带状态码', async () => {
	await withFetch(async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', text: async () => 'down' }), async () => {
		const r = await listAgentMemoryCandidates({ agentMemoryGatewayUrl: 'http://127.0.0.1:3112' }, 'coder', { env: {} });
		assert.equal(r.state, 'offline');
		assert.ok(String(r.error).includes('503'));
	});
});

/* ── extras：结晶 + 治理审计（演化页签，2026-10-27）──────────────────── */
await checkAsync('★ extras：未配置 ⇒ unconfigured（不发请求）', async () => {
	let called = 0;
	await withFetch(async () => { called += 1; return { ok: true, text: async () => '[]' }; }, async () => {
		const r = await listAgentMemoryExtras({}, 'coder', { env: {} });
		assert.equal(r.state, 'unconfigured');
		assert.deepEqual(r.crystals, []);
		assert.deepEqual(r.audit, []);
	});
	assert.equal(called, 0);
});

await checkAsync('★ extras：在线 ⇒ 两条都取（title/summary 兜底、action/target 映射）', async () => {
	await withFetch(async (url) => {
		const m = String(url).match(/\/provider\/(\w+)/)[1];
		if (m === 'crystalList') {
			return { ok: true, text: async () => JSON.stringify([{ id: 'c1', title: '评测规范 v2', at: '2026-10-25' }, { id: 'c2', summary: '迁移三坑' }]) };
		}
		if (m === 'governanceAuditQuery') {
			return { ok: true, text: async () => JSON.stringify([{ id: 'a1', action: 'delete', targetId: 'fact#abc', at: '2026-10-26' }]) };
		}
		return { ok: true, text: async () => '[]' };
	}, async () => {
		const r = await listAgentMemoryExtras({ agentMemoryGatewayUrl: 'http://x:3112' }, 'coder', { env: {} });
		assert.equal(r.state, 'online');
		assert.equal(r.crystals.length, 2);
		assert.equal(r.crystals[1].title, '迁移三坑', 'summary 应能当 title 用');
		assert.equal(r.audit.length, 1);
		assert.equal(r.audit[0].action, 'delete');
		assert.equal(r.audit[0].target, 'fact#abc');
	});
});

await checkAsync('★ extras：形状不认识 ⇒ warn（不静默成"空库"）', async () => {
	await withFetch(async () => ({ ok: true, text: async () => JSON.stringify([{ weird: 1 }]) }), async () => {
		const r = await listAgentMemoryExtras({ agentMemoryGatewayUrl: 'http://x:3112' }, 'coder', { env: {} });
		assert.equal(r.crystals.length, 0);
		assert.ok(r.warn.length >= 1, '拿到 1 条却解析不出 ⇒ 必须 warn：' + JSON.stringify(r));
	});
});

await checkAsync('extras：一条失败不影响另一条（state 仍 online）', async () => {
	await withFetch(async (url) => {
		const m = String(url).match(/\/provider\/(\w+)/)[1];
		if (m === 'crystalList') { throw new Error('boom'); }
		return { ok: true, text: async () => JSON.stringify([{ action: 'delete' }]) };
	}, async () => {
		const r = await listAgentMemoryExtras({ agentMemoryGatewayUrl: 'http://x:3112' }, 'coder', { env: {} });
		assert.equal(r.state, 'online');
		assert.equal(r.audit.length, 1);
		assert.ok(r.errors.some((e) => String(e).includes('boom')));
	});
});

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ AgentMemory 候选单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
