/**
 * vssaros-memory — Bot 记忆版本历史（VsSaros 2026-11-05「记忆收敛」S2）。
 *
 * 原来 @vssaros/dsh-agents 给每个 Bot 的 MEMORY.md 建一个 git 仓库（回合末自动提交、可回滚）；
 * Bot 记忆并入本插件的 bot 轨（`<memoryDir>/bots/<botKey>/`）后，这里给同一个目录做同样的事：
 *   - 写入后防抖提交（store 的 onWrite 钩子 → scheduleCommit；1.5s 内的多次写入合成一条）；
 *   - log / 与当前内容按条目对比 / 回滚（回滚前先把当前状态落一条提交，再写回旧内容并再提交一条
 *     ⇒ 历史只追加，回滚本身也能再回滚）；
 *   - 打包整个历史（git bundle，导出 Bot 时带上）。
 * 旧 VA 仓库的格式不同（Markdown 列表，含模板注释）没法续写，导入时另存为只读的
 * `legacy-history.bundle`（见 bundleLegacyHistory）。
 *
 * 只用 git 子进程，**异步** + `windowsHide`；git 不可用时整个功能如实报「不可用」，不影响记忆读写。
 * 同一目录的 git 操作串行（Promise 链），防止两个提交互相抢 index.lock。
 * @module vssaros-memory/bot-history
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEntries, serializeEntries, withLock } from './store.js'

export const HISTORY_FILE = 'MEMORY.md'
export const LEGACY_BUNDLE = 'legacy-history.bundle'
// *.bundle：旧版留档 legacy-history.bundle、导入的 imported-history-*.bundle 都不进本机历史
const GITIGNORE = ['.memory.lock', '*.tmp.*', '*.bak.*', '*.bundle', ''].join('\n')
// 提交身份与行为全部用 -c 传，不写任何 git 配置（用户全局配置里的签名 / autocrlf 不影响这里）。
const GIT_OPTS = [
  '-c', 'user.name=VsSaros Memory', '-c', 'user.email=memory@vssaros.local',
  '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false',
  '-c', 'init.defaultBranch=main',
]
const REV_RE = /^[0-9a-f]{4,40}$/i

/** 跑一条 git；永不 reject（失败看 code）。 */
export function runGit(cwd, args, { timeout = 20_000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', [...GIT_OPTS, ...args], {
      cwd, windowsHide: true, timeout, maxBuffer: 32 << 20, encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
    })
  })
}

let gitProbe = null
/** git 是否可用（进程内只探测一次）。 */
export function gitAvailable() {
  gitProbe ??= runGit(tmpdir(), ['--version'], { timeout: 10_000 }).then((r) => r.code === 0)
  return gitProbe
}

const fmtDate = (iso) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso ?? '')
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 历史版本（oldText）对比当前（curText），按条目：
 *   del = 历史版有、当前没有（回滚会恢复）；add = 当前有、历史版没有（回滚会移除）；same。
 * 与 dsh-agents 旧接口 `diff` 同形（{ added, removed, rows }），外壳的历史面板直接复用。
 */
export function diffEntries(oldText, curText) {
  const oldEntries = parseEntries(oldText ?? '')
  const curEntries = parseEntries(curText ?? '')
  const cur = new Set(curEntries)
  const old = new Set(oldEntries)
  const rows = []
  for (const e of oldEntries) rows.push({ type: cur.has(e) ? 'same' : 'del', text: e })
  for (const e of curEntries) if (!old.has(e)) rows.push({ type: 'add', text: e })
  return {
    added: rows.filter((r) => r.type === 'add').length,
    removed: rows.filter((r) => r.type === 'del').length,
    rows,
  }
}

/**
 * @param {{ enabled?: boolean, delayMs?: number }} [options]
 */
export function createBotHistory(options = {}) {
  const enabled = options.enabled !== false
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 1500
  const chains = new Map()
  const timers = new Map()

  const serial = (dir, job) => {
    const prev = chains.get(dir) ?? Promise.resolve()
    const next = prev.then(job, job)
    chains.set(dir, next.catch(() => undefined))
    return next
  }

  const available = async () => enabled && await gitAvailable()

  async function ensureRepo(dir) {
    mkdirSync(dir, { recursive: true })
    if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), GITIGNORE)
    if (existsSync(join(dir, '.git'))) return true
    const r = await runGit(dir, ['init', '-q'])
    if (r.code !== 0) throw new Error(`git init 失败：${r.stderr.trim() || r.code}`)
    return true
  }

  const hasHead = async (dir) => (await runGit(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0

  async function readAt(dir, rev) {
    const r = await runGit(dir, ['show', `${rev}:${HISTORY_FILE}`])
    if (r.code === 0) return r.stdout
    if (/does not exist|exists on disk, but not in/i.test(r.stderr)) return ''
    throw new Error(`读取版本 ${rev} 失败：${r.stderr.trim() || r.code}`)
  }

  const readCurrent = (dir) => {
    const f = join(dir, HISTORY_FILE)
    return existsSync(f) ? readFileSync(f, 'utf8') : ''
  }

  /** 立即提交（无改动返回 null）。只能在 serial 里调。 */
  async function commitNow(dir, subject) {
    if (!existsSync(join(dir, HISTORY_FILE)) && !existsSync(join(dir, '.git'))) return null
    await ensureRepo(dir)
    await runGit(dir, ['add', '-A'])
    if ((await runGit(dir, ['diff', '--cached', '--quiet'])).code === 0) return null
    let message = subject
    if (!message) {
      if (await hasHead(dir)) {
        const d = diffEntries(await readAt(dir, 'HEAD'), readCurrent(dir))
        message = `更新 Bot 记忆：新增 ${d.added} 条，删除 ${d.removed} 条`
      } else {
        message = `初始版本（${parseEntries(readCurrent(dir)).length} 条）`
      }
    }
    const r = await runGit(dir, ['commit', '-q', '--no-verify', '-m', message])
    if (r.code !== 0) throw new Error(`git commit 失败：${r.stderr.trim() || r.code}`)
    return (await runGit(dir, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
  }

  function clearTimer(dir) {
    const t = timers.get(dir)
    if (t) clearTimeout(t)
    timers.delete(dir)
  }

  /** 写入后调用：防抖提交。 */
  function scheduleCommit(dir) {
    if (!enabled) return
    clearTimer(dir)
    const t = setTimeout(() => {
      timers.delete(dir)
      void serial(dir, async () => { if (await available()) await commitNow(dir) }).catch(() => undefined)
    }, delayMs)
    t.unref?.()
    timers.set(dir, t)
  }

  /** 把待提交的改动立刻落成提交（读历史前调用，保证看到的是最新的）。 */
  function flush(dir) {
    clearTimer(dir)
    return serial(dir, async () => (await available() ? commitNow(dir) : null))
  }

  async function log(dir, limit = 15) {
    if (!(await available())) return { enabled: false, log: [], legacy: existsSync(join(dir, LEGACY_BUNDLE)) }
    await flush(dir)
    const n = Math.max(1, Math.min(200, Number(limit) || 15))
    const r = existsSync(join(dir, '.git'))
      ? await serial(dir, () => runGit(dir, ['log', `-n${n}`, '--format=%h%x1f%cI%x1f%s']))
      : { code: 1, stdout: '' }
    const rows = r.code === 0
      ? r.stdout.split('\n').filter(Boolean).map((line) => {
        const [hash, iso, subject] = line.split('\x1f')
        return { hash, date: fmtDate(iso), subject }
      })
      : []
    return { enabled: true, log: rows, legacy: existsSync(join(dir, LEGACY_BUNDLE)) }
  }

  async function compare(dir, rev) {
    if (!REV_RE.test(String(rev ?? ''))) throw new Error(`版本号不合法：${String(rev)}`)
    if (!(await available())) throw new Error('git 不可用，无法读取历史版本')
    await flush(dir)
    const text = await serial(dir, () => readAt(dir, rev))
    return { rev, diff: diffEntries(text, readCurrent(dir)) }
  }

  async function restore(dir, rev) {
    if (!REV_RE.test(String(rev ?? ''))) throw new Error(`版本号不合法：${String(rev)}`)
    if (!(await available())) throw new Error('git 不可用，无法回滚')
    clearTimer(dir)
    return serial(dir, async () => {
      const before = await commitNow(dir, '回滚前的状态')
      const text = await readAt(dir, rev)
      withLock(dir, () => {
        const f = join(dir, HISTORY_FILE)
        const tmp = `${f}.tmp.${process.pid}`
        writeFileSync(tmp, serializeEntries(parseEntries(text)))
        renameSync(tmp, f)
      })
      const after = await commitNow(dir, `回滚到 ${rev}`)
      return { ok: true, before, after, rev }
    })
  }

  /** 整个历史打成 git bundle（没有提交返回 null）。 */
  async function bundle(dir) {
    if (!(await available())) return null
    await flush(dir)
    if (!existsSync(join(dir, '.git'))) return null
    return serial(dir, async () => {
      if (!(await hasHead(dir))) return null
      const out = join(tmpdir(), `vsm-bot-history-${process.pid}-${Date.now()}.bundle`)
      const r = await runGit(dir, ['bundle', 'create', out, '--all'])
      if (r.code !== 0) return null
      try { return readFileSync(out) } finally { rmSync(out, { force: true }) }
    })
  }

  function dispose() {
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  }

  return { enabled, available, ensureRepo, scheduleCommit, flush, log, compare, restore, bundle, dispose }
}

/**
 * 旧 VA 记忆目录自带的 git 历史 → `<dest>/legacy-history.bundle`（只读留档，幂等；失败不抛）。
 * @returns {Promise<'none'|'exists'|'created'|'failed'>}
 */
export async function bundleLegacyHistory(srcDir, destDir) {
  try {
    if (!existsSync(join(srcDir, '.git'))) return 'none'
    const dest = join(destDir, LEGACY_BUNDLE)
    if (existsSync(dest)) return 'exists'
    if (!(await gitAvailable())) return 'failed'
    if ((await runGit(srcDir, ['rev-parse', '--verify', '-q', 'HEAD'])).code !== 0) return 'none'
    mkdirSync(destDir, { recursive: true })
    const tmp = `${dest}.tmp.${process.pid}`
    const r = await runGit(srcDir, ['bundle', 'create', tmp, '--all'])
    if (r.code !== 0) { rmSync(tmp, { force: true }); return 'failed' }
    renameSync(tmp, dest)
    return 'created'
  } catch {
    return 'failed'
  }
}
