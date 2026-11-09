#!/usr/bin/env node
/**
 * GRBug 修复专家 · 第 1 步：解析 TAPD「复制源码关键字」文本。
 *
 * 输入示例（TAPD bug 详情页右上角菜单 → 复制源码关键字）：
 *   --bug=1281129 --user=邱子鉴 【Crash】【release】【影响设备数:1】EXCEPTION_ACCESS_VIOLATION_WRITE
 *     ntdll.dll pc 0x48389 RtlTryAcquireSRWLockExclusive (:0)[amd64:Windows https://www.tapd.cn/68880148/s/5967448
 *
 * 输出恒为一个 JSON 对象（stdout），不含任何凭据：
 *   { ok, bug, user, title, url, workspace, tags, crash, description }
 * description 是规范化后的 P4 changelist 描述（保留 --bug/--user 关联串）。
 *
 * 用法：
 *   node "<skillDir>/scripts/keyword.mjs" "<复制得到的文本>"
 *   echo "<文本>" | node "<skillDir>/scripts/keyword.mjs" --stdin
 *   node "<skillDir>/scripts/keyword.mjs" --self-test
 */
import { readFileSync } from 'node:fs'

export function parseKeyword(input) {
  const raw = String(input ?? '').replace(/\s+/g, ' ').trim()
  const bug = /--bug=([0-9]+)/.exec(raw)?.[1] ?? ''
  const user = /--user=([^\s]+)/.exec(raw)?.[1] ?? ''
  const url = /(https?:\/\/[^\s]+)/u.exec(raw)?.[1] ?? ''
  const workspace = /tapd\.cn\/([0-9]+)\//.exec(url)?.[1] ?? ''
  const tags = [...raw.matchAll(/【([^】]+)】/g)].map(m => m[1])
  // 标题 = 去掉关联串、标签、末尾 URL 之后剩下的正文（保留崩溃签名/模块名/偏移）
  const title = raw
    .replace(/--bug=[0-9]+/g, '').replace(/--user=\S+/g, '')
    .replace(/【[^】]+】/g, ' ')
    .replace(/https?:\/\/\S+/gu, '')
    .replace(/\s+/g, ' ').trim()
  const crash = /EXCEPTION_|ACCESS_VIOLATION|crash|崩溃|ntdll|RtlTry|0x[0-9a-f]+/i.test(title)
  // P4 CL 描述：保留原始关联串与标题，去掉末尾短链（短链放进报告，不占 CL 描述）
  const description = [
    `--bug=${bug}${user ? ` --user=${user}` : ''}`,
    raw.replace(/--bug=[0-9]+/g, '').replace(/--user=\S+/g, '').replace(/https?:\/\/\S+/gu, '')
      .replace(/\s+/g, ' ').trim(),
  ].filter(Boolean).join(' ').slice(0, 800)
  return { ok: !!bug, bug, user, url, workspace, tags, title, crash, description }
}

export const selfTest = () => {
  const sample = '--bug=1281129 --user=邱子鉴 【Crash】【release】【影响设备数:1】EXCEPTION_ACCESS_VIOLATION_WRITE ntdll.dll pc 0x48389 RtlTryAcquireSRWLockExclusive (:0)[amd64:Windows https://www.tapd.cn/68880148/s/5967448'
  const a = parseKeyword(sample)
  const b = parseKeyword('--bug=5001 修复 4K 下预览错位')
  const c = parseKeyword('完全没有关联串')
  return [
    a.ok && a.bug === '1281129' && a.user === '邱子鉴',
    a.workspace === '68880148' && a.tags.includes('Crash') && a.crash === true,
    a.title.includes('EXCEPTION_ACCESS_VIOLATION_WRITE') && !a.title.includes('https://'),
    a.description.startsWith('--bug=1281129 --user=邱子鉴') && !a.description.includes('https://'),
    b.ok && b.bug === '5001' && b.title === '修复 4K 下预览错位',
    c.ok === false,
    // 「复制源码关键字」文本以 --bug= 开头，不能被 CLI 参数过滤误丢（真机踩过）
    !['--stdin', '--self-test'].includes(sample.slice(0, 9)) && parseKeyword(sample).bug === '1281129',
  ]
}

const main = () => {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) {
    const results = selfTest()
    console.log(JSON.stringify({ ok: results.every(Boolean), cases: results.length, passed: results.filter(Boolean).length, results }))
    process.exitCode = results.every(Boolean) ? 0 : 1
    return
  }
  // ⚠ 「复制源码关键字」文本本身就以 `--bug=` 开头 ⇒ 不能按 `a.startsWith('--')` 过滤，
  //   否则整段会被当成 CLI 开关丢掉。这里只排除本脚本自己的两个开关。
  const OWN_FLAGS = new Set(['--stdin', '--self-test'])
  const text = args.includes('--stdin') ? readFileSync(0, 'utf8') : args.filter(a => !OWN_FLAGS.has(a)).join(' ')
  const parsed = parseKeyword(text)
  console.log(JSON.stringify(parsed))
  process.exitCode = parsed.ok ? 0 : 1
}

if (process.argv[1] && /keyword\.mjs$/.test(process.argv[1])) main()
