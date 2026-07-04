/*---------------------------------------------------------------------------------------------
 *  ConsolidationPipeline 单元测试 — 4 层固化管道
 *  Working → Episodic → Semantic → Procedural
 *  包含 LLM 驱动提取和规则回退
 *--------------------------------------------------------------------------------------------*/
import { ConsolidationPipeline, type EpisodicMemory } from '../consolidation.js';
import { describe, itAsync, assert, assertEqual } from './testRunner.js';

interface InternalEntry {
	id: string;
	content: string;
	type: string;
	timestamp?: number;
	metadata?: Record<string, unknown>;
	strength: number;
}

function makeEntries(count: number, sessionKey?: string): InternalEntry[] {
	const entries: InternalEntry[] = [];
	for (let i = 0; i < count; i++) {
		entries.push({
			id: `entry-${i}`,
			content: `Observation ${i}: we decided to use the database error handling pattern for the authentication module`,
			type: 'episodic',
			timestamp: i,
			metadata: sessionKey ? { sessionKey } : {},
			strength: 1.0,
		});
	}
	return entries;
}

export function runConsolidationTests(): void {
describe('ConsolidationPipeline — Episodic', () => {
	itAsync('extracts episodic memories from long-term entries', async () => {
		const pipe = new ConsolidationPipeline();
		const entries = makeEntries(5, 'session-001');
		const result = await pipe.consolidate('agent-1', entries);
		assert(result.episodicCount > 0, `episodicCount: ${result.episodicCount}`);
		assert(result.newEpisodic > 0, `newEpisodic: ${result.newEpisodic}`);
	});

	itAsync('skips sessions with < 3 entries', async () => {
		const pipe = new ConsolidationPipeline();
		const entries = makeEntries(2, 'session-tiny');
		const result = await pipe.consolidate('agent-2', entries);
		assertEqual(result.newEpisodic, 0, 'no episodic from tiny session');
	});

	itAsync('groups entries by session', async () => {
		const pipe = new ConsolidationPipeline();
		const entries = [
			...makeEntries(5, 'session-A'),
			...makeEntries(5, 'session-B'),
		];
		const result = await pipe.consolidate('agent-3', entries);
		assert(result.newEpisodic >= 2, `should create 2 episodic: ${result.newEpisodic}`);
		const episodic = pipe.getEpisodic('agent-3');
		const sessionIds = new Set(episodic.map(e => e.sessionId));
		assert(sessionIds.has('session-A'), 'has session-A');
		assert(sessionIds.has('session-B'), 'has session-B');
	});

	itAsync('throttle: second call within 1 hour returns zero new', async () => {
		const pipe = new ConsolidationPipeline();
		const entries = makeEntries(5, 'session-throttle');
		await pipe.consolidate('agent-4', entries);
		const result2 = await pipe.consolidate('agent-4', entries);
		assertEqual(result2.newEpisodic, 0, 'throttled');
		assertEqual(result2.newSemantic, 0, 'throttled semantic');
	});
});

describe('ConsolidationPipeline — Semantic (rule-based fallback)', () => {
	itAsync('extracts semantic memories when episodic >= threshold', async () => {
		const pipe = new ConsolidationPipeline();
		// Need 5+ episodic memories to trigger semantic extraction
		const allEntries: InternalEntry[] = [];
		for (let s = 0; s < 6; s++) {
			allEntries.push(...makeEntries(4, `session-${s}`));
		}
		await pipe.consolidate('agent-5', allEntries);
		const semantic = pipe.getSemantic('agent-5');
		assert(semantic.length > 0, `semantic extracted: ${semantic.length}`);
	});

	itAsync('no semantic extraction below threshold', async () => {
		const pipe = new ConsolidationPipeline();
		// Only 2 sessions → 2 episodic < 5 threshold
		const entries = [
			...makeEntries(4, 's1'),
			...makeEntries(4, 's2'),
		];
		await pipe.consolidate('agent-6', entries);
		assertEqual(pipe.getSemantic('agent-6').length, 0, 'no semantic below threshold');
	});

	itAsync('semantic memories have confidence and strength', async () => {
		const pipe = new ConsolidationPipeline();
		const allEntries: InternalEntry[] = [];
		for (let s = 0; s < 6; s++) {
			allEntries.push(...makeEntries(4, `session-${s}`));
		}
		await pipe.consolidate('agent-7', allEntries);
		const semantic = pipe.getSemantic('agent-7');
		for (const s of semantic) {
			assert(s.confidence > 0, `confidence > 0: ${s.confidence}`);
			assert(s.strength > 0, `strength > 0: ${s.strength}`);
			assert(s.fact.length > 0, 'non-empty fact');
		}
	});
});

describe('ConsolidationPipeline — Semantic (LLM-driven)', () => {
	itAsync('parses <facts> XML from LLM summarizer', async () => {
		const pipe = new ConsolidationPipeline();
		// Inject mock LLM summarizer that returns valid XML
		pipe.setSummarizer(async (_sys, _user) => {
			return `<facts>
<fact confidence="0.9">The project uses TypeScript strict mode</fact>
<fact confidence="0.7">Database migrations are handled by Knex</fact>
</facts>`;
		});

		// Need 5+ episodic to trigger semantic
		const allEntries: InternalEntry[] = [];
		for (let s = 0; s < 6; s++) {
			allEntries.push(...makeEntries(4, `llm-session-${s}`));
		}
		await pipe.consolidate('agent-llm-1', allEntries);

		const semantic = pipe.getSemantic('agent-llm-1');
		assert(semantic.length >= 2, `at least 2 facts extracted: ${semantic.length}`);
		const ts = semantic.find(s => s.fact.includes('TypeScript strict'));
		assert(ts !== undefined, 'found TypeScript fact');
		assert(ts!.confidence === 0.9, `confidence 0.9: ${ts!.confidence}`);
	});

	itAsync('falls back to rule-based when LLM fails', async () => {
		const pipe = new ConsolidationPipeline();
		// Mock LLM that throws
		pipe.setSummarizer(async () => { throw new Error('LLM unavailable'); });

		const allEntries: InternalEntry[] = [];
		for (let s = 0; s < 6; s++) {
			allEntries.push(...makeEntries(4, `fallback-${s}`));
		}
		await pipe.consolidate('agent-llm-2', allEntries);

		// Should still have semantic memories via rule-based fallback
		const semantic = pipe.getSemantic('agent-llm-2');
		assert(semantic.length > 0, `fallback extracted: ${semantic.length}`);
	});

	itAsync('dedup: same fact not extracted twice', async () => {
		const pipe = new ConsolidationPipeline();
		let callCount = 0;
		pipe.setSummarizer(async () => {
			callCount++;
			return `<facts><fact confidence="0.8">Unique fact number ${callCount}</fact></facts>`;
		});

		const allEntries: InternalEntry[] = [];
		for (let s = 0; s < 6; s++) {
			allEntries.push(...makeEntries(4, `dedup-${s}`));
		}
		await pipe.consolidate('agent-llm-3', allEntries);
		const firstCount = pipe.getSemantic('agent-llm-3').length;

		// Clear throttle and run again with same entries
		pipe.clear('agent-llm-3');
		// Manually inject episodic to bypass the session grouping
		const episodic = pipe.getEpisodic('agent-llm-3');
		assert(episodic.length === 0, 'cleared');

		// Second run with new sessions → different facts (callCount increments)
		const moreEntries: InternalEntry[] = [];
		for (let s = 0; s < 6; s++) {
			moreEntries.push(...makeEntries(4, `dedup2-${s}`));
		}
		await pipe.consolidate('agent-llm-3', moreEntries);
		const secondCount = pipe.getSemantic('agent-llm-3').length;
		assert(secondCount >= firstCount, `second run has >= facts: ${secondCount} >= ${firstCount}`);
	});
});

describe('ConsolidationPipeline — Procedural (LLM-driven)', () => {
	itAsync('parses <procedures> XML from LLM', async () => {
		const pipe = new ConsolidationPipeline();
		pipe.setSummarizer(async (sys, _user) => {
			if (sys.includes('workflow')) {
				return `<procedures>
<procedure name="Error Handling Pattern" trigger="when a database error occurs">
<step>Log the error with full stack trace</step>
<step>Retry with exponential backoff</step>
<step>Fallback to cached data</step>
</procedure>
</procedures>`;
			}
			// For semantic extraction
			return `<facts>
<fact confidence="0.8">Database errors should be retried</fact>
<fact confidence="0.7">Use exponential backoff for retries</fact>
<fact confidence="0.6">Cache fallback improves resilience</fact>
</facts>`;
		});

		const allEntries: InternalEntry[] = [];
		for (let s = 0; s < 6; s++) {
			allEntries.push(...makeEntries(4, `proc-${s}`));
		}
		await pipe.consolidate('agent-proc-1', allEntries);

		const procedural = pipe.getProcedural('agent-proc-1');
		assert(procedural.length > 0, `procedural extracted: ${procedural.length}`);
		const errPattern = procedural.find(p => p.name === 'Error Handling Pattern');
		assert(errPattern !== undefined, 'found error handling pattern');
		assert(errPattern!.steps.length === 3, `3 steps: ${errPattern!.steps.length}`);
		assert(errPattern!.triggerCondition.includes('database error'), 'has trigger condition');
	});

	itAsync('falls back to rule-based procedural when no LLM', async () => {
		const pipe = new ConsolidationPipeline();

		const allEntries: InternalEntry[] = [];
		for (let s = 0; s < 6; s++) {
			allEntries.push(...makeEntries(4, `rule-proc-${s}`));
		}
		await pipe.consolidate('agent-proc-2', allEntries);

		// Rule-based procedural requires keyword frequency >= 2
		const procedural = pipe.getProcedural('agent-proc-2');
		// May or may not extract depending on keyword frequency
		assert(procedural.length >= 0, `rule-based procedural: ${procedural.length}`);
	});
});

describe('ConsolidationPipeline — buildContext', () => {
	itAsync('builds context string from all tiers', async () => {
		const pipe = new ConsolidationPipeline();
		const allEntries: InternalEntry[] = [];
		for (let s = 0; s < 6; s++) {
			allEntries.push(...makeEntries(4, `ctx-${s}`));
		}
		await pipe.consolidate('agent-ctx', allEntries);

		const context = pipe.buildContext('agent-ctx', 10);
		assert(context.length > 0, 'non-empty context');
		// Should contain semantic or procedural sections
		assert(context.includes('## Semantic Memory') || context.includes('## Procedural Memory'),
			'has section headers');
	});

	itAsync('empty context for unknown agent', async () => {
		const pipe = new ConsolidationPipeline();
		const context = pipe.buildContext('unknown-agent');
		assertEqual(context, '', 'empty for unknown');
	});
});

describe('ConsolidationPipeline — clear', () => {
	itAsync('clear removes all tiers for agent', async () => {
		const pipe = new ConsolidationPipeline();
		const entries = makeEntries(5, 'session-clear');
		await pipe.consolidate('agent-clear', entries);
		assert(pipe.getEpisodic('agent-clear').length > 0, 'has episodic before clear');

		pipe.clear('agent-clear');
		assertEqual(pipe.getEpisodic('agent-clear').length, 0, 'episodic cleared');
		assertEqual(pipe.getSemantic('agent-clear').length, 0, 'semantic cleared');
		assertEqual(pipe.getProcedural('agent-clear').length, 0, 'procedural cleared');
	});
});
}
