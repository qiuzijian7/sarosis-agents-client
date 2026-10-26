/*---------------------------------------------------------------------------------------------
 *  reactDetailSmoke.mjs — 「记忆详情 React 二级页」的**真渲染**冒烟测试（2026-10-26）
 *
 * ## 为什么需要它（源码级守卫不够）
 * `dsh-plugins/check-memory-detail-react.mjs` 只能断言"结构在"，**测不到渲染**：
 * 拼错一个字段名、把 `arr()` 用在非数组上、`h()` 嵌套少个括号 —— 源级守卫全绿，用户点了才炸 ✗。
 *
 * ## 做法
 * - 用 `react-dom/server` 的 `renderToStaticMarkup` **真渲染**（不需要浏览器/jsdom ✓）
 * - `client.memory.js` 是宿主 chunk（`window.__ModuleLoader__.load({factory})`）⇒ 这里用
 *   `new Function(...)` 给它喂假 `window`/`document`/`require`，把 factory 抓出来执行 ✓
 * - 逐个页签用**假模型**渲染并断言可见文案（10 个页签 + 空态 + 页签壳/返回按钮）
 *
 * ## 为什么能测到每个页签
 * SSR 里 `useEffect` **不跑** ⇒ `MemoryDetailPage` 永远停在 loading ⇒ 只能测到壳。
 * ⇒ 所以正文渲染被抽成纯函数 `renderDetailTab(tab, model)`（见 `client.memory.js` 的注释）✓
 *
 * 用法：node dsh-plugins/vssaros-memory/test/reactDetailSmoke.mjs   （exit 0 = 全过）
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_VIEW = path.join(HERE, '..', 'webapp', 'src', 'detailView.js');

const results = [];
const check = (name, fn) => {
	try {
		const detail = fn();
		results.push({ name, ok: true, detail: detail || '' });
	} catch (e) {
		results.push({ name, ok: false, detail: String((e && e.message) || e) });
	}
};
const assert = (cond, msg) => { if (!cond) { throw new Error(msg); } };
const contains = (html, needle, what) => {
	assert(html.includes(needle), `${what || '输出'} 里找不到 ${JSON.stringify(needle)}（实际长度 ${html.length}）`);
};

// ── 载入**单一真源** `webapp/src/detailView.js`（ESM，直接 import ✓）────────
//   ⚠ 以前这里是"假 window/ModuleLoader 把 client.memory.js 的 factory 抠出来"，
//     现在详情视图已经抽成单一真源（dsh chunk 里那份由 build 生成）⇒ 直接测真源更有意义 ✓
const { createDetailView } = await import(pathToFileURL(SRC_VIEW).href);
const { renderDetailTab, MemoryDetailPage } = createDetailView(React);
assert(typeof renderDetailTab === 'function', 'detailView.js 必须导出 createDetailView(...).renderDetailTab');
assert(typeof MemoryDetailPage === 'function', 'detailView.js 必须导出 createDetailView(...).MemoryDetailPage');

const draw = el => renderToStaticMarkup(el);

// ── ① 页签壳：10 个页签 + 返回按钮 + loading 态 ──────────────────────────
check('① 壳：10 个页签 + 「← 返回记忆库」+ loading 态', () => {
	const html = draw(React.createElement(MemoryDetailPage, { onBack() { } }));
	const tabs = ['memories', 'sessions', 'slots', 'lessons', 'consolidation', 'audit', 'hooks', 'commits', 'report', 'skills'];
	for (const t of tabs) { contains(html, `data-memory-detail-tab="${t}"`, '页签壳'); }
	contains(html, '返回记忆库', '页签壳');
	contains(html, 'data-memory-detail-state="loading"', 'SSR 首帧');
	return '10 页签齐';
});

// ── ② 记忆 ───────────────────────────────────────────────────────────────
check('② 记忆：条目正文 / tier / 类型 / 时间', () => {
	const html = draw(renderDetailTab('memories', {
		items: [{ tier: 'episodic', type: 'fact', content: '记忆正文X', timestamp: 1700000000000 }],
	}));
	contains(html, '记忆正文X', '记忆页');
	contains(html, 'episodic', '记忆页');
	contains(html, 'fact', '记忆页');
	return 'ok';
});

check('②b 记忆：空态说明"空 ≠ 出错"', () => {
	const html = draw(renderDetailTab('memories', { items: [] }));
	contains(html, '没有记忆条目', '记忆空态');
	return 'ok';
});

// ── ③ 会话 ───────────────────────────────────────────────────────────────
check('③ 会话：sessionId + 摘要 + 错误行', () => {
	const html = draw(renderDetailTab('sessions', {
		sessions: [{ sessionId: 'sess-1' }], summaries: [{ summary: '摘要A' }], sessionsError: 'boom',
	}));
	contains(html, 'sess-1', '会话页');
	contains(html, '摘要A', '会话页');
	contains(html, 'boom', '会话页错误');
	return 'ok';
});

// ── ④ 槽位 ───────────────────────────────────────────────────────────────
check('④ 槽位：按 slotNames 顺序 + 空槽位标 (空) + 正文', () => {
	const html = draw(renderDetailTab('slots', {
		slotNames: ['project_context', 'guidance'],
		slots: [{ name: 'project_context', content: '槽位正文Y' }],
	}));
	contains(html, 'project_context', '槽位页');
	contains(html, '槽位正文Y', '槽位页');
	contains(html, '(空)', '槽位页（guidance 没有内容应标空）');
	return 'ok';
});

// ── ⑤ 教训 ───────────────────────────────────────────────────────────────
check('⑤ 教训：正文 + 标签；空态说明"要显式提炼"', () => {
	const html = draw(renderDetailTab('lessons', { lessons: [{ content: '教训一', tags: ['tagA'] }] }));
	contains(html, '教训一', '教训页');
	contains(html, 'tagA', '教训页');
	const empty = draw(renderDetailTab('lessons', { lessons: [] }));
	contains(empty, '显式提炼', '教训空态');
	return 'ok';
});

// ── ⑥ 固化 ───────────────────────────────────────────────────────────────
check('⑥ 固化：三层计数 + 上下文正文', () => {
	const html = draw(renderDetailTab('consolidation', {
		episodicItems: [1], semanticItems: [1, 2], proceduralItems: [], consolidationContext: '上下文Z',
	}));
	contains(html, '上下文Z', '固化页');
	contains(html, 'Episodic', '固化页');
	contains(html, 'Semantic', '固化页');
	return 'ok';
});

// ── ⑦ 审计 ───────────────────────────────────────────────────────────────
check('⑦ 审计：汇总 + 日志行（operation/type/正文）', () => {
	const html = draw(renderDetailTab('audit', {
		auditSummary: { totalAuditEntries: 5 },
		auditLog: [{ operation: 'distill', type: 'memory_write', timestamp: 1700000000000, content: '审计W' }],
	}));
	contains(html, 'distill', '审计页');
	contains(html, '审计W', '审计页');
	contains(html, 'totalAuditEntries', '审计页汇总');
	return 'ok';
});

// ── ⑧ 钩子 ───────────────────────────────────────────────────────────────
check('⑧ 钩子：统计键值', () => {
	const html = draw(renderDetailTab('hooks', { hookStats: { totalHooks: 10 } }));
	contains(html, 'totalHooks', '钩子页');
	contains(html, '10', '钩子页');
	const empty = draw(renderDetailTab('hooks', { hookStats: {} }));
	contains(empty, '没有钩子统计', '钩子空态');
	return 'ok';
});

// ── ⑨ 提交 ───────────────────────────────────────────────────────────────
check('⑨ 提交：sha 前 10 位 + message；空态说明数据源', () => {
	const html = draw(renderDetailTab('commits', {
		commitStats: { total: 1 }, commits: [{ sha: 'abcdef1234567890', message: '提交M' }],
	}));
	contains(html, 'abcdef1234', '提交页（应截前 10 位）');
	contains(html, '提交M', '提交页');
	const empty = draw(renderDetailTab('commits', { commits: [] }));
	contains(empty, '不是代码库 git 历史', '提交空态');
	return 'ok';
});

// ── ⑩ 报告 ───────────────────────────────────────────────────────────────
check('⑩ 报告：对象键值 / 字符串正文', () => {
	const obj = draw(renderDetailTab('report', { report: { totalMemories: 7 } }));
	contains(obj, 'totalMemories', '报告页');
	contains(obj, '7', '报告页');
	const str = draw(renderDetailTab('report', { report: '报告正文R' }));
	contains(str, '报告正文R', '报告页（字符串）');
	const none = draw(renderDetailTab('report', { report: null }));
	contains(none, '报告为空', '报告空态');
	return 'ok';
});

// ── ⑪ 技能 ───────────────────────────────────────────────────────────────
check('⑪ 技能：标题 + 置信度 + SKILL.md 标记', () => {
	const html = draw(renderDetailTab('skills', {
		skillStats: { totalSkills: 1 },
		skills: [{ title: '技能T', confidence: 0.9, skillMdWritten: true }],
	}));
	contains(html, '技能T', '技能页');
	contains(html, 'SKILL.md', '技能页');
	contains(html, 'totalSkills', '技能页汇总');
	return 'ok';
});

// ── ⑫ 记忆页复刻细节（本轮修的两个真坑）──────────────────────────────────
check('②c 记忆：时间是**已格式化字符串**（不得退化 1970）', () => {
	const html = draw(renderDetailTab('memories', {
		items: [{ tier: 'episodic', type: 'fact', content: 'X', timestamp: '10-26 12:34' }],
	}, { layer: 'all', type: '' }));
	contains(html, '10-26 12:34', '记忆页时间');
	assert(!html.includes('1970'), '时间被当成数字解析了（会全显示 1970）✗');
	return 'ok';
});

check('②d 记忆：tier 徽标带 data-tier + 来源分区徽标 + 统计行', () => {
	const html = draw(renderDetailTab('memories', {
		agentId: 'ws-cur', total: 1, itemLimit: 200, partitions: ['ws-cur', 'saros-claw'],
		items: [{ tier: 'semantic', type: 'fact', content: 'Y', partition: 'saros-claw', timestamp: '10-26' }],
	}, { layer: 'all', type: '' }));
	contains(html, 'data-tier="semantic"', 'tier 徽标');
	contains(html, 'data-partition="saros-claw"', '来源分区徽标');
	contains(html, 'data-memory-detail-stats', '统计行');
	contains(html, '已查 2 个分区', '统计行分区数');
	return 'ok';
});

check('②e 记忆：层筛选生效（layer=working ⇒ 只剩 working）', () => {
	const html = draw(renderDetailTab('memories', { agentId: 'a', items: [
		{ tier: 'working', content: 'W条' }, { tier: 'episodic', content: 'E条' } ] }, { layer: 'working' }));
	contains(html, 'W条', '筛选后');
	assert(!html.includes('E条'), 'layer=working 时不该出现 episodic 条目 ✗');
	return 'ok';
});

// ── ⑫ client.memory.js 的**生成块**能渲染（验证"单一真源"确实产出可用代码）──────
check('⑫ 生成块（client.memory.js）能渲染 —— 与真源同源', () => {
	const CHUNK = path.join(HERE, '..', 'lib', 'client.memory.js');
	const chunk = fs.readFileSync(CHUNK, 'utf8');
	const m = /@generated:detailView begin[\s\S]*?\*\/([\s\S]*?)\/\* @generated:detailView end \*\//.exec(chunk);
	assert(m, 'client.memory.js 缺少 @generated:detailView 标记块');
	// 把生成块当函数体执行：h/hooks/API 由外层注入（与 chunk 里同样的自由变量）
	const factory = new Function('h', 'useState', 'useEffect', 'useCallback', 'API',
		m[1] + '\n		return { renderDetailTab, MemoryDetailPage };');
	const built = factory(React.createElement, React.useState, React.useEffect, React.useCallback, '/x/memory/api');
	assert(typeof built.renderDetailTab === 'function', '生成块里没有 renderDetailTab');
	const html = draw(built.renderDetailTab('memories', { items: [{ tier: 'semantic', content: '生成块X' }] }, { layer: 'all', type: '' }));
	contains(html, '生成块X', '生成块渲染');
	return 'ok';
});

// ── 汇总 ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
for (const r of results) {
	console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
}
console.log('');
if (failed.length) {
	console.error(`✗ 记忆详情 React 渲染冒烟失败：${failed.length}/${results.length}`);
	process.exit(1);
}
console.log(`✓ 记忆详情 React 渲染冒烟通过（${results.length} 项）`);
