/**
 * vssaros-memory/transcript — 导出前脱敏（纯函数）。
 *
 * 对齐官方 analyzer_system.md：「Never copy secrets, API keys, tokens,
 * passwords or other credentials into memory… If the fact matters, refer to
 * the credential by name without its value.」⇒ 只抹值，保留「deploy token」
 * 这类名称与上下文，命中规则要可审计。
 *
 * @module vssaros-memory/transcript/redact
 */

/** 顺序敏感：先整块（私钥），再具体凭据，最后通用模式。 */
export const MASK_RULES = Object.freeze([
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'bearer', re: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { name: 'api-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'credential', re: /((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'phone-cn', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { name: 'id-cn', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
])

/**
 * @param {string} text
 * @returns {{text: string, hits: Array<{rule:string,count:number}>}}
 */
export function redactText(text) {
  let out = String(text ?? '')
  const hits = []
  for (const { name, re } of MASK_RULES) {
    re.lastIndex = 0
    let count = 0
    out = out.replace(re, (matched, prefix) => {
      count++
      // credential 规则要保留 `token=` 这样的名称前缀，只替换值。
      return typeof prefix === 'string' ? `${prefix}[REDACTED:${name}]` : `[REDACTED:${name}]`
    })
    if (count > 0) hits.push({ rule: name, count })
  }
  return { text: out, hits }
}

/** 便捷判据：给守卫/测试用，检查具体值是否真的零命中。 */
export function containsAnySecret(text, values) {
  const source = String(text ?? '')
  return (values ?? []).filter((value) => value && source.includes(String(value)))
}
