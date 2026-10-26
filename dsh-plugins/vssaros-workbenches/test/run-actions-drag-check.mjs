#!/usr/bin/env node
// run-actions-drag-check.mjs —— 「S2 一体条」整组拖拽 的行为测试（假 DOM，不联网）
//
// 为什么值得测：拖拽是纯交互状态机（阈值 / 夹取 / 安全区 / 吞 click / 持久化），
// 光看代码很容易漏边界。这里把 workbenches 里的**真实源码**抠出来，用假 DOM 跑。
//
// 用法：node dsh-plugins/vssaros-workbenches/test/run-actions-drag-check.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const FILE = 'dsh-plugins/vssaros-workbenches/lib/client.js';

let pass = 0;
let fail = 0;
const ok = (n) => { pass += 1; console.log('  ✓ ' + n); };
const bad = (n, d = '') => { fail += 1; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); };
const ck = (n, c, d = '') => (c ? ok(n) : bad(n, d));

/** 抠出「位置常量 + 夹取 + 应用 + 拖拽」这一整段（attachActionsDrag 依赖前三个）。 */
function extract() {
	const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8').replace(/\r\n/g, '\n');
	const start = src.indexOf("/** S2 一体条的位置（相对工作台面板左上角）");
	const end = src.indexOf('/**\n\t\t * 统一挂载 S2 一体条');
	if (start < 0 || end < 0) { return ''; }
	return src.slice(start, end);
}

// ── 假 DOM ─────────────────────────────────────────────────────────────
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

function makeEnv({ frame = rect(0, 0, 800, 600), el = rect(772, 271, 32, 58), stored = null } = {}) {
	const win = new Map();
	const window = {
		addEventListener: (t, fn) => { if (!win.has(t)) { win.set(t, new Set()); } win.get(t).add(fn); },
		removeEventListener: (t, fn) => { if (win.has(t)) { win.get(t).delete(fn); } },
	};
	const store = new Map();
	if (stored) { store.set('__vssarosWbActionsPos', JSON.stringify(stored)); }
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => { store.set(k, String(v)); },
		removeItem: (k) => { store.delete(k); },
	};
	const attrs = new Map();
	const el_ = {
		style: {},
		isConnected: true,
		getBoundingClientRect: () => el,
		addEventListener: (t, fn) => { el_.__ev = el_.__ev || {}; (el_.__ev[t] = el_.__ev[t] || []).push(fn); },
		setAttribute: (k, v) => { attrs.set(k, String(v)); },
		removeAttribute: (k) => { attrs.delete(k); },
		hasAttribute: (k) => attrs.has(k),
		setPointerCapture: () => { el_.__captured = true; },
	};
	const frameEl = { getBoundingClientRect: () => frame };
	const fireWin = (t, ev = {}) => {
		const set = win.get(t);
		if (!set) { return 0; }
		[...set].forEach((fn) => fn(ev));
		return set.size;
	};
	const fireEl = (t, ev = {}) => {
		const list = (el_.__ev && el_.__ev[t]) || [];
		list.forEach((fn) => fn({ ...ev, currentTarget: el_ }));
		return list.length;
	};
	return { window, localStorage, el: el_, frameEl, attrs, store, fireWin, fireEl };
}

function compile(env) {
	const src = extract();
	if (!src) { return null; }
	return new Function('window', 'localStorage', src + '\nreturn attachActionsDrag;')(env.window, env.localStorage);
}

console.log('[actions-drag] S2 一体条 · 整组拖拽');

const probe = makeEnv();
const src = extract();
ck('能抠出拖拽实现', !!src && /function attachActionsDrag/.test(src));
if (!src) {
	console.log(`\n[actions-drag] ${pass} passing / ${fail} failing`);
	process.exit(1);
}

// ① 不动 ⇒ 算点击：不写位置、不设 data-dragging、不吞 click
{
	const env = makeEnv();
	const drag = compile(env);
	drag(env.el, env.frameEl);
	env.fireEl('pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1, clientX: 780, clientY: 280 });
	env.fireWin('pointermove', { pointerId: 1, clientX: 781, clientY: 281 });   // 位移 2px < 3px
	env.fireWin('pointerup', {});
	ck('微动 2px ⇒ 不算拖（不写位置）', env.store.size === 0, [...env.store.keys()].join(','));
	ck('微动 ⇒ 不设 data-dragging', !env.attrs.has('data-dragging'));
	ck('微动 ⇒ 不吞 click（按钮 onClick 照常生效）', (env.el.__ev.click || []).length === 0);
}

// ② 真拖 ⇒ 记位置 + data-moved + 吞掉紧随的 click
{
	const env = makeEnv();
	const drag = compile(env);
	drag(env.el, env.frameEl);
	env.fireEl('pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1, clientX: 780, clientY: 280 });
	env.fireWin('pointermove', { pointerId: 1, clientX: 680, clientY: 340 });
	const during = { left: env.el.style.left, top: env.el.style.top };
	env.fireWin('pointerup', {});
	const saved = JSON.parse(env.store.get('__vssarosWbActionsPos') || 'null');
	ck('拖动中把组挪到 left/top', during.left === '672px' && during.top === '331px', JSON.stringify(during));
	ck('拖动中清掉 right/transform', env.el.style.right === 'auto' && env.el.style.transform === 'none');
	ck('松手写 localStorage', !!saved && saved.x === 672 && saved.y === 331, JSON.stringify(saved));
	ck('松手清掉 data-dragging', !env.attrs.has('data-dragging'));
	ck('松手吞掉那次 click', (env.el.__ev.click || []).length === 1);
	ck('拖动后组带 data-moved', env.attrs.has('data-moved'));
}

// ③ 拖进 header ⇒ 夹在安全区（30）
{
	const env = makeEnv();
	const drag = compile(env);
	drag(env.el, env.frameEl);
	env.fireEl('pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1, clientX: 780, clientY: 280 });
	env.fireWin('pointermove', { pointerId: 1, clientX: 780, clientY: -500 });
	env.fireWin('pointerup', {});
	const saved = JSON.parse(env.store.get('__vssarosWbActionsPos') || 'null');
	ck('拖进 header ⇒ y 夹到 30（不压住宿主按钮）', !!saved && saved.y === 30, JSON.stringify(saved));
}

// ④ 拖出右下 ⇒ 夹在面板内
{
	const env = makeEnv();
	const drag = compile(env);
	drag(env.el, env.frameEl);
	env.fireEl('pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1, clientX: 780, clientY: 280 });
	env.fireWin('pointermove', { pointerId: 1, clientX: 4000, clientY: 4000 });
	env.fireWin('pointerup', {});
	const saved = JSON.parse(env.store.get('__vssarosWbActionsPos') || 'null');
	ck('拖出右下 ⇒ 夹到 (768, 542)', !!saved && saved.x === 800 - 32 && saved.y === 600 - 58, JSON.stringify(saved));
}

// ⑤ 右键 ⇒ 复位 + 清存储
{
	const env = makeEnv({ stored: { x: 100, y: 120 } });
	const drag = compile(env);
	drag(env.el, env.frameEl);
	ck('恢复上次位置', env.el.style.left === '100px' && env.el.style.top === '120px', `${env.el.style.left}/${env.el.style.top}`);
	let prevented = false;
	env.fireEl('contextmenu', { preventDefault: () => { prevented = true; } });
	ck('右键复位到默认（右中）', env.el.style.right === '12px' && env.el.style.transform === 'translateY(-50%)');
	ck('右键清掉存储', !env.store.has('__vssarosWbActionsPos'));
	ck('右键阻止默认菜单', prevented === true);
	ck('复位后去掉 data-moved', !env.attrs.has('data-moved'));
}

// ⑥ 右键不接管拖拽（留给 contextmenu）
{
	const env = makeEnv();
	const drag = compile(env);
	drag(env.el, env.frameEl);
	let prevented = false;
	env.fireEl('pointerdown', { button: 2, pointerType: 'mouse', pointerId: 1, clientX: 780, clientY: 280, preventDefault: () => { prevented = true; } });
	env.fireWin('pointermove', { pointerId: 1, clientX: 500, clientY: 100 });
	ck('右键不启动拖拽', env.store.size === 0 && !env.attrs.has('data-moved'));
}

// ⑦ 存档越界 ⇒ 挂载时先夹一次
{
	const env = makeEnv({ stored: { x: 5000, y: 5000 } });
	const drag = compile(env);
	drag(env.el, env.frameEl);
	ck('越界存档被夹回面板内', env.el.style.left === '768px' && env.el.style.top === '542px',
		`${env.el.style.left}/${env.el.style.top}`);
}

console.log(`\n[actions-drag] ${pass} passing / ${fail} failing`);
process.exit(fail ? 1 : 0);
