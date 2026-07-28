/*---------------------------------------------------------------------------------------------
 *  MiMo 范式策略（mimo）— 任务门控 ReAct（对齐 MiMo-Code task/gate.ts）
 *
 *  = Hermes budgeted-react 的全部能力（预算门控 / 委托记账 / 强制委托提醒 /
 *    beforeTerminate 的 TaskGate 主会话门控，现均已上移到 HermesReActStrategy
 *    基类，本类直接继承，保证 mimo 与 budgeted-react 在此维度行为一致）。
 *
 *  行为要点（来自基类继承的 beforeTerminate）：
 *  结束前查任务板真相 —— 当前会话（含其子 agent）名下仍有非终态任务时，
 *  注入 <system-reminder> 重入提醒继续迭代，重入上限
 *  MAX_TASK_GATE_MAIN_REACT(3)（与 MiMo-Code 主会话 cap 一致）；任务板未接线 /
 *  查询失败 → 失败开放（退化为 Hermes 行为，绝不困住 loop）。
 *
 *  本类仅作为「mimo」范式的具名标识存在（paradigm='mimo'），便于
 *  switch_paradigm 与产品侧区分；若未来 mimo 需要额外扩展点，在此 override。
 *--------------------------------------------------------------------------------------------*/

import { HermesReActStrategy } from './hermesReActStrategy.js';

export class MiMoStrategy extends HermesReActStrategy {
	override readonly paradigm = 'mimo' as const;
}
