/**
 * Dreaming 端到端集成测试：真正 `apply()` 装配插件 → 捕获 /memory-evolve
 * prefix handler → 用假 req/res 走完「配置 → 任务规格 → 预览 → 运行历史 →
 * 提案 → 审批闸」整条链路。
 *
 * 之前每个模块都有单测，但没有一次证明它们**接得起来**：deps 是否传全、
 * RUNTIME_KEYS 是否真的回显、审批闸是否按运行时值生效、成功轮是否写索引。
 * 单跑：node --test tests/dream-integration.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, RUNTIME_KEYS } from '../lib/index.js'

const DREAM_KEYS = [
  'dreamEnabled', 'dreamApprovalMode', 'dreamGroupSize', 'dreamMaxFiles', 'dreamRefuterModel',
]

/** 精简版 plugin.test.js 的 fakeCtx：inject 回调会执行，effect 立即执行。 */
function fakeCtx(overrides = {}) {
  const state = { tools: [], contexts: [], commands: [], listeners: [], routes: [] }
  const services = {
    tools: { register: (def) => { state.tools.push(def); return () => {} }, get: () => undefined },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    webServer: { register: (route) => { state.routes.push(route); return () => {} } },
    ...(overrides.services ?? {}),
  }
  const ctx = {
    state,
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    commands: services.commands,
    webServer: services.webServer,
    on: (name, fn) => { (state.listeners[name] ||= []).push(fn); return () => {} },
    inject: (deps, cb) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      // 与真实 cordis 的 fakeCtx 一致：把 ctx 自己当注入后的作用域传进去。
      const disposer = cb(ctx)
      return { dispose: typeof disposer === 'function' ? disposer : () => {} }
    },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get: (key) => services[key] ?? (key === 'settings'
      ? { get: (ns) => (ns === 'locale' ? { preference: 'zh' } : undefined) }
      : undefined),
    logger: { warn() {}, info() {}, error() {} },
  }
  return Object.assign(ctx, overrides)
}

/** 与 bookmarks.test.js 同形：req 必须是 AsyncIterable，res 只需 writeHead/end。 */
async function call(handler, method, url, body) {
  const res = {
    status: 0, headers: null, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(text) { this.body = text },
  }
  const req = {
    method, url, headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  await handler(req, res)
  return { status: res.status, json: () => JSON.parse(res.body) }
}

async function withHarness(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dream-integration-'))
  try {
    const memoryDir = join(root, 'memories')
    const ctx = fakeCtx()
    // 没有 llm 服务 ⇒ Dream 应回落到 P0 保守实现；没有 schedule 服务 ⇒ cron 安全降级。
    apply(ctx, { memoryDir })
    const route = ctx.state.routes.find((r) => r.kind === 'prefix' && r.path === '/memory-evolve')
    assert.ok(route, 'apply() 后必须注册 /memory-evolve 前缀路由')
    assert.equal(typeof route.handler, 'function')
    return await fn({ root, memoryDir, handler: route.handler, ctx })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('5 个 Dream 键都在 RUNTIME_KEYS 里，且 GET /api/config 如实回显默认值', async () => withHarness(async ({ handler }) => {
  for (const key of DREAM_KEYS) assert.ok(RUNTIME_KEYS.includes(key), `${key} 漏了`)
  const res = await call(handler, 'GET', '/memory-evolve/api/config')
  assert.equal(res.status, 200)
  const cfg = res.json().config
  assert.equal(cfg.dreamEnabled, false)
  assert.equal(cfg.dreamApprovalMode, 'report')
  assert.equal(cfg.dreamGroupSize, 20)
  assert.equal(cfg.dreamMaxFiles, 500)
  assert.equal(cfg.dreamRefuterModel, null)
  assert.ok(!('memoryDir' in cfg), '静态键不该混进面板 config')
}))

test('POST /api/config 写 Dream 键后持久化，非法值返回 400', async () => withHarness(async ({ handler }) => {
  const patch = {
    dreamEnabled: true, dreamGroupSize: 3, dreamMaxFiles: 2, dreamRefuterModel: 'haiku',
  }
  const saved = await call(handler, 'POST', '/memory-evolve/api/config', { patch })
  assert.equal(saved.status, 200, saved.json().error ?? '')
  for (const [key, value] of Object.entries(patch)) assert.equal(saved.json().config[key], value)

  const again = await call(handler, 'GET', '/memory-evolve/api/config')
  assert.equal(again.json().config.dreamGroupSize, 3, '运行时值应被回显（持久化到 stateFile）')
  assert.equal(again.json().config.dreamRefuterModel, 'haiku')

  const bad = await call(handler, 'POST', '/memory-evolve/api/config', { patch: { dreamApprovalMode: 'auto-apply' } })
  assert.equal(bad.status, 400)
  assert.match(bad.json().error, /dreamApprovalMode/)
}))

test('只读端点：任务规格 / 运行历史 / 提案（缺 runId 返回 400）', async () => withHarness(async ({ handler }) => {
  const spec = await call(handler, 'GET', '/memory-evolve/api/dream/task-spec')
  assert.equal(spec.status, 200)
  assert.equal(spec.json().task.action.method, 'dream.run')
  assert.equal(spec.json().task.kind, 'action')

  const runs = await call(handler, 'GET', '/memory-evolve/api/dream/runs')
  assert.equal(runs.status, 200)
  assert.deepEqual(runs.json().runs, [])

  const missing = await call(handler, 'GET', '/memory-evolve/api/dream/proposals')
  assert.equal(missing.status, 400)
}))

test('完整链路：运行时参数生效 → 预览不写六轨 → runs 有 quality → 索引落盘', async () => withHarness(async ({ handler, memoryDir }) => {
  await call(handler, 'POST', '/memory-evolve/api/config', {
    patch: { dreamEnabled: true, dreamGroupSize: 3, dreamMaxFiles: 2 },
  })

  const run = await call(handler, 'POST', '/memory-evolve/api/dream/run', {})
  assert.equal(run.status, 200, JSON.stringify(run.json().reason))
  const body = run.json()
  assert.equal(body.ok, true)
  assert.equal(body.roles, false, 'llm 缺席必须回落保守实现')
  assert.equal(body.manifest.applied, 0, '预览永远不写记忆')
  assert.equal(body.manifest.concurrency, 8)
  assert.equal(body.options.groupSize, 3, '分组大小必须读运行时值，而不是请求体')
  assert.equal(body.manifest.quality.complete, true)
  assert.equal(body.manifest.quality.fidelity, 1)

  const runs = await call(handler, 'GET', '/memory-evolve/api/dream/runs')
  assert.equal(runs.json().runs.length, 1)
  assert.equal(runs.json().runs[0].runId, body.runId)

  const props = await call(handler, 'GET', `/memory-evolve/api/dream/proposals?runId=${body.runId}`)
  assert.equal(props.status, 200)
  assert.deepEqual(props.json().proposals, [], '保守实现不编造提案')

  const indexFile = join(memoryDir, 'dream', '_index.md')
  assert.equal(existsSync(indexFile), true, '成功轮必须写按需检索索引')
  assert.match(readFileSync(indexFile, 'utf8'), /inject: false/)
}))

test('审批闸：report 模式拒绝 apply；改成 approved 后才放行，且仍是 dry-run 优先', async () => withHarness(async ({ handler }) => {
  await call(handler, 'POST', '/memory-evolve/api/config', { patch: { dreamEnabled: true } })
  const run = await call(handler, 'POST', '/memory-evolve/api/dream/run', {})
  const runId = run.json().runId

  const blocked = await call(handler, 'POST', '/memory-evolve/api/dream/apply', { runId, apply: true })
  assert.equal(blocked.status, 422)
  assert.equal(blocked.json().reason, 'approval-mode-report')
  assert.equal(blocked.json().applied, 0)

  const dry = await call(handler, 'POST', '/memory-evolve/api/dream/apply', { runId, apply: false })
  assert.equal(dry.status, 200)
  assert.equal(dry.json().dryRun, true)

  await call(handler, 'POST', '/memory-evolve/api/config', { patch: { dreamApprovalMode: 'approved' } })
  const allowed = await call(handler, 'POST', '/memory-evolve/api/dream/apply', { runId, apply: true })
  assert.equal(allowed.status, 200, JSON.stringify(allowed.json()))
  assert.equal(allowed.json().applied, 0, '空提案集不会凭空写入')
}))

test('未匹配路由返回 404，URL 前缀必须是 /memory-evolve', async () => withHarness(async ({ handler }) => {
  const res = await call(handler, 'GET', '/memory-evolve/api/dream/not-exist')
  assert.equal(res.status, 404)
  assert.equal(res.json().error, 'not found')
}))
