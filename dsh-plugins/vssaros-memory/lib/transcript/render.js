/**
 * vssaros-memory/transcript — 事件 → 官方标签格式的纯文本转录。
 *
 * 标签口径对齐 Anthropic prompts/analyzer_system.md：
 *   USER: / AGENT: / TOOL CALL <tool>: / TOOL RESULT (<tool>): / EVENT <type>:
 * 正文里若出现标签样行，缩进一个空格，避免被 analyzer 误读为事件边界。
 * 纯文本而非 JSON：官方实测这一项能显著降本（少轮次、少 token）。
 *
 * @module vssaros-memory/transcript/render
 */

const LABEL_RE = /^(?:USER:|AGENT:|TOOL CALL |TOOL RESULT \(|SESSION |NOTE ABOUT THIS FILE:|EVENT |=== )/

/** 标签样行缩进一格（官方 analyzer prompt 明确的转义规则）。 */
export function indentLabelLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => (LABEL_RE.test(line) ? ` ${line}` : line))
    .join('\n')
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : String(part?.text ?? part?.content ?? '')))
      .join('\n')
  }
  return String(content ?? '')
}

function formatValue(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return indentLabelLines(value)
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, val]) => `${key}: ${typeof val === 'string' ? val : JSON.stringify(val)}`)
      .join('\n')
  }
  return String(value)
}

/** 文件名只保留 ASCII 安全字符；消息里只传文件名，不传转录正文。 */
export function safeName(name) {
  const raw = String(name ?? '').trim()
  if (!raw) return 'unnamed'
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.+/g, '.')
  const trimmed = cleaned.replace(/^[^A-Za-z0-9_]+/, '')
  if (!trimmed) return 'unnamed'
  return /^[A-Za-z0-9_]/.test(trimmed) ? trimmed : `s_${trimmed}`
}

function blockOf(event) {
  const type = String(event?.type ?? 'unknown')
  if (type === 'user.message' || type === 'user') {
    return `USER:\n${indentLabelLines(textOf(event.content ?? event.text))}`
  }
  if (type === 'agent.message' || type === 'agent') {
    return `AGENT:\n${indentLabelLines(textOf(event.content ?? event.text))}`
  }
  if (type === 'agent.tool_use' || type === 'tool/call' || type === 'tool_use') {
    const name = String(event.name ?? event.tool ?? 'unknown')
    const input = event.input ?? event.arguments ?? event.args
    return `TOOL CALL ${name}:\n${indentLabelLines(formatValue(input))}`
  }
  if (type === 'agent.tool_result' || type === 'tool/result' || type === 'tool_result') {
    const name = String(event.name ?? event.tool ?? 'unknown')
    const output = event.output ?? event.result ?? event.content
    return `TOOL RESULT (${name}):\n${indentLabelLines(formatValue(output))}`
  }
  // session / usage / thinking / thread_created 等一律进 EVENT，正文由 analyzer 判断。
  return `EVENT ${type}:\n${JSON.stringify(event)}`
}

/**
 * @param {Array<object>} events 已解码的 JSONL 事件
 * @param {{agent?:string, title?:string, note?:string}} [meta]
 * @returns {string}
 */
export function renderTranscript(events, meta = {}) {
  const list = Array.isArray(events) ? events : []
  const sessionEvent = list.find((event) => event?.type === 'session') ?? {}
  const id = String(sessionEvent.id ?? meta.sessionId ?? 'unknown')
  const title = String(sessionEvent.title ?? meta.title ?? '')
  const agent = String(sessionEvent.agent?.name ?? sessionEvent.agent ?? meta.agent ?? 'agent')
  const createdAt = String(sessionEvent.created_at ?? meta.createdAt ?? '')
  const head = `SESSION ${id} | ${title} | ${agent} | ${createdAt}`
  const notes = meta.note ? `NOTE ABOUT THIS FILE: ${meta.note}` : ''
  // session 事件本身也进 EVENT 块（官方格式里它是事件，不是被丢弃的元数据）。
  const body = list.map(blockOf).join('\n\n')
  return [head, notes, '=== primary thread: ' + agent + ' ===', body].filter(Boolean).join('\n') + '\n'
}
