/**
 * 记忆「检索」：按需取全文（memory expand）与条目匹配的边界。
 * 单跑：node --test tests/memory-recall-edges.test.js
 *
 * progressive-disclosure.test.js 覆盖了 expand 的两条主路径，但没有钉住
 * 「未知 id / 非 key 轨 / 缺 cwd / 旧条目 legacy id」这些漏召回与越权边界，
 * 以及展示文本 ↔ 磁盘原文的匹配规则。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import {
  MemoryStore, projectHash, serializeEntries, parseEntryBranches, normalizeForMatch,
} from '../lib/store.js'
import { legacyIdFor } from '../lib/sync/entryid.js'
import { setLocale } from '../lib/i18n.js'

setLocale('zh')

function fakeCtx() {
  const state = { tools: [], contexts: [], commands: [], listeners: [], routes: [] }
  const services = {
    tools: { register: (def) => { state.tools.push(def); return () => {} }, get: () => undefined },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    webServer: { register: (route) => { state.routes.push(route); return () => {} } },
  }
  const ctx = {
    state,
    tools: services.tools, systemPrompt: services.systemPrompt,
    commands: services.commands, webServer: services.webServer,
    on: (name, fn) => { (state.listeners[name] ||= []).push(fn); return () => {} },
    inject: (deps, cb) => (deps.every((d) => services[d] !== undefined) ? { dispose: cb(ctx) ?? (() => {}) } : { dispose: () => {} }),
    effect: (fn) => fn() ?? (() => {}),
    get: (key) => services[key] ?? (key === 'settings' ? { get: (ns) => (ns === 'locale' ? { preference: 'zh' } : undefined) } : undefined),
    logger: { warn() {}, info() {}, error() {} },
  }
  return ctx
}

const WITH_ID = '[id:abc12345] [summary:一句话] 关键事实 ABC'
const NO_ID = '无 ID 的旧条目 DEF'

function withTool(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-recall-'))
  try {
    const cwd = '/proj/recall'
    const keyPath = join(dir, 'projects', projectHash(cwd), 'KEY.md')
    mkdirSync(dirname(keyPath), { recursive: true })
    writeFileSync(keyPath, serializeEntries([WITH_ID, NO_ID]), 'utf8')

    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    assert.ok(tool, 'memory 工具应已注册')
    const exec = {
      agent: { id: 'a1', session: { header: { cwd } } },
      callId: 'c1', signal: new AbortController().signal,
    }
    return fn({ dir, tool, exec, cwd })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('expand：按 [id:] 取回全文，且剥离 [id:] / [summary:] 元数据', async () => withTool(async ({ tool, exec }) => {
  const out = await tool.execute({ action: 'expand', target: 'key', id: 'abc12345' }, exec)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.entries.length, 1)
  assert.match(out.entries[0], /关键事实 ABC/)
  assert.ok(!out.entries[0].includes('[id:'), '全文不该带身份证')
  assert.ok(!out.entries[0].includes('[summary:'), '全文不该带摘要标记')
}))

test('expand：无 [id:] 的旧条目可用 legacyIdFor 兜底召回', async () => withTool(async ({ tool, exec }) => {
  const legacy = legacyIdFor(NO_ID)
  assert.ok(typeof legacy === 'string' && legacy.length > 0)
  const out = await tool.execute({ action: 'expand', target: 'key', id: legacy }, exec)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.match(out.entries[0], /无 ID 的旧条目 DEF/)
}))

test('expand：未知 id 返回失败而不是编造内容', async () => withTool(async ({ tool, exec }) => {
  const out = await tool.execute({ action: 'expand', target: 'key', id: 'not-exist' }, exec)
  assert.equal(out.ok, false)
  assert.equal(out.entries, undefined)
}))

test('expand：非 key 轨 / 缺 id / 缺 cwd 都被拒绝', async () => withTool(async ({ tool, exec }) => {
  const bad = [
    { action: 'expand', target: 'memory', id: 'abc12345' },
    { action: 'expand', target: 'key' },
  ]
  for (const args of bad) {
    const out = await tool.execute(args, exec)
    assert.equal(out.ok, false, JSON.stringify(args))
  }
  const noCwd = await tool.execute(
    { action: 'expand', target: 'key', id: 'abc12345' },
    { ...exec, agent: { id: 'a1', session: { header: {} } } },
  )
  assert.equal(noCwd.ok, false, '没有 cwd 时不该跨项目召回')
}))

test('parseEntryBranches：无标记视为「全部」，带标记解析成列表', () => {
  assert.equal(parseEntryBranches('无标记的事实'), null)
  const scoped = parseEntryBranches('[branch:main,dev] 事实')
  assert.ok(Array.isArray(scoped), '带标记应返回数组')
  assert.ok(scoped.includes('main') && scoped.includes('dev'))
})

test('normalizeForMatch：剥离 [id:]/[summary:] 且幂等（精确操作的前提）', () => {
  const cleaned = normalizeForMatch(WITH_ID)
  assert.ok(!cleaned.includes('[id:'), '展示层剥掉身份证后仍能命中磁盘原文')
  assert.ok(!cleaned.includes('[summary:'))
  assert.match(cleaned, /关键事实 ABC/, '正文必须保留')
  assert.equal(normalizeForMatch(cleaned), cleaned, '归一化应幂等')
  assert.equal(normalizeForMatch(NO_ID), NO_ID, '无元数据的条目不受影响')
  assert.notEqual(cleaned, normalizeForMatch(NO_ID), '不同条目不该被误判为同一条')
})

test('buildMemoryFiles 之外的读取：MemoryStore.query 能按 limit 截断不丢顺序', async () => withTool(async ({ dir, cwd }) => {
  const store = new MemoryStore(dir)
  const agent = { session: { header: { cwd } } }
  const rows = store.query('key', agent, { limit: 1 })
  assert.equal(rows.length, 1)
  assert.match(rows[0].entry ?? rows[0].text ?? String(rows[0]), /关键事实 ABC|无 ID 的旧条目/)
}))
