#!/usr/bin/env node
/**
 * Dreaming P0 + P1 + P1-UI + P2 契约守卫（零新增插件版）。
 *
 * 静态钉住 25 条不变量，并自带**反向突变**：把源码在内存里改坏后，
 * 对应判据必须立刻变红 —— 防止守卫写成「永远通过」的摆设。
 * 依据 doc/memory-dreaming-refactor-architecture.html 的 8.2 / 11 节。
 *
 * 单跑：node dsh-plugins/check-dreaming-contract.mjs
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

const FILES = {
  decode: 'dsh-plugins/vssaros-memory/lib/transcript/decode.js',
  export: 'dsh-plugins/vssaros-memory/lib/transcript/export.js',
  index: 'dsh-plugins/vssaros-memory/lib/index.js',
  api: 'dsh-plugins/vssaros-memory/lib/api.js',
  patch: 'dsh-plugins/vssaros-memory/cordis.patch.yml',
  state: 'dsh-plugins/vssaros-memory/lib/dream/state.js',
  proposal: 'dsh-plugins/vssaros-memory/lib/dream/proposal.js',
  orchestrator: 'dsh-plugins/vssaros-memory/lib/dream/orchestrator.js',
  controller: 'dsh-plugins/vssaros-memory/lib/dream/index.js',
  writer: 'dsh-plugins/vssaros-memory/lib/dream/writer.js',
  schedule: 'dsh-plugins/vssaros-memory/lib/dream/schedule.js',
  roles: 'dsh-plugins/vssaros-memory/lib/dream/roles.js',
  conc: 'dsh-plugins/vssaros-memory/lib/dream/concurrency.js',
  wiki: 'dsh-plugins/vssaros-memory/lib/dream/index-md.js',
  evalu: 'dsh-plugins/vssaros-memory/lib/dream/eval.js',
  taskSpec: 'dsh-plugins/vssaros-memory/lib/dream/task-spec.js',
  integration: 'dsh-plugins/vssaros-memory/tests/dream-integration.test.js',
  pkg: 'package.json',
}

const LABELS = {
  asyncZstd: '转录解码只用异步 zstd（不许同步解压卡 Host 主线程）',
  defaultOff: 'dreamEnabled 静态默认关闭（DEFAULTS 与 cordis.patch.yml 同一份）',
  windowOnlyOnSuccess: 'last_run 只在整轮成功时推进（失败保留窗口）',
  closedOps: '提案操作是 6 项闭合集且不含 remove（归档优先）',
  reportOnly: '编排器本体 report-only：applied 恒为 0，不直写记忆文件',
  exportReadOnly: '导出器只读会话、不触碰记忆目录',
  noCrossPluginImport: '零新增插件：dream / transcript 模块不跨包 import 其它插件源码',
  onCheckChain: '本守卫已登记在 check:dsh-plugins 链上',
  writerNoDirectWrite: 'P1 writer 只经 store 公开方法 + withLock + conservationCheck',
  writerDryRunDefault: 'P1 默认 dry-run，apply 必须显式为 true 才落盘',
  writerArchiveFirst: 'P1 归档优先：先 archive.append，绝不调用 store.remove/delete',
  writerRollback: 'P1 守恒/读回失败时用 store.write(before) 回滚',
  dedupeInjected: 'P1 注入四轨写入前做实质变化去重（保护前缀缓存）',
  runtimeKeyWired: 'P1 dreamEnabled 已成对加入 RUNTIME_KEYS 与 validateRuntimePatch',
  scheduleOptional: 'P1 cron 只注入自建 vssarosScheduler，以 Context/effect/fiber 管理订阅',
  settingsKeysPaired: 'P1-UI 前置：5 个 Dream 键在 DEFAULTS / RUNTIME_KEYS / validateRuntimePatch / patch.yml 里成对（不谎报可写范围）',
  runtimeDrivenController: 'P1-UI 前置：控制器真的消费运行时配置，且仅报告模式禁止 apply',
  llmRolesInjected: 'P2-a 控制器接入 LLM 三角色，且 llm 缺席回落保守实现',
  llmFailClosed: 'P2-a LLM 适配层 fail-closed：stream 缺席判死、解析不出默认拒、失败返回 null',
  boundedConcurrency: 'P2-b analyzer 并行但有上限（默认 8），不用无上限 Promise.all',
  indexNotInjected: 'P2-b _index.md 默认 inject:false，源码里没有任何快照/上下文注册调用',
  qualityEvaluated: 'P2-b 成功轮写入成本/保真评测（fidelity + 计数完整性）',
  refuterModelIndependent: 'P2-c refuter 可用独立小模型且键成对；analyzer/organizer 仍继承',
  taskSpecReady: 'P2-c scheduler action 任务规格合法，只读端点只返回规格不创建任务',
  integrationWired: '端到端集成测试真的 apply() 装配并走完 config → run → apply 全链路',
}

/** 纯判据：输入是源码文本映射，便于内存反向突变。 */
function verdict(src) {
  const opsBlock = src.proposal.match(/DREAM_OPERATIONS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] ?? ''
  const ops = [...opsBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  const runtimeBlock = src.index.match(/export const RUNTIME_KEYS\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? ''
  const dreamSources = [
    src.controller, src.writer, src.schedule, src.orchestrator, src.state,
    src.proposal, src.roles, src.conc, src.wiki, src.evalu, src.taskSpec,
  ].join('\n')
  return {
    asyncZstd: /promisify\(zlib\.zstdDecompress\)/.test(src.decode) && !/zstdDecompressSync/.test(src.decode),
    defaultOff: /dreamEnabled:\s*false/.test(src.index) && /^\s+dreamEnabled:\s*false/m.test(src.patch),
    windowOnlyOnSuccess: /if \(ok\)\s*\{\s*state\.last_run = at/.test(src.state),
    closedOps: ops.length === 6 && ops.join(',') === 'add,replace,archive,summarize,flag_conflict,link',
    reportOnly: /manifest\.applied = 0/.test(src.orchestrator)
      && !/writeFileSync/.test(src.orchestrator)
      && !/MEMORY\.md/.test(src.orchestrator),
    exportReadOnly: /memoryDirTouched: false/.test(src.export)
      && !/writeFile\([^)]*memoryDir/.test(src.export),
    noCrossPluginImport: !/vssaros-sessions|from\s+['"]\.\.\/\.\.\//.test(dreamSources),
    onCheckChain: src.pkg.includes('check-dreaming-contract.mjs'),
    writerNoDirectWrite: /withLock\(lockAt/.test(src.writer)
      && /conservationCheck\(before/.test(src.writer)
      && /store\.add\(target, p\.content, agent\)/.test(src.writer)
      && !/MEMORY\.md|USER\.md|KEY\.md/.test(src.writer),
    writerDryRunDefault: /if \(!apply\)/.test(src.writer)
      && /apply:\s*apply === true/.test(src.controller),
    writerArchiveFirst: /archive\.append\(target, original/.test(src.writer)
      && !/store\.remove\(|\.delete\(/.test(src.writer),
    writerRollback: /store\.write\(target, before, agent\)/.test(src.writer),
    dedupeInjected: /INJECTED_TARGETS\.has\(p\.target\)/.test(src.writer)
      && /isDuplicate\(store, p\.target, agent, p\.content\)/.test(src.writer),
    runtimeKeyWired: runtimeBlock.includes("'dreamEnabled'")
      && /case 'dreamEnabled':/.test(src.index),
    scheduleOptional: /ctx\.inject\(\['vssarosScheduler'\]/.test(src.schedule)
      && /const svc = scope\.vssarosScheduler/.test(src.schedule)
      && /typeof svc\?\.onFire !== 'function'/.test(src.schedule)
      && /scope\.effect\(\(\) => svc\.onFire\(/.test(src.schedule)
      && /fiber\.dispose\(\)/.test(src.schedule)
      && !/ctx\.inject\(\['schedule'\]/.test(src.schedule),
    settingsKeysPaired: [
      'dreamEnabled', 'dreamApprovalMode', 'dreamGroupSize', 'dreamMaxFiles', 'dreamRefuterModel',
    ].every((key) =>
      new RegExp(`${key}:`).test(src.index)
      && runtimeBlock.includes(`'${key}'`)
      && new RegExp(`case '${key}':`).test(src.index)
      && src.patch.includes(`${key}:`)),
    runtimeDrivenController: /export function dreamOptionsOf\(/.test(src.controller)
      && /getRuntime/.test(src.controller)
      && /'approval-mode-report'/.test(src.controller),
    llmRolesInjected: /createLlmRoles\(\{ llm: llmOf\(\), refuterModel: runtime\.dreamRefuterModel \?\? null \}\)/.test(src.controller)
      && /roles\?\.analyze \?\? conservativeAnalyze/.test(src.controller)
      && /getLlm/.test(src.controller),
    llmFailClosed: /typeof llm\.stream !== 'function'/.test(src.roles)
      && /解析失败，默认拒/.test(src.roles)
      && /return null/.test(src.roles)
      && /text-delta/.test(src.roles),
    boundedConcurrency: /mapWithConcurrency\(group, concurrency/.test(src.orchestrator)
      && /DEFAULT_CONCURRENCY\s*=\s*8/.test(src.conc)
      && /Math\.min\(size, list\.length\)/.test(src.conc),
    indexNotInjected: /'inject: false'/.test(src.wiki)
      && !/systemPrompt\.context|renderSnapshot/.test(src.wiki)
      && /writeIndex/.test(src.controller),
    qualityEvaluated: /manifest\.quality = evaluateRun/.test(src.orchestrator)
      && /export function fidelityOf/.test(src.evalu)
      && /export function estimateRunCost/.test(src.evalu),
    refuterModelIndependent: /model: refuterModel/.test(src.roles)
      && /case 'dreamRefuterModel':/.test(src.index),
    taskSpecReady: /method: 'dream.run'/.test(src.taskSpec)
      && /kind: 'action'/.test(src.taskSpec)
      && /memory-evolve\/api\/dream\/task-spec/.test(src.api),
    integrationWired: /apply\(ctx, \{ memoryDir \}\)/.test(src.integration)
      && /\/memory-evolve\/api\/config/.test(src.integration)
      && /\/memory-evolve\/api\/dream\/apply/.test(src.integration),
  }
}

const MUTATIONS = [
  { key: 'asyncZstd', file: 'decode', from: 'promisify(zlib.zstdDecompress)', to: 'zlib.zstdDecompressSync' },
  { key: 'defaultOff', file: 'index', from: 'dreamEnabled: false', to: 'dreamEnabled: true' },
  { key: 'windowOnlyOnSuccess', file: 'state', from: 'if (ok) {', to: 'if (true) {' },
  { key: 'closedOps', file: 'proposal', from: "'flag_conflict', 'link',", to: "'flag_conflict', 'link', 'remove'," },
  { key: 'reportOnly', file: 'orchestrator', from: 'manifest.applied = 0', to: 'manifest.applied = 1' },
  { key: 'exportReadOnly', file: 'export', from: 'memoryDirTouched: false', to: 'memoryDirTouched: true' },
  {
    key: 'noCrossPluginImport', file: 'controller',
    from: "import { exportSessions } from '../transcript/export.js'",
    to: "import { exportSessions } from '../../vssaros-sessions/lib/index.js'",
  },
  { key: 'onCheckChain', file: 'pkg', from: 'check-dreaming-contract.mjs', to: '__guard_removed__' },
  { key: 'writerNoDirectWrite', file: 'writer', from: 'withLock(lockAt, () => {', to: '/* 去掉锁 */ (() => {' },
  { key: 'writerDryRunDefault', file: 'writer', from: 'if (!apply) {', to: 'if (false) {' },
  { key: 'writerArchiveFirst', file: 'writer', from: 'archive.append(target, original', to: 'archive.__removed__(target, original' },
  { key: 'writerRollback', file: 'writer', from: 'store.write(target, before, agent)', to: 'store.__noRollback__(target, before, agent)' },
  { key: 'dedupeInjected', file: 'writer', from: 'isDuplicate(store, p.target, agent, p.content)', to: 'isDuplicateRemoved(store, p.target, agent, p.content)' },
  { key: 'runtimeKeyWired', file: 'index', from: "'canvasEnabled', 'dreamEnabled',", to: "'canvasEnabled'," },
  { key: 'scheduleOptional', file: 'schedule', from: "typeof svc?.onFire !== 'function'", to: 'false' },
  { key: 'scheduleOptional', file: 'schedule', from: "ctx.inject(['vssarosScheduler']", to: "ctx.inject(['schedule']" },
  { key: 'scheduleOptional', file: 'schedule', from: 'const svc = scope.vssarosScheduler', to: 'const svc = scope' },
  { key: 'scheduleOptional', file: 'schedule', from: 'scope.effect(() => svc.onFire(', to: 'svc.onFire(' },
  { key: 'scheduleOptional', file: 'schedule', from: 'fiber.dispose()', to: 'fiber.__notDisposed__()' },
  { key: 'settingsKeysPaired', file: 'index', from: "'dreamApprovalMode', 'dreamGroupSize', 'dreamMaxFiles',", to: '' },
  { key: 'runtimeDrivenController', file: 'controller', from: "reason: 'approval-mode-report'", to: "reason: '__removed__'" },
  { key: 'llmRolesInjected', file: 'controller', from: 'roles?.analyze ?? conservativeAnalyze', to: 'conservativeAnalyze' },
  { key: 'llmFailClosed', file: 'roles', from: "typeof llm.stream !== 'function'", to: 'false' },
  { key: 'boundedConcurrency', file: 'orchestrator', from: 'mapWithConcurrency(group, concurrency', to: 'Promise.all(group.map(' },
  { key: 'indexNotInjected', file: 'wiki', from: "'inject: false'", to: "'inject: true'" },
  { key: 'qualityEvaluated', file: 'orchestrator', from: 'manifest.quality = evaluateRun', to: 'manifest.quality = undefined' },
  { key: 'refuterModelIndependent', file: 'roles', from: 'model: refuterModel', to: 'model: undefined' },
  { key: 'taskSpecReady', file: 'taskSpec', from: "method: 'dream.run'", to: "method: '__removed__'" },
  { key: 'integrationWired', file: 'integration', from: '/memory-evolve/api/dream/apply', to: '/__removed__' },
]

const problems = []
function ok(label, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) problems.push(label)
}

const src = Object.fromEntries(Object.entries(FILES).map(([key, path]) => [key, read(path)]))
const baseline = verdict(src)
for (const [key, label] of Object.entries(LABELS)) ok(label, baseline[key])

for (const mutation of MUTATIONS) {
  const original = src[mutation.file]
  const changed = original.includes(mutation.from)
  // 全局替换：同一判据的代码可能出现在多个分支（archive.append / store.write(before)），
  // 只改第一处会让反向突变「假通过」——守卫自己也要防这一手。
  const mutated = changed ? original.split(mutation.from).join(mutation.to) : original
  const caught = changed && verdict({ ...src, [mutation.file]: mutated })[mutation.key] === false
  ok(`反向突变 ${mutation.key}`, caught, changed ? '' : '未找到突变锚点（源码形状变了，请同步守卫）')
}

const total = Object.keys(LABELS).length + MUTATIONS.length
console.log(`\n${total - problems.length}/${total} passed`)
if (!problems.length) {
  const run = spawnSync(process.execPath, ['--test',
    join(ROOT, 'dsh-plugins/vssaros-scheduler/test/service-isolation.test.js'),
    join(ROOT, 'dsh-plugins/vssaros-memory/tests/dream-schedule.test.js')],
    { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } })
  if (run.status !== 0) problems.push(`调度服务隔离与 Dream 生命周期测试失败（exit=${run.status}）：${String(run.stderr || run.stdout).slice(-3000)}`)
  else console.log(run.stdout.trim())
}
if (problems.length) {
  console.error(`失败项：\n- ${problems.join('\n- ')}`)
  process.exitCode = 1
}
