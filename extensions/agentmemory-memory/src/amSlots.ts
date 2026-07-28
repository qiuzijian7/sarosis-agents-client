/*---------------------------------------------------------------------------------------------
 *  无状态插槽系统 — 1:1 对齐 agentmemory src/functions/slots.ts
 *
 *  8 个默认插槽：persona / user_preferences / tool_guidelines / project_context /
 *  guidance / pending_items / session_patterns / self_notes
 *
 *  pinned 插槽固定注入 LLM 上下文（不受 token budget 截断）
 *  每条插槽独立 KV key-value
 *--------------------------------------------------------------------------------------------*/

import type { MemorySlot, Observation } from './amTypes.js';
import { KV, generateId } from './amSchema.js';
import { StateKV } from './stateKV.js';

const DEFAULT_SIZE_LIMIT = 2000;

const DEFAULT_SLOTS: Array<Omit<MemorySlot, 'createdAt' | 'updatedAt'>> = [
	{ label: 'persona', content: '', sizeLimit: 1000, description: 'Role, tone, behavioural guidelines.', pinned: true, readOnly: false, scope: 'global' },
	{ label: 'user_preferences', content: '', sizeLimit: 2000, description: 'Coding style, tool preferences, naming conventions.', pinned: true, readOnly: false, scope: 'global' },
	{ label: 'tool_guidelines', content: '', sizeLimit: 1500, description: 'Tool selection rules (prefer X, never run Y).', pinned: true, readOnly: false, scope: 'global' },
	{ label: 'project_context', content: '', sizeLimit: 3000, description: 'Architecture decisions, conventions, build commands.', pinned: true, readOnly: false, scope: 'project' },
	{ label: 'guidance', content: '', sizeLimit: 1500, description: 'Active advice: focus areas, risks to avoid.', pinned: true, readOnly: false, scope: 'project' },
	{ label: 'pending_items', content: '', sizeLimit: 2000, description: 'Unfinished work, explicit TODOs, promises.', pinned: true, readOnly: false, scope: 'project' },
	{ label: 'session_patterns', content: '', sizeLimit: 1500, description: 'Recurring behaviours across sessions.', pinned: false, readOnly: false, scope: 'project' },
	{ label: 'self_notes', content: '', sizeLimit: 1500, description: 'Free-form agent self-notes.', pinned: false, readOnly: false, scope: 'project' },
];

async function seedDefaults(kv: StateKV, agentId: string): Promise<void> {
	const ts = new Date().toISOString();
	const scope = KV.slots(agentId);
	for (const tmpl of DEFAULT_SLOTS) {
		const existing = await kv.get<MemorySlot>(scope, tmpl.label);
		if (!existing) {
			await kv.set(scope, tmpl.label, { ...tmpl, createdAt: ts, updatedAt: ts } as MemorySlot);
		}
	}
}

export async function slotList(kv: StateKV, agentId: string): Promise<MemorySlot[]> {
	await seedDefaults(kv, agentId);
	return (await kv.list<MemorySlot>(KV.slots(agentId))).sort((a, b) => a.label.localeCompare(b.label));
}

export async function slotGet(kv: StateKV, agentId: string, label: string): Promise<MemorySlot | null> {
	return kv.get<MemorySlot>(KV.slots(agentId), label);
}

export async function slotSet(kv: StateKV, agentId: string, label: string, content: string): Promise<MemorySlot | null> {
	await seedDefaults(kv, agentId);
	const slot = await kv.get<MemorySlot>(KV.slots(agentId), label);
	if (!slot || slot.readOnly) return null;
	// 空内容 = 删除槽位（memoryDetailEditorPane 用 setSlot(agentId, name, '') 删除）
	if (!content || !content.trim()) {
		await kv.delete(KV.slots(agentId), label);
		return null;
	}
	slot.content = content.slice(0, slot.sizeLimit || DEFAULT_SIZE_LIMIT);
	slot.updatedAt = new Date().toISOString();
	await kv.set(KV.slots(agentId), label, slot);
	return slot;
}

export async function listPinnedSlots(kv: StateKV, agentId: string): Promise<MemorySlot[]> {
	const all = await slotList(kv, agentId);
	return all.filter(s => s.pinned && s.content.trim().length > 0);
}

export function renderPinnedContext(slots: MemorySlot[]): string {
	if (slots.length === 0) return '';
	const lines: string[] = ['# agentmemory pinned slots', ''];
	for (const s of slots) {
		lines.push(`## ${s.label}`);
		lines.push(s.content.trim());
		lines.push('');
	}
	return lines.join('\n');
}

// ─── Observe 统一入口（对齐 agentmemory mem::observe）────────────────

import type { CoreMemoryEntry } from './amTypes.js';

export interface ObservePayload {
	sessionId: string;
	hookType: string;
	timestamp: string;
	data: unknown;
}

export async function observe(kv: StateKV, agentId: string, payload: ObservePayload): Promise<{ success: boolean; deduplicated?: boolean }> {
	if (!payload?.sessionId || !payload?.hookType || !payload?.timestamp) {
		return { success: false };
	}
	if (payload.hookType === 'post_tool_use' || payload.hookType === 'post_tool_failure') {
		const d = (payload.data ?? {}) as Record<string, unknown>;
		const toolName = (d['tool_name'] as string) || 'unknown';
		const result = typeof d === 'string' ? d : JSON.stringify(d).slice(0, 200);
		const id = `core_obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const entry: CoreMemoryEntry = {
			id, content: `[tool:${toolName}] ${payload.hookType === 'post_tool_failure' ? 'FAILED: ' : ''}${result}`,
			importance: 3, pinned: false, accessCount: 0,
			lastAccessedAt: new Date().toISOString(), createdAt: new Date().toISOString(), agentId,
		};
		await kv.set(KV.coreMemory(agentId), id, entry);
	}
	return { success: true };
}

// ─── Enrich（对齐 agentmemory mem::enrich）─────────────────────────────

export async function enrich(kv: StateKV, agentId: string, files: string[], terms: string[] = [], project?: string): Promise<{ context: string }> {
	const parts: string[] = [];
	for (const file of files) {
		const related = await kv.list<any>(KV.memories(agentId));
		const matches = related.filter((m: any) => m.files?.some((f: string) => f.includes(file) || file.includes(f)));
		if (matches.length > 0) {
			parts.push(`Related to ${file}:`);
			for (const m of matches.slice(0, 3)) {
				parts.push(`- ${(m as any).content?.slice(0, 200) ?? ''}`);
			}
		}
	}
	return { context: parts.join('\n').slice(0, 4000) };
}

// ─── Slot Reflect（复刻 agentmemory mem::slot-reflect，slots.ts:361-486）────

/** reflect 门控：原版 AGENTMEMORY_REFLECT=true 才开（默认关）；
 *  移植版 slots 常开故默认开，AGENTMEMORY_REFLECT=false 关闭（刻意的默认值差异）。 */
export function isReflectEnabled(): boolean {
	try {
		return (typeof process !== 'undefined' ? process.env['AGENTMEMORY_REFLECT'] : undefined) !== 'false';
	} catch {
		return true;
	}
}

/**
 * mem::slot-reflect 复刻：session 结束时把近期观察反思进 slots——
 *   pending_items    ← 含 "todo" 的观察标题行（去重追加）
 *   session_patterns ← 错误/命令执行计数（覆盖式摘要）
 *   project_context  ← 触及文件列表（去重追加，每次 ≤20 条）
 * 均受 slot.sizeLimit 尾部截断。与原版差异：①观察类型映射 hookType
 * （error→post_tool_failure；command_run→post_tool_use 且工具名匹配
 * run/exec/shell/terminal/bash/command）；②无 withKeyedLock（in-process KV
 * 单线程网关，最坏情况一次丢失更新，可接受）；③审计写 KV.state（与
 * governanceAuditQuery 的读取约定一致，id 前缀 audit_）。
 */
export async function slotReflect(
	kv: StateKV, agentId: string, sessionId: string, maxObservations: number = 50,
): Promise<{ success: boolean; applied: number; observationsReviewed: number; reason?: string }> {
	if (!sessionId) {
		return { success: false, applied: 0, observationsReviewed: 0, reason: 'sessionId required' };
	}
	const max = Number.isInteger(maxObservations) && maxObservations > 0 ? Math.min(200, maxObservations) : 50;
	const observations = await kv.list<Observation>(KV.observations(agentId, sessionId)).catch(() => [] as Observation[]);
	if (observations.length === 0) {
		return { success: true, applied: 0, observationsReviewed: 0, reason: 'no observations for session' };
	}
	const recent = [...observations]
		.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
		.slice(0, max);

	// 聚合：todo 行 / 模式计数 / 触及文件
	const pendingLines: string[] = [];
	const patternCounts = new Map<string, number>();
	const files = new Set<string>();
	for (const obs of recent) {
		const d = (obs.data ?? {}) as Record<string, unknown>;
		const title = String(obs.title ?? d['tool_name'] ?? '').toLowerCase();
		const narrative = String(d['content'] ?? d['tool_output'] ?? '').toLowerCase();
		if (narrative.includes('todo') || title.includes('todo')) {
			pendingLines.push(`- ${obs.title || String(d['content'] ?? '').slice(0, 60) || obs.id}`);
		}
		if (obs.hookType === 'post_tool_failure' || obs.hookType === 'tool_failure') {
			patternCounts.set('errors', (patternCounts.get('errors') ?? 0) + 1);
		}
		const toolName = String(d['tool_name'] ?? '');
		if (obs.hookType === 'post_tool_use' && /run|exec|shell|terminal|bash|command/i.test(toolName)) {
			patternCounts.set('commands', (patternCounts.get('commands') ?? 0) + 1);
		}
		if (Array.isArray(d['files'])) {
			for (const f of d['files'] as unknown[]) { if (typeof f === 'string') { files.add(f); } }
		}
	}

	await seedDefaults(kv, agentId);
	let applied = 0;
	const now = new Date().toISOString();

	if (pendingLines.length > 0) {
		const slot = await slotGet(kv, agentId, 'pending_items');
		if (slot && !slot.readOnly) {
			const already = new Set(slot.content.split('\n'));
			const fresh = pendingLines.filter(l => !already.has(l));
			if (fresh.length > 0) {
				const sep = slot.content && !slot.content.endsWith('\n') ? '\n' : '';
				const next = `${slot.content}${sep}${fresh.join('\n')}`;
				slot.content = next.length > slot.sizeLimit ? next.slice(next.length - slot.sizeLimit) : next;
				slot.updatedAt = now;
				await kv.set(KV.slots(agentId), 'pending_items', slot);
				applied++;
			}
		}
	}

	if (patternCounts.size > 0) {
		const slot = await slotGet(kv, agentId, 'session_patterns');
		if (slot && !slot.readOnly) {
			const summary = [
				`last reflection: ${now}`,
				...[...patternCounts.entries()].map(([kind, count]) => `- ${kind}: ${count} in last ${recent.length} observations`),
			].join('\n');
			slot.content = summary.length > slot.sizeLimit ? summary.slice(0, slot.sizeLimit) : summary;
			slot.updatedAt = now;
			await kv.set(KV.slots(agentId), 'session_patterns', slot);
			applied++;
		}
	}

	if (files.size > 0) {
		const slot = await slotGet(kv, agentId, 'project_context');
		if (slot && !slot.readOnly) {
			const fresh = [...files].filter(f => !slot.content.includes(f)).slice(0, 20);
			if (fresh.length > 0) {
				const header = slot.content.length === 0 ? 'Files touched in recent sessions:' : '';
				const sep = slot.content && !slot.content.endsWith('\n') ? '\n' : '';
				const nextRaw = `${slot.content}${sep}${header ? header + '\n' : ''}${fresh.map(f => `- ${f}`).join('\n')}`;
				slot.content = nextRaw.length > slot.sizeLimit ? nextRaw.slice(nextRaw.length - slot.sizeLimit) : nextRaw;
				slot.updatedAt = now;
				await kv.set(KV.slots(agentId), 'project_context', slot);
				applied++;
			}
		}
	}

	if (applied > 0) {
		// 审计（对齐原版 recordAudit；移植版约定写 KV.state、id 前缀 audit_）
		const auditId = generateId('audit');
		await kv.set(KV.state(agentId), auditId, {
			id: auditId, ts: now, action: 'slot_reflect', actor: 'mem::slot-reflect',
			targets: [sessionId], details: { observationCount: recent.length, slotsUpdated: applied },
		}).catch(() => {});
	}

	return { success: true, applied, observationsReviewed: recent.length };
}
