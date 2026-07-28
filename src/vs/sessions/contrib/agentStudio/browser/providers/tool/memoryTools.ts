/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Memory Tools — memory_remember / memory_search / memory_delete / memory_list。
 *
 * 从 builtinToolProvider.ts 的 _registerMemoryTools 抽出，降低主文件体积。
 *
 * 统一记忆后端（2026-07 起）：全部操作经 IMemoryProvider（AgentMemoryProviderV2，
 * renderer 代理 → 网关宿主引擎 → KV 存储）。SessionMemoryProvider 的 JSONL 文件
 * 后端已废弃删除，本文件不再保留任何 JSONL 降级路径——写入/搜索/删除/列出任何
 * 一步绕过 provider 都会产生"死数据"（写入无人读取的文件）。
 *
 * 注意：本模块必须在 _registerBundledTools 之前注册——bundled 目录中的
 * memory_remember/memory_list 若抢先注册会变成 stub（isStub=true，LLM 不可调用）。
 */

import type { IAgentOSService } from '../../../common/agentOS.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

export interface MemoryToolContext {
	register(registration: IBuiltinToolRegistration): void;
	agentOS: IAgentOSService;
	logService: ILogService;
}

/**
 * M2（2026-07-26 §16）：子代理记忆写入预算——subagent 的 agentId 每次任务唯一，
 * 按 agentId 计数即 per-task 预算（默认 10，AGENT_STUDIO_SUBAGENT_MAX_MEMORY_WRITES
 * 可配）。运行日志曾出现单个子代理 93 次 writeMemory（memory_remember 滥用）。
 */
const _subagentMemoryWrites = new Map<string, number>();
const SUBAGENT_MEMORY_WRITE_BUDGET = (() => {
	try {
		const raw = typeof process !== 'undefined' ? process.env['AGENT_STUDIO_SUBAGENT_MAX_MEMORY_WRITES'] : undefined;
		const n = raw !== undefined ? Number(raw) : NaN;
		return Number.isInteger(n) && n > 0 ? n : 10;
	} catch { return 10; }
})();

function checkSubagentMemoryBudget(agentId: string): { allowed: boolean; used: number } {
	if (!agentId.startsWith('subagent-')) { return { allowed: true, used: 0 }; }
	const used = _subagentMemoryWrites.get(agentId) ?? 0;
	if (used >= SUBAGENT_MEMORY_WRITE_BUDGET) { return { allowed: false, used }; }
	_subagentMemoryWrites.set(agentId, used + 1);
	// 防御性上限：map 超 500 键时淘汰最老（agentId 含时间戳，插入序≈时间序）
	if (_subagentMemoryWrites.size > 500) {
		const oldest = _subagentMemoryWrites.keys().next().value;
		if (oldest !== undefined) { _subagentMemoryWrites.delete(oldest); }
	}
	return { allowed: true, used: used + 1 };
}

export function registerMemoryTools(ctx: MemoryToolContext): void {
	const source = 'saros.builtin-tools';

	ctx.register({
		definition: {
			name: 'memory_remember',
			description: 'Save a memory entry. Use ONLY for facts/preferences/decisions valuable across sessions (e.g. user preferences, project conventions, key decisions). Do NOT record transient task progress — put that in your final reply instead. Limit: at most 3 saves per task. The memory backend (AgentMemory) automatically deduplicates identical content.',
			inputSchema: { type: 'object', properties: {
				content: { type: 'string', description: 'Memory content to save' },
				memory_type: { type: 'string', enum: ['working', 'pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact'], description: 'Memory type (对齐 agentmemory mem::remember). working→核心槽位(mem:core-memory), 其余原生类型→长期记忆(mem:memories). semantic/procedural 由固化管线自动产出, 不接受手动写入 (default: fact)' },
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

			// M2: 子代理写入预算（per-task 默认 10 次）
			const budget = checkSubagentMemoryBudget(agentId);
			if (!budget.allowed) {
				return [{ type: 'text', text: `memory_remember: 记忆写入预算已用尽（本任务 ${SUBAGENT_MEMORY_WRITE_BUDGET} 次上限）。请将结论写入最终回复返回给主代理，而不是继续写入记忆。` }];
			}

			const memProvider = ctx.agentOS.getActiveMemoryProvider();
			if (!memProvider) {
				return [{ type: 'text', text: 'memory_remember error: no memory provider available (AgentMemory gateway not running?)' }];
			}

			// R2: slot_id 支持 — LLM 可直接编辑记忆槽位（对齐 agentmemory memory_slot_set）
			if (slotId) {
				const validSlots = ['persona', 'user_preferences', 'project_context', 'tool_guidelines', 'guidance', 'pending_items', 'session_patterns', 'self_notes'];
				if (!validSlots.includes(slotId)) {
					return [{ type: 'text', text: `memory_remember error: invalid slot_id "${slotId}". Valid: ${validSlots.join(', ')}` }];
				}
				try {
				await memProvider.writeMemory(agentId, {
					id: `slot-${slotId}-${Date.now()}`,
					type: 'working',
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

			const memType = (args['memory_type'] as string || 'fact');
			const tags = Array.isArray(args['tags']) ? args['tags'] as string[] : undefined;
			const importance = typeof args['importance'] === 'number' ? Math.max(0, Math.min(10, args['importance'] as number)) : 5;
			const entry = {
				id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
				type: memType,
				content,
				timestamp: Date.now(),
				importance,
				// importance/tags 一并放 metadata，供引擎 writeMemory 读取（working→coreAdd；原生类型→remember→mem:memories）
				metadata: { importance, ...(tags ? { tags } : {}) },
			};

			try {
				await memProvider.writeMemory(agentId, entry);
				return [{ type: 'text', text: `Memory saved (${memType}, importance=${importance}): ${content.slice(0, 100)}` }];
			} catch (err) {
				ctx.logService.warn('[BuiltinTools] memory_remember: provider write failed:', err);
				return [{ type: 'text', text: `memory_remember failed: ${err instanceof Error ? err.message : String(err)}` }];
			}
		},
	});

	// ── memory_search ──────────────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_search',
			description: 'Search memories by keyword or natural-language query. Returns matching entries sorted by relevance (semantic search: BM25 + Vector + Graph hybrid via AgentMemory).',
			inputSchema: { type: 'object', properties: {
				query: { type: 'string', description: 'Search query (natural language or keyword)' },
				limit: { type: 'number', description: 'Max results (default: 10)' },
			}, required: ['query'] },
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_search error: agentId is required' }]; }
			const query = (args['query'] as string) || '';
			const limit = typeof args['limit'] === 'number' ? Math.min(args['limit'] as number, 50) : 10;

			const memProvider = ctx.agentOS.getActiveMemoryProvider();
			if (!memProvider) {
				return [{ type: 'text', text: 'memory_search error: no memory provider available (AgentMemory gateway not running?)' }];
			}

			try {
				const results = await memProvider.searchMemory(agentId, query);
				const slice = results.slice(0, limit);
				if (slice.length === 0) { return [{ type: 'text', text: 'No matching memories found.' }]; }
				const lines = slice.map(e => {
					const score = e.score !== undefined ? ` (score: ${e.score.toFixed(2)})` : '';
					const imp = e.importance !== undefined ? ` [importance: ${e.importance}]` : '';
					const ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
					return `- [${e.type}]${imp}${score} ${ts} (id: ${e.id}): ${e.content.slice(0, 200)}`;
				});
				return [{ type: 'text', text: `Found ${slice.length} matching memories (semantic search):\n${lines.join('\n')}` }];
			} catch (err) {
				ctx.logService.warn('[BuiltinTools] memory_search: provider search failed:', err);
				return [{ type: 'text', text: `memory_search failed: ${err instanceof Error ? err.message : String(err)}` }];
			}
		},
	});

	// ── memory_delete ──────────────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_delete',
			description: 'Delete (forget) a memory entry by its ID. Use memory_search first to find the entry ID. Deletion is a soft-delete in AgentMemory (entry is marked forgotten, no longer recalled). For bulk cleanup use memory_governance.',
			inputSchema: { type: 'object', properties: {
				id: { type: 'string', description: 'Memory entry ID to delete' },
			}, required: ['id'] },
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_delete error: agentId is required' }]; }
			const id = args['id'] as string;
			if (!id) { return [{ type: 'text', text: 'memory_delete error: id is required' }]; }

			const memProvider = ctx.agentOS.getActiveMemoryProvider();
			if (!memProvider) {
				return [{ type: 'text', text: 'memory_delete error: no memory provider available (AgentMemory gateway not running?)' }];
			}

			// V2 统一 KV 存储不分短/长期文件，forgetMemory 即软删除入口。
			const forgetFn = (memProvider as { forgetMemory?: (a: string, id: string) => Promise<boolean> }).forgetMemory;
			if (typeof forgetFn !== 'function') {
				return [{ type: 'text', text: 'memory_delete error: active memory provider does not support deletion' }];
			}
			try {
				const ok = await forgetFn.call(memProvider, agentId, id);
				return ok
					? [{ type: 'text', text: `Deleted memory entry ${id}.` }]
					: [{ type: 'text', text: `Memory entry ${id} not found.` }];
			} catch (err) {
				ctx.logService.warn('[BuiltinTools] memory_delete: provider forget failed:', err);
				return [{ type: 'text', text: `memory_delete failed: ${err instanceof Error ? err.message : String(err)}` }];
			}
		},
	});

	// ── memory_list ────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_list',
			description: 'List memory entries, optionally filtered by type. Returns newest entries first.',
			inputSchema: { type: 'object', properties: {
				memory_type: { type: 'string', enum: ['working', 'semantic', 'procedural', 'pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact'], description: 'Only list entries of this type (default: all types)' },
				limit: { type: 'number', description: 'Max entries to return (default: 20)' },
			} },
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_list error: agentId is required' }]; }
			const memType = args['memory_type'] as string | undefined;
			const limit = typeof args['limit'] === 'number' ? Math.min(args['limit'] as number, 50) : 20;

			const memProvider = ctx.agentOS.getActiveMemoryProvider();
			if (!memProvider) {
				return [{ type: 'text', text: 'memory_list error: no memory provider available (AgentMemory gateway not running?)' }];
			}

			try {
				// 空查询 = 全量列出（provider 对空 query 返回全部 active 记忆）。
				let entries = await memProvider.searchMemory(agentId, '');
				if (memType) {
					entries = entries.filter(e => e.type === memType);
				}
				entries.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
				const slice = entries.slice(0, limit);
				if (slice.length === 0) {
					return [{ type: 'text', text: memType ? `No ${memType} memories found.` : 'No memories found.' }];
				}
				const lines = slice.map(e => `[${e.id.slice(-8)}] [${e.type}] ${e.timestamp ? new Date(e.timestamp).toLocaleString() : ''}: ${e.content.slice(0, 200)}`);
				return [{ type: 'text', text: `${memType ?? 'all'} memories (${slice.length}/${entries.length}):\n${lines.join('\n')}` }];
			} catch (err) {
				ctx.logService.warn('[BuiltinTools] memory_list: provider list failed:', err);
				return [{ type: 'text', text: `memory_list failed: ${err instanceof Error ? err.message : String(err)}` }];
			}
		},
	});

	ctx.logService.info('[BuiltinTools] registerMemoryTools: 4 memory tools registered (V2 provider-only)');
}
