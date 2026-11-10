/**
 * P0（2026-11-10）多根工作区记忆作用域：纯函数 + API 契约 + 客户端静态一致性。
 *
 * 全部为纯内存夹具（不起 Host、不碰真实用户数据）。跑法：
 *   node --test tests/workspace-scope.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { deriveMemoryScope, cwdUnderRoot } from '../lib/workspace-scope.js'
import { buildMemoryFiles } from '../lib/memory-tab.js'
import { ArchiveStore, MemoryStore, SuggestionQueue, workspaceKeyOf } from '../lib/store.js'
import { installApi } from '../lib/api.js'
import { TodoStore } from '../lib/todo.js'
import { validateRuntimePatch } from '../lib/index.js'
import { setLocale } from '../lib/i18n.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
setLocale('zh')

/** 造一个与 foundation.createFoundationService() 同形状的假服务。 */
function fakeFoundation(roots, workspaceId = 'ws-1') {
  return {
    workspaceContext: () => ({ workspaceId, workspaceRoot: roots[0]?.path, relatedRoots: roots.map(r => r.path) }),
    workspaceRoots: () => roots.map((r, i) => ({ path: r.path, name: r.name ?? r.path.split(/[\\/]/).filter(Boolean).pop(), isPrimary: i === 0 })),
  }
}

const THREE_ROOTS = [
  { path: '/ws/repo-a', name: 'repo-a' },
  { path: '/ws/repo-b', name: 'repo-b' },
  { path: '/ws/repo-c', name: 'repo-c' },
]

// ─── 纯函数 ────────────────────────────────────────────────────────────────

test('deriveMemoryScope: 多根有序去重、主根首位、当前根由 cwd 判定', () => {
  const scope = deriveMemoryScope(fakeFoundation(THREE_ROOTS), '/ws/repo-b/src/index.ts', { workspaceKeyOf })
  assert.equal(scope.workspaceId, 'ws-1')
  assert.equal(scope.roots.length, 3)
  assert.equal(scope.roots[0].isPrimary, true)
  assert.equal(scope.roots[0].name, 'repo-a')
  assert.equal(scope.current, '/ws/repo-b')
  assert.equal(scope.ambiguous, false)
  assert.equal(typeof scope.workspaceKey, 'string')
})

test('deriveMemoryScope: cwd 落在根外 ⇒ ambiguous=true，不猜归属', () => {
  const scope = deriveMemoryScope(fakeFoundation(THREE_ROOTS), '/tmp/scratch/x.ts')
  assert.equal(scope.current, null)
  assert.equal(scope.ambiguous, true)
})

test('deriveMemoryScope: 单根不标 ambiguous，键与 workspaceKeyOf 同口径', () => {
  const scope = deriveMemoryScope(fakeFoundation([THREE_ROOTS[0]]), '/ws/repo-a/lib/a.ts', { workspaceKeyOf })
  assert.equal(scope.roots.length, 1)
  assert.equal(scope.ambiguous, false)
  assert.equal(scope.workspaceKey, workspaceKeyOf('/ws/repo-a'))
})

test('deriveMemoryScope: foundation 缺席 / 无上下文 / 服务抛错一律降级为 null', () => {
  assert.equal(deriveMemoryScope(undefined, '/ws/repo-a'), null)
  assert.equal(deriveMemoryScope({}, '/ws/repo-a'), null)
  assert.equal(deriveMemoryScope({ workspaceContext: () => undefined, workspaceRoots: () => THREE_ROOTS }, '/ws/repo-a'), null)
  assert.equal(deriveMemoryScope({ workspaceContext: () => { throw new Error('not bound') }, workspaceRoots: () => [] }, '/ws/repo-a'), null)
})

test('deriveMemoryScope: 根集来自 workspaceRoots()，不自己拼老载荷', () => {
  // 老口径 relatedRoots 全量含主根；若自己拼会重复。这里 workspaceRoots() 已去重 ⇒ 不应出现 4 根。
  const svc = fakeFoundation(THREE_ROOTS)
  svc.workspaceRoots = () => THREE_ROOTS.map((r, i) => ({ path: r.path, name: r.name, isPrimary: i === 0 }))
  const scope = deriveMemoryScope(svc, '/ws/repo-c')
  assert.equal(scope.roots.length, 3)
  assert.equal(scope.current, '/ws/repo-c')
})

test('cwdUnderRoot: 路径边界不误命中同前缀兄弟目录', () => {
  assert.equal(cwdUnderRoot('/ws/repo-a/x.ts', '/ws/repo-a'), true)
  assert.equal(cwdUnderRoot('/ws/repo-a', '/ws/repo-a'), true)
  assert.equal(cwdUnderRoot('/ws/repo-abc/x.ts', '/ws/repo-a'), false)
  assert.equal(cwdUnderRoot('/other/x.ts', '/ws/repo-a'), false)
  assert.equal(cwdUnderRoot('', '/ws/repo-a'), false)
})

// ─── 数据层：每行作用域元数据（向后兼容旧调用）────────────────────────────

test('buildMemoryFiles: 每行带 scope，旧 3 参调用逐字段兼容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scope-test-'))
  try {
    const config = { memoryDir: dir, skillDir: join(dir, 'skills') }
    const store = new MemoryStore(dir)
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    try {
      const legacy = buildMemoryFiles(config, store, '/ws/repo-a')
      assert.equal(legacy.length, 9, '旧调用仍返回 9 轨')
      // 旧字段一个不少；新增字段只有 scope（无作用域上下文时不带 root/workspaceKey）。
      for (const key of ['key', 'title', 'available', 'exists', 'truncated', 'content', 'path']) {
        assert.ok(Object.hasOwn(legacy[0], key), `旧字段 ${key} 不能丢`)
      }
      assert.equal(legacy[0].scope, 'project')
      assert.equal(legacy[0].root, undefined)
      assert.equal(legacy[0].workspaceKey, undefined)

      const scope = deriveMemoryScope(fakeFoundation(THREE_ROOTS), '/ws/repo-b/src', { workspaceKeyOf })
      const enriched = buildMemoryFiles(config, store, '/ws/repo-b/src', undefined, scope)
      assert.equal(enriched.length, 9)
      const byKey = Object.fromEntries(enriched.map(f => [f.key, f]))
      assert.equal(byKey.project.scope, 'project')
      assert.equal(byKey.key.scope, 'project')
      assert.equal(byKey['archive-key'].scope, 'project')
      assert.equal(byKey.project.root.name, 'repo-b')
      assert.equal(byKey.project.workspaceKey, workspaceKeyOf('/ws/repo-b'))
      assert.equal(byKey.memory.scope, 'global')
      assert.equal(byKey.user.scope, 'global')
      assert.equal(byKey.daily.scope, 'global')
      assert.equal(byKey['archive-memory'].scope, 'global')
      assert.equal(byKey.agents.scope, 'global')
    } finally {
      process.env.DSH_HOME = prevHome
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── API：新增字段全可选 + 只读端点 ────────────────────────────────────────

async function bootApi(getWorkspaceScope) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scope-api-'))
  const store = new MemoryStore(dir)
  const archive = new ArchiveStore(dir)
  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  const todoStore = new TodoStore(dir)
  const state = { reviewEnabled: true, memoryTabEnabled: true }
  const ctx = { webServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } } }
  installApi(ctx, {
    store, archive, queue, todoStore,
    getRuntime: () => ({ ...state }),
    updateRuntime: (patch) => { for (const [k, v] of Object.entries(patch)) validateRuntimePatch(k, v); Object.assign(state, patch); return { ...state } },
    resolveRevealTarget: () => undefined,
    revealPath: () => {},
    config: { memoryDir: dir, skillDir: join(dir, 'skills') },
    resolveCwd: () => '/ws/repo-b/src',
    getWorkspaceScope,
  })
  const server = createServer((req, res) => ctx.handler(req, res))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (path) => {
    const res = await fetch(base + path)
    return { status: res.status, data: await res.json().catch(() => ({})) }
  }
  return { request, dir, close: () => new Promise(r => server.close(r)) }
}

test('GET /api/memory-files: 单根/无上下文时新增字段为空，旧字段逐字不变', async () => {
  const api = await bootApi(() => null)
  try {
    const { status, data } = await api.request('/memory-evolve/api/memory-files?sessionId=s1')
    assert.equal(status, 200)
    assert.equal(data.cwd, '/ws/repo-b/src')
    assert.ok(Array.isArray(data.files) && data.files.length === 9)
    assert.deepEqual(data.roots, [])
    assert.equal(data.workspaceId, null)
    assert.equal(data.workspaceKey, null)
    assert.equal(data.botKey, null)
    assert.equal(data.scope, null)
    assert.ok(Object.hasOwn(data, 'branch') && Object.hasOwn(data, 'branches'))
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('GET /api/memory-files + /api/workspace-scope: 多根作用域一致下发', async () => {
  const scope = deriveMemoryScope(fakeFoundation(THREE_ROOTS), '/ws/repo-b/src', { workspaceKeyOf })
  const api = await bootApi(() => scope)
  try {
    const files = await api.request('/memory-evolve/api/memory-files?sessionId=s1')
    assert.equal(files.status, 200)
    assert.equal(files.data.workspaceId, 'ws-1')
    assert.equal(files.data.roots.length, 3)
    assert.equal(files.data.roots[0].isPrimary, true)
    assert.equal(files.data.workspaceKey, scope.workspaceKey)
    assert.deepEqual(files.data.scope, { current: '/ws/repo-b', ambiguous: false })
    const projectRow = files.data.files.find(f => f.key === 'project')
    assert.equal(projectRow.scope, 'project')
    assert.equal(projectRow.root.name, 'repo-b')

    const wsScope = await api.request('/memory-evolve/api/workspace-scope?sessionId=s1')
    assert.equal(wsScope.status, 200)
    assert.equal(wsScope.data.scope.workspaceId, 'ws-1')
    assert.equal(wsScope.data.scope.current, '/ws/repo-b')
    assert.equal(wsScope.data.cwd, '/ws/repo-b/src')
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

// ─── 客户端：源码 ↔ 产物静态一致性（产物是提交进仓库的构建结果）──────────

test('客户端源码与 lib/client.js 同时具备作用域条 / 双字典 / CSS', () => {
  const source = readFileSync(join(ROOT, 'src/client/MemoryTabView.tsx'), 'utf8')
  const dict = readFileSync(join(ROOT, 'src/client/index.ts'), 'utf8')
  const css = readFileSync(join(ROOT, 'src/client/styles.css'), 'utf8')
  const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

  for (const needle of ['mt-scope-bar', 'memoryTab.scope.label', 'scope.roots.length > 1']) {
    assert.ok(source.includes(needle), `MemoryTabView.tsx 缺 ${needle}`)
  }
  for (const needle of ['mt-scope-bar', 'memoryTab.scope.label', 'mt-scope-root-active']) {
    assert.ok(bundle.includes(needle), `lib/client.js 缺 ${needle}（改了 .tsx 必须同步重建产物）`)
    assert.ok(css.includes(needle) || needle.startsWith('memoryTab.'), `styles.css 缺 ${needle}`)
  }
  // zh / en 双字典：源码与产物都必须各有这 8 个 key，否则 i18n 键集会漏。
  const keys = [
    'memoryTab.scope.label', 'memoryTab.scope.roots', 'memoryTab.scope.primary',
    'memoryTab.scope.current', 'memoryTab.scope.key', 'memoryTab.scope.global',
    'memoryTab.scope.botHint', 'memoryTab.scope.ambiguous',
  ]
  for (const key of keys) {
    // 只数「字典定义行」（'key': / "key":），不把 JSX 里的 t('key') 引用算进去。
    const srcDefs = (dict.match(new RegExp(`\\s*'${key.replaceAll('.', '\\.')}'\\s*:`, 'g')) ?? []).length
    const bundleDefs = (bundle.match(new RegExp(`\\s*"${key.replaceAll('.', '\\.')}"\\s*:`, 'g')) ?? []).length
    assert.equal(srcDefs, 2, `index.ts 的 zh/en 字典必须各含 ${key}`)
    assert.equal(bundleDefs, 2, `lib/client.js 的 zh/en 字典必须各含 ${key}`)
  }
  // 产物语法可解析（防手工增量 patch 写坏 bundle）。
  assert.doesNotThrow(() => new Function(bundle), 'lib/client.js 必须可被 JS 解析')
})
