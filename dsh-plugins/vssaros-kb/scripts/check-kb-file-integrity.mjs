/*
 * 守卫：**源码文件完整性**（2026-10-25）。
 *
 * 为什么需要单独一条：改代码时用 `String.replace` 拼接，若替换串里含 `$'`
 * （JS 的特殊替换模式 = "匹配之后的全部内容"），会把**文件后半段整段复制一份**。
 * 这种损坏 `node --check` 是绿的（两份代码都合法），功能上表现为"函数定义了两次、
 * 后者覆盖前者"，极难从报错定位 —— 本仓库已经踩过两次（一次把 client.js 撑到 1554 行）。
 *
 * 两道检查：
 *   ① **关键符号必须唯一**（面板/设置/图谱/install/apply/主路由）
 *   ② **滑窗重复检测**：任意 24 行归一化窗口不得在高相似位置重复出现
 *      （真正重复插入的那一段，行内容与缩进都一模一样）
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-file-integrity.mjs
 */
import { readFileSync, statSync } from 'node:fs';

const HERE = new URL('.', import.meta.url);
const FILES = [
	{ path: new URL('../lib/client.js', HERE), uniques: ['function KbWorkbenchPanel', 'function KbSettingsPage', 'function KbGraph', 'function install(', '__ModuleLoader__'], maxLines: 3000 },
	// ⚠ 符号要选**能唯一定位一个语句**的：`/api/doc` 这种会命中十几处注释，
	//   用它做"唯一性"断言会把正常文件判红（第一版就是这么误报的）。
	{
		path: new URL('../lib/index.js', HERE),
		uniques: [
			'export function apply(',
			'pathname === `${ROUTE_PREFIX}/api/view-data`)',
			'pathname === `${ROUTE_PREFIX}/api/doc`)',
			'async function performFeishuSync(',
		],
		maxLines: 12000,
	},
	{ path: new URL('../lib/md/render.js', HERE), uniques: ['export function renderMarkdownHtml'], maxLines: 800 },
];

let pass = 0;
const failed = [];
const t = (name, ok, extra = '') => {
	if (ok) { pass += 1; return; }
	failed.push(name);
	console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`);
};

/**
 * 找整段重复（24 行窗口，按内容全等判断）。
 * 抽成函数是为了**自测**：守卫必须能证明自己抓得住"整段复制"，
 * 否则它只是一个"总是绿"的装饰（这类守卫比没有更糟）。
 */
function findDupWindow(lines, WIN = 24) {
	const norm = lines.map(l => l.trim());
	const seen = new Map();
	for (let i = 0; i + WIN <= norm.length; i++) {
		const win = norm.slice(i, i + WIN);
		const meaningful = win.filter(l => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
		if (meaningful.length < 12) { continue; }
		const key = win.join('\n');
		if (seen.has(key)) { return `L${seen.get(key) + 1} 与 L${i + 1}（${WIN} 行）`; }
		seen.set(key, i);
	}
	return '';
}

// 自测：造一份"把中间 30 行原样复制到末尾"的文本，检测器必须报出来
{
	const body = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`);
	const corrupted = [...body, ...body.slice(5, 35)];
	t('自测：检测器能抓到整段重复', findDupWindow(corrupted) !== '', '期望报出重复位置');
	const clean = [...body, ...body.map((l, i) => l + ' // ' + i)];
	t('自测：正常文件不会被误报', findDupWindow(clean) === '', findDupWindow(clean));
}

for (const spec of FILES) {
	const file = spec.path.pathname.replace(/^\//, '').replace(/\//g, '/');
	let text = '';
	try { text = readFileSync(spec.path, 'utf8'); } catch (e) {
		t(`${spec.path.pathname} 可读`, false, String(e?.message ?? e));
		continue;
	}
	const name = String(spec.path.pathname).split('/').slice(-1)[0];
	const lines = text.split(/\r?\n/);

	// ① 关键符号唯一
	for (const sym of spec.uniques) {
		const n = text.split(sym).length - 1;
		t(`${name}: 符号唯一「${sym}」`, n === 1, '出现 ' + n + ' 次');
	}

	// ② 行数上限（异常膨胀多半是重复）
	t(`${name}: 行数合理（≤ ${spec.maxLines}）`, lines.length <= spec.maxLines, '实际 ' + lines.length + ' 行');

	// ③ 滑窗重复检测（与自测共用同一个实现，避免"自测的是一份、实际用的是另一份"）
	const dup = findDupWindow(lines);
	t(`${name}: 无整段重复（24 行窗口）`, dup === '', dup);

	// ④ 体积（防再次把文件撑成两倍）
	const kb = Math.round(statSync(spec.path).size / 1024);
	t(`${name}: 体积合理（≤ ${Math.round(spec.maxLines / 10)}KB）`, kb <= Math.round(spec.maxLines / 10), kb + 'KB');
}

console.log('='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项（源码完整性）`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（源码完整性：符号唯一 / 无整段重复 / 体积合理）`);
