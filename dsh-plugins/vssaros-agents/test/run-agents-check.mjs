// @vssaros/dsh-agents — 包内自检（工作台模板 S15）。
//   跑法：node dsh-plugins/vssaros-agents/test/run-agents-check.mjs
//   两类断言：
//     ① 静态契约（清单 / patch / 入口 / 组件 / 共享层 / 容器查询 / 锚点 / 零 iframe）
//     ② 纯逻辑：clipText（截断）/ timeLabel（今天给 HH:MM）/ agoLabel（相对时间）/ clampImportLimit（导入上限）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agoLabel, clipText, timeLabel } from '../lib/activity.js';
import { clampImportLimit } from '../lib/agentmemoryImport.js';
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
check('清单声明工作台 title', !!pkg.vssaros?.workbench?.title, pkg.vssaros?.workbench?.title);
check('注入自有宿主 @vssaros/dsh-workbenches', (pkg.dsh?.client?.inject || []).includes('@vssaros/dsh-workbenches'));
const patchField = pkg.dsh?.bundle?.patch;
check('清单带 dsh.bundle.patch', /cordis\.patch\.yml/.test(String(Array.isArray(patchField) ? patchField.join(',') : patchField)), JSON.stringify(patchField));
check('files 里含 cordis.patch.yml', (pkg.files || []).includes('cordis.patch.yml'));
const patch = read('cordis.patch.yml');
check('patch 有 insert 段', /-\s*insert:/.test(patch));
check('patch 的 name 与包名一致', patch.includes(`'@vssaros/dsh-agents'`));

console.log('── 入口与组件 ──');
check('入口不写 chunk: 字段', !/^\s*chunk\s*:/m.test(strip(read('lib/client.js'))));
const component = listLib().map((p) => ({ p, text: strip(fs.readFileSync(p, 'utf8')) }))
	.filter((x) => /desktopWorkbenches\.register\(/.test(x.text))
	.sort((a, b) => (b.text.match(/\bwb-[a-z-]+/g) || []).length - (a.text.match(/\bwb-[a-z-]+/g) || []).length)[0];
check('找到工作台组件（含 register）', !!component, component?.p.split(/[\\/]/).pop());
const src = component?.text || '';
check('描述符带 repository（vssaros:<模块>）', /repository:\s*'vssaros:agents'/.test(src));
check('根节点有 data-vssaros-surface="workbench"', /data-vssaros-surface['"]?\s*:\s*['"]workbench/.test(src));
check('工具条锚点恰好 1 个', (src.match(/data-dsh-workbench-toolbar/g) || []).length === 1);
const wbClasses = new Set((src.match(/'wb(?:-[a-z0-9]+)*'/g) || []).map((s) => s.slice(1, -1)));
check('用到 ≥10 个 wb-* 原语', wbClasses.size >= 10, wbClasses.size + ' 个');
const bare = src.split('\n').filter((l) => !l.includes('var(--') && (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(rgba?|hsla?)\(/.test(l)));
check('无裸色值', bare.length === 0, bare.slice(0, 2).join(' | '));
check('有 @container（窄栏重排）', /@container/.test(src));
check('不再用 @media (max-width) 判宽', !/@media[^{]*\(\s*max-width/.test(src));
check('≥3 个 data-* 锚点', new Set(src.match(/data-[a-z0-9-]{3,30}/g) || []).size >= 3);
check('零 iframe', !/<iframe|createElement\(['"]iframe/.test(src));

console.log('── clipText ──');
check('短文本原样返回', clipText('abc', 10) === 'abc');
check('超长截断并加省略号', clipText('abcdef', 3) === 'abc…', clipText('abcdef', 3));
check('正好等于长度不截断', clipText('abc', 3) === 'abc');
check('null/undefined 安全', clipText(null, 5) === '' && clipText(undefined, 5) === '');

console.log('── timeLabel / agoLabel ──');
{
	const now = Date.now();
	check('空值 ⇒ 空字符串', timeLabel(null) === '' && timeLabel(0) === '', JSON.stringify([timeLabel(null), timeLabel(0)]));
	const hm = timeLabel(now);
	check('今天 ⇒ HH:MM（不含日期）', /^\d{2}:\d{2}$/.test(hm), hm);
	const old = timeLabel(now - 3 * 86400 * 1000);
	check('更早 ⇒ 带 M/D', /^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/.test(old), old);
}
check('agoLabel 空值 ⇒ —', agoLabel(null) === '—', agoLabel(null));
check('agoLabel 30 秒前 ⇒ 「N 秒前」', /秒前/.test(agoLabel(Date.now() - 30 * 1000)), agoLabel(Date.now() - 30 * 1000));
check('agoLabel 5 分钟前 ⇒ 「N 分钟前」', /分钟前/.test(agoLabel(Date.now() - 5 * 60 * 1000)), agoLabel(Date.now() - 5 * 60 * 1000));
check('agoLabel 3 小时前 ⇒ 「N 小时前」', /小时前/.test(agoLabel(Date.now() - 3 * 3600 * 1000)), agoLabel(Date.now() - 3 * 3600 * 1000));
check('agoLabel 未来时间不出现负数', !/-/.test(agoLabel(Date.now() + 60 * 1000)), agoLabel(Date.now() + 60 * 1000));

console.log('── clampImportLimit ──');
{
	const dflt = clampImportLimit(0);
	check('0 / 负数 / 非数字 ⇒ 回默认值', dflt > 0 && clampImportLimit(-5) === dflt && clampImportLimit('abc') === dflt, String(dflt));
	check('字符串数字被解析', clampImportLimit(' 42 ') === 42, String(clampImportLimit(' 42 ')));
	check('小数向下取整', clampImportLimit(12.9) === 12, String(clampImportLimit(12.9)));
	const huge = clampImportLimit(1e9);
	check('超大值被夹到上限（且不大于入参）', huge > 0 && huge < 1e9, String(huge));
	check('上限是幂等的（再夹一次不变）', clampImportLimit(huge) === huge, String(clampImportLimit(huge)));
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
	const derived = toPresetDefinition({ ...base, model: 'm' }, { provider: 'p', idSuffix: '-assign' });
	check('-assign ⇒ 无 delegation 组、有 default-model', !rowIdsOf(derived.definition.plugins).includes('delegation') && rowIdsOf(derived.definition.plugins).includes('default-model'));
	check('-assign 的 preset id 带后缀', derived.definition.id === 'vssaros-probe-assign', derived.definition.id);

	// 两次构造互不影响（基座是深拷贝，不能被上一个 agent 的差量污染）
	const again = toPresetDefinition(base, { provider: 'p' });
	const sub2 = findDeep(again.definition.plugins, 'tool-subagent');
	check('基座深拷贝（上次的清单不残留）', !sub2?.config?.allowedAgentPresets, JSON.stringify(sub2?.config));
	check('基座本体未被改写', !JSON.stringify(STANDARD_BASE_ROWS).includes('backgroundMode'));
	check('人设行带本 preset id（运行时 allowlist 防误伤）', definition.plugins[0]?.config?.presetId === 'vssaros-probe' && derived.definition.plugins[0]?.config?.presetId === 'vssaros-probe-assign', JSON.stringify([definition.plugins[0]?.config?.presetId, derived.definition.plugins[0]?.config?.presetId]));
}

// ── 工具 allowlist（2026-10-25 真机：saroasis-studio 会话里只剩 skill + subagent）──────────
// 旧实现在 preset 作用域 `restrict({ allow: [全局名] })` ⇒ agent 从 preset 层继承的基座工具被一起筛掉。
// 新实现：agent 作用域 `restrict({ deny: allowlistDenyOf(...) })`。下面钉**绝对期望值**（不是相对比较）。
console.log('── 工具 allowlist ──');
{
	const globals = ['skill', 'browser', 'kb_search', 'codebase_search', 'mcp__x__y', 'run_code', 'memory_list'];
	const deny = allowlistDenyOf(['read', 'write', 'pwsh', 'web_search', 'skill'], globals);
	check('saroasis 口径：deny = 其余全局工具', JSON.stringify(deny) === JSON.stringify(['browser', 'codebase_search', 'kb_search', 'mcp__x__y', 'memory_list']), JSON.stringify(deny));
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

/* ★ 2026-10-27（方案 C2）：侧栏点条目必须**分栏打开** —— 中栏开会话（绑该 bot 人格）+ 右栏开设置。
   守它是因为：这条链路全靠两个桥方法都在才成立，缺一个就会静默退回"打开整页"（C1 老形态）。 */
{
	const sv = strip(read('lib/sideview.js'));
	check('C2：优先调 openBot（由宿主布局：chat 左、设置右）', /typeof bridge\.openBot === 'function'/.test(sv) && /bridge\.openBot\(id\)/.test(sv));
	check('C2：点条目调用 newChat(preset)', /bridge\.newChat\(preset\)/.test(sv));
	check('C2：点条目调用 openAgentSettings(id)', /bridge\.openAgentSettings\(id\)/.test(sv));
	check('C2：openFull 从行上取 data-preset（新会话才绑得上人格）', /getAttribute\('data-preset'\)/.test(sv));
	check('C2：两能力都在时不再开整页（提前 return）', /if \(ok >= 2\) \{ note\(.+\n?.{0,40}return; \}/.test(sv) || /if \(ok >= 2\)/.test(sv));
	check('C2：缺能力时退回 openModulePage（不静默）', /openModulePage\('\/x\/agents\/'\)/.test(sv));
	check('C2：页面能力检测用 typeof（老桥不炸）', /typeof bridge\.newChat === 'function'/.test(sv) && /typeof bridge\.openAgentSettings === 'function'/.test(sv));
}

/* ★ 2026-10-28：IM 绑定页 / 渠道的平台清单**不许在客户端再写一份**。
   真机事故：服务端 BINDING_PLATFORMS 有 5 个平台，适配器、凭据、网关全都做好，
   而绑定页的下拉写死成 `[['loopback',…],['feishu',…]]` ⇒ telegram / discord / 企业微信
   **根本选不到** ⇒ 功能可达性为零（差的就是一个下拉）。
   这类"两份清单漂移"在本项目已发生多次（工作台清单 / 工具面快照 / preset 清单），
   所以用源码断言钉住；平台语义（inboundMode 等）则直接 import 真源做行为断言。 */
{
	const bindSrc = read('lib/client.agents.js');
	const idxSrc = read('lib/index.js');
	check('IM 绑定页：平台下拉由服务端 platforms / channelDefs 渲染',
		/bdata\.platforms/.test(bindSrc) && /bdata\.channelDefs/.test(bindSrc));
	check('IM 绑定页：不再写死平台选项数组（loopback + feishu 两项）',
		!/\[\['loopback',\s*'模拟器[^']*'\],\s*\['feishu'/.test(bindSrc));
	check('IM 绑定页：chatId 占位来自 imPlatforms 的 chatIdHint',
		/selDef\.chatIdHint/.test(bindSrc));
	check('IM 绑定页：入站状态按所选平台取（不再固定读 data.inbound）',
		/\(bdata\.inbounds \|\| \{\}\)\[p\]/.test(bindSrc));
	check('IM 绑定页：启停入站带 platform（否则后端缺省按飞书处理）',
		/controlInbound\('inbound-start', p\)/.test(bindSrc) && /platform \? \{ action, platform \}/.test(bindSrc));
	/* ★ 2026-10-29 真机截图：「已绑定 channel 的 bot，UI 却显示未连接」。根因是身份条只有
	   一枚「未连接」，而它说的是**会话消息流**没连上 ⇒ 渠道状态必须单独一枚徽章，
	   且实时那枚要把来源写清楚（"实时…"），旧的裸「未连接」不许回来。 */
	check('身份条：渠道状态单独一枚徽章（data-ag-channel，由 bindings + inbounds 算）',
		/'data-ag-channel'/.test(bindSrc) && /channelPillOf\(a\.id\)/.test(bindSrc) && /inbounds\[b\.platform\]/.test(bindSrc));
	check('身份条：实时状态点明来源（data-ag-live-state + 「实时…」），不再裸写「未连接」',
		/'data-ag-live-state'/.test(bindSrc) && /'实时未连'/.test(bindSrc) && !/'未连接'/.test(bindSrc));
	check('身份条：进 Bots 页就拉绑定表（否则渠道徽章永远没数据）',
		/useEffect\(\(\) => \{ void loadBindings\(\); \}, \[loadBindings\]\)/.test(bindSrc));

	/* ★ 2026-10-29 真机：飞书里能收到答复，但 Bots 页/工作区只有一串「(未命名会话)」。
	   判据：派发必须**每个绑定固定一条会话**（imSessions 映射），且只在新建时起名。 */
	const bindMod = read('lib/bindings.js');
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
		const { pickLazyEagerKeys, presetIdOf, assignmentPresetIdOf } = await import('../lib/core/agents.js');
		const keys = ['a', 'b', 'c', 'd', 'e', 'b::assign'];
		const deleg = new Set([presetIdOf('d'), presetIdOf('e')]);
		const r1 = pickLazyEagerKeys(keys, { delegatable: deleg, recent: [], max: 1 });
		check('lazy 首批：委派清单引用的不受 max 限制（缺了 tool-subagent 整个 preset 起不来）',
			r1.has('d') && r1.has('e'), [...r1].join(','));
		const r2 = pickLazyEagerKeys(keys, { recent: [presetIdOf('c'), assignmentPresetIdOf('b')], max: 0 });
		check('lazy 首批：最近会话用过的 preset 必须在（含委派派生版；桌面窗口启动即恢复上次会话）',
			r2.has('c') && r2.has('b::assign') && r2.size === 2, [...r2].join(','));
		const r3 = pickLazyEagerKeys(keys, { max: 3 });
		check('lazy 首批：不够 max 时按扫描顺序补本体，不补委派派生版',
			[...r3].join(',') === 'a,b,c', [...r3].join(','));

		const idx = strip(read('lib/index.js'));
		check('lazy：阶段 2 必须用同一批 key 门控（否则会把全部注册回去）',
			/await applyDesired\(okPresetIds, true, phase2Only\)/.test(idx)
			&& /const phase2Only = lazyMode \? new Set\(\[\.\.\.eagerKeys\]/.test(idx));
		check('lazy：补齐整个 state 只排一个定时器',
			/function scheduleLazyFill\(state, config, total\) \{\s*if \(state\.lazyFill\) \{\s*return;/.test(idx));
		check('lazy：补齐 / 启动首轮 / rescan 都走 syncSerial（先等在飞的一轮，避免并发重复注册）',
			/async function syncSerial\(state, presets, config\) \{\s*try \{ await state\.syncing; \}[\s\S]{0,80}return syncOnce\(state, presets, config\);/.test(idx)
			&& (idx.match(/await syncSerial\(state, state\.presets, config\)/g) || []).length >= 3,
			(idx.match(/await syncSerial\(state, state\.presets, config\)/g) || []).length + ' 处');
		check('两阶段注册：第一阶段只注册可委派的（否则每个 preset 注册两次）',
			/await applyDesired\(null, false, new Set\(gate\(missingKeys\)\.filter\(isDelegatableKey\)\)\)/.test(idx));
		check('lazy：两处 sessionController 都套了"建会话前先补齐"',
			(idx.match(/state\.sessionController = withLazyPresetGuard\(child\.sessionController\)/g) || []).length === 2);
		check('lazy：有回退开关（配置 presetMode: eager / 环境变量 =off）',
			/config\?\.presetMode !== 'eager' && process\.env\.VSSAROS_DSH_PRESET_MODE !== 'off'/.test(idx));
		check('lazy：第二阶段不做可委派 preset（每个 preset 挂载 ~0.4s ⇒ 5 个就是 ~2s）',
			/const phase2Only = lazyMode \? new Set\(\[\.\.\.eagerKeys\]\.filter\(\(key\) => !isDelegatableKey\(key\)\)\) : eagerKeys;/.test(idx)
			&& /await applyDesired\(okPresetIds, true, phase2Only\)/.test(idx));
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
	for (const t of ['mentions.test.mjs', 'dispatch-budget.test.mjs', 'member-policy.test.mjs', 'owner-policy.test.mjs', 'relay-policy.test.mjs', 'group-session.test.mjs', 'bindings.test.mjs', 'feishu-adapter.test.mjs', 'feishu-inbound.test.mjs', 'channel-policy.test.mjs', 'pairing.test.mjs', 'dead-letters.test.mjs', 'telegram-adapter.test.mjs', 'discord-adapter.test.mjs', 'wecom-adapter.test.mjs', 'binding-media.test.mjs', 'outbound-media.test.mjs', 'feishu-gateway.test.mjs', 'memory-dir.test.mjs', 'memory-init.test.mjs', 'git-lanes.test.mjs', 'memory-restore.test.mjs', 'memory-bundle.test.mjs', 'group-ops.test.mjs', 'agentmemory-candidates.test.mjs', 'agentmemory-sync.test.mjs', 'atomic-write.test.mjs', 'im-credentials.test.mjs', 'inbound-state.test.mjs', 'im-session-map.test.mjs', 'feishu-raw-ws.test.mjs', 'im-inbound-lock.test.mjs', 'host-self-watch.test.mjs']) {
		const r = spawnSync(process.execPath, [path.join(HERE, t)], { encoding: 'utf8' });
		const last = String(r.stdout || '').trim().split('\n').filter(Boolean).pop()
			|| String(r.stderr || '').slice(0, 120);
		check(`包内单测 ${t} 通过`, r.status === 0, last);
	}
}

/* ── 群聊三件套（2026-10-31，对齐 DeepSeekBot 的 group_create / group_invite_bot / group_leave）──
   参照 `dsh-bot-agent-adapter.ts:2787+`，但比它更严：DSB 的 `ownerBotSlug` 由建群 bot 自己拿到，
   我们刻意不给（群主只能由人指定 ⇒ 防 bot 互相提权），所以这三个工具给的是"拉起协作"而不是"控制群"。 */
{
	const toolsSrc = read('lib/tools.js');
	const code = strip(toolsSrc);
	const { TOOL_NAMES, WRITE_TOOLS } = await import('../lib/tools.js');
	for (const n of ['agent_group_create', 'agent_group_invite', 'agent_group_leave']) {
		check(`群工具 ${n} 已登记（并在工具快照里）`, TOOL_NAMES.includes(n));
	}
	check('★ 建群过审批闸；拉人 / 退群不过闸（拉人有群级「加入需确认」兜底，退群只影响调用者自己）',
		WRITE_TOOLS.includes('agent_group_create')
		&& !WRITE_TOOLS.includes('agent_group_invite')
		&& !WRITE_TOOLS.includes('agent_group_leave'),
		JSON.stringify(WRITE_TOOLS));
	check('★ 建群不得给自己塞群主（ownerAgentId 只能由人指定 ⇒ 防 bot 互相提权）',
		!/ownerAgentId/.test(code));
	check('★ 三个群工具都要先取当前会话身份，拿不到就拒绝（否则"谁在建群"无从追溯）',
		(code.match(/exec\?\.agent\?\.id/g) || []).length >= 3
		&& (code.match(/拿不到当前会话身份/g) || []).length >= 3);
	check('群工具只复用 groups.js 的服务函数（权限 / 上限 / 去重 / 待确认都在服务层）',
		/from '\.\/groups\.js'/.test(code) && /createGroup\(config/.test(code)
		&& /addGroupMembers\(config/.test(code) && /removeGroupMember\(config/.test(code));
	check('退群只能退自己（member 恒为 selfId，不接受外部传入）',
		/member: selfId/.test(code));
	/* 幂等只对**建群 / 拉人**这两个会重试的写口；两个工具都要能把 operationKey 透传下去 */
	check('★ 群工具透传 operationKey（重试/补发才防得住重复）',
		(code.match(/operationKey: String\(args\.operationKey\)/g) || []).length === 2);
}

/* ── 群聊写口的幂等 + 陈旧防护（2026-10-31，P2；对齐 DSB 的 channel_management_operations）──
   没有这一层时：Bot 重试 / 双击 / 页面重发会把"建群、拉人"真的执行两次
   （拉人靠"已在成员里"能兜住一半，但**待确认区**和"半路失败重试"兜不住）。 */
{
	const groupsSrc = strip(read('lib/groups.js'));
	check('★ 建群接幂等（同 key 同参不重复建）',
		/withIdempotency\(config, \{[\s\S]{0,200}operationKey: input\?\.operationKey[\s\S]{0,200}payload: \{ name, members, mode \}/.test(groupsSrc));
	check('★ 拉人接幂等（payload 带群 id + 成员）',
		/operationKey: input\?\.operationKey,[\s\S]{0,160}payload: \{ id: group\.id, members: wanted \}/.test(groupsSrc));
	check('★ 拉人有陈旧防护（拿旧 updatedAt 覆盖 ⇒ 409，不静默覆盖）',
		/staleDenial\(group, input\?\.expectedUpdatedAt\)/.test(groupsSrc));
	check('幂等回放时如实标记 replayed（调用方能看出"这次没真跑"）',
		/idem\.replayed \? \{ \.\.\.idem\.result, replayed: true \} : idem\.result/.test(groupsSrc));
	check('幂等/陈旧的判定放在纯函数模块（可单测，不依赖文件系统）',
		read('lib/core/groupOps.js').includes('export function planIdempotent')
		&& read('lib/core/groupOps.js').includes('export function staleDenial'));
	/* ★★ 顺序断言（2026-10-31 真机抓到的坑）：幂等一开始被放在"写入前"，于是第二次同 key 重放
	   先被「已有同名群」拦成 409 ⇒ **幂等形同虚设**。它必须在所有校验**之前**。
	   ⚠ 必须同时判 `>= 0`：indexOf 找不到返回 -1，而 `-1 < 任意位置` ⇒ 不加就是假绿 ✗。 */
	const iIdem1 = groupsSrc.indexOf('withIdempotency');
	const iSameName = groupsSrc.indexOf('已有同名群');
	check('★ 建群的幂等必须在「已有同名群」校验之前（否则重放被拦 ⇒ 幂等没用）',
		iIdem1 >= 0 && iSameName >= 0 && iIdem1 < iSameName, `idem@${iIdem1} 同名@${iSameName}`);
	const iIdem2 = groupsSrc.lastIndexOf('withIdempotency');
	const iStale = groupsSrc.indexOf('staleDenial(group');
	check('★ 拉人的幂等必须在陈旧判断之前（重放不该被 stale 挡住）',
		iIdem2 >= 0 && iStale >= 0 && iIdem2 < iStale, `idem@${iIdem2} stale@${iStale}`);
}

/* ── 群成员上限（2026-10-31，P3；对齐 DSB 的「建群初始成员 ≤100」）────────
   原来 20 太紧（拉几个人一起讨论就到顶），而且超限只报一句"成员最多 20 个"
   —— 不告诉用户**现在几个** ⇒ 用户不知道为什么被拒，只能一个个试。 */
{
	const groupsSrc = strip(read('lib/groups.js'));
	const agentsSrc = strip(read('lib/client.agents.js'));
	check('★ 成员上限 = 100（对齐 DSB；原 20 太紧）', /export const MAX_MEMBERS = 100;/.test(groupsSrc));
	check('★ 群数上限**仍是 50**（DSB 没有这条，我们刻意保留 —— 群多了左栏没法看）',
		/const MAX_GROUPS = 50;/.test(groupsSrc));
	check('★ 上限回传给前端（listGroups 带 maxMembers ⇒ 前端不写死数字）',
		/maxMembers: MAX_MEMBERS/.test(groupsSrc));
	check('★ 前端用后端给的上限（不得出现写死的"上限 100"）',
		/groupsView\.data\.maxMembers/.test(agentsSrc) && !/上限 100/.test(agentsSrc));
	check('★ 超限回执带"现在几个 / 上限几个"（否则用户不知道为什么被拒）',
		/成员最多 \$\{MAX_MEMBERS\} 个（这次勾了 \$\{members\.length\} 个）/.test(groupsSrc)
		&& /成员最多 \$\{MAX_MEMBERS\} 个（现在 \$\{before\.size\} 个，还要加 \$\{added\.length\} 个）/.test(groupsSrc)
		&& /成员最多 \$\{MAX_MEMBERS\} 个（现在 \$\{group\.members\?\.length \?\? 0\} 个）/.test(groupsSrc));
	check('建群 / 群设置**两处**都显示上限（定义 1 + 使用 2）',
		(agentsSrc.match(/memberCapTxt/g) || []).length >= 3);
}

/* ── invitation-first（2026-10-31，P1；对齐 DSB 的 invitation-first + auto-accept）──
   补的是"被邀的 Bot 自己能看见、能决定"这一层：
   以前 Bot 是被静默塞进 members 的（谁拉的我、什么时候，都没记录，它自己也不知道）。 */
{
	const groupsSrc = strip(read('lib/groups.js'));
	const toolsSrc = strip(read('lib/tools.js'));
	const indexSrc2 = read('lib/index.js');
	const pageSrc = read('lib/groupPage.js');
	// ⚠ `TOOL_NAMES` 只在上面那个块里 import 过 ⇒ 这里要自己取一份（块作用域，不共享）
	const { TOOL_NAMES } = await import('../lib/tools.js');
	check('★ 待确认条目记下"谁邀请的 / 什么性质"（kind + by）⇒ 邀请可见',
		/kind: 'invite', by: inviteBy/.test(groupsSrc));
	check('★ Bot 能自己回应邀请（respondGroupInvite + 查邀请 / 回应两个工具）',
		/export async function respondGroupInvite/.test(groupsSrc)
		&& /name: 'agent_group_invites'/.test(toolsSrc)
		&& /name: 'agent_group_invite_respond'/.test(toolsSrc));
	check('★★ 开了「加入需确认」的群，Bot **不得**自己放行（否则该开关对 Bot 邀请路径形同虚设）',
		/if \(group\.requireApproval === true\) \{[\s\S]{0,120}throw httpError\(403/.test(groupsSrc));
	check('★ 默认仍是自动接受（两个闸都不开 ⇒ 与以前一致，不强迫多一步）',
		/group\.botAutoAccept === false/.test(groupsSrc));
	check('自动接受时**不唤醒** Bot（加人 ≠ 现在就得说话）',
		/不唤醒/.test(read('lib/groups.js')));
	check('接口与页面接上新开关（botAutoAccept 可读可写 ⇒ 不是死配置）',
		/action === 'invite-respond'/.test(indexSrc2) && /gpBotAutoAccept/.test(pageSrc));
	check('待确认区显示邀请人', /p\.by&&p\.by!=="human"/.test(pageSrc));
	/* ★ 待确认区**工作台也要有一块**（2026-10-31）：以前只在 SSR 群聊页有 ⇒
	   在工作台里群设置半天，却看不见"还有几个人等着进群"（邀请发出去像石沉大海）。 */
	const agentsSrc2 = strip(read('lib/client.agents.js'));
	/* ⚠ 断言要写**完整字面量**（带 `: ''`）：只写 `data-ag-gset-pending` 的话，
	   把它改成 `…pendingx` 仍然匹配 ⇒ 突变验不出红（假绿，刚踩到）。 */
	check('★ 工作台群设置也有待确认区（✓ / ✕ 两个口都要有）',
		/'data-ag-gset-pending': ''/.test(agentsSrc2) && /data-ag-pend-ok/.test(agentsSrc2) && /data-ag-pend-no/.test(agentsSrc2));
	check('★ 待确认区显示"谁邀请的" + "等谁点头"（否则用户不知道该自己点还是等它）',
		/p\.by === 'human'/.test(agentsSrc2) && /等你批准/.test(agentsSrc2) && /等它自己回应/.test(agentsSrc2));
	check('工作台与 SSR 页走**同一个** join-decide 口（两边不各写一份决定逻辑）',
		/join-decide/.test(agentsSrc2));
	/* ★ 光有待确认区不够：**开关也得能在工作台翻** —— 否则只在工作台里操作时，
	   待确认区永远是空的（要产生待确认项得先去 SSR 群聊页翻开关）。 */
	check('★ 工作台群设置能翻两个加入开关（requireApproval / botAutoAccept）',
		/'data-ag-gset-approval': ''/.test(agentsSrc2) && /'data-ag-gset-autoaccept': ''/.test(agentsSrc2));
	check('★ botAutoAccept **默认开**（`!== false` ⇒ undefined 也算开，与以前一致，不强迫多一步）',
		/t\.botAutoAccept !== false/.test(agentsSrc2));
	check('两个开关即时生效（各发一条 approval 请求，不跟着「保存」走）',
		/action: 'approval'[\s\S]{0,90}requireApproval: on/.test(agentsSrc2)
		&& /action: 'approval'[\s\S]{0,90}botAutoAccept: on/.test(agentsSrc2));
}

/* ── 导出 / 导入**带历史**（2026-10-31，P1；对齐 DSB 的 `.botharness/git-history.bundle`）──
   以前包里只有"最后一次的记忆内容" ⇒ 换台机器装回来，演化 / 回滚 / 版本名全没了。 */
{
	const packSrc = strip(read('lib/pack.js'));
	/* ⚠ memory.js **不能用 strip()**：里面有字符串 `'+refs/heads/*:refs/remotes/origin/*'`，
	   `/*` 会被当成块注释开头 ⇒ 把代码整段删掉（刚踩到，断言莫名其妙地红）。
	   下面这些断言都是**代码字面量**，本来也不需要去注释 ⇒ 直接读原文。 */
	const memorySrc2 = read('lib/memory.js');
	check('历史用 git bundle 且带 `--all`（全部分支与 tag 都在）',
		/'bundle', 'create'/.test(memorySrc2) && /'--all'/.test(memorySrc2));
	check('★ 历史**默认不带**（里面还留着删掉过的内容 ⇒ 必须显式勾选）',
		/options\.includeHistory === true/.test(packSrc));
	check('★ 导入**不动工作区**（不做 reset --hard ⇒ 不会覆盖包里的文件）',
		!/'reset', '--hard'/.test(memorySrc2));
	/* ⚠ 必须钉到 **fetch 的 refspec** 上：只查 `refs/remotes/origin` 的话，下面那行
	   `rev-parse refs/remotes/origin/<name>` 也含它 ⇒ 把 fetch 改坏也验不出红（假绿，刚踩到）。 */
	check('⚠ 不能直接 fetch 进当前检出分支（git 会拒）⇒ fetch 的 refspec 必须是 remote-tracking',
		/'fetch', tmp, '\+refs\/heads\/\*:refs\/remotes\/origin\/\*'/.test(memorySrc2) && /'update-ref'/.test(memorySrc2));
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
	check('新工具进了 TOOL_NAMES（否则快照与工具面对不上）',
		TOOL_NAMES3.includes('agent_group_invites') && TOOL_NAMES3.includes('agent_group_invite_respond'));
}

/* ── 右栏记忆页签的**布局与内容**重做（2026-10-31，照截图问题 + mockup 落地）── */
{
	const src = read('lib/client.agents.js');
	const mem = read('lib/memory.js');
	check('★ 页签不换行（5 个页签 ⇒ nowrap + 短标签；否则「分支」掉到第二行贴在成员条旁边）',
		/\.ag3-rtabs \{[^}]*flex-wrap:nowrap/.test(src) && /short: '最近'/.test(src) && /t\.short \|\| t\.label/.test(src));
	check('★ 成员选择条在**内容区内部**（不再夹在页签行与内容区之间）',
		/'ag3-gsel in-body'/.test(src) && /className: 'ag3-rbody'[\s\S]{0,260}'ag3-gsel in-body'/.test(src));
	/* ⚠ 必须钉到 **gitGraphOf 那一处**（`isInitCommit(commit.subject)`）：只写 `isInit: isInitCommit`
	   的话，gitLogOf 里还有一份 ⇒ 把分道图那条改坏也验不出红（假绿，刚踩到）。 */
	check('★ init 提交：服务端打标 + 前端降级（只有 1 个提交时演化图不能全是噪音）',
		/const isInitCommit = /.test(mem) && /isInit: isInitCommit\(commit\.subject\)/.test(mem)
		&& /ag3-crow\.is-init/.test(src) && /rows\.every\(\(c\) => c\.isInit\)/.test(src));
	check('★ AgentMemory 折叠成一行（网关没内容时别占半屏，把演化时间线挤没）',
		/'ag3-am-fold'/.test(src) && /setAmOpenEvo/.test(src) && /hasContent \? amOpenEvo !== false/.test(src));
	check('meta 瘦身（分支/版本徽标各最多 1 个 + 当天只显时刻）',
		/brs2\.slice\(0, 1\)/.test(src) && /vers2\.slice\(0, 1\)/.test(src) && /shortWhen\(c\.date\)/.test(src));
	check('长文案改短（「拿不到候选 —— 网关起来后再点「刷新」。」在窄栏会被截断）',
		!/网关起来后再点/.test(src) && /网关未启动，点「刷新」重试/.test(src));
	/* ★ 2026-10-31 用户报「来自 AgentMemory · 在线 · http://… 太挤」⇒ 标题行只放
	   名称 + 状态徽标 + 刷新；**网关地址单独一行**截断（title 看全文）。 */
	check('★ AgentMemory 头部两行布局（状态不再和网关 URL 挤一行）',
		/'ag3-am-hd'/.test(src) && /'ag3-am-url'/.test(src) && /title: String\(d0\.gateway\)/.test(src));
	/* ★ 2026-10-31 用户要求：Bots 工作台不要宿主外壳的浮动工具栏（vssWbActions，
	   出处 = @vssaros/dsh-workbenches；本 chunk 只在本工作台页面加载 ⇒ 作用域天然限定）。 */
	check('★ 隐藏宿主浮动工具栏（.vssWbActions，用户要求；恢复 = 删这条 CSS）',
		/\.vssWbActions \{ display:none !important; \}/.test(src));
}

console.log(`\n[agents] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
