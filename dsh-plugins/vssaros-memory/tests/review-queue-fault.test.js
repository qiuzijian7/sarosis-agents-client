/**
 * 记忆「记录」的审批队列：异常与边界路径。
 * 单跑：node --test tests/review-queue-fault.test.js
 *
 * api.test.js / plugin.test.js 覆盖了 approve/reject 的正常路径，但没有钉住
 * 坏 JSONL 行、重复/越界索引、归档失败时建议必须保留这些「不丢数据」契约。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SuggestionQueue, MemoryStore } from '../lib/store.js'
import {
  enqueueSuggestion, approveSuggestions, rejectSuggestions, archiveSuggestions,
} from '../lib/review.js'

function withQueue(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-queue-'))
  try {
    const file = join(dir, 'SUGGESTIONS.jsonl')
    const queue = new SuggestionQueue(file)
    const store = new MemoryStore(dir)
    return fn({ dir, file, queue, store })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('队列文件不存在 / 为空时 read() 返回空数组', () => withQueue(({ file, queue }) => {
  assert.deepEqual(queue.read(), [])
  writeFileSync(file, '', 'utf8')
  assert.deepEqual(queue.read(), [])
}))

test('坏 JSONL 行被跳过且留证，其余建议仍能读取（不整批失效）', () => withQueue(({ dir, file, queue }) => {
  const good = JSON.stringify({ target: 'memory', content: '事实 A', hits: 1 })
  writeFileSync(file, ['{ 这不是 JSON', good, JSON.stringify({ target: 'user', content: '事实 B', hits: 1 })].join('\n') + '\n', 'utf8')
  const rows = queue.read()
  assert.equal(rows.length, 2, '坏行不该让整个队列读不出来')
  assert.deepEqual(rows.map((r) => r.content), ['事实 A', '事实 B'])
  // 留证：坏行另存，不静默吞掉
  assert.ok(readdirSync(dir).some((n) => n.includes('.bad.')), '坏行应留一份可诊断副本')
}))

test('enqueueSuggestion：同义重复只累加 hits，不新增条目', () => withQueue(({ queue }) => {
  const a = enqueueSuggestion(queue, 'memory', '部署需要 token 名称', '第一次', { id: 'a1' })
  assert.equal(a.queued, 1)
  const b = enqueueSuggestion(queue, 'memory', '部署需要 token 名称', '第二次', { id: 'a1' })
  assert.equal(b.queued, 1)
  const rows = queue.read()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].hits, 2)
  assert.equal(rows[0].reason, '第二次')
}))

test('approveSuggestions：越界索引无副作用；成功后条目离开队列并落盘', () => withQueue(({ queue, store }) => {
  enqueueSuggestion(queue, 'memory', '事实 A', null, { id: 'a1' })
  const outOfRange = approveSuggestions(store, null, queue, [99], undefined, undefined, undefined)
  assert.equal(outOfRange.remaining, 1, '越界索引不该丢建议')
  assert.equal(queue.read().length, 1)

  const ok = approveSuggestions(store, null, queue, [1], undefined, undefined, undefined)
  assert.equal(ok.remaining, 0)
  assert.equal(queue.read().length, 0)
  assert.equal(store.entriesOf('memory').length, 1, '批准后应写入主轨')
}))

test('approveSuggestions：key 轨缺 cwd 写入失败时建议保留在队列', () => withQueue(({ queue, store }) => {
  enqueueSuggestion(queue, 'key', '项目关键事实', null, { id: 'a1' }) // 无 cwd
  const out = approveSuggestions(store, null, queue, [1], undefined, undefined, undefined)
  assert.equal(out.remaining, 1, '写不进去就该留着，不能静默丢')
  assert.equal(queue.read().length, 1)
}))

test('rejectSuggestions：重复索引只删一次，其余保留', () => withQueue(({ queue }) => {
  enqueueSuggestion(queue, 'memory', '事实 A', null, { id: 'a1' })
  enqueueSuggestion(queue, 'user', '事实 B', null, { id: 'a1' })
  const out = rejectSuggestions(queue, [1, 1, 2])
  assert.equal(out.removed, 2)
  assert.equal(out.remaining, 0)
  assert.deepEqual(queue.read(), [])
}))

test('archiveSuggestions：归档失败时建议不丢（可重试）', () => withQueue(({ queue }) => {
  enqueueSuggestion(queue, 'memory', '事实 A', '低优先级', { id: 'a1' })
  const brokenArchive = { append: () => ({ ok: false, message: '归档目录不可写' }) }
  const out = archiveSuggestions(brokenArchive, queue, [1])
  assert.equal(out.remaining, 1)
  assert.equal(queue.read()[0].content, '事实 A')
  assert.ok(out.lines[0].includes('归档目录不可写'), '失败原因要可见')
}))
