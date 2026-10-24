// 页签拖拽排序的守卫（2026-10-23 用户："要求页签支持拖拽排序"）。
//
// 为什么要有它：换序是**纯逻辑 + 一处持久化 + 一处点击闸门**三件套，任何一件漏了都不会报错，
// 只表现成"拖了没反应 / 重开又乱 / 松手顺手切了页签"这种难查的体感问题 ✗。
// 所以这里分两层：
//   ① 纯逻辑（`reorderTabs`）—— 真调用、真断言顺序与钳制（不是比源码字符串）；
//   ② 接线 —— 换序必须落到 `saveTabs` + `bumpTabs`，拖动后的 click 必须被吞掉，
//      「会话」那格不许可拖，✕ 上按下不许起拖。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.cwd();
const problems = [];
const ok = (name) => console.log('  ✓ ' + name);
const fail = (msg) => { problems.push(String(msg)); console.log('  ✗ ' + String(msg)); };
const read = (rel) => readFileSync(join(repo, rel), 'utf8');
const eq = (name, actual, expected) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { ok(name); } else { fail(name + '：期望 ' + e + '，实际 ' + a); }
};
const truthy = (name, cond, detail) => { if (cond) { ok(name); } else { fail(name + (detail ? '：' + detail : '')); } };

const CHUNK = 'dsh-plugins/vssaros-chat-surface/lib/client.workbenchNav.js';
const src = read(CHUNK);

// ── ① 装载 chunk，拿 __test.reorderTabs（真跑，不做字符串比较）──────────────────
let reorderTabs = null;
{
	let captured = null;
	const fakeRequire = (name) => {
		if (name === 'react') {
			return { createElement: () => null, Fragment: 'fragment', useState: v => [typeof v === 'function' ? v() : v, () => { }], useEffect: () => { }, useRef: v => ({ current: v }) };
		}
		throw new Error('unexpected require: ' + name);
	};
	// chunk 的入口是 `window.__ModuleLoader__.load({ factory })`；`window` 是形参 ⇒ 给个只带 loader 的壳即可
	const host = { __ModuleLoader__: { load: m => { captured = m; } } };
	new Function('window', 'require', src)(host, fakeRequire);
	truthy('① chunk 通过 __ModuleLoader__ 注册（入口没坏）', !!captured, '没有调用 load');
	const mod = captured.factory(fakeRequire);
	truthy('① __test 暴露了 reorderTabs（换序逻辑可测）', !!(mod.__test && typeof mod.__test.reorderTabs === 'function'));
	reorderTabs = mod.__test ? mod.__test.reorderTabs : null;
}

const T = (id) => ({ id, name: id, route: '/x/' + id + '/' });
const ids = (list) => list.map(t => t.id);

if (reorderTabs) {
	const base = [T('a'), T('b'), T('c')];

	// ② 往右拖：a 插到末尾（slot = length）
	eq('② 把第一个拖到末尾 ⇒ [b,c,a]', ids(reorderTabs(base, 'a', 3)), ['b', 'c', 'a']);
	// ③ 往左拖：c 插到最前（slot = 0）
	eq('③ 把最后一个拖到最前 ⇒ [c,a,b]', ids(reorderTabs(base, 'c', 0)), ['c', 'a', 'b']);
	// ④ 中间位置
	eq('④ 把 c 拖到 a 与 b 之间（slot=1）⇒ [a,c,b]', ids(reorderTabs(base, 'c', 1)), ['a', 'c', 'b']);
	// ⑤ "插到自己原位" 不该变（返回同一引用 ⇒ 不写盘、不重画）
	{
		const same = reorderTabs(base, 'b', 1);
		truthy('⑤ 拖回原位返回同一引用（避免无谓写盘 / 重画）', same === base);
		const same2 = reorderTabs(base, 'b', 2);
		truthy('⑤ 插到自己右边一格也等于原位（先摘后插的 off-by-one）', same2 === base);
	}
	// ⑥ 越界钳制
	eq('⑥ slot 超长 ⇒ 落到末尾', ids(reorderTabs(base, 'a', 99)), ['b', 'c', 'a']);
	eq('⑥ slot 为负 ⇒ 落到最前', ids(reorderTabs(base, 'c', -5)), ['c', 'a', 'b']);
	// ⑦ 异常输入不炸、不改入参
	{
		truthy('⑦ 未知 id ⇒ 原样返回', reorderTabs(base, 'zzz', 1) === base);
		truthy('⑦ 非数组 ⇒ 空数组', Array.isArray(reorderTabs(null, 'a', 0)) && reorderTabs(null, 'a', 0).length === 0);
		truthy('⑦ slot 非数字 ⇒ 原样返回', reorderTabs(base, 'a', NaN) === base);
		eq('⑦ 换序不改动入参', ids(base), ['a', 'b', 'c']);
	}
}

// ── ⑧ 接线：换序必须写盘 + 重画；拖动后的 click 必须被吞；「会话」不可拖；✕ 不触发拖 ──
{
	// moveTabTo 现在走 reorderTabs（避免"两套换序逻辑"）
	const mAt = src.indexOf('const moveTabTo = (id, slot) => {');
	truthy('⑧ 找到 moveTabTo（拖拽结果有落地处）', mAt > 0);
	if (mAt > 0) {
		const body = src.slice(mAt, mAt + 500);
		truthy('⑧ moveTabTo 用 reorderTabs（换序只有一处实现）', /reorderTabs\(openTabs, id, slot\)/.test(body));
		truthy('⑧ 换序后 saveTabs(openTabs)（否则重开窗口顺序又乱）', /saveTabs\(openTabs\)/.test(body));
		truthy('⑧ 换序后 bumpTabs()（否则条上不重画）', /bumpTabs\(\)/.test(body));
	}
	truthy('⑧ 页签 onClick 有"刚拖过就丢掉"的闸门（否则松手顺手切页签）',
		src.includes('if (dragMovedRef.current) { dragMovedRef.current = false; return; }'));

	// 「会话」那格是出口 ⇒ 不许可拖
	const chatAt = src.indexOf('"data-vssaros-wb-tab": "chat"');
	truthy('⑧ 找到「会话」那一格（可断言它不被拖拽化）', chatAt > 0);
	if (chatAt > 0) {
		truthy('⑧ 「会话」那格不许挂 onPointerDown（回聊天的出口不能被拖走）',
			!src.slice(chatAt, chatAt + 400).includes('onPointerDown'));
	}
	// ✕ 上按下不许起拖
	truthy('⑧ 关闭按钮挡住了 pointerdown（点 ✕ 不该进入拖拽）',
		src.includes('onPointerDown: (e) => { try { e.stopPropagation(); }'));
}

console.log('');
if (problems.length) {
	console.error('[check-dsh-tab-drag] ✗ 页签拖拽排序守卫失败：');
	for (const p of problems) { console.error('  - ' + p); }
	process.exit(1);
}
console.log('[check-dsh-tab-drag] ✓ 页签拖拽排序：纯逻辑换序 / 钳制 / 幂等 / 持久化接线 / 点击闸门 / 「会话」不可拖 全部通过');
