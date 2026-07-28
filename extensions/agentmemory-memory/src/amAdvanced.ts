/*---------------------------------------------------------------------------------------------
 *  AgentMemory 高级特性 — 阶段 C+D（actions/checkpoints/leases/signals/sketches/sentinels/snapshots/crystallize/facets）
 *  对齐 agentmemory functions/actions.ts checkpoints.ts leases.ts signals.ts sketches.ts sentinels.ts snapshot.ts crystallize.ts facets.ts
 *--------------------------------------------------------------------------------------------*/

import type { Memory } from './amTypes.js';
import { KV, generateId } from './amSchema.js';
import { StateKV } from './stateKV.js';

const MS_PER_HOUR = 60 * 60 * 1000;

export interface Action { id: string; title: string; description: string; status: 'pending'|'active'|'done'|'blocked'|'cancelled'; priority: number; createdAt: string; updatedAt: string; createdBy: string; project?: string; tags: string[]; parentId?: string; }
export interface Checkpoint { id: string; name: string; description: string; status: 'pending'|'passed'|'failed'|'expired'; type: 'ci'|'approval'|'deploy'|'external'|'timer'; createdAt: string; resolvedAt?: string; linkedActionIds: string[]; }
export interface Lease { id: string; actionId: string; agentId: string; acquiredAt: string; expiresAt: string; status: 'active'|'expired'|'released'; }
export interface SignalMsg { id: string; from: string; to?: string; type: 'info'|'request'|'response'|'alert'|'handoff'; content: string; createdAt: string; expiresAt?: string; }
export interface Sketch { id: string; title: string; description: string; status: 'active'|'promoted'|'discarded'; actionIds: string[]; project?: string; createdAt: string; expiresAt: string; promotedAt?: string; }
export interface Sentinel {
	id: string; name: string; condition: string; type: 'threshold'|'pattern'|'schedule';
	linkedActionIds: string[]; createdAt: string;
	/** 生命周期状态：watching（监视中）→ triggered（已触发）/ cancelled（已取消）/ expired（已过期）。
	 *  历史条目无此字段，读取时按 'watching' 处理。 */
	status?: 'watching'|'triggered'|'cancelled'|'expired';
	triggeredAt?: string;
	/** 触发结果（原因 + 匹配细节），由 sentinelCheck/sentinelTrigger 写入 */
	result?: Record<string, unknown>;
	expiresAt?: string;
}
export interface Snapshot { id: string; name: string; createdAt: string; data: Record<string,unknown>; }
export interface Crystal { id: string; narrative: string; keyOutcomes: string[]; filesAffected: string[]; lessons: string[]; sourceActionIds: string[]; createdAt: string; project?: string; }
export interface FacetRecord { id: string; targetId: string; targetType: 'action'|'memory'|'observation'; dimension: string; value: string; createdAt: string; }

// ─── Actions ────────────────────────────────────────────────────────────

export async function actionCreate(kv: StateKV, agentId: string, title: string, description?: string, priority?: number, project?: string): Promise<Action> {
	const now = new Date().toISOString();
	const a: Action = { id: generateId('act'), title: title.trim(), description: description?.trim() ?? '', status: 'pending', priority: Math.max(1, Math.min(10, priority ?? 5)), createdAt: now, updatedAt: now, createdBy: agentId, project, tags: [], parentId: undefined };
	await kv.set(KV.actions(agentId), a.id, a);
	return a;
}
export async function actionUpdate(kv: StateKV, agentId: string, id: string, status?: Action['status'], priority?: number): Promise<Action|null> {
	const a = await kv.get<Action>(KV.actions(agentId), id); if (!a) return null;
	if (status) a.status = status; if (priority) a.priority = priority;
	a.updatedAt = new Date().toISOString(); await kv.set(KV.actions(agentId), id, a); return a;
}
export async function actionList(kv: StateKV, agentId: string): Promise<Action[]> {
	return (await kv.list<Action>(KV.actions(agentId))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
export async function actionGet(kv: StateKV, agentId: string, id: string): Promise<Action|null> {
	return kv.get<Action>(KV.actions(agentId), id);
}

// ─── Action Edge（复刻 agentmemory mem::action-edge-create：行动 DAG 关系边）───

export interface ActionEdge {
	id: string; from: string; to: string;
	type: 'blocks'|'depends_on'|'relates_to'|'supersedes';
	createdAt: string;
}

/** 在两个已存在的 action 之间建关系边。存 relations scope（id 前缀 aedge_），
 *  避免污染 actionList 读取的 actions scope（与原版存储位置的刻意差异）。 */
export async function actionEdgeCreate(
	kv: StateKV, agentId: string, from: string, to: string,
	type: ActionEdge['type'] = 'depends_on',
): Promise<ActionEdge | null> {
	const [a, b] = await Promise.all([
		kv.get<Action>(KV.actions(agentId), from),
		kv.get<Action>(KV.actions(agentId), to),
	]);
	if (!a || !b) { return null; }
	const edge: ActionEdge = { id: generateId('aedge'), from, to, type, createdAt: new Date().toISOString() };
	await kv.set(KV.relations(agentId), edge.id, edge);
	return edge;
}

// ─── Checkpoints ────────────────────────────────────────────────────────

export async function checkpointCreate(kv: StateKV, agentId: string, name: string, description?: string, type?: Checkpoint['type']): Promise<Checkpoint> {
	const now = new Date().toISOString();
	const cp: Checkpoint = { id: generateId('ckpt'), name: name.trim(), description: description?.trim() ?? '', status: 'pending', type: type ?? 'external', createdAt: now, linkedActionIds: [] };
	await kv.set(KV.checkpoints(agentId), cp.id, cp); return cp;
}
export async function checkpointResolve(kv: StateKV, agentId: string, id: string, passed: boolean): Promise<Checkpoint|null> {
	const cp = await kv.get<Checkpoint>(KV.checkpoints(agentId), id); if (!cp) return null;
	cp.status = passed ? 'passed' : 'failed'; cp.resolvedAt = new Date().toISOString();
	await kv.set(KV.checkpoints(agentId), id, cp); return cp;
}
export async function checkpointList(kv: StateKV, agentId: string): Promise<Checkpoint[]> {
	return (await kv.list<Checkpoint>(KV.checkpoints(agentId))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}

// ─── Leases ─────────────────────────────────────────────────────────────

export async function leaseAcquire(kv: StateKV, agentId: string, actionId: string, ttlMs?: number): Promise<{success:boolean;lease?:Lease;error?:string}> {
	const existing = await kv.list<Lease>(KV.leases(agentId));
	const active = existing.find(l=>l.actionId===actionId && l.status==='active' && new Date(l.expiresAt).getTime()>Date.now());
	if (active) return {success:false, error:'Already leased', lease:active};
	const ttl = Math.min(ttlMs??10*60*1000, 60*60*1000); const now = new Date();
	const lease:Lease = {id:generateId('lse'), actionId, agentId, acquiredAt:now.toISOString(), expiresAt:new Date(now.getTime()+ttl).toISOString(), status:'active'};
	await kv.set(KV.leases(agentId), lease.id, lease); return {success:true, lease};
}
export async function leaseRelease(kv: StateKV, agentId: string, leaseId: string): Promise<boolean> {
	const lease = await kv.get<Lease>(KV.leases(agentId), leaseId); if (!lease||lease.status!=='active') return false;
	lease.status='released'; await kv.set(KV.leases(agentId), leaseId, lease); return true;
}

// ─── Signals ────────────────────────────────────────────────────────────

export async function signalSend(kv: StateKV, agentId: string, type: SignalMsg['type'], content: string, to?: string): Promise<SignalMsg> {
	const now = new Date().toISOString();
	const sig: SignalMsg = {id:generateId('sig'), from:agentId, to, type, content, createdAt:now, expiresAt:new Date(Date.now()+24*MS_PER_HOUR).toISOString()};
	await kv.set(KV.signals(agentId), sig.id, sig); return sig;
}
export async function signalQuery(kv: StateKV, agentId: string): Promise<SignalMsg[]> {
	return (await kv.list<SignalMsg>(KV.signals(agentId))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}

// ─── Sketches ───────────────────────────────────────────────────────────

export async function sketchCreate(kv: StateKV, agentId: string, title: string, description?: string): Promise<Sketch> {
	const now = new Date().toISOString();
	const sk:Sketch = {id:generateId('skt'), title:title.trim(), description:description?.trim()??'', status:'active', actionIds:[], project:agentId, createdAt:now, expiresAt:new Date(Date.now()+7*24*MS_PER_HOUR).toISOString()};
	await kv.set(KV.sketches(agentId), sk.id, sk); return sk;
}
export async function sketchPromote(kv: StateKV, agentId: string, sketchId: string): Promise<Sketch|null> {
	const sk = await kv.get<Sketch>(KV.sketches(agentId), sketchId); if (!sk) return null;
	sk.status='promoted'; sk.promotedAt=new Date().toISOString(); await kv.set(KV.sketches(agentId), sketchId, sk); return sk;
}
export async function sketchList(kv: StateKV, agentId: string): Promise<Sketch[]> { return kv.list<Sketch>(KV.sketches(agentId)); }

// ─── Sentinels ──────────────────────────────────────────────────────────

export async function sentinelCreate(kv: StateKV, agentId: string, name: string, condition: string, type: Sentinel['type']='threshold'): Promise<Sentinel> {
	const now = new Date().toISOString();
	const s: Sentinel = {id:generateId('sen'), name:name.trim(), condition, type, linkedActionIds:[], createdAt:now, status:'watching'};
	await kv.set(KV.sentinels(agentId), s.id, s); return s;
}
export async function sentinelList(kv: StateKV, agentId: string): Promise<Sentinel[]> { return kv.list<Sentinel>(KV.sentinels(agentId)); }

// ─── Sentinel 评估生命周期（接入：check/trigger/cancel）────────────────────
// 对齐 agentmemory functions/sentinels.ts 的 mem::sentinel-check/trigger/cancel，
// 但条件表达式适配本移植版的 LLM 友好自由文本格式：
//   threshold: "memory_count > 1000" / "lesson_count >= 10"（支持 > < >= <= == != 及 gt/lt/gte/lte/eq）
//   pattern:   正则或子串，匹配哨兵创建之后的新记忆内容
//   schedule:  "24h" / "7d" / ISO 时间字符串，到期触发

/** threshold 条件可引用的指标（从 KV 实时计算） */
async function sentinelMetricValue(kv: StateKV, agentId: string, metric: string): Promise<number | undefined> {
	switch (metric) {
		case 'memory_count':
		case 'active_memories':
			return (await kv.list<Memory>(KV.memories(agentId))).filter(m => m.isLatest !== false).length;
		case 'total_memories':
			return (await kv.list<Memory>(KV.memories(agentId))).length;
		case 'lesson_count':
			return (await kv.list(KV.lessons(agentId))).length;
		case 'skill_count':
			return (await kv.list(KV.skillStore(agentId))).length;
		case 'session_count':
			return (await kv.list(KV.sessions(agentId))).length;
		case 'action_count':
			return (await kv.list(KV.actions(agentId))).length;
		case 'signal_count':
			return (await kv.list(KV.signals(agentId))).length;
		case 'checkpoint_count':
			return (await kv.list(KV.checkpoints(agentId))).length;
		default:
			return undefined;
	}
}

const SENTINEL_COND_RE = /^\s*([a-z_][a-z0-9_]*)\s*(>=|<=|==|!=|>|<|gte|lte|gt|lt|eq|neq)\s*(-?\d+(?:\.\d+)?)\s*$/i;

function evalThresholdCondition(current: number, op: string, value: number): boolean {
	switch (op.toLowerCase()) {
		case '>': case 'gt': return current > value;
		case '<': case 'lt': return current < value;
		case '>=': case 'gte': return current >= value;
		case '<=': case 'lte': return current <= value;
		case '==': case 'eq': return current === value;
		case '!=': case 'neq': return current !== value;
		default: return false;
	}
}

/** 解析 schedule 条件为触发时间点（epoch ms）；无法解析返回 undefined */
function parseScheduleTime(condition: string, createdAt: string): number | undefined {
	const c = condition.trim();
	const dur = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i.exec(c);
	if (dur) {
		const n = parseFloat(dur[1]);
		const unit = dur[2].toLowerCase();
		const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? MS_PER_HOUR : 24 * MS_PER_HOUR;
		return new Date(createdAt).getTime() + n * mult;
	}
	const t = Date.parse(c);
	return Number.isNaN(t) ? undefined : t;
}

async function markSentinelTriggered(kv: StateKV, agentId: string, sentinel: Sentinel, result: Record<string, unknown>): Promise<boolean> {
	// 重读防止并发重复触发（单进程网关下基本防御）
	const fresh = await kv.get<Sentinel>(KV.sentinels(agentId), sentinel.id);
	if (!fresh || (fresh.status ?? 'watching') !== 'watching') return false;
	fresh.status = 'triggered';
	fresh.triggeredAt = new Date().toISOString();
	fresh.result = result;
	await kv.set(KV.sentinels(agentId), fresh.id, fresh);
	return true;
}

export interface SentinelCheckResult {
	checked: number;
	triggered: Array<{ id: string; name: string; type: string; result: Record<string, unknown> }>;
	expired: number;
	errors: Array<{ id: string; error: string }>;
}

/**
 * 评估 agent 的全部 watching 哨兵：threshold（指标比较）/ pattern（新记忆匹配）/
 * schedule（到期）三类条件，命中的标记为 triggered 并返回清单。
 * 过期哨兵（expiresAt 已过）标记为 expired。
 * 由 runMaintenanceSweep 周期调用，也可经工具手动触发。
 */
export async function sentinelCheck(kv: StateKV, agentId: string): Promise<SentinelCheckResult> {
	const all = await kv.list<Sentinel>(KV.sentinels(agentId));
	const now = Date.now();
	const result: SentinelCheckResult = { checked: 0, triggered: [], expired: 0, errors: [] };

	for (const s of all) {
		const status = s.status ?? 'watching';
		if (status !== 'watching') continue;

		// 过期处理
		if (s.expiresAt && Date.parse(s.expiresAt) < now) {
			s.status = 'expired';
			await kv.set(KV.sentinels(agentId), s.id, s);
			result.expired++;
			continue;
		}

		result.checked++;
		try {
			if (s.type === 'threshold') {
				const m = SENTINEL_COND_RE.exec(s.condition);
				if (!m) { result.errors.push({ id: s.id, error: `unparseable threshold condition: "${s.condition}"` }); continue; }
				const [, metric, op, rawVal] = m;
				const current = await sentinelMetricValue(kv, agentId, metric);
				if (current === undefined) { result.errors.push({ id: s.id, error: `unknown metric: "${metric}"` }); continue; }
				const value = parseFloat(rawVal);
				if (evalThresholdCondition(current, op, value)) {
					const triggerResult = { reason: 'threshold_crossed', metric, currentValue: current, threshold: value, operator: op };
					if (await markSentinelTriggered(kv, agentId, s, triggerResult)) {
						result.triggered.push({ id: s.id, name: s.name, type: s.type, result: triggerResult });
					}
				}
			} else if (s.type === 'pattern') {
				// 匹配哨兵创建之后的新记忆（正则优先，退化子串，忽略大小写）
				const createdMs = Date.parse(s.createdAt);
				const memories = await kv.list<Memory>(KV.memories(agentId));
				const recent = memories.filter(mm => mm.isLatest !== false && Date.parse(mm.createdAt) >= createdMs);
				let matcher: (text: string) => boolean;
				try {
					const re = new RegExp(s.condition, 'i');
					matcher = (t) => re.test(t);
				} catch {
					const needle = s.condition.toLowerCase();
					matcher = (t) => t.toLowerCase().includes(needle);
				}
				const hit = recent.find(mm => matcher(mm.content));
				if (hit) {
					const triggerResult = { reason: 'pattern_matched', pattern: s.condition, matchedMemoryId: hit.id, matchedContent: hit.content.slice(0, 200) };
					if (await markSentinelTriggered(kv, agentId, s, triggerResult)) {
						result.triggered.push({ id: s.id, name: s.name, type: s.type, result: triggerResult });
					}
				}
			} else if (s.type === 'schedule') {
				const due = parseScheduleTime(s.condition, s.createdAt);
				if (due === undefined) { result.errors.push({ id: s.id, error: `unparseable schedule condition: "${s.condition}"` }); continue; }
				if (now >= due) {
					const triggerResult = { reason: 'schedule_elapsed', condition: s.condition, dueAt: new Date(due).toISOString() };
					if (await markSentinelTriggered(kv, agentId, s, triggerResult)) {
						result.triggered.push({ id: s.id, name: s.name, type: s.type, result: triggerResult });
					}
				}
			}
		} catch (err) {
			result.errors.push({ id: s.id, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return result;
}

/** 手动触发哨兵（对齐 mem::sentinel-trigger） */
export async function sentinelTrigger(kv: StateKV, agentId: string, sentinelId: string, result?: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
	const s = await kv.get<Sentinel>(KV.sentinels(agentId), sentinelId);
	if (!s) return { success: false, error: 'sentinel not found' };
	if ((s.status ?? 'watching') !== 'watching') return { success: false, error: `sentinel already ${s.status}` };
	await markSentinelTriggered(kv, agentId, s, result ?? { reason: 'manual_trigger' });
	return { success: true };
}

/** 取消监视中的哨兵（对齐 mem::sentinel-cancel） */
export async function sentinelCancel(kv: StateKV, agentId: string, sentinelId: string): Promise<{ success: boolean; error?: string }> {
	const s = await kv.get<Sentinel>(KV.sentinels(agentId), sentinelId);
	if (!s) return { success: false, error: 'sentinel not found' };
	if ((s.status ?? 'watching') !== 'watching') return { success: false, error: `cannot cancel sentinel with status ${s.status}` };
	s.status = 'cancelled';
	await kv.set(KV.sentinels(agentId), s.id, s);
	return { success: true };
}

// ─── Snapshots ──────────────────────────────────────────────────────────

export async function snapshotCreate(kv: StateKV, agentId: string, name: string): Promise<Snapshot> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const active = memories.filter(m=>m.isLatest!==false);
	// 全量存储（对齐 agentmemory snapshot.ts 的 state.json 语义），
	// 使 amReplication.snapshotRestore 可以恢复；保留 memoryCount/memoryIds 向后兼容字段。
	const snap:Snapshot = {id:generateId('snap'), name, createdAt:new Date().toISOString(), data:{memoryCount:active.length, memoryIds:active.map(m=>m.id), memories:active}};
	await kv.set(KV.snapshots(agentId), snap.id, snap); return snap;
}
export async function snapshotList(kv: StateKV, agentId: string): Promise<Snapshot[]> {
	return (await kv.list<Snapshot>(KV.snapshots(agentId))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}

// ─── Crystallize ────────────────────────────────────────────────────────

export async function crystallize(kv: StateKV, agentId: string, actionId: string): Promise<Crystal|null> {
	const action = await kv.get<Action>(KV.actions(agentId), actionId); if (!action) return null;
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const related = memories.filter(m=>m.isLatest!==false && m.concepts.some(c=>action.title.toLowerCase().includes(c)));
	const crystal:Crystal = {id:generateId('cry'), narrative:`Action ${action.title} completed`, keyOutcomes:[action.status], filesAffected:[], lessons:[], sourceActionIds:[actionId], createdAt:new Date().toISOString(), project:action.project};
	await kv.set(KV.crystals(agentId), crystal.id, crystal); return crystal;
}
export async function crystalList(kv: StateKV, agentId: string): Promise<Crystal[]> { return kv.list<Crystal>(KV.crystals(agentId)); }

// ─── Facets ─────────────────────────────────────────────────────────────

export async function facetTag(kv: StateKV, agentId: string, targetId: string, targetType: FacetRecord['targetType'], dimension: string, value: string): Promise<FacetRecord> {
	const f:FacetRecord = {id:generateId('fac'), targetId, targetType, dimension, value, createdAt:new Date().toISOString()};
	await kv.set(KV.facets(agentId), f.id, f); return f;
}
export async function facetQuery(kv: StateKV, agentId: string, dimension: string, value?: string): Promise<FacetRecord[]> {
	const all = await kv.list<FacetRecord>(KV.facets(agentId));
	return all.filter(f=>f.dimension===dimension && (!value||f.value===value));
}
