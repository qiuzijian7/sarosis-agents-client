/*---------------------------------------------------------------------------------------------
 *  AgentMemory 辅助特性 — 阶段 A 收尾 + 阶段 B
 *
 *  1. File Index — 文件关联记忆召回 (mem::file-context)
 *  2. Privacy — 敏感数据清洗 (mem::privacy-sanitize)
 *  3. Export/Import — 记忆导出/导入 (mem::export/import)
 *  4. Governance — 批量记忆管理 (mem::governance-delete/bulk)
 *--------------------------------------------------------------------------------------------*/

import type { Memory, SemanticMemory, ProceduralMemory, CoreMemoryEntry } from './amTypes.js';
import { KV, generateId } from './amSchema.js';
import { StateKV } from './stateKV.js';

// ─── 1. File Index（对齐 agentmemory mem::file-context）─────────────────

export async function fileContext(kv: StateKV, agentId: string, files: string[]): Promise<{ context: string; relatedMemories: string[] }> {
	if (files.length === 0) return { context: '', relatedMemories: [] };

	const memories = await kv.list<Memory>(KV.memories(agentId));
	const active = memories.filter(m => m.isLatest !== false);

	const relatedIds: string[] = [];
	const parts: string[] = [];

	for (const file of files) {
		const matches = active.filter(m => m.files?.some((f: string) =>
			f.includes(file) || file.includes(f) || f.split('/').pop() === file.split('/').pop()
		));
		if (matches.length > 0) {
			parts.push(`### ${file}`);
			for (const m of matches.slice(0, 3)) {
				parts.push(`- [${m.type}] ${m.content.slice(0, 200)}`);
				relatedIds.push(m.id);
			}
		}
	}

	return {
		context: parts.join('\n').slice(0, 4000),
		relatedMemories: [...new Set(relatedIds)],
	};
}

// ─── 2. Privacy（对齐 agentmemory mem::privacy-sanitize）───────────────

const SECRET_PATTERNS = [
	/(?:api[_-]?key|secret|token|password|credential|auth)[\s]*[=:]\s*["']?[A-Za-z0-9_\-/.+]{20,}["']?/gi,
	/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi,
	/sk-[A-Za-z0-9][A-Za-z0-9\-_]{19,}/g,
	/gh[pus]_[A-Za-z0-9]{36,}/g,
	/AKIA[0-9A-Z]{16}/g,
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g,
];

export function sanitizeContent(text: string): string {
	let result = text.replace(/<private>[\s\S]*?<\/private>/gi, '[REDACTED]');
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, '[REDACTED_SECRET]');
	}
	return result;
}

// ─── 3. Export/Import（对齐 agentmemory mem::export/import）─────────────

export interface ExportData {
	version: string;
	exportedAt: string;
	agentId: string;
	memories: Memory[];
	semantic: SemanticMemory[];
	procedural: ProceduralMemory[];
	coreMemory: CoreMemoryEntry[];
}

export async function exportMemories(kv: StateKV, agentId: string): Promise<ExportData> {
	const [memories, semantic, procedural, coreMemory] = await Promise.all([
		kv.list<Memory>(KV.memories(agentId)),
		kv.list<SemanticMemory>(KV.semantic(agentId)),
		kv.list<ProceduralMemory>(KV.procedural(agentId)),
		kv.list<CoreMemoryEntry>(KV.coreMemory(agentId)),
	]);

	return {
		version: '2.0',
		exportedAt: new Date().toISOString(),
		agentId,
		memories: memories.filter(m => m.isLatest !== false),
		semantic,
		procedural,
		coreMemory,
	};
}

export async function importMemories(kv: StateKV, agentId: string, data: ExportData): Promise<number> {
	let imported = 0;
	for (const m of data.memories) {
		await kv.set(KV.memories(agentId), m.id, m);
		imported++;
	}
	for (const s of data.semantic) {
		await kv.set(KV.semantic(agentId), s.id, s);
		imported++;
	}
	for (const p of data.procedural) {
		await kv.set(KV.procedural(agentId), p.id, p);
		imported++;
	}
	for (const c of data.coreMemory) {
		await kv.set(KV.coreMemory(agentId), c.id, c);
		imported++;
	}
	return imported;
}

// ─── 4. Governance（对齐 agentmemory mem::governance-delete/bulk）───────

export async function governanceDelete(kv: StateKV, agentId: string, memoryIds: string[]): Promise<{ deleted: number }> {
	let deleted = 0;
	for (const id of memoryIds) {
		const mem = await kv.get<Memory>(KV.memories(agentId), id);
		if (mem) {
			mem.isLatest = false;
			mem.updatedAt = new Date().toISOString();
			await kv.set(KV.memories(agentId), id, mem);
			deleted++;
		}
	}
	return { deleted };
}

export async function governanceBulkDelete(kv: StateKV, agentId: string, filters: {
	type?: string; maxStrength?: number; minAgeDays?: number; pattern?: string; dryRun?: boolean;
}): Promise<{ deleted: number; matched: number; scanned: number; dryRun: boolean }> {
	const memories = await kv.list<Memory>(KV.memories(agentId));
	const active = memories.filter(m => m.isLatest !== false);
	const now = Date.now();
	const dryRun = filters.dryRun === true;
	let deleted = 0;
	let matched = 0;

	for (const m of active) {
		let match = true;
		if (filters.type && m.type !== filters.type) match = false;
		if (filters.maxStrength !== undefined && m.strength > filters.maxStrength) match = false;
		if (filters.minAgeDays) {
			const age = (now - new Date(m.createdAt).getTime()) / (24 * 60 * 60 * 1000);
			if (age < filters.minAgeDays) match = false;
		}
		if (filters.pattern && !m.content.toLowerCase().includes(filters.pattern.toLowerCase())) match = false;

		if (match) {
			matched++;
			if (!dryRun) {
				m.isLatest = false;
				m.updatedAt = new Date().toISOString();
				await kv.set(KV.memories(agentId), m.id, m);
				deleted++;
			}
		}
	}

	return { deleted, matched, scanned: active.length, dryRun };
}

// ─── 5. Diagnostics（对齐 agentmemory mem::diagnose）────────────────────

export async function diagnose(kv: StateKV, agentId: string): Promise<Record<string, unknown>> {
	const [memories, semantic, procedural, core] = await Promise.all([
		kv.list<Memory>(KV.memories(agentId)),
		kv.list<SemanticMemory>(KV.semantic(agentId)),
		kv.list<ProceduralMemory>(KV.procedural(agentId)),
		kv.list<CoreMemoryEntry>(KV.coreMemory(agentId)),
	]);

	const active = memories.filter(m => m.isLatest !== false);
	const superseded = memories.filter(m => m.isLatest === false);
	const withTTL = active.filter(m => !!m.forgetAfter);
	const lowStrength = active.filter(m => m.strength < 2);

	return {
		agentId,
		status: 'healthy',
		episodic: { total: memories.length, active: active.length, superseded: superseded.length },
		semantic: { total: semantic.length },
		procedural: { total: procedural.length },
		core: { total: core.length },
		issues: {
			ttlExpiring: withTTL.length,
			lowStrength: lowStrength.length,
			staleSuperseded: superseded.length,
		},
	};
}

// ─── 6. Heal（复刻 agentmemory mem::heal：diagnose 的自动修复侧）────────────

/**
 * 修复畸形记忆记录：补齐缺失的 isLatest/strength/concepts/createdAt 字段。
 * 保守策略——只补字段不删数据（删除走 governanceBulkDelete 的显式路径）。
 */
export async function heal(kv: StateKV, agentId: string): Promise<{ issues: string[]; fixed: number; scanned: number }> {
	const issues: string[] = [];
	let fixed = 0;
	const memories = await kv.list<Memory>(KV.memories(agentId));
	for (const m of memories) {
		let touched = false;
		if (typeof m.isLatest !== 'boolean') { m.isLatest = true; touched = true; }
		if (typeof m.strength !== 'number' || !Number.isFinite(m.strength)) { m.strength = 5; touched = true; }
		if (!Array.isArray(m.concepts)) { m.concepts = []; touched = true; }
		if (!m.createdAt) { m.createdAt = new Date().toISOString(); touched = true; }
		if (touched) {
			m.updatedAt = new Date().toISOString();
			await kv.set(KV.memories(agentId), m.id, m);
			fixed++;
		}
	}
	if (fixed > 0) { issues.push(`repaired ${fixed} malformed memories (missing isLatest/strength/concepts/createdAt)`); }
	return { issues, fixed, scanned: memories.length };
}
