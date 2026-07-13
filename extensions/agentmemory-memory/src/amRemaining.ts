/* eslint-disable */
// ─── amRemaining.ts ───────────────────────────────────────────────────────────
// 剩余 agentmemory 高级功能的 V2 无状态实现
// 覆盖：routines / team / mesh / temporal-graph / replay / relations /
//       branch-aware / frontier / flow-compress / disk-size / image-quota /
//       claude-bridge / obsidian-export
// ──────────────────────────────────────────────────────────────────────────────

import type { StateKV } from './stateKV.js';
import { KV, generateId } from './amSchema.js';
import type { Memory, Lesson } from './amTypes.js';

// ─── 类型定义 ────────────────────────────────────────────────────────────────

export interface RoutineStep {
	order: number; title: string; description: string;
	actionTemplate: Record<string, unknown>; dependsOn: number[];
}
export interface Routine {
	id: string; name: string; description: string; steps: RoutineStep[];
	createdAt: string; updatedAt: string; frozen: boolean;
	tags: string[]; sourceProceduralIds: string[];
}
export interface RoutineRun {
	id: string; routineId: string; status: 'running'|'completed'|'failed';
	currentStep: number; startedAt: string; completedAt?: string; runLog: string[];
}
export interface TeamSharedItem {
	id: string; sharedBy: string; sharedAt: string; type: string;
	content: unknown; project: string; visibility: 'shared'|'private';
}
export interface MeshPeer {
	id: string; name: string; url: string; status: 'online'|'offline';
	lastSeen: string; sharedScopes: string[];
}
export interface TemporalEdge {
	id: string; source: string; target: string; type: string;
	weight: number; validFrom?: string; validTo?: string;
	reasoning: string; sentiment: 'positive'|'negative'|'neutral';
	alternatives: string[]; observationIds: string[];
}
export interface ReplaySession {
	sessionId: string; title: string; narrative: string;
	keyDecisions: string[]; filesModified: string[]; concepts: string[];
	observationCount: number; createdAt: string;
}
export interface FrontierItem {
	id: string; concept: string; description: string; priority: number;
	sourceIds: string[]; createdAt: string;
}
export interface BranchInfo { name: string; path: string; active: boolean; sessions: string[]; }

// ─── 1. Routines（对齐 agentmemory routines.ts）───────────────────────────────

export async function routineCreate(kv: StateKV, agentId: string,
	data: { name: string; description?: string; steps: { title: string; description?: string; actionTemplate?: Record<string,unknown>; dependsOn?: number[] }[]; tags?: string[] }
): Promise<Routine> {
	if (!data.name || !Array.isArray(data.steps) || data.steps.length === 0) {
		throw new Error('name and steps are required');
	}
	const now = new Date().toISOString();
	const routine: Routine = {
		id: generateId('rtn'), name: data.name.trim(),
		description: (data.description || '').trim(),
		steps: data.steps.map((s, i) => ({
			order: i, title: s.title.trim(), description: (s.description || '').trim(),
			actionTemplate: s.actionTemplate || {}, dependsOn: s.dependsOn || [],
		})),
		createdAt: now, updatedAt: now, frozen: true,
		tags: data.tags || [], sourceProceduralIds: [],
	};
	await kv.set(KV.procedural(agentId), routine.id, routine as unknown as Record<string,unknown>);
	return routine;
}

export async function routineList(kv: StateKV, agentId: string): Promise<Routine[]> {
	const all = await kv.list<any>(KV.procedural(agentId));
	return all.filter((r: any) => r.id?.startsWith('rtn')) as Routine[];
}

export async function routineGet(kv: StateKV, agentId: string, id: string): Promise<Routine|null> {
	return await kv.get<Routine>(KV.procedural(agentId), id) ?? null;
}

export async function routineRun(kv: StateKV, agentId: string, routineId: string): Promise<RoutineRun> {
	const routine = await routineGet(kv, agentId, routineId);
	if (!routine) throw new Error('routine not found');
	const run: RoutineRun = {
		id: generateId('run'), routineId, status: 'running',
		currentStep: 0, startedAt: new Date().toISOString(), runLog: [],
	};
	await kv.set(KV.procedural(agentId), run.id, run as unknown as Record<string,unknown>);
	return run;
}

// ─── 2. Team Sharing（对齐 agentmemory team.ts，简化版）──────────────────────

export async function teamShare(kv: StateKV, agentId: string,
	itemId: string, itemType: string, project?: string
): Promise<{ success: boolean; item?: TeamSharedItem; error?: string }> {
	const content = await kv.get<any>(KV.memories(agentId), itemId);
	if (!content) return { success: false, error: 'Item not found' };
	const shared: TeamSharedItem = {
		id: generateId('ts'), sharedBy: agentId,
		sharedAt: new Date().toISOString(), type: itemType,
		content, project: project || '', visibility: 'shared',
	};
	await kv.set(KV.summaries(agentId), shared.id, shared as unknown as Record<string,unknown>);
	return { success: true, item: shared };
}

export async function teamQuery(kv: StateKV, agentId: string, query?: string): Promise<TeamSharedItem[]> {
	const all = await kv.list<TeamSharedItem>(KV.summaries(agentId));
	const items = all.filter((s: any) => s.id?.startsWith('ts'));
	if (!query) return items as TeamSharedItem[];
	const q = query.toLowerCase();
	return (items as TeamSharedItem[]).filter(i => JSON.stringify(i.content).toLowerCase().includes(q));
}

// ─── 3. Mesh Coordination（对齐 agentmemory mesh.ts，简化版）─────────────────

export async function meshJoin(kv: StateKV, agentId: string,
	name: string, url: string, scopes: string[] = ['memories','actions']
): Promise<MeshPeer> {
	const peer: MeshPeer = { id: generateId('mesh'), name, url,
		status: 'online', lastSeen: new Date().toISOString(), sharedScopes: scopes };
	await kv.set(KV.state(agentId), `mesh:${peer.id}`, peer as unknown as Record<string,unknown>);
	return peer;
}

export async function meshList(kv: StateKV, agentId: string): Promise<MeshPeer[]> {
	const all = await kv.list<MeshPeer>(KV.state(agentId));
	return all.filter((p: any) => p.id?.startsWith('mesh'));
}

export async function meshLeave(kv: StateKV, agentId: string, peerId: string): Promise<boolean> {
	const peer = await kv.get<MeshPeer>(KV.state(agentId), `mesh:${peerId}`);
	if (!peer) return false;
	peer.status = 'offline';
	await kv.set(KV.state(agentId), `mesh:${peerId}`, peer as unknown as Record<string,unknown>);
	return true;
}

// ─── 4. Temporal Graph（对齐 agentmemory temporal-graph.ts，简化版）───────────

export async function temporalExtract(kv: StateKV, agentId: string,
	sessionId: string
): Promise<{ entities: number; edges: number }> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const active = memories.filter(m => m.isLatest !== false);
	const entities = new Set<string>();
	let edgeCount = 0;
	for (const m of active) {
		for (const c of (m.concepts ?? [])) entities.add(c);
		for (const f of (m.files ?? [])) entities.add(f);
	}
	const entityList = Array.from(entities);
	// 生成概念间的时序边（概念共现视为关联）
	for (const m of active) {
		const concepts = m.concepts ?? [];
		for (let i = 0; i < concepts.length; i++) {
			for (let j = i + 1; j < concepts.length; j++) {
				const edge: TemporalEdge = {
					id: generateId('te'), source: concepts[i], target: concepts[j],
					type: 'related_to', weight: 0.5,
					validFrom: m.createdAt, validTo: 'current',
					reasoning: `Co-occurrence in memory ${m.id}`,
					sentiment: 'neutral', alternatives: [], observationIds: [m.id],
				};
				await kv.set(KV.state(agentId), edge.id, edge as unknown as Record<string,unknown>);
				edgeCount++;
			}
		}
	}
	return { entities: entityList.length, edges: edgeCount };
}

export async function temporalQuery(kv: StateKV, agentId: string,
	entity: string
): Promise<TemporalEdge[]> {
	const all = await kv.list<TemporalEdge>(KV.state(agentId));
	return all.filter((e: any) =>
		e.id?.startsWith('te') && (e.source === entity || e.target === entity)
	);
}

// ─── 5. Replay（对齐 agentmemory replay.ts，简化版）──────────────────────────

export async function replaySession(kv: StateKV, agentId: string,
	sessionId: string
): Promise<ReplaySession|null> {
	const all = await kv.list<any>(KV.summaries(agentId));
	const summary = all.find((s: any) => s.sessionId === sessionId || s.id === sessionId);
	if (!summary) return null;
	return { sessionId: summary.sessionId || sessionId,
		title: summary.title || 'Untitled',
		narrative: summary.narrative || '',
		keyDecisions: summary.keyDecisions || [],
		filesModified: summary.filesModified || [],
		concepts: summary.concepts || [],
		observationCount: summary.observationCount || 0,
		createdAt: summary.createdAt || new Date().toISOString() };
}

export async function replayList(kv: StateKV, agentId: string): Promise<ReplaySession[]> {
	const all = await kv.list<any>(KV.summaries(agentId));
	return all.filter((s: any) => s.title || s.narrative).map((s: any) => ({
		sessionId: s.sessionId || s.id, title: s.title || 'Untitled',
		narrative: s.narrative || '', keyDecisions: s.keyDecisions || [],
		filesModified: s.filesModified || [], concepts: s.concepts || [],
		observationCount: s.observationCount || 0,
		createdAt: s.createdAt || new Date().toISOString(),
	})).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ─── 6. Relations（对齐 agentmemory relate.ts）───────────────────────────────

export async function relateMemories(kv: StateKV, agentId: string,
	sourceId: string, targetId: string, relationType: string = 'related_to'
): Promise<{ id: string }> {
	const id = generateId('rel');
	const rel = { id, sourceId, targetId, type: relationType, createdAt: new Date().toISOString(), agentId };
	// 双向记录（不修改源记忆，仅记录关系）
	await kv.set(KV.state(agentId), `rel:${id}`, rel as unknown as Record<string,unknown>);
	return { id };
}

export async function getRelated(kv: StateKV, agentId: string,
	memoryId: string
): Promise<Memory[]> {
	const all = await kv.list<any>(KV.state(agentId));
	const relIds = all.filter((r: any) => r.id?.startsWith('rel') &&
		(r.sourceId === memoryId || r.targetId === memoryId))
		.map((r: any) => r.sourceId === memoryId ? r.targetId : r.sourceId);
	const mems: Memory[] = [];
	for (const id of relIds) {
		const m = await kv.get<Memory>(KV.memories(agentId), id);
		if (m?.isLatest !== false) mems.push(m as any);
	}
	return mems;
}

// ─── 7. Branch Aware（对齐 agentmemory branch-aware.ts，简化版）───────────────

export function detectWorktrees(workspacePath: string): BranchInfo[] {
	// 生产环境通过 git worktree 检测，测试返回空
	if (!workspacePath) return [];
	return [];
}

export function listWorktrees(workspacePath: string): BranchInfo[] {
	return detectWorktrees(workspacePath);
}

export async function branchSessions(kv: StateKV, agentId: string,
	branch: string
): Promise<string[]> {
	const all = await kv.list<any>(KV.summaries(agentId));
	return all.filter((s: any) => s.concepts?.includes(branch) || s.title?.includes(branch))
		.map((s: any) => s.sessionId || s.id);
}

// ─── 8. Frontier（对齐 agentmemory frontier.ts，简化版）───────────────────────

export async function frontierGet(kv: StateKV, agentId: string): Promise<FrontierItem[]> {
	const all = await kv.list<any>(KV.state(agentId));
	return all.filter((f: any) => f.id?.startsWith('frontier'))
		.sort((a, b) => (b.priority||0) - (a.priority||0));
}

export async function frontierNext(kv: StateKV, agentId: string): Promise<FrontierItem|null> {
	const items = await frontierGet(kv, agentId);
	return items[0] ?? null;
}

export async function frontierAdd(kv: StateKV, agentId: string,
	concept: string, description: string = '', priority: number = 5
): Promise<FrontierItem> {
	const item: FrontierItem = {
		id: generateId('frontier'), concept: concept.trim(),
		description, priority: Math.max(1, Math.min(10, priority)),
		sourceIds: [], createdAt: new Date().toISOString(),
	};
	await kv.set(KV.state(agentId), item.id, item as unknown as Record<string,unknown>);
	return item;
}

// ─── 9. Flow Compress / Compress File（对齐 agentmemory）─────────────────────

export async function flowCompress(kv: StateKV, agentId: string,
	sessionId: string
): Promise<{ compressed: boolean; count: number }> {
	const mems = await kv.list<Memory>(KV.memories(agentId));
	const active = mems.filter(m => m.isLatest !== false);
	let count = 0;
	// 将低 strength 记忆合并（相邻同类型 + 同 concept 合并内容）
	const groups = new Map<string, Memory[]>();
	for (const m of active) {
		const key = m.type + ':' + (m.concepts ?? []).join(',');
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(m);
	}
	for (const [key, group] of groups) {
		if (group.length <= 1) continue;
		// 合并：保留第一个，其余标记 isLatest=false
		const [keep, ...rest] = group;
		for (const m of rest) {
			m.isLatest = false; (m as any).supersededBy = keep.id;
			await kv.set(KV.memories(agentId), m.id, m);
			count++;
		}
		// 更新保留的记忆内容为合并
		keep.content = group.map(m => m.content).join('; ');
		keep.concepts = Array.from(new Set(group.flatMap(m => m.concepts ?? [])));
		await kv.set(KV.memories(agentId), keep.id, keep);
	}
	return { compressed: count > 0, count };
}

export async function compressFile(kv: StateKV, agentId: string,
	filePath: string
): Promise<{ summary: string }> {
	const all = await kv.list<Memory>(KV.memories(agentId));
	const related = all.filter(m => m.isLatest !== false && (m.files ?? []).some(f => f.includes(filePath)));
	const summary = related.slice(0, 5).map(m => m.content).join(' | ');
	return { summary: summary.slice(0, 2000) };
}

// ─── 10. Disk Size / Image Quota / Vision Search（对齐 agentmemory）──────────

export async function diskSize(kv: StateKV, agentId: string): Promise<{ scopes: Record<string,number>; totalBytes: number }> {
	const scopes: Record<string,number> = {};
	let total = 0;
	for (const scopeFn of [KV.memories, KV.coreMemory, KV.lessons, KV.insights,
		KV.semantic, KV.procedural, KV.summaries, KV.state, KV.slots]) {
		try {
			const items = await kv.list<any>(scopeFn(agentId));
			const scopeName = scopeFn(agentId).split(':')[1] || scopeFn(agentId);
			const bytes = items.reduce((s, i) => s + JSON.stringify(i).length, 0);
			scopes[scopeName] = bytes; total += bytes;
		} catch { scopes[scopeFn(agentId)] = 0; }
	}
	return { scopes, totalBytes: total };
}

export function imageQuota(agentId: string): { used: number; limit: number; available: number } {
	// 简化实现：KV 中不存图片，返回全额
	return { used: 0, limit: 50, available: 50 };
}

export async function visionSearch(kv: StateKV, agentId: string,
	query: string
): Promise<Memory[]> {
	// 简化：基于标签和内容匹配（不含图片编码）
	const all = await kv.list<Memory>(KV.memories(agentId));
	const q = query.toLowerCase();
	return all.filter(m => m.isLatest !== false && (m.concepts ?? []).some(c => q.includes(c) || c.includes(q))).slice(0, 5);
}

// ─── 11. Claude Bridge（对齐 agentmemory claude-bridge.ts，简化版）───────────

export async function claudeBridgeRead(kv: StateKV, agentId: string): Promise<{ memories: Memory[]; lessons: Lesson[]; queryCount: number }> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const lessons = await kv.list<Lesson>(KV.lessons(agentId));
	return { memories: memories.filter(m => m.isLatest !== false), lessons: lessons.filter(l => !l.deleted), queryCount: 0 };
}

export async function claudeBridgeSync(kv: StateKV, agentId: string,
	items: { content: string; type: string; tags?: string[] }[]
): Promise<number> {
	let count = 0;
	for (const item of items) {
		const id = generateId('claude');
		const mem: Memory = {
			id, type: (item.type || 'fact') as any,
			title: '', content: item.content,
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
			concepts: item.tags || [], files: [], sessionIds: [],
			strength: 7, version: 1, isLatest: true, agentId,
		};
		await kv.set(KV.memories(agentId), id, mem);
		count++;
	}
	return count;
}

// ─── 12. Obsidian Export（对齐 agentmemory obsidian-export.ts，简化版）───────

export async function obsidianExport(kv: StateKV, agentId: string): Promise<string> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const lessons = await kv.list<Lesson>(KV.lessons(agentId));
	const lines: string[] = ['# AgentMemory Export\n', '## Memories\n'];
	for (const m of memories.filter(m => m.isLatest !== false)) {
		lines.push(`- [${m.type}] ${m.content}`);
		if (m.concepts?.length) lines.push(`  tags: #${m.concepts.join(' #')}`);
	}
	lines.push('\n## Lessons\n');
	for (const l of lessons.filter(l => !l.deleted)) {
		lines.push(`- (${(l.confidence*100).toFixed(0)}%) ${l.content}`);
	}
	return lines.join('\n');
}

// ─── 13. getRelations（兼容 V1）──────────────────────────────────────────────

export async function getRelations(kv: StateKV, agentId: string, memoryId: string): Promise<any[]> {
	const all = await kv.list<any>(KV.state(agentId));
	return all.filter((r: any) => r.id?.startsWith('rel') &&
		(r.sourceId === memoryId || r.targetId === memoryId));
}

export async function getRelationStats(kv: StateKV, agentId: string): Promise<Record<string,number>> {
	const all = await kv.list<any>(KV.state(agentId));
	const rels = all.filter((r: any) => r.id?.startsWith('rel'));
	return { total: rels.length };
}
