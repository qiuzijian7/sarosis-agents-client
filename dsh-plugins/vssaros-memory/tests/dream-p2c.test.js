/**
 * Dreaming P2-c — refuter 独立小模型 + scheduler 任务规格。
 * 单跑：node --test tests/dream-p2c.test.js
 *
 * 官方 cookbook 用 Haiku 跑 analyzer、独立 refuter 复核；本仓不新增静态
 * inject，只把模型名做成可空运行时键，roles.js 为 refuter 单独建 callModel。
 * scheduler 规格必须严格对齐 vssaros-scheduler 的 RULE_SCHEMA / action 字段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, RUNTIME_KEYS, resolveConfig, validateRuntimePatch } from '../lib/index.js'
import { createLlmRoles } from '../lib/dream/roles.js'
import { dreamTaskSpec, validateDreamTask } from '../lib/dream/task-spec.js'
import { shouldRunDream } from '../lib/dream/schedule.js'
import { createDreamController } from '../lib/dream/index.js'

async function withTmp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dream-p2c-'))
  try { return await fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

/** 记录每次 llm.stream 的 options；回复一份三角色都能解析的通用 JSON。 */
function recordingLlm(seen) {
  const reply = JSON.stringify({
    proposals: [], verdicts: [], changes: [],
    factsBefore: [], factsAfter: [], summary: '',
  })
  return {
    stream: async function* (options) {
      seen.push(options)
      yield { type: 'text-delta', text: reply }
      yield { type: 'finish' }
    },
  }
}

test('DEFAULTS / RUNTIME_KEYS：dreamRefuterModel 默认 null（继承会话模型）', () => {
  assert.equal(DEFAULTS.dreamRefuterModel, null)
  assert.equal(resolveConfig({}).dreamRefuterModel, null)
  assert.ok(RUNTIME_KEYS.includes('dreamRefuterModel'))
})

test('运行时与静态校验：null 或非空字符串，拒绝空串/数字/超长', () => {
  assert.doesNotThrow(() => validateRuntimePatch('dreamRefuterModel', null))
  assert.doesNotThrow(() => validateRuntimePatch('dreamRefuterModel', 'haiku'))
  assert.throws(() => validateRuntimePatch('dreamRefuterModel', ''), /字符串|null/)
  assert.throws(() => validateRuntimePatch('dreamRefuterModel', 3), /字符串|null/)
  assert.throws(() => validateRuntimePatch('dreamRefuterModel', 'x'.repeat(200)), /超长/)
  assert.throws(() => resolveConfig({ dreamRefuterModel: 3 }), /dreamRefuterModel/)
})

test('createLlmRoles：refuterModel 只作用于 refuter，analyzer/organizer 仍继承', async () => {
  const seen = []
  const roles = createLlmRoles({
    llm: recordingLlm(seen), refuterModel: 'haiku',
    readFile: async () => 'USER:\n查一下测试命令',
  })
  assert.ok(roles)
  await roles.analyze({ name: 's0.txt', path: '/tmp/s0.txt' }).catch(() => {})
  await roles.organize([])
  await roles.refute([])
  assert.equal(seen.length, 3, '三个角色各调一次模型')
  assert.equal(seen[0].model, undefined)
  assert.equal(seen[1].model, undefined)
  assert.equal(seen[2].model, 'haiku', '只有 refuter 换模型')
})

test('createLlmRoles：不传 refuterModel 时三个角色同模型', async () => {
  const seen = []
  const roles = createLlmRoles({ llm: recordingLlm(seen) })
  await roles.organize([])
  await roles.refute([])
  assert.ok(seen.every((o) => o.model === undefined))
})

test('dreamTaskSpec：对齐 scheduler 的 action 任务与 RULE_SCHEMA', () => {
  const task = dreamTaskSpec()
  assert.equal(task.kind, 'action')
  assert.equal(task.rule.kind, 'daily')
  assert.equal(task.rule.time, '01:00')
  assert.equal(task.action.method, 'dream.run')
  assert.ok(typeof task.action.service === 'string' && task.action.service.length > 0)
  assert.ok(task.action.args && typeof task.action.args === 'object')
  assert.ok(!('prompt' in task), 'action 型任务不该带 prompt')
  assert.equal(validateDreamTask(task).ok, true)
})

test('任务规格能被 shouldRunDream 识别，且受总开关约束', () => {
  const task = dreamTaskSpec()
  assert.equal(shouldRunDream(task, { dreamEnabled: true }), true)
  assert.equal(shouldRunDream(task, { dreamEnabled: false }), false)
})

test('validateDreamTask：拒绝缺 method / kind 不对 / 规则缺时间', () => {
  const bad = [
    { ...dreamTaskSpec(), action: { service: 'x' } },
    { ...dreamTaskSpec(), kind: 'prompt' },
    { ...dreamTaskSpec(), rule: { kind: 'daily' } },
    null,
  ]
  for (const task of bad) assert.equal(validateDreamTask(task).ok, false)
})

test('自定义时间与标题仍保持规格合法', () => {
  const task = dreamTaskSpec({ title: '每周整理', time: '03:30' })
  assert.equal(task.title, '每周整理')
  assert.equal(task.rule.time, '03:30')
  assert.equal(validateDreamTask(task).ok, true)
})

test('端到端：控制器把运行时 refuterModel 传到 LLM 调用', async () => withTmp(async (root) => {
  const seen = []
  const ctrl = createDreamController({
    memoryDir: join(root, 'memories'), dshHome: root,
    getRuntime: () => ({ dreamRefuterModel: 'haiku' }),
    getLlm: () => recordingLlm(seen),
  })
  const out = await ctrl.run({})
  assert.equal(out.ok, true, out.reason)
  assert.equal(out.roles, true, '本轮应走 LLM 角色')
  assert.ok(seen.some((o) => o.model === 'haiku'), 'refuter 应收到独立模型名')
  assert.equal(out.manifest.applied, 0)
}))
