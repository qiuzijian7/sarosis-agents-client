/**
 * vssaros-memory/dream — P1 cron 接线（可选订阅 scheduler）。
 *
 * 自建 `vssarosScheduler` 的 `onFire(cb)` 返回 disposer；与官方 schedule 隔离。
 * 注入回调接收 Context，订阅随 scope.effect 生命周期释放；服务缺席安全降级。
 *
 * 只认 `kind:'action'` 且 `action.method === 'dream.run'` 的任务；
 * 现有 attachDelivery() 明确跳过非 prompt 型（L209-211），两者职责不重叠。
 * 开关每次触发时读运行时值，因此不需要 applyRuntimePatch 里的 sync 联动。
 *
 * @module vssaros-memory/dream/schedule
 */

/** 是否应因这个任务触发一轮 Dream（纯函数）。 */
export function shouldRunDream(task, runtime) {
  if (!task || task.kind !== 'action') return false
  if (task?.action?.method !== 'dream.run') return false
  return runtime?.dreamEnabled === true
}

/**
 * 可选订阅 vssarosScheduler 的 onFire。返回注入 fiber 的 disposer；无有效 ctx 时返回 null。
 * @param {{ctx:object, getRuntime:Function, run:Function, log?:Function}} options
 */
export function attachDreamSchedule({ ctx, getRuntime, run, log = () => {} } = {}) {
  if (!ctx || typeof ctx.inject !== 'function' || typeof run !== 'function') return null
  const fiber = ctx.inject(['vssarosScheduler'], (scope) => {
    const svc = scope.vssarosScheduler
    if (typeof svc?.onFire !== 'function') return
    scope.effect(() => svc.onFire((payload) => {
      const task = payload?.task
      const runtime = typeof getRuntime === 'function' ? getRuntime() : (getRuntime ?? {})
      if (!shouldRunDream(task, runtime)) return
      try {
        const result = run({ source: 'schedule', task, atMs: payload?.atMs ?? null })
        if (result && typeof result.catch === 'function') {
          result.catch((error) => log(`Dream 定时任务失败：${String(error?.message ?? error)}`))
        }
      } catch (error) {
        // 派发不阻塞：一个任务的异常不能停掉整个调度引擎。
        log(`Dream 定时任务失败：${String(error?.message ?? error)}`)
      }
    }))
  })
  return typeof fiber?.dispose === 'function' ? () => fiber.dispose() : null
}
