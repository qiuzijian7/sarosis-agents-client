// VsSaros 2026-11-05「记忆收敛成一套」：bot 轨、工作区键、旧目录认领、旧记忆导入、对外写入口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, renderSnapshot, resolveConfig, validateRuntimePatch, RUNTIME_KEYS } from '../lib/index.js'
import { setLocale } from '../lib/i18n.js'
import { MemoryStore, projectHash, workspaceKeyOf, __resetWorkspaceKeyCache } from '../lib/store.js'
import { adoptLegacyProjectDir, makeProjectDirResolver } from '../lib/sync/index.js'
import { importLegacyAgentMemory, legacyEntriesOf, LEGACY_LEDGER_FILE } from '../lib/legacy-import.js'
import { botOfAgent, slugifyBotId } from '../lib/vssaros-bot.js'
import { buildMemoryFiles } from '../lib/memory-tab.js'

setLocale('zh')

const tempDir = (tag) => mkdtempSync(join(tmpdir(), `vsm-converge-${tag}-`))
const clean = (dir) => rmSync(dir, { recursive: true, force: true })
const botAgent = (preset, extra = {}) => ({ session: { header: { agentPreset: preset, cwd: extra.cwd } } })

function fakeCtx(services = {}) {
  const state = { tools: [], contexts: [], routes: [] }
  const all = {
    tools: { register: (def) => { state.tools.push(def); return () => {} }, get: () => undefined },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: () => () => {} },
    webServer: { register: (route) => { state.routes.push(route); return () => {} } },
    ...services,
  }
  const settings = { get: (ns) => (ns === 'locale' ? { preference: 'zh' } : undefined) }
  const ctx = {
    state,
    tools: all.tools,
    systemPrompt: all.systemPrompt,
    commands: all.commands,
    webServer: all.webServer,
    on: () => () => {},
    inject: (deps, cb) => (deps.every((d) => all[d] !== undefined) ? { dispose: cb(ctx) ?? (() => {}) } : { dispose: () => {} }),
    effect: (fn) => fn() ?? (() => {}),
    get: (key) => all[key] ?? (key === 'settings' ? settings : undefined),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return ctx
}

// ── Bot 识别 ──────────────────────────────────────────────────────────────
test('botOfAgent：Bot preset 有键、模式 preset / 非 vssaros 没有', () => {
  assert.equal(botOfAgent(botAgent('vssaros-coder'))?.key, 'coder')
  assert.equal(botOfAgent(botAgent('vssaros-standard')), null, '模式 preset 不是 Bot')
  assert.equal(botOfAgent(botAgent('vssaros-full')), null)
  assert.equal(botOfAgent(botAgent('standard')), null)
  assert.equal(botOfAgent(botAgent('')), null)
  assert.equal(botOfAgent(undefined), null)
})

test('botOfAgent：投影里的当前 preset 优先于创建头；身份记录与 preset 同键', () => {
  const projections = {
    stateOf: (_session, key) => (key === 'agentPreset' ? 'vssaros-camelcase-bot' : { botId: 'CamelCase.Bot', presetId: 'vssaros-camelcase-bot' }),
  }
  const bot = botOfAgent(botAgent('vssaros-other'), projections)
  assert.equal(bot.key, 'camelcase-bot', 'slugify(记录里的 botId) 与 preset 后缀一致')
  assert.equal(bot.label, 'CamelCase.Bot')
  assert.equal(slugifyBotId('CamelCase.Bot'), 'camelcase-bot')
})

// ── bot 轨存储与注入 ──────────────────────────────────────────────────────
test('bot 轨：按 Bot 分目录；非 Bot 会话定位不到并给出明确错误', () => {
  const dir = tempDir('bot')
  try {
    const store = new MemoryStore(dir)
    assert.ok(store.add('bot', '用户喜欢简短回答', botAgent('vssaros-coder')).ok)
    assert.ok(existsSync(join(dir, 'bots', 'coder', 'MEMORY.md')))
    assert.equal(store.entriesOf('bot', botAgent('vssaros-writer')).length, 0, '另一个 Bot 看不到')
    assert.equal(store.locate('bot', botAgent('vssaros-standard')), undefined)
    assert.throws(() => store.add('bot', 'x', botAgent('standard')), /不是 Bot 会话/)
  } finally { clean(dir) }
})

test('快照：Bot 会话注入本 Bot 记忆段，其它会话不注入', () => {
  const dir = tempDir('snap')
  try {
    const config = resolveConfig({ memoryDir: dir })
    const store = new MemoryStore(config.memoryDir, config)
    store.add('bot', '部署前先跑 smoke 测试', botAgent('vssaros-coder'))
    const bot = renderSnapshot(config, store, botAgent('vssaros-coder', { cwd: dir }))
    assert.ok(bot.includes('## 本 Bot 的记忆（coder；memory 工具 target=bot）'), bot.slice(0, 300))
    assert.ok(bot.includes('部署前先跑 smoke 测试'))
    const plain = renderSnapshot(config, store, botAgent('vssaros-standard', { cwd: dir }))
    assert.ok(!plain.includes('本 Bot 的记忆'))
    assert.ok(!plain.includes('部署前先跑 smoke 测试'))
  } finally { clean(dir) }
})

test('快照：Bot 记忆按整条截断到 botMemoryCharLimit，0 = 不注入', () => {
  const dir = tempDir('cap')
  try {
    const store = new MemoryStore(dir)
    const agent = botAgent('vssaros-coder', { cwd: dir })
    for (let i = 0; i < 40; i += 1) store.add('bot', `第 ${i} 条 Bot 经验：这是一条用来测试注入上限的条目`, agent)
    const capped = renderSnapshot(resolveConfig({ memoryDir: dir, botMemoryCharLimit: 300 }), store, agent)
    const section = capped.slice(capped.indexOf('## 本 Bot 的记忆'))
    const body = section.split('\n## ')[0]
    assert.ok(/还有 \d+ 条未注入（注入上限 300 字符）/.test(body), body)
    assert.ok(body.includes('第 0 条'), '从最早的条目开始保留')
    assert.ok(!body.includes('第 39 条'))
    const off = renderSnapshot(resolveConfig({ memoryDir: dir, botMemoryCharLimit: 0 }), store, agent)
    assert.ok(!off.includes('本 Bot 的记忆'))
  } finally { clean(dir) }
})

test('botMemoryCharLimit 是运行时键：非负整数', () => {
  assert.ok(RUNTIME_KEYS.includes('botMemoryCharLimit'))
  validateRuntimePatch('botMemoryCharLimit', 0)
  validateRuntimePatch('botMemoryCharLimit', 4096)
  assert.throws(() => validateRuntimePatch('botMemoryCharLimit', -1), /botMemoryCharLimit/)
  assert.throws(() => validateRuntimePatch('botMemoryCharLimit', 1.5), /botMemoryCharLimit/)
})

test('memory 工具：target 含 bot，Bot 会话里 add/list 走 bot 轨', async () => {
  const dir = tempDir('tool')
  try {
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir, legacyAgentImport: false })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    assert.ok(tool.parameters.properties.target.enum.includes('bot'))
    const exec = { agent: botAgent('vssaros-coder', { cwd: dir }), callId: 'c', signal: new AbortController().signal }
    const added = await tool.execute({ action: 'add', target: 'bot', content: '用户的时区是 UTC+8' }, exec)
    assert.ok(added.ok, JSON.stringify(added))
    const listed = await tool.execute({ action: 'list', target: 'bot' }, exec)
    assert.ok(JSON.stringify(listed).includes('UTC+8'))
    const denied = await tool.execute({ action: 'add', target: 'bot', content: '不该写进去' }, { ...exec, agent: botAgent('standard', { cwd: dir }) })
    assert.equal(denied.ok, false)
    assert.match(String(denied.message), /不是 Bot 会话/)
  } finally { clean(dir) }
})

test('子代理写 bot 轨与全局轨同一道闸（suggest 模式拒绝）', async () => {
  const dir = tempDir('sub')
  try {
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir, legacyAgentImport: false })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    const agent = { session: { header: { agentPreset: 'vssaros-coder', cwd: dir, origin: 'subagent' } } }
    const out = await tool.execute({ action: 'add', target: 'bot', content: '子代理想写的东西' }, { agent, callId: 'c', signal: new AbortController().signal })
    assert.equal(out.ok, false)
    assert.ok(!existsSync(join(dir, 'bots', 'coder', 'MEMORY.md')))
  } finally { clean(dir) }
})

test('对外写入口：globalThis[vssaros.memory.store].addBotEntry 写进 bot 轨', () => {
  const dir = tempDir('bus')
  try {
    apply(fakeCtx(), { memoryDir: dir, legacyAgentImport: false })
    const writer = globalThis[Symbol.for('vssaros.memory.store')]
    assert.equal(writer?.version, 1)
    assert.ok(writer.addBotEntry('CamelCase.Bot', '步骤证据：工单 T-1 的第 2 步成功').ok)
    const text = readFileSync(join(dir, 'bots', 'camelcase-bot', 'MEMORY.md'), 'utf8')
    assert.ok(text.includes('工单 T-1'))
    assert.equal(writer.addBotEntry('', 'x').ok, false)
  } finally { clean(dir) }
})

// ── 工作区键与旧目录认领 ──────────────────────────────────────────────────
test('工作区键：同一仓库的子目录会话落到同一个项目目录', () => {
  const root = tempDir('ws')
  try {
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'packages', 'a'), { recursive: true })
    __resetWorkspaceKeyCache()
    assert.equal(workspaceKeyOf(root), workspaceKeyOf(join(root, 'packages', 'a')))
    assert.equal(workspaceKeyOf(`${root}${process.platform === 'win32' ? '\\' : '/'}`), workspaceKeyOf(root), '末尾分隔符不影响')
    if (process.platform === 'win32') assert.equal(workspaceKeyOf(root.toUpperCase()), workspaceKeyOf(root), 'Windows 大小写不敏感')
  } finally { clean(root) }
})

test('工作区键与 dsh-agents 的 workspaceKeyOf(resolveWorkspace(cwd).root) 逐字节一致', async () => {
  const root = tempDir('parity')
  try {
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'sub'))
    const va = await import('../../vssaros-agents/lib/workspaceMemory.js')
    __resetWorkspaceKeyCache()
    for (const cwd of [root, join(root, 'sub')]) {
      assert.equal(workspaceKeyOf(cwd), va.resolveWorkspace(cwd).key, cwd)
    }
  } finally { clean(root) }
})

test('旧 projectHash 目录：新目录不存在 ⇒ 整体改名过去', () => {
  const memoryDir = tempDir('adopt')
  const cwd = tempDir('adopt-cwd')
  try {
    const projectsDir = join(memoryDir, 'projects')
    const legacy = join(projectsDir, projectHash(cwd))
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'KEY.md'), '[2026-11-01] 旧目录里的关键记忆\n')
    writeFileSync(join(legacy, 'TODOS.md'), '待办\n')
    __resetWorkspaceKeyCache()
    const resolver = makeProjectDirResolver({ memoryDir })
    const dir = resolver(cwd)
    if (dir === legacy) return // 这个平台上新旧键碰巧相同（非 Windows 且 cwd 已是 realpath）：无需认领
    assert.ok(!existsSync(legacy))
    assert.ok(readFileSync(join(dir, 'KEY.md'), 'utf8').includes('旧目录里的关键记忆'))
    assert.ok(existsSync(join(dir, 'TODOS.md')), '待办一起搬走')
  } finally { clean(memoryDir); clean(cwd) }
})

test('旧 projectHash 目录：两边都有 ⇒ 同名文件按条目并集，旧目录挪到 .merged 留底', () => {
  const memoryDir = tempDir('merge')
  try {
    const projectsDir = join(memoryDir, 'projects')
    const cwd = 'C:\\Repo\\Sub'
    const dir = join(projectsDir, 'newkey000000')
    const legacy = join(projectsDir, projectHash(cwd))
    mkdirSync(dir, { recursive: true })
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(dir, 'KEY.md'), '[2026-11-02] 新目录的条目\n§\n[2026-11-01] 两边都有\n')
    writeFileSync(join(legacy, 'KEY.md'), '[2026-11-01] 两边都有\n§\n[2026-10-30] 只在旧目录\n')
    writeFileSync(join(legacy, 'MEMORY.md'), '[2026-10-30 10:00] 旧项目日志\n')
    assert.equal(adoptLegacyProjectDir(projectsDir, cwd, dir), 'merged')
    const key = readFileSync(join(dir, 'KEY.md'), 'utf8')
    assert.equal(key.split('两边都有').length - 1, 1, '不重复')
    assert.ok(key.includes('只在旧目录'))
    assert.ok(key.indexOf('新目录的条目') < key.indexOf('只在旧目录'), '新目录的顺序在前')
    assert.ok(readFileSync(join(dir, 'MEMORY.md'), 'utf8').includes('旧项目日志'), '缺的文件直接搬')
    assert.ok(!existsSync(legacy))
    assert.equal(readdirSync(join(projectsDir, '.merged')).length, 1)
    assert.equal(adoptLegacyProjectDir(projectsDir, cwd, dir), 'none', '幂等')
  } finally { clean(memoryDir) }
})

// ── 旧 Bot / 工作区记忆导入 ───────────────────────────────────────────────
test('legacyEntriesOf：去模板注释、占位行与标题，保留日期前缀', () => {
  const text = [
    '# 记忆', '', '<!-- 每轮注入到 system prompt。', '     加一条：追加一个 Markdown 列表项。 -->', '',
    '- （还没有条目 —— 在这里加第一条）', '- [2026-10-20] 用户偏好中文', '* 没有日期的条目', '## 小标题', '',
  ].join('\n')
  assert.deepEqual(legacyEntriesOf(text), ['[2026-10-20] 用户偏好中文', '没有日期的条目'])
})

test('导入：Bot（自定义 + 内置）与工作区记忆并入 bot / key 轨，幂等且不改源', () => {
  const dataRoot = tempDir('legacy-root')
  const memoryDir = tempDir('legacy-mem')
  try {
    const custom = join(dataRoot, 'agents', 'CamelCase.Bot', 'memory')
    const builtin = join(dataRoot, 'agent-memory', 'coder')
    const ws = join(dataRoot, 'workspace-memory', 'abcdef012345')
    for (const d of [custom, builtin, ws]) mkdirSync(d, { recursive: true })
    writeFileSync(join(custom, 'MEMORY.md'), '# 记忆\n\n- [2026-10-01] 自定义 Bot 的偏好\n')
    writeFileSync(join(builtin, 'MEMORY.md'), '# 记忆\n\n- （还没有条目 —— 在这里加第一条）\n')
    const wsText = '# 工作区记忆\n\n- [2026-10-05] 构建用 pnpm\n- [2026-10-06] 端口 4109\n'
    writeFileSync(join(ws, 'MEMORY.md'), wsText)
    // 目标里已有一条同正文（日期不同）⇒ 不重复导入
    mkdirSync(join(memoryDir, 'projects', 'abcdef012345'), { recursive: true })
    writeFileSync(join(memoryDir, 'projects', 'abcdef012345', 'KEY.md'), '[2026-11-01] 端口 4109\n')

    const config = { memoryDir, legacyAgentDataRoot: dataRoot }
    const first = importLegacyAgentMemory(config)
    assert.equal(first.scanned, 3)
    assert.equal(first.imported, 2, JSON.stringify(first))
    assert.ok(readFileSync(join(memoryDir, 'bots', 'camelcase-bot', 'MEMORY.md'), 'utf8').includes('[2026-10-01] 自定义 Bot 的偏好'), '日期保留')
    assert.ok(!existsSync(join(memoryDir, 'bots', 'coder', 'MEMORY.md')), '只有占位行的模板不产生文件')
    const key = readFileSync(join(memoryDir, 'projects', 'abcdef012345', 'KEY.md'), 'utf8')
    assert.ok(key.includes('构建用 pnpm'))
    assert.equal(key.split('端口 4109').length - 1, 1)
    assert.equal(readFileSync(join(ws, 'MEMORY.md'), 'utf8'), wsText, '源文件不改')
    assert.ok(existsSync(join(memoryDir, LEGACY_LEDGER_FILE)))

    const again = importLegacyAgentMemory(config)
    assert.equal(again.imported, 0)
    assert.equal(again.skipped, 3, '内容没变 ⇒ 跳过')

    writeFileSync(join(builtin, 'MEMORY.md'), '# 记忆\n\n- [2026-11-05] 回滚期间旧路径写的一条\n')
    const third = importLegacyAgentMemory(config)
    assert.equal(third.imported, 1, '源文件变了 ⇒ 补导新增条目')
    assert.ok(readFileSync(join(memoryDir, 'bots', 'coder', 'MEMORY.md'), 'utf8').includes('回滚期间'))
  } finally { clean(dataRoot); clean(memoryDir) }
})

test('apply 启动即导入旧记忆（legacyAgentImport:false 时不导入）', () => {
  const dataRoot = tempDir('apply-root')
  try {
    mkdirSync(join(dataRoot, 'agent-memory', 'coder'), { recursive: true })
    writeFileSync(join(dataRoot, 'agent-memory', 'coder', 'MEMORY.md'), '- [2026-10-01] 启动导入\n')
    const on = tempDir('apply-on')
    const off = tempDir('apply-off')
    try {
      apply(fakeCtx(), { memoryDir: on, legacyAgentDataRoot: dataRoot })
      assert.ok(existsSync(join(on, 'bots', 'coder', 'MEMORY.md')))
      apply(fakeCtx(), { memoryDir: off, legacyAgentDataRoot: dataRoot, legacyAgentImport: false })
      assert.ok(!existsSync(join(off, 'bots', 'coder', 'MEMORY.md')))
    } finally { clean(on); clean(off) }
  } finally { clean(dataRoot) }
})

// ── 记忆页签 ─────────────────────────────────────────────────────────────
test('记忆页签：Bot 会话多一行 Bot 记忆，普通会话没有', () => {
  const dir = tempDir('tab')
  try {
    const config = resolveConfig({ memoryDir: dir })
    const store = new MemoryStore(dir, { projectDirResolver: makeProjectDirResolver(config) })
    store.add('bot', '页签里能看到的 Bot 记忆', botAgent('vssaros-coder'))
    const withBot = buildMemoryFiles(config, store, dir, botAgent('vssaros-coder', { cwd: dir }))
    const row = withBot.find((r) => r.key === 'bot')
    assert.ok(row?.exists && row.content.includes('页签里能看到的 Bot 记忆'), JSON.stringify(row))
    assert.ok(!buildMemoryFiles(config, store, dir, botAgent('standard', { cwd: dir })).some((r) => r.key === 'bot'))
    assert.ok(!buildMemoryFiles(config, store, dir).some((r) => r.key === 'bot'), '没传会话 ⇒ 没有')
  } finally { clean(dir) }
})
