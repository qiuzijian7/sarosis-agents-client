/*---------------------------------------------------------------------------------------------
 *  会话任务门桥接（Session TaskGate Bridge）
 *
 *  为策略层（MiMoStrategy.beforeTerminate）提供查询"当前会话未完成任务"的通道。
 *  IAgentOSService 不直接暴露任务板服务，因此采用与 unifiedSubAgentDispatch
 *  `_taskLookup` 相同的注入模式：taskOrchestrationService（任务板持有者）在
 *  构造时注册 lookup，策略在执行时查询。未注册/查询失败 → undefined/异常，
 *  调用方失败开放（退化为无门控行为，绝不困住 agent loop）。
 *--------------------------------------------------------------------------------------------*/

import type { IIncompleteTask } from '../common/taskGate.js';

/** 会话任务查询：返回该会话（含其子 agent）名下所有非终态任务。 */
export type SessionTaskLookup = (ownerAgentId: string) => Promise<readonly IIncompleteTask[]>;

let _lookup: SessionTaskLookup | undefined;

/** 注册会话任务查询（taskOrchestrationService 构造时调用；传 undefined 显式清除，测试用）。 */
export function registerSessionTaskLookup(lookup: SessionTaskLookup | undefined): void {
	_lookup = lookup;
}

/** 获取会话任务查询（未注册返回 undefined —— 调用方按失败开放处理）。 */
export function getSessionTaskLookup(): SessionTaskLookup | undefined {
	return _lookup;
}
