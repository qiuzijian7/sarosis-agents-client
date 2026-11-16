/**
 * vssaros-memory/dream — 插件内装配入口（零新增插件）。
 *
 * P0：report-only 预览（导出 → 计数 → 报告），绝不写记忆六轨。
 * P1：受控 apply 通道（writer.js）、cron 可选订阅（schedule.js）、4 个运行时键。
 * P2-a：llm 服务可用时接上 analyzer / organizer / refuter 三种角色（roles.js），
 *       让 Dream 真正产出提案；服务缺席则整层回落 P0 保守实现，不装不报错。
 *
 * 审批走自己的 proposals.json，不复用 approveSuggestions —— 后者一律
 * store.add（review.js:455），会把 replace/archive 误当成新增条目。
 * 只暴露纯函数与轻控制器，不改 apply() 的 inject 数组、不注册 cordis 服务。
 *
 * @module vssaros-memory/dream
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exportSessions } from '../transcript/export.js'
import { runDream } from './orchestrator.js'
import { readState } from './state.js'
import { applyProposals } from './writer.js'
import { createLlmRoles } from './roles.js'
import { readIndex, writeIndex } from './index-md.js'

/**
 * 从运行时配置解析本轮参数（纯函数）。
 * 非法/缺失回落产品默认；超过上限夹到上限，绝不把坏 state 灌进导出器。
 */
export function dreamOptionsOf(runtime = {}, overrides = {}) {
  const r = runtime && typeof runtime === 'object' ? runtime : {}
  const o = overrides && typeof overrides === 'object' ? overrides : {}
  const intOrDefault = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) return fallback
    return Math.min(n, max)
  }
  return {
    groupSize: intOrDefault(o.groupSize !== undefined ? o.groupSize : r.dreamGroupSize, 20, 1, 50),
    maxFiles: intOrDefault(o.maxFiles !== undefined ? o.maxFiles : r.dreamMaxFiles, 500, 1, 500),
    approvalMode: r.dreamApprovalMode === 'approved' ? 'approved' : 'report',
  }
}

/** 默认确定性 analyzer：只读转录文本，不产提案（P0 保守实现）。 */
async function conservativeAnalyze(file) {
  let chars = 0
  try {
    chars = (await readFile(file.path, 'utf8')).length
  } catch {
    // 文件读不到就如实记为 0，不编造
  }
  return { file: file.name, chars, proposals: [], summary: 'P0 确定性分析（未接入 LLM）' }
}

/** 默认 organizer：只报告，不提任何写入操作。 */
async function conservativeOrganize(results) {
  return {
    proposals: [],
    changes: [`汇总 ${results.length} 份分析结果`],
    factsBefore: [], factsAfter: [],
  }
}

/** 默认 refuter：空提案集 → 空判定（合法复核，不是「缺席」）。 */
async function conservativeRefute(proposals) {
  return { verdicts: proposals.map(() => ({ keep: false, reason: 'P0 不自动批准任何提案' })) }
}

/**
 * @param {{memoryDir:string, dshHome:string, store?:object, archive?:object,
 *          resolveAgent?:Function, getRuntime?:Function, getLlm?:Function}} options
 */
export function createDreamController({
  memoryDir, dshHome, store = null, archive = null, resolveAgent = null,
  getRuntime = null, getLlm = null,
} = {}) {
  const root = join(memoryDir, 'dream')
  const stateFile = join(root, 'state.json')
  const runtimeOf = () => (typeof getRuntime === 'function' ? (getRuntime() ?? {}) : (getRuntime ?? {}))
  const llmOf = () => (typeof getLlm === 'function' ? (getLlm() ?? null) : null)

  /** 列出运行历史（新→旧），读各自的 manifest.json。 */
  async function listRuns(limit = 30) {
    let names = []
    try {
      names = await readdir(join(root, 'runs'), { withFileTypes: true })
    } catch {
      return []
    }
    const dirs = names.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse()
    const runs = []
    for (const name of dirs.slice(0, limit)) {
      try {
        runs.push(JSON.parse(await readFile(join(root, 'runs', name, 'manifest.json'), 'utf8')))
      } catch {
        // 坏 manifest 跳过，不影响整列表
      }
    }
    return runs
  }

  /** 读某一轮的已复核提案（审批页数据源）。 */
  async function readProposals(runId) {
    const safe = String(runId ?? '').replace(/[^A-Za-z0-9._-]/g, '')
    if (!safe) throw new Error('缺少 runId')
    try {
      return JSON.parse(await readFile(join(root, 'runs', safe, 'proposals.json'), 'utf8'))
    } catch {
      throw new Error(`运行 ${safe} 没有可审批的提案`)
    }
  }

  /** 手动预览一轮：只写 dream/runs/**，绝不写记忆六轨。 */
  async function run({ since = 0, until = Date.now() } = {}) {
    const runtime = runtimeOf()
    const options = dreamOptionsOf(runtime)
    // llm 缺席 ⇒ roles === null ⇒ 回落保守实现（headless / TUI 安全降级）。
    // 配了 dreamRefuterModel 时，只有 refuter 改用独立模型，其余角色仍继承。
    const roles = createLlmRoles({ llm: llmOf(), refuterModel: runtime.dreamRefuterModel ?? null })
    const exported = await exportSessions({
      dshHome, memoryDir,
      outDir: join(root, 'runs', `preview-${Date.now()}`, 'transcripts'),
      since, until, maxFiles: options.maxFiles,
    })
    const result = await runDream({
      files: exported.files,
      outDir: root,
      stateFile,
      groupSize: options.groupSize,
      models: roles?.models,
      analyze: roles?.analyze ?? conservativeAnalyze,
      organize: roles?.organize ?? conservativeOrganize,
      refute: roles?.refute ?? conservativeRefute,
    })
    // 只按需检索的运行目录：成功轮追加一条（新→旧，上限 30），失败轮不写。
    // 绝不注册 systemPrompt.context；_index.md 不进任何注入轨。
    if (result.ok) {
      const existing = await readIndex(memoryDir)
      const entry = { slug: result.runId, title: `预览 · 提案 ${result.proposals.length} · ok` }
      await writeIndex({ memoryDir, entries: [entry, ...existing], at: new Date().toISOString() })
    }
    return { ...result, options, roles: Boolean(roles), exported, state: readState(stateFile) }
  }

  /**
   * P1 受控写入：默认 dry-run，`apply === true` 才经 writer 落盘。
   * 两道闸：①审批模式必须是 approved；②审批必须显式给 runId。
   */
  async function applyRun({ runId, apply = false, indices = null } = {}) {
    const options = dreamOptionsOf(runtimeOf())
    if (apply === true && options.approvalMode !== 'approved') {
      // 只报告模式下连 proposals.json 都不读：不泄露、不写盘、不留半成品。
      return {
        ok: false, dryRun: false, applied: 0, reason: 'approval-mode-report',
        runId: String(runId ?? ''), proposals: 0, skipped: [], changes: [],
      }
    }
    const all = await readProposals(runId)
    const chosen = Array.isArray(indices)
      ? indices.map((i) => all[Number(i)]).filter(Boolean)
      : all
    const safe = String(runId ?? '').replace(/[^A-Za-z0-9._-]/g, '')
    const runDir = join(root, 'runs', safe)
    const agent = typeof resolveAgent === 'function' ? (resolveAgent() ?? {}) : {}
    const result = applyProposals({
      proposals: chosen,
      store,
      archive,
      agent,
      runDir,
      apply: apply === true,
    })
    if (apply === true) {
      await writeFile(join(runDir, 'apply-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    }
    return { ...result, runId: safe, proposals: chosen.length, options }
  }

  return { root, stateFile, listRuns, readProposals, run, applyRun }
}

export { runDream } from './orchestrator.js'
export { readState, beginRun, finishRun, writeState } from './state.js'
export { DREAM_OPERATIONS, normalizeProposals, conservationCheck } from './proposal.js'
export { applyProposals, INJECTED_TARGETS } from './writer.js'
export { attachDreamSchedule, shouldRunDream } from './schedule.js'
export { createLlmRoles, callModelOnce, extractJson } from './roles.js'
