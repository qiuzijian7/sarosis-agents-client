/*---------------------------------------------------------------------------------------------
 *  AgentMemory 高级特性 — 阶段 A 剩余功能
 *
 *  1. Query Expansion — 查询同义词展开 + 实体提取
 *  2. Sliding Window — 最近访问记忆窗口
 *  3. Summarize — 会话级摘要（synthetic + LLM fallback）
 *  4. Skill Extract — 从会话记忆提取可复用技能
 *--------------------------------------------------------------------------------------------*/

import type { Memory, CoreMemoryEntry, SessionSummary, Observation } from './amTypes.js';
import { KV, generateId, estimateTokens } from './amSchema.js';
import { StateKV } from './stateKV.js';

// ─── 1. Query Expansion（对齐 agentmemory mem::query-expansion）──────────

export interface QueryExpansion {
	reformulations: string[];
	temporalConcretizations: string[];
	entityExtractions: string[];
}

const SYNONYMS: Record<string, string[]> = {
	'error': ['bug', 'exception', 'crash', 'failure', 'problem', 'issue'],
	'fix': ['resolve', 'patch', 'repair', 'correct', 'remedy'],
	'deploy': ['release', 'ship', 'launch', 'publish', 'rollout'],
	'config': ['configuration', 'settings', 'setup', 'options', 'preferences'],
	'build': ['compile', 'transpile', 'bundle', 'package', 'assemble'],
	'test': ['testing', 'verify', 'validate', 'check', 'assert'],
	'api': ['endpoint', 'interface', 'service', 'route', 'handler'],
	'component': ['module', 'element', 'widget', 'piece', 'part'],
	'pattern': ['pattern', 'template', 'blueprint', 'model', 'archetype'],
	'performance': ['speed', 'optimization', 'efficiency', 'latency', 'throughput'],
};

const ENTITY_PATTERN = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;

export async function expandQuery(kv: StateKV, agentId: string, query: string, project?: string): Promise<QueryExpansion> {
	const reformulations: string[] = [query];
	const words = query.toLowerCase().split(/\s+/);

	// 同义词展开
	for (const word of words) {
		const syns = SYNONYMS[word];
		if (syns) {
			for (const syn of syns) {
				reformulations.push(query.replace(new RegExp(word, 'i'), syn));
			}
		}
	}

	// 实体提取
	const entityExtractions: string[] = [];
	let match;
	while ((match = ENTITY_PATTERN.exec(query)) !== null) {
		entityExtractions.push(match[1]);
	}

	// 从记忆标题中搜索相关实体
	const memories = await kv.list<Memory>(KV.memories(agentId));
	for (const m of memories) {
		if (m.isLatest === false) continue;
		for (const concept of m.concepts) {
			if (words.some(w => concept.toLowerCase().includes(w))) {
				entityExtractions.push(concept);
			}
		}
	}

	return {
		reformulations: [...new Set(reformulations)].slice(0, 8),
		temporalConcretizations: [],
		entityExtractions: [...new Set(entityExtractions)].slice(0, 10),
	};
}

// ─── 2. Sliding Window（对齐 agentmemory mem::enrich-window）───────────

export interface WindowEntry {
	id: string;
	content: string;
	type: string;
	timestamp: number;
	score: number;
	source: 'search' | 'context' | 'write' | 'restore';
}

const WINDOW_SIZE = 50;

export async function slidingWindowAdd(kv: StateKV, agentId: string, entry: WindowEntry): Promise<void> {
	const all = await kv.list<WindowEntry>(KV.recentSearches(agentId));
	// kv.list 可能将存储的数组作为单个元素返回
	const window: WindowEntry[] = all.length === 1 && Array.isArray(all[0]) ? all[0] as unknown as WindowEntry[] : all as unknown as WindowEntry[];
	window.push(entry);
	const trimmed = window.length > WINDOW_SIZE ? window.slice(-WINDOW_SIZE) : window;
	await kv.set(KV.recentSearches(agentId), 'current', trimmed as any);
}

export async function slidingWindowGet(kv: StateKV, agentId: string, limit = 15): Promise<WindowEntry[]> {
	const all = await kv.list<WindowEntry>(KV.recentSearches(agentId));
	const entries: WindowEntry[] = all.length === 1 && Array.isArray(all[0]) ? all[0] as unknown as WindowEntry[] : all as unknown as WindowEntry[];
	return entries
		.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
		.slice(0, limit);
}

// ─── 3. Summarize（对齐 agentmemory mem::summarize）─────────────────────

export async function summarizeSession(kv: StateKV, agentId: string, sessionId: string): Promise<SessionSummary | null> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const sessionMems = memories.filter(m => m.isLatest !== false);
	if (sessionMems.length === 0) return null;

	const now = new Date().toISOString();
	const files = [...new Set(sessionMems.flatMap(m => m.files))].slice(0, 20);
	const concepts = [...new Set(sessionMems.flatMap(m => m.concepts))].slice(0, 20);
	const decisions = sessionMems
		.filter(m => m.type === 'architecture' || m.type === 'preference' || m.type === 'workflow')
		.map(m => m.content.slice(0, 100));

	const summary: SessionSummary = {
		sessionId,
		project: agentId,
		createdAt: now,
		title: sessionMems.length > 0 ? sessionMems[0].title.slice(0, 80) : 'Session',
		narrative: `Session with ${sessionMems.length} observations covering ${concepts.length} concepts`,
		keyDecisions: decisions.slice(0, 10),
		filesModified: files,
		concepts,
		observationCount: sessionMems.length,
		agentId,
	};
	await kv.set(KV.summaries(agentId), sessionId, summary);
	return summary;
}

// ─── 4. Skill Extract（对齐 agentmemory mem::skill-extract）─────────────

export interface ExtractedSkill {
	id: string;
	trigger: string;
	title: string;
	steps: string[];
	expectedOutcome: string;
	tags: string[];
	confidence: number;
	sourceSessionIds: string[];
	createdAt: string;
}

export async function extractSkill(kv: StateKV, agentId: string, sessionId: string): Promise<ExtractedSkill | null> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const sessionMems = memories.filter(m => m.isLatest !== false);
	const proceduralSteps = sessionMems.filter(m => m.type === 'workflow' || m.type === 'pattern');

	if (proceduralSteps.length < 2) return null;

	const now = new Date().toISOString();
	const steps = proceduralSteps.map(m => m.content.slice(0, 200));

	const skill: ExtractedSkill = {
		id: generateId('skl'),
		trigger: `When the agent encounters a ${proceduralSteps[0].type} task`,
		title: `Multi-step procedure from session ${sessionId.slice(0, 8)}`,
		steps,
		expectedOutcome: 'Procedure completed successfully',
		tags: [...new Set(proceduralSteps.flatMap(m => m.concepts))].slice(0, 10),
		confidence: Math.min(1, proceduralSteps.length / 5),
		sourceSessionIds: [sessionId],
		createdAt: now,
	};

	// 持久化到 procedural scope
	await kv.set(KV.procedural(agentId), skill.id, {
		id: skill.id,
		createdAt: skill.createdAt,
		updatedAt: skill.createdAt,
		title: skill.title,
		steps: skill.steps,
		preconditions: [skill.trigger],
		expectedOutcome: skill.expectedOutcome,
		confidence: skill.confidence,
		sourceSessionIds: skill.sourceSessionIds,
		tags: skill.tags,
		agentId,
	});

	return skill;
}

// ─── 5. Skill List / Match（复刻 agentmemory mem::skill-list / mem::skill-match）──

/** 存储记录 → ExtractedSkill 归一化（持久化形态用 preconditions[0] 存 trigger） */
function normalizeSkill(raw: Record<string, unknown>): ExtractedSkill | null {
	const id = typeof raw['id'] === 'string' ? raw['id'] : '';
	if (!id.startsWith('skl') || !Array.isArray(raw['steps'])) { return null; }
	const preconditions = Array.isArray(raw['preconditions']) ? raw['preconditions'] as unknown[] : [];
	return {
		id,
		trigger: typeof raw['trigger'] === 'string' ? raw['trigger'] : String(preconditions[0] ?? ''),
		title: String(raw['title'] ?? ''),
		steps: raw['steps'] as string[],
		expectedOutcome: String(raw['expectedOutcome'] ?? ''),
		tags: Array.isArray(raw['tags']) ? raw['tags'] as string[] : [],
		confidence: typeof raw['confidence'] === 'number' ? raw['confidence'] : 0.5,
		sourceSessionIds: Array.isArray(raw['sourceSessionIds']) ? raw['sourceSessionIds'] as string[] : [],
		createdAt: String(raw['createdAt'] ?? ''),
	};
}

/** mem::skill-list：列出 agent 已抽取的技能（按创建时间倒序） */
export async function skillList(kv: StateKV, agentId: string): Promise<ExtractedSkill[]> {
	const all = await kv.list<Record<string, unknown>>(KV.procedural(agentId));
	return all
		.map(normalizeSkill)
		.filter((s): s is ExtractedSkill => s !== null)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** mem::skill-match：任务文本 vs 技能 trigger/title/tags/steps 关键词重叠打分，
 *  乘置信度权重，取 top N（任务 → 推荐技能的闭环查询侧，D3 补齐）。 */
export async function skillMatch(kv: StateKV, agentId: string, task: string, limit: number = 3): Promise<Array<{ skill: ExtractedSkill; score: number }>> {
	if (!task || !task.trim()) { return []; }
	const skills = await skillList(kv, agentId);
	if (skills.length === 0) { return []; }
	const terms = task.toLowerCase().split(/[^a-z0-9_一-龥]+/i).filter(t => t.length >= 2);
	if (terms.length === 0) { return []; }
	const scored: Array<{ skill: ExtractedSkill; score: number }> = [];
	for (const skill of skills) {
		const hay = `${skill.trigger} ${skill.title} ${skill.tags.join(' ')} ${skill.steps.join(' ')}`.toLowerCase();
		const hits = terms.filter(t => hay.includes(t)).length;
		if (hits > 0) {
			scored.push({ skill, score: (hits / terms.length) * (0.5 + skill.confidence * 0.5) });
		}
	}
	return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── 6. Session Handoff（复刻 agentmemory MCP session_handoff 工具语义）──────

/**
 * 生成会话交接文档：本会话摘要 + 未闭合 actions + 近期重要观察 + pinned slots
 * → markdown；同时以 SessionSummary 形态持久化（key `handoff_<sessionId>`），
 * 使下一个会话的策展注入（summaries 块）自然携带交接信息。
 */
export async function sessionHandoff(
	kv: StateKV, agentId: string, sessionId: string,
): Promise<{ markdown: string; entry: SessionSummary } | null> {
	if (!sessionId) { return null; }
	const [{ listPinnedSlots }, { actionList }] = await Promise.all([
		import('./amSlots.js'), import('./amAdvanced.js'),
	]);

	const summary = await kv.get<SessionSummary>(KV.summaries(agentId), sessionId).catch(() => null);
	const observations = await kv.list<Observation>(KV.observations(agentId, sessionId)).catch(() => [] as Observation[]);
	const important = observations
		.filter(o => (o.importance ?? (o.hookType === 'post_tool_failure' ? 7 : o.hookType === 'post_tool_use' ? 5 : 4)) >= 5)
		.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
		.slice(0, 10);
	const openActions = (await actionList(kv, agentId).catch(() => []))
		.filter(a => a.status === 'pending' || a.status === 'active' || a.status === 'blocked')
		.slice(0, 10);
	const pinned = await listPinnedSlots(kv, agentId).catch(() => []);

	if (!summary && important.length === 0 && openActions.length === 0) { return null; }

	const sections: string[] = [`# Session Handoff — ${sessionId.slice(0, 8)}`, ''];
	if (summary) {
		sections.push('## Summary', summary.narrative || summary.title, '');
		if (summary.keyDecisions.length > 0) {
			sections.push('## Key Decisions', ...summary.keyDecisions.map(d => `- ${d}`), '');
		}
	}
	if (openActions.length > 0) {
		sections.push('## Open Actions', ...openActions.map(a => `- [${a.status}] (p${a.priority}) ${a.title}`), '');
	}
	if (important.length > 0) {
		sections.push('## Important Observations', ...important.map(o => {
			const d = (o.data ?? {}) as Record<string, unknown>;
			const preview = String(d['content'] ?? d['tool_output'] ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
			return `- [${o.hookType}] ${o.title ?? ''}: ${preview}`;
		}), '');
	}
	if (pinned.length > 0) {
		sections.push('## Pinned Context', ...pinned.map(s => `- **${s.label}**: ${s.content.trim().slice(0, 120)}`), '');
	}
	const markdown = sections.join('\n');

	const now = new Date().toISOString();
	const entry: SessionSummary = {
		sessionId,
		title: `Session Handoff — ${sessionId.slice(0, 8)}`,
		narrative: markdown.slice(0, 2000),
		keyDecisions: summary?.keyDecisions ?? [],
		filesModified: summary?.filesModified ?? [],
		concepts: summary?.concepts ?? [],
		observationCount: observations.length,
		agentId,
		project: summary?.project ?? '',
		createdAt: now,
	};
	await kv.set(KV.summaries(agentId), `handoff_${sessionId}`, entry);
	return { markdown, entry };
}
