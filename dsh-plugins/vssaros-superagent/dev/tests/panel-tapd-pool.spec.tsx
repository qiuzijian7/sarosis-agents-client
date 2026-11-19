// @vitest-environment jsdom
import { act } from 'react'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { applyOwnerOverride, conditionRange, fallbackConditions, PoolItemSchema, TapdFilterPoolSchema, TapdFilterSchemeSchema } from '../src/sources/tapd-filter-schemes.ts'
import { usePanel, mount, remount, click, tab, settle, type, all } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const schemes = process.env.TAPD_LIVE_SCHEMES
  ? (JSON.parse(readFileSync(process.env.TAPD_LIVE_SCHEMES, 'utf8')) as unknown[]).map(row => TapdFilterSchemeSchema.parse(row))
  : (['story', 'bug'] as const).map(kind => TapdFilterSchemeSchema.parse({ name: `filter-${kind}-1`, kind,
  url: `https://example.test/${kind}`, source: 'live', capturedAt: '2026-11-17T01:00:00Z', hash: '12345678',
  conditions: applyOwnerOverride(fallbackConditions(kind), 'qiuzijian').map(condition => condition.field === '预计完成时间'
    ? { ...condition, value: { from: '2024-01-09 00:00:00', to: '2026-09-30 23:59:59' } } : condition) }))
const candidates = Array.from({ length: 6 }, (_, index) => PoolItemSchema.parse({ id: `${1001 + index}`, kind: index < 4 ? 'bug' : 'story',
  title: ['HUD 血条刷新延迟', '技能图标冷却溢出', '大厅按钮重复响应', '背包排序错位', '结算动效优化', '引导文案调整'][index],
  priority: index % 2 ? '中' : '高', status: '新建', scheme: index < 4 ? 'filter-bug-1' : 'filter-story-1', hit: '当前处理人 · 发布计划' }))

it('renders scheme A, preserves draft enables on sync, filters and links rows, and sends draft conditions to preview', async () => {
  server.tapdCard = true
  const original = globalThis.fetch
  const requests: { path: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    if (path.endsWith('/filter-schemes/sync')) { requests.push({ path, body }); return new Response(JSON.stringify({ schemes,
      pool: TapdFilterPoolSchema.parse({ owner: 'qiuzijian', items: candidates }), results: [
        { kind: 'story', total: 2, recent: 1, added: 2 }, { kind: 'bug', total: 4, recent: 1, added: 4 }],
      identity: { loginName: 'qiuzijian', signedIn: true } })) }
    if (path.endsWith('/filter-schemes/preview')) { requests.push({ path, body }); return new Response(JSON.stringify({ total: 6, recent: 2, items: candidates })) }
    if (path.endsWith('/filter-schemes/run')) {
      requests.push({ path, body }); const pool = TapdFilterPoolSchema.parse(body.pool)
      return new Response(JSON.stringify({ pool: { ...pool, items: pool.items.map(item => item.enabled ? { ...item, state: 'queued' } : item) },
        planned: 1, dispatched: 1, runId: 'test-run', day: '2026-11-17', dispatchQueued: true }))
    }
    return original(url, init)
  }))
  await mount(); await click(tab(zh['tab.settings']))
  const panel = document.querySelector<HTMLElement>('[data-tapd-schemes]')!
  const button = (text: string) => [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!
  expect(panel.querySelector('.dt-row-main')).toBeNull()
  expect(panel.querySelectorAll('.dt-tapd-source')).toHaveLength(2)
  expect(panel.querySelectorAll('.dt-tapd-kpi')).toHaveLength(4)
  expect(button('开始执行').disabled).toBe(true)
  expect(panel.querySelector<HTMLInputElement>('input[type="time"]')!.value).toBe('02:00')
  await click(button('立即同步全部'))
  expect(panel.querySelectorAll('.dt-tapd-conditions tbody tr')).toHaveLength(schemes.find(row => row.kind === 'bug')!.conditions.length)
  expect([...panel.querySelectorAll('.dt-tapd-source')].every(source => source.textContent?.includes('已同步'))).toBe(true)
  expect(panel.querySelector('.dt-tapd-error')).toBeNull()
  expect(panel.querySelector<HTMLButtonElement>('.dt-tapd-conditions tr[data-locked] button')!.disabled).toBe(true)
  expect(panel.querySelectorAll('.dt-tapd-pool-table tbody tr')).toHaveLength(6)
  expect(panel.querySelectorAll('.dt-tapd-pool-table [aria-checked="true"]')).toHaveLength(0)
  expect(panel.querySelector('.dt-tapd-kpi strong')?.textContent).toBe('6')
  expect(requests.some(request => request.path.endsWith('/preview'))).toBe(false)
  expect(requests.find(request => request.path.endsWith('/sync'))?.body.pool).toMatchObject({ items: [] })
  await click(button('试算并加入'))
  expect(requests.find(request => request.path.endsWith('/preview'))?.body.scheme).toMatchObject({ kind: 'bug' })
  expect(panel.querySelectorAll('.dt-tapd-pool-table tbody tr')).toHaveLength(6)
  const link = panel.querySelector<HTMLAnchorElement>('.dt-tapd-title-cell a')!
  expect(link.href).toContain('bugtrace/bugs/view/1001'); expect(link.target).toBe('_blank')
  await click(panel.querySelector<HTMLButtonElement>('.dt-tapd-pool-table [role="switch"]')!)
  expect(button('开始执行').disabled).toBe(false)
  await click(button('立即同步全部'))
  expect(panel.querySelector('.dt-tapd-pool-table [role="switch"]')!.getAttribute('aria-checked')).toBe('true')
  await click(panel.querySelector<HTMLElement>('.dt-tapd-filters button[role="tab"]:nth-child(2)')!)
  expect(panel.querySelectorAll('.dt-tapd-pool-table tbody tr')).toHaveLength(2)
  await click(button('全部启用'))
  await click(panel.querySelector<HTMLElement>('.dt-tapd-filters button[role="tab"]:first-child')!)
  expect(panel.querySelectorAll('.dt-tapd-pool-table [aria-checked="true"]')).toHaveLength(3)
  const search = panel.querySelector<HTMLInputElement>('.dt-tapd-search input')!
  await type(search, 'HUD')
  expect(panel.querySelectorAll('.dt-tapd-pool-table tbody tr')).toHaveLength(1)
  await type(search, '')
  await click(button('开始执行'))
  expect(requests.find(request => request.path.endsWith('/run'))?.body.pool).toMatchObject({ autoProcess: false })
  expect(panel.querySelectorAll('.dt-tapd-pool-table tbody tr').length).toBe(6)
  expect(panel.textContent).not.toContain('今日已修复 3')
  await click(panel.querySelector<HTMLElement>('.dt-tapd-scheme-tabs button[role="tab"]:first-child')!)
  expect(panel.querySelectorAll('.dt-tapd-conditions tbody tr')).toHaveLength(5)
  const dueFrom = panel.querySelector<HTMLInputElement>('input[aria-label="预计完成时间 from"]')!
  const dueTo = panel.querySelector<HTMLInputElement>('input[aria-label="预计完成时间 to"]')!
  expect(dueFrom.value).toBe('2024-01-09T00:00')
  expect(dueTo.value.replace(/\.000$/, '')).toBe('2026-09-30T23:59:59')
  expect(dueTo.step).toBe('1')
  expect(panel.querySelector('.dt-tapd-range-summary')?.textContent).toContain('2026-09-30 23:59:59')
  await type(dueTo, '2026-10-01T08:15:37')
  await click(button('试算并加入'))
  expect(requests.filter(request => request.path.endsWith('/preview')).at(-1)?.body.scheme)
    .toMatchObject({ conditions: expect.arrayContaining([expect.objectContaining({ field: '预计完成时间',
      value: { from: conditionRange(schemes.find(row => row.kind === 'story')!.conditions.find(row => row.field === '预计完成时间')!.value).from,
        to: '2026-10-01T08:15:37' } })]) })
  await type(dueTo, '2026-09-30T23:59:59')
  await act(async () => {
    const input = panel.querySelector<HTMLInputElement>('input[type="time"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }); await settle()
  expect(panel.querySelector('[role="alert"]')!.textContent).toContain('有效执行时间')
  await type(panel.querySelector<HTMLInputElement>('input[type="time"]')!, '02:00')
  if (process.env.TAPD_UI_CAPTURE) {
    const file = process.env.TAPD_UI_CAPTURE
    const css = readFileSync('src/client/client.css', 'utf8')
    const storyHtml = panel.outerHTML
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TAPD 实际 React 组件 · 测试渲染</title><style>:root{--dsw-alias-label-primary:#1f2329;--dsw-alias-label-secondary:#3d4450;--dsw-alias-label-tertiary:#717784;--dsw-alias-label-caption:#8a909b;--dsw-alias-bg-layer-1:#f5f6f8;--dsw-alias-bg-layer-2:#fff;--dsw-alias-border-l3:#e3e6eb;--dsw-alias-border-l4:#d5d9e0;--dsw-alias-brand-primary:#2563eb;--dsw-alias-link:#2563eb;--dsw-alias-label-primary-foreground:#fff;}*{box-sizing:border-box}body{margin:0;padding:20px;background:#f5f6f8;font:13px/1.55 'Segoe UI','Microsoft YaHei',sans-serif}.preview{max-width:1120px;margin:auto;background:#fff;border:1px solid #e3e6eb;border-radius:16px;padding:18px}${css}</style><body><main class="preview">${panel.outerHTML}</main></body></html>`)
    await click(panel.querySelector<HTMLElement>('.dt-tapd-scheme-tabs button[role="tab"]:last-child')!)
    const bugPage = file.replace(/\.html$/, '-bug.html')
    writeFileSync(bugPage, readFileSync(file, 'utf8').replace(storyHtml, panel.outerHTML))
  }
  expect(all('.dt-tapd-error')).toHaveLength(0)
})

it('shows automatic identity matching or asks for one validated confirmation and reuses it after reopening', async () => {
  server.tapdCard = true
  const original = globalThis.fetch
  let confirmed = false, loginName = 'alice'
  const confirmations: unknown[] = []
  const identity = () => ({ signedIn: true, loginName, staffId: '123', workspace: '68880148',
    status: confirmed ? 'resolved' : 'unmatched', tapdName: confirmed ? 'TAPD甲' : '',
    source: confirmed ? 'confirmed' : 'none', cached: confirmed, message: confirmed ? '后续在当前项目自动复用' : '无法唯一匹配，请确认一次 TAPD 用户名' })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/tapd/identity')) return new Response(JSON.stringify(identity()))
    if (path.endsWith('/tapd/identity/confirm')) {
      const body = JSON.parse(String(init?.body)); confirmations.push(body)
      if (body.name !== '甲') return new Response(JSON.stringify({ error: '该名称不在当前项目成员目录中' }), { status: 400 })
      confirmed = true
      return new Response(JSON.stringify(identity()))
    }
    return original(url, init)
  }))
  await mount(); await click(tab(zh['tab.settings']))
  const panel = () => document.querySelector<HTMLElement>('[data-tapd-identity]')!
  const button = (text: string) => [...panel().querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === text)!
  expect(panel().textContent).toContain('alice'); expect(panel().textContent).toContain('待确认')
  expect(button('确认并记住').disabled).toBe(true)
  if (process.env.TAPD_UI_CAPTURE) {
    const file = process.env.TAPD_UI_CAPTURE
    const preview = new DOMParser().parseFromString(readFileSync(file, 'utf8'), 'text/html')
    preview.querySelector('[data-tapd-identity]')!.outerHTML = panel().outerHTML
    writeFileSync(file.replace(/\.html$/, '-unmatched.html'), '<!doctype html>' + preview.documentElement.outerHTML)
  }
  await type(panel().querySelector<HTMLInputElement>('input')!, '不存在')
  await click(button('确认并记住'))
  expect(panel().querySelector('[role="alert"]')?.textContent).toContain('不在当前项目')
  expect(panel().querySelector<HTMLInputElement>('input')!.value).toBe('不存在')
  await type(panel().querySelector<HTMLInputElement>('input')!, '甲')
  await click(button('确认并记住'))
  expect(confirmations.at(-1)).toEqual({ loginName: 'alice', workspace: '68880148', name: '甲' })
  expect(panel().textContent).toContain('TAPD甲'); expect(panel().textContent).toContain('已确认 · 自动复用')
  expect(panel().querySelector('input')).toBeNull()
  expect(server.requests.some(request => request.path.endsWith('/filter-schemes/run'))).toBe(false)
  await remount()
  expect(panel().textContent).toContain('TAPD甲'); expect(panel().querySelector('input')).toBeNull()
  loginName = 'bob'; confirmed = false
  await click(button('重新读取身份'))
  expect(panel().textContent).toContain('bob'); expect(panel().textContent).not.toContain('TAPD甲')
  expect(panel().querySelector<HTMLInputElement>('input')?.value).toBe('')
})

it('shows the real intake failure and lets enabled timed-out items be retried rather than labeling it human approval', async () => {
  server.tapdCard = true
  const original = globalThis.fetch
  const item = PoolItemSchema.parse({ id: '1001', kind: 'bug', title: '候选单据', state: 'failed', phase: 'evaluation',
    detail: '评估不可用：超时；可重新执行以重评原任务', retryable: true })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/filter-schemes/pool')) return new Response(JSON.stringify({ items: [item] }))
    if (path.endsWith('/filter-schemes/sync')) return new Response(JSON.stringify({ schemes, pool: TapdFilterPoolSchema.parse({ owner: 'qiuzijian', items: [item] }), identity: { loginName: 'qiuzijian', signedIn: true } }))
    return original(url, init)
  }))
  await mount(); await click(tab(zh['tab.settings']))
  const panel = document.querySelector<HTMLElement>('[data-tapd-schemes]')!
  const button = (text: string) => [...panel.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === text)!
  await click(button('立即同步全部'))
  expect(panel.querySelector('.dt-tapd-pool-table')?.textContent).toContain('评估不可用：超时')
  expect(panel.querySelector('.dt-tapd-pool-table')?.textContent).not.toContain('等待人工处理')
  await click(panel.querySelector<HTMLButtonElement>('.dt-tapd-pool-table [role="switch"]')!)
  expect(button('开始执行').disabled).toBe(false)
})
