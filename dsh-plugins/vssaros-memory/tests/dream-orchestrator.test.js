/**
 * Dreaming P0 — 编排器：分组、计数校验、refuter 缺席零写入、守恒、预算、只读。
 * 单跑：node --test tests/dream-orchestrator.test.js
 *
 * P0 是 report-only：无论走哪个分支，都绝不写记忆六轨、不调用 writer。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDream } from '../lib/dream/orchestrator.js'
import { readState } from '../lib/dream/state.js'

const EVIDENCE = { file: 'transcripts/01.txt', at: 12 }

async function withTmp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dream-orch-'))
  try { return await fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

function filesOf(n) {
  return Array.from({ length: n }, (_, i) => ({ name: `s${i}.txt`, path: `/tmp/s${i}.txt`, size: 100 }))
}

function base(root, overrides = {}) {
  const memoryDir = join(root, 'memories')
  const outDir = join(root, 'dream')
  const stateFile = join(outDir, 'state.json')
  return {
    memoryDir, outDir, stateFile,
    files: filesOf(11),
    groupSize: 5,
    analyze: async (file) => ({ file: file.name, proposals: [], summary: 'ok' }),
    organize: async () => ({
      proposals: [{ op: 'add', target: 'daily', content: '新事实', evidence: EVIDENCE }],
      changes: ['合并 1 组'],
      factsBefore: ['旧事实'], factsAfter: ['旧事实', '新事实'],
    }),
    refute: async (proposals) => ({ verdicts: proposals.map(() => ({ keep: true, reason: '有证据' })) }),
    ...overrides,
  }
}

/** 造六轨文件，返回快照函数。 */
function seedMemory(memoryDir) {
  mkdirSync(memoryDir, { recursive: true })
  const targets = ['MEMORY.md', 'USER.md', 'KEY.md', 'daily.md'].map((n) => join(memoryDir, n))
  for (const file of targets) writeFileSync(file, `原始 ${file}\n`)
  return () => targets.map((f) => [statSync(f).mtimeMs, readFileSync(f, 'utf8')])
}

test('正常一轮：分组、计数、organizer 一次、refuter 复核、manifest 落盘', async () => withTmp(async (root) => {
  const opts = base(root)
  let organizeCalls = 0
  const groups = []
  opts.analyze = async (file) => { groups.push(file.name); return { file: file.name, proposals: [], summary: 'ok' } }
  opts.organize = async (results) => {
    organizeCalls++
    return {
      proposals: [{ op: 'add', target: 'daily', content: '新事实', evidence: EVIDENCE }],
      changes: [], factsBefore: [], factsAfter: [], analyzed: results.length,
    }
  }
  const result = await runDream(opts)
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.manifest.expected, 11)
  assert.equal(result.manifest.processed, 11)
  assert.deepEqual(result.manifest.failures, [])
  assert.equal(result.manifest.organized, true)
  assert.equal(result.manifest.refuted, 1)
  assert.equal(result.manifest.applied, 0, 'P0 永远是 report-only')
  assert.equal(organizeCalls, 1, 'organizer 只跑一次')
  assert.equal(groups.length, 11)
  assert.ok(groups.every((n) => typeof n === 'string'))
  const runDir = join(root, 'dream', 'runs', result.runId)
  assert.ok(JSON.parse(readFileSync(join(runDir, 'proposals.json'), 'utf8')).length === 1)
  assert.match(readFileSync(join(runDir, 'report.md'), 'utf8'), /11 \/ 11/)
  assert.equal(readState(opts.stateFile).last_run !== null, true, '成功才推进窗口')
}))

test('任一转录没被分析 ⇒ 整轮失败、无提案、窗口不推进', async () => withTmp(async (root) => {
  const opts = base(root)
  opts.analyze = async (file) => {
    if (file.name === 's3.txt') throw new Error('解码失败')
    return { file: file.name, proposals: [], summary: 'ok' }
  }
  let organizeCalls = 0
  opts.organize = async () => { organizeCalls++; return { proposals: [], changes: [], factsBefore: [], factsAfter: [] } }
  const result = await runDream(opts)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'incomplete')
  assert.equal(result.manifest.processed, 10)
  assert.equal(result.manifest.failures.length, 1)
  assert.equal(result.manifest.organized, false, '计数不全不许进整理阶段')
  assert.equal(organizeCalls, 0)
  assert.deepEqual(result.proposals, [], '失败轮的提案必须为空，不能留半批')
  assert.equal(readState(opts.stateFile).last_run, null)
}))

test('refuter 缺席 / 抛错 / 解析不出 ⇒ 零写入（对齐 cookbook-brain）', async () => withTmp(async (root) => {
  for (const refute of [
    async () => null,
    async () => { throw new Error('refuter 挂了') },
    async (proposals) => ({ verdicts: proposals.map(() => ({ keep: undefined })) }),
  ]) {
    const dir = join(root, String(Math.random()).slice(2))
    const opts = base(root, { outDir: dir, stateFile: join(dir, 'state.json'), refute })
    const result = await runDream(opts)
    assert.equal(result.ok, false, 'refuter 不可用必须判失败')
    assert.equal(result.reason, 'refuter-absent')
    assert.deepEqual(result.proposals, [])
    assert.equal(result.manifest.applied, 0)
    assert.equal(readState(opts.stateFile).last_run, null)
  }
}))

test('守恒校验不通过 ⇒ 整轮失败', async () => withTmp(async (root) => {
  const opts = base(root)
  opts.organize = async () => ({
    proposals: [{ op: 'add', target: 'daily', content: '新事实', evidence: EVIDENCE }],
    changes: [], factsBefore: ['旧事实 A', '旧事实 B'], factsAfter: ['旧事实 A'],
  })
  const result = await runDream(opts)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'conservation-failed')
  assert.deepEqual(result.manifest.missing, ['旧事实 B'])
}))

test('预算超限 ⇒ 估算先行、不部分写入、不调用 analyzer', async () => withTmp(async (root) => {
  const opts = base(root)
  let calls = 0
  opts.analyze = async () => { calls++; return { proposals: [] } }
  const result = await runDream({ ...opts, budget: { maxTokens: 10 }, estimate: () => ({ tokens: 999999 }) })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'budget-exceeded')
  assert.equal(calls, 0)
  assert.equal(readState(opts.stateFile).last_run, null)
}))

test('skip-if-running：state.running=true 时直接拒绝，不产出任何 run 目录', async () => withTmp(async (root) => {
  const opts = base(root)
  const { beginRun } = await import('../lib/dream/state.js')
  beginRun(opts.stateFile, { at: '2026-11-12T01:00:00Z' })
  const result = await runDream(opts)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'already-running')
  assert.equal(result.runId, null)
}))

test('P0 只读：成功轮与失败轮都不改六轨记忆文件', async () => withTmp(async (root) => {
  const opts = base(root)
  const snapshot = seedMemory(opts.memoryDir)
  const before = snapshot()
  await runDream(opts)
  const afterFailure = await runDream({ ...opts, outDir: join(root, 'dream2'), stateFile: join(root, 'dream2', 'state.json'), analyze: async () => { throw new Error('x') } })
  assert.equal(afterFailure.ok, false)
  const targets = ['MEMORY.md', 'USER.md', 'KEY.md', 'daily.md'].map((n) => join(opts.memoryDir, n))
  for (let i = 0; i < targets.length; i++) {
    assert.equal(statSync(targets[i]).mtimeMs, before[i][0], 'report-only 不许改记忆文件 mtime')
    assert.equal(readFileSync(targets[i], 'utf8'), before[i][1])
  }
}))

test('提案未通过 refuter 的不进 proposals.json', async () => withTmp(async (root) => {
  const opts = base(root)
  opts.organize = async () => ({
    proposals: [
      { op: 'add', target: 'daily', content: '保留', evidence: EVIDENCE },
      { op: 'add', target: 'daily', content: '丢弃', evidence: EVIDENCE },
    ],
    changes: [], factsBefore: [], factsAfter: [],
  })
  opts.refute = async (proposals) => ({ verdicts: proposals.map((p) => ({ keep: p.content === '保留', reason: 'x' })) })
  const result = await runDream(opts)
  assert.equal(result.ok, true)
  assert.equal(result.proposals.length, 1)
  assert.equal(result.manifest.refuted, 1)
  const saved = JSON.parse(readFileSync(join(root, 'dream', 'runs', result.runId, 'proposals.json'), 'utf8'))
  assert.deepEqual(saved.map((p) => p.content), ['保留'])
}))
