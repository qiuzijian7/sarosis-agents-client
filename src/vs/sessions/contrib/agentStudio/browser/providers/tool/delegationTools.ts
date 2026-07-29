/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IAgentOSService } from '../../../common/agentOS.js';
import type { ITaskOrchestrationService } from '../../../../../common/agentStudioService.js';
import type { IAgentStudioService } from '../../../../../common/agentStudioService.js';
import { ToolSecurityLevel } from '../../../common/providers.js';
import type { IToolResultContent, IModelSelection, IAgentTurnRequest, IChatStreamDelta } from '../../../common/providers.js';
import { SubAgentResult, UnifiedSubAgentDispatch, SUB_AGENT_TYPE_LABELS, SubAgentType, SubAgentIsolationLevel, resolveIsolationLevel, type SubAgentEventSink, type SubAgentOptions } from '../../../common/unifiedSubAgentDispatch.js';
import { IterationBudget } from '../../../common/iterationBudget.js';
import { reduceCardState, type MutableCardState } from '../../../common/subAgentCardReducer.js';
import type { Agent } from '../../../../../common/agentStudioTypes.js';
import { getBuiltinAgentIdentity } from '../../../common/builtinAgents.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';
import type { ICodebaseGraphService } from '../../codebaseGraphService.js';
import type { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';

export interface DelegationToolContext {
	register: (d: IBuiltinToolRegistration) => void;
	id: string;
	agentOS: IAgentOSService;
	orchestrationService: ITaskOrchestrationService;
	getParentWorktreePath: () => string | undefined;
	studioService: IAgentStudioService;
	logService: ILogService;
	/**
	 * A：索引就绪前置 — 委派 explore 子代理前由代码层检查/构建代码图，
	 * 而非把 index_repository 暴露给 LLM 让其自行决定（LLM 会把"索引已启动"
	 * 误判为任务完成，导致"只索引即停"的空洞输出）。
	 */
	codebaseGraphService?: ICodebaseGraphService;
	workspaceService?: IWorkspaceContextService;
}



// ─── new_agent 工具 — 独立导出函数，便于 TDD 测试 ────────────────────────────

// ─── new_agent 工具 — 独立导出函数，便于 TDD 测试 ────────────────────────────

/**
 * 将 agent 名称转换为 URL 友好的 slug 格式。
 *
 * 规则：
 *   - 小写字母、数字、连字符
 *   - 空格/下划线 → 连字符
 *   - 移除其他特殊字符
 *   - 去除首尾连字符
 *   - 最多 40 字符
 *
 * 示例：
 *   "Code Reviewer"   → "code-reviewer"
 *   "My Coding Agent"  → "my-coding-agent"
 *   "UI/UX Designer"   → "uiux-designer"
 *
 * 导出为独立函数以便单元测试。
 */
/**
 * 从 SubAgentResult.toolTrace 提取 UI 工具痕迹列表。
 *
 * 内部 toolTrace 格式：
 *   { toolName, status: 'ok' | 'error', argsSizeBytes?, resultSizeBytes?, error? }
 *
 * 提取为 ISubAgentTraceEntry 列表供 SubAgentCard 渲染。
 * 导出为独立函数以便单测（避免实例化完整的 registerDelegationTools ctx）。
 */
export function extractToolTracesFromResult(result: SubAgentResult): Array<{
	id: string; name: string; status: 'done' | 'error'; args?: string; result?: string;
}> {
	const rawTrace: any[] = (result as any).toolTrace || [];
	return rawTrace.map((t: any, ti: number) => ({
		id: `t${ti}`,
		name: t.toolName || 'unknown',
		status: (t.status === 'error' ? 'error' : 'done') as 'done' | 'error',
		args: t.argsSizeBytes ? `${t.argsSizeBytes}B args` : undefined,
		result: typeof t.error === 'string' ? t.error
			: t.resultSizeBytes ? `${t.resultSizeBytes}B result`
				: undefined,
	}));
}

/**
 * 终态快照的 toolTraces 解析：优先用流式积累的 card.toolTraces（含 args/result
 * 预览，与 UI 流式期渲染一致）；为空时回退到 result.toolTrace 汇总（仅 size 摘要）。
 *
 * 若只用提取结果，一旦 result.toolTrace 为空，终态快照会以 last-write-wins 覆盖掉
 * 流式期累积的丰富 traces，卡片只剩 output 文本。与 planExploreTool 的策略对齐。
 * 导出为独立函数以便单测。
 */
export function resolveFinalToolTraces(
	card: Pick<MutableCardState, 'toolTraces'> | undefined,
	result: SubAgentResult,
	saId: string,
): Array<{ id: string; name: string; status: 'running' | 'done' | 'error'; args?: string; result?: string }> {
	if (card && card.toolTraces.length > 0) {
		return card.toolTraces.map(t => ({ ...t }));
	}
	return extractToolTracesFromResult(result).map(t => ({ ...t, id: `${saId}-${t.id}` }));
}

/**
 * 剥离 dispatch 追加给父 agent 的 `[COMPLETION GATE] status=… — …` 页脚。
 * 该页脚是父 agent 的可靠性契约，不应作为噪音显示在子代理卡片的 output 区。
 */
export function stripCompletionGateFooter(output: string): string {
	return output.replace(/\s*\[COMPLETION GATE\][^\n]*/g, '').trimEnd();
}

export function slugifyAgentName(name: string): string {
	let slug = name
		.toLowerCase()
		.trim()
		// 先将非 ASCII 空格类字符（全角空格、中文逗号等）替换为半角
		.replace(/[\u3000\u2000-\u200F\u2028-\u202F\u205F\u00A0]/g, ' ')
		.replace(/[^a-z0-9\s_-]/g, '')   // 移除特殊字符（含中文）
		.replace(/[\s_]+/g, '-')          // 空格/下划线 → 连字符
		.replace(/-+/g, '-')              // 去重连字符
		.replace(/^-|-$/g, '')            // 去首尾连字符
		.slice(0, 40);                    // 限制长度

	// 纯中文/Unicode 名称导致 slug 为空时，使用时间戳生成可用的 id
	if (!slug) {
		slug = `agent-${Date.now().toString(36)}`;
	}
	return slug;
}

/**
 * handleNewAgentTool — 创建持久化 Agent 定义。
 *
 * 与 delegate_task 的区别：
 *   - delegate_task 创建一次性子代理，执行完即销毁
 *   - new_agent 创建持久化 Agent，保存到 ~/.saros/agents/{id}/，可被后续复用
 *
 * Agent 命名规则：
 *   - 名称自动转为 slug 格式（小写、连字符分隔，如 "Code Reviewer" → "code-reviewer"）
 *   - id 与 slug 名称一致，无随机后缀（确保可读性和可预测性）
 *
 * 导出为独立函数以便单元测试（避免实例化整个 BuiltinToolProvider）。
 *
 * @param args LLM 传入的工具参数
 * @param studioService Agent Studio 服务（提供 createAgent）
 * @returns IToolResultContent[] — JSON 格式的创建结果
 */
export async function handleNewAgentTool(
	args: Record<string, unknown>,
	studioService: Pick<IAgentStudioService, 'createAgent'>,
): Promise<IToolResultContent[]> {
	const rawName = args['name'] as string | undefined;
	const role = args['role'] as string | undefined;
	const description = args['description'] as string | undefined;

	// 1. 验证必填字段
	const missing: string[] = [];
	if (!rawName?.trim()) { missing.push('name'); }
	if (!role?.trim()) { missing.push('role'); }
	if (!description?.trim()) { missing.push('description'); }
	if (missing.length > 0) {
		return [{
			type: 'text', text: JSON.stringify({
				success: false,
				error: `Missing required parameter(s): ${missing.join(', ')}`,
			})
		}];
	}

	// 2. Slug 化名称并对齐 _generateId 的 slug 逻辑（但去掉随机后缀）
	const slugName = slugifyAgentName(rawName!);
	const displayName = rawName!.trim();

	// 3. 构建 Partial<Agent> — displayName 保留用户原始输入，id 使用 slug
	const trimmedRole = role!.trim();
	const trimmedDesc = description!.trim();
	const agentData: Partial<Agent> = {
		id: slugName,
		name: displayName,
		role: trimmedRole,
		description: trimmedDesc,
		source: 'custom',
	};
	// systemPrompt: 用户提供则使用，否则基于 role + description 自动生成
	agentData.systemPrompt = args['systemPrompt']
		? (args['systemPrompt'] as string)
		: `You are a ${trimmedRole}. ${trimmedDesc}`;
	if (args['model']) { agentData.model = args['model'] as string; }
	if (args['tools']) { agentData.tools = args['tools'] as string[]; }
	if (args['skills']) { agentData.skills = args['skills'] as string[]; }
	if (args['category']) { agentData.category = args['category'] as string; }

	// 4. 调用 studioService.createAgent
	try {
		const agent = await studioService.createAgent(agentData);
		return [{
			type: 'text', text: JSON.stringify({
				success: true,
				id: agent.id,
				name: agent.name,
				role: agent.role,
				description: agent.description,
				category: agent.category,
				systemPrompt: agent.systemPrompt || '(auto-generated)',
				message: `Agent "${agent.name}" created successfully. Use delegate_task to assign tasks to it.`,
			})
		}];
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return [{
			type: 'text', text: JSON.stringify({
				success: false,
				error: `Failed to create agent: ${msg}`,
			})
		}];
	}
}

/**
 * _registerDelegationTools — 从 builtinToolProvider 抽取（source 硬编码 'saros.builtin-tools'）。
 */

/**
 * P2d（2026-07-28）：partial（salvaged）委派结果的后续行动指引。
 * 此前主 agent 常把 partial 当 success 直接综合（日志 1785231958842：3 个并行
 * 子代理全 partial，主 agent 未察觉「没全做完」就继续向下执行）。此指引要求
 * 主 agent 显式处理缺口——要么收窄再派一次，要么明确告知用户哪些未验证。
 * 纯文本常量（数据驱动，无场景特化），导出以便单测。
 */
export function partialDelegationAdvisory(): string {
	return (
		'[delegation-advisory] The above sub-agent result is PARTIAL (cut short by budget/timeout) — it is INCOMPLETE, not final. ' +
		'Do NOT treat it as a finished answer. Before drawing conclusions from it: either (a) re-dispatch a NARROWER follow-up sub-agent ' +
		'to fetch the missing part, or (b) explicitly tell the user which aspects remain unverified.'
	);
}

/**
 * P2c 末步强制收尾：将委派结果格式化为带「角色 + exitReason」的结构化收尾，
 * 让父 agent（LLM）始终收到一致的终态信号（success/failed + 终止原因），
 * 而非裸文本。子 agent 的 exitReason 由 unifiedSubAgentDispatch 在各退出路径
 * 统一设置（completed / timeout / max_iterations / interrupted — 见 P3 父→子取消传播）。
 */
function formatDelegationResult(
	role: (typeof SUB_AGENT_TYPE_LABELS)[number]['value'],
	result: SubAgentResult,
	index: number | undefined,
	isolation: SubAgentIsolationLevel,
): string {
	const tag = index !== undefined ? `Task ${index}` : 'delegate_task';
	const roleLabel = SUB_AGENT_TYPE_LABELS.find((t) => t.value === role)?.label ?? String(role);
	const iso = `isolation=${isolation}`;
	if (result.success) {
		// P2（2026-07-26，对齐 MiMo reportedStatus）：salvage 部分完成显式化——
		// success=true 但 exitReason≠completed（timeout/max_iterations 打捞）时
		// RESULT 行直接标 partial，主 agent 不解析正文即可感知「没全做完」。
		const exitReason = result.exitReason ?? 'completed';
		if (exitReason !== 'completed') {
			const okTools = result.toolTrace?.filter(t => t.status === 'ok').length ?? 0;
			// P2d：partial 结果附行动指引，防主 agent 把不完整结果当完成直接综合。
			return `[${tag}] RESULT: partial (role=${roleLabel}, ${iso}, exitReason=${exitReason}, salvaged=${okTools} tools)\n${result.output ?? '(no output)'}\n\n${partialDelegationAdvisory()}`;
		}
		return `[${tag}] RESULT: success (role=${roleLabel}, ${iso}, exitReason=${exitReason})\n${result.output ?? '(no output)'}`;
	}
	const reason = result.exitReason ?? 'failed';
	return `[${tag}] RESULT: failed (role=${roleLabel}, ${iso}, exitReason=${reason})\n${result.error ?? 'unknown error'}`;
}

/**
 * 将 delegate_task 的 task/tasks 入参归一化为字符串。
 *
 * 模型（尤其推理模型）有时会把 `tasks` 传成对象数组（如
 * `[{ role, task, type }]`），而 schema 声明的是 `array of string`。
 * coerceOrReject 只校验顶层字段、不校验数组元素类型，对象元素会原样
 * 透传进 createSubAgent → subAgent.task 变成对象 → 后续
 * extractAcceptanceCriteria(subAgent.task).search(...) 直接崩溃，子 agent 被判 failed。
 *
 * 故在派发边界做一次归一化：对象优先取 task/description/content/goal/brief
 * 等可读字段，否则退回 JSON 字符串，保证 sub-agent 收到的 briefing 始终是字符串。
 */
export function normalizeTaskArg(x: unknown): string {
	if (typeof x === 'string') { return x; }
	if (x === null || x === undefined) { return ''; }
	if (Array.isArray(x)) { return x.map(normalizeTaskArg).join('\n\n'); }
	if (typeof x === 'object') {
		const o = x as Record<string, unknown>;
		const cand = o['task'] ?? o['description'] ?? o['content'] ?? o['goal']
			?? o['brief'] ?? o['prompt'] ?? o['instruction'];
		if (cand !== undefined) { return normalizeTaskArg(cand); }
		try { return JSON.stringify(x); } catch { return String(x); }
	}
	return String(x);
}

/**
 * A：索引管理工具 — 只读探索型子代理不应可见。
 *
 * 架构根因（日志 1784891684376）：explore 子代理把 `index_repository` 的"索引已启动"
 * 确认信息误判为任务完成信号，调一次即 `finishReason=stop`，输出空洞占位文本
 * （"I'll start..."）。治本方案不是提示词约束，而是：
 *   1. 由代码层在 dispatch 前预建代码图（_ensureGraphReadyForExplore），
 *      index_repository 不再交给 LLM 决策；
 *   2. 把这些索引管理工具从子代理的可见工具面中移除（excludedTools），
 *      杜绝 LLM 误调用。
 *
 * 保留 index_status / check_index_coverage / list_projects（只读、无害，可让
 * 子代理确认图是否就绪），只移除会触发/变更索引的工具。
 *
 * terminal（2026-07-27 日志「新文件56.txt」）：explore 子代理不信任内置 search，
 * 转而用 terminal 手动 `grep -rn` / `Select-String -Recurse` / `Get-ChildItem` /
 * 写 python 脚本探索——单次任务 terminal 64 次/193s（是 search_code 9s 的 21 倍），
 * 且引发路径臆测读空文件、写脚本到工作区外被沙箱拦。内置 search_code(ripgrep, ~176ms)
 * 已足够快。探索型子代理定位是「只读检索」，命令执行属副作用面，一并隐藏——
 * 强制其走 search_code/search_files/search_graph，杜绝手搜绕路。
 */
const EXPLORE_EXCLUDED_TOOLS: readonly string[] = [
	'index_repository',
	'delete_project',
	'manage_adr',
	'export_artifact',
	'ingest_traces',
	'detect_changes',
	// 命令执行——探索型子代理不应用 terminal 手动 grep/写脚本搜代码（见上方注释）
	'terminal',
	// M4（2026-07-26 §16）：只读探索型子代理禁写记忆——memory_remember 滥用
	// 曾致单任务 93 次写入；记忆写入由主代理/长期型 agent 负责。
	'memory_remember',
];

/**
 * A：索引就绪前置 — 委派 code-explorer 子代理前由代码层确保代码图已加载。
 *
 * 复用 codebaseTools.index_repository 的等价逻辑（跳过已加载、多目录循环、
 * fast 模式、失败不阻塞 dispatch），但直接走 ICodebaseGraphService 而非 LLM 工具调用。
 * 返回是否就绪（true=图已可用；false=服务未注入或索引失败，仍允许 dispatch，
 * 由子代理的 search_graph 等工具在运行时返回 "no graph loaded" 报错，不影响其他流程）。
 */
async function _ensureGraphReadyForExplore(ctx: DelegationToolContext): Promise<boolean> {
	const graph = ctx.codebaseGraphService;
	const workspace = ctx.workspaceService;
	if (!graph || !workspace) {
		ctx.logService.warn('[delegate_task] codebaseGraphService/workspaceService not injected — skip graph preflight (sub-agent may see "no graph loaded")');
		return false;
	}
	try {
		// 竞态守卫：启动时 bootstrap 的 loadGraphMerge 可能仍在加载大图谱，
		// 期间误判"无图"会对全部 folder 触发全量重建（曾致每次会话必重建）
		await graph.whenGraphLoaded();
		if (graph.hasGraphData()) { return true; }
		// 尝试从 SQLite 磁盘回载（Phase 2f 后端启用时免重建）
		if (await graph.tryLoadFromSqlite()) { return true; }

		const folders = workspace.getWorkspace().folders;
		if (folders.length === 0) { return false; }
		ctx.logService.info(`[delegate_task] graph preflight: building index for ${folders.length} folder(s) before dispatching code-explorer sub-agent...`);
		for (const f of folders) {
			// 逐 folder 守卫：已有数据的 folder 跳过，避免多 folder 工作区每次全量重建
			if (graph.hasProjectData(f.uri.fsPath)) { continue; }
			const result = await graph.indexWorkspace(f.uri.fsPath, { mode: 'fast', excludeDirs: [] });
			ctx.logService.info(`[delegate_task] graph preflight ${f.uri.fsPath}: ${result.success ? 'OK' : 'FAILED'} — ${result.message}`);
		}
		return graph.hasGraphData();
	} catch (err) {
		ctx.logService.warn(`[delegate_task] graph preflight error (continuing dispatch): ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

export function registerDelegationTools(ctx: DelegationToolContext): void {
	// Hermes 动态描述（2026-07-23）：把运行时真实上限注入工具描述 —— 防止模型
	// 按"想当然的默认值"自我设限（Hermes _build_top_level_description 每次
	// schema 重建时写入真实配置值的做法）。注册时从 dispatch 配置读取一次
	// （dispatch 配置在工作区级稳定；修改配置后 provider 重新注册生效）。
	let maxConcurrent = 3;
	let maxSpawnDepth = 1;
	try {
		const cfg = (ctx.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch).getConfig();
		maxConcurrent = cfg.maxConcurrent;
		maxSpawnDepth = cfg.maxSpawnDepth;
	} catch { /* dispatch 未就绪时使用默认值 */ }

	/** delegate_task 单次调用允许的子代理数硬上限（防止过度创建）。 */
	const MAX_TASKS_PER_CALL = 5;

	// delegate_task — LLM 自主委派任务给子代理（单次调用 1-5 个子代理）
	ctx.register({
		definition: {
			name: 'delegate_task',
			displaySummary: 'Delegate a task to a sub-agent.',
			description:
				'Launch a sub-agent to do FOCUSED RETRIEVAL work: search the codebase, locate files/symbols, ' +
				'read specific files, and return the raw materials it found. Each call spawns ONE sub-agent ' +
				'in an isolated context.\n' +
				'\n\n' +
				'**WHY USE THIS (instead of doing it yourself)**\n' +
				'- Retrieval results come back ONCE as a compact summary — not as dozens of raw search/read outputs filling your own context window.\n' +
				'- The sub-agent burns its own budget on slow parts (large-repo searches can take 20s+ each), keeping your context and time for reasoning.\n' +
				'\n\n' +
				'**WHAT TO DELEGATE — retrieval only**\n' +
				'- Questions answerable by search + read: "find where X is implemented", "locate all callers of Y", "read files A,B,C and extract the Z logic".\n' +
				'- The sub-agent collects MATERIALS (file paths, symbol names, code snippets with line numbers) — YOU do the analysis and synthesis on its return.\n' +
				'\n\n' +
				'**WHAT NOT TO DELEGATE — open-ended analysis**\n' +
				'- Do NOT delegate a whole investigation like "analyze the X mechanism" or "write a report on Y". Open-ended tasks make the sub-agent iterate 50+ turns of searching/reading and risk hitting its 10-minute timeout with NOTHING returned.\n' +
				'- Instead: decompose the investigation into concrete retrieval questions, delegate them one at a time (or in parallel), then synthesize the answers yourself.\n' +
				'\n\n' +
				'**TASK BRIEFING (CRITICAL: the sub-agent starts BLANK — it cannot see this conversation)**\n' +
				'- GOAL: what specific information/materials to find (NOT what conclusion to draw).\n' +
				'- KNOWN: facts you already established and dead-ends to skip.\n' +
				'- SCOPE: constrain the search area when possible (project name, directory, file pattern) — unconstrained repo-wide searches are slow (20s+ each).\n' +
				'- OUTPUT: a compact structured list of findings (paths / symbols / snippets with line numbers), NOT a long-form analysis. Tell it to return what it has even if incomplete — partial materials are useful, a timeout is not.\n' +
				'- SIZE: aim for ≤15 tool calls per sub-agent.\n' +
				'\n\n' +
				'**PARALLEL** (rare — only truly independent retrieval questions)\n' +
				'- Issue multiple delegate_task calls in one message, each with a single question.\n' +
				'- Do NOT split aspects of the same question across sub-agents.\n' +
				'\n\n' +
				'**WHEN NOT TO USE**\n' +
				'- Trivial single-file lookup, or the answer is already in your context\n' +
				'- Simple enough to finish in one turn with your own tools\n' +
				'- You must keep continuous context across sequential steps (do it yourself)\n' +
				'- You are already at maximum spawn depth\n' +
				'\n\n' +
				`**LIMITS: max ${maxConcurrent} concurrent sub-agents overall; max spawn depth ${maxSpawnDepth} (sub-agents CANNOT spawn their own sub-agents).**\n`,
			inputSchema: {
				type: 'object',
				properties: {
					task: { type: 'string', description: 'Retrieval task to delegate (spawns ONE sub-agent). Self-contained briefing — the sub-agent cannot see this conversation. Retrieval only: search/locate/read and return materials (paths, symbols, snippets with line numbers); do NOT delegate open-ended analysis ("analyze X", "write a report on Y") — it will iterate 50+ turns and may time out with nothing returned. Aim for ≤15 tool calls; tell it to return partial findings rather than run dry.' },
					type: {
						type: 'string',
						enum: ['code-explorer', 'researcher', 'data'],
						description: 'Which read-only agent to delegate to. MUST be one of the 3 registered read-only agents: "code-explorer" (codebase search/read), "researcher" (web research), "data" (data analysis). DO NOT create or invent new agent names.',
					},
					context: {
						type: 'string',
						description: 'Optional background context to inject into the sub-agent (e.g. a summary of prior steps, ' +
							'relevant findings, or decisions already made). The sub-agent cannot see this conversation, so pass ' +
							'any facts it needs here.',
					},
					toolsets: {
						type: 'array',
						items: { type: 'string' },
						description: 'Optional toolset scope for the sub-agent (e.g. ["core"] for read-only work). ' +
							'When set, the sub-agent may ONLY use tools from the listed toolsets — a way to constrain ' +
							'what the delegated work is allowed to do. Defaults to no restriction.',
					},
					model: {
						type: 'string',
						description: 'Optional model for the sub-agent. Accepts "providerId/modelId" (e.g. ' +
							'"knot-agui/gpt-4o-mini") or just "modelId" (reuses the session\'s current provider). ' +
							'When set, the sub-agent runs with this model instead of the session default.',
					},
					isolation_level: {
						type: 'string',
						enum: ['subagent', 'peer'],
						description: "Isolation model for this delegation. 'subagent' (default): hierarchical — inherits the parent's worktree, and cancelling the parent turn also cancels this sub-agent (parent fully controls its lifecycle). 'peer': peer-to-peer — runs independently, does NOT inherit the parent's worktree, and a parent-turn cancellation will NOT kill it (only an explicit interrupt or swarm cancel can). Use 'peer' for independent collaborators that should outlive the parent's turn.",
					},
					output_schema: {
						type: 'object',
						description: 'Optional JSON Schema for the sub-agent\'s final deliverable. When set, the sub-agent must return its conclusion as a JSON object matching this schema (validated, one retry on invalid output); the RESULT body will be the serialized JSON object instead of free text. Use when you need machine-readable structured findings.',
						properties: {
							_freeform: {
								type: 'object',
								description: 'Arbitrary JSON Schema object',
								properties: { _value: { type: 'string', description: 'A value (stringified)' } },
							},
						},
					},
				},
				required: ['task'],
			},
			category: 'delegation',
			source: ctx.id,
		},
		handler: async (args, signal, agentId) => {
			// 模型可能把 task 传成对象（而非 schema 声明的字符串），
			// 派发前归一化为字符串，避免 subAgent.task 变成对象后 CompletionGate 崩溃。
			const task = args['task'] !== undefined ? normalizeTaskArg(args['task']) : undefined;
			// tasks 数组已从 schema 移除——LLM 不应再传。向后兼容：若传入则合并
			// 所有任务为单个综合任务（而非丢弃后续任务），避免静默丢失工作。
			let tasks: string[] | undefined;
			if (Array.isArray(args['tasks'])) {
				const arr = (args['tasks'] as unknown[]).map(normalizeTaskArg).filter(t => t.trim().length > 0);
				if (arr.length > 0) {
					if (arr.length > 1) {
						ctx.logService.warn(`[delegate_task] 'tasks' array is deprecated (removed from schema). Merging ${arr.length} items into ONE comprehensive task.`);
					}
					tasks = arr.length === 1 ? [arr[0]] : [arr.map((t, i) => `${i + 1}. ${t}`).join('\n')];
				}
			}
			const typeArg = args['type'] as string | undefined;
			const contextArg = args['context'] as string | undefined;
			const toolsetsArg = args['toolsets'] as string[] | undefined;
			const modelArg = args['model'] as string | undefined;
			const isolationLevelArg = args['isolation_level'] as string | undefined;
			// P3（2026-07-26，对齐 MiMo output_schema）：要求子代理返回结构化 JSON 结论。
			const outputSchemaArg = args['output_schema'] as Record<string, unknown> | undefined;

			if (task && (!task.trim().length)) {
				return [{ type: 'text', text: 'delegate_task error: "task" must be a non-empty self-contained description.' }];
			}
			if (!task && (!tasks || tasks.length === 0)) {
				return [{ type: 'text', text: 'delegate_task error: provide "task" with a self-contained description.' }];
			}

			// P0: 只许调用项目中已注册的 3 个 read-only agent。
			// 非法/未指定时回退到 code-explorer，不允许创建新 agent。
			const VALID_DELEGATE_TYPES = ['code-explorer', 'researcher', 'data'] as const;
			type ValidDelegateType = typeof VALID_DELEGATE_TYPES[number];
			const resolveAgentType = (v?: string): SubAgentType => {
				// 只允许 3 个已注册 agent；非法值 → 回退到 code-explorer
				if (!v || !VALID_DELEGATE_TYPES.includes(v as ValidDelegateType)) {
					return SubAgentType.Explore;
				}
				return SubAgentType.Explore; // all 3 read-only agents → Explore type
			};
			const subAgentType = resolveAgentType(typeArg);
			// agentTypeLabel 用于 subagent 卡片的 type 字段（卡片 badge + title 前缀），
			// 直接映射用户指定的 agent 名；非法值回退 'explore'。
			const agentTypeLabel: string =
				(typeArg && VALID_DELEGATE_TYPES.includes(typeArg as ValidDelegateType))
					? typeArg
					: 'explore';
			// agentId 驱动（2026-07-27）：委派 type 解析到 builtinAgents.ts 中同名内置 Agent，
			// 用其真实 systemPrompt / tools 实例化子代理，替代通用 Explore 折中提示词。
			// 非法/未指定 → 回退 code-explorer（与 resolveAgentType / agentTypeLabel 回退一致）。
			// getBuiltinAgentIdentity 已剥离 DELEGATION_GUIDANCE，保证子代理不再嵌套委派。
			// 注意：**不**回退到内置 Agent 的 model 字段——那些字段常为老快照 ID
			// （如 code-explorer 的 claude-sonnet-4-20250514）不在当前环境 allow-list 中，
			// 会导致 chat first delta 即 error（事故 1785142383743）。子代理默认继承父模型。
			const canonicalAgentId: string =
				(typeArg && VALID_DELEGATE_TYPES.includes(typeArg as ValidDelegateType))
					? typeArg
					: 'code-explorer';
			const agentIdentity: Pick<SubAgentOptions, 'agentId' | 'systemPrompt' | 'allowedTools'> =
				getBuiltinAgentIdentity(canonicalAgentId) ?? { agentId: canonicalAgentId };
			// P2b: 解析隔离档位（默认 'subagent'）。
			const isolationLevel = resolveIsolationLevel(isolationLevelArg);

			// Resolve the optional model override. Accept "providerId/modelId"
			// or a bare "modelId" (reuses the session's current provider).
			const resolveModelArg = (v?: string): IModelSelection | undefined => {
				if (!v) { return undefined; }
				const slash = v.indexOf('/');
				if (slash > 0) {
					return { providerId: v.slice(0, slash), modelId: v.slice(slash + 1) };
				}
				const active = ctx.agentOS.getActiveModelSelection?.();
				return { providerId: active?.providerId ?? 'knot-agui', modelId: v };
			};
			// 显式 modelArg 优先，否则继承父 agent 的当前 model（不做内置 Agent model 回退）。
			// 事故（日志 1785142383743）：builtin `code-explorer` 硬编码 model='claude-sonnet-4-20250514'
			// 属老快照 ID，不在当前环境 allow-list 中 → modelProvider.chat 首个 delta 即 type=error，
			// 子代理 0 工具调用即"完成"，看起来像"subagent 没调用工具"。子代理天然应继承父模型，
			// 除非用户显式指定 modelArg。
			const modelSelection = resolveModelArg(modelArg);

			// P2b: peer 档不继承父 worktree（最小权限 —— peer 不应越权访问父工作区）。
			// subagent 档保持继承（现状）。isolationLevel 在上方已解析。
			const inheritWorktree = isolationLevel !== 'peer' ? ctx.getParentWorktreePath() : undefined;

			// ─── P0/P1: 流式执行过程旁路总线（inlineTraceSink）────────────────
			// 子 agent 执行的 tool_start / tool_end 事件经旁路总线实时推送到
			// SubAgentCard（不走主 delta 流）。与 planExploreTool 对齐，共享
			// subAgentCardReducer 纯函数驱动卡片快照，UI 按 id 幂等 upsert。
			const parentToolCallId = `delegate_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const cardMap = new Map<string, MutableCardState>();
			let batchGroupId = parentToolCallId;
			let flushTimer: ReturnType<typeof setTimeout> | undefined;

			const flushNow = () => {
				if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
				try {
					ctx.agentOS.fireSubAgentTrace({
						groupId: batchGroupId,
						// groupId 不出现在 MutableCardState 上，所有卡片共享 batchGroupId。
						// delegate_task 子代理：skipSubAgentCard=true → 不创建独立卡片，
						// 执行内容全部内嵌在 delegate_task 卡片中。
						subagentData: [...cardMap.values()].map(c => ({
							id: c.id, type: c.type as 'explore' | 'general' | 'scout', task: c.task,
							status: c.status as 'pending' | 'running' | 'done' | 'error' | 'cancelled',
							progress: c.progress, output: c.output, error: c.error,
							groupId: batchGroupId, toolTraces: c.toolTraces.map(t => ({ ...t })),
							parentToolCallId,
							startedAt: c.startedAt, completedAt: c.completedAt,
							skipSubAgentCard: true,
						})),
					});
				} catch { /* sink errors are swallowed by design */ }
			};
			const scheduleFlush = () => {
				if (flushTimer) { return; }
				flushTimer = setTimeout(() => { flushTimer = undefined; flushNow(); }, 100);
			};

			const inlineTraceSink: SubAgentEventSink = (ev) => {
				if (ev.groupId && !batchGroupId) { batchGroupId = ev.groupId; }
				let card = cardMap.get(ev.subAgentId);
				if (!card) {
					// groupId 不在 MutableCardState 上，通过 cardMap key → groupId 外挂映射。
					// ev.subAgentId 即 dispatch 内部的 subAgentId（跨流式与最终态天然一致）。
					// status 预置为 'pending'（非 'running'）+ startedAt 兜底：reduceCardState 的
					// Spawned 分支仅当 status !== 'running' && !== 'pending' 时才重置并写
					// startedAt——曾预置 'running' 导致首个 Spawned 事件被误判为"已在运行"而
					// 跳过赋值，startedAt 永久 undefined，卡片/footer 耗时文本恒为空
					// （_subAgentDurationText/_delegateTotalDurationText 首行即判空返回）。
					card = {
						id: ev.subAgentId,
						type: agentTypeLabel,
						task: ev.task || task || 'delegated task',
						status: 'pending',
						toolTraces: [],
						startedAt: Date.now(),
					};
					cardMap.set(ev.subAgentId, card);
				}
				reduceCardState(card!, ev);
				scheduleFlush();
			};

			// Build executeFn that delegates to AgentOS
			const executeFn = (request: IAgentTurnRequest, _budget: IterationBudget): AsyncIterable<IChatStreamDelta> => {
				return ctx.agentOS.executeAgentTurn(request);
			};

			// P1: delegate_task 并发保护。单任务请求 1 个子代理，批量请求 N 个。
			// 全局并发上限取 MAX_TASKS_PER_CALL(5)：防止过度创建，同时允许 1-5 个子代理。
			const dispatch = ctx.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch;
			const activeCount = dispatch.activeSubAgentCount;
			const isBatchMode = !task && tasks && tasks.length > 0;
			const requestedCount = isBatchMode ? tasks!.length : 1;

			if (activeCount + requestedCount > MAX_TASKS_PER_CALL) {
				const allowed = Math.max(0, MAX_TASKS_PER_CALL - activeCount);
				if (allowed === 0) {
					return [{ type: 'text', text: `delegate_task error: max ${MAX_TASKS_PER_CALL} concurrent sub-agents already running. Wait for existing sub-agents to complete before delegating again.` }];
				}
				if (isBatchMode) {
					ctx.logService.warn(`[delegate_task] batch truncated ${tasks!.length} → ${allowed} (global concurrent cap ${MAX_TASKS_PER_CALL}, active ${activeCount})`);
					tasks = tasks!.slice(0, allowed);
				}
			}

			// ── 工具集配置：按 agent 类型自动设置默认 toolsets ──
			// 如果 LLM 未指定 toolsetsArg，根据 agent 类型给子 agent 正确的工具集。
			// code-explorer: 图谱 + 内容 grep（codebase + codebase-grep 两个 toolset）+ 文件操作
			// researcher: web 搜索
			// data: 代码执行
			// 注意（事故 1785143114444）：`search_code` 挂在独立 toolset `codebase-grep`
			// 而非 `codebase`，遗漏它会导致 code-explorer 子代理只能用 `search_files`（ripgrep 文件名/路径）
			// 手搜代码内容，104 次搜索里 0 次 search_code——治本方案是把 `codebase-grep` 纳入默认。
			const DEFAULT_TOOLSETS_BY_TYPE: Record<string, string[]> = {
				'code-explorer': ['core', 'mcp-bridge', 'codebase', 'codebase-grep'],
				'researcher': ['core', 'mcp-bridge', 'web'],
				'data': ['core', 'mcp-bridge', 'exec', 'data'],
			};
			const effectiveToolsets = toolsetsArg && toolsetsArg.length > 0
				? toolsetsArg
				: (typeArg && DEFAULT_TOOLSETS_BY_TYPE[typeArg]) || undefined;

			// ── A：只读探索型子代理隐藏索引管理工具 + code-explorer 索引就绪前置 ──
			// 1. excludedTools：把 index_repository 等从子代理可见工具面移除，
			//    杜绝 LLM 把"索引已启动"误判为任务完成（治本，非提示词约束）。
			// 2. preflight：code-explorer 依赖代码图，dispatch 前由代码层建好图，
			//    使子代理可直接调用 search_graph，无需（也不能）再调用 index_repository。
			const excludedTools = subAgentType === SubAgentType.Explore ? EXPLORE_EXCLUDED_TOOLS : undefined;
			if (agentTypeLabel === 'code-explorer') {
				await _ensureGraphReadyForExplore(ctx);
			}

			try {
				if (task) {
					// Single task mode —— 需求（2026-07-26）：「一个 subagent 执行完毕
					// 所有任务」。同父 agent + 同类型 + 窗口内完成的子代理直接
					// follow-up 续跑（复用会话：上下文完整保留 + 免冷启动），
					// 否则才新起子代理。
					const dispatchSvc = ctx.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch;
					const reusable = dispatchSvc.findReusableSubAgent(agentId ?? 'unknown', subAgentType);
					let result: SubAgentResult;
					if (reusable) {
						ctx.logService.info(`[delegate_task] follow-up 复用子代理 ${reusable.id}（type=${subAgentType}），免冷启动`);
						result = await dispatchSvc.dispatchFollowUp(
							reusable.id,
							task,
							executeFn,
							inlineTraceSink,
							signal,
						);
					} else {
						result = await dispatchSvc.dispatch(
							agentId ?? 'unknown',
							task,
							executeFn,
							{ type: subAgentType, isolationLevel, worktreePath: inheritWorktree, context: contextArg, toolsets: effectiveToolsets, model: modelSelection, excludedTools, ...agentIdentity, ...(outputSchemaArg ? { outputSchema: outputSchemaArg } : {}) },
							inlineTraceSink, // P0/P1: 旁路总线流式驱动 SubAgentCard 工具痕迹
							signal,     // P3: 父→子取消传播（父 turn abort 信号）
						);
					}

					// R5 兜底：flush 终态快照，含完整 toolTraces。
					flushNow();

					// 从 result.toolTrace 提取工具痕迹到 subagentData，
					// 供 SubAgentCard 渲染（与 planExploreTool 对齐）。
					// subAgentId 由 inlineTraceSink 的事件写入 cardMap；
					// 取首个卡片的 id 回填到 subagentData（单任务模式下只有一张卡）。
					const finalCard = cardMap.size > 0 ? [...cardMap.values()][0] : undefined;
					const saId = finalCard?.id ?? parentToolCallId;
					const toolTraces = resolveFinalToolTraces(finalCard, result, saId);
					const toolSummary = toolTraces.length > 0
						? `Tools: ${toolTraces.map(t => t.name).slice(0, 8).join(', ')}`
						: 'No tools used';

					ctx.agentOS.fireSubAgentTrace({
						groupId: batchGroupId,
						subagentData: [{
							id: saId,
							type: agentTypeLabel,
							task: task.slice(0, 200),
							status: result.success ? 'done' as const : 'error' as const,
							output: result.success ? stripCompletionGateFooter(result.output || '(no output)').slice(0, 2000) : (result.error || 'unknown error'),
							progress: toolSummary,
							groupId: batchGroupId,
							parentToolCallId,
							toolTraces,
							startedAt: finalCard?.startedAt, completedAt: finalCard?.completedAt,
						}],
					});

					// P2c 末步强制收尾：结构化收尾（含 role + exitReason），不丢失败原因。
					return [{ type: 'text', text: formatDelegationResult(subAgentType, result, undefined, isolationLevel) }];
				}

				// Batch tasks mode（1-5 个独立子代理并行）。
				// agentId 驱动：每个并行子代理都以内置 Agent 身份实例化（systemPrompt/tools/model）。
				const perTaskOptions = tasks!.map(() => ({
					type: subAgentType,
					isolationLevel,
					toolsets: effectiveToolsets,
					...agentIdentity,
					...(inheritWorktree ? { worktreePath: inheritWorktree } : {}),
					...(toolsetsArg ? { toolsets: toolsetsArg } : {}),
					...(modelSelection ? { model: modelSelection } : {}),
					...(excludedTools ? { excludedTools } : {}),
					...(outputSchemaArg ? { outputSchema: outputSchemaArg } : {}),
				}));
				const results = await (ctx.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch).dispatchParallelExplore(
					agentId ?? 'unknown',
					tasks!,
					executeFn,
					contextArg, // shared context injected into every batched sub-agent
					perTaskOptions,
					inlineTraceSink, // P0/P1: 旁路总线流式驱动 SubAgentCard 工具痕迹
					signal,    // P3: 父→子取消传播（父 turn abort 信号）
				);

				// R5 兜底：flush 终态快照
				flushNow();

				// 从每个 result.toolTrace 提取工具痕迹，构建 subagentData。
				const subagentData = results.map((r: SubAgentResult, i: number) => {
					// 按任务文本匹配流式卡片（并行下事件到达顺序 ≠ 任务顺序，
					// 位置匹配 [...cardMap.keys()][i] 会把 traces/output 错配到别的子代理）。
					// card.task 来自事件 ev.task = subAgent.task = tasks[i]（dispatch 边界
					// 已经 normalizeTaskArg 归一化为同一字符串），可精确匹配。
					const card = [...cardMap.values()].find(c => c.task === tasks![i]);
					const saId = card?.id ?? `delegate-${parentToolCallId}-${i}`;
					const toolTraces = resolveFinalToolTraces(card, r, saId);
					const toolSummary = toolTraces.length > 0
						? `Tools: ${toolTraces.map(t => t.name).slice(0, 8).join(', ')}`
						: 'No tools used';
					return {
						id: saId,
						type: agentTypeLabel,
						task: (tasks![i] || `Task ${i + 1}`).slice(0, 200),
						status: r.success ? 'done' as const : 'error' as const,
						output: r.success ? stripCompletionGateFooter(r.output || '(no output)').slice(0, 2000) : (r.error || 'unknown error'),
						progress: toolSummary,
						groupId: batchGroupId,
						parentToolCallId,
						toolTraces,
						startedAt: card?.startedAt, completedAt: card?.completedAt,
						skipSubAgentCard: true,
					};
				});

				ctx.agentOS.fireSubAgentTrace({
					groupId: batchGroupId,
					subagentData,
				});

				// P2c 末步强制收尾：每个并行子 agent 都用结构化收尾（含 role + exitReason）。
				const lines = results.map((r: SubAgentResult, i: number) =>
					formatDelegationResult(subAgentType, r, i + 1, isolationLevel));
				return [{ type: 'text', text: lines.join('\n\n') }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return [{ type: 'text', text: `delegate_task error: ${msg}` }];
			}
		},
		descriptionBuilder: (agentId: string) => {
			try {
				const dispatch = ctx.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch;
				const config = dispatch.getConfig();
				return `Delegate a task to a sub-agent (single task per call). ` +
					`Each sub-agent runs independently and returns its result. ` +
					`For parallel work, issue multiple delegate_task calls in one message. ` +
					`(max ${config.maxConcurrent} concurrent, ${config.maxSpawnDepth} levels deep). ` +
					`\n\n` +
					`## CRITICAL — the sub-agent starts BLANK:\n` +
					`It cannot see this conversation. Write every task as a self-contained briefing:\n` +
					`- GOAL: what to accomplish and why\n` +
					`- CONTEXT: what you already know / have ruled out\n` +
					`- ACCEPTANCE: how to know it is done, plus output limits (e.g. "report in <200 words")\n` +
					`\n\n` +
					`## All sub-agents are Explore (read-only search/read/list)\n` +
					`- Searches inside sub-agents do NOT consume your context window.\n` +
					`- Use plan_explore for parallel multi-area investigation; delegate_task for focused deep-dives.\n` +
					`\`- isolation_level: 'subagent' (default, parent-controlled) or 'peer' (independent, survives parent-turn cancellation, no inherited worktree).\n` +
					`\n\n` +
					`## Pass context with \`context\`:\n` +
					`- The sub-agent is BLANK, so anything it needs from this conversation must be passed here (prior steps, findings, decisions).\n` +
					`- Keep it a concise summary — do not paste the whole transcript.\n` +
					`\n\n` +
					`## Scope the sub-agent (optional):\n` +
					`- \`toolsets\`: restrict which toolsets the sub-agent may use, e.g. ["core"] for read-only investigation. Omit for no restriction.\n` +
					`- \`model\`: run the sub-agent on a specific model, e.g. "knot-agui/gpt-4o-mini" or just "gpt-4o-mini" (reuses the session provider). Use a cheaper model for trivial fan-out to save cost.\n` +
					`\n\n` +
					`## When to use:\n` +
					`- Exploring ONE feature/mechanism even across multiple files or aspects\n` +
					`  (e.g. "analyze GC" → ONE task covering all GC aspects; do NOT split by aspect)\n` +
					`- A single job complex enough to benefit from a dedicated context\n` +
					`- Slow or expensive work that would otherwise block your own context\n` +
					`\n\n` +
					`## When NOT to use:\n` +
					`- The task is simple and can be completed in one turn\n` +
					`- You need to maintain ongoing context/memory across steps\n` +
					`- You are already at maximum spawn depth\n`;
			} catch {
				return `Delegate a task to a sub-agent (single task per call). ` +
					'Each sub-agent runs independently and returns its result.';
			}
		},
	});
	ctx.logService.info('[BuiltinTools] _registerDelegationTools: delegate_task registered');

	// ── new_agent — 创建持久化 Agent 定义 ──────────────────────────────
	// 与 delegate_task 的区别：new_agent 创建可复用的持久化 Agent，
	// 而 delegate_task 创建一次性子代理。详见 handleNewAgentTool 文档。
	ctx.register({
		definition: {
			name: 'new_agent',
			description: [
				'Create a new persistent agent definition that can be reused for future tasks.',
				'',
				'The created agent is saved to ~/.vssaros/agents/{agentId}/ and becomes available',
				'for delegation (delegate_task), orchestration plans, and manual invocation.',
				'',
				'## When to use:',
				'- You need a specialized agent that does not exist yet',
				'- A task requires a role/toolset combination not covered by existing agents',
				'- You want to create a reusable team member for ongoing work',
				'',
				'## When NOT to use:',
				'- For a one-off or throwaway task — this creates a persistent agent; run the task via the read-only delegation tool instead.',
				'- For codebase exploration / search — never create a generic "General Assistant"; that belongs to the read-only exploration sub-agent.',
				'- The agent already exists (reuse it via delegation)',
				'',
				'## Role guidance:',
				'- Set `role` to a CONCRETE specialty that matches the agent purpose (e.g. "Code Reviewer", "Researcher", "Tester").',
				'- Avoid vague roles like "General Assistant" — a persistent agent should have a focused specialty; one-off exploration is handled by the read-only exploration sub-agent.',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Human-readable agent name (e.g. "Code Reviewer")' },
					role: { type: 'string', description: 'Agent role/specialty — use a CONCRETE value (e.g. "Code Reviewer", "Researcher", "Tester"). Avoid vague "General Assistant"; a persistent agent should have a focused specialty.' },
					description: { type: 'string', description: 'What this agent does and when to use it' },
					systemPrompt: { type: 'string', description: 'Custom system prompt for the agent' },
					model: { type: 'string', description: 'LLM model (default: inherits workspace default)' },
					tools: {
						type: 'array',
						items: { type: 'string' },
						description: 'Enabled tool names (default: all core tools)',
					},
					skills: {
						type: 'array',
						items: { type: 'string' },
						description: 'Skill names to enable',
					},
					category: { type: 'string', description: 'Category label (default: "General")' },
				},
				required: ['name', 'role', 'description'],
			},
			category: 'delegation',
			source: ctx.id,
			securityLevel: ToolSecurityLevel.Cautious,
		},
		handler: async (args) => {
			return handleNewAgentTool(args, ctx.studioService);
		},
	});
	ctx.logService.info('[BuiltinTools] _registerDelegationTools: new_agent registered');
}
