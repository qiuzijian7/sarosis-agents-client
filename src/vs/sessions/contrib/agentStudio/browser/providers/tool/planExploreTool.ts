/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * plan_explore 工具 — WorkBuddy 风格 Plan 模式的并行探索引擎。
 *
 * 设计理念（参考 WorkBuddy / OpenCode Phase 1 parallel explore）：
 *   1. 用户输入需求 → 主 LLM 分析需求，拆解探索方向
 *   2. 调用 plan_explore(areas: [...]) → 系统自动派发 N 个 Explore 子 agent 并行研究
 *   3. 每个 Explore 子 agent 独立搜索/读取文件，返回结构化发现
 *   4. 所有结果汇总后注入主 LLM 上下文 → LLM 综合生成具体 plan → exit_plan_mode
 *
 * 与 delegate_task 的区别：
 *   - delegate_task 是通用委派工具（可读写、可任意角色）
 *   - plan_explore 是 Plan 模式专用工具（强制只读 Explore 类型、自动格式化发现摘要、
 *     带 goal 上下文传递、返回结构化而非原始文本）
 */

import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IToolResultContent } from '../../../common/providers.js';
import type { IAgentOSService } from '../../../common/agentOS.js';
import type { IAgentTurnRequest, IChatStreamDelta } from '../../../common/providers.js';
import type { ITaskOrchestrationService } from '../../../../../common/agentStudioService.js';
import { UnifiedSubAgentDispatch, SubAgentType, SubAgentResult, type SubAgentEventSink } from '../../../common/unifiedSubAgentDispatch.js';
import { getBuiltinAgentIdentity } from '../../../common/builtinAgents.js';
import { IterationBudget } from '../../../common/iterationBudget.js';
import { reduceCardState, type MutableCardState } from '../../../common/subAgentCardReducer.js';

/** plan_explore 工具的单个探索区域定义 */
export interface PlanExploreArea {
	/** 探索区域标题（如 "knowledgeBase 模块架构"、"embedding 服务现状"） */
	title: string;
	/**
	 * 探索重点 — 自包含的任务描述。
	 * 子 agent 无法看到主会话对话，所以这里必须写清楚目标、已知信息、期望输出。
	 */
	focus: string;
	/**
	 * 已知相关文件/目录模式（可选）。
	 * 子 agent 会优先从这些位置开始搜索。
	 */
	files?: string[];
}

/**
 * 注册 plan_explore 工具到 BuiltinToolProvider。
 *
 * @param ctx 工具注册上下文（与 delegationTools 的 DelegationToolContext 对齐）
 */
export function registerPlanExploreTool(ctx: {
	register: (d: {
		definition: { name: string; displaySummary?: string; description: string; inputSchema: Record<string, unknown>; category?: string; source?: string };
		handler: (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => Promise<IToolResultContent[]>;
	}) => void;
	id: string;
	agentOS: IAgentOSService;
	orchestrationService: ITaskOrchestrationService;
	logService: ILogService;
	getParentWorktreePath: () => string | undefined;
}): void {

	ctx.register({
		definition: {
			name: 'plan_explore',
			displaySummary: 'Launch parallel exploration agents for multi-area research (Plan mode).',
			description: [
				'Launch PARALLEL read-only exploration sub-agents to investigate multiple areas of the codebase simultaneously.',
				'',
				'## WHY USE THIS (instead of manual grep/file_read)',
				'- Searches done via sub-agents do NOT enter your context window — saving tokens.',
				'- Up to 5 areas run simultaneously (truly parallel — much faster than sequential manual search).',
				'- Each sub-agent is a dedicated Explore agent that can use search_graph, grep, file_read,',
				'  and other read-only tools to perform deep investigation autonomously.',
				'- Results are consolidated into a structured summary for you to synthesize.',
				'',
		'## WHEN TO USE',
		'- Use this as your VERY FIRST action when you receive a user requirement in Plan mode.',
		'- For same-workspace analysis, use ONE area (one code-explorer sub-agent covers the whole codebase).',
		'- Split into multiple areas ONLY when the requirement spans different repos, services, or languages.',
		'- Each area is investigated by a dedicated Explore-type sub-agent that can search, read, and analyze.',
				'',
				'## HOW IT WORKS',
				'1. You provide `areas` (what to explore) and `goal` (why).',
				'2. The system spawns N parallel Explore sub-agents — each runs independently.',
				'3. Each sub-agent searches code, reads files, and produces a structured finding report.',
				'4. ALL results are returned to you as a consolidated summary.',
				'5. You then synthesize these findings into a concrete task plan via `plan_exit`.',
				'',
				'## EXAMPLE',
				'```\nplan_explore({',
				'  goal: "Design a local knowledge base solution with Hyper-Extract + bge-m3 embedding",',
				'  areas: [',
				'    { title: "KB Architecture", focus: "Explore the existing knowledgeBase module architecture. How are KBs stored? What interfaces exist? Find all files related to knowledge base." },',
				'    { title: "Embedding Pipeline", focus: "Investigate how embeddings are currently generated and stored. Look for any embedding service, vector store, or similarity search code." },',
				'    { title: "Hyper-Extract Integration", focus: "Search for any existing Hyper-Extract usage or extraction pipeline. How does data extraction work currently?" },',
				'  ]',
				'})\n```',
				'',
				'## OUTPUT',
				'Returns a structured summary of findings from all exploration areas:',
				'- Key files found per area',
				'- Architecture observations',
				'- Relevant code patterns',
				'- Potential risks or dependencies',
				'',
				'Use these findings to build your plan. Do NOT re-explore what the sub-agents already covered.',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					goal: {
						type: 'string',
						description: 'The overall user requirement/goal that ties all explorations together. This context is shared with every sub-agent so they understand the big picture.',
					},
					areas: {
						type: 'array',
						description: 'Exploration areas to investigate IN PARALLEL. Each area spawns its own dedicated Explore-type sub-agent. Default to 1 area for same-workspace codebase analysis; split into multiple ONLY when truly independent (different repos/services/languages). HARD MAX 5 (extra areas are dropped). Areas must be MUTUALLY INDEPENDENT (no sequential dependency).',
						items: {
							type: 'object',
							properties: {
								title: {
									type: 'string',
									description: 'Short title for this exploration area (e.g., "Auth Module", "DB Schema", "API Layer"). Displayed in the UI.',
								},
								focus: {
									type: 'string',
									description: 'SELF-CONTAINED investigation briefing. The sub-agent CANNOT see this conversation. Include: what to find, where to look, what to report back. Be specific about file patterns, function names, or module paths if known.',
								},
								files: {
									type: 'array',
									items: { type: 'string' },
									description: 'Known relevant file glob patterns or paths. The sub-agent will prioritize these locations first. Optional but helps focus the search.',
								},
							},
							required: ['title', 'focus'],
						},
					},
				},
				required: ['goal', 'areas'],
			},
			category: 'planning',
			source: ctx.id,
		},

		handler: async (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string): Promise<IToolResultContent[]> => {
			const goal = (args['goal'] as string) || '';
			const rawAreas = (args['areas'] as Array<Record<string, unknown>>) || [];

			if (!goal) {
				return [{ type: 'text', text: JSON.stringify({ success: false, error: 'plan_explore: "goal" is required — describe the overall user requirement.' }) }];
			}
			if (rawAreas.length === 0) {
				return [{ type: 'text', text: JSON.stringify({ success: false, error: 'plan_explore: "areas" array must have at least one exploration area.' }) }];
			}
			// 策略：统一产出 Explore 类型子 agent，但支持多个探索区域（1-5 个）。
			// 每个 area 派发一个独立的 Explore sub-agent 并行执行。上限 5 个，超出部分截断。
			const MAX_AREAS = 5;
			if (rawAreas.length > MAX_AREAS) {
				ctx.logService.info(`[AgentOS][plan_explore] ${rawAreas.length} areas requested → capping to ${MAX_AREAS} (max parallel Explore agents).`);
			}
			const cappedAreas = rawAreas.slice(0, MAX_AREAS);

			const areas: PlanExploreArea[] = cappedAreas.map((a, i) => ({
				title: (a['title'] as string) || `Area ${i + 1}`,
				focus: (a['focus'] as string) || '(no focus specified)',
				files: (a['files'] as string[]) || [],
			}));

			ctx.logService.info(`[AgentOS][plan_explore] Launching ${areas.length} parallel exploration areas for goal: "${goal.slice(0, 80)}"`);

			try {
				// 获取 subAgentDispatch 实例
			const dispatch = ctx.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch | undefined;
			if (!dispatch) {
				return [{ type: 'text', text: JSON.stringify({
					success: false,
					error: 'plan_explore: orchestration service or subAgentDispatch not available. Fall back to manual research with grep/file_read tools.',
				}) }];
			}

			// 注入 logger 用于子 agent 流式诊断（heartbeat / DELTA GAP / handover / tool_end）—— plan 模式也需要
			(dispatch as any).setLogger?.((lvl: string, msg: string) => (ctx.logService as any)[lvl]?.(msg) ?? ctx.logService.info(msg));

				// 构建 shared context（goal + 全局背景）
				const sharedContext = [
					`# EXPLORATION GOAL`,
					`${goal}`,
					``,
					`# YOUR MISSION`,
					`You are a read-only exploration agent. Investigate your assigned area thoroughly using search_graph (primary), grep (fallback), file_read, and other read-only tools.`,
					``,
					`# REPORT FORMAT`,
					`When done, provide a concise finding report covering:`,
					`1. Key files/patterns found`,
					`2. Architecture observations`,
					`3. Relevant code snippets (brief)`,
					`4. Risks, gaps, or assumptions`,
				].join('\n');

				// 每个 area 派发一个独立的 Explore sub-agent（类型统一为 Explore），并行执行。
				const tasks = areas.map(a => {
					const fileHint = a.files?.length ? `\n\nPRIORITY FILES/PATTERNS TO CHECK FIRST:\n${a.files.map(f => `- ${f}`).join('\n')}` : '';
					return `[${a.title}] ${a.focus}${fileHint}`;
				});

				// 构建执行函数
				const executeFn = (request: IAgentTurnRequest, _budget: IterationBudget): AsyncIterable<IChatStreamDelta> => {
					return ctx.agentOS.executeAgentTurn(request);
				};

				const worktreePath = ctx.getParentWorktreePath();

				// ─── P0/P1: 流式执行过程旁路总线 ───────────────────────────────
				// 维护每个子 agent 的全量卡片快照（cardMap），事件驱动更新，节流 fire。
				// UI 按 id upsert。流式与最终态共用 dispatch 内部 subAgentId，天然去重。
				const parentToolCallId = `plan_explore_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				type MutableCard = {
					id: string;
					type: 'explore';
					task: string;
					status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
					progress?: string;
					output?: string;
					streamingOutput?: string;
					error?: string;
				groupId?: string;
				areaIndex: number;
				toolTraces: Array<{ id: string; name: string; status: 'running' | 'done' | 'error'; args?: string; result?: string }>;
				startedAt?: number;
				completedAt?: number;
			};
				const cardMap = new Map<string, MutableCard>();
				let batchGroupId: string | undefined;
				let flushTimer: ReturnType<typeof setTimeout> | undefined;

				// 精确全等匹配：ev.task 全等于创建 sub-agent 时传入的 tasks[i]
				// （unifiedSubAgentDispatch 的 SubAgentEvent.task 原样取自 subAgent.task），
				// 故 tasks.indexOf 即 area 索引。避免用 startsWith 标题前缀匹配导致
				// 相似/重复标题（如 "Auth" vs "Auth Module"）串位。
				const areaIndexOf = (task: string): number =>
					tasks.indexOf(task);

				const flushNow = () => {
					if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
					try {
						ctx.agentOS.fireSubAgentTrace({
							groupId: batchGroupId,
							subagentData: [...cardMap.values()].map(c => ({
								id: c.id, type: c.type, task: c.task, status: c.status,
								progress: c.progress, output: c.output, streamingOutput: c.streamingOutput, error: c.error, groupId: c.groupId,
								toolTraces: c.toolTraces.map(t => ({ ...t })),
								parentToolCallId,
								startedAt: c.startedAt, completedAt: c.completedAt,
							})),
						});
					} catch { /* sink errors are swallowed by design */ }
				};
				const scheduleFlush = () => {
					// R3: 时间窗合并高频事件，限制 UI 重渲染频率（~100ms）。
					if (flushTimer) { return; }
					flushTimer = setTimeout(() => { flushTimer = undefined; flushNow(); }, 100);
				};

				const inlineTraceSink: SubAgentEventSink = (ev) => {
					if (ev.groupId && !batchGroupId) { batchGroupId = ev.groupId; }
					let card = cardMap.get(ev.subAgentId);
					if (!card) {
						const idx = areaIndexOf(ev.task);
						card = {
							id: ev.subAgentId, type: 'explore',
							task: idx >= 0 ? areas[idx].title : ev.task,
							status: 'running', groupId: ev.groupId, areaIndex: idx, toolTraces: [],
							startedAt: Date.now(),
						};
						cardMap.set(ev.subAgentId, card);
					}
					reduceCardState(card as MutableCardState, ev);
					scheduleFlush();
				};

				// 执行并行探索
				// agentId 驱动（2026-07-27）：每个探索子代理都以内置 code-explorer Agent
				// 身份实例化（真实 systemPrompt / tools），替代通用 Explore 折中提示词。
				const exploreIdentity = getBuiltinAgentIdentity('code-explorer') ?? {};
				const results: SubAgentResult[] = await dispatch.dispatchParallelExplore(
					agentId ?? 'unknown',
					tasks,
					executeFn,
					sharedContext,
					tasks.map(() => ({
						type: SubAgentType.Explore,
						priority: 'high' as const,
						parentWorkMode: 'plan', // exploration always inherits the read-only work phase
						...exploreIdentity,
						...(worktreePath ? { worktreePath } : {}),
					})),
					inlineTraceSink, // P0/P1: 旁路总线流式驱动聊天框卡片（不碰底部面板）
					signal,          // P3: 取消传播
					// P0: 并发上限设为 area 数（≤MAX_AREAS=5），让所有探索区域真正同时并行，
					// 不被全局默认 maxConcurrent=3 限流成分批串行。
					tasks.length,
				);

				// R5 兜底：立即 flush 最终快照，确保终态（含收敛后的 trace）送达 UI。
				flushNow();

				// 立即清理已完成的子 agent，防止底部 Agent Chat 面板出现多余 tab/卡片。
				// 用户只需在聊天框中看到 plan_explore 工具卡片即可。
				try { dispatch.cleanup(); } catch { /* best-effort */ }

				// 格式化汇总结果
				const summaryLines: string[] = [];
				summaryLines.push(`# Parallel Exploration Results (${results.length} areas)\n`);

				const successCount = results.filter(r => r.success).length;
				const failCount = results.length - successCount;

				// Hermes 批次摘要预算（2026-07-23）：整批摘要总量设上限，按成功数均分，
				// 防"N 个子代理各塞 3K 字符撑爆父级上下文"（Hermes issue #9126 死亡螺旋）。
				// 每区预算 = max(下限, 总量上限/成功数)；区少时每区更宽松，区多时收紧。
				const BATCH_SUMMARY_TOTAL_CAP = 24000;
				const PER_AREA_SUMMARY_FLOOR = 2000;
				const perAreaCap = Math.max(PER_AREA_SUMMARY_FLOOR, Math.floor(BATCH_SUMMARY_TOTAL_CAP / Math.max(1, successCount)));

				for (let i = 0; i < results.length; i++) {
					// 每个 result 对应一个 area，按索引取对应标题。
					const areaTitle = areas[i]?.title ?? `Area ${i + 1}`;
					const result = results[i];
					const statusIcon = result.success ? '✓' : '✗';

					summaryLines.push(`## ${statusIcon} ${areaTitle}`);
					summaryLines.push('');

					if (result.success) {
						// 截断过长的输出
						const output = result.output || '(no output)';
						if (output.length > perAreaCap) {
							summaryLines.push(output.slice(0, perAreaCap));
							summaryLines.push(`\n... [truncated, full output ${output.length} chars]`);
						} else {
							summaryLines.push(output);
						}
					} else {
						summaryLines.push(`**Failed:** ${result.error || 'unknown error'}`);
					}

					// Token 用量统计
					if ((result as any).tokenUsage) {
						const tu = (result as any).tokenUsage as { inputTokens?: number; outputTokens?: number };
						summaryLines.push(`\n*Tokens: input=${tu.inputTokens ?? '?'}, output=${tu.outputTokens ?? '?'}*`);
					}

					summaryLines.push('');
				}

				summaryLines.push('---');
				summaryLines.push(`Summary: ${successCount}/${results.length} areas explored successfully${failCount > 0 ? `, ${failCount} failed` : ''}.`);
				summaryLines.push('');
				summaryLines.push('**Next step:** Synthesize these findings into a concrete task plan, then call `plan_exit`.');

				ctx.logService.info(`[AgentOS][plan_explore] Completed: ${successCount}/${results.length} areas successful`);

				// Build ISubAgentData[] for chat panel rendering (SubAgentCards)
				// P0/P1: 复用流式 cardMap 的 subAgentId，subagent_batch 兜底按 id upsert 不会重复建卡。
				const subagentData = results.map((result, i) => {
					const card = [...cardMap.values()].find(c => c.areaIndex === i);
					// 优先用流式积累的 trace（与 UI 已渲染一致）；否则回退到 result.toolTrace 汇总。
					let toolTraces = card?.toolTraces.map(t => ({ ...t }));
					if (!toolTraces || toolTraces.length === 0) {
						const rawTrace: any[] = (result as any).toolTrace || [];
						toolTraces = rawTrace.map((t: any, ti: number) => ({
							id: `${card?.id || `area${i}`}-t${ti}`,
							name: t.toolName || 'unknown',
							status: t.status === 'error' ? 'error' as const : 'done' as const,
							args: t.argsSizeBytes ? `${t.argsSizeBytes}B args` : undefined,
							result: t.error || (t.resultSizeBytes ? `${t.resultSizeBytes}B result` : undefined),
						}));
					}
					const toolSummary = toolTraces.length > 0
						? `Tools: ${toolTraces.map((t: any) => t.name).slice(0, 8).join(', ')}`
						: 'No tools used';
					return {
						id: card?.id || `plan-explore-${Date.now()}-${i}`,
						type: 'explore' as const,
						task: areas[i]?.title || `Area ${i + 1}`,
						status: result.success ? 'done' as const : 'error' as const,
						output: result.success ? (result.output || '(no output)').slice(0, 2000) : (result.error || 'unknown error'),
						progress: toolSummary,
						groupId: card?.groupId || `plan-explore-batch`,
						parentToolCallId,
						toolTraces,
					};
				});

				return [{ type: 'text', text: JSON.stringify({
					success: true,
					goal,
					areaCount: areas.length,
					successCount,
					failCount,
					findings: summaryLines.join('\n'),
					subagentData,  // ← ISubAgentData[] for UI rendering
				}) }];

			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logService.error(`[AgentOS][plan_explore] Error: ${msg}`);
				return [{ type: 'text', text: JSON.stringify({
					success: false,
					error: `plan_explore execution error: ${msg}`,
				}) }];
			}
		},
	});

	ctx.logService.info('[BuiltinTools] registerPlanExploreTool: plan_explore registered');
}
