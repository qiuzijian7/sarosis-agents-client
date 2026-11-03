import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const dir = join(process.cwd(), 'src/client')
const css = readFileSync(join(dir, 'client.css'), 'utf8')
const code = readdirSync(dir).filter(name => /\.tsx?$/.test(name)).map(name => readFileSync(join(dir, name), 'utf8')).join('\n')

it('styles only classes a component uses', () => {
  // Template literals like `dt-btn-${variant}` match any class with that prefix.
  const prefixes = [...code.matchAll(/(dt-[\w-]*-)\$\{/g)].map(match => match[1]!)
  const used = (name: string) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(code) || prefixes.some(prefix => name.startsWith(prefix))
  const classes = new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.(dt-[\w-]+)/g)].map(match => match[1]!))
  expect([...classes].filter(name => !used(name))).toEqual([])
})

it('lets a segmented option wrap instead of clipping a long label', () => {
  // A second `white-space: nowrap` later in the same rule silently overrode `normal` and made the two
  // "How to reach TAPD" options overlap; a duplicate `padding` also swallowed `padding-block`.
  const rules = css.split('\n').filter(line => /^\s*\.dt-segment\s*\{/.test(line))
  expect(rules.length).toBeGreaterThan(1)
  expect(rules.some(line => line.includes('white-space: nowrap'))).toBe(false)
  const main = rules.find(line => line.includes('height: auto')) ?? ''
  expect(main).toContain('white-space: normal')
  expect(main).toContain('overflow-wrap: anywhere')
  expect((main.match(/padding:/g) ?? []).length).toBe(1)
})

it('lays row fields out as labelled cards instead of one cramped line', () => {
  // Eight TAPD watch columns used to be forced into `repeat(var(--dt-columns), minmax(0, 1fr))`,
  // so every input was a few dozen pixels wide and only placeholders hinted at what it was.
  expect(css).toContain('grid-template-columns: repeat(auto-fit, minmax(132px, 1fr))')
  expect(css).not.toContain('repeat(var(--dt-columns)')
  for (const name of ['dt-rows-head', 'dt-rows-title', 'dt-rows-grid', 'dt-rows-cell', 'dt-rows-cell-label']) {
    expect(css).toContain(`.${name}`)
    expect(code).toContain(name)
  }
})

it('writes one rule per line, each selector once within its block', () => {
  const blocks: string[][] = [[]]
  for (const line of css.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(text => text.trim()).filter(Boolean)) {
    if (line === '}') { blocks.pop(); continue }
    if (/^@(media|container|supports)\b.*\{$/.test(line)) { blocks.push([]); continue }
    // A rule, or a keyframes rule with its steps, opens and closes on its line.
    expect(line).toMatch(/^[^{}]+\{[^{}]*\}$|^@keyframes [\w-]+ \{( [^{}]+ \{[^{}]*\})+ \}$/)
    if (line.startsWith('@')) continue
    const selector = line.slice(0, line.indexOf('{')).trim()
    expect(blocks.at(-1)).not.toContain(selector)
    blocks.at(-1)!.push(selector)
  }
})
