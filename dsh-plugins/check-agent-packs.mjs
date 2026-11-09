// @vssaros/dsh-plugins — P1 能力包 / 长结果 / MCP 授权守卫（2026-11-08）
//
// 跑法：node dsh-plugins/check-agent-packs.mjs
//
// 钉住四件事，并自带反向突变自检（内存副本，不改磁盘）：
//   ① capability pack 是**只加不减**的并集，未声明时老 agent 的 tools 逐字不变；
//   ② 能力预算真的会判红（>PACK_TOOL_BUDGET）；pack 里不写影子会话专用工具；
//   ③ 长结果富媒体：超阈值给前 N 行 + 完整路径说明，不把截断说成全文；
//      read_skill / skill_search 的 output{schema,render} 都齐备；
//   ④ stdio MCP 未 approved 不挂载，且插件侧与 IDE 侧判据逐字同形。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

const packs = await mod('dsh-plugins/vssaros-agents/lib/core/packs.js')
const long = await mod('dsh-plugins/vssaros-skills/lib/core/longOutput.js')
const mcp = await mod('dsh-plugins/vssaros-mcp/lib/core/mcpConfig.js')
const agentsSrc = read('dsh-plugins/vssaros-agents/lib/core/agents.js')
const skillsSrc = read('dsh-plugins/vssaros-skills/lib/index.js')
const mcpHostSrc = read('dsh-plugins/vssaros-mcp/lib/core/mcpConfig.js')
const mcpIdeSrc = read('src/vs/sessions/contrib/dshHarness/common/dshMcpConfig.ts')
const mdFormat = read('src/vs/sessions/contrib/agentStudio/common/agentMdFormat.ts')
const agentTypes = read('src/vs/sessions/common/agentStudioTypes.ts')
const genMd = read('dsh-plugins/scripts/gen-builtin-agent-md.mjs')

console.log('check-agent-packs：P1 能力包 / 长结果 / MCP 授权')

// ── ① pack 只加不减 ────────────────────────────────────────────────────────
{
	const declared = ['read', 'custom_tool'];
	const plain = packs.mergeCapabilities(declared, [], []);
	const withFs = packs.mergeCapabilities(declared, [], ['fs']);
	const withTwo = packs.mergeCapabilities(declared, [], ['fs', 'web']);
	ok('① 未声明 capabilities ⇒ tools 逐字不变（老 agent 零回归）',
		JSON.stringify(plain.tools) === '["read","custom_tool"]' && plain.fromPacks.length === 0)
	ok('① 声明 pack ⇒ 并集（只加不减，原有名字不掉）',
		declared.every(t => withFs.tools.includes(t)) && withFs.tools.includes('bash') && withFs.tools.includes('glob'))
	ok('① 多个 pack 叠加去重', withTwo.tools.includes('web_search') && withTwo.tools.includes('bash')
		&& new Set(withTwo.tools).size === withTwo.tools.length)
	ok('① 未知 pack 名不静默吞', packs.expandPacks(['nope']).unknown.join(',') === 'nope')
	ok('① pack 不含影子会话专用工具（group_ask / group_goal）',
		!Object.values(packs.PACKS).some(p => p.tools.some(t => t === 'group_ask' || t === 'group_goal')))
	ok('① .agent.md 格式层读写 capabilities（含类型声明）',
		mdFormat.includes('capabilities?: string[]') && mdFormat.includes('fm.capabilities = agent.capabilities')
		&& mdFormat.includes('capabilities: parseStringOrArray(raw.capabilities)')
		&& agentTypes.includes('capabilities?: string[]') && genMd.includes('capabilities: JSON.stringify'))
	ok('① toPresetDefinition 用并集且写进 notes', agentsSrc.includes('mergeCapabilities(agent.tools, agent.skills, agent.capabilities)')
		&& agentsSrc.includes('toDshTools(merged.tools)') && agentsSrc.includes('能力包展开'))
	ok('① 基座生成链未被改写（保守取舍）', (() => {
		const base = read('dsh-plugins/vssaros-agents/lib/core/presetBase.generated.js')
		return base.includes('export const STANDARD_BASE_ROWS') && base.includes('"skill-filesystem"')
			&& base.includes('"tool-skill"') && base.includes('"compaction"')
	})(), 'REQUIRED_BASE_ROW_IDS 的 6 行必须还在')
}

// ── ② 能力预算 ─────────────────────────────────────────────────────────────
{
	ok('② 预算内不报，超额报红', packs.toolBudgetProblems(['a', 'b']).length === 0
		&& packs.toolBudgetProblems(Array.from({ length: packs.PACK_TOOL_BUDGET + 1 }, (_, i) => `t${i}`)).length === 1)
	ok('② 预算守卫接进 check-agent-tools.mjs', read('dsh-plugins/check-agent-tools.mjs').includes('toolBudgetProblems')
		&& read('dsh-plugins/check-agent-tools.mjs').includes('能力预算守卫'))
	ok('② pack 工具名都在 dsh 工具面（守卫判据 A 同口径）', (() => {
		const snap = JSON.parse(read('dsh-plugins/tools-snapshot.json'))
		const pluginTools = new Set(Object.values(snap.plugins).flat().map(t => t.name))
		// 官方 runtime 工具名（read/glob/pwsh/...）不在快照里，这里只校验"插件工具"那一类
		return Object.values(packs.PACKS).every(p => p.tools.every(t => pluginTools.has(t) || /^(read|write|edit|glob|grep|bash|pwsh|web_search|web_fetch|skill)$/.test(t)))
	})())
	// 新增 lib 模块必须进 files 白名单（check-plugin-files.mjs 的同一条规则，在这里先挡一道）
	ok('② 新模块都在 package.json 的 files 白名单', (() => {
		const agentsPkg = JSON.parse(read('dsh-plugins/vssaros-agents/package.json'))
		const skillsPkg = JSON.parse(read('dsh-plugins/vssaros-skills/package.json'))
		return agentsPkg.files.includes('lib/core/packs.js')
			&& ['lib/core/skillBudget.js', 'lib/core/agentSkills.js', 'lib/core/longOutput.js']
				.every(f => skillsPkg.files.includes(f))
			&& read('package.json').includes('node dsh-plugins/check-agent-packs.mjs')
	})())
}

// ── ③ 长结果富媒体 ─────────────────────────────────────────────────────────
{
	const shortText = 'a\nb\nc';
	const short = long.clipLongOutput(shortText, { attachmentPath: '/tmp/full.md' });
	const many = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
	const clipped = long.clipLongOutput(many, { maxLines: 10, maxChars: 5000, attachmentPath: '/skills/x/SKILL.md' });
	ok('③ 短正文不截断', !short.truncated && short.preview === shortText && !short.attachmentPath)
	ok('③ 超阈值只留前 N 行且给完整路径', clipped.truncated && clipped.keptLines === 10 && clipped.totalLines === 200
		&& clipped.attachmentPath === '/skills/x/SKILL.md' && clipped.preview.startsWith('line 0'))
	ok('③ 说明里明说行数与路径（不假装是全文）', long.longOutputNote(clipped).includes('10/200')
		&& long.longOutputNote(clipped).includes('/skills/x/SKILL.md') && long.longOutputNote(short) === '')
	ok('③ 按字符预算也会截', long.clipLongOutput('x'.repeat(30000), { maxLines: 99999, maxChars: 100 }).truncated)
	ok('③ read_skill / skill_search 的 render 都接了裁剪', skillsSrc.includes('clipLongOutput(value.content')
		&& skillsSrc.includes('clipLongOutput(lines.join')
		&& (skillsSrc.match(/clipLongOutput\(/g) || []).length >= 2)
	ok('③ output.schema 扩了 truncated / attachmentPath 且没动 description',
		(skillsSrc.match(/attachmentPath: \{ type: 'string' \}/g) || []).length === 2
		&& (skillsSrc.match(/truncated: \{ type: 'boolean' \}/g) || []).length >= 2)
	ok('③ 工具快照与源码工具名一致（改了工具就跑 --only vssaros-skills --write）', (() => {
		const snap = JSON.parse(read('dsh-plugins/tools-snapshot.json'))
		const names = (snap.plugins['vssaros-skills'] ?? []).map(e => e.name).sort()
		const source = [...read('dsh-plugins/vssaros-skills/lib/index.js').matchAll(/name: '(capability_attach|capability_search|list_skills|read_skill|skill_context|skill_manage|skill_search)'/g)].map(m => m[1])
		// 快照条目数 = 源码工具数；total = 所有插件条目之和（不写死数字，新增工具只需 --write）
		const sum = Object.values(snap.plugins).reduce((n, list) => n + list.length, 0)
		return names.length === new Set(source).size && names.every(n => source.includes(n)) && snap.total === sum
	})())
}

// ── ④ MCP stdio 授权 ───────────────────────────────────────────────────────
{
	const GATE = 'stdio 服务器未批准（在 mcp.json 里给该条加 "approved": true 才会启动本机进程）';
	ok('④ 插件侧与 IDE 侧判据逐字同形', mcpHostSrc.includes('if (config.approved !== true)') && mcpIdeSrc.includes('if (config.approved !== true)')
		&& mcpHostSrc.includes(GATE) && mcpIdeSrc.includes(GATE))
	const base = { servers: { local: { type: 'stdio', command: 'node', args: ['x.js'] } } };
	const unapproved = mcp.parseMcpServers(JSON.stringify(base), {});
	const approved = mcp.parseMcpServers(JSON.stringify({ servers: { local: { ...base.servers.local, approved: true } } }), {});
	const http = mcp.parseMcpServers(JSON.stringify({ servers: { remote: { type: 'http', url: 'https://example.test/mcp' } } }), {});
	ok('④ stdio 未 approved ⇒ 跳过（不起本机进程）', unapproved.servers.length === 0
		&& unapproved.skipped.some(s => s.reason.includes('未批准')))
	ok('④ stdio 显式 approved ⇒ 正常挂载', approved.servers.length === 1 && approved.servers[0].transport === 'stdio')
	ok('④ http 不受该约束（不起进程）', http.servers.length === 1 && http.servers[0].transport === 'streamable-http')
	ok('④ 现有配置零影响（本机没有 stdio 服务器）', (() => {
		try {
			const cfg = JSON.parse(readFileSync('C:/Users/qiuzijian/.vssaros-dev/mcp.json', 'utf8'))
			return !Object.values(cfg.servers ?? {}).some(s => s.type === 'stdio' || (!s.type && s.command))
		} catch { return true }
	})())
}

// ── 反向突变（内存副本，判据必须变红）────────────────────────────────────
{
	const verdict = src => ({
		union: src.includes('mergeCapabilities(agent.tools, agent.skills, agent.capabilities)') && src.includes('toDshTools(merged.tools)'),
		budget: src.includes('toolBudgetProblems(merged.tools)'),
		clipRender: src.includes('clipLongOutput(value.content') && src.includes('clipLongOutput(lines.join'),
		approval: src.includes('if (config.approved !== true)'),
	})
	const baseline = verdict(agentsSrc + skillsSrc + mcpHostSrc)
	ok('反向突变基线全绿', Object.values(baseline).every(Boolean), JSON.stringify(baseline))
	const cases = [
		['pack 改成减法（丢掉显式 tools）', agentsSrc, 'mergeCapabilities(agent.tools, agent.skills, agent.capabilities)', 'expandPacks(agent.capabilities)', 'union'],
		['预算守卫拿掉', agentsSrc, 'toolBudgetProblems(merged.tools)', '[]', 'budget'],
		['长结果裁剪拿掉', skillsSrc, 'clipLongOutput(value.content', 'String(value.content ??', 'clipRender'],
		['stdio 门控拿掉', mcpHostSrc, "if (config.approved !== true) {", 'if (false) {', 'approval'],
	]
	for (const [label, src, from, to, key] of cases) {
		const mutated = src.replace(from, () => to)
		const changed = mutated !== src
		const combined = key === 'union' || key === 'budget' ? mutated + skillsSrc + mcpHostSrc
			: key === 'clipRender' ? agentsSrc + mutated + mcpHostSrc : agentsSrc + skillsSrc + mutated
		ok(`反向突变 ${label} ⇒ 判据变红`, changed && verdict(combined)[key] === false,
			`changed=${changed} got=${verdict(combined)[key]}`)
	}
}

console.log(problems.length ? `\n✗ check-agent-packs：${problems.length} 项失败` : '\n✓ check-agent-packs：全部通过')
if (problems.length) { for (const p of problems) { console.log(`  ✗ ${p}`); } }
process.exitCode = problems.length ? 1 : 0
