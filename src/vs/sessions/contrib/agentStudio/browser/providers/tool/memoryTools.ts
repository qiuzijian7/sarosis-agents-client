/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Memory Tools — memory_remember / memory_search / memory_delete / memory_list。
 *
 * 从 builtinToolProvider.ts 的 _registerMemoryTools 抽出，降低主文件体积。
 * 同时把记忆去重 + JSONL 持久化 helper 一并搬为模块级函数（仅本分组使用）：
 *   - computeTextSimilarity / findDuplicateMemory（Jaccard 3-gram 去重）
 *   - getMemFile / readJsonl / writeAtomic（基于 fileService 的原子写）
 */

import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import type { IAgentOSService } from '../../../common/agentOS.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IFileService } from '../../../../../../platform/files/common/files.js';
import type { INativeEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

/** 记忆去重相似度阈值（Jaccard 相似度 ≥ 此值视为重复） */
const MEMORY_DUPLICATE_THRESHOLD = 0.85;

export interface MemoryToolContext {
	register(registration: IBuiltinToolRegistration): void;
	agentOS: IAgentOSService;
	logService: ILogService;
	fileService: IFileService;
	environmentService: INativeEnvironmentService;
}

/**
 * 计算两段文本的相似度（基于字符 3-gram 的 Jaccard 相似度）。
 * 返回值范围 [0, 1]，1 表示完全相同。
 */
function computeTextSimilarity(text1: string, text2: string): number {
	const s1 = text1.toLowerCase().trim();
	const s2 = text2.toLowerCase().trim();
	if (s1 === s2) { return 1.0; }
	if (Math.abs(s1.length - s2.length) > Math.max(s1.length, s2.length) * 0.3) {
		// 长度差异超过 30% 大概率不相似，快速返回 0 以节省计算
		return 0.0;
	}

	const n = 3; // character n-gram size
	const getNgrams = (s: string): Set<string> => {
		if (s.length < n) { return new Set([s]); }
		const grams = new Set<string>();
		for (let i = 0; i <= s.length - n; i++) {
			grams.add(s.slice(i, i + n));
		}
		return grams;
	};

	const g1 = getNgrams(s1);
	const g2 = getNgrams(s2);
	const intersection = new Set([...g1].filter(g => g2.has(g)));
	const union = new Set([...g1, ...g2]);
	if (union.size === 0) { return 1.0; }
	return intersection.size / union.size;
}

/**
 * 检查新记忆内容是否与已有记忆重复。
 * 返回重复记忆的 id；若无重复返回 null。
 */
function findDuplicateMemory(entries: Array<{ id: string; content: string; [key: string]: unknown }>, newContent: string): string | null {
	for (const entry of entries) {
		const sim = computeTextSimilarity(entry.content, newContent);
		if (sim >= MEMORY_DUPLICATE_THRESHOLD) {
			return entry.id;
		}
	}
	return null;
}

/** 解析某 agent 的记忆文件路径（用户主目录下 .saros/memory/<agentId>/<fileName>） */
function getMemFile(userHome: URI, agentId: string, fileName: string): URI {
	const safe = agentId.replace(/[^A-Za-z0-9_.-]/g, '_');
	return URI.joinPath(userHome, '.saros', 'memory', safe, fileName);
}

/** 读取 JSONL 文件，逐行解析；文件不存在/解析失败返回空数组 */
async function readJsonl(fileService: IFileService, file: URI): Promise<any[]> {
	try {
		const buf = await fileService.readFile(file);
		const text = buf.value.toString();
		const out: any[] = [];
		for (const raw of text.split('\n')) {
			const line = raw.trim();
			if (!line) { continue; }
			try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
		}
		return out;
	} catch {
		return [];
	}
}

/** 原子写：先写临时文件再 move 覆盖，避免半写损坏 */
async function writeAtomic(fileService: IFileService, file: URI, entries: any[]): Promise<void> {
	const text = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
	const tmpFile = URI.joinPath(file, '..', `.mem_${Date.now()}_${Math.random().toString(36).slice(2)}`);
	try {
		await fileService.writeFile(tmpFile, VSBuffer.fromString(text));
		await fileService.move(tmpFile, file, true);
	} catch (err) {
		try { await fileService.del(tmpFile); } catch { /* ignore */ }
		throw err;
	}
}

export function registerMemoryTools(ctx: MemoryToolContext): void {
	const source = 'saros.builtin-tools';
	const userHome = ctx.environmentService.userHome;

	ctx.register({
		definition: {
			name: 'memory_remember',
			description: 'Save a memory entry (short-term or long-term). Use this to persist important information across sessions. Automatically detects and merges duplicate content (similarity >= 0.85) by updating the existing entry.',
			inputSchema: { type: 'object', properties: {
				content: { type: 'string', description: 'Memory content to save' },
				memory_type: { type: 'string', enum: ['working', 'episodic', 'semantic', 'procedural'], description: 'Memory type (default: episodic)' },
				tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering' },
				importance: { type: 'number', description: 'Importance score 0-10 (default: 5)' },
				slot_id: { type: 'string', description: 'If set, write to a specific memory slot (persona/user_preferences/project_context/tool_guidelines/guidance) instead of creating a memory entry' },
			}, required: ['content'] },
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_remember error: agentId is required' }]; }
			const content = args['content'] as string;
			if (!content) { return [{ type: 'text', text: 'memory_remember error: content is required' }]; }
			const slotId = args['slot_id'] as string | undefined;

			// R2: slot_id 支持 — LLM 可直接编辑记忆槽位（对齐 agentmemory memory_slot_set）
			if (slotId) {
				const validSlots = ['persona', 'user_preferences', 'project_context', 'tool_guidelines', 'guidance', 'pending_items', 'session_patterns', 'self_notes'];
				if (!validSlots.includes(slotId)) {
					return [{ type: 'text', text: `memory_remember error: invalid slot_id "${slotId}". Valid: ${validSlots.join(', ')}` }];
				}
				const memProvider = ctx.agentOS.getActiveMemoryProvider();
				if (memProvider) {
					try {
						await memProvider.writeMemory(agentId, {
							id: `slot-${slotId}-${Date.now()}`,
							type: 'episodic',
							content,
							timestamp: Date.now(),
							importance: 8,
							metadata: { slot_id: slotId, source: 'llm_slot_edit' },
						});
						return [{ type: 'text', text: `Slot "${slotId}" updated: ${content.slice(0, 100)}` }];
					} catch (err) {
						ctx.logService.warn('[BuiltinTools] memory_remember slot write failed:', err);
						return [{ type: 'text', text: `Failed to update slot "${slotId}": ${err}` }];
					}
				}
				return [{ type: 'text', text: 'memory_remember error: no memory provider available for slot write' }];
			}
			const memType: 'working' | 'episodic' = (args['memory_type'] as string || 'episodic') === 'working' ? 'working' : 'episodic';
			const tags = Array.isArray(args['tags']) ? args['tags'] as string[] : undefined;
			const importance = typeof args['importance'] === 'number' ? Math.max(0, Math.min(10, args['importance'] as number)) : 5;
			const entry = {
				id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
				type: memType as 'working' | 'episodic' | 'semantic' | 'procedural',
				content,
				timestamp: Date.now(),
				importance,
				metadata: tags ? { tags } : undefined,
			};

			// ── 优先通过 IMemoryProvider 写入（同步到 provider 的索引/向量存储）──
			const memProvider = ctx.agentOS.getActiveMemoryProvider();
			if (memProvider) {
				try {
					await memProvider.writeMemory(agentId, entry);
					return [{ type: 'text', text: `Memory saved (${memType}, importance=${importance}): ${content.slice(0, 100)}` }];
				} catch (err) {
					ctx.logService.warn('[BuiltinTools] memory_remember: provider write failed, falling back to local:', err);
				}
			}

			// ── 降级：本地 JSONL 写入 ─────────────────────────────────
			const file = getMemFile(userHome, agentId, memType === 'working' ? 'short-term.jsonl' : 'long-term.jsonl');
			try { await ctx.fileService.createFolder(URI.joinPath(file, '..')); } catch { /* ignore */ }
			const existing = await readJsonl(ctx.fileService, file);

			// 去重检查：若与新内容相似的记忆已存在，则更新已有记忆而非重复写入
			const dupId = findDuplicateMemory(existing, content);
			if (dupId) {
				// 更新已有记忆：刷新时间戳，若新重要性更高则覆盖
				const idx = existing.findIndex((e: any) => e.id === dupId);
				if (idx >= 0) {
					existing[idx].timestamp = Date.now();
					if (importance > (existing[idx].importance ?? 5)) {
						existing[idx].importance = importance;
					}
					if (tags) { existing[idx].metadata = { ...(existing[idx].metadata ?? {}), tags }; }
				}
				if (memType === 'working') { while (existing.length > 200) existing.shift(); }
				await writeAtomic(ctx.fileService, file, existing);
				return [{ type: 'text', text: `Memory updated (duplicate detected, similarity >= ${MEMORY_DUPLICATE_THRESHOLD}): ${content.slice(0, 100)}\n[memory_file: ${file.toString()}]` }];
			}

			// 无重复，写入新记忆
			existing.push(entry);
			if (memType === 'working') { while (existing.length > 200) existing.shift(); }
			await writeAtomic(ctx.fileService, file, existing);
			return [{ type: 'text', text: `Memory saved (${memType}, importance=${importance}): ${content.slice(0, 100)}\n[memory_file: ${file.toString()}]` }];
		},
	});

	// ── memory_search ──────────────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_search',
			description: 'Search memories by keyword, tag, or time range. Returns matching entries sorted by relevance (semantic search when available, falls back to keyword matching).',
			inputSchema: { type: 'object', properties: {
				query: { type: 'string', description: "Search query. Supports prefixes: tag:foo, type:short, type:long, after:YYYY-MM-DD, before:YYYY-MM-DD, recent:7d (or 24h)" },
				limit: { type: 'number', description: 'Max results (default: 10)' },
			}, required: ['query'] },
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_search error: agentId is required' }]; }
			const query = (args['query'] as string) || '';
			const limit = typeof args['limit'] === 'number' ? Math.min(args['limit'] as number, 50) : 10;

			// ── 优先使用 IMemoryProvider（支持语义搜索：BM25 + Vector + Graph 混合搜索）──
			const memProvider = ctx.agentOS.getActiveMemoryProvider();
			if (memProvider) {
				try {
					const results = await memProvider.searchMemory(agentId, query);
					if (results.length > 0) {
						const slice = results.slice(0, limit);
						const lines = slice.map(e => {
							const score = e.score !== undefined ? ` (score: ${e.score.toFixed(2)})` : '';
							const imp = e.importance !== undefined ? ` [importance: ${e.importance}]` : '';
							const ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
							return `- [${e.type}]${imp}${score} ${ts}: ${e.content.slice(0, 200)}`;
						});
						return [{ type: 'text', text: `Found ${slice.length} matching memories (semantic search):\n${lines.join('\n')}` }];
					}
					// Provider returned empty — fall through to local search
				} catch (err) {
					ctx.logService.warn('[BuiltinTools] memory_search: provider search failed, falling back to local:', err);
				}
			}

			// ── 降级：本地 JSONL 子串匹配 ──────────────────────────────
			let typeFilter: 'working' | 'episodic' | 'semantic' | 'procedural' | undefined;
			let tagFilter: string | undefined;
			const tokens = query.split(/\s+/);
			const remaining: string[] = [];
			for (const tok of tokens) {
				if (tok.startsWith('type:')) {
					const v = tok.slice(5);
					typeFilter = v === 'working' ? 'working' : v === 'episodic' ? 'episodic' : v === 'semantic' ? 'semantic' : v === 'procedural' ? 'procedural' : undefined;
				} else if (tok.startsWith('tag:')) {
					tagFilter = tok.slice(4);
				} else {
					remaining.push(tok);
				}
			}
			const textQuery = remaining.join(' ').trim().toLowerCase();
			const [shortTerm, longTerm] = await Promise.all([
				typeFilter === 'episodic' ? Promise.resolve([] as any[]) : readJsonl(ctx.fileService, getMemFile(userHome, agentId, 'short-term.jsonl')),
				typeFilter === 'working' ? Promise.resolve([] as any[]) : readJsonl(ctx.fileService, getMemFile(userHome, agentId, 'long-term.jsonl')),
			]);
			const all = [...shortTerm, ...longTerm];
			const matched = all.filter(e => {
				if (textQuery && !e.content.toLowerCase().includes(textQuery)) { return false; }
				if (tagFilter) {
					const tags = (e.metadata?.['tags'] as string[] | undefined) ?? [];
					if (!Array.isArray(tags) || !tags.includes(tagFilter)) { return false; }
				}
				return true;
			});
			matched.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
			const slice = matched.slice(0, limit);
			if (slice.length === 0) { return [{ type: 'text', text: 'No matching memories found.' }]; }
			const lines = slice.map(e => `- [${e.type}] ${new Date(e.timestamp).toLocaleString()}: ${e.content.slice(0, 200)}`);
			return [{ type: 'text', text: `Found ${slice.length} matching memories:\n${lines.join('\n')}` }];
		},
	});

	// ── memory_delete ──────────────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_delete',
			description: 'Delete a memory entry by its ID. Use memory_search first to find the entry ID.',
			inputSchema: { type: 'object', properties: {
				id: { type: 'string', description: 'Memory entry ID to delete' },
				memory_type: { type: 'string', enum: ['working', 'episodic', 'semantic', 'procedural'], description: 'Memory type to delete from' },
			}, required: ['id', 'memory_type'] },
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_delete error: agentId is required' }]; }
			const id = args['id'] as string;
			const memType = (args['memory_type'] as string || 'episodic') === 'working' ? 'working' : 'episodic';
			if (!id) { return [{ type: 'text', text: 'memory_delete error: id is required' }]; }
			const file = getMemFile(userHome, agentId, memType === 'working' ? 'short-term.jsonl' : 'long-term.jsonl');
			const existing = await readJsonl(ctx.fileService, file);
			const before = existing.length;
			const filtered = existing.filter(e => e.id !== id);
			if (filtered.length === before) {
				return [{ type: 'text', text: `Memory entry ${id} not found in ${memType}.\n[memory_file: ${file.toString()}]` }];
			}
			await writeAtomic(ctx.fileService, file, filtered);
			return [{ type: 'text', text: `Deleted memory entry ${id} from ${memType}.\n[memory_file: ${file.toString()}]` }];
		},
	});

	// ── memory_list ────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_list',
			description: 'List all memory entries of a given type.',
			inputSchema: { type: 'object', properties: {
				memory_type: { type: 'string', enum: ['working', 'episodic', 'semantic', 'procedural'], description: 'Memory type to list (default: episodic)' },
				limit: { type: 'number', description: 'Max entries to return (default: 20)' },
			} },
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_list error: agentId is required' }]; }
			const memType = (args['memory_type'] as string || 'episodic') === 'working' ? 'working' : 'episodic';
			const limit = typeof args['limit'] === 'number' ? Math.min(args['limit'] as number, 50) : 20;
			const file = getMemFile(userHome, agentId, memType === 'working' ? 'short-term.jsonl' : 'long-term.jsonl');
			const entries = await readJsonl(ctx.fileService, file);
			entries.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
			const slice = entries.slice(0, limit);
			if (slice.length === 0) { return [{ type: 'text', text: `No ${memType} memories found.\n[memory_file: ${file.toString()}]` }]; }
			const lines = slice.map(e => `[${e.id.slice(-8)}] ${new Date(e.timestamp).toLocaleString()}: ${e.content.slice(0, 200)}`);
			return [{ type: 'text', text: `${memType} memories (${slice.length}/${entries.length}):\n${lines.join('\n')}\n[memory_file: ${file.toString()}]` }];
		},
	});

	ctx.logService.info('[BuiltinTools] registerMemoryTools: 4 memory tools registered');
}
