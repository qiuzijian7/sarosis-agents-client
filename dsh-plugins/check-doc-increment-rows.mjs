#!/usr/bin/env node
// check-doc-increment-rows.mjs ★ 「bump 必须补 §15.0 增量行」守卫（2026-11-10）
//
// 真机问题：0.1.87/0.1.88/0.1.91/0.1.92 四个版本只出现在标题区间里，
//   文档表体没有对应行 ⇒ 标题写着最新版本，读者却查不到这一版做了什么。
//   build.mjs 的 docBaselineProblem() 只校验 data-baseline 与 15.0 区间终点，不校验行。
//
// 契约：从 BASELINE_START 到 package.json 当前版本，每个补丁号都必须在 §15.0 表体
//   有独立增量行。这样每次 bump 都会立刻判红，直到补上该版本的一行。
//   范围行（如「0.1.75–0.1.76」）不算，必须能被「（0.1.XX）」或「(0.1.XX)」精确命中。
//
// 跑法：node dsh-plugins/check-doc-increment-rows.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const problems = []
const ok = (label, condition, detail = '') => {
  if (condition) { console.log(`  ✓ ${label}`) }
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); problems.push(label) }
}
/** 从哪一路版本开始要求「每版一行」。0.1.84 起文档有连续独立行。 */
const BASELINE_START = 84

console.log('check-doc-increment-rows：每个版本都要在 §15.0 留下一行')
const version = JSON.parse(read('dsh-plugins/vssaros-superagent/package.json')).version
const doc = read('doc/superagent-framework-v2.html')
const declared = /data-baseline="([^"]+)"/.exec(doc)?.[1]
const range = /<h3>15\.0 · \S+ – (\S+)/.exec(doc)?.[1]
ok('① data-baseline / §15.0 区间终点都等于 package.json 版本',
  declared === version && range === version, `baseline=${declared} range=${range} version=${version}`)

// 只看 §15.0 的 tbody，避免命中 15.1–17 的历史快照
const h3 = doc.indexOf('<h3>15.0 · ')
const tbody = doc.indexOf('<tbody>', h3)
const end = doc.indexOf('</tbody>', tbody)
const body = tbody > 0 && end > tbody ? doc.slice(tbody, end) : ''
ok('② 能定位 §15.0 表体', body.length > 0)

const match = /^0\.1\.(\d+)$/.exec(String(version))
ok('③ 当前版本号形如 0.1.N', !!match, version)
const rows = body.split(/\r?\n/).filter(line => /^<tr>/.test(line.trim()))
const missing = []
if (match) {
  for (let n = BASELINE_START; n <= Number(match[1]); n++) {
    const v = `0.1.${n}`
    if (!rows.some(line => line.includes(`（${v}）`) || line.includes(`(${v})`))) { missing.push(v) }
  }
}
ok(`④ 0.1.${BASELINE_START} – ${version} 每个版本都有独立增量行`,
  missing.length === 0, missing.length ? `缺行：${missing.join('、')}` : `共 ${rows.length} 行`)

console.log(problems.length ? `\n✗ check-doc-increment-rows：${problems.length} 项失败` : '\n✓ check-doc-increment-rows：全部通过')
process.exitCode = problems.length ? 1 : 0
