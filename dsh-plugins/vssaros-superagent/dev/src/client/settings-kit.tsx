/** Shared settings context, block draft hook, form controls, Source schema field renderer, and configuration history. */
import { cloneElement, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement,
  type ReactNode } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { FieldSpec, Localized } from '../sources/kind.ts'
import { usePoll, type HistoryView, type Settings, type SettingsView, type SourceView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input, SegmentedControl, Switch } from './controls.tsx'
import { useDraft } from './draft.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { errorText, localized, valueLabel, when, type T } from './text.ts'
import { Hint, LoadState } from './widgets.tsx'

/** Parse a numeric input string, returning `null` when empty so the server rejects blank required numbers instead of coercing to 0. */
export const numberOf = (text: string): number | null => text.trim() ? Number(text) : null
/** ★ 2026-11-11: sentinel for a `chooseFrom` dropdown's "add new" option. Never written into the Source config. */
export const ADD_NEW_VALUE = '__new__'
interface SettingsData { settings: SettingsView; reload: () => Promise<void> }
const SettingsContext = createContext<SettingsData | undefined>(undefined)
export function useSettings(): SettingsData {
  const value = useContext(SettingsContext)
  if (!value) throw new Error('A settings block rendered outside the settings')
  return value
}
export function SettingsProvider({ children }: { children: ReactNode }) {
  const { call } = usePanel()
  const { restarts } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET settings'), [call, restarts])
  if (!data) return <LoadState error={error} loading />
  return <SettingsContext.Provider value={{ settings: data, reload }}>
    {error && <LoadState error={error} loading={false} />}
    {children}
  </SettingsContext.Provider>
}
export function useBlockDraft<V>(block: string, saved: V, revision: number, toValue: (draft: V) => unknown = draft => draft) {
  const { t, call, notify } = usePanel()
  const { state } = usePanelData()
  const { reload } = useSettings()
  return useDraft({ key: `dsh-superagent/draft/${state?.masterId ?? ''}/${block}`, saved, revision, reload, save: async (value, from) => {
    const result = await call('PUT settings/:block', { block, body: { value: toValue(value), revision: from } })
    notify(t(result.restarting ? 'savedRestarting' : 'saved'))
    return result
  } })
}

/** Fieldset wrapper that restores focus to the previously active input after a save completes and re-enables the form. */
export function Fields({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  const set = useRef<HTMLFieldSetElement>(null)
  const focused = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const active = document.activeElement
    if (disabled) focused.current = active instanceof HTMLElement && set.current?.contains(active) ? active : null
    else if (focused.current && (!active
      || active === document.body)) { focused.current.focus({ preventScroll: true }); focused.current = null }
  }, [disabled])
  return <fieldset ref={set} className="dt-fieldset" disabled={disabled}>{children}</fieldset>
}
export function Field({ label, hint, note, action,
  children }: { label: string; hint?: string | undefined; note?: ReactNode; action?: ReactNode; children: ReactElement<{ id?: string; 'aria-describedby'?: string }> }) {
  const id = useId()
  const control = cloneElement(children, { id, ...(note ? { 'aria-describedby': [children.props['aria-describedby'], `${id}-note`].filter(Boolean).join(' ') } : {}) })
  return <div className="dt-field">
    <span className="dt-field-head"><label htmlFor={id}>{label}</label>{hint && <InfoTip text={hint} />}</span>
    {action ? <div className="dt-cli-row">{control}{action}</div> : control}
    {note && <small id={`${id}-note`}>{note}</small>}
  </div>
}
export function SwitchRow({ label, hint, checked,
  onChange }: { label: string; hint?: string | undefined; checked: boolean; onChange: (next: boolean) => void }) {
  return <div className="dt-switch-row">
    <div className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</div><Switch checked={checked} onChange={onChange}
      label={label} />
  </div>
}
type RoleModel = Settings['eval']['model']
/**
 * ★ 2026-11-13：与 dsh 聊天框的模型选择器用同一份数据源与同一套选择逻辑。
 * 聊天框（`dsh-client-ui-model-selection` 的 `ModelSelect`）从 `sessionController.modelCatalog()`
 * 取 `groups / default / failures / routableProviders`，按 provider → model → effort 逐级挑选；
 * 本设置页的 `GET models` 返回的就是同一份 `ModelCatalog`（`app/http.ts`、`app/api.ts`）。
 * 官方组件挂在 composer 的 slot 上、写入会话与全局 DSH 默认，不能跨构建边界复用，
 * 因此这里只复刻「目录驱动、可继承默认、不写死任何 provider/model」的部分：
 * 值全部来自 `catalog`，空项写回 `null`（= 继承 DSH 默认），绝不调用 selectModel/saveSelection。
 */
export function ModelField({ id, value, onChange }: { id: string; value: RoleModel; onChange: (next: RoleModel) => void }) {
  const { t, call } = usePanel()
  const [catalog, setCatalog] = useState<ApiResponse<'GET models'>>()
  const [error, setError] = useState<string>()
  useEffect(() => { call('GET models').then(setCatalog, failure => setError(errorText(failure))) }, [call])
  const current = { provider: value?.provider ?? '', model: value?.model ?? '', effort: value?.reasoningEffort ?? '' }
  const set = (next: Partial<typeof current>) => {
    const { provider, model, effort } = { ...current, ...next }
    // A role model needs BOTH a provider and a model; a partial pair would fail RoleModelSchema.
    onChange(provider.trim() && model.trim() ? { provider, model, ...effort.trim() ? { reasoningEffort: effort } : {} } : null)
  }
  const groups = catalog?.groups ?? []
  const models = groups.find(group => group.id === current.provider.trim())?.models ?? []
  const efforts = models.find(model => model.id === current.model.trim())?.reasoning?.efforts ?? []
  const fallback = catalog?.default
  // ★ 2026-11-13：留空不是「已配置」，把继承状态说清楚；默认 route 明确不可用时再给一条告警。
  const inherit = !current.provider.trim() && !current.model.trim()
  const unusable = !!catalog && (catalog.failures?.some(f => f.id === catalog.default.provider) ||
    (Array.isArray(catalog.routableProviders) && catalog.routableProviders.length > 0 &&
      !catalog.routableProviders.includes(catalog.default.provider)))
  /** Options come from the live catalog; a stored value outside it is kept so a save cannot silently erase it. */
  const options = (values: readonly { id: string; name: string }[], selected: string, empty: string) => <>
    <option value="">{empty}</option>
    {selected && !values.some(entry => entry.id === selected) ? <option value={selected}>{selected}</option> : null}
    {values.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
  </>
  const pick = (name: keyof typeof current, label: string, empty: string,
    values: readonly { id: string; name: string }[], choose: (next: string) => void) => <Field label={label}>
    <select className="dt-select" value={current[name]} onChange={event => choose(event.target.value)}>
      {options(values, current[name], empty)}
    </select>
  </Field>
  /** Catalog unavailable (GET failed): fall back to manual text entry rather than locking the field. */
  const input = (name: keyof typeof current, label: string, placeholder: string) => <Field label={label}>
    <Input spellCheck={false} placeholder={placeholder} value={current[name]}
      onChange={event => set({ [name]: event.target.value })} />
  </Field>
  const chooseProvider = (next: string) => set({ provider: next, model: groups.find(group => group.id === next)?.models[0]?.id ?? '', effort: '' })
  const chooseModel = (next: string) => set({ model: next, effort: '' })
  return <div className="dt-model">
    {inherit ? <Hint>{t('modelNotConfigured', { model: fallback ? `${fallback.provider} / ${fallback.model}` : '—' })}</Hint>
      : <Hint>{fallback ? t('defaultModel', { model: `${fallback.provider} / ${fallback.model}${fallback.reasoningEffort ? ` · ${fallback.reasoningEffort}` : ''}` }) : t('defaultModelUnavailable')}</Hint>}
    {unusable && <p className="dt-error" role="alert">{t('defaultModelUnusable')}</p>}
    {error && <p className="dt-error">{t('modelCatalogError', { error })}</p>}
    <div className="dt-grid3">
      {groups.length
        ? <>{pick('provider', t('modelProvider'), t('modelInherit'), groups, chooseProvider)}
          {pick('model', t('modelName'), t('modelInherit'), models, chooseModel)}
          {pick('effort', t('modelEffort'), t('modelEffortDefault'), efforts, next => set({ effort: next }))}</>
        : <>{input('provider', t('modelProvider'), t('modelInherit'))}{input('model', t('modelName'), t('modelInherit'))}{input('effort',
          t('modelEffort'), t('modelEffortDefault'))}</>}
    </div>
  </div>
}

type HistoryChange = NonNullable<HistoryView['items'][number]['changes']>[number]
function changeText(t: T, change: HistoryChange, sources: SourceView[]): string {
  const source = sources.find(item => item.id === change.source)
  const field = (change.part ? source?.policy?.fields : source?.fields)?.find(item => item.key === change.field)
  const shown = (value: unknown) => value === undefined || value === null || value === '' ? t('unsetValue') : typeof value === 'boolean'
    ? t(value ? 'yes' : 'no')
    : change.code === 'mode' ? valueLabel(t, 'mode', String(value)) : String(value)
  return t(`change.${change.code}`,
    { items: (change.items ?? []).map(item => source?.labels[item] ?? item).join(t('listSeparator')),
    from: shown(change.from), to: shown(change.to), name: change.name ?? '', source: source ? localized(t, source.title)
      : change.source ?? '',
    field: field ? localized(t, field.label) : change.field ?? '' })
}
/**
 * Collapsible revision history for the specified settings blocks, optionally including all Policy-changing saves.
 * Revisions saved before per-block tracking existed have no `block` and appear under `policy`.
 */
/** `except` leaves a block out, for a kind whose settings the panel shows outside the group its block name suggests. */
export function ConfigHistory({ blocks, versions, focus, except = [] }: { blocks: string[]; versions?: boolean; focus?: string
  except?: readonly string[] }) {
  const { t, call } = usePanel()
  const { settings } = useSettings()
  const { sources } = settings
  const [open, setOpen] = useState(!!focus)
  const [data, setData] = useState<HistoryView>()
  const [error, setError] = useState<string>()
  const revisions = JSON.stringify([Object.values(settings.blocks).map(block => block.revision), sources.map(source => source.revision)])
  useEffect(() => { if (open) call('GET policy/history').then(setData, failure => setError(errorText(failure))) }, [open, call, revisions])
  const listed = (block: string | undefined) => block ? blocks.some(item => item === block || (item.endsWith(':')
    && block.startsWith(item))) : blocks.includes('policy')
  const items = data?.items.filter(item => ((versions && item.policyChanged) || listed(item.block))
    && !(item.block && except.includes(item.block))) ?? []
  // Match the oldest save that produced the focused Policy version (where that version originated).
  const target = focus ? items.filter(item => item.policyChanged && item.policyVersion.startsWith(focus)).at(-1) : undefined
  const scroll = (element: HTMLLIElement | null) => { if (element
    && !element.dataset.scrolled) { element.dataset.scrolled = '1'; element.scrollIntoView?.({ block: 'center' }) } }
  return <DisclosureRow icon={<Icon name="history" />} title={t('configHistory')} open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      {error && <p className="dt-error">{error}</p>}
      {data && <>
        <Hint>{t('historyIntro')}</Hint>
        {focus && !target && <Hint>{t('policyVersionUnrecorded', { version: focus.slice(0, 8) })}</Hint>}
        {items.length ? <ul className="dt-timeline">{items.map(item => <li key={item.revision} className={item === target
          ? 'dt-event dt-highlight' : 'dt-event'}
          ref={item === target ? scroll : undefined}>
          <div className="dt-row-title">{t('historyItem', { revision: item.revision, source: valueLabel(t, 'historySource',
            item.source) })}</div>
          <div className="dt-event-foot">{when(item.savedAt, t('lang'))}{item.policyChanged && <> · {t('historyPolicyChanged',
            { version: item.policyVersion.slice(0, 8) })}</>}</div>
          {item.changes === null ? <Hint>{t('historyNoBaseline')}</Hint> : item.changes.length
            ? <ul className="dt-changes">{item.changes.map((change, index) => <li key={index}>{changeText(t, change, sources)}</li>)}</ul>
              : <Hint>{t('historyNoChanges')}</Hint>}
          {item.notified.length > 0 && <Hint>{t('historyNotified', { count: item.notified.length,
            titles: item.notified.map(ticket => ticket.title).join(t('listSeparator')) })}</Hint>}
        </li>)}</ul> : <Hint>{t('historyEmpty')}</Hint>}
      </>}
    </div>
  </DisclosureRow>
}

type Row = Record<string, string>
type Column = Extract<FieldSpec, { type: 'rows' }>['columns'][number]
const ROWS_SHOWN = 6
const byName = ([, a]: [string, string], [, b]: [string, string]) => a.localeCompare(b)
function RowsField({ field, value, saved, onChange, labels, refreshLabels }: {
  field: Extract<FieldSpec, { type: 'rows' }>; value: unknown; saved: unknown; onChange: (next: unknown) => void; labels: Record<string,
    string>
  refreshLabels: (() => Promise<string[]>) | undefined
}) {
  const { t, notify } = usePanel()
  const [open, setOpen] = useState(false)
  const refresh = useAction(async () => {
    try {
      const added = await refreshLabels!()
      notify(added.length ? t('labelsAdded', { names: added.join(t('listSeparator')) }) : t('labelsCurrent'))
    } catch (failure) { notify(t('labelsFailed', { error: errorText(failure) })) }
  })
  const label = localized(t, field.label), hint = localized(t, field.hint)
  // An unset rows field shows its declared defaults (the schema's runtime defaults); an explicit [] stays empty.
  const rows = Array.isArray(value) ? value as Row[] : (field.defaults ?? []) as Row[]
  const set = (index: number, row: Row) => onChange(rows.map((item, position) => position === index ? row : item))
  const key = field.columns[0]!
  const savedKeys = new Set((Array.isArray(saved) ? saved as Row[] : []).map(row => row[key.key]))
  const choose = key.type === 'text' && key.choose && Object.keys(labels).length ? localized(t, key.choose) : ''
  // Exclude options already selected in another row.
  const choices = (id: string) => Object.entries(labels).filter(([option]) => option === id
    || !rows.some(other => other[key.key] === option)).sort(byName)
  const blank = Object.fromEntries(field.columns.map(column => [column.key, column.type === 'select' ? column.options[0]!.value : '']))
  // Summarize a row by its second column only when that column is free text (e.g., a display name), not a select option.
  const named = field.columns[1]?.type === 'text' ? field.columns[1] : undefined
  const rowName = (row: Row) => (named && row[named.key]) || labels[row[key.key] ?? ''] || row[key.key] || ''
  const cell = (row: Row, index: number, column: Column) => {
    const id = row[key.key] ?? '', change = (next: string) => set(index, { ...row, [column.key]: next })
    if (column === key && (savedKeys.has(id) || (!choose && labels[id]))) {
      return <span key={column.key} className={labels[id] ? 'dt-row-label' : 'dt-row-label dt-mono'} title={id}>{labels[id] ?? id}</span>
    }
    if (column === key && choose) {
      return <select key={column.key} className="dt-select" aria-label={choose} required value={id}
        onChange={event => change(event.target.value)}>
        <option value="" disabled>{choose}</option>
        {choices(id).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
      </select>
    }
    // A namespaced label slice turns any text column into a TAPD-backed dropdown (not just the first column).
    if (column.type === 'text' && column.chooseFrom) {
      const prefix = column.chooseFrom + ':'
      const current = String(row[column.key] ?? '')
      return <select key={column.key} className="dt-select" aria-label={localized(t, column.label)} value={current}
        onChange={event => change(event.target.value)}>
        <option value="">{localized(t, column.label)}</option>
        {current && !labels[prefix + current] ? <option value={current}>{current}</option> : null}
        {Object.entries(labels).filter(([option]) => option.startsWith(prefix)).sort(byName)
          .map(([option, name]) => <option key={option} value={option.slice(prefix.length)}>{name}</option>)}
      </select>
    }
    if (column.type === 'select') {
      return <select key={column.key} className="dt-select" aria-label={localized(t, column.label)} value={row[column.key] ?? ''}
        onChange={event => change(event.target.value)}>
        {column.options.map(option => <option key={option.value} value={option.value}>{localized(t, option.label)}</option>)}
      </select>
    }
    return <Input key={column.key} className={column.optional ? undefined : 'dt-mono'} aria-label={localized(t, column.label)}
      placeholder={localized(t, column.label)}
      required={!column.optional} pattern={column.pattern} spellCheck={false} value={row[column.key] ?? ''}
        onChange={event => change(event.target.value)} />
  }
  return <div className="dt-field">
    <div className="dt-subhead">
      <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}<span className="dt-count">{rows.length || ''}</span></span>
      <span className="dt-subhead-actions">
        {key.type === 'text' && key.refresh && refreshLabels && <Button variant="ghost" size="sm" className={refresh.busy ? 'dt-btn-busy'
          : undefined} icon={<Icon name="refresh" />}
          disabled={refresh.busy} aria-busy={refresh.busy} onClick={() => { void refresh.run() }}>{localized(t, key.refresh)}</Button>}
        <Button variant="ghost" size="sm" icon={<Icon name="plus" />} onClick={() => { setOpen(true); onChange([...rows,
          blank]) }}>{t('addRow')}</Button>
      </span>
    </div>
    {rows.length > ROWS_SHOWN && <button type="button" className="dt-textlink dt-rows-summary" aria-expanded={open}
      onClick={() => setOpen(!open)}>
      {open ? t('collapse') : rows.map(rowName).join(t('listSeparator'))}
    </button>}
    {(rows.length <= ROWS_SHOWN || open) && <ul className="dt-rows">{rows.map((row, index) => <li key={index} className="dt-rows-item">
      <div className="dt-rows-head">
        <span className="dt-rows-title" title={rowName(row) || `#${index + 1}`}>{rowName(row) || `#${index + 1}`}</span>
        <Button variant="ghost" size="sm" icon={<Icon name="trash" />} aria-label={t('removeRow', { name: labels[row[key.key] ?? '']
          || row[key.key] || label })}
          onClick={() => onChange(rows.filter((_, position) => position !== index))} />
      </div>
      <div className="dt-rows-grid">
        {field.columns.map(column => <label key={column.key} className="dt-rows-cell">
          <span className="dt-rows-cell-label">{localized(t, column.label)}</span>
          {cell(row, index, column)}
        </label>)}
      </div>
    </li>)}</ul>}
  </div>
}
export function SourceField({ field, value, saved, fact, onChange, labels, refreshLabels, action, detail,
  onAddNew, addNewOpen }: {
  field: FieldSpec; value: unknown; saved: unknown; fact: Localized | string | undefined; onChange: (next: unknown) => void
  labels: Record<string, string>
  refreshLabels?: () => Promise<string[]>
  /** VsSaros addition: controls rendered to the right of a text input, and a result area below the field. */
  action?: ReactNode
  detail?: ReactNode
  /** ★ 2026-11-11: the card opens an "add new app" form instead of storing the sentinel value. */
  onAddNew?: () => void
  addNewOpen?: boolean
}) {
  const { t, navigate } = usePanel()
  const label = localized(t, field.label), hint = localized(t, field.hint)
  switch (field.type) {
    case 'switch': return <SwitchRow label={label} hint={hint} checked={value === true} onChange={onChange} />
    case 'select': return <Field label={label} hint={hint}>
      <SegmentedControl className="dt-segmented dt-field-segmented" label={label} value={String(value ?? field.options[0]!.value)}
        options={field.options.map(option => ({ value: option.value, label: localized(t, option.label) }))} onChange={onChange} />
    </Field>
    case 'number': return <Field label={label} hint={hint}>
      <Input type="number" min={field.min} max={field.max} required value={String(value ?? '')}
        onChange={event => onChange(event.target.value === '' ? '' : Number(event.target.value))} />
    </Field>
    case 'text': {
      // ★ 2026-11-11：字段可声明 noEmptyOption（不要空占位项）。
      //   飞书 App ID 用它去掉「未配置 / 请先配置」占位项，只列真实应用与末尾的「+ 添加新应用」；
      //   TAPD 等其它 chooseFrom 字段不声明 ⇒ 行为完全不变。
      /* ★ 2026-11-11: while the "add new app" form is open the select stays on that option,
         but the sentinel never reaches the draft config. */
      const selected = addNewOpen ? ADD_NEW_VALUE : (String(value ?? '') || String(field.defaultValue ?? ''))
      return <>
        <Field label={label} hint={hint} note={localized(t, field.note) || localized(t, fact)} action={action}>
          {field.chooseFrom
            ? <select className="dt-select" value={selected}
              onChange={event => event.target.value === ADD_NEW_VALUE ? onAddNew?.() : onChange(event.target.value)}>
              {!field.noEmptyOption && <option value="">{field.choose ? localized(t, field.choose) : localized(t, field.label)}</option>}
              {selected && selected !== ADD_NEW_VALUE && !labels[`${field.chooseFrom}:${selected}`]
                ? <option value={selected}>{selected}</option> : null}
              {Object.entries(labels).filter(([option]) => option.startsWith(field.chooseFrom + ':')).sort(byName)
                .map(([option, name]) => <option key={option} value={option.slice(field.chooseFrom!.length + 1)}>{name}</option>)}
              {field.addNew && onAddNew ? <option value={ADD_NEW_VALUE}>{localized(t, field.addNew)}</option> : null}
            </select>
            : field.choose && Object.keys(labels).length
              ? <select className="dt-select" value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
                <option value="">{localized(t, field.choose)}</option>
                {value && !labels[String(value)] ? <option value={String(value)}>{String(value)}</option> : null}
                {Object.entries(labels).sort(byName).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
              </select>
              : <Input value={String(value ?? '')} readOnly={field.readonly} pattern={field.pattern} spellCheck={false}
                onChange={event => onChange(event.target.value)} />}
        </Field>
        {detail}
      </>
    }
    case 'fact': return <div className="dt-field">
      <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</span>
      <span className="dt-mono">{localized(t, fact) || t('empty')}</span>
      {field.settings && <small>
        <button type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute(field.settings!))}>{t(`openSettingsOf.${field.settings}`)}</button>
      </small>}
    </div>
    case 'rows': return <RowsField field={field} value={value} saved={saved} onChange={onChange} labels={labels}
      refreshLabels={refreshLabels} />
  }
}
