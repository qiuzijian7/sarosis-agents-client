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

console.log(`\n[agents] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
