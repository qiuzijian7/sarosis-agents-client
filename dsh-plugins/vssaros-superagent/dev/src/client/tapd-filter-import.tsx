/**
 * Imports the Saroasis platform's bug-filter JSON into the TAPD Source draft. The Host compiles the
 * Chinese display conditions into TAPD query fields; this component shows every condition's fate and
 * lets a person enable, tune, preview or remove the resulting daily sweeps. Nothing is saved until
 * the Source card's own Save button is pressed.
 */
import { useState } from 'react'
import type { TapdFilterSchedule } from '../sources/tapd-filters.ts'
import type { TapdWatch } from '../sources/tapd-api.ts'
import { Button, DisclosureRow, Icon, Input, Switch, Tag, type TagTone } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import { Hint } from './widgets.tsx'

interface Report { field: string; op: string; enabled: boolean; target: 'api' | 'local' | 'skipped' | 'manual'; detail: string }
interface ImportResult { schedule: TapdFilterSchedule; watch: TapdWatch; report: Report[]; warnings: string[]; maps: 'live' | 'fallback' }
const TARGET: Record<Report['target'], { zh: string; en: string; tone: TagTone }> = {
  api: { zh: '下推 API', en: 'TAPD query', tone: 'success' },
  local: { zh: '本地过滤', en: 'Local filter', tone: 'info' },
  skipped: { zh: '已禁用', en: 'Disabled', tone: 'quiet' },
  manual: { zh: '未生效', en: 'Not applied', tone: 'warning' },
}

export interface TapdFilterImportProps {
  /** The draft config's schedules and watches. */
  schedules: TapdFilterSchedule[]
  watches: TapdWatch[]
  /** Writes the whole draft config back; the person still has to save the card. */
  onChange: (next: { schedules: TapdFilterSchedule[]; watches: TapdWatch[] }) => void
}

export function TapdFilterImport({ schedules, watches, onChange }: TapdFilterImportProps) {
  const { t, call, notify } = usePanel()
  const lang = t('lang') === 'en' ? 'en' : 'zh'
  const say = (zh: string, en: string) => lang === 'en' ? en : zh
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<ImportResult>()
  const [preview, setPreview] = useState<{ total: number; recent: number }>()
  const importRun = useAction(async () => {
    if (!text.trim()) return
    const existing = schedules.map(item => item.name)
    let index = 1, name = ''
    do { name = `filter-bug-${index++}` } while (existing.includes(name) || watches.some(w => w.name === name))
    const response = await call('POST sources/tapd/filters/import', { body: { text, name } }) as unknown as ImportResult
    setResult(response); setPreview(undefined)
    return response
  })
  const previewRun = useAction(async () => {
    if (!result) return
    const response = await call('POST sources/tapd/filters/preview', { body: { query: result.schedule.query,
      windowDays: result.schedule.windowDays } })
    setPreview(response)
    return response
  })
  const apply = () => {
    if (!result) return
    if (schedules.some(item => item.name === result.schedule.name) || watches.some(w => w.name === result.watch.name)) {
      notify(say('同名接收项已存在，请先删除', 'A watch with this name already exists; remove it first')); return
    }
    onChange({ schedules: [...schedules, result.schedule], watches: [...watches, result.watch] })
    notify(say('已生成接收项；默认关闭定时，确认后请保存', 'Watch added; the daily sweep is off by default. Save the card when ready.'))
    setResult(undefined); setText(''); setPreview(undefined)
  }
  const patch = (name: string, change: Partial<TapdFilterSchedule>) =>
    onChange({ schedules: schedules.map(item => item.name === name ? { ...item, ...change } : item), watches })
  const remove = (name: string) => {
    onChange({ schedules: schedules.filter(item => item.name !== name), watches: watches.filter(item => item.name !== name) })
    if (result?.schedule.name === name) setResult(undefined)
  }
  return <DisclosureRow icon={<Icon name="filter" />} title={say('从 JSON 导入 TAPD 筛选条件', 'Import a TAPD filter from JSON')}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Field label={say('粘贴平台导出的筛选条件 JSON', 'Paste the platform filter JSON')}
        hint={say('从「萨罗斯管理平台 · 缺陷」页面导出的 conditions/state。导入只修改本卡片草稿，保存后才生效。',
          'The conditions/state export of the platform bug page. Import only edits this card draft; save to apply.')}>
        <textarea className="dt-textarea dt-mono" rows={5} spellCheck={false} value={text}
          placeholder='{"source":"TAPD筛选条件","conditions":[...],"state":{...}}'
          onChange={event => setText(event.target.value)} />
      </Field>
      <div className="dt-row-buttons">
        <Button variant="outline" size="sm" icon={<Icon name="copy" />} disabled={!text.trim() || importRun.busy}
          aria-busy={importRun.busy} onClick={() => { void importRun.run().catch(error => notify(String(error))) }}>
          {say('解析并预览映射', 'Parse and preview mapping')}
        </Button>
        {result && <Button variant="ghost" size="sm" icon={<Icon name="search" />} disabled={previewRun.busy}
          onClick={() => { void previewRun.run().catch(error => notify(String(error))) }}>
          {say('试算命中数', 'Preview match count')}
        </Button>}
      </div>
      {result && <>
        <p className="dt-hint">
          {say(`字段映射：${result.maps === 'live' ? '来自本项目 TAPD 实时配置' : '内置映射（TAPD 暂不可达）'}`,
            `Field map: ${result.maps === 'live' ? 'live workspace configuration' : 'built-in fallback (TAPD unreachable)'}`)}
        </p>
        <ul className="dt-rows">{result.report.map((row, index) => <li key={index} className="dt-rows-item">
          <div className="dt-rows-head"><span className="dt-rows-title">{row.field} · {row.op}</span>
            <Tag tone={TARGET[row.target].tone}>{TARGET[row.target][lang]}</Tag></div>
          <p className="dt-hint">{row.detail}</p>
        </li>)}</ul>
        {result.warnings.length > 0 && <div role="status" className="dt-error">
          {result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        </div>}
        {preview && <p className="dt-hint">
          {say(`当前查询命中 ${preview.total} 条；其中最近 ${result.schedule.windowDays} 天有变动 ${preview.recent} 条。单次上限 ${result.schedule.maxPerRun}。`,
            `${preview.total} bugs match in total; ${preview.recent} changed within ${result.schedule.windowDays} days. Per-run cap: ${result.schedule.maxPerRun}.`)}
        </p>}
        <div className="dt-row-buttons">
          <Button variant="primary" size="sm" icon={<Icon name="plus" />} onClick={apply}>
            {say('新增一个 bug 接收项', 'Add one bug watch')}
          </Button>
        </div>
      </>}
      {schedules.length > 0 && <div className="dt-part">
        <p className="dt-subhead">{say('已导入的每日筛选', 'Imported daily sweeps')}</p>
        {schedules.map(schedule => <div key={schedule.name} className="dt-card dt-filter-schedule">
          <div className="dt-row-main">
            <span className="dt-field-head">{schedule.name}</span>
            <Switch checked={schedule.enabled} label={say('每天自动执行', 'Run daily')}
              onChange={enabled => patch(schedule.name, { enabled })} />
          </div>
          <p className="dt-hint">{schedule.page} · {schedule.exportedAt} · {say('上次扫描', 'Last sweep')}: {schedule.report.length} {say('条条件', 'conditions')}</p>
          <Fields disabled={false}>
            <Field label={say('执行时间（本机 HH:MM）', 'Local time (HH:MM)')}>
              <Input value={schedule.at} pattern="[0-2][0-9]:[0-5][0-9]" spellCheck={false}
                onChange={event => patch(schedule.name, { at: event.target.value })} />
            </Field>
            <Field label={say('单次最多接单', 'Max tickets per run')}>
              <Input type="number" min={1} max={200} value={String(schedule.maxPerRun)}
                onChange={event => patch(schedule.name, { maxPerRun: Number(event.target.value) || 1 })} />
            </Field>
            <Field label={say('只看最近 N 天有变动的单子', 'Only items changed within N days')}>
              <Input type="number" min={1} max={30} value={String(schedule.windowDays)}
                onChange={event => patch(schedule.name, { windowDays: Number(event.target.value) || 1 })} />
            </Field>
          </Fields>
          <div className="dt-row-buttons">
            <Button variant="ghost" size="sm" icon={<Icon name="trash" />} onClick={() => remove(schedule.name)}>
              {say('删除', 'Remove')}
            </Button>
          </div>
        </div>)}
        <Hint>{say('启用后，每天到点把符合筛选且此前未派发的缺陷自动交给 SuperAgent。默认关闭；请先试算命中数并确认单次上限。',
          'Once enabled, each day the sweep hands newly matching bugs to SuperAgent. Off by default; preview the match count and confirm the cap first.')}</Hint>
      </div>}
    </div>
  </DisclosureRow>
}
