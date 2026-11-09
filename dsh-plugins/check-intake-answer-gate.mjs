#!/usr/bin/env node
// check-intake-answer-gate.mjs ★ 待人回答工单的「回答闸门」守卫（2026-11-09）
//
// 真机：主管台所有消息共用一个 desk Thread，工单创建时订阅它 ⇒ 一条全新的请求
//   （「添加一个测试专家」）也会被扇出给「待人回答」的旧工单（「打开 cartoon.hml 文件」），
//   回执先说「已转给正在做的工单…」，worker 之后才 handback 退回重评。
//
// 契约：
//   ① `awaitingAnswer(ticket)` 覆盖两种待人回答形态：blocked/failed 报告 与 未回答的 attention。
//   ② `looksLikeAnswer(text)` 保守：只排除明确的新工作 / 建群 / @群命令，其余一律当成回答。
//   ③ `Intake.receive` 在订阅扇出循环里，对 human 且待人回答的工单应用闸门 ⇒ 不进 fanout ⇒ Eval。
//   ④ 判据只在 core 层（不反向依赖 app/groupFastPath），bot/CI 与已结束工单不受影响。
//   ⑤ 运行 bundle 与 dev 源码同形；根链、测试、文档都在位。
//
// 跑法：node dsh-plugins/check-intake-answer-gate.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const problems = []
const ok = (label, condition, detail = '') => {
	if (condition) { console.log(`  ✓ ${label}`) }
	else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); problems.push(label) }
}
const P = 'dsh-plugins/vssaros-superagent/'
const intake = read(P + 'dev/src/core/intake.ts')
const bundle = read(P + 'lib/index.js')
const coreSpec = read(P + 'dev/tests/core-engine.spec.ts')
const deskSpec = read(P + 'dev/tests/superagent-desk.spec.ts')

console.log('check-intake-answer-gate：待人回答工单只接回答，新请求交回 Eval')

// ① 两种待人回答形态
{
	ok('① awaitingAnswer 同时覆盖 waitsForPerson 与 ticket.attention',
		/export const awaitingAnswer = \(ticket: Ticket\): boolean =>\s*\n?\s*!ticket\.ended && \(!!ticket\.attention \|\| waitsForPerson\(ticket\)\)/.test(intake))
	ok('① core 层只从 model.ts 引入 waitsForPerson（不反向依赖 app/groupFastPath）',
		/import \{ isoTime, liveTicket, threadKey, waitsForPerson \} from '\.\/model\.ts'/.test(intake)
		&& !/from '\.\.\/app\//.test(intake))
}

// ② 判据保守
{
	ok('② looksLikeAnswer 排除 @群命令 / 新工作动词 / 建群请求，其余放行',
		/export function looksLikeAnswer\(text: string\): boolean/.test(intake)
		&& /body\.startsWith\('@'\)/.test(intake) && /NEW_WORK\.test\(body\)/.test(intake)
		&& /GROUP_REQUEST\.test\(body\)/.test(intake) && /return true\s*\}/.test(intake))
	ok('② 礼貌前缀可连用（请帮我新建一个… 必须被识别为新请求）',
		/\(\?:\(\?:请\|帮我\|麻烦\|顺便\|再\|又\|另外\|还有\)\\s\*\)\*/.test(intake))
	// 真机两条：添加一个测试专家 / 创建一个 … 开发团队。动词表被删掉时守卫要能独立拦住。
	ok('② 新工作动词表含 创建/添加/新建/组建/成立（真机样例）',
		/const NEW_WORK = \/\^.*创建\|新建\|组建\|成立\|添加\|新增/u.test(intake)
		&& /const GROUP_REQUEST = .*群\|团队/u.test(intake))
}

// ③ 闸门接在扇出循环里
{
	ok('③ Intake.receive 的订阅循环对 human + 待人回答 + 不像回答的消息跳过 fanout',
		/if \(trigger\.human && !followed && awaitingAnswer\(ticket\) && !looksLikeAnswer\(trigger\.text\)\) continue/.test(intake))
	ok('③ 闸门位于 reached.set 之前（否则 fanout 里仍有这张工单）',
		intake.indexOf('looksLikeAnswer(trigger.text)) continue') > 0
		&& intake.indexOf('looksLikeAnswer(trigger.text)) continue') < intake.indexOf('reached.set(ticketId'))
	ok('③ queueForEval 仍在（owners 为空时新请求走 Eval）',
		/if \(!this\.owners\(trigger\)\.length\) this\.queueForEval\(trigger\)/.test(intake))
}

// ④ 测试覆盖
{
	ok('④ core-engine.spec.ts 有纯函数与端到端判据测试',
		coreSpec.includes("describe('intake answer gate (2026-11-09)'")
		&& coreSpec.includes("expect(looksLikeAnswer('添加一个测试专家')).toBe(false)")
		&& coreSpec.includes("expect(h.repo.triggers.disposition('2')).toMatchObject({ fanout: [] })"))
	ok('④ superagent-desk.spec.ts 有真机形态的端到端回归（attention + 回执）',
		deskSpec.includes('keeps a new desk request out of a ticket awaiting an answer')
		&& deskSpec.includes('添加一个测试专家') && deskSpec.includes('已收到，正在按普通流程安排'))
	ok('④ 测试覆盖真回答不误伤 / bot 不受影响 / 已结束工单不受影响',
		coreSpec.includes('是 pomodoro-h5 里的 cartoon.html') && coreSpec.includes('does not gate bot/CI messages')
		&& coreSpec.includes('only gates a ticket that is actually awaiting a person'))
}

// ⑤ build / 文档 / 根链
{
	ok('⑤ 运行 bundle 与真源同形（判据已编进 lib）',
		/looksLikeAnswer|awaitingAnswer/.test(bundle))
	ok('⑤ build --check 在根链里', read('package.json').includes('vssaros-superagent/dev/scripts/build.mjs --check'))
	ok('⑤ 守卫已接入根链', read('package.json').includes('node dsh-plugins/check-intake-answer-gate.mjs'))
}

// ⑥ 反向突变（内存副本）
{
	const hasGate = src => /if \(trigger\.human && !followed && awaitingAnswer\(ticket\) && !looksLikeAnswer\(trigger\.text\)\) continue/.test(src)
	ok('⑥ 反向突变基线全绿', hasGate(intake))
	ok('⑥ 摘掉闸门 ⇒ 判据变红', !hasGate(intake.replace(
		'if (trigger.human && !followed && awaitingAnswer(ticket) && !looksLikeAnswer(trigger.text)) continue', 'void 0')))
	ok('⑥ attention 从 awaitingAnswer 里去掉 ⇒ 判据变红',
		!/\!ticket\.ended && \(!!ticket\.attention \|\| waitsForPerson\(ticket\)\)/.test(
			intake.replace('!!ticket.attention || waitsForPerson(ticket)', 'waitsForPerson(ticket)')))
}

console.log(problems.length ? `\n✗ check-intake-answer-gate：${problems.length} 项失败` : '\n✓ check-intake-answer-gate：全部通过')
process.exitCode = problems.length ? 1 : 0
