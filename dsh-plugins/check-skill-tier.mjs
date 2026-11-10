// @vssaros/dsh-plugins — P2 技能分级与治理守卫（2026-11-08）
//
// 跑法：node dsh-plugins/check-skill-tier.mjs
//
// 钉住六件事，并自带反向突变自检（内存副本，不改磁盘）：
//   ① 173 个随包技能 frontmatter 的 tier 完整、合法，core ≤ 40；
//   ② `<available_skills>` 只列 core + agent 显式点名，extended 折叠成**可达**提示（不是删掉）；
//   ③ `skill_search` 把随包技能纳入 BM25 语料，extended 能被检索到、且带 skillDir 绝对路径；
//   ④ 同名覆盖：override: true 只许随包声明，裁决走单一真源，不硬编码 rank 550/600；
//   ⑤ 相对脚本路径：现有 67 处登记为基线，新增一处即判红；
//   ⑥ owner: bot:<id> 提升时校验 bot 真实存在，幽灵 Bot 挡住。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const read = rel => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const mod = async rel => await import(pathToFileURL(join(ROOT, rel)).href)
const problems = []
const ok = (label, condition, detail = '') => {
	if (condition) { console.log(`  ✓ ${label}`); }
	else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); problems.push(label); }
}

const bundled = await mod('dsh-plugins/vssaros-skills/lib/core/bundledSkills.js')
const override = await mod('dsh-plugins/vssaros-skills/lib/core/overridePolicy.js')
const agents = await mod('dsh-plugins/vssaros-skills/lib/core/agentSkills.js')
const scripts = await mod('dsh-plugins/scripts/skill-script-refs.mjs')
const BUNDLED_ROOT = join(ROOT, 'dsh-plugins/vssaros-skill-bundle/skills')
const indexSrc = read('dsh-plugins/vssaros-skills/lib/index.js')
/** SuperAgent 运行 bundle：`deskWithoutCatalog` 的定义与注册都在里面（dev/src 分两个文件）。 */
const readSuperagentIndex = () => read('dsh-plugins/vssaros-superagent/lib/index.js')
const pkg = JSON.parse(read('dsh-plugins/vssaros-skills/package.json'))

console.log('check-skill-tier：P2 技能分级与治理')

// ── ① tier 完整性 / core 上限 ─────────────────────────────────────────────
{
	const dirs = readdirSync(BUNDLED_ROOT, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
	const missing = [], illegal = [], core = [], extended = []
	for (const dir of dirs) {
		const file = join(BUNDLED_ROOT, dir, 'SKILL.md')
		if (!existsSync(file)) { continue }
		const text = readFileSync(file, 'utf8')
		const hit = /^tier:\s*(\S+)\s*$/m.exec(text)
		if (!hit) { missing.push(dir); continue }
		if (!bundled.SKILL_TIERS.includes(hit[1])) { illegal.push(`${dir}:${hit[1]}`); continue }
		;(hit[1] === 'core' ? core : extended).push(dir)
	}
	ok('① 174 个随包技能都有合法 tier', dirs.length === 174 && missing.length === 0 && illegal.length === 0,
		`files=${dirs.length} missing=${missing.length} illegal=${illegal.length}`)
	ok('① core ≤ 40、extended 保留（分级不是删减）', core.length > 0 && core.length <= bundled.SKILL_CORE_LIMIT && extended.length > 0,
		`core=${core.length} extended=${extended.length}`)
	ok('① core 上限常量没被人放大（40 是每轮目录预算）', bundled.SKILL_CORE_LIMIT === 40,
		`limit=${bundled.SKILL_CORE_LIMIT}`)
	const idx = bundled.bundledTierIndex(BUNDLED_ROOT).index
	ok('① tier 索引能读到 core/extended', idx.get(core[0])?.tier === 'core' && idx.get(extended[0])?.tier === 'extended' && idx.size === 174)
	ok('① 没写 tier 的老技能按 core（零回归）', bundled.tierOfMd('---\nname: x\n---\nbody') === 'core')
}

// ── ② 目录分区 ───────────────────────────────────────────────────────────
{
	const idx = new Map([['core-a', { tier: 'core' }], ['ext-a', { tier: 'extended' }], ['ext-b', { tier: 'extended' }]])
	const entries = ['core-a', 'ext-a', 'ext-b', 'unknown'].map(name => ({ name, description: name }))
	const plain = bundled.partitionCatalog(entries, idx)
	const pinned = bundled.partitionCatalog(entries, idx, new Set(['ext-a']))
	ok('② 默认只列 core + 未标注项', plain.core.map(e => e.name).join(',') === 'core-a,unknown' && plain.extended.length === 2)
	ok('② agent 显式点名的 extended 绕过 tier', pinned.core.some(e => e.name === 'ext-a') && pinned.extended.length === 1)
	ok('② 折叠提示明说数量与检索路径（不把技能说成不存在）', bundled.extendedHint(2).includes('skill_search') && bundled.extendedHint(2).includes('2'))
	ok('② catalog 用 partitionCatalog 且 source.entries 仍是全量', indexSrc.includes('partitionCatalog(entries, BUNDLED_TIER_INDEX')
		&& indexSrc.includes('source: { kind: \'skill-catalog\', form: \'catalog\', entries }')
		&& indexSrc.includes('extendedHint('))
	ok('② core 上限取自同一常量', indexSrc.includes('partition.core.slice(0, SKILL_CORE_LIMIT)'))
	// ★ 2026-11-09 收尾：成本根因是「173 条全量注入」，不是某一个会话太多。
	//   `deskWithoutCatalog` 曾只救主管台一个会话；现在分级挂在全局 pre-step 发布器上，
	//   对所有 agent 生效，那个过滤器退化为 desk 会话的兜底。钉住这层关系，防止以后
	//   有人再把「只给主管台过滤」当成解法（那样其它会话又会吃 173 行目录）。
	const superagentIndex = readSuperagentIndex()
	ok('② 分级作用于所有会话：挂在 agent/pre-step 全局发布器上',
		/scope\.on\('agent\/pre-step'/.test(indexSrc) && indexSrc.includes('ensureSkillCatalog(payload'))
	ok('② deskWithoutCatalog 只是 desk 会话的 prepend 兜底，不是分级实现',
		/function deskWithoutCatalog\(deskId\)/.test(superagentIndex)
		&& /deskWithoutCatalog\(deskId\), \{ prepend: true \}\)/.test(superagentIndex)
		&& /options\?\.sessionId === deskId/.test(superagentIndex)
		&& !/partitionCatalog/.test(superagentIndex))
	// ★ 2026-11-10（框架质量评估建议 4）：本守卫只读运行 bundle，改了 TS 没 rebuild 时
	//   上面那条会假绿。真源里这个符号必须也在；根本保障仍是 build.mjs --check 的哈希比对。
	// 用「符号 + (」而不是裸 includes：改名成 deskWithoutCatalogXxx 也应判红。
	ok('② dev↔bundle 同形：deskWithoutCatalog 在真源与运行 bundle 都在',
		/deskWithoutCatalog\s*\(/.test(read('dsh-plugins/vssaros-superagent/dev/src/app/desk.ts'))
		&& /deskWithoutCatalog\s*\(/.test(read('dsh-plugins/vssaros-superagent/dev/src/app/runtime.ts'))
		&& /deskWithoutCatalog\s*\(/.test(superagentIndex))
	ok('② 全局回退开关仍可用（skillScopeMode: legacy 只在显式配置时启用）',
		/skillScopeMode \?\? 'attached'/.test(indexSrc) && indexSrc.includes("=== 'legacy'"))
}

// ── ③ skill_search 覆盖随包 ──────────────────────────────────────────────
{
	ok('③ skill_search 把随包索引并入 BM25 语料', indexSrc.includes('for (const [name, entry] of BUNDLED_TIER_INDEX)')
		&& indexSrc.includes('skills.push({ id: name'))
	ok('③ 同名用户技能优先（first-wins）', indexSrc.includes('if (seen.has(name)) { continue; }'))
	ok('③ skillDir 与 tier 补回结果（rankSkills 会丢字段）', indexSrc.includes('dirs.get(item.id)')
		&& indexSrc.includes("tier: BUNDLED_TIER_INDEX.get(item.id)?.tier"))
	ok('③ output.schema 声明了 tier', indexSrc.includes("tier: { type: 'string' }"))
	ok('③ 检查器能识别裸相对脚本且放过合法写法', (() => {
		const bad = scripts.scanScriptRefs('run `python3 scripts/foo.py` now')
		const good = scripts.scanScriptRefs('run `node dsh-plugins/check.mjs` and `node /tmp/a.mjs` and `node $SKILL_DIR/a.mjs`')
		return bad.includes('scripts/foo.py') && good.length === 0
	})())
}

// ── ④ 同名覆盖 ───────────────────────────────────────────────────────────
{
	ok('④ 默认用户技能赢，显式 override 才随包赢', override.resolveSameName({ name: 'x' }, { name: 'x' }) === 'user'
		&& override.resolveSameName({ name: 'x', override: true }, { name: 'x' }) === 'bundled')
	ok('④ 只认字面 true', override.overrideOfMd('---\noverride: true\n---\nx') === true
		&& override.overrideOfMd('---\noverride: "true"\n---\nx') === false)
	ok('④ 无效/越权声明会判红', override.overrideProblems([{ name: 'a', override: true }], []).length === 1
		&& override.overrideProblems([], [{ name: 'b', override: true }]).length === 1)
	const rootsSpec = read('src/vs/sessions/contrib/agentStudio/common/skillRoots.ts')
	ok('④ 根顺序是单一真源，裁决代码不硬编码 rank', (() => {
		const policy = read('dsh-plugins/vssaros-skills/lib/core/overridePolicy.js')
		// 只看可执行行（注释里说明「别学 DS Bot 的 550/600」是允许且必要的）
		const code = policy.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
		return rootsSpec.includes('SKILL_ROOT_SPECS') && !/\b(?:550|600)\b/.test(code)
	})())
	ok('④ skillFromFile 只把 override 收进 metadata', read('dsh-plugins/vssaros-skills/lib/core/skills.js').includes('...(override ? { override: true } : {})'))
}

// ── ⑤ 相对脚本路径基线 ───────────────────────────────────────────────────
{
	const rows = []
	for (const dir of readdirSync(BUNDLED_ROOT, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()) {
		const file = join(BUNDLED_ROOT, dir, 'SKILL.md')
		if (!existsSync(file)) { continue }
		const refs = scripts.scanScriptRefs(readFileSync(file, 'utf8'))
		if (refs.length) { rows.push({ file: `${dir}/SKILL.md`, refs }) }
	}
	// 基线：现有写法登记为已知技术债；新增引用才判红。number 变化也判红（防止有人删掉检查器）。
	const baseline = JSON.parse(read('dsh-plugins/scripts/skill-script-refs.baseline.json'))
	const added = scripts.newScriptRefs(rows, baseline)
	ok('⑤ 相对路径检查器确实扫到了历史写法（假绿防线）', rows.length > 0 && baseline.length > 0,
		`rows=${rows.length} baseline=${baseline.length}`)
	ok('⑤ 没有新增的裸相对脚本引用', added.length === 0, added.slice(0, 3).join('; '))
	ok('⑤ 基线指纹与当前一致（删技能也要重新登记）', scripts.baselineHash(rows) === scripts.baselineHash(baseline),
		`now=${scripts.baselineHash(rows)} base=${scripts.baselineHash(baseline)}`)
}

// ── ⑥ owner 强校验 ───────────────────────────────────────────────────────
{
	const ghost = '---\nname: x\nmetadata:\n  owner: "bot:ghost-bot"\n---\nbody'
	ok('⑥ 幽灵 Bot 被挡、真实 Bot 放行', agents.ownerBotProblems(ghost, id => id === 'real-bot').length === 1
		&& agents.ownerBotProblems(ghost, id => id === 'ghost-bot').length === 0)
	ok('⑥ 无 owner 的技能不受影响', agents.ownerBotProblems('---\nname: x\n---\nbody', () => false).length === 0)
	const manage = read('dsh-plugins/vssaros-skills/lib/core/skillManage.js')
	ok('⑥ promote 落盘前校验、失败不写盘', manage.includes('ownerBotProblems(body, botExists)')
		&& /if \(ownerIssues\.length\) \{ throw new Error/.test(manage)
		&& manage.indexOf('ownerIssues.length') < manage.indexOf('atomicWriteSync(file, body)'))
	ok('⑥ 校验注入可替换（测试可直测）', manage.includes('options?.botExists ??'))
	// 反向：真的把 promote 的校验拿掉（内存副本），跑一遍纯逻辑确认「幽灵 Bot 会被提升」
	{
		const { skillManage, draftDirOf } = await mod('dsh-plugins/vssaros-skills/lib/core/skillManage.js')
		const { mkdtempSync, writeFileSync: wf, mkdirSync: mk, rmSync } = await import('node:fs')
		const { tmpdir } = await import('node:os')
		const tmp = mkdtempSync(join(tmpdir(), 'p2-owner-'))
		try {
			const skillsRoot = join(tmp, 'skills')
			const ghost = '---\nname: ghostskill\nmetadata:\n  owner: "bot:no-such-bot"\n---\nbody'
			const draftDir = draftDirOf(skillsRoot, 'ghostskill')
			mk(draftDir, { recursive: true })
			wf(join(draftDir, 'SKILL.md'), ghost)
			let rejected = false
			try { skillManage({ action: 'promote', name: 'ghostskill' }, skillsRoot, { botExists: () => false }) }
			catch (e) { rejected = /不存在的 bot|幽灵 Bot/.test(String(e?.message ?? '')) }
			ok('⑥ 实际 promote 幽灵 Bot 被拒（不是只测纯函数）', rejected)
		} finally { rmSync(tmp, { recursive: true, force: true }) }
	}
}

// ── 清单 / 版本 / 链 ─────────────────────────────────────────────────────
{
	ok('新模块都在 files 白名单', ['lib/core/bundledSkills.js', 'lib/core/overridePolicy.js', 'lib/core/agentSkills.js']
		.every(f => pkg.files.includes(f)))
	const bundlePkg = JSON.parse(read('dsh-plugins/vssaros-skill-bundle/package.json'))
	const atLeast = (current, floor) => {
		const a = String(current).split('.').map(Number), b = String(floor).split('.').map(Number)
		for (let i = 0; i < 3; i += 1) { if ((a[i] ?? 0) !== (b[i] ?? 0)) { return (a[i] ?? 0) > (b[i] ?? 0); } }
		return true
	}
	ok('版本已 bump（skills + 173 个 SKILL.md 的 bundle 都要装新版）',
		atLeast(pkg.version, '0.7.71') && atLeast(bundlePkg.version, '0.1.1'),
		`skills=${pkg.version} bundle=${bundlePkg.version}`)
	const chain = read('package.json')
	ok('守卫在 check:dsh-plugins 链内', chain.includes('node dsh-plugins/check-skill-tier.mjs'))
	ok('check-skill-bundle 加了 tier 守卫', read('dsh-plugins/check-skill-bundle.mjs').includes('tier'))
	ok('check-skill-tool-refs 接了相对路径检查器', read('dsh-plugins/check-skill-tool-refs.mjs').includes('scanScriptRefs'))
	ok('文档 §10 写清分级与治理', read('doc/skill-authoring-standard.md').includes('## 10.'))
}

// ── 反向突变（内存副本，判据必须变红）────────────────────────────────────
{
	const verdict = src => ({
		partition: src.includes('partitionCatalog(entries, BUNDLED_TIER_INDEX'),
		limit: src.includes('partition.core.slice(0, SKILL_CORE_LIMIT)'),
		searchBundled: src.includes('for (const [name, entry] of BUNDLED_TIER_INDEX)'),
		dirBack: src.includes('dirs.get(item.id)'),
		pinned: src.includes('skillSubsetFor({ scope: agent }'),
	})
	const baseline = verdict(indexSrc)
	ok('反向突变基线全绿', Object.values(baseline).every(Boolean), JSON.stringify(baseline))
	const cases = [
		['catalog 不分级（列全量）', 'const listed = partition.core.slice(0, SKILL_CORE_LIMIT);', 'const listed = entries;', 'limit'],
		['extended 不进检索语料', 'for (const [name, entry] of BUNDLED_TIER_INDEX) {', 'for (const [name, entry] of []) {', 'searchBundled'],
		['skillDir 不补回', 'skillDir: dirs.get(item.id) ?? \'\',', '', 'dirBack'],
		['agent 点名不绕过 tier', '...(skillSubsetFor({ scope: agent }, dataRootOf(config)) ?? [])', '/* no pinned */', 'pinned'],
	]
	for (const [label, from, to, key] of cases) {
		const mutated = indexSrc.replace(from, () => to)
		ok(`反向突变 ${label} ⇒ 判据变红`, mutated !== indexSrc && verdict(mutated)[key] === false,
			`changed=${mutated !== indexSrc} got=${verdict(mutated)[key]}`)
	}
}

console.log(problems.length ? `\n✗ check-skill-tier：${problems.length} 项失败` : '\n✓ check-skill-tier：全部通过')
if (problems.length) { for (const p of problems) { console.log(`  ✗ ${p}`); } }
process.exitCode = problems.length ? 1 : 0
