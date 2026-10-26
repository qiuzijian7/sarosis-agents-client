#!/usr/bin/env node
// 生成一个「注册式工作台」骨架：清单 + 服务端入口 + 客户端入口 + 子块面板。
//
// 用法：
//   node scaffold_workbench.mjs <module> [--dir <输出目录>] [--title <标题>]
//        [--icon codicon:list-tree] [--desc <一句话>] [--order 41] [--force]
//
// 例：
//   node scaffold_workbench.mjs tasks --dir dsh-plugins/vssaros-tasks --title "任务台" --icon codicon:checklist
//
// 生成后必做（脚本会打印提醒）：
//   1) 把包加进 check-workbench-style.mjs 的 UNIFIED 白名单
//   2) 在 chat-surface 的 DEFAULT_ITEMS / 启动器登记
//   3) 跑 check-chat-surface-chunks / check-workbench-catalog / check-workbench-style
//   4) 写探针（本脚本不生成探针：探针依赖你本仓的 sandbox lib）

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const moduleName = (argv[0] || '').trim();
if (!moduleName || moduleName.startsWith('--')) {
	console.error('用法: node scaffold_workbench.mjs <module> [--dir <输出目录>] [--title 标题] [--icon codicon:xxx] [--desc 描述] [--order 41] [--force]');
	process.exit(1);
}
if (!/^[a-z][a-z0-9-]*$/.test(moduleName)) {
	console.error(`module 只能是小写字母开头、含 a-z0-9-：${moduleName}`);
	process.exit(1);
}
const flag = (name, fallback) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const title = flag('title', moduleName);
const desc = flag('desc', '一句话说清它替用户做什么');
const icon = flag('icon', 'codicon:list-tree');
const order = Number(flag('order', '41'));
const outDir = flag('dir', `dsh-plugins/vssaros-${moduleName}`);
const force = argv.includes('--force');
const pkgName = `@vssaros/dsh-${moduleName}`;

const files = {};

files['package.json'] = JSON.stringify({
	name: pkgName,
	version: '0.1.0',
	private: true,
	type: 'module',
	description: desc,
	main: './lib/index.js',
	exports: { '.': './lib/index.js', './client': './lib/client.js' },
	// `test/` 也进 files：包内自检要能跟着包发出去（否则装出去的人没得跑）
	files: ['cordis.patch.yml', 'lib/', 'test/'],
	scripts: { check: `node ./test/run-${moduleName}-check.mjs` },
	// ⚠ `dsh.bundle.patch` 是**激活入口**：没有它插件不会进运行时（且宿主不报错，纯静默）
	dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['@vssaros/dsh-workbenches'] } },
	vssaros: {
		workbench: {
			title,
			description: desc,
			icon,
			repository: `vssaros:${moduleName}`,
			customFrame: true,
		},
		activityBar: { icon, order },
	},
}, null, 2) + '\n';

// ⚠ bundle patch = **激活入口**。缺了它：profile 里 deps/bundles 都登记、宿主也不报错，
//   但注册表里就是没有这个工作台（纯静默）—— 2026-10-24 真机就是这么浪费了两轮的。
files['cordis.patch.yml'] = [
	`# @vssaros/dsh-${moduleName} bundle patch：把本插件 insert 进运行时（缺了 = 静默不激活）。`,
	'- insert:',
	`    - id: vssaros-${moduleName}`,
	`      name: '${pkgName}'`,
	'      config: {}',
	'',
].join('\n');

files[join('lib', 'index.js')] = [
	`// @vssaros/dsh-${moduleName} — 服务端：一条页面路由，SSR 与工作台共用同一份数据。`,
	'',
	'/**',
	' * 取数：**只装配一次**。SSR 页与工作台（`?format=json`）都调它。',
	' * 分开写两份 ⇒ 口径必然分叉（「页面说 32、工作台说 30」）。',
	' */',
	'export function buildPayload({ items = [] } = {}) {',
	'\treturn {',
	'\t\tok: true,',
	'\t\titems,',
	'\t\tcount: items.length,',
	'\t};',
	'}',
	'',
	'export const name = `dsh-${moduleName}`;',
	'',
	'export function apply(ctx, config = {}) {',
	'\tctx.server.get(\'/x/' + moduleName + '/\', async (req, res) => {',
	'\t\tconst url = new URL(req.url, \'http://x\');',
	'\t\tconst payload = buildPayload({ items: (config.items || []) });',
	'\t\t// ★ 工作台吃的就是这一个分支（与 SSR 共用同一次取数）',
	'\t\tif (url.searchParams.get(\'format\') === \'json\') {',
	'\t\t\tres.writeHead(200, { \'content-type\': \'application/json; charset=utf-8\', \'cache-control\': \'no-store\' });',
	'\t\t\tres.end(JSON.stringify(payload));',
	'\t\t\treturn;',
	'\t\t}',
	'\t\tres.writeHead(200, { \'content-type\': \'text/html; charset=utf-8\' });',
	'\t\tres.end(renderShell(payload));',
	'\t});',
	'}',
	'',
	'/** 最小 SSR 壳（注册式工作台用不到它，但直开路由时要有东西）。 */',
	'function renderShell(payload) {',
	'\treturn \'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + title + '</title></head>\'',
	'\t\t+ \'<body><pre>\' + JSON.stringify(payload, null, 2).replace(/</g, \'&lt;\') + \'</pre></body></html>\';',
	'}',
	'',
].join('\n');

files[join('lib', 'client.js')] = [
	`// @vssaros/dsh-${moduleName} — 客户端入口（只装载子块；注册在子块的 install 里）。`,
	'//',
	'// ⚠ 四条真机踩过的规矩：',
	'//   ① 入口**不要**写 `chunk:`（会让整个 web boot 失败）；',
	'//   ② 入口 `inject` 写宿主服务名；子块 `install(ctx)` 里再 `ctx.inject` 兜底；',
	'//   ③ 描述符**必须带 `repository`**（`vssaros:<模块>` 或 https://github.com/<owner>/<repo>），',
	'//      缺了宿主 `normalize()` 判 `Invalid workbench repository` ⇒ **静默不进注册表**；',
	'//   ④ 改过子块要再动一次本入口 + 升版本（chunk 守卫按 mtime 判）。',
	'window.__ModuleLoader__.load({',
	`\tid: '${pkgName}',`,
	'\tfactory: (require) => {',
	'\t\tvar module = { exports: {} };',
	'\t\tvar exports = module.exports;',
	`\t\tglobalThis.__vssarosWb_${moduleName.replace(/-/g, '_')} = { loaded: false, registered: false };`,
	'',
	'\t\tfunction apply(ctx) {',
	'\t\t\ttry {',
	'\t\t\t\tif (typeof require.async !== \'function\') { throw new Error(\'装载器没有 require.async（老运行时）\'); }',
	`\t\t\t\trequire.async(\'./client.${moduleName}.js\')`,
	'\t\t\t\t\t.then(part => {',
	'\t\t\t\t\t\tif (!part || typeof part.install !== \'function\') { throw new Error(\'子块没有导出 install\'); }',
	'\t\t\t\t\t\tpart.install(ctx);',
	`\t\t\t\t\t\tglobalThis.__vssarosWb_${moduleName.replace(/-/g, '_')} = { loaded: true, registered: true };`,
	'\t\t\t\t\t})',
	'\t\t\t\t\t.catch(e => {',
	'\t\t\t\t\t\tconst why = String((e && e.message) || e);',
	`\t\t\t\t\t\tglobalThis.__vssarosWb_${moduleName.replace(/-/g, '_')} = { loaded: true, registered: false, failed: why };`,
	`\t\t\t\t\t\tconsole.warn(\'[${moduleName}] 装载失败：\' + why);`,
	'\t\t\t\t\t});',
	'\t\t\t} catch (e) { console.warn(\'[' + moduleName + '] 装载失败：\' + String((e && e.message) || e)); }',
	'\t\t\treturn undefined;',
	'\t\t}',
	'',
	'\t\texports.apply = apply;',
	'\t\texports.inject = [\'desktopWorkbenches\'];',
	'\t\treturn module.exports;',
	'\t},',
	'});',
	'',
].join('\n');

files[join('lib', `client.${moduleName}.js`)] = [
	`// @vssaros/dsh-${moduleName} — 工作台面板（React）。`,
	'//',
	'// 纪律：',
	'//   · 颜色只走 `--dsw-alias-*`（写成 var(--x, 兜底)），尺寸只走 `--wb-*`；',
	'//   · 用共享层原语（wb-toolbar / wb-split / wb-pane / wb-list / wb-row / wb-badge / wb-btn / wb-empty / wb-diag）；',
	'//   · 机器锚点用 `data-*`（类名属视觉层，UI 统一时会被换掉 ⇒ 探针会「数出 0」）；',
	'//   · 零 iframe：这里是宿主里渲染的 React，不是嵌页面；',
	'//   · 空态要写「为什么空 + 下一步」，不能只写「暂无数据」。',
	'window.__ModuleLoader__.load({',
	`\tid: '${pkgName}',`,
	`\tchunk: 'client.${moduleName}.js',`,
	'\tfactory: (require) => {',
	'\t\tconst react = require(\'react\');',
	'\t\tconst h = react.createElement;',
	'\t\tconst { useState, useEffect } = react;',
	'',
	`\t\tconst STYLE_ID = 'vssaros-${moduleName}-layout';`,
	'\t\t// 布局覆盖 + **容器查询**（必填：工作台会被塞进 320–420px 的 sideview / 右栏，@media 判不出来）',
	'\t\tconst CSS = `',
	`\t\t.wb-${moduleName} { container-type: inline-size; min-height: 0; }`,
	'\t\t@container (max-width: 860px) {',
	'\t\t\t.wb-split { grid-template-columns: 1fr; grid-auto-rows: minmax(0, 1fr); }',
	'\t\t}',
	'\t\t@container (max-width: 560px) {',
	'\t\t\t.wb-toolbar { flex-wrap: wrap; row-gap: var(--wb-s1); }',
	'\t\t}',
	'\t\t`;',
	'\t\tfunction ensureStyle() {',
	'\t\t\tif (document.getElementById(STYLE_ID)) { return; }',
	'\t\t\tconst el = document.createElement(\'style\');',
	'\t\t\tel.id = STYLE_ID;',
	'\t\t\tel.textContent = CSS;',
	'\t\t\tdocument.head.appendChild(el);',
	'\t\t}',
	'',
	'\t\tfunction Panel() {',
	'\t\t\tconst [state, setState] = useState({ status: \'loading\', items: [], error: \'\' });',
	'\t\t\tconst [picked, setPicked] = useState(\'\');',
	'',
	'\t\t\tuseEffect(() => {',
	'\t\t\t\tensureStyle();',
	`\t\t\t\tfetch(\'/x/${moduleName}/?format=json\', { cache: \'no-store\' })`,
	'\t\t\t\t\t.then(r => r.json())',
	'\t\t\t\t\t.then(body => setState({ status: \'ready\', items: body.items || [], error: \'\' }))',
	'\t\t\t\t\t.catch(e => setState({ status: \'error\', items: [], error: String((e && e.message) || e) }));',
	'\t\t\t}, []);',
	'',
	'\t\t\tconst items = state.items;',
	'\t\t\treturn h(\'div\', { className: \'wb wb-' + moduleName + '\', \'data-vssaros-surface\': \'workbench\', \'data-vssaros-page\': \'' + moduleName + '\' },',
	'\t\t\t\th(\'div\', { className: \'wb-toolbar\', \'data-dsh-workbench-toolbar\': \'\' },',
	'\t\t\t\t\th(\'span\', { className: \'wb-title\' }, \'' + title + '\'),',
	'\t\t\t\t\th(\'span\', { className: \'wb-spacer\' }),',
	'\t\t\t\t\th(\'span\', { className: \'wb-badge\', \'data-vssaros-' + moduleName + '-count\': String(items.length) }, items.length + \' 项\'),',
	'\t\t\t\t),',
	'\t\t\t\th(\'div\', { className: \'wb-split\' },',
	'\t\t\t\t\th(\'div\', { className: \'wb-pane wb-pane-left\' },',
	'\t\t\t\t\t\titems.length',
	'\t\t\t\t\t\t\t? h(\'div\', { className: \'wb-list\' }, items.map((it, i) => h(\'div\', {',
	'\t\t\t\t\t\t\t\tkey: String(it.id || i),',
	'\t\t\t\t\t\t\t\tclassName: \'wb-row\' + (picked === String(it.id || i) ? \' is-current\' : \'\'),',
	'\t\t\t\t\t\t\t\t\'data-vssaros-' + moduleName + '-row\': String(it.id || i),',
	'\t\t\t\t\t\t\t\tonClick: () => setPicked(String(it.id || i)),',
	'\t\t\t\t\t\t\t}, h(\'span\', { className: \'wb-row-name\' }, String(it.title || it.name || it.id || (\'条目 \' + (i + 1)))))))',
	'\t\t\t\t\t\t\t: h(\'div\', { className: \'wb-empty\' },',
	'\t\t\t\t\t\t\t\th(\'strong\', null, state.status === \'error\' ? \'读不到数据\' : \'还没有条目\'),',
	'\t\t\t\t\t\t\t\th(\'span\', null, state.status === \'error\' ? (state.error || \'请重试\') : \'在上方工具栏新建一条，或检查数据目录\'),',
	'\t\t\t\t\t\t\t),',
	'\t\t\t\t\t),',
	'\t\t\t\t\th(\'div\', { className: \'wb-pane wb-pane-right\' },',
	'\t\t\t\t\t\th(\'div\', { className: \'wb-pane-hd\' }, h(\'span\', { className: \'wb-pane-title\' }, picked ? \'详情\' : \'未选中\')),',
	'\t\t\t\t\t\th(\'div\', { className: \'wb-scroll\', \'data-vssaros-' + moduleName + '-detail\': picked || \'\' },',
	'\t\t\t\t\t\t\tpicked ? h(\'pre\', { className: \'wb-pre\' }, JSON.stringify(items.find(x => String(x.id) === picked) || {}, null, 2))',
	'\t\t\t\t\t\t\t\t: h(\'div\', { className: \'wb-empty\' }, h(\'strong\', null, \'选左边一条\'), h(\'span\', null, \'详情会显示在这里\')),',
	'\t\t\t\t\t\t),',
	'\t\t\t\t\t),',
	'\t\t\t\t),',
	'\t\t\t);',
	'\t\t}',
	'',
	'\t\t// 描述符必须在**组件文件**里（style 守卫用「含 desktopWorkbenches.register 的文件」当组件）',
	'\t\tconst DESCRIPTOR = {',
	`\t\t\trepository: 'vssaros:${moduleName}',   // ⚠ 必填：缺了宿主判 Invalid workbench repository`,
	`\t\t\tid: 'vssaros/${moduleName}',`,
	`\t\t\ttitle: '${title}',`,
	`\t\t\tdescription: '${desc}',`,
	`\t\t\ticon: '${icon}',`,
	`\t\t\troute: '/x/${moduleName}/',`,
	`\t\t\torder: ${order},`,
	'\t\t\tcustomFrame: true,',
	'\t\t};',
	'',
	'\t\tfunction install(ctx) {',
	'\t\t\tif (ctx.desktopWorkbenches) {',
	`\t\t\t\tctx.effect(() => ctx.desktopWorkbenches.register(DESCRIPTOR, Panel), 'vssaros-${moduleName}: workbench');`,
	'\t\t\t\treturn undefined;',
	'\t\t\t}',
	'\t\t\tctx.inject([\'desktopWorkbenches\'], (c) => {',
	`\t\t\t\tc.effect(() => c.desktopWorkbenches.register(DESCRIPTOR, Panel), 'vssaros-${moduleName}: workbench');`,
	'\t\t\t});',
	'\t\t\treturn undefined;',
	'\t\t}',
	'',
	'\t\treturn { Panel, install };',
	'\t},',
	'});',
	'',
].join('\n');

files[join('README.md')] = [
	`# ${title}（\`${pkgName}\`）`,
	'',
	desc,
	'',
	'## 形态',
	'',
	'- 注册式工作台：左列表 / 右详情，颜色与尺寸全走共享层（`wb-*` + `--dsw-alias-*`）。',
	'- 取数：`GET /x/' + moduleName + '/?format=json`（与 SSR 共用同一次装配）。',
	'',
	'## 本地验证',
	'',
	'```bash',
	'node dsh-plugins/check-workbench-style.mjs      # 需把本包加入 UNIFIED 白名单',
	'node dsh-plugins/check-workbench-catalog.mjs',
	'node dsh-plugins/check-chat-surface-chunks.mjs',
	'```',
	'',
	'> 骨架由 `dsh-workbench-authoring` 技能生成；探针需按本仓 `poc/dsh-p0/scripts/lib.mjs` 自己写（见技能 references/verification.md）。',
	'',
].join('\n');

// 包内自检（S15）：没有它，工作台一装出去就没有可跑的验收；守卫也会报红。
files[join('test', `run-${moduleName}-check.mjs`)] = [
	`// ${pkgName} — 包内自检（工作台模板 S15）。`,
	`//   跑法：node dsh-plugins/vssaros-${moduleName}/test/run-${moduleName}-check.mjs`,
	"import fs from 'node:fs';",
	"import path from 'node:path';",
	"import { fileURLToPath } from 'node:url';",
	'',
	'const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), \'..\');',
	'const read = (rel) => fs.readFileSync(path.join(ROOT, rel), \'utf8\');',
	'const walk = (dir, out = []) => {',
	'\tfor (const name of fs.readdirSync(dir)) {',
	'\t\tconst p = path.join(dir, name);',
	'\t\tif (fs.statSync(p).isDirectory()) { walk(p, out); } else if (name.endsWith(\'.js\')) { out.push(p); }',
	'\t}',
	'\treturn out;',
	'};',
	'const strip = (t) => t.replace(/\\/\\*[\\s\\S]*?\\*\\//g, \'\').replace(/^\\s*\\/\\/.*$/gm, \'\');',
	'',
	'let pass = 0;',
	'let fail = 0;',
	'const check = (name, ok, detail) => {',
	'\tif (ok) { pass += 1; console.log(\'  ok   \' + name); }',
	'\telse { fail += 1; console.log(\'  FAIL \' + name + (detail ? \'  — \' + String(detail).slice(0, 160) : \'\')); }',
	'};',
	'',
	'const pkg = JSON.parse(read(\'package.json\'));',
	`check('包名', pkg.name === '${pkgName}', pkg.name);`,
	`check('清单声明工作台 title', pkg.vssaros?.workbench?.title === '${title}', pkg.vssaros?.workbench?.title);`,
	`check('注入自有宿主 @vssaros/dsh-workbenches', (pkg.dsh?.client?.inject || []).includes('@vssaros/dsh-workbenches'));`,
	'const patchField = pkg.dsh?.bundle?.patch;',
	"check('清单带 dsh.bundle.patch', /cordis\\.patch\\.yml/.test(String(Array.isArray(patchField) ? patchField.join(',') : patchField)), JSON.stringify(patchField));",
	"check('files 里含 cordis.patch.yml', (pkg.files || []).includes('cordis.patch.yml'));",
	"check('cordis.patch.yml 有 insert 段', /-\\s*insert:/.test(read('cordis.patch.yml')));",
	'',
	"check('入口不写 chunk: 字段', !/^\\s*chunk\\s*:/m.test(strip(read('lib/client.js'))));",
	'const component = walk(path.join(ROOT, \'lib\')).map((p) => ({ p, text: strip(fs.readFileSync(p, \'utf8\')) }))',
	'\t.filter((x) => /desktopWorkbenches\\.register\\(/.test(x.text))',
	'\t.sort((a, b) => (b.text.match(/\\bwb-[a-z-]+/g) || []).length - (a.text.match(/\\bwb-[a-z-]+/g) || []).length)[0];',
	"check('找到工作台组件（含 register）', !!component, component?.p.split(/[\\\\/]/).pop());",
	'const src = component ? component.text : \'\';',
	`check('描述符带 repository（vssaros:${moduleName}）', /repository:\\s*'vssaros:${moduleName}'/.test(src));`,
	"check('根节点有 data-vssaros-surface=\"workbench\"', /data-vssaros-surface['\"]?\\s*:\\s*['\"]workbench/.test(src));",
	"check('工具条锚点恰好 1 个', (src.match(/data-dsh-workbench-toolbar/g) || []).length === 1);",
	"const wbClasses = new Set(src.match(/\\bwb(?:-[a-z0-9]+)*\\b/g) || []);",
	"check('用到 ≥10 个 wb-* 原语', wbClasses.size >= 10, wbClasses.size + ' 个');",
	"const bare = src.split('\\n').filter((l) => !l.includes('var(--') && (/(?<![&\\w])#[0-9a-fA-F]{3,8}\\b/.test(l) || /\\b(rgba?|hsla?)\\(/.test(l)));",
	"check('无裸色值', bare.length === 0, bare.slice(0, 2).join(' | '));",
	"check('有 @container（窄栏重排）', /@container/.test(src));",
	"check('≥3 个 data-* 锚点', new Set(src.match(/data-[a-z0-9-]{3,30}/g) || []).size >= 3);",
	"check('零 iframe', !/<iframe|createElement\\(['\"]iframe/.test(src));",
	'',
	`console.log('\\n[${moduleName}] ' + pass + ' passing / ' + fail + ' failing');`,
	'process.exit(fail === 0 ? 0 : 1);',
	'',
].join('\n');

// ── 落盘 ────────────────────────────────────────────────────────────
let written = 0;
for (const [rel, content] of Object.entries(files)) {
	const abs = join(outDir, rel);
	if (existsSync(abs) && !force) {
		console.warn(`跳过（已存在）：${abs}（要覆盖加 --force）`);
		continue;
	}
	mkdirSync(join(abs, '..'), { recursive: true });
	writeFileSync(abs, content.replace(/\r?\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8');
	written++;
}

console.log(`\n✓ 生成 ${written} 个文件 → ${outDir}`);
console.log(`
接下来（漏一步都会被守卫抓）：
  1) 把 'vssaros-${moduleName}' 加进 dsh-plugins/check-workbench-style.mjs 的 UNIFIED 白名单
  2) 在 dsh-plugins/vssaros-chat-surface/lib/client.workbenchNav.js 登记（DEFAULT_ITEMS / 启动器）
     —— 图标若是 codicon，同时加进 workbenchNav + market 两张 WB_ICON_EMOJI 表（逐字一致）
  3) node dsh-plugins/check-workbench-style.mjs && node dsh-plugins/check-workbench-catalog.mjs
     node dsh-plugins/check-chat-surface-chunks.mjs
  4) 写探针：注册表里有 vssaros/${moduleName} / 无 iframe / 卡片数 == 数据项数 / 切暗色颜色变
`);
