#!/usr/bin/env node
/**
 * VsSaros addition (2026-11-07, P0 · co-install semantics): the real-machine case of `tests/dsb-coexist.spec.ts`.
 *
 * Reads, without changing anything, a real VsSaros data root (default `~/.vssaros-dev`): SuperAgent's `orchestrator.sqlite`
 * and the DSH session logs, and checks on what really ran that, with DS Bot (`ds-bot`) in the same profile:
 *   ① no model call is counted twice in `usage_call` (no relayed row has an own twin: same Session, model and tokens, within
 *      3 s), and DS Bot's relayed calls are recorded (`relay`), so GET usage and a ticket's page can show them;
 *   ② no team step's approval waits for a person while one of the person's `step_approval_rule`s covers it;
 *   ③ DS Bot's skills add at most 800 characters to the main Session's skill catalog (and how much the desk's history holds,
 *      which no desk request carries since 0.1.68);
 *   ④ every `team_distill` evidence names the step that ran (`sessionId` = step-<ticket>-<key>), and every relayed call of a
 *      step Session belongs to a step SuperAgent ran.
 * Each check prints PASS, FAIL or SKIP (no such data yet). Exit code 1 when one fails.
 *
 * To make the data: install ds-bot in the profile, save a value in DS Bot's secrets, set a text-only model for a team Bot,
 * then send the supervisor a team request whose text holds that value and an image, and answer one step's out-of-bounds
 * command with 「同意并记住」. Run: node dsh-plugins/vssaros-superagent/dev/scripts/e2e-dsb-coexist.mjs [--data <root>]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import zlib from 'node:zlib'

const at = process.argv.indexOf('--data')
const data = at > 0 ? process.argv[at + 1] : join(homedir(), '.vssaros-dev')
const home = join(data, 'dsh-home')
const results = []
const say = (check, state, detail) => { results.push(state); console.log(`${state.padEnd(4)} ${check}: ${detail}`) }

// DS Bot in the profile (as the Host loads it): a bundle of the vssaros profile named ds-bot.
const profile = JSON.parse(readFileSync(join(home, 'profiles', 'vssaros', 'package.json'), 'utf8'))
const bundles = profile.dsh?.profile?.bundles ?? []
const dsBot = bundles.includes('ds-bot') || existsSync(join(home, 'profiles', 'vssaros', 'node_modules', 'ds-bot', 'package.json'))
console.log(`data root ${data}; ds-bot ${dsBot ? 'installed' : 'NOT installed (the checks still run on what is there)'}`)

const db = new DatabaseSync(join(home, 'dsh-superagent', 'orchestrator.sqlite'), { readOnly: true })
const rows = (sql, ...args) => db.prepare(sql).all(...args)
const calls = rows('SELECT id, value FROM usage_call ORDER BY id').map(row => ({ id: row.id, ...JSON.parse(String(row.value)) }))

// ①
const relayed = calls.filter(call => call.relay)
const twins = relayed.filter(call => calls.some(other => other.id !== call.id && !other.relay && other.session === call.session && other.model === call.model
  && other.input === call.input && other.output === call.output && Math.abs(Date.parse(other.at) - Date.parse(call.at)) < 3000))
if (twins.length) say('①', 'FAIL', `${twins.length} relayed call(s) also counted as their own: ${twins.slice(0, 3).map(call => `${call.session}#${call.id}`).join(', ')}`)
else if (!relayed.length) say('①', 'SKIP', `${calls.length} calls, none relayed yet (no DS Bot rewrite or OCR in SuperAgent's Sessions)`)
else say('①', 'PASS', `${calls.length} calls; ${relayed.filter(call => call.relay === 'resent').length} resent and ${relayed.filter(call => call.relay === 'side').length} side, none counted twice`)

// ②
const rules = rows("SELECT value FROM step_approval_rule").map(row => JSON.parse(String(row.value)))
const pending = rows("SELECT name FROM sqlite_master WHERE type='table' AND name='step_approval'").length
  ? rows("SELECT value FROM step_approval").map(row => JSON.parse(String(row.value))).filter(item => !item.answer && !item.outcome) : []
const covered = pending.filter(item => rules.some(rule => rule.bot?.id === item.bot?.id && rule.tool === item.tool
  && typeof item.detail?.code === 'string' && (item.detail.code === rule.head || item.detail.code.startsWith(`${rule.head} `))))
if (covered.length) say('②', 'FAIL', `${covered.length} waiting approval(s) a rule covers: ${covered.map(item => item.detail.code).join(', ')}`)
else if (!rules.length) say('②', 'SKIP', 'no step_approval_rule yet (answer a step\'s command with 「同意并记住」)')
else say('②', 'PASS', `${rules.length} rule(s); ${pending.length} waiting approval(s), none of them covered by a rule`)

// ③ The latest skill catalog DSH put into the main Session, and none in the desk.
function sessionLog(id) {
  const root = join(home, 'sessions')
  for (const workspace of readdirSync(root)) {
    const file = join(root, workspace, id, 'session.v4.jsonl.zstd')
    if (existsSync(file)) return file
  }
  return undefined
}
function events(file) {
  const buf = readFileSync(file), magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), starts = []
  for (let i = buf.indexOf(magic); i >= 0; i = buf.indexOf(magic, i + 1)) starts.push(i)
  let text = ''
  for (let k = 0; k < starts.length; k++) { try { text += zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1] ?? buf.length)).toString('utf8') } catch { /* a magic number inside data */ } }
  return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
}
/** The `entries` of a skill catalog message (DSH writes `source: { kind: 'skill-catalog', entries }`) anywhere in an event. */
function catalogEntries(value) {
  if (!value || typeof value !== 'object') return undefined
  if (value.kind === 'skill-catalog' && Array.isArray(value.entries)) return value.entries
  for (const child of Object.values(value)) {
    const found = catalogEntries(child)
    if (found) return found
  }
  return undefined
}
const catalogs = file => events(file).flatMap(event => { const found = catalogEntries(event); return found ? [found] : [] })
const ids = Object.fromEntries(rows("SELECT name FROM sqlite_master WHERE type='table' AND name='kv'").length
  ? rows("SELECT key, value FROM kv WHERE key IN ('master', 'desk')").map(row => [row.key, String(row.value)]) : [])
const newest = prefix => readdirSync(join(home, 'sessions')).flatMap(workspace => readdirSync(join(home, 'sessions', workspace))
  .filter(name => name.startsWith(prefix)).map(name => join(home, 'sessions', workspace, name, 'session.v4.jsonl.zstd')))
  .filter(existsSync).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
const masterLog = ids.master ? sessionLog(ids.master) : newest('orchestrator-')
const deskLog = ids.desk ? sessionLog(ids.desk) : newest('desk-')
const DS_BOT_SKILLS = ['goal-grill', 'office', 'office-tools']
const last = masterLog ? catalogs(masterLog).at(-1) : undefined
const listed = last ?? []
const fromDsBot = listed.filter(entry => DS_BOT_SKILLS.includes(entry.name))
const added = fromDsBot.map(entry => `- ${entry.name}: ${entry.description}`).join('\n').length
const total = listed.map(entry => `- ${entry.name}: ${entry.description}`).join('\n').length
const deskCatalogs = deskLog ? catalogs(deskLog) : []
const deskChars = deskCatalogs.reduce((sum, entries) => sum + entries.map(entry => `- ${entry.name}: ${entry.description}`).join('\n').length, 0)
// The desk masks every tool, but its first step can run before the mask: SuperAgent 0.1.68+ drops a catalog from every desk
// request (`deskWithoutCatalog`), so one in its history is reported, not failed.
if (deskCatalogs.length) console.log(`NOTE ③: the desk's history holds ${deskCatalogs.length} skill catalog(s), ${deskChars} characters; no desk request carries them (deskWithoutCatalog)`)
if (added > 800) say('③', 'FAIL', `DS Bot adds ${added} characters to the main Session's skill catalog (cap 800)`)
else if (!last) say('③', 'SKIP', 'no skill catalog in the main Session\'s log yet')
else say('③', 'PASS', `main Session catalog: ${listed.length} skills (${total} characters), ${fromDsBot.length} of DS Bot (${added} characters)`)

// ④
const distills = rows('SELECT value FROM team_distill').map(row => JSON.parse(String(row.value)))
const wrong = distills.filter(item => item.evidence && item.evidence.sessionId && item.evidence.sessionId !== `step-${item.evidence.ticketId}-${item.evidence.stepKey}`)
const steps = new Set(rows('SELECT ticket, key FROM team_step').map(row => `${row.ticket}/${row.key}`))
const strays = relayed.filter(call => call.role === 'step' && !steps.has(`${call.ticketId}/${call.step}`))
if (wrong.length || strays.length) say('④', 'FAIL', `${wrong.length} evidence(s) naming another Session; ${strays.length} relayed step call(s) of no step`)
else if (!distills.length) say('④', 'SKIP', 'no team_distill evidence yet')
else say('④', 'PASS', `${distills.length} evidence(s), each of the step that ran; ${relayed.filter(call => call.role === 'step').length} relayed step call(s), all of known steps`)

db.close()
process.exitCode = results.includes('FAIL') ? 1 : 0
