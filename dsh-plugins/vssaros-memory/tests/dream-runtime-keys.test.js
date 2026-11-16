/**
 * Dreaming P0 — 插件内装配契约。
 * 单跑：node --test tests/dream-runtime-keys.test.js
 *
 * P1：dreamEnabled 仍是静态默认关闭，但已成对加入 RUNTIME_KEYS +
 * validateRuntimePatch，可在设置页运行时开关；不改 MemoryQueueView.tsx /
 * lib/client.js（它们是另一套待确认建议面板，与本键无关）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig, RUNTIME_KEYS, validateRuntimePatch } from '../lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('静态默认值：dreamEnabled 缺省 false', () => {
  assert.equal(resolveConfig({}).dreamEnabled, false)
})

test('静态类型校验：布尔值可配，字符串直接抛错', () => {
  assert.equal(resolveConfig({ dreamEnabled: true }).dreamEnabled, true)
  assert.throws(() => resolveConfig({ dreamEnabled: 'yes' }), /布尔|boolean/i)
})

test('cordis.patch.yml 里带同一份默认值（产品默认不放在 profile 覆盖层）', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /^\s+dreamEnabled:\s*false\s*$/m)
  assert.match(patch, /id:\s*vssaros-memory/, '身份链不许被改动')
})

test('P1 运行时键：dreamEnabled 可写且只允许布尔', () => {
  assert.ok(RUNTIME_KEYS.includes('dreamEnabled'))
  assert.doesNotThrow(() => validateRuntimePatch('dreamEnabled', true))
  assert.doesNotThrow(() => validateRuntimePatch('dreamEnabled', false))
  assert.throws(() => validateRuntimePatch('dreamEnabled', 'yes'), /布尔/)
})

test('插件内模块已落盘：零新增插件，全部在 lib/dream 与 lib/transcript 下', () => {
  for (const file of [
    'lib/dream/index.js', 'lib/dream/state.js', 'lib/dream/proposal.js',
    'lib/dream/orchestrator.js',
    'lib/transcript/decode.js', 'lib/transcript/redact.js',
    'lib/transcript/render.js', 'lib/transcript/export.js',
  ]) {
    assert.equal(existsSync(join(ROOT, file)), true, `缺 ${file}`)
  }
})

test('package.json 已 bump（改非入口文件不 bump 会被发布守卫拦下）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@vssaros/dsh-memory')
  assert.notEqual(pkg.version, '1.0.15', '必须 bump 版本，否则已装 profile 不会更新')
  assert.ok(pkg.files.includes('lib/'), '新增 lib 子目录必须被 files 白名单覆盖')
})
