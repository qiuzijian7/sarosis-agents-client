/**
 * 记忆「读取 / 记录」基础：六轨 × 写入 → 读回 → 磁盘格式往返矩阵。
 * 单跑：node --test tests/store-six-track-roundtrip.test.js
 *
 * 现有 store.test.js 覆盖 parse/serialize 纯函数与单轨操作，但没有一次把
 * memory/user/key/bot/daily/project 六轨逐轨跑完「locate → write → entriesOf
 * → readRaw → isCanonical → parseEntries」这条闭环，也没钉住定位边界。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryStore, ENTRY_DELIMITER, parseEntries, serializeEntries, isCanonical, withLock,
} from '../lib/store.js'

/**
 * 生产路径里所有写都在 withLock(loc.dir, …) 内（锁会 mkdir 目录），
 * write() 本身不建父目录 —— 这里照真实调用链包一层，避免造出假 ENOENT。
 */
function writeTrack(store, target, entries, agent) {
  const loc = store.locate(target, agent)
  const write = store.write.bind(store)
  return withLock(loc.dir, () => write(target, entries, agent))
}

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-sixtrack-'))
  try {
    const store = new MemoryStore(dir, {
      botKeyResolver: () => 'code-explorer',
      projectDirResolver: () => join(dir, 'projects', 'p-test'),
    })
    const agent = { id: 'a1', session: { id: 's1', header: { cwd: '/work/p' } } }
    return fn({ dir, store, agent })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const TRACKS = ['memory', 'user', 'key', 'bot', 'daily', 'project']

test('locate：六轨都能定位到 {dir,file}，无效轨抛错', () => withStore(({ store, agent }) => {
  for (const target of TRACKS) {
    const loc = store.locate(target, agent)
    assert.ok(loc, `${target} 应可定位`)
    assert.equal(typeof loc.dir, 'string')
    assert.equal(typeof loc.file, 'string')
    assert.ok(loc.file.endsWith('.md'), `${target} 文件名应以 .md 结尾`)
  }
  assert.throws(() => store.locate('system-prompt', agent), /无效的记忆轨/)
}))

test('locate 边界：project/key 缺 cwd、bot 非 Bot 会话都返回 undefined', () => withStore(({ dir }) => {
  const store = new MemoryStore(dir, {
    botKeyResolver: () => null,
    projectDirResolver: () => join(dir, 'projects', 'p-test'),
  })
  assert.equal(store.locate('project', undefined), undefined)
  assert.equal(store.locate('key', { session: { header: {} } }), undefined)
  assert.equal(store.locate('bot', { session: { header: {} } }), undefined)
  assert.throws(() => store.resolveTarget('key', undefined), /无法定位记忆轨/)
}))

test('六轨逐轨往返：write → entriesOf → readRaw → canonical → parseEntries', () => withStore(({ store, agent }) => {
  for (const target of TRACKS) {
    const entries = [`${target} 事实 A`, `${target} 事实 B`]
    writeTrack(store, target, entries, agent)
    assert.deepEqual(store.entriesOf(target, agent), entries, `${target} 读回应与写入一致`)

    const raw = store.readRaw(target, agent)
    assert.equal(raw.text, serializeEntries(entries), `${target} 磁盘文本应为 canonical 序列`)
    assert.equal(isCanonical(raw.text), true, `${target} 必须可逐字节往返`)
    assert.deepEqual(parseEntries(raw.text), entries, `${target} parseEntries 应还原条目`)
    assert.equal(raw.text.includes(ENTRY_DELIMITER), true, `${target} 应含 § 分隔符`)
  }
}))

test('六轨互不串写：写 memory 不产生/改动其它轨文件', () => withStore(({ dir, store, agent }) => {
  writeTrack(store, 'memory', ['只有长期记忆'], agent)
  const memPath = join(dir, 'MEMORY.md')
  assert.equal(readFileSync(memPath, 'utf8'), serializeEntries(['只有长期记忆']))
  assert.deepEqual(store.entriesOf('user', agent), [], 'user 轨应保持空')
  assert.deepEqual(store.entriesOf('daily', agent), [], 'daily 轨应保持空')
  assert.equal(existsSync(join(dir, 'USER.md')), false, '不该凭空建出 USER.md')
}))

test('空轨：entriesOf 返回空数组，readRaw 为空文本且 canonical', () => withStore(({ store, agent }) => {
  for (const target of TRACKS) {
    assert.deepEqual(store.entriesOf(target, agent), [], `${target} 初始应为空`)
    const raw = store.readRaw(target, agent)
    assert.equal(raw.text, '', `${target} 空文件文本`)
    assert.equal(isCanonical(raw.text), true, '空文件视为合法空存储')
  }
}))

test('peekExact 返回磁盘原文（不剥离 [id:] / [summary:] 元数据）', () => withStore(({ store, agent }) => {
  const entry = '[id:abc12345] [2026-11-12] [summary:一句话] 关键事实 ABC'
  writeTrack(store, 'key', [entry], agent)
  const peeked = store.peekExact('key', entry, agent)
  assert.equal(peeked.ok, true)
  assert.equal(peeked.entry, entry, '必须原样返回磁盘文本，供精确操作使用')
}))

test('多条目写入后顺序稳定，分隔符不会吞掉相邻空行', () => withStore(({ store, agent }) => {
  const entries = ['第一行\n第二行', '条目 B', '条目 C']
  writeTrack(store, 'memory', entries, agent)
  assert.deepEqual(store.entriesOf('memory', agent), entries)
  assert.equal(isCanonical(store.readRaw('memory', agent).text), true)
}))
