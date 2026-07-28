/*---------------------------------------------------------------------------------------------
 *  AgentMemory 类型定义 — 1:1 对齐 agentmemory src/types.ts
 *  废弃旧的 InternalMemoryEntry，使用独立类型 + 独立 KV scope。
 *--------------------------------------------------------------------------------------------*/

/** 长期记忆（episodic）— 对齐 agentmemory Memory */
export interface Memory {
	id: string;
	createdAt: string;
	updatedAt: string;
	type: 'pattern' | 'preference' | 'architecture' | 'bug' | 'workflow' | 'fact';
	title: string;
	content: string;
	concepts: string[];
	files: string[];
	sessionIds: string[];
	strength: number;
	version: number;
	parentId?: string;
	supersedes?: string[];
	relatedIds?: string[];
	sourceObservationIds?: string[];
	isLatest: boolean;
	forgetAfter?: string;
	imageRef?: string;
	agentId?: string;
	project?: string;
}

/** 语义记忆 — 独立 KV scope mem:semantic */
export interface SemanticMemory {
	id: string;
	createdAt: string;
	updatedAt: string;
	content: string;
	confidence: number;
	accessCount: number;
	lastAccessedAt?: string;
	sourceIds: string[];
	tags: string[];
	project?: string;
	agentId?: string;
}

/** 程序性记忆 — 独立 KV scope mem:procedural */
export interface ProceduralMemory {
	id: string;
	createdAt: string;
	updatedAt: string;
	title: string;
	steps: string[];
	preconditions: string[];
	expectedOutcome: string;
	confidence: number;
	sourceSessionIds: string[];
	tags: string[];
	project?: string;
	agentId?: string;
}

/** 核心记忆（短期/工作记忆）— 独立 KV scope mem:core-memory */
export interface CoreMemoryEntry {
	id: string;
	content: string;
	importance: number;
	pinned: boolean;
	accessCount: number;
	lastAccessedAt: string;
	createdAt: string;
	agentId?: string;
}

/** 教训 — 独立 KV scope mem:lessons */
export interface Lesson {
	id: string;
	content: string;
	context: string;
	confidence: number;
	reinforcements: number;
	source: 'crystal' | 'manual' | 'consolidation' | 'error_pattern';
	sourceIds: string[];
	project?: string;
	tags: string[];
	createdAt: string;
	updatedAt: string;
	lastReinforcedAt?: string;
	lastDecayedAt?: string;
	decayRate: number;
	deleted?: boolean;
}

/** 洞察 — 独立 KV scope mem:insights */
export interface Insight {
	id: string;
	createdAt: string;
	content: string;
	confidence: number;
	sourceMemoryIds: string[];
	tags: string[];
	project?: string;
	agentId?: string;
}

/** 观测记录 — 独立 per-session KV scope mem:obs:${agentId}:${sessionId} */
export interface Observation {
	id: string;
	sessionId: string;
	hookType: string;
	timestamp: string;
	data: unknown;
	createdAt: string;
	agentId?: string;
	compressed?: boolean;
	/** 短标题（工具名/内容摘要）——mem::context 重要观察块筛选用（o.title 非空） */
	title?: string;
	/** 重要性 1-10（失败 > 工具使用 > turn 消息 > 生命周期）——mem::context 筛选 importance>=5 */
	importance?: number;
}

export interface ObservationPayload {
	sessionId: string;
	hookType: string;
	timestamp: string;
	data?: unknown;
	agentId?: string;
}

/** 会话摘要 — 独立 KV scope mem:summaries */
export interface SessionSummary {
	sessionId: string;
	project: string;
	createdAt: string;
	title: string;
	narrative: string;
	keyDecisions: string[];
	filesModified: string[];
	concepts: string[];
	observationCount: number;
	agentId?: string;
}

/** 会话记录 — 独立 KV scope mem:sessions（session_start / observe 时注册） */
export interface SessionRecord {
	id: string;
	agentId: string;
	startedAt: string;
	updatedAt: string;
	status: string;
	observationCount: number;
	project?: string;
	cwd?: string;
	firstPrompt?: string;
}

/** 访问日志 — 独立 KV scope mem:access */
export interface AccessLog {
	memoryId: string;
	count: number;
	lastAt: string;
	recent: number[];
}

/** 保留评分 — 独立 KV scope mem:retention */
export interface RetentionScore {
	memoryId: string;
	source: 'episodic' | 'semantic' | 'procedural';
	score: number;
	salience: number;
	temporalDecay: number;
	reinforcementBoost: number;
	lastAccessed: number;
	accessCount: number;
}

/** 上下文块 — 对齐 agentmemory ContextBlock */
export interface ContextBlock {
	type: 'summary' | 'observation' | 'memory' | 'lesson' | 'slot' | 'core' | 'routine' | 'crystal';
	content: string;
	tokens: number;
	recency: number;
	priority?: number;
	sourceIds?: string[];
}

/** 搜索结果 */
export interface SearchResult {
	id: string;
	content: string;
	score: number;
	source: 'bm25' | 'vector' | 'graph' | 'hybrid' | 'kv';
	/** 记忆关联会话（diversifyBySession 用；remember 写入的全局记忆为空数组） */
	sessionIds?: string[];
}

/**
 * agentmemory 原版类型模型（2026-07-27 对齐，不再做 4-Tier→fact 坍缩/路由）：
 * - 层类型（Layer，各有独立 scope）：working→mem:core-memory、semantic→mem:semantic、procedural→mem:procedural
 * - Episodic 原生类型（KV.memories 内 Memory.type）：pattern/preference/architecture/bug/workflow/fact
 * 不再有 'episodic' 作为 type 值——Episodic 是「层」，其条目一律用原生类型。
 */

/** Episodic 原生类型（KV.memories 内 Memory.type 的合法值） */
export const EPISODIC_TYPES = ['pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact'] as const;
export type AmEpisodicType = typeof EPISODIC_TYPES[number];

/** 层类型（各有独立 scope 的 agentmemory 层） */
export type AmLayerType = 'working' | 'semantic' | 'procedural';

/** 合法记忆 type 全集 = 层类型 ∪ Episodic 原生类型（不含 'episodic'） */
export type AmMemoryType = AmLayerType | AmEpisodicType;

/** type → 所属层（agentmemory 原版 4 层模型），供展示分组用 */
export function layerOfType(type: string): 'working' | 'episodic' | 'semantic' | 'procedural' {
	if (type === 'working') { return 'working'; }
	if (type === 'semantic') { return 'semantic'; }
	if (type === 'procedural') { return 'procedural'; }
	return 'episodic';
}

/** IMemoryEntry 兼容接口 — type 字段使用 agentmemory 原生类型（层类型或 Episodic 原生类型） */
export interface IMemoryEntry {
	id: string;
	type: AmMemoryType | string;
	content: string;
	metadata?: Record<string, unknown>;
	timestamp?: number;
	importance?: number;
	score?: number;
}

/** 记忆插槽 — 对齐 agentmemory MemorySlot */
export interface MemorySlot {
	label: string;
	content: string;
	sizeLimit: number;
	description: string;
	pinned: boolean;
	readOnly: boolean;
	scope: 'project' | 'global';
	createdAt: string;
	updatedAt: string;
}

/** IMemoryContext 兼容接口 */
export interface IMemoryContext {
	shortTermMemories: IMemoryEntry[];
	longTermMemories: IMemoryEntry[];
	systemPrompt: string;
	relevantDocuments: unknown[];
	/** 注入策展块数量（对齐原版 mem::context 返回的 blocks 元数据） */
	contextBlocks?: number;
	/** 注入实际占用 token 数（含 header/footer，对齐原版 tokens 元数据） */
	contextTokens?: number;
}
