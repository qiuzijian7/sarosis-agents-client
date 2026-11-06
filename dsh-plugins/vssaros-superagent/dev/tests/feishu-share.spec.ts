/**
 * VsSaros addition: the Feishu Source must not open a second long connection for an app the Bots inbound already
 * holds, because Feishu delivers each event to one connection of an app at random. Real temporary lock and
 * credentials files are used, written exactly as vssaros-agents writes them.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOTS_LOCK_STALE_MS, botsFeishuApp, busTaken, FEISHU_EVENTS_KEY, feishuAppHolder, FeishuConsumerExit, listensShared,
  sharedEvent, sharedFeishuEvents } from '../src/sources/feishu-share.ts'
import { HEALTH_TEXT } from '../src/sources/host.ts'

const dirs: string[] = []
const tree = (): string => { const dir = mkdtempSync(join(tmpdir(), 'sa-feishu-share-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const NOW = 1_800_000_000_000
/** A home with the Bots lock and, in `dataRoot`, the credentials file naming `appId`. */
function bots(appId: string | undefined, lock: { pid?: number; heartbeatAt?: number; dataRoot?: string } = {}) {
  const home = tree(), dataRoot = lock.dataRoot ?? join(home, '.vssaros-dev')
  mkdirSync(dataRoot, { recursive: true })
  if (appId !== undefined)
    writeFileSync(join(dataRoot, 'agent-im-accounts.json'), JSON.stringify({ version: 1, accounts: { feishu: { appId, appSecret: 's' } } }))
  writeFileSync(join(home, '.vssaros-im-feishu.lock'), JSON.stringify({ format: 1, platform: 'feishu', pid: lock.pid ?? 4242,
    dataRoot, acquiredAt: NOW, heartbeatAt: lock.heartbeatAt ?? NOW - 1000 }))
  return { home, dataRoot }
}
const live = () => true

describe('the Bots inbound that holds a Feishu app', () => {
  it('is found when a live, fresh holder uses the same app', () => {
    const { home, dataRoot } = bots('cli_shared')
    expect(feishuAppHolder('cli_shared', { home, now: NOW, isAlive: live })).toEqual({ pid: 4242, dataRoot, appId: 'cli_shared' })
  })
  it('is ignored for another app, a stale heartbeat, a dead pid or no lock at all', () => {
    const other = bots('cli_bots')
    expect(feishuAppHolder('cli_superagent', { home: other.home, now: NOW, isAlive: live })).toBeUndefined()
    const stale = bots('cli_shared', { heartbeatAt: NOW - BOTS_LOCK_STALE_MS - 1 })
    expect(feishuAppHolder('cli_shared', { home: stale.home, now: NOW, isAlive: live })).toBeUndefined()
    const dead = bots('cli_shared')
    expect(feishuAppHolder('cli_shared', { home: dead.home, now: NOW, isAlive: () => false })).toBeUndefined()
    expect(feishuAppHolder('cli_shared', { home: tree(), now: NOW, isAlive: live })).toBeUndefined()
  })
  it('never blocks the Source when the holder\'s app cannot be read', () => {
    const { home } = bots(undefined)
    expect(feishuAppHolder('cli_shared', { home, now: NOW, isAlive: live })).toBeUndefined()
    expect(botsFeishuApp(join(tree(), 'missing'))).toBeUndefined()
  })
  it('falls back to the release data root when the lock names none', () => {
    const home = tree()
    const { dataRoot } = bots('cli_shared', { dataRoot: join(home, '.vssaros') })
    writeFileSync(join(home, '.vssaros-im-feishu.lock'), JSON.stringify({ pid: 7, dataRoot: '', heartbeatAt: NOW }))
    expect(feishuAppHolder('cli_shared', { home, now: NOW, isAlive: live })).toEqual({ pid: 7, dataRoot, appId: 'cli_shared' })
  })
  it('only reads, so the Bots keep their lock untouched', () => {
    const { home } = bots('cli_shared')
    const before = readFileSync(join(home, '.vssaros-im-feishu.lock'), 'utf8')
    feishuAppHolder('cli_shared', { home, now: NOW, isAlive: live })
    expect(readFileSync(join(home, '.vssaros-im-feishu.lock'), 'utf8')).toBe(before)
  })
  it('sees a per-app lock of vssaros-agents 0.2.317+, and trusts the appId written into the legacy lock', () => {
    const home = tree()
    writeFileSync(join(home, '.vssaros-im-feishu-cli_extra1.lock'), JSON.stringify({ pid: 11, dataRoot: '/r', heartbeatAt: NOW }))
    expect(feishuAppHolder('cli_Extra1', { home, now: NOW, isAlive: live })).toEqual({ pid: 11, dataRoot: '/r', appId: 'cli_Extra1' })
    expect(feishuAppHolder('cli_other', { home, now: NOW, isAlive: live })).toBeUndefined()
    // A legacy lock naming its app needs no credentials file, and a different app is no conflict.
    writeFileSync(join(home, '.vssaros-im-feishu.lock'), JSON.stringify({ pid: 12, dataRoot: '/nowhere', appId: 'cli_dflt', heartbeatAt: NOW }))
    expect(feishuAppHolder('cli_dflt', { home, now: NOW, isAlive: live })?.pid).toBe(12)
    expect(feishuAppHolder('cli_other', { home, now: NOW, isAlive: live })).toBeUndefined()
  })
})

describe('a consumer that another event bus pre-empts', () => {
  it('is recognized from lark-cli\'s exit code 2 and its message only', () => {
    expect(busTaken(2, '{"error":{"message":"another bus already connected for app cli_x"}}')).toBe(true)
    expect(busTaken(2, 'unknown EventKey im.foo')).toBe(false)
    expect(busTaken(4, 'another bus already connected')).toBe(false)
    const exit = new FeishuConsumerExit(2, false, 'another bus already connected')
    expect(exit.message).toBe('Feishu event consumer exited (2, ready=false): another bus already connected')
  })
  it('has health text that names the app and the one-connection rule', () => {
    expect(HEALTH_TEXT.feishuAppShared).toContain('{app}')
    expect(HEALTH_TEXT.feishuAppShared).toContain('{holder}')
    expect(HEALTH_TEXT.feishuBusBusy).toContain('one connection only')
  })
  it('is checked before the consumer starts, and the exit keeps its code', () => {
    const loops = readFileSync(new URL('../src/sources/feishu-loops.ts', import.meta.url), 'utf8')
    const consume = loops.indexOf('await consume(ctx, running.signal)')
    expect(loops.indexOf('listensShared(sharedFeishuEvents(), appId, feishuAppHolder(appId))')).toBeLessThan(consume)
    expect(loops.indexOf('const holder = feishuAppHolder(appId)')).toBeLessThan(consume)
    expect(loops).toContain('new FeishuConsumerExit(code, ready, diagnostic)')
    expect(loops).toContain("health('error', 'feishuBusBusy'")
    // A running consumer yields within five seconds when the Bots take the same app later, here or elsewhere.
    expect(loops).toContain('if (!enabled(ctx) || feishuAppHolder(appId) || sharedFeishuEvents()?.active(appId)) running.abort()')
  })
})

describe('listening through the Bots connection in this Host', () => {
  const raw = (overrides: Record<string, unknown> = {}, sender: Record<string, unknown> = { sender_type: 'user', sender_id: { open_id: 'ou_alice' } }) =>
    ({ schema: '2.0', header: { event_type: 'im.message.receive_v1', app_id: 'cli_bot' }, event: { sender, message: {
      message_id: 'om_1', chat_id: 'oc_g', chat_type: 'group', message_type: 'text', create_time: '1800000000000',
      content: JSON.stringify({ text: '@_user_1 fix it' }), mentions: [{ key: '@_user_1', name: 'Bot', id: { open_id: 'ou_bot', union_id: 'on_x' } }],
      root_id: 'om_0', ...overrides } } })
  it('turns a raw v2 event into the shape event consume prints', () => {
    expect(sharedEvent(raw())).toEqual({ message_id: 'om_1', chat_id: 'oc_g', chat_type: 'group', create_time: '1800000000000',
      sender_id: 'ou_alice', sender_type: 'user', content: '@_user_1 fix it', mentions: [{ id: 'ou_bot', key: '@_user_1', name: 'Bot' }],
      root_id: 'om_0' })
    expect(sharedEvent(raw({ chat_type: 'p2p', content: 'plain system text', mentions: undefined }))).toMatchObject(
      { chat_type: 'p2p', content: 'plain system text', mentions: [] })
    expect(sharedEvent(raw({}, { sender_type: 'app', sender_id: { open_id: 'ou_other_bot' } }))).toMatchObject({ sender_type: 'bot' })
  })
  it('drops other events, and a sender it cannot tell from this bot', () => {
    expect(sharedEvent({ header: { event_type: 'im.chat.member.bot.added_v1' }, event: {} })).toBeUndefined()
    expect(sharedEvent(raw({}, { sender_type: 'app', sender_id: {} }))).toBeUndefined()
    expect(sharedEvent(raw({ chat_id: '' }))).toBeUndefined()
    expect(sharedEvent(undefined)).toBeUndefined()
  })
  it('finds the bus only in the shape vssaros-agents publishes', () => {
    expect(sharedFeishuEvents({})).toBeUndefined()
    expect(sharedFeishuEvents({ [FEISHU_EVENTS_KEY]: { version: 2, active: () => true, subscribe: () => () => {} } })).toBeUndefined()
    const bus = { version: 1 as const, active: () => true, subscribe: () => () => {} }
    expect(sharedFeishuEvents({ [FEISHU_EVENTS_KEY]: bus })).toBe(bus)
  })
  it('listens shared while the connection is up, or while the Bots of this process hold the lock and reconnect', () => {
    const bus = (up: boolean) => ({ version: 1 as const, active: (id: string) => up && id === 'cli_bot', subscribe: () => () => {} })
    expect(listensShared(undefined, 'cli_bot', undefined)).toBe(false)
    expect(listensShared(bus(true), 'cli_bot', undefined)).toBe(true)
    expect(listensShared(bus(true), 'cli_other', undefined)).toBe(false)
    expect(listensShared(bus(false), 'cli_bot', { pid: 7, dataRoot: '', appId: 'cli_bot' }, 7)).toBe(true)
    expect(listensShared(bus(false), 'cli_bot', { pid: 8, dataRoot: '', appId: 'cli_bot' }, 7)).toBe(false)
  })
})
