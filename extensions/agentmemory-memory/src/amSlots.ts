/*---------------------------------------------------------------------------------------------
 *  无状态插槽系统 — 1:1 对齐 agentmemory src/functions/slots.ts
 *
 *  8 个默认插槽：persona / user_preferences / tool_guidelines / project_context /
 *  guidance / pending_items / session_patterns / self_notes
 *
 *  pinned 插槽固定注入 LLM 上下文（不受 token budget 截断）
 *  每条插槽独立 KV key-value
 *--------------------------------------------------------------------------------------------*/

import type { MemorySlot } from './amTypes.js';
import { KV } from './amSchema.js';
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
