// VsSaros addition (2026-11-06, P2 · compliance): code adapted from DS Bot (Apache License 2.0) is attributed. A source file
// that names a ds-bot/src/ file it adapts or follows is listed in NOTICE, NOTICE names only files that exist, and the
// package's license declares both licenses.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect, it } from 'vitest'

const DEV = join(import.meta.dirname, '..'), ROOT = join(DEV, '..')
const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8')
const slashed = (path: string) => path.split(sep).join('/')
/** The source files that name a DS Bot file they derive from. */
function derived(): string[] {
  return readdirSync(join(DEV, 'src'), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(tsx?|css)$/.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name))
    .filter(file => /ds-bot\/src\/[\w/.-]+\.js/.test(readFileSync(file, 'utf8')))
    .map(file => slashed(relative(DEV, file)))
    .sort()
}
/** The files the DS Bot section of NOTICE lists. */
function listed(): string[] {
  const section = notice.slice(notice.indexOf('DS Bot (DeepSeek-Bot)'), notice.indexOf('Third-party code bundled into lib/'))
  return [...new Set([...section.matchAll(/\b(src\/[\w/.-]+\.(?:tsx?|css))\b/g)].map(match => match[1]!))].sort()
}

it('lists in NOTICE every source file adapted from DS Bot, and only files that exist', () => {
  const sources = derived()
  expect(sources).toEqual(expect.arrayContaining(['src/app/feed.ts', 'src/client/composer.tsx', 'src/client/flow-card.tsx']))
  expect(sources.filter(file => !listed().includes(file))).toEqual([])
  expect(listed().filter(file => !existsSync(join(DEV, file)))).toEqual([])
})

it('declares both licenses: the package MIT, the DS Bot code Apache-2.0', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { license: string; files: string[] }
  expect(pkg.license).toBe('MIT AND Apache-2.0')
  expect(pkg.files).toEqual(expect.arrayContaining(['NOTICE', 'LICENSE']))
  expect(notice).toMatch(/Apache License, Version 2\.0, Copyright 2026 Fei2411 and the DS Bot contributors/)
})
