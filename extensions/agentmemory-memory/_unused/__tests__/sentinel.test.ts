/*---------------------------------------------------------------------------------------------
 *  Sentinel 评估生命周期测试（amAdvanced.sentinelCheck / sentinelTrigger / sentinelCancel）
 *
 *  覆盖：threshold（指标比较）/ pattern（新记忆匹配）/ schedule（到期）三类条件、
 *  过期处理、触发幂等、手动触发/取消、以及无 status 字段历史条目的向后兼容。
 *  使用 MockStateKV（内存 Map），与 amV2.test.ts 同一模式。
 *--------------------------------------------------------------------------------------------*/

import * as adv from '../amAdvanced.js';
import * as fn from '../amFunctions.js';
import { KV, generateId } from '../amSchema.js';

class MockStateKV {
	private _store = new Map<string, Map<string, string>>();
	async get<T = unknown>(scope: string, key: string): Promise<T | null> {
		const raw = this._store.get(scope)?.get(key);
		return raw ? JSON.parse(raw) as T : null;
	}
	async set<T = unknown>(scope: string, key: string, value: T): Promise<void> {
		if (!this._store.has(scope)) this._store.set(scope, new Map());
		this._store.get(scope)!.set(key, JSON.stringify(value));
	}
	async delete(scope: string, key: string): Promise<void> { this._store.get(scope)?.delete(key); }
	async list<T = unknown>(scope: string): Promise<T[]> {
		const out: T[] = [];
		for (const raw of this._store.get(scope)?.values() ?? []) {
			try { out.push(JSON.parse(raw) as T); } catch { /* skip */ }
		}
		return out;
	}
	async listKeys(scope: string): Promise<string[]> {
		const m = this._store.get(scope);
		return m ? Array.from(m.keys()) : [];
	}
	async clearScope(scope: string): Promise<void> { this._store.delete(scope); }
}

const AGENT = 'test-agent';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
	if (cond) { passed++; }
	else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

async function test(name: string, t: (kv: MockStateKV) => Promise<void>): Promise<void> {
	console.log(`\n  ${name}`);
	const kv = new MockStateKV();
	try { await t(kv); }
	catch (err) {
		failed++;
		const msg = err instanceof Error ? err.message : String(err);
		failures.push(`${name}: threw ${msg}`);
		console.log(`  ✗ threw: ${msg}`);
	}
}

async function addMemory(kv: MockStateKV, content: string, createdAt?: string): Promise<void> {
	const m = {
		id: generateId('mem'), type: 'fact', content,
		createdAt: createdAt ?? new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		strength: 5, isLatest: true, concepts: [], metadata: {},
	};
	await kv.set(KV.memories(AGENT), m.id, m);
}

export async function runSentinelTests(): Promise<void> {
	passed = 0; failed = 0; failures.length = 0;
	console.log('\n🧪 Sentinel Lifecycle (check/trigger/cancel) Tests\n');

	await test('sentinelCreate: status=watching', async (kv) => {
		const s = await adv.sentinelCreate(kv as any, AGENT, 'watch', 'memory_count > 5');
		assert(s.status === 'watching', 'new sentinel should be watching');
	});

	await test('threshold: 命中条件触发并写 result', async (kv) => {
		await addMemory(kv, 'fact one');
		await addMemory(kv, 'fact two');
		const s = await adv.sentinelCreate(kv as any, AGENT, 'too-many', 'memory_count > 1');
		const r = await adv.sentinelCheck(kv as any, AGENT);
		assert(r.checked === 1, `checked=1 (got ${r.checked})`);
		assert(r.triggered.length === 1, `1 triggered (got ${r.triggered.length})`);
		assert(r.triggered[0].result.reason === 'threshold_crossed', 'reason=threshold_crossed');
		assert(r.triggered[0].result.currentValue === 2, 'currentValue=2');
		const stored = await kv.get<adv.Sentinel>(KV.sentinels(AGENT), s.id);
		assert(stored?.status === 'triggered', 'stored status=triggered');
		assert(!!stored?.triggeredAt, 'triggeredAt set');
	});

	await test('threshold: 条件不满足不触发；支持 gte/单词运算符', async (kv) => {
		await addMemory(kv, 'one');
		await adv.sentinelCreate(kv as any, AGENT, 'big', 'memory_count >= 100');
		const r = await adv.sentinelCheck(kv as any, AGENT);
		assert(r.triggered.length === 0, 'not triggered');
		const r2 = await adv.sentinelCheck(kv as any, AGENT);
		assert(r2.checked === 1, 'still watching → checked again');
	});

	await test('threshold: 未知指标/无法解析条件 → errors 而不误触发', async (kv) => {
		await adv.sentinelCreate(kv as any, AGENT, 'bad-metric', 'foo_count > 1');
		await adv.sentinelCreate(kv as any, AGENT, 'bad-cond', 'when memory is full');
		const r = await adv.sentinelCheck(kv as any, AGENT);
		assert(r.triggered.length === 0, 'none triggered');
		assert(r.errors.length === 2, `2 errors (got ${r.errors.length}): ${JSON.stringify(r.errors)}`);
	});

	await test('pattern: 只匹配哨兵创建之后的新记忆', async (kv) => {
		// 旧记忆（哨兵创建前）不应触发
		const old = new Date(Date.now() - 60_000).toISOString();
		await addMemory(kv, 'database connection failed at boot', old);
		const s = await adv.sentinelCreate(kv as any, AGENT, 'db-errors', 'database.*failed', 'pattern');
		const r1 = await adv.sentinelCheck(kv as any, AGENT);
		assert(r1.triggered.length === 0, 'old memory should NOT trigger');
		// 新记忆应触发
		await addMemory(kv, 'database query failed again');
		const r2 = await adv.sentinelCheck(kv as any, AGENT);
		assert(r2.triggered.length === 1, 'new memory SHOULD trigger');
		assert(r2.triggered[0].result.reason === 'pattern_matched', 'reason=pattern_matched');
		assert(String(r2.triggered[0].result.matchedContent).includes('database query failed'), 'matched content recorded');
		void s;
	});

	await test('schedule: 到期触发，未到期不触发', async (kv) => {
		await adv.sentinelCreate(kv as any, AGENT, 'immediate', '0ms', 'schedule');
		await adv.sentinelCreate(kv as any, AGENT, 'later', '1h', 'schedule');
		const r = await adv.sentinelCheck(kv as any, AGENT);
		assert(r.triggered.length === 1, `only immediate triggers (got ${r.triggered.length})`);
		assert(r.triggered[0].result.reason === 'schedule_elapsed', 'reason=schedule_elapsed');
	});

	await test('触发幂等：第二次 check 不重复触发', async (kv) => {
		await addMemory(kv, 'x');
		await adv.sentinelCreate(kv as any, AGENT, 'once', 'memory_count > 0');
		const r1 = await adv.sentinelCheck(kv as any, AGENT);
		const r2 = await adv.sentinelCheck(kv as any, AGENT);
		assert(r1.triggered.length === 1, 'first check triggers');
		assert(r2.triggered.length === 0, 'second check does not re-trigger');
		assert(r2.checked === 0, 'no longer watching');
	});

	await test('expired: expiresAt 已过 → 标记 expired 且不评估', async (kv) => {
		const s = await adv.sentinelCreate(kv as any, AGENT, 'exp', 'memory_count > 999');
		s.expiresAt = new Date(Date.now() - 1000).toISOString();
		await kv.set(KV.sentinels(AGENT), s.id, s);
		const r = await adv.sentinelCheck(kv as any, AGENT);
		assert(r.expired === 1, `expired=1 (got ${r.expired})`);
		assert(r.checked === 0, 'not checked');
	});

	await test('sentinelTrigger: 手动触发；已触发再次触发报错', async (kv) => {
		const s = await adv.sentinelCreate(kv as any, AGENT, 'manual', 'memory_count > 999');
		const ok = await adv.sentinelTrigger(kv as any, AGENT, s.id, { reason: 'ops_request' });
		assert(ok.success, 'manual trigger succeeds');
		const again = await adv.sentinelTrigger(kv as any, AGENT, s.id);
		assert(!again.success && /already/.test(again.error ?? ''), 're-trigger rejected');
		const stored = await kv.get<adv.Sentinel>(KV.sentinels(AGENT), s.id);
		assert(stored?.result?.reason === 'ops_request', 'result recorded');
	});

	await test('sentinelCancel: 取消 watching；不能取消已触发', async (kv) => {
		const s1 = await adv.sentinelCreate(kv as any, AGENT, 'c1', 'memory_count > 0');
		const ok = await adv.sentinelCancel(kv as any, AGENT, s1.id);
		assert(ok.success, 'cancel succeeds');
		const s2 = await adv.sentinelCreate(kv as any, AGENT, 'c2', 'memory_count > 0');
		await adv.sentinelTrigger(kv as any, AGENT, s2.id);
		const bad = await adv.sentinelCancel(kv as any, AGENT, s2.id);
		assert(!bad.success, 'cannot cancel triggered');
		const r = await adv.sentinelCheck(kv as any, AGENT);
		assert(r.checked === 0, 'cancelled/triggered not checked');
	});

	await test('向后兼容：无 status 字段的历史哨兵按 watching 处理', async (kv) => {
		await addMemory(kv, 'legacy data');
		// 模拟旧格式：无 status 字段
		const legacy: any = { id: generateId('sen'), name: 'legacy', condition: 'memory_count > 0', type: 'threshold', linkedActionIds: [], createdAt: new Date().toISOString() };
		await kv.set(KV.sentinels(AGENT), legacy.id, legacy);
		const r = await adv.sentinelCheck(kv as any, AGENT);
		assert(r.triggered.length === 1, 'legacy sentinel evaluated & triggered');
	});

	console.log(`\n  Sentinel: ${passed} passed, ${failed} failed\n`);
	if (failed > 0) {
		console.log('  Failures:');
		for (const f of failures) console.log(`    - ${f}`);
		throw new Error(`${failed} sentinel test(s) failed`);
	}
}
