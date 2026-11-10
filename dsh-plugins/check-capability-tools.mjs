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

// ── ⑥ MCP 写口契约（2026-11-10）────────────────────────────────────────────
// 钉住「装了不生效」：写口只写 `servers`，且写出来的条目必须能被 parseMcpServers 吃到。
// 原来的 `mcp_install` 写 `mcpServers`、条目缺 `type`、http 把 env 写成 env，三处都让安装变成空操作。
{
	const mcpIndex = await mod('dsh-plugins/vssaros-mcp/lib/index.js');
	const mcpSrc = read('dsh-plugins/vssaros-mcp/lib/index.js');
	const market = await mod('dsh-plugins/vssaros-marketplace/lib/mcpInstall.js');
	const parser = await mod('dsh-plugins/vssaros-mcp/lib/core/mcpConfig.js');
	ok('⑥ 写盘计划是导出的纯函数（可做行为断言，不靠正则猜）', typeof mcpIndex.planMcpInstall === 'function');
	const stdio = mcpIndex.planMcpInstall({}, { name: 'demo', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] });
	ok('⑥ 只写 servers 且解析侧读得到（不再有 mcpServers）',
		!!stdio.next.servers?.demo && !('mcpServers' in stdio.next)
		&& parser.parseMcpServers(JSON.stringify(stdio.next), {}).skipped
			.some(s => s.name === 'demo' && s.state === 'needs-approval'));
	ok('⑥ stdio 条目带 type + 显式 approved:false', stdio.entry.type === 'stdio' && stdio.entry.approved === false);
	const http = mcpIndex.planMcpInstall({}, { name: 'remote', transport: 'http', url: 'https://x/mcp', env: { Authorization: 'Bearer x' } });
	ok('⑥ http 把 env 写成 headers（解析侧读的是 headers）',
		http.entry.type === 'http' && http.entry.headers?.Authorization === 'Bearer x' && !('env' in http.entry)
		&& parser.parseMcpServers(JSON.stringify(http.next), {}).servers.length === 1);
	const legacy = mcpIndex.planMcpInstall(
		{ mcpServers: { old: { command: 'node' } }, inputs: [] },
		{ name: 'new', transport: 'http', url: 'https://x/mcp' });
	ok('⑥ 历史 mcpServers 合并迁移、补 type、不自动授权、保留其它键',
		!('mcpServers' in legacy.next) && legacy.next.servers.old?.type === 'stdio'
		&& legacy.next.servers.old?.approved === undefined && Array.isArray(legacy.next.inputs)
		&& !!legacy.next.servers.new);
	ok('⑥ 已存在条目不覆盖', (() => {
		try { mcpIndex.planMcpInstall({ servers: { demo: { type: 'http', url: 'https://x' } } }, { name: 'demo', transport: 'http', url: 'https://y' }); return false; }
		catch (e) { return String(e.message).includes('已存在'); }
	})());
	ok('⑥ sse / 非法名 / 缺 command 一律拒绝', (() => {
		const bad = [
			{ name: 'remote', transport: 'sse', url: 'https://x/sse' },
			{ name: 'a'.repeat(33), transport: 'http', url: 'https://x' },
			{ name: 'local', transport: 'stdio' },
		];
		return bad.every(p => { try { mcpIndex.planMcpInstall({}, p); return false; } catch { return true; } });
	})());
	ok('⑥ 商城写口同样显式 approved:false', market.toMcpEntry({ transport: 'stdio', command: 'npx' }).approved === false);
	ok('⑥ 工具 schema 的 transport 枚举不含 sse', !/enum:\s*\[[^\]]*'sse'/.test(mcpSrc));
	ok('⑥ 反向突变（全量去掉旧键清理）⇒ 判据变红', (() => {
		// planMcpInstall / planMcpRemove 两个写口都有这行 ⇒ 单处 replace 会假绿，必须全量替换。
		const needle = 'delete next.mcpServers;';
		const count = s => s.split(needle).length - 1;
		const verdict = s => s.includes('const next = { ...raw, servers };') && count(s) >= 2;
		return verdict(mcpSrc) && !verdict(mcpSrc.split(needle).join(''));
	})());
}

// ── ⑦ 运行时 MCP 挂载骨架（2026-11-10）────────────────────────────────────
// 依据 P3-110（官方 boot 真组合树 9/9）：cordis 原生路径可行。这里钉住开关两侧同源、
// 缺省关闭、supervisor 让路，以及 reconcile 骨架的离线行为（不依赖真 Host）。
{
	const rt = await mod('dsh-plugins/vssaros-mcp/lib/core/mcpRuntime.js');
	const jsRt = read('dsh-plugins/vssaros-mcp/lib/core/mcpRuntime.js');
	const idx = read('dsh-plugins/vssaros-mcp/lib/index.js');
	const sup = read('src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts');
	const ENV = 'VSSAROS_MCP_RUNTIME_MOUNT';
	ok('⑦ 两侧开关同一个环境变量、同值判据',
		jsRt.includes(`'${ENV}'`) && tsMcp.includes(`'${ENV}'`)
		&& jsRt.includes("!== '0'") && tsMcp.includes("!== '0'"));
	ok('⑦ 开关缺省启用、显式 0 回退到旧覆盖层',
		rt.isMcpRuntimeMountEnabled({}) === true
		&& rt.isMcpRuntimeMountEnabled({ [ENV]: '1' }) === true
		&& rt.isMcpRuntimeMountEnabled({ [ENV]: '0' }) === false);
	const mcpPageJs = read('dsh-plugins/vssaros-mcp/lib/core/mcpConfig.js');
	ok('⑦ UI 文案随开关切换，不再无条件写死「需重启 Host」',
		mcpPageJs.includes('runtimeMount') && mcpPageJs.includes('无需重启 Host'));
	ok('⑦ supervisor 有让路早返回且保留原渲染器（静态形状守卫不受影响）',
		sup.includes('if (isMcpRuntimeMountEnabled())') && sup.includes('renderMcpOverlay(servers)'));
	ok('⑦ 插件入口接入运行时挂载',
		idx.includes('installRuntimeMount(ctx, config)') && jsRt.includes('export const isMcpRuntimeMountEnabled'));
	ok('⑦ restartNeeded 跟随挂载模型，不再写死 true',
		idx.includes('restartNeeded: !isMcpRuntimeMountEnabled()'));
	ok('⑦ 安装回执按 restartNeeded 分流，不写死「重启 Host 后生效」',
		idx.includes('value.restartNeeded ?') && !idx.includes('——重启 Host 后生效'));

	// 离线 fake ctx：完整跑一遍「新增 → 指纹短路 → 改配置重挂 → 删除 → 全卸」
	const made = [];
	const fakeCtx = {
		plugin(_client, config) {
			const rec = { config, disposed: false };
			made.push(rec);
			return { await: async () => {}, dispose: () => { rec.disposed = true; } };
		},
	};
	const client = { name: 'mcp-client', apply() {} };
	const r = new rt.McpRuntime({ ctx: fakeCtx, client });
	const sA = { serverName: 'a', transport: 'stdio', command: 'npx', args: ['x'] };
	const sB = { serverName: 'b', transport: 'streamable-http', url: 'https://x/mcp' };
	await r.reconcile([sA, sB]);
	ok('⑦ reconcile 新增两台，config 与渲染器同形',
		made.length === 2 && made[0].config.serverName === 'a' && made[0].config.failOnStartupError === true
		&& made[1].config.transport === 'streamable-http' && Object.keys(r.statusView()).length === 0);
	await r.reconcile([sA, sB]);
	ok('⑦ 指纹不变不重复挂载', made.length === 2);
	await r.reconcile([{ ...sA, args: ['y'] }, sB]);
	ok('⑦ 配置变化先 dispose 旧 fiber 再重挂',
		made.length === 3 && made[0].disposed === true && made[2].config.args[0] === 'y');
	await r.reconcile([sB]);
	ok('⑦ 配置里删掉的服务器被卸载', made[2].disposed === true && !r.mounts.has('a'));
	await r.stop();
	ok('⑦ stop() 卸载全部且状态清空', made.every(m => m.disposed) && Object.keys(r.statusView()).length === 0);

	// 失败分支：保留失败指纹，不反复重试同一坏配置
	let attempts = 0;
	const failCtx = { plugin() { attempts++; return { await: async () => { throw new Error('boom'); }, dispose() {} }; } };
	const r2 = new rt.McpRuntime({ ctx: failCtx, client });
	await r2.reconcile([sA]);
	await r2.reconcile([sA]);
	ok('⑦ 挂载失败保留指纹，不反复重试同一坏配置', attempts === 1 && r2.statusView().a?.state === 'error');
	await r2.stop();

	ok('⑦ 反向突变（去掉让路早返回）⇒ 判据变红', (() => {
		const verdict = s => s.includes('if (isMcpRuntimeMountEnabled())');
		return verdict(sup) && !verdict(sup.replace('if (isMcpRuntimeMountEnabled()) {', 'if (false) {'));
	})());
}

// ── ⑧ 跨应用 MCP 导入 + 运行期状态 UI（2026-11-10）────────────────────────
{
	const imp = await mod('dsh-plugins/vssaros-mcp/lib/core/mcpImport.js');
	const impSrc = read('dsh-plugins/vssaros-mcp/lib/core/mcpImport.js');
	const idx2 = read('dsh-plugins/vssaros-mcp/lib/index.js');
	const pageSrc = read('dsh-plugins/vssaros-mcp/lib/core/mcpConfig.js');

	const win = imp.importSourcePaths({ env: { APPDATA: 'C:/Users/x/AppData/Roaming' }, home: 'C:/Users/x', os: 'win32' });
	const mac = imp.importSourcePaths({ env: {}, home: '/Users/x', os: 'darwin' });
	const lin = imp.importSourcePaths({ env: {}, home: '/home/x', os: 'linux' });
	ok('⑧ 三个来源 + 三种平台路径（claude/cursor/vscode，vscode 读 servers 键）',
		win.length === 3 && win[0].source === 'claude' && win[2].key === 'servers'
		&& win[0].path.includes('AppData') && mac[0].path.includes('Library')
		&& lin[0].path.includes('.config'));

	const fixtures = {
		'/claude.json': JSON.stringify({ mcpServers: {
			local: { command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'RAW-SECRET' } },
			remote: { url: 'https://x.example/mcp?key=SECRET-IN-URL', headers: { Authorization: 'Bearer RAW' } },
			sse: { type: 'sse', url: 'https://x.example/sse' },
			placeholder: { command: '${workspaceFolder}/run' },
		} }),
		'/cursor.json': JSON.stringify({ mcpServers: { cur: { serverUrl: 'https://cursor.example/mcp' } } }),
	};
	const paths = [
		{ source: 'claude', key: 'mcpServers', path: '/claude.json' },
		{ source: 'cursor', key: 'mcpServers', path: '/cursor.json' },
		{ source: 'vscode', key: 'servers', path: '/missing.json' },
	];
	const readFake = async p => { if (p in fixtures) { return fixtures[p]; } throw new Error('ENOENT'); };
	const items = await imp.scanImportSources({ paths, read: readFake });
	ok('⑧ 只读扫描：缺失/坏文件静默跳过，claude+cursor 共 5 项', items.length === 5);
	const view = imp.toImportView(items);
	ok('⑧ 视图不含任何凭据值（键名可见、URL query 已脱敏）',
		!JSON.stringify(view).includes('RAW-SECRET') && !JSON.stringify(view).includes('Bearer RAW')
		&& !JSON.stringify(view).includes('SECRET-IN-URL') && view.some(v => v.envKeys.includes('TOKEN'))
		&& view.some(v => v.target.includes('<redacted>')));

	const plan = imp.planImport({ items, raw: { servers: { local: { type: 'http', url: 'https://existing' } }, inputs: [] } });
	ok('⑧ 导入写 servers、同名不覆盖、保留其它顶层键',
		!!plan.next.servers.remote && plan.next.servers.local.url === 'https://existing'
		&& plan.next.servers.cur.type === 'http' && Array.isArray(plan.next.inputs)
		&& !('mcpServers' in plan.next));
	ok('⑧ sse / 占位符 / 同名被跳过并说明原因',
		plan.skipped.some(s => s.name === 'claude:sse' && /sse/.test(s.reason))
		&& plan.skipped.some(s => s.name === 'claude:placeholder' && /\$\{/.test(s.reason))
		&& plan.skipped.some(s => s.name === 'claude:local' && /同名/.test(s.reason)));
	ok('⑧ stdio 导入显式 approved:false（不自动授权本机进程）',
		imp.planImport({ items, picked: ['claude:local'] }).next.servers.local.approved === false);
	ok('⑧ picked 只导入选中项', imp.planImport({ items, picked: ['cursor:cur'] }).added.join(',') === 'cur');
	ok('⑧ 名字约束与 planMcpInstall 同形',
		impSrc.includes('/^[A-Za-z0-9_-]{1,32}$/') && idx2.includes('/^[A-Za-z0-9_-]{1,32}$/'));

	ok('⑧ mcp_import 已注册且审批闸覆盖它（fail-closed）',
		idx2.includes("name: 'mcp_import'") && idx2.includes("exec.name === 'mcp_import'"));
	ok('⑧ 缺省 scan 只读（不写盘）',
		idx2.includes("String(params?.action ?? 'scan')") && idx2.includes("if (action === 'scan')"));
	ok('⑧ 运行期状态接入片段且不谎报就绪',
		idx2.includes('runtimeStatus: activeMcpRuntime?.statusView() ?? null')
		&& pageSrc.includes('runtimeStatus === null') && pageSrc.includes('首次同步尚未完成'));
	const statusHtml = (await mod('dsh-plugins/vssaros-mcp/lib/core/mcpConfig.js')).renderSection({
		path: '/x/mcp.json', exists: true, parsed: { servers: [], skipped: [] }, toolCount: '0', toolList: [],
		runtimeMount: true, runtimeStatus: { bad: { state: 'error', error: 'boom' } },
	});
	ok('⑧ 片段渲染报错状态（data-vssaros-mcp-runtime-errors）',
		statusHtml.includes('data-vssaros-mcp-runtime-errors="1"') && statusHtml.includes('boom'));
	ok('⑧ 反向突变（去掉审批闸覆盖）⇒ 判据变红', (() => {
		const verdict = s => s.includes("exec.name === 'mcp_import'");
		return verdict(idx2) && !verdict(idx2.replace("exec.name === 'mcp_import'", 'false'));
	})());
}

// ── ⑨ dsh 侧 OSV 供应链预检（2026-11-10）──────────────────────────────────
// IDE 侧 mcpSupplyChain.ts 是退役残留；这里钉住 dsh 侧真源的三条纪律与两个写口接线。
{
	const osv = await mod('dsh-plugins/vssaros-mcp/lib/core/mcpOsv.js');
	const idx3 = read('dsh-plugins/vssaros-mcp/lib/index.js');

	const npx = osv.extractPackages('npx', ['-y', '@modelcontextprotocol/server-github@latest']);
	ok('⑨ 包提取：npx 的 scoped 包去版本', npx.length === 1
		&& npx[0].name === '@modelcontextprotocol/server-github' && npx[0].ecosystem === 'npm', JSON.stringify(npx));
	ok('⑨ 包提取：uvx → PyPI', osv.extractPackages('uvx', ['mcp-server-time'])[0]?.ecosystem === 'PyPI');
	ok('⑨ 本地路径 / 自有二进制不查（宁可漏报不误拦）',
		osv.extractPackages('node', ['./server.mjs']).length === 0
		&& osv.extractPackages('comfy-mcp', []).length === 0);
	const refs = [{ name: 'bad-pkg', ecosystem: 'npm' }, { name: 'cve-pkg', ecosystem: 'npm' }];
	const hits = osv.parseOsvQueryBatch({
		results: [{ vulns: [{ id: 'MAL-2026-1', aliases: ['GHSA-x'] }] }, { vulns: [{ id: 'CVE-2020-1' }] }],
	}, refs);
	ok('⑨ 只取 MAL-*（含 aliases），普通 CVE 忽略',
		hits.length === 1 && hits[0].name === 'bad-pkg' && hits[0].ids.includes('MAL-2026-1'));

	let calls = 0;
	const fakeFetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ results: [{}] }) }; };
	const clean = await osv.checkPackagesAgainstOsv([{ name: 'clean-pkg', ecosystem: 'npm' }],
		{ fetchImpl: fakeFetch, now: () => 1000 });
	ok('⑨ 查通干净 ⇒ clean', clean.status === 'clean' && calls === 1);
	const cached = await osv.checkPackagesAgainstOsv([{ name: 'clean-pkg', ecosystem: 'npm' }],
		{ fetchImpl: fakeFetch, now: () => 2000 });
	ok('⑨ 1h 内命中缓存，不打网络', cached.status === 'clean' && calls === 1);
	const expired = await osv.checkPackagesAgainstOsv([{ name: 'clean-pkg', ecosystem: 'npm' }],
		{ fetchImpl: fakeFetch, now: () => 1000 + osv.OSV_CACHE_TTL_MS + 1 });
	ok('⑨ 超过 TTL 重新查询', expired.status === 'clean' && calls === 2);
	const unknown = await osv.checkPackagesAgainstOsv([{ name: 'offline-pkg', ecosystem: 'npm' }],
		{ fetchImpl: async () => { throw new Error('offline'); }, now: () => 10000 });
	ok('⑨ 网络失败 unknown（fail-open）', unknown.status === 'unknown' && /offline/.test(unknown.reason ?? ''));
	const again = await osv.checkPackagesAgainstOsv([{ name: 'offline-pkg', ecosystem: 'npm' }],
		{ fetchImpl: fakeFetch, now: () => 10001 });
	ok('⑨ 失败不缓存（下次仍真查，绝不假装已验证）', again.status === 'clean' && calls === 3);
	const blocked = await osv.checkPackagesAgainstOsv([{ name: 'evil-pkg', ecosystem: 'npm' }], {
		fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: [{ vulns: [{ id: 'MAL-2026-9' }] }] }) }),
		now: () => 20000,
	});
	ok('⑨ 命中恶意包 ⇒ blocked', blocked.status === 'blocked' && blocked.hits[0]?.ids.includes('MAL-2026-9'));
	const blockedText = osv.buildOsvBlockedMessage(blocked);
	ok('⑨ 阻断文案含公告 id 与关闭开关',
		blockedText.includes('MAL-2026-9') && blockedText.includes('VSSAROS_MCP_OSV=0'));
	ok('⑨ 缺省启用、=0 可关闭', osv.isOsvEnabled({}) === true && osv.isOsvEnabled({ VSSAROS_MCP_OSV: '0' }) === false);
	const singleMount = 'precheckOsv([next.servers[name]])';
	const countOsv = s => s.split(singleMount).length - 1;
	// 2026-11-10：mcp_install 与 mcp_catalog(install) 都是单条写口 ⇒ 同一串出现 2 次；
	// mcp_import 是批量写口。反向突变必须用**全量替换**，只 replace 第一处会假绿。
	ok('⑨ 三个安装写口都接了预检',
		countOsv(idx3) === 2 && idx3.includes('precheckOsv(added.map(name => next.servers[name]))'));
	const botPack = await mod('dsh-plugins/vssaros-marketplace/lib/botPack.js');
	ok('⑨ 商城回执按挂载模型分流（缺省 applied / =0 restart-required）',
		botPack.makeBotReceipt({}).mcp === 'applied'
		&& botPack.makeBotReceipt({ VSSAROS_MCP_RUNTIME_MOUNT: '0' }).mcp === 'restart-required');
	ok('⑨ fail-open 时回执如实提示「供应链预检未完成」，不静默',
		(idx3.match(/供应链预检未完成/g) ?? []).length === 2);
	ok('⑨ 商城判据与 dsh 侧同值（跨插件不 import，由本守卫钉住）',
		read('dsh-plugins/vssaros-marketplace/lib/botPack.js').includes("VSSAROS_MCP_RUNTIME_MOUNT === '0'")
		&& read('dsh-plugins/vssaros-mcp/lib/core/mcpRuntime.js').includes("!== '0'"));
	ok('⑨ 反向突变（全量去掉安装写口预检）⇒ 判据变红', (() => {
		return countOsv(idx3) === 2 && countOsv(idx3.split(singleMount).join('void 0')) === 0;
	})());
}

// ── ⑩ 远程 MCP 目录（2026-11-10）─────────────────────────────────────────
// 钉住「凭据型不装」这条产品判据：网关没落地时允许安装 = 制造永远连不上的条目。
{
	const cat = await mod('dsh-plugins/vssaros-mcp/lib/core/mcpCatalog.js');
	const idx4 = read('dsh-plugins/vssaros-mcp/lib/index.js');
	const all = cat.listCatalog();
	ok('⑩ 目录：6 项免登录可安装 + OAuth / API-key 型都在',
		all.filter(e => e.installable).length === 6
		&& all.some(e => e.auth === 'oauth') && all.some(e => e.auth === 'key'));
	ok('⑩ 所有条目都是 https 且 id 满足 dsh 的 [A-Za-z0-9_-]{1,32}',
		all.every(e => /^https:\/\//.test(e.url) && /^[A-Za-z0-9_-]{1,32}$/.test(e.id)));
	ok('⑩ query / category / installableOnly 三个过滤器',
		cat.listCatalog({ query: 'context7' }).length === 1
		&& cat.listCatalog({ category: 'docs' }).length >= 3
		&& cat.listCatalog({ installableOnly: true }).every(e => e.installable));
	const catPlan = cat.planCatalogInstall({ id: 'context7', raw: { mcpServers: { old: { command: 'node' } }, inputs: [] } });
	ok('⑩ 免登录项写 servers（type=http）、清旧键、保留其它顶层键',
		catPlan.next.servers.context7.type === 'http'
		&& catPlan.next.servers.context7.url === 'https://mcp.context7.com/mcp'
		&& !('mcpServers' in catPlan.next) && Array.isArray(catPlan.next.inputs));
	ok('⑩ OAuth 型 / 未知 id / 同名 / key 型缺凭据一律明确拒绝', (() => {
		const cases = [
			() => cat.planCatalogInstall({ id: 'notion' }),
			() => cat.planCatalogInstall({ id: 'no-such-id' }),
			() => cat.planCatalogInstall({ id: 'context7', raw: { servers: { context7: { type: 'http', url: 'https://x' } } } }),
			() => cat.planCatalogInstall({ id: 'amap' }),
		];
		return cases.every(fn => { try { fn(); return false; } catch { return true; } });
	})());
	const amapOk = cat.planCatalogInstall({ id: 'amap', env: { MCP_AMAP_KEY: 'K1' } });
	ok('⑩ key 型凭据已设置 ⇒ 可安装，且只写 query 引用模板（真值不进 mcp.json）',
		amapOk.next.servers.amap.type === 'http'
		&& amapOk.next.servers.amap.query.key === '${env:MCP_AMAP_KEY}'
		&& !JSON.stringify(amapOk.next).includes('K1'));
	ok('⑩ 工具注册、审批闸覆盖、缺省 list 只读',
		idx4.includes("name: 'mcp_catalog'") && idx4.includes("exec.name === 'mcp_catalog'")
		&& idx4.includes("String(params?.action ?? 'list')"));
	ok('⑩ 反向突变（去掉目录工具审批闸）⇒ 判据变红', (() => {
		const verdict = s => s.includes("exec.name === 'mcp_catalog'");
		return verdict(idx4) && !verdict(idx4.replace("exec.name === 'mcp_catalog'", 'false'));
	})());
}

// ── ⑪ 删除工具与只读片段的管理引导（2026-11-10）─────────────────────────
{
	const mcpMod = await mod('dsh-plugins/vssaros-mcp/lib/index.js');
	const idx5 = read('dsh-plugins/vssaros-mcp/lib/index.js');
	const page5 = read('dsh-plugins/vssaros-mcp/lib/core/mcpConfig.js');
	const rm = mcpMod.planMcpRemove(
		{ mcpServers: { old: { command: 'node' } }, servers: { keep: { type: 'http', url: 'https://x' } }, inputs: [] },
		{ name: 'old' });
	ok('⑪ 删除：写 servers、清旧键、保留其它服务器与顶层键',
		!rm.next.servers.old && rm.next.servers.keep.url === 'https://x'
		&& !('mcpServers' in rm.next) && Array.isArray(rm.next.inputs));
	ok('⑪ 删除：不存在 / 非法名明确拒绝（不做无操作写盘）', (() => {
		const base = { servers: { keep: { type: 'http', url: 'https://x' } } };
		const cases = [
			() => mcpMod.planMcpRemove(base, { name: 'nope' }),
			() => mcpMod.planMcpRemove(base, { name: 'Bad Name' }),
		];
		return cases.every(fn => { try { fn(); return false; } catch { return true; } });
	})());
	ok('⑪ mcp_remove 已注册且审批闸覆盖',
		idx5.includes("name: 'mcp_remove'") && idx5.includes("exec.name === 'mcp_remove'"));
	ok('⑪ 只读片段给出管理动作引导，不承载写操作',
		page5.includes('本片段只读') && page5.includes('mcp_remove') && page5.includes('mcp_catalog'));
	const html5 = (await mod('dsh-plugins/vssaros-mcp/lib/core/mcpConfig.js')).renderSection({
		path: '/x/mcp.json', exists: true, parsed: { servers: [], skipped: [] }, toolCount: '0', toolList: [],
	});
	ok('⑪ 片段真的渲染出管理引导行', html5.includes('mcp_remove') && html5.includes('带审批'));
	ok('⑪ 反向突变（去掉删除审批闸）⇒ 判据变红', (() => {
		const verdict = s => s.includes("exec.name === 'mcp_remove'");
		return verdict(idx5) && !verdict(idx5.replace("exec.name === 'mcp_remove'", 'false'));
	})());
}

// ── ⑫ 凭据隔离网关（2026-11-10）───────────────────────────────────────────
// 离线起本地假上游 + 真网关，验证「凭据不进 mcp-client config」「nonce 鉴权」「只 https」
// 「401 重试」「变量缺失拒绝」「close 清理」。不打外网。
{
	const { createServer } = await import('node:http');
	const gwMod = await mod('dsh-plugins/vssaros-mcp/lib/core/mcpGateway.js');
	const idx6 = read('dsh-plugins/vssaros-mcp/lib/index.js');
	const seen = [];
	let upstreamStatus = 200;
	const upstream = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) { chunks.push(chunk); }
		seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), url: req.url });
		res.writeHead(upstreamStatus, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
		res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
	});
	await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
	const baseUrl = `http://127.0.0.1:${upstream.address().port}/mcp`;
	const env = { MY_TOKEN: 'SECRET-VALUE' };
	const gw = gwMod.createMcpGateway({ env, allowInsecure: true });
	await gw.listen();
	gw.register('remote', { url: baseUrl, headers: { Authorization: 'Bearer ${env:MY_TOKEN}', 'X-Static': 'v1' } });

	const clientConfig = { url: gw.urlFor('remote'), headers: gw.headers() };
	ok('⑫ mcp-client config 里没有任何真凭据（只有回环 URL + nonce）',
		!JSON.stringify(clientConfig).includes('SECRET-VALUE') && clientConfig.url.startsWith('http://127.0.0.1:'));
	const good = await fetch(clientConfig.url, {
		method: 'POST',
		headers: { ...clientConfig.headers, 'content-type': 'application/json', 'mcp-session-id': 'cli-1' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
	});
	const goodText = await good.text();
	ok('⑫ 网关注入真凭据、转发 MCP 会话头、回传 Mcp-Session-Id',
		good.status === 200 && seen.at(-1)?.headers.authorization === 'Bearer SECRET-VALUE'
		&& seen.at(-1)?.headers['mcp-session-id'] === 'cli-1'
		&& good.headers.get('mcp-session-id') === 'sess-1' && goodText.includes('"ok":true'));
	const noAuth = await fetch(clientConfig.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	const badAuth = await fetch(clientConfig.url, { method: 'POST', headers: { Authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{}' });
	ok('⑫ 缺失 / 错误 nonce ⇒ 401，且上游根本没被调用',
		noAuth.status === 401 && badAuth.status === 401 && seen.length === 1);
	ok('⑫ ${env:VAR} / ${VAR} 解析；变量缺失明确报错',
		gwMod.resolveSecretRefs('Bearer ${env:MY_TOKEN}', env).value === 'Bearer SECRET-VALUE'
		&& gwMod.resolveSecretRefs('Bearer ${MY_TOKEN}', env).value === 'Bearer SECRET-VALUE'
		&& !!gwMod.resolveSecretRefs('Bearer ${MISSING}', {}).error);
	const gw2 = gwMod.createMcpGateway({ env: {}, allowInsecure: true });
	await gw2.listen();
	gw2.register('m', { url: baseUrl, headers: { Authorization: 'Bearer ${env:MISSING}' } });
	const missing = await fetch(gw2.urlFor('m'), { method: 'POST', headers: { ...gw2.headers(), 'content-type': 'application/json' }, body: '{}' });
	ok('⑫ 凭据变量缺失 ⇒ 400，不把 ${...} 原样传给上游', missing.status === 400);
	await gw2.close();
	gw.register('q', { url: baseUrl, headers: {}, query: { key: '${env:MY_TOKEN}' } });
	const withQuery = await fetch(gw.urlFor('q'), { method: 'POST', headers: { ...gw.headers(), 'content-type': 'application/json' }, body: '{}' });
	ok('⑫ query 型凭据在转发时才解析并附加到上游 URL',
		withQuery.status === 200 && seen.at(-1)?.url?.includes('key=SECRET-VALUE'));
	const gw3 = gwMod.createMcpGateway({ env });
	await gw3.listen();
	gw3.register('i', { url: baseUrl, headers: {} });
	const insecure = await fetch(gw3.urlFor('i'), { method: 'POST', headers: { ...gw3.headers(), 'content-type': 'application/json' }, body: '{}' });
	ok('⑫ 非 https 上游 ⇒ 403（默认策略）', insecure.status === 403);
	await gw3.close();
	upstreamStatus = 401;
	const before = seen.length;
	const retry = await fetch(clientConfig.url, { method: 'POST', headers: { ...clientConfig.headers, 'content-type': 'application/json' }, body: '{}' });
	ok('⑫ 上游 401 ⇒ 重新解析凭据并重试一次后如实回传',
		retry.status === 401 && seen.length - before === 2);
	upstreamStatus = 200;
	await gw.close();
	ok('⑫ close() 释放端口并清空路由', gw.port === 0 && gw.size === 0);
	await new Promise(resolve => upstream.close(resolve));
	ok('⑫ 网关开关缺省启用、=0 回退',
		gwMod.isMcpGatewayEnabled({}) === true && gwMod.isMcpGatewayEnabled({ VSSAROS_MCP_GATEWAY: '0' }) === false);
	ok('⑫ 运行时挂载把带 headers 或 query 凭据的 http 条目都改挂网关，卸载时关闭',
		idx6.includes('gateway.register(s.serverName') && idx6.includes('gateway.urlFor(s.serverName)')
		&& idx6.includes('void gateway?.close()')
		&& idx6.includes('rawServers[s.serverName]?.query')
		&& idx6.includes('query: rawServers[s.serverName]?.query'));
	// 真机事故：有引用的 http server + 「void tick() 与 fiber dispose 竞态」会让进程挂住不退出。
	ok('⑫ 网关 server unref + 首次 tick 与卸载竞态保护（不挂住进程）',
		read('dsh-plugins/vssaros-mcp/lib/core/mcpGateway.js').includes('server.unref?.()')
		&& idx6.includes('if (stopped) { await gateway.close(); gateway = null; return; }'));
	ok('⑫ 反向突变（去掉网关注册）⇒ 判据变红', (() => {
		const verdict = s => s.includes('gateway.register(s.serverName');
		return verdict(idx6) && !verdict(idx6.replace('gateway.register(s.serverName', 'void 0'));
	})());
}

// ── ⑬ 已有 MCP 管理页与新挂载模型对齐（2026-11-10）──────────────────────
// 管理页在 vssaros-skills 的连接器页签（编辑弹层/开关/删除/工具明细本来就有）。
// 这里钉住「写死的重启文案不许回来」——运行时挂载下它们全是假话。
{
	const skills = read('dsh-plugins/vssaros-skills/lib/index.js');
	ok('⑬ skills 页判据与 dsh 侧同值',
		skills.includes("const MCP_RUNTIME_MOUNT = process.env.VSSAROS_MCP_RUNTIME_MOUNT !== '0';")
		&& read('dsh-plugins/vssaros-mcp/lib/core/mcpRuntime.js').includes("!== '0'"));
	ok('⑬ 服务端文案由常量派生（MCP_APPLY_HINT / MCP_TOGGLE_TAIL / MCP_DISABLED_NOTE）',
		['MCP_APPLY_HINT', 'MCP_TOGGLE_TAIL', 'MCP_DISABLED_NOTE'].every(k => (skills.match(new RegExp(k, 'g')) ?? []).length >= 2));
	const stale = [
		'编辑 mcp.json（保存后需重启 Host 生效）',
		'保存后**重启 Host** 才生效',
		"'已启用（点一下停用，重启 Host 后生效）'",
		"'已停用（点一下启用，重启 Host 后生效）'",
		"'已停用（重启 Host 后不加载）'",
		"delTitle: '从 mcp.json 注销并删除安装目录（重启 Host 后不再加载）'",
	];
	ok('⑬ 六处写死的「重启后生效」文案零残留', stale.every(s => !skills.includes(s)),
		stale.filter(s => skills.includes(s)).join(' / '));
	ok('⑬ 页内开关反馈保持中性（生效交给后端 restartRequired 决定）',
		skills.includes("? '已启用（点一下停用）'") && skills.includes("if (j.restartRequired && rowEl)"));
	ok('⑬ 凭据隔离连接器在管理页有可见标识与事实行（含 query-only 引用）',
		skills.includes('const secured = refValues.some') && skills.includes('...(e.query')
		&& skills.includes("{ text: '凭据隔离' }") && skills.includes("['凭据',"));
	ok('⑬ 反向突变（把开关判据改回常量）⇒ 判据变红', (() => {
		const needle = "const MCP_RUNTIME_MOUNT = process.env.VSSAROS_MCP_RUNTIME_MOUNT !== '0';";
		const verdict = s => s.includes(needle);
		return verdict(skills) && !verdict(skills.replace(needle, 'const MCP_RUNTIME_MOUNT = false;'));
	})());
}

// ── ⑭ 凭据仓库 / secrets 获取层第一块（2026-11-10）────────────────────────
// 离线验证「真值只进 mode 600 文件、mcp.json 只有占位符、网关转发时才解析」。
{
	const { mkdtempSync, rmSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const sec = await mod('dsh-plugins/vssaros-mcp/lib/core/mcpSecrets.js');
	const gwMod = await mod('dsh-plugins/vssaros-mcp/lib/core/mcpGateway.js');
	const idx7 = read('dsh-plugins/vssaros-mcp/lib/index.js');
	const dir = mkdtempSync(join(tmpdir(), 'mcp-secrets-guard-'));

	const set = sec.planSecretSet({ version: 1, secrets: {} }, { id: 'amap', fields: { key: 'SECRET-1', note: 'x' } });
	ok('⑭ 写计划：字段合并、结构合法', set.id === 'amap' && set.next.secrets.amap.key === 'SECRET-1'
		&& set.next.secrets.amap.note === 'x' && set.next.version === 1);
	const env = sec.secretsAsEnv(set.next, { PATH: 'p' });
	ok('⑭ 合成 env：MCP_AMAP_KEY 可解析且保留 base env',
		env.MCP_AMAP_KEY === 'SECRET-1' && env.MCP_AMAP_NOTE === 'x' && env.PATH === 'p');
	const view = sec.secretView(set.next);
	ok('⑭ 脱敏视图不给真值，只给字段名与 ${env:...} 引用名',
		!JSON.stringify(view).includes('SECRET-1') && view[0].fields.includes('key')
		&& view[0].refs.includes('${env:MCP_AMAP_KEY}'));
	ok('⑭ 网关用合成 env 在转发时解析占位符',
		gwMod.resolveSecretRefs('Bearer ${env:MCP_AMAP_KEY}', env).value === 'Bearer SECRET-1');
	// 不改 parseMcpServers 双侧镜像：现有解析器用合成 env 就能吃到引用。
	const parser = await mod('dsh-plugins/vssaros-mcp/lib/core/mcpConfig.js');
	const cfgText = JSON.stringify({ servers: { remote: { type: 'http', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer ${env:MCP_AMAP_KEY}' } } } });
	ok('⑭ mcp.json 的 ${env:MCP_*} 引用被现有 parseMcpServers 吃到（双侧镜像无需改）',
		parser.parseMcpServers(cfgText, env).servers.length === 1
		&& parser.parseMcpServers(cfgText, env).servers[0].headers.Authorization === 'Bearer SECRET-1');
	await sec.writeSecrets(dir, set.next);
	const back = await sec.readSecrets(dir);
	ok('⑭ 落盘读回一致，且写入声明 mode 600 + chmod（跨平台不写死实际位）',
		back.secrets.amap.key === 'SECRET-1'
		&& read('dsh-plugins/vssaros-mcp/lib/core/mcpSecrets.js').includes('mode: 0o600')
		&& read('dsh-plugins/vssaros-mcp/lib/core/mcpSecrets.js').includes('chmod('));
	ok('⑭ 空串删字段 / 不存在不写盘 / 非法 id 与非字符串值拒绝', (() => {
		const cleared = sec.planSecretSet(set.next, { id: 'amap', fields: { note: '' } });
		const cases = [
			() => sec.planSecretDelete({ secrets: {} }, { id: 'nope' }),
			() => sec.planSecretSet({}, { id: 'Bad Id', fields: { key: 'x' } }),
			() => sec.planSecretSet({}, { id: 'ok', fields: { key: 123 } }),
		];
		return !('note' in cleared.next.secrets.amap)
			&& cases.every(fn => { try { fn(); return false; } catch { return true; } });
	})());
	ok('⑭ mcp_secret 已注册、审批闸覆盖、缺省 list 只读',
		idx7.includes("name: 'mcp_secret'") && idx7.includes("exec.name === 'mcp_secret'")
		&& idx7.includes("String(params?.action ?? 'list')"));
	ok('⑭ 运行时挂载把 secrets 纳入轮询签名并合成 env 给解析器/网关',
		idx7.includes('secretsPathForMcpConfig(path)') && idx7.includes('secretsAsEnv(secrets, process.env)')
		&& idx7.includes('readMountPlan(path, mergedEnv)') && idx7.includes('createMcpGateway({ env: mergedEnv, warn })'));
	ok('⑭ 目录拒绝文案已更新为准确替代路径（不再谎称网关未落地）',
		read('dsh-plugins/vssaros-mcp/lib/core/mcpCatalog.js').includes('mcp_secret 设置真值'));
	ok('⑭ 反向突变（去掉凭据工具审批闸）⇒ 判据变红', (() => {
		const verdict = s => s.includes("exec.name === 'mcp_secret'");
		return verdict(idx7) && !verdict(idx7.replace("exec.name === 'mcp_secret'", 'false'));
	})());
	rmSync(dir, { recursive: true, force: true });
}

// ── ⑮ 商城 MCP 安装写口接 OSV（2026-11-10）────────────────────────────────
// 跨插件不互相 import：vssaros-mcp provide 服务，商城可选注入。
// 这里钉住「两条 installBundle 路径 + 普通商品路径 + Bot 包路径」全覆盖与 fail-open 语义。
{
	const mkt = await mod('dsh-plugins/vssaros-marketplace/lib/mcpInstall.js');
	const mcpSrc7 = read('dsh-plugins/vssaros-mcp/lib/index.js');
	const mktSrc = read('dsh-plugins/vssaros-marketplace/lib/index.js');
	const instSrc = read('dsh-plugins/vssaros-marketplace/lib/installers.js');
	const cfg = { transport: 'stdio', command: 'npx', args: ['-y', 'evil-pkg'] };

	ok('⑮ vssaros-mcp 对外 provide OSV 服务（商城不复制第二份实现）',
		mcpSrc7.includes("ctx.provide?.('vssarosMcpOsv'") && mcpSrc7.includes('checkStdioEntriesAgainstOsv'));
	ok('⑮ 商城可选注入，两条 installBundle 路径 + 普通商品路径都接了预检',
		mktSrc.includes("ctx.inject(['vssarosMcpOsv']")
		&& (mktSrc.match(/osvCheck: assertMcpConfigSafe/g) ?? []).length === 2
		&& mktSrc.includes('await assertMcpConfigSafe(config)'));
	ok('⑮ Bot 组合包路径透传钩子，并在写 mcp.json 之前调用',
		instSrc.includes('osvCheck = null') && instSrc.includes('await osvCheck(cfg)')
		&& instSrc.includes('upgrade, osvCheck }'));

	const fakeOsv = {
		isOsvEnabled: () => true,
		checkStdioEntriesAgainstOsv: async () => ({ status: 'blocked', hits: [{ name: 'evil-pkg', ecosystem: 'npm', ids: ['MAL-1'] }] }),
		buildOsvBlockedMessage: v => 'BLOCKED:' + v.hits[0].ids.join(','),
	};
	const blocked = await mkt.checkMcpConfigOsv(fakeOsv, cfg);
	ok('⑮ 命中恶意包 ⇒ blocked 且带阻断文案', blocked.status === 'blocked' && blocked.message.includes('MAL-1'));
	ok('⑮ 服务缺失 / 显式关闭 ⇒ fail-open（skipped）',
		(await mkt.checkMcpConfigOsv(null, cfg)).status === 'skipped'
		&& (await mkt.checkMcpConfigOsv({ ...fakeOsv, isOsvEnabled: () => false }, cfg)).status === 'skipped');
	ok('⑮ 网络失败 unknown ⇒ 放行但不假装已验证',
		(await mkt.checkMcpConfigOsv({ ...fakeOsv,
			checkStdioEntriesAgainstOsv: async () => ({ status: 'unknown', reason: 'offline' }) }, cfg)).status === 'unknown');
	let seenType = null;
	await mkt.checkMcpConfigOsv({ ...fakeOsv,
		checkStdioEntriesAgainstOsv: async entries => { seenType = entries[0]?.type; return { status: 'clean' }; },
	}, { transport: 'http', url: 'https://x/mcp' });
	ok('⑮ http 条目如实传类型给 OSV（由它跳过，不打查询）', seenType === 'http');
	ok('⑮ 反向突变（去掉普通商品路径预检）⇒ 判据变红', (() => {
		const needle = 'await assertMcpConfigSafe(config)';
		const verdict = s => s.includes(needle);
		return verdict(mktSrc) && !verdict(mktSrc.replace(needle, 'void 0'));
	})());
}

// ── ⑯ 商城上架 DS Bot 远程 MCP（2026-11-10）──────────────────────────────
// 商城现有 134 个是 Cline 仓库型；DS Bot 的 38 个是纯远程 URL 型 ⇒ 走 bundle 通道。
// 这里只钉住**本地代码契约**（服务端数据是运维结果，不写进守卫）。
{
	const mktInstall = await mod('dsh-plugins/vssaros-marketplace/lib/mcpInstall.js');
	const syncSrc = read('dsh-plugins/vssaros-marketplace/tools/sync-dsb-mcp.mjs');
	ok('⑯ 商城安装写口支持 query 型凭据引用（Amap）',
		mktInstall.toMcpEntry({ transport: 'http', url: 'https://x', query: { key: '${env:MCP_AMAP_KEY}' } })
			.query?.key === '${env:MCP_AMAP_KEY}');
	const rows = (syncSrc.match(/^\t\['/gm) ?? []).length;
	ok('⑯ 批量登记脚本含且仅含 38 个 DS Bot 远程 MCP（mail 非 MCP ⇒ 排除）',
		rows === 38 && !syncSrc.includes("['mail',"));
	// 判据要匹配**代码调用形态**：脚本注释里提到了 publishDistribution（解释为什么不能用），
	// 用 includes('publishDistribution') 会把注释误判成调用 ✗。
	ok('⑯ 走 bundle 通道 publishVersion（纯 URL 不能登记为 external 源）',
		syncSrc.includes('await publishVersion(') && !syncSrc.includes('publishDistribution('));
	ok('⑯ 凭据只用 ${env:...} 引用，config.json 不含任何明文',
		syncSrc.includes("'${env:'") && syncSrc.includes("'Bearer ' + tokenRef")
		&& syncSrc.includes('config.query = { key: keyRef }')
		&& !/Bearer [A-Za-z0-9_-]{20,}/.test(syncSrc));
	ok('⑯ dsb- 前缀 + 已存在跳过 + dry 模式（幂等可复跑）',
		syncSrc.includes("slug: 'dsb-' + id") && syncSrc.includes('existing.has(s.slug)')
		&& syncSrc.includes('const DRY') && syncSrc.includes('if (DRY)'));
	ok('⑯ 反向突变（去掉 query 透传）⇒ 判据变红', (() => {
		const s = read('dsh-plugins/vssaros-marketplace/lib/mcpInstall.js');
		const verdict = x => x.includes('entry.query = cfg.query');
		return verdict(s) && !verdict(s.replace('entry.query = cfg.query', 'void 0'));
	})());
}

// ── ⑰ DS Bot 品牌图标复刻（2026-11-10）──────────────────────────────────
// 商城 isImageIcon() 认 data:image/ ⇒ 每个 item 的 SVG 以 data URI 内联进 icon，
// 不用图床、不依赖外部 CSS 变量。这里钉住资产完整性与回填脚本的幂等性。
{
	const { DSB_MARKS_SVG: marks } = await mod('dsh-plugins/vssaros-marketplace/tools/dsb-marks.mjs');
	const sync2 = read('dsh-plugins/vssaros-marketplace/tools/sync-dsb-mcp.mjs');
	const clientJs = read('dsh-plugins/vssaros-marketplace/lib/client.js');
	const ids = Object.keys(marks);
	ok('⑰ 38 个 item 各有一份品牌 SVG 资产',
		ids.length === 38 && ids.includes('github') && ids.includes('amap') && ids.includes('context7'));
	ok('⑰ SVG 独立可用：xmlns / viewBox / 正确闭合、无 view-box 与 CSS 变量',
		ids.every(k => marks[k].includes('xmlns="http://www.w3.org/2000/svg"')
			&& marks[k].includes('viewBox=') && !marks[k].includes('view-box')
			&& marks[k].endsWith('</svg>') && !marks[k].includes('var(--')));
	ok('⑰ 多色 marks 保留品牌色（不是清一色单色）',
		(marks.figma.match(/#[0-9A-Fa-f]{6}/g) ?? []).length >= 5
		&& marks.stripe.includes('#635BFF') && marks.cloudflare.includes('#FAAE40'));
	const pngAssets = JSON.parse(read('dsh-plugins/vssaros-marketplace/tools/dsb-marks-png.json'));
	ok('⑰ 38 个 PNG 资产齐全且都是合法 PNG（服务端封面白名单不收 svg）',
		Object.keys(pngAssets).length === 38
		&& ids.every(k => Buffer.from(pngAssets[k], 'base64').subarray(0, 8)
			.equals(Buffer.from('89504e470d0a1a0a', 'hex'))));
	// ★ 真机事故：data:image/svg+xml;base64 的长串在 44px 图标块里被当短文本居中截断，
	//   显示成 base64 中段的乱码字母 ⇒ 必须写绝对 http URL（所有版本 isImageIcon 都认）。
	ok('⑰ icon 写绝对 http URL，不再内联 data URI',
		clientJs.includes('data:image')
		&& sync2.includes("ENDPOINT + '/covers/' + spec.slug + '.png'")
		&& !sync2.includes("'data:image/svg+xml;base64,'"));
	ok('⑰ --icons 上传自持 PNG 后写库，且幂等（先 GET 比对）',
		sync2.includes("const ICONS = argv.includes('--icons')")
		&& sync2.includes("'/api/v1/covers?'") && sync2.includes("ext: 'png'")
		&& sync2.includes('market.updatePackage(spec.slug, { icon: iconUrl })')
		&& sync2.includes("String(detail?.icon ?? '') === iconUrl"));
	ok('⑰ 反向突变（去掉图标回填调用）⇒ 判据变红', (() => {
		const needle = 'market.updatePackage(spec.slug, { icon: iconUrl })';
		const verdict = s => s.includes(needle);
		return verdict(sync2) && !verdict(sync2.replace(needle, 'void 0'));
	})());
}

console.log(problems.length ? `\n✗ check-capability-tools：${problems.length} 项失败` : '\n✓ check-capability-tools：全部通过');
if (problems.length) { for (const p of problems) { console.log(`  ✗ ${p}`); } }
process.exitCode = problems.length ? 1 : 0;
