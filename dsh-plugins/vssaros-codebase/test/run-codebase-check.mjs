// @vssaros/dsh-codebase — 包内自检（工作台模板 S15）。
//   跑法：node dsh-plugins/vssaros-codebase/test/run-codebase-check.mjs
//   两类断言：
//     ① 静态契约（清单 / patch / 入口 / 组件 / 共享层 / 容器查询 / 锚点 / 零 iframe）
//     ② 纯逻辑：扩展名→语言映射、工具面常量（读写分离 / ADR 只读动作）、端口审计口径
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageOfFile } from '../lib/parser/extract.js';
import { ADR_READ_ACTIONS, PORT_AUDIT, TOOL_NAMES, WRITE_TOOLS, portAuditOf } from '../lib/index.js';

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
check('包名', pkg.name === '@vssaros/dsh-codebase', pkg.name);
check('清单声明工作台 title', !!pkg.vssaros?.workbench?.title, pkg.vssaros?.workbench?.title);
check('注入自有宿主 @vssaros/dsh-workbenches', (pkg.dsh?.client?.inject || []).includes('@vssaros/dsh-workbenches'));
const patchField = pkg.dsh?.bundle?.patch;
check('清单带 dsh.bundle.patch', /cordis\.patch\.yml/.test(String(Array.isArray(patchField) ? patchField.join(',') : patchField)), JSON.stringify(patchField));
check('files 里含 cordis.patch.yml', (pkg.files || []).includes('cordis.patch.yml'));
const patch = read('cordis.patch.yml');
check('patch 有 insert 段', /-\s*insert:/.test(patch));
check('patch 的 name 与包名一致', patch.includes(`'@vssaros/dsh-codebase'`));

console.log('── 入口与组件 ──');
check('入口不写 chunk: 字段', !/^\s*chunk\s*:/m.test(strip(read('lib/client.js'))));
const component = listLib().map((p) => ({ p, text: strip(fs.readFileSync(p, 'utf8')) }))
	.filter((x) => /desktopWorkbenches\.register\(/.test(x.text))
	.sort((a, b) => (b.text.match(/\bwb-[a-z-]+/g) || []).length - (a.text.match(/\bwb-[a-z-]+/g) || []).length)[0];
check('找到工作台组件（含 register）', !!component, component?.p.split(/[\\/]/).pop());
const src = component?.text || '';
check('描述符带 repository（vssaros:<模块>）', /repository:\s*'vssaros:codebase'/.test(src));
check('根节点有 data-vssaros-surface="workbench"', /data-vssaros-surface['"]?\s*:\s*['"]workbench/.test(src));
check('工具条锚点恰好 1 个', (src.match(/data-dsh-workbench-toolbar/g) || []).length === 1);
const wbClasses = new Set((src.match(/'wb(?:-[a-z0-9]+)*'/g) || []).map((s) => s.slice(1, -1)));
check('用到 ≥10 个 wb-* 原语', wbClasses.size >= 10, wbClasses.size + ' 个');
const bare = src.split('\n').filter((l) => !l.includes('var(--') && (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(rgba?|hsla?)\(/.test(l)));
check('无裸色值', bare.length === 0, bare.slice(0, 2).join(' | '));
check('有 @container（窄栏重排）', /@container/.test(src));
check('≥3 个 data-* 锚点', new Set(src.match(/data-[a-z0-9-]{3,30}/g) || []).size >= 3);
check('零 iframe', !/<iframe|createElement\(['"]iframe/.test(src));

console.log('── 扩展名 → 语言 ──');
check('.ts → typescript', languageOfFile('src/a.ts') === 'typescript', languageOfFile('src/a.ts'));
check('.tsx → tsx', languageOfFile('src/A.tsx') === 'tsx', languageOfFile('src/A.tsx'));
check('.js → javascript', languageOfFile('a.js') === 'javascript', languageOfFile('a.js'));
check('大小写不敏感', languageOfFile('A.TS') === 'typescript', languageOfFile('A.TS'));
check('无扩展名 ⇒ undefined（不瞎猜）', languageOfFile('Makefile') === undefined, String(languageOfFile('Makefile')));
check('未知扩展名 ⇒ undefined', languageOfFile('a.zzz') === undefined, String(languageOfFile('a.zzz')));

console.log('── 工具面常量 ──');
check('TOOL_NAMES 非空且唯一', TOOL_NAMES.length > 0 && new Set(TOOL_NAMES).size === TOOL_NAMES.length, TOOL_NAMES.length + ' 个');
check('WRITE_TOOLS 都是已登记工具（防拼错）', WRITE_TOOLS.every((t) => TOOL_NAMES.includes(t)), WRITE_TOOLS.join(','));
check('读写分离：写工具不混进只读集合', WRITE_TOOLS.length > 0 && TOOL_NAMES.length > WRITE_TOOLS.length, `${WRITE_TOOLS.length}/${TOOL_NAMES.length}`);
check('ADR 只读动作是 list/get', ADR_READ_ACTIONS.join(',') === 'list,get', ADR_READ_ACTIONS.join(','));

console.log('── 端口审计 ──');
{
	check('PORT_AUDIT 非空', PORT_AUDIT.length > 0, PORT_AUDIT.length + ' 条');
	const none = portAuditOf([]);
	check('未注册任何工具 ⇒ missing 覆盖所有目标名', none.missing.length > 0 && none.extra.length === 0, JSON.stringify({ missing: none.missing.length, extra: none.extra.length }));
	const all = portAuditOf(PORT_AUDIT.map((e) => e.to ?? e.replacedBy).filter(Boolean));
	check('全部注册 ⇒ missing 为空', all.missing.length === 0, JSON.stringify(all.missing));
	check('多注册的工具进 extra（不静默）', portAuditOf(['codebase_overview', 'not_a_tool']).extra.includes('not_a_tool'));
	check('sourceTools 等于 PORT_AUDIT 条数', none.sourceTools === PORT_AUDIT.length, String(none.sourceTools));
}

console.log(`\n[codebase] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
