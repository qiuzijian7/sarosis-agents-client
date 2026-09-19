/*---------------------------------------------------------------------------------------------
 *  请求发出前的诊断日志段 —— 由 `agentTurnExecutor.ts` 迁出（2026-09-17 Part 化期 5）。
 *
 *  两个函数都在「构造完 modelOptions、真正发请求之前」调用，特征一致：
 *    · 纯日志，**零返回值、零副作用**（不改 messages / runState / enabledTools）；
 *    · 不参与控制流（无 yield / break / continue）；
 *    · 失败一律吞掉 —— 诊断绝不阻断请求。
 *
 *  刻意未迁出的邻近代码及原因：
 *    · `modelOptions` / `context` / `conversationId` / `_estAtRequest` 等构造
 *      —— 其值跨段被消费（usage 回来后的 promptOverhead 配对、错误日志），
 *      迁出会退化成一个大 out-param 包，得不偿失；
 *    · `computeForkContext` 已在 turnIterationGate.ts，不重复搬运。
 *--------------------------------------------------------------------------------------------*/

import {
	buildPromptBudgetReport,
	formatPromptBudgetLog,
	shouldEmitBudgetReport,
} from '../../common/promptBudget.js';
import { probeToolGuidance, formatToolSchemaDiagLog } from '../../common/promptDiagnostics.js';

/** 日志宿主窄接口 —— 只声明本段实际调用的成员。 */
export interface IRequestDiagnosticsLogger {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
}

/** 工具 schema 成本分组结果（与主文件 `groupToolSchemaCosts` 的返回同构）。 */
export interface IToolSchemaCostBreakdown {
	groups: Array<{ name: string; tokens: number; count: number }>;
	costs: Array<{ name: string; tokens: number }>;
}

/** `emitPromptBudgetReport` 的入参。 */
export interface IPromptBudgetReportDeps {
	logService: IRequestDiagnosticsLogger;
	messages: ReadonlyArray<unknown>;
	/** 本请求发出时刻的消息粗估 token（主文件的 `_estAtRequest`）。 */
	messagesTokens: number;
	/** 本请求发出时刻的 tools schema 粗估 token（主文件的 `_toolsSchemaAtRequest`）。 */
	toolsSchemaTokens: number;
	/** 冻结前缀的命名段（主文件传 `request.promptSegments`）。 */
	frozenPrefixSegments: unknown;
	contextWindow: number;
	enabledTools: ReadonlyArray<unknown>;
	/** 工具 schema 成本分组（主文件注入 `groupToolSchemaCosts`，避免 Part 反向 import 主文件）。 */
	groupToolSchemaCosts: (tools: ReadonlyArray<unknown>) => IToolSchemaCostBreakdown;
	/** 上一次报告的总量，用于漂移节流；由调用方持有并在回调里更新。 */
	lastPromptBudgetTotal: number;
	/** 实际打印了报告时回调，供调用方写回 `loopState.lastPromptBudgetTotal`。 */
	onReported: (totalTokens: number) => void;
	/** 审批开关是否开启（影响 approvalShape 探针是否算缺陷）。 */
	isToolCallConfirmationEnabled: boolean;
}

/**
 * 输出 [PromptBudget] 提示词预算表 + [ToolSchemaDiag] 引导文案送达探针。
 *
 * promptOverhead 只回答「一共多大」；预算表回答「**谁**在吃 context」：
 * 冻结前缀按 driver 登记的命名段归因、注入型 system 消息按来源分类、
 * tools schema 按 toolset 聚合 + 列出最贵的几个工具。
 *
 * 节流：每 turn 首次必打 + 之后仅总量漂移 ≥15% 再打（见 `shouldEmitBudgetReport`），
 * 避免每个 iteration 刷 10 行；刻意不挂配置开关。
 */
export function emitPromptBudgetReport(deps: IPromptBudgetReportDeps): void {
	const { logService } = deps;
	try {
		const toolCost = deps.groupToolSchemaCosts(deps.enabledTools);
		const budget = buildPromptBudgetReport({
			messages: deps.messages as any,
			messagesTokens: deps.messagesTokens,
			frozenPrefixSegments: deps.frozenPrefixSegments as any,
			toolGroups: toolCost.groups,
			toolCosts: toolCost.costs,
			contextWindow: deps.contextWindow,
		});
		if (!shouldEmitBudgetReport(budget.totalTokens, deps.lastPromptBudgetTotal)) {
			return;
		}
		const note = deps.lastPromptBudgetTotal > 0
			? `drift from ${deps.lastPromptBudgetTotal}`
			: `turn baseline`;
		logService.info(formatPromptBudgetLog(budget, note));
		deps.onReported(budget.totalTokens);

		// ── [ToolSchemaDiag] 关键引导文案是否真的送达模型（2026-08-22）──────
		// 与预算表同频（每 turn 首次 + 显著漂移时），避免每轮刷屏。
		// 用途：模型不遵守 description 时，先用这条排除「文案没进 schema /
		// 被截断 / 工具被折叠成桥接」三种情形，再判定是「模型不听」。
		// 此前只能靠 toolsSchemaTokens 差值间接推断（13509→13912），
		// 既要人工换算、也定位不到具体哪个工具。
		const probes = probeToolGuidance(
			deps.enabledTools as ReadonlyArray<{ name?: string; description?: string }>,
			// 审批关闭时 approvalShape 探针的引导段本就不下发（见
			// compatibilityTools.shellApprovalGuidance），探针标 skipped 不算缺陷。
			deps.isToolCallConfirmationEnabled,
		);
		const schemaDiag = formatToolSchemaDiagLog(probes, deps.enabledTools.length, deps.toolsSchemaTokens);
		if (schemaDiag.level === 'warn') {
			logService.warn(schemaDiag.text);
		} else {
			logService.info(schemaDiag.text);
		}
	} catch (budgetError) {
		// 诊断失败绝不阻断请求
		logService.warn('[PromptBudget] failed to build report:', budgetError);
	}
}

/** MCP 连接层统计（主文件注入 `getLastMcpServerStats()` 的结果）。 */
export interface IMcpServerStats {
	servers: string[];
	toolCount: number;
}

/** `logToolsSentToLlm` 的入参。 */
export interface IToolsSentLogDeps {
	logService: IRequestDiagnosticsLogger;
	enabledTools: ReadonlyArray<{ name?: string; category?: string }>;
	/** 是否为子代理回合 —— 决定「无 MCP 工具」是 warn 还是 info。 */
	isSubAgent: boolean;
	agentId: string | undefined;
	sessionId: string | undefined;
	/** 会话级去重集合，由调用方跨 turn 持有。 */
	noMcpWarnedSessions: Set<string>;
	/** MCP 连接层统计；无则表示本会话未发现任何 MCP 工具。 */
	getLastMcpServerStats: () => IMcpServerStats | undefined;
}

/**
 * 列出实际发送给 LLM 的所有工具名，并在「一个 MCP 工具都没有」时给出分叉诊断。
 *
 * 「无 MCP 工具」的三种处置（成因完全不同，不分清就会一直治标）：
 *   · 子代理回合 → 一律 info。子代理工具集由 dispatcher 决定
 *     （`DEFAULT_TOOLSETS_BY_TYPE`），没有可让用户去改的「agent 的 tools」配置，
 *     且每个子代理有独立 agentId ⇒ 会话级去重对它天然失效、反复刷屏；
 *   · 主代理首次 → warn 一次并写入去重集合。再按「连接层面是否检测到 MCP
 *     服务器」分叉：已连接但被 agent 工具集裁掉 vs 压根没连上；
 *   · 主代理后续 → 降级 info（未配置/未连接 MCP 是稳态而非逐轮异常）。
 */
export function logToolsSentToLlm(deps: IToolsSentLogDeps): void {
	const { logService, enabledTools } = deps;
	if (enabledTools.length === 0) {
		logService.warn(`[AgentOS] ⚠ NO TOOLS at all in API request!`);
		return;
	}

	const mcpToolsSent = enabledTools.filter((t) => t.category?.startsWith('mcp:'));
	const builtinToolsSent = enabledTools.filter((t) => !t.category?.startsWith('mcp:'));
	logService.info(
		`[AgentOS] TOOLS SENT TO LLM: ${enabledTools.length} total\n` +
		`  MCP tools (${mcpToolsSent.length}): [${mcpToolsSent.map((t) => t.name).join(', ')}]\n` +
		`  Builtin tools (${builtinToolsSent.length}): [${builtinToolsSent.map((t) => t.name).join(', ')}]`
	);
	if (mcpToolsSent.length > 0) {
		return;
	}

	const sessionKey = deps.sessionId || deps.agentId || 'unknown';
	if (deps.isSubAgent) {
		logService.info(
			`[AgentOS] NO MCP TOOLS in subagent turn (by design — subagent toolset comes from the ` +
			`dispatcher, not from agent tools config; ${builtinToolsSent.length} builtin tools sent) ` +
			`agentId=${deps.agentId ?? '(n/a)'}`,
		);
		return;
	}
	if (deps.noMcpWarnedSessions.has(sessionKey)) {
		logService.info(`[AgentOS] NO MCP TOOLS in API request (session already warned once)`);
		return;
	}

	deps.noMcpWarnedSessions.add(sessionKey);
	// ★ 2026-09-07：旧文案「not connected or configured」把两种成因混为一谈，
	// 实测误导（日志 1788767675940：comfy-mcp 已连接、39 个工具已发现，实为被
	// agent 工具集裁掉，却被读成连不上）。现按连接层面是否检测到服务器分叉。
	const stats = deps.getLastMcpServerStats();
	const reason = stats
		? `MCP tools excluded by agent toolset — servers connected: [${stats.servers.join(', ')}] with ${stats.toolCount} tool(s) available but none enabled for this agent (add 'mcp:<server>' to the agent's tools, or enable the MCP toolset)`
		: `MCP servers not connected or configured — no MCP tool was discovered in this session`;
	logService.warn(`[AgentOS] ⚠ NO MCP TOOLS in API request — ${reason} (won't warn again this session; ${builtinToolsSent.length} builtin tools unaffected)`);
}
