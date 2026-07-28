/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent 配置读取器 — 从 agentStudioService 读取 Agent 级别的 tools/toolsets 配置。
 *
 * 从 agentOSService.ts 抽出 5 个 _getAgent* 方法（~80 行），零 this 状态依赖。
 * 全部通过 getAgentsSync() 查询 Agent 注册数据，纯读取无副作用。
 */

export interface AgentConfigDeps {
	getAgentsSync: () => any[] | undefined;
}

export function getAgentToolsConfig(deps: AgentConfigDeps, agentId?: string): string[] | undefined {
	if (!agentId) { return undefined; }
	try {
		const agents = deps.getAgentsSync();
		if (!agents) { return undefined; }
		const agent = agents.find((a: any) => a.id === agentId);
		return agent?.tools;
	} catch {
		return undefined;
	}
}

export function getAgentEnabledToolsets(deps: AgentConfigDeps, agentId?: string): string[] | undefined {
	if (!agentId) { return undefined; }
	try {
		const agents = deps.getAgentsSync();
		if (!agents) { return undefined; }
		const agent = agents.find((a: any) => a.id === agentId);
		return agent?.enabledToolsets?.length ? agent.enabledToolsets : undefined;
	} catch {
		return undefined;
	}
}

export function getAgentDisabledToolsets(deps: AgentConfigDeps, agentId?: string): string[] | undefined {
	if (!agentId) { return undefined; }
	try {
		const agents = deps.getAgentsSync();
		if (!agents) { return undefined; }
		const agent = agents.find((a: any) => a.id === agentId);
		return agent?.disabledToolsets?.length ? agent.disabledToolsets : undefined;
	} catch {
		return undefined;
	}
}

export function getAgentConfigBool(deps: AgentConfigDeps, agentId: string, field: string): boolean | undefined {
	try {
		const agents = deps.getAgentsSync();
		if (!agents) { return undefined; }
		const agent = agents.find((a: any) => a.id === agentId);
		const val = agent?.[field];
		return typeof val === 'boolean' ? val : undefined;
	} catch { return undefined; }
}

export function shouldEnableUpdatePlan(deps: AgentConfigDeps, agentId?: string): boolean {
	if (agentId) {
		const planFlag = getAgentConfigBool(deps, agentId, 'enableUpdatePlan');
		if (planFlag === false) { return false; }
	}
	return true;
}
