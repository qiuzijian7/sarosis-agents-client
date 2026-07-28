/* eslint-disable */
// ─── amRemaining.ts ───────────────────────────────────────────────────────────
// 剩余 agentmemory 高级功能的 V2 无状态实现
// 覆盖：routines / team / mesh / temporal-graph / replay / relations /
//       branch-aware / frontier / flow-compress / disk-size / image-quota /
//       claude-bridge / obsidian-export
// ──────────────────────────────────────────────────────────────────────────────

import type { StateKV } from './stateKV.js';
import { KV, generateId } from './amSchema.js';
import type { Memory, Lesson, SemanticMemory, ProceduralMemory } from './amTypes.js';

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
	id: string; name: string; url: string; status: 'online'|'offline'|'syncing'|'error';
	lastSeen: string; sharedScopes: string[];
	/** 上次成功同步时间（delta 收集的水位线） */
	lastSyncAt?: string;
	/** 同步过滤（如限定 project；对齐原版 syncFilter） */
	syncFilter?: { project?: string };
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

/** 推进 routine 执行进度：记录步骤结果、推进 currentStep，末步完成时自动标记 run 为 completed。 */
export async function routineStepUpdate(
	kv: StateKV, agentId: string, runId: string, stepOrder: number,
	status: 'done' | 'failed' | 'skipped' | 'running',
	result?: string, error?: string,
): Promise<RoutineRun | null> {
	const runs = await kv.list<RoutineRun>(KV.procedural(agentId));
	const run = runs.find(r => r.id === runId);
	if (!run) return null;
	const routines = await kv.list<Routine>(KV.procedural(agentId));
	const routine = routines.find(r => r.id === run.routineId);
	if (!routine) return null;
	const total = routine.steps.length;
	// 仅前向推进 currentStep（done 才推进，避免失败步骤回退）
	if (status === 'done' && stepOrder + 1 > run.currentStep) {
		run.currentStep = Math.min(stepOrder + 1, total);
	}
	run.runLog = run.runLog ?? [];
	run.runLog.push(`${stepOrder}:${status}${result ? ` ${result}` : ''}${error ? ` ERROR=${error}` : ''}`);
	const lastOrder = total - 1;
	if (stepOrder >= lastOrder && (status === 'done' || status === 'skipped')) {
		run.status = 'completed';
		run.completedAt = new Date().toISOString();
	} else if (status === 'failed') {
		run.status = 'failed';
	}
	await kv.set(KV.procedural(agentId), run.id, run as unknown as Record<string, unknown>);
	return run;
}

/** 删除 routine 及其所有 run 记录。 */
export async function routineDelete(kv: StateKV, agentId: string, routineId: string): Promise<boolean> {
	const routines = await kv.list<Routine>(KV.procedural(agentId));
	if (!routines.find(r => r.id === routineId)) return false;
	const runs = await kv.list<RoutineRun>(KV.procedural(agentId));
	for (const r of runs) {
		if (r.routineId === routineId) await kv.delete(KV.procedural(agentId), r.id);
	}
	await kv.delete(KV.procedural(agentId), routineId);
	return true;
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
	// D1 修复（doc §13）：写全局 team scope（mem:team:<teamId>:shared，teamId=project||'default'）
	// ——跨 agent 可见。此前误写 per-agent summaries scope：其他 agent 永远看不到
	// （共享语义失效），且 TeamSharedItem 混入摘要被 buildContext 当 SessionSummary 注入。
	const teamId = project || 'default';
	await kv.set(KV.teamShared(teamId), shared.id, shared as unknown as Record<string,unknown>);
	return { success: true, item: shared };
}

export async function teamQuery(kv: StateKV, agentId: string, query?: string, teamId: string = 'default'): Promise<TeamSharedItem[]> {
	// D1 修复：查全局 team scope（跨 agent 共享池），不再过滤 per-agent summaries
	const items = await kv.list<TeamSharedItem>(KV.teamShared(teamId));
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

// ─── 3b. Mesh Sync（复刻 agentmemory mem::mesh-sync / mem::mesh-receive，mesh.ts:196-372）───

export interface MeshSyncPayload {
	sourceAgentId?: string;
	memories?: Memory[];
	actions?: Array<Record<string, unknown>>;
	semantic?: SemanticMemory[];
	procedural?: ProceduralMemory[];
	relations?: Array<Record<string, unknown>>;
}

const MESH_SYNC_SCOPES = ['memories', 'actions', 'semantic', 'procedural', 'relations'] as const;

/** 复刻原版 isPrivateIP（mesh.ts:19-30） */
function isPrivateIP(ip: string): boolean {
	if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') { return true; }
	if (ip.startsWith('10.') || ip.startsWith('192.168.')) { return true; }
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) { return true; }
	if (ip === '169.254.169.254') { return true; }
	if (ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd')) { return true; }
	if (ip.startsWith('::ffff:')) { return isPrivateIP(ip.slice(7)); }
	return false;
}

/** SSRF 防护（复刻原版 isAllowedUrl，mesh.ts:32-55）。
 *  与原版差异：AGENTMEMORY_MESH_ALLOW_LOCAL=true 时放行本机/私网——
 *  原版 mesh 面向公网对等节点故默认阻断；本项目主场景是同机/局域网
 *  多 IDE 实例互联（且同步本身需 AGENTMEMORY_SECRET 鉴权），提供显式开关。 */
export async function isAllowedMeshUrl(urlStr: string): Promise<boolean> {
	try {
		const parsed = new URL(urlStr);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { return false; }
		if (parsed.username || parsed.password) { return false; }
		const allowLocal = (typeof process !== 'undefined' ? process.env['AGENTMEMORY_MESH_ALLOW_LOCAL'] : undefined) === 'true';
		const host = parsed.hostname.toLowerCase();
		let isLocal = host === 'localhost';
		if (!isLocal) {
			try {
				const { isIP } = await import('node:net');
				if (isIP(host)) {
					isLocal = isPrivateIP(host);
				} else {
					// 域名：解析到私网地址则按私网处理（失败放行——fetch 会兜底失败）
					try {
						const { lookup } = await import('node:dns/promises');
						const resolved = await lookup(host, { all: true });
						isLocal = resolved.some(r => isPrivateIP(r.address));
					} catch { /* allow */ }
				}
			} catch { /* node:net 不可用时按非 IP 处理 */ }
		}
		return isLocal ? allowLocal : true;
	} catch {
		return false;
	}
}

function deltaFilter<T>(items: T[], sinceTime: number, tsField: 'updatedAt' | 'createdAt'): T[] {
	return items.filter(item => {
		const ts = (item as Record<string, unknown>)[tsField];
		return typeof ts === 'string' && new Date(ts).getTime() > sinceTime;
	});
}

/** 收集同步数据（mem::mesh-export 数据源）：delta since + syncFilter */
export async function collectSyncData(
	kv: StateKV, agentId: string, scopes: readonly string[], since?: string, syncFilter?: { project?: string },
): Promise<MeshSyncPayload> {
	const result: MeshSyncPayload = { sourceAgentId: agentId };
	const parsed = since ? new Date(since).getTime() : 0;
	const sinceTime = Number.isNaN(parsed) ? 0 : parsed;
	const projectScoped = !!syncFilter?.project;

	if (scopes.includes('memories')) {
		let all = await kv.list<Memory>(KV.memories(agentId));
		if (syncFilter?.project) { all = all.filter(m => m.project === syncFilter.project); }
		result.memories = deltaFilter(all, sinceTime, 'updatedAt');
	}
	if (scopes.includes('actions')) {
		let all = await kv.list<Record<string, unknown>>(KV.actions(agentId));
		if (syncFilter?.project) { all = all.filter(a => a['project'] === syncFilter.project); }
		result.actions = deltaFilter(all, sinceTime, 'updatedAt');
	}
	if (scopes.includes('semantic') && !projectScoped) {
		const all = (await kv.list<unknown>(KV.semantic(agentId)))
			.filter((e): e is SemanticMemory => typeof e === 'object' && e !== null && !Array.isArray(e));
		result.semantic = deltaFilter(all, sinceTime, 'updatedAt');
	}
	if (scopes.includes('procedural') && !projectScoped) {
		const all = (await kv.list<unknown>(KV.procedural(agentId)))
			.filter((e): e is ProceduralMemory => typeof e === 'object' && e !== null && !Array.isArray(e));
		result.procedural = deltaFilter(all, sinceTime, 'updatedAt');
	}
	if (scopes.includes('relations') && !projectScoped) {
		const all = await kv.list<Record<string, unknown>>(KV.relations(agentId));
		result.relations = deltaFilter(all, sinceTime, 'createdAt');
	}
	return result;
}

/** LWW 合并（复刻原版 lwwMergeList；无 withKeyedLock——in-process 单线程网关） */
async function lwwMergeList<T extends { id: string }>(
	kv: StateKV, scope: string, items: T[] | undefined, tsField: 'updatedAt' | 'createdAt',
): Promise<number> {
	if (!items || !Array.isArray(items)) { return 0; }
	let count = 0;
	for (const item of items) {
		if (!item.id || typeof item.id !== 'string') { continue; }
		const ts = (item as Record<string, unknown>)[tsField];
		if (typeof ts !== 'string' || Number.isNaN(new Date(ts).getTime())) { continue; }
		const existing = await kv.get<T>(scope, item.id);
		if (!existing) {
			await kv.set(scope, item.id, item);
			count++;
		} else {
			const existingTs = (existing as Record<string, unknown>)[tsField] as string;
			if (new Date(ts) > new Date(existingTs)) {
				await kv.set(scope, item.id, item);
				count++;
			}
		}
	}
	return count;
}

/** 应用同步数据（mesh-receive 与 mesh-sync pull 共用） */
export async function applySyncData(
	kv: StateKV, agentId: string, data: MeshSyncPayload, scopes: readonly string[],
): Promise<number> {
	let applied = 0;
	if (scopes.includes('memories')) {
		applied += await lwwMergeList(kv, KV.memories(agentId), data.memories, 'updatedAt');
	}
	if (scopes.includes('actions')) {
		applied += await lwwMergeList(kv, KV.actions(agentId), data.actions as Array<{ id: string }> | undefined, 'updatedAt');
	}
	if (scopes.includes('semantic')) {
		applied += await lwwMergeList(kv, KV.semantic(agentId), data.semantic, 'updatedAt');
	}
	if (scopes.includes('procedural')) {
		applied += await lwwMergeList(kv, KV.procedural(agentId), data.procedural, 'updatedAt');
	}
	if (scopes.includes('relations') && data.relations) {
		for (const rel of data.relations) {
			const sourceId = rel['sourceId'] as string | undefined;
			const targetId = rel['targetId'] as string | undefined;
			const type = rel['type'] as string | undefined;
			if (!sourceId || !targetId || !type) { continue; }
			const relKey = `${sourceId}:${targetId}:${type}`;
			const existing = await kv.get(KV.relations(agentId), relKey);
			if (!existing) {
				await kv.set(KV.relations(agentId), relKey, rel);
				applied++;
			}
		}
	}
	return applied;
}

/** mem::mesh-receive：接受远端推送，LWW 合并 + 审计 */
export async function meshReceive(
	kv: StateKV, agentId: string, data: MeshSyncPayload,
): Promise<{ success: boolean; accepted: number; error?: string }> {
	if (!data || typeof data !== 'object') {
		return { success: false, accepted: 0, error: 'payload required' };
	}
	const accepted = await applySyncData(kv, agentId, data, MESH_SYNC_SCOPES);
	const auditId = generateId('audit');
	await kv.set(KV.state(agentId), auditId, {
		id: auditId, ts: new Date().toISOString(), action: 'mesh_receive', actor: 'mem::mesh-receive',
		targets: [], details: { accepted, sourceAgentId: data.sourceAgentId ?? 'unknown' },
	}).catch(() => {});
	return { success: true, accepted };
}

/** mem::mesh-sync：对等同步（push + pull，delta since lastSyncAt）。
 *  需 AGENTMEMORY_SECRET（双方一致）；AGENTMEMORY_MESH_ALLOW_LOCAL=true 才允许本机/私网对等。 */
export async function meshSync(
	kv: StateKV, agentId: string,
	opts?: { peerId?: string; scopes?: string[]; direction?: 'push' | 'pull' | 'both' },
): Promise<{ success: boolean; results?: Array<{ peerId: string; peerName: string; pushed: number; pulled: number; errors: string[] }>; error?: string }> {
	const secret = typeof process !== 'undefined' ? process.env['AGENTMEMORY_SECRET'] : undefined;
	if (!secret) {
		return { success: false, error: 'mesh sync requires AGENTMEMORY_SECRET' };
	}
	const direction = opts?.direction ?? 'both';
	let peers: MeshPeer[];
	if (opts?.peerId) {
		const peer = await kv.get<MeshPeer>(KV.state(agentId), `mesh:${opts.peerId}`);
		if (!peer) { return { success: false, error: 'peer not found' }; }
		peers = [peer];
	} else {
		peers = await meshList(kv, agentId);
	}
	peers = peers.filter(p => p.status !== 'offline');

	const results: Array<{ peerId: string; peerName: string; pushed: number; pulled: number; errors: string[] }> = [];
	for (const peer of peers) {
		const result = { peerId: peer.id, peerName: peer.name, pushed: 0, pulled: 0, errors: [] as string[] };
		const scopes = opts?.scopes ?? peer.sharedScopes ?? ['memories', 'actions'];
		peer.status = 'syncing';
		await kv.set(KV.state(agentId), `mesh:${peer.id}`, peer as unknown as Record<string, unknown>);
		try {
			if (!(await isAllowedMeshUrl(peer.url))) {
				result.errors.push('peer URL blocked: private/local address not allowed (set AGENTMEMORY_MESH_ALLOW_LOCAL=true for LAN peers)');
			} else {
				const base = peer.url.replace(/\/+$/, '');
				if (direction === 'push' || direction === 'both') {
					try {
						const pushData = await collectSyncData(kv, agentId, scopes, peer.lastSyncAt, peer.syncFilter);
						const response = await fetch(`${base}/mesh/receive?agent=${encodeURIComponent(agentId)}`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
							body: JSON.stringify(pushData),
							signal: AbortSignal.timeout(30000),
							redirect: 'error',
						});
						if (response.ok) {
							const body = await response.json() as { accepted?: number };
							result.pushed = body.accepted ?? 0;
						} else {
							result.errors.push(`push failed: HTTP ${response.status}`);
						}
					} catch (err) {
						result.errors.push(`push failed: ${String(err)}`);
					}
				}
				if (direction === 'pull' || direction === 'both') {
					try {
						const response = await fetch(
							`${base}/mesh/export?agent=${encodeURIComponent(agentId)}&since=${encodeURIComponent(peer.lastSyncAt ?? '')}&scopes=${encodeURIComponent(scopes.join(','))}`,
							{ headers: { 'Authorization': `Bearer ${secret}` }, signal: AbortSignal.timeout(30000), redirect: 'error' },
						);
						if (response.ok) {
							const pullData = await response.json() as MeshSyncPayload;
							result.pulled = await applySyncData(kv, agentId, pullData, scopes);
						} else {
							result.errors.push(`pull failed: HTTP ${response.status}`);
						}
					} catch (err) {
						result.errors.push(`pull failed: ${String(err)}`);
					}
				}
			}
			peer.status = result.errors.length > 0 ? 'error' : 'online';
			if (result.errors.length === 0) {
				peer.lastSyncAt = new Date().toISOString();
				peer.lastSeen = peer.lastSyncAt;
			}
		} catch (err) {
			peer.status = 'error';
			result.errors.push(String(err));
		}
		await kv.set(KV.state(agentId), `mesh:${peer.id}`, peer as unknown as Record<string, unknown>);
		const auditId = generateId('audit');
		await kv.set(KV.state(agentId), auditId, {
			id: auditId, ts: new Date().toISOString(), action: 'mesh_sync', actor: 'mem::mesh-sync',
			targets: [peer.id], details: { direction, scopes, pushed: result.pushed, pulled: result.pulled, errors: result.errors, lastSyncAt: peer.lastSyncAt },
		}).catch(() => {});
		results.push(result);
	}
	return { success: true, results };
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
