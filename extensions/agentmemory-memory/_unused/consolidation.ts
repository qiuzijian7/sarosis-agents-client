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

// LLM system prompts for semantic/procedural extraction (1:1 parity with agentmemory)
const SEMANTIC_EXTRACTION_SYS = `You are a knowledge extraction engine. Given session summaries from a coding agent, extract stable cross-session facts.

Output ONLY valid XML:
<facts>
<fact confidence="0.8">A specific, concrete technical fact that applies across sessions</fact>
<fact confidence="0.6">A softer observation or preference pattern</fact>
</facts>

Guidelines:
- Facts should be specific and actionable, not vague generalities
- Confidence: 0.8+ for clear repeated patterns, 0.5-0.7 for single observations
- Prefer technical facts (architecture, dependencies, constraints, conventions) over conversational trivia
- Max 10 facts`;

const PROCEDURAL_EXTRACTION_SYS = `You are a workflow extraction engine. Given cross-session facts from a coding agent, extract reusable procedural patterns.

Output ONLY valid XML:
<procedures>
<procedure name="Pattern Name" trigger="when this situation occurs">
<step>Concrete first step</step>
<step>Concrete second step</step>
</procedure>
</procedures>

Guidelines:
- Only extract patterns supported by at least 2 facts mentioning similar workflows
- Each step should be concrete and actionable
- Trigger should describe when the agent should apply this procedure
- Max 5 procedures`;

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

	/** Optional LLM summarizer (1:1 parity with agentmemory's provider.summarize) */
	private _summarizer?: (systemPrompt: string, userPrompt: string) => Promise<string>;

	/** Set the LLM summarizer for high-quality semantic/procedural extraction */
	setSummarizer(fn: (systemPrompt: string, userPrompt: string) => Promise<string>): void {
		this._summarizer = fn;
	}

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
		const newSemantic = await this._extractSemantic(agentId);

		// 3. Procedural: extract workflow patterns from semantic memories
		const newProcedural = await this._extractProcedural(agentId);

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
	private async _extractSemantic(agentId: string): Promise<number> {
		const episodic = this._episodic.get(agentId) ?? [];
		if (episodic.length < SEMANTIC_THRESHOLD) return 0;

		const semantic = this._semantic.get(agentId) ?? [];
		const existingFacts = new Set(semantic.map(s => s.fact.toLowerCase()));
		let newCount = 0;

		// LLM-driven extraction (1:1 parity with agentmemory's mem::consolidate-pipeline semantic tier)
		if (this._summarizer) {
			try {
				const recent = episodic.slice(-10);
				const summaries = recent.map(e => `Session: ${e.title}\n${e.narrative}`).join('\n\n---\n\n');
				const prompt = `Extract stable cross-session facts from these session summaries. Output XML only:\n\n<facts>\n<fact confidence="0.8">A stable technical fact</fact>\n</facts>\n\n${summaries}`;
				const result = await this._summarizer(SEMANTIC_EXTRACTION_SYS, prompt);
				const factsXml = /<fact\b[^>]*>([\s\S]*?)<\/fact>/gi;
				let match;
				while ((match = factsXml.exec(result)) !== null) {
					const fact = match[1].trim();
					if (!fact || fact.length < 10 || existingFacts.has(fact.toLowerCase())) continue;
					const confMatch = /confidence="([\d.]+)"/.exec(result.slice(match.index));
					const confidence = confMatch ? parseFloat(confMatch[1]) : 0.7;
					semantic.push({
						id: `sem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						fact,
						confidence,
						sourceSessionIds: recent.map(e => e.sessionId),
						sourceMemoryIds: recent.map(e => e.id),
						accessCount: 0,
						lastAccessedAt: new Date().toISOString(),
						strength: confidence,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					});
					existingFacts.add(fact.toLowerCase());
					newCount++;
				}
				this._semantic.set(agentId, semantic);
				return newCount;
			} catch { /* fallback to rule-based */ }
		}

		// Rule-based fallback: extract facts from episodic keyDecisions/narratives
		const conceptFreq = new Map<string, string[]>();
		for (const epi of episodic) {
			for (const concept of epi.concepts) {
				const arr = conceptFreq.get(concept) ?? [];
				arr.push(epi.id);
				conceptFreq.set(concept, arr);
			}
		}

		const recent = episodic.slice(-20);
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
	private async _extractProcedural(agentId: string): Promise<number> {
		const semantic = this._semantic.get(agentId) ?? [];
		const procedural = this._procedural.get(agentId) ?? [];

		// LLM-driven extraction (1:1 parity with agentmemory)
		if (this._summarizer && semantic.length >= 3) {
			try {
				const facts = semantic.slice(-15).map(s => s.fact).join('\n');
				const prompt = `Extract reusable workflow patterns from these cross-session facts. Output XML only:\n\n<procedures>\n<procedure name="Pattern Name" trigger="when to apply">\n<step>First step</step>\n<step>Second step</step>\n</procedure>\n</procedures>\n\n${facts}`;
				const result = await this._summarizer(PROCEDURAL_EXTRACTION_SYS, prompt);
				const procRegex = /<procedure\s+name="([^"]+)"\s*(?:trigger="([^"]*)")?>([\s\S]*?)<\/procedure>/gi;
				let match;
				const existingNames = new Set(procedural.map(p => p.name.toLowerCase()));
				let newCount = 0;
				while ((match = procRegex.exec(result)) !== null) {
					const name = match[1].trim();
					const trigger = match[2]?.trim() ?? '';
					const stepsXml = match[3];
					const steps: string[] = [];
					for (const sm of stepsXml.matchAll(/<step>([\s\S]*?)<\/step>/g)) {
						steps.push(sm[1].trim());
					}
					if (!name || steps.length < 2 || existingNames.has(name.toLowerCase())) continue;
					procedural.push({
						id: `proc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						name,
						steps,
						triggerCondition: trigger,
						expectedOutcome: '',
						frequency: 1,
						sourceSessionIds: [],
						tags: [],
						strength: 0.7,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					});
					existingNames.add(name.toLowerCase());
					newCount++;
				}
				this._procedural.set(agentId, procedural);
				return newCount;
			} catch { /* fallback to rule-based */ }
		}

		// Rule-based fallback: group by keyword frequency
		const patternFreq = new Map<string, SemanticMemory[]>();
		for (const sem of semantic) {
			const keywords = sem.fact.toLowerCase().split(/\s+/).filter((w: string) => w.length > 4);
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
