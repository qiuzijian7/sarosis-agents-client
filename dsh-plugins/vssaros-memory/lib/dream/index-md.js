/**
 * vssaros-memory/dream — `dream/_index.md` 运行目录（P2-b）。
 *
 * 官方 Cookbook 用 `_index.md` 作 wiki 目录；本仓记忆真源是六轨 `§` 文件，
 * 所以这里只把它当作 **Dream 运行产物的按需检索索引**，不承载记忆正文。
 *
 * ⚠ 默认 `inject: false`：绝不注册系统提示词上下文、绝不参与快照注入 ——
 * 四轨全文注入 + 变化才追加尾消息会打碎 LLM 前缀缓存，且未经复核的结论
 * 不该直达 system prompt。守卫会静态钉住「源码里没有这两处注册调用」。
 *
 * @module vssaros-memory/dream/index-md
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const MAX_INDEX_ENTRIES = 30

/** slug 只允许 ASCII 小写字母/数字/连字符，且长度有界。 */
export function slugOf(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '') || 'untitled'
}

/**
 * @param {{entries?:Array<{slug?:string,title?:string}>, at?:string}} options
 * @returns {string}
 */
export function buildIndex({ entries = [], at = new Date().toISOString() } = {}) {
  const list = (Array.isArray(entries) ? entries : []).slice(0, MAX_INDEX_ENTRIES).map((entry) => ({
    slug: slugOf(entry?.slug ?? entry?.title ?? ''),
    title: String(entry?.title ?? '').replace(/\n/g, ' ').trim(),
  }))
  return [
    '---',
    'type: dream-index',
    `updated: ${at}`,
    `entries: ${list.length}`,
    'inject: false',
    '---',
    '',
    '# Dream 索引（只按需检索，不注入 system prompt）',
    '',
    ...list.map((entry) => `- [[${entry.slug}]] — ${entry.title}`),
    '',
  ].join('\n')
}

/** 从索引文本里取回条目（坏行跳过，不整批失败）。 */
export function parseIndex(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const match = line.match(/^- \[\[([^\]]+)\]\]\s+—\s+(.*)$/)
    if (match) out.push({ slug: match[1], title: match[2].trim() })
  }
  return out
}

export function indexPathOf(memoryDir) {
  return join(memoryDir, 'dream', '_index.md')
}

/** 读已有索引；文件不存在/损坏返回空数组。 */
export async function readIndex(memoryDir) {
  try {
    return parseIndex(await readFile(indexPathOf(memoryDir), 'utf8'))
  } catch {
    return []
  }
}

/** 只写 `<memoryDir>/dream/_index.md`，六轨记忆文件一个都不碰。 */
export async function writeIndex({ memoryDir, entries = [], at = new Date().toISOString() } = {}) {
  const path = indexPathOf(memoryDir)
  const list = Array.isArray(entries) ? entries.slice(0, MAX_INDEX_ENTRIES) : []
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, buildIndex({ entries: list, at }), 'utf8')
  return { path, count: list.length }
}
