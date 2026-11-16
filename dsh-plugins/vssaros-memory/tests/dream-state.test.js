/**
 * Dreaming P0 — 运行状态：失败保留窗口、skip-if-running、原子写。
 * 单跑：node --test tests/dream-state.test.js
 *
 * 对齐官方 dreaming_nightly.py：state["last_run"] 只在整轮成功时推进；
 * 失败的一夜保留同一窗口，次日重取同一批会话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginRun, finishRun, readState, writeState } from '../lib/dream/state.js'

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-state-'))
  try { return fn(join(dir, 'state.json')) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('readState：文件不存在时返回安全默认值', () => withTmp((file) => {
  assert.deepEqual(readState(file), {
    last_run: null, last_success: null, running: false, run_id: null, runs: [],
  })
}))

test('readState：损坏 JSON 回落默认且保留一份可诊断的坏文件副本', () => withTmp((file) => {
  writeFileSync(file, '{ 这不是 JSON')
  const state = readState(file)
  assert.equal(state.last_run, null)
  assert.equal(state.running, false)
  assert.ok(readdirSync(join(file, '..')).some((n) => n.includes('.bad')), '坏文件要留证，不能静默吞掉')
}))

test('writeState：原子写，不残留 tmp 文件', () => withTmp((file) => {
  writeState(file, { last_run: '2026-11-12T01:00:00Z', running: false, runs: [] })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).last_run, '2026-11-12T01:00:00Z')
  assert.ok(!readdirSync(join(file, '..')).some((n) => n.includes('.tmp.')), '原子写不能留下半成品')
}))

test('beginRun：首次领取成功，running 期间第二次被拒绝（防重叠）', () => withTmp((file) => {
  const first = beginRun(file, { at: '2026-11-12T01:00:00Z' })
  assert.equal(first.ok, true)
  assert.equal(first.state.running, true)
  const second = beginRun(file, { at: '2026-11-12T01:00:01Z' })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'already-running')
  assert.equal(readState(file).run_id, first.state.run_id, '拒绝重入不能改掉已有 run_id')
}))

test('finishRun 成功：推进 last_run / last_success，清除 running，留运行记录', () => withTmp((file) => {
  beginRun(file, { at: '2026-11-12T01:00:00Z' })
  const state = finishRun(file, { ok: true, at: '2026-11-12T01:02:30Z', runId: 'run-1' })
  assert.equal(state.last_run, '2026-11-12T01:02:30Z')
  assert.equal(state.last_success, '2026-11-12T01:02:30Z')
  assert.equal(state.running, false)
  assert.equal(state.runs[0].id, 'run-1')
}))

test('finishRun 失败：last_run 不推进（窗口保留），但 running 必须释放', () => withTmp((file) => {
  beginRun(file, { at: '2026-11-12T01:00:00Z' })
  const state = finishRun(file, { ok: false, at: '2026-11-12T01:02:30Z', runId: 'run-failed', reason: 'incomplete' })
  assert.equal(state.last_run, null, '失败的一夜不能推进窗口，否则会话被永久跳过')
  assert.equal(state.last_success, null)
  assert.equal(state.running, false, '不释放会让以后每一轮都 already-running')
  assert.equal(state.runs[0].ok, false)
  assert.equal(state.runs[0].reason, 'incomplete')
}))

test('失败后下一轮仍能领取同一窗口', () => withTmp((file) => {
  beginRun(file, { at: '2026-11-12T01:00:00Z' })
  finishRun(file, { ok: false, at: '2026-11-12T01:02:00Z', runId: 'r1', reason: 'refuter-absent' })
  const next = beginRun(file, { at: '2026-11-13T01:00:00Z' })
  assert.equal(next.ok, true)
  assert.equal(readState(file).last_run, null)
}))

test('runs 记录有上限，不无限增长', () => withTmp((file) => {
  for (let i = 0; i < 45; i++) {
    beginRun(file, { at: `2026-11-${String(i + 1).padStart(2, '0')}T01:00:00Z` })
    finishRun(file, { ok: true, at: `2026-11-${String(i + 1).padStart(2, '0')}T01:01:00Z`, runId: `r${i}` })
  }
  assert.ok(readState(file).runs.length <= 30)
  assert.equal(existsSync(file), true)
}))
