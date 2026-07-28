/*---------------------------------------------------------------------------------------------
 *  amReplication.ts — agentmemory 原版机制补全复刻
 *
 *  移植自 agentmemory src/functions/ 的剩余缺口（对比分析见
 *  doc/memory-mechanism-comparison.html 9.6 节）：
 *
 *    slots.ts     → slotCreate / slotAppend / slotReplace / slotDelete
 *    reflect.ts   → insightSearch / insightDecaySweep（数据层；LLM 反思生成由
 *                   session_end 链 slotReflect 承担，不在本模块）
 *    sketches.ts  → sketchAdd / sketchGc
 *    snapshot.ts  → snapshotRestore（snapshotCreate 增强为全量存储，见 amAdvanced）
 *    routines.ts  → routineStatus / routineFreeze
 *    signals.ts   → signalThreads / signalCleanup
 *    team.ts      → teamFeed / teamProfile
 *    graph.ts     → graphBuild / graphReset
 *
 *  适配说明：
 *  - 原版为单租户全局 KV，本移植版全部按 agentId 隔离（KV.*(agentId)）
 *  - 原版 snapshot 用 git 版本化 state.json；本移植版把完整记忆快照存 KV.snapshots
 *  - 原版 recordAudit 治理审计此处从简（治理审计已由 amExtras.auditLog 承担，
 *    高级工具 memory_governance audit 可查）
 *--------------------------------------------------------------------------------------------*/

import type { Memory, MemorySlot, Insight } from './amTypes.js';
import { KV, generateId } from './amSchema.js';
import { StateKV } from './stateKV.js';
import type { Sketch, SignalMsg } from './amAdvanced.js';
import type { Routine, RoutineRun, TeamSharedItem } from './amRemaining.js';
import * as pipe from './amPipeline.js';
import { deleteAccessLog } from './amFunctions.js';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Slots（对齐 agentmemory functions/slots.ts mem::slot-create/append/replace/delete）
// ═══════════════════════════════════════════════════════════════════════════

const SLOT_LABEL_RE = /^[a-z][a-z0-9_]*$/;

function validateSlotLabel(label: unknown): string | null {
	if (typeof label !== 'string') return null;
	const l = label.trim();
	return SLOT_LABEL_RE.test(l) ? l : null;
}

export async function slotCreate(
	kv: StateKV, agentId: string,
	data: { label: string; content?: string; sizeLimit?: number; description?: string; pinned?: boolean; scope?: 'project' | 'global' },
): Promise<{ success: boolean; slot?: MemorySlot; error?: string }> {
	const label = validateSlotLabel(data?.label);
	if (!label) return { success: false, error: 'label required (lowercase, starts with letter, [a-z0-9_])' };
	const sizeLimit = data.sizeLimit ?? 2000;
	if (!Number.isInteger(sizeLimit) || sizeLimit < 1 || sizeLimit > 20000) {
		return { success: false, error: 'sizeLimit must be an integer between 1 and 20000' };
	}
	const content = typeof data.content === 'string' ? data.content : '';
	if (content.length > sizeLimit) {
		return { success: false, error: `content exceeds sizeLimit (${content.length} > ${sizeLimit})` };
	}
	const scope = KV.slots(agentId);
	const existing = await kv.get<MemorySlot>(scope, label);
	if (existing) return { success: false, error: 'slot already exists' };
	const ts = new Date().toISOString();
	const slot: MemorySlot = {
		label, content, sizeLimit,
		description: typeof data.description === 'string' ? data.description : '',
		pinned: typeof data.pinned === 'boolean' ? data.pinned : true,
		readOnly: false, scope: data.scope ?? 'project',
		createdAt: ts, updatedAt: ts,
	};
	await kv.set(scope, label, slot);
	return { success: true, slot };
}

export async function slotAppend(
	kv: StateKV, agentId: string, label: string, text: string,
): Promise<{ success: boolean; slot?: MemorySlot; size?: number; currentSize?: number; sizeLimit?: number; error?: string }> {
	const l = validateSlotLabel(label);
	if (!l) return { success: false, error: 'label required' };
	if (typeof text !== 'string' || !text) return { success: false, error: 'text required' };
	const slot = await kv.get<MemorySlot>(KV.slots(agentId), l);
	if (!slot) return { success: false, error: 'slot not found (use slotCreate first)' };
	if (slot.readOnly) return { success: false, error: 'slot is read-only' };
	const sep = slot.content && !slot.content.endsWith('\n') ? '\n' : '';
	const next = `${slot.content}${sep}${text}`;
	if (next.length > slot.sizeLimit) {
		return {
			success: false,
			error: `append would exceed sizeLimit (${next.length} > ${slot.sizeLimit}). Use slotReplace to compact first.`,
			currentSize: slot.content.length, sizeLimit: slot.sizeLimit,
		};
	}
	const updated: MemorySlot = { ...slot, content: next, updatedAt: new Date().toISOString() };
	await kv.set(KV.slots(agentId), l, updated);
	return { success: true, slot: updated, size: next.length };
}

export async function slotReplace(
	kv: StateKV, agentId: string, label: string, content: string,
): Promise<{ success: boolean; slot?: MemorySlot; size?: number; error?: string }> {
	const l = validateSlotLabel(label);
	if (!l) return { success: false, error: 'label required' };
	if (typeof content !== 'string') return { success: false, error: 'content required (string)' };
	const slot = await kv.get<MemorySlot>(KV.slots(agentId), l);
	if (!slot) return { success: false, error: 'slot not found (use slotCreate first)' };
	if (slot.readOnly) return { success: false, error: 'slot is read-only' };
	if (content.length > slot.sizeLimit) {
		return { success: false, error: `content exceeds sizeLimit (${content.length} > ${slot.sizeLimit})`, };
	}
	const updated: MemorySlot = { ...slot, content, updatedAt: new Date().toISOString() };
	await kv.set(KV.slots(agentId), l, updated);
	return { success: true, slot: updated, size: content.length };
}

export async function slotDelete(
	kv: StateKV, agentId: string, label: string,
): Promise<{ success: boolean; error?: string }> {
	const l = validateSlotLabel(label);
	if (!l) return { success: false, error: 'label required' };
	const slot = await kv.get<MemorySlot>(KV.slots(agentId), l);
	if (!slot) return { success: false, error: 'slot not found' };
	if (slot.readOnly) return { success: false, error: 'slot is read-only' };
	await kv.delete(KV.slots(agentId), l);
	return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Insights 数据层（对齐 agentmemory mem::insight-list/search/decay-sweep）
// ═══════════════════════════════════════════════════════════════════════════

export async function insightSearch(kv: StateKV, agentId: string, query: string, limit = 20): Promise<Insight[]> {
	const all = await kv.list<Insight>(KV.insights(agentId));
	if (!query?.trim()) {
		return all.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
	}
	const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
	const scored = all
		.map(i => {
			const text = `${i.content} ${(i.tags ?? []).join(' ')}`.toLowerCase();
			const hits = terms.filter(t => text.includes(t)).length;
			return { i, score: hits / Math.max(terms.length, 1) + i.confidence * 0.01 };
		})
		.filter(s => s.score > 0.01);
	return scored
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(s => s.i);
}

const INSIGHT_DECAY_RATE = 0.05;
const INSIGHT_PRUNE_THRESHOLD = 0.1;

/** 洞察衰减扫描：confidence 按固定速率衰减，低于阈值则清除（对齐 lessonDecaySweep 语义） */
export async function insightDecaySweep(kv: StateKV, agentId: string): Promise<{ decayed: number; pruned: number }> {
	const all = await kv.list<Insight>(KV.insights(agentId));
	let decayed = 0;
	let pruned = 0;
	for (const i of all) {
		i.confidence = Math.max(0, i.confidence * (1 - INSIGHT_DECAY_RATE));
		if (i.confidence < INSIGHT_PRUNE_THRESHOLD) {
			await kv.delete(KV.insights(agentId), i.id);
			pruned++;
		} else {
			await kv.set(KV.insights(agentId), i.id, i);
			decayed++;
		}
	}
	return { decayed, pruned };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Sketch 生命周期（对齐 agentmemory sketches.ts addAction/gc）
// ═══════════════════════════════════════════════════════════════════════════

/** 向既有 sketch 追加 action id（对齐 SketchManager.addAction 的 KV 函数版） */
export async function sketchAdd(
	kv: StateKV, agentId: string, sketchId: string, actionId: string,
): Promise<{ success: boolean; sketch?: Sketch; error?: string }> {
	const sketch = await kv.get<Sketch>(KV.sketches(agentId), sketchId);
	if (!sketch) return { success: false, error: 'sketch not found' };
	if (sketch.status !== 'active') return { success: false, error: `sketch is ${sketch.status}` };
	if (!sketch.actionIds.includes(actionId)) {
		sketch.actionIds.push(actionId);
	}
	await kv.set(KV.sketches(agentId), sketch.id, sketch);
	return { success: true, sketch };
}

/** GC：过期且未 promote 的 sketch 标记为 discarded（对齐 SketchManager.gc） */
export async function sketchGc(kv: StateKV, agentId: string): Promise<{ discarded: number }> {
	const all = await kv.list<Sketch>(KV.sketches(agentId));
	const now = Date.now();
	let discarded = 0;
	for (const s of all) {
		if (s.status === 'active' && s.expiresAt && Date.parse(s.expiresAt) <= now) {
			s.status = 'discarded';
			await kv.set(KV.sketches(agentId), s.id, s);
			discarded++;
		}
	}
	return { discarded };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Snapshot 恢复（对齐 agentmemory mem::snapshot-restore）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从快照恢复记忆数据（对齐原版 checkout state.json 后重载的语义）：
 * 快照中的记录按 id upsert 回 KV；快照之后新产生的记录不受影响；
 * 快照数据由增强版 snapshotCreate（amAdvanced）以 `memories` 字段全量存储，
 * 旧格式快照（仅 memoryIds）返回 unsupported 错误。
 */
export async function snapshotRestore(
	kv: StateKV, agentId: string, snapshotId: string,
): Promise<{ success: boolean; restored?: number; error?: string }> {
	const snap = await kv.get<{ id: string; data: Record<string, unknown> }>(KV.snapshots(agentId), snapshotId);
	if (!snap) return { success: false, error: 'snapshot not found' };
	const memories = (snap.data as { memories?: Memory[] }).memories;
	if (!Array.isArray(memories)) {
		return { success: false, error: 'snapshot is in legacy format (ids only, no full data) — cannot restore' };
	}
	let restored = 0;
	for (const m of memories) {
		if (m?.id) {
			await kv.set(KV.memories(agentId), m.id, m);
			restored++;
		}
	}
	return { success: true, restored };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Routine 状态（对齐 agentmemory mem::routine-status / mem::routine-freeze）
// ═══════════════════════════════════════════════════════════════════════════

export interface RoutineStatusResult {
	success: boolean;
	run?: RoutineRun;
	progress?: { total: number; done: number; active: number; pending: number };
	error?: string;
}

/**
 * 运行状态聚合（对齐原版：读取 run + routine，汇总步骤进度，
 * 全部完成时自动把 run 标记为 completed）。
 * 本移植版的 RoutineRun 以 currentStep 推进（不逐步建 action），
 * progress 按 currentStep 折算。
 */
export async function routineStatus(kv: StateKV, agentId: string, runId: string): Promise<RoutineStatusResult> {
	const all = await kv.list<RoutineRun>(KV.procedural(agentId));
	const run = all.find(r => r.id === runId);
	if (!run) return { success: false, error: 'run not found' };
	const routines = await kv.list<Routine>(KV.procedural(agentId));
	const routine = routines.find(r => r.id === run.routineId);
	const total = routine?.steps.length ?? 0;
	const done = Math.min(run.currentStep, total);
	if (total > 0 && done >= total && run.status === 'running') {
		run.status = 'completed';
		run.completedAt = new Date().toISOString();
		await kv.set(KV.procedural(agentId), run.id, run as unknown as Record<string, unknown>);
	}
	return {
		success: true, run,
		progress: { total, done, active: run.status === 'running' ? 1 : 0, pending: Math.max(total - done - (run.status === 'running' ? 1 : 0), 0) },
	};
}

/** 冻结/解冻 routine（原版 mem::routine-freeze 单向冻结；本移植版支持显式恢复） */
export async function routineFreeze(
	kv: StateKV, agentId: string, routineId: string, frozen = true,
): Promise<{ success: boolean; routine?: Routine; error?: string }> {
	const routines = await kv.list<Routine>(KV.procedural(agentId));
	const routine = routines.find(r => r.id === routineId);
	if (!routine) return { success: false, error: 'routine not found' };
	routine.frozen = frozen;
	routine.updatedAt = new Date().toISOString();
	await kv.set(KV.procedural(agentId), routine.id, routine as unknown as Record<string, unknown>);
	return { success: true, routine };
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Signal 线程与清理（对齐 agentmemory mem::signal-threads / mem::signal-cleanup）
// ═══════════════════════════════════════════════════════════════════════════

export interface SignalThread {
	threadId: string;
	messages: number;
	lastMessage: string;
	participants: string[];
}

/** 会话线程聚合：按 threadId（缺省回退信号自身 id）分组，统计消息数/参与者/最后时间 */
export async function signalThreads(kv: StateKV, agentId: string, limit = 20): Promise<{ success: boolean; threads: SignalThread[] }> {
	const signals = await kv.list<SignalMsg & { threadId?: string }>(KV.signals(agentId));
	const now = Date.now();
	const relevant = signals.filter(s => !s.expiresAt || Date.parse(s.expiresAt) > now);
	const threadMap = new Map<string, { threadId: string; messages: number; lastMessage: string; participants: Set<string> }>();
	for (const sig of relevant) {
		const tid = sig.threadId || sig.id;
		const existing = threadMap.get(tid);
		if (existing) {
			existing.messages++;
			existing.participants.add(sig.from);
			if (sig.to) existing.participants.add(sig.to);
			if (sig.createdAt > existing.lastMessage) existing.lastMessage = sig.createdAt;
		} else {
			const participants = new Set<string>([sig.from]);
			if (sig.to) participants.add(sig.to);
			threadMap.set(tid, { threadId: tid, messages: 1, lastMessage: sig.createdAt, participants });
		}
	}
	const threads = Array.from(threadMap.values())
		.map(t => ({ ...t, participants: Array.from(t.participants) }))
		.sort((a, b) => b.lastMessage.localeCompare(a.lastMessage))
		.slice(0, limit);
	return { success: true, threads };
}

/** 清理过期信号（对齐原版：物理删除 expiresAt 已过的条目） */
export async function signalCleanup(kv: StateKV, agentId: string): Promise<{ success: boolean; removed: number }> {
	const signals = await kv.list<SignalMsg>(KV.signals(agentId));
	const now = Date.now();
	let removed = 0;
	for (const sig of signals) {
		if (sig.expiresAt && Date.parse(sig.expiresAt) <= now) {
			await kv.delete(KV.signals(agentId), sig.id);
			removed++;
		}
	}
	return { success: true, removed };
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Team Feed / Profile（对齐 agentmemory mem::team-feed / mem::team-profile）
// ═══════════════════════════════════════════════════════════════════════════

/** 团队共享池时间线（对齐原版：visibility=shared，按 sharedAt 倒序）
 *  D1 修复：读全局 team scope（mem:team:<teamId>:shared），跨 agent 可见。 */
export async function teamFeed(kv: StateKV, agentId: string, limit = 20, teamId: string = 'default'): Promise<{ items: TeamSharedItem[]; total: number }> {
	const all = await kv.list<TeamSharedItem>(KV.teamShared(teamId));
	const shared = all.filter(i => i.visibility === 'shared');
	const sorted = shared
		.sort((a, b) => b.sharedAt.localeCompare(a.sharedAt))
		.slice(0, limit);
	return { items: sorted, total: shared.length };
}

export interface TeamProfileResult {
	members: string[];
	topConcepts: Array<{ concept: string; frequency: number }>;
	topFiles: Array<{ file: string; frequency: number }>;
	sharedPatterns: string[];
	totalSharedItems: number;
	updatedAt: string;
}

/** 团队画像：成员/高频概念/高频文件/共享模式聚合（对齐原版 mem::team-profile）
 *  D1 修复：读全局 team scope。 */
export async function teamProfile(kv: StateKV, agentId: string, teamId: string = 'default'): Promise<TeamProfileResult> {
	const items = await kv.list<TeamSharedItem>(KV.teamShared(teamId));
	const members = [...new Set(items.map(i => i.sharedBy))];
	const conceptCounts = new Map<string, number>();
	const fileCounts = new Map<string, number>();
	const patterns: string[] = [];
	for (const item of items) {
		if (item.type === 'memory' || item.type === 'pattern') {
			const mem = item.content as Memory;
			if (mem?.concepts) {
				for (const c of mem.concepts) conceptCounts.set(c, (conceptCounts.get(c) || 0) + 1);
			}
			if ((mem as { files?: string[] })?.files) {
				for (const f of (mem as { files?: string[] }).files!) fileCounts.set(f, (fileCounts.get(f) || 0) + 1);
			}
			if (item.type === 'pattern' && mem?.content) {
				patterns.push(mem.content.slice(0, 100));
			}
		}
	}
	return {
		members,
		topConcepts: [...conceptCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([concept, frequency]) => ({ concept, frequency })),
		topFiles: [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([file, frequency]) => ({ file, frequency })),
		sharedPatterns: patterns.slice(0, 10),
		totalSharedItems: items.length,
		updatedAt: new Date().toISOString(),
	};
}

/**
 * D1 一次性迁移（doc §13）：早期版本 teamShare 误写 per-agent summaries scope
 * （id 前缀 ts_*、含 sharedBy/project 字段的 TeamSharedItem）——搬迁到全局
 * team scope 并从 summaries 删除，恢复摘要块纯净 + 跨 agent 可见性。
 * 幂等：config scope 落 flag，后续 sweep 直接跳过。
 */
export async function migrateLegacyTeamShared(kv: StateKV, agentId: string): Promise<{ migrated: number; skipped?: boolean }> {
	const flagKey = 'teamSharedMigratedV1';
	const done = await kv.get<boolean>(KV.config(agentId), flagKey).catch(() => null);
	if (done) { return { migrated: 0, skipped: true }; }
	let migrated = 0;
	const all = await kv.list<Record<string, unknown>>(KV.summaries(agentId));
	for (const e of all) {
		const id = String(e['id'] ?? '');
		const sharedBy = e['sharedBy'] as string | undefined;
		if (!id.startsWith('ts') || !sharedBy) { continue; }
		const teamId = (e['project'] as string) || (e['teamId'] as string) || 'default';
		await kv.set(KV.teamShared(teamId), id, e);
		await kv.delete(KV.summaries(agentId), id);
		migrated++;
	}
	await kv.set(KV.config(agentId), flagKey, true);
	return { migrated };
}

/**
 * L1-L3 一次性清洗（doc §17，2026-07-26）：客户端 L1-L3 提炼管线已移除，
 * 其历史产物（id 前缀 l1-extract- / l2-scene- / l3-persona-，经 remember 的
 * idOverride 落库）从长期层硬删除——与 runFullSweep 相同的删除语义
 * （kv.delete + deleteAccessLog）。幂等：config scope 落 flag，后续 sweep 跳过。
 */
export async function purgeLegacyL1L3Extractions(kv: StateKV, agentId: string): Promise<{ purged: number; skipped?: boolean }> {
	const flagKey = 'l1l3PurgeV1';
	const done = await kv.get<boolean>(KV.config(agentId), flagKey).catch(() => null);
	if (done) { return { purged: 0, skipped: true }; }
	const PREFIXES = ['l1-extract-', 'l2-scene-', 'l3-persona-'];
	let purged = 0;
	const all = await kv.list<Memory>(KV.memories(agentId));
	for (const m of all) {
		if (!PREFIXES.some(p => m.id.startsWith(p))) { continue; }
		await kv.delete(KV.memories(agentId), m.id);
		await deleteAccessLog(kv, agentId, m.id);
		purged++;
	}
	await kv.set(KV.config(agentId), flagKey, true);
	return { purged };
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Graph 构建与重置（对齐 agentmemory mem::graph-build / mem::graph-reset）
// ═══════════════════════════════════════════════════════════════════════════

/** 批量建图：对全部 active 记忆执行实体抽取（对齐原版 graph-build 的批处理语义） */
export async function graphBuild(kv: StateKV, agentId: string): Promise<{ processed: number; nodes: number; edges: number }> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const active = memories.filter(m => m.isLatest !== false);
	for (const m of active) {
		await pipe.graphExtract(kv, agentId, m.id, m.content);
	}
	const stats = pipe.graphStats();
	return { processed: active.length, nodes: stats.nodes, edges: stats.edges };
}

/** 重置图谱（原版 graph-reset：清空索引以便重建） */
export function graphReset(): { success: boolean } {
	pipe.resetGraph();
	return { success: true };
}

export { generateId };
