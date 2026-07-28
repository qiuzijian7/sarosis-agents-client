/*---------------------------------------------------------------------------------------------
 *  计划队列注册表 —— 方案1（工具驱动的队列注册）的接线层。
 *
 *  解决的问题：agent loop 的串行计划队列（agentTurnExecutor 的 planTasks +
 *  无工具调用轮自动推进）原先只有 preLoop 一个生产者；preLoop 禁用后队列空转。
 *  本模块让 LLM 在 turn 进行中通过 plan_register 工具把有序任务列表写入
 *  当前 turn 的执行队列，打通「调研 → 拆任务 → 依次执行」流程：
 *
 *    agentTurnExecutor（turn 开始）          plan_register 工具（turn 进行中）
 *      registerPlanQueueHandle(agentId, ──────▶ getPlanQueueHandle(agentId)
 *        { setPlan })                            handle.setPlan(tasks)
 *      ◀────── 闭包直接改写 turn 局部 planTasks/currentTaskIdx
 *
 *  生命周期：handle 在 turn 开始时注册、turn 结束（finally）时注销，
 *  因此工具只能写入"当前正在执行的 turn"的队列，不会泄漏到下一个 turn。
 *--------------------------------------------------------------------------------------------*/

import type { ParsedPlanTask } from './workMode.js';

/**
 * 当前 turn 计划队列的操作句柄（由 agentTurnExecutor 以闭包实现）。
 */
export interface IPlanQueueHandle {
	/** 替换本 turn 的执行队列并从第 0 个任务重新开始。 */
	setPlan(tasks: readonly ParsedPlanTask[]): void;
	/** 当前队列快照（供工具结果回显/日志）。 */
	getPlan(): { readonly tasks: readonly ParsedPlanTask[]; readonly currentIndex: number };
}

const _handles = new Map<string, IPlanQueueHandle>();

/**
 * 注册某 agent 当前 turn 的计划队列句柄。
 * 返回注销函数（幂等；仅当句柄仍是自己时才移除，避免误删后注册者）。
 */
export function registerPlanQueueHandle(agentId: string, handle: IPlanQueueHandle): () => void {
	_handles.set(agentId, handle);
	return () => {
		if (_handles.get(agentId) === handle) {
			_handles.delete(agentId);
		}
	};
}

/** 查询某 agent 当前 turn 的计划队列句柄（无活动 turn 时返回 undefined）。 */
export function getPlanQueueHandle(agentId: string): IPlanQueueHandle | undefined {
	return _handles.get(agentId);
}
