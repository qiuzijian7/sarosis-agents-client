#!/usr/bin/env node
/**
 * GRBug 修复专家 · 第 2 步：从 TAPD bug 详情里提取证据链接，下载日志 / trace 到会话工作区。
 *
 * ⚠ 边界（不要越界承诺）：
 *   · 本脚本只做「从已知 URL 下载文件」。TAPD 附件列表请用 tapd-skill 的 `raw GET /files/get_files`
 *     或 `GET /bugs?...` 拿到 download_url，再把 URL 交给本脚本。
 *   · CrashSight / crash-reporting 内网报表需要登录态：脚本不会伪造 cookie 或谎称拿到数据；
 *     下载失败会如实记录 reason，并在报告里标成「需人工在浏览器导出」。
 *   · .utrace / .etl / .dmp 只落地 + 记录大小与哈希，不做二进制解析 —— 分析交给
 *     UnrealInsights / WPA / cdb 等外部工具（仓库内没有这些分析器）。
 *
 * 用法：
 *   node "<skillDir>/scripts/evidence.mjs" --bug 1281129 --url <URL> [--url <URL> ...] [--out <目录>] [--dry-run]
 *   node "<skillDir>/scripts/evidence.mjs" --self-test
 *
 * 输出恒为 JSON：{ ok, bug, out, items:[{url,name,kind,bytes,sha256,ok,reason}], perf, manual }
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const MAX_BYTES = 200 * 1024 * 1024
const TRACE_EXT = /\.(?:utrace|etl|dmp|mdmp|pdb|trace|perfetto|json\.gz)$/i
const LOG_EXT = /\.(?:log|txt|csv|json|zip|7z|gz|tgz)$/i

export function classify(url) {
  const path = String(url).split(/[?#]/)[0]
  if (TRACE_EXT.test(path) || /trace|perf|profile/i.test(path)) return 'trace'
  if (LOG_EXT.test(path) || /log|crash|dump|attachment/i.test(path)) return 'log'
  return 'other'
}
export function safeName(url, index) {
  const raw = basename(String(url).split(/[?#]/)[0]) || `evidence-${index}`
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || `evidence-${index}`
}

export async function collect({ bug, urls, out, dryRun = false, fetchImpl, now = Date.now() }) {
  const items = []
  const cwd = process.cwd()
  const dir = out || join(cwd, 'grbug-evidence', `bug-${bug || 'unknown'}`)
  if (!dryRun) mkdirSync(dir, { recursive: true })
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    const kind = classify(url)
    const name = safeName(url, i)
    if (dryRun) { items.push({ url, name, kind, bytes: 0, ok: true, reason: 'dry-run' }); continue }
    try {
      const f = fetchImpl || fetch
      const res = await f(url, { signal: AbortSignal.timeout(60_000), headers: { accept: '*/*' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength > MAX_BYTES) throw new Error(`文件超过 ${MAX_BYTES} 字节上限`)
      const file = join(dir, name)
      writeFileSync(file, buf)
      items.push({ url, name, kind, bytes: statSync(file).size, sha256: createHash('sha256').update(buf).digest('hex'), ok: true,
        file, ...(kind === 'trace' ? { note: '二进制 trace 需外部工具分析（UnrealInsights / WPA / cdb）' } : {}) })
    } catch (e) {
      items.push({ url, name, kind, bytes: 0, ok: false, reason: String(e?.message || e) })
    }
  }
  const failed = items.filter(x => !x.ok)
  return {
    ok: failed.length === 0, bug, out: dir, items,
    perf: items.some(x => x.kind === 'trace' && x.ok),
    manual: failed.length
      ? [`${failed.length} 个链接下载失败（多为内网登录态）：${failed.map(x => x.reason).join('；')}。请在浏览器登录后手动导出到 ${dir}，再在报告中注明。`,
        '若含 .utrace/.etl/.dmp，用 UnrealInsights / WPA / cdb 分析后把结论写入报告；本技能不解析二进制 trace。']
      : items.some(x => x.kind === 'trace')
        ? ['若含 .utrace/.etl/.dmp，用 UnrealInsights / WPA / cdb 分析后把结论写入报告；本技能不解析二进制 trace.']
        : [],
    at: new Date(now).toISOString(),
  }
}

const main = async () => {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) {
    const dry = await collect({ bug: '1281129', urls: [
      'https://example.com/crash/report/abc.log', 'https://example.com/trace/game.utrace', 'https://example.com/s/5967448',
    ], dryRun: true })
    const results = [
      dry.items.length === 3,
      dry.items[0].kind === 'log' && dry.items[1].kind === 'trace',
      dry.perf === true && dry.manual.length >= 1,
      classify('https://x/a.etl') === 'trace' && classify('https://x/a.log') === 'log',
      safeName('https://x/../a b.log', 1) === 'a_b.log',
    ]
    console.log(JSON.stringify({ ok: results.every(Boolean), cases: results.length, passed: results.filter(Boolean).length, results }))
    process.exitCode = results.every(Boolean) ? 0 : 1
    return
  }
  const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
  const urls = []
  for (let i = 0; i < args.length; i++) if (args[i] === '--url' && args[i + 1]) urls.push(args[++i])
  const report = await collect({ bug: arg('--bug', ''), urls, out: arg('--out', undefined), dryRun: args.includes('--dry-run') })
  console.log(JSON.stringify(report))
  process.exitCode = report.ok ? 0 : 1
}

if (process.argv[1] && /evidence\.mjs$/.test(process.argv[1])) await main()
