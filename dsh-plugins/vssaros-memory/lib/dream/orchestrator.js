/**
 * vssaros-memory/dream — 带外编排（P0：report-only，绝不写记忆六轨）。
 *
 * 顺序对齐官方 analyzer_system.md：分组（约 20）→ 每份一个 analyzer →
 * 计数校验 → organizer 一次 → 对抗 refuter → 提案落盘。
 * 三条硬闸门：计数不全 / refuter 不可用 / 事实不守恒 ⇒ 整轮失败、零写入。
 *
 * analyzer / organizer / refute 全部可注入：P0 不调 LLM、不起子会话、
 * 不依赖 Claude Managed Agents；P2 再换成本仓 llm 服务与 de_session 并行。
 *
 * @module vssaros-memory/dream/orchestrator
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beginRun, finishRun } from './state.js'
import { conservationCheck, normalizeProposals } from './proposal.js'
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from './concurrency.js'
import { estimateRunCost, evaluateRun } from './eval.js'

const DEFAULT_BUDGET = { maxTokens: Infinity, maxTurns: Infinity }

function defaultEstimate(files) {
  return estimateRunCost(files)
}

function groupsOf(files, groupSize) {
  const list = Array.isArray(files) ? files : []
  const size = Number.isInteger(groupSize) && groupSize > 0 ? groupSize : 20
  const groups = []
  for (let i = 0; i < list.length; i += size) groups.push(list.slice(i, i + size))
  return groups
}

function baseManifest({ files, budget, at, runId, concurrency }) {
  return {
    expected: Array.isArray(files) ? files.length : 0,
    processed: 0,
    failures: [],
    organized: false,
    refuted: 0,
    applied: 0,
    index_entries: 0,
    concurrency,
    changes: [],
    rejected: [],
    missing: [],
    budget: { ...budget },
    runId,
    at,
    ok: false,
    reason: null,
  }
}

async function writeRunArtifacts(runDir, { manifest, proposals, report }) {
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await writeFile(join(runDir, 'proposals.json'), `${JSON.stringify(proposals, null, 2)}\n`, 'utf8')
  await writeFile(join(runDir, 'report.md'), report, 'utf8')
}

function reportOf(manifest, proposals, skipped) {
  return [
    `# Dream 运行报告（P0 · report-only）`,
    ``,
    `- 已分析：${manifest.processed} / ${manifest.expected}`,
    `- 失败：${manifest.failures.length}`,
    `- organizer：${manifest.organized ? '完成' : '未执行'}`,
    `- refuter 通过：${manifest.refuted}`,
    `- applied：${manifest.applied}（P0 恒为 0，不写任何记忆文件）`,
    `- 结果：${manifest.ok ? '成功' : `失败（${manifest.reason}）`}`,
    ``,
    `## 提案`,
    ...(proposals.length ? proposals.map((p) => `- [${p.op}] ${p.target ?? ''} ${p.content ?? p.match ?? ''}（证据 ${JSON.stringify(p.evidence)}）`) : ['- （无）']),
    ``,
    `## 跳过`,
    ...(skipped.length ? skipped.map((s) => `- ${s.name ?? s.input}：${s.why ?? s.reason}`) : ['- （无）']),
    ``,
  ].join('\n')
}

/**
 * 跑一轮 Dream。任何失败分支都不写记忆六轨，也不返回可应用的提案。
 * @returns {Promise<{ok:boolean, reason:string|null, manifest:object, proposals:Array, runId:string|null, outDir:string|null}>}
 */
export async function runDream(options = {}) {
  const {
    files = [],
    outDir,
    stateFile,
    groupSize = 20,
    concurrency = DEFAULT_CONCURRENCY,
    budget = DEFAULT_BUDGET,
    estimate = defaultEstimate,
    analyze,
    organize,
    refute,
    models = { analyzer: 'injected', organizer: 'injected', refuter: 'injected' },
    now = () => new Date().toISOString(),
  } = options
  const at = now()
  const manifest = baseManifest({ files, budget, at, runId: null, concurrency })
  manifest.models = models

  const begin = beginRun(stateFile, { at })
  if (!begin.ok) {
    manifest.reason = begin.reason
    return { ok: false, reason: begin.reason, manifest, proposals: [], runId: null, outDir: null }
  }
  const runId = begin.runId
  manifest.runId = runId
  const runDir = join(outDir, 'runs', runId)

  const finalize = async (proposals) => {
    let artifactsWritten = false
    try {
      await writeRunArtifacts(runDir, {
        manifest, proposals,
        report: reportOf(manifest, proposals, manifest.ok ? [] : manifest.failures),
      })
      artifactsWritten = true
    } finally {
      finishRun(stateFile, {
        ok: artifactsWritten && manifest.ok,
        at: now(), runId,
        reason: artifactsWritten ? manifest.reason : 'artifact-write-failed',
      })
    }
    return { ok: manifest.ok, reason: manifest.reason, manifest, proposals, runId, outDir: runDir }
  }

  /** 所有失败出口统一收尾：释放 running、只在成功时推进窗口。 */
  const fail = async (reason, extras = {}) => {
    Object.assign(manifest, extras)
    manifest.ok = false
    manifest.reason = reason
    return await finalize([])
  }

  // ① 估算先行：超限直接停，不部分写入，也不调用 analyzer。
  try {
    const quote = await estimate(files, budget)
    manifest.budget.tokens = quote?.tokens ?? 0
    if (Number.isFinite(budget?.maxTokens) && (quote?.tokens ?? 0) > budget.maxTokens) {
      return await fail('budget-exceeded')
    }
    if (Number.isFinite(budget?.maxTurns) && (quote?.turns ?? 0) > budget.maxTurns) {
      return await fail('budget-exceeded')
    }
  } catch (error) {
    return await fail('estimate-failed', { failures: [{ input: 'estimate', reason: String(error?.message ?? error) }] })
  }

  // ② 分组 → 每份一个 analyzer；组内并行但有上限，一组做完再下一组。
  const results = []
  const failures = []
  for (const group of groupsOf(files, groupSize)) {
    const settled = await mapWithConcurrency(group, concurrency, async (file) => {
      try {
        const result = await analyze(file)
        return { ok: true, input: file.name ?? String(file.path ?? ''), result }
      } catch (error) {
        return { ok: false, input: file.name ?? String(file.path ?? ''), reason: String(error?.message ?? error) }
      }
    })
    for (const item of settled) {
      if (item.ok) results.push(item.result)
      else failures.push({ input: item.input, reason: item.reason })
    }
  }
  manifest.processed = results.length
  manifest.failures = failures
  if (manifest.processed !== manifest.expected || failures.length > 0) {
    return await fail('incomplete')
  }

  // ③ organizer 只跑一次。
  let organized
  try {
    organized = await organize(results)
  } catch (error) {
    return await fail('organizer-failed', { failures: [{ input: 'organizer', reason: String(error?.message ?? error) }] })
  }
  manifest.organized = true
  manifest.changes = Array.isArray(organized?.changes) ? organized.changes : []

  const { accepted, rejected } = normalizeProposals(organized?.proposals ?? [])
  manifest.rejected = rejected

  // ④ 对抗 refuter：缺席 / 抛错 / 判定解析不出 ⇒ 零写入（cookbook-brain 规则）。
  let verdicts = null
  try {
    const verdict = await refute(accepted)
    verdicts = verdict?.verdicts ?? null
  } catch {
    verdicts = null
  }
  if (!Array.isArray(verdicts) || verdicts.length !== accepted.length ||
      verdicts.some((v) => typeof v?.keep !== 'boolean')) {
    return await fail('refuter-absent')
  }
  const kept = accepted.filter((_, i) => verdicts[i].keep)

  // ⑤ 事实守恒：一条都不许丢。
  const conservation = conservationCheck(organized?.factsBefore, organized?.factsAfter)
  if (!conservation.ok) {
    return await fail('conservation-failed', { missing: conservation.missing })
  }

  manifest.refuted = kept.length
  manifest.applied = 0
  manifest.ok = true
  manifest.reason = null
  manifest.quality = evaluateRun({
    manifest,
    factsBefore: organized?.factsBefore,
    factsAfter: organized?.factsAfter,
  })
  return await finalize(kept)
}
