/*---------------------------------------------------------------------------------------------
 *  consolidationLlm.ts — LLM 驱动的 consolidate-pipeline（2026-07-26 C1）
 *
 *  1:1 复刻 agentmemory src/functions/consolidation-pipeline.ts +
 *  src/prompts/consolidation.ts 的 LLM 路径：
 *    - semantic tier：summaries(≥5, top20) → LLM(SEMANTIC_MERGE_SYSTEM)
 *      → <fact confidence> 提取 → mem:semantic（按 content 大小写不敏感去重强化）
 *    - procedural tier：pattern 记忆(≥2, sessionIds≥2) → LLM(PROCEDURAL_EXTRACTION_SYSTEM)
 *      → <procedure name trigger><step> 提取 → mem:procedural（按 title 去重强化）
 *
 *  门控：CONSOLIDATION_ENABLED=true 且 LLM 已配置（AGENTMEMORY_LLM_BASE_URL/API_KEY）。
 *  未启用/LLM 失败时由调用方（runConsolidationPipeline）回退确定性路径。
 *
 *  与原版差异：①per-agent KV scope（原版全局）；②字段映射到移植版类型
 *  （fact→SemanticMemory.content、name→ProceduralMemory.title、
 *  trigger→preconditions[0]、strength→confidence）。
 *--------------------------------------------------------------------------------------------*/

import type { SemanticMemory, ProceduralMemory, SessionSummary, Memory } from './amTypes.js';
import { KV, generateId } from './amSchema.js';
import { StateKV } from './stateKV.js';
import { callChatCompletion, isLlmConfigured } from './compressor.js';

// ─── 提示词（1:1 复刻原版 prompts/consolidation.ts）─────────────────────────

export const SEMANTIC_MERGE_SYSTEM = `You are a memory consolidation engine. Given overlapping episodic memories (session summaries), extract stable factual knowledge.

Output format (XML):
<facts>
  <fact confidence="0.0-1.0">Concise factual statement</fact>
</facts>

Rules:
- Extract only facts that appear in 2+ episodes or are highly confident
- Confidence reflects how well-supported the fact is across episodes
- Combine overlapping information into single concise facts
- Skip ephemeral details (specific error messages, temporary states)`;

export function buildSemanticMergePrompt(
	episodes: Array<{ title: string; narrative: string; concepts: string[] }>,
): string {
	const items = episodes
		.map((e, i) => `[Episode ${i + 1}]\nTitle: ${e.title}\nNarrative: ${e.narrative}\nConcepts: ${e.concepts.join(', ')}`)
		.join('\n\n');
	return `Consolidate these episodic memories into stable facts:\n\n${items}`;
}

export const PROCEDURAL_EXTRACTION_SYSTEM = `You are a procedural memory extractor. Given repeated patterns and workflows observed across sessions, extract reusable procedures.

Output format (XML):
<procedures>
  <procedure name="short descriptive name" trigger="when to use this procedure">
    <step>Step 1 description</step>
    <step>Step 2 description</step>
  </procedure>
</procedures>

Rules:
- Only extract procedures observed 2+ times
- Steps should be concrete and actionable
- Trigger condition should be specific enough to match automatically`;

export function buildProceduralExtractionPrompt(
	patterns: Array<{ content: string; frequency: number }>,
): string {
	const items = patterns
		.map((p, i) => `[Pattern ${i + 1}] (seen ${p.frequency}x)\n${p.content}`)
		.join('\n\n');
	return `Extract reusable procedures from these recurring patterns:\n\n${items}`;
}

// ─── 门控 ───────────────────────────────────────────────────────────────────

/** LLM consolidation 门控：CONSOLIDATION_ENABLED=true 且 LLM 已配置（对齐原版） */
export function isConsolidationLlmEnabled(): boolean {
	try {
		const raw = typeof process !== 'undefined' ? process.env['CONSOLIDATION_ENABLED'] : undefined;
		return raw === 'true' && isLlmConfigured();
	} catch {
		return false;
	}
}

// ─── Semantic tier（summaries → LLM → facts → mem:semantic）──────────────────

export type ConsolidationTierResult =
	| { newFacts?: number; newProcedures?: number; totalSummaries?: number; patternsAnalyzed?: number }
	| { skipped: true; reason: string }
	| { error: string };

export async function consolidateSemanticWithLlm(kv: StateKV, agentId: string): Promise<ConsolidationTierResult> {
	// 输入为 session summaries（对齐原版语义层输入；D1 防御同款过滤）
	const summaries = (await kv.list<SessionSummary>(KV.summaries(agentId)))
		.filter(s => typeof s.narrative === 'string' && Array.isArray(s.keyDecisions));
	if (summaries.length < 5) {
		return { skipped: true, reason: 'fewer than 5 summaries' };
	}
	const recent = [...summaries]
		.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
		.slice(0, 20);

	const prompt = buildSemanticMergePrompt(
		recent.map(s => ({ title: s.title, narrative: s.narrative, concepts: s.concepts ?? [] })),
	);
	const response = await callChatCompletion(SEMANTIC_MERGE_SYSTEM, prompt, 1200);
	if (!response) { return { error: 'llm unavailable' }; }

	const factRegex = /<fact\s+confidence="([^"]+)">([^<]+)<\/fact>/g;
	let match;
	let newFacts = 0;
	const now = new Date().toISOString();
	// 仅在既有 semantic 条目中查重（跳过 episodic 数组等非 SemanticMemory 形态）
	const existingSemantic = (await kv.list<unknown>(KV.semantic(agentId)))
		.filter((e): e is SemanticMemory => typeof e === 'object' && e !== null && !Array.isArray(e)
			&& typeof (e as SemanticMemory).content === 'string');

	while ((match = factRegex.exec(response)) !== null) {
		const parsedConf = parseFloat(match[1]);
		const confidence = Number.isNaN(parsedConf) ? 0.5 : Math.min(1, Math.max(0, parsedConf));
		const fact = match[2].trim();
		if (!fact) { continue; }

		const existing = existingSemantic.find(s => s.content.toLowerCase() === fact.toLowerCase());
		if (existing) {
			existing.accessCount = (existing.accessCount ?? 0) + 1;
			existing.lastAccessedAt = now;
			existing.updatedAt = now;
			existing.confidence = Math.max(existing.confidence, confidence);
			await kv.set(KV.semantic(agentId), existing.id, existing);
		} else {
			const entry: SemanticMemory = {
				id: generateId('sem'), createdAt: now, updatedAt: now,
				content: fact, confidence,
				accessCount: 1, lastAccessedAt: now,
				sourceIds: recent.map(s => s.sessionId),
				tags: ['consolidated', 'llm'], agentId,
			};
			await kv.set(KV.semantic(agentId), entry.id, entry);
			existingSemantic.push(entry);
			newFacts++;
		}
	}
	return { newFacts, totalSummaries: summaries.length };
}

// ─── Procedural tier（patterns → LLM → procedures → mem:procedural）──────────

export async function consolidateProceduralWithLlm(kv: StateKV, agentId: string): Promise<ConsolidationTierResult> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const patterns = memories
		.filter(m => m.isLatest !== false && m.type === 'pattern')
		.map(m => ({ content: m.content, frequency: (m.sessionIds?.length || 1) }))
		.filter(p => p.frequency >= 2);
	if (patterns.length < 2) {
		return { skipped: true, reason: 'fewer than 2 recurring patterns' };
	}

	const response = await callChatCompletion(
		PROCEDURAL_EXTRACTION_SYSTEM, buildProceduralExtractionPrompt(patterns), 1500,
	);
	if (!response) { return { error: 'llm unavailable' }; }

	const procRegex = /<procedure\s+name="([^"]+)"\s+trigger="([^"]+)">([\s\S]*?)<\/procedure>/g;
	let match;
	let newProcs = 0;
	const now = new Date().toISOString();
	// 查重范围：有 steps 数组的条目（技能 skl_/例程等同 scope 条目不参与）
	const existingProcs = (await kv.list<unknown>(KV.procedural(agentId)))
		.filter((e): e is ProceduralMemory => typeof e === 'object' && e !== null && !Array.isArray(e)
			&& Array.isArray((e as ProceduralMemory).steps) && typeof (e as ProceduralMemory).title === 'string');

	while ((match = procRegex.exec(response)) !== null) {
		const name = match[1].trim();
		const trigger = match[2].trim();
		const stepsBlock = match[3];
		const steps: string[] = [];
		const stepRegex = /<step>([^<]+)<\/step>/g;
		let stepMatch;
		while ((stepMatch = stepRegex.exec(stepsBlock)) !== null) {
			steps.push(stepMatch[1].trim());
		}
		if (!name || steps.length === 0) { continue; }

		const existing = existingProcs.find(p => p.title.toLowerCase() === name.toLowerCase());
		if (existing) {
			existing.confidence = Math.min(1, (existing.confidence ?? 0.5) + 0.1);
			existing.updatedAt = now;
			await kv.set(KV.procedural(agentId), existing.id, existing);
		} else {
			const entry: ProceduralMemory = {
				id: generateId('proc'), createdAt: now, updatedAt: now,
				title: name, steps,
				preconditions: trigger ? [trigger] : [],
				expectedOutcome: '',
				confidence: 0.5,
				sourceSessionIds: [],
				tags: ['consolidated', 'llm'], agentId,
			};
			await kv.set(KV.procedural(agentId), entry.id, entry);
			existingProcs.push(entry);
			newProcs++;
		}
	}
	return { newProcedures: newProcs, patternsAnalyzed: patterns.length };
}
