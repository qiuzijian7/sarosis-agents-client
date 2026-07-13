/*---------------------------------------------------------------------------------------------
 *  AgentMemory 无状态函数 — 1:1 对齐 agentmemory src/functions/*.ts
 *
 *  核心设计：
 *    - 每个函数是无状态的，不持有任何内存缓存
 *    - 每次操作直接读写 StateKV（磁盘优先）
 *    - 记忆按类型存储在独立 KV scope 中
 *    - 每条记忆是独立 KV key-value（不是 JSONL 批量 blob）
 *    - 废弃旧的 Map<string, InternalMemoryEntry[]> + JSONL 序列化模式
 *--------------------------------------------------------------------------------------------*/

import type {
	Memory, CoreMemoryEntry,
	Lesson, SessionSummary, AccessLog, RetentionScore,
	ContextBlock, SearchResult, IMemoryEntry, IMemoryContext,
	Observation, ObservationPayload,
	SemanticMemory, ProceduralMemory, Insight,
} from './amTypes.js';
import { KV, generateId, fingerprintId, jaccardSimilarity, estimateTokens } from './amSchema.js';
import { StateKV } from './stateKV.js';
import { getProfile } from './amPipeline.js';
import { listPinnedSlots, renderPinnedContext } from './amSlots.js';

// 延迟导入（避免循环依赖）
// Plan C: getter 可能返回网关 HTTP 代理（search 为异步），故用最小接口而非
// 具体类类型，真实 BM25Index / VectorIndex 与代理都满足该契约。
export interface SearchHit { id: string; score: number; }
export interface BM25Like {
	readonly size: number;
	search(query: string, limit?: number): SearchHit[] | Promise<SearchHit[]>;
}
export interface VectorLike {
	readonly available: boolean;
	readonly size: number;
	search(query: string, limit?: number): Promise<SearchHit[]>;
}
let _getBM25Index: (() => BM25Like) | undefined;
let _getVectorIndex: (() => VectorLike) | undefined;
export function setIndexGetters(
	bm25Fn: () => BM25Like,
	vecFn: () => VectorLike,
): void {
	_getBM25Index = bm25Fn;
	_getVectorIndex = vecFn;
}

const RECENT_CAP = 20;
/** Jaccard 冲突检测阈值（对齐 agentmemory remember.ts > 0.7） */
const CONTRADICTION_THRESHOLD = 0.7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Access Tracker ─────────────────────────────────────────────────────

export async function recordAccess(kv: StateKV, agentId: string, memoryId: string, ts?: number): Promise<void> {
	if (!memoryId) return;
	const timestamp = ts ?? Date.now();
	const log = await kv.get<AccessLog>(KV.accessLog(agentId), memoryId) ?? {
		memoryId, count: 0, lastAt: '', recent: [],
	};
	log.count++;
	log.lastAt = new Date(timestamp).toISOString();
	log.recent.push(timestamp);
	if (log.recent.length > RECENT_CAP) log.recent = log.recent.slice(-RECENT_CAP);
	await kv.set(KV.accessLog(agentId), memoryId, log);
}

export async function recordAccessBatch(kv: StateKV, agentId: string, memoryIds: string[], ts?: number): Promise<void> {
	await Promise.all(memoryIds.map(id => recordAccess(kv, agentId, id, ts).catch(() => {})));
}

export async function getAccessLog(kv: StateKV, agentId: string, memoryId: string): Promise<AccessLog> {
	return await kv.get<AccessLog>(KV.accessLog(agentId), memoryId) ?? {
		memoryId, count: 0, lastAt: '', recent: [],
	};
}

export async function deleteAccessLog(kv: StateKV, agentId: string, memoryId: string): Promise<void> {
	await kv.delete(KV.accessLog(agentId), memoryId);
}

// ─── Core Memory ────────────────────────────────────────────────────────

export async function coreAdd(kv: StateKV, agentId: string, content: string, importance?: number, pinned?: boolean): Promise<string> {
	if (!content?.trim()) return '';
	const id = generateId('core');
	const now = new Date().toISOString();
	const entry: CoreMemoryEntry = {
		id, content: content.trim(),
		importance: Math.min(10, Math.max(1, importance ?? 7)),
		pinned: pinned ?? false,
		accessCount: 0, lastAccessedAt: now, createdAt: now, agentId,
	};
	await kv.set(KV.coreMemory(agentId), id, entry);
	return id;
}

export async function coreRemove(kv: StateKV, agentId: string, id: string): Promise<boolean> {
	await kv.delete(KV.coreMemory(agentId), id);
	return true;
}

export async function coreList(kv: StateKV, agentId: string): Promise<CoreMemoryEntry[]> {
	const entries = await kv.list<CoreMemoryEntry>(KV.coreMemory(agentId));
	return entries.sort((a, b) => b.importance - a.importance);
}

export async function autoPage(kv: StateKV, agentId: string, tokenBudget: number): Promise<number> {
	const coreEntries = await kv.list<CoreMemoryEntry>(KV.coreMemory(agentId));
	const coreBudget = Math.floor(tokenBudget * 0.3);
	let totalTokens = coreEntries.reduce((s, e) => s + estimateTokens(e.content), 0);
	if (totalTokens <= coreBudget) return 0;
	const now = Date.now();
	const unpinned = coreEntries.filter(e => !e.pinned).sort((a, b) => scoreCoreEntry(a, now) - scoreCoreEntry(b, now));
	let paged = 0;
	for (const entry of unpinned) {
		if (totalTokens <= coreBudget) break;
		const mem: Memory = {
			id: generateId('mem'), createdAt: entry.createdAt, updatedAt: new Date().toISOString(),
			type: 'fact', title: entry.content.slice(0, 80), content: entry.content,
			concepts: [], files: [], sessionIds: [], strength: entry.importance / 10,
			version: 1, isLatest: true, agentId,
		};
		await kv.set(KV.memories(agentId), mem.id, mem);
		await kv.delete(KV.coreMemory(agentId), entry.id);
		totalTokens -= estimateTokens(entry.content);
		paged++;
	}
	return paged;
}

function scoreCoreEntry(e: CoreMemoryEntry, now: number): number {
	const recencyDays = (now - new Date(e.lastAccessedAt).getTime()) / MS_PER_DAY;
	return (e.importance / 10) * 0.5 + (1 / (1 + recencyDays * 0.1)) * 0.3 + (Math.log2(e.accessCount + 1) / 10) * 0.2;
}

export async function buildWorkingContext(kv: StateKV, agentId: string, tokenBudget: number): Promise<string> {
	const now = Date.now();
	let usedTokens = 0;
	const coreEntries = await kv.list<CoreMemoryEntry>(KV.coreMemory(agentId));
	const pinned = coreEntries.filter(e => e.pinned);
	const unpinned = coreEntries.filter(e => !e.pinned).sort((a, b) => scoreCoreEntry(b, now) - scoreCoreEntry(a, now));
	const coreLines: string[] = [];
	const coreBudget = Math.floor(tokenBudget * 0.3);
	for (const entry of [...pinned, ...unpinned]) {
		const tokens = estimateTokens(entry.content);
		if (usedTokens + tokens > coreBudget && !entry.pinned) continue;
		coreLines.push(`- ${entry.content}`);
		usedTokens += tokens;
	}
	const archivalLines: string[] = [];
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const active = memories.filter(m => m.isLatest !== false).sort((a, b) => b.strength - a.strength);
	const archivalIds: string[] = [];
	for (const mem of active) {
		const tokens = estimateTokens(mem.content);
		if (usedTokens + tokens > tokenBudget) continue;
		archivalLines.push(`- [${mem.type}] ${mem.title}: ${mem.content}`);
		archivalIds.push(mem.id);
		usedTokens += tokens;
	}
	void recordAccessBatch(kv, agentId, archivalIds);
	const sections: string[] = [];
	if (coreLines.length > 0) sections.push(`## Core Memory\n${coreLines.join('\n')}`);
	if (archivalLines.length > 0) sections.push(`## Archival Memory\n${archivalLines.join('\n')}`);
	return sections.join('\n\n');
}

// ─── Remember ───────────────────────────────────────────────────────────

export async function remember(
	kv: StateKV, agentId: string,
	content: string, type?: Memory['type'], concepts?: string[], files?: string[],
	ttlDays?: number, project?: string, idOverride?: string,
): Promise<{ success: boolean; id?: string; action?: string; error?: string }> {
	if (!content?.trim()) return { success: false, error: 'content is required' };
	const validTypes = new Set(['pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact']);
	const memType = validTypes.has(type || '') ? type! : 'fact';
	const now = new Date().toISOString();
	const ttl = ttlDays ? new Date(Date.now() + ttlDays * MS_PER_DAY).toISOString() : undefined;

	// P18: 指纹去重（对齐 agentmemory fingerprintId 检查）
	const fpId = fingerprintId('mem', content.trim());
	const fpExisting = await kv.get<Memory>(KV.memories(agentId), fpId);
	if (fpExisting && fpExisting.isLatest !== false) {
		return { success: true, id: fpId, action: 'deduplicated' };
	}

	// Jaccard 冲突检测（> 0.7 阈值，对齐 agentmemory remember.ts:81）
	const existing = await kv.list<Memory>(KV.memories(agentId));
	let supersededId: string | undefined;
	let supersededVersion = 1;
	for (const m of existing) {
		if (m.isLatest === false) continue;
		if (project && m.project && m.project !== project) continue;
		const sim = jaccardSimilarity(content.toLowerCase(), m.content.toLowerCase());
		if (sim > CONTRADICTION_THRESHOLD) {
			supersededId = m.id;
			supersededVersion = (m.version ?? 1) + 1;
			m.isLatest = false;
			m.updatedAt = now;
			await kv.set(KV.memories(agentId), m.id, m);
			break;
		}
	}

	const id = idOverride || fpId; // 显式 id 优先（IMemoryProvider 契约），否则用指纹 ID
	const mem: Memory = {
		id, createdAt: now, updatedAt: now, type: memType, title: content.slice(0, 80),
		content: content.trim(), concepts: concepts ?? [], files: files ?? [],
		sessionIds: [], strength: 7, version: supersededId ? supersededVersion : 1,
		isLatest: true, parentId: supersededId,
		forgetAfter: ttl, agentId, project,
	};
	if (supersededId) {
		(mem as any).supersedes = [supersededId]; // 声明替代了哪个旧版本
	}
	await kv.set(KV.memories(agentId), id, mem);
	return { success: true, id, action: supersededId ? 'superseded' : 'created' };
}

// ─── Search ─────────────────────────────────────────────────────────────

const RRF_K = 60;
const HYBRID_BM25_WEIGHT = 0.4;
const HYBRID_VECTOR_WEIGHT = 0.6;

export async function searchMemories(kv: StateKV, agentId: string, query: string, limit: number = 10): Promise<SearchResult[]> {
	if (!query?.trim()) {
		return fallbackKVRecall(kv, agentId, limit);
	}

	const bm25 = _getBM25Index?.();
	const vec = _getVectorIndex?.();

	// BM25 召回（Plan C: getter 可能返回网关 HTTP 代理，search 为异步）
	const bm25Results: Map<string, number> = new Map();
	if (bm25) {
		const bm25Hits = await bm25.search(query, limit * 3);
		for (const r of bm25Hits) {
			bm25Results.set(r.id, r.score);
		}
	}

	// Vector 召回（如果可用）
	const vectorResults: Map<string, number> = new Map();
	if (vec && vec.available) {
		try {
			for (const r of await vec.search(query, limit * 3)) {
				vectorResults.set(r.id, r.score);
			}
		} catch { /* fall through to BM25-only */ }
	}

	// RRF 融合（对齐 agentmemory hybrid-search.ts）
	const hasVector = vectorResults.size > 0;
	const allIds = new Set([...bm25Results.keys(), ...vectorResults.keys()]);
	const combined: Array<{ id: string; score: number }> = [];

	// 权重动态归一化
	let effectiveBm25W = HYBRID_BM25_WEIGHT;
	let effectiveVectorW = hasVector ? HYBRID_VECTOR_WEIGHT : 0;
	const totalW = effectiveBm25W + effectiveVectorW;
	if (totalW > 0) { effectiveBm25W /= totalW; effectiveVectorW /= totalW; }

	// 按分数排序得出 rank
	const bm25Ranked = Array.from(bm25Results.entries()).sort((a, b) => b[1] - a[1]);
	const vectorRanked = Array.from(vectorResults.entries()).sort((a, b) => b[1] - a[1]);

	for (const id of allIds) {
		const bIdx = bm25Ranked.findIndex(([i]) => i === id);
		const vIdx = vectorRanked.findIndex(([i]) => i === id);
		const bm25RRF = bIdx >= 0 ? 1 / (RRF_K + bIdx + 1) : 0;
		const vectorRRF = vIdx >= 0 ? 1 / (RRF_K + vIdx + 1) : 0;
		const score = effectiveBm25W * bm25RRF + effectiveVectorW * vectorRRF;
		combined.push({ id, score });
	}
	combined.sort((a, b) => b.score - a.score);

	// 从 KV 回查 content + type
	const top = combined.slice(0, limit);
	const results: SearchResult[] = [];
	for (const c of top) {
		try {
			const mem = await kv.get<Memory>(KV.memories(agentId), c.id);
			if (mem && mem.isLatest !== false) {
				results.push({ id: mem.id, content: mem.content, score: c.score, source: hasVector ? 'hybrid' : 'bm25' });
			}
		} catch { /* skip missing */ }
	}
	void recordAccessBatch(kv, agentId, results.map(r => r.id));
	return results;
}

/** 回退：KV 直接遍历词匹配（BM25 不可用时） */
async function fallbackKVRecall(kv: StateKV, agentId: string, limit: number): Promise<SearchResult[]> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const active = memories.filter(m => m.isLatest !== false).sort((a, b) => b.strength - a.strength);
	return active.slice(0, limit).map(mem => ({
		id: mem.id, content: mem.content, score: mem.strength / 10, source: 'kv' as const,
	}));
}

// ─── Context ────────────────────────────────────────────────────────────

export async function buildContext(
	kv: StateKV, agentId: string, sessionId: string, project: string, tokenBudget: number,
): Promise<IMemoryContext> {
	const blocks: ContextBlock[] = [];

	// Pinned slots（固定注入，不受 token budget 截断，priority=0）
	const pinnedSlots = await listPinnedSlots(kv, agentId);
	const slotContent = renderPinnedContext(pinnedSlots);
	if (slotContent) {
		blocks.push({ type: 'slot', content: slotContent, tokens: estimateTokens(slotContent), recency: Date.now(), priority: 0 } as any);
	}

	const coreEntries = await kv.list<CoreMemoryEntry>(KV.coreMemory(agentId));
	for (const e of coreEntries) {
		const content = `- ${e.content}`;
		blocks.push({ type: 'core', content, tokens: estimateTokens(content), recency: new Date(e.lastAccessedAt).getTime(), sourceIds: [e.id] });
	}

	// Profile block（从 amPipeline 获取，对齐 agentmemory context.ts profile 注入）
	const profile = await getProfile(kv, agentId);
	if (profile) {
		const parts: string[] = [];
		if (profile.topConcepts?.length > 0) parts.push(`Concepts: ${profile.topConcepts.slice(0, 8).map(c => c.concept).join(', ')}`);
		if (profile.topFiles?.length > 0) parts.push(`Key files: ${profile.topFiles.slice(0, 5).map(f => f.file).join(', ')}`);
		if (profile.conventions?.length > 0) parts.push(`Conventions: ${profile.conventions.join('; ')}`);
		if (profile.commonErrors?.length > 0) parts.push(`Common errors: ${profile.commonErrors.slice(0, 3).join('; ')}`);
		if (parts.length > 0) {
			const content = `## Project Profile\n${parts.join('\n')}`;
			blocks.push({ type: 'slot', content, tokens: estimateTokens(content), recency: Date.now(), priority: 0 } as any);
		}
	}
	const lessons = await kv.list<Lesson>(KV.lessons(agentId));
	const relevantLessons = lessons.filter(l => !l.deleted && l.confidence >= 0.1)
		.sort((a, b) => ((b.project === project ? 1.5 : 1) * b.confidence) - ((a.project === project ? 1.5 : 1) * a.confidence))
		.slice(0, 10);
	if (relevantLessons.length > 0) {
		const items = relevantLessons.map(l => `- (${l.confidence.toFixed(2)}) ${l.content}${l.context ? ` — ${l.context}` : ''}`).join('\n');
		const content = `## Lessons Learned\n${items}`;
		blocks.push({ type: 'lesson', content, tokens: estimateTokens(content), recency: Date.now(), sourceIds: relevantLessons.map(l => l.id) });
	}
	const summaries = await kv.list<SessionSummary>(KV.summaries(agentId));
	for (const s of summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10)) {
		const content = `## ${s.title}\n${s.narrative}\nDecisions: ${s.keyDecisions.join('; ')}\nFiles: ${s.filesModified.join(', ')}`;
		blocks.push({ type: 'summary', content, tokens: estimateTokens(content), recency: new Date(s.createdAt).getTime() });
	}
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const active = memories.filter(m => m.isLatest !== false).sort((a, b) => b.strength - a.strength);
	for (const m of active.slice(0, 20)) {
		const content = `- [${m.type}] ${m.title}: ${m.content.slice(0, 200)}`;
		blocks.push({ type: 'memory', content, tokens: estimateTokens(content), recency: new Date(m.updatedAt).getTime(), sourceIds: [m.id] });
	}
	let usedTokens = 0;
	const selected: string[] = [];
	const accessedIds: string[] = [];
	for (const block of blocks) {
		if (usedTokens + block.tokens > tokenBudget) continue;
		selected.push(block.content);
		usedTokens += block.tokens;
		if (block.sourceIds) accessedIds.push(...block.sourceIds);
	}
	if (accessedIds.length > 0) void recordAccessBatch(kv, agentId, accessedIds);
	void autoPage(kv, agentId, tokenBudget);
	const header = `<agentmemory-context project="${project}">`;
	const footer = `</agentmemory-context>`;
	const systemPrompt = selected.length > 0 ? `${header}\n${selected.join('\n\n')}\n${footer}` : '';
	const longTermMemories: IMemoryEntry[] = active.slice(0, 10).map(m => ({
		id: m.id, type: m.type, content: m.content,
		metadata: { concepts: m.concepts, files: m.files, strength: m.strength },
		timestamp: new Date(m.createdAt).getTime(), importance: m.strength,
	}));
	const shortTermMemories: IMemoryEntry[] = coreEntries.slice(0, 15).map(e => ({
		id: e.id, type: 'working', content: e.content,
		metadata: { pinned: e.pinned, importance: e.importance },
		timestamp: new Date(e.createdAt).getTime(), importance: e.importance,
	}));
	return { shortTermMemories, longTermMemories, systemPrompt, relevantDocuments: [] };
}

// ─── Auto-forget ────────────────────────────────────────────────────────

export async function autoForget(kv: StateKV, agentId: string, dryRun: boolean = false): Promise<{
	ttlExpired: string[]; contradictions: Array<{ memoryA: string; memoryB: string; similarity: number }>; lowValue: string[];
}> {
	const now = Date.now();
	const result = { ttlExpired: [] as string[], contradictions: [] as Array<{ memoryA: string; memoryB: string; similarity: number }>, lowValue: [] as string[] };
	const memories = await kv.list<Memory>(KV.memories(agentId));
	for (const mem of memories) {
		if (mem.forgetAfter && now > new Date(mem.forgetAfter).getTime()) {
			result.ttlExpired.push(mem.id);
			if (!dryRun) { await kv.delete(KV.memories(agentId), mem.id); await deleteAccessLog(kv, agentId, mem.id); }
		}
	}
	const latest = memories.filter(m => m.isLatest !== false && !result.ttlExpired.includes(m.id)).slice(0, 1000);
	const compared = new Set<string>();
	for (let i = 0; i < latest.length; i++) {
		for (let j = i + 1; j < latest.length; j++) {
			const key = latest[i].id < latest[j].id ? `${latest[i].id}|${latest[j].id}` : `${latest[j].id}|${latest[i].id}`;
			if (compared.has(key)) continue;
			compared.add(key);
			const sim = jaccardSimilarity(latest[i].content.toLowerCase(), latest[j].content.toLowerCase());
			if (sim > CONTRADICTION_THRESHOLD) {
				result.contradictions.push({ memoryA: latest[i].id, memoryB: latest[j].id, similarity: sim });
				if (!dryRun) {
					const older = new Date(latest[i].createdAt).getTime() < new Date(latest[j].createdAt).getTime() ? latest[i] : latest[j];
					older.isLatest = false;
					older.updatedAt = new Date().toISOString();
					await kv.set(KV.memories(agentId), older.id, older);
				}
			}
		}
	}
	for (const mem of latest) {
		if (mem.isLatest === false) continue;
		if (mem.strength <= 2 && (now - new Date(mem.createdAt).getTime()) > 180 * MS_PER_DAY) {
			result.lowValue.push(mem.id);
			if (!dryRun) { await kv.delete(KV.memories(agentId), mem.id); await deleteAccessLog(kv, agentId, mem.id); }
		}
	}
	return result;
}

// ─── Retention ──────────────────────────────────────────────────────────

const DEFAULT_DECAY = { lambda: 0.01, sigma: 0.3, tiers: { hot: 0.7, warm: 0.4, cold: 0.15 } };

export async function retentionScore(kv: StateKV, agentId: string): Promise<{ total: number; scores: RetentionScore[]; tiers: { hot: number; warm: number; cold: number; evictable: number } }> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const scores: RetentionScore[] = [];
	for (const mem of memories) {
		if (mem.isLatest === false) continue;
		const log = await getAccessLog(kv, agentId, mem.id);
		const typeWeights: Record<string, number> = { architecture: 0.9, pattern: 0.8, preference: 0.85, bug: 0.7, workflow: 0.6, fact: 0.5 };
		const salience = Math.min(1, (typeWeights[mem.type] ?? 0.5) + Math.min(0.2, log.count * 0.02));
		const daysSinceCreation = (Date.now() - new Date(mem.createdAt).getTime()) / MS_PER_DAY;
		const temporalDecay = Math.exp(-DEFAULT_DECAY.lambda * daysSinceCreation);
		const reinforcementBoost = log.recent.reduce((s, t) => s + 1 / Math.max(1, (Date.now() - t) / MS_PER_DAY), 0) * DEFAULT_DECAY.sigma;
		const score = Math.min(1, salience * temporalDecay + reinforcementBoost);
		scores.push({ memoryId: mem.id, source: 'episodic', score, salience, temporalDecay, reinforcementBoost, lastAccessed: log.recent[log.recent.length - 1] ?? 0, accessCount: log.count });
	}
	scores.sort((a, b) => b.score - a.score);
	const tiers = {
		hot: scores.filter(s => s.score >= DEFAULT_DECAY.tiers.hot).length,
		warm: scores.filter(s => s.score >= DEFAULT_DECAY.tiers.warm && s.score < DEFAULT_DECAY.tiers.hot).length,
		cold: scores.filter(s => s.score >= DEFAULT_DECAY.tiers.cold && s.score < DEFAULT_DECAY.tiers.warm).length,
		evictable: scores.filter(s => s.score < DEFAULT_DECAY.tiers.cold).length,
	};
	await Promise.all(scores.map(s => kv.set(KV.retentionScores(agentId), s.memoryId, s)));
	return { total: scores.length, scores, tiers };
}

export async function retentionEvict(kv: StateKV, agentId: string, maxEvict: number = 50): Promise<number> {
	const scores = await kv.list<RetentionScore>(KV.retentionScores(agentId));
	const candidates = scores.filter(s => s.score < DEFAULT_DECAY.tiers.cold).sort((a, b) => a.score - b.score).slice(0, Math.min(1000, maxEvict));
	let evicted = 0;
	for (const c of candidates) {
		await kv.delete(KV.memories(agentId), c.memoryId);
		await kv.delete(KV.retentionScores(agentId), c.memoryId);
		await deleteAccessLog(kv, agentId, c.memoryId);
		evicted++;
	}
	return evicted;
}

// ─── Lessons ────────────────────────────────────────────────────────────

export async function lessonSave(kv: StateKV, agentId: string, content: string, context?: string, confidence?: number, project?: string): Promise<{ action: string; id: string }> {
	if (!content?.trim()) return { action: 'error', id: '' };
	const fp = fingerprintId('lsn', content.trim().toLowerCase());
	const existing = await kv.get<Lesson>(KV.lessons(agentId), fp);
	if (existing && !existing.deleted) {
		existing.reinforcements++;
		existing.confidence = Math.min(1, existing.confidence + 0.1 * (1 - existing.confidence));
		existing.lastReinforcedAt = new Date().toISOString();
		existing.updatedAt = new Date().toISOString();
		if (context && !existing.context) existing.context = context;
		await kv.set(KV.lessons(agentId), fp, existing);
		return { action: 'strengthened', id: fp };
	}
	const now = new Date().toISOString();
	const lesson: Lesson = {
		id: fp, content: content.trim(), context: context?.trim() ?? '',
		confidence: confidence ?? 0.5, reinforcements: 0,
		source: 'manual', sourceIds: [], project, tags: [],
		createdAt: now, updatedAt: now, decayRate: 0.05,
	};
	await kv.set(KV.lessons(agentId), fp, lesson);
	return { action: 'created', id: fp };
}

export async function lessonRecall(kv: StateKV, agentId: string, query: string, project?: string, limit: number = 10): Promise<Lesson[]> {
	const lessons = await kv.list<Lesson>(KV.lessons(agentId));
	const q = query.toLowerCase();
	return lessons
		.filter(l => !l.deleted && l.confidence >= 0.1)
		.filter(l => !project || !l.project || l.project === project)
		.map(l => {
			const text = `${l.content} ${l.context} ${l.tags.join(' ')}`.toLowerCase();
			const terms = q.split(/\s+/).filter(t => t.length > 1);
			const matchCount = terms.filter(t => text.includes(t)).length;
			if (matchCount === 0) return null;
			const relevance = matchCount / terms.length;
			const daysSince = l.lastReinforcedAt ? (Date.now() - new Date(l.lastReinforcedAt).getTime()) / MS_PER_DAY : 999;
			return { lesson: l, score: l.confidence * relevance * (1 / (1 + daysSince * 0.01)) };
		})
		.filter((x): x is NonNullable<typeof x> => x !== null)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(x => x.lesson);
}

export async function lessonList(kv: StateKV, agentId: string): Promise<Lesson[]> {
	const lessons = await kv.list<Lesson>(KV.lessons(agentId));
	return lessons.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function lessonDelete(kv: StateKV, agentId: string, lessonId: string): Promise<boolean> {
	const lesson = await kv.get<Lesson>(KV.lessons(agentId), lessonId);
	if (!lesson) return false;
	lesson.deleted = true;
	lesson.updatedAt = new Date().toISOString();
	await kv.set(KV.lessons(agentId), lessonId, lesson);
	return true;
}

export async function lessonDecaySweep(kv: StateKV, agentId: string): Promise<{ decayed: number; softDeleted: number }> {
	const lessons = await kv.list<Lesson>(KV.lessons(agentId));
	let decayed = 0, softDeleted = 0;
	const now = Date.now();
	for (const lesson of lessons) {
		if (lesson.deleted) continue;
		const baseline = lesson.lastDecayedAt || lesson.lastReinforcedAt || lesson.createdAt;
		const weeks = (now - new Date(baseline).getTime()) / (MS_PER_DAY * 7);
		if (weeks < 1) continue;
		const decay = lesson.decayRate * weeks;
		const newConf = Math.max(0.05, lesson.confidence - decay);
		if (newConf !== lesson.confidence) {
			lesson.confidence = Math.round(newConf * 1000) / 1000;
			lesson.lastDecayedAt = new Date().toISOString();
			lesson.updatedAt = new Date().toISOString();
			if (lesson.confidence <= 0.1 && lesson.reinforcements === 0) { lesson.deleted = true; softDeleted++; }
			else { decayed++; }
			await kv.set(KV.lessons(agentId), lesson.id, lesson);
		}
	}
	return { decayed, softDeleted };
}

// ─── Semantic Memory（独立 KV scope mem:semantic）──────────────────────

export async function semanticSave(kv: StateKV, agentId: string, content: string, confidence: number = 0.7, sourceIds: string[] = [], tags: string[] = [], project?: string): Promise<string> {
	if (!content?.trim()) return '';
	const id = generateId('sem');
	const now = new Date().toISOString();
	const entry: SemanticMemory = {
		id, createdAt: now, updatedAt: now, content: content.trim(),
		confidence, accessCount: 0, sourceIds, tags, project, agentId,
	};
	await kv.set(KV.semantic(agentId), id, entry);
	return id;
}

export async function semanticList(kv: StateKV, agentId: string): Promise<SemanticMemory[]> {
	return kv.list<SemanticMemory>(KV.semantic(agentId));
}

export async function semanticSearch(kv: StateKV, agentId: string, query: string, limit: number = 10): Promise<SemanticMemory[]> {
	const all = await kv.list<SemanticMemory>(KV.semantic(agentId));
	const q = query.toLowerCase();
	const terms = q.split(/\s+/).filter(t => t.length > 1);
	return all
		.map(s => {
			const text = `${s.content} ${s.tags.join(' ')}`.toLowerCase();
			const matchCount = terms.filter(t => text.includes(t)).length;
			if (matchCount === 0) return null;
			return { entry: s, score: (matchCount / terms.length) * s.confidence };
		})
		.filter((x): x is NonNullable<typeof x> => x !== null)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(x => x.entry);
}

// ─── Procedural Memory（独立 KV scope mem:procedural）──────────────────

export async function proceduralSave(kv: StateKV, agentId: string, title: string, steps: string[], preconditions: string[] = [], expectedOutcome: string = '', confidence: number = 0.7, tags: string[] = [], project?: string): Promise<string> {
	if (!title?.trim()) return '';
	const id = generateId('proc');
	const now = new Date().toISOString();
	const entry: ProceduralMemory = {
		id, createdAt: now, updatedAt: now, title: title.trim(),
		steps, preconditions, expectedOutcome, confidence,
		sourceSessionIds: [], tags, project, agentId,
	};
	await kv.set(KV.procedural(agentId), id, entry);
	return id;
}

export async function proceduralList(kv: StateKV, agentId: string): Promise<ProceduralMemory[]> {
	return kv.list<ProceduralMemory>(KV.procedural(agentId));
}

export async function proceduralSearch(kv: StateKV, agentId: string, query: string, limit: number = 10): Promise<ProceduralMemory[]> {
	const all = await kv.list<ProceduralMemory>(KV.procedural(agentId));
	const q = query.toLowerCase();
	const terms = q.split(/\s+/).filter(t => t.length > 1);
	return all
		.map(p => {
			const text = `${p.title} ${p.steps.join(' ')} ${p.tags.join(' ')}`.toLowerCase();
			const matchCount = terms.filter(t => text.includes(t)).length;
			if (matchCount === 0) return null;
			return { entry: p, score: (matchCount / terms.length) * p.confidence };
		})
		.filter((x): x is NonNullable<typeof x> => x !== null)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(x => x.entry);
}

// ─── Insight（独立 KV scope mem:insights）───────────────────────────────

export async function insightSave(kv: StateKV, agentId: string, content: string, confidence: number = 0.6, sourceMemoryIds: string[] = [], tags: string[] = [], project?: string): Promise<string> {
	if (!content?.trim()) return '';
	const id = generateId('ins');
	const now = new Date().toISOString();
	const entry: Insight = {
		id, createdAt: now, content: content.trim(),
		confidence, sourceMemoryIds, tags, project, agentId,
	};
	await kv.set(KV.insights(agentId), id, entry);
	return id;
}

export async function insightList(kv: StateKV, agentId: string): Promise<Insight[]> {
	return kv.list<Insight>(KV.insights(agentId));
}

// ─── Session Summary（独立 KV scope mem:summaries）──────────────────────

export async function sessionSummarySave(kv: StateKV, agentId: string, sessionId: string, project: string, title: string, narrative: string, keyDecisions: string[] = [], filesModified: string[] = [], concepts: string[] = [], observationCount: number = 0): Promise<string> {
	const key = sessionId || generateId('sess');
	const now = new Date().toISOString();
	const entry: SessionSummary = {
		sessionId: key, project, createdAt: now,
		title, narrative, keyDecisions, filesModified, concepts,
		observationCount, agentId,
	};
	await kv.set(KV.summaries(agentId), key, entry);
	return key;
}

export async function sessionSummaryList(kv: StateKV, agentId: string): Promise<SessionSummary[]> {
	const all = await kv.list<SessionSummary>(KV.summaries(agentId));
	return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ─── Cross-type consolidation（episodic → semantic / procedural）────────

export async function consolidateToSemantic(kv: StateKV, agentId: string, sourceMemoryIds: string[], mergedContent: string, confidence: number = 0.7): Promise<string> {
	return semanticSave(kv, agentId, mergedContent, confidence, sourceMemoryIds, ['consolidated'], undefined);
}

export async function consolidateToProcedural(kv: StateKV, agentId: string, sourceMemoryIds: string[], title: string, steps: string[], confidence: number = 0.7): Promise<string> {
	// 从 source memories 提取 concepts 作为 tags
	const sourceMems: Memory[] = [];
	for (const id of sourceMemoryIds) {
		const m = await kv.get<Memory>(KV.memories(agentId), id);
		if (m) sourceMems.push(m);
	}
	const tags = Array.from(new Set(sourceMems.flatMap(m => m.concepts))).slice(0, 10);
	return proceduralSave(kv, agentId, title, steps, [], '', confidence, tags, undefined);
}

// ─── Evict ──────────────────────────────────────────────────────────────

export async function evict(kv: StateKV, agentId: string, dryRun: boolean = false): Promise<{ expiredMemories: number; nonLatest: number; lowImportance: number }> {
	const now = Date.now();
	const stats = { expiredMemories: 0, nonLatest: 0, lowImportance: 0 };
	const memories = await kv.list<Memory>(KV.memories(agentId));
	for (const mem of memories) {
		if (mem.forgetAfter && now > new Date(mem.forgetAfter).getTime()) {
			stats.expiredMemories++;
			if (!dryRun) { await kv.delete(KV.memories(agentId), mem.id); await deleteAccessLog(kv, agentId, mem.id); }
			continue;
		}
		if (mem.isLatest === false && (now - new Date(mem.createdAt).getTime()) > 90 * MS_PER_DAY) {
			stats.nonLatest++;
			if (!dryRun) { await kv.delete(KV.memories(agentId), mem.id); await deleteAccessLog(kv, agentId, mem.id); }
			continue;
		}
		if (mem.strength <= 2 && (now - new Date(mem.createdAt).getTime()) > 90 * MS_PER_DAY) {
			stats.lowImportance++;
			if (!dryRun) { await kv.delete(KV.memories(agentId), mem.id); await deleteAccessLog(kv, agentId, mem.id); }
		}
	}
	return stats;
}

// ─── Forget / Reinforce ────────────────────────────────────────────────

export async function forgetMemory(kv: StateKV, agentId: string, memId: string): Promise<boolean> {
	const mem = await kv.get<Memory>(KV.memories(agentId), memId);
	if (!mem) return false;
	mem.isLatest = false;
	mem.updatedAt = new Date().toISOString();
	await kv.set(KV.memories(agentId), memId, mem);
	return true;
}

export async function reinforceMemory(kv: StateKV, agentId: string, memId: string): Promise<boolean> {
	const mem = await kv.get<Memory>(KV.memories(agentId), memId);
	if (!mem) return false;
	mem.strength = Math.min(10, mem.strength + 1);
	mem.updatedAt = new Date().toISOString();
	await kv.set(KV.memories(agentId), memId, mem);
	await recordAccess(kv, agentId, memId);
	return true;
}

// ─── IMemoryProvider 兼容入口 ──────────────────────────────────────────

export async function writeMemory(
	kv: StateKV, agentId: string,
	entry: { id?: string; type: string; content: string; metadata?: Record<string, unknown> },
): Promise<boolean> {
	if (!entry.content?.trim()) return false;
	const slotId = entry.metadata?.['slot_id'] as string | undefined;
	if (slotId) { await coreAdd(kv, agentId, entry.content, undefined, true); return true; }
	// working / short_term → Core Memory
	if (entry.type === 'working' || entry.type === 'short_term') {
		await coreAdd(kv, agentId, entry.content, entry.metadata?.['importance'] as number | undefined, entry.metadata?.['pinned'] as boolean | undefined);
		return true;
	}
	// 其余所有类型 → episodic Memory scope（保持 agentmemory 原生 type 不变）
	const result = await remember(kv, agentId, entry.content, entry.type as Memory['type'],
		entry.metadata?.['concepts'] as string[] | undefined,
		entry.metadata?.['files'] as string[] | undefined,
		entry.metadata?.['ttlDays'] as number | undefined,
		entry.metadata?.['project'] as string | undefined,
		entry.id);
	return result.success;
}

export async function loadContextFn(
	kv: StateKV, agentId: string, sessionId: string, query?: string, tokenBudget: number = 2000,
): Promise<IMemoryContext> {
	if (query && query.trim().length > 0) {
		const results = await searchMemories(kv, agentId, query, 10);
		const coreEntries = await kv.list<CoreMemoryEntry>(KV.coreMemory(agentId));
		const topShort: IMemoryEntry[] = coreEntries.slice(0, 15).map(e => ({
			id: e.id, type: 'working', content: e.content,
			metadata: { pinned: e.pinned, importance: e.importance },
			timestamp: new Date(e.createdAt).getTime(), importance: e.importance,
		}));
		const longTermMemories: IMemoryEntry[] = results.map(r => ({
			id: r.id, type: (r as any).type || 'fact', content: r.content, metadata: { score: r.score, source: r.source },
		}));
		const workingContext = await buildWorkingContext(kv, agentId, tokenBudget);
		const systemPrompt = `<agentmemory-context agent="${agentId}">\n${workingContext}\n\n## Search Results\n${results.map((r, i) => `[${i + 1}] ${r.content.slice(0, 200)}`).join('\n')}\n</agentmemory-context>`;
		return { shortTermMemories: topShort, longTermMemories, systemPrompt, relevantDocuments: [] };
	}
	return buildContext(kv, agentId, sessionId, agentId, tokenBudget);
}

export async function searchMemoryFn(kv: StateKV, agentId: string, query: string, limit?: number): Promise<IMemoryEntry[]> {
	const results = await searchMemories(kv, agentId, query, limit ?? 10);
	// 从 KV 回查原始 Memory 获取原生 type，不做映射
	const mapped = await Promise.all(results.map(async r => {
		let memType: string = 'fact';
		try {
			const mem = await kv.get<Memory>(KV.memories(agentId), r.id);
			if (mem) memType = mem.type;
		} catch { /* use default */ }
		return {
			id: r.id, type: memType, content: r.content,
			metadata: { score: r.score, source: r.source },
		} as IMemoryEntry;
	}));
	return mapped;
}

/** G12 recallFormatted：对齐 builtinToolProvider line 1665，返回格式化文本 + 元数据 */
export async function recallFormatted(kv: StateKV, agentId: string, query: string, tokenBudget: number): Promise<Array<{ id: string; content: string; score: number; type: string; metadata?: Record<string, unknown> }>> {
	const results = await searchMemories(kv, agentId, query, 10);
	return results.map(r => ({
		id: r.id,
		content: r.content,
		score: r.score,
		type: (r as any).type || 'fact',
		metadata: { source: r.source, concepts: (r as any).concepts, strength: (r as any).strength },
	}));
}

export async function getStatsFn(kv: StateKV, agentId: string): Promise<Record<string, number>> {
	const [memories, coreEntries, lessons] = await Promise.all([
		kv.list<Memory>(KV.memories(agentId)),
		kv.list<CoreMemoryEntry>(KV.coreMemory(agentId)),
		kv.list<Lesson>(KV.lessons(agentId)),
	]);
	return {
		longTermCount: memories.filter(m => m.isLatest !== false).length,
		coreMemoryCount: coreEntries.length,
		lessonsCount: lessons.filter(l => !l.deleted).length,
	};

}

export async function removeAgentFn(kv: StateKV, agentId: string): Promise<void> {
	await Promise.all([
		kv.clearScope(KV.memories(agentId)),
		kv.clearScope(KV.coreMemory(agentId)),
		kv.clearScope(KV.lessons(agentId)),
		kv.clearScope(KV.summaries(agentId)),
		kv.clearScope(KV.accessLog(agentId)),
		kv.clearScope(KV.retentionScores(agentId)),
		kv.clearScope(KV.sessions(agentId)),
		kv.clearScope(KV.slots(agentId)),
		kv.clearScope(KV.profiles(agentId)),
		kv.clearScope(KV.semantic(agentId)),
		kv.clearScope(KV.procedural(agentId)),
		kv.clearScope(KV.insights(agentId)),
	]);
}

// ─── Observe ────────────────────────────────────────────────────────────
// Observation / ObservationPayload 类型定义在 amTypes.ts

/** 观测写入 — 对齐 agentmemory observe.ts，写入 per-session KV scope */
export async function observe(
	kv: StateKV, agentId: string, payload: ObservationPayload,
): Promise<{ success: boolean; observationId?: string; error?: string }> {
	if (!payload.sessionId || !payload.hookType || !payload.timestamp) {
		return { success: false, error: 'Invalid payload: sessionId, hookType, timestamp required' };
	}
	const id = generateId('obs');
	const now = new Date().toISOString();
	const obs: Observation = {
		id,
		sessionId: payload.sessionId,
		hookType: payload.hookType,
		timestamp: payload.timestamp,
		data: payload.data ?? {},
		createdAt: now,
		agentId: payload.agentId || agentId,
	};
	try {
		await kv.set(KV.observations(agentId, payload.sessionId), id, obs);
		// 检查是否达到压缩阈值（fire-and-forget，不阻塞 observe 返回）
		const { maybeCompressSession } = await import('./amCompress.js');
		maybeCompressSession(kv, agentId, payload.sessionId, (payload as any).project).catch(() => {});
		return { success: true, observationId: id };
	} catch (e: any) {
		return { success: false, error: e?.message ?? 'persist failed' };
	}
}

/** 获取 session 的观测列表 */
export async function observeList(
	kv: StateKV, agentId: string, sessionId: string,
): Promise<Observation[]> {
	try {
		return await kv.list<Observation>(KV.observations(agentId, sessionId));
	} catch {
		return [];
	}
}

/** 获取 session 的观测计数 */
export async function observeCount(
	kv: StateKV, agentId: string, sessionId: string,
): Promise<number> {
	try {
		const obs = await kv.list<Observation>(KV.observations(agentId, sessionId));
		return obs.length;
	} catch {
		return 0;
	}
}
