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
	Lesson, SessionSummary, SessionRecord, AccessLog, RetentionScore,
	ContextBlock, SearchResult, IMemoryEntry, IMemoryContext,
	Observation, ObservationPayload,
	SemanticMemory, ProceduralMemory, Insight,
} from './amTypes.js';
import { KV, generateId, fingerprintId, jaccardSimilarity, estimateTokens } from './amSchema.js';
import { StateKV } from './stateKV.js';
import { getProfile } from './amPipeline.js';
import { listPinnedSlots, renderPinnedContext } from './amSlots.js';
import { cascadeUpdate } from './amFinal.js';

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
// 2026-07-25 P1 并发安全：getter 改为 agent 感知（按 agentId 返回对应索引）。
// 此前宿主经「模块级 currentAgent 可变字段 + 零参 getter」传递 agent 身份，
// 多 agent 并发调用时互相覆盖（跨 agent 召回泄漏）。零参旧式 getter 仍兼容
// （TS 允许少参函数赋值给多参签名），但新接入方应使用 agentId 参数。
let _getBM25Index: ((agentId: string) => BM25Like | null) | undefined;
let _getVectorIndex: ((agentId: string) => VectorLike | null) | undefined;
export function setIndexGetters(
	bm25Fn: (agentId: string) => BM25Like | null,
	vecFn: (agentId: string) => VectorLike | null,
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
	const normalized = content.trim();
	// M1（2026-07-26 §16）：相似度去重——完全相同跳过；Jaccard ≥0.85 替换旧条目。
	// 此前 type=working/short_term 写入经此路径无条件追加（与 remember 的 Jaccard
	// 路径不对称），子代理 memory_remember 滥用时 core memory 被洪泛（单任务 93 条）。
	// core scope 体量小（工作记忆，通常 <100 条），全量扫描成本可接受。
	// 注意：用完整 token 集的局部 Jaccard——amSchema.jaccardSimilarity 会丢弃
	// ≤2 字符 token（编号），对仅编号不同的短工作记忆（"Core 1"/"Core 2"）
	// 会误判为完全相同（1.0）而错误合并。
	const tokenize = (s: string) => new Set(s.toLowerCase().split(/\s+/).filter(t => t.length > 0));
	const jaccard = (a: string, b: string): number => {
		const A = tokenize(a); const B = tokenize(b);
		let inter = 0;
		for (const t of A) { if (B.has(t)) { inter++; } }
		const union = A.size + B.size - inter;
		return union === 0 ? 1 : inter / union;
	};
	const existing = await kv.list<CoreMemoryEntry>(KV.coreMemory(agentId));
	for (const e of existing) {
		if (e.content === normalized) { return e.id; }
	}
	for (const e of existing) {
		if (jaccard(normalized, e.content) >= 0.85) {
			e.content = normalized;
			e.importance = Math.min(10, Math.max(1, importance ?? e.importance));
			if (pinned !== undefined) { e.pinned = pinned; }
			e.lastAccessedAt = new Date().toISOString();
			await kv.set(KV.coreMemory(agentId), e.id, e);
			return e.id;
		}
	}
	const id = generateId('core');
	const now = new Date().toISOString();
	const entry: CoreMemoryEntry = {
		id, content: normalized,
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

// ─── 记忆列表缓存（P0 修复网关假死）────────────────────────────────────────
// 根因：remember() 每次写入都 kv.list(全部记忆) 做同步 JSON.parse + Jaccard 扫描，
// 记忆量增长后单次写入阻塞网关事件循环数秒，子代理写入洪峰时请求超时(5s)、
// 代理误判"网关死了"并静默丢弃写入（2026-07-25 线上日志证实）。
// 修复：进程内 per-agent 写穿缓存 + 5s TTL。缓存仅供 Jaccard 去重/冲突扫描使用
// （启发式，容忍秒级陈旧）；search/recall/loadContext 等读取路径仍直连 KV 不走缓存。
const MEM_LIST_TTL_MS = 5000;
const _memListCache = new Map<string, { at: number; list: Memory[] }>();

async function listMemoriesCached(kv: StateKV, agentId: string): Promise<Memory[]> {
	const c = _memListCache.get(agentId);
	if (c && Date.now() - c.at < MEM_LIST_TTL_MS) { return c.list; }
	const list = await kv.list<Memory>(KV.memories(agentId));
	_memListCache.set(agentId, { at: Date.now(), list });
	return list;
}

/** 写入后同步缓存（write-through），保证紧接着的写入能看到刚写入的条目 */
function memCachePut(agentId: string, mem: Memory): void {
	const c = _memListCache.get(agentId);
	if (!c) { return; }
	const idx = c.list.findIndex(m => m.id === mem.id);
	if (idx >= 0) { c.list[idx] = mem; } else { c.list.push(mem); }
}

export async function remember(
	kv: StateKV, agentId: string,
	content: string, type?: Memory['type'], concepts?: string[], files?: string[],
	ttlDays?: number, project?: string, idOverride?: string,
): Promise<{ success: boolean; id?: string; action?: string; error?: string }> {
	if (!content?.trim()) return { success: false, error: 'content is required' };
	// agentmemory 原生类型原样落库——不再做 4-Tier→fact 的坍缩/路由；仅空值兜底 fact。
	const memType = (type && type.trim()) ? type : 'fact';
	const now = new Date().toISOString();
	const ttl = ttlDays ? new Date(Date.now() + ttlDays * MS_PER_DAY).toISOString() : undefined;

	// P18: 指纹去重（对齐 agentmemory fingerprintId 检查）
	const fpId = fingerprintId('mem', content.trim());
	const fpExisting = await kv.get<Memory>(KV.memories(agentId), fpId);
	if (fpExisting && fpExisting.isLatest !== false) {
		return { success: true, id: fpId, action: 'deduplicated' };
	}

	// Jaccard 冲突检测（> 0.7 阈值，对齐 agentmemory remember.ts:81）
	const existing = await listMemoriesCached(kv, agentId);
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
	memCachePut(agentId, mem); // 写穿缓存：紧接的写入立即可见本条目
	// 接入 cascade：supersede 传播 —— 旧版本被替代后，把引用它的 state entries
	// （actions/sketches/快照等）标记为 stale，防止下游继续消费过时结论。
	// 失败不阻断主写入路径。
	if (supersededId) {
		try {
			await cascadeUpdate(kv, agentId, supersededId);
		} catch { /* cascade 失败不影响 remember 结果 */ }
	}
	return { success: true, id, action: supersededId ? 'superseded' : 'created' };
}

// ─── Search ─────────────────────────────────────────────────────────────

const RRF_K = 60;
const HYBRID_BM25_WEIGHT = 0.4;
const HYBRID_VECTOR_WEIGHT = 0.6;
/** Graph 流默认权重（对齐原版 AGENTMEMORY_GRAPH_WEIGHT=0.3） */
const GRAPH_WEIGHT_DEFAULT = 0.3;
/** rerank 窗口（对齐原版 RERANK 窗口 20） */
const RERANK_WINDOW = 20;
/** diversifyBySession 每会话上限（对齐原版 smart-search 的 ≤3/session） */
const DIVERSIFY_MAX_PER_SESSION = 3;

/** Graph 流权重：AGENTMEMORY_GRAPH_WEIGHT 覆盖（=0 关闭 graph 流） */
function graphStreamWeight(): number {
	try {
		const raw = typeof process !== 'undefined' ? process.env['AGENTMEMORY_GRAPH_WEIGHT'] : undefined;
		if (raw === undefined) { return GRAPH_WEIGHT_DEFAULT; }
		const w = Number(raw);
		return Number.isFinite(w) && w > 0 ? w : 0;
	} catch { return GRAPH_WEIGHT_DEFAULT; }
}

/** rerank 门控（默认开；AGENTMEMORY_RERANK=false 关闭）。
 *  默认用 rerankSimple（确定性关键词覆盖，零依赖）——网关无 xenova 时
 *  原版 rerank() 会降级为原始顺序，rerankSimple 是严格更优的确定性回退。 */
function isRerankEnabled(): boolean {
	try { return (typeof process !== 'undefined' ? process.env['AGENTMEMORY_RERANK'] : undefined) !== 'false'; } catch { return true; }
}

/** diversifyBySession（对齐原版 hybrid-search.ts:106-148，≤3/session）。
 *  sessionIds 缺失的条目按自身 id 独立成桶（remember 写入的记忆无会话归属，
 *  不应互相挤占名额——否则会误伤全局记忆召回）。 */
function diversifyBySession(results: SearchResult[], maxPerSession: number = DIVERSIFY_MAX_PER_SESSION): SearchResult[] {
	const counts = new Map<string, number>();
	return results.filter(r => {
		const sid = r.sessionIds?.[0] ?? r.id;
		const n = counts.get(sid) ?? 0;
		if (n >= maxPerSession) { return false; }
		counts.set(sid, n + 1);
		return true;
	});
}

export async function searchMemories(kv: StateKV, agentId: string, query: string, limit: number = 10): Promise<SearchResult[]> {
	if (!query?.trim()) {
		return fallbackKVRecall(kv, agentId, limit);
	}

	const bm25 = _getBM25Index?.(agentId);
	const vec = _getVectorIndex?.(agentId);
	const fetchDepth = Math.max(limit * 3, RERANK_WINDOW);

	// 三路召回并行（对齐原版 hybrid-search.tripleStreamSearch：BM25 + Vector + Graph）
	const [bm25Hits, vectorHits, graphHits] = await Promise.all([
		Promise.resolve(bm25 ? bm25.search(query, fetchDepth) : []).catch(() => [] as Array<{ id: string; score: number }>),
		Promise.resolve(vec && vec.available ? vec.search(query, fetchDepth) : []).catch(() => [] as Array<{ id: string; score: number }>),
		(async (): Promise<Array<{ id: string; score: number }>> => {
			if (graphStreamWeight() <= 0) { return []; }
			try {
				// 动态导入避免模块环（amPipeline → amFunctions）。空图谱返回空。
				const { graphQuery } = await import('./amPipeline.js');
				return graphQuery(agentId, query, 2, fetchDepth).map(r => ({ id: r.obsId, score: r.score }));
			} catch { return []; }
		})(),
	]);

	const bm25Results = new Map<string, number>();
	for (const r of bm25Hits) { bm25Results.set(r.id, r.score); }
	const vectorResults = new Map<string, number>();
	for (const r of vectorHits) { vectorResults.set(r.id, r.score); }
	const graphResults = new Map<string, number>();
	for (const r of graphHits) { graphResults.set(r.id, r.score); }

	// RRF 三流融合（对齐原版：有效权重按可用流动态确定）
	const hasVector = vectorResults.size > 0;
	const hasGraph = graphResults.size > 0;
	const allIds = new Set([...bm25Results.keys(), ...vectorResults.keys(), ...graphResults.keys()]);
	const combined: Array<{ id: string; score: number }> = [];

	let effectiveBm25W = HYBRID_BM25_WEIGHT;
	let effectiveVectorW = hasVector ? HYBRID_VECTOR_WEIGHT : 0;
	let effectiveGraphW = hasGraph ? graphStreamWeight() : 0;
	const totalW = effectiveBm25W + effectiveVectorW + effectiveGraphW;
	if (totalW > 0) { effectiveBm25W /= totalW; effectiveVectorW /= totalW; effectiveGraphW /= totalW; }

	const bm25Ranked = Array.from(bm25Results.entries()).sort((a, b) => b[1] - a[1]);
	const vectorRanked = Array.from(vectorResults.entries()).sort((a, b) => b[1] - a[1]);
	const graphRanked = Array.from(graphResults.entries()).sort((a, b) => b[1] - a[1]);

	for (const id of allIds) {
		const bIdx = bm25Ranked.findIndex(([i]) => i === id);
		const vIdx = vectorRanked.findIndex(([i]) => i === id);
		const gIdx = graphRanked.findIndex(([i]) => i === id);
		const score =
			(bIdx >= 0 ? effectiveBm25W / (RRF_K + bIdx + 1) : 0) +
			(vIdx >= 0 ? effectiveVectorW / (RRF_K + vIdx + 1) : 0) +
			(gIdx >= 0 ? effectiveGraphW / (RRF_K + gIdx + 1) : 0);
		combined.push({ id, score });
	}
	combined.sort((a, b) => b.score - a.score);

	// KV 回填（取 rerank 窗口深度，附 sessionIds 供 diversify）
	const candidates = combined.slice(0, Math.max(limit, RERANK_WINDOW));
	const backfilled: SearchResult[] = [];
	for (const c of candidates) {
		try {
			const mem = await kv.get<Memory>(KV.memories(agentId), c.id);
			if (mem && mem.isLatest !== false) {
				backfilled.push({
					id: mem.id, content: mem.content, score: c.score,
					source: hasVector || hasGraph ? 'hybrid' : 'bm25',
					sessionIds: mem.sessionIds,
				});
			}
		} catch { /* skip missing */ }
	}

	// 会话去集中化（G3，对齐原版 ≤3/session）
	const diversified = diversifyBySession(backfilled);

	// rerank（G2）：rerankSimple 确定性回退接 top-20 窗口（AGENTMEMORY_RERANK=false 关闭）
	let ranked = diversified;
	if (isRerankEnabled() && diversified.length > 1) {
		const { rerankSimple } = await import('./reranker.js');
		const reranked = rerankSimple(query, diversified.map(r => ({ id: r.id, content: r.content, combinedScore: r.score })), RERANK_WINDOW);
		const byId = new Map(diversified.map(r => [r.id, r]));
		ranked = reranked.map(rr => ({ ...byId.get(rr.id)!, score: rr.rerankScore }));
	}

	const results = ranked.slice(0, limit);
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

/** XML 属性转义（对齐原版 context.ts escapeXmlAttr） */
function escapeXmlAttr(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

export async function buildContext(
	kv: StateKV, agentId: string, sessionId: string, project: string, tokenBudget: number,
	query?: string, options?: { includeEntries?: boolean },
): Promise<IMemoryContext> {
	const blocks: ContextBlock[] = [];
	const nowMs = Date.now();

	// ── 注入组装 1:1 对齐 agentmemory mem::context（functions/context.ts）──
	// 块序列：pinned slots → project profile → lessons → session summaries →
	// 重要观察（无摘要会话的近期观察）→ 全局 recency 排序 → 预算填充。
	// 原版不注入原始长期记忆/核心记忆（召回全走工具）——memories 与 core
	// 仅放进返回值供 UI/其他消费者使用，不进注入文本。

	// Pinned slots（recency=now 使其排序后自然靠前，与原版一致）
	const pinnedSlots = await listPinnedSlots(kv, agentId);
	const slotContent = renderPinnedContext(pinnedSlots);
	if (slotContent) {
		blocks.push({ type: 'slot', content: slotContent, tokens: estimateTokens(slotContent), recency: nowMs, sourceIds: pinnedSlots.map(s => s.label) });
	}

	// Project Profile
	const profile = await getProfile(kv, agentId);
	if (profile) {
		const parts: string[] = [];
		if (profile.topConcepts?.length > 0) parts.push(`Concepts: ${profile.topConcepts.slice(0, 8).map(c => c.concept).join(', ')}`);
		if (profile.topFiles?.length > 0) parts.push(`Key files: ${profile.topFiles.slice(0, 5).map(f => f.file).join(', ')}`);
		if (profile.conventions?.length > 0) parts.push(`Conventions: ${profile.conventions.join('; ')}`);
		if (profile.commonErrors?.length > 0) parts.push(`Common errors: ${profile.commonErrors.slice(0, 3).join('; ')}`);
		if (parts.length > 0) {
			const content = `## Project Profile\n${parts.join('\n')}`;
			blocks.push({ type: 'slot', content, tokens: estimateTokens(content), recency: nowMs });
		}
	}

	// Lessons（project 作用域 ×1.5 加权，confidence 排序，top 10）
	const lessons = await kv.list<Lesson>(KV.lessons(agentId));
	const relevantLessons = lessons.filter(l => !l.deleted && l.confidence >= 0.1)
		.sort((a, b) => ((b.project === project ? 1.5 : 1) * b.confidence) - ((a.project === project ? 1.5 : 1) * a.confidence))
		.slice(0, 10);
	if (relevantLessons.length > 0) {
		const items = relevantLessons.map(l => `- (${l.confidence.toFixed(2)}) ${l.content}${l.context ? ` — ${l.context}` : ''}`).join('\n');
		const content = `## Lessons Learned\n${items}`;
		const mostRecent = relevantLessons.reduce((acc, l) => {
			const t = new Date(l.lastReinforcedAt || l.updatedAt).getTime();
			return t > acc ? t : acc;
		}, 0);
		blocks.push({ type: 'lesson', content, tokens: estimateTokens(content), recency: mostRecent, sourceIds: relevantLessons.map(l => l.id) });
	}

	// Session summaries（最近 10 个会话，排除当前）
	// D1 防御（doc §13）：过滤非 SessionSummary 条目——历史版本 teamShare 曾把
	// TeamSharedItem 误存进 summaries scope（无 narrative/keyDecisions 字段），
	// 直接渲染会产出 "undefined" 畸形行；迁移由 runMaintenanceSweep 一次性完成。
	const summaries = (await kv.list<SessionSummary>(KV.summaries(agentId)))
		.filter(s => typeof s.narrative === 'string' && Array.isArray(s.keyDecisions));
	const summarizedSessionIds = new Set(summaries.map(s => s.sessionId));
	for (const s of summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10)) {
		const content = `## ${s.title}\n${s.narrative}\nDecisions: ${s.keyDecisions.join('; ')}\nFiles: ${s.filesModified.join(', ')}`;
		blocks.push({ type: 'summary', content, tokens: estimateTokens(content), recency: new Date(s.createdAt).getTime() });
	}

	// 重要观察（对齐原版：无摘要会话的近期观察，每会话取最近 3 条）
	const sessions = await kv.list<{ id: string; startedAt: string }>(KV.sessions(agentId));
	const recentUnsummarized = sessions
		.filter(s => s.id !== sessionId && !summarizedSessionIds.has(s.id))
		.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
		.slice(0, 5);
	// 并行加载各会话观察（对齐原版 Promise.all；此前串行 await 在 SQLite 后端下放大延迟）
	const obsLists = await Promise.all(
		recentUnsummarized.map(sess =>
			kv.list<Observation>(KV.observations(agentId, sess.id)).catch(() => [] as Observation[])),
	);
	for (let i = 0; i < recentUnsummarized.length; i++) {
		const sess = recentUnsummarized[i];
		const observations = obsLists[i];
		if (observations.length === 0) { continue; }
		// 对齐原版 context.ts:204-215：仅选 title 非空 && importance≥5 的「重要观察」，
		// 按 importance 降序（并列按时间倒序）取 top5/会话。
		// 旧条目缺字段时按同一启发式回退派生，保证向后兼容。
		const important = observations.filter(o => {
			const imp = o.importance ?? observationImportance(o.hookType, o.data);
			const title = o.title ?? observationTitle(o.hookType, o.data);
			return title.length > 0 && imp >= 5;
		});
		if (important.length === 0) { continue; }
		const top = important.sort((a, b) => {
			const di = (b.importance ?? 0) - (a.importance ?? 0);
			return di !== 0 ? di : b.timestamp.localeCompare(a.timestamp);
		}).slice(0, 5);
		const items = top.map(o => {
			const title = o.title ?? observationTitle(o.hookType, o.data);
			const d = o.data as Record<string, unknown> | undefined;
			const preview = String(d?.['content'] ?? d?.['tool_output'] ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
			return `- [${o.hookType}] ${title}: ${preview}`;
		}).filter(line => line.length > 12).join('\n');
		if (items) {
			const content = `## Session ${sess.id.slice(0, 8)} (${sess.startedAt.slice(0, 10)})\n${items}`;
			blocks.push({ type: 'observation', content, tokens: estimateTokens(content), recency: new Date(top[0].timestamp).getTime(), sourceIds: top.map(o => o.id) });
		}
	}

	// Reusable Routines（可复用工作流，取最近更新的 top 3，注入供 agent 直接复用）
	try {
		const procEntries = await kv.list<any>(KV.procedural(agentId));
		const routines = procEntries.filter((r: any) => r.id?.startsWith('rtn'))
			.sort((a: any, b: any) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))).slice(0, 3);
		if (routines.length > 0) {
			const lines = routines.map((r: any) => `- ${r.name}: ${(r.steps ?? []).map((s: any) => s.title).join(' → ')}`);
			const content = `## Reusable Routines\n${lines.join('\n')}`;
			blocks.push({ type: 'routine', content, tokens: estimateTokens(content), recency: Date.parse(String(routines[0].updatedAt ?? '')) || nowMs, sourceIds: routines.map((r: any) => r.id) });
		}
	} catch { /* routines 注入失败不阻断策展 */ }

	// Recent Workflow Crystals（近期已完成工作链结晶，取 top 3）
	try {
		const crystals = (await kv.list<any>(KV.crystals(agentId)))
			.sort((a: any, b: any) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))).slice(0, 3);
		if (crystals.length > 0) {
			const lines = crystals.map((c: any) => `- ${String(c.narrative ?? '').slice(0, 120)}`);
			const content = `## Recent Workflow Crystals\n${lines.join('\n')}`;
			blocks.push({ type: 'crystal', content, tokens: estimateTokens(content), recency: Date.parse(String(crystals[0].createdAt ?? '')) || nowMs, sourceIds: crystals.map((c: any) => c.id) });
		}
	} catch { /* crystals 注入失败不阻断策展 */ }

	// Query 相关召回块（2026-07-25 P0：注入=策展为主、搜索为辅）——
	// 此前 loadContextFn 的 query 分支用「混合搜索 + buildWorkingContext 全量倾倒」
	// 替代整个策展，此处将 query 召回降为 ≤30% 预算的附加块（recency=now 自然靠前）。
	// 全量召回仍走 memory_search/memory_recall 工具（原版 mem::search 工具驱动姿态）。
	if (query && query.trim().length > 0) {
		try {
			const results = await searchMemories(kv, agentId, query, 10);
			const searchBudget = Math.floor(tokenBudget * 0.3);
			let searchTokens = 0;
			const lines: string[] = [];
			for (const r of results) {
				const line = `[${lines.length + 1}] ${r.content.slice(0, 200)}`;
				const t = estimateTokens(line);
				if (searchTokens + t > searchBudget) { continue; }
				lines.push(line); searchTokens += t;
			}
			if (lines.length > 0) {
				const content = `## Relevant Memories\n${lines.join('\n')}`;
				// 不传 sourceIds——searchMemories 内部已 recordAccessBatch，避免重复计数
				blocks.push({ type: 'memory', content, tokens: estimateTokens(content), recency: nowMs });
			}
		} catch { /* 搜索失败不阻断策展注入 */ }
	}

	// 全局 recency 排序（原版 context.ts:234 —— 最新块优先占用预算）
	blocks.sort((a, b) => b.recency - a.recency);

	// 预算填充（header/footer 计入预算，对齐原版 context.ts:241）
	const header = `<agentmemory-context project="${escapeXmlAttr(project)}">`;
	const footer = `</agentmemory-context>`;
	let usedTokens = estimateTokens(header) + estimateTokens(footer);
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
	const systemPrompt = selected.length > 0 ? `${header}\n${selected.join('\n\n')}\n${footer}` : '';

	// 返回值中的长期/短期记忆数组仅供 UI 与其他消费者（不进注入文本）。
	// includeEntries=false 时跳过两次全表 list——注入路径不需要这些数组
	// （SQLite 后端下全表 list + JSON.parse 会同步阻塞网关事件循环）。
	const includeEntries = options?.includeEntries !== false;
	let longTermMemories: IMemoryEntry[] = [];
	let shortTermMemories: IMemoryEntry[] = [];
	if (includeEntries) {
		const coreEntries = await kv.list<CoreMemoryEntry>(KV.coreMemory(agentId));
		const memories = await kv.list<Memory>(KV.memories(agentId));
		const active = memories.filter(m => m.isLatest !== false).sort((a, b) => b.strength - a.strength);
		longTermMemories = active.slice(0, 10).map(m => ({
			id: m.id, type: m.type, content: m.content,
			metadata: { concepts: m.concepts, files: m.files, strength: m.strength },
			timestamp: new Date(m.createdAt).getTime(), importance: m.strength,
		}));
		shortTermMemories = coreEntries.slice(0, 15).map(e => ({
			id: e.id, type: 'working', content: e.content,
			metadata: { pinned: e.pinned, importance: e.importance },
			timestamp: new Date(e.createdAt).getTime(), importance: e.importance,
		}));
	}
	return { shortTermMemories, longTermMemories, systemPrompt, relevantDocuments: [], contextBlocks: selected.length, contextTokens: usedTokens };
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
	memCachePut(agentId, mem); // 写穿缓存同步，避免缓存消费者读到陈旧 isLatest
	return true;
}

export async function reinforceMemory(kv: StateKV, agentId: string, memId: string): Promise<boolean> {
	const mem = await kv.get<Memory>(KV.memories(agentId), memId);
	if (!mem) return false;
	mem.strength = Math.min(10, mem.strength + 1);
	mem.updatedAt = new Date().toISOString();
	await kv.set(KV.memories(agentId), memId, mem);
	memCachePut(agentId, mem); // 写穿缓存同步
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
	const importance = entry.metadata?.['importance'] as number | undefined;
	// 对齐 agentmemory 原版写入目标：
	//   mem::remember  → 只写长期层 mem:memories（原生类型）；
	//   mem::core-add  → 写 working 层 mem:core-memory；
	//   semantic/procedural 层 **不由** remember/writeMemory 写入，而是固化管线（session_end/consolidate）产出。
	// 因此此处不再有 semantic/procedural 路由。
	// working / short_term → Core Memory (mem:core-memory)（对齐 mem::core-add）
	if (entry.type === 'working' || entry.type === 'short_term') {
		await coreAdd(kv, agentId, entry.content, importance, entry.metadata?.['pinned'] as boolean | undefined);
		return true;
	}
	// 其余原生类型（pattern/preference/architecture/bug/workflow/fact）→ 长期层 KV.memories（对齐 mem::remember）
	const result = await remember(kv, agentId, entry.content, entry.type as Memory['type'],
		entry.metadata?.['concepts'] as string[] | undefined,
		entry.metadata?.['files'] as string[] | undefined,
		entry.metadata?.['ttlDays'] as number | undefined,
		entry.metadata?.['project'] as string | undefined,
		entry.id);
	return result.success;
}

/**
 * 文件相关 bug 记忆匹配（复刻原版 mem::enrich 的高价值部分 enrich.ts:bugMemories）：
 * `type=bug ∩ isLatest ∩ project 匹配 ∩ files 路径重叠`，按 updatedAt 倒序取 top N。
 * 用于「即将触碰这些文件 → 提示其历史 bug」的 volatile 注入，
 * 不复活 per-tool-call enrich（原版 #143 token 燃烧事故的教训）。
 * 走 listMemoriesCached 写穿缓存，避免每次全表 list 阻塞网关事件循环。
 */
export async function bugMemoriesForFiles(
	kv: StateKV, agentId: string, files: string[], project?: string, limit: number = 3,
): Promise<Memory[]> {
	if (!Array.isArray(files) || files.length === 0) { return []; }
	const memories = await listMemoriesCached(kv, agentId);
	return memories
		.filter(m => m.type === 'bug'
			&& m.isLatest !== false
			&& (!project || !m.project || m.project === project)
			&& Array.isArray(m.files)
			&& m.files.some(f => files.some(df => f.includes(df) || df.includes(f))))
		.sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
		.slice(0, limit);
}

export async function loadContextFn(
	kv: StateKV, agentId: string, sessionId: string, query?: string, tokenBudget: number = 2000,
	options?: { includeEntries?: boolean },
): Promise<IMemoryContext> {
	// 2026-07-25 P0 修正（doc/memory-mechanism-comparison.html §12 F1）：
	// 注入路径恒走 mem::context 策展。旧 query 分支（混合搜索 top10 +
	// buildWorkingContext 全量灌预算）已从注入路径移除——它是 MemGPT 式
	// 全量倾倒，与「注入=策展、召回=工具」的原版姿态冲突，且使精心复刻的
	// buildContext 沦为死代码（客户端注入恒传 query）。query 现作为
	// buildContext 内 ≤30% 预算的 Relevant Memories 附加块。
	return buildContext(kv, agentId, sessionId, agentId, tokenBudget, query, options);
}

export async function searchMemoryFn(kv: StateKV, agentId: string, query: string, limit?: number): Promise<IMemoryEntry[]> {
	const results = await searchMemories(kv, agentId, query, limit ?? 10);
	// 从 KV 回查原始 Memory 获取原生 type + createdAt（UI 按时间排序/展示），不做映射
	const mapped = await Promise.all(results.map(async r => {
		let memType: string = 'fact';
		let timestamp: number | undefined;
		try {
			const mem = await kv.get<Memory>(KV.memories(agentId), r.id);
			if (mem) {
				memType = mem.type;
				timestamp = Date.parse(mem.createdAt) || undefined;
			}
		} catch { /* use default */ }
		return {
			id: r.id, type: memType, content: r.content,
			timestamp,
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

/** Session 记录显式创建（对齐原版 session-start hook 的注册语义）：
 *  会话开始时注册到 KV.sessions（幂等：已存在则不动）——sessions 表是
 *  summaries 块 / 重要观察块 / 会话统计的关联键。 */
export async function sessionStart(
	kv: StateKV, agentId: string, sessionId: string,
	project?: string, cwd?: string,
): Promise<{ success: boolean; created: boolean }> {
	if (!sessionId) { return { success: false, created: false }; }
	const scope = KV.sessions(agentId);
	const existing = await kv.get(scope, sessionId);
	if (existing) { return { success: true, created: false }; }
	const now = new Date().toISOString();
	await kv.set(scope, sessionId, {
		id: sessionId,
		agentId,
		startedAt: now,
		updatedAt: now,
		status: 'active',
		observationCount: 0,
		...(project ? { project } : {}),
		...(cwd ? { cwd } : {}),
	});
	return { success: true, created: true };
}

/** 每会话观察上限（滑动窗口，对齐原版 maxObservationsPerSession 语义）：
 *  超限时淘汰最老未压缩条目；全部已压缩则淘汰最老一条。
 *  可用 AGENTMEMORY_MAX_OBS_PER_SESSION 覆盖（默认 200）。 */
function maxObservationsPerSession(): number {
	const raw = typeof process !== 'undefined' ? process.env?.['AGENTMEMORY_MAX_OBS_PER_SESSION'] : undefined;
	const n = raw ? parseInt(raw, 10) : NaN;
	return Number.isFinite(n) && n > 0 ? n : 200;
}

/** 观察重要性启发式（对齐原版 mem::context importance≥5 筛选的输入侧）：
 *  工具失败(7) > 工具使用(5) > turn 消息(4) > 生命周期事件(3)。
 *  payload.data.importance 可显式覆盖（1-10）。 */
export function observationImportance(hookType: string, data: unknown): number {
	const d = data as Record<string, unknown> | undefined;
	const explicit = typeof d?.['importance'] === 'number' ? d['importance'] as number : NaN;
	if (Number.isFinite(explicit)) { return Math.min(10, Math.max(1, explicit)); }
	switch (hookType) {
		case 'post_tool_failure': case 'tool_failure': return 7;
		case 'post_tool_use': return 5;
		case 'turn_observation': return 4;
		default: return 3;
	}
}

/** 观察标题派生：`toolName[: 文件basename]`，无工具名时取内容前 60 字符。 */
export function observationTitle(hookType: string, data: unknown): string {
	const d = data as Record<string, unknown> | undefined;
	const toolName = typeof d?.['tool_name'] === 'string' ? (d['tool_name'] as string).trim() : '';
	if (toolName) {
		const files = Array.isArray(d?.['files']) ? (d['files'] as unknown[]).filter((f): f is string => typeof f === 'string') : [];
		const base = files.length > 0 ? String(files[0]).split(/[\\/]/).pop() : '';
		return (base ? `${toolName}: ${base}` : toolName).slice(0, 80);
	}
	const content = String(d?.['content'] ?? d?.['tool_output'] ?? '').replace(/\s+/g, ' ').trim();
	return content.slice(0, 60);
}

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
		// 写入时持久化标题/重要性（buildContext 重要观察块 importance≥5 筛选的输入；
		// 旧条目缺字段时读取侧按同一启发式回退派生）
		title: observationTitle(payload.hookType, payload.data),
		importance: observationImportance(payload.hookType, payload.data),
	};
	try {
		const scope = KV.observations(agentId, payload.sessionId);
		// P1 滑动窗口：写入前若已达上限，淘汰最老未压缩条目
		const existing = await kv.list<Observation>(scope);
		const max = maxObservationsPerSession();
		if (existing.length >= max) {
			const sorted = [...existing].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
			const evictCount = existing.length - max + 1;
			const evictIds = new Set(sorted.filter(o => !(o as { compressed?: boolean }).compressed).slice(0, evictCount).map(o => o.id));
			if (evictIds.size === 0) { evictIds.add(sorted[0].id); }
			for (const evictId of evictIds) { await kv.delete(scope, evictId); }
		}
		await kv.set(scope, id, obs);
		// Session 记录注册（对齐 agentmemory observe.ts:228-281）：
		// 已存在 → 更新 updatedAt + observationCount+1（+ firstPrompt 若 payload 带 userPrompt）；
		// 不存在 → 创建（status=active）。sessions 表是 summaries/重要观察块的关联键。
		try {
			const sessionScope = KV.sessions(agentId);
			const userPrompt = typeof payload.data?.['userPrompt'] === 'string'
				? String(payload.data['userPrompt']).replace(/\s+/g, ' ').trim().slice(0, 200) : undefined;
			const existing = await kv.get<{ observationCount?: number; firstPrompt?: string }>(sessionScope, payload.sessionId);
			if (existing) {
				await kv.set(sessionScope, payload.sessionId, {
					...existing,
					updatedAt: now,
					observationCount: (existing.observationCount ?? 0) + 1,
					...((!existing.firstPrompt && userPrompt) ? { firstPrompt: userPrompt } : {}),
				});
			} else {
				await kv.set(sessionScope, payload.sessionId, {
					id: payload.sessionId,
					agentId,
					startedAt: payload.timestamp ?? now,
					updatedAt: now,
					status: 'active',
					observationCount: 1,
					...(payload.data?.['project'] ? { project: payload.data['project'] } : {}),
					...(payload.data?.['cwd'] ? { cwd: payload.data['cwd'] } : {}),
					...(userPrompt ? { firstPrompt: userPrompt } : {}),
				});
			}
		} catch { /* session 注册失败不阻断观察写入 */ }
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

/** 列出会话记录（KV.sessions，按 updatedAt desc）—— Dashboard/memoryDetail 会话面板用。 */
export async function sessionList(
	kv: StateKV, agentId: string,
): Promise<SessionRecord[]> {
	try {
		const all = await kv.list<SessionRecord>(KV.sessions(agentId));
		return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
	} catch {
		return [];
	}
}
