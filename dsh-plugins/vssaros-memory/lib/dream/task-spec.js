/**
 * vssaros-memory/dream — scheduler action 任务规格（P2-c，纯函数）。
 *
 * 严格对齐 dsh-plugins/vssaros-scheduler/lib/tools.js 的 RULE_SCHEMA 与
 * `vssaros_schedule_create` 参数：kind ∈ prompt/loop/action，action = {service,method,args}
 * （required: service / method），daily 规则带 `time`。
 *
 * ⚠ 只**返回规格**，绝不替用户创建任务：scheduler 的任务是运行时数据，
 * 由使用者在自己的 profile 里显式创建；本插件不写别人的数据目录。
 * `attachDreamSchedule()` 的 onFire 只认 action.method === 'dream.run'，
 * 且每次触发都读运行时 `dreamEnabled`，所以任务存在 ≠ 自动运行。
 *
 * @module vssaros-memory/dream/task-spec
 */

export const DREAM_TASK_TITLE = 'Dream · 夜间记忆整理'
export const DREAM_TASK_TIME = '01:00'

/** 生成可直接交给 `vssaros_schedule_create` 的任务对象。 */
export function dreamTaskSpec({ title = DREAM_TASK_TITLE, time = DREAM_TASK_TIME } = {}) {
  return {
    title: String(title),
    kind: 'action',
    rule: { kind: 'daily', time: String(time) },
    action: { service: 'memory-evolve', method: 'dream.run', args: {} },
  }
}

/** 形状自检：给 API / 测试 / 守卫用，坏规格一律判不合法。 */
export function validateDreamTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    return { ok: false, reason: '任务不是对象' }
  }
  if (task.kind !== 'action') return { ok: false, reason: 'kind 必须是 action' }
  if (!task.rule || task.rule.kind !== 'daily' || !/^\d{2}:\d{2}$/.test(String(task.rule.time ?? ''))) {
    return { ok: false, reason: 'daily 规则必须带 HH:MM 的 time' }
  }
  if (!task.action || task.action.method !== 'dream.run'
    || typeof task.action.service !== 'string' || task.action.service.length === 0) {
    return { ok: false, reason: 'action 必须带 service 与 method=dream.run' }
  }
  if (!task.action.args || typeof task.action.args !== 'object' || Array.isArray(task.action.args)) {
    return { ok: false, reason: 'action.args 必须是对象' }
  }
  if ('prompt' in task) return { ok: false, reason: 'action 型任务不该带 prompt' }
  return { ok: true }
}
