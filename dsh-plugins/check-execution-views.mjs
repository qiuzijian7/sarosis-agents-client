#!/usr/bin/env node
// check-execution-views.mjs ★ 「流程图 / 看板 / 列表」归属「执行」页签守卫（2026-11-09）
//
// 用户要求：SuperAgent 的这三个团队视图应该在执行页签内，不再是独立的 work 页面。
// 背景：2026-11-07 移除了顶栏 `work` 页签，但它的页面还留在 `work` 路由里 ⇒ 从概况侧栏
//   「查看流程」点进去时没有任何页签被选中，看起来像挂在「对话」下面的孤儿页。
//
// 契约：
//   ① `parseRoute` 把历史 `work` 深链（含 ticket）归一到 execution；execution 保留 ticket。
//   ② 执行页的 ExecutionStatus 内嵌 WorkPage，且原有状态 / 用量 / 审批 / 工单列表不丢。
//   ③ WorkPage 用 embedded 避免与执行页的 GroupRuns compact 重复轮询。
//   ④ 概况侧栏的深链直接指 execution；NAV_TABS 仍是 6 个页签、其中没有 work。
//   ⑤ 构建产物与真源同形（build --check 兜底）。
//
// 跑法：node dsh-plugins/check-execution-views.mjs
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
const route = read(P + 'dev/src/client/route.ts')
const app = read(P + 'dev/src/client/app.tsx')
const exec = read(P + 'dev/src/client/execution.tsx')
const work = read(P + 'dev/src/client/work.tsx')
const team = read(P + 'dev/src/client/team-plans.tsx')
const bundle = read(P + 'lib/client.js')
const spec = read(P + 'dev/tests/panel-work.spec.tsx')

console.log('check-execution-views：三视图归属「执行」页签')

// ① 路由归一
{
	ok('① work 深链归一到 execution 且带 ticket',
		/case 'work': return \{ page: 'execution', query: compact\(\{ ticket: text\('ticket'\) \}\) \}/.test(route))
	ok('① execution 的 query 类型与解析都保留 ticket',
		/query\?: \{ filter\?: TicketFilter; ticket\?: string \}/.test(route)
		&& /case 'execution': return record \?[\s\S]{0,180}ticket: text\('ticket'\)/.test(route))
	ok('① NAV_TABS 仍过滤掉 work（顶栏不出现独立工作台页签）',
		/NAV_TABS: readonly Tab\[\] = TABS\.filter\(tab => tab !== 'work'\)/.test(route))
}

// ② 执行页内嵌三视图，且原有内容保留
{
	ok('② ExecutionStatus 接收 ticketId 并内嵌 WorkPage embedded',
		/export function ExecutionStatus\(\{ filter: current, state, reload, ticketId \}/.test(exec)
		&& /<WorkPage key=\{ticketId\} ticketId=\{ticketId\} embedded \/>/.test(exec))
	ok('② 执行页原有的状态 / 用量 / 审批 / 工单列表都还在',
		['<StatusHead', '<UsagePanel', '<ApprovalRulesPanel', 'TICKET_FILTERS.map', '<TicketLine'].every(k => exec.includes(k)))
	ok('② app.tsx 的 execution / work 都渲染同一个执行页（无独立 WorkPage 分支）',
		!/\bWorkPage\b/.test(app)
		&& /case 'work': return state \? <ExecutionStatus/.test(app)
		&& /case 'execution': return route\.id !== undefined \? <TicketPage[\s\S]{0,160}<ExecutionStatus/.test(app))
}

// ③ embedded 去重
{
	ok('③ WorkPage 支持 embedded 且跳过自己的 GroupRuns',
		/export function WorkPage\(\{ ticketId, embedded = false \}/.test(work)
		&& /const groupRuns = embedded \? null : <GroupRuns \/>/.test(work))
	ok('③ 三视图按钮仍在 WorkPage 内（flow / board / list）',
		/items=\{\(\['flow', 'board', 'list'\] as const\)/.test(work))
}

// ④ 深链与构建产物
{
	ok('④ 概况侧栏「查看流程」直接指 execution 并带 ticket',
		/navigate\(\{ page: 'execution', query: \{ ticket: team\.ticket\.id \} \}\)/.test(team)
		&& !/navigate\(\{ page: 'work'/.test(team))
	ok('④ 运行 bundle 与真源同形（work 归一 + 内嵌）',
		bundle.includes('case "execution"') && bundle.includes('ticketId:') && !/dt-tab-work/.test(bundle))
	ok('④ build --check 在根链里', read('package.json').includes('vssaros-superagent/dev/scripts/build.mjs --check'))
}

// ⑤ 测试覆盖
{
	ok('⑤ panel-work 断言执行页签被选中且执行页原有状态还在',
		/tab\(zh\['tab\.execution'\]\)\.getAttribute\('aria-selected'\)\)\.toBe\('true'\)/.test(spec)
		&& /\.dt-status-title/.test(spec))
	ok('⑤ navigation 断言 work 归一与 ticket 透传',
		/normalizes a stored Workbench link to the Execution tab/.test(read(P + 'dev/tests/navigation.spec.ts')))
	ok('⑤ 守卫已接入根链', read('package.json').includes('node dsh-plugins/check-execution-views.mjs'))
}

// ⑥ 反向突变（内存副本）
{
	const hasEmbedded = (src) => /<WorkPage key=\{ticketId\} ticketId=\{ticketId\} embedded \/>/.test(src)
	ok('⑥ 反向突变基线全绿', hasEmbedded(exec))
	ok('⑥ 去掉内嵌 WorkPage ⇒ 判据变红', !hasEmbedded(exec.replace('<WorkPage key={ticketId} ticketId={ticketId} embedded />', 'void 0')))
	const broken = route.replace("case 'work': return { page: 'execution'", "case 'work': return { page: 'chat'")
	ok('⑥ work 深链不再归一 ⇒ 判据变红', broken !== route
		&& !/case 'work': return \{ page: 'execution'/.test(broken))
}

console.log(problems.length ? `\n✗ check-execution-views：${problems.length} 项失败` : '\n✓ check-execution-views：全部通过')
process.exitCode = problems.length ? 1 : 0
