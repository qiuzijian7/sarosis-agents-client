// VsSaros 2026-11-05 S1：项目关键记忆（key 轨）写入方式 keyWriteMode。
// 原来 @vssaros/dsh-agents 的 workspace_memory 是直写；并入 key 轨后一律进待确认队列 ⇒ 没人确认就永远是空的。
// direct：主会话 add 直接写 KEY.md；子代理仍进队列。上游默认 queue，产品默认在 cordis.patch.yml 里设 direct。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, renderSnapshot, resolveConfig, validateRuntimePatch, RUNTIME_KEYS } from '../lib/index.js'
import { setLocale, getLocale } from '../lib/i18n.js'
import { MemoryStore, workspaceKeyOf } from '../lib/store.js'

const previousLocale = getLocale()
setLocale('zh')
after(() => setLocale(previousLocale))
const here = dirname(fileURLToPath(import.meta.url))
const tempDir = (tag) => mkdtempSync(join(tmpdir(), `vsm-key-${tag}-`))
const clean = (dir) => rmSync(dir, { recursive: true, force: true })

function fakeCtx(services = {}) {
  const state = { tools: [], effects: [] }
  const all = {
    tools: { register: (def) => { state.tools.push(def); return () => {} }, get: () => undefined },
    systemPrompt: { context: () => () => {} },
    commands: { register: () => () => {} },
    webServer: { register: () => () => {} },
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
    effect: (fn) => {
      const dispose = fn() ?? (() => {})
      state.effects.push(dispose)
      return dispose
    },
    get: (key) => all[key] ?? (key === 'settings' ? settings : undefined),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return ctx
}

const execOf = (cwd, origin) => ({
  agent: { id: 'a', session: { header: { cwd, ...(origin ? { origin } : {}) } } },
  callId: 'c',
  signal: new AbortController().signal,
})

async function withMemoryTool(extra, fn, services = {}) {
  const mem = tempDir('mem')
  const cwd = tempDir('cwd')
  const ctx = fakeCtx(services)
  try {
    apply(ctx, { memoryDir: mem, legacyAgentImport: false, ...extra, coiSyncSkills: false })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    assert.ok(tool, 'memory 工具应已注册')
    return await fn({ mem, cwd, ctx, tool })
  } finally {
    try {
      for (const dispose of ctx.state.effects.reverse()) dispose()
    } finally {
      clean(mem)
      clean(cwd)
    }
  }
}

async function addKey(extra, origin) {
  return await withMemoryTool(extra, async ({ mem, cwd, tool }) => {
    const out = await tool.execute({ action: 'add', target: 'key', content: '构建统一用 pnpm' }, execOf(cwd, origin))
    const keyFile = join(mem, 'projects', workspaceKeyOf(cwd), 'KEY.md')
    const queueFile = join(mem, 'SUGGESTIONS.jsonl')
    return {
      out,
      key: existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : '',
      queued: existsSync(queueFile) ? readFileSync(queueFile, 'utf8') : '',
    }
  })
}

test('keyWriteMode：运行时键，只接受 direct / queue；上游默认 queue', () => {
  assert.ok(RUNTIME_KEYS.includes('keyWriteMode'))
  validateRuntimePatch('keyWriteMode', 'direct')
  validateRuntimePatch('keyWriteMode', 'queue')
  assert.throws(() => validateRuntimePatch('keyWriteMode', 'auto'), /keyWriteMode/)
  assert.equal(resolveConfig({}).keyWriteMode, 'queue')
})

test('keyWriteMode=queue（上游默认）：主会话 add key 进待确认队列', async () => {
  const r = await addKey({})
  assert.equal(r.out.ok, true)
  assert.equal(r.key, '')
  assert.ok(r.queued.includes('构建统一用 pnpm'))
})

test('keyWriteMode=direct：主会话 add key 直接写进 KEY.md，不进队列', async () => {
  const r = await addKey({ keyWriteMode: 'direct' })
  assert.equal(r.out.ok, true, JSON.stringify(r.out))
  assert.ok(r.key.includes('构建统一用 pnpm'), r.key)
  assert.ok(!r.queued.includes('构建统一用 pnpm'))
  assert.ok(!/待确认/.test(String(r.out.message)), String(r.out.message))
})

test('keyWriteMode=direct：子代理 add key 仍进待确认队列', async () => {
  const r = await addKey({ keyWriteMode: 'direct' }, 'subagent')
  assert.equal(r.key, '')
  assert.ok(r.queued.includes('构建统一用 pnpm'))
})

for (const target of ['memory', 'user', 'bot']) {
  for (const scenario of [
    { name: 'suggest 不发起审批且拒绝', mode: 'suggest', outcome: 'allowed-once', requests: 0, allowed: false },
    { name: 'auto 缺审批服务拒绝', mode: 'auto', requests: 0, allowed: false },
    { name: 'auto 审批拒绝不写入', mode: 'auto', outcome: 'denied', requests: 1, allowed: false },
    { name: 'auto 单次批准后才写入', mode: 'auto', outcome: 'allowed-once', requests: 1, allowed: true },
  ]) {
    test(`子代理 ${target}：${scenario.name}`, async () => {
      const requests = []
      const services = scenario.outcome === undefined ? {} : {
        approval: { request: async (request) => { requests.push(request); return scenario.outcome } },
      }
      await withMemoryTool({ reviewMode: scenario.mode }, async ({ mem, cwd, tool }) => {
        const exec = execOf(cwd, 'subagent')
        exec.agent.session.header.agentPreset = 'vssaros-coder'
        const out = await tool.execute({ action: 'add', target, content: `${target} 审批事实` }, exec)
        const file = target === 'bot'
          ? join(mem, 'bots', 'coder', 'MEMORY.md')
          : join(mem, target === 'memory' ? 'MEMORY.md' : 'USER.md')
        const stored = existsSync(file) ? readFileSync(file, 'utf8') : ''
        assert.deepEqual({ ok: out.ok, requests: requests.length, stored: stored.includes(`${target} 审批事实`) }, {
          ok: scenario.allowed, requests: scenario.requests, stored: scenario.allowed,
        })
        if (requests.length) {
          assert.deepEqual({ agent: requests[0].agent, toolName: requests[0].toolName, callId: requests[0].callId, signal: requests[0].signal }, {
            agent: exec.agent, toolName: 'memory', callId: exec.callId, signal: exec.signal,
          })
        }
      }, services)
    })
  }
}

for (const target of ['memory', 'user']) {
  test(`主会话 ${target}：suggest 是提示纪律，不是程序级确认闸`, async () => {
    await withMemoryTool({ reviewMode: 'suggest' }, async ({ mem, cwd, tool }) => {
      const out = await tool.execute({ action: 'add', target, content: '主会话明确写入的事实' }, execOf(cwd))
      assert.equal(out.ok, true)
      const file = join(mem, target === 'memory' ? 'MEMORY.md' : 'USER.md')
      assert.ok(readFileSync(file, 'utf8').includes('主会话明确写入的事实'))
      assert.equal(existsSync(join(mem, 'SUGGESTIONS.jsonl')), false)
    })
  })
}

test('快照收尾文案随 keyWriteMode 变化（子代理始终说进队列）', () => {
  const dir = tempDir('snap')
  try {
    const render = (extra, origin) => {
      const config = resolveConfig({ memoryDir: dir, ...extra })
      return renderSnapshot(config, new MemoryStore(dir, config), { id: 'a', session: { header: { cwd: dir, ...(origin ? { origin } : {}) } } })
    }
    const queue = render({})
    assert.ok(queue.includes('提交 1 条建议（走待确认队列'), '默认仍提示进队列')
    const direct = render({ keyWriteMode: 'direct' })
    assert.ok(direct.includes('向 target=key 写入 1 条'), direct.slice(-600))
    assert.ok(!direct.includes('走待确认队列'))
    const sub = render({ keyWriteMode: 'direct' }, 'subagent')
    assert.ok(sub.includes('走待确认队列'), '子代理仍进队列')
  } finally { clean(dir) }
})

test('产品默认（插件自带 cordis.patch.yml）：keyWriteMode: direct', () => {
  const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /^\s+keyWriteMode:\s*direct\s*$/m)
})
