/**
 * vssaros-memory/dream — P1 受控写入（apply 通道）。
 *
 * 纪律（全部有本仓依据）：
 * - 只经 MemoryStore 公开方法（add / replace / removeExact / write），**禁止直接改 .md**
 *   （§ 分隔符 + drift guard 会拒写；memory-consolidate/SKILL.md 钉死）。
 * - 默认 dry-run，`apply === true` 才落盘；POST /api/dream/apply 必须显式。
 * - 同轨串行 withLock；写前快照落 <runDir>/snapshot/<target>.json；写后读回校验。
 * - archive 优先：原文先入 ArchiveStore（可移回），再 removeExact；绝不调用 remove/delete。
 * - 事实不守恒 / 读回不含新内容 ⇒ 用 store.write(before) 回滚，整批判失败。
 * - 注入四轨（memory/user/key/bot）做实质变化去重，保护 renderSnapshot 的 LLM 前缀缓存；
 *   daily / project 不注入，可自由写。
 *
 * @module vssaros-memory/dream/writer
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withLock } from '../store.js'
import { conservationCheck, normalizeProposals } from './proposal.js'

/** 会全文进 system prompt 的四轨（写它们会打断前缀缓存）。 */
export const INJECTED_TARGETS = new Set(['memory', 'user', 'key', 'bot'])
const TARGETS = new Set([...INJECTED_TARGETS, 'daily', 'project', 'archive'])
const ARCHIVE_TARGETS = new Set(['memory', 'user', 'key'])
const EXECUTABLE = new Set(['add', 'replace', 'archive'])

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, '')
}

export function snapshotPathOf(runDir, target) {
  return join(runDir, 'snapshot', `${target}.json`)
}

function writeSnapshot(runDir, target, before, at) {
  if (!runDir) return
  const file = snapshotPathOf(runDir, target)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ target, before, at }, null, 2)}\n`, 'utf8')
}

function isDuplicate(store, target, agent, content) {
  const key = normalize(content)
  if (!key) return false
  return store.entriesOf(target, agent).some((row) => normalize(row).includes(key))
}

function readbackHas(store, target, agent, content) {
  const key = normalize(content)
  return store.entriesOf(target, agent).some((row) => normalize(row).includes(key))
}

function peekOriginal(store, target, match, agent) {
  if (typeof store.peek === 'function') return store.peek(target, match, agent)?.entry ?? null
  if (typeof store.peekExact === 'function') return store.peekExact(target, match, agent)?.entry ?? null
  return null
}

/**
 * @param {object} options
 * @param {Array<object>} options.proposals  runDream 产出的已复核提案
 * @param {object} options.store             MemoryStore（或同形假件）
 * @param {object} [options.archive]         ArchiveStore，可空（空则只留快照）
 * @param {object} [options.agent]           会话视角（project/key/bot 定位用）
 * @param {string} [options.runDir]          <memoryDir>/dream/runs/<runId>
 * @param {boolean} [options.apply=false]    必须显式 true 才写
 * @returns {{ok:boolean, dryRun:boolean, applied:number, skipped:Array, preview:Array, changes:Array, reason:string|null, snapshots:Array}}
 */
export function applyProposals(options = {}) {
  const {
    proposals = [], store, archive = null, agent = {}, runDir = null,
    apply = false, lockDir = null, now = () => new Date().toISOString(),
  } = options
  const result = {
    ok: false, dryRun: !apply, applied: 0, skipped: [], preview: [],
    changes: [], reason: null, snapshots: [],
  }
  if (!store || typeof store.entriesOf !== 'function') {
    result.reason = 'no-store'
    return result
  }

  const { accepted, rejected } = normalizeProposals(proposals)
  for (const item of rejected) {
    result.skipped.push({ op: item.proposal?.op ?? null, reason: item.reason })
  }

  const executable = []
  for (const p of accepted) {
    if (!EXECUTABLE.has(p.op)) {
      result.skipped.push({ op: p.op, reason: `P1 不执行 ${p.op}（仅 add / replace / archive）` })
      continue
    }
    if (!TARGETS.has(p.target)) {
      result.skipped.push({ op: p.op, reason: `非法目标轨 ${String(p.target)}` })
      continue
    }
    // 归档优先、禁用删除是 proposal.js 的闭合集纪律；这里再挡一次。
    if (apply && p.op === 'add' && INJECTED_TARGETS.has(p.target) && isDuplicate(store, p.target, agent, p.content)) {
      result.skipped.push({ op: p.op, reason: '注入轨实质变化去重（内容已存在）' })
      continue
    }
    executable.push(p)
  }

  if (!apply) {
    result.preview = executable.map((p) => ({
      op: p.op, target: p.target, content: p.content ?? null,
      match: p.match ?? null, evidence: p.evidence,
    }))
    result.ok = true
    return result
  }

  const groups = new Map()
  for (const p of executable) {
    if (!groups.has(p.target)) groups.set(p.target, [])
    groups.get(p.target).push(p)
  }

  const at = now()
  for (const [target, group] of groups) {
    const lockAt = lockDir ?? (runDir ? join(runDir, 'locks', target) : null)
    if (!lockAt) {
      result.ok = false
      result.reason = 'no-lock-dir'
      return result
    }
    const archived = []
    const preserved = []
    try {
      withLock(lockAt, () => {
        const before = store.entriesOf(target, agent)
        writeSnapshot(runDir, target, before, at)
        if (runDir) result.snapshots.push(snapshotPathOf(runDir, target))

        for (const p of group) {
          let outcome
          if (p.op === 'add') {
            outcome = store.add(target, p.content, agent)
          } else if (p.op === 'replace') {
            // 被替换的原文进「保留集」：写前快照已留底，能进 ArchiveStore 的轨先归档。
            // 否则「修正旧结论」这类提案会被 conservationCheck 误判为丢事实。
            const original = peekOriginal(store, target, p.match, agent)
            if (original) {
              preserved.push(original)
              if (archive && ARCHIVE_TARGETS.has(target)) {
                archive.append(target, original, agent?.session?.header?.cwd)
              }
            }
            outcome = store.replace(target, p.match, p.content, agent)
          } else {
            const original = peekOriginal(store, target, p.match, agent)
            if (original && archive && ARCHIVE_TARGETS.has(target)) {
              archive.append(target, original, agent?.session?.header?.cwd)
              archived.push(original)
            }
            outcome = original
              ? store.removeExact(target, original, agent)
              : { ok: false, reason: 'noMatch' }
          }
          if (!outcome || outcome.ok === false) {
            throw Object.assign(new Error(String(outcome?.reason ?? 'write-failed')), { dreamReason: 'write-failed' })
          }
          result.applied++
          result.changes.push({ op: p.op, target, match: p.match ?? null, evidence: p.evidence })
        }

        const after = store.entriesOf(target, agent)
        // 归档的原文仍「在」（可移回），算作事实保留，否则 archive 类提案会被误判丢事实。
        const conservation = conservationCheck(before, after.concat(archived, preserved))
        if (!conservation.ok) {
          store.write(target, before, agent)
          throw Object.assign(new Error('conservation-failed'), { dreamReason: 'conservation-failed' })
        }
        for (const p of group) {
          if (p.op === 'archive') continue
          if (!readbackHas(store, target, agent, p.content)) {
            store.write(target, before, agent)
            throw Object.assign(new Error('readback-failed'), { dreamReason: 'readback-failed' })
          }
        }
      })
    } catch (error) {
      result.ok = false
      result.reason = error.dreamReason ?? 'write-failed'
      result.applied = 0
      result.changes = []
      return result
    }
  }

  result.ok = true
  return result
}
