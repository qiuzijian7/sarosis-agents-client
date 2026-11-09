// VsSaros addition (2026-11-07): the result a group chat writes back to the ticket it runs.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GROUP_SETTLE_MS, groupTicketReport, groupTicketTitle, type GroupState } from '../src/app/group-tickets.ts'
import { isGroupTicket, ticketExecutor, type Ticket } from '../src/core/model.ts'

const createdAt = '2026-11-07T10:00:00.000Z'
const t0 = Date.parse(createdAt)
const ticket = { createdAt, group: { roomId: 'r', roomName: '番茄钟群' } }
const base: GroupState = { roomId: 'r', roomName: '番茄钟群', idle: true, activeAt: t0 + 100, log: [{ at: t0 + 50, who: 'Coder', text: '做好了' }] }
const now = t0 + 100 + GROUP_SETTLE_MS

describe('groupTicketReport', () => {
  it('reports nothing while the group works, has just stopped, or has not started on the ticket', () => {
    expect(groupTicketReport(ticket, undefined, now)).toBeUndefined()
    expect(groupTicketReport(ticket, { ...base, idle: false }, now)).toBeUndefined()
    expect(groupTicketReport(ticket, base, now - 1)).toBeUndefined()
    expect(groupTicketReport(ticket, { ...base, log: [{ at: t0 - 1, who: 'Coder', text: '上一张的' }] }, now)).toBeUndefined()
    expect(groupTicketReport(ticket, { ...base, log: [{ at: t0 + 1, who: '用户', text: '开工' }] }, now)).toBeUndefined()
  })
  it('is ready with the last two replies since the ticket began, leaving out the person and the questions', () => {
    const log = [{ at: t0 + 1, who: '用户', text: '开工' }, { at: t0 + 2, who: 'Coder', kind: 'ask', text: '问用户：范围' },
      { at: t0 + 3, who: 'Designer', text: '稿子好了' }, { at: t0 + 4, who: 'Tester', text: '测过了' }, { at: t0 + 5, who: 'Coder', text: '交付' }]
    expect(groupTicketReport(ticket, { ...base, log }, now)).toEqual({ state: 'ready',
      summary: '群「番茄钟群」这次的结果（4 条回复）：\n\nTester：测过了\n\nCoder：交付' })
  })
  it('waits while the group asks the person, or its goal is not done; ends with its goal', () => {
    expect(groupTicketReport(ticket, { ...base, asks: [{ name: 'Coder', at: t0 + 60, headline: '范围', questions: 1 }] }, now))
      .toEqual({ state: 'waiting', summary: '群「番茄钟群」等你在群里选择：Coder（范围）' })
    const goal = { title: '像素番茄钟', status: 'active' as const, idle: true, summary: '', updatedAt: t0 + 10 }
    expect(groupTicketReport(ticket, { ...base, goal }, now)?.state).toBe('waiting')
    expect(groupTicketReport(ticket, { ...base, goal: { ...goal, status: 'complete', summary: '三个按钮都通过' } }, now))
      .toEqual({ state: 'ready', summary: '群「番茄钟群」完成了目标「像素番茄钟」：三个按钮都通过' })
    expect(groupTicketReport(ticket, { ...base, goal: { ...goal, status: 'stopped' } }, now)?.state).toBe('dropped')
    // A goal finished before this ticket began is not this ticket's result.
    expect(groupTicketReport(ticket, { ...base, goal: { ...goal, status: 'complete', updatedAt: t0 - 1 } }, now)?.state).toBe('ready')
  })
  it('drops the ticket when its group was deleted', () => {
    expect(groupTicketReport(ticket, { roomId: 'r', missing: true }, now)).toEqual({ state: 'dropped', summary: '群「番茄钟群」已经删除，这张工单没有结果。' })
  })
})

describe('groupTicketTitle', () => {
  it('drops the @group the message starts with, plain or as a DSH reference', () => {
    expect(groupTicketTitle('@番茄钟群 开发像素版', '番茄钟群')).toBe('开发像素版')
    expect(groupTicketTitle('@[番茄钟群](dsh-session:abc) 开发像素版', '番茄钟群')).toBe('开发像素版')
    expect(groupTicketTitle('@番茄钟群', '番茄钟群')).toBe('@番茄钟群')
    expect(groupTicketTitle(`@番茄钟群 ${'很长'.repeat(60)}`, '番茄钟群')).toHaveLength(81)
  })
})

/**
 * 决策 15（2026-11-09）：群执行显式收编。
 * ① 领域模型有正式的 `executor` 字段，所有判别走 `ticketExecutor()`，不再靠 `group` 是否存在；
 * ② 复用已有的 `ticket` / `usage_call` 表，**不新建第二组计划表**。
 * 下面两组都是「反向突变」：把实现改回旧形态时，断言必须变红。
 */
const devRoot = join(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(join(devRoot, rel), 'utf8')

describe('决策 15 · group executor in the domain model', () => {
  it('executor 正式进领域模型，且存量工单（只有 group）零迁移可推导', () => {
    const explicit = { executor: 'group', group: { roomId: 'r', roomName: '群' } } as Pick<Ticket, 'executor' | 'group'>
    const worker = { executor: 'worker' } as Pick<Ticket, 'executor' | 'group'>
    const legacy = { group: { roomId: 'r', roomName: '群' } } as Pick<Ticket, 'executor' | 'group'>
    expect(ticketExecutor(explicit)).toBe('group')
    expect(ticketExecutor(worker)).toBe('worker')
    expect(ticketExecutor(legacy)).toBe('group')
    expect(isGroupTicket(legacy)).toBe(true)
    // 反向：executor 优先于 group 字段（布尔旁路做不到这点）
    expect(isGroupTicket({ executor: 'worker', group: legacy.group } as Pick<Ticket, 'executor' | 'group'>)).toBe(false)
  })
  it('反向突变：去掉 executor 字段/推导函数 ⇒ 判据变红', () => {
    const model = read('src/core/model.ts')
    // 行首判据：注释掉的 `// export type TicketExecutor` 不能算数
    expect(/^export type TicketExecutor/m.test(model)).toBe(true)
    expect(/^export const ticketExecutor\s*=/m.test(model)).toBe(true)
    expect(/ticketExecutor\s*=\s*\(ticket[^)]*\)\s*:\s*TicketExecutor/.test(model)).toBe(true)
    expect(/^export const isGroupTicket\s*=/m.test(model)).toBe(true)
  })
  it('反向突变：把某处分发改回 `ticket.group` 布尔旁路 ⇒ 判据变红', () => {
    for (const rel of ['src/core/tickets.ts', 'src/executor/dsh.ts', 'src/app/views/records.ts', 'src/app/runtime.ts']) {
      const src = read(rel)
      // 任何形式的「拿 group 存在与否当开关」都要被抓住
      expect(/if\s*\(\s*!?ticket\.group\s*\)|!!ticket\.group|!!item\.group|\.filter\(item => item\.group\)/.test(src), rel).toBe(false)
      expect(/ticketExecutor|isGroupTicket/.test(src), rel).toBe(true)
    }
    const tickets = read('src/core/tickets.ts')
    expect(tickets).toContain("executor: outcome.group ? 'group' : 'worker'")
    expect(tickets).toContain("const groupRun = ticketExecutor(ticket) === 'group'")
    expect(read('src/app/runtime.ts')).toContain('.filter(isGroupTicket)')
    expect(read('src/app/views/records.ts')).toContain('isGroupTicket(ticket)')
    expect(read('src/executor/dsh.ts')).toContain('isGroupTicket(ticket)')
  })
})

describe('决策 15 · no second plan table', () => {
  /** 群执行若另起一套计划表，表名会命中这里；hydra 已归档的 team_plan 也在内。 */
  const planTables = (src: string) => [...src.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/gi)]
    .map(m => String(m[1] ?? '')).filter(name => /^(group_(plan|task|step|ticket|member|execution)|team_plan)$/i.test(name))
  it('store / usage 里没有第二组计划表，群结算复用 usage_call', () => {
    expect(planTables(read('src/app/store.ts'))).toEqual([])
    expect(planTables(read('src/app/usage.ts'))).toEqual([])
    expect(read('src/app/usage.ts')).toContain('INSERT INTO usage_call')
    expect(read('src/app/usage.ts')).toMatch(/recordGroupSettlement\(/)
  })
  it('反向突变：真建一张 group_plan 也能被判据抓住（判据不是恒真）', () => {
    expect(planTables('CREATE TABLE IF NOT EXISTS group_plan (id TEXT PRIMARY KEY)')).toEqual(['group_plan'])
    expect(planTables('CREATE TABLE team_plan (id TEXT)')).toEqual(['team_plan'])
  })
  it('群结算走已有 report/结算链，并在账本留一行', () => {
    const runtime = read('src/app/runtime.ts')
    expect(runtime).toContain('this.engine.report(ticket.id, report)')
    expect(runtime).toMatch(/recordGroupSettlement\(ticket\.id, roomId, report\.state\)/)
  })
})
