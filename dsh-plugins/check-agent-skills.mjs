// @vssaros/dsh-plugins — 技能承接与 agent 绑定守卫（2026-11-08 P0）
//
// 跑法：node dsh-plugins/check-agent-skills.mjs
//
// 钉住五件事（任何一条被改坏都要红），并自带**反向突变自检**：把实现里的关键行临时改坏，
// 断言守卫确实会报红（不是"永远绿"的假守卫）。反向突变在内存中的源码副本上跑，不碰磁盘。
//
//   ① 名字真实性：builtinAgents.ts 里 agent 的 skills[] 必须指向真实存在的技能目录；
//   ② 绑定生效：skills:[] 变成 provider.list() 的可见子集，且 owner: bot:<other> 被隔离；
//   ③ 一份清单：<available_skills> 只出现一次、同一技能不出现两行、always 摘要行在清单内；
//   ④ 预算：always 摘要行逐行受 planCatalogLines 限制，超出必须明说（note 而不是静默丢）；
//   ⑤ 退役不回潮：不 import IDE 侧 skillInjectionBudget.ts、不写 @ISkillRegistry 注入。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')
const read = rel => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const problems = []
const ok = (label, condition, detail = '') => {
	if (condition) { console.log(`  ✓ ${label}`); }
	else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); problems.push(label); }
}

const SKILLS = 'dsh-plugins/vssaros-skills'
const indexSrc = read(`${SKILLS}/lib/index.js`)
const coreSrc = read(`${SKILLS}/lib/core/skills.js`)
const budgetSrc = read(`${SKILLS}/lib/core/skillBudget.js`)
const agentSrc = read(`${SKILLS}/lib/core/agentSkills.js`)
const patchSrc = read(`${SKILLS}/cordis.patch.yml`)
const pkg = JSON.parse(read(`${SKILLS}/package.json`))

// 纯函数走动态 import（守卫与实现同源，不复制口径）
const mod = async rel => await import(pathToFileURL(join(ROOT, rel)).href)
const budget = await mod(`${SKILLS}/lib/core/skillBudget.js`)
const agents = await mod(`${SKILLS}/lib/core/agentSkills.js`)
const core = await mod(`${SKILLS}/lib/core/skills.js`)

console.log('check-agent-skills：技能承接与 agent 绑定（P0）')

// ── ① 名字真实性 ───────────────────────────────────────────────────────────
{
	const bundled = join(ROOT, 'dsh-plugins/vssaros-skill-bundle/skills')
	const dirs = new Set()
	if (existsSync(bundled)) {
		for (const e of readdirSync(bundled, { withFileTypes: true })) { if (e.isDirectory()) { dirs.add(e.name); } }
	}
	// 插件自带 skills/ 也算（与 check-agent-tools.mjs 判据 B 同口径）
	for (const plugin of ['vssaros-skills', 'vssaros-agents']) {
		const p = join(ROOT, 'dsh-plugins', plugin, 'skills')
		if (!existsSync(p)) { continue; }
		for (const e of readdirSync(p, { withFileTypes: true })) { if (e.isDirectory()) { dirs.add(e.name); } }
	}
	const builtin = read('src/vs/sessions/contrib/agentStudio/common/builtinAgents.ts')
	const lists = [...builtin.matchAll(/skills:\s*\[([^\]]*)\]/g)].map(m => m[1])
	const named = lists.flatMap(block => [...block.matchAll(/['"]([a-z0-9][a-z0-9-]*)['"]/g)].map(m => m[1]))
	const missing = [...new Set(named)].filter(name => !dirs.has(name))
	ok('① builtinAgents.ts 的 skills[] 都指向真实技能目录', dirs.size > 0 && missing.length === 0,
		`随包 ${dirs.size} 个；缺失：${missing.join(', ') || '无'}`)
}

// ── ② 绑定生效（纯函数 + 静态接线双保险）─────────────────────────────────
{
	ok('② preset id → agent id', agents.agentIdOfPreset('vssaros-coder') === 'coder'
		&& agents.agentIdOfPreset('standard') === '' && agents.agentIdOfPreset('') === '')
	ok('② .agent.md 的 skills: 逗号串与块列表都认', (() => {
		const a = agents.skillsOfAgentMd('---\nname: X\nskills: anysearch, analysis\n---\nbody')
		const b = agents.skillsOfAgentMd('---\nname: X\nskills:\n  - anysearch\n  - analysis\n---\nbody')
		return JSON.stringify(a) === '["anysearch","analysis"]' && JSON.stringify(b) === '["anysearch","analysis"]'
	})())
	ok('② owner: bot:<id> 顶层与 metadata: 下都认', agents.ownerBotOfSkillMd('---\nowner: bot:tester\n---\nx') === 'tester'
		&& agents.ownerBotOfSkillMd('---\nmetadata:\n  owner: "bot:designer"\n---\nx') === 'designer'
		&& agents.ownerBotOfSkillMd('---\nname: x\n---\nbody') === '')
	const all = [
		{ name: 'anysearch' }, { name: 'analysis' },
		{ name: 'tester-only', owner: 'bot:tester' }, { name: 'designer-only', owner: 'bot:designer' },
	]
	const a = agents.filterSkillsForAgent(all, ['anysearch'], 'coder')
	const b = agents.filterSkillsForAgent(all, null, 'coder')
	const c = agents.filterSkillsForAgent(all, null, 'tester')
	ok('② 声明 skills[] ⇒ 只出子集；未声明 ⇒ 全量但排除别人的归属技能',
		JSON.stringify(a.map(x => x.name)) === '["anysearch"]'
		&& JSON.stringify(b.map(x => x.name)) === '["anysearch","analysis"]'
		&& c.some(x => x.name === 'tester-only') && !c.some(x => x.name === 'designer-only'),
		JSON.stringify({ a: a.map(x => x.name), b: b.map(x => x.name), c: c.map(x => x.name) }))
	ok('② skillSubsetFor 无 scope 时不收窄', agents.skillSubsetFor({}, '/nonexistent') === null
		&& agents.skillSubsetFor({ scope: { session: { header: { agentPreset: 'standard' } } } }, '/nonexistent') === null)
	ok('② provider.list() 在 toCandidate 之前过滤（静态）', (() => {
		const i = indexSrc.indexOf('async list(options)')
		const filter = indexSrc.indexOf('filterSkillsForAgent', i)
		const map = indexSrc.indexOf('.map(toCandidate)', i)
		return i >= 0 && filter > i && map > filter
	})(), 'filterSkillsForAgent 必须在 map(toCandidate) 之前')
	ok('② 缺省全量语义未被破坏（subset=null 分支）', agentSrc.includes('return names.length ? names : null')
		&& indexSrc.includes('skillSubsetFor(options, dataRootOf(config))'))
}

// ── ③ 一份清单 ─────────────────────────────────────────────────────────────
{
	const catalogCount = (indexSrc.match(/'<available_skills>'/g) || []).length
	ok('③ <available_skills> 只构造一处', catalogCount === 1, `count=${catalogCount}`)
	ok('③ 一条 user 消息（不再各发一条）', (() => {
		const i = indexSrc.indexOf('const ensureSkillCatalog')
		const j = indexSrc.indexOf('const autoloadHandler')
		const body = indexSrc.slice(i, j)
		return (body.match(/createUserMessage\(/g) || []).length === 1
	})())
	ok('③ 同一技能不出现两行（always 行替换普通行，不是追加）', (() => {
		// P2 把 catalog 的条目从 `entries` 收窄成 `listed`（core 子集）⇒ 断言只查不变量：
		//   常驻技能排前、其余排后，且清单块里没有把未经预算的条目又铺一遍。
		const hasOrdered = /\.\.\.\w+\.filter\(entry => alwaysNames\.has\(entry\.name\)\)/.test(indexSrc)
		const hasRest = /\.\.\.\w+\.filter\(entry => !alwaysNames\.has\(entry\.name\)\)/.test(indexSrc)
		const i = indexSrc.indexOf("'<available_skills>'")
		const j = indexSrc.indexOf("'</available_skills>'")
		const block = i >= 0 && j > i ? indexSrc.slice(i, j) : ''
		return hasOrdered && hasRest && block.length > 0
			&& !block.includes('...entries.map(') && !block.includes('...listed.map(')
	})())
	ok('③ owner 归属标记进技能记录（否则隔离拿不到数据）', coreSrc.includes('...(owner ? { owner } : {})')
		&& indexSrc.includes('owner: skill.owner'))
	ok('③ always 摘要行在同一清单内、带常驻标记', core.catalogSummaryLine({ name: 'be-concise', description: '保持简短 <b>' }, { always: true })
		=== '- `be-concise`（常驻·每轮生效）: 保持简短 &lt;b&gt;'
		&& indexSrc.includes("catalogSummaryLine(entry, { always: true })"))
	ok('③ 全文链路仍是显式特例，不是第二份清单', patchSrc.includes('skillAutoload:')
		&& patchSrc.includes('唯一的全文特例') && !patchSrc.includes('根本不生效'))
}

// ── ④ 预算 ─────────────────────────────────────────────────────────────────
{
	const lines = Array.from({ length: 10 }, (_, i) => `x`.repeat(60) + i)
	const full = budget.planCatalogLines(lines, 10_000)
	const cut = budget.planCatalogLines(lines, 150)
	ok('④ 清单预算：不超限时全保留', full.kept.length === 10 && full.omitted === 0)
	// P2 把「超出预算」的提示合并进 extendedHint（同时覆盖 extended 折叠与预算降级）⇒ 查两处任一
	ok('④ 清单预算：超限降级且明说 omitted', cut.kept.length < 10 && cut.omitted === 10 - cut.kept.length
		&& (budgetSrc.includes('超出清单预算') || indexSrc.includes('超出清单预算') || indexSrc.includes('extendedHint(')))
	ok('④ 单条/总量边界与 skill_context 同源', budget.SKILL_BODY_MAX === 4000 && budget.SKILL_TOTAL_MAX === 20000
		&& indexSrc.includes('Math.min(SKILL_BODY_MAX, budget)') && !indexSrc.includes('Math.min(4000, budget)'))
	ok('④ 正文预算贪心且排序确定', (() => {
		const plan = budget.planSkillInjections([
			{ skill: { id: 'b' }, priority: 1, contentChars: 10 },
			{ skill: { id: 'a' }, priority: 1, contentChars: 10 },
			{ skill: { id: 'z' }, priority: 0, contentChars: 10 },
		], { maxFullSkills: 2, maxPromptChars: 20 })
		return JSON.stringify(plan.full.map(s => s.id)) === '["z","a"]' && plan.summary.length === 1
	})())
	ok('④ 降级说明不为空', budget.buildSkillBudgetNote(2).includes('2 skill(s)') && budget.buildSkillBudgetNote(0) === '')
	ok('④ 预算常量与 IDE 侧退役实现同值（算法复用，不是接线）',
		budget.DEFAULT_SKILL_BUDGET.maxFullSkills === 10 && budget.DEFAULT_SKILL_BUDGET.maxPromptChars === 48000
		&& budgetSrc.includes('planSkillInjections'))
}

// ── ⑤ 退役不回潮 ───────────────────────────────────────────────────────────
{
	const ideBudget = read('src/vs/sessions/contrib/agentStudio/common/skillInjectionBudget.ts')
	ok('⑤ 不 import IDE 侧 skillInjectionBudget', !/from\s+['"][^'"]*skillInjectionBudget/.test(indexSrc + coreSrc + budgetSrc + agentSrc))
	ok('⑤ 不写 @ISkillRegistry 注入', !/^\s*@ISkillRegistry\b/m.test(indexSrc + budgetSrc + agentSrc))
	ok('⑤ IDE 侧纯函数仍原样（没被搬走/接回）', ideBudget.includes('export function planSkillInjections') && ideBudget.includes('DEFAULT_SKILL_BUDGET'))
	ok('⑤ chatEngine 仍是唯一 dsh', /chatEngine/.test(read('dsh-plugins/check-ide-agent-loop-retirement.mjs')))
}

// ── 清单/版本/链 ───────────────────────────────────────────────────────────
{
	ok('新模块进 package.json files 白名单', ['lib/core/skillBudget.js', 'lib/core/agentSkills.js']
		.every(f => Array.isArray(pkg.files) && pkg.files.includes(f)))
	const agentsPkg = JSON.parse(read('dsh-plugins/vssaros-agents/package.json'))
	// 版本只要求「不低于 P0 落地时的基线」：后续 P1/P2 还会继续 bump，别把守卫写成一次性快照
	const atLeast = (current, floor) => {
		const a = String(current).split('.').map(Number), b = String(floor).split('.').map(Number)
		for (let i = 0; i < 3; i += 1) { if ((a[i] ?? 0) !== (b[i] ?? 0)) { return (a[i] ?? 0) > (b[i] ?? 0); } }
		return true
	}
	ok('版本已 bump（同版本 plugin add 会短路）', atLeast(pkg.version, '0.7.68') && atLeast(agentsPkg.version, '0.2.356'),
		`skills=${pkg.version} agents=${agentsPkg.version}`)
	ok('守卫在 check:dsh-plugins 链内', read('package.json').includes('node dsh-plugins/check-agent-skills.mjs'))
	ok('文档 §9 写清 skills[] 与 owner 分工', read('doc/skill-authoring-standard.md').includes('## 9. ')
		&& read('doc/skill-authoring-standard.md').includes('归属标记，不是作用域'))
}

// ── 反向突变自检：把关键实现改坏，上面的断言必须变红 ──────────────────────
// 这里直接用「实现源码副本」跑同一批静态判据，不改磁盘文件。
function staticVerdict(src) {
	return {
		filterBeforeMap: (() => {
			const i = src.indexOf('async list(options)')
			const filter = src.indexOf('filterSkillsForAgent', i)
			const map = src.indexOf('.map(toCandidate)', i)
			return i >= 0 && filter > i && map > filter
		})(),
		oneCatalog: (src.match(/'<available_skills>'/g) || []).length === 1,
		budgetWired: src.includes('Math.min(SKILL_BODY_MAX, budget)'),
		subsetWired: src.includes('skillSubsetFor(options, dataRootOf(config))'),
		oneMessage: (() => {
			const i = src.indexOf('const ensureSkillCatalog'), j = src.indexOf('const autoloadHandler')
			return i >= 0 && j > i && (src.slice(i, j).match(/createUserMessage\(/g) || []).length === 1
		})(),
		alwaysWired: src.includes("catalogSummaryLine(entry, { always: true })"),
		// P2 起提示行叫 noteLines（P0 叫 activeNote）⇒ 判据查「清单块里有没有把条目又铺一遍」
		noDoubleList: (() => {
			const i = src.indexOf("'<available_skills>'")
			const j = src.indexOf("'</available_skills>'")
			const block = i >= 0 && j > i ? src.slice(i, j) : ''
			return block.length > 0 && !/\.\.\.(?:entries|listed)\.map\(/.test(block)
		})(),
	}
}
const baseline = staticVerdict(indexSrc)
const mutations = [
	['M1 去掉 scope 子集过滤', s => s.replace('skillSubsetFor(options, dataRootOf(config))', 'null'), 'subsetWired', false],
	['M2 去掉 always 摘要标记', s => s.replace("catalogSummaryLine(entry, { always: true })", "lineOf(entry)"), 'alwaysWired', false],
	['M3 预算上限改回硬编码', s => s.replace('Math.min(SKILL_BODY_MAX, budget)', 'Math.min(4000, budget)'), 'budgetWired', false],
	['M4 同一技能出现两行', s => s.replace("'<available_skills>',\n", "'<available_skills>',\n\t\t\t\t\t\t\t\t...listed.map(entry => `- \\`${entry.name}\\``),\n"), 'noDoubleList', false],
	['M5 filter 移到 toCandidate 之后', s => s.replace('return scan.skills.filter(skill => names.has(skill.name)).map(toCandidate);', 'return scan.skills.map(toCandidate);'), 'filterBeforeMap', true],
]
for (const [label, mutate, key, expect] of mutations) {
	const mutated = mutate(indexSrc)
	const changed = mutated !== indexSrc
	const verdict = staticVerdict(mutated)
	const detected = verdict[key] === expect
	ok(`反向突变 ${label} ⇒ 守卫判据会变红`, changed && detected,
		`changed=${changed} key=${key} got=${verdict[key]}`)
}
ok('反向突变基线全绿（判据本身没写反）', Object.values(baseline).every(Boolean), JSON.stringify(baseline))

console.log(problems.length ? `\n✗ check-agent-skills：${problems.length} 项失败` : '\n✓ check-agent-skills：全部通过')
if (problems.length) { for (const p of problems) { console.log(`  ✗ ${p}`); } }
process.exitCode = problems.length ? 1 : 0
