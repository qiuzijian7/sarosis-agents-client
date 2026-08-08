/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent Memory 上下文注入 — 从 _executeWithFallbackDirectly 核心生成器内抽出（~216 行）。
 *
 * 负责：加载 Memory 上下文、Hooks（session_start/prompt_submit）、策略过滤、
 * 构建注入块、修改 messages 数组、yield memory_injected delta。
 */

import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatStreamDelta, IAgentTurnRequest } from '../common/providers.js';
import { insertMessages } from '../common/agentRunState.js';

export interface MemoryInjectionDeps {
	readonly logService: ILogService;
	getActiveMemoryProvider: () => any;
	injectedSessions: Set<string>;
}

/**
 * 注入硬超时（对齐原版 hook 语义：session-start 1.5s / enrich 2s + 静默失败）。
 * 记忆注入绝不允许阻塞 turn 启动——网关繁忙（大库压缩/大扫除）时超时降级为空上下文。
 */
const MEMORY_INJECT_TIMEOUT_MS = 2000;

/**
 * 从 Memory Provider 加载上下文并注入到消息数组。
 * 在 _executeWithFallbackDirectly agent loop 开始前调用。
 * yield memory_injected delta 通知 UI。
 * @returns 修改后的 messages 数组。
 */
export async function* injectMemoryContext(
	deps: MemoryInjectionDeps,
	request: IAgentTurnRequest,
	messages: any[]
): AsyncGenerator<IChatStreamDelta, { messages: any[] }> {

	// ── 全局开关：AGENTMEMORY_INJECT_CONTEXT ──────────────────────
	// 对齐 agentmemory config.ts isContextInjectionEnabled()——默认关闭
	// （显式 AGENTMEMORY_INJECT_CONTEXT=true 才注入；capture 写入通道常开，
	// 召回走工具。减少每轮 token 消耗、避免记忆污染）。
	if (!isMemoryInjectionEnabled()) {
		deps.logService.info('[AgentOS][MemoryInjection] DISABLED — AGENTMEMORY_INJECT_CONTEXT is not "true"');
		return { messages };
	}

	const memoryProvider = deps.getActiveMemoryProvider();

	// ── Hook: session_start + prompt_submit ──────────────────────────
	if (memoryProvider?.triggerHook) {
		const userMsg = [...(request.messages as Array<{ role?: string; content?: string }>)]
			.reverse().find(m => m?.role === 'user')?.content ?? '';
		memoryProvider.triggerHook('session_start', {
			agentId: request.agentId, sessionId: request.sessionId || '', timestamp: Date.now(),
		}).catch(() => {});
		memoryProvider.triggerHook('prompt_submit', {
			agentId: request.agentId, sessionId: request.sessionId || '', timestamp: Date.now(),
			userMessage: userMsg.slice(0, 2000),
		}).catch(() => {});
	}

	if (memoryProvider) {
		try {
			// P7: 注入幂等去重（前置检查）——同一 session 只注入一次。
			// 已注入的 session 直接跳过后续 loadContext（此前先全量构建再丢弃，
			// 每轮白付一次混合搜索 + 策展组装的成本）。
			const sessionKey = request.sessionId || request.agentId;
			const alreadyInjected = deps.injectedSessions.has(sessionKey);
			if (alreadyInjected) {
				return { messages };
			}

			const recallQuery = [...(request.messages as Array<{ role?: string; content?: string }>)]
				.reverse().find(m => m?.role === 'user')?.content ?? '';
			const recallScope: 'agent' | 'global' = request.memoryScope ?? 'agent';
			const recallOptions = { scope: recallScope };

			// 硬超时降级：网关繁忙时注入不阻塞 turn 启动（对齐原版 hook 语义）
			const loadPromise = memoryProvider.loadContext(
				request.agentId, request.sessionId || '', recallQuery, recallOptions,
			);
			const timeoutPromise = new Promise<null>(resolve =>
				setTimeout(() => resolve(null), MEMORY_INJECT_TIMEOUT_MS));
			let memoryContext: any = null;
			try {
				memoryContext = await Promise.race([loadPromise, timeoutPromise]);
			} catch { /* 与超时同等降级 */ }
			if (memoryContext == null) {
				deps.logService.warn(`[AgentOS][MemoryInjection] loadContext timeout/error (${MEMORY_INJECT_TIMEOUT_MS}ms cap) — injecting empty context for agent ${request.agentId}`);
				memoryContext = { longTermMemories: [], shortTermMemories: [], injectedContext: '' };
			}

			// ── 按 memoryConfig.strategy 过滤 ────────────
			const strategy: 'summary' | 'full' = request.memoryStrategy === 'summary' ? 'summary' : 'full';
			const SYSTEM_DEFAULT_MAX_MEMORY_ENTRIES = 50;
			const maxEntriesSource = (typeof request.memoryMaxEntries === 'number' && request.memoryMaxEntries > 0)
				? ('agent-config' as const) : ('system-default' as const);
			const maxEntries = maxEntriesSource === 'agent-config'
				? request.memoryMaxEntries! : SYSTEM_DEFAULT_MAX_MEMORY_ENTRIES;

			deps.logService.info(
				`[AgentOS][MemoryCap] maxEntries=${maxEntries} (source=${maxEntriesSource}, ` +
				`raw=${request.memoryMaxEntries ?? 'undefined'})`
			);

			const cap = <T,>(arr: T[] | undefined): T[] => {
				if (!arr || arr.length === 0) { return []; }
				return arr.length > maxEntries ? arr.slice(-maxEntries) : arr;
			};

			const rawLongTermCount = (memoryContext.longTermMemories ?? []).length;
			const rawShortTermCount = (memoryContext.shortTermMemories ?? []).length;
			const filteredLongTerm = cap(memoryContext.longTermMemories);
			const filteredShortTerm = strategy === 'full' ? cap(memoryContext.shortTermMemories) : [];

			// ── Diagnostic ────────
			if (rawLongTermCount > 0 || rawShortTermCount > 0) {
				const ltStats = (memoryContext.longTermMemories as any[])?.slice(0, 5).map((m: any) =>
					`[${m.type ?? '?'}] id=${(m.id ?? '').slice(0, 16)} chars=${(m.content ?? '').length}`
				).join(', ') ?? '';
				const stStats = (memoryContext.shortTermMemories as any[])?.slice(0, 5).map((m: any) =>
					`[${m.type ?? '?'}] id=${(m.id ?? '').slice(0, 16)} chars=${(m.content ?? '').length}`
				).join(', ') ?? '';
				deps.logService.info(
					`[AgentOS][MemoryLoad] agent=${request.agentId} ` +
					`longTerm=${rawLongTermCount}->${filteredLongTerm.length} ` +
					`shortTerm=${rawShortTermCount}->${filteredShortTerm.length} ` +
					`maxEntries=${maxEntries}(${maxEntriesSource}) strategy=${strategy}`
				);
				if (ltStats) { deps.logService.info(`[AgentOS][MemoryLoad] longTerm samples: ${ltStats}`); }
				if (stStats) { deps.logService.info(`[AgentOS][MemoryLoad] shortTerm samples: ${stStats}`); }
			}

			// ── 注入组装对齐 agentmemory mem::context（2026-07-25 P0 修正）──
			// 原版注入只含策展块（pinned slots / project profile / lessons /
			// session summaries / 重要观察 + ≤30% 预算的 query 召回块，recency
			// 排序 + 预算填充，由引擎 buildContext 产出）；不注入原始长期/短期
			// 记忆——召回全走工具。longTermMemories/shortTermMemories 返回值
			// 仅诊断日志使用（注入路径 includeEntries=false，恒为空数组）。
			const blocks: string[] = [];

			if (memoryContext.systemPrompt && memoryContext.systemPrompt.trim().length > 0) {
				blocks.push(memoryContext.systemPrompt.trim());
			}

			// P8 Recently Touched Files 已移至 volatile 层（agentTurnExecutor）——
			// 「最近触碰」是每轮可变语义，放策展块内既污染一次性注入、又因
			// stash 每轮清空而从未生效（死代码，见 doc §12 F3）。

			// 2026-08-07：新 session 元信息模式——首条消息不注入具体记忆内容，
			// 只注入「存在记忆 + 可用工具检索」的元信息标记，防止旧结论锚定新任务。
			// 后续轮次恢复正常完整注入。planModePrefix 保留（同 session 的 plan 模式仍需）。
			const isNewSession = !deps.injectedSessions.has(sessionKey);

			if (isNewSession && blocks.length > 0) {
				// 新 session 且有记忆上下文：注入元信息而非具体内容
				const blockCount = memoryContext.contextBlocks ?? blocks.length;
				const tokens = memoryContext.contextTokens ?? Math.ceil(blocks.join('\n\n').length / 3);
				const metaInfo = [
					'<!-- NEW SESSION: Historical memory context exists but is intentionally NOT shown',
					'to avoid anchoring. The current task is NEW — do NOT assume previous conclusions apply.',
					'Use memory_search / memory_recall tools to retrieve relevant memories if needed. -->',
					'',
					`存在历史记忆上下文（约 ${blockCount} 个策展块，~${tokens} tokens）。为避免旧结论锚定新任务，`,
					'未直接展示内容。请使用 memory_search / memory_recall 工具按需检索相关记忆。',
				].join('\n');
				const result = `<agentmemory-context>\n${metaInfo}\n</agentmemory-context>`;
				let insertIdx = 0;
				for (let i = 0; i < messages.length; i++) {
					if (messages[i]?.role === 'system') { insertIdx = i + 1; }
					else { break; }
				}
				messages = insertMessages(messages, insertIdx, { role: 'system', content: result });
				deps.injectedSessions.add(sessionKey);
				deps.logService.info(
					`[AgentOS] New session — injected memory META-INFO only (${blockCount} blocks, ~${tokens} tokens, agent=${request.agentId})`
				);
				yield {
					type: 'memory_injected',
					content: '新会话：已注入记忆元信息（内容未展示，可用工具检索）',
					metadata: { strategy, newSession: true, contextBlocks: blockCount, contextTokens: tokens },
				} as any;
			} else if (blocks.length > 0) {
				// 后续轮次：正常完整注入
				// 优先用引擎返回的真实预算占用（含 header/footer），缺失时回退字符粗估
				const usedTokens = memoryContext.contextTokens ?? Math.ceil(blocks.join('\n\n').length / 3);
				// Plan 模式下为记忆上下文加前缀警告：历史结论不应阻止新规划
				// 根因：Episodic/Semantic 记忆含旧分析结论，LLM 读后认为"已完成"，
				// 拒绝重新规划。加前缀让 LLM 知道这些是历史参考，当前任务是新规划。
				const planModePrefix = request.chatMode === 'plan'
					? '<!-- PLAN MODE: The memories below are from PREVIOUS sessions. ' +
				      'They are historical context only. The current task is a NEW planning request. ' +
				      'Do NOT assume previous conclusions are still valid. ' +
				      'Do NOT skip planning because "analysis was already done". ' +
				      'You MUST decompose the current request into a fresh plan. -->\n\n'
					: '';
				const result = `<agentmemory-context>\n${planModePrefix}${blocks.join('\n\n')}\n</agentmemory-context>`;
				let insertIdx = 0;
				for (let i = 0; i < messages.length; i++) {
					if (messages[i]?.role === 'system') { insertIdx = i + 1; }
					else { break; }
				}
				messages = insertMessages(messages, insertIdx, { role: 'system', content: result });
				deps.injectedSessions.add(sessionKey);

			deps.logService.info(
				`[AgentOS] Injected agentmemory-context (strategy=${strategy}, ${result.length} chars, ` +
				`~${usedTokens} tokens, curatedBlocks=${blocks.length}, ` +
				`hasSystemPrompt=${!!memoryContext.systemPrompt}, ` +
				`planMode=${request.chatMode === 'plan'}) for agent ${request.agentId}`
			);

			// 记忆内容预览日志（前 200 字符）— 帮助定位记忆是否含误导性结论
			const previewContent = blocks.join('\n\n').slice(0, 200);
			deps.logService.info(
				`[AgentOS][MemoryInjection] Content preview (first 200 chars): ${previewContent.replace(/\n/g, '\\n')}...`
			);

			yield {
				type: 'memory_injected',
				content: `已注入记忆上下文 (~${usedTokens} tokens)`,
				metadata: {
					strategy, usedTokens, curatedBlocks: blocks.length,
					hasSystemPrompt: !!memoryContext.systemPrompt,
					contextBlocks: memoryContext.contextBlocks,
					contextTokens: memoryContext.contextTokens,
				},
			} as any;
			} else {
				deps.logService.info(
					`[AgentOS] Memory provider returned empty context for agent ${request.agentId} ` +
					`(strategy=${strategy}, Episodic/Semantic=${filteredLongTerm.length}, ` +
					`Working=${filteredShortTerm.length})`
				);
			}
		} catch (error) {
			deps.logService.error('[AgentOS] Failed to load memory context', error);
			yield { type: 'memory_injected', content: `记忆加载失败: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200), metadata: { error: true } } as any;
		}
	} else {
		deps.logService.info(`[AgentOS] No memory provider registered — skipping memory injection`);
	}

	return { messages };
}

/**
 * 全局记忆注入开关。
 *
 * 对齐 agentmemory config.ts isContextInjectionEnabled()：
 *   - AGENTMEMORY_INJECT_CONTEXT 未设置或不为 "true" → 关闭
 *   - 显式设置为 "true" → 开启
 *   - 注入关闭时 injectMemoryContext 直接返回 messages（零开销，不调 loadContext）
 *
 * 关闭场景：
 *   - 减少 LLM token 消耗（每次工具调用注入 ~3000-5000 字符）
 *   - 避免跨 agent 记忆污染
 *   - 环境变量在 .env 或 shell 中设置：Windows `set AGENTMEMORY_INJECT_CONTEXT=true`
 */
export function isMemoryInjectionEnabled(): boolean {
	try {
		return typeof process !== 'undefined'
			&& process.env?.['AGENTMEMORY_INJECT_CONTEXT'] === 'true';
	} catch {
		return false;
	}
}
