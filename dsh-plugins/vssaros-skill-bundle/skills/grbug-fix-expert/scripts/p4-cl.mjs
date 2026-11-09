#!/usr/bin/env node
/**
 * GRBug 修复专家 · 第 5 步：把修改过的文件签出并放进一个**新建的 pending changelist**，
 * CL 描述 = TAPD「复制源码关键字」解析出的内容（由 keyword.mjs 提供）。
 *
 * ⚠ 纪律：
 *   · 只调用 guarded p4 允许的子命令：change -o / change -i / edit / reopen / opened。
 *     绝不 submit、绝不 change -f/-u/-U/-t（p4-guard 会拒绝）。
 *   · 默认 --dry-run：只打印将执行的命令与 CL form，不碰真实 P4。
 *   · 描述里保留 --bug=<id> 关联（DSH_SUPERAGENT_TAPD_BUG 的约定），便于 TAPD 关联。
 *
 * 用法：
 *   node "<skillDir>/scripts/p4-cl.mjs" --description "<关键字文本>" --file <路径> [--file ...] [--dry-run]
 *   node "<skillDir>/scripts/p4-cl.mjs" --self-test
 */
import { spawnSync } from 'node:child_process'

const ALLOWED = new Set(['change', 'edit', 'reopen', 'opened'])

export function p4Form(client, user, description) {
  const text = String(description).split(/\r?\n/).map(line => `\t${line}`).join('\n')
  return `Change:\tnew\n\nClient:\t${client}\n\nUser:\t${user}\n\nStatus:\tnew\n\nDescription:\n${text}\n`
}
export function withDescription(form, description) {
  const lines = String(form).split(/\r?\n/)
  const start = lines.findIndex(line => /^Description:/.test(line))
  const text = String(description).split(/\r?\n/).map(line => `\t${line}`)
  if (start < 0) return `${String(form).trimEnd()}\n\nDescription:\n${text.join('\n')}\n`
  let end = start + 1
  while (end < lines.length && (lines[end].startsWith('\t') || lines[end] === '' && lines[end + 1]?.startsWith('\t'))) end++
  return [...lines.slice(0, start), 'Description:', ...text, ...lines.slice(end)].join('\n')
}
export function createdChangeNumber(output) {
  return /Change\s+(\d+)\s+(?:created|renumbered|submitted)/i.exec(String(output))?.[1] ?? ''
}

export function plan({ description, files, client = '${P4CLIENT}', user = '${P4USER}' }) {
  return {
    create: ['p4', ['change', '-o'], '<form>'],
    submit: ['p4', ['change', '-i'], withDescription(p4Form(client, user, description), description)],
    checkout: files.map(file => ['p4', ['edit', '-c', '<CL>', file]]),
    reopen: files.map(file => ['p4', ['reopen', '-c', '<CL>', file]]),
  }
}

export const selfTest = () => {
  const form = p4Form('gr-client', 'qiuzijian', '--bug=1281129 --user=邱子鉴 【Crash】EXCEPTION_ACCESS_VIOLATION_WRITE')
  const changed = withDescription('Change:\tnew\n\nDescription:\n\told text\n\nFiles:\n', '--bug=5001 修复')
  const results = [
    form.includes('Change:\tnew') && form.includes('Status:\tnew') && form.includes('--bug=1281129'),
    changed.includes('\t--bug=5001 修复') && !changed.includes('old text') && changed.includes('Files:'),
    createdChangeNumber('Change 12345 created with 2 open file(s).') === '12345',
    createdChangeNumber('no change here') === '',
    [...ALLOWED].every(a => !['submit', 'delete', 'obliterate'].includes(a)),
    plan({ description: 'x', files: ['a.cpp', 'b.h'] }).checkout.length === 2,
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
  const files = []
  for (let i = 0; i < args.length; i++) if (args[i] === '--file' && args[i + 1]) files.push(args[++i])
  const description = arg('--description', '')
  const dry = args.includes('--dry-run') || !args.includes('--execute')
  if (!description || !files.length) {
    console.log(JSON.stringify({ ok: false, error: '需要 --description 与至少一个 --file' }))
    process.exitCode = 1
    return
  }
  const client = process.env.P4CLIENT || '<P4CLIENT>'
  const user = process.env.P4USER || '<P4USER>'
  const steps = plan({ description, files, client, user })
  if (dry) {
    console.log(JSON.stringify({ ok: true, mode: 'dry-run', description, files, steps,
      note: '确认无误后加 --execute 才会真的调用 p4；本项目绝不 p4 submit。' }))
    return
  }
  // --execute：真跑 guarded p4。所有子命令都在白名单内。
  const run = (argv, input) => {
    if (!ALLOWED.has(argv[0])) throw new Error(`不允许的 p4 子命令：${argv[0]}`)
    const r = spawnSync('p4', argv, { encoding: 'utf8', input, windowsHide: true, timeout: 120_000 })
    if (r.error) throw r.error
    if (r.status !== 0) throw new Error(`p4 ${argv.join(' ')} 失败：${String(r.stderr || r.stdout).trim().slice(0, 300)}`)
    return String(r.stdout ?? '')
  }
  try {
    const form = run(['change', '-o'])
    const body = withDescription(form, description)
    const output = run(['change', '-i'], body)
    const cl = createdChangeNumber(output)
    if (!cl) throw new Error(`无法从 p4 输出解析 CL 号：${output.slice(0, 200)}`)
    for (const file of files) run(['edit', '-c', cl, file])
    const opened = run(['opened', '-c', cl])
    console.log(JSON.stringify({ ok: true, mode: 'executed', changelist: Number(cl), description, files, opened: opened.trim().slice(0, 2000) }))
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e?.message || e), hint: 'CL 可能已创建但未签出文件，请用 p4 opened -c <CL> 检查后重试' }))
    process.exitCode = 1
  }
}

if (process.argv[1] && /p4-cl\.mjs$/.test(process.argv[1])) main()
