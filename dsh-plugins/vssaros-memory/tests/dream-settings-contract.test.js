/**
 * Dreaming P1-UI 前置 —— 设置页键的服务端契约。
 * 单跑：node --test tests/dream-settings-contract.test.js
 *
 * 纪律：设置面板里出现的每个键都必须真的被服务端消费（不谎报可写范围）。
 * 对 chat-surface 的 Dreaming 分组做**只读跨插件契约校验**：组内每个键
 * 都必须在服务端 RUNTIME_KEYS 且默认值能过 validateRuntimePatch，防止
 * 设置页出现「看得见但保存必 400」的假开关。分组未落地时跳过、不阻塞。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dreamOptionsOf, createDreamController } from '../lib/dream/index.js'
import { DEFAULTS, RUNTIME_KEYS, resolveConfig, validateRuntimePatch } from '../lib/index.js'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHAT_SURFACE_CHUNK = join(PLUGIN_ROOT, '..', 'vssaros-chat-surface', 'lib', 'client.conversationViews.js')
const DREAM_KEYS = ['dreamEnabled', 'dreamApprovalMode', 'dreamGroupSize', 'dreamMaxFiles']

function withTmp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dream-settings-'))
  try { return fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('DEFAULTS 里四个 Dream 键都有产品默认值（默认关 / 仅报告 / 20 / 500）', () => {
  assert.equal(DEFAULTS.dreamEnabled, false)
  assert.equal(DEFAULTS.dreamApprovalMode, 'report')
  assert.equal(DEFAULTS.dreamGroupSize, 20)
  assert.equal(DEFAULTS.dreamMaxFiles, 500)
  assert.equal(resolveConfig({}).dreamApprovalMode, 'report')
})

test('四个 Dream 键成对进入 RUNTIME_KEYS 与 validateRuntimePatch', () => {
  for (const key of DREAM_KEYS) assert.ok(RUNTIME_KEYS.includes(key), `${key} 不在 RUNTIME_KEYS`)
  assert.doesNotThrow(() => validateRuntimePatch('dreamEnabled', true))
  assert.doesNotThrow(() => validateRuntimePatch('dreamApprovalMode', 'approved'))
  assert.doesNotThrow(() => validateRuntimePatch('dreamGroupSize', 10))
  assert.doesNotThrow(() => validateRuntimePatch('dreamMaxFiles', 100))
})

test('静态配置也校验新键（防损坏 state / 手写 patch 绕过运行时校验）', () => {
  assert.throws(() => resolveConfig({ dreamApprovalMode: 'auto-apply' }), /dreamApprovalMode/)
  assert.throws(() => resolveConfig({ dreamGroupSize: 0 }), /dreamGroupSize/)
  assert.throws(() => resolveConfig({ dreamMaxFiles: 1.5 }), /dreamMaxFiles/)
})

test('运行时校验拒绝非法值：枚举 / 非整数 / 越界', () => {
  assert.throws(() => validateRuntimePatch('dreamApprovalMode', 'auto'), /report/)
  assert.throws(() => validateRuntimePatch('dreamGroupSize', 0), /整数/)
  assert.throws(() => validateRuntimePatch('dreamGroupSize', 51), /整数|1\.\.50/)
  assert.throws(() => validateRuntimePatch('dreamGroupSize', 1.5), /整数/)
  assert.throws(() => validateRuntimePatch('dreamMaxFiles', 501), /整数|1\.\.500/)
})

test('dreamOptionsOf：空运行时回落到产品默认', () => {
  assert.deepEqual(dreamOptionsOf(), { groupSize: 20, maxFiles: 500, approvalMode: 'report' })
  assert.deepEqual(dreamOptionsOf(null), { groupSize: 20, maxFiles: 500, approvalMode: 'report' })
})

test('dreamOptionsOf：运行时值生效，非法/越界一律夹回合法区间', () => {
  const ok = dreamOptionsOf({ dreamGroupSize: 8, dreamMaxFiles: 120, dreamApprovalMode: 'approved' })
  assert.equal(ok.groupSize, 8)
  assert.equal(ok.maxFiles, 120)
  assert.equal(ok.approvalMode, 'approved')
  assert.equal(dreamOptionsOf({ dreamGroupSize: 999 }).groupSize, 50)
  assert.equal(dreamOptionsOf({ dreamGroupSize: -1 }).groupSize, 20)
  assert.equal(dreamOptionsOf({ dreamMaxFiles: 'x' }).maxFiles, 500)
  assert.equal(dreamOptionsOf({ dreamApprovalMode: 'auto' }).approvalMode, 'report')
})

test('dreamOptionsOf：调用方覆盖值同样受夹取约束', () => {
  assert.equal(dreamOptionsOf({}, { groupSize: 999 }).groupSize, 50)
  assert.equal(dreamOptionsOf({}, { maxFiles: 0 }).maxFiles, 500)
  assert.equal(dreamOptionsOf({}, { groupSize: 3 }).groupSize, 3)
})

test('仅报告模式下 apply=true 被拒绝，且不写任何文件（默认安全）', () => withTmp((root) => {
  const memoryDir = join(root, 'memories')
  const ctrl = createDreamController({
    memoryDir, dshHome: root,
    store: { entriesOf: () => [] },
    getRuntime: () => ({ dreamApprovalMode: 'report' }),
  })
  const result = ctrl.applyRun({ runId: 'run-x', apply: true })
  return Promise.resolve(result).then((out) => {
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'approval-mode-report')
    assert.equal(existsSync(join(memoryDir, 'dream', 'runs', 'run-x', 'apply-result.json')), false)
  })
}))

test('审批模式为 approved 时才进入真正的 apply 流程', () => withTmp((root) => {
  const ctrl = createDreamController({
    memoryDir: join(root, 'memories'), dshHome: root,
    store: { entriesOf: () => [] },
    getRuntime: () => ({ dreamApprovalMode: 'approved' }),
  })
  // 没有 proposals.json ⇒ 应报「没有可审批的提案」，而不是 approval-mode-report
  return ctrl.applyRun({ runId: 'run-y', apply: true }).then(
    () => assert.fail('应当因缺提案而拒绝'),
    (error) => assert.ok(!String(error.message).includes('approval-mode-report')),
  )
}))

/** 只读探测：只取 dreaming 组的 fields 块，别把后面 React 的 key:"t" 之类算进来。 */
const chunk = existsSync(CHAT_SURFACE_CHUNK) ? readFileSync(CHAT_SURFACE_CHUNK, 'utf8') : ''
const groupMatch = chunk.match(/id:\s*"dreaming"[\s\S]*?fields:\s*\[([\s\S]*?)\n\s*\]\s*\n\s*\},/)
const groupText = groupMatch?.[1] ?? ''
const groupKeys = [...groupText.matchAll(/key:\s*"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1])

test('跨插件契约：设置页 dreaming 分组的每个键都在服务端可写',
  groupMatch ? {} : { skip: 'chat-surface 尚未出现 dreaming 分组，落地后本用例自动启用' },
  () => {
    assert.ok(groupKeys.length > 0, 'dreaming 组里没有任何键')
    for (const key of groupKeys) {
      assert.ok(RUNTIME_KEYS.includes(key), `设置页显示了 ${key} 但服务端 RUNTIME_KEYS 没有它（保存必 400）`)
      assert.doesNotThrow(() => validateRuntimePatch(key, DEFAULTS[key]), `设置页显示了 ${key} 但 validateRuntimePatch 拒收默认值`)
    }
    assert.ok(groupKeys.includes('dreamEnabled'), '分组缺少总开关')
  })
