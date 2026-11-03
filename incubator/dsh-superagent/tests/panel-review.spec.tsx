// @vitest-environment jsdom
// VsSaros addition: the review of a ticket's shelved changelist, from the Overview and the ticket's page.
import { act } from 'react'
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, all, find, click, type, text, field, at } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const FILES = [
  { depotFile: '//GR/main/Source/Editor/Preview.cpp', rev: '12', type: 'text', lines: ['@@ -10,3 +10,4 @@', ' int scale = 1;', '-float dpi = 1.0f;', '+float dpi = GetDpi();'] },
  { depotFile: '//GR/main/Content/Icons/preview.uasset', rev: '3', type: 'binary+F', lines: [] },
]
function waiting(mode: 'pipeline' | 'host' = 'pipeline') {
  server.reviews.t1 = { submit: { mode, tags: '#review #ShelveForSubmit' }, diffs: FILES,
    review: { ticketId: 't1', change: 501, fingerprint: '0123456789abcdef', client: 'superagent-fix-dpi', state: 'waiting', requestedAt: '2026-11-03T03:00:00.000Z',
      description: '--bug=5001 修复 4K 下预览错位\n', files: FILES.map(file => ({ depotFile: file.depotFile, action: 'edit', rev: file.rev, type: file.type, digest: 'AB' })) } }
}
const approveButton = () => find(zh['review.approve']) as HTMLButtonElement
const ack = () => field<HTMLInputElement>(zh['review.ack'])
async function check(box: HTMLInputElement) { await act(async () => { box.click() }) }

it('lists a waiting review first on the Overview, and opens the ticket at its review', async () => {
  waiting()
  await mount()
  const titles = all('.dt-section-title .dt-section-name').map(title => title.textContent)
  expect(titles[0]).toBe(zh['review.pending'])
  expect(text()).toContain('--bug=5001 修复 4K 下预览错位')
  expect(text()).toContain('CL 501 · 2 个文件')
  await click(zh['review.open'])
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
  expect(all('.dt-section-name').map(title => title.textContent)).toContain('提交审核 · CL 501')
})

it('approves only after every file was opened and the reviewer confirmed, sending the fingerprint read', async () => {
  waiting()
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(approveButton().disabled).toBe(true)
  expect(ack().disabled).toBe(true)
  await click(find('//GR/main/Source/Editor/Preview.cpp#12 (text)', '[data-disclosure-row]'))
  expect(document.querySelector('.dt-diff-add')?.textContent).toBe('+float dpi = GetDpi();\n')
  expect(document.querySelector('.dt-diff-del')?.textContent).toBe('-float dpi = 1.0f;\n')
  expect(ack().disabled).toBe(true)
  await click(find('//GR/main/Content/Icons/preview.uasset#3 (binary+F)', '[data-disclosure-row]'))
  expect(text()).toContain(zh['review.binary'])
  expect(text()).toContain('已看 2 / 2')
  expect(ack().disabled).toBe(false)
  expect(approveButton().disabled).toBe(true)
  await check(ack())
  expect(approveButton().disabled).toBe(false)
  await click(approveButton())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('CL 描述会加上 #review #ShelveForSubmit')
  expect(server.requests.some(request => request.path.endsWith('/review/approve'))).toBe(false)
  await click(find(zh.confirm, '[role="dialog"] button'))
  expect(server.requests.find(request => request.path === 'tickets/t1/review/approve')).toMatchObject({ method: 'POST', body: { fingerprint: '0123456789abcdef' } })
  expect(text()).toContain('已同意，已交给提交流水线 · qiuzijian')
  expect(document.querySelector('.dt-review-files')).toBeNull()
})

it('shows the files that changed when an approval is refused, and keeps the review open', async () => {
  waiting('host')
  server.reviewChanged = ['//GR/main/Source/Editor/Preview.cpp']
  at({ page: 'execution', id: 't1' })
  await mount()
  for (const row of all('.dt-review-files [data-disclosure-row]')) await click(row)
  await check(ack())
  await click(approveButton())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(zh['review.approveHost'])
  await click(find(zh.confirm, '[role="dialog"] button'))
  expect(text()).toContain(zh['review.changed'])
  expect(all('.dt-banner.dt-danger li').map(item => item.textContent)).toEqual(['//GR/main/Source/Editor/Preview.cpp'])
  expect(server.reviews.t1!.review.state).toBe('waiting')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('sends a CL back with a comment, which it cannot do with none', async () => {
  waiting()
  at({ page: 'execution', id: 't1' })
  await mount()
  await click(zh['review.reject'])
  const send = all('[role="dialog"] button').find(button => button.textContent === zh['review.reject']) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  await type(field<HTMLTextAreaElement>('打回 CL 501'), '测试用例补一个 1x 缩放')
  await click(send)
  expect(server.requests.find(request => request.path === 'tickets/t1/review/reject')).toMatchObject({ body: { comment: '测试用例补一个 1x 缩放' } })
  expect(text()).toContain('已打回 · qiuzijian：测试用例补一个 1x 缩放')
})

it('discards a CL after confirmation', async () => {
  waiting()
  at({ page: 'execution', id: 't1' })
  await mount()
  await click(zh['review.discard'])
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(zh['review.discardConfirm'])
  await click(find(zh.confirm, '[role="dialog"] button'))
  expect(server.requests.some(request => request.path === 'tickets/t1/review/discard' && request.method === 'POST')).toBe(true)
  expect(text()).toContain('已放弃 · qiuzijian')
})

it('shows no review section for a ticket without a changelist, and words it in English', async () => {
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(all('.dt-section-name').map(title => title.textContent)).not.toContain('提交审核 · CL 501')
  waiting()
  await mount(en)
  expect(text()).toContain('Review · CL 501')
  expect(find(en['review.approve'])).toBeDefined()
})
