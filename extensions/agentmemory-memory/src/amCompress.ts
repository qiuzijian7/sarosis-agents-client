/*---------------------------------------------------------------------------------------------
 *  amCompress.ts — 压缩闭环（Zero-LLM synthetic compress + SessionSummary）
 *  1:1 复刻 agentmemory compress-synthetic.ts + observe.ts 压缩触发逻辑
 *
 *  流程：observe() → 累积到阈值 → compressSession() → SessionSummary → context 注入
 *--------------------------------------------------------------------------------------------*/

import type { StateKV } from './stateKV.js';
import type { Observation, SessionSummary } from './amTypes.js';
import { KV } from './amSchema.js';

// ─── 常量 ─────────────────────────────────────────────────────────────

/** 触发压缩的观测数阈值（略低于 agentmemory 的 20 */ 
export const COMPRESS_OBS_THRESHOLD = 15;

// ─── Synthetic Compress ──────────────────────────────────────────────────

/** 
 * Zero-LLM 压缩：从观测列表中提取结构化摘要。
 * 对齐 agentmemory buildSyntheticCompression 的逻辑。
 */
export function buildSyntheticCompression(
	observations: Observation[],
): { title: string; narrative: string; files: string[]; concepts: string[]; decisions: string[] } {
	if (observations.length === 0) {
		return { title: 'Empty session', narrative: '', files: [], concepts: [], decisions: [] };
	}

	// 收集文件引用
	const files = new Set<string>();
	const concepts = new Set<string>();
	const decisions = new Set<string>();
	const narrativeParts: string[] = [];

	for (const obs of observations) {
		const data = obs.data as Record<string, unknown> | undefined;
		if (!data) continue;

		// 提取文件路径（对齐 agentmemory extractFiles，包括 tool_input 嵌套）
		const extractFilesFrom = (d: Record<string, unknown> | undefined) => {
			if (!d) return;
			for (const key of ['file_path', 'filepath', 'path', 'filePath', 'file', 'pattern']) {
				const v = d[key];
				if (typeof v === 'string' && v.length > 0 && v.length < 512) files.add(v);
			}
		};
		extractFilesFrom(data);
		if (typeof data['tool_input'] === 'object' && data['tool_input'] !== null) {
			extractFilesFrom(data['tool_input'] as Record<string, unknown>);
		}

		// 提取 concepts
		if (Array.isArray(data['concepts'])) {
			for (const c of data['concepts'] as string[]) {
				if (typeof c === 'string' && c.length > 0) concepts.add(c);
			}
		}

		// 提取 decisions
		const decision = data['decision'] || data['result'];
		if (typeof decision === 'string' && decision.length > 0 && decision.length < 200) {
			decisions.add(decision);
		}

		// 构建叙事片段
		const input = stringify(data['tool_input'] || data['input']);
		const output = stringify(data['tool_output'] || data['output'] || data['result']);
		const prompt = stringify(data['prompt'] || data['user_message']);
		const parts = [prompt, input, output].filter(s => s.length > 0);
		if (parts.length > 0) {
			narrativeParts.push(truncate(parts.join(' | '), 200));
		}
	}

	// 构建标题：取最常见的 hookType
	const hookCounts = new Map<string, number>();
	for (const o of observations) {
		hookCounts.set(o.hookType, (hookCounts.get(o.hookType) || 0) + 1);
	}
	const topHook = [...hookCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'session';
	const title = `${topHook} session (${observations.length} observations)`;

	// 叙事：前 5 个片段
	const narrative = narrativeParts.slice(0, 5).join('\n');

	return {
		title,
		narrative,
		files: [...files],
		concepts: [...concepts],
		decisions: [...decisions],
	};
}

function stringify(v: unknown): string {
	if (v == null) return '';
	if (typeof v === 'string') return v;
	try { return JSON.stringify(v); } catch { return String(v); }
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
}

// ─── Compress Session ──────────────────────────────────────────────────

/**
 * 压缩会话：收集观测 → synthetic compress → 写入 SessionSummary。
 * 对齐 agentmemory compressSession 流程。
 */
export async function compressSession(
	kv: StateKV, agentId: string, sessionId: string, project?: string,
): Promise<SessionSummary | null> {
	try {
		const scope = KV.observations(agentId, sessionId);
		const observations = await kv.list<Observation>(scope);

		// 过滤出未压缩的观测
		const uncompressed = observations.filter(o => !o.compressed);
		if (uncompressed.length === 0) return null;

		// 标记为已压缩
		const now = new Date().toISOString();
		for (const o of uncompressed.slice(0, COMPRESS_OBS_THRESHOLD)) {
			o.compressed = true;
			await kv.set(scope, o.id, o);
		}

		// 构建 synthetic 压缩
		const compressed = buildSyntheticCompression(uncompressed);

		// 写入 SessionSummary
		const summary: SessionSummary = {
			sessionId,
			project: project || 'default',
			createdAt: now,
			title: compressed.title,
			narrative: compressed.narrative,
			keyDecisions: compressed.decisions,
			filesModified: compressed.files,
			concepts: compressed.concepts,
			observationCount: uncompressed.length,
			agentId,
		};

		await kv.set(KV.summaries(agentId), sessionId, summary);
		return summary;
	} catch {
		return null;
	}
}

/**
 * 检查是否需要压缩，若达到阈值则自动触发。
 * 在 observe() 调用后调用此函数。
 */
export async function maybeCompressSession(
	kv: StateKV, agentId: string, sessionId: string, project?: string,
): Promise<SessionSummary | null> {
	try {
		const count = await countUncompressed(kv, agentId, sessionId);
		if (count >= COMPRESS_OBS_THRESHOLD) {
			return await compressSession(kv, agentId, sessionId, project);
		}
		return null;
	} catch {
		return null;
	}
}

async function countUncompressed(kv: StateKV, agentId: string, sessionId: string): Promise<number> {
	try {
		const obs = await kv.list<Observation>(KV.observations(agentId, sessionId));
		return obs.filter(o => !o.compressed).length;
	} catch {
		return 0;
	}
}

/**
 * 为 onPreCompact 注入上下文的 SessionSummary 列表。
 * 对齐 agentmemory context.ts 中从 KV.summaries 读取的逻辑。
 */
export async function getCompactContext(
	kv: StateKV, agentId: string, limit = 5,
): Promise<SessionSummary[]> {
	try {
		const all = await kv.list<SessionSummary>(KV.summaries(agentId));
		return all
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, limit);
	} catch {
		return [];
	}
}
