// @vssaros/dsh-plugins — 17.1 P1 技能声明链路守卫（2026-11-09）
//
// 跑法：node dsh-plugins/check-skill-write-service.mjs
//
// 钉住一条完整链路，防止「preset 解析了 skills: 却没人消费」这种半成品回来：
//   ① vssaros-skills 提供进程内写服务（ctx.provide），纯逻辑真跑 pin / pinnedFor / listOwned；
//   ② 目录发布器把服务登记的技能并入 pinned（含能力包展开的技能）；
//   ③ toPresetDefinition 把 merged.skills 写进 preset 声明；
//   ④ applyPersona 读 config.skills 并登记给服务，ownedSkillsText 退出主链路（只留 deprecated 定义）；
//   ⑤ 新模块进 package.json files 白名单；
//   ⑥ 反向突变：链路任一环被拆掉 ⇒ 判据变红。
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const mod = async rel => await import(pathToFileURL(join(ROOT, rel)).href)
const problems = []
const ok = (label, condition, detail = '') => {
	if (condition) { console.log(`  ✓ ${label}`) }
	else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); problems.push(label) }
}

const skillsIndex = read('dsh-plugins/vssaros-skills/lib/index.js')
const agentsCore = read('dsh-plugins/vssaros-agents/lib/core/agents.js')
const agentsIndex = read('dsh-plugins/vssaros-agents/lib/index.js')
const stepMemory = read('dsh-plugins/vssaros-agents/lib/stepMemory.js')
const skillsPkg = JSON.parse(read('dsh-plugins/vssaros-skills/package.json'))
const serviceSrc = read('dsh-plugins/vssaros-skills/lib/core/skillWriteService.js')
const service = await mod('dsh-plugins/vssaros-skills/lib/core/skillWriteService.js')

console.log('check-skill-write-service：17.1 P1 技能声明链路')

// ① 服务注册 + 纯逻辑真跑
{
	ok('① ctx.provide 注册 vssarosSkills 且暴露 skillWriteService() 供直读',
		/ctx\.provide\?\.\(SKILL_WRITE_SERVICE_NAME, activeSkillWriteService\)/.test(skillsIndex)
		&& /export function skillWriteService\(\)/.test(skillsIndex))
	ok('① 服务名常量与 files 白名单一致',
		service.SKILL_WRITE_SERVICE_NAME === 'vssarosSkills'
		&& skillsPkg.files.includes('lib/core/skillWriteService.js'))
	const dir = mkdtempSync(join(tmpdir(), 'skill-write-'))
	try {
		mkdirSync(join(dir, 'alpha-skill'), { recursive: true })
		writeFileSync(join(dir, 'alpha-skill', 'SKILL.md'),
			'---\nname: alpha\ndescription: 甲技能\nowner: bot:coder\n---\n# alpha\n')
		mkdirSync(join(dir, '.drafts', 'draft-skill'), { recursive: true })
		writeFileSync(join(dir, '.drafts', 'draft-skill', 'SKILL.md'),
			'---\nname: draft\nowner: bot:coder\n---\n# draft\n')
		let invalidated = 0
		const svc = service.createSkillWriteService({ skillsRoot: () => dir, invalidate: () => { invalidated += 1 } })
		ok('① pin 幂等、pinnedFor 按多个 scope id 取并集',
			svc.pin('coder', ['analysis', 'analysis', ''] ) === 1
			&& svc.pin('coder', ['plan']) === 2
			&& svc.pinnedFor('session-1', 'coder').join(',') === 'analysis,plan')
		ok('① listOwned 只认已批准技能（.drafts 不算）',
			svc.listOwned('coder').map(s => s.name).join(',') === 'alpha'
			&& svc.listOwned('designer').length === 0)
		svc.invalidate()
		ok('① invalidate 可调（写盘后目录重建）', invalidated === 1)
		ok('① 目录读不动时降级为空而非抛错',
			service.createSkillWriteService({ skillsRoot: () => join(dir, 'nope') }).listOwned('coder').length === 0)
	} finally { rmSync(dir, { recursive: true, force: true }) }
}

// ② 目录发布器消费服务
{
	ok('② 目录发布器把服务登记的技能并入 pinned',
		/activeSkillWriteService\?\.pinnedFor\(/.test(skillsIndex)
		&& /new Set\(\[\s*\.\.\.\(skillSubsetFor/.test(skillsIndex))
}

// ③ preset 消费 skills:
{
	ok('③ toPresetDefinition 把 merged.skills 写进 preset 声明',
		/\.\.\.\(merged\.skills\.length \? \{ skills: merged\.skills \} : \{\}\),/.test(agentsCore))
}

// ④ applyPersona 退出 ownedSkillsText
{
	ok('④ applyPersona 读 config.skills 并调服务 pin',
		/declaredSkills\.length && config\.agentId/.test(agentsIndex)
		&& /svc\.pin\(config\.agentId, declaredSkills\)/.test(agentsIndex)
		&& /ctx\.get\?\.\('vssarosSkills'\)/.test(agentsIndex))
	ok('④ ownedSkillsText 退出主链路（不再 import、不再 60s 扫盘、不再拼进人设）',
		!/import \{[^}]*ownedSkillsText/.test(agentsIndex)
		&& !/ownedSkillsOf\(config/.test(agentsIndex)
		&& !/refreshSkills\(|skillsTextFor\(|setInterval\(\(\) => \{ void refreshSkills/.test(agentsIndex)
		&& /text: \(context\) => switchedPersonaText\(projections, context\) \?\? staticPersona/.test(agentsIndex))
	ok('④ ownedSkillsText 保留导出但标 @deprecated（兼容既有测试）',
		/@deprecated/.test(stepMemory) && /export function ownedSkillsText\(/.test(stepMemory))
}

// ⑤ 文档与总线的废弃标注（第 5 条）
{
	const doc = read('doc/superagent-framework-v2.html')
	const bus = read('dsh-plugins/vssaros-agents/lib/teamBus.js')
	ok('⑤ import-ds-bot 非全量迁移写成用户可见说明',
		/用户可见说明/.test(doc) && /不会.*被导入|不会<\/strong>被导入/.test(doc)
		&& /密钥/.test(doc) && /MCP/.test(doc))
	ok('⑤ 团队总线 delegate / subscribe 标 @deprecated',
		/@deprecated[^\n]*\n\s*delegate:/.test(bus) && /@deprecated[^\n]*\n\s*subscribe\(/.test(bus))
	ok('⑤ 决策 15 与发布前唯一硬门槛已登记',
		/<tr><td>15<\/td>/.test(doc) && /发布前唯一硬门槛/.test(doc)
		&& /随包版（非 dev profile）/.test(doc) && /rc\.2 Host 下复测/.test(doc)
		&& /已知限制（不阻断发布）/.test(doc))
}

// ⑥ 反向突变（源码内存副本，判据必须变红）
{
	const verdict = (s) => ({
		provide: /ctx\.provide\?\.\(SKILL_WRITE_SERVICE_NAME, activeSkillWriteService\)/.test(s.skillsIndex),
		pinUse: /activeSkillWriteService\?\.pinnedFor\(/.test(s.skillsIndex),
		preset: /\.\.\.\(merged\.skills\.length \? \{ skills: merged\.skills \} : \{\}\),/.test(s.agentsCore),
		pinCall: /svc\.pin\(config\.agentId, declaredSkills\)/.test(s.agentsIndex),
		retired: !/import \{[^}]*ownedSkillsText/.test(s.agentsIndex),
	})
	const base = { skillsIndex, agentsCore, agentsIndex }
	ok('⑥ 反向突变基线全绿', Object.values(verdict(base)).every(Boolean), JSON.stringify(verdict(base)))
	const cases = [
		['去掉 ctx.provide', { ...base, skillsIndex: skillsIndex.replace("ctx.provide?.(SKILL_WRITE_SERVICE_NAME, activeSkillWriteService);", "void 0;") }, 'provide'],
		['目录发布器不读 pinned', { ...base, skillsIndex: skillsIndex.replace('activeSkillWriteService?.pinnedFor(', 'null?.pinnedFor(') }, 'pinUse'],
		['preset 不写 skills', { ...base, agentsCore: agentsCore.replace('...(merged.skills.length ? { skills: merged.skills } : {}),', '// removed') }, 'preset'],
		['applyPersona 不登记服务', { ...base, agentsIndex: agentsIndex.replace('svc.pin(config.agentId, declaredSkills);', 'void declaredSkills;') }, 'pinCall'],
		['ownedSkillsText 回到主链路', { ...base, agentsIndex: agentsIndex.replace("import { decideSkillDraft, rememberStep }", "import { decideSkillDraft, ownedSkillsText, rememberStep }") }, 'retired'],
	]
	for (const [label, src, key] of cases) {
		ok(`⑥ 反向突变 ${label} ⇒ 判据变红`, src.skillsIndex !== skillsIndex || src.agentsCore !== agentsCore || src.agentsIndex !== agentsIndex
			? verdict(src)[key] === false : false)
	}
}

console.log(problems.length ? `\n✗ check-skill-write-service：${problems.length} 项失败` : '\n✓ check-skill-write-service：全部通过')
process.exitCode = problems.length ? 1 : 0
