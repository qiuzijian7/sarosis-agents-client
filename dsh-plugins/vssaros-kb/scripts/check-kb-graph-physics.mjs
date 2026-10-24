/*
 * 守卫：图谱力学参数**不允许分叉**（2026-10-24）。
 *
 * 背景：同一套参数此前手抄两份 —— `lib/graphPage.js` 的 `GRAPH_SCRIPT`（独立页 `/x/kb/graph`）
 *   与 `lib/client.js` 的 `KbGraph`（工作台面板 canvas）。数值一分叉，同一个库在两个入口
 *   的形状就完全不同，而这种差异只能靠肉眼比对才发现。
 *
 * 为什么不用「import 共享模块 + 模板插值」：
 *   `check-page-templates.mjs` / `check-page-script.mjs` 校验的是**模板源码文本**
 *   （提取后再做 ESLint no-undef 与求值冒烟）。模板里出现 `${GRAPH_PHYSICS.x}` 时，
 *   那两个守卫会把它当成页面脚本的一部分 ⇒ 直接解析失败（实测 2 条红）。
 *   ⇒ 采用「共享模块是真源 + 两侧各持一份数值 + 本守卫逐项对账」：
 *     谁改了一边忘了另一边，`check-all` 立刻报红。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-graph-physics.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { GRAPH_PHYSICS, SHARED_KEYS } from '../lib/shared/graphPhysics.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLIENT = readFileSync(HERE + '../lib/client.js', 'utf8');
const PAGE = readFileSync(HERE + '../lib/graphPage.js', 'utf8');

let pass = 0;
const failed = [];
function check(name, cond, detail = '') {
	if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
	else { failed.push(name); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}

// ── 1. 共享模块自检 ───────────────────────────────────────────────
check('共享模块导出 GRAPH_PHYSICS 且数值键齐全',
	SHARED_KEYS.every(k => typeof GRAPH_PHYSICS[k] === 'number'),
	SHARED_KEYS.map(k => k + '=' + GRAPH_PHYSICS[k]).join(', '));

// ── 2. graphPage.js（独立页）里的字面量必须与共享模块一致 ─────────────
function num(re, src, name) {
	const m = re.exec(src);
	if (!m) { check('graphPage.js 能解析出 ' + name, false); return undefined; }
	return Number(m[1]);
}
const pageRepulsion = num(/var FORCES = \{ repulsion: ([\d.]+),/, PAGE, 'repulsion');
const pageSpring = num(/var FORCES = \{ repulsion: [\d.]+, spring: ([\d.]+),/, PAGE, 'spring');
const pageCenter = num(/var FORCES = \{ repulsion: [\d.]+, spring: [\d.]+, center: ([\d.]+) \};/, PAGE, 'center');
const pageMaxStep = num(/var MAX_STEP = ([\d.]+);/, PAGE, 'MAX_STEP');
const pageDamping = num(/node\.vx \*= ([\d.]+); node\.vy \*= [\d.]+;/, PAGE, 'damping');
const pageCollision = num(/\* alpha \* ([\d.]+) : 0;/, PAGE, 'collision');

for (const [name, got, want] of [
	['repulsion', pageRepulsion, GRAPH_PHYSICS.repulsion],
	['spring', pageSpring, GRAPH_PHYSICS.spring],
	['center', pageCenter, GRAPH_PHYSICS.center],
	['maxStep', pageMaxStep, GRAPH_PHYSICS.maxStep],
	['damping', pageDamping, GRAPH_PHYSICS.damping],
	['collision', pageCollision, GRAPH_PHYSICS.collision],
]) {
	if (got === undefined) { continue; }
	check('graphPage.js ' + name + ' 与共享模块一致', got === want, 'page=' + got + ' shared=' + want);
}

// ── 3. client.js（面板）的 KB_GRAPH_PHYS 必须与共享模块一致 ────────────
const m = /const KB_GRAPH_PHYS = \{([^}]*)\};/.exec(CLIENT);
check('client.js 存在 KB_GRAPH_PHYS 常量', !!m);
if (m) {
	let phys = null;
	try {
		phys = new Function('return {' + m[1] + '};')();
	} catch (e) {
		check('KB_GRAPH_PHYS 可解析', false, String((e && e.message) || e));
	}
	if (phys) {
		for (const k of SHARED_KEYS) {
			check('client.js ' + k + ' 与共享模块一致',
				phys[k] === GRAPH_PHYSICS[k],
				'client=' + phys[k] + ' shared=' + GRAPH_PHYSICS[k]);
		}
	}
}

// ── 4. 反向：页面侧不许重新引入插值（会把另外两个守卫打红）───────────────
check('graphPage.js 没有 ${GRAPH_PHYSICS.} 插值（否则 check-page-script 会解析失败）',
	!PAGE.includes('${GRAPH_PHYSICS.'));

console.log('\n' + '='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项`);
	for (const f of failed) { console.log('   - ' + f); }
	process.exit(1);
} else {
	console.log(`✓ 全部 ${pass} 项通过（图谱力学参数未分叉）`);
}
