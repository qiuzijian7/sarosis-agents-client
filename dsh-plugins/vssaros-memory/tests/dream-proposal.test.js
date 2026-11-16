/**
 * Dreaming P0 — 提案契约：闭合操作集、证据必填、replace 全文、事实守恒。
 * 单跑：node --test tests/dream-proposal.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DREAM_OPERATIONS, normalizeProposals, conservationCheck } from '../lib/dream/proposal.js'

const EVIDENCE = { file: 'transcripts/07-release.txt', at: 142 }

function proposal(overrides = {}) {
  return {
    op: 'add', target: 'daily', content: '一条完整的新事实',
    evidence: EVIDENCE, source: 'dream', ...overrides,
  }
}

test('闭合操作集：6 项、冻结、不含 remove', () => {
  assert.ok(Object.isFrozen(DREAM_OPERATIONS))
  assert.equal(DREAM_OPERATIONS.length, 6)
  assert.ok(DREAM_OPERATIONS.includes('archive'))
  assert.ok(!DREAM_OPERATIONS.includes('remove'), '本仓纪律：归档优先，禁用删除')
  assert.ok(!DREAM_OPERATIONS.includes('apply'), 'apply 是执行阶段，不是提案操作')
})

test('合法提案被接受，且入参不被修改（纯函数）', () => {
  const input = [proposal()]
  const snapshot = JSON.stringify(input)
  const { accepted, rejected } = normalizeProposals(input)
  assert.equal(accepted.length, 1)
  assert.equal(rejected.length, 0)
  assert.equal(JSON.stringify(input), snapshot)
  assert.notEqual(accepted[0], input[0], '返回的是规范化副本，不是复用可变引用')
})

test('未登记操作 / 缺证据 / 非法 target 全部被拒绝且不中断整批', () => {
  const input = [
    proposal({ op: 'remove' }),
    proposal({ op: 'exec' }),
    proposal({ evidence: undefined }),
    proposal({ target: 'system-prompt' }),
    proposal(),
  ]
  const { accepted, rejected } = normalizeProposals(input)
  assert.equal(accepted.length, 1)
  assert.equal(rejected.length, 4)
  assert.ok(rejected.every((r) => typeof r.reason === 'string' && r.reason.length > 0))
})

test('replace 必须携带 match + 条目完整新全文（2026-09-16 静默吞内容事故）', () => {
  const bad = [
    proposal({ op: 'replace', content: undefined }),
    proposal({ op: 'replace', match: undefined, content: '全文' }),
    proposal({ op: 'replace', match: '旧说法', content: '只给增量' }),
  ]
  const { accepted, rejected } = normalizeProposals(bad)
  assert.equal(accepted.length, 1, 'content 是自由文本，只有缺 match / 缺 content 才能判死')
  assert.equal(rejected.length, 2)
})

test('archive 要 match；link 要 slug；summarize 要 content', () => {
  const { accepted, rejected } = normalizeProposals([
    proposal({ op: 'archive', match: '重复条目' }),
    proposal({ op: 'archive' }),
    proposal({ op: 'link', slug: 'tidewick-repo-orientation' }),
    proposal({ op: 'link' }),
    proposal({ op: 'summarize', content: '摘要' }),
    proposal({ op: 'summarize', content: undefined }),
  ])
  assert.equal(accepted.length, 3)
  assert.equal(rejected.length, 3)
})

test('非数组输入返回空集合而不是抛错', () => {
  for (const raw of [null, undefined, {}, 'x']) {
    const { accepted, rejected } = normalizeProposals(raw)
    assert.deepEqual(accepted, [])
    assert.deepEqual(rejected, [])
  }
})

test('conservationCheck：事实行一条都不能丢', () => {
  const before = ['make test 需要 TIDEWICK_DATA_DIR', '0.4.0 起改为 __file__ 锚定', 'deploy token 按名称取']
  const after = ['0.4.0 起改为 __file__ 锚定（合并）', 'deploy token 按名称取', '旧值→新值：0.4.0 前需要环境变量']
  const result = conservationCheck(before, after)
  assert.equal(result.ok, false)
  assert.equal(result.missing.length, 1)
  assert.match(result.missing[0], /TIDEWICK_DATA_DIR/)
})

test('conservationCheck：全保留 + 忽略空白差异 → 通过', () => {
  const before = ['事实 A', '事实 B']
  const after = ['  事实 A  ', '事实 B', '新增事实 C']
  assert.deepEqual(conservationCheck(before, after), { ok: true, missing: [] })
})

test('conservationCheck：空 before 视为通过', () => {
  assert.equal(conservationCheck([], ['任意']).ok, true)
})
