// @vssaros/dsh-memory — 包内自检（工作台模板 S15）。
//   跑法：node dsh-plugins/vssaros-memory/test/run-memory-check.mjs
//   两类断言：
//     ① 静态契约（清单 / patch / 入口 / 组件 / 共享层 / 容器查询 / 锚点 / 零 iframe）
//     ② 纯逻辑：详情页常量（页签 / 分页）+ renderDetailPage 冒烟（10 个页签都在、空数据不崩）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { DETAIL_PAGE_SIZE, DETAIL_ROUTE, DETAIL_VIEWS, renderDetailPage } from '../lib/detail.js';

// 详情页渲染会用到数据根（委托 @vssaros/dsh-foundation）——包内自检不装宿主，
// 用 foundationRef 提供的**探针后门**（`globalThis.__VSSAROS_FOUNDATION__`）塞一个最小实现。
globalThis.__VSSAROS_FOUNDATION__ = {
	dataRootOf: () => path.join(os.tmpdir(), 'vssaros-memory-check'),
	// 详情页 HTML 也要它转义（foundation 里那份是唯一真源；这里给最小等价实现）
	escapeHtml: (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
};

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
check('包名', pkg.name === '@vssaros/dsh-memory', pkg.name);
check('清单声明工作台 title', !!pkg.vssaros?.workbench?.title, pkg.vssaros?.workbench?.title);
check('注入自有宿主 @vssaros/dsh-workbenches', (pkg.dsh?.client?.inject || []).includes('@vssaros/dsh-workbenches'));
const patchField = pkg.dsh?.bundle?.patch;
check('清单带 dsh.bundle.patch', /cordis\.patch\.yml/.test(String(Array.isArray(patchField) ? patchField.join(',') : patchField)), JSON.stringify(patchField));
check('files 里含 cordis.patch.yml', (pkg.files || []).includes('cordis.patch.yml'));
const patch = read('cordis.patch.yml');
check('patch 有 insert 段', /-\s*insert:/.test(patch));
check('patch 的 name 与包名一致', patch.includes(`'@vssaros/dsh-memory'`));

console.log('── 入口与组件 ──');
check('入口不写 chunk: 字段', !/^\s*chunk\s*:/m.test(strip(read('lib/client.js'))));
const component = listLib().map((p) => ({ p, text: strip(fs.readFileSync(p, 'utf8')) }))
	.filter((x) => /desktopWorkbenches\.register\(/.test(x.text))
	.sort((a, b) => (b.text.match(/\bwb-[a-z-]+/g) || []).length - (a.text.match(/\bwb-[a-z-]+/g) || []).length)[0];
check('找到工作台组件（含 register）', !!component, component?.p.split(/[\\/]/).pop());
const src = component?.text || '';
check('描述符带 repository（vssaros:<模块>）', /repository:\s*'vssaros:memory'/.test(src));
check('根节点有 data-vssaros-surface="workbench"', /data-vssaros-surface['"]?\s*:\s*['"]workbench/.test(src));
check('工具条锚点恰好 1 个', (src.match(/data-dsh-workbench-toolbar/g) || []).length === 1);
const wbClasses = new Set((src.match(/'wb(?:-[a-z0-9]+)*'/g) || []).map((s) => s.slice(1, -1)));
check('用到 ≥10 个 wb-* 原语', wbClasses.size >= 10, wbClasses.size + ' 个');
const bare = src.split('\n').filter((l) => !l.includes('var(--') && (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(rgba?|hsla?)\(/.test(l)));
check('无裸色值', bare.length === 0, bare.slice(0, 2).join(' | '));
check('有 @container（窄栏重排）', /@container/.test(src));
check('≥3 个 data-* 锚点', new Set(src.match(/data-[a-z0-9-]{3,30}/g) || []).size >= 3);
check('零 iframe', !/<iframe|createElement\(['"]iframe/.test(src));

console.log('── 详情页常量 ──');
check('详情路由是 /x/memory/detail', DETAIL_ROUTE === '/x/memory/detail', DETAIL_ROUTE);
check('分页 50 条', DETAIL_PAGE_SIZE === 50, String(DETAIL_PAGE_SIZE));
check('页签 10 个', DETAIL_VIEWS.length === 10, String(DETAIL_VIEWS.length));
check('页签 id 唯一', new Set(DETAIL_VIEWS.map((v) => v.id)).size === DETAIL_VIEWS.length);
check('前三个页签是 记忆/会话/槽位', DETAIL_VIEWS.slice(0, 3).map((v) => v.id).join(',') === 'memories,sessions,slots', DETAIL_VIEWS.slice(0, 3).map((v) => v.id).join(','));
check('每个页签都有 label（emoji + 中文）', DETAIL_VIEWS.every((v) => typeof v.label === 'string' && v.label.length > 0));

console.log('── renderDetailPage 冒烟（空数据不崩）──');
{
	const model = {
		params: new URLSearchParams('view=memories'),
		agentId: 'main',
		items: [], tierCounts: { working: 0, episodic: 0, semantic: 0, procedural: 0 },
		typeCounts: {}, extStats: {}, agents: [], slotNames: [], sessions: [], summaries: [],
	};
	let out = null;
	let err = '';
	try { out = renderDetailPage(model); } catch (e) { err = String(e?.message || e); }
	check('空数据渲染不抛错', !err, err);
	const body = String(out?.body || out || '');
	check('渲染结果是一段 HTML', body.length > 200 && body.includes('<'), String(body.length) + ' 字符');
	check('页面带 data-vssaros-page 锚点', /data-vssaros-page/.test(body));
	check('10 个页签的标签都在页面上', DETAIL_VIEWS.every((v) => body.includes(v.label) || body.includes(v.id)));
}

console.log(`\n[memory] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
