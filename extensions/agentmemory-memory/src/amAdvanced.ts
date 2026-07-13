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
export interface Sentinel { id: string; name: string; condition: string; type: 'threshold'|'pattern'|'schedule'; linkedActionIds: string[]; createdAt: string; }
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
	const s: Sentinel = {id:generateId('sen'), name:name.trim(), condition, type, linkedActionIds:[], createdAt:now};
	await kv.set(KV.sentinels(agentId), s.id, s); return s;
}
export async function sentinelList(kv: StateKV, agentId: string): Promise<Sentinel[]> { return kv.list<Sentinel>(KV.sentinels(agentId)); }

// ─── Snapshots ──────────────────────────────────────────────────────────

export async function snapshotCreate(kv: StateKV, agentId: string, name: string): Promise<Snapshot> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const active = memories.filter(m=>m.isLatest!==false);
	const snap:Snapshot = {id:generateId('snap'), name, createdAt:new Date().toISOString(), data:{memoryCount:active.length, memoryIds:active.map(m=>m.id)}};
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
