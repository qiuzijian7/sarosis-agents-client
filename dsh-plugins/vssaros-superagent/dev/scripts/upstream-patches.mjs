#!/usr/bin/env node
// VsSaros addition: the patch set of the VsSaros built-in @vssaros/dsh-superagent against its upstream,
// dsh-superagent-prototype, so upstream changes can still be merged.
//
//   node dsh-plugins/vssaros-superagent/dev/scripts/upstream-patches.mjs          write dev/vssaros-patches.diff
//   node dsh-plugins/vssaros-superagent/dev/scripts/upstream-patches.mjs --check  check it applies to a clean upstream
//
// The patch is in the upstream's layout: upstream's root files map to dev/ here (src, tests, docs, examples, scripts,
// SETUP.md, the configs and package.json), while prompts, skills, locale, cordis.patch.yml, README.md and NOTICE stay at
// the plugin root. The plugin root's package.json is VsSaros's own manifest and has no upstream counterpart.
// Merging an upstream update: apply this patch to the new upstream, resolve, then copy it back by the same map.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEV = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGIN = dirname(DEV)
const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
const UPSTREAM = process.env.DSH_SUPERAGENT_UPSTREAM ?? /\(([^)]+)\)/.exec(manifest.vssarosPatches?.upstream ?? '')?.[1]
const PATCHES = join(PLUGIN, manifest.vssarosPatches?.patches ?? 'dev/vssaros-patches.diff')
/** Upstream path → path here, relative to the plugin. */
export const LAYOUT = {
  src: 'dev/src', tests: 'dev/tests', docs: 'dev/docs', examples: 'dev/examples', scripts: 'dev/scripts', 'SETUP.md': 'dev/SETUP.md',
  'package.json': 'dev/package.json', 'tsconfig.json': 'dev/tsconfig.json', 'tsdown.config.ts': 'dev/tsdown.config.ts',
  'vitest.config.ts': 'dev/vitest.config.ts', prompts: 'prompts', skills: 'skills', locale: 'locale', 'cordis.patch.yml': 'cordis.patch.yml',
  'README.md': 'README.md', NOTICE: 'NOTICE',
}

if (!UPSTREAM || !existsSync(UPSTREAM)) {
  console.log(`dsh-superagent upstream not found (${UPSTREAM ?? 'unset'}); set DSH_SUPERAGENT_UPSTREAM to its checkout`)
  process.exit(process.argv.includes('--check') ? 0 : 1)
}
const slash = path => path.replace(/\\/g, '/')
if (process.argv.includes('--check')) {
  const result = spawnSync('git', ['-C', UPSTREAM, '--no-pager', 'apply', '--check', PATCHES], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) { console.error(`the patch set does not apply to ${UPSTREAM}:\n${result.stderr}`); process.exit(1) }
  console.log(`dev/vssaros-patches.diff applies to ${UPSTREAM}`)
  process.exit(0)
}
let diff = ''
for (const [upstream, here] of Object.entries(LAYOUT)) {
  const from = join(UPSTREAM, upstream), to = join(PLUGIN, here)
  if (!existsSync(from) && !existsSync(to)) continue
  // A side that does not exist is read as empty through the null device, which Git for Windows also names /dev/null.
  const a = existsSync(from) ? slash(from) : '/dev/null', b = existsSync(to) ? here : '/dev/null'
  const result = spawnSync('git', ['--no-pager', 'diff', '--no-index', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', a, b],
    { cwd: PLUGIN, encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true })
  if (result.status !== 0 && result.status !== 1) throw new Error(`git diff ${upstream}: ${result.stderr}`)
  // Name both sides by their upstream path.
  let text = result.stdout.replaceAll(`a/${slash(UPSTREAM)}/`, 'a/').replaceAll(`b/${slash(UPSTREAM)}/`, 'b/')
  if (here !== upstream) text = text.replaceAll(`a/${here}`, `a/${upstream}`).replaceAll(`b/${here}`, `b/${upstream}`)
  diff += text
}
writeFileSync(PATCHES, diff)
console.log(`wrote ${slash(relative(PLUGIN, PATCHES))}: ${diff.length} bytes`)
