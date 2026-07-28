/*---------------------------------------------------------------------------------------------
 *  amReplication 测试 — 原版机制补全复刻（slots/insights/sketch/snapshot/
 *  routine/signal/team/graph）的行为验证。
 *--------------------------------------------------------------------------------------------*/

import * as repl from '../amReplication.js';
import * as adv from '../amAdvanced.js';
import * as rem from '../amRemaining.js';
import * as fn from '../amFunctions.js';
import * as pipe from '../amPipeline.js';
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

export async function runAmReplicationTests(): Promise<void> {
	passed = 0; failed = 0; failures.length = 0;
	console.log('\n🧪 amReplication (原版机制复刻) Tests\n');

	// ─── 1. Slots ────────────────────────────────────────────────────
	await test('slotCreate: 校验 label / 重复拒绝 / 容量校验', async (kv) => {
		const bad = await repl.slotCreate(kv as any, AGENT, { label: 'Bad Label!' });
		assert(!bad.success, 'invalid label rejected');
		const ok = await repl.slotCreate(kv as any, AGENT, { label: 'my_slot', sizeLimit: 50 });
		assert(ok.success && ok.slot?.sizeLimit === 50, 'created with sizeLimit');
		const dup = await repl.slotCreate(kv as any, AGENT, { label: 'my_slot' });
		assert(!dup.success && /already exists/.test(dup.error ?? ''), 'duplicate rejected');
		const tooBig = await repl.slotCreate(kv as any, AGENT, { label: 'big', sizeLimit: 5, content: '123456' });
		assert(!tooBig.success && /exceeds sizeLimit/.test(tooBig.error ?? ''), 'oversize content rejected');
	});

	await test('slotAppend: 追加换行拼接 / 超限报错 / 未找到报错', async (kv) => {
		await repl.slotCreate(kv as any, AGENT, { label: 'notes', content: 'line1', sizeLimit: 30 });
		const r1 = await repl.slotAppend(kv as any, AGENT, 'notes', 'line2');
		assert(r1.success && r1.slot?.content === 'line1\nline2', 'append joins with newline');
		const overflow = await repl.slotAppend(kv as any, AGENT, 'notes', 'x'.repeat(30));
		assert(!overflow.success && /exceed sizeLimit/.test(overflow.error ?? ''), 'overflow rejected');
		const missing = await repl.slotAppend(kv as any, AGENT, 'nope', 'x');
		assert(!missing.success && /not found/.test(missing.error ?? ''), 'missing slot rejected');
	});

	await test('slotReplace / slotDelete: 替换与删除', async (kv) => {
		await repl.slotCreate(kv as any, AGENT, { label: 'ctx', content: 'old', sizeLimit: 100 });
		const rep = await repl.slotReplace(kv as any, AGENT, 'ctx', 'new content');
		assert(rep.success && rep.slot?.content === 'new content', 'replaced');
		const del = await repl.slotDelete(kv as any, AGENT, 'ctx');
		assert(del.success, 'deleted');
		assert((await kv.get(KV.slots(AGENT), 'ctx')) === null, 'slot gone from KV');
	});

	// ─── 2. Insights ─────────────────────────────────────────────────
	await test('insightSearch: 关键词命中并按相关度排序', async (kv) => {
		const mk = (id: string, content: string, confidence: number, tags: string[] = []) => ({
			id, content, confidence, tags, createdAt: new Date().toISOString(), sourceMemoryIds: [],
		});
		await kv.set(KV.insights(AGENT), 'i1', mk('i1', 'prefers pnpm over npm for monorepos', 0.9, ['pkg']));
		await kv.set(KV.insights(AGENT), 'i2', mk('i2', 'uses strict TypeScript config', 0.8, ['ts']));
		const r = await repl.insightSearch(kv as any, AGENT, 'pnpm monorepo');
		assert(r.length === 1 && r[0].id === 'i1', 'only matching insight returned');
		const all = await repl.insightSearch(kv as any, AGENT, '');
		assert(all.length === 2 && all[0].confidence >= all[1].confidence, 'empty query returns all by confidence');
	});

	await test('insightDecaySweep: 置信度衰减并清除低值', async (kv) => {
		const mk = (id: string, confidence: number) => ({ id, content: id, confidence, tags: [], createdAt: '', sourceMemoryIds: [] });
		await kv.set(KV.insights(AGENT), 'keep', mk('keep', 0.9));
		await kv.set(KV.insights(AGENT), 'drop', mk('drop', 0.05));
		const r = await repl.insightDecaySweep(kv as any, AGENT);
		assert(r.pruned === 1, `pruned=1 (got ${r.pruned})`);
		const kept = await kv.get<any>(KV.insights(AGENT), 'keep');
		assert(kept && kept.confidence < 0.9 && kept.confidence > 0.1, 'kept but decayed');
	});

	// ─── 3. Sketch ───────────────────────────────────────────────────
	await test('sketchAdd: 追加 action 去重；sketchGc: 过期标记 discarded', async (kv) => {
		const sk = await adv.sketchCreate(kv as any, AGENT, 'plan A');
		const r1 = await repl.sketchAdd(kv as any, AGENT, sk.id, 'act-1');
		const r2 = await repl.sketchAdd(kv as any, AGENT, sk.id, 'act-1');
		assert(r1.success && r2.success, 'add succeeds');
		assert(r2.sketch?.actionIds.length === 1, 'duplicate action deduped');
		const missing = await repl.sketchAdd(kv as any, AGENT, 'nope', 'act');
		assert(!missing.success, 'missing sketch rejected');
		// GC
		const expired = await adv.sketchCreate(kv as any, AGENT, 'old plan');
		expired.expiresAt = new Date(Date.now() - 1000).toISOString();
		await kv.set(KV.sketches(AGENT), expired.id, expired);
		const gc = await repl.sketchGc(kv as any, AGENT);
		assert(gc.discarded === 1, `discarded=1 (got ${gc.discarded})`);
	});

	// ─── 4. Snapshot 全量往返 ────────────────────────────────────────
	await test('snapshotCreate(全量) + snapshotRestore: 删除后可恢复', async (kv) => {
		await fn.remember(kv as any, AGENT, 'important convention: use pnpm', 'fact');
		await fn.remember(kv as any, AGENT, 'user prefers dark theme', 'preference');
		const snap = await adv.snapshotCreate(kv as any, AGENT, 'backup');
		const before = (await kv.list<any>(KV.memories(AGENT))).length;
		assert(before >= 2, `2+ memories (got ${before})`);
		// 模拟灾难：清空记忆
		await kv.clearScope(KV.memories(AGENT));
		assert((await kv.list(KV.memories(AGENT))).length === 0, 'wiped');
		const r = await repl.snapshotRestore(kv as any, AGENT, snap.id);
		assert(r.success && (r.restored ?? 0) >= 2, `restored >= 2 (got ${r.restored})`);
		const after = await kv.list<any>(KV.memories(AGENT));
		assert(after.some((m: any) => m.content.includes('pnpm')), 'content restored');
	});

	await test('snapshotRestore: 旧格式快照返回 unsupported', async (kv) => {
		await kv.set(KV.snapshots(AGENT), 'legacy', { id: 'legacy', name: 'old', createdAt: '', data: { memoryCount: 1, memoryIds: ['m1'] } });
		const r = await repl.snapshotRestore(kv as any, AGENT, 'legacy');
		assert(!r.success && /legacy format/.test(r.error ?? ''), 'legacy rejected');
	});

	// ─── 5. Routine ──────────────────────────────────────────────────
	await test('routineStatus: 进度折算 + 完成自动标记', async (kv) => {
		const routine = await rem.routineCreate(kv as any, AGENT, {
			name: 'deploy', steps: [{ title: 's1' }, { title: 's2' }],
		});
		const run = await rem.routineRun(kv as any, AGENT, routine.id);
		const r1 = await repl.routineStatus(kv as any, AGENT, run.id);
		assert(r1.success && r1.progress?.total === 2 && r1.progress.done === 0, 'initial progress');
		// 推进 currentStep
		run.currentStep = 2;
		await kv.set(KV.procedural(AGENT), run.id, run);
		const r2 = await repl.routineStatus(kv as any, AGENT, run.id);
		assert(r2.run?.status === 'completed', 'auto-completed when all steps done');
		assert(!!r2.run?.completedAt, 'completedAt set');
	});

	await test('routineFreeze: 冻结与解冻', async (kv) => {
		const routine = await rem.routineCreate(kv as any, AGENT, { name: 'r', steps: [{ title: 's' }] });
		const f = await repl.routineFreeze(kv as any, AGENT, routine.id, true);
		assert(f.success && f.routine?.frozen === true, 'frozen');
		const u = await repl.routineFreeze(kv as any, AGENT, routine.id, false);
		assert(u.routine?.frozen === false, 'unfrozen');
	});

	await test('routineStepUpdate: 推进步骤并末步自动完成', async (kv) => {
		const routine = await rem.routineCreate(kv as any, AGENT, {
			name: 'flow', steps: [{ title: 's1' }, { title: 's2' }, { title: 's3' }],
		});
		const run = await rem.routineRun(kv as any, AGENT, routine.id);
		const mid = await rem.routineStepUpdate(kv as any, AGENT, run.id, 1, 'done', 'ok');
		assert(mid !== null && mid.currentStep === 2 && mid.status === 'running', 'mid step advances currentStep');
		const done = await rem.routineStepUpdate(kv as any, AGENT, run.id, 2, 'done', 'final');
		assert(done !== null && done.status === 'completed' && !!done.completedAt, 'last step auto-completes run');
		assert(done !== null && done.runLog.length >= 2, 'runLog records step entries');
	});

	await test('routineStepUpdate: 失败标记 + 未找到返回 null', async (kv) => {
		const routine = await rem.routineCreate(kv as any, AGENT, { name: 'flow2', steps: [{ title: 's1' }, { title: 's2' }] });
		const run = await rem.routineRun(kv as any, AGENT, routine.id);
		const failed = await rem.routineStepUpdate(kv as any, AGENT, run.id, 0, 'failed', undefined, 'boom');
		assert(failed?.status === 'failed', 'failed step marks run failed');
		const missing = await rem.routineStepUpdate(kv as any, AGENT, 'run_missing', 0, 'done');
		assert(missing === null, 'unknown runId returns null');
	});

	await test('routineDelete: 删除 routine 及其 run', async (kv) => {
		const routine = await rem.routineCreate(kv as any, AGENT, { name: 'todel', steps: [{ title: 's' }] });
		const run = await rem.routineRun(kv as any, AGENT, routine.id);
		const ok = await rem.routineDelete(kv as any, AGENT, routine.id);
		assert(ok === true, 'delete returns true');
		assert((await rem.routineGet(kv as any, AGENT, routine.id)) === null, 'routine removed');
		const runGone = await kv.get(KV.procedural(AGENT), run.id);
		assert(runGone === null, 'run removed');
		const again = await rem.routineDelete(kv as any, AGENT, routine.id);
		assert(again === false, 'double delete returns false');
	});

	// ─── 6. Signal ───────────────────────────────────────────────────
	await test('signalThreads: 按 threadId 聚合并排序', async (kv) => {
		const now = new Date().toISOString();
		await kv.set(KV.signals(AGENT), 's1', { id: 's1', from: 'a', to: 'b', type: 'info', content: 'm1', createdAt: '2026-07-25T01:00:00Z', threadId: 't1' });
		await kv.set(KV.signals(AGENT), 's2', { id: 's2', from: 'b', to: 'a', type: 'response', content: 'm2', createdAt: '2026-07-25T02:00:00Z', threadId: 't1' });
		await kv.set(KV.signals(AGENT), 's3', { id: 's3', from: 'c', type: 'info', content: 'm3', createdAt: '2026-07-25T03:00:00Z' });
		const r = await repl.signalThreads(kv as any, AGENT);
		assert(r.threads.length === 2, `2 threads (got ${r.threads.length})`);
		const t1 = r.threads.find(t => t.threadId === 't1')!;
		assert(t1.messages === 2 && t1.participants.length === 2, 't1 aggregated');
		assert(r.threads[0].threadId === 's3', 'sorted by lastMessage desc');
		void now;
	});

	await test('signalCleanup: 删除过期信号', async (kv) => {
		await kv.set(KV.signals(AGENT), 'exp', { id: 'exp', from: 'a', type: 'info', content: 'x', createdAt: '', expiresAt: new Date(Date.now() - 1000).toISOString() });
		await kv.set(KV.signals(AGENT), 'live', { id: 'live', from: 'a', type: 'info', content: 'y', createdAt: '' });
		const r = await repl.signalCleanup(kv as any, AGENT);
		assert(r.removed === 1, `removed=1 (got ${r.removed})`);
		assert((await kv.get(KV.signals(AGENT), 'live')) !== null, 'live signal kept');
	});

	// ─── 7. Team ─────────────────────────────────────────────────────
	await test('teamFeed: 倒序 + 上限；teamProfile: 成员/概念聚合', async (kv) => {
		const m1 = await fn.remember(kv as any, AGENT, 'uses jwt for auth', 'pattern');
		const m2 = await fn.remember(kv as any, AGENT, 'db pool size 10', 'architecture');
		await rem.teamShare(kv as any, AGENT, m1.id!, 'pattern');
		await new Promise(r => setTimeout(r, 5));
		await rem.teamShare(kv as any, AGENT, m2.id!, 'memory');
		const feed = await repl.teamFeed(kv as any, AGENT, 10);
		assert(feed.total === 2 && feed.items.length === 2, 'feed has both');
		assert(feed.items[0].sharedAt >= feed.items[1].sharedAt, 'sorted desc');
		const profile = await repl.teamProfile(kv as any, AGENT);
		assert(profile.members.includes(AGENT), 'member listed');
		assert(profile.totalSharedItems === 2, 'total counted');
	});

	await test('migrateLegacyTeamShared: 搬迁遗留条目到全局 scope（幂等）', async (kv) => {
		// D1 修复前的错误存储形态：TeamSharedItem 误存 summaries scope
		await kv.set(KV.summaries(AGENT), 'ts_legacy_1', {
			id: 'ts_legacy_1', sharedBy: AGENT, type: 'pattern',
			content: { content: 'legacy shared' }, project: 'proj-mig',
			sharedAt: new Date().toISOString(),
		});
		// 正常摘要不受影响
		await kv.set(KV.summaries(AGENT), 'sess-1', {
			id: 'sess-1', sessionId: 'sess-1', title: 't', narrative: 'n',
			keyDecisions: [], filesModified: [], concepts: [], observationCount: 1,
			createdAt: new Date().toISOString(),
		});
		const r1 = await repl.migrateLegacyTeamShared(kv as any, AGENT);
		assert(r1.migrated === 1, `migrated=1 (got ${r1.migrated})`);
		const teamItems = await kv.list<any>(KV.teamShared('proj-mig'));
		assert(teamItems.length === 1 && teamItems[0].id === 'ts_legacy_1', 'item now in global team scope');
		const summaries = await kv.list<any>(KV.summaries(AGENT));
		assert(summaries.length === 1 && summaries[0].id === 'sess-1', 'summaries cleaned, real summary untouched');
		const r2 = await repl.migrateLegacyTeamShared(kv as any, AGENT);
		assert(r2.migrated === 0 && r2.skipped === true, 'second run idempotent (config flag)');
	});

	await test('purgeLegacyL1L3Extractions: 硬删除 L1-L3 历史产物（幂等）', async (kv) => {
		// §17：客户端 L1-L3 管线移除后的存量清洗——id 前缀 l1-extract-/l2-scene-/l3-persona-
		const legacy = [
			['l1-extract-1750000000000-0', 'episodic'],
			['l1-extract-1750000000000-1', 'episodic'],
			['l2-scene-1750000000001-0', 'semantic'],
			['l3-persona-1750000000002', 'procedural'],
		] as const;
		for (const [id, type] of legacy) {
			await kv.set(KV.memories(AGENT), id, {
				id, createdAt: '', updatedAt: '', type, title: 't', content: 'legacy',
				concepts: [], files: [], sessionIds: [], strength: 5, version: 1, isLatest: true,
			});
			await kv.set(KV.accessLog(AGENT), id, { memoryId: id, count: 1, lastAt: '', recent: [] });
		}
		// 正常记忆不受影响
		await fn.remember(kv as any, AGENT, 'user prefers TypeScript strict mode', 'preference');

		const r1 = await repl.purgeLegacyL1L3Extractions(kv as any, AGENT);
		assert(r1.purged === 4, `purged=4 (got ${r1.purged})`);
		const remaining = await kv.list<any>(KV.memories(AGENT));
		assert(remaining.length === 1, `only normal memory remains (got ${remaining.length})`);
		assert(!remaining.some((m: any) => m.id.startsWith('l1-extract-')), 'no l1-extract left');
		assert(!remaining.some((m: any) => m.id.startsWith('l2-scene-')), 'no l2-scene left');
		assert(!remaining.some((m: any) => m.id.startsWith('l3-persona-')), 'no l3-persona left');
		const accessLeft = await kv.list<any>(KV.accessLog(AGENT));
		assert(accessLeft.length === 0, `access logs cleaned (got ${accessLeft.length})`);
		const r2 = await repl.purgeLegacyL1L3Extractions(kv as any, AGENT);
		assert(r2.purged === 0 && r2.skipped === true, 'second run idempotent (config flag)');
	});

	// ─── 8. Graph ────────────────────────────────────────────────────
	await test('graphBuild: 批量抽取；graphReset: 清空后可重建', async (kv) => {
		pipe.resetGraph();
		await fn.remember(kv as any, AGENT, 'src/auth.ts uses jwt middleware for authentication', 'architecture');
		const built = await repl.graphBuild(kv as any, AGENT);
		assert(built.processed >= 1, `processed >= 1 (got ${built.processed})`);
		assert(built.nodes > 0, `nodes > 0 (got ${built.nodes})`);
		repl.graphReset();
		const stats = pipe.graphStats();
		assert(stats.nodes === 0 && stats.edges === 0, 'graph cleared after reset');
	});

	console.log(`\n  amReplication: ${passed} passed, ${failed} failed\n`);
	if (failed > 0) {
		console.log('  Failures:');
		for (const f of failures) console.log(`    - ${f}`);
		throw new Error(`${failed} amReplication test(s) failed`);
	}
}
