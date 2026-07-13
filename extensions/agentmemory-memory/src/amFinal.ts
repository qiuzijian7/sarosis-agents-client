/* eslint-disable */
// ─── amFinal.ts ────────────────────────────────────────────────────────────
// 最终差异补齐：agentmemory 尚缺的 cascade / frontier / governance-audit /
// relation-evolve / temporal-edge / crystal / facet扩展 / lease管理 /
// checkpoint-expire / sketch-discard / disk-manage / smart-search / health
// ────────────────────────────────────────────────────────────────────────────

import type { StateKV } from './stateKV.js';
import { KV, generateId } from './amSchema.js';
import type { Memory, Lesson } from './amTypes.js';

// ─── 1. Cascade Update（agentmemory cascade.ts）────────────────────────────

export async function cascadeUpdate(kv: StateKV, agentId: string,
	supersededMemoryId: string
): Promise<{ success: boolean; flagged: number }> {
	const superseded = await kv.get<Memory>(KV.memories(agentId), supersededMemoryId);
	if (!superseded) return { success: false, flagged: 0 };
	// 标记所有引用该记忆的 state entries 为 stale
	let flagged = 0;
	const stateEntries = await kv.list<any>(KV.state(agentId));
	for (const e of stateEntries) {
		if (e.stale) continue;
		const refs = e.sourceMemoryIds ?? e.observationIds ?? e.sourceIds ?? [];
		if (refs.includes(supersededMemoryId)) {
			e.stale = true;
			e.updatedAt = new Date().toISOString();
			await kv.set(KV.state(agentId), e.id || String(Math.random()), e);
			flagged++;
		}
	}
	return { success: true, flagged };
}

// ─── 2. Frontier（agentmemory frontier.ts，简化版）─────────────────────────

export async function frontierNext(kv: StateKV, agentId: string,
	project?: string, agentIdentity?: string, includeLeasedByOthers?: boolean
): Promise<{ action: any; score: number; blockers: string[] } | null> {
	const items = await kv.list<any>(KV.state(agentId));
	const frontier = items.filter((f: any) => f.id?.startsWith('frontier'));
	if (frontier.length === 0) return null;
	const best = frontier.sort((a: any, b: any) => (b.priority || 0) - (a.priority || 0))[0];
	return { action: best, score: best.priority || 0, blockers: [] };
}

// ─── 3. Governance Audit Query（agentmemory governance.ts）─────────────────

export async function governanceAuditQuery(kv: StateKV, agentId: string,
	filter?: { limit?: number; agentId?: string; startDate?: string; endDate?: string; operations?: string[] }
): Promise<Array<Record<string, unknown>>> {
	const all = await kv.list<any>(KV.state(agentId));
	const auditEntries = all.filter((e: any) => e.id?.startsWith('audit'));
	if (filter?.limit) return auditEntries.slice(0, filter.limit);
	return auditEntries;
}

// ─── 4. Relation Evolve（agentmemory relations.ts）─────────────────────────

export async function relateEvolve(kv: StateKV, agentId: string,
	sourceId: string, targetId: string, relationType: string = 'related_to'
): Promise<{ id: string; confidence: number }> {
	const source = await kv.get<Memory>(KV.memories(agentId), sourceId);
	const target = await kv.get<Memory>(KV.memories(agentId), targetId);
	if (!source || !target) throw new Error('source or target memory not found');
	let confidence = 0.5;
	if (source.concepts && target.concepts) {
		const shared = source.concepts.filter(c => target.concepts!.includes(c));
		confidence += Math.min(shared.length * 0.1, 0.3);
	}
	const id = generateId('rel');
	const rel = { id, sourceId, targetId, type: relationType, confidence,
		createdAt: new Date().toISOString(), agentId };
	await kv.set(KV.state(agentId), `rel:${id}`, rel as any);
	return { id, confidence };
}

// ─── 5. Temporal Edge Create（agentmemory temporal-graph.ts）───────────────

export async function temporalEdgeCreate(kv: StateKV, agentId: string,
	source: string, target: string, type: string, weight: number,
	reasoning: string, sentiment: 'positive'|'negative'|'neutral' = 'neutral'
): Promise<string> {
	const id = generateId('te');
	const edge = { id, source, target, type, weight,
		validFrom: new Date().toISOString(), validTo: 'current',
		reasoning, sentiment, alternatives: [], observationIds: [], agentId };
	await kv.set(KV.state(agentId), id, edge as any);
	return id;
}

// ─── 6. Crystal Get / Auto-Crystallize（agentmemory crystallize.ts）────────

export async function crystalGet(kv: StateKV, agentId: string, crystalId: string): Promise<any | null> {
	return await kv.get<any>(KV.crystals(agentId), crystalId) ?? null;
}

export async function autoCrystallize(kv: StateKV, agentId: string): Promise<number> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const highStrength = memories.filter(m => m.isLatest !== false && m.strength >= 9);
	let count = 0;
	for (const m of highStrength) {
		const id = generateId('cry');
		const crystal = { id, narrative: m.content, keyOutcomes: [],
			filesAffected: m.files ?? [], lessons: [],
			sourceActionIds: [m.id], createdAt: new Date().toISOString(),
			project: agentId, agentId };
		await kv.set(KV.crystals(agentId), id, crystal as any);
		count++;
	}
	return count;
}

// ─── 7. Facet Stats / Dimensions / Untag / Get（agentmemory facets.ts）─────

export async function facetStats(kv: StateKV, agentId: string): Promise<Record<string, number>> {
	const all = await kv.list<any>(KV.facets(agentId));
	const facets = all.filter((f: any) => f.targetId);
	const stats: Record<string, number> = {};
	for (const f of facets) {
		const key = `${f.dimension}:${f.value}`;
		stats[key] = (stats[key] || 0) + 1;
	}
	return stats;
}

export async function facetDimensions(kv: StateKV, agentId: string): Promise<string[]> {
	const all = await kv.list<any>(KV.facets(agentId));
	return Array.from(new Set(all.filter((f: any) => f.dimension).map((f: any) => f.dimension)));
}

export async function facetUntag(kv: StateKV, agentId: string,
	targetId: string, dimension: string
): Promise<boolean> {
	const all = await kv.list<any>(KV.facets(agentId));
	for (const f of all) {
		if ((f.targetId === targetId || !targetId) && f.dimension === dimension) {
			await kv.delete(KV.facets(agentId), f.id);
			return true;
		}
	}
	return false;
}

export async function facetGet(kv: StateKV, agentId: string,
	targetId: string, dimension?: string
): Promise<Array<Record<string, unknown>>> {
	const all = await kv.list<any>(KV.facets(agentId));
	return all.filter((f: any) => f.targetId === targetId && (!dimension || f.dimension === dimension));
}

// ─── 8. Checkpoint Expire（agentmemory checkpoints.ts）─────────────────────

export async function checkpointExpire(kv: StateKV, agentId: string,
	checkpointId: string
): Promise<boolean> {
	const cp = await kv.get<any>(KV.checkpoints(agentId), checkpointId);
	if (!cp) return false;
	cp.status = 'expired';
	cp.resolvedAt = new Date().toISOString();
	await kv.set(KV.checkpoints(agentId), checkpointId, cp);
	return true;
}

// ─── 9. Lease Renew / Cleanup（agentmemory leases.ts）──────────────────────

export async function leaseRenew(kv: StateKV, agentId: string,
	leaseId: string, ttlMs: number = 30_000
): Promise<boolean> {
	const lease = await kv.get<any>(KV.leases(agentId), leaseId);
	if (!lease || lease.status !== 'active') return false;
	lease.expiresAt = new Date(Date.now() + ttlMs).toISOString();
	await kv.set(KV.leases(agentId), leaseId, lease);
	return true;
}

export async function leaseCleanup(kv: StateKV, agentId: string): Promise<number> {
	const all = await kv.list<any>(KV.leases(agentId));
	const now = Date.now();
	let cleaned = 0;
	for (const l of all) {
		if (l.status === 'active' && new Date(l.expiresAt).getTime() < now) {
			l.status = 'expired';
			await kv.set(KV.leases(agentId), l.id, l);
			cleaned++;
		}
	}
	return cleaned;
}

// ─── 10. Sketch Discard（agentmemory sketches.ts）──────────────────────────

export async function sketchDiscard(kv: StateKV, agentId: string,
	sketchId: string
): Promise<boolean> {
	const sk = await kv.get<any>(KV.sketches(agentId), sketchId);
	if (!sk) return false;
	sk.status = 'discarded';
	await kv.set(KV.sketches(agentId), sketchId, sk);
	return true;
}

// ─── 11. Disk Size Manager（agentmemory disk-size-manager.ts，简化版）───────

export async function diskSizeCleanup(kv: StateKV, agentId: string): Promise<{ cleanedScopes: string[]; freedBytes: number }> {
	const cleanedScopes: string[] = [];
	let freedBytes = 0;
	// 清理过期 leases + 旧 expired checkpoints
	const leasesCleaned = await leaseCleanup(kv, agentId);
	if (leasesCleaned > 0) cleanedScopes.push('leases');
	// 清理 stale state entries
	const stateEntries = await kv.list<any>(KV.state(agentId));
	for (const e of stateEntries) {
		if (e.stale) {
			await kv.delete(KV.state(agentId), e.id);
			freedBytes += JSON.stringify(e).length;
		}
	}
	return { cleanedScopes, freedBytes };
}

// ─── 12. Image Quota Cleanup（agentmemory image-quota-cleanup.ts）───────────

export function imageQuotaCleanup(agentId: string): { removed: number } {
	// V2 不存储图片，总是返回 0
	return { removed: 0 };
}

// ─── 13. Smart Search（agentmemory smart search 聚合层）────────────────────

export async function smartSearch(kv: StateKV, agentId: string,
	query: string, limit: number = 10
): Promise<Array<{ id: string; content: string; score: number; source: string; type?: string }>> {
	const results: Array<{ id: string; content: string; score: number; source: string; type?: string }> = [];
	// 1. Memories
	const mems = await kv.list<Memory>(KV.memories(agentId));
	const q = query.toLowerCase();
	const terms = q.split(/\s+/).filter(t => t.length > 1);
	for (const m of mems) {
		if (m.isLatest === false) continue;
		const text = (m.content + ' ' + (m.concepts ?? []).join(' ')).toLowerCase();
		const matchCount = terms.filter(t => text.includes(t)).length;
		if (matchCount > 0) {
			results.push({ id: m.id, content: m.content, score: matchCount / terms.length, source: 'memory', type: m.type });
		}
	}
	// 2. Lessons
	const lessons = await kv.list<Lesson>(KV.lessons(agentId));
	for (const l of lessons) {
		if (l.deleted) continue;
		const text = (l.content + ' ' + (l.context ?? '')).toLowerCase();
		const matchCount = terms.filter(t => text.includes(t)).length;
		if (matchCount > 0) {
			results.push({ id: l.id, content: l.content, score: matchCount / terms.length * l.confidence, source: 'lesson' });
		}
	}
	return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── 14. Recent Searches（agentmemory 搜索历史）────────────────────────────

export async function recentSearchesGet(kv: StateKV, agentId: string,
	limit: number = 20
): Promise<Array<{ query: string; timestamp: string; resultCount: number }>> {
	const all = await kv.list<any>(KV.recentSearches(agentId));
	return all
		.filter((s: any) => s.query)
		.sort((a: any, b: any) => (b.timestamp || '').localeCompare(a.timestamp || ''))
		.slice(0, limit);
}

export async function recentSearchesAdd(kv: StateKV, agentId: string,
	query: string, resultCount: number
): Promise<void> {
	const id = generateId('sr');
	await kv.set(KV.recentSearches(agentId), id, {
		id, query, timestamp: new Date().toISOString(), resultCount
	});
}

// ─── 15. Health Monitor（agentmemory health.ts，简化版）─────────────────────

export async function healthCheck(kv: StateKV, agentId: string): Promise<{
	status: 'healthy' | 'degraded' | 'unhealthy';
	checks: Record<string, { ok: boolean; detail?: string }>;
}> {
	const checks: Record<string, { ok: boolean; detail?: string }> = {};
	try {
		const mems = await kv.list<Memory>(KV.memories(agentId));
		checks['memories'] = { ok: true, detail: `${mems.length} entries` };
	} catch (e: any) { checks['memories'] = { ok: false, detail: e.message }; }
	try {
		const core = await kv.list<any>(KV.coreMemory(agentId));
		checks['core'] = { ok: true, detail: `${core.length} entries` };
	} catch (e: any) { checks['core'] = { ok: false, detail: e.message }; }
	const allOk = Object.values(checks).every(c => c.ok);
	return { status: allOk ? 'healthy' : 'degraded', checks };
}

// ─── 16. Circuit Breaker States（agentmemory circuit-breaker.ts）────────────

export async function circuitStatesGet(kv: StateKV, agentId: string): Promise<Record<string, unknown>> {
	const all = await kv.list<any>(KV.state(agentId));
	const circuits = all.filter((c: any) => c.id?.startsWith('circuit'));
	const result: Record<string, unknown> = {};
	for (const c of circuits) {
		result[c.name || c.id] = { status: c.status || 'closed', failCount: c.failCount || 0 };
	}
	return result;
}

// ─── 17. Dedup Map（agentmemory dedup.ts 的 KV 持久化版本）───────────────

export async function dedupCheck(kv: StateKV, agentId: string,
	key: string
): Promise<boolean> {
	const existing = await kv.get<any>(KV.state(agentId), `dedup:${key}`);
	return !!existing;
}

export async function dedupMark(kv: StateKV, agentId: string,
	key: string
): Promise<void> {
	await kv.set(KV.state(agentId), `dedup:${key}`, {
		id: `dedup:${key}`, key, createdAt: new Date().toISOString()
	});
}

// ─── 18. Rich File Context（agentmemory file-index.ts + concepts 增强版）────

export async function richFileContext(kv: StateKV, agentId: string,
	files: string[], concepts: string[] = []
): Promise<{ context: string; memoryCount: number; concepts: string[] }> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const active = memories.filter(m => m.isLatest !== false);
	const related = active.filter(m => {
		const fileMatch = files.some(f => (m.files ?? []).some(mf => mf.includes(f) || f.includes(mf)));
		const conceptMatch = concepts.length > 0 && concepts.some(c =>
			(m.concepts ?? []).some(mc => mc.toLowerCase().includes(c.toLowerCase()))
		);
		return fileMatch || conceptMatch;
	});
	const extractedConcepts = Array.from(new Set(related.flatMap(m => m.concepts ?? [])));
	const context = related.slice(0, 10).map(m => `- [${m.type}] ${m.content.slice(0, 240)}`).join('\n');
	return { context: context.slice(0, 4000), memoryCount: related.length, concepts: extractedConcepts };
}

// ─── 19. Version Diff Aware（agentmemory 版本对比，新功能）───────────────

export async function diffFileContext(kv: StateKV, agentId: string,
	filesChanged: string[]
): Promise<string> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const active = memories.filter(m => m.isLatest !== false);
	const related = active.filter(m =>
		filesChanged.some(f => (m.files ?? []).some(mf => mf.includes(f) || f.includes(mf)))
	);
	if (related.length === 0) return '';
	const lines: string[] = ['## Related memories for changed files'];
	for (const m of related.slice(0, 10)) {
		lines.push(`- [${m.type}] ${m.content.slice(0, 200)}`);
	}
	return lines.join('\n');
}

// ─── 20. Skills Write File（agentmemory skill file writer，简化版）─────────

export async function skillsWriteFile(skillsList: Array<{ id: string; title: string; steps: string[]; confidence: number }>): Promise<{
	written: number; failed: number; errors: string[];
}> {
	// 无文件系统访问权限时返回成功但 written=0
	return { written: 0, failed: skillsList.length, errors: skillsList.map(s => `No fs access for ${s.id}`) };
}

// ─── 21. Signal Types Expanded（agentmemory signals.ts 扩展）──────────────

export async function signalSendExpanded(kv: StateKV, agentId: string,
	type: 'info'|'request'|'response'|'alert'|'handoff', content: string,
	to?: string, ttlMs?: number
): Promise<{ id: string }> {
	const id = generateId('sig');
	const signal = { id, from: agentId, to, type, content,
		createdAt: new Date().toISOString(),
		expiresAt: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined };
	await kv.set(KV.signals(agentId), id, signal as any);
	return { id };
}

export async function signalQueryExpanded(kv: StateKV, agentId: string,
	type?: string, from?: string
): Promise<Array<Record<string, unknown>>> {
	const all = await kv.list<any>(KV.signals(agentId));
	const now = Date.now();
	return all.filter((s: any) => {
		if (s.expiresAt && new Date(s.expiresAt).getTime() < now) return false;
		if (type && s.type !== type) return false;
		if (from && s.from !== from) return false;
		return true;
	});
}
