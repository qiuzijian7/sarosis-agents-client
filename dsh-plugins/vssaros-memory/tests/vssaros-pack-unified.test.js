// VsSaros 2026-11-05 S3：Bot 导出 / 导入走统一记忆存储（真实 VM 写入口 + 真实 dsh-agents pack.js）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { setLocale } from '../lib/i18n.js'
import { gitAvailable } from '../lib/bot-history.js'
import { entriesFromMarkdown, exportAgent, importAgent, memoryMarkdownOf, unifiedMemoryOf, MEMORY_HISTORY_NAME } from '../../vssaros-agents/lib/pack.js'
import { zipRead } from '../../vssaros-agents/lib/core/zip.js'

setLocale('zh')
const KEY = Symbol.for('vssaros.memory.store')
const tempDir = (tag) => mkdtempSync(join(tmpdir(), `vsm-pack-${tag}-`))
const clean = (dir) => rmSync(dir, { recursive: true, force: true })

function fakeCtx() {
  const all = {
    tools: { register: () => () => {}, get: () => undefined },
    systemPrompt: { context: () => () => {} },
    commands: { register: () => () => {} },
    webServer: { register: () => () => {} },
  }
  const settings = { get: (ns) => (ns === 'locale' ? { preference: 'zh' } : undefined) }
  const ctx = {
    tools: all.tools, systemPrompt: all.systemPrompt, commands: all.commands, webServer: all.webServer,
    on: () => () => {},
    inject: (deps, cb) => (deps.every((d) => all[d] !== undefined) ? { dispose: cb(ctx) ?? (() => {}) } : { dispose: () => {} }),
    effect: (fn) => fn() ?? (() => {}),
    get: (key) => all[key] ?? (key === 'settings' ? settings : undefined),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return ctx
}

function vaRoot(tag) {
  const root = tempDir(tag)
  const config = { dataRoot: root, agentsRoot: join(root, 'agents') }
  const dir = join(config.agentsRoot, 'coder')
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, '.agent.md'), '---\nname: Coder Bot\n---\n你是一个写代码的 Bot。\n', 'utf8')
  return { root, config, dir }
}

const zipMap = async (buffer) => new Map((await zipRead(buffer)).map((e) => [e.name, e.data.toString('utf8')]))

test('Markdown 往返：条目 → MEMORY.md → 条目（换行压成空格，占位行与注释不算条目）', () => {
  const md = memoryMarkdownOf(['[2026-11-01] 一', '[2026-11-02] 二\n续行'])
  assert.equal(md, '# 记忆\n\n- [2026-11-01] 一\n- [2026-11-02] 二 续行\n')
  assert.deepEqual(entriesFromMarkdown(md), ['[2026-11-01] 一', '[2026-11-02] 二 续行'])
  assert.deepEqual(entriesFromMarkdown('<!-- - 注释里的 -->\n- （还没有条目 —— 在这里加第一条）\n* 星号也算\n'), ['星号也算'])
})

test('写入口 v2：拿不到 / 版本不够 ⇒ 不用统一存储', () => {
  assert.equal(unifiedMemoryOf({}, {}), null)
  assert.equal(unifiedMemoryOf({}, { [KEY]: { version: 1, addBotEntry() {} } }), null, 'v1 没有读 / 导入方法')
  const v2 = { version: 2, readBotMemory() {} }
  assert.equal(unifiedMemoryOf({}, { [KEY]: v2 }), v2)
})

test('导出 / 导入：主记忆与历史都走统一存储；旧目录的其它记忆文件照旧随包走', { skip: !(await gitAvailable()) }, async () => {
  const memA = tempDir('memA')
  const memB = tempDir('memB')
  const a = vaRoot('vaA')
  const b = vaRoot('vaB')
  rmSync(b.dir, { recursive: true, force: true })
  try {
    apply(fakeCtx(), { memoryDir: memA, legacyAgentImport: false })
    const w = globalThis[KEY]
    assert.ok(w.version >= 2, '写入口版本只增不减')
    assert.ok(w.addBotEntry('coder', '用户偏好中文回答').ok)
    assert.ok(w.addBotEntry('coder', '部署前先跑 smoke').ok)
    // 旧目录：一份过时的 MEMORY.md（不该被导出）+ 一个附加记忆文件（照旧随包走）
    writeFileSync(join(a.dir, 'memory', 'MEMORY.md'), '# 记忆\n\n- 过时的旧条目\n', 'utf8')
    writeFileSync(join(a.dir, 'memory', 'notes.md'), '附加笔记\n', 'utf8')

    const pack = await exportAgent(a.config, 'coder', { includeMemory: true, includeHistory: true })
    assert.deepEqual(pack.memoryFiles.sort(), ['MEMORY.md', 'notes.md'])
    assert.equal(pack.history.included, true, JSON.stringify(pack.history))
    assert.equal(pack.history.store, 'unified')
    const files = await zipMap(pack.buffer)
    assert.ok(files.get('memory/MEMORY.md').includes('用户偏好中文回答'))
    assert.ok(!files.get('memory/MEMORY.md').includes('过时的旧条目'), '主记忆以统一存储为准')
    assert.equal(files.get('memory/notes.md'), '附加笔记\n')
    assert.ok(files.has(MEMORY_HISTORY_NAME))

    // 换一台「机器」：新的统一存储 + 新的 agents 根，已有一条同正文条目（日期不同）
    apply(fakeCtx(), { memoryDir: memB, legacyAgentImport: false })
    const wb = globalThis[KEY]
    wb.importBotEntries('coder', ['[2020-01-01] 部署前先跑 smoke'])
    const imported = await importAgent(b.config, pack.buffer)
    assert.equal(imported.mode, 'created')
    assert.equal(imported.memory.store, 'unified')
    assert.equal(imported.memory.added, 1, JSON.stringify(imported.memory))
    assert.equal(imported.memory.skipped, 1, '同正文按去重跳过')
    const now = wb.readBotMemory('coder').entries
    assert.equal(now.length, 2)
    assert.ok(now.some((e) => e.endsWith('用户偏好中文回答')))
    assert.equal(imported.history.archived, true)
    assert.ok(readdirSync(join(memB, 'bots', 'coder')).some((n) => /^imported-history-.*\.bundle$/.test(n)))
    assert.ok(existsSync(join(b.dir, 'memory', 'notes.md')), '附加记忆文件写回旧目录')
    assert.ok(!existsSync(join(b.dir, 'memory', 'MEMORY.md')), '主记忆不再写旧目录')

    // 拿不到写入口（CLI，不经 Host）：读写旧目录（收件箱），历史如实说带不了
    delete globalThis[KEY]
    const cli = await exportAgent(a.config, 'coder', { includeMemory: true, includeHistory: true })
    assert.ok((await zipMap(cli.buffer)).get('memory/MEMORY.md').includes('过时的旧条目'))
    assert.equal(cli.history.included, false)
    const c = vaRoot('vaC')
    rmSync(c.dir, { recursive: true, force: true })
    try {
      const back = await importAgent(c.config, pack.buffer)
      assert.equal(back.history.restored, false)
      assert.ok(existsSync(join(c.dir, 'memory', 'MEMORY.md')), 'CLI 导入写进收件箱')
    } finally { clean(c.root) }
  } finally {
    delete globalThis[KEY]
    for (const d of [memA, memB, a.root, b.root]) clean(d)
  }
})
