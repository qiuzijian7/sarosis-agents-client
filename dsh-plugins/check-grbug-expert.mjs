#!/usr/bin/env node
// check-grbug-expert.mjs ★ GRBug 修复专家守卫（2026-11-09）
//
// 用户要求：从 TAPD bug 单驱动修复（读单 / 下载日志与 trace / 分析 / 修复 / HTML 报告 /
//   P4 new pending CL 用「复制源码关键字」命名），并内置一个 GRBug 修复专家。
//
// 为什么单独一道守卫：这个专家是**编排型**技能，最容易退化成「只有文档、没有可执行的脚本」，
//   或悄悄引入仓库里根本不存在的工具名（tapd_get_bug / trace_analyze / p4_new_cl）⇒ 模型照抄必失败。
//   所以守卫同时钉住：① 技能可加载且 tier 正确；② 四个脚本真跑 self-test；
//   ③ 六个阶段与真实命令在正文里；④ 缺口被显式声明、没有伪造工具名；⑤ 计数/版本/根链同步。
//
// 跑法：node dsh-plugins/check-grbug-expert.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const problems = []
const ok = (label, condition, detail = '') => {
	if (condition) { console.log(`  ✓ ${label}`) }
	else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); problems.push(label) }
}
const BUNDLE = 'dsh-plugins/vssaros-skill-bundle/skills/'
const SKILL = BUNDLE + 'grbug-fix-expert/'
const md = existsSync(join(ROOT, SKILL + 'SKILL.md')) ? read(SKILL + 'SKILL.md') : ''
const scripts = ['keyword.mjs', 'evidence.mjs', 'p4-cl.mjs', 'report.mjs']

console.log('check-grbug-expert：GRBug 修复专家（流程 + 可执行脚本）')

// ① 技能可加载、tier 不占 core 预算
{
	ok('① SKILL.md 存在且 name 与目录一致、description 带引号可解析',
		md.startsWith('---\n') && /^name: grbug-fix-expert$/m.test(md)
		&& /^description: "GRBug 修复专家/m.test(md) && /^---$/m.test(md))
	ok('① tier: extended（第 174 个技能不占常驻 40 条 core 预算）', /^tier: extended$/m.test(md))
	ok('① recommended_tools 只列真实工具名',
		/^recommended_tools: \["pwsh", "read", "write", "skill_search", "read_skill"\]$/m.test(md))
	ok('① 四个脚本都在技能目录里', scripts.every(f => existsSync(join(ROOT, SKILL + 'scripts/' + f))))
}

// ② 真跑 self-test（不是静态摆设）
{
	for (const f of scripts) {
		const r = spawnSync(process.execPath, [join(ROOT, SKILL + 'scripts/' + f), '--self-test'],
			{ cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } })
		let parsed = null
		try { parsed = JSON.parse((r.stdout ?? '').replace(/^\uFEFF/, '')); } catch { /* 下面判红 */ }
		ok(`② ${f} --self-test 真跑全绿`, r.status === 0 && !!parsed && parsed.ok === true && parsed.passed === parsed.cases,
			`exit=${r.status} ${String(r.stdout ?? '').trim().slice(0, 90)}`)
	}
	// ★ 报告脚本必须独立真跑（不信任它自己的 --self-test，脚本判据被改松时守卫要能发现）。
	//   直接 import 模块的 `render` 函数，不再起一个 `node -e` 子进程：
	//   · 少一次进程创建，也不受 check-spawn-hide「调用后 500 字符内要有 windowsHide」的窗口限制；
	//   · 判据与真机同源（就是 report.mjs 导出的那个函数）。
	const { render } = await import(pathToFileURL(join(ROOT, SKILL + 'scripts/report.mjs')).href)
	const html = render({ bug: '1281129', user: '邱子鉴',
		evidence: { items: [{ name: 'a.log', kind: 'log', ok: true, bytes: 3 }], manual: ['内网需人工导出'] },
		fix: { files: ['a.cpp'] }, changelist: 12345 })
	// ⚠ 必须按「第 7 节」切片判定：第 2 节的证据 warn div 也会输出同样的 manual 文案，
	//   只查整篇 includes('内网需人工导出') 会在「第 7 节的 limits 来源被删」时假绿。
	const section7 = html.slice(html.indexOf('7 · 已知限制'))
	ok('② report.mjs 独立渲染出含证据/限制/不提交说明的 HTML',
		html.includes('1281129') && html.includes('a.log') && html.includes('a.cpp')
		&& html.includes('p4 submit') && !html.includes('<script')
		&& section7.includes('内网需人工导出') && section7.includes('不推断结论'))
	// 端到端：解析真机样例关键字 → 生成 CL 描述 → 报告 HTML 含该描述
	const kw = spawnSync(process.execPath, [join(ROOT, SKILL + 'scripts/keyword.mjs'),
		'--bug=1281129 --user=邱子鉴 【Crash】【release】EXCEPTION_ACCESS_VIOLATION_WRITE ntdll.dll pc 0x48389 RtlTryAcquireSRWLockExclusive https://www.tapd.cn/68880148/s/5967448'],
		{ cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } })
	const parsed = (() => { try { return JSON.parse(kw.stdout ?? ''); } catch { return null; } })()
	ok('② 真机样例关键字解析出 bug/user/workspace 与 P4 CL 描述',
		!!parsed && parsed.ok === true && parsed.bug === '1281129' && parsed.user === '邱子鉴'
		&& parsed.workspace === '68880148' && parsed.crash === true
		&& parsed.description.startsWith('--bug=1281129 --user=邱子鉴'),
		String(kw.stdout ?? '').slice(0, 160))
}

// ③ 六个阶段与真实命令
{
	const stages = ['① 取单', '② 证据', '③ 根因', '④ 修复', '⑤ 生成 HTML 报告', '⑥ P4 checkout']
	ok('③ 正文覆盖六个阶段', stages.every(s => md.includes(s)))
	ok('③ 取单走 tapd-skill CLI（不是不存在的 tapd_get_bug 工具）',
		md.includes('tapd-api.mjs" get bug') && md.includes('raw GET /files/get_files'))
	ok('③ P4 走 guarded 白名单、保留 --bug= 关联、明确不 submit',
		md.includes('p4 change -o') && md.includes('p4 change -i') && md.includes('p4 edit -c')
		&& /绝不 `p4 submit`/.test(md) && md.includes('--bug=<id>'))
	ok('③ 脚本命令都用 <skillDir> 绝对路径（cwd 是会话工作区）',
		scripts.every(f => md.includes(`<skillDir>/scripts/${f}`)) && !/node scripts\//.test(md))
}

// ④ 能力缺口显式声明、不伪造工具名
{
	ok('④ 正文声明 CrashSight / trace 分析器 / 模型级工具的缺口',
		md.includes('无 CrashSight') && md.includes('.utrace') && md.includes('人工步骤')
		&& md.includes('无模型级'))
	// 这些名字只能出现在「无模型级 … 工具」这段缺口说明里，不能作为命令被调用。
	ok('④ 正文没有把不存在的工具名当命令调用',
		!/(?:node|调用|运行|执行)\s+`?(?:tapd_get_bug|trace_analyze|p4_new_cl)/.test(md)
		&& !/`(?:tapd_get_bug|trace_analyze|p4_new_cl)`\s*\(/.test(md)
		&& md.includes('均真实存在'))
	ok('④ 产物写会话工作区、不改 TAPD 状态、不提交代码',
		md.includes('不写技能目录') && md.includes('不提交代码') && md.includes('不改 TAPD 状态'))
}

// ⑤ 计数 / 版本 / 根链同步
{
	const tierGuard = read('dsh-plugins/check-skill-tier.mjs')
	const scopeGuard = read('dsh-plugins/check-skill-scope.mjs')
	const capGuard = read('dsh-plugins/check-capability-tools.mjs')
	ok('⑤ 技能计数守卫已同步到 174',
		/dirs\.length === 174/.test(tierGuard) && /library\.size === 174/.test(scopeGuard)
		&& /all\.total === 174/.test(capGuard))
	const pkg = JSON.parse(read('dsh-plugins/vssaros-skill-bundle/package.json'))
	ok('⑤ bundle 版本已 bump 且描述计数为 174', pkg.version >= '0.1.6'
		&& pkg.description.includes('174 built-in SKILL.md directories'))
	ok('⑤ 文档有流程梳理小节', read('doc/skill-authoring-standard.md').includes('10.x GRBug 修复专家'))
	ok('⑤ 守卫已接入根链', read('package.json').includes('node dsh-plugins/check-grbug-expert.mjs'))
	// ★ 2026-11-09：技能是 tier: extended，只靠 capability_search 才能找到。
	//   显式挂到 TAPD 专员 agent 的 skills ⇒ 绕过分级进它的常驻目录（partitionCatalog pinned）。
	//   TS 真源与 .agent.md 产物必须同时带这一项，否则 gen-builtin-agent-md --check / 单源测试会红。
	const builtinAgents = read('src/vs/sessions/contrib/agentStudio/common/builtinAgents.ts')
	const studioMd = read('resources/.agents/agents/saroasis-studio/.agent.md')
	ok('⑤ 真源把 grbug-fix-expert 显式点名给 saroasis-studio（TAPD 专员）',
		/skills:\s*\[[^\]]*'grbug-fix-expert'[^\]]*\]/.test(builtinAgents)
		&& /skills:[\s\S]{0,220}- grbug-fix-expert/.test(studioMd))
	ok('⑤ 点名的技能目录真实存在（不是空挂载）',
		existsSync(join(ROOT, SKILL + 'SKILL.md')))
	ok('⑤ 文档明确写出「已显式挂到 saroasis-studio」（不是别处碰巧提到该 agent）',
		read('doc/skill-authoring-standard.md').includes('**已显式挂到 `saroasis-studio`**'))
}

// ⑥ 反向突变（内存副本）：删掉脚本或改回伪造工具名 ⇒ 判据变红
{
	const hasStages = (src) => ['① 取单', '② 证据', '③ 根因', '④ 修复', '⑤ 生成 HTML 报告', '⑥ P4 checkout'].every(s => src.includes(s))
	ok('⑥ 反向突变基线全绿', hasStages(md))
	ok('⑥ 删掉 P4 阶段 ⇒ 判据变红', !hasStages(md.replace('⑥ P4 checkout', '⑥ (removed)')))
	// 正文里的脚本命令必须是 `node "<skillDir>/scripts/x.mjs"`；把占位符去掉就是裸相对路径 bug。
	// 判据与 ③ 同形：所有脚本都必须带占位符（少一个就红）。
	const hasAllAbsolute = (src) => scripts.every(f => src.includes(`<skillDir>/scripts/${f}`))
	const bare = md.split('<skillDir>/scripts/keyword.mjs').join('scripts/keyword.mjs')
	ok('⑥ 把脚本路径改成裸相对路径 ⇒ 判据变红',
		hasAllAbsolute(md) && bare !== md && !hasAllAbsolute(bare))
}

console.log(problems.length ? `\n✗ check-grbug-expert：${problems.length} 项失败` : '\n✓ check-grbug-expert：全部通过')
process.exitCode = problems.length ? 1 : 0
