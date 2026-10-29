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
			/await applyDesired\(okPresetIds, true, eagerKeys\)/.test(idx));
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
	for (const t of ['mentions.test.mjs', 'dispatch-budget.test.mjs', 'member-policy.test.mjs', 'owner-policy.test.mjs', 'relay-policy.test.mjs', 'group-session.test.mjs', 'bindings.test.mjs', 'feishu-adapter.test.mjs', 'feishu-inbound.test.mjs', 'channel-policy.test.mjs', 'pairing.test.mjs', 'dead-letters.test.mjs', 'telegram-adapter.test.mjs', 'discord-adapter.test.mjs', 'wecom-adapter.test.mjs', 'binding-media.test.mjs', 'outbound-media.test.mjs', 'feishu-gateway.test.mjs', 'memory-dir.test.mjs', 'memory-init.test.mjs', 'agentmemory-candidates.test.mjs', 'agentmemory-sync.test.mjs', 'atomic-write.test.mjs', 'im-credentials.test.mjs', 'inbound-state.test.mjs', 'im-session-map.test.mjs', 'feishu-raw-ws.test.mjs', 'im-inbound-lock.test.mjs', 'host-self-watch.test.mjs']) {
		const r = spawnSync(process.execPath, [path.join(HERE, t)], { encoding: 'utf8' });
		const last = String(r.stdout || '').trim().split('\n').filter(Boolean).pop()
			|| String(r.stderr || '').slice(0, 120);
		check(`包内单测 ${t} 通过`, r.status === 0, last);
	}
}

console.log(`\n[agents] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
