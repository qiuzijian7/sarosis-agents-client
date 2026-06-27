/*---------------------------------------------------------------------------------------------
 *  4 层固化管道 — Working → Episodic → Semantic → Procedural。
 *  参考 agentmemory src/functions/consolidation-pipeline.ts
 *
 *  层级说明：
 *    Working   — 原始观察（短期记忆，已有）
 *    Episodic  — 会话级摘要（会话结束时生成）
 *    Semantic  — 跨会话事实提取（从多条 Episodic 聚合）
 *    Procedural — 工作流模式（从 Semantic 提取重复模式）
 *
 *  固化触发：
 *    Episodic  → 会话结束时（_endSession）
 *    Semantic  → Episodic 达 5 条时
 *    Procedural → Semantic 中模式频次 ≥ 2 时
 *--------------------------------------------------------------------------------------------*/

import { compress, compressSynthetic } from './compressor.js';

export interface EpisodicMemory {
	id: string;
	sessionId: string;
	title: string;
	narrative: string;
	keyDecisions: string[];
	filesModified: string[];
	concepts: string[];
	observationCount: number;
	createdAt: string;
}

export interface SemanticMemory {
	id: string;
	fact: string;
	confidence: number;
	sourceSessionIds: string[];
	sourceMemoryIds: string[];
	accessCount: number;
	lastAccessedAt: string;
	strength: number;
	createdAt: string;
	updatedAt: string;
}

export interface ProceduralMemory {
	id: string;
	name: string;
	steps: string[];
	triggerCondition: string;
	expectedOutcome?: string;
	frequency: number;
	sourceSessionIds: string[];
	tags: string[];
	strength: number;
	createdAt: string;
	updatedAt: string;
}

const SEMANTIC_THRESHOLD = 5; // Need 5+ episodic memories to trigger semantic extraction
const PROCEDURAL_THRESHOLD = 2; // Need 2+ recurring patterns to trigger procedural extraction
const DECAY_DAYS = 60;
const DECAY_FACTOR = 0.92;
const MIN_STRENGTH = 0.1;

interface InternalEntry {
	id: string;
	content: string;
	type: string;
	timestamp?: number;
	metadata?: Record<string, unknown>;
	strength: number;
}

export class ConsolidationPipeline {
	private _episodic = new Map<string, EpisodicMemory[]>();
	private _semantic = new Map<string, SemanticMemory[]>();
	private _procedural = new Map<string, ProceduralMemory[]>();
	private _lastConsolidated = new Map<string, number>();

	/**
	 * Run full consolidation pipeline for an agent.
	 * Called during sweep (every 6 hours) or manually.
	 */
	async consolidate(agentId: string, longEntries: InternalEntry[]): Promise<{
		episodicCount: number;
		semanticCount: number;
		proceduralCount: number;
		newEpisodic: number;
		newSemantic: number;
		newProcedural: number;
	}> {
		const now = Date.now();
		const lastRun = this._lastConsolidated.get(agentId) ?? 0;
		// Throttle: at most once per hour
		if (now - lastRun < 60 * 60 * 1000) {
			return { ...this._getCounts(agentId), newEpisodic: 0, newSemantic: 0, newProcedural: 0 };
		}
		this._lastConsolidated.set(agentId, now);

		// 1. Episodic: generate session summaries from recent long-term memories
		const newEpisodic = await this._extractEpisodic(agentId, longEntries);

		// 2. Semantic: extract cross-session facts from episodic memories
		const newSemantic = this._extractSemantic(agentId);

		// 3. Procedural: extract workflow patterns from semantic memories
		const newProcedural = this._extractProcedural(agentId);

		// 4. Apply decay
		this._applyDecay(agentId);

		return {
			...this._getCounts(agentId),
			newEpisodic,
			newSemantic,
			newProcedural,
		};
	}

	/** Generate episodic memories (session summaries) from long-term entries */
	private async _extractEpisodic(agentId: string, entries: InternalEntry[]): Promise<number> {
		const existing = this._episodic.get(agentId) ?? [];
		const existingIds = new Set(existing.map(e => e.sessionId));

		// Group entries by session
		const bySession = new Map<string, InternalEntry[]>();
		for (const entry of entries) {
			const sessionId = (entry.metadata?.['sessionKey'] as string) ?? 'default';
			if (!existingIds.has(sessionId)) {
				const group = bySession.get(sessionId) ?? [];
				group.push(entry);
				bySession.set(sessionId, group);
			}
		}

		let newCount = 0;
		for (const [sessionId, group] of bySession) {
			if (group.length < 3) continue; // Skip tiny sessions

			const combinedContent = group.map(e => e.content).join('\n');
			let compressed;
			try {
				compressed = await compress(combinedContent);
			} catch {
				compressed = compressSynthetic(combinedContent);
			}

			const episodic: EpisodicMemory = {
				id: `epi-${sessionId}-${Date.now()}`,
				sessionId,
				title: compressed.title,
				narrative: compressed.narrative,
				keyDecisions: compressed.facts.filter(f => /decided|chose|should|will/i.test(f)),
				filesModified: compressed.files,
				concepts: compressed.concepts,
				observationCount: group.length,
				createdAt: new Date().toISOString(),
			};
			existing.push(episodic);
			newCount++;
		}

		this._episodic.set(agentId, existing);
		return newCount;
	}

	/** Extract semantic memories (cross-session facts) from episodic memories */
	private _extractSemantic(agentId: string): number {
		const episodic = this._episodic.get(agentId) ?? [];
		if (episodic.length < SEMANTIC_THRESHOLD) return 0;

		const semantic = this._semantic.get(agentId) ?? [];
		const existingFacts = new Set(semantic.map(s => s.fact.toLowerCase()));
		let newCount = 0;

		// Aggregate concepts across episodic memories
		const conceptFreq = new Map<string, string[]>();
		for (const epi of episodic) {
			for (const concept of epi.concepts) {
				const arr = conceptFreq.get(concept) ?? [];
				arr.push(epi.id);
				conceptFreq.set(concept, arr);
			}
		}

		// Extract facts from episodic narratives
		const recent = episodic.slice(-20); // Last 20 sessions
		for (const epi of recent) {
			const facts = epi.keyDecisions.length > 0
				? epi.keyDecisions
				: epi.narrative.split(/[.\n]/).filter(s => s.trim().length > 15 && s.trim().length < 150);

			for (const fact of facts) {
				const trimmed = fact.trim();
				if (!trimmed || existingFacts.has(trimmed.toLowerCase())) continue;

				semantic.push({
					id: `sem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					fact: trimmed,
					confidence: 0.6,
					sourceSessionIds: [epi.sessionId],
					sourceMemoryIds: [epi.id],
					accessCount: 0,
					lastAccessedAt: new Date().toISOString(),
					strength: 0.6,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				});
				existingFacts.add(trimmed.toLowerCase());
				newCount++;
			}
		}

		this._semantic.set(agentId, semantic);
		return newCount;
	}

	/** Extract procedural memories (workflow patterns) from semantic memories */
	private _extractProcedural(agentId: string): number {
		const semantic = this._semantic.get(agentId) ?? [];
		const procedural = this._procedural.get(agentId) ?? [];

		// Find recurring patterns (same fact appearing in multiple sessions)
		const patternFreq = new Map<string, SemanticMemory[]>();
		for (const sem of semantic) {
			// Group by concept keywords
			const keywords = sem.fact.toLowerCase().split(/\s+/).filter(w => w.length > 4);
			for (const kw of keywords) {
				const arr = patternFreq.get(kw) ?? [];
				arr.push(sem);
				patternFreq.set(kw, arr);
			}
		}

		let newCount = 0;
		const existingNames = new Set(procedural.map(p => p.name.toLowerCase()));

		for (const [keyword, sems] of patternFreq) {
			if (sems.length < PROCEDURAL_THRESHOLD) continue;
			const name = keyword.charAt(0).toUpperCase() + keyword.slice(1);
			if (existingNames.has(name.toLowerCase())) continue;

			procedural.push({
				id: `proc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				name,
				steps: sems.slice(0, 5).map(s => s.fact),
				triggerCondition: `When "${keyword}" is mentioned`,
				frequency: sems.length,
				sourceSessionIds: [...new Set(sems.flatMap(s => s.sourceSessionIds))],
				tags: [keyword],
				strength: 0.5,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			existingNames.add(name.toLowerCase());
			newCount++;
		}

		this._procedural.set(agentId, procedural);
		return newCount;
	}

	/** Apply decay to semantic and procedural memories */
	private _applyDecay(agentId: string): void {
		const now = Date.now();
		const semantic = this._semantic.get(agentId);
		if (semantic) {
			for (const s of semantic) {
				const daysSince = (now - new Date(s.lastAccessedAt).getTime()) / (1000 * 60 * 60 * 24);
				if (daysSince > DECAY_DAYS) {
					const periods = Math.floor(daysSince / DECAY_DAYS);
					s.strength = Math.max(MIN_STRENGTH, s.strength * Math.pow(DECAY_FACTOR, periods));
				}
			}
		}

		const procedural = this._procedural.get(agentId);
		if (procedural) {
			for (const p of procedural) {
				const daysSince = (now - new Date(p.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
				if (daysSince > DECAY_DAYS) {
					const periods = Math.floor(daysSince / DECAY_DAYS);
					p.strength = Math.max(MIN_STRENGTH, p.strength * Math.pow(DECAY_FACTOR, periods));
				}
			}
		}
	}

	private _getCounts(agentId: string) {
		return {
			episodicCount: this._episodic.get(agentId)?.length ?? 0,
			semanticCount: this._semantic.get(agentId)?.length ?? 0,
			proceduralCount: this._procedural.get(agentId)?.length ?? 0,
		};
	}

	// ─── Public API ──────────────────────────────────────────────────────────

	getEpisodic(agentId: string): EpisodicMemory[] {
		return this._episodic.get(agentId) ?? [];
	}

	getSemantic(agentId: string): SemanticMemory[] {
		return this._semantic.get(agentId) ?? [];
	}

	getProcedural(agentId: string): ProceduralMemory[] {
		return this._procedural.get(agentId) ?? [];
	}

	/** Build context from all tiers for injection */
	buildContext(agentId: string, limit: number = 20): string {
		const parts: string[] = [];
		const semantic = this._semantic.get(agentId) ?? [];
		const procedural = this._procedural.get(agentId) ?? [];

		if (semantic.length > 0) {
			parts.push('## Semantic Memory (Cross-session Facts)');
			const top = [...semantic]
				.sort((a, b) => b.strength - a.strength)
				.slice(0, Math.min(10, limit));
			for (const s of top) {
				parts.push(`- [${s.strength.toFixed(2)}] ${s.fact}`);
			}
		}

		if (procedural.length > 0) {
			parts.push('\n## Procedural Memory (Workflow Patterns)');
			const top = [...procedural]
				.sort((a, b) => b.strength - a.strength)
				.slice(0, Math.min(5, limit));
			for (const p of top) {
				parts.push(`- [${p.frequency}x] ${p.name}: ${p.triggerCondition}`);
			}
		}

		return parts.join('\n');
	}

	clear(agentId: string): void {
		this._episodic.delete(agentId);
		this._semantic.delete(agentId);
		this._procedural.delete(agentId);
		this._lastConsolidated.delete(agentId);
	}
}
