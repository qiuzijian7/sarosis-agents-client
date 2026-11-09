// @vssaros/dsh-plugins — L3 能力工具 / MCP 状态机守卫（2026-11-08）
//
// 跑法：node dsh-plugins/check-capability-tools.mjs
//
// 钉住：
//   ① capability_search 有界检索：上限 20、诚实 "N more"、tier/attached 状态正确
//   ② capability_attach 只挂本会话、不落盘、有上限、attach 后 invalidate 让目录重建
//   ③ 两个工具定义完整（output.schema 顶层合法、render 存在、快照已同步）
//   ④ MCP 双侧 state 同形；needs-approval 与 error 分开；mcpStateView 汇总正确
//   ⑤ 基座/回退不受影响
// 外加反向突变自检（内存副本）。
import { readFileSync } from 'node:fs';
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

const tools = await mod('dsh-plugins/vssaros-skills/lib/core/capabilityTools.js');
const bundled = await mod('dsh-plugins/vssaros-skills/lib/core/bundledSkills.js');
const caps = await mod('dsh-plugins/vssaros-skills/lib/core/capabilityLibrary.js');
const providerMod = await mod('dsh-plugins/vssaros-skills/lib/core/bundledProvider.js');
const indexSrc = read('dsh-plugins/vssaros-skills/lib/index.js');
const agentSrc = read('dsh-plugins/vssaros-agents/lib/index.js');
const jsMcp = read('dsh-plugins/vssaros-mcp/lib/core/mcpConfig.js');
const tsMcp = read('src/vs/sessions/contrib/dshHarness/common/dshMcpConfig.ts');
const BUNDLED_ROOT = join(ROOT, 'dsh-plugins/vssaros-skill-bundle/skills');
const { index } = bundled.bundledTierIndex(BUNDLED_ROOT);
const library = caps.buildCapabilityLibrary(index);
const coreSet = caps.expandAttachments([caps.DEFAULT_CAPABILITY_PACK], [], library).names;

console.log('check-capability-tools：L3 能力工具 / MCP 状态机');

// ── ① 有界检索 ───────────────────────────────────────────────────────────
{
	const all = tools.searchCapabilities(library, coreSet, '');
	ok('① 空查询覆盖整个能力库 174 条', all.total === 174, `total=${all.total}`);
	// omitted 从 total 推导：每加一个技能都会变，写死数字会让守卫假红（2026-11-09 GRBug 专家 +1 踩过）。
	ok('① 返回有界 20 条且诚实报 omitted', all.items.length === 20 && all.omitted === all.total - 20,
		`items=${all.items.length} omitted=${all.omitted} total=${all.total}`);
	// 直接钉住上限常量：库只有 174 条时「把上限改成 100000」不会立刻改 items 数，
	// 但会让未来的大能力库失去保护 ⇒ 必须断言常量与 clamp 都还在。
	ok('① 检索上限常量 = 20 且 clamp 用它', tools.CAPABILITY_SEARCH_MAX === 20
		&& read('dsh-plugins/vssaros-skills/lib/core/capabilityTools.js').includes('CAPABILITY_SEARCH_MAX, CAPABILITY_SEARCH_MAX)'));
	ok('① 显式传超大 limit 仍被夹到 20', tools.searchCapabilities(library, coreSet, '', 100000).items.length === 20);
	const hit = tools.searchCapabilities(library, coreSet, 'act-on-feedback');
	ok('① 精确命中未列出的 extended 技能，状态正确',
		hit.total === 1 && hit.items[0].tier === 'extended' && hit.items[0].attached === false);
	const legacy = tools.searchCapabilities(library, null, 'act-on-feedback');
	ok('① legacy（attached=null）全部标为已可见', legacy.items[0]?.attached === true);
	const none = tools.searchCapabilities(library, coreSet, 'zzzz-no-such-skill');
	ok('① 无命中时给明确提示而不是空串', none.total === 0 && tools.renderCapabilityRows(none).includes('没有匹配'));
	ok('① render 明说取正文/挂载路径', tools.renderCapabilityRows(all).includes('read_skill')
		&& tools.renderCapabilityRows(all).includes('capability_attach'));
}

// ── ② 会话级挂载 ─────────────────────────────────────────────────────────
{
	const store = tools.createCapabilityAttachments();
	ok('② 会话隔离：A 挂的不出现在 B', (() => {
		store.attach('session-A', 'act-on-feedback');
		return store.namesFor('session-A').has('act-on-feedback') && !store.namesFor('session-B').has('act-on-feedback');
	})());
	ok('② 重复挂载返回 exists，不重复计数', store.attach('session-A', 'act-on-feedback') === 'exists');
	ok('② detach / clear 生效', (() => {
		store.detach('session-A', 'act-on-feedback');
		const cleared = !store.namesFor('session-A').has('act-on-feedback');
		store.attach('session-A', 'x'); store.clear('session-A');
		return cleared && store.namesFor('session-A').size === 0;
	})());
	const capped = tools.createCapabilityAttachments(2);
	capped.attach('s', 'a'); capped.attach('s', 'b');
	ok('② 达上限返回 full，不再扩张', capped.attach('s', 'c') === 'full' && capped.namesFor('s').size === 2);
	ok('② 空会话 id 返回 null（不静默挂到全局）', store.attach('', 'x') === null);
	ok('② attachProblems 拒绝幽灵名 / 包名，放行真实技能',
		tools.attachProblems('ghost', library).some(p => p.includes('没有'))
		&& tools.attachProblems('core', library).some(p => p.includes('能力包名'))
		&& tools.attachProblems('act-on-feedback', library).length === 0);

	// 真跑 provider：会话 attach 之后该技能变 modelInvocable
	const store2 = tools.createCapabilityAttachments();
	const p = providerMod.createBundledProvider({
		index, library, mode: 'attached', dataRoot: '/nonexistent',
		agentIdOfPreset: () => 'coder',
		sessionAttachments: store2,
		attachmentsForAgent: () => ({ names: new Set(coreSet), problems: [] }),
	});
	const scope = { session: { id: 'sess-1', header: { agentPreset: 'vssaros-coder' } } };
	const before = await p.list({ scope });
	ok('② attach 前 extended 技能不可见', before.find(c => c.name === 'act-on-feedback')?.invocation.modelInvocable === false);
	store2.attach('sess-1', 'act-on-feedback');
	const after = await p.list({ scope });
	ok('② attach 后同会话变可见（provider 合并成功）',
		after.find(c => c.name === 'act-on-feedback')?.invocation.modelInvocable === true);
	const other = await p.list({ scope: { session: { id: 'sess-2', header: { agentPreset: 'vssaros-coder' } } } });
	ok('② 别的会话仍不可见', other.find(c => c.name === 'act-on-feedback')?.invocation.modelInvocable === false);
}

// ── ③ 工具定义 / 快照 ────────────────────────────────────────────────────
{
	ok('③ capability_search 已注册且 render 走能力库渲染器',
		indexSrc.includes("name: 'capability_search'") && indexSrc.includes('renderCapabilityRows(value)'));
	ok('③ capability_attach 已注册且 render 走结构化 message',
		indexSrc.includes("name: 'capability_attach'") && indexSrc.includes('value.message'));
	// output.schema 的官方 assertSupportedJsonSchema 校验由 check-tool-definitions.mjs 真跑覆盖
	// （它伪 ctx 真跑 apply 收集 register 实参，不在这里用正则重造一份脆弱判据）。
	ok('③ 两个新工具都在官方 schema 守卫的覆盖范围内（守卫在根链且真跑 apply）',
		read('package.json').includes('node dsh-plugins/check-tool-definitions.mjs')
		&& read('dsh-plugins/check-tool-definitions.mjs').includes('officialBadness'));
	ok('③ 两个新工具都声明了 output.schema 的 properties / required / render', (() => {
		const seg = indexSrc.slice(indexSrc.indexOf("name: 'capability_search'"), indexSrc.indexOf("name: 'skill_search'"));
		return (seg.match(/type: 'object'/g) || []).length >= 2
			&& (seg.match(/required: \[/g) || []).length >= 4
			&& (seg.match(/render: /g) || []).length === 2;
	})());
	ok('③ attach 后调 invalidateBundled（官方 registry 重取 ⇒ 目录重发）',
		indexSrc.includes('invalidateBundled?.()') && indexSrc.includes('invalidateBundled = () => control.invalidate()'));
	ok('③ capability_attach 不写盘 / 不碰 .agent.md',
		!/\bwriteFileSync\b/.test(indexSrc.slice(indexSrc.indexOf("name: 'capability_attach'"), indexSrc.indexOf("name: 'capability_attach'") + 3000)));
	const snap = JSON.parse(read('dsh-plugins/tools-snapshot.json'));
	const names = (snap.plugins['vssaros-skills'] ?? []).map(e => e.name);
	ok('③ 快照已同步（7 个工具、total 与条目和一致）',
		names.includes('capability_search') && names.includes('capability_attach') && names.length === 7
		&& snap.total === Object.values(snap.plugins).reduce((n, l) => n + l.length, 0),
		`names=${names.length} total=${snap.total}`);
	ok('③ 新模块进了 files 白名单', (() => {
		const pkg = JSON.parse(read('dsh-plugins/vssaros-skills/package.json'));
		return pkg.files.includes('lib/core/capabilityTools.js');
	})());
	ok('③ 守卫已接入根链', read('package.json').includes('node dsh-plugins/check-capability-tools.mjs'));
}

// ── ④ MCP 结构化状态（双侧同形）────────────────────────────────────────
{
	const markers = ["const skip = (reason, state = 'error') => skipped.push({ name, reason, state });",
		"skip('stdio 服务器未批准", "'needs-approval'",
		'export function mcpStateView('];
	for (const [label, src] of [['插件侧', jsMcp], ['IDE 侧', tsMcp]]) {
		ok(`④ ${label} 有结构化 state + 状态汇总`,
			src.includes('needs-approval') && src.includes('mcpStateView') && src.includes("'error'"));
	}
	const approvalCall = /skip\('stdio 服务器未批准[\s\S]{0,220}?'needs-approval'\)/;
	ok('④ 双侧 needs-approval 文案与缺省 error 同形',
		jsMcp.includes("'needs-approval'") && tsMcp.includes("'needs-approval'")
		&& jsMcp.includes("state = 'error'") && tsMcp.includes("state: McpServerState = 'error'"));
	ok('④ 双侧「未批准」那次 skip 真的传了 needs-approval（不是别处留了个字符串）',
		approvalCall.test(jsMcp) && approvalCall.test(tsMcp));
	const mcp = await mod('dsh-plugins/vssaros-mcp/lib/core/mcpConfig.js');
	const parsed = mcp.parseMcpServers(JSON.stringify({ servers: {
		local: { type: 'stdio', command: 'node' },
		remote: { type: 'http', url: 'https://x/mcp' },
		broken: { type: 'sse', url: 'https://x/sse' },
	} }));
	const view = mcp.mcpStateView(parsed);
	ok('④ 状态机区分 needs-approval / error / ready',
		view.counts['needs-approval'] === 1 && view.counts.error === 1 && view.counts.ready === 1
		&& view.pendingApproval === true, JSON.stringify(view.counts));
	const approved = mcp.parseMcpServers(JSON.stringify({ servers: {
		local: { type: 'stdio', command: 'node', approved: true },
	} }));
	ok('④ approved:true 后从 needs-approval 变 ready',
		mcp.mcpStateView(approved).counts.ready === 1 && !mcp.mcpStateView(approved).pendingApproval);
	ok('④ 老配置（无 state 字段）按 error 兜底，不静默变 ready',
		mcp.mcpStateView({ servers: [], skipped: [{ name: 'old', reason: 'x' }] }).counts.error === 1);
	void markers; void agentSrc;
}

// ── ⑤ 回退与反向突变 ────────────────────────────────────────────────────
{
	ok('⑤ legacy 一键回退仍在', indexSrc.includes("config?.skillScopeMode ?? 'attached'"));
	ok('⑤ 全局 bundled 行仍停用', !/^\s*- id: vssaros-skill-bundle-fs\s*$/m.test(read('dsh-plugins/vssaros-skill-bundle/cordis.patch.yml')));
	ok('⑤ 双根 agent 服务仍在', agentSrc.includes('attachmentsOf: async (preset)'));

	const verdict = (src) => ({
		search: src.includes("name: 'capability_search'"),
		attach: src.includes("name: 'capability_attach'"),
		// ★ 2026-11-09：`vssarosSkills` 服务里也有一处 invalidateBundled（写盘后重建目录）。
		//   这里要钉的是 **capability_attach 挂载成功后**那一处 ⇒ 用带注释的唯一串。
		invalidate: src.includes('// 让官方 registry 重新 collect ⇒ 官方目录自己重发（我们不改任何消息）')
			&& /try \{ invalidateBundled\?\.\(\); \} catch \{ \/\* invalidate 失败不阻断挂载 \*\/ \}/.test(src),
		sessionStore: src.includes('sessionAttachments: SESSION_ATTACHMENTS'),
	});
	const base = verdict(indexSrc);
	ok('反向突变基线全绿', Object.values(base).every(Boolean), JSON.stringify(base));
	const cases = [
		['去掉 capability_search', "name: 'capability_search',", "name: 'capability_search_DISABLED',", 'search'],
		['去掉 capability_attach', "name: 'capability_attach',", "name: 'capability_attach_DISABLED',", 'attach'],
		['attach 后不 invalidate', "try { invalidateBundled?.(); } catch { /* invalidate 失败不阻断挂载 */ }", 'void 0', 'invalidate'],
		['provider 不接收会话 attach', 'sessionAttachments: SESSION_ATTACHMENTS,', '', 'sessionStore'],
	];
	for (const [label, from, to, key] of cases) {
		const mutated = indexSrc.replace(from, () => to);
		ok(`反向突变 ${label} ⇒ 判据变红`, mutated !== indexSrc && verdict(mutated)[key] === false);
	}
}

console.log(problems.length ? `\n✗ check-capability-tools：${problems.length} 项失败` : '\n✓ check-capability-tools：全部通过');
if (problems.length) { for (const p of problems) { console.log(`  ✗ ${p}`); } }
process.exitCode = problems.length ? 1 : 0;
