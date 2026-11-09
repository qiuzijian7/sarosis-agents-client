#!/usr/bin/env node
// check-answer-link.mjs ★ 「去 XX 回答」不得产生空 href 外链（2026-11-09）
//
// 真机 bug：SuperAgent 执行页「去 superagent 回答」点开了一个 127.0.0.x 网页。
//   根因链：sources/superagent.ts 的 channel.link 返回 `url: ''`（主管对话没有外链）
//     → rows.tsx / ticket.tsx 把它交给 `<ActionLink href="" target="_blank">`
//     → 浏览器把空 href 解析成当前文档 URL（DSH Web UI 的 loopback 页）
//     → Electron 宿主 dshViewHost.ts 的 setWindowOpenHandler 把 target=_blank 交给 shell.openExternal
//     → 系统浏览器打开 127.0.0.1:<port>。
//
// 契约：
//   ① `ActionLink` 与 `ExternalLink` 对空 href 都必须渲染非 <a>（应用内按钮 / 纯文本）。
//   ② 回答按钮传 onActivate 切到「对话」页（应用内导航），飞书/GitHub 有真实外链仍是 <a>。
//   ③ Host 侧 superagent 的 url 保持空（不要试图填一个 127.0.0.1 URL，那仍会被外抛）。
//   ④ 运行 bundle 与 dev 源码同形（build --check 兜底）。
//   ⑤ 两处 UI 回归测试存在（列表行 + 工单详情页）。
//
// 跑法：node dsh-plugins/check-answer-link.mjs
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
const widgets = read(P + 'dev/src/client/widgets.tsx')
const rows = read(P + 'dev/src/client/rows.tsx')
const ticket = read(P + 'dev/src/client/ticket.tsx')
const locales = read(P + 'dev/src/client/locales.ts')
const hostSource = read(P + 'dev/src/sources/superagent.ts')
const bundle = read(P + 'lib/client.js')
const overview = read(P + 'dev/tests/panel-overview.spec.tsx')
const execSpec = read(P + 'dev/tests/panel-execution.spec.tsx')

console.log('check-answer-link：「去 XX 回答」空 href 不外抛')

// ① 组件层：空 href 不产生 <a>
{
	ok('① ActionLink 接受 onActivate 且空 href 渲染 button（带 in-app 标记）',
		/export function ActionLink\(\{ href, children, icon = 'external', onActivate \}/.test(widgets)
		&& /if \(!href\) \{[\s\S]{0,260}data-vssaros-in-app-action="1"/.test(widgets)
		&& /disabled=\{!onActivate\} onClick=\{onActivate\}/.test(widgets))
	ok('① ExternalLink 空 href 渲染 span（不是 <a>）',
		/if \(!href\) \{ return <span className="dt-inline-link dt-icon-link" data-vssaros-no-link="1">/.test(widgets))
	ok('① 有真实 href 时仍渲染 target=_blank 的 <a>（飞书/GitHub 行为不变）',
		/<a className="dt-btn dt-btn-outline dt-btn-sm" href=\{href\} \{\.\.\.external\}>/.test(widgets)
		&& /<a className="dt-inline-link dt-icon-link" href=\{href\} \{\.\.\.external\}>/.test(widgets))
}

// ② 两个调用点都传 onActivate 切到对话页
{
	ok('② 列表行 TicketLine 传 onActivate 切到 chat',
		/<ActionLink href=\{answer\.url\} icon="message" onActivate=\{\(\) => navigate\(\{ page: 'chat' \}\)\}/.test(rows))
	ok('② 工单详情 TicketPage 传 onActivate 切到 chat',
		/<ActionLink href=\{channel\.url\} icon="message" onActivate=\{\(\) => navigate\(\{ page: 'chat' \}\)\}/.test(ticket)
		&& /const \{ t, call, navigate \} = usePanel\(\)/.test(ticket))
	ok('② 主管对话文案已本地化（不再回退成裸 superagent）',
		/'source\.superagent': \['主管对话', 'Supervisor desk'\]/.test(locales))
}

// ③ Host 侧：url 保持空，且不能有人填 loopback 地址
{
	ok('③ Host 的 superagent channel.link 仍返回 url:\'\'（无站内 URL 可填）',
		/link: address => \(\{ url: ''/.test(hostSource))
	ok('③ 全链路任何地方都没有硬编码 127.0.0.1 / localhost 的 href',
		![widgets, rows, ticket, hostSource].some(src => /href=\{?["'`]?https?:\/\/(?:127\.0\.0\.1|localhost)/.test(src)))
}

// ④ bundle 同形
{
	// 用带引号的完整属性名（而不是裸子串）：`data-vssaros-in-app-action-REMOVED` 这种改名不该骗过判据。
	ok('④ 运行 bundle 里 ActionLink 也有空 href 兜底与 in-app 按钮',
		/"data-vssaros-in-app-action": "1"/.test(bundle)
		&& /"data-vssaros-no-link": "1"/.test(bundle)
		&& /"dt-btn dt-btn-outline dt-btn-sm"/.test(bundle))
	ok('④ build --check 在根链里', read('package.json').includes('vssaros-superagent/dev/scripts/build.mjs --check'))
}

// ⑤ 回归测试
{
	ok('⑤ 列表行与工单详情页各有一条真机回归断言',
		/answers a SuperAgent desk question in the app instead of opening a blank external link/.test(overview)
		&& /answers a SuperAgent desk question from the Ticket page/.test(execSpec)
		&& /not\.toContain\(''\)/.test(overview) && /data-vssaros-in-app-action/.test(overview))
	ok('⑤ 守卫已接入根链', read('package.json').includes('node dsh-plugins/check-answer-link.mjs'))
}

// ⑥ 反向突变（内存副本）
{
	const guarded = (src) => /if \(!href\) \{[\s\S]{0,260}data-vssaros-in-app-action="1"/.test(src)
		&& /if \(!href\) \{ return <span/.test(src)
	ok('⑥ 反向突变基线全绿', guarded(widgets))
	const noGuard = widgets.replace('if (!href) {\n    return <button type="button" className="dt-btn dt-btn-outline dt-btn-sm" data-vssaros-in-app-action="1"', 'if (false) {\n    return <button')
	ok('⑥ 去掉 ActionLink 空 href 兜底 ⇒ 判据变红', noGuard !== widgets && !guarded(noGuard))
	const broken = rows.replace('onActivate={() => navigate({ page: \'chat\' })}', '')
	ok('⑥ 列表行不传 onActivate ⇒ 判据变红', broken !== rows
		&& !/onActivate=\{\(\) => navigate\(\{ page: 'chat' \}\)\}/.test(broken))
}

console.log(problems.length ? `\n✗ check-answer-link：${problems.length} 项失败` : '\n✓ check-answer-link：全部通过')
process.exitCode = problems.length ? 1 : 0
