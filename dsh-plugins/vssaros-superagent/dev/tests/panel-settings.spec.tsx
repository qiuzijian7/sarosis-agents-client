// @vitest-environment jsdom
// The Settings groups, drafts, save bars and history.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Field, Fields, SourceField } from '../src/client/settings-kit.tsx'
import { p4Kind } from '../src/sources/p4.ts'
import { DEFAULT_RECONCILE_IGNORE } from '../src/sources/p4-change.ts'
import { CardProvider } from '../src/client/provider.tsx'
import { expect, it, onTestFinished } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field, translator } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it('shows P4CLIENT name guidance without changing the input and associates it for screen readers', async () => {
  const spec = p4Kind.fields.find(field => field.key === 'executionClient')!
  expect(spec.hint?.zh).toContain('磁盘路径')
  expect(spec.note?.en).toContain('not a disk path')
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  onTestFinished(async () => { await act(async () => root.unmount()); container.remove() })
  await act(async () => root.render(<Field label={spec.label.zh} hint={spec.hint!.zh} note={spec.note!.zh}>
    <input defaultValue="GR_qiuzijian_main" />
  </Field>))
  const input = container.querySelector('input')!
  expect(input.value).toBe('GR_qiuzijian_main')
  expect(container.querySelector('small')?.textContent).toContain('不是磁盘路径')
  expect(container.querySelector('small')?.id).toBe(input.getAttribute('aria-describedby'))
  expect(container.querySelector('label')?.htmlFor).toBe(input.id)
})

it('shows the built-in reconcile ignore list when the field is unset, and keeps an explicit empty list empty', async () => {
  const spec = p4Kind.fields.find(item => item.key === 'reconcileIgnore')!
  expect(spec.type === 'rows' && spec.defaults).toEqual(DEFAULT_RECONCILE_IGNORE)
  const show = async (value: unknown) => {
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => root.render(<CardProvider t={translator(zh)}>
      <SourceField field={spec} value={value} saved={value} fact={undefined} labels={{}} onChange={() => {}} />
    </CardProvider>))
    // More than six rows are collapsed behind a summary button until a person expands them.
    const expand = container.querySelector('.dt-rows-summary')
    if (expand) await act(async () => { (expand as HTMLElement).click() })
    const result = [...container.querySelectorAll<HTMLElement>('.dt-rows-title')].map(el => el.getAttribute('title') || el.textContent || '')
    await act(async () => root.unmount()); container.remove()
    return result
  }
  expect(await show(undefined)).toEqual(DEFAULT_RECONCILE_IGNORE.map(item => item.path))
  expect(await show([])).toEqual([])
  expect(await show([{ path: 'OnlyMine' }])).toEqual(['OnlyMine'])
})

it('offers opt-in worker PTC and trace with a manual-only metadata query', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(find(zh.workerPtc, '[role="switch"]').getAttribute('aria-checked')).toBe('false')
  expect(find(zh.toolTraceSwitch, '[role="switch"]').getAttribute('aria-checked')).toBe('false')
  expect(server.requests.some(request => request.path.startsWith('tools/trace'))).toBe(false)
  await click(zh.toolTraceRefresh)
  expect(server.requests.filter(request => request.path.startsWith('tools/trace'))).toHaveLength(1)
  expect(text()).toContain(zh.toolTraceOff)
  await click(find(zh.workerPtc, '[role="switch"]'))
  await click(find(zh.toolTraceSwitch, '[role="switch"]'))
  await click(zh.save)
  expect(server.settings.executor).toMatchObject({ workerPtc: true, toolTrace: true })
})
it('edits trusted Git project mappings in Execution settings and preserves their values on save', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(zh.addRow)
  const cell = (name: string) => {
    const label = all('.dt-rows-cell').find(el => el.querySelector('span')?.textContent === name)!
    return label.querySelector<HTMLInputElement | HTMLSelectElement>('input, select')!
  }
  await type(cell(zh.projectMappingId), 'gr')
  await type(cell(zh['term.source']), 'tapd')
  await type(cell(zh.projectMappingKey), '68880148')
  await type(cell(zh.projectMappingRepository), 'F:\\GitProject')
  await type(cell(zh.projectMappingRef), 'main')
  await click(zh.save)
  expect(server.settings.executor.projects).toEqual([{ id: 'gr', source: 'tapd', projectId: '68880148', repository: 'F:\\GitProject', ref: 'main' }])
})
it('says 模型未配置 explicitly when the Executor model is left empty', async () => {
  server.settings = { ...server.settings, executor: { ...server.settings.executor, model: null } }
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await settle()
  const hints = [...document.querySelectorAll('.dt-model .dt-hint')].map(el => el.textContent ?? '')
  expect(hints.join(' ')).toContain('模型未配置')
  expect(hints.join(' ')).toContain('host / default')
})

it('builds model choices from the live catalog and keeps an inherit-default option', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await settle()
  const selects = () => all('.dt-model select') as HTMLSelectElement[]
  const provider = selects()[0]!
  expect([...provider.options].map(option => option.value)).toEqual(['', 'worker-provider'])
  await type(provider, 'worker-provider')
  expect([...selects()[1]!.options].map(option => option.value)).toEqual(['', 'worker-model'])
  expect([...selects()[2]!.options].map(option => option.value)).toEqual(['', 'high'])
  await type(selects()[0]!, '')
  expect([...all('.dt-model .dt-hint')].map(el => el.textContent).join(' ')).toContain('模型未配置')
})

it('keeps a person\'s own value where another save changed the same setting, and says so', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  server.settings = { ...server.settings, executor: { ...server.settings.executor, maxWorkers: 4 } }
  server.revisions.executor = 1
  await click(zh.save)
  expect(document.querySelector('.dt-savebar [role="alert"]')?.textContent).toBe(zh.saveConflict)
  expect(field<HTMLInputElement>(zh.maxWorkers).value).toBe('6')
  await click(zh.save)
  expect(server.settings.executor.maxWorkers).toBe(6)
})

it('saves the Eval block on the Policy settings and the Executor with its execution environment on the Execution settings, each against its own revision', async () => {
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(zh['mode.auto'])
  await type(field<HTMLInputElement>(zh.evalTimeout), '180')
  const [provider, model] = all('.dt-model select')
  await type(provider as HTMLSelectElement, 'worker-provider'); await type(model as HTMLSelectElement, 'worker-model')
  await click(zh.save)
  expect(server.settings.eval).toEqual({ mode: 'auto', timeoutSeconds: 180, model: { provider: 'worker-provider', model: 'worker-model' }, fastExplicitTasks: false })
  await click(find(zh['promptPart.runtime/work'], '.dt-settings-link'))
  await type(field<HTMLInputElement>(zh.maxWorkers), '5')
  // An empty root uses the default directory, which the field names instead of looking set.
  expect(field<HTMLInputElement>(zh.executionDirectory).closest('.dt-field')!.querySelector('small')?.textContent).toBe('留空时用 /srv/dsh-superagent/work')
  await type(field<HTMLInputElement>(zh.executionDirectory), '/srv/work')
  // A variable picked from the list goes where the caret is in the prepare command.
  const prepare = field<HTMLTextAreaElement>(zh.prepareCommand)
  await type(prepare, 'git worktree add ')
  prepare.setSelectionRange(17, 17)
  await click('可用的环境变量 3')
  expect(all('.dt-table tbody tr').map(row => row.textContent)).toEqual(['DSH_SUPERAGENT_DIR工单的执行目录执行器', 'DSH_SUPERAGENT_NAME工单短名执行器',
    'DSH_SUPERAGENT_GITHUB_REPOSITORY仓库GitHub · 已关闭'])
  await click('DSH_SUPERAGENT_DIR')
  expect(field<HTMLTextAreaElement>(zh.prepareCommand).value).toBe('git worktree add "$DSH_SUPERAGENT_DIR"')
  await type(field<HTMLInputElement>(zh.blockedCommands), 'gh-personal  gh.other')
  const [workerProvider, workerModel, effort] = all('.dt-model select')
  await type(workerProvider as HTMLSelectElement, 'worker-provider'); await type(workerModel as HTMLSelectElement,
    'worker-model'); await type(effort as HTMLSelectElement, 'high')
  expect([...(all('.dt-model select')[2] as HTMLSelectElement).options].map(option => option.value)).toEqual(['', 'high'])
  // VsSaros addition (2026-11-07): another plugin's side calls (DS Bot's OCR) are allowed until a person turns them off here.
  const sideCalls = find(zh.sideCalls, '[role="switch"]')
  expect(sideCalls.getAttribute('aria-checked')).toBe('true')
  await click(sideCalls)
  // ★ 2026-11-13：HTML 报告外发默认关闭，人要显式打开。
  expect(find(zh.feishuReport, '[role="switch"]').getAttribute('aria-checked')).toBe('false')
  await click(zh.save)
  expect(server.settings.executor).toEqual({ maxWorkers: 5, directory: '/srv/work', teamEnabled: false, staffing: true, autoApprove: false, sideCalls: false,
    feishuReport: false,
    prepare: 'git worktree add "$DSH_SUPERAGENT_DIR"', projects: [], workerPtc: false, toolTrace: false, blockedCommands: ['gh-personal', 'gh.other'], model: { provider: 'worker-provider',
      model: 'worker-model', reasoningEffort: 'high' } })
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/eval',
    'settings/executor'])
})

it('loads configuration history on demand with localized changes, Source field labels and notified Tickets', async () => {
  server.history = { current: 3, policyVersion: 'abcdef1234567890', items: [{ revision: 3, savedAt: '2026-09-22T00:00:00Z',
    source: 'sync', policyVersion: 'abcdef1234567890', policyChanged: true, notified: [{ id: 't1', title: '修复回归' }], block: 'policy',
    changes: [{ code: 'mode', from: 'off', to: 'observe' }, { code: 'sourceRowsAdded', source: 'feishu', field: 'allowed', items: ['Bob'],
      part: true }, { code: 'sourceField', source: 'feishu', field: 'syncChat', from: '', to: 'oc_team', part: true }] }] }
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(server.requests.some(request => request.path === 'policy/history')).toBe(false)
  await click(zh.configHistory)
  for (const expected of ['第 3 次保存 · 从群同步', '生成策略版本 abcdef12', '接单模式：关闭 → 仅观察', '飞书 · 能发起工作的飞书用户 新增：Bob', '飞书 · 同步来源群：未设置 → oc_team',
    '因策略变更通知了 1 个进行中的工单：修复回归']) expect(text()).toContain(expected)
})

it('shows save and discard only while a settings block has edits, at the end of that block', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(all('.dt-savebar')).toHaveLength(0)
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  expect(all('.dt-savebar')).toHaveLength(1)
  await type(field<HTMLInputElement>(zh.maxWorkers), '3')
  expect(all('.dt-savebar')).toHaveLength(0)
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  await click(zh.discard)
  expect(all('.dt-savebar')).toHaveLength(0)
  // A save submitted from a field keeps the focus there; one from the bar hands it to the block when the bar closes.
  const workers = field<HTMLInputElement>(zh.maxWorkers)
  await type(workers, '5')
  workers.focus()
  await act(async () => { workers.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.executor.maxWorkers).toBe(5)
  expect(document.activeElement).toBe(workers)
  await type(workers, '4')
  const save = find(zh.save)
  save.focus()
  await click(save)
  expect(all('.dt-savebar')).toHaveLength(0)
  expect(document.activeElement).toBe(workers.form)
  await click(find(zh['term.source'], '.dt-settings-link'))
  expect(all('.dt-savebar')).toHaveLength(0)
  const github = all('.dt-card').find(card => card.querySelector('.dt-card-title')?.textContent === 'GitHub')!
  await type(field<HTMLInputElement>('智能体的 GitHub CLI'), 'gh-other')
  expect(github.lastElementChild!.classList.contains('dt-savebar')).toBe(true)
  // The agent CLI is read by setup, so the bar warns that saving restarts dsh-superagent and interrupts running work.
  expect(github.lastElementChild!.textContent).toContain('2 个进行中的派工会中断')
})

it('gives the focus back to the field that had it once a block\'s save ends', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  const render = (disabled: boolean) => act(async () => { root.render(<Fields disabled={disabled}><input aria-label="value" /></Fields>) })
  await render(false)
  const input = container.querySelector('input')!
  input.focus()
  await render(true)
  // jsdom does not blur a control when it becomes disabled; move focus away manually.
  const elsewhere = document.createElement('button'); document.body.append(elsewhere); elsewhere.focus(); elsewhere.remove()
  expect(document.activeElement).toBe(document.body)
  await render(false)
  expect(document.activeElement).toBe(input)
})

it('lists the settings groups stages first, opens each stage\'s group from its status, and returns to the last group opened',
  async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  expect(all('.dt-settings-link').map(link => link.textContent)).toEqual(['来源', '评估', '执行', '提示词', '部署'])
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.source'])
  for (const [tab, group] of [['来源', '来源'], ['评估', '评估'], ['执行', '执行']] as const) {
    await click(find(tab, '[role="tab"]'))
    await click(find(zh['tab.settings'], '.dt-status-head button'))
    expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(group)
  }
  // The Trigger stage has no settings, so its status offers none.
  await click(tab(zh['tab.trigger']))
  expect(all('.dt-status-head button').map(button => button.textContent)).not.toContain(zh['tab.settings'])
  await click(tab(zh['tab.settings']))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['promptPart.runtime/work'])
  await click(tab(zh['tab.trigger']))
  await remount()
  await click(tab(zh['tab.settings']))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['promptPart.runtime/work'])
})
