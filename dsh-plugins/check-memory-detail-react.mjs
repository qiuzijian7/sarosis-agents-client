/*---------------------------------------------------------------------------------------------
 *  check-memory-detail-react.mjs — 「记忆详情 = React 二级页」的口径守卫（2026-10-26）
 *
 * ## 为什么要有它（这个入口先后试过 4 条路，3 条全是坑）
 *  ① `location.href='/x/memory/detail'` ⇒ **主 frame 整页导航** ⇒ 被导航守卫拦（"点了没反应"），
 *     或把整个客户端替换掉（丢页签栏/全屏）；
 *  ② `window.open('./detail')` ⇒ 内部浏览器打开**没有 token** 的地址 ⇒ **黑屏窗口**；
 *  ③ `openModulePage('/x/memory/detail')` ⇒ 桌面全窗客户端**没有编辑区** ⇒ 空编辑器 ⇒ **黑屏**；
 *     且它**不接受带查询串的 route**（`validatePluginRoute` 逐段校验 ⇒ `?` 判非法 ⇒ invalid command）；
 *  ④ ✅ **同一 React 工作台内 state 切二级页**（不导航/不开窗/不需要桥）。
 *
 * ## 守卫的三条不变量
 *  ① 入口必须是**页内切换**：代码里出现 `setPage('detail')`，且**代码中不得再有**
 *     `openModulePage(` / `window.open(` / `window.location.assign(`（注释里提到不算 —— 必须去注释再判，
 *     否则注释里的关键词会造成**假绿**，这个坑本仓踩过 ✗）；
 *  ② 二级页必须**真的用 React 组件**：`MemoryDetailPage` 存在，且**10 个页签 id 全在**
 *     （memories/sessions/slots/lessons/consolidation/audit/hooks/commits/report/skills）；
 *  ③ 数据走 **JSON 接口**：服务端有 `GET /x/memory/api/detail`，且实现复用 `loadDetailModel`
 *     （与 SSR 详情页同一份取数 ⇒ 两个界面口径不会分叉）。
 *
 * 用法：node dsh-plugins/check-memory-detail-react.mjs   （退出码 0 = 通过）
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, 'vssaros-memory', 'lib', 'client.memory.js');
const SERVER = path.join(HERE, 'vssaros-memory', 'lib', 'index.js');

/** 去掉注释（块注释状态机 + 行注释）——**必须做**：注释里就写着那几个禁用词 ✗ */
function stripComments(text) {
	const out = [];
	let inBlock = false;
	for (const raw of text.split('\n')) {
		let s = raw.replace(/\r$/, '');
		if (inBlock) {
			const end = s.indexOf('*/');
			if (end < 0) { out.push(''); continue; }
			s = s.slice(end + 2);
			inBlock = false;
		}
		const bs = s.indexOf('/*');
		if (bs >= 0) {
			const end = s.indexOf('*/', bs + 2);
			if (end < 0) { s = s.slice(0, bs); inBlock = true; }
			else { s = s.slice(0, bs) + s.slice(end + 2); }
		}
		const lc = s.indexOf('//');
		if (lc >= 0) { s = s.slice(0, lc); }
		out.push(s);
	}
	return out.join('\n');
}

const problems = [];

const clientRaw = fs.readFileSync(CLIENT, 'utf8');
const client = stripComments(clientRaw);
const server = stripComments(fs.readFileSync(SERVER, 'utf8'));

// ── ① 入口是页内切换，且不再有"开文档"的三条老路 ─────────────────────────
if (!/setPage\(\s*'detail'\s*\)/.test(client)) {
	problems.push("入口没有 `setPage('detail')` ⇒ 不是页内二级页？");
}
for (const banned of ['openModulePage(', 'window.open(', 'window.location.assign(', 'location.href =']) {
	if (client.includes(banned)) {
		problems.push(`代码里仍有 \`${banned}\` ⇒ 又回到"开文档"的老路`
			+ `（整页导航/丢 token/空编辑器黑屏，均已实测失败）✗`);
	}
}

// ── ② 二级页是 React 组件，且 10 个页签齐 ────────────────────────────────
if (!/function MemoryDetailPage\s*\(/.test(client)) {
	problems.push('缺少 `MemoryDetailPage` 组件（二级页必须用 React 组件实现）');
}
const TABS = ['memories', 'sessions', 'slots', 'lessons', 'consolidation', 'audit', 'hooks', 'commits', 'report', 'skills'];
const missing = TABS.filter(id => !client.includes(`id: '${id}'`));
if (missing.length) {
	problems.push(`二级页缺少页签：${missing.join('、')}（用户要求 10 个页签全部迁到 React）`);
}
if (!client.includes('data-memory-detail-tab')) {
	problems.push('缺少 `data-memory-detail-tab` 锚点（探针/自动化要用它点页签）');
}
if (!client.includes('back-to-library')) {
	problems.push('缺少「← 返回记忆库」入口（二级页必须能回，不能把用户困住）');
}

// ── ③ 数据走 JSON 接口，且复用 loadDetailModel ───────────────────────────
if (!server.includes('api/detail')) {
	problems.push('服务端没有 `GET /x/memory/api/detail` ⇒ React 二级页取不到数据');
}
const apiIdx = server.indexOf('api/detail');
if (apiIdx >= 0 && !server.slice(apiIdx, apiIdx + 900).includes('loadDetailModel(')) {
	problems.push('`api/detail` 没有复用 `loadDetailModel` ⇒ 与 SSR 详情页的取数口径会分叉 ✗');
}

if (problems.length) {
	console.error(`✗ 记忆详情（React 二级页）口径检查失败（${problems.length} 项）：`);
	for (const p of problems) { console.error(`  · ${p}`); }
	process.exit(1);
}
console.log('✓ 记忆详情 = React 二级页（页内切换 + 10 页签 + JSON 接口复用 loadDetailModel）');
