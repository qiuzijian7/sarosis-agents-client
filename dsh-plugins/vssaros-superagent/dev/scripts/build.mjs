#!/usr/bin/env node
// VsSaros addition: builds the shipped lib/ of the VsSaros built-in @vssaros/dsh-superagent from this dev/ workspace.
// lib/ is committed, because the release pipeline builds no plugin.
//
//   node dsh-plugins/vssaros-superagent/dev/scripts/build.mjs          build ../lib
//   node dsh-plugins/vssaros-superagent/dev/scripts/build.mjs --check  only check that ../lib is what the source builds
//
// VsSaros fix (2026-11-06): without this workspace's node_modules (`pnpm --dir dsh-plugins/vssaros-superagent/dev install`)
// `--check` fails — a checkout that cannot build lib/ cannot say lib/ is right. Only `DSH_SUPERAGENT_ALLOW_NO_TOOLCHAIN=1`
// lets it pass, and it says so loudly.
//
// VsSaros fix (2026-11-06, version linkage): lib/build-manifest.json records the package version lib/ was built for and a
// hash of its files. A build whose lib/ differs from the last one under the same version fails ("bump the version": the
// Host refreshes an installed plugin only on a new version, so the change would not take effect), and `--check` fails when
// the manifest's hash is not lib/'s or its version is not package.json's.
//
// VsSaros addition (2026-11-07): `--check` also fails when doc/superagent-framework-v2.html is not for this version (its
// `data-baseline` and the end of its 15.0 heading), so the doc cannot drift behind the code again.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEV = dirname(dirname(fileURLToPath(import.meta.url)))
const LIB = join(DEV, '..', 'lib')
const check = process.argv.includes('--check')

/** Every file under `dir`, relative to it, with forward slashes. */
function filesOf(dir, base = dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesOf(path, base) : [relative(base, path).replace(/\\/g, '/')]
  })
}
const MANIFEST = 'build-manifest.json'
const versionOf = () => String(JSON.parse(readFileSync(join(DEV, '..', 'package.json'), 'utf8')).version)
/** A hash of every file of `dir` but the manifest, by path and content. */
function hashOf(dir) {
  const hash = createHash('sha256')
  for (const file of filesOf(dir).filter(name => name !== MANIFEST).sort()) hash.update(`${file}\0`).update(readFileSync(join(dir, file))).update('\0')
  return `sha256:${hash.digest('hex')}`
}
const manifestOf = dir => { try { return JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) } catch { return undefined } }
/**
 * VsSaros addition (2026-11-07, doc version guard): the design doc's code baseline must be the package's version, as the
 * manifest's is — it says so twice, `data-baseline="<version>"` on its baseline tag and the end of its 15.0 heading's range
 * (「15.0 · 0.1.56 – <version> …」). Concurrent work bumped the version without the doc (0.1.62 in the doc at 0.1.65).
 * A checkout without the doc (the plugin outside this repository) has nothing to check.
 * @returns why the doc is not for this version, or undefined.
 */
function docBaselineProblem(text = readDoc(), version = versionOf()) {
  if (text === undefined) return undefined
  const declared = /data-baseline="([^"]+)"/.exec(text)?.[1]
  const range = /<h3>15\.0 · \S+ – (\S+)/.exec(text)?.[1]
  if (declared === version && range === version) return undefined
  return `${DOC_NAME} says baseline ${declared ?? '(none)'} and 15.0 up to ${range ?? '(none)'}, but dsh-plugins/vssaros-superagent is ${version}:`
    + ` update its data-baseline, its 15.0 heading, and 15.0's rows for what changed`
}
const DOC_NAME = 'doc/superagent-framework-v2.html'
function readDoc() {
  const path = join(DEV, '..', '..', '..', DOC_NAME)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}
/**
 * VsSaros addition (2026-11-09, doc structure guard): a concurrent merge left `<<<` / `>>>` markers and
 * duplicated closing tags in the design doc while its `data-baseline` was still correct — the version
 * guard cannot see structural damage. `--check` also rejects conflict markers and unbalanced tags.
 * Comments, <style> and <script> bodies are excluded: their text is not document structure.
 * @returns why the doc is structurally broken, or undefined.
 */
function docStructureProblem(text = readDoc()) {
  if (text === undefined) return undefined
  const markers = []
  if (text.includes('<<<') || text.includes('>>>')) markers.push('unresolved conflict markers <<< / >>>')
  if (/^\s*={7,}\s*$/m.test(text)) markers.push('an unresolved conflict separator =======')
  if (markers.length) return `${DOC_NAME} has ${markers.join(' and ')}: resolve the merge first`
  const shape = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  const unbalanced = []
  for (const tag of ['section', 'main', 'div', 'ol']) {
    const open = (shape.match(new RegExp('<' + tag + '(?=[\\s>])', 'g')) ?? []).length
    const close = (shape.match(new RegExp('</' + tag + '>', 'g')) ?? []).length
    if (open !== close) unbalanced.push(`<${tag}> ${open} open / ${close} close`)
  }
  return unbalanced.length ? `${DOC_NAME} has unbalanced HTML tags: ${unbalanced.join(', ')}` : undefined
}
/** Runs tsdown from this workspace; it writes ../lib. */
function build() {
  const bin = join(DEV, 'node_modules', 'tsdown', 'dist', 'run.mjs')
  const result = spawnSync(process.execPath, [bin], { cwd: DEV, stdio: check ? 'pipe' : 'inherit', windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '' } })
  if (result.status !== 0) throw new Error(`tsdown exited ${result.status}${check ? `:\n${String(result.stderr)}` : ''}`)
}

if (!existsSync(join(DEV, 'node_modules', 'tsdown'))) {
  const message = 'the dsh-superagent toolchain is not installed (pnpm --dir dsh-plugins/vssaros-superagent/dev install)'
  if (!check) throw new Error(message)
  if (process.env.DSH_SUPERAGENT_ALLOW_NO_TOOLCHAIN === '1') {
    // Still check what can be checked without building: the manifest against lib/ and package.json.
    const manifest = manifestOf(LIB)
    const ok = manifest && manifest.hash === hashOf(LIB) && manifest.version === versionOf()
    console.warn(`⚠ dsh-plugins/vssaros-superagent/lib: NOT rebuilt (DSH_SUPERAGENT_ALLOW_NO_TOOLCHAIN=1); ${message}. Manifest ${ok ? 'matches' : 'does NOT match'} lib/ and package.json.`)
    const doc = docBaselineProblem(), shape = docStructureProblem()
    if (doc) console.error(`✗ ${doc}`)
    if (shape) console.error(`✗ ${shape}`)
    process.exit(ok && !doc && !shape ? 0 : 1)
  }
  console.error(`✗ dsh-plugins/vssaros-superagent/lib: cannot be checked, ${message}. (Set DSH_SUPERAGENT_ALLOW_NO_TOOLCHAIN=1 to check only its manifest.)`)
  process.exit(1)
}

const kept = mkdtempSync(join(tmpdir(), 'dsh-superagent-lib-'))
cpSync(LIB, kept, { recursive: true })
rmSync(LIB, { recursive: true, force: true })
let restore = check
try {
  build()
  // The bundled entries load with nothing but Node built-ins (the repository's guards import them bare).
  const entries = filesOf(LIB).filter(file => file.endsWith('.js') && file !== 'client.js')
    .map(file => readFileSync(join(LIB, file), 'utf8')).join('\n')
  const bare = [...new Set([...entries.matchAll(/(?:^|[\s;])(?:import\s[^'"]*?from\s*|import\s*)['"]([^'"./][^'"]*)['"]/gm)].map(match => match[1]))]
    .filter(name => !name.startsWith('node:'))
  if (bare.length) { restore = true; throw new Error(`the bundled entry imports packages: ${bare.join(', ')}`) }
  // Version linkage: lib/ changed under the same version would not reach an installed copy.
  const version = versionOf(), hash = hashOf(LIB), previous = manifestOf(kept)
  if (!check && previous && previous.version === version && previous.hash !== hash) {
    restore = true
    throw new Error(`lib/ changed but the version is still ${version}: bump "version" in dsh-plugins/vssaros-superagent/package.json, then build again`)
  }
  writeFileSync(join(LIB, MANIFEST), `${JSON.stringify({ version, hash }, null, 2)}\n`)
  if (check) {
    const before = filesOf(kept), after = filesOf(LIB)
    const changed = after.filter(file => !before.includes(file) || !readFileSync(join(kept, file)).equals(readFileSync(join(LIB, file))))
    const removed = before.filter(file => !after.includes(file))
    if (changed.length || removed.length) {
      const stale = changed.includes(MANIFEST) && changed.length === 1
      console.error(stale ? `dsh-plugins/vssaros-superagent/lib/${MANIFEST} is not for version ${version} / these files: rebuild after a version bump`
        : `dsh-plugins/vssaros-superagent/lib is not what dev/src builds: ${[...changed, ...removed.map(file => `-${file}`)].join(', ')}`)
      console.error('Run: node dsh-plugins/vssaros-superagent/dev/scripts/build.mjs')
      process.exitCode = 1
    } else console.log(`dsh-plugins/vssaros-superagent/lib matches dev/src (${after.length} files, version ${version})`)
    const doc = docBaselineProblem(), shape = docStructureProblem()
    if (doc) { console.error(`✗ ${doc}`); process.exitCode = 1 }
    if (shape) { console.error(`✗ ${shape}`); process.exitCode = 1 }
    if (readDoc() !== undefined && !doc && !shape) console.log(`${DOC_NAME} is for version ${version} and structurally sound`)
  } else {
    console.log(`built dsh-plugins/vssaros-superagent/lib: ${filesOf(LIB).length} files`)
    const doc = docBaselineProblem(), shape = docStructureProblem()
    if (doc) console.warn(`⚠ ${doc} (build.mjs --check fails until it is)`)
    if (shape) console.warn(`⚠ ${shape} (build.mjs --check fails until it is)`)
  }
} catch (error) {
  restore = true
  throw error
} finally {
  if (restore) { rmSync(LIB, { recursive: true, force: true }); cpSync(kept, LIB, { recursive: true }) }
  rmSync(kept, { recursive: true, force: true })
}
