// @vitest-environment jsdom
// VsSaros addition: the Chat tab's composer, after DeepSeek-Bot's: the "+" menu (files, a chat reference, a scheduled
// message), dictation, the voice-chat button that the send button replaces, and voice chat itself.
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { nextHourLocal, plainSpeech, speechNote } from '../src/client/composer.tsx'
import { all, click, find, mount, settle, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const composer = () => document.querySelector<HTMLTextAreaElement>('.dt-composer-input')!
const note = () => document.querySelector('.dt-composer-note')?.textContent

/** The browser's speech recognition, driven by the test. */
class FakeRecognition {
  static made: FakeRecognition[] = []
  lang = ''; interimResults = false; continuous = false; started = false
  onresult: ((event: unknown) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  constructor() { FakeRecognition.made.push(this) }
  start() { this.started = true }
  stop() { this.onend?.() }
  abort() { this.started = false }
  say(text: string, final = true) { this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: final })] }) }
}
const speech = () => {
  FakeRecognition.made = []
  vi.stubGlobal('webkitSpeechRecognition', FakeRecognition)
}
afterEach(() => { vi.unstubAllGlobals() })

it('shows the voice-chat button while the draft is empty and the send button once there is something to send', async () => {
  await mount()
  expect(composer().placeholder).toBe('给 SuperAgent 发消息')
  expect(document.querySelector('.dt-composer-voice')).not.toBeNull()
  expect(document.querySelector('.dt-composer-send')).toBeNull()
  await type(composer(), '帮我看下首页')
  expect(document.querySelector('.dt-composer-voice')).toBeNull()
  await click(find(zh['chat.send']))
  expect(server.deskSent).toEqual(['帮我看下首页'])
  expect(composer().value).toBe('')
  expect(document.querySelector('.dt-composer-voice')).not.toBeNull()
})

it('clears the draft on submit but restores it when the send fails', async () => {
  await mount()
  server.down = true
  await type(composer(), '保留我')
  await click(find(zh['chat.send']))
  await vi.waitFor(() => expect(composer().value).toBe('保留我'))
  expect(document.querySelector('[data-testid="local-submission"][data-state="failed"]')?.textContent).toContain(zh['chat.sendFailed'])
})

it('opens the "+" menu with files, a chat reference and a scheduled task, and closes it on Escape', async () => {
  await mount()
  const plus = find(zh['composer.add'])
  await click(plus)
  expect(plus.getAttribute('aria-expanded')).toBe('true')
  expect(all('.dt-menu [role="menuitem"]').map(item => item.textContent)).toEqual(['添加文件', '引用对话', '定时任务'])
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(document.querySelector('.dt-menu')).toBeNull()
  // A chat reference lands in the draft, naming the Thread the supervisor can read.
  await click(plus)
  await click(find(zh['composer.reference']))
  const first = all('.dt-menu-list button')[0]!
  const title = first.querySelector('.dt-menu-label')!.textContent!
  expect(all('.dt-menu-list button').some(item => item.textContent?.includes('主管对话'))).toBe(false)
  await click(first)
  expect(composer().value).toMatch(new RegExp(`^引用对话「${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}」（线程 [^）]+）$`))
  expect(document.querySelector('.dt-menu')).toBeNull()
})

it('attaches files: keeps them in the state directory and names them in the message', async () => {
  await mount()
  const input = document.querySelector<HTMLInputElement>('.dt-composer input[type="file"]')!
  const pick = async (...files: File[]) => {
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await settle()
  }
  await pick(new File(['hello'], 'notes.txt', { type: 'text/plain' }), new File([new Uint8Array(11 * 1024 * 1024)], 'huge.bin'))
  expect(text()).toContain(zh['composer.fileTooBig'].replace('{name}', 'huge.bin'))
  expect(all('.dt-composer-file-name').map(item => item.textContent)).toEqual(['notes.txt'])
  expect(document.querySelector('.dt-composer')?.hasAttribute('data-tall')).toBe(true)
  // Files alone are something to send.
  await click(find(zh['chat.send']))
  await vi.waitFor(() => expect(server.deskSent).toHaveLength(1))
  expect(server.deskFiles).toEqual([{ name: 'notes.txt', data: 'aGVsbG8=' }])
  expect(server.deskSent[0]).toBe('附件：\n- notes.txt（5 B）：/state/desk-files/notes.txt')
  expect(all('.dt-composer-file')).toHaveLength(0)
  // A file can be taken off before sending.
  await pick(new File(['x'], 'a.txt'))
  await click(find(zh['composer.removeFile'].replace('{name}', 'a.txt')))
  expect(all('.dt-composer-file')).toHaveLength(0)
})

it('schedules the draft as a message to the supervisor, and lists and deletes scheduled ones', async () => {
  await mount()
  await type(composer(), '汇总昨天的工单进度')
  await click(find(zh['composer.add']))
  await click(find(zh['composer.schedule']))
  const dialog = () => document.querySelector('[role="dialog"]')!
  expect(dialog().textContent).toContain(zh['schedule.empty'])
  expect(dialog().querySelector('textarea')!.value).toBe('汇总昨天的工单进度')
  expect(dialog().querySelector<HTMLInputElement>('input[type="datetime-local"]')!.value).toBe(nextHourLocal())
  await type(dialog().querySelector('select')!, 'daily')
  await click(find(zh['schedule.save']))
  expect(server.deskSchedules).toMatchObject([{ text: '汇总昨天的工单进度', repeat: 'daily' }])
  expect(new Date(server.deskSchedules[0]!.at).getTime()).toBe(new Date(nextHourLocal()).getTime())
  expect(document.querySelector('.dt-toast')?.textContent).toContain('已添加定时任务')
  expect(composer().value).toBe('')
  await click(find(zh['composer.add']))
  await click(find(zh['composer.schedule']))
  const listed = document.querySelector('[data-testid="desk-schedules"]')?.textContent ?? ''
  expect(listed).toContain('汇总昨天的工单进度')
  expect(listed).toContain(zh['schedule.daily'])
  await click(find(zh['schedule.delete'], '[role="dialog"] button'))
  expect(server.deskSchedules).toEqual([])
})

it('dictates into the draft, and says when dictation is not available', async () => {
  await mount()
  await click(find(zh['composer.dictate']))
  expect(note()).toBe(zh['composer.dictationUnavailable'])
  speech()
  await type(composer(), '首页')
  await click(find(zh['composer.dictate']))
  expect(find(zh['composer.stopDictation']).getAttribute('aria-pressed')).toBe('true')
  await act(async () => { FakeRecognition.made[0]!.say('要加新手引导', false); FakeRecognition.made[0]!.say('要加新手引导') })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(composer().value).toBe('首页要加新手引导')
  await click(find(zh['composer.stopDictation']))
  expect(find(zh['composer.dictate']).getAttribute('aria-pressed')).toBe('false')
  await act(async () => { FakeRecognition.made[0]!.onerror?.({ error: 'not-allowed' }) })
  expect(note()).toBe(zh['composer.micBlocked'])
})

it('holds a voice chat: sends what was said, reads the answer aloud and listens again, until it ends', async () => {
  speech()
  const spoken: string[] = []
  class Utterance { lang = ''; onend: (() => void) | null = null; constructor(public text: string) {} }
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
  vi.stubGlobal('speechSynthesis', { cancel: vi.fn(), speak: vi.fn((utterance: Utterance) => { spoken.push(utterance.text); setTimeout(() => utterance.onend?.(), 0) }) })
  await mount()
  await click(find(zh['composer.voiceStart']))
  expect(document.querySelector('.dt-voice-status')?.textContent).toBe(zh['voice.listening'])
  expect(document.querySelector('.dt-composer')).toBeNull()
  await act(async () => { FakeRecognition.made[0]!.say('首页新手引导要上线'); FakeRecognition.made[0]!.stop() })
  await settle()
  expect(server.deskSent).toEqual(['首页新手引导要上线'])
  expect(document.querySelector('.dt-voice-status')?.textContent).toBe(zh['voice.thinking'])
  server.deskMessages = [...server.deskMessages, { id: 'r1', role: 'superagent', text: '**已接单**：首页新手引导上线。', at: '2026-11-05T10:01:00.000Z' }]
  await vi.waitFor(() => expect(spoken).toEqual(['已接单 ：首页新手引导上线。']), { timeout: 4000 })
  // After reading it aloud, it listens again.
  await vi.waitFor(() => expect(FakeRecognition.made.length).toBe(2))
  expect(document.querySelector('.dt-voice-status')?.textContent).toBe(zh['voice.listening'])
  await click(find(zh['voice.pause']))
  expect(document.querySelector('.dt-voice-status')?.textContent).toBe(zh['voice.paused'])
  await click(find(zh['voice.end']))
  expect(document.querySelector('.dt-voice')).toBeNull()
  expect(document.querySelector('.dt-composer')).not.toBeNull()
})

it('says when voice chat is not available, and words speech the way a person hears it', async () => {
  await mount()
  await click(find(zh['composer.voiceStart']))
  expect(document.querySelector('.dt-voice-status')?.textContent).toBe(zh['voice.unsupported'])
  expect(all('.dt-voice-bar button').map(button => button.getAttribute('aria-label'))).toEqual([zh['voice.end']])
  expect(plainSpeech('## 标题\n见 [文档](https://x) 和 `code`\n```js\nx()\n```')).toBe('标题 见 文档 和 code')
  expect([speechNote('no-speech'), speechNote('network'), speechNote('not-allowed'), speechNote('bad')])
    .toEqual([undefined, 'composer.dictationOffline', 'composer.micBlocked', 'composer.notHeard'])
})
