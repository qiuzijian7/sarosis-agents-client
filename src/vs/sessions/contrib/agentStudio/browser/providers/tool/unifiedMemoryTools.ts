/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unified Memory Tools — memory_recall / memory_improve / memory_forget (G12)。
 *
 * 从 builtinToolProvider.ts 的 _registerUnifiedMemoryTools 抽出，降低主文件体积。
 * 对齐 cognee remember/recall/improve/forget 的统一记忆 API：
 *   - memory_recall : 语义化检索（hybrid / graph / vector 多策略 + reranker）
 *   - memory_improve : 强化/更新/合并已有记忆
 *   - memory_forget  : 软删除记忆（保留审计历史）
 */

import type { IToolResultContent } from '../../../common/providers.js';
import type { IAgentOSService } from '../../../common/agentOS.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

export interface UnifiedMemoryToolContext {
	register(registration: IBuiltinToolRegistration): void;
	agentOS: IAgentOSService;
	logService: ILogService;
}

export function registerUnifiedMemoryTools(ctx: UnifiedMemoryToolContext): void {
	const source = 'saros.builtin-tools';
	const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

	// memory_recall: 语义化检索 (比 memory_search 更智能，支持多策略 + reranker)
	ctx.register({
		definition: {
			name: 'memory_recall',
			description: 'Recall memories using semantic search with multi-strategy support. More intelligent than memory_search — supports hybrid (BM25+Vector), graph-first, and vector-first strategies with automatic re-ranking.',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'What to recall (natural language query)' },
					strategy: { type: 'string', enum: ['hybrid', 'graph_first', 'vector_first', 'graph_only', 'vector_only'], description: 'Search strategy (default: hybrid)' },
					limit: { type: 'number', description: 'Max results (default: 10)' },
				},
				required: ['query'],
			},
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return text('memory_recall error: agentId is required'); }
			const query = args['query'] as string;
			if (!query) { return text('memory_recall error: query is required'); }
			const memProvider = ctx.agentOS.getActiveMemoryProvider();
			if (!memProvider) { return text('memory_recall: no memory provider available'); }
			const strategy = (args['strategy'] as string) ?? 'hybrid';
			const limit = (args['limit'] as number) ?? 10;
			try {
				// G8/G9/G10/G2: 多策略召回 + rerank + GraphRAG + 长结果分块
				const recallFn = (memProvider as any).recallFormatted;
				if (typeof recallFn === 'function') {
					return text(await recallFn.call(memProvider, agentId, query, strategy, limit));
				}
				// 回退：provider 不支持多策略时退回普通 searchMemory
				const results = await memProvider.searchMemory(agentId, query);
				const limited = results.slice(0, limit);
				if (limited.length === 0) { return text('memory_recall: no results found'); }
				const summary = limited.map((r: any, i: number) =>
					`[${i + 1}] ${r.content?.slice(0, 200) ?? ''}`
				).join('\n');
				return text(`Recalled ${limited.length} memories:\n${summary}`);
			} catch (err) {
				return text(`memory_recall failed: ${err}`);
			}
		},
	});

	// memory_improve: 改进/强化已有记忆
	ctx.register({
		definition: {
			name: 'memory_improve',
			description: 'Improve an existing memory by reinforcing its importance or updating its content. Use this when you encounter information that confirms or enhances a previously saved memory.',
			inputSchema: {
				type: 'object',
				properties: {
					memory_id: { type: 'string', description: 'ID of the memory to improve' },
					action: { type: 'string', enum: ['reinforce', 'update', 'merge'], description: 'reinforce=boost importance, update=replace content, merge=append content' },
					new_content: { type: 'string', description: 'New or additional content (for update/merge actions)' },
				},
				required: ['memory_id', 'action'],
			},
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return text('memory_improve error: agentId is required'); }
			const memId = args['memory_id'] as string;
			const action = args['action'] as string;
			const newContent = args['new_content'] as string | undefined;
			const memProvider = ctx.agentOS.getActiveMemoryProvider();
			if (!memProvider) { return text('memory_improve: no memory provider available'); }

			// reinforce: 通过 writeMemory 重新写入相同内容 (触发 accessCount++)
			// update/merge: 写入新内容
			try {
				if (action === 'reinforce') {
					// 强化 = 提升重要性/访问度（不再覆盖原内容）
					const fn = (memProvider as any).reinforceMemory;
					if (typeof fn === 'function') {
						const ok = await fn.call(memProvider, agentId, memId);
						return ok ? text(`Memory ${memId} reinforced.`) : text(`memory_improve: memory ${memId} not found`);
					}
					// 回退（旧行为，可能覆盖原内容）
					await memProvider.writeMemory(agentId, {
						id: memId,
						type: 'episodic',
						content: '(reinforced)',
						metadata: { reinforced: true, source: 'memory_improve' },
					});
					return text(`Memory ${memId} reinforced.`);
				}
				if ((action === 'update' || action === 'merge') && newContent) {
					await memProvider.writeMemory(agentId, {
						id: `${memId}-${action}-${Date.now()}`,
						type: 'episodic',
						content: newContent,
						metadata: { improves: memId, action, source: 'memory_improve' },
					});
					return text(`Memory ${memId} ${action}d with new content.`);
				}
				return text(`memory_improve: unknown action "${action}"`);
			} catch (err) {
				return text(`memory_improve failed: ${err}`);
			}
		},
	});

	// memory_forget: 删除记忆 (软删除)
	ctx.register({
		definition: {
			name: 'memory_forget',
			description: 'Forget (soft-delete) a memory entry. The memory is marked as deleted but not physically removed, preserving audit history.',
			inputSchema: {
				type: 'object',
				properties: {
					memory_id: { type: 'string', description: 'ID of the memory to forget' },
					reason: { type: 'string', description: 'Optional reason for forgetting' },
				},
				required: ['memory_id'],
			},
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return text('memory_forget error: agentId is required'); }
			const memId = args['memory_id'] as string;
			const reason = args['reason'] as string | undefined;
			const memProvider = ctx.agentOS.getActiveMemoryProvider();
			if (!memProvider) { return text('memory_forget: no memory provider available'); }
			try {
				// 软删除：标记原记忆为 superseded（不再被召回）
				const fn = (memProvider as any).forgetMemory;
				if (typeof fn === 'function') {
					const ok = await fn.call(memProvider, agentId, memId, reason);
					return ok
						? text(`Memory ${memId} has been forgotten.${reason ? ` Reason: ${reason}` : ''}`)
						: text(`memory_forget: memory ${memId} not found`);
				}
				// 回退（旧行为：仅写 forget 标记，原记忆仍可被召回）
				await memProvider.writeMemory(agentId, {
					id: `forget-${memId}-${Date.now()}`,
					type: 'episodic',
					content: `(forgotten: ${memId})`,
					metadata: { forgets: memId, reason: reason ?? 'user_request', source: 'memory_forget' },
				});
				return text(`Memory ${memId} has been forgotten.${reason ? ` Reason: ${reason}` : ''}`);
			} catch (err) {
				return text(`memory_forget failed: ${err}`);
			}
		},
	});

	ctx.logService.info('[BuiltinTools] registerUnifiedMemoryTools: 3 unified memory tools registered');
}
