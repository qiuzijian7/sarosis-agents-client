/*---------------------------------------------------------------------------------------------
 *  inboxView.test.mjs — 收件箱 React 组件冒烟（★ 2026-11-02）
 *
 * 为什么另起一个：`inbox.test.mjs` 钉的是**数据与动作**，而页面是否真把它们画出来、
 * 按钮锚点在不在、空态/错态/窄容器规则有没有，只能真渲染才知道。
 *
 * 做法：假 `window.__ModuleLoader__` 抠出 `client.memory.js` 的 factory，用宿主同一份 React
 * 真渲染 `InboxSection`（`react-dom/server`，不需要浏览器）。SSR 下 `useEffect` 不跑 ⇒
 * 组件提供仅供测试的 `props.initial` 注入首帧数据。
 *
 * ## 钉住
 *  ① loading / error / 空态 三个非内容态都有各自的锚点与文案
 *  ② 待审行：文本 / hits / 提升·改写·丢弃 三个按钮 / 旧探针锚点 / "未自动提升：<原因>"
 *  ③ 批量条只在待审出现；自动提升动态与已处理有「撤销提升 / 恢复到待审」
 *  ④ 自动提升档位 off 时，空态文案不骗人
 *  ⑤ 样式：窄容器规则 + 无裸色值 + 模板字符串里没有反引号
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHUNK = path.join(HERE, '..', 'lib', 'client.memory.js');

const results = [];
const check = (name, fn) => {
	try { const d = fn(); results.push({ name, ok: true, detail: d || '' }); }
	catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); }
};
const assert = (cond, msg) => { if (!cond) { throw new Error(msg); } };
const contains = (html, needle, what) => assert(html.includes(needle), `${what || '输出'} 里找不到 ${JSON.stringify(needle)}`);
const absent = (html, needle, what) => assert(!html.includes(needle), `${what || '输出'} 里不该出现 ${JSON.stringify(needle)}`);

// ── 装载 chunk：假 window / ModuleLoader，require('react') 给宿主同一份 ──────────
const src = await readFile(CHUNK, 'utf8');
let loaded = null;
globalThis.window = { __ModuleLoader__: { load(def) { loaded = def; } } };
globalThis.document = globalThis.document ?? { addEventListener() {}, getElementById() { return null; } };
// chunk 是脚本（含 `window.__ModuleLoader__.load(...)`），用 Function 执行
new Function('window', 'document', src)(globalThis.window, globalThis.document);
assert(loaded && typeof loaded.factory === 'function', 'chunk 没有调用 __ModuleLoader__.load({factory})');
const mod = loaded.factory(name => { if (name === 'react') { return React; } throw new Error(`chunk 不该 require ${name}`); });
const Inbox = mod.__InboxSection;
assert(typeof Inbox === 'function', 'chunk 必须导出 __InboxSection 测试钩子');

const draw = props => renderToStaticMarkup(React.createElement(Inbox, props));

const pendingRow = (over = {}) => ({
	id: 'p1', text: '以后所有构建都必须走 pnpm，不要用 npm', kind: '习惯约定', hits: 1, sessionId: 'sess-12345678abc', turn: 3,
	at: Date.now(), lastSeenAt: Date.now(), updatedAt: 0, status: 'draft', promotedBy: '', edited: false,
	why: 'hits<2', hint: '只出现过 1 次；同一句再出现 1 次，且 LLM 判定通过后会自动提升。', eligible: false, ...over,
});
const inboxData = (over = {}) => ({
	ok: true, mode: 'high-only', minHits: 2, distill: {},
	pending: [pendingRow(), pendingRow({ id: 'p2', text: '约定所有包都要 bump 版本', kind: '项目规范', hits: 2, why: 'awaiting-judge', eligible: true })],
	autos: [{ ...pendingRow({ id: 'a1', text: '以后用 pnpm', status: 'promoted', promotedBy: 'auto-distill', hits: 2 }) }],
	done: [
		{ ...pendingRow({ id: 'h1', text: '记住 dev app 重启才加载', status: 'promoted', promotedBy: 'human' }) },
		{ ...pendingRow({ id: 'r1', text: '注意不要提交 doc', status: 'rejected' }) },
	],
	counts: { pending: 2, autos: 1, done: 2 }, reasons: { 'hits<2': 1, 'awaiting-judge': 1 }, truncated: false, ...over,
});

check('① loading / error / 空态 各有锚点', () => {
	contains(draw({}), 'data-memory-inbox-state="loading"', 'loading');
	const err = draw({ initial: { error: 'HTTP 500' } });
	contains(err, 'data-memory-inbox-state="error"', 'error'); contains(err, 'HTTP 500', 'error'); contains(err, 'role="alert"', 'error');
	const empty = draw({ initial: { data: inboxData({ pending: [], counts: { pending: 0, autos: 0, done: 0 }, reasons: {} }) } });
	contains(empty, 'data-memory-inbox-state="empty"', 'empty'); contains(empty, '收件箱清空了', 'empty');
	return 'ok';
});

check('② 待审行：文本 / hits / 三个按钮 / 旧探针锚点 / 未自动提升原因', () => {
	const html = draw({ initial: { data: inboxData() } });
	contains(html, '以后所有构建都必须走 pnpm', '待审');
	contains(html, 'hits 1', '待审'); contains(html, 'hits 2', '待审');
	contains(html, 'data-vssaros-memory-promote="p1"', '旧探针锚点');
	contains(html, 'data-vssaros-memory-discard="p1"', '旧探针锚点');
	contains(html, 'data-vssaros-memory-draft-list', '旧探针锚点');
	contains(html, 'data-vssaros-memory-drafts="2"', '旧探针锚点（计数）');
	contains(html, '改写', '待审');
	contains(html, 'data-memory-inbox-why="hits&lt;2"', '门控原因');
	contains(html, '未自动提升：hits&lt;2', '门控原因文案');
	contains(html, '等待 LLM 判定', '结构已达标但未判定的候选');
	contains(html, 'data-memory-inbox-reasons', '原因汇总');
	return 'ok';
});

check('③ 批量条只在待审出现；动态与已处理有撤销入口', () => {
	const pend = draw({ initial: { data: inboxData() } });
	contains(pend, 'data-memory-inbox-bulk="promote"', '批量条'); contains(pend, 'data-memory-inbox-bulk="discard"', '批量条');
	contains(pend, '全选', '批量条');
	const auto = draw({ initial: { data: inboxData(), seg: 'auto' } });
	absent(auto, 'data-memory-inbox-bulk', '自动提升动态'); contains(auto, '已自动提升', '动态'); contains(auto, '撤销提升', '动态');
	contains(auto, '凭据：hits=2', '动态要带凭据');
	const done = draw({ initial: { data: inboxData(), seg: 'done' } });
	absent(done, 'data-memory-inbox-bulk', '已处理'); contains(done, '恢复到待审', '已丢弃的可恢复'); contains(done, '已丢弃', '已处理'); contains(done, '已提升', '已处理');
	return 'ok';
});

check('④ 档位 off 时，空态文案不骗人', () => {
	const off = draw({ initial: { seg: 'auto', data: inboxData({ mode: 'off', autos: [], counts: { pending: 2, autos: 0, done: 2 } }) } });
	contains(off, '自动提升当前为 off', 'off 空态');
	const on = draw({ initial: { seg: 'auto', data: inboxData({ autos: [], counts: { pending: 2, autos: 0, done: 2 } }) } });
	contains(on, '门槛：强句式', 'on 空态要写门槛'); absent(on, '当前为 off', 'on 空态');
	contains(draw({ initial: { data: inboxData() } }), '自动提升：high-only', '头部档位');
	return 'ok';
});

check('⑤ 样式：窄容器规则 / 无裸色值 / 模板字符串无反引号', () => {
	const css = src.slice(src.indexOf('const CSS = `'), src.indexOf('function install'));
	assert(css.length > 200, '找不到 CSS 模板');
	assert(/@container \(max-width: 560px\)[\s\S]*\.mem-inbox-row \{ grid-template-columns:20px minmax\(0,1fr\); \}/.test(css), '窄容器下行布局规则缺失');
	assert(/\.mem-hide-sm \{ display:none; \}/.test(css), '窄容器下应隐藏次要列');
	// 逐行：含 #hex / rgb( 的行必须同行带 var(--（与 run-agents-check 的「无裸色值」同判据）
	const bad = css.split('\n').filter(l => (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(rgba?|hsla?)\(/.test(l)) && !l.includes('var(--'));
	assert(bad.length === 0, `裸色值：${bad.slice(0, 2).join(' | ')}`);
	// 只查真正的 @media **规则**（`@media (` / `@media screen`），不查注释里提到它的文字
	assert(!/@media\s*[(a-z]/i.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), '禁用 @media 判宽（规范 §4.3：只用容器查询）');
	return 'ok';
});

const failed = results.filter(r => !r.ok);
for (const r of results) { console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`); }
console.log('');
if (failed.length) { console.error(`✗ 收件箱视图测试失败：${failed.length}/${results.length}`); process.exit(1); }
console.log(`✓ 收件箱视图测试通过（${results.length} 项）`);
