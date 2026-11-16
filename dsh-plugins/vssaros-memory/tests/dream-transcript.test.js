/**
 * Dreaming P0 — 转录导出层契约。
 * 单跑：node --test tests/dream-transcript.test.js
 *
 * 纪律：插件之间不能跨包 import（vssaros-workitem/lib/core/ledger.js:3-5），
 * 所以 lib/transcript/ 自带一份**异步**多帧 zstd 解码，口径与
 * vssaros-sessions/lib/core/sessionLog.js 对齐；本测试用 zstdCompressSync
 * 造夹具（造数据可以同步，插件源码不许同步解压）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

import { decodeZstdFrames, parseJsonl } from '../lib/transcript/decode.js'
import { redactText } from '../lib/transcript/redact.js'
import { renderTranscript, safeName } from '../lib/transcript/render.js'
import { exportSessions } from '../lib/transcript/export.js'

const hasZstd = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompress === 'function'
const zstdOpts = hasZstd ? {} : { skip: '当前 Node 不支持 zstd（需要 22.15+）' }

async function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-transcript-'))
  try { return await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** 造一个「一份会话一个文件」的多帧 zstd 日志。 */
function makeLog(events) {
  if (!hasZstd) return Buffer.alloc(0)
  const lines = events.map((event) => JSON.stringify(event))
  return Buffer.concat(lines.map((line) => zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))))
}

function sessionEvents(id, { status = 'idle', user = '查一下测试命令', secret = '' } = {}) {
  return [
    { type: 'session', id, title: `会话 ${id}`, status, created_at: '2026-11-12T00:10:00Z', agent: { name: 'code-explorer' } },
    { type: 'user.message', content: [{ type: 'text', text: user }] },
    { type: 'agent.tool_use', name: 'grep', input: { q: 'make test' } },
    { type: 'agent.tool_result', name: 'grep', output: `命中 2 处 ${secret}` },
    { type: 'agent.message', content: [{ type: 'text', text: '结论：无需环境变量' }] },
  ]
}

test('decodeZstdFrames：多帧拼接逐帧解出，顺序不乱', zstdOpts, async () => {
  const buf = makeLog(sessionEvents('s1'))
  const text = await decodeZstdFrames(buf)
  const events = parseJsonl(text)
  assert.equal(events.length, 5)
  assert.equal(events[0].type, 'session')
  assert.equal(events[1].type, 'user.message')
  assert.match(text, /结论：无需环境变量/)
})

test('decodeZstdFrames：坏帧跳过且不编造内容', zstdOpts, async () => {
  const good = makeLog(sessionEvents('s2'))
  const broken = Buffer.from('这不是一帧 zstd 但含魔数之外的垃圾')
  const text = await decodeZstdFrames(Buffer.concat([good, broken, good]))
  const events = parseJsonl(text)
  assert.equal(events.filter((e) => e.type === 'session').length, 2, '两段好帧都应解出')
  assert.ok(!text.includes('这不是一帧'), '坏帧内容不得进入文本')
})

test('decodeZstdFrames：空 buffer / 无魔数返回空串，不抛错', async () => {
  assert.equal(await decodeZstdFrames(Buffer.alloc(0)), '')
  assert.equal(await decodeZstdFrames(Buffer.from('plain text')), '')
})

test('parseJsonl：跳过坏行而不整批失败', () => {
  const text = '{"type":"a"}\n不合法\n{"type":"b"}\n'
  assert.deepEqual(parseJsonl(text).map((e) => e.type), ['a', 'b'])
})

test('renderTranscript：官方标签格式 + 内容里的伪标签行加缩进', () => {
  const text = renderTranscript(sessionEvents('s3'), { agent: 'code-explorer' })
  assert.match(text, /^SESSION s3 \|/)
  assert.match(text, /USER:\n查一下测试命令/)
  assert.match(text, /AGENT:\n结论：无需环境变量/)
  assert.match(text, /TOOL CALL grep:\n/)
  assert.match(text, /TOOL RESULT \(grep\):\n/)
  assert.match(text, /EVENT session:/)
})

test('renderTranscript：正文里出现 USER: 时不被误读为新标签', () => {
  const events = [{ type: 'agent.message', content: [{ type: 'text', text: '第一行\nUSER:\n这是正文' }] }]
  const text = renderTranscript(events)
  assert.match(text, /AGENT:\n第一行\n USER:/, '内容里的标签样行必须缩进一个空格')
  assert.match(text, /这是正文/)
})

test('redactText：密钥 / Bearer / JWT / 邮箱 / 手机 / 身份证 / 私钥块零命中', () => {
  const raw = [
    'deploy token 的值：sk-abcdefghijklmnopqrstuvwxyz012345',
    'Authorization: Bearer abcdefghijklmnop123456',
    'jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    '联系 qiuzijian@example.com / 13800138000 / 110101199001011234',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----',
  ].join('\n')
  const { text, hits } = redactText(raw)
  for (const secret of [
    'sk-abcdefghijklmnopqrstuvwxyz012345',
    'Bearer abcdefghijklmnop123456',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    'qiuzijian@example.com', '13800138000', '110101199001011234', 'MIIEowIBAAKCAQEAsecret',
  ]) {
    assert.ok(!text.includes(secret), `敏感值仍在：${secret}`)
  }
  assert.match(text, /deploy token/, '凭据名称要保留，不能把上下文一起抹掉')
  assert.ok(hits.length >= 5, '必须报告命中的规则，便于审计')
  assert.ok(text.includes('[REDACTED:'))
})

test('redactText：干净文本零命中且逐字不变', () => {
  const raw = '0.4.0 起 make test 无需 TIDEWICK_DATA_DIR\n来源 07-release.txt#142'
  const { text, hits } = redactText(raw)
  assert.equal(text, raw)
  assert.equal(hits.length, 0)
})

test('safeName：文件名只允许 ASCII 安全字符且以字母/数字/_ 开头', () => {
  assert.equal(safeName('abc-01.txt'), 'abc-01.txt')
  const cn = safeName('中文 会话/abc')
  assert.match(cn, /^[A-Za-z0-9_][A-Za-z0-9._-]*$/)
  assert.ok(cn.endsWith('abc'))
  assert.equal(safeName(''), 'unnamed')
  assert.match(safeName('../etc/passwd'), /^[A-Za-z0-9_]/)
  assert.ok(!safeName('../etc/passwd').includes('/'))
})

test('exportSessions：只导已结束且含用户消息的会话，脱敏后一份一个 txt', zstdOpts, async () => {
  await withTmp(async (root) => {
    const sessions = join(root, 'sessions', 'cwd-a')
    const outDir = join(root, 'out')
    mkdirSync(sessions, { recursive: true })
    mkdirSync(outDir, { recursive: true })

    const cases = [
      ['done-1', { status: 'idle', secret: 'Bearer abcdefghijklmnop123456' }],
      ['empty-1', { status: 'idle', user: '' }],
      ['live-1', { status: 'running' }],
      ['done-2', { status: 'terminated' }],
    ]
    for (const [id, opts] of cases) {
      const dir = join(sessions, id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'session.v4.jsonl.zstd'), makeLog(sessionEvents(id, opts)))
    }

    const result = await exportSessions({ dshHome: root, outDir, since: 0, until: Date.now() + 1000 })
    const names = result.files.map((f) => f.name).sort()
    assert.deepEqual(names, ['done-1.txt', 'done-2.txt'])
    assert.equal(result.manifest.expected, 2)
    assert.equal(result.manifest.processed, 2)
    assert.equal(result.skipped.length, 2, '空会话与活跃会话都要记入跳过清单')

    const done1 = readFileSync(join(outDir, 'done-1.txt'), 'utf8')
    assert.match(done1, /^SESSION done-1 \|/)
    assert.ok(!done1.includes('Bearer abcdefghijklmnop123456'), '导出文件里不得残留密钥值')
    assert.match(done1, /\[REDACTED:/)
  })
})

test('exportSessions：增量窗口与 maxFiles 上限生效', zstdOpts, async () => {
  await withTmp(async (root) => {
    const sessions = join(root, 'sessions', 'cwd-a')
    const outDir = join(root, 'out')
    mkdirSync(sessions, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    for (let i = 0; i < 4; i++) {
      const dir = join(sessions, `s${i}`)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'session.v4.jsonl.zstd')
      writeFileSync(file, makeLog(sessionEvents(`s${i}`)))
      // 前两份是「昨天」，后两份是「今天」
      const at = i < 2 ? new Date('2026-11-10T00:00:00Z') : new Date('2026-11-12T00:00:00Z')
      utimesSync(file, at, at)
    }
    const since = new Date('2026-11-11T00:00:00Z').getTime()
    const all = await exportSessions({ dshHome: root, outDir, since, until: Date.now() })
    assert.equal(all.manifest.expected, 2, '窗口外的会话不进本轮')
    const capped = await exportSessions({ dshHome: root, outDir, since, until: Date.now(), maxFiles: 1 })
    assert.equal(capped.manifest.expected, 1, '超过上限要停止，不能悄悄截断半批')
    assert.ok(capped.skipped.some((s) => String(s.why).includes('上限')))
  })
})

test('exportSessions：P0 只读 —— 六轨记忆文件 mtime 与内容都不变', zstdOpts, async () => {
  await withTmp(async (root) => {
    const sessions = join(root, 'sessions', 'cwd-a')
    const memoryDir = join(root, 'memories')
    const outDir = join(root, 'out')
    mkdirSync(sessions, { recursive: true })
    mkdirSync(memoryDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    const dir = join(sessions, 'done-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), makeLog(sessionEvents('done-1')))

    const targets = ['MEMORY.md', 'USER.md', 'KEY.md'].map((name) => join(memoryDir, name))
    for (const file of targets) writeFileSync(file, `原始内容 ${file}\n`)
    const before = targets.map((file) => [statSync(file).mtimeMs, readFileSync(file, 'utf8')])

    await exportSessions({ dshHome: root, memoryDir, outDir, since: 0, until: Date.now() + 1000 })

    for (let i = 0; i < targets.length; i++) {
      assert.equal(statSync(targets[i]).mtimeMs, before[i][0], 'P0 不许碰记忆文件')
      assert.equal(readFileSync(targets[i], 'utf8'), before[i][1])
    }
    assert.ok(existsSync(join(outDir, 'done-1.txt')))
  })
})
