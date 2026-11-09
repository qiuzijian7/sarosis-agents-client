// @vssaros/dsh-plugins — 21 个内置 agent 的能力包配置守卫（2026-11-08）
//
// 跑法：node dsh-plugins/check-agent-capabilities.mjs
//
// 钉住：
//   ① 21 个 agent 全覆盖，且真源映射表与产物 .agent.md 逐字段一致
//   ② 两套包（工具 packs.js / 技能 capabilityLibrary.js）键集合完全相等
//   ③ 每个技能包引用的技能名真实存在（防止再配出 DS Bot 名字的空包）
//   ④ 每个 agent 的包名在两侧都不报 unknown、可见集不缩水（≥40 core）
//   ⑤ 单根兜底与服务侧的 declared 语义一致（只写 skills[] 仍带 core）
//   ⑥ 生成物与真源不漂移（gen-builtin-agent-md.mjs --check 同口径）
// 外加反向突变自检（内存副本）。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const mod = async rel => await import(pathToFileURL(join(ROOT, rel)).href);
const problems = [];
const ok = (label, condition, detail = '') => {
	if (condition) { console.log(`  ✓ ${label}`); }
	else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); problems.push(label); }
};

const caps = await mod('dsh-plugins/vssaros-skills/lib/core/capabilityLibrary.js');
const packs = await mod('dsh-plugins/vssaros-agents/lib/core/packs.js');
const bundled = await mod('dsh-plugins/vssaros-skills/lib/core/bundledSkills.js');
const bundleRoot = join(ROOT, 'dsh-plugins/vssaros-skill-bundle/skills');
const { index } = bundled.bundledTierIndex(bundleRoot);
const library = caps.buildCapabilityLibrary(index);
const agentRoot = join(ROOT, 'resources/.agents/agents');
const ids = readdirSync(agentRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
const tsSrc = read('src/vs/sessions/contrib/agentStudio/common/builtinAgents.ts');
const skillScopeSrc = read('dsh-plugins/check-skill-scope.mjs');

console.log('check-agent-capabilities：21 个内置 agent 的能力包配置');

// ── ① 真源映射表与产物一致 ───────────────────────────────────────────────
{
	ok('① 真源有 BUILTIN_AGENT_CAPABILITIES 且在 getBuiltinAgents() 循环里注入',
		tsSrc.includes('const BUILTIN_AGENT_CAPABILITIES')
		&& tsSrc.includes('BUILTIN_AGENT_CAPABILITIES[a.id]'));
	// 从映射表源码抠出每条配置，与产物逐 agent 比对
	const table = /const BUILTIN_AGENT_CAPABILITIES[\s\S]*?= Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(tsSrc)?.[1] ?? '';
	const entries = [...table.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*\[([^\]]*)\],/gm)]
		.map(m => [m[1], [...m[2].matchAll(/'([^']+)'/g)].map(x => x[1])]);
	const map = new Map(entries);
	ok('① 映射表恰好覆盖 20 个 agent，无遗漏无多余',
		entries.length === 20 && ids.length === 20 && ids.every(id => map.has(id)) && [...map.keys()].every(id => ids.includes(id)),
		`table=${entries.length} dirs=${ids.length}`);
	let mismatched = [];
	for (const id of ids) {
		const f = join(agentRoot, id, '.agent.md');
		if (!existsSync(f)) { mismatched.push(id + ':no-md'); continue }
		const parsed = caps.parseAgentAttachments(readFileSync(f, 'utf8'));
		const want = map.get(id) ?? [];
		if (JSON.stringify(parsed.capabilities) !== JSON.stringify(want)) {
			mismatched.push(`${id}: md=[${parsed.capabilities}] ts=[${want}]`);
		}
	}
	ok('① 20 份产物 .agent.md 的 capabilities 与真源逐字段一致', mismatched.length === 0,
		mismatched.slice(0, 3).join(' | '));
}

// ── ② 两套包键集合 ──────────────────────────────────────────────────────
{
	const a = Object.keys(caps.CAPABILITY_PACKS).sort();
	const b = Object.keys(packs.PACKS).sort();
	ok('② 工具包 / 技能包键集合完全相等（同一个 capabilities 字段喂两套表）',
		JSON.stringify(a) === JSON.stringify(b), `skill=${a.length} tool=${b.length}`);
	ok('② 工具专属包在技能侧标为空 names、技能专属包在工具侧标为空 tools',
		caps.TOOL_ONLY_PACKS.every(n => caps.CAPABILITY_PACKS[n]?.names?.length === 0)
		&& packs.SKILL_ONLY_PACKS.every(n => packs.PACKS[n]?.tools?.length === 0));
}

// ── ③ 技能名真实性 ──────────────────────────────────────────────────────
{
	const ghost = [];
	for (const [name, pack] of Object.entries(caps.CAPABILITY_PACKS)) {
		for (const skill of pack.names ?? []) {
			if (!library.has(skill)) { ghost.push(`${name}/${skill}`); }
		}
	}
	ok('③ 所有技能包引用的名字都在随包库里（0 个幽灵技能）', ghost.length === 0, ghost.slice(0, 5).join(','));
	ok('③ 领域包确实主要覆盖 extended（不是把 core 又列一遍）', (() => {
		let ext = 0, core = 0;
		for (const [name, pack] of Object.entries(caps.CAPABILITY_PACKS)) {
			if (!['core', 'all'].includes(name) && !caps.TOOL_ONLY_PACKS.includes(name)) {
				for (const skill of pack.names ?? []) { (library.get(skill)?.tier === 'extended' ? ext++ : core++); }
			}
		}
		return ext > core;
	})());
}

// ── ④ 每个 agent 的配置可用 ─────────────────────────────────────────────
{
	const bad = [], sizes = [];
	for (const id of ids) {
		const f = join(agentRoot, id, '.agent.md');
		const t = existsSync(f) ? readFileSync(f, 'utf8') : '';
		const parsed = caps.parseAgentAttachments(t);
		const exp = caps.expandAttachments(parsed.capabilities, parsed.skills, library);
		const tool = packs.expandPacks(parsed.capabilities);
		const visible = exp.names.size;
		sizes.push(visible);
		if (exp.problems.length || tool.unknown.length || visible < 40) {
			bad.push(`${id}: visible=${visible} skillProblems=${exp.problems.length} toolUnknown=${tool.unknown.length}`);
		}
	}
	ok('④ 20 个 agent 的包名两侧都合法、可见集均 ≥40 core', bad.length === 0, bad.slice(0, 3).join(' | '));
	ok('④ 主助理删除后全部收窄到 <120 条（避免目录又回到 173）',
		sizes.length === 20 && sizes.every(n => n < 120), `sizes=${Math.min(...sizes)}..${Math.max(...sizes)}`);
	// ★ 2026-11-09：主助理已删除 ⇒ 反向钉住「确实删干净了」，防止有人改回 all 或复活目录
	ok('④ 主助理 saros-claw 已从真源 / 白名单 / 产物目录删除', (() => {
		// 白名单是独立的 Set 字面量，不能靠「带注释的那一行」判据（换个注释就漏）
		const whitelist = /USER_FACING_BUILTIN_AGENT_IDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(tsSrc)?.[1] ?? '';
		return !tsSrc.includes("id: 'saros-claw'")
			&& !whitelist.includes('saros-claw')
			&& !tsSrc.includes("'saros-claw': ['all']")
			&& !ids.includes('saros-claw');
	})());
	ok('④ 没有任何 agent 再拿 all 全量包', !/:\s*\[[^\]]*'all'[^\]]*\]/.test(tsSrc));
}

// ── ⑤ 两条路径的 declared 语义一致 ──────────────────────────────────────
{
	const lib = read('dsh-plugins/vssaros-skills/lib/core/capabilityLibrary.js');
	const idx = read('dsh-plugins/vssaros-skills/lib/index.js');
	ok('⑤ 单根兜底在只写 skills[] 时仍带 DEFAULT_CAPABILITY_PACK',
		lib.includes("const caps = parsed.capabilities?.length ? parsed.capabilities : [DEFAULT_CAPABILITY_PACK];"));
	ok('⑤ 服务侧同口径', idx.includes("const caps = decl.capabilities?.length ? decl.capabilities : [DEFAULT_CAPABILITY_PACK];"));
	const onlySkills = caps.attachmentsForAgent('vssaros-coder', '/definitely-no-such-root', library,
		(p) => p.slice('vssaros-'.length), () => ({ capabilities: [], skills: ['code-review'] }));
	ok('⑤ 纯函数实证：只写 skills[] 的 agent 仍拿到 40 core + 点名技能',
		onlySkills.names.size >= 40, `size=${onlySkills.names.size}`);
}

// ── ⑥ 存量数据兼容层已移除（2026-11-09 用户决策：不要兼容层）────────────
{
	const idx = read('dsh-plugins/vssaros-agents/lib/index.js');
	const constants = read('src/vs/sessions/contrib/agentStudio/common/constants.ts');
	ok('⑥ 兼容层模块已删除且不在随包清单里',
		!existsSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/core/legacyClawAlias.js'))
		&& !read('dsh-plugins/vssaros-agents/package.json').includes('legacyClawAlias.js'));
	ok('⑥ 注册层没有别名 preset / 旧 id 归一化',
		!idx.includes('__legacy:')
		&& !idx.includes('legacyAliasDefinition')
		&& !idx.includes('resolveLegacyPresetId')
		&& !idx.includes('legacyClawAlias'));
	ok('⑥ 画布 Run 默认已改指 workflow-agent，不再引用旧常量名',
		constants.includes("DEFAULT_WORKFLOW_AGENT_ID = 'workflow-agent'")
		&& !constants.includes('SAROS_CLAW_AGENT_ID')
		&& read('src/vs/sessions/contrib/agentStudio/browser/agentStudioWebviewController.ts').includes('DEFAULT_WORKFLOW_AGENT_ID'));
}

// ── ⑦ 生成物漂移 / 根链 ────────────────────────────────────────────────
{
	const gen = read('dsh-plugins/scripts/gen-builtin-agent-md.mjs');
	ok('⑦ gen-builtin-agent-md.mjs 的 --check 比对 capabilities',
		gen.includes('capabilities: JSON.stringify'));
	ok('⑦ 守卫已接入根链', read('package.json').includes('node dsh-plugins/check-agent-capabilities.mjs'));
	void skillScopeSrc;
}

// ── 反向突变（内存副本，判据必须变红）────────────────────────────────────
{
	const verdict = (src) => ({
		table: /const BUILTIN_AGENT_CAPABILITIES:\s*Readonly</.test(src),
		inject: src.includes('BUILTIN_AGENT_CAPABILITIES[a.id]'),
		mapping: /\bcoder:\s*\['core', 'code', 'git', 'qa'\]/.test(src),
	});
	const base = verdict(tsSrc);
	ok('反向突变基线全绿', Object.values(base).every(Boolean), JSON.stringify(base));
	const cases = [
		['去掉映射表', "const BUILTIN_AGENT_CAPABILITIES:", 'const BUILTIN_AGENT_CAPABILITIES_DISABLED:', 'table'],
		['去掉循环注入', 'BUILTIN_AGENT_CAPABILITIES[a.id]', "['core']", 'inject'],
		['改掉 coder 的包', "coder: ['core', 'code', 'git', 'qa'],", "coder: ['all'],", 'mapping'],
	];
	for (const [label, from, to, key] of cases) {
		const mutated = tsSrc.replace(from, () => to);
		ok(`反向突变 ${label} ⇒ 判据变红`, mutated !== tsSrc && verdict(mutated)[key] === false);
	}
}

console.log(problems.length ? `\n✗ check-agent-capabilities：${problems.length} 项失败` : '\n✓ check-agent-capabilities：全部通过');
if (problems.length) { for (const p of problems) { console.log(`  ✗ ${p}`); } }
process.exitCode = problems.length ? 1 : 0;
