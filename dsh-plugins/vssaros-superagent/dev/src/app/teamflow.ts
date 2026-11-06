/**
 * VsSaros addition (superagent v2, P5): the TeamFlow adapter. TeamFlow (`dsh-plugin-teamflow`) keeps a workspace's teams in
 * `$DSH_HOME/teamflow/<projectKey>/teams.json`, where `projectKey` is its `slugPath(cwd)`. Its pipeline has seven fixed
 * stages (`PHASE_ORDER`): a team only picks and labels them, and a stage's `role` is display text, not a VsSaros Bot.
 * So a saved team workflow is exported as one team `sa-<workflow id>` whose stages are the steps mapped onto those phases,
 * with what does not map listed as lost; and TeamFlow's teams are imported as workflow seeds whose roles a person still staffs.
 * TeamFlow rewrites the whole file when it saves, so an export reads it, replaces only its own `sa-*` team, keeps a backup
 * and writes it back through a temporary file; a file it cannot read is never overwritten.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TeamWorkflow, WorkflowStep } from './retrospective.ts'

/** TeamFlow's fixed pipeline stages, in order (`host/constants.ts` `PHASE_ORDER`). */
export const TEAMFLOW_PHASES = ['prd', 'design', 'scaffold', 'tech', 'dev', 'qa', 'acceptance'] as const
export type TeamflowPhase = typeof TEAMFLOW_PHASES[number]
/** The prefix of the teams superagent writes; no other team is ever touched. */
export const EXPORT_PREFIX = 'sa-'

export interface TeamflowStage { key: string; label: string; role: string; optional?: boolean; promptKey?: string }
export interface TeamflowTeam {
  id: string; name: string; nameEn?: string; icon: string; description: string; descriptionEn?: string
  stages: TeamflowStage[]; mode?: string; needDesign?: boolean; needScaffold?: boolean
}
/** One export of a workflow into a TeamFlow workspace. */
export interface TeamflowExport {
  adapter: 'teamflow'; projectKey: string; teamId: string; file: string; runnable: boolean; lossy: string[]; at: string
}
export interface TeamflowPlace { cwd: string; dshHome?: string }

/** TeamFlow's built-in team, written alongside the first export into a workspace that has no teams.json yet. */
const BUILTIN_DEV_TEAM: TeamflowTeam = {
  id: 'dev', name: '软件开发', nameEn: 'Software Development', icon: '💻', description: 'PRD→设计→技术→开发→QA→验收',
  descriptionEn: 'PRD → design → tech → dev → QA → acceptance', mode: 'auto',
  stages: [
    { key: 'prd', label: 'PRD 产品需求', role: '产品经理', promptKey: 'prd' },
    { key: 'design', label: 'UI/UX 设计', role: 'UI/UX 设计师', optional: true, promptKey: 'design' },
    { key: 'scaffold', label: '架构规划', role: '架构师', optional: true, promptKey: 'scaffold' },
    { key: 'tech', label: '技术方案', role: '高级全栈工程师', promptKey: 'tech' },
    { key: 'dev', label: '开发', role: '高级全栈工程师', promptKey: 'dev' },
    { key: 'qa', label: 'QA 测试', role: 'QA 测试工程师', promptKey: 'qa' },
    { key: 'acceptance', label: '产品验收', role: '产品经理', promptKey: 'acceptance' },
  ],
}

/** TeamFlow's `slugPath`: the workspace's basename and a sha1 of its path, `ws-<name>-<8 hex>`. */
export function teamflowProjectKey(path: string): string {
  const raw = String(path || '').replace(/\\/g, '/')
  const base = raw.split('/').filter(Boolean).pop() || 'root'
  const tag = base.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'ws'
  return `ws-${tag}-${createHash('sha1').update(raw || 'default').digest('hex').slice(0, 8)}`
}
export const teamflowFile = (place: TeamflowPlace): string =>
  join(place.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh'), 'teamflow', teamflowProjectKey(place.cwd), 'teams.json')

const PHASE_WORDS: [TeamflowPhase, RegExp][] = [
  ['acceptance', /验收|acceptance|sign[- ]?off/i],
  ['qa', /测试|回归|qa\b|test|verify|校验/i],
  ['design', /设计|交互|视觉|原型|ui\b|ux\b|design|mockup/i],
  ['scaffold', /架构|脚手架|骨架|scaffold|architecture/i],
  ['prd', /需求|prd\b|产品|requirement|spec(ification)?\b/i],
  ['tech', /技术方案|方案|tech|technical|调研|research/i],
  ['dev', /开发|实现|修复|编码|改代码|dev\b|implement|fix|code|build/i],
]
/** The TeamFlow phase a step maps to: its own `phase` when it names one, else by the words of its title. */
export function phaseOf(step: Pick<WorkflowStep, 'title'> & { phase?: string }): TeamflowPhase | undefined {
  if (step.phase && (TEAMFLOW_PHASES as readonly string[]).includes(step.phase)) return step.phase as TeamflowPhase
  return PHASE_WORDS.find(([, words]) => words.test(step.title))?.[0]
}

/** The TeamFlow team a workflow becomes, whether TeamFlow can run it as the workflow means, and what is lost. */
export function toTeamflowTeam(workflow: TeamWorkflow): { team: TeamflowTeam; runnable: boolean; lossy: string[] } {
  const lossy: string[] = []
  const mapped = new Map<TeamflowPhase, WorkflowStep>()
  for (const step of workflow.steps) {
    const phase = phaseOf(step)
    if (!phase) { lossy.push(`${step.key} ${step.title}：TeamFlow 没有对应阶段`); continue }
    const taken = mapped.get(phase)
    if (taken) { lossy.push(`${step.key} ${step.title}：与 ${taken.key} 同属「${phase}」阶段，TeamFlow 每个阶段只有一个`); continue }
    mapped.set(phase, step)
  }
  const order = (phase: TeamflowPhase) => TEAMFLOW_PHASES.indexOf(phase)
  const phaseOfKey = new Map([...mapped].map(([phase, step]) => [step.key, phase]))
  for (const [phase, step] of mapped) {
    for (const after of step.after) {
      const before = phaseOfKey.get(after)
      if (before && order(before) > order(phase)) lossy.push(`${step.key} ${step.title}：依赖 ${after}，但 TeamFlow 的阶段顺序会先跑它`)
    }
  }
  if (workflow.params.some(param => param.key !== 'goal')) lossy.push(`参数 ${workflow.params.filter(param => param.key !== 'goal').map(param => param.key).join('、')}：TeamFlow 团队没有参数`)
  if (workflow.gates.length) lossy.push(`闸门 ${workflow.gates.join('、')}：TeamFlow 用它自己的确认档位`)
  const stages = [...mapped].sort(([a], [b]) => order(a) - order(b)).map(([phase, step]) => ({
    key: phase, label: step.title.slice(0, 40), role: botNameOf(workflow, step), promptKey: phase,
    ...phase === 'design' || phase === 'scaffold' ? { optional: true } : {},
  }))
  const team: TeamflowTeam = {
    id: `${EXPORT_PREFIX}${workflow.id}`, name: workflow.name.slice(0, 40) || workflow.id, icon: '🤝',
    description: `superagent 团队工作流 v${workflow.version}：${stages.map(stage => stage.label).join(' → ')}`.slice(0, 200),
    stages, mode: 'auto', ...mapped.has('design') ? { needDesign: true } : {}, ...mapped.has('scaffold') ? { needScaffold: true } : {},
  }
  return { team, runnable: stages.length > 0 && lossy.every(line => line.startsWith('参数') || line.startsWith('闸门')), lossy }
}
const botNameOf = (workflow: TeamWorkflow, step: WorkflowStep) =>
  workflow.roles?.find(role => role.key === step.role)?.bot?.name ?? step.bot ?? step.role ?? ''

/** Reads a workspace's teams; `undefined` when it has none yet. */
function readTeams(file: string): TeamflowTeam[] | undefined {
  if (!existsSync(file)) return undefined
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    throw new Error(`TeamFlow 的 ${file} 读不出来（${(error as Error).message}），不覆盖它`)
  }
  const teams = (raw as { teams?: unknown })?.teams
  if (!Array.isArray(teams)) throw new Error(`TeamFlow 的 ${file} 没有 teams 列表，不覆盖它`)
  return teams as TeamflowTeam[]
}

/** Writes a workflow into a TeamFlow workspace as the team `sa-<id>`; every other team stays as it was. */
export function exportToTeamflow(workflow: TeamWorkflow, place: TeamflowPlace): TeamflowExport {
  if (!place.cwd?.trim()) throw new Error('需要 TeamFlow 工作区的路径（cwd）')
  const file = teamflowFile(place)
  const existing = readTeams(file)
  const { team, runnable, lossy } = toTeamflowTeam(workflow)
  if (!team.stages.length) throw new Error('这个工作流没有一个步骤能对应到 TeamFlow 的阶段，不导出')
  const teams = existing ?? [BUILTIN_DEV_TEAM]
  const at = teams.findIndex(item => item.id === team.id)
  const next = at >= 0 ? teams.map((item, i) => i === at ? team : item) : [...teams, team]
  mkdirSync(dirname(file), { recursive: true })
  if (existing) copyFileSync(file, `${file}.bak`)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ version: 1, teams: next }, null, 2), 'utf8')
  renameSync(temporary, file)
  return { adapter: 'teamflow', projectKey: teamflowProjectKey(place.cwd), teamId: team.id, file, runnable, lossy, at: new Date().toISOString() }
}

/**
 * TeamFlow's teams in a workspace (its built-in team when it has no teams.json yet) as workflow seeds: one step per stage,
 * in order, each with the stage's role as what it needs; the teams superagent exported are left out.
 */
export function importFromTeamflow(place: TeamflowPlace): { projectKey: string; seeds: TeamWorkflow[] } {
  if (!place.cwd?.trim()) throw new Error('需要 TeamFlow 工作区的路径（cwd）')
  const projectKey = teamflowProjectKey(place.cwd)
  const teams = (readTeams(teamflowFile(place)) ?? [BUILTIN_DEV_TEAM]).filter(team => !team.id.startsWith(EXPORT_PREFIX) && team.stages?.length)
  const at = new Date().toISOString()
  const seeds = teams.map((team): TeamWorkflow => {
    const roles = [...new Set(team.stages.map(stage => stage.role || stage.key))]
      .map((role, i) => ({ key: `r${i + 1}`, need: role }))
    const steps = team.stages.map((stage, i) => ({ key: `S${i + 1}`, title: stage.label || stage.key, spec: `${stage.label || stage.key}（TeamFlow 阶段 ${stage.key}）`,
      bot: '', after: i ? [`S${i}`] : [], role: roles.find(role => role.need === (stage.role || stage.key))!.key, access: 'write' as const,
      ...(TEAMFLOW_PHASES as readonly string[]).includes(stage.key) ? { phase: stage.key } : {} }))
    return { id: `wf-tf-${createHash('sha1').update(`${projectKey}/${team.id}`).digest('hex').slice(0, 8)}`, name: team.name || team.id,
      version: 1, fromPlanId: '', source: 'teamflow', goal: team.description || team.name || team.id, state: 'draft',
      params: [{ key: 'goal', label: '目标' }], roles, steps, gates: [], budget: { tokens: 300_000, turns: 90, parallel: 3 },
      triggers: ['manual'], runs: 0, ok: 100, at }
  })
  return { projectKey, seeds }
}
