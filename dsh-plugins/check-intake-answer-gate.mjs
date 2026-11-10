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
const model = read(P + 'dev/src/core/model.ts')
const tickets = read(P + 'dev/src/core/tickets.ts')
const bundle = read(P + 'lib/index.js')
const coreSpec = read(P + 'dev/tests/core-engine.spec.ts')
const deskSpec = read(P + 'dev/tests/superagent-desk.spec.ts')
const groupRequest = read(P + 'dev/src/core/group-request.ts')
const feishuSource = read('dsh-plugins/vssaros-superagent/dev/src/sources/feishu.ts')
const ticketNotices = read('dsh-plugins/vssaros-superagent/dev/src/app/ticket-notices.ts')
const runtimeSource = read('dsh-plugins/vssaros-superagent/dev/src/app/runtime.ts')
const fastPath = read(P + 'dev/src/app/groupFastPath.ts')

console.log('check-intake-answer-gate：待人回答工单只接回答，新请求交回 Eval')

// ① 两种待人回答形态
{
	ok('① awaitingAnswer 在 core 叶子 model.ts 统一定义，覆盖两种待人回答形态',
		/export const awaitingAnswer = \(ticket: Ticket\): boolean =>\s*\n?\s*!ticket\.ended && \(!!ticket\.attention \|\| waitsForPerson\(ticket\)\)/.test(model))
	// ★ 2026-11-10（框架质量评估建议 3）：扇出闸门与 addInput 不再各判一半。
	ok('① intake.ts 与 tickets.ts 共用同一 awaitingAnswer（attention 形态不再漏判）',
		/import \{ awaitingAnswer, isoTime, liveTicket, threadKey \} from '\.\/model\.ts'/.test(intake)
		&& /export \{ awaitingAnswer \}/.test(intake)
		&& /const held = liveTicket\(ticket\) && automatic\(input\) && awaitingAnswer\(ticket\)/.test(tickets)
		&& /!awaitingAnswer\(ticket\) && !staffing\(ticket\)/.test(tickets)
		&& !/waitsForPerson\(ticket\)/.test(tickets))
	ok('① core 层不反向依赖 app/groupFastPath',
		!/from '\.\.\/app\//.test(intake) && !/from '\.\.\/app\//.test(model))
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
		&& /export const GROUP_REQUEST = .*群\|团队/u.test(groupRequest))
	// ★ 2026-11-10（建议 3）：正则原先在 intake.ts 与 groupFastPath.ts 各存一份且语义已可漂移。
	ok('② 建群判据单一真源：两处都从 core/group-request.ts 导入，不再各自硬编码',
		/from '\.\/group-request\.ts'/.test(intake)
		&& /from '\.\.\/core\/group-request\.ts'/.test(fastPath)
		&& !/\[\^，,。！!？?\]\{0,48\}/.test(intake)
		&& !/\[\^，,。！!？?\]\{0,48\}/.test(fastPath)
		&& /GROUP_REQUEST\.test\(body\)/.test(intake)
		&& /return GROUP_REQUEST\.test\(body\)/.test(fastPath))
}

// ③ 闸门接在扇出循环里
{
	ok('③ Intake.receive 的订阅循环对 human + 待人回答 + 不像回答的消息跳过 fanout',
		/if \(trigger\.human && !followed && awaitingAnswer\(ticket\) && !looksLikeAnswer\(trigger\.text\)\) continue/.test(intake))
	ok('③ 闸门位于 reached.set 之前（否则 fanout 里仍有这张工单）',
		intake.indexOf('looksLikeAnswer(trigger.text)) continue') > 0
		&& intake.indexOf('looksLikeAnswer(trigger.text)) continue') < intake.indexOf('reached.set(ticketId'))
	// ★ 2026-11-10：owners 抽成变量供回执复用，判据同步（仍是「没有工单接住 ⇒ 走 Eval」）。
	ok('③ queueForEval 仍在（owners 为空时新请求走 Eval）',
		/const owners = this\.owners\(trigger\)/.test(intake)
		&& /if \(!owners\.length\) this\.queueForEval\(trigger\)/.test(intake))
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
	ok('④ core-engine.spec.ts 有 addInput 共用判据的行为用例（attention 形态）',
		coreSpec.includes('shares awaitingAnswer between the intake gate and addInput')
		&& coreSpec.includes('expect(waitsForPerson(ticket)).toBe(false)'))
	ok('④ 测试覆盖真回答不误伤 / bot 不受影响 / 已结束工单不受影响',
		coreSpec.includes('是 pomodoro-h5 里的 cartoon.html') && coreSpec.includes('does not gate bot/CI messages')
		&& coreSpec.includes('only gates a ticket that is actually awaiting a person'))
}

// ⑤ build / 文档 / 根链
{
	ok('⑤ 运行 bundle 与真源同形（判据已编进 lib）',
		/looksLikeAnswer|awaitingAnswer/.test(bundle))
	// ★ 2026-11-10（建议 4）：只读 bundle 的守卫在「改了 TS 没 rebuild」时会假绿。
	//   关键符号必须在 dev 与 bundle 两边都在；根本保障仍是 build.mjs --check 的哈希比对。
	// 用词边界而非裸 includes：改名成 awaitingAnswerXxx 也应判红。
	ok('⑤ dev↔bundle 同形：闸门关键符号两边都在（防只改 TS 不 rebuild）',
		['awaitingAnswer', 'looksLikeAnswer', 'NEW_WORK', 'GROUP_REQUEST']
			.every(mark => new RegExp(`\\b${mark}\\b`).test(intake) && new RegExp(`\\b${mark}\\b`).test(bundle))
		&& /ticket\.attention/.test(model) && /ticket\.attention/.test(bundle))
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
			model.replace('!!ticket.attention || waitsForPerson(ticket)', 'waitsForPerson(ticket)')))
	ok('⑥ tickets.ts 退回 waitsForPerson ⇒ 判据变红',
		!/const held = liveTicket\(ticket\) && automatic\(input\) && awaitingAnswer\(ticket\)/.test(
			tickets.replace('automatic(input) && awaitingAnswer(ticket)', 'automatic(input) && waitsForPerson(ticket)')))
}

console.log(problems.length ? `\n✗ check-intake-answer-gate：${problems.length} 项失败` : '\n✓ check-intake-answer-gate：全部通过')
// ⑦ 收到回执（2026-11-10 用户：飞书发消息后要给一个反馈）
{
	ok('⑦ 收到人的消息先回执：来源给文案才发，且用 key(\'received\') 不撞接单回执',
		/const owners = this\.owners\(trigger\)/.test(intake)
		&& /filter\.receipt/.test(intake)
		&& /key\('received', trigger\.id\)/.test(intake)
		&& /kind: 'notice'/.test(intake)
		// 飞书侧提供文案，且只对私聊 / 群内 @ 机器人返回（listen:'all' 的群不刷屏）
		&& /const RECEIPT = '已收到，正在处理…'/.test(feishuSource)
		&& /row: 'direct', receipt: RECEIPT/.test(feishuSource)
		&& /meta\.mentioned === true \? \{ receipt: RECEIPT \}/.test(feishuSource))
	ok('⑦ 回执只给「没有工单接住、即将进评估」的消息（回答既有工单不重复确认）',
		/if \(trigger\.human && trigger\.channel && filter\.receipt && !owners\.length\)/.test(intake))
}

// ⑧ 工单结束把结果发回飞书（2026-11-10 用户：执行结束后把结果返回飞书）
{
	ok('⑧ 范围：只对 feishu channel 发，不重复 github/p4 的终态通知',
		/export function ticketResultNotices\(ticket: Ticket\)/.test(ticketNotices)
		&& /channel\.source === FEISHU/.test(ticketNotices)
		// 只看 import：注释里说明「不重复 github/p4 的终态通知」是正常的。
		&& !/from '\.\/(github-pull|p4-change)\.ts'/.test(ticketNotices))
	ok('⑧ 幂等：notice id 带 ended.at 与 thread，复活后再结束才会再发',
		/\$\{TICKET_RESULT_NOTICE\}:\$\{ticket\.id\}:\$\{view\.at\}:\$\{channel\.thread\}/.test(ticketNotices))
	ok('⑧ 结果文本复用 receiptView（title + outcome + report.summary，缺 summary 用 ended.reason）',
		/receiptView\(ticket\)/.test(ticketNotices)
		&& /【工单结束】/.test(ticketNotices))
	ok('⑧ runtime 在 ticket.ended 分支真的发出去',
		/for \(const message of ticketResultNotices\(ended\)\) outbox\.send\(message\)/.test(runtimeSource))
}

process.exitCode = problems.length ? 1 : 0
