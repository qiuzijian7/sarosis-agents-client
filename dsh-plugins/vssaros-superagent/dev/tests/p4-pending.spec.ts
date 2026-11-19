import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_RECONCILE_IGNORE, P4ConfigSchema } from '../src/sources/p4-change.ts'
import { consolidatePending, finalizePending, ignoredDepotFile, pendingName, withPendingName,
  type P4Records } from '../src/executor/p4-pending.ts'

const config = (overrides: Record<string, unknown> = {}) => P4ConfigSchema.parse({
  cli: 'p4', port: 'ssl:p4.test:1666', user: 'bot', paths: [{ path: '//GR/main/UE5EA/Engine/...' }],
  submit: 'pending', reconcileIgnore: [], ...overrides,
})

describe('pending CL ignore rules', () => {
  it('matches directory names, file suffixes and full depot patterns', () => {
    const ignores = [{ path: 'Binaries' }, { path: '__pycache__' }, { path: '*.pyc' }, { path: '//GR/main/Game/Saved/...' }]
    expect(ignoredDepotFile('//GR/main/UE5EA/Engine/Binaries/DotNET/X.dll', ignores)).toBe(true)
    expect(ignoredDepotFile('//GR/main/UE5EA/Engine/Source/__pycache__/a.pyc', ignores)).toBe(true)
    expect(ignoredDepotFile('//GR/main/UE5EA/Engine/Source/a.pyc', ignores)).toBe(true)
    expect(ignoredDepotFile('F:/ws/UE5EA/Engine/Intermediate/x.obj', [{ path: 'Intermediate' }])).toBe(true)
    expect(ignoredDepotFile('//GR/main/Game/Saved/Config/x.ini', ignores)).toBe(true)
    expect(ignoredDepotFile('//GR/main/UE5EA/Engine/Source/Runtime/A.cpp', ignores)).toBe(false)
  })

  it('ships a default ignore list shared with the settings panel', () => {
    const defaults = P4ConfigSchema.parse({}).reconcileIgnore
    expect(defaults).toEqual(DEFAULT_RECONCILE_IGNORE)
    expect(defaults.some(item => item.path === 'Binaries')).toBe(true)
    expect(P4ConfigSchema.parse({}).reconcileFallback).toBe(false)
  })
})

describe('consolidating one pending CL without a tree walk', () => {
  const opened = () => [
    { depotFile: '//GR/main/UE5EA/Engine/Source/A.cpp', change: 'default' },
    { depotFile: '//GR/main/UE5EA/Engine/Source/B.h', change: '501' },
    { depotFile: '//GR/main/UE5EA/Engine/Binaries/DotNET/X.dll', change: 'default' },
    { clientFile: 'F:/ws/UE5EA/Engine/Source/New.h', change: 'default' },
  ]

  it('by default only reads opened and reopens files, never reconciles, dirs or wildcards', async () => {
    const calls: string[][] = []
    const records = vi.fn(async (args: string[]) => {
      calls.push(args)
      return args[0] === 'opened' ? opened() : []
    }) as unknown as P4Records
    const result = await consolidatePending(config({ reconcileIgnore: [{ path: 'Binaries' }] }), 501, records)
    expect(vi.mocked(records).mock.calls.map(([args]) => args[0])).toEqual(['opened', 'reopen'])
    expect(result.reopened).toEqual(['//GR/main/UE5EA/Engine/Source/A.cpp', 'F:/ws/UE5EA/Engine/Source/New.h'])
    expect(result.reconciled).toEqual([])
    expect(result.ignored).toBe(1)
    expect(result.files).toBe(3)
    expect(calls.some(args => args[0] === 'reconcile' || args[0] === 'dirs')).toBe(false)
    expect(calls.every(args => !args.some(arg => arg.includes('...') || arg === '*'))).toBe(true)
    expect(calls.find(args => args[0] === 'reopen')?.join(' ')).not.toMatch(/Binaries/)
  })

  it('pool delivery leaves the previous and default changelists untouched, even with reconcile fallback', async () => {
    const records = vi.fn(async (args: string[]) => args[0] === 'opened' ? [
      { depotFile: '//GR/main/UE5EA/Engine/Source/Previous.cpp', change: '1298138' },
      { depotFile: '//GR/main/UE5EA/Engine/Source/Current.cpp', change: '501' },
      { depotFile: '//GR/main/UE5EA/Engine/Source/Unrelated.h', change: 'default' },
    ] : [])
    const result = await consolidatePending(config({ reconcileFallback: true }), 501, records, true)
    expect(result.files).toBe(1); expect(result.reopened).toEqual([])
    expect(records.mock.calls.some(([args]) => args.includes('reopen') || args.join(' ').includes('Previous') || args.join(' ').includes('Unrelated'))).toBe(false)
    expect(records.mock.calls.find(([args]) => args[0] === 'reconcile')?.[0].slice(6)).toEqual(['//GR/main/UE5EA/Engine/Source/Current.cpp'])
  })
  it('fallback reconciles only explicit opened files in batches, never a wildcard', async () => {
    const calls: string[][] = []
    const many = Array.from({ length: 205 }, (_, i) => ({ depotFile: `//GR/main/UE5EA/Engine/Source/F${i}.cpp`, change: 'default' }))
    const records = vi.fn(async (args: string[]) => {
      calls.push(args)
      return args[0] === 'opened' ? many : []
    }) as unknown as P4Records
    const result = await consolidatePending(config({ reconcileFallback: true }), 501, records)
    const reconciles = calls.filter(args => args[0] === 'reconcile')
    expect(reconciles).toHaveLength(3)
    expect(reconciles.every(args => args.includes('-c') && args.includes('501'))).toBe(true)
    expect(reconciles.every(args => args.every(arg => !arg.includes('...') && arg !== '*'))).toBe(true)
    expect(reconciles.flatMap(args => args.slice(6))).toHaveLength(205)
    expect(result.reconciled).toHaveLength(205)
    expect(calls.some(args => args[0] === 'dirs')).toBe(false)
    expect(calls.some(args => args.includes('-n'))).toBe(false)
  })

  it('fallback skips ignored and out-of-scope opened files', async () => {
    const calls: string[][] = []
    const records = vi.fn(async (args: string[]) => {
      calls.push(args)
      return args[0] === 'opened' ? [
        { depotFile: '//GR/main/UE5EA/Engine/Source/A.cpp', change: '501' },
        { depotFile: '//GR/main/UE5EA/Engine/Binaries/DotNET/X.dll', change: '501' },
        { depotFile: '//GR/main/Other/Outside.cpp', change: '501' },
      ] : []
    }) as unknown as P4Records
    await consolidatePending(config({ reconcileFallback: true, reconcileIgnore: DEFAULT_RECONCILE_IGNORE }), 501, records)
    const reconciles = calls.filter(args => args[0] === 'reconcile')
    expect(reconciles).toHaveLength(1)
    expect(reconciles[0]!.slice(6)).toEqual(['//GR/main/UE5EA/Engine/Source/A.cpp'])
    expect(calls.every(args => args.join(' ').indexOf('Binaries') < 0)).toBe(true)
  })

  it('names the CL, keeps the ticket marker and re-shelves without submitting', async () => {
    const forms: string[][] = []
    const records = vi.fn(async (args: string[]) => args[0] === 'opened' ? opened() : []) as unknown as P4Records
    const form = vi.fn(async (args: string[], input?: string) => {
      forms.push([...args, ...input ? [input] : []])
      return 'Change:\t501\n\nClient:\tmain\n\nDescription:\n\told text\n'
    })
    const result = await finalizePending(config({ pendingName: 'Fix {title}' }), 501, 't1', 'Crash in Set.h', { records, form })
    expect(result.name).toBe('Fix Crash in Set.h [dsh-superagent:t1]')
    expect(forms[0]).toEqual(['change', '-o', '501'])
    expect(forms[1]?.[2]).toContain('Fix Crash in Set.h [dsh-superagent:t1]')
    expect(vi.mocked(records).mock.calls.map(([args]) => args[0])).toContain('shelve')
    expect(vi.mocked(records).mock.calls.every(([args]) => args[0] !== 'submit')).toBe(true)
  })

  it('always keeps the marker even if the operator template omits it', () => {
    expect(pendingName(config({ pendingName: 'plain name' }), 't9', 'T')).toBe('plain name [dsh-superagent:t9]')
    expect(withPendingName('Change:\t1\n\nDescription:\n\told\n\nFiles:\n', 'new')).toContain('\tnew\n')
  })
})
