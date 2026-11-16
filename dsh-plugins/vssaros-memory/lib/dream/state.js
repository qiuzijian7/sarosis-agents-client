/**
 * vssaros-memory/dream — 运行状态（原子写 / 失败保留窗口 / 防重入）。
 *
 * 对齐官方 dreaming_nightly.py：state["last_run"] 只在整轮成功时推进；
 * 失败的一夜保留同一窗口，次日重取同一批会话（不补跑、不跳过）。
 *
 * @module vssaros-memory/dream/state
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_RUNS = 30

function defaultState() {
  return { last_run: null, last_success: null, running: false, run_id: null, runs: [] }
}

/** 坏 JSON 回落默认，并留一份 .bad 副本便于诊断（不静默吞）。 */
export function readState(file) {
  if (!file || !existsSync(file)) return defaultState()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { ...defaultState(), ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    try {
      const raw = readFileSync(file)
      writeFileSync(`${file}.bad.${Date.now()}`, raw)
    } catch {
      // 留证失败也不阻塞回落
    }
    return defaultState()
  }
}

/**
 * Windows 上 rename 覆盖已存在文件会偶发 EPERM / EBUSY / EACCES（杀软、
 * 索引服务短暂持锁）。重试几轮即可，失败时清掉 tmp 再抛，不留半成品。
 * 同 dsh-plugins/vssaros-agents/lib/atomicWrite.js 的 renameWithRetry 口径。
 */
function renameWithRetry(from, to, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      if (['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) && i < attempts - 1) {
        const until = Date.now() + 20 * (i + 1)
        while (Date.now() < until) { /* 等锁释放 */ }
        continue
      }
      try { rmSync(from, { force: true }) } catch { /* 清理失败不掩盖原错误 */ }
      throw error
    }
  }
}

/** 原子写：tmp + rename，绝不留下半成品。 */
export function writeState(file, state) {
  if (!file) throw new Error('writeState: 需要 stateFile')
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameWithRetry(tmp, file)
}

/** 领取一轮；已在跑就拒绝（skip-if-running），不改已有 run_id。 */
export function beginRun(file, { at = new Date().toISOString() } = {}) {
  const state = readState(file)
  if (state.running) return { ok: false, reason: 'already-running', state, runId: null }
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  state.running = true
  state.run_id = runId
  state.started_at = at
  writeState(file, state)
  return { ok: true, state, runId }
}

/**
 * 收尾：无论成败都释放 running；**只有 ok 才推进 last_run / last_success**。
 * @returns {object} 落盘后的 state
 */
export function finishRun(file, { ok, at = new Date().toISOString(), runId = null, reason = null } = {}) {
  const state = readState(file)
  const id = runId ?? state.run_id
  state.running = false
  state.run_id = null
  if (ok) {
    state.last_run = at
    state.last_success = at
  }
  const record = { id, ok: Boolean(ok), at }
  if (reason) record.reason = reason
  state.runs = [record, ...(Array.isArray(state.runs) ? state.runs : [])].slice(0, MAX_RUNS)
  writeState(file, state)
  return state
}
