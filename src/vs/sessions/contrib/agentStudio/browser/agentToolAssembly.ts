/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent Tool Assembly — 从 agentOSService.ts 抽出 _getEnabledTools（~275 行）。
 *
 * 负责：工具收集 → toolset 推断 → Agent 配置过滤 → focus 模式 → assembly →
 * schema 修正 → 桥接排序 → LRU 缓存。
 *
 * 对齐 Hermes-Agent model_tools.py 的 get_tool_definitions + cache_key 设计。
 */

import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IModelProvider, IToolDefinition,
} from '../common/providers.js';
import {
	ToolsetPriority, getToolsetForTool, getToolsetPriority, isBridgeTool, isCoreTool,
	TOOL_SEARCH_BRIDGE_TOOLS,
} from '../common/toolsetConfig.js';
import {
	assembleToolDefs, IAssemblyResult,
	IToolSearchConfig,
} from '../common/toolSearchAssembler.js';
import {
	buildDispatcherContext, IDispatcherContext,
} from '../common/toolSearchDispatcher.js';
import {
	correctSchemaReferences,
} from '../common/schemaCorrector.js';
import {
	IFocusModeResult,
} from '../common/focusMode.js';
import { applyHardPermission, type IHardPermissionPolicy } from '../common/toolPermission.js';
import { AgentGraph, TRANSFER_TO_AGENT_TOOL } from '../common/agentGraph.js';

export interface ToolAssemblyDeps {
	readonly logService: ILogService;
	// Service callbacks (delegate to wrappers / private methods on host)
	resolveContextWindow: (provider: IModelProvider, modelId: string) => Promise<number>;
	listAllToolsWithState: (agentId: string) => Promise<Array<IToolDefinition & { enabled: boolean; category?: string }>>;
	getAgentToolsConfig: (agentId?: string) => string[] | undefined;
	getAgentEnabledToolsets: (agentId?: string) => string[] | undefined;
	getAgentDisabledToolsets: (agentId?: string) => string[] | undefined;
	shouldEnableUpdatePlan: (agentId?: string) => boolean;
	detectFocusModeIfNeeded: () => Promise<IFocusModeResult>;
	getToolSearchConfig: () => IToolSearchConfig;
	getConfigFingerprint: () => string;
	// Read-only state snapshots
	registryGeneration: number;
	currentModelProvider: IModelProvider | undefined;
	currentModelId: string | undefined;
	// Mutable state (Map passed by reference — operations work directly)
	cachedToolDefs: Map<string, IToolDefinition[]>;
	toolDefsCacheMax: number;
	// Write callbacks (for fields that get reassigned on host)
	setLastAllEnabledToolNames: (names: Set<string>) => void;
	setLastAssembly: (assembly: IAssemblyResult) => void;
	setLastDispatcherCtx: (ctx: IDispatcherContext) => void;
}

export async function getEnabledTools(
	deps: ToolAssemblyDeps,
	agentId: string,
	agentGraph?: AgentGraph,
	toolsetsOverride?: string[],
	hardPermission?: IHardPermissionPolicy,
	excludedTools?: readonly string[],
	allowedTools?: readonly string[],
): Promise<IToolDefinition[]> {
	type TTool = IToolDefinition & { enabled: boolean; toolset: string };

	const contextWindow = (deps.currentModelProvider && deps.currentModelId)
		? await deps.resolveContextWindow(deps.currentModelProvider, deps.currentModelId)
		: undefined;

	const allWithState = await deps.listAllToolsWithState(agentId);
	const enabled = allWithState.filter(t => t.enabled) as TTool[];
	deps.setLastAllEnabledToolNames(new Set(enabled.map(t => t.name)));

	const cacheKey = [
		agentId,
		deps.registryGeneration,
		deps.getConfigFingerprint(),
		contextWindow ?? 'undefined',
		// toolsetsOverride / excludedTools 影响最终过滤结果，必须计入缓存键——
		// 否则同一 agent 用不同 scope/exclusion 时会命中旧缓存（被唯一 subagent id
		// 掩盖的既有 bug，这里一并修正）。
		...(toolsetsOverride ? [`ts:${[...toolsetsOverride].sort().join(',')}`] : []),
		...(excludedTools ? [`ex:${[...excludedTools].sort().join(',')}`] : []),
		...(allowedTools ? [`al:${[...allowedTools].sort().join(',')}`] : []),
		...allWithState.map(t => `${t.name}:${t.enabled ? '1' : '0'}`).sort(),
	].join('|');

	const cached = deps.cachedToolDefs.get(cacheKey);
	if (cached) {
		deps.cachedToolDefs.delete(cacheKey);
		deps.cachedToolDefs.set(cacheKey, cached);
		deps.logService.info(`[AgentOS] _getEnabledTools: cache hit — ${cached.length} tools (gen=${deps.registryGeneration}, ctxWin=${contextWindow ?? '?'})`);
		return applyHardPermission(cached, hardPermission);
	}

	while (deps.cachedToolDefs.size >= deps.toolDefsCacheMax) {
		const oldest = deps.cachedToolDefs.keys().next().value;
		if (oldest !== undefined) {
			deps.cachedToolDefs.delete(oldest);
		}
	}

	// Step 1: 分离 MCP 工具，按服务器创建动态 toolset
	const mcpOriginal = enabled.filter(t => t.category?.startsWith('mcp:'));
	const builtin = enabled.filter(t => !t.category?.startsWith('mcp:'));
	const mcpToolsetByServer = new Map<string, string[]>();
	for (const t of mcpOriginal) {
		const server = (t.category as string).replace(/^mcp:/, '');
		if (!mcpToolsetByServer.has(server)) {
			mcpToolsetByServer.set(server, []);
		}
		mcpToolsetByServer.get(server)!.push(t.name);
	}
	if (mcpToolsetByServer.size > 0) {
		const servers = [...mcpToolsetByServer.entries()].map(([s, tools]) => `${s}(${tools.length})`).join(', ');
		deps.logService.info(`[AgentOS] _getEnabledTools: MCP servers detected — ${servers}`);
	}

	// Step 2: 推断 toolset
	const tagged: TTool[] = builtin.map(t => ({
		...t,
		toolset: (t.toolset ?? getToolsetForTool(t.name)) as string,
	}));
	const mcpTagged: TTool[] = mcpOriginal.map(t => {
		const server = (t.category as string).replace(/^mcp:/, '');
		return { ...t, toolset: `mcp-${server}` };
	});

	// Step 3: Agent.tools[] + enabledToolsets + disabledToolsets 配置过滤
	const agentTools = deps.getAgentToolsConfig(agentId);
	const agentToolsets = deps.getAgentEnabledToolsets(agentId);
	const agentDisabledToolsets = deps.getAgentDisabledToolsets(agentId);
	const allTagged = [...tagged, ...mcpTagged];
	let scoped = allTagged;

	// Step 3a: 自动 focus 模式
	if (!agentToolsets?.length) {
		const focusResult = await deps.detectFocusModeIfNeeded();
		if (focusResult.mode === 'focus' && focusResult.recommendedToolsets.length > 0) {
			const focusSet = new Set(focusResult.recommendedToolsets);
			const hasMcpLegacy = focusSet.has('mcp');
			const beforeFocus = scoped.length;
			scoped = scoped.filter(t =>
				focusSet.has(t.toolset) || isBridgeTool(t.name) || isCoreTool(t.name)
				|| getToolsetPriority(t.toolset) === ToolsetPriority.Always
				|| (hasMcpLegacy && t.toolset.startsWith('mcp-'))
			);
			deps.logService.info(`[AgentOS] _getEnabledTools: focus mode auto-applied [${focusResult.recommendedToolsets.join(', ')}] (${focusResult.reason}) -> ${scoped.length}/${beforeFocus} tools`);
		}
	}

	if (agentToolsets?.length) {
		const toolsetSet = new Set(agentToolsets);
		scoped = scoped.filter(t => toolsetSet.has(t.toolset) || isBridgeTool(t.name));
		deps.logService.info(`[AgentOS] _getEnabledTools: agent ${agentId} enabledToolsets [${agentToolsets.join(', ')}] -> ${scoped.length}/${allTagged.length} tools`);
	}
	if (agentTools?.length) {
		const toolSet = new Set(agentTools);
		scoped = allTagged.filter(t =>
			toolSet.has(t.name) || isBridgeTool(t.name)
			|| getToolsetPriority(t.toolset) === ToolsetPriority.Always
		);
		deps.logService.info(`[AgentOS] _getEnabledTools: agent ${agentId} tools config -> ${scoped.length}/${allTagged.length}`);
	}

	if (agentDisabledToolsets?.length) {
		const beforeDisable = scoped.length;
		const disabledSet = new Set(agentDisabledToolsets);
		scoped = scoped.filter(t => {
			if (isBridgeTool(t.name)) { return true; }
			if (!disabledSet.has(t.toolset)) { return true; }
			if (getToolsetPriority(t.toolset) === ToolsetPriority.Always) { return true; }
			return false;
		});
		const afterDisable = scoped.length;
		if (beforeDisable !== afterDisable) {
			deps.logService.info(`[AgentOS] _getEnabledTools: agent ${agentId} disabledToolsets [${agentDisabledToolsets.join(', ')}] (with core protection) -> ${afterDisable}/${beforeDisable} tools`);
		}
	}

	// Step 3c: update_plan 门控
	const updatePlanEnabled = deps.shouldEnableUpdatePlan(agentId);
	if (!updatePlanEnabled) {
		const beforePlan = scoped.length;
		scoped = scoped.filter(t => t.name !== 'update_plan');
		if (beforePlan !== scoped.length) {
			deps.logService.info(`[AgentOS] _getEnabledTools: update_plan disabled -> ${scoped.length}/${beforePlan} tools`);
		}
	}

	// Step 3d: per-request toolset scope override
	if (toolsetsOverride?.length) {
		const overrideSet = new Set(toolsetsOverride);
		const beforeOverride = scoped.length;
		scoped = scoped.filter(t => overrideSet.has(t.toolset) || isBridgeTool(t.name));
		deps.logService.info(`[AgentOS] _getEnabledTools: toolsetsOverride [${toolsetsOverride.join(', ')}] -> ${scoped.length}/${beforeOverride} tools`);
	}

	// Step 3d-allowlist: per-request tool-name allowlist (agentId-driven delegation).
	// When a delegated sub-agent is instantiated from a builtin Agent, its `tools`
	// array is passed here so the visible tool surface is narrowed to EXACTLY those
	// tools — plus mandatory bridge tools and Always-priority tools (never dropped so
	// the sub-agent can still search/complete). Applied on top of toolsetsOverride.
	if (allowedTools?.length) {
		const allowSet = new Set(allowedTools);
		const beforeAllow = scoped.length;
		scoped = scoped.filter(t =>
			allowSet.has(t.name) || isBridgeTool(t.name)
			|| getToolsetPriority(t.toolset) === ToolsetPriority.Always
		);
		deps.logService.info(`[AgentOS] _getEnabledTools: allowedTools [${allowedTools.join(', ')}] -> ${scoped.length}/${beforeAllow} tools`);
	}

	// Step 3e: per-request tool-name exclusion (delegation) — unconditional, applied
	// AFTER all toolset/allowlist filtering so the parent can hide specific tools
	// (e.g. index_repository) from a sub-agent without touching the toolset config.
	if (excludedTools?.length) {
		const excludedSet = new Set(excludedTools);
		const beforeExclude = scoped.length;
		// '*' 通配：排除全部工具（2026-07-26 P1 停滞强制总结的禁工具轮——
		// 对齐 MiMo max-steps 的 toolChoice:"none"，模型只能输出文本总结）。
		scoped = excludedSet.has('*') ? [] : scoped.filter(t => !excludedSet.has(t.name));
		if (beforeExclude !== scoped.length) {
			deps.logService.info(`[AgentOS] _getEnabledTools: excludedTools [${excludedTools.join(', ')}] -> ${scoped.length}/${beforeExclude} tools`);
		}
	}

	const mcpToolNameSet = new Set(mcpOriginal.map(t => t.name));

	// Step 4: Assembly 层
	const nonMcpScoped = scoped.filter(t => !mcpToolNameSet.has(t.name));
	const tsConfig = deps.getToolSearchConfig();
	const assembly = assembleToolDefs([...nonMcpScoped, ...mcpTagged], {
		contextLength: contextWindow,
		config: tsConfig,
	});
	let finalTools = assembly.toolDefs;

	if (!assembly.activated && mcpOriginal.length > 0) {
		deps.logService.info(`[AgentOS] _getEnabledTools: passthrough — ${mcpOriginal.length} MCP tools sent directly`);
	}

	deps.setLastAssembly(assembly);
	deps.setLastDispatcherCtx(buildDispatcherContext(assembly, tsConfig));

	// 诊断日志
	{
		const directToolNames = finalTools.filter(t => !isBridgeTool(t.name)).map(t => t.name);
		const mcpServers = [...mcpToolsetByServer.keys()];
		const parts: string[] = [];
		parts.push(`[AgentOS] Direct-sent tools (${directToolNames.length}/${enabled.length}): ${directToolNames.join(', ')}`);
		if (mcpServers.length > 0) {
			parts.push(`| MCP servers (${mcpServers.length}): ${mcpServers.join(', ')} (mcpTools=${mcpOriginal.length})`);
		}
		if (assembly.deferredCount > 0) {
			parts.push(`| deferred via tool_search: ${assembly.deferredCount}`);
		}
		deps.logService.info(parts.join(' '));
	}

	// Step 6: 桥接工具排前面
	const BRIDGE_NAMES: Set<string> = new Set([
		TOOL_SEARCH_BRIDGE_TOOLS.search, TOOL_SEARCH_BRIDGE_TOOLS.describe, TOOL_SEARCH_BRIDGE_TOOLS.call,
	]);
	finalTools.sort((a, b) => (BRIDGE_NAMES.has(a.name) ? 0 : 1) - (BRIDGE_NAMES.has(b.name) ? 0 : 1));

	// Step 7: Schema 修正
	const beforeCorrection = finalTools.length;
	finalTools = correctSchemaReferences(finalTools);
	if (finalTools.length !== beforeCorrection || finalTools.some((t, i) => t !== finalTools[i])) {
		deps.logService.info(`[AgentOS] _getEnabledTools: schema correction applied`);
	}

	if (mcpOriginal.length) {
		deps.logService.info(`[AgentOS] _getEnabledTools: ${mcpOriginal.length} MCP tools — ${assembly.activated ? 'folded into unified bridge' : 'sent directly (passthrough)'}`);
	}
	if (assembly.activated) {
		deps.logService.info(`[AgentOS] _getEnabledTools: Tool Search activated — ${assembly.deferredCount} deferred (~${assembly.deferredTokens} tokens, thresh ~${assembly.thresholdTokens})`);
	}
	deps.logService.info(`[AgentOS] _getEnabledTools: ${finalTools.length}/${enabled.length}/${allWithState.length} tools (assembly-driven) for ${agentId}`);

	// Supervisor handoff 工具可见性
	if (!agentGraph || Object.keys(agentGraph.nodes).length < 2) {
		const before = finalTools.length;
		finalTools = finalTools.filter(t => t.name !== TRANSFER_TO_AGENT_TOOL);
		if (before !== finalTools.length) {
			deps.logService.info(`[AgentOS] _getEnabledTools: handoff tool filtered out -> ${finalTools.length}/${before} tools`);
		}
	}

	const result = finalTools.map(({ enabled: _, toolset: __, ...toolDef }) => toolDef);
	const PRIORITY_NAMES = new Set([
		'search_graph', 'query_graph', 'get_architecture', 'trace_path',
		'search_code', 'get_code_snippet', 'index_repository', 'index_status',
		'detect_changes', 'update_plan',
		'tool_search', 'tool_describe', 'tool_call',
	]);
	result.sort((a, b) => {
		const aPri = PRIORITY_NAMES.has(a.name) ? 0 : 1;
		const bPri = PRIORITY_NAMES.has(b.name) ? 0 : 1;
		return aPri - bPri || a.name.localeCompare(b.name);
	});

	deps.cachedToolDefs.set(cacheKey, result);
	deps.logService.info(`[AgentOS] _getEnabledTools: cache miss — computed ${result.length} tools (gen=${deps.registryGeneration}, ctxWin=${contextWindow ?? '?'})`);
	return applyHardPermission(result, hardPermission);
}
