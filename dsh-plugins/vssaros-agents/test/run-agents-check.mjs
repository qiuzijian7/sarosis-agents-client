// @vssaros/dsh-agents — 包内自检。
//   跑法：node dsh-plugins/vssaros-agents/test/run-agents-check.mjs
//   两类断言：
//     ① 静态契约（清单 / patch / 共享基座 / 会话级模型选择 / 工具 allowlist 等）
//     ② 纯逻辑：clampImportLimit（导入上限）等 Host 侧小工具
//   ★ 2026-11-03：Bots 工作台与群聊功能整体下线 ⇒ 工作台组件（wb-* / desktopWorkbenches）与
//     `lib/activity.js`、`lib/groups.js`、`lib/groupPage.js`、`lib/client.agents.js` 的断言全部移除，
//     改为"这些文件必须不存在"的反向断言（复活即红）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowlistDenyOf, REQUIRED_BASE_ROW_IDS, rowIdsOf, toPresetDefinition } from '../lib/core/agents.js';
import { STANDARD_BASE_ROWS } from '../lib/core/presetBase.generated.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const listLib = (dir = path.join(ROOT, 'lib'), out = []) => {
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) { listLib(p, out); } else if (name.endsWith('.js')) { out.push(p); }
	}
	return out;
};
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
	if (ok) { pass += 1; console.log('  ok   ' + name + (detail ? '  — ' + String(detail).slice(0, 90) : '')); }
	else { fail += 1; console.log('  FAIL ' + name + (detail ? '  — ' + String(detail).slice(0, 200) : '')); }
};

const pkg = JSON.parse(read('package.json'));

console.log('── 清单与激活 ──');
check('包名', pkg.name === '@vssaros/dsh-agents', pkg.name);
// ★ 2026-11-06：插件管理器的 list_bundles 把 description 原样交给模型（实测 dsh-plugin-manager types/index.js 只剥 meta）。
//   这段曾累计到 20651 字 ⇒ 版本说明一律写 CHANGELOG.md，description 只留一段现状摘要。
check('description 只是摘要（≤ 1000 字，版本说明写 CHANGELOG.md）', String(pkg.description || '').length <= 1000,
	`现在 ${String(pkg.description || '').length} 字`);
check('CHANGELOG.md 存在且随包发出', fs.existsSync(path.join(ROOT, 'CHANGELOG.md')) && (pkg.files || []).includes('CHANGELOG.md'));
// ★ 2026-11-03：Bots 工作台下线 ⇒ 清单里只剩最小 vssaros（module + view.kind=none），
//   不再有活动栏 / 原生视图 / 工作台。⚠ `vssaros.module` **必须留**：IDE 侧 `listBundledPlugins`
//   只认「有 vssaros.module 的包」为随包模块插件（supervisor 自动安装/升级的输入）。
check('清单只剩最小 vssaros（module=agents + view.kind=none，无 activityBar/view 路由/workbench）',
	pkg.vssaros?.module === 'agents'
	&& pkg.vssaros?.view?.kind === 'none'
	&& !('activityBar' in (pkg.vssaros || {}))
	&& !('workbench' in (pkg.vssaros || {}))
	&& !('route' in (pkg.vssaros?.view || {})), JSON.stringify(pkg.vssaros));
check('不再注入 @vssaros/dsh-workbenches', !(pkg.dsh?.client?.inject || []).includes('@vssaros/dsh-workbenches'));
check('不再有客户端 chunk 声明（dsh.client）', !('client' in (pkg.dsh || {})));
const patchField = pkg.dsh?.bundle?.patch;
check('清单带 dsh.bundle.patch', /cordis\.patch\.yml/.test(String(Array.isArray(patchField) ? patchField.join(',') : patchField)), JSON.stringify(patchField));
check('files 里含 cordis.patch.yml', (pkg.files || []).includes('cordis.patch.yml'));
const patch = read('cordis.patch.yml');
check('patch 有 insert 段', /-\s*insert:/.test(patch));
check('patch 的 name 与包名一致', patch.includes(`'@vssaros/dsh-agents'`));
/* ★ 2026-11-03 真机事故「join is not defined」：applyPersona 的记忆提示里用 join() 拼 MEMORY.md
   绝对路径，但 `import { join } from 'node:path'` 从来没写过。那行只在「bot 有记忆内容」时才执行
   ⇒ 潜伏很久，重启后打开有记忆的 bot 会话才炸。任何裸 join( 调用都必须有对应导入。 */
{
	const idxAll = read('lib/index.js');
	check('lib/index.js：裸 join( 必须有 node:path 导入（防「join is not defined」复发）',
		!/(^|[^.\w$])join\s*\(/.test(idxAll) || /import\s*\{[^}]*\bjoin\b[^}]*\}\s*from\s*'node:path'/.test(idxAll));
}

console.log('── 入口与组件（Bots 工作台已下线）──');
check('不再有工作台组件（无 desktopWorkbenches.register）', !listLib().some((f) => /desktopWorkbenches\.register\(/.test(fs.readFileSync(f, 'utf8'))));
for (const f of ['lib/client.js', 'lib/client.agents.js', 'lib/client.botSettings.js', 'lib/detail.js', 'lib/sideview.js', 'lib/createPage.js', 'lib/activity.js']) {
	check(`${f} 已删（工作台 / 客户端 chunk 下线）`, !fs.existsSync(path.join(ROOT, f)));
}

/* ── 记忆已并入 @vssaros/dsh-memory（★ 2026-11-06「记忆收敛」S4）──────────────────────────────
   本插件不再有自己的记忆存储 / 注入 / 工具。反向断言：旧模块不许复活，也不许有人再 import 它们。 */
console.log('── 记忆已并入统一记忆 ──');
{
	for (const f of ["lib/memory.js","lib/workspaceMemory.js","lib/memoryPrefs.js","lib/agentmemoryImport.js","lib/memoryEvoPage.js"]) {
		check(`${f} 已删（记忆并入 @vssaros/dsh-memory）`, !fs.existsSync(path.join(ROOT, f)));
	}
	const gone = /from '[^']*\/(memory|workspaceMemory|memoryPrefs|agentmemoryImport|memoryEvoPage)\.js'/;
	check('没有任何文件再 import 已删的记忆模块', !listLib().some((f) => gone.test(fs.readFileSync(f, 'utf8'))));
	const idx = read('lib/index.js');
	check('index.js 不再注册工作区记忆段 / 不再注入 Bot 记忆', !/vssaros-workspace-memory/.test(idx) && !/readMemorySnapshot/.test(idx));
	check('旧记忆接口与演化页已删（没有转接层）', !/api\/memory`|api\/workspace-memory|api\/memory-prefs|api\/agentmemory|\/memory\/\(\[A-Za-z/.test(idx) && !fs.existsSync(path.join(ROOT, 'lib/memoryFacade.js')));
	const { TOOL_NAMES: names } = await import('../lib/tools.js');
	check('不再有 workspace_memory 工具', !names.includes('workspace_memory'), names.join(','));
	const pkg2 = JSON.parse(read('package.json'));
	check('files 白名单同步（删掉的不在、新增的在）',
		["lib/memory.js","lib/workspaceMemory.js","lib/memoryPrefs.js","lib/agentmemoryImport.js","lib/memoryEvoPage.js"].every((f) => !pkg2.files.includes(f)) && ['lib/memoryFiles.js'].every((f) => pkg2.files.includes(f)));
}

// ── agent preset = 共享基座 ⊕ 差量（2026-10-25）────────────────────────────────────
// 回归点：之前 agent preset 只有 persona/model/compaction/subagent ⇒ 会话里没有 fs / pwsh / skill。
console.log('── agent preset 共享基座 ──');
{
	const base = { id: 'probe', name: 'Probe', persona: '你是探针', tools: ['read', 'pwsh'], model: '' };
	const { definition, notes } = toPresetDefinition(base, { provider: 'p', allowedAgentPresets: ['vssaros-other'] });
	const ids = rowIdsOf(definition.plugins);
	check('files 里含基座生成物', (pkg.files || []).includes('lib/core/presetBase.generated.js'));
	check('基座必需行齐全', REQUIRED_BASE_ROW_IDS.every(id => ids.includes(id)), REQUIRED_BASE_ROW_IDS.filter(id => !ids.includes(id)).join(','));
	check('含 pwsh / bash 两行（按平台 disabled）', ids.includes('tool-pwsh') && ids.includes('tool-bash'));
	const pwsh = definition.plugins.find(r => r.id === 'tool-pwsh');
	check('pwsh 的 disabled 保留为 JsExpr', !!pwsh?.disabled && typeof pwsh.disabled.__jsExpr === 'string', JSON.stringify(pwsh?.disabled));
	check('第一行是本包人设行', definition.plugins[0]?.id === 'persona' && definition.plugins[0]?.name === '@vssaros/dsh-agents');
	check('没有官方 dsh-persona 行', !JSON.stringify(definition.plugins).includes('@deepseek-ai/dsh-persona'));
	check('没有 @vssaros/* 模块行（host 层已加载，重复挂会撞服务）', definition.plugins.slice(1).every(r => !String(r.name).startsWith('@vssaros/')));
	check('id 不重复', new Set(ids).size === ids.length, ids.length + ' 行');
	const findDeep = (rows, id) => { for (const r of rows) { if (r.id === id) { return r; } if (r.group && Array.isArray(r.config)) { const h = findDeep(r.config, id); if (h) { return h; } } } return undefined; };
	const sub = findDeep(definition.plugins, 'tool-subagent');
	check('subagent 带 backgroundMode + 动态清单', sub?.config?.backgroundMode === 'continuable' && sub?.config?.allowedAgentPresets?.[0] === 'vssaros-other', JSON.stringify(sub?.config));
	const fork = findDeep(definition.plugins, 'tool-subagent-fork');
	check('fork 带 backgroundMode 且不带清单', fork?.config?.backgroundMode === 'continuable' && !fork?.config?.allowedAgentPresets, JSON.stringify(fork?.config));
	check('notes 里没有"基座缺行"', !notes.some(n => n.startsWith('基座缺行')), notes.find(n => n.startsWith('基座缺行')));

	const lone = toPresetDefinition({ ...base, subagents: false }, { provider: 'p' });
	check('subagents:false ⇒ 无 delegation 组', !rowIdsOf(lone.definition.plugins).includes('delegation') && !rowIdsOf(lone.definition.plugins).includes('tool-subagent'));
	check('subagents:false 仍有 fs / skill', ['tool-fs', 'tool-skill'].every(id => rowIdsOf(lone.definition.plugins).includes(id)));
	// ★ 2026-11-03：模型**不进 preset**（default-model 行在 dsh API 会话里没有消费方，从未生效）；
	//   `-assign` 派生 preset 已删 ⇒ idSuffix / modelOverride 都不再参与
	const withModel = toPresetDefinition({ ...base, model: 'm', modelAssignment: 'p2/m2' }, { provider: 'p', idSuffix: '-assign' });
	check('preset 不再带 default-model 行（模型是会话级选择）', !rowIdsOf(withModel.definition.plugins).includes('default-model')
		&& !JSON.stringify(withModel.definition.plugins).includes('dsh-agent-default-model'));
	check('preset id 不再带派生后缀（idSuffix 被忽略）', withModel.definition.id === 'vssaros-probe', withModel.definition.id);
	check('有模型也照常挂 delegation 组（不再有"派生版无 fan-out"分支）', rowIdsOf(withModel.definition.plugins).includes('delegation'));
	const unrouted = toPresetDefinition({ ...base, model: 'bare' }, { provider: '' });
	check('裸模型名 + 无 defaultProvider ⇒ 仍出「模型未映射」note（页面琥珀标 / resetModel 判据）', unrouted.notes.some(n => n.startsWith('模型未映射')));
	check('provider/model 显式写法 ⇒ 无「模型未映射」', !toPresetDefinition({ ...base, model: 'x/y' }, { provider: '' }).notes.some(n => n.startsWith('模型未映射')));

	// 两次构造互不影响（基座是深拷贝，不能被上一个 agent 的差量污染）
	const again = toPresetDefinition(base, { provider: 'p' });
	const sub2 = findDeep(again.definition.plugins, 'tool-subagent');
	check('基座深拷贝（上次的清单不残留）', !sub2?.config?.allowedAgentPresets, JSON.stringify(sub2?.config));
	check('基座本体未被改写', !JSON.stringify(STANDARD_BASE_ROWS).includes('backgroundMode'));
	check('人设行带本 preset id（运行时 allowlist / 模型选择防误伤）', definition.plugins[0]?.config?.presetId === 'vssaros-probe' && definition.plugins[0]?.config?.agentId === 'probe', JSON.stringify(definition.plugins[0]?.config));
}

// ── 会话级模型选择（2026-11-03）────────────────────────────────────────────────────────
// 回归点：preset 里的 default-model 行在 dsh API 会话里没有消费方（ApiSessionAgentController 读 host 层
// agentDefaultModel；子代理继承父模型）⇒ `.agent.md` 的 model / model-assignment 从未生效。
console.log('── 会话级模型选择 ──');
{
	const { modelRouteOf } = await import('../lib/core/agents.js');
	check('modelRouteOf：裸名 + defaultProvider', JSON.stringify(modelRouteOf('m', 'p')) === '{"provider":"p","model":"m"}');
	check('modelRouteOf：provider/model 显式优先', JSON.stringify(modelRouteOf('x/y', 'p')) === '{"provider":"x","model":"y"}');
	check('modelRouteOf：裸名无 provider ⇒ undefined', modelRouteOf('m', '') === undefined);
	check('modelRouteOf：空 / 非字符串 ⇒ undefined', modelRouteOf('', 'p') === undefined && modelRouteOf(undefined, 'p') === undefined);

	const ms = await import('../lib/modelSelection.js');
	const { assignmentModelRouteOf } = await import('../lib/assignments.js');
	ms.__resetModelSelection();
	ms.setAgentModelRoutes([{ id: 'a', model: 'm1', modelAssignment: 'q/m2' }, { id: 'b', model: 'm3' }, { id: 'c' }], 'p');
	check('路由表：main / assign', JSON.stringify(ms.agentModelRouteOf('a')) === '{"provider":"p","model":"m1"}'
		&& JSON.stringify(ms.agentModelRouteOf('a', 'assign')) === '{"provider":"q","model":"m2"}');
	check('路由表：没写 model-assignment ⇒ assign 回落 main', JSON.stringify(ms.agentModelRouteOf('b', 'assign')) === '{"provider":"p","model":"m3"}');
	check('路由表：都没写 ⇒ undefined（跟随默认）', ms.agentModelRouteOf('c') === undefined && ms.agentModelRouteOf('c', 'assign') === undefined);
	check('委派路由：model-assignment 优先、回落 model', JSON.stringify(assignmentModelRouteOf({ model: 'm1', modelAssignment: 'q/m2' }, 'p')) === '{"provider":"q","model":"m2"}'
		&& JSON.stringify(assignmentModelRouteOf({ model: 'm1' }, 'p')) === '{"provider":"p","model":"m1"}'
		&& assignmentModelRouteOf({}, 'p') === undefined);
	check('isBlankModelState：只认 pending===null && lastUsed===null', ms.isBlankModelState({ pending: null, lastUsed: null })
		&& !ms.isBlankModelState({ pending: { provider: 'p', model: 'm' }, lastUsed: null })
		&& !ms.isBlankModelState({ pending: null, lastUsed: { provider: 'p', model: 'm' } })
		&& !ms.isBlankModelState(undefined));
	check('isSubagentSession：origin=subagent 或带 parentSession', ms.isSubagentSession({ session: { header: { origin: 'subagent' } } })
		&& ms.isSubagentSession({ session: { header: { parentSession: 's1' } } })
		&& !ms.isSubagentSession({ session: { header: { id: 's2' } } }));

	// 假 dsh：selectForNextRequest 记账 + 投影状态可变
	const mk = () => {
		const calls = [];
		const states = new Map();
		const agent = { session: { header: { id: 's' } } };
		states.set(agent.session, { pending: null, lastUsed: null });
		const sc = {
			agents: { selectForNextRequest(ag, sel) { calls.push(sel); states.set(ag.session, { ...states.get(ag.session), pending: sel }); } },
			commands: { async requireModel(sel) { if (sel.model === 'bad') { throw new Error('model-unavailable'); } } },
		};
		const llm = { async resolveCallConfig(c) { return { provider: c.provider, model: c.model }; } };
		const projections = { stateOf: (session, key) => (key === 'modelSelection' ? states.get(session) : undefined) };
		return { calls, states, agent, deps: { sc, llm, projections } };
	};
	{
		ms.__resetModelSelection();
		const t = mk();
		const r = await ms.applyModelSelection(t.deps, t.agent, { provider: 'p', model: 'm' });
		check('空白会话 ⇒ 选上（走 selectForNextRequest，不碰全局默认）', r.ok && t.calls.length === 1 && t.calls[0].model === 'm', JSON.stringify(r));
		const r2 = await ms.applyModelSelection(t.deps, t.agent, { provider: 'p', model: 'm9' });
		check('已选过（pending 非空）⇒ onlyIfBlank 不覆盖', !r2.ok && r2.reason === 'not-blank' && t.calls.length === 1, JSON.stringify(r2));
		const r3 = await ms.applyModelSelection(t.deps, t.agent, { provider: 'p', model: 'm9' }, { onlyIfBlank: false });
		check('onlyIfBlank:false（委派显式指定）⇒ 覆盖', r3.ok && t.calls.length === 2 && t.calls[1].model === 'm9', JSON.stringify(r3));
	}
	{
		ms.__resetModelSelection();
		const t = mk();
		t.states.set(t.agent.session, { pending: null, lastUsed: { provider: 'p', model: 'old' } });
		const r = await ms.applyModelSelection(t.deps, t.agent, { provider: 'p', model: 'm' });
		check('老会话（跑过请求）⇒ 不碰', !r.ok && r.reason === 'not-blank' && t.calls.length === 0, JSON.stringify(r));
	}
	{
		ms.__resetModelSelection();
		const t = mk();
		const r = await ms.applyModelSelection(t.deps, t.agent, { provider: 'p', model: 'bad' });
		check('模型不可用 ⇒ 不选（跟随默认），且失败不缓存', !r.ok && r.reason === 'model-unavailable' && t.calls.length === 0, JSON.stringify(r));
	}
	{
		ms.__resetModelSelection();
		const t = mk();
		t.agent.session.header.origin = 'subagent';
		const r = await ms.applyModelSelection(t.deps, t.agent, { provider: 'p', model: 'm' });
		check('子代理会话 ⇒ 不碰（继承父模型是官方语义）', !r.ok && r.reason === 'subagent' && t.calls.length === 0, JSON.stringify(r));
	}
	{
		ms.__resetModelSelection();
		const t = mk();
		await ms.resolveRoute(t.deps, { provider: 'p', model: 'm' });
		let committedSync = false;
		const pending = ms.applyModelSelection(t.deps, t.agent, { provider: 'p', model: 'm' });
		committedSync = t.calls.length === 1;
		await pending;
		check('命中校验缓存 ⇒ 同步提交（建会话后立刻 steer 也赶得上第一步）', committedSync);
	}
	{
		ms.__resetModelSelection();
		const t = mk();
		delete t.deps.sc.agents.selectForNextRequest;
		const r = await ms.applyModelSelection(t.deps, t.agent, { provider: 'p', model: 'm' });
		check('官方入口不在（dsh 版本变了）⇒ 如实返回 no-select-api、不抛', !r.ok && r.reason === 'no-select-api', JSON.stringify(r));
	}
	ms.__resetModelSelection();

	// 接线：preset 作用域订阅 agent/created 选模型；委派在 steer 之前显式选；syncPresets 不再派生 -assign
	const idx = strip(read('lib/index.js'));
	const asg = strip(read('lib/assignments.js'));
	check('applyPersona 调 installSessionBinding', /installSessionBinding\(ctx, config\)/.test(idx.slice(idx.indexOf('function applyPersona('), idx.indexOf('function installSessionBinding('))));
	check('installSessionBinding 订阅 agent/created 且 onlyIfBlank:true', /function installSessionBinding\([\s\S]*?ctx\.on\('agent\/created'[\s\S]*?applyModelSelection\(deps, agent, route, \{ onlyIfBlank: true \}\)/.test(idx));
	check('syncPresets 刷新路由表', /setAgentModelRoutes\(scan\.agents, provider\)/.test(idx));
	check('syncPresets 不再派生 -assign preset', !/idSuffix: '-assign'/.test(idx) && !/::assign/.test(idx));
	const steerAt = asg.indexOf('live.steer(message)');
	const selectAt = asg.indexOf('applyModelSelection(');
	check('委派：模型选择在 steer 之前', selectAt > 0 && steerAt > 0 && selectAt < steerAt, `${selectAt} < ${steerAt}`);
	check('委派：会话用本体 preset（不再 -assign）', /const wantPreset = presetIdOf\(agent\.id\)/.test(asg));
	check('modelSelection 只走 selectForNextRequest，不调会改全局默认的 selectModel / saveSelection',
		!/\.selectModel\(|saveSelection\(/.test(strip(read('lib/modelSelection.js'))));
}

// ── 工具 allowlist（2026-10-25 真机：saroasis-studio 会话里只剩 skill + subagent）──────────
// 旧实现在 preset 作用域 `restrict({ allow: [全局名] })` ⇒ agent 从 preset 层继承的基座工具被一起筛掉。
// 新实现：agent 作用域 `restrict({ deny: allowlistDenyOf(...) })`。下面钉**绝对期望值**（不是相对比较）。
console.log('── 工具 allowlist ──');
{
	const globals = ['skill', 'browser', 'kb_search', 'codebase_search', 'mcp__x__y', 'run_code', 'memory_list'];
	const deny = allowlistDenyOf(['read', 'write', 'pwsh', 'web_search', 'skill'], globals);
	// ★ 2026-11-06：MCP 工具默认保留（用户接的 MCP 本意就是给 bot 用的）⇒ mcp__x__y 不再进 deny
	check('saroasis 口径：deny = 其余全局工具（MCP 工具除外）', JSON.stringify(deny) === JSON.stringify(['browser', 'codebase_search', 'kb_search', 'memory_list']), JSON.stringify(deny));
	const optOut = allowlistDenyOf(['read', '!mcp__*'], globals);
	check('写 !mcp__* 的 bot 藏掉全部 MCP 工具', optOut.includes('mcp__x__y'), JSON.stringify(optOut));
	const oneServer = allowlistDenyOf(['!mcp__x__*'], ['mcp__x__y', 'mcp__z__w']);
	check('!mcp__某服务__* 只藏那一个服务', JSON.stringify(oneServer) === JSON.stringify(['mcp__x__y']), JSON.stringify(oneServer));
	const wild = allowlistDenyOf(['workflow_*'], ['workflow_run', 'workflow_list', 'kb_search']);
	check('prefix* 通配保留整组工具', JSON.stringify(wild) === JSON.stringify(['kb_search']), JSON.stringify(wild));
	const denyBeats = allowlistDenyOf(['workflow_*', '!workflow_apply'], ['workflow_run', 'workflow_apply']);
	check('排除优先于通配保留', JSON.stringify(denyBeats) === JSON.stringify(['workflow_apply']), JSON.stringify(denyBeats));
	check('排除也能藏掉 ALWAYS_KEEP 以外的精确名', JSON.stringify(allowlistDenyOf(['kb_search', '!kb_search'], ['kb_search'])) === JSON.stringify(['kb_search']));
	check('基座工具名（read/pwsh…）永不进 deny', !deny.some(n => ['read', 'write', 'pwsh', 'web_search'].includes(n)));
	const noSkill = allowlistDenyOf(['codebase_search'], globals);
	check('没声明 skill 也不藏 skill（与基座同名，按名 deny 会连基座一起藏）', !noSkill.includes('skill') && noSkill.includes('kb_search'), JSON.stringify(noSkill));
	check('run_code 永不进 deny（PTC 保留名，点名会抛）', !noSkill.includes('run_code'));
	const shadow = allowlistDenyOf([], ['browser', 'web_fetch'], n => n === 'web_fetch');
	check('被基座遮蔽的同名全局工具不进 deny', JSON.stringify(shadow) === JSON.stringify(['browser']), JSON.stringify(shadow));
	const throwing = allowlistDenyOf([], ['browser'], () => { throw new Error('x'); });
	check('shadowed 抛错 ⇒ 当作未遮蔽（照常 deny）', JSON.stringify(throwing) === JSON.stringify(['browser']), JSON.stringify(throwing));
	check('空输入安全', JSON.stringify(allowlistDenyOf(undefined, undefined)) === '[]');

	// 静态：applyPersona 不许再在 preset 作用域上挂 allow 掩码；必须走 agent/created + deny
	const idx = strip(read('lib/index.js'));
	const personaBody = idx.slice(idx.indexOf('function applyPersona('), idx.indexOf('function installAllowlist('));
	check('applyPersona 里没有 restrict({ allow', !/restrict\(\s*\{\s*allow/.test(personaBody));
	const bodyOf = (name) => { const at = idx.indexOf('function ' + name + '('); if (at < 0) { return ''; } const end = idx.indexOf('\nfunction ', at + 10); const end2 = idx.indexOf('\nexport function ', at + 10); const stop = [end, end2].filter(n => n > 0).sort((a, b) => a - b)[0] ?? idx.length; return idx.slice(at, stop); };
	check('installAllowlist 订阅 agent/created', /ctx\.on\(\s*'agent\/created'/.test(bodyOf('installAllowlist')));
	const watchBody = bodyOf('watchAllowlist');
	check('watchAllowlist 用 deny 收窄、且不用 allow', /restrict\(\{\s*deny:/.test(watchBody) && !/restrict\(\{\s*allow/.test(watchBody), watchBody.length + ' chars');
}

/* ★ 2026-10-27：欢迎卡建议词必须**透出到 API 行**。
   真机现象：所有内置 agent 的欢迎卡都是同一套通用按钮。
   根因：`core/agents.js` 解析了 `.agent.md` 的 `suggestions:`，但 `lib/index.js` 的两处
        行映射（GET /api/agents 与名册 JSON）都**没带这个字段** ⇒ 前端 cardModel() 拿到
        undefined ⇒ suggestionsOf() 一路兜到通用三条。
   守它是因为：这属于"解析了但没透出"的静默断链，任何一侧单改都看不出来。 */
{
	const idx = strip(read('lib/index.js'));
	const rowBlocks = idx.split('agents: shownAgents.map(a => ({').slice(1);
	check('找到 ≥2 处 agent 行映射', rowBlocks.length >= 2, rowBlocks.length + ' 处');
	for (const [i, blk] of rowBlocks.entries()) {
		const body = blk.slice(0, 900);
		check(`行映射 #${i + 1} 透出 suggestions`, /suggestions:\s*a\.suggestions/.test(body));
	}
	const core = strip(read('lib/core/agents.js'));
	check('core/agents.js 仍解析 md 的 suggestions', /const suggestions = listValue\(meta\.suggestions\)/.test(core));
}

/* ★ 2026-11-03：Bots 工作台（含侧栏 SSR 版 sideview.js）已整体下线 ⇒ 上面那组 C2 断言随之移除；
   反向断言：sideview.js 不许复活（bots 只从聊天框侧栏「Bots」页签进）。 */
check('侧栏 SSR 版（lib/sideview.js）已随工作台删除', !fs.existsSync(path.join(ROOT, 'lib/sideview.js')));

/* ★ 2026-10-28：IM 绑定页 / 渠道的平台清单**不许在客户端再写一份**。
   真机事故：服务端 BINDING_PLATFORMS 有 5 个平台，适配器、凭据、网关全都做好，
   而绑定页的下拉写死成 `[['loopback',…],['feishu',…]]` ⇒ telegram / discord / 企业微信
   **根本选不到** ⇒ 功能可达性为零（差的就是一个下拉）。
   这类"两份清单漂移"在本项目已发生多次（工作台清单 / 工具面快照 / preset 清单），
   所以用源码断言钉住；平台语义（inboundMode 等）则直接 import 真源做行为断言。 */
{
	const idxSrc = read('lib/index.js');
	/* ★ 2026-11-03：IM 绑定**页面**随 Bots 工作台一起下线（原 client.agents.js 的渠道 section 已删）。
	   页面 UI 的断言等渠道 section 在会话「设置」页签重建时再加回来；这里只留 Host 侧口径。 */
	check('IM 绑定页（工作台渠道 section）已随工作台下线', !fs.existsSync(path.join(ROOT, 'lib/client.agents.js')));

	/* ★ 2026-10-29 真机：飞书里能收到答复，但 Bots 页/工作区只有一串「(未命名会话)」。
	   判据：派发必须**每个绑定固定一条会话**（imSessions 映射），且只在新建时起名。 */
	const bindMod = read('lib/bindings.js');
	check('IM 绑定：目标只剩 agent（dsh 群聊下线 ⇒ targetKind 恒为 agent）',
		/const targetKind = 'agent';/.test(bindMod) && !/targetKind[^;\n]{0,40}'group'/.test(bindMod));
	check('IM 派发：优先复用绑定记住的会话（imSessions.get）',
		/deps\.imSessions/.test(bindMod) && /sessMap\.get\(config, binding\.id\)/.test(bindMod) && /sessMap\.set\(config, binding\.id, sessionId\)/.test(bindMod));
	check('IM 派发：会话失效才重建（canDeliver 判活）',
		/canDeliver\(sessionId\)/.test(bindMod) && /typeof live\.steer === 'function'/.test(bindMod));
	check('IM 派发：首次派发 + 新建时起名（之后不覆盖用户改过的名字）',
		/\(created \|\| firstBind\) && typeof deps\.renameSession === 'function'/.test(bindMod) && /const firstBind = !sessionId/.test(bindMod));
	check('index.js：imSessions / renameSession 都注入到 dispatch（走 sessionController.rename）',
		/getImSession\(c, bindingId\)/.test(idxSrc) && /sc\.rename\(\{ sessionId, title \}\)/.test(idxSrc));

	const { IM_PLATFORM_DEFS, isInboundStartable } = await import('../lib/imPlatforms.js');
	const impl = IM_PLATFORM_DEFS.filter((d) => d.implemented);
	check('imPlatforms：每个已接入平台都有 inboundMode / inboundLabel / chatIdHint',
		impl.every((d) => !!d.inboundMode && !!d.inboundLabel && !!d.chatIdHint),
		impl.map((d) => d.key + ':' + d.inboundMode).join(' '));
	check('imPlatforms：inboundMode 只允许 ws / poll / callback',
		impl.every((d) => ['ws', 'poll', 'callback'].includes(d.inboundMode)));
	check('isInboundStartable：被动回调平台为 false，其余为 true',
		impl.filter((d) => d.inboundMode === 'callback').every((d) => !isInboundStartable(d))
		&& impl.filter((d) => d.inboundMode !== 'callback').every((d) => isInboundStartable(d)));
	check('index.js：inbounds 覆盖全部可启停平台（漏一个 ⇒ 那平台永远显示"未启动"）',
		impl.filter((d) => isInboundStartable(d))
			.every((d) => new RegExp('\\b' + d.key + ':\\s*state\\.').test(idxSrc)),
		impl.filter((d) => isInboundStartable(d)).map((d) => d.key).join(' '));
}

/* ★ 2026-10-29：工具名快照（首启提速）—— 纯逻辑 + 接线守卫。
   背景：`dsh-tools` 的 `schemas(scope)` 会对每个可见工具深拷贝一次 parameters（197 个工具），
   而 `denyTools` 收敛只要名字 ⇒ 30 个 preset × 每轮 tools/change ⇒ 十几秒白烧。 */
{
	const { createToolNameSnapshot, visibleToolNames } = await import('../lib/core/toolNames.js');

	/* ★ 2026-10-29：preset 聚类（首启提速的**平方级**杠杆）—— 纯逻辑 + 不变量。
	   机制：每个 agent 一个 preset ⇒ 注册 N 个 ⇒ dsh 的 discovery **每次注册都全量重扫 roots**
	   （官方源码 `packages/preset/agent-presets/src/discovery.ts`："re-reads the roots on every call"）⇒ O(N²)
	   ⇒ 实测 26 个 preset ≈ 13.4s（去掉 21 个内置 ⇒ `ready in` 22919 → 11784ms）。 */
	{
		const { clusterKeyOf, presetClusterIdOf, presetClusterOf } = await import('../lib/core/agents.js');
		const agent = (id, tools) => ({ id, tools });

		check('聚类键只看 tools 白名单（顺序无关；人设/模型不进键）',
			clusterKeyOf(agent('a', ['x', 'y'])) === clusterKeyOf(agent('b', ['y', 'x'])),
			clusterKeyOf(agent('a', ['x', 'y'])));
		check('聚类：tools 不同的 agent 不合并',
			presetClusterOf([agent('a', ['x']), agent('b', ['y'])]).length === 2);
		const same = presetClusterOf([agent('b', ['x']), agent('a', ['x'])]);
		check('聚类：tools 相同的 agent 合并成一类',
			same.length === 1 && same[0].agents.join(',') === 'a,b', JSON.stringify(same));
		const none = presetClusterOf([agent('a', []), agent('b', [])]);
		check('聚类：没声明 tools 的 agent 归到同一类（白名单相同 ⇒ 可以共用）',
			none.length === 1 && none[0].agents.join(',') === 'a,b', JSON.stringify(none));
		const o1 = JSON.stringify(presetClusterOf([agent('a', ['x']), agent('b', ['x'])]));
		const o2 = JSON.stringify(presetClusterOf([agent('b', ['x']), agent('a', ['x'])]));
		check('聚类：结果与输入顺序无关', o1 === o2, o1);
		check('cluster id 稳定且带前缀（同样 key ⇒ 同样 id）',
			presetClusterIdOf('x|y') === presetClusterIdOf('x|y') && presetClusterIdOf('x|y').startsWith('vssaros-cluster-'),
			presetClusterIdOf('x|y'));
		const ids = ['x', 'y', 'x|y', ''].map(presetClusterIdOf);
		check('cluster id 不撞（抽样几个不同的 key）', new Set(ids).size === ids.length, ids.join(' '));
	}

	/* ★ 2026-10-29：lazy 注册（首启提速，实测端到端 30.7–33.0s → 20.6–21.8s）。 */
	{
		const { pickLazyEagerKeys, presetIdOf } = await import('../lib/core/agents.js');
		const keys = ['a', 'b', 'c', 'd', 'e'];
		const deleg = new Set([presetIdOf('d'), presetIdOf('e')]);
		const r1 = pickLazyEagerKeys(keys, { delegatable: deleg, recent: [], max: 1 });
		check('lazy 首批：委派清单引用的不受 max 限制（缺了 tool-subagent 整个 preset 起不来）',
			r1.has('d') && r1.has('e'), [...r1].join(','));
		const r2 = pickLazyEagerKeys(keys, { recent: [presetIdOf('c'), 'vssaros-b-assign'], max: 0 });
		check('lazy 首批：最近会话用过的 preset 必须在（桌面窗口启动即恢复上次会话；旧 -assign id 不再对应任何 key）',
			r2.has('c') && r2.size === 1, [...r2].join(','));
		const r3 = pickLazyEagerKeys(keys, { max: 3 });
		check('lazy 首批：不够 max 时按扫描顺序补',
			[...r3].join(',') === 'a,b,c', [...r3].join(','));

		const idx = strip(read('lib/index.js'));
		// ⚠ applyDesired 现在带第 4 个参数（计时用的 phase 标签）⇒ 只钉前三个实参，末尾允许 `, …`
		check('lazy：阶段 2 必须用同一批 key 门控（否则会把全部注册回去）',
			/await applyDesired\(okPresetIds, true, phase2Only(?:,|\))/.test(idx)
			&& /const phase2Only = lazyMode \? new Set\(\[\.\.\.eagerKeys\]/.test(idx));
		check('lazy：补齐整个 state 只排一个定时器',
			/function scheduleLazyFill\(state, config, total\) \{\s*if \(state\.lazyFill\) \{\s*return;/.test(idx));
		check('lazy：补齐 / 启动首轮 / rescan 都走 syncSerial（先等在飞的一轮，避免并发重复注册）',
			/async function syncSerial\(state, presets, config\) \{\s*try \{ await state\.syncing; \}[\s\S]{0,80}return syncOnce\(state, presets, config\);/.test(idx)
			&& (idx.match(/await syncSerial\(state, state\.presets, config\)/g) || []).length >= 3,
			(idx.match(/await syncSerial\(state, state\.presets, config\)/g) || []).length + ' 处');
		check('两阶段注册：第一阶段只注册可委派的（否则每个 preset 注册两次）',
			/await applyDesired\(null, false, new Set\(gate\(missingKeys\)\.filter\(isDelegatableKey\)\)(?:,|\))/.test(idx));
		// ⚠ withLazyPresetGuard 现在带第 2 个参数（toolsOf 回调）⇒ 只钉到第一个实参，别写死右括号
		check('lazy：两处 sessionController 都套了"建会话前先补齐"',
			(idx.match(/state\.sessionController = withLazyPresetGuard\(child\.sessionController/g) || []).length === 2);
		check('lazy：有回退开关（配置 presetMode: eager / 环境变量 =off）',
			/config\?\.presetMode !== 'eager' && process\.env\.VSSAROS_DSH_PRESET_MODE !== 'off'/.test(idx));
		check('lazy：第二阶段不做可委派 preset（每个 preset 挂载 ~0.4s ⇒ 5 个就是 ~2s）',
			/const phase2Only = lazyMode \? new Set\(\[\.\.\.eagerKeys\]\.filter\(\(key\) => !isDelegatableKey\(key\)\)\) : eagerKeys;/.test(idx)
			&& /await applyDesired\(okPresetIds, true, phase2Only(?:,|\))/.test(idx));
		check('MCP 计时探针：工具成簇出现时记一行（host 启动后多少 ms）',
			/MCP 工具到位：host 启动后 \$\{Date\.now\(\) - hostStartedAt\}ms/.test(idx));
	}

	// 快路径：只用内部 view() 的 key，**不碰 schemas()**（深拷贝是那十几秒的大头）。
	let schemaCalls = 0;
	const fast = {
		view: () => ({ visible: new Map([['a', {}], ['b', {}]]) }),
		schemas: () => { schemaCalls += 1; return [{ name: 'a' }, { name: 'b' }]; },
	};
	check('工具名：走内部 view() 取名字（不调用 schemas ⇒ 不做 JSON 深拷贝）',
		JSON.stringify(visibleToolNames(fast)) === JSON.stringify(['a', 'b']) && schemaCalls === 0,
		`schemaCalls=${schemaCalls}`);

	// 退回：没有 view() ⇒ 用 schemas()，语义一致。
	const legacy = { schemas: () => [{ name: 'x' }, { name: 'y' }] };
	check('工具名：内部 API 不可用时退回 schemas()',
		JSON.stringify(visibleToolNames(legacy)) === JSON.stringify(['x', 'y']));

	// view() 抛错 ⇒ 也要能退回（不能整轮收敛停摆）。
	const broken = { view: () => { throw new Error('boom'); }, schemas: () => [{ name: 'z' }] };
	check('工具名：内部 API 抛错时退回 schemas()',
		JSON.stringify(visibleToolNames(broken)) === JSON.stringify(['z']));

	// 注册表没就绪 ⇒ null（调用方等下一次 tools/change）
	check('工具名：schemas() 抛错 ⇒ 返回 null（等下一次 tools/change）',
		visibleToolNames({ schemas: () => { throw new Error('not ready'); } }) === null);
	check('工具名：没有 tools ⇒ null', visibleToolNames(undefined) === null);

	// 缓存：同版本复用；invalidate 后重算。
	let calls = 0;
	const counting = { view: () => { calls += 1; return { visible: new Map([['t', {}]]) }; } };
	const snap = createToolNameSnapshot();
	snap.namesOf(counting);
	snap.namesOf(counting);
	check('工具名快照：同版本内复用（不重复枚举）', calls === 1, `calls=${calls}`);
	snap.invalidate();
	snap.namesOf(counting);
	check('工具名快照：收到 tools/change 后必须重算（不漏藏新工具）', calls === 2, `calls=${calls}`);

	// 按实例隔离：两个 preset 的可见集不同 ⇒ 不能互相污染。
	const instA = { view: () => ({ visible: new Map([['a-tool', {}]]) }) };
	const instB = { view: () => ({ visible: new Map([['b-tool', {}]]) }) };
	const snap2 = createToolNameSnapshot();
	const na = snap2.namesOf(instA);
	const nb = snap2.namesOf(instB);
	const na2 = snap2.namesOf(instA);
	check('工具名快照：按实例隔离（A 的名字不会串到 B）',
		JSON.stringify(na) === JSON.stringify(['a-tool'])
		&& JSON.stringify(nb) === JSON.stringify(['b-tool'])
		&& JSON.stringify(na2) === JSON.stringify(['a-tool']),
		`${JSON.stringify(na)}/${JSON.stringify(nb)}/${JSON.stringify(na2)}`);

	// 接线：index.js 的收敛必须走快照（不许再直接 schemas()）
	const idxForTools = strip(read('lib/index.js'));
	check('index.js：工具面收敛走快照（不许再逐次 schemas() 深拷贝）',
		/createToolNameSnapshot/.test(idxForTools)
		&& /nameSnapshot\.namesOf\(child\.tools\)/.test(idxForTools)
		&& !/child\.tools\.schemas\?\.\(\)/.test(idxForTools));
	check('index.js：agent allowlist 路径也走快照（每个 agent 一份，同样不许逐次 schemas()）',
		/nameSnapshot\.namesOf\(tools\)/.test(idxForTools)
		&& !/tools\.schemas\?\.\(\)/.test(idxForTools));
	// 去抖窗口：成簇的 tools/change（MCP 一口气注册 39 个工具）必须合并成一轮，
	// 否则"轮数 × 作用域数"就是首启的十几秒；但也不能放大到没边。
	const debounceMatch = /const TOOL_SURFACE_DEBOUNCE_MS = (\d+);/.exec(idxForTools);
	check('index.js：收敛去抖窗口已放大（成簇事件合并成一轮）',
		!!debounceMatch && Number(debounceMatch[1]) >= 500 && Number(debounceMatch[1]) <= 2000,
		debounceMatch ? debounceMatch[1] : 'not found');
	check('index.js：两处收敛 schedule 都用同一个去抖窗口（不许一处改一处没改）',
		(idxForTools.match(/timer = undefined; sync\(\); \}, TOOL_SURFACE_DEBOUNCE_MS\)/g) || []).length === 2,
		(idxForTools.match(/TOOL_SURFACE_DEBOUNCE_MS\)/g) || []).length + ' 处引用');
}

/* ★ 2026-10-26：把两个**独立单测**纳入包内自检。
   为什么：它们各自是可执行脚本（`node xxx.test.mjs`），不进 run-all 的 `p3-*` 扫描，
   也不会被别人顺手跑到 ⇒ 等于没有 CI 覆盖。这里用子进程跑一遍，按退出码判定。 */
{
	const { spawnSync } = await import('node:child_process');
	// ★ 2026-11-03：群聊下线 ⇒ mentions / dispatch-budget / member-policy / owner-policy / relay-policy /
	//   group-session / group-ops 这几个群专属单测随功能一起删除，不再在此执行。
	for (const t of ['bindings.test.mjs', 'feishu-adapter.test.mjs', 'feishu-inbound.test.mjs', 'channel-policy.test.mjs', 'pairing.test.mjs', 'dead-letters.test.mjs', 'telegram-adapter.test.mjs', 'discord-adapter.test.mjs', 'wecom-adapter.test.mjs', 'binding-media.test.mjs', 'outbound-media.test.mjs', 'feishu-gateway.test.mjs', 'git-lanes.test.mjs', 'atomic-write.test.mjs', 'im-credentials.test.mjs', 'inbound-state.test.mjs', 'im-session-map.test.mjs', 'feishu-raw-ws.test.mjs', 'im-inbound-lock.test.mjs', 'host-self-watch.test.mjs', 'rooms.test.mjs', 'rooms-restart.test.mjs',
		// ★ 2026-11-06：团队总线（含契约修订 2）、团队步骤记忆（模型提炼）、DS Bot 团队离线导入
		'team-bus.test.mjs', 'step-memory.test.mjs', 'ds-bot-import.test.mjs']) {
		const r = spawnSync(process.execPath, [path.join(HERE, t)], { encoding: 'utf8' });
		const last = String(r.stdout || '').trim().split('\n').filter(Boolean).pop()
			|| String(r.stderr || '').slice(0, 120);
		check(`包内单测 ${t} 通过`, r.status === 0, last);
	}
}

/* ── 群聊功能整体下线（★ 2026-11-03 用户要求「移除群聊功能和 UI 入口」）──────────────────
   原来这一带的四组断言（群工具三件套 / 写口幂等 / 成员上限 / invitation-first）全部随功能删除，
   改成**反向断言**：群相关模块与工具不许复活（复活即红，防止有人把功能偷偷加回来）。
   parseMentions / clipDispatchText 等被 IM 渠道复用的工具已抽到 lib/textUtils.js 与 lib/agentSession.js。 */
{
	const { TOOL_NAMES, WRITE_TOOLS } = await import('../lib/tools.js');
	for (const n of ['agent_group_create', 'agent_group_invite', 'agent_group_leave', 'agent_group_invites', 'agent_group_invite_respond']) {
		check(`群工具 ${n} 已移除`, !TOOL_NAMES.includes(n));
	}
	check('群工具不再进审批闸名单', WRITE_TOOLS.every(n => !n.startsWith('agent_group_')), JSON.stringify(WRITE_TOOLS));
	for (const f of ['lib/groups.js', 'lib/groupPage.js', 'lib/groupFiles.js', 'lib/groupTasks.js', 'lib/mentions.js', 'lib/core/groupOps.js', 'lib/core/groupChat.js', 'lib/client.groupChat.js']) {
		check(`${f} 已删（群聊下线）`, !fs.existsSync(path.join(ROOT, f)));
	}
	const toolsSrc = strip(read('lib/tools.js'));
	check('tools.js 不再 import groups.js（服务层已删）', !/from '\.\/groups\.js'/.test(toolsSrc));
	check('IM 渠道复用的文本工具已搬到 textUtils.js', fs.existsSync(path.join(ROOT, 'lib/textUtils.js'))
		&& /from '\.\/textUtils\.js'/.test(read('lib/bindings.js')));
	check('IM 派发找会话的工具已搬到 agentSession.js', fs.existsSync(path.join(ROOT, 'lib/agentSession.js'))
		&& /ensureAgentSession/.test(read('lib/index.js')));
	const idx = read('lib/index.js');
	check('群路由已摘（api/groups、group-file、/group 页面）', !/api\/groups|api\/group-file|ROUTE_PREFIX}\/group/.test(idx));
	check('首页收件箱不再推导群消息（buildHomeData 无 groups 参数）', !/groups: groupsData/.test(idx));
}

/* ── ★ 2026-11-05 多 bot 群聊（新设计，lib/rooms.js；与上面下线的旧群聊互不相干）─────────────
   群 = 一条专属会话 + 成员名单；群会话不调模型（llm/stream 合成 group_relay）；成员在影子会话里回答。
   行为由 rooms.test.mjs 真跑；这里钉接线：路由、投影、总线、安装都在 index.js 里。 */
{
	const idx = strip(read('lib/index.js'));
	check('群聊路由 /api/rooms 已接（分派在 rooms.js 的 roomsApi：create / update / flags / delete / progress）',
		/ROUTE_PREFIX}\/api\/rooms`/.test(idx) && /roomsApi\(state\.rooms/.test(idx)
		&& ['create', 'update', 'flags', 'delete'].every(a => read('lib/rooms.js').includes(`action === '${a}'`)));
	check('群标记投影已注册（页面 projectionValues["vssaros-room"]）', /register\(roomProjection\(\)\)/.test(idx));
	check('群聊运行时装在顶层角色（installRooms）且向团队总线提供建群（provideGroups）',
		/installRooms\(ctx, state\.rooms\)/.test(idx) && /teamBus\(\)\.provideGroups\(state\.rooms\)/.test(idx));
	const roomsSrc = strip(read('lib/rooms.js'));
	check('@群 / 引用会话桥：session-reference ⇒ postToRoom ⇒ 群会话 user/message，唤醒 group_relay',
		/ROOM_REFERENCE_KIND/.test(roomsSrc) && /postToRoom\(/.test(roomsSrc)
		&& /rooms\.postToRoom\(ref\.roomId/.test(roomsSrc) && /form: ROOM_POST_FORM/.test(roomsSrc));
	check('群执行全局进度端点 ?active=1 与 room-progress 同口径',
		/get\?\.\('active'\)/.test(roomsSrc) && /rooms\.active\(\)/.test(roomsSrc) && /finishedAt/.test(roomsSrc));
	check('P0 建群按 originTriggerId 幂等：rooms.create 复用旧群、总线透传幂等键',
		/originTriggerId/.test(roomsSrc) && /const existing = \[\.\.\.rooms\.values\(\)\]\.find/.test(roomsSrc)
		&& /originTriggerId/.test(strip(read('lib/teamBus.js'))));
	check('群进度状态节点与错误兜底：events 独立于 replies，progress/active/工具结果都带',
		/ROOM_WORK_GRACE_MS/.test(roomsSrc) && /pushEvent\(round, 'working'/.test(roomsSrc)
		&& /events: round\.events/.test(roomsSrc) && /events: round\.events \|\| \[\]/.test(roomsSrc));
	check('群执行过程落盘并重启恢复：save 写 rounds、load 读 rounds、未完成轮次收口 cut',
		/version: ROOMS_FILE_VERSION/.test(roomsSrc) && /rounds: \[\.\.\.rounds\.values\(\)\]/.test(roomsSrc)
		&& /Array\.isArray\(raw\?\.rounds\)/.test(roomsSrc) && /phase = 'cut'/.test(roomsSrc)
		&& /void save\(\)/.test(roomsSrc) && /interrupted/.test(roomsSrc));
	check('群执行持久化加固：未来版本只读冻结、同拍合并写、flush、载入裁剪、dispose 时落盘并交还租约',
		/version > ROOMS_FILE_VERSION/.test(roomsSrc) && /if \(frozen\)/.test(roomsSrc) && /if \(queuedWrite\)/.test(roomsSrc)
		&& /async function flush\(\)/.test(roomsSrc) && /pruneRounds\(\)/.test(roomsSrc) && /rooms\.close \?\? rooms\.flush/.test(roomsSrc));
	check('群执行单写者租约：载入接管、落盘前核对 token、被接管即只读（行为见 rooms.test / rooms-restart.test）',
		/const leaseFile = /.test(roomsSrc) && /await claimLease\(\)/.test(roomsSrc)
		&& /owner\.token !== leaseToken/.test(roomsSrc) && /freeze\('superseded'/.test(roomsSrc));
	check('群执行跨插件契约：工具结果 / progress / active 共用 roundOutput（schema + 统一 status + 关联 id）',
		/function roundOutput\(round\)/.test(roomsSrc) && /schema: ROUND_SCHEMA/.test(roomsSrc) && /roundStatusOf\(round\)/.test(roomsSrc)
		&& /\.\.\.roundOutput\(round\)/.test(roomsSrc) && /map\(roundView\)/.test(roomsSrc) && /originTriggerId: room\.originTriggerId/.test(roomsSrc));
	const pkg = JSON.parse(read('package.json'));
	check('群聊模块进了 files 白名单', ['lib/rooms.js', 'lib/core/rooms.js'].every(f => pkg.files.includes(f)));
}

/* ── 导出 / 导入**带历史**（2026-10-31，P1；对齐 DSB 的 `.botharness/git-history.bundle`）──
   以前包里只有"最后一次的记忆内容" ⇒ 换台机器装回来，演化 / 回滚 / 版本名全没了。 */
{
	const packSrc = strip(read('lib/pack.js'));
	check('历史来自统一记忆（bundleBotHistory / importBotHistory）', /bundleBotHistory\(/.test(packSrc) && /importBotHistory\(/.test(packSrc));
	check('★ 历史**默认不带**（里面还留着删掉过的内容 ⇒ 必须显式勾选）',
		/options\.includeHistory === true/.test(packSrc));
	check('bundle 有单独的大小上限（挡"塞个大家伙进来"）', /MAX_HISTORY_BYTES/.test(packSrc));
	/* ★ 光在库里支持不够 —— **接口也要够得着**，否则就是死配置（没人能勾） */
	const indexSrc3 = read('lib/index.js');
	check('★ 导出接口接上了 history 开关（GET `&history=1` + POST `history:true`）',
		/includeHistory: url\.searchParams\.get\('history'\) === '1'/.test(indexSrc3)
		&& /includeHistory: body\?\.history === true/.test(indexSrc3));
	check('落盘导出的回执带 history（带没带、多大、为什么没带）',
		/history: pack\.history/.test(packSrc));
	/* ⚠ 这个块里没有 TOOL_NAMES ⇒ 直接用会 ReferenceError（块作用域不共享，刚踩到：
	   整个自检脚本在最后一行崩掉 ⇒ 后面新增的断言**一条都没跑**，看着像"全绿"其实没验）。 */
	const { TOOL_NAMES: TOOL_NAMES3 } = await import('../lib/tools.js');
	check('工具面与快照对得上（TOOL_NAMES 非空且无群工具）',
		TOOL_NAMES3.length >= 6 && TOOL_NAMES3.every(n => !n.startsWith('agent_group_')), TOOL_NAMES3.join(','));
}

/* ── 右栏记忆页签（★ 2026-11-03：Bots 工作台下线，页面部分删除；Host 侧演化链断言保留）── */
{
	check('Bots 工作台 React 已删（记忆页签 UI 随之移除）', !fs.existsSync(path.join(ROOT, 'lib/client.agents.js')));
	check('清单里不再有 vssaros.workbench.floatingActions',
		!(pkg.vssaros && pkg.vssaros.workbench && 'floatingActions' in pkg.vssaros.workbench));
}

console.log(`\n[agents] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
