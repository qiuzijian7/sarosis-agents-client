/**
 * vssaros-memory/transcript — 会话转录导出（P0：只读、一份会话一个 txt）。
 *
 * 递归扫 <dshHome>/sessions 下的 session.v4.jsonl.zstd，按窗口增量挑「已结束且
 * 含用户消息」的会话；绝不写 <memoryDir> 下的六轨记忆文件。
 *
 * 跳过规则与官方 dreaming_nightly.py 一致：仍在运行的会话不导（下一轮也不
 * 回看），空会话不占分组名额。失败/跳过都进 skipped 清单，计数由调用方核对。
 *
 * @module vssaros-memory/transcript/export
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { decodeZstdFrames, parseJsonl } from './decode.js'
import { redactText } from './redact.js'
import { renderTranscript, safeName } from './render.js'

const LOG_NAME = 'session.v4.jsonl.zstd'
const FINISHED = new Set(['idle', 'terminated'])

async function collectSessionLogs(root, out) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return // 目录不存在 / 无权限 ⇒ 本轮没有可导的会话，不编造
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      await collectSessionLogs(full, out)
    } else if (entry.isFile() && entry.name === LOG_NAME) {
      out.push({ path: full, id: basename(dirname(full)) })
    }
  }
}

/** 判定一份会话是否可导（纯函数，便于单测）。 */
export function exportableOf(events) {
  const list = Array.isArray(events) ? events : []
  const session = list.find((event) => event?.type === 'session')
  const status = String(session?.status ?? '').toLowerCase()
  if (status && !FINISHED.has(status)) return { ok: false, reason: '会话仍在运行' }
  const hasUser = list.some((event) => {
    const type = String(event?.type ?? '')
    if (type !== 'user.message' && type !== 'user') return false
    const text = event.content ?? event.text
    if (typeof text === 'string') return text.trim().length > 0
    if (Array.isArray(text)) return text.some((part) => String(part?.text ?? part ?? '').trim().length > 0)
    return false
  })
  if (!hasUser) return { ok: false, reason: '空会话（无用户消息）' }
  return { ok: true }
}

/**
 * @param {object} options
 * @param {string} options.dshHome  Host 数据根（sessions/ 的父目录）
 * @param {string} options.outDir   本轮 transcripts/ 目录
 * @param {number} [options.since]  窗口起点（ms，含）
 * @param {number} [options.until]  窗口终点（ms，含）
 * @param {number} [options.maxFiles=500]
 * @param {string} [options.memoryDir] 仅用于校验「不写记忆」的语义，不写它
 * @returns {Promise<{files:Array, skipped:Array, manifest:object}>}
 */
export async function exportSessions(options = {}) {
  const {
    dshHome, outDir, memoryDir,
    since = 0,
    until = Date.now(),
    maxFiles = 500,
    decode = decodeZstdFrames,
    redact = redactText,
    render = renderTranscript,
  } = options
  if (!dshHome || !outDir) throw new Error('exportSessions: 需要 dshHome 与 outDir')

  await mkdir(outDir, { recursive: true })
  const candidates = []
  await collectSessionLogs(join(dshHome, 'sessions'), candidates)
  candidates.sort((a, b) => a.path.localeCompare(b.path))

  const files = []
  const skipped = []
  for (const candidate of candidates) {
    const info = await stat(candidate.path)
    if (info.mtimeMs < since || info.mtimeMs > until) continue
    if (files.length >= maxFiles) {
      skipped.push({ name: candidate.id, why: '超过 maxFiles 上限' })
      continue
    }
    const text = await decode(await readFile(candidate.path))
    const events = parseJsonl(text)
    const verdict = exportableOf(events)
    if (!verdict.ok) {
      skipped.push({ name: candidate.id, why: verdict.reason })
      continue
    }
    const session = events.find((event) => event?.type === 'session') ?? {}
    const rendered = render(events, {
      sessionId: candidate.id,
      title: session.title,
      agent: session.agent?.name ?? session.agent,
      createdAt: session.created_at,
    })
    const { text: safeText, hits } = redact(rendered)
    const name = `${safeName(candidate.id)}.txt`
    const path = join(outDir, name)
    await writeFile(path, safeText, 'utf8')
    files.push({ name, path, size: Buffer.byteLength(safeText), redactions: hits.length })
  }

  return {
    files,
    skipped,
    manifest: {
      expected: files.length,
      processed: files.length,
      skipped: skipped.length,
      // P0 只读：memoryDir 只记录、不触碰。
      memoryDirTouched: false,
      memoryDir: memoryDir ?? null,
    },
  }
}
