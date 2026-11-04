/**
 * VsSaros addition: what a team plan leaves behind. When a plan ends, the Retrospective turns its reports, failures and
 * dependencies into skill drafts and one reusable team workflow. Skills go into the same skills library as
 * `vssaros-skills` (`<dataRoot>/skills/<id>/SKILL.md`, `.drafts/` for ones waiting for a person) — no second library,
 * no write through a Session tool: the supervisor's own panel is the gate, and a safe skill takes effect at once.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Store } from './store.ts'
import { TeamError, type PlanView, type TeamStep } from './team.ts'

/** A saved workflow is reused when this much of the new request's words its name and steps cover. */
export const WORKFLOW_MATCH_THRESHOLD = 0.7
/** A skill with one of these in its body needs a person before it is injected into any Bot. */
const RISKY = /\b(npx|npm|pnpm|yarn|git|bash|pwsh|shell|curl|wget|http|https|feishu|mail|email|webhook|secret|token|password|credential|deploy|publish|send)\b/i
/** A draft with this much word overlap with a skill already in the library becomes a new version of it. */
const SIMILARITY = 0.8
const now = () => new Date().toISOString()

export type SkillState = 'draft' | 'active' | 'rejected'
export interface SkillRecord {
  id: string; name: string; title: string; description: string; scope: string; origin: string; evidence: string
  risk: 'low' | 'medium'; state: SkillState; version: number; body: string; planId: string; file: string; at: string
}
export interface WorkflowParam { key: string; label: string; value?: string }
export interface WorkflowStep { key: string; title: string; spec: string; bot: string; after: string[] }
export interface TeamWorkflow {
  id: string; name: string; version: number; fromPlanId: string; goal: string; state: 'draft' | 'saved'
  params: WorkflowParam[]; steps: WorkflowStep[]; gates: string[]; budget: { tokens: number; turns: number; parallel: number }
  triggers: string[]; runs: number; ok: number; at: string
}
/** How well a saved workflow fits a new request. */
export interface WorkflowMatch { id: string; name: string; version: number; score: number }

/** Words of a string: latin/digit runs and Chinese bigrams, so either language can be compared. */
export function words(text: string): string[] {
  const lower = String(text ?? '').toLowerCase()
  const latin = lower.match(/[a-z0-9_-]{2,}/g) ?? []
  const han = lower.match(/[\u3400-\u9fff]/g) ?? []
  const grams = han.slice(1).map((ch, i) => han[i] + ch)
  return [...new Set([...latin, ...grams])]
}
/** How much of `a` is covered by `b` (0..1); a short request against a long workflow name still scores fairly. */
export function coverage(a: string, b: string): number {
  const left = words(a), right = new Set(words(b))
  if (!left.length || !right.size) return 0
  return left.filter(word => right.has(word)).length / left.length
}

/** The skills library root, following `vssaros-foundation`'s `dataRootOf` without importing that package. */
export function skillsRootOf(foundation?: { dataRootOf?: (config: object) => string }, env: NodeJS.ProcessEnv = process.env): string {
  const fromService = foundation?.dataRootOf?.({})
  const root = fromService || env.VSSAROS_DATA_ROOT?.trim() || join(homedir(), '.vssaros')
  return join(root, 'skills')
}

/** Atoms for the two `team_*` tables this module owns. */
export class RetroStore {
  constructor(private readonly store: Pick<Store, 'db' | 'atomic'>) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS team_skill (id TEXT PRIMARY KEY, state TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_workflow (id TEXT PRIMARY KEY, state TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_skill_state ON team_skill(state, at);
      CREATE INDEX IF NOT EXISTS team_workflow_state ON team_workflow(state, at);
    `)
  }
  saveSkill(skill: SkillRecord): void {
    this.store.db.prepare('INSERT INTO team_skill VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, value=excluded.value')
      .run(skill.id, skill.state, JSON.stringify(skill), skill.at)
  }
  skill(id: string): SkillRecord | undefined { return this.row('team_skill', id) as SkillRecord | undefined }
  skills(state?: SkillState): SkillRecord[] { return this.rows('team_skill', state) as SkillRecord[] }
  saveWorkflow(workflow: TeamWorkflow): void {
    this.store.db.prepare('INSERT INTO team_workflow VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, value=excluded.value')
      .run(workflow.id, workflow.state, JSON.stringify(workflow), workflow.at)
  }
  workflow(id: string): TeamWorkflow | undefined { return this.row('team_workflow', id) as TeamWorkflow | undefined }
  workflows(state?: TeamWorkflow['state']): TeamWorkflow[] { return this.rows('team_workflow', state) as TeamWorkflow[] }
  private row(table: string, id: string): unknown {
    const found = this.store.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id)
    return found ? JSON.parse(String(found.value)) : undefined
  }
  private rows(table: string, state?: string): unknown[] {
    const found = state
      ? this.store.db.prepare(`SELECT value FROM ${table} WHERE state=? ORDER BY at`).all(state)
      : this.store.db.prepare(`SELECT value FROM ${table} ORDER BY at`).all()
    return found.map(row => JSON.parse(String(row.value)))
  }
}

/** What the Retrospective needs from the Runtime. */
export interface RetroHost {
  readonly store: Pick<Store, 'db' | 'atomic'>
  readonly skillsRoot: string
  warn(message: string): void
}

/**
 * Turns ended plans into skill drafts and reusable workflows, and writes safe skills into the shared skills library.
 * A draft with a command or an outbound channel waits in `.drafts/` until a person approves it in the panel.
 */
export class Retrospective {
  readonly tables: RetroStore
  /** Two advances of the same plan can end together; only one of them may write the retrospective. */
  private readonly ending = new Set<string>()
  constructor(private readonly host: RetroHost) { this.tables = new RetroStore(host.store) }

  /** Called once when a plan ends. Idempotent: a plan that already produced drafts produces no more. */
  async onPlanEnd(plan: PlanView): Promise<void> {
    if (this.ending.has(plan.id)) return
    if (this.tables.skills().some(skill => skill.planId === plan.id) || this.tables.workflows().some(workflow => workflow.fromPlanId === plan.id)) return
    this.ending.add(plan.id)
    try {
      const drafts = this.skillDrafts(plan)
      for (const draft of drafts) {
        const existing = await this.similar(draft)
        const version = existing ? existing.version + 1 : 1
        const risky = RISKY.test(draft.body)
        const skill: SkillRecord = { ...draft, version, risk: risky ? 'medium' : 'low', state: risky ? 'draft' : 'active',
          name: existing?.name ?? draft.name, file: '' }
        skill.file = await this.writeSkill(skill, existing?.body)
        this.tables.saveSkill(skill)
      }
      this.tables.saveWorkflow(this.workflowDraft(plan))
    } finally { this.ending.delete(plan.id) }
  }

  /** Deterministic drafts from the plan's reports, failures and dependency shape; at most four. */
  private skillDrafts(plan: PlanView): Omit<SkillRecord, 'version' | 'state' | 'risk' | 'file'>[] {
    const at = now()
    const done = plan.steps.filter(step => step.state === 'done' && step.report).slice(0, 2)
    const trouble = plan.steps.find(step => step.state === 'failed' || (step.att ?? 1) > 1)
    const drafts: Omit<SkillRecord, 'version' | 'state' | 'risk' | 'file'>[] = []
    for (const step of done) drafts.push({
      id: `sk-${randomUUID().slice(0, 8)}`, name: `team-${plan.id}-${step.id}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      title: `${step.title} · ${step.botName ?? step.bot}`, description: `${step.title}：${(step.report ?? '').slice(0, 80)}`,
      scope: `bot:${step.botId ?? step.bot}`, origin: `${plan.id} · ${step.id}`, evidence: `step ${step.id} hop ${step.hop}`,
      planId: plan.id, at,
      body: [`# ${step.title}`, '', `## 适用`, `${plan.goal} 中由 ${step.botName ?? step.bot} 承担的「${step.title}」。`,
        '', '## 做法', step.spec, '', '## 结果', step.report ?? '', '', '## 证据', `${plan.id} / ${step.id}，第 ${step.hop} 跳。`,
        '', 'scope: ' + `bot:${step.botId ?? step.bot}`, 'origin: ' + `${plan.id} · ${step.id}`, 'risk: low'].join('\n'),
    })
    if (trouble) drafts.push({
      id: `sk-${randomUUID().slice(0, 8)}`, name: `team-${plan.id}-${trouble.id}-check`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      title: `${trouble.title} · 回归检查`, description: `${trouble.title} 的失败复现与重派经验`,
      scope: `bot:${trouble.botId ?? trouble.bot}`, origin: `${plan.id} · ${trouble.id}`, evidence: `attempt ${trouble.att}`,
      planId: plan.id, at,
      body: [`# ${trouble.title} · 回归检查`, '', '## 反例', trouble.error ?? `第 ${trouble.att} 次尝试才通过`,
        '', '## 检查清单', trouble.spec, '', '## 修复结果', trouble.report ?? '（见轨迹中的重派步骤）',
        '', `origin: ${plan.id} · ${trouble.id}`, 'risk: medium'].join('\n'),
    })
    drafts.push({
      id: `sk-${randomUUID().slice(0, 8)}`, name: `team-${plan.id}-split`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      title: '多角色需求拆解', description: `${plan.goal} 的 ${plan.steps.length} 步依赖与并行拆法`,
      scope: 'supervisor', origin: plan.id, evidence: `${plan.steps.length} steps`, planId: plan.id, at,
      body: ['# 多角色需求拆解', '', '## 计划', plan.goal, '', '## 步骤与依赖',
        ...plan.steps.map(step => `- ${step.id} ${step.title} · ${step.botName ?? step.bot}${step.after.length ? ` · after ${step.after.join(', ')}` : ''} · ${step.state}`),
        '', '## 经验', '只依赖同一前置步骤的步骤可以并行派出；汇合步骤等所有前置步骤完成。',
        '', `origin: ${plan.id}`, 'scope: supervisor', 'risk: low'].join('\n'),
    })
    return drafts
  }

  /** The library skill whose description most overlaps this draft; a close match means a new version, not a new skill. */
  private async similar(draft: { description: string }): Promise<{ name: string; version: number; body: string } | undefined> {
    let found: { name: string; version: number; body: string } | undefined
    for (const prior of this.tables.skills('active')) {
      if (coverage(draft.description, prior.description) >= SIMILARITY) return { name: prior.name, version: prior.version, body: prior.body }
    }
    try {
      const root = this.host.skillsRoot
      const entries = await readdir(root, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const text = await readFile(join(root, entry.name, 'SKILL.md'), 'utf8').catch(() => '')
        const description = /^description:\s*(.+)$/mi.exec(text)?.[1] ?? ''
        if (description && coverage(draft.description, description) >= SIMILARITY) {
          found = { name: entry.name, version: Number(/^version:\s*(\d+)/mi.exec(text)?.[1] ?? 1), body: text }
        }
      }
    } catch { /* A library that is not there yet simply has no prior skill. */ }
    return found
  }

  /** Writes the SKILL.md: active skills into the library, risky ones into `.drafts/`; returns the file path. */
  private async writeSkill(skill: SkillRecord, previous?: string): Promise<string> {
    const dir = skill.state === 'active' ? this.host.skillsRoot : join(this.host.skillsRoot, '.drafts')
    const folder = join(dir, skill.name)
    await mkdir(folder, { recursive: true })
    const earlier = previous ? previous.replace(/^\s*---[\s\S]*?---\s*/, '').trim() : ''
    const body = earlier ? `${earlier}\n\n---\n\n## v${skill.version}（${skill.at}）\n\n${skill.body}` : skill.body
    const content = ['---', `name: ${skill.name}`, `description: ${skill.description.replace(/[\r\n]+/g, ' ')}`,
      `title: ${skill.title.replace(/[\r\n]+/g, ' ')}`, `version: ${skill.version}`, 'activation: manual',
      'category: team-retrospective', '---', '', body].join('\n')
    const file = join(folder, 'SKILL.md')
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, file)
    return file
  }

  /** A person approves a risky draft: it moves from `.drafts/` into the active library. */
  async approveSkill(id: string): Promise<SkillRecord> {
    const skill = this.tables.skill(id)
    if (!skill) throw new TeamError(`No skill draft ${id}`)
    if (skill.state !== 'draft') throw new TeamError(`Skill ${id} is ${skill.state}`)
    const active: SkillRecord = { ...skill, state: 'active', file: '' }
    active.file = await this.writeSkill(active)
    await rm(join(this.host.skillsRoot, '.drafts', skill.name), { recursive: true, force: true }).catch(() => undefined)
    this.tables.saveSkill(active)
    return active
  }
  /** A person rejects a risky draft: its file goes away and no Bot ever reads it. */
  async rejectSkill(id: string): Promise<SkillRecord> {
    const skill = this.tables.skill(id)
    if (!skill) throw new TeamError(`No skill draft ${id}`)
    if (skill.state !== 'draft') throw new TeamError(`Skill ${id} is ${skill.state}`)
    await rm(join(this.host.skillsRoot, '.drafts', skill.name), { recursive: true, force: true }).catch(() => undefined)
    const rejected = { ...skill, state: 'rejected' as const }
    this.tables.saveSkill(rejected)
    return rejected
  }

  /** A saved workflow of this plan: parameters, role slots, step DAG, gates, budget and triggers. */
  private workflowDraft(plan: PlanView): TeamWorkflow {
    const keys = new Set<string>()
    for (const step of plan.steps) for (const match of step.spec.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) keys.add(match[1]!)
    const params: WorkflowParam[] = [...keys].map(key => ({ key, label: key }))
    if (!params.length) params.push({ key: 'goal', label: '目标', value: plan.goal })
    return { id: `wf-${randomUUID().slice(0, 8)}`, name: plan.goal.slice(0, 60), version: 1, fromPlanId: plan.id,
      goal: plan.goal, state: 'draft', params, steps: plan.steps.map((step: TeamStep) => ({ key: step.id, title: step.title,
        spec: step.spec, bot: step.bot, after: step.after })),
      gates: plan.steps.filter(step => /发布|通知|外发|release|notify/i.test(step.title)).map(step => `${step.id}: human`),
      budget: { tokens: 300_000, turns: 90, parallel: 3 }, triggers: ['manual'], runs: 0, ok: 100, at: now() }
  }

  /** A person confirms the draft; only saved workflows are matched against new requests. */
  saveWorkflow(id: string): TeamWorkflow {
    const workflow = this.tables.workflow(id)
    if (!workflow) throw new TeamError(`No workflow ${id}`)
    const saved = { ...workflow, state: 'saved' as const, version: Math.max(1, workflow.version) }
    this.tables.saveWorkflow(saved)
    return saved
  }
  /** Workflows whose names and steps cover the new request, best first. */
  match(request: string): WorkflowMatch[] {
    return this.tables.workflows('saved').map(workflow => ({ id: workflow.id, name: workflow.name, version: workflow.version,
      score: Math.round(coverage(request, `${workflow.name} ${workflow.goal} ${workflow.steps.map(step => step.title).join(' ')}`) * 100) }))
      .filter(hit => hit.score >= WORKFLOW_MATCH_THRESHOLD * 100).sort((a, b) => b.score - a.score)
  }
  /** Records a run. The Team turns the saved steps into a new plan; usage is credited when that plan ends. */
  run(id: string): TeamWorkflow {
    const workflow = this.tables.workflow(id)
    if (!workflow) throw new TeamError(`No workflow ${id}`)
    if (workflow.state !== 'saved') throw new TeamError(`Workflow ${id} is a draft; save it first`)
    const running = { ...workflow, runs: workflow.runs + 1 }
    this.tables.saveWorkflow(running)
    return running
  }
}
