/**
 * vssaros-memory/dream — 提案契约（纯函数）。
 *
 * 对齐 dpro10/cookbook-brain：proposer 只能提**闭合操作集**；
 * 对齐官方 organizer_system.md：一条事实都不许丢；
 * 对齐本仓 memory-consolidate/SKILL.md：replace 是整条替换、归档优先禁用删除。
 *
 * @module vssaros-memory/dream/proposal
 */

/** 闭合操作集：新增操作必须先改这里 + 改守卫 + 改测试。 */
export const DREAM_OPERATIONS = Object.freeze([
  'add', 'replace', 'archive', 'summarize', 'flag_conflict', 'link',
])

const TARGETS = new Set(['memory', 'user', 'key', 'bot', 'daily', 'project', 'archive'])

function evidenceOk(evidence) {
  if (!evidence) return false
  if (typeof evidence === 'string') return evidence.trim().length > 0
  if (typeof evidence === 'object') return Boolean(evidence.file || evidence.path || evidence.at !== undefined)
  return false
}

function rejectReason(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return '提案不是对象'
  if (!DREAM_OPERATIONS.includes(proposal.op)) return `未登记操作：${String(proposal.op)}`
  if (!evidenceOk(proposal.evidence)) return '缺少证据（transcript 文件 / 事件序号）'
  const content = typeof proposal.content === 'string' ? proposal.content.trim() : ''
  const match = typeof proposal.match === 'string' ? proposal.match.trim() : ''
  switch (proposal.op) {
    case 'add':
      if (!TARGETS.has(proposal.target)) return `非法目标轨：${String(proposal.target)}`
      if (!content) return 'add 缺少完整条目正文'
      return null
    case 'replace':
      if (!match) return 'replace 缺少 match（要替换的条目）'
      if (!content) return 'replace 必须携带条目完整新全文（2026-09-16 静默吞内容事故）'
      return null
    case 'archive':
      if (!match) return 'archive 缺少 match'
      return null
    case 'summarize':
      if (!content) return 'summarize 缺少摘要正文'
      return null
    case 'flag_conflict':
      if (!match) return 'flag_conflict 缺少 match'
      return null
    case 'link':
      if (typeof proposal.slug !== 'string' || !proposal.slug.trim()) return 'link 缺少 slug'
      return null
    default:
      return '未登记操作'
  }
}

/**
 * 校验并规范化一批提案。返回副本，不改入参；坏条目只记原因，不中断整批。
 * @param {unknown} raw
 * @returns {{accepted: Array<object>, rejected: Array<{proposal:unknown, reason:string}>}}
 */
export function normalizeProposals(raw) {
  if (!Array.isArray(raw)) return { accepted: [], rejected: [] }
  const accepted = []
  const rejected = []
  for (const proposal of raw) {
    const reason = rejectReason(proposal)
    if (reason) rejected.push({ proposal, reason })
    else accepted.push({ ...proposal, source: proposal.source ?? 'dream' })
  }
  return { accepted, rejected }
}

/**
 * 事实守恒：before 的每一条事实行都要在 after 里还能找到（忽略首尾空白）。
 * 合并/改写不能悄悄丢事实 —— cookbook-brain 与 dream-warden 的同一条硬规则。
 * @returns {{ok:boolean, missing:string[]}}
 */
export function conservationCheck(beforeLines, afterLines) {
  const before = (Array.isArray(beforeLines) ? beforeLines : []).map((line) => String(line ?? '').trim()).filter(Boolean)
  const after = (Array.isArray(afterLines) ? afterLines : []).map((line) => String(line ?? '').trim())
  // 合并允许在原事实后追加说明（「…（合并）」），但原文必须仍能逐字找到；
  // 只写「旧值→新值」这种转述而不保留原句，仍判为丢失。
  const missing = before.filter((line) => !after.some((candidate) => candidate === line || candidate.includes(line)))
  return { ok: missing.length === 0, missing }
}
