/*
 * 守卫：页面「一页三形态」的接线不许断（2026-10-21 新增，规范见 doc/workbench-authoring-standard.md）。
 *
 * 为什么要有它：三形态全靠**字符串拼装**（renderPage 里选 header/toolbar/body/script），
 * 又全是模板串 ⇒ 改错一处（选了错脚本、丢了 attrs、kind 改了）**语法仍然合法**，
 * 只有真机点开才会发现"目录页里冒出正文面板"或"编辑区一片空白"。这类静默退化必须被静态咬住。
 *
 * 检查项：
 *   ① 三个页内脚本都能被**提取**且**语法合法**（new Function 只解析不执行 ⇒ 不碰 window/document）
 *   ② renderPage 收 surface 且缺省 'full'（既有探针走这条）
 *   ③ editor 分支存在，且正文占位锚点齐全（data-doc-view-body / -title / -meta）
 *   ④ 目录版**不加载** DOC_PREVIEW_SCRIPT（正文只在编辑区）
 *   ⑤ body 上真的打了表面标记（data-vssaros-surface）
 *   ⑥ 路由把 surface 传进 renderPage（且旧的无参调用已消失）
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-page-surfaces.mjs
 *      （已并入 scripts/check-all.mjs）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INDEX = fileURLToPath(new URL('../lib/index.js', import.meta.url));
const src = readFileSync(INDEX, 'utf8');

let pass = 0;
const failed = [];
function ok(name, detail = '') {
	pass += 1;
	console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`);
}
function bad(name, detail) {
	failed.push(name);
	console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
}
function check(name, cond, detail) {
	if (cond) { ok(name, detail); } else { bad(name, detail); }
}

/** 从源码里取一个模板串常量（与 check-page-script.mjs 同一套抽取口径）。 */
function templateOf(name) {
	const re = new RegExp('(?:export\\s+)?const\\s+' + name + '\\s*=\\s*`([\\s\\S]*?)\\n`;');
	const hit = re.exec(src);
	return hit ? hit[1] : null;
}

// ① 三个页内脚本：能提取 + 语法合法
const SCRIPTS = ['KB_SCRIPT', 'DOC_PREVIEW_SCRIPT', 'DOC_SURFACE_SCRIPT'];
for (const name of SCRIPTS) {
	const body = templateOf(name);
	if (body === null) {
		bad(`${name} 能提取`);
		continue;
	}
	ok(`${name} 能提取`, `${body.length} 字符`);
	try {
		// 只解析不执行（模板里用的都是页面全局，new Function 不会跑）
		new Function(body);
		ok(`${name} 语法合法`);
	} catch (e) {
		bad(`${name} 语法合法`, String(e && e.message ? e.message : e));
	}
}

// ② renderPage 收 surface，缺省 full
check(
	'renderPage 接受 surface 且缺省 full',
	/async function renderPage\(\{ config, state, surface = 'full' \}\)/.test(src),
);
check(
	'路由把 surface 传给 renderPage',
	/renderPage\(\{ config, state, surface \}\)/.test(src),
);
check(
	'旧的无参调用已消失（否则 surface 恒为 full）',
	!/renderPage\(\{ config, state \}\)/.test(src),
);

// ③ editor 分支 + 正文锚点
check('editor 分支存在', /if \(surface === 'editor'\) \{/.test(src));
for (const anchor of ['data-doc-view', 'data-doc-view-title', 'data-doc-view-meta', 'data-doc-view-body']) {
	check(`editor 分支有正文锚点 ${anchor}`, src.includes(anchor));
}

// ④ 目录版不加载预览兜底；完整页仍两者都加载
check(
	'sideview 只加载 KB_SCRIPT（正文面板不进目录页）',
	/script: surface === 'sideview' \? KB_SCRIPT : KB_SCRIPT \+ DOC_PREVIEW_SCRIPT/.test(src),
);
check(
	'editor 只加载 DOC_SURFACE_SCRIPT',
	/script: DOC_SURFACE_SCRIPT,/.test(src),
);

// ⑤ body 上的表面标记（三态共用同一份 attrs）
check(
	'attrs 里带 data-vssaros-surface',
	/data-vssaros-surface="\$\{surface\}"/.test(src),
);
check(
	'两个外壳都用 surfaceAttrs（editor + full/sideview）',
	(src.match(/attrs: surfaceAttrs,/g) ?? []).length === 2,
);

// ⑥ kind 不许跟着 surface 变（两个页内脚本与探针都以 data-vssaros-page="kb" 为锚点）
const kindCount = (src.match(/kind: 'kb',/g) ?? []).length;
check('kind 仍为 kb（至少 2 处：editor 分支 + 共用外壳）', kindCount >= 2, `${kindCount} 处`);

console.log('\n' + '='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项未通过：${failed.join(' / ')}`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
