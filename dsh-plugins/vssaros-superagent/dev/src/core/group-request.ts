/** 建群 / 组队请求的共享判据：Intake 回答闸门与群聊快路径必须同源（2026-11-10）。 */
/** 动词到「群/团队」之间最多 48 字符（够放长标题，又不跨过整句话）；「群聊」单独命中。 */
export const GROUP_REQUEST = /(?:建|拉|创建|组建|成立)[^，,。！!？?]{0,48}(?:群|团队)|群聊/u

import type { Trigger } from './model.ts'

/** ★ 2026-11-12（用户授权改准入规则）：明确任务 = 任务动词 + 可访问 URL + 无否定词 + 非建群请求。 */
const TASK_URL = /https?:\/\/[^\s，。！？?、）)]+/i
const POLITE = /^(?:(?:请|帮我|麻烦|顺便|再|又|另外|还有)\s*)*/u
const TASK_VERB = /^(?:修复|修一下|处理|跟进|建单|提单|排查|定位|复现|创建|新建|组建|成立|添加|新增|增加|生成|实现|开发|开始|启动|拉个|拉一?个|做(?:一)?个|写(?:一)?个)/u
const NEGATIVE = /(?:不要|别|无需|不用|不必|取消|先不|暂不)/u

/**
 * 只放行「修复bug单：https://…」「帮我实现 https://…」这类明确任务。
 * 「test1」「hello」「谢谢」「看看这个链接 https://…」都不命中 ⇒ 仍由模型判 ignore。
 */
export function explicitTask(trigger: Pick<Trigger, 'text' | 'human'>): boolean {
  if (!trigger.human) return false
  const text = trigger.text.replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!TASK_URL.test(text) || NEGATIVE.test(text) || GROUP_REQUEST.test(text)) return false
  return TASK_VERB.test(text.replace(POLITE, ''))
}
