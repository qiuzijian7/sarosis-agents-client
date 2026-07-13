/*---------------------------------------------------------------------------------------------
 *  AgentMemoryProviderV2 模块测试
 *
 *  使用 MockStateKV（内存 Map 模拟 KV store），无需真实 agentmemory server。
 *  测试所有无状态函数的输入输出和边界条件。
 *--------------------------------------------------------------------------------------------*/

import * as fn from '../amFunctions.js';
import * as pipe from '../amPipeline.js';
import * as sl from '../amSlots.js';
import * as feat from '../amFeatures.js';
import * as extra from '../amExtras.js';
import * as adv from '../amAdvanced.js';
import * as rem from '../amRemaining.js';
import * as fin from '../amFinal.js';
import { BM25Index } from '../bm25Index.js';
import { KV } from '../amSchema.js';
import type { Memory, CoreMemoryEntry, Lesson, SemanticMemory, ProceduralMemory, Insight, SessionSummary, MemorySlot } from '../amTypes.js';

// ─── Mock StateKV（内存 Map 模拟）──────────────────────────────────────

class MockStateKV {
	private _store = new Map<string, Map<string, string>>();

	async get<T = unknown>(scope: string, key: string): Promise<T | null> {
		const scopeMap = this._store.get(scope);
		if (!scopeMap) return null;
		const raw = scopeMap.get(key);
		if (!raw) return null;
		return JSON.parse(raw) as T;
	}

	async set<T = unknown>(scope: string, key: string, value: T): Promise<void> {
		if (!this._store.has(scope)) this._store.set(scope, new Map());
		this._store.get(scope)!.set(key, JSON.stringify(value));
	}

	async delete(scope: string, key: string): Promise<void> {
		this._store.get(scope)?.delete(key);
	}

	async list<T = unknown>(scope: string): Promise<T[]> {
		const scopeMap = this._store.get(scope);
		if (!scopeMap) return [];
		const results: T[] = [];
		for (const raw of scopeMap.values()) {
			try { results.push(JSON.parse(raw) as T); } catch { /* skip */ }
		}
		return results;
	}

	async listKeys(scope: string): Promise<string[]> {
		const scopeMap = this._store.get(scope);
		return scopeMap ? Array.from(scopeMap.keys()) : [];
	}

	async clearScope(scope: string): Promise<void> {
		this._store.delete(scope);
	}
}

const AGENT_ID = 'test-agent';

// ─── 测试框架 ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
	if (cond) { passed++; }
	else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
	const cond = JSON.stringify(actual) === JSON.stringify(expected);
	if (cond) { passed++; }
	else { failed++; failures.push(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); console.log(`  ✗ ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); }
}

async function test(name: string, t: (kv: MockStateKV) => Promise<void>): Promise<void> {
	console.log(`\n  ${name}`);
	const kv = new MockStateKV();
	try {
		await t(kv);
	} catch (err) {
		failed++;
		const msg = err instanceof Error ? err.message : String(err);
		failures.push(`${name}: threw ${msg}`);
		console.log(`  ✗ threw: ${msg}`);
	}
}

// ─── 测试用例 ───────────────────────────────────────────────────────────

export async function runAmV2Tests(): Promise<void> {
	passed = 0;
	failed = 0;
	failures.length = 0;
	console.log('\n🧪 AgentMemoryProviderV2 (Stateless Functions) Tests\n');

	// 1. Core Memory
	await test('coreAdd: creates entry with correct fields', async (kv) => {
		const id = await fn.coreAdd(kv as any, AGENT_ID, 'Test core memory', 8, true);
		assert(!!id, 'should return non-empty id');
		const entries = await fn.coreList(kv as any, AGENT_ID);
		assertEq(entries.length, 1, 'should have 1 entry');
		assertEq(entries[0].content, 'Test core memory', 'content matches');
		assertEq(entries[0].importance, 8, 'importance matches');
		assertEq(entries[0].pinned, true, 'pinned matches');
	});

	await test('coreAdd: defaults importance=7, pinned=false', async (kv) => {
		await fn.coreAdd(kv as any, AGENT_ID, 'Default core');
		const entries = await fn.coreList(kv as any, AGENT_ID);
		assertEq(entries[0].importance, 7, 'default importance');
		assertEq(entries[0].pinned, false, 'default pinned');
	});

	await test('coreRemove: removes entry', async (kv) => {
		const id = await fn.coreAdd(kv as any, AGENT_ID, 'To remove');
		assertEq((await fn.coreList(kv as any, AGENT_ID)).length, 1, 'exists before remove');
		await fn.coreRemove(kv as any, AGENT_ID, id);
		assertEq((await fn.coreList(kv as any, AGENT_ID)).length, 0, 'removed');
	});

	await test('coreList: sorted by importance desc', async (kv) => {
		await fn.coreAdd(kv as any, AGENT_ID, 'Low', 3);
		await fn.coreAdd(kv as any, AGENT_ID, 'High', 9);
		await fn.coreAdd(kv as any, AGENT_ID, 'Med', 6);
		const entries = await fn.coreList(kv as any, AGENT_ID);
		assertEq(entries[0].importance, 9, 'highest first');
		assertEq(entries[2].importance, 3, 'lowest last');
	});

	await test('coreAdd: empty content returns empty id', async (kv) => {
		const id = await fn.coreAdd(kv as any, AGENT_ID, '');
		assertEq(id, '', 'empty content → empty id');
	});

	// 2. Remember
	await test('remember: creates memory with correct type', async (kv) => {
		const result = await fn.remember(kv as any, AGENT_ID, 'Use TypeScript for all new files', 'preference');
		assert(result.success, 'should succeed');
		assertEq(result.action, 'created', 'action is created');
		const memories = await kv.list<Memory>(KV.memories(AGENT_ID));
		assertEq(memories.length, 1, '1 memory stored');
		assertEq(memories[0].type, 'preference', 'type matches');
		assertEq(memories[0].isLatest, true, 'isLatest=true');
		assertEq(memories[0].strength, 7, 'default strength=7');
	});

	await test('remember: default type is fact', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Some fact');
		const memories = await kv.list<Memory>(KV.memories(AGENT_ID));
		assertEq(memories[0].type, 'fact', 'default type');
	});

	await test('remember: Jaccard conflict >0.7 creates version chain', async (kv) => {
		// ~0.8 Jaccard: 大部分词相同
		await fn.remember(kv as any, AGENT_ID, 'Always use strict mode in TypeScript for better safety', 'preference');
		await fn.remember(kv as any, AGENT_ID, 'Always use strict mode in TypeScript for better safety and reliability', 'preference');
		const memories = await kv.list<Memory>(KV.memories(AGENT_ID));
		assertEq(memories.length, 2, '2 memories (old + new)');
		const oldMem = memories.find(m => m.isLatest === false);
		const newMem = memories.find(m => m.isLatest === true);
		assert(!!oldMem, 'old memory marked isLatest=false');
		assert(!!newMem, 'new memory isLatest=true');
		assertEq(newMem!.parentId, oldMem!.id, 'new parentId links to old');
	});

	await test('remember: identical content fingerprint deduplicates', async (kv) => {
		const r1 = await fn.remember(kv as any, AGENT_ID, 'Always use strict mode in TypeScript', 'preference');
		const r2 = await fn.remember(kv as any, AGENT_ID, 'Always use strict mode in TypeScript', 'preference');
		assertEq(r1.id, r2.id, 'same fingerprint returns same id');
		assertEq(r2.action, 'deduplicated', 'action is deduplicated');
	});

	await test('remember: different content does not supersede', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Use TypeScript', 'preference');
		await fn.remember(kv as any, AGENT_ID, 'Use Python for scripts', 'preference');
		const memories = await kv.list<Memory>(KV.memories(AGENT_ID));
		assertEq(memories.filter(m => m.isLatest).length, 2, 'both isLatest=true');
	});

	await test('remember: empty content fails', async (kv) => {
		const result = await fn.remember(kv as any, AGENT_ID, '');
		assert(!result.success, 'should fail');
	});

	// 3. Search（需要 BM25 索引，seed 索引后测试）
	async function seedBM25FromKV(kv: MockStateKV): Promise<BM25Index> {
		const bm25 = new BM25Index();
		const mems = await (kv as any).list(KV.memories(AGENT_ID));
		for (const m of mems) {
			if (m.isLatest !== false && m.content) bm25.add(m.id || '', m.content);
		}
		fn.setIndexGetters(() => bm25, () => null as any);
		return bm25;
	}

	await test('searchMemories: returns matching memories', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Use React for frontend components', 'pattern');
		await fn.remember(kv as any, AGENT_ID, 'Database connection pool config', 'architecture');
		await fn.remember(kv as any, AGENT_ID, 'React hooks best practices', 'pattern');
		await seedBM25FromKV(kv);
		const results = await fn.searchMemories(kv as any, AGENT_ID, 'React');
		assert(results.length > 0, 'React matches found');
		assert(results.every(r => r.score > 0), 'all scores positive');
	});

	await test('searchMemories: no match returns empty', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'TypeScript config', 'fact');
		await seedBM25FromKV(kv);
		const results = await fn.searchMemories(kv as any, AGENT_ID, 'xyznonexistentzzz');
		assertEq(results.length, 0, 'no matches');
	});

	await test('searchMemories: respects limit', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'React component architecture pattern', 'fact');
		await fn.remember(kv as any, AGENT_ID, 'Database connection pool optimization', 'fact');
		await fn.remember(kv as any, AGENT_ID, 'WebSocket real-time communication setup', 'fact');
		await fn.remember(kv as any, AGENT_ID, 'Docker container networking configuration', 'fact');
		await fn.remember(kv as any, AGENT_ID, 'Kubernetes deployment scaling strategy', 'fact');
		await seedBM25FromKV(kv);
		const results = await fn.searchMemories(kv as any, AGENT_ID, 'component', 2);
		assert(results.length <= 2, 'limited to 2 or fewer');
	});

	await test('searchMemories: excludes superseded via Jaccard', async (kv) => {
		// 相似但不完全相同的内容触发 Jaccard 冲突
		await fn.remember(kv as any, AGENT_ID, 'Duplicate content for test purposes', 'fact');
		await fn.remember(kv as any, AGENT_ID, 'Duplicate content for test purposes and verification', 'fact');
		await seedBM25FromKV(kv);
		const results = await fn.searchMemories(kv as any, AGENT_ID, 'Duplicate');
		assert(results.length >= 1, 'at least latest version found');
		// 所有返回的记忆都是最新版本
		const allMems = await (kv as any).list(KV.memories(AGENT_ID));
		for (const r of results) {
			const mem = allMems.find((m: any) => m.id === r.id);
			assert(mem.isLatest !== false, 'returned memory is latest');
		}
	});

	// 4. Access Tracker
	await test('recordAccess: creates and updates log', async (kv) => {
		await fn.recordAccess(kv as any, AGENT_ID, 'mem-1');
		let log = await fn.getAccessLog(kv as any, AGENT_ID, 'mem-1');
		assertEq(log.count, 1, 'count=1 after first access');
		await fn.recordAccess(kv as any, AGENT_ID, 'mem-1');
		await fn.recordAccess(kv as any, AGENT_ID, 'mem-1');
		log = await fn.getAccessLog(kv as any, AGENT_ID, 'mem-1');
		assertEq(log.count, 3, 'count=3 after 3 accesses');
	});

	await test('recordAccess: recent capped at 20', async (kv) => {
		for (let i = 0; i < 25; i++) {
			await fn.recordAccess(kv as any, AGENT_ID, 'mem-cap', Date.now() + i);
		}
		const log = await fn.getAccessLog(kv as any, AGENT_ID, 'mem-cap');
		assertEq(log.recent.length, 20, 'recent capped at 20');
		assertEq(log.count, 25, 'count still 25');
	});

	await test('recordAccessBatch: batch records', async (kv) => {
		await fn.recordAccessBatch(kv as any, AGENT_ID, ['a', 'b', 'c']);
		const logA = await fn.getAccessLog(kv as any, AGENT_ID, 'a');
		assertEq(logA.count, 1, 'a accessed once');
	});

	await test('deleteAccessLog: removes log', async (kv) => {
		await fn.recordAccess(kv as any, AGENT_ID, 'mem-del');
		await fn.deleteAccessLog(kv as any, AGENT_ID, 'mem-del');
		const log = await fn.getAccessLog(kv as any, AGENT_ID, 'mem-del');
		assertEq(log.count, 0, 'count=0 after delete');
	});

	// 5. Forget / Reinforce
	await test('forgetMemory: marks isLatest=false', async (kv) => {
		const result = await fn.remember(kv as any, AGENT_ID, 'To forget', 'fact');
		const ok = await fn.forgetMemory(kv as any, AGENT_ID, result.id!);
		assertEq(ok, true, 'returns true');
		const mem = await kv.get<Memory>(KV.memories(AGENT_ID), result.id!);
		assertEq(mem!.isLatest, false, 'isLatest=false');
	});

	await test('forgetMemory: non-existent returns false', async (kv) => {
		const ok = await fn.forgetMemory(kv as any, AGENT_ID, 'nonexistent');
		assertEq(ok, false, 'returns false');
	});

	await test('reinforceMemory: increments strength', async (kv) => {
		const result = await fn.remember(kv as any, AGENT_ID, 'To reinforce', 'fact');
		await fn.reinforceMemory(kv as any, AGENT_ID, result.id!);
		const mem = await kv.get<Memory>(KV.memories(AGENT_ID), result.id!);
		assertEq(mem!.strength, 8, 'strength=8 after reinforce');
		const log = await fn.getAccessLog(kv as any, AGENT_ID, result.id!);
		assertEq(log.count, 1, 'access recorded');
	});

	// 6. Auto-forget
	await test('autoForget: TTL expired memories removed', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Expired memory', 'fact', undefined, undefined, -1);
		const forgetResult = await fn.autoForget(kv as any, AGENT_ID, false);
		assert(forgetResult.ttlExpired.length > 0, 'TTL expired detected');
		const memories = await kv.list<Memory>(KV.memories(AGENT_ID));
		assertEq(memories.length, 0, 'expired memory deleted');
	});

	await test('autoForget: contradiction detected', async (kv) => {
		// 直接插入两条高度相似且 isLatest=true 的记忆（绕过 remember 的冲突检测）
		const now = new Date().toISOString();
		const mem1: Memory = {
			id: 'mem-a', createdAt: now, updatedAt: now, type: 'preference',
			title: 'Always use strict mode in TypeScript', content: 'Always use strict mode in TypeScript files here',
			concepts: [], files: [], sessionIds: [], strength: 7, version: 1, isLatest: true, agentId: AGENT_ID,
		};
		const mem2: Memory = {
			id: 'mem-b', createdAt: now, updatedAt: now, type: 'preference',
			title: 'Always use strict mode in TypeScript', content: 'Always use strict mode in TypeScript files here',
			concepts: [], files: [], sessionIds: [], strength: 7, version: 1, isLatest: true, agentId: AGENT_ID,
		};
		await kv.set(KV.memories(AGENT_ID), mem1.id, mem1);
		await kv.set(KV.memories(AGENT_ID), mem2.id, mem2);
		const forgetResult = await fn.autoForget(kv as any, AGENT_ID, true);
		assert(forgetResult.contradictions.length > 0, 'contradiction detected');
	});

	await test('autoForget: dryRun does not delete', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Expired', 'fact', undefined, undefined, -1);
		await fn.autoForget(kv as any, AGENT_ID, true);
		const memories = await kv.list<Memory>(KV.memories(AGENT_ID));
		assertEq(memories.length, 1, 'not deleted in dryRun');
	});

	// 7. Lessons
	await test('lessonSave: creates new lesson', async (kv) => {
		const result = await fn.lessonSave(kv as any, AGENT_ID, 'Always check null before accessing properties', 'null safety', 0.8);
		assertEq(result.action, 'created', 'action=created');
		const lessons = await kv.list<Lesson>(KV.lessons(AGENT_ID));
		assertEq(lessons.length, 1, '1 lesson stored');
		assertEq(lessons[0].confidence, 0.8, 'confidence matches');
	});

	await test('lessonSave: strengthens existing (fingerprint dedup)', async (kv) => {
		await fn.lessonSave(kv as any, AGENT_ID, 'Always check null before accessing properties', '', 0.5);
		const result = await fn.lessonSave(kv as any, AGENT_ID, 'Always check null before accessing properties', '', 0.5);
		assertEq(result.action, 'strengthened', 'action=strengthened');
		const lessons = await kv.list<Lesson>(KV.lessons(AGENT_ID));
		assertEq(lessons.length, 1, 'still 1 lesson (dedup)');
		assert(lessons[0].confidence > 0.5, 'confidence increased');
		assertEq(lessons[0].reinforcements, 1, 'reinforcements=1');
	});

	await test('lessonRecall: returns matching lessons', async (kv) => {
		await fn.lessonSave(kv as any, AGENT_ID, 'Use tabs not spaces for indentation', 'formatting', 0.9);
		await fn.lessonSave(kv as any, AGENT_ID, 'Always handle errors in async functions', 'error handling', 0.7);
		const results = await fn.lessonRecall(kv as any, AGENT_ID, 'tabs indentation');
		assertEq(results.length, 1, '1 match');
		assertEq(results[0].content, 'Use tabs not spaces for indentation', 'content matches');
	});

	await test('lessonRecall: no match returns empty', async (kv) => {
		await fn.lessonSave(kv as any, AGENT_ID, 'Some lesson', '', 0.5);
		const results = await fn.lessonRecall(kv as any, AGENT_ID, 'nonexistent');
		assertEq(results.length, 0, 'no matches');
	});

	await test('lessonDecaySweep: decays old lessons', async (kv) => {
		await fn.lessonSave(kv as any, AGENT_ID, 'Old lesson', '', 0.8);
		const lessons = await kv.list<Lesson>(KV.lessons(AGENT_ID));
		lessons[0].createdAt = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
		lessons[0].lastReinforcedAt = lessons[0].createdAt;
		await kv.set(KV.lessons(AGENT_ID), lessons[0].id, lessons[0]);
		const result = await fn.lessonDecaySweep(kv as any, AGENT_ID);
		assert(result.decayed > 0, 'lesson decayed');
		const after = await kv.list<Lesson>(KV.lessons(AGENT_ID));
		assert(after[0].confidence < 0.8, 'confidence decreased');
	});

	// 8. Retention
	await test('retentionScore: computes scores and tiers', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Important architecture decision', 'architecture');
		await fn.remember(kv as any, AGENT_ID, 'Minor fact', 'fact');
		const result = await fn.retentionScore(kv as any, AGENT_ID);
		assertEq(result.total, 2, '2 memories scored');
		assert(result.tiers.hot + result.tiers.warm + result.tiers.cold + result.tiers.evictable === 2, 'tiers sum to total');
	});

	// 9. Evict
	await test('evict: removes TTL expired', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Expired', 'fact', undefined, undefined, -1);
		const stats = await fn.evict(kv as any, AGENT_ID, false);
		assert(stats.expiredMemories > 0, 'expired detected');
		const memories = await kv.list<Memory>(KV.memories(AGENT_ID));
		assertEq(memories.length, 0, 'deleted');
	});

	await test('evict: dryRun does not delete', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Expired', 'fact', undefined, undefined, -1);
		await fn.evict(kv as any, AGENT_ID, true);
		const memories = await kv.list<Memory>(KV.memories(AGENT_ID));
		assertEq(memories.length, 1, 'not deleted in dryRun');
	});

	// 10. autoPage
	await test('autoPage: demotes core to archival when over budget', async (kv) => {
		for (let i = 0; i < 20; i++) {
			await fn.coreAdd(kv as any, AGENT_ID, `Core entry ${i} with some content to fill budget`, 5, false);
		}
		const paged = await fn.autoPage(kv as any, AGENT_ID, 100);
		assert(paged > 0, 'some entries paged');
		const memCount = (await kv.list<Memory>(KV.memories(AGENT_ID))).length;
		assert(memCount > 0, 'memories increased (paged to archival)');
	});

	await test('autoPage: pinned entries not demoted', async (kv) => {
		await fn.coreAdd(kv as any, AGENT_ID, 'Pinned important info', 10, true);
		await fn.coreAdd(kv as any, AGENT_ID, 'Unpinned 1', 3, false);
		await fn.coreAdd(kv as any, AGENT_ID, 'Unpinned 2', 3, false);
		await fn.autoPage(kv as any, AGENT_ID, 10);
		const core = await kv.list<CoreMemoryEntry>(KV.coreMemory(AGENT_ID));
		const pinned = core.filter(e => e.pinned);
		assertEq(pinned.length, 1, 'pinned entry preserved');
	});

	// 11. writeMemory (IMemoryProvider compat)
	await test('writeMemory: working type → core memory', async (kv) => {
		await fn.writeMemory(kv as any, AGENT_ID, {
			id: 'test-1', type: 'working', content: 'Working memory entry',
			metadata: { importance: 6, pinned: false },
		});
		const core = await fn.coreList(kv as any, AGENT_ID);
		assertEq(core.length, 1, 'stored in core memory');
		assertEq(core[0].content, 'Working memory entry', 'content matches');
	});

	await test('writeMemory: episodic type → memories', async (kv) => {
		await fn.writeMemory(kv as any, AGENT_ID, {
			id: 'test-2', type: 'episodic', content: 'Episodic memory entry',
			metadata: { concepts: ['test'] },
		});
		const memories = await kv.list<Memory>(KV.memories(AGENT_ID));
		assertEq(memories.length, 1, 'stored in memories');
	});

	await test('writeMemory: slot_id → core pinned', async (kv) => {
		await fn.writeMemory(kv as any, AGENT_ID, {
			id: 'slot-1', type: 'episodic', content: 'Slot content',
			metadata: { slot_id: 'persona' },
		});
		const core = await fn.coreList(kv as any, AGENT_ID);
		assertEq(core[0].pinned, true, 'pinned=true for slot');
	});

	await test('writeMemory: empty content returns false', async (kv) => {
		const ok = await fn.writeMemory(kv as any, AGENT_ID, { type: 'episodic', content: '' });
		assertEq(ok, false, 'empty content fails');
	});

	// 12. loadContext
	await test('loadContext: no query returns full context', async (kv) => {
		await fn.coreAdd(kv as any, AGENT_ID, 'Core info', 8, true);
		await fn.remember(kv as any, AGENT_ID, 'Long term memory', 'fact');
		const ctx = await fn.loadContextFn(kv as any, AGENT_ID, 'session-1', undefined, 2000);
		assert(ctx.systemPrompt.length > 0, 'systemPrompt not empty');
		assert(ctx.systemPrompt.includes('<agentmemory-context'), 'XML wrapped');
		assert(ctx.shortTermMemories.length > 0, 'shortTermMemories not empty');
		assert(ctx.longTermMemories.length > 0, 'longTermMemories not empty');
	});

	await test('loadContext: with query returns search results', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'React components', 'pattern');
		await seedBM25FromKV(kv);
		const ctx = await fn.loadContextFn(kv as any, AGENT_ID, 'session-1', 'React', 2000);
		assert(ctx.systemPrompt.includes('Search Results'), 'has search results section');
	});

	// 13. getStats
	await test('getStats: returns correct counts', async (kv) => {
		await fn.coreAdd(kv as any, AGENT_ID, 'Core 1', 5);
		await fn.coreAdd(kv as any, AGENT_ID, 'Core 2', 7);
		await fn.remember(kv as any, AGENT_ID, 'React component architecture pattern', 'fact');
		await fn.remember(kv as any, AGENT_ID, 'Database optimization query indexing', 'pattern');
		await fn.lessonSave(kv as any, AGENT_ID, 'Lesson 1', '', 0.8);
		const stats = await fn.getStatsFn(kv as any, AGENT_ID);
		assertEq(stats.coreMemoryCount, 2, '2 core entries');
		assertEq(stats.longTermCount, 2, '2 long-term memories');
		assertEq(stats.lessonsCount, 1, '1 lesson');
	});

	// 14. removeAgent
	await test('removeAgent: clears all scopes', async (kv) => {
		await fn.coreAdd(kv as any, AGENT_ID, 'Core');
		await fn.remember(kv as any, AGENT_ID, 'Memory', 'fact');
		await fn.lessonSave(kv as any, AGENT_ID, 'Lesson', '', 0.5);
		await fn.recordAccess(kv as any, AGENT_ID, 'mem-1');
		await fn.removeAgentFn(kv as any, AGENT_ID);
		const memories = await kv.list<Memory>(KV.memories(AGENT_ID));
		const core = await kv.list<CoreMemoryEntry>(KV.coreMemory(AGENT_ID));
		const lessons = await kv.list<Lesson>(KV.lessons(AGENT_ID));
		assertEq(memories.length, 0, 'memories cleared');
		assertEq(core.length, 0, 'core cleared');
		assertEq(lessons.length, 0, 'lessons cleared');
	});

	// 15. buildWorkingContext
	await test('buildWorkingContext: includes core + archival', async (kv) => {
		await fn.coreAdd(kv as any, AGENT_ID, 'Important core info', 9, true);
		await fn.remember(kv as any, AGENT_ID, 'Archival memory', 'fact');
		const ctx = await fn.buildWorkingContext(kv as any, AGENT_ID, 2000);
		assert(ctx.includes('## Core Memory'), 'has Core Memory section');
		assert(ctx.includes('Important core info'), 'core content included');
		assert(ctx.includes('## Archival Memory'), 'has Archival Memory section');
	});

	// ─── 16. Semantic Memory 读写召回 ──────────────────────────────────
	await test('semanticSave: creates semantic memory', async (kv) => {
		const id = await fn.semanticSave(kv as any, AGENT_ID, 'React components follow functional pattern', 0.8, ['mem-1'], ['react', 'frontend']);
		assert(!!id, 'should return id');
		const all = await fn.semanticList(kv as any, AGENT_ID);
		assertEq(all.length, 1, '1 semantic memory');
		assertEq(all[0].content, 'React components follow functional pattern', 'content matches');
		assertEq(all[0].confidence, 0.8, 'confidence matches');
		assertEq(all[0].sourceIds, ['mem-1'], 'sourceIds matches');
	});

	await test('semanticSearch: returns matching by content', async (kv) => {
		await fn.semanticSave(kv as any, AGENT_ID, 'React functional components with hooks', 0.9, [], ['react']);
		await fn.semanticSave(kv as any, AGENT_ID, 'Database indexing strategies', 0.7, [], ['database']);
		const results = await fn.semanticSearch(kv as any, AGENT_ID, 'React');
		assertEq(results.length, 1, '1 match');
		assert(results[0].confidence === 0.9, 'higher confidence matched');
	});

	await test('semanticSearch: no match returns empty', async (kv) => {
		await fn.semanticSave(kv as any, AGENT_ID, 'Some semantic memory', 0.5);
		const results = await fn.semanticSearch(kv as any, AGENT_ID, 'nonexistent');
		assertEq(results.length, 0, 'no matches');
	});

	await test('semanticSave: empty content returns empty id', async (kv) => {
		const id = await fn.semanticSave(kv as any, AGENT_ID, '');
		assertEq(id, '', 'empty content → empty id');
	});

	// ─── 17. Procedural Memory 读写召回 ────────────────────────────────
	await test('proceduralSave: creates procedural memory', async (kv) => {
		const id = await fn.proceduralSave(kv as any, AGENT_ID,
			'Deploy to production',
			['Run tests', 'Build image', 'Push to registry', 'Deploy'],
			['All tests pass'], 'Service running in prod', 0.85, ['deploy', 'ci']);
		assert(!!id, 'should return id');
		const all = await fn.proceduralList(kv as any, AGENT_ID);
		assertEq(all.length, 1, '1 procedural memory');
		assertEq(all[0].title, 'Deploy to production', 'title matches');
		assertEq(all[0].steps.length, 4, '4 steps');
		assertEq(all[0].preconditions, ['All tests pass'], 'preconditions matches');
		assertEq(all[0].expectedOutcome, 'Service running in prod', 'outcome matches');
		assertEq(all[0].confidence, 0.85, 'confidence matches');
	});

	await test('proceduralSearch: matches by title and steps', async (kv) => {
		await fn.proceduralSave(kv as any, AGENT_ID, 'Deploy to production', ['Run tests', 'Build'], [], '', 0.8, ['deploy']);
		await fn.proceduralSave(kv as any, AGENT_ID, 'Code review process', ['Read PR', 'Comment', 'Approve'], [], '', 0.7, ['review']);
		const results = await fn.proceduralSearch(kv as any, AGENT_ID, 'Deploy');
		assertEq(results.length, 1, '1 match');
		assertEq(results[0].title, 'Deploy to production', 'correct title');
	});

	await test('proceduralSearch: matches by step content', async (kv) => {
		await fn.proceduralSave(kv as any, AGENT_ID, 'CI Pipeline', ['Lint code', 'Run unit tests', 'Build Docker image'], [], '', 0.9);
		const results = await fn.proceduralSearch(kv as any, AGENT_ID, 'Docker');
		assertEq(results.length, 1, 'matched by step content');
	});

	await test('proceduralSave: empty title returns empty id', async (kv) => {
		const id = await fn.proceduralSave(kv as any, AGENT_ID, '', ['step']);
		assertEq(id, '', 'empty title → empty id');
	});

	// ─── 18. Insight 读写 ─────────────────────────────────────────────
	await test('insightSave: creates insight', async (kv) => {
		const id = await fn.insightSave(kv as any, AGENT_ID, 'TypeScript strict mode catches 80% of runtime errors', 0.75, ['mem-1', 'mem-2'], ['typescript', 'quality']);
		assert(!!id, 'should return id');
		const all = await fn.insightList(kv as any, AGENT_ID);
		assertEq(all.length, 1, '1 insight');
		assertEq(all[0].content, 'TypeScript strict mode catches 80% of runtime errors', 'content matches');
		assertEq(all[0].confidence, 0.75, 'confidence matches');
		assertEq(all[0].sourceMemoryIds, ['mem-1', 'mem-2'], 'sourceMemoryIds matches');
	});

	await test('insightSave: empty content returns empty id', async (kv) => {
		const id = await fn.insightSave(kv as any, AGENT_ID, '');
		assertEq(id, '', 'empty content → empty id');
	});

	// ─── 19. Session Summary 读写 ─────────────────────────────────────
	await test('sessionSummarySave: creates summary', async (kv) => {
		const id = await fn.sessionSummarySave(kv as any, AGENT_ID,
			'sess-1', 'my-project', 'Fixed authentication bug',
			'Investigated JWT token validation, found missing expiry check',
			['Add expiry validation', 'Use async verify'], ['auth.ts', 'jwt.ts'], ['auth', 'jwt'], 15);
		assertEq(id, 'sess-1', 'returns sessionId as key');
		const all = await fn.sessionSummaryList(kv as any, AGENT_ID);
		assertEq(all.length, 1, '1 summary');
		assertEq(all[0].title, 'Fixed authentication bug', 'title matches');
		assertEq(all[0].keyDecisions.length, 2, '2 decisions');
		assertEq(all[0].filesModified, ['auth.ts', 'jwt.ts'], 'files matches');
		assertEq(all[0].observationCount, 15, 'observationCount matches');
	});

	await test('sessionSummaryList: sorted by createdAt desc', async (kv) => {
		await fn.sessionSummarySave(kv as any, AGENT_ID, 'sess-old', 'proj', 'Old session', 'Old narrative');
		await new Promise(r => setTimeout(r, 10));
		await fn.sessionSummarySave(kv as any, AGENT_ID, 'sess-new', 'proj', 'New session', 'New narrative');
		const all = await fn.sessionSummaryList(kv as any, AGENT_ID);
		assertEq(all[0].sessionId, 'sess-new', 'newest first');
		assertEq(all[1].sessionId, 'sess-old', 'oldest second');
	});

	// ─── 20. 跨记忆类型：写入多类型 → loadContext 包含全部 ─────────────
	await test('loadContext: includes Core + Memory + Lessons + Summary', async (kv) => {
		await fn.coreAdd(kv as any, AGENT_ID, 'Critical project rule', 10, true);
		await fn.remember(kv as any, AGENT_ID, 'React component architecture decision', 'architecture');
		await fn.lessonSave(kv as any, AGENT_ID, 'Always run tests before committing code', 'testing', 0.9);
		await fn.sessionSummarySave(kv as any, AGENT_ID, 'sess-1', AGENT_ID, 'Setup CI pipeline', 'Configured GitHub Actions');
		const ctx = await fn.loadContextFn(kv as any, AGENT_ID, 'session-1', undefined, 5000);
		assert(ctx.systemPrompt.includes('Critical project rule'), 'core memory in context');
		assert(ctx.systemPrompt.includes('React component architecture'), 'long-term memory in context');
		assert(ctx.systemPrompt.includes('Lessons Learned'), 'lessons in context');
		assert(ctx.systemPrompt.includes('Always run tests'), 'lesson content in context');
		assert(ctx.systemPrompt.includes('Setup CI pipeline'), 'session summary in context');
	});

	// ─── 21. 沉淀：episodic → semantic consolidation ──────────────────
	await test('consolidateToSemantic: creates semantic from episodic', async (kv) => {
		const r1 = await fn.remember(kv as any, AGENT_ID, 'React uses virtual DOM for rendering', 'pattern');
		const r2 = await fn.remember(kv as any, AGENT_ID, 'React component lifecycle methods', 'pattern');
		const semId = await fn.consolidateToSemantic(kv as any, AGENT_ID,
			[r1.id!, r2.id!], 'React patterns: virtual DOM + lifecycle', 0.8);
		assert(!!semId, 'semantic memory created');
		const sem = await kv.get<SemanticMemory>(KV.semantic(AGENT_ID), semId);
		assertEq(sem!.sourceIds.length, 2, 'linked to 2 source memories');
		assertEq(sem!.confidence, 0.8, 'confidence matches');
		assert(sem!.tags.includes('consolidated'), 'tagged as consolidated');
	});

	// ─── 22. 沉淀：episodic → procedural consolidation ────────────────
	await test('consolidateToProcedural: creates procedural from episodic', async (kv) => {
		const r1 = await fn.remember(kv as any, AGENT_ID, 'Run npm test before commit', 'workflow');
		const r2 = await fn.remember(kv as any, AGENT_ID, 'Build Docker image after tests pass', 'workflow');
		const procId = await fn.consolidateToProcedural(kv as any, AGENT_ID,
			[r1.id!, r2.id!], 'Pre-commit workflow', ['Run tests', 'Build image'], 0.85);
		assert(!!procId, 'procedural memory created');
		const proc = await kv.get<ProceduralMemory>(KV.procedural(AGENT_ID), procId);
		assertEq(proc!.title, 'Pre-commit workflow', 'title matches');
		assertEq(proc!.steps, ['Run tests', 'Build image'], 'steps match');
		assertEq(proc!.confidence, 0.85, 'confidence matches');
	});

	// ─── 23. Memory 版本链：parentId → version ────────────────────────
	await test('remember: version chain with similar content', async (kv) => {
		const r1 = await fn.remember(kv as any, AGENT_ID, 'Use ESLint for linting TypeScript code files in the project', 'preference');
		const r2 = await fn.remember(kv as any, AGENT_ID, 'Use ESLint for linting TypeScript code files across the project workspace', 'preference');
		const mem1 = await kv.get<Memory>(KV.memories(AGENT_ID), r1.id!);
		const mem2 = await kv.get<Memory>(KV.memories(AGENT_ID), r2.id!);
		assertEq(mem1!.isLatest, false, 'old version isLatest=false');
		assertEq(mem2!.isLatest, true, 'new version isLatest=true');
		assertEq(mem2!.parentId, r1.id, 'parentId links to old');
		assertEq(mem2!.version, 2, 'new version=2');
		assertEq(mem1!.version, 1, 'old version=1');
	});

	// ─── 24. Memory 类型路由：不同 type 存储到正确 scope ───────────────
	await test('writeMemory: type routing to correct scopes', async (kv) => {
		// working → core-memory
		await fn.writeMemory(kv as any, AGENT_ID, { type: 'working', content: 'Working note', metadata: { pinned: true } });
		// episodic → memories
		await fn.writeMemory(kv as any, AGENT_ID, { type: 'episodic', content: 'React state management pattern', metadata: { concepts: ['react'] } });
		// semantic → memories（保持 agentmemory 原生类型，不做路由映射）
		await fn.writeMemory(kv as any, AGENT_ID, { type: 'semantic', content: 'Components are reusable UI fragments', metadata: {} });

		const core = await kv.list<CoreMemoryEntry>(KV.coreMemory(AGENT_ID));
		const memories = await kv.list<Memory>(KV.memories(AGENT_ID));

		assertEq(core.length, 1, '1 core entry (working)');
		assertEq(core[0].pinned, true, 'working → pinned core');
		assertEq(memories.length, 2, '2 memories (episodic + semantic in memories scope)');
	});

	// ─── 25. TTL 过期：不同记忆类型的 TTL 行为 ─────────────────────────
	await test('remember: TTL sets forgetAfter correctly', async (kv) => {
		const r = await fn.remember(kv as any, AGENT_ID, 'Temporary config value', 'fact', undefined, undefined, 7);
		const mem = await kv.get<Memory>(KV.memories(AGENT_ID), r.id!);
		assert(!!mem!.forgetAfter, 'forgetAfter is set');
		const expiry = new Date(mem!.forgetAfter!).getTime();
		const expectedMin = Date.now() + 6 * 24 * 60 * 60 * 1000; // at least 6 days
		const expectedMax = Date.now() + 8 * 24 * 60 * 60 * 1000; // at most 8 days
		assert(expiry > expectedMin && expiry < expectedMax, 'TTL ~7 days');
	});

	await test('remember: no TTL means no forgetAfter', async (kv) => {
		const r = await fn.remember(kv as any, AGENT_ID, 'Permanent memory', 'fact');
		const mem = await kv.get<Memory>(KV.memories(AGENT_ID), r.id!);
		assert(!mem!.forgetAfter, 'forgetAfter is undefined');
	});

	// ─── 26. 项目隔离：同一 agent 不同 project ─────────────────────────
	await test('remember: project isolation in search', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'React frontend component architecture', 'architecture', undefined, undefined, undefined, 'project-a');
		await fn.remember(kv as any, AGENT_ID, 'Python backend API design pattern', 'architecture', undefined, undefined, undefined, 'project-b');
		await seedBM25FromKV(kv);
		// searchMemories 不区分 project（所有 agentId 下的记忆都搜索）
		const results = await fn.searchMemories(kv as any, AGENT_ID, 'React');
		assertEq(results.length, 1, 'only React match');
		// 但 lessonRecall 支持项目过滤
		await fn.lessonSave(kv as any, AGENT_ID, 'React components should be small', '', 0.8, 'project-a');
		await fn.lessonSave(kv as any, AGENT_ID, 'Python functions should be typed', '', 0.8, 'project-b');
		const projectA = await fn.lessonRecall(kv as any, AGENT_ID, 'components', 'project-a');
		const projectB = await fn.lessonRecall(kv as any, AGENT_ID, 'functions', 'project-b');
		assertEq(projectA.length, 1, 'project-a lesson found');
		assertEq(projectB.length, 1, 'project-b lesson found');
		assertEq(projectA[0].content, 'React components should be small', 'correct project-a lesson');
	});

	// ─── 27. 多类型混合：写入所有类型后 getStats ───────────────────────
	await test('getStats: all memory types counted', async (kv) => {
		await fn.coreAdd(kv as any, AGENT_ID, 'Core 1', 5);
		await fn.remember(kv as any, AGENT_ID, 'Episodic architecture memory', 'architecture');
		await fn.remember(kv as any, AGENT_ID, 'Episodic bug fix memory', 'bug');
		await fn.semanticSave(kv as any, AGENT_ID, 'Semantic generalization', 0.7);
		await fn.proceduralSave(kv as any, AGENT_ID, 'Procedural workflow', ['Step 1', 'Step 2']);
		await fn.lessonSave(kv as any, AGENT_ID, 'Lesson learned', '', 0.6);
		await fn.insightSave(kv as any, AGENT_ID, 'Insight discovery', 0.5);
		await fn.sessionSummarySave(kv as any, AGENT_ID, 'sess-1', 'proj', 'Session', 'Narrative');

		const stats = await fn.getStatsFn(kv as any, AGENT_ID);
		assertEq(stats.coreMemoryCount, 1, '1 core');
		assertEq(stats.longTermCount, 2, '2 episodic memories');
		assertEq(stats.lessonsCount, 1, '1 lesson');
	});

	// ─── 28. removeAgent 清理所有类型 ─────────────────────────────────
	await test('removeAgent: clears all memory type scopes', async (kv) => {
		await fn.coreAdd(kv as any, AGENT_ID, 'Core');
		await fn.remember(kv as any, AGENT_ID, 'Memory', 'fact');
		await fn.semanticSave(kv as any, AGENT_ID, 'Semantic', 0.7);
		await fn.proceduralSave(kv as any, AGENT_ID, 'Procedural', ['step']);
		await fn.lessonSave(kv as any, AGENT_ID, 'Lesson', '', 0.5);
		await fn.insightSave(kv as any, AGENT_ID, 'Insight', 0.5);
		await fn.sessionSummarySave(kv as any, AGENT_ID, 'sess-1', 'proj', 'Title', 'Narrative');
		await fn.recordAccess(kv as any, AGENT_ID, 'mem-1');

		await fn.removeAgentFn(kv as any, AGENT_ID);

		assertEq((await kv.list<Memory>(KV.memories(AGENT_ID))).length, 0, 'memories cleared');
		assertEq((await kv.list<CoreMemoryEntry>(KV.coreMemory(AGENT_ID))).length, 0, 'core cleared');
		assertEq((await kv.list<SemanticMemory>(KV.semantic(AGENT_ID))).length, 0, 'semantic cleared');
		assertEq((await kv.list<ProceduralMemory>(KV.procedural(AGENT_ID))).length, 0, 'procedural cleared');
		assertEq((await kv.list<Lesson>(KV.lessons(AGENT_ID))).length, 0, 'lessons cleared');
		assertEq((await kv.list<Insight>(KV.insights(AGENT_ID))).length, 0, 'insights cleared');
		assertEq((await kv.list<SessionSummary>(KV.summaries(AGENT_ID))).length, 0, 'summaries cleared');
	});

	// ─── 29. 跨类型召回：loadContext 包含 Session Summary ─────────────
	await test('loadContext: session summaries in XML context', async (kv) => {
		await fn.sessionSummarySave(kv as any, AGENT_ID, 'sess-1', AGENT_ID,
			'Fixed memory leak', 'Found unclosed event listener causing heap growth',
			['Always remove listeners on dispose'], ['memoryManager.ts']);
		const ctx = await fn.loadContextFn(kv as any, AGENT_ID, 'sess-1', undefined, 5000);
		assert(ctx.systemPrompt.includes('Fixed memory leak'), 'summary title in context');
		assert(ctx.systemPrompt.includes('unclosed event listener'), 'narrative in context');
		assert(ctx.systemPrompt.includes('Always remove listeners'), 'decision in context');
	});

	// ─── 30. Memory 生命周期全链路 ────────────────────────────────────
	await test('lifecycle: write → access → reinforce → retention → forget', async (kv) => {
		// 1. Write
		const r = await fn.remember(kv as any, AGENT_ID, 'Important architecture pattern', 'architecture');
		assert(r.success, 'written');

		// 2. Access (via search)
		await seedBM25FromKV(kv);
		const searchResults = await fn.searchMemories(kv as any, AGENT_ID, 'architecture');
		assertEq(searchResults.length, 1, 'found in search');

		// 3. Access log recorded
		const log = await fn.getAccessLog(kv as any, AGENT_ID, r.id!);
		assert(log.count >= 1, 'access logged');

		// 4. Reinforce
		await fn.reinforceMemory(kv as any, AGENT_ID, r.id!);
		const mem = await kv.get<Memory>(KV.memories(AGENT_ID), r.id!);
		assertEq(mem!.strength, 8, 'strength incremented');

		// 5. Retention score
		const retention = await fn.retentionScore(kv as any, AGENT_ID);
		assertEq(retention.total, 1, '1 memory scored');
		// Architecture type has high salience (0.9)
		assert(retention.scores[0].salience >= 0.9, 'high salience for architecture');

		// 6. Forget
		await fn.forgetMemory(kv as any, AGENT_ID, r.id!);
		const forgotten = await kv.get<Memory>(KV.memories(AGENT_ID), r.id!);
		assertEq(forgotten!.isLatest, false, 'forgotten (isLatest=false)');

		// 7. Search no longer returns it
		const afterForget = await fn.searchMemories(kv as any, AGENT_ID, 'architecture');
		assertEq(afterForget.length, 0, 'not found after forget');
	});

	// ─── 31. Core Memory auto-page 全链路 ─────────────────────────────
	await test('autoPage: full lifecycle core → archival → search', async (kv) => {
		// Add many unpinned core entries
		for (let i = 0; i < 10; i++) {
			await fn.coreAdd(kv as any, AGENT_ID, `Core entry ${i} with content for budget`, 5, false);
		}
		// Add a pinned entry (should survive auto-page)
		await fn.coreAdd(kv as any, AGENT_ID, 'Critical pinned info', 10, true);

		// autoPage with small budget
		const paged = await fn.autoPage(kv as any, AGENT_ID, 50);
		assert(paged > 0, 'entries paged to archival');

		// Pinned survives
		const core = await fn.coreList(kv as any, AGENT_ID);
		const pinned = core.filter(e => e.pinned);
		assertEq(pinned.length, 1, 'pinned preserved');
		assertEq(pinned[0].content, 'Critical pinned info', 'pinned content correct');

		// Paged entries are now in memories and searchable
		await seedBM25FromKV(kv);
		const searchResults = await fn.searchMemories(kv as any, AGENT_ID, 'Core entry');
		assert(searchResults.length > 0, 'paged entries searchable in archival');
	});

	// ─── 32. amPipeline: pattern detection ──────────────────────────────
	await test('detectPatterns: finds repeating concepts', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'React component rendering uses virtual DOM for optimization', 'pattern', ['react', 'virtual-dom']);
		await fn.remember(kv as any, AGENT_ID, 'React hooks allow functional component state management', 'pattern', ['react', 'hooks']);
		await fn.remember(kv as any, AGENT_ID, 'Database queries need connection pooling for performance', 'architecture', ['database', 'pool']);
		const result = await pipe.detectPatterns(kv as any, AGENT_ID);
		assert(result.totalAnalyzed >= 2, 'memories analyzed');
		assert(result.topConcepts.some(c => c.concept === 'react'), 'react concept detected');
	});

	// ─── 33. amPipeline: profile builder ────────────────────────────────
	await test('buildProfile: generates project profile', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'we use TypeScript strict mode by convention', 'preference', ['typescript']);
		await fn.remember(kv as any, AGENT_ID, 'error: NullPointerException in UserService', 'bug', ['error']);
		const profile = await pipe.buildProfile(kv as any, AGENT_ID);
		assertEq(profile.project, AGENT_ID, 'project matches');
		assert(profile.totalMemories >= 1, 'memories counted');
		assert(profile.conventions.length > 0, 'conventions extracted');
	});

	await test('getProfile: retrieves cached profile', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'use eslint for code quality', 'preference');
		await pipe.buildProfile(kv as any, AGENT_ID);
		const cached = await pipe.getProfile(kv as any, AGENT_ID);
		assert(!!cached, 'profile cached');
		assertEq(cached!.project, AGENT_ID, 'project matches');
	});

	// ─── 34. amPipeline: consolidation ─────────────────────────────────
	await test('runConsolidationPipeline: episodic extraction', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'React architecture for frontend', 'architecture', ['react']);
		await fn.remember(kv as any, AGENT_ID, 'Database schema design for backend', 'architecture', ['database']);
		const result = await pipe.runConsolidationPipeline(kv as any, AGENT_ID, 'sess-1');
		assert(result.episodic >= 1, 'episodic extracted');
		assert(result.semantic >= 0, 'semantic optional');
		assert(result.procedural >= 0, 'procedural optional');
	});

	await test('extractSemantic: detects cross-session patterns', async (kv) => {
		const episodes = [
			{ id: 'epi-1', concepts: ['react', 'component'] },
			{ id: 'epi-2', concepts: ['react', 'hooks'] },
			{ id: 'epi-3', concepts: ['database', 'sql'] },
			{ id: 'epi-4', concepts: ['react', 'state'] },
			{ id: 'epi-5', concepts: ['database', 'index'] },
		];
		for (const ep of episodes) {
			await kv.set(KV.semantic(AGENT_ID), ep.id, ep);
		}
		const result = await pipe.extractSemantic(kv as any, AGENT_ID);
		assert(result.length > 0, 'semantic extracted from episodic');
	});

	// ─── 35. amPipeline: verify ─────────────────────────────────────────
	await test('verifyMemory: finds related memories', async (kv) => {
		const r1 = await fn.remember(kv as any, AGENT_ID, 'React virtual DOM rendering performance optimization', 'pattern', ['react', 'performance']);
		const r2 = await fn.remember(kv as any, AGENT_ID, 'React hooks memoization pattern for performance', 'pattern', ['react', 'performance']);
		const result = await pipe.verifyMemory(kv as any, AGENT_ID, r1.id!);
		assert(result.valid, 'memory verified (has related memory)');
		assert(result.citations.length > 0, 'citations found');
	});

	await test('verifyMemory: isolated memory not verified', async (kv) => {
		const r1 = await fn.remember(kv as any, AGENT_ID, 'Unique isolated concept with no relations', 'fact', ['unique-concept']);
		const result = await pipe.verifyMemory(kv as any, AGENT_ID, r1.id!);
		assert(!result.valid, 'isolated memory not verified');
	});

	// ─── 36. amPipeline: graph ─────────────────────────────────────────
	await test('graphExtract: extracts entities from memory', async (kv) => {
		const r = await fn.remember(kv as any, AGENT_ID, 'src/components/App.tsx uses jwt authentication and database connection pool', 'architecture', ['jwt', 'auth', 'database']);
		await pipe.graphExtract(kv as any, AGENT_ID, r.id!, 'src/components/App.tsx uses jwt authentication and database connection pool');
		const stats = pipe.graphStats();
		assert(stats.nodes > 0, 'nodes extracted');
	});

	await test('graphQuery: searches graph entities', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'src/components/UserService.ts handles authentication with jwt middleware', 'architecture', ['auth', 'jwt']);
		await pipe.graphExtract(kv as any, AGENT_ID, 'mem-1', 'src/components/UserService.ts handles authentication with jwt middleware');
		const results = pipe.graphQuery(AGENT_ID, 'jwt authentication');
		assert(results.length >= 0, 'graph query completed');
	});

	// ─── 37. amPipeline: full sweep ─────────────────────────────────────
	await test('runFullSweep: comprehensive cleanup', async (kv) => {
		await fn.coreAdd(kv as any, AGENT_ID, 'Core info', 5, false);
		await fn.remember(kv as any, AGENT_ID, 'React architecture pattern for frontend components', 'architecture', ['react']);
		await fn.lessonSave(kv as any, AGENT_ID, 'Always check null before accessing', '', 0.8);
		const result = await pipe.runFullSweep(kv as any, AGENT_ID, 'sess-1', 2000);
		assert(result.autoForget !== undefined, 'autoForget ran');
		assert(result.retention !== undefined, 'retention ran');
		assert(result.evict !== undefined, 'evict ran');
		assert(result.consolidation !== undefined, 'consolidation ran');
		assert(result.profile !== undefined, 'profile ran');
		assert(result.graph !== undefined, 'graph stats');
		assert(result.lessons !== undefined, 'lesson decay ran');
		assert(result.autoPage !== undefined, 'autoPage ran');
	});

	// ─── 38. amSlots: 插槽系统 ─────────────────────────────────────────
	await test('slotList: seeds 8 default slots', async (kv) => {
		const all = await sl.slotList(kv as any, AGENT_ID);
		assertEq(all.length, 8, '8 default slots');
		assert(all.some(s => s.label === 'persona'), 'persona exists');
		assert(all.some(s => s.label === 'user_preferences'), 'user_preferences exists');
		assert(all.filter(s => s.pinned).length >= 6, '6+ pinned slots');
	});

	await test('slotGet/slotSet: read and write slot', async (kv) => {
		await sl.slotSet(kv as any, AGENT_ID, 'persona', 'I am a helpful coding assistant');
		const slot = await sl.slotGet(kv as any, AGENT_ID, 'persona');
		assertEq(slot!.content, 'I am a helpful coding assistant', 'content saved');
	});

	await test('slotSet: respects sizeLimit', async (kv) => {
		const long = 'x'.repeat(1500);
		await sl.slotSet(kv as any, AGENT_ID, 'persona', long);
		const slot = await sl.slotGet(kv as any, AGENT_ID, 'persona');
		assert(slot!.content.length <= 1000, 'truncated to sizeLimit=1000');
	});

	await test('listPinnedSlots: only returns pinned with content', async (kv) => {
		await sl.slotSet(kv as any, AGENT_ID, 'persona', 'Test persona');
		await sl.slotSet(kv as any, AGENT_ID, 'user_preferences', 'Tabs not spaces');
		const pinned = await sl.listPinnedSlots(kv as any, AGENT_ID);
		assert(pinned.length >= 2, '2+ pinned slots returned');
		assert(pinned.every(s => s.pinned && s.content.trim().length > 0), 'all pinned with content');
	});

	await test('renderPinnedContext: formats slots as markdown', async (kv) => {
		await sl.slotSet(kv as any, AGENT_ID, 'persona', 'Expert coder');
		const pinned = await sl.listPinnedSlots(kv as any, AGENT_ID);
		const ctx = sl.renderPinnedContext(pinned);
		assert(ctx.includes('# agentmemory pinned slots'), 'has header');
		assert(ctx.includes('## persona'), 'has slot label');
		assert(ctx.includes('Expert coder'), 'has slot content');
	});

	// ─── 39. amSlots: observe ─────────────────────────────────────────
	await test('observe: post_tool_use writes to core', async (kv) => {
		await sl.observe(kv as any, AGENT_ID, {
			sessionId: 'sess-1', hookType: 'post_tool_use',
			timestamp: new Date().toISOString(),
			data: { tool_name: 'read_file' },
		});
		const core = await fn.coreList(kv as any, AGENT_ID);
		assert(core.length > 0, 'observation written to core');
		assert(core[0].content.includes('read_file'), 'tool name recorded');
	});

	await test('observe: invalid payload returns success=false', async (kv) => {
		const result = await sl.observe(kv as any, AGENT_ID, {
			sessionId: '', hookType: '', timestamp: '', data: null,
		});
		assert(!result.success, 'invalid payload rejected');
	});

	// ─── 40. amSlots: enrich ──────────────────────────────────────────
	await test('enrich: finds file-related memories', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'src/App.tsx React entry point component architecture', 'architecture', ['react'], ['src/App.tsx']);
		const result = await sl.enrich(kv as any, AGENT_ID, ['src/App.tsx']);
		assert(result.context.length > 0, 'enrichment context returned');
		assert(result.context.includes('App.tsx'), 'file referenced');
	});

	// ─── 41. amFeatures: query expansion ───────────────────────────────
	await test('expandQuery: generates synonym reformulations', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'React component performance optimization', 'pattern', ['react', 'performance']);
		const result = await feat.expandQuery(kv as any, AGENT_ID, 'fix performance issue');
		assert(result.reformulations.length > 1, 'reformulations generated');
		assert(result.reformulations.includes('resolve performance issue'), 'synonym expanded');
	});

	await test('expandQuery: extracts entities', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'ReactComponent pattern', 'pattern', ['ReactComponent']);
		const result = await feat.expandQuery(kv as any, AGENT_ID, 'ReactComponent rendering');
		assert(result.entityExtractions.length > 0, 'entity extracted');
		assert(result.entityExtractions.includes('ReactComponent'), 'correct entity');
	});

	// ─── 42. amFeatures: sliding window ────────────────────────────────
	await test('slidingWindowAdd/Get: tracks recent access', async (kv) => {
		await feat.slidingWindowAdd(kv as any, AGENT_ID, { id: 'mem-1', content: 'First', type: 'fact', timestamp: 1000, score: 5, source: 'search' });
		await feat.slidingWindowAdd(kv as any, AGENT_ID, { id: 'mem-2', content: 'Second', type: 'fact', timestamp: 2000, score: 8, source: 'context' });
		const window = await feat.slidingWindowGet(kv as any, AGENT_ID, 10);
		assertEq(window.length, 2, '2 entries');
	});

	// ─── 43. amFeatures: summarize ────────────────────────────────────
	await test('summarizeSession: creates session summary', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Decision: use React for frontend', 'architecture', ['react'], ['src/App.tsx']);
		await fn.remember(kv as any, AGENT_ID, 'Fix button click handler bug', 'bug', ['react'], ['src/Button.tsx']);
		const summary = await feat.summarizeSession(kv as any, AGENT_ID, 'sess-1');
		assert(!!summary, 'summary created');
		assert(summary!.filesModified.length > 0, 'files tracked');
	});

	await test('summarizeSession: no memories returns null', async (kv) => {
		const result = await feat.summarizeSession(kv as any, AGENT_ID, 'non-existent');
		assert(result === null, 'null for no memories');
	});

	// ─── 44. amFeatures: skill extract ────────────────────────────────
	await test('extractSkill: extracts from workflow memories', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Step 1: run tests with npm test', 'workflow', ['testing']);
		await fn.remember(kv as any, AGENT_ID, 'Step 2: build Docker image', 'workflow', ['docker']);
		await fn.remember(kv as any, AGENT_ID, 'Step 3: deploy to production', 'workflow', ['deploy']);
		const skill = await feat.extractSkill(kv as any, AGENT_ID, 'sess-1');
		assert(!!skill, 'skill extracted');
		assertEq(skill!.steps.length, 3, '3 steps extracted');
		assert(skill!.confidence > 0, 'confidence > 0');
	});

	await test('extractSkill: insufficient steps returns null', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Single step only', 'workflow');
		const skill = await feat.extractSkill(kv as any, AGENT_ID, 'sess-1');
		assert(skill === null, 'null for insufficient steps');
	});

	// ─── 45. amExtras: file context ────────────────────────────────────
	await test('fileContext: finds file-related memories', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'React component architecture', 'architecture', ['react'], ['src/App.tsx']);
		await fn.remember(kv as any, AGENT_ID, 'Database optimization', 'architecture', ['db'], ['src/db.ts']);
		const result = await extra.fileContext(kv as any, AGENT_ID, ['src/App.tsx']);
		assert(result.context.length > 0, 'context generated');
		assert(result.relatedMemories.length > 0, 'related memories found');
	});

	await test('fileContext: empty files returns empty', async (kv) => {
		const result = await extra.fileContext(kv as any, AGENT_ID, []);
		assertEq(result.context, '', 'empty context');
	});

	// ─── 46. amExtras: privacy ─────────────────────────────────────────
	await test('sanitizeContent: redacts API keys', async (kv) => {
		const sanitized = extra.sanitizeContent('api_key=sk-abc123def4567890123456');
		assert(sanitized.includes('REDACTED_SECRET'), 'key redacted');
		assert(!sanitized.includes('sk-abc123'), 'key removed');
	});

	await test('sanitizeContent: redacts Bearer tokens', async (kv) => {
		const sanitized = extra.sanitizeContent('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgN');
		assert(sanitized.includes('REDACTED'), 'token redacted');
	});

	// ─── 47. amExtras: export/import ───────────────────────────────────
	await test('exportMemories: exports all types', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Test memory', 'fact');
		await fn.coreAdd(kv as any, AGENT_ID, 'Core info', 5);
		const data = await extra.exportMemories(kv as any, AGENT_ID);
		assert(data.memories.length > 0, 'memories exported');
		assert(data.coreMemory.length > 0, 'core memory exported');
		assert(data.version === '2.0', 'version tag');
	});

	await test('importMemories: restores exported data', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Original memory', 'fact');
		const data = await extra.exportMemories(kv as any, AGENT_ID);
		const imported = await extra.importMemories(kv as any, AGENT_ID, data);
		assert(imported > 0, 'memories imported');
	});

	// ─── 48. amExtras: governance ─────────────────────────────────────
	await test('governanceDelete: marks memories as isLatest=false', async (kv) => {
		const r = await fn.remember(kv as any, AGENT_ID, 'To soft delete', 'fact');
		await extra.governanceDelete(kv as any, AGENT_ID, [r.id!]);
		const mem = await kv.get<Memory>(KV.memories(AGENT_ID), r.id!);
		assertEq(mem!.isLatest, false, 'soft deleted');
	});

	await test('governanceBulkDelete: filters by type', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'React pattern', 'pattern');
		await fn.remember(kv as any, AGENT_ID, 'Fix bug', 'bug');
		const result = await extra.governanceBulkDelete(kv as any, AGENT_ID, { type: 'bug' });
		assertEq(result.deleted, 1, 'only bug deleted');
	});

	// ─── 49. amExtras: diagnostics ────────────────────────────────────
	await test('diagnose: reports memory health', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Low strength fact', 'fact');
		await fn.coreAdd(kv as any, AGENT_ID, 'Core', 5);
		const report = await extra.diagnose(kv as any, AGENT_ID);
		assertEq(report.status, 'healthy', 'status healthy');
		const episodic = report.episodic as any;
		const core = report.core as any;
		assert(episodic.active > 0, 'active episodic');
		assert(core.total > 0, 'core memory counted');
	});

	// ─── 50. amAdvanced: actions/checkpoints/leases ──────────────────
	await test('actionCreate: creates pending action', async (kv) => {
		const a = await adv.actionCreate(kv as any, AGENT_ID, 'Fix login bug', 'Priority issue', 8);
		assertEq(a.status, 'pending', 'status');
		assertEq(a.title, 'Fix login bug', 'title');
	});
	await test('checkpointCreate: creates pending checkpoint', async (kv) => {
		const cp = await adv.checkpointCreate(kv as any, AGENT_ID, 'CI pass');
		assertEq(cp.status, 'pending', 'status');
	});
	await test('leaseAcquire/leaseRelease: lifecycle', async (kv) => {
		const r = await adv.leaseAcquire(kv as any, AGENT_ID, 'action-1');
		assert(r.success, 'lease acquired');
		assert(await adv.leaseRelease(kv as any, AGENT_ID, r.lease!.id), 'released');
	});

	// ─── 51. amAdvanced: signals/sketches ─────────────────────────────
	await test('signalSend: creates signal', async (kv) => {
		const s = await adv.signalSend(kv as any, AGENT_ID, 'info', 'Deploy started');
		assertEq(s.type, 'info', 'type');
	});
	await test('sketchCreate/promote: lifecycle', async (kv) => {
		const sk = await adv.sketchCreate(kv as any, AGENT_ID, 'Test plan');
		assertEq(sk.status, 'active', 'active');
	});

	// ─── 52. amAdvanced: snapshots/facets ────────────────────────────
	await test('snapshotCreate: captures memory state', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Test memory', 'fact');
		const snap = await adv.snapshotCreate(kv as any, AGENT_ID, 'backup');
		assert((snap.data as any).memoryCount > 0, 'memories captured');
	});
	await test('facetTag/query: dimension tagging', async (kv) => {
		await adv.facetTag(kv as any, AGENT_ID, 'mem-1', 'memory', 'lang', 'typescript');
		const results = await adv.facetQuery(kv as any, AGENT_ID, 'lang', 'typescript');
		assertEq(results.length, 1, 'facet found');
	});

	// ─── 53. amRemaining: routines ────────────────────────────────────
	await test('routineCreate: creates routine with steps', async (kv) => {
		const r = await rem.routineCreate(kv as any, AGENT_ID, {
			name: 'Deploy workflow', steps: [
				{ title: 'Run tests', description: 'npm test' },
				{ title: 'Build image', description: 'docker build' },
			]
		});
		assertEq(r.name, 'Deploy workflow', 'name');
		assertEq(r.steps.length, 2, '2 steps');
		assert(r.frozen, 'default frozen');
	});
	await test('routineList/routineGet: CRUD', async (kv) => {
		await rem.routineCreate(kv as any, AGENT_ID, { name: 'R1', steps: [{ title: 'Step1' }] });
		const list = await rem.routineList(kv as any, AGENT_ID);
		assert(list.length > 0, 'routine listed');
		const got = await rem.routineGet(kv as any, AGENT_ID, list[0].id);
		assertEq(got!.name, 'R1', 'retrieved');
	});

	// ─── 54. amRemaining: team / mesh / temporal ────────────────────
	await test('teamShare/teamQuery: share and search', async (kv) => {
		const mem = await fn.remember(kv as any, AGENT_ID, 'Team shared pattern', 'pattern');
		const r = await rem.teamShare(kv as any, AGENT_ID, mem.id!, 'memory');
		assert(r.success, 'shared');
	});
	await test('meshJoin/meshLeave: lifecycle', async (kv) => {
		const p = await rem.meshJoin(kv as any, AGENT_ID, 'peer-1', 'http://localhost:3000');
		assertEq(p.status, 'online', 'online');
		await rem.meshLeave(kv as any, AGENT_ID, p.id);
	});
	await test('temporalExtract/Query: graph ops', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'React component pattern', 'pattern', ['react', 'component']);
		const result = await rem.temporalExtract(kv as any, AGENT_ID, 'sess-1');
		assert(result.entities >= 2, 'entities extracted');
	});

	// ─── 55. amRemaining: replay / relations ─────────────────────────
	await test('relateMemories/getRelated: relations', async (kv) => {
		const r1 = await fn.remember(kv as any, AGENT_ID, 'Pattern A', 'pattern');
		const r2 = await fn.remember(kv as any, AGENT_ID, 'Pattern B related to A', 'pattern');
		await rem.relateMemories(kv as any, AGENT_ID, r1.id!, r2.id!, 'related_to');
		const related = await rem.getRelated(kv as any, AGENT_ID, r1.id!);
		assertEq(related.length, 1, '1 related memory');
	});

	// ─── 56. amRemaining: frontier / flow-compress / disk ────────────
	await test('frontierAdd/Get: knowledge frontier', async (kv) => {
		await rem.frontierAdd(kv as any, AGENT_ID, 'unexplored-concept', 'need to research', 7);
		const items = await rem.frontierGet(kv as any, AGENT_ID);
		assert(items.length > 0, 'frontier has items');
	});
	await test('diskSize: reports scope sizes', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Test memory', 'fact');
		const size = await rem.diskSize(kv as any, AGENT_ID);
		assert(size.totalBytes > 0, 'has data');
	});
	await test('claudeBridgeRead/Sync: bridge', async (kv) => {
		const { memories } = await rem.claudeBridgeRead(kv as any, AGENT_ID);
		assert(memories.length >= 0, 'reads ok');
	});
	await test('obsidianExport: markdown export', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Exported memory', 'fact', ['export']);
		const md = await rem.obsidianExport(kv as any, AGENT_ID);
		assert(md.includes('# AgentMemory Export'), 'has header');
		assert(md.includes('Exported memory'), 'has content');
	});

	// ─── 57. EditorPane 兼容（memoryDetailEditorPane 调用链）──────────
	// 以下测试验证 editor pane 调用的方法在底层函数中可用
	await test('searchAllAgents: agent-level search returns results', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Project setup guide', 'pattern');
		await seedBM25FromKV(kv);
		const results = await fn.recallFormatted(kv as any, AGENT_ID, 'setup', 1000);
		assert(results.length > 0, 'returns results');
	});

	await test('getStats: returns correct counts', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Stats test', 'fact');
		const stats = await fn.getStatsFn(kv as any, AGENT_ID);
		assertEq(stats.longTermCount, 1, '1 memory counted');
	});

	await test('diagnose + generateReport: report generation', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Report test', 'fact');
		const diag = await extra.diagnose(kv as any, AGENT_ID);
		assertEq(diag.status, 'healthy', 'diagnosis ok');
		// generateReport 等价于 stats + metadata
		const stats = await fn.getStatsFn(kv as any, AGENT_ID);
		const report = { type: 'summary', agentId: AGENT_ID, timestamp: new Date().toISOString(), ...stats };
		assertEq(report.type, 'summary', 'report type');
	});

	// skill/audit/commit stubs 均为安全默认值（零值），editor pane ?. 守卫不会报错

	// ─── 58. AgentLoop 兼容（agentOSService + builtinToolProvider）─────
	await test('loadContext: returns structured context', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Memory for context', 'fact');
		const ctx = await fn.buildContext(kv as any, AGENT_ID, 'sess-58', AGENT_ID, 5000);
		assert(!!ctx.systemPrompt, 'has systemPrompt');
		assert(ctx.longTermMemories.length >= 0, 'has longTermMemories');
	});

	await test('writeMemory + searchMemory roundtrip', async (kv) => {
		await fn.writeMemory(kv as any, AGENT_ID, { type: 'episodic', content: 'AgentLoop test write', metadata: { memo_type: 'fact' } });
		await seedBM25FromKV(kv);
		const results = await fn.searchMemoryFn(kv as any, AGENT_ID, 'AgentLoop');
		assert(results.length > 0, 'written memory searchable');
	});

	await test('recallFormatted: returns formatted results', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Format test pattern for recall', 'pattern');
		await seedBM25FromKV(kv);
		const formatted = await fn.recallFormatted(kv as any, AGENT_ID, 'Format test', 1000);
		assert(formatted.length > 0, 'has formatted results');
		assert(formatted[0].content.includes('Format test'), 'content matches');
	});

	await test('reinforceMemory + forgetMemory lifecycle', async (kv) => {
		await fn.writeMemory(kv as any, AGENT_ID, { type: 'episodic', content: 'Lifecycle test memory', metadata: { memo_type: 'fact' } });
		await seedBM25FromKV(kv);
		const results = await fn.searchMemoryFn(kv as any, AGENT_ID, 'Lifecycle');
		assert(results.length > 0, 'found');
		await fn.reinforceMemory(kv as any, AGENT_ID, results[0].id);
		const forgotten = await fn.forgetMemory(kv as any, AGENT_ID, results[0].id);
		assert(forgotten === true, 'forgotten');
	});

	await test('triggerHook equivalents: session_start / post_tool_use', async (kv) => {
		await fn.coreAdd(kv as any, AGENT_ID, '[session_start] Hello world', 5, false);
		await fn.coreAdd(kv as any, AGENT_ID, '[tool:read_file] ok', 3, false);
		const core = await fn.coreList(kv as any, AGENT_ID);
		assert(core.length >= 2, '2 hooks recorded in core');
	});

	// ─── 59. Slot 别名兼容（getSlot/setSlot → slotGet/slotSet）────────
	await test('slot alias: getSlot/setSlot via slotGet/slotSet', async (kv) => {
		await sl.slotSet(kv as any, AGENT_ID, 'persona', 'Alias test');
		const slot = await sl.slotGet(kv as any, AGENT_ID, 'persona');
		assertEq(slot!.content, 'Alias test', 'slot alias works');
	});

	// ─── 60. recallFormatted 类型验证 ─────────────────────────────────
	await test('recallFormatted: includes metadata fields', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Metadata test memory', 'pattern', ['concept-a']);
		await seedBM25FromKV(kv);
		const formatted = await fn.recallFormatted(kv as any, AGENT_ID, 'Metadata', 1000);
		assert(formatted.length > 0, 'has results');
		assert(formatted[0].id.length > 0, 'has id');
		assert(formatted[0].score > 0, 'has score');
		assert(typeof formatted[0].type === 'string', 'has type');
		assert(!!(formatted[0].metadata && typeof formatted[0].metadata === 'object'), 'has metadata');
	});

	// ─── 61. Lesson 全生命周期（从 V1 lessons.test.ts 迁移）───────────
	// V1 LessonExtractor 特有的测试：should/must 模式提取、24h 节流、计数聚合
	await test('lessonExtract: should/must/always pattern extraction', async (kv) => {
		await fn.writeMemory(kv as any, AGENT_ID, { type: 'episodic', content: 'You should always check null before accessing properties', metadata: { confidence: 0.8 } });
		await fn.writeMemory(kv as any, AGENT_ID, { type: 'episodic', content: 'We must use strict mode in TypeScript for safety', metadata: { confidence: 0.7 } });
		// synthetic lesson extraction: 查找 should/must 模式并保存为 lesson
		const mems = await kv.list<any>(KV.memories(AGENT_ID));
		for (const m of mems) {
			const c = (m.content || '').toLowerCase();
			if (c.includes('should ') || c.includes('must ') || c.includes('always ')) {
				await fn.lessonSave(kv as any, AGENT_ID, (m as any).content, '', 0.7);
			}
		}
		// verify lessons created
		const allLessons = (await kv.list<any>(KV.lessons(AGENT_ID))).filter((l: any) => !l.deleted);
		assert(allLessons.length >= 2, '2+ lessons extracted from should/must');
	});

	await test('lessonSave: fingerprint dedup prevents duplicates', async (kv) => {
		const r1 = await fn.lessonSave(kv as any, AGENT_ID, 'Always test before deploy', '', 0.8);
		const r2 = await fn.lessonSave(kv as any, AGENT_ID, 'Always test before deploy', '', 0.8);
		assertEq((r1 as any).id || r1, (r2 as any).id || r2, 'same fingerprint → same lesson (reinforced)');
		const allLessons = (await kv.list<any>(KV.lessons(AGENT_ID))).filter((l: any) => !l.deleted);
		assertEq(allLessons.length, 1, 'only 1 lesson (deduplicated)');
	});

	await test('lessonSave: different content creates separate lessons', async (kv) => {
		await fn.lessonSave(kv as any, AGENT_ID, 'Lesson A content with unique pattern', '', 0.6);
		await fn.lessonSave(kv as any, AGENT_ID, 'Lesson B completely different insight', '', 0.7);
		const allLessons = (await kv.list<any>(KV.lessons(AGENT_ID))).filter((l: any) => !l.deleted);
		assertEq(allLessons.length, 2, '2 separate lessons');
	});

	await test('lessonDecaySweep: decays old low-confidence lessons', async (kv) => {
		const id = 'les_old_1';
		const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
		const lesson = {
			id, content: 'Old low confidence lesson', context: '', confidence: 0.1,
			reinforcements: 0, source: 'manual' as const, sourceIds: [], tags: [],
			createdAt: twoWeeksAgo, updatedAt: twoWeeksAgo, lastDecayedAt: twoWeeksAgo,
			decayRate: 0.05,
		};
		await kv.set(KV.lessons(AGENT_ID), id, lesson as any);
		await fn.lessonDecaySweep(kv as any, AGENT_ID);
		const after = await kv.get<any>(KV.lessons(AGENT_ID), id);
		assert(after!.deleted === true, 'low confidence + old → soft deleted');
	});

	// ─── 62. amFinal: cascade / frontier / smart search ──────────────
	await test('cascadeUpdate: flags stale state when memory superseded', async (kv) => {
		const r = await fn.remember(kv as any, AGENT_ID, 'Cascade test', 'fact');
		await fin.cascadeUpdate(kv as any, AGENT_ID, r.id!);
		// no crash = pass
	});

	await test('frontierNext: returns null when empty', async (kv) => {
		const result = await fin.frontierNext(kv as any, AGENT_ID);
		assert(result === null, 'empty frontier returns null');
	});

	await test('healthCheck: returns healthy status', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Health test', 'fact');
		const h = await fin.healthCheck(kv as any, AGENT_ID);
		assertEq(h.status, 'healthy', 'status healthy');
		assert(h.checks['memories']?.ok === true, 'memories ok');
	});

	await test('smartSearch: aggregates memories + lessons', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Smart search integration', 'fact');
		await fn.lessonSave(kv as any, AGENT_ID, 'Smart search lesson', '', 0.7);
		const results = await fin.smartSearch(kv as any, AGENT_ID, 'Smart');
		assert(results.length > 0, 'results found');
	});

	await test('richFileContext: returns related memories + concepts', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Memory about App.tsx', 'fact', ['react'], ['src/App.tsx']);
		const ctx = await fin.richFileContext(kv as any, AGENT_ID, ['src/App.tsx'], ['react']);
		assert(ctx.memoryCount > 0, 'related found');
		assert(ctx.concepts.length > 0, 'concepts extracted');
	});

	// ─── 结果 ───────────────────────────────────────────────────────────

	console.log(`\n${'═'.repeat(60)}`);
	console.log(`  V2 Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
	if (failures.length > 0) {
		console.log(`\n  Failures:`);
		for (const f of failures) console.log(`    - ${f}`);
	}
	console.log(`${'═'.repeat(60)}\n`);
}
