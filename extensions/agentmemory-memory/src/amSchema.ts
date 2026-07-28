/*---------------------------------------------------------------------------------------------
 *  KV Schema — 1:1 对齐 agentmemory src/state/schema.ts
 *  按 scope 分区，每条记忆是独立 KV key-value。
 *  废弃旧的 JSONL 批量序列化模式。
 *--------------------------------------------------------------------------------------------*/

/** KV scope 常量 — 每个 scope 对应一种记忆类型，per-agent 隔离 */
export const KV = {
	sessions: (agentId: string) => `mem:sessions:${agentId}`,
	observations: (agentId: string, sessionId: string) => `mem:obs:${agentId}:${sessionId}`,
	memories: (agentId: string) => `mem:memories:${agentId}`,
	summaries: (agentId: string) => `mem:summaries:${agentId}`,
	config: (agentId: string) => `mem:config:${agentId}`,
	embeddings: (agentId: string, obsId: string) => `mem:emb:${agentId}:${obsId}`,
	bm25Index: (agentId: string) => `mem:index:bm25:${agentId}`,
	relations: (agentId: string) => `mem:relations:${agentId}`,
	profiles: (agentId: string) => `mem:profiles:${agentId}`,
	graphNodes: (agentId: string) => `mem:graph:nodes:${agentId}`,
	graphEdges: (agentId: string) => `mem:graph:edges:${agentId}`,
	semantic: (agentId: string) => `mem:semantic:${agentId}`,
	procedural: (agentId: string) => `mem:procedural:${agentId}`,
	coreMemory: (agentId: string) => `mem:core-memory:${agentId}`,
	audit: (agentId: string) => `mem:audit:${agentId}`,
	actions: (agentId: string) => `mem:actions:${agentId}`,
	lessons: (agentId: string) => `mem:lessons:${agentId}`,
	insights: (agentId: string) => `mem:insights:${agentId}`,
	retentionScores: (agentId: string) => `mem:retention:${agentId}`,
	accessLog: (agentId: string) => `mem:access:${agentId}`,
	slots: (agentId: string) => `mem:slots:${agentId}`,
	state: (agentId: string) => `mem:state:${agentId}`,
	recentSearches: (agentId: string) => `mem:recent-searches:${agentId}`,
	checkpoints: (agentId: string) => `mem:checkpoints:${agentId}`,
	leases: (agentId: string) => `mem:leases:${agentId}`,
	signals: (agentId: string) => `mem:signals:${agentId}`,
	sketches: (agentId: string) => `mem:sketches:${agentId}`,
	sentinels: (agentId: string) => `mem:sentinels:${agentId}`,
	snapshots: (agentId: string) => `mem:snapshots:${agentId}`,
	crystals: (agentId: string) => `mem:crystals:${agentId}`,
	facets: (agentId: string) => `mem:facets:${agentId}`,
	auditLog: (agentId: string) => `mem:audit:${agentId}`,
	commitLog: (agentId: string) => `mem:commits:${agentId}`,
	hookLog: (agentId: string) => `mem:hooks:${agentId}`,
	skillStore: (agentId: string) => `mem:skills:${agentId}`,
	circuitStates: (agentId: string) => `mem:circuits:${agentId}`,
	dedupStore: (agentId: string) => `mem:dedup:${agentId}`,
	// ─── 团队共享（全局 scope，不带 agentId —— 对齐原版 mem:team:<teamId>:*）───
	// D1 修复（doc §13）：此前误用 per-agent summaries scope，导致①其他 agent
	// 永远看不到共享条目②TeamSharedItem 混入摘要被 buildContext 当摘要注入。
	teamShared: (teamId: string) => `mem:team:${teamId}:shared`,
	teamProfile: (teamId: string) => `mem:team:${teamId}:profile`,
} as const;

/** 生成 ID — 对齐 agentmemory generateId */
export function generateId(prefix: string): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 14);
	return `${prefix}_${ts}_${rand}`;
}

/**
 * 纯 JS 内容哈希（双 32-bit 乘积混合，输出 16 hex）。
 * 替代 node:crypto createHash('sha256')，渲染进程兼容。
 * 仅用于去重指纹，非安全场景，无需密码级强度。
 */
function contentHash(content: string): string {
	let h1 = 0xdeadbeef | 0;
	let h2 = 0x41c6ce57 | 0;
	for (let i = 0; i < content.length; i++) {
		const ch = content.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
}

/** 基于 content 指纹生成 ID — 对齐 agentmemory fingerprintId */
export function fingerprintId(prefix: string, content: string): string {
	const hash = contentHash(content);
	return `${prefix}_${hash.slice(0, 16)}`;
}

/** Jaccard 相似度 — 对齐 agentmemory jaccardSimilarity */
export function jaccardSimilarity(a: string, b: string): number {
	const setA = new Set(a.split(/\s+/).filter(t => t.length > 2));
	const setB = new Set(b.split(/\s+/).filter(t => t.length > 2));
	if (setA.size === 0 && setB.size === 0) return 1;
	if (setA.size === 0 || setB.size === 0) return 0;
	let intersection = 0;
	for (const word of setA) {
		if (setB.has(word)) intersection++;
	}
	return intersection / (setA.size + setB.size - intersection);
}

/** 估算 token 数 — 对齐 agentmemory estimateTokens */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3);
}
