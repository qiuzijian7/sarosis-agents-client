#!/usr/bin/env node
/**
 * GRBug 修复专家 · 第 4 步：把各阶段产物汇总成一份自包含 HTML 报告（写会话工作区）。
 *
 * 用法：
 *   node "<skillDir>/scripts/report.mjs" --input <summary.json> --out reports/grbug-<bug>.html
 *   node "<skillDir>/scripts/report.mjs" --self-test
 *
 * 输入 JSON 字段全部可选，缺失项显示「未提供 / 需人工补充」，不编造结论：
 *   { bug, user, url, title, tags, crash, evidence:{items,manual}, analysis, fix:{files,summary},
 *     verification, changelist, traceConclusion, limits }
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const val = (v, fallback = '未提供') => v === undefined || v === null || v === '' ? fallback : esc(v)
const list = (items, fallback = '无') => Array.isArray(items) && items.length
  ? '<ul>' + items.map(x => `<li>${esc(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('') + '</ul>' : `<p class="muted">${fallback}</p>`

export function render(summary) {
  const s = summary && typeof summary === 'object' ? summary : {}
  const ev = s.evidence && typeof s.evidence === 'object' ? s.evidence : {}
  const fix = s.fix && typeof s.fix === 'object' ? s.fix : {}
  const rows = (Array.isArray(ev.items) ? ev.items : []).map(x =>
    `<tr><td>${val(x.name)}</td><td>${val(x.kind)}</td><td>${x.ok ? '已下载' : '失败'}</td><td>${val(x.bytes)}</td><td class="muted">${val(x.reason || x.note, '')}</td></tr>`).join('')
  const tags = (Array.isArray(s.tags) ? s.tags : []).map(x => `<span class="tag">${esc(x)}</span>`).join('')
  const limits = [
    ...(Array.isArray(ev.manual) ? ev.manual : []),
    ...(Array.isArray(s.limits) ? s.limits : []),
    '本报告只陈述已落盘的证据与已执行的命令；未执行/未验证的环节一律标注，不推断结论。',
  ]
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>GRBug 修复报告 · ${val(s.bug, 'unknown')}</title>
<style>
:root{color-scheme:light}body{font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:960px;margin:32px auto;padding:0 20px;color:#1f2328;background:#fff}
h1{font-size:22px;border-bottom:2px solid #d0d7de;padding-bottom:10px}h2{font-size:16px;margin-top:28px;border-left:4px solid #0969da;padding-left:10px}
table{border-collapse:collapse;width:100%;margin:10px 0}th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f6f8fa}code,.mono{font-family:Consolas,monospace;background:#f6f8fa;padding:1px 5px;border-radius:4px}
.tag{display:inline-block;background:#ddf4ff;color:#0969da;border-radius:10px;padding:1px 9px;margin-right:6px;font-size:12px}
.muted{color:#656d76}.warn{background:#fff8c5;border-left:4px solid #d4a72c;padding:10px 14px}.ok{color:#1a7f37}
footer{margin-top:36px;border-top:1px solid #d0d7de;padding-top:10px;color:#656d76;font-size:12px}
</style></head><body>
<h1>GRBug 修复报告 · <span class="mono">${val(s.bug, 'unknown')}</span></h1>
<p>${tags}<span class="muted">生成时间：${esc(s.generatedAt || new Date().toISOString())}</span></p>
<h2>1 · TAPD 单子</h2>
<table><tr><th>单号</th><td class="mono">${val(s.bug)}</td><th>报告人</th><td>${val(s.user)}</td></tr>
<tr><th>标题 / 崩溃签名</th><td colspan="3">${val(s.title)}</td></tr>
<tr><th>链接</th><td colspan="3">${s.url ? `<a href="${esc(s.url)}">${esc(s.url)}</a>` : '未提供'}</td></tr>
<tr><th>类型</th><td colspan="3">${s.crash === true ? 'Crash / 异常' : s.perf === true ? '性能问题（含 trace）' : '未提供'}</td></tr></table>
<h2>2 · 证据（日志 / 附件 / Trace）</h2>
<table><tr><th>文件</th><th>类别</th><th>状态</th><th>字节</th><th>备注</th></tr>${rows || '<tr><td colspan="5" class="muted">未下载任何证据</td></tr>'}</table>
${ev.manual && ev.manual.length ? `<div class="warn">${ev.manual.map(x => `<div>· ${esc(x)}</div>`).join('')}</div>` : ''}
<h2>3 · 分析与根因</h2>${val(s.analysis, '未提供；请基于证据补充根因，不要在没有证据时下结论。')}
${s.traceConclusion ? `<h3>Trace 分析结论</h3>${val(s.traceConclusion)}` : ''}
<h2>4 · 修复</h2>${val(fix.summary, '未提供')}${list(fix.files, '未记录改动文件')}
<h2>5 · 验证</h2>${val(s.verification, '未验证；请补充编译 / 复现 / 回归结果。')}
<h2>6 · Perforce pending changelist</h2>
<p>新建 pending CL：<span class="mono">${s.changelist ? esc(s.changelist) : '未创建（或需人工执行）'}</span>；
描述取自 TAPD「复制源码关键字」，保留 <code>--bug=&lt;id&gt;</code> 关联。<strong>本流程从不执行 <code>p4 submit</code>。</strong></p>
<h2>7 · 已知限制 / 需人工步骤</h2><div class="warn">${limits.map(x => `<div>· ${esc(x)}</div>`).join('')}</div>
<footer>由 GRBug 修复专家生成 · 所有结论以本报告落盘时的真实产物为准</footer></body></html>`
}

export const selfTest = () => {
  const html = render({ bug: '1281129', user: '邱子鉴', title: 'EXCEPTION_ACCESS_VIOLATION_WRITE', tags: ['Crash'],
    url: 'https://www.tapd.cn/68880148/s/5967448', crash: true,
    evidence: { items: [{ name: 'a.log', kind: 'log', ok: true, bytes: 12 }], manual: ['内网报表需人工导出'] },
    fix: { files: ['a.cpp'], summary: '加锁保护' }, changelist: 12345 })
  const results = [
    html.startsWith('<!doctype html>') && html.includes('<meta charset="utf-8">'),
    html.includes('1281129') && html.includes('邱子鉴') && html.includes('EXCEPTION_ACCESS_VIOLATION_WRITE'),
    html.includes('a.log') && html.includes('a.cpp') && html.includes('12345'),
    html.includes('内网报表需人工导出') && html.includes('p4 submit'),
    !html.includes('<script') && !html.includes('undefined'),
    render({}).includes('未提供'),
  ]
  return results
}

const main = () => {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) {
    const results = selfTest()
    console.log(JSON.stringify({ ok: results.every(Boolean), cases: results.length, passed: results.filter(Boolean).length, results }))
    process.exitCode = results.every(Boolean) ? 0 : 1
    return
  }
  const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
  const input = arg('--input', '')
  const out = arg('--out', join(process.cwd(), 'reports', 'grbug-report.html'))
  let summary = {}
  try { if (input) summary = JSON.parse(readFileSync(input, 'utf8')) } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `读取输入失败：${String(e?.message || e)}` })); process.exitCode = 1; return
  }
  summary.generatedAt = summary.generatedAt || new Date().toISOString()
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, render(summary), 'utf8')
  console.log(JSON.stringify({ ok: true, out, bytes: Buffer.byteLength(render(summary), 'utf8') }))
}

if (process.argv[1] && /report\.mjs$/.test(process.argv[1])) main()
