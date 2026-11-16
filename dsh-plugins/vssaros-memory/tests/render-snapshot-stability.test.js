/**
 * 记忆「读取」的注入侧：renderSnapshot 的文本稳定性与可见性规则。
 * 单跑：node --test tests/render-snapshot-stability.test.js
 *
 * plugin.test.js 只断言过「KEY 注入、project/daily 不注入」的单点，本文件
 * 把「同一输入逐字节稳定、段顺序固定、bot 整条截断、摘要模式格式、空轨不
 * 产生空段、注入净化」钉成一组可回归的契约。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, renderSnapshot } from '../lib/index.js'
import { MemoryStore, withLock } from '../lib/store.js'
import { setLocale, getLocale } from '../lib/i18n.js'

const previousLocale = getLocale()
setLocale('zh')
after(() => setLocale(previousLocale))

/** 生产路径里写操作都在 withLock 内（锁负责建目录）；照真实链路包一层。 */
function writeTrack(store, target, entries, agent) {
  const loc = store.locate(target, agent)
  const write = store.write.bind(store)
  return withLock(loc.dir, () => write(target, entries, agent))
}

function withSnapshot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-snapshot-'))
  try {
    const store = new MemoryStore(dir, {
      botKeyResolver: () => 'code-explorer',
      projectDirResolver: () => join(dir, 'projects', 'p-test'),
    })
    const agent = { id: 'a1', session: { id: 's1', header: { cwd: '/work/p' } } }
    const config = resolveConfig({ memoryDir: dir, reviewEnabled: false })
    const snap = (extra = {}) => renderSnapshot({ ...config, ...extra }, store, agent, undefined, null, null)
    return fn({ dir, store, agent, config, snap })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function seed(store, agent) {
  writeTrack(store, 'memory', ['[2026-11-12] 全局事实 MEM'], agent)
  writeTrack(store, 'user', ['[2026-11-12] 用户偏好 USER'], agent)
  writeTrack(store, 'key', ['[id:abc12345] [summary:一句话] 关键事实 KEY'], agent)
  writeTrack(store, 'project', ['项目进展 PROJ'], agent)
  writeTrack(store, 'daily', ['今日日志 DAILY'], agent)
  writeTrack(store, 'bot', ['Bot 记忆 BOT'], agent)
}

test('同一输入连渲两次逐字节相等（前缀缓存友好的前提）', () => withSnapshot(({ snap, store, agent }) => {
  seed(store, agent)
  assert.equal(snap(), snap())
}))

test('段顺序固定：session → memory → user → bot → key，且用空行分隔', () => withSnapshot(({ snap, store, agent }) => {
  seed(store, agent)
  const text = snap()
  const pos = ['s1', '全局事实 MEM', '用户偏好 USER', 'Bot 记忆 BOT', '关键事实 KEY']
    .map((marker) => text.indexOf(marker))
  for (const p of pos) assert.ok(p >= 0, `缺少段：${pos.join(',')}`)
  for (let i = 1; i < pos.length; i++) assert.ok(pos[i] > pos[i - 1], '段顺序被打乱')
  assert.ok(text.split('\n\n').length >= 5, '段之间应以空行分隔')
}))

test('可见性：memory/user/bot/key 进快照，project/daily 绝不注入', () => withSnapshot(({ snap, store, agent }) => {
  seed(store, agent)
  const text = snap()
  assert.match(text, /全局事实 MEM/)
  assert.match(text, /用户偏好 USER/)
  assert.match(text, /Bot 记忆 BOT/)
  assert.match(text, /关键事实 KEY/)
  assert.ok(!text.includes('项目进展 PROJ'), 'project 轨每次都变，注入会打碎前缀缓存')
  assert.ok(!text.includes('今日日志 DAILY'), 'daily 轨每次都变，注入会打碎前缀缓存')
}))

test('botMemoryCharLimit=0 时整段不注入（不是截断成空段）', () => withSnapshot(({ snap, store, agent }) => {
  seed(store, agent)
  assert.match(snap(), /Bot 记忆 BOT/)
  const text = snap({ botMemoryCharLimit: 0 })
  assert.ok(!text.includes('Bot 记忆 BOT'))
  assert.ok(!text.includes('Bot 记忆'), 'head 也不该出现')
}))

test('摘要模式：给 - [id] summary，不泄漏 KEY 全文', () => withSnapshot(({ snap, store, agent }) => {
  seed(store, agent)
  const full = snap({ keyProgressiveDisclosure: 'off' })
  assert.match(full, /关键事实 KEY/)
  const brief = snap({ keyProgressiveDisclosure: 'on' })
  assert.ok(!brief.includes('关键事实 KEY'), '摘要模式不该注入全文')
  assert.match(brief, /- \[[^\]]+\] 一句话/, '摘要行应是 - [id] summary 固定格式')
}))

test('全量注入剥离 [id:] 与 [summary:] 元数据；正文里的 {{…}} 被净化', () => withSnapshot(({ snap, store, agent }) => {
  writeTrack(store, 'memory', ['[id:deadbeef] [summary:摘要] 事实 {{evil}} 保留'], agent)
  const text = snap()
  assert.ok(!text.includes('[id:deadbeef]'))
  assert.ok(!text.includes('[summary:摘要]'))
  assert.ok(!text.includes('{{evil}}'), '注入体不应携带模板占位符')
  assert.match(text, /事实 .*保留|保留/)
}))

test('空轨不产生空段：空存储时只有会话段与固定纪律文本', () => withSnapshot(({ snap }) => {
  const text = snap()
  assert.match(text, /s1/, '会话 ID 常驻')
  assert.ok(!text.includes('- \n'), '不应出现空条目行')
  assert.equal(text, snap(), '空存储也必须稳定')
}))
