/**
 * vssaros-memory/transcript — 多帧 zstd 解码（插件内自带实现）。
 *
 * ⚠ 为什么自带一份：插件之间不能跨包 import（见
 * dsh-plugins/vssaros-workitem/lib/core/ledger.js:3-5；profile 里没有跨包
 * 解析路径），所以不能直接 import vssaros-sessions 的 decodeZstdFrames()。
 * 这里与 sessions / chat-surface 两版**口径一致**：魔数 28 B5 2F FD 切帧、
 * 逐帧异步解压、坏帧跳过不编造、帧内误判魔数时向后合并重试。
 *
 * ⚠ 只能用异步 zlib.zstdDecompress（Node 22.15+）：同步解压几 MB 日志会把
 * Host 主线程整段卡住，dshPluginPackages.test.ts 钉着「插件不许同步解压」。
 *
 * @module vssaros-memory/transcript/decode
 */
import zlib from 'node:zlib'
import { promisify } from 'node:util'

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const zstdDecompressAsync = typeof zlib.zstdDecompress === 'function'
  ? promisify(zlib.zstdDecompress)
  : null

/** 当前 Node 是否支持 zstd（不假装读到）。 */
export function zstdAvailable() {
  return zstdDecompressAsync !== null
}

/**
 * 逐帧解压多帧 zstd，返回拼起来的文本；解不出的帧被跳过，不抛错、不编造。
 * @param {Buffer} buf
 * @param {{maxFrames?: number}} [options]
 * @returns {Promise<string>}
 */
export async function decodeZstdFrames(buf, { maxFrames = Infinity } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || !zstdDecompressAsync) return ''

  const offsets = []
  let at = 0
  while ((at = buf.indexOf(ZSTD_MAGIC, at)) >= 0) {
    offsets.push(at)
    at += ZSTD_MAGIC.length
  }
  if (offsets.length === 0) return ''
  if (offsets[0] !== 0) offsets.unshift(0)

  const limit = Number.isFinite(maxFrames) && maxFrames > 0
    ? Math.min(offsets.length, Math.floor(maxFrames))
    : offsets.length
  const parts = []
  for (let k = 0; k < limit; k++) {
    const start = offsets[k]
    let end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    let done = false
    for (let tries = 0; tries < 3 && !done; tries++) {
      try {
        parts.push((await zstdDecompressAsync(buf.subarray(start, end))).toString('utf8'))
        done = true
      } catch {
        // 帧内部恰好出现魔数 ⇒ 切出来的两段都解不出，把后一段并进来重试。
        const next = k + 2 + tries
        end = next < offsets.length ? offsets[next] : buf.length
      }
    }
    // 仍失败就丢这一段：日志是只追加的，单帧坏掉不该让整块导出失败。
  }
  return parts.join('')
}

/** JSONL → 事件数组；坏行跳过（不整批失败、不编造）。 */
export function parseJsonl(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const value = JSON.parse(trimmed)
      if (value && typeof value === 'object') out.push(value)
    } catch {
      // 跳过坏行
    }
  }
  return out
}
