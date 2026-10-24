// @vssaros/dsh-workflow — 包内自检（工作台模板 S15）。
//   跑法：node dsh-plugins/vssaros-workflow/test/run-workflow-check.mjs
//   两类断言：
//     ① 静态契约（清单 / patch / 入口 / 组件 / 共享层 / 容器查询 / 锚点 / 零 iframe）
//     ② 纯逻辑：dag.js（邻接表 / 后继 / AskUser 端口路由 / Kahn 拓扑排序 + 环检测）
//               engineCore.js（变量插值：`{{key}}` / `{{node.output}}`）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askUserNextNodes, buildAdjacency, nextNodes, topoOrder } from '../lib/core/dag.js';
import { interpolate } from '../lib/core/engineCore.js';

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
check('包名', pkg.name === '@vssaros/dsh-workflow', pkg.name);
check('清单声明工作台 title', !!pkg.vssaros?.workbench?.title, pkg.vssaros?.workbench?.title);
check('注入自有宿主 @vssaros/dsh-workbenches', (pkg.dsh?.client?.inject || []).includes('@vssaros/dsh-workbenches'));
const patchField = pkg.dsh?.bundle?.patch;
check('清单带 dsh.bundle.patch', /cordis\.patch\.yml/.test(String(Array.isArray(patchField) ? patchField.join(',') : patchField)), JSON.stringify(patchField));
check('files 里含 cordis.patch.yml', (pkg.files || []).includes('cordis.patch.yml'));
const patch = read('cordis.patch.yml');
check('patch 有 insert 段', /-\s*insert:/.test(patch));
check('patch 的 name 与包名一致', patch.includes(`'@vssaros/dsh-workflow'`));

console.log('── 入口与组件 ──');
check('入口不写 chunk: 字段', !/^\s*chunk\s*:/m.test(strip(read('lib/client.js'))));
const component = listLib().map((p) => ({ p, text: strip(fs.readFileSync(p, 'utf8')) }))
	.filter((x) => /desktopWorkbenches\.register\(/.test(x.text))
	.sort((a, b) => (b.text.match(/\bwb-[a-z-]+/g) || []).length - (a.text.match(/\bwb-[a-z-]+/g) || []).length)[0];
check('找到工作台组件（含 register）', !!component, component?.p.split(/[\\/]/).pop());
const src = component?.text || '';
check('描述符带 repository（vssaros:<模块>）', /repository:\s*'vssaros:workflow'/.test(src));
check('根节点有 data-vssaros-surface="workbench"', /data-vssaros-surface['"]?\s*:\s*['"]workbench/.test(src));
check('工具条锚点恰好 1 个', (src.match(/data-dsh-workbench-toolbar/g) || []).length === 1);
const wbClasses = new Set((src.match(/'wb(?:-[a-z0-9]+)*'/g) || []).map((s) => s.slice(1, -1)));
check('用到 ≥10 个 wb-* 原语', wbClasses.size >= 10, wbClasses.size + ' 个');
const bare = src.split('\n').filter((l) => !l.includes('var(--') && (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(rgba?|hsla?)\(/.test(l)));
check('无裸色值', bare.length === 0, bare.slice(0, 2).join(' | '));
check('有 @container（窄栏重排）', /@container/.test(src));
check('≥3 个 data-* 锚点', new Set(src.match(/data-[a-z0-9-]{3,30}/g) || []).size >= 3);
check('零 iframe', !/<iframe|createElement\(['"]iframe/.test(src));

console.log('── DAG：邻接表与后继 ──');
{
	const adj = buildAdjacency([
		{ from: 'a', to: 'b' },
		{ from: 'a', to: 'c', fromPort: 'option-1' },
		{ from: '', to: 'x' },
		{ from: 'y' },
	]);
	check('建邻接表（跳过缺端的连接）', adj.get('a')?.length === 2 && !adj.has(''), JSON.stringify([...adj.keys()]));
	check('nextNodes 返回全部后继', nextNodes('a', adj).join(',') === 'b,c', nextNodes('a', adj).join(','));
	check('未知节点 ⇒ 空后继', nextNodes('zzz', adj).length === 0);
	check('AskUser 只走选中端口', askUserNextNodes('a', adj, [1]).join(',') === 'c', askUserNextNodes('a', adj, [1]).join(','));
	check('AskUser 端口没匹配 ⇒ 回退全量（旧图兼容）', askUserNextNodes('a', adj, [9]).join(',') === 'b,c', askUserNextNodes('a', adj, [9]).join(','));
}

console.log('── DAG：拓扑排序与环检测 ──');
{
	const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
	const order = topoOrder(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
	check('线性图 ⇒ 顺序正确', order.join(',') === 'a,b,c', order.join(','));
	const diamond = topoOrder([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
		[{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }]);
	check('菱形图 ⇒ 起点在前、终点在后', diamond[0] === 'a' && diamond.at(-1) === 'd' && diamond.length === 4, diamond.join(','));
	check('无连接 ⇒ 全零入度、原序返回', topoOrder([{ id: 'x' }, { id: 'y' }], []).join(',') === 'x,y');
	let cyc = '';
	try { topoOrder([{ id: 'a' }, { id: 'b' }], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]); }
	catch (e) { cyc = String(e?.message || e); }
	check('有环 ⇒ 抛错且说明「有环」+ 卡住的节点', /有环/.test(cyc) && /a/.test(cyc), cyc);
}

console.log('── 变量插值 ──');
{
	check('{{key}} 从上下文取', interpolate('hi {{name}}', {}, { name: '张三' }) === 'hi 张三');
	check('{{node.output}} 从节点状态取', interpolate('{{n1.output}}', { n1: { output: 'OK' } }, {}) === 'OK');
	check('取不到 ⇒ 原样保留（不吞占位符）', interpolate('{{missing}}', {}, {}) === '{{missing}}');
	check('非字符串值不硬塞', interpolate('{{x}}', {}, { x: 42 }) === '{{x}}');
	check('空输入安全', interpolate('', {}, {}) === '');
}

console.log(`\n[workflow] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
