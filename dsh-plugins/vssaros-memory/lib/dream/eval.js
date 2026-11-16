/**
 * vssaros-memory/dream — 成本估算与保真率评测（P2-b，纯函数）。
 *
 * 官方示例：11 份转录约 $0.36 / 2.5 分钟；50+ 份 12 MB 约 $8 / 10 分钟。
 * 本仓不接计费 API，所以只做**确定性的规模估算**（tokens / 轮次 / 分组数）
 * 与事实保真率，供 manifest 与报告审计，不谎报真实花费。
 *
 * @module vssaros-memory/dream/eval
 */
import { conservationCheck } from './proposal.js'

/**
 * @param {Array} files
 * @param {{avgTokensPerFile?:number, groupSize?:number,
 *          organizerTokens?:number, refuterTokens?:number}} [options]
 */
export function estimateRunCost(files = [], options = {}) {
  const {
    avgTokensPerFile = 1000, groupSize = 20,
    organizerTokens = 2000, refuterTokens = 1000,
  } = options
  const count = Array.isArray(files) ? files.length : 0
  const size = Number.isInteger(groupSize) && groupSize > 0 ? groupSize : 20
  const groups = count === 0 ? 0 : Math.ceil(count / size)
  return {
    files: count,
    groups,
    tokens: count * avgTokensPerFile + groups * (organizerTokens + refuterTokens),
    turns: count + groups * 2, // 每份一次 analyzer + 每组各一次 organizer / refuter
  }
}

/** 事实保真率：合并/改写后原文还能逐字找到的比例。 */
export function fidelityOf(factsBefore = [], factsAfter = []) {
  const before = (Array.isArray(factsBefore) ? factsBefore : [])
    .map((line) => String(line ?? '').trim()).filter(Boolean)
  const { missing } = conservationCheck(before, factsAfter)
  const total = before.length
  if (total === 0) return { rate: 1, preserved: 0, total: 0, missing: [], ok: true }
  const preserved = total - missing.length
  return {
    rate: preserved / total,
    preserved, total, missing,
    ok: missing.length === 0,
  }
}

/** 把一轮 manifest + 事实清单汇总成可审计的评测结果。 */
export function evaluateRun({ manifest = {}, factsBefore = [], factsAfter = [] } = {}) {
  const fidelity = fidelityOf(factsBefore, factsAfter)
  const expected = Number(manifest?.expected ?? 0)
  const processed = Number(manifest?.processed ?? 0)
  const complete = expected === processed
  return {
    expected, processed, complete,
    tokens: Number(manifest?.budget?.tokens ?? 0),
    turns: Number(manifest?.turns ?? 0),
    fidelity: fidelity.rate,
    missing: fidelity.missing,
    ok: manifest?.ok === true && fidelity.ok && complete,
  }
}
