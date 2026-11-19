export interface TapdFilterDomRow { field: string; op: string; values: string[]; range: string[]; enabled: boolean; group?: string }
export const TAPD_FILTER_PAGES: Readonly<Record<'story' | 'bug', string>>
export const TAPD_FILTER_READ_EXPRESSION: string
export function tapdFilterRowsReady(rows: unknown): rows is TapdFilterDomRow[]
export function createTapdFilterReader(clientFactory: (kind: 'story' | 'bug') => {
  navigate(url: string): Promise<unknown>
  evaluateAsync(expression: string, timeoutMs: number): Promise<unknown>
  closeOwnedPage(): Promise<unknown>
}, options?: { timeoutMs?: number }): { read(kind: 'story' | 'bug'): Promise<TapdFilterDomRow[]> }
