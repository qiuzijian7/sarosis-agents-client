#!/usr/bin/env node
/**
 * 记忆「读取 / 检索 / 记录」三条链路的契约守卫。
 *
 * 起因：审批队列里一行坏 JSON 会让整个 SUGGESTIONS.jsonl 读不出来
 * （approve / reject / archive / 记忆 Tab 一起失效）。修复后配静态判据 +
 * 反向突变，防止回退；顺带钉住快照不注入易变轨、写操作串行原子、Tab 展示
 * 剥离内部元数据三条既有纪律。
 *
 * 单跑：node dsh-plugins/check-memory-io-contract.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

const FILES = {
  store: 'dsh-plugins/vssaros-memory/lib/store.js',
  index: 'dsh-plugins/vssaros-memory/lib/index.js',
  tab: 'dsh-plugins/vssaros-memory/lib/memory-tab.js',
  snapshotTest: 'dsh-plugins/vssaros-memory/tests/render-snapshot-stability.test.js',
  queueTest: 'dsh-plugins/vssaros-memory/tests/review-queue-fault.test.js',
  pkg: 'package.json',
}

const LABELS = {
  queueBadLinesTolerant: '记录链：坏 JSONL 行被跳过并留 .bad 副本，不整批失效',
  snapshotVolatileExcluded: '读取链：project/daily 绝不进快照（有测试钉住）',
  writesSerialized: '记录链：变更走 withLock + tmp/rename 原子写',
  tabStripsMetadata: '检索链：记忆 Tab 展示剥离 [id:] / [summary:] 元数据',
  onCheckChain: '本守卫已登记在 check:dsh-plugins 链上',
}

function verdict(src) {
  return {
    queueBadLinesTolerant: /bad\.push\(line\)/.test(src.store)
      && /\.bad\./.test(src.store)
      && /坏 JSONL 行/.test(src.queueTest),
    snapshotVolatileExcluded: /deliberately NOT rendered into the snapshot/.test(src.index)
      && /!text\.includes\('项目进展 PROJ'\)/.test(src.snapshotTest)
      && /!text\.includes\('今日日志 DAILY'\)/.test(src.snapshotTest),
    writesSerialized: /return withLock\(loc\.dir/.test(src.store)
      && /renameSync\(tmp, path\)/.test(src.store)
      && /\.tmp\.\$\{process\.pid\}/.test(src.store),
    tabStripsMetadata: src.tab.includes('stripEntrySummary(trimmed)')
      && src.tab.includes('[id:'),
    onCheckChain: src.pkg.includes('check-memory-io-contract.mjs'),
  }
}

const MUTATIONS = [
  { key: 'queueBadLinesTolerant', file: 'store', from: 'bad.push(line)', to: 'void line' },
  { key: 'snapshotVolatileExcluded', file: 'snapshotTest', from: "!text.includes('项目进展 PROJ')", to: 'true' },
  { key: 'writesSerialized', file: 'store', from: 'renameSync(tmp, path)', to: 'renameSyncRemoved(tmp, path)' },
  { key: 'tabStripsMetadata', file: 'tab', from: 'stripEntrySummary(trimmed)', to: 'trimmed' },
  { key: 'onCheckChain', file: 'pkg', from: 'check-memory-io-contract.mjs', to: '__guard_removed__' },
]

const problems = []
function ok(label, condition) {
  console.log(`${condition ? '✓' : '✗'} ${label}`)
  if (!condition) problems.push(label)
}

const src = Object.fromEntries(Object.entries(FILES).map(([key, path]) => [key, read(path)]))
const baseline = verdict(src)
for (const [key, label] of Object.entries(LABELS)) ok(label, baseline[key])

for (const mutation of MUTATIONS) {
  const original = src[mutation.file]
  const changed = original.includes(mutation.from)
  const mutated = changed ? original.split(mutation.from).join(mutation.to) : original
  const caught = changed && verdict({ ...src, [mutation.file]: mutated })[mutation.key] === false
  ok(`反向突变 ${mutation.key}`, caught)
}

const total = Object.keys(LABELS).length + MUTATIONS.length
console.log(`\n${total - problems.length}/${total} passed`)
if (problems.length) {
  console.error(`失败项：\n- ${problems.join('\n- ')}`)
  process.exitCode = 1
}
