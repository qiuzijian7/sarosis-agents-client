/**
 * Dreaming P1 — cron 接线契约（可选订阅 scheduler 的 onFire）。
 * 单跑：node --test tests/dream-schedule.test.js
 *
 * 自建 vssarosScheduler 与官方 schedule 服务隔离。
 * Cordis inject 回调接收 Context，effect 的订阅随注入 fiber 生命周期释放。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachDreamSchedule, shouldRunDream } from '../lib/dream/schedule.js'

function fakeCtx(svc, official = undefined) {
  const calls = []
  let callback = null
  let names = []
  let effects = []
  let disposed = false
  let disposeCalls = 0
  const release = () => {
    for (const off of effects.splice(0).reverse()) off()
  }
  const activate = () => {
    if (disposed || !names.every((name) => name === 'vssarosScheduler' && svc)) return
    callback({
      vssarosScheduler: svc,
      schedule: official,
      effect: (fn) => { const off = fn(); if (typeof off === 'function') effects.push(off) },
    })
  }
  return {
    calls,
    get disposeCalls() { return disposeCalls },
    setService(value) { release(); svc = value; activate() },
    inject: (deps, cb) => {
      calls.push(deps)
      names = deps
      callback = cb
      activate()
      return { dispose() { if (disposed) return; disposed = true; disposeCalls++; release() } }
    },
  }
}

function fakeService() {
  let listener = null
  let offCalls = 0
  return {
    onFire: (cb) => { listener = cb; return () => { offCalls++; if (listener === cb) listener = null } },
    emit: (payload) => listener?.(payload),
    get listener() { return listener },
    get offCalls() { return offCalls },
  }
}

const ACTION_TASK = { kind: 'action', action: { service: 'memory-evolve', method: 'dream.run', args: {} } }

test('shouldRunDream：只认 action + dream.run + 开关打开', () => {
  assert.equal(shouldRunDream(ACTION_TASK, { dreamEnabled: true }), true)
  assert.equal(shouldRunDream(ACTION_TASK, { dreamEnabled: false }), false)
  assert.equal(shouldRunDream(ACTION_TASK, {}), false)
  assert.equal(shouldRunDream({ kind: 'prompt' }, { dreamEnabled: true }), false)
  assert.equal(shouldRunDream({ kind: 'action', action: { method: 'other.run' } }, { dreamEnabled: true }), false)
  assert.equal(shouldRunDream(null, { dreamEnabled: true }), false)
})

test('无 vssarosScheduler / 无 onFire ⇒ 安全降级，仍可释放注入 fiber', () => {
  for (const svc of [null, undefined, {}, { onFire: 'not-a-function' }]) {
    const ctx = fakeCtx(svc)
    const dispose = attachDreamSchedule({ ctx, getRuntime: () => ({ dreamEnabled: true }), run: () => {} })
    assert.deepEqual(ctx.calls, [['vssarosScheduler']])
    assert.equal(typeof dispose, 'function')
    dispose()
    assert.equal(ctx.disposeCalls, 1)
  }
})

test('任务到点且开关打开 ⇒ 触发一轮 run（fire-and-forget，异常只记日志）', () => {
  const svc = fakeService()
  const ctx = fakeCtx(svc)
  const runs = []
  const logs = []
  attachDreamSchedule({
    ctx, getRuntime: () => ({ dreamEnabled: true }),
    run: (payload) => { runs.push(payload); return Promise.resolve() },
    log: (msg) => logs.push(msg),
  })
  svc.emit({ task: ACTION_TASK, atMs: 1 })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].source, 'schedule')
  assert.equal(logs.length, 0)
})

test('开关关闭 / 非目标任务 ⇒ 不触发 run', () => {
  const svc = fakeService()
  let runs = 0
  attachDreamSchedule({ ctx: fakeCtx(svc), getRuntime: () => ({ dreamEnabled: false }), run: () => { runs++ } })
  svc.emit({ task: ACTION_TASK })
  assert.equal(runs, 0)
  svc.emit({ task: { kind: 'prompt' } })
  assert.equal(runs, 0)
})

test('run 抛错只记日志，不让一个任务的异常停掉整个调度引擎', () => {
  const svc = fakeService()
  const logs = []
  attachDreamSchedule({
    ctx: fakeCtx(svc), getRuntime: () => ({ dreamEnabled: true }),
    run: () => Promise.reject(new Error('boom')),
    log: (msg) => logs.push(msg),
  })
  svc.emit({ task: ACTION_TASK })
  return Promise.resolve().then(() => {
    assert.equal(logs.length, 1)
    assert.match(logs[0], /boom/)
  })
})

test('disposer 会释放 onFire 订阅（engine.onFire 返回的 off 被调用）', () => {
  const svc = fakeService()
  const ctx = fakeCtx(svc)
  const dispose = attachDreamSchedule({ ctx, getRuntime: () => ({ dreamEnabled: true }), run: () => {} })
  assert.equal(typeof dispose, 'function')
  dispose()
  dispose()
  assert.equal(svc.offCalls, 1)
  assert.equal(ctx.disposeCalls, 1)
  assert.equal(svc.listener, null)
})

test('官方 schedule 永不订阅；自建服务晚到、替换、移除均随 scope effect 生命周期', () => {
  const official = fakeService()
  const ctx = fakeCtx(null, official)
  const runs = []
  let enabled = true
  const dispose = attachDreamSchedule({ ctx, getRuntime: () => ({ dreamEnabled: enabled }), run: (payload) => runs.push(payload) })
  assert.equal(official.listener, null)
  const first = fakeService()
  ctx.setService(first)
  first.emit({ task: ACTION_TASK })
  assert.equal(runs.length, 1)
  enabled = false
  first.emit({ task: ACTION_TASK })
  assert.equal(runs.length, 1)
  const second = fakeService()
  ctx.setService(second)
  assert.equal(first.offCalls, 1)
  first.emit({ task: ACTION_TASK })
  enabled = true
  second.emit({ task: ACTION_TASK })
  assert.equal(runs.length, 2)
  ctx.setService(null)
  assert.equal(second.offCalls, 1)
  dispose()
  ctx.setService(fakeService())
  assert.equal(official.listener, null)
  assert.equal(runs.length, 2)
})

test('同步 run 异常只记日志，后续触发继续执行', () => {
  const svc = fakeService()
  const logs = []
  let calls = 0
  attachDreamSchedule({ ctx: fakeCtx(svc), getRuntime: () => ({ dreamEnabled: true }), run: () => { calls++; throw new Error('sync boom') }, log: (message) => logs.push(message) })
  svc.emit({ task: ACTION_TASK })
  svc.emit({ task: ACTION_TASK })
  assert.equal(calls, 2)
  assert.equal(logs.length, 2)
  assert.match(logs[0], /sync boom/)
})
