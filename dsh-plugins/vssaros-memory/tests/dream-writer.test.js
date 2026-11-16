/**
 * Dreaming P1 — 受控写入（writer）契约。
 * 单跑：node --test tests/dream-writer.test.js
 *
 * 硬纪律：所有写入只经 MemoryStore 的公开方法（add / replace / removeExact /
 * write），禁止直接改 .md；默认 dry-run；同轨串行 withLock；写前快照 +
 * 写后读回；事实不守恒就回滚；注入四轨做实质变化去重（保护前缀缓存）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyProposals, INJECTED_TARGETS } from '../lib/dream/writer.js'

const EVIDENCE = { file: 'transcripts/07.txt', at: 12 }

/** 内存版 MemoryStore 假件：记录调用顺序，行为与真实 store 同形。 */
function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, [...v]]))
  const calls = []
  const ensure = (t) => { if (!data.has(t)) data.set(t, []); return data.get(t) }
  return {
    calls,
    data,
    locate: (target) => ({ dir: `/tmp/${target}`, file: `/tmp/${target}/MEMORY.md` }),
    entriesOf: (target) => [...ensure(target)],
    add: (target, content) => { ensure(target).push(`[stamped] ${content}`); calls.push(['add', target]); return { ok: true } },
    replace: (target, match, content) => {
      const rows = ensure(target)
      const idx = rows.findIndex((r) => r.includes(match))
      calls.push(['replace', target])
      if (idx < 0) return { ok: false, reason: 'noMatch' }
      rows[idx] = `[stamped] ${content}`
      return { ok: true }
    },
    removeExact: (target, entry) => {
      const rows = ensure(target)
      const idx = rows.indexOf(entry)
      calls.push(['removeExact', target])
      if (idx < 0) return { ok: false }
      rows.splice(idx, 1)
      return { ok: true, removed: entry }
    },
    peekExact: (target, entry) => ({ ok: true, entry: ensure(target).find((r) => r.includes(entry)) ?? null }),
    write: (target, entries) => { data.set(target, [...entries]); calls.push(['write', target]) },
  }
}

function proposal(op, overrides = {}) {
  return { op, target: 'daily', content: '新事实', evidence: EVIDENCE, source: 'dream', ...overrides }
}

function withTmp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dream-writer-'))
  try { return fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('注入四轨集合：memory / user / key / bot（daily / project 不受限）', () => {
  assert.deepEqual([...INJECTED_TARGETS].sort(), ['bot', 'key', 'memory', 'user'])
})

test('默认 dry-run：apply 未显式为 true 时零写入，只出预览', () => withTmp((root) => {
  const store = fakeStore({ daily: ['已有条目'] })
  const result = applyProposals({
    proposals: [proposal('add')], store, agent: {}, runDir: join(root, 'run'),
  })
  assert.equal(result.ok, true)
  assert.equal(result.applied, 0)
  assert.equal(result.dryRun, true)
  assert.deepEqual(store.calls, [], 'dry-run 不许调用任何写方法')
  assert.equal(store.data.get('daily').length, 1)
  assert.equal(result.preview.length, 1)
}))

test('apply=true 才落盘：add 走 store.add，写前快照与写后读回都发生', () => withTmp((root) => {
  const store = fakeStore({ daily: ['已有条目'] })
  const runDir = join(root, 'run')
  const result = applyProposals({
    proposals: [proposal('add')], store, agent: {}, runDir, apply: true,
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.applied, 1)
  assert.equal(result.dryRun, false)
  assert.deepEqual(store.calls, [['add', 'daily']])
  assert.equal(store.data.get('daily').length, 2)
  assert.equal(existsSync(join(runDir, 'snapshot', 'daily.json')), true, '写前快照必须落盘')
  assert.equal(JSON.parse(readFileSync(join(runDir, 'snapshot', 'daily.json'), 'utf8')).before.length, 1)
  assert.equal(result.changes.length, 1)
}))

test('同轨串行：同一 target 的多条提案按序执行，不并发', () => withTmp((root) => {
  const store = fakeStore({ daily: [] })
  const result = applyProposals({
    proposals: [proposal('add', { content: 'A' }), proposal('add', { content: 'B' })],
    store, agent: {}, runDir: join(root, 'run'), apply: true,
  })
  assert.equal(result.applied, 2)
  assert.deepEqual(store.calls, [['add', 'daily'], ['add', 'daily']])
  assert.ok(store.data.get('daily')[0].includes('A'))
  assert.ok(store.data.get('daily')[1].includes('B'))
}))

test('replace 必须携带完整新全文；缺 match 的提案被跳过且不中断整批', () => withTmp((root) => {
  const store = fakeStore({ daily: ['旧说法'] })
  const result = applyProposals({
    proposals: [
      proposal('replace', { match: '旧说法', content: '新全文（含旧值对照）' }),
      { op: 'replace', target: 'daily', content: '缺 match', evidence: EVIDENCE },
    ],
    store, agent: {}, runDir: join(root, 'run'), apply: true,
  })
  assert.equal(result.applied, 1)
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0].reason, /match|校验/)
  assert.ok(store.data.get('daily')[0].includes('新全文'))
}))

test('archive 优先：归档类提案走 peekExact → removeExact，绝不调用 remove/delete', () => withTmp((root) => {
  const store = fakeStore({ memory: ['重复条目'] })
  const archived = []
  const archive = { append: (target, content) => { archived.push([target, content]); return { ok: true } } }
  const result = applyProposals({
    proposals: [proposal('archive', { target: 'memory', match: '重复条目' })],
    store, archive, agent: {}, runDir: join(root, 'run'), apply: true,
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.applied, 1)
  assert.equal(archived.length, 1, '原文必须先归档，保证可移回')
  assert.ok(store.calls.every(([fn]) => fn !== 'remove' && fn !== 'delete'))
  assert.ok(store.calls.some(([fn]) => fn === 'removeExact'))
}))

test('注入四轨实质变化去重：内容已存在则跳过，不制造无谓的快照变更', () => withTmp((root) => {
  const store = fakeStore({ memory: ['[stamped] 已有事实'] })
  const result = applyProposals({
    proposals: [proposal('add', { target: 'memory', content: '已有事实' })],
    store, agent: {}, runDir: join(root, 'run'), apply: true,
  })
  assert.equal(result.applied, 0, '重复内容不许写入会进 system prompt 的轨')
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0].reason, /去重|已存在/)
  assert.deepEqual(store.calls, [])
}))

test('daily / project 不注入 ⇒ 允许重复写入（不做去重）', () => withTmp((root) => {
  const store = fakeStore({ daily: ['[stamped] 已有事实'] })
  const result = applyProposals({
    proposals: [proposal('add', { content: '已有事实' })],
    store, agent: {}, runDir: join(root, 'run'), apply: true,
  })
  assert.equal(result.applied, 1)
}))

test('事实不守恒 ⇒ 回滚到写前快照，整批判失败', () => withTmp((root) => {
  const store = fakeStore({ memory: ['事实 A', '事实 B'] })
  const realReplace = store.replace
  // 模拟一次写坏了的实现：除被替换条目外，连无关的事实 B 也被吞掉。
  store.replace = (target, match, content, agent) => {
    const outcome = realReplace(target, match, content, agent)
    store.data.set(target, ['[stamped] 完全不同的新文'])
    return outcome
  }
  const result = applyProposals({
    proposals: [proposal('replace', { target: 'memory', match: '事实 A', content: '完全不同的新文' })],
    store, agent: {}, runDir: join(root, 'run'), apply: true,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'conservation-failed')
  assert.deepEqual(store.data.get('memory'), ['事实 A', '事实 B'], '必须回滚')
  assert.ok(store.calls.some(([fn]) => fn === 'write'), '回滚走 store.write 快照')
}))

test('写后读回不含新内容 ⇒ 回滚并判失败', () => withTmp((root) => {
  const store = fakeStore({ daily: [] })
  store.add = () => ({ ok: true }) // 假件故意写丢
  const result = applyProposals({
    proposals: [proposal('add')], store, agent: {}, runDir: join(root, 'run'), apply: true,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'readback-failed')
  assert.deepEqual(store.data.get('daily'), [])
}))

test('非法 target / 未登记 op 被拦下，不落盘', () => withTmp((root) => {
  const store = fakeStore({})
  const result = applyProposals({
    proposals: [
      proposal('add', { target: 'system-prompt' }),
      { op: 'remove', target: 'daily', content: 'x', evidence: EVIDENCE },
    ],
    store, agent: {}, runDir: join(root, 'run'), apply: true,
  })
  assert.equal(result.applied, 0)
  assert.equal(result.skipped.length, 2)
  assert.deepEqual(store.calls, [])
}))

test('快照可回滚：返回 before 镜像，调用方可自行恢复', () => withTmp((root) => {
  const store = fakeStore({ daily: ['原始 A', '原始 B'] })
  const result = applyProposals({
    proposals: [proposal('add')], store, agent: {}, runDir: join(root, 'run'), apply: true,
  })
  assert.equal(result.ok, true)
  const snap = JSON.parse(readFileSync(join(root, 'run', 'snapshot', 'daily.json'), 'utf8'))
  assert.deepEqual(snap.before, ['原始 A', '原始 B'])
}))
