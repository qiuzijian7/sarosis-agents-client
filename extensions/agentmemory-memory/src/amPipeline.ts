/*---------------------------------------------------------------------------------------------
 *  AgentMemory 无状态管道函数 — V1 模块改造为 V2 纯函数
 *
 *  涵盖：
 *    1. Consolidation Pipeline
 *    2. Knowledge Graph
 *    3. Profile Builder
 *    4. Pattern Detector
 *    5. Memory Verify
 *    6. LLM Compress
 *    7. Full Sweep (auto-forget + retention + evict + consol + graph + profile)
 *--------------------------------------------------------------------------------------------*/

import type { Memory, SemanticMemory, ProceduralMemory } from './amTypes.js';
import { KV, generateId, estimateTokens } from './amSchema.js';
import { StateKV } from './stateKV.js';
import { KnowledgeGraph, type GraphRetrievalResult } from './knowledgeGraph.js';
import { PatternDetector, type PatternDetectionResult } from './patternDetector.js';
import { autoForget, retentionScore, retentionEvict, evict, lessonDecaySweep, autoPage } from './amFunctions.js';
import { compress as llmCompress, compressSynthetic } from './compressor.js';

const SEMANTIC_THRESHOLD = 5;
const CONVENTION_RE = /\b(?:we use|we should|convention is|always|never|must|should|prefer|standard|guideline)\b/gi;
const PROFILE_ERROR_RE = /\b(?:error|fail|exception|crash|bug|issue|problem)[:\s]+([^\n.]{10,80})/gi;

// ─── 1. Pattern Detection ──────────────────────────────────────────────

const _detector = new PatternDetector();

export async function detectPatterns(kv: StateKV, agentId: string): Promise<PatternDetectionResult> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const entries = memories
		.filter(m => m.isLatest !== false)
		.map(m => ({ id: m.id, content: m.content, concepts: m.concepts, files: m.files }));
	return _detector.detect(entries);
}

// ─── 2. Profile Builder ────────────────────────────────────────────────

export interface ProjectProfile {
	project: string; updatedAt: string; summary: string;
	topConcepts: Array<{ concept: string; frequency: number }>;
	topFiles: Array<{ file: string; frequency: number }>;
	conventions: string[]; commonErrors: string[];
	recentActivity: string[]; sessionCount: number; totalMemories: number;
}

export async function buildProfile(kv: StateKV, agentId: string): Promise<ProjectProfile> {
	const now = new Date().toISOString();
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const active = memories.filter(m => m.isLatest !== false);
	const patterns = await detectPatterns(kv, agentId);
	const conventions = new Set<string>();
	const errors = new Set<string>();
	for (const m of active) {
		for (const s of m.content.split(/[.\n]/)) {
			if (CONVENTION_RE.test(s) && s.trim().length > 10 && s.trim().length < 200) conventions.add(s.trim());
		}
		for (const match of m.content.matchAll(PROFILE_ERROR_RE)) errors.add(match[1].trim());
	}
	const recentActivity = [...active]
		.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
		.slice(0, 5).map(m => m.content.replace(/\s+/g, ' ').slice(0, 100));
	const profile: ProjectProfile = {
		project: agentId, updatedAt: now,
		summary: `Project: ${agentId} (${active.length} memories)`,
		topConcepts: patterns.topConcepts, topFiles: patterns.topFiles,
		conventions: [...conventions].slice(0, 10), commonErrors: [...errors].slice(0, 10),
		recentActivity, sessionCount: 0, totalMemories: active.length,
	};
	await kv.set(KV.profiles(agentId), 'current', profile);
	return profile;
}

export async function getProfile(kv: StateKV, agentId: string): Promise<ProjectProfile | null> {
	return kv.get<ProjectProfile>(KV.profiles(agentId), 'current');
}

// ─── 3. Knowledge Graph ────────────────────────────────────────────────

let _graph: KnowledgeGraph | null = null;
function getGraph(): KnowledgeGraph { if (!_graph) _graph = new KnowledgeGraph(); return _graph; }

export async function graphExtract(kv: StateKV, agentId: string, memoryId: string, content: string): Promise<void> {
	getGraph().extractFromMemory(memoryId, content, agentId);
}

export function graphQuery(agentId: string, query: string, depth = 2, limit = 10): GraphRetrievalResult[] {
	return getGraph().searchByEntities(KnowledgeGraph.extractEntityNames(query), depth, limit);
}

export function graphStats(): { nodes: number; edges: number } {
	return { nodes: getGraph().nodeCount, edges: getGraph().edgeCount };
}

/** 重置图谱单例（对齐 agentmemory mem::graph-reset：清空索引以便重建） */
export function resetGraph(): void {
	_graph = null;
}

// ─── 4. Consolidation Pipeline ──────────────────────────────────────────

interface EpisodicMemory {
	id: string; sessionId: string; title: string; narrative: string;
	keyDecisions: string[]; filesModified: string[]; concepts: string[];
	observationCount: number; createdAt: string;
}

export async function extractEpisodic(kv: StateKV, agentId: string, sessionId: string, longEntries: Memory[]): Promise<EpisodicMemory[]> {
	const now = new Date().toISOString();
	const ep: EpisodicMemory = {
		id: generateId('epi'), sessionId,
		title: longEntries.length > 0 ? longEntries[0].title : 'Session summary',
		narrative: `Session with ${longEntries.length} observations`,
		keyDecisions: longEntries.filter(m => m.type === 'architecture' || m.type === 'preference').map(m => m.content.slice(0, 100)).slice(0, 10),
		filesModified: [...new Set(longEntries.flatMap(m => m.files))].slice(0, 20),
		concepts: [...new Set(longEntries.flatMap(m => m.concepts))].slice(0, 30),
		observationCount: longEntries.length, createdAt: now,
	};
	const existing = await kv.list<EpisodicMemory>(KV.semantic(agentId));
	await kv.set(KV.semantic(agentId), 'episodic', [...existing, ep] as any);
	return [ep];
}

export async function extractSemantic(kv: StateKV, agentId: string): Promise<SemanticMemory[]> {
	const episodic = await kv.list<any>(KV.semantic(agentId));
	// 处理两种存储格式：episodic 作为一个大数组或每个 episode 独立存储
	const episodes = episodic.flatMap((e: any) => {
		if (Array.isArray(e)) return e;
		return [e];
	}).filter((e: any) => e.id?.startsWith('epi'));
	if (episodes.length < SEMANTIC_THRESHOLD) return [];
	const now = new Date().toISOString();
	const conceptFreq = new Map<string, number>();
	for (const e of episodes) for (const c of (e.concepts ?? [])) conceptFreq.set(c, (conceptFreq.get(c) ?? 0) + 1);
	const results: SemanticMemory[] = [];
	for (const [concept, freq] of conceptFreq) {
		if (freq >= 2) {
			const entry: SemanticMemory = {
				id: generateId('sem'), createdAt: now, updatedAt: now,
				content: `Pattern: ${concept} appeared ${freq}x across ${episodes.length} sessions`,
				confidence: Math.min(1, freq / episodes.length),
				accessCount: 0, sourceIds: [], tags: [concept, 'consolidated'], agentId,
			};
			await kv.set(KV.semantic(agentId), entry.id, entry);
			results.push(entry);
		}
	}
	return results;
}

export async function extractProcedural(kv: StateKV, agentId: string): Promise<ProceduralMemory[]> {
	const sem = await kv.list<SemanticMemory>(KV.semantic(agentId));
	const consolidated = sem.filter(s => s.tags?.includes('consolidated'));
	if (consolidated.length < 2) return [];
	const now = new Date().toISOString();
	const entry: ProceduralMemory = {
		id: generateId('proc'), createdAt: now, updatedAt: now,
		title: `Workflow from ${consolidated.length} semantic patterns`,
		steps: consolidated.map(s => s.content.slice(0, 100)),
		preconditions: [], expectedOutcome: 'Pattern-based workflow extracted',
		confidence: 0.7, sourceSessionIds: [], tags: consolidated.flatMap(s => s.tags), agentId,
	};
	await kv.set(KV.procedural(agentId), entry.id, entry);
	return [entry];
}

export async function runConsolidationPipeline(kv: StateKV, agentId: string, sessionId: string): Promise<{
	episodic: number; semantic: number; procedural: number;
	llm?: boolean; details?: Record<string, unknown>;
}> {
	// C1（2026-07-26 §16）：LLM 路径优先——CONSOLIDATION_ENABLED=true 且
	// LLM 已配置时走 consolidationLlm（1:1 复刻原版 mem::consolidate-pipeline
	// 的 SEMANTIC_MERGE / PROCEDURAL_EXTRACTION 提示词流程）；
	// 未启用或 LLM 失败时回退下方确定性路径。
	const { isConsolidationLlmEnabled, consolidateSemanticWithLlm, consolidateProceduralWithLlm } =
		await import('./consolidationLlm.js'); // 动态导入：LLM 路径非常用，避免冷启动加载
	if (isConsolidationLlmEnabled()) {
		const [sem, proc] = await Promise.all([
			consolidateSemanticWithLlm(kv, agentId).catch((e): Record<string, unknown> => ({ error: String(e) })),
			consolidateProceduralWithLlm(kv, agentId).catch((e): Record<string, unknown> => ({ error: String(e) })),
		]);
		const semFacts = (sem as { newFacts?: number }).newFacts ?? 0;
		const procNew = (proc as { newProcedures?: number }).newProcedures ?? 0;
		// 两层都失败（如 LLM 网关不通）→ 回退确定性路径而非空跑
		const semFailed = 'error' in sem;
		const procFailed = 'error' in proc;
		if (!(semFailed && procFailed)) {
			return { episodic: 0, semantic: semFacts, procedural: procNew, llm: true, details: { semantic: sem, procedural: proc } };
		}
	}

	const memories = await kv.list<Memory>(KV.memories(agentId));
	const active = memories.filter(m => m.isLatest !== false);
	const epi = await extractEpisodic(kv, agentId, sessionId, active);
	const sem = await extractSemantic(kv, agentId);
	const proc = await extractProcedural(kv, agentId);
	return { episodic: epi.length, semantic: sem.length, procedural: proc.length };
}

// ─── 5. Memory Verify ──────────────────────────────────────────────────

export async function verifyMemory(kv: StateKV, agentId: string, memoryId: string): Promise<{ valid: boolean; citations: string[] }> {
	const mem = await kv.get<Memory>(KV.memories(agentId), memoryId);
	if (!mem) return { valid: false, citations: [] };
	const all = await kv.list<Memory>(KV.memories(agentId));
	const related = all.filter(m => m.isLatest !== false && m.id !== memoryId && m.concepts.some(c => mem.concepts.includes(c)));
	return { valid: related.length > 0, citations: related.slice(0, 5).map(m => m.id) };
}

// ─── 6. LLM Compress ───────────────────────────────────────────────────

export async function compressMemories() {
	return async (systemPrompt: string, userPrompt: string): Promise<string> => {
		const combined = `${systemPrompt}\n\n${userPrompt}`;
		try {
			const result = await llmCompress(combined);
			return typeof result === 'string' ? result : JSON.stringify(result);
		} catch {
			const synth = compressSynthetic(combined);
			return synth.narrative || synth.title || JSON.stringify(synth);
		}
	};
}

// ─── 7. Full Sweep ─────────────────────────────────────────────────────

export async function runFullSweep(kv: StateKV, agentId: string, sessionId: string, tokenBudget: number): Promise<Record<string, unknown>> {
	const result: Record<string, unknown> = {};

	// auto-forget
	const forgetResult = await autoForget(kv, agentId, false);
	result.autoForget = { ttlExpired: forgetResult.ttlExpired.length, contradictions: forgetResult.contradictions.length };

	// retention
	const retentionResult = await retentionScore(kv, agentId);
	const evicted = await retentionEvict(kv, agentId);
	result.retention = { total: retentionResult.total, evicted, tiers: retentionResult.tiers };

	// evict
	const evictResult = await evict(kv, agentId, false);
	result.evict = evictResult;

	// consolidation
	const consolResult = await runConsolidationPipeline(kv, agentId, sessionId);
	result.consolidation = consolResult;

	// profile
	const profile = await buildProfile(kv, agentId);
	result.profile = { concepts: profile.topConcepts.length, files: profile.topFiles.length };

	// graph
	result.graph = graphStats();

	// lessons decay
	const lessonResult = await lessonDecaySweep(kv, agentId);
	result.lessons = lessonResult;

	// auto-page
	const paged = await autoPage(kv, agentId, tokenBudget);
	result.autoPage = { paged };

	return result;
}
