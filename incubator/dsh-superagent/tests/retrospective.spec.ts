// VsSaros addition: what a finished team plan leaves behind — skill drafts in the shared skills library,
// their approval, and a reusable team workflow. Real temporary SQLite plus a real temporary skills root.
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { coverage, Retrospective, skillsRootOf, words, WORKFLOW_MATCH_THRESHOLD } from '../src/app/retrospective.ts'
import { Store } from '../src/app/store.ts'
import type { PlanView } from '../src/app/team.ts'

let dir: string
let root: string
let store: Store
let retro: Retrospective

const plan = (): PlanView => ({
  id: 'plan-1', goal: '首页新手引导上线', status: 'done', createdAt: '2026-11-04T10:00:00.000Z',
  endedAt: '2026-11-04T12:14:00.000Z', running: 0, bots: ['设计 bot', '数据 bot'],
  steps: [
    { id: 'T1', planId: 'plan-1', title: '交互方案', spec: '出 5 步交互稿', bot: '设计 bot', botId: 'designer',
      botName: '设计 bot', after: [], state: 'done', hop: 2, report: '交互稿 5 屏，含跳过与重入规则。' },
    { id: 'T2', planId: 'plan-1', title: '回归测试', spec: '覆盖每一步', bot: '测试 bot', botId: 'tester',
      botName: '测试 bot', after: ['T1'], state: 'done', hop: 4, att: 2, report: '运行 npx playwright test 后 14 条用例通过。' },
    { id: 'T3', planId: 'plan-1', title: '发版通知', spec: '发到 {{chat}}', bot: '发布 bot', botId: 'publisher',
      botName: '发布 bot', after: ['T2'], state: 'done', hop: 2, report: '版本说明已发。' },
  ],
  exchanges: [],
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-retro-'))
  root = join(dir, 'skills')
  store = new Store(join(dir, 'orchestrator.sqlite'))
  retro = new Retrospective({ store, skillsRoot: root, warn: () => {} })
})
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

describe('words and coverage', () => {
  it('compares latin words and Chinese bigrams', () => {
    expect(words('Playwright 引导流程')).toContain('playwright')
    expect(words('引导流程')).toContain('导流')
    expect(coverage('新手引导上线', '首页新手引导上线')).toBeGreaterThan(WORKFLOW_MATCH_THRESHOLD)
    expect(coverage('缺陷分诊', '首页新手引导上线')).toBeLessThan(WORKFLOW_MATCH_THRESHOLD)
  })
  it('resolves the skills root from the foundation service, then the environment, then the home', () => {
    expect(skillsRootOf({ dataRootOf: () => '/srv/data' }, {})).toBe(join('/srv/data', 'skills'))
    expect(skillsRootOf(undefined, { VSSAROS_DATA_ROOT: '/env/data' })).toBe(join('/env/data', 'skills'))
  })
})

describe('a finished plan', () => {
  it('distills skills into the shared library and drafts the risky ones into .drafts', async () => {
    await retro.onPlanEnd(plan())
    const skills = retro.tables.skills()
    expect(skills.length).toBeGreaterThanOrEqual(3)
    const active = skills.filter(skill => skill.state === 'active')
    const waiting = skills.filter(skill => skill.state === 'draft')
    expect(waiting.length).toBeGreaterThan(0) // the one whose report contains npx playwright test
    for (const skill of skills) {
      const file = skill.state === 'active' ? join(root, skill.name, 'SKILL.md') : join(root, '.drafts', skill.name, 'SKILL.md')
      expect(existsSync(file)).toBe(true)
      const text = readFileSync(file, 'utf8')
      expect(text).toMatch(/^---\nname: /)
      expect(text).toContain(`version: ${skill.version}`)
      expect(text).toContain('description: ')
      expect(skill.file).toBe(file)
    }
    expect(active.some(skill => skill.scope === 'supervisor')).toBe(true)
  })
  it('is idempotent, and a close skill becomes a new version instead of a second file', async () => {
    await retro.onPlanEnd(plan())
    const before = retro.tables.skills()
    await retro.onPlanEnd(plan())
    expect(retro.tables.skills()).toHaveLength(before.length)
    const same = plan()
    same.id = 'plan-2'
    same.steps[0]!.report = '交互稿 5 屏，含跳过与重入规则。'
    await retro.onPlanEnd(same)
    expect(retro.tables.skills().some(skill => skill.version > 1)).toBe(true)
  })
  it('a person approves or rejects a risky skill; only approved ones reach the active library', async () => {
    await retro.onPlanEnd(plan())
    const waiting = retro.tables.skills('draft')
    expect(waiting.length).toBeGreaterThan(0)
    const approved = await retro.approveSkill(waiting[0]!.id)
    expect(approved.state).toBe('active')
    expect(existsSync(join(root, approved.name, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root, '.drafts', approved.name, 'SKILL.md'))).toBe(false)
    if (waiting[1]) {
      const rejected = await retro.rejectSkill(waiting[1].id)
      expect(rejected.state).toBe('rejected')
      expect(existsSync(join(root, '.drafts', rejected.name, 'SKILL.md'))).toBe(false)
    }
    await expect(retro.approveSkill(waiting[0]!.id)).rejects.toThrow(/active/)
  })
  it('drafts a reusable workflow with parameters, steps, gates and budget, then saves and runs it', async () => {
    await retro.onPlanEnd(plan())
    const [draft] = retro.tables.workflows('draft')
    expect(draft?.fromPlanId).toBe('plan-1')
    expect(draft?.steps).toHaveLength(3)
    expect(draft?.params.map(param => param.key)).toContain('chat')
    expect(draft?.gates.some(gate => gate.includes('T3'))).toBe(true)
    expect(draft?.budget).toEqual({ tokens: 300_000, turns: 90, parallel: 3 })
    expect(retro.match('首页新手引导上线')).toHaveLength(0) // drafts are never matched
    const saved = retro.saveWorkflow(draft!.id)
    expect(saved.state).toBe('saved')
    const hits = retro.match('首页新手引导上线')
    expect(hits[0]?.score).toBeGreaterThanOrEqual(WORKFLOW_MATCH_THRESHOLD * 100)
    expect(retro.run(draft!.id).runs).toBe(1)
    expect(retro.run(draft!.id).runs).toBe(2)
    expect(() => retro.run('missing')).toThrow(/No workflow/)
  })
})
