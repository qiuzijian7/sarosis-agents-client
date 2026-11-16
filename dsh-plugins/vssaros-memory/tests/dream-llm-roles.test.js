/**
 * Dreaming P2-a — 插件内 LLM 角色适配器契约。
 * 单跑：node --test tests/dream-llm-roles.test.js
 *
 * 对齐官方 Cookbook：分组 analyzer（Verify→Enrich→Organize）→ 末尾一次
 * organizer（不读 transcript 正文）→ 独立上下文 refuter（解析不出默认拒）。
 * 对齐 dpro10/cookbook-brain：refuter 整体不可用 ⇒ 整轮零写入。
 * 实现只用本仓 ctx.llm.stream()（AsyncIterable<text-delta>），不依赖 CMA。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ANALYZER_SYSTEM, ORGANIZER_SYSTEM, REFUTER_SYSTEM,
  extractJson, callModelOnce, makeAnalyzer, makeOrganizer, makeRefuter, createLlmRoles,
} from '../lib/dream/roles.js'
import { createDreamController } from '../lib/dream/index.js'
import { runDream } from '../lib/dream/orchestrator.js'

function withTmp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dream-roles-'))
  try { return fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

/** 假 llm：按已确认的 llm.stream(options) 形态产出 chunk。 */
function fakeLlm(reply, { onOptions, error } = {}) {
  return {
    stream: async function* (options) {
      if (onOptions) onOptions(options)
      if (error) { yield { type: 'error', message: error }; return }
      yield { type: 'block-start' }
      yield { type: 'text-delta', text: reply }
      yield { type: 'block-end' }
      yield { type: 'finish' }
    },
  }
}

const PROPOSALS = [
  { op: 'add', target: 'daily', content: 'CI 需要 deploy token（按名称取，不写值）' },
  { op: 'replace', target: 'key', match: '旧说法', content: '0.4.0 起 make test 无需环境变量（保留旧值对照）' },
]

test('三份系统提示词：规则齐备且不引入 CMA / SDK 细节', () => {
  assert.match(ANALYZER_SYSTEM, /Verify/)
  assert.match(ANALYZER_SYSTEM, /Enrich/)
  assert.match(ANALYZER_SYSTEM, /Organize/)
  assert.match(ANALYZER_SYSTEM, /不可信|数据/)
  for (const prompt of [ANALYZER_SYSTEM, ORGANIZER_SYSTEM, REFUTER_SYSTEM]) {
    assert.ok(!/memory_stores|client\.beta|Managed Agents/i.test(prompt))
    assert.match(prompt, /add \/ replace \/ archive/)
  }
})

test('extractJson：裸 JSON / ```json 块 / 前后带说明都能取到，坏文本返回 null', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('分析如下：\n{"proposals":[]}\n以上。'), { proposals: [] })
  assert.equal(extractJson('完全没有 JSON'), null)
  assert.equal(extractJson('{"a": 坏'), null)
})

test('callModelOnce：累加 text-delta，并把 system / prompt / signal 传给 llm.stream', async () => {
  let seen = null
  const llm = fakeLlm('第一段' + '第二段', { onOptions: (o) => { seen = o } })
  const llm2 = {
    stream: async function* (o) {
      seen = o
      yield { type: 'text-delta', text: '第一段' }
      yield { type: 'text-delta', text: '第二段' }
      yield { type: 'finish' }
    },
  }
  const out = await callModelOnce({ llm: llm2, system: 'S', prompt: 'P', maxTokens: 123 })
  assert.deepEqual(out, { ok: true, text: '第一段第二段' })
  assert.equal(seen.system, 'S')
  assert.equal(seen.maxTokens, 123)
  assert.match(JSON.stringify(seen.messages), /P/)
  assert.ok(seen.signal, '必须传 AbortSignal 以便超时')
  assert.equal((await callModelOnce({ llm, system: 'S', prompt: 'P' })).ok, true)
})

test('callModelOnce：error chunk / llm 缺席一律 fail-closed，不抛到 apply()', async () => {
  const bad = await callModelOnce({ llm: fakeLlm('', { error: 'quota' }), system: 'S', prompt: 'P' })
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /quota|error|失败/i)
  for (const llm of [null, undefined, {}, { stream: 'x' }]) {
    const out = await callModelOnce({ llm, system: 'S', prompt: 'P' })
    assert.equal(out.ok, false)
  }
})

test('makeAnalyzer：把模型输出解析成合法提案，自动补证据，坏条目被过滤', async () => {
  const calls = []
  const analyze = makeAnalyzer({
    callModel: async ({ prompt }) => {
      calls.push(prompt)
      return { ok: true, text: JSON.stringify({ proposals: [...PROPOSALS, { op: 'remove', target: 'daily', content: 'x' }] }) }
    },
    readFile: async () => 'USER:\n查一下测试命令\nAGENT:\n结论：无需环境变量',
  })
  const result = await analyze({ name: '01.txt', path: '/tmp/01.txt' })
  assert.equal(result.proposals.length, 2)
  assert.equal(result.rejected.length, 1, '未登记操作 remove 必须被拒')
  assert.ok(result.proposals.every((p) => p.evidence && String(p.evidence.file).includes('01.txt')))
  assert.match(calls[0], /查一下测试命令/, 'analyzer 要读 transcript 正文')
  assert.match(calls[0], /Verify/)
})

test('makeAnalyzer：坏 JSON / 调用失败都不编造提案（调用失败上抛以触发计数不全）', async () => {
  const badJson = makeAnalyzer({
    callModel: async () => ({ ok: true, text: '这不是 JSON' }),
    readFile: async () => '正文',
  })
  const out = await badJson({ name: 'x.txt', path: '/tmp/x.txt' })
  assert.deepEqual(out.proposals, [])
  const failed = makeAnalyzer({
    callModel: async () => ({ ok: false, reason: 'llm 缺席' }),
    readFile: async () => '正文',
  })
  await assert.rejects(() => failed({ name: 'x.txt', path: '/tmp/x.txt' }), /llm|失败/i)
})

test('makeOrganizer：只拿分析结果，不读 transcript 正文', async () => {
  let prompt = ''
  const organize = makeOrganizer({
    callModel: async ({ prompt: p }) => {
      prompt = p
      return { ok: true, text: JSON.stringify({
        proposals: PROPOSALS, changes: ['合并 1 组'],
        factsBefore: ['旧事实'], factsAfter: ['旧事实', '新事实'],
      }) }
    },
  })
  const out = await organize([
    { file: '01.txt', proposals: PROPOSALS, summary: 'ok' },
    { file: '02.txt', proposals: [], summary: 'ok' },
  ])
  assert.equal(out.proposals.length, 2)
  assert.deepEqual(out.factsBefore, ['旧事实'])
  assert.match(prompt, /01\.txt/)
  assert.ok(!prompt.includes('USER:\n查一下'), 'organizer 不许读 transcript 正文')
})

test('makeRefuter：逐条 keep/reject；解析失败默认全拒；整体不可用返回 null', async () => {
  const good = makeRefuter({
    callModel: async () => ({ ok: true, text: JSON.stringify({ verdicts: [{ keep: true, reason: '有证据' }, { keep: false, reason: '冲突' }] }) }),
  })
  const verdict = await good(PROPOSALS)
  assert.deepEqual(verdict.verdicts.map((v) => v.keep), [true, false])

  const unparsable = makeRefuter({ callModel: async () => ({ ok: true, text: '模型没按格式回' }) })
  const rejected = await unparsable(PROPOSALS)
  assert.equal(rejected.verdicts.length, 2)
  assert.ok(rejected.verdicts.every((v) => v.keep === false), '解析不出默认拒')

  const absent = makeRefuter({ callModel: async () => ({ ok: false, reason: 'llm 缺席' }) })
  assert.equal(await absent(PROPOSALS), null, 'refuter 缺席要让编排器整轮失败')
})

test('createLlmRoles：llm 缺席返回 null（回落保守实现），可用时给齐三个角色', () => {
  assert.equal(createLlmRoles({ llm: null }), null)
  assert.equal(createLlmRoles({ llm: {} }), null)
  const roles = createLlmRoles({ llm: fakeLlm(JSON.stringify({ proposals: [], verdicts: [] })) })
  assert.equal(typeof roles.analyze, 'function')
  assert.equal(typeof roles.organize, 'function')
  assert.equal(typeof roles.refute, 'function')
})

test('端到端：LLM 角色注入 runDream 能产出提案，refuter 缺席则整轮零写入', async () => withTmp(async (root) => {
  const files = Array.from({ length: 3 }, (_, i) => {
    const path = join(root, `s${i}.txt`)
    writeFileSync(path, 'USER:\n查一下\n', 'utf8')
    return { name: `s${i}.txt`, path }
  })
  const roles = {
    analyze: makeAnalyzer({
      callModel: async () => ({ ok: true, text: JSON.stringify({ proposals: [PROPOSALS[0]] }) }),
      readFile: async () => '正文',
    }),
    organize: makeOrganizer({
      callModel: async () => ({ ok: true, text: JSON.stringify({ proposals: [PROPOSALS[0]], changes: [], factsBefore: [], factsAfter: [] }) }),
    }),
    refute: makeRefuter({
      callModel: async () => ({ ok: true, text: JSON.stringify({ verdicts: [{ keep: true, reason: '有证据' }] }) }),
    }),
  }
  const ok = await runDream({ files, outDir: root, stateFile: join(root, 'state.json'), ...roles })
  assert.equal(ok.ok, true, ok.reason)
  assert.equal(ok.manifest.processed, 3)
  assert.equal(ok.proposals.length, 1)
  assert.equal(ok.manifest.applied, 0, 'P2 仍是 report-only')

  const absent = await runDream({
    files, outDir: join(root, 'b'), stateFile: join(root, 'b', 'state.json'),
    ...roles,
    refute: async () => null,
  })
  assert.equal(absent.ok, false)
  assert.equal(absent.reason, 'refuter-absent')
  assert.deepEqual(absent.proposals, [])
}))

test('控制器：getLlm 返回 null 时仍走保守实现，不抛错（headless/TUI 安全）', async () => withTmp(async (root) => {
  const ctrl = createDreamController({
    memoryDir: join(root, 'memories'), dshHome: root,
    getRuntime: () => ({}), getLlm: () => null,
  })
  const out = await ctrl.run({})
  assert.equal(out.ok, true, out.reason)
  assert.equal(out.options.approvalMode, 'report')
}))
