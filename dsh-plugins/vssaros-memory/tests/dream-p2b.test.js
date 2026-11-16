/**
 * Dreaming P2-b — 有界并发 / wiki 索引 / 成本与保真评测。
 * 单跑：node --test tests/dream-p2b.test.js
 *
 * 官方 Cookbook：analyzer 分组并行但要有上限（约 8）、末尾 organizer 一次；
 * `dream/_index.md` 是**只按需检索**的目录，默认绝不注入 system prompt。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mapWithConcurrency } from '../lib/dream/concurrency.js'
import { slugOf, buildIndex, parseIndex, writeIndex } from '../lib/dream/index-md.js'
import { estimateRunCost, fidelityOf, evaluateRun } from '../lib/dream/eval.js'
import { runDream } from '../lib/dream/orchestrator.js'
import { createDreamController } from '../lib/dream/index.js'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function withTmp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dream-p2b-'))
  try { return await fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('mapWithConcurrency：结果按输入顺序返回，并发峰值不超过上限', async () => {
  let inFlight = 0
  let peak = 0
  const items = Array.from({ length: 12 }, (_, i) => i)
  const out = await mapWithConcurrency(items, 3, async (i) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setImmediate(resolve))
    inFlight--
    return i * 2
  })
  assert.deepEqual(out, items.map((i) => i * 2))
  assert.ok(peak <= 3, `峰值 ${peak} 超过上限 3`)
  assert.ok(peak >= 2, '没有真正并行')
})

test('mapWithConcurrency：非法上限回落到 8，空数组返回空', async () => {
  for (const bad of [0, -1, 1.5, 'x', NaN, null]) {
    const out = await mapWithConcurrency([1, 2, 3], bad, async (x) => x)
    assert.deepEqual(out, [1, 2, 3])
  }
  assert.deepEqual(await mapWithConcurrency([], 3, async (x) => x), [])
})

test('slugOf：ASCII 安全、可往返、有长度上限', () => {
  const slug = slugOf('Run 2026/11-12 预览')
  assert.match(slug, /^[a-z0-9][a-z0-9-]*$/)
  assert.ok(slug.length <= 64)
  assert.equal(slugOf(''), 'untitled')
  assert.equal(slugOf('!!!'), 'untitled')
})

test('buildIndex / parseIndex：frontmatter + [[slug]] 目录，可往返且不注入', () => {
  const text = buildIndex({
    at: '2026-11-12T01:00:00Z',
    entries: [
      { slug: 'run-1', title: '预览 · 提案 3 · ok' },
      { slug: 'run-2', title: '定时 · 提案 0 · ok' },
    ],
  })
  assert.match(text, /^---\n/)
  assert.match(text, /inject:\s*false/)
  assert.match(text, /entries:\s*2/)
  assert.match(text, /\[\[run-1\]\]/)
  assert.match(text, /只按需检索|不注入/)
  assert.deepEqual(parseIndex(text), [
    { slug: 'run-1', title: '预览 · 提案 3 · ok' },
    { slug: 'run-2', title: '定时 · 提案 0 · ok' },
  ])
  assert.deepEqual(parseIndex('随便一段文字'), [])
})

test('writeIndex：只写 <memoryDir>/dream/_index.md，六轨文件 mtime 与内容不变', async () => withTmp(async (root) => {
  const memoryDir = join(root, 'memories')
  mkdirSync(memoryDir, { recursive: true })
  const tracks = ['MEMORY.md', 'USER.md', 'KEY.md'].map((n) => join(memoryDir, n))
  for (const f of tracks) writeFileSync(f, `原始 ${f}\n`, 'utf8')
  const before = tracks.map((f) => [statSync(f).mtimeMs, readFileSync(f, 'utf8')])

  const out = await writeIndex({
    memoryDir, at: '2026-11-12T01:00:00Z',
    entries: [{ slug: 'run-1', title: '预览' }],
  })
  assert.equal(out.count, 1)
  assert.equal(existsSync(join(memoryDir, 'dream', '_index.md')), true)
  assert.match(readFileSync(out.path, 'utf8'), /\[\[run-1\]\]/)
  for (let i = 0; i < tracks.length; i++) {
    assert.equal(statSync(tracks[i]).mtimeMs, before[i][0])
    assert.equal(readFileSync(tracks[i], 'utf8'), before[i][1])
  }
}))

test('索引模块源码里没有 systemPrompt.context（不把索引灌进 system prompt）', () => {
  const src = readFileSync(join(PLUGIN_ROOT, 'lib', 'dream', 'index-md.js'), 'utf8')
  assert.ok(!src.includes('systemPrompt.context'))
  assert.ok(!src.includes('renderSnapshot'))
})

test('estimateRunCost：分组与轮次估算一致，空集合为 0', () => {
  const q = estimateRunCost(Array.from({ length: 11 }, (_, i) => ({ name: `s${i}.txt` })), { groupSize: 5 })
  assert.equal(q.files, 11)
  assert.equal(q.groups, 3)
  assert.equal(q.tokens, 11 * 1000 + 3 * 3000)
  assert.equal(q.turns, 11 + 3 * 2)
  assert.deepEqual(estimateRunCost([]), { files: 0, groups: 0, tokens: 0, turns: 0 })
})

test('fidelityOf：全保留 1.0、丢一条按比例下降、空 before 视为 1.0', () => {
  assert.equal(fidelityOf(['A', 'B'], ['A', 'B', 'C']).rate, 1)
  const partial = fidelityOf(['事实 A', '事实 B', '事实 C'], ['事实 A', '事实 C'])
  assert.equal(partial.preserved, 2)
  assert.equal(partial.total, 3)
  assert.ok(Math.abs(partial.rate - 2 / 3) < 1e-9)
  assert.equal(partial.ok, false)
  assert.deepEqual(partial.missing, ['事实 B'])
  assert.equal(fidelityOf([], []).rate, 1)
})

test('evaluateRun：把计数、成本、保真率汇总成一份评测', () => {
  const manifest = { ok: true, expected: 3, processed: 3, budget: { tokens: 6000 } }
  const out = evaluateRun({ manifest, factsBefore: ['A', 'B'], factsAfter: ['A', 'B'] })
  assert.equal(out.ok, true)
  assert.equal(out.complete, true)
  assert.equal(out.fidelity, 1)
  assert.equal(out.tokens, 6000)
  const bad = evaluateRun({ manifest: { ...manifest, ok: false, processed: 2 }, factsBefore: ['A'], factsAfter: [] })
  assert.equal(bad.ok, false)
  assert.equal(bad.complete, false)
  assert.equal(bad.fidelity, 0)
})

test('runDream：有界并发生效、manifest 记录上限、成功轮带 quality', async () => withTmp(async (root) => {
  const files = Array.from({ length: 11 }, (_, i) => ({ name: `s${i}.txt`, path: `/tmp/s${i}.txt` }))
  let inFlight = 0
  let peak = 0
  const out = await runDream({
    files, outDir: root, stateFile: join(root, 'state.json'),
    groupSize: 5, concurrency: 3,
    analyze: async (file) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setImmediate(r))
      inFlight--
      return { file: file.name, proposals: [] }
    },
    organize: async () => ({ proposals: [], changes: [], factsBefore: ['A', 'B'], factsAfter: ['A', 'B'] }),
    refute: async (ps) => ({ verdicts: ps.map(() => ({ keep: true })) }),
  })
  assert.equal(out.ok, true, out.reason)
  assert.equal(out.manifest.processed, 11)
  assert.ok(peak <= 3, `并发峰值 ${peak} > 3`)
  assert.equal(out.manifest.concurrency, 3)
  assert.equal(out.manifest.quality.fidelity, 1)
  assert.equal(out.manifest.quality.complete, true)
}))

test('控制器：成功轮写 dream/_index.md，且不注入（不碰六轨）', async () => withTmp(async (root) => {
  const memoryDir = join(root, 'memories')
  const ctrl = createDreamController({ memoryDir, dshHome: root, getLlm: () => null })
  const out = await ctrl.run({})
  assert.equal(out.ok, true, out.reason)
  const file = join(memoryDir, 'dream', '_index.md')
  assert.equal(existsSync(file), true)
  assert.match(readFileSync(file, 'utf8'), /inject:\s*false/)
  assert.equal(out.manifest.applied, 0)
}))
