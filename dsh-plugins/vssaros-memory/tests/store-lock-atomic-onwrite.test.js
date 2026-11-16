/**
 * 记忆「记录」的底层保证：锁 / 原子写 / 写后钩子。
 * 单跑：node --test tests/store-lock-atomic-onwrite.test.js
 *
 * store.test.js 覆盖了 drift guard 与 add/replace，但 withLock 的重入与异常
 * 释放、write 的 tmp 残留、onWrite 抛错不影响写入都没有独立断言；
 * vssaros-bot-history.test.js 的 onWrite 用例被 gitAvailable() 整片跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, withLock, isStaleLock } from '../lib/store.js'

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-lock-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('withLock：同目录嵌套重入不死锁，返回值透传', () => withTmp((dir) => {
  const value = withLock(dir, () => withLock(dir, () => 42))
  assert.equal(value, 42)
  assert.equal(isStaleLock(join(dir, '.memory.lock')), false, '锁文件应已释放')
}))

test('withLock：临界区抛错后仍释放锁，下一次可立即获取', () => withTmp((dir) => {
  assert.throws(() => withLock(dir, () => { throw new Error('boom') }), /boom/)
  assert.equal(withLock(dir, () => 'ok'), 'ok')
  assert.equal(readdirSync(dir).some((n) => n === '.memory.lock'), false, '不能残留锁文件')
}))

test('isStaleLock：死进程 pid 判 stale、活 pid 判有效、文件不存在判不 stale', () => withTmp((dir) => {
  const lock = join(dir, '.memory.lock')
  writeFileSync(lock, JSON.stringify({ pid: 99999999 }), 'utf8')
  assert.equal(isStaleLock(lock), true, '持有者已死 ⇒ 残留锁应立即清除')
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), 'utf8')
  assert.equal(isStaleLock(lock), false, '持有者活着 ⇒ 锁有效')
  rmSync(lock, { force: true })
  assert.equal(isStaleLock(lock), false, '文件不存在 ⇒ 不 stale')
}))

test('write：原子替换不留 .tmp.<pid>，磁盘内容等于序列化结果', () => withTmp((dir) => {
  const store = new MemoryStore(dir)
  store.write('memory', ['A', 'B'], undefined)
  const files = readdirSync(dir)
  assert.ok(!files.some((n) => n.includes('.tmp.')), `不应残留临时文件：${files.join(',')}`)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), 'A\n§\nB\n')
}))

test('onWrite：每次 write 调用一次；钩子抛错不影响记忆落盘', () => withTmp((dir) => {
  const calls = []
  const store = new MemoryStore(dir, {
    onWrite: (target, path) => {
      calls.push({ target, path })
      throw new Error('history backend down')
    },
  })
  store.write('memory', ['事实 A'], undefined)
  store.write('user', ['事实 B'], undefined)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((c) => c.target), ['memory', 'user'])
  assert.deepEqual(store.entriesOf('memory'), ['事实 A'])
  assert.deepEqual(store.entriesOf('user'), ['事实 B'])
}))

test('连续 add 不丢条目，且每次都经过写后钩子', () => withTmp((dir) => {
  const calls = []
  const store = new MemoryStore(dir, {
    injectionScan: false,
    onWrite: (target) => calls.push(target),
  })
  for (let i = 0; i < 8; i++) {
    const out = store.add('memory', `事实 ${i}`, undefined)
    assert.equal(out.ok, true, JSON.stringify(out))
  }
  assert.equal(store.entriesOf('memory').length, 8)
  assert.equal(calls.length, 8)
}))

test('并发（同步交错）add 到同一轨：锁保证顺序与完整性', () => withTmp((dir) => {
  const store = new MemoryStore(dir, { injectionScan: false })
  const results = []
  for (let i = 0; i < 5; i++) {
    withLock(dir, () => {
      results.push(store.add('memory', `并发 ${i}`, undefined).ok)
    })
  }
  assert.ok(results.every(Boolean))
  const entries = store.entriesOf('memory')
  assert.equal(entries.length, 5)
  for (let i = 0; i < 5; i++) assert.ok(entries[i].includes(`并发 ${i}`), '顺序不应被打乱')
}))
