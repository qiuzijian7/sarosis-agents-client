/**
 * 记忆「读取 / 检索」的页签数据源：buildMemoryFiles 的行清单、作用域与展示剥离。
 * 单跑：node --test tests/memory-tab-read-contract.test.js
 *
 * memory-tab.test.js 固定断言「9 行」，造成 Bot 会话第 10 行与 scope 的盲区；
 * 本文件补上 Bot / 非 Bot 对照、作用域归属、content 元数据剥离、不可用行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, serializeEntries } from '../lib/store.js'
import { buildMemoryFiles } from '../lib/memory-tab.js'

function withTab(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-tab-read-'))
  try {
    const store = new MemoryStore(dir, { botKeyResolver: () => 'code-explorer' })
    const config = { memoryDir: dir }
    const cwd = '/work/p'
    return fn({ dir, store, config, cwd })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('非 Bot 会话 9 行；Bot 会话多一行 bot 且排在最前', () => withTab(({ store, config, cwd }) => {
  const plain = buildMemoryFiles(config, store, cwd, undefined, undefined)
  assert.equal(plain.length, 9)
  assert.equal(plain.some((r) => r.key === 'bot'), false)

  const bot = buildMemoryFiles(config, store, cwd, { session: { header: { cwd } } }, undefined)
  assert.equal(bot.length, 10)
  assert.equal(bot[0].key, 'bot')
  assert.equal(bot[0].scope, 'bot')
  assert.match(bot[0].path, /bots[/\\]code-explorer[/\\]MEMORY\.md$/)
}))

test('作用域归属：项目三行 scope=project，其余（除 bot）为 global', () => withTab(({ store, config, cwd }) => {
  const rows = buildMemoryFiles(config, store, cwd, undefined, undefined)
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
  for (const key of ['project', 'key', 'archive-key']) assert.equal(byKey[key].scope, 'project', key)
  for (const key of ['daily', 'user', 'memory', 'archive-user', 'archive-memory', 'agents']) {
    assert.equal(byKey[key].scope, 'global', key)
  }
}))

test('缺 cwd：项目三行 available=false 且没有 path，行仍可见', () => withTab(({ store, config }) => {
  const rows = buildMemoryFiles(config, store, undefined, undefined, undefined)
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
  for (const key of ['project', 'key', 'archive-key']) {
    assert.equal(byKey[key].available, false, key)
    assert.equal(byKey[key].path, undefined, key)
    assert.equal(byKey[key].exists, false, key)
    assert.equal(byKey[key].content, '', key)
  }
}))

test('不存在的文件 exists=false / content 为空，但行不下发空指针', () => withTab(({ store, config, cwd }) => {
  const rows = buildMemoryFiles(config, store, cwd, undefined, undefined)
  assert.ok(rows.every((r) => typeof r.title === 'string' && r.title.length > 0))
  assert.ok(rows.every((r) => typeof r.content === 'string'))
  assert.equal(rows.find((r) => r.key === 'memory').exists, false)
}))

test('content 展示剥离 [id:] 与 [summary:]，正文完整保留', () => withTab(({ dir, store, config, cwd }) => {
  const entry = '[id:deadbeef] [2026-11-12] [summary:一句话] 关键事实 ABC'
  writeFileSync(join(dir, 'MEMORY.md'), serializeEntries([entry]), 'utf8')
  const rows = buildMemoryFiles(config, store, cwd, undefined, undefined)
  const content = rows.find((r) => r.key === 'memory').content
  assert.equal(rows.find((r) => r.key === 'memory').exists, true)
  assert.ok(!content.includes('[id:deadbeef]'), '身份证是内部元数据')
  assert.ok(!content.includes('[summary:一句话]'), '摘要标记是内部元数据')
  assert.match(content, /关键事实 ABC/, '正文不能被剥掉')
}))

test('多根 scope：项目行带 root 与 workspaceKey，bot/global 行不带', () => withTab(({ store, config, cwd }) => {
  const scope = {
    workspaceId: 'ws1', workspaceKey: 'abc123',
    roots: [{ path: cwd }], current: cwd, ambiguous: false,
  }
  const rows = buildMemoryFiles(config, store, cwd, { session: { header: { cwd } } }, scope)
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
  for (const key of ['project', 'key', 'archive-key']) {
    assert.equal(byKey[key].workspaceKey, 'abc123', key)
    assert.deepEqual(byKey[key].root, { path: cwd }, key)
  }
  assert.equal(byKey.bot.root, undefined)
  assert.equal(byKey.memory.root, undefined)
}))
