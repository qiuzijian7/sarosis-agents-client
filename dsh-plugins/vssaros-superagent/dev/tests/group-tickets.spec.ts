// VsSaros addition (2026-11-07): the result a group chat writes back to the ticket it runs.
import { describe, expect, it } from 'vitest'
import { GROUP_SETTLE_MS, groupTicketReport, groupTicketTitle, type GroupState } from '../src/app/group-tickets.ts'

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
