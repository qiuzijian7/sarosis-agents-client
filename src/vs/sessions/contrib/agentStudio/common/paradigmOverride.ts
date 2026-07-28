/*---------------------------------------------------------------------------------------------
 *  范式运行时切换注册表（paradigm override）
 *
 *  提供 per-agent 的范式覆盖层：switch_paradigm 工具写入覆盖，主循环每次
 *  resolve 策略与注入策略提示词时优先读取覆盖值。覆盖在 **turn 边界**生效
 *  （策略实例与预算本就 per-turn 创建，无中间态），实现运行期热切换：
 *
 *    switch_paradigm({ paradigm: 'mimo' })
 *      → setParadigmOverride(agentId, 'mimo')
 *      → 下一 turn：factory.resolve(request, override ?? request.paradigm)
 *      → getStrategyGuidance(override ?? agent.paradigm)（提示词同步切换）
 *
 *  与 planQueueRegistry 同构（module 级注册表，common 层，browser 双侧可导入）。
 *--------------------------------------------------------------------------------------------*/

import type { AgentParadigm } from './agentLoopStrategy.js';

/** 可被切换工具接受的范式集合（排除 graph —— 图执行走独立路由，不适合热切换）。 */
export const SWITCHABLE_PARADIGMS: readonly AgentParadigm[] = [
	'budgeted-react',
	'mimo',
	'react',
	'plan-explore',
	'readonly',
	'delegation',
];

const _overrides = new Map<string, AgentParadigm>();

/** 写入某 agent 的范式覆盖（undefined/空 = 清除覆盖，回落到配置解析链）。 */
export function setParadigmOverride(agentId: string, paradigm: AgentParadigm | undefined): void {
	if (paradigm) {
		_overrides.set(agentId, paradigm);
	} else {
		_overrides.delete(agentId);
	}
}

/** 读取某 agent 当前的范式覆盖（无覆盖返回 undefined）。 */
export function getParadigmOverride(agentId: string): AgentParadigm | undefined {
	return _overrides.get(agentId);
}

/** 清除某 agent 的范式覆盖。 */
export function clearParadigmOverride(agentId: string): void {
	_overrides.delete(agentId);
}
