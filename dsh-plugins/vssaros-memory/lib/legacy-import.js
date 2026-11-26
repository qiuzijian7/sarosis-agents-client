/**
 * vssaros-memory — 旧 Bot / 工作区记忆一次性导入（VsSaros 2026-11-05「记忆收敛成一套」）。
 *
 * 以前 @vssaros/dsh-agents 自己存了两份记忆，现在并入本插件：
 *   - Bot 记忆      `<数据根>/agents/<id>/memory/MEMORY.md`（自定义 Bot）
 *                   `<数据根>/agent-memory/<id>/MEMORY.md`（内置 Bot）
 *                    → `<memoryDir>/bots/<slugify(id)>/MEMORY.md`（bot 轨）
 *   - 工作区记忆    `<数据根>/workspace-memory/<key>/MEMORY.md`
 *                    → `<memoryDir>/projects/<key>/KEY.md`（key 轨；key 与 store.workspaceKeyOf 同口径）
 * 数据根：`config.legacyAgentDataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`（与 dsh-agents 一致）。
 *
 * 规则：只追加、按正文去重（忽略日期前缀）、**不改不删源文件**（回滚开关打开后旧路径原样可用）。
 * 源文件内容变了（例如回滚期间旧路径又写过）会在下次启动补导新增的条目。
 * 记账：`<memoryDir>/legacy-agent-memory.json`（每个源文件的内容 sha1 与导入条数）。
 * @module vssaros-memory/legacy-import
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ENTRY_DELIMITER, parseEntries, serializeEntries, withLock } from './store.js'
import { BOT_KEY_RE, slugifyBotId } from './vssaros-bot.js'

export const LEGACY_LEDGER_FILE = 'legacy-agent-memory.json'
const PLACEHOLDER_RE = /^（还没有条目/
const DATE_PREFIX_RE = /^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/

/** 旧数据根（与 dsh-agents 的 dataRootOf 同优先级）。 */
export function legacyDataRootOf(config) {
  const configured = typeof config?.legacyAgentDataRoot === 'string' ? config.legacyAgentDataRoot.trim() : ''
  if (configured) return configured
  const fromEnv = typeof process.env.VSSAROS_DATA_ROOT === 'string' ? process.env.VSSAROS_DATA_ROOT.trim() : ''
  return fromEnv || join(homedir(), '.vssaros')
}

/**
 * 旧 MEMORY.md（Markdown 列表，`- [YYYY-MM-DD] 正文`）→ 条目正文数组。
 * 去掉 HTML 注释、标题、空行与模板占位行；保留日期前缀（与本插件长期轨的盖章格式一致）。
 */
export function legacyEntriesOf(text) {
  const body = String(text ?? '').replace(/<!--[\s\S]*?-->/g, '')
  const out = []
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*[-*+]\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const entry = m[1]
    if (PLACEHOLDER_RE.test(entry)) continue
    if (entry.includes(ENTRY_DELIMITER)) continue
    out.push(entry)
  }
  return out
}

const bodyOf = (entry) => String(entry).replace(DATE_PREFIX_RE, '').trim()

/** 把 entries 并进目标文件（按正文去重），返回新增条数。 */
function mergeInto(dir, file, entries) {
  return withLock(dir, () => {
    const path = join(dir, file)
    const current = existsSync(path) ? parseEntries(readFileSync(path, 'utf8')) : []
    const seen = new Set(current.map(bodyOf))
    const extra = []
    for (const entry of entries) {
      const key = bodyOf(entry)
      if (!key || seen.has(key)) continue
      seen.add(key)
      extra.push(entry)
    }
    if (extra.length === 0) return 0
    mkdirSync(dir, { recursive: true })
    const tmp = `${path}.tmp.${process.pid}`
    writeFileSync(tmp, serializeEntries([...current, ...extra]), 'utf8')
    renameSync(tmp, path)
    return extra.length
  })
}

function listDirs(root) {
  try {
    return readdirSync(root).filter((name) => {
      try { return statSync(join(root, name)).isDirectory() } catch { return false }
    })
  } catch {
    return []
  }
}

/** 所有旧记忆源：`{ kind: 'bot'|'workspace', id, source, destDir, destFile }`。 */
export function legacySources(config) {
  const dataRoot = legacyDataRootOf(config)
  const out = []
  const bot = (id, source) => {
    const key = slugifyBotId(id)
    if (!BOT_KEY_RE.test(key)) return
    out.push({ kind: 'bot', id, source, destDir: join(config.memoryDir, 'bots', key), destFile: 'MEMORY.md' })
  }
  for (const id of listDirs(join(dataRoot, 'agents'))) {
    const source = join(dataRoot, 'agents', id, 'memory', 'MEMORY.md')
    if (existsSync(source)) bot(id, source)
  }
  for (const id of listDirs(join(dataRoot, 'agent-memory'))) {
    const source = join(dataRoot, 'agent-memory', id, 'MEMORY.md')
    if (existsSync(source)) bot(id, source)
  }
  for (const key of listDirs(join(dataRoot, 'workspace-memory'))) {
    if (!/^[0-9a-f]{12}$/.test(key)) continue
    const source = join(dataRoot, 'workspace-memory', key, 'MEMORY.md')
    if (existsSync(source)) {
      out.push({ kind: 'workspace', id: key, source, destDir: join(config.memoryDir, 'projects', key), destFile: 'KEY.md' })
    }
  }
  return out
}

/** Normal local Linux filesystem updates have usable identity/change metadata; this does not cover snapshot replay. */
export function isSupportedLegacyCacheFileSystem(type, platform = process.platform) {
  return platform === 'linux' && [0xef53n, 0x58465342n, 0x9123683en].includes(type)
}

function canUseMetadataCache(source, destination, options) {
  if (options.metadataCache !== undefined) return options.metadataCache === true
  if (process.platform !== 'linux') return false
  try {
    return [source, destination].every(path => isSupportedLegacyCacheFileSystem(statfsSync(path, { bigint: true }).type))
  } catch { return false }
}

/** Stable file identity for a previously content-verified migration; recent or coarse timestamps are not cached. */
function fileStamp(path, now) {
  try {
    const st = statSync(path, { bigint: true })
    if (!st.isFile() || st.dev === 0n || st.ino === 0n || st.mtimeNs <= 0n || st.ctimeNs <= 0n || st.birthtimeNs <= 0n
      || st.ctimeNs % 1_000_000_000n === 0n
      || Number(st.ctimeNs / 1_000_000n) > now - 2_000) return undefined
    return `v1:${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.birthtimeNs}`
  } catch { return undefined }
}

/**
 * 执行导入（启动时调用；失败的单个源记进账本，不抛）。
 * @param {{ force?: boolean, metadataCache?: boolean, readSource?: (path: string) => string, now?: () => number }} [options]
 * @returns {{ scanned: number, imported: number, skipped: number, cached: number, failed: number, details: object[] }}
 */
export function importLegacyAgentMemory(config, options = {}) {
  const ledgerPath = join(config.memoryDir, LEGACY_LEDGER_FILE)
  let ledger = { version: 1, sources: {} }
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    if (parsed?.sources && typeof parsed.sources === 'object' && !Array.isArray(parsed.sources)) ledger = { version: 1, sources: parsed.sources }
  } catch { /* 没有账本 = 第一次导入 */ }
  const summary = { scanned: 0, imported: 0, skipped: 0, cached: 0, failed: 0, details: [] }
  const now = options.now ?? Date.now
  const readSource = options.readSource ?? ((path) => readFileSync(path, 'utf8'))
  let dirty = false
  for (const src of legacySources(config)) {
    summary.scanned += 1
    const destination = join(src.destDir, src.destFile)
    const previous = ledger.sources[src.source]
    const cacheAllowed = canUseMetadataCache(src.source, destination, options)
    const sourceStamp = cacheAllowed ? fileStamp(src.source, now()) : undefined
    const destinationStamp = cacheAllowed ? fileStamp(destination, now()) : undefined
    const sameTarget = previous?.dest === destination && previous?.kind === src.kind && previous?.id === src.id
    if (!options.force && sameTarget && /^[0-9a-f]{40}$/.test(previous?.sha1 ?? '')
      && sourceStamp && destinationStamp && previous.sourceStamp === sourceStamp && previous.destinationStamp === destinationStamp) {
      summary.skipped += 1
      summary.cached += 1
      continue
    }
    let text
    try { text = readSource(src.source) } catch { summary.failed += 1; continue }
    const stableSourceStamp = sourceStamp && sourceStamp === fileStamp(src.source, now()) ? sourceStamp : null
    const sha1 = createHash('sha1').update(text).digest('hex')
    if (sameTarget && previous?.sha1 === sha1) {
      summary.skipped += 1
      if ((previous.sourceStamp ?? null) !== stableSourceStamp || (previous.destinationStamp ?? null) !== (destinationStamp ?? null)) {
        ledger.sources[src.source] = { ...previous, sourceStamp: stableSourceStamp, destinationStamp: destinationStamp ?? null }
        dirty = true
      }
      continue
    }
    try {
      const entries = legacyEntriesOf(text)
      const added = entries.length > 0 ? mergeInto(src.destDir, src.destFile, entries) : 0
      ledger.sources[src.source] = {
        sha1, kind: src.kind, id: src.id, dest: destination, entries: entries.length, added, at: new Date().toISOString(),
        sourceStamp: stableSourceStamp && stableSourceStamp === fileStamp(src.source, now()) ? stableSourceStamp : null,
        destinationStamp: cacheAllowed ? fileStamp(destination, now()) ?? null : null,
      }
      summary.imported += added
      summary.details.push({ kind: src.kind, id: src.id, entries: entries.length, added })
      dirty = true
    } catch (error) {
      summary.failed += 1
      ledger.sources[src.source] = { sha1: null, kind: src.kind, id: src.id, error: String(error?.message ?? error), at: new Date().toISOString() }
      dirty = true
    }
  }
  if (dirty) {
    mkdirSync(config.memoryDir, { recursive: true })
    const tmp = `${ledgerPath}.tmp.${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
    renameSync(tmp, ledgerPath)
  }
  return summary
}
