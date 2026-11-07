// VsSaros 2026-11-05 S2：Bot 记忆版本历史（bot 轨的 git 历史、对比、回滚、旧历史留档、接口）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLocale } from '../lib/i18n.js'
import { ArchiveStore, MemoryStore, SuggestionQueue } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'
import { installApi } from '../lib/api.js'
import { validateRuntimePatch } from '../lib/index.js'
import { bundleLegacyHistory, createBotHistory, diffEntries, gitAvailable, LEGACY_BUNDLE } from '../lib/bot-history.js'

setLocale('zh')
const skip = !(await gitAvailable())
const tempDir = (tag) => mkdtempSync(join(tmpdir(), `vsm-hist-${tag}-`))
const clean = (dir) => rmSync(dir, { recursive: true, force: true })
const bot = (preset) => ({ session: { header: { agentPreset: preset } } })
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', windowsHide: true })

test('diffEntries：del = 历史版有当前没有（回滚会恢复），add = 当前有历史版没有（回滚会移除）', () => {
  const d = diffEntries('A\n§\nB\n', 'B\n§\nC\n')
  assert.deepEqual(d.rows, [{ type: 'del', text: 'A' }, { type: 'same', text: 'B' }, { type: 'add', text: 'C' }])
  assert.equal(d.removed, 1)
  assert.equal(d.added, 1)
})

test('store 的 onWrite 钩子：每种变更都触发，钩子抛错不影响写入', { skip }, () => {
  const dir = tempDir('hook')
  try {
    const calls = []
    const store = new MemoryStore(dir, { onWrite: (target, path) => { calls.push([target, path]); throw new Error('boom') } })
    assert.ok(store.add('bot', '第一条', bot('vssaros-coder')).ok)
    assert.ok(store.replace('bot', '第一条', '第一条（改）', bot('vssaros-coder')).ok)
    assert.ok(store.remove('bot', '第一条', bot('vssaros-coder')).ok)
    assert.ok(store.add('memory', '全局一条').ok)
    assert.deepEqual(calls.map((c) => c[0]), ['bot', 'bot', 'bot', 'memory'])
    assert.ok(calls[0][1].endsWith(join('bots', 'coder', 'MEMORY.md')))
  } finally { clean(dir) }
})

test('写入后防抖提交：多次写入合成一条，提交说明写出增删条数', { skip }, async () => {
  const dir = tempDir('commit')
  const hist = createBotHistory({ delayMs: 30 })
  try {
    const store = new MemoryStore(dir, { onWrite: (t, p) => { if (t === 'bot') hist.scheduleCommit(join(p, '..')) } })
    const botDir = join(dir, 'bots', 'coder')
    store.add('bot', '用户偏好简短回答', bot('vssaros-coder'))
    store.add('bot', '用户时区 UTC+8', bot('vssaros-coder'))
    let r = await hist.log(botDir)
    assert.equal(r.enabled, true)
    assert.equal(r.log.length, 1, JSON.stringify(r.log))
    assert.match(r.log[0].subject, /^初始版本（2 条）$/)
    assert.match(r.log[0].date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    store.add('bot', '部署前先跑 smoke', bot('vssaros-coder'))
    store.remove('bot', '用户时区', bot('vssaros-coder'))
    await new Promise((res) => setTimeout(res, 120))
    r = await hist.log(botDir)
    assert.equal(r.log.length, 2)
    assert.equal(r.log[0].subject, '更新 Bot 记忆：新增 1 条，删除 1 条')
    assert.ok(readFileSync(join(botDir, '.gitignore'), 'utf8').includes('.memory.lock'))
    const status = git(botDir, 'status', '--porcelain')
    assert.equal(status.trim(), '', '锁文件、临时文件不进历史，工作区干净')
  } finally { hist.dispose(); clean(dir) }
})

test('对比与回滚：回滚前先提交当前状态，回滚本身也能再回滚', { skip }, async () => {
  const dir = tempDir('restore')
  const hist = createBotHistory({ delayMs: 10_000 })
  try {
    const store = new MemoryStore(dir, { onWrite: (t, p) => { if (t === 'bot') hist.scheduleCommit(join(p, '..')) } })
    const botDir = join(dir, 'bots', 'coder')
    store.add('bot', 'A 旧事实', bot('vssaros-coder'))
    const v1 = (await hist.log(botDir)).log[0].hash
    store.replace('bot', 'A 旧事实', 'A 新事实', bot('vssaros-coder'))
    store.add('bot', 'B', bot('vssaros-coder'))
    const cmp = await hist.compare(botDir, v1)
    assert.equal(cmp.diff.removed, 1, '回滚会恢复 1 条')
    assert.equal(cmp.diff.added, 2, '回滚会移除 2 条')
    // compare 会先把待提交改动落成提交 ⇒ 再写一条，让回滚时确有未提交的改动
    store.add('bot', 'C 未提交', bot('vssaros-coder'))
    const out = await hist.restore(botDir, v1)
    assert.equal(out.ok, true)
    assert.ok(out.before, '回滚前的未提交改动先落了一条提交')
    const entries = store.entriesOf('bot', bot('vssaros-coder'))
    assert.equal(entries.length, 1)
    assert.match(entries[0], /A 旧事实$/)
    const log = (await hist.log(botDir)).log
    assert.deepEqual(log.slice(0, 2).map((c) => c.subject), [`回滚到 ${v1}`, '回滚前的状态'])
    const back = await hist.restore(botDir, log[1].hash)
    assert.equal(back.ok, true)
    assert.equal(store.entriesOf('bot', bot('vssaros-coder')).length, 3, '回滚可以再回滚（A 新事实、B、C 都回来）')
    await assert.rejects(hist.compare(botDir, 'not-a-rev'), /版本号不合法/)
    await assert.rejects(hist.restore(botDir, 'abcdef0123'), /读取版本|失败/)
  } finally { hist.dispose(); clean(dir) }
})

test('打包历史：没有提交返回 null，有提交返回可克隆的 bundle', { skip }, async () => {
  const dir = tempDir('bundle')
  const hist = createBotHistory({ delayMs: 10_000 })
  try {
    const botDir = join(dir, 'bots', 'coder')
    assert.equal(await hist.bundle(botDir), null)
    const store = new MemoryStore(dir, { onWrite: (t, p) => { if (t === 'bot') hist.scheduleCommit(join(p, '..')) } })
    store.add('bot', '打包测试', bot('vssaros-coder'))
    const buf = await hist.bundle(botDir)
    assert.ok(Buffer.isBuffer(buf) && buf.length > 0)
    const file = join(dir, 'x.bundle')
    writeFileSync(file, buf)
    git(dir, 'clone', '-q', file, 'clone')
    assert.ok(readFileSync(join(dir, 'clone', 'MEMORY.md'), 'utf8').includes('打包测试'))
  } finally { hist.dispose(); clean(dir) }
})

test('旧 VA 仓库的历史另存为只读 bundle（幂等；没有 git / 没有提交时什么都不做）', { skip }, async () => {
  const dir = tempDir('legacy')
  try {
    const src = join(dir, 'agent-memory', 'coder')
    const dest = join(dir, 'memories', 'bots', 'coder')
    mkdirSync(src, { recursive: true })
    assert.equal(await bundleLegacyHistory(src, dest), 'none', '没有 .git')
    git(src, 'init', '-q')
    assert.equal(await bundleLegacyHistory(src, dest), 'none', '空仓库')
    writeFileSync(join(src, 'MEMORY.md'), '- [2026-10-01] 旧事实\n')
    git(src, 'add', '-A')
    git(src, 'commit', '-q', '-m', 'v1')
    assert.equal(await bundleLegacyHistory(src, dest), 'created')
    assert.ok(existsSync(join(dest, LEGACY_BUNDLE)))
    assert.equal(await bundleLegacyHistory(src, dest), 'exists')
  } finally { clean(dir) }
})

test('接口：列表 / 对比 / 回滚；非 Bot 会话与历史关闭时如实报错', { skip }, async () => {
  const dir = tempDir('api')
  const hist = createBotHistory({ delayMs: 10_000 })
  const sessions = { s_bot: bot('vssaros-coder'), s_plain: bot('standard') }
  const store = new MemoryStore(dir, { onWrite: (t, p) => { if (t === 'bot') hist.scheduleCommit(join(p, '..')) } })
  const boot = async (botHistory) => {
    const ctx = { webServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } } }
    const state = { memoryTabEnabled: true }
    installApi(ctx, {
      store, archive: new ArchiveStore(dir), queue: new SuggestionQueue(join(dir, 'S.jsonl')), todoStore: new TodoStore(dir),
      getRuntime: () => ({ ...state }), updateRuntime: (p) => { for (const [k, v] of Object.entries(p)) validateRuntimePatch(k, v); return state },
      config: { memoryDir: dir, skillDir: join(dir, 'skills') },
      resolveCwd: () => undefined, resolveAgent: (id) => sessions[id], botHistory,
    })
    const server = createServer((req, res) => ctx.handler(req, res))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}`
    const call = async (method, path, body) => {
      const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
      return { status: res.status, data: await res.json().catch(() => ({})) }
    }
    return { call, close: () => new Promise((r) => server.close(r)) }
  }
  const api = await boot(hist)
  try {
    store.add('bot', '接口测试 v1', sessions.s_bot)
    let r = await api.call('GET', '/memory-evolve/api/bot-history?sessionId=s_bot')
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(r.data.bot, 'coder')
    assert.equal(r.data.log.length, 1)
    const v1 = r.data.log[0].hash
    store.add('bot', '接口测试 v2', sessions.s_bot)
    r = await api.call('GET', `/memory-evolve/api/bot-history?sessionId=s_bot&rev=${v1}`)
    assert.equal(r.data.diff.added, 1)
    r = await api.call('POST', '/memory-evolve/api/bot-history', { sessionId: 's_bot', action: 'restore', rev: v1 })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(store.entriesOf('bot', sessions.s_bot).length, 1)
    r = await api.call('GET', '/memory-evolve/api/bot-history?sessionId=s_plain')
    assert.equal(r.status, 400)
    assert.match(r.data.error, /不是 Bot 会话/)
    r = await api.call('POST', '/memory-evolve/api/bot-history', { sessionId: 's_bot', action: 'drop' })
    assert.equal(r.status, 400)
  } finally { await api.close() }
  const off = await boot(createBotHistory({ enabled: false }))
  try {
    const r = await off.call('GET', '/memory-evolve/api/bot-history?sessionId=s_bot')
    assert.equal(r.status, 503)
    assert.equal(r.data.code, 'BOT_HISTORY_DISABLED')
  } finally { await off.close(); hist.dispose(); clean(dir) }
})
