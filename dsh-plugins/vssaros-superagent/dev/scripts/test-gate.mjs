// VsSaros gate (2026-11-06): the whole SuperAgent suite, run in parallel as vitest runs it by default, must pass with no
// failure at all. Fails on any failed test, any error outside a test (an unhandled rejection), any spec file that did not
// run, and a missing toolchain (dev/node_modules) — a checkout that cannot run the suite does not pass it.
//
//   node dsh-plugins/vssaros-superagent/dev/scripts/test-gate.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dev = join(dirname(fileURLToPath(import.meta.url)), '..')
const vitest = join(dev, 'node_modules', 'vitest', 'vitest.mjs')
const fail = (message) => { console.error(`✗ superagent test gate: ${message}`); process.exit(1) }
if (!existsSync(vitest)) fail(`no toolchain at ${join(dev, 'node_modules')}: run pnpm install in dsh-plugins/vssaros-superagent/dev first`)

// The spec files vitest must run: all of tests/, less the POSIX-only one on Windows (vitest.config.ts says the same).
const posixOnly = process.platform === 'win32' ? ['service-script.spec.ts'] : []
const expected = readdirSync(join(dev, 'tests')).filter(name => /\.spec\.tsx?$/.test(name) && !posixOnly.includes(name)).sort()

const out = mkdtempSync(join(tmpdir(), 'superagent-gate-'))
const report = join(out, 'report.json')
try {
  const env = { ...process.env, NODE_OPTIONS: '' }
  const run = spawnSync(process.execPath, [vitest, 'run', '--reporter=dot', '--reporter=json', `--outputFile.json=${report}`],
    { cwd: dev, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  if (!existsSync(report)) fail(`vitest wrote no report (exit ${run.status}):\n${String(run.stderr || run.stdout).slice(-2000)}`)
  const result = JSON.parse(readFileSync(report, 'utf8'))
  const ran = result.testResults.map(file => file.name.replace(/\\/g, '/').split('/').pop()).sort()
  const missing = expected.filter(name => !ran.includes(name))
  const failed = result.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed')
    .map(test => `${file.name.replace(/\\/g, '/').split('/').pop()} › ${test.fullName}`))
  const broken = result.testResults.filter(file => file.status === 'failed' && !file.assertionResults.some(test => test.status === 'failed'))
    .map(file => `${file.name.replace(/\\/g, '/').split('/').pop()}: ${String(file.message ?? '').split('\n')[0]}`)
  const problems = [
    ...failed.map(line => `failed: ${line}`),
    ...broken.map(line => `file failed to run: ${line}`),
    ...missing.map(name => `did not run: ${name}`),
    ...!result.success && !failed.length && !broken.length ? [`vitest reported failure (exit ${run.status}): an error outside the tests`] : [],
  ]
  if (problems.length) fail(`${problems.length} problem(s)\n  ${problems.slice(0, 30).join('\n  ')}`)
  console.log(`✓ superagent test gate: ${ran.length} files, ${result.numPassedTests} passed, ${result.numPendingTests + result.numTodoTests} skipped, 0 failed (parallel)`)
} finally {
  rmSync(out, { recursive: true, force: true })
}
