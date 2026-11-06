/**
 * VsSaros addition (built-in packaging): what dsh-superagent takes from DSH packages at run time, without importing them
 * at load. A VsSaros built-in plugin has no dependencies of its own and its entry must load where no `@deepseek-ai/*`
 * package resolves (the repository's guards import it bare), so:
 * - `Service` is Cordis's service base, rebuilt here: Cordis keys services by `Symbol.for` symbols and never checks
 *   `instanceof Service`, so an instance of this class is registered and isolated exactly as one of Cordis's own.
 * - The message helpers of `@deepseek-ai/dsh-llm` only brand strings and freeze a copy; they are rebuilt here too.
 * - `scopeParentOf` reads a WeakMap inside `@deepseek-ai/dsh-scope`, so it must be the Host's own instance of that module:
 *   `loadHostModules()` (awaited by `apply`) finds it from the Host's entry script, as `@vssaros/dsh-agents` does.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Message, MessageId as MessageIdType, ReasoningEffortId as ReasoningEffortIdType } from '@deepseek-ai/dsh-llm'

const symbols = { filter: Symbol.for('cordis.filter'), isolate: Symbol.for('cordis.isolate'), extend: Symbol.for('cordis.extend'),
  tracker: Symbol.for('cordis.tracker'), check: Symbol.for('cordis.check') }

/** Cordis's `Service` base (non-callable services): registers itself as `name` in `ctx` for the owning fiber's lifetime. */
export abstract class Service {
  declare ctx: Context
  declare name: string
  constructor(ctx: Context, name: string) {
    this.ctx = ctx
    this.name = name
    Object.defineProperty(this, symbols.tracker, { value: { associate: name, property: 'ctx' }, writable: true, configurable: true })
    ;(ctx as unknown as { reflect: { provide(name: string, value: unknown, check?: unknown): void } })
      .reflect.provide(name, this, (this as unknown as Record<symbol, unknown>)[symbols.check])
  }
  /** Whether an event emitted in `ctx` reaches this service: the same isolation as its own context. */
  [Symbol.for('cordis.filter')](ctx: Context): boolean {
    const isolate = (context: Context) => (context as unknown as Record<symbol, Record<string, unknown> | undefined>)[symbols.isolate]
    return isolate(ctx)?.[this.name] === isolate(this.ctx)?.[this.name]
  }
  [Symbol.for('cordis.extend')](props: object): this {
    return Object.assign(Object.create(this) as this, props)
  }
}

/** `@deepseek-ai/dsh-llm`'s `MessageId`: the same string, branded. */
export const MessageId = (id: string): MessageIdType => id as MessageIdType
/** `@deepseek-ai/dsh-llm`'s `ReasoningEffortId`: the same string, branded. */
export const ReasoningEffortId = (id: string): ReasoningEffortIdType => id as ReasoningEffortIdType
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key])
  }
  return value
}
/** `@deepseek-ai/dsh-llm`'s `freezeMessage`: an immutable copy that keeps the message's identity. */
export const freezeMessage = <T extends Message>(message: T): T => deepFreeze(structuredClone(message))

type ScopeModule = { scopeParentOf(key: object): object | undefined }
let scope: ScopeModule | undefined
let scopeTried = false
/** Imports one package as the Host loaded it: resolved from the Host's entry script first, then from here. */
async function hostImport<T>(name: string): Promise<T | undefined> {
  for (const anchor of [process.argv[1], import.meta.url]) {
    if (!anchor) continue
    try {
      const resolved = createRequire(anchor).resolve(name)
      return await import(pathToFileURL(resolved).href) as T
    } catch { /* the next anchor */ }
  }
  try { return await import(name) as T } catch { return undefined }
}
/** Loads the Host modules dsh-superagent reads synchronously later; never throws. @returns what could not be loaded. */
export async function loadHostModules(): Promise<string[]> {
  if (!scopeTried) {
    scopeTried = true
    const module = await hostImport<ScopeModule>('@deepseek-ai/dsh-scope')
    if (typeof module?.scopeParentOf === 'function') scope = module
  }
  return scope ? [] : ['@deepseek-ai/dsh-scope']
}
/** `@deepseek-ai/dsh-scope`'s `scopeParentOf`; none when the Host's module could not be loaded. */
export const scopeParentOf = (key: object): object | undefined => scope?.scopeParentOf(key)
