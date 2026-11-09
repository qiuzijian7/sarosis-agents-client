// @vssaros/dsh-plugins — 能力库 / 按 scope 收窄的守卫（2026-11-08，换架构）
//
// 跑法：node dsh-plugins/check-skill-scope.mjs
//
// ★ 为什么需要这个守卫：P0/P2 把 tier 过滤写在 `ensureSkillCatalog`（一个只在官方目录
//   缺失时才跑的兜底），结果生产目录仍是 230 行，而全链守卫全绿。本守卫改为**跑真实
//   provider.list({scope})**，断言不同 agent 拿到不同的 invocation，且 candidate 形状
//   通过官方 `validateCandidate` 同款校验 ⇒ 从源头钉住「目录为什么会小」。
//
// 钉住六件事 + 反向突变自检：
//   ① 全局 filesystem 行已停用（否则 collectFresh 会把 173 个并进每个 agent）
//   ② candidate 形状满足官方校验；同名 / rank 600 语义不变
//   ③ 每个 agent 的 attach 集不同；缺省只挂 core（40），不是全量
//   ④ 未 attach 的技能 modelInvocable:false 但 userInvocable:true（/name 仍可加载）
//   ⑤ `get()` 仍能取到未 attach 技能的全文（分级不是删除）
//   ⑥ legacy 模式一键回退到全量；skill_search / read_skill 能覆盖 173 个
import { readFileSync, existsSync } from 'node:fs';
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

const bundled = await mod('dsh-plugins/vssaros-skills/lib/core/bundledSkills.js');
const caps = await mod('dsh-plugins/vssaros-skills/lib/core/capabilityLibrary.js');
const providerMod = await mod('dsh-plugins/vssaros-skills/lib/core/bundledProvider.js');
const agents = await mod('dsh-plugins/vssaros-skills/lib/core/agentSkills.js');

const BUNDLED_ROOT = join(ROOT, 'dsh-plugins/vssaros-skill-bundle/skills');
const { index } = bundled.bundledTierIndex(BUNDLED_ROOT);
const library = caps.buildCapabilityLibrary(index);
const indexSrc = read('dsh-plugins/vssaros-skills/lib/index.js');
const patch = read('dsh-plugins/vssaros-skill-bundle/cordis.patch.yml');

console.log('check-skill-scope：能力库 / 按 agent 收窄');

// ── ① 根因：全局 filesystem 行必须停用 ───────────────────────────────────
{
	const active = /^\s*- id: vssaros-skill-bundle-fs\s*$/m.test(patch);
	ok('① 全局 bundled filesystem 行已停用（否则 global 层无条件并进每个 agent）', !active);
	ok('① 新 provider 在 skills 插件里注册，且用同一 providerName',
		indexSrc.includes('return createBundledProvider({')
		&& providerMod.BUNDLED_PROVIDER_NAME === 'vssaros-bundled'
		&& providerMod.BUNDLED_RANK === 600);
	ok('① builder 的 tool-skill / skill-filesystem 基座行未被禁用',
		/REQUIRED_BASE_ROW_IDS[\s\S]{0,300}skill-filesystem[\s\S]{0,80}tool-skill/.test(
			read('dsh-plugins/vssaros-agents/lib/core/agents.js')));
	// ★ 21 个内置 agent 的 .agent.md 在 `agentsBuiltinRoot`（Host 生成物），不在 <dataRoot>/agents/。
	//   只读单根会让它们的 skills[]/capabilities[] 永远读不到 ⇒ 必须走 agents 侧双根服务。
	const agentsSrc = read('dsh-plugins/vssaros-agents/lib/index.js');
	ok('① agents 侧暴露双根 attachmentsOf / agentsBuiltinRoot',
		agentsSrc.includes('attachmentsOf: async (preset)') && agentsSrc.includes('scanAgentsFromConfig(config)')
		&& agentsSrc.includes("agentsBuiltinRoot: () => agentsBuiltinRootOf(config)"));
	ok('① skills 侧消费服务且保留单根兜底（服务没就绪不会让技能消失）',
		indexSrc.includes('attachmentsFromAgentService(preset, root, library, idOf)')
		&& indexSrc.includes('attachmentsForAgent(preset, dataRoot, library, idOf, parseAgentAttachments)')
		&& indexSrc.includes("ctx.inject(['vssarosAgents']"));
}

// ── ② 能力库与 attach 语义 ──────────────────────────────────────────────
{
	const coreCount = [...library.values()].filter(x => x.tier === 'core').length;
	ok('② 能力库收全 174 个技能、40 core / 134 extended', library.size === 174 && coreCount === 40,
		`size=${library.size} core=${coreCount}`);
	const { names } = caps.expandAttachments([caps.DEFAULT_CAPABILITY_PACK], [], library);
	ok('② 缺省 attach = 40 个 core（不是全量）', names.size === 40 && !names.has('act-on-feedback'),
		`size=${names.size}`);
	const all = caps.expandAttachments(['all'], [], library);
	ok('② all 包 = 全量 174', all.names.size === 174);
	const pinned = caps.expandAttachments([], ['act-on-feedback'], library);
	ok('② skills[] 显式点名绕过 tier（extended 技能也可见）', pinned.names.has('act-on-feedback'));
	const bad = caps.expandAttachments(['no-such-pack'], ['ghost-skill'], library);
	ok('② 幽灵包名 / 幽灵技能名会判红', bad.problems.length === 2, bad.problems.join(';'));
	const parsed = caps.parseAgentAttachments('---\nname: x\ncapabilities: [core, fs]\nskills: ["a", "b"]\n---\nbody');
	ok('② .agent.md 的 capabilities/skills 都能读（数组 + 逗号串）',
		parsed.capabilities.join(',') === 'core,fs' && parsed.skills.join(',') === 'a,b');
}

// ── ③ 真实 provider：按 scope 收窄、形状合法、全文可达 ────────────────────
{
	const dataRoot = join(ROOT, '.scope-test-agents');
	// 不写盘：用一个临时目录里的 .agent.md 需要真实文件 ⇒ 改用可注入的 stub 验证
	const makeProvider = (mode, attach) => providerMod.createBundledProvider({
		index,
		library,
		mode,
		dataRoot,
		agentIdOfPreset: agents.agentIdOfPreset,
		attachmentsForAgent: attach,
	});
	const stub = (result) => () => result;

	const attachedSet = caps.expandAttachments([caps.DEFAULT_CAPABILITY_PACK], [], library).names;
	const p = makeProvider('attached', stub({ names: attachedSet, problems: [] }));
	const list = await p.list({ scope: { session: { header: { agentPreset: 'vssaros-coder' } } } });
	ok('③ provider.list() 返回全部 174 个 candidate（不删，保住 get 链路）', list.length === 174,
		`got=${list.length}`);
	const visible = list.filter(c => c.invocation.modelInvocable);
	ok('③ 只有 40 个 modelInvocable ⇒ 官方目录自动收窄', visible.length === 40,
		`visible=${visible.length}`);
	// 注意：少数技能 frontmatter 自带 user-invocable: false，provider 必须如实保留；
	// 这里断言的是「attach 收窄只动 modelInvocable，不改 userInvocable」，不是一律 true。
	const legacyProbe = makeProvider('legacy', stub({ names: new Set(), problems: [] }));
	const listProbe = await legacyProbe.list({ scope: undefined });
	const byName = new Map(listProbe.map(c => [c.name, c.invocation.userInvocable]));
	ok('③ attach 只收窄 modelInvocable，userInvocable 逐技能不变（/name 手势保留）',
		list.every(c => c.invocation.userInvocable === byName.get(c.name)));

	// 官方 validateCandidate 同款校验
	const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
	const invalid = list.filter(c => !SKILL_NAME.test(c.name) || !c.description
		|| typeof c.invocation.modelInvocable !== 'boolean' || typeof c.invocation.userInvocable !== 'boolean'
		|| c.source !== 'bundled' || c.rank !== 600 || c.provider !== p.name
		|| typeof c.path !== 'string' || c.resourceBase?.kind !== 'directory');
	ok('③ candidate 逐字段满足官方 validateCandidate / filesystem 形状', invalid.length === 0,
		`invalid=${invalid.length} first=${JSON.stringify(invalid[0]?.name)}`);

	// 全文链路：挑一个未 attach 的 extended 技能
	const hidden = list.find(c => !c.invocation.modelInvocable);
	const definition = hidden ? await p.get(hidden) : undefined;
	ok('⑤ get() 仍能取到未 attach 技能的全文（分级不是删除）',
		!!definition && typeof definition.content === 'string' && definition.content.length > 0,
		`name=${hidden?.name} chars=${definition?.content?.length ?? 0}`);

	// 不同 agent 不同结果
	const otherSet = caps.expandAttachments([], ['act-on-feedback'], library).names;
	const p2 = makeProvider('attached', stub({ names: otherSet, problems: [] }));
	const list2 = await p2.list({ scope: { session: { header: { agentPreset: 'vssaros-designer' } } } });
	const v2 = new Set(list2.filter(c => c.invocation.modelInvocable).map(c => c.name));
	const v1 = new Set(visible.map(c => c.name));
	ok('③ 不同 agent 的可见集确实不同（scoped，而非全局收窄）',
		v2.size === 1 && v2.has('act-on-feedback') && !v1.has('act-on-feedback') && v1.size === 40,
		`agentA=${v1.size} agentB=${v2.size}`);

	// legacy 回退
	const legacy = makeProvider('legacy', stub({ names: new Set(), problems: [] }));
	const listL = await legacy.list({ scope: { session: { header: { agentPreset: 'vssaros-coder' } } } });
	ok('⑥ legacy 模式一键回退到全量可见',
		listL.length === 174 && listL.every(c => c.invocation.modelInvocable),
		`visible=${listL.filter(c => c.invocation.modelInvocable).length}`);

	// 非 vssaros agent 不收窄
	const foreign = makeProvider('attached', stub({ names: null, problems: [] }));
	const listF = await foreign.list({ scope: { session: { header: { agentPreset: 'dsh-superagent-router' } } } });
	ok('⑥ 非 vssaros preset 不收窄（官方全量语义不变）',
		listF.length === 174 && listF.every(c => c.invocation.modelInvocable));

	// ★ 双根服务：异步 attachmentsOf 返回不同声明 ⇒ provider 必须 await 后再算可见集
	const asyncAttach = (preset) => {
		const decl = preset === 'vssaros-coder'
			? { capabilities: ['core'], skills: ['act-on-feedback'] }
			: { capabilities: ['engineering'], skills: [] };
		const r = caps.expandAttachments(decl.capabilities, decl.skills, library);
		return Promise.resolve({ names: r.names, problems: r.problems, agentId: 'x', declared: true });
	};
	const pa = makeProvider('attached', (_p, _r, lib, idOf) => asyncAttach('vssaros-coder'));
	const pb = makeProvider('attached', (_p, _r, lib, idOf) => asyncAttach('vssaros-writer'));
	const sa = new Set((await pa.list({ scope: { session: { header: { agentPreset: 'vssaros-coder' } } } }))
		.filter(c => c.invocation.modelInvocable).map(c => c.name));
	const sb = new Set((await pb.list({ scope: { session: { header: { agentPreset: 'vssaros-writer' } } } }))
		.filter(c => c.invocation.modelInvocable).map(c => c.name));
	ok('③ 异步双根服务的不同声明 ⇒ 不同可见集（provider 会 await）',
		sa.size === 41 && sa.has('act-on-feedback') && sb.size <= 6 && !sb.has('act-on-feedback'),
		`coder=${sa.size} writer=${sb.size}`);

	// ★★ 2026-11-09 真机事故守卫（此前 stub 假绿的缺口）：**真跑** index.js 导出的
	//   `attachmentsFromAgentService` 的三条分支，逐条断言 `names instanceof Set`。
	//   旧代码在 `declared:false` / `catch` 两条兜底把 `expandAttachments()` 的整个返回对象
	//   塞进 `names` ⇒ provider 的 `attached.has()` 抛 TypeError ⇒ 官方把 provider 整个 skip
	//   ⇒ 173 个随包技能在真机全丢。这三条断言能在离线拦住同类回归。
	const plugin = await mod('dsh-plugins/vssaros-skills/lib/index.js');
	const idOf = () => 'coder';
	const call = (svc) => { plugin.bindAgentDeclarations(svc); return plugin.attachmentsFromAgentService('vssaros-coder', '/nonexistent-agents', library, idOf); };
	const rUndeclared = await call({ attachmentsOf: async () => ({ declared: false, capabilities: [], skills: [] }) });
	const rThrow = await call({ attachmentsOf: async () => { throw new Error('probe-boom'); } });
	const rDeclared = await call({ attachmentsOf: async () => ({ declared: true, capabilities: ['core'], skills: ['act-on-feedback'] }) });
	ok('⑦ 真跑服务：未声明 agent 的兜底 names 是 Set（不是整个 expandAttachments 对象）',
		rUndeclared.names instanceof Set && rUndeclared.names.size === 40,
		`type=${Object.prototype.toString.call(rUndeclared.names)} size=${rUndeclared.names?.size}`);
	ok('⑦ 真跑服务：attachmentsOf 抛错时的兜底 names 是 Set',
		rThrow.names instanceof Set && rThrow.names.size === 40,
		`type=${Object.prototype.toString.call(rThrow.names)} size=${rThrow.names?.size}`);
	ok('⑦ 真跑服务：已声明 agent 的 names 是 Set 且含显式点名技能',
		rDeclared.names instanceof Set && rDeclared.names.size === 41 && rDeclared.names.has('act-on-feedback'),
		`size=${rDeclared.names?.size}`);
	// 端到端：把真服务的返回值直接喂给真 provider（不是 stub），确认 173 个 candidate 都在、
	// 且目录确实收窄到 40。这是「provider 不被 skip」的最终证据。
	// ⚠ `agentDeclarationService` 是模块级单例，上面最后注入的是 declared:true ⇒ 先重置回去。
	plugin.bindAgentDeclarations({ attachmentsOf: async () => ({ declared: false, capabilities: [], skills: [] }) });
	const pReal = providerMod.createBundledProvider({
		index, library, mode: 'attached', dataRoot: () => '/nonexistent-agents', agentIdOfPreset: agents.agentIdOfPreset,
		attachmentsForAgent: (preset, root, lib, id) => plugin.attachmentsFromAgentService(preset, root, lib, id),
	});
	const listReal = await pReal.list({ scope: { session: { header: { agentPreset: 'vssaros-coder' } } } });
	const realVisible = listReal.filter(c => c.invocation.modelInvocable).length;
	ok('⑦ 端到端：真服务 + 真 provider ⇒ 174 candidate、40 可见（provider 未被 skip）',
		listReal.length === 174 && realVisible === 40, `candidates=${listReal.length} visible=${realVisible}`);

	// provider 的形状防御：即使上游又传回非法形状，也必须退回全量而不是抛错丢技能
	const pBadShape = makeProvider('attached', stub({ names: { notASet: true }, problems: [] }));
	const listBad = await pBadShape.list({ scope: { session: { header: { agentPreset: 'vssaros-coder' } } } });
	ok('⑦ attach 集形状非法时保守退回全量（宁可目录大，也不让技能消失）',
		listBad.length === 174 && listBad.every(c => c.invocation.modelInvocable),
		`visible=${listBad.filter(c => c.invocation.modelInvocable).length}`);
}

// ── ④ 检索 / 全文覆盖 173 个 ────────────────────────────────────────────
{
	ok('④ skill_search 把随包索引并入 BM25 语料',
		indexSrc.includes('for (const [name, entry] of BUNDLED_TIER_INDEX)'));
	ok('④ read_skill 有随包全文兜底（extended 可检索也读得到）',
		indexSrc.includes('readBundledSkillBody(BUNDLED_TIER_INDEX, skillId)'));
	// 未 attach 的技能 modelInvocable:false ⇒ 原生 `skill` 工具会拒绝；检索结果必须引导到 read_skill
	ok('④ skill_search 的 render 引导到 read_skill（不指向会拒绝的原生 skill 工具）',
		indexSrc.includes('按 id 用 \\`read_skill\\` 取正文')
		&& !indexSrc.includes('按 id 用原生 skill 工具取正文'));
	const sample = providerMod.readBundledSkillBody(index, [...index.keys()][0]);
	ok('④ readBundledSkillBody 能读到正文与技能目录绝对路径',
		!!sample && sample.body.length > 0 && existsSync(join(sample.directory, 'SKILL.md')));
}

// ── ⑤ 清单 / 版本 / 链 ─────────────────────────────────────────────────
{
	const pkg = JSON.parse(read('dsh-plugins/vssaros-skills/package.json'));
	const bundlePkg = JSON.parse(read('dsh-plugins/vssaros-skill-bundle/package.json'));
	ok('⑤ 两个新模块都在 files 白名单',
		['lib/core/capabilityLibrary.js', 'lib/core/bundledProvider.js'].every(f => pkg.files.includes(f)));
	// 版本只许增不许减：写死「等于某值」会在每次正常 bump 后误红（2026-11-09 踩过）。
	// 「改了内容就必须 bump」由 check-dsh-plugin-sync 的「同版不同字节」判据负责，这里不重复。
	const versionAtLeast = (actual, floor) => {
		const a = String(actual).split('.').map(Number);
		const b = String(floor).split('.').map(Number);
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			if ((a[i] ?? 0) !== (b[i] ?? 0)) { return (a[i] ?? 0) > (b[i] ?? 0); }
		}
		return true;
	};
	ok('⑤ 版本已 bump（只许增）',
		versionAtLeast(pkg.version, '0.7.79') && versionAtLeast(bundlePkg.version, '0.1.3'),
		`skills=${pkg.version} bundle=${bundlePkg.version}`);
	ok('⑤ 守卫已接入根链', read('package.json').includes('node dsh-plugins/check-skill-scope.mjs'));
	// ★ 2026-11-09：`dataRootOf()` 曾在 `registerProvider` 工厂回调里同步求值 ⇒ foundation
	//   未绑定就抛错 ⇒ 整个 provider 注册失败。必须传函数、由 provider 在 list() 里惰性求值。
	ok('⑧ dataRoot 惰性求值（不在 apply 期调 foundation）',
		indexSrc.includes('dataRoot: () => dataRootOf(config),')
		&& !/dataRoot:\s*dataRootOf\(config\),/.test(indexSrc)
		&& read('dsh-plugins/vssaros-skills/lib/core/bundledProvider.js').includes('typeof opts.dataRoot === \'function\''));
}

// ── 反向突变（内存副本，判据必须变红）────────────────────────────────────
{
	const verdict = (src, patchSrc) => ({
		disabled: !/^\s*- id: vssaros-skill-bundle-fs\s*$/m.test(patchSrc),
		registered: src.includes('return createBundledProvider({'),
		scopeAware: src.includes('mode: String(config?.skillScopeMode'),
		bodyFallback: src.includes('readBundledSkillBody(BUNDLED_TIER_INDEX, skillId)'),
		// 两条兜底必须取 `.names`；`names: expandAttachments(` 是真机事故的原样
		namesShape: !/names:\s*expandAttachments\(/.test(src),
		lazyRoot: src.includes('dataRoot: () => dataRootOf(config),'),
	});
	const base = verdict(indexSrc, patch);
	ok('反向突变基线全绿', Object.values(base).every(Boolean), JSON.stringify(base));
	const cases = [
		['把全局 filesystem 行恢复', null, patch.replace('    # - id: vssaros-skill-bundle-fs', '    - id: vssaros-skill-bundle-fs'), 'disabled'],
		['去掉新 provider 注册', indexSrc.replace('return createBundledProvider({', 'void ('), null, 'registered'],
		['把 scope 模式写死 legacy', indexSrc.replace("mode: String(config?.skillScopeMode ?? 'attached') === 'legacy' ? 'legacy' : 'attached',", "mode: 'legacy',"), null, 'scopeAware'],
		['去掉 read_skill 随包兜底', indexSrc.replace('readBundledSkillBody(BUNDLED_TIER_INDEX, skillId)', 'undefined'), null, 'bodyFallback'],
		['兜底分支退回「整个对象塞进 names」', indexSrc.replace('const fallback = expandAttachments([DEFAULT_CAPABILITY_PACK], [], library);\n\t\t\treturn { names: fallback.names,', 'return { names: expandAttachments([DEFAULT_CAPABILITY_PACK], [], library),'), null, 'namesShape'],
		['dataRoot 改回 apply 期同步求值', indexSrc.replace('dataRoot: () => dataRootOf(config),', 'dataRoot: dataRootOf(config),'), null, 'lazyRoot'],
	];
	for (const [label, src, patchSrc, key] of cases) {
		const v = verdict(src ?? indexSrc, patchSrc ?? patch);
		ok(`反向突变 ${label} ⇒ 判据变红`, v[key] === false, JSON.stringify(v));
	}
}

console.log(problems.length ? `\n✗ check-skill-scope：${problems.length} 项失败` : '\n✓ check-skill-scope：全部通过');
if (problems.length) { for (const p of problems) { console.log(`  ✗ ${p}`); } }
process.exitCode = problems.length ? 1 : 0;
