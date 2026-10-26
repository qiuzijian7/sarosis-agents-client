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

console.log(`\n[agents] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
